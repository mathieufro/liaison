// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shared days-off calendar on the real database: whole-day ordinary events of the one
// calendar an admin chose become company days off, an event gone upstream removes its row, and a
// calendar that can no longer be read leaves its days as typed ones and tells an admin once.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { seedContext } from "~/seed/context"
import { type EventSpec, seedTeamCalendar } from "~/seed/factories/calendar/events"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { CALENDAR_ENDED_KIND, syncDaysOffCalendar } from "./days-off-calendar"
import { awaitTimeFeatureSync } from "./time-feature"

let orgId = ""
let owner: minimal.Session
/** Two weeks ahead, so every seeded event lies in the twelve months the job reads. */
const base = new Date(Date.now() + 14 * 86_400_000)

function actorOf(userId: string, scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function call<T = Record<string, any>>(
  method: string,
  input: unknown,
  userId = owner.userId,
): Promise<T> {
  const a = actorOf(userId)
  return withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      { name: "projects" },
      a.scopes,
      "user",
      undefined,
      { origin: "human-ui" } as never,
    )
    return JSON.parse(await bridge[method](JSON.stringify(input))) as T
  })
}

const allDay = (key: string, title: string, day: number): EventSpec => ({
  key,
  title,
  day,
  startHour: 0,
  allDay: true,
  attendees: [],
})

/** A calendar with its events marked as Google's ordinary type, as a sync stores them. */
async function calendarWith(
  name: string,
  events: EventSpec[],
  as: UserContext,
  ownerKind: "org" | "person" = "org",
): Promise<{ calendarId: string; eventIds: string[] }> {
  const made = await seedTeamCalendar(seedContext({ orgId, now: base }), as, {
    accountEmail: `${name.toLowerCase().replace(/\W+/g, "-")}@example.test`,
    calendarExternalId: `${name}-external`,
    calendarName: name,
    timezone: "UTC",
    people: {},
    events,
    owner: ownerKind,
  })
  await db.execute(drizzleSql`
    UPDATE app_calendar.events SET event_type = 'default', status = 'confirmed'
     WHERE calendar_id = ${made.calendarId}::uuid`)
  return made
}

async function eventDate(eventId: string): Promise<string> {
  return extractRows<{ d: string }>(
    await db.execute(
      drizzleSql`SELECT start->>'date' AS d FROM app_calendar.events WHERE id = ${eventId}::uuid`,
    ),
  )[0]?.d as string
}

const rows = async () =>
  extractRows<{ starts_on: string; source: string | null; label: string | null; via: string }>(
    await db.execute(drizzleSql`
      SELECT starts_on::text AS starts_on, source_event_id::text AS source, label,
             created_via AS via
        FROM app_projects.days_off WHERE org_id = ${orgId}::uuid ORDER BY starts_on`),
  )

const endedLines = async () =>
  extractRows<{ user_id: string }>(
    await db.execute(drizzleSql`
      SELECT user_id::text AS user_id FROM kernel.attention_events
       WHERE org_id = ${orgId}::uuid AND kind = ${CALENDAR_ENDED_KIND}`),
  )

async function wipe() {
  await db.execute(drizzleSql`DELETE FROM app_projects.days_off WHERE org_id = ${orgId}::uuid`)
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET timezone = 'UTC' WHERE id = ${orgId}::uuid`,
  )
  owner = await minimal.adminSession(orgId)
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
  const made = await call<{ id: string }>("projects_createProject", { name: "Calendar studio" })
  await call("projects_updateProject", { projectId: made.id, timeBudgets: true })
  await awaitTimeFeatureSync(orgId)
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("the shared days-off calendar", () => {
  it("whole-day events become rows within a day", async () => {
    await wipe()
    const cal = await calendarWith(
      "Company days",
      [
        allDay("founders", "Founders day", 2),
        allDay("typed", "Already typed", 3),
        allDay("ooo", "Someone out", 4),
        { key: "meeting", title: "Planning", day: 1, startHour: 10, attendees: [] },
      ],
      actorOf(owner.userId),
    )
    const [founders, typed, ooo] = cal.eventIds as [string, string, string]
    await db.execute(
      drizzleSql`UPDATE app_calendar.events SET event_type = 'outOfOffice' WHERE id = ${ooo}::uuid`,
    )
    // A typed day off on the same date as an event wins over it.
    const typedDate = await eventDate(typed)
    await call("projects_daysOffSet", { on: typedDate, label: "Typed by hand" })
    expect(
      (await call("projects_timeSettingsSet", { daysOffCalendarId: cal.calendarId })).error,
    ).toBeUndefined()

    const out = await syncDaysOffCalendar(orgId, new Date())
    expect(out).toMatchObject({ state: "synced", added: 1, removed: 0 })
    expect(await rows()).toEqual([
      {
        starts_on: await eventDate(founders),
        source: founders,
        label: "Founders day",
        via: "calendar",
      },
      { starts_on: typedDate, source: null, label: "Typed by hand", via: "settings" },
    ])
    const listed = await call<{ rows: Array<{ fromCalendar: boolean; label: string | null }> }>(
      "projects_daysOffList",
      {},
    )
    expect(listed.rows.map((r) => [r.fromCalendar, r.label])).toEqual([
      [true, null],
      [false, "Typed by hand"],
    ])
    // The next day's run finds nothing new.
    expect(await syncDaysOffCalendar(orgId, new Date())).toMatchObject({ added: 0, removed: 0 })
  })

  it("an event deleted upstream removes its row", async () => {
    const [{ source } = { source: null }] = (await rows()).filter((r) => r.source)
    await db.execute(
      drizzleSql`UPDATE app_calendar.events SET deleted_at = now() WHERE id = ${source}::uuid`,
    )
    expect(await syncDaysOffCalendar(orgId, new Date())).toMatchObject({ removed: 1 })
    expect((await rows()).map((r) => r.source)).toEqual([null])
  })

  it("a disconnect keeps the rows as typed and tells an admin once", async () => {
    await wipe()
    const cal = await calendarWith(
      "Holidays feed",
      [allDay("a", "Bridge day", 2), allDay("b", "Closing day", 3)],
      actorOf(owner.userId),
    )
    await call("projects_timeSettingsSet", { daysOffCalendarId: cal.calendarId })
    await syncDaysOffCalendar(orgId, new Date())
    expect((await rows()).filter((r) => r.source)).toHaveLength(2)

    await db.execute(drizzleSql`
      UPDATE app_calendar.accounts SET sync_status = 'disconnected', disconnected_at = now()
       WHERE id = (SELECT account_id FROM app_calendar.calendars WHERE id = ${cal.calendarId}::uuid)`)
    expect(await syncDaysOffCalendar(orgId, new Date())).toMatchObject({ state: "ended", kept: 2 })
    expect((await rows()).map((r) => [r.source, r.label])).toEqual([
      [null, "Bridge day"],
      [null, "Closing day"],
    ])
    expect((await call("projects_timeSettingsGet", {})).daysOffCalendarId).toBeNull()
    expect((await endedLines()).map((l) => l.user_id)).toContain(owner.userId)
    const count = (await endedLines()).length
    expect(await syncDaysOffCalendar(orgId, new Date())).toEqual({ state: "none" })
    expect(await endedLines()).toHaveLength(count)
  })

  it("a person's own calendar cannot be chosen, and one set before is no longer read", async () => {
    await wipe()
    const member = await minimal.session(orgId, { role: "member" })
    const personal = await calendarWith(
      "Member days",
      [allDay("p", "Hospital", 2)],
      actorOf(member.userId),
      "person",
    )
    // Not offered, and refused when named.
    const settings = await call("projects_timeSettingsGet", {}, member.userId)
    expect(settings.options.map((o: { value: string }) => o.value)).not.toContain(
      personal.calendarId,
    )
    const refused = await call(
      "projects_timeSettingsSet",
      { daysOffCalendarId: personal.calendarId },
      member.userId,
    )
    expect(refused.error?.code).toBe("calendar_not_found")
    expect(refused.error?.message).toContain("a person's own calendar")
    // A calendar chosen while the organization's, then turned into a person's own: the daily
    // read stops, imports nothing more, removes what it read from it, and tells the settings
    // admins without its titles.
    const turned = await calendarWith(
      "Studio days",
      [allDay("s", "Hospital", 2)],
      actorOf(owner.userId),
    )
    await call("projects_timeSettingsSet", { daysOffCalendarId: turned.calendarId })
    await syncDaysOffCalendar(orgId, new Date())
    expect((await rows()).map((r) => r.label)).toEqual(["Hospital"])
    await db.execute(drizzleSql`
      UPDATE app_calendar.accounts SET owner_type = 'user', owner_id = ${member.userId}::uuid
       WHERE id = (SELECT account_id FROM app_calendar.calendars
                    WHERE id = ${turned.calendarId}::uuid)`)
    expect(await syncDaysOffCalendar(orgId, new Date())).toMatchObject({ state: "ended", kept: 0 })
    expect(await rows()).toEqual([])
    const summaries = extractRows<{ summary: string }>(
      await db.execute(drizzleSql`
        SELECT summary FROM kernel.attention_events
         WHERE org_id = ${orgId}::uuid AND kind = ${CALENDAR_ENDED_KIND}
           AND entity_id = ${turned.calendarId}`),
    ).map((r) => r.summary)
    expect(summaries.length).toBeGreaterThan(0)
    expect(summaries.join(" ")).not.toContain("Hospital")
    expect(await syncDaysOffCalendar(orgId, new Date())).toEqual({ state: "none" })
  })

  it("a deselected calendar is not read as deleted events", async () => {
    // A calendar unticked (its events purged) keeps its days too.
    await wipe()
    const team = await calendarWith(
      "Office days",
      [allDay("o", "Office closed", 3)],
      actorOf(owner.userId),
    )
    await call("projects_timeSettingsSet", { daysOffCalendarId: team.calendarId })
    await syncDaysOffCalendar(orgId, new Date())
    await db.execute(drizzleSql`
      UPDATE app_calendar.calendars SET selected = false WHERE id = ${team.calendarId}::uuid`)
    await db.execute(
      drizzleSql`DELETE FROM app_calendar.events WHERE calendar_id = ${team.calendarId}::uuid`,
    )
    expect(await syncDaysOffCalendar(orgId, new Date())).toMatchObject({ state: "ended", kept: 1 })
    expect((await rows()).map((r) => [r.source, r.label])).toEqual([[null, "Office closed"]])
  })

  it("with no calendar chosen nothing is read", async () => {
    expect(await syncDaysOffCalendar(orgId, new Date())).toEqual({ state: "none" })
  })
})
