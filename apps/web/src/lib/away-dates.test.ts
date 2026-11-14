// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { awayDay, awayRangeEnds, awayWeekdays } from "./away-dates"

describe("away dates", () => {
  it("a day reads day and month, the year only when it is not this year", () => {
    expect(awayDay("2026-11-20", "en", "2026-11-08")).toBe("20 Nov")
    expect(awayDay("2027-01-04", "en", "2026-11-08")).toBe("4 Jan 2027")
    expect(awayDay("2026-11-20", "fr", "2026-11-08")).toBe("20 nov.")
  })

  it("a range in one month names the month once; across months, both", () => {
    expect(awayRangeEnds("2026-11-23", "2026-11-27", "en", "2026-11-08")).toEqual({
      from: "23",
      to: "27 Nov",
    })
    expect(awayRangeEnds("2026-11-09", "2026-12-20", "en", "2026-11-08")).toEqual({
      from: "9 Nov",
      to: "20 Dec",
    })
    expect(awayRangeEnds("2026-12-28", "2027-01-04", "en", "2026-11-08")).toEqual({
      from: "28 Dec",
      to: "4 Jan 2027",
    })
  })

  it("a value that is not a calendar day is shown as given", () => {
    expect(awayDay("soon", "en", "2026-11-08")).toBe("soon")
  })

  it("weekdays from ISO numbers", () => {
    expect(awayWeekdays([1, 5], "en")).toEqual(["Mon", "Fri"])
  })
})
