// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The calendar factory: an org-owned team calendar with a working week on it.
//
// A calendar account is normally born from a kernel connection event after a
// Google OAuth handshake. `onAccountConnected` is a pure upsert over that
// event's data though, and `runCalendarImport` takes the calendar listing as
// an INJECTED callback, so a seed drives both honestly without inventing a
// credential (the seam the calendar sync tests use); events go in through
// `createLocalEvent`. The account is org owned, so every active member gets
// the calendar's access grant: a shared team calendar everyone can see.
//
// No privileged write: everything runs on an RLS transaction as the actor.
import { sql } from "drizzle-orm"
import { createLocalEvent, onAccountConnected, runCalendarImport } from "~/apps/calendar/sync"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { seedClock } from "~/seed/clock"
import type { SeedContext } from "~/seed/context"
import { asUser, rowsOf, type SeedPerson } from "~/seed/factories/people/actors"

export interface EventSpec {
  key: string
  title: string
  description?: string
  location?: string
  /** Day offset from the Monday of the base week. */
  day: number
  startHour: number
  startMinute?: number
  durationMinutes?: number
  /** Person keys. */
  attendees: string[]
  allDay?: boolean
  /** Google RRULE strings for a recurring series. */
  recurrence?: string[]
}

type ExecTx = { execute: (q: unknown) => Promise<unknown> }

/**
 * Connect the team calendar account (or adopt it), import its one calendar and
 * write each event unless one with its title is already on it.
 */
export async function seedTeamCalendar(
  ctx: SeedContext,
  actor: UserContext,
  input: {
    accountEmail: string
    /** The provider's id of the calendar. */
    calendarExternalId: string
    calendarName: string
    timezone: string
    people: Record<string, SeedPerson | undefined>
    events: readonly EventSpec[]
    /**
     * `person`: the actor's own account instead of the team's, so its events are theirs alone
     * (a personal calendar no colleague's grant opens). Defaults to `org`.
     */
    owner?: "org" | "person"
  },
): Promise<{ eventIds: string[]; calendarId: string }> {
  const { orgId } = ctx
  const clock = seedClock(ctx.now)
  const noopEnqueue = async () => {
    // A seeded org has no Google credential, so there is nothing for a sync
    // job to talk to. The rows are what the seed needs; the jobs would fail.
  }
  const eventIds: string[] = []
  let calendarId = ""

  await asUser(actor, async (tx) => {
    const { accountId } = await onAccountConnected(
      tx as never,
      orgId,
      {
        data: {
          id: ctx.id("calendar-connection", input.owner === "person" ? actor.userId : "team"),
          appName: "calendar",
          ownerType: input.owner === "person" ? "user" : "org",
          ownerId: input.owner === "person" ? actor.userId : null,
          identifier: input.accountEmail,
          connectionName: "google-calendar",
        },
      } as never,
      noopEnqueue,
    )

    const imported = await runCalendarImport(
      tx as never,
      orgId,
      accountId,
      async () => [
        {
          id: input.calendarExternalId,
          summary: input.calendarName,
          primary: true,
          accessRole: "owner",
          timeZone: input.timezone,
        } as never,
      ],
      noopEnqueue,
    )
    calendarId = imported.calendarIds[0] as string

    for (const spec of input.events) {
      const start = clock.dayAt(spec.day, spec.startHour, spec.startMinute ?? 0)
      const existing = rowsOf<{ id: string }>(
        await (tx as ExecTx).execute(
          sql`SELECT id FROM ${sql.raw(schemaRef("app_calendar"))}.events
              WHERE org_id = ${orgId} AND calendar_id = ${calendarId}::uuid
                AND title = ${spec.title} LIMIT 1`,
        ),
      )
      if (existing[0]) {
        eventIds.push(existing[0].id)
        continue
      }
      const end = spec.allDay
        ? clock.dayAt(spec.day + 1, 0)
        : new Date(start.getTime() + (spec.durationMinutes ?? 30) * 60_000)
      // Google's point shape: a dated point for an all day event, a timed one
      // otherwise. The sandbox bridge performs the same conversion.
      const point = (d: Date) =>
        spec.allDay
          ? { date: d.toISOString().slice(0, 10) }
          : { dateTime: d.toISOString(), timeZone: input.timezone }

      const { eventId } = await createLocalEvent(tx as never, orgId, calendarId, accountId, {
        title: spec.title,
        ...(spec.description ? { description: spec.description } : {}),
        ...(spec.location ? { location: spec.location } : {}),
        start: point(start),
        end: point(end),
        allDay: spec.allDay ?? false,
        attendees: spec.attendees.map((key) => ({
          email: input.people[key]?.email ?? key,
          displayName: input.people[key]?.name ?? key,
          responseStatus: "accepted",
        })),
        ...(spec.recurrence ? { recurrence: spec.recurrence } : {}),
      })
      eventIds.push(eventId)
    }

    // `createLocalEvent` marks every row `pending_push: 'create'` so a real
    // account would push it to Google on the next sync. This org has no Google
    // account to push to, so the flag would sit there forever and read as a
    // permanently stuck outbound queue. `'none'` (the column's own default) is
    // the honest state for a local only calendar.
    await (tx as ExecTx).execute(
      sql`UPDATE ${sql.raw(schemaRef("app_calendar"))}.events SET pending_push = 'none'
          WHERE org_id = ${orgId} AND calendar_id = ${calendarId}::uuid
            AND pending_push <> 'none'`,
    )
  })

  return { eventIds, calendarId }
}
