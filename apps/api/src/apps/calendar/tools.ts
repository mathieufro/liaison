// SPDX-License-Identifier: FSL-1.1-ALv2
// Host-side agent tool logic for the calendar app (Task 7). Runs under the caller's RLS-scoped
// `RlsClient` so `list_calendars`/`list_events`/`search_events` automatically respect the
// `calendar:calaccess` membership dimension — personal calendars are visible only to their
// connecting user, org calendars to every org member. No manual visibility filtering here: RLS
// is the enforcement mechanism (Amendment 5).
import { calendarPointToDate, expandRecurrence } from "@liaison/shared"
import type { RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"

const CALENDAR_SCHEMA = () => schemaRef("app_calendar")

export interface CalendarListItem {
  id: string
  name: string
  color: string | null
  accessRole: string | null
  selected: boolean
}

/**
 * listCalendarsForCaller — every calendar of the caller's connected accounts, selected or not,
 * with its `selected` flag: the settings checkboxes are built from it, so an unticked calendar
 * must stay listed to be ticked again. Views that show events keep the selected ones. A
 * disconnected account's calendars are deleted with it (`onAccountDisconnected`), so they are
 * not here to filter out.
 */
export async function listCalendarsForCaller(
  db: RlsClient,
  orgId: string,
): Promise<CalendarListItem[]> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT id, name, color, access_role, selected
    FROM ${sql.raw(schema)}.calendars
    WHERE org_id = ${orgId}::uuid
    ORDER BY name
  `)) as unknown as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  return list.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    color: (r.color as string | null) ?? null,
    accessRole: (r.access_role as string | null) ?? null,
    selected: r.selected as boolean,
  }))
}

export interface CalendarAccountDto {
  id: string
  /** The kernel connection (`kernel.connected_accounts.id`) this account belongs to: what the
   * generic `DELETE /connections/:id` disconnect takes. `id` is the calendar app's own row. */
  connectedAccountId: string
  identifier: string
  displayName: string | null
  ownerType: string
  status: string
  /** Why the last import/sync failed (set with status 'error'), else null. */
  lastSyncError: string | null
  createdAt: string
}

/**
 * listAccountsForCaller — Settings-page account/connection listing. The generic kernel
 * connections list (`GET /connections/:appName`) deliberately excludes org-owned non-kernel
 * connections (they're meant to be read through the app's own sandboxed tools instead — see
 * `listConnections` in `modules/apps/connections/service.ts`), so calendar exposes this
 * app-specific tool for its Settings UI (mirrors mail's `listAccounts`). RLS (via `db`) already
 * scopes visibility: personal accounts to their owner, org accounts to every org member holding
 * the `calendar:calaccess` grant for that account id — no manual filtering needed here.
 */
export async function listAccountsForCaller(
  db: RlsClient,
  orgId: string,
): Promise<CalendarAccountDto[]> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const rows = (await db.execute(sql`
    SELECT id, connected_account_id, email_address, display_name, owner_type, sync_status,
           last_sync_error, created_at
    FROM ${sql.raw(schema)}.accounts
    WHERE org_id = ${orgId}::uuid AND disconnected_at IS NULL
    ORDER BY created_at
  `)) as unknown as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  return list.map((r) => ({
    id: r.id as string,
    connectedAccountId: r.connected_account_id as string,
    identifier: r.email_address as string,
    displayName: (r.display_name as string | null) ?? null,
    ownerType: r.owner_type as string,
    status: r.sync_status as string,
    lastSyncError: (r.last_sync_error as string | null) ?? null,
    createdAt:
      (r.created_at as Date | string) instanceof Date
        ? (r.created_at as Date).toISOString()
        : (r.created_at as string),
  }))
}

export interface EventOccurrence {
  eventId: string
  calendarId: string
  title: string | null
  start: unknown
  end: unknown
  allDay: boolean
  recurrenceComplex: boolean
}

/**
 * CalendarEventDto — the wire shape `list_events`/`search_events` return. Carries the FULL
 * field set (description/location/recurrence/recurringEventId/originalStartTime/status) so the
 * caller (UI client-side expander per Task 8, or an agent) can expand recurrence and populate an
 * edit form. `recurringEventId` is Google's master id (so exceptions join to their master by
 * Google id — the only stable cross-row key: local row UUIDs and Google ids never match). For a
 * recurring MASTER, `eventId` is the master's Google id too, so the client expander's
 * `exception.recurringEventId === master.eventId` join lines up. Non-recurring rows keep the
 * local UUID as `eventId` (used directly by the UI to open/edit them).
 */
export interface CalendarEventDto {
  eventId: string
  /** Google's id of the event (null until a local create reached Google). A recurring master's
   * is the id its exception rows carry in `recurringEventId`. */
  googleEventId: string | null
  calendarId: string
  title: string | null
  description: string | null
  location: string | null
  start: unknown
  end: unknown
  allDay: boolean
  recurrence: string[] | null
  recurringEventId: string | null
  originalStartTime: unknown
  status: string
  hangoutLink: string | null
  /** Who is invited, as Google reports them (absent fields omitted). */
  attendees: CalendarAttendeeDto[]
  /** Whether a guest-list change from this account would be applied by Google: the account
   * organizes the event (or it was created here), or the event lets guests modify it. */
  attendeesEditable: boolean
  /** Google's message when it refused this event's last change from Liaison; else null. */
  pushError: string | null
  /** Why a delete Google refused brought this event back; else null. */
  pushNotice: string | null
}

export interface CalendarAttendeeDto {
  email: string
  displayName?: string
  /** Google's responseStatus: needsAction | accepted | declined | tentative. */
  responseStatus?: string
  organizer?: boolean
  self?: boolean
  optional?: boolean
}

/** The stored attendee list (Google objects; legacy rows may hold bare emails) as DTOs. */
export function toAttendeeDtos(raw: unknown): CalendarAttendeeDto[] {
  if (!Array.isArray(raw)) return []
  const out: CalendarAttendeeDto[] = []
  for (const item of raw) {
    if (typeof item === "string") {
      if (item) out.push({ email: item })
      continue
    }
    if (!item || typeof item !== "object") continue
    const a = item as Record<string, unknown>
    if (typeof a.email !== "string" || !a.email) continue
    const dto: CalendarAttendeeDto = { email: a.email }
    if (typeof a.displayName === "string") dto.displayName = a.displayName
    if (typeof a.responseStatus === "string") dto.responseStatus = a.responseStatus
    if (typeof a.organizer === "boolean") dto.organizer = a.organizer
    if (typeof a.self === "boolean") dto.self = a.self
    if (typeof a.optional === "boolean") dto.optional = a.optional
    out.push(dto)
  }
  return out
}

export interface RawEventRow {
  id: string
  calendar_id: string
  google_event_id?: string | null
  title: string | null
  description: string | null
  location: string | null
  start: unknown
  end: unknown
  all_day: boolean
  recurrence: string[] | null
  recurring_event_id: string | null
  original_start_time: { date?: string; dateTime?: string } | null
  status: string
  hangout_link?: string | null
  attendees?: unknown
  organizer_self?: boolean | null
  guests_can_modify?: boolean | null
  push_error?: string | null
  push_notice?: string | null
}

function toDate(point: unknown): Date | null {
  return calendarPointToDate(point)
}

function overlapsWindow(row: RawEventRow, windowStart: Date, windowEnd: Date): boolean {
  const start = toDate(row.start)
  const end = toDate(row.end)
  return !!start && !!end && start < windowEnd && end > windowStart
}

function rowOccurrence(row: RawEventRow, recurrenceComplex: boolean): EventOccurrence {
  return {
    eventId: row.id,
    calendarId: row.calendar_id,
    title: row.title,
    start: row.start,
    end: row.end,
    allDay: row.all_day,
    recurrenceComplex,
  }
}

/**
 * expandRecurringEvent — the occurrences of a recurring master within [windowStart, windowEnd],
 * with its exceptions applied: an exception replaces the occurrence at its
 * `original_start_time` (a cancelled one removes it) and shows at its own time when that is in
 * the window. The rule arithmetic is `expandRecurrence` (@liaison/shared), the same the web
 * calendar uses. A complex (unsupported) rule yields the master's own occurrence, flagged.
 */
export function expandRecurringEvent(
  master: RawEventRow,
  exceptions: RawEventRow[],
  windowStart: Date,
  windowEnd: Date,
): EventOccurrence[] {
  const occurrences: EventOccurrence[] = []
  const replaced = new Set<number>()
  for (const ex of exceptions) {
    const original = toDate(ex.original_start_time)
    if (original) replaced.add(original.getTime())
    if (ex.status !== "cancelled" && overlapsWindow(ex, windowStart, windowEnd)) {
      occurrences.push(rowOccurrence(ex, false))
    }
  }
  const { complex, occurrences: series } = expandRecurrence(master, windowStart, windowEnd)
  if (complex) {
    if (overlapsWindow(master, windowStart, windowEnd))
      occurrences.push(rowOccurrence(master, true))
    return occurrences
  }
  for (const occ of series) {
    if (replaced.has(occ.start.getTime())) continue
    occurrences.push({
      eventId: master.id,
      calendarId: master.calendar_id,
      title: master.title,
      start: master.all_day
        ? { date: occ.start.toISOString().slice(0, 10) }
        : { ...(master.start as object), dateTime: occ.start.toISOString() },
      end: master.all_day
        ? { date: occ.end.toISOString().slice(0, 10) }
        : { ...(master.end as object), dateTime: occ.end.toISOString() },
      allDay: master.all_day,
      recurrenceComplex: false,
    })
  }
  return occurrences
}

export interface ListEventsParams {
  calendarId?: string
  timeMin: string
  timeMax: string
  /** Only events one of these addresses attends (one, or up to 50). */
  attendee?: string | string[]
}

/** The attendee filter's addresses, lowercased; null when none was asked for. */
export function attendeeFilter(value: unknown): Set<string> | null {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : []
  const emails = list
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .slice(0, 50)
    .map((v) => v.trim().toLowerCase())
  return emails.length > 0 ? new Set(emails) : null
}

/**
 * rowToDto — maps a raw events row to the wire DTO. The join key (`recurringEventId`) and a
 * recurring master's `eventId` are BOTH the Google id when present, so exceptions
 * (`recurring_event_id` = Google's master id) line up with their master client-side. A master
 * with no google_event_id yet (local-born, un-pushed) falls back to its local UUID — such a
 * master has no Google-authored exceptions to join against anyway.
 */
function rowToDto(row: RawEventRow): CalendarEventDto {
  const isRecurringMaster =
    row.recurring_event_id === null && Array.isArray(row.recurrence) && row.recurrence.length > 0
  return {
    eventId: isRecurringMaster ? (row.google_event_id ?? row.id) : row.id,
    googleEventId: row.google_event_id ?? null,
    calendarId: row.calendar_id,
    title: row.title,
    description: row.description,
    location: row.location,
    start: row.start,
    end: row.end,
    allDay: row.all_day,
    recurrence: row.recurrence,
    recurringEventId: row.recurring_event_id,
    originalStartTime: row.original_start_time,
    status: row.status,
    hangoutLink: row.hangout_link ?? null,
    attendees: toAttendeeDtos(row.attendees),
    attendeesEditable: row.organizer_self !== false || row.guests_can_modify === true,
    pushError: row.push_error ?? null,
    pushNotice: row.push_notice ?? null,
  }
}

/** SQL for a stored `{dateTime}` / `{date}` point column as timestamptz (an all-day date at
 * UTC midnight, like `calendarPointToDate`), NULL when the point is missing or unreadable. */
function pointTimestampSql(column: string): string {
  const c = column
  return `(CASE
    WHEN ${c}->>'dateTime' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}' THEN (${c}->>'dateTime')::timestamptz
    WHEN ${c}->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN ((${c}->>'date')::date)::timestamp AT TIME ZONE 'UTC'
  END)`
}

/** How far before the window an exception's original slot may start and its occurrence still
 * overlap the window (the longest series occurrence we expect: a multi-week all-day block). */
const EXCEPTION_ORIGINAL_LOOKBACK = "31 days"

/** The date of an RRULE's UNTIL, as a POSIX regex passed as a bind parameter (a backslash
 * written inside the sql`` template is eaten by the template literal). */
const UNTIL_DATE_PATTERN = "UNTIL=([0-9]{8})"

const EVENT_COLUMNS = `id, calendar_id, google_event_id, title, description, location, start, "end", all_day,
  recurrence, recurring_event_id, original_start_time, status, hangout_link, attendees,
  organizer_self, guests_can_modify, push_error, push_notice`

/**
 * listEventsForCaller — the RAW rows the window needs, with their full field set: plain events
 * overlapping it, the recurring masters with an occurrence in it, and the exception rows whose
 * original slot or own time touches it. Recurrence expansion stays the caller's job (the web
 * `expandEvents`, or an agent reading `recurrence`). Three queries whatever the number of
 * series: the window bounds plain events and exceptions in SQL; masters are cut in SQL by start
 * and by a date UNTIL, then exactly (COUNT, UNTIL, the rule) by `expandRecurrence`. RLS (via
 * `db`) scopes visibility.
 */
export async function listEventsForCaller(
  db: RlsClient,
  orgId: string,
  params: ListEventsParams,
): Promise<CalendarEventDto[]> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const windowStart = new Date(params.timeMin)
  const windowEnd = new Date(params.timeMax)
  const timeMin = windowStart.toISOString()
  const timeMax = windowEnd.toISOString()
  // Resolve Google's "primary" alias to a concrete calendar uuid before the
  // calendar_id = $::uuid filter — an agent may address the default calendar as
  // "primary" (Google convention), which would otherwise blow up as a 22P02.
  let calendarIdFilterValue = params.calendarId
  if (calendarIdFilterValue === "primary") {
    const { getCalendarById } = await import("~/apps/calendar/sync")
    const primary = await getCalendarById(db, orgId, "primary")
    calendarIdFilterValue = primary?.id
  }
  const calendarFilter = calendarIdFilterValue
    ? sql`AND calendar_id = ${calendarIdFilterValue}::uuid`
    : sql``
  // Unticked calendars do not show (their events are purged on untick; this also covers rows
  // that outlived it). Written as an exclusion so a caller whose RLS hides calendars still sees
  // its events.
  const selectedOnly = sql`AND calendar_id NOT IN (
    SELECT id FROM ${sql.raw(schema)}.calendars WHERE org_id = ${orgId}::uuid AND selected = false
  )`
  const startTs = sql.raw(pointTimestampSql("start"))
  const endTs = sql.raw(pointTimestampSql(`"end"`))
  const originalTs = sql.raw(pointTimestampSql("original_start_time"))
  const rowsOf = <T>(result: unknown): T[] =>
    Array.isArray(result) ? (result as T[]) : (((result as { rows?: T[] }).rows ?? []) as T[])

  // Plain (non-recurring, non-exception) events overlapping the window.
  const plain = rowsOf<RawEventRow>(
    await db.execute(sql`
      SELECT ${sql.raw(EVENT_COLUMNS)}
      FROM ${sql.raw(schema)}.events
      WHERE org_id = ${orgId}::uuid AND recurring_event_id IS NULL
        AND (jsonb_typeof(recurrence) IS DISTINCT FROM 'array' OR jsonb_array_length(recurrence) = 0)
        AND status != 'cancelled' AND deleted_at IS NULL ${calendarFilter} ${selectedOnly}
        AND ${startTs} < ${timeMax}::timestamptz AND ${endTs} > ${timeMin}::timestamptz
    `),
  )

  // Recurring masters begun before the window ends and not ended by a date UNTIL before it
  // starts. UNTIL bounds an occurrence's START: the last one may run on for the series'
  // duration, and the UNTIL day is read with two days of margin for the zones.
  const masterCandidates = rowsOf<RawEventRow>(
    await db.execute(sql`
      SELECT ${sql.raw(EVENT_COLUMNS)}
      FROM ${sql.raw(schema)}.events
      WHERE org_id = ${orgId}::uuid AND recurring_event_id IS NULL
        AND jsonb_typeof(recurrence) = 'array' AND jsonb_array_length(recurrence) > 0
        AND deleted_at IS NULL ${calendarFilter} ${selectedOnly}
        AND ${startTs} < ${timeMax}::timestamptz
        AND (
          substring(recurrence::text from ${UNTIL_DATE_PATTERN}) IS NULL
          OR to_date(substring(recurrence::text from ${UNTIL_DATE_PATTERN}), 'YYYYMMDD')::timestamp
               AT TIME ZONE 'UTC' + interval '2 days'
               + COALESCE(${endTs} - ${startTs}, interval '0')
             > ${timeMin}::timestamptz
        )
    `),
  )
  // Exactly: a master stays when the rule gives it an occurrence in the window. A complex rule
  // cannot be walked here, so its master stays (the caller shows what it can of it).
  const masters = masterCandidates.filter((m) => {
    const { complex, occurrences } = expandRecurrence(m, windowStart, windowEnd)
    return complex || occurrences.length > 0
  })

  // Exceptions whose own time overlaps the window (a moved occurrence to show) or whose
  // original slot does (the occurrence it replaces or cancels). One query for every series.
  const exceptions = rowsOf<RawEventRow & { deleted_at?: unknown }>(
    await db.execute(sql`
      SELECT ${sql.raw(EVENT_COLUMNS)}, deleted_at
      FROM ${sql.raw(schema)}.events
      WHERE org_id = ${orgId}::uuid AND recurring_event_id IS NOT NULL ${calendarFilter} ${selectedOnly}
        AND (
          (${originalTs} < ${timeMax}::timestamptz
            AND ${originalTs} > ${timeMin}::timestamptz - ${sql.raw(`interval '${EXCEPTION_ORIGINAL_LOOKBACK}'`)})
          OR (${startTs} < ${timeMax}::timestamptz AND ${endTs} > ${timeMin}::timestamptz)
        )
    `),
  )

  const results: CalendarEventDto[] = plain.map(rowToDto)
  for (const master of masters) results.push(rowToDto(master))
  // An occurrence whose delete is still on its way to Google already reads as cancelled, so
  // the series' expansion drops it instead of showing it again.
  for (const ex of exceptions) {
    results.push(rowToDto(ex.deleted_at ? { ...ex, status: "cancelled" } : ex))
  }
  const attending = attendeeFilter(params.attendee)
  if (!attending) return results
  return results.filter((event) =>
    event.attendees.some((a) => attending.has(a.email.trim().toLowerCase())),
  )
}

interface SearchRow {
  id: string
  calendar_id: string
  title: string | null
  start: unknown
  end: unknown
  hangout_link: string | null
  attendees: unknown
}

export async function searchEventsForCaller(
  db: RlsClient,
  orgId: string,
  query: string,
  limit = 20,
): Promise<
  Array<{
    eventId: string
    calendarId: string
    title: string | null
    start: unknown
    end: unknown
    hangoutLink: string | null
    attendees: CalendarAttendeeDto[]
  }>
> {
  const { sql } = await import("drizzle-orm")
  const schema = CALENDAR_SCHEMA()
  const pattern = `%${query}%`
  // Clamp the caller-supplied limit to a sane maximum so an agent passing a huge value can't pull
  // an unbounded result set (mild resource-pressure guard; RLS already scopes visibility).
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 200)
  const rows = (await db.execute(sql`
    SELECT id, calendar_id, title, start, "end", hangout_link, attendees
    FROM ${sql.raw(schema)}.events
    WHERE org_id = ${orgId}::uuid AND status != 'cancelled' AND deleted_at IS NULL
      AND (title ILIKE ${pattern} OR description ILIKE ${pattern} OR location ILIKE ${pattern})
    ORDER BY start
    LIMIT ${safeLimit}
  `)) as unknown as { rows?: SearchRow[] } | SearchRow[]
  const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
  // start/end and the video link let the caller tell which meeting it found (e.g. "the 11 AM
  // one") before updating it.
  return list.map((r) => ({
    eventId: r.id,
    calendarId: r.calendar_id,
    title: r.title,
    start: r.start,
    end: r.end,
    hangoutLink: r.hangout_link ?? null,
    attendees: toAttendeeDtos(r.attendees),
  }))
}

/** isWellFormedEmail — minimal validation gate for attendee entries at the tool boundary
 * (Design: "validate attendee entries are well-formed emails before push"). */
export function isWellFormedEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

/** The conferencing values `create_event` / `update_event` accept. Calendar connects Google
 * accounts only, so the one video-call product it can attach is Google Meet. */
export const CONFERENCE_OPTIONS = ["google_meet", "none"] as const

/** A location that only names a video-call product ("Google Meet", "Hangouts"): not a place
 * and not a link. An agent asked for a Meet used to write this instead of creating one. */
const CONFERENCE_PRODUCT_LOCATION_RE =
  /^\s*(google\s*meet|hangouts?\s*meet|google\s*hangouts?|hangouts?|meet)\s*$/i

/**
 * resolveConferenceIntent — maps the tool's `conference` param to the row's conference request:
 * "add" (create a Google Meet), "remove" (drop the event's conference; update only) or
 * undefined (leave the conference alone). A location holding only a Meet product name is turned
 * into a real Meet request and the location dropped (cleared on update), so the event gets a
 * link instead of the words "Google Meet". Any other `conference` value is refused with the
 * accepted ones named.
 */
export function resolveConferenceIntent(
  params: { conference?: unknown; location?: string },
  mode: "create" | "update",
): { conference: "add" | "remove" | undefined; location: string | undefined } {
  const { conference } = params
  if (
    conference !== undefined &&
    conference !== null &&
    !(CONFERENCE_OPTIONS as readonly unknown[]).includes(conference)
  ) {
    throw new Error(
      `calendar: unsupported conference "${String(conference)}". Use "google_meet" to add a Google Meet video link${
        mode === "update" ? ' or "none" to remove the existing one' : ""
      }. Calendar connects Google accounts only: Zoom or Microsoft Teams links cannot be created here; put a link the user gives you in the description.`,
    )
  }
  let request: "add" | "remove" | undefined =
    conference === "google_meet"
      ? "add"
      : conference === "none" && mode === "update"
        ? "remove"
        : undefined
  let location = params.location
  if (location !== undefined && CONFERENCE_PRODUCT_LOCATION_RE.test(location)) {
    if (request === undefined) request = "add"
    location = mode === "update" ? "" : undefined
  }
  return { conference: request, location }
}

/** The video link of a Google event: `hangoutLink` (Meet), else the conference's video entry
 * point (any conferencing solution). */
export function conferenceLinkOf(item: {
  hangoutLink?: string | null
  conferenceData?: unknown
}): string | null {
  if (typeof item.hangoutLink === "string" && item.hangoutLink) return item.hangoutLink
  const entryPoints = (item.conferenceData as { entryPoints?: unknown } | null | undefined)
    ?.entryPoints
  if (!Array.isArray(entryPoints)) return null
  for (const ep of entryPoints) {
    const e = ep as { entryPointType?: unknown; uri?: unknown } | null
    if (e?.entryPointType === "video" && typeof e.uri === "string" && e.uri) return e.uri
  }
  return null
}
