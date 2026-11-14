// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An app table no declared scope can reach (no `rlsScope` its scopes cover, and
// no scope named after the table) is visible to administrators only: every
// least-privilege role reads it as empty. Registration refuses such an app
// instead of logging and carrying on half-working. Outside production the
// refusal throws, so a test, a dev server or CI fails on it; in production the
// app is not loaded and is marked in error with the tables named, while the
// other apps register.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { type AppDescriptor, AppRegistrationFatalError, registerApps } from "~/modules/apps/runtime"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG = crypto.randomUUID()
const UNREACHABLE = "fxunreach"
const REACHABLE = "fxreach"

/** A table gated on `<app>:notes:*` while the app only declares `<app>:items:*`. */
function unreachableApp(): AppDescriptor {
  return {
    name: UNREACHABLE,
    version: "1.0.0",
    _format: "manifest",
    _bundlePath: `/apps/${UNREACHABLE}/handlers.js`,
    scopes: [`${UNREACHABLE}:items:read`],
    schema: {
      items: { fields: { title: "string" } },
      notes: { fields: { body: "text?" } },
    },
  } as AppDescriptor
}

/** The same tables, the second one aliased onto the declared scope. */
function reachableApp(): AppDescriptor {
  return {
    name: REACHABLE,
    version: "1.0.0",
    _format: "manifest",
    _bundlePath: `/apps/${REACHABLE}/handlers.js`,
    scopes: [`${REACHABLE}:items:read`],
    schema: {
      items: { fields: { title: "string" } },
      notes: { rlsScope: "items", fields: { body: "text?" } },
    },
  } as AppDescriptor
}

async function appRow(
  name: string,
): Promise<
  { status: string; problem_code: string | null; problem_message: string | null } | undefined
> {
  const [row] = await sql<
    { status: string; problem_code: string | null; problem_message: string | null }[]
  >`
    SELECT status, problem_code, problem_message FROM kernel.apps WHERE org_id = ${ORG} AND name = ${name}`
  return row
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  const [row] = await sql<{ present: boolean }[]>`
    SELECT to_regclass(${`"${schema}"."${table}"`}) IS NOT NULL AS present`
  return row?.present === true
}

const savedNodeEnv = process.env.NODE_ENV

beforeAll(async () => {
  await sql.unsafe(
    insertSql("kernel.organizations", {
      id: ORG,
      name: "Reachability",
      slug: `reach-${ORG.slice(0, 8)}`,
    }),
  )
})

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv
})

afterAll(async () => {
  resetAppRegistries()
  for (const name of [UNREACHABLE, REACHABLE]) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS app_${name} CASCADE`)
  }
  await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("registration refuses an app table no declared scope can reach", () => {
  it("outside production, registering it throws and names the table", async () => {
    let caught: unknown
    try {
      await registerApps([unreachableApp()], ORG)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(AppRegistrationFatalError)
    expect((caught as AppRegistrationFatalError).code).toBe("rls_unreachable")
    expect((caught as AppRegistrationFatalError).details).toMatchObject({
      appName: UNREACHABLE,
      tables: ["notes"],
    })
    expect(await tableExists(`app_${UNREACHABLE}`, "notes")).toBe(false)
  })

  it("in production, the app is not loaded and is marked in error, and the other apps register", async () => {
    process.env.NODE_ENV = "production"
    const { failedApps } = await registerApps([unreachableApp(), reachableApp()], ORG)
    expect(failedApps).toEqual([UNREACHABLE])
    const row = await appRow(UNREACHABLE)
    expect(row?.status).toBe("error")
    expect(row?.problem_code).toBe("manifest_invalid")
    expect(row?.problem_message).toContain("notes")
    expect(await tableExists(`app_${UNREACHABLE}`, "notes")).toBe(false)
    expect((await appRow(REACHABLE))?.status).toBe("active")
    expect(await tableExists(`app_${REACHABLE}`, "notes")).toBe(true)
  })

  it("every built-in app still registers on a new org", async () => {
    const org = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.organizations", {
        id: org,
        name: "Built-ins",
        slug: `builtin-${org.slice(0, 8)}`,
      }),
    )
    try {
      await ensureAppsForOrg(org)
      const errored = await sql<{ name: string }[]>`
        SELECT name FROM kernel.apps WHERE org_id = ${org} AND status = 'error'`
      expect(errored.map((r) => r.name)).toEqual([])
    } finally {
      await sql`DELETE FROM kernel.apps WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
    }
  }, 120_000)
})
