// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The refund cards: the pending approval with the refundable remainder, the other ways it can go, and the
// confirm that says what an action does before it does it.
import { describe, expect, it } from "bun:test"
import type { PaymentItem } from "./customers-model"
import { RefundCard } from "./RefundCards"
import {
  amountText,
  decideRefund,
  editedAmount,
  type RefundApproval,
  refundCardView,
  refundsOf,
  retryConfirm,
} from "./refund-model"

const payment = (over: Partial<PaymentItem> = {}): PaymentItem => ({
  id: "ch_3QOmbre1014",
  customerId: "cus_a",
  invoiceId: "in_1",
  amountMinor: 17880,
  refundedMinor: 0,
  currency: "eur",
  status: "succeeded",
  failureCode: null,
  disputed: false,
  at: "2026-10-14T10:00:00Z",
  card: { brand: "mastercard", last4: "5108", exp: "07/27" },
  ...over,
})
const approval = (over: Partial<RefundApproval> = {}): RefundApproval => ({
  id: "ap1",
  toolName: "stripe:refunds_create",
  status: "pending",
  payload: { chargeId: "ch_3QOmbre1014" },
  ...over,
})

describe("refund cards", () => {
  it('"Try again" asks a confirm stating the amount and card', () => {
    const v = refundCardView(
      approval({ error: "Your Stripe balance is too low to cover it today." }),
      payment(),
      "en",
    )
    expect(v.state).toBe("refused")
    const retry = v.actions.find((a) => a.id === "retry")
    expect(retry?.confirm).toBeTruthy()
    expect(retry?.confirm).toContain("€178.80")
    expect(retry?.confirm).toContain("Mastercard 5108")
    expect(retry?.confirm).toBe(retryConfirm("€178.80", "Mastercard 5108, 07/27"))
    // A refused refund names no credit note and says nothing was lost.
    expect(v.note).toContain("Stripe balance")
    expect(typeof RefundCard).toBe("function")
  })

  it('"Try again" asks for the refused amount, capped at what is left, and its confirm names that figure', () => {
    // A refused partial refund of 20.00 on a 178.80 charge.
    const v = refundCardView(
      approval({ payload: { chargeId: "ch_3QOmbre1014", amountMinor: "2000" }, error: "Refused." }),
      payment(),
      "en",
    )
    expect(v.retryMinor).toBe(2000)
    expect(v.actions.find((a) => a.id === "retry")?.confirm).toBe(
      retryConfirm("€20.00", "Mastercard 5108, 07/27"),
    )
    // More than is left by now: capped, and the confirm says the capped figure.
    const capped = refundCardView(
      approval({ payload: { chargeId: "ch_3QOmbre1014", amountMinor: "9000" }, error: "Refused." }),
      payment({ refundedMinor: 17880 - 5000 }),
      "en",
    )
    expect(capped.retryMinor).toBe(5000)
    expect(capped.actions.find((a) => a.id === "retry")?.confirm).toContain("€50.00")
  })

  it('"Save and approve" saves the typed amount on the approval and approves that saved version', async () => {
    const calls: unknown[][] = []
    const host = {
      editApproval: async (id: string, fields: Record<string, unknown>) => {
        calls.push(["edit", id, fields])
        return { payloadHash: "h-edited" }
      },
      decideApproval: async (id: string, decision: string, hash?: string) => {
        calls.push(["decide", id, decision, hash])
      },
    }
    const a = approval({ payloadHash: "h-agent" })
    const edit = { text: "89.40", currency: "eur", leftMinor: 17880, currentMinor: 17880 }
    expect(await decideRefund(host, a, "approve", edit)).toBeNull()
    expect(calls).toEqual([
      ["edit", "ap1", { amountMinor: "8940" }],
      ["decide", "ap1", "approve", "h-edited"],
    ])
    // An amount above what is left decides nothing.
    calls.length = 0
    expect(await decideRefund(host, a, "approve", { ...edit, text: "500" })).toHaveProperty("error")
    expect(calls).toEqual([])
    // Unchanged: the agent's version is approved as it stands.
    expect(await decideRefund(host, a, "approve", { ...edit, text: "178.80" })).toBeNull()
    expect(calls).toEqual([["decide", "ap1", "approve", "h-agent"]])
  })

  it("the edited amount is read from what a person types, and must fit what is left", () => {
    expect(amountText(8940, "eur")).toBe("89.40")
    expect(editedAmount("89,40", "eur", 17880)).toEqual({ minor: 8940 })
    expect(editedAmount(" 12 ", "eur", 17880)).toEqual({ minor: 1200 })
    expect(editedAmount("0", "eur", 17880)).toHaveProperty("error")
    expect(editedAmount("12.345", "eur", 17880)).toHaveProperty("error")
    expect(editedAmount("abc", "eur", 17880)).toHaveProperty("error")
    expect((editedAmount("200", "eur", 17880) as { error: string }).error).toContain("178.80")
  })

  it("shows the pending approval and what is still refundable", () => {
    const v = refundCardView(approval(), payment({ refundedMinor: 8940 }), "en")
    expect(v.state).toBe("pending")
    expect(v.remainder).toBe("€89.40")
    expect(v.remainderMinor).toBe(8940)
    expect(v.actions.map((a) => a.id)).toEqual(["edit", "approve", "reject"])
    // Edited down to a part: the amount asked is the payload's.
    const part = refundCardView(
      approval({ payload: { chargeId: "ch_3QOmbre1014", amountMinor: 8940 }, editing: true }),
      payment(),
      "en",
    )
    expect(part.state).toBe("editing")
    expect(part.amount).toBe("€89.40")
    expect(part.actions.map((a) => a.id)).toEqual(["approve", "reject"])
  })

  it("a charge already refunded in full offers the credit note, with a confirm that says what it asks", () => {
    const v = refundCardView(approval(), payment({ refundedMinor: 17880 }), "en")
    expect(v.state).toBe("already_refunded")
    expect(v.canApprove).toBe(false)
    const note = v.actions.find((a) => a.id === "credit_note")
    expect(note?.label).toBe("Issue the credit note for it")
    expect(note?.confirm).toContain("€178.80")
    expect(note?.confirm).toContain("nothing is issued until a person approves")
  })

  it("holds Approve while the key is revoked and only matches this customer's charges", () => {
    expect(refundCardView(approval(), payment(), "en", true).canApprove).toBe(false)
    const mine = refundsOf(
      [
        approval(),
        approval({ id: "ap2", payload: { chargeId: "ch_other" } }),
        approval({ id: "ap3", toolName: "stripe:subscription_cancel" }),
      ],
      [payment()],
    )
    expect(mine.map((m) => m.approval.id)).toEqual(["ap1"])
  })
})
