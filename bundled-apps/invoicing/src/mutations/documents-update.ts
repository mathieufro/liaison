// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: documents.update (post-issue editing in place).

import { type BuyerVatFacts, checkBuyerVat, consumerDeclaredAgainstEvidence } from "../buyer-vat"
import {
  type DraftLine,
  type DraftLineInput,
  enrichLineCustoms,
  type IssueBatchOp,
  readRefString,
} from "../issue"
import { issueDateParts } from "../issue-date"
import { documentRollup, lineSubtotal, lineTax, lineTotal } from "../money"
import { type DocumentFull, documentsGet, isUuid, type ReadsCtx } from "../reads"
import { runItemDraftRefusal } from "../recurring/run-card"
import { type ClassifyInput, classify } from "../tax"
import { dateOnly, FOREIGN_ID_CHARS, findIssuerProfile, isCalendarDate } from "./db-helpers"
import { liftMisplacedCountry, netLinesForIssuer, normaliseDraftLine } from "./lines"
import { ensureDocumentPdf } from "./pdf"
import {
  type ErrorEnvelope,
  lineAmountsError,
  type MutationResult,
  type MutationsCtx,
  normaliseCustomerReference,
  normaliseNotes,
  type PreflightResult,
  toPreflightResult,
} from "./shared"

// ─────────────────────────────────────────────────────────────────────────
// documents.update — Sufio-style POST-ISSUE editing. Unlike drafts_update
// (drafts only), this edits an already-issued (or draft) document IN PLACE:
// counterparty snapshot fields, incoterm, issued_at/due_at, tax_treatment,
// and — when `lines` is supplied — a full line replacement with totals
// recomputed exactly like the issue path (classify() → per-line tax →
// document rollup). `number` / `type` / `status` / `issuer_profile_id` /
// `currency` are immutable here — there is no param for them.
// ─────────────────────────────────────────────────────────────────────────

/** Statuses that make a document immutable — no field, including lines, may change. */
const NOT_EDITABLE_STATUSES = new Set(["voided", "cancelled"])

/** Document types that are NOT accounting documents: never frozen after issue. */
const NON_ACCOUNTING_TYPES: ReadonlySet<string> = new Set(["proforma", "quote", "purchase_order"])

/**
 * Fields of a documents_update payload that change the FINANCIAL SUBSTANCE of a
 * document. Once an INVOICE or CREDIT NOTE is ISSUED (any non-draft status), these are FROZEN:
 * a French issuer's issued invoice is legally immutable, and a correction to any
 * of these goes through a CREDIT NOTE, never an in-place edit. Harmless metadata
 * (address/email/linked contact/incoterm/dates) stays editable post-issue so the
 * Sufio-style correction of a typo'd address still works.
 */
const ISSUED_FROZEN_FIELDS: ReadonlyArray<keyof DocumentsUpdateInput> = [
  "lines",
  "tax_treatment",
  "counterparty_name",
  "counterparty_vat_id",
]

/** Fields the legal original carries (BT-2, BT-9, the buyer's name, VAT id, country and address
 *  BT-50..55, the delivery party BG-13/BG-15 and its name, the lines and their tax): locked once a
 *  legal original exists, so no later copy can contradict it. The customer's purchase order number
 *  stays amendable after issue (a reference, deliberately not carried in the CII). */
const LEGAL_ORIGINAL_LOCKED_FIELDS: ReadonlyArray<keyof DocumentsUpdateInput> = [
  "lines",
  "tax_treatment",
  "counterparty_name",
  "counterparty_vat_id",
  "counterparty_country",
  "counterparty_address",
  "counterparty_shipping_address",
  "counterparty_shipping_name",
  "issued_at",
  "due_at",
]

/** A date column compares on its day only (a timestamp and its YYYY-MM-DD are the same value). */
function k10(v: unknown): number {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? 10 : Number.MAX_SAFE_INTEGER
}

export interface DocumentsUpdateInput {
  id: string
  counterparty_name?: string | null
  counterparty_address?: string | null
  /** Ship to snapshot. RENDER ONLY: printed as the PDF's SHIP TO block when it differs from the
   *  billing address, and never an input to `classify()`, which keys off counterparty_country. */
  counterparty_shipping_address?: string | null
  counterparty_shipping_name?: string | null
  counterparty_vat_id?: string | null
  counterparty_email?: string | null
  counterparty_country?: string | null
  counterparty_contact_id?: string | null
  incoterm?: string
  issued_at?: string | null
  due_at?: string | null
  /** The customer's purchase order number. Non financial reference metadata, same class as
   *  address/email/incoterm/dates: editable on a draft AND on an already-issued document. */
  po_number?: string | null
  /** INTERNAL, caller scoped, never in the manifest params (same pattern as `lines_are_net`
   *  above) — labels the `po_number_changed` audit entry's `source`. Every manifest-exposed
   *  caller (the documents_update agent/UI tool) is a human decision, even when relayed by an
   *  agent, so the default "person" is correct there. Reserved for a future Shopify sync that
   *  overwrites a document's PO number from an order/draft-order update with no human step in
   *  between (none exists yet in this codebase) — that caller would set this to "shopify_sync"
   *  so the log says plainly where the change came from. */
  po_number_source?: "shopify_sync" | "person"
  /** Free-text notes printed on the document. Non financial reference metadata, same class as
   *  po_number / address / dates: NOT in ISSUED_FROZEN_FIELDS, so it is editable on a draft AND
   *  on an already issued, sent or paid document, and the edit re-renders the PDF. Null or a
   *  blank string clears it; over NOTES_MAX_LENGTH characters is a typed `notes_too_long`
   *  error. */
  notes?: string | null
  /** The caller's own reference for this customer in another system (e.g. a CRM record id),
   *  printed as "Customer ref". Non financial, editable at any status like po_number. Stored on
   *  `external_refs.customer_reference`; null or blank clears it. */
  customer_reference?: string | null
  tax_treatment?: string | null
  /** The intra-EU buyer is a private consumer although the org's data suggests a business
   *  (buyer-vat.ts). Recorded on `external_refs.buyer_is_consumer`. */
  buyer_is_consumer?: boolean | null
  lines?: DraftLineInput[]
  /** INTERNAL, caller scoped, never in the manifest params so no agent or UI caller can set it.
   *  Set ONLY by onShopifyDraftOrderUpsert (handlers/shopify-draft-order.ts) when `lines` was
   *  built by draftOrderLinesToItems, which already netted them via netOfIncludedTax — telling
   *  documentsUpdate not to net them a second time. This must be scoped to the CALL, not to the
   *  document: keying off the document row (e.g. "this document has a shopify_draft_order_id")
   *  would exempt EVERY caller of that document from netting, including the Editor's own
   *  documents_update save on the same open quote, which sends genuinely GROSS lines and needs
   *  them netted. Only the sync handler knows its own lines are already net; nothing else does. */
  lines_are_net?: boolean
}

/** Recompute per-line subtotal/tax/total + the document rollup for a REPLACED line set, mirroring
 *  issueDocument's snapshot-building loop — INCLUDING the same customs-overlay enrichment
 *  (enrichLineCustoms, shared with issueDocument in issue.ts): an explicit hs_code/country_of_origin/
 *  customs_description on the line always wins, a blank field falls back to the
 *  product_customs_overlay for (product_source, external_id) when the caller supplies those. */
async function recomputeLines(
  ctx: MutationsCtx,
  lines: DraftLine[],
  classifyInput: ClassifyInput,
): Promise<{
  lineRows: Array<Omit<LineInsertLike, "document_id" | "id">>
  rollup: { subtotal_minor: bigint; tax_total_minor: bigint; grand_total_minor: bigint }
}> {
  const classification = classify(classifyInput)
  const lineRows: Array<Omit<LineInsertLike, "document_id" | "id">> = []
  for (const [idx, l] of lines.entries()) {
    const enriched = await enrichLineCustoms(ctx, l, classification.requires_hs_code)
    const tax_rate_bp =
      typeof l.tax_rate_bp_override === "number"
        ? l.tax_rate_bp_override
        : classification.default_rate_bp
    // Discount is subtracted from the line subtotal and carried on the row,
    // exactly as the issue path does it (issue.ts). It used to be dropped here:
    // `recomputeLines` never read `discount_minor` and the document_lines insert
    // below never wrote the column, so EVERY documents_update that replaced
    // lines silently billed the undiscounted price — the Shopify draft-order
    // sync on every edit, the Editor saving an open quote, and the agent's own
    // documents_update alike. Quote QUO-2026-0006 lost a 25.48 line discount
    // this way and the customer was quoted the full price.
    const discount_minor = l.discount_minor ?? 0n
    const subtotal_minor =
      lineSubtotal({ quantity: l.quantity, unit_price_minor: l.unit_price_minor }) - discount_minor
    const tax_minor = lineTax({ subtotal_minor, tax_rate_bp })
    const total_minor = lineTotal({ subtotal_minor, tax_minor })
    lineRows.push({
      // 1-based like the issue path — a replaced line set must not renumber
      // the document's items from 0 (shows as "# 0" on the PDF and detail).
      position: l.position ?? idx + 1,
      description: l.description,
      quantity: l.quantity,
      unit_price_minor: l.unit_price_minor,
      discount_minor,
      tax_rate_bp,
      subtotal_minor,
      tax_minor,
      total_minor,
      hs_code: enriched.hs_code,
      country_of_origin: enriched.country_of_origin,
      customs_description: enriched.customs_description,
      product_source: l.product_source,
      external_id: l.external_id,
    })
  }
  const rollup = documentRollup(lineRows)
  return { lineRows, rollup }
}

interface LineInsertLike {
  document_id: string
  id: string
  position: number
  description: string
  quantity: string
  unit_price_minor: bigint
  /** Per-line discount in minor units, already subtracted from `subtotal_minor`
   *  and rendered explicitly on the document (never folded into the price). */
  discount_minor?: bigint
  tax_rate_bp: number
  subtotal_minor: bigint
  tax_minor: bigint
  total_minor: bigint
  hs_code: string | null
  country_of_origin: string | null
  customs_description: string | null
  product_source: string | null
  external_id: string | null
}

/** documents_update columns that are internal/rendering bookkeeping, never lifecycle-meaningful
 *  to a human reading the kernel audit trail — excluded from document:updated's changed_fields
 *  gate. */
const DOCUMENT_UPDATED_NOISE_FIELDS = new Set([
  "pdf_status",
  "pdf_file_id",
  "lifecycle_log",
  "updated_at",
])
/** Columns whose VALUE must never reach the audit trail (line items / PII) even though the field
 *  NAME is fine to list in changed_fields. */
const DOCUMENT_UPDATED_DIFF_EXCLUDED_FIELDS = new Set([
  "lines",
  "counterparty_address",
  // A ship to is the postal address of a real person: PII of exactly the same class as
  // counterparty_address, so its VALUE never reaches the audit trail either.
  "counterparty_shipping_address",
  "counterparty_shipping_name",
  "counterparty_email",
  // Free-text prose an operator typed for the customer to read. The audit trail records THAT
  // the notes changed (the field name stays in changed_fields); pasting the before/after prose
  // into every kernel event is noise at best and copies whatever the operator wrote (an
  // internal remark, a customer's own words) into a second store.
  "notes",
])

type DocumentsUpdateResult = MutationResult<{
  id: string
  number: string | null
  document_status: string
  subtotal_minor: string
  tax_total_minor: string
  grand_total_minor: string
  lifecycle_log: Array<Record<string, unknown>>
  pdf_status: string | null
  lines: Array<Record<string, unknown>>
}>

export async function documentsUpdate(
  ctx: MutationsCtx,
  rawInput: DocumentsUpdateInput,
): Promise<DocumentsUpdateResult> {
  const r = await documentsUpdateRun(ctx, rawInput, false)
  if ("ok" in r) throw new Error("documents_update: the preflight result reached the executed call")
  return r
}

/**
 * documents_update's stage-time check: every validation the executed call makes, the intra-EU
 * business-buyer guard included, and no write, so a call the handler would refuse is refused
 * BEFORE an approval card is parked for a person to decide in vain.
 */
export async function documentsUpdatePreflight(
  ctx: MutationsCtx,
  rawInput: DocumentsUpdateInput,
): Promise<PreflightResult> {
  const r = await documentsUpdateRun(ctx, rawInput, true)
  if ("ok" in r) return toPreflightResult(r)
  if (r.status === "error") return { error: r.error }
  return { ok: true }
}

/**
 * Read behind the documents_update approval card (manifest `summarizerContext`): the document as
 * documents_get returns it, plus what the business-buyer guard makes of the edit (`buyer_preview`),
 * so the card lists the evidence when the agent declares the buyer a private consumer against it.
 * Read-only: the preflight path of the update, which writes nothing.
 */
export async function documentsUpdatePreview(
  ctx: MutationsCtx & ReadsCtx,
  rawInput: DocumentsUpdateInput,
): Promise<
  Partial<DocumentFull> & { buyer_preview: BuyerVatFacts | null; buyer_refusal: string | null }
> {
  const doc = await documentsGet(ctx, { id: String(rawInput?.id ?? "") })
  const r = await documentsUpdateRun(ctx, rawInput, true)
  const buyerPreview = "ok" in r ? r.buyer : null
  const refusal = !("ok" in r) && r.status === "error" ? r.error.message : null
  return { ...(doc ?? {}), buyer_preview: buyerPreview, buyer_refusal: refusal }
}

function dateRefused(code: string, message: string): ErrorEnvelope {
  return { status: "error", error: { code, message } }
}

/** How to correct a date this document cannot take: an accounting document needs a credit note. */
function dateCorrectionHint(doc: Record<string, unknown>, isAccountingDocument: boolean): string {
  if (!isAccountingDocument) {
    const noun = doc.type === "purchase_order" ? "purchase order" : String(doc.type)
    return `To date it differently, issue a new ${noun}.`
  }
  return doc.type === "credit_note"
    ? "To correct it, issue a new credit note with the right date."
    : "To correct it, issue a credit note (credit_note_create_and_issue, referencing this invoice) and a new invoice."
}

/**
 * The nearest numbers before and after `numberInt` in its series that carry a date. Pages through
 * the (issuer, type, year) series: the bridge's `where` has equality and `in`, no range. A date
 * change on an issued document is rare and a person decides it, so reading the series is fine.
 */
async function neighbouringNumbers(
  ctx: MutationsCtx,
  doc: Record<string, unknown>,
  numberInt: number,
): Promise<{ previous: Record<string, unknown> | null; next: Record<string, unknown> | null }> {
  const PAGE = 500
  let previous: Record<string, unknown> | null = null
  for (let offset = 0; ; offset += PAGE) {
    const rows = (await ctx.db.findMany("documents", {
      where: {
        issuer_profile_id: doc.issuer_profile_id,
        type: doc.type,
        year_of_issue: doc.year_of_issue,
      },
      orderBy: { number_int: "asc" },
      limit: PAGE,
      offset,
      select: ["id", "number", "number_int", "issued_at"],
    })) as Array<Record<string, unknown>>
    for (const row of rows) {
      if (row.number_int == null || !dateOnly(row.issued_at)) continue
      const n = Number(row.number_int)
      if (n < numberInt) previous = row
      else if (n > numberInt) return { previous, next: row }
    }
    if (rows.length < PAGE) return { previous, next: null }
  }
}

/** The date a change would give an invoice or credit note, against the other side of the correction. */
async function correctionOrderRefusal(
  ctx: MutationsCtx,
  doc: Record<string, unknown>,
  date: string,
  label: string,
): Promise<ErrorEnvelope | null> {
  if (doc.type === "credit_note") {
    const refs = (doc.external_refs ?? {}) as Record<string, unknown>
    const originalId = doc.original_document_id ?? refs.original_document_id
    if (typeof originalId !== "string" || !originalId) return null
    const [original] = (await ctx.db.findMany("documents", {
      where: { id: originalId },
      select: ["number", "issued_at"],
      limit: 1,
    })) as Array<Record<string, unknown>>
    const originalDate = dateOnly(original?.issued_at)
    if (!originalDate || date >= originalDate) return null
    return dateRefused(
      "issue_date_before_original",
      `${date} is before ${String(original?.number)} (${originalDate}), the invoice ${label} corrects. Nothing was ` +
        "changed. Pass that date or a later one.",
    )
  }
  if (doc.type !== "invoice") return null
  const notes = (await ctx.db.findMany("documents", {
    where: { original_document_id: doc.id, type: "credit_note" },
    orderBy: { issued_at: "asc" },
    select: ["number", "issued_at"],
    limit: 1,
  })) as Array<Record<string, unknown>>
  const noteDate = dateOnly(notes[0]?.issued_at)
  if (!noteDate || date <= noteDate) return null
  return dateRefused(
    "issue_date_after_credit_note",
    `${date} is after ${String(notes[0]?.number)} (${noteDate}), a credit note that corrects ${label}. Nothing was ` +
      "changed. Pass that date or an earlier one.",
  )
}

/**
 * A number and its date belong to one year, and numbers and dates run together in a series
 * (mutations/credit-notes.ts takes a stated date by the same rules). An issued document whose date
 * changes keeps both true, or the change is refused:
 *  - the date stays a real date, in the year of the number; every numbered type answers to this;
 *  - an invoice or credit note also stays between its neighbouring numbers and on or before today,
 *    since no number issued today could follow a later date. A quote, proforma or purchase order
 *    records no sale, so no order binds it.
 *  - a credit note stays on or after the invoice it corrects, and that invoice on or before its
 *    credit notes: moving either one must not put the correction first.
 * The same date again is no change: the editor's save carries every field. A date that already
 * disagrees with its number can still be brought back to the number's year.
 */
async function issuedDateChangeRefusal(
  ctx: MutationsCtx,
  doc: Record<string, unknown>,
  stated: unknown,
  isAccountingDocument: boolean,
): Promise<ErrorEnvelope | null> {
  const label = String(doc.number ?? doc.id)
  const date = dateOnly(stated)
  if (date !== null && date === dateOnly(doc.issued_at)) return null
  if (!date || !isCalendarDate(date)) {
    return dateRefused(
      "issued_at_invalid",
      `issued_at ${JSON.stringify(stated ?? null)} is not a date, and ${label} is issued so it must keep one. ` +
        "Nothing was changed. Pass YYYY-MM-DD.",
    )
  }
  const year = doc.year_of_issue == null ? null : Number(doc.year_of_issue)
  if (year !== null && Number(date.slice(0, 4)) !== year) {
    return dateRefused(
      "issue_date_crosses_number_year",
      `${label} is numbered in ${year}, so its date cannot move to ${date}. Nothing was changed. ` +
        dateCorrectionHint(doc, isAccountingDocument),
    )
  }
  if (!isAccountingDocument) return null

  const issuer = await findIssuerProfile(ctx.db, String(doc.issuer_profile_id))
  const today = await issueDateParts(ctx, issuer ?? {})
  if (!today.ok) return today.error
  if (date > today.issued_at) {
    return dateRefused(
      "issue_date_in_future",
      `${date} is after today (${today.issued_at} in the issuer's time zone), and no number issued today could ` +
        `follow it. Nothing was changed. Pass today or an earlier date.`,
    )
  }
  const correctionRefusal = await correctionOrderRefusal(ctx, doc, date, label)
  if (correctionRefusal) return correctionRefusal
  if (doc.number_int == null || year === null) return null
  const { previous, next } = await neighbouringNumbers(ctx, doc, Number(doc.number_int))
  const previousDate = dateOnly(previous?.issued_at)
  const nextDate = dateOnly(next?.issued_at)
  const hint = dateCorrectionHint(doc, isAccountingDocument)
  if (previousDate && date < previousDate) {
    return dateRefused(
      "issue_date_breaks_number_order",
      `${date} is before ${String(previous?.number)} (${previousDate}), the number just before ${label}, and ` +
        `numbers and dates run together. Nothing was changed. Pass that date or a later one. ${hint}`,
    )
  }
  if (nextDate && date > nextDate) {
    return dateRefused(
      "issue_date_breaks_number_order",
      `${date} is after ${String(next?.number)} (${nextDate}), the number just after ${label}, and ` +
        `numbers and dates run together. Nothing was changed. Pass that date or an earlier one. ${hint}`,
    )
  }
  return null
}

async function documentsUpdateRun(
  ctx: MutationsCtx,
  rawInput: DocumentsUpdateInput,
  preflight: boolean,
): Promise<DocumentsUpdateResult | { ok: true; buyer: BuyerVatFacts | null }> {
  const rawId = rawInput?.id ? String(rawInput.id) : ""
  if (!rawId) {
    return { status: "error", error: { code: "invalid_params", message: "id is required" } }
  }
  // Accept a document NUMBER as well as its uuid id (see reads.ts's resolveDocumentRow / this
  // file's findDocumentSummary) — a raw `where: { id: rawId }` lookup used to 22P02 at the pg
  // layer when an agent passed a visible number (e.g. "PO0034009") instead of the uuid.
  if (FOREIGN_ID_CHARS.test(rawId)) {
    return { status: "error", error: { code: "not_found", message: `document ${rawId} not found` } }
  }
  const where = isUuid(rawId) ? { id: rawId } : { number: rawId }
  const docRows = await ctx.db.findMany("documents", { where, limit: 1 })
  const doc = docRows[0] as Record<string, unknown> | undefined
  if (!doc) {
    return { status: "error", error: { code: "not_found", message: `document ${rawId} not found` } }
  }
  // From here on, always operate on the RESOLVED uuid — never the raw (possibly non-uuid) input.
  const id = String(doc.id)
  const currentStatus = String(doc.status ?? "draft")
  if (currentStatus === "draft") {
    const runRefusal = await runItemDraftRefusal(ctx, doc, "documents_update")
    if (runRefusal) return runRefusal
  }
  if (NOT_EDITABLE_STATUSES.has(currentStatus)) {
    return {
      status: "error",
      error: {
        code: "document_not_editable",
        message: `document ${id} is ${currentStatus} and can no longer be edited`,
      },
    }
  }
  // ISSUED-IMMUTABILITY — an issued (non-draft) document's FINANCIAL SUBSTANCE is
  // frozen. Editing lines/totals/tax_treatment/counterparty legal identity in place
  // on an issued invoice is a compliance problem for a French issuer (issued
  // invoices must be immutable; corrections flow through a credit note). Reject
  // those field edits with a TYPED error steering to the credit-note flow. Metadata
  // edits (address/email/contact/incoterm/dates) still pass on an issued document,
  // and every field remains editable while the document is still a DRAFT.
  // An OPEN QUOTE is not an issued legal record: it is a live offer, and a negotiation changes
  // its lines. When the issuer is mapped to a Shopify shop the quote IS a draft order, so every
  // edit made in Shopify has to land here -- freezing it would make the mirror diverge silently.
  // (The draft-order sync itself leaves a settled quote alone, see handlers/shopify-draft-order.ts.)
  // The freeze is a rule of ACCOUNTING documents only: an invoice and a credit note. A proforma, a
  // quote and a purchase order record no sale and carry no legal immutability, so their lines,
  // tax treatment and recipient identity stay editable after issue, recomputed and re-rendered
  // exactly like a draft. Without this, an issued proforma could never be corrected at all: its
  // create-and-issue tool converges onto the existing document and this tool refused the edit.
  const docTypeForFreeze = String(doc.type ?? "invoice")
  const isAccountingDocument = !NON_ACCOUNTING_TYPES.has(docTypeForFreeze)
  if (currentStatus !== "draft" && isAccountingDocument) {
    const attemptedFrozen = ISSUED_FROZEN_FIELDS.filter((f) => f in rawInput)
    if (attemptedFrozen.length > 0) {
      return {
        status: "error",
        error: {
          code: "issued_document_immutable",
          message:
            `document ${id} is ${currentStatus}, its financial substance is frozen and cannot be ` +
            `edited in place (attempted: ${attemptedFrozen.join(", ")}). An issued invoice is immutable; ` +
            `to correct lines, totals, tax treatment, or the counterparty's legal identity, issue a CREDIT NOTE ` +
            `(credit_note_create_and_issue, referencing this invoice) instead. To add or change the customer's ` +
            `purchase order number on an issued invoice, pass po_number to this same tool: it is a non financial ` +
            `reference and stays amendable after issue. Editing the linked Shopify order is not a substitute, ` +
            `since it changes the order without changing the document already sent to the customer.`,
        },
      }
    }
  }

  // BL-44-style forgiving country normalisation, same as drafts_update.
  // Once the legal original exists (fixed at issue; the Factur-X for an e-invoice), every field
  // its CII carries is locked too, even those an issued document otherwise lets a person amend
  // (the dates, the billing and shipping addresses): an edit would make every later copy contradict the legal
  // original the customer and the platform hold.
  if (doc.legal_original_id) {
    const current = (k: string): unknown => doc[k] ?? null
    const norm = (v: unknown): string =>
      v == null
        ? ""
        : v instanceof Date
          ? v.toISOString().slice(0, 10)
          : typeof v === "object"
            ? JSON.stringify(v)
            : String(v).slice(0, k10(v)).trim()
    const attempted = LEGAL_ORIGINAL_LOCKED_FIELDS.filter(
      (f) =>
        f in rawInput &&
        norm((rawInput as unknown as Record<string, unknown>)[f]) !== norm(current(f)),
    )
    if (attempted.length > 0) {
      return {
        status: "error",
        error: {
          code: "legal_original_locked",
          message:
            `document ${String(doc.number ?? id)} has a legal original fixed at issue, which carries ` +
            `${attempted.join(", ")}; these cannot change on the document. To correct them, issue a credit note ` +
            `(credit_note_create_and_issue, referencing this invoice) and a new invoice. The purchase order number, ` +
            `notes, the contact link, email and incoterm can still be updated.`,
        },
      }
    }
  }

  if ("issued_at" in rawInput && currentStatus !== "draft") {
    const refused = await issuedDateChangeRefusal(
      ctx,
      doc,
      rawInput.issued_at,
      isAccountingDocument,
    )
    if (refused) return refused
  }

  const { counterparty_country, tax_treatment } = liftMisplacedCountry({
    counterparty_country:
      "counterparty_country" in rawInput ? (rawInput.counterparty_country ?? null) : undefined,
    tax_treatment: "tax_treatment" in rawInput ? (rawInput.tax_treatment ?? null) : undefined,
  }) as { counterparty_country?: string | null; tax_treatment?: string | null }

  const update: Record<string, unknown> = {}
  const changedFields: string[] = []
  const setIfPresent = (key: keyof DocumentsUpdateInput, column: string) => {
    if (key in rawInput) {
      update[column] = (rawInput as unknown as Record<string, unknown>)[key] ?? null
      changedFields.push(column)
    }
  }
  setIfPresent("counterparty_name", "counterparty_name")
  setIfPresent("counterparty_address", "counterparty_address")
  setIfPresent("counterparty_shipping_address", "counterparty_shipping_address")
  setIfPresent("counterparty_shipping_name", "counterparty_shipping_name")
  setIfPresent("counterparty_vat_id", "counterparty_vat_id")
  setIfPresent("counterparty_email", "counterparty_email")
  setIfPresent("counterparty_contact_id", "counterparty_contact_id")
  if (counterparty_country !== undefined) {
    update.counterparty_country = counterparty_country
    if (!changedFields.includes("counterparty_country")) changedFields.push("counterparty_country")
  }
  if (tax_treatment !== undefined) {
    update.tax_treatment = tax_treatment
    if (!changedFields.includes("tax_treatment")) changedFields.push("tax_treatment")
  }
  if (rawInput.incoterm !== undefined) {
    update.incoterm = rawInput.incoterm
    changedFields.push("incoterm")
  }
  if ("issued_at" in rawInput) {
    update.issued_at = rawInput.issued_at ?? null
    changedFields.push("issued_at")
  }
  if ("due_at" in rawInput) {
    update.due_at = rawInput.due_at ?? null
    changedFields.push("due_at")
  }
  // Free-text notes. A plain column, no external_refs mirror and no dedicated lifecycle event:
  // the generic "edited" entry (fields: ["notes"]) plus document:updated is the whole audit
  // story for free text. Deliberately NOT in ISSUED_FROZEN_FIELDS -- a contract reference or a
  // customs mention is non financial, so it lands on an issued/sent/paid document too and the
  // forced PDF re-render below puts it on the customer-facing face, exactly like po_number.
  if ("notes" in rawInput) {
    const notes = normaliseNotes(rawInput.notes)
    if (!notes.ok) return notes.error
    update.notes = notes.value ?? null
    changedFields.push("notes")
  }
  // Audit trail for the PO number specifically: every set/change/clear gets its own
  // `po_number_changed` lifecycle_log entry (from/to/source), on top of the generic "edited"
  // marker every other field change gets — a silent change to a customer-facing reference is
  // exactly what causes a dispute months later, and this is what settles it. Only logged when
  // the value actually changes (a no-op documents_update call with the same po_number does not
  // spam the log).
  let poNumberChange: { from: string | null; to: string | null } | null = null
  if ("po_number" in rawInput) {
    // Effective CURRENT value before this edit: the column when set, else the external_refs
    // fallback for a row written before the column existed — same rule readRefColumn (reads.ts)
    // applies, inlined here since this diff is document-write-side, not a read projection.
    const previousPoNumber =
      readRefString(doc, "po_number") ??
      readRefString((doc.external_refs as Record<string, unknown> | undefined) ?? {}, "po_number")
    const nextPoNumber = rawInput.po_number?.trim() || null
    update.po_number = nextPoNumber
    // Mirror onto external_refs too (the first-class column is the canonical read path, but
    // external_refs stays the pre-column fallback readRefString/readRefColumn use, and the
    // legacy CSV importer wrote it there first).
    const { po_number: _dropped, ...restRefs } =
      (doc.external_refs as Record<string, unknown> | undefined) ?? {}
    update.external_refs = nextPoNumber ? { ...restRefs, po_number: nextPoNumber } : restRefs
    changedFields.push("po_number")
    if (nextPoNumber !== previousPoNumber) {
      poNumberChange = { from: previousPoNumber, to: nextPoNumber }
    }
  }
  // The customer's reference in another system: external_refs only (no column), composed onto
  // whatever the po_number branch above already prepared so neither edit drops the other.
  if ("customer_reference" in rawInput) {
    const ref = normaliseCustomerReference(rawInput.customer_reference)
    if (!ref.ok) return ref.error
    const { customer_reference: _old, ...restRefs } =
      (update.external_refs as Record<string, unknown> | undefined) ??
      (doc.external_refs as Record<string, unknown> | undefined) ??
      {}
    update.external_refs = ref.value ? { ...restRefs, customer_reference: ref.value } : restRefs
    changedFields.push("customer_reference")
  }

  // Who the buyer is, intra-EU: a change to the recipient or the lines re-runs the business-buyer
  // guard (buyer-vat.ts) on the merged document, so an edit can not turn a business sale into a
  // consumer one either. The Shopify draft-order sync (lines_are_net) mirrors Shopify's own tax.
  const buyerTouched =
    rawInput.lines !== undefined ||
    rawInput.buyer_is_consumer !== undefined ||
    [
      "counterparty_vat_id",
      "counterparty_country",
      "counterparty_name",
      "counterparty_email",
      "counterparty_address",
      "counterparty_contact_id",
      "tax_treatment",
    ].some((k) => k in rawInput)
  const buyerDocType = String(doc.type ?? "")
  let buyerFacts: BuyerVatFacts | null = null
  if (
    buyerTouched &&
    !rawInput.lines_are_net &&
    buyerDocType !== "credit_note" &&
    buyerDocType !== "purchase_order"
  ) {
    const merged = (col: string): string | null => {
      const v = col in update ? update[col] : doc[col]
      return typeof v === "string" && v.trim() !== "" ? v : null
    }
    const refs = {
      ...(((update.external_refs ?? doc.external_refs) as
        | Record<string, unknown>
        | null
        | undefined) ?? {}),
    }
    const consumer =
      rawInput.buyer_is_consumer !== undefined
        ? rawInput.buyer_is_consumer === true
        : refs.buyer_is_consumer === true
    const buyerIssuer = await findIssuerProfile(ctx.db, String(doc.issuer_profile_id))
    if (buyerIssuer) {
      const storedTax =
        typeof refs.tax_country === "string" && refs.tax_country.trim() ? refs.tax_country : null
      const r = await checkBuyerVat(ctx, {
        issuerCountry: buyerIssuer.country,
        taxCountry: storedTax ?? merged("counterparty_country"),
        counterparty: {
          contact_id: merged("counterparty_contact_id"),
          legal_name: merged("counterparty_name"),
          email: merged("counterparty_email"),
          address: merged("counterparty_address"),
          vat_id: merged("counterparty_vat_id"),
          customer_kind: merged("customer_kind"),
        },
        buyerIsConsumer: consumer,
        excludeDocumentId: id,
      })
      if (!r.ok) return r.error
      buyerFacts = r.facts
      if (r.facts.vat_id && !merged("counterparty_vat_id")) {
        update.counterparty_vat_id = r.facts.vat_id
        if (!changedFields.includes("counterparty_vat_id"))
          changedFields.push("counterparty_vat_id")
      }
    }
    if (rawInput.buyer_is_consumer !== undefined) {
      if (consumer) refs.buyer_is_consumer = true
      else delete refs.buyer_is_consumer
      // The evidence a person approved the declaration against (buyer-vat.ts).
      if (consumer && consumerDeclaredAgainstEvidence(buyerFacts))
        refs.buyer_is_consumer_evidence = buyerFacts?.consumer_override_evidence ?? []
      else delete refs.buyer_is_consumer_evidence
      update.external_refs = refs
      changedFields.push("buyer_is_consumer")
    }
  }

  // Line replacement — recompute totals exactly like the issue path.
  if (rawInput.lines) {
    const amountsErr = lineAmountsError(rawInput.lines, "lines")
    if (amountsErr) return amountsErr
  }
  // The preflight stops here: everything above only read and validated.
  if (preflight) return { ok: true, buyer: buyerFacts }
  const lineOps: IssueBatchOp[] = []
  if (rawInput.lines) {
    const normalised = rawInput.lines.map(normaliseDraftLine)
    const effectiveCountry =
      (update.counterparty_country as string | null | undefined) ??
      (doc.counterparty_country as string | null) ??
      null
    const issuer = await findIssuerProfile(ctx.db, String(doc.issuer_profile_id))
    const classifyInput: ClassifyInput = {
      issuer_country: issuer?.country ?? null,
      counterparty_country: effectiveCountry,
      has_vat_id: !!(
        (update.counterparty_vat_id as string | null | undefined) ?? doc.counterparty_vat_id
      ),
    }
    // Typed prices on a documents_update line replacement are typed input exactly like
    // drafts_create/drafts_update: under an issuer with `prices_include_tax`, net the gross
    // figure out here, once, before it reaches document_lines — this path replaces lines on
    // a still-draft document AND an issued proforma, quote or purchase order, so it is not merely
    // an internal round-trip. Without this, editing an open quote's lines under an inclusive
    // issuer stored the gross price untouched.
    // credit_note is excluded, matching drafts_create/drafts_update: its items are reversal
    // amounts mirroring an already-net original invoice, never a typed retail price.
    // The Shopify draft-order sync is ALSO excluded, but CALLER scoped via `input.lines_are_net`
    // (internal, not a manifest param — see its doc comment on DocumentsUpdateInput), never by
    // inspecting the document row. onShopifyDraftOrderUpsert (handlers/shopify-draft-order.ts)
    // sets it because IT built `lines` from draftOrderLinesToItems, which already netted them via
    // netOfIncludedTax before this call ever runs; netting them again there would divide an
    // already-net price a SECOND time on every re-sync, unattended (no approval, no human in the
    // loop). Keying this off the DOCUMENT instead (e.g. "this document has a
    // shopify_draft_order_id") would have been wrong: it would exempt EVERY caller of that
    // document from netting, including the Editor's own documents_update save on the same open
    // quote — which sends genuinely GROSS lines and DOES need them netted, so a document-scoped
    // exemption silently stored the operator's typed price as net, inflating it 20% on the PDF.
    const docType = String(doc.type ?? "")
    const netLines =
      issuer && docType !== "credit_note" && !rawInput.lines_are_net
        ? netLinesForIssuer(normalised, issuer, classifyInput)
        : normalised
    const { lineRows, rollup } = await recomputeLines(ctx, netLines, classifyInput)
    // The old lines go, the new ones come and the totals follow in ONE commit (below): a run that
    // dies part way never leaves a document whose lines and totals disagree.
    const oldLines = (await ctx.db.findMany("document_lines", {
      where: { document_id: id },
      limit: 1000,
    })) as Array<Record<string, unknown>>
    for (const old of oldLines) lineOps.push({ delete: "document_lines", id: String(old.id) })
    for (const row of lineRows) {
      lineOps.push({
        insert: "document_lines",
        data: {
          document_id: id,
          position: row.position,
          description: row.description,
          quantity: row.quantity,
          unit_price_minor: row.unit_price_minor.toString(),
          discount_minor: (row.discount_minor ?? 0n).toString(),
          tax_rate_bp: row.tax_rate_bp,
          subtotal_minor: row.subtotal_minor.toString(),
          tax_minor: row.tax_minor.toString(),
          total_minor: row.total_minor.toString(),
          hs_code: row.hs_code,
          country_of_origin: row.country_of_origin,
          customs_description: row.customs_description,
          product_source: row.product_source,
          external_id: row.external_id,
        },
      })
    }
    update.subtotal_minor = rollup.subtotal_minor.toString()
    update.tax_total_minor = rollup.tax_total_minor.toString()
    update.grand_total_minor = rollup.grand_total_minor.toString()
    changedFields.push("lines")
  }

  const existingLog = (doc.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? []
  const editActor = await ctx.getUserId()
  const editTs = new Date().toISOString()
  const newLog = [
    ...existingLog,
    {
      event: "edited",
      actor: editActor,
      ts: editTs,
      fields: changedFields,
    },
    ...(poNumberChange
      ? [
          {
            event: "po_number_changed",
            actor: editActor,
            ts: editTs,
            from: poNumberChange.from,
            to: poNumberChange.to,
            source: rawInput.po_number_source ?? "person",
          },
        ]
      : []),
  ]
  update.lifecycle_log = newLog

  if (lineOps.length > 0 || Object.keys(update).length > 0) {
    await ctx.db.batch({
      ops: [
        ...lineOps,
        ...(Object.keys(update).length > 0 ? [{ update: "documents", id, data: update }] : []),
      ],
    })
  }

  // Kernel audit trail — mirrors the "edited" lifecycle_log entry just written above, gated on
  // a non-empty changed_fields (after dropping internal/rendering-only columns) so a documents_update
  // call that touches nothing a human cares about (or nothing at all) does not spam the audit
  // trail. `pdf_status`/`pdf_file_id`/`lifecycle_log`/`updated_at` never actually land in
  // changedFields today (this handler never sets them there), but are excluded defensively.
  const meaningfulChangedFields = changedFields.filter((f) => !DOCUMENT_UPDATED_NOISE_FIELDS.has(f))
  if (meaningfulChangedFields.length > 0) {
    // Bounded before/after per field — never the whole row, never line items, never an address
    // or email (PII).
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    for (const f of meaningfulChangedFields) {
      if (DOCUMENT_UPDATED_DIFF_EXCLUDED_FIELDS.has(f)) continue
      changes[f] = { from: doc[f] ?? null, to: update[f] ?? null }
    }
    await ctx.emit({
      entity: "document",
      action: "updated",
      entityId: id,
      data: {
        document_id: id,
        type: String(doc.type ?? "invoice"),
        number: (doc.number as string | null) ?? null,
        status: currentStatus,
        changed_fields: meaningfulChangedFields,
        changes,
      },
    })
  }
  if (poNumberChange) {
    await ctx.emit({
      entity: "document",
      action: "po_number_changed",
      entityId: id,
      data: {
        document_id: id,
        type: String(doc.type ?? "invoice"),
        number: (doc.number as string | null) ?? null,
        status: currentStatus,
        from: poNumberChange.from,
        to: poNumberChange.to,
      },
    })
  }

  // Re-render the PDF — content changed, so force a fresh render regardless of the current
  // pdf_status. A render failure must NOT roll back the edit: ensureDocumentPdf already persists
  // `pdf_status: 'failed'` on failure and returns an error envelope rather than throwing; the edit
  // above has already been committed, so we only need to let its outcome flow into the refreshed
  // document read below, never revert the edit itself.
  // link: false — this handler updated the documents row in its open tx above; a host-side
  // cross-tx link-write would deadlock on that row lock (see ensureDocumentPdf).
  await ensureDocumentPdf(ctx, id, { force: true, link: false })

  const refreshedRows = await ctx.db.findMany("documents", { where: { id }, limit: 1 })
  const refreshed = refreshedRows[0] as Record<string, unknown>
  const lineRowsOut = await ctx.db.findMany("document_lines", {
    where: { document_id: id },
    orderBy: { position: "asc" },
    limit: 1000,
  })

  return {
    status: "completed",
    id,
    number: (refreshed.number as string | null) ?? null,
    document_status: String(refreshed.status ?? currentStatus),
    subtotal_minor: String(refreshed.subtotal_minor ?? "0"),
    tax_total_minor: String(refreshed.tax_total_minor ?? "0"),
    grand_total_minor: String(refreshed.grand_total_minor ?? "0"),
    lifecycle_log: (refreshed.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? [],
    pdf_status: (refreshed.pdf_status as string | null) ?? null,
    lines: lineRowsOut as Array<Record<string, unknown>>,
  }
}
