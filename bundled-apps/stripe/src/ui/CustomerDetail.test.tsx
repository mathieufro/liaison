// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One customer's page: a dispute is a line to read, a Stripe-issued invoice shows no Liaison number,
// cards are masked, and Cancel only asks in the discussion.
import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loadCustomer, StripeCustomerDetail } from "./CustomerDetail"
import {
  cardExpired,
  discussionAsk,
  disputeLine,
  invoiceView,
  maskedCard,
  paymentView,
} from "./customers-model"
import { postToDiscussion } from "./discussion"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
  ;(globalThis as any).__LIAISON_TEST_APP_NAME = undefined
})

describe("the customer page", () => {
  it("a dispute has no submit control", () => {
    const line = disputeLine(
      {
        id: "dp_1",
        paymentId: "ch_1",
        amountMinor: 58800,
        currency: "eur",
        reason: "unrecognized",
        status: "needs_response",
        evidenceDueBy: "2026-11-20T00:00:00Z",
      },
      "en",
    )
    expect(line.action).toBeNull()
    expect(line.text).toContain("€588.00")
    expect(line.text).toContain("unrecognized")
    // The section holds a line and a pointer to Stripe, never a button.
    const src = readFileSync(join(import.meta.dir, "CustomerDetail.tsx"), "utf8")
    const at = src.indexOf('<Section id="disputes"')
    expect(at).toBeGreaterThan(0)
    expect(src.slice(at, src.indexOf("</Section>", at))).not.toMatch(/<button|onClick/)
  })

  it("a mode B invoice shows no Liaison number", () => {
    const stripeIssued = invoiceView(
      {
        id: "in_1",
        customerId: "cus_a",
        subscriptionId: null,
        status: "paid",
        amountDueMinor: 0,
        totalMinor: 49000,
        currency: "eur",
        nextPaymentAttempt: null,
        number: "ABC-0001",
        issuer: "stripe",
        liaisonDocumentId: "doc-9",
      },
      "en",
    )
    expect(stripeIssued.issuedBy).toBe("stripe")
    expect(stripeIssued.issuedLabel).toBe("Issued by Stripe")
    expect(stripeIssued.documentId).toBeNull()
    const ours = invoiceView(
      {
        id: "in_2",
        customerId: "cus_a",
        subscriptionId: null,
        status: "open",
        amountDueMinor: 174000,
        totalMinor: 174000,
        currency: "eur",
        nextPaymentAttempt: null,
        number: "F-2026-0418",
        issuer: "liaison",
        liaisonDocumentId: "doc-1",
      },
      "en",
    )
    expect(ours.issuedLabel).toBe("Issued by Liaison, collected by Stripe")
    expect(ours.documentId).toBe("doc-1")
    expect(ours.statusLabel).toBe("Unpaid")
  })

  it("an invoice Liaison issued reads Liaison's number, not the Stripe id", () => {
    const ours = invoiceView(
      {
        id: "in_TFarlon",
        customerId: "cus_a",
        subscriptionId: null,
        status: "open",
        amountDueMinor: 174000,
        totalMinor: 174000,
        currency: "eur",
        nextPaymentAttempt: null,
        number: null,
        issuer: "liaison",
        liaisonDocumentId: "doc-1",
        liaisonDocumentNumber: "F-2026-0418",
      },
      "en",
    )
    expect([ours.number, ours.documentId]).toEqual(["F-2026-0418", "doc-1"])
    const theirs = invoiceView(
      {
        id: "in_3",
        customerId: "cus_a",
        subscriptionId: null,
        status: "paid",
        amountDueMinor: 0,
        totalMinor: 100,
        currency: "eur",
        nextPaymentAttempt: null,
        number: "ABC-0002",
        issuer: "stripe",
        liaisonDocumentId: null,
        liaisonDocumentNumber: "F-2026-0001",
      },
      "en",
    )
    expect(theirs.number).toBe("ABC-0002")
  })

  it("Cancel posts to the discussion and runs nothing", async () => {
    const tools: string[] = []
    const fetched: Array<{ path: string; body: any }> = []
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = "stripe"
    ;(globalThis as any).__liaisonHost = {
      invokeTool: async (_a: string, tool: string) => {
        tools.push(tool)
        return {}
      },
      fetch: async (path: string, init?: { body?: string }) => {
        fetched.push({ path, body: init?.body ? JSON.parse(init.body) : null })
        return path.endsWith("/entity-discussion") ? { data: { threadId: "t1" } } : { data: {} }
      },
    }
    const text = discussionAsk(
      "cancel",
      { id: "cus_a", name: "Maison Arlon", email: null },
      { id: "sub_1", label: "Group plan" },
    )
    await postToDiscussion("row-1", text)
    expect(tools).toEqual([])
    expect(fetched.map((f) => f.path)).toEqual([
      "/api/threads/entity-discussion",
      "/api/threads/t1/messages",
    ])
    expect(fetched[0]?.body).toEqual({ app: "stripe", entityType: "customer", entityId: "row-1" })
    expect(fetched[1]?.body.content).toContain("cancellation of Group plan")
    expect(fetched[1]?.body.content).toContain("for my approval")
    // The page never calls the cancel or refund tool from its Refund and Cancel buttons.
    const src = readFileSync(join(import.meta.dir, "CustomerDetail.tsx"), "utf8")
    expect(src).not.toMatch(/invokeTool[^)]*"(subscription_cancel|refunds_create)"/)
    expect(typeof StripeCustomerDetail).toBe("function")
    expect(typeof loadCustomer).toBe("function")
  })

  it("shows a card as brand, last 4 and expiry and nothing more", () => {
    expect(maskedCard({ brand: "visa", last4: "4242", exp: "10/26" })).toBe("Visa 4242, 10/26")
    // Whatever a read held, only the last four digits are ever drawn.
    expect(maskedCard({ brand: "visa", last4: "4242424242424242", exp: "10/26" })).toBe(
      "Visa 4242, 10/26",
    )
    expect(maskedCard(null)).toBe("No card")
    expect(
      cardExpired({ brand: "visa", last4: "4242", exp: "10/26" }, new Date("2026-11-10")),
    ).toBe(true)
    expect(
      cardExpired({ brand: "visa", last4: "4242", exp: "10/27" }, new Date("2026-11-10")),
    ).toBe(false)
    const p = paymentView(
      {
        id: "ch_1",
        customerId: "c",
        invoiceId: null,
        amountMinor: 174000,
        refundedMinor: 0,
        currency: "eur",
        status: "succeeded",
        failureCode: null,
        disputed: false,
        at: null,
        card: { brand: "visa", last4: "4242", exp: "10/26" },
      },
      "en",
    )
    expect(p.detail).toBe("Visa 4242, 10/26")
    expect(p.refundable?.label).toBe("€1,740.00")
  })
})
