// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scheduled safety job for card payments on Stripe (every 10 minutes), the Stripe twin of
// `reconcile-shopify-payments`: it tightens payment status toward what Stripe already reports,
// never touches money, and never issues by itself. What an event missed (invoicing was off, an
// event failed for good) is handed to the SAME idempotent handler the event would have reached:
//   - a Stripe invoice issued by Liaison, finalized after the connection, with no document:
//     the finalized handler (its unique key stops a second document);
//   - a paid Stripe invoice whose document is unpaid: the paid handler;
//   - a succeeded refund in mode A with no credit note, whose payment's invoice has a document:
//     the refund handler (its unique key stops a second credit note).
// It also lists, once, the Stripe invoices that waited while nobody had decided who issues, as
// soon as a person picked Liaison: they issue only on a person's click. A refund still waiting for
// its invoice after a day raises one Home item.
import { resolveOpenParks } from "../deferred"
import { isoOf, issuerAt, streamRows } from "../streams"
import {
  documentByRef,
  onStripeInvoiceFinalized,
  STRIPE_UNDECIDED_PARK,
  type StripeCtx,
  type StripeInvoicePayload,
  stripeRef,
} from "./stripe-invoice-finalized"
import { onStripeInvoicePaid } from "./stripe-invoice-paid"
import {
  flagLongRefundWaits,
  onStripeRefundCreated,
  type StripeRefundPayload,
} from "./stripe-refund-created"

type Row = Record<string, unknown>

export interface ReconcileCandidates {
  invoices?: StripeInvoicePayload[]
  refunds?: Array<
    StripeRefundPayload & { refund_id: string; amount_minor: string | number; status: string }
  >
}

export interface StripeReconcileResult {
  status: "ok"
  issued: number
  marked_paid: number
  credit_notes: number
  listed_undecided: number
  message: string
}

const OPEN_PARK = ["awaiting_config", "awaiting_data", "awaiting_dependency"]
const WAITING_MAX = 500

/** Stripe invoices and refunds held by an open park: the retry sweep re-drives them, so the
 *  safety job's places go to what no handler holds. */
async function waitingIds(ctx: StripeCtx): Promise<string[]> {
  const rows = (await ctx.db.findMany("deferred_events", {
    where: { status: { in: OPEN_PARK } },
    limit: 2000,
  })) as Row[]
  const ids = new Set<string>()
  for (const r of rows) {
    const m = /^stripe:((?:in|re)_[A-Za-z0-9]+)$/.exec(String(r.event_id ?? ""))
    if (m?.[1]) ids.add(m[1])
    if (ids.size >= WAITING_MAX) break
  }
  return [...ids]
}

async function candidates(ctx: StripeCtx): Promise<ReconcileCandidates | null> {
  if (!ctx.executeTool) return null
  try {
    const env = await ctx.executeTool("stripe:reconcile_candidates", {
      waiting: await waitingIds(ctx),
    })
    return env.status === "completed" ? ((env.result ?? {}) as ReconcileCandidates) : null
  } catch {
    return null
  }
}

/** Parks of invoices finalized while undecided, listed once a person has picked Liaison. */
async function listUndecided(ctx: StripeCtx): Promise<number> {
  const streams = (await streamRows(ctx)).filter((r) => r.stripe_connected === true)
  if (!streams.some((s) => s.issuer === "liaison")) return 0
  const parks = (await ctx.db.findMany("deferred_events", {
    where: { reason: "issuer_undecided" },
    limit: 200,
  })) as Row[]
  const fresh = parks.filter((r) => {
    const b = (r.blocked_on ?? {}) as Row
    return r.status !== "resolved" && b.kind === STRIPE_UNDECIDED_PARK && b.listed !== true
  })
  const stillLiaison = fresh.filter((r) => {
    const p = (r.event_payload_json ?? {}) as StripeInvoicePayload
    const s = streams.find(
      (x) =>
        x.issuer_profile_id === ((r.blocked_on as Row).issuer_profile_id ?? x.issuer_profile_id),
    )
    return s
      ? issuerAt(s, isoOf(p.finalized_at) ?? "") === "liaison" || s.issuer === "liaison"
      : false
  })
  if (stillLiaison.length === 0) return 0
  for (const r of stillLiaison) {
    await ctx.db.update("deferred_events", String(r.id), {
      blocked_on: { ...((r.blocked_on ?? {}) as Row), listed: true },
    })
  }
  await ctx.emit({
    entity: "stripe_invoice",
    action: "undecided_listed",
    entityId: String(stillLiaison[0]?.id),
    data: {
      count: stillLiaison.length,
      invoices: stillLiaison
        .map((r) => String(((r.event_payload_json ?? {}) as Row).stripe_invoice_id ?? ""))
        .join(", "),
      resolved: false,
    },
  })
  return stillLiaison.length
}

export async function reconcileStripePayments(ctx: StripeCtx): Promise<StripeReconcileResult> {
  let issued = 0
  let paid = 0
  let notes = 0
  const listed = await listUndecided(ctx)
  await flagLongRefundWaits(ctx)
  const found = await candidates(ctx)
  for (const inv of found?.invoices ?? []) {
    const doc = await documentByRef(ctx, stripeRef(inv.stripe_invoice_id))
    if (!doc) {
      // Re-emitted to its own handler: the decision to issue is the handler's, never this job's.
      const r = await onStripeInvoiceFinalized(inv, ctx)
      if (r.status === "ok") issued += 1
      continue
    }
    if (
      inv.status === "paid" &&
      (doc.payment_status !== "paid" || doc.collection_state === "failed")
    ) {
      const r = await onStripeInvoicePaid(inv, ctx)
      if (r.status === "ok") paid += 1
    } else if (doc.payment_status === "paid") {
      await resolveOpenParks(ctx, stripeRef(inv.stripe_invoice_id), "already_issued")
    }
  }
  for (const ref of found?.refunds ?? []) {
    const r = await onStripeRefundCreated(
      {
        charge_id: ref.charge_id,
        invoice_id: ref.invoice_id ?? null,
        charged_at: ref.charged_at ?? null,
        refunds: [{ id: ref.refund_id, amount_minor: ref.amount_minor, status: ref.status }],
      },
      ctx,
    )
    notes += r.refunds.filter((x) => x.outcome === "issued").length
  }
  return {
    status: "ok",
    issued,
    marked_paid: paid,
    credit_notes: notes,
    listed_undecided: listed,
    message: found
      ? `Stripe reconciled: ${issued} missing invoice(s) issued by their handler, ${paid} marked paid, ${notes} missing credit note(s) issued.`
      : "Stripe could not be read; nothing changed. The next run tries again.",
  }
}

export const reconcileStripePaymentsJobHandler = (_payload: unknown, ctx: StripeCtx) =>
  reconcileStripePayments(ctx)
