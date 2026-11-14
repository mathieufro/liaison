// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { expandDaysOff, resolveDayForm } from "./days-off"

describe("resolveDayForm", () => {
  it("week 52 asked on 6 Nov 2026 is 21 to 27 Dec 2026", () => {
    const r = resolveDayForm({ week: 52 }, "2026-11-06", "Europe/Paris")
    expect(r).toMatchObject({ ok: true, from: "2026-12-21", to: "2026-12-27" })
    if (r.ok) {
      expect(r.days).toHaveLength(7)
      expect(r.days[0]).toBe("Mon 21 Dec 2026")
      expect(r.days[6]).toBe("Sun 27 Dec 2026")
    }
  })

  it("week 53 of 2026 is 28 Dec to 3 Jan", () => {
    expect(resolveDayForm({ week: 53 }, "2026-11-06", null)).toMatchObject({
      ok: true,
      from: "2026-12-28",
      to: "2027-01-03",
    })
  })

  it("week 53 of 2027 does not exist", () => {
    expect(resolveDayForm({ week: 53, weekYear: 2027 }, "2026-11-06", null)).toMatchObject({
      ok: false,
      code: "no_such_week",
    })
  })

  it("a week without a year that has ended this year means next year's", () => {
    expect(resolveDayForm({ week: 10 }, "2026-11-06", null)).toMatchObject({
      ok: true,
      from: "2027-03-08",
    })
  })

  it("a week without a year is still this year's on its last day and next year's the day after", () => {
    expect(resolveDayForm({ week: 47 }, "2026-11-22", null)).toMatchObject({ from: "2026-11-16" })
    expect(resolveDayForm({ week: 47 }, "2026-11-23", null)).toMatchObject({ from: "2027-11-22" })
  })

  it("25 Dec with no year is the next 25 Dec", () => {
    expect(resolveDayForm({ on: "12-25" }, "2026-11-06", null)).toMatchObject({
      ok: true,
      from: "2026-12-25",
      to: "2026-12-25",
      days: ["Fri 25 Dec 2026"],
    })
    expect(resolveDayForm({ on: "12-25" }, "2026-12-25", null)).toMatchObject({
      from: "2026-12-25",
    })
    expect(resolveDayForm({ on: "12-25" }, "2026-12-26", null)).toMatchObject({
      from: "2027-12-25",
    })
  })

  it("29 Feb with no year is the next leap day", () => {
    expect(resolveDayForm({ on: "02-29" }, "2026-11-06", null)).toMatchObject({
      from: "2028-02-29",
    })
  })

  it("a range crossing the new year reads its last day after its first", () => {
    expect(resolveDayForm({ from: "12-24", to: "01-02" }, "2026-11-06", null)).toMatchObject({
      ok: true,
      from: "2026-12-24",
      to: "2027-01-02",
    })
  })

  it("a week cannot repeat every year", () => {
    expect(resolveDayForm({ week: 52, yearly: true }, "2026-11-06", null)).toMatchObject({
      ok: false,
      code: "week_cannot_recur",
    })
  })

  it("refuses a last day before the first and mixed forms", () => {
    expect(
      resolveDayForm({ from: "2026-12-10", to: "2026-12-01" }, "2026-11-06", null),
    ).toMatchObject({
      ok: false,
      code: "bad_dates",
    })
    expect(resolveDayForm({ on: "2026-12-10", week: 3 }, "2026-11-06", null)).toMatchObject({
      ok: false,
    })
    expect(resolveDayForm({ on: "2026-02-30" }, "2026-11-06", null)).toMatchObject({ ok: false })
  })

  it("reads today in the org's zone: 23:30 and 00:30 Paris around a month end", () => {
    // 31 Oct 2026 22:30 UTC is 23:30 in Paris (UTC+1 after the clock change); 23:30 UTC is 00:30 on 1 Nov.
    const before = new Date("2026-10-31T22:30:00Z")
    const after = new Date("2026-10-31T23:30:00Z")
    expect(resolveDayForm({ on: "10-31" }, before, "Europe/Paris")).toMatchObject({
      from: "2026-10-31",
    })
    expect(resolveDayForm({ on: "10-31" }, after, "Europe/Paris")).toMatchObject({
      from: "2027-10-31",
    })
    expect(resolveDayForm({ on: "10-31" }, after, "UTC")).toMatchObject({ from: "2026-10-31" })
  })
})

describe("expandDaysOff", () => {
  it("a yearly 25 Dec reduces week 52 of 2026 and the week of 25 Dec 2027", () => {
    const rows = [{ startsOn: "2025-12-25", endsOn: "2025-12-25", yearly: true }]
    expect(expandDaysOff(rows, "2026-12-21", "2026-12-27")).toEqual(["2026-12-25"])
    expect(expandDaysOff(rows, "2027-12-20", "2027-12-26")).toEqual(["2027-12-25"])
  })

  it("a yearly row does not reach back before it starts", () => {
    const rows = [{ startsOn: "2026-12-25", endsOn: "2026-12-25", yearly: true }]
    expect(expandDaysOff(rows, "2025-12-20", "2025-12-31")).toEqual([])
  })

  it("a yearly 24 Dec to 2 Jan crosses the new year", () => {
    const rows = [{ startsOn: "2026-12-24", endsOn: "2027-01-02", yearly: true }]
    const days = expandDaysOff(rows, "2028-12-20", "2029-01-05")
    expect(days[0]).toBe("2028-12-24")
    expect(days).toContain("2028-12-31")
    expect(days).toContain("2029-01-01")
    expect(days[days.length - 1]).toBe("2029-01-02")
    expect(days).toHaveLength(10)
    expect(expandDaysOff(rows, "2027-01-01", "2027-01-05")).toEqual(["2027-01-01", "2027-01-02"])
  })

  it("29 Feb recurs in leap years only", () => {
    const rows = [{ startsOn: "2024-02-29", endsOn: "2024-02-29", yearly: true }]
    expect(expandDaysOff(rows, "2027-02-25", "2027-03-02")).toEqual([])
    expect(expandDaysOff(rows, "2028-02-25", "2028-03-02")).toEqual(["2028-02-29"])
  })

  it("a one-off range is clipped to the window, once per date, sorted", () => {
    const rows = [
      { startsOn: "2026-12-30", endsOn: "2027-01-03" },
      { startsOn: "2027-01-02", endsOn: "2027-01-02" },
    ]
    expect(expandDaysOff(rows, "2027-01-01", "2027-01-02")).toEqual(["2027-01-01", "2027-01-02"])
    expect(expandDaysOff(rows, "2027-01-05", "2027-01-01")).toEqual([])
  })
})
