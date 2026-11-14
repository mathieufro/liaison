// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The customers list: what a search and a chip ask of the mirror, the plan totals, the order of rows,
// and the company suggestion.
import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loadList, StripeCustomersList } from "./CustomersList"
import {
  buildRows,
  type CustomerItem,
  countLabel,
  linkOffer,
  listRequest,
  planTotals,
  statusOf,
  whatHappensNext,
} from "./customers-model"
import type { MrrResult, SubItem } from "./home-model"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
  ;(globalThis as any).__LIAISON_TEST_APP_NAME = undefined
})

const cust = (id: string, over: Partial<CustomerItem> = {}): CustomerItem => ({
  id,
  rowId: `row-${id}`,
  name: `Name ${id}`,
  email: `${id}@client.example`,
  currency: "eur",
  delinquent: false,
  deleted: false,
  companyId: null,
  contactId: null,
  linkedBy: null,
  ...over,
})
const sub = (customerId: string, over: Partial<SubItem> = {}): SubItem => ({
  id: `sub_${customerId}`,
  customerId,
  status: "active",
  plan: "Team",
  mrrMinor: 49000,
  currency: "eur",
  trialEnd: null,
  pastDueSince: null,
  card: null,
  ...over,
})

describe("the list reads the mirror", () => {
  it("search and the Subscriptions filter read the mirror by name, email and id", async () => {
    // A name, an email and a Stripe id all go to the mirror as typed.
    for (const q of ["Maison Arlon", "claire@maison-arlon.example", "cus_RarlonHotels"]) {
      const r = listRequest(q, "all")
      expect(r.tool).toBe("customers_search")
      expect(r.args.query).toBe(q)
      expect(r.args.filter).toBeUndefined()
      // The Subscriptions chip is a state of the same list: the same read, kept to live subscriptions.
      const s = listRequest(q, "subscriptions")
      expect(s.args.query).toBe(q)
      expect(s.liveOnly).toBe(true)
    }
    expect(listRequest("", "unlinked").args.filter).toBe("unlinked")
    expect(listRequest("", "past_due").args.filter).toBe("past_due")

    // Through the host: the page's own call carries the search, and nothing else is asked of the mirror by name.
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = "stripe"
    ;(globalThis as any).__liaisonHost = {
      invokeTool: async (_app: string, tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args })
        if (tool === "customers_search") return { items: [cust("cus_a")], nextCursor: null }
        return { items: [] }
      },
    }
    const page = await loadList("claire@maison-arlon.example", "subscriptions")
    expect(calls[0]).toEqual({
      tool: "customers_search",
      args: { limit: 25, query: "claire@maison-arlon.example" },
    })
    expect(page.customers.map((c) => c.id)).toEqual(["cus_a"])
    expect(typeof StripeCustomersList).toBe("function")
  })

  it("the Subscriptions filter's plan totals equal the query's byPlan", () => {
    const mrr: MrrResult = {
      partial: false,
      asOf: null,
      rules: [],
      lines: [
        {
          currency: "eur",
          mrrMinor: 1000000,
          pastDueMinor: 0,
          activeCount: 169,
          byPlan: [
            { plan: "Team", mrrMinor: 800000, count: 120 },
            { plan: "Starter", mrrMinor: 200000, count: 49 },
          ],
          movements: {
            newMinor: 0,
            upgradeMinor: 0,
            downgradeMinor: 0,
            cancelledMinor: 0,
            netMinor: 0,
            startMinor: 0,
          },
          monthStart: "2026-11-01",
        },
      ],
    }
    // The page shows three customers; the totals still are the query's, never the page's sum.
    const page = buildRows(
      [cust("a"), cust("b"), cust("c")],
      { a: [sub("a")], b: [sub("b")], c: [sub("c")] },
      true,
    )
    expect(page.length).toBe(3)
    const totals = planTotals(mrr, "en")
    expect(totals[0]?.plans.map((p) => [p.plan, p.count])).toEqual([
      ["Team", 120],
      ["Starter", 49],
    ])
    // No total while the answer is partial.
    expect(planTotals({ ...mrr, partial: true }, "en")).toEqual([])
    // Source guard: the list reads the totals from the model and sums nothing itself.
    const src = readFileSync(join(import.meta.dir, "CustomersList.tsx"), "utf8")
    expect(src).toContain("planTotals(")
    expect(src).not.toMatch(/\.reduce\(/)
  })

  it("before Stripe is connected the page says so and offers the connect form, never counts of 0", () => {
    const src = readFileSync(join(import.meta.dir, "CustomersList.tsx"), "utf8")
    expect(src).toContain('pageKind(h) === "not_connected"')
    expect(src).toContain('data-testid="stripe-customers-not-connected"')
    expect(src).toContain('navigate("/settings/apps/stripe?open=stripe")')
  })

  it("a personal address gets no company suggestion", () => {
    const suggestion = { companyId: "co1", name: "Mail Provider", domain: "mail.example" }
    for (const email of ["nadia.ferrand@gmail.com", "x@outlook.fr", "y@hotmail.com"]) {
      expect(linkOffer({ email }, suggestion).kind).toBe("none")
    }
    expect(linkOffer({ email: "compta@bistrot-garance.example" }, suggestion).kind).toBe(
      "suggested",
    )
    expect(linkOffer({ email: "compta@bistrot-garance.example" }, null).kind).toBe("none")
    expect(linkOffer({ email: null }, suggestion).kind).toBe("none")
  })
})

describe("rows", () => {
  it("the Subscriptions filter keeps only customers with a live subscription", () => {
    const rows = buildRows(
      [cust("a"), cust("b"), cust("c")],
      { a: [sub("a")], b: [sub("b", { status: "canceled" })], c: [] },
      true,
    )
    expect(rows.map((r) => r.customer.id)).toEqual(["a"])
    expect(buildRows([cust("a"), cust("b")], { a: [sub("a")], b: [] }, false).length).toBe(2)
  })

  it("lists problems first, then the mirror's order", () => {
    const rows = buildRows(
      [cust("a"), cust("b"), cust("c", { delinquent: true })],
      { a: [sub("a")], b: [sub("b", { status: "past_due" })], c: [] },
      false,
    )
    expect(rows.map((r) => r.customer.id)).toEqual(["b", "c", "a"])
  })

  it("says what happens next and keeps the status calm", () => {
    const past = sub("p", { status: "past_due", pastDueSince: "2026-11-03T00:00:00Z" })
    expect(statusOf(past, {}, "en")).toEqual({ label: "Past due", tone: "problem" })
    expect(whatHappensNext(past, null, "en")).toContain("No retry left")
    expect(whatHappensNext(past, "2026-11-12T00:00:00Z", "en")).toContain("retries")
    expect(
      whatHappensNext(
        sub("t", { status: "trialing", trialEnd: "2026-11-12T00:00:00Z" }),
        null,
        "en",
      ),
    ).toContain("Trial ends")
    expect(countLabel(50, true)).toBe("50+")
    expect(countLabel(3, false)).toBe("3")
  })
})

describe("calm interface", () => {
  it("no alarm colour in the customers screens", () => {
    for (const f of [
      "CustomersList.tsx",
      "CustomerDetail.tsx",
      "RefundCards.tsx",
      "panel-view.tsx",
      "customers-model.ts",
      "refund-model.ts",
      "panels-model.ts",
    ]) {
      const src = readFileSync(join(import.meta.dir, f), "utf8")
      expect(src).not.toMatch(
        /\b(?:text|bg|border)-(?:red|rose|orange|danger|error)\b|animate-(?:pulse|ping|bounce)|tone="error"/,
      )
    }
  })
})
