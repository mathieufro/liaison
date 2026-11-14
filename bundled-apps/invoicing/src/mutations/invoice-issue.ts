// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: invoice issuance (issue, create and issue) and their preflights.

import { asHandlerSummary, issueCard } from "../approval-cards"
import { type BuyerVatFacts, checkBuyerVat, needsHumanBuyerDecision } from "../buyer-vat"
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
  type IssueBatchOp,
  type IssueInput,
  taxCountryOf,
} from "../issue"
import { issueDateParts } from "../issue-date"
import { checkIssuerGuard, type GuardCtx } from "../issuer-guard"
import { runItemDraftRefusal } from "../recurring/run-card"
import type { ClassifyInput } from "../tax"
import { planTax } from "../tax-plan"
import { assertNoLiveInvoiceForOrder } from "./credit-coverage"
import {
  findIssuerProfile,
  getDraft,
  type IssuerProfileRow,
  rejectDraftOrderId,
  resolveIssuerProfileOrError,
  updateDraftRow,
} from "./db-helpers"
import { issueWithFxRate } from "./fx-issue"
import {
  buildIssueInputFromDraft,
  checkTwoEyes,
  computeLineFinancials,
  counterpartyFromRow,
  netLinesForIssuer,
  normaliseDraftLines,
} from "./lines"
import { checkDraftBuyer } from "./quote-proforma-po"
import {
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

/**
 * Read-only validation shared by `invoiceIssue` and its stage-time preflight export: the draft
 * resolves, is an invoice, carries lines, its issuer profile exists, and the recipient snapshot
 * is complete. ONE copy, called from both sides, so the staged refusal and the executed refusal
 * can never drift apart.
 */
async function preflightInvoiceIssueParams(
  ctx: MutationsCtx,
  input: { draft_id: string; billsOtherThanStripe?: string | null },
  forRun = false,
  stage: "preflight" | "handler" = "handler",
): Promise<
  | {
      ok: true
      draft: DraftRow
      issuer: IssuerProfileRow
      counterparty: Counterparty
      warning: EinvoicingWarning | null
      buyer: BuyerVatFacts
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
  // A month-end run's draft issues from its run's card only: never twice, never around it.
  if (!forRun) {
    const runRefusal = await runItemDraftRefusal(ctx, draft, "invoice_issue")
    if (runRefusal) return { ok: false, error: runRefusal }
  }
  if (draft.type !== "invoice") {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "invalid_type",
          message: `expected draft.type=invoice, got ${draft.type}`,
        },
      },
    }
  }
  // One customer, one issuer: a customer Stripe bills is not invoiced again by hand. A Shopify order
  // is its own sale, and a month-end row is checked by its run (recurring_item_issue).
  if (!forRun && !draft.shopify_order_id && !draft.external_refs?.shopify_order_id) {
    const guard = await checkIssuerGuard(ctx as GuardCtx, {
      contactId: draft.counterparty_contact_id,
      emails: [draft.counterparty_email],
      billsOtherThanStripe: input.billsOtherThanStripe,
      stage,
    })
    if (!guard.ok) return { ok: false, error: guard.error }
  }
  if (!draft.lines || draft.lines.length === 0) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "empty_document",
          message:
            "cannot issue an invoice with no line items: add at least one line first (pass `items` to drafts_create, or `lines` to drafts_update) before issuing",
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

  // Two-eyes (post-approval re-entry only — first-entry has no approval, so this is a no-op at
  // stage time and the ordering of the checks below is preserved exactly).
  const twoEyesErr = await checkTwoEyes(ctx, issuer)
  if (twoEyesErr) return { ok: false, error: twoEyesErr }

  // Running the classifier at gate time ensures the gate and the persisted grand_total_minor use
  // identical arithmetic — both include VAT at the classified rate — so the counterparty must be
  // the SAME one issueDocument will persist.
  const counterparty = counterpartyFromRow(draft, issuer)
  // Refuse an incomplete recipient BEFORE gating: no approval card is parked, and no invoice
  // number is consumed, for a document that could not legally be issued anyway.
  const incompleteErr = counterpartyCompletenessError(counterparty)
  if (incompleteErr) {
    return { ok: false, error: { status: "error", error: incompleteErr } }
  }
  const buyer = await checkDraftBuyer(ctx, draft, issuer, counterparty)
  if (!buyer.ok) return buyer
  const issuedCounterparty = buyer.counterparty
  // E-invoicing gate, same rule: a French business buyer without the data its e-invoice needs is
  // refused here (enforce) with the fields and the tools that fix them.
  const gate = await checkEinvoiceGate(ctx, {
    type: "invoice",
    issuer,
    counterparty: issuedCounterparty,
    lines: draft.lines,
    operation_category: draft.operation_category ?? null,
  })
  if (!gate.ok) return { ok: false, error: gate.error }
  return {
    ok: true,
    draft,
    issuer,
    counterparty: issuedCounterparty,
    warning: gate.warning,
    buyer: buyer.buyer,
  }
}

/**
 * STAGE-TIME preflight for the gated `invoice_issue` tool (manifest `preflight`). A gated call
 * must not be parked for a human when the data it needs is missing: an unresolvable draft, a
 * non-invoice draft, an empty one or an incomplete recipient is refused here, before the
 * approval request exists, so the agent fixes it instead of the approver hitting the wall.
 */
export async function invoiceIssuePreflight(
  ctx: MutationsCtx,
  input: { draft_id: string; billsOtherThanStripe?: string | null },
): Promise<PreflightResult> {
  return toPreflightResult(await preflightInvoiceIssueParams(ctx, input, false, "preflight"))
}

export async function invoiceIssue(
  ctx: MutationsCtx,
  input: { draft_id: string; due_at?: string | null; billsOtherThanStripe?: string | null },
): Promise<
  MutationResult<{ document_id: string; number: string; einvoicing_warning?: EinvoicingWarning }>
> {
  const pre = await preflightInvoiceIssueParams(ctx, input)
  if (!pre.ok) return pre.error
  let { draft } = pre
  const { issuer, counterparty } = pre
  // A corrected payment due date / terms (NET-30 → NET-60) may arrive either on
  // first call OR via approval_update_payload on the PENDING approval (re-entry
  // carries it on `input.due_at`). Apply it to the draft of record so the gate total,
  // the persisted document, and the agent's report all reflect the corrected terms —
  // pre-issuance, this is a normal safe edit. It happens AFTER the draft resolved and
  // validated: writing it first mutated the draft of record on a call that then failed,
  // leaving a document edited by a rejected request.
  if (input.due_at !== undefined && input.due_at !== null) {
    draft = await updateDraftRow(ctx.db, input.draft_id, { due_at: input.due_at })
  }
  const gateClassifyInput: ClassifyInput = {
    issuer_country: issuer.country,
    counterparty_country: taxCountryOf(counterparty),
    has_vat_id: !!counterparty.vat_id,
  }
  const { grand: total } = computeLineFinancials(draft.lines, gateClassifyInput)
  const threshold =
    issuer.invoice_approval_threshold_minor != null
      ? toBigInt(issuer.invoice_approval_threshold_minor)
      : null
  if (!ctx.approval && threshold != null && total > threshold) {
    const approval = await ctx.requestApproval({
      tool_name: "invoicing:invoice_issue",
      ...asHandlerSummary(
        issueCard({
          kind: "invoice_issue",
          type: "invoice",
          fromDraft: true,
          customer: counterparty.legal_name,
          country: counterparty.country,
          currency: draft.currency,
          lines: draft.lines,
          totalMinor: total,
          orderNumber: draft.shopify_order_number ?? null,
          poNumber: draft.po_number ?? null,
          dueAt: draft.due_at ?? null,
          issuerName: issuer.legal_name,
          draftId: input.draft_id,
        }),
      ),
      // Carry the draft's current due date / terms ON the approval payload so the
      // approver can SEE the terms and CORRECT them (NET-30 → NET-60) via
      // approval_update_payload before issuing. `due_at` is the editable field
      // (manifest editableFields); the re-entry above applies the corrected value.
      // Only include due_at when set — the schema types it as a string, so a null
      // would fail re-entry param validation; an unset due date is simply omitted.
      current_payload: draft.due_at
        ? { draft_id: input.draft_id, due_at: draft.due_at }
        : { draft_id: input.draft_id },
      editable_fields: ["due_at"],
    })
    // Granted inline (a person's own call holding the deciding scope): issue now.
    if (!approval.auto_approved) {
      return { status: "pending_approval", approval_id: approval.approval_id }
    }
  }
  const when = await issueDateParts(ctx, issuer)
  if (!when.ok) return when.error
  // The draft is discarded in the same commit as the invoice that replaces it, so a
  // re-invocation refuses with not_found rather than re-issuing.
  const issueInput = {
    ...buildIssueInputFromDraft(draft, issuer, counterparty, when),
    commit_with: [{ delete: "documents", id: input.draft_id }],
  }
  const issued = await issueWithFxRate(ctx, issueInput)
  if (!issued.ok) return issued.error
  const result = issued.result
  return {
    status: "completed",
    document_id: result.document_id,
    number: result.number,
    ...(result.einvoicing_warning ? { einvoicing_warning: result.einvoicing_warning } : {}),
  }
}

/**
 * Issue a month-end run's draft: the same checks and numbering as `invoice_issue`, with no card of
 * its own (the run's approval is that card). In one commit the draft gives up its `external_ref`,
 * the issued document takes it with the draft's change log, the draft is deleted and the caller's
 * `commit_with` writes land (`{ $ref: "document" }`, `{ $seq: "formatted" }`): all or nothing.
 */
export async function issueRunDraft(
  ctx: MutationsCtx,
  input: {
    draft_id: string
    external_ref: string
    lifecycle_log: Array<Record<string, unknown>>
    einvoice_send?: "stage" | "batch" | "held"
    commit_with?: IssueBatchOp[]
  },
): Promise<
  MutationResult<{ document_id: string; number: string; einvoicing_warning?: EinvoicingWarning }>
> {
  const pre = await preflightInvoiceIssueParams(ctx, input, true)
  if (!pre.ok) return pre.error
  const { draft, issuer, counterparty } = pre
  const when = await issueDateParts(ctx, issuer)
  if (!when.ok) return when.error
  const issueInput = buildIssueInputFromDraft(draft, issuer, counterparty, when)
  // The draft is discarded in the same commit as the invoice that replaces it.
  const issued = await issueWithFxRate(ctx, {
    ...issueInput,
    external_ref: input.external_ref,
    lifecycle_carry: input.lifecycle_log,
    ...(input.einvoice_send ? { einvoice_send: input.einvoice_send } : {}),
    commit_before: [{ update: "documents", id: input.draft_id, data: { external_ref: null } }],
    commit_with: [{ delete: "documents", id: input.draft_id }, ...(input.commit_with ?? [])],
  })
  if (!issued.ok) return issued.error
  return {
    status: "completed",
    document_id: issued.result.document_id,
    number: issued.result.number,
    ...(issued.result.einvoicing_warning
      ? { einvoicing_warning: issued.result.einvoicing_warning }
      : {}),
  }
}

export interface InvoiceCreateAndIssueInput {
  counterparty: Counterparty
  /** When omitted, defaults to the org's sole issuer profile; a typed error is
   *  returned if the org has zero or several (see resolveIssuerProfileOrError). */
  issuer_profile_id?: string | null
  currency: string
  incoterm?: string
  due_at?: string | null
  /** Optional Shopify order id/name to LINK + IDEMPOTENTLY DEDUPE this invoice
   *  (same contract as DraftsCreateInput.shopify_order_id): one invoice per
   *  order — a second create for an already-invoiced order is refused. */
  shopify_order_id?: string | null
  /** The order's HUMAN name ("#1149"), printed on the invoice and indexed for search. */
  shopify_order_number?: string | null
  /** The customer's purchase order number, when they gave one. Printed as a "PO number"
   *  line on the invoice PDF and indexed for documents_search. */
  po_number?: string | null
  /** Free-text notes printed on the document PDF under the totals (contract reference, extra
   *  customs information, a special mention). Non financial: trimmed, blank becomes null, and
   *  refused past NOTES_MAX_LENGTH characters. Stays editable after issue via documents_update. */
  notes?: string | null
  /** E-invoicing: the goods / services category of the operation. Required (with the buyer's
   *  data) when the invoice is a French business e-invoice; line kinds alone never decide it. */
  operation_category?: OperationCategory | null
  /** The intra-EU buyer is a private consumer although the org's data suggests a business
   *  (see QuoteCreateAndIssueInput.buyer_is_consumer). */
  buyer_is_consumer?: boolean | null
  /** What this invoice bills when the customer also pays a live Stripe subscription (a person's statement). */
  billsOtherThanStripe?: string | null
  items: DraftLineInput[]
}

/**
 * Read-only validation shared by `invoiceCreateAndIssue` and its stage-time preflight export:
 * recipient completeness, notes length, the Shopify draft-order-id trap, the one-live-invoice-per-order
 * duplicate guard and issuer resolution. ONE copy, called from both sides, so a staged refusal and an
 * executed refusal can never drift apart.
 */
async function preflightInvoiceCreateAndIssueParams(
  ctx: MutationsCtx,
  rawInput: InvoiceCreateAndIssueInput,
  opts: InvoiceCreateAndIssueOptions = {},
  stage: "preflight" | "handler" = "handler",
): Promise<
  | {
      ok: true
      input: Omit<InvoiceCreateAndIssueInput, "items"> & { items: DraftLine[] }
      notes: { value: string | null | undefined }
      issuer: IssuerProfileRow
      buyer: BuyerVatFacts | null
    }
  | { ok: false; error: ErrorEnvelope }
> {
  // Recipient completeness — refuse BEFORE idempotency lookups, gating and number allocation, so
  // an incomplete recipient never parks an approval card or consumes a document number. The tool's
  // JSON Schema already requires these fields, so this catches the in-process / cross-app callers
  // that bypass Ajv.
  const counterpartyErr = counterpartyCompletenessError(rawInput.counterparty)
  if (counterpartyErr) {
    return { ok: false, error: { status: "error", error: counterpartyErr } }
  }
  // Free-text notes, validated BEFORE gating so an over-long note never parks an approval card
  // or consumes a document number: trimmed, blank becomes null, over the cap is a typed error.
  const notes = normaliseNotes(rawInput.notes)
  if (!notes.ok) return { ok: false, error: notes.error }
  // A price that is not a whole number of minor units ("$1", "899.00") is refused here, before
  // gating, never guessed.
  const amountsErr = lineAmountsError(rawInput.items)
  if (amountsErr) return { ok: false, error: amountsErr }
  // Wire payloads deliver bigint fields as strings (JSON); coerce at the
  // boundary so the math helpers don't trip on mixed-type comparisons.
  // items defaults to [] so callers that omit it don't crash on .map().
  // `items` is canonicalised to the strict normalised `DraftLine[]` here (loose wire input →
  // minor-unit bigint / decimal-string quantity), so the downstream math/issue path sees strict types.
  const input: Omit<InvoiceCreateAndIssueInput, "items"> & { items: DraftLine[] } = {
    ...rawInput,
    items: normaliseDraftLines(rawInput.items ?? []),
  }
  // Guard the DRAFT-ORDER trap: a weak model sometimes passes a Shopify
  // *draft*-order id (`gid://shopify/DraftOrder/<n>`) where a *completed* order id
  // belongs. Such an id can never link to a real order, so instead of silently
  // creating an unlinked invoice against a draft-order id, refuse it with a TYPED,
  // explicit error naming the mistake. (Only the unmistakable DraftOrder gid is
  // rejected — a bare numeric id is still accepted, since completed orders are
  // routinely passed unprefixed.)
  const draftOrderErr = rejectDraftOrderId(input.shopify_order_id)
  if (draftOrderErr) return { ok: false, error: draftOrderErr }
  // IDEMPOTENCY — one invoice per Shopify order, the SAME guard drafts_create uses
  // (assertNoLiveInvoiceForOrder): when the caller links a shopify_order_id, refuse a second
  // live document for an order that already has one, with a clear agent-readable error naming
  // the existing document. Sharing the one implementation is deliberate — this function used to
  // carry its own stale copy that blocked on ANY existing document, credited or not, which is
  // the guard the real paid-order auto-issue flow calls, so that copy was the actual source of
  // the reported "cannot invoice a modified order" symptom.
  if (input.shopify_order_id) {
    try {
      await assertNoLiveInvoiceForOrder(ctx.db, input.shopify_order_id, {
        creditedInSameCommit: opts.replacesInvoiceId,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        error: {
          status: "error",
          error: {
            code: "already_invoiced",
            message: message.replace(/^already_invoiced:\s*/, ""),
          },
        },
      }
    }
  }
  // One customer, one issuer: a customer a live Stripe subscription bills is not invoiced again by
  // hand. A Shopify order is its own sale.
  if (!input.shopify_order_id) {
    const guard = await checkIssuerGuard(ctx as GuardCtx, {
      contactId: input.counterparty.contact_id ?? null,
      emails: [input.counterparty.email],
      billsOtherThanStripe: input.billsOtherThanStripe,
      stage,
    })
    if (!guard.ok) return { ok: false, error: guard.error }
  }
  // Threshold check happens BEFORE persisting any draft — keeps the "above
  // threshold → no draft persisted as document" invariant the tests pin.
  // Resolve the issuer safely: default to the sole profile, or return a typed
  // error (ambiguous / none / not-found) rather than a NULL that 23502s at insert.
  const issuerResolution = await resolveIssuerProfileOrError(ctx.db, input.issuer_profile_id)
  if (!issuerResolution.ok) return { ok: false, error: issuerResolution.error }
  const issuer = issuerResolution.issuer
  const twoEyesErrCreate = await checkTwoEyes(ctx, issuer)
  if (twoEyesErrCreate) return { ok: false, error: twoEyesErrCreate }
  // Intra-EU business or consumer (buyer-vat.ts): refused with the evidence, or the VAT number an
  // earlier document carries filled in.
  const buyerCheck = await checkBuyerVat(ctx, {
    issuerCountry: issuer.country,
    taxCountry: taxCountryOf(input.counterparty),
    counterparty: input.counterparty,
    buyerIsConsumer: input.buyer_is_consumer,
  })
  if (!buyerCheck.ok) return { ok: false, error: buyerCheck.error }
  if (buyerCheck.facts.vat_id && !input.counterparty.vat_id) {
    input.counterparty = { ...input.counterparty, vat_id: buyerCheck.facts.vat_id }
  }
  // E-invoicing gate: refused here (enforce), before any approval card or number.
  const paramsErr = einvoiceParamsError(input.counterparty, input.operation_category)
  if (paramsErr) return { ok: false, error: paramsErr }
  const gate = await checkEinvoiceGate(ctx, {
    type: "invoice",
    issuer,
    counterparty: input.counterparty,
    lines: input.items,
    operation_category: input.operation_category ?? null,
  })
  if (!gate.ok) return { ok: false, error: gate.error }
  return { ok: true, input, notes, issuer, buyer: buyerCheck.facts }
}

/**
 * STAGE-TIME preflight for the gated `invoice_create_and_issue` tool (manifest `preflight`).
 * A gated call must not be parked for a human when the data it needs is missing: an incomplete
 * recipient, an over-long note, a Shopify draft-order id, an order that ALREADY has a live
 * invoice, or an ambiguous issuer is refused here, before the approval request exists.
 */
export async function invoiceCreateAndIssuePreflight(
  ctx: MutationsCtx,
  rawInput: InvoiceCreateAndIssueInput,
): Promise<PreflightResult> {
  return toPreflightResult(
    await preflightInvoiceCreateAndIssueParams(ctx, rawInput, {}, "preflight"),
  )
}

type InvoiceCreateResult = MutationResult<{
  document_id: string
  number: string
  einvoicing_warning?: EinvoicingWarning
}>

export interface InvoiceCreateAndIssueOptions {
  /** The order's live invoice that a credit note issued IN THE SAME COMMIT fully reverses
   *  (order_reissue_apply): it does not count as the order's live invoice. */
  replacesInvoiceId?: string
}

export async function invoiceCreateAndIssue(
  ctx: MutationsCtx,
  rawInput: InvoiceCreateAndIssueInput,
): Promise<InvoiceCreateResult> {
  const prepared = await prepareInvoiceCreateAndIssue(ctx, rawInput)
  if (!prepared.ok) return prepared.result
  const issued = await issueWithFxRate(ctx, prepared.issueInput)
  if (!issued.ok) return issued.error
  const result = issued.result
  return {
    status: "completed",
    document_id: result.document_id,
    number: result.number,
    ...(result.einvoicing_warning ? { einvoicing_warning: result.einvoicing_warning } : {}),
  }
}

/**
 * Everything `invoice_create_and_issue` does before issuing (the checks, the approval gate, the
 * issuance input), with nothing written: the caller issues it, alone or in one commit with
 * another document (order_reissue_apply).
 */
export async function prepareInvoiceCreateAndIssue(
  ctx: MutationsCtx,
  rawInput: InvoiceCreateAndIssueInput,
  opts: InvoiceCreateAndIssueOptions = {},
): Promise<
  | { ok: true; issueInput: IssueInput }
  | { ok: false; result: Exclude<InvoiceCreateResult, { status: "completed" }> }
> {
  // The duplicate-invoice and issuer-resolution guards below ALSO run at stage time (the
  // preflight export above shares this exact code), but they stay here: an order can acquire a
  // live invoice between staging and approval, so the executed call re-checks rather than trusts.
  const pre = await preflightInvoiceCreateAndIssueParams(ctx, rawInput, opts)
  if (!pre.ok) return { ok: false, result: pre.error }
  const { input, notes, issuer, buyer } = pre

  const createClassifyInput: ClassifyInput = {
    issuer_country: issuer.country,
    counterparty_country: taxCountryOf(input.counterparty),
    has_vat_id: !!input.counterparty.vat_id,
  }
  const taxPlan = planTax({
    issuerCountry: issuer.country,
    pricesIncludeTax: issuer.prices_include_tax === true,
    taxCountry: createClassifyInput.counterparty_country,
    hasVatId: createClassifyInput.has_vat_id,
    lines: input.items,
  })
  // Typed prices are gross under an issuer with prices_include_tax (see netLinesForIssuer).
  input.items = netLinesForIssuer(input.items, issuer, createClassifyInput)
  const { grand: total } = computeLineFinancials(input.items, createClassifyInput)
  const threshold =
    issuer.invoice_approval_threshold_minor != null
      ? toBigInt(issuer.invoice_approval_threshold_minor)
      : null
  // A consumer the agent declared against business evidence is decided by a person, whatever the
  // threshold says (buyer-vat.ts).
  if (
    !ctx.approval &&
    ((threshold != null && total > threshold) || needsHumanBuyerDecision(buyer))
  ) {
    const approval = await ctx.requestApproval({
      tool_name: "invoicing:invoice_create_and_issue",
      ...asHandlerSummary(
        issueCard({
          kind: "invoice_create_and_issue",
          type: "invoice",
          fromDraft: false,
          customer: input.counterparty.legal_name,
          country: input.counterparty.country,
          tax: taxPlan,
          taxCountry: createClassifyInput.counterparty_country,
          buyer,
          currency: input.currency,
          lines: input.items,
          totalMinor: total,
          orderNumber: input.shopify_order_number ?? null,
          poNumber: input.po_number ?? null,
          dueAt: input.due_at ?? null,
          issuerName: issuer.legal_name,
        }),
      ),
      // Pass the ORIGINAL wire payload (string money), not the normalised one:
      // `current_payload` crosses the JSON bridge and is persisted as the
      // approval's re-entry params. Normalised lines carry bigint
      // `unit_price_minor`, which is not JSON-serialisable; the tool re-normalises
      // on re-entry anyway, so the string form is both safe and faithful.
      current_payload: rawInput,
      editable_fields: ["items"],
    })
    // Granted inline (a person's own call holding the deciding scope): issue now.
    if (!approval.auto_approved) {
      return {
        ok: false,
        result: { status: "pending_approval", approval_id: approval.approval_id },
      }
    }
  }

  const when = await issueDateParts(ctx, issuer)
  if (!when.ok) return { ok: false, result: when.error }
  const issueInput: IssueInput = {
    type: "invoice" as const,
    issuer,
    counterparty: input.counterparty,
    operation_category: input.operation_category ?? null,
    draft: {
      currency: input.currency,
      incoterm: input.incoterm ?? "DAP",
      year_of_issue: when.year_of_issue,
      issued_at: when.issued_at,
      due_at: input.due_at ?? null,
      external_refs: {
        ...(input.shopify_order_id ? { shopify_order_id: input.shopify_order_id } : {}),
        ...(input.shopify_order_number ? { shopify_order_number: input.shopify_order_number } : {}),
        ...(input.po_number ? { po_number: input.po_number } : {}),
        ...(buyer?.buyer_is_consumer ? { buyer_is_consumer: true } : {}),
      },
      notes: notes.value ?? null,
      lines: input.items,
    },
  }
  return { ok: true, issueInput }
}
