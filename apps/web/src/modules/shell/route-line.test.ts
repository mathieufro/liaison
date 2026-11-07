// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { awayLabel } from "~/modules/shell/route-line"

const t = (key: string, vars: Record<string, string | number> = {}) =>
  `${key.split(".").pop()}:${Object.values(vars).join(",")}`

describe("away in a list of people", () => {
  it("away until the last day of the run", () => {
    expect(awayLabel({ until: "2026-12-20" }, t, "en-GB", "2026-12-14")).toBe("awayUntil:20 Dec")
  })

  it("recurring reads away today, back Monday", () => {
    // Friday 2026-11-06 only: back the next working day.
    expect(awayLabel({ until: "2026-11-06" }, t, "en-GB", "2026-11-06")).toBe(
      "awayTodayBack:Monday",
    )
    // Wednesday only: back Thursday.
    expect(awayLabel({ until: "2026-11-04" }, t, "en-GB", "2026-11-04")).toBe(
      "awayTodayBack:Thursday",
    )
  })

  it("not away: nothing", () => {
    expect(awayLabel(null, t, "en-GB")).toBeNull()
    expect(awayLabel(undefined, t, "en-GB")).toBeNull()
  })
})
