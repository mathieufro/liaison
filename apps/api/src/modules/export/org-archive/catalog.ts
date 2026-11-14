// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Which tables a whole-org export reads, from the live catalog (no table list
 * to keep in step):
 *
 *  - every base table of `kernel` and the `app_*` schemas with an `org_id`
 *    column (the discovery `demo-reset.ts` uses for its org-scoped tables),
 *  - `kernel.organizations`, the org's own row,
 *  - every table without `org_id` whose single-column foreign key points at
 *    one of those tables or at the org row (user preferences, attention
 *    subscriptions, role grants, node session events, ...): its rows belong to
 *    the org through that parent.
 *
 * Each table comes with its columns (type) and primary key, which the reader
 * pages by (keyset, one short transaction per batch).
 */
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

export interface ExportColumn {
  name: string
  /** `format_type` of the column, e.g. `bigint`, `timestamp with time zone`. */
  type: string
}

export type ExportTableReach =
  | { kind: "org" }
  | { kind: "org-row" }
  | {
      kind: "child"
      column: string
      parentSchema: string
      parentTable: string
      parentColumn: string
      parentIsOrgRow: boolean
    }

export interface ExportTable {
  /** Physical schema (with any test prefix). */
  schema: string
  /** Logical schema: `kernel`, `app_<name>`. */
  logicalSchema: string
  table: string
  columns: ExportColumn[]
  primaryKey: string[]
  reach: ExportTableReach
}

function prefix(): string {
  return schemaRef("")
}

/** `<logical schema>.<table>.<column>`, the key the redaction lists use. */
export function columnKey(t: Pick<ExportTable, "logicalSchema" | "table">, column: string): string {
  return `${t.logicalSchema}.${t.table}.${column}`
}

export async function discoverExportTables(): Promise<ExportTable[]> {
  const p = prefix()
  const kernel = schemaRef("kernel")
  const appLike = `${p.replaceAll("_", "\\_")}app\\_%`
  return withSystemDb("org-export-catalog", async (tx) => {
    const cols = extractRows<{ schema: string; table: string; column: string; type: string }>(
      await tx.execute(drizzleSql`
        SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
               format_type(a.atttypid, a.atttypmod) AS type
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
          AND (n.nspname = ${kernel} OR n.nspname LIKE ${appLike})
        ORDER BY n.nspname, c.relname, a.attnum
      `),
    )
    const pks = extractRows<{ schema: string; table: string; column: string }>(
      await tx.execute(drizzleSql`
        SELECT n.nspname AS schema, c.relname AS table, a.attname AS column
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE i.indisprimary AND (n.nspname = ${kernel} OR n.nspname LIKE ${appLike})
        ORDER BY n.nspname, c.relname, k.ord
      `),
    )
    const fks = extractRows<{
      schema: string
      table: string
      column: string
      parent_schema: string
      parent_table: string
      parent_column: string
    }>(
      await tx.execute(drizzleSql`
        SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
               pn.nspname AS parent_schema, pc.relname AS parent_table, pa.attname AS parent_column
        FROM pg_constraint k
        JOIN pg_class c ON c.oid = k.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
        JOIN pg_class pc ON pc.oid = k.confrelid
        JOIN pg_namespace pn ON pn.oid = pc.relnamespace
        JOIN pg_attribute pa ON pa.attrelid = k.confrelid AND pa.attnum = k.confkey[1]
        WHERE k.contype = 'f' AND array_length(k.conkey, 1) = 1
          AND (n.nspname = ${kernel} OR n.nspname LIKE ${appLike})
        ORDER BY n.nspname, c.relname, a.attnotnull DESC, k.conname
      `),
    )

    const byTable = new Map<string, ExportTable>()
    for (const r of cols) {
      const id = `${r.schema}.${r.table}`
      let t = byTable.get(id)
      if (!t) {
        t = {
          schema: r.schema,
          logicalSchema: r.schema.slice(p.length),
          table: r.table,
          columns: [],
          primaryKey: [],
          reach: { kind: "org" },
        }
        byTable.set(id, t)
      }
      t.columns.push({ name: r.column, type: r.type })
    }
    for (const r of pks) byTable.get(`${r.schema}.${r.table}`)?.primaryKey.push(r.column)

    const orgRowId = `${kernel}.organizations`
    const direct = new Set<string>()
    const out: ExportTable[] = []
    for (const [id, t] of byTable) {
      if (id === orgRowId) {
        t.reach = { kind: "org-row" }
        out.push(t)
      } else if (t.columns.some((c) => c.name === "org_id")) {
        direct.add(id)
        out.push(t)
      }
    }
    // A table with several foreign keys reaches the org through its first, and a
    // NOT NULL one sorts first: only it holds a parent for every row. A nullable
    // reference to a person (user_preferences.next_in_line_id) would export the
    // rows that name someone instead of the rows of each person.
    const seen = new Set<string>()
    for (const fk of fks) {
      const id = `${fk.schema}.${fk.table}`
      const t = byTable.get(id)
      if (!t || direct.has(id) || id === orgRowId || seen.has(id)) continue
      const parentId = `${fk.parent_schema}.${fk.parent_table}`
      const parentIsOrgRow = parentId === orgRowId
      if (!parentIsOrgRow && !direct.has(parentId)) continue
      seen.add(id)
      t.reach = {
        kind: "child",
        column: fk.column,
        parentSchema: fk.parent_schema,
        parentTable: fk.parent_table,
        parentColumn: fk.parent_column,
        parentIsOrgRow,
      }
      out.push(t)
    }
    // Every exported table is paged by its primary key; none lacks one today,
    // and the writer refuses an export rather than skip a table that does.
    return out.sort((a, b) =>
      `${a.logicalSchema}.${a.table}`.localeCompare(`${b.logicalSchema}.${b.table}`),
    )
  })
}
