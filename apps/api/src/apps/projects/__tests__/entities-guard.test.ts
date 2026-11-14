// SPDX-License-Identifier: FSL-1.1-ALv2
// The time, reconcile and capacity tables hold per-person and billing facts. None of them
// is a searchable entity, an export column set, an import target or attention text.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { projectsAppManifest } from "../manifest-descriptor"

const MIGRATIONS = join(import.meta.dir, "../../../db/migrations")
const ATTENTION_SOURCE = join(import.meta.dir, "../attention.ts")

/** Tables the time and budgets migrations created in the projects schema. */
function newTimeTables(): string[] {
  const names = new Set<string>()
  for (const file of readdirSync(MIGRATIONS)) {
    if (!/^03(2[0-9])_projects_(time|reconcile)/.test(file) || !file.endsWith(".sql")) continue
    const sql = readFileSync(join(MIGRATIONS, file), "utf8")
    for (const m of sql.matchAll(/CREATE TABLE app_projects\.([a-z_]+)/g)) names.add(m[1]!)
  }
  return [...names].sort()
}

function mentions(haystack: string, table: string): boolean {
  return new RegExp(`(^|[^a-z_])${table}([^a-z_]|$)`).test(haystack)
}

describe("projects entities, export, import and attention", () => {
  const manifest = projectsAppManifest as unknown as {
    entities: unknown
    export: { schema: unknown }
    import: { kinds: Record<string, unknown> }
    attention: unknown
  }

  it("the new tables are not in search, export or import", () => {
    const tables = newTimeTables()
    // The guard reads the migrations, so it fails loud if they move or are renamed.
    expect(tables).toEqual(
      expect.arrayContaining([
        "reconciliations",
        "reconciliation_lines",
        "task_time",
        "person_capacity",
        "project_timeboxes",
        "days_off",
      ]),
    )
    const surfaces: Record<string, string> = {
      entities: JSON.stringify(manifest.entities),
      "export.schema": JSON.stringify(manifest.export.schema),
      "import.kinds": JSON.stringify(manifest.import.kinds),
      attention: `${JSON.stringify(manifest.attention)}\n${readFileSync(ATTENTION_SOURCE, "utf8")}`,
    }
    const found: string[] = []
    for (const [surface, text] of Object.entries(surfaces)) {
      for (const table of tables) if (mentions(text, table)) found.push(`${surface}: ${table}`)
    }
    expect(found).toEqual([])
  })

  it("no import kind or searchable entity is named after a new table", () => {
    const tables = newTimeTables()
    const named = [
      ...Object.keys(manifest.import.kinds),
      ...Object.keys(manifest.entities as object),
    ]
    for (const name of named) expect(tables).not.toContain(name)
  })
})
