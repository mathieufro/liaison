// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The software world seeded by hand on a private box, with no visitor account:
// `liaison seed --tier demo --world saas --variant visitor` names no owner, so
// the owner's routines run as the org's admin, with the admin's own agent.
//
//   bun run scripts/test-run.ts demo-seed --file src/seed/worlds/saas/seed-without-owner.saas.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { type SeedDemoWorldResult, seedDemoWorld } from "~/seed/tiers/demo/seed-demo"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"

const BOARD_DATE = new Date("2026-11-09T08:30:00.000Z")
const ORG_SLUG = `saas-no-owner-${Date.now().toString(36)}`

let world: SeedDemoWorldResult
let appsRoot: string | null = null

beforeAll(async () => {
  if (!process.env.LIAISON_APPS_DIR) {
    appsRoot = mkdtempSync(path.join(tmpdir(), "saas-no-owner-"))
    process.env.LIAISON_APPS_DIR = path.join(appsRoot, "apps")
  }
  for (const app of ["invoicing", "stripe"]) await installFromDist(app, crypto.randomUUID())
  world = await seedDemoWorld({
    orgSlug: ORG_SLUG,
    worldId: "saas",
    variant: "visitor",
    baseTime: BOARD_DATE,
  })
}, 2_400_000)

afterAll(() => {
  if (appsRoot) rmSync(appsRoot, { recursive: true, force: true })
})

describe("the software world seeded with no visitor account", () => {
  it("seeds in full, the owner's morning brief running as the admin with the admin's own agent", async () => {
    expect(world.org.ownerUserId).toBeFalsy()
    expect(world.failures).toEqual([])
    expect(world.complete).toBe(true)
    const admin = world.org.people.find((p) => p.userId === world.org.adminUserId)
    if (!admin) throw new Error("the admin is not one of the seeded people")
    const rows = await withPrivilegedDb(world.orgId, "saas-no-owner-test", async (tx) => {
      const r = await tx.execute(
        sql`SELECT owner_user_id::text AS owner, owner_agent_id::text AS agent
              FROM kernel.routines WHERE org_id = ${world.orgId}::uuid AND name = 'Morning brief'`,
      )
      return (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<
        Record<string, unknown>
      >
    })
    expect(rows).toEqual([{ owner: admin.userId, agent: admin.personalAgentId }])
  }, 600_000)
})
