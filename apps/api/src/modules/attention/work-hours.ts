// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Work-hours helpers. A user's work-hours schedule is stored as two `HH:MM`
 * strings in the user's IANA timezone plus a `workDays` array of ISO weekday
 * numbers (1=Mon … 7=Sun). The window can cross midnight (e.g. 22:00–08:00 for
 * night shifts). Identical start/end is treated as "all 24 hours" of each
 * selected work day — combined with all seven `workDays` this is the way to
 * disable gating entirely.
 *
 * Non-urgent attention events arriving outside the schedule defer to the next
 * window open via `nextWorkWindowStart`; events arriving inside flow through to
 * the digest worker immediately.
 */

export interface WorkHoursPrefs {
  workHoursStart: string
  workHoursEnd: string
  workDays: number[]
  timezone: string
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number // ISO: 1=Mon … 7=Sun
}

function isoWeekday(date: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" })
  const short = fmt.format(date)
  // Mon Tue Wed Thu Fri Sat Sun → 1..7
  return ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[
    short
  ]!
}

function getLocalParts(date: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  const parts = fmt.formatToParts(date)
  const map: Record<string, string> = {}
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: isoWeekday(date, tz),
  }
}

function parseHHmm(s: string): { h: number; m: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(s)
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return { h, m }
}

/**
 * Build a Date corresponding to the given local Y/M/D hh:mm in tz.
 * Uses a two-pass iteration to converge through DST offsets.
 */
function utcFromLocal(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  let guess = new Date(Date.UTC(y, mo - 1, d, h, mi, 0, 0))
  for (let i = 0; i < 2; i++) {
    const lp = getLocalParts(guess, tz)
    const targetUtc = Date.UTC(y, mo - 1, d, h, mi, 0, 0)
    const observedUtc = Date.UTC(lp.year, lp.month - 1, lp.day, lp.hour, lp.minute, 0, 0)
    const diff = targetUtc - observedUtc
    if (diff === 0) break
    guess = new Date(guess.getTime() + diff)
  }
  return guess
}

function minutesOfDay(h: number, m: number): number {
  return h * 60 + m
}

function isWithinHours(curMinutes: number, s: number, e: number): boolean {
  // start == end → "all 24 hours" of the work day
  if (s === e) return true
  if (s < e) return curMinutes >= s && curMinutes < e
  // Window crosses midnight: in window when after start OR before end.
  return curMinutes >= s || curMinutes < e
}

/**
 * True iff non-urgent email should be deferred — i.e. the user is outside their
 * work-hours window right now.
 *
 * A midnight-crossing window is anchored to its start day: for 22:00–08:00 with
 * `workDays = [1..5]`, Monday 23:00 is still "inside the Monday window" and
 * Saturday 03:00 is still "inside the Friday window".
 */
export function isOutsideWorkWindow(now: Date, prefs: WorkHoursPrefs): boolean {
  const start = parseHHmm(prefs.workHoursStart)
  const end = parseHHmm(prefs.workHoursEnd)
  if (!start || !end) return false // malformed — fail open (treat as inside)
  if (prefs.workDays.length === 0) return true

  const local = getLocalParts(now, prefs.timezone)
  const cur = minutesOfDay(local.hour, local.minute)
  const s = minutesOfDay(start.h, start.m)
  const e = minutesOfDay(end.h, end.m)
  const workDaySet = new Set(prefs.workDays)

  // Midnight-crossing window where cur is in the early-morning tail belongs to
  // the previous local day's window.
  if (s !== e && s > e && cur < e) {
    const yesterdayIso = local.weekday === 1 ? 7 : local.weekday - 1
    return !workDaySet.has(yesterdayIso)
  }

  if (!workDaySet.has(local.weekday)) return true
  return !isWithinHours(cur, s, e)
}

/**
 * Returns the UTC date when the user's work-hours window next opens. If the
 * user is currently inside the window, returns `now`. Skips non-workdays.
 */
export function nextWorkWindowStart(now: Date, prefs: WorkHoursPrefs): Date {
  if (!isOutsideWorkWindow(now, prefs)) return now
  const start = parseHHmm(prefs.workHoursStart)
  if (!start) return now
  if (prefs.workDays.length === 0) return now

  const local = getLocalParts(now, prefs.timezone)
  const cur = minutesOfDay(local.hour, local.minute)
  const s = minutesOfDay(start.h, start.m)
  const workDaySet = new Set(prefs.workDays)

  // Probe today + the next seven days; pick the first work day whose start
  // time hasn't passed. Anchor each probe at local 12:00 (via utcFromLocal) so
  // converting back to local parts is stable across far-east tz like
  // Pacific/Kiritimati (UTC+14) where UTC-midnight would resolve to the
  // following local day and skew the weekday by one.
  for (let offset = 0; offset < 8; offset++) {
    const probeUtc = utcFromLocal(
      local.year,
      local.month,
      local.day + offset,
      12,
      0,
      prefs.timezone,
    )
    const lp = getLocalParts(probeUtc, prefs.timezone)
    if (!workDaySet.has(lp.weekday)) continue
    if (offset === 0 && cur >= s) continue // already past today's start
    return utcFromLocal(lp.year, lp.month, lp.day, start.h, start.m, prefs.timezone)
  }
  return now
}

/** `YYYY-MM-DD` plus `days`, on the calendar (no time zone involved). */
function addLocalDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * The person's work days, as local `YYYY-MM-DD` dates in their time zone, whose whole work
 * window lies inside [start, end). A window crossing midnight ends on the next day; a start
 * equal to its end is the whole day. Part of a work window is not a whole working day, so a
 * morning off counts for nothing.
 */
export function wholeWorkingDays(start: Date, end: Date, prefs: WorkHoursPrefs): string[] {
  const s = parseHHmm(prefs.workHoursStart)
  const e = parseHHmm(prefs.workHoursEnd)
  if (!s || !e || end.getTime() <= start.getTime()) return []
  const workDaySet = new Set(prefs.workDays)
  const first = getLocalParts(start, prefs.timezone)
  const out: string[] = []
  // A window that starts the day before `start` (night shift) cannot be whole, so the walk
  // starts on the local day of `start`, and stops once a window would open at or after `end`.
  let day = `${first.year}-${String(first.month).padStart(2, "0")}-${String(first.day).padStart(2, "0")}`
  for (let i = 0; i < 400; i++, day = addLocalDays(day, 1)) {
    const [y, mo, d] = day.split("-").map(Number) as [number, number, number]
    const open = utcFromLocal(y, mo, d, s.h, s.m, prefs.timezone)
    if (open.getTime() >= end.getTime()) break
    const sameDay = minutesOfDay(s.h, s.m) === minutesOfDay(e.h, e.m)
    const crosses = !sameDay && minutesOfDay(s.h, s.m) > minutesOfDay(e.h, e.m)
    const windowOpen = sameDay ? utcFromLocal(y, mo, d, 0, 0, prefs.timezone) : open
    const closeDay = sameDay || crosses ? addLocalDays(day, 1) : day
    const [cy, cmo, cd] = closeDay.split("-").map(Number) as [number, number, number]
    const close = sameDay
      ? utcFromLocal(cy, cmo, cd, 0, 0, prefs.timezone)
      : utcFromLocal(cy, cmo, cd, e.h, e.m, prefs.timezone)
    if (!workDaySet.has(isoWeekday(utcFromLocal(y, mo, d, 12, 0, prefs.timezone), prefs.timezone)))
      continue
    if (windowOpen.getTime() >= start.getTime() && close.getTime() <= end.getTime()) out.push(day)
  }
  return out
}

/**
 * The first work window that opens after the whole of local day `lastDay` (`YYYY-MM-DD`,
 * in the prefs' zone): where an away person's held mail is let go. A date that cannot be read
 * leaves the instant it was asked at to the caller.
 */
export function firstWorkWindowAfterDay(lastDay: string, prefs: WorkHoursPrefs): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastDay)
  if (!m) return null
  const midnight = utcFromLocal(Number(m[1]), Number(m[2]), Number(m[3]) + 1, 0, 0, prefs.timezone)
  return nextWorkWindowStart(midnight, prefs)
}
