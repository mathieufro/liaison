// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The less common situations of recurring invoicing, and the e-invoice status words an invoice
// shows: each word maps to exactly one state, and each state says what happens next.
import { afterEach, describe, expect, it } from "bun:test"
import { FR } from "./i18n-fr"
import {
  EINVOICE_STATUS_TABLE,
  type EinvoiceFacts,
  einvoiceStatusWord,
  LOAD_ERROR_LINES,
  ORPHAN_ACTIONS,
  OVERFLOW_PAGE,
  orphanParams,
  RecurringStates,
} from "./RecurringStates"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
})

const WORDS = [
  "Waiting for payment",
  "Collected",
  "Partly collected",
  "Not needed",
  "Refused by the buyer",
  "Not sent",
  "To report at your platform",
]

const facts = (over: Partial<EinvoiceFacts>): EinvoiceFacts => ({
  einvoice_state: "sent",
  collection_state: null,
  payment_status: "unpaid",
  ...over,
})

describe("e-invoice status words", () => {
  it("each status word maps to one state in a table", () => {
    // The table the invoice and the states page show, one row per word, each with what it means.
    expect(EINVOICE_STATUS_TABLE.map((r) => r.word)).toEqual(WORDS)
    for (const row of EINVOICE_STATUS_TABLE) expect(row.means.length).toBeGreaterThan(10)
    // One stored state per word, and every word reached by exactly one of them.
    const states: Array<[EinvoiceFacts, string]> = [
      [facts({}), "Waiting for payment"],
      [facts({ collection_state: "reported", payment_status: "paid" }), "Collected"],
      [facts({ collection_state: "reported", payment_status: "partial" }), "Partly collected"],
      [facts({ collection_state: "not_needed", payment_status: "paid" }), "Not needed"],
      [facts({ einvoice_state: "refused" }), "Refused by the buyer"],
      [facts({ einvoice_state: "failed" }), "Not sent"],
      [
        facts({ collection_state: "collection_manual", payment_status: "paid" }),
        "To report at your platform",
      ],
    ]
    const reached = states.map(([f]) => einvoiceStatusWord(f))
    expect(reached).toEqual(states.map(([, w]) => w))
    expect(new Set(reached).size).toBe(WORDS.length)
    for (const w of reached)
      expect(EINVOICE_STATUS_TABLE.filter((r) => r.word === w)).toHaveLength(1)
    // A document that never went to the platform has no word at all.
    expect(einvoiceStatusWord(facts({ einvoice_state: null }))).toBeNull()
    // Every word has French.
    for (const row of EINVOICE_STATUS_TABLE) {
      expect(FR[row.word]).toBeTruthy()
      expect(FR[row.means]).toBeTruthy()
    }
  })

  it("a buyer's refusal wins over a payment, and a rejected deposit reads as refused too", () => {
    expect(
      einvoiceStatusWord(
        facts({ einvoice_state: "refused", collection_state: "reported", payment_status: "paid" }),
      ),
    ).toBe("Refused by the buyer")
    expect(einvoiceStatusWord(facts({ einvoice_state: "rejected" }))).toBe("Refused by the buyer")
    expect(einvoiceStatusWord(facts({ einvoice_state: "not_in_directory" }))).toBe("Not sent")
  })
})

describe("less common situations", () => {
  it("a list that cannot load says no invoice is affected and runs still happen", () => {
    expect(LOAD_ERROR_LINES.title).toBe("Could not load your schedules")
    expect(LOAD_ERROR_LINES.body).toContain("Runs that are due still happen on their own")
    expect(OVERFLOW_PAGE).toBe(50)
    expect(typeof RecurringStates).toBe("object")
  })

  it("a Stripe payment with no invoice offers two actions, each asking a confirm", () => {
    expect(ORPHAN_ACTIONS.map((a) => a.tool)).toEqual([
      "invoice_from_stripe_payment",
      "payment_link_to_invoice",
    ])
    for (const a of ORPHAN_ACTIONS) expect(a.confirm.length).toBeGreaterThan(10)
    // Linking never marks the invoice paid, so the confirm does not say it does.
    expect(ORPHAN_ACTIONS.find((a) => a.id === "link")?.confirm).not.toContain("marked paid")
  })

  it("Create the invoice sends the VAT rate the amount includes, the one thing a charge with no invoice lacks", () => {
    expect(orphanParams("create", "ch_1", null, "20")).toEqual({
      params: { chargeId: "ch_1", vatRateBp: 2000 },
    })
    expect(orphanParams("create", "ch_1", null, "5,5")).toEqual({
      params: { chargeId: "ch_1", vatRateBp: 550 },
    })
    expect(orphanParams("create", "ch_1", null, "0")).toEqual({
      params: { chargeId: "ch_1", vatRateBp: 0 },
    })
    expect(orphanParams("create", "ch_1", null, "twenty")).toHaveProperty("error")
    expect(orphanParams("link", "ch_1", "doc-1", "")).toEqual({
      params: { chargeId: "ch_1", documentId: "doc-1" },
    })
  })
})
