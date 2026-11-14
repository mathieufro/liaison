// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  APPROVING_WEDGE_GRACE_MS,
  type ApprovalSendGuard,
  type ApprovalSummary,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { apiViewer, authorityFacts, canSeeInList } from "~/modules/approvals/authority"
import {
  type ApprovalLastEdit,
  type ApprovalRequestSummary,
  buildApprovalSummary,
  splitToolName,
} from "~/modules/approvals/event-data"
import { readApprovalLastFailure, readApprovalLastFailures } from "~/modules/approvals/last-failure"
import {
  pickApprovalRequester,
  readApprovalRequester,
  readApprovalRequesters,
} from "~/modules/approvals/requester"
import { withServedSummaries } from "~/modules/approvals/served-summary"
import { approvalEditableFieldsRegistry } from "~/modules/apps/app-registries"
import {
  evaluateSendGuard,
  evaluateSendGuardsAtCard,
  isPinnedSendGuard,
  type PinnedSendGuard,
  personZones,
  recipientFacts,
  recipientsOf,
  type SendGuardVerdict,
  withoutThirdParty,
} from "~/modules/mail/send-guard"
import { revealManagedApprovalSummaries } from "~/modules/mailbox-crypto/managed-approval"

const K = drizzleSql.raw(schemaRef("kernel"))

/** How far back the recently-decided mode reaches, and its row cap. */
export const RECENTLY_DECIDED_WINDOW_HOURS = 24
export const RECENTLY_DECIDED_LIMIT = 25

interface RawApprovalRow {
  id: string
  handle: string
  status: ApprovalRequestSummary["status"]
  created_at: Date | string
  expires_at: Date | string
  tool_name: string
  approve_scope: string | null
  summary: ApprovalSummary
  current_payload: Record<string, unknown>
  thread_id: string
  originating_thread_id: string
  requested_by: string
  notify_user_ids: string[]
  decided_by: string | null
  decided_at: Date | string | null
  reason: string | null
  bundle_id: string | null
  bundle_position: number | null
  depends_on_id: string | null
  resource_owner_id: string | null
  /** A11: the agent whose turn proposed this gated call, null when a human did. */
  agent_id: string | null
  metadata: Record<string, unknown> | null
}

function mapLastEdit(
  metadata: Record<string, unknown> | null,
  createdAt: Date | string,
): ApprovalLastEdit | null {
  if (!metadata || metadata.type !== "payload-edit") return null
  return {
    editorUserId: metadata.editorUserId as string,
    at: new Date(createdAt).toISOString(),
    diff: Array.isArray(metadata.diff) ? (metadata.diff as ApprovalLastEdit["diff"]) : [],
  }
}

/**
 * The newest payload edit of each approval, read from the system message the
 * edit path posts into the approval's thread.
 *
 * One probe per DISTINCT thread through the partial index
 * `messages_payload_edit_idx` (0156): the WHERE below must match its predicate
 * exactly, and the CTE is MATERIALIZED so the planner cannot inline it and
 * probe once per approval instead. Many approvals share one thread (an MCP connection's, a routine's)
 * and such threads hold thousands of messages; the old join walked the whole
 * thread once per approval with the messages RLS policy evaluated on every row,
 * and timed the whole approvals list out.
 *
 * An enrichment, never a gate: if the read fails, the cards render without
 * their "edited" marker and the failure is logged. The read runs in a
 * savepoint so a failed statement does not abort the caller's transaction.
 */
export async function readLastPayloadEdits(
  db: RlsClient,
  orgId: string,
  requestIds: string[],
): Promise<Map<string, ApprovalLastEdit | null>> {
  const out = new Map<string, ApprovalLastEdit | null>()
  if (requestIds.length === 0) return out
  const requestIdList = drizzleSql.join(
    requestIds.map((id) => drizzleSql`${id}::uuid`),
    drizzleSql`, `,
  )
  try {
    const rows = await db.transaction(async (sp) =>
      extractRows<{
        request_id: string
        metadata: Record<string, unknown> | null
        created_at: Date | string
      }>(
        await sp.execute(drizzleSql`
          WITH threads AS (
            SELECT DISTINCT thread_id FROM ${K}.approval_requests WHERE id IN (${requestIdList})
          ), last_edit AS MATERIALIZED (
            SELECT t.thread_id, e.metadata, e.created_at
            FROM threads t
            CROSS JOIN LATERAL (
              SELECT m.metadata, m.created_at
              FROM ${K}.messages m
              WHERE m.thread_id = t.thread_id
                AND m.author_type = 'system'
                AND (m.metadata ->> 'type') = 'payload-edit'
              ORDER BY m.created_at DESC
              LIMIT 1
            ) e
          )
          SELECT ar.id AS request_id, le.metadata, le.created_at
          FROM ${K}.approval_requests ar
          JOIN last_edit le ON le.thread_id = ar.thread_id
          WHERE ar.id IN (${requestIdList})
        `),
      ),
    )
    for (const r of rows) out.set(r.request_id, mapLastEdit(r.metadata, r.created_at))
  } catch (err) {
    log.error(
      { err, orgId, requestCount: requestIds.length, op: "approvals.readLastPayloadEdits" },
      "approval payload-edit lookup failed: listing the approvals without their last edit",
    )
  }
  return out
}

export async function listApprovals(
  db: RlsClient,
  args: {
    orgId: string
    userId: string
    scopes: string[]
    bundleId?: string
    threadId?: string
    ticketId?: string
    conversationId?: string
    /** Decidable-feed mode only: keep the rows of this app's tools (`<app>:<tool>`). */
    app?: string
    /** Requested-by-me mode (Home's "Waiting on others", D21): the caller's
     *  own pending requests, newest first. */
    requestedByMe?: boolean
    /** Recently-decided mode (the agent's approvals read): requests decided in
     *  the last {@link RECENTLY_DECIDED_WINDOW_HOURS} hours, newest decision
     *  first, so "was it done?" after a denial has a grounded answer. */
    recentlyDecided?: boolean
    /** The cards' surface: each agent mail draft carries what the send check says now. */
    sendGuards?: boolean
  },
): Promise<ApprovalRequestSummary[]> {
  // Bundle mode: return every step of one bundle in position order.
  // Thread mode: every approval hosted on one thread, newest first (an MCP
  // connection thread accumulates approvals over its life).
  // Ticket mode: every approval raised FOR a ticket (`tool_params.ticketId`),
  // regardless of which thread the request actually lives on. A ROUTINE
  // raising a gated tickets:reply/nudge/close hosts the approval_request on
  // its own output thread, not the ticket's internalThreadId — so the
  // threadId mode above misses it entirely. Mirrors the `tool_params @>`
  // match `cancelApprovalsForSourceTicket` already uses (approvals/cancel.ts).
  // Conversation mode: same shape for mail — every gated mail:reply/forward
  // raised FOR a conversation (`tool_params.conversationId`), so the mail
  // conversation view can render its pending drafts inline regardless of
  // which thread hosts the request.
  // Decidable-feed mode: the existing pending decidable list.
  //
  // Audience + scope filter: RLS scopes the org, but within an org any member
  // could otherwise enumerate another member's approval payloads by guessing
  // a bundle/thread id. Bundle/thread/decidable-feed modes require the caller
  // be in `notify_user_ids` AND hold the row's DECIDING scope (`approve_scope`,
  // falling back to `<app>:approve` — see the shared authority module), OR be
  // the requester. Ticket mode uses a different, cleaner boundary: a gated
  // tickets:* approval is inherently ticket-scoped, so anyone who can read
  // the ticket (holds `tickets:tickets:read`, the same scope the tickets app
  // gates all ticket reads on) can see its pending reply/nudge/close drafts —
  // matching "if you can read the ticket, you can see its drafts" rather than
  // requiring thread participancy the ticket page never establishes.
  const result = args.bundleId
    ? await db.execute(drizzleSql`
        SELECT id, handle, status, created_at, expires_at, tool_name, approve_scope, summary, current_payload,
               thread_id, originating_thread_id, requested_by, notify_user_ids,
               decided_by, decided_at, reason, bundle_id, bundle_position, depends_on_id,
               resource_owner_id, agent_id, metadata
        FROM ${K}.approval_requests
        WHERE org_id = ${args.orgId} AND bundle_id = ${args.bundleId}
          AND status <> 'cancelled'
        ORDER BY bundle_position ASC
      `)
    : args.threadId
      ? await db.execute(drizzleSql`
        SELECT id, handle, status, created_at, expires_at, tool_name, approve_scope, summary, current_payload,
               thread_id, originating_thread_id, requested_by, notify_user_ids,
               decided_by, decided_at, reason, bundle_id, bundle_position, depends_on_id,
               resource_owner_id, agent_id, metadata
        FROM ${K}.approval_requests
        WHERE org_id = ${args.orgId} AND thread_id = ${args.threadId}
        ORDER BY created_at DESC
        LIMIT 50
      `)
      : args.ticketId
        ? await db.execute(drizzleSql`
        SELECT id, handle, status, created_at, expires_at, tool_name, approve_scope, summary, current_payload,
               thread_id, originating_thread_id, requested_by, notify_user_ids,
               decided_by, decided_at, reason, bundle_id, bundle_position, depends_on_id,
               resource_owner_id, agent_id, metadata
        FROM ${K}.approval_requests
        WHERE org_id = ${args.orgId}
          AND tool_name IN ('tickets:reply', 'tickets:nudge', 'tickets:close')
          AND (
            tool_params @> jsonb_build_object('ticketId', ${args.ticketId}::text)
            OR current_payload @> jsonb_build_object('ticketId', ${args.ticketId}::text)
          )
        ORDER BY created_at DESC
        LIMIT 50
      `)
        : args.conversationId
          ? await db.execute(drizzleSql`
        SELECT id, handle, status, created_at, expires_at, tool_name, approve_scope, summary, current_payload,
               thread_id, originating_thread_id, requested_by, notify_user_ids,
               decided_by, decided_at, reason, bundle_id, bundle_position, depends_on_id,
               resource_owner_id, agent_id, metadata
        FROM ${K}.approval_requests
        WHERE org_id = ${args.orgId}
          AND tool_name IN ('mail:reply', 'mail:forward')
          AND (
            tool_params @> jsonb_build_object('conversationId', ${args.conversationId}::text)
            OR current_payload @> jsonb_build_object('conversationId', ${args.conversationId}::text)
          )
        ORDER BY created_at DESC
        LIMIT 50
      `)
          : args.recentlyDecided
            ? await db.execute(drizzleSql`
        SELECT id, handle, status, created_at, expires_at, tool_name, approve_scope, summary, current_payload,
               thread_id, originating_thread_id, requested_by, notify_user_ids,
               decided_by,
               -- Expiry never stamps decided_at: the request closed at its deadline.
               COALESCE(decided_at, CASE WHEN status = 'expired' THEN expires_at END) AS decided_at,
               reason, bundle_id, bundle_position, depends_on_id,
               resource_owner_id, agent_id, metadata
        FROM ${K}.approval_requests
        WHERE org_id = ${args.orgId}
          AND (
            status IN ('approved', 'denied', 'withdrawn', 'expired', 'cancelled')
            -- Approved and still executing; a wedged one is back in the pending feed.
            OR (status = 'approving'
                AND approving_started_at >= now() - make_interval(secs => ${APPROVING_WEDGE_GRACE_MS / 1000}::double precision))
          )
          AND COALESCE(decided_at, CASE WHEN status = 'expired' THEN expires_at END)
              >= now() - make_interval(hours => ${RECENTLY_DECIDED_WINDOW_HOURS})
        -- A bare name resolves to the output column (the COALESCE above).
        ORDER BY decided_at DESC
        LIMIT ${RECENTLY_DECIDED_LIMIT}
      `)
            : args.requestedByMe
              ? await db.execute(drizzleSql`
        SELECT id, handle, status, created_at, expires_at, tool_name, approve_scope, summary, current_payload,
               thread_id, originating_thread_id, requested_by, notify_user_ids,
               decided_by, decided_at, reason, bundle_id, bundle_position, depends_on_id,
               resource_owner_id, agent_id, metadata
        FROM ${K}.approval_requests
        WHERE org_id = ${args.orgId}
          AND requested_by = ${args.userId}
          AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 100
      `)
              : await db.execute(drizzleSql`
        SELECT id, handle, status, created_at, expires_at, tool_name, approve_scope, summary, current_payload,
               thread_id, originating_thread_id, requested_by, notify_user_ids,
               decided_by, decided_at, reason, bundle_id, bundle_position, depends_on_id,
               resource_owner_id, agent_id, metadata
        FROM ${K}.approval_requests
        WHERE org_id = ${args.orgId}
          AND (
            status = 'pending'
            -- A row stuck at 'approving' past the wedge grace window is a DEAD execution
            -- (the claim commits before the handler runs; an unmapped handler error leaves
            -- it there forever). Surface it again so a decide can reach decide.ts's
            -- healWedgedApproving and reset it — hidden, it is undecidable by anyone.
            OR (status = 'approving'
                AND approving_started_at < now() - make_interval(secs => ${APPROVING_WEDGE_GRACE_MS / 1000}::double precision))
          )
          ${args.app ? drizzleSql`AND starts_with(tool_name, ${`${args.app}:`})` : drizzleSql``}
        ORDER BY created_at ASC
      `)
  const rows = extractRows<RawApprovalRow>(result)

  // Visibility is the shared authority answer (`canSeeInList`): owner-routed
  // rows stay requester/owner-private in EVERY mode; ticket/conversation modes
  // widen to surface readers; the requester always sees their own request; and
  // everyone else needs notify-membership plus the row's own deciding scope.
  // The scope comes from `approve_scope` on the row — recomputing
  // `<app>:approve` here is what silently dropped kernel:update_skill rows
  // (decided by kernel:skills:approve) that RLS had already let through.
  const listViewer = apiViewer(args.userId, args.scopes)
  const listMode = { ticketId: args.ticketId, conversationId: args.conversationId }
  const visible = rows.filter((r) => canSeeInList(authorityFacts(r), listViewer, listMode))

  if (visible.length === 0) return []
  // A ticket approval's ref follows the ticket's current display handle.
  const filtered = await withServedSummaries(db, args.orgId, visible)

  // Who ASKED is `requesters` below (an agent or a person, one rule); this
  // map names the deciders only.
  const userIds = [...new Set(filtered.flatMap((r) => (r.decided_by ? [r.decided_by] : [])))]
  const userRows =
    userIds.length === 0
      ? []
      : extractRows<{ id: string; name: string }>(
          await db.execute(drizzleSql`
            SELECT id, name FROM ${K}.users
            WHERE id IN (${drizzleSql.join(
              userIds.map((id) => drizzleSql`${id}::uuid`),
              drizzleSql`, `,
            )})
          `),
        )
  const userMap = new Map(userRows.map((u) => [u.id, u.name]))

  const requestIds = filtered.map((r) => r.id)
  const lastEditByRequestId = await readLastPayloadEdits(db, args.orgId, requestIds)
  // One privileged batch read for the post-approval failures (the ONE source:
  // approved_handler_executions), so a card that reverted to pending carries its
  // reason inline instead of reading as a fresh "waiting".
  const requesters = await readApprovalRequesters(db, args.orgId, requestIds)

  const lastFailureByRequestId = await withPrivilegedDb(
    args.orgId,
    "approvals-list-last-failure",
    (tx) => readApprovalLastFailures(tx, args.orgId, requestIds),
  )

  const guards = args.sendGuards
    ? await readSendGuards(db, args.orgId, filtered, "card")
    : new Map<string, ApprovalSendGuard>()

  const summaries = filtered.map((r) => {
    const { appName, toolShortName } = splitToolName(r.tool_name)
    const editableFields =
      approvalEditableFieldsRegistry.get([args.orgId, appName, toolShortName]) ?? []
    const summary = buildApprovalSummary({
      raw: r,
      requester: requesters.get(r.id) ?? pickApprovalRequester(null, null, r.requested_by),
      decidedByName: r.decided_by ? (userMap.get(r.decided_by) ?? null) : null,
      editableFields,
      lastEdit: lastEditByRequestId.get(r.id) ?? null,
      lastFailure: lastFailureByRequestId.get(r.id) ?? null,
    })
    const guard = guards.get(r.id)
    return guard ? { ...summary, sendGuard: guard } : summary
  })
  // A draft sealed under a transparent mailbox's key: opened for its owner.
  return revealManagedApprovalSummaries(summaries, args.orgId, args.userId)
}

// ── The send check, as a card shows it ──────────────────────────────────────

const GUARDED_SENDS = new Set(["mail:compose", "mail:reply"])
const QUOTE_CHARS = 200
const GUARD_STATES = new Set<ApprovalSendGuard["state"]>([
  "clear",
  "replied",
  "bounced",
  "held",
  "opted_out",
  "ref_stop",
  "unavailable",
])

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * The start of the message that stopped or held a draft, read with the VIEWER's access, so a
 * reply in a mailbox they cannot read gives neither quote nor record. A sealed message has no
 * cleartext snippet and gives no quote. In a savepoint: a failed read costs the quote only.
 */
async function readableQuote(
  db: RlsClient,
  verdict: SendGuardVerdict,
): Promise<{ readable: boolean; quote: string | null }> {
  const record = verdict.record
  if (!record || !verdict.at) return { readable: false, quote: null }
  const at = verdict.at
  try {
    const rows = await db.transaction(async (sp) =>
      extractRows<{ quote: string | null }>(
        await sp.execute(
          record.kind === "ticket"
            ? drizzleSql`
                SELECT left(m.text_body, ${QUOTE_CHARS}) AS quote
                  FROM ${drizzleSql.raw(schemaRef("app_tickets"))}.messages m
                 WHERE m.ticket_id = ${record.id}::uuid AND m.kind = 'inbound'
                   AND COALESCE(m.sent_at, m.received_at) >= ${at}::timestamptz
                   AND COALESCE(m.sent_at, m.received_at) < ${at}::timestamptz + interval '1 millisecond'
                 LIMIT 1`
            : drizzleSql`
                SELECT left(m.snippet, ${QUOTE_CHARS}) AS quote
                  FROM ${drizzleSql.raw(schemaRef("app_mail"))}.messages m
                 WHERE m.conversation_id = ${record.id}::uuid AND m.direction = 'inbound'
                   AND COALESCE(m.sent_at, m.synced_at) >= ${at}::timestamptz
                   AND COALESCE(m.sent_at, m.synced_at) < ${at}::timestamptz + interval '1 millisecond'
                 LIMIT 1`,
        ),
      ),
    )
    const row = rows[0]
    if (!row) return { readable: false, quote: null }
    const quote = row.quote?.trim() ?? ""
    return { readable: true, quote: quote === "" ? null : quote }
  } catch (err) {
    log.warn({ err, record }, "send guard quote read failed; the card shows none")
    return { readable: false, quote: null }
  }
}

async function cardGuard(db: RlsClient, found: SendGuardVerdict): Promise<ApprovalSendGuard> {
  const { readable, quote } = await readableQuote(db, found)
  // A viewer who cannot open the message reads a third person only as "someone at <company>".
  const verdict = readable ? found : withoutThirdParty(found)
  return {
    state: verdict.state,
    ...(verdict.who !== undefined ? { who: verdict.who } : {}),
    ...(verdict.at ? { at: verdict.at } : {}),
    ...(verdict.holdUntil ? { holdUntil: verdict.holdUntil } : {}),
    ...(verdict.code ? { code: verdict.code } : {}),
    ...(verdict.label ? { label: verdict.label } : {}),
    ...(verdict.optedOut ? { optedOut: verdict.optedOut } : {}),
    ...(quote ? { quote } : {}),
    ...(readable && verdict.record ? { record: verdict.record } : {}),
    // Unnamed, the kind still says where it came in: "a reply came in on a ticket".
    ...(!readable && (verdict.record?.kind ?? verdict.source)
      ? { source: verdict.record?.kind ?? verdict.source }
      : {}),
  }
}

/** A stopped request's guard, as its send recorded it (the execution's error). */
async function readStoppedGuards(
  orgId: string,
  requestIds: string[],
): Promise<Map<string, SendGuardVerdict>> {
  const out = new Map<string, SendGuardVerdict>()
  if (requestIds.length === 0) return out
  const rows = await withPrivilegedDb(orgId, "approvals-list-send-guard", async (tx) =>
    extractRows<{ approval_request_id: string; verdict: unknown }>(
      await tx.execute(drizzleSql`
        SELECT DISTINCT ON (approval_request_id) approval_request_id, error->'guard' AS verdict
          FROM ${K}.approved_handler_executions
         WHERE org_id = ${orgId}::uuid
           AND approval_request_id IN (${drizzleSql.join(
             requestIds.map((id) => drizzleSql`${id}::uuid`),
             drizzleSql`, `,
           )})
           AND status = 'failed_no_effect'
         ORDER BY approval_request_id, finished_at DESC NULLS LAST`),
    ),
  )
  for (const row of rows) {
    const recorded = row.verdict
    if (!isObj(recorded) || typeof recorded.state !== "string") continue
    if (!GUARD_STATES.has(recorded.state as ApprovalSendGuard["state"])) continue
    out.set(row.approval_request_id, recorded as unknown as SendGuardVerdict)
  }
  return out
}

/**
 * The send check on each agent mail draft, computed now and never stored, so a hold that ended
 * reads as clear with no write. A pending draft is checked against the mail as it stands (no
 * providers at a list read; the single read asks them too); a closed one shows what its send
 * recorded. The check at send stays the authority.
 */
export type GuardRow = Pick<
  RawApprovalRow,
  "id" | "status" | "tool_name" | "current_payload" | "requested_by"
>

async function readSendGuards(
  db: RlsClient,
  orgId: string,
  rows: GuardRow[],
  at: "card" | "send",
): Promise<Map<string, ApprovalSendGuard>> {
  const out = new Map<string, ApprovalSendGuard>()
  for (const [id, verdict] of await readSendGuardVerdicts(orgId, rows, at)) {
    out.set(id, await cardGuard(db, verdict))
  }
  // A pending draft's recipients who are contacts, with what the composer would show
  // about them: the approver's send is theirs, whatever the mail is classified.
  // One read for every draft's recipients, however many drafts.
  const pending = rows.flatMap((row) => {
    const guard = out.get(row.id)
    if (!guard || row.status !== "pending") return []
    const payload = row.current_payload
    const addresses = recipientsOf(payload.to, payload.cc, payload.bcc).map((a) =>
      a.trim().toLowerCase(),
    )
    return [{ guard, addresses }]
  })
  if (pending.length === 0) return out
  const facts = new Map(
    (await recipientFacts(orgId, [...new Set(pending.flatMap((p) => p.addresses))])).map((f) => [
      f.email,
      f,
    ]),
  )
  for (const { guard, addresses } of pending) {
    const recipients = [...new Set(addresses)].flatMap((a) => {
      const fact = facts.get(a)
      return fact ? [fact] : []
    })
    if (recipients.length > 0) guard.recipients = recipients
  }
  return out
}

/**
 * When a pending mail draft's hold ends, if the send check reads it held now (an out-of-office
 * until a date); null for any other row. The expiry reads it so a held draft never lapses
 * before its hold is over.
 */
export async function readHeldUntil(orgId: string, row: GuardRow): Promise<Date | null> {
  const verdict = (await readSendGuardVerdicts(orgId, [row], "card")).get(row.id)
  if (verdict?.state !== "held" || !verdict.holdUntil) return null
  const until = new Date(verdict.holdUntil)
  return Number.isNaN(until.getTime()) ? null : until
}

async function readSendGuardVerdicts(
  orgId: string,
  rows: GuardRow[],
  at: "card" | "send",
): Promise<Map<string, SendGuardVerdict>> {
  const out = new Map<string, SendGuardVerdict>()
  const guarded = rows.filter(
    (r) => GUARDED_SENDS.has(r.tool_name) && isPinnedSendGuard(r.current_payload?.sendGuard),
  )
  if (guarded.length === 0) return out
  const closed = guarded.filter((r) => r.status !== "pending")
  const pending = guarded.filter((r) => r.status === "pending")
  for (const [id, verdict] of await readStoppedGuards(
    orgId,
    closed.map((r) => r.id),
  )) {
    out.set(id, verdict)
  }
  if (pending.length === 0) return out
  const zones = await personZones(
    orgId,
    pending.map((r) => r.requested_by),
  )
  const checks = pending.map((r) => {
    const payload = r.current_payload
    return {
      ...(zones.get(r.requested_by) ?? { locale: null, timeZone: null }),
      guard: payload.sendGuard as PinnedSendGuard,
      recipients: recipientsOf(payload.to, payload.cc, payload.bcc),
      toolName: r.tool_name,
    }
  })
  // One draft at a send asks the providers too; a list of drafts reads in shared queries.
  const verdicts =
    at === "send"
      ? await Promise.all(checks.map((c) => evaluateSendGuard({ ...c, orgId, at })))
      : await evaluateSendGuardsAtCard(orgId, checks)
  for (const [i, r] of pending.entries()) {
    const verdict = verdicts[i]
    if (verdict) out.set(r.id, verdict)
  }
  return out
}

/**
 * The send check on the agent mail drafts of Home's feed, as a card reads it: a held
 * draft is not on Home, one with a final state shows its reason uncounted.
 */
export function readFeedSendGuards(
  db: RlsClient,
  orgId: string,
  rows: GuardRow[],
): Promise<Map<string, ApprovalSendGuard>> {
  return readSendGuards(db, orgId, rows, "card")
}

/**
 * The send check's state alone on each draft, for the badge every push counts: no quote and no
 * record read, and a number of queries that does not grow with the drafts.
 */
export async function readFeedSendGuardStates(
  orgId: string,
  rows: GuardRow[],
): Promise<Map<string, ApprovalSendGuard["state"]>> {
  const out = new Map<string, ApprovalSendGuard["state"]>()
  for (const [id, verdict] of await readSendGuardVerdicts(orgId, rows, "card")) {
    out.set(id, verdict.state)
  }
  return out
}

/** A guard state that ends a draft: nothing it says can still go out as written. */
export function isFinalSendGuardState(state: ApprovalSendGuard["state"]): boolean {
  return state === "replied" || state === "bounced" || state === "opted_out" || state === "ref_stop"
}

/** Compact pending-approval descriptor for agent-context injection. */
export interface EntityPendingApproval {
  id: string
  toolName: string
  title: string
  /** Who asked (`readApprovalRequesters`): the agent, or the person. */
  requesterName: string
  createdAt: string
  editableFields: string[]
}

/**
 * Pending approval requests that REFERENCE any of the given entity ids —
 * generically, across every app: a gated tickets:reply carries `ticketId` in
 * its tool_params, a mail:reply carries `conversationId`, a boxtal shipment
 * carries an order/shipment id, a summary may link the entity. Rather than
 * enumerating per-tool param keys (the ticket/conversation modes above do,
 * and every new gated tool would need wiring), match the entity UUID anywhere
 * in tool_params / current_payload / summary. UUIDs are collision-safe as
 * substrings, so a text containment match is exact in practice.
 *
 * Used by the agent context assembler to surface "this entity already has a
 * queued draft" when the user is viewing (or referencing) an entity — the
 * recurring field failure is the agent re-running the original gated tool and
 * stacking a DUPLICATE approval instead of editing the pending one.
 *
 * Visibility boundary: the caller must only pass entity ids the actor has
 * ALREADY resolved under RLS (the context assembler only forwards entities
 * whose snippet loaded). Given the actor can read the entity, its queued
 * gated actions are surfaced — same "if you can read the surface, you can see
 * its drafts" boundary as the ticket/conversation modes — EXCEPT personally-
 * routed approvals (resource_owner_id set), which stay requester/owner-only.
 */
export async function listPendingApprovalsForEntities(
  db: RlsClient,
  args: { orgId: string; userId: string; entityIds: string[] },
): Promise<EntityPendingApproval[]> {
  const ids = [...new Set(args.entityIds)].filter(Boolean)
  if (ids.length === 0) return []

  const matchClauses = drizzleSql.join(
    ids.map(
      (id) => drizzleSql`(
        tool_params::text LIKE ${`%${id}%`}
        OR current_payload::text LIKE ${`%${id}%`}
        OR summary::text LIKE ${`%${id}%`}
      )`,
    ),
    drizzleSql` OR `,
  )

  const rows = extractRows<
    Pick<
      RawApprovalRow,
      "id" | "tool_name" | "summary" | "requested_by" | "resource_owner_id" | "created_at"
    >
  >(
    await db.execute(drizzleSql`
      SELECT id, tool_name, summary, requested_by, resource_owner_id, created_at
      FROM ${K}.approval_requests
      WHERE org_id = ${args.orgId}
        AND status = 'pending'
        AND (${matchClauses})
      ORDER BY created_at DESC
      LIMIT 20
    `),
  )

  const visible = rows.filter(
    (r) =>
      !r.resource_owner_id || r.requested_by === args.userId || r.resource_owner_id === args.userId,
  )
  if (visible.length === 0) return []

  const requesters = await readApprovalRequesters(
    db,
    args.orgId,
    visible.map((r) => r.id),
  )

  return visible.map((r) => {
    const { appName, toolShortName } = splitToolName(r.tool_name)
    const editableFields =
      approvalEditableFieldsRegistry.get([args.orgId, appName, toolShortName]) ?? []
    return {
      id: r.id,
      toolName: r.tool_name,
      title: r.summary?.title ?? r.tool_name,
      requesterName: (requesters.get(r.id) ?? pickApprovalRequester(null, null, r.requested_by))
        .name,
      createdAt: new Date(r.created_at).toISOString(),
      editableFields: editableFields.map((f) => f.field),
    }
  })
}

export async function getApproval(
  db: RlsClient,
  args: {
    orgId: string
    userId: string
    requestId: string
    /** The card's surface: an agent mail draft carries the send check, providers asked too. */
    sendGuards?: boolean
  },
): Promise<ApprovalRequestSummary | null> {
  const rows = extractRows<RawApprovalRow>(
    await db.execute(drizzleSql`
      SELECT id, handle, status, created_at, expires_at, tool_name, approve_scope, summary, current_payload,
             thread_id, originating_thread_id, requested_by, notify_user_ids,
             decided_by, decided_at, reason, bundle_id, bundle_position, depends_on_id,
             resource_owner_id, agent_id, metadata
      FROM ${K}.approval_requests WHERE id = ${args.requestId}
    `),
  )
  if (rows.length === 0) return null
  const [r] = await withServedSummaries(db, args.orgId, [rows[0]!])
  if (!r) return null
  const [decider] = r.decided_by
    ? extractRows<{ name: string }>(
        await db.execute(drizzleSql`SELECT name FROM ${K}.users WHERE id = ${r.decided_by}`),
      )
    : [undefined]
  const lastEdit = (await readLastPayloadEdits(db, args.orgId, [r.id])).get(r.id) ?? null
  const { appName, toolShortName } = splitToolName(r.tool_name)
  const editableFields =
    approvalEditableFieldsRegistry.get([args.orgId, appName, toolShortName]) ?? []
  const lastFailure = await withPrivilegedDb(args.orgId, "approval-get-last-failure", (tx) =>
    readApprovalLastFailure(tx, args.orgId, r.id),
  )
  const built = buildApprovalSummary({
    raw: r,
    requester: await readApprovalRequester(db, args.orgId, r.id, r.requested_by),
    decidedByName: decider?.name ?? null,
    editableFields,
    lastEdit,
    lastFailure,
  })
  const guard = args.sendGuards
    ? (await readSendGuards(db, args.orgId, [r], "send")).get(r.id)
    : undefined
  const summary = guard ? { ...built, sendGuard: guard } : built
  const [shown] = await revealManagedApprovalSummaries([summary], args.orgId, args.userId)
  return shown ?? summary
}
