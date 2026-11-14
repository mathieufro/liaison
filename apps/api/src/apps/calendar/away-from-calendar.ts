// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AWAY FROM THE PERSON'S OWN CALENDAR. After each sync of a calendar, its events are read for
// what they say about the person's away days, and modules/users/away.ts (the one writer of
// kernel.away_ranges) records it. Only the person's own primary calendar on their personal
// connection counts: never a calendar subscribed from a colleague, never an org account's.
//
// An out-of-office the person made, covering at least one whole working day, counts at once.
// An all-day event that looks like leave is asked about once and counts for nothing until Yes.
// Part-day events, focus time, working location, birthdays and Gmail events count for nothing.
// The title is read here to classify and then dropped: no kernel row or event holds it.

import {
  type AttentionItem,
  type CalendarPointLike,
  calendarPointToDate,
  expandRecurrence,
  utcDateString,
} from "@liaison/shared"
import { sql } from "drizzle-orm"
import type { GoogleEventItem } from "~/apps/calendar/sync"
import type { RlsClient } from "~/db"
import { extractRows, type PrivilegedDb } from "~/db"
import { privilegedFrom, withSystemDb } from "~/db/privileged"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { type WorkHoursPrefs, wholeWorkingDays } from "~/modules/attention/work-hours"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"
import {
  applyCalendarAwayEffects,
  type CalendarAwayEffect,
  type CalendarAwayOutcome,
  type CalendarAwayPerson,
  readCalendarAwayPerson,
} from "~/modules/users/away"

/** How far ahead a recurring series is kept as one row per occurrence. */
export const CALENDAR_AWAY_HORIZON_DAYS = 60

/** Words that make an all-day event worth asking about, matched on whole words, accents folded. */
const LEAVE_WORDS =
  /\b(vacances|conges?|rtt|holidays?|vacations?|leave|pto|out of office|absent|absente)\b/

/** Google event types that never say someone is away. */
const NEVER_AWAY = new Set(["focusTime", "workingLocation", "birthday", "fromGmail"])

type Reader = Pick<RlsClient, "execute">
type DbHandle = Reader & {
  /** A savepoint on the caller's transaction (RlsClient and PrivilegedDb alike). */
  transaction: <T>(fn: (tx: Reader) => Promise<T>) => Promise<T>
}

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
}

/** True when the title looks like leave. The title goes no further than this test. */
export function looksLikeLeave(title: string | undefined | null): boolean {
  return title ? LEAVE_WORDS.test(fold(title)) : false
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function prefsOf(person: CalendarAwayPerson): WorkHoursPrefs {
  return {
    workHoursStart: person.workHoursStart,
    workHoursEnd: person.workHoursEnd,
    workDays: person.workDays,
    timezone: person.timezone,
  }
}

/** What one event says, from the event alone. `ref` is the row's link to it. */
export function classifyCalendarItem(
  item: GoogleEventItem,
  calendarId: string,
  person: CalendarAwayPerson,
): CalendarAwayEffect {
  const ref = `${calendarId}:${item.id}`
  const organised = item.organizer?.self === true
  const base = { ref, googleEventId: item.id, organised }
  if (item.status === "cancelled") return { ...base, kind: "cancelled" }
  const type = item.eventType ?? "default"
  if (NEVER_AWAY.has(type)) return { ...base, kind: "none" }
  const allDay = Boolean(item.start?.date && !item.start?.dateTime)

  if (type === "outOfOffice") {
    // Marked away by a delegate on the person's calendar does not count: set_away has its rules.
    if (!organised && item.creator?.self !== true) return { ...base, kind: "none" }
    const start = allDay
      ? localMidnight(item.start?.date, person.timezone)
      : calendarPointToDate(item.start)
    const end = allDay
      ? localMidnight(item.end?.date, person.timezone)
      : calendarPointToDate(item.end)
    if (!start || !end) return { ...base, kind: "none" }
    const days = wholeWorkingDays(start, end, prefsOf(person))
    const first = days[0]
    const last = days[days.length - 1]
    if (!first || !last) return { ...base, kind: "none" }
    return { ...base, organised: true, kind: "active", startsOn: first, endsOn: last }
  }

  if (type !== "default" || !allDay) return { ...base, kind: "none" }
  const me = (item.attendees ?? []).find((a) => a.self === true)
  const accepted = me?.responseStatus === "accepted"
  if (!organised && !accepted) return { ...base, kind: "none" }
  if (!looksLikeLeave(item.summary)) return { ...base, kind: "none" }
  const startsOn = item.start?.date
  const endExclusive = item.end?.date
  if (!startsOn || !endExclusive || endExclusive <= startsOn) return { ...base, kind: "none" }
  return { ...base, kind: "ask", startsOn, endsOn: addDays(endExclusive, -1) }
}

/** Midnight of a `YYYY-MM-DD` in the person's zone, as an instant. */
function localMidnight(date: string | undefined, timezone: string): Date | null {
  if (!date) return null
  const guess = new Date(`${date}T00:00:00Z`)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(guess)
  const m: Record<string, string> = {}
  for (const p of parts) if (p.type !== "literal") m[p.type] = p.value
  const seen = Date.UTC(
    Number(m.year),
    Number(m.month) - 1,
    Number(m.day),
    Number(m.hour),
    Number(m.minute),
  )
  return new Date(guess.getTime() - (seen - guess.getTime()))
}

/** Google's id of one occurrence, as `googleInstanceId` in sync.ts builds it. */
function instanceId(masterId: string, start: Date, allDay: boolean): string {
  const iso = start.toISOString()
  const day = iso.slice(0, 10).replace(/-/g, "")
  return allDay
    ? `${masterId}_${day}`
    : `${masterId}_${day}T${iso.slice(11, 19).replace(/:/g, "")}Z`
}

function isMaster(item: GoogleEventItem): boolean {
  return !item.recurringEventId && Array.isArray(item.recurrence) && item.recurrence.length > 0
}

/**
 * Whose own primary calendar this is: the person, when the calendar is the primary one of
 * their own personal connection (its id is the account's address). Otherwise nobody.
 */
async function ownerOfPrimary(
  db: Reader,
  orgId: string,
  calendarId: string,
): Promise<string | null> {
  const rows = extractRows<{
    gid: string
    email: string
    owner_type: string
    owner_id: string | null
  }>(
    await db.execute(sql`
      SELECT c.google_calendar_id AS gid, a.email_address AS email, a.owner_type, a.owner_id
      FROM ${sql.raw(schemaRef("app_calendar"))}.calendars c
      JOIN ${sql.raw(schemaRef("app_calendar"))}.accounts a ON a.id = c.account_id AND a.org_id = c.org_id
      WHERE c.org_id = ${orgId}::uuid AND c.id = ${calendarId}::uuid AND a.disconnected_at IS NULL`),
  )
  const row = rows[0]
  if (!row || row.owner_type !== "user" || !row.owner_id) return null
  return row.gid.toLowerCase() === row.email.toLowerCase() ? row.owner_id : null
}

/** The stored exceptions of a series: their own rows decide those occurrences. */
async function exceptionIds(
  db: Reader,
  orgId: string,
  calendarId: string,
  masterId: string,
): Promise<Set<string>> {
  const rows = extractRows<{ id: string }>(
    await db.execute(sql`
      SELECT google_event_id AS id FROM ${sql.raw(schemaRef("app_calendar"))}.events
      WHERE org_id = ${orgId}::uuid AND calendar_id = ${calendarId}::uuid
        AND recurring_event_id = ${masterId} AND google_event_id IS NOT NULL`),
  )
  return new Set(rows.map((r) => r.id))
}

/**
 * Reads what `items` (one sync's events of one calendar) say about the person's away days and
 * records it. Runs after the events are stored; never fails the sync: a failure is logged and
 * the next sync or the daily refresh reads the events again.
 *
 * The away rows are written on the sync's own transaction, in a savepoint (privilegedFrom:
 * as it is when privileged, elevated in place when its login may, its own transaction
 * otherwise), so a sync holding a privileged slot never asks for a second one.
 */
export async function applyAwayFromCalendar(
  db: DbHandle,
  orgId: string,
  calendarId: string,
  allItems: readonly GoogleEventItem[],
  now: Date = new Date(),
): Promise<CalendarAwayOutcome | null> {
  // Only these events can say anything about away days; a page of meetings costs no read.
  const items = allItems.filter(
    (i) =>
      i.status === "cancelled" ||
      i.eventType === "outOfOffice" ||
      Boolean(i.start?.date && !i.start?.dateTime) ||
      (Array.isArray(i.recurrence) && i.recurrence.length > 0),
  )
  if (items.length === 0) return null
  try {
    const personId = await ownerOfPrimary(db, orgId, calendarId)
    if (!personId) return null
    return await db.transaction((savepoint) =>
      privilegedFrom(savepoint, orgId, "away-calendar-apply", (ptx) =>
        applyForPerson(savepoint, ptx, orgId, calendarId, personId, items, now),
      ),
    )
  } catch (err) {
    log.warn({ err, orgId, calendarId }, "could not read away days from the calendar")
    return null
  }
}

/** The effects of `items` on `personId`'s calendar rows, read and written on `ptx`. */
async function applyForPerson(
  db: Reader,
  ptx: PrivilegedDb,
  orgId: string,
  calendarId: string,
  personId: string,
  items: readonly GoogleEventItem[],
  now: Date,
): Promise<CalendarAwayOutcome | null> {
  const person = await readCalendarAwayPerson(ptx, orgId, personId)
  if (!person) return null
  const effects: CalendarAwayEffect[] = []
  const seriesRefs: Array<{ prefix: string; keep: Set<string>; cancelled?: boolean }> = []
  const windowStart = new Date(now.getTime() - 86_400_000)
  const windowEnd = new Date(now.getTime() + CALENDAR_AWAY_HORIZON_DAYS * 86_400_000)
  // Series first, then single events and exceptions, so an exception has the last word.
  const ordered = [...items.filter(isMaster), ...items.filter((i) => !isMaster(i))]
  const inBatch = new Set(items.map((i) => i.id))
  for (const item of ordered) {
    if (!isMaster(item)) {
      effects.push(classifyCalendarItem(item, calendarId, person))
      continue
    }
    const prefix = `${calendarId}:${item.id}_`
    if (item.status === "cancelled") {
      seriesRefs.push({ prefix, keep: new Set(), cancelled: true })
      continue
    }
    const allDay = Boolean(item.start?.date && !item.start?.dateTime)
    const { occurrences } = expandRecurrence(
      { start: item.start, end: item.end, recurrence: item.recurrence },
      windowStart,
      windowEnd,
    )
    const exceptions = await exceptionIds(db, orgId, calendarId, item.id)
    const keep = new Set<string>()
    for (const occ of occurrences) {
      const id = instanceId(item.id, occ.start, allDay)
      keep.add(`${calendarId}:${id}`)
      if (exceptions.has(id) || inBatch.has(id)) continue
      const point = (at: Date): CalendarPointLike =>
        allDay ? { date: utcDateString(at) } : { dateTime: at.toISOString() }
      const { recurrence: _r, ...single } = item
      effects.push(
        classifyCalendarItem(
          {
            ...single,
            id,
            start: point(occ.start),
            end: point(occ.end),
            recurringEventId: item.id,
          } as GoogleEventItem,
          calendarId,
          person,
        ),
      )
    }
    for (const id of exceptions) keep.add(`${calendarId}:${id}`)
    seriesRefs.push({ prefix, keep })
  }
  return await applyCalendarAwayEffects(ptx, orgId, personId, effects, { seriesRefs, now })
}

interface StoredEventRow {
  google_event_id: string
  status: string
  title: string | null
  start: GoogleEventItem["start"] | null
  end: GoogleEventItem["end"] | null
  recurrence: string[] | null
  recurring_event_id: string | null
  organizer_self: boolean | null
  attendees: GoogleEventItem["attendees"] | null
  event_type: string | null
}

/**
 * Reads the calendar's stored events again: extends recurring series to the next 60 days and
 * asks about leave-looking events that waited behind the three open questions. The daily job,
 * and the one read of a calendar connected before away days existed.
 */
export async function refreshAwayFromStoredEvents(
  db: DbHandle,
  orgId: string,
  calendarId: string,
  now: Date = new Date(),
): Promise<CalendarAwayOutcome | null> {
  const rows = extractRows<StoredEventRow>(
    await db.execute(sql`
      SELECT google_event_id, status, title, start, "end", recurrence, recurring_event_id,
        organizer_self, attendees, event_type
      FROM ${sql.raw(schemaRef("app_calendar"))}.events
      WHERE org_id = ${orgId}::uuid AND calendar_id = ${calendarId}::uuid
        AND google_event_id IS NOT NULL AND deleted_at IS NULL
        AND (all_day OR event_type = 'outOfOffice' OR recurrence IS NOT NULL)`),
  )
  const items: GoogleEventItem[] = rows.map((r) => ({
    id: r.google_event_id,
    status: r.status,
    ...(r.title ? { summary: r.title } : {}),
    ...(r.start ? { start: r.start } : {}),
    ...(r.end ? { end: r.end } : {}),
    ...(Array.isArray(r.recurrence) ? { recurrence: r.recurrence } : {}),
    ...(r.recurring_event_id ? { recurringEventId: r.recurring_event_id } : {}),
    organizer: r.organizer_self ? { self: true } : {},
    ...(Array.isArray(r.attendees) ? { attendees: r.attendees } : {}),
    ...(r.event_type ? { eventType: r.event_type } : {}),
  }))
  return applyAwayFromCalendar(db, orgId, calendarId, items, now)
}

/** The daily job: every personal primary calendar, each in its own system transaction. */
export async function refreshCalendarAwayAll(
  now: Date = new Date(),
): Promise<{ calendars: number }> {
  // An org being moved is left as it is until the move ends.
  const calendars = await sweepSkippingMoving((notMoving) =>
    withSystemDb("calendar-away-list", async (tx) =>
      extractRows<{ org_id: string; id: string }>(
        await tx.execute(sql`
          SELECT c.org_id, c.id FROM ${sql.raw(schemaRef("app_calendar"))}.calendars c
          JOIN ${sql.raw(schemaRef("app_calendar"))}.accounts a ON a.id = c.account_id AND a.org_id = c.org_id
          WHERE a.owner_type = 'user' AND a.disconnected_at IS NULL
            AND lower(c.google_calendar_id) = lower(a.email_address)
            AND ${notMoving(sql.raw("c.org_id"))}`),
      ),
    ),
  ).catch((err: unknown) => {
    // No calendar app registered on this instance: nothing to read.
    log.debug({ err }, "calendar away refresh: no calendar tables")
    return [] as Array<{ org_id: string; id: string }>
  })
  for (const c of calendars) {
    await withSystemDb("calendar-away-refresh", (tx) =>
      refreshAwayFromStoredEvents(tx, c.org_id, c.id, now),
    ).catch((err: unknown) => log.warn({ err, orgId: c.org_id }, "calendar away refresh failed"))
  }
  return { calendars: calendars.length }
}

interface AwayCalendarMeta {
  kind?: string
  calendarId?: string
  googleEventId?: string
  title?: string
}

/**
 * The Home feed's asked lines show the event's title, read now from the viewer's own calendar
 * under their own access, so it is never stored with the line. Only the feed's HTTP answer
 * carries it: the Home brief reads the stored lines, which hold dates only.
 */
export async function withLiveCalendarTitles(
  actor: ActorContext,
  items: AttentionItem[],
): Promise<void> {
  const asked = items.filter((i) => {
    const m = (i.metadata as { awayCalendar?: AwayCalendarMeta } | undefined)?.awayCalendar
    return m?.kind === "asked" && m.calendarId && m.googleEventId
  })
  if (asked.length === 0 || actor.actorType !== "user") return
  try {
    await withRlsContext(actor, async (tx) => {
      for (const item of asked) {
        const m = (item.metadata as { awayCalendar: AwayCalendarMeta }).awayCalendar
        const id = m.googleEventId as string
        const master = id.includes("_") ? id.slice(0, id.lastIndexOf("_")) : id
        const row = extractRows<{ title: string | null }>(
          await tx.execute(sql`
            SELECT title FROM ${sql.raw(schemaRef("app_calendar"))}.events
            WHERE org_id = ${actor.orgId}::uuid AND calendar_id = ${m.calendarId}::uuid
              AND google_event_id IN (${id}, ${master}) AND deleted_at IS NULL
            ORDER BY (google_event_id = ${id}) DESC LIMIT 1`),
        )[0]
        if (row?.title) m.title = row.title
      }
    })
  } catch (err) {
    // The line still reads, with its dates and without the title.
    log.warn({ err, orgId: actor.orgId }, "could not read calendar titles for Home")
  }
}
