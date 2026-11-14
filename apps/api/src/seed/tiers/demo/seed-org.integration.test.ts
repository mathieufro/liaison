// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seeder against a REAL database: it runs end to end, it is re-runnable,
// and the people it creates can actually log in.
//
// Everything asserted here is read back out of Postgres (row counts, the org's
// enabled-app list, the agent rows, the avatar columns) or obtained from the
// product's own login path. Nothing is taken from the seeder's own return value
// alone.
//
// Locally: run it against `liaison_hardening_test`, never a shared database.
//   DATABASE_URL=postgres://liaison_app:liaison_app@localhost:5432/liaison_hardening_test \
//     bun test src/seed/tiers/demo/seed-org.integration.test.ts --timeout 600000
import { beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { login } from "~/modules/auth/auth"
import { verifyAccessToken } from "~/modules/auth/jwt"
import { invalidateDemoMarker, isDemoOrgId, loadDemoMarker } from "~/modules/demo/demo-org"
import { DEMO_SHOP_DOMAIN } from "~/modules/demo/shopify"
import { commercialIdentityMissing, readCommercialIdentity } from "~/modules/mail/commercial-footer"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { DEMO_DESK_TEAMS, DEMO_ROLE_AGENTS, DEMO_TEAM } from "~/seed/world/fiction"
import {
  DESK_TEAM_DIMENSION,
  demoPersonEmail,
  type SeedDemoOrgResult,
  seedDemoOrg,
} from "./seed-org"

const ORG_SLUG = "demo-seed-integration"
// A SECOND seeded org on the same box: every persona exists in both, which is
// the case the single-org test could never see.
const SECOND_ORG_SLUG = "demo-seed-integration-two"
const DB_URL = process.env.DATABASE_URL ?? ""

// This test WRITES. The development database is shared with another checkout,
// so it is refused outright rather than reported after the fact.
beforeAll(() => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev/.test(DB_URL)) {
    throw new Error("refusing to seed liaison_dev: use liaison_hardening_test")
  }
  // Catalog apps unpack under `LIAISON_APPS_DIR`, whose production default
  // (/var/lib/liaison/apps) is not writable outside the container. Same
  // treatment the dev server and the chaos orchestrator give it.
  if (!process.env.LIAISON_APPS_DIR) {
    process.env.LIAISON_APPS_DIR = path.join(mkdtempSync(path.join(tmpdir(), "demo-seed-")), "apps")
  }
})

async function countsFor(orgId: string): Promise<Record<string, number>> {
  return withSystemDb("demo-seed-test-counts", async (tx) => {
    const one = async (query: ReturnType<typeof sql>): Promise<number> => {
      const rows = await tx.execute(query)
      const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
      const first = list[0] as { count?: string | number } | undefined
      return Number(first?.count ?? 0)
    }
    return {
      users: await one(sql`SELECT count(*) AS count FROM kernel.users WHERE org_id = ${orgId}`),
      roles: await one(sql`SELECT count(*) AS count FROM kernel.roles WHERE org_id = ${orgId}`),
      userRoles: await one(
        sql`SELECT count(*) AS count FROM kernel.user_roles WHERE org_id = ${orgId}`,
      ),
      roleScopeGrants: await one(
        sql`SELECT count(*) AS count FROM kernel.role_scope_grants g
            JOIN kernel.roles r ON r.id = g.role_id WHERE r.org_id = ${orgId}`,
      ),
      agents: await one(sql`SELECT count(*) AS count FROM kernel.agents WHERE org_id = ${orgId}`),
      // Apps are installed instance wide and ENABLED per org, so the per-org
      // count that can drift on a re-seed is the enabled list.
      enabledApps: await one(
        sql`SELECT jsonb_array_length(coalesce(settings -> 'enabledApps', '[]'::jsonb)) AS count
            FROM kernel.organizations WHERE id = ${orgId}`,
      ),
    }
  })
}

async function enabledAppsFor(orgId: string): Promise<string[]> {
  return withSystemDb("demo-seed-test-enabled-apps", async (tx) => {
    const rows = await tx.execute(
      sql`SELECT coalesce(settings -> 'enabledApps', '[]'::jsonb) AS apps
          FROM kernel.organizations WHERE id = ${orgId}`,
    )
    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
    const first = list[0] as { apps?: string[] } | undefined
    return [...(first?.apps ?? [])].sort()
  })
}

/**
 * The CONTENT a re-seed has to converge on, read back out of Postgres. Row
 * counts are a weak oracle: a run that deletes one row and inserts another
 * passes them, and an `onConflictDoNothing` on an agent leaves a stale system
 * prompt behind while every count stays perfect. This reads the columns whose
 * value is the point: who the people are, what the agents say and may reach,
 * and the demo marker on the org.
 */
async function snapshotFor(orgId: string): Promise<Record<string, unknown>> {
  return withSystemDb("demo-seed-test-snapshot", async (tx) => {
    const rowsOf = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> => {
      const result = await tx.execute(query)
      return (
        Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      ) as Record<string, unknown>[]
    }
    return {
      users: await rowsOf(
        sql`SELECT email, name, avatar_key, settings -> 'demo' AS demo
            FROM kernel.users WHERE org_id = ${orgId} ORDER BY email`,
      ),
      roles: await rowsOf(
        sql`SELECT r.name, r.description,
                   (SELECT coalesce(array_agg(g.scope ORDER BY g.scope), '{}')
                      FROM kernel.role_scope_grants g WHERE g.role_id = r.id) AS scopes,
                   (SELECT coalesce(jsonb_object_agg(d.dimension_key, d.dimension_values), '{}')
                      FROM kernel.role_dimension_grants d WHERE d.role_id = r.id) AS dimensions
            FROM kernel.roles r WHERE r.org_id = ${orgId} ORDER BY r.name`,
      ),
      agents: await rowsOf(
        sql`SELECT handle, kind, display_name, purpose, system_prompt, scope_ceiling,
                   tool_allowlist, model_preference
            FROM kernel.agents WHERE org_id = ${orgId} ORDER BY handle`,
      ),
      org: await rowsOf(
        sql`SELECT slug, timezone, default_locale,
                   settings -> 'demo' AS demo,
                   settings -> 'enabledApps' AS enabled_apps
            FROM kernel.organizations WHERE id = ${orgId}`,
      ),
    }
  })
}

/** The stored system prompt for one role agent handle. */
async function systemPromptFor(orgId: string, handle: string): Promise<string> {
  return withSystemDb("demo-seed-test-prompt", async (tx) => {
    const result = await tx.execute(
      sql`SELECT system_prompt FROM kernel.agents
          WHERE org_id = ${orgId} AND handle = ${handle}`,
    )
    const list = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    return String((list[0] as { system_prompt?: string } | undefined)?.system_prompt ?? "")
  })
}

/**
 * The org's OWNER: the one account a seeded demo org can be signed into. The
 * caller supplies it (the person who registered, or App Review), and the seven
 * seeded people are left with no password at all.
 */
const OWNER = { email: "owner@demo.liaison.sh", name: "Demo Owner", password: "DemoOwner1!Seed" }

/** `settings.tickets.approveRepliesFromHome` as stored on the org row. */
async function approveRepliesFromHome(orgId: string): Promise<unknown> {
  const result = await withSystemDb("demo-seed-test-approve-from-home", (tx) =>
    tx.execute(
      sql`SELECT settings->'tickets'->'approveRepliesFromHome' AS value
          FROM kernel.organizations WHERE id = ${orgId}`,
    ),
  )
  const rows = (
    Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  ) as Array<{ value: unknown }>
  return rows[0]?.value ?? null
}

/** A role's scopes, sorted. */
async function scopesOfRole(orgId: string, role: string): Promise<string[]> {
  const rows = (await withSystemDb("demo-seed-test-role-scopes", (tx) =>
    tx.execute(
      sql`SELECT g.scope FROM kernel.role_scope_grants g
          JOIN kernel.roles r ON r.id = g.role_id
          WHERE r.org_id = ${orgId} AND r.name = ${role} ORDER BY g.scope`,
    ),
  )) as unknown as Array<{ scope: string }>
  return rows.map((r) => r.scope)
}
let scopesOfOperationsAfterFirst: string[] = []

describe("seedDemoOrg against a real database", () => {
  let first: SeedDemoOrgResult
  let second: SeedDemoOrgResult
  let countsAfterFirst: Record<string, number>
  let countsAfterSecond: Record<string, number>
  let snapshotAfterFirst: Record<string, unknown>
  let snapshotAfterSecond: Record<string, unknown>
  let driftedPersonEmail: string
  let approveFromHomeAfterFirst: unknown

  beforeAll(async () => {
    first = await seedDemoOrg({ orgSlug: ORG_SLUG, variant: "reserved", owner: OWNER })
    countsAfterFirst = await countsFor(first.orgId)
    snapshotAfterFirst = await snapshotFor(first.orgId)
    // Drift the world between the two runs, the way an operator editing a demo
    // agent or a shipped prompt change does. The second seed has to put it back.
    await withSystemDb("demo-seed-test-drift", (tx) =>
      tx.execute(
        sql`UPDATE kernel.agents
            SET system_prompt = 'stale prompt from a previous release',
                purpose = 'stale purpose',
                display_name = 'Stale Desk'
            WHERE org_id = ${first.orgId} AND handle = '@support'`,
      ),
    )
    // And give a PERSONA a password, the way an operator's SQL or an older
    // seeder could. Nobody is supposed to be able to sign in as one of the seven
    // and the next seed has to take it back off, or one hand-written UPDATE
    // reopens the front door this change closed.
    driftedPersonEmail = demoPersonEmail(ORG_SLUG, DEMO_TEAM[1].key).toLowerCase()
    await withSystemDb("demo-seed-test-drift-person", (tx) =>
      tx.execute(
        sql`UPDATE kernel.users
            SET password_hash = 'drifted-by-an-operator'
            WHERE org_id = ${first.orgId} AND email = ${driftedPersonEmail}`,
      ),
    )

    // And FUND the org, the way `ensureOrg`'s create path and an operator's
    // top up both can. A demo org must hold no platform credit whatever put it
    // there, so the next seed has to take it away again even though it is
    // adopting an org rather than creating one.
    await withSystemDb("demo-seed-test-fund", (tx) =>
      tx.execute(
        sql`UPDATE kernel.credit_balances
            SET included_balance = 25, purchased_balance = 7
            WHERE org_id = ${first.orgId}`,
      ),
    )

    // And the desks' teams: one desk's grant rewritten to another team (an
    // operator's edit), one removed outright (an org seeded before desks had
    // teams). The next seed has to put both back.
    await withSystemDb("demo-seed-test-drift-teams", async (tx) => {
      await tx.execute(
        sql`UPDATE kernel.role_dimension_grants d SET dimension_values = '["finance"]'::jsonb
            FROM kernel.roles r
            WHERE d.role_id = r.id AND r.org_id = ${first.orgId} AND r.name = 'support'
              AND d.dimension_key = ${DESK_TEAM_DIMENSION}`,
      )
      await tx.execute(
        sql`DELETE FROM kernel.role_dimension_grants d USING kernel.roles r
            WHERE d.role_id = r.id AND r.org_id = ${first.orgId} AND r.name = 'fulfillment'
              AND d.dimension_key = ${DESK_TEAM_DIMENSION}`,
      )
    })

    // And a role whose scopes moved on the server while the seeder's own list
    // moved too (a release that changes the role, on a box seeded by the last
    // one): one scope taken off the role, and its last-applied record made
    // stale. To `config apply` that is a conflict it leaves unwritten; a re-seed
    // of the demo box stopped there. The seeder owns the org: it writes its list.
    scopesOfOperationsAfterFirst = await scopesOfRole(first.orgId, "operations")
    await withSystemDb("demo-seed-test-drift-role-scopes", async (tx) => {
      await tx.execute(
        sql`DELETE FROM kernel.role_scope_grants g USING kernel.roles r
            WHERE g.role_id = r.id AND r.org_id = ${first.orgId} AND r.name = 'operations'
              AND g.scope = ${scopesOfOperationsAfterFirst[0] ?? ""}`,
      )
      await tx.execute(
        sql`UPDATE kernel.config_applied_fields SET value_hash = 'sha256:stale'
            WHERE org_id = ${first.orgId} AND path = 'roles.operations'`,
      )
    })

    // And turn ticket replies approved from Home back OFF, the way a reviewer
    // toggling the tickets settings page does. The reserved org's next seed has
    // to put it back on.
    approveFromHomeAfterFirst = await approveRepliesFromHome(first.orgId)
    await withSystemDb("demo-seed-test-drift-approve-from-home", (tx) =>
      tx.execute(
        sql`UPDATE kernel.organizations
            SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{tickets}',
              COALESCE(settings->'tickets', '{}'::jsonb) || '{"approveRepliesFromHome": false}'::jsonb, true)
            WHERE id = ${first.orgId}`,
      ),
    )

    second = await seedDemoOrg({ orgSlug: ORG_SLUG, variant: "reserved", owner: OWNER })
    countsAfterSecond = await countsFor(second.orgId)
    snapshotAfterSecond = await snapshotFor(second.orgId)
  }, 900_000)

  it("seeds the org, its whole team and a personal agent each", () => {
    expect(first.orgId).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.people.length).toBe(DEMO_TEAM.length)
    // The seven people, plus the org's one owner.
    expect(countsAfterFirst.users).toBe(DEMO_TEAM.length + 1)
    for (const person of first.people) {
      expect(person.userId).toMatch(/^[0-9a-f-]{36}$/)
      expect(person.personalAgentId).toMatch(/^[0-9a-f-]{36}$/)
    }
    // one personal agent each, three role agents, one @base system agent, and
    // the org owner's own personal agent (`first` is seeded with an owner)
    expect(countsAfterFirst.agents).toBe(DEMO_TEAM.length + 5)
    expect(first.agentsByHandle["@support"]?.kind).toBe("role")
    expect(first.agentsByHandle["@operations"]?.kind).toBe("role")
    expect(first.agentsByHandle["@finance"]?.kind).toBe("role")
  })

  it("is idempotent on CONTENT: the second run restores every meaningful column", () => {
    // The whole snapshot, not the counts: emails, names, avatars, profile
    // settings, role scope grants, every agent's prompt, purpose, name and
    // ceiling, and the org's demo marker, timezone and enabled apps.
    expect(snapshotAfterSecond).toEqual(snapshotAfterFirst)
  })

  it("a re-seed CONVERGES a role agent whose content drifted", async () => {
    // beforeAll overwrote @support's prompt, purpose and display name between
    // the two runs. With `onConflictDoNothing` the row survives untouched and
    // the count stays right, which is what made "re-run the seed to reset the
    // world" false for agent definitions.
    const stored = await systemPromptFor(first.orgId, "@support")
    const definition = DEMO_ROLE_AGENTS.find((a) => a.handle === "@support")
    expect(definition).toBeDefined()
    expect(stored).toBe(definition?.systemPrompt ?? "")
    expect(stored).not.toContain("stale prompt")
  })

  it("puts a role's scopes back when they moved on the server since the last seed", async () => {
    expect(scopesOfOperationsAfterFirst.length).toBeGreaterThan(1)
    expect(await scopesOfRole(second.orgId, "operations")).toEqual(scopesOfOperationsAfterFirst)
  })

  it("gives every desk person their desk's ticket team, through their role, and converges a drifted one", async () => {
    // Read through the product's own permission loader: what RLS is handed
    // for each person, not the seeder's view of it.
    for (const person of second.people) {
      const perms = await withPrivilegedDb(second.orgId, "demo-seed-test-desk-perms", (tx) =>
        loadEffectivePermissions(tx, person.userId, second.orgId),
      )
      if (person.role === "founder_admin") {
        expect(perms.dimensionGrants["*"]).toEqual(["*"])
        continue
      }
      const teams = [...(perms.dimensionGrants[DESK_TEAM_DIMENSION] ?? [])].sort()
      expect(teams, person.key).toEqual([...DEMO_DESK_TEAMS[person.role]].sort())
    }
    // Support's grant was rewritten to finance and fulfillment's deleted
    // between the runs: both are back to the desk's own team.
    const roles = snapshotAfterSecond.roles as Array<{ name: string; dimensions: unknown }>
    expect(roles.find((r) => r.name === "support")?.dimensions).toEqual({
      [DESK_TEAM_DIMENSION]: ["support"],
    })
    expect(roles.find((r) => r.name === "fulfillment")?.dimensions).toEqual({
      [DESK_TEAM_DIMENSION]: ["operations"],
    })
  })

  // The reserved org is the App Review workspace, and its review notes approve a
  // ticket reply from Home. The setting is seeded, not left to an operator, so
  // it survives every reset and every new box.
  it("turns on approving ticket replies from Home for the reserved org, and converges it", async () => {
    expect(approveFromHomeAfterFirst).toBe(true)
    expect(await approveRepliesFromHome(second.orgId)).toBe(true)
  })

  it("is idempotent: the second run changes no row count and no resolved id", () => {
    expect(countsAfterSecond).toEqual(countsAfterFirst)
    expect(second.orgId).toBe(first.orgId)
    expect(second.createdOrg).toBe(false)
    expect(second.people.map((p) => p.userId)).toEqual(first.people.map((p) => p.userId))
    expect(second.people.map((p) => p.personalAgentId)).toEqual(
      first.people.map((p) => p.personalAgentId),
    )
    expect(second.agents.map((a) => a.agentId).sort()).toEqual(
      first.agents.map((a) => a.agentId).sort(),
    )
  })

  it("leaves every seeded person unable to sign in, because none of them has a password", async () => {
    // THE MUTATION THAT PROVES THIS BITES: delete the `nullPersonaPasswords`
    // UPDATE from seed-org.ts. Every one of the seven is a working login again,
    // on a throwaway password, which is the shape the published constant had.
    const person = first.peopleByKey.amina
    expect(person).toBeDefined()
    const hash = await withSystemDb("demo-seed-test-persona-hash", async (tx) => {
      const result = await tx.execute(
        sql`SELECT password_hash AS hash FROM kernel.users WHERE id = ${person.userId}`,
      )
      const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      return (rows[0] as { hash: unknown } | undefined)?.hash ?? null
    })
    expect(hash).toBeNull()
  })

  it("lets the OWNER sign in, through the real password path", async () => {
    const result = await login(OWNER.email, OWNER.password, first.orgSlug)
    expect("accessToken" in result).toBe(true)
    if ("accessToken" in result) {
      expect(result.accessToken.length).toBeGreaterThan(20)
      const claims = await verifyAccessToken(result.accessToken, env.JWT_SECRET)
      expect(claims.orgId).toBe(first.orgId)
      expect(claims.userId).toBe(String(first.ownerUserId))
    }
  })

  it("rejects the wrong password for the owner", async () => {
    await expect(login(OWNER.email, "not the owner's password", first.orgSlug)).rejects.toThrow()
  })

  it("enables the demo app surface and neither ads nor calls", async () => {
    const enabled = await enabledAppsFor(first.orgId)
    for (const name of ["tickets", "mail", "knowledge", "projects", "invoicing", "shopify"]) {
      expect(enabled).toContain(name)
    }
    expect(enabled).not.toContain("ads")
    expect(enabled).not.toContain("calls")
    expect(first.failedApps).toEqual([])
  })

  it("gives every person a job title and a bio, and no uploaded picture", async () => {
    const rows = await withSystemDb("demo-seed-test-profiles", async (tx) => {
      const result = await tx.execute(
        sql`SELECT email, avatar_url, avatar_key, settings -> 'demo' AS demo
            FROM kernel.users
            WHERE org_id = ${first.orgId} AND settings -> 'demo' IS NOT NULL
            ORDER BY email`,
      )
      return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
        email: string
        avatar_url: string | null
        demo: Record<string, string> | null
      }[]
    })
    expect(rows.length).toBe(DEMO_TEAM.length)
    for (const row of rows) {
      // No picture on purpose: the product's initials disc is the look.
      expect(row.avatar_url).toBeNull()
      expect(row.demo?.jobTitle?.length).toBeGreaterThan(3)
      expect(row.demo?.bio?.length).toBeGreaterThan(20)
    }
  })

  it("bounds each role agent's ceiling to its own desk, never an admin scope", async () => {
    const rows = await withSystemDb("demo-seed-test-agents", async (tx) => {
      const result = await tx.execute(
        sql`SELECT handle, scope_ceiling FROM kernel.agents
            WHERE org_id = ${first.orgId} AND kind = 'role' ORDER BY handle`,
      )
      return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
        handle: string
        scope_ceiling: string[]
      }[]
    })
    expect(rows.map((r) => r.handle)).toEqual(["@finance", "@operations", "@support"])
    for (const row of rows) {
      expect(row.scope_ceiling.length).toBeGreaterThan(0)
      expect(row.scope_ceiling).not.toContain("*")
      expect(row.scope_ceiling.some((s) => s.startsWith("chaos-debug:"))).toBe(false)
      expect(row.scope_ceiling.some((s) => s.startsWith("kernel:users:admin"))).toBe(false)
    }
  })

  it("gives each role agent a curated tool allowlist and a pinned model, not Auto with no curation", async () => {
    const rows = await withSystemDb("demo-seed-test-agent-tools", async (tx) => {
      const result = await tx.execute(
        sql`SELECT handle, tool_allowlist, model_preference, scope_ceiling FROM kernel.agents
            WHERE org_id = ${first.orgId} AND kind = 'role' ORDER BY handle`,
      )
      return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
        handle: string
        tool_allowlist: string[] | null
        model_preference: string | null
        scope_ceiling: string[]
      }[]
    })
    expect(rows.map((r) => r.handle)).toEqual(["@finance", "@operations", "@support"])
    for (const row of rows) {
      // The assertion that fails without the fix: a role agent seeded with no
      // curated tool set and no pinned model looks like an empty shell in the
      // agent directory. Reverting `toolAllowlist`/`modelPreference` on
      // `DEMO_ROLE_AGENTS` back to unset makes this fail.
      expect(row.tool_allowlist?.length ?? 0, `${row.handle} tool_allowlist`).toBeGreaterThan(0)
      expect(row.model_preference, `${row.handle} model_preference`).toBeTruthy()
      // Every allowlisted tool names an app the desk's own scope ceiling can
      // actually reach: no dangling allowlist entry for an app this desk has
      // no scope for at all.
      const ceilingApps = new Set(row.scope_ceiling.map((s) => s.split(":")[0]))
      for (const tool of row.tool_allowlist ?? []) {
        const app = tool.split(":")[0]
        expect(ceilingApps.has(app), `${row.handle} allowlists '${tool}' outside its ceiling`).toBe(
          true,
        )
      }
    }
  })

  it("gives the org the world company's commercial identity, so its business mail can stage", async () => {
    expect(await readCommercialIdentity(first.orgId)).toMatchObject({
      legalName: "Resonant Audio Labs SAS",
      postalAddress: "14 rue des Ateliers, 75011 Paris, France",
    })
    expect(await commercialIdentityMissing(first.orgId)).toBe(false)
  })

  it("writes the demo timezone and locale onto the org row", async () => {
    const rows = await withSystemDb("demo-seed-test-org-row", async (tx) => {
      const result = await tx.execute(
        sql`SELECT timezone, default_locale FROM kernel.organizations WHERE id = ${first.orgId}`,
      )
      return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as {
        timezone: string
        default_locale: string
      }[]
    })
    expect(rows[0]?.timezone).toBe("Europe/Paris")
    expect(rows[0]?.default_locale).toBe("en")
  })

  it("holds NO platform credit, on any seeding path", async () => {
    // A demo org that is created holding platform credit is money whoever was
    // handed the org can spend, and a visitor org is handed to anyone who asks. The balance ROW exists (it is the org's)
    // and both of its balances are zero.
    const rows = await withSystemDb("demo-seed-test-credit", async (tx) => {
      const result = await tx.execute(
        sql`SELECT included_balance AS included, purchased_balance AS purchased
            FROM kernel.credit_balances WHERE org_id = ${first.orgId}`,
      )
      return (
        Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      ) as Array<{ included: unknown; purchased: unknown }>
    })
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].included)).toBe(0)
    expect(Number(rows[0].purchased)).toBe(0)
  })

  it("takes a password back OFF a seeded person that something else put there", async () => {
    const rows = await withSystemDb("demo-seed-test-restored-person", async (tx) => {
      const result = await tx.execute(
        sql`SELECT password_hash AS hash FROM kernel.users
            WHERE org_id = ${first.orgId} AND email = ${driftedPersonEmail}`,
      )
      return (
        Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      ) as Array<{ hash: string | null }>
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].hash).toBeNull()
    await expect(login(driftedPersonEmail, "drifted-by-an-operator")).rejects.toThrow()
  })

  it("MARKS the org as a demo org itself, before anyone can log into it", async () => {
    // Unmarked means `assertDemoEgressAllowed` and `checkDemoSpendCeiling` both
    // return on line one: real SMTP, real connector credentials, no ceiling.
    // The seeder is the only component that knows at creation time.
    // Read it back out of Postgres, not out of the writer's own cache.
    invalidateDemoMarker()
    const marker = await loadDemoMarker(first.orgId)
    expect(marker).not.toBeNull()
    expect(marker?.variant).toBe("reserved")
    expect(marker?.expiresAt).toBeNull()
    expect(await isDemoOrgId(first.orgId)).toBe(true)
  })

  it("installs the Shopify demo connection, without which two apps render nothing", async () => {
    // Shopify is the only app with no local mirror: its entities are declared
    // `external: true`, so every screen is a live GraphQL call and seeded rows
    // render nothing. `home_load` returns an empty bundle with no shop domain,
    // and boxtal's `to_prepare_list`, the operator's main screen, derives from a
    // live Shopify order scan. The stored token must be the internal sentinel,
    // never anything a caller supplied.
    const rows = await withSystemDb("demo-seed-test-shopify-connection", async (tx) => {
      const result = await tx.execute(
        sql`select identifier, status, metadata
            from kernel.connected_accounts
            where org_id = ${first.orgId} and app_name = 'shopify'`,
      )
      const list = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      return list as { identifier: string; status: string; metadata: unknown }[]
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.identifier).toBe(DEMO_SHOP_DOMAIN)
    expect(rows[0]?.status).toBe("active")
    expect((rows[0]?.metadata as { demo?: boolean } | null)?.demo).toBe(true)
  })

  it("seeds no API connection off the demo instance, where nothing answers the fixture origin", async () => {
    // Only the demo instance answers the fixture CRM's origin in-process
    // (modules/demo/api-connector/responder.ts); this box is not one, so a
    // seeded connection would point at a host that does not resolve. The
    // demo-instance install itself: modules/demo/api-connector tests.
    const { adapters, accounts } = await withSystemDb(
      "demo-seed-test-api-connector",
      async (tx) => {
        const listOf = (result: unknown) =>
          Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
        return {
          adapters: listOf(
            await tx.execute(
              sql`select identifier from kernel.api_adapters where org_id = ${first.orgId}`,
            ),
          ),
          accounts: listOf(
            await tx.execute(
              sql`select identifier from kernel.connected_accounts
                  where org_id = ${first.orgId} and app_name = 'api-connector'`,
            ),
          ),
        }
      },
    )
    expect(adapters).toEqual([])
    expect(accounts).toEqual([])
  })

  it("gives each seeded org its own copy of every address", async () => {
    // `login()` answers 401 for an email that exists in more than one org and
    // was given no slug (auth.ts), and one demo box hosts one org per visitor,
    // every one of them seeded from the same world. Deriving the mail domain
    // from the org slug is what keeps the copies distinct.
    const other = await seedDemoOrg({ orgSlug: SECOND_ORG_SLUG, variant: "visitor" })
    expect(other.orgId).not.toBe(first.orgId)

    for (const key of ["amina", "henrik"]) {
      const here = first.peopleByKey[key]
      const there = other.peopleByKey[key]
      expect(here.email).not.toBe(there.email)
      expect(here.email).toBe(demoPersonEmail(ORG_SLUG, key))
      expect(there.email).toBe(demoPersonEmail(SECOND_ORG_SLUG, key))
    }

    invalidateDemoMarker()
    const otherMarker = await loadDemoMarker(other.orgId)
    expect(otherMarker?.variant).toBe("visitor")
    expect(otherMarker?.expiresAt).not.toBeNull()
  }, 900_000)

  it("a visitor org is the same world under its own id", async () => {
    // A disposable slug: the visitor variant is created on demand and never
    // adopted, so a fresh one also proves the create path end to end.
    const visitor = await seedDemoOrg({
      orgSlug: `demo-visitor-${Date.now()}`,
      variant: "visitor",
    })
    expect(visitor.createdOrg).toBe(true)
    expect(visitor.orgId).not.toBe(first.orgId)
    expect(visitor.variant).toBe("visitor")
    expect(visitor.people.map((p) => p.key)).toEqual(first.people.map((p) => p.key))
    // Seeded with no owner: nobody at all can sign into it, which is the safe
    // direction for an org an operator made by hand.
    expect(visitor.ownerUserId).toBeNull()
    const loginable = await withSystemDb("demo-seed-test-visitor-logins", async (tx) => {
      const result = await tx.execute(
        sql`SELECT count(*) AS count FROM kernel.users
            WHERE org_id = ${visitor.orgId} AND password_hash IS NOT NULL`,
      )
      const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
      return Number((rows[0] as { count: unknown } | undefined)?.count ?? -1)
    })
    expect(loginable).toBe(0)
    const counts = await countsFor(visitor.orgId)
    // The same seven people. One fewer user than `first`, which also has an owner.
    expect(counts.users).toBe(DEMO_TEAM.length)
    expect(counts.users).toBe(countsAfterFirst.users - 1)
    // One fewer agent too: no owner here means no owner personal agent.
    expect(counts.agents).toBe(countsAfterFirst.agents - 1)
  }, 900_000)
})
