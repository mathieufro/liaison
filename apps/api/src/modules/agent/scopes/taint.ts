// SPDX-License-Identifier: FSL-1.1-ALv2
import { orgKernelSettingsSchema } from "@liaison/shared"
import { and, eq, type SQL, sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { threads } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { broadcastEphemeral } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import { getOrgKernelSettings } from "~/lib/settings"
import { hasOtherLiveRun, threadRunKey } from "~/modules/agent/scopes/live-runs"
import { writeAuditLog } from "~/modules/audit/service"

const K = () => sql.raw(schemaRef("kernel"))

const log = rootLogger.child({ module: "taint" })

/**
 * Tool calls running on a thread that record whether they marked it (the tool bridge). Whatever
 * marks the thread while a call runs (the call's own taint source, a knowledge read deciding per
 * document, a sub-run's result) is that call's doing, so its stored metadata says it brought
 * outside text in, and a later turn replaying it is marked from that record. Two calls running at
 * once on one thread both count as marking: the safe direction. In-process: the watcher and the
 * marking call always share a process.
 */
const markWatchers = new Map<string, Set<{ marked: boolean }>>()

export function watchTaintMarks(threadId: string): { readonly marked: boolean; stop(): void } {
  const watcher = { marked: false }
  let watchers = markWatchers.get(threadId)
  if (!watchers) {
    watchers = new Set()
    markWatchers.set(threadId, watchers)
  }
  watchers.add(watcher)
  return {
    get marked() {
      return watcher.marked
    },
    stop() {
      const current = markWatchers.get(threadId)
      if (!current) return
      current.delete(watcher)
      if (current.size === 0) markWatchers.delete(threadId)
    },
  }
}

/**
 * `source`: the namespace of the one MCP server whose result brought the outside text in
 * (`mcp:<slug>`, `outsideTextSourceOf`). Omitted, the source is unknown, and the thread's sources
 * become unknown for as long as the mark stands: every hold then applies (scope-taint.ts, rule
 * 6h). A known source starts the set on an unmarked thread and joins a known set on a marked one;
 * it never turns an unknown set known.
 */
export async function setTaintFlag(
  threadId: string,
  orgId: string,
  opts: { sourceAt?: Date; source?: string } = {},
): Promise<void> {
  for (const watcher of markWatchers.get(threadId) ?? []) watcher.marked = true
  // When it was marked, by the database clock: now for a read that just ran, or, for a turn that
  // replays stored history, when the newest source row was written. A person's clear keeps a mark
  // set after its card was created (clearOutsideTextMark).
  const at = opts.sourceAt ? sql`${opts.sourceAt.toISOString()}::timestamptz` : sql`now()`
  await withPrivilegedDb(orgId, "set-taint-flag", async (tx) => {
    await tx
      .update(threads)
      .set({
        tainted: true,
        taintedAt: sql`GREATEST(COALESCE(${threads.taintedAt}, ${at}), ${at})`,
        // Every SET expression reads the row as it was before this update.
        taintedSources:
          opts.source === undefined
            ? sql`NULL`
            : sql`CASE
                WHEN NOT ${threads.tainted} THEN ARRAY[${opts.source}::text]
                WHEN ${threads.taintedSources} IS NULL THEN NULL
                WHEN ${opts.source}::text = ANY(${threads.taintedSources}) THEN ${threads.taintedSources}
                ELSE array_append(${threads.taintedSources}, ${opts.source}::text)
              END`,
      })
      .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
  })
  // Broadcast taint change so frontend can update reactively
  broadcastEphemeral({
    app: "kernel",
    entity: "thread",
    action: "update",
    entityId: threadId,
    orgId,
    actorId: "system",
    actorType: "system",
    data: { id: threadId, type: "agent_chat", changes: { tainted: true } },
  }).catch((err) => log.error({ err, threadId }, "Failed to broadcast taint update"))
}

interface CheckTaintParams {
  threadId: string
  orgId: string
  /** The tool declares a trustBoundary (every user-facing write/read of an app). */
  toolHasTrustBoundary: boolean
  /** The tool has an external side effect or an exfiltration channel (send, post, upload, fetch). */
  toolHasExternalEffect?: boolean
}

export type WebContentProtection = "off" | "standard" | "hardened"

/**
 * The org's untrusted-content posture (`organizations.settings.webContentProtection`):
 * - "standard" (the default): after a turn read outside text, an ungated outward tool becomes an
 *   approval request a person decides.
 * - "hardened": every trust-boundary tool does too.
 * - "off": an org admin's explicit choice to let the agent act on outside text unattended. The turn
 *   is still marked and outside text still fenced; nothing waits for a person because of it.
 */
export async function getWebContentProtection(orgId: string): Promise<WebContentProtection> {
  return withPrivilegedDb(orgId, "taint-protection", async (tx) => {
    const settings = await getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema)
    return settings.webContentProtection ?? "standard"
  })
}

/**
 * Has this turn read outside text AND does the org want such turns held for a person? The single
 * question every untrusted-content approval asks (escalation, auto-approve policies) and what files
 * an agent's Knowledge write for review. False when the org switched the protection off.
 */
export async function untrustedTurnNeedsApproval(
  threadId: string,
  orgId: string,
): Promise<boolean> {
  if (!(await isThreadTainted(threadId, orgId))) return false
  return (await getWebContentProtection(orgId)) !== "off"
}

/**
 * Does a tool call after the turn read untrusted text have to wait for a human?
 *
 * - `externalEffect` tools (an outward channel: upload, post, survey) park in "standard"
 *   and "hardened": they protect exactly the tools whose side effect cannot be taken back or
 *   carries data out; "hardened" additionally parks every trust-boundary tool. A web read
 *   (web_fetch, web_search) never parks here (scope-taint.ts, rule 9): the dispatch does not ask,
 *   and the web-read guardrails bound it instead.
 * - "off" parks nothing.
 * - The result is an approval request (`taint_escalation`), never a hard failure: the person
 *   reads what the injected turn wants to do and decides.
 *
 * Turns that read nothing untrusted are unaffected (`threads.tainted` is false). The mark is reset
 * when a new turn or tick starts (`clearTaintFlag`).
 */
export async function checkTaintEscalation(
  params: CheckTaintParams,
): Promise<{ blocked: boolean; reason?: string }> {
  const { threadId, orgId, toolHasTrustBoundary } = params
  const toolHasExternalEffect = params.toolHasExternalEffect === true

  if (!toolHasTrustBoundary && !toolHasExternalEffect) return { blocked: false }

  const result = await withPrivilegedDb(orgId, "taint-check", async (tx) => {
    const [thread] = await tx
      .select({ tainted: threads.tainted })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
    if (!thread?.tainted) return { blocked: false as const }

    const settings = await getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema)
    const protection = settings.webContentProtection ?? "standard"
    if (protection === "off") return { blocked: false as const }

    if (toolHasExternalEffect || protection === "hardened") {
      return { blocked: true as const, reason: "taint_escalation" }
    }
    return { blocked: false as const }
  })

  return result
}

/**
 * The namespace of the MCP server a tool belongs to (`mcp:<slug>` for `mcp:<slug>:<tool>`), the
 * one outside-text source a thread records by name. Anything else is null: an unnamed source.
 */
export function outsideTextSourceOf(toolName: string | null | undefined): string | null {
  const m = typeof toolName === "string" ? /^mcp:([a-z0-9-]{1,32}):[^:]/.exec(toolName) : null
  return m ? `mcp:${m[1]}` : null
}

/**
 * True when no thread in `threadIds` holds outside text from anywhere but `source`: each is either
 * unmarked, or marked with a known source set whose every entry is `source`. An unknown set (a
 * source with no name, a mark from before migration 0199) or any other source is false.
 */
export async function outsideTextOnlyFrom(
  threadIds: ReadonlyArray<string>,
  orgId: string,
  source: string,
): Promise<boolean> {
  if (threadIds.length === 0) return false
  return withPrivilegedDb(orgId, "taint-sources-read", async (tx) => {
    for (const threadId of threadIds) {
      const [thread] = await tx
        .select({ tainted: threads.tainted, sources: threads.taintedSources })
        .from(threads)
        .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
      if (!thread) return false
      if (!thread.tainted) continue
      if (!thread.sources || thread.sources.length === 0) return false
      if (!thread.sources.every((s) => s === source)) return false
    }
    return true
  })
}

/** Is thread tainted (has the turn read untrusted outside text)? */
export async function isThreadTainted(threadId: string, orgId: string): Promise<boolean> {
  return withPrivilegedDb(orgId, "taint-read", async (tx) => {
    const [thread] = await tx
      .select({ tainted: threads.tainted })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
    return thread?.tainted === true
  })
}

/**
 * The thread's outside-text mark as it stands: whether it is set, and the sources it names (the MCP
 * servers the text came from), or null when a source is unknown. What a paused routine run keeps,
 * so its resume goes on under the same mark (restoreTaintMark).
 */
export async function readTaintMark(
  threadId: string,
  orgId: string,
): Promise<{ tainted: boolean; sources: string[] | null }> {
  return withPrivilegedDb(orgId, "taint-mark-read", async (tx) => {
    const [thread] = await tx
      .select({ tainted: threads.tainted, sources: threads.taintedSources })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
    const tainted = thread?.tainted === true
    return { tainted, sources: tainted && thread?.sources?.length ? thread.sources : null }
  })
}

/**
 * Put back a mark kept by readTaintMark before a run's next part: unmarked when it was not tainted,
 * else marked with exactly those sources (null: unknown, which every hold applies to).
 */
export async function restoreTaintMark(
  threadId: string,
  orgId: string,
  mark: { tainted: boolean; sources: readonly string[] | null },
): Promise<void> {
  await clearTaintFlag(threadId, orgId)
  if (!mark.tainted) return
  if (!mark.sources || mark.sources.length === 0) {
    await setTaintFlag(threadId, orgId)
    return
  }
  for (const source of mark.sources) await setTaintFlag(threadId, orgId, { source })
}

/**
 * A turn the person typed directly: a foreground chat message of an in-app agent. A routine tick,
 * a background or job-driven re-invocation, a sub-run, an agent-to-agent ask, a restricted session's
 * message, the MCP gateway and a call with no run frame at all (a trigger, an inbound event) are
 * NOT: nothing proves a person is looking at what they decide to do. Fails closed: the frame must say so.
 */
export function isHumanTypedTurn(frame: { humanTurn?: boolean } | undefined): boolean {
  return frame?.humanTurn === true
}

/**
 * Where a routine's triggering event came from, decided where the event is matched
 * (`event-routine-subscriber.ts`) and carried on the tick's payload:
 * - "external": the event carries text written outside the organisation (an inbound mail or
 *   ticket message from an outside sender, a third-party webhook payload, a social post).
 * - "internal": an org member or the org's own agent produced it (an internal thread message, a
 *   task change, a member's action).
 * Absent (a payload queued before this field existed) counts as external: fail closed.
 */
export type TriggerEventOrigin = "external" | "internal"

/**
 * The untrusted-content mark covers the turn that read the outside text, not the thread's whole
 * life. A new turn the person typed and a new routine tick start clean, so a long-lived thread is
 * no longer held forever by one read it made weeks ago. Within the turn the mark stands: a read
 * then an outward tool in the same turn still parks. A typed turn whose history still replays
 * outside text is marked again right after (replayed-outside-text.ts). An MCP connection's thread
 * is never cleared: the gateway cannot tell a client's new conversation from a reconnect of one
 * that still holds the text (mcp/transport-routes.ts).
 */
export async function clearTaintFlag(
  threadId: string,
  orgId: string,
  opts: { ownRunId?: string } = {},
): Promise<void> {
  // Another run still live on this thread keeps its mark: the reset waits for the next start.
  if (await hasOtherLiveRun(threadRunKey(threadId), opts.ownRunId)) return
  const cleared = await withPrivilegedDb(orgId, "clear-taint-flag", async (tx) =>
    tx
      .update(threads)
      .set({ tainted: false, taintedSources: null })
      .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId), eq(threads.tainted, true)))
      .returning({ id: threads.id }),
  )
  if (cleared.length === 0) return
  broadcastEphemeral({
    app: "kernel",
    entity: "thread",
    action: "update",
    entityId: threadId,
    orgId,
    actorId: "system",
    actorType: "system",
    data: { id: threadId, type: "agent_chat", changes: { tainted: false } },
  }).catch((err) => log.error({ err, threadId }, "Failed to broadcast taint clear"))
}

/**
 * When a person last cleared this thread's outside-text mark, or null. History rows written at or
 * before it no longer mark a turn that replays them (replayed-outside-text.ts).
 */
export async function loadTaintClearedAt(threadId: string, orgId: string): Promise<Date | null> {
  return withPrivilegedDb(orgId, "taint-cleared-at", async (tx) => {
    const [thread] = await tx
      .select({ at: threads.taintClearedAt })
      .from(threads)
      .where(and(eq(threads.id, threadId), eq(threads.orgId, orgId)))
    return thread?.at ?? null
  })
}

/**
 * A person's decision (the approved kernel:outside_text_clear): the outside text this thread had
 * read when the approval card was created may be acted on. The clear time is that card's creation
 * time, by the database clock, so what the person saw listed on the card is exactly what they
 * cleared: a later turn replaying that history is not marked again by it. Outside text read after
 * the card was created still marks: the live mark stays when it was set after the card, and rows
 * written after it mark a later turn. Otherwise the mark is lifted now, including for a run still
 * live on the thread (unlike clearTaintFlag, which waits for the next start). The clear time never
 * moves back (an older card approved after a newer one). Returns false when the request is not a
 * card raised on this thread: nothing changes.
 */
export async function clearOutsideTextMark(
  threadId: string,
  orgId: string,
  approvalRequestId: string,
): Promise<boolean> {
  return liftOutsideTextMark(
    threadId,
    orgId,
    sql`SELECT ar.created_at AS at
          FROM ${K()}.approval_requests ar
         WHERE ar.id = ${approvalRequestId}::uuid
           AND ar.org_id = ${orgId}::uuid
           AND ar.tool_name = 'kernel:outside_text_clear'
           AND (ar.originating_thread_id = ${threadId}::uuid OR ar.thread_id = ${threadId}::uuid)`,
  )
}

/**
 * The same decision taken directly by the person in the conversation (the globe's "Clear the
 * mark", POST /threads/:id/outside-text/clear): the click IS the approval the card would have
 * asked them for, so it applies the approved clear's effect with the clear time "now", by the
 * database clock. Everything the thread had read until the click may be acted on; anything read
 * afterwards marks it again. The caller has already decided the person may (threads/routes.ts).
 * Records who cleared it in the audit log. Returns false when the thread is not there.
 */
export async function clearOutsideTextMarkNow(
  threadId: string,
  orgId: string,
  clearedBy: string,
): Promise<boolean> {
  return liftOutsideTextMark(threadId, orgId, sql`SELECT now() AS at`, { clearedBy })
}

/**
 * The one rule of a person's clear, for both ways of deciding it: `clearAt` is a query yielding
 * one row whose `at` is the clear time (no row: nothing changes). Rows written at or before it no
 * longer mark a turn (replayed-outside-text.ts), the live mark stays only when it was set after
 * it, and the clear time never moves back.
 */
async function liftOutsideTextMark(
  threadId: string,
  orgId: string,
  clearAt: SQL,
  opts: { clearedBy?: string } = {},
): Promise<boolean> {
  const row = await withPrivilegedDb(orgId, "clear-outside-text-mark", async (tx) => {
    const result = await tx.execute(sql`
      WITH c AS (${clearAt})
      UPDATE ${K()}.threads t
         SET taint_cleared_at = GREATEST(COALESCE(t.taint_cleared_at, c.at), c.at),
             tainted = t.tainted AND t.tainted_at IS NOT NULL AND t.tainted_at > c.at,
             tainted_sources = CASE
               WHEN t.tainted AND t.tainted_at IS NOT NULL AND t.tainted_at > c.at
               THEN t.tainted_sources END
        FROM c
       WHERE t.id = ${threadId}::uuid
         AND t.org_id = ${orgId}::uuid
      RETURNING t.tainted`)
    const updated = extractRows<{ tainted: boolean }>(result)[0]
    if (updated && opts.clearedBy) {
      await writeAuditLog(
        tx,
        {
          orgId,
          actorId: opts.clearedBy,
          actorType: "user",
          app: "kernel",
          entityType: "thread",
          entityId: threadId,
          action: "outside_text_mark_cleared",
        },
        { required: true },
      )
    }
    return updated
  })
  if (!row) return false
  if (!row.tainted) {
    broadcastEphemeral({
      app: "kernel",
      entity: "thread",
      action: "update",
      entityId: threadId,
      orgId,
      actorId: "system",
      actorType: "system",
      data: { id: threadId, type: "agent_chat", changes: { tainted: false } },
    }).catch((err) => log.error({ err, threadId }, "Failed to broadcast taint clear"))
  }
  return true
}

/** Does this triggering event carry text from outside the organisation? Fails closed. */
export function triggerEventIsExternal(triggerEvent: unknown): boolean {
  if (!triggerEvent || typeof triggerEvent !== "object") return false
  return (triggerEvent as { origin?: unknown }).origin !== "internal"
}

/**
 * Each routine tick starts clean. An event-fired tick whose event carries outside text has that
 * payload in its prompt before any tool ran, so no taintSource tool ever marks the thread: mark it
 * here, before the first turn. A tick fired by an internal event, a cron tick and a run-now tick
 * without outside data start unmarked. Not best-effort: a tick that cannot record its state must
 * not run, so the error propagates.
 */
export async function taintThreadForTriggerEvent(
  threadId: string,
  orgId: string,
  triggerEvent: unknown,
): Promise<void> {
  if (triggerEventIsExternal(triggerEvent)) {
    await setTaintFlag(threadId, orgId)
    return
  }
  await clearTaintFlag(threadId, orgId)
}

/** A manifest's `taintSourceWhen`: the field of a row read and the value that makes it outside text. */
export interface TaintSourceRowCondition {
  field: string
  equals: string | number | boolean
}

/** How deep the row walk looks into a result: a row sits in a list, a list in an object or two. */
const ROW_WALK_DEPTH = 6

/**
 * Does a result hold a row the condition calls outside text? A row is any object in the result
 * that carries the condition's field. One matching row taints the turn; rows that all carry
 * another value leave it clean. A result with no row carrying the field cannot be judged, so it
 * taints (fail closed): a projection that drops the field must not make outside text read clean.
 */
export function rowsMatchTaintCondition(result: unknown, cond: TaintSourceRowCondition): boolean {
  let sawRow = false
  const walk = (value: unknown, depth: number): boolean => {
    if (value === null || typeof value !== "object" || depth > ROW_WALK_DEPTH) return false
    if (Array.isArray(value)) return value.some((item) => walk(item, depth + 1))
    const row = value as Record<string, unknown>
    if (Object.hasOwn(row, cond.field)) {
      sawRow = true
      if (row[cond.field] === cond.equals) return true
    }
    return Object.values(row).some((child) => walk(child, depth + 1))
  }
  if (walk(result, 0)) return true
  return !sawRow
}

/**
 * Does this successful call of a `taintSource` tool taint the turn? Always, unless the tool is
 * narrowed: by the host's `taintSourceWhen` function (analyze_media: only a file from outside the
 * org), or by the manifest's row condition read on the result (`taintSourceWhenRow`). A narrowing
 * that cannot answer counts as yes, and so does a row condition with no result to read: fail closed.
 */
export async function taintSourceApplies(
  tool: {
    taintSource?: boolean
    taintSourceWhen?: (params: unknown, ctx: { orgId: string }) => Promise<boolean>
    taintSourceWhenRow?: TaintSourceRowCondition
  },
  params: unknown,
  orgId: string,
  read?: { result: unknown },
): Promise<boolean> {
  if (!tool.taintSource) return false
  if (tool.taintSourceWhen) {
    try {
      return await tool.taintSourceWhen(params, { orgId })
    } catch (err) {
      log.error({ err }, "taintSourceWhen failed: the turn is marked")
      return true
    }
  }
  if (tool.taintSourceWhenRow) {
    if (!read) return true
    return rowsMatchTaintCondition(read.result, tool.taintSourceWhenRow)
  }
  return true
}

/**
 * A `taintSource` tool's successful result has reached `threadIds`: mark each of them as having
 * read outside text, exactly as the live call marks its turn. Returns whether the result taints
 * (so a caller can fence it); throws when the mark cannot be recorded, and the caller withholds the
 * result rather than let untrusted text reach the model unmarked (fail closed). Shared by the live
 * call (execute-tool.ts) and an approved call's result handed back to its conversation
 * (approvals/result-notice.ts).
 */
export async function markThreadsForTaintSourceResult(
  tool: Parameters<typeof taintSourceApplies>[0],
  params: unknown,
  orgId: string,
  threadIds: ReadonlyArray<string | null | undefined>,
  toolName?: string,
  read?: { result: unknown },
): Promise<boolean> {
  if (!(await taintSourceApplies(tool, params, orgId, read))) return false
  const source = outsideTextSourceOf(toolName) ?? undefined
  for (const threadId of new Set(threadIds.filter((t): t is string => Boolean(t)))) {
    await setTaintFlag(threadId, orgId, source ? { source } : {})
  }
  return true
}
