// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The world of an away range read from a calendar: the request world of approval-world.ts, plus
// the person's own Google calendar connected the way the calendar app records a connection (its
// account, its primary calendar, as the system writes them), and each change of the person's out-of-office event handed to
// the same function a calendar sync hands the events it fetched (applyAwayFromCalendar). Google
// itself is the one thing not in the loop: the events are what its API returns for that change.

import { randomUUID } from "node:crypto"
import { applyAwayFromCalendar } from "~/apps/calendar/away-from-calendar"
import {
  type GoogleEventItem,
  onAccountConnected,
  onAccountDisconnected,
  runCalendarImport,
} from "~/apps/calendar/sync"
import { sql } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { getOrCreatePreferences, updatePreferences } from "~/modules/users/preferences-service"
import { ApprovalCase, ctxOf } from "./approval-world"

/** The kernel schema as the run names it (a test namespace prefixes it). */
const K = () => sql(schemaRef("kernel"))

const noopEnqueue = async () => {
  // No Google credential in a test: the rows are what the cell reads, the sync jobs would fail.
}

/** UTC midnight `offset` days from today, as Google writes a point in time. */
function midnight(offset: number): string {
  const d = new Date(Date.now() + offset * 86_400_000)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

export class CalendarCase extends ApprovalCase {
  calendarId = ""
  connectionId = ""
  eventId = ""
  title = "Out of office"
  from = 0
  days = 3
  cancelled = false

  async connect(): Promise<this> {
    await this.build()
    // Every day a working day, so a range read from an event starting today runs today, whatever
    // the weekday the suite runs on.
    const person = await ctxOf(this.orgId, this.people.person)
    await withRlsContext(person, async (tx) => {
      const prefs = await getOrCreatePreferences(this.people.person, this.orgId, { rlsTx: tx })
      await updatePreferences(
        this.people.person,
        {
          digestCadence: prefs.digestCadence,
          workHoursStart: "00:00",
          workHoursEnd: "23:59",
          workDays: [1, 2, 3, 4, 5, 6, 7],
          timezone: "UTC",
        },
        { rlsTx: tx },
      )
    })
    const [u] =
      (await sql`SELECT email FROM ${K()}.users WHERE id = ${this.people.person}`) as Array<{
        email: string
      }>
    const email = u?.email as string
    this.connectionId = randomUUID()
    this.eventId = `ooo-${randomUUID().slice(0, 8)}`
    await withPrivilegedDb(this.orgId, "relations-calendar-connect", async (tx) => {
      const { accountId } = await onAccountConnected(
        tx,
        this.orgId,
        {
          orgId: this.orgId,
          actorId: this.people.person,
          data: {
            id: this.connectionId,
            appName: "calendar",
            ownerType: "user",
            ownerId: this.people.person,
            identifier: email,
            connectionName: "google-calendar",
          },
        },
        noopEnqueue,
      )
      // The import job's own transaction, which the sandbox bridge hands over as an RLS client.
      const imported = await runCalendarImport(
        tx as never,
        this.orgId,
        accountId,
        async () => [
          {
            id: email,
            summary: email,
            accessRole: "owner",
            timeZone: "UTC",
          },
        ],
        noopEnqueue,
      )
      this.calendarId = imported.calendarIds[0] as string
    })
    await this.sync()
    return this
  }

  /** The person's out-of-office event as Google returns it now. */
  item(): GoogleEventItem {
    return {
      id: this.eventId,
      status: this.cancelled ? "cancelled" : "confirmed",
      eventType: "outOfOffice",
      summary: this.title,
      organizer: { self: true },
      start: { dateTime: midnight(this.from) },
      end: { dateTime: midnight(this.from + this.days) },
    }
  }

  /** One sync of the person's calendar carrying the event. */
  async sync(): Promise<void> {
    await withPrivilegedDb(this.orgId, "relations-calendar-sync", (tx) =>
      applyAwayFromCalendar(tx, this.orgId, this.calendarId, [this.item()]),
    )
  }

  async disconnect(): Promise<void> {
    await withPrivilegedDb(this.orgId, "relations-calendar-disconnect", (tx) =>
      onAccountDisconnected(tx as never, this.orgId, {
        orgId: this.orgId,
        data: { id: this.connectionId, appName: "calendar" },
      }),
    )
  }

  async calendarRanges(): Promise<
    Array<{ starts_on: string; ends_on: string | null; status: string }>
  > {
    return (await sql`
      SELECT starts_on::text, ends_on::text, status FROM ${K()}.away_ranges
      WHERE org_id = ${this.orgId} AND user_id = ${this.people.person} AND source = 'calendar'`) as Array<{
      starts_on: string
      ends_on: string | null
      status: string
    }>
  }

  async accountDisconnected(): Promise<boolean> {
    const [row] = (await sql`
      SELECT disconnected_at IS NOT NULL AS gone FROM app_calendar.accounts
      WHERE org_id = ${this.orgId} AND connected_account_id = ${this.connectionId}`) as Array<{
      gone: boolean
    }>
    return row?.gone ?? true
  }
}
