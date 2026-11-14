// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The money events invoicing reads, from verified Stripe events through the handler
// and from the refund tool, against the Stripe mock (objects re-read by id, refunds
// listed by charge) and the in-memory tables; and the two reads invoicing calls.
import { beforeEach, describe, expect, it } from "bun:test"
import { stripeDocumentRef as invoicingDocumentRef } from "../../invoicing/src/streams"
import { handleStripeEvent, type IngestCtx } from "./dispatch"
import { MemDb } from "./mem-db.testkit"
import { mockFetch, moneyCtx, seedCharge, stripeMockReset, stripeMockSeed } from "./money.testkit"
import { stripeDocumentRef } from "./money-events"
import { reconcileCandidates, refundsForCharge } from "./tools/money-reads"
import { refundsCreate } from "./tools/refunds"
import { invoiceDocumentLink, refundDocumentLink } from "./tools/routes"

type Obj = Record<string, any>
type Emitted = { entity: string; action: string; entityId?: string; data?: any }

const PAN = "4917484589897107"

/** The tables with inserts and conditional updates, as the mirror writes them. */
class Tables extends MemDb {
  async insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }> {
    const key =
      entity === "webhook_deliveries"
        ? "event_id"
        : entity === "sync_state"
          ? "resource"
          : "stripe_id"
    if (data[key] !== undefined && this.rows(entity).some((r) => r[key] === data[key]))
      throw new Error("duplicate key value")
    this.seed(entity, [data])
    return { id: String(this.rows(entity).at(-1)?.id) }
  }
  async updateMany(
    entity: string,
    opts: { where: Record<string, unknown>; data: Record<string, unknown> },
  ) {
    const rows = (await this.findMany(entity, { where: opts.where })) as Obj[]
    for (const r of rows) await this.update(entity, r.id, opts.data)
    return { count: rows.length }
  }
}

/** Stripe: the mock, plus the invoice payments and tax rates it does not serve. */
const invoicePayments = new Map<string, string>()
const taxRates = new Map<string, number>()
const fetchStripe: IngestCtx["fetch"] = async (url, opts) => {
  const u = new URL(url)
  if (u.pathname === "/v1/invoice_payments") {
    const intent = u.searchParams.get("payment[payment_intent]") ?? ""
    const inv = invoicePayments.get(intent)
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({
        object: "list",
        data: inv ? [{ id: `inpay_${intent}`, invoice: inv }] : [],
        has_more: false,
      }),
    }
  }
  const rate = /^\/v1\/tax_rates\/(.+)$/.exec(u.pathname)?.[1]
  if (rate) {
    const pct = taxRates.get(rate)
    return pct === undefined
      ? {
          status: 404,
          headers: {},
          body: JSON.stringify({ error: { message: "No such tax rate" } }),
        }
      : {
          status: 200,
          headers: {},
          body: JSON.stringify({ id: rate, object: "tax_rate", percentage: pct }),
        }
  }
  return mockFetch(url, opts)
}

let db: Tables
let emitted: Emitted[]

function ingest(): IngestCtx {
  return {
    db: db as unknown as IngestCtx["db"],
    fetch: fetchStripe,
    emit: async (e) => {
      emitted.push(e as Emitted)
    },
  }
}

let seq = 0
const deliver = (type: string, objectId: string, id = `evt_${++seq}`) =>
  handleStripeEvent(
    { id, type, created: 1767229300, livemode: false, data: { object: { id: objectId } } },
    ingest(),
  )
const of = (action: string) => emitted.filter((e) => `${e.entity}:${e.action}` === action)

beforeEach(() => {
  stripeMockReset()
  invoicePayments.clear()
  taxRates.clear()
  db = new Tables()
  db.seed("install_metadata", [
    { state: "connected", livemode: false, webhook_confirmed_at: "2026-11-01T00:00:00Z" },
  ])
  emitted = []
})

const refund = (id: string, charge: string, amount: number, status: string) =>
  stripeMockSeed("refunds", { id, charge, amount, status, currency: "eur", created: 1767232800 })

describe("refunds reach invoicing", () => {
  it("a refunded charge emits refund:created listing each of its refunds by id, with its invoice, and mirrors them", async () => {
    seedCharge("ch_R1", 12000, 5000, { payment_intent: "pi_R1", status: "succeeded" })
    invoicePayments.set("pi_R1", "in_R1")
    refund("re_A", "ch_R1", 3000, "succeeded")
    refund("re_B", "ch_R1", 2000, "pending")
    expect((await deliver("charge.refunded", "ch_R1")).status).toBe(200)
    const [e] = of("refund:created")
    expect(of("refund:created")).toHaveLength(1)
    expect(e?.data).toMatchObject({
      charge_id: "ch_R1",
      invoice_id: "in_R1",
      document_ref: "stripe:in_R1",
    })
    // Mutation caught: one refund at the charge's cumulative 5000 instead of each by id.
    expect([...e!.data.refunds].sort((a: Obj, b: Obj) => a.id.localeCompare(b.id))).toEqual([
      { id: "re_A", amount_minor: "3000", status: "succeeded", currency: "eur" },
      { id: "re_B", amount_minor: "2000", status: "pending", currency: "eur" },
    ])
    expect(
      db
        .rows("stripe_refunds")
        .map((r) => [r.stripe_id, r.status])
        .sort(),
    ).toEqual([
      ["re_A", "succeeded"],
      ["re_B", "pending"],
    ])
    expect(db.rows("stripe_payments")[0]?.invoice_id).toBe("in_R1")
  })

  it("a refund still reaches invoicing when another write of its charge made this mirror write stale", async () => {
    seedCharge("ch_R9", 12000, 3000, { status: "succeeded" })
    refund("re_R9", "ch_R9", 3000, "succeeded")
    db.seed("stripe_payments", [
      { stripe_id: "ch_R9", status: "succeeded", stripe_updated: "2099-01-01T00:00:00.000Z" },
    ])
    expect((await deliver("charge.refunded", "ch_R9")).status).toBe(200)
    expect(of("refund:created").map((e) => e.data.charge_id)).toEqual(["ch_R9"])
  })

  it("a refund that settles emits refund:settled, a failed or canceled one refund:failed, and a pending one nothing", async () => {
    seedCharge("ch_R2", 12000, 3000, { status: "succeeded" })
    refund("re_S", "ch_R2", 1000, "succeeded")
    refund("re_F", "ch_R2", 1000, "failed")
    refund("re_C", "ch_R2", 500, "canceled")
    refund("re_P", "ch_R2", 500, "pending")
    for (const id of ["re_S", "re_F", "re_C", "re_P"]) await deliver("charge.refund.updated", id)
    expect(
      emitted
        .filter((e) => e.entity === "refund")
        .map((e) => [e.action, e.data.refund_id, e.data.status]),
    ).toEqual([
      ["settled", "re_S", "succeeded"],
      ["failed", "re_F", "failed"],
      ["failed", "re_C", "canceled"],
    ])
    expect(of("refund:settled")[0]?.data).toMatchObject({
      charge_id: "ch_R2",
      invoice_id: null,
      document_ref: "stripe:ch_R2",
      amount_minor: "1000",
      refunds: [{ id: "re_S", amount_minor: "1000", status: "succeeded", currency: "eur" }],
    })
  })

  it("the refund tool announces refund:created with every refund of the charge", async () => {
    const tdb = new Tables()
    tdb.seed("install_metadata", [{ state: "connected", livemode: false }])
    tdb.seed("stripe_payments", [
      {
        stripe_id: "ch_T1",
        invoice_id: "in_T1",
        amount_minor: 10000,
        refunded_minor: 0,
        disputed: false,
        currency: "eur",
      },
    ])
    seedCharge("ch_T1", 10000)
    const ctx = moneyCtx(tdb, "approval-1", { cardIssuer: "stripe" })
    const out: Emitted[] = []
    const res = (await refundsCreate(
      { chargeId: "ch_T1", amountMinor: 2500 },
      { ...ctx, emit: async (e) => void out.push(e as Emitted) },
    )) as Obj
    expect(res.refundId).toBeString()
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ entity: "refund", action: "created", entityId: res.refundId })
    expect(out[0]?.data).toMatchObject({
      refund_id: res.refundId,
      charge_id: "ch_T1",
      invoice_id: "in_T1",
      document_ref: "stripe:in_T1",
      status: "succeeded",
      refunds: [{ id: res.refundId, amount_minor: "2500", status: "succeeded", currency: "eur" }],
    })
  })
})

describe("a refund names the date of its charge", () => {
  const CHARGED = 1764583200
  const chargedIso = new Date(CHARGED * 1000).toISOString()

  it("from a refunded charge, a refund's update and the refund tool, so invoicing can tell who issued the charge's invoice", async () => {
    seedCharge("ch_D1", 12000, 3000, { status: "succeeded", created: CHARGED })
    refund("re_D1", "ch_D1", 3000, "succeeded")
    await deliver("charge.refunded", "ch_D1")
    expect(of("refund:created")[0]?.data.charged_at).toBe(chargedIso)

    seedCharge("ch_D2", 12000, 1000, { status: "succeeded", created: CHARGED })
    refund("re_D2", "ch_D2", 1000, "succeeded")
    await deliver("charge.refund.updated", "re_D2")
    expect(of("refund:settled")[0]?.data.charged_at).toBe(chargedIso)

    const tdb = new Tables()
    tdb.seed("install_metadata", [{ state: "connected", livemode: false }])
    tdb.seed("stripe_payments", [
      {
        stripe_id: "ch_D3",
        invoice_id: "in_D3",
        amount_minor: 10000,
        refunded_minor: 0,
        disputed: false,
        currency: "eur",
        created_at_stripe: chargedIso,
      },
    ])
    seedCharge("ch_D3", 10000, 0, { created: CHARGED })
    const out: Emitted[] = []
    const ctx = moneyCtx(tdb, "approval-d3", { cardIssuer: "liaison" })
    await refundsCreate(
      { chargeId: "ch_D3", amountMinor: 2500 },
      { ...ctx, emit: async (e) => void out.push(e as Emitted) },
    )
    expect(out[0]?.data.charged_at).toBe(chargedIso)
  })

  it("a mirror row's missing date is no date, never the epoch", async () => {
    db.seed("stripe_payments", [
      { stripe_id: "ch_D4", invoice_id: "in_D4", created_at_stripe: new Date(0).toISOString() },
    ])
    seedCharge("ch_D4", 12000, 1000, { status: "succeeded" })
    refund("re_D4", "ch_D4", 1000, "succeeded")
    await deliver("charge.refund.updated", "re_D4")
    expect(of("refund:settled")[0]?.data.charged_at).toBeNull()
  })
})

describe("payments no invoice explains", () => {
  it("a succeeded charge no invoice explains emits payment:unmatched once, masked, and one an invoice pays emits nothing", async () => {
    stripeMockSeed("customers", {
      id: "cus_U1",
      name: "Lumen Studio",
      email: "billing@lumen.example",
      description: null,
    })
    seedCharge("ch_U1", 4500, 0, {
      customer: "cus_U1",
      payment_intent: "pi_U1",
      status: "succeeded",
      description: `card ${PAN}`,
    })
    seedCharge("ch_P1", 4500, 0, {
      customer: "cus_U1",
      payment_intent: "pi_P1",
      status: "succeeded",
    })
    invoicePayments.set("pi_P1", "in_P1")
    await deliver("charge.succeeded", "ch_U1", "evt_U1")
    await deliver("charge.succeeded", "ch_U1", "evt_U1")
    await deliver("charge.succeeded", "ch_P1")
    const unmatched = of("payment:unmatched")
    expect(unmatched).toHaveLength(1)
    expect(unmatched[0]?.data).toMatchObject({
      charge_id: "ch_U1",
      invoice_id: null,
      document_ref: "stripe:ch_U1",
      customer_id: "cus_U1",
      amount_minor: "4500",
      currency: "eur",
      created: "2026-01-01T01:01:40.000Z",
      customer: { name: "Lumen Studio", email: "billing@lumen.example", country: "FR" },
    })
    expect(unmatched[0]?.data.description).not.toContain(PAN)
    expect(unmatched[0]?.data.description).toContain("7107")
  })
})

describe("finalized invoices carry what invoicing issues from", () => {
  it("each line carries its net before tax, its rate and the tax Stripe charged, and the buyer comes from the mirror, masked", async () => {
    taxRates.set("txr_20", 20)
    db.seed("stripe_customers", [
      {
        stripe_id: "cus_FIXTURE0001",
        name: "Client Example SAS",
        email: "billing@client.example",
        contact_id: "7d4e3c1a-0000-4000-8000-000000000001",
        address: {
          country: "FR",
          line1: `1 rue ${PAN}`,
          line2: null,
          postal_code: "69001",
          city: "Lyon",
        },
        tax_ids: [{ type: "eu_vat", value: "FR40902000009" }],
        stripe_updated: "2026-01-01T00:00:00.000Z",
      },
    ])
    stripeMockSeed("invoices", {
      id: "in_L1",
      status: "open",
      lines: {
        object: "list",
        has_more: false,
        data: [
          {
            id: "il_1",
            description: "Pro plan",
            quantity: 3,
            amount: 14700,
            period: { start: 1764547200, end: 1767225600 },
            discount_amounts: [{ amount: 300 }],
            taxes: [
              {
                amount: 2880,
                taxable_amount: 14400,
                tax_behavior: "exclusive",
                tax_rate_details: { tax_rate: "txr_20" },
              },
            ],
          },
          { id: "il_2", description: "Setup", quantity: 1, amount: 0, taxes: [] },
        ],
      },
    })
    await deliver("invoice.finalized", "in_L1")
    const [e] = of("invoice:finalized")
    expect(e?.data).toMatchObject({
      stripe_invoice_id: "in_L1",
      contact_id: "7d4e3c1a-0000-4000-8000-000000000001",
      customer: {
        name: "Client Example SAS",
        email: "billing@client.example",
        country: "FR",
        vat_id: "FR40902000009",
      },
    })
    expect(e?.data.customer.address).toContain("Lyon")
    // The mirror holds the masked text; the payload is built from it.
    expect(JSON.stringify(e?.data)).not.toContain(PAN)
    expect(e?.data.lines).toEqual([
      {
        description: "Pro plan",
        quantity: 3,
        unit_amount_excl_minor: "4900",
        amount_minor: "14700",
        discount_minor: "300",
        tax_rate_bp: 2000,
        tax_minor: "2880",
        period_start: "2025-12-01T00:00:00.000Z",
        period_end: "2026-01-01T00:00:00.000Z",
        product_name: null,
      },
      {
        description: "Setup",
        quantity: 1,
        unit_amount_excl_minor: "0",
        amount_minor: "0",
        tax_rate_bp: 0,
        tax_minor: "0",
        period_start: null,
        period_end: null,
        product_name: null,
      },
    ])
  })
})

describe("the reads invoicing calls", () => {
  it("refunds_for_charge lists a charge's refunds from Stripe by id and refuses a malformed id", async () => {
    seedCharge("ch_Q1", 9000, 4000, { payment_intent: "pi_Q1" })
    invoicePayments.set("pi_Q1", "in_Q1")
    refund("re_Q1", "ch_Q1", 1500, "succeeded")
    refund("re_Q2", "ch_Q1", 2500, "succeeded")
    const ctx = { db: db as never, fetch: fetchStripe }
    const res = (await refundsForCharge({ chargeId: "ch_Q1" }, ctx)) as Obj
    expect(res.invoice_id).toBe("in_Q1")
    expect(res.document_ref).toBe("stripe:in_Q1")
    expect(res.refunds.map((r: Obj) => [r.id, r.amount_minor]).sort()).toEqual([
      ["re_Q1", "1500"],
      ["re_Q2", "2500"],
    ])
    expect(((await refundsForCharge({ chargeId: "nope" }, ctx)) as Obj).error.code).toBe(
      "charge_id_invalid",
    )
  })

  it("reconcile_candidates lists invoices with no document read from Stripe, recently paid ones, and succeeded refunds with no credit note", async () => {
    const recent = new Date(Date.now() - 2 * 86_400_000).toISOString()
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString()
    const inv = (stripe_id: string, extra: Obj) => ({
      stripe_id,
      customer_id: "cus_FIXTURE0001",
      status: "open",
      total_minor: 12000,
      currency: "eur",
      finalized_at: recent,
      issuer: "undecided",
      liaison_document_id: null,
      ...extra,
    })
    db.seed("stripe_invoices", [
      inv("in_M1", {}),
      inv("in_OLD", { finalized_at: old }),
      inv("in_PRE", { issuer: "before_connection" }),
      inv("in_DONE", {
        status: "paid",
        paid_at: recent,
        liaison_document_id: "7d4e3c1a-0000-4000-8000-000000000002",
      }),
    ])
    stripeMockSeed("invoices", {
      id: "in_M1",
      status: "open",
      lines: { object: "list", has_more: false, data: [] },
    })
    db.seed("stripe_payments", [
      { stripe_id: "ch_M1", invoice_id: "in_M1", created_at_stripe: old },
    ])
    db.seed("stripe_refunds", [
      {
        stripe_id: "re_M1",
        payment_id: "ch_M1",
        amount_minor: 3000,
        currency: "eur",
        status: "succeeded",
        liaison_document_id: null,
        created_at_stripe: recent,
      },
      {
        stripe_id: "re_M2",
        payment_id: "ch_M1",
        amount_minor: 1000,
        currency: "eur",
        status: "pending",
        liaison_document_id: null,
        created_at_stripe: recent,
      },
      {
        stripe_id: "re_OLD",
        payment_id: "ch_M1",
        amount_minor: 1000,
        currency: "eur",
        status: "succeeded",
        liaison_document_id: null,
        created_at_stripe: old,
      },
    ])
    const res = (await reconcileCandidates({}, { db: db as never, fetch: fetchStripe })) as Obj
    expect(res.invoices.map((i: Obj) => [i.stripe_invoice_id, i.status])).toEqual([
      ["in_M1", "open"],
      ["in_DONE", "paid"],
    ])
    expect(res.invoices[0].lines).toEqual([])
    expect(res.refunds).toEqual([
      {
        refund_id: "re_M1",
        charge_id: "ch_M1",
        invoice_id: "in_M1",
        document_ref: "stripe:in_M1",
        amount_minor: "3000",
        currency: "eur",
        status: "succeeded",
        charged_at: old,
      },
    ])
  })

  it("reconcile_candidates walks past what invoicing decided or holds parked, however many come first", async () => {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
    const inv = (stripe_id: string, finalized_at: string, extra: Obj = {}) => ({
      stripe_id,
      customer_id: "cus_FIXTURE0001",
      status: "open",
      total_minor: 12000,
      currency: "eur",
      finalized_at,
      issuer: "liaison",
      liaison_document_id: null,
      ...extra,
    })
    // Newer than the one invoice an event missed: free trials, Stripe's own, a parked one.
    const skipped = Array.from({ length: 30 }, (_, i) =>
      inv(`in_Z${i}`, day(1), { total_minor: 0 }),
    )
    db.seed("stripe_invoices", [
      ...skipped,
      ...Array.from({ length: 30 }, (_, i) => inv(`in_S${i}`, day(1), { issuer: "stripe" })),
      inv("in_PARKED", day(1)),
      inv("in_LOST", day(3)),
    ])
    stripeMockSeed("invoices", {
      id: "in_LOST",
      status: "open",
      lines: { object: "list", has_more: false, data: [] },
    })
    db.seed("stripe_refunds", [
      ...Array.from({ length: 120 }, (_, i) => ({
        stripe_id: `re_K${i}`,
        payment_id: "ch_K",
        amount_minor: 100,
        currency: "eur",
        status: "succeeded",
        liaison_document_id: null,
        liaison_skipped: "issued_by_stripe",
        created_at_stripe: day(1),
      })),
      {
        stripe_id: "re_WAIT",
        payment_id: "ch_K",
        amount_minor: 100,
        currency: "eur",
        status: "succeeded",
        liaison_document_id: null,
        created_at_stripe: day(1),
      },
      {
        stripe_id: "re_LOST",
        payment_id: "ch_K",
        amount_minor: 100,
        currency: "eur",
        status: "succeeded",
        liaison_document_id: null,
        created_at_stripe: day(2),
      },
    ])
    const res = (await reconcileCandidates(
      { waiting: ["in_PARKED", "re_WAIT"] },
      { db: db as never, fetch: fetchStripe },
    )) as Obj
    expect(res.invoices.map((i: Obj) => i.stripe_invoice_id)).toEqual(["in_LOST"])
    expect(res.refunds.map((r: Obj) => r.refund_id)).toEqual(["re_LOST"])
  })

  it("invoicing records what a Stripe invoice or refund became, or that none follows", async () => {
    const doc = "7d4e3c1a-0000-4000-8000-000000000009"
    db.seed("stripe_invoices", [
      { stripe_id: "in_L1", status: "open" },
      { stripe_id: "in_L2", status: "open" },
    ])
    db.seed("stripe_refunds", [
      { stripe_id: "re_L1", status: "succeeded" },
      { stripe_id: "re_L2", status: "succeeded" },
    ])
    const ctx = { db: db as never }
    expect(
      await invoiceDocumentLink({ stripeInvoiceId: "in_L1", documentId: doc }, ctx),
    ).toMatchObject({ ok: true })
    expect(
      await invoiceDocumentLink({ stripeInvoiceId: "in_L2", issuedBy: "stripe" }, ctx),
    ).toMatchObject({ ok: true })
    expect(((await invoiceDocumentLink({ stripeInvoiceId: "in_L2" }, ctx)) as Obj).error.code).toBe(
      "invoice_link_invalid",
    )
    expect(
      await refundDocumentLink({ stripeRefundId: "re_L1", documentId: doc }, ctx),
    ).toMatchObject({ ok: true })
    expect(
      await refundDocumentLink({ stripeRefundId: "re_L2", skipped: "nothing_left" }, ctx),
    ).toMatchObject({ ok: true })
    const by = (t: string, id: string) => db.rows(t).find((r) => r.stripe_id === id) as Obj
    expect([
      by("stripe_invoices", "in_L1").issuer,
      by("stripe_invoices", "in_L1").liaison_document_id,
    ]).toEqual(["liaison", doc])
    expect(by("stripe_invoices", "in_L2").issuer).toBe("stripe")
    expect(by("stripe_refunds", "re_L1").liaison_document_id).toBe(doc)
    expect(by("stripe_refunds", "re_L2").liaison_skipped).toBe("nothing_left")
  })

  it("the document key of a charge is invoicing's own", () => {
    for (const c of [
      { id: "ch_1", invoice: "in_1" },
      { id: "ch_1", invoice: null },
      { id: "ch_1" },
    ]) {
      expect(stripeDocumentRef(c)).toBe(invoicingDocumentRef(c))
    }
  })
})
