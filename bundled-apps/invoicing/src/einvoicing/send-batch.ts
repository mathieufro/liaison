// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The daily send batch. An e-invoice issued with no person (a month-end run issuing by itself)
// is not staged on its own card: it waits in `awaiting_send_batch`, and once a day the
// `einvoicing-send-daily` job asks for ONE card per organisation listing every such document.
// Approving it (`einvoice_send_batch`, gated, never auto-approved) prepares each send as a
// person's own approval does: one dispatch grant per document, bound to that document and its
// legal original. A rejected or expired card releases its documents for the next day's card.
// A document waiting more than two days raises one Home line, and the card names the oldest.
import {
  type EinvCtx,
  einvoiceSend,
  fail,
  readEinvoicingSettings,
  type SendBinding,
  sendFacts,
} from "./transmit"

type Row = Record<string, unknown>

/** How long a document may wait for the batch before a Home line says so. */
export const WAITING_ALERT_MS = 2 * 24 * 3600 * 1000
const RELEASE_UNANSWERED_MS = 48 * 3600 * 1000
const MAX_DOCUMENTS = 200

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

/** A pending batch whose card was declined, expired or cancelled releases its documents. */
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
  await ctx.db.update("einvoice_send_batches", String(batch.id), {
    state: "released",
    finished_at: new Date().toISOString(),
    skipped: { released: why },
  })
  return true
}

function waitingSince(d: Row): number {
  const t = Date.parse(String(d.einvoice_send_requested_at ?? d.issued_at ?? ""))
  return Number.isFinite(t) ? t : Date.now()
}

/** One Home line, once per document, when the oldest document has waited more than two days. */
async function raiseWaiting(ctx: EinvCtx, oldest: Row): Promise<void> {
  if (Date.now() - waitingSince(oldest) <= WAITING_ALERT_MS || !ctx.emit) return
  const id = String(oldest.id)
  const already = (await ctx.db.findMany("einvoice_send_batches", {
    where: { waiting_alert_document_id: id },
    limit: 1,
  })) as Row[]
  if (already.length > 0) return
  await ctx.emit({
    entity: "einvoicing",
    action: "send_waiting",
    entityId: id,
    data: {
      document_id: id,
      number: oldest.number ?? null,
      since: new Date(waitingSince(oldest)).toISOString().slice(0, 10),
      resolved: false,
    },
  })
  return
}

/** Daily job: one card per organisation listing every document waiting for the batch. */
export async function einvoiceSendDailyJob(
  ctx: EinvCtx,
): Promise<{ status: string; batch_id?: string; documents?: number }> {
  const settings = await readEinvoicingSettings(ctx.db)
  if (!settings.provider_app) return { status: "skipped_no_provider" }
  if (!settings.send_enabled) return { status: "skipped_sending_disabled" }
  const pending = (await ctx.db.findMany("einvoice_send_batches", {
    where: { state: "pending" },
    orderBy: { createdAt: "asc" },
    limit: 50,
  })) as Row[]
  const live: Row[] = []
  for (const b of pending) if (!(await releaseIfDead(ctx, b))) live.push(b)
  // A card still waiting is the day's card: no document is ever on two cards.
  if (live.length > 0) return { status: "batch_pending", batch_id: String(live[0]!.id) }
  const waiting = (await ctx.db.findMany("documents", {
    where: { einvoice_state: "awaiting_send_batch" },
    limit: MAX_DOCUMENTS,
  })) as Row[]
  const items: SendBinding[] = []
  const docs: Row[] = []
  for (const d of waiting) {
    const r = await sendFacts(ctx.db, String(d.id))
    if (!("ok" in r)) continue // not sendable as it stands: readiness says why; it stays waiting
    items.push(r.facts.binding)
    docs.push(d)
  }
  if (docs.length === 0) return { status: "nothing_to_send" }
  const oldest = docs.reduce((a, b) => (waitingSince(b) < waitingSince(a) ? b : a))
  const numbers = docs.map((d) => String(d.number ?? d.id))
  const batch = (await ctx.db.insert("einvoice_send_batches", {
    state: "pending",
    document_ids: docs.map((d) => String(d.id)),
    numbers,
    items,
    provider_app: settings.provider_app,
    requested_at: new Date().toISOString(),
    oldest_waiting_since: new Date(waitingSince(oldest)).toISOString(),
  })) as Row
  await raiseWaiting(ctx, oldest)
  if (Date.now() - waitingSince(oldest) > WAITING_ALERT_MS) {
    await ctx.db.update("einvoice_send_batches", String(batch.id), {
      waiting_alert_document_id: String(oldest.id),
    })
  }
  if (!ctx.requestApproval) return { status: "approval_unavailable", batch_id: String(batch.id) }
  const platform = `${String(settings.provider_app).charAt(0).toUpperCase()}${String(settings.provider_app).slice(1)}`
  const numberLines: string[] = []
  let line = ""
  let listed = 0
  for (const n of numbers) {
    const next = line ? `${line}, ${n}` : n
    if (next.length > 190) {
      numberLines.push(line)
      line = n
    } else line = next
    if (numberLines.length >= 6) break
    listed += 1
  }
  if (line && numberLines.length < 6) numberLines.push(line)
  const rest = numbers.length - listed
  const approval = await ctx.requestApproval({
    tool_name: "invoicing:einvoice_send_batch",
    summary: `Send ${docs.length} e-invoice${docs.length === 1 ? "" : "s"} issued with no person through ${platform}`,
    summary_detail: {
      subtitle:
        "Transmits each Factur-X legal original to its buyer's platform. This cannot be undone.",
      lines: [
        `Oldest waiting: ${String(oldest.number ?? oldest.id)} since ${new Date(waitingSince(oldest)).toISOString().slice(0, 10)}`,
        ...numberLines,
        ...(rest > 0 ? [`and ${rest} more (listed on the batch)`] : []),
      ].slice(0, 8),
    },
    current_payload: { batch_id: String(batch.id) },
    editable_fields: [],
    on_behalf_of: settings.changed_by,
    // Decided by whoever may send the documents, as the batch tool itself requires.
    approve_scope: "invoicing:documents:write",
  })
  if (approval.auto_approved) {
    // A job's request always parks; were it ever granted outright, nothing is sent from here.
    await ctx.db.update("einvoice_send_batches", String(batch.id), {
      state: "released",
      finished_at: new Date().toISOString(),
      skipped: { released: "not a person's decision" },
    })
    return { status: "batch_released", batch_id: String(batch.id) }
  }
  await ctx.db.update("einvoice_send_batches", String(batch.id), {
    approval_request_id: approval.approval_id,
  })
  return { status: "batch_requested", batch_id: String(batch.id), documents: docs.length }
}

/**
 * The approved card: prepare each document's send under its own dispatch grant. A document that
 * changed since the card (its binding drifted) or is no longer sendable is skipped and keeps
 * waiting for the next day's card.
 */
export async function einvoiceSendBatch(ctx: EinvCtx, params: { batch_id?: string }) {
  const id = str(params?.batch_id)
  if (!id) return fail("invalid_input", "batch_id is required")
  const batch = (
    (await ctx.db.findMany("einvoice_send_batches", { where: { id }, limit: 1 })) as Row[]
  )[0]
  if (!batch) return fail("row_not_found", `send batch ${id} not found`)
  if (batch.state !== "pending")
    return {
      status: "ok",
      batch_id: id,
      prepared: 0,
      replay: true,
      message: `Send batch ${id} is ${String(batch.state)}; nothing was prepared again.`,
    }
  let prepared = 0
  const skipped: Array<{ document_id: string; reason: string }> = []
  for (const item of (Array.isArray(batch.items) ? batch.items : []) as SendBinding[]) {
    const out = await einvoiceSend(ctx, item)
    if (out.status === "ok") {
      if (!("replay" in out && out.replay)) prepared += 1
      continue
    }
    const err = (out as { error: { code: string; message: string } }).error
    // Outside a person's decision no grant is minted: the card stays as it was.
    if (err.code === "contract_grant_refused" || err.code === "contracts_unavailable") {
      return fail(
        err.code,
        `Nothing was sent: ${err.message} Send batch ${id} still waits for a person's approval.`,
      )
    }
    skipped.push({ document_id: item.document_id, reason: err.message })
  }
  await ctx.db.update("einvoice_send_batches", id, {
    state: "approved",
    skipped,
    finished_at: new Date().toISOString(),
  })
  return {
    status: "ok",
    batch_id: id,
    prepared,
    skipped,
    message: `Prepared ${prepared} e-invoice send${prepared === 1 ? "" : "s"}; the e-invoicing job transmits them.${skipped.length > 0 ? ` ${skipped.length} changed or cannot be sent and wait for the next card.` : ""}`,
  }
}
