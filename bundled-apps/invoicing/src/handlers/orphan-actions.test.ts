// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The two actions on a Stripe payment no invoice explains: create the invoice, or link it to one.
// Both are a person's decision, never auto-approved.
import { describe, expect, test } from "bun:test"
import manifest from "../../app.manifest.json"
import { onStripeInvoiceFinalized } from "./stripe-invoice-finalized"
import { finalized, invoices, parks, stripeCtx, stripeDb } from "./stripe-money.testkit"
import {
  chargeLines,
  invoiceFromStripePayment,
  invoiceFromStripePaymentPreflight,
  onStripePaymentUnmatched,
  paymentLinkToInvoice,
  paymentLinkToInvoicePreflight,
} from "./stripe-payment-unmatched"

type Row = Record<string, unknown>
const tools = manifest.tools as unknown as Record<string, Row>
const approved = {
  approvalRequestId: "a1",
  approvalDeciderId: "u1",
  toolName: "invoicing:invoice_from_stripe_payment",
}
const charge = (id: string) => ({
  charge_id: id,
  amount_minor: "6000",
  currency: "eur",
  created: "2026-11-12",
  customer: finalized().customer,
})

describe("a Stripe payment with no invoice", () => {
  test("a click on Create the invoice with its confirm runs at once and parks nothing", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    await onStripePaymentUnmatched(charge("ch_7"), ctx)
    expect(
      await invoiceFromStripePaymentPreflight(ctx, { chargeId: "ch_7", vatRateBp: 2000 }),
    ).toMatchObject({ ok: true, noAutoApprove: true })
    // The person's click is the approval: the handler issues now, takes the next number, parks nothing.
    const r = await invoiceFromStripePayment(
      { ...ctx, approval: approved },
      { chargeId: "ch_7", vatRateBp: 2000 },
    )
    expect(r).toMatchObject({ status: "completed" })
    const doc = invoices(db)[0] as Row
    expect(doc.external_ref).toBe("stripe:ch_7")
    expect(String(doc.grand_total_minor)).toBe("6000")
    expect(parks(db).every((p) => p.status === "resolved")).toBe(true)
    expect(tools.invoice_from_stripe_payment?.approvalCard).toEqual({
      summary: "Create this invoice now? It takes the next number.",
    })
    // A second click is refused: one invoice per payment.
    const again = await invoiceFromStripePayment(
      { ...ctx, approval: approved },
      { chargeId: "ch_7", vatRateBp: 2000 },
    )
    expect(again).toMatchObject({ status: "error", error: { code: "already_invoiced" } })
  })

  test("an invoice for a 9.99 charge at 20% totals 9.99, with a rounding line where no net fits", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    await onStripePaymentUnmatched({ ...charge("ch_9"), amount_minor: "999" }, ctx)
    const r = await invoiceFromStripePayment(
      { ...ctx, approval: approved },
      { chargeId: "ch_9", vatRateBp: 2000 },
    )
    expect(r).toMatchObject({ status: "completed" })
    expect(String((invoices(db)[0] as Row).grand_total_minor)).toBe("999")
    for (const gross of [1n, 999n, 1000n, 6000n, 12345n]) {
      const total = chargeLines(gross, 2000, "x")?.reduce(
        (a, l) =>
          a +
          BigInt(String(l.unit_amount_excl_minor)) +
          (l.tax_rate_bp
            ? (BigInt(String(l.unit_amount_excl_minor)) * 2000n + 5000n) / 10000n
            : 0n),
        0n,
      )
      expect(total).toBe(gross)
    }
  })

  test("a Stripe invoice whose total Liaison would not reproduce waits for a person, never issued off by a cent", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    const r = await onStripeInvoiceFinalized(finalized({ total_minor: "12002" }), ctx)
    expect(r.status).toBe("deferred")
    expect(invoices(db)).toHaveLength(0)
    expect(parks(db)[0]).toMatchObject({ reason: "stripe_total_mismatch" })
    expect(ctx.emitted.filter((e) => e.action === "stripe_tax_review")).toHaveLength(1)
    // A line with several taxes carries no single rate: it waits too.
    const multi = await onStripeInvoiceFinalized(
      finalized({
        stripe_invoice_id: "in_m",
        lines: [{ description: "Plan", quantity: 1, unit_amount_excl_minor: "10000" }],
      }),
      ctx,
    )
    expect(multi.status).toBe("deferred")
  })

  test("a charge linked by hand to an invoice past the first 500 is still found", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    for (let i = 0; i < 600; i++)
      await db.insert("documents", {
        type: "invoice",
        status: "issued",
        number: `FA-${i}`,
        external_refs: i === 599 ? { stripe_charge_id: "ch_far" } : {},
      })
    expect(await onStripePaymentUnmatched(charge("ch_far"), ctx)).toMatchObject({
      status: "skipped",
      reason: "already_linked",
    })
  })

  test("linking a charge twice answers already_linked", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    await onStripeInvoiceFinalized(finalized({ stripe_invoice_id: "in_x" }), ctx)
    const doc = invoices(db)[0] as Row
    await onStripePaymentUnmatched(charge("ch_8"), ctx)
    expect(
      await paymentLinkToInvoicePreflight(ctx, { chargeId: "ch_8", documentId: String(doc.id) }),
    ).toMatchObject({ ok: true })
    const first = await paymentLinkToInvoice(
      { ...ctx, approval: approved },
      { chargeId: "ch_8", documentId: String(doc.id) },
    )
    expect(first.status).toBe("completed")
    expect(
      parks(db).filter((p) => p.event_id === "stripe:ch_8" && p.status !== "resolved"),
    ).toHaveLength(0)
    const second = await paymentLinkToInvoice(
      { ...ctx, approval: approved },
      { chargeId: "ch_8", documentId: String(doc.id) },
    )
    expect(second).toMatchObject({ status: "error", error: { code: "already_linked" } })
  })

  test("an auto-approve policy does not issue from a Stripe payment", () => {
    for (const name of ["invoice_from_stripe_payment", "payment_link_to_invoice"]) {
      expect(tools[name]).toMatchObject({ gated: true, noAutoApprove: true })
    }
  })
})
