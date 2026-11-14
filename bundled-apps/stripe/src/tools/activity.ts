// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `activity_read` (hidden, an activity source): the Stripe rows of a company's
// or a contact's timeline. Seven kinds: the customer created upstream (so a
// linked customer with nothing else still shows), a payment failed, a retry
// failed (a later failed charge on the same invoice), a subscription started, a
// subscription cancelled, a refund, a dispute. Newest first by (time, `<prefix><id>`), only
// rows strictly older than the cursor, as the kernel merges sources.
import { iso, type ReadCtx, UUID } from "./read-common"

type Obj = Record<string, unknown>

interface Cursor {
  at: string
  id: string
}

export interface ActivityRow {
  id: string
  at: string
  title: string
  who: string | null
  contactId: string | null
  href: { app: string; entityType: string; entityId: string } | null
}

function compare(a: Cursor, b: Cursor): number {
  const ta = Date.parse(a.at)
  const tb = Date.parse(b.at)
  if (ta !== tb) return tb - ta
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

function money(minor: unknown, currency: unknown): string {
  const n = Number(minor)
  return Number.isFinite(n)
    ? `, ${(n / 100).toFixed(2)} ${String(currency ?? "").toUpperCase()}`.trimEnd()
    : ""
}

export async function activityRead(params: Obj | undefined, ctx: ReadCtx) {
  const v = params ?? {}
  const contactIds = Array.isArray(v.contactIds)
    ? v.contactIds.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 50)
    : []
  const companyId = typeof v.companyId === "string" && UUID.test(v.companyId) ? v.companyId : null
  const b = v.before as { at?: unknown; id?: unknown } | null | undefined
  const before =
    b && typeof b.at === "string" && typeof b.id === "string"
      ? { at: new Date(b.at).toISOString(), id: b.id }
      : null
  const limit = Math.min(100, Math.max(1, Number(v.limit) || 30))
  const prefix = typeof v.prefix === "string" ? v.prefix : ""

  const customers: Obj[] = []
  if (contactIds.length > 0) {
    customers.push(
      ...((await ctx.db.findMany("stripe_customers", {
        where: { contact_id: { in: contactIds } },
        limit: 100,
      })) as Obj[]),
    )
  }
  if (companyId) {
    customers.push(
      ...((await ctx.db.findMany("stripe_customers", {
        where: { company_id: companyId },
        limit: 100,
      })) as Obj[]),
    )
  }
  const byId = new Map(customers.map((c) => [String(c.stripe_id), c]))
  if (byId.size === 0) return { rows: [] }
  const ids = [...byId.keys()]

  const rows: ActivityRow[] = []
  const push = (
    customerId: string,
    id: string,
    at: string | null,
    title: string,
    entityId: string,
  ) => {
    if (!at) return
    if (before && compare({ at, id: `${prefix}${id}` }, before) <= 0) return
    const c = byId.get(customerId)
    rows.push({
      id,
      at,
      title,
      who: typeof c?.name === "string" ? c.name : null,
      contactId: typeof c?.contact_id === "string" ? c.contact_id : null,
      href: { app: "stripe", entityType: "customer", entityId: customerId },
    })
    void entityId
  }

  for (const [customerId, c] of byId) {
    if (c.deleted_at) continue
    push(
      customerId,
      `${customerId}:customer`,
      iso(c.created_at_stripe),
      "Customer created",
      customerId,
    )
  }

  const payments = (await ctx.db.findMany("stripe_payments", {
    where: { customer_id: { in: ids } },
    orderBy: { created_at_stripe: "asc" },
    limit: 1000,
  })) as Obj[]
  const failedSeen = new Set<string>()
  for (const p of payments) {
    if (p.status !== "failed") continue
    const invoice = typeof p.invoice_id === "string" ? p.invoice_id : null
    const retry = invoice !== null && failedSeen.has(invoice)
    if (invoice) failedSeen.add(invoice)
    push(
      String(p.customer_id),
      `${String(p.stripe_id)}:${retry ? "retry_failed" : "payment_failed"}`,
      iso(p.created_at_stripe),
      `${retry ? "Retry failed" : "Payment failed"}${money(p.amount_minor, p.currency)}`,
      String(p.stripe_id),
    )
  }

  const subs = (await ctx.db.findMany("stripe_subscriptions", {
    where: { customer_id: { in: ids } },
    limit: 1000,
  })) as Obj[]
  for (const s of subs) {
    const plan = String(s.plan_name ?? "Subscription")
    push(
      String(s.customer_id),
      `${String(s.stripe_id)}:started`,
      iso(s.started_at) ?? iso(s.created_at) ?? iso(s.current_period_start),
      `${plan} started`,
      String(s.stripe_id),
    )
    if (s.status === "canceled" || s.canceled_at) {
      push(
        String(s.customer_id),
        `${String(s.stripe_id)}:cancelled`,
        iso(s.canceled_at),
        `${plan} cancelled`,
        String(s.stripe_id),
      )
    }
  }

  const paymentIds = payments.map((p) => String(p.stripe_id))
  const customerOf = new Map(payments.map((p) => [String(p.stripe_id), String(p.customer_id)]))
  if (paymentIds.length > 0) {
    const refunds = (await ctx.db.findMany("stripe_refunds", {
      where: { payment_id: { in: paymentIds } },
      limit: 1000,
    })) as Obj[]
    for (const r of refunds) {
      push(
        customerOf.get(String(r.payment_id)) ?? "",
        `${String(r.stripe_id)}:refund`,
        iso(r.created_at_stripe),
        `Refund${money(r.amount_minor, r.currency)}`,
        String(r.stripe_id),
      )
    }
    const disputes = (await ctx.db.findMany("stripe_disputes", {
      where: { payment_id: { in: paymentIds } },
      limit: 1000,
    })) as Obj[]
    for (const d of disputes) {
      push(
        customerOf.get(String(d.payment_id)) ?? "",
        `${String(d.stripe_id)}:dispute`,
        iso(d.created_at_stripe),
        `Dispute opened${money(d.amount_minor, d.currency)}`,
        String(d.stripe_id),
      )
    }
  }
  rows.sort((a, b) =>
    compare({ at: a.at, id: `${prefix}${a.id}` }, { at: b.at, id: `${prefix}${b.id}` }),
  )
  return { rows: rows.slice(0, limit) }
}
