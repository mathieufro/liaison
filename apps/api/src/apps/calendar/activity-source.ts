// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Calendar's rows for a company's or a contact's timeline (`calendar:activity_read`):
 * the events one of the people attends, under the caller's row security.
 * Recurring events are expanded, which needs a window: each page reads the 90
 * days before its cursor and says where that window began, so the timeline
 * pages on to older meetings.
 */
import { calendarPointToDate } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { expandRecurringEvent, type RawEventRow } from "~/apps/calendar/tools"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import {
  type ActivitySourceAnswer,
  compareActivity,
  parseSourceInput,
} from "~/modules/contacts/activity"

export const CALENDAR_ACTIVITY_WINDOW_DAYS = 90

const tableRef = (schema: string, name: string) =>
  drizzleSql.raw(`${quoteIdent(schemaRef(schema))}.${quoteIdent(name)}`)
const COLUMNS =
  drizzleSql.raw(`e.id, e.calendar_id, e.google_event_id, e.title, e.start, e."end", e.all_day,
  e.recurrence, e.recurring_event_id, e.original_start_time, e.status, e.attendees`)
const START = drizzleSql.raw(`(CASE
    WHEN e.start->>'dateTime' ~ '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}' THEN (e.start->>'dateTime')::timestamptz
    WHEN e.start->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN ((e.start->>'date')::date)::timestamp AT TIME ZONE 'UTC'
  END)`)

export async function calendarActivityRows(
  db: RlsClient,
  orgId: string,
  raw: unknown,
): Promise<ActivitySourceAnswer> {
  const input = parseSourceInput(raw)
  if (input.contactIds.length === 0) return { rows: [] }
  const people = extractRows<{ id: string; email: string; name: string | null }>(
    await db.execute(drizzleSql`
      SELECT id::text AS id, lower(email) AS email, name FROM ${tableRef("kernel", "contacts")}
       WHERE org_id = ${orgId}::uuid AND id = ANY(${`{${input.contactIds.join(",")}}`}::uuid[])
         AND email IS NOT NULL`),
  )
  if (people.length === 0) return { rows: [] }
  const byEmail = new Map(people.map((p) => [p.email, p]))
  const emails = JSON.stringify([...byEmail.keys()])
  const end = input.before ? new Date(input.before.at) : new Date()
  const start = new Date(end.getTime() - CALENDAR_ACTIVITY_WINDOW_DAYS * 86_400_000)
  // An attendee entry is `{email}` or a bare address.
  const attends = drizzleSql`EXISTS (
    SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.attendees) = 'array' THEN e.attendees ELSE '[]'::jsonb END) a
     WHERE lower(COALESCE(a->>'email', a#>>'{}')) IN (SELECT jsonb_array_elements_text(${emails}::jsonb)))`
  const live = drizzleSql`e.org_id = ${orgId}::uuid AND e.deleted_at IS NULL AND e.status <> 'cancelled'
    AND e.recurring_event_id IS NULL AND ${attends}`
  const recurring = drizzleSql`COALESCE(jsonb_typeof(e.recurrence) = 'array' AND jsonb_array_length(e.recurrence) > 0, false)`
  const plain = extractRows<RawEventRow>(
    await db.execute(drizzleSql`
      SELECT ${COLUMNS} FROM ${tableRef("app_calendar", "events")} e
       WHERE ${live} AND NOT (${recurring})
         AND ${START} > ${start.toISOString()}::timestamptz AND ${START} <= ${end.toISOString()}::timestamptz`),
  )
  const masters = extractRows<RawEventRow>(
    await db.execute(drizzleSql`
      SELECT ${COLUMNS} FROM ${tableRef("app_calendar", "events")} e
       WHERE ${live} AND ${recurring} AND ${START} <= ${end.toISOString()}::timestamptz`),
  )
  const older = extractRows<{ any: boolean }>(
    await db.execute(drizzleSql`
      SELECT EXISTS (SELECT 1 FROM ${tableRef("app_calendar", "events")} e
                      WHERE ${live} AND ${START} <= ${start.toISOString()}::timestamptz) AS any`),
  )[0]?.any

  const attendeeOf = (row: RawEventRow) => {
    for (const a of Array.isArray(row.attendees) ? row.attendees : []) {
      const email = (typeof a === "string" ? a : (a as { email?: unknown })?.email) as unknown
      const hit = typeof email === "string" ? byEmail.get(email.toLowerCase()) : undefined
      if (hit) return hit
    }
    return null
  }
  const rows: ActivitySourceAnswer["rows"] = []
  const push = (row: RawEventRow, nativeId: string, at: Date) => {
    if (at <= start || at > end) return
    const iso = at.toISOString()
    if (
      input.before &&
      compareActivity({ at: iso, id: `${input.prefix}${nativeId}` }, input.before) <= 0
    )
      return
    const who = attendeeOf(row)
    rows.push({
      id: nativeId,
      at: iso,
      title: row.title?.trim() || "Meeting",
      who: who?.name ?? null,
      contactId: who?.id ?? null,
      href: { app: "calendar", entityType: "event", entityId: row.id },
    })
  }
  for (const row of plain) {
    const at = calendarPointToDate(row.start)
    if (at) push(row, row.id, at)
  }
  for (const master of masters) {
    for (const occurrence of expandRecurringEvent(master, [], start, end)) {
      const at = calendarPointToDate(occurrence.start)
      if (at) push(master, `${master.id}@${at.toISOString()}`, at)
    }
  }
  rows.sort((a, b) =>
    compareActivity(
      { at: a.at, id: `${input.prefix}${a.id}` },
      { at: b.at, id: `${input.prefix}${b.id}` },
    ),
  )
  return { rows: rows.slice(0, input.limit), windowStart: older ? start.toISOString() : null }
}
