// SPDX-License-Identifier: FSL-1.1-ALv2
// Time rows lose their person after 36 months. Once a month, each row whose work day is older
// than that keeps its minutes and gets its cost frozen at the rate that was in force on that
// day, then its person is removed. Totals and margin read the same before and after. The job
// decides by the row's age alone: it reads no activity, judges no one and tells no one.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"

/** How long a time row keeps its person. */
export const TASK_TIME_PERSON_MONTHS = 36

/** The first work day still kept with its person, `months` before `now` (UTC). */
export function personCutoff(now: Date, months = TASK_TIME_PERSON_MONTHS): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()))
  return d.toISOString().slice(0, 10)
}

/**
 * Freeze the cost of every row older than the cutoff, then remove its person. One transaction,
 * so a row never loses its person before its cost is kept. Orgs being moved are skipped.
 */
export async function anonymiseOldTaskTime(now: Date = new Date()): Promise<{
  cutoff: string
  anonymised: number
}> {
  const cutoff = personCutoff(now)
  const anonymised = await sweepSkippingMoving((notMoving) =>
    withSystemDb("projects-task-time-anonymise", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("task_time")} tt
           SET (cost_minor, cost_currency) = (
             SELECT round(tt.minutes::numeric * c.rate_minor / 60)::bigint, c.currency
               FROM ${projectsRel("cost_rates")} c
              WHERE c.org_id = tt.org_id AND c.user_id = tt.user_id
                AND c.effective_from <= tt.work_date
              ORDER BY c.effective_from DESC LIMIT 1)
         WHERE tt.user_id IS NOT NULL AND tt.cost_minor IS NULL
           AND tt.work_date < ${cutoff}::date
           AND ${notMoving(drizzleSql.raw("tt.org_id"))}`)
      const gone = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          UPDATE ${projectsRel("task_time")} tt SET user_id = NULL, changed_by = NULL
           WHERE tt.user_id IS NOT NULL AND tt.work_date < ${cutoff}::date
             AND ${notMoving(drizzleSql.raw("tt.org_id"))}
          RETURNING tt.id::text AS id`),
      )
      return gone.length
    }),
  )
  return { cutoff, anonymised }
}
