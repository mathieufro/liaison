// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The projects factory: project boards with their tasks, subtasks and
// dependencies, through `createProject` / `createTask` / `addDependency`, the
// projects app's own services, on an RLS transaction as the project's owner.
// A project's `key` is UNIQUE per org and a task's `externalRef` is too, which
// is what makes a re-run adopt instead of duplicate.
//
// No privileged write. Task STATUS is not an enum: a project owns its status
// rows and "done" means `terminal`; the default ladder is used throughout so a
// board reads the way a new project's would.
import { sql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import { addDependency, createTask } from "~/apps/projects/service/tasks"
import { writeTaskPlan } from "~/apps/projects/service/time-plan"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { seedClock } from "~/seed/clock"
import type { SeedContext } from "~/seed/context"
import { asUser, rowsOf } from "~/seed/factories/people/actors"

export interface TaskSpec {
  key: string
  title: string
  description?: string
  status: "backlog" | "todo" | "in_progress" | "done" | "cancelled"
  /** Person key. */
  assignee?: string
  priority?: "low" | "normal" | "high" | "urgent"
  /** Days from the base time. Negative is overdue. */
  dueInDays?: number
  /** Task key of the parent, for a subtask. */
  parent?: string
  /** Task keys this one is blocked by. */
  dependsOn?: string[]
  /** Days from the base time to the task's start date. */
  startInDays?: number
  /** When a done task was closed; the product's own close time otherwise. */
  completedAt?: Date
  /** The task's own timebox, in minutes. */
  timeboxMinutes?: number
  /** A milestone: usually the parent of work tasks, its timebox counting for theirs. */
  isMilestone?: boolean
  /**
   * The task's number on its board (`KEY-12`). Set on every task of a spec or on none: tasks
   * are then created in number order, and the project skips the numbers the board leaves out.
   */
  number?: number
}

export interface ProjectSpec {
  key: string
  name: string
  description: string
  icon: string
  /** Person key: the project's owner, who creates it and its tasks. */
  owner: string
  tasks: TaskSpec[]
}

type ExecTx = { execute: (q: unknown) => Promise<unknown> }

/** Whether a task counts as overdue: due before the base time and still open. */
export function isOverdue(task: TaskSpec): boolean {
  return (
    task.dueInDays !== undefined &&
    task.dueInDays < 0 &&
    task.status !== "done" &&
    task.status !== "cancelled"
  )
}

/**
 * Seed one project as `owner`, in one RLS transaction: the project, its tasks
 * (parents before subtasks, so a `parentTaskId` always resolves) and then the
 * dependencies, once every task id is known.
 */
export async function seedProject(
  ctx: SeedContext,
  owner: UserContext,
  input: {
    people: Record<string, { userId: string } | undefined>
    spec: ProjectSpec
    /** A task's idempotency key (UNIQUE per org), from its spec key. */
    externalRefOf: (taskKey: string) => string
  },
): Promise<{ projectId: string; taskIds: string[] }> {
  const { orgId } = ctx
  const { people, spec } = input
  const clock = seedClock(ctx.now)
  const taskIds: string[] = []
  let projectId = ""
  await asUser(owner, async (tx) => {
    const found = rowsOf<{ id: string }>(
      await (tx as ExecTx).execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("app_projects"))}.projects
            WHERE org_id = ${orgId} AND key = ${spec.key} LIMIT 1`,
      ),
    )
    if (found[0]) {
      projectId = found[0].id
    } else {
      const created = await createProject({
        tx: tx as never,
        orgId,
        actor: owner,
        input: { name: spec.name, description: spec.description, icon: spec.icon, key: spec.key },
      })
      projectId = created.id
    }

    const taskIdByKey: Record<string, string> = {}
    const numbered = spec.tasks.some((t) => t.number !== undefined)
    if (numbered && !spec.tasks.every((t) => t.number !== undefined)) {
      throw new Error(`seed: project ${spec.key} numbers some tasks and not others`)
    }
    const ordered = numbered
      ? [...spec.tasks].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
      : [...spec.tasks].sort((a, b) => (a.parent ? 1 : 0) - (b.parent ? 1 : 0))
    // The tasks a previous run wrote, in one read: a re-run adopts them.
    const refs = ordered.map((t) => input.externalRefOf(t.key))
    const adopted = new Map(
      rowsOf<{ id: string; external_ref: string }>(
        await (tx as ExecTx).execute(
          sql`SELECT id, external_ref FROM ${sql.raw(schemaRef("app_projects"))}.tasks
              WHERE org_id = ${orgId}
                AND external_ref IN (SELECT jsonb_array_elements_text(${JSON.stringify(refs)}::jsonb))`,
        ),
      ).map((r) => [r.external_ref, r.id]),
    )
    // The number the project hands out next, once read; moved only across a gap.
    let nextNumber: number | null = null
    for (const task of ordered) {
      const externalRef = input.externalRefOf(task.key)
      const existing = adopted.get(externalRef)
      if (existing) {
        taskIdByKey[task.key] = existing
        taskIds.push(existing)
        continue
      }
      if (task.parent && !taskIdByKey[task.parent]) {
        throw new Error(`seed: task ${task.key} comes before its parent ${task.parent}`)
      }
      if (task.number !== undefined) {
        if (nextNumber === null) {
          nextNumber = Number(
            rowsOf<{ n: number }>(
              await (tx as ExecTx).execute(
                sql`SELECT next_task_number AS n FROM ${sql.raw(schemaRef("app_projects"))}.projects
                     WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid`,
              ),
            )[0]?.n ?? 1,
          )
        }
        if (task.number > nextNumber) {
          // The board's own number: the project's counter moves past the numbers it leaves
          // out, as when those tasks moved to another project, so the product hands this one out.
          await (tx as ExecTx).execute(
            sql`UPDATE ${sql.raw(schemaRef("app_projects"))}.projects
                   SET next_task_number = ${task.number}
                 WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid`,
          )
        }
        nextNumber = Math.max(nextNumber, task.number) + 1
      }
      const dueDate = task.dueInDays === undefined ? undefined : clock.daysAfter(task.dueInDays)
      const startDate =
        task.startInDays === undefined ? undefined : clock.daysAfter(task.startInDays)
      const created = await createTask({
        tx: tx as never,
        orgId,
        actor: owner,
        input: {
          projectId,
          title: task.title,
          ...(task.description ? { description: task.description } : {}),
          statusLabel: task.status,
          ...(task.assignee ? { assigneeId: people[task.assignee]?.userId } : {}),
          priority: task.priority ?? "normal",
          ...(dueDate ? { dueDate: dueDate.toISOString() } : {}),
          ...(startDate ? { startDate: startDate.toISOString().slice(0, 10) } : {}),
          ...(task.completedAt ? { completedAt: task.completedAt.toISOString() } : {}),
          ...(task.parent && taskIdByKey[task.parent]
            ? { parentTaskId: taskIdByKey[task.parent] }
            : {}),
          externalRef,
        } as never,
      })
      taskIdByKey[task.key] = created.id
      taskIds.push(created.id)
      if (task.timeboxMinutes !== undefined || task.isMilestone) {
        // The task's timebox and milestone flag through the product's own writer, in the
        // owner's transaction: a timebox needs the project to use time and budgets.
        await writeTaskPlan({
          tx: tx as never,
          orgId,
          taskId: created.id,
          scopes: owner.scopes,
          patch: {
            ...(task.timeboxMinutes !== undefined ? { timebox: `${task.timeboxMinutes}m` } : {}),
            ...(task.isMilestone ? { isMilestone: true } : {}),
          },
        })
      }
    }

    for (const task of spec.tasks) {
      const taskId = taskIdByKey[task.key]
      if (!taskId) continue
      for (const blockerKey of task.dependsOn ?? []) {
        const blockerId = taskIdByKey[blockerKey]
        if (!blockerId) continue
        const already = rowsOf<{ task_id: string }>(
          await (tx as ExecTx).execute(
            sql`SELECT task_id FROM ${sql.raw(schemaRef("app_projects"))}.task_dependencies
                WHERE task_id = ${taskId}::uuid AND depends_on_task_id = ${blockerId}::uuid`,
          ),
        )
        if (already.length > 0) continue
        await addDependency({
          tx: tx as never,
          orgId,
          actor: owner,
          taskId,
          dependsOnTaskId: blockerId,
          type: "blocks",
        } as never)
      }
    }
  })
  return { projectId, taskIds }
}

/**
 * One task in the project keyed `projectKey`, created by `creator` (found by
 * its external reference on a re-run). Null when the project is not there.
 */
export async function seedProjectTask(
  ctx: SeedContext,
  creator: UserContext,
  task: {
    projectKey: string
    externalRef: string
    title: string
    description: string
    statusLabel: TaskSpec["status"]
    assigneeId: string
    priority: NonNullable<TaskSpec["priority"]>
    dueInDays: number
  },
): Promise<string | null> {
  const { orgId } = ctx
  const clock = seedClock(ctx.now)
  return asUser(creator, async (tx) => {
    const existing = rowsOf<{ id: string }>(
      await tx.execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("app_projects"))}.tasks
            WHERE org_id = ${orgId} AND external_ref = ${task.externalRef} LIMIT 1`,
      ),
    )
    if (existing[0]) return existing[0].id
    const project = rowsOf<{ id: string }>(
      await tx.execute(
        sql`SELECT id FROM ${sql.raw(schemaRef("app_projects"))}.projects
            WHERE org_id = ${orgId} AND key = ${task.projectKey} LIMIT 1`,
      ),
    )[0]
    if (!project) return null
    const created = await createTask({
      tx: tx as never,
      orgId,
      actor: creator,
      input: {
        projectId: project.id,
        title: task.title,
        description: task.description,
        statusLabel: task.statusLabel,
        assigneeId: task.assigneeId,
        priority: task.priority,
        dueDate: clock.daysAfter(task.dueInDays).toISOString(),
        externalRef: task.externalRef,
      } as never,
    })
    return created.id
  })
}
