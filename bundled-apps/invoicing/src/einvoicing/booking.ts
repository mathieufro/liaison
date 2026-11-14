// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Booking reported sales (B2C, exports, intra-EU, non-registered buyers, internal cancellations)
// in the bound PA provider's ledger as ordinary customer invoices: never transmitted, the legal
// original attached. Only from the cut-over date and only while `book_enabled` is on.
//
// Batched under ONE approval a day: the daily job gathers the eligible documents into a batch and
// asks for its approval (count, totals per regime, the document numbers); approving it prepares
// one booking row per document (idempotency key per document); the transmit job books them one
// by one; once the batch is done an attention summary lists what was booked and what failed.
// A recurring invariant check re-reads booked invoices: one that shows an e-invoicing status
// (the provider transmitted something that must only be reported) raises a high-priority item
// and switches booking off.
import type { BookingData, BookingLine } from "@liaison/app-sdk/contracts"
import {
  type EinvCtx,
  fail,
  idempotencyKey,
  mintDispatchGrant,
  onOrAfterCutover,
  readEinvoicingSettings,
  type StepOutcome,
} from "./transmit"

type Row = Record<string, unknown>

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

const BOOKABLE_REGIMES = new Set(["e_reporting"])
const UNBOOKABLE_STATUS = new Set(["draft", "pending_approval", "voided", "cancelled"])

export function bookable(doc: Row, cutover: string | null): string | null {
  if (doc.type !== "invoice" && doc.type !== "credit_note")
    return `a ${String(doc.type)} is not booked`
  if (UNBOOKABLE_STATUS.has(String(doc.status))) return `the document is ${String(doc.status)}`
  if (!(BOOKABLE_REGIMES.has(String(doc.regime)) || doc.internal_cancellation === true)) {
    return `regime ${String(doc.regime ?? "unknown")} is not booked (only reported sales are)`
  }
  if (!onOrAfterCutover(doc.issued_at, cutover)) return "issued before the cut-over date"
  if (!str(doc.legal_original_id) || !str(doc.legal_original_sha256)) return "no legal original"
  return null
}

async function candidates(ctx: EinvCtx, cutover: string | null): Promise<Row[]> {
  const out: Row[] = []
  const seen = new Set<string>()
  const pushAll = async (where: Record<string, unknown>) => {
    // Newest first: everything older than the cut-over is never booked, so the walk stops there.
    const rows = (await ctx.db.findMany("documents", {
      where,
      orderBy: { issued_at: "desc" },
      limit: 500,
    })) as Row[]
    for (const d of rows) {
      if (!onOrAfterCutover(d.issued_at, cutover)) break
      if (seen.has(String(d.id))) continue
      seen.add(String(d.id))
      out.push(d)
    }
  }
  await pushAll({ regime: "e_reporting", einvoice_state: null })
  await pushAll({ internal_cancellation: true, einvoice_state: null })
  return out.filter((d) => bookable(d, cutover) === null)
}

function money(minor: number, currency: string): string {
  const v = (minor / 100).toFixed(2)
  return `${v} ${currency}`
}

const RELEASE_UNANSWERED_MS = 48 * 3600 * 1000

/**
 * A pending batch whose approval was declined, expired or cancelled will never be approved: it is
 * released (state `released`) so its documents go into the next batch. One whose approval cannot
 * be read back, or that never got one, is released once it is well past the approval's lifetime.
 */
async function releaseIfDead(ctx: EinvCtx, batch: Row): Promise<boolean> {
  const approvalId = str(batch.approval_request_id)
  let dead = false
  let why = ""
  if (approvalId && ctx.approvals?.statusOf) {
    let raw: unknown = await ctx.approvals.statusOf(approvalId)
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw)
      } catch {
        raw = null
      }
    }
    const st = (raw ?? {}) as { status?: string | null; expired?: boolean }
    if (
      st.status === "denied" ||
      st.status === "expired" ||
      st.status === "cancelled" ||
      (st.status === "pending" && st.expired === true)
    ) {
      dead = true
      why = st.status === "pending" ? "expired" : String(st.status)
    } else if (st.status === null || st.status === undefined) {
      const at = Date.parse(String(batch.requested_at ?? ""))
      dead = Number.isFinite(at) && Date.now() - at > RELEASE_UNANSWERED_MS
      why = "approval not found"
    }
  } else {
    const at = Date.parse(String(batch.requested_at ?? ""))
    dead = Number.isFinite(at) && Date.now() - at > RELEASE_UNANSWERED_MS
    why = approvalId ? "approval status unavailable" : "no approval was created"
  }
  if (!dead) return false
  await ctx.db.update("einvoice_book_batches", String(batch.id), {
    state: "released",
    finished_at: new Date().toISOString(),
    skipped: { released: why },
  })
  return true
}

/** Daily job: one batch, one approval request. */
export async function bookDailyJob(
  ctx: EinvCtx,
): Promise<{ status: string; batch_id?: string; documents?: number }> {
  const settings = await readEinvoicingSettings(ctx.db)
  if (!settings.provider_app) return { status: "skipped_no_provider" }
  if (!settings.book_enabled) return { status: "skipped_booking_disabled" }
  // Every pending batch (not one at random): a declined or expired one releases its documents;
  // the documents of every batch still awaiting its approval stay out of a new one, so no
  // document is ever on two approval cards.
  const inPending = new Set<string>()
  const pending = (await ctx.db.findMany("einvoice_book_batches", {
    where: { state: "pending" },
    orderBy: { createdAt: "asc" },
    limit: 200,
  })) as Row[]
  for (const b of pending) {
    if (await releaseIfDead(ctx, b)) continue
    for (const id of Array.isArray(b.document_ids) ? (b.document_ids as string[]) : [])
      inPending.add(String(id))
  }
  const docs = (await candidates(ctx, settings.cutover_date)).filter(
    (d) => !inPending.has(String(d.id)),
  )
  if (docs.length === 0) return { status: "nothing_to_book" }
  const totals: Record<string, Record<string, number>> = {}
  for (const d of docs) {
    const regime = d.internal_cancellation === true ? "internal_cancellation" : String(d.regime)
    const cur = String(d.currency ?? "EUR")
    const sign = d.type === "credit_note" ? -1 : 1
    totals[regime] ??= {}
    totals[regime]![cur] = (totals[regime]![cur] ?? 0) + sign * Number(d.grand_total_minor ?? 0)
  }
  const numbers = docs.map((d) => String(d.number ?? d.id))
  const batch = (await ctx.db.insert("einvoice_book_batches", {
    state: "pending",
    document_ids: docs.map((d) => String(d.id)),
    numbers,
    totals,
    provider_app: settings.provider_app,
    requested_at: new Date().toISOString(),
  })) as Row
  if (!ctx.requestApproval) return { status: "approval_unavailable", batch_id: String(batch.id) }
  const totalLines = Object.entries(totals).map(
    ([regime, byCur]) =>
      `${regime === "e_reporting" ? "Reported sales" : "Internal cancellations"}: ${Object.entries(
        byCur,
      )
        .map(([c, m]) => money(m, c))
        .join(", ")}`,
  )
  // The card holds 8 lines of 200 characters: the numbers fill what the totals leave.
  const numberLines: string[] = []
  let line = ""
  let listed = 0
  for (const n of numbers) {
    const next = line ? `${line}, ${n}` : n
    if (next.length > 190) {
      numberLines.push(line)
      line = n
    } else line = next
    if (numberLines.length >= 7 - totalLines.length) break
    listed += 1
  }
  if (line && numberLines.length < 7 - totalLines.length) numberLines.push(line)
  const rest = numbers.length - listed
  const approval = await ctx.requestApproval({
    tool_name: "invoicing:einvoice_book_batch",
    summary: `Book ${docs.length} reported sale${docs.length === 1 ? "" : "s"} in ${String(settings.provider_app).charAt(0).toUpperCase()}${String(settings.provider_app).slice(1)}`,
    summary_detail: {
      subtitle: "Ledger entries only: nothing is transmitted to any customer.",
      lines: [
        ...totalLines,
        ...numberLines,
        ...(rest > 0 ? [`and ${rest} more (listed on the batch)`] : []),
      ].slice(0, 8),
    },
    current_payload: { batch_id: String(batch.id) },
    editable_fields: [],
    on_behalf_of: settings.changed_by,
  })
  // A job's request always parks; should it ever be granted outright, book the batch now rather
  // than leave it pending on an approval that does not exist.
  if (approval.auto_approved) {
    await einvoiceBookBatch(ctx, { batch_id: String(batch.id) })
    return { status: "batch_booked", batch_id: String(batch.id), documents: docs.length }
  }
  await ctx.db.update("einvoice_book_batches", String(batch.id), {
    approval_request_id: approval.approval_id,
  })
  return { status: "batch_requested", batch_id: String(batch.id), documents: docs.length }
}

/** The approved batch: prepare one booking row per document still bookable. */
export async function einvoiceBookBatch(ctx: EinvCtx, params: { batch_id?: string }) {
  const id = str(params?.batch_id)
  if (!id) return fail("invalid_input", "batch_id is required")
  const batch = (
    (await ctx.db.findMany("einvoice_book_batches", { where: { id }, limit: 1 })) as Row[]
  )[0]
  if (!batch) return fail("row_not_found", `batch ${id} not found`)
  if (batch.state !== "pending") return { status: "ok", batch_id: id, prepared: 0, replay: true }
  const settings = await readEinvoicingSettings(ctx.db)
  if (!settings.book_enabled || !settings.provider_app) {
    await ctx.db.update("einvoice_book_batches", id, { state: "cancelled" })
    return fail(
      "booking_disabled",
      "Booking is switched off (or no provider is configured); nothing was booked.",
    )
  }
  let prepared = 0
  const skipped: Array<{ document_id: string; reason: string }> = []
  for (const docId of (batch.document_ids as string[]) ?? []) {
    const doc = (
      (await ctx.db.findMany("documents", { where: { id: docId }, limit: 1 })) as Row[]
    )[0]
    const why = doc ? bookable(doc, settings.cutover_date) : "not found"
    if (why) {
      skipped.push({ document_id: docId, reason: why })
      continue
    }
    const key = idempotencyKey(docId, "book_sale", String(doc!.legal_original_sha256))
    const existing = (
      (await ctx.db.findMany("einvoice_transmissions", {
        where: { idempotency_key: key },
        limit: 1,
      })) as Row[]
    )[0]
    if (existing) continue
    // The approval of the batch, made portable for the booking job (one grant per document).
    const granted = await mintDispatchGrant(ctx, ["book_sale"], {
      document_ref: docId,
      legal_original_sha256: String(doc!.legal_original_sha256),
      idempotency_key: key,
    })
    if (!("ok" in granted)) {
      skipped.push({ document_id: docId, reason: granted.error.message })
      continue
    }
    await ctx.db.insert("einvoice_transmissions", {
      document_id: docId,
      action: "book_sale",
      idempotency_key: key,
      provider_app: settings.provider_app,
      state: "prepared",
      approval_request_id: ctx.approval?.approvalRequestId ?? null,
      approved_by: ctx.approval?.approvalDeciderId ?? null,
      approval_method: ctx.approval ? "approval" : "direct_click",
      approval_snapshot: { batch_id: id, legal_original_sha256: doc!.legal_original_sha256 },
      dispatch_grant: granted.grant,
      batch_id: id,
      attempts: 0,
      lifecycle_log: [],
    })
    await ctx.db.update("documents", docId, {
      einvoice_state: "booking_prepared",
      pa_provider: settings.provider_app,
    })
    prepared += 1
  }
  await ctx.db.update("einvoice_book_batches", id, { state: "approved", skipped })
  return { status: "ok", batch_id: id, prepared, skipped }
}

/** Booking data the provider needs, from the stored document (amounts signed for a credit note). */
export async function bookingData(ctx: EinvCtx, doc: Row): Promise<BookingData> {
  const lines = (await ctx.db.findMany("document_lines", {
    where: { document_id: String(doc.id) },
    orderBy: { position: "asc" },
    limit: 500,
  })) as Row[]
  const sign = doc.type === "credit_note" ? -1 : 1
  const treatment = String(doc.tax_treatment ?? "unconfigured")
  const original = str(doc.original_document_id)
  let credit_of: BookingData["credit_of"] = null
  if (original) {
    const o = (
      (await ctx.db.findMany("documents", { where: { id: original }, limit: 1 })) as Row[]
    )[0]
    // The original's deposit at the platform (the latest attempt that reached it).
    const ot = (
      (await ctx.db.findMany("einvoice_transmissions", {
        where: { document_id: original },
        limit: 50,
      })) as Row[]
    )
      .filter((r) => str(r.provider_ref))
      .sort((a, b) => Number(b.attempt ?? 1) - Number(a.attempt ?? 1))[0]
    credit_of = { invoice_number: String(o?.number ?? ""), provider_ref: str(ot?.provider_ref) }
  }
  const kind = String(doc.customer_kind ?? "individual") as BookingData["customer"]["kind"]
  const name = str(doc.buyer_legal_name) ?? str(doc.counterparty_name) ?? "Customer"
  const country = (
    str(doc.billing_country_code) ??
    str(doc.counterparty_country) ??
    "FR"
  ).toUpperCase()
  return {
    invoice_number: String(doc.number),
    issue_date: String(doc.issued_at ?? "").slice(0, 10),
    due_date: String(doc.due_at ?? doc.issued_at ?? "").slice(0, 10),
    currency: String(doc.currency ?? "EUR"),
    fx_rate: str(doc.fx_rate),
    subtotal_minor: sign * Number(doc.subtotal_minor ?? 0),
    tax_minor: sign * Number(doc.tax_total_minor ?? 0),
    total_minor: sign * Number(doc.grand_total_minor ?? 0),
    credit_of,
    customer: {
      contact_ref: str(doc.counterparty_contact_id),
      kind,
      legal_name: name,
      vat_id: str(doc.counterparty_vat_id),
      country_code: country,
      address: {
        line1: str(doc.billing_line1) ?? str(doc.counterparty_address)?.split("\n")[0] ?? "-",
        line2: str(doc.billing_line2),
        postcode: str(doc.billing_postcode) ?? "-",
        city: str(doc.billing_city) ?? "-",
        country_code: country,
      },
    },
    lines: lines.map(
      (l): BookingLine => ({
        label: String(l.description ?? "Item"),
        quantity: String(l.quantity ?? "1"),
        unit_price_minor: sign * Number(l.unit_price_minor ?? 0),
        subtotal_minor: sign * Number(l.subtotal_minor ?? 0),
        tax_minor: sign * Number(l.tax_minor ?? 0),
        tax_rate_bp: Number(l.tax_rate_bp ?? 0),
        tax_treatment: treatment,
        operation_category:
          l.line_kind === "service" || l.line_kind === "software" ? "services" : "goods",
        rate_is_placeholder: false,
        destination_country: country,
      }),
    ),
  }
}

/** One booking step (called by the transmit job for a prepared `book_sale` row). */
export async function stepBook(ctx: EinvCtx, row: Row): Promise<StepOutcome> {
  const doc = (
    (await ctx.db.findMany("documents", {
      where: { id: String(row.document_id) },
      limit: 1,
    })) as Row[]
  )[0]
  const settings = await readEinvoicingSettings(ctx.db)
  const why = doc ? bookable(doc, settings.cutover_date) : "not found"
  const failRow = async (code: string, message: string, retryable = false) => {
    await ctx.db.update("einvoice_transmissions", String(row.id), {
      state: retryable ? "prepared" : "failed",
      last_error: { code, message },
      lease_until: null,
      attempts: Number(row.attempts ?? 0) + 1,
      next_attempt_at: retryable ? new Date(Date.now() + 10 * 60_000).toISOString() : null,
    })
    if (!retryable && doc)
      await ctx.db.update("documents", String(doc.id), { einvoice_state: "booking_failed" })
    return { stop: code === "provider_rate_limited" }
  }
  if (!settings.book_enabled)
    return failRow("booking_disabled", "Booking was switched off before this row was booked.", true)
  if (why) return failRow("not_bookable", why)
  const lo = (
    (await ctx.db.findMany("legal_originals", {
      where: { id: String(doc!.legal_original_id) },
      limit: 1,
    })) as Row[]
  )[0]
  if (!lo?.file_id) return failRow("legal_original_missing", "The legal original file is missing.")
  if (!ctx.contracts)
    return failRow("contracts_unavailable", "contract dispatch is not available here", true)
  const env = await ctx.contracts.call(
    "einvoicing-pa@1",
    "book_sale",
    {
      document_ref: String(doc!.id),
      pdf_file_id: String(lo.file_id),
      legal_original_sha256: String(lo.sha256),
      data: (await bookingData(ctx, doc!)) as unknown as Record<string, unknown>,
      idempotency_key: String(row.idempotency_key),
    },
    { grant: str(row.dispatch_grant), provider: str(row.provider_app) },
  )
  const result = env.status === "completed" ? (env.result as Row) : null
  const err =
    env.status === "error"
      ? env.error
      : result?.status === "error"
        ? (result.error as { code: string; message: string; retryable?: boolean })
        : null
  if (err) {
    if (err.code === "vat_rate_unmappable" && ctx.emit) {
      await ctx.emit({
        entity: "einvoicing",
        action: "booking_failed",
        entityId: String(doc!.id),
        data: {
          document_id: doc!.id,
          number: doc!.number,
          code: err.code,
          reason: err.message,
          resolved: false,
        },
      })
    }
    return failRow(err.code, err.message, err.retryable === true)
  }
  await ctx.db.update("einvoice_transmissions", String(row.id), {
    state: "booked",
    provider_ref: String(result!.provider_ref),
    lease_until: null,
    last_error: null,
    next_attempt_at: null,
  })
  await ctx.db.update("documents", String(doc!.id), {
    einvoice_state: "booked",
    pa_provider: settings.provider_app,
  })
  return { stop: false }
}

/** After a tick: summarise every approved batch whose rows are all done. */
export async function summariseBatches(ctx: EinvCtx): Promise<number> {
  const batches = (await ctx.db.findMany("einvoice_book_batches", {
    where: { state: "approved" },
    limit: 20,
  })) as Row[]
  let done = 0
  for (const b of batches) {
    const rows = (await ctx.db.findMany("einvoice_transmissions", {
      where: { batch_id: String(b.id) },
      limit: 1000,
    })) as Row[]
    if (rows.some((r) => r.state === "prepared")) continue
    const booked = rows.filter((r) => r.state === "booked")
    const failed = rows.filter((r) => r.state === "failed")
    const numberOf = async (docId: unknown) =>
      String(
        (
          (await ctx.db.findMany("documents", { where: { id: String(docId) }, limit: 1 })) as Row[]
        )[0]?.number ?? docId,
      )
    const failedNumbers = await Promise.all(failed.map((r) => numberOf(r.document_id)))
    await ctx.db.update("einvoice_book_batches", String(b.id), {
      state: "done",
      booked: booked.length,
      failed: failed.length,
      finished_at: new Date().toISOString(),
    })
    if (ctx.emit) {
      await ctx.emit({
        entity: "einvoicing",
        action: "booking_summary",
        entityId: String(b.id),
        data: {
          batch_id: b.id,
          booked: booked.length,
          failed: failed.length,
          failed_numbers: failedNumbers.join(", ") || "none",
          provider: b.provider_app ?? null,
        },
      })
    }
    done += 1
  }
  return done
}

/** Invariant (every 3 h): a booked invoice must never carry an e-invoicing status. */
export async function bookingInvariantJob(
  ctx: EinvCtx,
): Promise<{ checked: number; breaches: number }> {
  const settings = await readEinvoicingSettings(ctx.db)
  if (!settings.provider_app || !ctx.contracts) return { checked: 0, breaches: 0 }
  const rows = (await ctx.db.findMany("einvoice_transmissions", {
    where: { state: "booked", action: "book_sale" },
    orderBy: { createdAt: "desc" },
    limit: 200,
  })) as Row[]
  let checked = 0
  let breaches = 0
  for (const row of rows) {
    if (!str(row.provider_ref)) continue
    // Through the provider the sale was booked with: after a switch of PA, a ref of the old one is
    // never read at (nor attributed to) the new one.
    const env = await ctx.contracts.call(
      "einvoicing-pa@1",
      "get_einvoice_status",
      { provider_ref: String(row.provider_ref) },
      { provider: str(row.provider_app) },
    )
    if (env.status === "error") {
      if (env.error.code === "provider_rate_limited") break
      continue
    }
    const s = env.result as Row
    if (s.status === "error") continue
    checked += 1
    if (s.e_invoicing === true || (s.raw !== null && s.raw !== undefined)) {
      breaches += 1
      await ctx.db.update("einvoice_transmissions", String(row.id), {
        lifecycle_state_raw: (s.raw as string | null) ?? null,
        last_error: {
          code: "booked_but_einvoiced",
          message: "The provider shows an e-invoicing status on a booked (reported) sale.",
        },
      })
      if (settings.id)
        await ctx.db.update("einvoicing_settings", settings.id, {
          book_enabled: false,
          changed_by: "system:booking-invariant",
        })
      const doc = (
        (await ctx.db.findMany("documents", {
          where: { id: String(row.document_id) },
          limit: 1,
        })) as Row[]
      )[0]
      if (ctx.emit) {
        await ctx.emit({
          entity: "einvoicing",
          action: "booking_invariant_breach",
          entityId: String(row.document_id),
          data: {
            document_id: row.document_id,
            number: doc?.number ?? null,
            raw: s.raw ?? null,
            resolved: false,
          },
        })
      }
    }
  }
  return { checked, breaches }
}
