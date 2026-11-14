// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Calendar-date arithmetic on `YYYY-MM-DD` strings, in UTC so a server's own zone never shifts a day.

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const

/** Midnight UTC of a `YYYY-MM-DD` date: a date-only ISO string always parses as UTC. */
function utcDay(date: string): Date {
  return new Date(date)
}

export function addDays(date: string, days: number): string {
  const d = utcDay(date)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function isRealDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const d = utcDay(date)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date
}

/** ISO weekday of a date, Monday 1 to Sunday 7. */
export function isoWeekdayOf(date: string): number {
  const day = utcDay(date).getUTCDay()
  return day === 0 ? 7 : day
}

/** "Mon 7 Dec 2026": the form every result states a date in, so a misread date is seen at once. */
export function dayLabel(date: string): string {
  const d = utcDay(date)
  return `${DAY_NAMES[isoWeekdayOf(date) - 1]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** The ISO year a date belongs to: the year of that week's Thursday. */
export function isoYearOf(date: string): number {
  return Number(addDays(date, 4 - isoWeekdayOf(date)).slice(0, 4))
}

function isoWeekMonday(year: number, week: number): string {
  // 4 January is always in week 1.
  const jan4 = `${year}-01-04`
  return addDays(addDays(jan4, 1 - isoWeekdayOf(jan4)), (week - 1) * 7)
}

/** 52 or 53. */
export function isoWeeksIn(year: number): number {
  const monday1 = isoWeekMonday(year, 1)
  return (
    Math.floor((utcDay(`${year}-12-28`).getTime() - utcDay(monday1).getTime()) / (7 * 86_400_000)) +
    1
  )
}

/** The ISO week label (`2026-W48`) of a date. */
export function isoWeekOf(date: string): string {
  const year = isoYearOf(date)
  const monday = addDays(date, 1 - isoWeekdayOf(date))
  const week =
    1 +
    Math.round(
      (utcDay(monday).getTime() - utcDay(isoWeekMonday(year, 1)).getTime()) / (7 * 86_400_000),
    )
  return `${year}-W${String(week).padStart(2, "0")}`
}

/** The ISO week after a `2026-W48` label, or null when the label is not one. */
export function nextIsoWeek(week: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(week)
  const range = m ? isoWeekRange(Number(m[1]), Number(m[2])) : null
  return range ? isoWeekOf(addDays(range.from, 7)) : null
}

/** Monday to Sunday of an ISO week, or null when that year has no such week. */
export function isoWeekRange(year: number, week: number): { from: string; to: string } | null {
  if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > isoWeeksIn(year)) {
    return null
  }
  const from = isoWeekMonday(year, week)
  return { from, to: addDays(from, 6) }
}
