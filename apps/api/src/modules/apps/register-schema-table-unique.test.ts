// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A table-level UNIQUE the manifest declares must exist on the live table,
// whether the table was created with it or predates the declaration.
//
// CREATE TABLE emitted it inline, but the additive ALTER path skipped it, so a
// table created before the declaration (or by hand) never got it, and every
// `ON CONFLICT (<those columns>)` the app runs then failed on each write (the
// mail sync's conversation upsert against an older app_mail.conversations).
//
// Fails-without-fix: after the v2 registration no unique index covers
// (org_id, title).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import { registerApps } from "~/modules/apps/runtime"

const TEST_ORG = "00000000-0000-0000-0000-000000120932"
const APP = "uq-drift-app"
const SCHEMA = "app_uq_drift_app"

function manifest(version: string, unique?: string[][]) {
  return {
    name: APP,
    version,
    _format: "manifest" as const,
    _bundlePath: "/apps/uq-drift-app/handlers.js",
    scopes: [`${APP}:rows:read`],
    schema: {
      rows: { fields: { title: "string" }, ...(unique ? { constraints: { unique } } : {}) },
    },
  }
}

/** The non-partial unique indexes on the table, each as its sorted column list. */
async function uniqueIndexes(): Promise<string[]> {
  const rows = await sql<{ cols: string }[]>`
    SELECT (SELECT string_agg(a.attname::text, ',' ORDER BY a.attname::text)
              FROM unnest(i.indkey) AS k(attnum)
              JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum) AS cols
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = ${SCHEMA} AND t.relname = 'rows'
      AND i.indisunique AND NOT i.indisprimary AND i.indpred IS NULL`
  return rows.map((r) => r.cols).sort()
}

describe("registerApps adds a declared table UNIQUE the live table lacks", () => {
  beforeAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'UQ Drift Org', 'uq-drift-org')
      ON CONFLICT (id) DO NOTHING`
  })

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = ${APP}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  it("adds the UNIQUE to a table created before it was declared, once", async () => {
    await registerApps([manifest("1.0.0") as any], TEST_ORG)
    expect(await uniqueIndexes()).toEqual([])

    await registerApps([manifest("1.1.0", [["title"]]) as any], TEST_ORG)
    expect(await uniqueIndexes()).toEqual(["org_id,title"])

    // Registering again (and a table created with the UNIQUE inline) adds no duplicate.
    await registerApps([manifest("1.1.1", [["title"]]) as any], TEST_ORG)
    expect(await uniqueIndexes()).toEqual(["org_id,title"])
  })

  it("adds no wider UNIQUE when a narrower unique key already covers it", async () => {
    // A table whose own key is (title) already makes (org_id, title) unique. A
    // second, wider unique index would not be the arbiter of an upsert's
    // ON CONFLICT (title), so concurrent upserts of one new row raced on it and
    // one failed with a unique violation.
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = ${APP}`
    await registerApps([manifest("1.0.0") as any], TEST_ORG)
    await sql.unsafe(`CREATE UNIQUE INDEX rows_title_key ON "${SCHEMA}"."rows" (title)`)

    await registerApps([manifest("1.1.0", [["title"]]) as any], TEST_ORG)
    expect(await uniqueIndexes()).toEqual(["title"])
  })

  it("leaves a table whose rows violate the UNIQUE registered, without it", async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = ${APP}`
    await registerApps([manifest("1.0.0") as any], TEST_ORG)
    await sql.unsafe(
      `INSERT INTO "${SCHEMA}"."rows" (org_id, title) VALUES ('${TEST_ORG}', 'dup'), ('${TEST_ORG}', 'dup')`,
    )

    await registerApps([manifest("1.1.0", [["title"]]) as any], TEST_ORG)
    expect(await uniqueIndexes()).toEqual([])
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM ${sql(SCHEMA)}.rows`
    expect(count.n).toBe(2)
  })
})
