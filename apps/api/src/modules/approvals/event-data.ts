// SPDX-License-Identifier: FSL-1.1-ALv2
import type {
  ApprovalEditableField,
  ApprovalLastEdit,
  ApprovalLastFailure,
  ApprovalRequester,
  ApprovalRequestStatus,
  ApprovalRequestSummary,
  ApprovalSummary,
} from "@liaison/shared"
import { SHARED_SURFACE_APPROVAL_TOOLS as SHARED_SURFACE_TOOLS } from "@liaison/shared"
import { sql as drizzleSql, eq, type SQL } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { TICKET_MERGED_REASON } from "~/modules/approvals/cancel"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { readApprovalRequester } from "~/modules/approvals/requester"
import { humanizeToolName, splitToolName } from "~/modules/approvals/tool-name"
import { approvalEditableFieldsRegistry } from "~/modules/apps/app-registries"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"

export { humanizeToolName, splitToolName }

const K = drizzleSql.raw(schemaRef("kernel"))

/**
 * FX4: the SET fragment that folds a RESTAGING turn's scopes into the scopes
 * already recorded on an approval row (`proposing_turn_scopes`, migration 0067).
 *
 * A restage replaces the payload with a later turn's, and that turn may have
 * read more than the one that first staged it, so the recorded set is UNIONED
 * and never replaced: a restage can only narrow the eventual row's visibility.
 * Unknown on either side goes back to NULL, the fail-closed branch the approved
 * re-entry reads as "nothing was recorded".
 *
 * Bound as ONE jsonb parameter rather than as `text[]`: a JS array interpolated
 * into a drizzle template is spread into a parameter LIST, so the scopes never
 * arrive as an array and an empty one renders as a literal `()` -- invalid SQL
 * that failed the whole restage.
 */
export function proposingTurnScopesUnionSql(scopes: string[] | null): SQL {
  const json = scopes === null ? null : JSON.stringify(scopes)
  return drizzleSql`proposing_turn_scopes = CASE
      WHEN proposing_turn_scopes IS NULL OR ${json}::jsonb IS NULL THEN NULL
      ELSE ARRAY(
        SELECT DISTINCT s FROM (
          SELECT unnest(proposing_turn_scopes) AS s
          UNION SELECT jsonb_array_elements_text(${json}::jsonb) AS s
        ) u ORDER BY s
      )
    END`
}

export type {
  ApprovalEditableField,
  ApprovalLastEdit,
  ApprovalRequestStatus,
  ApprovalRequestSummary,
}

export interface BuildApprovalSummaryRaw {
  id: string
  handle: string
  status: ApprovalRequestStatus
  created_at: Date | string
  expires_at: Date | string
  tool_name: string
  /** Persisted decision scope (null = derived `<app>:approve`). REQUIRED so
   *  the compiler flags any SELECT/raw literal that fails to supply it — the
   *  DTO must always carry the row's real deciding scope. */
  approve_scope: string | null
  summary: ApprovalSummary
  current_payload: Record<string, unknown>
  thread_id: string
  originating_thread_id: string
  requested_by: string
  notify_user_ids: string[]
  decided_by?: string | null
  decided_at?: Date | string | null
  reason?: string | null
  bundle_id?: string | null
  bundle_position?: number | null
  depends_on_id?: string | null
  resource_owner_id?: string | null
  /** A11: the agent whose turn PROPOSED this gated call, persisted on the row
   *  beside the human `requested_by`. Absent on a request a human staged. */
  agent_id?: string | null
  metadata?: Record<string, unknown> | null
}

/**
 * The reason a row shows. Rows a ticket merge cancelled before the reason became a sentence carry
 * the code `ticket_merged`: they read as the sentence a merge stores today.
 */
function readableReason(reason: string): string {
  return reason === "ticket_merged" ? TICKET_MERGED_REASON : reason
}

/** Canonical mapper from a raw approval-request row to the public `ApprovalRequestSummary`.
 *  Used by create event, update events (decide / revert / expiry / reaper / edit), and the
 *  GET list/detail responses. */
export function buildApprovalSummary(input: {
  raw: BuildApprovalSummaryRaw
  /** Who asked, from `readApprovalRequester(s)`: the only name the card shows. */
  requester: ApprovalRequester
  /** Decider display name, when the row is decided and the name is at hand. */
  decidedByName?: string | null
  editableFields: ApprovalEditableField[]
  lastEdit: ApprovalLastEdit | null
  /** Most recent post-approval execution failure (null when never failed).
   *  Carried on both the list/get payload and the revert-to-pending WS event so
   *  the card renders it inline — the single surface for "why did nothing
   *  happen" (no separate attention translation, no event-data duplication). */
  lastFailure?: ApprovalLastFailure | null
}): ApprovalRequestSummary {
  const r = input.raw
  return {
    id: r.id,
    handle: r.handle,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString(),
    toolName: r.tool_name,
    approveScope: r.approve_scope,
    summary: r.summary,
    editableFields: input.editableFields,
    currentPayload: r.current_payload,
    payloadHash: approvalPayloadHash(r.tool_name, r.current_payload),
    threadId: r.thread_id,
    originatingThreadId: r.originating_thread_id,
    requestedBy: { id: r.requested_by },
    requester: input.requester,
    notifyUserIds: r.notify_user_ids,
    ...(r.decided_by ? { decidedBy: r.decided_by } : {}),
    ...(r.decided_by && input.decidedByName ? { decidedByName: input.decidedByName } : {}),
    ...(r.decided_at ? { decidedAt: new Date(r.decided_at).toISOString() } : {}),
    ...((r.status === "denied" || r.status === "cancelled") && r.reason
      ? { reason: readableReason(r.reason) }
      : {}),
    ...(r.reason === "taint_escalation" ? { heldForOutsideText: true as const } : {}),
    bundleId: r.bundle_id ?? null,
    bundlePosition: r.bundle_position ?? null,
    dependsOnId: r.depends_on_id ?? null,
    resourceOwnerId: r.resource_owner_id ?? null,
    lastEdit: input.lastEdit,
    lastFailure: input.lastFailure ?? null,
    ...(r.metadata && Object.keys(r.metadata).length > 0 ? { metadata: r.metadata } : {}),
  }
}

// Tool families whose approvals are SHARED-SURFACE: they gate an action on a
// ticket or mail conversation the whole team works, not a privately-routed
// approval (e.g. a refund sent to a named approver). For these, `listApprovals`
// scopes VISIBILITY to "anyone who can read the surface" (the ticket/mail read
// scope) rather than the request's `notify_user_ids` — so the DECIDE and EDIT
// eligibility checks must use the same broadened boundary. Otherwise a teammate
// sees the draft card the list returned but gets 403 acting on it, because the
// notify-set is only ever the original requester. Keep this list in sync with
// the ticket/conversation-mode tool lists in `list.ts`.
// One copy of the family list, in the shared authority module (the web's
// decide-eligibility check consumes the same set).
const SHARED_SURFACE_APPROVAL_TOOLS = SHARED_SURFACE_TOOLS

/** Ownership-aware shared-surface check. A tool in the shared-surface family
 *  is only ACTUALLY shared-surface when the approval does NOT target a
 *  personally-owned resource: a reply drafted from a PERSONAL mailbox
 *  (resource_owner_id set) is privately routed to the owner, so the team-wide
 *  widening of decide/edit/visibility must not apply. Prefer this over the
 *  raw tool-name check wherever the approval row is at hand. */
export function isSharedSurfaceApproval(row: {
  tool_name: string
  resource_owner_id?: string | null
}): boolean {
  return row.resource_owner_id == null && SHARED_SURFACE_APPROVAL_TOOLS.has(row.tool_name)
}

interface RawSummaryRow {
  id: string
  handle: string
  status: ApprovalRequestStatus
  created_at: Date
  expires_at: Date
  tool_name: string
  approve_scope: string | null
  summary: ApprovalSummary
  current_payload: Record<string, unknown>
  thread_id: string
  originating_thread_id: string
  requested_by: string
  notify_user_ids: string[]
  decided_by: string | null
  decided_at: Date | null
  reason: string | null
  bundle_id: string | null
  bundle_position: number | null
  depends_on_id: string | null
  resource_owner_id: string | null
  agent_id: string | null
  metadata: Record<string, unknown> | null
}

/** Load an approval row + requester name + editable fields and produce the canonical
 *  `ApprovalRequestSummary`. Used for create/update event payloads and HTTP detail responses. */
export async function loadApprovalSummary(
  tx: PrivilegedDb | RlsClient,
  orgId: string,
  requestId: string,
  lastEdit: ApprovalLastEdit | null = null,
  lastFailure: ApprovalLastFailure | null = null,
): Promise<ApprovalRequestSummary> {
  const [raw] = extractRows<RawSummaryRow>(
    await tx.execute(drizzleSql`
      SELECT id, handle, status, created_at, expires_at, tool_name, approve_scope, summary,
             current_payload, thread_id, originating_thread_id, requested_by, notify_user_ids,
             decided_by, decided_at, reason, bundle_id, bundle_position, depends_on_id,
             resource_owner_id, agent_id, metadata
      FROM ${K}.approval_requests WHERE id = ${requestId}
    `),
  )
  const requester = await readApprovalRequester(tx, orgId, requestId, raw.requested_by)
  const [decider] = raw.decided_by
    ? await tx.select({ name: users.name }).from(users).where(eq(users.id, raw.decided_by))
    : [undefined]
  const { appName, toolShortName } = splitToolName(raw.tool_name)
  const editableFields = approvalEditableFieldsRegistry.get([orgId, appName, toolShortName]) ?? []
  return buildApprovalSummary({
    raw,
    requester,
    decidedByName: decider?.name ?? null,
    editableFields,
    lastEdit,
    lastFailure,
  })
}

/** Post a system message to the originating thread, plus the discussion thread when it differs.
 *  Authoring user is the requester for the originating post (always a participant) and the actor
 *  for the discussion-thread post. */
export async function postDualSystemMessages(
  tx: PrivilegedDb,
  args: {
    /** What the content may quote; `[]` only for text that carries no scoped data. */
    requiredScopes: string[]
    orgId: string
    threadId: string
    originatingThreadId: string
    requesterId: string
    actorUserId: string
    content: string
    metadata: Record<string, unknown>
    /** A11: the agent this notice is about, for callers that know it (the
     *  identity a job hop or an approval row carries). Omitted means "read the
     *  live turn", which is what every in-frame caller wants. */
    agentId?: string | null
  },
): Promise<void> {
  // A7: an approval opened from a reply thread keeps its root on the row
  // (execute-tool), and every notice about it lands in that same reply thread
  // of the originating thread. One primary-key read; absent, the channel.
  const requestId = typeof args.metadata.requestId === "string" ? args.metadata.requestId : null
  let replyRootId: string | null = null
  if (requestId) {
    const [row] = extractRows<{ reply_root_id: string | null }>(
      await tx.execute(drizzleSql`
        SELECT metadata->>'replyRootId' AS reply_root_id
        FROM ${K}.approval_requests
        WHERE id = ${requestId} AND org_id = ${args.orgId}
          AND originating_thread_id = ${args.originatingThreadId}`),
    )
    replyRootId = row?.reply_root_id ?? null
  }
  await sendMessage(tx as unknown as RlsClient, {
    requiredScopes: args.requiredScopes,
    orgId: args.orgId,
    userId: args.requesterId,
    threadId: args.originatingThreadId,
    content: args.content,
    authorType: "system",
    agentId: args.agentId,
    metadata: args.metadata,
    replyRootId,
  })
  if (args.threadId !== args.originatingThreadId) {
    await sendMessage(tx as unknown as RlsClient, {
      requiredScopes: args.requiredScopes,
      orgId: args.orgId,
      userId: args.actorUserId,
      threadId: args.threadId,
      content: args.content,
      authorType: "system",
      agentId: args.agentId,
      metadata: args.metadata,
    })
  }
}

/** Look up a user's display name. Used to render "Approved by X" /
 *  "Denied by X" system messages. */
export async function loadUserName(tx: PrivilegedDb | RlsClient, userId: string): Promise<string> {
  const [user] = await tx.select({ name: users.name }).from(users).where(eq(users.id, userId))
  return user?.name ?? "Unknown"
}

/** Coerce a stored approval payload (object or JSON string) into a plain object.
 *  jsonb columns sometimes round-trip as strings depending on driver/version. */
export function normalizeApprovalPayload(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? safeJsonParse(value) : value
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return {}
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** Build the requester's effective UserContext — used by approve, cascade, and
 *  poll paths that need to run handlers under the requester's permissions. */
export async function loadRequesterContext(
  orgId: string,
  requesterId: string,
  reason: string,
): Promise<UserContext> {
  const perms = await withPrivilegedDb(orgId, reason, (pdb) =>
    loadEffectivePermissions(pdb, requesterId, orgId),
  )
  return {
    actorType: "user",
    userId: requesterId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
}

/**
 * True when a bundle step still has a step waiting behind it: one depending on
 * it, or any other step of its bundle not yet run (`deferred`) or running
 * (`approving`). A bundle whose later steps refer to the head, not to the step
 * before them, has dependents that do not depend on this step: the turn still
 * waits for the last of them.
 */
export async function hasDeferredDependent(orgId: string, approvalId: string): Promise<boolean> {
  const [waiting] = extractRows<{ id: string }>(
    await withPrivilegedDb(orgId, "approval-result-turn-bundle", (tx) =>
      tx.execute(drizzleSql`
        SELECT o.id FROM ${K}.approval_requests o
        WHERE o.org_id = ${orgId} AND o.id <> ${approvalId}
          AND (
            (o.depends_on_id = ${approvalId} AND o.status = 'deferred')
            OR (o.status IN ('deferred', 'approving') AND o.bundle_id IS NOT NULL
                AND o.bundle_id = (SELECT s.bundle_id FROM ${K}.approval_requests s
                                    WHERE s.id = ${approvalId} AND s.org_id = ${orgId}))
          )
        LIMIT 1`),
    ),
  )
  return Boolean(waiting)
}

/** Once per approval, durably: whoever claims first runs the turn (`metadata.resultTurnAt`). */
async function claimTurnOnce(
  tx: PrivilegedDb,
  orgId: string,
  approvalId: string,
): Promise<boolean> {
  const [claimed] = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${K}.approval_requests
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('resultTurnAt', now())
      WHERE id = ${approvalId} AND org_id = ${orgId}
        AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'resultTurnAt')
      RETURNING id`),
  )
  return Boolean(claimed)
}

/**
 * The same once-per-approval claim, for a decided approval of a routine run
 * (routine-run-resume.ts): the run, not a conversation, takes the turn, so
 * there is no result row to start from and no "conversation moved on" check
 * (the routine's thread is shared by its runs). A denial or expiry claims it too.
 */
export async function claimApprovalTurnOnce(orgId: string, approvalId: string): Promise<boolean> {
  return withPrivilegedDb(orgId, "approval-result-turn-claim", (tx) =>
    claimTurnOnce(tx, orgId, approvalId),
  )
}

/**
 * Claim the one turn an approved call's result hands back to the agent that
 * proposed it (approval-result-turn.ts), and return the result row it starts
 * from. Null when there is nothing to answer: no result row for an approved
 * request, the person wrote after the decision, the agent already spoke after
 * the result, or the turn was claimed before (`metadata.resultTurnAt`).
 */
export async function claimApprovalResultTurn(args: {
  orgId: string
  approvalId: string
  threadId: string
  requesterId: string
  agentId: string
}): Promise<{ messageId: string; askId: string } | null> {
  return withPrivilegedDb(args.orgId, "approval-result-turn-claim", async (tx) => {
    const [line] = extractRows<{
      id: string
      created_at: string
      decided_at: string | null
      ask_id: string | null
      approval_created_at: string
      originating_thread_id: string | null
    }>(
      await tx.execute(drizzleSql`
        SELECT m.id, m.created_at, a.decided_at, a.metadata->>'askId' AS ask_id,
          a.created_at AS approval_created_at, a.originating_thread_id
        FROM ${K}.messages m
        JOIN ${K}.approval_requests a ON a.id = ${args.approvalId} AND a.org_id = ${args.orgId}
        WHERE m.thread_id = ${args.threadId} AND m.org_id = ${args.orgId}
          AND m.author_type = 'system'
          AND m.metadata->>'type' = 'approval-result'
          AND m.metadata->>'requestId' = ${args.approvalId}
          AND a.status = 'approved'
        ORDER BY m.created_at
        LIMIT 1`),
    )
    if (!line) return null
    // The conversation moved on: the person wrote after the decision (their
    // turn replays the result and answers it), or the agent already spoke
    // after the result.
    const [moved] = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${K}.messages
        WHERE thread_id = ${args.threadId} AND org_id = ${args.orgId}
          AND (
            (author_type = 'user' AND author_id = ${args.requesterId}
              AND created_at > COALESCE(${line.decided_at}::timestamptz, ${line.created_at}::timestamptz))
            OR (author_type = 'agent' AND author_agent_id = ${args.agentId}
              AND created_at > ${line.created_at}::timestamptz)
          )
        LIMIT 1`),
    )
    if (moved) return null
    if (await siblingAnswersLater(tx, args, line)) return null
    if (!(await claimTurnOnce(tx, args.orgId, args.approvalId))) return null
    return { messageId: line.id, askId: line.ask_id ?? (await fallbackAskId(tx, args, line)) }
  })
}

/**
 * One turn of the agent answers one question, however many of its calls that
 * turn parked. A sibling is another approval the same agent proposed in the
 * same conversation for the same ask (`metadata.askId`). While a sibling is
 * still undecided or running, or a sibling's result was posted after this one,
 * the turn is that sibling's to hand back: it reads every result row, this one
 * included. Without an ask recorded, each approval stands alone.
 */
async function siblingAnswersLater(
  tx: PrivilegedDb,
  args: { orgId: string; approvalId: string; threadId: string },
  line: { id: string; created_at: string },
): Promise<boolean> {
  const [sibling] = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT s.id
        FROM ${K}.approval_requests a
        JOIN ${K}.approval_requests s
          ON s.org_id = a.org_id AND s.id <> a.id
         AND s.originating_thread_id = a.originating_thread_id
         AND s.agent_id IS NOT DISTINCT FROM a.agent_id
         AND s.metadata->>'askId' = a.metadata->>'askId'
       WHERE a.id = ${args.approvalId} AND a.org_id = ${args.orgId}
         AND a.metadata->>'askId' IS NOT NULL
         AND (
           s.status IN ('pending', 'approving', 'deferred')
           OR (s.status = 'approved' AND EXISTS (
             SELECT 1 FROM ${K}.messages r
              WHERE r.thread_id = ${args.threadId} AND r.org_id = ${args.orgId}
                AND r.author_type = 'system'
                AND r.metadata->>'type' = 'approval-result'
                AND r.metadata->>'requestId' = s.id::text
                AND (r.created_at > ${line.created_at}::timestamptz
                  OR (r.created_at = ${line.created_at}::timestamptz AND r.id::text > ${line.id}))))
         )
       LIMIT 1`),
  )
  return Boolean(sibling)
}

/**
 * An approval of an agent's turn was refused (denied, expired, cancelled,
 * withdrawn) while the turn's other calls were approved: those siblings left
 * the turn to this one, so the latest approved sibling whose turn was never
 * taken hands it back now. Null when none is owed (a sibling is still
 * undecided, or none was approved, or its turn already ran).
 */
export async function approvedSiblingOwedTurn(
  orgId: string,
  approvalId: string,
): Promise<{
  id: string
  originating_thread_id: string
  requested_by: string
  agent_id: string | null
  origin: string | null
} | null> {
  return withPrivilegedDb(orgId, "approval-result-turn-sibling", async (tx) => {
    const [row] = extractRows<{
      id: string
      originating_thread_id: string
      requested_by: string
      agent_id: string | null
      origin: string | null
    }>(
      await tx.execute(drizzleSql`
        SELECT s.id::text, s.originating_thread_id::text, s.requested_by::text,
               s.agent_id::text, s.metadata->>'origin' AS origin
          FROM ${K}.approval_requests a
          JOIN ${K}.approval_requests s
            ON s.org_id = a.org_id AND s.id <> a.id
           AND s.originating_thread_id = a.originating_thread_id
           AND s.agent_id IS NOT DISTINCT FROM a.agent_id
           AND s.metadata->>'askId' = a.metadata->>'askId'
          JOIN ${K}.messages r
            ON r.org_id = s.org_id AND r.thread_id = s.originating_thread_id
           AND r.author_type = 'system'
           AND r.metadata->>'type' = 'approval-result'
           AND r.metadata->>'requestId' = s.id::text
         WHERE a.id = ${approvalId} AND a.org_id = ${orgId}
           AND a.metadata->>'askId' IS NOT NULL
           AND NOT (a.metadata ? 'originRoutineRunId')
           AND s.status = 'approved'
           AND NOT (COALESCE(s.metadata, '{}'::jsonb) ? 'resultTurnAt')
           AND NOT EXISTS (
             SELECT 1 FROM ${K}.approval_requests p
              WHERE p.org_id = a.org_id AND p.id <> a.id
                AND p.originating_thread_id = a.originating_thread_id
                AND p.agent_id IS NOT DISTINCT FROM a.agent_id
                AND p.metadata->>'askId' = a.metadata->>'askId'
                AND p.status IN ('pending', 'approving', 'deferred'))
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT 1`),
    )
    return row ?? null
  })
}

/**
 * The person's message an approval's handed-back turn answers, for an approval
 * that predates `metadata.askId`: the latest message a person wrote in the
 * conversation that proposed the call, before the call was proposed. When
 * there is none, the result row itself, as before.
 */
async function fallbackAskId(
  tx: PrivilegedDb,
  args: { orgId: string; threadId: string },
  line: { id: string; approval_created_at: string; originating_thread_id: string | null },
): Promise<string> {
  const [ask] = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${K}.messages
      WHERE thread_id = ${line.originating_thread_id ?? args.threadId} AND org_id = ${args.orgId}
        AND author_type NOT IN ('system', 'agent')
        AND created_at <= ${line.approval_created_at}::timestamptz
      ORDER BY created_at DESC
      LIMIT 1`),
  )
  return ask?.id ?? line.id
}

/** Cancel every deferred step of a bundle. Called when a head is denied,
 *  expired, or any step fails — keeps the SQL invariant in one place so the
 *  three terminal-state transitions cannot drift apart. */
export async function cancelDeferredBundleSiblings(
  tx: PrivilegedDb,
  bundleId: string,
): Promise<void> {
  await tx.execute(drizzleSql`
    UPDATE ${K}.approval_requests SET status = 'cancelled'
    WHERE bundle_id = ${bundleId} AND status = 'deferred'`)
}

/**
 * Cancel every deferred step that waits, directly or through other deferred
 * steps, on `approvalId`. `cancelDeferredBundleSiblings` keys on the bundle id,
 * which a later step that became its own decision (a sealed mail send waiting
 * for its mailbox owner, cascade.ts) does not share as its id: denying or
 * expiring that step must not strand the steps behind it.
 */
export async function cancelDeferredDependents(
  tx: PrivilegedDb,
  approvalId: string,
): Promise<void> {
  await tx.execute(drizzleSql`
    WITH RECURSIVE chain(id) AS (
      SELECT id FROM ${K}.approval_requests
       WHERE depends_on_id = ${approvalId} AND status = 'deferred'
      UNION
      SELECT ar.id FROM ${K}.approval_requests ar JOIN chain c ON ar.depends_on_id = c.id
       WHERE ar.status = 'deferred'
    )
    UPDATE ${K}.approval_requests SET status = 'cancelled'
     WHERE id IN (SELECT id FROM chain)`)
}

/** Post the dual system message + load the summary + queue the
 *  `approval_request:update` event. Every terminal state transition (decide
 *  deny, decide revert, expiry, edit, terminalize-approved) does the same
 *  triplet — one helper makes the event shape impossible to drift. */
export async function emitApprovalStateChange(
  tx: PrivilegedDb,
  args: {
    /** What `content` and `metadata` may quote. `[]` only for a fixed notice
     *  that carries no handler output: the error variants quote the handler's
     *  own message and carry its raw error object, so they require what the call
     *  could reveal (see `approvalFailureRequiredScopes`). */
    requiredScopes: string[]
    orgId: string
    requestId: string
    threadId: string
    originatingThreadId: string
    requesterId: string
    actorUserId: string
    actorType: "user" | "system"
    content: string
    metadata: Record<string, unknown>
    lastEdit?: ApprovalLastEdit | null
    /** The post-approval execution failure to stamp onto this event's approval
     *  summary (revert-to-pending / ambiguous-hold), so the card renders it
     *  inline live over WS. Null/omitted for non-failure transitions. */
    lastFailure?: ApprovalLastFailure | null
  },
): Promise<void> {
  // Read first: the notice names WHICH request it is about. "Approved by X.
  // Tool executed successfully." with no handle and no tool is what the agent
  // replays from its transcript (system-event-replay.ts), and in a thread with
  // two approvals it cannot tell which one was decided. A caller's own key
  // wins; the summary only fills what the caller left out.
  const summaryData = await loadApprovalSummary(
    tx,
    args.orgId,
    args.requestId,
    args.lastEdit ?? null,
    args.lastFailure ?? null,
  )
  await postDualSystemMessages(tx, {
    requiredScopes: args.requiredScopes,
    orgId: args.orgId,
    threadId: args.threadId,
    originatingThreadId: args.originatingThreadId,
    requesterId: args.requesterId,
    actorUserId: args.actorUserId,
    content: args.content,
    metadata: {
      requestHandle: summaryData.handle,
      toolName: summaryData.toolName,
      ...args.metadata,
    },
    // A11: every caller of this helper is a HUMAN-decided lifecycle transition
    // (deny, revert, expiry, edit, terminalize-approved). The explicit null
    // keeps the notice honest when some other agent's turn is live in the
    // deciding request: `sendMessage` reads the live frame only when this is
    // absent. A caller that genuinely knows an agent posts through
    // `postDualSystemMessages` directly, as the restage and sequence-failed
    // notices do.
    agentId: null,
  })
  await tx.queueEvent({
    app: "kernel",
    entity: "approval_request",
    action: "update",
    entityId: args.requestId,
    orgId: args.orgId,
    actorId: args.actorUserId,
    actorType: args.actorType,
    // A11: same reason as the notice above. A human drove this transition, so
    // the explicit null stops FX21's central stamp from claiming it for an
    // unrelated live turn.
    agentId: null,
    data: summaryData,
  })
}

/** Optimistic-lock UPDATE on `kernel.approval_requests`. The `from` clause is
 *  the guard that makes the transition idempotent under concurrency. Returns
 *  the first row from RETURNING, or undefined if the guard failed.
 *
 *  `set` and `returning` are caller-supplied SQL fragments so each transition
 *  can specify exactly the columns it cares about — the helper only owns the
 *  surrounding "UPDATE … WHERE id AND status = $from RETURNING …" shape. */
export async function lockedUpdateApproval<R>(
  tx: PrivilegedDb,
  args: {
    requestId: string
    from: string | readonly string[]
    set: SQL
    returning: SQL
  },
): Promise<R | undefined> {
  const fromClause = Array.isArray(args.from)
    ? drizzleSql`status IN (${drizzleSql.join(
        args.from.map((s) => drizzleSql`${s}`),
        drizzleSql.raw(", "),
      )})`
    : drizzleSql`status = ${args.from as string}`
  const rows = extractRows<R>(
    await tx.execute(drizzleSql`
      UPDATE ${K}.approval_requests
      SET ${args.set}
      WHERE id = ${args.requestId} AND ${fromClause}
      RETURNING ${args.returning}`),
  )
  return rows[0]
}
