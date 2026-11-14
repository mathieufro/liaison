// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A mirror row turned back into the processor's object, in its API shape.
//
// The stand-in answers a read by id or a list from the org's own mirror rows
// (outside objects win, overlay.ts). The shapes are the inverse of the payments
// app's row builders: reading an object the stand-in returned and writing it
// through the app's own mirror code gives back the row it came from, so a
// reconcile or a probe over the stand-in converges and changes nothing. Only
// what the mirror keeps exists here: no raw card number, no metadata the mirror
// did not keep, never a key.
import { PAYMENTS_APP } from "./sentinel"

type Obj = Record<string, unknown>

/** The mirror's column holding the processor's id. */
export const ID = `${PAYMENTS_APP}_id`
/** The mirror's column holding the object's creation instant. */
export const CREATED = `created_at_${PAYMENTS_APP}`

/** An instant (Date, ISO text or null) as the processor's unix seconds, or null. */
export function unixOf(v: unknown): number | null {
  const ms = v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number.NaN
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

const num = (v: unknown): number => {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" || typeof v === "bigint"
        ? Number(v)
        : Number.NaN
  return Number.isFinite(n) ? n : 0
}
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v))
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)

function json(v: unknown): unknown {
  if (typeof v !== "string") return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

/** The card a row keeps (brand, last 4, `MM/YY`), as `payment_method_details.card`. */
function cardOf(row: Obj): Obj | null {
  const last4 = str(row.card_last4)
  const brand = str(row.card_brand)
  if (!last4 && !brand) return null
  const exp = /^(\d{2})\/(\d{2})$/.exec(String(row.card_exp ?? ""))
  return {
    brand,
    last4,
    exp_month: exp ? Number(exp[1]) : null,
    exp_year: exp ? 2000 + Number(exp[2]) : null,
  }
}

export function customerObject(row: Obj, livemode: boolean): Obj {
  const id = String(row[ID])
  if (row.deleted_at) return { id, object: "customer", deleted: true }
  const address = json(row.address) as Obj | null
  const taxIds = json(row.tax_ids) as Obj[] | null
  return {
    id,
    object: "customer",
    livemode,
    email: str(row.email),
    name: str(row.name),
    currency: str(row.currency),
    delinquent: row.delinquent === true,
    address: address ?? null,
    tax_ids: Array.isArray(taxIds)
      ? {
          object: "list",
          data: taxIds.map((t) => ({ object: "tax_id", type: t.type, value: t.value })),
          has_more: false,
        }
      : null,
    created: unixOf(row[CREATED]),
  }
}

export function subscriptionObject(row: Obj, livemode: boolean): Obj {
  const items = (json(row.items) as Obj[] | null) ?? []
  const start = unixOf(row.current_period_start)
  const end = unixOf(row.current_period_end)
  const percent = numOrNull(row.discount_percent)
  const amount = numOrNull(row.discount_amount_minor)
  const discounts: Obj[] = []
  if (percent !== null && percent > 0)
    discounts.push({ object: "discount", coupon: { percent_off: percent, duration: "forever" } })
  if (amount !== null && amount > 0)
    discounts.push({ object: "discount", coupon: { amount_off: amount, duration: "forever" } })
  const cancelAt = unixOf(row.cancel_at)
  return {
    id: String(row[ID]),
    object: "subscription",
    livemode,
    customer: String(row.customer_id ?? ""),
    status: String(row.status ?? "active"),
    currency: str(row.currency),
    start_date: unixOf(row.started_at) ?? start,
    trial_end: unixOf(row.trial_end),
    cancel_at: cancelAt,
    cancel_at_period_end: cancelAt !== null && end !== null && cancelAt === end,
    canceled_at: unixOf(row.canceled_at),
    discounts,
    items: {
      object: "list",
      has_more: false,
      data: items.map((it, i) => ({
        id: `si_${String(row[ID]).replace(/^sub_/, "")}_${i}`,
        object: "subscription_item",
        quantity: num(it.quantity) || 1,
        current_period_start: start,
        current_period_end: end,
        tax_rates:
          typeof it.tax_percent === "number" && it.tax_percent > 0
            ? [{ object: "tax_rate", percentage: it.tax_percent }]
            : [],
        price: {
          id: it.price_id ?? null,
          object: "price",
          product:
            typeof it.product_name === "string"
              ? { object: "product", name: it.product_name }
              : null,
          unit_amount: num(it.unit_amount),
          currency: it.currency ?? null,
          tax_behavior: it.tax_behavior ?? null,
          recurring: {
            interval: it.interval ?? null,
            interval_count: num(it.interval_count) || 1,
            usage_type: it.usage_type ?? null,
          },
        },
      })),
    },
  }
}

export function invoiceObject(row: Obj, livemode: boolean): Obj {
  const tax = num(row.tax_minor)
  return {
    id: String(row[ID]),
    object: "invoice",
    livemode,
    customer: String(row.customer_id ?? ""),
    parent: row.subscription_id
      ? {
          type: "subscription_details",
          subscription_details: { subscription: String(row.subscription_id) },
        }
      : null,
    number: str(row.number),
    status: String(row.status ?? "draft"),
    total: num(row.total_minor),
    total_taxes: tax ? [{ amount: tax }] : [],
    amount_paid: num(row.amount_paid_minor),
    amount_due: num(row.amount_due_minor),
    currency: str(row.currency) ?? "",
    period_start: unixOf(row.period_start),
    period_end: unixOf(row.period_end),
    billing_reason: str(row.billing_reason),
    hosted_invoice_url: str(row.hosted_invoice_url),
    next_payment_attempt: unixOf(row.next_payment_attempt),
    status_transitions: { finalized_at: unixOf(row.finalized_at), paid_at: unixOf(row.paid_at) },
  }
}

/** The lines of an invoice the mirror keeps no lines for: one line, its amount before tax. */
export function invoiceLines(invoice: Obj, planName: string | null): Obj[] {
  if (invoice.lines && typeof invoice.lines === "object") {
    const data = (invoice.lines as Obj).data
    if (Array.isArray(data)) return data as Obj[]
  }
  const total = num(invoice.total)
  const tax = ((invoice.total_taxes as Obj[] | undefined) ?? []).reduce(
    (s, t) => s + num(t.amount),
    0,
  )
  const net = total - tax
  return [
    {
      id: `il_${String(invoice.id).replace(/^in_/, "")}`,
      object: "line_item",
      description: planName ?? "Subscription",
      quantity: 1,
      amount: net,
      currency: invoice.currency,
      period: { start: invoice.period_start, end: invoice.period_end },
      taxes:
        tax > 0 && net > 0
          ? [
              {
                amount: tax,
                taxable_amount: net,
                tax_behavior: "exclusive",
                tax_rate_details: {
                  tax_rate: { percentage: Math.round((tax / net) * 10000) / 100 },
                },
              },
            ]
          : [],
    },
  ]
}

export function chargeObject(row: Obj, livemode: boolean): Obj {
  const amount = num(row.amount_minor)
  const refunded = num(row.refunded_minor)
  const card = cardOf(row)
  return {
    id: String(row[ID]),
    object: "charge",
    livemode,
    payment_intent: str(row.payment_intent),
    invoice: str(row.invoice_id),
    customer: str(row.customer_id),
    amount,
    amount_refunded: refunded,
    refunded: amount > 0 && refunded >= amount,
    currency: str(row.currency) ?? "",
    status: String(row.status ?? "pending"),
    failure_code: str(row.failure_code),
    failure_message: str(row.failure_message),
    payment_method_details: card ? { type: "card", card } : null,
    created: unixOf(row[CREATED]),
    disputed: row.disputed === true,
  }
}

export function refundObject(row: Obj, livemode: boolean): Obj {
  return {
    id: String(row[ID]),
    object: "refund",
    livemode,
    charge: String(row.payment_id ?? ""),
    amount: num(row.amount_minor),
    currency: str(row.currency) ?? "",
    status: String(row.status ?? "pending"),
    reason: str(row.reason),
    metadata: {},
    created: unixOf(row[CREATED]),
  }
}

export function disputeObject(row: Obj, livemode: boolean): Obj {
  return {
    id: String(row[ID]),
    object: "dispute",
    livemode,
    charge: String(row.payment_id ?? ""),
    amount: num(row.amount_minor),
    currency: str(row.currency) ?? "",
    reason: str(row.reason) ?? "",
    status: String(row.status ?? ""),
    evidence_details: { due_by: unixOf(row.evidence_due_by) },
    created: unixOf(row[CREATED]),
  }
}

/** One modelled resource: its path segment, its object kind, its mirror table suffix, its builder. */
export interface StandInResource {
  segment: string
  kind: "customer" | "subscription" | "invoice" | "charge" | "refund" | "dispute"
  table: string
  build: (row: Obj, livemode: boolean) => Obj
}

export const STANDIN_RESOURCES: readonly StandInResource[] = [
  { segment: "customers", kind: "customer", table: "customers", build: customerObject },
  {
    segment: "subscriptions",
    kind: "subscription",
    table: "subscriptions",
    build: subscriptionObject,
  },
  { segment: "invoices", kind: "invoice", table: "invoices", build: invoiceObject },
  { segment: "charges", kind: "charge", table: "payments", build: chargeObject },
  { segment: "refunds", kind: "refund", table: "refunds", build: refundObject },
  { segment: "disputes", kind: "dispute", table: "disputes", build: disputeObject },
]
