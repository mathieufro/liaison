// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The follow-ups of a company's change of manager, through the real routes and the real event
// bus: a person's own call changes the manager or deactivates someone, the outbox publishes the
// committed events, and the `once` subscriber writes the Home rows.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { companies, userScopeGrants } from "~/db/schema/kernel"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { env } from "~/lib/env"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { awaitOrgApps } from "~/modules/apps/init"
import { registerKernelBulkApp } from "~/modules/apps/kernel-bulk"
import { signAccessToken } from "~/modules/auth/jwt"
import { HANDOVER_KIND, UNOWNED_KIND } from "~/modules/contacts/company-unowned"
import { everyMemberScopeGrants } from "~/modules/permissions/permissions"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000c0e01"
const ADMIN = "00000000-0000-4000-8000-0000000c0e02"

function uuid(seed: number): string {
  return `00000000-0000-4000-8000-${(0xc0e000 + seed).toString(16).padStart(12, "0")}`
}

let token: string

beforeAll(async () => {
  await acquireTestLock()
  await clearRedisPatterns([`app_idem:${ORG}:*`])
  await sql`DELETE FROM kernel.attention_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.companies WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await seedOrgRow({ id: ORG, name: "Ownership Events Org", slug: "ownership-events-org" })
  await seedUserRow({
    id: ADMIN,
    orgId: ORG,
    email: "oe-admin@test.com",
    name: "Nadia Admin",
    status: "active",
  })
  await withSystemDb("ownership-events-test-grants", (db) =>
    db.insert(userScopeGrants).values(
      ["kernel:users:admin", "kernel:companies:write"].map((scope) => ({
        userId: ADMIN,
        orgId: ORG,
        scope,
      })),
    ),
  )
  await awaitOrgApps(ORG)
  const everyMember = await withPrivilegedDb(ORG, "ownership-events-test-scopes", (tx) =>
    everyMemberScopeGrants(tx, ADMIN, ORG),
  )
  token = await signAccessToken(
    {
      userId: ADMIN,
      orgId: ORG,
      name: "Nadia Admin",
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["kernel:users:admin", "kernel:companies:write", ...everyMember.map((g) => g.scope)],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
  registerKernelBulkApp(ORG)

  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  registerEventSubscribers({
    bufferAndBroadcast: async () => {},
    broadcast: async () => {},
    closeConnectionsForUser: () => {},
  } as never)
  // Events left by earlier files must not run against this file's state.
  await drainOutbox()
}, 120_000)

afterAll(async () => {
  resetEventBus()
  toolRegistry.deleteByPrefix([ORG, "kernel"])
  manifestRegistry.delete([ORG, "kernel"])
  await sql`DELETE FROM kernel.attention_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.companies WHERE org_id = ${ORG}`
  await clearRedisPatterns([`app_idem:${ORG}:*`])
  await releaseTestLock()
})

async function person(seed: number, name: string): Promise<string> {
  return seedUserRow({
    id: uuid(seed),
    orgId: ORG,
    email: `oe-${seed}@test.com`,
    name,
    status: "active",
  })
}

async function company(name: string, owner: string | null): Promise<string> {
  const [row] = await withSystemDb("ownership-events-test-company", (db) =>
    db
      .insert(companies)
      .values({
        orgId: ORG,
        handle: `co-${crypto.randomUUID().slice(0, 8)}`,
        name,
        ownerUserId: owner,
        orgAccess: "editor",
        createdBy: ADMIN,
      })
      .returning({ id: companies.id }),
  )
  return (row as { id: string }).id
}

async function post(path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as any }
}

const giveCompanies = (companyIds: string[], ownerUserId: string | null) =>
  post("/api/apps/kernel/tools/companies_write", { companyIds, ownerUserId })

const statusOf = async (id: string) =>
  ((await sql`SELECT status FROM kernel.users WHERE id = ${id}`)[0] as { status: string }).status

const ownerOf = async (id: string) =>
  (
    (await sql`SELECT owner_user_id FROM kernel.companies WHERE id = ${id}`)[0] as {
      owner_user_id: string | null
    }
  ).owner_user_id

async function unreadRows(kind: string, entityId: string) {
  return sql`
    SELECT user_id, summary, metadata FROM kernel.attention_events
    WHERE org_id = ${ORG} AND kind = ${kind} AND entity_id = ${entityId} AND read_at IS NULL`
}

describe("a company's change of manager, through the routes and the event bus", () => {
  it("the previous manager is told who gave their companies to whom", async () => {
    const previous = await person(1, "Léon Prévost")
    const next = await person(2, "Inès Martin")
    const a = await company("Fonderie Alba", previous)
    const b = await company("Verrerie Bleue", previous)

    const res = await giveCompanies([a, b], next)
    expect(res.status).toBe(200)
    expect(await ownerOf(a)).toBe(next)
    // Nothing is written before the committed events are published.
    expect(await unreadRows(HANDOVER_KIND, previous)).toHaveLength(0)

    await drainOutbox()
    const told = await unreadRows(HANDOVER_KIND, previous)
    expect(told).toHaveLength(1)
    expect(told[0]!.user_id).toBe(previous)
    expect(told[0]!.summary).toBe(
      "Nadia Admin gave Fonderie Alba and Verrerie Bleue to Inès Martin",
    )
    expect((told[0]!.metadata as { changedBy: { id: string } }).changedBy.id).toBe(ADMIN)
    // The new manager and the admin who made the change get no such row.
    expect(await unreadRows(HANDOVER_KIND, next)).toHaveLength(0)
    expect(await unreadRows(HANDOVER_KIND, ADMIN)).toHaveLength(0)
  })

  it("the unowned row counts down as companies get a manager, and goes on reactivation", async () => {
    const leaver = await person(10, "Léa Fontaine")
    const taker = await person(11, "Hugo Bernard")
    const first = await company("Fonderie Une", leaver)
    const second = await company("Fonderie Deux", leaver)

    const res = await post(`/api/admin/users/${leaver}/deactivate`, { accountsTo: null })
    expect(res.status).toBe(200)
    expect(res.body.data.companies.withoutManager).toHaveLength(2)
    await drainOutbox()
    let rows = await unreadRows(UNOWNED_KIND, leaver)
    expect(rows.map((r) => r.user_id)).toEqual([ADMIN])
    expect(rows[0]!.summary).toBe("2 companies have no account manager since Léa Fontaine left")

    expect((await giveCompanies([first], taker)).status).toBe(200)
    await drainOutbox()
    rows = await unreadRows(UNOWNED_KIND, leaver)
    expect(rows[0]!.summary).toBe("1 company has no account manager since Léa Fontaine left")

    expect((await giveCompanies([second], taker)).status).toBe(200)
    await drainOutbox()
    expect(await unreadRows(UNOWNED_KIND, leaver)).toHaveLength(0)

    // Someone else leaves companies behind, then comes back: their row goes.
    const back = await person(12, "Paul Retour")
    await company("Retour SARL", back)
    expect((await post(`/api/admin/users/${back}/deactivate`, { accountsTo: null })).status).toBe(
      200,
    )
    await drainOutbox()
    expect(await unreadRows(UNOWNED_KIND, back)).toHaveLength(1)
    expect((await post(`/api/admin/users/${back}/reactivate`, {})).status).toBe(200)
    expect(await unreadRows(UNOWNED_KIND, back)).toHaveLength(1)
    await drainOutbox()
    expect(await unreadRows(UNOWNED_KIND, back)).toHaveLength(0)
  })

  it("the admin route refuses to deactivate a manager without saying who takes their companies", async () => {
    const manager = await person(20, "Chloé Garnier")
    const co = await company("Maison Garnier", manager)

    const refused = await post(`/api/admin/users/${manager}/deactivate`, {})
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe("accounts_to_required")
    expect(refused.body.error.message).toContain("manages 1 company")
    expect(refused.body.error.message).toContain("Nothing was changed")
    expect(await statusOf(manager)).toBe("active")
    expect(await ownerOf(co)).toBe(manager)

    // Someone who manages nothing is deactivated with no question.
    const plain = await person(21, "Marc Simple")
    const done = await post(`/api/admin/users/${plain}/deactivate`, {})
    expect(done.status).toBe(200)
    expect(await statusOf(plain)).toBe("deactivated")
  })
})
