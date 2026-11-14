// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One duration reader and one writer, for the Timebox and Took fields and for the agent's tools.

/** Minutes in a working day when an org has not said otherwise: 7 hours. */
export const DEFAULT_HOURS_PER_DAY_MINUTES = 420

const MAX_MINUTES = 60 * 24 * 366

function num(text: string): number | null {
  const n = Number(text.replace(",", "."))
  return Number.isFinite(n) ? n : null
}

function done(minutes: number): number | null {
  const rounded = Math.round(minutes)
  return rounded > 0 && rounded <= MAX_MINUTES ? rounded : null
}

const HALF_DAY =
  /^(?:(?:une?\s+)?demi[\s-]?journ[ée]e|half(?:\s+an?)?\s+day|half[\s-]day|1\s*\/\s*2\s*(?:days?|d|jours?|j))$/
const NUMBER = "(\\d+(?:[.,]\\d+)?)"
const DAYS = new RegExp(`^${NUMBER}\\s*(?:days?|d|jours?|j)$`)
const HOURS = new RegExp(`^${NUMBER}\\s*(?:hours?|hrs?|h)$`)
const MINUTES = new RegExp(`^${NUMBER}\\s*(?:minutes?|mins?|m)$`)
const HOURS_MINUTES = /^(\d+)\s*h\s*(\d{1,2})\s*(?:m|min|mins)?$/

/**
 * Minutes from what a person typed, or null when it cannot be read. A day is the org's hours in a
 * day (`hoursPerDayMinutes`), so "half a day" at 7 hours is 210. A bare number is not a duration.
 */
export function parseDuration(
  text: string,
  hoursPerDayMinutes: number = DEFAULT_HOURS_PER_DAY_MINUTES,
): number | null {
  if (typeof text !== "string") return null
  if (!Number.isFinite(hoursPerDayMinutes) || hoursPerDayMinutes <= 0) return null
  const t = text.trim().toLowerCase().replace(/\s+/g, " ")
  if (t === "") return null
  if (HALF_DAY.test(t)) return done(hoursPerDayMinutes / 2)
  let m = HOURS_MINUTES.exec(t)
  if (m) {
    const minutes = Number(m[2])
    return minutes < 60 ? done(Number(m[1]) * 60 + minutes) : null
  }
  m = DAYS.exec(t)
  if (m) return done((num(m[1] as string) ?? Number.NaN) * hoursPerDayMinutes)
  m = HOURS.exec(t)
  if (m) return done((num(m[1] as string) ?? Number.NaN) * 60)
  m = MINUTES.exec(t)
  if (m) return done(num(m[1] as string) ?? Number.NaN)
  return null
}

function trim(n: number): string {
  return String(Math.round(n * 10) / 10)
}

/**
 * Minutes as a person reads them. In days: "3 d" when whole, "7.5 d" at a half, "~1 d" when it
 * is only about that. In hours: "2 h", "1 h 30", "45 m".
 */
export function formatDuration(
  minutes: number,
  unit: "d" | "h",
  hoursPerDayMinutes: number = DEFAULT_HOURS_PER_DAY_MINUTES,
): string {
  if (unit === "d" && hoursPerDayMinutes > 0) {
    const days = minutes / hoursPerDayMinutes
    const halves = days * 2
    if (Math.abs(halves - Math.round(halves)) < 1e-9) return `${trim(Math.round(halves) / 2)} d`
    return `~${trim(Math.max(0.5, Math.round(halves) / 2))} d`
  }
  const whole = Math.round(minutes)
  const h = Math.floor(whole / 60)
  const m = whole % 60
  if (h === 0) return `${m} m`
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`
}
