// SPDX-License-Identifier: FSL-1.1-ALv2
// The writes about time rows that no one person's transaction may make, because
// they reach other people: turning dated hours on tells everyone with entries on
// the project once on Home. It runs after the person's transaction commits (it
// reads committed state), on the privileged handle. Moves and merges carry the
// rows in the mover's own transaction, in the database (migration 0321: the
// tasks trigger and app_projects.merge_task_time). Nothing here reads activity
// on a schedule, and no row's minutes are ever shown to anyone but their author.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type PrivilegedDb } from "~/db"
import { afterCurrentCommit } from "~/db/commit-hooks"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "projects/time-rows" })

export const DATED_ON_KIND = "projects:time_budgets.dated_on"

const inFlight = new Set<Promise<void>>()

/** Resolves once every time-row write queued so far has finished (tests). */
export async function awaitTimeRowWrites(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight])
}

/** Run `fn` once the caller's transaction ends, or at once outside one. */
function writeTimeRowsAfterCommit(
  orgId: string,
  reason: string,
  fn: (tx: PrivilegedDb) => Promise<void>,
): void {
  const start = () => {
    const p: Promise<void> = withPrivilegedDb(orgId, reason, fn)
      .catch((err) => log.error({ err, orgId, reason }, "time rows write failed"))
      .finally(() => inFlight.delete(p))
    inFlight.add(p)
  }
  if (!afterCurrentCommit(start)) start()
}

/** Dated hours turned on: one Home line to each person with entries on the project. */
export function tellEntrantsDatedOn(
  orgId: string,
  project: { id: string; name: string },
  actorId: string,
): void {
  writeTimeRowsAfterCommit(orgId, "projects-time-rows-dated-on", async (tx) => {
    const K = drizzleSql.raw(schemaRef("kernel"))
    const people = extractRows<{ user_id: string }>(
      await tx.execute(drizzleSql`
        SELECT DISTINCT user_id::text AS user_id FROM ${projectsRel("task_time")}
         WHERE org_id = ${orgId}::uuid AND project_id = ${project.id}::uuid
           AND user_id IS NOT NULL`),
    )
    const summary = `${project.name} now uses dated hours: from now on its lead and finance see the days and hours you enter on it. What you entered before stays yours alone.`
    for (const { user_id } of people) {
      await tx.execute(drizzleSql`
        INSERT INTO ${K}.attention_events
          (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_id,
           actor_type, metadata, occurred_at, is_urgent, digest_state, digest_eligible_at, email_only)
        VALUES (${orgId}::uuid, ${user_id}::uuid, 'projects', 'project', ${project.id},
                ${DATED_ON_KIND}, 20, ${summary}, ${actorId}::uuid, 'user', '{}'::jsonb,
                now(), false, 'not_eligible', now(), false)
        ON CONFLICT (user_id, app, entity_type, entity_id, kind)
          WHERE read_at IS NULL AND email_only = false
          DO NOTHING`)
    }
  })
}
