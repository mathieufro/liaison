// SPDX-License-Identifier: FSL-1.1-ALv2
// The shared days-off calendar: the one calendar a settings admin chose
// (`time_settings.days_off_calendar_id`), read once a day for the next twelve months. Nothing
// else is read: no person's own calendar, no activity, no country. With no calendar chosen the
// job reads nothing.
//
// A whole-day, confirmed event of Google's ordinary type becomes a company day off marked as
// read from the calendar, its title kept as the label (60 characters). Part-day events, out of
// office, focus time, working location, birthdays and Gmail events make no row. A typed day off
// on the same dates wins. An event gone from the calendar removes its row.
//
// Before reading, the job checks that the calendar still exists, is selected, its account is
// connected and belongs to the organization (a person's own calendar is never read, whoever
// chose it). If not, nothing more is read and the setting clears: the imported days become
// ordinary typed days, except those of a person's own calendar, which are removed (their titles
// were never the company's), and the settings admins get one Home line asking for a new source.
// A passing sync error skips the day quietly.
import { addCalendarDays } from "@liaison/shared"
import { and, sql as drizzleSql, eq, isNotNull } from "drizzle-orm"
import { expandRecurringEvent, type RawEventRow } from "~/apps/calendar/tools"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { daysOff } from "~/db/schema/app_projects"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"
import { scopeHoldersInTx } from "~/modules/permissions/scope-holders"
import { orgTimezone } from "./time-plan"
import { todayIn } from "./took"

const log = rootLogger.child({ module: "projects/days-off-calendar" })

export const CALENDAR_ENDED_KIND = "projects:time_budgets.calendar_ended"
const ENDED_ENTITY = "days_off_calendar"
/** Who is told that the shared calendar can no longer be read. */
const ENDED_AUDIENCE_SCOPE = "projects:settings:admin"
const LABEL_MAX = 60
const HORIZON_DAYS = 365

export type DaysOffCalendarOutcome =
  | { state: "none" }
  | { state: "skipped"; reason: string }
  | { state: "ended"; calendarId: string; kept: number }
  | { state: "synced"; calendarId: string; added: number; removed: number }

interface CalendarState {
  selected: boolean
  sync_status: string
  disconnected: boolean
  owner_type: string
}

interface WholeDay {
  eventId: string
  from: string
  to: string
  label: string | null
}

/** The instant a civil date starts, in UTC. */
function utcMidnight(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d))
}

const cal = () => drizzleSql.raw(schemaRef("app_calendar"))

function pointDate(point: unknown): string | null {
  const d = (point as { date?: unknown } | null)?.date
  return typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

/** A whole-day span from Google's exclusive end date, or null for anything else. */
function wholeDays(eventId: string, start: unknown, end: unknown, title: string | null) {
  const from = pointDate(start)
  const endEx = pointDate(end)
  if (!from || !endEx || endEx <= from) return null
  const label = title?.trim() ? title.trim().slice(0, LABEL_MAX) : null
  return { eventId, from, to: addCalendarDays(endEx, -1), label }
}

async function readState(
  tx: PrivilegedDb,
  orgId: string,
  calendarId: string,
): Promise<CalendarState | null> {
  return (
    extractRows<CalendarState>(
      await tx.execute(drizzleSql`
        SELECT c.selected, a.sync_status, (a.disconnected_at IS NOT NULL) AS disconnected,
               a.owner_type
          FROM ${cal()}.calendars c
          JOIN ${cal()}.accounts a ON a.id = c.account_id AND a.org_id = c.org_id
         WHERE c.org_id = ${orgId}::uuid AND c.id = ${calendarId}::uuid`),
    )[0] ?? null
  )
}

/** The calendar's whole-day ordinary events that reach into [from, to]. */
async function readWholeDays(
  tx: PrivilegedDb,
  orgId: string,
  calendarId: string,
  from: string,
  to: string,
): Promise<WholeDay[]> {
  const base = drizzleSql`org_id = ${orgId}::uuid AND calendar_id = ${calendarId}::uuid
    AND all_day AND deleted_at IS NULL`
  const plain = extractRows<{ id: string; start: unknown; end: unknown; title: string | null }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, start, "end", title FROM ${cal()}.events
       WHERE ${base} AND status = 'confirmed' AND event_type = 'default'
         AND recurring_event_id IS NULL
         AND COALESCE(CASE WHEN jsonb_typeof(recurrence) = 'array' THEN jsonb_array_length(recurrence) END, 0) = 0`),
  )
  const out: WholeDay[] = []
  for (const r of plain) {
    const d = wholeDays(r.id, r.start, r.end, r.title)
    if (d && d.to >= from && d.from <= to) out.push(d)
  }
  const masters = extractRows<RawEventRow>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, calendar_id::text AS calendar_id, google_event_id, title, description,
             location, start, "end", all_day, recurrence, recurring_event_id, original_start_time,
             status
        FROM ${cal()}.events
       WHERE ${base} AND status = 'confirmed' AND event_type = 'default'
         AND recurring_event_id IS NULL
         AND COALESCE(CASE WHEN jsonb_typeof(recurrence) = 'array' THEN jsonb_array_length(recurrence) END, 0) > 0`),
  )
  const windowStart = utcMidnight(from)
  const windowEnd = utcMidnight(addCalendarDays(to, 1))
  for (const m of masters) {
    const exceptions = m.google_event_id
      ? extractRows<RawEventRow>(
          await tx.execute(drizzleSql`
            SELECT id::text AS id, calendar_id::text AS calendar_id, title, description, location,
                   start, "end", all_day, recurrence, recurring_event_id, original_start_time,
                   CASE WHEN deleted_at IS NOT NULL THEN 'cancelled' ELSE status END AS status
              FROM ${cal()}.events
             WHERE org_id = ${orgId}::uuid AND calendar_id = ${calendarId}::uuid
               AND recurring_event_id = ${m.google_event_id}`),
        )
      : []
    for (const occ of expandRecurringEvent(m, exceptions, windowStart, windowEnd)) {
      if (!occ.allDay || occ.recurrenceComplex) continue
      // An occurrence moved to its own row counts under its own id.
      const d = wholeDays(occ.eventId, occ.start, occ.end, occ.title)
      if (d && d.to >= from && d.from <= to) out.push(d)
    }
  }
  return out
}

/**
 * The calendar can no longer be read: its days stay as typed days, the setting clears and the
 * settings admins are told once on Home.
 */
async function endSource(
  tx: PrivilegedDb,
  orgId: string,
  calendarId: string,
  why: string,
  personal = false,
): Promise<number> {
  const imported = and(eq(daysOff.orgId, orgId), isNotNull(daysOff.sourceEventId))
  const kept = personal
    ? await tx.delete(daysOff).where(imported).returning({ id: daysOff.id })
    : await tx
        .update(daysOff)
        .set({ sourceEventId: null, updatedAt: new Date() })
        .where(imported)
        .returning({ id: daysOff.id })
  await tx.execute(drizzleSql`
    UPDATE ${projectsRel("time_settings")} SET days_off_calendar_id = NULL, updated_at = now()
     WHERE org_id = ${orgId}::uuid`)
  const told = extractRows<{ told: boolean }>(
    await tx.execute(drizzleSql`
      SELECT EXISTS (
        SELECT 1 FROM ${kernelRel("attention_events")}
         WHERE org_id = ${orgId}::uuid AND app = 'projects' AND entity_type = ${ENDED_ENTITY}
           AND entity_id = ${calendarId} AND kind = ${CALENDAR_ENDED_KIND}) AS told`),
  )[0]?.told
  if (told !== true) {
    const days = `${kept.length} ${kept.length === 1 ? "day" : "days"}`
    const summary = personal
      ? `The days-off calendar is no longer read (${why}). The ${days} read from it ${kept.length === 1 ? "was" : "were"} removed. Choose a calendar the organization connected in the Projects time settings, or type the days.`
      : `The shared days-off calendar can no longer be read (${why}). Its ${days} ${
          kept.length === 1 ? "stays" : "stay"
        } as typed company days off. Choose a new calendar in the Projects time settings, or keep typing days.`
    for (const userId of await scopeHoldersInTx(tx, orgId, ENDED_AUDIENCE_SCOPE)) {
      await tx.execute(drizzleSql`
        INSERT INTO ${kernelRel("attention_events")}
          (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary, actor_id,
           actor_type, metadata, occurred_at, is_urgent, digest_state, digest_eligible_at,
           email_only)
        VALUES (${orgId}::uuid, ${userId}::uuid, 'projects', ${ENDED_ENTITY}, ${calendarId},
                ${CALENDAR_ENDED_KIND}, 20, ${summary}, NULL, 'system', '{}'::jsonb, now(), false,
                'not_eligible', now(), false)
        ON CONFLICT (user_id, app, entity_type, entity_id, kind)
          WHERE read_at IS NULL AND email_only = false
          DO NOTHING`)
    }
  }
  return kept.length
}

/** One org's daily read of its shared days-off calendar. */
export async function syncDaysOffCalendar(
  orgId: string,
  now: Date = new Date(),
): Promise<DaysOffCalendarOutcome> {
  return withPrivilegedDb(
    orgId,
    "projects-days-off-calendar",
    async (tx) => {
      const calendarId = extractRows<{ id: string | null }>(
        await tx.execute(drizzleSql`
          SELECT days_off_calendar_id::text AS id FROM ${projectsRel("time_settings")}
           WHERE org_id = ${orgId}::uuid`),
      )[0]?.id
      if (!calendarId) return { state: "none" } as const
      const present = extractRows<{ t: string | null }>(
        await tx.execute(
          drizzleSql`SELECT to_regclass(${`${schemaRef("app_calendar")}.calendars`})::text AS t`,
        ),
      )[0]?.t
      const state = present ? await readState(tx, orgId, calendarId) : null
      if (state?.sync_status === "error") {
        return { state: "skipped", reason: "the calendar's last sync failed" } as const
      }
      const why = !state
        ? "it was removed"
        : !state.selected
          ? "it is no longer selected"
          : state.disconnected || ["reauth-required", "disconnected"].includes(state.sync_status)
            ? "its account is disconnected"
            : state.owner_type !== "org"
              ? "it is a person's own calendar, not one the organization connected"
              : null
      if (why) {
        const personal = !!state && state.owner_type !== "org"
        const kept = await endSource(tx, orgId, calendarId, why, personal)
        return { state: "ended", calendarId, kept: personal ? 0 : kept } as const
      }

      const today = todayIn(await orgTimezone(tx, orgId), now)
      const until = addCalendarDays(today, HORIZON_DAYS)
      const wanted = await readWholeDays(tx, orgId, calendarId, today, until)
      const key = (d: { eventId: string; from: string; to: string }) =>
        `${d.eventId}|${d.from}|${d.to}`
      const existing = extractRows<{ id: string; event: string; from: string; to: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id, source_event_id::text AS event, starts_on::text AS "from",
                 ends_on::text AS "to"
            FROM ${projectsRel("days_off")}
           WHERE org_id = ${orgId}::uuid AND source_event_id IS NOT NULL
             AND ends_on >= ${today}::date`),
      )
      const wantedKeys = new Set(wanted.map(key))
      const haveKeys = new Set(
        existing.map((e) => key({ eventId: e.event, from: e.from, to: e.to })),
      )
      let removed = 0
      for (const e of existing) {
        if (wantedKeys.has(key({ eventId: e.event, from: e.from, to: e.to }))) continue
        await tx.delete(daysOff).where(and(eq(daysOff.orgId, orgId), eq(daysOff.id, e.id)))
        removed++
      }
      let added = 0
      for (const d of wanted) {
        if (haveKeys.has(key(d))) continue
        // A typed day off on the same dates wins: the unique span index keeps it.
        const rows = await tx
          .insert(daysOff)
          .values({
            orgId,
            startsOn: d.from,
            endsOn: d.to,
            recursYearly: false,
            label: d.label,
            sourceEventId: d.eventId,
            createdVia: "calendar",
          })
          .onConflictDoNothing({
            target: [daysOff.orgId, daysOff.startsOn, daysOff.endsOn, daysOff.recursYearly],
          })
          .returning({ id: daysOff.id })
        added += rows.length
      }
      return { state: "synced", calendarId, added, removed } as const
    },
    { pool: "jobs" },
  )
}

/** The daily job: orgs using time and budgets that chose a shared calendar. */
export async function runDaysOffCalendarAll(
  now: Date = new Date(),
): Promise<{ orgs: number; ended: number }> {
  const orgs = await sweepSkippingMoving((notMoving) =>
    withSystemDb("projects-days-off-calendar-orgs", async (tx) =>
      extractRows<{ org_id: string }>(
        await tx.execute(drizzleSql`
          SELECT ts.org_id::text AS org_id FROM ${projectsRel("time_settings")} ts
           WHERE ts.days_off_calendar_id IS NOT NULL AND ${notMoving(drizzleSql.raw("ts.org_id"))}
             AND EXISTS (
               SELECT 1 FROM ${projectsRel("projects")} p
                WHERE p.org_id = ts.org_id AND p.kind = 'work' AND p.time_budgets_on
                  AND p.archived_at IS NULL)`),
      ).map((r) => r.org_id),
    ),
  )
  let ended = 0
  for (const orgId of orgs) {
    try {
      const out = await syncDaysOffCalendar(orgId, now)
      if (out.state === "ended") ended++
    } catch (err) {
      log.warn({ err, orgId }, "days-off calendar read failed for one org")
    }
  }
  return { orgs: orgs.length, ended }
}
