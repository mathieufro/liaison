// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The software world's visitor workspace ended: seeded as a visitor's, its
// card-payments stand-in holding outside objects, then past its time and
// reaped. Nothing of it remains: no row in any table that names the org (the
// app tables of the payments and invoicing apps included), no outside object
// at the stand-in, no search document, no stored object, no Redis key.
//
//   bun run scripts/test-run.ts demo-seed --file src/seed/worlds/saas/stripe-world-reset.saas.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEMO_WORLD_NEEDS } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { bullPrefix, redisBullMQ } from "~/lib/redis"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { purgeDemoOrg } from "~/modules/demo/demo-reset"
import { countOutsideObjects, putOutsideObjects } from "~/modules/demo/worlds/saas/payments/overlay"
import { residueScan } from "~/modules/org/purge/residue"
import { type SeedDemoWorldResult, seedDemoWorld } from "~/seed/tiers/demo/seed-demo"
import { installFromDist } from "../../../../test-support/seed/install-dist-apps"

const CATALOG_WORLD_APPS = ["invoicing", "stripe"]
const SLUG = `saas-world-reset-${Date.now().toString(36)}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** The residue query the year simulator's door run reads too. */
const RESIDUE_SQL = readFileSync(path.join(import.meta.dir, "..", "org-residue.sql"), "utf8")

/** Every Redis key naming the org (the queue library's own left out), as the purge scans them. */
async function orgRedisKeysLeft(orgId: string): Promise<string[]> {
  const out: string[] = []
  let cursor = "0"
  do {
    const [next, keys] = await redisBullMQ.scan(cursor, "MATCH", `*${orgId}*`, "COUNT", 1000)
    cursor = next
    out.push(...keys.filter((k) => !k.startsWith(`${bullPrefix}:`)))
  } while (cursor !== "0")
  return out
}

type Row = Record<string, unknown>
const rowsOf = (r: unknown): Row[] =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Row[]

/** Tables still holding rows of `orgId`, by the residue query. */
async function residueRows(orgId: string): Promise<Row[]> {
  if (!UUID.test(orgId)) throw new Error(`not an org id: ${orgId}`)
  const query = RESIDUE_SQL.replaceAll("$1", `'${orgId}'`)
  return withSystemDb("saas-world-reset-residue", async (tx) =>
    rowsOf(await tx.execute(sql.raw(query))),
  )
}

let world: SeedDemoWorldResult
let appsRoot: string | null = null

beforeAll(async () => {
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    appsRoot = mkdtempSync(path.join(tmpdir(), "saas-world-reset-"))
    process.env.LIAISON_APPS_DIR = path.join(appsRoot, "apps")
  }
  for (const app of CATALOG_WORLD_APPS) await installFromDist(app, crypto.randomUUID())
  world = await seedDemoWorld({
    orgSlug: SLUG,
    worldId: "saas",
    variant: "visitor",
    owner: { email: `owner@${SLUG}.example`, name: "Visitor Owner", password: "SaasReset1!Owner" },
    needs: [...DEMO_WORLD_NEEDS.saas],
  })
  // A cancellation the visitor made at the stand-in: state held outside the database.
  await putOutsideObjects(world.orgId, [
    { id: "sub_resetprobe", object: "subscription", status: "canceled" },
  ])
}, 2_400_000)

afterAll(() => {
  DemoModeTestAccess.set(null)
  if (appsRoot) rmSync(appsRoot, { recursive: true, force: true })
})

describe("the software world's workspace, ended and reaped", () => {
  it("holds rows in the payments and invoicing apps and outside objects before the reaper", async () => {
    expect(world.failures).toEqual([])
    const tables = (await residueRows(world.orgId)).map((r) => `${r.schema_name}.${r.table_name}`)
    const appTables = (app: string) => tables.filter((t) => t.startsWith(`app_${app}.`))
    expect(appTables("stripe").length).toBeGreaterThan(0)
    expect(appTables("invoicing").length).toBeGreaterThan(0)
    expect(await countOutsideObjects(world.orgId)).toBe(1)
  })

  it("the reaper leaves no row in any table, no outside object, no search document and nothing stored", async () => {
    const now = new Date()
    // Two days past a day's time.
    await markOrgAsDemo(
      world.orgId,
      visitorMarker(24, new Date(now.getTime() - 72 * 3_600_000), [...DEMO_WORLD_NEEDS.saas], {
        worldId: "saas",
      }),
    )
    const result = await purgeDemoOrg(world.orgId, now)
    expect(result.purged).toBe(true)

    expect(await residueRows(world.orgId)).toEqual([])
    expect(await countOutsideObjects(world.orgId)).toBe(0)
    const scan = await residueScan(world.orgId)
    expect(scan.orgRow).toBe(false)
    expect({
      rows: scan.rows,
      searchDocuments: scan.searchDocuments,
      objects: scan.objects,
      redisKeys: (await orgRedisKeysLeft(world.orgId)).length,
      jobSchedulers: scan.jobSchedulers,
    }).toEqual({ rows: {}, searchDocuments: 0, objects: 0, redisKeys: 0, jobSchedulers: 0 })
  }, 600_000)
})
