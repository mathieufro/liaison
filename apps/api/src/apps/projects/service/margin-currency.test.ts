// SPDX-License-Identifier: FSL-1.1-ALv2
// Margin subtracts time at cost from invoices only when both are in one currency.
import { describe, expect, it } from "bun:test"
import { composeMargin, type MarginCost } from "./margin"

const cost = (costCurrencies: string[], costUnlabelled = false): MarginCost => ({
  projectId: "p",
  projectName: "A project",
  period: null,
  costMinor: 10_000,
  takenMinutes: 120,
  minutesWithoutRate: 0,
  partial: false,
  coverage: { withEntries: 1, total: 1 },
  currency: "EUR",
  costCurrencies,
  costUnlabelled,
})
const invoiced = (currency: string | null) =>
  ({ ok: true, invoicedMinor: 50_000, currency, documents: 1 }) as const

describe("margin and currencies", () => {
  it("cost in one currency and invoices in another refuse with mixed_currencies", () => {
    const out = composeMargin(cost(["USD"]), invoiced("EUR"))
    expect("error" in out && out.error.code).toBe("mixed_currencies")
  })

  it("one currency throughout gives the margin", () => {
    const out = composeMargin(cost(["EUR"]), invoiced("EUR"))
    expect("margin" in out && out.margin).toBe(400)
  })

  it("rates with no currency take the invoices' currency", () => {
    const out = composeMargin(cost([]), invoiced("EUR"))
    expect("currency" in out && out.currency).toBe("EUR")
  })

  it("time at a rate with no currency beside time at a USD rate refuses, though invoices are USD", () => {
    const out = composeMargin(cost(["USD"], true), invoiced("USD"))
    expect("error" in out && out.error.code).toBe("mixed_currencies")
    expect("error" in out && out.error.message).toContain("no currency")
  })

  it("invoicing's own mixed-currency refusal is passed on, never read as unreadable", () => {
    const out = composeMargin(cost(["EUR"]), {
      ok: false,
      off: false,
      refusal: { code: "mixed_currencies", message: "Two currencies. Nothing was summed." },
    })
    expect("error" in out && out.error.code).toBe("mixed_currencies")
  })
})
