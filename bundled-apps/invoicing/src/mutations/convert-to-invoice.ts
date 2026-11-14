// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: documents.convert_to_invoice (quote to invoice, including the
// Shopify draft order completion path).

import type { OperationCategory } from "../einvoicing/classify-operation"
import type { OperationSource } from "../einvoicing/gate"
import {
  checkEinvoiceGate,
  type EinvoicingWarning,
  einvoiceParamsError,
} from "../einvoicing/issue-gate"
// Cycle note: the draft-order sync imports the mutations index back (it calls quoteCreateAndIssue
// and documentsUpdate). Both directions are function-level only -- nothing runs at module init --
// so the bundle resolves it through hoisting.
import { shopifyOrderIdFromGid } from "../handlers/shopify-draft-order"
import { type Counterparty, counterpartyCompletenessError, type DraftLine } from "../issue"
import { issueDateParts } from "../issue-date"
import { transition } from "../state"
import {
  findDocumentSummary,
  findIssuerProfile,
  type IssuerProfileRow,
  loadDraftLines,
  readDraftOrderId,
} from "./db-helpers"
import { issueWithFxRate } from "./fx-issue"
import { counterpartyFromRow } from "./lines"
import {
  type DocumentRowSummary,
  type DocumentType,
  type ErrorEnvelope,
  type MutationResult,
  type MutationsCtx,
  normaliseNotes,
  type PreflightResult,
  toPreflightResult,
} from "./shared"

// ── documents.convert_to_invoice ──────────────────────────────────────────

export interface ConvertToInvoiceInput {
  source_document_id: string
  notes?: string | null
  /** E-invoicing: the operation category of the invoice, when the source does not state one
   *  (a French B2B e-invoice needs it stated). An explicit value wins over the source's. */
  operation_category?: OperationCategory | null
}

/** The category the converted invoice carries: the call's, else the one the source stated. */
function convertCategory(
  input: ConvertToInvoiceInput,
  source: DocumentRowSummary,
): { category: OperationCategory | null; source: OperationSource | null } {
  if (input.operation_category) return { category: input.operation_category, source: "explicit" }
  const stated = source.einvoice?.operation_category ?? null
  const statedSource = source.einvoice?.operation_category_source ?? null
  return stated && statedSource !== "lines_default"
    ? { category: stated, source: statedSource }
    : { category: null, source: null }
}

export type ConvertToInvoiceResult = MutationResult<{
  /** "local": an invoice was issued here and `document_id`/`number` are ITS id and number.
   *  "shopify_order_created": the draft order was completed in Shopify, `document_id` is the
   *  SOURCE quote (now `invoiced`) and the invoice follows from the `order:created` event. */
  mode?: "local" | "shopify_order_created"
  document_id: string
  number: string
  shopify_order_id?: string | null
  shopify_order_number?: string | null
  einvoicing_warning?: EinvoicingWarning
}>

/**
 * Read-only validation shared by `documentsConvertToInvoice` and its stage-time preflight export:
 * notes length, the source document resolves, its status allows a convert, its issuer exists and
 * its recipient snapshot is complete. ONE copy, called from both sides, so the staged refusal and
 * the executed refusal can never drift apart.
 */
async function preflightConvertToInvoiceParams(
  ctx: MutationsCtx,
  input: ConvertToInvoiceInput,
): Promise<
  | {
      ok: true
      source: DocumentRowSummary
      issuer: IssuerProfileRow
      counterparty: Counterparty
      notes: { value: string | null | undefined }
      nextStatus: string
      sourceLines: DraftLine[]
    }
  | { ok: false; error: ErrorEnvelope }
> {
  // Free-text notes for the new invoice. Validated before anything is read or written, so an
  // over-long note never half-converts the source document.
  const notes = normaliseNotes(input.notes)
  if (!notes.ok) return { ok: false, error: notes.error }
  const source = await findDocumentSummary(ctx.db, input.source_document_id)
  if (!source) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "not_found",
          message: `document ${input.source_document_id} not found`,
        },
      },
    }
  }
  const status = source.status ?? "draft"
  const trans = transition({ type: source.type as DocumentType, status }, "convert_to_invoice")
  if (trans.status !== "ok") {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "invalid_transition",
          message: `cannot convert ${source.type} in status=${status}`,
        },
      },
    }
  }

  const issuer = await findIssuerProfile(ctx.db, source.issuer_profile_id)
  if (!issuer) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "issuer_not_found",
          message: `issuer_profile ${source.issuer_profile_id} not found`,
        },
      },
    }
  }

  // Carry the SOURCE document's counterparty (name + country) forward — issue RE-DERIVES the tax
  // treatment from counterparty_country (classify(issuer_country, counterparty_country)), so dropping
  // it to the issuer's country silently mis-classifies (e.g. a US-export quote → issuer-domestic 20%
  // VAT) and a "Customer" placeholder name leaves the agent unable to reconcile the converted invoice
  // (it loops trying to fix what the convert mis-built). Fall back only when the source lacks them.
  // The new invoice inherits the SOURCE document's recipient snapshot in full (name, address,
  // email, VAT id) — a convert must not downgrade a complete quote/proforma recipient.
  const counterparty = counterpartyFromRow(source, issuer)
  const convertIncompleteErr = counterpartyCompletenessError(counterparty)
  if (convertIncompleteErr) {
    return { ok: false, error: { status: "error", error: convertIncompleteErr } }
  }
  // E-invoicing gate on the invoice this convert produces, with the source's own lines (the
  // handler issues from the same query). Runs before a Shopify-linked quote's draft order is
  // completed, so a refused convert never reaches Shopify. A Shopify-linked quote's invoice is
  // issued from the order's lines, whose kinds Shopify sets: those count as authoritative.
  const sourceLines = await loadDraftLines(ctx.db, source.id)
  const paramsErr = einvoiceParamsError(null, input.operation_category)
  if (paramsErr) return { ok: false, error: paramsErr }
  const cat = convertCategory(input, source)
  const gate = await checkEinvoiceGate(ctx, {
    type: "invoice",
    issuer,
    counterparty,
    lines: sourceLines,
    operation_category: cat.category,
    operation_source: cat.category
      ? cat.source
      : readDraftOrderId(source)
        ? "lines_authoritative"
        : null,
  })
  if (!gate.ok) return { ok: false, error: gate.error }
  return { ok: true, source, issuer, counterparty, notes, nextStatus: trans.next, sourceLines }
}

/**
 * STAGE-TIME preflight for the gated `documents_convert_to_invoice` tool (manifest `preflight`).
 * A gated call must not be parked for a human when the data it needs is missing: a source that
 * does not resolve, one whose status forbids a convert, or an incomplete counterparty is refused
 * here, before the approval request exists.
 */
export async function documentsConvertToInvoicePreflight(
  ctx: MutationsCtx,
  input: ConvertToInvoiceInput,
): Promise<PreflightResult> {
  return toPreflightResult(await preflightConvertToInvoiceParams(ctx, input))
}

/**
 * `documents_convert_to_invoice`. The tool holds no transaction of its own, so
 * the two Shopify calls of a Shopify-linked quote keep no database connection or transaction open
 * while Shopify answers; the quote is stamped in one write once Shopify has completed the draft
 * order. A local convert (the quote marked, the invoice numbered and written) lands in one commit
 * through the app's internal `documents_convert_local` tool, so a failure leaves the quote as it
 * was and uses no number.
 */
export async function documentsConvertToInvoice(
  ctx: MutationsCtx,
  input: ConvertToInvoiceInput,
): Promise<ConvertToInvoiceResult> {
  // The status guard below ALSO runs at stage time (the preflight export above shares this exact
  // code), but it stays here: a source document can legitimately move on between staging and
  // approval, so the executed call re-checks rather than trusts.
  const pre = await preflightConvertToInvoiceParams(ctx, input)
  if (!pre.ok) return pre.error
  // Shopify-linked quote: converting means COMPLETING the draft order in Shopify. Shopify
  // creates the real order, and the existing `shopify/order:created` auto-flow issues the
  // invoice(s) from it -- issuing one here too would double-invoice the customer.
  // `paymentPending: true` because a B2B customer pays against the invoice, not at checkout.
  const draftOrderId = readDraftOrderId(pre.source)
  if (draftOrderId)
    return convertViaShopifyDraftOrder(ctx, pre.source, draftOrderId, pre.nextStatus)
  const env = await ctx.executeTool("invoicing:documents_convert_local", { ...input })
  if (env.status === "pending_approval")
    return { status: "pending_approval", approval_id: env.approval_id }
  if (env.status !== "completed") {
    return {
      status: "error",
      error: {
        code: env.error?.code ?? "convert_failed",
        message: `The ${pre.source.type} ${pre.source.number ?? pre.source.id} was not converted and no number was used: ${env.error?.message ?? "the convert returned an error"}.`,
      },
    }
  }
  return env.result as ConvertToInvoiceResult
}

/**
 * `documents_convert_local`, internal: the local half of a convert. The source's new status
 * commits with the invoice in one batch. A Shopify-linked source is refused here: it converts
 * through Shopify instead.
 */
export async function documentsConvertLocal(
  ctx: MutationsCtx,
  input: ConvertToInvoiceInput,
): Promise<ConvertToInvoiceResult> {
  const pre = await preflightConvertToInvoiceParams(ctx, input)
  if (!pre.ok) return pre.error
  const { source, issuer, counterparty, notes, sourceLines } = pre
  const trans = { next: pre.nextStatus }
  // Source lines (loaded by the shared check above) mirror into the new invoice. Loaded by the
  // RESOLVED uuid (source.id), not the raw input — input.source_document_id may be a document
  // NUMBER, and document_lines.document_id is a uuid foreign key.

  // NO handler-level approval here. Converting is the deliberate human click on a quote the
  // customer already accepted (and, for a Shopify-linked quote, the money decision was already
  // taken in Shopify). Agents still hit the KERNEL gate: the manifest keeps this tool
  // `gated: true`, so an agent-issued convert parks an approval card before the handler runs.
  // The old handler-level two-eyes + threshold checks parked a SECOND approval on top of that
  // and made the human's own click unusable.

  if (readDraftOrderId(source)) {
    return {
      status: "error",
      error: {
        code: "shopify_linked",
        message: `Document ${source.number ?? source.id} is linked to a Shopify draft order, so it converts through documents_convert_to_invoice, which completes the draft order; nothing was written.`,
      },
    }
  }

  // Before anything changes: a refused zone leaves the source as it was.
  const when = await issueDateParts(ctx, issuer)
  if (!when.ok) return when.error

  // Issue a new invoice referencing the source. UI/agent flow seeds lines. The source's new
  // status commits with the invoice (`commit_with`): a refused or failed issue leaves the source
  // as it was, and an issued invoice never leaves its source unconverted.
  const cat = convertCategory(input, source)
  const issueInput = {
    type: "invoice" as const,
    issuer,
    counterparty,
    operation_category: cat.category,
    operation_source: cat.source,
    draft: {
      currency: source.currency,
      incoterm: source.incoterm,
      year_of_issue: when.year_of_issue,
      issued_at: when.issued_at,
      due_at: null as string | null,
      // Persist the resolved uuid on the external_refs link, not whatever identifier the
      // caller passed in (a document number), so downstream joins/back-links stay uuid-stable.
      external_refs: {
        source_document_id: source.id,
        ...(source.po_number ? { po_number: source.po_number } : {}),
      },
      // An explicit note on the convert call wins; otherwise the quote's or proforma's own
      // notes carry onto the invoice, same rule as po_number above.
      notes: (notes.value === undefined ? source.notes : notes.value) ?? null,
      lines: sourceLines,
    },
    commit_with: [
      {
        update: "documents",
        id: source.id,
        data: { status: trans.next },
        append: {
          lifecycle_log: [
            {
              event: "converted_to_invoice",
              actor: await ctx.getUserId(),
              ts: new Date().toISOString(),
            },
          ],
        },
      },
    ],
  }
  const issued = await issueWithFxRate(ctx, issueInput)
  if (!issued.ok) return issued.error
  const result = issued.result
  return {
    status: "completed",
    mode: "local",
    document_id: result.document_id,
    number: result.number,
    ...(result.einvoicing_warning ? { einvoicing_warning: result.einvoicing_warning } : {}),
  }
}

/**
 * Complete the quote's Shopify draft order, then stamp the quote `invoiced` with the order it
 * produced. The INVOICE is not issued here: `shopify/order:created` fires for the new order and
 * the existing auto-flow issues it (split by scope, customs-enriched, emailed) exactly as it
 * does for a checkout.
 */
async function convertViaShopifyDraftOrder(
  ctx: MutationsCtx,
  source: DocumentRowSummary,
  draftOrderId: string,
  nextStatus: string,
): Promise<ConvertToInvoiceResult> {
  const envelope = await ctx.executeTool("shopify:draft_orders_complete", {
    id: draftOrderId,
    paymentPending: true,
  })
  if (envelope.status === "pending_approval") {
    return { status: "pending_approval", approval_id: envelope.approval_id }
  }
  if (envelope.status !== "completed") {
    return {
      status: "error",
      error: {
        code: envelope.error?.code ?? "draft_order_complete_failed",
        message: envelope.error?.message ?? "shopify:draft_orders_complete returned an error",
      },
    }
  }
  // Re-read the draft order for the order it produced. Tolerated as null: the completion
  // succeeded either way, and the order:created event carries the authoritative reference.
  let orderId: string | null = null
  let orderNumber: string | null = null
  const fetched = await ctx.executeTool("shopify:draft_orders_get", { id: draftOrderId })
  if (fetched.status === "completed") {
    const draft = (fetched.result as { draftOrder?: Record<string, unknown> } | null)?.draftOrder
    const o = draft as { orderId?: unknown; orderName?: unknown } | undefined
    // Numeric handle, like the invoice the order:created flow writes (see shopifyOrderIdFromGid).
    orderId =
      typeof o?.orderId === "string" && o.orderId !== "" ? shopifyOrderIdFromGid(o.orderId) : null
    orderNumber = typeof o?.orderName === "string" && o.orderName !== "" ? o.orderName : null
  }
  const actor = await ctx.getUserId()
  const ts = new Date().toISOString()
  const externalRefs = {
    ...((source.external_refs as Record<string, unknown> | undefined) ?? {}),
    ...(orderId ? { shopify_order_id: orderId } : {}),
    ...(orderNumber ? { shopify_order_number: orderNumber } : {}),
  }
  await ctx.db.update("documents", source.id, {
    status: nextStatus,
    external_refs: externalRefs,
    ...(orderId ? { shopify_order_id: orderId } : {}),
    ...(orderNumber ? { shopify_order_number: orderNumber } : {}),
    lifecycle_log: [
      ...source.lifecycle_log,
      { event: "converted_to_invoice", actor, ts },
      {
        event: "draft_order_completed",
        actor,
        ts,
        draft_order_id: draftOrderId,
        ...(orderId ? { shopify_order_id: orderId } : {}),
      },
    ],
  })
  return {
    status: "completed",
    mode: "shopify_order_created",
    document_id: source.id,
    number: source.number ?? "",
    shopify_order_id: orderId,
    shopify_order_number: orderNumber,
  }
}
