// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: documents.mark_paid and documents.record_refund.

import { readMinorAmount } from "@liaison/app-sdk"
import { reportCollection } from "../einvoicing/collection"
import type { EinvCtx } from "../einvoicing/transmit"
import { civilDateOf } from "../issue-date"
import { transition } from "../state"
import { findDocumentSummary, findIssuerProfile, sumPriorRefundedMinor } from "./db-helpers"
import { ensureDocumentPdf } from "./pdf"
import {
  type DocumentRowSummary,
  type DocumentType,
  type ErrorEnvelope,
  invalidAmountError,
  type MutationResult,
  type MutationsCtx,
  type PreflightResult,
  toPreflightResult,
} from "./shared"

// ── documents.mark_paid ───────────────────────────────────────────────────

/**
 * Report a payment or refund to the e-invoicing platform where VAT is due on receipt
 * (einvoicing/collection.ts). Best effort: the payment is already recorded, and a failure is
 * stored on the document's collection state, never thrown.
 */
async function reportCollectionAfter(
  ctx: MutationsCtx,
  documentId: string,
  event: { kind: "paid" | "refund"; amount_minor: bigint; date: string; ref: string },
): Promise<void> {
  const einv = ctx as unknown as EinvCtx
  if (!einv.contracts) return
  try {
    await reportCollection(einv, documentId, event)
  } catch {
    // Left as it was: the document panel shows no collection, and the next payment event retries.
  }
}

/**
 * Read-only validation shared by `documentsMarkPaid` and its stage-time preflight export: the
 * document resolves and its current status allows a mark-paid. ONE copy, called from both sides,
 * so the staged refusal and the executed refusal can never drift apart.
 */
async function preflightMarkPaidParams(
  ctx: MutationsCtx,
  input: { document_id: string; paid_date?: string },
): Promise<
  | { ok: true; doc: DocumentRowSummary; nextStatus: string; paidAt: string }
  | { ok: false; error: ErrorEnvelope }
> {
  const doc = await findDocumentSummary(ctx.db, input.document_id)
  if (!doc) {
    return {
      ok: false,
      error: {
        status: "error",
        error: { code: "not_found", message: `document ${input.document_id} not found` },
      },
    }
  }
  const status = doc.status ?? "draft"
  const trans = transition({ type: doc.type as DocumentType, status }, "mark_paid")
  if (trans.status !== "ok") {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "invalid_transition",
          message: `cannot mark_paid ${doc.type} in status=${status}`,
        },
      },
    }
  }
  if (input.paid_date) return { ok: true, doc, nextStatus: trans.next, paidAt: input.paid_date }
  // Nobody stated the date: today, in the issuer's time zone, like the issue date beside it.
  const issuer = await findIssuerProfile(ctx.db, doc.issuer_profile_id)
  const today = await civilDateOf(ctx, issuer ?? {})
  if (!today.ok) return today
  return { ok: true, doc, nextStatus: trans.next, paidAt: today.date }
}

/**
 * STAGE-TIME preflight for the gated `documents_mark_paid` tool (manifest `preflight`). A gated
 * call must not be parked for a human when the data it needs is missing: an id that resolves to
 * nothing, or a document whose status cannot be marked paid, is refused here, before the approval
 * request exists.
 */
export async function documentsMarkPaidPreflight(
  ctx: MutationsCtx,
  input: { document_id: string; paid_date?: string },
): Promise<PreflightResult> {
  return toPreflightResult(await preflightMarkPaidParams(ctx, input))
}

export async function documentsMarkPaid(
  ctx: MutationsCtx,
  input: { document_id: string; paid_date?: string; payment_note?: string },
): Promise<MutationResult<{ document_id: string }>> {
  // The status guard below ALSO runs at stage time (the preflight export above shares this exact
  // code), but it stays here: a document can be paid, credited or refunded between staging and
  // approval, so the executed call re-checks rather than trusts.
  const pre = await preflightMarkPaidParams(ctx, input)
  if (!pre.ok) return pre.error
  const { doc } = pre
  const trans = { next: pre.nextStatus }
  const { paidAt } = pre
  await ctx.db.update("documents", doc.id, {
    status: trans.next,
    payment_status: "paid",
    paid_at: paidAt,
    lifecycle_log: [
      ...doc.lifecycle_log,
      {
        event: "marked_paid",
        actor: await ctx.getUserId(),
        ts: new Date().toISOString(),
        paid_date: input.paid_date ?? null,
        payment_note: input.payment_note ?? null,
      },
    ],
  })
  // Kernel audit trail — mirrors the marked_paid lifecycle_log entry just written above.
  await ctx.emit({
    entity: "document",
    action: "paid",
    entityId: doc.id,
    data: {
      document_id: doc.id,
      type: doc.type,
      number: doc.number,
      status: trans.next,
      currency: doc.currency,
      grand_total_minor: doc.grand_total_minor.toString(),
      paid_at: paidAt,
      payment_status: "paid",
    },
  })
  // Re-render the PDF so it reflects the settled state ("Amount paid" instead of "Total due", no
  // banking box) — the template reads payment_status from the persisted row. Best-effort: a render
  // failure leaves pdf_status="failed" (retryable via documents_retry_pdf) but must NOT fail the
  // mark-paid itself, which is already persisted. `link: false` because this handler just updated
  // the documents row in its open tx: the host's privileged link-write (a separate tx) would
  // deadlock on that row lock (same reasoning as documents_update — see ensureDocumentPdf).
  await reportCollectionAfter(ctx, doc.id, {
    kind: "paid",
    amount_minor: doc.grand_total_minor,
    date: paidAt,
    ref: `paid:${paidAt}`,
  })
  await ensureDocumentPdf(ctx, doc.id, { force: true, link: false })
  return { status: "completed", document_id: doc.id }
}

// ── documents.record_refund ───────────────────────────────────────────────

/**
 * Read-only validation shared by `documentsRecordRefund` and its stage-time preflight export:
 * the document resolves, the amount is positive, the status allows the refund kind, and a partial
 * refund does not push the CUMULATIVE refunded amount past the document total. ONE copy, called
 * from both sides, so the staged refusal and the executed refusal can never drift apart.
 */
async function preflightRecordRefundParams(
  ctx: MutationsCtx,
  input: {
    document_id: string
    refund_amount_minor: bigint
    refund_kind: "full" | "partial"
  },
): Promise<
  | { ok: true; kind: "full"; doc: DocumentRowSummary; nextStatus: string }
  | {
      ok: true
      kind: "partial"
      doc: DocumentRowSummary
      status: string
      cumulativeRefundedMinor: bigint
      fullyRefunded: boolean
    }
  | { ok: false; error: ErrorEnvelope }
> {
  // The amount arrives as JSON, so a NUMBER (an approval payload's 39900), not
  // the bigint the type promises: `0n + 39900` throws "cannot convert bigint to
  // number" inside the sandbox. Read once here, for every comparison below.
  const refundAmount = readMinorAmount(input.refund_amount_minor)
  if (refundAmount === null) {
    return {
      ok: false,
      error: {
        status: "error",
        error: invalidAmountError("refund_amount_minor", input.refund_amount_minor),
      },
    }
  }
  input = { ...input, refund_amount_minor: refundAmount }
  const doc = await findDocumentSummary(ctx.db, input.document_id)
  if (!doc) {
    return {
      ok: false,
      error: {
        status: "error",
        error: { code: "not_found", message: `document ${input.document_id} not found` },
      },
    }
  }
  const status = doc.status ?? "draft"

  // Validate amount for both full and partial refunds before branching.
  if (input.refund_amount_minor <= 0n) {
    return {
      ok: false,
      error: {
        status: "error",
        error: { code: "invalid_amount", message: "refund_amount_minor must be positive" },
      },
    }
  }

  if (input.refund_kind === "full") {
    const trans = transition({ type: doc.type as DocumentType, status }, "mark_refunded")
    if (trans.status !== "ok") {
      return {
        ok: false,
        error: {
          status: "error",
          error: {
            code: "invalid_transition",
            message: `cannot refund ${doc.type} in status=${status}`,
          },
        },
      }
    }
    // A full refund is bounded like a partial one: it cannot exceed what is still unrefunded.
    const priorFull = sumPriorRefundedMinor(doc.lifecycle_log)
    if (priorFull + input.refund_amount_minor > doc.grand_total_minor) {
      return {
        ok: false,
        error: {
          status: "error",
          error: {
            code: "invalid_amount",
            message: `cumulative refund ${priorFull + input.refund_amount_minor} (prior ${priorFull} + ${input.refund_amount_minor}) exceeds document total ${doc.grand_total_minor}`,
          },
        },
      }
    }
    return { ok: true, kind: "full", doc, nextStatus: trans.next }
  }

  // Partial — does not transition status; appends a lifecycle log entry.
  if (status !== "paid" && status !== "issued") {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "invalid_transition",
          message: `cannot partial-refund ${doc.type} in status=${status}`,
        },
      },
    }
  }
  // Cumulative-refund guard. A partial refund must be checked against the sum
  // of refunds ALREADY recorded on this document, not against the document
  // total in isolation — otherwise sequential partials can over-refund past
  // 100% (each one individually <= total), and partials summing to exactly the
  // total never flip payment_status to 'refunded'.
  const priorRefundedMinor = sumPriorRefundedMinor(doc.lifecycle_log)
  const cumulativeRefundedMinor = priorRefundedMinor + input.refund_amount_minor
  if (cumulativeRefundedMinor > doc.grand_total_minor) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "invalid_amount",
          message: `cumulative refund ${cumulativeRefundedMinor} (prior ${priorRefundedMinor} + ${input.refund_amount_minor}) exceeds document total ${doc.grand_total_minor}`,
        },
      },
    }
  }
  // When the cumulative reaches the total exactly, the document is fully
  // refunded — flip both the document status and payment_status, mirroring the
  // refund_kind="full" branch above.
  return {
    ok: true,
    kind: "partial",
    doc,
    status,
    cumulativeRefundedMinor,
    fullyRefunded: cumulativeRefundedMinor === doc.grand_total_minor,
  }
}

/**
 * STAGE-TIME preflight for the gated `documents_record_refund` tool (manifest `preflight`). A
 * gated call must not be parked for a human when the data it needs is missing or wrong: an
 * unknown document, a non-positive amount, a status that cannot be refunded, or an OVER-refund
 * past the document total is refused here, before the approval request exists.
 */
export async function documentsRecordRefundPreflight(
  ctx: MutationsCtx,
  input: {
    document_id: string
    refund_amount_minor: bigint
    refund_kind: "full" | "partial"
  },
): Promise<PreflightResult> {
  return toPreflightResult(await preflightRecordRefundParams(ctx, input))
}

export async function documentsRecordRefund(
  ctx: MutationsCtx,
  input: {
    document_id: string
    refund_amount_minor: bigint
    refund_kind: "full" | "partial"
  },
): Promise<MutationResult<{ document_id: string }>> {
  // The status and cumulative-amount guards below ALSO run at stage time (the preflight export
  // above shares this exact code), but they stay here: another refund can land between staging
  // and approval, so the executed call re-checks rather than trusts.
  const pre = await preflightRecordRefundParams(ctx, input)
  if (!pre.ok) return pre.error
  const { doc } = pre

  if (pre.kind === "full") {
    const trans = { next: pre.nextStatus }
    await ctx.db.update("documents", doc.id, {
      status: trans.next,
      payment_status: "refunded",
      lifecycle_log: [
        ...doc.lifecycle_log,
        {
          event: "full_refund_recorded",
          actor: await ctx.getUserId(),
          ts: new Date().toISOString(),
          refund_amount_minor: input.refund_amount_minor.toString(),
        },
      ],
    })
    await reportCollectionAfter(ctx, doc.id, {
      kind: "refund",
      amount_minor: input.refund_amount_minor,
      date: new Date().toISOString().slice(0, 10),
      ref: `refund:${doc.lifecycle_log.length}`,
    })
    return { status: "completed", document_id: doc.id }
  }

  // Partial — does not transition status; appends a lifecycle log entry. The status and
  // cumulative-amount guards ran in the shared validation above.
  const { status, fullyRefunded } = pre
  const updatePatch: Record<string, unknown> = {
    payment_status: fullyRefunded ? "refunded" : "partial",
    lifecycle_log: [
      ...doc.lifecycle_log,
      {
        event: "partial_refund_recorded",
        actor: await ctx.getUserId(),
        ts: new Date().toISOString(),
        refund_amount_minor: input.refund_amount_minor.toString(),
      },
    ],
  }
  if (fullyRefunded) {
    const trans = transition({ type: doc.type as DocumentType, status }, "mark_refunded")
    if (trans.status === "ok") updatePatch.status = trans.next
  }
  await ctx.db.update("documents", doc.id, updatePatch)
  await reportCollectionAfter(ctx, doc.id, {
    kind: "refund",
    amount_minor: input.refund_amount_minor,
    date: new Date().toISOString().slice(0, 10),
    ref: `refund:${doc.lifecycle_log.length}`,
  })
  return { status: "completed", document_id: doc.id }
}
