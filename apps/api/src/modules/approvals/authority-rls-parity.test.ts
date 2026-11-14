// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TS <-> RLS PARITY ORACLE. The SQL `approval_requests_select` policy
// (migration 0029) and the TS authority module answer the same questions —
// "who can see this row?" and, inside it, "what scope decides it?"
// (`COALESCE(approve_scope, split_part(tool_name,':',1)||':approve')` vs
// `decidingScope`). SQL cannot call TS, so nothing structural keeps them in
// sync; this test does, empirically: it inserts a row x viewer matrix, runs a
// real RLS-context SELECT per pair, and asserts:
//
//  (1) EXACT parity with `rlsVisibilityMirror` — a TS restatement of the
//      policy written IN TERMS OF the authority primitives. Someone editing a
//      future migration's approver branch without touching the primitives (or
//      vice versa) diverges the matrix and fails here.
//  (2) DIRECTIONAL soundness — `canSeeInFeed => rlsVisible` and
//      `canSeeInList => rlsVisible`: no TS surface may consider a row
//      renderable that RLS will not return (the exact 2026-08 bug class ran
//      the other way round: RLS returned rows the app layer then dropped).
//
// RLS is DELIBERATELY wider than the TS surfaces (find-and-open: admin
// branches, tickets/mail shared-surface widening, requester). This oracle
// observes the policy; it never motivates narrowing or widening either side.
//
// Fixture discipline: the policy's admin/notify scope branches read
// kernel.user_scope_grants from the DB, while the tickets/mail branches read
// the SESSION scopes (app_tickets.app_has_scope). Every viewer therefore gets
// the SAME scope set granted in the DB and passed in the RLS actor context.
//
// Any future migration touching approval_requests_select MUST add its new
// branch's row/viewer to this matrix.

import { beforeAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import {
  type ApprovalAuthorityFacts,
  type ApprovalRoute,
  canSeeInFeed,
  canSeeInList,
  decidingScope,
  homePlacement,
  isNotified,
  isOwnerRouted,
  isRequester,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { apiViewer } from "~/modules/approvals/authority"
import { hasScope } from "~/modules/permissions/permissions"
import { insertThreadWithParticipants } from "~/modules/threads/thread"

let orgId: string
let threadId: string

interface Viewer {
  name: string
  id: string
  scopes: string[]
}
interface Row {
  name: string
  id: string
  facts: ApprovalAuthorityFacts
  /** `metadata.taintAudienceMustHold` (0167): what a surface reader must hold. */
  taintAudienceMustHold?: string[]
}

const viewers: Viewer[] = []
const rows: Row[] = []
/** What every active member of the fixture org holds with no stored grant (0261). */
const EVERY_MEMBER_SCOPE = "parity_app:things:read"

/** The SQL policy, restated over the authority primitives (see header). */
function rlsVisibilityMirror(
  f: ApprovalAuthorityFacts,
  v: Viewer,
  taintAudienceMustHold: readonly string[] = [],
): boolean {
  const has = (s: string) => hasScope(s, [...v.scopes, EVERY_MEMBER_SCOPE])
  // 0167: a tainted shared-surface draft reaches a surface reader only when they hold its taint.
  const holdsTaint = taintAudienceMustHold.every(has)
  if (isOwnerRouted(f)) return isRequester(f, v.id) || f.resourceOwnerId === v.id
  if (isRequester(f, v.id)) return true
  if (has("kernel:approvals:admin") || has("kernel:users:admin")) return true
  if (isNotified(f, v.id) && has(decidingScope(f))) return true
  if (f.toolName.startsWith("tickets:") && has("tickets:tickets:read") && holdsTaint) return true
  if (f.toolName.startsWith("mail:") && has("mail:conversations:read") && holdsTaint) return true
  return false
}

async function insertUser(email: string, scopes: string[]): Promise<string> {
  const id = await withSystemDb("parity-user", async (tx) => {
    const r = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${email}, 'Parity User', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    return (r.rows ?? r)[0].id as string
  })
  for (const scope of scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${id}, ${orgId}, ${scope}) ON CONFLICT DO NOTHING`
  }
  return id
}

let handleSeq = 0
async function insertApproval(args: {
  name: string
  toolName: string
  approveScope: string | null
  resourceOwnerId: string | null
  requestedBy: string
  notifyUserIds: string[]
  dimensionConstraint?: { key: string; values: string[] } | null
  taintAudienceMustHold?: string[]
}): Promise<void> {
  handleSeq += 1
  const id = await withSystemDb("parity-row", async (tx) => {
    const r = (await tx.execute(drizzleSql`
      INSERT INTO kernel.approval_requests
        (id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
         current_payload, expires_at, requested_by, status, notify_user_ids,
         approve_scope, dimension_constraint, resource_owner_id, reason, metadata)
      VALUES
        (gen_random_uuid(), ${orgId}, ${`parity-${Date.now()}-${handleSeq}`}, ${threadId},
         ${threadId}, ${args.toolName}, '{}'::jsonb, '{}'::jsonb,
         now() + interval '1 hour', ${args.requestedBy}, 'pending',
         ${`{${args.notifyUserIds.join(",")}}`}::uuid[],
         ${args.approveScope},
         ${args.dimensionConstraint ? JSON.stringify(args.dimensionConstraint) : null}::jsonb,
         ${args.resourceOwnerId}, 'gated',
         ${JSON.stringify(args.taintAudienceMustHold ? { taintAudienceMustHold: args.taintAudienceMustHold } : {})}::jsonb)
      RETURNING id
    `)) as any
    return (r.rows ?? r)[0].id as string
  })
  rows.push({
    name: args.name,
    id,
    facts: {
      toolName: args.toolName,
      approveScope: args.approveScope,
      resourceOwnerId: args.resourceOwnerId,
      requestedById: args.requestedBy,
      notifyUserIds: args.notifyUserIds,
    },
    ...(args.taintAudienceMustHold ? { taintAudienceMustHold: args.taintAudienceMustHold } : {}),
  })
}

function actor(v: Viewer): UserContext {
  return { actorType: "user", userId: v.id, orgId, scopes: v.scopes, dimensionGrants: {} }
}

async function rlsVisible(row: Row, v: Viewer): Promise<boolean> {
  const seen = await withRlsContext(actor(v), async (tx) => {
    const r = await tx.execute(
      drizzleSql`SELECT id FROM kernel.approval_requests WHERE id = ${row.id}`,
    )
    return ((r as any).rows ?? r) as unknown[]
  })
  return seen.length === 1
}

beforeAll(async () => {
  const slug = `parity-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("parity-org", async (tx) => {
    const o = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'RLS Parity', ${slug}) RETURNING id
    `)) as any
    orgId = (o.rows ?? o)[0].id
  })

  const mk = async (name: string, scopes: string[]) => {
    const id = await insertUser(`${name}-${slug}@x.test`, scopes)
    const v = { name, id, scopes }
    viewers.push(v)
    return v
  }

  const requester = await mk("requester", [])
  const owner = await mk("owner", [])
  // The C-Level persona: the row's custom scope, nothing admin.
  const customNotified = await mk("custom-notified", ["kernel:skills:approve"])
  await mk("custom-unnotified", ["kernel:skills:approve"])
  const derivedNotified = await mk("derived-notified", ["test:approve"])
  // Notified but holding only the admin-grade generic scope — the regression
  // viewer: must NOT see a custom-scope row through the notify branch.
  const genericAdmin = await mk("generic-admin-notified", ["kernel:approve"])
  await mk("approvals-admin", ["kernel:approvals:admin"])
  await mk("star-admin", ["*"])
  // Trailing `:*` grants (migration 0104): hasScope covers everything under the prefix.
  const kpiWildcard = await mk("kpi-wildcard-notified", ["kpi:*"])
  await mk("kpi-wildcard-unnotified", ["kpi:*"])
  // A mid-segment `*` covers nothing but itself, in hasScope and in the policy.
  const midWildcard = await mk("mid-wildcard-notified", ["kpi:*:approve"])
  await mk("kernel-wildcard-admin", ["kernel:*"])
  await mk("approvals-wildcard-admin", ["kernel:approvals:*"])
  await mk("ticket-reader", ["tickets:tickets:read"])
  await mk("mail-reader", ["mail:conversations:read"])
  // 0167: surface readers who also hold a tainted draft's taint (a parent grant covers it).
  await mk("ticket-reader-tainted", ["tickets:tickets:read", "boxtal:shipments:read"])
  await mk("mail-reader-tainted", ["mail:conversations:read", "boxtal"])
  await mk("bystander", [])

  threadId = await withPrivilegedDb(orgId, "parity-thread", async (tx) => {
    const { thread } = await insertThreadWithParticipants(tx, {
      orgId,
      userId: requester.id,
      participantIds: [requester.id],
      title: "Parity thread",
      isPinned: false,
      createdFrom: null,
    })
    return thread.id
  })

  await sql`INSERT INTO kernel.apps (org_id, name, version, every_member_scopes)
    VALUES (${orgId}, 'parity_app', '1.0.0', ${`{${EVERY_MEMBER_SCOPE}}`}::text[])`
  // 0261: decided by a scope every member holds, as a disclosure decision can be.
  await insertApproval({
    name: "every-member-decided",
    toolName: "kernel:threads_reply",
    approveScope: EVERY_MEMBER_SCOPE,
    resourceOwnerId: null,
    requestedBy: requester.id,
    notifyUserIds: [requester.id, customNotified.id],
  })
  await insertApproval({
    name: "plain-derived",
    toolName: "test:gatedEcho",
    approveScope: null,
    resourceOwnerId: null,
    requestedBy: requester.id,
    notifyUserIds: [requester.id, derivedNotified.id, genericAdmin.id, customNotified.id],
  })
  await insertApproval({
    name: "kpi-derived",
    toolName: "kpi:kpi_propose_edit",
    approveScope: null,
    resourceOwnerId: null,
    requestedBy: requester.id,
    notifyUserIds: [requester.id, kpiWildcard.id, midWildcard.id],
  })
  await insertApproval({
    name: "custom-scope-skill",
    toolName: "kernel:update_skill",
    approveScope: "kernel:skills:approve",
    resourceOwnerId: null,
    requestedBy: requester.id,
    notifyUserIds: [requester.id, customNotified.id, genericAdmin.id],
  })
  await insertApproval({
    name: "owner-routed",
    toolName: "mail:reply",
    approveScope: null,
    resourceOwnerId: owner.id,
    requestedBy: requester.id,
    notifyUserIds: [owner.id],
  })
  await insertApproval({
    name: "tickets-shared",
    toolName: "tickets:reply",
    approveScope: null,
    resourceOwnerId: null,
    requestedBy: requester.id,
    notifyUserIds: [requester.id],
  })
  await insertApproval({
    name: "mail-shared",
    toolName: "mail:reply",
    approveScope: null,
    resourceOwnerId: null,
    requestedBy: requester.id,
    notifyUserIds: [requester.id],
  })
  // Rule 8 (scope-taint.ts): a draft parked although some surface readers lack its taint.
  await insertApproval({
    name: "tickets-shared-tainted",
    toolName: "tickets:reply",
    approveScope: null,
    resourceOwnerId: null,
    requestedBy: requester.id,
    notifyUserIds: [requester.id],
    taintAudienceMustHold: ["boxtal:shipments:read"],
  })
  await insertApproval({
    name: "mail-shared-tainted",
    toolName: "mail:reply",
    approveScope: null,
    resourceOwnerId: null,
    requestedBy: requester.id,
    notifyUserIds: [requester.id],
    taintAudienceMustHold: ["boxtal:shipments:read"],
  })
  await insertApproval({
    name: "dimension-constrained",
    toolName: "kernel:create_skill",
    approveScope: "kernel:skills:approve",
    resourceOwnerId: null,
    requestedBy: requester.id,
    notifyUserIds: [customNotified.id],
    dimensionConstraint: { key: "kernel:skills_domain", values: ["shipping"] },
  })
  await insertApproval({
    name: "unresolved-sentinel",
    toolName: "kernel:create_skill",
    approveScope: "kernel:skills:approve",
    resourceOwnerId: null,
    requestedBy: requester.id,
    notifyUserIds: [requester.id],
    dimensionConstraint: { key: "__unresolved__", values: ["__unresolved__"] },
  })
}, 60_000)

describe("authority <-> RLS parity matrix", () => {
  it("the mirror (written over authority primitives) equals actual RLS on every pair", async () => {
    const diverged: string[] = []
    for (const row of rows) {
      for (const v of viewers) {
        const actual = await rlsVisible(row, v)
        const mirrored = rlsVisibilityMirror(row.facts, v, row.taintAudienceMustHold)
        if (actual !== mirrored) {
          diverged.push(`${row.name} x ${v.name}: rls=${actual} mirror=${mirrored}`)
        }
      }
    }
    expect(diverged).toEqual([])
  }, 60_000)

  it("directional soundness: nothing the TS surfaces render is RLS-invisible", async () => {
    const unsound: string[] = []
    for (const row of rows) {
      for (const v of viewers) {
        const viewer = apiViewer(v.id, v.scopes)
        const feed = canSeeInFeed(row.facts, viewer)
        const list = canSeeInList(row.facts, viewer)
        if (!feed && !list) continue
        const actual = await rlsVisible(row, v)
        if (feed && !actual) unsound.push(`feed: ${row.name} x ${v.name}`)
        if (list && !actual) unsound.push(`list: ${row.name} x ${v.name}`)
      }
    }
    expect(unsound).toEqual([])
  }, 60_000)

  it("a tainted shared-surface draft: a surface reader lacking its taint is out, a holder and the requester are in (0167)", async () => {
    const find = (n: string) => {
      const v = viewers.find((x) => x.name === n)
      if (!v) throw new Error(`viewer ${n} missing`)
      return v
    }
    const tickets = rows.find((r) => r.name === "tickets-shared-tainted")
    const mail = rows.find((r) => r.name === "mail-shared-tainted")
    const plain = rows.find((r) => r.name === "tickets-shared")
    if (!tickets || !mail || !plain) throw new Error("fixture missing")
    expect(await rlsVisible(tickets, find("ticket-reader"))).toBe(false)
    expect(await rlsVisible(tickets, find("ticket-reader-tainted"))).toBe(true)
    expect(await rlsVisible(tickets, find("requester"))).toBe(true)
    expect(await rlsVisible(mail, find("mail-reader"))).toBe(false)
    expect(await rlsVisible(mail, find("mail-reader-tainted"))).toBe(true)
    // A draft without the key is unchanged: every ticket reader sees it.
    expect(await rlsVisible(plain, find("ticket-reader"))).toBe(true)
  })

  it("a notified approver holding the deciding scope only as an every-member scope reads the row; nobody else does (0261)", async () => {
    const row = rows.find((r) => r.name === "every-member-decided")!
    const find = (name: string) => viewers.find((v) => v.name === name)!
    expect(await rlsVisible(row, find("custom-notified"))).toBe(true)
    expect(await rlsVisible(row, find("bystander"))).toBe(false)
    expect(await rlsVisible(row, find("derived-notified"))).toBe(false)
  })

  it("the COALESCE branch equals decidingScope: custom-scope holder in, generic kernel:approve out", async () => {
    const row = rows.find((r) => r.name === "custom-scope-skill")
    const customNotified = viewers.find((v) => v.name === "custom-notified")
    const genericAdmin = viewers.find((v) => v.name === "generic-admin-notified")
    if (!row || !customNotified || !genericAdmin) throw new Error("fixture missing")
    expect(await rlsVisible(row, customNotified)).toBe(true)
    // Notified AND holding admin-grade kernel:approve — but that is NOT the
    // row's deciding scope, so the notify branch must refuse. (This pair is the
    // 2026-08-06 incident in SQL form.)
    expect(await rlsVisible(row, genericAdmin)).toBe(false)
  })

  it("a notified kpi:* approver can read the kpi approval it decides (0104)", async () => {
    const row = rows.find((r) => r.name === "kpi-derived")
    const wildcard = viewers.find((v) => v.name === "kpi-wildcard-notified")
    const unnotified = viewers.find((v) => v.name === "kpi-wildcard-unnotified")
    const mid = viewers.find((v) => v.name === "mid-wildcard-notified")
    if (!row || !wildcard || !unnotified || !mid) throw new Error("fixture missing")
    expect(hasScope(decidingScope(row.facts), wildcard.scopes)).toBe(true)
    expect(await rlsVisible(row, wildcard)).toBe(true)
    // Holding the scope is not enough without being in the audience...
    expect(await rlsVisible(row, unnotified)).toBe(false)
    // ...and a mid-segment wildcard covers nothing.
    expect(await rlsVisible(row, mid)).toBe(false)
  })

  it("kernel:* and kernel:approvals:* are approvals admins in RLS as in hasScope (0104)", async () => {
    const row = rows.find((r) => r.name === "plain-derived")
    if (!row) throw new Error("fixture missing")
    for (const name of ["kernel-wildcard-admin", "approvals-wildcard-admin"]) {
      const v = viewers.find((x) => x.name === name)
      if (!v) throw new Error("fixture missing")
      expect(await rlsVisible(row, v)).toBe(true)
    }
  })
})

describe("routing sorts the feed's audience and never widens it", () => {
  /** Every route a world of routed rows and away people could give a row of this matrix. */
  function everyRoute(): ApprovalRoute[] {
    const routes: ApprovalRoute[] = [{ to: "usual" }]
    for (const u of viewers) {
      routes.push({ to: "owner", userId: u.id })
      for (const why of ["asked", "on_item", "manager"] as const) {
        routes.push({
          to: "person",
          userId: u.id,
          why,
          awayUntil: null,
          standIn: null,
          blockedStandIn: null,
        })
        for (const s of viewers) {
          if (s.id === u.id) continue
          routes.push({
            to: "person",
            userId: u.id,
            why,
            awayUntil: "2026-12-20",
            standIn: s.id,
            blockedStandIn: null,
          })
          routes.push({
            to: "person",
            userId: u.id,
            why,
            awayUntil: "2026-12-20",
            standIn: null,
            blockedStandIn: s.id,
          })
        }
      }
    }
    return routes
  }

  it("for every row, viewer and route, a placement other than hidden implies the feed rule, which implies row security returns it", async () => {
    const unsound: string[] = []
    const routes = everyRoute()
    for (const row of rows) {
      for (const v of viewers) {
        const viewer = apiViewer(v.id, v.scopes)
        const placed = routes.some((route) => homePlacement(row.facts, route, viewer) !== "hidden")
        if (!placed) continue
        if (!canSeeInFeed(row.facts, viewer)) unsound.push(`feed: ${row.name} x ${v.name}`)
        else if (!(await rlsVisible(row, v))) unsound.push(`rls: ${row.name} x ${v.name}`)
      }
    }
    expect(unsound).toEqual([])
  }, 60_000)

  it("the approval_requests_select policy is the one its last migration wrote, naming no routing input", async () => {
    const dir = new URL("../../db/migrations/", import.meta.url).pathname
    const touching = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter((f) => readFileSync(`${dir}${f}`, "utf8").includes("approval_requests_select"))
    expect(touching.at(-1)).toBe("0261_every_member_scope_approvers.sql")
    const [policy] = (await sql`
      SELECT qual FROM pg_policies
      WHERE schemaname = 'kernel' AND tablename = 'approval_requests'
        AND policyname = 'approval_requests_select'`) as Array<{ qual: string }>
    expect(policy?.qual).toBeTruthy()
    expect(policy?.qual).not.toMatch(/route_|away_ranges|next_in_line/)
  })
})
