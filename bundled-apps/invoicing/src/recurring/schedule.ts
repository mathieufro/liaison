// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The date rules of a recurring schedule. Every date here is a civil date ("YYYY-MM-DD"), moved
// by whole days with integer arithmetic: no instant, no clock and no zone table. What "today" is
// comes from the caller, which reads it from the host in the issuer's time zone (`issue-date.ts`).
//
// Liaison holds no holiday calendar and infers nothing from a country: the draft day steps back
// over weekends only, and an issue day never moves, so a Saturday stays a Saturday.

export type Repeats = "month" | "quarter" | "year"
export type ScheduleStatus = "draft" | "active" | "paused" | "ended"

/** Days between the draft and the issue day: the time a person has to look at the draft. */
export const DRAFT_LEAD_DAYS = 3

const pad = (n: number, width = 2) => String(n).padStart(width, "0")

function parts(date: string): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number)
  return [y as number, m as number, d as number]
}

function format(y: number, m: number, d: number): string {
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`
}

/** Days since 1970-01-01 of a civil date (proleptic Gregorian). */
function toDays(date: string): number {
  const [y0, m, d] = parts(date)
  const y = m <= 2 ? y0 - 1 : y0
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

function fromDays(days: number): string {
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  )
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp + (mp < 10 ? 3 : -9)
  return format(yoe + era * 400 + (m <= 2 ? 1 : 0), m, d)
}

export function addDays(date: string, n: number): string {
  return fromDays(toDays(date) + n)
}

/** ISO weekday: Monday 1 to Sunday 7. */
export function weekdayOf(date: string): number {
  return ((((toDays(date) + 3) % 7) + 7) % 7) + 1
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

export function isCivilDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = parts(value)
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)
}

/** The first day of the month, quarter or year that holds the date. */
export function periodStart(repeats: Repeats, date: string): string {
  const [y, m] = parts(date)
  if (repeats === "year") return format(y, 1, 1)
  if (repeats === "quarter") return format(y, Math.floor((m - 1) / 3) * 3 + 1, 1)
  return format(y, m, 1)
}

/** `2026-11` for a month, `2026-Q4` for a quarter, `2026` for a year. */
export function periodKey(repeats: Repeats, issueOn: string): string {
  const [y, m] = parts(issueOn)
  if (repeats === "year") return String(y)
  if (repeats === "quarter") return `${y}-Q${Math.floor((m - 1) / 3) + 1}`
  return `${y}-${pad(m)}`
}

/** The day the draft is made: three calendar days before the issue day, back over weekends only. */
export function draftOn(issueOn: string): string {
  let draft = addDays(issueOn, -DRAFT_LEAD_DAYS)
  const weekday = weekdayOf(draft)
  if (weekday === 6) draft = addDays(draft, -1)
  else if (weekday === 7) draft = addDays(draft, -2)
  return draft
}

/** The last day an invoice of that billing month may still issue: the month's last day. */
export function latestIssueOn(issueOn: string): string {
  const [y, m] = parts(issueOn)
  return format(y, m, daysInMonth(y, m))
}

export interface Cadence {
  repeats: Repeats
  /** `last`, a day of the month `1` to `28`, or `MM-DD` for a year. */
  billing_day: string
}

/** Which months a cadence bills in, and the day it bills on in each. */
function billingMonths(c: Cadence): { months: number[]; day: number | "last" } | null {
  const bd = c.billing_day
  const monthDay = /^(\d{2})-(\d{2})$/.exec(bd)
  if (c.repeats === "year") {
    if (bd === "last") return { months: [12], day: "last" }
    if (!monthDay) return null
    return { months: [Number(monthDay[1])], day: Number(monthDay[2]) }
  }
  const day: number | "last" | null =
    bd === "last"
      ? "last"
      : /^\d{1,2}$/.test(bd)
        ? Number(bd)
        : monthDay
          ? Number(monthDay[2])
          : null
  if (day === null) return null
  if (c.repeats === "month") return { months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], day }
  // A quarter bills in the last month of each quarter, or from the month a date names.
  const anchor = monthDay ? Number(monthDay[1]) : 3
  const first = ((anchor - 1) % 3) + 1
  return { months: [first, first + 3, first + 6, first + 9], day }
}

/** The first billing day on or after `onOrAfter`. A day past the month's end is its last day. */
export function nextIssueOn(cadence: Cadence, onOrAfter: string): string {
  const plan = billingMonths(cadence)
  if (!plan) throw new Error(`billing_day "${cadence.billing_day}" names no date`)
  const [y0] = parts(onOrAfter)
  for (let y = y0; y <= y0 + 1; y++) {
    for (const m of plan.months) {
      const last = daysInMonth(y, m)
      const day = plan.day === "last" ? last : Math.min(plan.day, last)
      const candidate = format(y, m, day)
      if (candidate >= onOrAfter) return candidate
    }
  }
  throw new Error("no billing day within two years")
}

export interface ScheduleDates {
  next_issue_on: string
  next_draft_on: string
}

/** The next issue day on or after `from`, with its draft day. */
export function datesFrom(cadence: Cadence, from: string): ScheduleDates {
  const issue = nextIssueOn(cadence, from)
  return { next_issue_on: issue, next_draft_on: draftOn(issue) }
}

export interface DueFacts extends Cadence {
  status: string
  next_issue_on?: string | null
  next_draft_on?: string | null
  ends_on?: string | null
  paused_until?: string | null
}

/**
 * True when the schedule gets a draft today: active, its draft day reached, and not ended before
 * the period it would bill. A schedule ending inside the period still bills that last one.
 */
export function isDueForDraft(s: DueFacts, today: string): boolean {
  if (s.status !== "active" || !s.next_draft_on || !s.next_issue_on) return false
  if (s.next_draft_on > today) return false
  if (s.ends_on && s.ends_on < periodStart(s.repeats, s.next_issue_on)) return false
  return true
}

/**
 * The dates a paused schedule takes on when it resumes on `today`: the next billing day from
 * today. Every billing day inside the pause is skipped, so nothing is back-billed.
 */
export function resumeOn(s: Cadence, today: string): ScheduleDates {
  return datesFrom(s, today)
}

export interface ScheduleLine {
  description?: unknown
  qty?: unknown
  unit_price_minor?: unknown
  vat_bp?: unknown
  product_ref?: unknown
  line_kind?: unknown
}

export interface ScheduleFacts {
  contact_id?: unknown
  repeats?: unknown
  billing_day?: unknown
  lines?: unknown
}

export interface ScheduleError {
  field: "contact_id" | "repeats" | "billing_day" | "lines"
  message: string
}

/** What stops a schedule being saved: a missing customer, date or line, each named. */
export function validateSchedule(s: ScheduleFacts): ScheduleError[] {
  const errors: ScheduleError[] = []
  if (typeof s.contact_id !== "string" || s.contact_id.trim() === "") {
    errors.push({ field: "contact_id", message: "choose the customer to bill" })
  }
  if (s.repeats !== "month" && s.repeats !== "quarter" && s.repeats !== "year") {
    errors.push({ field: "repeats", message: "repeats must be month, quarter or year" })
  } else {
    const bd = s.billing_day
    const ok =
      typeof bd === "string" &&
      billingMonths({ repeats: s.repeats, billing_day: bd }) !== null &&
      (bd === "last" ||
        (/^\d{1,2}$/.test(bd) && Number(bd) >= 1 && Number(bd) <= 28) ||
        (/^\d{2}-\d{2}$/.test(bd) && isCivilDate(`2024-${bd}`)))
    if (!ok)
      errors.push({
        field: "billing_day",
        message: "give the billing day: last, a day from 1 to 28, or MM-DD for a year",
      })
  }
  const lines = Array.isArray(s.lines) ? (s.lines as ScheduleLine[]) : []
  const lineOk = (l: ScheduleLine) =>
    typeof l.description === "string" &&
    l.description.trim() !== "" &&
    typeof l.qty === "number" &&
    l.qty > 0 &&
    Number.isInteger(l.unit_price_minor) &&
    (l.unit_price_minor as number) >= 0 &&
    Number.isInteger(l.vat_bp) &&
    (l.vat_bp as number) >= 0 &&
    (l.vat_bp as number) <= 10000
  if (lines.length === 0 || !lines.every(lineOk)) {
    errors.push({
      field: "lines",
      message:
        "add at least one line with a description, a quantity above zero, a price in minor units and a VAT rate in basis points",
    })
  }
  return errors
}
