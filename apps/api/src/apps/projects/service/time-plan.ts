// SPDX-License-Identifier: FSL-1.1-ALv2
// Time plan service: timeboxes, Took and a project's plan, billing terms and
// period timeboxes. Every write runs in the person's own RLS transaction; the
// row policies of `task_time` keep a person to their own row (the dated
// corrector is the one exception). Every tool that plans time asks
// `assertPlanningOn` first and answers `planning_off` when the project does not
// use time and budgets, writing nothing.
import { formatDuration, parseDuration } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { UUID_RE } from "~/lib/uuid"
import { hasScope } from "~/modules/permissions/permissions"
import { parseCurrency } from "./currency"
import { assertPlanningOn, orgUsesTimeBudgets, type PlanningProject } from "./planning"
import { ProjectsServiceError } from "./statuses"
import {
  checkPersonStatement,
  type EnteredVia,
  enteredViaOf,
  type TookPlace,
  todayIn,
} from "./took"

/** A real calendar day written YYYY-MM-DD (2026-02-30 is not one). */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split("-").map(Number) as [number, number, number]
  const day = new Date(Date.UTC(y, m - 1, d))
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d
}

function pgCodeOf(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.cause?.code ?? e?.code
}

export const DEFAULT_HOURS_PER_DAY_MINUTES = 420
export const UNREADABLE_TIME_MESSAGE = "Could not read this. Try 2 h, 1h30, half a day or 2 days."

type Tx = RlsClient

interface ProjectRow {
  id: string
  key: string | null
  name: string
  kind: "work" | "pipeline"
  time_budgets_on: boolean
  lead_name: string | null
}

function toPlanning(row: ProjectRow): PlanningProject {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    kind: row.kind,
    timeBudgetsOn: row.time_budgets_on,
    leadName: row.lead_name,
  }
}

/** The project as the planning guard reads it, or null when the caller cannot see it. */
export async function loadPlanningProject(
  tx: Tx,
  orgId: string,
  projectId: string,
): Promise<PlanningProject | null> {
  const rows = extractRows<ProjectRow>(
    await tx.execute(drizzleSql`
      SELECT p.id::text AS id, p.key, p.name, p.kind, p.time_budgets_on, u.name AS lead_name
        FROM ${projectsRel("projects")} p
        LEFT JOIN ${kernelRel("users")} u ON u.id = p.owner_id AND u.org_id = p.org_id
       WHERE p.id = ${projectId}::uuid AND p.org_id = ${orgId}::uuid
       LIMIT 1`),
  )
  return rows[0] ? toPlanning(rows[0]) : null
}

/** The project of a task, or a 404 when the caller cannot see the task. */
export async function projectOfTask(
  tx: Tx,
  orgId: string,
  taskId: string,
): Promise<{ taskId: string; taskKey: string | null; project: PlanningProject }> {
  const rows = extractRows<ProjectRow & { task_key: string | null }>(
    await tx.execute(drizzleSql`
      SELECT p.id::text AS id, p.key, p.name, p.kind, p.time_budgets_on, u.name AS lead_name,
             CASE WHEN p.key IS NOT NULL AND t.number IS NOT NULL
                  THEN p.key || '-' || t.number::text END AS task_key
        FROM ${projectsRel("tasks")} t
        JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
        LEFT JOIN ${kernelRel("users")} u ON u.id = p.owner_id AND u.org_id = p.org_id
       WHERE t.id = ${taskId}::uuid AND t.org_id = ${orgId}::uuid
       LIMIT 1`),
  )
  const row = rows[0]
  if (!row) throw new ProjectsServiceError(404, "not_found", `Task ${taskId} was not found.`)
  return { taskId, taskKey: row.task_key, project: toPlanning(row) }
}

/** Refuses `planning_off` unless the project uses time and budgets. */
export function requirePlanning(
  orgId: string,
  project: PlanningProject | null,
  scopes: readonly string[],
): asserts project is PlanningProject {
  assertPlanningOn(project, orgUsesTimeBudgets(orgId), scopes)
}

/** The org's hours in a day, in minutes, at this moment (default 7 h). */
export async function hoursPerDayMinutes(tx: Tx | PrivilegedDb, orgId: string): Promise<number> {
  const rows = extractRows<{ m: number }>(
    await tx.execute(drizzleSql`
      SELECT hours_per_day_minutes AS m FROM ${projectsRel("time_settings")}
       WHERE org_id = ${orgId}::uuid LIMIT 1`),
  )
  return rows[0]?.m ?? DEFAULT_HOURS_PER_DAY_MINUTES
}

/**
 * The org's zone, for "today" and for the day a task closed. A person's own row security does
 * not read `kernel.organizations`, so the zone comes from the one org-zone reader (cached a
 * minute); a privileged caller's own read still answers first.
 */
export async function orgTimezone(tx: Tx | PrivilegedDb, orgId: string): Promise<string> {
  const rows = extractRows<{ tz: string | null }>(
    await tx.execute(drizzleSql`
      SELECT timezone AS tz FROM ${kernelRel("organizations")} WHERE id = ${orgId}::uuid LIMIT 1`),
  )
  if (rows[0]?.tz) return rows[0].tz
  const { dashboardTimezone } = await import("~/modules/dashboards/execute")
  return dashboardTimezone(orgId)
}

export async function datedHoursOn(tx: Tx, orgId: string, projectId: string): Promise<boolean> {
  const rows = extractRows<{ d: boolean }>(
    await tx.execute(drizzleSql`
      SELECT dated_hours AS d FROM ${projectsRel("project_time_plan")}
       WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`),
  )
  return rows[0]?.d === true
}

/** Parse a duration at the org's hours in a day, or refuse with the field's own words. */
function readDuration(text: string, hpd: number, field: string): number {
  const minutes = parseDuration(text, hpd)
  if (minutes === null || minutes <= 0) {
    throw new ProjectsServiceError(400, "unreadable_time", UNREADABLE_TIME_MESSAGE, {
      field,
      text,
      next: "Ask the person to say it again in one of those forms. Nothing was saved.",
    })
  }
  return minutes
}

async function taskTotal(tx: Tx, projectId: string, taskId: string): Promise<number> {
  const rows = extractRows<{ minutes: number | string }>(
    await tx.execute(drizzleSql`
      SELECT minutes FROM ${projectsRel("task_time_totals")}(${projectId}::uuid, NULL, NULL)
       WHERE task_id = ${taskId}::uuid`),
  )
  return Number(rows[0]?.minutes ?? 0)
}

// ─── Timebox and milestone on a task (create / update) ────────────────────────

export interface TaskPlanPatch {
  timebox?: string | null
  isMilestone?: boolean
}

/**
 * Write a task's timebox and milestone flag. A timebox needs the project to use time and
 * budgets (`planning_off` otherwise, before anything is written); the milestone flag does not.
 * Answers the time keys the task result carries, or null when the project does not use it.
 */
export async function writeTaskPlan(args: {
  tx: Tx
  orgId: string
  taskId: string
  scopes: readonly string[]
  patch: TaskPlanPatch
}): Promise<{ timeboxMinutes: number | null; realTotalMinutes: number } | null> {
  const { tx, orgId, taskId, scopes, patch } = args
  const { project } = await projectOfTask(tx, orgId, taskId)
  if (patch.timebox !== undefined) requirePlanning(orgId, project, scopes)
  let minutes: number | null | undefined
  if (patch.timebox !== undefined) {
    minutes =
      patch.timebox === null
        ? null
        : readDuration(patch.timebox, await hoursPerDayMinutes(tx, orgId), "timebox")
  }
  if (minutes !== undefined || patch.isMilestone !== undefined) {
    await tx.execute(drizzleSql`
      UPDATE ${projectsRel("tasks")} SET
        timebox_minutes = ${minutes === undefined ? drizzleSql`timebox_minutes` : minutes},
        is_milestone = ${patch.isMilestone === undefined ? drizzleSql`is_milestone` : patch.isMilestone},
        updated_at = now()
       WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid`)
  }
  return taskTimeKeys(tx, orgId, taskId, project)
}

/** A task's time keys when its project uses time and budgets, else null (no key at all). */
export async function taskTimeKeys(
  tx: Tx,
  orgId: string,
  taskId: string,
  project?: PlanningProject,
): Promise<{ timeboxMinutes: number | null; realTotalMinutes: number } | null> {
  const p = project ?? (await projectOfTask(tx, orgId, taskId)).project
  if (!orgUsesTimeBudgets(orgId) || p.kind !== "work" || !p.timeBudgetsOn) return null
  const rows = extractRows<{ m: number | null }>(
    await tx.execute(drizzleSql`
      SELECT timebox_minutes AS m FROM ${projectsRel("tasks")}
       WHERE id = ${taskId}::uuid AND org_id = ${orgId}::uuid`),
  )
  return { timeboxMinutes: rows[0]?.m ?? null, realTotalMinutes: await taskTotal(tx, p.id, taskId) }
}

// ─── Took ─────────────────────────────────────────────────────────────────────

export interface TaskTimeSetResult {
  taskId: string
  taskKey: string | null
  minutes: number | null
  time: string | null
  totalMinutes: number
  date: string | null
  enteredVia: EnteredVia | null
  message: string
}

/** The person's latest message in the thread, read under their own row security. */
export async function latestHumanMessage(
  tx: Tx,
  orgId: string,
  threadId: string | undefined,
  userId: string,
): Promise<string | null> {
  if (!threadId) return null
  const rows = extractRows<{ content: string }>(
    await tx.execute(drizzleSql`
      SELECT content FROM ${kernelRel("messages")}
       WHERE org_id = ${orgId}::uuid AND thread_id = ${threadId}::uuid
         AND author_type = 'user' AND author_id = ${userId}::uuid AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`),
  )
  return rows[0]?.content ?? null
}

/**
 * `task_time_set`: the caller's own real time on a task. Without dated hours a person has one
 * row per task (an edit keeps its first date, clearing deletes it); with dated hours one row per
 * date, today in the org's timezone by default, never a future date. A repeat of the same call
 * leaves one row.
 */
export async function setTaskTime(args: {
  tx: Tx
  orgId: string
  userId: string
  scopes: readonly string[]
  place: TookPlace
  threadId?: string
  input: { taskId: string; time: string | null; date?: string; quote?: string }
  now?: Date
}): Promise<TaskTimeSetResult> {
  const { tx, orgId, userId, scopes, place, input } = args
  const { taskId, taskKey, project } = await projectOfTask(tx, orgId, input.taskId)
  requirePlanning(orgId, project, scopes)
  const dated = await datedHoursOn(tx, orgId, project.id)
  const tz = await orgTimezone(tx, orgId)
  const today = todayIn(tz, args.now)
  if (input.date !== undefined && !dated) {
    throw new ProjectsServiceError(
      400,
      "date_not_used",
      "Nothing was recorded: this project does not use dated hours, so Took takes no date.",
      {
        next: "Call again without date.",
      },
    )
  }
  const date = dated ? (input.date ?? today) : undefined
  if (date !== undefined && !isCalendarDate(date)) {
    throw new ProjectsServiceError(
      400,
      "invalid_date",
      `Nothing was recorded: ${date} is not a date (YYYY-MM-DD).`,
    )
  }
  if (date !== undefined && date > today) {
    throw new ProjectsServiceError(
      400,
      "future_date",
      `Nothing was recorded: ${date} is after today (${today}), and time is entered for days already worked.`,
      {
        next: "Ask for the day it was worked, today or earlier.",
      },
    )
  }
  const label = taskKey ?? taskId

  if (input.time === null) {
    await tx.execute(drizzleSql`
      DELETE FROM ${projectsRel("task_time")}
       WHERE org_id = ${orgId}::uuid AND task_id = ${taskId}::uuid AND user_id = ${userId}::uuid
         ${date !== undefined ? drizzleSql`AND work_date = ${date}::date` : drizzleSql``}`)
    const total = await taskTotal(tx, project.id, taskId)
    return {
      taskId,
      taskKey,
      minutes: null,
      time: null,
      totalMinutes: total,
      date: date ?? null,
      enteredVia: null,
      message: `Your time on ${label}${date ? ` for ${date}` : ""} was cleared. The task's total is now ${formatDuration(total, "h")}.`,
    }
  }

  const hpd = await hoursPerDayMinutes(tx, orgId)
  const minutes = readDuration(input.time, hpd, "time")
  const refusal = checkPersonStatement({
    place,
    minutes,
    quote: input.quote,
    hoursPerDayMinutes: hpd,
    latestHumanMessage:
      place.origin === "in-app-agent"
        ? await latestHumanMessage(tx, orgId, args.threadId, userId)
        : null,
  })
  if (refusal) {
    throw new ProjectsServiceError(409, refusal.code, refusal.message, { next: refusal.next })
  }
  const via = enteredViaOf(place.origin)
  let workDate: string
  if (date !== undefined) {
    workDate = date
    await tx.execute(drizzleSql`
      INSERT INTO ${projectsRel("task_time")}
        (org_id, task_id, project_id, user_id, work_date, minutes, entered_via)
      VALUES (${orgId}::uuid, ${taskId}::uuid, ${project.id}::uuid, ${userId}::uuid,
              ${date}::date, ${minutes}, ${via})
      ON CONFLICT (org_id, task_id, user_id, work_date)
        DO UPDATE SET minutes = EXCLUDED.minutes, entered_via = EXCLUDED.entered_via,
                      changed_by = NULL, updated_at = now()`)
  } else {
    // One row per person per task: an edit replaces the minutes and keeps the first date.
    const existing = extractRows<{ id: string; work_date: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, work_date::text AS work_date FROM ${projectsRel("task_time")}
         WHERE org_id = ${orgId}::uuid AND task_id = ${taskId}::uuid AND user_id = ${userId}::uuid
         ORDER BY work_date ASC`),
    )
    const first = existing[0]
    if (first) {
      workDate = first.work_date
      await tx.execute(drizzleSql`
        UPDATE ${projectsRel("task_time")}
           SET minutes = ${minutes}, entered_via = ${via}, changed_by = NULL, updated_at = now()
         WHERE id = ${first.id}::uuid`)
      for (const extra of existing.slice(1)) {
        await tx.execute(
          drizzleSql`DELETE FROM ${projectsRel("task_time")} WHERE id = ${extra.id}::uuid`,
        )
      }
    } else {
      workDate = today
      await tx.execute(drizzleSql`
        INSERT INTO ${projectsRel("task_time")}
          (org_id, task_id, project_id, user_id, work_date, minutes, entered_via)
        VALUES (${orgId}::uuid, ${taskId}::uuid, ${project.id}::uuid, ${userId}::uuid,
                ${today}::date, ${minutes}, ${via})
        ON CONFLICT (org_id, task_id, user_id, work_date)
          DO UPDATE SET minutes = EXCLUDED.minutes, entered_via = EXCLUDED.entered_via,
                        updated_at = now()`)
    }
  }
  const total = await taskTotal(tx, project.id, taskId)
  return {
    taskId,
    taskKey,
    minutes,
    time: formatDuration(minutes, "h"),
    totalMinutes: total,
    date: dated ? workDate : null,
    enteredVia: via,
    message: `Recorded ${formatDuration(minutes, "h")} of your own time on ${label}${dated ? ` for ${workDate}` : ""}. The task's total is now ${formatDuration(total, "h")}.`,
  }
}

/** `task_time_get`: the caller's own rows on a task, and the task's total (no one else's part). */
export async function getTaskTime(args: {
  tx: Tx
  orgId: string
  userId: string
  scopes: readonly string[]
  taskId: string
}): Promise<{
  taskId: string
  taskKey: string | null
  mine: Array<{
    id: string
    date: string
    minutes: number
    enteredVia: EnteredVia
    changedBy?: string
  }>
  totalMinutes: number
}> {
  const { tx, orgId, userId, scopes } = args
  const { taskId, taskKey, project } = await projectOfTask(tx, orgId, args.taskId)
  requirePlanning(orgId, project, scopes)
  const rows = extractRows<{
    id: string
    date: string
    minutes: number
    entered_via: EnteredVia
    changed_by_name: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT tt.id::text AS id, tt.work_date::text AS date, tt.minutes, tt.entered_via,
             CASE WHEN tt.changed_by IS NOT NULL AND tt.changed_by <> tt.user_id
                  THEN cb.name END AS changed_by_name
        FROM ${projectsRel("task_time")} tt
        LEFT JOIN ${kernelRel("users")} cb ON cb.id = tt.changed_by AND cb.org_id = tt.org_id
       WHERE tt.org_id = ${orgId}::uuid AND tt.task_id = ${taskId}::uuid
         AND tt.user_id = ${userId}::uuid
       ORDER BY tt.work_date`),
  )
  return {
    taskId,
    taskKey,
    mine: rows.map((r) => ({
      id: r.id,
      date: r.date,
      minutes: r.minutes,
      enteredVia: r.entered_via,
      ...(r.changed_by_name ? { changedBy: `Changed by ${r.changed_by_name}` } : {}),
    })),
    totalMinutes: await taskTotal(tx, project.id, taskId),
  }
}

/** Held exactly (never through `*`): finance's read and correction of a dated sheet. */
export const TIMESHEET_READ_SCOPE = "projects:timesheet:read"

const NOT_YOURS_TO_CHANGE =
  "Only the project's lead or finance changes an entry, on a project with dated hours."

/**
 * `task_time_correct`: the project's lead or an exact holder of the timesheet scope changes
 * an entry on that project's dated sheet (entered while dated hours were on, after they were
 * last turned on). Any other entry, the caller's own private ones included, is not found here,
 * and the row policy says the same. Like Took, the new figure is a person's own statement: an
 * agent passes the corrector's words as `quote`, and a routine or a sub-run is refused. The
 * person then reads "Changed by <name>" under their own Took.
 */
export async function correctTaskTime(args: {
  tx: Tx
  orgId: string
  actorId: string
  scopes: readonly string[]
  place: TookPlace
  threadId?: string
  input: { entryId: string; time: string; date?: string; quote?: string }
}): Promise<{ id: string; taskId: string; date: string; minutes: number; message: string }> {
  const { tx, orgId, actorId, scopes, input } = args
  if (!UUID_RE.test(input.entryId)) {
    throw new ProjectsServiceError(
      404,
      "not_found",
      `No entry ${input.entryId} you may change was found; nothing changed.`,
      { next: NOT_YOURS_TO_CHANGE },
    )
  }
  const found = extractRows<{
    task_id: string
    project_id: string
    on_sheet: boolean
    owner_id: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT tt.task_id::text AS task_id, tt.project_id::text AS project_id,
             (tt.entered_dated AND coalesce(tp.dated_hours, false) AND pr.time_budgets_on
               AND tt.created_at >= tp.dated_hours_changed_at) AS on_sheet,
             pr.owner_id::text AS owner_id
        FROM ${projectsRel("task_time")} tt
        JOIN ${projectsRel("projects")} pr ON pr.id = tt.project_id AND pr.org_id = tt.org_id
        LEFT JOIN ${projectsRel("project_time_plan")} tp
          ON tp.project_id = tt.project_id AND tp.org_id = tt.org_id
       WHERE tt.id = ${input.entryId}::uuid AND tt.org_id = ${orgId}::uuid`),
  )
  const entry = found[0]
  // Defence in depth over the row policy: only an entry on a dated sheet, only for that
  // project's lead or an exact timesheet reader.
  if (!entry?.on_sheet || (entry.owner_id !== actorId && !scopes.includes(TIMESHEET_READ_SCOPE))) {
    throw new ProjectsServiceError(
      404,
      "not_found",
      `No entry ${input.entryId} you may change was found; nothing changed.`,
      { next: NOT_YOURS_TO_CHANGE },
    )
  }
  const project = await loadPlanningProject(tx, orgId, entry.project_id)
  requirePlanning(orgId, project, scopes)
  const hpd = await hoursPerDayMinutes(tx, orgId)
  const minutes = readDuration(input.time, hpd, "time")
  const refusal = checkPersonStatement({
    place: args.place,
    minutes,
    quote: input.quote,
    hoursPerDayMinutes: hpd,
    latestHumanMessage:
      args.place.origin === "in-app-agent"
        ? await latestHumanMessage(tx, orgId, args.threadId, actorId)
        : null,
  })
  if (refusal) {
    throw new ProjectsServiceError(
      409,
      refusal.code,
      refusal.message.replace("Nothing was recorded", "Nothing changed"),
      { next: refusal.next },
    )
  }
  if (input.date !== undefined) {
    if (!isCalendarDate(input.date)) {
      throw new ProjectsServiceError(
        400,
        "invalid_date",
        `Nothing changed: ${input.date} is not a date (YYYY-MM-DD).`,
        { next: "Give the day the work was done, as YYYY-MM-DD." },
      )
    }
    const today = todayIn(await orgTimezone(tx, orgId))
    if (input.date > today) {
      throw new ProjectsServiceError(
        400,
        "future_date",
        `Nothing changed: ${input.date} is after today (${today}), and time is entered for days already worked.`,
        { next: "Give the day the work was done, today or earlier." },
      )
    }
  }
  const updated = extractRows<{ id: string; date: string; user_id: string | null }>(
    await tx
      .transaction(async (sp) =>
        sp.execute(drizzleSql`
      UPDATE ${projectsRel("task_time")}
         SET minutes = ${minutes},
             work_date = ${input.date === undefined ? drizzleSql`work_date` : drizzleSql`${input.date}::date`},
             changed_by = CASE WHEN user_id = ${actorId}::uuid THEN NULL ELSE ${actorId}::uuid END,
             updated_at = now()
       WHERE id = ${input.entryId}::uuid AND org_id = ${orgId}::uuid
       RETURNING id::text AS id, work_date::text AS date, user_id::text AS user_id`),
      )
      .catch((err: unknown) => {
        if (pgCodeOf(err) === "23505") {
          throw new ProjectsServiceError(
            409,
            "entry_exists",
            `Nothing changed: the same person already has an entry on this task for ${input.date}.`,
            { next: "Correct that day's entry instead." },
          )
        }
        throw err
      }),
  )
  const row = updated[0]
  if (!row) {
    throw new ProjectsServiceError(
      404,
      "not_found",
      `Entry ${input.entryId} was not changed: you may not change it.`,
      { next: NOT_YOURS_TO_CHANGE },
    )
  }
  return {
    id: row.id,
    taskId: entry.task_id,
    date: row.date,
    minutes,
    message: `The entry is now ${formatDuration(minutes, "h")} on ${row.date}. Its author sees that you changed it.`,
  }
}

// ─── A project's plan, terms and period timeboxes ─────────────────────────────

const BASES = ["none", "hourly", "daily", "fixed", "retainer"] as const
export type Basis = (typeof BASES)[number]

export interface TimePlanInput {
  projectId: string
  basis?: Basis
  timebox?: string | null
  billerId?: string | null
  sourceRepos?: Array<{ provider: string; repo: string }>
  datedHours?: boolean
}

export interface TimePlan {
  projectId: string
  basis: Basis
  timeboxMinutes: number | null
  billerId: string | null
  datedHours: boolean
  sourceRepos: Array<{ provider: string; repo: string }>
}

/**
 * `time_plan_set`: one project's plan. `datedHours` records who turned it and when; turning it
 * on reaches forward only (the row policy reads the change date). Answers whether dated hours
 * were turned on now, so the caller tells everyone with entries.
 */
export async function setTimePlan(args: {
  tx: Tx
  orgId: string
  actorId: string
  scopes: readonly string[]
  input: TimePlanInput
}): Promise<{ plan: TimePlan; datedTurnedOn: boolean; message: string }> {
  const { tx, orgId, actorId, scopes, input } = args
  const project = await loadPlanningProject(tx, orgId, input.projectId)
  requirePlanning(orgId, project, scopes)
  if (input.basis !== undefined && !BASES.includes(input.basis)) {
    throw new ProjectsServiceError(
      400,
      "invalid_basis",
      `Nothing changed: basis is one of ${BASES.join(", ")}.`,
    )
  }
  const timebox =
    input.timebox === undefined || input.timebox === null
      ? input.timebox
      : readDuration(input.timebox, await hoursPerDayMinutes(tx, orgId), "timebox")
  const before = extractRows<{ dated_hours: boolean }>(
    await tx.execute(drizzleSql`
      SELECT dated_hours FROM ${projectsRel("project_time_plan")}
       WHERE project_id = ${project.id}::uuid AND org_id = ${orgId}::uuid`),
  )[0]
  const wasDated = before?.dated_hours === true
  const flip = input.datedHours !== undefined && input.datedHours !== wasDated
  const keep = (
    col:
      | "basis"
      | "timebox_minutes"
      | "biller_id"
      | "dated_hours"
      | "dated_hours_changed_by"
      | "dated_hours_changed_at"
      | "source_repos",
  ) => drizzleSql.raw(`project_time_plan.${col}`)
  const repos = input.sourceRepos === undefined ? null : JSON.stringify(input.sourceRepos)
  await tx.execute(drizzleSql`
    INSERT INTO ${projectsRel("project_time_plan")}
      (project_id, org_id, basis, timebox_minutes, biller_id, dated_hours,
       dated_hours_changed_by, dated_hours_changed_at, source_repos)
    VALUES (${project.id}::uuid, ${orgId}::uuid, ${input.basis ?? "none"},
            ${timebox ?? null}, ${input.billerId ?? null}::uuid, ${input.datedHours ?? false},
            ${flip ? actorId : null}::uuid, ${flip ? drizzleSql`now()` : null},
            ${repos ?? "[]"}::jsonb)
    ON CONFLICT (project_id) DO UPDATE SET
      basis = ${input.basis === undefined ? keep("basis") : input.basis},
      timebox_minutes = ${timebox === undefined ? keep("timebox_minutes") : timebox},
      biller_id = ${input.billerId === undefined ? keep("biller_id") : drizzleSql`${input.billerId}::uuid`},
      dated_hours = ${input.datedHours === undefined ? keep("dated_hours") : input.datedHours},
      dated_hours_changed_by = ${flip ? drizzleSql`${actorId}::uuid` : keep("dated_hours_changed_by")},
      dated_hours_changed_at = ${flip ? drizzleSql`now()` : keep("dated_hours_changed_at")},
      source_repos = ${repos === null ? keep("source_repos") : drizzleSql`${repos}::jsonb`},
      updated_at = now()`)
  const row = extractRows<{
    basis: Basis
    timebox_minutes: number | null
    biller_id: string | null
    dated_hours: boolean
    source_repos: Array<{ provider: string; repo: string }>
  }>(
    await tx.execute(drizzleSql`
      SELECT basis, timebox_minutes, biller_id::text AS biller_id, dated_hours, source_repos
        FROM ${projectsRel("project_time_plan")}
       WHERE project_id = ${project.id}::uuid AND org_id = ${orgId}::uuid`),
  )[0]
  if (!row) throw new ProjectsServiceError(404, "not_found", "The plan was not saved.")
  const datedTurnedOn = flip && input.datedHours === true
  const parts = [`${project.name}'s plan is saved: basis ${row.basis}`]
  if (row.timebox_minutes) parts.push(`timebox ${formatDuration(row.timebox_minutes, "h")}`)
  parts.push(`dated hours ${row.dated_hours ? "on" : "off"}`)
  let message = `${parts.join(", ")}.`
  if (datedTurnedOn) {
    message +=
      " From now on its lead and finance see each person's dated entries made on it; entries made before stay private to their authors. Everyone with entries is told on Home."
  } else if (flip) {
    message += " The timesheet is hidden and every entry is kept."
  }
  return {
    plan: {
      projectId: project.id,
      basis: row.basis,
      timeboxMinutes: row.timebox_minutes,
      billerId: row.biller_id,
      datedHours: row.dated_hours,
      sourceRepos: row.source_repos ?? [],
    },
    datedTurnedOn,
    message,
  }
}

/** The plan as the edit form reads it back; the money keys only for a holder of the money scope. */
export interface TimePlanRead {
  projectId: string
  basis: Basis
  billerId: string | null
  billerName: string | null
  datedHours: boolean
  rate?: number | null
  fixedPrice?: number | null
  currency?: string | null
}

/**
 * One project's plan, read back for the form that edits it: basis, who bills, dated hours and,
 * for a holder of `projects:money:read`, the rate or fixed price. A project that does not use
 * time and budgets refuses `planning_off`, as every other time read does.
 */
export async function getTimePlan(args: {
  tx: Tx
  orgId: string
  scopes: readonly string[]
  projectId: string
}): Promise<TimePlanRead> {
  const { tx, orgId, scopes, projectId } = args
  const project = await loadPlanningProject(tx, orgId, projectId)
  requirePlanning(orgId, project, scopes)
  const plan = extractRows<{
    basis: Basis | null
    biller_id: string | null
    biller_name: string | null
    dated_hours: boolean | null
  }>(
    await tx.execute(drizzleSql`
      SELECT tp.basis, tp.biller_id::text AS biller_id, u.name AS biller_name, tp.dated_hours
        FROM ${projectsRel("project_time_plan")} tp
        LEFT JOIN ${kernelRel("users")} u ON u.id = tp.biller_id AND u.org_id = tp.org_id
       WHERE tp.project_id = ${project.id}::uuid AND tp.org_id = ${orgId}::uuid`),
  )[0]
  const out: TimePlanRead = {
    projectId: project.id,
    basis: plan?.basis ?? "none",
    billerId: plan?.biller_id ?? null,
    billerName: plan?.biller_name ?? null,
    datedHours: plan?.dated_hours === true,
  }
  if (!hasScope("projects:money:read", [...scopes])) return out
  const terms = extractRows<{
    rate_minor: string | number | null
    fixed_price_minor: string | number | null
    currency: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT rate_minor, fixed_price_minor, currency FROM ${projectsRel("project_billing_terms")}
       WHERE project_id = ${project.id}::uuid AND org_id = ${orgId}::uuid`),
  )[0]
  const major = (v: string | number | null | undefined) => (v == null ? null : Number(v) / 100)
  return {
    ...out,
    rate: major(terms?.rate_minor),
    fixedPrice: major(terms?.fixed_price_minor),
    currency: terms?.currency ?? null,
  }
}

/** `billing_terms_set`: a rate or a fixed price, never both. Amounts in major units. */
export async function setBillingTerms(args: {
  tx: Tx
  orgId: string
  scopes: readonly string[]
  input: { projectId: string; rate?: number | null; fixedPrice?: number | null; currency?: string }
}): Promise<{
  projectId: string
  rate: number | null
  fixedPrice: number | null
  currency: string | null
  message: string
}> {
  const { tx, orgId, scopes, input } = args
  const project = await loadPlanningProject(tx, orgId, input.projectId)
  requirePlanning(orgId, project, scopes)
  if (typeof input.rate === "number" && typeof input.fixedPrice === "number") {
    throw new ProjectsServiceError(
      400,
      "rate_and_fixed_price",
      "Nothing changed: a project is billed by a rate or at a fixed price, not both.",
      {
        next: "Ask which one the project uses, then call again with only that one.",
      },
    )
  }
  const minor = (v: number | null | undefined) =>
    v === undefined ? undefined : v === null ? null : Math.round(v * 100)
  const rate = minor(input.rate)
  const fixed = minor(input.fixedPrice)
  if ((rate ?? 0) < 0 || (fixed ?? 0) < 0) {
    throw new ProjectsServiceError(
      400,
      "invalid_amount",
      "Nothing changed: an amount cannot be negative.",
    )
  }
  const currency = parseCurrency(input.currency)
  // Setting one clears the other, so the project never holds both.
  const rateValue =
    rate !== undefined ? rate : fixed !== undefined && fixed !== null ? null : undefined
  const fixedValue =
    fixed !== undefined ? fixed : rate !== undefined && rate !== null ? null : undefined
  const keep = (col: "rate_minor" | "fixed_price_minor" | "currency") =>
    drizzleSql.raw(`project_billing_terms.${col}`)
  await tx.execute(drizzleSql`
    INSERT INTO ${projectsRel("project_billing_terms")}
      (project_id, org_id, rate_minor, fixed_price_minor, currency)
    VALUES (${project.id}::uuid, ${orgId}::uuid, ${rateValue ?? null}, ${fixedValue ?? null},
            ${currency ?? null})
    ON CONFLICT (project_id) DO UPDATE SET
      rate_minor = ${rateValue === undefined ? keep("rate_minor") : rateValue},
      fixed_price_minor = ${fixedValue === undefined ? keep("fixed_price_minor") : fixedValue},
      currency = ${currency === undefined ? keep("currency") : currency},
      updated_at = now()`)
  const row = extractRows<{
    rate_minor: string | number | null
    fixed_price_minor: string | number | null
    currency: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT rate_minor, fixed_price_minor, currency FROM ${projectsRel("project_billing_terms")}
       WHERE project_id = ${project.id}::uuid AND org_id = ${orgId}::uuid`),
  )[0]
  const major = (v: string | number | null | undefined) => (v == null ? null : Number(v) / 100)
  const out = {
    projectId: project.id,
    rate: major(row?.rate_minor),
    fixedPrice: major(row?.fixed_price_minor),
    currency: row?.currency ?? null,
  }
  const what =
    out.fixedPrice !== null
      ? `a fixed price of ${out.fixedPrice}${out.currency ? ` ${out.currency}` : ""}`
      : out.rate !== null
        ? `a rate of ${out.rate}${out.currency ? ` ${out.currency}` : ""}`
        : "no rate and no fixed price"
  return {
    ...out,
    message: `${project.name} is now billed at ${what}. Cards made from now use it; an issued line keeps what it had.`,
  }
}

/** `period_timebox_set`: a month's or a period's timebox on a project; null removes it. */
export async function setPeriodTimebox(args: {
  tx: Tx
  orgId: string
  actorId: string
  scopes: readonly string[]
  input: { projectId: string; month?: string; from?: string; to?: string; timebox: string | null }
}): Promise<{
  projectId: string
  from: string
  to: string
  minutes: number | null
  removed: boolean
  message: string
}> {
  const { tx, orgId, actorId, scopes, input } = args
  const project = await loadPlanningProject(tx, orgId, input.projectId)
  requirePlanning(orgId, project, scopes)
  let from: string
  let to: string
  if (input.month !== undefined) {
    const m = /^(\d{4})-(\d{2})$/.exec(input.month)
    const month = m ? Number(m[2]) : 0
    if (!m || month < 1 || month > 12) {
      throw new ProjectsServiceError(
        400,
        "invalid_period",
        `Nothing changed: ${input.month} is not a month (YYYY-MM).`,
      )
    }
    const year = Number(m[1])
    from = `${m[1]}-${m[2]}-01`
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
    to = `${m[1]}-${m[2]}-${String(last).padStart(2, "0")}`
  } else if (input.from && input.to && input.from <= input.to) {
    from = input.from
    to = input.to
  } else {
    throw new ProjectsServiceError(
      400,
      "invalid_period",
      "Nothing changed: give month (YYYY-MM), or from and to with from on or before to.",
    )
  }
  if (input.timebox === null) {
    const gone = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        DELETE FROM ${projectsRel("project_timeboxes")}
         WHERE org_id = ${orgId}::uuid AND project_id = ${project.id}::uuid
           AND period_start = ${from}::date
         RETURNING id::text AS id`),
    )
    return {
      projectId: project.id,
      from,
      to,
      minutes: null,
      removed: gone.length > 0,
      message:
        gone.length > 0
          ? `The timebox of ${project.name} for ${from} to ${to} is removed.`
          : `${project.name} had no timebox for ${from} to ${to}; nothing changed.`,
    }
  }
  const minutes = readDuration(input.timebox, await hoursPerDayMinutes(tx, orgId), "timebox")
  await tx.execute(drizzleSql`
    INSERT INTO ${projectsRel("project_timeboxes")}
      (org_id, project_id, period_start, period_end, minutes, source, created_by)
    VALUES (${orgId}::uuid, ${project.id}::uuid, ${from}::date, ${to}::date, ${minutes},
            'manual', ${actorId}::uuid)
    ON CONFLICT (org_id, project_id, period_start) DO UPDATE SET
      period_end = EXCLUDED.period_end, minutes = EXCLUDED.minutes, updated_at = now()`)
  return {
    projectId: project.id,
    from,
    to,
    minutes,
    removed: false,
    message: `${project.name} has a timebox of ${formatDuration(minutes, "h")} for ${from} to ${to}.`,
  }
}
