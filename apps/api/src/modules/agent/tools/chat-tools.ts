// SPDX-License-Identifier: FSL-1.1-ALv2
import { agentSpeakerName } from "@liaison/shared"
import { and, desc, sql as drizzleSql, eq, gt, ilike, inArray, isNull, or } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agents, messages, routines, threadParticipants, threads, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { EXTERNAL_CLIENT_POST_KEY } from "~/modules/agent/context/agent-attribution"
import { routineDisplayName } from "~/modules/agent/routines/routine-label"
import {
  captureActingAgentId,
  currentRunContext,
  currentToolCallScopesBefore,
  isPersonExternalClientCall,
} from "~/modules/agent/runtime/run-context"
import {
  decidePostDisclosure,
  type PostTarget,
  TAINT_DISCLOSURE_APPROVAL_KEY,
  TAINT_DISCLOSURE_EXTERNAL_CLIENT_KEY,
} from "~/modules/agent/scopes/post-disclosure"
import {
  SCOPE_TAINT_BLOCKED_MESSAGE,
  SINK_KERNEL_MESSAGES,
  taintSourceApps,
  toScopeTaintBlockedError,
  UNKNOWN_TURN_TAINT,
} from "~/modules/agent/scopes/scope-taint"
import {
  holdsEveryScope,
  loadOrgMemberGrants,
  peopleTaintGap,
  threadPeopleIds,
} from "~/modules/agent/scopes/taint-approval-audience"
import { expandWildcardStamp } from "~/modules/agent/scopes/taint-read-scopes"
import { openContactDiscussion } from "~/modules/contacts/discussion"
import { attachFilesToParent, FileServiceError } from "~/modules/files/attach"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import {
  enrolInEntityDiscussion,
  isDiscussionEntity,
  openEntityDiscussion,
} from "~/modules/threads/entity-discussion"
import { publishMessageAttachments, sendMessage } from "~/modules/threads/message"
import { dispatchForPostedMessage } from "~/modules/threads/posted-message-dispatch"
import { createThread, listThreads } from "~/modules/threads/thread"
import { canReadThreadAnchorEntity } from "~/modules/threads/thread-anchor"

interface ChatToolContext {
  userId: string
  orgId: string
  db: RlsClient
  /**
   * The thread the agent loop is executing in. When it is a routine's run-log
   * thread, agent posts are attributed to "Routine {name}"; otherwise to
   * "{User}'s agent".
   */
  agentExecutionThreadId?: string
  /** The calling actor's effective scopes, injected by executeTool. */
  scopes?: string[]
  /** Where this call came from, as `createAppContext` stamps it. "mcp" with no
   *  acting agent is a PERSON on an external client. */
  actorType?: "user" | "agent" | "mcp"
  /** The agent taking this turn, when one is. */
  actingAgentId?: string | null
  /** The acting user's dimension grants, for the turns this post may start. */
  dimensionGrants?: Record<string, string[]>
  /** The calling turn's scope taint as the dispatch resolved it (raw). */
  turnTaintScopes?: readonly string[]
  /** The approval this call executes, on an approved re-entry (createAppContext). */
  approvalRequestId?: string
}

/** An approved disclosure (scope-taint.ts, rule 11b), as the approval row recorded it. */
interface ApprovedPostDisclosure {
  /** The people of the conversation when the post parked: approving disclosed it to them. */
  audience: string[]
  /** The post was a person's own external-client request, with that connection's scopes: the
   *  dispatch recorded it when it parked, since the re-entry runs without the client's frame. */
  externalClient: ExternalClientPoster | null
}

/** Who a person's external-client post wakes agents as: that person, never widened. */
interface ExternalClientPoster {
  /** The connection's scopes, as recorded when the post parked. */
  scopes: string[]
  /** The requester's own dimension grants. The re-entry's are the requester's widened by the
   *  decider's (delegated authority to run the handler), which no woken turn may inherit. */
  dimensionGrants: Record<string, string[]>
}

/**
 * The approved disclosure this call executes, or null when it executes no such approval. The
 * dispatch parked the post because some of its readers lack what the turn read and recorded who
 * the post would reach then; the requester, who holds the taint, approved sharing it with
 * exactly them. Read off the row, never assumed from a bare approval id; a row without the
 * snapshot discloses to nobody.
 */
async function approvedPostDisclosure(
  ctx: ChatToolContext,
): Promise<ApprovedPostDisclosure | null> {
  const id = ctx.approvalRequestId
  if (!id) return null
  const rows = await withPrivilegedDb(ctx.orgId, "agent-post-disclosure", async (tx) =>
    extractRows<{ disclosed: boolean | null; audience: unknown; external_client: unknown }>(
      await tx.execute(drizzleSql`
        SELECT (metadata->>'taintDisclosedToReaders')::boolean AS disclosed,
               metadata->'taintDisclosureAudience' AS audience,
               metadata->${TAINT_DISCLOSURE_EXTERNAL_CLIENT_KEY} AS external_client
        FROM ${drizzleSql.raw(schemaRef("kernel"))}.approval_requests
        WHERE id = ${id}::uuid AND org_id = ${ctx.orgId}::uuid`),
    ),
  )
  const row = rows[0]
  if (row?.disclosed !== true || !Array.isArray(row.audience)) return null
  const external = row.external_client as { scopes?: unknown } | null | undefined
  const scopes =
    external && Array.isArray(external.scopes)
      ? external.scopes.filter((s): s is string => typeof s === "string")
      : null
  return {
    audience: row.audience.filter((u): u is string => typeof u === "string"),
    externalClient:
      scopes === null
        ? null
        : {
            scopes,
            dimensionGrants: (
              await withPrivilegedDb(ctx.orgId, "agent-post-disclosure-requester", (tx) =>
                loadEffectivePermissions(tx, ctx.userId, ctx.orgId),
              )
            ).dimensionGrants,
          },
  }
}

// Where a new thread's title and references land (the thread row and kernel.thread_references).
// Not an enforcing sink: judged by the thread's participants.
const SINK_KERNEL_THREADS = "kernel.threads"

/**
 * True when a PERSON is calling, from a connection bound to no agent (an
 * external MCP client such as Claude Code). The words are still a MODEL's,
 * written for the person: the row is authored as "{User}'s agent" exactly like
 * an in-app agent post, never as the person, and it carries the external-client
 * marker so the agent that reads it takes it as a request. It triggers the
 * agents it addresses exactly as the same post through the thread route does.
 * Every agent-driven call (an in-app turn, a routine tick, an agent-bound MCP
 * connection) has an acting agent or a live run frame and is unchanged.
 */
function isHumanActor(ctx: ChatToolContext): boolean {
  // Its gateway frame (scope-taint.ts, rule 14) is the person's own, as no frame was before it.
  return isPersonExternalClientCall({
    mcp: ctx.actorType === "mcp",
    actingAgentId: ctx.actingAgentId ?? captureActingAgentId(),
  })
}

/**
 * The requiredScopes of an agent post, which may quote what the calling turn
 * read. The turn's taint when the frame carries it (what it read before this
 * call; the reply tool's own write scope is not data). Otherwise fail closed
 * like the sandbox bridge's messages.post: the frame's effective scope, then
 * the caller's scopes (a direct call with no frame at all acts with those), and
 * null (refuse with scope_unknown) when none is known. Every MCP gateway call,
 * an agentless one included, runs under a frame with an accumulator (rule 14),
 * and a stamp that would hide the post from someone it addresses is refused by
 * the handler, never written (resolvePostVisibility).
 */
export function agentPostRequiredScopes(ctx: { scopes?: string[] }): string[] | null {
  const frame = currentRunContext()
  const known =
    currentToolCallScopesBefore() ??
    frame?.turnScopeAccumulator?.snapshot() ??
    frame?.effectiveScope ??
    ctx.scopes
  return known === undefined ? null : [...new Set(known)].sort()
}

const SCOPE_UNKNOWN_ERROR =
  "scope_unknown: this agent turn's scope taint is unknown, so the message was not posted"

/** The handler's refusal of a post that would be written hidden (scope-taint.ts, rule 14). */
export const POST_WOULD_BE_HIDDEN_CODE = "post_would_be_hidden"

function postWouldBeHiddenError(gap: { missingScopes: string[]; lacking: number | null }): {
  code: string
  message: string
} {
  // Only what the people lacking it lack, never the whole taint (they may hold most of it).
  const apps = taintSourceApps(gap.missingScopes)
  const what = apps.length > 0 ? `${apps.join(", ")} data` : "data"
  const who =
    gap.lacking === null
      ? "Some people in this conversation may not be able to see what this session read (it could not be checked)"
      : `${gap.lacking} ${gap.lacking === 1 ? "person" : "people"} in this conversation cannot see ${what} this session read`
  return {
    code: POST_WOULD_BE_HIDDEN_CODE,
    message: `NOT POSTED. ${who}, so they would not see this message, and a message is never written hidden from the people it is meant for. Nothing was sent, and no approval was created. Tell the user it was not posted and why. You may post a version that leaves that data out; otherwise a person who can see that data shares it with these people themselves, or an admin adjusts their access. Do not retry the same message.`,
  }
}

type PostVisibility =
  | {
      disclosureList: string[] | null
      metadata?: Record<string, unknown>
      /** An approved post a person's external client requested: who it wakes agents as. */
      externalClient?: ExternalClientPoster
    }
  | { error: { code: string; message: string } }

/**
 * Who a post stamped `stamp` is written for (scope-taint.ts, rules 11 and 14). An approved
 * disclosure (rule 11b) reaches the people it was approved for who are still there, and marks
 * the row with its approval: that is the requester's standing disclosure for this thread. Without
 * one, the post is written only when nobody else in the conversation would lose it, or when a
 * direct message or the standing disclosure covers them (post-disclosure.ts); otherwise it is
 * refused, never written hidden.
 */
async function resolvePostVisibility(
  ctx: ChatToolContext,
  stamp: readonly string[],
  target: PostTarget,
  people: () => Promise<string[]>,
): Promise<PostVisibility> {
  const approved = await approvedPostDisclosure(ctx)
  if (approved !== null) {
    const snapshot = approved.audience
    const now = await people()
    // Someone who joined after the post parked was not part of the decision. Writing it would
    // hide it from them when they lack what it carries, so it is not written (rule 14e).
    const newcomers = now.filter((u) => !snapshot.includes(u))
    if (newcomers.length > 0) {
      const gap = await peopleTaintGap({
        orgId: ctx.orgId,
        userIds: newcomers,
        taintScopes: expandWildcardStamp(stamp, ctx.orgId),
      })
      if (gap !== null) {
        return {
          error: {
            code: POST_WOULD_BE_HIDDEN_CODE,
            message: `NOT POSTED. Since this message was approved, ${gap.lacking === null ? "someone" : gap.lacking === 1 ? "1 person" : `${gap.lacking} people`} joined this conversation who cannot see the data it carries, so they would not see it. Nothing was sent. Tell the user: to share it with everyone now in the conversation, send it again; it will ask for their approval once more.`,
          },
        }
      }
    }
    return {
      disclosureList: now.filter((u) => snapshot.includes(u)),
      ...(ctx.approvalRequestId
        ? { metadata: { [TAINT_DISCLOSURE_APPROVAL_KEY]: ctx.approvalRequestId } }
        : {}),
      ...(approved.externalClient !== null ? { externalClient: approved.externalClient } : {}),
    }
  }
  const decision = await decidePostDisclosure({
    orgId: ctx.orgId,
    requesterUserId: ctx.userId,
    stamp,
    target,
  })
  if (decision.kind === "clear") return { disclosureList: null }
  if (decision.kind === "disclose") return { disclosureList: decision.disclosureList }
  if (decision.kind === "requester_lacks") {
    return {
      error: {
        code: POST_WOULD_BE_HIDDEN_CODE,
        message: SCOPE_TAINT_BLOCKED_MESSAGE(
          SINK_KERNEL_MESSAGES,
          stamp,
          "poster",
          undefined,
          decision,
        ),
      },
    }
  }
  rootLogger
    .child({ module: "chat-tools" })
    .warn(
      { orgId: ctx.orgId, lacking: decision.lacking },
      "agent post refused: it would be written hidden from people in the conversation",
    )
  return { error: postWouldBeHiddenError(decision) }
}

/**
 * Resolve the attributed author label for an agent thread post. A named agent
 * → its display name; a personal agent → "{Owner}'s agent"; a routine
 * execution thread → "Routine {name}"; anything else → "{User}'s agent".
 * Agent posts are always attributed, never impersonated as the human.
 */
export async function resolveAgentAuthorLabel(ctx: ChatToolContext): Promise<string> {
  // THE SPEAKER IS THE AGENT, NOT THE HUMAN WHOSE TURN IT IS. Falling through
  // to "{User}'s agent" for a named agent put "App Review's agent" on a Finance
  // Desk post. A personal agent's stored name is the generic "Personal agent",
  // so it signs as its owner's (`agentSpeakerName`), after a routine run's own
  // attribution.
  const actingAgentId = captureActingAgentId()
  let personal: { name: string; kind: string; ownerName: string | null } | null = null
  if (actingAgentId) {
    const [a] = await withPrivilegedDb(ctx.orgId, "resolve-agent-author-label", (tx) =>
      tx
        .select({ name: agents.displayName, kind: agents.kind, ownerName: users.name })
        .from(agents)
        .leftJoin(users, eq(users.id, agents.ownerUserId))
        .where(and(eq(agents.id, actingAgentId), eq(agents.orgId, ctx.orgId)))
        .limit(1),
    )
    if (a && a.kind !== "personal" && a.name) return a.name
    personal = a?.kind === "personal" ? a : null
  }
  if (ctx.agentExecutionThreadId) {
    // `routines` is privileged-access only — its RLS blocks the regular agent
    // context — so resolve the routine via a privileged lookup, not `ctx.db`.
    const execThreadId = ctx.agentExecutionThreadId
    const [routine] = await withPrivilegedDb(ctx.orgId, "resolve-agent-author-label", (tx) =>
      tx
        .select({ name: routines.name, title: routines.title })
        .from(routines)
        .where(eq(routines.outputThreadId, execThreadId))
        .limit(1),
    )
    if (routine) return `Routine ${routineDisplayName(routine)}`
  }
  const personalLabel = personal
    ? agentSpeakerName({
        displayName: personal.name,
        kind: personal.kind,
        ownerName: personal.ownerName,
      })
    : null
  if (personalLabel) return personalLabel
  const [u] = await ctx.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, ctx.userId))
    .limit(1)
  return `${u?.name ?? "User"}'s agent`
}

interface ThreadReferenceInput {
  app: string
  entityType: string
  entityId: string
}

function likePattern(q: string): string {
  return `%${q.replace(/[%_\\]/g, "\\$&")}%`
}

export async function handleThreadsList(
  params: { limit?: number; archived?: boolean; unreadOnly?: boolean },
  ctx: ChatToolContext,
): Promise<{ threads: Array<any>; hasMore: boolean; cursor: string | null }> {
  const { limit = 10, archived, unreadOnly } = params
  const capLimit = Math.min(limit, 50)

  return listThreads(ctx.db, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    limit: capLimit,
    archived,
    unreadOnly,
  })
}

/**
 * The content pass of thread search: messages matching `query` in threads the
 * caller is a participant of, best first.
 *
 * The CANDIDATES come from the search index (`resolveThreadMessageMatches`),
 * which replaces an `ILIKE '%q%'` over every message of the org. The ROWS come
 * from the caller's own RLS transaction, with the same membership join, type
 * and deletion predicates the ILIKE query had, restricted to those ids: the
 * messages SELECT policy (scopes, disclosure) and the participant join decide
 * what is returned, exactly as before, and the index only proposes. A stale
 * document can cost a hit, never leak one.
 *
 * When the index cannot answer, the ILIKE runs as before but BOUNDED: over the
 * caller's own threads and the last CONTENT_FALLBACK_DAYS, which the
 * (thread_id, created_at) index serves without scanning the table.
 */
const CONTENT_FALLBACK_DAYS = 90

async function searchMessageContent(
  query: string,
  pattern: string,
  limit: number,
  ctx: ChatToolContext,
): Promise<
  Array<{
    threadId: string
    threadHandle: string
    threadTitle: string | null
    threadUpdatedAt: Date
    messageId: string
    messageContent: string
    authorName: string
    messageCreatedAt: Date
  }>
> {
  const myThreads = await ctx.db
    .select({ id: threads.id })
    .from(threads)
    .innerJoin(
      threadParticipants,
      and(eq(threadParticipants.threadId, threads.id), eq(threadParticipants.userId, ctx.userId)),
    )
    .where(and(eq(threads.orgId, ctx.orgId), eq(threads.type, "thread")))
  const threadIds = myThreads.map((t) => t.id)
  if (threadIds.length === 0) return []

  let candidateIds: string[] | null = null
  try {
    const { resolveThreadMessageMatches } = await import("~/modules/search/service")
    candidateIds = await resolveThreadMessageMatches({
      orgId: ctx.orgId,
      userId: ctx.userId,
      scopes: ctx.scopes ?? [],
      q: query,
      threadIds,
      limit,
    })
  } catch (err) {
    rootLogger.warn(
      { err, orgId: ctx.orgId },
      "threads_search: index unavailable, bounded ILIKE fallback",
    )
  }
  if (candidateIds !== null && candidateIds.length === 0) return []

  const base = ctx.db
    .select({
      threadId: messages.threadId,
      threadHandle: threads.handle,
      threadTitle: threads.title,
      threadUpdatedAt: threads.updatedAt,
      messageId: messages.id,
      messageContent: messages.content,
      authorName: users.name,
      messageCreatedAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(
      threadParticipants,
      and(eq(threadParticipants.threadId, threads.id), eq(threadParticipants.userId, ctx.userId)),
    )
    .innerJoin(users, eq(users.id, messages.authorId))
  const common = [
    eq(messages.orgId, ctx.orgId),
    eq(threads.type, "thread"),
    isNull(messages.deletedAt),
  ]

  if (candidateIds !== null) {
    const rows = await base.where(and(...common, inArray(messages.id, candidateIds)))
    // The index's rank order; ids RLS withheld are simply absent.
    const rank = new Map(candidateIds.map((id, i) => [id, i]))
    return rows.sort((a, b) => (rank.get(a.messageId) ?? 0) - (rank.get(b.messageId) ?? 0))
  }
  return await base
    .where(
      and(
        ...common,
        inArray(messages.threadId, threadIds),
        gt(messages.createdAt, drizzleSql`now() - make_interval(days => ${CONTENT_FALLBACK_DAYS})`),
        ilike(messages.content, pattern),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit)
}

export async function handleThreadsSearch(
  params: { query: string; limit?: number },
  ctx: ChatToolContext,
): Promise<{ threads: Array<any> }> {
  const { query, limit = 10 } = params
  const pattern = likePattern(query)
  const capLimit = Math.min(limit, 20)

  // Pass 1: threads with matching title, filtered to threads the user participates in
  const titleResults = await ctx.db
    .select({
      id: threads.id,
      handle: threads.handle,
      title: threads.title,
      updatedAt: threads.updatedAt,
    })
    .from(threads)
    .innerJoin(
      threadParticipants,
      and(eq(threadParticipants.threadId, threads.id), eq(threadParticipants.userId, ctx.userId)),
    )
    .where(
      and(eq(threads.orgId, ctx.orgId), eq(threads.type, "thread"), ilike(threads.title, pattern)),
    )
    .orderBy(desc(threads.updatedAt))
    .limit(capLimit)

  const foundIds = new Set(titleResults.map((r) => r.id))

  const remainingAfterTitle = capLimit - titleResults.length
  const participantMatches: Array<any> = []

  if (remainingAfterTitle > 0) {
    const k = drizzleSql.raw(schemaRef("kernel"))
    const participantResult = await ctx.db.execute(drizzleSql`
      SELECT t.id, t.handle, t.title, t.updated_at, u.name AS participant_name
      FROM ${k}.threads t
      JOIN ${k}.thread_participants self_tp ON self_tp.thread_id = t.id AND self_tp.user_id = ${ctx.userId}
      JOIN ${k}.thread_participants matched_tp ON matched_tp.thread_id = t.id
      JOIN ${k}.users u ON u.id = matched_tp.user_id
      WHERE t.org_id = ${ctx.orgId}
        AND t.type = 'thread'
        AND u.name ILIKE ${pattern}
      ORDER BY t.updated_at DESC
      LIMIT ${remainingAfterTitle * 3}
    `)
    const participantResults = extractRows<any>(participantResult)

    for (const row of participantResults) {
      if (foundIds.has(row.id)) continue
      foundIds.add(row.id)
      participantMatches.push({
        id: row.id,
        handle: row.handle,
        title: row.title,
        updatedAt: row.updated_at,
        matchContext: {
          participantName: row.participant_name,
        },
      })
      if (participantMatches.length >= remainingAfterTitle) break
    }
  }

  // Pass 3: message content search, only for threads not already found.
  const remaining = capLimit - titleResults.length - participantMatches.length
  const messageMatches: Array<any> = []

  if (remaining > 0) {
    const msgResults = await searchMessageContent(query, pattern, remaining * 3, ctx)
    const seen = new Set<string>()
    for (const r of msgResults) {
      if (foundIds.has(r.threadId) || seen.has(r.threadId)) continue
      seen.add(r.threadId)
      messageMatches.push({
        id: r.threadId,
        handle: r.threadHandle,
        title: r.threadTitle,
        updatedAt: r.threadUpdatedAt,
        matchContext: {
          messageId: r.messageId,
          snippet: r.messageContent.slice(0, 200),
          authorName: r.authorName,
          createdAt: r.messageCreatedAt,
        },
      })
      if (messageMatches.length >= remaining) break
    }
  }

  return {
    threads: [
      ...titleResults.map((r) => ({
        id: r.id,
        handle: r.handle,
        title: r.title,
        updatedAt: r.updatedAt,
      })),
      ...participantMatches,
      ...messageMatches,
    ].slice(0, capLimit),
  }
}

type TitleTaintRefusal = {
  code: "E_SCOPE_TAINT_BLOCKED"
  message: string
  retryable: false
  writeTargetTable: string
  reason: "scope_taint_blocked"
}

/** The turn's taint as seen by this handler: what the dispatch forwarded, else the live frame
 *  (a frame without an accumulator is an unknowable taint), else no turn at all. */
export function handlerTurnTaint(ctx: { turnTaintScopes?: readonly string[] }): readonly string[] {
  if (ctx.turnTaintScopes !== undefined) return ctx.turnTaintScopes
  const frame = currentRunContext()
  if (!frame) return []
  if (!frame.turnScopeAccumulator) return UNKNOWN_TURN_TAINT
  return currentToolCallScopesBefore() ?? frame.turnScopeAccumulator.snapshot()
}

/**
 * Null when the new thread's title and references may be written, else the refusal. Both are
 * read by every participant (the title on the thread row; the references in
 * kernel.thread_references, loaded into each participant's agent context), so the audience is
 * the requester plus every participant (`kernel.users`), whatever their account status, and each
 * must hold EVERY scope the turn read (`holdsEveryScope`, the check the approval audience uses).
 * An id that resolves to no account of the org fails closed, and the unknown sentinel is held
 * by nobody, so it refuses.
 */
async function participantTaintRefusal(
  ctx: ChatToolContext,
  participantIds: readonly string[],
): Promise<TitleTaintRefusal | null> {
  const turnTaint = handlerTurnTaint(ctx)
  if (turnTaint.length === 0) return null
  const audienceIds = [...new Set([ctx.userId, ...participantIds])]
  let held = false
  // Who lacks what, counted for the refusal (never named). An unresolved id counts as lacking.
  let gap: { missingScopes: string[]; lacking: number | null } = {
    missingScopes: [],
    lacking: null,
  }
  if (!turnTaint.some((s) => UNKNOWN_TURN_TAINT.includes(s))) {
    try {
      const members = await loadOrgMemberGrants(ctx.orgId, { userIds: audienceIds })
      held =
        members.length === audienceIds.length &&
        members.every((m) => holdsEveryScope(m.scopes, turnTaint))
      const missing = new Set<string>()
      let lacking = audienceIds.length - members.length
      for (const m of members) {
        const lacks = turnTaint.filter((scope) => !holdsEveryScope(m.scopes, [scope]))
        if (lacks.length === 0) continue
        lacking += 1
        for (const scope of lacks) missing.add(scope)
      }
      gap = { missingScopes: [...missing].sort(), lacking }
    } catch {
      held = false
    }
  }
  if (held) return null
  rootLogger
    .child({ module: "chat-tools" })
    .warn(
      { orgId: ctx.orgId, participants: audienceIds.length },
      "threads_create title or references refused by scope taint",
    )
  const { message, code, writeTargetTable, reason } = toScopeTaintBlockedError(
    SINK_KERNEL_THREADS,
    turnTaint,
    "participants",
    gap,
  )
  return { code, message, retryable: false, writeTargetTable, reason }
}

type CreatedFromInput = { app: string; entityType: string; entityId: string }

/** threads_create naming the entity a conversation is about (`createdFrom`). */
async function createFromEntity(
  params: {
    participantIds: string[]
    title?: string
    initialMessage?: string
    references?: ThreadReferenceInput[]
    forceCreate?: boolean
    createdFrom: CreatedFromInput
  },
  ctx: ChatToolContext,
): Promise<
  | { thread: any }
  | { threadId: string; created: boolean; [k: string]: unknown }
  | { error: string }
  | { error: { code: string; message: string } }
  | { error: TitleTaintRefusal }
  | null
> {
  const ref = params.createdFrom
  const label = `${ref.app}:${ref.entityType} ${ref.entityId}`
  const notVisible = {
    error: {
      code: "created_from_not_visible",
      message: `${label} does not exist or is not visible to you: nothing was created or posted. Pass an id you saw in a result.`,
    },
  }
  if (!isDiscussionEntity(ctx.orgId, ref)) {
    // Not a discussion: a new thread that belongs to the entity, as the REST route makes.
    if (!(await canReadThreadAnchorEntity(ctx.db, ctx.orgId, ref))) return notVisible
    return null
  }
  const opened = await openEntityDiscussion(ctx.db, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    ref,
  })
  if (!opened) return notVisible
  const { enrolled, dropped } = await enrolInEntityDiscussion({
    orgId: ctx.orgId,
    threadId: opened.threadId,
    ref,
    userIds: params.participantIds.filter((id) => id !== ctx.userId),
  })
  const droppedLine =
    dropped.length > 0 ? ` Not added, since they cannot see ${label}: ${dropped.join(", ")}.` : ""
  if (!params.initialMessage) {
    return {
      threadId: opened.threadId,
      created: opened.created,
      ...(enrolled.length > 0 ? { added: enrolled } : {}),
      ...(dropped.length > 0 ? { notAdded: dropped } : {}),
      result: `${opened.created ? "Opened" : "Found"} the discussion of ${label} (thread ${opened.threadId}); nothing was posted.${droppedLine} Post into it with kernel__threads_reply and this threadId.`,
    }
  }
  const posted = await postThreadReply(
    { threadId: opened.threadId, content: params.initialMessage },
    ctx,
  )
  if (!("message" in posted)) return posted
  return {
    threadId: opened.threadId,
    created: opened.created,
    message: posted.message,
    ...(enrolled.length > 0 ? { added: enrolled } : {}),
    ...(dropped.length > 0 ? { notAdded: dropped } : {}),
    result: `Posted into the discussion of ${label} (thread ${opened.threadId}${opened.created ? ", opened now" : ""}), attributed to you as the agent; everyone who can see it reads it.${droppedLine}`,
  }
}

export async function handleThreadsCreate(
  params: {
    participantIds?: string[]
    title?: string
    initialMessage?: string
    references?: ThreadReferenceInput[]
    forceCreate?: boolean
    createdFrom?: CreatedFromInput
  },
  ctx: ChatToolContext,
): Promise<
  | { thread: any }
  | { threadId: string; created: boolean; [k: string]: unknown }
  | { error: string }
  | { error: { code: string; message: string } }
  | { error: TitleTaintRefusal }
> {
  const participantIds = params.participantIds ?? []
  if (params.createdFrom) {
    const fromEntity = await createFromEntity(
      { ...params, participantIds, createdFrom: params.createdFrom },
      ctx,
    )
    if (fromEntity) return fromEntity
  }
  // THE INITIAL MESSAGE is a kernel.messages row, the enforcing sink the tool
  // declares: stamped with the turn's scopes exactly like threads_reply, and
  // hidden from any reader lacking them.
  const initialScopes = params.initialMessage ? agentPostRequiredScopes(ctx) : []
  if (initialScopes === null) return { error: SCOPE_UNKNOWN_ERROR }
  // THE TITLE AND THE REFERENCES are the parts of the write the message sink does
  // not cover: free text on the thread row and in kernel.thread_references, read by
  // every participant. On a tainted turn they are judged against that real audience,
  // the requester plus the participants, and refused when one of them lacks a scope
  // the turn read. The participant list itself is the thread's membership, not data.
  // An approved disclosure (rule 11) was decided by the requester for exactly these people.
  const snapshot = await approvedPostDisclosure(ctx)
  // A titled or forced create writes into a thread of its own: no DM by dedupe, no standing
  // disclosure of another thread applies to it (rule 14).
  const target = {
    participantIds: participantIds,
    newThread: !!params.title || params.forceCreate === true,
  }
  const audience = async () => [...new Set([ctx.userId, ...participantIds])]
  // The title and references are unstamped and read by every later member: only an approval
  // discloses them, never the direct-message or standing shortcut of the message body.
  if (snapshot === null && (params.title || (params.references?.length ?? 0) > 0)) {
    const refusal = await participantTaintRefusal(ctx, participantIds)
    if (refusal) return { error: refusal }
  }
  // Never written hidden (rule 14): the first message reaches every participant it addresses.
  const visibility = params.initialMessage
    ? await resolvePostVisibility(ctx, initialScopes, target, audience)
    : ({ disclosureList: null } as const)
  if ("error" in visibility) return { error: visibility.error }
  const agentAuthorLabel = await resolveAgentAuthorLabel(ctx)
  const result = await createThread(ctx.db, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    participantIds,
    title: params.title,
    forceCreate: params.forceCreate,
    initialMessage: params.initialMessage
      ? {
          content: params.initialMessage,
          authorType: "agent",
          agentAuthorLabel,
          requiredScopes: initialScopes,
          ...(visibility.disclosureList ? { disclosureList: visibility.disclosureList } : {}),
          ...("metadata" in visibility && visibility.metadata
            ? { metadata: visibility.metadata }
            : {}),
        }
      : undefined,
    references: params.references,
    ...(params.createdFrom ? { createdFrom: params.createdFrom } : {}),
  })

  return {
    thread: {
      id: result.id,
      handle: result.handle,
      title: result.title,
      participants: (result as any).participants,
      deduplicated: result.deduplicated,
    },
  }
}

/** threads_read of the conversation the turn is answering (its `taintFreeWhen`). */
export function readsAnsweringThread(
  params: unknown,
  ctx: { executionThreadId?: string },
): boolean {
  const threadId = (params as { threadId?: unknown } | null)?.threadId
  return (
    typeof ctx.executionThreadId === "string" &&
    ctx.executionThreadId !== "" &&
    threadId === ctx.executionThreadId
  )
}

export async function handleThreadsRead(
  params: { threadId: string; limit?: number; replyRootId?: string },
  ctx: ChatToolContext,
): Promise<{ thread: any; messages: any[] } | { error: { code: string; message: string } }> {
  const { threadId, limit = 50, replyRootId } = params
  const capLimit = Math.min(limit, 100)

  // Verify participation via RLS join
  const [threadRow] = await ctx.db
    .select({
      id: threads.id,
      handle: threads.handle,
      title: threads.title,
      type: threads.type,
    })
    .from(threads)
    .innerJoin(
      threadParticipants,
      and(eq(threadParticipants.threadId, threads.id), eq(threadParticipants.userId, ctx.userId)),
    )
    .where(and(eq(threads.id, threadId), eq(threads.orgId, ctx.orgId)))

  // Approval-discussion threads carry internal decision context the agent must
  // never surface, even though the executing user is a participant (RLS permits
  // the read, so the guard lives here). Return the same not-found shape used for
  // an inaccessible thread so existence isn't leaked.
  if (!threadRow || threadRow.type === "approval") {
    return { error: { code: "not_found", message: "Thread not found or not a participant" } }
  }

  // A18: WHICH VIEW. A reply thread is its root plus its replies; the root
  // must be a message of this thread the caller can read, and not a reply.
  // Without a root, the channel view: a reply appears only when it was also
  // sent to the channel.
  if (replyRootId) {
    const [rootRow] = await ctx.db
      .select({ replyRootId: messages.replyRootId })
      .from(messages)
      .where(
        and(
          eq(messages.id, replyRootId),
          eq(messages.threadId, threadId),
          eq(messages.orgId, ctx.orgId),
        ),
      )
      .limit(1)
    if (!rootRow || rootRow.replyRootId) {
      return {
        error: {
          code: "invalid_params",
          message: "replyRootId is not the root of a reply thread in this thread",
        },
      }
    }
  }
  const viewClause = replyRootId
    ? or(eq(messages.id, replyRootId), eq(messages.replyRootId, replyRootId))
    : or(isNull(messages.replyRootId), eq(messages.alsoInChannel, true))

  // Fetch most recent N messages, then reverse to chronological order
  const recentMessages = await ctx.db
    .select({
      id: messages.id,
      content: messages.content,
      authorName: users.name,
      authorType: messages.authorType,
      replyRootId: messages.replyRootId,
      createdAt: messages.createdAt,
      requiredScopes: messages.requiredScopes,
      // How many replies a channel message has, so the agent knows there is a
      // reply thread to read under it.
      replyCount: drizzleSql<number>`(
        SELECT COUNT(*)::int FROM ${messages} r
        WHERE r.reply_root_id = ${messages.id} AND r.thread_id = ${messages.threadId}
          AND r.deleted_at IS NULL AND r.author_type IN ('user', 'agent')
      )`,
    })
    .from(messages)
    .innerJoin(users, eq(users.id, messages.authorId))
    .where(
      and(
        eq(messages.threadId, threadId),
        eq(messages.orgId, ctx.orgId),
        isNull(messages.deletedAt),
        viewClause,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(capLimit)

  recentMessages.reverse()

  // The conversation the turn is answering records no blanket thread-read scope (its
  // `taintFreeWhen`), so what it returns taints the turn by each message's own stamp, exactly as
  // the same messages do when they are injected as history.
  if (readsAnsweringThread(params, { executionThreadId: ctx.agentExecutionThreadId })) {
    const accumulator = currentRunContext()?.turnScopeAccumulator
    for (const m of recentMessages) accumulator?.recordInjected(m.requiredScopes ?? [])
  }

  return {
    thread: {
      id: threadRow.id,
      handle: threadRow.handle,
      title: threadRow.title,
    },
    messages: recentMessages.map((m) => ({
      id: m.id,
      authorName: m.authorName,
      authorType: m.authorType,
      content: m.content.length > 2000 ? `${m.content.slice(0, 2000)}...` : m.content,
      createdAt: m.createdAt,
      ...(m.replyRootId ? { replyRootId: m.replyRootId } : {}),
      ...(Number(m.replyCount) > 0 ? { replyCount: Number(m.replyCount) } : {}),
    })),
  }
}

/** threads_reply's refusal to post into the thread the turn is answering. */
export const ANSWERING_THREAD_CODE = "answering_thread"

type ThreadsReplyResult =
  | { message: any; postedTo?: string }
  | { error: string }
  | { error: { code: string; message: string } }

/**
 * threads_reply: post into a thread, or into a Liaison contact's discussion
 * (`contactId`). The discussion is resolved under the caller's RLS: a contact
 * they cannot see is "not found" and nothing is created; one they see opens
 * its thread (created on first use) with them enrolled, exactly as opening
 * the contact page does (modules/contacts/discussion.ts). An agent's post
 * there is attributed to the agent and needs no approval, like any post.
 */
export async function handleThreadsReply(
  params: {
    threadId?: string
    contactId?: string
    content: string
    attachments?: string[]
    replyRootId?: string
  },
  ctx: ChatToolContext,
): Promise<ThreadsReplyResult> {
  if (!!params.threadId === !!params.contactId) {
    return {
      error: {
        code: "INVALID_ARGUMENT",
        message:
          "Give threadId (a thread) or contactId (a contact's discussion), exactly one of them.",
      },
    }
  }
  let threadId = params.threadId
  if (!threadId && params.contactId) {
    const opened = await openContactDiscussion(ctx.db, {
      orgId: ctx.orgId,
      contactId: params.contactId,
      userId: ctx.userId,
    })
    if (!opened) {
      return {
        error: {
          code: "NOT_FOUND",
          message: `Contact not found: ${params.contactId}. Only pass an id you actually saw in a kernel__contacts_search or kernel__contacts_read result.`,
        },
      }
    }
    threadId = opened.threadId
  }
  const posted = await postThreadReply(
    { ...params, threadId: threadId as string, contactDiscussion: !!params.contactId },
    ctx,
  )
  // Where it went, in the result the agent reports from: a post here is not a
  // write to the org's CRM, and with one connected the two read alike.
  return params.contactId && "message" in posted
    ? {
        ...posted,
        postedTo: `The discussion of contact ${params.contactId}, in Liaison only: not in any connected system.`,
      }
    : posted
}

async function postThreadReply(
  params: {
    threadId: string
    content: string
    attachments?: string[]
    replyRootId?: string
    /** Posted into a contact's discussion (contactId), whose readers are the contact's. */
    contactDiscussion?: boolean
  },
  ctx: ChatToolContext,
): Promise<ThreadsReplyResult> {
  // ONE REPLY ROW PER TURN. The turn's OWN answer is already persisted by the
  // runtime when the turn finishes, so an agent that also calls threads_reply
  // on the thread it is answering writes the same answer twice: an early row
  // with no timeline and no tool calls, then the real one a second later. The
  // model is told what to do instead rather than silently deduplicated, so it
  // does not retry.
  // The same rule inside a reply thread: the turn's own answer lands in the
  // reply thread it answers (A7), so posting there again is the duplicate; a
  // post into ANOTHER place of the same room (the channel, another reply
  // thread) is a different message.
  const answeringRoot = currentRunContext()?.replyRoot?.rootMessageId ?? null
  if (
    ctx.agentExecutionThreadId &&
    params.threadId === ctx.agentExecutionThreadId &&
    (params.replyRootId ?? null) === answeringRoot
  ) {
    // A typed refusal (400 `answering_thread`, execute-tool.ts statusForToolError):
    // the caller asked for the wrong thread, which is not a server fault.
    return {
      error: {
        code: ANSWERING_THREAD_CODE,
        message:
          "This is the conversation you are answering: your reply is posted when this turn ends, so posting it with kernel__threads_reply as well would show it twice. Just answer. Use kernel__threads_reply for OTHER threads.",
      },
    }
  }
  const requiredScopes = agentPostRequiredScopes(ctx)
  if (requiredScopes === null) return { error: SCOPE_UNKNOWN_ERROR }
  // Rule 11b: the people the post would have reached when it parked, still in the thread now.
  // Without an approval, never written hidden (rule 14). A contact discussion is read by the
  // contact's readers, not judged here (rule 11c).
  const visibility = params.contactDiscussion
    ? ({ disclosureList: null } as PostVisibility)
    : await resolvePostVisibility(ctx, requiredScopes, { threadId: params.threadId }, () =>
        threadPeopleIds(ctx.orgId, params.threadId),
      )
  if ("error" in visibility) return { error: visibility.error }
  const disclosedTo = visibility.disclosureList
  // A person's external client: live, or, on an approved re-entry (whose frame is the
  // approval's), as the dispatch recorded it on the approval when the post parked. Then the
  // connection's own scopes and the requester's own dimension grants, never the re-entry's (the
  // requester's widened by the decider's).
  const client: ExternalClientPoster | null = isHumanActor(ctx)
    ? { scopes: ctx.scopes ?? [], dimensionGrants: ctx.dimensionGrants ?? {} }
    : "externalClient" in visibility
      ? (visibility.externalClient ?? null)
      : null
  const human = client !== null
  const agentAuthorLabel = await resolveAgentAuthorLabel(ctx)
  // A18: a reply-thread post names a live root of this thread that is not a
  // reply; anything else is refused here rather than posted to the channel.
  if (params.replyRootId) {
    const [rootRow] = await ctx.db
      .select({ replyRootId: messages.replyRootId, deletedAt: messages.deletedAt })
      .from(messages)
      .where(
        and(
          eq(messages.id, params.replyRootId),
          eq(messages.threadId, params.threadId),
          eq(messages.orgId, ctx.orgId),
        ),
      )
      .limit(1)
    if (!rootRow || rootRow.replyRootId || rootRow.deletedAt) {
      return { error: "replyRootId is not the live root of a reply thread in this thread" }
    }
  }
  const result = await sendMessage(ctx.db, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    threadId: params.threadId,
    content: params.content,
    // NEVER AUTHORED AS THE PERSON. An external client is a model acting for
    // them; storing its words as a `user` row showed them as the person's own.
    authorType: "agent" as const,
    agentAuthorLabel,
    ...(human || visibility.metadata
      ? {
          metadata: {
            ...(human ? { [EXTERNAL_CLIENT_POST_KEY]: true } : {}),
            ...visibility.metadata,
          },
        }
      : {}),
    requiredScopes,
    // Rule 11: an approved disclosure is read by the thread's people, whatever they hold.
    ...(disclosedTo ? { disclosureList: disclosedTo } : {}),
    replyRootId: params.replyRootId ?? null,
  })

  if (!result) {
    // Common weak-model misdirection: passing an APP entity's id (a ticket, a
    // mail conversation) as threadId. threads_reply only posts to kernel chat
    // threads the agent participates in — the owning app's reply tool is the
    // right surface, so point there instead of leaving a dead-end error.
    return {
      error:
        "Not a participant of this thread (or the id is not a chat thread). If you are replying to an app entity such as a ticket or an email conversation, use that app's own reply tool (e.g. tickets__reply, mail__reply) — find it with kernel__tool_search.",
    }
  }

  // Attach any agent-supplied files onto the just-posted message. The reply
  // tool is gated by `kernel:threads:write`, so the actor holds it here. A
  // failure here is reported WITH the posted message, never as `{ error }`:
  // the message is committed, and an error result would let an approved call
  // be re-pended and post it a second time.
  let attachmentError: string | undefined
  if (params.attachments?.length) {
    try {
      await attachFilesToParent(
        {
          sourceFileIds: params.attachments,
          target: { app: "kernel", entityType: "message", entityId: result.id },
        },
        {
          rlsTx: ctx.db,
          privileged: (reason, fn) => withPrivilegedDb(ctx.orgId, reason, fn),
          orgId: ctx.orgId,
          userId: ctx.userId,
          actorType: "agent",
          scopes: ["kernel:threads:write"],
        },
      )
      // The create event went out before the files were attached, so this
      // update is how everyone already in the thread sees them without a reload.
      await publishMessageAttachments(ctx.db, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        threadId: params.threadId,
        messageId: result.id,
      })
    } catch (err) {
      const reason = err instanceof FileServiceError ? err.message : "could not attach files"
      attachmentError = `The message is posted, but its files could not be attached: ${reason}. Do not post it again.`
    }
  }

  // The dispatch the SAME post through the thread route triggers: live
  // mentioned agents, and in a 1:1 agent chat with no mention the agent seated
  // there. An agent's own post keeps starting nothing, which is why agents_ask
  // exists rather than "just reply with a mention".
  if (client !== null) {
    try {
      await dispatchForPostedMessage(
        (fn) =>
          withRlsContext(
            {
              actorType: "user",
              userId: ctx.userId,
              orgId: ctx.orgId,
              scopes: client.scopes,
              dimensionGrants: client.dimensionGrants,
            },
            fn,
          ),
        {
          orgId: ctx.orgId,
          threadId: params.threadId,
          // The person drives this dispatch through their client: no in-app
          // agent is the caller, whichever agent the row's author id names.
          // A4, as agents_ask: the woken agent runs at its own ceiling
          // intersected with this connection's scope, never wider. The guard
          // only narrows a nested dispatch, so the turn hangs under this post,
          // exactly as an asked agent's turn hangs under its question.
          message: {
            ...result,
            authorAgentId: null,
            parentMessageId: result.parentMessageId ?? result.id,
          },
          callerEffectiveScope: client.scopes,
          actor: {
            userId: ctx.userId,
            orgId: ctx.orgId,
            scopes: client.scopes,
            dimensionGrants: client.dimensionGrants,
          },
        },
      )
    } catch (err) {
      // The message is posted. A dispatch that could not start is logged, never
      // turned into a failed post the caller would retry (and double-post).
      rootLogger
        .child({ module: "chat-tools" })
        .error({ err, threadId: params.threadId }, "Dispatching a posted reply failed")
    }
  }

  return {
    message: {
      id: result.id,
      threadId: result.threadId,
      replyRootId: result.replyRootId,
      content: result.content,
      createdAt: result.createdAt,
    },
    ...(attachmentError ? { attachmentError } : {}),
  }
}
