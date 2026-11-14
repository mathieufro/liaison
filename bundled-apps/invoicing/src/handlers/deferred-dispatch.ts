// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Production entry for the `deferred-retry` cron job.
//
// The kernel invokes every manifest job handler as `(payload, ctx)` (see the
// header of `bundled-apps/invoicing/src/handlers.ts`). The pure drain loop
// `deferredRetryJob` takes an *injected* `dispatch` so its logic stays unit
// testable — which means it cannot be the manifest handler directly: bound as
// one, its second parameter (`dispatch`) would receive the ctx and every
// re-dispatch would throw, so parked events would never recover (they would
// just age to the dead-letter cap).
//
// This module is the kernel-shaped seam. It builds the REAL dispatch — routing
// each parked row to its recovery by `blocked_on.kind` — and runs the drain.

import { appEffectOnce, type EffectsBridge } from "@liaison/app-sdk/effects"
import { type DeferredRow, EMAIL_OUTCOME_UNKNOWN } from "../deferred"
import { isParkedCreditNote, retryParkedCreditNote } from "../einvoicing/parked-credit-note"
import { deliveryFileId } from "../legal-originals/delivery"
import { documentsRetryPdf, type MutationsCtx } from "../mutations"
import { type DeferredDispatch, type DeferredRetryResult, deferredRetryJob } from "./deferred-retry"
import { isParkedDraftOrderQuote, retryParkedDraftOrderQuote } from "./shopify-draft-order"
import {
  findIssuerByShopId,
  type OrderPaidCtx,
  type OrderPaidPayload,
  onShopifyOrderPaid,
} from "./shopify-order-paid"
import { onStripeInvoiceFinalized, STRIPE_PARK_PREFIX } from "./stripe-invoice-finalized"
import { retryParkedStripeCreditNote, STRIPE_CREDIT_NOTE_PARK } from "./stripe-refund-created"

// The cron ctx is the full bundled-app bridge, so it satisfies both the
// order-handler surface (re-issue path) and the mutations surface (PDF retry).
// `effects` is the kernel's effect ledger; absent on an older kernel.
type DeferredDispatchCtx = OrderPaidCtx & MutationsCtx & { effects?: EffectsBridge }

type DispatchOutcome = { status: "ok" } | { status: "still_blocked"; reason: string }

function blockedField(row: DeferredRow, key: string): string {
  return String((row.blocked_on as Record<string, unknown>)[key] ?? "")
}

/**
 * Re-send the auto-email for an already-issued + rendered document (the
 * `email_send` / `issuer_mail_account` parks happen AFTER issuance, so
 * re-driving the order handler would no-op at the duplicate-document guard —
 * the email is the only thing left to do).
 */
async function retryAutoEmail(
  ctx: DeferredDispatchCtx,
  row: DeferredRow,
): Promise<DispatchOutcome> {
  const documentId = blockedField(row, "document_id")
  if (!documentId) return { status: "still_blocked", reason: "missing_document_id" }
  // Once its outcome was found unknown, the automatic mail is never sent by this job again,
  // even after the ledger's retention dropped the unknown key: a person decides (they check
  // the sent folder and send the document with documents_send_to_customer, which closes this park).
  if (row.reason === EMAIL_OUTCOME_UNKNOWN)
    return { status: "still_blocked", reason: EMAIL_OUTCOME_UNKNOWN }
  const docRows = await ctx.db.findMany("documents", { where: { id: documentId }, limit: 1 })
  const doc = docRows[0] as Record<string, unknown> | undefined
  if (!doc) return { status: "still_blocked", reason: "document_missing" }
  // The legal original (fixed at issue), never a later management re-render.
  const pdfFileId = (await deliveryFileId(ctx.db, doc)).file_id
  // The PDF must exist before we can attach it — a render_failed park recovers first.
  if (!pdfFileId) return { status: "still_blocked", reason: "pdf_not_ready" }
  const payload = row.event_payload_json as OrderPaidPayload
  const to = payload.customer?.email
  if (!to) return { status: "still_blocked", reason: "customer_email_missing" }
  const issuer = await findIssuerByShopId(ctx.db, payload.shop_id)
  if (!issuer?.mail_account_id) {
    return { status: "still_blocked", reason: "issuer_mail_account_missing" }
  }
  const number = String(doc.number ?? "")
  const tpl = (issuer.email_templates ?? {}).invoice_paid ?? {}
  const subject = (tpl.subject ?? "Invoice {{number}}").replace("{{number}}", number)
  const textBody = (tpl.body ?? "Please find your invoice attached.").replace("{{number}}", number)
  const send = async (): Promise<DispatchOutcome> => {
    const res = await ctx.executeTool("mail:composeForApp", {
      accountId: issuer.mail_account_id,
      to: [to],
      subject,
      textBody,
      attachments: [pdfFileId],
      originating_approval_id: null,
    })
    if (res.status === "completed") return { status: "ok" }
    return {
      status: "still_blocked",
      reason: res.status === "error" ? (res.error.code ?? "email_failed") : res.status,
    }
  }
  if (!ctx.effects) return send()
  // S11: the mail is claimed in the kernel's effect ledger before it is sent and stored after,
  // so a sweep that stopped between the send and the park's `resolved` mark (a deploy handing
  // the job back, a crash) does not send it again: the next sweep replays the stored outcome
  // and closes the park. A send the provider refused releases the claim (the next sweep sends).
  // A claim whose sweep died mid-send is unknown: the mail may have gone, so it is never sent
  // again by this job; the park stays open with that reason until a person checks the sent
  // folder and sends the document themselves (documents_send_to_customer closes the park).
  try {
    const out = await appEffectOnce<DispatchOutcome>(
      ctx.effects,
      `auto-email:${documentId}`,
      async () => {
        const outcome = await send()
        if (outcome.status !== "ok") throw new EmailRefused(outcome)
        return outcome
      },
    )
    if (out.status === "ran" || out.status === "replayed") return { status: "ok" }
    if (out.status === "in_flight") return { status: "still_blocked", reason: "email_in_flight" }
    return { status: "still_blocked", reason: EMAIL_OUTCOME_UNKNOWN }
  } catch (err) {
    if (err instanceof EmailRefused) return err.outcome
    throw err
  }
}

/** A send the mail app refused: nothing went out, so the claim is released. */
class EmailRefused extends Error {
  constructor(readonly outcome: DispatchOutcome) {
    super("email refused")
  }
}

/**
 * `changed_at` of the identities the sweep's waiting identity parks are blocked on, read per
 * contact (filtered, never a scan), so a park is re-driven as soon as its buyer's identity was
 * fixed rather than after its backoff.
 */
function identityChangedAtLoader(ctx: DeferredDispatchCtx) {
  return async (contactIds: string[]): Promise<Map<string, Date>> => {
    const out = new Map<string, Date>()
    for (const contactId of contactIds) {
      const rows = (await ctx.db.findMany("counterparty_identities", {
        where: { contact_id: contactId },
        limit: 1,
      })) as Array<Record<string, unknown>>
      const changed = rows[0]?.changed_at
      if (changed == null || changed === "") continue
      const at = changed instanceof Date ? changed : new Date(String(changed))
      if (!Number.isNaN(at.getTime())) out.set(contactId, at)
    }
    return out
  }
}

/**
 * Manifest `jobs.deferred-retry` handler (kernel `(payload, ctx)` shape). The
 * scheduled payload is unused — the job drains the whole org's deferred queue.
 */
export async function deferredRetryJobHandler(
  _payload: unknown,
  ctx: DeferredDispatchCtx,
  opts?: { now?: Date; batchSize?: number },
): Promise<DeferredRetryResult> {
  const dispatch: DeferredDispatch = async (row: DeferredRow) => {
    const kind = blockedField(row, "kind")

    // An automatic credit note (refund / cancellation) parked on the buyer's identity: re-issue
    // that credit note alone, never the refund or cancellation handler (see parked-credit-note.ts).
    if (isParkedCreditNote(row.event_payload_json)) {
      return retryParkedCreditNote(ctx, row)
    }

    // Card payments on Stripe: a parked credit note re-runs the refund path by its refund id; a
    // parked invoice re-runs its finalized handler (the undecided stream, an unmatched payment and
    // the approval wait for a person, never this sweep). Never the Shopify order handler.
    const payloadKind = String(
      (row.event_payload_json as Record<string, unknown> | null)?.kind ?? "",
    )
    if (payloadKind === STRIPE_CREDIT_NOTE_PARK)
      return retryParkedStripeCreditNote(ctx, row.event_payload_json)
    if (payloadKind.startsWith(STRIPE_PARK_PREFIX) || kind.startsWith(STRIPE_PARK_PREFIX)) {
      if (
        payloadKind !== "stripe_invoice" ||
        kind === "stripe_issuer_undecided" ||
        kind === "stripe_invoice_approval"
      ) {
        return { status: "still_blocked", reason: row.reason ?? "waits_for_a_person" }
      }
      const r = await onStripeInvoiceFinalized(row.event_payload_json, ctx)
      return r.status === "deferred" || r.status === "error" || r.status === "pending_approval"
        ? { status: "still_blocked", reason: r.status === "deferred" ? r.reason : r.status }
        : { status: "ok" }
    }

    // A Shopify draft order's quote that waited for its issuer's time zone: make that quote, never
    // the order handler (a draft order is not an order).
    if (isParkedDraftOrderQuote(row.event_payload_json)) {
      return retryParkedDraftOrderQuote(ctx, row)
    }

    // PDF render failure: invoice + lines are persisted, only the PDF is missing.
    if (kind === "pdf_render") {
      const documentId = blockedField(row, "document_id")
      if (!documentId) return { status: "still_blocked", reason: "missing_document_id" }
      const r = await documentsRetryPdf(ctx, { id: documentId })
      if (r.status === "completed") return { status: "ok" }
      return {
        status: "still_blocked",
        reason: r.status === "error" ? (r.error.code ?? "render_failed") : r.status,
      }
    }

    // Email send failure / now-available mail dependency / late-configured mail
    // account: invoice + PDF exist; the auto-email is the only remaining step.
    if (kind === "email_send" || kind === "issuer_mail_account") {
      return retryAutoEmail(ctx, row)
    }

    // Everything else (issuer_mapping, customer_email, contact, tax_regime, and
    // a throttled `customs` fetch) parked BEFORE the document was persisted —
    // re-drive the order handler. Idempotent: the duplicate-document guard makes
    // a since-issued order resolve cleanly; a still-present blocker re-defers.
    const result = await onShopifyOrderPaid(row.event_payload_json as OrderPaidPayload, ctx)
    return result.status === "deferred"
      ? { status: "still_blocked", reason: result.reason }
      : { status: "ok" }
  }

  return deferredRetryJob(ctx, dispatch, {
    ...opts,
    identityChangedAt: identityChangedAtLoader(ctx),
  })
}
