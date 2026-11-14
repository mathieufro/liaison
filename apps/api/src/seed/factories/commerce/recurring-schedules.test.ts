// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { seedContext } from "~/seed/context"
import { recurringScheduleRows } from "./invoicing"

const ctx = seedContext({
  orgId: "00000000-0000-4000-8000-0000000e7100",
  now: new Date("2026-11-10T09:00:00Z"),
})
const spec = {
  contactId: "00000000-0000-4000-8000-0000000e7101",
  repeats: "month" as const,
  billingDay: "last",
  lines: [
    { description: "Calibration plan {period}", qty: 1, unitPriceMinor: 120000, vatBp: 2000 },
  ],
  nextIssueOn: "2026-11-30",
  nextDraftOn: "2026-11-27",
}

describe("recurring schedule seed rows", () => {
  it("are deterministic, review only, and a paused or ended schedule has no next date", () => {
    const specs = [
      { ...spec, key: "calibration", status: "active" as const },
      { ...spec, key: "rental", status: "paused" as const },
      { ...spec, key: "old", status: "ended" as const },
    ]
    const first = recurringScheduleRows(ctx, "issuer-1", specs)
    const again = recurringScheduleRows(ctx, "issuer-1", specs)
    expect(first.map((r) => r.id)).toEqual(again.map((r) => r.id))
    expect(new Set(first.map((r) => r.id)).size).toBe(3)
    expect(first.every((r) => r.issue_mode === "review" && r.auto_enabled_by === null)).toBe(true)
    expect(first.map((r) => r.next_issue_on)).toEqual(["2026-11-30", null, null])
    expect(first.map((r) => r.next_draft_on)).toEqual(["2026-11-27", null, null])
  })
})
