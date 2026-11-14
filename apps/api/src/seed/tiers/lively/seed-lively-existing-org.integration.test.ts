// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The lively tier seeded into an org someone else made, with the caller's own
// people in the world's seats: the org is never marked as a demo org and keeps
// its name; a member already at a seat's address is adopted there (same
// password, own roles kept, the seat's role added on top); a seat at a new address is created under the
// caller's name; the world's activity lands on the adopted member's seat; the
// commerce part stays out when asked; a bad overlay is refused before any write.
//
//   bun run scripts/test-run.ts demo-seed --file "$PWD/apps/api/src/seed/tiers/lively/seed-lively-existing-org.integration.test.ts"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, loadDemoMarker } from "~/modules/demo/demo-org"
import { person, secondOrg } from "~/seed/tiers/minimal"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"
import { livelyWorldWith, type SeedLivelyResult, seedLivelyWorld } from "./seed-lively"

const DB_URL = process.env.DATABASE_URL ?? ""
const CATALOG_DEMO_APPS = ["invoicing", "social", "pennylane", "boxtal", "shopify", "monitoring"]

type Rows = Array<Record<string, unknown>>
const rowsOf = (r: unknown): Rows =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Rows

const MEMBER_EMAIL = `desk-${crypto.randomUUID().slice(0, 8)}@harness.test`
const NEW_EMAIL = `new-${crypto.randomUUID().slice(0, 8)}@harness.test`

let org: { orgId: string; adminUserId: string }
let memberId: string
let memberBefore: { hash: string; roles: string }
let result: SeedLivelyResult

async function memberState(userId: string) {
  const [row] = rowsOf(
    await withSystemDb("lively-existing-test-member", (tx) =>
      tx.execute(sql`
        SELECT u.password_hash AS hash,
               coalesce(string_agg(r.name, ',' ORDER BY r.name), '') AS roles
        FROM kernel.users u
        LEFT JOIN kernel.user_roles ur ON ur.user_id = u.id
        LEFT JOIN kernel.roles r ON r.id = ur.role_id
        WHERE u.id = ${userId}::uuid GROUP BY u.password_hash`),
    ),
  )
  return { hash: String(row?.hash), roles: String(row?.roles) }
}

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database")
  }
  DemoModeTestAccess.set(false)
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(mkdtempSync(path.join(tmpdir(), "lively-")), "apps")
  }
  for (const app of CATALOG_DEMO_APPS) await installFromDist(app, crypto.randomUUID())

  org = await secondOrg({ name: "Harness Org" })
  const member = await person(org.orgId, {
    role: "member",
    name: "Desk Person",
    email: MEMBER_EMAIL,
  })
  memberId = member.id
  memberBefore = await memberState(memberId)

  const [admin] = rowsOf(
    await withSystemDb("lively-existing-test-admin", (tx) =>
      tx.execute(sql`SELECT email FROM kernel.users WHERE id = ${org.adminUserId}::uuid`),
    ),
  )
  result = await seedLivelyWorld({
    existingOrg: org,
    people: [
      { seat: "elodie", name: "Harness Admin", email: String(admin?.email) },
      { seat: "amina", name: "Desk Person", email: MEMBER_EMAIL },
      { seat: "lucas", name: "New Person", email: NEW_EMAIL, jobTitle: "Night desk" },
    ],
    personaPassword: "Lively-Harness-1!",
    withoutCommerce: true,
  })
}, 1_200_000)

afterAll(() => {
  DemoModeTestAccess.set(null)
})

describe("the lively tier in an existing org", () => {
  it("seeds the whole world into that org, ten people", () => {
    expect(result.world.failures).toEqual([])
    expect(result.complete).toBe(true)
    expect(result.world.orgId).toBe(org.orgId)
    expect(result.world.org.people.length).toBe(10)
  })

  it("never marks the org as a demo org and keeps its name and its commercial identity", async () => {
    invalidateDemoMarker(org.orgId)
    expect(await loadDemoMarker(org.orgId)).toBeNull()
    const [row] = rowsOf(
      await withSystemDb("lively-existing-test-org", (tx) =>
        tx.execute(
          sql`SELECT name, settings -> 'commercialIdentity' AS identity
              FROM kernel.organizations WHERE id = ${org.orgId}::uuid`,
        ),
      ),
    )
    expect(row?.name).toBe("Harness Org")
    // The world company's identity is not the org owner's to be given.
    expect(row?.identity ?? null).toBeNull()
  })

  it("adopts the members in their seats: own password and roles kept, seat role added", async () => {
    const seats = result.world.org.peopleByKey
    expect(seats.elodie?.userId).toBe(org.adminUserId)
    expect(seats.amina?.userId).toBe(memberId)
    expect(memberBefore.roles).toBe("member")
    expect(await memberState(memberId)).toEqual({
      hash: memberBefore.hash,
      roles: "member,support",
    })
  })

  it("creates a seat at a new address under the caller's name and role", async () => {
    const lucas = result.world.org.peopleByKey.lucas
    expect(lucas?.email).toBe(NEW_EMAIL)
    const [row] = rowsOf(
      await withSystemDb("lively-existing-test-new", (tx) =>
        tx.execute(sql`SELECT name, password_hash IS NOT NULL AS has_password
                       FROM kernel.users WHERE id = ${lucas?.userId}::uuid`),
      ),
    )
    expect(row?.name).toBe("New Person")
    expect(row?.has_password).toBe(true)
    expect((await memberState(lucas?.userId as string)).roles).toBe("support")
  })

  it("writes the world's activity for the adopted member's seat", async () => {
    const [row] = rowsOf(
      await withSystemDb("lively-existing-test-activity", (tx) =>
        tx.execute(sql`
          SELECT
            (SELECT count(*)::int FROM kernel.messages
              WHERE org_id = ${org.orgId}::uuid AND author_id = ${memberId}::uuid) AS messages,
            (SELECT count(*)::int FROM kernel.attention_events
              WHERE org_id = ${org.orgId}::uuid AND user_id = ${memberId}::uuid) AS attention`),
      ),
    )
    expect(Number(row?.messages)).toBeGreaterThan(0)
    expect(Number(row?.attention)).toBeGreaterThan(0)
  })

  it("leaves the commerce part out on request", async () => {
    expect(result.world.commerce).toBeNull()
    const [row] = rowsOf(
      await withSystemDb("lively-existing-test-commerce", (tx) =>
        tx.execute(
          sql`SELECT count(*)::int AS n FROM app_invoicing.documents WHERE org_id = ${org.orgId}::uuid`,
        ),
      ),
    )
    expect(Number(row?.n)).toBe(0)
  })

  it("refuses a bad overlay and a replace before any write", async () => {
    expect(() => livelyWorldWith([{ seat: "nobody", name: "X", email: "x@harness.test" }])).toThrow(
      /no seat 'nobody'/,
    )
    expect(() =>
      livelyWorldWith([
        { seat: "amina", name: "A", email: "a@harness.test" },
        { seat: "amina", name: "B", email: "b@harness.test" },
      ]),
    ).toThrow(/given twice/)
    expect(() =>
      livelyWorldWith([
        { seat: "amina", name: "A", email: "same@harness.test" },
        { seat: "lucas", name: "B", email: "SAME@harness.test" },
      ]),
    ).toThrow(/given twice/)
    await expect(seedLivelyWorld({ existingOrg: org, replace: true })).rejects.toThrow(
      /refused for an existing org/,
    )
  })
})
