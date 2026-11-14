// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The story clock is pure: every instant is computed from the anchor, on the
// company's Paris calendar, so these tests need no database.
import { describe, expect, it } from "bun:test"
import { storyClock } from "~/seed/worlds/story-clock"

/** A Paris wall time as an instant, written as its UTC equivalent. */
const utc = (iso: string) => new Date(`${iso}Z`)

/** The Paris wall clock of an instant, `YYYY-MM-DD HH:MM`. */
function paris(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`
}

describe("story clock", () => {
  it("an instant asked in the past never passes the anchor", () => {
    // 09:15 in Paris on a Wednesday (UTC+1 in November).
    const anchor = utc("2026-11-11T08:15:00")
    const clock = storyClock(anchor)
    // Today at 18:00 has not happened yet: as a past instant it stops at the anchor.
    expect(clock.d(0, "18:00").getTime()).toBeLessThanOrEqual(anchor.getTime())
    // Today at 08:00 already happened: it stays as asked.
    expect(paris(clock.d(0, "08:00"))).toBe("2026-11-11 08:00")
    for (const n of [-30, -7, -1, 0]) {
      for (const at of ["00:00", "09:14", "09:16", "23:59"]) {
        expect(clock.d(n, at).getTime()).toBeLessThanOrEqual(anchor.getTime())
      }
    }
  })

  it("a day offset lands at the asked Paris wall time, else at the anchor's", () => {
    const clock = storyClock(utc("2026-11-11T08:15:00"))
    expect(paris(clock.d(-3, "14:30"))).toBe("2026-11-08 14:30")
    expect(paris(clock.d(2))).toBe("2026-11-13 09:15")
    // A row seeded at night keeps its night time: only event times clamp to working hours.
    const night = storyClock(utc("2026-11-11T22:40:00"))
    expect(paris(night.d(-1))).toBe("2026-11-10 23:40")
    expect(night.h(-2).getTime()).toBe(utc("2026-11-11T20:40:00").getTime())
    expect(night.h(3).getTime()).toBe(utc("2026-11-12T01:40:00").getTime())
  })

  it("rejects a wall time that is not HH:MM", () => {
    const clock = storyClock(utc("2026-11-11T08:15:00"))
    expect(() => clock.d(1, "9h")).toThrow(/HH:MM/)
    expect(() => clock.d(1, "24:00")).toThrow(/HH:MM/)
  })

  it("twelve events in this month keep their order when the anchor is 00:30 on the 1st", () => {
    // 00:30 in Paris on 1 December 2026.
    const anchor = utc("2026-11-30T23:30:00")
    const clock = storyClock(anchor)
    const monthStart = utc("2026-11-30T23:00:00")
    const events = Array.from({ length: 12 }, (_, i) => clock.thisMonthEvent(i, 12))
    for (const [i, at] of events.entries()) {
      expect(at.getTime()).toBeGreaterThanOrEqual(monthStart.getTime())
      expect(at.getTime()).toBeLessThanOrEqual(anchor.getTime())
      if (i > 0) expect(at.getTime()).toBeGreaterThan(events[i - 1]?.getTime() ?? 0)
    }
  })

  it("events in this month fall in working hours, in order, before the anchor when the month allows", () => {
    // 10:00 in Paris on 20 November 2026.
    const anchor = utc("2026-11-20T09:00:00")
    const clock = storyClock(anchor)
    const events = Array.from({ length: 12 }, (_, i) => clock.thisMonthEvent(i, 12))
    for (const [i, at] of events.entries()) {
      const wall = paris(at)
      expect(wall.slice(0, 7)).toBe("2026-11")
      const hhmm = wall.slice(11)
      expect(hhmm >= "09:00" && hhmm <= "18:00").toBe(true)
      expect(at.getTime()).toBeLessThanOrEqual(anchor.getTime())
      if (i > 0) expect(at.getTime()).toBeGreaterThan(events[i - 1]?.getTime() ?? 0)
    }
    // Spread over the month, not bunched on one day.
    expect(new Set(events.map((e) => paris(e).slice(0, 10))).size).toBeGreaterThan(6)
  })

  it("rejects an event index outside its count", () => {
    const clock = storyClock(utc("2026-11-20T09:00:00"))
    expect(() => clock.thisMonthEvent(12, 12)).toThrow()
    expect(() => clock.thisMonthEvent(-1, 12)).toThrow()
  })

  it("the k-th weekday of last month counts working days, from the end when negative", () => {
    // Anchor in November 2026: last month is October, which starts on a Thursday.
    const clock = storyClock(utc("2026-11-11T08:15:00"))
    expect(paris(clock.lastMonthWeekday(1)).slice(0, 10)).toBe("2026-10-01")
    expect(paris(clock.lastMonthWeekday(3)).slice(0, 10)).toBe("2026-10-05")
    expect(paris(clock.lastMonthWeekday(-1)).slice(0, 10)).toBe("2026-10-30")
    expect(paris(clock.lastMonthWeekday(2, "16:00"))).toBe("2026-10-02 16:00")
    expect(() => clock.lastMonthWeekday(23)).toThrow()
    expect(() => clock.lastMonthWeekday(0)).toThrow()
  })

  it("last month of a January anchor is the December before", () => {
    const clock = storyClock(utc("2027-01-01T08:00:00"))
    expect(paris(clock.lastMonthWeekday(-1)).slice(0, 10)).toBe("2026-12-31")
  })

  it("the k-th day of next week starts on the Monday after the anchor's week", () => {
    // Wednesday 11 November 2026: next week starts Monday 16 November.
    const clock = storyClock(utc("2026-11-11T08:15:00"))
    expect(paris(clock.nextWeekDay(1, "10:00"))).toBe("2026-11-16 10:00")
    expect(paris(clock.nextWeekDay(5)).slice(0, 10)).toBe("2026-11-20")
    // A Sunday anchor: next week is the one starting the next day.
    const sunday = storyClock(utc("2026-11-15T10:00:00"))
    expect(paris(sunday.nextWeekDay(1)).slice(0, 10)).toBe("2026-11-16")
    expect(() => clock.nextWeekDay(8)).toThrow()
  })

  it("the first 5 January ahead of 29 February 2028 is 5 January 2029", () => {
    const clock = storyClock(utc("2028-02-29T11:00:00"))
    expect(paris(clock.yearFirst(1, 5)).slice(0, 10)).toBe("2029-01-05")
    // A date later this year stays in this year; the anchor's own date is not ahead.
    expect(paris(clock.yearFirst(3, 1)).slice(0, 10)).toBe("2028-03-01")
    expect(paris(clock.yearFirst(2, 29)).slice(0, 10)).toBe("2032-02-29")
  })

  it("the month key and the next day follow Paris on both sides of 31 December", () => {
    // 23:30 on 31 December in Paris, then 00:30 on 1 January (still 31 December in UTC).
    const before = storyClock(utc("2026-12-31T22:30:00"))
    const after = storyClock(utc("2026-12-31T23:30:00"))
    expect(before.monthKey()).toBe("2026-12")
    expect(after.monthKey()).toBe("2027-01")
    expect(paris(before.d(1, "10:00"))).toBe("2027-01-01 10:00")
    expect(paris(after.d(-1, "10:00"))).toBe("2026-12-31 10:00")
    // This month's events of a 1 January anchor stay in January.
    expect(paris(after.thisMonthEvent(0, 3)).slice(0, 7)).toBe("2027-01")
    expect(paris(before.thisMonthEvent(2, 3)).slice(0, 7)).toBe("2026-12")
  })

  it("a wall time keeps its Paris hour on both sides of the last Sunday of October", () => {
    // Saturday 24 October 2026 at 12:00 in Paris (UTC+2); the clocks go back on Sunday 25.
    const saturday = storyClock(utc("2026-10-24T10:00:00"))
    expect(saturday.d(1, "12:00").getTime()).toBe(utc("2026-10-25T11:00:00").getTime())
    expect(paris(saturday.d(1))).toBe("2026-10-25 12:00")
    // Monday 26 October at 12:00 (UTC+1), looking back across the change.
    const monday = storyClock(utc("2026-10-26T11:00:00"))
    expect(monday.d(-2, "12:00").getTime()).toBe(utc("2026-10-24T10:00:00").getTime())
    expect(paris(monday.d(-1))).toBe("2026-10-25 12:00")
    // Hours are elapsed time, not wall time: 48 hours before Monday noon is Saturday 13:00.
    expect(paris(monday.h(-48))).toBe("2026-10-24 13:00")
  })

  it("formats a date for pack prose in English and French", () => {
    const clock = storyClock(utc("2026-11-11T08:15:00"))
    const at = clock.d(-8, "10:00")
    expect(clock.fmt(at, "en")).toBe("3 November 2026")
    expect(clock.fmt(at, "fr")).toBe("3 novembre 2026")
    expect(clock.fmt(at, "en", "dayMonth")).toBe("3 Nov")
    expect(clock.fmt(at, "en", "weekday")).toBe("Tuesday 3 November")
    // Formatting reads Paris: 00:30 on 1 January is already the new year.
    const newYear = storyClock(utc("2026-12-31T23:30:00"))
    expect(newYear.fmt(newYear.anchor, "en")).toBe("1 January 2027")
  })

  it("is a pure function of the anchor", () => {
    const a = storyClock(utc("2026-11-11T08:15:00"))
    const b = storyClock(utc("2026-11-11T08:15:00"))
    expect(a.d(-5, "11:00").getTime()).toBe(b.d(-5, "11:00").getTime())
    expect(a.thisMonthEvent(4, 12).getTime()).toBe(b.thisMonthEvent(4, 12).getTime())
    expect(a.anchor.getTime()).toBe(a.seed.base.getTime())
  })
})
