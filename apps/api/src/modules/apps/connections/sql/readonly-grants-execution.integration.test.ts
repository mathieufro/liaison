// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The read-only role's grants file revokes EXECUTE from PUBLIC on every
// function of the schemas it covers, then re-grants it to the roles that run
// them. A SECURITY DEFINER function runs as its owner, so the owner of every
// such function must still be able to call each in-schema function its body
// calls once the file is applied, or a deployed instance (where the file runs
// at database init) fails where a test database (where it does not) passes.
// The test reads the file's REVOKE and GRANT lines and works out, from the
// catalog, which roles still hold EXECUTE once PUBLIC loses it: a function's
// owner, a role re-granted the schema, an explicit grantee, or a member of one.
// The read-only role is matched by name: a test database need not have it
// (CI's does not; the file creates it on a deployed instance).

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { sql } from "~/db"

const GRANTS_PATH = resolve(import.meta.dir, "generated/readonly-grants.sql")

/** Per schema whose functions lose PUBLIC EXECUTE, the roles the file re-grants. */
function regrants(): Record<string, string[]> {
  const text = readFileSync(GRANTS_PATH, "utf8")
  const out: Record<string, string[]> = {}
  for (const m of text.matchAll(
    /^REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA (\w+) FROM PUBLIC;$/gm,
  )) {
    out[m[1] as string] = []
  }
  for (const m of text.matchAll(/^GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA (\w+) TO (\w+);$/gm)) {
    out[m[1] as string]?.push(m[2] as string)
  }
  return out
}

describe("read-only grants and definer functions", () => {
  it("every definer function's owner can still call the in-schema functions its body calls", async () => {
    const schemas = regrants()
    expect(schemas.kernel).toContain("liaison_rls")
    const pairs = Object.entries(schemas).flatMap(([nsp, roles]) => roles.map((r) => `${nsp}|${r}`))
    const rows = await sql<{ fn: string; owner: string; callee: string; ok: boolean }[]>`
      WITH regrant AS (
        SELECT split_part(x, '|', 1) AS nsp, split_part(x, '|', 2) AS role
          FROM unnest(${pairs}::text[]) AS x
      ),
      calls AS (
        SELECT p.oid::regprocedure::text AS fn, p.proowner, m[1] AS nsp, m[2] AS name
          FROM pg_proc p, regexp_matches(p.prosrc, '([a-z_]+)[.]([a-z_][a-z0-9_]*)[[:space:]]*[(]', 'g') AS m
         WHERE p.prosecdef AND pg_get_userbyid(p.proowner) LIKE 'liaison%'
      )
      SELECT c.fn, pg_get_userbyid(c.proowner) AS owner, c.nsp || '.' || c.name AS callee,
             bool_or(
               f.proowner = c.proowner
               OR EXISTS (SELECT 1 FROM regrant r
                           WHERE r.nsp = c.nsp AND pg_has_role(c.proowner, r.role, 'USAGE'))
               OR EXISTS (SELECT 1 FROM aclexplode(f.proacl) a
                           WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> 0
                             AND pg_get_userbyid(a.grantee) <> 'liaison_readonly'
                             AND pg_has_role(c.proowner, a.grantee, 'USAGE'))
             ) AS ok
        FROM calls c
        JOIN pg_namespace n ON n.nspname = c.nsp
        JOIN pg_proc f ON f.pronamespace = n.oid AND f.proname = c.name
       WHERE c.nsp IN (SELECT DISTINCT nsp FROM regrant)
       GROUP BY c.fn, c.proowner, c.nsp, c.name`
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter((r) => !r.ok).map((r) => `${r.owner}: ${r.fn} -> ${r.callee}`)).toEqual([])
  })
})
