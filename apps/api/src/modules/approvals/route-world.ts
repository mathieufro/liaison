// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHO A PENDING APPROVAL IS FOR: the API's reader of the routing world.
//
// `routeApproval` (packages/shared/src/approvals/authority.ts) is pure; this module fills its
// inputs for a whole feed at once: who can decide which row (one query over the distinct
// person, scope and app pairs), who is away today in their own time zone, their next in line,
// and who is still active. It grants nothing: `canDecide` is the row's notify set intersected
// with the deciding scope, so a route only sorts the audience the feed already has.
//
// Failure never empties Home: away unreadable means nobody is away (logged), so each row stays
// with its person.

import {
  type ApprovalRoute,
  type AwayRangeDays,
  awayRunEnd,
  isAwayOn,
  personLocalDate,
  type RoutingWorld,
  routeApproval,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { authorityFacts, decidingScope } from "~/modules/approvals/authority"
import { appBridgeManifest, toolRegistry } from "~/modules/apps/app-registries"
import {
  everyMemberScopeFragment,
  scopeMatchesFragment,
} from "~/modules/permissions/eligible-approvers"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"

const K = drizzleSql.raw(schemaRef("kernel"))

/** The columns a route reads off a request row. */
export interface RoutableApprovalRow {
  id: string
  tool_name: string
  status: string
  metadata: { originRoutineId?: string; minApprovers?: number; origin?: string } | null
  notify_user_ids: string[] | null
  requested_by: string
  approve_scope: string | null
  resource_owner_id: string | null
  route_person_id?: string | null
  /** The company the request is about; absent when the caller did not select it. */
  route_company_id?: string | null
}

/** The app a request's tool belongs to: it decides a restriction, as the select policy does. */
function toolApp(toolName: string): string {
  return toolName.split(":")[0] ?? ""
}

function pairKey(userId: string, scope: string, app: string): string {
  return `${userId}\u0000${scope}\u0000${app}`
}

/**
 * Which of `pairs` (person, deciding scope, app) hold that scope today and are not denied the
 * app, in ONE query, with the same predicate as `hasScope` and the select policy. Keys are
 * `person\u0000scope\u0000app`.
 */
export async function readPeopleDecide(
  tx: Reader,
  orgId: string,
  pairs: ReadonlyMap<string, { userId: string; scope: string; app: string }>,
): Promise<Set<string>> {
  const out = new Set<string>()
  if (pairs.size === 0) return out
  const values = drizzleSql.join(
    [...pairs.values()].map(
      (p) => drizzleSql`(${p.userId}::uuid, ${p.scope}::text, ${p.app}::text)`,
    ),
    drizzleSql`, `,
  )
  const rows = extractRows<{ user_id: string; scope: string; app: string }>(
    await tx.execute(drizzleSql`
      WITH wanted(user_id, scope, app) AS (VALUES ${values})
      SELECT w.user_id, w.scope, w.app
      FROM wanted w
      WHERE NOT ${K}.app_access_denied(${orgId}::uuid, w.user_id, w.app)
        AND (EXISTS (
        SELECT 1 FROM ${K}.user_scope_grants g
        WHERE g.user_id = w.user_id AND g.org_id = ${orgId}::uuid
          AND ${scopeMatchesFragment(drizzleSql`g.scope`, drizzleSql`w.scope`)}
      ) OR EXISTS (
        SELECT 1
        FROM ${K}.user_roles ur
        JOIN ${K}.role_scope_grants rsg ON rsg.role_id = ur.role_id
        WHERE ur.user_id = w.user_id AND ur.org_id = ${orgId}::uuid
          AND ${scopeMatchesFragment(drizzleSql`rsg.scope`, drizzleSql`w.scope`)}
      ) OR ${everyMemberScopeFragment(orgId, drizzleSql`w.user_id`, drizzleSql`w.scope`)})
    `),
  )
  for (const r of rows) out.add(pairKey(r.user_id, r.scope, r.app))
  return out
}

/** A transaction the route reads run on: the viewer's, or a claim's privileged one. */
type Reader = Pick<RlsClient, "execute">

/** Who is away when, read once per feed. */
export interface AwayWorld {
  away(userId: string): { until: string | null; nextInLineId: string | null } | null
  /** Everyone named in a range today, as the person or their next in line. */
  people: Set<string>
  /** The people away today whose next in line is `userId`. */
  standingFor(userId: string): string[]
}

const NOBODY_AWAY: AwayWorld = { away: () => null, people: new Set(), standingFor: () => [] }

interface RangeRow {
  user_id: string
  starts_on: string
  ends_on: string | null
  weekdays: number[] | null
  next_in_line_id: string | null
  status: AwayRangeDays["status"]
  ended_early_on: string | null
}

/**
 * Today's away ranges of the org, each person's own date, and the standing next in line of the
 * people away with no per-range one. A member reads active ranges under RLS; the standing
 * default lives in `user_preferences`, which only its owner reads, so that one column is read
 * privileged, for the people away today and nobody else.
 */
export async function readAwayWorld(
  tx: RlsClient,
  orgId: string,
  now: Date = new Date(),
): Promise<AwayWorld> {
  try {
    // Every range not over, later ones included: a range that starts the day after another ends
    // continues the same run, and the run's walk bounds how far it reads. In a savepoint, so a
    // failed read leaves the caller's transaction usable.
    const ranges = await tx.transaction(async (sp) =>
      extractRows<RangeRow>(
        await sp.execute(drizzleSql`
          SELECT user_id, starts_on::text AS starts_on, ends_on::text AS ends_on, weekdays,
                 next_in_line_id, status, ended_early_on::text AS ended_early_on
          FROM ${K}.away_ranges
          WHERE org_id = ${orgId}::uuid AND status = 'active'
            AND (ends_on IS NULL OR ends_on >= (now() AT TIME ZONE 'UTC')::date - 1)`),
      ),
    )
    if (ranges.length === 0) return NOBODY_AWAY
    const userIds = [...new Set(ranges.map((r) => r.user_id))]
    const zones = extractRows<{ id: string; timezone: string | null }>(
      await tx.execute(drizzleSql`
        SELECT id, timezone FROM ${K}.users
        WHERE org_id = ${orgId}::uuid AND id IN (${drizzleSql.join(
          userIds.map((id) => drizzleSql`${id}::uuid`),
          drizzleSql`, `,
        )})`),
    )
    const zoneOf = new Map(zones.map((z) => [z.id, z.timezone]))
    const byUser = new Map<string, RangeRow[]>()
    for (const r of ranges) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r])

    const standing = new Map<string, string | null>()
    const awayToday = new Map<string, { until: string; ranges: RangeRow[]; today: string }>()
    const needOrgTz = userIds.some((id) => !zoneOf.get(id))
    // The org's zone, for people with none of their own; organizations is not readable under RLS.
    const orgTz = needOrgTz
      ? await withPrivilegedDb(orgId, "approval-route-org-zone", async (ptx) =>
          extractRows<{ timezone: string | null }>(
            await ptx.execute(
              drizzleSql`SELECT timezone FROM ${K}.organizations WHERE id = ${orgId}::uuid`,
            ),
          ),
        ).then((r) => r[0]?.timezone ?? null)
      : null

    for (const [userId, list] of byUser) {
      const today = personLocalDate(now, zoneOf.get(userId) ?? null, orgTz)
      const days = list.map(rangeDays)
      const until = awayRunEnd(days, today)
      if (until === null) continue
      awayToday.set(userId, { until, ranges: list, today })
    }
    if (awayToday.size === 0) return NOBODY_AWAY

    // The range covering today names the next in line; none named: the person's standing one.
    const withoutOwn = [...awayToday].filter(
      ([, a]) => !currentRange(a.ranges, a.today)?.next_in_line_id,
    )
    if (withoutOwn.length > 0) {
      const ids = withoutOwn.map(([id]) => id)
      const prefs = await withPrivilegedDb(orgId, "approval-route-next-in-line", async (ptx) =>
        extractRows<{ user_id: string; next_in_line_id: string | null }>(
          await ptx.execute(drizzleSql`
            SELECT p.user_id, p.next_in_line_id FROM ${K}.user_preferences p
            JOIN ${K}.users u ON u.id = p.user_id AND u.org_id = ${orgId}::uuid
            WHERE p.user_id IN (${drizzleSql.join(
              ids.map((id) => drizzleSql`${id}::uuid`),
              drizzleSql`, `,
            )})`),
        ),
      )
      for (const p of prefs) standing.set(p.user_id, p.next_in_line_id)
    }

    const people = new Set<string>()
    const resolved = new Map<string, { until: string; nextInLineId: string | null }>()
    for (const [userId, a] of awayToday) {
      const nextInLineId =
        currentRange(a.ranges, a.today)?.next_in_line_id ?? standing.get(userId) ?? null
      resolved.set(userId, { until: a.until, nextInLineId })
      people.add(userId)
      if (nextInLineId) people.add(nextInLineId)
    }
    return {
      away: (userId) => resolved.get(userId) ?? null,
      people,
      standingFor: (userId) =>
        [...resolved].filter(([, r]) => r.nextInLineId === userId).map(([id]) => id),
    }
  } catch (err) {
    log.warn({ err, orgId }, "could not read who is away; routing as if nobody were")
    return NOBODY_AWAY
  }
}

function rangeDays(r: RangeRow): AwayRangeDays {
  return {
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    weekdays: r.weekdays,
    status: r.status,
    endedEarlyOn: r.ended_early_on,
  }
}

/** The range that makes the person away on `today`, the latest starting one first. */
function currentRange(ranges: RangeRow[], today: string): RangeRow | undefined {
  return [...ranges]
    .filter((r) => isAwayOn(rangeDays(r), today))
    .sort((a, b) => b.starts_on.localeCompare(a.starts_on))[0]
}

/** Who among `ids` is still an active member. */
async function readActive(tx: Reader, orgId: string, ids: Set<string>): Promise<Set<string>> {
  if (ids.size === 0) return new Set()
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${K}.users
      WHERE org_id = ${orgId}::uuid AND status = 'active' AND user_type = 'member' AND id IN (${drizzleSql.join(
        [...ids].map((id) => drizzleSql`${id}::uuid`),
        drizzleSql`, `,
      )})`),
  )
  return new Set(rows.map((r) => r.id))
}

export interface RoutedRows {
  route(rowId: string): ApprovalRoute
  /** Whether this row's requester decides it (Home's peer rule), from the same query. */
  requesterDecides(rowId: string): boolean
}

/**
 * The route of every row of one feed. Owner-routed rows never read the world. A row about a
 * company (`route_company_id`) names that company's account manager, read now, so a hand-over
 * moves every waiting row on the next read without writing one. No company, or a company with
 * no manager: the row goes on as before.
 */
export async function readApprovalRoutes(
  tx: RlsClient,
  orgId: string,
  rows: readonly RoutableApprovalRow[],
  now: Date = new Date(),
): Promise<RoutedRows> {
  return routesIn(tx, orgId, rows, await readAwayWorld(tx, orgId, now))
}

/**
 * The kind of route of each row, read on any transaction, with nobody away. Away changes who
 * stands in, never whether a row is the owner's, a person's or the usual deciders'.
 */
export async function readRoutesIgnoringAway(
  tx: Reader,
  orgId: string,
  rows: readonly RoutableApprovalRow[],
): Promise<RoutedRows> {
  return routesIn(tx, orgId, rows, NOBODY_AWAY)
}

/**
 * The account manager of each row's company, by row id. The company column is read on `tx`
 * when the caller did not select it; the manager is read privileged, and only for rows that
 * name a company: who looks after a company is not a question of who may read it, so a viewer
 * who cannot see a private company places its row as everyone else does. A feed with no row
 * about a company makes no privileged read.
 */
async function readRowManagers(
  tx: Reader,
  orgId: string,
  rows: readonly RoutableApprovalRow[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const companyOf = new Map<string, string>()
  const unread = rows.filter((r) => r.resource_owner_id == null && r.route_company_id === undefined)
  for (const r of rows) {
    if (r.resource_owner_id == null && r.route_company_id) companyOf.set(r.id, r.route_company_id)
  }
  if (unread.length > 0) {
    const found = extractRows<{ id: string; route_company_id: string }>(
      await tx.execute(drizzleSql`
        SELECT id, route_company_id FROM ${K}.approval_requests
        WHERE org_id = ${orgId}::uuid AND route_company_id IS NOT NULL
          AND id IN (${drizzleSql.join(
            unread.map((r) => drizzleSql`${r.id}::uuid`),
            drizzleSql`, `,
          )})`),
    )
    for (const f of found) companyOf.set(f.id, f.route_company_id)
  }
  if (companyOf.size === 0) return out
  const companyIds = [...new Set(companyOf.values())]
  const managers = await withPrivilegedDb(orgId, "approval-route-manager", async (ptx) =>
    extractRows<{ id: string; owner_user_id: string }>(
      await ptx.execute(drizzleSql`
        SELECT id, owner_user_id FROM ${K}.companies
        WHERE org_id = ${orgId}::uuid AND owner_user_id IS NOT NULL
          AND id IN (${drizzleSql.join(
            companyIds.map((id) => drizzleSql`${id}::uuid`),
            drizzleSql`, `,
          )})`),
    ),
  )
  const managerOf = new Map(managers.map((m) => [m.id, m.owner_user_id]))
  for (const [rowId, companyId] of companyOf) {
    const managerId = managerOf.get(companyId)
    if (managerId) out.set(rowId, managerId)
  }
  return out
}

/** The routes of `rows` in a given away world, every other fact read on `tx`. */
async function routesIn(
  tx: Reader,
  orgId: string,
  rows: readonly RoutableApprovalRow[],
  awayWorld: AwayWorld,
): Promise<RoutedRows> {
  // Everyone a route may name, per row: requester, person on the item, the company's manager,
  // and the away chain.
  const managers = await readRowManagers(tx, orgId, rows)
  const pairs = new Map<string, { userId: string; scope: string; app: string }>()
  const chainPeople = new Set<string>(awayWorld.people)
  for (const r of rows) {
    const scope = decidingScope(authorityFacts(r))
    const app = toolApp(r.tool_name)
    const people = new Set([r.requested_by, ...awayWorld.people])
    const managerId = managers.get(r.id)
    if (r.route_person_id) people.add(r.route_person_id)
    if (managerId) people.add(managerId)
    for (const userId of people) {
      if (userId === r.requested_by || (r.notify_user_ids ?? []).includes(userId)) {
        pairs.set(pairKey(userId, scope, app), { userId, scope, app })
      }
    }
    if (r.route_person_id) chainPeople.add(r.route_person_id)
    if (managerId) chainPeople.add(managerId)
  }
  const decides = await readPeopleDecide(tx, orgId, pairs)
  for (const r of rows) chainPeople.add(r.requested_by)
  const active = await readActive(tx, orgId, chainPeople)

  const byId = new Map(rows.map((r) => [r.id, r]))
  const routes = new Map<string, ApprovalRoute>()
  const requesterDecidesOf = (r: RoutableApprovalRow) =>
    (r.metadata?.minApprovers ?? 1) < 2 &&
    decides.has(pairKey(r.requested_by, decidingScope(authorityFacts(r)), toolApp(r.tool_name)))

  return {
    requesterDecides(rowId) {
      const r = byId.get(rowId)
      return r ? requesterDecidesOf(r) : false
    },
    route(rowId) {
      const cached = routes.get(rowId)
      if (cached) return cached
      const r = byId.get(rowId)
      if (!r) return { to: "usual" }
      const scope = decidingScope(authorityFacts(r))
      const app = toolApp(r.tool_name)
      const notify = new Set(r.notify_user_ids ?? [])
      const world: RoutingWorld = {
        canDecide: (userId) =>
          notify.has(userId) && active.has(userId) && decides.has(pairKey(userId, scope, app)),
        isActive: (userId) => active.has(userId),
        away: (userId) => awayWorld.away(userId),
      }
      const route = routeApproval(
        authorityFacts(r),
        {
          routePersonId: r.route_person_id ?? null,
          managerId: managers.get(r.id) ?? null,
          minApprovers: r.metadata?.minApprovers ?? 1,
          stalled: r.status === "approving",
          peer: {
            requestedById: r.requested_by,
            originRoutineId: r.metadata?.originRoutineId ?? null,
            raisedBySystem: r.metadata?.origin === "system",
            requesterCanDecide: requesterDecidesOf(r),
          },
        },
        world,
      )
      routes.set(rowId, route)
      return route
    },
  }
}

/**
 * One row's route as a decision's claim sees it: the person on the item read on `tx`, the
 * claim's transaction holding the row's lock, so a reassignment cannot land between this read
 * and the decision. The away world is the one the decider read just before.
 */
export async function readLockedApprovalRoute(
  tx: Reader,
  orgId: string,
  row: Omit<RoutableApprovalRow, "route_person_id" | "route_company_id">,
  awayWorld: AwayWorld,
): Promise<ApprovalRoute> {
  const [current] = extractRows<{
    route_person_id: string | null
    route_company_id: string | null
  }>(
    await tx.execute(
      drizzleSql`SELECT route_person_id, route_company_id FROM ${K}.approval_requests WHERE id = ${row.id}::uuid`,
    ),
  )
  const routes = await routesIn(
    tx,
    orgId,
    [
      {
        ...row,
        route_person_id: current?.route_person_id ?? null,
        route_company_id: current?.route_company_id ?? null,
      },
    ],
    awayWorld,
  )
  return routes.route(row.id)
}

/**
 * An item changed hands (a ticket assigned, a task's assignee changed): every pending request
 * linked to it is now for the new person, from the next feed read. Its own privileged
 * transaction, after the write: a failure is logged and the assignment stands.
 */
export async function updateItemRoutePerson(args: {
  orgId: string
  app: string
  entityType: string
  entityId: string
  personId: string | null
}): Promise<number> {
  try {
    return await withPrivilegedDb(args.orgId, "approval-route-person", async (tx) => {
      const rows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          UPDATE ${K}.approval_requests ar
          SET route_person_id = ${args.personId}::uuid
          WHERE ar.org_id = ${args.orgId}::uuid
            AND ar.status = 'pending'
            AND ar.route_person_id IS DISTINCT FROM ${args.personId}::uuid
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(ar.summary->'links') = 'array'
                     THEN ar.summary->'links' ELSE '[]'::jsonb END) l
              WHERE l->>'app' = ${args.app}
                AND l->>'entityType' = ${args.entityType}
                AND l->>'entityId' = ${args.entityId})
          RETURNING ar.id`),
      )
      return rows.length
    })
  } catch (err) {
    log.warn(
      {
        err,
        orgId: args.orgId,
        app: args.app,
        entityType: args.entityType,
        entityId: args.entityId,
      },
      "could not move pending approvals to the item's new person; the assignment stands",
    )
    return 0
  }
}

/**
 * The people away today who name `viewerId` as their next in line, for the Home providers that
 * declare `passesOn`. Read as the viewer; unreadable means nobody (logged by the away read).
 */
export async function readStandingInFor(
  tx: RlsClient,
  orgId: string,
  viewerId: string,
  now: Date = new Date(),
): Promise<string[]> {
  return (await readAwayWorld(tx, orgId, now)).standingFor(viewerId)
}

/** How long a proposal waits for its app to say who it is for before it goes to the usual deciders. */
export const PROPOSE_ROUTE_BUDGET_MS = 300

/**
 * The same wait for a request background work proposes (origin "system": a job, a cron): no person
 * waits on its answer, and the app's sandbox may be busy with that very job, so its app gets longer.
 */
export const BACKGROUND_ROUTE_BUDGET_MS = 5_000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface SummaryLink {
  app?: unknown
  entityType?: unknown
  entityId?: unknown
}
/** What a proposal's route reads from the records it links to. */
export interface ProposeRoute {
  routePersonId?: string
  routeCompanyId?: string
}

interface RequesterArgs {
  orgId: string
  toolName: string
  /** Asked as the requester: a record they cannot read says nobody. */
  requestedBy: string
  budgetMs?: number
}

/**
 * The route columns of a request being proposed, from the records its summary links to.
 *
 * - The person: the first link whose app declares `approvalRoute` for its entity type asks that
 *   read-only tool who the record is with.
 * - The company: a kernel company link is that company, a kernel contact link is the contact's
 *   company, and any other routed link's tool may name its record's company too. Links that name
 *   more than one company give none: a batch across companies is never split by routing.
 *
 * Every read runs as the requester. A missing, slow or failing answer leaves its column unset
 * (logged): the request then reaches the usual deciders, and the proposal never waits longer
 * than the budget.
 */
export async function resolveProposeRoute(
  args: RequesterArgs & { summary: unknown },
): Promise<ProposeRoute> {
  const links = (args.summary as { links?: unknown } | null)?.links
  if (!Array.isArray(links)) return {}
  const kernelCompanyIds = new Set<string>()
  const kernelContactIds = new Set<string>()
  const routed: Array<{ app: string; tool: string; entityType: string; entityId: string }> = []
  for (const raw of links.slice(0, 10) as SummaryLink[]) {
    if (typeof raw?.app !== "string" || typeof raw.entityType !== "string") continue
    if (typeof raw.entityId !== "string" || raw.entityId.length === 0) continue
    if (raw.app === "kernel" && UUID_RE.test(raw.entityId)) {
      if (raw.entityType === "company") kernelCompanyIds.add(raw.entityId.toLowerCase())
      if (raw.entityType === "contact") kernelContactIds.add(raw.entityId.toLowerCase())
      continue
    }
    const tool = appBridgeManifest(args.orgId, raw.app)?.approvalRoute?.[raw.entityType]
    if (!tool) continue
    routed.push({ app: raw.app, tool, entityType: raw.entityType, entityId: raw.entityId })
  }
  if (routed.length === 0 && kernelCompanyIds.size === 0 && kernelContactIds.size === 0) return {}

  const perms = withPrivilegedDb(args.orgId, "approval-route-requester-perms", (ptx) =>
    loadEffectivePermissions(ptx, args.requestedBy, args.orgId),
  )
  const [kernelCompanies, answers] = await Promise.all([
    readLinkedCompanies(args, perms, kernelCompanyIds, kernelContactIds),
    Promise.all(
      routed.map((l) => askRouteTool(args, perms, l.app, l.tool, l.entityType, l.entityId)),
    ),
  ])
  const companies = new Set(kernelCompanies)
  for (const a of answers) if (a.companyId) companies.add(a.companyId.toLowerCase())
  const personId = answers[0]?.personId ?? null
  const [onlyCompany] = companies
  return {
    ...(personId ? { routePersonId: personId } : {}),
    ...(companies.size === 1 && onlyCompany ? { routeCompanyId: onlyCompany } : {}),
  }
}

/** The companies the kernel links name, as the requester reads them (a contact gives its company). */
async function readLinkedCompanies(
  args: RequesterArgs,
  perms: ReturnType<typeof loadEffectivePermissions>,
  companyIds: Set<string>,
  contactIds: Set<string>,
): Promise<string[]> {
  if (companyIds.size === 0 && contactIds.size === 0) return []
  const ids = (s: Set<string>) =>
    s.size === 0
      ? drizzleSql`NULL::uuid`
      : drizzleSql.join(
          [...s].map((id) => drizzleSql`${id}::uuid`),
          drizzleSql`, `,
        )
  try {
    const p = await perms
    const rows = await withRlsContext(
      {
        actorType: "user",
        userId: args.requestedBy,
        orgId: args.orgId,
        scopes: p.scopes,
        dimensionGrants: p.dimensionGrants,
      },
      async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            SELECT c.id::text AS id FROM ${K}.companies c
            WHERE c.org_id = ${args.orgId}::uuid
              AND (c.id IN (${ids(companyIds)})
                OR c.id IN (SELECT ct.company_id FROM ${K}.contacts ct
                             WHERE ct.org_id = ${args.orgId}::uuid AND ct.id IN (${ids(contactIds)})))`),
        ),
    )
    return rows.map((r) => r.id.toLowerCase())
  } catch (err) {
    log.warn(
      { err, orgId: args.orgId, request: args.toolName },
      "could not read the company a request is about; no company route",
    )
    return []
  }
}

async function askRouteTool(
  args: RequesterArgs,
  perms: ReturnType<typeof loadEffectivePermissions>,
  app: string,
  tool: string,
  entityType: string,
  entityId: string,
): Promise<{ personId: string | null; companyId: string | null }> {
  const nobody = { personId: null, companyId: null }
  const toolName = `${app}:${tool}`
  const fields = { orgId: args.orgId, request: args.toolName, routeTool: toolName, entityId }
  if (toolRegistry.get([args.orgId, app, tool])?.readOnly !== true) {
    log.warn(fields, "approval route tool is missing or not read-only; usual deciders")
    return nobody
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve("timeout")
    }, args.budgetMs ?? PROPOSE_ROUTE_BUDGET_MS)
  })
  try {
    const { executeToolCore } = await import("~/modules/apps/execute-tool")
    const asked = perms.then((p) =>
      executeToolCore({
        toolName,
        orgId: args.orgId,
        actor: {
          actorType: "user",
          userId: args.requestedBy,
          orgId: args.orgId,
          scopes: p.scopes,
          dimensionGrants: p.dimensionGrants,
        },
        params: { entityType, entityId },
        origin: "system",
        signal: controller.signal,
      }),
    )
    const answer = await Promise.race([asked, timedOut])
    if (answer === "timeout") {
      log.warn(fields, "approval route tool did not answer in time; usual deciders")
      return nobody
    }
    if (!("data" in answer)) {
      log.warn({ ...fields, answer }, "approval route tool refused; usual deciders")
      return nobody
    }
    const data = answer.data as { personId?: unknown; companyId?: unknown } | null
    const uuidOrNull = (v: unknown) => (typeof v === "string" && UUID_RE.test(v) ? v : null)
    return { personId: uuidOrNull(data?.personId), companyId: uuidOrNull(data?.companyId) }
  } catch (err) {
    log.warn({ ...fields, err }, "approval route tool failed; usual deciders")
    return nobody
  } finally {
    clearTimeout(timer)
  }
}
