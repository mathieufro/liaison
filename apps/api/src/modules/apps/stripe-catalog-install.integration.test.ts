// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The payments connector as an operator gets it: built to its `.liaisonapp`,
// baked into the app catalog, installed from the catalog on a fresh org. It
// registers there (live registries, an active app row, every mirror table), and
// erasing a person keeps the mirrored customer, a legal record, while the id of
// the person who matched it is anonymized.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import {
  appBridgeManifestRegistry,
  manifestRegistry,
  resetAppRegistries,
} from "~/modules/apps/app-registries"
import { installCatalogApp } from "~/modules/apps/catalog"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { eraseUser } from "~/modules/erasure/erase-user"
import { insertSql } from "~/seed/factories/org/test-rows"
import { ensureBundledAppBuilt } from "~/tests/helpers/bundled-app-build"
import { createTestOrg } from "~/tests/helpers/org"
import { bakeIntoTestCatalog } from "~/tests/helpers/test-app-catalog"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "stripe"
const MIRROR_TABLES = [
  "stripe_customers",
  "stripe_subscriptions",
  "stripe_invoices",
  "stripe_payments",
  "stripe_refunds",
  "stripe_disputes",
  "stripe_mrr_events",
  "sync_state",
  "install_metadata",
  "webhook_deliveries",
]

let orgId: string
let adminId: string
let installRoot: string

async function removeInstall(): Promise<void> {
  await withSystemDb("stripe-catalog-install-cleanup", async (db) => {
    await db.delete(appsInstalled).where(eq(appsInstalled.name, APP))
    await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, APP))
  })
}

beforeAll(async () => {
  await acquireTestLock()
  installRoot = mkdtempSync(join(tmpdir(), "stripe-catalog-install-"))
  process.env.LIAISON_APPS_DIR = installRoot
  await removeInstall()
  orgId = (await createTestOrg()).id
  await ensureAppsForOrg(orgId)
  const [admin] = await sql<{ id: string }[]>`
    SELECT id FROM kernel.users WHERE org_id = ${orgId} ORDER BY created_at ASC LIMIT 1`
  if (!admin) throw new Error("the fresh org has no user")
  adminId = admin.id
  bakeIntoTestCatalog(ensureBundledAppBuilt(APP))
  await installCatalogApp({ orgId, name: APP, installedBy: adminId })
}, 240_000)

afterAll(async () => {
  await removeInstall()
  resetAppRegistries()
  rmSync(installRoot, { recursive: true, force: true })
  delete process.env.LIAISON_APPS_DIR
  await releaseTestLock()
})

describe("the payments connector installed from the catalog", () => {
  it("registers on a fresh org: live registries, an active app row and every mirror table", async () => {
    expect(manifestRegistry.get([orgId, APP])).toBeDefined()
    expect(appBridgeManifestRegistry.get([orgId, APP])).toBeDefined()
    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM kernel.apps WHERE org_id = ${orgId} AND name = ${APP}`
    expect(row?.status).toBe("active")
    const present = await sql<{ table: string }[]>`
      SELECT tablename AS table FROM pg_tables WHERE schemaname = 'app_stripe' ORDER BY tablename`
    expect(present.map((r) => r.table)).toEqual(expect.arrayContaining(MIRROR_TABLES))
  })

  it("erasing a user anonymizes their id in the new tables and keeps the customer record", async () => {
    const erased = crypto.randomUUID()
    const kept = crypto.randomUUID()
    for (const id of [erased, kept]) {
      await sql.unsafe(
        insertSql("kernel.users", {
          id,
          org_id: orgId,
          email: `matcher-${id.slice(0, 8)}@example.com`,
          password_hash: "x",
          name: "Matcher",
          status: "active",
        }),
      )
    }
    const customers = [
      { stripeId: `cus_erase_${erased.slice(0, 6)}`, matchBy: erased },
      { stripeId: `cus_keep_${kept.slice(0, 6)}`, matchBy: kept },
    ]
    for (const c of customers) {
      await sql.unsafe(
        insertSql("app_stripe.stripe_customers", {
          org_id: orgId,
          stripe_id: c.stripeId,
          email: "billing@client.example",
          match_method: "person",
          match_by: c.matchBy,
          stripe_updated: "2026-11-01T00:00:00Z",
          created_at_stripe: "2026-01-01T00:00:00Z",
        }),
      )
    }

    const res = await eraseUser(erased)
    expect(res.exitCode).toBe(0)

    const rows = await sql<{ stripe_id: string; match_by: string | null }[]>`
      SELECT stripe_id, match_by::text AS match_by FROM app_stripe.stripe_customers
      WHERE org_id = ${orgId} ORDER BY stripe_id`
    const byId = new Map(rows.map((r) => [r.stripe_id, r.match_by]))
    // The legal record stays; only the person's id leaves it.
    expect(byId.has(customers[0].stripeId)).toBe(true)
    expect(byId.get(customers[0].stripeId)).not.toBe(erased)
    // Another person's match is untouched.
    expect(byId.get(customers[1].stripeId)).toBe(kept)
  })
})
