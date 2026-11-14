// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The request role (liaison_rls) gets on a runtime-registered app table exactly
// what it gets on a kernel table: SELECT, INSERT, UPDATE, DELETE (and
// REFERENCES). TRUNCATE and TRIGGER ignore row-level security, FORCE included,
// so holding them on the request connection would let one statement empty or
// hook every org's rows. Registration also takes back what an older
// registration granted, so an existing install heals on its next boot.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { type AppDescriptor, registerApps } from "~/modules/apps/runtime"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const APP = "grantsprobe"
const schema = schemaRef(`app_${APP}`)
const table = `${schema}.notes`

const probeApp = {
  name: APP,
  version: "1.0.0",
  description: "Grant probe",
  scopes: [`${APP}:notes:read`],
  schema: {
    notes: { fields: { title: "string", aclUserIds: "json", aclRoleIds: "json" } },
  },
  tools: {},
} as unknown as AppDescriptor

const DEFINER_TYPE = `${APP}.note`

/** What the SECURITY DEFINER search-ACL recompute (migration 0178) needs on a shareable table. */
async function definerPrivileges() {
  const [row] = await sql`
    SELECT has_schema_privilege('liaison_definer', ${schema}, 'USAGE') AS usage,
           has_table_privilege('liaison_definer', ${table}, 'SELECT') AS sel,
           has_column_privilege('liaison_definer', ${table}, 'acl_user_ids', 'UPDATE') AS users,
           has_column_privilege('liaison_definer', ${table}, 'acl_role_ids', 'UPDATE') AS roles,
           has_column_privilege('liaison_definer', ${table}, 'title', 'UPDATE') AS other
  `
  return row
}

async function privileges() {
  const [row] = await sql`
    SELECT has_table_privilege('liaison_rls', ${table}, 'SELECT') AS sel,
           has_table_privilege('liaison_rls', ${table}, 'DELETE') AS del,
           has_table_privilege('liaison_rls', ${table}, 'TRUNCATE') AS trunc,
           has_table_privilege('liaison_rls', ${table}, 'TRIGGER') AS trig
  `
  return row
}

describe("runtime app registration grants", () => {
  let orgId: string

  beforeAll(async () => {
    await acquireTestLock()
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    orgId = (await createTestOrg()).id
    resetAppRegistries()
    await registerApps([probeApp], orgId)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.shareable_resource_types WHERE resource_type = ${DEFINER_TYPE}`
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    resetAppRegistries()
    await releaseTestLock()
  })

  it("gives the request role read/write but no TRUNCATE or TRIGGER", async () => {
    expect(await privileges()).toEqual({ sel: true, del: true, trunc: false, trig: false })
  })

  it("takes back TRUNCATE and TRIGGER an older registration granted", async () => {
    // An older registration: older code, so an older DDL stamp on the schema.
    await sql.unsafe(`GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO liaison_rls`)
    await sql.unsafe(`COMMENT ON SCHEMA ${schema} IS 'liaison:app-ddl:v1:older'`)
    expect((await privileges()).trunc).toBe(true)
    resetAppRegistries()
    await registerApps([probeApp], orgId)
    expect(await privileges()).toEqual({ sel: true, del: true, trunc: false, trig: false })
  })

  it("tables created later in the schema do not inherit TRUNCATE or TRIGGER", async () => {
    const rows = await sql<{ privilege_type: string }[]>`
      SELECT a.privilege_type
      FROM pg_default_acl d
      JOIN pg_namespace n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) a
      WHERE n.nspname = ${schema} AND d.defaclobjtype = 'r'
        AND a.grantee = 'liaison_rls'::regrole
    `
    const granted = rows.map((r) => r.privilege_type)
    expect(granted).toContain("SELECT")
    expect(granted.filter((p) => p === "TRUNCATE" || p === "TRIGGER")).toEqual([])
  })

  it("re-asserts the definer role's grants on a shareable table it recreates", async () => {
    const [knowledge] = await sql<{ can_manage: string }[]>`
      SELECT can_manage::text FROM kernel.shareable_resource_types
       WHERE resource_type = 'knowledge.document'`
    await sql`
      INSERT INTO kernel.shareable_resource_types (resource_type, can_manage, resource_table)
      VALUES (${DEFINER_TYPE}, ${knowledge?.can_manage ?? ""}::regprocedure, ${table}::regclass)
      ON CONFLICT (resource_type) DO UPDATE SET resource_table = EXCLUDED.resource_table`
    await sql.unsafe(`REVOKE ALL ON ${table} FROM liaison_definer`)
    await sql.unsafe(`REVOKE ALL ON SCHEMA ${schema} FROM liaison_definer`)
    resetAppRegistries()
    await registerApps([probeApp], orgId)
    expect(await definerPrivileges()).toEqual({
      usage: true,
      sel: true,
      users: true,
      roles: true,
      other: false,
    })
  })

  it("grants the definer role nothing on a table that is not shareable", async () => {
    await sql`DELETE FROM kernel.shareable_resource_types WHERE resource_type = ${DEFINER_TYPE}`
    await sql.unsafe(`REVOKE ALL ON ${table} FROM liaison_definer`)
    resetAppRegistries()
    await registerApps([probeApp], orgId)
    expect((await definerPrivileges())?.sel).toBe(false)
  })
})
