// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Away dates as people read them, everywhere an away date is shown: "20 Dec", a range
// "23 to 27 Nov" or "9 Nov to 20 Dec", the year only when it is not this year. Every input is a
// calendar day, `YYYY-MM-DD`; anything else is returned as given.

/** English days read day first ("20 Dec"), as the rest of the product writes them. */
function intlLocale(locale: string): string {
  return locale === "en" ? "en-GB" : locale
}

function utcNoon(date: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const d = new Date(`${date}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}

function localToday(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mm}-${dd}`
}

function dayFormat(locale: string, withYear: boolean): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  })
}

/** "20 Dec", or "20 Dec 2027" when that is not this year. */
export function awayDay(date: string, locale: string, today: string = localToday()): string {
  const d = utcNoon(date)
  if (!d) return date
  return dayFormat(locale, date.slice(0, 4) !== today.slice(0, 4)).format(d)
}

/**
 * The two ends of a range, to put in the reader's "{from} to {to}": "23" and "27 Nov" within
 * one month, "9 Nov" and "20 Dec" across months, each with its year when not this year.
 */
export function awayRangeEnds(
  from: string,
  to: string,
  locale: string,
  today: string = localToday(),
): { from: string; to: string } {
  const a = utcNoon(from)
  const b = utcNoon(to)
  if (!a || !b) return { from: awayDay(from, locale, today), to: awayDay(to, locale, today) }
  const toLabel = awayDay(to, locale, today)
  if (from.slice(0, 7) === to.slice(0, 7)) {
    // Same month and year: the first day alone, where the reader's form puts the day first.
    const parts = dayFormat(locale, from.slice(0, 4) !== today.slice(0, 4)).formatToParts(a)
    const dayAt = parts.findIndex((p) => p.type === "day")
    const monthAt = parts.findIndex((p) => p.type === "month")
    if (dayAt >= 0 && dayAt < monthAt) return { from: parts[dayAt]?.value ?? from, to: toLabel }
  }
  return { from: awayDay(from, locale, today), to: toLabel }
}

/** Short weekday names for ISO days, Monday 1 to Sunday 7: "Fri". */
export function awayWeekdays(isoDays: readonly number[], locale: string): string[] {
  const f = new Intl.DateTimeFormat(intlLocale(locale), { weekday: "short", timeZone: "UTC" })
  // 2024-01-01 was a Monday.
  return isoDays.map((n) => f.format(new Date(Date.UTC(2024, 0, n, 12))))
}
