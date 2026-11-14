// SPDX-License-Identifier: FSL-1.1-ALv2
// `einvoice_transmission_get` (read only): what the document panel and the agent show about one
// document's e-invoicing transmission or booking.
import { documentStream } from "./standing"
import {
  attemptOf,
  type EinvCtx,
  fail,
  readEinvoicingSettings,
  sendFacts,
  TERMINAL_SEND_FAILURES,
} from "./transmit"

type Row = Record<string, unknown>

export async function einvoiceTransmissionGet(ctx: EinvCtx, params: { document_id?: string }) {
  const id = typeof params?.document_id === "string" ? params.document_id.trim() : ""
  if (!id) return fail("invalid_input", "document_id is required")
  const doc = ((await ctx.db.findMany("documents", { where: { id }, limit: 1 })) as Row[])[0]
  if (!doc) return fail("row_not_found", `document ${id} not found`)
  const rows = (await ctx.db.findMany("einvoice_transmissions", {
    where: { document_id: id },
    orderBy: { createdAt: "asc" },
    limit: 20,
  })) as Row[]
  // Attempts are appended: the latest send attempt is the one that stands.
  const sends = rows
    .filter((r) => r.action === "send_einvoice")
    .sort((a, b) => attemptOf(a) - attemptOf(b))
  const latestSend = sends[sends.length - 1] ?? null
  const retry = latestSend !== null && TERMINAL_SEND_FAILURES.has(String(latestSend.state))
  const settings = await readEinvoicingSettings(ctx.db)
  // What a send would bind, for the confirmation (registry identity next to the contact), or why
  // it cannot be sent: for an e-invoice not yet transmitted, or whose last attempt failed for good
  // (a retry is a new attempt, bound to its number).
  let send_preview: Row | null = null
  let send_blocked: string | null = null
  if (doc.regime === "e_invoice" && (!latestSend || retry)) {
    const f = await sendFacts(ctx.db, id)
    if ("ok" in f) {
      const reg = (f.facts.identity?.registry_name as string | null | undefined) ?? null
      const contact = (doc.counterparty_name as string | null) ?? null
      send_preview = {
        binding: {
          ...f.facts.binding,
          ...(latestSend ? { attempt: attemptOf(latestSend) + 1 } : {}),
        },
        registry_name: reg ?? doc.buyer_legal_name ?? null,
        registry_city:
          (f.facts.identity?.registry_city as string | null | undefined) ??
          doc.billing_city ??
          null,
        contact_name: contact,
        name_mismatch: Boolean(
          reg &&
            contact &&
            !reg.toUpperCase().includes(contact.toUpperCase().split(/\s+/)[0] ?? ""),
        ),
      }
    } else {
      send_blocked = f.error.message
    }
  }
  return {
    status: "ok",
    document_id: id,
    number: doc.number ?? null,
    regime: doc.regime ?? null,
    einvoice_state: doc.einvoice_state ?? null,
    // The collection report and payment, for the document's e-invoicing status word, and the
    // stream it came from (card payments on Stripe or a recurring schedule).
    collection_state: doc.collection_state ?? null,
    payment_status: doc.payment_status ?? null,
    stream: documentStream(doc),
    send_approval_id: doc.einvoice_send_approval_id ?? null,
    send_requested_at: doc.einvoice_send_requested_at ?? null,
    provider_app: settings.provider_app,
    send_enabled: settings.send_enabled,
    cutover_date: settings.cutover_date,
    send_preview,
    send_blocked,
    transmissions: rows.map((r) => ({
      id: r.id,
      action: r.action,
      attempt: attemptOf(r),
      state: r.state,
      provider_app: r.provider_app,
      provider_ref: r.provider_ref ?? null,
      lifecycle_state: r.lifecycle_state ?? null,
      lifecycle_code: r.lifecycle_code ?? null,
      lifecycle_reason: r.lifecycle_reason ?? null,
      lifecycle_log: Array.isArray(r.lifecycle_log) ? r.lifecycle_log : [],
      approval_method: r.approval_method ?? null,
      approved_by: r.approved_by ?? null,
      last_error: r.last_error ?? null,
      created_at: r.created_at ?? null,
    })),
  }
}

/** `einvoicing_settings_get` (read only): the e-invoicing settings, the installed providers of the
 *  contract, and the bound provider's registration (emission activated, webhook). */
export async function einvoicingSettingsGet(
  ctx: EinvCtx & { contracts?: EinvCtx["contracts"] & { providers?(c: string): Promise<unknown> } },
) {
  const settings = await readEinvoicingSettings(ctx.db)
  let providers: string[] = []
  if (ctx.contracts?.providers) {
    const raw = await ctx.contracts.providers("einvoicing-pa@1")
    providers = (typeof raw === "string" ? JSON.parse(raw) : raw) as string[]
  }
  let registration: Row | null = null
  if (settings.provider_app && ctx.contracts) {
    const env = await ctx.contracts.call("einvoicing-pa@1", "registration_status", {})
    registration =
      env.status === "completed" ? (env.result as Row) : { status: "error", error: env.error }
  }
  // `rows`: the settings and the bound provider's registration status as `key`/`value` rows, the
  // list a dashboard block reads (`providers` stays the list of installed providers).
  const rows: Array<{ key: string; value: string | boolean | null }> = [
    { key: "provider_app", value: settings.provider_app },
    { key: "cutover_date", value: settings.cutover_date },
    { key: "send_enabled", value: settings.send_enabled },
    { key: "book_enabled", value: settings.book_enabled },
    {
      key: "registration_status",
      value: typeof registration?.status === "string" ? registration.status : null,
    },
  ]
  return { status: "ok", settings, providers, registration, rows }
}

/** `einvoicing_settings_values` (read only, the settings page's own): the four e-invoicing fields
 *  of the settings page, in the shape `einvoicing_settings_set` takes back. */
export async function einvoicingSettingsValues(ctx: Pick<EinvCtx, "db">): Promise<{
  provider_app: string | null
  cutover_date: string | null
  send_enabled: boolean
  book_enabled: boolean
}> {
  const s = await readEinvoicingSettings(ctx.db)
  return {
    provider_app: s.provider_app,
    cutover_date: s.cutover_date,
    send_enabled: s.send_enabled,
    book_enabled: s.book_enabled,
  }
}

/** `einvoicing_provider_options` (read only, the settings page's own): the installed apps that
 *  implement e-invoicing (einvoicing-pa@1), as the platform field's choices. */
export async function einvoicingProviderOptions(
  ctx: EinvCtx & { contracts?: EinvCtx["contracts"] & { providers?(c: string): Promise<unknown> } },
): Promise<{ options: Array<{ value: string; label: string }> }> {
  if (!ctx.contracts?.providers) return { options: [] }
  const raw = await ctx.contracts.providers("einvoicing-pa@1")
  const list = (typeof raw === "string" ? JSON.parse(raw) : raw) as unknown
  const names = Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : []
  return { options: names.map((p) => ({ value: p, label: p })) }
}
