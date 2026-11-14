// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Stripe invoice life after finalization, in mode A:
//   paid: the Liaison invoice is marked paid on the charge's date, its PDF re-rendered, and the
//         collection is recorded once; paid before the finalized event was handled: issue first.
//   payment failed: the document never changes; attention only when a person can act (no next
//         attempt, or an expired card); otherwise Stripe is still retrying.
//   voided, uncollectible: attention only, no document change.
import { reportCollection } from "../einvoicing/collection"
import type { EinvCtx } from "../einvoicing/transmit"
import { civilDateOf } from "../issue-date"
import { findIssuerProfile } from "../mutations/db-helpers"
import { ensureDocumentPdf } from "../mutations/pdf"
import {
  documentByRef,
  type FinalizedResult,
  onStripeInvoiceFinalized,
  payloadOf,
  type StripeCtx,
  type StripeInvoicePayload,
  stripeRef,
} from "./stripe-invoice-finalized"

type Row = Record<string, unknown>

export type PaidResult =
  | { status: "ok"; document_id: string; paid_at: string }
  | { status: "skipped"; reason: string; document_id?: string }
  | { status: "issue_first"; outcome: FinalizedResult }

export async function onStripeInvoicePaid(event: unknown, ctx: StripeCtx): Promise<PaidResult> {
  const p = payloadOf<StripeInvoicePayload>(event)
  if (!p?.stripe_invoice_id) return { status: "skipped", reason: "invalid_payload" }
  let doc = await documentByRef(ctx, stripeRef(p.stripe_invoice_id))
  if (!doc) {
    // Paid before its finalized event was handled: issue first (born paid), then nothing to mark.
    const outcome = await onStripeInvoiceFinalized({ ...p, status: "paid" }, ctx)
    if (outcome.status !== "ok") return { status: "issue_first", outcome }
    doc = (await ctx.db.findOne("documents", outcome.document_id)) as Row | null
    if (!doc) return { status: "issue_first", outcome }
    await recordCollection(ctx, doc)
    return { status: "ok", document_id: String(doc.id), paid_at: String(doc.paid_at ?? "") }
  }
  if (doc.payment_status === "paid") {
    // A collection report that failed is tried again on the next delivery or safety-job run.
    if (doc.collection_state === "failed") await reportPaid(ctx, doc)
    return { status: "skipped", reason: "already_paid", document_id: String(doc.id) }
  }
  const issuer = await findIssuerProfile(ctx.db, String(doc.issuer_profile_id ?? ""))
  const paid = await civilDateOf(ctx, issuer ?? {}, p.paid_at ?? null)
  if (!paid.ok)
    return {
      status: "skipped",
      reason: paid.error.error.code ?? "timezone",
      document_id: String(doc.id),
    }
  const log = Array.isArray(doc.lifecycle_log) ? (doc.lifecycle_log as Row[]) : []
  await ctx.db.update("documents", String(doc.id), {
    status: doc.status === "issued" ? "paid" : doc.status,
    payment_status: "paid",
    paid_at: paid.date,
    lifecycle_log: [
      ...log,
      {
        event: "marked_paid",
        actor: "system",
        ts: new Date().toISOString(),
        paid_date: paid.date,
        payment_note: `Stripe ${p.charge_id ?? p.stripe_invoice_id}`,
      },
    ],
  })
  await ctx.emit({
    entity: "document",
    action: "paid",
    entityId: String(doc.id),
    data: {
      document_id: String(doc.id),
      type: doc.type,
      number: doc.number,
      paid_at: paid.date,
      payment_status: "paid",
    },
  })
  await ensureDocumentPdf(ctx, String(doc.id), { force: true, link: false })
  await recordCollection(ctx, {
    ...doc,
    lifecycle_log:
      ((await ctx.db.findOne("documents", String(doc.id))) as Row | null)?.lifecycle_log ?? log,
  })
  return { status: "ok", document_id: String(doc.id), paid_at: paid.date }
}

/** The collection of a paid Stripe invoice is reported once: a lifecycle mark the e-invoicing report reads. */
async function recordCollection(ctx: StripeCtx, doc: Row): Promise<void> {
  const log = Array.isArray(doc.lifecycle_log) ? (doc.lifecycle_log as Row[]) : []
  if (log.some((e) => e.event === "collection_due")) return
  await ctx.db.update("documents", String(doc.id), {
    lifecycle_log: [
      ...log,
      { event: "collection_due", actor: "system", ts: new Date().toISOString(), source: "stripe" },
    ],
  })
  await reportPaid(ctx, doc)
}

/** Where VAT is due on receipt, the e-invoicing platform is told of the payment
 *  (einvoicing/collection.ts); idempotent per document and payment. */
async function reportPaid(ctx: StripeCtx, doc: Row): Promise<void> {
  const einv = ctx as unknown as EinvCtx
  if (!einv.contracts) return
  const paidOn = String(
    ((await ctx.db.findOne("documents", String(doc.id))) as Row | null)?.paid_at ??
      doc.paid_at ??
      "",
  ).slice(0, 10)
  try {
    await reportCollection(einv, String(doc.id), {
      kind: "paid",
      amount_minor: BigInt(String(doc.grand_total_minor ?? "0")),
      date: paidOn,
      ref: "stripe:paid",
    })
  } catch {
    // The payment stands; the collection shows as not reported and the document panel says so.
  }
}

export type FailedResult =
  | { status: "attention"; reason: string }
  | { status: "in_retries" }
  | { status: "skipped"; reason: string }

/** A failed card payment: the document stays as it is; a person is told only when they can act. */
export async function onStripeInvoicePaymentFailed(
  event: unknown,
  ctx: StripeCtx,
): Promise<FailedResult> {
  const p = payloadOf<StripeInvoicePayload>(event)
  if (!p?.stripe_invoice_id) return { status: "skipped", reason: "invalid_payload" }
  const expired = p.failure_code === "expired_card"
  const lastTry = !p.next_payment_attempt
  if (!expired && !lastTry) return { status: "in_retries" }
  const reason = expired ? "the card has expired" : "Stripe will not try again"
  await ctx.emit({
    entity: "stripe_invoice",
    action: "payment_failed",
    entityId: p.stripe_invoice_id,
    data: {
      stripe_invoice_id: p.stripe_invoice_id,
      number: p.number ?? p.stripe_invoice_id,
      reason,
      resolved: false,
    },
  })
  return { status: "attention", reason }
}

/** Voided or marked uncollectible in Stripe: a person is told; no Liaison document changes. */
export async function onStripeInvoiceClosed(
  event: unknown,
  ctx: StripeCtx,
  how: "voided" | "uncollectible",
) {
  const p = payloadOf<StripeInvoicePayload>(event)
  if (!p?.stripe_invoice_id) return { status: "skipped" as const, reason: "invalid_payload" }
  const doc = await documentByRef(ctx, stripeRef(p.stripe_invoice_id))
  await ctx.emit({
    entity: "stripe_invoice",
    action: how,
    entityId: p.stripe_invoice_id,
    data: {
      stripe_invoice_id: p.stripe_invoice_id,
      number: (doc?.number as string | undefined) ?? p.number ?? p.stripe_invoice_id,
      resolved: false,
    },
  })
  return { status: "attention" as const, reason: how }
}
