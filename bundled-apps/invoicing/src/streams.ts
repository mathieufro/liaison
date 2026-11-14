// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who issues what. An issuer profile sells in three streams: subscriptions paid by card on Stripe
// (the card stream), recurring invoices paid by transfer, and one-off invoices. The card stream
// exists only while Stripe is connected, and has exactly one issuer: Liaison (each charge gets a
// Liaison invoice) or Stripe (Stripe's invoice is the legal one, Liaison keeps a copy). Until a
// person decides it is `undecided`, and nothing is issued for it. The two other streams are always
// Liaison's and are never billed from Stripe.
//
// A change of issuer is a person's decision (`issuer_stream_set`, gated, never auto-approved). It
// applies to Stripe invoices finalized after the moment it was confirmed: earlier ones keep their
// issuer and their numbers (`issuerAt`).
//
// Stripe's own emails to customers (finalized invoices, credit notes, receipts) cannot be read
// through Stripe's API, so Liaison never says they are off: it asks, until a person states they
// checked, and keeps who and when (`issuer_emails_confirm`).
import { einvoiceStandingOff, standingOf, standingOn, untilDay } from "./einvoicing/standing"
import type { EinvCtx } from "./einvoicing/transmit"
import type { ErrorEnvelope, MutationsCtx } from "./mutations/shared"

type Row = Record<string, unknown>

export type StreamIssuer = "liaison" | "stripe" | "undecided"
export type StreamName = "card" | "transfer" | "one_off"

export interface StreamsCtx {
  db: MutationsCtx["db"]
  getUserId: MutationsCtx["getUserId"]
  approval?: MutationsCtx["approval"] | null
  requestApproval?: MutationsCtx["requestApproval"]
  emit?: MutationsCtx["emit"]
  turn?: { get(): Promise<unknown> }
}

const ENTITY = "stripe_streams"
const fail = (code: string, message: string): ErrorEnvelope => ({
  status: "error",
  error: { code, message },
})

/** A timestamp column read back as an ISO string, whether the store hands text or a Date. */
export function isoOf(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === "string" && v) return new Date(v).toISOString()
  return null
}

/** The issuer a French profile is offered first, and why; others are offered nothing. */
export function suggestedIssuer(profile: Row): { issuer: "liaison"; why: string } | null {
  const country = String(profile.country ?? "").toUpperCase()
  const vat = String(profile.vat_id ?? "")
    .toUpperCase()
    .replace(/\s/g, "")
  if (country === "FR" || vat.startsWith("FR")) {
    return {
      issuer: "liaison",
      why: "French e-invoicing needs each invoice and each payment reported to your platform, which Liaison does for the invoices it issues.",
    }
  }
  return null
}

export async function streamRows(ctx: Pick<StreamsCtx, "db">): Promise<Row[]> {
  return (await ctx.db.findMany(ENTITY, { limit: 100 })) as Row[]
}

/** Whether Stripe is connected as far as invoicing knows (a card stream row says so). */
export async function stripeConnected(ctx: Pick<StreamsCtx, "db">): Promise<boolean> {
  return (await streamRows(ctx)).some((r) => r.stripe_connected === true)
}

/**
 * Who issues the invoice of a Stripe invoice finalized at `finalizedAt`: the issuer before a switch
 * for one finalized before it, else the current one. Null when no card stream exists.
 */
export function issuerAt(stream: Row | null, finalizedAt: string): StreamIssuer | null {
  if (!stream) return null
  const switched = isoOf(stream.switched_at)
  if (switched && finalizedAt < switched && typeof stream.previous_issuer === "string") {
    return stream.previous_issuer as StreamIssuer
  }
  return (stream.issuer as StreamIssuer) ?? "undecided"
}

/**
 * The one `external_ref` a document made from a Stripe payment takes: its invoice's id when the
 * charge belongs to an invoice, the charge's own id only when it has none. A payment invoiced by
 * hand and the finalized event of the same invoice then collide on the unique key, so one charge
 * never yields two documents.
 */
export function stripeDocumentRef(charge: { id: string; invoice?: string | null }): string {
  return charge.invoice ? `stripe:${charge.invoice}` : `stripe:${charge.id}`
}

/** Every issuer profile gets its card stream row once Stripe connects, undecided until a person picks. */
export async function ensureCardStreams(ctx: StreamsCtx, connected: boolean): Promise<Row[]> {
  const profiles = (await ctx.db.findMany("issuer_profiles", { limit: 100 })) as Row[]
  const rows = await streamRows(ctx)
  const fresh: Row[] = []
  for (const p of profiles) {
    if (p.archived_at) continue
    const row = rows.find((r) => r.issuer_profile_id === p.id)
    if (row) {
      if (row.stripe_connected !== connected)
        await ctx.db.update(ENTITY, String(row.id), { stripe_connected: connected })
      continue
    }
    if (!connected) continue
    try {
      const created = (await ctx.db.insert(ENTITY, {
        issuer_profile_id: p.id,
        issuer: "undecided",
        stripe_connected: true,
      })) as Row
      fresh.push({ ...created, issuer_profile_id: p.id, issuer: "undecided", profile: p })
    } catch {
      // A concurrent delivery created it first (unique per issuer profile).
    }
  }
  return fresh
}

/**
 * The issuer card: a person decides who issues card payments' invoices. A French profile has
 * Liaison pre-selected with the reason; another has nothing selected. Parks as a gated
 * `issuer_stream_set` that a person decides; never auto-approved.
 */
export async function stageIssuerCard(ctx: StreamsCtx, profile: Row): Promise<string | null> {
  if (!ctx.requestApproval) return null
  const pick = suggestedIssuer(profile)
  const name = String(profile.legal_name ?? profile.id)
  const approval = await ctx.requestApproval({
    tool_name: "invoicing:issuer_stream_set",
    summary: `Who issues the invoices of ${name}'s card subscriptions on Stripe?`,
    summary_detail: {
      subtitle: pick ? "Liaison is pre-selected" : "Nothing is pre-selected: pick one",
      lines: [
        "Liaison: a legal invoice from Liaison for each charge, in your series; Stripe only takes the payment.",
        "Stripe: Stripe's invoice is the legal one; Liaison keeps a copy marked Issued by Stripe.",
        ...(pick ? [`Why Liaison: ${pick.why}`] : []),
        "Nothing is issued for card payments until this is decided. Check the choice with your accountant.",
      ],
    },
    current_payload: {
      issuerProfileId: String(profile.id),
      ...(pick ? { issuer: pick.issuer } : {}),
    },
    editable_fields: ["issuer"],
  })
  const id = approval.approval_id ?? null
  return id
}

export interface StripeEmails {
  state: "unknown" | "confirmed"
  confirmedBy: string | null
  confirmedAt: string | null
}

export function stripeEmailsOf(row: Row | null): StripeEmails {
  const by = typeof row?.emails_confirmed_by === "string" ? row.emails_confirmed_by : null
  const at = isoOf(row?.emails_confirmed_at)
  return by && at
    ? { state: "confirmed", confirmedBy: by, confirmedAt: at }
    : { state: "unknown", confirmedBy: null, confirmedAt: null }
}

/** One issuer profile's streams, as `issuer_stream_get` returns them and the settings section shows. */
/** A stream's standing e-invoice authorization as the settings section shows it: who, when, until. */
export interface StandingView {
  on: boolean
  turnedOnBy: string | null
  turnedOnAt: string | null
  until: string | null
}

const STANDING_OFF: StandingView = { on: false, turnedOnBy: null, turnedOnAt: null, until: null }

function standingView(row: Row | null): StandingView {
  if (!row) return STANDING_OFF
  return {
    on: true,
    turnedOnBy: typeof row.turned_on_by === "string" ? row.turned_on_by : null,
    turnedOnAt: isoOf(row.turned_on_at),
    until: untilDay(row) || null,
  }
}

export function streamsOf(
  profile: Row,
  card: Row | null,
  standing: { card?: Row | null; transfer?: Row | null } = {},
) {
  const cardStream =
    card && card.stripe_connected === true
      ? [
          {
            stream: "card" as const,
            issuer: (card.issuer as StreamIssuer) ?? "undecided",
            decidedBy: typeof card.decided_by === "string" ? card.decided_by : null,
            decidedAt: isoOf(card.decided_at),
            previousIssuer: typeof card.previous_issuer === "string" ? card.previous_issuer : null,
            switchedAt: isoOf(card.switched_at),
            suggested: suggestedIssuer(profile),
            standing: standingView(standing.card ?? null),
          },
        ]
      : []
  return {
    issuerProfileId: String(profile.id),
    name: String(profile.legal_name ?? ""),
    country: typeof profile.country === "string" ? profile.country : null,
    streams: [
      ...cardStream,
      {
        stream: "transfer" as const,
        issuer: "liaison" as const,
        notBilledFromStripe: true,
        standing: standingView(standing.transfer ?? null),
      },
      { stream: "one_off" as const, issuer: "liaison" as const, notBilledFromStripe: true },
    ],
    stripe_emails: cardStream.length > 0 ? stripeEmailsOf(card) : null,
  }
}

export async function issuerStreamGet(ctx: StreamsCtx, input: { issuerProfileId?: string } = {}) {
  const profiles = ((await ctx.db.findMany("issuer_profiles", { limit: 100 })) as Row[]).filter(
    (p) => !p.archived_at && (!input.issuerProfileId || p.id === input.issuerProfileId),
  )
  if (input.issuerProfileId && profiles.length === 0) {
    return fail(
      "issuer_not_found",
      `No issuer profile ${input.issuerProfileId}. List them with settings_issuer_profile_list.`,
    )
  }
  const rows = await streamRows(ctx)
  const einv = ctx as unknown as EinvCtx
  const out = await Promise.all(
    profiles.map(async (p) =>
      streamsOf(p, rows.find((r) => r.issuer_profile_id === p.id) ?? null, {
        card: await standingOf(einv, String(p.id), "card"),
        transfer: await standingOf(einv, String(p.id), "transfer"),
      }),
    ),
  )
  const connected = out.some((o) => o.streams.some((s) => s.stream === "card"))
  return {
    status: "completed" as const,
    issuers: out,
    stripeConnected: connected,
    summary: connected
      ? `${out.length} issuer profile${out.length === 1 ? "" : "s"}. Card subscriptions on Stripe have one issuer each; recurring by transfer and one-off invoices are always Liaison's.`
      : "Stripe is not connected: recurring by transfer and one-off invoices are Liaison's, and nothing is billed from Stripe.",
  }
}

/** Who issues card payments' invoices for the org, for the Stripe app's refunds (hidden tool). */
export async function cardStreamIssuer(ctx: Pick<StreamsCtx, "db">) {
  const rows = (await streamRows(ctx)).filter((r) => r.stripe_connected === true)
  const issuer = rows.some((r) => r.issuer === "liaison")
    ? "liaison"
    : rows.some((r) => r.issuer === "stripe")
      ? "stripe"
      : rows.length
        ? "undecided"
        : null
  return { issuer }
}

async function decider(ctx: StreamsCtx): Promise<string> {
  return ctx.approval?.approvalDeciderId ?? (await ctx.getUserId())
}

async function actingAgent(ctx: StreamsCtx): Promise<string | null> {
  try {
    const raw: unknown = ctx.turn ? await ctx.turn.get() : null
    const t = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
      agentId?: string | null
    } | null
    return t?.agentId ?? null
  } catch {
    // An unreadable turn is treated as an agent's: the person still decides.
    return "unknown"
  }
}

/** Invoices made from Stripe payments that are still unpaid: what a switch leaves behind. */
async function unpaidStripeDocuments(ctx: StreamsCtx, issuerProfileId: string): Promise<number> {
  const rows = (await ctx.db.findMany("documents", {
    where: {
      issuer_profile_id: issuerProfileId,
      type: "invoice",
      payment_status: { in: ["unpaid", "partial"] },
    },
    limit: 500,
  })) as Row[]
  return rows.filter(
    (d) => typeof d.external_ref === "string" && d.external_ref.startsWith("stripe:"),
  ).length
}

/** The profile and its connected card stream, or why there is none. Read-only. */
async function cardStreamOf(
  ctx: StreamsCtx,
  issuerProfileId: string,
): Promise<{ profile: Row; row: Row } | ErrorEnvelope> {
  const profile = (await ctx.db.findOne("issuer_profiles", issuerProfileId)) as Row | null
  if (!profile)
    return fail("issuer_not_found", `No issuer profile ${issuerProfileId}; nothing was changed.`)
  const row = (await streamRows(ctx)).find((r) => r.issuer_profile_id === issuerProfileId) ?? null
  if (!row || row.stripe_connected !== true) {
    return fail(
      "card_stream_not_connected",
      `Stripe is not connected, so ${String(profile.legal_name ?? issuerProfileId)} has no card stream; nothing was changed. Connect Stripe first.`,
    )
  }
  return { profile, row }
}

/** Stage-time check of issuer_stream_set: a card stream exists to decide. The pick itself is the person's, on the card. */
export async function issuerStreamSetPreflight(
  ctx: StreamsCtx,
  input: { issuerProfileId: string; stream?: string; issuer?: string; einvoiceStanding?: boolean },
) {
  if (typeof input.einvoiceStanding === "boolean" && input.issuer === undefined) {
    if (input.stream !== "card" && input.stream !== "transfer") {
      return fail(
        "stream_not_authorizable",
        "A standing e-invoice authorization is for the card or transfer stream; one-off invoices always have a person at issue. Nothing was staged.",
      )
    }
    const profile = await ctx.db.findOne("issuer_profiles", input.issuerProfileId)
    return profile
      ? { ok: true }
      : fail("issuer_not_found", `No issuer profile ${input.issuerProfileId}; nothing was staged.`)
  }
  if (input.stream && input.stream !== "card") {
    return fail(
      "stream_not_choosable",
      "Only card subscriptions on Stripe have a choice of issuer; transfer and one-off invoices are always Liaison's. Nothing was staged.",
    )
  }
  const found = await cardStreamOf(ctx, input.issuerProfileId)
  return "status" in found ? found : { ok: true }
}

/** Stage-time check of issuer_emails_confirm: a card stream exists to confirm. */
export async function issuerEmailsConfirmPreflight(
  ctx: StreamsCtx,
  input: { issuerProfileId: string },
) {
  const found = await cardStreamOf(ctx, input.issuerProfileId)
  return "status" in found ? found : { ok: true }
}

export async function issuerStreamSet(
  ctx: StreamsCtx,
  input: { issuerProfileId: string; stream?: string; issuer?: string; einvoiceStanding?: boolean },
) {
  if (typeof input.einvoiceStanding === "boolean" && input.issuer === undefined)
    return standingSet(ctx, input)
  if (input.stream && input.stream !== "card") {
    return fail(
      "stream_not_choosable",
      `The ${input.stream === "one_off" ? "one-off" : "transfer"} stream is always issued by Liaison and is never billed from Stripe, so nothing was changed. Only card subscriptions on Stripe have a choice.`,
    )
  }
  if (input.issuer !== "liaison" && input.issuer !== "stripe") {
    return fail(
      "issuer_required",
      "Pick who issues the invoices of card subscriptions, liaison or stripe; nothing was changed. Ask the person, and check the choice with their accountant.",
    )
  }
  const found = await cardStreamOf(ctx, input.issuerProfileId)
  if ("status" in found) return found
  const { profile, row } = found
  const by = await decider(ctx)
  const now = new Date().toISOString()
  const before = (row.issuer as StreamIssuer) ?? "undecided"
  if (before === input.issuer) {
    return {
      status: "completed" as const,
      issuer: before,
      effectiveAt: isoOf(row.decided_at),
      ...(await cardStanding(ctx, input.issuerProfileId)),
      summary: `${String(profile.legal_name)}'s card subscriptions were already issued by ${before === "liaison" ? "Liaison" : "Stripe"}; nothing changed.`,
    }
  }
  const switching = before !== "undecided"
  await ctx.db.update(ENTITY, String(row.id), {
    issuer: input.issuer,
    decided_by: by,
    decided_at: now,
    ...(switching ? { previous_issuer: before, switched_at: now } : {}),
  })
  const unpaid = switching ? await unpaidStripeDocuments(ctx, input.issuerProfileId) : 0
  if (unpaid > 0 && ctx.emit) {
    await ctx.emit({
      entity: "stripe_stream",
      action: "switched",
      entityId: String(row.id),
      data: {
        issuer_profile_id: input.issuerProfileId,
        issuer: input.issuer,
        previous: before,
        unpaid,
      },
    })
  }
  const who = input.issuer === "liaison" ? "Liaison" : "Stripe"
  return {
    status: "completed" as const,
    issuer: input.issuer,
    effectiveAt: now,
    ...(await cardStanding(ctx, input.issuerProfileId)),
    summary: switching
      ? `${who} now issues the invoices of ${String(profile.legal_name)}'s card subscriptions finalized from ${now}. Invoices issued before keep their issuer and numbers${unpaid > 0 ? `; ${unpaid} of them are unpaid and an alert names them` : ""}. Check the change with your accountant.`
      : `${who} issues the invoices of ${String(profile.legal_name)}'s card subscriptions from ${now}.`,
  }
}

/** The card stream's standing e-invoice authorization, as issuer_stream_set reports it. */
async function cardStanding(
  ctx: StreamsCtx,
  issuerProfileId: string,
): Promise<{ einvoiceStanding: boolean; standingUntil: string | null }> {
  const live = await standingOf(ctx as unknown as EinvCtx, issuerProfileId, "card")
  return { einvoiceStanding: live !== null, standingUntil: live ? untilDay(live) : null }
}

/**
 * The standing e-invoice authorization of the card or transfer stream (einvoicing/standing.ts).
 * On: only inside a person's approval, which mints the stream's grant. Off: at once.
 */
async function standingSet(
  ctx: StreamsCtx,
  input: { issuerProfileId: string; stream?: string; einvoiceStanding?: boolean },
) {
  const stream = input.stream
  if (stream !== "card" && stream !== "transfer") {
    return fail(
      "stream_not_authorizable",
      "A standing e-invoice authorization is for the card or transfer stream; one-off invoices always have a person at issue. Nothing was changed.",
    )
  }
  const profile = (await ctx.db.findOne("issuer_profiles", input.issuerProfileId)) as Row | null
  if (!profile)
    return fail(
      "issuer_not_found",
      `No issuer profile ${input.issuerProfileId}; nothing was changed.`,
    )
  const einv = ctx as unknown as EinvCtx
  if (input.einvoiceStanding === false)
    return einvoiceStandingOff(einv, { issuerProfileId: input.issuerProfileId, stream })
  const on = await standingOn(einv, input.issuerProfileId, stream)
  if (!("ok" in on)) return on
  const live = await standingOf(einv, input.issuerProfileId, stream)
  const label = stream === "card" ? "card subscriptions" : "recurring by transfer"
  return {
    status: "completed" as const,
    issuer:
      stream === "card"
        ? (((await streamRows(ctx)).find((r) => r.issuer_profile_id === input.issuerProfileId)
            ?.issuer as StreamIssuer | undefined) ?? "undecided")
        : "liaison",
    effectiveAt: isoOf(live?.turned_on_at),
    einvoiceStanding: true,
    standingUntil: on.until,
    summary: `E-invoices of ${String(profile.legal_name)}'s ${label} issued with no person are now sent at issue, with no card, until ${on.until}. A renewal card comes a week before; turn it off at any time.`,
  }
}

/**
 * A person states that Stripe's own emails to customers are off. Only a person's own click records
 * it; an agent's call waits for a person, since Liaison cannot read the setting and the statement
 * is the person's.
 */
export async function issuerEmailsConfirm(ctx: StreamsCtx, input: { issuerProfileId: string }) {
  const found = await cardStreamOf(ctx, input.issuerProfileId)
  if ("status" in found) return found
  const { row } = found
  if (!ctx.approval && (await actingAgent(ctx)) !== null) {
    const approval = ctx.requestApproval
      ? await ctx.requestApproval({
          tool_name: "invoicing:issuer_emails_confirm",
          summary: "Confirm that Stripe's emails to customers are off",
          summary_detail: {
            subtitle: "An agent asked; only a person who checked in Stripe can say so",
            lines: [
              "In Stripe, Settings, Billing: finalized invoices, credit notes and payment receipts should not email customers.",
              "Liaison cannot read this setting. Approve only if you checked it.",
            ],
          },
          current_payload: { issuerProfileId: input.issuerProfileId },
        })
      : null
    return {
      status: "pending_approval" as const,
      approval_id: approval?.approval_id ?? null,
      message:
        "Nothing was recorded: only a person who checked Stripe's settings can confirm the emails are off, so this waits for them.",
    }
  }
  const by = await decider(ctx)
  const at = new Date().toISOString()
  await ctx.db.update(ENTITY, String(row.id), { emails_confirmed_by: by, emails_confirmed_at: at })
  return {
    status: "completed" as const,
    confirmedAt: at,
    confirmedBy: by,
    summary: `Recorded that Stripe's emails to customers are off, stated by ${by} at ${at}. Liaison cannot read this setting, so check again if someone changes it.`,
  }
}

/** Stripe connected or disconnected (its `connection:state_changed`): card streams follow, and a new one asks its issuer. */
export async function onStripeConnectionChanged(ctx: StreamsCtx, event: { data?: unknown }) {
  const data = (event?.data ?? {}) as { to?: unknown }
  const to = typeof data.to === "string" ? data.to : ""
  const base = to.split("+")[0] ?? ""
  // Stored key onwards counts as connected for the guard: the mirror says itself when it cannot answer.
  const connected = base !== "" && base !== "not_connected"
  const fresh = await ensureCardStreams(ctx, connected)
  for (const row of fresh) {
    const approvalId = await stageIssuerCard(ctx, row.profile as Row)
    if (approvalId) await ctx.db.update(ENTITY, String(row.id), { approval_request_id: approvalId })
  }
  return { ok: true, connected, created: fresh.length }
}
