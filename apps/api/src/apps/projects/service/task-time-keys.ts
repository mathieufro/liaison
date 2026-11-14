// SPDX-License-Identifier: FSL-1.1-ALv2
// The time keys a task row carries on a project that uses time and budgets: its timebox, the
// task's total of time spent (everyone's, with no one's part named) and its milestone flag. A
// task of any other project, or of an org where no project uses it, carries none of the keys,
// not even empty ones. The total comes from `task_time_totals`, which answers per task and
// never per person, so no row of another person reaches the caller.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import { orgUsesTimeBudgets } from "./planning"

export interface TaskTimeKeys {
  timeboxMinutes: number | null
  /** The task's total, everyone's entries together. Absent without the project-read scope. */
  realTotalMinutes?: number
  isMilestone: boolean
}

type Tx = RlsClient | RlsTx

/**
 * Add the time keys to each row whose project uses time and budgets, in place, with one query
 * for the rows and one totals read per such project. Rows of other projects are left as they are.
 */
export async function attachTaskTimeKeys<T extends { id: string; projectId: string }>(
  tx: Tx,
  orgId: string,
  rows: T[],
): Promise<Array<T & Partial<TaskTimeKeys>>> {
  const out = rows as Array<T & Partial<TaskTimeKeys>>
  if (rows.length === 0 || !orgUsesTimeBudgets(orgId)) return out
  const ids = drizzleSql.join(
    rows.map((r) => drizzleSql`${r.id}::uuid`),
    drizzleSql`, `,
  )
  const planned = extractRows<{
    id: string
    project_id: string
    timebox_minutes: number | null
    is_milestone: boolean
  }>(
    await tx.execute(drizzleSql`
      SELECT t.id::text AS id, t.project_id::text AS project_id, t.timebox_minutes, t.is_milestone
        FROM ${projectsRel("tasks")} t
        JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
       WHERE t.org_id = ${orgId}::uuid AND t.id IN (${ids})
         AND p.kind = 'work' AND p.time_budgets_on`),
  )
  if (planned.length === 0) return out
  const byTask = new Map(planned.map((r) => [r.id, r]))
  const canReadTotals =
    extractRows<{ ok: boolean }>(
      await tx.execute(
        drizzleSql`SELECT app_projects.app_has_scope('projects:projects:read') AS ok`,
      ),
    )[0]?.ok === true
  const totals = new Map<string, number>()
  if (canReadTotals) {
    for (const projectId of new Set(planned.map((r) => r.project_id))) {
      const rowsOf = extractRows<{ task_id: string; minutes: number | string }>(
        await tx.execute(drizzleSql`
          SELECT task_id::text AS task_id, minutes
            FROM ${projectsRel("task_time_totals")}(${projectId}::uuid, NULL, NULL)`),
      )
      for (const r of rowsOf) totals.set(r.task_id, Number(r.minutes))
    }
  }
  for (const row of out) {
    const p = byTask.get(row.id)
    if (!p) continue
    row.timeboxMinutes = p.timebox_minutes
    if (canReadTotals) row.realTotalMinutes = totals.get(row.id) ?? 0
    row.isMilestone = p.is_milestone
  }
  return out
}
