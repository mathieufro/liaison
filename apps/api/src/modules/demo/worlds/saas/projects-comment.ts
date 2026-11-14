// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `saas-projects-comment`: the software world's projects scenario event. A
// developer comments on the visitor's task in the product project through the
// ordinary task-comment path, so the comment lands in the task's discussion and
// the visitor is notified like any other. Fixed content, once per run.
import { SAAS_PROJECTS_COMMENT_INJECTOR } from "@liaison/shared"
import { and, sql as drizzleSql, eq, gte } from "drizzle-orm"
import { postTaskComment } from "~/apps/projects/service/task-comment"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { messages } from "~/db/schema/kernel"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { worldActor, worldPersonId } from "~/seed/world/people"

/** The visitor's task, written when the scenario starts (`scenario-start.ts`). */
export const SAAS_PROJECTS_TASK_REF = "demo:saas:task:rota-csv-import"
export const SAAS_PROJECTS_TASK_TITLE = "Import rotas from a CSV file"
export const SAAS_PROJECTS_COMMENTER = "Baptiste Noël"
export const SAAS_PROJECTS_COMMENT =
  "Venues moving from spreadsheets will send us CSV files with one row per shift. Can you " +
  "break the import down for next week: the file format, the checks on bad rows and the " +
  "preview before anything is saved? Happy to take the parsing part."

export const saasProjectsCommentInjector: WorldInjector = {
  id: SAAS_PROJECTS_COMMENT_INJECTOR,
  world: "saas",
  async injectWorldEvent({ orgId, runStartedAt }) {
    const commenterId = await worldPersonId(orgId, SAAS_PROJECTS_COMMENTER)
    const task = await withPrivilegedDb(orgId, "demo-world-saas-projects-read", async (tx) => {
      const row = extractRows<{ id: string; thread_id: string | null }>(
        await tx.execute(
          drizzleSql`SELECT id::text AS id, thread_id::text AS thread_id FROM app_projects.tasks
            WHERE org_id = ${orgId}::uuid AND external_ref = ${SAAS_PROJECTS_TASK_REF} LIMIT 1`,
        ),
      )[0]
      if (!row) return null
      if (row.thread_id) {
        const [posted] = await tx
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.threadId, row.thread_id),
              eq(messages.authorId, commenterId),
              gte(messages.createdAt, runStartedAt),
            ),
          )
          .limit(1)
        if (posted) return { id: row.id, posted: true }
      }
      return { id: row.id, posted: false }
    })
    if (!task) throw new Error("demo world: the visitor's task is not there")
    if (task.posted) return
    const commenter = await worldActor(orgId, commenterId)
    await withRlsContext(commenter, (tx) =>
      postTaskComment(tx, {
        orgId,
        userId: commenterId,
        taskId: task.id,
        body: SAAS_PROJECTS_COMMENT,
        requiredScopes: [],
      }),
    )
  },
  // The visitor's task: the beats after the comment open it.
  async entityOf({ orgId }) {
    return withPrivilegedDb(orgId, "demo-world-saas-projects-task", async (tx) => {
      const row = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`SELECT id::text AS id FROM app_projects.tasks
            WHERE org_id = ${orgId}::uuid AND external_ref = ${SAAS_PROJECTS_TASK_REF} LIMIT 1`,
        ),
      )[0]
      return row?.id ?? null
    })
  },
}
