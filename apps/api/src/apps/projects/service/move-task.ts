// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient, type RlsTx } from "~/db"
import type { UserContext } from "~/db/rls"
import { readProjectLevels, remapChecklistValidations } from "./checklist"
import { dealTargetStatusForMove, refuseDealAsSubtask, syncDealOutcome } from "./deals"
import { fieldsForProject, lockProjectFields, readProjectFields, sameFields } from "./fields"
import { resolveStatusRef } from "./resolve"
import { ProjectsServiceError } from "./statuses"
import { MAX_TASK_DEPTH } from "./task-depth"
import { loadTaskDetails } from "./task-detail"
import {
  recordTransitions,
  type TransitionActor,
  type TransitionInput,
  transitionActorFor,
} from "./transitions"

export { MAX_TASK_DEPTH } from "./task-depth"

interface TaskRow {
  id: string
  org_id: string
  project_id: string
  parent_task_id: string | null
  status_id: string
  number: number
  position: number
  completed_at: Date | string | null
}

async function fetchTask(
  tx: RlsTx | RlsClient,
  orgId: string,
  taskId: string,
): Promise<TaskRow | null> {
  const rows = extractRows<TaskRow>(
    await tx.execute(drizzleSql`
      SELECT id, org_id, project_id, parent_task_id, status_id, number, position, completed_at
      FROM ${projectsRel("tasks")}
      WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  return rows[0] ?? null
}

export async function ensureProjectMutableForTasks(
  tx: RlsTx | RlsClient,
  orgId: string,
  projectId: string,
): Promise<void> {
  const rows = extractRows<{ id: string; archived_at: Date | string | null }>(
    await tx.execute(drizzleSql`
      SELECT id, archived_at FROM ${projectsRel("projects")}
      WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  if (rows.length === 0) {
    throw new ProjectsServiceError(404, "not_found", "project not found")
  }
  if (rows[0]?.archived_at) {
    throw new ProjectsServiceError(409, "project_archived", "project is archived")
  }
}

export async function statusIsTerminal(
  tx: RlsTx | RlsClient,
  orgId: string,
  statusId: string,
): Promise<boolean> {
  const rows = extractRows<{ terminal: boolean }>(
    await tx.execute(drizzleSql`
      SELECT terminal FROM ${projectsRel("project_statuses")}
      WHERE id = ${statusId}::uuid AND org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  return rows[0]?.terminal ?? false
}

export async function computeNextCompletedAt(
  tx: RlsTx | RlsClient,
  orgId: string,
  options: {
    previousStatusId: string
    nextStatusId: string
    previousCompletedAt: Date | string | null
  },
): Promise<Date | string | null | undefined> {
  if (options.nextStatusId === options.previousStatusId) return undefined
  const wasTerminal = await statusIsTerminal(tx, orgId, options.previousStatusId)
  const willTerminal = await statusIsTerminal(tx, orgId, options.nextStatusId)
  if (!wasTerminal && willTerminal) {
    return options.previousCompletedAt ?? new Date()
  }
  if (wasTerminal && !willTerminal) {
    return null
  }
  return undefined
}

export interface PositionRequest {
  projectId: string
  statusId: string
  parentTaskId: string | null
  beforeTaskId?: string | null
  afterTaskId?: string | null
}

export async function computePosition(
  tx: RlsTx | RlsClient,
  orgId: string,
  req: PositionRequest,
  excludeTaskId?: string,
): Promise<number> {
  const positionOf = async (id: string): Promise<number | null> => {
    const rows = extractRows<{ position: number }>(
      await tx.execute(drizzleSql`
        SELECT position FROM ${projectsRel("tasks")}
        WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid LIMIT 1
      `),
    )
    return rows[0]?.position ?? null
  }

  let candidate: number | null = null

  if (req.beforeTaskId && req.afterTaskId) {
    const a = await positionOf(req.afterTaskId)
    const b = await positionOf(req.beforeTaskId)
    if (a !== null && b !== null) candidate = (a + b) / 2
  }
  if (candidate === null && req.afterTaskId) {
    const a = await positionOf(req.afterTaskId)
    if (a !== null) candidate = a + 1
  }
  if (candidate === null && req.beforeTaskId) {
    const b = await positionOf(req.beforeTaskId)
    if (b !== null) candidate = b - 1
  }

  if (candidate === null) {
    // Default: append (max+1) within scope
    const exclude = excludeTaskId ? drizzleSql`AND id <> ${excludeTaskId}::uuid` : drizzleSql``
    const parentClause = req.parentTaskId
      ? drizzleSql`AND parent_task_id = ${req.parentTaskId}::uuid`
      : drizzleSql`AND parent_task_id IS NULL`
    const rows = extractRows<{ max_pos: number | null }>(
      await tx.execute(drizzleSql`
        SELECT MAX(position) AS max_pos
        FROM ${projectsRel("tasks")}
        WHERE org_id = ${orgId}::uuid
          AND project_id = ${req.projectId}::uuid
          AND status_id = ${req.statusId}::uuid
          ${parentClause}
          ${exclude}
      `),
    )
    const maxPos = rows[0]?.max_pos
    return (maxPos ?? 1000) + 1
  }

  // Collision guard: if the candidate position already exists in the target
  // scope (can happen when midpoints converge to the same float), re-balance
  // the entire sibling list with integer gaps and pick the correct slot.
  const exclude = excludeTaskId ? drizzleSql`AND id <> ${excludeTaskId}::uuid` : drizzleSql``
  const parentClause = req.parentTaskId
    ? drizzleSql`AND parent_task_id = ${req.parentTaskId}::uuid`
    : drizzleSql`AND parent_task_id IS NULL`
  const collision = extractRows<{ cnt: number }>(
    await tx.execute(drizzleSql`
      SELECT COUNT(*)::int AS cnt FROM ${projectsRel("tasks")}
      WHERE org_id = ${orgId}::uuid
        AND project_id = ${req.projectId}::uuid
        AND status_id = ${req.statusId}::uuid
        AND position = ${candidate}
        ${parentClause}
        ${exclude}
    `),
  )
  if ((collision[0]?.cnt ?? 0) === 0) return candidate

  // Re-balance: assign dense integer positions (1, 2, 3, …) to existing
  // siblings ordered by their current position, then re-derive the candidate
  // index so inserts land at the right slot without fractional arithmetic.
  await tx.execute(drizzleSql`
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (ORDER BY position ASC, id ASC) * 1000 AS new_pos
      FROM ${projectsRel("tasks")}
      WHERE org_id = ${orgId}::uuid
        AND project_id = ${req.projectId}::uuid
        AND status_id = ${req.statusId}::uuid
        ${parentClause}
        ${exclude}
    )
    UPDATE ${projectsRel("tasks")} t
    SET position = ranked.new_pos
    FROM ranked
    WHERE t.id = ranked.id
  `)

  // After re-balancing, re-derive the candidate from the updated positions.
  return computePosition(tx, orgId, req, excludeTaskId)
}

export interface MoveTaskArgs {
  tx: RlsClient
  orgId: string
  actor: UserContext
  /** BOUNDARY assertion (NOT a destination): when set, the task MUST already belong
   *  to this project or the move 404s. The REST route passes the URL's `:projectId`
   *  here so a task can only be moved through its own project's path. To RELOCATE a
   *  task to a different project, use `targetProjectId`. */
  projectId?: string
  /** DESTINATION for a cross-project relocation: when set and different from the
   *  task's current project, the task (and its whole subtree) is moved into this
   *  project and each moved task's status is remapped to one in the destination. */
  targetProjectId?: string
  taskId: string
  parentTaskId?: string | null
  statusId?: string
  beforeTaskId?: string | null
  afterTaskId?: string | null
  /** Stored as the deal's lost reason when this move closes a deal as lost. */
  lostReason?: string | null
  /** Who made the change, for the transitions (default: from the run, else the person). */
  via?: TransitionActor
}

export interface MoveTaskResult {
  id: string
  /** Per-project task number; a cross-project move allocates a new one, so the
   *  display key changes. */
  number: number
  parentTaskId: string | null
  statusId: string
  position: number
  completedAt: string | null
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null
  if (value instanceof Date) return value.toISOString()
  return value
}

/**
 * Pick a status in the TARGET project to host a task being moved across projects.
 * A task's `status_id` belongs to its CURRENT project, so a cross-project move must
 * remap it. Preserve intent: a terminal (done/cancelled) task lands on the target's
 * first terminal status; a non-terminal task lands on the target's first
 * non-terminal status; fall back to the target's first status if it lacks the
 * matching kind. An explicit `targetStatusId` (validated to belong to the target)
 * overrides this. Throws `no_statuses` if the target has none.
 */
async function pickTargetStatusId(
  tx: RlsTx | RlsClient,
  orgId: string,
  targetProjectId: string,
  sourceTerminal: boolean,
  explicitStatusId?: string,
): Promise<string> {
  if (explicitStatusId) {
    // Tolerates a label in the id slot and misses list the project's real
    // columns — same agent-facing contract as create/update (see resolve.ts).
    return resolveStatusRef(tx, orgId, targetProjectId, { statusId: explicitStatusId })
  }
  const rows = extractRows<{ id: string; terminal: boolean }>(
    await tx.execute(drizzleSql`
      SELECT id, terminal FROM ${projectsRel("project_statuses")}
      WHERE project_id = ${targetProjectId}::uuid AND org_id = ${orgId}::uuid
      ORDER BY "order" ASC
    `),
  )
  if (rows.length === 0)
    throw new ProjectsServiceError(409, "no_statuses", "target project has no statuses")
  const match = rows.find((r) => r.terminal === sourceTerminal)
  return (match ?? rows[0]!).id
}

export async function moveTask(args: MoveTaskArgs): Promise<MoveTaskResult> {
  const { tx, orgId, actor, projectId, targetProjectId, taskId } = args
  return tx.transaction(async (innerTx) => {
    const task = await fetchTask(innerTx, orgId, taskId)
    if (!task) throw new ProjectsServiceError(404, "not_found", "task not found")
    // BOUNDARY assertion: `projectId` (the REST path scope) means "the task must be
    // in this project" — a mismatch is a 404, NEVER an implicit relocation.
    if (projectId && task.project_id !== projectId) {
      throw new ProjectsServiceError(404, "not_found", "task not found")
    }

    // CROSS-PROJECT MOVE (BL-213): `targetProjectId` relocates the task — and its
    // whole subtree — into a DIFFERENT project instead of recreating + deleting
    // (which strands duplicate tasks). A real general projects operation ("move this
    // task to project X") that was previously impossible: the tool only
    // repositioned/re-parented within a project.
    if (targetProjectId && task.project_id !== targetProjectId) {
      await ensureProjectMutableForTasks(innerTx, orgId, task.project_id)
      await ensureProjectMutableForTasks(innerTx, orgId, targetProjectId)
      // The values move with the tasks: hold off a definition change on either side (in a fixed
      // order) until they have.
      for (const id of [task.project_id, targetProjectId].sort()) {
        await lockProjectFields(innerTx, id, "write-values")
      }
      // Only a ROOT task may cross projects — moving a child alone would split its
      // tree across projects. Move the whole subtree by re-rooting the task.
      if (task.parent_task_id !== null) {
        throw new ProjectsServiceError(
          400,
          "cross_project_child_move",
          "only a top-level task can be moved to another project; move its parent (the whole subtree moves with it)",
        )
      }
      // Collect the moving subtree (the task + all descendants) with each one's terminal-ness.
      const subtree = extractRows<{
        id: string
        status_id: string
        status_terminal: boolean
        fields: Record<string, unknown> | null
      }>(
        await innerTx.execute(drizzleSql`
          WITH RECURSIVE moving AS (
            SELECT id, status_id FROM ${projectsRel("tasks")}
            WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid
            UNION ALL
            SELECT t.id, t.status_id FROM ${projectsRel("tasks")} t
            JOIN moving m ON t.parent_task_id = m.id
            WHERE t.org_id = ${orgId}::uuid
          )
          SELECT m.id, m.status_id, COALESCE(s.terminal, false) AS status_terminal, t.fields
          FROM moving m
          JOIN ${projectsRel("tasks")} t ON t.id = m.id
          LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = m.status_id
        `),
      )
      // A deal only moves to another pipeline, and lands on the stage that
      // matches its outcome (refused into a work project, nothing written).
      const dealStatusId = await dealTargetStatusForMove(innerTx, orgId, taskId, targetProjectId)
      // Re-key the moved items' validations to the target project's levels by name.
      await remapChecklistValidations(
        innerTx,
        orgId,
        subtree.map((n) => n.id),
        await readProjectLevels(innerTx, orgId, task.project_id),
        await readProjectLevels(innerTx, orgId, targetProjectId),
      )
      // Remap each moved task's status into the target project, then move the row.
      // Task numbers are unique per project, so every moved task (subtree included)
      // takes a FRESH number from the destination's counter: keeping the source
      // number collides with a destination task holding it, and leaves the
      // destination counter handing out numbers moved tasks already hold. The
      // display key therefore changes on a cross-project move (ERB-35 -> BUG-n).
      // Field values: a value the destination declares a field it does not fit (another type,
      // other choices) is put aside under HIDDEN_FIELDS_KEY, so it is never read as the
      // destination's field; values of keys the destination does not declare stay (reads skip
      // them). The destination's required fields are not enforced on a move.
      // Tombstones included: a value a removed field would not fit is put aside too.
      const targetFields = await readProjectFields(innerTx, orgId, targetProjectId)
      const hiddenByTask = new Map<string, string[]>()
      const transitions: TransitionInput[] = []
      for (const node of subtree) {
        const { fields: nextFields, hidden } = fieldsForProject(node.fields ?? {}, targetFields)
        hiddenByTask.set(node.id, hidden)
        if (!sameFields(nextFields, node.fields ?? {})) {
          await innerTx.execute(drizzleSql`
            UPDATE ${projectsRel("tasks")} SET fields = ${JSON.stringify(nextFields)}::jsonb
            WHERE id = ${node.id}::uuid AND org_id = ${orgId}::uuid
          `)
        }
      }
      for (const node of subtree) {
        const newStatusId = await pickTargetStatusId(
          innerTx,
          orgId,
          targetProjectId,
          node.status_terminal,
          node.id === taskId ? (args.statusId ?? dealStatusId) : undefined,
        )
        const newPosition = await computePosition(
          innerTx,
          orgId,
          { projectId: targetProjectId, statusId: newStatusId, parentTaskId: null },
          node.id,
        )
        await innerTx.execute(drizzleSql`
          UPDATE ${projectsRel("tasks")}
          SET project_id = ${targetProjectId}::uuid,
              status_id = ${newStatusId}::uuid,
              number = ${projectsRel("allocate_task_number")}(${targetProjectId}::uuid),
              position = ${node.id === taskId ? newPosition : 0},
              updated_at = now()
          WHERE id = ${node.id}::uuid AND org_id = ${orgId}::uuid
        `)
        transitions.push({
          taskId: node.id,
          projectId: targetProjectId,
          fromStatusId: node.status_id,
          toStatusId: newStatusId,
        })
      }
      // A deal moved between pipelines keeps its rows; a task moved into a
      // pipeline becomes a deal. Its outcome follows the stage it landed on.
      await syncDealOutcome(
        innerTx,
        orgId,
        actor,
        subtree.map((n) => n.id),
        { lostReason: args.lostReason },
      )
      const movedRow = (await fetchTask(innerTx, orgId, taskId))!
      // One event for the moved root, carrying its full row in the target
      // project plus where it came from (a client showing the source removes it).
      const [movedDetail] = await loadTaskDetails(innerTx, orgId, [taskId])
      await innerTx.queueEvent({
        app: "projects",
        entity: "task",
        action: "moved",
        entityId: taskId,
        data: {
          fromStatusId: task.status_id,
          toStatusId: movedRow.status_id,
          hiddenFields: hiddenByTask.get(taskId) ?? [],
          ...movedDetail,
          id: taskId,
          projectId: targetProjectId,
          fromProjectId: task.project_id,
          number: movedRow.number,
          fromNumber: task.number,
          parentTaskId: movedRow.parent_task_id,
          statusId: movedRow.status_id,
          position: movedRow.position,
        },
        actorId: actor.userId,
        actorType: "user",
        orgId,
      })
      // Every moved task's status was remapped into the destination: one transition each
      // (the subtree's included), the destination's project id on them.
      await recordTransitions(innerTx, orgId, transitions, args.via ?? transitionActorFor(actor))
      return {
        id: movedRow.id,
        number: movedRow.number,
        parentTaskId: movedRow.parent_task_id,
        statusId: movedRow.status_id,
        position: movedRow.position,
        completedAt: toIso(movedRow.completed_at),
      }
    }
    await ensureProjectMutableForTasks(innerTx, orgId, task.project_id)
    const nextStatusId = args.statusId ?? task.status_id
    const nextParentId = args.parentTaskId === undefined ? task.parent_task_id : args.parentTaskId

    if (args.statusId !== undefined && args.statusId !== task.status_id) {
      const statusRows = extractRows<{ id: string }>(
        await innerTx.execute(drizzleSql`
          SELECT id FROM ${projectsRel("project_statuses")}
          WHERE id = ${nextStatusId}::uuid
            AND project_id = ${task.project_id}::uuid
            AND org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )
      if (statusRows.length === 0) {
        throw new ProjectsServiceError(404, "status_not_found", "status not in project")
      }
    }

    if (nextParentId !== null) {
      if (task.parent_task_id === null) await refuseDealAsSubtask(innerTx, orgId, taskId)
      const parent = await fetchTask(innerTx, orgId, nextParentId)
      if (!parent) {
        throw new ProjectsServiceError(404, "parent_not_found", "parent task not found")
      }
      if (parent.project_id !== task.project_id) {
        throw new ProjectsServiceError(
          400,
          "cross_project_move",
          "parent task is in a different project",
        )
      }

      const cycleRows = extractRows<{
        cycle: boolean
        proposed_parent_depth: number | null
        subtree_height: number | null
      }>(
        await innerTx.execute(drizzleSql`
          WITH RECURSIVE ancestors AS (
            SELECT id, parent_task_id, 1 AS depth
            FROM ${projectsRel("tasks")}
            WHERE id = ${nextParentId}::uuid AND org_id = ${orgId}::uuid
            UNION ALL
            SELECT t.id, t.parent_task_id, a.depth + 1
            FROM ${projectsRel("tasks")} t
            JOIN ancestors a ON t.id = a.parent_task_id
            WHERE t.org_id = ${orgId}::uuid
          ), moving_subtree AS (
            SELECT id, 1 AS h
            FROM ${projectsRel("tasks")}
            WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid
            UNION ALL
            SELECT t.id, ms.h + 1
            FROM ${projectsRel("tasks")} t
            JOIN moving_subtree ms ON t.parent_task_id = ms.id
            WHERE t.org_id = ${orgId}::uuid
          )
          SELECT
            EXISTS (SELECT 1 FROM ancestors WHERE id = ${taskId}::uuid) AS cycle,
            (SELECT MAX(depth) FROM ancestors) AS proposed_parent_depth,
            (SELECT MAX(h) FROM moving_subtree) AS subtree_height
        `),
      )
      const row = cycleRows[0]
      if (row?.cycle) {
        throw new ProjectsServiceError(400, "task_cycle_detected", "move would create a cycle")
      }
      const proposedDepth = row?.proposed_parent_depth ?? 0
      const subtreeHeight = row?.subtree_height ?? 1
      if (proposedDepth + subtreeHeight > MAX_TASK_DEPTH) {
        throw new ProjectsServiceError(
          400,
          "task_depth_exceeded",
          `depth budget exceeded (max ${MAX_TASK_DEPTH})`,
        )
      }
    } else {
      // Moving to root: validate subtree height alone <= MAX_TASK_DEPTH
      const heightRows = extractRows<{ subtree_height: number | null }>(
        await innerTx.execute(drizzleSql`
          WITH RECURSIVE moving_subtree AS (
            SELECT id, 1 AS h FROM ${projectsRel("tasks")}
            WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid
            UNION ALL
            SELECT t.id, ms.h + 1 FROM ${projectsRel("tasks")} t
            JOIN moving_subtree ms ON t.parent_task_id = ms.id
            WHERE t.org_id = ${orgId}::uuid
          )
          SELECT MAX(h) AS subtree_height FROM moving_subtree
        `),
      )
      const subtreeHeight = heightRows[0]?.subtree_height ?? 1
      if (subtreeHeight > MAX_TASK_DEPTH) {
        throw new ProjectsServiceError(
          400,
          "task_depth_exceeded",
          `depth budget exceeded (max ${MAX_TASK_DEPTH})`,
        )
      }
    }

    const position = await computePosition(
      innerTx,
      orgId,
      {
        projectId: task.project_id,
        statusId: nextStatusId,
        parentTaskId: nextParentId,
        beforeTaskId: args.beforeTaskId,
        afterTaskId: args.afterTaskId,
      },
      taskId,
    )

    const completedAt = await computeNextCompletedAt(innerTx, orgId, {
      previousStatusId: task.status_id,
      nextStatusId,
      previousCompletedAt: task.completed_at,
    })
    const completedFrag =
      completedAt === undefined
        ? drizzleSql``
        : completedAt === null
          ? drizzleSql`, completed_at = NULL`
          : drizzleSql`, completed_at = ${completedAt instanceof Date ? completedAt.toISOString() : completedAt}::timestamptz`

    const parentSet = nextParentId === null ? drizzleSql`NULL` : drizzleSql`${nextParentId}::uuid`

    const updated = extractRows<TaskRow>(
      await innerTx.execute(drizzleSql`
        UPDATE ${projectsRel("tasks")}
        SET parent_task_id = ${parentSet},
            status_id = ${nextStatusId}::uuid,
            position = ${position},
            updated_at = now()
            ${completedFrag}
        WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid
        RETURNING id, org_id, project_id, parent_task_id, status_id, number, position, completed_at
      `),
    )

    // The deal's outcome follows its new stage, in this transaction. A task
    // promoted to the root of a pipeline becomes a deal here.
    await syncDealOutcome(innerTx, orgId, actor, [taskId], {
      fromStatusIds: { [taskId]: task.status_id },
      lostReason: args.lostReason,
    })

    // J2: if this move (de)completed the task, recompute the stored `blocked`
    // flag on every task that depends on it. A dependent is blocked iff it has
    // an open ('blocks') dependency on a task that is not completed.
    if (completedAt !== undefined) {
      await innerTx.execute(drizzleSql`
        UPDATE ${projectsRel("tasks")} dep
        SET blocked = EXISTS (
          SELECT 1 FROM ${projectsRel("task_dependencies")} td
          JOIN ${projectsRel("tasks")} blk ON blk.id = td.depends_on_task_id
          WHERE td.task_id = dep.id AND td.type = 'blocks' AND blk.completed_at IS NULL
        ), updated_at = now()
        WHERE dep.org_id = ${orgId}::uuid
          AND dep.id IN (
            SELECT task_id FROM ${projectsRel("task_dependencies")}
            WHERE depends_on_task_id = ${taskId}::uuid
          )
      `)
    }

    // The event carries the full row after the write (key, completedAt,
    // priority...), not just the move coordinates.
    const [movedDetail] = await loadTaskDetails(innerTx, orgId, [taskId])
    await innerTx.queueEvent({
      app: "projects",
      entity: "task",
      action: "moved",
      entityId: taskId,
      data: {
        fromStatusId: task.status_id,
        toStatusId: nextStatusId,
        ...movedDetail,
        id: taskId,
        projectId: task.project_id,
        parentTaskId: nextParentId,
        statusId: nextStatusId,
        position,
      },
      actorId: actor.userId,
      actorType: "user",
      orgId,
    })

    await recordTransitions(
      innerTx,
      orgId,
      [
        {
          taskId,
          projectId: task.project_id,
          fromStatusId: task.status_id,
          toStatusId: nextStatusId,
        },
      ],
      args.via ?? transitionActorFor(actor),
    )

    const row = updated[0]!
    return {
      id: row.id,
      number: row.number,
      parentTaskId: row.parent_task_id,
      statusId: row.status_id,
      position: row.position,
      completedAt: toIso(row.completed_at),
    }
  })
}
