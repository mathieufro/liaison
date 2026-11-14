// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mirror: what of a Stripe object is kept, and the one way a row is written.
//
// ALLOW-LIST. Each `*Row` function copies the named columns and nothing else.
// Metadata, payment method details beyond brand, last 4 and expiry, and the raw
// object are never kept. Every free text Stripe lets a payer or a user fill
// (names, descriptions, memos, failure messages, dispute reasons, line
// descriptions) goes through the card mask first, kept or not, and the number
// of card numbers found is reported so the caller can raise one attention item.
//
// ORDER. Stripe objects carry no update time, so `stripe_updated` is the instant
// the re-fetch STARTED (taken before the request). A write never moves a row
// backwards: the decision is made by the database, in the UPDATE's own WHERE,
// never by a value read earlier and trusted later. The app's database bridge
// has no upsert, so the write is a compare-and-swap loop:
//   - no row: INSERT; a concurrent insert of the same id loses on the unique
//     index (`org_id, stripe_id`) and the loop reads again;
//   - a row newer than ours: nothing is written (stale);
//   - a row not newer: `UPDATE … WHERE stripe_id = $id AND stripe_updated = $seen`,
//     which matches nothing if anyone committed in between, and the loop reads
//     again. Postgres re-checks that WHERE on the newest committed row after
//     waiting for a concurrent writer's lock, so two re-fetches committing in
//     either order leave the later one's state.
import { computeMrr, discountColumns, discountsOf, type MrrDiscount, taxPercentOf } from "./mrr"
import { maskCardNumbers } from "./pan-scan"

export type MirrorEntity =
  | "stripe_customers"
  | "stripe_subscriptions"
  | "stripe_invoices"
  | "stripe_payments"
  | "stripe_refunds"
  | "stripe_disputes"

/** The slice of the app's db bridge the mirror uses. */
export interface MirrorDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      limit?: number
      offset?: number
      orderBy?: Record<string, "asc" | "desc">
    },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  updateMany(
    entity: string,
    opts: { where: Record<string, unknown>; data: Record<string, unknown> },
  ): Promise<{ count: number }>
}

type Obj = Record<string, unknown>

/** Card numbers found while building rows; shared across one delivery. */
export interface MaskTally {
  cards: number
  fields: string[]
}

export function newTally(): MaskTally {
  return { cards: 0, fields: [] }
}

/** Masked text (or null), counting what was hidden under `field`. */
export function scan(value: unknown, field: string, tally: MaskTally): string | null {
  if (typeof value !== "string") return null
  const r = maskCardNumbers(value)
  if (r.masked > 0) {
    tally.cards += r.masked
    if (!tally.fields.includes(field)) tally.fields.push(field)
  }
  return r.text
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const idOf = (v: unknown): string | null => (typeof v === "string" ? v : str((v as Obj | null)?.id))

/** Unix seconds to an ISO instant, or null. */
export function at(seconds: unknown): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null
}

function cardOf(obj: Obj): {
  card_brand: string | null
  card_last4: string | null
  card_exp: string | null
} {
  const card = ((obj.payment_method_details as Obj | undefined)?.card ?? null) as Obj | null
  if (!card) return { card_brand: null, card_last4: null, card_exp: null }
  const m = num(card.exp_month)
  const y = num(card.exp_year)
  const last4 = str(card.last4)
  return {
    card_brand: str(card.brand),
    card_last4: last4 && /^\d{4}$/.test(last4) ? last4 : null,
    card_exp:
      m > 0 && y > 0 ? `${String(m).padStart(2, "0")}/${String(y % 100).padStart(2, "0")}` : null,
  }
}

export function customerRow(obj: Obj, tally: MaskTally): Obj {
  // The description is read for card numbers and never kept (no column).
  scan(obj.description, "customer description", tally)
  const addr = (obj.address ?? null) as Obj | null
  const taxIds = ((obj.tax_ids as Obj | undefined)?.data ?? null) as Obj[] | null
  return {
    stripe_id: obj.id,
    email: scan(obj.email, "customer email", tally),
    name: scan(obj.name, "customer name", tally),
    currency: str(obj.currency),
    delinquent: obj.delinquent === true,
    address: addr
      ? {
          country: str(addr.country),
          line1: scan(addr.line1, "customer address", tally),
          line2: scan(addr.line2, "customer address", tally),
          postal_code: str(addr.postal_code),
          city: scan(addr.city, "customer address", tally),
        }
      : null,
    tax_ids: Array.isArray(taxIds)
      ? taxIds.map((t) => ({ type: str(t.type), value: str(t.value) }))
      : null,
    deleted_at: null,
    created_at_stripe: at(obj.created) ?? new Date(0).toISOString(),
  }
}

/**
 * A subscription's mirror row. `kept` is the discounts the stored row already
 * holds: used when the object carries discount ids only (an event snapshot).
 */
export function subscriptionRow(
  obj: Obj,
  tally: MaskTally,
  now: Date = new Date(),
  kept: MrrDiscount[] = [],
): Obj {
  scan(obj.description, "subscription description", tally)
  const items = (((obj.items as Obj | undefined)?.data ?? []) as Obj[]).map((it) => {
    const price = (it.price ?? {}) as Obj
    const rec = (price.recurring ?? {}) as Obj
    return {
      price_id: str(price.id),
      product_name: scan(
        typeof price.product === "string" ? price.product : (price.product as Obj | null)?.name,
        "product name",
        tally,
      ),
      unit_amount: num(price.unit_amount),
      currency: str(price.currency),
      interval: str(rec.interval),
      interval_count: num(rec.interval_count) || 1,
      quantity: num(it.quantity) || 1,
      usage_type: str(rec.usage_type),
      tax_behavior: str(price.tax_behavior),
      tax_percent: taxPercentOf(it, obj),
      period_start: at(it.current_period_start),
      period_end: at(it.current_period_end),
    }
  })
  const status = String(obj.status ?? "active")
  const discounts = discountsOf(obj, now) ?? kept
  const mrr = computeMrr({ status, items, discounts })
  const first = items[0]
  return {
    stripe_id: obj.id,
    customer_id: idOf(obj.customer) ?? "",
    status,
    plan_name: first?.product_name ?? first?.price_id ?? "",
    items: items.map(({ period_start: _s, period_end: _e, ...rest }) => rest),
    ...discountColumns(discounts),
    mrr_minor: mrr,
    currency: str(obj.currency) ?? first?.currency ?? "",
    current_period_start: first?.period_start ?? at(obj.start_date) ?? new Date(0).toISOString(),
    current_period_end: first?.period_end ?? at(obj.start_date) ?? new Date(0).toISOString(),
    trial_end: at(obj.trial_end),
    cancel_at: at(obj.cancel_at),
    canceled_at: at(obj.canceled_at),
    // When the customer's subscription began at Stripe (not when this mirror first saw it).
    started_at: at(obj.start_date),
    ...subscriptionCardOf(obj),
  }
}

/**
 * The card a subscription bills, from its expanded `default_payment_method`: a customer who adds
 * a new card shows the new one. Not expanded (an id, or none): no card columns, so the row keeps
 * the card it held.
 */
function subscriptionCardOf(obj: Obj): Partial<ReturnType<typeof cardOf>> {
  const pm = obj.default_payment_method
  if (!pm || typeof pm !== "object") return {}
  const card = (pm as Obj).card
  if (!card || typeof card !== "object") return {}
  return cardOf({ payment_method_details: { card } })
}

export function invoiceRow(obj: Obj, tally: MaskTally): Obj {
  // The memo (`description`) and the footer are read for card numbers and never kept.
  scan(obj.description, "invoice memo", tally)
  scan(obj.footer, "invoice memo", tally)
  const parent = (obj.parent ?? null) as Obj | null
  const sub = (parent?.subscription_details as Obj | undefined)?.subscription ?? obj.subscription
  const transitions = (obj.status_transitions ?? {}) as Obj
  const taxes = Array.isArray(obj.total_taxes) ? (obj.total_taxes as Obj[]) : []
  return {
    stripe_id: obj.id,
    customer_id: idOf(obj.customer) ?? "",
    subscription_id: idOf(sub),
    number: str(obj.number),
    status: String(obj.status ?? "draft"),
    total_minor: num(obj.total),
    tax_minor: taxes.reduce((s, t) => s + num(t.amount), 0),
    amount_paid_minor: num(obj.amount_paid),
    amount_due_minor: num(obj.amount_due),
    currency: str(obj.currency) ?? "",
    period_start: at(obj.period_start),
    period_end: at(obj.period_end),
    billing_reason: str(obj.billing_reason),
    hosted_invoice_url: str(obj.hosted_invoice_url),
    next_payment_attempt: at(obj.next_payment_attempt),
    finalized_at: at(transitions.finalized_at),
    paid_at: at(transitions.paid_at),
  }
}

export function paymentRow(obj: Obj, tally: MaskTally): Obj {
  scan(obj.description, "payment description", tally)
  const status = obj.status === "succeeded" || obj.status === "failed" ? obj.status : "pending"
  return {
    stripe_id: obj.id,
    payment_intent: idOf(obj.payment_intent),
    invoice_id: idOf(obj.invoice),
    customer_id: idOf(obj.customer),
    amount_minor: num(obj.amount),
    refunded_minor: num(obj.amount_refunded),
    currency: str(obj.currency) ?? "",
    status,
    failure_code: str(obj.failure_code),
    failure_message: scan(obj.failure_message, "payment failure message", tally),
    ...cardOf(obj),
    created_at_stripe: at(obj.created) ?? new Date(0).toISOString(),
    disputed: obj.disputed === true,
  }
}

export function refundRow(obj: Obj, tally: MaskTally): Obj {
  return {
    stripe_id: obj.id,
    payment_id: idOf(obj.charge) ?? "",
    amount_minor: num(obj.amount),
    currency: str(obj.currency) ?? "",
    status: String(obj.status ?? "pending"),
    reason: scan(obj.reason, "refund reason", tally),
    created_at_stripe: at(obj.created) ?? new Date(0).toISOString(),
  }
}

export function disputeRow(obj: Obj, tally: MaskTally): Obj {
  const evidence = (obj.evidence_details ?? {}) as Obj
  return {
    stripe_id: obj.id,
    payment_id: idOf(obj.charge) ?? "",
    amount_minor: num(obj.amount),
    currency: str(obj.currency) ?? "",
    reason: scan(obj.reason, "dispute reason", tally) ?? "",
    status: String(obj.status ?? ""),
    evidence_due_by: at(evidence.due_by),
    created_at_stripe: at(obj.created) ?? new Date(0).toISOString(),
  }
}

export type WriteOutcome = "inserted" | "updated" | "stale"

const MAX_ATTEMPTS = 8

function instantMs(v: unknown): number {
  if (v instanceof Date) return v.getTime()
  return typeof v === "string" ? Date.parse(v) : Number.NaN
}

/**
 * Write one mirror row unless the stored one is newer. `stripeUpdated` is the
 * instant the re-fetch started (ISO, millisecond precision).
 */
export async function writeMirror(
  db: MirrorDb,
  entity: MirrorEntity,
  row: Obj,
  stripeUpdated: string,
  /** Called once after this call's own write, with the row as it was before (null: none). */
  written?: (before: Obj | null) => Promise<void>,
): Promise<WriteOutcome> {
  const stripeId = row.stripe_id
  if (typeof stripeId !== "string" || stripeId.length === 0)
    throw new Error(`${entity}: a row without a Stripe id`)
  const mine = Date.parse(stripeUpdated)
  const data = { ...row, stripe_updated: stripeUpdated }
  let lastError: unknown = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [current] = (await db.findMany(entity, {
      where: { stripe_id: stripeId },
      limit: 1,
    })) as Obj[]
    if (!current) {
      try {
        await db.insert(entity, data)
        await written?.(null)
        return "inserted"
      } catch (err) {
        // Another writer inserted the same id first: read it and decide again.
        lastError = err
        continue
      }
    }
    const seen = current.stripe_updated
    const seenMs = instantMs(seen)
    if (Number.isFinite(seenMs) && seenMs > mine) return "stale"
    const { count } = await db.updateMany(entity, {
      where:
        seen === null || seen === undefined
          ? { stripe_id: stripeId, stripe_updated: null }
          : { stripe_id: stripeId, stripe_updated: seen },
      data,
    })
    if (count > 0) {
      await written?.(current)
      return "updated"
    }
    // Someone committed in between: read again.
  }
  throw new Error(
    `${entity} ${stripeId}: the row kept changing under ${MAX_ATTEMPTS} writes${lastError instanceof Error ? ` (${lastError.message})` : ""}; nothing was written.`,
  )
}
