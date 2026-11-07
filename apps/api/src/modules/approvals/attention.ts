// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  APPROVING_WEDGE_GRACE_MS,
  type ApprovalRoute,
  type ApprovalSendGuard,
  type AttentionItem,
  appApprovesFromHome,
  type HomePlacement,
  homePlacement,
  isPeerSelfApprovable,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { apiViewer, authorityFacts, canSeeInFeed } from "~/modules/approvals/authority"
import { humanizeToolName, splitToolName } from "~/modules/approvals/event-data"
import { readApprovalLastFailures } from "~/modules/approvals/last-failure"
import {
  isFinalSendGuardState,
  readFeedSendGuardStates,
  readFeedSendGuards,
} from "~/modules/approvals/list"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { approvalActionPhrase, deriveApprovalDetail } from "~/modules/approvals/payload-title"
import { readApprovalRequesters } from "~/modules/approvals/requester"
import { type RoutedRows, readApprovalRoutes } from "~/modules/approvals/route-world"
import { withServedSummaries } from "~/modules/approvals/served-summary"
import { toolRegistry } from "~/modules/apps/app-registries"
import { sendGuardProviderPill } from "~/modules/mail/send-guard"
import { isSeededWrite } from "~/modules/notifications/seeded"

const K = drizzleSql.raw(schemaRef("kernel"))

/** The first in-app `{label, app, entityType, entityId}` link of a summary, as the row's open link. */
function firstEntityLink(
  links: unknown,
): { label: string; app: string; entity: string; entityId: string } | null {
  if (!Array.isArray(links)) return null
  for (const l of links) {
    if (!l || typeof l !== "object") continue
    const { label, app, entityType, entityId } = l as Record<string, unknown>
    if (
      typeof label === "string" &&
      typeof app === "string" &&
      typeof entityType === "string" &&
      typeof entityId === "string" &&
      label &&
      app &&
      entityType &&
      entityId
    )
      return { label, app, entity: entityType, entityId }
  }
  return null
}

interface PendingApprovalRow {
  id: string
  handle: string
  summary: {
    title?: string
    subtitle?: string
    lines?: unknown
    impact?: "external" | "internal"
    ref?: string
    links?: unknown
  } | null
  tool_name: string
  status: string
  metadata: {
    ambiguousAt?: string
    ambiguousError?: string
    originRoutineId?: string
    minApprovers?: number
    approvedBy?: string[]
  } | null
  created_at: Date | string
  expires_at: Date | string
  notify_user_ids: string[]
  requested_by: string
  bundle_id: string | null
  /** The row's OWN decision scope. Dimension-constrained approvals (skills) set
   *  this to something other than `<app>:approve`, so it must never be
   *  recomputed from the tool name. */
  approve_scope: string | null
  /** Ownership-routed privacy: when set, only this user may see or decide it. */
  resource_owner_id: string | null
  current_payload: Record<string, unknown> | null
  /** The conversation the request was raised in (where its card shows). */
  originating_thread_id: string | null
  /** The person on the item, read only to route the row (route-world.ts). */
  route_person_id: string | null
}

/** One step of a bundle, as the row names it. */
interface BundleStepRow {
  tool_name: string
  summary: PendingApprovalRow["summary"]
  current_payload: Record<string, unknown> | null
}

/** A bundle's last step (its outcome), how many steps it has, and every step in order. */
interface BundleOutcome extends BundleStepRow {
  cnt: number
  steps: BundleStepRow[]
  /** Later steps run off earlier ones. A parallel bundle (independent
   *  requests, each decided on its own) has no single outcome to name. */
  sequenced: boolean
}

/**
 * The row's pill: a send-guard provider's for the first ref's kind ("Billing: payment reminder"),
 * else the tool's manifest `approvalCard.pill`, else none (the client names the action as before).
 */
function approvalRowPill(
  orgId: string,
  toolName: string,
  payload: Record<string, unknown> | null,
): { label: string; labelKey?: string } | undefined {
  const guard = payload?.sendGuard as { refs?: unknown } | undefined
  const first = Array.isArray(guard?.refs) ? (guard.refs[0] as { kind?: unknown }) : undefined
  if (first && typeof first.kind === "string") {
    const pill = sendGuardProviderPill(orgId, first.kind)
    if (pill) return pill
  }
  const { appName, toolShortName } = splitToolName(toolName)
  const pill = toolRegistry.get([orgId, appName, toolShortName])?.approvalCard?.pill
  return pill && typeof pill.label === "string" && pill.label.length > 0 ? pill : undefined
}

/**
 * The send check on each agent mail draft of the feed or badge. A failed read is a row without
 * its guard line, never a failed feed.
 */
async function readGuardsQuietly(
  tx: RlsClient,
  orgId: string,
  rows: Array<{
    id: string
    status: string
    tool_name: string
    current_payload: Record<string, unknown> | null
    requested_by: string
  }>,
): Promise<Map<string, ApprovalSendGuard>> {
  const guarded = rows.filter((r) => r.status === "pending" && r.current_payload?.sendGuard)
  if (guarded.length === 0) return new Map()
  try {
    return await readFeedSendGuards(
      tx,
      orgId,
      guarded.map((r) => ({
        id: r.id,
        status: "pending" as const,
        tool_name: r.tool_name,
        current_payload: r.current_payload ?? {},
        requested_by: r.requested_by,
      })),
    )
  } catch (err) {
    log.warn({ err, orgId }, "could not read the send check for the attention feed")
    return new Map()
  }
}

/** The send check's state alone on each pending agent mail draft, as the badge counts it. */
async function readGuardStatesQuietly(
  orgId: string,
  rows: Array<{
    id: string
    status: string
    tool_name: string
    current_payload: Record<string, unknown> | null
    requested_by: string
  }>,
): Promise<Map<string, ApprovalSendGuard["state"]>> {
  const guarded = rows.filter((r) => r.status === "pending" && r.current_payload?.sendGuard)
  if (guarded.length === 0) return new Map()
  try {
    return await readFeedSendGuardStates(
      orgId,
      guarded.map((r) => ({
        id: r.id,
        status: "pending" as const,
        tool_name: r.tool_name,
        current_payload: r.current_payload ?? {},
        requested_by: r.requested_by,
      })),
    )
  } catch (err) {
    log.warn({ err, orgId }, "could not read the send check for the badge")
    return new Map()
  }
}

/**
 * The name a request reads under: its summarizer's own title, else the action
 * and the thing the payload names, else the action in words. HOW it was made
 * rides along so the reader's client can say it in the reader's language.
 */
function approvalRowName(
  row: BundleStepRow,
  skillNamesById: Record<string, string>,
): {
  authored: string | null
  titleDetail: string | null
  titleKind: "summary" | "derived" | "action"
  title: string
} {
  const authored =
    row.summary?.title && row.summary.title !== row.tool_name ? row.summary.title : null
  const titleDetail = authored
    ? null
    : deriveApprovalDetail(row.tool_name, row.current_payload, { skillNamesById })
  const titleKind = authored ? "summary" : titleDetail ? "derived" : "action"
  const title =
    authored ??
    (titleDetail
      ? `${approvalActionPhrase(row.tool_name)}: ${titleDetail}`
      : humanizeToolName(row.tool_name))
  return { authored, titleDetail, titleKind, title }
}

async function readCurrentScopes(tx: RlsClient): Promise<string[]> {
  try {
    const result = await tx.execute(drizzleSql`SELECT rls_ctx.scopes() AS scopes`)
    const row = extractRows<{ scopes: string | null }>(result)[0]
    if (!row?.scopes) return []
    if (row.scopes === "*") return ["*"]
    return row.scopes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Resolve a pending approval's blast-radius classification. Precedence:
 *   1. summary.impact — the per-call override a summarizer froze on the row
 *      at gate time (it saw the actual params, e.g. a tickets close WITH a
 *      body emails the customer even though a silent close is internal);
 *   2. the LIVE registered tool metadata (manifest `approvalImpact`) — not
 *      frozen on the row, so a manifest re-classification reflects
 *      immediately;
 *   3. "external" — fail-safe for an unresolvable app/tool or an undeclared
 *      field: nothing risky may read as safe.
 * Cheap in-memory lookup, and it must never take the feed down.
 */
function resolveApprovalImpact(
  orgId: string,
  appName: string,
  toolShortName: string,
  summaryImpact?: "external" | "internal",
): "external" | "internal" {
  if (summaryImpact === "internal" || summaryImpact === "external") return summaryImpact
  try {
    const tool = toolRegistry.get([orgId, appName, toolShortName])
    return tool?.approvalImpact === "internal" ? "internal" : "external"
  } catch {
    return "external"
  }
}

/**
 * Whether this tool's approval must be decided FROM THE RECORD, not from a feed
 * row. A ticket reply goes to a customer and the reviewer cannot judge it
 * without the conversation in front of them, so its card offers only "Open
 * ticket" outside the ticket itself.
 *
 * Declared per tool (`decideInContext` in the manifest) rather than matched on
 * a tool name, so the next surface that needs it just sets the flag. Resolved
 * from the LIVE registry like approvalImpact, so a re-classification takes
 * effect without rewriting frozen rows. Fails OPEN (decidable) on an
 * unresolvable tool: this is a deliberate-review affordance, not a security
 * boundary, and a registry gap must not strand a pending approval.
 */
function resolveDecideInContext(orgId: string, appName: string, toolShortName: string): boolean {
  try {
    return toolRegistry.get([orgId, appName, toolShortName])?.decideInContext === true
  } catch {
    return false
  }
}

/**
 * The apps, among `appNames`, whose decide-in-context approvals the org opted
 * OUT of it (`settings.<app>.approveRepliesFromHome`, default off): such an
 * approval is decidable from its feed row like any other. Read privileged:
 * `kernel.organizations` is not readable under RLS. An unreadable setting is
 * the default (off), so the row keeps its "Open" behaviour.
 */
async function readAppsApprovingFromHome(
  orgId: string,
  appNames: Set<string>,
): Promise<Set<string>> {
  try {
    return await withPrivilegedDb(orgId, "attention-approve-from-home", async (tx) => {
      const rows = extractRows<{ settings: unknown }>(
        await tx.execute(
          drizzleSql`SELECT settings FROM ${K}.organizations WHERE id = ${orgId}::uuid`,
        ),
      )
      const raw = rows[0]?.settings
      const settings = typeof raw === "string" ? JSON.parse(raw) : raw
      return new Set([...appNames].filter((app) => appApprovesFromHome(settings, app)))
    })
  } catch (err) {
    log.warn({ err, orgId }, "could not read the approve-from-home settings; using the default")
    return new Set()
  }
}

/** The facts the feed's "this person decides it" rule reads off a request row. */
type DecidableApprovalRow = Pick<
  PendingApprovalRow,
  | "id"
  | "tool_name"
  | "status"
  | "metadata"
  | "notify_user_ids"
  | "requested_by"
  | "approve_scope"
  | "resource_owner_id"
  | "route_person_id"
>

/**
 * Whether a request is in the caller's feed as THEIR decision: the feed's
 * visibility rule, minus a two-approver request they already signed off
 * (decide.ts refuses a second sign-off). A STALLED one stays: every row the
 * feed query returns at `approving` is a dead execution, and the people who
 * signed it are exactly who must see it.
 */
function isCallersDecision(
  r: DecidableApprovalRow,
  callerUserId: string,
  callerScopes: string[],
): boolean {
  if (!canSeeApprovalInFeed(r, callerUserId, callerScopes)) return false
  const stalled = r.status === "approving"
  const signedOff = r.metadata?.approvedBy
  return stalled || !(Array.isArray(signedOff) && signedOff.includes(callerUserId))
}

/**
 * Home's peer-noise flag for one row (`metadata.peerSelfApprovable` on the feed item): another
 * person raised it and can decide it themselves. When two people both hold the deciding scope,
 * every request each raises lands in the other's feed though the requester routinely approves
 * their own. Whether the requester decides it is not persisted, so `readApprovalRoutes` reads it
 * in the same one query as the route, with the predicate `hasScope` and the select policy use.
 * Under a two-approver policy the requester never finishes it alone, so it is never noise.
 */
function rowIsPeerSelfApprovable(
  r: DecidableApprovalRow,
  callerUserId: string,
  routes: RoutedRows,
): boolean {
  return isPeerSelfApprovable(
    {
      requestedById: r.requested_by,
      originRoutineId: r.metadata?.originRoutineId ?? null,
      requesterCanDecide: routes.requesterDecides(r.id),
    },
    callerUserId,
  )
}

/** Where a row sits on this viewer's Home (shared `homePlacement`). */
function rowPlacement(
  r: DecidableApprovalRow,
  route: ApprovalRoute,
  callerUserId: string,
  callerScopes: string[],
): HomePlacement {
  return homePlacement(authorityFacts(r), route, apiViewer(callerUserId, callerScopes))
}

/** The feed's predicate over `approval_requests ar`: pending, or approving and dead. */
const FEED_STATUS_SQL = drizzleSql`(
  ar.status = 'pending'
  OR (
    ar.status = 'approving'
    AND (
      ar.approving_started_at
        < now() - make_interval(secs => ${APPROVING_WEDGE_GRACE_MS / 1000}::double precision)
      OR ar.metadata ? 'ambiguousAt'
    )
  )
)`

/**
 * THE APPROVALS IN THE BADGE (rule 6), as few facts as the shared `countBadge`
 * needs: one item per request in the caller's feed as their decision, with
 * Home's peer-noise flag, so `countBadge` folds exactly what Home folds. A
 * bounded read (at most `limit` rows, the deciding columns only, no
 * summaries, bundles or failures): it runs per recipient on every push. The
 * rows are narrowed in SQL to the ones addressed to the caller (an owner's,
 * or a notified person's), the same audience gate `canSeeApprovalInFeed`
 * then applies with the scope check.
 */
export async function computeApprovalBadgeItems(
  tx: RlsClient,
  orgId: string,
  callerUserId: string,
  limit: number,
): Promise<
  Array<{
    kind: "approval_pending"
    entity: string
    entityId: string
    metadata: { peerSelfApprovable: boolean; placement: HomePlacement }
  }>
> {
  const callerScopes = await readCurrentScopes(tx)
  const rows = extractRows<DecidableApprovalRow & Pick<PendingApprovalRow, "current_payload">>(
    await tx.execute(drizzleSql`
      SELECT ar.id, ar.tool_name, ar.status, ar.metadata, ar.notify_user_ids,
             ar.requested_by, ar.approve_scope, ar.resource_owner_id, ar.route_person_id,
             CASE WHEN ar.current_payload ? 'sendGuard' THEN ar.current_payload END AS current_payload
      FROM ${K}.approval_requests ar
      WHERE ar.org_id = ${orgId}
        AND ${FEED_STATUS_SQL}
        AND (
          ar.resource_owner_id = ${callerUserId}::uuid
          OR (ar.resource_owner_id IS NULL
              AND ar.notify_user_ids @> ARRAY[${callerUserId}::uuid])
        )
      ORDER BY ar.created_at DESC
      LIMIT ${limit}
    `),
  ).filter((r) => isCallersDecision(r, callerUserId, callerScopes))
  // As on Home: a held draft, or one that can no longer go out as written, is not counted.
  // The state alone, read for every draft in shared queries: this runs on every push.
  const states = await readGuardStatesQuietly(orgId, rows)
  const counted = rows.filter((r) => {
    const state = states.get(r.id)
    return state === undefined || (state !== "held" && !isFinalSendGuardState(state))
  })
  const routes = await readApprovalRoutes(tx, orgId, counted)
  return counted.map((r) => {
    const placement = rowPlacement(r, routes.route(r.id), callerUserId, callerScopes)
    return {
      kind: "approval_pending" as const,
      entity: "approval_request",
      entityId: r.id,
      metadata: {
        // A row for someone else is never this person's ask, also for a client that
        // predates `placement` and reads the peer flag alone.
        peerSelfApprovable:
          placement === "others" || rowIsPeerSelfApprovable(r, callerUserId, routes),
        placement,
      },
    }
  })
}

/**
 * Whether `caller` may SEE this pending approval in their attention feed.
 *
 * Pure and exported so the rule is testable without a database: it is the rule
 * that broke in prod (2026-08-06), where three pending kernel:update_skill
 * approvals were listed by approvals_list yet invisible in every feed.
 *
 * Two things it must get right, each of which independently hid those rows:
 *  - the DECISION SCOPE is the row's own `approve_scope`. Recomputing
 *    `<app>:approve` asks for `kernel:approve` on a skill approval, an
 *    admin-grade scope the actual approvers deliberately do not hold.
 * The audience gate (`notify_user_ids`) is deliberately UNCHANGED: it is what
 * keeps one desk's approvals out of another approver's feed, and widening it to
 * "anyone who could decide" floods every tickets:approve holder with every
 * ticket reply. So a decider who was never notified still does not see the row;
 * that is a routing question, not a rendering one.
 * Ownership routing wins over both: an owner-routed approval is private.
 *
 * The rule itself lives in the shared authority module (`canSeeInFeed`,
 * packages/shared/src/approvals/authority.ts) — this export is the DB-row-shaped
 * entry point kept for its callers and tests. Do not add logic here.
 */
export function canSeeApprovalInFeed(
  row: {
    tool_name: string
    approve_scope: string | null
    resource_owner_id: string | null
    notify_user_ids: string[] | null
    requested_by: string
  },
  callerUserId: string,
  callerScopes: string[],
): boolean {
  return canSeeInFeed(authorityFacts(row), apiViewer(callerUserId, callerScopes))
}

export async function computeApprovalAttentionItems(
  tx: RlsClient,
  orgId: string,
  callerUserId: string,
): Promise<AttentionItem[]> {
  const callerScopes = await readCurrentScopes(tx)
  // WEDGED EXECUTIONS BELONG IN THE FEED. A row stuck at `approving` past the
  // grace window is a DEAD execution: the human already approved it, the claim
  // committed, then the handler never finished (a container recreate mid-deploy
  // kills in-flight handlers — 8 rows wedged this way on prod across the
  // 2026-07-16/20/22 deploys, some with no `approved_handler_executions` row at
  // all, some stuck at `started` with no error). The approving reaper flags such
  // a row but DELIBERATELY leaves it in place for a human to decide, and
  // `list.ts` surfaces it so a decide can reach `healWedgedApproving`.
  //
  // This feed queried `status = 'pending'` only, so it showed none of them — the
  // one surface a human actually looks at was blind to precisely the rows that
  // need a human. They sat 12-19 days: a role grant that never applied, a
  // shipping label never bought, five HS codes never written. Matching the
  // list.ts predicate here closes that hole.
  const result = await tx.execute(drizzleSql`
    SELECT ar.id, ar.handle, ar.summary, ar.tool_name, ar.status, ar.metadata, ar.created_at, ar.expires_at,
           ar.notify_user_ids, ar.bundle_id, ar.approve_scope, ar.resource_owner_id, ar.requested_by,
           ar.current_payload, ar.originating_thread_id, ar.route_person_id
    FROM ${K}.approval_requests ar
    WHERE ar.org_id = ${orgId}
      AND (
        ar.status = 'pending'
        OR (
          ar.status = 'approving'
          AND (
            ar.approving_started_at
              < now() - make_interval(secs => ${APPROVING_WEDGE_GRACE_MS / 1000}::double precision)
            -- ...OR we ALREADY KNOW it failed. The grace window exists only to
            -- avoid showing an execution that is genuinely still running; a row
            -- whose handler came back ambiguous is not running, it is dead. Without
            -- this clause a failed approval is invisible for a full 10 minutes
            -- after the operator clicks Approve -- it simply vanishes from the
            -- queue and reads as success. That silence is the whole bug.
            OR ar.metadata ? 'ambiguousAt'
          )
        )
      )
  `)
  // A ticket approval's ref follows the ticket's current display handle.
  const rows = await withServedSummaries(tx, orgId, extractRows<PendingApprovalRow>(result))
  const requesters = await readApprovalRequesters(
    tx,
    orgId,
    rows.map((r) => r.id),
  )

  const routes = await readApprovalRoutes(tx, orgId, rows)

  // Per-bundle step count and OUTCOME step, built once (avoids N+1 when
  // several bundles pend). A bundle's head is its FIRST step (a CRM write), so
  // titling the row from the head read "Run create_contact on crm, 3 steps" for
  // what is really a quote reply to a customer. The row names the bundle by its
  // LAST step instead -- what the person approving actually brings about -- and
  // the expanded card still lists every step under its own title.
  const bundleOutcomes = new Map<string, BundleOutcome>()
  const headBundleIds = [...new Set(rows.filter((r) => r.bundle_id === r.id).map((r) => r.id))]
  if (headBundleIds.length > 0) {
    // Every step, in order: the outcome is the last, and a sequence's row also
    // says what happens in order (`bundleSequence`).
    const stepRows = extractRows<BundleStepRow & { bundle_id: string; has_dep: boolean }>(
      await tx.execute(drizzleSql`
        SELECT bundle_id, tool_name, summary, current_payload,
               depends_on_id IS NOT NULL AS has_dep
        FROM ${K}.approval_requests
        WHERE org_id = ${orgId}
          AND bundle_id IN (${drizzleSql.join(
            headBundleIds.map((id) => drizzleSql`${id}::uuid`),
            drizzleSql`, `,
          )})
        ORDER BY bundle_id, bundle_position ASC NULLS FIRST, created_at ASC`),
    )
    const byBundle = new Map<string, Array<BundleStepRow & { has_dep: boolean }>>()
    for (const s of stepRows) {
      const list = byBundle.get(s.bundle_id) ?? []
      list.push(s)
      byBundle.set(s.bundle_id, list)
    }
    for (const [bundleId, steps] of byBundle) {
      const last = steps[steps.length - 1]
      if (!last) continue
      bundleOutcomes.set(bundleId, {
        tool_name: last.tool_name,
        summary: last.summary,
        current_payload: last.current_payload,
        cnt: steps.length,
        sequenced: steps.some((s) => s.has_dep === true),
        steps: steps.map(({ tool_name, summary, current_payload }) => ({
          tool_name,
          summary,
          current_payload,
        })),
      })
    }
  }

  // A skill approval's payload carries the skill's uuid and nothing readable,
  // so the names come from the skills table -- once, for every such row in this
  // feed, rather than per row.
  const skillIds = new Set<string>()
  for (const r of [...rows, ...[...bundleOutcomes.values()].flatMap((o) => o.steps)]) {
    if (!r.summary?.title && /^kernel:\w*_?skill$/.test(r.tool_name)) {
      const id = r.current_payload?.id
      if (typeof id === "string") skillIds.add(id)
    }
  }
  const skillNamesById: Record<string, string> = {}
  if (skillIds.size > 0) {
    try {
      const skillRows = extractRows<{ id: string; name: string }>(
        await tx.execute(
          drizzleSql`SELECT id, name FROM ${K}.skills
                     WHERE org_id = ${orgId} AND id IN (${drizzleSql.join(
                       [...skillIds].map((id) => drizzleSql`${id}::uuid`),
                       drizzleSql`, `,
                     )})`,
        ),
      )
      for (const row of skillRows) skillNamesById[row.id] = row.name
    } catch {
      // A name we could not read is a less specific title, never a failed feed.
    }
  }

  // Read once, and only when a decide-in-context approval is in the feed at all.
  const decideInContextApps = new Set<string>()
  for (const r of rows) {
    const { appName, toolShortName } = splitToolName(r.tool_name)
    if (resolveDecideInContext(orgId, appName, toolShortName)) decideInContextApps.add(appName)
  }
  const approveFromHomeApps =
    decideInContextApps.size > 0
      ? await readAppsApprovingFromHome(orgId, decideInContextApps)
      : new Set<string>()

  // WHY THE LAST APPROVE FAILED, on the row itself. A handler that failed with
  // no effect reverts the request to pending; the expanded card reads the cause
  // from the approval (list.ts), but a row decided from the feed without opening
  // its card had only the transient toast, so once it faded the row read as a
  // fresh request. Same single source as the card: approved_handler_executions.
  let lastFailures = new Map<string, { code: string; message: string; at: string }>()
  if (rows.length > 0) {
    try {
      lastFailures = await withPrivilegedDb(orgId, "approval-attention-last-failure", (ptx) =>
        readApprovalLastFailures(
          ptx,
          orgId,
          rows.map((r) => r.id),
        ),
      )
    } catch (err) {
      // A failure we could not read is a row without its banner, never a failed feed.
      log.warn({ err, orgId }, "could not read approval last failures for the attention feed")
    }
  }

  // A held draft (an out-of-office until a date) is not on Home until its hold ends; that is
  // read fresh each time, so the row comes back with no write. A draft whose check says it can
  // no longer go out as written shows why, and is not counted.
  const guards = await readGuardsQuietly(tx, orgId, rows)
  const routeNames = await readRouteNames(tx, orgId, callerUserId, rows, routes)

  const items: AttentionItem[] = []
  for (const r of rows) {
    const { appName, toolShortName } = splitToolName(r.tool_name)
    // In the feed as THEIR decision (a two-approver request they already
    // signed off waits for someone else and leaves it; a stalled one stays).
    if (!isCallersDecision(r, callerUserId, callerScopes)) continue
    const guard = guards.get(r.id)
    if (guard?.state === "held") continue

    // A wedged row is NOT a fresh decision: it was already approved and its
    // execution died. It outranks any pending item (the work is half-done and
    // has been silently stalled for as long as nobody looked) and its
    // expiry countdown is meaningless, so it never takes the expiry bump.
    const wedged = r.status === "approving"
    const route = routes.route(r.id)
    const placement = rowPlacement(r, route, callerUserId, callerScopes)

    // THE ROW'S NAME. The author's summary title wins; a missing one (no
    // registered summarizer, a summarizer that threw, a row written outside
    // executeTool) used to fall straight through to `humanizeToolName`, which
    // is byte-identical to the action badge the row already renders beside the
    // title -- so the row deduplicated the two and showed NO title at all. The
    // payload names the thing being acted on, and it is tried first.
    //
    // HOW the name was made rides along (`titleKind`, `titleDetail`), so the
    // reader's client can say it in the reader's language: the action words are
    // the product's, only a summarizer's own title and the payload detail are
    // data. The "Stalled: " prefix stays out of `baseTitle` for the same reason.
    // WHAT THE ROW SHOWS. A bundle head shows its outcome (the bundle's last
    // step): title, action chip, who/what, lines and link. The decision itself
    // (approval id, payload hash, decide-in-context) stays the head's.
    const outcome = r.bundle_id === r.id ? bundleOutcomes.get(r.id) : undefined
    const isSequence = Boolean(outcome && outcome.cnt > 1 && outcome.sequenced)
    const shown = isSequence && outcome ? outcome : r
    const { titleDetail, titleKind, title: rowTitle } = approvalRowName(shown, skillNamesById)

    const expiresMs = new Date(r.expires_at).getTime() - Date.now()
    let urgency = 60
    if (wedged) urgency = 95
    else if (expiresMs <= 60 * 60 * 1000) urgency = Math.min(90, urgency + 20)

    items.push({
      id: `kernel:approval_pending:${r.id}`,
      app: "kernel",
      entity: "approval_request",
      entityId: r.id,
      kind: "approval_pending",
      // A raw tool id must never surface as a tile title. Prefer the author's
      // summary title, but if it is missing (or is itself the bare tool id,
      // which some gated tools store verbatim), fall back to the humanized
      // action label ("Invoicing: mark document paid").
      summary: wedged ? `Stalled: ${rowTitle}` : rowTitle,
      urgency,
      occurredAt: new Date(r.created_at).toISOString(),
      action: {
        type: "decide_approval",
        approvalId: r.id,
        payloadHash: approvalPayloadHash(r.tool_name, r.current_payload),
      },
      metadata: {
        toolName: r.tool_name,
        // The tool the row is NAMED after, when that is not the gated tool
        // itself: a bundle head's outcome step. The chip and the title read it;
        // everything that acts on the request keeps using `toolName`.
        ...(shown !== r ? { outcomeToolName: shown.tool_name } : {}),
        appName,
        // The `request-N` label. Agents cite approvals by handle/uuid in chat;
        // the collapsed feed row printed neither, so a reviewer told "approve
        // request-42" had to expand every row to find it.
        requestHandle: r.handle,
        // Where the request was raised: a person reading that conversation has
        // seen its card, so the router holds the interrupt back (rule 1).
        ...(r.originating_thread_id ? { originatingThreadId: r.originating_thread_id } : {}),
        // A seed's approval notifies nobody (notifications/seeded.ts).
        ...(isSeededWrite(r.metadata) ? { seeded: true } : {}),
        // What ACTION is gated ("Tickets: reply") + how risky it is, so the
        // feed row is decidable at a glance without expanding the card.
        actionLabel: humanizeToolName(shown.tool_name),
        ...(() => {
          const pill = approvalRowPill(orgId, shown.tool_name, shown.current_payload)
          return pill ? { pill } : {}
        })(),
        ...(guard ? { sendGuard: guard } : {}),
        ...(guard && isFinalSendGuardState(guard.state) ? { uncounted: true as const } : {}),
        // WHO/WHAT this acts on ("Reply to Alex Martin on ticket-10013",
        // "Ship draft ... to a dealer"). The summarizers have always
        // written it; the feed just never carried it, so a row led with the
        // ACTION and the ENTITY -- the least useful ordering for the person
        // deciding, who needs to know who it reaches before what it is called
        // (ticket-10176: "add the customer name to the approval cards").
        ...(typeof shown.summary?.subtitle === "string" && shown.summary.subtitle.length > 0
          ? { subtitle: shown.summary.subtitle }
          : {}),
        // WHICH record, by the id people use (`ticket-B2B-123`): the row
        // renders it first, as the card does.
        ...(typeof shown.summary?.ref === "string" && shown.summary.ref.length > 0
          ? { ref: shown.summary.ref.slice(0, 40) }
          : {}),
        // WHAT changes, in the summarizer's own words ("Label -> Idea",
        // "Priority: high", "Amount: 120 EUR"). The feed row showed the title
        // and the project name and nothing else, so "Update status column:
        // backlog" had to be expanded to learn what it would become.
        ...(Array.isArray(shown.summary?.lines) && shown.summary.lines.length > 0
          ? {
              summaryLines: shown.summary.lines
                .filter((l): l is string => typeof l === "string" && l.length > 0)
                .slice(0, 8),
            }
          : {}),
        // WHERE the item lives (the ticket, the mail thread, the invoice):
        // the summary's first in-app link, so the row offers "Open" next to
        // its decision like the expanded card does.
        ...(() => {
          const openLink = firstEntityLink(shown.summary?.links)
          return openLink ? { openLink } : {}
        })(),
        // Who asked: the agent, or the person (modules/approvals/requester.ts).
        ...(requesters.get(r.id)?.name ? { requesterName: requesters.get(r.id)?.name } : {}),
        requestedById: r.requested_by,
        // Peer noise: another person's request that they could have approved
        // themselves. The feed hides these BY DEFAULT (a display default, never
        // a permission — the row stays decidable and shows with the filter off).
        // A row for someone else ("For others, you can also approve") folds the same way, so a
        // client that predates `placement` counts and pushes it as it always has.
        peerSelfApprovable:
          placement === "others" || rowIsPeerSelfApprovable(r, callerUserId, routes),
        // Whose the row is, and where it sits on this viewer's Home.
        route,
        placement,
        // The names Home's "why" line says, for a row routed to a person or with a blocked stand-in.
        ...(() => {
          const line = routeLineOf(route, routeNames)
          return line ? { routeLine: line } : {}
        })(),
        // A bundle reads as external when any end of it is (the chip shows the outcome).
        approvalImpact:
          shown !== r &&
          resolveApprovalImpact(
            orgId,
            splitToolName(shown.tool_name).appName,
            splitToolName(shown.tool_name).toolShortName,
            shown.summary?.impact,
          ) === "external"
            ? "external"
            : resolveApprovalImpact(orgId, appName, toolShortName, r.summary?.impact),
        // When true the feed row must NOT offer approve/deny — only a way into
        // the record, so the reviewer reads the context first.
        // An org may opt an app's replies out (settings.<app>.approveRepliesFromHome):
        // the row is then decidable like any other approval.
        ...(resolveDecideInContext(orgId, appName, toolShortName) &&
        !approveFromHomeApps.has(appName)
          ? {
              decideInContext: true as const,
              // Where "Open" must land: the RECORD the approval acts on, not
              // the approval's own thread. Opening the approval entity took the
              // reviewer to the agent's working thread, which is useless for
              // judging a customer reply -- the whole point of decideInContext
              // is to read the ticket (reported 2026-08-06). The ticket id is
              // in the gated call's own payload.
              ...(appName === "tickets" && typeof r.current_payload?.ticketId === "string"
                ? {
                    openTarget: {
                      app: "tickets",
                      entity: "ticket",
                      entityId: r.current_payload.ticketId,
                    },
                  }
                : {}),
            }
          : {}),
        expiresAt: new Date(r.expires_at).toISOString(),
        expiresInSeconds: Math.max(0, Math.round(expiresMs / 1000)),
        // Lets the card render "approved, execution stalled" with its close-out
        // instead of a countdown that means nothing for this row.
        ...(wedged ? { wedged: true as const } : {}),
        baseTitle: rowTitle,
        titleKind,
        ...(titleDetail ? { titleDetail } : {}),
        // The handler's own words, so the card explains WHY instead of just
        // saying "stalled" and making the operator go dig in the logs.
        ...(r.metadata?.ambiguousError ? { failureReason: r.metadata.ambiguousError } : {}),
        // The most recent failed execution of a request back at pending (see
        // lastFailures above). A wedged row explains itself through failureReason.
        ...(!wedged && lastFailures.get(r.id) ? { lastFailure: lastFailures.get(r.id) } : {}),
        // A bundle head (bundle_id === id) carries its sequence step count so
        // the feed shows one item per bundle, annotated with how many steps.
        ...(r.bundle_id === r.id ? { bundleSteps: outcome?.cnt ?? 1 } : {}),
        // A sequence says what happens, in order: each step's own name, under
        // the outcome's title, in place of the outcome's lines.
        ...(isSequence && outcome
          ? {
              bundleSequence: outcome.steps.map((step) => ({
                toolName: step.tool_name,
                title: approvalRowName(step, skillNamesById).title,
              })),
            }
          : {}),
      },
    })
  }
  return items
}

/** The names a row's "why" line says (`metadata.routeLine`): who it is for, who stands in. */
export interface RouteLine {
  forName?: string
  standInName?: string
  blockedName?: string
}

function routeLineOf(route: ApprovalRoute, names: Map<string, string>): RouteLine | null {
  if (route.to !== "person") return null
  const line: RouteLine = {}
  const forName = names.get(route.userId)
  if (forName) line.forName = forName
  const standInName = route.standIn ? names.get(route.standIn) : undefined
  if (standInName) line.standInName = standInName
  const blockedName = route.blockedStandIn ? names.get(route.blockedStandIn) : undefined
  if (blockedName) line.blockedName = blockedName
  return line
}

/**
 * The names of the people the feed's routes name, read once as the viewer. A name that cannot be
 * read leaves the line without it, never a failed feed.
 */
async function readRouteNames(
  tx: RlsClient,
  orgId: string,
  callerUserId: string,
  rows: readonly { id: string }[],
  routes: RoutedRows,
): Promise<Map<string, string>> {
  const ids = new Set<string>()
  for (const r of rows) {
    const route = routes.route(r.id)
    if (route.to !== "person") continue
    for (const id of [route.userId, route.standIn, route.blockedStandIn]) {
      if (id && id !== callerUserId) ids.add(id)
    }
  }
  const out = new Map<string, string>()
  if (ids.size === 0) return out
  try {
    const found = extractRows<{ id: string; name: string }>(
      await tx.execute(drizzleSql`
        SELECT id, name FROM ${K}.users
        WHERE org_id = ${orgId}::uuid AND id IN (${drizzleSql.join(
          [...ids].map((id) => drizzleSql`${id}::uuid`),
          drizzleSql`, `,
        )})`),
    )
    for (const u of found) out.set(u.id, u.name)
  } catch (err) {
    log.warn({ err, orgId }, "could not read the names of the approval routes")
  }
  return out
}
