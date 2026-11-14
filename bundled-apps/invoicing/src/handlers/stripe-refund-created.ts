// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Stripe refund in mode A becomes one Liaison credit note, only once Stripe says the refund
// succeeded, keyed `external_ref = stripe:<re_id>` (unique), whichever arrives first: the refund
// tool's result, `charge.refunded`, `charge.refund.updated`, or the safety job's re-run.
//
// Each refund is handled by its own id and its own amount, never by the charge's cumulative
// refunded amount: two partial refunds make two credit notes that sum to what was refunded.
//   pending: nothing yet (its update comes later);
//   failed or canceled, no credit note: none is made, and one attention item says so;
//   failed after its credit note was issued: one attention item names that credit note;
//   succeeded: a credit note citing the invoice, CN- series, capped at what remains, split over the
//   invoice's VAT rates in proportion (largest remainder; a short minor unit goes on one 0-tax
//   "Rounding adjustment" line, so the parts sum exactly). An e-invoicing refusal parks it with its
//   own arguments, re-issued alone by the retry sweep.
// Mode B (Stripe issues) and an undecided stream: no credit note. A charge made while Stripe issued
// (before a switch, or before Stripe was connected) has no Liaison invoice to credit: the refund is
// recorded as Stripe's. One still waiting for its invoice after a day raises one Home item (the
// safety job), closed once the refund gets its credit note or is skipped.
import { park, resolveOpenParks } from "../deferred"
import { reportCollection } from "../einvoicing/collection"
import { autoCreditNoteCounterparty } from "../einvoicing/parked-credit-note"
import type { EinvCtx } from "../einvoicing/transmit"
import type { LineKind } from "../issue"
import { creditedTotalMinor, creditNoteCreateAndIssue } from "../mutations"
import { toBigInt } from "../mutations/shared"
import { cardStreamIssuer, isoOf, stripeDocumentRef } from "../streams"
import { buildAdjustmentReversalItems } from "./shopify-refund-created"
import {
  cardStreamFor,
  documentByRef,
  payloadOf,
  type StripeCtx,
  stripeRef,
} from "./stripe-invoice-finalized"
import { invoiceLinkedTo } from "./stripe-payment-unmatched"

type Row = Record<string, unknown>

export interface StripeRefund {
  id: string
  amount_minor: string | number
  status: string
  currency?: string | null
}

export interface StripeRefundPayload {
  refund_id?: string
  charge_id: string
  /** The charge's invoice, when it has one: the document is keyed by it. */
  invoice_id?: string | null
  amount_minor?: string | number
  currency?: string | null
  status?: string
  /** Every refund of the charge as Stripe lists it (`GET /v1/refunds?charge=`), by id. */
  refunds?: StripeRefund[]
  /** When the charge was made: who issued its invoice then. */
  charged_at?: string | null
}

export const STRIPE_CREDIT_NOTE_PARK = "stripe_credit_note"

export interface ParkedStripeCreditNote {
  kind: typeof STRIPE_CREDIT_NOTE_PARK
  refund_id: string
  charge_id: string
  invoice_id: string | null
  amount_minor: string
  charged_at?: string | null
}

/** The once-only marker of a refund's waiting item, and the park kind the retry sweep leaves alone. */
export const STRIPE_REFUND_WAIT_PARK = "stripe_refund_waiting"
const waitKey = (refundId: string) => `${stripeRef(refundId)}:waiting`

export type RefundOutcome =
  | { refund_id: string; outcome: "issued"; document_id: string; number: string }
  | { refund_id: string; outcome: "exists"; document_id: string }
  | {
      refund_id: string
      outcome: "pending" | "mode_b" | "no_invoice" | "parked" | "nothing_left" | "issued_by_stripe"
    }
  | { refund_id: string; outcome: "failed_attention"; credit_note_id: string | null }

const AUTO_APPROVAL = {
  approvalRequestId: "auto:stripe-refund",
  approvalDeciderId: "system",
  toolName: "invoicing:credit_note_create_and_issue",
}

/** The charge's refunds, by id: the payload's list, else the Stripe app's, else the one refund. */
async function refundsOf(ctx: StripeCtx, p: StripeRefundPayload): Promise<StripeRefund[]> {
  if (Array.isArray(p.refunds) && p.refunds.length > 0) return p.refunds
  if (ctx.executeTool) {
    try {
      const env = await ctx.executeTool("stripe:refunds_for_charge", { chargeId: p.charge_id })
      if (env.status === "completed") {
        const list = (env.result as { refunds?: StripeRefund[] } | null)?.refunds
        if (Array.isArray(list) && list.length > 0) return list
      }
    } catch {
      // Fall back on the refund this event names.
    }
  }
  return p.refund_id
    ? [
        {
          id: p.refund_id,
          amount_minor: p.amount_minor ?? 0,
          status: p.status ?? "pending",
          currency: p.currency ?? null,
        },
      ]
    : []
}

export async function onStripeRefundCreated(
  event: unknown,
  ctx: StripeCtx,
): Promise<{ status: "ok" | "skipped"; reason?: string; refunds: RefundOutcome[] }> {
  const p = payloadOf<StripeRefundPayload>(event)
  if (!p || typeof p.charge_id !== "string" || !p.charge_id)
    return { status: "skipped", reason: "invalid_payload", refunds: [] }
  if ((await cardStreamIssuer(ctx)).issuer !== "liaison") {
    const ids =
      Array.isArray(p.refunds) && p.refunds.length > 0
        ? p.refunds.map((r) => r.id)
        : p.refund_id
          ? [p.refund_id]
          : []
    for (const id of ids) {
      await linkRefund(ctx, id, { skipped: "issued_by_stripe" })
      await closeWait(ctx, id, "issued_by_stripe")
    }
    return { status: "skipped", reason: "mode_b", refunds: [] }
  }
  const invoiceRef = stripeDocumentRef({ id: p.charge_id, invoice: p.invoice_id ?? null })
  const out: RefundOutcome[] = []
  for (const r of await refundsOf(ctx, p)) {
    const one = await handleOne(ctx, p, invoiceRef, r)
    // Recorded on the Stripe refund once decided, so the safety job walks past it.
    if (one.outcome === "issued" || one.outcome === "exists") {
      await linkRefund(ctx, r.id, { documentId: one.document_id })
      await closeWait(ctx, r.id, "issued")
    } else if (one.outcome === "nothing_left" || one.outcome === "issued_by_stripe") {
      await linkRefund(ctx, r.id, { skipped: one.outcome })
      await resolveOpenParks(ctx, stripeRef(r.id), one.outcome)
      await closeWait(ctx, r.id, one.outcome)
    }
    out.push(one)
  }
  return { status: "ok", refunds: out }
}

/** Close a refund's waiting item, if it raised one. */
async function closeWait(ctx: StripeCtx, refundId: string, reason: string): Promise<void> {
  const { resolved } = await resolveOpenParks(ctx, waitKey(refundId), reason)
  if (resolved > 0) {
    await ctx.emit({
      entity: "stripe_refund",
      action: "waiting",
      entityId: refundId,
      data: { refund_id: refundId, resolved: true },
    })
  }
}

/** Whether Stripe issued the invoices of card payments when this charge was made (or Stripe was
 *  not connected yet): then no Liaison invoice exists to credit. Unknown date: not known. */
async function issuedByStripeAt(
  ctx: StripeCtx,
  chargedAt: string | null | undefined,
): Promise<boolean> {
  const at = isoOf(chargedAt)
  if (!at) return false
  const stream = await cardStreamFor(ctx, at)
  if (!stream) return false
  if (stream.issuer === "stripe") return true
  const connectedAt = isoOf(stream.row.created_at)
  return !!connectedAt && at < connectedAt
}

/** The safety job's pass: each refund waiting longer than a day for its invoice raises one Home
 *  item to the people who issue documents. The marker park makes it once per refund. */
export const REFUND_WAIT_MS = 24 * 60 * 60 * 1000

export async function flagLongRefundWaits(ctx: StripeCtx, now = Date.now()): Promise<number> {
  const rows = (await ctx.db.findMany("deferred_events", {
    where: {
      reason: "invoice_not_issued",
      status: { in: ["awaiting_config", "awaiting_data", "awaiting_dependency"] },
    },
    limit: 500,
  })) as Row[]
  let raised = 0
  for (const row of rows) {
    const b = (row.blocked_on ?? {}) as Row
    if (b.kind !== STRIPE_CREDIT_NOTE_PARK || typeof b.refund_id !== "string") continue
    const since = isoOf(row.created_at)
    if (!since || now - Date.parse(since) < REFUND_WAIT_MS) continue
    const p = (row.event_payload_json ?? {}) as Partial<ParkedStripeCreditNote>
    const def = await park(
      { db: ctx.db },
      {
        event_id: waitKey(b.refund_id),
        event_payload_json: { kind: STRIPE_REFUND_WAIT_PARK, refund_id: b.refund_id },
        status: "awaiting_dependency",
        reason: "refund_waiting",
        blocked_on: { kind: STRIPE_REFUND_WAIT_PARK, refund_id: b.refund_id },
      },
    )
    if (!def.created) continue
    raised += 1
    await ctx.emit({
      entity: "stripe_refund",
      action: "waiting",
      entityId: b.refund_id,
      data: {
        deferred_id: def.id,
        refund_id: b.refund_id,
        charge_id: String(p.charge_id ?? ""),
        resolved: false,
      },
    })
  }
  return raised
}

/** Tell the Stripe app which credit note a refund became, or why none follows. Best effort. */
async function linkRefund(
  ctx: StripeCtx,
  stripeRefundId: string,
  link: { documentId: string } | { skipped: "issued_by_stripe" | "nothing_left" },
): Promise<void> {
  if (!ctx.executeTool) return
  try {
    await ctx.executeTool("stripe:refund_document_link", { stripeRefundId, ...link })
  } catch {
    // The safety job finds it again; the credit note itself is what counts.
  }
}

async function handleOne(
  ctx: StripeCtx,
  p: StripeRefundPayload,
  invoiceRef: string,
  r: StripeRefund,
): Promise<RefundOutcome> {
  const ref = stripeRef(r.id)
  const note = await documentByRef(ctx, ref)
  const status = String(r.status ?? "")
  if (status === "failed" || status === "canceled") {
    return failed(ctx, p, r, note)
  }
  if (note) return { refund_id: r.id, outcome: "exists", document_id: String(note.id) }
  if (status !== "succeeded") return { refund_id: r.id, outcome: "pending" }
  // The invoice the charge became, or the one a person linked it to by hand.
  const original =
    (await documentByRef(ctx, invoiceRef)) ?? (await invoiceLinkedTo(ctx, p.charge_id))
  if (!original) {
    // Stripe issued the charge's invoice: there is nothing of Liaison's to credit.
    if (await issuedByStripeAt(ctx, p.charged_at))
      return { refund_id: r.id, outcome: "issued_by_stripe" }
    // The invoice is not issued yet (parked, or its event still on the way): wait for it.
    await park(
      { db: ctx.db },
      {
        event_id: ref,
        event_payload_json: parked(p, r),
        status: "awaiting_dependency",
        reason: "invoice_not_issued",
        blocked_on: { kind: STRIPE_CREDIT_NOTE_PARK, invoice_ref: invoiceRef, refund_id: r.id },
      },
    )
    return { refund_id: r.id, outcome: "no_invoice" }
  }
  return issueFor(ctx, p, r, original)
}

function parked(
  p: StripeRefundPayload,
  r: StripeRefund,
): ParkedStripeCreditNote & { refunds: StripeRefund[] } {
  return {
    kind: STRIPE_CREDIT_NOTE_PARK,
    refund_id: r.id,
    charge_id: p.charge_id,
    invoice_id: p.invoice_id ?? null,
    amount_minor: String(r.amount_minor),
    charged_at: p.charged_at ?? null,
    refunds: [r],
  }
}

async function failed(
  ctx: StripeCtx,
  p: StripeRefundPayload,
  r: StripeRefund,
  note: Row | null,
): Promise<RefundOutcome> {
  const key = `${stripeRef(r.id)}:failed`
  // One attention item per failed refund: the park below is its once-only marker.
  const def = await park(
    { db: ctx.db },
    {
      event_id: key,
      event_payload_json: { kind: "stripe_refund_failed", refund_id: r.id, charge_id: p.charge_id },
      status: "awaiting_data",
      reason: note ? "refund_failed_after_credit_note" : "refund_failed",
      blocked_on: {
        kind: "stripe_refund_failed",
        refund_id: r.id,
        credit_note_id: note ? String(note.id) : null,
      },
    },
  )
  if (def.created) {
    await ctx.emit({
      entity: "stripe_refund",
      action: "failed",
      entityId: r.id,
      data: {
        deferred_id: def.id,
        refund_id: r.id,
        charge_id: p.charge_id,
        credit_note: note ? String(note.number ?? note.id) : "none",
        resolved: false,
      },
    })
  }
  return {
    refund_id: r.id,
    outcome: "failed_attention",
    credit_note_id: note ? String(note.id) : null,
  }
}

async function issueFor(
  ctx: StripeCtx,
  p: StripeRefundPayload,
  r: StripeRefund,
  original: Row,
): Promise<RefundOutcome> {
  const fresh = ((await ctx.db.findOne("documents", String(original.id))) as Row | null) ?? original
  const total = toBigInt(fresh.grand_total_minor)
  const lifecycle = (fresh.lifecycle_log as Row[] | undefined) ?? []
  const credited = await creditedTotalMinor(ctx.db, {
    id: String(fresh.id),
    lifecycle_log: lifecycle,
  })
  const remaining = (total < 0n ? -total : total) - credited
  let amount = toBigInt(r.amount_minor)
  if (remaining <= 0n) return { refund_id: r.id, outcome: "nothing_left" }
  if (amount > remaining) amount = remaining
  const lines = (await ctx.db.findMany("document_lines", {
    where: { document_id: String(fresh.id) },
  })) as Row[]
  const items = buildAdjustmentReversalItems(
    lines.map((l) => ({
      unit_price_minor: toBigInt(l.unit_price_minor),
      quantity: (l.quantity as string | number | undefined) ?? "1",
      tax_rate_bp: Number(l.tax_rate_bp ?? 0),
      line_kind: ((l.line_kind as LineKind | undefined) ?? "service") as LineKind,
    })),
    amount,
    (fresh.scope as string | null) ?? null,
  )
  const res = await creditNoteCreateAndIssue(
    { ...ctx, approval: AUTO_APPROVAL },
    {
      issuer_profile_id: (fresh.issuer_profile_id as string | null) ?? null,
      counterparty: autoCreditNoteCounterparty(fresh),
      currency: String(fresh.currency ?? "EUR"),
      items: items as never,
      original_document_id: String(fresh.id),
      reason: `Stripe refund ${r.id}`,
    },
    { external_ref: stripeRef(r.id), einvoice_send: "batch" },
  )
  if (res.status === "completed") {
    await resolveOpenParks(ctx, stripeRef(r.id), "issued")
    await reportRefund(ctx, String(fresh.id), res.document_id, amount, r.id)
    return { refund_id: r.id, outcome: "issued", document_id: res.document_id, number: res.number }
  }
  // Refused (an e-invoicing gate, an incomplete recipient): parked with its arguments, never lost.
  const code = res.status === "error" ? String(res.error.code ?? "error") : res.status
  const def = await park(
    { db: ctx.db },
    {
      event_id: stripeRef(r.id),
      event_payload_json: parked(p, { ...r, amount_minor: amount.toString() }),
      status: "awaiting_data",
      reason: code,
      blocked_on: {
        kind: STRIPE_CREDIT_NOTE_PARK,
        refund_id: r.id,
        document_id: String(fresh.id),
        contact_id: (fresh.counterparty_contact_id as string | null) ?? null,
        code,
      },
    },
  )
  if (def.created) {
    await ctx.emit({
      entity: "deferred",
      action: "credit_note_refused",
      entityId: def.id,
      data: {
        deferred_id: def.id,
        order_label: String(fresh.number ?? fresh.id),
        document_id: String(fresh.id),
        code,
        message: res.status === "error" ? res.error.message : null,
        resolved: false,
      },
    })
  }
  return { refund_id: r.id, outcome: "parked" }
}

/** Where VAT is due on receipt, the money given back is reported against the original invoice
 *  (a negative collection), dated as its credit note. Idempotent per refund; a failure leaves the
 *  original's collection marked failed for the document panel. */
async function reportRefund(
  ctx: StripeCtx,
  originalId: string,
  creditNoteId: string,
  amount: bigint,
  refundId: string,
): Promise<void> {
  const einv = ctx as unknown as EinvCtx
  if (!einv.contracts) return
  const note = (await ctx.db.findOne("documents", creditNoteId)) as Row | null
  const date = String(note?.issued_at ?? "").slice(0, 10)
  if (!date) return
  try {
    await reportCollection(einv, originalId, {
      kind: "refund",
      amount_minor: amount,
      date,
      ref: stripeRef(refundId),
    })
  } catch {
    // The credit note stands; the collection shows as not reported and the document panel says so.
  }
}

/** The retry sweep's re-drive of a parked Stripe credit note: the same idempotent path. */
export async function retryParkedStripeCreditNote(
  ctx: StripeCtx,
  payload: unknown,
): Promise<{ status: "ok" } | { status: "still_blocked"; reason: string }> {
  const p = payload as ParkedStripeCreditNote & { refunds?: StripeRefund[] }
  if (!p || p.kind !== STRIPE_CREDIT_NOTE_PARK)
    return { status: "still_blocked", reason: "invalid_parked_credit_note" }
  const res = await onStripeRefundCreated(
    {
      charge_id: p.charge_id,
      invoice_id: p.invoice_id,
      charged_at: p.charged_at ?? null,
      refunds: p.refunds ?? [
        { id: p.refund_id, amount_minor: p.amount_minor, status: "succeeded" },
      ],
    },
    ctx,
  )
  const one = res.refunds[0]
  if (
    one &&
    (one.outcome === "issued" ||
      one.outcome === "exists" ||
      one.outcome === "nothing_left" ||
      one.outcome === "issued_by_stripe")
  ) {
    return { status: "ok" }
  }
  return { status: "still_blocked", reason: one?.outcome ?? res.reason ?? "unknown" }
}
