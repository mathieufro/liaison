// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E5 — Agent read tools.
//
// Pure read-only surfaces (`gated: false`) exposed to the agent + UI:
//
//   - documents_search({ query?, type?, status?, contact?, date_range?, treatment? })
//     → list of document headers (id, number, type, status, total, …)
//   - documents_get({ id }) → full document with lines
//   - hs_codes_lookup({ query }) → fuzzy hits from org library
//   - pending_approvals_list({})  → caller's pending approvals scoped to
//     `tool_name LIKE 'invoicing:%'` (per spec §"Pending Approval data
//     source pinned").
//
// All db access goes through the kernel's generic CRUD surface
// (`ctx.db.findMany` / `ctx.db.findOne`). The bridge serialises rows
// to JSON, so bigint columns (e.g. `grand_total_minor`) round-trip as
// strings — we coerce at the edges.

import { addressMatch, addressParts, normaliseAddress } from "./address-match"
import type { CrossAppExecuteTool } from "./cross-app"
import { csvCell } from "./csv"
import { needsHumanReview } from "./deferred"
import { type LinkedShipment, linkedShipments } from "./handlers/link-shipments"
import { civilDateOf, issuerTimezoneUnset, type TimeSurface } from "./issue-date"
import { deliveryFileId } from "./legal-originals/delivery"
import { toBigInt } from "./mutations/shared"

export interface DocumentHeader {
  id: string
  type: string
  /** Split-order scope (goods / software) — null for whole-order documents. */
  scope: string | null
  number: string | null
  status: string
  payment_status: string
  counterparty_contact_id: string | null
  counterparty_name: string | null
  counterparty_address: string | null
  /** Ship to snapshot, surfaced so documents_get and the UI can show / correct it. Render only:
   *  the tax treatment is derived from counterparty_country, never from this address. */
  counterparty_shipping_address: string | null
  counterparty_shipping_name: string | null
  counterparty_vat_id: string | null
  counterparty_email: string | null
  counterparty_country: string | null
  currency: string
  grand_total_minor: bigint
  issued_at: string | null
  due_at: string | null
  /** Sales channel for the documents-list "Channel" column + Shopify/Manual
   *  filter: "shopify" when the document was reconciled from a Shopify order
   *  (top-level shopify_order_id set), else "manual". */
  channel: "shopify" | "manual"
  /** The linked Shopify order gid, when this document was generated from a
   *  Shopify order — the "shippable order" marker cross-app consumers (Boxtal
   *  prep) key on. Null for manual documents. */
  shopify_order_id: string | null
  /** The HUMAN store order reference ("#1149") this document bills, when it came
   *  from a Shopify order. Distinct from `shopify_order_id` (the numeric/gid
   *  handle the API uses): this is what a customer quotes and what an operator
   *  searches for. Null for manual documents. */
  shopify_order_number: string | null
  /** Physical shipment batch reference for per-shipment proformas (one proforma
   *  per batch of the same Shopify order). Null for whole-order documents. Lets
   *  boxtal and operators find a batch's proforma. */
  shipment_ref: string | null
  /** The Shopify draft order this quote IS, when the issuer profile is mapped to a
   *  shop. A quote and its draft order are the same object seen from two sides:
   *  converting the quote completes the draft order in Shopify. Null otherwise. */
  shopify_draft_order_id: string | null
  /** The human draft order reference ("#D12") the store shows. Null otherwise. */
  shopify_draft_order_name: string | null
  /** The customer's purchase order number, when they gave one. Top-level column,
   *  falling back to `external_refs.po_number` for rows written before the column
   *  existed (the CSV importer has always recorded it there). Null when absent. */
  po_number: string | null
  /** The issuer's own reference for this customer in another system (e.g. a CRM record id),
   *  printed as "Customer ref" (`external_refs.customer_reference`). Null when absent. */
  customer_reference: string | null
  /** Free-text notes carried on the document face (contract reference, extra customs
   *  information, a special mention). Plain top-level column, no external_refs fallback:
   *  nothing ever wrote notes anywhere else. Null when the document carries none. */
  notes: string | null
  /** The id of the invoice this credit note credits
   *  (`external_refs.original_document_id`). Null for anything that is not a
   *  credit note, or a credit note issued before the link existed. */
  original_document_id: string | null
  /** The visible number of the invoice this credit note credits
   *  (`external_refs.original_document_number`). Null in the same cases as
   *  `original_document_id`. */
  original_document_number: string | null
  /** Visible numbers of every ISSUED credit note against this document, read straight off its own
   *  `lifecycle_log` `credit_note_issued` markers (no extra query — the row is already fetched).
   *  Empty for a credit note itself, or an invoice with none recorded. Powers the documents-list
   *  "Credited by ..." indicator even when the credit note row is not in the current view (unlike
   *  the co-resident pairing label, which needs both rows on screen). */
  credited_by_numbers: string[]
}

export interface DocumentLine {
  id: string
  position: number
  description: string
  quantity: string
  unit_price_minor: bigint
  /** Per-line discount in minor units (tax-exclusive); 0 when none. */
  discount_minor: bigint
  /** goods (default) / software / shipping — the split-invoice classifier. */
  line_kind: string
  /** The line's EXPLICIT per-line VAT override in basis points, or null when the line has never
   *  had one set — issuing (and any read-modify-write) falls back to the issuer's classified rate
   *  for a null line. Collapsing null into 0 here would make an unset line indistinguishable from
   *  a deliberate 0 percent exemption, which is how a round-tripped save used to drop VAT
   *  entirely (see mutations.ts loadDraftLines / insertDraftLines, which already preserve this
   *  distinction on the drafts_update path — this is the same distinction on the documents_get
   *  read path). */
  tax_rate_bp: number | null
  subtotal_minor: bigint
  tax_minor: bigint
  total_minor: bigint
  hs_code: string | null
  country_of_origin: string | null
  customs_description: string | null
  product_source: string | null
  external_id: string | null
}

export interface DocumentFull extends DocumentHeader {
  subtotal_minor: bigint
  tax_total_minor: bigint
  tax_treatment: string | null
  incoterm: string
  issuer_profile_id: string
  pdf_file_id: string | null
  pdf_status: string | null
  external_refs: Record<string, unknown>
  lifecycle_log: Array<Record<string, unknown>>
  lines: DocumentLine[]
  /** E-invoicing: the draft's customer type, operation type and structured billing (the Editor
   *  saves them back with drafts_update), and the regime recorded at issue. */
  customer_kind: string | null
  operation_category: string | null
  billing_line1: string | null
  billing_line2: string | null
  billing_postcode: string | null
  billing_city: string | null
  billing_country_code: string | null
  regime: string | null
  regime_reasons: unknown[]
  /** The Boxtal shipment(s) created against this document, written back by the link-shipments
   *  job (empty until a parcel exists). Invoice to parcel in one hop. */
  shipments: LinkedShipment[]
}

export interface HsCodeEntry {
  code: string
  description: string | null
  last_used_at: Date | string | null
}

export interface PendingApproval {
  id: string
  tool_name: string
  summary: string
  created_at: Date | string
  requested_by_user_id: string
}

export interface DocumentsSearchInput {
  query?: string
  /** Only these documents (their ids, at most 100): resolves a set of document references,
   *  e.g. the invoices a list of shipments points at, to their numbers in one read. */
  ids?: string[]
  type?: "invoice" | "quote" | "proforma" | "purchase_order" | "credit_note"
  status?: string
  /** Filter by counterparty. Both `contact_id` (the UI/ContactDocumentsPanel
   *  form field) and the legacy `contact` alias are accepted. */
  contact_id?: string
  contact?: string
  /** Only documents made out to the people of this company (kernel:companies_read). */
  company_id?: string
  date_range?: { from?: string | null; to?: string | null }
  treatment?: string
  /** "newest" (default) or "oldest" first, by issue date. */
  sort?: "newest" | "oldest"
  limit?: number
  offset?: number
  /** Exhaustive-sweep countdown: return ONLY `{ totalCount }` — a server count
   *  of ALL documents matching the STRUCTURED filter (type/status/contact), not
   *  the page — so a routine sweeping e.g. "chase every overdue invoice" reads a
   *  measured remaining count that drops as each invoice's status flips. NOTE:
   *  the count reflects the server-side filter only; the client-side `date_range`
   *  narrowing (and free-text `query`) is NOT applied to the count, so a
   *  date-bounded sweep should disclose the count is for the status/type filter.
   *  The default (countOnly absent) return shape — a bare DocumentHeader[] — is
   *  unchanged, so the ContactDocumentsPanel UI is unaffected. */
  countOnly?: boolean
  /** Bulk-hydrate each returned document with its `lines` (same shape as
   *  documents_get) plus `incoterm` and `requires_hs_code`. For cross-app
   *  consumers (Boxtal's prep worklist) that would otherwise issue one
   *  documents_get sandbox execution PER document — a 26-row worklist cost 26
   *  worker executions and blew the interactive tool budget. The extra data is
   *  fetched with in-execution db reads, so the whole page costs ONE sandbox
   *  execution. Default absent: the bare DocumentHeader[] shape is unchanged. */
  include_lines?: boolean
}

/**
 * Generic CRUD surface (subset of `@liaison/app-sdk` `DbClient`) the
 * read tools need. We also accept the optional `search` extension the
 * sandbox bridge supports (ILIKE over `fields`) — declared here as a
 * local widening since the SDK type omits it.
 */
export interface ReadsDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      orderBy?: Record<string, "asc" | "desc">
      limit?: number
      offset?: number
      search?: { fields: string[]; query: string }
    },
  ): Promise<unknown[]>
  findOne(entity: string, id: string): Promise<unknown | null>
  count(entity: string, opts?: { where?: Record<string, unknown> }): Promise<number>
}

/**
 * Pending-approvals affordance — exposed by the kernel bridge as
 * `ctx.kernel.listApprovals(toolNamePrefix?, limit?)`. Returns a JSON
 * array (already parsed by the sandbox shim) of ApprovalRequestSummary
 * shapes we map to PendingApproval.
 */
export interface ReadsKernel {
  listApprovals(toolNamePrefix?: string, limit?: number): Promise<unknown[]>
}

/** The HTTP envelope a sandbox `ctx.fetch` resolves to. */
export interface ReadsFetchEnvelope {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * Sandbox egress shim — the subset of `@liaison/app-sdk` `AppContext.fetch`
 * the VIES read needs. The kernel gates outbound URLs against the manifest's
 * `network.allowedDomains` (here: `ec.europa.eu`); no `Response` crosses the
 * QuickJS bridge, so the body is a JSON *string* we parse ourselves.
 *
 * RETURN TYPE IS A UNION ON PURPOSE — the QuickJS bridge marshaller (`executor`
 * `__wrap`) only JSON-parses a host method's string return when a NON-PRIMITIVE
 * arg was passed; a url-only call leaks the raw `{"status",…}` JSON *string*.
 * `vatValidate` passes an opts object (so it normally gets the parsed envelope)
 * AND defensively parses a string, so the type must admit both shapes.
 */
export type ReadsFetch = (
  url: string,
  opts?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
) => Promise<ReadsFetchEnvelope | string>

export interface ReadsCtx {
  db: ReadsDb
  kernel: ReadsKernel
  /** Optional in the type so the DB-only reads (which never egress) can be
   *  exercised with a `{ db, kernel }` ctx; `vatValidate` requires it on the
   *  live path and degrades to a "could not confirm" result when it is absent. */
  fetch?: ReadsFetch
  /** Cross-app dispatch: the kernel contact reads that widen a `contact_id` search to the
   *  contact's email and addresses. Optional so DB-only reads run with `{ db, kernel }`. */
  executeTool?: CrossAppExecuteTool
}

/** Hard upper bound applied to every read tool's `limit` arg. */
export const READS_MAX_LIMIT = 100
/** Page size and ceiling of the date-range walk in documentsSearch. */
const RANGE_SCAN_PAGE = 100
const MAX_RANGE_SCAN = 5000
const DEFAULT_LIMIT = 50

function clampLimit(requested?: number): number {
  if (!Number.isFinite(requested)) return DEFAULT_LIMIT
  const n = Math.floor(Number(requested))
  if (n < 1) return DEFAULT_LIMIT
  return Math.min(n, READS_MAX_LIMIT)
}

/** The human Shopify order reference for a persisted row: the top-level column
 *  when set, else the `external_refs.shopify_order_number` the writers have
 *  always recorded. Blank strings read as absent. */
function readOrderNumberFromRow(r: Record<string, unknown>): string | null {
  const refs = (r.external_refs as Record<string, unknown> | undefined) ?? {}
  for (const candidate of [r.shopify_order_number, refs.shopify_order_number]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim()
  }
  return null
}

/** The visible numbers of the row's own ISSUED `credit_note_issued` lifecycle_log markers,
 *  deduplicated by credit note id. The row's `lifecycle_log` is already part of the fetched
 *  document row (generic-CRUD `findMany` selects the whole row), so this reads data already in
 *  hand rather than issuing a query per document. */
function creditedByNumbersFromRow(r: Record<string, unknown>): string[] {
  const log = (r.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? []
  const numbers: string[] = []
  const seen = new Set<string>()
  for (const entry of log) {
    if (String(entry.event ?? "") !== "credit_note_issued") continue
    const id = typeof entry.credit_note_id === "string" ? entry.credit_note_id : ""
    const num = typeof entry.number === "string" ? entry.number.trim() : ""
    const key = id || num
    if (!key || seen.has(key)) continue
    seen.add(key)
    if (num) numbers.push(num)
  }
  return numbers
}

/** A top-level mirror column, falling back to the `external_refs` key of the same
 *  name for rows written before the column existed. Blank reads as absent. */
function readRefColumn(r: Record<string, unknown>, key: string): string | null {
  const refs = (r.external_refs as Record<string, unknown> | undefined) ?? {}
  for (const candidate of [r[key], refs[key]]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim()
  }
  return null
}

function toDocumentHeader(row: unknown): DocumentHeader {
  const r = row as Record<string, unknown>
  // Bigint columns come back from the bridge as strings (Postgres BIGINT
  // round-trips as a numeric string). We return them as strings to keep the
  // tool result JSON-safe — BigInt values would crash the kernel's JSON
  // serialiser when the handler envelope is sent across the worker IPC.
  return {
    id: String(r.id),
    type: String(r.type),
    scope: (r.scope as string | null) ?? null,
    number: (r.number as string | null) ?? null,
    status: String(r.status ?? "draft"),
    payment_status: String(r.payment_status ?? "unpaid"),
    counterparty_contact_id: (r.counterparty_contact_id as string | null) ?? null,
    counterparty_name: (r.counterparty_name as string | null) ?? null,
    counterparty_address: (r.counterparty_address as string | null) ?? null,
    counterparty_shipping_address: (r.counterparty_shipping_address as string | null) ?? null,
    counterparty_shipping_name: (r.counterparty_shipping_name as string | null) ?? null,
    counterparty_vat_id: (r.counterparty_vat_id as string | null) ?? null,
    counterparty_email: (r.counterparty_email as string | null) ?? null,
    counterparty_country: (r.counterparty_country as string | null) ?? null,
    currency: String(r.currency ?? "EUR"),
    grand_total_minor: String(r.grand_total_minor ?? "0") as unknown as bigint,
    issued_at: (r.issued_at as string | null) ?? null,
    due_at: (r.due_at as string | null) ?? null,
    // A Shopify-reconciled document carries a top-level shopify_order_id; surface
    // it as the sales channel so the documents list + Shopify/Manual filter bucket
    // it correctly (was always "manual" because this field was never derived).
    channel:
      typeof r.shopify_order_id === "string" && r.shopify_order_id.length > 0
        ? "shopify"
        : "manual",
    shopify_order_id:
      typeof r.shopify_order_id === "string" && r.shopify_order_id.length > 0
        ? r.shopify_order_id
        : null,
    // The column is the issue-time mirror; documents issued (or CSV-imported)
    // before it existed carry the reference only on external_refs, so read
    // through to it rather than showing them as order-less. (Free-text SEARCH
    // still needs the column — hence the one-off backfill in
    // scripts/backfill-order-numbers.sql.)
    shopify_order_number: readOrderNumberFromRow(r),
    shipment_ref:
      typeof r.shipment_ref === "string" && r.shipment_ref.length > 0 ? r.shipment_ref : null,
    shopify_draft_order_id: readRefColumn(r, "shopify_draft_order_id"),
    shopify_draft_order_name: readRefColumn(r, "shopify_draft_order_name"),
    po_number: readRefColumn(r, "po_number"),
    customer_reference: readRefColumn(r, "customer_reference"),
    notes: typeof r.notes === "string" && r.notes.length > 0 ? r.notes : null,
    original_document_id: readRefColumn(r, "original_document_id"),
    original_document_number: readRefColumn(r, "original_document_number"),
    credited_by_numbers: creditedByNumbersFromRow(r),
  }
}

function toDocumentLine(row: unknown): DocumentLine {
  const r = row as Record<string, unknown>
  // Bigints stay as strings — see toDocumentHeader comment.
  return {
    id: String(r.id),
    position: Number(r.position ?? 0),
    description: String(r.description ?? ""),
    quantity: String(r.quantity ?? "0"),
    unit_price_minor: String(r.unit_price_minor ?? "0") as unknown as bigint,
    discount_minor: String(r.discount_minor ?? "0") as unknown as bigint,
    line_kind: String(r.line_kind ?? "goods"),
    // NULL means "no per-line override" and must stay NULL through this read — collapsing it
    // into 0 makes an unset line indistinguishable from an explicit 0 percent exemption once the
    // caller (the Editor) echoes it back on save.
    tax_rate_bp: r.tax_rate_bp == null ? null : Number(r.tax_rate_bp),
    subtotal_minor: String(r.subtotal_minor ?? "0") as unknown as bigint,
    tax_minor: String(r.tax_minor ?? "0") as unknown as bigint,
    total_minor: String(r.total_minor ?? "0") as unknown as bigint,
    hs_code: (r.hs_code as string | null) ?? null,
    country_of_origin: (r.country_of_origin as string | null) ?? null,
    // Customs join key for the cross-app shipping hand-off (Phase 18 / Boxtal):
    // these columns already exist on document_line; surface them so a downstream
    // shipping app can join each line to its catalog shipping profile by
    // (product_source, external_id) with zero re-entry of customs metadata.
    customs_description: (r.customs_description as string | null) ?? null,
    product_source: (r.product_source as string | null) ?? null,
    external_id: (r.external_id as string | null) ?? null,
  }
}

/** The document columns the free-text `query` reaches (documentsSearch). */
const DOCUMENT_SEARCH_FIELDS = [
  "number",
  "counterparty_name",
  "buyer_legal_name",
  "counterparty_address",
  "counterparty_email",
  "counterparty_shipping_name",
  "counterparty_shipping_address",
  "shopify_order_id",
  "shopify_order_number",
  "po_number",
  // Free text an operator typed onto the document (a contract reference, a special mention).
  "notes",
]
/** Bound of the line-description and external-reference lookups of one search. */
const LINE_SEARCH_LIMIT = 200
const EXTERNAL_REF_SCAN = 500

/** A query's words: lower-cased, accent and punctuation free ("Martin-Pas" gives martin, pas). */
export function searchWords(text: string | null | undefined): string[] {
  return normaliseAddress(text).split(" ").filter(Boolean)
}

/** Every term is in the text: as a whole word when `whole`, else anywhere inside it. */
function everyTerm(text: string, tokens: string[], whole = false): boolean {
  if (tokens.length === 0) return false
  if (whole) {
    const words = new Set(text.split(" "))
    return tokens.every((t) => words.has(t))
  }
  return tokens.every((t) => text.includes(t))
}

function rowText(r: Record<string, unknown>, keys: string[]): string {
  return normaliseAddress(
    keys.map((k) => (typeof r[k] === "string" ? (r[k] as string) : "")).join(" "),
  )
}

/** The normalised words of every searchable header field, the external order reference included. */
function headerText(r: Record<string, unknown>): string {
  return `${rowText(r, DOCUMENT_SEARCH_FIELDS)} ${normaliseAddress(readOrderNumberFromRow(r))}`.trim()
}

/**
 * How well a document matches a free-text query, best first: 0 its number, order or PO reference
 * IS the query; 1 every term is a whole word of a name on it; 2 every term is a whole word of
 * another field (the address, the email); 3 every term is a whole word of a line description;
 * 4 every term is inside some word; 5 only some terms match (the bridge's any-term fallback).
 * So "Martin Pas" puts the invoice addressed to "Giuseppe Martin Pas" above "Pascal Havé".
 */
function matchRank(r: Record<string, unknown>, q: string, tokens: string[], lines: string): number {
  const ref = q.replace(/^#/, "").trim().toLowerCase()
  const refs = [r.number, readOrderNumberFromRow(r), r.shopify_order_id, r.po_number].map((v) =>
    typeof v === "string" ? v.replace(/^#/, "").trim().toLowerCase() : "",
  )
  if (ref !== "" && refs.includes(ref)) return 0
  if (
    everyTerm(
      rowText(r, ["counterparty_name", "buyer_legal_name", "counterparty_shipping_name"]),
      tokens,
      true,
    )
  )
    return 1
  const header = headerText(r)
  if (everyTerm(header, tokens, true)) return 2
  if (lines && everyTerm(lines, tokens, true)) return 3
  if (everyTerm(`${header} ${lines}`, tokens)) return 4
  return 5
}

/**
 * Documents with a line whose description holds every term of the query ("mono mk2"), within the
 * same structured filter. `lineText` collects each hit document's matching descriptions for the
 * ranking.
 */
async function lineMatchedRows(
  ctx: ReadsCtx,
  q: string,
  tokens: string[],
  where: Record<string, unknown>,
  lineText: Map<string, string>,
): Promise<unknown[]> {
  const lines = (await ctx.db.findMany("document_lines", {
    search: { fields: ["description"], query: q },
    limit: LINE_SEARCH_LIMIT,
  })) as Array<Record<string, unknown>>
  for (const l of lines) {
    const text = normaliseAddress(typeof l.description === "string" ? l.description : "")
    // The bridge falls back to ANY term when no line has them all: keep only lines with every term.
    if (!everyTerm(text, tokens)) continue
    const id = String(l.document_id ?? "")
    if (!UUID_RE.test(id)) continue
    lineText.set(id, `${lineText.get(id) ?? ""} ${text}`.trim())
  }
  const ids = [...lineText.keys()].slice(0, READS_MAX_LIMIT)
  if (ids.length === 0) return []
  return ctx.db.findMany("documents", { where: { ...where, id: { in: ids } }, limit: ids.length })
}

/**
 * The documents whose order reference is recorded only in `external_refs` (imported before the
 * `shopify_order_number` column was filled), for an order-reference query that found nothing
 * else. A bounded walk over the newest documents of the same filter.
 */
async function externalRefOrderRows(
  ctx: ReadsCtx,
  q: string,
  where: Record<string, unknown>,
): Promise<unknown[]> {
  const ref = q.replace(/^#/, "").trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(ref) || !/\d/.test(ref)) return []
  const out: unknown[] = []
  for (let scanned = 0; scanned < EXTERNAL_REF_SCAN; scanned += RANGE_SCAN_PAGE) {
    const page = (await ctx.db.findMany("documents", {
      where,
      orderBy: { issued_at: "desc", number_int: "desc" },
      limit: RANGE_SCAN_PAGE,
      offset: scanned,
    })) as Array<Record<string, unknown>>
    for (const r of page) {
      const refs = (r.external_refs as Record<string, unknown> | undefined) ?? {}
      const values = [refs.shopify_order_number, refs.shopify_order_name, refs.order_number]
      if (
        values.some(
          (v) =>
            (typeof v === "string" || typeof v === "number") &&
            String(v).replace(/^#/, "").trim().toLowerCase() === ref,
        )
      ) {
        out.push(r)
      }
    }
    if (page.length < RANGE_SCAN_PAGE) break
  }
  return out
}

/** One line of a kernel contact address, the way a document prints it. */
function contactAddressLine(a: Record<string, unknown>): string {
  const s = (k: string) =>
    typeof a[k] === "string" && (a[k] as string).trim() !== "" ? (a[k] as string).trim() : null
  const city = [s("postalCode"), s("city")].filter(Boolean).join(" ")
  return [s("street1"), s("street2"), city, s("countryIso2")].filter(Boolean).join(", ")
}

/**
 * The documents of a contact that are NOT linked to it by id: made out to its email, or to one
 * of its addresses (same house number and street, compared by `addressMatch`). Needs the kernel
 * contact reads; without them (or for a malformed id) it finds nothing extra.
 */
/** The ids of a company's people the caller can see; none when it is not visible. */
async function companyPeople(ctx: ReadsCtx, companyId: string): Promise<string[]> {
  const exec = ctx.executeTool
  if (!exec || !UUID_RE.test(companyId)) return []
  try {
    const env = await exec("kernel:companies_read", { companyId })
    if (env.status !== "completed") return []
    const people = (env.result as { people?: unknown } | null)?.people
    return (Array.isArray(people) ? people : [])
      .map((p) => (p as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === "string" && UUID_RE.test(id))
  } catch {
    return []
  }
}

async function contactMatchedRows(
  ctx: ReadsCtx,
  contactId: string,
  where: Record<string, unknown>,
): Promise<unknown[]> {
  const exec = ctx.executeTool
  if (!exec || !UUID_RE.test(contactId)) return []
  const { counterparty_contact_id: _linked, ...base } = where
  let email: string | null = null
  const addresses: string[] = []
  try {
    const env = await exec("kernel:contacts_read", { contactId })
    if (env.status === "completed") {
      const e = (env.result as { contact?: { email?: unknown } } | null)?.contact?.email
      if (typeof e === "string" && e.includes("@")) email = e.trim()
    }
  } catch {
    // An unreadable contact adds nothing: the linked documents still come back.
  }
  try {
    const env = await exec("kernel:contacts_addresses_list", { contactId })
    if (env.status === "completed") {
      const list = (env.result as { addresses?: unknown } | null)?.addresses
      for (const a of Array.isArray(list) ? list : []) {
        const line = contactAddressLine((a ?? {}) as Record<string, unknown>)
        if (line) addresses.push(line)
      }
    }
  } catch {
    // Same: no address book, no address matches.
  }
  const out: unknown[] = []
  if (email) {
    for (const e of new Set([email, email.toLowerCase()])) {
      out.push(
        ...(await ctx.db.findMany("documents", {
          where: { ...base, counterparty_email: e },
          limit: READS_MAX_LIMIT,
        })),
      )
    }
  }
  for (const line of addresses.slice(0, 3)) {
    const postcode = addressParts(line)?.postcode
    if (!postcode) continue
    const hits = (await ctx.db.findMany("documents", {
      where: base,
      search: {
        fields: ["counterparty_address", "counterparty_shipping_address"],
        query: postcode,
      },
      limit: READS_MAX_LIMIT,
    })) as Array<Record<string, unknown>>
    for (const r of hits) {
      const billing = typeof r.counterparty_address === "string" ? r.counterparty_address : null
      const shipping =
        typeof r.counterparty_shipping_address === "string" ? r.counterparty_shipping_address : null
      if (addressMatch(line, billing) !== null || addressMatch(line, shipping) !== null) out.push(r)
    }
  }
  return out
}

/** The one-line next step a free-text search that found nothing hands back. */
export function documentsSearchNoHitHint(query: string): string {
  return `No document matches "${query}". If "${query}" names a customer, their earlier sales and prices are in invoicing__customer_history with customer="${query}" (it also reads their Shopify orders), or shopify__orders_search with the customer's name.`
}

/** A query shaped like a document number ("F-2026-0006", "INV2026-14"): a prefix, then digits. */
const NUMBER_LIKE = /^[A-Za-z]{1,8}[-/_.]?\d[\d/_.-]*$/

/**
 * What a search for a number that no document carries answers: that the number does not exist,
 * and the numbers that end with the same digits, which may be the one the person means. None of
 * them is opened or picked here.
 */
async function noSuchNumberHint(ctx: ReadsCtx, query: string): Promise<string | null> {
  if (!NUMBER_LIKE.test(query)) return null
  const digits = query.match(/(\d+)\D*$/)?.[1]
  if (!digits) return null
  const rows = (await ctx.db.findMany("documents", {
    where: {},
    search: { fields: ["number"], query: digits },
    orderBy: { issued_at: "desc", number_int: "desc" },
    limit: READS_MAX_LIMIT,
  })) as Array<{ number?: unknown }>
  const close = [
    ...new Set(
      rows
        .map((r) => (typeof r.number === "string" ? r.number : ""))
        .filter((n) => n && n.toLowerCase() !== query.toLowerCase() && n.endsWith(digits)),
    ),
  ].slice(0, 5)
  const none = `No document is numbered "${query}".`
  return close.length > 0
    ? `${none} Numbers ending in ${digits}: ${close.join(", ")}. None of them is "${query}": ask the person which one they mean.`
    : `${none} No document number ends in ${digits} either.`
}

/**
 * The documents_search tool: documentsSearch, except that a free-text query that finds nothing
 * answers `{ results: [], hint }` so the agent is told where to look next instead of concluding
 * the customer has no history. Every other answer keeps its shape.
 */
export async function documentsSearchTool(
  ctx: ReadsCtx,
  input: DocumentsSearchInput = {},
): Promise<
  DocumentHeader[] | { totalCount: number } | { results: DocumentHeader[]; hint: string }
> {
  const result = input.countOnly
    ? await documentsSearch(ctx, { ...input, countOnly: true })
    : await documentsSearch(ctx, input)
  const q = input.query?.trim()
  if (q && Array.isArray(result) && result.length === 0) {
    return { results: [], hint: (await noSuchNumberHint(ctx, q)) ?? documentsSearchNoHitHint(q) }
  }
  return result
}

// Overloads keep existing callers (no `countOnly`) typed as a bare
// DocumentHeader[] — so the ContactDocumentsPanel UI and the existing tests are
// untouched — while a `countOnly: true` call returns just the count.
//
// Matching: every whitespace-separated term of the free-text `query` must appear,
// case-insensitively, in one of DOCUMENT_SEARCH_FIELDS (the bridge's tokenized search, which
// falls back to any term when no row has them all), or in a line description; every hit is
// then ranked by matchRank, so exact references and whole-word name matches come first. Other
// apps (boxtal's shipment and proforma flows) pick the exact number among the hits.
export async function documentsSearch(
  ctx: ReadsCtx,
  input: DocumentsSearchInput & { countOnly: true },
): Promise<{ totalCount: number }>
export async function documentsSearch(
  ctx: ReadsCtx,
  input?: DocumentsSearchInput,
): Promise<DocumentHeader[]>
export async function documentsSearch(
  ctx: ReadsCtx,
  input: DocumentsSearchInput = {},
): Promise<DocumentHeader[] | { totalCount: number }> {
  const limit = clampLimit(input.limit)
  const offset = Math.max(0, Math.floor(input.offset ?? 0))

  const where: Record<string, unknown> = {}
  if (input.type) where.type = input.type
  if (input.status) where.status = input.status
  if (input.treatment) where.tax_treatment = input.treatment
  const contactFilter = input.contact_id?.trim() || input.contact?.trim()
  if (contactFilter) where.counterparty_contact_id = contactFilter
  if (input.company_id?.trim() && !contactFilter) {
    const people = await companyPeople(ctx, input.company_id.trim())
    if (people.length === 0) return input.countOnly ? { totalCount: 0 } : []
    where.counterparty_contact_id = { in: people }
  }
  if (Array.isArray(input.ids)) {
    // Only well-formed ids reach the IN list: a malformed one would fail the whole read
    // ("invalid input syntax for type uuid") instead of matching nothing.
    const ids = [
      ...new Set(input.ids.filter((id) => typeof id === "string" && UUID_RE.test(id))),
    ].slice(0, READS_MAX_LIMIT)
    if (ids.length === 0) return input.countOnly ? { totalCount: 0 } : []
    where.id = { in: ids }
    // db_count refuses where.id: the count of a bounded id set is the rows it reads.
    if (input.countOnly) {
      return {
        totalCount: (await ctx.db.findMany("documents", { where, limit: ids.length })).length,
      }
    }
  }

  // Exhaustive-sweep countdown: a server COUNT over the SAME structured filter,
  // returned as `{ totalCount }` ONLY when asked — the default bare-array shape
  // (consumed by ContactDocumentsPanel) is left untouched.
  if (input.countOnly) {
    return { totalCount: await ctx.db.count("documents", { where }) }
  }

  const q = input.query?.trim()
  // Newest first by default; "oldest" lists the same set chronologically. `number_int` breaks
  // ties inside one issue day (issued_at is a DATE), so same-day documents keep their numbering
  // order instead of whatever order the database happens to return them in.
  const dir: "asc" | "desc" = input.sort === "oldest" ? "asc" : "desc"
  const from = input.date_range?.from || undefined
  const to = input.date_range?.to || undefined
  const fetchPage = (pageLimit: number, pageOffset: number) =>
    ctx.db.findMany("documents", {
      where,
      // Free-text `query` matches the document NUMBER, the counterparty's name, address and email
      // (billing and shipping), the Shopify order (numeric id and human name), the PO number and the
      // notes. BL-248: a weak model handed a customer reference searches it as free text rather
      // than resolving a contact id first. The ADDRESS matters as much as the name: an invoice is
      // often made out to a company while the person the user names ("Martin Pas") only appears
      // in its address ("Giuseppe Martin Pas, Via ..."), and a name-only search answered "no
      // previous invoice" for a customer who had one. l712: an order-reference query
      // ("#2357") finds the order's invoice through `shopify_order_number`. The bridge matches
      // each whitespace-separated term case-insensitively in any field; line descriptions and the
      // order number kept only in `external_refs` are matched below, and every hit is ranked.
      search: q ? { fields: DOCUMENT_SEARCH_FIELDS, query: q } : undefined,
      orderBy: { issued_at: dir, number_int: dir },
      limit: pageLimit,
      offset: pageOffset,
    })

  // `issued_at` is a DATE column but the driver hands it back as a full
  // timestamp string ("2026-07-24 00:00:00+00"), while the bounds are bare
  // "YYYY-MM-DD". A raw string compare then makes the `to` bound EXCLUDE every
  // document issued ON that day ("2026-07-24 00:00:00+00" > "2026-07-24"), so a
  // single-day range returned nothing. Compare on the date portion only.
  const issuedDay = (r: { issued_at: string | null }): string | null =>
    r.issued_at != null ? r.issued_at.slice(0, 10) : null
  const inRange = (d: string | null) => d != null && (!from || d >= from) && (!to || d <= to)
  const rowInRange = (r: unknown) => (!from && !to) || inRange(issuedDay(toDocumentHeader(r)))

  // A contact's documents are the ones linked to it by id AND the ones made out to its email or
  // to one of its addresses: an imported or Shopify-made invoice is often not linked to the
  // contact at all.
  const contactExtras = contactFilter ? await contactMatchedRows(ctx, contactFilter, where) : []
  // A free-text query or a widened contact set is merged, ranked and paged here; otherwise the
  // database pages the plain filter as before.
  const merged = !!q || contactExtras.length > 0
  const wanted = merged ? Math.min(offset + limit, 1000) : offset + limit
  const firstOffset = merged ? 0 : offset

  let rows: unknown[]
  if (!from && !to) {
    rows = await fetchPage(merged ? wanted : limit, firstOffset)
  } else {
    // The db bridge has equality filters only, so the date range is applied here. It used to
    // filter ONE over-fetched page of the newest rows, which made any period older than that
    // page come back empty. Walk the issued_at ordered set instead, keep the rows in range, and
    // stop once the walk is past the far bound (the order guarantees nothing after it matches).
    // `offset` and `limit` then apply to the in-range rows. Bounded by MAX_RANGE_SCAN rows.
    const matched: unknown[] = []
    let scanned = 0
    walk: while (scanned < MAX_RANGE_SCAN) {
      const pageRows = await fetchPage(RANGE_SCAN_PAGE, scanned)
      scanned += pageRows.length
      for (const r of pageRows) {
        const d = issuedDay(toDocumentHeader(r))
        if (inRange(d)) {
          matched.push(r)
          if (matched.length >= wanted) break walk
        } else if (
          d != null &&
          ((dir === "desc" && from && d < from) || (dir === "asc" && to && d > to))
        ) {
          break walk
        }
      }
      if (pageRows.length < RANGE_SCAN_PAGE) break
    }
    rows = matched.slice(firstOffset)
  }

  if (merged) {
    const tokens = q ? searchWords(q) : []
    const lineText = new Map<string, string>()
    const extra: unknown[] = contactExtras.filter(
      (r) =>
        rowInRange(r) &&
        (tokens.length === 0 || everyTerm(headerText(r as Record<string, unknown>), tokens)),
    )
    if (q && tokens.length > 0 && !Array.isArray(input.ids)) {
      const byLines = await lineMatchedRows(ctx, q, tokens, where, lineText)
      extra.push(...byLines.filter(rowInRange))
    }
    if (q && rows.length === 0 && extra.length === 0) {
      extra.push(...(await externalRefOrderRows(ctx, q, where)).filter(rowInRange))
    }
    const seen = new Set<string>()
    const all: Array<Record<string, unknown>> = []
    for (const r of [...rows, ...extra] as Array<Record<string, unknown>>) {
      const id = String(r.id)
      if (seen.has(id)) continue
      seen.add(id)
      all.push(r)
    }
    const sign = dir === "asc" ? 1 : -1
    const key = (r: Record<string, unknown>) => String(r.issued_at ?? "").slice(0, 10)
    all.sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      if (ka !== kb) return ka < kb ? -sign : sign
      return (Number(a.number_int ?? 0) - Number(b.number_int ?? 0)) * sign
    })
    if (q) {
      const rank = new Map(
        all.map((r) => [String(r.id), matchRank(r, q, tokens, lineText.get(String(r.id)) ?? "")]),
      )
      // Array.prototype.sort is stable: within one rank the date order above stays.
      all.sort((a, b) => (rank.get(String(a.id)) ?? 9) - (rank.get(String(b.id)) ?? 9))
    }
    rows = all.slice(offset, offset + limit)
  }
  const mapped = rows.map(toDocumentHeader)
  const page = mapped.slice(0, limit)
  if (!input.include_lines) return page

  // Hydrate the final page with lines + the customs-relevant header fields
  // (incoterm, requires_hs_code) that toDocumentHeader drops. Per-document db
  // reads here are cheap host round-trips inside this one sandbox execution.
  const rawById = new Map<string, Record<string, unknown>>()
  for (const r of rows as Array<Record<string, unknown>>) rawById.set(String(r.id), r)
  return Promise.all(
    page.map(async (h) => {
      const raw = rawById.get(h.id)
      const lineRows = await ctx.db.findMany("document_lines", {
        where: { document_id: h.id },
        orderBy: { position: "asc" },
        limit: 1000,
      })
      return {
        ...h,
        incoterm: String(raw?.incoterm ?? "DAP"),
        requires_hs_code: (raw?.requires_hs_code as boolean | null) ?? null,
        lines: lineRows.map(toDocumentLine),
      }
    }),
  )
}

// app_invoicing.documents.id is a UUID column. A weak model sometimes passes a FOREIGN id here — e.g.
// a Shopify DraftOrder GID (`gid://shopify/DraftOrder/123`) when confusing a draft quote with an
// invoicing document — which would 22P02 ("invalid input syntax for type uuid") at the pg layer and
// surface as a handler crash / EXECUTED-FAIL. A `:`/`/`/whitespace character can never appear in a
// uuid, so such an id can never reference a document — treat it as a clean not-found. (BL-129.)
const FOREIGN_ID_CHARS = /[:/\s]/

// RFC-4122-ish UUID shape (accepts any version/variant nibble — the DB column enforces the real
// constraint; this is just a routing test to decide id-lookup vs number-lookup).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True when `value` is shaped like a Postgres uuid. Used to route an incoming document
 *  identifier to an id lookup (uuid) vs a number lookup (everything else) — see
 *  `resolveDocumentRow` below. Exported so `mutations.ts` shares the exact same test. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/**
 * Resolve a document row by either its `id` (uuid) or its visible `number` (e.g.
 * "PO0034009", "INV-2026-0041"). A weak agent naturally passes the NUMBER it just
 * saw in a documents_search result or on a rendered PDF — the visible label — rather
 * than the internal uuid, which previously fell straight into a raw
 * `where: { id }` lookup and 22P02'd at the pg layer (invalid input syntax for type
 * uuid) surfacing as a bare 500 (BL-… prod incident, PO0034009). `number` is not
 * declared UNIQUE at the schema level, but numbering is gap-free per
 * (issuer_profile_id, type, year_of_issue) at issue time and `ctx.db` is already
 * org/RLS-scoped, so a number lookup is unambiguous in practice; we still guard by
 * taking the single row deterministically (`limit: 1`) rather than assuming
 * uniqueness at the DB layer.
 *
 * A `:`/`/`/whitespace-bearing id (e.g. a Shopify GID) can never be a uuid NOR a
 * document number — short-circuit straight to null (BL-129) without a wasted query.
 */
export async function resolveDocumentRow(
  db: ReadsDb,
  idOrNumber: string,
): Promise<Record<string, unknown> | null> {
  if (!idOrNumber || FOREIGN_ID_CHARS.test(idOrNumber)) return null
  const where = isUuid(idOrNumber) ? { id: idOrNumber } : { number: idOrNumber }
  const rows = await db.findMany("documents", { where, limit: 1 })
  return (rows[0] as Record<string, unknown> | undefined) ?? null
}

function textOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

export async function documentsGet(
  ctx: ReadsCtx,
  input: { id: string },
): Promise<DocumentFull | null> {
  if (!input.id) throw new Error("id is required")
  const doc = await resolveDocumentRow(ctx.db, input.id)
  if (!doc) return null
  const resolvedId = String(doc.id)
  const lineRows = await ctx.db.findMany("document_lines", {
    where: { document_id: resolvedId },
    orderBy: { position: "asc" },
    limit: 1000,
  })
  const header = toDocumentHeader(doc)
  return {
    ...header,
    subtotal_minor: String(doc.subtotal_minor ?? "0") as unknown as bigint,
    tax_total_minor: String(doc.tax_total_minor ?? "0") as unknown as bigint,
    tax_treatment: (doc.tax_treatment as string | null) ?? null,
    incoterm: String(doc.incoterm ?? "DAP"),
    issuer_profile_id: String(doc.issuer_profile_id ?? ""),
    pdf_file_id: (doc.pdf_file_id as string | null) ?? null,
    pdf_status: (doc.pdf_status as string | null) ?? null,
    external_refs: (doc.external_refs as Record<string, unknown> | undefined) ?? {},
    lifecycle_log: (doc.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? [],
    lines: lineRows.map(toDocumentLine),
    shipments: linkedShipments(doc.external_refs),
    customer_kind: textOrNull(doc.customer_kind),
    operation_category: textOrNull(doc.operation_category),
    billing_line1: textOrNull(doc.billing_line1),
    billing_line2: textOrNull(doc.billing_line2),
    billing_postcode: textOrNull(doc.billing_postcode),
    billing_city: textOrNull(doc.billing_city),
    billing_country_code: textOrNull(doc.billing_country_code),
    regime: textOrNull(doc.regime),
    regime_reasons: Array.isArray(doc.regime_reasons) ? (doc.regime_reasons as unknown[]) : [],
  }
}

export async function hsCodesLookup(
  ctx: ReadsCtx,
  input: { query: string; limit?: number },
): Promise<HsCodeEntry[]> {
  const q = input.query?.trim() ?? ""
  if (!q) return []
  const rows = await ctx.db.findMany("hs_code_library", {
    search: { fields: ["code", "description"], query: q },
    limit: clampLimit(input.limit),
  })
  return rows.map((row) => {
    const r = row as Record<string, unknown>
    return {
      code: String(r.code),
      description: (r.description as string | null) ?? null,
      last_used_at: (r.last_used_at as Date | string | null) ?? null,
    }
  })
}

/** The requester's user id from `requestedBy` (`{ id }`, or a bare id string). */
function requesterIdOf(requestedBy: unknown): string {
  if (typeof requestedBy === "string") return requestedBy
  if (requestedBy && typeof requestedBy === "object") {
    const id = (requestedBy as { id?: unknown }).id
    if (typeof id === "string") return id
  }
  return ""
}

export async function pendingApprovalsList(
  ctx: ReadsCtx,
  input: { limit?: number } = {},
): Promise<PendingApproval[]> {
  const rows = await ctx.kernel.listApprovals("invoicing:", clampLimit(input.limit))
  return rows.map((row) => {
    const r = row as Record<string, unknown>
    // ApprovalRequestSummary shape (camelCase from @liaison/shared):
    //   { id, toolName, summary: { title, lines }, createdAt, requestedBy: { id }, … }
    // `requestedBy` is an object: `String()` on it printed "[object Object]".
    const summary = r.summary as { title?: unknown; headline?: unknown } | undefined
    const title = typeof summary?.title === "string" ? summary.title : summary?.headline
    return {
      id: String(r.id),
      tool_name: String(r.toolName ?? ""),
      summary: typeof title === "string" ? title : "",
      created_at: (r.createdAt as Date | string) ?? new Date(0).toISOString(),
      requested_by_user_id: requesterIdOf(r.requestedBy),
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────
// VAT validation (EU VIES) — authoritative VAT-number lookup.
//
// Backs the `vat_validate` agent tool so the agent never has to scrape VIES via
// `web_fetch` (a tainted, non-authoritative source) or fabricate a result. The
// live path calls the EU VIES REST API through the sandbox egress shim
// (`ctx.fetch`, gated by the manifest's `network.allowedDomains`); a
// deterministic mock (mirrors the Pennylane probe's mock-first shape) serves
// tests under `VIES_LIVE=0` so a missing/unreachable network NEVER blocks a run.
// ─────────────────────────────────────────────────────────────────────────

export interface VatValidateInput {
  country_code: string
  vat_number: string
  /** A tighter deadline for the VIES call (the sandbox's fetch ceiling otherwise). The business-
   *  buyer guard passes a short one: an outage must read "not verified", never time the tool out. */
  timeout_ms?: number
}

export interface VatValidateResult {
  isValid: boolean
  countryCode: string
  vatNumber: string
  name: string | null
  address: string | null
  requestDate: string | null
  source: "vies_rest" | "vies_mock"
  /** Set on a degraded result (non-200, network/parse failure) so the agent can
   *  report an honest "could not confirm" instead of inventing a pass. */
  error?: string
}

/** The raw VIES REST response shape (`/rest-api/ms/{cc}/vat/{num}`). Every field
 *  past the validity flag may be absent; we coerce to `null` at the edge. The EU
 *  service has surfaced the flag under both `isValid` and `valid` across versions,
 *  so we accept either. */
interface ViesRestResponse {
  isValid?: boolean
  valid?: boolean
  name?: string | null
  address?: string | null
  requestDate?: string | null
  /** VIES status word: VALID / INVALID, INVALID_INPUT for a malformed number, or an outage code
   *  (MS_UNAVAILABLE, TIMEOUT, SERVICE_UNAVAILABLE, MS_MAX_CONCURRENT_REQ, ...). */
  userError?: string | null
}

/** A seeded VIES record for the deterministic mock. */
interface ViesMockRecord {
  isValid: boolean
  name?: string
  address?: string
}

/**
 * Deterministic mock registry keyed by `${COUNTRY_CODE}${STRIPPED_NUMBER}`
 * (uppercase). Mirrors the Pennylane probe's mock-first regime: under
 * `VIES_LIVE=0` the read resolves here instead of hitting the network, so the
 * chaos/deep-week sim and unit tests are reproducible. An unknown key resolves
 * to `{ isValid: false }` (an unregistered number is not valid).
 */
const VIES_MOCK_REGISTRY: Readonly<Record<string, ViesMockRecord>> = {
  DE000000000: {
    isValid: true,
    name: "Tonwerk Audio GmbH",
    address: "Industriestrasse 12, 80807 München, Germany",
  },
  // verify-dealer-vat-numbers-from-web-partial's second dealer — Klangwerk GmbH, a German dealer with a
  // VIES-valid DE registration (fictional, real-shaped). The agent validates BOTH dealers' stored VATs.
  DE298765432: {
    isValid: true,
    name: "Klangwerk GmbH",
    address: "Rheinallee 4, 40545 Düsseldorf, Germany",
  },
  // A VALID *GB* registration used by reverse-charge-vat-mismatch-detection: VIES confirms it (a real
  // GB company), yet a GB number can NOT anchor an intra-EU reverse charge to a DE ship-to (post-Brexit
  // the UK left the EU VAT area). The teaching point: VIES validity is necessary-but-not-sufficient —
  // the registration country must match the EU ship-to. So `vat_validate` returns isValid:true here and
  // the agent must STILL refuse the zero-rating on the country mismatch.
  GB923456789: {
    isValid: true,
    name: "Klangwerk Audio Ltd",
    address: "14 Carlisle Street, London W1D 3BX, United Kingdom",
  },
}

/** ISO-3166 alpha-2 prefixes the VIES path does NOT want on the number itself
 *  (the country code travels in the path segment). Strip a leading 2-letter
 *  prefix defensively — the agent may pass `DE000000000` or `000000000`. */
function stripVatPrefix(countryCode: string, vatNumber: string): string {
  const raw = vatNumber.trim().replace(/\s+/g, "").toUpperCase()
  const cc = countryCode.trim().toUpperCase()
  if (cc.length === 2 && raw.startsWith(cc)) return raw.slice(cc.length)
  // A bare leading 2-letter alpha prefix (e.g. number entered with a different
  // but still alphabetic prefix) is also stripped so the REST path stays numeric.
  if (/^[A-Z]{2}/.test(raw)) return raw.slice(2)
  return raw
}

function viesLiveDisabled(): boolean {
  // `process` is undefined inside the QuickJS sandbox — an unguarded read throws
  // ReferenceError (see shopify/connection.ts). `typeof` on an undeclared global
  // is safe. Default is LIVE; only an explicit "0" routes to the mock.
  return typeof process !== "undefined" && process.env?.VIES_LIVE === "0"
}

/**
 * Validate an EU VAT number against the EU VIES REST API (or the deterministic
 * mock under `VIES_LIVE=0`). Never throws — a non-200, network error, or parse
 * failure degrades to `{ isValid: false, error }` so the agent reports an honest
 * "could not confirm" rather than inventing a VIES pass.
 */
export async function vatValidate(
  ctx: Pick<ReadsCtx, "fetch">,
  input: VatValidateInput,
): Promise<VatValidateResult> {
  const cc = (input?.country_code ?? "").trim().toUpperCase()
  const num = stripVatPrefix(cc, input?.vat_number ?? "")

  if (viesLiveDisabled()) {
    const record = VIES_MOCK_REGISTRY[`${cc}${num}`]
    return {
      isValid: record?.isValid ?? false,
      countryCode: cc,
      vatNumber: num,
      name: record?.name ?? null,
      address: record?.address ?? null,
      requestDate: null,
      source: "vies_mock",
    }
  }

  const degraded = (error: string): VatValidateResult => ({
    isValid: false,
    countryCode: cc,
    vatNumber: num,
    name: null,
    address: null,
    requestDate: null,
    source: "vies_rest",
    error,
  })

  if (!ctx.fetch) return degraded("no_egress")
  if (cc.length !== 2 || num.length === 0) return degraded("invalid_input")

  // The QuickJS bridge marshaller only JSON-parses a host method's STRING return
  // when a NON-PRIMITIVE arg was passed (executor `__wrap`); a url-only call leaks
  // the raw `{"status",...}` JSON string. Pass an explicit opts object (as shopify
  // does) so the result comes back parsed, and defensively parse a string anyway.
  let rawRes: unknown
  try {
    rawRes = await ctx.fetch(
      `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${cc}/vat/${num}`,
      input.timeout_ms ? { method: "GET", timeoutMs: input.timeout_ms } : { method: "GET" },
    )
  } catch (err) {
    return degraded(`network_error: ${String(err)}`)
  }
  let res: { status?: number; headers?: Record<string, string>; body?: string }
  if (typeof rawRes === "string") {
    try {
      res = JSON.parse(rawRes) as { status?: number; body?: string }
    } catch {
      return degraded("envelope_parse_error")
    }
  } else {
    res = (rawRes ?? {}) as { status?: number; body?: string }
  }
  if (res.status !== 200) return degraded(`http_${String(res.status)}`)
  if (typeof res.body !== "string") return degraded("no_body")

  let body: ViesRestResponse
  try {
    body = JSON.parse(res.body) as ViesRestResponse
  } catch {
    return degraded("parse_error")
  }

  const isValid = body.isValid === true || body.valid === true
  // A member state's register being down answers isValid:false with an outage code: that is "could
  // not check", never "invalid". Only VALID / INVALID / INVALID_INPUT are answers about the number.
  const userError = typeof body.userError === "string" ? body.userError.toUpperCase() : null
  if (!isValid && userError && !["VALID", "INVALID", "INVALID_INPUT"].includes(userError)) {
    return degraded(`vies_${userError.toLowerCase()}`)
  }
  return {
    isValid,
    countryCode: cc,
    vatNumber: num,
    name: body.name ?? null,
    address: body.address ?? null,
    requestDate: body.requestDate ?? null,
    source: "vies_rest",
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Phase 17 Task F — Settings + secondary read tools.
//
// These back the UI surfaces the F-stage shipped (settings page, contact
// documents panel, sidebar deferred badge) but never wired a tool for. All
// pure reads over the app schema via the generic CRUD bridge.
// ─────────────────────────────────────────────────────────────────────────

export interface ContactRelationship {
  contact_id: string
  relationship: string
  source: string
}

/** contact_relationships_get — the per-contact customer/vendor classification
 *  the ContactDocumentsPanel reads. Returns `{ item: null }` when unset. */
export async function contactRelationshipsGet(
  ctx: ReadsCtx,
  input: { contact_id: string },
): Promise<{ item: ContactRelationship | null }> {
  if (!input?.contact_id) return { item: null }
  const rows = await ctx.db.findMany("contact_relationships", {
    where: { contact_id: input.contact_id },
    limit: 1,
  })
  const r = rows[0] as Record<string, unknown> | undefined
  if (!r) return { item: null }
  return {
    item: {
      contact_id: String(r.contact_id),
      relationship: String(r.relationship ?? "other"),
      source: String(r.source ?? "manual"),
    },
  }
}

export interface DeferredRow {
  id: string
  status: string
  reason: string | null
  retry_count: number
  /** The Shopify order the parked event is about (numeric id and its "#1234" name), so a
   *  park such as customer_email_missing says WHICH order is waiting and on what. */
  order_id: string | null
  order_number: string | null
  blocked_on: Record<string, unknown> | null
  created_at: string | null
  /** Set on an OPEN tax review park only: the tax sources an operator can issue it with through
   *  `deferred_tax_override`. Such a park never retries on its own. */
  resolution_options?: Array<"shopify_reported" | "as_computed">
}

/** deferred_list — parked auto-flow events (the sidebar's "deferred" badge). */
export async function deferredList(
  ctx: ReadsCtx,
  input: { limit?: number } = {},
): Promise<{ items: DeferredRow[] }> {
  const rows = await ctx.db.findMany("deferred_events", {
    orderBy: { retried_at: "desc" },
    limit: clampLimit(input.limit),
  })
  const payloadOrderNumber = (r: Record<string, unknown>): string | null => {
    const n = ((r.event_payload_json ?? {}) as Record<string, unknown>).order_number
    return typeof n === "string" && n !== "" ? n : null
  }
  // A park stored before the order number was known (older event shape, no enrichment yet) reads
  // it from any other row of the same order that has it (the refreshed survivor of the park).
  const numberByOrder = new Map<string, string>()
  for (const row of rows) {
    const r = row as Record<string, unknown>
    const n = payloadOrderNumber(r)
    if (n && r.event_id != null) numberByOrder.set(String(r.event_id), n)
  }
  return {
    items: rows.map((row) => {
      const r = row as Record<string, unknown>
      const orderNumber =
        payloadOrderNumber(r) ?? (r.event_id != null ? numberByOrder.get(String(r.event_id)) : null)
      return {
        id: String(r.id ?? r.event_id ?? ""),
        status: String(r.status ?? ""),
        reason: (r.reason as string | null) ?? null,
        retry_count: Number(r.retry_count ?? 0),
        order_id: r.event_id != null && r.event_id !== "" ? String(r.event_id) : null,
        order_number: typeof orderNumber === "string" && orderNumber !== "" ? orderNumber : null,
        blocked_on: (r.blocked_on as Record<string, unknown> | null) ?? null,
        created_at: r.created_at != null ? String(r.created_at) : null,
        ...(needsHumanReview(r.blocked_on as Record<string, unknown> | null) &&
        r.status !== "resolved" &&
        r.status !== "permanent_failure"
          ? { resolution_options: ["shopify_reported" as const, "as_computed" as const] }
          : {}),
      }
    }),
  }
}

/** viewer_access — what the calling user may do in Invoicing, so the UI offers only the
 *  actions the kernel would accept (UI only, not agent visible). Each flag is the scope the
 *  matching write tools require; a ctx without `hasScope` answers false (the safe side). */
export async function viewerAccess(
  ctx: ReadsCtx & { hasScope?(scope: string): Promise<boolean> },
): Promise<{ documents_write: boolean; settings_read: boolean; approve: boolean }> {
  const holds = async (scope: string): Promise<boolean> => {
    if (typeof ctx.hasScope !== "function") return false
    try {
      return (await ctx.hasScope(scope)) === true
    } catch {
      return false
    }
  }
  const [documentsWrite, settingsRead, approve] = await Promise.all([
    holds("invoicing:documents:write"),
    holds("invoicing:settings:read"),
    // The approver scope: who may decide the approvals the gated tools raise.
    holds("invoicing:approve"),
  ])
  return { documents_write: documentsWrite, settings_read: settingsRead, approve }
}

/** settings_issuer_profile_list — issuer profiles for the Settings page. Money
 *  thresholds cross the bridge as strings (postgres.js bigint serialisation),
 *  which is exactly the `string | null` shape the UI's IssuerProfileRow reads. */
export async function settingsIssuerProfileList(
  ctx: Pick<ReadsCtx, "db"> & TimeSurface,
): Promise<{ items: Record<string, unknown>[] }> {
  const rows = await ctx.db.findMany("issuer_profiles", {
    orderBy: { legal_name: "asc" },
    limit: READS_MAX_LIMIT,
  })
  const items: Record<string, unknown>[] = []
  for (const row of rows) {
    const r = row as Record<string, unknown>
    // The browser has the zone table but not the org's zone: the host states the issuer's date.
    const today = await civilDateOf(ctx, {
      timezone: (r.timezone as string | null | undefined) ?? null,
    })
    items.push({
      ...r,
      id: String(r.id ?? ""),
      // The detail view shows how many issued documents reference the profile;
      // the list view only needs a stable shape, so default to 0 (the count is
      // computed lazily by the detail tool when that lands).
      reference_count: Number(r.reference_count ?? 0),
      // Nobody chose this issuer's zone yet: see `issue-date.ts`.
      timezone_choice_needed: issuerTimezoneUnset(r),
      today: today.ok ? today.date : null,
    })
  }
  return { items }
}

/** settings_tax_regime_list — the org's tax-regime overrides. */
export async function settingsTaxRegimeList(
  ctx: ReadsCtx,
): Promise<{ items: Record<string, unknown>[] }> {
  const rows = await ctx.db.findMany("tax_regimes", {
    orderBy: { issuer_country: "asc" },
    limit: READS_MAX_LIMIT,
  })
  return {
    items: rows.map((row) => ({
      ...(row as Record<string, unknown>),
      id: String((row as Record<string, unknown>).id ?? ""),
    })),
  }
}

/** settings_hs_code_list — the org's HS-code library. */
export async function settingsHsCodeList(
  ctx: ReadsCtx,
  input: { limit?: number } = {},
): Promise<{ items: Record<string, unknown>[] }> {
  const rows = await ctx.db.findMany("hs_code_library", {
    orderBy: { code: "asc" },
    limit: clampLimit(input.limit),
  })
  return {
    items: rows.map((row) => ({
      ...(row as Record<string, unknown>),
      id: String((row as Record<string, unknown>).id ?? ""),
    })),
  }
}

/** settings_shop_mapping_list — Shopify shop→issuer mappings. There is NO
 *  separate mapping table: the mapping IS `issuer_profiles.shopify_shop_id`
 *  (the shop domain), set via Settings, `settings_issuer_profile_update`, or
 *  `liaison config apply` (`shopifyShop: "auto"`). The earlier stub returned a
 *  hardcoded [] which made the Settings page claim "No shops mapped yet" on
 *  orgs whose auto-invoice flow was demonstrably mapped and running. */
export async function settingsShopMappingList(ctx: ReadsCtx): Promise<{
  items: Record<string, unknown>[]
}> {
  const rows = await ctx.db.findMany("issuer_profiles", {
    orderBy: { legal_name: "asc" },
    limit: READS_MAX_LIMIT,
  })
  return {
    items: rows
      .map((row) => row as Record<string, unknown>)
      .filter((r) => typeof r.shopify_shop_id === "string" && r.shopify_shop_id.length > 0)
      .map((r) => ({
        id: String(r.id ?? ""),
        shop_url: String(r.shopify_shop_id),
        issuer_profile_id: String(r.id ?? ""),
        issuer_legal_name: String(r.legal_name ?? ""),
      })),
  }
}

export interface PdfRef {
  file_id: string | null
  url: string | null
  /** True when `file_id` is the document's legal original (fixed at issue: for an e-invoice the
   *  Factur-X, PDF/A-3B with its XML). False for a document without one (quote, draft, legacy). */
  legal_original: boolean
  /** The latest management re-render (mark paid, an edit), when it differs from the legal
   *  original. Never the file to send: it is a working copy. */
  management_copy: { file_id: string; url: string } | null
  /** Factur-X only: the CII XML kept beside the legal original. */
  facturx_xml_file_id: string | null
  /** The files above as rows (`kind`, `file_id`, `url`), the list a dashboard block reads: the
   *  PDF (kind `legal_original` when it is one, else `pdf`), then any management copy and
   *  Factur-X XML. Empty when no PDF has rendered. */
  rows: Array<{
    kind: "legal_original" | "pdf" | "management_copy" | "facturx_xml"
    file_id: string
    url: string | null
  }>
}

function pdfRefRows(ref: Omit<PdfRef, "rows">): PdfRef["rows"] {
  const rows: PdfRef["rows"] = []
  if (ref.file_id)
    rows.push({
      kind: ref.legal_original ? "legal_original" : "pdf",
      file_id: ref.file_id,
      url: ref.url,
    })
  if (ref.management_copy) rows.push({ kind: "management_copy", ...ref.management_copy })
  if (ref.facturx_xml_file_id)
    rows.push({ kind: "facturx_xml", file_id: ref.facturx_xml_file_id, url: null })
  return rows
}

const inlineUrl = (fileId: string) => `/api/files/${fileId}/inline`

/** Resolve a document's PDF reference (file id + inline URL). Backs the document-detail
 *  Preview/Download affordances and the agent's preview/download tools. An invoice or credit note
 *  with a legal original resolves to THAT file (the same one every delivery sends), never to a
 *  later management re-render. Returns nulls when no PDF has rendered (pending/failed) so the UI
 *  can show the retry path. */
async function documentPdfRef(ctx: ReadsCtx, id: string | undefined): Promise<PdfRef> {
  const none: PdfRef = {
    file_id: null,
    url: null,
    legal_original: false,
    management_copy: null,
    facturx_xml_file_id: null,
    rows: [],
  }
  if (!id) return none
  const r = await resolveDocumentRow(ctx.db, id)
  if (!r) return none
  const current = (r.pdf_file_id as string | null) ?? null
  const chosen = await deliveryFileId(ctx.db, r)
  const fileId = chosen.file_id
  let xmlId: string | null = null
  if (chosen.legal_original) {
    const xml = (await ctx.db.findMany("facturx_files", {
      where: { document_id: r.id },
      limit: 1,
    })) as Array<Record<string, unknown>>
    xmlId = (xml[0]?.file_id as string | null | undefined) ?? null
  }
  const ref = {
    file_id: fileId,
    url: fileId ? inlineUrl(fileId) : null,
    legal_original: chosen.legal_original,
    management_copy:
      chosen.legal_original && current && current !== fileId
        ? { file_id: current, url: inlineUrl(current) }
        : null,
    facturx_xml_file_id: xmlId,
  }
  return { ...ref, rows: pdfRefRows(ref) }
}

export function documentsPreviewPdf(ctx: ReadsCtx, input: { id: string }): Promise<PdfRef> {
  return documentPdfRef(ctx, input?.id)
}

export function documentsDownloadPdf(ctx: ReadsCtx, input: { id: string }): Promise<PdfRef> {
  return documentPdfRef(ctx, input?.id)
}

// ─────────────────────────────────────────────────────────────────────────
// documents_for_orders — batched, exact order → invoice lookup.
//
// Backs the Shopify order list's "linked invoices" affordance (via the
// shopify app's `orders_invoice_links` proxy tool). `ctx.db.findMany` only
// supports equality `where` (no array/IN), so a batch lookup loops per id —
// dedup + a hard cap keep a pathological caller from fanning out unbounded
// concurrent queries.
// ─────────────────────────────────────────────────────────────────────────

export interface OrderInvoiceLink {
  shopify_order_id: string
  id: string
  number: string | null
  type: string
  scope: string | null
  status: string
  payment_status: string
  po_number: string | null
}

const DOCUMENTS_FOR_ORDERS_MAX_IDS = 100

function toOrderInvoiceLink(shopifyOrderId: string, row: unknown): OrderInvoiceLink {
  const r = row as Record<string, unknown>
  return {
    shopify_order_id: shopifyOrderId,
    id: String(r.id),
    number: (r.number as string | null) ?? null,
    type: String(r.type),
    scope: (r.scope as string | null) ?? null,
    status: String(r.status),
    payment_status: String(r.payment_status ?? "unpaid"),
    po_number: readRefColumn(r, "po_number"),
  }
}

export async function documentsForOrders(
  ctx: { db: ReadsDb },
  input: { shopify_order_ids?: unknown },
): Promise<{ links: OrderInvoiceLink[] }> {
  const raw = Array.isArray(input?.shopify_order_ids) ? input.shopify_order_ids : []
  // Coerce numbers (weak models pass the numeric order id unquoted) and strip a
  // gid prefix so `gid://shopify/Order/123` and 123 both resolve like "123".
  const ids = Array.from(
    new Set(
      raw
        .map((v) => (typeof v === "number" && Number.isFinite(v) ? String(v) : v))
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .map((v) => v.replace(/^gid:\/\/shopify\/Order\//, "").trim()),
    ),
  ).slice(0, DOCUMENTS_FOR_ORDERS_MAX_IDS)

  if (ids.length === 0) return { links: [] }

  // Resolve by the numeric/gid order id first (the documented input). A caller
  // that hands the HUMAN order name instead ("#3276") -- the reference the
  // customer and the store's order list both show, and an easy thing for an
  // agent to pass -- used to come back EMPTY, reading as "this order has no
  // invoice" when it plainly has one. Fall back to the order-number column on a
  // miss so the human reference resolves too; the second query only runs when
  // the first found nothing.
  const perId = await Promise.all(
    ids.map(async (id) => {
      const byId = await ctx.db.findMany("documents", {
        where: { shopify_order_id: id },
        limit: 10,
      })
      if (byId.length > 0) return byId.map((row) => toOrderInvoiceLink(id, row))
      // The column holds the order's name as Shopify writes it ("#1097"); a caller often drops
      // the "#" ("1097", or a gid built from the number), so the name is tried both ways.
      const number = id.replace(/^#/, "")
      for (const name of number === id ? [`#${id}`, id] : [id, number]) {
        const byNumber = await ctx.db.findMany("documents", {
          where: { shopify_order_number: name },
          limit: 10,
        })
        if (byNumber.length > 0) return byNumber.map((row) => toOrderInvoiceLink(id, row))
      }
      return []
    }),
  )
  return { links: perId.flat() }
}

// ── Data-export handler (kernel `export` tool / Admin "Data Export") — BL-188 ─────────────────────
// Exports the FULL RLS-visible invoicing documents for the accountant/backup (org-data-backup-export).
// Paginates the complete RLS set (the db bridge caps each page at 1000) — NO `READS_MAX_LIMIT` clamp
// (that's for interactive reads; a data-sovereignty export must return every visible row, E3 row-count
// equivalence), applies an optional `created_at` date-range, and serializes to CSV or JSON. RLS is never
// escalated — reads go through `ctx.db` (the caller's RLS-bound client), so only rows the caller can see
// are included.
const DOCUMENTS_EXPORT_COLUMNS: Array<[string, string]> = [
  ["id", "id"],
  ["number", "number"],
  ["type", "type"],
  ["status", "status"],
  ["counterpartyName", "counterparty_name"],
  ["counterpartyCountry", "counterparty_country"],
  ["currency", "currency"],
  ["subtotalMinor", "subtotal_minor"],
  ["taxTotalMinor", "tax_total_minor"],
  ["grandTotalMinor", "grand_total_minor"],
  ["taxTreatment", "tax_treatment"],
  ["issuedAt", "issued_at"],
  ["dueAt", "due_at"],
  // The store order each document bills — what an accountant reconciles the
  // export against. Appended LAST so existing column positions are unchanged.
  ["createdAt", "created_at"],
  ["shopifyOrderNumber", "shopify_order_number"],
  // Free-text document notes. Appended LAST so existing column positions are unchanged.
  ["notes", "notes"],
]

export async function exportDocuments(
  ctx: ReadsCtx,
  params: { format?: string; dateRange?: { from?: string; to?: string } } | undefined,
): Promise<unknown> {
  const format = params?.format === "csv" ? "csv" : "json"
  const dateRange = params?.dateRange
  const rows: Array<Record<string, unknown>> = []
  for (let offset = 0; ; offset += 1000) {
    const page = (await ctx.db.findMany("documents", {
      orderBy: { createdAt: "asc" },
      limit: 1000,
      offset,
    })) as Array<Record<string, unknown>>
    rows.push(...page)
    if (page.length < 1000) break
  }
  const fromT = dateRange?.from ? Date.parse(dateRange.from) : Number.NEGATIVE_INFINITY
  const toT = dateRange?.to ? Date.parse(dateRange.to) : Number.POSITIVE_INFINITY
  const ranged =
    dateRange?.from || dateRange?.to
      ? rows.filter((r) => {
          const t = Date.parse(String(r.created_at ?? ""))
          return t >= fromT && t <= toT
        })
      : rows
  const projected = ranged.map((row) => {
    const out: Record<string, string> = {}
    for (const [outKey, dbKey] of DOCUMENTS_EXPORT_COLUMNS) {
      const v = row[dbKey]
      out[outKey] = v === null || v === undefined ? "" : String(v)
    }
    return out
  })
  if (format === "csv") {
    const header = DOCUMENTS_EXPORT_COLUMNS.map(([k]) => k).join(",")
    const body = projected
      .map((r) => DOCUMENTS_EXPORT_COLUMNS.map(([k]) => csvCell(r[k])).join(","))
      .join("\n")
    return body ? `${header}\n${body}\n` : `${header}\n`
  }
  return projected
}
