// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A change of a company's account manager is a row on the company's timeline,
// on the real path: the change commits its event, the outbox's audit consumer
// writes the audit row, and the timeline reads it back as the reader, pages
// with the other sources' cursor and shows nothing to a reader who cannot see
// the company.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { companies } from "~/db/schema/kernel"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { readActivity } from "~/modules/contacts/activity"
import { setCompanyManager } from "~/modules/contacts/companies"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const ADMIN = crypto.randomUUID()
const ANA = crypto.randomUUID()
const TOM = crypto.randomUUID()
const OUTSIDER = crypto.randomUUID()
const tag = ORG.slice(0, 8)

const admin: UserContext = {
  actorType: "user",
  userId: ADMIN,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
}
const outsider: UserContext = {
  actorType: "user",
  userId: OUTSIDER,
  orgId: ORG,
  scopes: ["kernel:companies:read"],
  dimensionGrants: {},
}

async function company(name: string, orgAccess: "editor" | "none"): Promise<string> {
  const [row] = await withSystemDb("manager-activity-test-company", (db) =>
    db
      .insert(companies)
      .values({
        orgId: ORG,
        handle: `co-${tag}-${name}`,
        name,
        orgAccess,
        createdBy: ADMIN,
      })
      .returning({ id: companies.id }),
  )
  return (row as { id: string }).id
}

async function give(companyId: string, ownerUserId: string | null): Promise<void> {
  const result = await withRlsContext(admin, (tx) =>
    setCompanyManager(tx, { orgId: ORG, userId: ADMIN, companyIds: [companyId], ownerUserId }),
  )
  expect({ moved: result.moved.map((m) => m.id), skipped: result.skipped }).toEqual({
    moved: [companyId],
    skipped: [],
  })
  await drainOutbox()
}

let northwind = ""
let other = ""
let hidden = ""

beforeAll(async () => {
  await acquireTestLock()
  await seedOrgRow({ id: ORG, name: "Manager Timeline Org", slug: `manager-timeline-${tag}` })
  for (const [id, name] of [
    [ADMIN, "Nadia Admin"],
    [ANA, "Ana Lopez"],
    [TOM, "Tom Kerr"],
    [OUTSIDER, "Olga Field"],
  ] as const) {
    await seedUserRow({
      id,
      orgId: ORG,
      email: `${name.split(" ")[0]}-${tag}@test.example`,
      name,
      status: "active",
    })
  }
  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  registerEventSubscribers({
    bufferAndBroadcast: async () => {},
    broadcast: async () => {},
    closeConnectionsForUser: () => {},
  } as never)
  await drainOutbox()

  northwind = await company("northwind", "editor")
  other = await company("other", "editor")
  hidden = await company("hidden", "none")
  await give(northwind, ANA)
  await give(other, TOM)
  await give(northwind, TOM)
  await give(northwind, null)
  // A restricted company only its creator sees: they take it on themselves.
  await give(hidden, ADMIN)
}, 120_000)

afterAll(async () => {
  resetEventBus()
  await sql`DELETE FROM kernel.attention_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`.catch(() => undefined)
  await sql`DELETE FROM kernel.companies WHERE org_id = ${ORG}`
  await releaseTestLock()
})

describe("a company's account manager changes on its timeline", () => {
  it("each change of manager is a timeline row naming who it went from and to, newest first", async () => {
    const page = await readActivity({ orgId: ORG, actor: admin, target: { companyId: northwind } })
    const rows = (page?.items ?? []).filter((r) => r.source === "company")
    expect(rows.map((r) => r.title)).toEqual([
      "Account manager removed (was Tom Kerr)",
      "Account manager changed from Ana Lopez to Tom Kerr",
      "Account manager set to Ana Lopez",
    ])
    expect(rows.every((r) => r.who === "Nadia Admin" && r.id.startsWith("company:"))).toBe(true)
    // Another company's change is not on this one's timeline.
    expect(
      rows.some((r) => r.title.includes("Tom Kerr") && r.title.startsWith("Account manager set")),
    ).toBe(false)
  })

  it("a reader who cannot see the company gets no timeline at all", async () => {
    expect(
      await readActivity({ orgId: ORG, actor: outsider, target: { companyId: hidden } }),
    ).toBeNull()
    const seen = await readActivity({ orgId: ORG, actor: admin, target: { companyId: hidden } })
    expect(seen?.items.map((r) => r.title)).toEqual(["Account manager set to Nadia Admin"])
  })

  it("the manager rows page by the shared cursor with no duplicate and no gap", async () => {
    const first = await readActivity({
      orgId: ORG,
      actor: admin,
      target: { companyId: northwind },
      limit: 2,
      source: "company",
    })
    expect(first?.items).toHaveLength(2)
    expect(first?.nextBefore).toBeTruthy()
    const second = await readActivity({
      orgId: ORG,
      actor: admin,
      target: { companyId: northwind },
      limit: 2,
      source: "company",
      before: first?.nextBefore,
    })
    expect(second?.items.map((r) => r.title)).toEqual(["Account manager set to Ana Lopez"])
    expect(second?.nextBefore).toBeNull()
    const ids = [...(first?.items ?? []), ...(second?.items ?? [])].map((r) => r.id)
    expect(new Set(ids).size).toBe(3)
  })

  it("another company's manager change is on that company's timeline only", async () => {
    const page = await readActivity({
      orgId: ORG,
      actor: admin,
      target: { companyId: other },
      source: "company",
    })
    expect(page?.items.map((r) => r.title)).toEqual(["Account manager set to Tom Kerr"])
  })
})
