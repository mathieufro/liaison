// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The date rules of a recurring schedule: pure civil-date arithmetic, no clock, no zone table.
import { describe, expect, test } from "bun:test"
import {
  draftOn,
  isDueForDraft,
  latestIssueOn,
  nextIssueOn,
  periodKey,
  resumeOn,
  validateSchedule,
  weekdayOf,
} from "./schedule"

describe("draft day", () => {
  // Mutation caught: stepping the draft day over a list of holidays (1 Jan) as well as weekends.
  test("draft day steps back over weekends only: 30 Nov 2026 gives Fri 27 Nov and 5 Jan 2027 gives Fri 1 Jan", () => {
    expect(draftOn("2026-11-30")).toBe("2026-11-27")
    expect(weekdayOf("2026-11-27")).toBe(5)
    expect(draftOn("2027-01-05")).toBe("2027-01-01")
    expect(weekdayOf("2027-01-01")).toBe(5)
  })

  test("a draft day that falls on a weekday stays, a Saturday or Sunday steps back to the Friday", () => {
    // Mon 2 Nov: 3 days back is Fri 30 Oct, a weekday.
    expect(draftOn("2026-11-02")).toBe("2026-10-30")
    // Tue 3 Nov: Sat 31 Oct steps to Fri 30 Oct.
    expect(draftOn("2026-11-03")).toBe("2026-10-30")
    // Wed 4 Nov: Sun 1 Nov steps to Fri 30 Oct.
    expect(draftOn("2026-11-04")).toBe("2026-10-30")
    // Thu 5 Nov: Mon 2 Nov, no step.
    expect(draftOn("2026-11-05")).toBe("2026-11-02")
    // Sat 31 Oct: Wed 28 Oct.
    expect(draftOn("2026-10-31")).toBe("2026-10-28")
  })

  test("the draft day crosses a month and a year end by calendar days", () => {
    expect(draftOn("2027-01-02")).toBe("2026-12-30")
    expect(draftOn("2028-03-02")).toBe("2028-02-28")
  })
})

describe("issue day", () => {
  // Mutation caught: stepping a weekend issue day back to the previous working day.
  test("month last day issues on that day even on a Saturday, and the latest issue date is the month's last day", () => {
    const month = { repeats: "month", billing_day: "last" } as const
    expect(nextIssueOn(month, "2026-11-01")).toBe("2026-11-30")
    expect(weekdayOf("2026-11-30")).toBe(1)
    // 31 Oct 2026 is a Saturday and stays a Saturday.
    expect(weekdayOf("2026-10-31")).toBe(6)
    expect(nextIssueOn(month, "2026-10-01")).toBe("2026-10-31")
    expect(latestIssueOn("2026-10-31")).toBe("2026-10-31")
    // Mid-month day: a Sunday stays a Sunday and the latest date is still the month's last.
    const fifteenth = { repeats: "month", billing_day: "15" } as const
    expect(nextIssueOn(fifteenth, "2026-11-01")).toBe("2026-11-15")
    expect(weekdayOf("2026-11-15")).toBe(7)
    expect(latestIssueOn("2026-11-15")).toBe("2026-11-30")
  })

  test("31st with February is the last day", () => {
    const month = { repeats: "month", billing_day: "last" } as const
    expect(nextIssueOn(month, "2027-02-01")).toBe("2027-02-28")
    expect(nextIssueOn(month, "2028-02-01")).toBe("2028-02-29")
    expect(latestIssueOn("2028-02-29")).toBe("2028-02-29")
    // A day-of-month beyond the month's end is clamped to its last day.
    expect(nextIssueOn({ repeats: "year", billing_day: "02-30" }, "2027-01-01")).toBe("2027-02-28")
  })

  test("the next issue day is on or after the date asked, both sides of the day", () => {
    const month = { repeats: "month", billing_day: "last" } as const
    expect(nextIssueOn(month, "2026-11-29")).toBe("2026-11-30")
    expect(nextIssueOn(month, "2026-11-30")).toBe("2026-11-30")
    expect(nextIssueOn(month, "2026-12-01")).toBe("2026-12-31")
    const fifth = { repeats: "month", billing_day: "5" } as const
    expect(nextIssueOn(fifth, "2026-11-05")).toBe("2026-11-05")
    expect(nextIssueOn(fifth, "2026-11-06")).toBe("2026-12-05")
    expect(nextIssueOn(fifth, "2026-12-31")).toBe("2027-01-05")
  })

  test("a quarter bills in March, June, September and December and a year on its own date", () => {
    expect(nextIssueOn({ repeats: "quarter", billing_day: "last" }, "2026-11-01")).toBe(
      "2026-12-31",
    )
    expect(nextIssueOn({ repeats: "quarter", billing_day: "last" }, "2027-01-01")).toBe(
      "2027-03-31",
    )
    expect(nextIssueOn({ repeats: "year", billing_day: "03-15" }, "2026-11-01")).toBe("2027-03-15")
    expect(nextIssueOn({ repeats: "year", billing_day: "last" }, "2026-11-01")).toBe("2026-12-31")
  })

  test("a period key names the month, quarter or year of the issue day", () => {
    expect(periodKey("month", "2026-11-30")).toBe("2026-11")
    expect(periodKey("quarter", "2026-12-31")).toBe("2026-Q4")
    expect(periodKey("quarter", "2027-01-15")).toBe("2027-Q1")
    expect(periodKey("year", "2027-03-15")).toBe("2027")
  })
})

describe("what is due", () => {
  const active = {
    status: "active",
    repeats: "month",
    billing_day: "last",
    next_issue_on: "2026-11-30",
    next_draft_on: "2026-11-27",
    ends_on: null,
    paused_until: null,
  } as const

  test("an active schedule is due on its draft day and not the day before", () => {
    expect(isDueForDraft(active, "2026-11-26")).toBe(false)
    expect(isDueForDraft(active, "2026-11-27")).toBe(true)
    expect(isDueForDraft(active, "2026-11-30")).toBe(true)
  })

  test("a paused, ended or draft schedule is never due", () => {
    for (const status of ["paused", "ended", "draft"] as const) {
      expect(isDueForDraft({ ...active, status }, "2026-11-30")).toBe(false)
    }
  })

  test("a schedule that ended before the period creates nothing, one ending inside it still bills", () => {
    // The period is November 2026.
    expect(isDueForDraft({ ...active, ends_on: "2026-10-31" }, "2026-11-30")).toBe(false)
    expect(isDueForDraft({ ...active, ends_on: "2026-11-01" }, "2026-11-30")).toBe(true)
    expect(isDueForDraft({ ...active, ends_on: "2026-11-15" }, "2026-11-30")).toBe(true)
  })

  // Mutation caught: resuming with the dates the schedule had before the pause.
  test("resuming skips every issue day inside the pause", () => {
    const paused = { ...active, status: "paused", paused_until: "2027-01-10" } as const
    const resumed = resumeOn(paused, "2027-01-11")
    expect(resumed.next_issue_on).toBe("2027-01-31")
    expect(resumed.next_draft_on).toBe("2027-01-28")
    // On the issue day itself it is still billed.
    expect(resumeOn(paused, "2027-01-31").next_issue_on).toBe("2027-01-31")
  })
})

describe("saving a schedule", () => {
  const good = {
    contact_id: "c1",
    repeats: "month",
    billing_day: "last",
    lines: [{ description: "Retainer {period}", qty: 1, unit_price_minor: 150000, vat_bp: 2000 }],
  }

  test("a complete schedule has no error", () => {
    expect(validateSchedule(good)).toEqual([])
  })

  test("a missing customer, date or line is each named", () => {
    expect(validateSchedule({ ...good, contact_id: "" }).map((e) => e.field)).toEqual([
      "contact_id",
    ])
    expect(validateSchedule({ ...good, billing_day: "" }).map((e) => e.field)).toEqual([
      "billing_day",
    ])
    expect(validateSchedule({ ...good, billing_day: "31" }).map((e) => e.field)).toEqual([
      "billing_day",
    ])
    expect(validateSchedule({ ...good, billing_day: "13-01" }).map((e) => e.field)).toEqual([
      "billing_day",
    ])
    expect(validateSchedule({ ...good, lines: [] }).map((e) => e.field)).toEqual(["lines"])
    expect(
      validateSchedule({ ...good, lines: [{ ...good.lines[0], description: " " }] }).map(
        (e) => e.field,
      ),
    ).toEqual(["lines"])
    expect(
      validateSchedule({ ...good, lines: [{ ...good.lines[0], unit_price_minor: 12.5 }] }).map(
        (e) => e.field,
      ),
    ).toEqual(["lines"])
    expect(
      validateSchedule({ ...good, lines: [{ ...good.lines[0], vat_bp: 20000 }] }).map(
        (e) => e.field,
      ),
    ).toEqual(["lines"])
  })
})
