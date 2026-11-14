// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { assertKeepsClosingStages, syncDealOutcome } from "./deals"
import { loadTaskDetails } from "./task-detail"
import { recordTransitions, type TransitionActor, transitionActorFor } from "./transitions"

export class ProjectsServiceError extends Error {
  status: number
  code: string
  details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export interface ProjectStatus {
  id: string
  projectId: string
  label: string
  color: string | null
  order: number
  terminal: boolean
}

interface DbStatusRow {
  id: string
  project_id: string
  label: string
  color: string | null
  order: number
  terminal: boolean
}

function statusFromRow(r: DbStatusRow): ProjectStatus {
  return {
    id: r.id,
    projectId: r.project_id,
    label: r.label,
    color: r.color,
    order: r.order,
    terminal: r.terminal,
  }
}

async function ensureProjectMutable(
  tx: RlsClient,
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

export interface AddStatusArgs {
  tx: RlsClient
  orgId: string
  projectId: string
  actor: UserContext
  input: { label: string; color?: string | null; terminal?: boolean; afterStatusId?: string }
}

export async function addStatus(args: AddStatusArgs): Promise<ProjectStatus> {
  const { tx, orgId, projectId, actor, input } = args
  return tx.transaction(async (innerTx) => {
    await ensureProjectMutable(innerTx as RlsClient, orgId, projectId)
    let nextOrder: number
    if (input.afterStatusId) {
      const afterRows = extractRows<{ order: number }>(
        await innerTx.execute(drizzleSql`
          SELECT "order"
          FROM ${projectsRel("project_statuses")}
          WHERE id = ${input.afterStatusId}::uuid
            AND project_id = ${projectId}::uuid
            AND org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )
      const after = afterRows[0]
      if (!after) {
        throw new ProjectsServiceError(404, "not_found", "after status not found")
      }
      nextOrder = after.order + 1
      await innerTx.execute(drizzleSql`
        UPDATE ${projectsRel("project_statuses")}
        SET "order" = "order" + 1, updated_at = now()
        WHERE project_id = ${projectId}::uuid
          AND org_id = ${orgId}::uuid
          AND "order" >= ${nextOrder}
      `)
    } else {
      const orderRows = extractRows<{ next_order: number | null }>(
        await innerTx.execute(drizzleSql`
          SELECT COALESCE(MAX("order"), -1) + 1 AS next_order
          FROM ${projectsRel("project_statuses")}
          WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
        `),
      )
      nextOrder = orderRows[0]?.next_order ?? 0
    }
    const id = randomUUID()
    await innerTx.execute(drizzleSql`
      INSERT INTO ${projectsRel("project_statuses")}
        (id, org_id, project_id, label, color, "order", terminal)
      VALUES (
        ${id}::uuid,
        ${orgId}::uuid,
        ${projectId}::uuid,
        ${input.label},
        ${input.color ?? null},
        ${nextOrder},
        ${input.terminal ?? false}
      )
    `)
    await innerTx.queueEvent({
      app: "projects",
      entity: "project_status",
      action: "created",
      entityId: id,
      data: { id, projectId, label: input.label, afterStatusId: input.afterStatusId },
      actorId: actor.userId,
      actorType: "user",
      orgId,
    })
    const rows = extractRows<DbStatusRow>(
      await innerTx.execute(drizzleSql`
        SELECT id, project_id, label, color, "order", terminal
        FROM ${projectsRel("project_statuses")}
        WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid
      `),
    )
    return statusFromRow(rows[0]!)
  })
}

export interface UpdateStatusArgs {
  tx: RlsClient
  orgId: string
  projectId: string
  statusId: string
  actor: UserContext
  patch: { label?: string; color?: string | null; terminal?: boolean }
}

export async function updateStatus(args: UpdateStatusArgs): Promise<ProjectStatus> {
  const { tx, orgId, projectId, statusId, actor, patch } = args
  return tx.transaction(async (innerTx) => {
    await ensureProjectMutable(innerTx as RlsClient, orgId, projectId)
    // The terminal flag before the patch, read under a row lock, so a flip can
    // restamp the tasks already sitting in the column.
    const before =
      patch.terminal === undefined
        ? undefined
        : extractRows<{ terminal: boolean }>(
            await innerTx.execute(drizzleSql`
              SELECT terminal FROM ${projectsRel("project_statuses")}
              WHERE id = ${statusId}::uuid
                AND project_id = ${projectId}::uuid
                AND org_id = ${orgId}::uuid
              FOR UPDATE
            `),
          )[0]?.terminal
    // A stage that stops being terminal stops closing deals (a deal outcome
    // lives only on a terminal stage), unless it is the pipeline's last won or
    // lost stage, which is refused.
    const stopsClosing = patch.terminal === false && before === true
    if (stopsClosing) await assertKeepsClosingStages(innerTx, orgId, projectId, statusId)
    const sets: ReturnType<typeof drizzleSql>[] = []
    if (patch.label !== undefined) sets.push(drizzleSql`label = ${patch.label}`)
    if (patch.color !== undefined) sets.push(drizzleSql`color = ${patch.color}`)
    if (patch.terminal !== undefined) sets.push(drizzleSql`terminal = ${patch.terminal}`)
    if (stopsClosing) sets.push(drizzleSql`deal_outcome = NULL`)
    sets.push(drizzleSql`updated_at = now()`)
    const setSql = sets.reduce<ReturnType<typeof drizzleSql> | null>(
      (acc, frag) => (acc === null ? frag : drizzleSql`${acc}, ${frag}`),
      null,
    )
    if (setSql) {
      const result = await innerTx.execute(drizzleSql`
        UPDATE ${projectsRel("project_statuses")}
        SET ${setSql}
        WHERE id = ${statusId}::uuid
          AND project_id = ${projectId}::uuid
          AND org_id = ${orgId}::uuid
        RETURNING id, project_id, label, color, "order", terminal
      `)
      const rows = extractRows<DbStatusRow>(result)
      if (rows.length === 0) {
        throw new ProjectsServiceError(404, "not_found", "status not found")
      }
      // Same rule as a task moving between columns: entering terminal stamps
      // completed_at (keeping an existing stamp), leaving terminal clears it.
      if (patch.terminal !== undefined && before !== undefined && before !== patch.terminal) {
        const completedAtSql = patch.terminal
          ? drizzleSql`COALESCE(completed_at, now())`
          : drizzleSql`NULL`
        const inColumn = extractRows<{ id: string }>(
          await innerTx.execute(drizzleSql`
            UPDATE ${projectsRel("tasks")}
            SET completed_at = ${completedAtSql}, updated_at = now()
            WHERE status_id = ${statusId}::uuid
              AND project_id = ${projectId}::uuid
              AND org_id = ${orgId}::uuid
            RETURNING id
          `),
        )
        // Deals in a stage that stopped closing reopen.
        await syncDealOutcome(
          innerTx,
          orgId,
          actor,
          inColumn.map((r) => r.id),
        )
      }
      await innerTx.queueEvent({
        app: "projects",
        entity: "project_status",
        action: "updated",
        entityId: statusId,
        data: { id: statusId, projectId, ...patch },
        actorId: actor.userId,
        actorType: "user",
        orgId,
      })
      return statusFromRow(rows[0]!)
    }
    const rows = extractRows<DbStatusRow>(
      await innerTx.execute(drizzleSql`
        SELECT id, project_id, label, color, "order", terminal
        FROM ${projectsRel("project_statuses")}
        WHERE id = ${statusId}::uuid AND org_id = ${orgId}::uuid
      `),
    )
    if (rows.length === 0) {
      throw new ProjectsServiceError(404, "not_found", "status not found")
    }
    return statusFromRow(rows[0]!)
  })
}

export interface ReorderStatusesArgs {
  tx: RlsClient
  orgId: string
  projectId: string
  actor: UserContext
  orderedStatusIds: string[]
}

export async function reorderStatuses(args: ReorderStatusesArgs): Promise<ProjectStatus[]> {
  const { tx, orgId, projectId, actor, orderedStatusIds } = args
  return tx.transaction(async (innerTx) => {
    await ensureProjectMutable(innerTx as RlsClient, orgId, projectId)
    const existing = extractRows<{ id: string }>(
      await innerTx.execute(drizzleSql`
        SELECT id FROM ${projectsRel("project_statuses")}
        WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      `),
    )
    const existingIds = new Set(existing.map((r) => r.id))
    const inputSet = new Set(orderedStatusIds)
    if (
      orderedStatusIds.length !== existingIds.size ||
      inputSet.size !== orderedStatusIds.length ||
      ![...existingIds].every((id) => inputSet.has(id))
    ) {
      throw new ProjectsServiceError(
        400,
        "status_order_invalid",
        "ordered list must contain exactly the project's statuses",
      )
    }
    for (let i = 0; i < orderedStatusIds.length; i++) {
      const id = orderedStatusIds[i]!
      await innerTx.execute(drizzleSql`
        UPDATE ${projectsRel("project_statuses")}
        SET "order" = ${i}, updated_at = now()
        WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid AND project_id = ${projectId}::uuid
      `)
    }
    await innerTx.queueEvent({
      app: "projects",
      entity: "project_status",
      action: "reordered",
      entityId: projectId,
      data: { projectId, orderedStatusIds },
      actorId: actor.userId,
      actorType: "user",
      orgId,
    })
    const rows = extractRows<DbStatusRow>(
      await innerTx.execute(drizzleSql`
        SELECT id, project_id, label, color, "order", terminal
        FROM ${projectsRel("project_statuses")}
        WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
        ORDER BY "order" ASC
      `),
    )
    return rows.map(statusFromRow)
  })
}

export interface MigrateStatusArgs {
  tx: RlsClient
  orgId: string
  projectId: string
  sourceStatusId: string
  targetStatusId: string
  actor: UserContext
  /** Who made the change, for the transitions (default: from the run, else the person). */
  via?: TransitionActor
}

export async function migrateStatusTasks(
  args: MigrateStatusArgs,
): Promise<{ movedCount: number; movedTaskIds: string[] }> {
  const { tx, orgId, projectId, sourceStatusId, targetStatusId, actor } = args
  if (sourceStatusId === targetStatusId) {
    throw new ProjectsServiceError(400, "same_status", "source and target must differ")
  }
  return tx.transaction(async (innerTx) => {
    await ensureProjectMutable(innerTx as RlsClient, orgId, projectId)
    const presence = extractRows<{ id: string; terminal: boolean }>(
      await innerTx.execute(drizzleSql`
        SELECT id, terminal FROM ${projectsRel("project_statuses")}
        WHERE id IN (${sourceStatusId}::uuid, ${targetStatusId}::uuid)
          AND project_id = ${projectId}::uuid
          AND org_id = ${orgId}::uuid
      `),
    )
    if (presence.length !== 2) {
      throw new ProjectsServiceError(
        404,
        "status_not_found",
        "source or target status not in project",
      )
    }
    const target = presence.find((s) => s.id === targetStatusId)
    const targetTerminal = target?.terminal === true
    const completedAtSql = targetTerminal
      ? drizzleSql`COALESCE(completed_at, now())`
      : drizzleSql`NULL`
    const movedRows = extractRows<{ id: string }>(
      await innerTx.execute(drizzleSql`
        UPDATE ${projectsRel("tasks")}
        SET status_id = ${targetStatusId}::uuid,
            completed_at = ${completedAtSql},
            updated_at = now()
        WHERE project_id = ${projectId}::uuid
          AND org_id = ${orgId}::uuid
          AND status_id = ${sourceStatusId}::uuid
        RETURNING id
      `),
    )
    const movedTaskIds = movedRows.map((r) => r.id)
    // Each moved deal's outcome follows the stage it now sits in.
    await syncDealOutcome(innerTx, orgId, actor, movedTaskIds, {
      fromStatusIds: Object.fromEntries(movedTaskIds.map((id) => [id, sourceStatusId])),
    })
    // One query loads every moved row so each event carries the full task
    // (key, completedAt, position...) without a detail load per task.
    const movedDetails = new Map(
      (await loadTaskDetails(innerTx, orgId, movedTaskIds)).map((t) => [t.id, t]),
    )
    for (const id of movedTaskIds) {
      await innerTx.queueEvent({
        app: "projects",
        entity: "task",
        action: "moved",
        entityId: id,
        data: {
          fromStatusId: sourceStatusId,
          ...movedDetails.get(id),
          id,
          projectId,
          statusId: targetStatusId,
        },
        actorId: actor.userId,
        actorType: "user",
        orgId,
      })
    }
    // One statement for every moved task's transition.
    await recordTransitions(
      innerTx,
      orgId,
      movedTaskIds.map((taskId) => ({
        taskId,
        projectId,
        fromStatusId: sourceStatusId,
        toStatusId: targetStatusId,
      })),
      args.via ?? transitionActorFor(actor),
    )
    await innerTx.queueEvent({
      app: "projects",
      entity: "project_status",
      action: "updated",
      entityId: sourceStatusId,
      data: {
        id: sourceStatusId,
        projectId,
        migratedTo: targetStatusId,
        movedCount: movedTaskIds.length,
      },
      actorId: actor.userId,
      actorType: "user",
      orgId,
    })
    return { movedCount: movedTaskIds.length, movedTaskIds }
  })
}

export interface DeleteStatusArgs {
  tx: RlsClient
  orgId: string
  projectId: string
  statusId: string
  actor: UserContext
}

export async function deleteStatus(args: DeleteStatusArgs): Promise<{ deleted: true }> {
  const { tx, orgId, projectId, statusId, actor } = args
  return tx.transaction(async (innerTx) => {
    await ensureProjectMutable(innerTx as RlsClient, orgId, projectId)
    const statusRows = extractRows<{ id: string }>(
      await innerTx.execute(drizzleSql`
        SELECT id FROM ${projectsRel("project_statuses")}
        WHERE id = ${statusId}::uuid
          AND project_id = ${projectId}::uuid
          AND org_id = ${orgId}::uuid
        LIMIT 1
      `),
    )
    if (statusRows.length === 0) {
      throw new ProjectsServiceError(404, "not_found", "status not found")
    }
    const totalRows = extractRows<{ count: number }>(
      await innerTx.execute(drizzleSql`
        SELECT COUNT(*)::int AS count
        FROM ${projectsRel("project_statuses")}
        WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      `),
    )
    if ((totalRows[0]?.count ?? 0) <= 1) {
      throw new ProjectsServiceError(400, "last_status", "project must keep at least one status")
    }
    await assertKeepsClosingStages(innerTx, orgId, projectId, statusId)
    const taskCountRows = extractRows<{ count: number }>(
      await innerTx.execute(drizzleSql`
        SELECT COUNT(*)::int AS count
        FROM ${projectsRel("tasks")}
        WHERE status_id = ${statusId}::uuid
          AND project_id = ${projectId}::uuid
          AND org_id = ${orgId}::uuid
      `),
    )
    const taskCount = taskCountRows[0]?.count ?? 0
    if (taskCount > 0) {
      const sampleRows = extractRows<{ id: string }>(
        await innerTx.execute(drizzleSql`
          SELECT id FROM ${projectsRel("tasks")}
          WHERE status_id = ${statusId}::uuid
            AND project_id = ${projectId}::uuid
            AND org_id = ${orgId}::uuid
          ORDER BY created_at ASC
          LIMIT 50
        `),
      )
      throw new ProjectsServiceError(409, "status_in_use", "Status has tasks", {
        count: taskCount,
        taskIds: sampleRows.map((r) => r.id),
      })
    }
    const deletedRows = extractRows<{ id: string }>(
      await innerTx.execute(drizzleSql`
        DELETE FROM ${projectsRel("project_statuses")}
        WHERE id = ${statusId}::uuid
          AND project_id = ${projectId}::uuid
          AND org_id = ${orgId}::uuid
        RETURNING id
      `),
    )
    if (deletedRows.length === 0) {
      throw new ProjectsServiceError(404, "not_found", "status not found")
    }
    await innerTx.queueEvent({
      app: "projects",
      entity: "project_status",
      action: "deleted",
      entityId: statusId,
      data: { id: statusId, projectId },
      actorId: actor.userId,
      actorType: "user",
      orgId,
    })
    return { deleted: true }
  })
}
