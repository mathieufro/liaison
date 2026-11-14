// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The recurring schedules list: its first line is computed from the schedules (when the next
// drafts come and when they issue), the filters keep the right rows, and a customer billed through
// Stripe never shows without what this schedule bills instead.
import { afterEach, describe, expect, it } from "bun:test"
import {
  billsText,
  filterRows,
  InvoicingRecurringList,
  type ListRow,
  scheduleContactIds,
  titleLine,
} from "./RecurringList"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
})

const row = (over: Partial<ListRow>): ListRow => ({
  id: "s",
  contact_id: "c",
  status: "active",
  repeats: "month",
  billing_day: "last",
  next_issue_on: "2026-11-30",
  next_draft_on: "2026-11-27",
  paused_until: null,
  paid_by: "transfer",
  lines: [{ description: "Team plan, {period}", qty: 1, unit_price_minor: 49000, vat_bp: 2000 }],
  bills_other_than_stripe: null,
  ...over,
})

describe("the recurring list", () => {
  it("the first line names how many drafts come next, on which day, and when they issue", () => {
    const rows = [
      ...Array.from({ length: 7 }, (_, i) => row({ id: `m${i}` })),
      row({ id: "q", next_issue_on: "2026-12-31", next_draft_on: "2026-12-28" }),
      row({ id: "p", status: "paused", next_issue_on: "2026-11-30", next_draft_on: "2026-11-27" }),
    ]
    expect(titleLine(rows, "en-GB")).toBe(
      "Soonest first. Next: 7 drafts on Fri 27 Nov, to issue on Mon 30 Nov.",
    )
    expect(titleLine([row({})], "en-GB")).toBe(
      "Soonest first. Next: 1 draft on Fri 27 Nov, to issue on Mon 30 Nov.",
    )
    expect(titleLine([row({ status: "paused" })], "en-GB")).toBe("Soonest first.")
    // A US reader gets the same day, month order.
    expect(titleLine([row({})], "en-US")).toBe(
      "Soonest first. Next: 1 draft on Fri 27 Nov, to issue on Mon 30 Nov.",
    )
  })

  it("filters keep active or paused schedules", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "p", status: "paused" }),
      row({ id: "e", status: "ended" }),
    ]
    expect(filterRows(rows, "all").map((r) => r.id)).toEqual(["a", "p", "e"])
    expect(filterRows(rows, "active").map((r) => r.id)).toEqual(["a"])
    expect(filterRows(rows, "paused").map((r) => r.id)).toEqual(["p"])
  })

  it("a customer billed through Stripe shows what the schedule bills instead", () => {
    expect(billsText(row({}))).toBe("Team plan")
    expect(billsText(row({ bills_other_than_stripe: "On-site training days" }))).toBe(
      "On-site training days",
    )
    expect(typeof InvoicingRecurringList).toBe("function")
  })

  it("an ended schedule whose person was deleted still lists, and no person is looked up for it", () => {
    const rows = [
      row({ id: "a", contact_id: "c1" }),
      row({ id: "e", status: "ended", contact_id: null }),
      row({ id: "b", contact_id: "c1" }),
    ]
    expect(scheduleContactIds(rows)).toEqual(["c1"])
    expect(filterRows(rows, "all").map((r) => r.id)).toEqual(["a", "e", "b"])
    expect(billsText(rows[1] as ListRow)).toBe("Team plan")
  })
})
