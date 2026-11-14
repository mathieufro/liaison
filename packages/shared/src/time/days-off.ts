// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Company days off: expanding rows over a window, and reading the day forms a person says.

import { personLocalDate } from "../approvals/authority"
import { addDays, dayLabel, isoWeekRange, isoWeeksIn, isoYearOf, isRealDate } from "./dates"

/** One company day off. `yearly` repeats it on the same dates every year from `startsOn` on. */
export interface DaysOffRow {
  startsOn: string
  endsOn: string
  yearly?: boolean
}

const MAX_RANGE_DAYS = 366

/** The dates inside `from` to `to` (both included) that the rows cover, sorted, once each. */
export function expandDaysOff(rows: readonly DaysOffRow[], from: string, to: string): string[] {
  if (to < from) return []
  const out = new Set<string>()
  for (const row of rows) {
    if (row.endsOn < row.startsOn) continue
    if (!row.yearly) {
      const start = row.startsOn > from ? row.startsOn : from
      const end = row.endsOn < to ? row.endsOn : to
      for (let d = start; d <= end; d = addDays(d, 1)) out.add(d)
      continue
    }
    // Yearly: each day of the row recurs on its month and day. 29 Feb exists only in leap years,
    // so it falls out of the isRealDate check below.
    const recurring = new Set<string>()
    let d = row.startsOn
    for (let i = 0; i < MAX_RANGE_DAYS && d <= row.endsOn; i++, d = addDays(d, 1)) {
      recurring.add(d.slice(5))
    }
    const first = from > row.startsOn ? from : row.startsOn
    for (let day = first; day <= to; day = addDays(day, 1)) {
      if (recurring.has(day.slice(5))) out.add(day)
    }
  }
  return [...out].sort()
}

export interface DayFormInput {
  /** One day: `YYYY-MM-DD`, or `MM-DD` for its next occurrence. */
  on?: string
  /** A range's first and last day (included), the same two forms. */
  from?: string
  to?: string
  /** An ISO week number; the year is `weekYear`, else this ISO year, else next if it has ended. */
  week?: number
  weekYear?: number
  yearly?: boolean
}

export type DayFormRefusal = "bad_dates" | "no_such_week" | "week_cannot_recur"

export type ResolvedDayForm =
  | { ok: true; from: string; to: string; days: string[] }
  | { ok: false; code: DayFormRefusal; message: string }

function refuse(code: DayFormRefusal, message: string): ResolvedDayForm {
  return { ok: false, code, message }
}

function resolveDay(value: string, onOrAfter: string): string | null {
  if (/^\d{2}-\d{2}$/.test(value)) {
    const year = Number(onOrAfter.slice(0, 4))
    // Five years reach the next 29 Feb from any date.
    for (let y = year; y <= year + 5; y++) {
      const candidate = `${y}-${value}`
      if (isRealDate(candidate) && candidate >= onOrAfter) return candidate
    }
    return null
  }
  return isRealDate(value) ? value : null
}

/**
 * The dates a day form says, read against `today` (a date, or an instant read in `tz`), never by
 * the model. The answer states every day with its weekday so a misread date is seen at once.
 */
export function resolveDayForm(
  input: DayFormInput,
  today: string | Date,
  tz: string | null,
): ResolvedDayForm {
  const todayDate = typeof today === "string" ? today : personLocalDate(today, tz, null)
  const forms = [
    input.on !== undefined,
    input.from !== undefined || input.to !== undefined,
    input.week !== undefined,
  ].filter(Boolean).length
  if (forms !== 1) {
    return refuse(
      "bad_dates",
      "Give exactly one of: on (one day), from and to (a range), or week (an ISO week number).",
    )
  }
  let from: string
  let to: string
  if (input.week !== undefined) {
    if (input.yearly) {
      return refuse(
        "week_cannot_recur",
        "A week cannot repeat every year, because week numbers move. Give the dates instead.",
      )
    }
    const week = input.week
    if (!Number.isInteger(week) || week < 1 || week > 53) {
      return refuse("bad_dates", `Week ${week} is not an ISO week number (1 to 53).`)
    }
    let year = input.weekYear ?? isoYearOf(todayDate)
    if (input.weekYear === undefined) {
      const thisYear = isoWeekRange(year, Math.min(week, isoWeeksIn(year)))
      if (thisYear && thisYear.to < todayDate) year += 1
    }
    const range = isoWeekRange(year, week)
    if (!range) return refuse("no_such_week", `${year} has no ISO week ${week}.`)
    from = range.from
    to = range.to
  } else if (input.on !== undefined) {
    const day = resolveDay(input.on, todayDate)
    if (!day) return refuse("bad_dates", `"${input.on}" is not a date (YYYY-MM-DD or MM-DD).`)
    from = day
    to = day
  } else {
    if (input.from === undefined || input.to === undefined) {
      return refuse("bad_dates", "A range needs both from and to (the last day, included).")
    }
    const start = resolveDay(input.from, todayDate)
    if (!start) return refuse("bad_dates", `"${input.from}" is not a date (YYYY-MM-DD or MM-DD).`)
    const end = resolveDay(input.to, start)
    if (!end) return refuse("bad_dates", `"${input.to}" is not a date (YYYY-MM-DD or MM-DD).`)
    if (end < start) {
      return refuse(
        "bad_dates",
        `The last day (${dayLabel(end)}) is before the first (${dayLabel(start)}).`,
      )
    }
    from = start
    to = end
  }
  const days: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(dayLabel(d))
  return { ok: true, from, to, days }
}
