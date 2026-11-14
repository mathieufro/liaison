// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The QA door onto the seven demo people.
//
// `seedDemoOrg` nulls every persona's `password_hash` after provisioning, which
// is exactly right for a public demo box: seven published logins on the open
// internet is a front door. It is the wrong shape for a private QA staging box,
// where the whole point of the seeded world is that a tester signs in AS Amina
// and walks the support desk she owns.
//
// `personaPassword` is that door, and this asserts both halves of it: the
// people can sign in through the product's own `login()` when it is set, and
// asking for it on a box that IS the public demo is REFUSED before a single row
// is written.
//
// Locally: run it against `liaison_hardening_test`, never a shared database.
//   DATABASE_URL=postgres://liaison_app:liaison_app@localhost:5432/liaison_hardening_test \
//     bun test src/seed/tiers/demo/seed-personas-password.integration.test.ts --timeout 600000
import { beforeAll, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { login } from "~/modules/auth/auth"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { DEMO_WORLD, type DemoWorld } from "~/seed/world/fiction"
import { demoPersonEmail, seedDemoOrg } from "./seed-org"

const DB_URL = process.env.DATABASE_URL ?? ""
const QA_PASSWORD = "qa-persona-password-1"

/**
 * A small world: elodie (who owns the org as `founder_admin`), amina, and one
 * person for every other role, because the org's domain access names each role
 * and the seeder refuses a role no one holds. The layer seeders are not run
 * here, so the only thing that matters is that one person owns the org and the
 * others do not: the passwordless rule applies to all, and the flag has to lift
 * it for all.
 */
const SMALL_WORLD: DemoWorld = {
  ...DEMO_WORLD,
  team: DEMO_WORLD.team.filter(
    (p, i, all) =>
      p.key === "elodie" || p.key === "amina" || all.findIndex((q) => q.role === p.role) === i,
  ),
}

beforeAll(() => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test\b/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database: use liaison_hardening_test")
  }
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(mkdtempSync(path.join(tmpdir(), "demo-pw-")), "apps")
  }
})

async function passwordHashFor(orgId: string, email: string): Promise<string | null> {
  return withSystemDb("demo-persona-password-test", async (tx) => {
    const result = await tx.execute(
      sql`SELECT password_hash AS hash FROM kernel.users
          WHERE org_id = ${orgId}::uuid AND email = ${email.toLowerCase()}`,
    )
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    const hash = (rows[0] as { hash: unknown } | undefined)?.hash
    return typeof hash === "string" ? hash : null
  })
}

describe("seedDemoOrg persona passwords", () => {
  const slug = "demo-persona-pw-off"
  const withPwSlug = "demo-persona-pw-on"

  it("leaves the people passwordless by default", async () => {
    const org = await seedDemoOrg({
      orgSlug: slug,
      variant: "visitor",
      world: SMALL_WORLD,
      apps: [],
    })
    const amina = demoPersonEmail(slug, "amina")
    expect(await passwordHashFor(org.orgId, amina)).toBeNull()
    await expect(login(amina, QA_PASSWORD, slug)).rejects.toThrow()
  })

  it("gives every person the supplied password when one is asked for", async () => {
    const org = await seedDemoOrg({
      orgSlug: withPwSlug,
      variant: "visitor",
      world: SMALL_WORLD,
      apps: [],
      personaPassword: QA_PASSWORD,
    })
    for (const person of SMALL_WORLD.team) {
      const email = demoPersonEmail(withPwSlug, person.key)
      expect(await passwordHashFor(org.orgId, email)).not.toBeNull()
      const result = await login(email, QA_PASSWORD, withPwSlug)
      expect("accessToken" in result).toBe(true)
    }
  })

  it("re-pins the password on a RE-SEED of an org whose people were nulled", async () => {
    // `ensureUser` never resets an existing password, so an org seeded once
    // without the flag would stay unreachable if the seeder only handed the
    // password to the provisioner. The re-seed below is the whole point of the
    // flag on a box that was already seeded.
    const org = await seedDemoOrg({
      orgSlug: slug,
      variant: "visitor",
      world: SMALL_WORLD,
      apps: [],
      personaPassword: QA_PASSWORD,
    })
    const amina = demoPersonEmail(slug, "amina")
    const result = await login(amina, QA_PASSWORD, slug)
    expect("accessToken" in result).toBe(true)
    expect(await passwordHashFor(org.orgId, amina)).not.toBeNull()
  })

  it("REFUSES on a demo-mode box, before it writes anything", async () => {
    // A slug this run alone has ever used: an org left behind by an EARLIER
    // run would otherwise be read as this run's write and mask a regression.
    const refusedSlug = `demo-persona-pw-refused-${randomBytes(4).toString("hex")}`
    DemoModeTestAccess.set(true)
    try {
      await expect(
        seedDemoOrg({
          orgSlug: refusedSlug,
          variant: "visitor",
          world: SMALL_WORLD,
          apps: [],
          personaPassword: QA_PASSWORD,
        }),
      ).rejects.toThrow(/demo mode/i)
    } finally {
      DemoModeTestAccess.set(null)
    }
    const existed = await withSystemDb("demo-persona-password-test-refused", async (tx) => {
      const result = await tx.execute(
        sql`SELECT id FROM kernel.organizations WHERE slug = ${refusedSlug}`,
      )
      const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      return rows.length
    })
    expect(existed).toBe(0)
  })
})
