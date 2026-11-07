// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "Not now" on a Home item: a persisted attention event leaves the feed until
 * the next Monday at 00:00 in the person's own time zone, then comes back by
 * itself (the event provider reads `set_aside_until`). Set on a Monday, it is
 * the Monday after, never that same day.
 */

const DEFAULT_ZONE = "UTC"

/** A zone the runtime knows, or UTC. */
function validZone(timeZone: string | null | undefined): string {
  if (!timeZone) return DEFAULT_ZONE
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0)
    return timeZone
  } catch {
    return DEFAULT_ZONE
  }
}

interface WallClock {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 1 = Monday ... 7 = Sunday. */
  isoWeekday: number
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

function wallClock(at: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  }).formatToParts(at)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0"
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    isoWeekday: WEEKDAYS[get("weekday")] ?? 1,
  }
}

/** The zone's offset from UTC at an instant, in milliseconds. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const w = wallClock(at, timeZone)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** The instant a wall-clock midnight falls on in a zone. */
function midnightIn(year: number, month: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0)
  let instant = guess - zoneOffsetMs(new Date(guess), timeZone)
  // The offset at the guess and at midnight differ when a clock change lies between them.
  instant = guess - zoneOffsetMs(new Date(instant), timeZone)
  return new Date(instant)
}

/** The next Monday 00:00 in `timeZone` strictly after `now` (UTC when the zone is unknown). */
export function nextMondayStart(now: Date, timeZone: string | null | undefined): Date {
  const zone = validZone(timeZone)
  const today = wallClock(now, zone)
  const daysAhead = 8 - today.isoWeekday // Monday: 7, Sunday: 1
  const target = new Date(Date.UTC(today.year, today.month - 1, today.day + daysAhead))
  return midnightIn(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), zone)
}
