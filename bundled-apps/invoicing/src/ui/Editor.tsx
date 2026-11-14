// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Editor — single-page document authoring surface (spec §12 editor mock).
// Left side: header fields (type, issuer, counterparty, dates, language,
// incoterm) + line-item table. Right side: EditorSummary panel (treatment,
// totals, customs-readiness, validation warnings, approval-threshold info).
// Bottom bar: Preview PDF / the primary create-or-issue action / the same
// action + email. There is no draft-saving step: a new document is created
// and issued in one go.
//
// Pure logic (validateDraft / rollupTotals / customsReadiness / canIssue /
// readOnly) is extracted so the bundled-app bun:test suite can pin every
// branch without a jsdom shim. Component is thin presentation glue + a
// handful of `app.invokeTool(...)` calls.

import { app, navigate } from "@liaison/host"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Index,
  Show,
  untrack,
} from "solid-js"
import {
  documentRollup,
  formatMinorAsMajorInput,
  formatMoneyMinor,
  grossOfExcludedTax,
  lineSubtotal,
  lineTax,
  lineTotal,
  netOfIncludedTax,
  parseMoneyMajorToMinor,
} from "../money"
import { classify } from "../tax"
import { ContactPicker, pickedContactPatch } from "./ContactPicker"
import { EditorSummary } from "./EditorSummary"
import {
  type BlockerAction,
  blockerAction,
  type ClassifyVerdict,
  CUSTOMER_KIND_OPTIONS,
  type CustomerKind,
  identityHref,
  missingFieldLabel,
  missingSummary,
  OPERATION_CATEGORY_OPTIONS,
  type OperationCategory,
} from "./einvoicing/blockers"
import { tr } from "./i18n"
import {
  Button,
  cx,
  dateInputClass,
  Field,
  inputClass,
  Select,
  StatusBadge,
  TypeLabel,
} from "./kit"

export { EditorSummary } from "./EditorSummary"

// ─────────────────────────────────────────────────────────────────────────
// Types & enums.
// ─────────────────────────────────────────────────────────────────────────
export type DocType = "invoice" | "quote" | "proforma" | "purchase_order" | "credit_note"
export const DOC_TYPES: DocType[] = [
  "invoice",
  "quote",
  "proforma",
  "purchase_order",
  "credit_note",
]

// ─────────────────────────────────────────────────────────────────────────
// Primary-action copy.
//
// New documents are created and issued in ONE step: there is no draft stage
// and no draft-saving button. A quote is created (as a Shopify draft order
// when the issuer profile is mapped to a shop), a proforma and a purchase
// order are issued.
// ─────────────────────────────────────────────────────────────────────────
const PRIMARY_ACTION_LABEL: Partial<Record<DocType, string>> = {
  quote: "Create quote",
  proforma: "Issue proforma",
  purchase_order: "Issue purchase order",
}

/** Label of the editor's primary (non-email) action for a document type. */
export function primaryActionLabel(type: DocType): string {
  return tr(PRIMARY_ACTION_LABEL[type] ?? "Issue")
}

/** Same action, "+ email" variant. */
export function primaryActionEmailLabel(type: DocType): string {
  return `${primaryActionLabel(type)} + email`
}

/** Success banner copy for a completed create-and-issue result.
 *
 *  A quote created through a mapped Shopify shop comes back carrying the
 *  draft order it was created from: name the draft order so the operator
 *  knows where the quote now lives. Everything else keeps the generic copy. */
export function createAndIssueSuccessMessage(
  type: DocType,
  result?: Record<string, unknown> | null,
): string {
  const draftOrderName = result?.shopify_draft_order_name
  if (type === "quote" && typeof draftOrderName === "string" && draftOrderName.length > 0) {
    return tr("Quote created from Shopify draft order {{name}}.", { name: draftOrderName })
  }
  return type === "quote" ? tr("Quote created.") : tr("Issued.")
}

/** Success banner copy for the "+ email" variant of the primary action. */
export function emailedMessage(type: DocType, result?: Record<string, unknown> | null): string {
  return `${createAndIssueSuccessMessage(type, result)} ${tr("Emailed to the customer.")}`
}

/** Success banner copy for a `pending_approval` create-and-issue result. For a
 *  quote the approval is the SHOPIFY draft-order approval, not the invoicing
 *  pending-approval queue, so the copy points at Shopify instead. */
export function pendingApprovalMessage(type: DocType): string {
  return type === "quote"
    ? tr("Draft order sent for approval in Shopify. The quote appears once it is approved.")
    : tr("Sent for approval. See the Pending Approval queue.")
}

export type Language = "en" | "fr" | "de"
export const LANGUAGES: Language[] = ["en", "fr", "de"]

export type Incoterm = "EXW" | "FCA" | "FOB" | "CIF" | "DAP" | "DDP" | "DPU"
export const INCOTERMS: Incoterm[] = ["EXW", "FCA", "FOB", "CIF", "DAP", "DDP", "DPU"]

/** Max length of the free-text `notes` field (mirrors the tools' own 2000-char cap). */
export const NOTES_MAX_LENGTH = 2000

export interface DraftLine {
  position: number
  description: string
  /** Quantity as a decimal string with up to 3 fractional digits. */
  quantity: string
  unit_price_minor: string
  /** Always a concrete rate for display/math (the effective classified rate stands in when the
   *  line has no override — see `tax_rate_bp_overridden`). Never the wire's null. */
  tax_rate_bp: number
  /** True only when the operator (or the loaded document) has an EXPLICIT per-line VAT override
   *  — including a deliberate 0 percent exemption. False means `tax_rate_bp` is just the
   *  last-known EFFECTIVE rate shown for display/math on a line that has never had one set;
   *  `buildItems` must not echo that back as an override, or a save freezes today's classified
   *  rate in permanently and a later opened-and-saved copy of the SAME never-overridden line
   *  drops VAT entirely the moment the classifier picks a different rate (or none). Defaults to
   *  true when absent so every existing DraftLine literal (tests, new-line defaults) keeps
   *  today's explicit-override behaviour unchanged. */
  tax_rate_bp_overridden?: boolean
  hs_code?: string | null
  country_of_origin?: string | null
  customs_description?: string | null
}

export interface DraftDocument {
  id?: string
  type: DocType
  /** Lifecycle status — drives readOnly() / canIssue(). */
  status:
    | "draft"
    | "pending_approval"
    | "issued"
    | "sent"
    | "accepted"
    | "rejected"
    | "expired"
    | "closed"
    | "paid"
    | "overdue"
    | "refunded"
    | "voided"
    | "cancelled"
    | "received"
  currency: string
  language: Language
  incoterm: Incoterm
  /** Selected issuer profile id — required to save/issue (see validateDraft).
   *  `null` until the profile list resolves and one is auto-selected, or the
   *  user picks one via the header "Issuer" field. */
  issuer_profile_id: string | null
  issuer_country: string
  issuer_vat_id?: string | null
  /** From the selected issuer profile: typed unit prices are GROSS (tax included). The lines
   *  still carry what the operator typed; the totals divide the included tax out, exactly as
   *  the server does when the document is issued. */
  prices_include_tax?: boolean
  /** Customer section — counterparty snapshot fields. Persisted onto the draft/document row
   *  (drafts_create/drafts_update/documents_update all accept these) and shown on the PDF's
   *  Bill-to block. */
  counterparty_name: string | null
  counterparty_email: string | null
  counterparty_vat_id: string | null
  counterparty_address: string | null
  /** Ship to, shown as its own field so the operator can fill or correct a different consignee.
   *  Render only: the tax treatment follows counterparty_country, never this address. */
  counterparty_shipping_address?: string | null
  counterparty_shipping_name?: string | null
  counterparty_country: string | null
  counterparty_contact_id?: string | null
  issued_at: string | null
  due_at: string | null
  tax_treatment: string
  lines: DraftLine[]
  /** Optional approval threshold from the issuer profile — drives the
   *  yellow "approval required" badge in the summary panel. */
  invoice_approval_threshold_minor?: string | null
  /** Credit notes only — the id (or number, read-back for display) of the invoice this credit note
   *  corrects/reverses. Shown as the "Original invoice" field, hidden for every other type. Landed
   *  in the create call as `original_document_id`; a free-text `reason` travels alongside it. */
  original_document_id?: string | null
  /** Credit notes only — free-text reason for the credit note. */
  credit_note_reason?: string | null
  /** Free-text notes printed on the document (contract reference, customs details, special
   *  mentions). Non-financial metadata like po_number: accepted by drafts_update,
   *  {type}_create_and_issue AND documents_update on ANY editable status, so it never trips
   *  the issued-document immutability check. */
  notes?: string | null
  /** E-invoicing: who the buyer is. Required to issue an invoice to a French buyer unless the
   *  customer's recorded identity already says it (its identity wins at issue). */
  customer_kind?: CustomerKind | null
  /** E-invoicing: goods, services or mixed. Required when the invoice is an e-invoice. */
  operation_category?: OperationCategory | null
  /** E-invoicing: the buyer's structured billing address (an e-invoice needs postcode, city,
   *  country). The free-text address above stays what the PDF prints. */
  billing_line1?: string | null
  billing_line2?: string | null
  billing_postcode?: string | null
  billing_city?: string | null
  billing_country_code?: string | null
}

/** Issuer-profile shape the editor header select consumes — the subset of
 *  `settings_issuer_profile_list`'s `{ items: Record<string, unknown>[] }`
 *  rows (see `reads.ts::settingsIssuerProfileList`) the editor needs to
 *  populate the draft's issuer fields. Extra fields on the row pass through
 *  untyped; we only read what we use here. */
export interface EditorIssuerProfile {
  id: string
  legal_name: string
  country: string
  vat_id?: string | null
  default_currency?: string | null
  default_language?: Language | null
  invoice_approval_threshold_minor?: string | null
  /** Typed unit prices are gross (tax included) under this profile. */
  prices_include_tax?: boolean | null
  /** Today in this issuer's time zone, as the host states it. Null when its zone is unknown. */
  today?: string | null
  /** Set when a shop is linked: this issuer's quotes are made as draft orders in that shop. */
  shopify_shop_id?: string | null
  /** Some issuer-profile schemas mark a single default/primary profile —
   *  accepted under either common flag name; when neither is present the
   *  first profile in list order (already sorted by legal_name asc) wins. */
  is_default?: boolean | null
  is_primary?: boolean | null
}

// ─────────────────────────────────────────────────────────────────────────
// Pure helpers.
// ─────────────────────────────────────────────────────────────────────────
export interface ValidationIssue {
  field: string
  message: string
}

export interface ValidationResult {
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

const EU_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
])

export function validateDraft(d: DraftDocument): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  if (!d.issuer_profile_id) {
    errors.push({
      field: "issuer_profile_id",
      message: tr("An issuer profile is required. Configure one in Settings → Invoicing."),
    })
  }
  // Credit notes are never payable — they carry no due date, so it is not required (and the field
  // is hidden in the UI for this type).
  if (!d.due_at && d.type !== "credit_note") {
    errors.push({ field: "due_at", message: tr("Due date is required.") })
  }
  // Recipient completeness. An issued document is a legal record: it must say WHO it is
  // addressed to, WHERE they are and HOW to reach them. These mirror the backend rule
  // (counterpartyCompletenessError in issue.ts) so the Issue button is disabled with a
  // field-level message instead of the operator meeting a tool error after the fact.
  if (!d.counterparty_name?.trim()) {
    errors.push({
      field: "counterparty_name",
      message: tr("Customer name is required."),
    })
  }
  if (!d.counterparty_address?.trim()) {
    errors.push({
      field: "counterparty_address",
      message: tr("Customer address is required."),
    })
  }
  if (!d.counterparty_email?.trim()) {
    errors.push({
      field: "counterparty_email",
      message: tr("Customer email is required."),
    })
  }
  if (!d.counterparty_country) {
    errors.push({
      field: "counterparty_country",
      message: tr("Counterparty country is required."),
    })
  }
  if (!d.currency) {
    errors.push({ field: "currency", message: tr("Currency is required.") })
  }
  if (d.lines.length === 0) {
    errors.push({ field: "lines", message: tr("At least one line is required.") })
  }
  d.lines.forEach((line, idx) => {
    if (!line.description?.trim()) {
      errors.push({
        field: `lines[${idx}].description`,
        message: tr("Line description is required."),
      })
    }
    const unit = Number(line.unit_price_minor)
    // Credit notes legitimately carry NEGATIVE unit_price_minor (mirroring the reversed portion of
    // the original invoice) — only reject a non-finite value for that type; every other type keeps
    // the non-negative requirement.
    const unitInvalid =
      d.type === "credit_note" ? !Number.isFinite(unit) : !Number.isFinite(unit) || unit < 0
    if (unitInvalid) {
      errors.push({
        field: `lines[${idx}].unit_price_minor`,
        message:
          d.type === "credit_note"
            ? tr("Unit price must be a number.")
            : tr("Unit price must be a non-negative number."),
      })
    }
  })

  // Soft warning: EU-country issuer without VAT id.
  if (EU_COUNTRIES.has(d.issuer_country) && !d.issuer_vat_id) {
    warnings.push({
      field: "issuer_vat_id",
      message: tr("VAT ID is required by law on invoices issued from EU countries."),
    })
  }

  return { errors, warnings }
}

export interface TotalsResult {
  subtotal_minor: bigint
  tax_total_minor: bigint
  grand_total_minor: bigint
}

/**
 * Document totals from the editor's lines.
 *
 * `pricesIncludeTax` mirrors the issuer profile's setting: the operator types GROSS prices, so
 * each taxable line's subtotal is divided by (1 + rate) before the rollup. The preview then
 * shows the same subtotal / VAT / total the server will store when the document is issued
 * (`netLinesForIssuer` in mutations.ts does the identical division at the issue boundary). A
 * zero-rated line (reverse charge, export) has no included tax and stays exactly as typed.
 *
 * The function stays PURE: the flag is a parameter, never read from a signal.
 */
export function rollupTotals(lines: DraftLine[], pricesIncludeTax = false): TotalsResult {
  const inputs = lines.map((ln) => {
    const sub = lineSubtotal({
      quantity: ln.quantity,
      unit_price_minor: BigInt(ln.unit_price_minor || "0"),
    })
    return {
      subtotal_minor: pricesIncludeTax ? netOfIncludedTax(sub, ln.tax_rate_bp) : sub,
      tax_rate_bp: ln.tax_rate_bp,
    }
  })
  return documentRollup(inputs)
}

/** `rollupTotals` for an issuer whose typed prices are tax inclusive. */
export function rollupTotalsInclusive(lines: DraftLine[]): TotalsResult {
  return rollupTotals(lines, true)
}

/**
 * Convert a persisted document's NET unit prices back to the GROSS figure an operator typed,
 * per line, using each line's own tax rate. This is the Editor's single gross boundary: a
 * document read back from storage is always net (`netLinesForIssuer` on the server nets a typed
 * gross price to net exactly once, at the create/update write boundary), so the Editor's OWN
 * state must un-net it once on load. From then on every save round-trips gross -> net exactly
 * once server-side, and `rollupTotals(lines, true)` divides the SAME gross figure out exactly
 * once for display -- never twice.
 */
export function grossUpLinesForDisplay(lines: DraftLine[]): DraftLine[] {
  return lines.map((l) => ({
    ...l,
    unit_price_minor: grossOfExcludedTax(
      BigInt(l.unit_price_minor || "0"),
      l.tax_rate_bp,
    ).toString(),
  }))
}

/** Dependencies `applyNetToGrossOnLoad` needs, decoupled from solid-js signal types so it is
 *  callable from a plain accessor/setter pair too (real solid-js signals satisfy this shape). */
export interface NetToGrossOnLoadDeps {
  /** `props.initial.id` — set only for a document loaded via mapDocumentToDraft, never for a
   *  brand-new draft. */
  initialId: string | undefined
  getDraft: () => DraftDocument
  setDraft: (next: DraftDocument) => void
  getIssuerProfiles: () => EditorIssuerProfile[] | undefined
}

/**
 * The loaded-document counterpart of the issuer auto-select: a document opened via
 * mapDocumentToDraft already carries an issuer_profile_id, so it never goes through applyIssuer
 * and `prices_include_tax` starts unset. Its lines, however, are already NET (persisted post-
 * netLinesForIssuer) -- treating them as freshly-typed gross figures divides the included tax out
 * a SECOND time, both on screen and, if saved unchanged, into storage. Once the matching issuer
 * profile resolves, gross the lines up ONCE so the Editor's own state is always gross -- the
 * single point where net-on-disk becomes gross-in-hand.
 *
 * Pure with respect to its `deps` -- it owns no signal itself -- so the SAME function drives both
 * the real component's reactive memo (its caller keeps the run-once flag across re-evaluations)
 * and a test built on real solid-js signals, without needing to render the component into a DOM.
 * Returns true the run it actually applied (or decided prices_include_tax is off), so the caller
 * knows to stop calling it again; false on every run that could not yet resolve (issuer profiles
 * not loaded, no issuer selected, not a loaded document, or a credit_note).
 *
 * Also the point where a line with NO per-line override (`tax_rate_bp_overridden === false`) gets
 * its DISPLAY rate corrected from `mapLine`'s 0 placeholder to the issuer's actual classified
 * rate, via the SAME pure `classify()` the server calls at save/issue (`netLinesForIssuer` /
 * `recomputeLines` / `issueDocument`). This has to be the exact same rate the write side will
 * apply: grossing a net line up at one rate and having the server net it back down at a DIFFERENT
 * one would drift the stored price on every unchanged save, the same class of bug c2a750cc fixed
 * for the override case. `tax_rate_bp_overridden` itself is untouched, so `buildItems` still never
 * echoes this corrected rate back as an override.
 */
export function applyNetToGrossOnLoad(deps: NetToGrossOnLoadDeps): boolean {
  const { initialId, getDraft, setDraft, getIssuerProfiles } = deps
  if (!initialId) return false
  const draft = getDraft()
  // credit_note is excluded to match the server's own exclusion in netLinesForIssuer -- its
  // items are reversal amounts, not typed retail prices.
  if (draft.type === "credit_note") return false
  const items = getIssuerProfiles()
  if (!items || items.length === 0) return false
  const currentId = draft.issuer_profile_id
  if (!currentId) return false
  const issuer = items.find((p) => p.id === currentId)
  if (!issuer) return false
  const { default_rate_bp } = classify({
    issuer_country: issuer.country,
    counterparty_country: draft.counterparty_country,
    has_vat_id: !!draft.counterparty_vat_id,
  })
  const linesWithClassifiedRate = draft.lines.map((l) =>
    l.tax_rate_bp_overridden === false ? { ...l, tax_rate_bp: default_rate_bp } : l,
  )
  if (!issuer.prices_include_tax) {
    setDraft({ ...draft, prices_include_tax: false, lines: linesWithClassifiedRate })
    return true
  }
  setDraft({
    ...draft,
    prices_include_tax: true,
    lines: grossUpLinesForDisplay(linesWithClassifiedRate),
  })
  return true
}

/** A VAT rate in basis points as the percent a person reads and types (2000 → "20", 550 → "5.5"). */
export function bpToPercentInput(bp: number): string {
  return String(Math.round(bp) / 100)
}

/** A typed VAT percent ("20", "5,5", "5.5 %") in basis points, or null while it does not parse. */
export function percentInputToBp(text: string): number | null {
  const t = text.replace(/%/g, "").replace(",", ".").trim()
  if (t === "") return 0
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null
  return Math.round(Number(t) * 100)
}

/** Whether any line carries customs data, so a services invoice need not show those columns. */
export function showCustomsColumns(lines: DraftLine[], taxTreatment: string): boolean {
  return (
    EXPORT_TREATMENTS.has(taxTreatment) || lines.some((l) => !!l.hs_code || !!l.country_of_origin)
  )
}

export interface CustomsReadinessResult {
  applicable: boolean
  ready: boolean
  missing_hs: number
  missing_coo: number
}

const EXPORT_TREATMENTS = new Set([
  "eu_export_non_eu",
  "eu_reverse_charge",
  "uk_export_eu",
  "uk_export_non_eu",
  "us_export",
])

export function customsReadiness(lines: DraftLine[], taxTreatment: string): CustomsReadinessResult {
  if (!EXPORT_TREATMENTS.has(taxTreatment)) {
    return { applicable: false, ready: true, missing_hs: 0, missing_coo: 0 }
  }
  let missingHs = 0
  let missingCoo = 0
  for (const line of lines) {
    if (!line.hs_code) missingHs++
    if (!line.country_of_origin) missingCoo++
  }
  return {
    applicable: true,
    ready: missingHs === 0 && missingCoo === 0,
    missing_hs: missingHs,
    missing_coo: missingCoo,
  }
}

export function canIssue(d: DraftDocument): boolean {
  if (d.status !== "draft") return false
  const v = validateDraft(d)
  return v.errors.length === 0
}

export interface EinvoicingBlocker {
  field: string
  message: string
  action: BlockerAction
}

export interface EinvoicingIssueState {
  /** Enforce mode: what keeps Issue disabled, each with one action. */
  blockers: EinvoicingBlocker[]
  /** Warn mode: the calm note naming what is still to complete (Issue stays enabled). */
  note: string | null
}

/**
 * What e-invoicing asks of this draft before it is issued, from the draft itself and from the
 * last `einvoicing_classify` verdict on it. Customer type: an invoice to a French buyer needs
 * it unless the customer's identity already records it. Operation type: needed once classify
 * says the invoice is an e-invoice (or awaits a territory decision). Everything else the gate
 * would refuse comes from the verdict's `would_refuse.missing`, minus what the operator has
 * just filled in here. Enforce blocks Issue; warn issues and records the gap, so it only notes.
 */
export function einvoicingIssueState(
  d: DraftDocument,
  verdict: ClassifyVerdict | null | undefined,
  ctx: { documentId?: string | null } = {},
): EinvoicingIssueState {
  if (d.status !== "draft" || (d.type !== "invoice" && d.type !== "credit_note")) {
    return { blockers: [], note: null }
  }
  const bctx = {
    documentId: ctx.documentId ?? d.id ?? null,
    contactId: d.counterparty_contact_id ?? null,
    originalDocumentId: d.original_document_id ?? null,
    inEditor: true,
  }
  const items: EinvoicingBlocker[] = []
  const french = (d.counterparty_country ?? "").trim().toUpperCase() === "FR"
  const knownKind = d.customer_kind ?? verdict?.buyer?.customer_kind ?? null
  if (d.type === "invoice" && french && !knownKind) {
    items.push({
      field: "customer_kind",
      message: tr("Customer type is required."),
      action: blockerAction(
        { field: "customer_kind", fix_tool: "counterparty_identity_set" },
        bctx,
      ),
    })
  }
  const regime = verdict?.regime ?? null
  if (
    d.type === "invoice" &&
    (regime === "e_invoice" || regime === "needs_review") &&
    !d.operation_category
  ) {
    items.push({
      field: "operation_category",
      message: tr("Operation type is required."),
      action: blockerAction({ field: "operation_category", fix_tool: "drafts_update" }, bctx),
    })
  }
  for (const m of verdict?.would_refuse?.missing ?? []) {
    if (items.some((i) => i.field === m.field)) continue
    // Filled in here since the verdict was computed: it travels with the issuing call.
    if (m.field === "customer_kind" && knownKind) continue
    if (m.field === "operation_category" && d.operation_category) continue
    if (m.field === "billing_address" && d.billing_postcode?.trim() && d.billing_city?.trim())
      continue
    items.push({
      field: m.field,
      message: tr("Missing for this e-invoice: {{field}}.", { field: missingFieldLabel(m.field) }),
      action: blockerAction(m, bctx),
    })
  }
  if ((verdict?.gate_mode ?? "enforce") === "warn") {
    return {
      blockers: [],
      note:
        items.length > 0
          ? tr(
              "E-invoicing data still to complete: {{fields}}. Issuing records the gap on the document.",
              {
                fields: missingSummary(items.map((i) => ({ field: i.field, fix_tool: "" }))),
              },
            )
          : null,
    }
  }
  return { blockers: items, note: null }
}

/** canIssue() plus the e-invoicing blockers (enforce mode). */
export function canIssueWithEinvoicing(
  d: DraftDocument,
  verdict: ClassifyVerdict | null | undefined,
): boolean {
  return canIssue(d) && einvoicingIssueState(d, verdict).blockers.length === 0
}

/** A customer kind in plain words. */
export function customerKindLabel(kind: string | null | undefined): string {
  const o = CUSTOMER_KIND_OPTIONS.find((x) => x.value === kind)
  return o ? tr(o.label) : tr("Not set")
}

/** The e-invoicing fields a draft carries, as drafts_update takes them. */
export function einvoicingDraftPatch(d: DraftDocument): Record<string, unknown> {
  return {
    customer_kind: d.customer_kind ?? null,
    operation_category: d.operation_category ?? null,
    billing_line1: d.billing_line1 ?? null,
    billing_line2: d.billing_line2 ?? null,
    billing_postcode: d.billing_postcode ?? null,
    billing_city: d.billing_city ?? null,
    billing_country_code: d.billing_country_code ?? null,
  }
}

/** Statuses that make a document permanently immutable — no field may change
 *  (mirrors mutations.ts NOT_EDITABLE_STATUSES for documents_update). */
const NOT_EDITABLE_STATUSES = new Set(["voided", "cancelled"])

/** A document is editable unless it is voided or cancelled. Legacy draft rows
 *  push pending edits via drafts_update and issue via the {type}_issue tools;
 *  any other editable status saves via documents_update ("Save changes"). */
export function isEditableStatus(status: DraftDocument["status"]): boolean {
  return !NOT_EDITABLE_STATUSES.has(status)
}

/** Once an INVOICE or a CREDIT NOTE is issued its FINANCIAL SUBSTANCE is frozen server side
 *  (documents-update.ts ISSUED_FROZEN_FIELDS: lines, tax_treatment, counterparty_name,
 *  counterparty_vat_id). A proforma, a quote and a purchase order are not accounting documents
 *  and are never frozen: their lines stay editable after issue, exactly like a draft. Sending the
 *  frozen fields on a frozen document makes documents_update reject the WHOLE save, so the Editor
 *  must leave them out of the patch and lock their inputs, keeping the non financial fields
 *  (address, email, dates, incoterm, po_number, notes) editable after issue. */
export function isFinancialSubstanceFrozen(d: Pick<DraftDocument, "status" | "type">): boolean {
  if (d.status === "draft") return false
  return d.type === "invoice" || d.type === "credit_note"
}

/** `readOnly()` now only reflects PENDING_APPROVAL (still locked pending a human
 *  decision) or a genuinely immutable status (voided/cancelled) — every other
 *  status (draft, issued, sent, paid, overdue, …) is editable via documents_update. */
export function readOnly(d: DraftDocument): boolean {
  if (d.status === "pending_approval") return true
  return !isEditableStatus(d.status)
}

/**
 * Build the `items` payload the issue tools (and documents_update's `lines`)
 * expect (DraftLine[] in `mutations.ts` — position, description, quantity,
 * unit_price_minor, product_source, external_id). Pure function of the draft
 * lines so it's covered by the bun:test pure-helper suite without jsdom.
 *
 * `tax_rate_bp_override` is sent ONLY for a line the operator (or the loaded document) actually
 * set an explicit rate on (`tax_rate_bp_overridden !== false`). A line that has never had one set
 * carries `tax_rate_bp` as a display-only effective rate (see mapLine in ui/index.tsx) that must
 * never be echoed back as an override — doing so is what silently dropped VAT on a mere
 * open-and-save (server/mutations.ts honours an explicit 0 the same as any other override).
 */
export function buildItems(d: DraftDocument) {
  return d.lines.map((l) => ({
    position: l.position,
    description: l.description,
    quantity: l.quantity,
    unit_price_minor: l.unit_price_minor,
    tax_rate_bp_override: l.tax_rate_bp_overridden === false ? undefined : l.tax_rate_bp,
    hs_code: l.hs_code ?? undefined,
    country_of_origin: l.country_of_origin ?? undefined,
    customs_description: l.customs_description ?? undefined,
    product_source: null,
    external_id: null,
  }))
}

/**
 * Build the full `documents_update` patch for a NON-draft document — every
 * editable field (counterparty snapshot, incoterm, dates, tax_treatment) plus
 * a full line replacement. `id` must be a real document id (the Save-changes
 * button is only shown once a document is persisted, so this is always
 * called with `props.documentId` set).
 */
export function buildDocumentsUpdatePatch(d: DraftDocument, documentId: string) {
  const frozen = isFinancialSubstanceFrozen(d)
  return {
    id: documentId,
    counterparty_address: d.counterparty_address ?? null,
    counterparty_shipping_address: d.counterparty_shipping_address ?? null,
    counterparty_shipping_name: d.counterparty_shipping_name ?? null,
    counterparty_email: d.counterparty_email ?? null,
    counterparty_country: d.counterparty_country ?? null,
    counterparty_contact_id: d.counterparty_contact_id ?? null,
    incoterm: d.incoterm,
    issued_at: d.issued_at,
    due_at: d.due_at,
    notes: d.notes ?? null,
    ...(frozen
      ? {}
      : {
          counterparty_name: d.counterparty_name ?? null,
          counterparty_vat_id: d.counterparty_vat_id ?? null,
          tax_treatment: d.tax_treatment,
          lines: buildItems(d),
        }),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Display helpers.
// ─────────────────────────────────────────────────────────────────────────
function fmtMoney(minor: bigint, currency: string): string {
  return formatMoneyMinor(minor, currency)
}

/** Parse a hand-typed MAJOR-unit price cell into the MINOR-unit string the
 *  draft stores, or `null` when the text doesn't parse yet (mid-keystroke,
 *  e.g. a bare "-" or a trailing decimal separator) — the caller leaves the
 *  stored value untouched in that case. */
export function priceInputToMinor(text: string, currency: string): string | null {
  const minor = parseMoneyMajorToMinor(text, currency)
  return minor === null ? null : minor.toString()
}

/** Inverse of `priceInputToMinor`: render a stored MINOR-unit price as the
 *  MAJOR-unit text a price `<input>` shows. */
export function minorToPriceInput(minor: string, currency: string): string {
  return formatMinorAsMajorInput(minor, currency)
}

/**
 * The exact array update `updateLine` performs: replace the line at position
 * `i` with a NEW object (never mutate in place), leaving every other line's
 * reference untouched. Extracted so a test can exercise the real production
 * update path -- not a hand written stand-in -- without needing a DOM to
 * render the component that owns `updateLine`'s signals. This object-replace
 * shape is exactly what makes `<Index>` (keyed by position) survive the edit
 * while `<For>` (keyed by item reference) disposes and re-creates the row.
 */
export function replaceLineAt(
  lines: DraftLine[],
  i: number,
  patch: Partial<DraftLine>,
): DraftLine[] {
  return lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l))
}

/** Decides whether the unit-price cell's local text should be re-seeded from
 *  the stored MINOR value. Re-seeding is needed only when the stored value
 *  changed since the field last observed it (an external reload, or another
 *  line's data reused via `<Index>`) AND the on-screen text doesn't already
 *  represent that new stored value — never on the operator's own keystrokes,
 *  which leave `stored` unchanged. */
export function shouldReseedPriceText(a: {
  text: string
  stored: string
  lastStored: string
  currency: string
  lastCurrency: string
}): boolean {
  if (a.stored === a.lastStored && a.currency === a.lastCurrency) return false
  const parsed = priceInputToMinor(a.text, a.currency)
  if (parsed === null) return true
  return BigInt(parsed) !== BigInt(a.stored || "0")
}

// Compact line-cell input — denser than the full-width header `inputClass`.
const CELL =
  "rounded-md border border-border bg-surface px-2 py-1 text-[12.5px] text-text outline-none " +
  "transition-colors focus:border-accent-border focus:ring-2 focus:ring-accent-tint " +
  "disabled:cursor-not-allowed disabled:opacity-55"

// ─────────────────────────────────────────────────────────────────────────
// Editor component.
// ─────────────────────────────────────────────────────────────────────────
export interface EditorProps {
  /** Initial draft state. New documents start from `defaultDraft(type)`. */
  initial: DraftDocument
  /** Optional callback fired after Save / Issue. */
  onPersist?: (d: DraftDocument) => void
  /** Existing draft id — set when editing a LEGACY persisted draft (loaded via
   *  `documents_get`; the New flow never creates one). When present, the
   *  primary action pushes pending edits with `drafts_update` and then calls
   *  the `{type}_issue` tool against the existing draft instead of
   *  `{type}_create_and_issue` (which would create a duplicate). */
  documentId?: string
  /** Opened inside another view (a month-end row): the customer, notes, due date and lines only,
   *  with no top bar, no summary and no issue buttons. The host view saves through `onReady`. */
  compact?: boolean
  /** Shown, not editable: the viewer may read this draft but not change it. */
  readOnly?: boolean
  /** The draft as typed, on every change, before anything is saved. */
  onChange?: (d: DraftDocument) => void
  /** The editor's own save of an existing draft, for a host view's buttons: `drafts_update` with
   *  this editor's patch plus the extra arguments given. Resolves false when it was refused. */
  onReady?: (api: {
    save: (extra?: Record<string, unknown>) => Promise<boolean>
    error: () => string | null
  }) => void
}

/** Today on this computer's calendar: the date shown until the issuer's own date is known. */
export function localCivilDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * The issue date a new document shows once its issuer is known: that issuer's today, as long as
 * the field still holds the default it was given. A date somebody typed stays.
 */
export function issuedAtForIssuer(
  current: string | null,
  shownDefault: string | null,
  today: string | null | undefined,
): string | null {
  return today && shownDefault !== null && current === shownDefault ? today : current
}

/**
 * The date a new document's create tool receives: only one a person chose. The default the field
 * was given is no choice (it can be stale, or this computer's date), so the server dates that
 * document. An invoice's tool takes no date: its date is the day its number is taken.
 */
export function statedIssuedAt(d: DraftDocument, shownDefault: string | null): string | undefined {
  if (d.type === "invoice" || !d.issued_at || d.issued_at === shownDefault) return undefined
  return d.issued_at
}

/**
 * What the server will say about a chosen issue date, said beside the field rather than on the
 * click (mutations/stated-issue-date.ts holds the rule). Null when there is nothing to say: only a
 * date a person chose on a new document is ever judged, and an unknown today judges nothing.
 */
export function issueDateNotice(
  d: DraftDocument,
  shownDefault: string | null,
  issuer: Pick<EditorIssuerProfile, "today" | "shopify_shop_id"> | undefined,
): string | null {
  const stated = shownDefault === null ? undefined : statedIssuedAt(d, shownDefault)
  const today = issuer?.today
  if (!stated || !today || stated === today) return null
  if (d.type === "quote" && issuer?.shopify_shop_id) {
    return tr(
      "This issuer's quotes are made as Shopify draft orders and take the day the draft order is created. Clear this date, or pick an issuer with no shop.",
    )
  }
  return stated > today
    ? tr("This date is after today, so it would be refused. Pick today or an earlier date.")
    : null
}

export function defaultDraft(type: DocType = "invoice"): DraftDocument {
  return {
    type,
    status: "draft",
    currency: "EUR",
    language: "en",
    incoterm: "DAP",
    issuer_profile_id: null,
    issuer_country: "FR",
    counterparty_name: null,
    counterparty_email: null,
    counterparty_vat_id: null,
    counterparty_address: null,
    counterparty_shipping_address: null,
    counterparty_shipping_name: null,
    counterparty_country: null,
    issued_at: localCivilDate(),
    due_at: null,
    tax_treatment: "domestic",
    original_document_id: null,
    credit_note_reason: null,
    notes: null,
    lines: [
      {
        position: 1,
        description: "",
        quantity: "1",
        unit_price_minor: "0",
        tax_rate_bp: 0,
      },
    ],
  }
}

/** Picks the default/primary issuer profile from a list, else the first
 *  (list is already sorted `legal_name asc` by the read tool). Returns
 *  `undefined` for an empty list. */
function pickDefaultIssuer(items: EditorIssuerProfile[]): EditorIssuerProfile | undefined {
  return items.find((p) => p.is_default || p.is_primary) ?? items[0]
}

/** The issuer profiles, or why they could not be read. A refusal (the viewer's role lacks
 *  `invoicing:settings:read`) and a failed read are NOT "no profile exists": the editor says
 *  which one it is, so a read-only member is not told to configure an org that is configured. */
export interface IssuerProfilesLoad {
  items: EditorIssuerProfile[]
  failure: null | "forbidden" | "failed"
}

/** A refusal: an `{ status: "error", error: { code: "forbidden" } }` envelope, or a thrown
 *  host error carrying HTTP 403. */
function isForbidden(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as { status?: unknown; code?: unknown; error?: { code?: unknown } }
  return e.status === 403 || e.code === "forbidden" || e.error?.code === "forbidden"
}

/** Fetches issuer profiles via the app's `settings_issuer_profile_list` tool. Never throws:
 *  a failure yields no items (nothing can be issued against a fabricated issuer) plus the
 *  reason, which the banner reports. */
export async function loadIssuerProfiles(): Promise<IssuerProfilesLoad> {
  try {
    const r = await app.invokeTool<
      | { items: EditorIssuerProfile[] }
      | { status: "error"; error: { code: string; message: string } }
    >("settings_issuer_profile_list", {})
    if (r && typeof r === "object" && "status" in r && r.status === "error") {
      return { items: [], failure: isForbidden(r) ? "forbidden" : "failed" }
    }
    return { items: (r as { items: EditorIssuerProfile[] })?.items ?? [], failure: null }
  } catch (err) {
    return { items: [], failure: isForbidden(err) ? "forbidden" : "failed" }
  }
}

export const Editor: Component<EditorProps> = (props) => {
  const [draft, setDraft] = createSignal<DraftDocument>(props.initial)
  const ro = createMemo(() => props.readOnly === true || readOnly(draft()))
  /** Financial substance locked (an issued invoice or credit note): the line grid,
   *  customer name, VAT id and tax treatment inputs are disabled and left out of the patch. */
  const frozen = createMemo(() => isFinancialSubstanceFrozen(draft()))
  const validation = createMemo(() => validateDraft(draft()))
  const totals = createMemo(() => rollupTotals(draft().lines, !!draft().prices_include_tax))
  const readiness = createMemo(() => customsReadiness(draft().lines, draft().tax_treatment))
  // HS code and country of origin matter for goods sent abroad; a services line never needs them.
  const customsColumns = createMemo(() => showCustomsColumns(draft().lines, draft().tax_treatment))
  // The e-invoicing verdict on the saved draft (invoices and credit notes only): regime, gate
  // mode and what the gate would refuse. Refetched after the e-invoicing fields are saved.
  const classifyKey = () =>
    props.documentId &&
    draft().status === "draft" &&
    (draft().type === "invoice" || draft().type === "credit_note")
      ? props.documentId
      : null
  const [verdict, { refetch: refetchVerdict }] = createResource(classifyKey, async (id) => {
    try {
      const r = await app.invokeTool<ClassifyVerdict>("einvoicing_classify", { document_id: id })
      return r && r.status !== "error" ? r : null
    } catch {
      return null
    }
  })
  const einvoicing = createMemo(() =>
    einvoicingIssueState(draft(), verdict() ?? null, { documentId: props.documentId ?? null }),
  )
  const issuable = createMemo(() => canIssueWithEinvoicing(draft(), verdict() ?? null))
  // An EXISTING, non-draft, non-locked document — edits go through documents_update
  // (Save changes) instead of drafts_update + {type}_issue. Requires a persisted
  // documentId (a brand-new unsaved document is always status "draft").
  const isNonDraftEditable = createMemo(
    () => !!props.documentId && draft().status !== "draft" && !ro(),
  )
  const [lastError, setLastError] = createSignal<string | null>(null)
  const [lastSuccess, setLastSuccess] = createSignal<string | null>(null)

  const [issuerLoad] = app.createResource(loadIssuerProfiles)
  const issuerProfiles = (): EditorIssuerProfile[] | undefined => issuerLoad()?.items
  const issuerFailure = () => (issuerLoad.loading ? null : (issuerLoad()?.failure ?? null))
  // Tracks whether currency/language/threshold have already been auto-filled
  // once from the default profile, so a later manual issuer switch doesn't
  // clobber values the user may since have edited.
  let defaultsApplied = false
  // The default a new document's date field holds; an opened document has none.
  let issuedAtDefault = props.initial.id ? null : props.initial.issued_at

  const issueNotice = createMemo(() =>
    issueDateNotice(
      draft(),
      issuedAtDefault,
      issuerProfiles()?.find((p) => p.id === draft().issuer_profile_id),
    ),
  )

  const applyIssuer = (p: EditorIssuerProfile, opts: { applyDefaults: boolean }) => {
    const current = draft()
    const issuedAt = issuedAtForIssuer(current.issued_at, issuedAtDefault, p.today)
    if (issuedAt !== current.issued_at) issuedAtDefault = issuedAt
    const patch: Partial<DraftDocument> = {
      issuer_profile_id: p.id,
      issuer_country: p.country,
      issuer_vat_id: p.vat_id ?? null,
      prices_include_tax: !!p.prices_include_tax,
      issued_at: issuedAt,
    }
    if (opts.applyDefaults && !defaultsApplied) {
      const base = defaultDraft(current.type)
      if (current.currency === base.currency && p.default_currency) {
        patch.currency = p.default_currency
      }
      if (current.language === base.language && p.default_language) {
        patch.language = p.default_language
      }
      if (
        current.invoice_approval_threshold_minor === base.invoice_approval_threshold_minor &&
        p.invoice_approval_threshold_minor != null
      ) {
        patch.invoice_approval_threshold_minor = p.invoice_approval_threshold_minor
      }
      defaultsApplied = true
    }
    setDraft({ ...current, ...patch })
  }

  // Auto-select the default (or first) profile once the list resolves, but
  // only if the editor hasn't already got an issuer (e.g. an existing draft
  // reopened for edit already carries one).
  createMemo(() => {
    const items = issuerProfiles()
    if (!items || items.length === 0) return
    if (draft().issuer_profile_id) return
    const pick = pickDefaultIssuer(items)
    if (pick) applyIssuer(pick, { applyDefaults: true })
  })

  // The loaded-document counterpart of the auto-select memo above (see applyNetToGrossOnLoad's
  // own doc comment for the why). Guarded on a run-once flag here so a later unrelated edit, or a
  // signal re-fetch that hands the same document back, never re-triggers the conversion.
  let netToGrossApplied = false
  createMemo(() => {
    if (netToGrossApplied) return
    const applied = applyNetToGrossOnLoad({
      initialId: props.initial.id,
      getDraft: draft,
      setDraft,
      getIssuerProfiles: issuerProfiles,
    })
    if (applied) netToGrossApplied = true
  })

  const onIssuerChange = (id: string) => {
    const items = issuerProfiles() ?? []
    const picked = items.find((p) => p.id === id)
    if (picked) applyIssuer(picked, { applyDefaults: false })
  }

  const update = (patch: Partial<DraftDocument>) => {
    if (ro()) return
    setDraft({ ...draft(), ...patch })
  }
  const updateLine = (i: number, patch: Partial<DraftLine>) => {
    if (ro() || frozen()) return
    setDraft({ ...draft(), lines: replaceLineAt(draft().lines, i, patch) })
  }
  const addLine = () => {
    if (ro() || frozen()) return
    const lines = [...draft().lines]
    lines.push({
      position: lines.length + 1,
      description: "",
      quantity: "1",
      unit_price_minor: "0",
      tax_rate_bp: 0,
    })
    setDraft({ ...draft(), lines })
  }
  const removeLine = (i: number) => {
    if (ro() || frozen() || draft().lines.length === 1) return
    const lines = draft()
      .lines.filter((_, idx) => idx !== i)
      .map((l, idx) => ({ ...l, position: idx + 1 }))
    setDraft({ ...draft(), lines })
  }

  const invoke = async (
    tool: string,
    payload: Record<string, unknown>,
    /** Static banner copy, or a function of the completed tool result (a quote
     *  created through Shopify names its draft order). */
    successMessage: string | ((result: Record<string, unknown>) => string),
    /** Banner copy when the tool parks an approval instead of persisting. */
    pendingMessage: string = pendingApprovalMessage(draft().type),
  ) => {
    setLastError(null)
    setLastSuccess(null)
    try {
      const result = await app.invokeTool<
        Record<string, unknown> | { status: "error"; error: { code: string; message: string } }
      >(tool, payload)
      if (result && typeof result === "object" && "status" in result && result.status === "error") {
        const err = (result as { error?: { code?: string; message?: string } }).error
        setLastError(err?.message ?? err?.code ?? tr("The request failed."))
        return
      }
      if (
        result &&
        typeof result === "object" &&
        "status" in result &&
        result.status === "pending_approval"
      ) {
        // Gated tools (above-threshold documents, a Shopify draft order the
        // agent cannot create unattended) file an approval instead of
        // persisting a document — say so rather than "Issued.".
        setLastSuccess(pendingMessage)
        props.onPersist?.(draft())
        return
      }
      setLastSuccess(
        typeof successMessage === "function"
          ? successMessage((result ?? {}) as Record<string, unknown>)
          : successMessage,
      )
      props.onPersist?.(draft())
    } catch (e) {
      setLastError(e instanceof Error ? e.message : tr("The request failed."))
    }
  }

  /** Build the `counterparty` payload for the one-shot create-and-issue tools.
   *
   *  The name is sent AS TYPED. It used to fall back to the literal "Customer" when the field was
   *  empty, which is how an invoice with no recipient name reached a customer: the editor invented
   *  a name the operator never entered, and the backend had nothing to refuse. An empty field now
   *  stays empty, validateDraft blocks the Issue button, and the tool refuses it as a last resort. */
  const buildCounterparty = (d: DraftDocument) => ({
    contact_id: d.counterparty_contact_id ?? null,
    legal_name: d.counterparty_name?.trim() ?? "",
    country: d.counterparty_country ?? d.issuer_country,
    vat_id: d.counterparty_vat_id ?? null,
    address: d.counterparty_address ?? null,
    shipping_address: d.counterparty_shipping_address ?? null,
    shipping_name: d.counterparty_shipping_name ?? null,
    email: d.counterparty_email ?? null,
  })

  /** E-invoicing fields of the issuing call (invoice / credit note tools only accept them). */
  const einvoiceCounterparty = (d: DraftDocument) => ({
    customer_kind: d.customer_kind ?? null,
    billing_line1: d.billing_line1 ?? null,
    billing_postcode: d.billing_postcode ?? null,
    billing_city: d.billing_city ?? null,
    billing_country_code: d.billing_country_code ?? null,
  })

  /** Build the {type}_create_and_issue payload — shared by Issue and Issue+email. Credit notes get
   *  two extra fields (original_document_id, reason) and NO due_at (they are never payable); every
   *  other type keeps the existing shape unchanged. */
  const buildCreateAndIssuePayload = (d: DraftDocument): Record<string, unknown> => {
    const base: Record<string, unknown> = {
      counterparty: buildCounterparty(d),
      issuer_profile_id: d.issuer_profile_id ?? "",
      currency: d.currency,
      incoterm: d.incoterm,
      notes: d.notes ?? null,
      items: buildItems(d),
    }
    if (d.type === "credit_note") {
      base.original_document_id = d.original_document_id || null
      base.reason = d.credit_note_reason || null
    } else {
      base.due_at = d.due_at
    }
    if (d.type === "invoice" || d.type === "credit_note") {
      base.counterparty = { ...buildCounterparty(d), ...einvoiceCounterparty(d) }
      base.operation_category = d.operation_category ?? null
    }
    const issuedAt = statedIssuedAt(d, issuedAtDefault)
    if (issuedAt) base.issued_at = issuedAt
    return base
  }

  const draftPatch = () => {
    const patch: Record<string, unknown> = {
      counterparty_contact_id: draft().counterparty_contact_id ?? null,
      counterparty_name: draft().counterparty_name ?? null,
      counterparty_address: draft().counterparty_address ?? null,
      counterparty_shipping_address: draft().counterparty_shipping_address ?? null,
      counterparty_shipping_name: draft().counterparty_shipping_name ?? null,
      counterparty_vat_id: draft().counterparty_vat_id ?? null,
      counterparty_email: draft().counterparty_email ?? null,
      counterparty_country: draft().counterparty_country ?? null,
      currency: draft().currency,
      incoterm: draft().incoterm,
      due_at: draft().due_at,
      issuer_profile_id: draft().issuer_profile_id ?? "",
      notes: draft().notes ?? null,
      lines: buildItems(draft()),
      customer_kind: draft().customer_kind ?? null,
      operation_category: draft().operation_category ?? null,
      billing_line1: draft().billing_line1 ?? null,
      billing_line2: draft().billing_line2 ?? null,
      billing_postcode: draft().billing_postcode ?? null,
      billing_city: draft().billing_city ?? null,
      billing_country_code: draft().billing_country_code ?? null,
    }
    // Credit notes carry the reversal linkage via external_refs (drafts_update's generic passthrough
    // field) — creditNoteIssue reads original_document_id/reason from there at issue time.
    if (draft().type === "credit_note") {
      patch.external_refs = {
        original_document_id: draft().original_document_id || null,
        reason: draft().credit_note_reason || null,
      }
    }
    return patch
  }

  /** Push the current editor state onto the existing draft (no banner) so a
   *  subsequent issue call issues WHAT THE USER SEES, not the last-saved
   *  state. Returns false (and surfaces the error) when the update failed. */
  const pushDraftPatch = async (
    documentId: string,
    extra?: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      const result = await app.invokeTool<
        Record<string, unknown> | { status: "error"; error: { code: string; message: string } }
      >("drafts_update", { draft_id: documentId, patch: draftPatch(), ...(extra ?? {}) })
      if (result && typeof result === "object" && "status" in result && result.status === "error") {
        const err = (result as { error?: { code?: string; message?: string } }).error
        setLastError(err?.message ?? err?.code ?? tr("The request failed."))
        return false
      }
      return true
    } catch (e) {
      setLastError(e instanceof Error ? e.message : tr("The request failed."))
      return false
    }
  }

  createEffect(() => {
    const d = draft()
    // Only the draft is tracked: what the host does with it never re-runs this.
    untrack(() => props.onChange?.(d))
  })
  props.onReady?.({
    save: (extra) => {
      setLastError(null)
      return props.documentId ? pushDraftPatch(props.documentId, extra) : Promise.resolve(false)
    },
    error: () => lastError(),
  })

  /** Persist the e-invoicing fields of an existing draft as soon as they change, then re-ask
   *  einvoicing_classify, so what blocks Issue reflects what the operator just chose. */
  const saveEinvoicing = async (patch: Partial<DraftDocument>) => {
    update(patch)
    const documentId = props.documentId
    if (!documentId || draft().status !== "draft") return
    try {
      const result = await app.invokeTool<
        Record<string, unknown> | { status: "error"; error: { code: string; message: string } }
      >("drafts_update", { draft_id: documentId, patch: einvoicingDraftPatch(draft()) })
      if (result && typeof result === "object" && "status" in result && result.status === "error") {
        const err = (result as { error?: { code?: string; message?: string } }).error
        setLastError(err?.message ?? err?.code ?? tr("The request failed."))
        return
      }
      refetchVerdict()
    } catch (e) {
      setLastError(e instanceof Error ? e.message : tr("The request failed."))
    }
  }

  /** Save changes on an EXISTING NON-DRAFT document — the single "Save changes"
   *  action for an issued/sent/paid/etc. document. Calls documents_update with
   *  the full patch (counterparty snapshot, incoterm, dates, tax_treatment,
   *  lines) — server recomputes totals and re-renders the PDF. */
  const onSaveChanges = () => {
    const documentId = props.documentId
    if (!documentId) return
    void invoke(
      "documents_update",
      buildDocumentsUpdatePatch(draft(), documentId),
      "Changes saved. The PDF is re-rendering.",
    )
  }

  const onPreviewPdf = () => {
    // PDF preview requires an issued document. Until the editor's draft
    // persistence is wired (TODO above), the preview button is a no-op
    // placeholder rather than a broken tool dispatch.
  }

  const createAndIssueTool = (t: DocType): string => {
    switch (t) {
      case "invoice":
        return "invoice_create_and_issue"
      case "quote":
        return "quote_create_and_issue"
      case "proforma":
        return "proforma_create_and_issue"
      case "purchase_order":
        return "po_create_and_issue"
      case "credit_note":
        return "credit_note_create_and_issue"
    }
  }

  /** Issue tool for an EXISTING draft (issues in place — no duplicate draft). */
  const issueTool = (t: DocType): string => {
    switch (t) {
      case "invoice":
        return "invoice_issue"
      case "quote":
        return "quote_issue"
      case "proforma":
        return "proforma_issue"
      case "purchase_order":
        return "po_issue"
      case "credit_note":
        return "credit_note_issue"
    }
  }

  /** Issue an EXISTING draft: push pending edits first so we issue what the
   *  user sees, then issue in place. */
  const onIssueExisting = async (documentId: string) => {
    if (!(await pushDraftPatch(documentId))) return
    await invoke(
      issueTool(draft().type),
      // due_at travels on the draft via pushDraftPatch just above — {type}_issue
      // schemas (quote/proforma/po) only accept {draft_id}.
      { draft_id: documentId },
      (r) => createAndIssueSuccessMessage(draft().type, r),
    )
  }

  const onIssue = () =>
    props.documentId
      ? void onIssueExisting(props.documentId)
      : void invoke(createAndIssueTool(draft().type), buildCreateAndIssuePayload(draft()), (r) =>
          createAndIssueSuccessMessage(draft().type, r),
        )

  // Existing-draft "Issue + email" has no single gated tool (`{type}_issue`
  // only takes `{draft_id, due_at?}` — no `send_to_customer`), so issue first
  // then chain the same `documents_send_to_customer` tool DocumentDetail's
  // footer action calls. If issue lands in `pending_approval`, invoke()
  // already reports that and we skip the send (nothing to send yet).
  const onIssueEmailExisting = async () => {
    const documentId = props.documentId
    if (!documentId) return
    setLastError(null)
    setLastSuccess(null)
    if (!(await pushDraftPatch(documentId))) return
    try {
      const result = await app.invokeTool<
        Record<string, unknown> | { status: "error"; error: { code: string; message: string } }
      >(issueTool(draft().type), { draft_id: documentId })
      if (result && typeof result === "object" && "status" in result && result.status === "error") {
        const err = (result as { error?: { code?: string; message?: string } }).error
        setLastError(err?.message ?? err?.code ?? tr("The request failed."))
        return
      }
      if (
        result &&
        typeof result === "object" &&
        "status" in result &&
        result.status === "pending_approval"
      ) {
        setLastSuccess(pendingApprovalMessage(draft().type))
        props.onPersist?.(draft())
        return
      }
      await app.invokeTool("documents_send_to_customer", { document_id: documentId })
      setLastSuccess(emailedMessage(draft().type, result as Record<string, unknown>))
      props.onPersist?.(draft())
    } catch (e) {
      setLastError(e instanceof Error ? e.message : tr("The request failed."))
    }
  }

  const onIssueEmail = () =>
    props.documentId
      ? void onIssueEmailExisting()
      : void invoke(
          createAndIssueTool(draft().type),
          { ...buildCreateAndIssuePayload(draft()), send_to_customer: true },
          (r) => emailedMessage(draft().type, r),
        )

  return (
    <section data-testid="invoicing-editor" class="flex h-full min-h-0 flex-col">
      {/* Top bar — spans the lines column and the summary. The actions live at the top: the
          chat dock floats over the panel's bottom-right corner, so a bottom bar would sit under it. */}
      <Show when={!props.compact}>
        <div
          data-testid="editor-top-bar"
          class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-subtle px-5 py-3"
        >
          <div class="flex items-center gap-3">
            <TypeLabel
              type={draft().type}
              testid="editor-top-bar-type"
              class="text-[14px] font-medium text-text"
            />
            <StatusBadge status={draft().status} testid="editor-top-bar-status" />
          </div>
          <div class="flex flex-wrap items-center justify-end gap-2">
            <Show
              when={isNonDraftEditable()}
              fallback={
                <>
                  <Button
                    variant="secondary"
                    testid="editor-button-preview-pdf"
                    onClick={onPreviewPdf}
                  >
                    {tr("Preview PDF")}
                  </Button>
                  <Button
                    variant="secondary"
                    testid="editor-button-issue"
                    disabled={!issuable()}
                    onClick={onIssue}
                  >
                    {primaryActionLabel(draft().type)}
                  </Button>
                  <Button
                    variant="primary"
                    testid="editor-button-issue-email"
                    disabled={!issuable()}
                    onClick={onIssueEmail}
                  >
                    {primaryActionEmailLabel(draft().type)}
                  </Button>
                </>
              }
            >
              <Button variant="primary" testid="editor-button-save-changes" onClick={onSaveChanges}>
                {tr("Save changes")}
              </Button>
            </Show>
          </div>
        </div>
      </Show>

      <Show when={lastError()}>
        <div
          data-testid="editor-error-banner"
          class="border-b border-error-border bg-error-glow px-5 py-2.5 text-[12px] text-error"
        >
          {lastError()}
        </div>
      </Show>
      <Show when={lastSuccess() && !lastError()}>
        <div
          data-testid="editor-success-banner"
          class="border-b border-success-border bg-success-glow px-5 py-2.5 text-[12px] text-success"
        >
          {lastSuccess()}
        </div>
      </Show>

      <div class="flex min-h-0 flex-1">
        {/* Left: header + lines. Compact (inside a card) it may shrink to the card's width: the
            lines table scrolls on its own instead of widening the page. */}
        <div class={props.compact ? "flex min-w-0 flex-1 flex-col" : "flex flex-1 flex-col"}>
          <Show when={issuerFailure() === "forbidden"}>
            <div
              data-testid="editor-issuer-forbidden-banner"
              class="border-b border-border-subtle bg-warning-glow px-5 py-2.5 text-[12px] text-warning"
            >
              {tr(
                "Your role can't read the issuer profiles, so documents can't be created or issued here. Ask an admin for invoicing write access.",
              )}
            </div>
          </Show>
          <Show when={issuerFailure() === "failed"}>
            <div
              data-testid="editor-issuer-load-failed-banner"
              class="border-b border-border-subtle bg-warning-glow px-5 py-2.5 text-[12px] text-warning"
            >
              {tr("The issuer profiles couldn't be loaded. Reload the tab to try again.")}
            </div>
          </Show>
          <Show
            when={
              !issuerLoad.loading &&
              issuerFailure() === null &&
              (issuerProfiles()?.length ?? 0) === 0
            }
          >
            <div
              data-testid="editor-not-configured-banner"
              class="border-b border-border-subtle bg-error-glow px-5 py-2.5 text-[12px] text-error"
            >
              {tr(
                "Invoicing isn't configured yet: no issuer profile exists. Create one in Settings → Invoicing (or provision one via the `liaison config apply` CLI) before issuing documents.",
              )}
            </div>
          </Show>

          <Show when={ro()}>
            <div
              data-testid="editor-readonly-banner"
              class="border-b border-border-subtle bg-warning-glow px-5 py-2.5 text-[12px] text-warning"
            >
              <Show
                when={draft().status === "pending_approval"}
                fallback={
                  <>
                    {tr("This document is")} {draft().status} {tr("and cannot be edited.")}
                  </>
                }
              >
                {tr("Pending approval. The editor is read-only until the request is decided.")}
              </Show>
            </div>
          </Show>

          <Show when={isNonDraftEditable()}>
            <div
              data-testid="editor-issued-notice"
              class="border-b border-border-subtle bg-accent-tint px-5 py-2.5 text-[12px] text-text-secondary"
            >
              {tr("Editing an issued document: saving re-renders its PDF.")}
            </div>
          </Show>

          {/* Header strip */}
          <header
            class={
              props.compact
                ? "grid grid-cols-1 gap-x-5 gap-y-4 border-b border-border-subtle px-3 py-3 sm:grid-cols-2"
                : "grid grid-cols-2 gap-x-5 gap-y-4 border-b border-border-subtle px-5 py-4 lg:grid-cols-3"
            }
          >
            <Show when={!props.compact}>
              <Field label={tr("Type")}>
                <Select
                  testid="editor-field-type"
                  disabled={ro()}
                  value={draft().type}
                  onChange={(v) => update({ type: v as DocType })}
                >
                  <For each={DOC_TYPES}>
                    {(t) => (
                      <option value={t}>
                        {t.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}
                      </option>
                    )}
                  </For>
                </Select>
              </Field>
              <Field
                label={tr("Issuer")}
                error={validation().errors.some((er) => er.field === "issuer_profile_id")}
              >
                <Select
                  testid="editor-field-issuer"
                  disabled={ro() || (issuerProfiles()?.length ?? 0) === 0}
                  value={draft().issuer_profile_id ?? ""}
                  onChange={onIssuerChange}
                >
                  <option value="" disabled>
                    {tr("Select an issuer…")}
                  </option>
                  <For each={issuerProfiles() ?? []}>
                    {(p) => <option value={p.id}>{p.legal_name}</option>}
                  </For>
                </Select>
              </Field>
              <Field label={tr("Contact")}>
                <ContactPicker
                  contactId={draft().counterparty_contact_id ?? null}
                  disabled={ro()}
                  onPick={(c) => update(pickedContactPatch(c, draft()))}
                  onClear={() => update({ counterparty_contact_id: null })}
                />
              </Field>
              <Field label={tr("Issue date")}>
                <input
                  data-testid="editor-field-issued-at"
                  type="date"
                  disabled={ro()}
                  value={draft().issued_at ?? ""}
                  onInput={(e) => update({ issued_at: e.currentTarget.value || null })}
                  class={dateInputClass}
                />
                <Show when={issueNotice()}>
                  {(notice) => (
                    <p
                      data-testid="editor-issue-date-notice"
                      class="mt-1 text-[11.5px] text-text-secondary"
                    >
                      {notice()}
                    </p>
                  )}
                </Show>
              </Field>
            </Show>
            {/* Credit notes are never payable — no due date, so the field is hidden for this type. */}
            <Show when={draft().type !== "credit_note"}>
              <Field
                label={tr("Due date")}
                error={validation().errors.some((er) => er.field === "due_at")}
              >
                <input
                  data-testid="editor-field-due-at"
                  type="date"
                  disabled={ro()}
                  value={draft().due_at ?? ""}
                  onInput={(e) => update({ due_at: e.currentTarget.value || null })}
                  class={cx(
                    dateInputClass,
                    validation().errors.some((er) => er.field === "due_at") &&
                      "border-error focus:border-error focus:ring-error-glow",
                  )}
                />
              </Field>
            </Show>
            <Show when={!props.compact}>
              <Field label={tr("Language")}>
                <Select
                  testid="editor-field-language"
                  disabled={ro()}
                  value={draft().language}
                  onChange={(v) => update({ language: v as Language })}
                >
                  <For each={LANGUAGES}>{(l) => <option value={l}>{l.toUpperCase()}</option>}</For>
                </Select>
              </Field>
              <Field label={tr("Incoterm")}>
                <Select
                  testid="editor-field-incoterm"
                  disabled={ro()}
                  value={draft().incoterm}
                  onChange={(v) => update({ incoterm: v as Incoterm })}
                >
                  <For each={INCOTERMS}>{(i) => <option value={i}>{i}</option>}</For>
                </Select>
              </Field>
            </Show>
          </header>

          {/* Customer section */}
          <section
            data-testid="editor-section-customer"
            class={
              props.compact
                ? "grid grid-cols-1 gap-x-5 gap-y-4 border-b border-border-subtle px-3 py-3 sm:grid-cols-2"
                : "grid grid-cols-2 gap-x-5 gap-y-4 border-b border-border-subtle px-5 py-4 lg:grid-cols-3"
            }
          >
            <Field label={tr("Customer name")}>
              <input
                data-testid="editor-field-customer-name"
                disabled={ro() || frozen()}
                value={draft().counterparty_name ?? ""}
                onInput={(e) => update({ counterparty_name: e.currentTarget.value || null })}
                placeholder={tr("Customer legal / display name")}
                class={inputClass}
              />
            </Field>
            <Field label={tr("Customer email")}>
              <input
                data-testid="editor-field-customer-email"
                type="email"
                disabled={ro()}
                value={draft().counterparty_email ?? ""}
                onInput={(e) => update({ counterparty_email: e.currentTarget.value || null })}
                placeholder="customer@example.com"
                class={inputClass}
              />
            </Field>
            <Field label={tr("Customer VAT ID")}>
              <input
                data-testid="editor-field-customer-vat"
                disabled={ro() || frozen()}
                value={draft().counterparty_vat_id ?? ""}
                onInput={(e) => update({ counterparty_vat_id: e.currentTarget.value || null })}
                placeholder={tr("e.g. FR12345678901")}
                class={cx(inputClass, "font-mono text-[11.5px]")}
              />
            </Field>
            <Field label={tr("Customer country")}>
              <input
                data-testid="editor-field-customer-country"
                disabled={ro()}
                value={draft().counterparty_country ?? ""}
                onInput={(e) => update({ counterparty_country: e.currentTarget.value || null })}
                placeholder={tr("ISO 2-letter (e.g. FR)")}
                class={inputClass}
              />
            </Field>
            {/* Credit notes only — the invoice this credit note corrects/reverses. Minimum viable
                field is the plain document id/number text input; a search-by-number affordance
                (documents_search) is a nice-to-have left for a follow-up. */}
            <Show when={draft().type === "credit_note"}>
              <Field label={tr("Original invoice")}>
                <input
                  data-testid="editor-field-original-invoice"
                  disabled={ro()}
                  value={draft().original_document_id ?? ""}
                  onInput={(e) => update({ original_document_id: e.currentTarget.value || null })}
                  placeholder={tr("Original invoice id or number")}
                  class={inputClass}
                />
              </Field>
              <Field label={tr("Reason")}>
                <input
                  data-testid="editor-field-credit-note-reason"
                  disabled={ro()}
                  value={draft().credit_note_reason ?? ""}
                  onInput={(e) => update({ credit_note_reason: e.currentTarget.value || null })}
                  placeholder={tr("e.g. partial return, 2 of 10 units")}
                  class={inputClass}
                />
              </Field>
            </Show>
            <Field label={tr("Customer address")} class="col-span-2 lg:col-span-3">
              <textarea
                data-testid="editor-field-customer-address"
                disabled={ro()}
                value={draft().counterparty_address ?? ""}
                onInput={(e) => update({ counterparty_address: e.currentTarget.value || null })}
                placeholder={tr("Street, city, postal code, country")}
                rows={2}
                class={cx(inputClass, "resize-y")}
              />
            </Field>
            {/* Ship to: filled only when the parcel goes somewhere other than the billing
                address. Left empty, the document prints the BILL TO block alone. */}
            <Show when={!props.compact}>
              <Field label={tr("Shipping address (if different)")} class="col-span-2 lg:col-span-3">
                <textarea
                  data-testid="editor-field-shipping-address"
                  disabled={ro()}
                  value={draft().counterparty_shipping_address ?? ""}
                  onInput={(e) =>
                    update({ counterparty_shipping_address: e.currentTarget.value || null })
                  }
                  placeholder={tr("Leave empty when the parcel ships to the billing address")}
                  rows={2}
                  class={cx(inputClass, "resize-y")}
                />
              </Field>
              <Field label={tr("Ship to name (if different)")} class="col-span-2 lg:col-span-3">
                <input
                  data-testid="editor-field-shipping-name"
                  disabled={ro()}
                  value={draft().counterparty_shipping_name ?? ""}
                  onInput={(e) =>
                    update({ counterparty_shipping_name: e.currentTarget.value || null })
                  }
                  placeholder={tr("Consignee name, when it is not the billing customer")}
                  class={inputClass}
                />
              </Field>
            </Show>
            {/* Free-text notes printed on the document. Editable on EVERY editable status
                (documents_update takes notes as non-financial metadata, exactly like po_number),
                so it is NOT gated on the draft-only read-only flag beyond `ro()`. */}
            <Field label={tr("Notes")} class="col-span-2 lg:col-span-3">
              <textarea
                data-testid="editor-field-notes"
                disabled={ro()}
                maxlength={NOTES_MAX_LENGTH}
                value={draft().notes ?? ""}
                onInput={(e) => update({ notes: e.currentTarget.value || null })}
                placeholder={tr(
                  "Contract reference, customs details, special mentions: printed on the document",
                )}
                rows={3}
                class={cx(inputClass, "resize-y")}
              />
              <p
                data-testid="editor-field-notes-remaining"
                class="mt-1 text-[10.5px] text-text-tertiary"
              >
                {NOTES_MAX_LENGTH - (draft().notes?.length ?? 0)} {tr("characters left")}
              </p>
            </Field>
            {/* E-invoicing: customer type and operation type (invoices), the structured billing
                address an e-invoice needs (French buyers), and what still blocks Issue. Each
                blocker names its field and carries one action; warn mode only notes, calmly. */}
            <Show
              when={
                !props.compact && (draft().type === "invoice" || draft().type === "credit_note")
              }
            >
              <div
                data-testid="editor-section-einvoicing"
                class="col-span-2 grid grid-cols-2 gap-x-5 gap-y-4 lg:col-span-3 lg:grid-cols-3"
              >
                <Show when={draft().type === "invoice"}>
                  <Field
                    label={tr("Customer type")}
                    error={einvoicing().blockers.some((b) => b.field === "customer_kind")}
                  >
                    <Select
                      testid="editor-field-customer-kind"
                      disabled={ro() || frozen()}
                      value={draft().customer_kind ?? ""}
                      onChange={(v) =>
                        void saveEinvoicing({ customer_kind: (v || null) as CustomerKind | null })
                      }
                    >
                      <option value="">{tr("Not set")}</option>
                      <For each={CUSTOMER_KIND_OPTIONS}>
                        {(o) => <option value={o.value}>{tr(o.label)}</option>}
                      </For>
                    </Select>
                    <Show
                      when={
                        !draft().customer_kind &&
                        verdict()?.buyer?.source === "identity" &&
                        verdict()?.buyer?.customer_kind
                      }
                    >
                      <p
                        data-testid="editor-customer-kind-recorded"
                        class="mt-1 text-[10.5px] text-text-tertiary"
                      >
                        {tr("Recorded on the customer: {{kind}}", {
                          kind: customerKindLabel(verdict()?.buyer?.customer_kind),
                        })}
                      </p>
                    </Show>
                  </Field>
                  <Field
                    label={tr("Operation type")}
                    error={einvoicing().blockers.some((b) => b.field === "operation_category")}
                  >
                    <Select
                      testid="editor-field-operation-category"
                      disabled={ro() || frozen()}
                      value={draft().operation_category ?? ""}
                      onChange={(v) =>
                        void saveEinvoicing({
                          operation_category: (v || null) as OperationCategory | null,
                        })
                      }
                    >
                      <option value="">{tr("Not set")}</option>
                      <For each={OPERATION_CATEGORY_OPTIONS}>
                        {(o) => <option value={o.value}>{tr(o.label)}</option>}
                      </For>
                    </Select>
                  </Field>
                  <Show when={(draft().counterparty_country ?? "").trim().toUpperCase() === "FR"}>
                    <Field
                      label={tr("Billing postcode")}
                      error={einvoicing().blockers.some((b) => b.field === "billing_address")}
                    >
                      <input
                        data-testid="editor-field-billing-postcode"
                        disabled={ro() || frozen()}
                        value={draft().billing_postcode ?? ""}
                        onInput={(e) => update({ billing_postcode: e.currentTarget.value || null })}
                        onBlur={() =>
                          void saveEinvoicing({
                            billing_country_code: draft().billing_country_code ?? "FR",
                          })
                        }
                        class={inputClass}
                      />
                    </Field>
                    <Field
                      label={tr("Billing city")}
                      error={einvoicing().blockers.some((b) => b.field === "billing_address")}
                    >
                      <input
                        data-testid="editor-field-billing-city"
                        disabled={ro() || frozen()}
                        value={draft().billing_city ?? ""}
                        onInput={(e) => update({ billing_city: e.currentTarget.value || null })}
                        onBlur={() =>
                          void saveEinvoicing({
                            billing_country_code: draft().billing_country_code ?? "FR",
                          })
                        }
                        class={inputClass}
                      />
                    </Field>
                    <Field label={tr("Billing street")} class="col-span-2 lg:col-span-1">
                      <input
                        data-testid="editor-field-billing-line1"
                        disabled={ro() || frozen()}
                        value={draft().billing_line1 ?? ""}
                        onInput={(e) => update({ billing_line1: e.currentTarget.value || null })}
                        onBlur={() =>
                          void saveEinvoicing({
                            billing_country_code: draft().billing_country_code ?? "FR",
                          })
                        }
                        class={inputClass}
                      />
                    </Field>
                  </Show>
                </Show>
                <Show when={einvoicing().blockers.length > 0}>
                  <ul
                    data-testid="editor-einvoicing-blockers"
                    class="col-span-2 flex flex-col gap-1 lg:col-span-3"
                  >
                    <For each={einvoicing().blockers}>
                      {(b) => (
                        <li
                          data-testid={`editor-einvoicing-blocker-${b.field}`}
                          class="flex flex-wrap items-baseline gap-x-3 text-[11.5px] text-text-secondary"
                        >
                          <span>{b.message}</span>
                          <Show
                            when={b.action.kind === "open" ? b.action : null}
                            fallback={<span class="text-text-tertiary">{b.action.label}</span>}
                          >
                            {(a) => (
                              <a
                                class="cursor-pointer text-accent hover:underline"
                                href={a().href}
                                onClick={(e) => {
                                  e.preventDefault()
                                  navigate(a().href)
                                }}
                              >
                                {a().label}
                              </a>
                            )}
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={einvoicing().note}>
                  <div
                    data-testid="editor-einvoicing-note"
                    class="col-span-2 text-[11.5px] text-text-secondary lg:col-span-3"
                  >
                    {einvoicing().note}{" "}
                    <Show
                      when={identityHref({
                        contactId: draft().counterparty_contact_id ?? null,
                        documentId: props.documentId ?? null,
                      })}
                    >
                      {(href) => (
                        <a
                          class="cursor-pointer text-accent hover:underline"
                          href={href()}
                          onClick={(e) => {
                            e.preventDefault()
                            navigate(href())
                          }}
                        >
                          {tr("Open the customer identity")}
                        </a>
                      )}
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
          </section>

          {/* Lines */}
          <div
            class={
              props.compact
                ? "flex-1 overflow-x-auto px-3 py-3"
                : "flex-1 overflow-y-auto px-5 py-4"
            }
          >
            <table
              class={cx("w-full text-[12.5px]", props.compact && "max-sm:block")}
              data-testid="editor-lines-table"
            >
              <thead class={props.compact ? "max-sm:hidden" : undefined}>
                <tr class="text-left text-[10.5px] uppercase tracking-wider text-text-tertiary">
                  <th class="px-2 pb-2 font-medium">{tr("Description")}</th>
                  <th class="px-2 pb-2 text-right font-medium">{tr("Qty")}</th>
                  <th class="px-2 pb-2 text-right font-medium">
                    {draft().prices_include_tax ? tr("Unit price (incl. VAT)") : tr("Unit price")}
                  </th>
                  <th class="px-2 pb-2 text-right font-medium">{tr("VAT %")}</th>
                  <Show when={customsColumns()}>
                    <th class="px-2 pb-2 font-medium">{tr("HS code")}</th>
                    <th class="px-2 pb-2 font-medium">{tr("CoO")}</th>
                  </Show>
                  <th class="px-2 pb-2 text-right font-medium">{tr("Total")}</th>
                  <th class="px-2 pb-2" />
                </tr>
              </thead>
              <tbody class={props.compact ? "max-sm:block" : undefined}>
                <Index each={draft().lines}>
                  {(line, idx) => {
                    const sub = createMemo(() =>
                      lineSubtotal({
                        quantity: line().quantity,
                        unit_price_minor: BigInt(line().unit_price_minor || "0"),
                      }),
                    )
                    const tax = createMemo(() =>
                      lineTax({ subtotal_minor: sub(), tax_rate_bp: line().tax_rate_bp }),
                    )
                    const total = createMemo(() =>
                      lineTotal({ subtotal_minor: sub(), tax_minor: tax() }),
                    )
                    // Local text for the unit-price cell, held in MAJOR units so
                    // the operator types "100" and means 100 EUR. Seeded from
                    // the stored MINOR value; onInput both updates this text
                    // (so the input never fights the typist) and, when the text
                    // parses, pushes the parsed MINOR value into the draft.
                    // onBlur re-seeds from the stored value so partial/garbage
                    // text self-corrects instead of persisting.
                    const [priceText, setPriceText] = createSignal(
                      minorToPriceInput(line().unit_price_minor, draft().currency),
                    )
                    let lastStored = line().unit_price_minor
                    let lastCurrency = draft().currency
                    createEffect(() => {
                      const stored = line().unit_price_minor
                      const currency = draft().currency
                      // Only re-seed when the stored value changed from a
                      // source other than this input (an externally reloaded
                      // document, or `<Index>` reusing this row for a
                      // different line), or the document's currency changed
                      // (the same minor value reads as a different major-unit
                      // text once the currency switches), and the on-screen
                      // text does not already represent it — an in-flight
                      // keystroke that hasn't changed `stored` is left
                      // untouched.
                      const reseed = shouldReseedPriceText({
                        text: priceText(),
                        stored,
                        lastStored,
                        currency,
                        lastCurrency,
                      })
                      lastStored = stored
                      lastCurrency = currency
                      if (reseed) {
                        setPriceText(minorToPriceInput(stored, currency))
                      }
                    })
                    // The VAT rate is typed as a percent; the draft keeps basis points.
                    const [taxText, setTaxText] = createSignal(bpToPercentInput(line().tax_rate_bp))
                    createEffect(() => {
                      const stored = line().tax_rate_bp
                      if (percentInputToBp(untrack(taxText)) !== stored)
                        setTaxText(bpToPercentInput(stored))
                    })
                    return (
                      <tr
                        data-testid={`editor-line-${idx + 1}`}
                        class={cx(
                          "align-top",
                          props.compact &&
                            "max-sm:flex max-sm:flex-wrap max-sm:items-center max-sm:border-b max-sm:border-border-subtle max-sm:py-1",
                        )}
                      >
                        <td
                          class={cx("px-2 py-1.5", props.compact && "max-sm:block max-sm:w-full")}
                        >
                          <input
                            data-testid={`editor-line-${idx + 1}-description`}
                            disabled={ro() || frozen()}
                            value={line().description}
                            onInput={(e) => updateLine(idx, { description: e.currentTarget.value })}
                            placeholder={tr("Line description")}
                            class={cx(CELL, "w-full")}
                          />
                        </td>
                        <td class={cx("px-2 py-1.5", props.compact && "max-sm:block")}>
                          <input
                            data-testid={`editor-line-${idx + 1}-quantity`}
                            disabled={ro() || frozen()}
                            value={line().quantity}
                            onInput={(e) => updateLine(idx, { quantity: e.currentTarget.value })}
                            class={cx(CELL, "w-16 text-right tabular-nums")}
                          />
                        </td>
                        <td class={cx("px-2 py-1.5", props.compact && "max-sm:block")}>
                          <input
                            data-testid={`editor-line-${idx + 1}-unit-price`}
                            disabled={ro() || frozen()}
                            value={priceText()}
                            onInput={(e) => {
                              const text = e.currentTarget.value
                              setPriceText(text)
                              const minor = priceInputToMinor(text, draft().currency)
                              if (minor !== null) {
                                updateLine(idx, { unit_price_minor: minor })
                              }
                            }}
                            onBlur={() =>
                              setPriceText(
                                minorToPriceInput(line().unit_price_minor, draft().currency),
                              )
                            }
                            class={cx(CELL, "w-24 text-right tabular-nums")}
                          />
                        </td>
                        <td class={cx("px-2 py-1.5", props.compact && "max-sm:block")}>
                          <input
                            data-testid={`editor-line-${idx + 1}-tax-rate`}
                            disabled={ro() || frozen()}
                            inputmode="decimal"
                            value={taxText()}
                            onInput={(e) => {
                              setTaxText(e.currentTarget.value)
                              const bp = percentInputToBp(e.currentTarget.value)
                              if (bp === null) return
                              updateLine(idx, {
                                tax_rate_bp: bp,
                                // The operator just typed a rate: this is now an EXPLICIT override
                                // (including a deliberate 0 percent), never echoed as a stale
                                // classified default again.
                                tax_rate_bp_overridden: true,
                              })
                            }}
                            onBlur={() => setTaxText(bpToPercentInput(line().tax_rate_bp))}
                            class={cx(CELL, "w-16 text-right tabular-nums")}
                          />
                        </td>
                        <Show when={customsColumns()}>
                          <td class={cx("px-2 py-1.5", props.compact && "max-sm:block")}>
                            <input
                              data-testid={`editor-line-${idx + 1}-hs`}
                              disabled={ro() || frozen()}
                              value={line().hs_code ?? ""}
                              onInput={(e) =>
                                updateLine(idx, { hs_code: e.currentTarget.value || null })
                              }
                              placeholder="-"
                              class={cx(CELL, "w-24 font-mono")}
                            />
                          </td>
                          <td class={cx("px-2 py-1.5", props.compact && "max-sm:block")}>
                            <input
                              data-testid={`editor-line-${idx + 1}-coo`}
                              disabled={ro() || frozen()}
                              value={line().country_of_origin ?? ""}
                              onInput={(e) =>
                                updateLine(idx, {
                                  country_of_origin: e.currentTarget.value || null,
                                })
                              }
                              placeholder="-"
                              class={cx(CELL, "w-14 font-mono uppercase")}
                            />
                          </td>
                        </Show>
                        <td class={cx("px-2 py-1.5 text-right", props.compact && "max-sm:block")}>
                          <span class="font-mono tabular-nums text-text">
                            {fmtMoney(total(), draft().currency)}
                          </span>
                        </td>
                        <td class={cx("px-1 py-1.5 text-center", props.compact && "max-sm:block")}>
                          <Show when={!ro() && !frozen() && draft().lines.length > 1}>
                            <button
                              type="button"
                              data-testid={`editor-line-${idx + 1}-remove`}
                              onClick={() => removeLine(idx)}
                              aria-label={tr("Remove line")}
                              class="rounded-md px-1.5 py-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-error"
                            >
                              ✕
                            </button>
                          </Show>
                        </td>
                      </tr>
                    )
                  }}
                </Index>
              </tbody>
            </table>
            <Show when={draft().prices_include_tax}>
              <div
                data-testid="editor-prices-include-tax-note"
                class="mt-2 text-[11.5px] text-text-tertiary"
              >
                {tr(
                  "Prices are tax inclusive (issuer setting). Catalog lines take the store price.",
                )}
              </div>
            </Show>
            <Button
              variant="ghost"
              testid="editor-button-add-line"
              disabled={ro() || frozen()}
              onClick={addLine}
              class="mt-3"
            >
              {tr("+ Add line")}
            </Button>
          </div>
        </div>

        {/* Right: summary */}
        <Show when={!props.compact}>
          <aside class="w-72 shrink-0 overflow-y-auto border-l border-border-subtle bg-bg">
            <EditorSummary
              draft={draft()}
              totals={totals()}
              readiness={readiness()}
              validation={validation()}
            />
          </aside>
        </Show>
      </div>
    </section>
  )
}
