// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the Stripe app tells invoicing about money, in the exact shapes invoicing's
// subscribers read (`bundled-apps/invoicing/src/handlers/stripe-*.ts`). Minor units
// travel as strings across the JSON bridge. Every value comes from an object read
// from Stripe by id (or from the mirror, which holds only such objects), never from
// a webhook's payload, and every free text passes the card mask first.
//
//   refund:created   a charge was refunded (`charge.refunded`, or the refund tool's
//                    own result): EVERY refund of the charge, by id, as Stripe lists
//                    them (`GET /v1/refunds?charge=`), never the charge's cumulative
//                    refunded amount. Invoicing credits each one that succeeded, once.
//   refund:settled   a pending refund succeeded (`charge.refund.updated`).
//   refund:failed    a refund failed or was canceled: no credit note follows.
//   payment:unmatched a succeeded charge no Stripe invoice explains.
//   invoice:*        each line's net before tax, its rate and the tax Stripe charged,
//                    and the buyer as the mirror holds them.
//
// A charge's invoice is its `invoice` field when the object carries one; otherwise
// the invoice payment of its payment intent (`GET /v1/invoice_payments`), the way the
// current API links them. The document a charge becomes is keyed by
// `stripeDocumentRef`: its invoice when it has one, else the charge itself.
import { StripeApiError, type StripeHttpCtx, stripeFetch } from "./http"
import {
  at,
  customerRow,
  type MaskTally,
  type MirrorDb,
  newTally,
  refundRow,
  scan,
  writeMirror,
} from "./mirror"

type Obj = Record<string, unknown>

export interface MoneyEventCtx extends StripeHttpCtx {
  db: MirrorDb
}

/** The key of the document a charge becomes: its invoice when it has one, else the charge (invoicing's rule). */
export function stripeDocumentRef(charge: { id: string; invoice?: string | null }): string {
  return charge.invoice ? `stripe:${charge.invoice}` : `stripe:${charge.id}`
}

const idOf = (v: unknown): string | null =>
  typeof v === "string" && v
    ? v
    : typeof (v as Obj | null)?.id === "string"
      ? ((v as Obj).id as string)
      : null
const minor = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? String(Math.round(v)) : "0"

export interface RefundItem {
  id: string
  amount_minor: string
  status: string
  currency: string | null
}

export interface RefundEventPayload {
  refund_id: string
  charge_id: string
  invoice_id: string | null
  document_ref: string
  amount_minor: string
  currency: string | null
  status: string
  refunds: RefundItem[]
  /** When the charge was made: who issued its invoice then decides whether a credit note follows. */
  charged_at: string | null
}

export function refundItem(obj: Obj): RefundItem {
  return {
    id: String(obj.id),
    amount_minor: minor(obj.amount),
    status: String(obj.status ?? "pending"),
    currency: typeof obj.currency === "string" ? obj.currency : null,
  }
}

/** The invoice a charge pays, or null when no invoice explains it. */
export async function invoiceOfCharge(ctx: StripeHttpCtx, charge: Obj): Promise<string | null> {
  const direct = idOf(charge.invoice)
  if (direct) return direct
  const intent = idOf(charge.payment_intent)
  if (!intent) return null
  try {
    const list = await stripeFetch<{ data?: Obj[] }>(ctx, "/v1/invoice_payments", {
      params: { payment: { type: "payment_intent", payment_intent: intent }, limit: 1 },
    })
    return idOf(list?.data?.[0]?.invoice)
  } catch (err) {
    // A list Stripe does not serve for this key or account: no invoice is known.
    if (err instanceof StripeApiError && (err.status === 404 || err.status === 400)) return null
    throw err
  }
}

/** A charge's date from its mirror row or its Stripe object; a missing date (the epoch) is none. */
export function chargedAt(row: Obj | null | undefined, charge?: Obj | null): string | null {
  const v = row?.created_at_stripe
  const fromRow =
    v instanceof Date
      ? v.toISOString()
      : typeof v === "string" && v
        ? new Date(v).toISOString()
        : null
  const out = fromRow ?? at(charge?.created)
  return out && Date.parse(out) > 0 ? out : null
}

/** Every refund of a charge, by id, newest first as Stripe lists them (at most 100). */
export async function listRefunds(ctx: StripeHttpCtx, chargeId: string): Promise<Obj[]> {
  const list = await stripeFetch<{ data?: Obj[] }>(ctx, "/v1/refunds", {
    params: { charge: chargeId, limit: 100 },
  })
  return Array.isArray(list?.data) ? list.data : []
}

/** Write each refund to the mirror (unless a newer copy is there) and return the event payload. */
export async function refundEvent(
  ctx: MoneyEventCtx,
  charge: { id: string; invoice: string | null; charged_at?: string | null },
  refunds: Obj[],
  focus: Obj | null,
  stripeUpdated: string,
  tally: MaskTally = newTally(),
): Promise<RefundEventPayload> {
  for (const r of refunds) {
    if (typeof r.id === "string")
      await writeMirror(ctx.db, "stripe_refunds", refundRow(r, tally), stripeUpdated)
  }
  const items = refunds.filter((r) => typeof r.id === "string").map(refundItem)
  const main = focus ? refundItem(focus) : (items[0] ?? null)
  return {
    refund_id: main?.id ?? "",
    charge_id: charge.id,
    invoice_id: charge.invoice,
    document_ref: stripeDocumentRef(charge),
    amount_minor: main?.amount_minor ?? "0",
    currency: main?.currency ?? null,
    status: main?.status ?? "pending",
    refunds: items,
    charged_at: charge.charged_at ?? null,
  }
}

/** A Stripe customer's mirror row, read from the mirror, else from Stripe (masked) and written unless `store` is false. */
export async function customerOf(
  ctx: MoneyEventCtx,
  customerId: string | null,
  stripeUpdated: string,
  store = true,
): Promise<Obj | null> {
  if (!customerId) return null
  const [row] = (await ctx.db.findMany("stripe_customers", {
    where: { stripe_id: customerId },
    limit: 1,
  })) as Obj[]
  if (row) return row
  try {
    const obj = await stripeFetch<Obj>(ctx, `/v1/customers/${encodeURIComponent(customerId)}`, {
      params: { expand: ["tax_ids"] },
    })
    if (!obj || obj.deleted === true) return null
    const fresh = customerRow(obj, newTally())
    if (store) await writeMirror(ctx.db, "stripe_customers", fresh, stripeUpdated)
    return fresh
  } catch (err) {
    if (err instanceof StripeApiError && err.status === 404) return null
    throw err
  }
}

/**
 * The buyer as invoicing reads them: name, email, country, one-line address, VAT id. The mirror
 * holds masked text already; the mask runs again here so nothing older or hand-written leaks.
 */
export function buyerOf(row: Obj | null, tally: MaskTally = newTally()): Obj | null {
  if (!row) return null
  const a = (row.address ?? null) as Obj | null
  const parts = a
    ? [
        a.line1,
        a.line2,
        [a.postal_code, a.city].filter((x) => typeof x === "string" && x).join(" "),
      ]
    : []
  const address = parts.filter((x) => typeof x === "string" && x.trim()).join(", ")
  const taxIds = Array.isArray(row.tax_ids) ? (row.tax_ids as Obj[]) : []
  const vat = taxIds.find((t) => t.type === "eu_vat" || String(t.type ?? "").endsWith("_vat"))
  return {
    name: scan(row.name, "customer name", tally),
    email: scan(row.email, "customer email", tally),
    country: typeof a?.country === "string" ? a.country : null,
    address: scan(address || null, "customer address", tally),
    vat_id: typeof vat?.value === "string" ? vat.value : null,
  }
}

export interface PaymentUnmatchedPayload {
  charge_id: string
  invoice_id: null
  document_ref: string
  customer_id: string | null
  contact_id: string | null
  amount_minor: string
  currency: string
  created: string | null
  description: string | null
  customer: Obj | null
}

export function unmatchedPayload(
  charge: Obj,
  customer: Obj | null,
  tally: MaskTally,
): PaymentUnmatchedPayload {
  const id = String(charge.id)
  return {
    charge_id: id,
    invoice_id: null,
    document_ref: stripeDocumentRef({ id, invoice: null }),
    customer_id: idOf(charge.customer),
    contact_id: typeof customer?.contact_id === "string" ? customer.contact_id : null,
    amount_minor: minor(charge.amount),
    currency: typeof charge.currency === "string" ? charge.currency : "",
    created: at(charge.created),
    description: scan(charge.description, "payment description", tally),
    customer: buyerOf(customer, tally),
  }
}

// --- Invoice lines ---

/** Tax rates by id, read once per delivery: their percentage in basis points. */
export type RateCache = Map<string, number | null>

async function rateBp(ctx: StripeHttpCtx, rate: unknown, cache: RateCache): Promise<number | null> {
  if (rate && typeof rate === "object") {
    const pct = (rate as Obj).percentage
    return typeof pct === "number" ? Math.round(pct * 100) : null
  }
  if (typeof rate !== "string" || !rate) return null
  if (cache.has(rate)) return cache.get(rate) ?? null
  let bp: number | null = null
  try {
    const obj = await stripeFetch<Obj>(ctx, `/v1/tax_rates/${encodeURIComponent(rate)}`, {})
    bp = typeof obj?.percentage === "number" ? Math.round(obj.percentage * 100) : null
  } catch (err) {
    if (!(err instanceof StripeApiError && err.status === 404)) throw err
  }
  cache.set(rate, bp)
  return bp
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/**
 * One invoice line as invoicing reads it: the net before tax per unit, the discount,
 * the rate and the tax Stripe charged. Works with the current line shape (`taxes`,
 * `pricing`, `discount_amounts`) and the older one (`tax_amounts`, `price`).
 */
export async function invoiceLine(
  ctx: StripeHttpCtx,
  l: Obj,
  cache: RateCache,
  tally: MaskTally,
): Promise<Obj> {
  const period = (l.period ?? {}) as Obj
  const qtyRaw = typeof l.quantity === "number" && l.quantity > 0 ? Math.round(l.quantity) : 1
  const taxes = (
    Array.isArray(l.taxes) ? l.taxes : Array.isArray(l.tax_amounts) ? l.tax_amounts : []
  ) as Obj[]
  const discount = (Array.isArray(l.discount_amounts) ? (l.discount_amounts as Obj[]) : []).reduce(
    (s, d) => s + num(d.amount),
    0,
  )
  const tax = taxes.reduce((s, t) => s + num(t.amount), 0)
  const inclusive = taxes.some((t) => t.tax_behavior === "inclusive" || t.inclusive === true)
  // Net after discount, before tax: Stripe's taxable amount when it states one.
  // (Several taxes on one line share one taxable base.)
  const stated = taxes.find((t) => typeof t.taxable_amount === "number")
  const taxable = stated
    ? num(stated.taxable_amount)
    : num(l.amount) - (inclusive ? tax : 0) - discount
  const gross = taxable + discount
  const rates = new Set<number>()
  for (const t of taxes) {
    const details = (t.tax_rate_details ?? null) as Obj | null
    const bp = await rateBp(ctx, details?.tax_rate ?? t.tax_rate, cache)
    if (bp !== null) rates.add(bp)
  }
  const rate = rates.size === 1 ? [...rates][0] : null
  let quantity = qtyRaw
  let unit = gross / qtyRaw
  let description = scan(l.description, "invoice line", tally)
  if (!Number.isInteger(unit)) {
    // A unit price with a fraction of a cent: one line at the whole amount, the quantity named.
    description = `${qtyRaw} × ${description ?? "Subscription"}`
    quantity = 1
    unit = gross
  }
  const pricing = (l.pricing ?? {}) as Obj
  const productName =
    (pricing.price_details as Obj | undefined)?.product ?? (l.price as Obj | undefined)?.product
  return {
    description,
    quantity,
    unit_amount_excl_minor: String(Math.round(unit)),
    amount_minor: minor(l.amount),
    ...(discount > 0 ? { discount_minor: String(discount) } : {}),
    ...(rate !== null
      ? { tax_rate_bp: rate, tax_minor: String(tax) }
      : taxes.length === 0
        ? { tax_rate_bp: 0, tax_minor: "0" }
        : {}),
    period_start: at(period.start),
    period_end: at(period.end),
    product_name:
      typeof productName === "string"
        ? null
        : scan((productName as Obj | undefined)?.name, "product name", tally),
  }
}

/** Every line of an invoice: the embedded page, then the rest from Stripe's lines list. */
export async function invoiceLines(
  ctx: StripeHttpCtx,
  invoice: Obj,
  tally: MaskTally,
): Promise<Obj[]> {
  const embedded = (invoice.lines ?? {}) as Obj
  const lines = [...((embedded.data ?? []) as Obj[])]
  let more = embedded.has_more === true
  while (more && lines.length < 500) {
    const last = lines[lines.length - 1]
    const page = await stripeFetch<{ data?: Obj[]; has_more?: boolean }>(
      ctx,
      `/v1/invoices/${encodeURIComponent(String(invoice.id))}/lines`,
      { params: { limit: 100, ...(last?.id ? { starting_after: String(last.id) } : {}) } },
    )
    lines.push(...(page?.data ?? []))
    more = page?.has_more === true && (page?.data?.length ?? 0) > 0
  }
  const cache: RateCache = new Map()
  const out: Obj[] = []
  for (const l of lines) out.push(await invoiceLine(ctx, l, cache, tally))
  return out
}

const s = (v: unknown) => (typeof v === "number" ? String(v) : v)

/** `invoice:finalized` and `invoice:paid` as invoicing reads them, from the invoice's mirror row and the object read from Stripe. */
export async function invoiceEventPayload(
  ctx: MoneyEventCtx,
  row: Obj,
  obj: Obj,
  tally: MaskTally,
  stripeUpdated: string,
  /** False for a read: nothing is written to the mirror. */
  store = true,
): Promise<Obj> {
  const lines = await invoiceLines(ctx, obj, tally)
  const customer = await customerOf(
    ctx,
    typeof row.customer_id === "string" ? row.customer_id : null,
    stripeUpdated,
    store,
  )
  return {
    stripe_invoice_id: row.stripe_id,
    customer_id: row.customer_id,
    contact_id: typeof customer?.contact_id === "string" ? customer.contact_id : null,
    subscription_id: row.subscription_id,
    number: row.number,
    status: row.status,
    total_minor: s(row.total_minor),
    tax_minor: s(row.tax_minor),
    amount_paid_minor: s(row.amount_paid_minor),
    currency: row.currency,
    period_start: row.period_start,
    period_end: row.period_end,
    finalized_at: row.finalized_at,
    paid_at: row.paid_at,
    billing_reason: row.billing_reason,
    next_payment_attempt: row.next_payment_attempt,
    charge_id: idOf(obj.charge),
    customer: buyerOf(customer, tally),
    lines,
  }
}
