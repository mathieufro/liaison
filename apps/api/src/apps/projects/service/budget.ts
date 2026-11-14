// SPDX-License-Identifier: FSL-1.1-ALv2
// `budget_get`: one project's planned time against its real time, with the coverage that makes
// "real" honest. Everything is read under the asker's own row security; the totals come from
// `task_time_totals`, which has no person column, so no figure here can name anyone.
import { sql as drizzleSql } from "drizzle-orm"
import { projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type RlsClient } from "~/db"
import { hasScope } from "~/modules/permissions/permissions"
import {
  type BudgetTask,
  type Coverage,
  coverageOf,
  liveTasks,
  plannedByTask,
  plannedOfLine,
  realByTask,
} from "./coverage"
import {
  type Basis,
  hoursPerDayMinutes,
  loadPlanningProject,
  orgTimezone,
  requirePlanning,
} from "./time-plan"
import { todayIn } from "./took"

type Tx = RlsClient

const CARD_ROWS_MAX = 40
export const MONEY_READ_SCOPE = "projects:money:read"
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

export interface BudgetMilestone {
  id: string
  name: string
  state: "todo" | "started" | "done"
  plannedMinutes?: number
  realMinutes: number
}

export interface BudgetRate {
  rate: number
  per: "day" | "hour"
  currency: string | null
}

export interface BudgetResult {
  projectId: string
  projectName: string
  /** The one plain line, in the project's own unit. */
  line: string
  /** Minutes. Absent when nothing is planned to compare with. */
  timebox?: number
  real: number
  left?: number
  partial: boolean
  coverage: Coverage
  /** A fixed price, or the rate of a project billed by the day or by the hour. */
  money?: { price: number; currency: string | null } | BudgetRate
  state?: "hours-only"
  milestones: BudgetMilestone[]
  notInNumbers: Array<{ text: string }>
  offUntil?: string
  datedHours: boolean
  /** The card's own reading of the above: one group of milestone rows and the totals. */
  groups: Array<{ label: string; rows: BudgetMilestone[] }>
  totals: Array<{ k: string; text: string }>
}

const trim = (n: number): string => String(Math.round(n * 10) / 10)

function plainDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  return `${d} ${MONTHS[(m ?? 1) - 1]?.slice(0, 3)} ${y}`
}

function periodLabel(start: string, end: string): string {
  const [y, m, d] = start.split("-").map(Number)
  const last = new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate()
  if (d === 1 && end === `${start.slice(0, 8)}${String(last).padStart(2, "0")}`) {
    return MONTHS[(m ?? 1) - 1] ?? start
  }
  return `${plainDate(start)} to ${plainDate(end)}`
}

function money(amount: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: currency ?? "EUR",
    }).format(amount)
  } catch {
    return `${amount} ${currency ?? ""}`.trim()
  }
}

interface TaskRow {
  id: string
  parent_id: string | null
  title: string
  position: number
  number: number
  timebox_minutes: number | null
  is_milestone: boolean
  archived: boolean
  closed: boolean
  started: boolean
  completed_at: string | null
  /** The day it closed, in the org's zone. */
  closed_on: string | null
}

/**
 * The project's tasks with what coverage needs. A task is started once it is past the first
 * column (the default board's backlog and todo count as not started) and closed in a done
 * column; one in a cancelled column is in neither, so it never lowers coverage.
 */
async function readTasks(tx: Tx, orgId: string, projectId: string, tz: string) {
  return extractRows<TaskRow>(
    await tx.execute(drizzleSql`
      SELECT t.id::text AS id, t.parent_task_id::text AS parent_id, t.title, t.position,
             t.number, t.timebox_minutes, t.is_milestone,
             t.archived_at IS NOT NULL AS archived,
             (NOT cancelled.is AND (t.completed_at IS NOT NULL OR s.terminal)) AS closed,
             (NOT cancelled.is AND (t.completed_at IS NOT NULL OR s.terminal
              OR (s."order" > (SELECT min(s2."order") FROM ${projectsRel("project_statuses")} s2
                                WHERE s2.project_id = t.project_id)
                  AND lower(s.label) NOT IN ('backlog', 'todo', 'to do')))) AS started,
             CASE WHEN NOT cancelled.is AND (t.completed_at IS NOT NULL OR s.terminal)
                  THEN coalesce(t.completed_at, t.updated_at)::text END AS completed_at,
             CASE WHEN NOT cancelled.is AND (t.completed_at IS NOT NULL OR s.terminal)
                  THEN (coalesce(t.completed_at, t.updated_at) AT TIME ZONE ${tz})::date::text
             END AS closed_on
        FROM ${projectsRel("tasks")} t
        JOIN ${projectsRel("project_statuses")} s ON s.id = t.status_id
        CROSS JOIN LATERAL (SELECT lower(s.label) IN ('cancelled', 'canceled') AS is) cancelled
       WHERE t.project_id = ${projectId}::uuid AND t.org_id = ${orgId}::uuid`),
  )
}

/** The unit a project reads in: days for a project billed by the day, hours otherwise. */
function unitOf(basis: Basis, hpd: number) {
  const per = basis === "daily" ? hpd : 60
  const unit = basis === "daily" ? "d" : "h"
  return (minutes: number) => `${trim(minutes / per)} ${unit}`
}

export async function getBudget(args: {
  tx: Tx
  orgId: string
  scopes: readonly string[]
  projectId: string
  now?: Date
}): Promise<BudgetResult> {
  const { tx, orgId, scopes, projectId } = args
  const project = await loadPlanningProject(tx, orgId, projectId)
  requirePlanning(orgId, project, scopes)
  const tz = await orgTimezone(tx, orgId)
  const today = todayIn(tz, args.now)
  const hpd = await hoursPerDayMinutes(tx, orgId)

  const plan = extractRows<{
    basis: Basis
    timebox_minutes: number | null
    dated_hours: boolean
    changed_at: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT coalesce(tp.basis, 'none') AS basis, tp.timebox_minutes,
             coalesce(tp.dated_hours, false) AS dated_hours,
             p.time_budgets_changed_at::text AS changed_at
        FROM ${projectsRel("projects")} p
        LEFT JOIN ${projectsRel("project_time_plan")} tp ON tp.project_id = p.id
       WHERE p.id = ${projectId}::uuid AND p.org_id = ${orgId}::uuid`),
  )[0] ?? { basis: "none" as Basis, timebox_minutes: null, dated_hours: false, changed_at: null }
  const basis = plan.basis

  // A retainer or a project billed by the day reads the period it is in; its real time is that
  // period's too.
  const period =
    basis === "retainer" || basis === "daily"
      ? extractRows<{ minutes: number; start: string; end: string }>(
          await tx.execute(drizzleSql`
            SELECT minutes, period_start::text AS start, period_end::text AS "end"
              FROM ${projectsRel("project_timeboxes")}
             WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid
               AND period_start <= ${today}::date AND period_end >= ${today}::date
             ORDER BY period_start DESC LIMIT 1`),
        )[0]
      : undefined

  const rows = await readTasks(tx, orgId, projectId, tz)
  const tasks: BudgetTask[] = rows.map((r) => ({
    id: r.id,
    parentId: r.parent_id,
    name: r.title,
    position: r.position,
    number: r.number,
    timebox: r.timebox_minutes,
    isMilestone: r.is_milestone,
    archived: r.archived,
    closed: r.closed,
    started: r.started,
  }))
  const live = liveTasks(tasks)
  const liveIds = new Set(live.map((t) => t.id))

  const totals = extractRows<{ task_id: string; minutes: string | number; has_entries: boolean }>(
    await tx.execute(drizzleSql`
      SELECT task_id::text AS task_id, minutes, has_entries
        FROM ${projectsRel("task_time_totals")}(${projectId}::uuid,
          ${period ? drizzleSql`${period.start}::date` : drizzleSql`NULL::date`},
          ${period ? drizzleSql`${period.end}::date` : drizzleSql`NULL::date`})`),
  )
  const own = new Map<string, number>()
  const hasEntries = new Set<string>()
  let archivedMinutes = 0
  for (const r of totals) {
    const m = Number(r.minutes)
    if (!liveIds.has(r.task_id)) {
      archivedMinutes += m
      continue
    }
    own.set(r.task_id, m)
    if (r.has_entries) hasEntries.add(r.task_id)
  }
  const real = [...own.values()].reduce((a, b) => a + b, 0)
  // A period's figures count the period's tasks: those closed in it or holding time of it, as
  // the dated sheet counts them. Without a period, every started or closed task.
  const closedOn = new Map(rows.map((r) => [r.id, r.closed_on]))
  const coverage = coverageOf(
    period
      ? live.map((t) => {
          const on = closedOn.get(t.id)
          return {
            ...t,
            closed: !!on && on >= period.start && on <= period.end,
            started: hasEntries.has(t.id),
          }
        })
      : live,
    hasEntries,
  )
  const partial = coverage.withEntries < coverage.total

  const planned = plannedByTask(live)
  const realOf = realByTask(live, own)
  const plannedLine = period
    ? period.minutes
    : (plan.timebox_minutes ?? (plannedOfLine(live) > 0 ? plannedOfLine(live) : null))

  const milestoneState = (t: BudgetTask) => (t.closed ? "done" : t.started ? "started" : "todo")
  const milestones: BudgetMilestone[] = live
    .filter((t) => t.isMilestone)
    // In plan order: the order the project's tasks were numbered in. A board position only
    // orders a status column, so it cannot order milestones across columns.
    .sort((a, b) => a.number - b.number)
    .map((t) => {
      const p = planned.get(t.id) ?? 0
      return {
        id: t.id,
        name: t.name,
        state: milestoneState(t),
        ...(p > 0 ? { plannedMinutes: p } : {}),
        realMinutes: realOf.get(t.id) ?? 0,
      }
    })

  const fmt = unitOf(basis, hpd)
  // What a person reading the figures should know is not in them.
  const notInNumbers: Array<{ text: string }> = []
  const changed = plan.changed_at ? new Date(plan.changed_at) : null
  let offUntil: string | undefined
  if (
    changed &&
    rows.some((r) => !r.archived && r.completed_at && new Date(r.completed_at) < changed)
  ) {
    offUntil = todayIn(tz, changed)
    notInNumbers.push({
      text: `This project did not use time and budgets until ${plainDate(offUntil)}, so earlier tasks may have no time spent.`,
    })
  }
  if (archivedMinutes > 0) {
    notInNumbers.push({
      text: `${fmt(archivedMinutes)} entered on archived tasks is not counted. It returns if the task does.`,
    })
  }

  // The one line.
  const coverText = `real time entered on ${coverage.withEntries} of ${coverage.total} tasks`
  const tail = partial ? ` Partial: ${coverText}.` : ""
  let line: string
  if (period && plannedLine !== null) {
    const per = basis === "daily" ? hpd : 60
    const u = basis === "daily" ? "d" : "h"
    line = `${periodLabel(period.start, period.end)} so far ${trim(real / per)} of ${trim(plannedLine / per)} ${u}.${tail}`
  } else if (plannedLine === null) {
    line = `Nothing to compare: no timebox is set. ${fmt(real)} real so far.${tail}`
  } else if (real > plannedLine) {
    line = `${fmt(real)} real against a ${fmt(plannedLine)} timebox, ${fmt(real - plannedLine)} over.${
      basis === "fixed" ? " The price does not change." : ""
    }${tail}`
  } else {
    line = `${fmt(real)} real of ${fmt(plannedLine)} planned, ${fmt(plannedLine - real)} left.${tail}`
  }

  // Money: the keys exist only for a holder of the money scope (row security says the same).
  const canMoney = hasScope(MONEY_READ_SCOPE, [...scopes])
  let moneyOut: BudgetResult["money"]
  if (canMoney) {
    const terms = extractRows<{
      price: string | number | null
      rate: string | number | null
      currency: string | null
    }>(
      await tx.execute(drizzleSql`
        SELECT fixed_price_minor AS price, rate_minor AS rate, currency
          FROM ${projectsRel("project_billing_terms")}
         WHERE project_id = ${projectId}::uuid AND org_id = ${orgId}::uuid`),
    )[0]
    // A project billed by the day or the hour has a rate, not a price: it is shown as such.
    const per = basis === "daily" ? "day" : basis === "hourly" ? "hour" : null
    if (per && terms?.rate !== null && terms?.rate !== undefined) {
      moneyOut = { rate: Number(terms.rate) / 100, per, currency: terms.currency }
    } else if (terms?.price !== null && terms?.price !== undefined) {
      moneyOut = { price: Number(terms.price) / 100, currency: terms.currency }
    }
  }

  // A card holds at most 40 rows; the rest are in `milestones`.
  const cardRows = milestones.slice(0, CARD_ROWS_MAX)
  if (milestones.length > CARD_ROWS_MAX) {
    notInNumbers.push({
      text: `The card shows the first ${CARD_ROWS_MAX} of ${milestones.length} milestones.`,
    })
  }

  const totalsOut: Array<{ k: string; text: string }> = []
  if (plannedLine !== null) totalsOut.push({ k: "Planned", text: fmt(plannedLine) })
  totalsOut.push({ k: "Real", text: fmt(real) })
  if (plannedLine !== null) totalsOut.push({ k: "Left", text: fmt(plannedLine - real) })
  if (moneyOut && "rate" in moneyOut) {
    totalsOut.push({
      k: "Rate",
      text: `${money(moneyOut.rate, moneyOut.currency)} a${moneyOut.per === "hour" ? "n" : ""} ${moneyOut.per}`,
    })
  } else if (moneyOut) {
    totalsOut.push({ k: "Price", text: money(moneyOut.price, moneyOut.currency) })
  }

  return {
    projectId,
    projectName: project.name,
    line,
    ...(plannedLine !== null ? { timebox: plannedLine, left: plannedLine - real } : {}),
    real,
    partial,
    coverage,
    ...(moneyOut ? { money: moneyOut } : {}),
    ...(canMoney ? {} : { state: "hours-only" as const }),
    milestones,
    notInNumbers,
    ...(offUntil ? { offUntil } : {}),
    datedHours: plan.dated_hours,
    groups: cardRows.length > 0 ? [{ label: "Milestones", rows: cardRows }] : [],
    totals: totalsOut,
  }
}
