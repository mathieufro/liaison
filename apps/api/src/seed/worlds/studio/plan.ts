// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `studio` world's plan for time and budgets: its seven projects, their
// 120 tasks with milestones, timeboxes and due dates, the time people took,
// the project timeboxes per period, billing terms, cost rates, hours in a day
// and who is away, as a pure function of the anchor. No database, no wall
// clock: the layer writes exactly this, and `plan-invariants.test.ts` holds
// it to the world's figures at any anchor without seeding anything.
//
// Every date is a role on the story clock (`../story-clock.ts`) or a civil
// day counted from the anchor's Paris date: "last month's fourth weekday",
// "next week's Wednesday", "this month, never past today". Nothing here is a
// literal date.
//
// Which time lands where:
// - The fixed-price portal project: 346 h on 41 tasks under four milestones
//   whose own timeboxes are 52, 78, 200 and 90 h, all before this month.
// - The retainer project (dated hours on): last month's fourteen lines on the
//   same ordinal weekdays as the board, 46 h on six tasks, and this month's
//   18 h, each on a day of this month that is not after today.
// - The by-the-day project: two months ago 5 days, last month 7 days planned
//   and 7.5 days real plus half a day of outage, this month 2.5 days so far.
// - The second fixed-price project: 212 h on eight closed tasks against a
//   whole-project timebox of 180 h.
// - Next week: every open task of the ten people of delivery is due on next
//   week's Wednesday with its own timebox, so a person's planned hours next
//   week are the sum of those tasks; later work is due after next week.
import { addCalendarDays, isoWeekdayOf } from "@liaison/shared"
import { type StoryClock, storyClock } from "~/seed/worlds/story-clock"
import { STUDIO_AWAY, STUDIO_HOURS_PER_DAY_MINUTES, type StudioDeliveryKey } from "./fiction"

export type StudioTaskStatus = "todo" | "in_progress" | "done"

export interface StudioTaskPlan {
  /** The board's key; numbers are the board's and are not consecutive. */
  key: string
  title: string
  status: StudioTaskStatus
  /** Person key of the assignee. */
  assignee?: string
  /** Key of the milestone task this one sits under. */
  parent?: string
  isMilestone?: boolean
  timeboxMinutes?: number
  /** Paris civil due date, and the same as whole days from the anchor's date. */
  dueOn?: string
  dueInDays?: number
  /** When a done task was closed. */
  completedAt?: Date
}

export type StudioBasis = "none" | "hourly" | "daily" | "fixed" | "retainer"

export interface StudioPeriodTimebox {
  periodStart: string
  periodEnd: string
  minutes: number
  source: "manual" | "retainer"
}

export interface StudioProjectPlan {
  key: string
  name: string
  description: string
  icon: string
  /** Client key (`fiction.ts`), none for the studio's own project. */
  client?: string
  /** Person key of the project's owner. */
  owner: string
  /** Time and budgets, set through the project writer. */
  timeBudgets: boolean
  basis: StudioBasis
  /** Whole-project timebox. */
  timeboxMinutes?: number
  /** Day or hour rate, in minor units. On the retainer, the hour beyond the included. */
  rateMinor?: number
  fixedPriceMinor?: number
  currency: "EUR"
  /** Person key of who bills it. */
  biller?: string
  datedHours: boolean
  sourceRepos: string[]
  periods: StudioPeriodTimebox[]
  tasks: StudioTaskPlan[]
}

export interface StudioDealPlan {
  key: string
  title: string
  /** A stage of the default pipeline. */
  stage: "Lead" | "Qualified" | "Proposal" | "Demo"
  /** Where the deal sits on the board's three columns. */
  status: Exclude<StudioTaskStatus, "done">
  client?: string
  owner: string
  amountMinor: number
}

export interface StudioPipelinePlan {
  key: string
  name: string
  description: string
  owner: string
  deals: StudioDealPlan[]
}

export interface StudioTimeRow {
  project: string
  task: string
  person: string
  /** Paris civil date the time was taken on. */
  workDate: string
  minutes: number
}

export interface StudioCostRate {
  person: StudioDeliveryKey
  rateMinor: number
  currency: "EUR"
  effectiveFrom: string
}

export interface StudioAwayRange {
  person: string
  startsOn: string
  endsOn: string
  nextInLine: string
}

export interface StudioPlan {
  anchor: Date
  /** The anchor's Paris date. */
  today: string
  /** Next week, Monday to Sunday. */
  nextWeek: { from: string; to: string }
  hoursPerDayMinutes: number
  /** Company days off: none. */
  daysOff: readonly never[]
  projects: StudioProjectPlan[]
  pipeline: StudioPipelinePlan
  taskTime: StudioTimeRow[]
  costRates: StudioCostRate[]
  away: StudioAwayRange[]
}

const H = 60

/** Cost per hour of the ten people of delivery, in minor units. */
export const STUDIO_COST_RATES: Readonly<Record<StudioDeliveryKey, number>> = {
  bastien: 6000,
  clara: 5200,
  emma: 4500,
  hugo: 5000,
  lina: 5200,
  mathis: 4800,
  nadia: 6200,
  paul: 5400,
  sofia: 5500,
  yanis: 5000,
}

/**
 * Last month's dated lines on the retainer project: the ordinal weekday of
 * last month, the person, the task and the hours, in the board's order.
 */
export const STUDIO_DATED_LINES: ReadonlyArray<readonly [number, string, string, number]> = [
  [1, "emma", "SOREL-21", 2],
  [3, "nadia", "SOREL-19", 3],
  [4, "sofia", "SOREL-18", 4],
  [5, "sofia", "SOREL-18", 5],
  [6, "bastien", "SOREL-16", 3],
  [7, "nadia", "SOREL-19", 4],
  [8, "sofia", "SOREL-18", 5],
  [10, "emma", "SOREL-21", 3],
  [11, "nadia", "SOREL-20", 4],
  [13, "sofia", "SOREL-18", 4],
  [14, "emma", "SOREL-17", 1],
  [16, "nadia", "SOREL-20", 3],
  [18, "emma", "SOREL-21", 4],
  [20, "emma", "SOREL-17", 1],
]

/** Collation for "name order": accented names sort where a reader expects them. */
export function inNameOrder<T>(
  rows: readonly T[],
  nameOf: (row: T) => string,
  locale: string,
): T[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base" })
  return [...rows].sort((a, b) => collator.compare(nameOf(a), nameOf(b)))
}

const pad = (n: number) => String(n).padStart(2, "0")

/** The Paris civil date of an instant, `YYYY-MM-DD`. */
export function parisCivil(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(at)
}

/** Whole days from one civil date to another. */
function dayDiff(from: string, to: string): number {
  const ms = (c: string) => {
    const [y, m, d] = c.split("-").map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((ms(to) - ms(from)) / 86_400_000)
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

interface Calendar {
  clock: StoryClock
  today: string
  /** Day `day` (clamped to the month's length) of the month `back` months before the anchor's. */
  monthDate: (back: number, day: number) => string
  /** That month's first and last dates. */
  monthSpan: (back: number) => { start: string; end: string }
  /** Day `day` of this month, or today when today is earlier. */
  thisMonthUpTo: (day: number) => string
  /** The instant of a civil date at a Paris wall time (never past the anchor for today). */
  instantOn: (civil: string, hhmm: string) => Date
  /** Last month's k-th weekday. */
  lastMonthWeekdayDate: (k: number) => string
}

function calendar(anchor: Date): Calendar {
  const clock = storyClock(anchor)
  const today = parisCivil(anchor)
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number]
  const ym = (back: number) => {
    const index = ty * 12 + (tm - 1) - back
    return { year: Math.floor(index / 12), month: (index % 12) + 1 }
  }
  const monthDate = (back: number, day: number) => {
    const { year, month } = ym(back)
    return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`
  }
  return {
    clock,
    today,
    monthDate,
    monthSpan: (back) => {
      const { year, month } = ym(back)
      return {
        start: `${year}-${pad(month)}-01`,
        end: `${year}-${pad(month)}-${pad(daysInMonth(year, month))}`,
      }
    },
    thisMonthUpTo: (day) => `${ty}-${pad(tm)}-${pad(Math.min(day, td))}`,
    instantOn: (civil, hhmm) => clock.d(dayDiff(today, civil), hhmm),
    lastMonthWeekdayDate: (k) => parisCivil(clock.lastMonthWeekday(k, "12:00")),
  }
}

/** The studio's plan at an anchor. */
export function studioPlan(anchor: Date): StudioPlan {
  const cal = calendar(anchor)
  const { today } = cal
  const thisMonday = addCalendarDays(today, 1 - isoWeekdayOf(today))
  const nextMonday = addCalendarDays(thisMonday, 7)
  const nextWeek = { from: nextMonday, to: addCalendarDays(nextMonday, 6) }
  const nextWednesday = addCalendarDays(nextMonday, 2)
  const due = (civil: string) => ({ dueOn: civil, dueInDays: dayDiff(today, civil) })
  const dueNextWeek = due(nextWednesday)
  const closed = (back: number, day: number) => cal.instantOn(cal.monthDate(back, day), "17:00")
  const closedLastMonth = (k: number) => cal.clock.lastMonthWeekday(k, "17:30")

  const taskTime: StudioTimeRow[] = []
  const took = (project: string, task: string, person: string, workDate: string, hours: number) =>
    taskTime.push({ project, task, person, workDate, minutes: Math.round(hours * H) })

  // --- The fixed-price portal project ------------------------------------
  const marlin: StudioTaskPlan[] = []
  const milestone = (
    key: string,
    title: string,
    status: StudioTaskStatus,
    hours: number,
    extra: Partial<StudioTaskPlan>,
  ) => marlin.push({ key, title, status, isMilestone: true, timeboxMinutes: hours * H, ...extra })
  const work = (
    key: string,
    title: string,
    parent: string,
    assignee: string,
    status: StudioTaskStatus,
    extra: Partial<StudioTaskPlan> = {},
  ) => marlin.push({ key, title, parent, assignee, status, ...extra })
  /** A done task under a milestone, with the hours its assignee took on it. */
  const doneWith = (
    key: string,
    title: string,
    parent: string,
    assignee: string,
    hours: number,
    back: number,
    day: number,
  ) => {
    work(key, title, parent, assignee, "done", { completedAt: closed(back, day + 1) })
    if (hours > 0) took("MARLIN", key, assignee, cal.monthDate(back, day), hours)
  }

  milestone("MARLIN-1", "Discovery", "done", 52, { completedAt: closed(6, 26) })
  const discovery: Array<[string, string, string, number]> = [
    ["MARLIN-2", "Partner interviews", "bastien", 10],
    ["MARLIN-3", "Current portal audit", "bastien", 10],
    ["MARLIN-4", "Scope and estimate", "bastien", 10],
    ["MARLIN-5", "Data sources inventory", "nadia", 6],
    ["MARLIN-6", "Hosting options", "nadia", 6],
    ["MARLIN-7", "Integration map", "nadia", 6],
  ]
  discovery.forEach(([key, title, who, h], i) => {
    doneWith(key, title, "MARLIN-1", who, h, 6, 3 + i * 3)
  })

  milestone("MARLIN-8", "Design", "done", 78, { completedAt: closed(5, 27) })
  const design: Array<[string, string, string, number]> = [
    ["MARLIN-9", "Partner journeys", "bastien", 10],
    ["MARLIN-10", "Content structure", "bastien", 10],
    ["MARLIN-11", "Sign-in flow design", "nadia", 10],
    ["MARLIN-12", "Catalogue page design", "nadia", 10],
    ["MARLIN-13", "Order history design", "nadia", 10],
    ["MARLIN-14", "Accessibility review", "nadia", 10],
    ["MARLIN-15", "Prototype", "mathis", 6],
    ["MARLIN-16", "Prototype tests", "mathis", 5],
    ["MARLIN-17", "Design handover", "mathis", 5],
    ["MARLIN-18", "Design system", "mathis", 5],
  ]
  design.forEach(([key, title, who, h], i) => {
    doneWith(key, title, "MARLIN-8", who, h, 5, 2 + i * 2)
  })

  milestone("MARLIN-19", "Beta", "in_progress", 200, due(addCalendarDays(today, 5)))
  const betaDone: Array<[string, string, string, number]> = [
    ["MARLIN-20", "Beta plan", "bastien", 6],
    ["MARLIN-21", "Sign-in and roles", "nadia", 12],
    ["MARLIN-22", "Partner accounts", "nadia", 12],
    ["MARLIN-23", "Order history", "nadia", 12],
    ["MARLIN-24", "Partner catalogue pages", "nadia", 11],
    ["MARLIN-25", "Search", "nadia", 11],
    ["MARLIN-26", "Notifications", "nadia", 11],
    ["MARLIN-27", "Partner data import", "nadia", 11],
    ["MARLIN-28", "Price lists", "mathis", 11],
    ["MARLIN-29", "Stock levels", "mathis", 11],
    ["MARLIN-30", "Order export", "mathis", 11],
    ["MARLIN-31", "Invoice downloads", "mathis", 11],
    ["MARLIN-32", "Support form", "mathis", 11],
    ["MARLIN-33", "Analytics events", "mathis", 11],
    ["MARLIN-34", "Error pages", "mathis", 10],
    ["MARLIN-35", "Beta environment", "mathis", 10],
  ]
  betaDone.forEach(([key, title, who, h], i) => {
    const back = 4 - Math.floor(i / 6)
    doneWith(key, title, "MARLIN-19", who, h, back, 2 + (i % 6) * 4)
  })
  const betaOpen: Array<[string, string, string, number, number]> = [
    ["MARLIN-47", "Partner import retries", "nadia", 16, 12],
    ["MARLIN-49", "Beta fixes", "nadia", 8, 3],
    ["MARLIN-52", "Beta test data", "mathis", 4, 2],
  ]
  betaOpen.forEach(([key, title, who, planned, real], i) => {
    work(key, title, "MARLIN-19", who, "in_progress", {
      timeboxMinutes: planned * H,
      ...dueNextWeek,
    })
    took("MARLIN", key, who, cal.monthDate(1, 6 + i * 5), real)
  })

  milestone("MARLIN-36", "Launch", "todo", 90, due(addCalendarDays(today, 25)))
  const launchDone: Array<[string, string, string, number]> = [
    ["MARLIN-37", "Launch checklist", "bastien", 4],
    ["MARLIN-38", "Load tests", "nadia", 8],
    ["MARLIN-39", "Security fixes", "nadia", 8],
    ["MARLIN-40", "Redirects from the old portal", "mathis", 3],
    ["MARLIN-41", "Beta sign-off checklist", "mathis", 3],
    ["MARLIN-42", "Monitoring setup", "mathis", 2],
    ["MARLIN-43", "Domain and certificates", "bastien", 0],
  ]
  launchDone.forEach(([key, title, who, h], i) => {
    doneWith(key, title, "MARLIN-36", who, h, 2, 3 + i * 3)
  })
  work("MARLIN-51", "Launch cutover plan", "MARLIN-36", "bastien", "in_progress", {
    timeboxMinutes: 7 * H,
    ...dueNextWeek,
  })
  const launchLater: Array<[string, string, string, number, number]> = [
    ["MARLIN-58", "Launch runbook", "bastien", 12, 18],
    ["MARLIN-59", "Go-live rehearsal", "nadia", 14, 21],
    ["MARLIN-60", "Partner onboarding guide", "sofia", 6, 20],
  ]
  for (const [key, title, who, planned, days] of launchLater) {
    work(key, title, "MARLIN-36", who, "todo", {
      timeboxMinutes: planned * H,
      ...due(addCalendarDays(today, days)),
    })
  }

  // --- The retainer project ------------------------------------------------
  const sorel: StudioTaskPlan[] = []
  const lastWeekday = closedLastMonth(-1)
  const sorelDone: Array<[string, string, string]> = [
    ["SOREL-16", "Monthly review", "bastien"],
    ["SOREL-17", "Support questions", "emma"],
    ["SOREL-18", "Catalogue import", "sofia"],
    ["SOREL-19", "Rights database fixes", "nadia"],
    ["SOREL-20", "Rights database fixes, second part", "nadia"],
    ["SOREL-21", "Reader site upkeep", "emma"],
  ]
  for (const [key, title, who] of sorelDone) {
    sorel.push({ key, title, assignee: who, status: "done", completedAt: lastWeekday })
  }
  for (const [k, who, task, hours] of STUDIO_DATED_LINES) {
    took("SOREL", task, who, cal.lastMonthWeekdayDate(k), hours)
  }
  const sorelEarlier: Array<[string, string, string, number]> = [
    ["SOREL-3", "Reader site move", "emma", 5],
    ["SOREL-6", "Rights database audit", "nadia", 4],
    ["SOREL-9", "Catalogue feed fixes", "sofia", 3],
    ["SOREL-11", "Newsletter sign-up", "emma", 3],
    ["SOREL-13", "Quarterly review", "bastien", 2],
  ]
  for (const [key, title, who, back] of sorelEarlier) {
    sorel.push({ key, title, assignee: who, status: "done", completedAt: closed(back, 20) })
  }
  const sorelOpen: Array<[string, string, string, number, number, number]> = [
    ["SOREL-24", "Rights database export", "nadia", 8, 6, 3],
    ["SOREL-25", "Reader site upkeep", "emma", 12, 8, 5],
    ["SOREL-26", "Catalogue import", "sofia", 4, 4, 6],
  ]
  for (const [key, title, who, planned, real, day] of sorelOpen) {
    sorel.push({
      key,
      title,
      assignee: who,
      status: "in_progress",
      timeboxMinutes: planned * H,
      ...dueNextWeek,
    })
    took("SOREL", key, who, cal.thisMonthUpTo(day), real)
  }

  // --- The by-the-day project ---------------------------------------------
  const alpine: StudioTaskPlan[] = []
  const alpineSeptember: Array<[string, string, string, number, number]> = [
    ["ALPINE-9", "Stock data model", "sofia", 14, 12],
    ["ALPINE-10", "Stock data model review", "sofia", 7, 9],
    ["ALPINE-12", "Supplier connector", "mathis", 14, 14],
  ]
  alpineSeptember.forEach(([key, title, who, planned, real], i) => {
    alpine.push({
      key,
      title,
      assignee: who,
      status: "done",
      timeboxMinutes: planned * H,
      completedAt: closed(2, 12 + i * 4),
    })
    took("ALPINE", key, who, cal.monthDate(2, 10 + i * 4), real)
  })
  // Last month: Data export and Monitoring, then the three lines not in the plan.
  const alpineLastMonth: Array<[string, string, string, number | undefined, number]> = [
    ["ALPINE-11", "Export format review", "mathis", undefined, 4],
    ["ALPINE-13", "Export scheduling", "mathis", undefined, 3],
    ["ALPINE-14", "Stock export", "mathis", 14, 10.5],
    ["ALPINE-15", "Supplier export", "mathis", 7, 7],
    ["ALPINE-6", "Metrics collection", "mathis", undefined, 6],
    ["ALPINE-7", "Dashboard data sources", "mathis", undefined, 6],
    ["ALPINE-16", "Monitoring alerts", "nadia", 14, 8],
    ["ALPINE-17", "Monitoring dashboards", "nadia", 14, 8],
    ["ALPINE-8", "Staging outage fix", "mathis", undefined, 3.5],
    ["ALPINE-18", "Extra stock report", "mathis", undefined, 0],
    ["ALPINE-19", "Rights database export", "nadia", undefined, 0],
  ]
  alpineLastMonth.forEach(([key, title, who, planned, real], i) => {
    alpine.push({
      key,
      title,
      assignee: who,
      status: "done",
      ...(planned ? { timeboxMinutes: planned * H } : {}),
      completedAt: closedLastMonth(i + 6),
    })
    if (real > 0) took("ALPINE", key, who, cal.lastMonthWeekdayDate(i + 4), real)
  })
  alpine.push({
    key: "ALPINE-20",
    title: "Connector tests",
    assignee: "mathis",
    status: "in_progress",
    timeboxMinutes: 11 * H,
    ...dueNextWeek,
  })
  took("ALPINE", "ALPINE-20", "mathis", cal.thisMonthUpTo(4), 17.5)
  alpine.push({
    key: "ALPINE-21",
    title: "Stock dashboards",
    assignee: "sofia",
    status: "todo",
    timeboxMinutes: 6 * H,
    ...dueNextWeek,
  })
  alpine.push({
    key: "ALPINE-22",
    title: "Alert rules",
    assignee: "nadia",
    status: "todo",
    timeboxMinutes: 12 * H,
    ...dueNextWeek,
  })

  // --- The insurer's project, by the day -----------------------------------
  const rhone: StudioTaskPlan[] = [
    {
      key: "RHONE-9",
      title: "Member sign-in",
      assignee: "paul",
      status: "done",
      completedAt: closed(2, 17),
    },
    {
      key: "RHONE-11",
      title: "Claims rules",
      assignee: "yanis",
      status: "done",
      completedAt: closed(2, 24),
    },
  ]
  const rhoneNext: Array<[string, string, string, number]> = [
    ["RHONE-14", "Claims export scoping", "bastien", 16],
    ["RHONE-15", "Claims export", "clara", 35],
    ["RHONE-16", "Member portal", "lina", 35],
    ["RHONE-17", "Member sign-in", "paul", 12],
    ["RHONE-18", "Claims rules", "yanis", 24],
  ]
  for (const [key, title, who, planned] of rhoneNext) {
    rhone.push({
      key,
      title,
      assignee: who,
      status: "todo",
      timeboxMinutes: planned * H,
      ...dueNextWeek,
    })
  }

  // --- The second fixed-price project: 212 h against 180 h ------------------
  const verd: StudioTaskPlan[] = []
  const verdClosed: Array<[string, string, string, number]> = [
    ["VERD-3", "Fleet data model", "hugo", 30],
    ["VERD-4", "Route planner", "emma", 24],
    ["VERD-5", "Depot import", "hugo", 36],
    ["VERD-6", "Driver app sync", "paul", 28],
    ["VERD-7", "Warehouse feed", "sofia", 22],
    ["VERD-8", "Route planner tests", "paul", 32],
    ["VERD-9", "Depot rules", "yanis", 20],
    ["VERD-10", "Pilot review", "bastien", 20],
  ]
  verdClosed.forEach(([key, title, who, real], i) => {
    const back = 3 - Math.floor(i / 3)
    verd.push({
      key,
      title,
      assignee: who,
      status: "done",
      completedAt: closed(back, 8 + (i % 3) * 7),
    })
    took("VERD", key, who, cal.monthDate(back, 5 + (i % 3) * 7), real)
  })
  const verdNext: Array<[string, string, string, number]> = [
    ["VERD-11", "Warehouse data model", "sofia", 24],
    ["VERD-12", "Route planner fixes", "emma", 24],
    ["VERD-13", "Fleet data feed", "hugo", 36],
    ["VERD-14", "Route planner rollout", "paul", 25],
    ["VERD-15", "Rollout reviews", "bastien", 5],
    ["VERD-16", "Depot data checks", "yanis", 12],
  ]
  for (const [key, title, who, planned] of verdNext) {
    verd.push({
      key,
      title,
      assignee: who,
      status: "todo",
      timeboxMinutes: planned * H,
      ...dueNextWeek,
    })
  }

  // --- The studio's own work: time and budgets off, no timebox -------------
  const studio: StudioTaskPlan[] = [
    { key: "STUDIO-8", title: "Laptop refresh", assignee: "paul", status: "todo" },
    { key: "STUDIO-7", title: "Update onboarding notes", assignee: "lina", status: "todo" },
    { key: "STUDIO-9", title: "Build pipeline", assignee: "yanis", status: "in_progress" },
    { key: "STUDIO-6", title: "Delivery reviews", assignee: "bastien", status: "in_progress" },
    {
      key: "STUDIO-5",
      title: "Holiday rota",
      assignee: "bastien",
      status: "done",
      completedAt: closed(1, 9),
    },
    {
      key: "STUDIO-4",
      title: "New starter checklist",
      assignee: "lina",
      status: "done",
      completedAt: closed(1, 16),
    },
    {
      key: "STUDIO-3",
      title: "Office network upgrade",
      assignee: "gaspard",
      status: "done",
      completedAt: closed(2, 11),
    },
    {
      key: "STUDIO-2",
      title: "Expense policy",
      assignee: "salome",
      status: "done",
      completedAt: closed(2, 18),
    },
    {
      key: "STUDIO-1",
      title: "Brand refresh",
      assignee: "victor",
      status: "done",
      completedAt: closed(3, 14),
    },
  ]

  const month = (
    back: number,
    minutes: number,
    source: StudioPeriodTimebox["source"] = "manual",
  ) => {
    const span = cal.monthSpan(back)
    return { periodStart: span.start, periodEnd: span.end, minutes, source }
  }
  const day = STUDIO_HOURS_PER_DAY_MINUTES

  const projects: StudioProjectPlan[] = [
    {
      key: "MARLIN",
      name: "Partner portal rebuild",
      description:
        "The partner portal, rebuilt from discovery to launch, at a fixed price in four milestones.",
      icon: "layout-dashboard",
      client: "marlin",
      owner: "bastien",
      timeBudgets: true,
      basis: "fixed",
      fixedPriceMinor: 6_400_000,
      currency: "EUR",
      biller: "anais",
      datedHours: false,
      sourceRepos: ["haldenstudio/partner-portal"],
      periods: [],
      tasks: marlin,
    },
    {
      key: "SOREL",
      name: "Publishing retainer",
      description:
        "Monthly upkeep of the reader site, the rights database and the catalogue: 40 hours a month.",
      icon: "book-open",
      client: "sorel",
      owner: "bastien",
      timeBudgets: true,
      basis: "retainer",
      rateMinor: 12_000,
      currency: "EUR",
      biller: "anais",
      datedHours: true,
      sourceRepos: ["haldenstudio/reader-site"],
      periods: [month(1, 40 * H, "retainer"), month(0, 40 * H, "retainer")],
      tasks: sorel,
    },
    {
      key: "ALPINE",
      name: "Stock and supplier data",
      description:
        "Stock data, supplier exports and monitoring for the cooperative, billed by the day.",
      icon: "boxes",
      client: "alpine",
      owner: "bastien",
      timeBudgets: true,
      basis: "daily",
      rateMinor: 93_000,
      currency: "EUR",
      biller: "anais",
      datedHours: false,
      sourceRepos: ["haldenstudio/stock-data"],
      periods: [month(2, 5 * day), month(1, 7 * day), month(0, 6 * day)],
      tasks: alpine,
    },
    {
      key: "SALES",
      name: "Sales pipeline",
      description: "",
      icon: "handshake",
      owner: "romain",
      timeBudgets: false,
      basis: "none",
      currency: "EUR",
      datedHours: false,
      sourceRepos: [],
      periods: [],
      tasks: [],
    },
    {
      key: "RHONE",
      name: "Member portal and claims",
      description: "The member portal, sign-in and the claims export, billed by the day.",
      icon: "shield",
      client: "rhone",
      owner: "bastien",
      timeBudgets: true,
      basis: "daily",
      rateMinor: 88_000,
      currency: "EUR",
      biller: "anais",
      datedHours: false,
      sourceRepos: ["haldenstudio/member-portal"],
      periods: [month(2, 5 * day), month(1, 6 * day)],
      tasks: rhone,
    },
    {
      key: "VERD",
      name: "Route planning",
      description: "Route planning and fleet data for the carrier, at a fixed price for 180 hours.",
      icon: "truck",
      client: "verdier",
      owner: "bastien",
      timeBudgets: true,
      basis: "fixed",
      timeboxMinutes: 180 * H,
      fixedPriceMinor: 1_620_000,
      currency: "EUR",
      biller: "anais",
      datedHours: false,
      sourceRepos: ["haldenstudio/route-planner"],
      periods: [],
      tasks: verd,
    },
    {
      key: "STUDIO",
      name: "Studio",
      description: "The studio's own work: equipment, onboarding, reviews and the build machines.",
      icon: "home",
      owner: "lea",
      timeBudgets: false,
      basis: "none",
      currency: "EUR",
      datedHours: false,
      sourceRepos: [],
      periods: [],
      tasks: studio,
    },
  ]

  const pipeline: StudioPipelinePlan = {
    key: "SALES",
    name: "Sales pipeline",
    description: "New work from briefs to signed agreements.",
    owner: "romain",
    deals: [
      {
        key: "SALES-1",
        title: "Carrier booking and tracking system",
        stage: "Proposal",
        status: "in_progress",
        client: "tessier",
        owner: "romain",
        amountMinor: 3_800_000,
      },
      {
        key: "SALES-2",
        title: "Partner portal, phase two",
        stage: "Qualified",
        status: "todo",
        client: "marlin",
        owner: "sarah",
        amountMinor: 2_400_000,
      },
      {
        key: "SALES-3",
        title: "Claims analytics",
        stage: "Demo",
        status: "in_progress",
        client: "rhone",
        owner: "sarah",
        amountMinor: 1_760_000,
      },
      {
        key: "SALES-4",
        title: "Depot planning",
        stage: "Lead",
        status: "todo",
        client: "verdier",
        owner: "romain",
        amountMinor: 1_200_000,
      },
      {
        key: "SALES-5",
        title: "Reader app",
        stage: "Qualified",
        status: "todo",
        client: "sorel",
        owner: "sarah",
        amountMinor: 2_100_000,
      },
      {
        key: "SALES-6",
        title: "Supplier portal",
        stage: "Proposal",
        status: "in_progress",
        client: "alpine",
        owner: "romain",
        amountMinor: 2_790_000,
      },
      {
        key: "SALES-7",
        title: "Booking site rebuild",
        stage: "Lead",
        status: "todo",
        owner: "romain",
        amountMinor: 1_500_000,
      },
      {
        key: "SALES-8",
        title: "Data platform audit",
        stage: "Lead",
        status: "todo",
        owner: "sarah",
        amountMinor: 650_000,
      },
      {
        key: "SALES-9",
        title: "Field app for inspectors",
        stage: "Demo",
        status: "in_progress",
        owner: "romain",
        amountMinor: 3_100_000,
      },
    ],
  }

  const effectiveFrom = cal.monthDate(12, 1)
  const costRates: StudioCostRate[] = (Object.keys(STUDIO_COST_RATES) as StudioDeliveryKey[]).map(
    (person) => ({ person, rateMinor: STUDIO_COST_RATES[person], currency: "EUR", effectiveFrom }),
  )

  const away: StudioAwayRange[] = STUDIO_AWAY.map((a) => ({
    person: a.key,
    startsOn: addCalendarDays(thisMonday, a.fromWeek * 7),
    endsOn: addCalendarDays(thisMonday, a.throughWeek * 7 + 6),
    nextInLine: a.nextInLine,
  }))

  return {
    anchor,
    today,
    nextWeek,
    hoursPerDayMinutes: STUDIO_HOURS_PER_DAY_MINUTES,
    daysOff: [],
    projects,
    pipeline,
    taskTime,
    costRates,
    away,
  }
}

/** A project's tasks by board column; the pipeline's are its deals. */
export function studioBoardCounts(
  plan: StudioPlan,
): Record<string, Record<StudioTaskStatus, number>> {
  const out: Record<string, Record<StudioTaskStatus, number>> = {}
  for (const p of plan.projects) {
    const rows: { status: StudioTaskStatus }[] =
      p.key === plan.pipeline.key ? plan.pipeline.deals : p.tasks
    const counts = { todo: 0, in_progress: 0, done: 0 }
    for (const r of rows) counts[r.status]++
    out[p.key] = counts
  }
  return out
}
