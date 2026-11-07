// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The export closure of one org: every table whose rows belong to it.
//
// `orgScopedTables` (purge/rows.ts) lists the tables carrying an `org_id`, which
// is enough for a purge (the rest goes by FK cascade) and not for a copy: a
// role's scope grants, a person's preferences, an MCP connection's tool policy
// carry no `org_id`, only a foreign key to a row that does. The closure is
// therefore built from the catalog:
//
//   org        kernel.organizations, the org row itself (`id`);
//   direct     a table with an `org_id` column;
//   via        a table without one that references a closure table by foreign
//              key; its rows are the ones whose parent row is the org's (the
//              join path is kept, and may be several hops long).
//
// Every other table of `kernel` and the `app_*` schemas is instance state
// (`global`), and a table the catalog puts in the closure that must not move
// is `excluded` with its reason. Both lists live in `classification.ts`,
// pinned by closure.test.ts against the catalog: a new table fails that test
// until it is classified, and an unclassified kernel table refuses an export
// at run time (fail closed).
import { EXCLUDED_TABLES, GLOBAL_TABLES } from "./classification"

export type ClosureKind = "org" | "direct" | "via"

export interface ColumnInfo {
  name: string
  type: string
  /** Position among the live (not dropped) columns, from 1. */
  ordinal: number
  /** A generated column: never inserted, recomputed by the target. */
  generated: boolean
  /** An identity column (`GENERATED ALWAYS` needs OVERRIDING SYSTEM VALUE). */
  identity: "" | "a" | "d"
  /** NOT NULL: a foreign key on such columns reaches every row of its table. */
  notNull?: boolean
}

export interface ForeignKey {
  name: string
  /** `schema.table` */
  table: string
  columns: string[]
  refTable: string
  refColumns: string[]
  /** Compare as text (a synthetic link whose columns differ in type). */
  asText?: boolean
}

/**
 * Links the catalog cannot see: no foreign key, but each row is about one row
 * of a closure table. `durable_consumer_marks` records that a consumer handled
 * an outbox event (`event_id` = the `pending_events` id, as text); the org's
 * marks travel with its events so a replayed event is not handled twice on the
 * target.
 */
export const SYNTHETIC_LINKS: ForeignKey[] = [
  {
    name: "transfer:consumer-marks",
    table: "kernel.durable_consumer_marks",
    columns: ["event_id"],
    refTable: "kernel.pending_events",
    refColumns: ["id"],
    asText: true,
  },
]

/**
 * A unique index with a predicate (`WHERE ...`) or an expression key
 * (`lower(email)`): its keys are SQL on the table's own columns, and a row
 * only takes part when the predicate holds.
 */
export interface ComplexUnique {
  name: string
  /** One SQL expression per key column (a plain column is its quoted name). */
  keys: string[]
  predicate: string | null
}

export interface ClosureTable {
  /** `schema.table` */
  name: string
  schema: string
  table: string
  kind: ClosureKind
  /** For `via`: the foreign key to the parent closure table. */
  parent?: ForeignKey
  primaryKey: string[]
  columns: ColumnInfo[]
  /** Unique indexes (and constraints) that do not include `org_id`. */
  globalUniques: Array<{ name: string; columns: string[] }>
  /** Partial or expression unique indexes that do not name `org_id`. */
  complexUniques: ComplexUnique[]
  /** Every foreign key of the table (closure or not), checked after an import. */
  foreignKeys: ForeignKey[]
}

export interface CatalogTable {
  name: string
  schema: string
  table: string
  columns: ColumnInfo[]
  primaryKey: string[]
  uniques: Array<{ name: string; columns: string[] }>
  complexUniques: ComplexUnique[]
  foreignKeys: ForeignKey[]
}

/** What a transfer needs of a database connection (postgres.js `Sql` or a transaction). */
export interface TransferSql {
  unsafe: (query: string, params?: never[]) => Promise<unknown> & PromiseLike<unknown>
}

export async function query<T>(
  sql: TransferSql,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const rows = (await sql.unsafe(text, params as never[])) as unknown
  return (Array.isArray(rows) ? rows : []) as T[]
}

const ORG_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertUuid(id: string, what: string): string {
  if (!ORG_UUID.test(id)) throw new Error(`${what}: not a uuid: ${id}`)
  return id.toLowerCase()
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

export function rel(name: string): string {
  const dot = name.indexOf(".")
  return `${quoteIdent(name.slice(0, dot))}.${quoteIdent(name.slice(dot + 1))}`
}

/** Every base table of `kernel` and the `app_*` schemas with its columns, keys and FKs. */
export async function readCatalog(sql: TransferSql): Promise<Map<string, CatalogTable>> {
  const tables = await query<{ schema: string; table: string }>(
    sql,
    `SELECT n.nspname AS schema, c.relname AS table
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
      ORDER BY 1, 2`,
  )
  const out = new Map<string, CatalogTable>()
  for (const t of tables) {
    const name = `${t.schema}.${t.table}`
    out.set(name, {
      name,
      schema: t.schema,
      table: t.table,
      columns: [],
      primaryKey: [],
      uniques: [],
      complexUniques: [],
      foreignKeys: [],
    })
  }
  const cols = await query<{
    schema: string
    table: string
    name: string
    type: string
    generated: string
    identity: string
    not_null: boolean
  }>(
    sql,
    `SELECT n.nspname AS schema, c.relname AS table, a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attgenerated::text AS generated, a.attidentity::text AS identity,
            a.attnotnull AS not_null
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE a.attnum > 0 AND NOT a.attisdropped
        AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
      ORDER BY n.nspname, c.relname, a.attnum`,
  )
  for (const c of cols) {
    const t = out.get(`${c.schema}.${c.table}`)
    if (!t) continue
    t.columns.push({
      name: c.name,
      type: c.type,
      ordinal: t.columns.length + 1,
      generated: c.generated !== "",
      identity: (c.identity || "") as ColumnInfo["identity"],
      notNull: c.not_null,
    })
  }
  const idx = await query<{
    schema: string
    table: string
    name: string
    primary: boolean
    columns: string[]
  }>(
    sql,
    `SELECT n.nspname AS schema, c.relname AS table, i.relname AS name, x.indisprimary AS primary,
            array(SELECT a.attname FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
                  ORDER BY k.ord)::text[] AS columns
       FROM pg_index x
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE x.indisunique AND x.indpred IS NULL AND 0 <> ALL (x.indkey::int2[])
        AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
      ORDER BY 1, 2, 3`,
  )
  for (const i of idx) {
    const t = out.get(`${i.schema}.${i.table}`)
    if (!t) continue
    if (i.primary) t.primaryKey = i.columns
    t.uniques.push({ name: i.name, columns: i.columns })
  }
  // Partial and expression unique indexes (not primary keys): a collision with
  // another org's row is refused before anything is copied, like the plain ones.
  const complex = await query<{
    schema: string
    table: string
    name: string
    keys: string[]
    predicate: string | null
  }>(
    sql,
    `SELECT n.nspname AS schema, c.relname AS table, i.relname AS name,
            array(SELECT pg_get_indexdef(x.indexrelid, k, true) FROM generate_series(1, x.indnkeyatts) k ORDER BY k)::text[] AS keys,
            pg_get_expr(x.indpred, x.indrelid) AS predicate
       FROM pg_index x
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE x.indisunique AND NOT x.indisprimary
        AND (x.indpred IS NOT NULL OR 0 = ANY (x.indkey::int2[]))
        AND (n.nspname = 'kernel' OR n.nspname LIKE 'app_%')
      ORDER BY 1, 2, 3`,
  )
  for (const i of complex) {
    const t = out.get(`${i.schema}.${i.table}`)
    if (!t) continue
    // An index that names org_id keeps every org apart.
    if (i.keys.some((k) => /\borg_id\b/.test(k))) continue
    t.complexUniques.push({ name: i.name, keys: i.keys, predicate: i.predicate })
  }
  const fks = await query<{
    name: string
    schema: string
    table: string
    columns: string[]
    ref_schema: string
    ref_table: string
    ref_columns: string[]
  }>(
    sql,
    `SELECT con.conname AS name, n.nspname AS schema, c.relname AS table,
            array(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
                  ORDER BY k.ord)::text[] AS columns,
            rn.nspname AS ref_schema, rc.relname AS ref_table,
            array(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
                  ORDER BY k.ord)::text[] AS ref_columns
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class rc ON rc.oid = con.confrelid
       JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      WHERE con.contype = 'f'
        AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
      ORDER BY 1, 2, 3`,
  )
  for (const f of fks) {
    const t = out.get(`${f.schema}.${f.table}`)
    if (!t) continue
    const fk: ForeignKey = {
      name: f.name,
      table: t.name,
      columns: f.columns,
      refTable: `${f.ref_schema}.${f.ref_table}`,
      refColumns: f.ref_columns,
    }
    // A constraint declared twice (same columns, same target) is one path.
    if (
      t.foreignKeys.some(
        (g) =>
          g.refTable === fk.refTable &&
          g.columns.join() === fk.columns.join() &&
          g.refColumns.join() === fk.refColumns.join(),
      )
    ) {
      continue
    }
    t.foreignKeys.push(fk)
  }
  return out
}

export const ORG_TABLE = "kernel.organizations"

export interface Closure {
  /** In closure order: the org row first, then direct tables, then each `via` level. */
  tables: ClosureTable[]
  byName: Map<string, ClosureTable>
  /** Kernel/app tables neither in the closure nor classified global/excluded. */
  unclassified: string[]
}

/**
 * Build the closure from the catalog. `excluded` tables (and anything reachable
 * only through them) stay out.
 */
export function buildClosure(
  catalog: Map<string, CatalogTable>,
  excluded: ReadonlySet<string> = new Set(Object.keys(EXCLUDED_TABLES)),
): Closure {
  const tables: ClosureTable[] = []
  const byName = new Map<string, ClosureTable>()
  const add = (t: CatalogTable, kind: ClosureKind, parent?: ForeignKey) => {
    const ct: ClosureTable = {
      name: t.name,
      schema: t.schema,
      table: t.table,
      kind,
      ...(parent ? { parent } : {}),
      primaryKey: t.primaryKey,
      columns: t.columns,
      globalUniques: t.uniques.filter((u) => !u.columns.includes("org_id")),
      complexUniques: t.complexUniques,
      foreignKeys: t.foreignKeys,
    }
    tables.push(ct)
    byName.set(t.name, ct)
  }
  const org = catalog.get(ORG_TABLE)
  if (!org) throw new Error("org transfer: kernel.organizations is missing from the catalog")
  add(org, "org")
  for (const t of catalog.values()) {
    if (t.name === ORG_TABLE || excluded.has(t.name)) continue
    if (t.columns.some((c) => c.name === "org_id")) add(t, "direct")
  }
  // Breadth first: a table joins at the level of its nearest closure parent.
  for (;;) {
    const level: Array<[CatalogTable, ForeignKey]> = []
    for (const t of catalog.values()) {
      if (byName.has(t.name) || excluded.has(t.name)) continue
      // A key on NOT NULL columns first: a nullable one (a person's next in line) would
      // leave behind every row where it is empty.
      const parents = t.foreignKeys.filter((f) => byName.has(f.refTable) && f.refTable !== t.name)
      const required = (f: ForeignKey) =>
        f.columns.every((c) => t.columns.find((col) => col.name === c)?.notNull === true)
      const fk =
        parents.find(required) ??
        parents[0] ??
        SYNTHETIC_LINKS.find((f) => f.table === t.name && byName.has(f.refTable))
      if (fk) level.push([t, fk])
    }
    if (level.length === 0) break
    for (const [t, fk] of level) add(t, "via", fk)
  }
  const unclassified: string[] = []
  for (const name of catalog.keys()) {
    if (byName.has(name) || excluded.has(name) || name in GLOBAL_TABLES) continue
    unclassified.push(name)
  }
  return { tables, byName, unclassified }
}

/** One line per table, the form the classification pin compares. */
export function describeClosureTable(t: ClosureTable): string {
  if (t.kind !== "via" || !t.parent) return t.kind
  return `via ${t.parent.refTable} (${t.parent.columns.join(",")} -> ${t.parent.refColumns.join(",")})`
}

/**
 * The predicate "this row of `t` (aliased `alias`) belongs to org `orgId`".
 * `orgId` must be a checked uuid (assertUuid): it is inlined as a literal.
 */
/**
 * `orgPredicate` for a staged row of an import that does not apply its rows (the dry run of a
 * replacing import): a child's parent may be a row that arrived earlier in the same bundle and
 * sits only in that parent's staging table (already checked as this org's when it was staged).
 * A live parent still has to be this org's.
 */
export function stagedOrgPredicate(
  closure: Closure,
  t: ClosureTable,
  alias: string,
  orgId: string,
  stagedParent: (table: string) => string | undefined,
): string {
  const live = orgPredicate(closure, t, alias, orgId)
  if (t.kind !== "via" || !t.parent) return live
  const staged = stagedParent(t.parent.refTable)
  if (!staged) return live
  const fk = t.parent
  const join = fk.columns
    .map((c, i) =>
      fk.asText
        ? `sp.${quoteIdent(fk.refColumns[i] as string)}::text = ${alias}.${quoteIdent(c)}::text`
        : `sp.${quoteIdent(fk.refColumns[i] as string)} = ${alias}.${quoteIdent(c)}`,
    )
    .join(" AND ")
  return `(${live} OR EXISTS (SELECT 1 FROM ${staged} sp WHERE ${join}))`
}

export function orgPredicate(
  closure: Closure,
  t: ClosureTable,
  alias: string,
  orgId: string,
  depth = 0,
): string {
  const org = `'${assertUuid(orgId, "orgPredicate")}'::uuid`
  if (t.kind === "org") return `${alias}.id = ${org}`
  if (t.kind === "direct") return `${alias}.org_id = ${org}`
  const fk = t.parent
  if (!fk) throw new Error(`org transfer: ${t.name} has no parent`)
  const parent = closure.byName.get(fk.refTable)
  if (!parent)
    throw new Error(`org transfer: ${t.name}'s parent ${fk.refTable} is not in the closure`)
  const p = `p${depth}`
  const join = fk.columns
    .map((c, i) =>
      fk.asText
        ? `${p}.${quoteIdent(fk.refColumns[i] as string)}::text = ${alias}.${quoteIdent(c)}::text`
        : `${p}.${quoteIdent(fk.refColumns[i] as string)} = ${alias}.${quoteIdent(c)}`,
    )
    .join(" AND ")
  return `EXISTS (SELECT 1 FROM ${rel(parent.name)} ${p} WHERE ${join} AND ${orgPredicate(
    closure,
    parent,
    p,
    orgId,
    depth + 1,
  )})`
}

/** The closure of the database `sql` points at, refusing unclassified kernel tables. */
export async function loadClosure(sql: TransferSql): Promise<Closure> {
  return assertTransferable(buildClosure(await readCatalog(sql)))
}

/** Refuse a closure with an unclassified kernel table or a table without a primary key. */
export function assertTransferable(closure: Closure): Closure {
  const kernel = closure.unclassified.filter((n) => n.startsWith("kernel."))
  if (kernel.length > 0) {
    throw new Error(
      `org transfer: kernel table(s) ${kernel.join(", ")} are not classified ` +
        "(modules/org/transfer/classification.ts); refusing to copy an org without them",
    )
  }
  for (const t of closure.tables) {
    if (t.primaryKey.length === 0) {
      throw new Error(`org transfer: ${t.name} has no primary key; a delta cannot address its rows`)
    }
  }
  return closure
}

/** Column fingerprint of a table: `name type` per live column, in order. */
export function columnFingerprint(t: { columns: ColumnInfo[] }): string {
  return t.columns
    .map((c) => `${c.ordinal}:${c.name} ${c.type}${c.generated ? " gen" : ""}`)
    .join("|")
}
