// SPDX-License-Identifier: FSL-1.1-ALv2
// The dated sheet of one project and month: who took how long on which task, day by day. It
// exists only on a project that uses time and budgets with dated hours on, and only for the
// project's lead and an exact holder of the timesheet scope; everyone else is refused before
// anything is read. It shows the rows entered on the sheet (after dated hours were last turned
// on), read under the asker's own row security, which says the same thing. Read only: no
// input, no reminder, no list of who has not entered, and it never calls itself a legal record.
import { csvCell, formatDuration } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import type { UserContext } from "~/db/rls"
import { type Coverage, coverageOf, liveTasks } from "./coverage"
import { resolvePeriod } from "./reconcile-lines"
import { ProjectsServiceError } from "./statuses"
import {
  loadPlanningProject,
  orgTimezone,
  requirePlanning,
  TIMESHEET_READ_SCOPE,
} from "./time-plan"
import { todayIn } from "./took"

type Tx = RlsClient

export { TIMESHEET_READ_SCOPE }

/** What the sheet says about itself, on screen, in the PDF and in the CSV. */
export const NOT_A_RECORD = "Not a legal working-time record, and it reminds nobody of anything."

/** A line whose person was removed after the retention period. */
const NO_NAME_KEPT = "No name kept"

export interface TimesheetLine {
  entryId: string
  date: string
  person: string
  taskId: string
  taskKey: string | null
  task: string
  minutes: number
  hours: string
}

export interface Timesheet {
  projectId: string
  projectName: string
  month: string
  period: { from: string; to: string; label: string }
  lines: TimesheetLine[]
  totalMinutes: number
  total: string
  coverage: Coverage
  partial: boolean
  coverageLine: string
  note: string
  message: string
}

const hours = (minutes: number) => formatDuration(minutes, "h")

function refuse(message: string, next: string): never {
  throw new ProjectsServiceError(403, "not_allowed", message, { next })
}

/**
 * The sheet of `projectId` for `month` (YYYY-MM, default this month in the org's zone).
 * Refuses `planning_off` when the project does not use time and budgets, `dated_hours_off` when
 * it has no dated hours, and `not_allowed` when the asker is neither its lead nor a timesheet reader.
 */
export async function getTimesheet(args: {
  tx: Tx
  orgId: string
  userId: string
  scopes: readonly string[]
  projectId: string
  month?: string
  now?: Date
}): Promise<Timesheet> {
  const { tx, orgId, userId, scopes, projectId } = args
  const project = await loadPlanningProject(tx, orgId, projectId)
  requirePlanning(orgId, project, scopes)
  const head = extractRows<{ owner_id: string | null; dated: boolean }>(
    await tx.execute(drizzleSql`
      SELECT p.owner_id::text AS owner_id, coalesce(tp.dated_hours, false) AS dated
        FROM ${projectsRel("projects")} p
        LEFT JOIN ${projectsRel("project_time_plan")} tp
          ON tp.project_id = p.id AND tp.org_id = p.org_id
       WHERE p.id = ${projectId}::uuid AND p.org_id = ${orgId}::uuid`),
  )[0]
  if (!head?.dated) {
    throw new ProjectsServiceError(
      403,
      "dated_hours_off",
      `${project.name} has no dated sheet: dated hours are off, so its time stays with each person. Nothing is shown.`,
      {
        next: "Dated hours are turned on with the Dated hours switch in the project's budget panel; entries made before stay private.",
      },
    )
  }
  if (head.owner_id !== userId && !scopes.includes(TIMESHEET_READ_SCOPE)) {
    refuse(
      `Only the lead of ${project.name} and finance read its dated sheet. Nothing is shown.`,
      "The project's total time is in its budget.",
    )
  }
  const tz = await orgTimezone(tx, orgId)
  const period = resolvePeriod(
    args.month !== undefined ? { month: args.month } : {},
    todayIn(tz, args.now),
  )
  if (!period.month) {
    throw new ProjectsServiceError(400, "invalid_period", "month must be written YYYY-MM.")
  }

  const rows = extractRows<{
    id: string
    date: string
    minutes: number
    person: string | null
    task_id: string
    task_key: string | null
    task: string
  }>(
    await tx.execute(drizzleSql`
      SELECT tt.id::text AS id, tt.work_date::text AS date, tt.minutes, u.name AS person,
             tt.task_id::text AS task_id,
             CASE WHEN pr.key IS NOT NULL THEN pr.key || '-' || t.number::text END AS task_key,
             t.title AS task
        FROM ${projectsRel("task_time")} tt
        JOIN ${projectsRel("project_time_plan")} tp
          ON tp.project_id = tt.project_id AND tp.org_id = tt.org_id
        JOIN ${projectsRel("projects")} pr ON pr.id = tt.project_id AND pr.org_id = tt.org_id
        JOIN ${projectsRel("tasks")} t ON t.id = tt.task_id AND t.org_id = tt.org_id
        LEFT JOIN ${kernelRel("users")} u ON u.id = tt.user_id AND u.org_id = tt.org_id
       WHERE tt.org_id = ${orgId}::uuid AND tt.project_id = ${projectId}::uuid
         AND tt.work_date >= ${period.from}::date AND tt.work_date <= ${period.to}::date
         AND tt.entered_dated AND tt.created_at >= tp.dated_hours_changed_at`),
  )
  const collator = new Intl.Collator("en", { sensitivity: "base" })
  const lines: TimesheetLine[] = rows
    .map((r) => ({
      entryId: r.id,
      date: r.date,
      person: r.person ?? NO_NAME_KEPT,
      taskId: r.task_id,
      taskKey: r.task_key,
      task: r.task,
      minutes: r.minutes,
      hours: hours(r.minutes),
    }))
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        collator.compare(a.person, b.person) ||
        (a.taskKey ?? a.task).localeCompare(b.taskKey ?? b.task, "en", { numeric: true }),
    )
  const totalMinutes = lines.reduce((sum, l) => sum + l.minutes, 0)

  // Coverage: the month's tasks are the live leaf tasks closed in it (in the org's zone) or
  // holding a line of it; it counts tasks, never people.
  const tasks = extractRows<{
    id: string
    parent_id: string | null
    position: number
    number: number
    title: string
    archived: boolean
    closed_on: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT t.id::text AS id, t.parent_task_id::text AS parent_id, t.position, t.number,
             t.title, t.archived_at IS NOT NULL AS archived,
             CASE WHEN lower(s.label) NOT IN ('cancelled', 'canceled')
                       AND (t.completed_at IS NOT NULL OR s.terminal)
                  THEN (coalesce(t.completed_at, t.updated_at) AT TIME ZONE ${tz})::date::text
             END AS closed_on
        FROM ${projectsRel("tasks")} t
        JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id
       WHERE t.project_id = ${projectId}::uuid AND t.org_id = ${orgId}::uuid`),
  )
  const withLines = new Set(lines.map((l) => l.taskId))
  const live = liveTasks(
    tasks.map((t) => ({
      id: t.id,
      parentId: t.parent_id,
      name: t.title,
      position: t.position,
      number: t.number,
      timebox: null,
      isMilestone: false,
      archived: t.archived,
      closed: t.closed_on !== null && t.closed_on >= period.from && t.closed_on <= period.to,
      started: withLines.has(t.id),
    })),
  )
  const coverage = coverageOf(live, withLines)
  const partial = coverage.withEntries < coverage.total
  const coverageLine = `Real time entered on ${coverage.withEntries} of ${coverage.total} tasks of ${period.label}${partial ? ", partial" : ""}.`
  const total = hours(totalMinutes)
  return {
    projectId,
    projectName: project.name,
    month: period.month,
    period: { from: period.from, to: period.to, label: period.label },
    lines,
    totalMinutes,
    total,
    coverage,
    partial,
    coverageLine,
    note: NOT_A_RECORD,
    message:
      lines.length === 0
        ? `${project.name}, ${period.label}: no line on the dated sheet.`
        : `${project.name}, ${period.label}: ${lines.length} line${lines.length === 1 ? "" : "s"}, ${total} in all. ${coverageLine}`,
  }
}

// ── Export ──────────────────────────────────────────────────────────────────

export type TimesheetFormat = "pdf" | "csv"

/**
 * The sheet as CSV: the coverage line first, then the header, the lines and the total. Cells go
 * through the shared escaper, so a title or a name that starts like a formula stays text.
 */
export function timesheetCsv(sheet: Timesheet): string {
  const out: string[][] = [
    [sheet.coverageLine],
    ["Date", "Person", "Task", "Hours"],
    ...sheet.lines.map((l) => [
      l.date,
      l.person,
      l.taskKey ? `${l.taskKey} ${l.task}` : l.task,
      String(Math.round((l.minutes / 60) * 100) / 100),
    ]),
    ["Total", "", "", String(Math.round((sheet.totalMinutes / 60) * 100) / 100)],
    [sheet.note],
  ]
  return `${out.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`
}

/** The sheet as a PDF: title, the coverage line and the note on the first page, then the lines. */
export async function timesheetPdf(sheet: Timesheet): Promise<Uint8Array> {
  const { renderRichText } = await import("~/modules/documents/rich-text")
  const record: Record<string, unknown> = {
    h: {
      title: `${sheet.projectName}, dated hours, ${sheet.period.label}`,
      coverage: sheet.coverageLine,
      note: sheet.note,
      total: `Total: ${sheet.total}`,
    },
    rows: sheet.lines.map((l) => ({
      d: l.date,
      p: l.person,
      t: l.taskKey ? `${l.taskKey} ${l.task}` : l.task,
      h: l.hours,
    })),
  }
  const body: Record<string, unknown>[] = [
    { type: "heading", level: 1, text: "{{h.title ??}}" },
    { type: "paragraph", text: "{{h.coverage ??}}" },
    { type: "paragraph", size: 8, text: "{{h.note ??}}" },
    { type: "spacer", height: 8 },
  ]
  if (sheet.lines.length > 0) {
    body.push({
      type: "table",
      from: "rows",
      size: 8,
      columns: [
        { header: "Date", text: "{{d ??}}" },
        { header: "Person", text: "{{p ??}}" },
        { header: "Task", text: "{{t ??}}" },
        { header: "Hours", text: "{{h ??}}" },
      ],
    })
  }
  body.push({ type: "paragraph", text: "{{h.total ??}}" })
  const out = await renderRichText({
    body: { page: { size: "A4" }, blocks: body },
    record,
    labelOf: (path: string) => path,
    resolveImage: async () => null,
    title: `${sheet.projectName}, dated hours, ${sheet.period.label}`,
  })
  return out.bytes
}

export function timesheetFilename(sheet: Timesheet, format: TimesheetFormat): string {
  const base = `${sheet.projectName} dated hours ${sheet.month}`
    .replace(/[^\p{L}\p{N} _-]+/gu, "")
    .trim()
    .replace(/\s+/g, "-")
  return `${base || "dated-hours"}.${format}`
}

/**
 * `timesheet_export`: the sheet as a PDF or CSV file only the caller reads. A partial sheet
 * answers `needsConfirm` with its coverage until the caller says `acceptPartial`, and the file
 * then carries the coverage line on its first page or row. Refusals are `getTimesheet`'s.
 */
export async function exportTimesheet(args: {
  tx: Tx
  viewer: UserContext
  scopes: readonly string[]
  projectId: string
  month?: string
  format: string | undefined
  acceptPartial: boolean
  now?: Date
}): Promise<Record<string, unknown>> {
  const format = args.format
  if (format !== "pdf" && format !== "csv") {
    throw new ProjectsServiceError(
      400,
      "invalid_format",
      "format must be pdf or csv. Nothing was made.",
      {
        next: "Call again with format pdf or csv.",
      },
    )
  }
  const sheet = await getTimesheet({
    tx: args.tx,
    orgId: args.viewer.orgId,
    userId: args.viewer.userId,
    scopes: args.scopes,
    projectId: args.projectId,
    ...(args.month !== undefined ? { month: args.month } : {}),
    ...(args.now ? { now: args.now } : {}),
  })
  if (sheet.partial && !args.acceptPartial) {
    return {
      needsConfirm: true,
      coverage: sheet.coverage,
      coverageLine: sheet.coverageLine,
      message: `No file was made: the ${sheet.period.label} sheet of ${sheet.projectName} is partial. ${sheet.coverageLine}`,
      next: "Ask the person once whether to export it as it is; if yes, call again with acceptPartial: true. The file then carries the coverage line.",
    }
  }
  const bytes =
    format === "pdf" ? await timesheetPdf(sheet) : new TextEncoder().encode(timesheetCsv(sheet))
  const { stagePdfForViewer, StorageFullError } = await import("~/modules/dashboards/export")
  const filename = timesheetFilename(sheet, format)
  try {
    const file = await stagePdfForViewer(args.viewer, bytes, filename, {
      mimeType: format === "pdf" ? "application/pdf" : "text/csv",
      purpose: "timesheet_export",
    })
    return {
      ...file,
      format,
      lines: sheet.lines.length,
      totalMinutes: sheet.totalMinutes,
      total: sheet.total,
      partial: sheet.partial,
      coverageLine: sheet.coverageLine,
      message: `Made ${filename}: ${sheet.lines.length} line${sheet.lines.length === 1 ? "" : "s"}, ${sheet.total}, for you only. ${sheet.coverageLine}`,
      next: "Attach the file to your reply, or to a message to the client.",
    }
  } catch (err) {
    if (err instanceof StorageFullError) {
      throw new ProjectsServiceError(
        413,
        "storage_quota_exceeded",
        `${err.message}. No file was made.`,
      )
    }
    throw err
  }
}
