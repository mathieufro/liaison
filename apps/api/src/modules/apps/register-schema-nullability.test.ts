// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A field the manifest declares NOT NULL must be NOT NULL in the live table,
// whether the table was created with it or gained it from a later app version.
//
// CREATE TABLE emitted NOT NULL, but the additive ADD COLUMN path never did, so
// every non-nullable field added to an existing table landed nullable and the
// runtime logged "Schema drift detected: column nullability mismatch" at every
// boot (production: app_calendar.events.push_attempts, app_mail enc_version and
// encryption_state). Nothing ever tightened the column afterwards either.
//
// The other way, a field a later version makes nullable has its NOT NULL dropped: additive for the
// code already running, which keeps writing the value.
//
// Fails-without-fix: after the v2 registration `attempts` is nullable, and the
// v3 registration leaves the NULL row and the nullable column as they were.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { registerApps } from "~/modules/apps/runtime"

const TEST_ORG = "00000000-0000-0000-0000-000000120931"
const APP = "nn-drift-app"
const SCHEMA = "app_nn_drift_app"

function manifest(version: string, fields: Record<string, unknown>) {
  return {
    name: APP,
    version,
    _format: "manifest" as const,
    _bundlePath: "/apps/nn-drift-app/handlers.js",
    scopes: [`${APP}:rows:read`],
    schema: { rows: { fields } },
  }
}

async function column(name: string) {
  const [c] = await sql<{ is_nullable: string }[]>`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = ${SCHEMA} AND table_name = 'rows' AND column_name = ${name}`
  return c
}

describe("registerApps keeps declared NOT NULL columns NOT NULL", () => {
  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'NN Drift Org', 'nn-drift-org')
      ON CONFLICT (id) DO NOTHING`
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = ${APP}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  it("adds a defaulted non-nullable field to a populated table as NOT NULL", async () => {
    await registerApps([manifest("1.0.0", { title: "string" }) as any], TEST_ORG)
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}"."rows" (org_id, title) VALUES ('${TEST_ORG}', 'existing')`,
    )

    await registerApps(
      [manifest("1.1.0", { title: "string", attempts: { type: "integer", default: 0 } }) as any],
      TEST_ORG,
    )

    expect((await column("attempts")).is_nullable).toBe("NO")
    const rows = await sql.unsafe(`SELECT attempts FROM "${SCHEMA}"."rows"`)
    expect(rows.map((r: any) => r.attempts)).toEqual([0])
  })

  it("backfills NULLs and tightens a column an earlier version left nullable", async () => {
    // The production shape: the column came from the old ADD COLUMN path,
    // nullable, and a row carries NULL.
    await sql.unsafe(`ALTER TABLE "${SCHEMA}"."rows" ALTER COLUMN attempts DROP NOT NULL`)
    await sql.unsafe(`UPDATE "${SCHEMA}"."rows" SET attempts = NULL`)
    expect((await column("attempts")).is_nullable).toBe("YES")

    await registerApps(
      [manifest("1.2.0", { title: "string", attempts: { type: "integer", default: 0 } }) as any],
      TEST_ORG,
    )

    expect((await column("attempts")).is_nullable).toBe("NO")
    const rows = await sql.unsafe(`SELECT attempts FROM "${SCHEMA}"."rows"`)
    expect(rows.map((r: any) => r.attempts)).toEqual([0])
  })

  it("leaves a non-nullable field without a default nullable rather than fail", async () => {
    await registerApps(
      [
        manifest("1.3.0", {
          title: "string",
          attempts: { type: "integer", default: 0 },
          note: "string",
        }) as any,
      ],
      TEST_ORG,
    )
    // No value to give the existing row: NOT NULL would abort the registration.
    expect((await column("note")).is_nullable).toBe("YES")
  })

  it("drops NOT NULL when a later version makes a field nullable, keeping its rows", async () => {
    expect((await column("attempts")).is_nullable).toBe("NO")

    await registerApps(
      [
        manifest("1.4.0", {
          title: "string",
          attempts: { type: "integer", default: 0, required: false },
          note: "string?",
        }) as any,
      ],
      TEST_ORG,
    )

    expect((await column("attempts")).is_nullable).toBe("YES")
    const rows = await sql.unsafe(`SELECT attempts FROM "${SCHEMA}"."rows"`)
    expect(rows.map((r: any) => r.attempts)).toEqual([0])
    // A row without the value can now be written.
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}"."rows" (org_id, title, attempts) VALUES ('${TEST_ORG}', 'later', NULL)`,
    )
    // The columns the manifest still declares NOT NULL stay so.
    expect((await column("title")).is_nullable).toBe("NO")
  })
})
