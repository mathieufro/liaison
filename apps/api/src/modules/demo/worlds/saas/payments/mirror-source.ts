// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org's own mirror rows, read for the stand-in: the payments app's tables
// in its own schema, on the privileged handle scoped to the org. Table names
// are built from the app's name (the schema through `schemaRef`, so a test
// schema resolves too), values are bound, nothing is spliced.
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { PAYMENTS_APP } from "./sentinel"

type Obj = Record<string, unknown>

/** Most rows one list read walks: a demo world's mirror is far smaller. */
export const MIRROR_READ_CAP = 2_000

/** What the stand-in reads of the mirror. A seam: the provider test passes rows of its own. */
export interface MirrorSource {
  /** Every row of `app_<app>.<app>_<table>` for the org (capped). */
  rows(table: string): Promise<Obj[]>
  /** One row by its processor id, or null. */
  row(table: string, processorId: string): Promise<Obj | null>
  /** The app's install row, or null when the app was never connected. */
  install(): Promise<Obj | null>
}

function target(table: string) {
  return sql`${sql.identifier(schemaRef(`app_${PAYMENTS_APP}`))}.${sql.identifier(table)}`
}

async function readMirrorRows(
  orgId: string,
  table: string,
  where: ReturnType<typeof sql> | null,
  limit: number,
): Promise<Obj[]> {
  return withPrivilegedDb(orgId, "demo-payments-standin-read", async (tx) => {
    const filter = where ? sql` AND ${where}` : sql``
    const result = (await tx.execute(
      sql`SELECT * FROM ${target(table)} WHERE org_id = ${orgId}${filter} LIMIT ${limit}`,
    )) as unknown
    return (Array.isArray(result) ? result : ((result as { rows?: Obj[] }).rows ?? [])) as Obj[]
  })
}

/** The mirror of `orgId`, read from Postgres. */
export function dbMirrorSource(orgId: string): MirrorSource {
  return {
    rows: (table) => readMirrorRows(orgId, `${PAYMENTS_APP}_${table}`, null, MIRROR_READ_CAP),
    row: async (table, processorId) =>
      (
        await readMirrorRows(
          orgId,
          `${PAYMENTS_APP}_${table}`,
          sql`${sql.identifier(`${PAYMENTS_APP}_id`)} = ${processorId}`,
          1,
        )
      )[0] ?? null,
    install: async () => (await readMirrorRows(orgId, "install_metadata", null, 1))[0] ?? null,
  }
}
