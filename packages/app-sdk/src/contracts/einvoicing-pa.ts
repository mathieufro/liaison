// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `einvoicing-pa@1`: the provider contract a PA (plateforme agréée) app implements so an
// invoicing app can transmit e-invoices and book sales through it without knowing which PA it
// is. The vocabulary follows the XP Z12-013 Flow Service where it applies (submit a flow, an
// acknowledgement, lifecycle states); the lifecycle states and their official codes follow
// XP Z12-012. A provider maps its own status words onto `LifecycleState`.
//
// Ops are tools of the provider app, reached only through the kernel contract dispatch
// (`ctx.contracts.call`): each op tool must be `trustBoundary:"internal"`, `agentVisible:false`,
// `gated:false` and `contractOnly:true`, and must declare at least the params listed here.

export const EINVOICING_PA = "einvoicing-pa@1" as const

export interface ContractOpSpec {
  /** A provider must implement it to register as implementing the contract. */
  required: boolean
  /** Param names the provider op tool must declare (manifest `params.properties`). */
  params: readonly string[]
  /**
   * An outbound legal action at the provider (a deposit, a transmission, a booking). The kernel
   * dispatches it only with a dispatch grant: a token it minted inside a person's approval of a
   * gated, `noAutoApprove` tool of the calling app (or that approver's own click), naming this op
   * and binding param values (document, legal original fingerprint, ...) that must match the call.
   */
  outbound?: boolean
  /**
   * Params naming a kernel file of the CALLER (the legal original). The provider runs the op
   * without the caller's data scopes; it may read exactly these files, and only when the caller
   * can read them itself.
   */
  fileParams?: readonly string[]
  /**
   * The param naming the ONE caller record (`{app, entity_type, entity_id}`, app = the caller) the
   * provider may store a file onto during this op (`files_importFromUrl`). The kernel binds that
   * exact record to the dispatch; an op without it may store nothing on the caller's side.
   */
  fileTarget?: string
}

export interface ContractSpec {
  contract: string
  version: number
  ops: Readonly<Record<string, ContractOpSpec>>
}

export const einvoicingPaV1: ContractSpec = {
  contract: "einvoicing-pa",
  version: 1,
  ops: {
    /** `{emission_activated, reception_activated, registrations:[{siren, status, direction}]}` */
    registration_status: { required: true, params: [] },
    /** Lookup before any create: `{found:false}` or `{found:true, provider_ref, state}`. */
    find_einvoice: { required: true, params: ["invoice_number", "issue_date"] },
    /**
     * Deposit the legal original (Factur-X) with the PA without transmitting it yet. Upserts the
     * buyer, re-checks eligibility from the CII, pins the file to `legal_original_sha256`, adopts
     * an existing deposit for the same invoice. `{provider_ref, state}`. `stream_ref` (optional,
     * `<issuer profile>:<stream>`) is set on a send under a stream's standing authorization so the
     * dispatch grant can bind it, and `run_item_ref` (optional) on a send a person approved with a
     * month-end run; a provider declares both and ignores them.
     */
    submit_einvoice: {
      required: true,
      outbound: true,
      fileParams: ["facturx_file_id"],
      params: [
        "document_ref",
        "invoice_number",
        "issue_date",
        "facturx_file_id",
        "legal_original_sha256",
        "cii_xml",
        "buyer",
        "idempotency_key",
        "stream_ref",
        "run_item_ref",
      ],
    },
    /**
     * One state-machine step (validation wait, transmission). `{state, provider_ref, detail?}`.
     * Carries the document and its legal original fingerprint so the dispatch grant binds it.
     */
    advance_einvoice: {
      required: true,
      outbound: true,
      params: [
        "provider_ref",
        "invoice_number",
        "issue_date",
        "document_ref",
        "legal_original_sha256",
        "stream_ref",
        "run_item_ref",
      ],
    },
    /** Re-read the provider's status: `{raw, mapped, code, provider_ts, reason_text}` */
    get_einvoice_status: { required: true, params: ["provider_ref"] },
    /**
     * Provider refs whose status may have changed (webhook inbox): `{items:[{provider_ref, kind,
     * event_type, ack}]}`. `cursor` = the comma-joined `ack` of the items the caller HANDLED (an
     * item it skipped is delivered again); optional `kind` lists only that kind.
     */
    list_status_changes: { required: true, params: ["cursor"] },
    /** Lookup before any booking create: `{found:false}` or `{found:true, provider_ref, e_invoicing}`. */
    find_booking: { required: true, params: ["idempotency_key"] },
    /** Book a sale in the PA's ledger (never transmitted). `{provider_ref, state:"booked"}` */
    book_sale: {
      required: true,
      outbound: true,
      fileParams: ["pdf_file_id"],
      params: ["document_ref", "pdf_file_id", "legal_original_sha256", "data", "idempotency_key"],
    },
    /**
     * A collection (payment received) where VAT falls due on receipt (optional in v1): the
     * amounts by VAT rate (`[{rate_bp, net_minor, vat_minor}]`, negative for a refund) of the
     * document at `provider_ref`. A fact, not an issuing act: no dispatch grant. `{state}`.
     */
    report_collection: {
      required: false,
      params: ["provider_ref", "date", "amounts_by_vat_rate", "idempotency_key"],
    },
    /**
     * Reception (optional in v1). Supplier e-invoices received through the PA, newest after
     * `cursor` (the catch-up; webhook arrivals come through `list_status_changes` with kind
     * `supplier_invoice`): `{items:[{provider_ref, received_at}], cursor, has_more}`.
     */
    list_received: { required: false, params: ["cursor"] },
    /** One received invoice, normalised: `ReceivedInvoice`. */
    get_received: { required: false, params: ["provider_ref"] },
    /**
     * Download one of its files (`file`: "original" = the untouched CII/UBL/Factur-X as received,
     * "rendering" = a PDF the provider renders) host-side onto the CALLER's own file parent
     * (`target: {app, entity_type, entity_id}`), the provider's credential sent to its first host
     * only.
     * `{file_id, sha256, byte_size, mime_type, filename}`.
     */
    fetch_received_file: {
      required: false,
      params: ["provider_ref", "file", "target"],
      fileTarget: "target",
    },
    /**
     * Refuse, dispute or withdraw a dispute (`status`: "refused" | "in_dispute" | "approved") with
     * one of the reasons `get_received` offers for that action (`reason`: the provider's slug);
     * `comment` is provider-optional. Answers the re-read `ReceivedInvoice`.
     */
    set_received_status: {
      required: false,
      params: ["provider_ref", "status", "reason", "comment"],
    },
  },
}

/** True when `op` of `contractKey` is an outbound legal action (needs a dispatch grant). */
export function isOutboundOp(contractKey: string, op: string): boolean {
  return KNOWN_CONTRACTS[contractKey]?.ops[op]?.outbound === true
}

/** The params of `op` that name a caller's kernel file (see `ContractOpSpec.fileParams`). */
export function contractFileParams(contractKey: string, op: string): readonly string[] {
  return KNOWN_CONTRACTS[contractKey]?.ops[op]?.fileParams ?? []
}

/** Contracts the kernel knows, keyed `"<contract>@<version>"`. */
export const KNOWN_CONTRACTS: Readonly<Record<string, ContractSpec>> = {
  [EINVOICING_PA]: einvoicingPaV1,
}

// ---------------------------------------------------------------------------------------------
// Lifecycle states (XP Z12-012 status codes), precedence and the monotonic merge.

export type LifecycleState =
  | "imported"
  | "deposited"
  | "sent"
  | "accepted"
  | "approved"
  | "in_dispute"
  | "partially_collected"
  | "collected"
  | "refused"
  | "rejected"

/** Official status code per state (null = no code: the deposit is internal to the provider). */
export const LIFECYCLE_CODE: Readonly<Record<LifecycleState, number | null>> = {
  imported: null,
  deposited: 200,
  sent: 201,
  accepted: 204,
  approved: 205,
  in_dispute: 207,
  partially_collected: 212,
  collected: 212,
  refused: 210,
  rejected: 213,
}

const RANK: Readonly<Record<LifecycleState, number>> = {
  imported: 0,
  deposited: 1,
  sent: 2,
  accepted: 3,
  approved: 4,
  in_dispute: 4,
  partially_collected: 5,
  collected: 6,
  refused: 99,
  rejected: 99,
}

export const TERMINAL_STATES: ReadonlySet<LifecycleState> = new Set(["refused", "rejected"])

/** States after which the buyer side has the invoice: refused / rejected need a human decision. */
export function isLifecycleState(v: unknown): v is LifecycleState {
  return typeof v === "string" && Object.hasOwn(RANK, v)
}

/**
 * The monotonic merge: a terminal state (refused, rejected) is never overwritten; any state may
 * move to a terminal one; otherwise a lower-ranked state never replaces a higher one, and
 * `approved` / `in_dispute` (same rank) may replace each other.
 */
export function mergeLifecycle(
  current: LifecycleState | null,
  next: LifecycleState | null,
): LifecycleState | null {
  if (next === null || !isLifecycleState(next)) return current
  if (current === null || !isLifecycleState(current)) return next
  if (TERMINAL_STATES.has(current)) return current
  if (TERMINAL_STATES.has(next)) return next
  return RANK[next] >= RANK[current] ? next : current
}

/** One observation of a provider status, as stored in a transmission's lifecycle log. */
export interface LifecycleObservation {
  raw: string | null
  mapped: LifecycleState | null
  code: number | null
  provider_ts: string | null
  observed_at: string
  source: "webhook" | "catch_up" | "refresh" | "transmit"
  reason_text?: string | null
}

// ---------------------------------------------------------------------------------------------
// Op result shapes (what a provider returns, what a caller may rely on).

export interface EinvoiceBuyer {
  contact_ref: string | null
  legal_name: string
  siren: string
  vat_id: string | null
  routing_address: string
  address: {
    line1: string
    line2?: string | null
    postcode: string
    city: string
    country_code: string
  }
  emails?: string[]
}

export type EinvoiceDepositState =
  | "imported"
  | "validation_pending"
  | "send_requested"
  | "sent"
  | "failed"
  | "not_in_directory"
  | "routing_mismatch"

export interface ContractOpError {
  status: "error"
  error: { code: string; message: string; retryable?: boolean; detail?: unknown }
}

export interface BookingLine {
  label: string
  quantity: string
  unit_price_minor: number
  subtotal_minor: number
  tax_minor: number
  tax_rate_bp: number
  /** The invoicing app's tax treatment (eu_domestic, eu_reverse_charge, eu_b2c_oss, eu_export_non_eu, …). */
  tax_treatment: string
  operation_category: "goods" | "services"
  rate_is_placeholder?: boolean
  destination_country?: string | null
}

export interface BookingData {
  invoice_number: string
  issue_date: string
  due_date: string
  currency: string
  /** Rate to EUR (1 EUR = fx_rate units of `currency`), required when currency ≠ EUR. */
  fx_rate?: string | null
  subtotal_minor: number
  tax_minor: number
  total_minor: number
  credit_of?: { invoice_number: string; provider_ref?: string | null } | null
  customer: {
    contact_ref: string | null
    kind: "business" | "individual" | "public_entity" | "non_registered_entity"
    legal_name: string
    first_name?: string | null
    last_name?: string | null
    vat_id?: string | null
    country_code: string
    address: {
      line1: string
      line2?: string | null
      postcode: string
      city: string
      country_code: string
    }
  }
  lines: BookingLine[]
}

// ---------------------------------------------------------------------------------------------
// Reception: supplier e-invoices received through the PA.

/** Where a received invoice stands, from the receiving side. */
export type ReceivedState =
  | "received"
  | "approved"
  | "in_dispute"
  | "refused"
  | "rejected"
  | "partially_collected"
  | "collected"

/** Official status code per received state (null: no code a receiver can observe for it). */
export const RECEIVED_CODE: Readonly<Record<ReceivedState, number | null>> = {
  received: null,
  approved: 205,
  in_dispute: 207,
  refused: 210,
  rejected: 213,
  partially_collected: 212,
  collected: 212,
}

const RECEIVED_RANK: Readonly<Record<ReceivedState, number>> = {
  received: 0,
  approved: 1,
  in_dispute: 1,
  partially_collected: 2,
  collected: 3,
  refused: 99,
  rejected: 99,
}

export const RECEIVED_TERMINAL: ReadonlySet<ReceivedState> = new Set(["refused", "rejected"])

export function isReceivedState(v: unknown): v is ReceivedState {
  return typeof v === "string" && Object.hasOwn(RECEIVED_RANK, v)
}

/** Same rule as `mergeLifecycle`: terminal kept, any state may become terminal, a lower rank never
 *  replaces a higher one, `approved` / `in_dispute` move laterally (a dispute withdrawn). */
export function mergeReceived(
  current: ReceivedState | null,
  next: ReceivedState | null,
): ReceivedState | null {
  if (next === null || !isReceivedState(next)) return current
  if (current === null || !isReceivedState(current)) return next
  if (RECEIVED_TERMINAL.has(current)) return current
  if (RECEIVED_TERMINAL.has(next)) return next
  return RECEIVED_RANK[next] >= RECEIVED_RANK[current] ? next : current
}

/**
 * Reason codes a receiver gives when refusing (210) or disputing (207) an invoice: the codes of
 * the "Tableau des motifs de refus" of the French e-invoicing specifications (annexe 7) that this
 * contract knows. A provider maps each of its own reasons onto one of them.
 */
export const AFNOR_REASON_CODES = [
  "DEST_ERR",
  "ROUTAGE_ERR",
  "DOUBLON",
  "MONTANT_ERR",
  "TX_TVA_ERR",
  "CALCUL_ERR",
  "NON_CONFORME",
  "PU_ERR",
  "QTE_ERR",
  "ART_ERR",
  "LIVR_INCOMP",
  "QUALITE_ERR",
  "ANNUL_ENC",
  "AUTRE",
] as const
export type AfnorReasonCode = (typeof AFNOR_REASON_CODES)[number]

export function isAfnorReasonCode(v: unknown): v is AfnorReasonCode {
  return typeof v === "string" && (AFNOR_REASON_CODES as readonly string[]).includes(v)
}

/** What a receiver may do to a received invoice. */
export type ReceivedAction = "refuse" | "dispute" | "undispute"

/** The received state each action asks the provider to set. */
export const RECEIVED_ACTION_STATUS: Readonly<
  Record<ReceivedAction, "refused" | "in_dispute" | "approved">
> = {
  refuse: "refused",
  dispute: "in_dispute",
  undispute: "approved",
}

/** One provider reason, with the official code it maps to and plain-word labels. */
export interface ReceivedReason {
  reason: string
  afnor_code: AfnorReasonCode
  label_en: string
  label_fr: string
}

/** An action the provider allows NOW for this invoice (none on a terminal or paid one). */
export interface ReceivedActionOffer {
  action: ReceivedAction
  /** Empty for `undispute`, which takes no reason. */
  reasons: ReceivedReason[]
  /** Whether a free-text comment is accepted (never required by the contract). */
  comment: boolean
}

export interface ReceivedInvoice {
  provider_ref: string
  supplier: { name: string | null; siren: string | null; vat_id: string | null }
  invoice_number: string | null
  issue_date: string | null
  due_date: string | null
  currency: string | null
  /** Decimal strings in the invoice currency, as the provider states them. */
  totals: { before_tax: string | null; tax: string | null; total: string | null }
  status: {
    raw: string | null
    mapped: ReceivedState
    code: number | null
    reason_text: string | null
  }
  /** The routing address the invoice was received on. */
  routing_address: string | null
  /** The PA flow id, when the provider exposes it. */
  flow_id: string | null
  /** Files the provider can hand over (`fetch_received_file`). */
  files: Array<{
    file: "original" | "rendering"
    filename: string | null
    mime_type: string | null
  }>
  actions: ReceivedActionOffer[]
  /** A payment is linked: refusing or disputing is no longer possible. */
  payment_linked: boolean
  provider_ts: string | null
  received_at: string | null
}
