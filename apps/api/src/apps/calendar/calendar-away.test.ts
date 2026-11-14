// SPDX-License-Identifier: FSL-1.1-ALv2
// Away days read from the person's own calendar: what counts at once, what is asked about once,
// what counts for nothing, and how a row follows its event.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { AttentionItem } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { classifyCalendarItem, withLiveCalendarTitles } from "~/apps/calendar/away-from-calendar"
import {
  applyIncrementalSyncPages,
  applyInitialSyncPages,
  type GoogleEventItem,
  onAccountConnected,
  onAccountDisconnected,
  runCalendarImport,
} from "~/apps/calendar/sync"
import { sql } from "~/db"
import { PrivilegedDbTestAccess, withSystemDb } from "~/db/privileged"
import { wholeWorkingDays } from "~/modules/attention/work-hours"
import { answerCalendarAway, dayLabel, endAwayRange, readAwayToday } from "~/modules/users/away"
import { seedOrgRow, seedUserRow, setUserPreferences } from "~/seed/factories/org/rows"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

let orgId: string
let colleagueEmail: string

async function registerCalendarSchema() {
  const { calendarAppManifest } = await import("~/apps/calendar/manifest-descriptor")
  const { resetAppRegistries, setDeclaredEmits } = await import("~/modules/apps/app-registries")
  const { registerApps } = await import("~/modules/apps/runtime")
  resetAppRegistries()
  await withSystemDb("calendar-away-fixture-reg", async (tx) => {
    await tx.execute(
      drizzleSql`DELETE FROM kernel.apps WHERE org_id = ${orgId}::uuid AND name = 'calendar'`,
    )
  })
  setDeclaredEmits(
    "*",
    "kernel",
    new Set(["connected_account:create", "connected_account:disconnect"]),
  )
  await registerApps([calendarAppManifest as any], orgId)
}

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-away-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  colleagueEmail = `colleague-${slug}@x.test`
  orgId = await seedOrgRow({ id: crypto.randomUUID(), name: "Calendar Away Org", slug })
  await registerCalendarSchema()
}, 120_000)

afterAll(async () => {
  await releaseAppSchemaJsLock("app_calendar")
})

/** A person in Paris working 09:00 to 18:00, Monday to Friday, with their own calendar. */
async function person(name = "Tom Martin", extraCalendars: string[] = []) {
  const email = `p-${crypto.randomUUID()}@x.test`
  const connectionId = crypto.randomUUID()
  const userId = await seedUserRow({
    orgId,
    email,
    name,
    status: "active",
    passwordHash: "h",
    authVersion: 1,
    permissionVersion: 1,
    timezone: "Europe/Paris",
  })
  await setUserPreferences(userId, {
    workHoursStart: "09:00",
    workHoursEnd: "18:00",
    workDays: [1, 2, 3, 4, 5],
    timezone: "Europe/Paris",
  })
  return withSystemDb("calendar-away-person", async (tx) => {
    const { accountId } = await onAccountConnected(
      tx as any,
      orgId,
      {
        orgId,
        actorId: userId,
        data: {
          id: connectionId,
          appName: "calendar",
          ownerType: "user",
          ownerId: userId,
          identifier: email,
          connectionName: "google-calendar",
        },
      },
      async () => {},
    )
    const { calendarIds } = await runCalendarImport(
      tx as any,
      orgId,
      accountId,
      async () => [{ id: email, summary: name }, ...extraCalendars.map((id) => ({ id }))],
      async () => {},
    )
    const ids = (await tx.execute(drizzleSql`
      SELECT id, google_calendar_id FROM app_calendar.calendars WHERE account_id = ${accountId}::uuid`)) as any
    const byGoogle = new Map<string, string>(
      (ids.rows ?? ids).map((r: any) => [r.google_calendar_id, r.id]),
    )
    return {
      userId,
      email,
      accountId,
      connectionId,
      calendarId: byGoogle.get(email) as string,
      calendarOf: (gid: string) => byGoogle.get(gid) as string,
      all: calendarIds,
    }
  })
}

type Person = Awaited<ReturnType<typeof person>>

async function syncInitial(p: Person, items: GoogleEventItem[], calendarId = p.calendarId) {
  await withSystemDb("calendar-away-sync", (tx) =>
    applyInitialSyncPages(tx as any, orgId, calendarId, p.accountId, [
      { items, nextSyncToken: `t-${crypto.randomUUID()}` },
    ]),
  )
}

async function syncChange(p: Person, items: GoogleEventItem[]) {
  await withSystemDb("calendar-away-sync-inc", (tx) =>
    applyIncrementalSyncPages(tx as any, orgId, p.calendarId, [
      { items, nextSyncToken: `t-${crypto.randomUUID()}` },
    ]),
  )
}

async function ranges(userId: string) {
  return sql<
    Array<{
      id: string
      starts_on: string
      ends_on: string
      status: string
      source: string
      source_event_ref: string
      ended_early_on: string | null
    }>
  >`
    SELECT id, starts_on::text AS starts_on, ends_on::text AS ends_on, status, source,
      source_event_ref, ended_early_on::text AS ended_early_on
    FROM kernel.away_ranges WHERE org_id = ${orgId} AND user_id = ${userId} ORDER BY starts_on`
}

async function lines(userId: string) {
  const rows = await sql<Array<{ payload: any }>>`
    SELECT payload FROM kernel.pending_events
    WHERE org_id = ${orgId} AND payload->'data'->'targetUserIds' ? ${userId}
      AND payload->'data' ? 'awayCalendar'
    ORDER BY created_at`
  return rows.map((r) => r.payload.data)
}

/** A Monday at least ten days ahead, so every range here is in the future. */
function futureMonday(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 10)
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** Paris wall time on a date, as Google sends it. */
function paris(date: string, hhmm: string) {
  return { dateTime: `${date}T${hhmm}:00`, timeZone: "Europe/Paris" }
}
function atParis(date: string, hhmm: string): Date {
  // Paris is UTC+1 in winter and UTC+2 in summer; Intl gives the offset of that day.
  const guess = new Date(`${date}T${hhmm}:00Z`)
  const local = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/Paris" }))
  const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }))
  return new Date(guess.getTime() - (local.getTime() - utc.getTime()))
}

function ooo(id: string, start: string, end: string, extra: Partial<GoogleEventItem> = {}) {
  const [sd, st] = start.split(" ") as [string, string]
  const [ed, et] = end.split(" ") as [string, string]
  return {
    id,
    status: "confirmed",
    summary: "Out of office",
    eventType: "outOfOffice",
    organizer: { self: true },
    start: { dateTime: atParis(sd, st).toISOString(), timeZone: "Europe/Paris" },
    end: { dateTime: atParis(ed, et).toISOString(), timeZone: "Europe/Paris" },
    updated: new Date().toISOString(),
    ...extra,
  } as GoogleEventItem
}

function allDay(
  id: string,
  from: string,
  toExclusive: string,
  summary: string,
  extra: Partial<GoogleEventItem> = {},
) {
  return {
    id,
    status: "confirmed",
    summary,
    eventType: "default",
    organizer: { self: true },
    start: { date: from },
    end: { date: toExclusive },
    updated: new Date().toISOString(),
    ...extra,
  } as GoogleEventItem
}

describe("whole working days", () => {
  const prefs = {
    workHoursStart: "09:00",
    workHoursEnd: "18:00",
    workDays: [1, 2, 3, 4, 5],
    timezone: "Europe/Paris",
  }
  const mon = futureMonday()
  it("Mon 09:00 to Fri 18:00 is Monday to Friday", () => {
    expect(
      wholeWorkingDays(atParis(mon, "09:00"), atParis(addDays(mon, 4), "18:00"), prefs),
    ).toEqual([0, 1, 2, 3, 4].map((n) => addDays(mon, n)))
  })
  it("Mon 14:00 to Wed 12:00 is Tuesday only; 09:00 to 12:00 is none", () => {
    expect(
      wholeWorkingDays(atParis(mon, "14:00"), atParis(addDays(mon, 2), "12:00"), prefs),
    ).toEqual([addDays(mon, 1)])
    expect(wholeWorkingDays(atParis(mon, "09:00"), atParis(mon, "12:00"), prefs)).toEqual([])
  })
  it("a window across midnight ends the next day; start equal end is the whole day", () => {
    const night = { ...prefs, workHoursStart: "22:00", workHoursEnd: "06:00" }
    expect(
      wholeWorkingDays(atParis(mon, "22:00"), atParis(addDays(mon, 1), "06:00"), night),
    ).toEqual([mon])
    expect(
      wholeWorkingDays(atParis(mon, "22:00"), atParis(addDays(mon, 1), "05:00"), night),
    ).toEqual([])
    const whole = { ...prefs, workHoursStart: "00:00", workHoursEnd: "00:00" }
    expect(
      wholeWorkingDays(atParis(mon, "00:00"), atParis(addDays(mon, 1), "00:00"), whole),
    ).toEqual([mon])
    expect(
      wholeWorkingDays(atParis(mon, "09:00"), atParis(addDays(mon, 1), "00:00"), whole),
    ).toEqual([])
  })
})

describe("calendar reading: what counts", () => {
  const mon = futureMonday()
  const fri = addDays(mon, 4)

  it("an out-of-office Mon 09:00 to Fri 18:00 is one active row Mon to Fri, one Home line, no title anywhere", async () => {
    const p = await person()
    await syncInitial(p, [
      ooo("ooo1", `${mon} 09:00`, `${fri} 18:00`, { summary: "Secret trip OOO-TITLE-1" }),
    ])
    const rows = await ranges(p.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      starts_on: mon,
      ends_on: fri,
      status: "active",
      source: "calendar",
      source_event_ref: `${p.calendarId}:ooo1`,
    })
    const home = await lines(p.userId)
    expect(home).toHaveLength(1)
    expect(home[0].summary).toBe(
      `Your calendar marks you away from ${dayLabel(mon)} to ${dayLabel(fri)}. Nobody is next in line, so items for you stay with the usual approvers.`,
    )
    expect(home[0].awayCalendar).toMatchObject({ kind: "set", rangeId: rows[0]?.id })
    // Undo on the line: the row is set aside, and the next sync does not re-arm it.
    const undone = await answerCalendarAway(orgId, p.userId, rows[0]?.id as string, false)
    expect(undone.status).toBe("declined")
    await syncInitial(p, [
      ooo("ooo1", `${mon} 09:00`, `${fri} 18:00`, { summary: "x", etag: "e2" }),
    ])
    expect((await ranges(p.userId))[0]?.status).toBe("declined")
    expect(await lines(p.userId)).toHaveLength(1)
    // No title in any kernel table or event.
    const leaks = await sql<Array<{ n: number }>>`
      SELECT (SELECT count(*) FROM kernel.away_ranges WHERE row_to_json(away_ranges)::text LIKE '%OOO-TITLE-1%')
        + (SELECT count(*) FROM kernel.pending_events WHERE payload::text LIKE '%OOO-TITLE-1%')
        + (SELECT count(*) FROM kernel.attention_events WHERE row_to_json(attention_events)::text LIKE '%OOO-TITLE-1%') AS n`
    expect(Number(leaks[0]?.n)).toBe(0)
  })

  it("Mon 14:00 to Wed 12:00 makes Tuesday only; 09:00 to 12:00 makes no row", async () => {
    const p = await person()
    await syncInitial(p, [
      ooo("part1", `${mon} 14:00`, `${addDays(mon, 2)} 12:00`),
      ooo("part2", `${addDays(mon, 7)} 09:00`, `${addDays(mon, 7)} 12:00`),
    ])
    const rows = await ranges(p.userId)
    expect(rows.map((r) => [r.starts_on, r.ends_on])).toEqual([[addDays(mon, 1), addDays(mon, 1)]])
  })

  it("focusTime, workingLocation, birthday and fromGmail make no row", async () => {
    const p = await person()
    await syncInitial(p, [
      ooo("f1", `${mon} 09:00`, `${fri} 18:00`, { eventType: "focusTime" }),
      ooo("f2", `${mon} 09:00`, `${fri} 18:00`, { eventType: "workingLocation" }),
      allDay("f3", mon, addDays(mon, 1), "Congés", { eventType: "birthday" }),
      allDay("f4", mon, addDays(mon, 1), "Vacation", { eventType: "fromGmail" }),
    ])
    expect(await ranges(p.userId)).toHaveLength(0)
  })

  it("another calendar than the person's own primary makes no row, a subscribed colleague's included", async () => {
    const p = await person("Tom Martin", [
      colleagueEmail,
      "team-holidays@group.calendar.google.com",
    ])
    await syncInitial(
      p,
      [ooo("c1", `${mon} 09:00`, `${fri} 18:00`, { organizer: { self: true } })],
      p.calendarOf(colleagueEmail),
    )
    await syncInitial(
      p,
      [allDay("c2", mon, addDays(mon, 3), "Holiday")],
      p.calendarOf("team-holidays@group.calendar.google.com"),
    )
    expect(await ranges(p.userId)).toHaveLength(0)
  })

  it("an out-of-office with neither organizer.self nor creator.self makes no row", async () => {
    const p = await person()
    await syncInitial(p, [
      ooo("d1", `${mon} 09:00`, `${fri} 18:00`, { organizer: { email: "delegate@x.test" } }),
    ])
    expect(await ranges(p.userId)).toHaveLength(0)
    await syncInitial(p, [
      ooo("d2", `${mon} 09:00`, `${fri} 18:00`, {
        organizer: { email: "d@x.test" },
        creator: { self: true },
      }),
    ])
    expect(await ranges(p.userId)).toHaveLength(1)
  })
})

describe("calendar reading: asked once", () => {
  const mon = futureMonday()

  it("an all-day default event organised and matching is asked; the Home line reads the title live", async () => {
    const p = await person()
    await syncInitial(p, [allDay("a1", mon, addDays(mon, 5), "Congés d'hiver")])
    const rows = await ranges(p.userId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: "asked", starts_on: mon, ends_on: addDays(mon, 4) })
    // Counts for nothing until Yes.
    const now = new Date(`${addDays(mon, 1)}T10:00:00Z`)
    expect((await readAwayToday(orgId, [p.userId], now)).has(p.userId)).toBe(false)
    const home = await lines(p.userId)
    expect(home).toHaveLength(1)
    expect(home[0].summary).not.toContain("Congés")
    // The feed reads the title now, under the person's own access.
    const item = {
      metadata: { awayCalendar: { ...home[0].awayCalendar } },
    } as unknown as AttentionItem
    await withLiveCalendarTitles(
      {
        actorType: "user",
        userId: p.userId,
        orgId,
        scopes: ["*"],
        dimensionGrants: { "calendar:calaccess": [p.accountId] },
      },
      [item],
    )
    expect((item.metadata as any).awayCalendar.title).toBe("Congés d'hiver")
    // Yes: it counts.
    const yes = await answerCalendarAway(orgId, p.userId, rows[0]?.id as string, true)
    expect(yes.status).toBe("active")
    expect((await readAwayToday(orgId, [p.userId], now)).get(p.userId)?.until).toBe(addDays(mon, 4))
  })

  it("No declines it, and later syncs of that event ask nothing", async () => {
    const p = await person()
    await syncInitial(p, [allDay("n1", mon, addDays(mon, 2), "RTT")])
    const [row] = await ranges(p.userId)
    await answerCalendarAway(orgId, p.userId, row?.id as string, false)
    await syncInitial(p, [allDay("n1", mon, addDays(mon, 3), "RTT", { etag: "n1b" })])
    expect((await ranges(p.userId)).map((r) => r.status)).toEqual(["declined"])
    expect(await lines(p.userId)).toHaveLength(1)
  })

  it("a timed event with the same title, or an invite not accepted, makes no row", async () => {
    const p = await person()
    await syncInitial(p, [
      { ...allDay("t1", mon, mon, "Congés"), start: paris(mon, "09:00"), end: paris(mon, "18:00") },
      allDay("t2", mon, addDays(mon, 2), "Congés", {
        organizer: { email: "boss@x.test" },
        attendees: [{ email: p.email, self: true, responseStatus: "needsAction" }],
      }),
    ])
    expect(await ranges(p.userId)).toHaveLength(0)
  })

  it("an invited title reaches no model: no stored line or row holds it", async () => {
    const p = await person()
    await syncInitial(p, [
      allDay("i1", mon, addDays(mon, 2), "Congés fournisseur INVITE-TITLE", {
        organizer: { email: "supplier@x.test" },
        attendees: [{ email: p.email, self: true, responseStatus: "accepted" }],
      }),
    ])
    expect((await ranges(p.userId)).map((r) => r.status)).toEqual(["asked"])
    const leaks = await sql<Array<{ n: number }>>`
      SELECT (SELECT count(*) FROM kernel.pending_events WHERE payload::text LIKE '%INVITE-TITLE%')
        + (SELECT count(*) FROM kernel.attention_events WHERE row_to_json(attention_events)::text LIKE '%INVITE-TITLE%')
        + (SELECT count(*) FROM kernel.away_ranges WHERE row_to_json(away_ranges)::text LIKE '%INVITE-TITLE%') AS n`
    expect(Number(leaks[0]?.n)).toBe(0)
  })

  it("a fourth question waits until one is answered", async () => {
    const p = await person()
    const items = [0, 1, 2, 3].map((n) =>
      allDay(`q${n}`, addDays(mon, n * 7), addDays(mon, n * 7 + 1), "Vacances"),
    )
    await syncInitial(p, items)
    expect((await ranges(p.userId)).filter((r) => r.status === "asked")).toHaveLength(3)
    const [first] = await ranges(p.userId)
    await answerCalendarAway(orgId, p.userId, first?.id as string, true)
    await syncInitial(
      p,
      items.map((i) => ({ ...i, etag: "again" })),
    )
    expect((await ranges(p.userId)).filter((r) => r.status === "asked")).toHaveLength(3)
    expect(await ranges(p.userId)).toHaveLength(4)
  })
})

describe("calendar reading: follows its event", () => {
  const mon = futureMonday()
  const fri = addDays(mon, 4)

  it("moving the event moves the range, with a line stating the dates", async () => {
    const p = await person()
    await syncInitial(p, [ooo("m1", `${mon} 09:00`, `${fri} 18:00`)])
    await syncChange(p, [
      ooo("m1", `${addDays(mon, 7)} 09:00`, `${addDays(fri, 7)} 18:00`, { etag: "m1b" }),
    ])
    const rows = await ranges(p.userId)
    expect(rows.map((r) => [r.starts_on, r.ends_on, r.status])).toEqual([
      [addDays(mon, 7), addDays(fri, 7), "active"],
    ])
    const home = await lines(p.userId)
    expect(home).toHaveLength(2)
    expect(home[1].summary).toBe(
      `Your away moved: from ${dayLabel(addDays(mon, 7))} to ${dayLabel(addDays(fri, 7))}. Nobody is next in line, so items for you stay with the usual approvers.`,
    )
  })

  it("an outsider moving an accepted invite goes back to asked and Tom's Home shows nothing", async () => {
    const p = await person("Élodie Renard")
    const invite = (from: string, to: string, etag: string) =>
      allDay("o1", from, to, "Congés fournisseur", {
        etag,
        organizer: { email: "supplier@x.test" },
        attendees: [{ email: p.email, self: true, responseStatus: "accepted" }],
      })
    await syncInitial(p, [invite(mon, addDays(mon, 3), "o1a")])
    const [row] = await ranges(p.userId)
    await answerCalendarAway(orgId, p.userId, row?.id as string, true)
    const during = new Date(`${addDays(mon, 8)}T10:00:00Z`)
    await syncChange(p, [invite(addDays(mon, 7), addDays(mon, 10), "o1b")])
    const after = await ranges(p.userId)
    expect(after.map((r) => [r.status, r.starts_on])).toEqual([["asked", addDays(mon, 7)]])
    // Counts for nothing until she says Yes: nobody standing in for her sees her items.
    expect((await readAwayToday(orgId, [p.userId], during)).has(p.userId)).toBe(false)
    const home = await lines(p.userId)
    expect(home.map((l) => l.awayCalendar.kind)).toEqual(["asked", "asked"])
  })

  it("a calendar range over 30 days goes to asked", async () => {
    const p = await person()
    await syncInitial(p, [ooo("long", `${mon} 09:00`, `${addDays(mon, 39)} 18:00`)])
    expect((await ranges(p.userId)).map((r) => r.status)).toEqual(["asked"])
  })

  it("cancelling deletes the row unless it was ended early", async () => {
    const p = await person()
    await syncInitial(p, [
      ooo("x1", `${mon} 09:00`, `${fri} 18:00`),
      ooo("x2", `${addDays(new Date().toISOString().slice(0, 10), -5)} 09:00`, `${mon} 18:00`),
    ])
    const before = await ranges(p.userId)
    expect(before).toHaveLength(2)
    // x2 is running today: End early keeps it as a record of who was away when.
    const running = before.find((r) => r.source_event_ref.endsWith(":x2"))
    expect((await endAwayRange(orgId, p.userId, running?.id as string)).ended).toBe(true)
    await syncChange(p, [
      { id: "x1", status: "cancelled" } as GoogleEventItem,
      { id: "x2", status: "cancelled" } as GoogleEventItem,
    ])
    const left = await ranges(p.userId)
    expect(left.map((r) => r.source_event_ref.split(":")[1])).toEqual(["x2"])
  })

  it("ended early is not re-armed; moved to start after the end day it is active again with a new line", async () => {
    const p = await person()
    const startPast = addDays(new Date().toISOString().slice(0, 10), -5)
    await syncInitial(p, [ooo("e1", `${startPast} 09:00`, `${fri} 18:00`)])
    const [row] = await ranges(p.userId)
    await endAwayRange(orgId, p.userId, row?.id as string)
    await syncChange(p, [
      ooo("e1", `${startPast} 09:00`, `${addDays(fri, 3)} 18:00`, { etag: "e1b" }),
    ])
    expect((await ranges(p.userId))[0]?.ended_early_on).not.toBeNull()
    expect(await lines(p.userId)).toHaveLength(1)
    await syncChange(p, [
      ooo("e1", `${addDays(mon, 7)} 09:00`, `${addDays(fri, 7)} 18:00`, { etag: "e1c" }),
    ])
    const [moved] = await ranges(p.userId)
    expect(moved).toMatchObject({
      status: "active",
      ended_early_on: null,
      starts_on: addDays(mon, 7),
    })
    const home = await lines(p.userId)
    expect(home).toHaveLength(2)
    expect(home[1].awayCalendar.kind).toBe("set")
  })

  it("a recurring series keeps one row per occurrence in 60 days; a cancelled occurrence removes that row only", async () => {
    const p = await person()
    // Out of office every other Friday, 09:00 to 18:00, for a year: rows inside 60 days only.
    const firstFri = addDays(mon, 4)
    const master = ooo("r1", `${firstFri} 09:00`, `${firstFri} 18:00`, {
      recurrence: ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=FR;COUNT=26"],
    })
    await syncInitial(p, [master])
    const rows = await ranges(p.userId)
    const horizon = Date.now() + 60 * 86_400_000
    const expected: string[] = []
    for (let d = firstFri; atParis(d, "09:00").getTime() < horizon; d = addDays(d, 14))
      expected.push(d)
    expect(rows.map((r) => [r.starts_on, r.ends_on, r.status])).toEqual(
      expected.map((d) => [d, d, "active"]),
    )
    const firstId = `r1_${atParis(firstFri, "09:00").toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`
    expect(rows[0]?.source_event_ref).toBe(`${p.calendarId}:${firstId}`)
    await syncChange(p, [
      { id: firstId, status: "cancelled", recurringEventId: "r1" } as GoogleEventItem,
    ])
    const left = await ranges(p.userId)
    expect(left.map((r) => r.starts_on)).toEqual(expected.slice(1))
  })

  it("disconnecting the account deletes its calendar rows and keeps the person's said rows", async () => {
    const p = await person()
    await syncInitial(p, [ooo("g1", `${mon} 09:00`, `${fri} 18:00`)])
    await sql.unsafe(
      insertSql("kernel.away_ranges", {
        org_id: orgId,
        user_id: p.userId,
        starts_on: addDays(mon, 14),
        ends_on: addDays(mon, 15),
        source: "said",
        status: "active",
        set_by: p.userId,
      }),
    )
    await withSystemDb("calendar-away-disconnect", (tx) =>
      onAccountDisconnected(tx as any, orgId, {
        orgId,
        data: { id: p.connectionId, appName: "calendar" },
      }),
    )
    expect((await ranges(p.userId)).map((r) => r.source)).toEqual(["said"])
  })
})

describe("calendar reading: one privileged slot", () => {
  const mon = futureMonday()
  const fri = addDays(mon, 4)

  /** The privileged acquisitions made while another was held, during `run`. */
  async function nestedDuring(run: () => Promise<unknown>): Promise<string[]> {
    PrivilegedDbTestAccess.record()
    try {
      await run()
    } catch (err) {
      PrivilegedDbTestAccess.recorded()
      throw err
    }
    return PrivilegedDbTestAccess.recorded()
      .filter((a) => a.nested)
      .map((a) => a.reason)
  }

  it("a sync on a privileged transaction records its away rows and Home lines without a second slot", async () => {
    const p = await person()
    expect(
      await nestedDuring(() =>
        syncInitial(p, [
          ooo("s1", `${mon} 09:00`, `${fri} 18:00`),
          allDay("s2", addDays(mon, 7), addDays(mon, 8), "PTO"),
        ]),
      ),
    ).toEqual([])
    expect((await ranges(p.userId)).map((r) => r.status)).toEqual(["active", "asked"])
    expect((await lines(p.userId)).length).toBe(2)
    expect(
      await nestedDuring(() =>
        syncChange(p, [{ id: "s1", status: "cancelled" } as GoogleEventItem]),
      ),
    ).toEqual([])
    expect((await ranges(p.userId)).map((r) => r.status)).toEqual(["asked"])
  })

  it("disconnecting on a privileged transaction deletes the calendar rows without a second slot", async () => {
    const p = await person()
    await syncInitial(p, [ooo("d1", `${mon} 09:00`, `${fri} 18:00`)])
    expect(
      await nestedDuring(() =>
        withSystemDb("calendar-away-disconnect", (tx) =>
          onAccountDisconnected(tx as any, orgId, {
            orgId,
            data: { id: p.connectionId, appName: "calendar" },
          }),
        ),
      ),
    ).toEqual([])
    expect((await ranges(p.userId)).length).toBe(0)
  })
})

describe("classification", () => {
  it("never reads a part-day default event or a non-leave all-day event", () => {
    const who = {
      id: "u",
      name: "T",
      timezone: "Europe/Paris",
      workHoursStart: "09:00",
      workHoursEnd: "18:00",
      workDays: [1, 2, 3, 4, 5],
    }
    const mon = futureMonday()
    expect(
      classifyCalendarItem(allDay("z", mon, addDays(mon, 1), "Team offsite"), "c", who).kind,
    ).toBe("none")
    expect(
      classifyCalendarItem(allDay("z", mon, addDays(mon, 1), "Out of office"), "c", who).kind,
    ).toBe("ask")
    expect(classifyCalendarItem(allDay("z", mon, addDays(mon, 1), "PTO"), "c", who).kind).toBe(
      "ask",
    )
  })
})
