// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The whole of what the portal role can reach, read from the catalog. A client
// who signs in holds this role and nothing else, so this list is the boundary:
// a new grant, a new schema it can use or a new definer function it can call
// fails here until it is added, with its reason, on purpose.
//
// System catalogs are left out (pg_catalog and information_schema are readable
// by every role and hold no business rows).

import { afterAll, describe, expect, test } from "bun:test"
import postgres from "postgres"

const ROLE = "liaison_portal"

function privilegedUrl(): string {
  if (process.env.MIGRATION_DATABASE_URL) return process.env.MIGRATION_DATABASE_URL
  const base = process.env.DB_RESET_SUPERUSER_URL ?? "postgres://postgres:postgres@localhost:5432"
  const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(/^\//, "")
  return `${base.replace(/\/$/, "")}/${dbName}`
}

const db = postgres(privilegedUrl(), { max: 1, onnotice: () => {} })

afterAll(async () => {
  await db.end()
})

/** Every entry the role may reach, each with why. Anything else is a failure. */
const ALLOWED: Record<string, string> = {
  "schema portal USAGE": "the one schema of objects a client is meant to read",
  "schema public USAGE":
    "PUBLIC's default on the database, not a grant to this role: extensions live there, and no table in it is readable",
  "schema rls_ctx USAGE":
    "PUBLIC since the context readers were made (0184): a policy or view evaluated for any role calls them",
  "table portal.me SELECT": "the client's own row",
  "function portal.company_id()":
    "the caller's own company; every later view filters on it, and it reads only the caller's row",
  "function rls_ctx.org_id()": "returns the transaction's own org, after checking its tag",
  "function rls_ctx.user_id()": "returns the transaction's own user, after checking its tag",
  "function rls_ctx.scopes()": "returns the transaction's own scopes: none in a portal transaction",
  "function rls_ctx.dimensions()": "returns the transaction's own dimension grants: none here",
  "function rls_ctx.roles()": "returns the transaction's own roles: none here",
  "function rls_ctx.enter()":
    "stores only variables that verify, so calling it again from inside a transaction gains nothing",
}

describe("what the portal role can reach", () => {
  test("lists every grant, usage and executable definer function reachable by liaison_portal", async () => {
    const schemas = await db<{ name: string; usage: boolean; create: boolean }[]>`
      SELECT n.nspname AS name,
             has_schema_privilege(${ROLE}, n.oid, 'USAGE') AS usage,
             has_schema_privilege(${ROLE}, n.oid, 'CREATE') AS create
        FROM pg_namespace n
       WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'`
    const tables = await db<{ name: string; privilege: string }[]>`
      SELECT format('%I.%I', n.nspname, c.relname) AS name, p.privilege
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p(privilege)
       WHERE c.relkind IN ('r','p','v','m','f')
         AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
         AND has_table_privilege(${ROLE}, c.oid, p.privilege)`
    const columns = await db<{ name: string }[]>`
      SELECT format('%I.%I', n.nspname, c.relname) AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p','v','m','f')
         AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
         AND has_any_column_privilege(${ROLE}, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
         AND NOT has_table_privilege(${ROLE}, c.oid, 'SELECT')`
    const sequences = await db<{ name: string }[]>`
      SELECT format('%I.%I', n.nspname, c.relname) AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
         AND CASE WHEN c.relkind = 'S'
                  THEN has_sequence_privilege(${ROLE}, c.oid, 'USAGE, SELECT, UPDATE')
                  ELSE false END`
    const definers = await db<{ name: string }[]>`
      SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS name
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef
         AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
         AND has_schema_privilege(${ROLE}, n.oid, 'USAGE')
         AND has_function_privilege(${ROLE}, p.oid, 'EXECUTE')`

    const found = [
      ...schemas.filter((s) => s.usage).map((s) => `schema ${s.name} USAGE`),
      ...schemas.filter((s) => s.create).map((s) => `schema ${s.name} CREATE`),
      ...tables.map((t) => `table ${t.name} ${t.privilege}`),
      ...columns.map((c) => `column on ${c.name}`),
      ...sequences.map((s) => `sequence ${s.name}`),
      ...definers.map((d) => `function ${d.name}`),
    ].sort()
    expect(found).toEqual(Object.keys(ALLOWED).sort())
  })

  test("holds no attribute a login, a bypass or a role administrator would need", async () => {
    const [role] = await db<
      {
        rolsuper: boolean
        rolbypassrls: boolean
        rolcanlogin: boolean
        rolcreaterole: boolean
        rolcreatedb: boolean
      }[]
    >`SELECT rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb
        FROM pg_roles WHERE rolname = ${ROLE}`
    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: false,
      rolcreaterole: false,
      rolcreatedb: false,
    })
  })
})
