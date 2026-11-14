// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The story clock: every date a world pack seeds is a role relative to one
// anchor (the seed's `now`), read on the company's Paris calendar, never an
// absolute date. "Three days ago at 14:30", "the third working day of last
// month", "this month's seventh renewal" stay true whatever day the pool
// seeds the org, so the story reads the same at any anchor.
//
// Rules:
// - An instant asked in the past (a day offset of zero or less) never passes
//   the anchor: a past row asked at a wall time later than the anchor's
//   stops at the anchor.
// - An instant that must fall in this month stays between the month's start
//   and the anchor, in order, however little of the month has run.
// - Only this month's event times clamp to working hours. A row asked at a
//   day offset keeps the anchor's wall time, night included.
//
// Pure: no database, no wall clock. Built on `seedClock` for elapsed time.
import { type SeedClock, seedClock } from "~/seed/clock"

/** The company's calendar: every wall time and month boundary is read here. */
export const STORY_TIME_ZONE = "Europe/Paris"

/** Working hours for this month's events, Paris wall time, in minutes. */
const WORK_START_MIN = 9 * 60
const WORK_END_MIN = 18 * 60

/** How pack prose shows a date. */
export type StoryDateStyle = "date" | "dayMonth" | "weekday"

export interface StoryClock {
  /** The anchor every instant is computed from. */
  anchor: Date
  /** The elapsed-time clock on the same anchor. */
  seed: SeedClock
  /** `n` calendar days from the anchor (negative in the past) at that Paris wall time, else the anchor's. */
  d: (n: number, hhmm?: string) => Date
  /** `n` hours of elapsed time from the anchor. */
  h: (n: number) => Date
  /** Instant `i` (0-based) of `of` inside this month, between the month's start and the anchor, in order. */
  thisMonthEvent: (i: number, of: number) => Date
  /** The k-th weekday (Monday to Friday) of last month; negative k counts from the end. */
  lastMonthWeekday: (k: number, hhmm?: string) => Date
  /** Day k of next week, 1 for Monday to 7 for Sunday. */
  nextWeekDay: (k: number, hhmm?: string) => Date
  /** The first date of that month and day strictly after the anchor's date. */
  yearFirst: (month: number, day: number, hhmm?: string) => Date
  /** The display string for a date in a pack's seeded prose. */
  fmt: (date: Date, locale: string, style?: StoryDateStyle) => string
  /** The anchor's month, `YYYY-MM`. */
  monthKey: () => string
}

interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  ms: number
}

const partsFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: STORY_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
})

/** The Paris wall time of an instant. */
function wallOf(date: Date): WallTime {
  const parts = partsFormat.formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? Number.NaN)
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    ms: date.getUTCMilliseconds(),
  }
}

/** Paris offset from UTC at an instant, in ms. */
function offsetAt(ms: number): number {
  const w = wallOf(new Date(ms))
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.ms) - ms
}

/**
 * The instant of a Paris wall time. Day and month overflow normalise as in
 * `Date.UTC`, so `day + n` is calendar arithmetic. A wall time skipped by the
 * spring change resolves past the gap.
 */
function parisInstant(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  const first = asUtc - offsetAt(asUtc)
  return new Date(asUtc - offsetAt(first))
}

/** The civil date `n` days after a civil date. */
function addDays(year: number, month: number, day: number, n: number) {
  const at = new Date(Date.UTC(year, month - 1, day + n))
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() }
}

/** ISO weekday of a civil date, 1 Monday to 7 Sunday. */
function isoWeekday(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return dow === 0 ? 7 : dow
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function parseHhmm(hhmm: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm)
  if (!m) throw new RangeError(`story clock: wall time "${hhmm}" is not HH:MM (00:00 to 23:59)`)
  return { hour: Number(m[1]), minute: Number(m[2]) }
}

const LOCALES: Record<string, string> = { en: "en-GB", fr: "fr-FR" }

const STYLES: Record<StoryDateStyle, Intl.DateTimeFormatOptions> = {
  date: { day: "numeric", month: "long", year: "numeric" },
  dayMonth: { day: "numeric", month: "short" },
  weekday: { weekday: "long", day: "numeric", month: "long" },
}

export function storyClock(anchor: Date): StoryClock {
  const seed = seedClock(anchor)
  const a = wallOf(anchor)
  const anchorMs = anchor.getTime()

  /** A civil date at a wall time, or at the anchor's wall time. */
  const at = (date: { year: number; month: number; day: number }, hhmm?: string): Date => {
    if (hhmm === undefined) {
      return parisInstant(date.year, date.month, date.day, a.hour, a.minute, a.second, a.ms)
    }
    const { hour, minute } = parseHhmm(hhmm)
    return parisInstant(date.year, date.month, date.day, hour, minute)
  }

  const d = (n: number, hhmm?: string): Date => {
    if (!Number.isInteger(n)) throw new RangeError(`story clock: day offset ${n} is not an integer`)
    const instant = at(addDays(a.year, a.month, a.day, n), hhmm)
    // A past instant never passes the anchor.
    if (n <= 0 && instant.getTime() > anchorMs) return new Date(anchorMs)
    return instant
  }

  let monthEvents: { of: number; at: number[] } | null = null
  const thisMonthEvents = (of: number): number[] => {
    if (monthEvents?.of === of) return monthEvents.at
    const start = parisInstant(a.year, a.month, 1).getTime()
    const span = anchorMs - start
    const out: number[] = []
    let prev = start
    let j = 0
    // Spread evenly over the month so far, each mapped into its day's working hours.
    for (; j < of; j++) {
      const raw = start + Math.floor(((j + 1) * span) / (of + 1))
      const w = wallOf(new Date(raw))
      const dayStart = parisInstant(w.year, w.month, w.day).getTime()
      const next = addDays(w.year, w.month, w.day, 1)
      const dayLen = parisInstant(next.year, next.month, next.day).getTime() - dayStart
      const work = parisInstant(w.year, w.month, w.day, 0, WORK_START_MIN).getTime()
      const workLen = (WORK_END_MIN - WORK_START_MIN) * 60_000
      const snapped = work + Math.floor(((raw - dayStart) / dayLen) * workLen)
      if (snapped <= prev || snapped > anchorMs) break
      out.push(snapped)
      prev = snapped
    }
    // Too little of the month has run for working hours: the rest share what is
    // left before the anchor, in order.
    const rest = of - j
    for (let m = 0; m < rest; m++) {
      out.push(prev + Math.floor(((m + 1) * (anchorMs - prev)) / (rest + 1)))
    }
    monthEvents = { of, at: out }
    return out
  }

  const thisMonthEvent = (i: number, of: number): Date => {
    if (!Number.isInteger(of) || of < 1)
      throw new RangeError(`story clock: event count ${of} must be a positive integer`)
    if (!Number.isInteger(i) || i < 0 || i >= of) {
      throw new RangeError(`story clock: event ${i} is outside 0 to ${of - 1}`)
    }
    return new Date(thisMonthEvents(of)[i] ?? anchorMs)
  }

  const lastMonthWeekday = (k: number, hhmm?: string): Date => {
    const year = a.month === 1 ? a.year - 1 : a.year
    const month = a.month === 1 ? 12 : a.month - 1
    const weekdays: number[] = []
    for (let day = 1; day <= daysInMonth(year, month); day++) {
      if (isoWeekday(year, month, day) <= 5) weekdays.push(day)
    }
    const index = k > 0 ? k - 1 : weekdays.length + k
    const day = Number.isInteger(k) && k !== 0 ? weekdays[index] : undefined
    if (day === undefined) {
      throw new RangeError(
        `story clock: last month has ${weekdays.length} weekdays, not a weekday ${k}`,
      )
    }
    return at({ year, month, day }, hhmm)
  }

  const nextWeekDay = (k: number, hhmm?: string): Date => {
    if (!Number.isInteger(k) || k < 1 || k > 7) {
      throw new RangeError(`story clock: day ${k} of next week is outside 1 (Monday) to 7 (Sunday)`)
    }
    const toMonday = 8 - isoWeekday(a.year, a.month, a.day)
    return at(addDays(a.year, a.month, a.day, toMonday + k - 1), hhmm)
  }

  const yearFirst = (month: number, day: number, hhmm?: string): Date => {
    const anchorKey = a.year * 10_000 + a.month * 100 + a.day
    // Eight years cover any day that exists, 29 February included.
    for (let year = a.year; year <= a.year + 8; year++) {
      if (day < 1 || month < 1 || month > 12 || day > daysInMonth(year, month)) continue
      if (year * 10_000 + month * 100 + day > anchorKey) return at({ year, month, day }, hhmm)
    }
    throw new RangeError(`story clock: no ${day}/${month} date ahead of the anchor`)
  }

  const fmt = (date: Date, locale: string, style: StoryDateStyle = "date"): string =>
    new Intl.DateTimeFormat(LOCALES[locale] ?? locale, {
      ...STYLES[style],
      timeZone: STORY_TIME_ZONE,
    })
      .format(date)
      .replace(/\.$/, "")

  return {
    anchor,
    seed,
    d,
    h: (n) => seed.hoursAfter(n),
    thisMonthEvent,
    lastMonthWeekday,
    nextWeekDay,
    yearFirst,
    fmt,
    monthKey: () => `${a.year}-${String(a.month).padStart(2, "0")}`,
  }
}
