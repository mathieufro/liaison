// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHO A PENDING APPROVAL IS FOR, AS HOME AND THE BADGE READ IT.
//
// Routing sorts the audience the feed already has; it never widens it. The first block pins
// that a world with no route input changes nothing: the feed and the badge equal, row for row,
// a snapshot taken before routing existed (`home-routing.snapshot.json`). Only the keys routing
// adds to an item's metadata are left out of the comparison.
//
// Write the snapshot again (only on purpose): HOME_ROUTING_SNAPSHOT_WRITE=1.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { type AttentionItem, countBadge } from "@liaison/shared"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import {
  computeApprovalAttentionItems,
  computeApprovalBadgeItems,
} from "~/modules/approvals/attention"
import {
  ApprovalDecisionError,
  DecidedForTestAccess,
  decideApproval,
} from "~/modules/approvals/decide"
import { resolveProposeRoute, updateItemRoutePerson } from "~/modules/approvals/route-world"
import { attentionItemsRegistry } from "~/modules/apps/app-registries"
import { aggregateAttentionItems } from "~/modules/apps/attention-aggregator"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SNAPSHOT_PATH = new URL("./home-routing.snapshot.json", import.meta.url).pathname
/** The keys routing adds to a feed item's metadata, left out of the before/after comparison. */
const ROUTING_KEYS = new Set(["route", "placement", "routeLine"])

let ORG = ""
let THREAD = ""
const people: Record<string, string> = {}
const rows: Record<string, string> = {}

async function ctxOf(userId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(ORG, "home-routing-test-perms", (tx) =>
    loadEffectivePermissions(tx, userId, ORG),
  )
  return {
    actorType: "user",
    userId,
    orgId: ORG,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
}

interface RowSpec {
  tool?: string
  requestedBy: string
  notify: string[]
  status?: "pending" | "approving"
  metadata?: Record<string, unknown>
  resourceOwner?: string | null
  bundleId?: string | null
  bundlePosition?: number | null
  title: string
  routePersonId?: string | null
  links?: unknown[]
  /** The stored payload; by default `{ title }`. */
  payload?: Record<string, unknown>
}

export async function insertRow(spec: RowSpec): Promise<string> {
  const id = randomUUID()
  const wedged = spec.status === "approving"
  await sql.unsafe(
    insertSql("kernel.approval_requests", {
      id,
      org_id: ORG,
      handle: `APR-${id.slice(0, 8)}`,
      thread_id: THREAD,
      originating_thread_id: THREAD,
      tool_name: spec.tool ?? "projects:createTask",
      tool_params: "{}",
      current_payload: JSON.stringify(spec.payload ?? { title: spec.title }),
      expires_at: { raw: "now() + INTERVAL '3 days'" },
      notify_user_ids: `{${spec.notify.join(",")}}`,
      requested_by: spec.requestedBy,
      status: spec.status ?? "pending",
      summary: JSON.stringify({ title: spec.title, ...(spec.links ? { links: spec.links } : {}) }),
      metadata: JSON.stringify(spec.metadata ?? {}),
      resource_owner_id: spec.resourceOwner ?? null,
      bundle_id: spec.bundleId === "self" ? id : (spec.bundleId ?? null),
      bundle_position: spec.bundlePosition ?? null,
      approving_started_at: wedged ? { raw: "now() - INTERVAL '2 hours'" } : null,
      route_person_id: spec.routePersonId ?? null,
    }),
  )
  return id
}

/** Ids and clock-bound values replaced by names, so a run compares to another run. */
function normalise(value: unknown, names: Map<string, string>): unknown {
  if (typeof value === "string") {
    let out = value
    for (const [id, name] of names) out = out.split(id).join(`<${name}>`)
    return out.replace(/APR-[0-9a-f]{8}/g, "<handle>")
  }
  if (Array.isArray(value)) return value.map((v) => normalise(v, names))
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (["occurredAt", "expiresAt", "expiresInSeconds"].includes(k)) continue
      if (ROUTING_KEYS.has(k)) continue
      out[k] = normalise(v, names)
    }
    return out
  }
  return value
}

function nameMap(): Map<string, string> {
  const names = new Map<string, string>()
  for (const [k, v] of Object.entries(people)) names.set(v, k)
  for (const [k, v] of Object.entries(rows)) names.set(v, `row:${k}`)
  names.set(THREAD, "thread")
  names.set(ORG, "org")
  return names
}

async function feedOf(userId: string): Promise<AttentionItem[]> {
  const ctx = await ctxOf(userId)
  const items = await withRlsContext(ctx, (tx) => computeApprovalAttentionItems(tx, ORG, userId))
  return items.sort((a, b) => a.entityId.localeCompare(b.entityId))
}

async function badgeOf(userId: string) {
  const ctx = await ctxOf(userId)
  const items = await withRlsContext(ctx, (tx) => computeApprovalBadgeItems(tx, ORG, userId, 200))
  return items.sort((a, b) => a.entityId.localeCompare(b.entityId))
}

async function readWorld() {
  const names = nameMap()
  const out: Record<string, unknown> = {}
  for (const viewer of ["ines", "tom", "sara", "owner"]) {
    const userId = people[viewer] as string
    const feed = await feedOf(userId)
    const badge = await badgeOf(userId)
    const viewerFacts = { userId, canGrantAccess: false }
    out[viewer] = normalise(
      {
        feed: [...feed].sort((a, b) =>
          (names.get(a.entityId) ?? "").localeCompare(names.get(b.entityId) ?? ""),
        ),
        badgeItems: [...badge].sort((a, b) =>
          (names.get(a.entityId) ?? "").localeCompare(names.get(b.entityId) ?? ""),
        ),
        feedCount: countBadge({ threads: [], items: feed, viewer: viewerFacts }),
        badgeCount: countBadge({ threads: [], items: badge, viewer: viewerFacts }),
      },
      names,
    )
  }
  return out
}

describe("home routing: who a pending approval is for", () => {
  beforeAll(async () => {
    await acquireTestLock()
    ORG = (await createTestOrg()).id
    for (const name of ["ines", "tom", "sara", "owner", "lea"]) {
      people[name] = (await minimal.person(ORG, { name: `Fixture ${name}` })).id
    }
    for (const name of ["ines", "tom", "sara", "owner"]) {
      await minimal.grantScope(people[name] as string, "projects:approve")
    }
    THREAD = await minimal.thread(ORG, people.ines as string, { title: "Routing fixtures" })
    const deciders = [people.ines, people.tom, people.sara] as string[]
    // Tom raised it and could approve it himself: noise for the others.
    rows.peer = await insertRow({
      requestedBy: people.tom as string,
      notify: deciders,
      title: "Peer row",
    })
    rows.routine = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders,
      metadata: { originRoutineId: randomUUID() },
      title: "Routine row",
    })
    rows.twoApprovers = await insertRow({
      requestedBy: people.sara as string,
      notify: deciders,
      metadata: { minApprovers: 2, approvedBy: [people.tom] },
      title: "Two approver row",
    })
    rows.wedged = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders,
      status: "approving",
      metadata: { approvedBy: [people.sara] },
      title: "Wedged row",
    })
    rows.owner = await insertRow({
      requestedBy: people.owner as string,
      notify: [people.owner as string],
      resourceOwner: people.owner as string,
      title: "Owner row",
    })
    rows.bundle = await insertRow({
      requestedBy: people.sara as string,
      notify: deciders,
      bundleId: "self",
      bundlePosition: 0,
      title: "Bundle head",
    })
    rows.bundleStep = await insertRow({
      requestedBy: people.sara as string,
      notify: deciders,
      bundleId: rows.bundle,
      bundlePosition: 1,
      title: "Bundle outcome",
    })
  }, 180_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("with no route input, the feed and the badge equal the snapshot taken before routing, row for row", async () => {
    const world = await readWorld()
    if (process.env.HOME_ROUTING_SNAPSHOT_WRITE === "1") {
      writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(world, null, 2)}\n`)
    }
    expect(existsSync(SNAPSHOT_PATH)).toBe(true)
    expect(world).toEqual(JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")))
  })

  /** The row as this viewer's feed has it, or null when it is not in their feed. */
  async function placed(viewer: string, rowId: string) {
    const item = (await feedOf(people[viewer] as string)).find((i) => i.entityId === rowId)
    if (!item) return null
    const meta = item.metadata as Record<string, unknown>
    return {
      placement: meta.placement,
      route: meta.route as Record<string, unknown>,
      peerSelfApprovable: meta.peerSelfApprovable,
      item,
    }
  }

  /** What this row adds to the viewer's badge, through the badge's own read. */
  async function badgeFrom(viewer: string, rowId: string): Promise<number> {
    const items = (await badgeOf(people[viewer] as string)).filter((i) => i.entityId === rowId)
    return countBadge({
      threads: [],
      items,
      viewer: { canGrantAccess: false },
    })
  }

  async function away(userId: string, nextInLineId: string | null): Promise<string> {
    const [r] = (await sql.unsafe(
      insertSql(
        "kernel.away_ranges",
        {
          org_id: ORG,
          user_id: userId,
          starts_on: { raw: "current_date - 1" },
          ends_on: { raw: "current_date + 2" },
          next_in_line_id: nextInLineId,
          source: "said",
        },
        { returning: "id" },
      ),
    )) as Array<{ id: string }>
    return (r as { id: string }).id
  }

  async function requestColumns(): Promise<unknown[]> {
    return [
      ...(await sql`SELECT * FROM kernel.approval_requests WHERE org_id = ${ORG} ORDER BY id`),
    ]
  }

  const deciders = () => [people.ines, people.tom, people.sara] as string[]
  const ticketLink = (id: string) => [
    { label: "Ticket", app: "tickets", entityType: "ticket", entityId: id },
  ]

  it("a row with a person on the item is theirs; the other deciders have it as for someone else", async () => {
    const id = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      title: "On the item",
    })
    const sara = await placed("sara", id)
    expect(sara?.placement).toBe("mine")
    expect(sara?.route).toMatchObject({ to: "person", userId: people.sara, why: "on_item" })
    for (const other of ["ines", "tom"]) {
      const p = await placed(other, id)
      expect(p?.placement).toBe("others")
      // A client that reads the peer flag alone folds it too.
      expect(p?.peerSelfApprovable).toBe(true)
    }
    expect(await badgeFrom("sara", id)).toBe(1)
    expect(await badgeFrom("ines", id)).toBe(0)
  })

  it("a request its requester could approve is theirs, asked, and for someone else in the others' feeds", async () => {
    const tom = await placed("tom", rows.peer as string)
    expect(tom?.route).toMatchObject({ to: "person", userId: people.tom, why: "asked" })
    expect(tom?.placement).toBe("mine")
    expect((await placed("ines", rows.peer as string))?.placement).toBe("others")
  })

  it("reassigning the item moves the row on the next read, and leaves other items' rows alone", async () => {
    const ticket = randomUUID()
    const id = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      links: ticketLink(ticket),
      title: "Reassigned",
    })
    const untouched = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      links: ticketLink(randomUUID()),
      title: "Other ticket",
    })
    expect(
      await updateItemRoutePerson({
        orgId: ORG,
        app: "tickets",
        entityType: "ticket",
        entityId: ticket,
        personId: people.tom as string,
      }),
    ).toBe(1)
    expect((await placed("tom", id))?.placement).toBe("mine")
    expect((await placed("sara", id))?.placement).toBe("others")
    expect((await placed("sara", untouched))?.placement).toBe("mine")
  })

  it("going away rewrites no row; the next in line stands in, counted in their badge; ending it restores every placement", async () => {
    const id = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      title: "Away on the item",
    })
    const before = await requestColumns()
    const range = await away(people.sara as string, people.tom as string)
    try {
      expect(await requestColumns()).toEqual(before)
      const tom = await placed("tom", id)
      expect(tom?.placement).toBe("standing_in")
      expect(tom?.route).toMatchObject({ userId: people.sara, standIn: people.tom })
      expect(typeof tom?.route.awayUntil).toBe("string")
      expect(await badgeFrom("tom", id)).toBe(1)
      expect((await placed("ines", id))?.placement).toBe("others")
      // The person it is for can still act while away.
      expect((await placed("sara", id))?.placement).toBe("mine")
    } finally {
      await sql`UPDATE kernel.away_ranges SET ended_early_on = current_date - 1 WHERE id = ${range}`
    }
    expect((await placed("tom", id))?.placement).toBe("others")
    expect((await placed("sara", id))?.placement).toBe("mine")
    expect(await requestColumns()).toEqual(before)
    await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
  })

  it("a range with no next in line uses the person's standing one, read for a colleague under row security", async () => {
    const id = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      title: "Standing next in line",
    })
    await sql.unsafe(
      `${insertSql("kernel.user_preferences", {
        user_id: people.sara as string,
        next_in_line_id: people.tom as string,
      })} ON CONFLICT (user_id) DO UPDATE SET next_in_line_id = EXCLUDED.next_in_line_id`,
    )
    const range = await away(people.sara as string, null)
    try {
      expect((await placed("tom", id))?.placement).toBe("standing_in")
    } finally {
      await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
      await sql`UPDATE kernel.user_preferences SET next_in_line_id = NULL WHERE user_id = ${people.sara}`
    }
  })

  it("a next in line without the deciding scope gets nothing: no row, decide not found, and the others hold it naming them blocked", async () => {
    const id = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      title: "Blocked stand-in",
    })
    const range = await away(people.sara as string, people.lea as string)
    try {
      expect(await placed("lea", id)).toBeNull()
      const refused = await decideApproval({
        orgId: ORG,
        requestId: id,
        actor: await ctxOf(people.lea as string),
        decision: "deny",
      }).then(
        () => null,
        (err: unknown) => err,
      )
      expect(refused).toBeInstanceOf(ApprovalDecisionError)
      // Refused as any row they cannot read is: not found, which says nothing of the row.
      expect((refused as ApprovalDecisionError).status).toBe(404)
      for (const other of ["ines", "tom"]) {
        const p = await placed(other, id)
        expect(p?.placement).toBe("mine")
        expect(p?.route).toMatchObject({ standIn: null, blockedStandIn: people.lea })
      }
    } finally {
      await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
    }
  })

  it("granted the scope after the row was proposed, a next in line is still not notified: no row, decide not found", async () => {
    const id = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      title: "Granted later",
    })
    await minimal.grantScope(people.lea as string, "projects:approve")
    const range = await away(people.sara as string, people.lea as string)
    try {
      expect(await placed("lea", id)).toBeNull()
      const refused = await decideApproval({
        orgId: ORG,
        requestId: id,
        actor: await ctxOf(people.lea as string),
        decision: "deny",
      }).then(
        () => null,
        (err: unknown) => err,
      )
      // Refused as any row they cannot read is: not found, which says nothing of the row.
      expect((refused as ApprovalDecisionError).status).toBe(404)
    } finally {
      await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
    }
  })

  it("granted the scope after a shared ticket reply was proposed: not in their feed, yet their decide is taken", async () => {
    const id = await insertRow({
      tool: "tickets:reply",
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.sara as string,
      title: "Shared reply granted later",
    })
    // Granted after the proposal: reading tickets and deciding on them.
    await minimal.grantScope(people.lea as string, "tickets:tickets:read")
    await minimal.grantScope(people.lea as string, "tickets:approve")
    const range = await away(people.sara as string, people.lea as string)
    try {
      expect(await placed("lea", id)).toBeNull()
      // A ticket reply is a shared work item: anyone holding the deciding scope may decide it.
      const decided = await decideApproval({
        orgId: ORG,
        requestId: id,
        actor: await ctxOf(people.lea as string),
        decision: "deny",
      })
      expect(decided.status).toBe("denied")
    } finally {
      await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
    }
  })

  it("an owner-routed row with its owner away reaches nobody else: not the next in line, not in their badge", async () => {
    const range = await away(people.owner as string, people.tom as string)
    try {
      expect(await placed("tom", rows.owner as string)).toBeNull()
      expect(await badgeFrom("tom", rows.owner as string)).toBe(0)
      const owner = await placed("owner", rows.owner as string)
      expect(owner?.route).toEqual({ to: "owner", userId: people.owner })
      expect(owner?.placement).toBe("mine")
    } finally {
      await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
    }
  })

  it("a decision records whose it was taken for: next in line, also could, and nothing by the person it is for", async () => {
    const make = (title: string) =>
      insertRow({
        requestedBy: people.ines as string,
        notify: deciders(),
        metadata: { originRoutineId: randomUUID() },
        routePersonId: people.sara as string,
        title,
      })
    const byStandIn = await make("Decided by the stand-in")
    const byOther = await make("Decided by another")
    const byOwn = await make("Decided by its person")
    const decide = async (viewer: string, id: string) =>
      decideApproval({
        orgId: ORG,
        requestId: id,
        actor: await ctxOf(people[viewer] as string),
        decision: "deny",
      })
    const decidedFor = async (id: string) =>
      (
        (await sql`SELECT metadata FROM kernel.approval_requests WHERE id = ${id}`)[0] as {
          metadata: Record<string, unknown>
        }
      ).metadata.decidedFor
    const range = await away(people.sara as string, people.tom as string)
    try {
      await decide("tom", byStandIn)
      const audit = (await decidedFor(byStandIn)) as Record<string, unknown>
      expect(audit).toMatchObject({ userId: people.sara, as: "next_in_line" })
      expect(typeof audit.awayUntil).toBe("string")
    } finally {
      await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
    }
    await decide("ines", byOther)
    expect(await decidedFor(byOther)).toEqual({ userId: people.sara, as: "also_could" })
    await decide("sara", byOwn)
    expect(await decidedFor(byOwn)).toBeUndefined()
  })

  it("a deny records whose the row was as the decision locked it, not as it was read before", async () => {
    const decidedFor = async (id: string) =>
      (
        (await sql`SELECT metadata FROM kernel.approval_requests WHERE id = ${id}`)[0] as {
          metadata: Record<string, unknown>
        }
      ).metadata.decidedFor
    const id = await insertRow({
      requestedBy: people.ines as string,
      notify: deciders(),
      metadata: { originRoutineId: randomUUID() },
      routePersonId: people.ines as string,
      title: "Reassigned before the deny",
    })
    // The item changes hands between the decider's reads and the claim.
    DecidedForTestAccess.beforeClaim = async () => {
      await sql`UPDATE kernel.approval_requests SET route_person_id = ${people.sara as string}::uuid WHERE id = ${id}`
    }
    try {
      await decideApproval({
        orgId: ORG,
        requestId: id,
        actor: await ctxOf(people.ines as string),
        decision: "deny",
      })
    } finally {
      DecidedForTestAccess.beforeClaim = null
    }
    expect(await decidedFor(id)).toEqual({ userId: people.sara, as: "also_could" })
  })

  describe("an item changing hands moves its pending rows", () => {
    let admin: UserContext
    beforeAll(async () => {
      await ensureAppsForOrg(ORG)
      admin = await ctxOf((await minimal.orgAdmin(ORG)).id)
    }, 120_000)

    async function routedTo(link: unknown[], personId: string): Promise<string> {
      return insertRow({
        requestedBy: people.ines as string,
        notify: deciders(),
        metadata: { originRoutineId: randomUUID() },
        routePersonId: personId,
        links: link,
        title: "Follows its item",
      })
    }

    async function newTicket(): Promise<string> {
      const created = await executeTool({
        toolName: "tickets:create",
        orgId: ORG,
        actor: admin,
        params: { subject: "Routing door", channel: "manual" },
      })
      const ticketId = (created.data as { ticketId?: string } | undefined)?.ticketId
      if (!ticketId) throw new Error(`ticket not created: ${JSON.stringify(created)}`)
      return ticketId
    }

    it("assigning a ticket moves its row to the new assignee on the next read", async () => {
      const ticketId = await newTicket()
      const id = await routedTo(ticketLink(ticketId), people.sara as string)
      const res = await executeTool({
        toolName: "tickets:assign",
        orgId: ORG,
        actor: admin,
        params: { ticketId, assignedTo: people.tom },
      })
      expect(res.blocked).toBeUndefined()
      expect((await placed("tom", id))?.route).toMatchObject({ userId: people.tom, why: "on_item" })
      expect((await placed("sara", id))?.placement).toBe("others")
    })

    it("claiming an unassigned ticket moves its row to the one who claimed it", async () => {
      const ticketId = await newTicket()
      const id = await routedTo(ticketLink(ticketId), people.sara as string)
      const res = await executeTool({
        toolName: "tickets:assign",
        orgId: ORG,
        actor: admin,
        params: { ticketId, assignedTo: people.tom, onlyIfUnassigned: true },
      })
      expect(res.blocked).toBeUndefined()
      expect((await placed("tom", id))?.placement).toBe("mine")
    })

    it("changing a task's assignee moves its row on the next read", async () => {
      const project = await executeTool({
        toolName: "projects:createProject",
        orgId: ORG,
        actor: admin,
        params: { name: "Routing doors", tasks: [{ title: "Door task" }] },
      })
      const data = project.data as { tasks?: Array<{ id: string }> } | undefined
      const taskId = data?.tasks?.[0]?.id
      if (!taskId) throw new Error(`task not created: ${JSON.stringify(project)}`)
      const id = await routedTo(
        [{ label: "Task", app: "projects", entityType: "task", entityId: taskId }],
        people.sara as string,
      )
      const res = await executeTool({
        toolName: "projects:update",
        orgId: ORG,
        actor: admin,
        params: { taskId, assigneeId: people.tom },
      })
      expect(res.blocked).toBeUndefined()
      expect((await placed("tom", id))?.placement).toBe("mine")
    })

    it("a proposal about a task is for its assignee from the moment it is proposed", async () => {
      const project = await executeTool({
        toolName: "projects:createProject",
        orgId: ORG,
        actor: admin,
        params: { name: "Routing at propose", tasks: [{ title: "Task to delete" }] },
      })
      const taskId = (project.data as { tasks?: Array<{ id: string }> } | undefined)?.tasks?.[0]?.id
      if (!taskId) throw new Error(`task not created: ${JSON.stringify(project)}`)
      const assigned = await executeTool({
        toolName: "projects:update",
        orgId: ORG,
        actor: admin,
        params: { taskId, assigneeId: people.tom },
      })
      expect(assigned.blocked).toBeUndefined()
      await executeTool({
        toolName: "projects:delete",
        orgId: ORG,
        actor: admin,
        threadId: THREAD,
        params: { taskId },
        origin: "in-app-agent",
      })
      const [row] = (await sql`
        SELECT id, route_person_id FROM kernel.approval_requests
        WHERE org_id = ${ORG} AND tool_name = 'projects:delete' AND status = 'pending'
          AND tool_params->>'taskId' = ${taskId}`) as Array<{
        id: string
        route_person_id: string | null
      }>
      expect(row?.route_person_id).toBe(people.tom as string)
    })

    it("a ticket's app says who a request about it is for: its assignee", async () => {
      const ticketId = await newTicket()
      const summary = { links: ticketLink(ticketId) }
      expect(
        await resolveProposeRoute({
          orgId: ORG,
          toolName: "tickets:reply",
          summary,
          requestedBy: admin.userId as string,
        }),
      ).toEqual({})
      await executeTool({
        toolName: "tickets:assign",
        orgId: ORG,
        actor: admin,
        params: { ticketId, assignedTo: people.sara },
      })
      expect(
        await resolveProposeRoute({
          orgId: ORG,
          toolName: "tickets:reply",
          summary,
          requestedBy: admin.userId as string,
        }),
      ).toEqual({
        routePersonId: people.sara,
      })
    })

    it("an app that does not answer in time, or a record no app routes, leaves the request to the usual deciders", async () => {
      const ticketId = await newTicket()
      await executeTool({
        toolName: "tickets:assign",
        orgId: ORG,
        actor: admin,
        params: { ticketId, assignedTo: people.sara },
      })
      expect(
        await resolveProposeRoute({
          orgId: ORG,
          toolName: "tickets:reply",
          summary: { links: ticketLink(ticketId) },
          requestedBy: admin.userId as string,
          budgetMs: 0,
        }),
      ).toEqual({})
      expect(
        await resolveProposeRoute({
          orgId: ORG,
          toolName: "tickets:reply",
          summary: {
            links: [{ label: "Open", app: "mail", entityType: "conversation", entityId: ticketId }],
          },
          requestedBy: admin.userId as string,
        }),
      ).toEqual({})
    })

    it("approving for the person away records it with the claim that won", async () => {
      const id = await insertRow({
        tool: "projects:createProject",
        requestedBy: admin.userId as string,
        notify: deciders(),
        routePersonId: people.sara as string,
        payload: { name: "Approved by the next in line" },
        title: "Approved by the next in line",
      })
      const range = await away(people.sara as string, people.tom as string)
      try {
        const decided = await decideApproval({
          orgId: ORG,
          requestId: id,
          actor: await ctxOf(people.tom as string),
          decision: "approve",
        })
        expect(decided.status).toBe("approved")
      } finally {
        await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
      }
      const [stored] = (await sql`
        SELECT decided_by, metadata FROM kernel.approval_requests WHERE id = ${id}`) as Array<{
        decided_by: string
        metadata: Record<string, unknown>
      }>
      expect(stored?.decided_by).toBe(people.tom as string)
      expect(stored?.metadata.decidedFor).toMatchObject({ userId: people.sara, as: "next_in_line" })
    })

    it("an approve records whose the row was as the claim locked it, not as it was read before", async () => {
      const id = await insertRow({
        tool: "projects:createProject",
        requestedBy: admin.userId as string,
        notify: deciders(),
        routePersonId: people.sara as string,
        payload: { name: "Reassigned before the approve" },
        title: "Reassigned before the approve",
      })
      // The item moves to the decider between their reads and the claim: their own row now.
      DecidedForTestAccess.beforeClaim = async () => {
        await sql`UPDATE kernel.approval_requests SET route_person_id = ${people.tom as string}::uuid WHERE id = ${id}`
      }
      try {
        const decided = await decideApproval({
          orgId: ORG,
          requestId: id,
          actor: await ctxOf(people.tom as string),
          decision: "approve",
        })
        expect(decided.status).toBe("approved")
      } finally {
        DecidedForTestAccess.beforeClaim = null
      }
      const [stored] = (await sql`
        SELECT metadata FROM kernel.approval_requests WHERE id = ${id}`) as Array<{
        metadata: Record<string, unknown>
      }>
      expect(stored?.metadata.decidedFor).toBeUndefined()
    })

    it("Home passes the items of a person away to their next in line only through providers that declare it", async () => {
      const declared: [string, string] = ["*", "routePassOnDeclared"]
      const undeclared: [string, string] = ["*", "routePassOnUndeclared"]
      const fixture = new URL("../../tests/fixtures/aggregator-providers.ts", import.meta.url)
        .pathname
      attentionItemsRegistry.set(declared, {
        handler: "passOnEchoA",
        bundlePath: fixture,
        trusted: true,
        passesOn: true,
      })
      attentionItemsRegistry.set(undeclared, {
        handler: "passOnEchoB",
        bundlePath: fixture,
        trusted: true,
      })
      const range = await away(people.sara as string, people.tom as string)
      try {
        const feed = await aggregateAttentionItems({
          orgId: ORG,
          actor: await ctxOf(people.tom as string),
        })
        const heard = (app: string) =>
          (feed.items.find((i) => i.app === app)?.metadata as { forUserIds?: unknown })?.forUserIds
        expect(heard("routePassOnDeclared")).toEqual([people.sara])
        // Undeclared defaults to no pass-on: the provider never hears of anyone but the viewer.
        expect(heard("routePassOnUndeclared")).toEqual([])
      } finally {
        await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
        attentionItemsRegistry.delete(declared)
        attentionItemsRegistry.delete(undeclared)
      }
    })

    it("a task of a person away reaches their next in line's Home, tagged for them, and only while away", async () => {
      const project = await executeTool({
        toolName: "projects:createProject",
        orgId: ORG,
        actor: admin,
        params: {
          name: "Passed on",
          tasks: [{ title: "Overdue while away" }],
        },
      })
      const taskId = (project.data as { tasks?: Array<{ id: string }> } | undefined)?.tasks?.[0]?.id
      if (!taskId) throw new Error(`task not created: ${JSON.stringify(project)}`)
      await executeTool({
        toolName: "projects:update",
        orgId: ORG,
        actor: admin,
        params: { taskId, assigneeId: people.sara },
      })
      await sql`UPDATE app_projects.tasks SET due_date = '2020-01-06' WHERE id = ${taskId}`
      // Both read projects and tasks, so Tom can read the task he is handed.
      for (const p of ["tom", "sara"]) {
        await minimal.grantScope(people[p] as string, "projects:projects:read")
        await minimal.grantScope(people[p] as string, "projects:tasks:read")
      }
      const tomsTask = async () =>
        (
          await aggregateAttentionItems({ orgId: ORG, actor: await ctxOf(people.tom as string) })
        ).items.find((i) => i.app === "projects" && i.entityId === taskId)
      expect(await tomsTask()).toBeUndefined()
      const range = await away(people.sara as string, people.tom as string)
      try {
        expect((await tomsTask())?.metadata).toMatchObject({ forUserId: people.sara })
      } finally {
        await sql`DELETE FROM kernel.away_ranges WHERE id = ${range}`
      }
      expect(await tomsTask()).toBeUndefined()
    })

    it("a failing route update is logged and changes nothing else", async () => {
      expect(
        await updateItemRoutePerson({
          orgId: ORG,
          app: "tickets",
          entityType: "ticket",
          entityId: randomUUID(),
          personId: "not-a-person",
        }),
      ).toBe(0)
    })
  })
})

describe("home routing: back from away, and who is away in lists of people", () => {
  const p: Record<string, string> = {}

  beforeAll(async () => {
    await acquireTestLock()
    ORG = (await createTestOrg()).id
    for (const name of ["elodie", "tom", "sara", "owner", "lea"]) {
      p[name] = (await minimal.person(ORG, { name: `Fixture ${name}` })).id
    }
    for (const name of ["elodie", "tom", "sara", "owner"]) {
      await minimal.grantScope(p[name] as string, "projects:approve")
    }
    THREAD = await minimal.thread(ORG, p.elodie as string, { title: "Away fixtures" })
  }, 180_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  async function range(userId: string, from: string, to: string | null, extra = {}) {
    const [r] = (await sql.unsafe(
      insertSql(
        "kernel.away_ranges",
        {
          org_id: ORG,
          user_id: userId,
          starts_on: { raw: from },
          ends_on: to === null ? null : { raw: to },
          source: "said",
          ...extra,
        },
        { returning: "id" },
      ),
    )) as Array<{ id: string }>
    return (r as { id: string }).id
  }

  /** A request decided two days ago by `by`, recorded as taken for `forId`. */
  async function decidedFor(forId: string, by: string, spec: Partial<RowSpec> & { title: string }) {
    const id = await insertRow({
      requestedBy: spec.requestedBy ?? (p.lea as string),
      notify: spec.notify ?? [forId, by],
      ...spec,
    })
    await sql`
      UPDATE kernel.approval_requests
      SET status = 'approved', decided_by = ${by}::uuid, decided_at = now() - INTERVAL '2 days',
          metadata = jsonb_build_object('decidedFor', jsonb_build_object('userId', ${forId}::text, 'as', 'next_in_line'))
      WHERE id = ${id}::uuid`
    return id
  }

  async function recapOf(userId: string) {
    const { getAwayRecapAttentionItems } = await import("~/modules/approvals/away-recap")
    const ctx = await ctxOf(userId)
    return withRlsContext(ctx, (tx) => getAwayRecapAttentionItems(tx, ORG, userId))
  }

  it("one readable, one restricted, one owner-routed: only the readable shows", async () => {
    const elodie = p.elodie as string
    const tom = p.tom as string
    await range(elodie, "current_date - 5", "current_date - 1")
    await decidedFor(elodie, tom, { title: "Readable refund" })
    // Not notified to her: her own read of the requests does not return it.
    await decidedFor(elodie, tom, { title: "Restricted refund", notify: [tom] })
    await decidedFor(elodie, tom, {
      title: "Owner refund",
      requestedBy: p.owner as string,
      notify: [p.owner as string, elodie],
      resourceOwner: p.owner as string,
    })
    const items = await recapOf(elodie)
    expect(items).toHaveLength(1)
    const recap = (
      items[0]!.metadata as { awayRecap: { lines: { title: string }[]; more: number } }
    ).awayRecap
    expect(recap.lines.map((l) => l.title)).toEqual(["Readable refund"])
    expect(recap.more).toBe(0)
    expect(JSON.stringify(items)).not.toContain("Restricted refund")
    expect(JSON.stringify(items)).not.toContain("Owner refund")
  })

  it("no decision: no row", async () => {
    // Tom was away too and reads the requests he decided for Élodie: none was taken for him.
    await range(p.tom as string, "current_date - 4", "current_date - 1")
    expect(await recapOf(p.tom as string)).toEqual([])
  })

  it("at most 3 and N more, and Dismiss keeps it gone", async () => {
    const sara = p.sara as string
    const rangeId = await range(sara, "current_date - 6", "current_date - 1")
    for (const n of [1, 2, 3, 4, 5]) {
      await decidedFor(sara, p.tom as string, { title: `Sara refund ${n}` })
    }
    const [item] = await recapOf(sara)
    const recap = (item!.metadata as { awayRecap: { lines: unknown[]; more: number } }).awayRecap
    expect(recap.lines).toHaveLength(3)
    expect(recap.more).toBe(2)
    expect(item?.persisted).toBeUndefined()
    const { dismissAwayRecap } = await import("~/modules/approvals/away-recap")
    const ctx = await ctxOf(sara)
    expect(await withRlsContext(ctx, (tx) => dismissAwayRecap(tx, ORG, sara, rangeId))).toBe(true)
    expect(await recapOf(sara)).toEqual([])
    // Someone else's range cannot be dismissed by her.
    const tomRange = await range(p.lea as string, "current_date - 3", "current_date - 1")
    expect(await withRlsContext(ctx, (tx) => dismissAwayRecap(tx, ORG, sara, tomRange))).toBe(false)
  })

  it("users_search has away with no source or reason, the same away Home reads, standing default included", async () => {
    const { handleUsersSearch } = await import("~/modules/agent/tools/user-tools")
    const { readAwayWorld } = await import("~/modules/approvals/route-world")
    const owner = p.owner as string
    // Away today with no next in line on the range: the standing one is read as Home reads it.
    await range(owner, "current_date - 1", "current_date + 3")
    await sql.unsafe(
      `${insertSql("kernel.user_preferences", {
        user_id: owner,
        next_in_line_id: p.tom as string,
      })} ON CONFLICT (user_id) DO UPDATE SET next_in_line_id = EXCLUDED.next_in_line_id`,
    )
    const ctx = await ctxOf(p.elodie as string)
    const { result, world } = await withRlsContext(ctx, async (db) => ({
      result: await handleUsersSearch(
        { query: "Fixture" },
        { db, userId: p.elodie as string, orgId: ORG },
      ),
      world: await readAwayWorld(db, ORG),
    }))
    const ownerRow = result.items.find((i) => i.id === owner)
    expect(ownerRow?.away).toEqual({ until: world.away(owner)?.until ?? null })
    expect(Object.keys(ownerRow?.away ?? {})).toEqual(["until"])
    expect(world.away(owner)?.nextInLineId).toBe(p.tom)
    // Who is listed does not change: everyone active, away or not.
    expect(result.items.map((i) => i.id).sort()).toEqual(
      [p.elodie, p.tom, p.sara, p.owner, p.lea].map(String).sort(),
    )
    expect(result.items.find((i) => i.id === p.lea)?.away).toBeNull()
  })

  it("recurring reads away today, back on the next working day, and users_list carries it", async () => {
    const { handleUsersList } = await import("~/modules/agent/tools/admin-tools")
    const lea = p.lea as string
    const [{ dow }] = (await sql`SELECT extract(isodow FROM current_date)::int AS dow`) as Array<{
      dow: number
    }>
    await range(lea, "current_date - 14", null, { weekdays: `{${dow}}` })
    const listed = await handleUsersList({}, { orgId: ORG, userId: p.elodie as string } as never)
    const [{ today }] = (await sql`SELECT current_date::text AS today`) as Array<{ today: string }>
    expect(listed.users.find((u) => u.id === lea)?.away).toEqual({ until: today })
  })
})
