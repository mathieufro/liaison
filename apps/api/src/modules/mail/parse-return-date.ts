// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The date an out-of-office message says its author is back. Pure and
 * deterministic: a hold is computed from the message at each check and never
 * stored, so it cannot get stuck.
 */
import { DateTime } from "luxon"

const WINDOW_DAYS = 60
const DEFAULT_HOLD_MS = 7 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** An out-of-office says its date near the top; the rest is a quoted thread. */
const SCAN_CHARS = 20_000

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  janvier: 1,
  janv: 1,
  february: 2,
  feb: 2,
  février: 2,
  fevrier: 2,
  févr: 2,
  fév: 2,
  fev: 2,
  march: 3,
  mar: 3,
  mars: 3,
  april: 4,
  apr: 4,
  avril: 4,
  avr: 4,
  may: 5,
  mai: 5,
  june: 6,
  jun: 6,
  juin: 6,
  july: 7,
  jul: 7,
  juillet: 7,
  juil: 7,
  august: 8,
  aug: 8,
  août: 8,
  aout: 8,
  september: 9,
  sept: 9,
  sep: 9,
  septembre: 9,
  october: 10,
  oct: 10,
  octobre: 10,
  november: 11,
  nov: 11,
  novembre: 11,
  december: 12,
  dec: 12,
  décembre: 12,
  decembre: 12,
  déc: 12,
}

const MONTH = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|")
const WEEKDAY =
  "monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche"
/** Leads that name the last day away: the person is back the day after. */
const UNTIL_LEAD = "until|till|jusqu'(?:au|à)"
/** Leads that name the day the person is back. */
const BACK_LEAD =
  "back(?: at work| in the office)?(?: on)?|return(?:ing)?(?: to (?:work|the office))?(?: on)?|de retour(?: au bureau)?(?: le)?|retour(?: au bureau)?(?: le)?"

const LED_DATE = new RegExp(
  `\\b(?:(?<until>${UNTIL_LEAD})|${BACK_LEAD})(?: ?:)? (?:(?:the|le) )?(?:(?:${WEEKDAY}),? )?(?:(?:the|le) )?(?:` +
    "(?<isoY>\\d{4})-(?<isoM>\\d{2})-(?<isoD>\\d{2})" +
    "|(?<slashA>\\d{1,2})/(?<slashB>\\d{1,2})(?:/(?<slashY>\\d{4}|\\d{2}))?" +
    `|(?<nameD>\\d{1,2})(?:st|nd|rd|th|er|e|ème|eme)? (?:of )?(?<nameM>${MONTH})\\b\\.?,?(?: (?<nameY>\\d{4}))?` +
    `|(?<leadM>${MONTH})\\b\\.? (?<leadD>\\d{1,2})(?:st|nd|rd|th)?,?(?: (?<leadY>\\d{4}))?` +
    ")(?![\\d/])",
  "g",
)
const BARE_ISO = /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g

export interface ReturnDate {
  /** `YYYY-MM-DD` as the message states it, or null when the default applies. */
  returnDate: string | null
  /** The instant the hold ends. */
  holdUntil: Date
}

/** Milliseconds of a calendar day at UTC midnight, or null if it does not exist. */
function calendarDay(year: number, month: number, day: number): number | null {
  const ms = Date.UTC(year, month - 1, day)
  const date = new Date(ms)
  const exists =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  return exists ? ms : null
}

function usableZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC"
  return DateTime.now().setZone(timeZone).isValid ? timeZone : "UTC"
}

function readableText(text: string): string {
  return text
    .slice(0, SCAN_CHARS)
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith(">"))
    .join(" ")
    .normalize("NFC")
    .replace(/[’ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .toLowerCase()
}

/** A date as written. With no year it means its next occurrence. */
type Candidate = { month: number; day: number; year?: number }

function candidatesOf(
  groups: Record<string, string | undefined>,
  monthFirst: boolean,
): Candidate[] {
  if (groups.isoY) {
    return [{ year: Number(groups.isoY), month: Number(groups.isoM), day: Number(groups.isoD) }]
  }
  if (groups.slashA) {
    const a = Number(groups.slashA)
    const b = Number(groups.slashB)
    const rawYear = groups.slashY
    const year = rawYear ? Number(rawYear.length === 2 ? `20${rawYear}` : rawYear) : undefined
    const dayFirst = { day: a, month: b, year }
    const usFirst = { day: b, month: a, year }
    return monthFirst ? [usFirst, dayFirst] : [dayFirst, usFirst]
  }
  const name = groups.nameM ?? groups.leadM ?? ""
  const rawYear = groups.nameY ?? groups.leadY
  return [
    {
      month: MONTHS[name] ?? 0,
      day: Number(groups.nameD ?? groups.leadD),
      year: rawYear ? Number(rawYear) : undefined,
    },
  ]
}

/**
 * @param text the cleartext body; null on a sealed mailbox
 * @param sentAt when the auto-reply was sent
 * @param locale the requester's, which decides how `03/12` reads
 * @param timeZone the requester's; UTC when missing or unreadable
 * @throws RangeError when `sentAt` is not a date, so the caller's check fails
 *   closed instead of reading a hold that ends at no time at all
 */
export function parseReturnDate(
  text: string | null,
  sentAt: Date,
  locale?: string | null,
  timeZone?: string | null,
): ReturnDate {
  if (Number.isNaN(sentAt.getTime())) throw new RangeError("sentAt is not a date")
  const zone = usableZone(timeZone)
  const fallback = { returnDate: null, holdUntil: new Date(sentAt.getTime() + DEFAULT_HOLD_MS) }
  if (!text) return fallback

  const sent = DateTime.fromJSDate(sentAt, { zone })
  const sentDay = Date.UTC(sent.year, sent.month - 1, sent.day)

  /** The calendar day of a candidate, when it falls inside the window. */
  const accept = ({ year, month, day }: Candidate): number | null => {
    const years = year === undefined ? [sent.year, sent.year + 1] : [year]
    for (const y of years) {
      const ms = calendarDay(y, month, day)
      if (ms === null || ms <= sentDay) continue
      return ms - sentDay <= WINDOW_DAYS * DAY_MS ? ms : null
    }
    return null
  }

  const body = readableText(text)
  const monthFirst = /^en[-_]us\b/i.test(locale ?? "")
  let accepted: number | null = null
  // "Until 16 Nov" names the last day away, so the hold runs to the next morning;
  // "back on 17 Nov" names the day itself, so the hold ends that morning.
  let lastDayAway = true
  for (const match of body.matchAll(LED_DATE)) {
    for (const candidate of candidatesOf(match.groups ?? {}, monthFirst)) {
      // A real date outside the window is refused as it stands: reading `01/11`
      // the other way round would invent a date the sender did not mean.
      if (calendarDay(candidate.year ?? 2000, candidate.month, candidate.day) === null) continue
      accepted = accept(candidate)
      lastDayAway = match.groups?.until !== undefined
      break
    }
    if (accepted !== null) break
  }
  // An ISO date with no lead word: for a range, the end of it, the last day away.
  if (accepted === null) {
    lastDayAway = true
    for (const [, y, m, d] of body.matchAll(BARE_ISO)) {
      const ms = accept({ year: Number(y), month: Number(m), day: Number(d) })
      if (ms !== null && (accepted === null || ms > accepted)) accepted = ms
    }
  }
  if (accepted === null) return fallback

  const date = new Date(accepted)
  const holdUntil = DateTime.fromObject(
    { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() },
    { zone },
  )
    .plus({ days: lastDayAway ? 1 : 0 })
    .startOf("day")
  return {
    returnDate: date.toISOString().slice(0, 10),
    holdUntil: holdUntil.toJSDate(),
  }
}
