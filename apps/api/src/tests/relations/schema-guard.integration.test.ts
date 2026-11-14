// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The schema guard on the migrated database: every reference column of kernel and of the schema
// of each app in the tree (what its manifest adds included) is held by a link of links.yaml, or listed in the baseline of columns whose links are
// not built yet. Write the baseline again (only when a link is built or a column goes):
// RELATIONS_BASELINE_WRITE=1.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { sql } from "~/db/connection"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { loadLinks } from "./matrix"
import {
  BASELINE_PATH,
  columnKey,
  isReference,
  readBaseline,
  type SchemaColumn,
  staleBaseline,
  unnamedReferences,
} from "./schema-guard"

/** kernel and the schema of each app in the tree: a schema another test made is not the product's. */
function productSchemas(): string[] {
  const appsDir = path.join(import.meta.dir, "../../apps")
  const names = readdirSync(appsDir)
    .filter((d) => existsSync(path.join(appsDir, d, "app.manifest.json")))
    .map(
      (d) =>
        (
          JSON.parse(readFileSync(path.join(appsDir, d, "app.manifest.json"), "utf8")) as {
            name: string
          }
        ).name,
    )
  return ["kernel", ...names.map((n) => `app_${n.replaceAll("-", "_")}`)]
}

/**
 * Columns of the bundled apps' tables, read from their manifests: a bundled app's schema is made
 * when the app is installed, so the migrated database does not carry it. `app_<name>.<table>.<column>`.
 */
function bundledAppColumns(): Set<string> {
  const dir = path.join(import.meta.dir, "../../../../../bundled-apps")
  const out = new Set<string>()
  for (const d of readdirSync(dir)) {
    const file = path.join(dir, d, "app.manifest.json")
    if (!existsSync(file)) continue
    const m = JSON.parse(readFileSync(file, "utf8")) as {
      name: string
      schema?: Record<string, { fields?: Record<string, unknown> }>
    }
    const schema = `app_${m.name.replaceAll("-", "_")}`
    for (const [table, spec] of Object.entries(m.schema ?? {})) {
      for (const column of ["id", "org_id", ...Object.keys(spec.fields ?? {})])
        out.add(`${schema}.${table}.${column}`)
    }
  }
  return out
}

async function migratedColumns(): Promise<SchemaColumn[]> {
  const schemas = productSchemas()
  const rows = (await sql`
    SELECT c.table_schema AS schema, c.table_name AS "table", c.column_name AS column,
      EXISTS (
        SELECT 1 FROM information_schema.key_column_usage k
        JOIN information_schema.table_constraints tc
          ON tc.constraint_name = k.constraint_name AND tc.constraint_schema = k.constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND k.table_schema = c.table_schema
          AND k.table_name = c.table_name AND k.column_name = c.column_name
      ) AS "hasForeignKey"
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = ANY(${schemas})`) as SchemaColumn[]
  return rows
}

describe("relation schema guard on the migrated database", () => {
  let columns: SchemaColumn[] = []
  const named = new Set(loadLinks().flatMap((l) => l.columns ?? []))

  beforeAll(async () => {
    await acquireTestLock()
    columns = await migratedColumns()
    if (process.env.RELATIONS_BASELINE_WRITE === "1") {
      const keys = [...new Set(columns.filter(isReference).map(columnKey))]
        .filter((k) => !named.has(k))
        .sort()
      writeFileSync(
        BASELINE_PATH,
        `# Reference columns whose links are not built yet. Only shrinks: see schema-guard.ts.\n${keys.join("\n")}\n`,
      )
    }
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("reads app schemas as well as kernel, and finds the columns the built links name, a bundled app's in its manifest", () => {
    expect(columns.some((c) => c.schema.startsWith("app_"))).toBe(true)
    const present = new Set([...columns.map(columnKey), ...bundledAppColumns()])
    expect([...named].filter((k) => !present.has(k))).toEqual([])
  })

  it("every reference column is a link the matrix names or a listed column of an unbuilt link", () => {
    expect(unnamedReferences(columns, named, readBaseline())).toEqual([])
  })

  it("the baseline lists no column a link now names and none that is gone", () => {
    expect(staleBaseline(columns, named, readBaseline())).toEqual([])
  })
})
