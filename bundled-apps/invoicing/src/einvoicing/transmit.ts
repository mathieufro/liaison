// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Sending e-invoices through the bound PA provider (contract `einvoicing-pa@1`).
//
// Two phases (idempotent, crash-safe):
//   PREPARE  inside the human-approved `einvoice_send` (or the approver's own click): the
//            document is re-checked FROM THE DATABASE (regime e_invoice, a business buyer
//            established in France, a valid and active SIREN, the Factur-X legal original), the
//            approval's binding {document_id, legal_original_sha256, buyer_siren,
//            routing_address} is compared with what the database says now (any drift →
//            `einvoice_approval_stale`), and ONE transmission row is written under the key
//            sha256(document_id|send_einvoice|legal_original_sha256). No provider call.
//   EXECUTE  the `einvoicing-transmit` job: one provider step per row per tick, the row written
//            before and after each call (the job runs without an ambient transaction). Every
//            create is preceded by a provider-side lookup, so a crash in any window ends in
//            exactly one deposit and one transmission request.
// Jobs and webhooks only ever CREATE send approval requests (`stageSendApproval`); nothing but
// a person's approval or an approver's own click executes a send.
import {
  type ContractEnvelope,
  isLifecycleState,
  LIFECYCLE_CODE,
  type LifecycleState,
  mergeLifecycle,
} from "@liaison/app-sdk/contracts"
import { appEffectOnce, EffectOutcomeUnknown, type EffectsBridge } from "@liaison/app-sdk/effects"
import { base64, utf8Bytes } from "../legal-originals/bytes"
import { base64ToBytes, sha256OfBase64 } from "./backfill-sha256"
import { isValidSiren } from "./identity"
import { documentStreamRef, prepareStandingSend } from "./standing"
import { buyerTerritory } from "./territory"

export const CONTRACT = "einvoicing-pa@1"
type Row = Record<string, unknown>

export interface EinvDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      orderBy?: Record<string, "asc" | "desc">
      limit?: number
      offset?: number
    },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<unknown>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<unknown>
  updateMany?(
    entity: string,
    opts: { where: Record<string, unknown>; data: Record<string, unknown> },
  ): Promise<{ count: number }>
}

export interface ApprovalInput {
  tool_name: string
  summary: string
  summary_detail?: {
    subtitle?: string
    lines?: string[]
    links?: Array<{ label: string; app: string; entityType: string; entityId: string }>
  }
  current_payload: unknown
  editable_fields?: string[]
  on_behalf_of?: string | null
  /** Who decides the card: the holders of this scope of the app (default: the app's approve scope). */
  approve_scope?: string
}

export interface EinvCtx {
  db: EinvDb
  contracts?: {
    call(
      contract: string,
      op: string,
      params: Record<string, unknown>,
      opts?: { grant?: string | null; provider?: string | null },
    ): Promise<ContractEnvelope<unknown>>
    /** Kernel dispatch grant for outbound ops; minted only inside a person's approval (or click). */
    grant?(contract: string, ops: string[], subject: Record<string, string>): Promise<unknown>
  }
  files_getAttachmentBytes?(argsJson: string): Promise<string>
  emit?(event: { entity: string; action: string; entityId?: string; data?: unknown }): Promise<void>
  getUserId?(): Promise<string> | string
  approval?: { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null
  /** `auto_approved: true`: the kernel granted the request inline (a person's own call holding
   *  the deciding scope; no approval row) or an org policy approved it. */
  requestApproval?(
    input: ApprovalInput,
  ): Promise<
    | { approval_id: string; auto_approved?: undefined }
    | { approval_id: string | null; auto_approved: true }
  >
  /** Where one of this app's own approval requests stands (status only). */
  approvals?: { statusOf(approvalRequestId: string): Promise<unknown> }
  logger?: {
    info?(m: string, d?: unknown): void
    warn?(m: string, d?: unknown): void
    error?(m: string, d?: unknown): void
  }
  /** The kernel's effect ledger (`ctx.effects`): the deposit is claimed before the provider call. */
  effects?: EffectsBridge
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

export function fail(code: string, message: string, detail?: unknown) {
  return {
    status: "error" as const,
    error: { code, message, ...(detail !== undefined ? { detail } : {}) },
  }
}

export function sha256Text(s: string): string {
  return sha256OfBase64(base64(utf8Bytes(s))).sha256
}

export function decodeUtf8(b64: string): string {
  const bytes = base64ToBytes(b64)
  let out = ""
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!
    let cp: number
    if (b < 0x80) {
      cp = b
      i += 1
    } else if (b < 0xe0) {
      cp = ((b & 0x1f) << 6) | (bytes[i + 1]! & 0x3f)
      i += 2
    } else if (b < 0xf0) {
      cp = ((b & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f)
      i += 3
    } else {
      cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1]! & 0x3f) << 12) |
        ((bytes[i + 2]! & 0x3f) << 6) |
        (bytes[i + 3]! & 0x3f)
      i += 4
    }
    out += String.fromCodePoint(cp)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Settings (single `einvoicing_settings` row; the provider binding is read by the kernel).

export interface EinvoicingSettings {
  id: string | null
  provider_app: string | null
  cutover_date: string | null
  send_enabled: boolean
  book_enabled: boolean
  changed_by: string | null
}

export async function readEinvoicingSettings(
  db: Pick<EinvDb, "findMany">,
): Promise<EinvoicingSettings> {
  const rows = (await db.findMany("einvoicing_settings", {
    orderBy: { createdAt: "asc" },
    limit: 1,
  })) as Row[]
  const r = rows[0] ?? {}
  return {
    id: str(r.id),
    provider_app: str(r.provider_app),
    cutover_date: str(r.cutover_date),
    send_enabled: r.send_enabled === true,
    book_enabled: r.book_enabled === true,
    changed_by: str(r.changed_by),
  }
}

/** Last Sunday of `month` (0-based) in `year`, as a UTC day number of the month. */
function lastSunday(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0))
  return last.getUTCDate() - last.getUTCDay()
}

/**
 * The civil date in France (Europe/Paris) of an instant: CET (UTC+1), CEST (UTC+2) from the last
 * Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC (EU rule). Computed here
 * because the sandbox has no time-zone database. A bare `YYYY-MM-DD` is already a civil date, and
 * so is a stored `issued_at`: `issueDateParts` writes the issuer's own date, which the column keeps
 * as midnight UTC, and midnight UTC is that same day in France.
 */
export function parisCivilDate(at: unknown): string | null {
  if (typeof at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(at)) return at
  const ms =
    typeof at === "string"
      ? Date.parse(
          at.includes("T") || !at.includes(" ")
            ? at
            : at.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"),
        )
      : at instanceof Date
        ? at.getTime()
        : Number.NaN
  if (!Number.isFinite(ms)) return null
  const y = new Date(ms).getUTCFullYear()
  const summerStart = Date.UTC(y, 2, lastSunday(y, 2), 1)
  const summerEnd = Date.UTC(y, 9, lastSunday(y, 9), 1)
  const offset = ms >= summerStart && ms < summerEnd ? 2 : 1
  return new Date(ms + offset * 3600_000).toISOString().slice(0, 10)
}

/** On or after the cut-over date, comparing the issue instant's civil date in France. */
export function onOrAfterCutover(issuedAt: unknown, cutover: string | null): boolean {
  if (!cutover) return false
  const d = parisCivilDate(issuedAt)
  return d !== null && d >= cutover
}

/**
 * The organisation's switches for sending one document, re-read every time it matters (the
 * request, the approved execution, and the job right before each provider call): sending must be
 * on, and the document issued on or after the cut-over. Null when it may go.
 */
export function sendSwitchProblem(
  settings: EinvoicingSettings,
  doc: Row,
): ReturnType<typeof fail> | null {
  if (!settings.send_enabled) {
    return fail(
      "einvoice_send_disabled",
      "Sending e-invoices through the platform is switched off in the e-invoicing settings; nothing is sent.",
    )
  }
  if (!onOrAfterCutover(doc.issued_at, settings.cutover_date)) {
    return fail(
      "einvoice_before_cutover",
      `Document ${String(doc.number ?? doc.id)} was issued before the e-invoicing cut-over (${settings.cutover_date ?? "not set"}); it is never transmitted through the platform.`,
    )
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Eligibility and the approval binding, re-derived from the database.

export interface SendBinding {
  document_id: string
  legal_original_sha256: string
  buyer_siren: string
  routing_address: string
}

export interface SendFacts {
  doc: Row
  identity: Row | null
  binding: SendBinding
  legalOriginal: { id: string; file_id: string; sha256: string }
  facturx: { id: string; file_id: string }
}

const UNSENDABLE_STATUS = new Set(["draft", "pending_approval", "voided", "cancelled"])

export async function sendFacts(
  db: Pick<EinvDb, "findMany">,
  documentId: string,
  approved?: Partial<SendBinding> | null,
): Promise<{ ok: true; facts: SendFacts } | ReturnType<typeof fail>> {
  const doc = (
    (await db.findMany("documents", { where: { id: documentId }, limit: 1 })) as Row[]
  )[0]
  if (!doc) return fail("row_not_found", `document ${documentId} not found`)
  const reasons: string[] = []
  if (doc.type !== "invoice" && doc.type !== "credit_note")
    reasons.push(`a ${String(doc.type)} is not an invoice or credit note`)
  if (UNSENDABLE_STATUS.has(String(doc.status)))
    reasons.push(`the document is ${String(doc.status)}`)
  if (doc.regime !== "e_invoice")
    reasons.push(
      `its regime is ${String(doc.regime ?? "not recorded")}, not e_invoice (only a French business buyer with a SIREN is e-invoiced; this sale is reported instead)`,
    )
  if (doc.internal_cancellation === true)
    reasons.push("it is an internal cancellation (booked, never transmitted)")
  if (doc.customer_kind !== "business")
    reasons.push(`the buyer is ${String(doc.customer_kind ?? "of unknown kind")}, not a business`)
  const contactId = str(doc.counterparty_contact_id)
  const identity = contactId
    ? ((
        (await db.findMany("counterparty_identities", {
          where: { contact_id: contactId },
          limit: 1,
        })) as Row[]
      )[0] ?? null)
    : null
  const territory = buyerTerritory({
    billingCountry: str(doc.billing_country_code) ?? str(doc.counterparty_country),
    billingPostcode: str(doc.billing_postcode),
    vatId: str(doc.counterparty_vat_id),
  })
  const asFr =
    territory.territory === "FR" ||
    (territory.territory === "needs_review" && identity?.territory_treatment === "as_fr")
  if (!asFr)
    reasons.push(
      `the buyer is not established in France (${territory.country ?? "no billing country"})`,
    )
  const legalId = str(doc.legal_original_id)
  const lo = legalId
    ? (((await db.findMany("legal_originals", { where: { id: legalId }, limit: 1 })) as Row[])[0] ??
      null)
    : null
  if (!lo || lo.kind !== "facturx" || !str(lo.file_id) || !str(lo.sha256))
    reasons.push("it has no Factur-X legal original")
  else if (str(doc.legal_original_sha256) && lo.sha256 !== doc.legal_original_sha256)
    reasons.push("its legal original fingerprint does not match the document")
  const fx = (
    (await db.findMany("facturx_files", {
      where: { document_id: documentId },
      orderBy: { generated_at: "desc" },
      limit: 1,
    })) as Row[]
  )[0]
  if (!fx || !str(fx.file_id)) reasons.push("its Factur-X XML is missing")
  if (reasons.length > 0) {
    return fail(
      "einvoice_not_eligible",
      `Document ${String(doc.number ?? documentId)} cannot be sent through the PA: ${reasons.join("; ")}.`,
      { reasons },
    )
  }
  const buyerSiren = str(identity?.siren) ?? str(doc.buyer_siren) ?? ""
  const binding: SendBinding = {
    document_id: documentId,
    legal_original_sha256: String(lo!.sha256),
    buyer_siren: buyerSiren,
    routing_address: str(identity?.routing_address) ?? str(doc.buyer_routing_address) ?? buyerSiren,
  }
  if (approved) {
    const drift = (Object.keys(binding) as Array<keyof SendBinding>).filter(
      (k) => approved[k] !== undefined && approved[k] !== binding[k],
    )
    const missing = (Object.keys(binding) as Array<keyof SendBinding>).filter(
      (k) => approved[k] === undefined,
    )
    if (drift.length > 0 || missing.length > 0) {
      return fail(
        "einvoice_approval_stale",
        `What was approved no longer matches the document (${[...drift, ...missing].join(", ")} changed or missing). Request a new send approval.`,
        { changed: drift, missing },
      )
    }
  }
  const sirenReasons: string[] = []
  if (!isValidSiren(buyerSiren)) sirenReasons.push("the buyer SIREN is missing or invalid")
  if (str(doc.buyer_siren) && buyerSiren !== doc.buyer_siren)
    sirenReasons.push("the buyer SIREN changed since the invoice was issued")
  if (identity?.registry_status === "C")
    sirenReasons.push("the buyer's SIREN is ceased in the business registry")
  if (!identity && !str(doc.buyer_siren_confirmed_via))
    sirenReasons.push("the buyer SIREN was never confirmed")
  if (sirenReasons.length > 0) {
    return fail(
      "einvoice_not_eligible",
      `Document ${String(doc.number ?? documentId)} cannot be sent: ${sirenReasons.join("; ")}.`,
      { reasons: sirenReasons },
    )
  }
  return {
    ok: true,
    facts: {
      doc,
      identity,
      binding,
      legalOriginal: {
        id: String(lo!.id),
        file_id: String(lo!.file_id),
        sha256: String(lo!.sha256),
      },
      facturx: { id: String(fx!.id), file_id: String(fx!.file_id) },
    },
  }
}

/** sha256(document | action | legal original fingerprint), plus `| attempt` from a retry on. */
export function idempotencyKey(
  documentId: string,
  action: "send_einvoice" | "book_sale",
  legalSha: string,
  attempt = 1,
): string {
  return sha256Text(
    attempt > 1
      ? `${documentId}|${action}|${legalSha}|${attempt}`
      : `${documentId}|${action}|${legalSha}`,
  )
}

/** Send outcomes after which nothing more happens on that attempt; a person may retry. */
export const TERMINAL_SEND_FAILURES: ReadonlySet<string> = new Set([
  "failed",
  "not_in_directory",
  "routing_mismatch",
])

export function attemptOf(row: Row): number {
  const n = Number(row.attempt ?? 1)
  return Number.isInteger(n) && n >= 1 ? n : 1
}

/** The latest send attempt of a document (rows are append-only: a retry is a new row). */
export async function latestSendRow(
  db: Pick<EinvDb, "findMany">,
  documentId: string,
): Promise<Row | null> {
  const rows = (await db.findMany("einvoice_transmissions", {
    where: { document_id: documentId, action: "send_einvoice" },
    limit: 100,
  })) as Row[]
  let latest: Row | null = null
  for (const r of rows) if (!latest || attemptOf(r) > attemptOf(latest)) latest = r
  return latest
}

/**
 * The kernel's dispatch grant for outbound ops, binding `subject` (each later call must carry
 * these values). Minted only while a person's approval (or an approver's own click) is running
 * this app's gated, never-auto-approved tool; anywhere else the kernel refuses.
 */
export async function mintDispatchGrant(
  ctx: EinvCtx,
  ops: string[],
  subject: Record<string, string>,
): Promise<{ ok: true; grant: string } | ReturnType<typeof fail>> {
  if (!ctx.contracts?.grant)
    return fail("contracts_unavailable", "Dispatch grants are not available in this context.")
  const raw = await ctx.contracts.grant(CONTRACT, ops, subject)
  let out: unknown = raw
  if (typeof raw === "string") {
    try {
      out = JSON.parse(raw)
    } catch {
      out = null
    }
  }
  const o = (out ?? {}) as {
    grant?: unknown
    status?: string
    error?: { code?: string; message?: string }
  }
  if (typeof o.grant === "string" && o.grant !== "") return { ok: true, grant: o.grant }
  return fail(
    o.error?.code ?? "contract_grant_refused",
    o.error?.message ?? "The dispatch grant was refused.",
  )
}

// ---------------------------------------------------------------------------------------------
// Staging: create the send approval request (never executes anything).

const RESTAGE_AFTER_MS = 24 * 3600 * 1000

function confirmationLines(f: SendFacts): string[] {
  const reg = str(f.identity?.registry_name)
  const contactName = str(f.doc.counterparty_name) ?? str(f.doc.buyer_legal_name)
  const mismatch =
    reg &&
    contactName &&
    !reg.toUpperCase().includes(contactName.toUpperCase().split(/\s+/)[0] ?? "")
  return [
    `Registry name: ${reg ?? str(f.doc.buyer_legal_name) ?? "(not recorded)"}${mismatch ? `  (Liaison contact: ${contactName}; check it is the same company)` : ""}`,
    `SIREN: ${f.binding.buyer_siren}`,
    `Registered office: ${str(f.identity?.registry_city) ?? str(f.doc.billing_city) ?? "(unknown)"}`,
    `Routing address: ${f.binding.routing_address}`,
    `Legal original fingerprint: ${f.binding.legal_original_sha256.slice(0, 16)}…`,
  ]
}

/** The e-invoicing platform as a person names it ("pennylane" -> "Pennylane"). */
function platformName(app: string | null | undefined): string {
  const s = String(app ?? "the e-invoicing platform")
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export async function stageSendApproval(
  ctx: EinvCtx,
  documentId: string,
  opts: { onBehalfOf?: string | null; force?: boolean } = {},
): Promise<
  | { status: "staged"; approval_id: string; deduped: boolean }
  | { status: "approver_may_send"; document_id: string; message: string }
  | ReturnType<typeof fail>
> {
  const r = await sendFacts(ctx.db, documentId)
  if (!("ok" in r)) return r
  const f = r.facts
  const settings = await readEinvoicingSettings(ctx.db)
  if (!settings.provider_app) {
    return fail(
      "contract_provider_not_configured",
      "No PA provider is configured for e-invoicing (an administrator sets it in the e-invoicing settings).",
    )
  }
  const switched = sendSwitchProblem(settings, f.doc)
  if (switched) return switched
  // One live attempt at a time. After a terminal failure (failed, not in the directory, routing
  // mismatch) a person may ask again: a NEW attempt, under a fresh approval, appended as a new row.
  const latest = await latestSendRow(ctx.db, documentId)
  if (latest && !TERMINAL_SEND_FAILURES.has(String(latest.state))) {
    return fail(
      "einvoice_already_sent",
      `Document ${String(f.doc.number)} already has a PA transmission (${String(latest.state)}).`,
    )
  }
  const attempt = latest ? attemptOf(latest) + 1 : 1
  const prevId = str(f.doc.einvoice_send_approval_id)
  const prevAt = str(f.doc.einvoice_send_requested_at)
  const prevAttempt = Number(f.doc.einvoice_send_attempt ?? 1)
  if (
    !opts.force &&
    prevId &&
    prevAt &&
    prevAttempt === attempt &&
    Date.now() - Date.parse(prevAt) < RESTAGE_AFTER_MS
  ) {
    return { status: "staged", approval_id: prevId, deduped: true }
  }
  if (!ctx.requestApproval)
    return fail("approval_unavailable", "Approval requests cannot be created from this context.")
  const approval = await ctx.requestApproval({
    tool_name: "invoicing:einvoice_send",
    summary: `${attempt > 1 ? "Send again" : "Send"} e-invoice ${String(f.doc.number)}${f.doc.counterparty_name ? ` (${String(f.doc.counterparty_name)})` : ""} through ${platformName(settings.provider_app)}`,
    summary_detail: {
      subtitle:
        "Transmits the Factur-X legal original to the buyer's platform. This cannot be undone.",
      lines: [
        ...confirmationLines(f),
        ...(latest
          ? [
              `Attempt ${attempt}: the previous one ended ${String(latest.state)}${(latest.last_error as Row | null)?.code ? ` (${String((latest.last_error as Row).code)})` : ""}. The platform is checked for an earlier deposit first.`,
            ]
          : []),
      ],
      links: [
        {
          label: `Open ${String(f.doc.number ?? "the document")}`,
          app: "invoicing",
          entityType: "detail",
          entityId: documentId,
        },
      ],
    },
    current_payload: { ...f.binding, ...(attempt > 1 ? { attempt } : {}) },
    editable_fields: [],
    ...(opts.onBehalfOf ? { on_behalf_of: opts.onBehalfOf } : {}),
  })
  if (approval.auto_approved) {
    // A person's own call by someone who may decide the send: approvals are for agents, so the
    // kernel parked nothing. The send itself is not made from here: its dispatch grant is minted
    // only inside the gated send's own run, so the person sends it with their own click
    // (einvoice_send), and nothing is recorded as awaiting an approval that does not exist.
    return {
      status: "approver_may_send",
      document_id: documentId,
      message: `You hold the permission to send e-invoice ${String(f.doc.number)} yourself: send it directly (einvoice_send). No approval was requested.`,
    }
  }
  const approval_id = approval.approval_id
  await ctx.db.update("documents", documentId, {
    einvoice_send_approval_id: approval_id,
    einvoice_send_requested_at: new Date().toISOString(),
    einvoice_send_attempt: attempt,
    einvoice_state: "awaiting_send_approval",
  })
  return { status: "staged", approval_id, deduped: false }
}

/** After issue: stage the send approval when the document is an e_invoice issued on or after the
 *  cut-over and sending is on. Returns the approval id, or null when nothing was staged.
 *  `send: "batch"`: issued with no person, the document waits for the daily send card instead
 *  (`awaiting_send_batch`), and nothing is staged for it alone. `send: "held"`: the issue's own
 *  caller prepares the send under a grant it holds (a person-approved month-end run). */
export async function stageSendAfterIssue(
  ctx: EinvCtx,
  documentId: string,
  opts: { send?: "stage" | "batch" | "held" } = {},
): Promise<string | null> {
  // A month-end run's row approved by a person holds its own send grant: its issue path prepares it.
  if (opts.send === "held") return null
  const settings = await readEinvoicingSettings(ctx.db)
  if (!settings.provider_app || !settings.send_enabled) return null
  const doc = (
    (await ctx.db.findMany("documents", { where: { id: documentId }, limit: 1 })) as Row[]
  )[0]
  if (!doc || doc.regime !== "e_invoice" || !onOrAfterCutover(doc.issued_at, settings.cutover_date))
    return null
  if (doc.einvoice_state === "awaiting_send_batch") return null
  if (opts.send === "batch") {
    // A stream a person authorized to send on its own: prepared now, under that standing grant.
    if (await prepareStandingSend(ctx, documentId)) return null
    await ctx.db.update("documents", documentId, {
      einvoice_state: "awaiting_send_batch",
      einvoice_send_requested_at: new Date().toISOString(),
    })
    return null
  }
  const r = await stageSendApproval(ctx, documentId)
  if ("approval_id" in r) return r.approval_id
  // The issuer may send it themselves: nothing was staged and nothing is blocked.
  if (r.status === "approver_may_send") return null
  // Not sendable as it stands (e.g. a SIREN to confirm): readiness and the panel say why.
  await ctx.db.update("documents", documentId, { einvoice_state: "send_blocked" })
  return null
}

/** Agent / UI tool `einvoice_send_request`: ask for the send approval of one document. Refuses
 *  (no approval) anything that is not a domestic B2B e-invoice. */
export async function einvoiceSendRequest(ctx: EinvCtx, params: { document_id?: string }) {
  const id = str(params?.document_id)
  if (!id) return fail("invalid_input", "document_id is required")
  return stageSendApproval(ctx, id, { force: false })
}

// ---------------------------------------------------------------------------------------------
// The gated send (runs only after a person approved it, or on an approver's own click).

export async function einvoiceSend(
  ctx: EinvCtx,
  params: Partial<SendBinding> & { attempt?: number | null },
) {
  const id = str(params?.document_id)
  if (!id) return fail("invalid_input", "document_id is required")
  const attempt =
    params?.attempt === undefined || params?.attempt === null ? 1 : Number(params.attempt)
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 100)
    return fail("invalid_input", "attempt must be a positive integer")
  const r = await sendFacts(ctx.db, id, params)
  if (!("ok" in r)) return r
  const f = r.facts
  const settings = await readEinvoicingSettings(ctx.db)
  if (!settings.provider_app) {
    return fail("contract_provider_not_configured", "No PA provider is configured for e-invoicing.")
  }
  const switched = sendSwitchProblem(settings, f.doc)
  if (switched) return switched
  const key = idempotencyKey(id, "send_einvoice", f.binding.legal_original_sha256, attempt)
  const existing = (
    (await ctx.db.findMany("einvoice_transmissions", {
      where: { idempotency_key: key },
      limit: 1,
    })) as Row[]
  )[0]
  if (existing) {
    // An approval replayed, or approved twice: the one prepared row stands.
    return {
      status: "ok",
      transmission_id: String(existing.id),
      state: String(existing.state),
      replay: true,
    }
  }
  // Attempt n only right after attempt n-1 ended in a terminal failure; never beside a live one.
  const latest = await latestSendRow(ctx.db, id)
  if (
    latest
      ? !TERMINAL_SEND_FAILURES.has(String(latest.state)) || attemptOf(latest) !== attempt - 1
      : attempt !== 1
  ) {
    return fail(
      latest && !TERMINAL_SEND_FAILURES.has(String(latest.state))
        ? "einvoice_already_sent"
        : "einvoice_retry_not_allowed",
      latest
        ? `Document ${String(f.doc.number)} has attempt ${attemptOf(latest)} (${String(latest.state)}); this approval was for attempt ${attempt}. Request the send again.`
        : `Document ${String(f.doc.number)} has no failed attempt to retry; this approval was for attempt ${attempt}.`,
    )
  }
  // The person's decision, made portable: the job that later deposits and transmits presents
  // this grant, and the kernel refuses any outbound op without it (or for another document).
  const granted = await mintDispatchGrant(ctx, ["submit_einvoice", "advance_einvoice"], {
    document_ref: id,
    invoice_number: String(f.doc.number),
    legal_original_sha256: f.binding.legal_original_sha256,
  })
  if (!("ok" in granted)) return granted
  const approvedBy =
    ctx.approval?.approvalDeciderId ?? (ctx.getUserId ? await ctx.getUserId() : null)
  const inserted = (await ctx.db.insert("einvoice_transmissions", {
    document_id: id,
    action: "send_einvoice",
    idempotency_key: key,
    attempt,
    provider_app: settings.provider_app,
    state: "prepared",
    approval_request_id: ctx.approval?.approvalRequestId ?? null,
    approved_by: approvedBy,
    approval_method: ctx.approval ? "approval" : "direct_click",
    approval_snapshot: { ...f.binding },
    dispatch_grant: granted.grant,
    attempts: 0,
    lifecycle_log: [],
  })) as Row
  await ctx.db.update("documents", id, {
    einvoice_state: "prepared",
    pa_provider: settings.provider_app,
  })
  return { status: "ok", transmission_id: String(inserted.id), state: "prepared", replay: false }
}

// ---------------------------------------------------------------------------------------------
// Execution (job): one provider step per row.

const LEASE_MS = 5 * 60 * 1000
const STEP_STATES = ["prepared", "imported", "validation_pending", "send_requested"]
const MAX_ROWS_PER_TICK = 20

export interface StepOutcome {
  stop: boolean // a provider rate limit: stop this tick
}

async function claim(db: EinvDb, row: Row): Promise<boolean> {
  if (!db.updateMany) return true
  const now = Date.now()
  const lease = str(row.lease_until)
  if (lease && Date.parse(lease) > now) return false
  // Compare-and-set on the row's unique key (the bridge's updateMany does not take `id`).
  const { count } = await db.updateMany("einvoice_transmissions", {
    where: { idempotency_key: row.idempotency_key, lease_until: row.lease_until ?? null },
    data: { lease_until: new Date(now + LEASE_MS).toISOString() },
  })
  return count === 1
}

function truncateError(e: unknown): Record<string, unknown> {
  const s = JSON.stringify(e ?? null)
  return s.length <= 2048 ? (e as Record<string, unknown>) : { truncated: s.slice(0, 2000) }
}

async function call(
  ctx: EinvCtx,
  op: string,
  params: Record<string, unknown>,
  opts?: { grant?: string | null; provider?: string | null },
): Promise<
  | { ok: true; result: Row; provider: string | null }
  | { ok: false; error: { code: string; message: string; retryable?: boolean; detail?: unknown } }
> {
  if (!ctx.contracts)
    return {
      ok: false,
      error: { code: "contracts_unavailable", message: "contract dispatch is not available here" },
    }
  const env = opts
    ? await ctx.contracts.call(CONTRACT, op, params, opts)
    : await ctx.contracts.call(CONTRACT, op, params)
  if (env.status === "error") return { ok: false, error: env.error }
  const result = (env.result ?? {}) as Row
  if (result.status === "error" && result.error) return { ok: false, error: result.error as never }
  return { ok: true, result, provider: typeof env.provider === "string" ? env.provider : null }
}

type CallResult = Awaited<ReturnType<typeof call>>

/** A submit the provider refused: nothing was deposited, so the claim is released. */
class SubmitRefused extends Error {
  constructor(readonly res: CallResult) {
    super("submit refused")
  }
}

/**
 * Failures that say for sure nothing was deposited: the platform refused the invoice (a
 * non-retryable error), throttled the call, or does not emit yet. Any other failure (a timeout,
 * a server error, a lost connection: retryable) may have left the invoice deposited.
 */
const DEFINITE_REFUSALS: ReadonlySet<string> = new Set([
  "provider_rate_limited",
  "pa_emission_not_activated",
])

function isDefiniteRefusal(err: { code: string; retryable?: boolean }): boolean {
  return err.retryable !== true || DEFINITE_REFUSALS.has(err.code)
}

/**
 * The deposit, at most once (S11). Claimed in the kernel's effect ledger under the row's own
 * idempotency key before the provider call, stored after. A job run twice (a deploy handing it
 * back, a crash re-running it) gets the stored answer instead of depositing again. When an
 * earlier run claimed the key and died before storing the answer, the platform is asked
 * (`find_einvoice`): found means it was deposited (adopted as the answer), not found means it
 * was not (deposited now). A platform that cannot be asked leaves it unknown, retried later.
 * A deposit that failed in doubt (a timeout, a server error: retryable) is not released but
 * marked unknown, so the next tick asks the platform first; only a definite refusal releases it.
 * Without `ctx.effects` (an older kernel) the call is made as before; the provider-side lookup
 * on retries still guards it.
 */
async function submitOnce(
  ctx: EinvCtx,
  row: Row,
  params: Record<string, unknown>,
  number: string,
  issueDate: string,
): Promise<CallResult | "in_flight" | "unknown"> {
  const submit = () => call(ctx, "submit_einvoice", params, rowOpts(row, true))
  if (!ctx.effects) return submit()
  try {
    const out = await appEffectOnce<CallResult>(
      ctx.effects,
      `einv:${String(row.idempotency_key)}:submit`,
      async () => {
        let res: CallResult
        try {
          res = await submit()
        } catch (err) {
          // The call may have reached the platform before it failed.
          throw new EffectOutcomeUnknown("the deposit call failed", {
            ok: false,
            error: {
              code: "einvoice_outcome_unknown",
              message: `The deposit call failed: ${(err as Error)?.message ?? String(err)}`,
              retryable: true,
            },
          } satisfies CallResult)
        }
        if (res.ok) return res
        if (isDefiniteRefusal(res.error)) throw new SubmitRefused(res)
        // In doubt: the claim turns unknown, so the next tick asks the platform before depositing.
        throw new EffectOutcomeUnknown("the deposit outcome is in doubt", res)
      },
      {
        onUnknown: async () => {
          const found = await call(
            ctx,
            "find_einvoice",
            { invoice_number: number, issue_date: issueDate },
            rowOpts(row),
          )
          if (!found.ok) return { outcome: "skip" }
          if (found.result.found === true && str(found.result.provider_ref)) {
            return {
              outcome: "done",
              result: {
                ok: true,
                result: {
                  state: String(found.result.state),
                  provider_ref: String(found.result.provider_ref),
                },
                provider: found.provider,
              },
            }
          }
          return { outcome: "retry" }
        },
      },
    )
    if (out.status === "ran" || out.status === "replayed") return out.result
    return out.status
  } catch (err) {
    if (err instanceof SubmitRefused) return err.res
    if (err instanceof EffectOutcomeUnknown) return err.detail as CallResult
    throw err
  }
}

/** The options of a call about one transmission row: through the provider it is pinned to. */
function rowOpts(row: Row, withGrant = false): { grant?: string | null; provider?: string | null } {
  return {
    provider: str(row.provider_app),
    ...(withGrant ? { grant: str(row.dispatch_grant) } : {}),
  }
}

async function readXml(
  ctx: EinvCtx,
  facturx: { id: string; file_id: string },
): Promise<string | null> {
  if (!ctx.files_getAttachmentBytes) return null
  const file = JSON.parse(
    await ctx.files_getAttachmentBytes(
      JSON.stringify({
        fileId: facturx.file_id,
        allowedParents: [{ app: "invoicing", entityType: "facturx_xml", entityId: facturx.id }],
      }),
    ),
  ) as { bytesBase64?: string }
  return file.bytesBase64 ? decodeUtf8(file.bytesBase64) : null
}

async function emitOnce(ctx: EinvCtx, action: string, entityId: string, data: Row): Promise<void> {
  if (ctx.emit) await ctx.emit({ entity: "einvoicing", action, entityId, data })
}

async function recordFailure(
  ctx: EinvCtx,
  row: Row,
  err: { code: string; message: string; retryable?: boolean; detail?: unknown },
  doc: Row | null,
): Promise<StepOutcome> {
  const attempts = Number(row.attempts ?? 0) + 1
  const retryable = err.retryable === true || err.code === "pa_emission_not_activated"
  const delayMs =
    err.code === "pa_emission_not_activated"
      ? 3600_000
      : Math.min(60_000 * 2 ** Math.min(attempts, 6), 6 * 3600_000)
  const update: Row = {
    attempts,
    last_error: truncateError({
      code: err.code,
      message: err.message,
      ...(err.detail !== undefined ? { detail: err.detail } : {}),
    }),
    lease_until: null,
    next_attempt_at: retryable ? new Date(Date.now() + delayMs).toISOString() : null,
  }
  if (!retryable) update.state = "failed"
  await ctx.db.update("einvoice_transmissions", String(row.id), update)
  if (!retryable || (err.code === "pa_emission_not_activated" && attempts === 1)) {
    if (doc && !retryable)
      await ctx.db.update("documents", String(row.document_id), { einvoice_state: "failed" })
    await emitOnce(
      ctx,
      row.action === "book_sale" ? "booking_failed" : "transmission_failed",
      String(row.document_id),
      {
        document_id: row.document_id,
        number: doc?.number ?? null,
        code: err.code,
        reason: err.message,
        resolved: false,
      },
    )
  }
  return { stop: err.code === "provider_rate_limited" }
}

async function setState(ctx: EinvCtx, row: Row, state: string, extra: Row = {}): Promise<void> {
  await ctx.db.update("einvoice_transmissions", String(row.id), {
    state,
    lease_until: null,
    last_error: null,
    next_attempt_at: null,
    ...extra,
  })
  await ctx.db.update("documents", String(row.document_id), { einvoice_state: state })
}

async function stepSend(ctx: EinvCtx, row: Row): Promise<StepOutcome> {
  const r = await sendFacts(ctx.db, String(row.document_id))
  if (!("ok" in r)) return recordFailure(ctx, row, r.error, null)
  const f = r.facts
  const snapshot = (row.approval_snapshot ?? {}) as Partial<SendBinding>
  if (
    snapshot.legal_original_sha256 &&
    snapshot.legal_original_sha256 !== f.binding.legal_original_sha256
  ) {
    return recordFailure(
      ctx,
      row,
      {
        code: "einvoice_approval_stale",
        message: "The legal original changed after the approval.",
      },
      f.doc,
    )
  }
  // A send under a stream's standing grant goes only for a document of that very stream, read
  // from the document now, never from what was stored with the send.
  const rowStream = str(row.stream_ref)
  if (rowStream && documentStreamRef(f.doc) !== rowStream) {
    return recordFailure(
      ctx,
      row,
      {
        code: "stream_mismatch",
        message: `Document ${String(f.doc.number)} is not in the stream whose standing authorization prepared this send; nothing was sent. Ask for its send on the daily card.`,
      },
      f.doc,
    )
  }
  // A send under a month-end row's grant goes only for the invoice that row names now.
  const rowItem = str(row.run_item_ref)
  if (rowItem) {
    const item = (
      (await ctx.db.findMany("recurring_run_items", { where: { id: rowItem }, limit: 1 })) as Row[]
    )[0]
    if (!item || String(item.document_id) !== String(row.document_id)) {
      return recordFailure(
        ctx,
        row,
        {
          code: "run_item_mismatch",
          message: `Document ${String(f.doc.number)} is not the invoice of the month-end row whose approval prepared this send; nothing was sent. Ask for its send again.`,
        },
        f.doc,
      )
    }
  }
  const streamParam = {
    ...(rowStream ? { stream_ref: rowStream } : {}),
    ...(rowItem ? { run_item_ref: rowItem } : {}),
  }
  // The switches, right before any provider call: sending switched off since the approval holds
  // the row (it resumes when switched back on); a document before the cut-over never goes.
  const switched = sendSwitchProblem(await readEinvoicingSettings(ctx.db), f.doc)
  if (switched) {
    if (switched.error.code === "einvoice_send_disabled") {
      await ctx.db.update("einvoice_transmissions", String(row.id), {
        lease_until: null,
        last_error: { code: switched.error.code, message: switched.error.message },
        next_attempt_at: new Date(Date.now() + 3600_000).toISOString(),
      })
      return { stop: false }
    }
    return recordFailure(ctx, row, switched.error, f.doc)
  }
  const number = String(f.doc.number)
  const issueDate = String(f.doc.issued_at ?? "").slice(0, 10)
  if (row.state === "prepared" && attemptOf(row) > 1) {
    // A retry: an earlier attempt may have reached the platform after all. Look it up by invoice
    // number first and adopt it; only a document the platform does not hold is deposited again.
    const found = await call(
      ctx,
      "find_einvoice",
      { invoice_number: number, issue_date: issueDate },
      rowOpts(row),
    )
    if (!found.ok) return recordFailure(ctx, row, found.error, f.doc)
    if (found.result.found === true && str(found.result.provider_ref)) {
      const adopted = String(found.result.state)
      await setState(ctx, row, adopted === "imported" ? "validation_pending" : adopted, {
        provider_ref: String(found.result.provider_ref),
      })
      if (adopted === "sent")
        await refreshStatus(
          ctx,
          { ...row, state: "sent", provider_ref: String(found.result.provider_ref) },
          "transmit",
        )
      return { stop: false }
    }
  }
  if (row.state === "prepared") {
    const xml = await readXml(ctx, f.facturx)
    if (!xml)
      return recordFailure(
        ctx,
        row,
        {
          code: "facturx_unreadable",
          message: "The Factur-X XML could not be read.",
          retryable: true,
        },
        f.doc,
      )
    const submitParams = {
      document_ref: String(row.document_id),
      invoice_number: number,
      issue_date: issueDate,
      facturx_file_id: f.legalOriginal.file_id,
      legal_original_sha256: f.legalOriginal.sha256,
      cii_xml: xml,
      buyer: {
        contact_ref: str(f.doc.counterparty_contact_id),
        legal_name:
          str(f.identity?.registry_name) ??
          str(f.doc.buyer_legal_name) ??
          str(f.doc.counterparty_name) ??
          "",
        siren: f.binding.buyer_siren,
        vat_id: str(f.doc.counterparty_vat_id),
        routing_address: f.binding.routing_address,
        address: {
          line1: str(f.doc.billing_line1) ?? str(f.identity?.registry_line1) ?? "",
          line2: str(f.doc.billing_line2),
          postcode: str(f.doc.billing_postcode) ?? str(f.identity?.registry_postcode) ?? "",
          city: str(f.doc.billing_city) ?? str(f.identity?.registry_city) ?? "",
          country_code: "FR",
        },
      },
      idempotency_key: String(row.idempotency_key),
      ...streamParam,
    }
    const submitted = await submitOnce(ctx, row, submitParams, number, issueDate)
    if (submitted === "in_flight") {
      // Another run is depositing this very row now: it owns the outcome.
      await ctx.db.update("einvoice_transmissions", String(row.id), { lease_until: null })
      return { stop: false }
    }
    if (submitted === "unknown") {
      return recordFailure(
        ctx,
        row,
        {
          code: "einvoice_outcome_unknown",
          message:
            "An earlier deposit may have reached the platform and it could not be checked; it is looked up again.",
          retryable: true,
        },
        f.doc,
      )
    }
    const res = submitted
    if (!res.ok) return recordFailure(ctx, row, res.error, f.doc)
    const state = String(res.result.state)
    if (state === "not_in_directory" || state === "routing_mismatch") {
      await setState(ctx, row, state, { last_error: { listed: res.result.listed ?? [] } })
      await emitOnce(ctx, state, String(row.document_id), {
        document_id: row.document_id,
        number,
        listed: Array.isArray(res.result.listed) ? (res.result.listed as string[]).join(", ") : "",
        routing_address: f.binding.routing_address,
        resolved: false,
      })
      return { stop: false }
    }
    await setState(ctx, row, state === "imported" ? "validation_pending" : state, {
      provider_ref: String(res.result.provider_ref),
    })
    return { stop: false }
  }
  // imported / validation_pending / send_requested: one advance step.
  const res = await call(
    ctx,
    "advance_einvoice",
    {
      provider_ref: String(row.provider_ref),
      invoice_number: number,
      issue_date: issueDate,
      document_ref: String(row.document_id),
      legal_original_sha256: f.binding.legal_original_sha256,
      ...streamParam,
    },
    rowOpts(row, true),
  )
  if (!res.ok) return recordFailure(ctx, row, res.error, f.doc)
  const state = String(res.result.state)
  if (state === "failed") {
    await setState(ctx, row, "failed", { last_error: truncateError(res.result.detail ?? null) })
    await emitOnce(ctx, "transmission_failed", String(row.document_id), {
      document_id: row.document_id,
      number,
      code: "provider_failed",
      reason: JSON.stringify(res.result.detail ?? {}).slice(0, 300),
      resolved: false,
    })
    return { stop: false }
  }
  if (state === "sent") {
    await setState(ctx, row, "sent")
    await refreshStatus(ctx, { ...row, state: "sent" }, "transmit")
    return { stop: false }
  }
  const detail = (res.result.detail ?? null) as Row | null
  if (detail?.unconfirmed === true) {
    // The platform refused a (re-)request but does not show the transmission yet: it may have
    // gone through. Keep it requested and re-read later with a growing delay; never final here.
    const attempts = Number(row.attempts ?? 0) + 1
    await ctx.db.update("einvoice_transmissions", String(row.id), {
      state: "send_requested",
      attempts,
      lease_until: null,
      last_error: truncateError({
        code: "send_unconfirmed",
        message: "The platform has not confirmed the transmission yet; it is re-read.",
        detail,
      }),
      next_attempt_at: new Date(
        Date.now() + Math.min(60_000 * 2 ** Math.min(attempts, 6), 6 * 3600_000),
      ).toISOString(),
    })
    if (row.state !== "send_requested")
      await ctx.db.update("documents", String(row.document_id), {
        einvoice_state: "send_requested",
      })
    return { stop: false }
  }
  if (state !== row.state) await setState(ctx, row, state)
  else await ctx.db.update("einvoice_transmissions", String(row.id), { lease_until: null })
  return { stop: false }
}

// ---------------------------------------------------------------------------------------------
// Lifecycle statuses.

export async function refreshStatus(
  ctx: EinvCtx,
  row: Row,
  source: "webhook" | "catch_up" | "refresh" | "transmit",
): Promise<Row | ReturnType<typeof fail>> {
  // Read through the provider the row went through, even after the organisation switched PA.
  const res = await call(
    ctx,
    "get_einvoice_status",
    { provider_ref: String(row.provider_ref) },
    rowOpts(row),
  )
  if (!res.ok) return fail(res.error.code, res.error.message)
  const s = res.result
  const observed = isLifecycleState(s.mapped) ? (s.mapped as LifecycleState) : null
  const current = isLifecycleState(row.lifecycle_state)
    ? (row.lifecycle_state as LifecycleState)
    : null
  const next = mergeLifecycle(current, observed)
  const log = Array.isArray(row.lifecycle_log) ? [...(row.lifecycle_log as Row[])] : []
  const last = log[log.length - 1]
  const raw = (s.raw as string | null) ?? null
  if (!last || last.raw !== raw || last.mapped !== observed) {
    log.push({
      raw,
      mapped: observed,
      code: observed ? LIFECYCLE_CODE[observed] : null,
      provider_ts: (s.provider_ts as string | null) ?? null,
      observed_at: new Date().toISOString(),
      source,
      reason_text: (s.reason_text as string | null) ?? null,
      ...(observed !== next ? { ignored: "lower than the current state" } : {}),
    })
  }
  const update: Row = { lifecycle_log: log }
  if (next !== current) {
    update.lifecycle_state = next
    update.lifecycle_state_raw = raw
    update.lifecycle_code = next ? LIFECYCLE_CODE[next] : null
    update.lifecycle_reason = (s.reason_text as string | null) ?? null
  }
  await ctx.db.update("einvoice_transmissions", String(row.id), update)
  if (next !== current && next) {
    await ctx.db.update("documents", String(row.document_id), {
      einvoice_state: next,
      einvoice_state_raw: raw,
    })
    if (next === "refused" || next === "rejected") {
      const doc = (
        (await ctx.db.findMany("documents", {
          where: { id: String(row.document_id) },
          limit: 1,
        })) as Row[]
      )[0]
      await emitOnce(ctx, "transmission_refused", String(row.document_id), {
        document_id: row.document_id,
        number: doc?.number ?? null,
        state: next,
        code: LIFECYCLE_CODE[next],
        reason: (s.reason_text as string | null) ?? "no reason given",
        resolved: false,
      })
    }
  }
  return { ...row, ...update }
}

/**
 * Drain the bound provider's status-change inbox (webhooks): re-read each changed deposit, and hand
 * each arrived supplier e-invoice to `onReceived` (the reception flow mirrors it).
 * Acknowledges ONLY what it handled: a ref it re-read, an orphan it recorded, a ref of no send of
 * this app, an arrival `onReceived` took. A ref whose re-read failed, or an arrival `onReceived`
 * threw on, stays pending (delivered again next tick). Each kind is listed on its own, so without
 * `onReceived` received invoices are not even listed, and nothing is lost.
 */
export async function drainStatusChanges(
  ctx: EinvCtx,
  deps: { onReceived?: (ctx: EinvCtx, providerRef: string) => Promise<unknown> } = {},
): Promise<{ refreshed: number; orphans: number; stop: boolean }> {
  let refreshed = 0
  let orphans = 0
  type Item = { provider_ref: string; kind: string; event_type?: string | null; ack?: string }
  // One kind's inbox, acknowledged by item. `handle` answers "handled" (ack it), "kept"
  // (delivered again later) or "stop" (rate limited: ack what was handled, end the drain).
  const drainKind = async (
    kind: "customer_invoice" | "supplier_invoice",
    handle: (it: Item, provider: string | null | undefined) => Promise<"handled" | "kept" | "stop">,
  ): Promise<boolean> => {
    let ack: string[] = []
    const flush = async () => {
      if (ack.length > 0) await call(ctx, "list_status_changes", { cursor: ack.join(","), kind })
      ack = []
    }
    for (let round = 0; round < 5; round++) {
      const res = await call(ctx, "list_status_changes", {
        cursor: ack.length > 0 ? ack.join(",") : null,
        kind,
      })
      ack = []
      if (!res.ok) return res.error.code === "provider_rate_limited"
      const items = (res.result.items ?? []) as Item[]
      for (const it of items) {
        if (it.kind !== kind) continue // not ours to acknowledge
        const outcome = await handle(it, res.provider)
        if (outcome === "stop") {
          await flush()
          return true
        }
        if (outcome === "handled" && typeof it.ack === "string" && it.ack !== "") ack.push(it.ack)
      }
      // Nothing handled this round (nothing pending, or only refs that could not be handled now):
      // stop rather than re-read the same refs again in this tick.
      if (ack.length === 0) break
    }
    await flush()
    return false
  }

  const stopped = await drainKind("customer_invoice", async (it, provider) => {
    // A ref only means something at the provider that issued it: match rows pinned to the
    // provider that answered, never a same-numbered deposit at another PA.
    const rows = (await ctx.db.findMany("einvoice_transmissions", {
      where: {
        provider_ref: String(it.provider_ref),
        ...(provider ? { provider_app: provider } : {}),
      },
      limit: 1,
    })) as Row[]
    const row = rows[0]
    if (!row) {
      const seen = (await ctx.db.findMany("einvoicing_orphan_events", {
        where: { provider_ref: String(it.provider_ref) },
        limit: 1,
      })) as Row[]
      if (seen.length === 0) {
        await ctx.db.insert("einvoicing_orphan_events", {
          provider_ref: String(it.provider_ref),
          kind: it.kind,
          event_type: it.event_type ?? null,
          received_at: new Date().toISOString(),
        })
        await emitOnce(ctx, "orphan_event", String(it.provider_ref), {
          provider_ref: it.provider_ref,
          event_type: it.event_type ?? null,
          resolved: false,
        })
      }
      orphans += 1
      return "handled"
    }
    if (row.action !== "send_einvoice") return "handled"
    const out = await refreshStatus(ctx, row, "webhook")
    if ("status" in out && out.status === "error") {
      return (out as { error: { code: string } }).error.code === "provider_rate_limited"
        ? "stop"
        : "kept"
    }
    refreshed += 1
    return "handled"
  })
  if (stopped) return { refreshed, orphans, stop: true }

  const onReceived = deps.onReceived
  if (onReceived) {
    // A supplier e-invoice arrived: mirror it before its change is acknowledged.
    const stoppedReceived = await drainKind("supplier_invoice", async (it) => {
      try {
        await onReceived(ctx, String(it.provider_ref))
        return "handled"
      } catch {
        return "kept"
      }
    })
    if (stoppedReceived) return { refreshed, orphans, stop: true }
  }
  return { refreshed, orphans, stop: false }
}

// ---------------------------------------------------------------------------------------------
// The job tick.

export interface TransmitTickResult {
  stepped: number
  staged: number
  refreshed: number
  stopped_for_rate_limit: boolean
  skipped?: string
}

async function due(row: Row): Promise<boolean> {
  const at = str(row.next_attempt_at)
  return !at || Date.parse(at) <= Date.now()
}

export async function transmitTick(
  ctx: EinvCtx,
  deps: {
    stepBook?: (ctx: EinvCtx, row: Row) => Promise<StepOutcome>
    afterTick?: (ctx: EinvCtx) => Promise<void>
    onReceived?: (ctx: EinvCtx, providerRef: string) => Promise<unknown>
  } = {},
): Promise<TransmitTickResult> {
  const settings = await readEinvoicingSettings(ctx.db)
  if (!settings.provider_app)
    return {
      stepped: 0,
      staged: 0,
      refreshed: 0,
      stopped_for_rate_limit: false,
      skipped: "no_provider",
    }
  let staged = 0
  // 1) Ask for the send approval of every e-invoice issued since the cut-over that was never
  //    asked for (issue normally stages it; this catches issues that ran where no approval could
  //    be created, e.g. an event handler).
  if (settings.send_enabled && ctx.requestApproval) {
    // Newest first: everything older than the cut-over is never sent, so the walk stops there.
    const never = [
      ...((await ctx.db.findMany("documents", {
        where: { regime: "e_invoice", pdf_status: "ready", einvoice_state: null },
        orderBy: { issued_at: "desc" },
        limit: 100,
      })) as Row[]),
      // Blocked at issue (e.g. a SIREN still to confirm): retried until the data is fixed.
      ...((await ctx.db.findMany("documents", {
        where: { regime: "e_invoice", einvoice_state: "send_blocked" },
        orderBy: { issued_at: "desc" },
        limit: 50,
      })) as Row[]),
    ]
    // A request that expired or was declined is not re-asked automatically: the document panel
    // offers "request the send again" (calm by design: no daily nagging).
    for (const d of never) {
      if (!onOrAfterCutover(d.issued_at, settings.cutover_date)) continue
      if (UNSENDABLE_STATUS.has(String(d.status))) continue
      const prevAt = str(d.einvoice_send_requested_at)
      if (prevAt && Date.now() - Date.parse(prevAt) < RESTAGE_AFTER_MS) continue
      const r = await stageSendApproval(ctx, String(d.id), { onBehalfOf: settings.changed_by })
      if ("approval_id" in r && !r.deduped) staged += 1
      else if (
        !("approval_id" in r) &&
        r.status !== "approver_may_send" &&
        d.einvoice_state !== "send_blocked"
      ) {
        await ctx.db.update("documents", String(d.id), { einvoice_state: "send_blocked" })
      }
      if (staged >= 20) break
    }
  }
  // 2) One provider step per pending row.
  let stepped = 0
  let stopped = false
  const pending: Row[] = []
  for (const state of STEP_STATES) {
    pending.push(
      ...((await ctx.db.findMany("einvoice_transmissions", {
        where: { state, action: "send_einvoice" },
        orderBy: { createdAt: "asc" },
        limit: MAX_ROWS_PER_TICK,
      })) as Row[]),
    )
  }
  if (deps.stepBook) {
    pending.push(
      ...((await ctx.db.findMany("einvoice_transmissions", {
        where: { state: "prepared", action: "book_sale" },
        orderBy: { createdAt: "asc" },
        limit: MAX_ROWS_PER_TICK,
      })) as Row[]),
    )
  }
  for (const row of pending.slice(0, MAX_ROWS_PER_TICK * 2)) {
    if (!(await due(row))) continue
    if (!(await claim(ctx.db, row))) continue
    const out =
      row.action === "book_sale" && deps.stepBook
        ? await deps.stepBook(ctx, row)
        : await stepSend(ctx, row)
    stepped += 1
    if (out.stop) {
      stopped = true
      break
    }
  }
  // 3) Statuses the provider told us about.
  const drained = stopped
    ? { refreshed: 0, stop: true }
    : await drainStatusChanges(ctx, { onReceived: deps.onReceived })
  if (deps.afterTick && !stopped) await deps.afterTick(ctx)
  return {
    stepped,
    staged,
    refreshed: drained.refreshed,
    stopped_for_rate_limit: stopped || drained.stop,
  }
}

/** Catch-up (every 3 h): re-read every transmitted, non-terminal e-invoice. */
export async function statusCatchUp(ctx: EinvCtx): Promise<{ refreshed: number }> {
  const settings = await readEinvoicingSettings(ctx.db)
  if (!settings.provider_app) return { refreshed: 0 }
  let refreshed = 0
  for (const state of ["send_requested", "sent"]) {
    const rows = (await ctx.db.findMany("einvoice_transmissions", {
      where: { state, action: "send_einvoice" },
      limit: 200,
    })) as Row[]
    for (const row of rows) {
      if (
        row.lifecycle_state === "refused" ||
        row.lifecycle_state === "rejected" ||
        row.lifecycle_state === "collected"
      )
        continue
      if (!str(row.provider_ref)) continue
      const out = await refreshStatus(ctx, row, "catch_up")
      if ("status" in out && out.status === "error") {
        if ((out as { error: { code: string } }).error.code === "provider_rate_limited")
          return { refreshed }
        continue
      }
      refreshed += 1
    }
  }
  return { refreshed }
}

/** `einvoice_status_refresh` (read-ish): re-read a document's PA status now. */
export async function einvoiceStatusRefresh(ctx: EinvCtx, params: { document_id?: string }) {
  const id = str(params?.document_id)
  if (!id) return fail("invalid_input", "document_id is required")
  const row = await latestSendRow(ctx.db, id)
  if (!row) return fail("not_transmitted", "This document has no PA transmission yet.")
  if (!str(row.provider_ref))
    return {
      status: "ok",
      document_id: id,
      state: row.state,
      lifecycle_state: row.lifecycle_state ?? null,
    }
  const out = await refreshStatus(ctx, row, "refresh")
  if ("status" in out && out.status === "error") return out
  const r = out as Row
  return {
    status: "ok",
    document_id: id,
    state: r.state,
    lifecycle_state: r.lifecycle_state ?? null,
    lifecycle_code: r.lifecycle_code ?? null,
    reason: r.lifecycle_reason ?? null,
  }
}
