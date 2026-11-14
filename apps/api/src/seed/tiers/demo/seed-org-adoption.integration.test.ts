// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seeder never makes a real org a demo org. The demo marker makes an org's
// legal records purgeable at expiry, so the seeder writes it only on an org
// that already carries it or that the run created itself. An existing org
// without the marker is refused, before any write, whichever way the seeder is
// reached; there is no flag past it. (Re-seeding an org that IS marked, the
// reserved org's nightly path, is covered by seed-org.integration.test.ts.)
//
//   bun run scripts/test-run.ts demo-seed --file "$PWD/apps/api/src/seed/tiers/demo/seed-org-adoption.integration.test.ts"
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, loadDemoMarker } from "~/modules/demo/demo-org"
import { claimOrgSlug, findOrgIdBySlug, hasOrgSlugClaim } from "~/seed/factories/org/org"
import { runSeedDemoCli } from "./seed-demo"
import { demoMarkRefusal, seedDemoOrg } from "./seed-org"

const SLUG = `demo-adoption-${Math.random().toString(36).slice(2, 8)}`
const INTERRUPTED_SLUG = `${SLUG}-interrupted`
const DB_URL = process.env.DATABASE_URL ?? ""

type Rows = Array<Record<string, unknown>>
function rowsOf(result: unknown): Rows {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as Rows
}

let orgId = ""

async function marker(): Promise<unknown> {
  invalidateDemoMarker(orgId)
  return loadDemoMarker(orgId)
}

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev/.test(DB_URL)) throw new Error("refusing to write to liaison_dev")
  // A real workspace that merely shares the slug an operator typed.
  const rows = rowsOf(
    await withSystemDb("demo-adoption-test-org", (tx) =>
      tx.execute(
        sql`INSERT INTO kernel.organizations (name, slug) VALUES ('Real Tenant', ${SLUG}) RETURNING id`,
      ),
    ),
  )
  orgId = String(rows[0]?.id ?? "")
  expect(orgId).not.toBe("")
})

afterAll(async () => {
  await withSystemDb("demo-adoption-test-cleanup", (tx) =>
    tx.execute(sql`DELETE FROM kernel.organizations WHERE slug = ${SLUG}`),
  )
  // The interrupted org is a marked demo org by now: its rows go with the demo purge path.
  await withSystemDb("demo-adoption-test-cleanup-claim", (tx) =>
    tx.execute(sql`DELETE FROM kernel.system_config WHERE key LIKE ${`seed.org-claim:${SLUG}%`}`),
  )
})

describe("demoMarkRefusal", () => {
  it("allows an org that already carries the marker, or one this run created", () => {
    expect(demoMarkRefusal({ orgSlug: "a", hasMarker: true, createdThisRun: false })).toBeNull()
    expect(demoMarkRefusal({ orgSlug: "a", hasMarker: false, createdThisRun: true })).toBeNull()
  })

  it("refuses an unmarked org it did not create, naming the slug and the reason", () => {
    const refusal = demoMarkRefusal({ orgSlug: "acme", hasMarker: false, createdThisRun: false })
    expect(refusal).toContain("'acme'")
    expect(refusal).toContain("NOT a demo org")
    expect(refusal).toContain("did not create it")
  })
})

describe("seeding an existing org that is not a demo org", () => {
  it("is refused, and the org is left unmarked", async () => {
    await expect(seedDemoOrg({ orgSlug: SLUG, variant: "visitor" })).rejects.toThrow(
      new RegExp(`'${SLUG}'.*NOT a demo org`),
    )
    expect(await marker()).toBeNull()
  })

  it("is never deleted by a reset on a private box: the replace refuses it and the org stays", async () => {
    DemoModeTestAccess.set(false)
    try {
      await expect(
        runSeedDemoCli(["--slug", SLUG, "--world", "saas", "--variant", "visitor", "--reset"]),
      ).rejects.toThrow(new RegExp(`'${SLUG}': it is not a demo org`))
    } finally {
      DemoModeTestAccess.set(null)
    }
    expect(await findOrgIdBySlug(SLUG)).toBe(orgId)
    expect(await marker()).toBeNull()
  })

  it("is refused from the CLI too, whatever flag the operator adds", async () => {
    await expect(
      runSeedDemoCli(["--slug", SLUG, "--variant", "visitor", "--adopt-non-demo-org"]),
    ).rejects.toThrow(new RegExp(`'${SLUG}'.*NOT a demo org`))
    expect(await marker()).toBeNull()
  })
})

describe("a seed killed between creating the org and marking it", () => {
  it("leaves a claim the next run recognises: the half-made org is made again, marked, the claim released", async () => {
    // What the killed run left behind: its claim, and the org row with no marker.
    await claimOrgSlug(INTERRUPTED_SLUG)
    const rows = rowsOf(
      await withSystemDb("demo-adoption-test-interrupted-org", (tx) =>
        tx.execute(
          sql`INSERT INTO kernel.organizations (name, slug) VALUES ('Resonant Audio Labs', ${INTERRUPTED_SLUG}) RETURNING id`,
        ),
      ),
    )
    const interruptedId = String(rows[0]?.id ?? "")

    const org = await seedDemoOrg({ orgSlug: INTERRUPTED_SLUG, variant: "visitor" })
    expect(org.orgId).not.toBe(interruptedId)
    expect(org.people.length).toBe(7)
    invalidateDemoMarker(org.orgId)
    expect((await loadDemoMarker(org.orgId))?.variant).toBe("visitor")
    expect(await hasOrgSlugClaim(INTERRUPTED_SLUG)).toBe(false)
  }, 300_000)

  it("leaves no claim behind after a run that completes", async () => {
    expect(await hasOrgSlugClaim(SLUG)).toBe(false)
  })
})
