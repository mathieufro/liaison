// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What SQL run from a request transaction can reach, on the live database.
// Request transactions log in as `liaison_request` (DATABASE_REQUEST_PASSWORD,
// db/connection.ts, which every namespaced test run sets): from one, no
// statement may step into a role that bypasses row-level security, change or
// drop a policy, or own anything. Each probe runs in a savepoint, both as the
// transaction's role (liaison_rls) and after `RESET ROLE` (the login itself).
import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withRlsContext } from "~/db/rls"
import { PRIVILEGED_ROLE_REACH_SQL } from "~/db/role-reach"
import { schemaRef } from "~/db/schema-ref"

const ctx = { actorType: "system" as const, orgId: randomUUID(), purpose: "job" as const }

function pgCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.cause?.code ?? e?.code ?? "unknown"
}

/** "allowed", or the SQLSTATE the statement was refused with. */
async function attempt(tx: RlsClient, statement: string, resetRole = false): Promise<string> {
  try {
    await tx.transaction(async (sp) => {
      if (resetRole) await sp.execute(drizzleSql.raw("RESET ROLE"))
      await sp.execute(drizzleSql.raw(statement))
    })
    return "allowed"
  } catch (err) {
    return pgCode(err)
  }
}

function inRequestTx<T>(fn: (tx: RlsClient) => Promise<T>): Promise<T> {
  return withRlsContext(ctx, fn)
}

const ELEVATED_ROLES = [
  "liaison_admin",
  "liaison_schema_admin",
  "liaison_app",
  "liaison_definer",
  "postgres",
]

describe("the request login", () => {
  test("liaison_request's memberships are exactly liaison_rls and liaison_portal", async () => {
    const [who] = await inRequestTx(async (tx) =>
      extractRows<{ login: string; role: string; memberships: string[] }>(
        await tx.execute(drizzleSql`
          SELECT session_user::text AS login, current_user::text AS role,
                 ARRAY(SELECT r.rolname::text FROM pg_roles r
                        WHERE r.rolname <> session_user
                          AND pg_has_role(session_user, r.oid, 'MEMBER')
                        ORDER BY 1) AS memberships`),
      ),
    )
    expect(who).toEqual({
      login: "liaison_request",
      role: "liaison_rls",
      // liaison_portal holds less than liaison_rls, and withPortalContext steps
      // into it on this login. Nothing else may ever join this list.
      memberships: ["liaison_portal", "liaison_rls"],
    })
  })

  test("liaison_portal is a member of nothing", async () => {
    const rows = await inRequestTx(async (tx) =>
      extractRows<{ rolname: string }>(
        await tx.execute(drizzleSql`
          SELECT r.rolname::text AS rolname FROM pg_roles r
           WHERE r.rolname <> 'liaison_portal'
             AND pg_has_role('liaison_portal', r.oid, 'MEMBER')`),
      ),
    )
    expect(rows).toEqual([])
  })

  test("reaches no superuser, BYPASSRLS or server-file role", async () => {
    const rows = await inRequestTx(async (tx) =>
      extractRows<{ rolname: string }>(await tx.execute(drizzleSql.raw(PRIVILEGED_ROLE_REACH_SQL))),
    )
    expect(rows).toEqual([])
  })

  test("cannot SET ROLE to any elevated role, before or after RESET ROLE", async () => {
    const results = await inRequestTx(async (tx) => {
      const out: Record<string, string> = {}
      for (const role of ELEVATED_ROLES) {
        const exists = extractRows<{ n: number }>(
          await tx.execute(
            drizzleSql`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = ${role}`,
          ),
        )[0]?.n
        if (!exists) continue
        out[`set ${role}`] = await attempt(tx, `SET LOCAL ROLE ${role}`)
        out[`reset, set ${role}`] = await attempt(tx, `SET LOCAL ROLE ${role}`, true)
        out[`set_config ${role}`] = await attempt(tx, `SELECT set_config('role', '${role}', true)`)
      }
      out["session authorization"] = await attempt(tx, "SET SESSION AUTHORIZATION postgres")
      return out
    })
    expect(Object.keys(results).length).toBeGreaterThanOrEqual(9)
    for (const [probe, result] of Object.entries(results)) {
      expect({ probe, result }).toEqual({ probe, result: "42501" })
    }
  })

  test("cannot alter, drop or bypass a policy, on kernel or app tables", async () => {
    const results = await inRequestTx(async (tx) => {
      const targets = extractRows<{ schemaname: string; tablename: string; policyname: string }>(
        await tx.execute(drizzleSql`
          SELECT DISTINCT ON (schemaname) schemaname::text, tablename::text, policyname::text
            FROM pg_policies
           WHERE schemaname IN (${schemaRef("kernel")}, ${schemaRef("app_tickets")}, ${schemaRef("app_knowledge")})
           ORDER BY schemaname, tablename, policyname`),
      )
      const out: Record<string, string> = {}
      for (const t of targets) {
        const rel = `"${t.schemaname}"."${t.tablename}"`
        const policy = `"${t.policyname}" ON ${rel}`
        for (const reset of [false, true]) {
          const as = reset ? "login" : "liaison_rls"
          out[`${as}: drop ${policy}`] = await attempt(tx, `DROP POLICY ${policy}`, reset)
          out[`${as}: alter ${policy}`] = await attempt(
            tx,
            `ALTER POLICY ${policy} USING (true)`,
            reset,
          )
          out[`${as}: disable rls ${rel}`] = await attempt(
            tx,
            `ALTER TABLE ${rel} DISABLE ROW LEVEL SECURITY`,
            reset,
          )
          out[`${as}: new policy ${rel}`] = await attempt(
            tx,
            `CREATE POLICY probe_open ON ${rel} USING (true)`,
            reset,
          )
          out[`${as}: truncate ${rel}`] = await attempt(tx, `TRUNCATE ${rel}`, reset)
        }
      }
      return { targets: targets.length, out }
    })
    expect(results.targets).toBe(3)
    for (const [probe, result] of Object.entries(results.out)) {
      expect({ probe, result }).toEqual({ probe, result: "42501" })
    }
  })

  test("owns no table, function, schema or type, through any role it can reach", async () => {
    const [owned] = await inRequestTx(async (tx) =>
      extractRows<{ relations: number; functions: number; schemas: number; types: number }>(
        await tx.execute(drizzleSql`
          SELECT
            (SELECT count(*)::int FROM pg_class WHERE pg_has_role(session_user, relowner, 'MEMBER')) AS relations,
            (SELECT count(*)::int FROM pg_proc WHERE pg_has_role(session_user, proowner, 'MEMBER')) AS functions,
            (SELECT count(*)::int FROM pg_namespace WHERE pg_has_role(session_user, nspowner, 'MEMBER')) AS schemas,
            (SELECT count(*)::int FROM pg_type WHERE pg_has_role(session_user, typowner, 'MEMBER')) AS types`),
      ),
    )
    expect(owned).toEqual({ relations: 0, functions: 0, schemas: 0, types: 0 })
  })
})
