// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Stripe refund becomes a Liaison credit note in mode A: once per refund id, only once Stripe
// confirms it, split over the invoice's VAT rates. Mode B makes none.
import { describe, expect, test } from "bun:test"
import { reconcileStripePayments } from "./reconcile-stripe-payments"
import { onStripeInvoiceFinalized, stripeTaxMismatches } from "./stripe-invoice-finalized"
import { creditNotes, finalized, parks, stripeCtx, stripeDb } from "./stripe-money.testkit"
import { onStripeRefundCreated } from "./stripe-refund-created"

type Row = Record<string, unknown>

async function issued(
  issuer: "liaison" | "stripe" = "liaison",
  payload = finalized({ charge_id: "ch_1" }),
) {
  const db = stripeDb(issuer)
  const ctx = stripeCtx(db)
  await onStripeInvoiceFinalized(payload, ctx)
  return { db, ctx }
}

const refund = (id: string, amount: string, status: string) => ({
  id,
  amount_minor: amount,
  status,
})
const net = (db: ReturnType<typeof stripeDb>, cn: Row) =>
  db.__all("document_lines").filter((l) => l.document_id === cn.id)

describe("Stripe refunds and credit notes", () => {
  test("a credit note issues only after Stripe confirms, once, whichever arrives first", async () => {
    const { db, ctx } = await issued()
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_1", "6000", "pending")] },
      ctx,
    )
    expect(creditNotes(db)).toHaveLength(0)
    // The tool's result and charge.refunded both report it succeeded, then a replay.
    for (let i = 0; i < 3; i++) {
      await onStripeRefundCreated(
        { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_1", "6000", "succeeded")] },
        ctx,
      )
    }
    const cns = creditNotes(db)
    expect(cns).toHaveLength(1)
    expect((cns[0] as Row).external_ref).toBe("stripe:re_1")
    expect(String((cns[0] as Row).number)).toMatch(/^CN-/)
  })

  test("€89.40 at 20% splits into €74.50 and €14.90, a two-rate refund's parts sum exactly, and a refused e-invoice gate parks it with its arguments", async () => {
    const { db, ctx } = await issued()
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_2", "8940", "succeeded")] },
      ctx,
    )
    const cn = creditNotes(db)[0] as Row
    const lines = net(db, cn)
    expect(lines.map((l) => Number(l.unit_price_minor))).toEqual([-7450])
    expect(String(cn.grand_total_minor)).toBe("-8940")
    expect(String(cn.tax_total_minor)).toBe("-1490")

    // Two rates, 20% and 5.5%: the gross is shared by each rate's share (largest remainder); a
    // minor unit the per-rate split leaves short goes on one 0-tax "Rounding adjustment" line, so
    // the credit note's total is exactly the refund.
    const two = finalized({
      stripe_invoice_id: "in_2",
      total_minor: "22550",
      lines: [
        {
          description: "Plan",
          quantity: 1,
          unit_amount_excl_minor: "10000",
          tax_rate_bp: 2000,
          tax_minor: "2000",
        },
        {
          description: "Books",
          quantity: 1,
          unit_amount_excl_minor: "10000",
          tax_rate_bp: 550,
          tax_minor: "550",
        },
      ],
    })
    await onStripeInvoiceFinalized(two, ctx)
    await onStripeRefundCreated(
      { charge_id: "ch_2", invoice_id: "in_2", refunds: [refund("re_3", "10001", "succeeded")] },
      ctx,
    )
    const cn2 = creditNotes(db).find((d) => d.external_ref === "stripe:re_3") as Row
    expect(String(cn2.grand_total_minor)).toBe("-10001")

    // A refusal parks the credit note with its arguments; nothing is lost.
    const parked = stripeDb()
    const pctx = stripeCtx(parked)
    await onStripeInvoiceFinalized(finalized({ charge_id: "ch_1" }), pctx)
    await parked.update("documents", String((parked.__all("documents")[0] as Row).id), {
      counterparty_address: null,
    })
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_4", "1000", "succeeded")] },
      pctx,
    )
    expect(creditNotes(parked)).toHaveLength(0)
    const row = parks(parked).find((r) => r.event_id === "stripe:re_4") as Row
    expect(row.event_payload_json).toMatchObject({
      kind: "stripe_credit_note",
      refund_id: "re_4",
      amount_minor: "1000",
    })
  })

  test("a refund of a services invoice credits services, never goods", async () => {
    const { db, ctx } = await issued()
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_9", "6000", "succeeded")] },
      ctx,
    )
    const kinds = net(db, creditNotes(db)[0] as Row).map((l) => l.line_kind)
    expect(kinds.length).toBeGreaterThan(0)
    expect(new Set(kinds)).toEqual(new Set(["service"]))
  })

  test("each decided Stripe invoice and refund is recorded on the Stripe side, and parked ones are left to the retry sweep", async () => {
    const { db, ctx } = await issued()
    const links = () =>
      ctx.calls.filter((c) => c.tool.endsWith("_document_link")).map((c) => [c.tool, c.params])
    // Issued, a free trial's zero invoice, and a refund's credit note.
    const issuedDoc = db.__all("documents")[0] as Row
    // The link carries the document's number, which the Stripe side shows on the invoice's row.
    expect(links()).toContainEqual([
      "stripe:invoice_document_link",
      {
        stripeInvoiceId: "in_1",
        documentId: String(issuedDoc.id),
        documentNumber: String(issuedDoc.number),
      },
    ])
    await onStripeInvoiceFinalized(
      finalized({ stripe_invoice_id: "in_0", total_minor: "0", tax_minor: "0" }),
      ctx,
    )
    expect(links()).toContainEqual([
      "stripe:invoice_document_link",
      { stripeInvoiceId: "in_0", issuedBy: "stripe" },
    ])
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_7", "6000", "succeeded")] },
      ctx,
    )
    const cn = creditNotes(db)[0] as Row
    expect(links()).toContainEqual([
      "stripe:refund_document_link",
      { stripeRefundId: "re_7", documentId: String(cn.id) },
    ])
    // Nothing left to credit: decided too.
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_8", "99999", "succeeded")] },
      ctx,
    )
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_10", "100", "succeeded")] },
      ctx,
    )
    expect(links()).toContainEqual([
      "stripe:refund_document_link",
      { stripeRefundId: "re_10", skipped: "nothing_left" },
    ])

    // A parked invoice is named to the safety job's read, which leaves it to the retry sweep.
    await onStripeInvoiceFinalized(
      finalized({
        stripe_invoice_id: "in_P",
        customer: { name: "No Mail", email: null, country: "FR", address: null } as never,
      }),
      ctx,
    )
    await reconcileStripePayments(ctx)
    const read = ctx.calls.find((c) => c.tool === "stripe:reconcile_candidates")
    expect((read!.params as { waiting: string[] }).waiting).toContain("in_P")
  })

  test("in mode B a refund is recorded as Stripe's, so the safety job never asks again", async () => {
    const { ctx } = await issued("stripe")
    await onStripeRefundCreated(
      {
        charge_id: "ch_1",
        invoice_id: "in_1",
        refund_id: "re_B",
        amount_minor: "100",
        status: "succeeded",
      },
      ctx,
    )
    expect(ctx.calls).toContainEqual({
      tool: "stripe:refund_document_link",
      params: { stripeRefundId: "re_B", skipped: "issued_by_stripe" },
    })
  })

  test("a refund of a charge linked by hand to an invoice credits that invoice instead of waiting forever", async () => {
    const { db, ctx } = await issued("liaison", finalized({ stripe_invoice_id: "in_x" }))
    const doc = db.__all("documents")[0] as Row
    await db.update("documents", String(doc.id), {
      external_refs: { ...(doc.external_refs as Row), stripe_charge_id: "ch_hand" },
    })
    const r = await onStripeRefundCreated(
      { charge_id: "ch_hand", refunds: [refund("re_h", "1200", "succeeded")] },
      ctx,
    )
    expect(r.refunds[0]).toMatchObject({ outcome: "issued" })
  })

  test("a refund of a charge whose invoice Stripe issued is recorded as Stripe's, never parked", async () => {
    const db = stripeDb("liaison")
    const ctx = stripeCtx(db)
    const switchedAt = new Date(Date.UTC(2026, 10, 10, 9, 0)).toISOString()
    await db.update("stripe_streams", "st-1", {
      previous_issuer: "stripe",
      switched_at: switchedAt,
    })
    const before = new Date(Date.UTC(2026, 10, 5, 9, 0)).toISOString()
    const preConnection = new Date(Date.UTC(2026, 9, 20, 9, 0)).toISOString()
    const after = new Date(Date.UTC(2026, 10, 12, 9, 0)).toISOString()
    // Stripe issued at the charge's date (before the switch), or Stripe was not yet connected.
    const a = await onStripeRefundCreated(
      {
        charge_id: "ch_s1",
        invoice_id: "in_s1",
        charged_at: before,
        refunds: [refund("re_s1", "500", "succeeded")],
      },
      ctx,
    )
    const b = await onStripeRefundCreated(
      {
        charge_id: "ch_s2",
        charged_at: preConnection,
        refunds: [refund("re_s2", "500", "succeeded")],
      },
      ctx,
    )
    expect([a.refunds[0]?.outcome, b.refunds[0]?.outcome]).toEqual([
      "issued_by_stripe",
      "issued_by_stripe",
    ])
    expect(ctx.calls).toContainEqual({
      tool: "stripe:refund_document_link",
      params: { stripeRefundId: "re_s1", skipped: "issued_by_stripe" },
    })
    expect(ctx.calls).toContainEqual({
      tool: "stripe:refund_document_link",
      params: { stripeRefundId: "re_s2", skipped: "issued_by_stripe" },
    })
    expect(parks(db).filter((r) => r.status !== "resolved")).toHaveLength(0)
    // Liaison issued at the charge's date: the refund waits for that invoice.
    const c = await onStripeRefundCreated(
      {
        charge_id: "ch_s3",
        invoice_id: "in_s3",
        charged_at: after,
        refunds: [refund("re_s3", "500", "succeeded")],
      },
      ctx,
    )
    expect(c.refunds[0]?.outcome).toBe("no_invoice")
    expect(parks(db).find((r) => r.event_id === "stripe:re_s3")?.event_payload_json).toMatchObject({
      charged_at: after,
    })
  })

  test("a refund waiting a day for its invoice raises one Home item, closed once it gets its credit note or is skipped", async () => {
    const db = stripeDb("liaison")
    const ctx = stripeCtx(db)
    const waits = () =>
      ctx.emitted.filter((e) => e.entity === "stripe_refund" && e.action === "waiting")
    const age = async (eventId: string, hours: number) => {
      const row = parks(db).find((r) => r.event_id === eventId) as Row
      await db.update("deferred_events", String(row.id), {
        created_at: new Date(Date.now() - hours * 3_600_000),
      })
    }
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_w1", "1000", "succeeded")] },
      ctx,
    )
    await onStripeRefundCreated(
      { charge_id: "ch_9", invoice_id: "in_9", refunds: [refund("re_w2", "99999", "succeeded")] },
      ctx,
    )
    await age("stripe:re_w1", 2)
    await reconcileStripePayments(ctx)
    expect(waits()).toHaveLength(0)

    await age("stripe:re_w1", 25)
    await age("stripe:re_w2", 25)
    await reconcileStripePayments(ctx)
    await reconcileStripePayments(ctx)
    expect(waits().map((e) => [(e.data as Row).refund_id, (e.data as Row).resolved])).toEqual([
      ["re_w1", false],
      ["re_w2", false],
    ])
    expect(waits()[0]).toMatchObject({ entityId: "re_w1", data: { charge_id: "ch_1" } })

    // The invoice issues; the refund's re-drive makes its credit note and closes the item.
    await onStripeInvoiceFinalized(finalized({ charge_id: "ch_1" }), ctx)
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_w1", "1000", "succeeded")] },
      ctx,
    )
    expect(creditNotes(db)).toHaveLength(1)
    // The other is skipped: nothing is left to credit on its invoice.
    await onStripeInvoiceFinalized(finalized({ stripe_invoice_id: "in_9", charge_id: "ch_9" }), ctx)
    await onStripeRefundCreated(
      { charge_id: "ch_9", invoice_id: "in_9", refunds: [refund("re_w0", "12000", "succeeded")] },
      ctx,
    )
    await onStripeRefundCreated(
      { charge_id: "ch_9", invoice_id: "in_9", refunds: [refund("re_w2", "99999", "succeeded")] },
      ctx,
    )
    const closed = waits().filter((e) => (e.data as Row).resolved === true)
    expect(closed.map((e) => e.entityId)).toEqual(["re_w1", "re_w2"])
    expect(
      parks(db).filter(
        (r) => String(r.event_id).startsWith("stripe:re_w") && r.status !== "resolved",
      ),
    ).toHaveLength(0)
    await reconcileStripePayments(ctx)
    expect(waits()).toHaveLength(4)
  })

  test("a refund made in Stripe yields the same credit note with no card", async () => {
    const { db, ctx } = await issued()
    let approvals = 0
    ctx.requestApproval = (async () => {
      approvals += 1
      return { approval_id: "x" }
    }) as never
    // Only `charge.refunded` arrives, naming the refund; no tool result, no card.
    await onStripeRefundCreated(
      {
        data: {
          charge_id: "ch_1",
          invoice_id: "in_1",
          refund_id: "re_5",
          amount_minor: "3000",
          status: "succeeded",
        },
      },
      ctx,
    )
    expect(creditNotes(db)).toHaveLength(1)
    expect(approvals).toBe(0)
  })

  test("mode B refunds create no credit note", async () => {
    const { db, ctx } = await issued("stripe")
    const r = await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_6", "3000", "succeeded")] },
      ctx,
    )
    expect(r).toMatchObject({ status: "skipped", reason: "mode_b" })
    expect(db.__all("documents")).toHaveLength(0)
  })

  test("a pending refund makes no credit note until it succeeds, and a failed one makes none", async () => {
    const { db, ctx } = await issued()
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_7", "2000", "pending")] },
      ctx,
    )
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_7", "2000", "failed")] },
      ctx,
    )
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_7", "2000", "failed")] },
      ctx,
    )
    expect(creditNotes(db)).toHaveLength(0)
    expect(
      ctx.emitted.filter((e) => e.entity === "stripe_refund" && e.action === "failed"),
    ).toHaveLength(1)

    // Succeeded, credited, then failed: one attention item naming the credit note.
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_8", "2000", "succeeded")] },
      ctx,
    )
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_8", "2000", "failed")] },
      ctx,
    )
    const cn = creditNotes(db)[0] as Row
    const alert = ctx.emitted.find(
      (e) => e.action === "failed" && (e.data as Row).refund_id === "re_8",
    )
    expect((alert!.data as Row).credit_note).toBe(String(cn.number))
  })

  test("two partial refunds of one charge make two credit notes summing to the refunded total", async () => {
    const { db, ctx } = await issued()
    // charge.refunded fires twice; each delivery lists the charge's refunds by id.
    await onStripeRefundCreated(
      { charge_id: "ch_1", invoice_id: "in_1", refunds: [refund("re_a", "3000", "succeeded")] },
      ctx,
    )
    await onStripeRefundCreated(
      {
        charge_id: "ch_1",
        invoice_id: "in_1",
        amount_minor: "7000",
        refunds: [refund("re_a", "3000", "succeeded"), refund("re_b", "4000", "succeeded")],
      },
      ctx,
    )
    const cns = creditNotes(db)
    expect(cns).toHaveLength(2)
    expect(cns.reduce((s, c) => s + Number(c.grand_total_minor), 0)).toBe(-7000)
  })

  test("a refund made while invoicing was off gets its credit note within one reconcile tick", async () => {
    const { db, ctx } = await issued()
    ctx.executeTool = (async (tool: string) =>
      tool === "stripe:reconcile_candidates"
        ? {
            status: "completed",
            result: {
              invoices: [],
              refunds: [
                {
                  refund_id: "re_off",
                  charge_id: "ch_1",
                  invoice_id: "in_1",
                  amount_minor: "2500",
                  status: "succeeded",
                },
              ],
            },
          }
        : { status: "error", error: { code: "tool_not_found", message: "absent" } }) as never
    const r = await reconcileStripePayments(ctx)
    expect(r.credit_notes).toBe(1)
    await reconcileStripePayments(ctx)
    expect(creditNotes(db)).toHaveLength(1)
    expect((creditNotes(db)[0] as Row).external_ref).toBe("stripe:re_off")
  })

  test("the tax check reads each line and judges only lines Stripe taxed", () => {
    expect(stripeTaxMismatches([{ quantity: 1, unit_amount_excl_minor: "100" }])).toEqual([])
  })
})
