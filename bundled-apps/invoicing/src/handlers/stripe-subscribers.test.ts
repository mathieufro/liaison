// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Stripe invoices in mode A (Liaison issues card payments' invoices) and mode B (Stripe does),
// handled by invoicing's subscribers on the in-memory store. The real Postgres proofs of the
// money paths (one document under replay and concurrency, the legal date) are in the api
// integration suite.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { reconcileStripePayments } from "./reconcile-stripe-payments"
import { onStripeInvoiceFinalized } from "./stripe-invoice-finalized"
import {
  onStripeInvoiceClosed,
  onStripeInvoicePaid,
  onStripeInvoicePaymentFailed,
} from "./stripe-invoice-paid"
import { finalized, invoices, parks, stripeCtx, stripeDb } from "./stripe-money.testkit"
import { onStripePaymentUnmatched } from "./stripe-payment-unmatched"
import { onStripeRefundCreated } from "./stripe-refund-created"

afterEach(() => setSystemTime())

describe("Stripe invoices handled by invoicing", () => {
  test("a finalized invoice above zero issues one Liaison invoice and a replay gives one document", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    const first = await onStripeInvoiceFinalized({ data: finalized() }, ctx)
    expect(first.status).toBe("ok")
    const again = await onStripeInvoiceFinalized({ data: finalized() }, ctx)
    expect(again).toMatchObject({ status: "skipped", reason: "duplicate_document" })
    const docs = invoices(db)
    expect(docs).toHaveLength(1)
    const doc = docs[0] as Record<string, unknown>
    expect(doc.external_ref).toBe("stripe:in_1")
    expect(doc.due_at).toBe(doc.issued_at)
    expect(String(doc.grand_total_minor)).toBe("12000")
    const line = db.__all("document_lines").find((l) => l.document_id === doc.id) as Record<
      string,
      unknown
    >
    expect(String(line.description)).toContain("2026-11-01 to 2026-11-30")
    expect(Number(line.tax_rate_bp)).toBe(2000)
    // The Stripe invoice is told which document it became.
    expect(ctx.calls.some((c) => c.tool === "stripe:invoice_document_link")).toBe(true)
  })

  test("a tax difference of 2 minor units on a line parks for review and 1 does not", async () => {
    // Inclusive price: 49.99 with 20% inside is 41.66 before tax, on which Liaison computes 8.33.
    const line = (tax: string) => ({
      description: "Seat",
      quantity: 1,
      unit_amount_excl_minor: "4166",
      tax_rate_bp: 2000,
      tax_minor: tax,
    })
    const off1 = stripeDb()
    const r1 = await onStripeInvoiceFinalized(
      finalized({ total_minor: "5000", lines: [line("834")] }),
      stripeCtx(off1),
    )
    expect(r1.status).toBe("ok")
    // Issued at the charge, to the minor unit: the unit Stripe's tax differs by is a rounding line.
    expect(String((invoices(off1)[0] as Record<string, unknown>).grand_total_minor)).toBe("5000")

    const off2 = stripeDb()
    const ctx2 = stripeCtx(off2)
    const r2 = await onStripeInvoiceFinalized(
      finalized({ total_minor: "5001", lines: [line("835")] }),
      ctx2,
    )
    expect(r2).toMatchObject({ status: "deferred" })
    expect(invoices(off2)).toHaveLength(0)
    const park = parks(off2)[0] as Record<string, unknown>
    expect((park.blocked_on as Record<string, unknown>).kind).toBe("tax_check")
    expect(
      ctx2.emitted.some((e) => e.entity === "deferred" && e.action === "stripe_tax_review"),
    ).toBe(true)
    // No number was taken.
    expect(off2.__all("__sequences")).toHaveLength(0)
  })

  test("paid sets the charge's date, re-renders and reports collection once, and a paid-before-finalized issues first", async () => {
    setSystemTime(new Date(Date.UTC(2026, 10, 15, 12, 0)))
    const db = stripeDb()
    const ctx = stripeCtx(db)
    await onStripeInvoiceFinalized(finalized(), ctx)
    // Charged at 23:30 UTC on the 17th: the 18th in Paris.
    const paidAt = new Date(Date.UTC(2026, 10, 17, 23, 30)).toISOString()
    const paid = await onStripeInvoicePaid(finalized({ status: "paid", paid_at: paidAt }), ctx)
    expect(paid).toMatchObject({ status: "ok", paid_at: "2026-11-18" })
    await onStripeInvoicePaid(finalized({ status: "paid", paid_at: paidAt }), ctx)
    const doc = invoices(db)[0] as Record<string, unknown>
    expect(doc.payment_status).toBe("paid")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log.filter((e) => e.event === "collection_due")).toHaveLength(1)
    expect(log.filter((e) => e.event === "marked_paid")).toHaveLength(1)

    const early = stripeDb()
    const r = await onStripeInvoicePaid(
      finalized({ status: "paid", paid_at: paidAt }),
      stripeCtx(early),
    )
    expect(r.status).toBe("ok")
    const born = invoices(early)
    expect(born).toHaveLength(1)
    expect((born[0] as Record<string, unknown>).payment_status).toBe("paid")
  })

  test("a Stripe payment of an e-invoice where VAT is due on receipt reports its collection to the platform once", async () => {
    setSystemTime(new Date(Date.UTC(2026, 10, 15, 12, 0)))
    const db = stripeDb()
    const reported: Array<Record<string, unknown>> = []
    const contracts = {
      call: async (_c: string, op: string, params: Record<string, unknown>) => {
        reported.push({ op, ...params })
        return { status: "completed", result: { state: "accepted" } }
      },
    }
    const ctx = stripeCtx(db, { contracts } as never)
    await onStripeInvoiceFinalized(finalized(), ctx)
    const doc = invoices(db)[0] as Record<string, unknown>
    await db.update("documents", String(doc.id), {
      tax_treatment: "eu_domestic",
      operation_category: "services",
    })
    await db.insert("einvoice_transmissions", {
      document_id: doc.id,
      action: "send_einvoice",
      idempotency_key: "k-stripe",
      state: "sent",
      provider_app: "fakepa",
      provider_ref: "pa-stripe",
    })
    const paidAt = new Date(Date.UTC(2026, 10, 17, 10, 0)).toISOString()
    await onStripeInvoicePaid(finalized({ status: "paid", paid_at: paidAt }), ctx)
    await onStripeInvoicePaid(finalized({ status: "paid", paid_at: paidAt }), ctx)
    expect(reported).toEqual([
      expect.objectContaining({
        op: "report_collection",
        provider_ref: "pa-stripe",
        date: "2026-11-17",
      }),
    ])
  })

  test("a failed collection report is tried again on the next delivery, and a Stripe refund reports its negative collection", async () => {
    setSystemTime(new Date(Date.UTC(2026, 10, 15, 12, 0)))
    const db = stripeDb()
    const reported: Array<Record<string, unknown>> = []
    let up = false
    const contracts = {
      call: async (_c: string, op: string, params: Record<string, unknown>) => {
        if (!up)
          return { status: "error", error: { code: "provider_unavailable", message: "down" } }
        reported.push({ op, ...params })
        return { status: "completed", result: { state: "accepted" } }
      },
    }
    const ctx = stripeCtx(db, { contracts } as never)
    await onStripeInvoiceFinalized(finalized({ charge_id: "ch_1" }), ctx)
    const doc = invoices(db)[0] as Record<string, unknown>
    await db.update("documents", String(doc.id), {
      tax_treatment: "eu_domestic",
      operation_category: "services",
    })
    await db.insert("einvoice_transmissions", {
      document_id: doc.id,
      action: "send_einvoice",
      idempotency_key: "k-stripe",
      state: "sent",
      provider_app: "fakepa",
      provider_ref: "pa-stripe",
    })
    const paidAt = new Date(Date.UTC(2026, 10, 17, 10, 0)).toISOString()
    await onStripeInvoicePaid(finalized({ status: "paid", paid_at: paidAt }), ctx)
    expect((invoices(db)[0] as Record<string, unknown>).collection_state).toBe("failed")
    up = true
    await onStripeInvoicePaid(finalized({ status: "paid", paid_at: paidAt }), ctx)
    expect(reported).toEqual([
      expect.objectContaining({ op: "report_collection", date: "2026-11-17" }),
    ])
    expect((invoices(db)[0] as Record<string, unknown>).collection_state).toBe("reported")

    await onStripeRefundCreated(
      {
        charge_id: "ch_1",
        invoice_id: "in_1",
        refunds: [{ id: "re_1", amount_minor: "6000", status: "succeeded" }],
      },
      ctx,
    )
    const back = reported.at(-1) as {
      amounts_by_vat_rate: Array<{ rate_bp: number; net_minor: string; vat_minor: string }>
    }
    expect(reported).toHaveLength(2)
    expect(back.amounts_by_vat_rate).toEqual([
      { rate_bp: 2000, net_minor: "-5000", vat_minor: "-1000" },
    ])
  })

  test("a failed payment leaves the document equal and raises attention only when actionable", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    await onStripeInvoiceFinalized(finalized(), ctx)
    const before = JSON.stringify(invoices(db))
    const retrying = await onStripeInvoicePaymentFailed(
      finalized({ next_payment_attempt: "2026-11-20", failure_code: "card_declined" }),
      ctx,
    )
    expect(retrying.status).toBe("in_retries")
    expect(ctx.emitted.filter((e) => e.action === "payment_failed")).toHaveLength(0)
    await onStripeInvoicePaymentFailed(
      finalized({ next_payment_attempt: "2026-11-20", failure_code: "expired_card" }),
      ctx,
    )
    await onStripeInvoicePaymentFailed(
      finalized({ next_payment_attempt: null, failure_code: "card_declined" }),
      ctx,
    )
    expect(ctx.emitted.filter((e) => e.action === "payment_failed")).toHaveLength(2)
    expect(JSON.stringify(invoices(db))).toBe(before)
  })

  test("void, uncollectible, zero and negative totals change no document", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    await onStripeInvoiceFinalized(finalized(), ctx)
    const before = JSON.stringify(invoices(db))
    await onStripeInvoiceClosed(finalized(), ctx, "voided")
    await onStripeInvoiceClosed(finalized(), ctx, "uncollectible")
    expect(JSON.stringify(invoices(db))).toBe(before)
    expect(
      ctx.emitted.filter(
        (e) => e.entity === "stripe_invoice" && ["voided", "uncollectible"].includes(e.action),
      ),
    ).toHaveLength(2)

    const zero = await onStripeInvoiceFinalized(
      finalized({ stripe_invoice_id: "in_0", total_minor: "0" }),
      ctx,
    )
    expect(zero).toMatchObject({ status: "skipped", reason: "zero_total" })
    const neg = await onStripeInvoiceFinalized(
      finalized({ stripe_invoice_id: "in_neg", total_minor: "-500" }),
      ctx,
    )
    expect(neg).toMatchObject({ status: "deferred" })
    expect(ctx.emitted.some((e) => e.action === "needs_person")).toBe(true)
    expect(invoices(db)).toHaveLength(1)
  })

  test("mode B writes only the mirror and shows Issued by Stripe", async () => {
    const db = stripeDb("stripe")
    const ctx = stripeCtx(db)
    const r = await onStripeInvoiceFinalized(finalized(), ctx)
    expect(r).toMatchObject({ status: "skipped", reason: "issued_by_stripe" })
    await onStripeInvoicePaid(finalized({ status: "paid", paid_at: "2026-11-16" }), ctx)
    expect(db.__all("documents")).toHaveLength(0)
    expect(parks(db)).toHaveLength(0)
  })

  test("a payment with no invoice raises one unmatched row, never silently, and a replay adds none", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    const charge = {
      charge_id: "ch_9",
      amount_minor: "4500",
      currency: "eur",
      created: new Date(Date.UTC(2026, 10, 12, 10)).toISOString(),
    }
    const first = await onStripePaymentUnmatched({ data: charge }, ctx)
    expect(first).toMatchObject({ status: "deferred", created: true })
    await onStripePaymentUnmatched({ data: charge }, ctx)
    expect(parks(db)).toHaveLength(1)
    expect(
      ctx.emitted.filter((e) => e.entity === "stripe_payment" && e.action === "unmatched"),
    ).toHaveLength(1)
    // Before the connection it is Stripe's history, not a queue row.
    const old = await onStripePaymentUnmatched(
      { data: { ...charge, charge_id: "ch_old", created: "2026-10-01" } },
      ctx,
    )
    expect(old).toMatchObject({ status: "skipped", reason: "before_connection" })
  })

  test("the safety job tightens payment status only and issues nothing itself", async () => {
    const db = stripeDb()
    let listed = {
      invoices: [finalized({ status: "paid", paid_at: "2026-11-16" })],
      refunds: [] as unknown[],
    }
    const ctx = stripeCtx(db, {
      executeTool: (async (tool: string) =>
        tool === "stripe:reconcile_candidates"
          ? { status: "completed", result: listed }
          : { status: "error", error: { code: "tool_not_found", message: "absent" } }) as never,
    })
    await onStripeInvoiceFinalized(finalized(), ctx)
    const r = await reconcileStripePayments(ctx)
    expect(r).toMatchObject({ issued: 0, marked_paid: 1 })
    expect((invoices(db)[0] as Record<string, unknown>).payment_status).toBe("paid")
    // A Stripe invoice that is not Liaison's to issue (mode B) stays without a document: the job
    // hands it to the handler, which decides; the job never issues around it.
    const modeB = stripeDb("stripe")
    listed = { invoices: [finalized({ stripe_invoice_id: "in_b" })], refunds: [] }
    const rb = await reconcileStripePayments(stripeCtx(modeB, { executeTool: ctx.executeTool }))
    expect(rb.issued).toBe(0)
    expect(modeB.__all("documents")).toHaveLength(0)
  })

  test("an orphan charge invoiced by hand, then its invoice's finalized event, leaves one document", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    // The charge belongs to invoice in_1: a person invoices it from the queue first.
    await onStripePaymentUnmatched(
      { charge_id: "ch_1", amount_minor: "12000", currency: "eur", created: "2026-11-15" },
      ctx,
    )
    const { invoiceFromStripePayment } = await import("./stripe-payment-unmatched")
    await db.update("deferred_events", String(parks(db)[0]?.id), {
      event_payload_json: {
        charge_id: "ch_1",
        invoice_id: "in_1",
        amount_minor: "12000",
        currency: "eur",
        created: "2026-11-15",
        customer: finalized().customer,
      },
    })
    const made = await invoiceFromStripePayment(
      { ...ctx, approval: { approvalRequestId: "a", approvalDeciderId: "u", toolName: "t" } },
      { chargeId: "ch_1", vatRateBp: 2000 },
    )
    expect(made.status).toBe("completed")
    const r = await onStripeInvoiceFinalized(finalized(), ctx)
    expect(r).toMatchObject({ status: "skipped", reason: "duplicate_document" })
    expect(invoices(db)).toHaveLength(1)
  })

  test("a finalized event delivered after midnight issues with that day's date and number series, and the sequence's dates never decrease", async () => {
    const db = stripeDb()
    const ctx = stripeCtx(db)
    // Finalized at 23:50 Paris on 31 December, delivered at 00:20 Paris on 1 January.
    const finalizedAt = new Date(Date.UTC(2026, 11, 31, 22, 50)).toISOString()
    setSystemTime(new Date(Date.UTC(2026, 11, 31, 22, 55)))
    await onStripeInvoiceFinalized(finalized({ stripe_invoice_id: "in_a" }), ctx)
    setSystemTime(new Date(Date.UTC(2026, 11, 31, 23, 20)))
    await onStripeInvoiceFinalized(
      finalized({ stripe_invoice_id: "in_b", finalized_at: finalizedAt }),
      ctx,
    )
    const docs = invoices(db).map((d) => ({
      n: String(d.number),
      at: String(d.issued_at),
      y: Number(d.year_of_issue),
    }))
    expect(docs.find((d) => d.n.startsWith("INV-2026"))?.at).toBe("2026-12-31")
    const late = docs.find((d) => d.n.startsWith("INV-2027"))
    expect(late).toMatchObject({ at: "2027-01-01", y: 2027 })
    const dates = docs.map((d) => d.at)
    expect([...dates].sort()).toEqual(dates)
  })

  test("invoices finalized while undecided are listed at the decision and issue only on a person's click", async () => {
    const db = stripeDb("undecided")
    const ctx = stripeCtx(db, {
      executeTool: (async () => ({
        status: "completed",
        result: { invoices: [], refunds: [] },
      })) as never,
    })
    const r = await onStripeInvoiceFinalized(finalized(), ctx)
    expect(r).toMatchObject({ status: "deferred" })
    expect(ctx.emitted.filter((e) => e.action === "issuer_undecided")).toHaveLength(1)
    // Nothing lists before the decision; a person then picks Liaison.
    expect((await reconcileStripePayments(ctx)).listed_undecided).toBe(0)
    await db.update("stripe_streams", "st-1", {
      issuer: "liaison",
      decided_at: new Date().toISOString(),
    })
    expect((await reconcileStripePayments(ctx)).listed_undecided).toBe(1)
    expect((await reconcileStripePayments(ctx)).listed_undecided).toBe(0)
    expect(invoices(db)).toHaveLength(0)
    const { invoiceFromStripePayment } = await import("./stripe-payment-unmatched")
    const done = await invoiceFromStripePayment(
      {
        ...ctx,
        approval: {
          approvalRequestId: "a",
          approvalDeciderId: "u",
          toolName: "invoicing:invoice_from_stripe_payment",
        },
      },
      { stripeInvoiceId: "in_1" },
    )
    expect(done.status).toBe("completed")
    expect(invoices(db)).toHaveLength(1)
  })
})
