// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task D7 — In-app issuance helper.
//
// `issueDocument(ctx, input)` is the single seam every issuance tool
// (agent + manual) delegates to. It composes D2 (tax classifier), D3
// (numbering), D5 (money), D6 (PDF render via ctx.pdf), and K1 (thread
// post via ctx.messages). No transaction is held across the run: the
// number, the document, its lines and the caller's `commit_with` writes
// commit together in ONE `ctx.db.batch` call, so legal numbering stays
// gap-free and unique; everything after it is a separate, retryable step.
//
// Failure semantics:
//   - Failure before the batch (or of the batch) → nothing persisted, no
//     number consumed.
//   - PDF render failure → document is persisted with `pdf_status='failed'`;
//     number is preserved (committed with the document);
//     lifecycle log records `pdf_render_failed`; caller treats the absence
//     of `pdf_file_id` in the return envelope as "retry me".
//   - Thread post failure → document is persisted with `pdf_status='ready'`;
//     no thread post; lifecycle log records `thread_post_failed`; the
//     attention feed surfaces the failure (the kernel-side bridge raises
//     the attention; this helper only records the lifecycle event).
//
// Customs snapshot: when a draft line carries `(product_source, external_id)`,
// the helper looks up `product_customs_overlay` and copies the values onto
// the persisted document_line. Later edits to the overlay do NOT mutate
// the snapshotted line — this is enforced by storing the values inline on
// the document_lines row rather than referencing the overlay.

import type { CrossAppExecuteTool } from "./cross-app"
import type { CustomerKind, Regime } from "./einvoicing/classify"
import { classifyRegime } from "./einvoicing/classify"
import type { OperationCategory, PaymentState } from "./einvoicing/classify-operation"
import { cachedRate, FxRateUnavailableError, fxIssueDate } from "./einvoicing/fx"
import {
  type DeliveryAddress,
  EinvoiceGateRefusal,
  gateWarning,
  type OperationSource,
  type RegimeSnapshotColumns,
  regimeSnapshot,
} from "./einvoicing/gate"
import { ensureDerivedIdentity } from "./einvoicing/identity-derive"
import {
  type EinvoiceOriginal,
  type EinvoicingWarning,
  prepareEinvoiceGate,
} from "./einvoicing/issue-gate"
import { documentLegalMention } from "./einvoicing/mentions"
import { type EinvCtx, stageSendAfterIssue } from "./einvoicing/transmit"
import { FacturxBuildError, type FacturxInput } from "./facturx/cii"
import { facturxEligible, facturxInputFrom } from "./facturx/input"
import { DEFAULT_ZONE, issuerTimezoneUnset, type TimeSurface } from "./issue-date"
import { hasLegalOriginal, recordLegalOriginal } from "./legal-originals/record"
import { documentRollup, lineAmounts } from "./money"
import { numberingSequence } from "./numbering"
import { classify, operationLabel } from "./tax"

export type DocumentType = "invoice" | "quote" | "proforma" | "purchase_order" | "credit_note"

export interface IssuerProfile {
  id: string
  legal_name: string
  country: string
  vat_id: string | null
  address: string | null
  iban: string | null
  swift_bic: string | null
  bank_name: string | null
  default_language: "en" | "fr" | "de"
  /** kernel.files uuid of the issuer's logo. Optional — absent falls back to
   *  a text wordmark header on the PDF, never fails the render. */
  logo_file_id?: string | null
  prefix_invoice?: string
  prefix_quote?: string
  prefix_proforma?: string
  prefix_po?: string
  prefix_credit_note?: string
  /** IANA zone of the issue date and number year (`issue-date.ts`). */
  timezone?: string | null
  /** Defaults the `vat_on_debits` flag recorded on each issued document. */
  vat_on_debits_default?: boolean | null
  /** Structured seller address and e-invoicing routing (Factur-X BT-34..BT-40). */
  siret?: string | null
  routing_address?: string | null
  address_line1?: string | null
  address_line2?: string | null
  postcode?: string | null
  city?: string | null
  country_code?: string | null
  /** French identity mentions printed on the PDF. */
  siren?: string | null
  legal_form?: string | null
  share_capital?: string | null
  rcs_city?: string | null
}

export interface Counterparty {
  contact_id: string | null
  legal_name: string
  /** The country printed under the Bill-to address. */
  country: string
  /** The tax destination country, when it differs from the billing `country` (a buyer billed in
   *  one country whose goods are delivered to another). The classifier reads it in place of
   *  `country` when set, and issueDocument persists it on `external_refs.tax_country` so every
   *  later classification of the same document (re-render, credit note, reissue) agrees. Absent:
   *  `country` is both, as it always was. */
  tax_country?: string | null
  vat_id: string | null
  address: string | null
  /** Ship to address, when the parcel goes somewhere other than the billing address. RENDER ONLY:
   *  it prints as its own SHIP TO block on the PDF and is NEVER consulted by the tax classifier,
   *  which keys off `country` (the billing country) alone. Null / equal to `address` means there
   *  is nothing extra to print. */
  shipping_address?: string | null
  /** Consignee name for the ship to block when the parcel is addressed to someone other than the
   *  billing customer. Falls back to `legal_name` at render time. */
  shipping_name?: string | null
  /** Typed optional because not every caller shape carries it, but a MISSING or blank email
   *  now REFUSES the issuance (see `counterpartyCompletenessError`): a legal document must
   *  identify its recipient. Persisted to the document snapshot so a re-render /
   *  documents_get can show it. */
  email?: string | null
  /** E-invoicing: who the buyer is (business, individual, public entity, non-registered
   *  entity). A contact's identity row wins over this; absent and underivable on a French
   *  buyer, the issue gate refuses with customer_kind_missing (never a guess). */
  customer_kind?: CustomerKind | null
  /** The buyer's SIREN / SIRET as the caller or a stored snapshot carries them. */
  /** Never confirmed by the caller: a SIREN counts as registry-confirmed only through the
   *  contact's identity row (or, for a credit note, its original's recorded snapshot). */
  siren?: string | null
  siret?: string | null
  /** Structured billing address an e-invoice needs (postcode, city, ISO country code). The
   *  free-form `address` stays the printed Bill-to block. */
  billing_line1?: string | null
  billing_line2?: string | null
  billing_postcode?: string | null
  billing_city?: string | null
  billing_country_code?: string | null
  /** Structured delivery address, recorded only when it differs from the billing address. */
  delivery?: DeliveryAddress | null
}

/**
 * The counterparty fields a document CANNOT be issued without: who it is addressed to
 * (`legal_name`), where they are (`address`), and how to reach them (`email`) — plus the
 * `country` the tax classifier already needs. A draft may sit incomplete for as long as the
 * operator wants; ISSUING is what demands a complete recipient, because an issued document is
 * a legal record that leaves the building (PDF, mail, customs pouch).
 *
 * Enforced at the single issuance seam (`issueDocument`, via `CounterpartyIncompleteError`) so
 * NO path can bypass it, and re-checked up-front by each issuing handler so the caller gets a
 * typed `invalid_params` result instead of an exception. The JSON-Schema `required` array on the
 * `*_create_and_issue` tools rejects the agent path even earlier.
 */
export const REQUIRED_COUNTERPARTY_FIELDS = ["legal_name", "country", "address", "email"] as const

/** A counterparty field whose value is missing, null, or whitespace-only. */
function blank(v: string | null | undefined): boolean {
  return typeof v !== "string" || v.trim().length === 0
}

/**
 * Returns a typed error envelope body when the counterparty is too incomplete to issue,
 * else null. Shared by every issuing handler AND by `issueDocument` so the rule has ONE
 * definition and one message.
 */
export function counterpartyCompletenessError(
  counterparty: Pick<Counterparty, "legal_name" | "country" | "address" | "email">,
): { code: string; message: string } | null {
  const missing = REQUIRED_COUNTERPARTY_FIELDS.filter((f) => blank(counterparty[f]))
  if (missing.length === 0) return null
  return {
    code: "counterparty_incomplete",
    message:
      `cannot issue a document without a complete recipient: ${missing.join(", ")} ` +
      `${missing.length === 1 ? "is" : "are"} missing. An issued document is a legal record, ` +
      `so the recipient name, postal address, email and country are all required. Set them on ` +
      `the draft (drafts_update counterparty_name / counterparty_address / counterparty_email / ` +
      `counterparty_country) or pass a complete \`counterparty\` to the create-and-issue tool, ` +
      `e.g. counterparty: {"legal_name": "Acme SAS", "country": "FR", "address": ` +
      `"12 rue de la Paix, 75002 Paris, France", "email": "billing@acme.example"} (country is the ` +
      `ISO 3166 alpha-2 code). Ask the person for any of these you do not know; never make them up. ` +
      `Nothing was issued.`,
  }
}

/**
 * Raised by `issueDocument` when the counterparty snapshot is incomplete. Thrown rather than
 * returned because `issueDocument` is the last-resort backstop: every handler is expected to
 * have refused already via `counterpartyCompletenessError`, so reaching here means a NEW code
 * path forgot the check. Carries the same code/message so a catch site can surface it verbatim.
 */
export class CounterpartyIncompleteError extends Error {
  constructor(
    message: string,
    readonly code: string = "counterparty_incomplete",
  ) {
    super(message)
    this.name = "CounterpartyIncompleteError"
  }
}

/**
 * Wire-input shape for a draft line as the agent / an edited-approval payload delivers it — money and
 * quantity arrive LOOSE (a bigint, an integer-as-string, a MAJOR-unit decimal like "419.40", or a
 * number). `normaliseDraftLine` canonicalises this into the strict `DraftLine` (quantity decimal
 * string, unit_price_minor minor-unit bigint). Keep wire boundaries (drafts_create / drafts_update /
 * create-and-issue items) typed as this, NOT the strict normalised shape.
 */
/**
 * Line classification — drives customs handling and PDF grouping:
 *   - `goods`    (default) physical products; customs enrichment applies on exports.
 *   - `software` digital items (license keys, downloads) — never customs goods,
 *                rendered in their own "Software" group on the PDF.
 *   - `service`  work done for the buyer (consulting, a retainer): a service in the operation
 *                category and the tax classification, never customs goods.
 *   - `shipping` carriage lines — never customs goods, rendered last.
 */
export type LineKind = "goods" | "software" | "service" | "shipping"

export interface DraftLineInput {
  position?: number
  description: string
  quantity: string | number
  unit_price_minor: bigint | string | number
  /** Per-line discount in minor units (tax-exclusive), subtracted from
   *  quantity x unit price. Rendered explicitly on the invoice (a discount
   *  must be visible on the document, not folded into the unit price). */
  discount_minor?: bigint | string | number
  line_kind?: LineKind
  tax_rate_bp_override?: number
  /** Customs facts the agent may supply INLINE for an export line (so a complete export invoice is
   *  one drafts_create, no separate hs_codes_assign round-trip). An explicit value wins over the
   *  product overlay at issue. */
  hs_code?: string | null
  customs_description?: string | null
  country_of_origin?: string | null
  product_source: string | null
  external_id: string | null
}

export interface DraftLine {
  /** Optional: DB-loaded draft lines carry a position, but agent create-and-issue items don't —
   *  issueDocument falls back to the line's array index so the NOT-NULL column is always set. */
  position?: number
  description: string
  quantity: string
  unit_price_minor: bigint
  /** Per-line discount in minor units (tax-exclusive), subtracted from
   *  quantity x unit price and rendered explicitly on the document. */
  discount_minor?: bigint
  /** Line classification (goods / software / shipping). Absent means `goods`. */
  line_kind?: LineKind
  /**
   * Optional per-line override for the tax rate, in basis points. When
   * unset, the line inherits the document-level rate from the tax
   * classifier. Reverse-charge and zero-tax lines pass `0` here.
   */
  tax_rate_bp_override?: number
  /** Inline customs facts (export lines). An explicit value wins over the product overlay at issue. */
  hs_code?: string | null
  customs_description?: string | null
  country_of_origin?: string | null
  product_source: string | null
  external_id: string | null
}

export interface Draft {
  currency: string
  incoterm: string
  year_of_issue: number
  issued_at: string
  due_at: string | null
  external_refs: Record<string, unknown>
  /** Free-text notes for the document face (contract reference, extra customs information, a
   *  special mention). NOT mirrored onto external_refs: unlike po_number it is a plain
   *  top-level column with no legacy JSON home, so `documents.notes` is the single source. */
  notes?: string | null
  lines: DraftLine[]
}

/**
 * Document scope — set by the Shopify order-paid auto-flow when it SPLITS a
 * mixed order into two documents: `goods` (physical lines + shipping; the
 * commercial invoice customs sees) and `software` (digital lines only —
 * customs must never tariff these, so they live on their own document).
 * Null/absent for agent- and manually-created documents (whole-order scope).
 */
export type DocumentScope = "goods" | "software"

export interface IssueInput {
  type: DocumentType
  issuer: IssuerProfile
  counterparty: Counterparty
  draft: Draft
  scope?: DocumentScope | null
  /** Credit notes only — the ORIGINAL invoice's number, pre-resolved by the caller (e.g.
   *  credit_note_create_and_issue looked up `original_document_id`), threaded through to the
   *  rendered PDF's reference line. Ignored for every other type. */
  original_invoice_number?: string | null
  /** Credit notes only — the original invoice's issue date, rendered next to its number. */
  original_invoice_date?: string | null
  /** Credit notes only — the original invoice: its id (written to the `original_document_id`
   *  column), its stored regime (null for a legacy original that never had one) and its
   *  transmission state. The credit note takes the original's regime; a refused or rejected
   *  original makes it an internal cancellation. */
  original?: EinvoiceOriginal | null
  /** E-invoicing: the goods / services category stated by the caller (or the draft). */
  operation_category?: OperationCategory | null
  /** Where the category (or the line kinds) came from; `lines_authoritative` for line kinds
   *  set by an authoritative source. Defaults to `explicit` with a category. */
  operation_source?: OperationSource | null
  /** E-invoicing payment state at issue (due, paid, final after deposit). */
  payment_state?: PaymentState | null
  /** A checkout buyer (Shopify) without company or VAT id is a consumer; manual is the default. */
  origin?: "manual" | "shopify"
  /** Issue the document ALREADY SETTLED. The Shopify order-paid flow invoices a checkout that is
   *  already paid, so the document is born with payment_status="paid" + paid_at and its PDF renders
   *  "Amount paid" (no banking box) from the first render — no stale "Total due" PDF, no second
   *  render pass. Status still stays "issued" (a paid physical order must remain in Boxtal's
   *  to-prepare queue). `source` labels the settlement's origin in the lifecycle log. Absent for a
   *  normal unpaid issuance. */
  settlement?: { paid_at: string; source: string } | null
  /** Status the document is born in. Defaults to "issued" (invoices, credit notes, purchase
   *  orders). Quotes are born "sent": a quote is a live offer the moment it exists (and a
   *  Shopify draft order is exactly that), which is also the status the transition table
   *  drives accept / reject / expire / convert_to_invoice from. */
  initial_status?: string
  /** Where the PO number on `draft.external_refs.po_number` came from, for the audit trail
   *  (`po_number_changed` lifecycle_log entry appended below when a PO number is set at issue).
   *  "person" (the default) covers every agent/UI-driven create_and_issue call, drafts_create,
   *  and a carried-forward value (order_reissue_apply, a credit note inheriting its original
   *  invoice's PO number) — a human decision put it there, even if indirectly. "shopify_sync"
   *  is reserved for a value read straight off a Shopify webhook payload with no human step in
   *  between (the order-paid auto-flow). */
  po_number_source?: "shopify_sync" | "person"
  /** Change-log entries the issued document carries over from the draft it replaces. */
  lifecycle_carry?: Array<Record<string, unknown>>
  /** "batch": issued with no person (a month-end run issuing by itself), so an e-invoice waits
   *  for the daily send card instead of its own send approval. */
  einvoice_send?: "stage" | "batch" | "held"
  /** Writes that must commit with the document (the draft it replaces, the invoice a credit
   *  note credits): appended to the issuing batch. `{ $ref: "document" }` is the new document's
   *  id, `{ $seq: "formatted" }` its number. */
  commit_with?: IssueBatchOp[]
  /** Writes that must commit with the document but land before it in the batch (a draft giving
   *  up the unique key the new document takes). */
  commit_before?: IssueBatchOp[]
  /** A dedup key for the document (`documents.external_ref`, unique): the automatic credit note
   *  of one Shopify or Stripe refund, or a month-end run's period key (the draft hands its own
   *  over, after clearing it on the draft, so the period stays billed once). */
  external_ref?: string | null
}

export interface IssueResult {
  document_id: string
  number: string
  pdf_file_id: string | null
  /** Warn mode only: the gate's refusal, recorded on the document instead of blocking it. */
  einvoicing_warning?: EinvoicingWarning
}

/**
 * Minimal db surface — the helper uses only the generic CRUD methods
 * the sandbox bridge exposes. Tests can supply a hand-rolled in-memory
 * implementation that matches this subset (see issue.test.ts).
 *
 * The bridge's `db.insert` returns the full inserted row (the SDK type
 * narrows it to `{id}` but the bridge `RETURNING *` actually streams the
 * row back). We type the read-side return as `unknown` and coerce at the
 * call site.
 */
export interface IssueDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      orderBy?: Record<string, "asc" | "desc">
      limit?: number
      offset?: number
      select?: string[]
    },
  ): Promise<unknown[]>
  findOne(entity: string, id: string): Promise<unknown | null>
  insert(entity: string, data: Record<string, unknown>): Promise<unknown>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  /** `ctx.db.batch`: writes (and the number) that commit together. */
  batch(spec: IssueBatchSpec): Promise<{
    sequence?: { value: number; formatted?: string }
    sequences?: Record<string, { value: number; formatted?: string }>
    rows: Record<string, Record<string, unknown>>
  }>
}

/** One write of a `ctx.db.batch` (see the SDK's `DbBatchOp`). */
export type IssueBatchOp =
  | { insert: string; data: Record<string, unknown>; as?: string }
  | {
      update: string
      id: string | { $ref: string }
      data?: Record<string, unknown>
      append?: Record<string, unknown[]>
      merge?: Record<string, Record<string, unknown>>
    }
  | { delete: string; id: string | { $ref: string } }

export interface IssueBatchSequence {
  key: string
  format?: { prefix: string; pad?: number }
  unique?: { entity: string; field: string; where?: Record<string, unknown> }
}

export interface IssueBatchSpec {
  sequence?: IssueBatchSequence
  /** Several named sequences in one commit (`{ $seq: "<name>.formatted" }`). */
  sequences?: Record<string, IssueBatchSequence>
  ops: IssueBatchOp[]
}

/**
 * An issuance up to its commit: everything read, checked and fetched, nothing written. `ops`
 * write the document (named `document`), its lines and the caller's `commit_with` writes, numbered
 * by `sequence` through `{ $seq: ... }` placeholders. `finish` runs everything after the commit
 * (audit events, the PDF, the thread post, the e-invoicing send request) once the batch that
 * carried `ops` committed, given the number it allocated and the new document's id.
 */
export interface PreparedIssue {
  sequence: IssueBatchSequence
  ops: IssueBatchOp[]
  finish(committed: { value: number; formatted: string; documentId: string }): Promise<IssueResult>
}

// Minimal ctx surface — the helper consumes only the bridges it needs.
// The kernel-injected `AppContext` is a superset; tests can supply a
// hand-rolled in-memory ctx that matches this shape (see issue.test.ts).
export interface IssueCtx {
  /**
   * Sync-in-name, async-in-worker. The kernel exposes the calling user id
   * via the bridge as `__bridge_getUserId` wrapped by the worker shim's
   * async `__wrap`, so untrusted handlers must `await` the call to receive
   * the actual string. Calling without await returns the pending Promise
   * (which JSON-stringifies as `{}` and silently breaks downstream actors).
   */
  getUserId(): Promise<string>
  db: IssueDb
  /**
   * Cross-app dispatch — present on the kernel-injected ctx (and the
   * order-paid / agent / manual-issue ctxs). Optional so pure unit tests can
   * omit it. When present, the customs snapshot falls back to a live
   * `shopify:variants_get` for Shopify lines whose overlay carries no customs
   * yet, then caches the result into `product_customs_overlay`.
   */
  executeTool?: CrossAppExecuteTool
  /** The host's clock in a time zone: the issue date and number year (`issue-date.ts`). */
  time: TimeSurface["time"]
  pdf: {
    render(p: {
      template_kind: string
      data: unknown
      /** Download name for the stored PDF (e.g. `invoice-EMB-2026-8201.pdf`);
       *  sanitised host-side. Omitted -> the generic template-kind name. */
      filename?: string
      /** BL-191 — commit `<table>.<column> = file_id` in the host's privileged file-write tx so an
       *  on-demand render is visible cross-app before this handler commits. Host validates the column
       *  against the app's manifest schema. */
      link?: { table: string; column: string; row_id: string }
      /** Native PDF/A-3B (legal originals; Factur-X with its XML attached). */
      pdfa?: "3b"
      attachments?: Array<{
        name: string
        mime: string
        bytesBase64: string
        afRelationship: "Data" | "Source" | "Alternative" | "Supplement" | "Unspecified"
        description?: string
      }>
      xmp?: {
        extensions: Array<{
          schema: string
          namespaceUri: string
          prefix: string
          properties: Array<{ name: string; value: string; description: string }>
        }>
      }
      /** Store the file under one of this app's fileParents (default `pdf`); without an
       *  entityId the host mints one and returns it as `parent_entity_id`. */
      parent?: {
        entityType: string
        entityId?: string
        /** Insert the parent row with the file, committed (see the SDK). */
        commitRow?: {
          values: Record<string, string | number | boolean | null>
          fileIdColumn?: string
          sha256Column?: string
          sizeColumn?: string
        }
      }
    }): Promise<{
      file_id: string
      byte_size: number
      page_count: number
      sha256?: string
      parent_entity_id?: string
    }>
  }
  /** Kernel file bridge (stores bytes under one of this app's fileParents). Absent in pure
   *  unit-test contexts. */
  files_importAttachment?(argsJson: string): Promise<string>
  messages: {
    post(p: {
      contact_id: string
      body: string
      attachment_file_ids: string[]
    }): Promise<{ message_id: string }>
  }
  /**
   * The real SDK channel for the kernel audit trail (declared manifest events
   * `document:issued` / `document:paid` / `document:po_number_changed`). Present on the
   * kernel-injected ctx (and every real caller — MutationsCtx.emit is a superset); optional
   * so pure unit tests that don't care about the audit trail can omit it.
   */
  emit?(event: {
    entity: string
    action: string
    entityId?: string
    data?: unknown
    metadata?: Record<string, unknown>
  }): Promise<void>
  /** Handler-conditional approval (kernel). Used after issue to ask for an e-invoice's send
   *  approval; optional so pure unit tests can omit it. */
  requestApproval?(input: {
    tool_name: string
    summary: string
    summary_detail?: {
      subtitle?: string
      lines?: string[]
      links?: Array<{ label: string; app: string; entityType: string; entityId: string }>
    }
    current_payload: unknown
    editable_fields?: string[]
  }): Promise<
    | { approval_id: string; auto_approved?: undefined }
    | { approval_id: string | null; auto_approved: true }
  >
}

export interface DocumentInsert {
  type: string
  scope: DocumentScope | null
  status: string
  number: string | null
  number_int: number | null
  year_of_issue: number | null
  issuer_profile_id: string
  counterparty_contact_id: string | null
  counterparty_name: string | null
  /** Full counterparty snapshot at issue time — persisted so a PDF re-render (ensureDocumentPdf)
   *  and documents_get/search can reproduce the Bill-to block without the original in-flight
   *  Counterparty object. Later edits to the source contact do NOT mutate this snapshot. */
  counterparty_address: string | null
  /** Ship to snapshot, persisted alongside the billing snapshot so a re-render reproduces the
   *  SHIP TO block. Render only: never an input to `classify()`. */
  counterparty_shipping_address: string | null
  counterparty_shipping_name: string | null
  counterparty_vat_id: string | null
  counterparty_email: string | null
  counterparty_country: string | null
  currency: string
  subtotal_minor: bigint
  tax_total_minor: bigint
  grand_total_minor: bigint
  tax_treatment: string | null
  incoterm: string
  issued_at: string | null
  due_at: string | null
  /** Payment settlement, mirroring documents.payment_status (unpaid | partial | paid | refunded).
   *  Omitted on a normal unpaid issuance so the column keeps its DB default ("unpaid"); the
   *  Shopify order-paid flow sets it to "paid" at issue time so the PDF renders "Amount paid". */
  payment_status?: string | null
  /** Settlement date, mirroring documents.paid_at. Set alongside payment_status="paid". */
  paid_at?: string | null
  pdf_file_id: string | null
  pdf_status: string | null
  external_refs: Record<string, unknown>
  /**
   * Top-level mirror of `external_refs.shopify_order_id`, persisted as an
   * indexed column so the Shopify webhook handlers can dedup with an indexed
   * equality lookup instead of scanning an unordered slice of documents.
   */
  shopify_order_id: string | null
  /**
   * Top-level mirror of `external_refs.shopify_order_number`: the HUMAN order
   * reference the customer and the store both quote ("#1149", "EMB2357") --
   * NOT the numeric/gid `shopify_order_id`. Persisted as its own indexed column
   * so `documents_search` matches an order-number query, and rendered on the
   * PDF face so the order can be read straight off an invoice.
   */
  shopify_order_number: string | null
  /**
   * Top-level mirror of `external_refs.shipment_ref` (same pattern as
   * shopify_order_id): the physical shipment batch this document covers.
   * NULL for whole-order documents; part of the (shopify_order_id, scope,
   * shipment_ref) uniqueness key that allows one proforma per batch.
   */
  shipment_ref: string | null
  /**
   * Top-level mirror of `external_refs.shopify_draft_order_id`: the Shopify draft
   * order gid this quote IS. A mapped shop makes every quote a draft order, so the
   * column carries a partial UNIQUE index and is the idempotency key the
   * `draft_order:*` event handlers dedup on.
   */
  shopify_draft_order_id: string | null
  /** Top-level mirror of `external_refs.shopify_draft_order_name`: the human draft
   *  order reference ("#D12") the store shows. */
  shopify_draft_order_name: string | null
  /**
   * Top-level mirror of `external_refs.po_number`: the customer's purchase order
   * number, when they gave one. Persisted as its own column (same pattern as
   * shopify_order_number) so it is searchable via documents_search and rendered
   * on the PDF face without a JSON reach-through, and remains amendable on an
   * already-issued document via documents_update (a non-financial reference,
   * same class as the address or due date).
   */
  po_number: string | null
  /**
   * Free-text notes printed on the document PDF under the totals: a contract
   * reference, extra customs information, a special mention the customer asked
   * for. NON FINANCIAL, so it stays editable via documents_update on an already
   * issued, sent or paid document (which re-renders the PDF), exactly like
   * po_number. A plain column with no external_refs mirror.
   */
  notes: string | null
  /** Credit notes only: the original invoice, as a real column. */
  original_document_id?: string | null
  /** Credit notes only: the original's stored regime, its reasons, and whether the credit note
   *  is an internal cancellation (original refused or rejected). */
  regime?: Regime
  regime_reasons?: unknown[]
  internal_cancellation?: boolean
  /** The e-invoicing snapshot written by the issue gate (regime, buyer, billing, category). */
  einvoice?: Partial<RegimeSnapshotColumns>
  lifecycle_log: Array<Record<string, unknown>>
  /** The unique source key of the document, when one produced it (a dedup key, unique when set). */
  external_ref?: string | null
}
export interface DocumentRow extends DocumentInsert {
  id: string
}
export interface LineInsert {
  document_id: string
  position: number
  description: string
  quantity: string
  unit_price_minor: bigint
  discount_minor: bigint
  line_kind: LineKind
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
export interface OverlayRow {
  source: string
  external_id: string
  hs_code: string | null
  country_of_origin: string | null
  customs_description: string | null
}

function bigintToString(v: bigint): string {
  return v.toString()
}

/**
 * The human Shopify order reference carried on a document's `external_refs`
 * (`shopify_order_number`, e.g. "#1149"). Three writers put it there: the
 * order-created auto-flow (from the webhook's `name`), the CSV importer
 * (`order_number`), and an agent creating a draft for a known order. Everything
 * downstream -- the top-level mirror column, the PDF header line, the search
 * index -- reads it through here so the shapes stay in one place.
 *
 * Blank strings normalise to null: an empty column would otherwise match a
 * search for "" and render an empty "Order:" line on the PDF.
 */
export function readOrderNumber(refs: Record<string, unknown> | null | undefined): string | null {
  const raw = refs?.shopify_order_number
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  return trimmed === "" ? null : trimmed
}

/**
 * Read a non-blank string off a draft's `external_refs`, or null. Used for the
 * top-level mirror columns (shopify_draft_order_id / _name) so a blank ref never
 * becomes a blank column that a partial UNIQUE index or a search would match.
 */
export function readRefString(
  refs: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const raw = refs?.[key]
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  return trimmed === "" ? null : trimmed
}

/**
 * Serialise an insert payload for the bridge: bigint columns become
 * string-encoded numerics (the bridge JSON-stringifies the payload, which
 * cannot represent BigInt natively, and the underlying Postgres column
 * is BIGINT — accepting a numeric string).
 */
function serialiseDocumentInsert(row: DocumentInsert): Record<string, unknown> {
  return {
    type: row.type,
    scope: row.scope,
    status: row.status,
    number: row.number,
    number_int: row.number_int,
    year_of_issue: row.year_of_issue,
    issuer_profile_id: row.issuer_profile_id,
    counterparty_contact_id: row.counterparty_contact_id,
    counterparty_name: row.counterparty_name,
    counterparty_address: row.counterparty_address,
    counterparty_shipping_address: row.counterparty_shipping_address,
    counterparty_shipping_name: row.counterparty_shipping_name,
    counterparty_vat_id: row.counterparty_vat_id,
    counterparty_email: row.counterparty_email,
    counterparty_country: row.counterparty_country,
    currency: row.currency,
    subtotal_minor: bigintToString(row.subtotal_minor),
    tax_total_minor: bigintToString(row.tax_total_minor),
    grand_total_minor: bigintToString(row.grand_total_minor),
    tax_treatment: row.tax_treatment,
    incoterm: row.incoterm,
    issued_at: row.issued_at,
    due_at: row.due_at,
    // Only sent when explicitly settled at issue (Shopify order-paid) — otherwise omitted so the
    // documents.payment_status column keeps its "unpaid" default and paid_at stays null.
    ...(row.payment_status ? { payment_status: row.payment_status } : {}),
    ...(row.paid_at ? { paid_at: row.paid_at } : {}),
    pdf_file_id: row.pdf_file_id,
    pdf_status: row.pdf_status,
    external_refs: row.external_refs,
    shopify_order_id: row.shopify_order_id,
    shopify_order_number: row.shopify_order_number,
    shipment_ref: row.shipment_ref,
    shopify_draft_order_id: row.shopify_draft_order_id,
    shopify_draft_order_name: row.shopify_draft_order_name,
    po_number: row.po_number,
    notes: row.notes,
    ...(row.original_document_id ? { original_document_id: row.original_document_id } : {}),
    ...(row.regime ? { regime: row.regime, regime_reasons: row.regime_reasons ?? [] } : {}),
    ...(row.internal_cancellation !== undefined
      ? { internal_cancellation: row.internal_cancellation }
      : {}),
    ...(row.einvoice ?? {}),
    ...(row.external_ref ? { external_ref: row.external_ref } : {}),
    lifecycle_log: row.lifecycle_log,
  }
}

/** The link / regime columns of a credit note. The regime is the ORIGINAL's stored regime (never
 *  re-classified from current data); a refused or rejected original makes the note an internal
 *  cancellation. A legacy original with no stored regime leaves the regime columns unset. */
function creditNoteOriginalColumns(
  type: DocumentType,
  issuer: IssuerProfile,
  original: NonNullable<IssueInput["original"]> | null,
): Partial<DocumentInsert> {
  if (type !== "credit_note" || !original) return {}
  const out: Partial<DocumentInsert> = { original_document_id: original.id }
  if (!original.regime) return out
  const verdict = classifyRegime({
    docType: "credit_note",
    issuerCountry: issuer.country,
    issuerVatRegistered: !!issuer.vat_id,
    customerKind: null,
    billingCountry: null,
    billingPostcode: null,
    vatId: null,
    buyerSiren: null,
    sirenStatus: null,
    territoryTreatment: null,
    original: { regime: original.regime, transmissionStatus: original.transmissionStatus ?? null },
  })
  if (verdict.regime === null) return out
  out.regime = verdict.regime
  out.regime_reasons = verdict.reasons
  out.internal_cancellation = verdict.internalCancellation === true
  return out
}

function serialiseLineInsert(row: LineInsert): Record<string, unknown> {
  return {
    document_id: row.document_id,
    position: row.position,
    description: row.description,
    quantity: row.quantity,
    unit_price_minor: bigintToString(row.unit_price_minor),
    discount_minor: bigintToString(row.discount_minor),
    line_kind: row.line_kind,
    tax_rate_bp: row.tax_rate_bp,
    subtotal_minor: bigintToString(row.subtotal_minor),
    tax_minor: bigintToString(row.tax_minor),
    total_minor: bigintToString(row.total_minor),
    hs_code: row.hs_code,
    country_of_origin: row.country_of_origin,
    customs_description: row.customs_description,
    product_source: row.product_source,
    external_id: row.external_id,
  }
}

async function lookupOverlay(
  db: IssueDb,
  source: string,
  externalId: string,
): Promise<OverlayRow | null> {
  const rows = await db.findMany("product_customs_overlay", {
    where: { source, external_id: externalId },
    limit: 1,
  })
  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return {
    source: String(row.source),
    external_id: String(row.external_id),
    hs_code: (row.hs_code as string | null) ?? null,
    country_of_origin: (row.country_of_origin as string | null) ?? null,
    customs_description: (row.customs_description as string | null) ?? null,
  }
}

interface FetchedCustoms {
  hs_code: string | null
  country_of_origin: string | null
  customs_description: string | null
}

/**
 * Raised when the live customs fetch fails (Shopify throttle, invalid variant
 * id, transport error). Carries the upstream error code + retryable flag so the
 * caller can record a discoverable `customs_fetch_failed` lifecycle entry —
 * including whether we were being rate-limited — rather than silently dropping
 * the customs.
 */
export class CustomsFetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = "CustomsFetchError"
  }
  /** True when the failure is a Shopify rate-limit / throttle. */
  get throttled(): boolean {
    return (
      this.code === "RATE_LIMIT" ||
      this.code === "429" ||
      this.retryable ||
      /throttl|rate.?limit|429/i.test(this.message)
    )
  }
}

/**
 * Live customs fetch for a single Shopify variant gid via the cross-app
 * `shopify:variants_get` read (extended to flatten HS code + country of origin
 * + the product's customs-description metafield onto `attributes`). Returns the
 * customs triple on success (fields may be null when the variant genuinely
 * carries none). THROWS `CustomsFetchError` on a failed fetch (throttle / bad
 * id / transport) so the caller surfaces it on the document lifecycle.
 */
async function fetchShopifyVariantCustoms(
  executeTool: CrossAppExecuteTool,
  variantId: string,
): Promise<FetchedCustoms | null> {
  // No swallowing: a Shopify throttle (the client throws `RATE_LIMIT` after 3×
  // 429 retries), an invalid variant id, or a transport failure must surface so
  // the caller can record it on the document lifecycle — missing customs is
  // never silent. `executeTool` may throw (transport) or return a non-completed
  // envelope (tool error); both propagate as a thrown CustomsFetchError.
  const envelope = await executeTool("shopify:variants_get", { id: variantId })
  if (envelope.status !== "completed") {
    const e =
      (envelope as { error?: { code?: string; message?: string; retryable?: boolean } }).error ?? {}
    throw new CustomsFetchError(
      e.message ?? "shopify:variants_get failed",
      e.code ?? "tool_error",
      e.retryable ?? false,
    )
  }
  const hit = envelope.result as { attributes?: Record<string, unknown> } | null
  const attrs = hit?.attributes ?? {}
  return {
    hs_code: (attrs.hs_code as string | null) ?? null,
    country_of_origin: (attrs.country_of_origin as string | null) ?? null,
    customs_description: (attrs.customs_description as string | null) ?? null,
  }
}

/**
 * Cache a freshly-fetched customs triple into `product_customs_overlay` so
 * subsequent issuances (and the export overlay UI) read from the overlay. Same
 * upsert shape the product-changed sync uses (source='shopify',
 * updated_by_user_id=null); only reached when the row is absent or has no
 * customs, so this never clobbers a manual `hs_codes_assign` override.
 */
async function cacheVariantOverlay(
  db: IssueDb,
  externalId: string,
  customs: FetchedCustoms,
): Promise<void> {
  const existing = (await db.findMany("product_customs_overlay", {
    where: { source: "shopify", external_id: externalId },
    limit: 1,
  })) as Array<Record<string, unknown>>
  const data = {
    source: "shopify",
    external_id: externalId,
    hs_code: customs.hs_code,
    country_of_origin: customs.country_of_origin,
    customs_description: customs.customs_description,
    updated_by_user_id: null,
  }
  const current = existing[0]
  if (current) {
    await db.update("product_customs_overlay", String(current.id), data)
  } else {
    await db.insert("product_customs_overlay", data)
  }
}

/** A customs fetch that failed (throttle / bad id / transport) — recorded as a discoverable
 *  `customs_fetch_failed` lifecycle entry by the caller so a rate-limit or upstream error is never
 *  silently swallowed into "no customs". */
export interface CustomsFetchFailure {
  external_id: string
  code: string
  throttled: boolean
  retryable: boolean
  detail: string
}

/**
 * Resolve the effective customs triple (hs_code / country_of_origin / customs_description) for ONE
 * line: an explicit value on the line ALWAYS wins; a blank field falls back to the
 * `product_customs_overlay` row for (product_source, external_id) — with a live
 * `shopify:variants_get` fetch (cached back into the overlay) when the overlay is empty, the source
 * is 'shopify', `ctx.executeTool` is available, and `requiresHsCode` is true (extra-EU export — a
 * live fetch is pointless, and can even fail, on a domestic/reverse-charge document).
 *
 * Extracted from `issueDocument`'s per-line loop so BOTH the issue path AND `documents_update`'s
 * post-issue line replacement (mutations.ts) apply the exact same enrichment — an agent-created
 * document gets the same automatic HS-code fill the Shopify paid-order webhook flow gets.
 *
 * THROWS `CustomsFetchError` when the invoice legally requires HS codes (export) and the fetch fails
 * for a *retryable* reason (throttle / transport) — mirroring issueDocument's bail-before-persist
 * behavior so the caller can defer + retry rather than persist a customs-incomplete export line. Any
 * other failure is swallowed into the returned `fetchFailure` so the caller can log it without
 * blocking best-effort persistence.
 */
export async function enrichLineCustoms(
  ctx: { db: IssueDb; executeTool?: CrossAppExecuteTool },
  line: {
    hs_code?: string | null
    country_of_origin?: string | null
    customs_description?: string | null
    product_source?: string | null
    external_id?: string | null
  },
  requiresHsCode: boolean,
): Promise<{
  hs_code: string | null
  country_of_origin: string | null
  customs_description: string | null
  fetchFailure: CustomsFetchFailure | null
}> {
  let hs_code: string | null = line.hs_code ?? null
  let country_of_origin: string | null = line.country_of_origin ?? null
  let customs_description: string | null = line.customs_description ?? null
  let fetchFailure: CustomsFetchFailure | null = null
  if (line.product_source && line.external_id) {
    let overlay = await lookupOverlay(ctx.db, line.product_source, line.external_id)
    const overlayEmpty =
      !overlay || (!overlay.hs_code && !overlay.country_of_origin && !overlay.customs_description)
    if (line.product_source === "shopify" && overlayEmpty && ctx.executeTool && requiresHsCode) {
      try {
        const fetched = await fetchShopifyVariantCustoms(ctx.executeTool, line.external_id)
        if (
          fetched &&
          (fetched.hs_code || fetched.country_of_origin || fetched.customs_description)
        ) {
          await cacheVariantOverlay(ctx.db, line.external_id, fetched)
          overlay = { source: "shopify", external_id: line.external_id, ...fetched }
        }
      } catch (err) {
        const ce = err instanceof CustomsFetchError ? err : null
        if (ce && (ce.retryable || ce.throttled) && requiresHsCode) {
          throw ce
        }
        fetchFailure = {
          external_id: line.external_id,
          code: ce?.code ?? (err as { code?: string }).code ?? "customs_fetch_failed",
          throttled: ce?.throttled ?? false,
          retryable: ce?.retryable ?? false,
          detail: (ce?.message ?? (err as { message?: string }).message ?? String(err)).slice(
            0,
            300,
          ),
        }
      }
    }
    if (overlay) {
      hs_code = hs_code ?? overlay.hs_code
      country_of_origin = country_of_origin ?? overlay.country_of_origin
      customs_description = customs_description ?? overlay.customs_description
    }
  }
  return { hs_code, country_of_origin, customs_description, fetchFailure }
}

/** Documents in these statuses were never issued: a profile holding only them is at its first issue. */
const NEVER_ISSUED_STATUSES: ReadonlySet<string> = new Set(["draft", "pending_approval"])

/**
 * True at the first issue on an issuer profile nobody gave a time zone, in an organization that
 * has none either: the one moment the zone is asked (the line is raised once, after the number is
 * taken). A profile with a zone, an organization with a zone, or a profile with issued documents
 * (no backfill) is never asked.
 */
async function timezoneAskDue(ctx: IssueCtx, issuer: IssuerProfile): Promise<boolean> {
  if (!issuerTimezoneUnset(issuer)) return false
  const org = await ctx.time.civil({ timezone: DEFAULT_ZONE })
  if (org.zone !== DEFAULT_ZONE) return false

  const rows = (await ctx.db.findMany("documents", {
    where: { issuer_profile_id: issuer.id },
    select: ["id", "status"],
    limit: 200,
  })) as Array<{ status?: string | null }>
  return rows.every((r) => NEVER_ISSUED_STATUSES.has(String(r.status ?? "draft")))
}

export async function issueDocument(ctx: IssueCtx, input: IssueInput): Promise<IssueResult> {
  const prepared = await prepareIssue(ctx, input)
  // 6) Number, document, lines and the caller's own writes commit in ONE batch: a sandboxed run
  //    holds no transaction across its calls, so a run that fails or is killed after this point
  //    leaves an issued, numbered document (whose PDF a retry renders), and one that fails before
  //    it leaves nothing and consumes no number.
  const committed = await ctx.db.batch({ sequence: prepared.sequence, ops: prepared.ops })
  const allocated = committed.sequence
  if (
    !allocated ||
    typeof allocated.value !== "number" ||
    typeof allocated.formatted !== "string"
  ) {
    throw new Error(`numbering failed for "${prepared.sequence.key}": ${JSON.stringify(committed)}`)
  }
  return prepared.finish({
    value: allocated.value,
    formatted: allocated.formatted,
    documentId: String(committed.rows.document?.id),
  })
}

/**
 * Issue several documents in ONE commit: each is prepared (steps 0-5, nothing written), then every
 * document, its lines and its `commit_with` writes land in one `ctx.db.batch` that allocates each
 * document's number from its own named sequence, then each is finished in order (PDF, thread
 * post, ...). Either all of them are issued and numbered, or none is and no number is used: two
 * documents one decision covers (a credit note and the invoice that replaces the one it reverses)
 * never land half. Returns the results by the names given.
 */
export async function issueTogether<N extends string>(
  ctx: IssueCtx,
  inputs: ReadonlyArray<readonly [N, IssueInput]>,
): Promise<Record<N, IssueResult>> {
  const prepared: Array<[N, PreparedIssue]> = []
  for (const [name, input] of inputs) prepared.push([name, await prepareIssue(ctx, input)])
  const committed = await ctx.db.batch({
    sequences: Object.fromEntries(prepared.map(([name, p]) => [name, p.sequence])),
    ops: prepared.flatMap(([name, p]) => p.ops.map((op) => namespacedOp(op, name))),
  })
  const results = {} as Record<N, IssueResult>
  for (const [name, p] of prepared) {
    const allocated = committed.sequences?.[name]
    if (
      !allocated ||
      typeof allocated.value !== "number" ||
      typeof allocated.formatted !== "string"
    ) {
      throw new Error(`numbering failed for "${p.sequence.key}": ${JSON.stringify(committed)}`)
    }
    results[name] = await p.finish({
      value: allocated.value,
      formatted: allocated.formatted,
      documentId: String(committed.rows[`${name}.document`]?.id),
    })
  }
  return results
}

/** One prepared write renamed into a shared batch: its rows (`as`, `$ref`) and its number
 *  (`$seq`) become `<name>.…`, so two documents' placeholders never meet. */
function namespacedOp(op: IssueBatchOp, name: string): IssueBatchOp {
  const rename = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(rename)
    if (v === null || typeof v !== "object") return v
    const o = v as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length === 1 && keys[0] === "$seq") return { $seq: `${name}.${String(o.$seq)}` }
    if (keys.length === 1 && keys[0] === "$ref") return { $ref: `${name}.${String(o.$ref)}` }
    return Object.fromEntries(keys.map((k) => [k, rename(o[k])]))
  }
  const out = rename(op) as Record<string, unknown>
  if ("insert" in op && typeof op.as === "string") out.as = `${name}.${op.as}`
  return out as IssueBatchOp
}

/** Steps 0-5 of an issuance (see the file header), and its post-commit steps as `finish`. */
export async function prepareIssue(ctx: IssueCtx, input: IssueInput): Promise<PreparedIssue> {
  const { type, issuer, counterparty, draft } = input

  // 0) Recipient completeness. Runs BEFORE number allocation and any persistence, so a refused
  //    issuance consumes no invoice number and leaves no partial row. Backstop only — handlers
  //    check first and return a typed error; a throw here means a new path skipped that check.
  const incomplete = counterpartyCompletenessError(counterparty)
  if (incomplete) throw new CounterpartyIncompleteError(incomplete.message, incomplete.code)

  // 0b) E-invoicing gate. Same order rule: before numbering and any persistence. Backstop only —
  //     each issuing handler runs `checkEinvoiceGate` first and returns the typed, retryable
  //     error; this throw means a new path skipped it. Warn mode issues and records the warning.
  const gate = await prepareEinvoiceGate(
    ctx,
    {
      type,
      issuer,
      counterparty,
      lines: draft.lines,
      operation_category: input.operation_category ?? null,
      operation_source: input.operation_source ?? null,
      // The payment state AT ISSUE is recorded for every invoice (BT-23 x1 / x2 reads it, never
      // the later payment_status: a Factur-X first rendered after a mark-paid must still say due).
      payment_state:
        input.payment_state ?? (type === "invoice" ? (input.settlement ? "paid" : "due") : null),
      original: type === "credit_note" ? (input.original ?? null) : null,
      origin: input.origin ?? "manual",
    },
    { materialise: true },
  )
  const gateRefusal = gate.evaluation.refusal
  if (gateRefusal && gateRefusal.mode === "enforce") throw new EinvoiceGateRefusal(gateRefusal)
  const einvoicingWarning = gateRefusal ? gateWarning(gateRefusal) : undefined
  if (gate.derivedKind && counterparty.contact_id) {
    await ensureDerivedIdentity(ctx.db, {
      contact_id: counterparty.contact_id,
      customer_kind: gate.derivedKind,
      vat_id: counterparty.vat_id,
      billing_country: gate.input.buyer.billing.countryCode,
    })
  }

  const reasonFromRefs =
    typeof draft.external_refs.reason === "string" ? (draft.external_refs.reason as string) : null

  // 1) Tax treatment via D2 classifier, on the tax destination when the caller separated it from
  //    the printed billing country.
  const taxCountry = taxCountryOf(counterparty)
  const classification = classify({
    issuer_country: issuer.country,
    counterparty_country: taxCountry,
    has_vat_id: !!counterparty.vat_id,
  })
  const externalRefs: Record<string, unknown> =
    taxCountry && taxCountry !== counterparty.country
      ? { ...draft.external_refs, tax_country: taxCountry }
      : draft.external_refs
  const docDefaultRateBp = classification.default_rate_bp

  // 2) Build snapshot lines from draft + overlay lookup.
  const snapshotLines: Omit<LineInsert, "document_id">[] = []
  // Customs fetches that failed (throttle / bad id / transport) — recorded as
  // discoverable `customs_fetch_failed` lifecycle entries below so a rate-limit
  // or upstream error is never silently swallowed into "no customs".
  const customsFetchFailures: CustomsFetchFailure[] = []
  for (const [lineIndex, dl] of draft.lines.entries()) {
    const lineKind: LineKind = dl.line_kind ?? "goods"
    // Inline customs facts win — the agent can assign HS code / origin / goods description directly on
    // the line at drafts_create (no separate hs_codes_assign step). The product overlay only FILLS a
    // field the line left blank. Delegates to enrichLineCustoms (shared with documents_update).
    // Software and shipping lines are NOT customs goods: no overlay fill, no live
    // fetch, no HS-code requirement — even on an export invoice.
    const enriched =
      lineKind === "goods"
        ? await enrichLineCustoms(ctx, dl, classification.requires_hs_code)
        : { hs_code: null, country_of_origin: null, customs_description: null, fetchFailure: null }
    const { hs_code, country_of_origin, customs_description } = enriched
    if (enriched.fetchFailure) customsFetchFailures.push(enriched.fetchFailure)
    const tax_rate_bp =
      typeof dl.tax_rate_bp_override === "number" ? dl.tax_rate_bp_override : docDefaultRateBp
    const discount_minor = dl.discount_minor ?? 0n
    // Discount is subtracted from the line subtotal and rendered explicitly on
    // the document — never folded into the unit price.
    const { subtotal_minor, tax_minor, total_minor } = lineAmounts(
      { quantity: dl.quantity, unit_price_minor: dl.unit_price_minor, discount_minor },
      tax_rate_bp,
    )
    snapshotLines.push({
      // Agent create-and-issue items carry no `position` (only DB-loaded draft lines do); fall back
      // to the loop index so the NOT-NULL `document_lines.position` is always set (was: a null
      // INSERT → 23502 aborted the gated issuance).
      position: dl.position ?? lineIndex,
      description: dl.description,
      quantity: dl.quantity,
      unit_price_minor: dl.unit_price_minor,
      discount_minor,
      line_kind: lineKind,
      tax_rate_bp,
      subtotal_minor,
      tax_minor,
      total_minor,
      hs_code,
      country_of_origin,
      customs_description,
      product_source: dl.product_source,
      external_id: dl.external_id,
    })
  }

  // 3) Money rollup via D5.
  const rollup = documentRollup(snapshotLines)
  const fxDate = fxIssueDate(draft.issued_at)
  const fxSnapshot =
    draft.currency && draft.currency !== "EUR"
      ? await cachedRate(ctx.db, draft.currency, fxDate)
      : null
  // A foreign-currency e-invoice carries its VAT total in EUR (BT-111): without a rate its
  // Factur-X can never be built, and an issued document is never re-snapshotted. Refuse it here,
  // before numbering, so nothing is persisted and the call can simply be retried. The issuing
  // path warmed the cache just before; only an unreachable ECB lands here. Every other document
  // (EUR, out of the e-invoicing regime, an internal cancellation) issues without a rate.
  if (
    draft.currency &&
    draft.currency !== "EUR" &&
    !fxSnapshot &&
    (type === "invoice" || type === "credit_note") &&
    gate.evaluation.regime === "e_invoice" &&
    !gate.evaluation.internalCancellation
  ) {
    throw new FxRateUnavailableError(draft.currency, fxDate)
  }

  // 4) Numbering via D3: the number is allocated by the batch that writes the document (6).
  const sequence = numberingSequence({
    issuer_profile: issuer,
    type,
    year_of_issue: draft.year_of_issue,
  })

  const askTimezone = await timezoneAskDue(ctx, issuer)

  // 5) The document row, numbered by the batch.
  const nowIso = new Date().toISOString()
  const userId = await ctx.getUserId()
  const documentInsert: DocumentInsert = {
    type,
    scope: input.scope ?? null,
    status: input.initial_status ?? "issued",
    number: null,
    number_int: null,
    year_of_issue: draft.year_of_issue,
    issuer_profile_id: issuer.id,
    counterparty_contact_id: counterparty.contact_id,
    counterparty_name: counterparty.legal_name ?? null,
    counterparty_address: counterparty.address ?? null,
    counterparty_shipping_address: counterparty.shipping_address ?? null,
    counterparty_shipping_name: counterparty.shipping_name ?? null,
    counterparty_vat_id: counterparty.vat_id ?? null,
    counterparty_email: counterparty.email ?? null,
    counterparty_country: counterparty.country ?? null,
    currency: draft.currency,
    subtotal_minor: rollup.subtotal_minor,
    tax_total_minor: rollup.tax_total_minor,
    grand_total_minor: rollup.grand_total_minor,
    tax_treatment: classification.treatment,
    incoterm: draft.incoterm,
    issued_at: draft.issued_at,
    due_at: draft.due_at,
    // Born-settled (Shopify order-paid): only payment_status/paid_at are set — status stays
    // "issued" so the invoice remains a live, shippable document.
    ...(input.settlement ? { payment_status: "paid", paid_at: input.settlement.paid_at } : {}),
    pdf_file_id: null,
    pdf_status: "pending",
    external_refs: externalRefs,
    shopify_order_id:
      typeof draft.external_refs.shopify_order_id === "string"
        ? draft.external_refs.shopify_order_id
        : null,
    shopify_order_number: readOrderNumber(draft.external_refs),
    shipment_ref:
      typeof draft.external_refs.shipment_ref === "string"
        ? draft.external_refs.shipment_ref
        : null,
    shopify_draft_order_id: readRefString(draft.external_refs, "shopify_draft_order_id"),
    shopify_draft_order_name: readRefString(draft.external_refs, "shopify_draft_order_name"),
    po_number: readRefString(draft.external_refs, "po_number"),
    // Plain column, straight off the draft: notes has no external_refs mirror.
    notes: draft.notes ?? null,
    ...(gate
      ? {
          einvoice: regimeSnapshot({
            evaluation: gate.evaluation,
            input: gate.input,
            issuedAt: draft.issued_at,
            delivery: counterparty.delivery ?? null,
            // Cache read only: a missing rate leaves the fx columns null and never blocks the issue.
            fx: fxSnapshot,
            taxTotalMinor: rollup.tax_total_minor,
            currency: draft.currency,
          }),
        }
      : creditNoteOriginalColumns(type, issuer, input.original ?? null)),
    ...(input.external_ref ? { external_ref: input.external_ref } : {}),
    lifecycle_log: [
      ...(input.lifecycle_carry ?? []),
      { event: "issued", actor: userId, ts: nowIso },
      // Warn mode: the gate's refusal is recorded, calmly, on the document it did not block.
      ...(gateRefusal
        ? [
            {
              event: "einvoice_gate_warning",
              actor: userId,
              ts: nowIso,
              code: gateRefusal.code,
              missing: gateRefusal.missing.map((m) => m.field),
            },
          ]
        : []),
      // A born-settled issuance records the settlement inline (same shape the manual/reconcile
      // mark-paid paths append), so a Shopify paid order still shows a "marked_paid" audit entry.
      ...(input.settlement
        ? [{ event: "marked_paid", actor: userId, ts: nowIso, source: input.settlement.source }]
        : []),
      // Audit trail: every time a PO number is set, changed or cleared gets a dedicated
      // lifecycle_log entry recording the before/after value and where it came from -- a
      // silent change to a customer-facing reference is exactly what causes a dispute months
      // later, and this is what settles it. The very first set (a fresh issuance) is "changed"
      // from null too, so it is logged here just like any later documents_update edit.
      ...(readRefString(draft.external_refs, "po_number")
        ? [
            {
              event: "po_number_changed",
              actor: userId,
              ts: nowIso,
              from: null,
              to: readRefString(draft.external_refs, "po_number"),
              source: input.po_number_source ?? "person",
            },
          ]
        : []),
    ],
  }
  // The writes of step 6 (see issueDocument): the document, its lines, the caller's own.
  const ops: IssueBatchOp[] = [
    ...(input.commit_before ?? []),
    {
      insert: "documents",
      as: "document",
      data: {
        ...serialiseDocumentInsert(documentInsert),
        number: { $seq: "formatted" },
        number_int: { $seq: "value" },
      },
    },
    ...snapshotLines.map((l) => ({
      insert: "document_lines",
      data: {
        ...serialiseLineInsert({ ...l, document_id: "" }),
        document_id: { $ref: "document" },
      },
    })),
    ...(input.commit_with ?? []),
  ]

  const finish = async (committed: {
    value: number
    formatted: string
    documentId: string
  }): Promise<IssueResult> => {
    const numberResult = { value: committed.value, formatted: committed.formatted }
    documentInsert.number = numberResult.formatted
    documentInsert.number_int = numberResult.value
    const documentId = committed.documentId

    // Kernel audit trail — mirrors the lifecycle_log entries just written into
    // documentInsert.lifecycle_log above (issued / marked_paid / po_number_changed).
    // Optional: absent on the pure unit-test ctxs that don't care about the audit trail.
    if (ctx.emit) {
      await ctx.emit({
        entity: "document",
        action: "issued",
        entityId: documentId,
        data: {
          document_id: documentId,
          type,
          number: numberResult.formatted,
          status: documentInsert.status,
          currency: draft.currency,
          grand_total_minor: rollup.grand_total_minor.toString(),
        },
      })
      if (input.settlement) {
        await ctx.emit({
          entity: "document",
          action: "paid",
          entityId: documentId,
          data: {
            document_id: documentId,
            type,
            number: numberResult.formatted,
            status: documentInsert.status,
            currency: draft.currency,
            grand_total_minor: rollup.grand_total_minor.toString(),
            paid_at: input.settlement.paid_at,
            payment_status: "paid",
          },
        })
      }
      if (askTimezone) {
        // One Home line to the holders of the settings scope; a zone set on the profile resolves it.
        await ctx.emit({
          entity: "issuer_profile",
          action: "timezone_unset",
          entityId: issuer.id,
          data: {
            issuer_profile_id: issuer.id,
            legal_name: issuer.legal_name,
            document_id: documentId,
          },
        })
      }
      const issuedPoNumber = readRefString(draft.external_refs, "po_number")
      if (issuedPoNumber) {
        await ctx.emit({
          entity: "document",
          action: "po_number_changed",
          entityId: documentId,
          data: {
            document_id: documentId,
            type,
            number: numberResult.formatted,
            status: documentInsert.status,
            from: null,
            to: issuedPoNumber,
          },
        })
      }
    }

    // 7) Render PDF via ctx.pdf. Failures are captured: the document persists.
    //    An invoice or credit note's first render is its LEGAL ORIGINAL (PDF/A-3B; the Factur-X
    //    for an e_invoice document), fixed here in its own immutable row and file parent.
    let pdfFileId: string | null = null
    let pdfStatus: "ready" | "failed" | "facturx_failed" = "ready"
    let renderError: unknown = null
    const legalMention = await documentLegalMention(
      ctx.db,
      classification.treatment,
      issuer.default_language,
      {
        category:
          (documentInsert.einvoice?.operation_category as OperationCategory | null | undefined) ??
          null,
        issueDate: draft.issued_at,
      },
    )
    const templateData = buildTemplateData({
      type,
      document: { ...documentInsert, id: documentId },
      issuer,
      counterparty,
      lines: snapshotLines,
      requires_hs_code: classification.requires_hs_code,
      legal_mention: legalMention,
      original_invoice_number: input.original_invoice_number ?? null,
      original_invoice_date: input.original_invoice_date ?? null,
      reason: reasonFromRefs,
    })
    if (hasLegalOriginal(type)) {
      const docForFacturx = { ...documentInsert, id: documentId } as unknown as Record<
        string,
        unknown
      >
      let facturx: FacturxInput | null = null
      let buildError: FacturxBuildError | null = null
      if (facturxEligible(type, docForFacturx)) {
        try {
          facturx = facturxInputFrom({
            type: type as "invoice" | "credit_note",
            doc: docForFacturx,
            lines: snapshotLines,
            issuer: issuer as unknown as Record<string, unknown>,
            original: {
              number: input.original_invoice_number ?? null,
              issue_date: input.original_invoice_date ?? null,
            },
            legalMention,
          })
        } catch (err) {
          if (!(err instanceof FacturxBuildError)) throw err
          buildError = err
        }
      }
      const recorded = buildError
        ? ({
            ok: false,
            code: buildError.code,
            message: buildError.message,
            facturx: true,
          } as const)
        : await recordLegalOriginal(ctx, {
            documentId,
            type,
            number: documentInsert.number ?? documentId,
            templateData,
            facturx,
          })
      if (recorded.ok) {
        pdfFileId = recorded.file_id
      } else {
        renderError = { code: recorded.code, message: recorded.message }
        pdfStatus = recorded.facturx ? "facturx_failed" : "failed"
        if (recorded.facturx && ctx.emit) {
          await ctx.emit({
            entity: "einvoicing",
            action: "facturx_failed",
            entityId: documentId,
            data: {
              document_id: documentId,
              number: documentInsert.number,
              code: recorded.code,
              reason: recorded.message,
              resolved: false,
            },
          })
        }
      }
    } else {
      try {
        const rendered = (await ctx.pdf.render({
          template_kind: `invoicing:${type}_v1`,
          // Name the file after the document (e.g. `invoice-EMB-2026-8201.pdf`) so a
          // downloaded/emailed PDF is identifiable, not the generic template-kind name.
          filename: `${type}-${documentInsert.number}.pdf`,
          data: templateData,
        })) as
          | { file_id: string; byte_size: number; page_count: number }
          | { error: { code?: string; message?: string; retryable?: boolean } }
        // The bridge wraps thrown PDF errors into an envelope rather than
        // propagating them. Detect that shape and treat it as a render failure.
        if ("error" in rendered) {
          renderError = rendered.error
          pdfStatus = "failed"
        } else {
          pdfFileId = rendered.file_id
        }
      } catch (err) {
        renderError = err
        pdfStatus = "failed"
      }
    }

    // 8) Persist PDF status + lifecycle log update.
    const newLog: Array<Record<string, unknown>> = [...documentInsert.lifecycle_log]
    if (renderError) {
      newLog.push({
        event: "pdf_render_failed",
        actor: userId,
        ts: new Date().toISOString(),
        error: (renderError as { code?: string }).code ?? "render_failed",
        ...(pdfStatus === "facturx_failed"
          ? { facturx: true, detail: (renderError as { message?: string }).message ?? null }
          : {}),
      })
    }
    // Surface any live customs-fetch failures (Shopify throttle / bad id /
    // transport) so the invoice carries a discoverable trace of WHY a line is
    // missing customs — a rate-limit is flagged explicitly via `throttled`.
    for (const f of customsFetchFailures) {
      newLog.push({
        event: "customs_fetch_failed",
        actor: userId,
        ts: new Date().toISOString(),
        external_id: f.external_id,
        error: f.code,
        throttled: f.throttled,
        retryable: f.retryable,
        detail: f.detail,
      })
    }
    await ctx.db.update("documents", documentId, {
      pdf_file_id: pdfFileId,
      pdf_status: pdfStatus,
      lifecycle_log: newLog,
    })

    // 9) Post into the contact thread (best-effort; failure recorded but not
    // rethrown — caller treats absent thread post as an attention-feed item).
    if (pdfFileId && counterparty.contact_id) {
      try {
        await ctx.messages.post({
          contact_id: counterparty.contact_id,
          body: `${titleFor(type)} ${numberResult.formatted}`,
          attachment_file_ids: [pdfFileId],
        })
      } catch (err) {
        newLog.push({
          event: "thread_post_failed",
          actor: userId,
          ts: new Date().toISOString(),
          error: (err as { code?: string }).code ?? "thread_post_failed",
          detail: (err as { message?: string }).message ?? String(err),
        })
        await ctx.db.update("documents", documentId, { lifecycle_log: newLog })
      }
    }

    // 10) E-invoicing: an e_invoice issued on or after the cut-over, with sending switched on, gets
    //     ONE send approval request (never a send: a person approves it). Best effort: a context
    //     that cannot create approvals (or any failure) leaves it to the e-invoicing job.
    let einvoiceSend: { approval_id: string } | null = null
    if (pdfStatus === "ready" && pdfFileId && ctx.requestApproval) {
      try {
        const staged = await stageSendAfterIssue(ctx as unknown as EinvCtx, documentId, {
          send: input.einvoice_send ?? "stage",
        })
        if (staged) einvoiceSend = { approval_id: staged }
      } catch (err) {
        newLog.push({
          event: "einvoice_send_request_deferred",
          actor: userId,
          ts: new Date().toISOString(),
          detail: (err as { message?: string }).message ?? String(err),
        })
        await ctx.db.update("documents", documentId, { lifecycle_log: newLog })
      }
    }

    return {
      document_id: documentId,
      number: numberResult.formatted,
      pdf_file_id: pdfFileId,
      ...(einvoicingWarning ? { einvoicing_warning: einvoicingWarning } : {}),
      ...(einvoiceSend ? { einvoice_send_approval_id: einvoiceSend.approval_id } : {}),
    }
  }
  return { sequence, ops, finish }
}

/** The country the classifier must read for this counterparty: its tax destination when one was
 *  recorded, else its billing country. */
export function taxCountryOf(counterparty: Pick<Counterparty, "country" | "tax_country">): string {
  const t = typeof counterparty.tax_country === "string" ? counterparty.tax_country.trim() : ""
  return t !== "" ? t : counterparty.country
}

/** The tax destination recorded on a persisted document (`external_refs.tax_country`), or null for
 *  a document whose billing country was also its tax country. Used by every path that rebuilds a
 *  Counterparty from a stored row, so it classifies the document exactly as its issuance did. */
export function storedTaxCountry(
  row: { external_refs?: unknown } | null | undefined,
): string | null {
  const refs = row?.external_refs
  if (!refs || typeof refs !== "object") return null
  const raw = (refs as Record<string, unknown>).tax_country
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null
}

function titleFor(type: DocumentType): string {
  switch (type) {
    case "invoice":
      return "Invoice"
    case "quote":
      return "Quote"
    case "proforma":
      return "Proforma"
    case "purchase_order":
      return "Purchase Order"
    case "credit_note":
      return "Credit Note"
  }
}

export function buildTemplateData(params: {
  type: DocumentType
  document: DocumentRow
  issuer: IssuerProfile
  counterparty: Counterparty
  lines: Omit<LineInsert, "document_id">[]
  requires_hs_code: boolean
  legal_mention: string
  /** Credit notes only — the ORIGINAL invoice's number, resolved at render-data-build time from
   *  `external_refs.original_document_id` (when it references an existing invoice). Threaded onto
   *  `document.original_invoice_number` so the credit-note template can render a reference line
   *  ("Credit note for invoice <n>"). Omitted / undefined for every other document type. */
  original_invoice_number?: string | null
  /** Credit notes only — the original invoice's issue date (YYYY-MM-DD), rendered with its number. */
  original_invoice_date?: string | null
  /** Credit notes only — the free-text reason supplied at credit_note_create_and_issue, rendered
   *  under the reference line when present. */
  reason?: string | null
}) {
  const { type, document, issuer, counterparty, lines, requires_hs_code, legal_mention } = params
  const stored = document as unknown as Record<string, unknown>
  const flat = (document.einvoice ?? stored) as Record<string, unknown>
  const snapshot = {
    operation_category:
      ((flat.operation_category ?? stored.operation_category) as
        | OperationCategory
        | null
        | undefined) ?? null,
    vat_on_debits: (flat.vat_on_debits ?? stored.vat_on_debits) as boolean | null | undefined,
    buyer_siren: ((flat.buyer_siren ?? stored.buyer_siren) as string | null | undefined) ?? null,
  }
  return {
    document: {
      type,
      scope: document.scope ?? null,
      number: document.number ?? "",
      issued_at: document.issued_at ?? "",
      due_at: document.due_at,
      currency: document.currency,
      subtotal_minor: document.subtotal_minor.toString(),
      tax_total_minor: document.tax_total_minor.toString(),
      grand_total_minor: document.grand_total_minor.toString(),
      tax_treatment: document.tax_treatment ?? "",
      incoterm: document.incoterm,
      // Settlement state drives "Amount paid" vs "Total due" and whether the banking box shows.
      // On a re-render (ensureDocumentPdf) `document` is the full persisted row, so a Shopify
      // invoice that settled after issue renders paid; at issue time it is set only when the
      // caller issued the document already-paid.
      payment_status: document.payment_status ?? null,
      paid_at: document.paid_at ?? null,
      original_invoice_number: params.original_invoice_number ?? null,
      original_invoice_date: params.original_invoice_date ?? null,
      reason: params.reason ?? null,
      // The stored e-invoicing snapshot: at issue time it rides on `document.einvoice`, on a
      // re-render it is the persisted columns. Never recomputed from current data.
      operation_label: operationLabel(snapshot.operation_category, issuer.default_language),
      vat_on_debits: snapshot.vat_on_debits === true,
      // The human Shopify order reference, rendered as an "Order" line in the
      // header meta so the order can be read straight off the invoice PDF. The
      // top-level column is the issue-time mirror; a RE-render of a document
      // issued (or imported) before that column existed still finds it on
      // external_refs, so old invoices pick it up on their next render.
      shopify_order_number:
        document.shopify_order_number ?? readOrderNumber(document.external_refs),
      // The customer's PO number, rendered as a "PO number" line in the header meta,
      // same fallback rule as shopify_order_number above: a RE-render of a document
      // issued (or imported) before the column existed still finds it on
      // external_refs, so old invoices pick it up on their next render.
      po_number: document.po_number ?? readRefString(document.external_refs, "po_number"),
      // The caller's own reference for the customer (a CRM record id), printed as "Customer
      // ref". Lives only on external_refs, at issue and on every re-render alike.
      customer_reference: readRefString(document.external_refs, "customer_reference"),
      // Free-text notes, rendered as a "Notes" block under the totals on every
      // document type. Plain column: no external_refs fallback to consult.
      notes: document.notes ?? null,
    },
    issuer: {
      legal_name: issuer.legal_name,
      country: issuer.country,
      vat_id: issuer.vat_id,
      address: issuer.address,
      iban: issuer.iban,
      swift_bic: issuer.swift_bic,
      bank_name: issuer.bank_name,
      default_language: issuer.default_language,
      logo_file_id: issuer.logo_file_id ?? null,
      siren: issuer.siren ?? null,
      legal_form: issuer.legal_form ?? null,
      share_capital: issuer.share_capital ?? null,
      rcs_city: issuer.rcs_city ?? null,
    },
    counterparty: {
      legal_name: counterparty.legal_name,
      country: counterparty.country,
      vat_id: counterparty.vat_id,
      address: counterparty.address,
      // Render only. The template prints a SHIP TO block when this differs from `address`;
      // nothing downstream of here feeds it into the tax classification.
      shipping_address: counterparty.shipping_address ?? null,
      shipping_name: counterparty.shipping_name ?? null,
      email: counterparty.email ?? null,
      siren: snapshot.buyer_siren ?? null,
    },
    line_items: lines.map((l) => ({
      position: l.position,
      description: l.description,
      quantity: l.quantity,
      unit_price_minor: l.unit_price_minor.toString(),
      discount_minor: (l.discount_minor ?? 0n).toString(),
      line_kind: l.line_kind ?? "goods",
      tax_rate_bp: l.tax_rate_bp,
      subtotal_minor: l.subtotal_minor.toString(),
      tax_minor: l.tax_minor.toString(),
      total_minor: l.total_minor.toString(),
      hs_code: l.hs_code,
      country_of_origin: l.country_of_origin,
      customs_description: l.customs_description,
    })),
    legal_mention,
    requires_hs_code,
  }
}
