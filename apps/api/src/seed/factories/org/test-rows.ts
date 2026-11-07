// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Rows a database-level test needs in place, written as plain SQL text: the
// schema tests (constraints, row-level security, role grants) insert a row to
// be refused, so the statement itself must reach the database unchanged, and
// no service or provisioning path may stand in the way. The values are fixed
// ids and literals of the test, never user input.
/** A SQL expression written as is, such as `now()`. */
export interface RawExpression {
  raw: string
}

export type RowValue = string | number | boolean | null | RawExpression

function literal(value: RowValue): string {
  if (value === null) return "NULL"
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value === "object") return value.raw
  return `'${value.replaceAll("'", "''")}'`
}

/** One INSERT statement for one or more rows that share their columns. */
export function insertSql(
  table: string,
  rows: Record<string, RowValue> | Record<string, RowValue>[],
  options: { returning?: string; onConflictDoNothing?: boolean } = {},
): string {
  const list = Array.isArray(rows) ? rows : [rows]
  const first = list[0]
  if (!first) throw new Error("insertSql needs at least one row")
  const columns = Object.keys(first)
  const values = list
    .map((row) => `(${columns.map((c) => literal(row[c] ?? null)).join(", ")})`)
    .join(", ")
  return (
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values}` +
    (options.onConflictDoNothing ? " ON CONFLICT DO NOTHING" : "") +
    (options.returning ? ` RETURNING ${options.returning}` : "")
  )
}
