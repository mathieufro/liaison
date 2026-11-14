// SPDX-License-Identifier: FSL-1.1-ALv2
// `capacity_get`: planned time against available time per person for one ISO week, on the
// projects that use time and budgets. Planned comes from timeboxes only, never from time anyone
// entered; available from hours in a day, days per week, company days off and away days. A
// colleague's day off shows only as a lower available figure: no date, label, reason or flag.
// People come in name order and nothing ranks them: there is no sort and no score.
import {
  addCalendarDays,
  expandDaysOff,
  isoWeekdayOf,
  isoWeekOf,
  isoWeekRange,
  isoWeeksIn,
  overNote,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { awayDays } from "~/modules/users/away"
import { resolveTaskRef } from "./resolve"
import { ProjectsServiceError } from "./statuses"
import { hoursPerDayMinutes, orgTimezone } from "./time-plan"
import { todayIn } from "./took"

/** The person's request transaction, or the Home lines' privileged one. */
type Tx = RlsClient | PrivilegedDb

const WEEK_RE = /^(\d{4})-W(\d{2})$/
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true })

export interface CapacityTask {
  /** The task's id, so a board can open or move it. */
  id: string
  key: string | null
  title: string
  minutes: number
  /** Only when asked for (`withProjects`): the Home lines find the project's leads with it. */
  projectId?: string
}

export interface CapacityPerson {
  userId: string
  name: string
  availableMinutes: number
  plannedMinutes: number
  note: string | null
  tasks: CapacityTask[]
}

export interface CapacityCandidate {
  userId: string
  name: string
  freeMinutes: number
  onProject: boolean
}

export interface CapacityResult {
  week: string
  from: string
  to: string
  availableMinutes: number
  plannedMinutes: number
  people: CapacityPerson[]
  left: CapacityTask[]
  overLine: string | null
  /** What the figures cover, said with every answer. */
  covers: string
  /**
   * Only when nobody has planned work that week: what that means and how time gets planned,
   * so an empty list never reads as "nobody has room" or "no project uses time".
   */
  nothingPlanned?: string
  candidates?: CapacityCandidate[]
  taskId?: string
  /** The card's own reading of the above: the people, then the quiet row of who has left. */
  title: string
  groups: Array<{
    label: string
    rows: Array<{
      id: string
      name: string
      plannedMinutes: number
      availableMinutes?: number
      note?: string
    }>
  }>
  totals: Array<{ k: string; text: string }>
}

/** Monday to Sunday of an ISO week label, or a refusal naming the form. */
export function weekRange(week: string): { from: string; to: string } {
  const m = WEEK_RE.exec(week)
  const year = Number(m?.[1])
  const n = Number(m?.[2])
  const range = m ? isoWeekRange(year, n) : null
  if (!range) {
    throw new ProjectsServiceError(
      422,
      m && n <= 53 && n > isoWeeksIn(year) ? "no_such_week" : "bad_week",
      m
        ? `${year} has no ISO week ${n}. Nothing was read.`
        : `"${week}" is not an ISO week. Write it like 2026-W48. Nothing was read.`,
    )
  }
  return range
}

interface TaskRow {
  id: string
  parent_id: string | null
  project_id: string
  key: string | null
  title: string
  assignee_id: string | null
  timebox: number | null
  start_date: string | null
  due_date: string | null
  closed: boolean
}

interface PersonRow {
  id: string
  name: string
  status: string
}

function weekdays(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addCalendarDays(d, 1)) if (isoWeekdayOf(d) <= 5) out.push(d)
  return out
}

/** Timeboxed tasks with no timeboxed live task under them: a milestone's box never adds. */
function leafTimeboxed(rows: readonly TaskRow[]): TaskRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const hasBoxedBelow = new Set<string>()
  for (const r of rows) {
    if (r.timebox === null) continue
    let p = r.parent_id
    const seen = new Set<string>()
    while (p && byId.has(p) && !seen.has(p)) {
      seen.add(p)
      hasBoxedBelow.add(p)
      p = byId.get(p)?.parent_id ?? null
    }
  }
  return rows.filter((r) => r.timebox !== null && !hasBoxedBelow.has(r.id))
}

export async function getCapacity(args: {
  tx: Tx
  orgId: string
  week?: string
  taskId?: string
  now?: Date
  /** Internal callers only: each task also names its project. Never set from a tool. */
  withProjects?: boolean
}): Promise<CapacityResult> {
  const { tx, orgId } = args
  const tz = await orgTimezone(tx, orgId)
  const today = todayIn(tz, args.now)
  const currentWeek = isoWeekOf(today)
  const week = args.week ?? currentWeek
  const { from, to } = weekRange(week)
  const pastWeek = to < weekRange(currentWeek).from

  const rows = extractRows<TaskRow>(
    await tx.execute(drizzleSql`
      SELECT t.id::text AS id, t.parent_task_id::text AS parent_id, t.project_id::text AS project_id,
             CASE WHEN p.key IS NOT NULL THEN p.key || '-' || t.number::text END AS key,
             t.title, t.assignee_id::text AS assignee_id, t.timebox_minutes AS timebox,
             t.start_date::text AS start_date, t.due_date::text AS due_date,
             (t.completed_at IS NOT NULL OR COALESCE(s.terminal, false)) AS closed
        FROM ${projectsRel("tasks")} t
        JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
        LEFT JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id
       WHERE t.org_id = ${orgId}::uuid AND t.archived_at IS NULL
         AND p.time_budgets_on AND p.kind = 'work' AND p.archived_at IS NULL`),
  )
  const counted = leafTimeboxed(rows).filter((r) => r.assignee_id !== null)

  const dayOffRows = extractRows<{ starts_on: string; ends_on: string; yearly: boolean }>(
    await tx.execute(drizzleSql`
      SELECT starts_on::text AS starts_on, ends_on::text AS ends_on, recurs_yearly AS yearly
        FROM ${projectsRel("days_off")} WHERE org_id = ${orgId}::uuid`),
  ).map((r) => ({ startsOn: r.starts_on, endsOn: r.ends_on, yearly: r.yearly }))

  const assignees = [...new Set(counted.map((r) => r.assignee_id as string))]
  const people = new Map(
    (assignees.length === 0
      ? []
      : extractRows<PersonRow>(
          await tx.execute(drizzleSql`
            SELECT id::text AS id, name, status::text AS status FROM ${kernelRel("users")}
             WHERE org_id = ${orgId}::uuid AND id IN (${drizzleSql.join(
               assignees.map((id) => drizzleSql`${id}::uuid`),
               drizzleSql`, `,
             )})`),
        )
    ).map((p) => [p.id, p]),
  )
  const active = assignees.filter((id) => people.get(id)?.status === "active")

  // Placement reads a span's working days, so company days off and away days are read across
  // the whole of every span that reaches this week.
  let spanFrom = from
  let spanTo = to
  for (const r of counted) {
    if (r.start_date && r.due_date && r.start_date <= r.due_date) {
      if (r.start_date < spanFrom) spanFrom = r.start_date
      if (r.due_date > spanTo) spanTo = r.due_date
    }
  }
  const companyOff = new Set(expandDaysOff(dayOffRows, spanFrom, spanTo))
  const away = await awayDays(orgId, active, spanFrom, spanTo)
  const working = (userId: string, a: string, b: string) => {
    const off = new Set(away.get(userId) ?? [])
    return weekdays(a, b).filter((d) => !companyOff.has(d) && !off.has(d))
  }

  /** The minutes of a task that fall in this week, by C5's placement rule. */
  const inWeek = (r: TaskRow): number => {
    const box = r.timebox ?? 0
    if (r.start_date && r.due_date && r.start_date <= r.due_date) {
      const span = working(r.assignee_id as string, r.start_date, r.due_date)
      if (span.length > 0)
        return (box * span.filter((d) => d >= from && d <= to).length) / span.length
      return r.due_date >= from && r.due_date <= to ? box : 0
    }
    if (r.due_date) return r.due_date >= from && r.due_date <= to ? box : 0
    return week === currentWeek ? box : 0
  }
  /** Whether a task still lies ahead of this week's start (or in it), for who is on the list. */
  const ahead = (r: TaskRow): boolean => {
    if (r.closed) return false
    const end = r.due_date ?? (r.start_date && r.start_date > today ? r.start_date : today)
    return end >= from
  }

  const hpd = await hoursPerDayMinutes(tx, orgId)
  const perWeek = new Map(
    (active.length === 0
      ? []
      : extractRows<{ user_id: string; d: number }>(
          await tx.execute(drizzleSql`
            SELECT user_id::text AS user_id, days_per_week AS d FROM ${projectsRel("person_capacity")}
             WHERE org_id = ${orgId}::uuid AND user_id IN (${drizzleSql.join(
               active.map((id) => drizzleSql`${id}::uuid`),
               drizzleSql`, `,
             )})`),
        )
    ).map((r) => [r.user_id, Number(r.d)]),
  )
  const availableOf = (userId: string) =>
    Math.min(perWeek.get(userId) ?? 5, working(userId, from, to).length) * hpd

  const live = counted.filter((r) => pastWeek || !r.closed)
  const out: CapacityPerson[] = []
  for (const userId of active) {
    const mine = counted.filter((r) => r.assignee_id === userId)
    if (!mine.some(ahead)) continue
    const tasks = live
      .filter((r) => r.assignee_id === userId)
      .map((r) => ({
        id: r.id,
        key: r.key,
        title: r.title,
        minutes: inWeek(r),
        ...(args.withProjects ? { projectId: r.project_id } : {}),
      }))
      .filter((t) => t.minutes > 0)
    const planned = Math.round(tasks.reduce((s, t) => s + t.minutes, 0))
    const available = availableOf(userId)
    out.push({
      userId,
      name: people.get(userId)?.name ?? "",
      availableMinutes: available,
      plannedMinutes: planned,
      note: overNote(planned, available),
      tasks: tasks.map((t) => ({ ...t, minutes: Math.round(t.minutes) })),
    })
  }
  out.sort((a, b) => collator.compare(a.name, b.name) || a.userId.localeCompare(b.userId))

  const left = live
    .filter((r) => !active.includes(r.assignee_id as string))
    .map((r) => ({ id: r.id, key: r.key, title: r.title, minutes: Math.round(inWeek(r)) }))
    .filter((t) => t.minutes > 0)

  const availableMinutes = out.reduce((s, p) => s + p.availableMinutes, 0)
  const plannedMinutes = out.reduce((s, p) => s + p.plannedMinutes, 0)
  const over = out.filter((p) => p.plannedMinutes - p.availableMinutes > 180).length
  const hours = (m: number) => `${Math.round((m / 60) * 10) / 10} h`
  const groups: CapacityResult["groups"] = [
    {
      label: "People",
      rows: out.map((p) => ({
        id: p.userId,
        name: p.name,
        plannedMinutes: p.plannedMinutes,
        availableMinutes: p.availableMinutes,
        ...(p.note ? { note: p.note } : {}),
      })),
    },
  ]
  if (left.length > 0) {
    groups.push({
      label: "Assigned to people who have left",
      rows: left.map((t, i) => ({
        id: t.key ?? `left-${i}`,
        name: t.key ? `${t.key} ${t.title}` : t.title,
        plannedMinutes: t.minutes,
      })),
    })
  }
  const result: CapacityResult = {
    title: `Capacity, week ${Number(week.slice(6))} (${from} to ${to})`,
    groups,
    totals: [
      { k: "Planned", text: hours(out.reduce((s, p) => s + p.plannedMinutes, 0)) },
      { k: "Available", text: hours(out.reduce((s, p) => s + p.availableMinutes, 0)) },
    ],
    week,
    from,
    to,
    availableMinutes,
    plannedMinutes,
    people: out,
    left,
    overLine:
      over === 0
        ? null
        : over === 1
          ? "1 person has more than fits"
          : `${over} people have more than fits`,
    covers:
      "Planned time from timeboxes on projects that use time and budgets; available time from hours in a day, days per week, company days off and away days. Nothing here comes from time entered or from activity.",
  }
  if (out.length === 0 && left.length === 0) {
    result.nothingPlanned = await nothingPlannedLine(tx, orgId, week, from, to)
  }
  if (args.taskId) {
    // A key ("ATLAS-3") or an id; anything else is refused by name, never a raw cast error.
    const taskId = await resolveTaskRef(tx, orgId, String(args.taskId).trim())
    result.taskId = taskId
    result.candidates = await candidatesFor(tx, orgId, taskId, out, rows)
  }
  return result
}

/** The answer for a week where nobody has planned work, with how time gets planned. */
async function nothingPlannedLine(
  tx: Tx,
  orgId: string,
  week: string,
  from: string,
  to: string,
): Promise<string> {
  const projects = Number(
    extractRows<{ n: number }>(
      await tx.execute(drizzleSql`
        SELECT count(*)::int AS n FROM ${projectsRel("projects")}
         WHERE org_id = ${orgId}::uuid AND time_budgets_on AND kind = 'work' AND archived_at IS NULL`),
    )[0]?.n ?? 0,
  )
  const label = `week ${Number(week.slice(6))} (${from} to ${to})`
  const how =
    "Time is planned by giving a task a timebox and an assignee, with a due date or dates in the week (a task with no dates counts in the current week)."
  if (projects === 0) {
    return `Nobody has planned work in ${label}: no project uses time and budgets yet, and planned time exists only there. Time and budgets are switched on in a project's settings. ${how}`
  }
  const which =
    projects === 1
      ? "the 1 project that uses time and budgets"
      : `the ${projects} projects that use time and budgets`
  return `Nobody has planned work in ${label}: no task on ${which} has a timebox and an assignee in that week, so this says nothing yet about who has room. Each person's available time is their hours in a day and days per week, less company days off and away days. ${how}`
}

/** "Who can take this?": people with enough free time, those already on the project first. */
async function candidatesFor(
  tx: Tx,
  orgId: string,
  taskId: string,
  people: readonly CapacityPerson[],
  rows: readonly TaskRow[],
): Promise<CapacityCandidate[]> {
  const task = extractRows<{ project_id: string; timebox: number | null; owner_id: string | null }>(
    await tx.execute(drizzleSql`
      SELECT t.project_id::text AS project_id, t.timebox_minutes AS timebox, p.owner_id::text AS owner_id
        FROM ${projectsRel("tasks")} t
        JOIN ${projectsRel("projects")} p ON p.id = t.project_id AND p.org_id = t.org_id
       WHERE t.org_id = ${orgId}::uuid AND t.id = ${taskId}::uuid LIMIT 1`),
  )[0]
  if (!task) throw new ProjectsServiceError(404, "not_found", `Task ${taskId} was not found.`)
  const onProject = new Set(
    rows.filter((r) => r.project_id === task.project_id && r.assignee_id).map((r) => r.assignee_id),
  )
  if (task.owner_id) onProject.add(task.owner_id)
  const need = task.timebox ?? 0
  const fits = people
    .map((p) => ({
      userId: p.userId,
      name: p.name,
      freeMinutes: p.availableMinutes - p.plannedMinutes,
      onProject: onProject.has(p.userId),
    }))
    .filter((c) => c.freeMinutes > 0 && c.freeMinutes >= need)
  return [...fits.filter((c) => c.onProject), ...fits.filter((c) => !c.onProject)]
}
