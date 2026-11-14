// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { isoWeekOf, nextIsoWeek } from "./dates"

describe("ISO weeks", () => {
  it("names a date's week and the week after one, across a year's end", () => {
    expect(isoWeekOf("2026-11-14")).toBe("2026-W46")
    expect(isoWeekOf("2027-01-01")).toBe("2026-W53")
    expect(nextIsoWeek("2026-W46")).toBe("2026-W47")
    expect(nextIsoWeek("2026-W53")).toBe("2027-W01")
    expect(nextIsoWeek("2025-W52")).toBe("2026-W01")
    expect(nextIsoWeek("next")).toBeNull()
  })
})
