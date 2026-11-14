// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The standing e-invoice authorization of a stream (card subscriptions, or recurring by
// transfer), off by default. A person turns it on through `issuer_stream_set {einvoiceStanding:
// true}`, gated and never auto-approved: its approved re-entry mints ONE dispatch grant whose
// subject is the stream (`stream_ref = <issuer profile>:<stream>`), recorded with who and when.
// On that stream an e-invoice issued with no person is prepared at issue under that grant, with
// no card. `stream_ref` is computed only from the document's stored issuer profile and source,
// never from a caller's input, and the send refuses `stream_mismatch` when the two differ.
//
// The grant lasts 90 days (the kernel's grant lifetime): the daily job asks the person who turned
// it on to renew a week before, and on lapse the stream goes back to the daily batch, said once on
// Home. Turning it off narrows only, so a holder of the settings scope does it at once.
import {
  attemptOf,
  type EinvCtx,
  fail,
  idempotencyKey,
  latestSendRow,
  mintDispatchGrant,
  readEinvoicingSettings,
  sendFacts,
  TERMINAL_SEND_FAILURES,
} from "./transmit"

type Row = Record<string, unknown>
const ENTITY = "einvoice_standing"
const DAY_MS = 24 * 3600 * 1000
/** The kernel's dispatch grant lifetime (`GRANT_TTL_MS`). */
export const STANDING_DAYS = 90
/** The renewal card goes out this many days before the end. */
export const RENEW_DAYS_BEFORE = 7

export type StandingStream = "card" | "transfer"

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

/** The stream a document belongs to, from its stored source: Stripe payments or a recurring schedule. */
export function documentStream(doc: Row): StandingStream | null {
  const ref = str(doc.external_ref) ?? ""
  if (ref.startsWith("stripe:")) return "card"
  const refs = (doc.external_refs ?? {}) as Row
  if (ref.startsWith("recurring:") || typeof refs.recurring_schedule_id === "string")
    return "transfer"
  return null
}

export function streamRef(issuerProfileId: string, stream: StandingStream): string {
  return `${issuerProfileId}:${stream}`
}

/** The document's stream reference, from its stored issuer profile and source only. */
export function documentStreamRef(doc: Row): string | null {
  const issuer = str(doc.issuer_profile_id)
  const stream = documentStream(doc)
  return issuer && stream ? streamRef(issuer, stream) : null
}

/** When a standing authorization ends (its grant's expiry, an instant), as epoch ms. */
function untilOf(row: Row): number {
  const t = row.until instanceof Date ? row.until.getTime() : Date.parse(String(row.until ?? ""))
  return Number.isFinite(t) ? t : 0
}

/** The day a standing authorization ends, `YYYY-MM-DD` (UTC). */
export function untilDay(row: Row): string {
  const t = untilOf(row)
  return t > 0 ? new Date(t).toISOString().slice(0, 10) : ""
}

/** The live standing authorization of a stream, or null when it is off, revoked or lapsed. */
export async function standingOf(
  ctx: Pick<EinvCtx, "db">,
  issuerProfileId: string,
  stream: StandingStream,
): Promise<Row | null> {
  const rows = (await ctx.db.findMany(ENTITY, {
    where: { issuer_profile_id: issuerProfileId, stream },
    limit: 1,
  })) as Row[]
  const row = rows[0]
  if (!row || row.ended_at || !str(row.grant_ref) || Date.now() >= untilOf(row)) return null
  return row
}

async function deciderOf(ctx: EinvCtx): Promise<string | null> {
  return ctx.approval?.approvalDeciderId ?? (ctx.getUserId ? await ctx.getUserId() : null)
}

/** Turn the standing authorization on (inside a person's approval only: the grant says so). */
export async function standingOn(ctx: EinvCtx, issuerProfileId: string, stream: StandingStream) {
  const granted = await mintDispatchGrant(ctx, ["submit_einvoice", "advance_einvoice"], {
    stream_ref: streamRef(issuerProfileId, stream),
  })
  if (!("ok" in granted)) {
    // No platform bound: say so in the settings' own words, never the contract's id.
    if (granted.error.code === "contract_provider_not_configured") {
      return fail(
        "einvoicing_platform_not_set",
        "The standing e-invoice authorization was not turned on and nothing was recorded: no e-invoicing platform is set. Choose one in Settings, Invoicing, E-invoicing, then turn it on.",
      )
    }
    return fail(
      granted.error.code,
      `The standing e-invoice authorization was not turned on and nothing was recorded: ${granted.error.message}. Only a person's approval turns it on.`,
    )
  }
  const by = await deciderOf(ctx)
  const now = new Date()
  // A little before the grant itself expires, so a send never meets an expired grant.
  const until = new Date(now.getTime() + STANDING_DAYS * DAY_MS - 3600_000).toISOString()
  const data: Row = {
    turned_on_by: by,
    turned_on_at: now.toISOString(),
    grant_ref: granted.grant,
    until,
    ended_at: null,
    ended_by: null,
    renewal_requested_at: null,
  }
  const existing = (
    (await ctx.db.findMany(ENTITY, {
      where: { issuer_profile_id: issuerProfileId, stream },
      limit: 1,
    })) as Row[]
  )[0]
  if (existing) await ctx.db.update(ENTITY, String(existing.id), data)
  else await ctx.db.insert(ENTITY, { issuer_profile_id: issuerProfileId, stream, ...data })
  return { ok: true as const, until: until.slice(0, 10), by }
}

/**
 * `einvoice_standing_off`: turn a stream's standing authorization off, at once (it only narrows).
 * The next document issued with no person on that stream waits for the daily batch.
 */
export async function einvoiceStandingOff(
  ctx: EinvCtx,
  input: { issuerProfileId?: string; stream?: string },
) {
  const issuerProfileId = str(input?.issuerProfileId)
  const stream = input?.stream
  if (!issuerProfileId || (stream !== "card" && stream !== "transfer")) {
    return fail(
      "invalid_input",
      "Give issuerProfileId and stream (card or transfer); nothing was changed.",
    )
  }
  const row = (
    (await ctx.db.findMany(ENTITY, {
      where: { issuer_profile_id: issuerProfileId, stream },
      limit: 1,
    })) as Row[]
  )[0]
  if (!row || row.ended_at) {
    return {
      status: "completed" as const,
      einvoiceStanding: false,
      standingUntil: null,
      summary: `The ${stream} stream had no standing e-invoice authorization; nothing changed.`,
    }
  }
  const by = ctx.getUserId ? await ctx.getUserId() : null
  await ctx.db.update(ENTITY, String(row.id), {
    ended_at: new Date().toISOString(),
    ended_by: by,
    ended_reason: "revoked",
  })
  return {
    status: "completed" as const,
    einvoiceStanding: false,
    standingUntil: null,
    summary: `The standing e-invoice authorization of the ${stream} stream is off. E-invoices issued with no person on it now wait for the daily send card.`,
  }
}

/**
 * Prepare the send of a document issued with no person under its stream's standing grant. Null
 * when the stream has none (the caller sends it to the batch).
 */
export async function prepareStandingSend(
  ctx: EinvCtx,
  documentId: string,
): Promise<{ transmission_id: string } | null> {
  const doc = (
    (await ctx.db.findMany("documents", { where: { id: documentId }, limit: 1 })) as Row[]
  )[0]
  if (!doc) return null
  const stream = documentStream(doc)
  const issuer = str(doc.issuer_profile_id)
  if (!stream || !issuer) return null
  const standing = await standingOf(ctx, issuer, stream)
  if (!standing) return null
  const r = await sendFacts(ctx.db, documentId)
  if (!("ok" in r)) return null
  const settings = await readEinvoicingSettings(ctx.db)
  if (!settings.provider_app) return null
  const latest = await latestSendRow(ctx.db, documentId)
  if (latest && !TERMINAL_SEND_FAILURES.has(String(latest.state))) return null
  const attempt = latest ? attemptOf(latest) + 1 : 1
  const key = idempotencyKey(
    documentId,
    "send_einvoice",
    r.facts.binding.legal_original_sha256,
    attempt,
  )
  const inserted = (await ctx.db.insert("einvoice_transmissions", {
    document_id: documentId,
    action: "send_einvoice",
    idempotency_key: key,
    attempt,
    provider_app: settings.provider_app,
    state: "prepared",
    approval_request_id: null,
    approved_by: str(standing.turned_on_by),
    approval_method: "standing",
    approval_snapshot: { ...r.facts.binding },
    dispatch_grant: String(standing.grant_ref),
    stream_ref: streamRef(issuer, stream),
    attempts: 0,
    lifecycle_log: [],
  })) as Row
  const log = (Array.isArray(doc.lifecycle_log) ? doc.lifecycle_log : []) as Row[]
  await ctx.db.update("documents", documentId, {
    einvoice_state: "prepared",
    pa_provider: settings.provider_app,
    lifecycle_log: [
      ...log,
      {
        event: "einvoice_send_standing",
        actor: "einvoicing",
        ts: new Date().toISOString(),
        authorized_by: str(standing.turned_on_by),
        authorized_at: standing.turned_on_at ?? null,
        stream,
      },
    ],
  })
  return { transmission_id: String(inserted.id) }
}

/** Daily: one renewal card a week before the end, and a lapse back to the batch at the end. */
export async function einvoiceStandingDailyJob(
  ctx: EinvCtx,
): Promise<{ status: "ok"; renewals: number; lapsed: number }> {
  const rows = (await ctx.db.findMany(ENTITY, { where: { ended_at: null }, limit: 200 })) as Row[]
  const settings = await readEinvoicingSettings(ctx.db)
  let renewals = 0
  let lapsed = 0
  for (const row of rows) {
    if (!str(row.grant_ref)) continue
    const end = untilOf(row)
    const stream = String(row.stream)
    if (Date.now() >= end) {
      await ctx.db.update(ENTITY, String(row.id), {
        ended_at: new Date().toISOString(),
        ended_reason: "lapsed",
      })
      lapsed += 1
      if (ctx.emit) {
        await ctx.emit({
          entity: "einvoicing",
          action: "standing_lapsed",
          entityId: String(row.id),
          data: {
            issuer_profile_id: row.issuer_profile_id,
            stream,
            until: untilDay(row),
            resolved: false,
          },
        })
      }
      continue
    }
    if (
      row.renewal_requested_at ||
      Date.now() < end - RENEW_DAYS_BEFORE * DAY_MS ||
      !ctx.requestApproval
    )
      continue
    const approval = await ctx.requestApproval({
      tool_name: "invoicing:issuer_stream_set",
      summary: `Renew the standing e-invoice authorization of the ${stream === "card" ? "card subscriptions" : "recurring by transfer"} stream`,
      summary_detail: {
        subtitle: `It ends on ${untilDay(row)}. Renewed, e-invoices issued with no person on this stream keep being sent at issue for 90 more days; otherwise they wait for the daily send card.`,
      },
      current_payload: {
        issuerProfileId: String(row.issuer_profile_id),
        stream,
        einvoiceStanding: true,
      },
      editable_fields: [],
      on_behalf_of: str(row.turned_on_by) ?? settings.changed_by,
      // The deciders of the e-invoicing settings, whoever turned it on and whether or not they
      // are still here: the card is filed under that person, decided by the settings scope.
      approve_scope: "invoicing:settings:write",
    })
    if (approval.auto_approved) continue
    await ctx.db.update(ENTITY, String(row.id), { renewal_requested_at: new Date().toISOString() })
    renewals += 1
  }
  return { status: "ok", renewals, lapsed }
}
