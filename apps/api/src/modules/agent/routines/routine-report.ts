// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ROUTINE REPORTS BACK TO THE CONVERSATION IT WAS ASKED FOR IN.
//
// A tick works in the routine's own output thread, which nobody reads while it
// runs: "send me a message in one minute" ran on time, answered "Here is your
// one-minute message", and the answer sat in a thread the person never opened,
// so from where they asked, the agent never sent anything. A routine created
// from a conversation records it (`routines.report_thread_id`, 0166), and at the
// end of a successful tick its FINAL message is posted there:
//
//   - as the routine's owner agent, labelled "Routine <name>" (a run
//     attribution, never the human whose routine it is);
//   - through `persistAgentTurn`, the path every agent reply takes, so the
//     conversation gets its unread state, attention row and push;
//   - stamped with the scopes the tick's own replies carry, so a reader who
//     could not read the run's output cannot read its summary either;
//   - carrying `metadata.routineReport` (routine and output thread ids), which
//     the thread view draws as a "see the full run" link.
//
// One message per tick, the last thing the agent said. The tick prompt says so
// (`routineReportSentence`), so a long working tick ends with a summary written
// to the person rather than a log of its steps. No extra tool: a weak model
// cannot call the wrong one, forget to call it, or call it twice.

import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import {
  agents,
  messages,
  routineRuns,
  routines,
  threadParticipants,
  threads,
} from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { persistAgentTurn } from "~/modules/agent/runtime/persist-agent-turn"
import { normalizeRequiredScopes } from "~/modules/agent/scopes/write-required-scopes"
import {
  SKIPPED_MOVING,
  sweepSkippingMoving,
  writeUnlessMoving,
} from "~/modules/org/transfer-state/skip-moving"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import { createOrGetAgentDm } from "~/modules/threads/thread"
import { isMessageVisible, messageVisibilityFacts } from "~/services/security/visibility"

const log = rootLogger.child({ module: "routine-report" })

type RoutineRow = typeof routines.$inferSelect

/** What the delivered message's metadata carries, read by the thread view. */
export interface RoutineReportMetadata {
  routineId: string
  routineName: string
  outputThreadId: string
  /** The one reader the output thread is sure to seat, so the link is theirs. */
  ownerUserId: string
}

/** The sentence appended to the tick prompt of a routine that reports to a conversation. */
export function routineReportSentence(): string {
  return (
    "When you are done, your final message is sent to the person in the conversation where " +
    "this routine was set up. End with that message, written to them: the result they asked " +
    "for, or a short summary of what you found and did. Not a log of your steps."
  )
}

/** The tick prompt with the report sentence appended, or unchanged without a report conversation. */
export function withReportSentence(
  prompt: string,
  routine: Pick<RoutineRow, "reportThreadId">,
): string {
  return routine.reportThreadId ? `${prompt}\n\n${routineReportSentence()}` : prompt
}

/** A channel named by its handle (`#marketing`), the form a person and a model write. */
const HANDLE_REF = /^#?([a-z0-9][a-z0-9_-]{0,79})$/i
const UUID_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The attribution label of work a routine's tick did ("Routine <name>"), the
 * one its report posts carry; null when the routine is gone. Routines are
 * privileged-access only (their RLS blocks the agent context), so a caller in
 * an agent's turn resolves the name here.
 */
export async function routineAuthorLabel(orgId: string, routineId: string): Promise<string | null> {
  const [row] = await withPrivilegedDb(orgId, "routine-author-label", (tx) =>
    tx
      .select({ name: routines.name })
      .from(routines)
      .where(and(eq(routines.id, routineId), eq(routines.orgId, orgId)))
      .limit(1),
  )
  return row ? `Routine ${row.name}` : null
}

/**
 * The conversation a routine posts its runs in, from `ref`, or null.
 *
 * `ref` is a conversation id, or a channel's handle (`#marketing`). Only a
 * conversation the routine's OWNER sits in: the posts are written under the
 * owner's authority (the message's author), exactly like the tick prompt in
 * the output thread, so a thread the owner cannot post in could never receive
 * them. Never a routine's own output thread: a routine created by another
 * routine's tick reports nowhere rather than into a thread nobody reads.
 */
export async function resolveReportThreadId(
  orgId: string,
  ref: string | null | undefined,
  ownerUserId: string,
): Promise<string | null> {
  const value = ref?.trim()
  if (!value) return null
  const byId = UUID_REF.test(value)
  const handle = byId ? null : (HANDLE_REF.exec(value)?.[1] ?? null)
  if (!byId && !handle) return null
  return withPrivilegedDb(orgId, "routine-report-thread-check", async (tx) => {
    const [row] = await tx
      .select({ id: threads.id, type: threads.type })
      .from(threads)
      .innerJoin(
        threadParticipants,
        and(
          eq(threadParticipants.threadId, threads.id),
          eq(threadParticipants.userId, ownerUserId),
          eq(threadParticipants.orgId, orgId),
        ),
      )
      .where(
        and(
          byId ? eq(threads.id, value) : eq(threads.handle, handle!.toLowerCase()),
          eq(threads.orgId, orgId),
        ),
      )
      .limit(1)
    if (!row || row.type === "routine") return null
    return row.id
  })
}

/**
 * WHERE A ROUTINE POSTS WHEN NOBODY SAID: its owner's direct messages with the
 * routine's agent, when that agent is the owner's own personal agent (the
 * person's agent runs it, so the person's conversation with it is where its
 * runs belong). A role or org agent's routine has no such conversation and
 * keeps its output thread only, until someone sets one.
 *
 * Every create path applies it once, right after the insert, when the create
 * named no conversation and was not asked in one: the routine tool and the
 * REST route, a template's enable, an import. The DM is opened under the
 * owner's own authority when it does not exist yet (as the person's "+" does).
 * Best-effort: a routine whose default cannot be opened keeps its output
 * thread, which holds every run anyway.
 */
export async function applyDefaultReportThread(
  orgId: string,
  routine: Pick<RoutineRow, "id" | "ownerUserId" | "ownerAgentId" | "reportThreadId">,
): Promise<string | null> {
  if (routine.reportThreadId) return routine.reportThreadId
  const ownerAgentId = routine.ownerAgentId
  if (!ownerAgentId) return null
  try {
    const perms = await withPrivilegedDb(orgId, "routine-report-default-perms", async (tx) => {
      const [agent] = await tx
        .select({ kind: agents.kind, ownerUserId: agents.ownerUserId })
        .from(agents)
        .where(and(eq(agents.id, ownerAgentId), eq(agents.orgId, orgId)))
        .limit(1)
      if (agent?.kind !== "personal" || agent.ownerUserId !== routine.ownerUserId) return null
      return loadEffectivePermissions(tx, routine.ownerUserId, orgId)
    })
    if (!perms) return null
    const dm = await withRlsContext(
      {
        actorType: "user",
        userId: routine.ownerUserId,
        orgId,
        scopes: perms.scopes,
        dimensionGrants: perms.dimensionGrants,
      },
      (tx) => createOrGetAgentDm(tx, { orgId, userId: routine.ownerUserId, agentId: ownerAgentId }),
    )
    if (!dm) return null
    await withPrivilegedDb(orgId, "routine-report-default-set", (tx) =>
      tx
        .update(routines)
        .set({ reportThreadId: dm.id })
        .where(
          and(
            eq(routines.id, routine.id),
            eq(routines.orgId, orgId),
            isNull(routines.reportThreadId),
          ),
        ),
    )
    return dm.id
  } catch (err) {
    log.warn({ err, routineId: routine.id }, "Routine's default conversation not opened")
    return null
  }
}

/** `applyDefaultReportThread` for routines created in bulk (an import), by id. */
export async function applyDefaultReportThreads(
  orgId: string,
  routineIds: string[],
): Promise<void> {
  if (routineIds.length === 0) return
  const rows = await withPrivilegedDb(orgId, "routine-report-default-bulk", (tx) =>
    tx
      .select({
        id: routines.id,
        ownerUserId: routines.ownerUserId,
        ownerAgentId: routines.ownerAgentId,
        reportThreadId: routines.reportThreadId,
      })
      .from(routines)
      .where(and(eq(routines.orgId, orgId), inArray(routines.id, routineIds))),
  )
  for (const routine of rows) await applyDefaultReportThread(orgId, routine)
}

/**
 * The tick's final reply in the output thread: the last non-empty message the
 * routine's own agent wrote since the tick started, and the union of the scopes
 * every such message was stamped with (the summary may restate any of them).
 *
 * Only a DEDICATED output thread (type "routine") is read. An output thread
 * pointed at a conversation (a DM with the agent) also carries the agent's live
 * replies to the person, and one written during the tick would be reposted as
 * the routine's report into a conversation with other members. In such a thread
 * the tick's reply is already where the person reads it, so nothing is lost.
 */
async function readTickFinalReply(
  orgId: string,
  outputThreadId: string,
  ownerAgentId: string | null,
  since: Date,
): Promise<{ content: string; requiredScopes: string[] } | null> {
  const rows = await withPrivilegedDb(orgId, "routine-report-read-reply", async (tx) => {
    const [thread] = await tx
      .select({ type: threads.type })
      .from(threads)
      .where(and(eq(threads.id, outputThreadId), eq(threads.orgId, orgId)))
      .limit(1)
    if (thread?.type !== "routine") return []
    return tx
      .select({ content: messages.content, requiredScopes: messages.requiredScopes })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, outputThreadId),
          eq(messages.orgId, orgId),
          eq(messages.authorType, "agent"),
          ownerAgentId ? eq(messages.authorAgentId, ownerAgentId) : undefined,
          gte(messages.createdAt, since),
        ),
      )
      .orderBy(asc(messages.createdAt))
  })
  const final = [...rows].reverse().find((r) => r.content.trim().length > 0)
  if (!final) return null
  return {
    content: final.content,
    requiredScopes: normalizeRequiredScopes(rows.flatMap((r) => r.requiredScopes)),
  }
}

export interface RoutineReportDelivery {
  /** The message posted in the report conversation, when one was. */
  messageId: string | null
  /**
   * The people the report reached: seated in the report conversation AND able to
   * read it. A member lacking the reply's scopes has the row hidden from them by
   * RLS, so counting them as reached suppressed the only notice they would get.
   */
  reachedUserIds: string[]
}

const NOT_DELIVERED: RoutineReportDelivery = { messageId: null, reachedUserIds: [] }

/**
 * Post the tick's final reply into the routine's report conversation.
 *
 * Best-effort: a report that cannot be delivered is logged and the tick stands
 * (its output thread holds the full run). Nothing is posted when the tick wrote
 * no text, or when the conversation no longer seats the owner.
 */
export async function deliverRoutineReport(params: {
  orgId: string
  routine: RoutineRow
  outputThreadId: string
  /** When the tick started: only this tick's replies count. */
  since: Date
  /** The owner's effective scopes, the authority the report is written under. */
  ownerScopes: string[]
}): Promise<RoutineReportDelivery> {
  const { orgId, routine, outputThreadId } = params
  const reportThreadId = routine.reportThreadId
  if (!reportThreadId || reportThreadId === outputThreadId) return NOT_DELIVERED
  try {
    const reply = await readTickFinalReply(
      orgId,
      outputThreadId,
      routine.ownerAgentId ?? null,
      params.since,
    )
    if (!reply) return NOT_DELIVERED
    const routineReport: RoutineReportMetadata = {
      routineId: routine.id,
      routineName: routine.name,
      outputThreadId,
      ownerUserId: routine.ownerUserId,
    }
    const sent = await persistAgentTurn({
      // The run's summary, in the conversation it reports to: the end of the run.
      endsTurn: true,
      // Under the OWNER's RLS, as the tick prompt is written: the owner is the
      // row's author, and the insert policy admits only a seated author. No
      // dimension grants: a message row is gated by its scopes, not dimensions.
      write: (fn) =>
        withRlsContext(
          {
            actorType: "user",
            userId: routine.ownerUserId,
            orgId,
            scopes: params.ownerScopes,
            dimensionGrants: {},
          },
          fn,
        ),
      orgId,
      userId: routine.ownerUserId,
      threadId: reportThreadId,
      agentId: routine.ownerAgentId ?? undefined,
      agentAuthorLabel: `Routine ${routine.name}`,
      content: reply.content,
      requiredScopes: reply.requiredScopes,
      // Nobody in the conversation asked for it: news to its owner too.
      unprompted: true,
      metadata: { routineReport },
    })
    if (!sent) {
      log.warn(
        { routineId: routine.id, reportThreadId },
        "Routine report not delivered: the owner is no longer in the report conversation",
      )
      return NOT_DELIVERED
    }
    const reachedUserIds = await withPrivilegedDb(orgId, "routine-report-reached", async (tx) => {
      const seated = await tx
        .select({ userId: threadParticipants.userId })
        .from(threadParticipants)
        .where(
          and(eq(threadParticipants.threadId, reportThreadId), eq(threadParticipants.orgId, orgId)),
        )
      const reached: string[] = []
      for (const { userId } of seated) {
        if (!userId) continue
        const perms = await loadEffectivePermissions(tx, userId, orgId)
        const row = { requiredScopes: reply.requiredScopes, disclosureList: null }
        if (isMessageVisible(row, { userId, grants: perms.scopes })) reached.push(userId)
      }
      return reached
    })
    return { messageId: sent.id, reachedUserIds }
  } catch (err) {
    log.error({ err, routineId: routine.id, reportThreadId }, "Routine report not delivered")
    return NOT_DELIVERED
  }
}

// ---------------------------------------------------------------------------
// THE RUN'S FLOW IN THE CONVERSATION IT POSTS TO.
//
// The routine's final message alone left the conversation silent while the run
// worked and asked for approvals nobody saw there. So the conversation also
// carries, in order:
//
//   - a calm system line "Routine <name> is running", posted when a tick
//     starts and settled to `succeeded` or `failed` when it ends (the line
//     names the run's output thread, so it is the "see the full run" link);
//   - each approval the tick asks for, as the routine's own row carrying the
//     request (`metadata.routineApproval`), drawn as the live approval card;
//   - the final message (deliverRoutineReport above).
//
// One approval request, wherever its card is drawn: the row only points at it,
// so approving from Home, the output thread or here decides the same request,
// and every card follows it through the same approval events. Nothing here is
// a notification of its own: the approval row and the summary are messages,
// with the unread state and attention every message gets.
// ---------------------------------------------------------------------------

/** What a run line's metadata carries (`metadata.routineRun`), read by the thread view. */
export interface RoutineRunLineMetadata {
  routineId: string
  routineName: string
  outputThreadId: string
  ownerUserId: string
  /** The tick it stands for. */
  runKey: string
  status: RoutineRunLineStatus
}

/**
 * `waiting_approval`: the run paused on a gated call and resumes once it is
 * decided (routine-run-resume.ts); the line goes back to `running` with
 * `resumedAt` when it does.
 */
export type RoutineRunLineStatus = "running" | "waiting_approval" | "succeeded" | "failed"

/** What a settled run line says besides its status. */
export interface RoutineRunLineFacts {
  /** A follow-up run that ended with drafts still waiting for a person: how many. */
  draftsWaiting?: number
}

/** A running line older than this belongs to a tick that died (the routine lock is 10 minutes). */
export const STALE_RUN_LINE_MS = 15 * 60 * 1000

/** The conversation a routine posts its run in, or null when it posts only in its own thread. */
function runDestination(
  routine: Pick<RoutineRow, "reportThreadId">,
  outputThreadId: string,
): string | null {
  const dest = routine.reportThreadId
  return dest && dest !== outputThreadId ? dest : null
}

/**
 * Flip run lines from `running` (or any of `from`) to `status`, and tell the
 * conversation's live readers. Idempotent: only a line still in a `from` state
 * moves, so a retry, a second settle or the sweep after the tick's own settle
 * changes nothing. A line going back to `running` (a resumed run) is stamped
 * `resumedAt`, which is what the stale sweep measures it from.
 */
async function settleRunLines(
  orgId: string,
  where: ReturnType<typeof sql>,
  status: RoutineRunLineStatus,
  from: RoutineRunLineStatus[] = ["running"],
  facts?: RoutineRunLineFacts,
): Promise<number> {
  const settled = await withPrivilegedDb(orgId, "routine-run-line-settle", async (tx) => {
    const resumed = status === "running" ? new Date().toISOString() : null
    const extra = JSON.stringify(facts ?? {})
    const rows = extractRows<{ id: string; thread_id: string; metadata: Record<string, unknown> }>(
      await tx.execute(sql`
        UPDATE ${messages}
           SET metadata = jsonb_set(metadata, '{routineRun}', (CASE WHEN ${resumed}::text IS NULL
               THEN jsonb_set(metadata->'routineRun', '{status}', to_jsonb(${status}::text))
               ELSE jsonb_set(jsonb_set(metadata->'routineRun', '{status}', to_jsonb(${status}::text)),
                 '{resumedAt}', to_jsonb(${resumed}::text))
             END) || ${extra}::jsonb)
         WHERE org_id = ${orgId}::uuid
           AND author_type = 'system'
           AND metadata->'routineRun'->>'status' IN (${sql.join(
             from.map((f) => sql`${f}`),
             sql`, `,
           )})
           AND ${where}
        RETURNING id, thread_id, metadata`),
    )
    for (const row of rows) {
      await tx.queueEvent({
        app: "kernel",
        entity: "message",
        action: "update",
        entityId: row.id,
        orgId,
        actorType: "system",
        data: {
          id: row.id,
          threadId: row.thread_id,
          metadata: row.metadata,
          replyRootId: null,
          alsoInChannel: false,
          // The line carries no content: it is shown to every reader of the room.
          ...messageVisibilityFacts({ requiredScopes: [], disclosureList: null }),
        },
      })
    }
    return rows.length
  })
  return settled
}

/**
 * Post the "Routine <name> is running" line in the routine's conversation when
 * a tick starts. A line an earlier tick of this routine left `running` there
 * died with that tick (ticks of one routine never overlap: the routine lock),
 * so it is settled `failed` first. Best-effort, null when nothing was posted.
 */
export async function postRunStarted(params: {
  orgId: string
  routine: RoutineRow
  outputThreadId: string
  runKey: string
  ownerScopes: string[]
}): Promise<string | null> {
  const { orgId, routine, outputThreadId } = params
  const threadId = runDestination(routine, outputThreadId)
  if (!threadId) return null
  try {
    await settleRunLines(
      orgId,
      sql`thread_id = ${threadId}::uuid
          AND metadata->'routineRun'->>'routineId' = ${routine.id}
          AND ${notOnAComputer}`,
      "failed",
    )
    const routineRun: RoutineRunLineMetadata = {
      routineId: routine.id,
      routineName: routine.name,
      outputThreadId,
      ownerUserId: routine.ownerUserId,
      runKey: params.runKey,
      status: "running",
    }
    const sent = await withRlsContext(
      {
        actorType: "user",
        userId: routine.ownerUserId,
        orgId,
        scopes: params.ownerScopes,
        dimensionGrants: {},
      },
      (tx) =>
        sendMessage(tx, {
          orgId,
          userId: routine.ownerUserId,
          threadId,
          content: `Routine ${routine.name} is running.`,
          authorType: "system",
          agentId: routine.ownerAgentId ?? null,
          // A status line names the routine and nothing it read.
          requiredScopes: [],
          metadata: { type: "routine-run", routineRun },
        }),
    )
    return sent?.id ?? null
  } catch (err) {
    log.warn({ err, routineId: routine.id, threadId }, "Routine run line not posted")
    return null
  }
}

/**
 * A run handed to a person's computer (a node run, `routine_runs.status`
 * `dispatched`) is still going however long it takes there: its line is
 * settled when the node job settles (nodes/jobs.ts), never by the sweep or the
 * next tick. A node run's line carries its run row's id as its `runKey`.
 */
const notOnAComputer = sql`NOT EXISTS (
  SELECT 1 FROM ${routineRuns} rr
   WHERE rr.id::text = ${messages}.metadata->'routineRun'->>'runKey'
     AND rr.status = 'dispatched'
)`

/** Settle the line of a run by its key (a node run: its run row's id), idempotent. */
export async function settleRunLineOfRun(
  orgId: string,
  routineId: string,
  runKey: string,
  status: Exclude<RoutineRunLineStatus, "running">,
): Promise<void> {
  try {
    await settleRunLines(
      orgId,
      sql`metadata->'routineRun'->>'routineId' = ${routineId}
          AND metadata->'routineRun'->>'runKey' = ${runKey}`,
      status,
    )
  } catch (err) {
    log.warn({ err, routineId, runKey }, "Routine run line not settled")
  }
}

/**
 * Settle the tick's own run line when it ends (idempotent). A paused run's
 * line says `waiting_approval`, goes back to `running` when the run resumes,
 * and settles from either when the run ends.
 */
export async function settleRunStarted(
  orgId: string,
  lineId: string | null,
  status: RoutineRunLineStatus,
  facts?: RoutineRunLineFacts,
): Promise<void> {
  if (!lineId) return
  const from: RoutineRunLineStatus[] =
    status === "running" ? ["waiting_approval"] : ["running", "waiting_approval"]
  try {
    await settleRunLines(orgId, sql`id = ${lineId}::uuid`, status, from, facts)
  } catch (err) {
    log.warn({ err, lineId }, "Routine run line not settled")
  }
}

/**
 * The sweep for ticks that died without settling their line (a crash, a
 * deploy, a timeout that killed the worker): every line still `running` past
 * {@link STALE_RUN_LINE_MS} in a routine's conversation is settled `failed`.
 * Read through each routine's own conversation (indexed by thread), never a
 * scan of every message. Run with the event-routine reconciler.
 */
export async function settleStaleRunLines(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_RUN_LINE_MS)
  // An org being moved keeps its routines and runs as they are until the move ends.
  const destinations = await sweepSkippingMoving((notMoving) =>
    withSystemDb("routine-run-line-sweep", async (db) =>
      extractRows<{ org_id: string; routine_id: string; thread_id: string }>(
        await db.execute(sql`
        SELECT org_id::text, id::text AS routine_id, report_thread_id::text AS thread_id
          FROM ${routines}
         WHERE report_thread_id IS NOT NULL AND ${notMoving(sql.raw("org_id"))}`),
      ),
    ),
  )
  let settled = 0
  for (const d of destinations) {
    try {
      const n = await writeUnlessMoving(d.org_id, () =>
        settleRunLines(
          d.org_id,
          sql`thread_id = ${d.thread_id}::uuid
            AND metadata->'routineRun'->>'routineId' = ${d.routine_id}
            AND ${notOnAComputer}
            AND COALESCE((metadata->'routineRun'->>'resumedAt')::timestamptz, created_at)
                < ${cutoff.toISOString()}::timestamptz`,
          "failed",
        ),
      )
      if (n !== SKIPPED_MOVING) settled += n
    } catch (err) {
      log.warn({ err, routineId: d.routine_id }, "Stale routine run lines not settled")
    }
  }
  return settled
}

/** What a routine's approval row carries (`metadata.routineApproval`), drawn as the live card. */
export interface RoutineApprovalMetadata {
  requestId: string
  handle: string
  toolName: string
  routineId: string
  routineName: string
  outputThreadId: string
}

/**
 * Put the approval a routine's tick just asked for in the conversation the
 * routine posts to, as the routine's own row pointing at the request.
 *
 * Who sees it: the row is stamped with the scopes the proposing turn had read
 * (as the report is), so a member who could not read the run cannot read the
 * row; and the card inside it is the approval itself, which only its audience
 * can load (approval RLS and `notify_user_ids`), so a member who may not decide
 * it sees no card. It is news to the conversation's members (`unprompted`):
 * unread, with the usual attention. Best-effort: the request stands in Home
 * and in the run's own thread whatever happens here.
 */
export async function postRoutineApproval(params: {
  orgId: string
  routineId: string
  requestId: string
  handle: string
  toolName: string
  requestedBy: string
  /** The thread the tick ran in (the request's originating thread). */
  outputThreadId: string
  /** What the proposing turn had read; null when unknown (the routine's own ceiling then). */
  requiredScopes: string[] | null
}): Promise<string | null> {
  const { orgId } = params
  try {
    const [routine] = await withPrivilegedDb(orgId, "routine-approval-destination", (tx) =>
      tx
        .select()
        .from(routines)
        .where(and(eq(routines.id, params.routineId), eq(routines.orgId, orgId)))
        .limit(1),
    )
    if (!routine) return null
    const threadId = runDestination(routine, params.outputThreadId)
    // Only the routine's own asks: it runs as its owner, who is the requester.
    if (!threadId || routine.ownerUserId !== params.requestedBy) return null
    const perms = await withPrivilegedDb(orgId, "routine-approval-perms", (tx) =>
      loadEffectivePermissions(tx, routine.ownerUserId, orgId),
    )
    const routineApproval: RoutineApprovalMetadata = {
      requestId: params.requestId,
      handle: params.handle,
      toolName: params.toolName,
      routineId: routine.id,
      routineName: routine.name,
      outputThreadId: params.outputThreadId,
    }
    const sent = await persistAgentTurn({
      // An approval card the run raised: its own approvals item tells the deciders.
      endsTurn: false,
      write: (fn) =>
        withRlsContext(
          {
            actorType: "user",
            userId: routine.ownerUserId,
            orgId,
            scopes: perms.scopes,
            dimensionGrants: {},
          },
          fn,
        ),
      orgId,
      userId: routine.ownerUserId,
      threadId,
      agentId: routine.ownerAgentId ?? undefined,
      agentAuthorLabel: `Routine ${routine.name}`,
      content: `Approval request ${params.handle} is waiting for a decision.`,
      // Unknown is never "nothing": the routine's ceiling, what the run could read.
      requiredScopes: normalizeRequiredScopes(params.requiredScopes ?? routine.scopes ?? []),
      unprompted: true,
      metadata: { routineApproval },
    })
    return sent?.id ?? null
  } catch (err) {
    log.warn(
      { err, routineId: params.routineId },
      "Routine approval not posted to its conversation",
    )
    return null
  }
}
