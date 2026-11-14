// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The two reads invoicing makes of the Stripe app, hidden from the agent:
//
//   refunds_for_charge   every refund of one charge, by id, read from Stripe
//                        (`GET /v1/refunds?charge=`), never the charge's cumulative
//                        refunded amount, with the charge's invoice and the key of the
//                        document the charge became (`stripeDocumentRef`).
//   reconcile_candidates what an event may have missed, from the mirror: Stripe invoices
//                        finalized in the last 35 days that name no Liaison document
//                        (re-read from Stripe, in the `invoice:finalized` shape), paid
//                        invoices of the last 3 days that name one (to mark them paid),
//                        and succeeded refunds of the last 35 days with no credit note.
//                        Invoicing's own handlers decide; each is idempotent by its key.
import { refuseTool } from "@liaison/app-sdk/errors"
import { type StripeHttpCtx, stripeFetch } from "../http"
import { type MirrorDb, newTally } from "../mirror"
import {
  chargedAt,
  invoiceEventPayload,
  invoiceOfCharge,
  listRefunds,
  refundItem,
  stripeDocumentRef,
} from "../money-events"
import { moneyActionHold, type StateDb } from "../states"

type Obj = Record<string, unknown>

export interface MoneyReadCtx extends StripeHttpCtx {
  db: StateDb & MirrorDb
}

const CHARGE = /^(ch|py)_[A-Za-z0-9_]+$/
const DAY = 86_400_000
const WINDOW_DAYS = 35
const PAID_DAYS = 3
const MAX_INVOICES = 20
const MAX_REFUNDS = 100
const MAX_PAID = 100
const PAGE = 200

const iso = (v: unknown): string | null =>
  v instanceof Date
    ? v.toISOString()
    : typeof v === "string" && v
      ? new Date(v).toISOString()
      : null
const minor = (v: unknown): string => String(v ?? "0")

export async function refundsForCharge(params: Obj | undefined, ctx: MoneyReadCtx) {
  const chargeId = typeof params?.chargeId === "string" ? params.chargeId.trim() : ""
  if (!CHARGE.test(chargeId)) {
    return refuseTool(
      "charge_id_invalid",
      `"${chargeId}" is not a Stripe charge id (ch_...), so no refund was read.`,
    )
  }
  const hold = await moneyActionHold(ctx.db)
  if (hold)
    return refuseTool(
      hold.error.code ?? "stripe_unavailable",
      `Stripe cannot be asked about charge ${chargeId}: ${hold.error.message}`,
      { retryable: true },
    )
  let charge: Obj
  let refunds: Obj[]
  try {
    charge = await stripeFetch<Obj>(ctx, `/v1/charges/${encodeURIComponent(chargeId)}`, {})
    refunds = await listRefunds(ctx, chargeId)
  } catch (err) {
    return refuseTool(
      "stripe_unavailable",
      `Stripe did not list the refunds of charge ${chargeId} (${err instanceof Error ? err.message : String(err)}). Nothing changed; ask again later.`,
      { retryable: true },
    )
  }
  const invoiceId = await invoiceOfCharge(ctx, charge).catch(() => null)
  const items = refunds.filter((r) => typeof r.id === "string").map(refundItem)
  return {
    charge_id: chargeId,
    invoice_id: invoiceId,
    document_ref: stripeDocumentRef({ id: chargeId, invoice: invoiceId }),
    refunds: items,
    summary:
      items.length === 0
        ? `Charge ${chargeId} has no refund in Stripe.`
        : `Charge ${chargeId} has ${items.length} refund(s) in Stripe: ${items.map((r) => `${r.id} ${r.amount_minor} ${r.status}`).join(", ")}.`,
  }
}

/** Rows of `entity` matching `where`, newest first by `order`, read a page at a time until `keep`
 *  has taken `max` of them or a row falls before `since`. Rows invoicing already decided are
 *  filtered out by the query, so they never take a place. */
async function newestWhere(
  ctx: MoneyReadCtx,
  entity: string,
  where: Obj,
  order: string,
  since: number,
  max: number,
  keep: (r: Obj) => boolean,
): Promise<Obj[]> {
  const out: Obj[] = []
  for (let offset = 0; out.length < max; offset += PAGE) {
    const page = (await ctx.db.findMany(entity, {
      where,
      orderBy: { [order]: "desc" },
      limit: PAGE,
      offset,
    })) as Obj[]
    for (const r of page) {
      const at = iso(r[order])
      if (at === null) continue
      if (Date.parse(at) < since) return out
      if (keep(r)) out.push(r)
      if (out.length >= max) return out
    }
    if (page.length < PAGE) return out
  }
  return out
}

export async function reconcileCandidates(params: Obj | undefined, ctx: MoneyReadCtx) {
  const hold = await moneyActionHold(ctx.db)
  if (hold)
    return refuseTool(
      hold.error.code ?? "stripe_unavailable",
      `No reconcile candidates were read: ${hold.error.message}`,
      { retryable: true },
    )
  const now = Date.now()
  const since = now - WINDOW_DAYS * DAY
  // Invoices and refunds invoicing holds parked: its retry sweep re-drives them, not this job.
  const waiting = new Set(
    Array.isArray(params?.waiting)
      ? params.waiting.filter((x): x is string => typeof x === "string")
      : [],
  )

  // Invoicing decides each finalized invoice once: a document (linked), or Stripe's own invoice
  // stands (issuer recorded). Only the undecided ones are candidates, and a zero total never is.
  const missing = await newestWhere(
    ctx,
    "stripe_invoices",
    {
      liaison_document_id: null,
      issuer: { in: ["liaison", "undecided"] },
      status: { in: ["open", "paid"] },
    },
    "finalized_at",
    since,
    MAX_INVOICES,
    (r) => minor(r.total_minor) !== "0" && !waiting.has(String(r.stripe_id)),
  )
  const invoices: Obj[] = []
  let unread = 0
  for (const r of missing) {
    try {
      const obj = await stripeFetch<Obj>(
        ctx,
        `/v1/invoices/${encodeURIComponent(String(r.stripe_id))}`,
        {},
      )
      invoices.push(
        await invoiceEventPayload(ctx, r, obj, newTally(), new Date(now).toISOString(), false),
      )
    } catch {
      // Read again on the next run.
      unread++
    }
  }
  const paidRows = await newestWhere(
    ctx,
    "stripe_invoices",
    { status: "paid" },
    "paid_at",
    now - PAID_DAYS * DAY,
    MAX_PAID,
    (r) => typeof r.liaison_document_id === "string" && r.liaison_document_id !== "",
  )
  for (const r of paidRows) {
    invoices.push({
      stripe_invoice_id: r.stripe_id,
      status: "paid",
      paid_at: iso(r.paid_at),
      total_minor: minor(r.total_minor),
      currency: r.currency,
    })
  }

  const refundRows = await newestWhere(
    ctx,
    "stripe_refunds",
    { status: "succeeded", liaison_document_id: null, liaison_skipped: null },
    "created_at_stripe",
    since,
    MAX_REFUNDS,
    (r) => !waiting.has(String(r.stripe_id)) && !!r.payment_id,
  )
  const refunds: Obj[] = []
  const paymentByCharge = new Map<string, { invoice: string | null; charged_at: string | null }>()
  for (const r of refundRows) {
    const chargeId = String(r.payment_id)
    if (!paymentByCharge.has(chargeId)) {
      const [p] = (await ctx.db.findMany("stripe_payments", {
        where: { stripe_id: chargeId },
        limit: 1,
      })) as Obj[]
      paymentByCharge.set(chargeId, {
        invoice: typeof p?.invoice_id === "string" && p.invoice_id ? p.invoice_id : null,
        charged_at: chargedAt(p),
      })
    }
    const payment = paymentByCharge.get(chargeId)
    const invoiceId = payment?.invoice ?? null
    refunds.push({
      refund_id: String(r.stripe_id),
      charge_id: chargeId,
      invoice_id: invoiceId,
      document_ref: stripeDocumentRef({ id: chargeId, invoice: invoiceId }),
      amount_minor: minor(r.amount_minor),
      currency: r.currency ?? null,
      status: "succeeded",
      charged_at: payment?.charged_at ?? null,
    })
  }
  return {
    invoices,
    refunds,
    summary: `${missing.length} Stripe invoice(s) with no Liaison document${unread ? ` (${unread} not read from Stripe this time)` : ""}, ${paidRows.length} paid invoice(s) to check, ${refunds.length} succeeded refund(s) with no credit note recorded.`,
  }
}
