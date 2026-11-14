// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: credit notes (create and issue, issue from a draft).

import { readMinorAmount } from "@liaison/app-sdk"
import { asHandlerSummary, issueCard } from "../approval-cards"
import type { Regime } from "../einvoicing/classify"
import type { OperationCategory } from "../einvoicing/classify-operation"
import {
  checkEinvoiceGate,
  type EinvoicingWarning,
  einvoiceParamsError,
} from "../einvoicing/issue-gate"
import {
  type Counterparty,
  counterpartyCompletenessError,
  type DraftLine,
  type DraftLineInput,
  type IssueInput,
  type IssueResult,
  taxCountryOf,
} from "../issue"
import { type IssueDateParts, issueDateParts } from "../issue-date"
import { formatMoneyMinor } from "../money"
import type { ClassifyInput } from "../tax"
import { creditedTotalMinor, ISSUED_INVOICE_STATUSES } from "./credit-coverage"
import type { IssuerProfileRow } from "./db-helpers"
import {
  dateOnly,
  findDocumentSummary,
  findIssuerProfile,
  getDraft,
  resolveIssuerProfileOrError,
} from "./db-helpers"
import { issueWithFxRate } from "./fx-issue"
import {
  buildIssueInputFromDraft,
  checkTwoEyes,
  computeLineFinancials,
  counterpartyFromRow,
  normaliseDraftLines,
} from "./lines"
import {
  type DocumentRowSummary,
  type DraftRow,
  type ErrorEnvelope,
  lineAmountsError,
  type MutationResult,
  type MutationsCtx,
  normaliseNotes,
  type PreflightResult,
  toBigInt,
  toPreflightResult,
} from "./shared"
import { statedIssueDate } from "./stated-issue-date"

/** What the issue step needs to know of the original invoice: id, stored regime, transmission
 *  state and its stored buyer snapshot (a credit note follows its original's facts). */
function originalRefOf(original: DocumentRowSummary): NonNullable<IssueInput["original"]> {
  return {
    id: original.id,
    regime: (original.regime as Regime | null | undefined) ?? null,
    transmissionStatus: original.einvoice_state ?? null,
    counterparty_contact_id: original.counterparty_contact_id,
    snapshot: original.einvoice ?? null,
  }
}

/** Options for in-process callers of `creditNoteCreateAndIssue` (never on the wire). */
export interface CreditNoteIssueOptions {
  /** `shopify`: an automatic credit note reversing a Shopify order invoice (refund, cancellation).
   *  The original's line kinds come from the Shopify adapter, so they state the operation
   *  category, and a buyer with no company and no VAT id is a checkout consumer. */
  source?: "shopify"
  /** The note's dedup key, written to `documents.external_ref` (unique) in the issuing commit (a
   *  Stripe refund's `stripe:re_...`): one refund never yields two credit notes, and an automatic
   *  note re-run after its run died is found by it instead of issued twice. */
  external_ref?: string | null
  /** "batch": issued with no person (a Stripe refund's automatic credit note), so its e-invoice
   *  goes out like every other no-person issue instead of asking for its own send card. */
  einvoice_send?: "batch"
}

/** The gate inputs an automatic Shopify credit note carries (see `CreditNoteIssueOptions.source`). */
function autoSourceGateFields(opts: CreditNoteIssueOptions): {
  operation_source?: "lines_authoritative"
  origin?: "shopify"
} {
  return opts.source === "shopify"
    ? { operation_source: "lines_authoritative", origin: "shopify" }
    : {}
}

// ── Credit notes (E-series parity) ────────────────────────────────────────
//
// A credit note is a first-class legal document type — its own gap-free
// CN-{YYYY}- number series (issuer_profiles.prefix_credit_note), issued
// straight to 'issued' (never payable — no due date, no mark_paid /
// mark_refunded transition; see state.ts). Lines carry NEGATIVE unit_price_minor
// (mirroring what is reversed on the original invoice), and the document's total
// must come out negative (creditNoteSignError). When `original_document_id` is given it MUST reference an
// existing document of type='invoice'; on success the ORIGINAL invoice's
// lifecycle_log gets an appended `credit_note_issued` entry (id + number) so
// the reversal is discoverable from the invoice side too.
//
// Approval gating mirrors invoice_create_and_issue's threshold check, but
// compares the gate against ABS(grand_total) — a credit note's total is
// negative, and "issue a -6,744€ correction" must gate exactly like a +6,744€
// invoice would.

/**
 * The sign of a credit note, on every path that issues one. It credits, so its total is negative:
 * the refund and cancellation flows only ever build such lines, the card leaves the sign off, the
 * accounting booking flips it, and the over-credit guard compares absolute values, so a positive
 * one would pass as a reversal and add to the books. Lines may be mixed (a restocking fee against a
 * return). Zero only mirrors an invoice whose own total is zero. Imported legal originals do not
 * come through here: they are stored as their source states them, and are never re-issued.
 */
function creditNoteSignError(
  lines: ReadonlyArray<{ unit_price_minor?: unknown }>,
  total: bigint,
  originalTotal: bigint | null,
  currency: string,
): ErrorEnvelope | null {
  if (total < 0n || (total === 0n && originalTotal === 0n)) return null
  const positive = lines
    .map((l, i) => ({ i, unit: readMinorAmount(l.unit_price_minor) ?? 0n }))
    .find((l) => l.unit > 0n)
  const example = positive
    ? ` For example, line ${positive.i + 1}'s unit_price_minor is ${positive.unit}: send ${-positive.unit}.`
    : ""
  return {
    status: "error",
    error: {
      code: "credit_note_not_negative",
      message:
        `These lines total ${formatMoneyMinor(total, currency)}, and a credit note's total must be negative, ` +
        `because it reverses what was invoiced. Nothing was created and no number was taken. ` +
        `Send the amounts being reversed as negative unit_price_minor values.${example}`,
    },
  }
}

export interface CreditNoteCreateAndIssueInput {
  issuer_profile_id?: string | null
  counterparty: Counterparty
  currency?: string
  incoterm?: string
  issued_at?: string | null
  items: DraftLineInput[]
  /** The invoice this credit note corrects/reverses, if any. When set, MUST reference an existing
   *  document of type='invoice' — validated before issuance. Persisted onto
   *  `external_refs.original_document_id` and the original invoice's lifecycle_log gets a
   *  `credit_note_issued` entry. */
  original_document_id?: string | null
  /** Free-text reason for the credit note (e.g. "partial return — 2 of 10 units"). Persisted onto
   *  `external_refs.reason` and rendered under the reference line on the PDF. */
  reason?: string | null
  /** The customer's purchase order number. Printed as a "PO number" line on the credit note
   *  PDF and indexed for documents_search. When omitted and `original_document_id` is set, it
   *  is INHERITED from the original invoice's own po_number (same pattern as shopify_order_id
   *  below) — an explicit value here always wins over the inherited one. */
  po_number?: string | null
  /** Free-text notes printed on the credit note PDF under the totals (contract reference, extra
   *  customs information, a special mention). Non financial: trimmed, blank becomes null, and
   *  refused past NOTES_MAX_LENGTH characters. When omitted and `original_document_id` is set,
   *  they are INHERITED from the original invoice, same rule as po_number above; an explicit
   *  value (including null, which clears them) always wins. */
  notes?: string | null
  /** E-invoicing: the goods / services category. Omitted on a credit note against an e-invoice,
   *  the original's stated category applies. */
  operation_category?: OperationCategory | null
}

/** A credit note is a negative legal document, so an unset threshold means "always approve"
 *  (threshold 0), and a credit note that reverses no invoice is always approved whatever the
 *  threshold, since the over-credit cap cannot bound it. */
function creditNoteMustGate(
  threshold: bigint | null,
  absTotal: bigint,
  hasOriginal: boolean,
): boolean {
  return !hasOriginal || threshold == null || absTotal > threshold
}

interface CreditNoteCreatePrepared {
  rawInput: CreditNoteCreateAndIssueInput
  input: Omit<CreditNoteCreateAndIssueInput, "items"> & { items: DraftLine[] }
  notes: { value: string | null | undefined }
  issuer: IssuerProfileRow
  currency: string
  total: bigint
  absTotal: bigint
  when: IssueDateParts
  original: {
    number: string | null
    issuedAt: string | null
    ref: IssueInput["original"]
    uuid: string | null
    shopifyOrderId: string | null
    shopifyOrderNumber: string | null
    poNumber: string | null
    notes: string | null
    grandTotalMinor: bigint | null
  }
}

/**
 * Read-only validation shared by `creditNoteCreateAndIssue` and its stage-time preflight export:
 * recipient completeness, notes, issuer, the original invoice, the over-credit guard and the
 * e-invoicing gate. ONE copy, so the staged and the executed refusal never drift apart.
 */
async function preflightCreditNoteCreateAndIssueParams(
  ctx: MutationsCtx,
  rawInput: CreditNoteCreateAndIssueInput,
  opts: CreditNoteIssueOptions = {},
): Promise<{ ok: true; prepared: CreditNoteCreatePrepared } | { ok: false; error: ErrorEnvelope }> {
  // Recipient completeness — refuse BEFORE idempotency lookups, gating and number allocation, so
  // an incomplete recipient never parks an approval card or consumes a document number. The tool's
  // JSON Schema already requires these fields, so this catches the in-process / cross-app callers
  // that bypass Ajv.
  const counterpartyErr = counterpartyCompletenessError(rawInput.counterparty)
  if (counterpartyErr) return { ok: false, error: { status: "error", error: counterpartyErr } }
  // Free-text notes, validated BEFORE gating so an over-long note never parks an approval card
  // or consumes a document number: trimmed, blank becomes null, over the cap is a typed error.
  const notes = normaliseNotes(rawInput.notes)
  if (!notes.ok) return { ok: false, error: notes.error }
  // A price that is not a whole number of minor units ("$1", "899.00") is refused here, before
  // gating, never guessed.
  const amountsErr = lineAmountsError(rawInput.items)
  if (amountsErr) return { ok: false, error: amountsErr }
  const input: Omit<CreditNoteCreateAndIssueInput, "items"> & { items: DraftLine[] } = {
    ...rawInput,
    items: normaliseDraftLines(rawInput.items ?? []),
  }

  const issuerResolution = await resolveIssuerProfileOrError(ctx.db, input.issuer_profile_id)
  if (!issuerResolution.ok) return { ok: false, error: issuerResolution.error }
  const issuer = issuerResolution.issuer

  // Validate the original document up front — before any gating/persistence — so a bad reference
  // fails fast with a clear error rather than issuing an orphaned credit note. original_document_id
  // accepts either the uuid or the visible document number (findDocumentSummary resolves both); we
  // keep the RESOLVED uuid (original.id) for everything persisted below, never the raw input, since
  // a number is not a stable foreign-key value.
  let originalNumber: string | null = null
  let originalIssuedAt: string | null = null
  let originalRef: IssueInput["original"] = null
  let originalDocumentUuid: string | null = null
  // Carried forward from the original invoice onto this credit note's own external_refs below —
  // makes the credit note's shopify_order_id column match the invoice it reverses, so the
  // one-invoice-per-order guard's scoped-by-shopify_order_id lookup (assertNoLiveInvoiceForOrder)
  // finds it without a separate, unbounded query.
  let originalShopifyOrderId: string | null = null
  let originalShopifyOrderNumber: string | null = null
  let originalPoNumber: string | null = null
  let originalNotes: string | null = null
  if (input.original_document_id) {
    const original = await findDocumentSummary(ctx.db, input.original_document_id)
    if (!original) {
      return {
        ok: false,
        error: {
          status: "error",
          error: {
            code: "not_found",
            message: `original_document_id ${input.original_document_id} not found`,
          },
        },
      }
    }
    if (original.type !== "invoice") {
      return {
        ok: false,
        error: {
          status: "error",
          error: {
            code: "invalid_original_document",
            message: `original_document_id ${input.original_document_id} is a ${original.type}, not an invoice: a credit note can only reference an invoice`,
          },
        },
      }
    }
    // Gate on the STATUS too, not just the TYPE — an invoice that is still a draft or sitting in
    // pending_approval was never sent to the customer, so a "reversal" against it is not a
    // reversal of anything real. Every caller (agent tool, the Shopify refund/cancel auto-flows)
    // funnels through this one check, so none of them can credit a non-issued document.
    if (!ISSUED_INVOICE_STATUSES.has(original.status ?? "draft")) {
      return {
        ok: false,
        error: {
          status: "error",
          error: {
            code: "invalid_original_document",
            message: `original_document_id ${input.original_document_id} has status "${original.status}", not an issued invoice: a credit note can only reverse a document that was actually issued to the customer`,
          },
        },
      }
    }
    originalNumber = original.number
    originalIssuedAt = original.issued_at
    originalRef = originalRefOf(original)
    originalDocumentUuid = original.id
    originalShopifyOrderId = original.shopify_order_id
    originalShopifyOrderNumber = original.shopify_order_number
    originalPoNumber = original.po_number
    originalNotes = original.notes
  }

  const currency = input.currency ?? "EUR"
  const twoEyesErr = await checkTwoEyes(ctx, issuer)
  if (twoEyesErr) return { ok: false, error: twoEyesErr }

  const classifyInput: ClassifyInput = {
    issuer_country: issuer.country,
    counterparty_country: taxCountryOf(input.counterparty),
    has_vat_id: !!input.counterparty.vat_id,
  }
  const { grand: total } = computeLineFinancials(input.items, classifyInput)
  const absTotal = total < 0n ? -total : total
  const originalForSign = originalDocumentUuid
    ? await findDocumentSummary(ctx.db, originalDocumentUuid)
    : null
  const signErr = creditNoteSignError(
    input.items,
    total,
    originalForSign?.grand_total_minor ?? null,
    currency,
  )
  if (signErr) return { ok: false, error: signErr }

  // Over-credit guard: a credit note against an invoice can never push the invoice's
  // cumulative credited total past the invoice's own grand total. Without this, a credit
  // note issued straight to 'issued' status (never voidable — see the module comment above)
  // could permanently over-reverse an invoice and land a wrong number in the accounts.
  // Reuses creditedTotalMinor/isFullyCredited (the same union-of-lifecycle-log-and-back-link
  // rule assertNoLiveInvoiceForOrder already relies on) rather than a third way to compute
  // credited-ness, so the remainder-only cancellation path, the refund handler and the
  // operator-approved reissue -- which all issue a credit note for AT MOST what remains
  // uncredited -- stay unaffected; only a credit note that would exceed the remainder is
  // refused.
  if (originalDocumentUuid) {
    const original = originalForSign
    if (original) {
      const candidateDocs = originalShopifyOrderId
        ? ((await ctx.db.findMany("documents", {
            where: { shopify_order_id: originalShopifyOrderId },
            limit: 20,
          })) as Array<Record<string, unknown>>)
        : undefined
      const alreadyCredited = await creditedTotalMinor(
        ctx.db,
        { id: original.id, lifecycle_log: original.lifecycle_log },
        candidateDocs,
      )
      const invoiceTotal =
        original.grand_total_minor < 0n ? -original.grand_total_minor : original.grand_total_minor
      const remaining = invoiceTotal - alreadyCredited
      if (absTotal > remaining) {
        return {
          ok: false,
          error: {
            status: "error",
            error: {
              code: "over_credit",
              message:
                `credit note of ${formatMoneyMinor(absTotal, currency)} would exceed invoice ${originalNumber ?? original.id}'s own total: ` +
                `${formatMoneyMinor(alreadyCredited, currency)} already credited, ` +
                `${formatMoneyMinor(remaining, currency)} remaining of ${formatMoneyMinor(invoiceTotal, currency)}. ` +
                `A credit note cannot exceed the invoice it reverses.`,
            },
          },
        }
      }
    }
  }

  // E-invoicing gate: a credit note follows its original's regime and buyer snapshot; a legacy
  // original (no stored regime) is classified from the current data.
  const paramsErr = einvoiceParamsError(input.counterparty, input.operation_category)
  if (paramsErr) return { ok: false, error: paramsErr }
  const gate = await checkEinvoiceGate(ctx, {
    type: "credit_note",
    issuer,
    counterparty: input.counterparty,
    lines: input.items,
    operation_category: input.operation_category ?? null,
    ...autoSourceGateFields(opts),
    original: originalRef,
  })
  if (!gate.ok) return { ok: false, error: gate.error }

  const when = await statedIssueDate(ctx, issuer, "credit_note", input.issued_at, {
    number: originalNumber,
    issued_at: originalIssuedAt,
  })
  if (!when.ok) return when

  return {
    ok: true,
    prepared: {
      rawInput,
      input,
      notes,
      issuer,
      currency,
      total,
      absTotal,
      when,
      original: {
        grandTotalMinor: originalForSign?.grand_total_minor ?? null,
        number: originalNumber,
        issuedAt: originalIssuedAt,
        ref: originalRef,
        uuid: originalDocumentUuid,
        shopifyOrderId: originalShopifyOrderId,
        shopifyOrderNumber: originalShopifyOrderNumber,
        poNumber: originalPoNumber,
        notes: originalNotes,
      },
    },
  }
}

/**
 * STAGE-TIME preflight for `credit_note_create_and_issue` (manifest `preflight`; the tool is
 * `conditionalGate`). Refuses an incomplete recipient, a bad original, an over-credit or missing
 * e-invoicing data before any approval request exists.
 */
export async function creditNoteCreateAndIssuePreflight(
  ctx: MutationsCtx,
  rawInput: CreditNoteCreateAndIssueInput,
): Promise<PreflightResult> {
  const pre = await preflightCreditNoteCreateAndIssueParams(ctx, rawInput)
  return toPreflightResult(pre.ok ? { ok: true } : pre)
}

type CreditNoteResult = MutationResult<{
  document_id: string
  number: string
  einvoicing_warning?: EinvoicingWarning
}>

/** A credit note ready to issue: its issuance input, and what runs once it is issued. */
export interface PreparedCreditNote {
  issueInput: IssueInput
  after(result: IssueResult): Promise<void>
}

export async function creditNoteCreateAndIssue(
  ctx: MutationsCtx,
  rawInputIn: CreditNoteCreateAndIssueInput,
  opts: CreditNoteIssueOptions = {},
): Promise<CreditNoteResult> {
  const prepared = await prepareCreditNoteCreateAndIssue(ctx, rawInputIn, opts)
  if (!prepared.ok) return prepared.result
  const issued = await issueWithFxRate(ctx, prepared.credit.issueInput)
  if (!issued.ok) return issued.error
  const result = issued.result
  await prepared.credit.after(result)
  return {
    status: "completed",
    document_id: result.document_id,
    number: result.number,
    ...(result.einvoicing_warning ? { einvoicing_warning: result.einvoicing_warning } : {}),
  }
}

/**
 * Everything `credit_note_create_and_issue` does before issuing (the checks, the approval gate,
 * the issuance input) and after it (the original's audit event), with nothing written: the caller
 * issues it, alone or in one commit with another document (order_reissue_apply).
 */
export async function prepareCreditNoteCreateAndIssue(
  ctx: MutationsCtx,
  rawInputIn: CreditNoteCreateAndIssueInput,
  opts: CreditNoteIssueOptions = {},
): Promise<
  | { ok: true; credit: PreparedCreditNote }
  | { ok: false; result: Exclude<CreditNoteResult, { status: "completed" }> }
> {
  const pre = await preflightCreditNoteCreateAndIssueParams(ctx, rawInputIn, opts)
  if (!pre.ok) return { ok: false, result: pre.error }
  const { rawInput, input, notes, issuer, currency, total, absTotal, when } = pre.prepared
  const originalNumber = pre.prepared.original.number
  const originalIssuedAt = pre.prepared.original.issuedAt
  const originalRef = pre.prepared.original.ref
  const originalDocumentUuid = pre.prepared.original.uuid
  const originalShopifyOrderId = pre.prepared.original.shopifyOrderId
  const originalShopifyOrderNumber = pre.prepared.original.shopifyOrderNumber
  const originalPoNumber = pre.prepared.original.poNumber
  const originalNotes = pre.prepared.original.notes

  const threshold =
    issuer.invoice_approval_threshold_minor != null
      ? toBigInt(issuer.invoice_approval_threshold_minor)
      : null
  if (!ctx.approval && creditNoteMustGate(threshold, absTotal, !!originalDocumentUuid)) {
    const approval = await ctx.requestApproval({
      tool_name: "invoicing:credit_note_create_and_issue",
      ...asHandlerSummary(
        issueCard({
          kind: "credit_note_create_and_issue",
          type: "credit_note",
          fromDraft: false,
          customer: input.counterparty.legal_name,
          country: input.counterparty.country,
          currency,
          lines: input.items,
          totalMinor: total,
          orderNumber: originalShopifyOrderNumber,
          reason: input.reason ?? null,
          originalNumber,
          originalDate: dateOnly(originalIssuedAt),
          originalTotalMinor: pre.prepared.original.grandTotalMinor,
          issuedAt: input.issued_at ?? null,
          issuerName: issuer.legal_name,
        }),
      ),
      current_payload: rawInput,
      editable_fields: ["items"],
      // An auto-approve policy the org set for this tool may approve it: then carry on.
      auto_approvable: true,
    })
    if (!approval.auto_approved) {
      return {
        ok: false,
        result: { status: "pending_approval", approval_id: approval.approval_id },
      }
    }
  }

  const externalRefs: Record<string, unknown> = {}
  // Persist the RESOLVED uuid, not the raw input (which may be a document number): this is a
  // stored back-link other tools resolve as a straight uuid `id` lookup.
  if (originalDocumentUuid) externalRefs.original_document_id = originalDocumentUuid
  // Persist the original's NUMBER too — the detail UI links the reversal
  // chain by number, and the PDF's reference line needs it on re-render.
  if (originalNumber) externalRefs.original_document_number = originalNumber
  if (input.reason) externalRefs.reason = input.reason
  // Inherit the order link from the original invoice (see the comment above where these are
  // read): issueDocument mirrors external_refs.shopify_order_id onto the credit note's own
  // top-level column, so a later one-invoice-per-order lookup for this order sees the credit
  // note too.
  if (originalShopifyOrderId) externalRefs.shopify_order_id = originalShopifyOrderId
  if (originalShopifyOrderNumber) externalRefs.shopify_order_number = originalShopifyOrderNumber
  // Explicit input wins; otherwise inherit the original invoice's own PO number so the
  // reversal carries the same customer reference without the caller having to look it up
  // and repeat it.
  const effectivePoNumber = input.po_number ?? originalPoNumber
  if (effectivePoNumber) externalRefs.po_number = effectivePoNumber
  // Explicit input wins; otherwise inherit the original invoice's notes so the reversal
  // carries the same mention (a contract reference the customer reads on both documents).
  // `notes.value === undefined` means the caller said nothing; an explicit null clears it.
  const effectiveNotes = notes.value === undefined ? originalNotes : notes.value

  const original = originalDocumentUuid
    ? await findDocumentSummary(ctx.db, originalDocumentUuid)
    : null
  const issueInput = {
    type: "credit_note" as const,
    issuer,
    counterparty: input.counterparty,
    draft: {
      currency,
      incoterm: input.incoterm ?? "DAP",
      year_of_issue: when.year_of_issue,
      issued_at: when.issued_at,
      due_at: null as string | null,
      external_refs: externalRefs,
      notes: effectiveNotes ?? null,
      lines: input.items,
    },
    original_invoice_number: originalNumber,
    original_invoice_date: dateOnly(originalIssuedAt),
    original: originalRef,
    operation_category: input.operation_category ?? null,
    ...autoSourceGateFields(opts),
    ...(opts.external_ref ? { external_ref: opts.external_ref } : {}),
    ...(opts.einvoice_send ? { einvoice_send: opts.einvoice_send } : {}),
    commit_with: original ? [await creditedOnOriginal(ctx, original)] : [],
  }
  const after = async (result: IssueResult): Promise<void> => {
    if (!original || !originalDocumentUuid) return
    // Kernel audit trail — mirrors the credit_note_issued lifecycle_log entry committed with the note.
    await ctx.emit({
      entity: "document",
      action: "credited",
      entityId: originalDocumentUuid,
      data: {
        document_id: originalDocumentUuid,
        type: original.type,
        number: original.number,
        status: original.status,
        currency: original.currency,
        grand_total_minor: original.grand_total_minor.toString(),
        credit_note_id: result.document_id,
        original_document_id: originalDocumentUuid,
      },
    })
  }
  return { ok: true, credit: { issueInput, after } }
}

/**
 * Read-only validation shared by `creditNoteIssue` and its stage-time preflight export: the
 * draft, its type and lines, the issuer, the original invoice, recipient completeness and the
 * e-invoicing gate.
 */
async function preflightCreditNoteIssueParams(
  ctx: MutationsCtx,
  input: { draft_id: string },
): Promise<
  | {
      ok: true
      draft: DraftRow
      issuer: IssuerProfileRow
      counterparty: Counterparty
      classifyInput: ClassifyInput
      original: {
        number: string | null
        ref: IssueInput["original"]
        issuedAt: string | null
        uuid: string | null
      }
    }
  | { ok: false; error: ErrorEnvelope }
> {
  const draft = await getDraft(ctx.db, input.draft_id)
  if (!draft) {
    return {
      ok: false,
      error: {
        status: "error",
        error: { code: "not_found", message: `draft ${input.draft_id} not found` },
      },
    }
  }
  if (draft.type !== "credit_note") {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "invalid_type",
          message: `expected draft.type=credit_note, got ${draft.type}`,
        },
      },
    }
  }
  if (!draft.lines || draft.lines.length === 0) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "empty_document",
          message:
            "cannot issue a credit note with no line items: add at least one line first (pass `items` to drafts_create, or `lines` to drafts_update) before issuing",
        },
      },
    }
  }
  const issuer = await findIssuerProfile(ctx.db, draft.issuer_profile_id)
  if (!issuer) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "issuer_not_found",
          message: `issuer_profile ${draft.issuer_profile_id} not found`,
        },
      },
    }
  }

  const twoEyesErr = await checkTwoEyes(ctx, issuer)
  if (twoEyesErr) return { ok: false, error: twoEyesErr }

  const draftRefs = draft.external_refs ?? {}
  const originalDocumentId =
    typeof draftRefs.original_document_id === "string"
      ? (draftRefs.original_document_id as string)
      : null
  let originalNumber: string | null = null
  let originalRef: IssueInput["original"] = null
  let originalIssuedAt: string | null = null
  let originalDocumentUuid: string | null = null
  let originalTotal: bigint | null = null
  if (originalDocumentId) {
    const original = await findDocumentSummary(ctx.db, originalDocumentId)
    if (!original) {
      return {
        ok: false,
        error: {
          status: "error",
          error: {
            code: "not_found",
            message: `original_document_id ${originalDocumentId} not found`,
          },
        },
      }
    }
    if (original.type !== "invoice") {
      return {
        ok: false,
        error: {
          status: "error",
          error: {
            code: "invalid_original_document",
            message: `original_document_id ${originalDocumentId} is a ${original.type}, not an invoice`,
          },
        },
      }
    }
    originalNumber = original.number
    originalIssuedAt = original.issued_at
    originalRef = originalRefOf(original)
    originalDocumentUuid = original.id
    originalTotal = original.grand_total_minor
  }

  const counterparty = counterpartyFromRow(draft, issuer)
  const cnIncompleteErr = counterpartyCompletenessError(counterparty)
  if (cnIncompleteErr) return { ok: false, error: { status: "error", error: cnIncompleteErr } }
  const classifyInput: ClassifyInput = {
    issuer_country: issuer.country,
    counterparty_country: taxCountryOf(counterparty),
    has_vat_id: !!counterparty.vat_id,
  }
  const signErr = creditNoteSignError(
    draft.lines,
    computeLineFinancials(draft.lines, classifyInput).grand,
    originalTotal,
    draft.currency ?? "EUR",
  )
  if (signErr) return { ok: false, error: signErr }
  // E-invoicing gate (credit note follows its original; a legacy original is classified from
  // the current data).
  const gate = await checkEinvoiceGate(ctx, {
    type: "credit_note",
    issuer,
    counterparty,
    lines: draft.lines,
    operation_category: draft.operation_category ?? null,
    original: originalRef,
  })
  if (!gate.ok) return { ok: false, error: gate.error }
  return {
    ok: true,
    draft,
    issuer,
    counterparty,
    classifyInput,
    original: {
      number: originalNumber,
      ref: originalRef,
      issuedAt: originalIssuedAt,
      uuid: originalDocumentUuid,
    },
  }
}

/** STAGE-TIME preflight for `credit_note_issue` (manifest `preflight`; `conditionalGate`). */
export async function creditNoteIssuePreflight(
  ctx: MutationsCtx,
  input: { draft_id: string },
): Promise<PreflightResult> {
  const pre = await preflightCreditNoteIssueParams(ctx, input)
  return toPreflightResult(pre.ok ? { ok: true } : pre)
}

export async function creditNoteIssue(
  ctx: MutationsCtx,
  input: { draft_id: string },
): Promise<
  MutationResult<{ document_id: string; number: string; einvoicing_warning?: EinvoicingWarning }>
> {
  const pre = await preflightCreditNoteIssueParams(ctx, input)
  if (!pre.ok) return pre.error
  const { draft, issuer, counterparty, classifyInput } = pre
  const originalNumber = pre.original.number
  const originalRef = pre.original.ref
  const originalIssuedAt = pre.original.issuedAt
  const originalDocumentUuid = pre.original.uuid
  const { grand: total } = computeLineFinancials(draft.lines, classifyInput)
  const absTotal = total < 0n ? -total : total
  const threshold =
    issuer.invoice_approval_threshold_minor != null
      ? toBigInt(issuer.invoice_approval_threshold_minor)
      : null
  if (!ctx.approval && creditNoteMustGate(threshold, absTotal, !!originalDocumentUuid)) {
    const approval = await ctx.requestApproval({
      tool_name: "invoicing:credit_note_issue",
      ...asHandlerSummary(
        issueCard({
          kind: "credit_note_issue",
          type: "credit_note",
          fromDraft: true,
          customer: counterparty.legal_name,
          country: counterparty.country,
          currency: draft.currency,
          lines: draft.lines,
          totalMinor: total,
          orderNumber: draft.shopify_order_number ?? null,
          originalNumber,
          originalDate: dateOnly(originalIssuedAt),
          issuerName: issuer.legal_name,
          draftId: draft.id,
        }),
      ),
      current_payload: { draft_id: draft.id },
      editable_fields: ["lines"],
      // An auto-approve policy the org set for this tool may approve it: then carry on.
      auto_approvable: true,
    })
    if (!approval.auto_approved) {
      return { status: "pending_approval", approval_id: approval.approval_id }
    }
  }

  const when = await issueDateParts(ctx, issuer)
  if (!when.ok) return when.error
  const original = originalDocumentUuid
    ? await findDocumentSummary(ctx.db, originalDocumentUuid)
    : null
  const issueInput = {
    ...buildIssueInputFromDraft(draft, issuer, counterparty, when),
    original_invoice_number: originalNumber,
    original_invoice_date: dateOnly(originalIssuedAt),
    original: originalRef,
    // The draft and the original's "credited" entry commit with the note: a re-run finds no
    // draft instead of crediting twice.
    commit_with: [
      { delete: "documents", id: draft.id },
      ...(original ? [await creditedOnOriginal(ctx, original)] : []),
    ],
  }
  const issued = await issueWithFxRate(ctx, issueInput)
  if (!issued.ok) return issued.error
  const result = issued.result

  if (originalDocumentUuid) {
    if (original) {
      // Kernel audit trail — mirrors the credit_note_issued lifecycle_log entry committed with the note.
      await ctx.emit({
        entity: "document",
        action: "credited",
        entityId: originalDocumentUuid,
        data: {
          document_id: originalDocumentUuid,
          type: original.type,
          number: original.number,
          status: original.status,
          currency: original.currency,
          grand_total_minor: original.grand_total_minor.toString(),
          credit_note_id: result.document_id,
          original_document_id: originalDocumentUuid,
        },
      })
    }
  }

  return {
    status: "completed",
    document_id: result.document_id,
    number: result.number,
    ...(result.einvoicing_warning ? { einvoicing_warning: result.einvoicing_warning } : {}),
  }
}

/** The original invoice's `credit_note_issued` entry, written in the same commit as the credit
 *  note it names (`$ref` / `$seq`: the note's id and number, known only inside that commit). */
async function creditedOnOriginal(
  ctx: MutationsCtx,
  original: { id: string },
): Promise<{ update: string; id: string; append: Record<string, unknown[]> }> {
  // Appended to the log as it is at commit: no transaction is held across the run, so an entry
  // another writer added since this run read the original is kept.
  return {
    update: "documents",
    id: original.id,
    append: {
      lifecycle_log: [
        {
          event: "credit_note_issued",
          actor: await ctx.getUserId(),
          ts: new Date().toISOString(),
          credit_note_id: { $ref: "document" },
          number: { $seq: "formatted" },
        },
      ],
    },
  }
}
