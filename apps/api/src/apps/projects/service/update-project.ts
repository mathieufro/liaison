// SPDX-License-Identifier: FSL-1.1-ALv2
// Edit a project's own fields: name, description, icon, colour, key, group and
// the checklist-on-cards switch. One writer for the REST PATCH and the agent's
// `update_project` tool, so both refuse with the same codes.
//
// The key is the prefix of every task's display key (ERB-12) and of every
// mention and link written with one, so it changes only while the project has
// no task at all: a trashed task counts, since a restore brings its key back.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { describeDbError } from "~/lib/transient-db-error"
import {
  loadProjectDetail,
  normalizeExplicitProjectKey,
  normalizeProjectGroup,
  type ProjectDetail,
} from "./create-project"
import { assertVisibleCompany } from "./deals"
import { planningOffBody } from "./planning"
import { ProjectsServiceError } from "./statuses"
import { scheduleTimeBudgetsSync } from "./time-feature"

export interface UpdateProjectPatch {
  name?: string
  description?: string | null
  icon?: string | null
  color?: string | null
  key?: string
  /** Sidebar group heading: trimmed, "" or null clears it. */
  group?: string | null
  checklistOnCards?: boolean
  /** The project's client: a company the caller can read, or null to clear. */
  companyId?: string | null
  /** Time and budgets on this project. Work projects only; the org row follows (time-feature.ts). */
  timeBudgets?: boolean
}

export interface UpdateProjectArgs {
  tx: RlsClient
  orgId: string
  projectId: string
  actor: UserContext
  patch: UpdateProjectPatch
  /** The event's actor type: "agent" when the agent tool made the edit. */
  actorType?: "user" | "agent"
  /**
   * When a time and budgets change is recorded. Only a seed laying a world's past passes it (the
   * day the project started using it); every person's and agent's edit is recorded at now().
   */
  recordedAt?: Date
}

/** Does the project hold any task row, live or in the trash? */
export async function projectHasTasks(
  tx: RlsClient,
  orgId: string,
  projectId: string,
): Promise<boolean> {
  const rows = extractRows<{ one: number }>(
    await tx.execute(drizzleSql`
      SELECT 1 AS one FROM ${projectsRel("tasks")}
      WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  return rows.length > 0
}

export async function updateProject(args: UpdateProjectArgs): Promise<ProjectDetail> {
  return (await updateProjectWithOutcome(args)).detail
}

export interface UpdateProjectOutcome {
  detail: ProjectDetail
  /** Set when this call turned time and budgets on or off; absent when it was already so. */
  timeBudgetsFlipped?: "on" | "off"
}

/**
 * The one writer. A change of `timeBudgets` sets `time_budgets_changed_by` and `_at`,
 * queues one `time_feature:changed` event (its audit row), and after the commit the org
 * row is recomputed from the projects. The same value again writes nothing.
 */
export async function updateProjectWithOutcome(
  args: UpdateProjectArgs,
): Promise<UpdateProjectOutcome> {
  const { tx, orgId, projectId, actor } = args
  const { timeBudgets, ...patch } = args.patch
  return tx.transaction(async (innerTx) => {
    const rows = extractRows<{
      id: string
      key: string | null
      name: string
      kind: "work" | "pipeline"
      time_budgets_on: boolean
      archived_at: Date | string | null
    }>(
      await innerTx.execute(drizzleSql`
        SELECT id, key, name, kind, time_budgets_on, archived_at FROM ${projectsRel("projects")}
        WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
        LIMIT 1
        FOR UPDATE
      `),
    )
    const row = rows[0]
    if (!row) throw new ProjectsServiceError(404, "not_found", "project not found")
    if (row.archived_at) {
      throw new ProjectsServiceError(409, "project_archived", "project is archived")
    }
    if (timeBudgets === true && row.kind !== "work") {
      const body = planningOffBody(
        {
          id: row.id,
          key: row.key,
          name: row.name,
          kind: row.kind,
          timeBudgetsOn: false,
          leadName: null,
        },
        actor.scopes,
      )
      throw new ProjectsServiceError(409, "planning_off", body.message, body)
    }
    const flip =
      timeBudgets !== undefined && timeBudgets !== row.time_budgets_on ? timeBudgets : undefined
    const otherFields = Object.values(patch).some((v) => v !== undefined)
    if (!otherFields) {
      if (flip !== undefined) await writeFlip(innerTx as RlsClient, args, flip)
      return {
        detail: await loadProjectDetail(innerTx as RlsClient, orgId, projectId, {
          withTimeBudgets: timeBudgets !== undefined,
        }),
        ...(flip !== undefined
          ? { timeBudgetsFlipped: flip ? ("on" as const) : ("off" as const) }
          : {}),
      }
    }
    if (patch.name !== undefined && patch.name.trim().length === 0) {
      throw new ProjectsServiceError(400, "invalid_params", "name must not be empty")
    }
    let normalizedGroup: string | null | undefined
    try {
      normalizedGroup = normalizeProjectGroup(patch.group)
    } catch (err) {
      throw new ProjectsServiceError(400, "invalid_group", String((err as Error)?.message ?? err))
    }
    const sets: ReturnType<typeof drizzleSql>[] = []
    if (patch.name !== undefined) sets.push(drizzleSql`name = ${patch.name.trim()}`)
    if (patch.description !== undefined) sets.push(drizzleSql`description = ${patch.description}`)
    if (patch.icon !== undefined) sets.push(drizzleSql`icon = ${patch.icon}`)
    if (patch.color !== undefined) sets.push(drizzleSql`color = ${patch.color}`)
    if (normalizedGroup !== undefined) sets.push(drizzleSql`"group" = ${normalizedGroup}`)
    if (patch.checklistOnCards !== undefined) {
      sets.push(drizzleSql`checklist_on_cards = ${patch.checklistOnCards}`)
    }
    if (patch.companyId !== undefined) {
      if (patch.companyId !== null) await assertVisibleCompany(innerTx, orgId, patch.companyId)
      sets.push(drizzleSql`company_id = ${patch.companyId}::uuid`)
    }
    let normalizedKey: string | undefined
    if (patch.key !== undefined) {
      try {
        normalizedKey = normalizeExplicitProjectKey(patch.key)
      } catch (err) {
        throw new ProjectsServiceError(
          400,
          "invalid_project_key",
          String((err as Error)?.message ?? err),
        )
      }
      if (normalizedKey !== row.key) {
        if (await projectHasTasks(innerTx as RlsClient, orgId, projectId)) {
          throw new ProjectsServiceError(
            409,
            "project_key_locked",
            "the key cannot change once the project has tasks: every task key and link is built on it",
            { key: row.key },
          )
        }
        sets.push(drizzleSql`key = ${normalizedKey}`)
      }
    }
    sets.push(drizzleSql`updated_at = now()`)
    const setSql = sets.reduce<ReturnType<typeof drizzleSql> | null>(
      (acc, frag) => (acc === null ? frag : drizzleSql`${acc}, ${frag}`),
      null,
    )
    try {
      await innerTx.execute(drizzleSql`
        UPDATE ${projectsRel("projects")}
        SET ${setSql}
        WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
      `)
    } catch (err) {
      const { code, message: causeMessage } = describeDbError(err)
      const isKeyCollision =
        code === "23505" && !!causeMessage?.includes("app_projects_org_key_uidx")
      if (normalizedKey && isKeyCollision) {
        throw new ProjectsServiceError(
          409,
          "project_key_taken",
          `key ${JSON.stringify(normalizedKey)} is already in use by another project`,
        )
      }
      throw err
    }
    await innerTx.queueEvent({
      app: "projects",
      entity: "project",
      action: "updated",
      entityId: projectId,
      data: {
        id: projectId,
        ...patch,
        ...(normalizedKey !== undefined ? { key: normalizedKey } : {}),
        ...(normalizedGroup !== undefined ? { group: normalizedGroup } : {}),
      },
      actorId: actor.userId,
      actorType: args.actorType ?? "user",
      orgId,
    })
    if (flip !== undefined) await writeFlip(innerTx as RlsClient, args, flip)
    return {
      detail: await loadProjectDetail(innerTx as RlsClient, orgId, projectId, {
        withTimeBudgets: timeBudgets !== undefined,
      }),
      ...(flip !== undefined
        ? { timeBudgetsFlipped: flip ? ("on" as const) : ("off" as const) }
        : {}),
    }
  })
}

/** Turn the switch, record who and when, queue its event, and recompute the org row after commit. */
async function writeFlip(tx: RlsClient, args: UpdateProjectArgs, on: boolean): Promise<void> {
  const { orgId, projectId, actor } = args
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("projects")}
    SET time_budgets_on = ${on}, time_budgets_changed_by = ${actor.userId}::uuid,
        time_budgets_changed_at = ${args.recordedAt ? drizzleSql`${args.recordedAt.toISOString()}::timestamptz` : drizzleSql`now()`},
        updated_at = now()
    WHERE id = ${projectId}::uuid AND org_id = ${orgId}::uuid
  `)
  await tx.queueEvent({
    app: "projects",
    entity: "time_feature",
    action: "changed",
    entityId: projectId,
    data: { projectId, timeBudgets: on },
    actorId: actor.userId,
    actorType: args.actorType ?? "user",
    orgId,
  })
  scheduleTimeBudgetsSync(orgId, actor.userId)
}
