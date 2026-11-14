// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every column that points at another row must be a link the relation matrix names, so a new
// reference cannot arrive without its cells. The guard reads the schema as the database has it
// after migrating (kernel and every app schema, including what manifests add), not the migration
// text. A column counts as a reference when its name ends in `_id` or `_ids`, or when it has a
// foreign key. Columns that existed before the matrix and belong to links not built yet are in
// `reference-columns.baseline.txt`; that list only shrinks as their links are built.

import { readFileSync } from "node:fs"
import path from "node:path"

export interface SchemaColumn {
  schema: string
  table: string
  column: string
  hasForeignKey: boolean
}

export const BASELINE_PATH = path.join(import.meta.dir, "reference-columns.baseline.txt")

/** `app_<name>` and its test namespace prefixes read as one schema name. */
export function columnKey(c: Pick<SchemaColumn, "schema" | "table" | "column">): string {
  const schema = c.schema.replace(/^[a-z0-9]+_(?=app_)/, "")
  return `${schema}.${c.table}.${c.column}`
}

export function isReference(c: SchemaColumn): boolean {
  if (c.column === "id" || c.column === "org_id") return false
  return c.hasForeignKey || /_ids?$/.test(c.column)
}

export function readBaseline(text = readFileSync(BASELINE_PATH, "utf8")): Set<string> {
  return new Set(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  )
}

/** Reference columns no link names and the baseline does not hold. */
export function unnamedReferences(
  columns: readonly SchemaColumn[],
  named: ReadonlySet<string>,
  baseline: ReadonlySet<string>,
): string[] {
  const out = new Set<string>()
  for (const c of columns) {
    if (!isReference(c)) continue
    const key = columnKey(c)
    if (!named.has(key) && !baseline.has(key)) out.add(key)
  }
  return [...out].sort()
}

/** Baseline entries that no longer exist or that a link now names: the list must shrink with them. */
export function staleBaseline(
  columns: readonly SchemaColumn[],
  named: ReadonlySet<string>,
  baseline: ReadonlySet<string>,
): string[] {
  const present = new Set(columns.filter(isReference).map(columnKey))
  return [...baseline].filter((k) => !present.has(k) || named.has(k)).sort()
}
