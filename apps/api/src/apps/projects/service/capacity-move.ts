// SPDX-License-Identifier: FSL-1.1-ALv2
// "Move to <person>" on the capacity board: one press gives a task to someone else, through the
// task update every other path uses (same row security, same assignee checks), and tells the
// person who had it and the person who has it now. It is the presser's own act, never an
// approval. It reads planned time only and moves nothing else: the timebox and the dates stay.
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { resolveTaskRef } from "./resolve"
import { ProjectsServiceError } from "./statuses"
import { updateTask } from "./tasks"

export interface CapacityMoveResult {
  moved: boolean
  task: { id: string; key: string | null; title: string }
  from: { userId: string; name: string } | null
  /** Null when the press left the task unassigned again (the undo of a move from unassigned). */
  to: { userId: string; name: string } | null
  /** The people who got a Home line about it (never the person who pressed). */
  told: string[]
  message: string
}

interface PersonRow {
  id: string
  name: string
  status: string
}

async function person(tx: RlsClient, orgId: string, id: string): Promise<PersonRow | null> {
  return (
    extractRows<PersonRow>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, name, status::text AS status FROM ${kernelRel("users")}
         WHERE org_id = ${orgId}::uuid AND id = ${id}::uuid LIMIT 1`),
    )[0] ?? null
  )
}

export async function moveCapacityTask(args: {
  tx: RlsClient
  orgId: string
  actor: UserContext
  /** `toUserId: null` leaves the task with nobody: how a move from unassigned is undone. */
  input: { taskId?: string; toUserId?: string | null }
}): Promise<CapacityMoveResult> {
  const { tx, orgId, actor } = args
  const ref = String(args.input.taskId ?? "").trim()
  const unassign = args.input.toUserId === null
  const toUserId = unassign ? "" : String(args.input.toUserId ?? "").trim()
  if (!ref || (!toUserId && !unassign)) {
    throw new ProjectsServiceError(
      400,
      "invalid_input",
      "Name the task (taskId) and the person to move it to (toUserId, or null to leave it unassigned). Nothing was moved.",
    )
  }
  const taskId = await resolveTaskRef(tx as never, orgId, ref)
  const row = extractRows<{
    id: string
    key: string | null
    title: string
    assignee_id: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT t.id::text AS id, t.title, t.assignee_id::text AS assignee_id,
             CASE WHEN p.key IS NOT NULL THEN p.key || '-' || t.number::text END AS key
        FROM ${projectsRel("tasks")} t
        JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
       WHERE t.org_id = ${orgId}::uuid AND t.id = ${taskId}::uuid AND t.archived_at IS NULL
       LIMIT 1`),
  )[0]
  if (!row) {
    throw new ProjectsServiceError(
      404,
      "not_found",
      `Task ${ref} was not found. Nothing was moved.`,
    )
  }
  const name = row.key ?? row.title
  const task = { id: row.id, key: row.key, title: row.title }
  const prev = row.assignee_id ? await person(tx, orgId, row.assignee_id) : null
  const from = prev ? { userId: prev.id, name: prev.name } : null
  if (unassign) return unassignTask({ tx, orgId, actor, taskId, name, task, from })
  const target = await person(tx, orgId, toUserId)
  if (target?.status !== "active") {
    throw new ProjectsServiceError(
      409,
      "person_unavailable",
      `${name} was not moved: that person is not an active member of this organization.`,
    )
  }
  const to = { userId: target.id, name: target.name }
  if (row.assignee_id === target.id) {
    return {
      moved: false,
      task,
      from,
      to,
      told: [],
      message: `${name} is already with ${target.name}. Nothing changed and nobody was told.`,
    }
  }

  await updateTask({ tx, orgId, actor, taskId, input: { assigneeId: target.id } })

  const by = await byName(tx, orgId, actor)
  const told: string[] = []
  const tell = (userId: string, summary: string) =>
    notify(tx, orgId, actor, taskId, userId, summary)
  await tell(target.id, `${by} moved ${name} to you`)
  if (target.id !== actor.userId) told.push(target.name)
  if (from) {
    await tell(from.userId, `${by} moved ${name} to ${target.name}`)
    if (from.userId !== actor.userId) told.push(from.name)
  }
  const toldLine =
    told.length === 0
      ? "Nobody else was told."
      : told.length === 1
        ? `${told[0]} was told.`
        : `${told[0]} and ${told[1]} were both told.`
  return {
    moved: true,
    task,
    from,
    to,
    told,
    message: `${name} is now with ${target.name}. ${toldLine} Its timebox and dates did not change. To undo, ${from ? `move it back to ${from.name}` : "leave it unassigned again (toUserId null)"}.`,
  }
}

async function byName(tx: RlsClient, orgId: string, actor: UserContext): Promise<string> {
  return (await person(tx, orgId, actor.userId))?.name?.trim() || "A colleague"
}

/** A Home line for one person about the task, never for the person who pressed. */
async function notify(
  tx: RlsClient,
  orgId: string,
  actor: UserContext,
  taskId: string,
  userId: string,
  summary: string,
): Promise<void> {
  if (userId === actor.userId) return
  await tx.queueEvent({
    app: "kernel",
    entity: "agent_notification",
    action: "create",
    entityId: taskId,
    data: {
      summary,
      urgency: 40,
      targetUserIds: [userId],
      link: { tabType: "projects:task", entityId: taskId },
    },
    actorId: actor.userId,
    actorType: "user",
    orgId,
    timestamp: new Date().toISOString(),
  })
}

/** Leave the task with nobody: the person who had it is told. */
async function unassignTask(args: {
  tx: RlsClient
  orgId: string
  actor: UserContext
  taskId: string
  name: string
  task: CapacityMoveResult["task"]
  from: CapacityMoveResult["from"]
}): Promise<CapacityMoveResult> {
  const { tx, orgId, actor, taskId, name, task, from } = args
  if (!from) {
    return {
      moved: false,
      task,
      from: null,
      to: null,
      told: [],
      message: `${name} is already unassigned. Nothing changed and nobody was told.`,
    }
  }
  await updateTask({ tx, orgId, actor, taskId, input: { assigneeId: null } })
  const by = await byName(tx, orgId, actor)
  await notify(tx, orgId, actor, taskId, from.userId, `${by} left ${name} unassigned`)
  const told = from.userId === actor.userId ? [] : [from.name]
  return {
    moved: true,
    task,
    from,
    to: null,
    told,
    message: `${name} is unassigned again. ${told.length === 1 ? `${told[0]} was told.` : "Nobody else was told."} Its timebox and dates did not change.`,
  }
}
