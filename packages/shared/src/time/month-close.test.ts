// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { isoWeekdayOf } from "./dates"
import { monthCloseDay } from "./month-close"

describe("monthCloseDay", () => {
  it("the line's day is the last working day before the month's last day when the month ends on a Saturday, a Sunday and a Monday", () => {
    // 31 Oct 2026 is a Saturday, 31 May 2026 a Sunday, 31 Aug 2026 a Monday.
    expect(monthCloseDay(2026, 10)).toBe("2026-10-30")
    expect(monthCloseDay(2026, 5)).toBe("2026-05-29")
    expect(monthCloseDay(2026, 8)).toBe("2026-08-28")
    for (const [y, m] of [
      [2026, 10],
      [2026, 5],
      [2026, 8],
    ] as const) {
      expect(isoWeekdayOf(monthCloseDay(y, m))).toBeLessThanOrEqual(5)
    }
  })

  it("exactly one day of each month is the close day", () => {
    for (let m = 1; m <= 12; m++) {
      const day = monthCloseDay(2026, m)
      const last = new Date(Date.UTC(2026, m, 0)).toISOString().slice(0, 10)
      expect(day < last).toBe(true)
      expect(day.slice(0, 7)).toBe(last.slice(0, 7))
    }
  })

  it("skips company days off at the end of the month", () => {
    const rows = [{ startsOn: "2026-12-24", endsOn: "2026-12-30" }]
    expect(monthCloseDay(2026, 12)).toBe("2026-12-30")
    expect(monthCloseDay(2026, 12, rows)).toBe("2026-12-23")
    expect(
      monthCloseDay(2026, 12, [{ startsOn: "2026-12-30", endsOn: "2026-12-30", yearly: true }]),
    ).toBe("2026-12-29")
  })
})
