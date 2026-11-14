// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { awayLabel, awayRecapLineText, standingInText } from "~/modules/shell/route-line"

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

describe("While you were away", () => {
  const tr = (key: string, vars: Record<string, string | number> = {}) =>
    `${key.split(".").pop()}|${vars.name}|${vars.forName}|${vars.title}`

  it("a decision by the next in line says they stood in, with its day", () => {
    const line = {
      approvalId: "a-1",
      title: "Record a partial refund",
      outcome: "approved" as const,
      decidedByName: "Elodie Vasseur",
      decidedAs: "next_in_line" as const,
      decidedOn: "2026-11-10",
    }
    expect(awayRecapLineText(line, "Henrik Berg", tr, "en", "2026-11-14")).toBe(
      "recapApprovedStandIn|Elodie Vasseur|Henrik Berg|Record a partial refund, 10 Nov",
    )
    expect(
      awayRecapLineText({ ...line, outcome: "denied" }, "Henrik Berg", tr, "en", "2026-11-14"),
    ).toBe("recapDeniedStandIn|Elodie Vasseur|Henrik Berg|Record a partial refund, 10 Nov")
  })

  it("a decision by someone who could also decide says only whom it was for", () => {
    const line = {
      approvalId: "a-2",
      title: "Refund a duplicate charge",
      outcome: "approved" as const,
      decidedByName: "Sara Benali",
      decidedAs: "also_could" as const,
      decidedOn: "2026-11-12",
    }
    expect(awayRecapLineText(line, "Henrik Berg", tr, "en", "2026-11-14")).toBe(
      "recapApproved|Sara Benali|Henrik Berg|Refund a duplicate charge, 12 Nov",
    )
  })
})

describe("Home's line for a stand-in", () => {
  it("names who is away, until when, and that the reader is next in line", () => {
    expect(
      standingInText(
        { id: "u-a", name: "Amina Cherif", until: "2026-11-20" },
        t,
        "en-GB",
        "2026-11-08",
      ),
    ).toBe("standingInFor:Amina Cherif,20 Nov")
  })
})
