// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { entityRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import { computeSchemaHash, generateAlterTableDdl, generateTableDdl } from "~/modules/apps/ddl"
import { registerApps } from "~/modules/apps/runtime"

describe("generateTableDdl", () => {
  it("generates correct DDL for known field types", () => {
    const ddl = generateTableDdl("app_test", "items", {
      title: "string",
      count: "integer",
      active: "boolean",
    })
    expect(ddl).toContain("TEXT NOT NULL")
    expect(ddl).toContain("INTEGER NOT NULL")
    expect(ddl).toContain("BOOLEAN NOT NULL")
  })

  it("throws on unknown field type", () => {
    expect(() => generateTableDdl("app_test", "items", { data: "binary" })).toThrow(
      "Unknown field type",
    )
  })

  it("handles optional fields with ? suffix", () => {
    const ddl = generateTableDdl("app_test", "items", {
      note: "string?",
    })
    expect(ddl).toContain('"note" TEXT')
    expect(ddl).not.toContain('"note" TEXT NOT NULL')
  })

  it("handles optional fields with object syntax", () => {
    const ddl = generateTableDdl("app_test", "items", {
      note: { type: "string", required: false },
    })
    expect(ddl).toContain('"note" TEXT')
    expect(ddl).not.toContain('"note" TEXT NOT NULL')
  })

  it("converts camelCase to snake_case", () => {
    const ddl = generateTableDdl("app_test", "items", {
      createdBy: { type: "uuid", required: false },
    })
    expect(ddl).toContain('"created_by"')
  })

  it("always includes system columns", () => {
    const ddl = generateTableDdl("app_test", "items", { title: "string" })
    expect(ddl).toContain("id UUID PRIMARY KEY")
    expect(ddl).toContain("org_id UUID NOT NULL")
    expect(ddl).toContain("created_at TIMESTAMPTZ")
    expect(ddl).toContain("updated_at TIMESTAMPTZ")
  })
})

describe("generateAlterTableDdl", () => {
  it("generates ALTER TABLE ADD COLUMN for new fields", () => {
    const alterSql = generateAlterTableDdl("app_test", "items", { priority: "string" })
    expect(alterSql).toContain("ALTER TABLE")
    expect(alterSql).toContain("ADD COLUMN IF NOT EXISTS")
    expect(alterSql).toContain('"priority"')
    expect(alterSql).toContain("TEXT")
  })

  it("emits the enum CHECK on an ADDED column, like CREATE TABLE does", () => {
    // A column added to an EXISTING table went in unconstrained: only
    // `generateTableDdl` emitted the inline CHECK, and the runtime's enum
    // reconciler explicitly skips new columns ("CREATE/ALTER emits its CHECK")
    // — which was true of CREATE and false of ALTER. Net effect: on any
    // deployment that already had the table, a new enum field was enforced
    // nowhere. The whole point of declaring an enum is that the database
    // refuses the eleventh spelling; free text is what produced the 16-way
    // team rename.
    //
    // pg names an inline column CHECK `<table>_<col>_check` — the same name
    // the reconciler later looks for, so widening keeps working.
    const alterSql = generateAlterTableDdl("app_test", "items", {
      audience: { type: "string", required: false, enum: ["b2b", "b2c"] },
    })
    expect(alterSql).toContain("ADD COLUMN IF NOT EXISTS")
    expect(alterSql).toContain(`CHECK ("audience" IN ('b2b', 'b2c'))`)
  })

  it("does not invent a CHECK for a non-enum added column", () => {
    const alterSql = generateAlterTableDdl("app_test", "items", { note: "string?" })
    expect(alterSql).not.toContain("CHECK")
  })

  it("returns empty string when no new fields", () => {
    const alterSql = generateAlterTableDdl("app_test", "items", {})
    expect(alterSql).toBe("")
  })

  it("handles multiple new fields", () => {
    const alterSql = generateAlterTableDdl("app_test", "items", {
      count: "integer",
      active: "boolean",
    })
    expect(alterSql).toContain('"count" INTEGER')
    expect(alterSql).toContain('"active" BOOLEAN')
  })

  it("new columns are always nullable (no NOT NULL)", () => {
    const alterSql = generateAlterTableDdl("app_test", "items", { priority: "string" })
    expect(alterSql).toContain('"priority" TEXT')
    expect(alterSql).not.toContain("NOT NULL")
  })

  it("converts camelCase to snake_case for new columns", () => {
    const alterSql = generateAlterTableDdl("app_test", "items", { createdBy: "uuid" })
    expect(alterSql).toContain('"created_by"')
  })

  it("throws on unknown field type", () => {
    expect(() => generateAlterTableDdl("app_test", "items", { data: "binary" })).toThrow(
      "Unknown field type",
    )
  })

  it("handles object-syntax field definitions", () => {
    const alterSql = generateAlterTableDdl("app_test", "items", {
      note: { type: "string", required: false },
    })
    expect(alterSql).toContain('"note" TEXT')
  })

  it("quotes schema and table names", () => {
    const alterSql = generateAlterTableDdl("app_test", "items", { priority: "string" })
    expect(alterSql).toContain('"app_test"."items"')
  })
})

describe("DDL constraints and indexes", () => {
  it("generates UNIQUE constraint in CREATE TABLE", () => {
    const ddl = generateTableDdl(
      "app_mail",
      "accounts",
      {
        emailAddress: "string",
        syncStatus: "string",
      },
      { unique: [["emailAddress"]] },
    )
    expect(ddl).toContain('UNIQUE (org_id, "email_address")')
  })

  it("generates multi-column UNIQUE constraint", () => {
    const ddl = generateTableDdl(
      "app_mail",
      "accounts",
      {
        emailAddress: "string",
        provider: "string",
      },
      { unique: [["emailAddress", "provider"]] },
    )
    expect(ddl).toContain('UNIQUE (org_id, "email_address", "provider")')
  })

  it("generates CREATE INDEX statements", () => {
    const ddl = generateTableDdl(
      "app_mail",
      "accounts",
      {
        syncStatus: "string",
        connectedAccountId: "uuid",
      },
      undefined,
      [["syncStatus"], ["connectedAccountId"]],
    )
    expect(ddl).toContain("CREATE INDEX IF NOT EXISTS")
    expect(ddl).toContain('"app_mail"."accounts" (org_id, "sync_status")')
    expect(ddl).toContain('"app_mail"."accounts" (org_id, "connected_account_id")')
  })

  it("emits no constraint/index DDL when absent", () => {
    const ddl = generateTableDdl("app_test", "items", { title: "string" })
    expect(ddl).not.toContain("UNIQUE")
    expect(ddl).not.toContain("CREATE INDEX")
  })

  it("generateAlterTableDdl adds new indexes with IF NOT EXISTS", () => {
    const result = generateAlterTableDdl("app_mail", "accounts", {}, undefined, [["syncStatus"]])
    expect(result).toContain("CREATE INDEX IF NOT EXISTS")
    expect(result).toContain('"sync_status"')
  })

  it("computeSchemaHash changes when constraints change", () => {
    const hash1 = computeSchemaHash({ accounts: { fields: { email: "string" } } })
    const hash2 = computeSchemaHash({
      accounts: { fields: { email: "string" }, constraints: { unique: [["email"]] } },
    })
    expect(hash1).not.toBe(hash2)
  })

  it("computeSchemaHash changes when indexes change", () => {
    const hash1 = computeSchemaHash({ accounts: { fields: { email: "string" } } })
    const hash2 = computeSchemaHash({
      accounts: { fields: { email: "string" }, indexes: [["email"]] },
    })
    expect(hash1).not.toBe(hash2)
  })
})

describe("registerApps integration — schema migration", () => {
  const TEST_SCHEMA = "app_migration_test"
  const TEST_ORG_ID = "00000000-0000-0000-0000-000000000099"

  beforeAll(async () => {
    // Seed org required by kernel.apps FK constraint
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG_ID}, 'Migration Test Org', 'migration-test')
      ON CONFLICT (id) DO NOTHING`
    // Ensure clean state
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = 'migration-test'`
  })

  beforeEach(() => {
    // Clear registration tracking so re-registration tests work
    resetAppRegistries()
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`)
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_liveupgrade_test" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = 'migration-test'`
    await sql`DELETE FROM kernel.apps WHERE name = 'liveupgrade-test'`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG_ID}`
  })

  it("populates entity registry after app registration", async () => {
    const appWithEntities = {
      name: "migration-test",
      version: "0.9.0",
      entities: {
        record: {
          labelField: "title",
          handlePrefix: "rec",
          searchable: true,
        },
      },
    }
    await registerApps([appWithEntities], TEST_ORG_ID)

    const entry = entityRegistry.get([TEST_ORG_ID, "migration-test", "record"])
    expect(entry).toBeDefined()
    expect(entry?.labelField).toBe("title")
    expect(entry?.handlePrefix).toBe("rec")
    expect(entry?.searchable).toBe(true)
  })

  it("coalesces concurrent in-process registration for the same org/app", async () => {
    const appWithEntities = {
      name: "migration-test",
      version: "1.1.0",
      entities: {
        record: {
          labelField: "title",
          handlePrefix: "rec",
          searchable: true,
        },
      },
    }

    const first = registerApps([appWithEntities], TEST_ORG_ID)
    const second = registerApps([appWithEntities], TEST_ORG_ID)

    await second

    const entry = entityRegistry.get([TEST_ORG_ID, "migration-test", "record"])
    expect(entry).toBeDefined()

    await first

    const [row] = await sql`
      SELECT count(*)::int AS count
      FROM kernel.apps
      WHERE org_id = ${TEST_ORG_ID} AND name = 'migration-test'
    `
    expect(row.count).toBe(1)
  })

  it("creates table on first registration and adds columns on re-registration", async () => {
    // V1: register with initial fields
    const v1 = {
      name: "migration-test",
      version: "1.0.0",
      scopes: ["migration-test:records:read"],
      schema: {
        records: {
          fields: { title: "string", status: "string" },
        },
      },
    }
    await registerApps([v1], TEST_ORG_ID)

    // Verify table was created with expected columns
    const cols1 = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${TEST_SCHEMA} AND table_name = 'records'
      ORDER BY ordinal_position
    `
    const colNames1 = cols1.map((c: any) => c.column_name)
    expect(colNames1).toContain("title")
    expect(colNames1).toContain("status")
    expect(colNames1).not.toContain("priority")

    // Insert a row to verify data preservation
    await sql.unsafe(
      `INSERT INTO "${TEST_SCHEMA}"."records" (org_id, title, status) VALUES ('${TEST_ORG_ID}', 'keep me', 'open')`,
    )

    // Clear registration tracking so V2 re-registration proceeds
    resetAppRegistries()

    // V2: register again with an added field
    const v2 = {
      name: "migration-test",
      version: "2.0.0",
      scopes: ["migration-test:records:read"],
      schema: {
        records: {
          fields: { title: "string", status: "string", priority: "string?" },
        },
      },
    }
    await registerApps([v2], TEST_ORG_ID)

    // Verify new column was added
    const cols2 = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${TEST_SCHEMA} AND table_name = 'records'
      ORDER BY ordinal_position
    `
    const colNames2 = cols2.map((c: any) => c.column_name)
    expect(colNames2).toContain("priority")

    // Verify existing data preserved
    const rows = await sql.unsafe(`SELECT title, status FROM "${TEST_SCHEMA}"."records"`)
    expect(rows.length).toBe(1)
    expect(rows[0].title).toBe("keep me")
    expect(rows[0].status).toBe("open")
  })

  it("re-registers on VERSION change without a registry reset (catalog live upgrade)", async () => {
    // A catalog upgrade calls reloadInstalledApps in the SAME process — no
    // resetAppRegistries, no restart. The same-name guard must compare versions
    // and re-register (the old bundle dir is gone from disk, so a stale
    // registration would ENOENT every tool call until restart).
    const v1 = {
      name: "liveupgrade-test",
      version: "1.0.0",
      scopes: ["liveupgrade-test:records:read"],
      schema: { records: { fields: { title: "string" } } },
    }
    await registerApps([v1], TEST_ORG_ID)

    const v2 = {
      name: "liveupgrade-test",
      version: "1.0.1",
      scopes: ["liveupgrade-test:records:read"],
      schema: { records: { fields: { title: "string", extra: "string?" } } },
    }
    // NO resetAppRegistries here — this is the live-upgrade path.
    await registerApps([v2], TEST_ORG_ID)

    const cols = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${"app_liveupgrade_test"} AND table_name = 'records'
    `
    const colNames = cols.map((c: any) => c.column_name)
    expect(colNames).toContain("extra")

    // Same version re-registration stays a no-op (idempotent skip).
    await registerApps([v2], TEST_ORG_ID)
  })
})

// BL-103: a registration that throws must leave the app in a CLEARLY-ERRORED
// state — never silently installed-but-toolless. The historical bug was that the
// error-status write was a bare INSERT: a previously-registered app already has
// an (org_id, name) row, so the insert hit `apps_org_name_idx`, the conflict was
// swallowed by a catch-and-ignore, and the row kept its stale `active` status
// while the app had no live tools. The fix makes that write an upsert.
describe("registerApps — failed registration records errored state (BL-103)", () => {
  const ERR_ORG_ID = "00000000-0000-0000-0000-0000000000aa"

  // An app whose schema declares an unknown field type: it passes descriptor
  // validation (the contract validator does not whitelist field types) and then
  // throws a NON-fatal "Unknown field type" Error at DDL generation inside
  // registerSingleApp — exactly the registration-failure path under test.
  const badApp = (name: string) => ({
    name,
    version: "1.0.0",
    scopes: [`${name}:records:read`],
    schema: { records: { fields: { title: "string", bad: "binary" } } },
  })

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ERR_ORG_ID}, 'Err State Test Org', 'errstate-test')
      ON CONFLICT (id) DO NOTHING`
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ERR_ORG_ID}`
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_errstate_fresh" CASCADE`)
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_errstate_prior" CASCADE`)
  })

  beforeEach(() => {
    resetAppRegistries()
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ERR_ORG_ID}`
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_errstate_fresh" CASCADE`)
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_errstate_prior" CASCADE`)
    await sql`DELETE FROM kernel.organizations WHERE id = ${ERR_ORG_ID}`
  })

  it("creates a status=error row when a fresh app's registration throws (never silently dropped)", async () => {
    // No prior row exists — the failed registration must record an errored row,
    // not leave the app absent-and-silent.
    await registerApps([badApp("errstate-fresh")], ERR_ORG_ID)

    const [row] = await sql`
      SELECT status FROM kernel.apps
      WHERE org_id = ${ERR_ORG_ID} AND name = 'errstate-fresh'
    `
    expect(row?.status).toBe("error")
  })

  it("flips a previously-active app to status=error on re-registration failure (no stale active)", async () => {
    // Simulate a previously-healthy registration: an existing active row.
    await sql`INSERT INTO kernel.apps (id, org_id, name, version, status)
      VALUES (gen_random_uuid(), ${ERR_ORG_ID}, 'errstate-prior', '1.0.0', 'active')`

    // Re-registration now throws. Pre-fix this hit the unique index and was
    // swallowed, leaving status='active'. The upsert must flip it to 'error'.
    await registerApps([badApp("errstate-prior")], ERR_ORG_ID)

    const [row] = await sql`
      SELECT status FROM kernel.apps
      WHERE org_id = ${ERR_ORG_ID} AND name = 'errstate-prior'
    `
    expect(row?.status).toBe("error")
  })
})
