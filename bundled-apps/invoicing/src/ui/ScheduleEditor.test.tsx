// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The recurring schedule editor: Start stays disabled while the customer is billed through a
// Stripe subscription and nobody said what this schedule bills instead; no invoice number ever
// shows before an invoice issues; the save sends exactly the fields the tools take.
import { afterEach, describe, expect, it } from "bun:test"
import { type RecurringCtx, recurringList, recurringScheduleUpdate } from "../recurring/tools"
import { createMockDb } from "../test-db"
import {
  changedParams,
  conflictFrom,
  defaultSchedule,
  draftErrors,
  draftFromRow,
  editorActions,
  NUMBER_LINE,
  nextInvoices,
  previewDescription,
  type ScheduleDraft,
  ScheduleEditor,
  scheduleParams,
  scheduleTitle,
  seriesOf,
} from "./ScheduleEditor"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
})

const filled = (over: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
  ...defaultSchedule(),
  issuer_profile_id: "issuer-1",
  contact_id: "contact-1",
  lines: [{ description: "Group plan, {period}", qty: 1, unit_price_minor: 145000, vat_bp: 2000 }],
  ...over,
})

const CONFLICT = {
  status: "error",
  error: {
    code: "subscription_stream_conflict",
    message:
      "This customer pays the live Stripe subscription sub_1 (Group plan), which already invoices them.",
  },
}

describe("the schedule editor", () => {
  it("a saved change of how each invoice issues round-trips through the tool and back into the editor", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [
          {
            id: "issuer-1",
            legal_name: "Maison Nord SARL",
            country: "FR",
            default_currency: "EUR",
            default_language: "fr",
            timezone: "Europe/Paris",
          },
        ],
        recurring_schedules: [
          {
            id: "sched-1",
            issuer_profile_id: "issuer-1",
            contact_id: "contact-1",
            status: "active",
            repeats: "month",
            billing_day: "last",
            covers: "period_ended",
            issue_mode: "review",
            paid_by: "transfer",
            due_rule: "days_30",
            language: "fr",
            lines: [
              { description: "Retainer {period}", qty: 1, unit_price_minor: 150000, vat_bp: 2000 },
            ],
            next_issue_on: "2026-11-30",
            next_draft_on: "2026-11-27",
            version: 1,
          },
        ],
      },
    })
    const ctx = {
      getUserId: async () => "user-person",
      db: db as never,
      time: {
        civil: async ({ timezone }: { timezone: string }) => ({
          date: "2026-11-10",
          year: 2026,
          month: 11,
          day: 10,
          hour: 8,
          minute: 0,
          weekday: 2,
          zone: timezone,
        }),
      },
      approval: null,
    } as unknown as RecurringCtx
    const load = async () =>
      draftFromRow(
        "sched-1",
        (await recurringList(ctx, {})).rows[0] as unknown as Record<string, unknown>,
      )
    const before = await load()
    expect(before.issue_mode).toBe("review")
    const params = changedParams(before, { ...before, issue_mode: "auto" })
    expect(params).toEqual({ issue_mode: "auto" })
    expect(await recurringScheduleUpdate(ctx, { id: "sched-1", ...params })).toMatchObject({
      status: "completed",
      issueMode: "auto",
    })
    expect((await load()).issue_mode).toBe("auto")
  })

  it("an ended schedule whose person was deleted lists through the tool and opens with no customer", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [
          {
            id: "issuer-1",
            legal_name: "Maison Nord SARL",
            country: "FR",
            default_currency: "EUR",
            default_language: "fr",
            timezone: "Europe/Paris",
          },
        ],
        recurring_schedules: [
          {
            id: "sched-gone",
            issuer_profile_id: "issuer-1",
            contact_id: null,
            status: "ended",
            repeats: "month",
            billing_day: "last",
            issue_mode: "review",
            lines: [
              { description: "Retainer {period}", qty: 1, unit_price_minor: 150000, vat_bp: 2000 },
            ],
            next_issue_on: null,
            next_draft_on: null,
            version: 3,
          },
        ],
      },
    })
    const ctx = {
      getUserId: async () => "user-person",
      db: db as never,
      approval: null,
    } as unknown as RecurringCtx
    const listed = await recurringList(ctx, {})
    expect(listed.rows.map((r) => [r.id, r.contact_id])).toEqual([["sched-gone", null]])
    const draft = draftFromRow("sched-gone", listed.rows[0] as unknown as Record<string, unknown>)
    expect(draft).toMatchObject({ id: "sched-gone", status: "ended", contact_id: null })
    expect(draft.lines).toHaveLength(1)
  })

  it("Start stays disabled during an open conflict", () => {
    const conflict = conflictFrom(CONFLICT)
    expect(conflict).toEqual({ message: CONFLICT.error.message })
    // Not a conflict: any other refusal, or a success.
    expect(
      conflictFrom({ status: "error", error: { code: "invalid_schedule", message: "x" } }),
    ).toBeNull()
    expect(conflictFrom({ status: "completed" })).toBeNull()

    expect(editorActions(filled(), null).startDisabled).toBe(false)
    expect(editorActions(filled(), conflict).startDisabled).toBe(true)
    // Bill something else, with a line too short to say anything, still holds Start.
    expect(editorActions(filled({ billsOtherThanStripe: "abc" }), conflict).startDisabled).toBe(
      true,
    )
    // What it bills instead, said by the person, lifts it, and the save carries the text.
    const said = filled({ billsOtherThanStripe: "On-site training days" })
    expect(editorActions(said, conflict).startDisabled).toBe(false)
    expect(scheduleParams(said, "active").billsOtherThanStripe).toBe("On-site training days")
    // A schedule without a customer or a line cannot start either.
    expect(editorActions(filled({ contact_id: null }), null).startDisabled).toBe(true)
    expect(editorActions(filled({ lines: [] }), null).startDisabled).toBe(true)
  })

  it("no number shows before issue", () => {
    const next = nextInvoices({ repeats: "month", billing_day: "last" }, "2026-11-10", 3)
    expect(next.map((n) => n.issueOn)).toEqual(["2026-11-30", "2026-12-31", "2027-01-31"])
    for (const n of next) expect(Object.keys(n).sort()).toEqual(["draftOn", "issueOn"])
    expect(NUMBER_LINE).toContain("Taken the moment it issues")
    expect(NUMBER_LINE).not.toMatch(/\d{3,}/)
    expect(typeof ScheduleEditor).toBe("function")
  })

  it("the save sends the fields the tools take, a card link only when paid by card link", () => {
    const p = scheduleParams(
      filled({ paid_by: "transfer", card_link_url: "https://pay.example/x" }),
      "active",
    )
    expect(p).toMatchObject({
      issuer_profile_id: "issuer-1",
      contact_id: "contact-1",
      repeats: "month",
      billing_day: "last",
      status: "active",
    })
    expect("card_link_url" in p).toBe(false)
    expect("billsOtherThanStripe" in p).toBe(false)
    expect(
      scheduleParams(
        filled({ paid_by: "card_link", card_link_url: "https://pay.example/x" }),
        "draft",
      ).card_link_url,
    ).toBe("https://pay.example/x")
  })
})

describe("the editor speaks in the units a person types", () => {
  it("the preview fills {period} with the period the next invoice bills", () => {
    expect(previewDescription("Maintenance plan, {period}", "month", "2026-11-30")).toBe(
      "Maintenance plan, November 2026",
    )
    expect(previewDescription("Support, {period}", "quarter", "2026-12-31")).toBe(
      "Support, Q4 2026",
    )
    expect(previewDescription("No token", "month", undefined)).toBe("No token")
  })

  it("the lines error names a price and a VAT percent, never minor units or basis points", () => {
    const errors = draftErrors({ ...defaultSchedule(), issuer_profile_id: "i", contact_id: "c" })
    const lines = errors.find((e) => e.includes("line"))
    expect(lines).toContain("a VAT rate from 0 to 100 %")
    expect(errors.join(" ")).not.toMatch(/minor units|basis points/)
  })

  it("names the series read-only from the issuer, and the title names the customer", () => {
    const issuers = [{ id: "i1", legal_name: "Studio Sud", prefix_invoice: "F-{YYYY}-" }] as never
    expect(seriesOf(issuers, "i1")).toMatch(/^F-\d{4}- then the next number, from Studio Sud$/)
    expect(seriesOf(issuers, null)).toBeNull()
    expect(scheduleTitle("Klangwerk GmbH")).toBe("Recurring: Klangwerk GmbH")
    expect(scheduleTitle(null)).toBe("Recurring schedule")
  })
})
