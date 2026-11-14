// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe page's first screen: the attention groups, the trials, the MRR block
// and the "how this is computed" text that reads the query's own constants.
import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MRR_RULES, mrrRuleLines } from "../mrr"
import {
  buildAttention,
  buildMrrView,
  canReview,
  type MrrResult,
  toggleReview,
  trialsEnding,
} from "./home-model"
import { evidenceDueLine, howComputedLines, StripeHome } from "./StripeHome"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
})

const NOW = new Date("2026-11-10T09:00:00.000Z")
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString()

const sub = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  customerId: `cus_${id}`,
  status: "past_due",
  plan: "Team",
  mrrMinor: 49000,
  currency: "eur",
  currentPeriodEnd: day(20),
  trialEnd: null,
  cancelAt: null,
  pastDueSince: day(-6),
  card: { brand: "visa", last4: "4242", exp: "01/28" },
  ...over,
})
const invoice = (subscriptionId: string, over: Record<string, unknown> = {}) => ({
  id: `in_${subscriptionId}`,
  customerId: `cus_${subscriptionId}`,
  subscriptionId,
  status: "open",
  amountDueMinor: 49000,
  currency: "eur",
  nextPaymentAttempt: null,
  ...over,
})

describe("the how-computed text", () => {
  it("the How panel reads the same constants the query uses", () => {
    // The panel's lines ARE the query's lines, in both languages.
    expect(howComputedLines("en")).toEqual(mrrRuleLines("en"))
    expect(howComputedLines("fr")).toEqual(mrrRuleLines("fr"))
    // And they carry the constants' values: a literal in the panel would not follow a change.
    const joined = howComputedLines("en").join(" ")
    expect(joined).toContain(`${MRR_RULES.weeksPerYear}/${MRR_RULES.monthsPerYear}`)
    expect(joined).toContain(`${MRR_RULES.daysPerYear}/${MRR_RULES.monthsPerYear}`)
    for (const status of MRR_RULES.countedStatuses) expect(joined).toContain(status)
    // Source guard: the component imports the rules and holds no figure of its own.
    const src = readFileSync(join(import.meta.dir, "StripeHome.tsx"), "utf8")
    expect(src).toMatch(/from "\.\.\/mrr"/)
    expect(src).not.toMatch(/52\s*\/\s*12|365\s*\/\s*12|half up/i)
    expect(typeof StripeHome).toBe("function")
  })
})

describe("attention", () => {
  it("retries raise no attention row", () => {
    const subs = [sub("a"), sub("b"), sub("c")]
    // b and c have a retry scheduled; a has none left.
    const invoices = [
      invoice("a"),
      invoice("b", { nextPaymentAttempt: day(1) }),
      invoice("c", { nextPaymentAttempt: day(2), amountDueMinor: 10000 }),
    ]
    const a = buildAttention({
      pastDue: subs,
      openInvoices: invoices,
      disputes: [],
      approvals: [],
      now: NOW,
    })
    expect(a.failed.map((r) => r.subscriptionId)).toEqual(["a"])
    expect(a.retrying.count).toBe(2)
    expect(a.retrying.mrrByCurrency).toEqual({ eur: 98000 })
    // The count in the header is the rows a person has to look at, never the retries.
    expect(a.count).toBe(1)
  })

  it("a retry on an expired card is a failed payment to look at, never in Stripe's retries", () => {
    const a = buildAttention({
      pastDue: [sub("a", { card: { brand: "visa", last4: "4242", exp: "10/26" } }), sub("b")],
      openInvoices: [
        invoice("a", { nextPaymentAttempt: day(1) }),
        invoice("b", { nextPaymentAttempt: day(1) }),
      ],
      disputes: [],
      approvals: [],
      now: NOW,
    })
    expect(a.failed.map((r) => r.subscriptionId)).toEqual(["a"])
    expect(a.retrying.count).toBe(1)
    expect(a.count).toBe(1)
  })

  it("a retry in the past is no retry", () => {
    const a = buildAttention({
      pastDue: [sub("a")],
      openInvoices: [invoice("a", { nextPaymentAttempt: day(-1) })],
      disputes: [],
      approvals: [],
      now: NOW,
    })
    expect(a.failed).toHaveLength(1)
    expect(a.retrying.count).toBe(0)
  })

  it("urgency only orders the rows: the longest overdue first, the soonest deadline first", () => {
    const a = buildAttention({
      pastDue: [sub("a", { pastDueSince: day(-2) }), sub("b", { pastDueSince: day(-9) })],
      openInvoices: [],
      disputes: [
        {
          id: "dp_2",
          paymentId: "ch_2",
          amountMinor: 100,
          currency: "eur",
          reason: null,
          status: "needs_response",
          evidenceDueBy: day(9),
          at: day(-3),
        },
        {
          id: "dp_1",
          paymentId: "ch_1",
          amountMinor: 100,
          currency: "eur",
          reason: null,
          status: "needs_response",
          evidenceDueBy: day(2),
          at: day(-3),
        },
        {
          id: "dp_3",
          paymentId: "ch_3",
          amountMinor: 100,
          currency: "eur",
          reason: null,
          status: "won",
          evidenceDueBy: day(1),
          at: day(-3),
        },
      ],
      approvals: [],
      now: NOW,
    })
    expect(a.failed.map((r) => r.subscriptionId)).toEqual(["b", "a"])
    expect(a.disputes.map((d) => d.id)).toEqual(["dp_1", "dp_2"])
    expect(a.count).toBe(4)
  })

  it("a dispute's deadline reads as a short date, as the rest of the page", () => {
    expect(evidenceDueLine("2026-11-14T00:00:00Z", "en")).toBe(
      "Evidence is due in Stripe by Nov 14.",
    )
    expect(evidenceDueLine(null, "en")).toBe("Evidence is due in Stripe.")
  })

  it("Review expands only the pending approval", () => {
    const approvals = [
      {
        id: "ap_1",
        toolName: "stripe:refunds_create",
        status: "pending",
        summary: { title: "Refund 178.80 EUR on ch_9", lines: [] },
      },
      {
        id: "ap_2",
        toolName: "stripe:refunds_create",
        status: "decided",
        summary: { title: "Refund", lines: [] },
      },
      {
        id: "ap_3",
        toolName: "invoicing:invoice_issue",
        status: "pending",
        summary: { title: "Issue", lines: [] },
      },
    ]
    const a = buildAttention({ pastDue: [], openInvoices: [], disputes: [], approvals, now: NOW })
    // Only this app's own pending money requests are rows.
    expect(a.requests.map((r) => r.id)).toEqual(["ap_1"])
    expect(canReview(a, "ap_1")).toBe(true)
    expect(canReview(a, "ap_2")).toBe(false)
    expect(canReview(a, "dp_1")).toBe(false)
    // One open at a time; the same click closes it; an id that is no pending approval opens nothing.
    expect(toggleReview(a, null, "ap_1")).toBe("ap_1")
    expect(toggleReview(a, "ap_1", "ap_1")).toBeNull()
    expect(toggleReview(a, "ap_1", "ap_3")).toBe("ap_1")
    expect(toggleReview(a, null, "dp_1")).toBeNull()
  })
})

describe("trials", () => {
  it("lists trials ending within 7 days, soonest first, with the card on file said plainly", () => {
    const rows = trialsEnding(
      [
        sub("a", { status: "trialing", trialEnd: day(6), card: null }),
        sub("b", { status: "trialing", trialEnd: day(3) }),
        sub("c", { status: "trialing", trialEnd: day(7.5) }),
        sub("d", { status: "trialing", trialEnd: day(-1) }),
        sub("e", { status: "trialing", trialEnd: day(7) }),
      ],
      NOW,
    )
    expect(rows.map((r) => [r.subscriptionId, r.days, r.cardOnFile])).toEqual([
      ["b", 3, true],
      ["a", 6, false],
      ["e", 7, true],
    ])
  })
})

describe("monthly recurring revenue", () => {
  const result: MrrResult = {
    partial: false,
    asOf: "2026-11-10T08:58:00.000Z",
    rules: [],
    lines: [
      {
        currency: "eur",
        mrrMinor: 8470800,
        pastDueMinor: 336700,
        activeCount: 169,
        byPlan: [
          { plan: "Team", mrrMinor: 5000000, count: 83 },
          { plan: "Starter", mrrMinor: 2000000, count: 62 },
        ],
        movements: {
          newMinor: 294000,
          upgradeMinor: 96000,
          downgradeMinor: -34100,
          cancelledMinor: -127800,
          netMinor: 228100,
          startMinor: 8242700,
        },
        monthStart: "2026-11-01",
      },
      {
        currency: "usd",
        mrrMinor: 12000,
        pastDueMinor: 0,
        activeCount: 1,
        byPlan: [{ plan: "Team", mrrMinor: 12000, count: 1 }],
        movements: {
          newMinor: 0,
          upgradeMinor: 0,
          downgradeMinor: 0,
          cancelledMinor: 0,
          netMinor: 0,
          startMinor: 12000,
        },
        monthStart: "2026-11-01",
      },
    ],
  }

  it("each currency has its own block with its own figures, never converted", () => {
    const view = buildMrrView(result, "en")
    expect(view?.lines.map((l) => l.currency)).toEqual(["EUR", "USD"])
    expect(view?.lines[0]?.total).toContain("84,708")
    expect(view?.lines[0]?.change).toContain("2,281")
    expect(view?.lines[0]?.start).toContain("82,427")
    expect(view?.lines[1]?.total).toContain("120")
    // The rule line stays on the block: one currency per line, nothing converted.
    expect(view?.ruleLine).toBe("Each currency is its own line and is never converted.")
  })

  it("no MRR shows during import: a partial answer gives no figure and no block", () => {
    expect(buildMrrView({ partial: true, asOf: null, rules: [], lines: [] }, "en")).toBeNull()
    expect(buildMrrView(null, "en")).toBeNull()
    // Even a partial answer that carries lines shows none: the mirror is incomplete.
    expect(buildMrrView({ ...result, partial: true }, "en")).toBeNull()
  })

  it("says when movements are incomplete", () => {
    const view = buildMrrView({ ...result, movementsIncompleteBefore: "2026-10-20" }, "en")
    expect(view?.incomplete).toBe("Movements incomplete before 2026-10-20.")
  })
})

describe("calm interface", () => {
  it("no alarm colour anywhere in the Stripe screens", () => {
    for (const f of ["StripeHome.tsx", "HomeStates.tsx", "StripeSidebar.tsx", "home-model.ts"]) {
      const src = readFileSync(join(import.meta.dir, f), "utf8")
      expect(src).not.toMatch(
        /\b(?:text|bg|border)-(?:red|rose|orange|danger|error)\b|animate-(?:pulse|ping|bounce)|tone="error"/,
      )
    }
  })
})
