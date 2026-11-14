// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Stripe invoice finalized while Liaison issues the invoices of card payments (mode A): one
// Liaison invoice per Stripe invoice, keyed `external_ref = stripe:<in_id>` (unique), in the
// issuer's own series, dated the day the number is taken in the issuer's time zone (never
// `finalized_at`, so a late event never moves a legal date or year).
//
// Steps, in order, each one stopping or parking with its reason:
//   1. a document already carries the key, or the payment was already invoiced by hand: stop;
//   2. the card stream: Stripe issues, stop; nobody decided yet, park until a person decides;
//   3. finalized before Stripe was connected: stop;
//   4. a zero total: stop; a negative total: park for a person;
//   5. issuer profile missing: park awaiting_config; buyer's email or address missing: awaiting_data;
//   6. Stripe's tax per line against Liaison's, more than 1 minor unit apart: park for review;
//   7. the e-invoicing gate refuses: park on the buyer's identity;
//   8. above the issuer's approval threshold: a person approves first (the payload waits parked);
//   9. issue, due on the issue date, paid already when Stripe says so; link the Stripe invoice.
//
// The typed payload is the Stripe app's `invoice:finalized` (and `invoice:paid`): minor units as
// strings across the JSON bridge, as the Shopify order payload is.
import { park, resolveOpenParks } from "../deferred"
import {
  EINVOICE_IDENTITY_PARK_KIND,
  GATE_CODES,
  type GateCode,
  raiseIdentityAttention,
} from "../einvoicing/gate"
import { checkEinvoiceGate } from "../einvoicing/issue-gate"
import type { Counterparty, DraftLine } from "../issue"
import { civilDateOf, issueDateParts } from "../issue-date"
import { lineAmounts, lineTax } from "../money"
import { findIssuerProfile } from "../mutations/db-helpers"
import { issueWithFxRate } from "../mutations/fx-issue"
import { type ErrorEnvelope, type MutationsCtx, toBigInt } from "../mutations/shared"
import { isoOf, issuerAt, type StreamIssuer, streamRows } from "../streams"

type Row = Record<string, unknown>

export interface StripeInvoiceLine {
  description?: string | null
  quantity?: number | string | null
  /** Unit price before tax, minor units. */
  unit_amount_excl_minor?: string | number | null
  /** Line amount as Stripe states it (used when the unit price before tax is absent). */
  amount_minor?: string | number | null
  discount_minor?: string | number | null
  tax_rate_bp?: number | null
  /** Tax Stripe charged on the line, minor units. Absent: the line is not judged. */
  tax_minor?: string | number | null
  period_start?: string | null
  period_end?: string | null
  product_name?: string | null
}

export interface StripeInvoicePayload {
  stripe_invoice_id: string
  customer_id?: string | null
  subscription_id?: string | null
  contact_id?: string | null
  number?: string | null
  status?: string | null
  total_minor: string | number
  tax_minor?: string | number | null
  currency: string
  period_start?: string | null
  period_end?: string | null
  finalized_at?: string | null
  paid_at?: string | null
  charge_id?: string | null
  billing_reason?: string | null
  next_payment_attempt?: string | null
  failure_code?: string | null
  customer?: {
    name?: string | null
    email?: string | null
    country?: string | null
    address?: string | null
    vat_id?: string | null
  } | null
  lines?: StripeInvoiceLine[]
}

export type StripeCtx = MutationsCtx & {
  resolveContact?(params: { email?: string; name?: string; externalId?: string }): Promise<unknown>
}

export type FinalizedResult =
  | { status: "ok"; document_id: string; number: string }
  | { status: "skipped"; reason: string; document_id?: string }
  | { status: "deferred"; deferred_id: string; reason: string }
  | { status: "pending_approval"; approval_id: string | null }
  | { status: "error"; error: ErrorEnvelope["error"] }

/** Parks of this flow carry `blocked_on.kind` starting with this, so the retry sweep routes them here. */
export const STRIPE_PARK_PREFIX = "stripe_"
export const STRIPE_INVOICE_PARK = "stripe_invoice"
export const STRIPE_UNDECIDED_PARK = "stripe_issuer_undecided"
export const STRIPE_APPROVAL_PARK = "stripe_invoice_approval"
export const STRIPE_TAX_PARK = "tax_check"

export const stripeRef = (id: string) => `stripe:${id}`

/** The event's payload: the kernel delivers `{entity, action, data}`, a direct call the payload. */
export function payloadOf<T>(event: unknown): T {
  const e = (event ?? {}) as { data?: unknown }
  return (e.data && typeof e.data === "object" ? e.data : event) as T
}

export async function documentByRef(
  ctx: Pick<MutationsCtx, "db">,
  ref: string,
): Promise<Row | null> {
  const rows = (await ctx.db.findMany("documents", {
    where: { external_ref: ref },
    limit: 1,
  })) as Row[]
  return rows[0] ?? null
}

/** The connected card stream that issues a Stripe invoice finalized at `at`, and the issuer it names. */
export async function cardStreamFor(
  ctx: Pick<MutationsCtx, "db">,
  at: string,
): Promise<{ row: Row; issuer: StreamIssuer } | null> {
  const rows = (await streamRows(ctx)).filter((r) => r.stripe_connected === true)
  if (rows.length === 0) return null
  const named = rows.map((row) => ({ row, issuer: issuerAt(row, at) ?? "undecided" }))
  // Several issuer profiles: the one that issues decides; none issues, the first undecided waits.
  return (
    named.find((n) => n.issuer === "liaison") ??
    named.find((n) => n.issuer === "stripe") ??
    named[0] ??
    null
  )
}

const money = (minor: bigint, currency: string) =>
  `${(Number(minor) / 100).toFixed(2)} ${currency.toUpperCase()}`

function parkPayload(p: StripeInvoicePayload): StripeInvoicePayload & { kind: "stripe_invoice" } {
  return { ...p, kind: "stripe_invoice" }
}

async function parkInvoice(
  ctx: StripeCtx,
  p: StripeInvoicePayload,
  status: "awaiting_config" | "awaiting_data" | "awaiting_dependency",
  reason: string,
  kind: string,
  extra: Row = {},
): Promise<{ id: string; created: boolean }> {
  return park(
    { db: ctx.db },
    {
      event_id: stripeRef(p.stripe_invoice_id),
      event_payload_json: parkPayload(p),
      status,
      reason,
      blocked_on: { kind, stripe_invoice_id: p.stripe_invoice_id, ...extra },
    },
  )
}

async function raise(ctx: StripeCtx, action: string, entityId: string, data: Row): Promise<void> {
  if (ctx.emit)
    await ctx.emit({
      entity: "stripe_invoice",
      action,
      entityId,
      data: { ...data, resolved: false },
    })
}

export interface TaxMismatch {
  position: number
  description: string
  tax_rate_bp: number
  computed_minor: string
  stripe_minor: string
}

/** Net of a Stripe line before tax: quantity times the unit price before tax, less the discount. */
function lineNet(l: StripeInvoiceLine): { qty: bigint; unit: bigint; discount: bigint } {
  const qty = BigInt(Math.max(1, Math.round(Number(l.quantity ?? 1)) || 1))
  const discount = toBigInt(l.discount_minor ?? 0)
  if (l.unit_amount_excl_minor != null && l.unit_amount_excl_minor !== "") {
    return { qty, unit: toBigInt(l.unit_amount_excl_minor), discount }
  }
  // Only the line amount is known: the unit price is that amount over the quantity.
  return { qty, unit: toBigInt(l.amount_minor ?? 0) / qty, discount }
}

/**
 * Stripe's tax per line against Liaison's, computed half to even from the line's net at its rate.
 * More than 1 minor unit apart on any line: that line is listed. Lines without Stripe's figure or
 * rate are not judged.
 */
export function stripeTaxMismatches(lines: StripeInvoiceLine[]): TaxMismatch[] {
  const out: TaxMismatch[] = []
  for (const [i, l] of lines.entries()) {
    if (typeof l.tax_rate_bp !== "number" || l.tax_minor == null || l.tax_minor === "") continue
    const { qty, unit, discount } = lineNet(l)
    const computed = lineTax({ subtotal_minor: qty * unit - discount, tax_rate_bp: l.tax_rate_bp })
    const charged = toBigInt(l.tax_minor)
    const diff = computed > charged ? computed - charged : charged - computed
    if (diff > 1n) {
      out.push({
        position: i + 1,
        description: String(l.description ?? ""),
        tax_rate_bp: l.tax_rate_bp,
        computed_minor: computed.toString(),
        stripe_minor: charged.toString(),
      })
    }
  }
  return out
}

/**
 * What the Liaison invoice of these lines totals, computed as issuing computes it (one rounding
 * per line), or null when a line's rate is not known (several taxes on one line).
 */
export function liaisonTotalOf(lines: StripeInvoiceLine[]): bigint | null {
  let total = 0n
  for (const l of lines) {
    if (typeof l.tax_rate_bp !== "number") return null
    const { qty, unit, discount } = lineNet(l)
    total += lineAmounts(
      { quantity: qty.toString(), unit_price_minor: unit, discount_minor: discount },
      l.tax_rate_bp,
    ).total_minor
  }
  return total
}

/** The lines of the Liaison invoice: Stripe's own, at the rate Stripe charged, the period in the description. */
export function invoiceLines(p: StripeInvoicePayload): DraftLine[] {
  return (p.lines ?? []).map((l, i) => {
    const { qty, unit, discount } = lineNet(l)
    const start = (l.period_start ?? p.period_start ?? "").slice(0, 10)
    const end = (l.period_end ?? p.period_end ?? "").slice(0, 10)
    const base = String(l.description ?? l.product_name ?? "Subscription").trim() || "Subscription"
    return {
      position: i + 1,
      description: start && end && !base.includes(start) ? `${base} (${start} to ${end})` : base,
      quantity: qty.toString(),
      unit_price_minor: unit,
      ...(discount > 0n ? { discount_minor: discount } : {}),
      line_kind: "service",
      ...(typeof l.tax_rate_bp === "number" ? { tax_rate_bp_override: l.tax_rate_bp } : {}),
      product_source: null,
      external_id: null,
    }
  })
}

/** The buyer as Stripe names them, linked to a kernel contact by email; null fields stay null. */
async function counterpartyOf(
  ctx: StripeCtx,
  p: StripeInvoicePayload,
  issuerCountry: string,
): Promise<Counterparty> {
  const c = p.customer ?? {}
  const email = typeof c.email === "string" && c.email.includes("@") ? c.email.trim() : null
  let contactId = typeof p.contact_id === "string" && p.contact_id ? p.contact_id : null
  if (!contactId && email && ctx.resolveContact) {
    try {
      const resolved = (await ctx.resolveContact({
        email,
        ...(c.name ? { name: c.name } : {}),
        ...(p.customer_id ? { externalId: `stripe:${p.customer_id}` } : {}),
      })) as { id?: unknown; contactId?: unknown } | null
      const id = resolved?.id ?? resolved?.contactId
      contactId = typeof id === "string" ? id : null
    } catch {
      contactId = null
    }
  }
  const vat = typeof c.vat_id === "string" && c.vat_id.trim() ? c.vat_id.trim() : null
  return {
    contact_id: contactId,
    legal_name: String(c.name ?? email ?? "").trim(),
    country: String(c.country ?? issuerCountry).toUpperCase(),
    vat_id: vat,
    address: typeof c.address === "string" && c.address.trim() ? c.address.trim() : null,
    email,
    customer_kind: vat ? "business" : "individual",
  }
}

export interface FinalizedOptions {
  /** A person decided this invoice (issue-now click, or the approval of the threshold card). */
  byPerson?: boolean
}

/**
 * Issue the Liaison invoice of one finalized Stripe invoice, or say why not. Idempotent: the
 * unique key stops a replay, a re-emit and a second worker; a concurrent second issue rolls back
 * with its transaction and takes no number.
 */
export async function onStripeInvoiceFinalized(
  event: unknown,
  ctx: StripeCtx,
  opts: FinalizedOptions = {},
): Promise<FinalizedResult> {
  const p = payloadOf<StripeInvoicePayload>(event)
  if (!p || typeof p.stripe_invoice_id !== "string" || !p.stripe_invoice_id) {
    return { status: "skipped", reason: "invalid_payload" }
  }
  const ref = stripeRef(p.stripe_invoice_id)

  // 1. One document per Stripe invoice, and one per charge: the charge invoiced by hand before
  //    this event names the same invoice key (stripeDocumentRef).
  const existing = await documentByRef(ctx, ref)
  if (existing) {
    await linkBack(
      ctx,
      p.stripe_invoice_id,
      String(existing.id),
      typeof existing.number === "string" ? existing.number : null,
    )
    await resolveOpenParks(ctx, ref, "already_issued")
    return { status: "skipped", reason: "duplicate_document", document_id: String(existing.id) }
  }

  // 2. Who issues.
  const finalizedAt = isoOf(p.finalized_at) ?? new Date().toISOString()
  const stream = await cardStreamFor(ctx, finalizedAt)
  if (!stream) {
    const def = await parkInvoice(
      ctx,
      p,
      "awaiting_config",
      "card_stream_missing",
      STRIPE_INVOICE_PARK,
    )
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_config" }
  }
  if (stream.issuer === "stripe") {
    await markIssuedBy(ctx, p.stripe_invoice_id, "stripe")
    return { status: "skipped", reason: "issued_by_stripe" }
  }
  if (stream.issuer === "undecided" && !opts.byPerson) {
    const def = await parkInvoice(
      ctx,
      p,
      "awaiting_config",
      "issuer_undecided",
      STRIPE_UNDECIDED_PARK,
      {
        issuer_profile_id: stream.row.issuer_profile_id ?? null,
      },
    )
    if (def.created) {
      await raise(ctx, "issuer_undecided", def.id, {
        deferred_id: def.id,
        stripe_invoice_id: p.stripe_invoice_id,
        total: money(toBigInt(p.total_minor), p.currency),
      })
    }
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_config" }
  }

  // 3. Finalized before Stripe was connected: Stripe's invoice stands alone.
  const connectedAt = isoOf(stream.row.created_at)
  if (connectedAt && finalizedAt < connectedAt) {
    await markIssuedBy(ctx, p.stripe_invoice_id, "before_connection")
    return { status: "skipped", reason: "before_connection" }
  }

  // 4. Totals.
  const total = toBigInt(p.total_minor)
  if (total === 0n) {
    // Nothing to invoice: Stripe's own zero invoice stands.
    await markIssuedBy(ctx, p.stripe_invoice_id, "stripe")
    return { status: "skipped", reason: "zero_total" }
  }
  if (total < 0n) {
    const def = await parkInvoice(ctx, p, "awaiting_data", "negative_total", STRIPE_INVOICE_PARK)
    if (def.created) {
      await raise(ctx, "needs_person", def.id, {
        deferred_id: def.id,
        stripe_invoice_id: p.stripe_invoice_id,
        reason: "its total is negative",
      })
    }
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }

  // 5. Issuer and buyer.
  const issuer = await findIssuerProfile(ctx.db, String(stream.row.issuer_profile_id ?? ""))
  if (!issuer) {
    const def = await parkInvoice(
      ctx,
      p,
      "awaiting_config",
      "issuer_profile_missing",
      STRIPE_INVOICE_PARK,
    )
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_config" }
  }
  const counterparty = await counterpartyOf(ctx, p, issuer.country)
  if (!counterparty.email) {
    const def = await parkInvoice(
      ctx,
      p,
      "awaiting_data",
      "customer_email_missing",
      STRIPE_INVOICE_PARK,
      {
        customer_id: p.customer_id ?? null,
      },
    )
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }
  if (!counterparty.address || !counterparty.legal_name) {
    const def = await parkInvoice(
      ctx,
      p,
      "awaiting_data",
      "customer_address_missing",
      STRIPE_INVOICE_PARK,
      {
        customer_id: p.customer_id ?? null,
        contact_id: counterparty.contact_id,
      },
    )
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }

  // 6. Tax as charged, line by line.
  const mismatches = stripeTaxMismatches(p.lines ?? [])
  if (mismatches.length > 0) {
    const def = await parkInvoice(ctx, p, "awaiting_data", "stripe_tax_mismatch", STRIPE_TAX_PARK, {
      lines: mismatches,
    })
    if (def.created && ctx.emit) {
      await ctx.emit({
        entity: "deferred",
        action: "stripe_tax_review",
        entityId: def.id,
        data: {
          deferred_id: def.id,
          stripe_invoice_id: p.stripe_invoice_id,
          reason: `line ${mismatches[0]?.position}: Stripe charged ${mismatches[0]?.stripe_minor}, Liaison computes ${mismatches[0]?.computed_minor}`,
          resolved: false,
        },
      })
    }
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }

  // 6b. The whole invoice as charged. Each line's tax may differ from Stripe's by one minor unit
  //     (checked above); what that leaves goes on one 0-tax "Rounding adjustment" line, so the
  //     invoice totals the charge exactly. Anything more, or a line with several taxes (no single
  //     rate to issue at), waits for a person.
  const liaisonTotal = liaisonTotalOf(p.lines ?? [])
  const residual = liaisonTotal === null ? null : total - liaisonTotal
  const tolerance = BigInt((p.lines ?? []).length)
  if (residual === null || residual > tolerance || -residual > tolerance) {
    const def = await parkInvoice(
      ctx,
      p,
      "awaiting_data",
      "stripe_total_mismatch",
      STRIPE_TAX_PARK,
      {
        liaison_total_minor: liaisonTotal === null ? null : liaisonTotal.toString(),
        stripe_total_minor: total.toString(),
      },
    )
    if (def.created && ctx.emit) {
      await ctx.emit({
        entity: "deferred",
        action: "stripe_tax_review",
        entityId: def.id,
        data: {
          deferred_id: def.id,
          stripe_invoice_id: p.stripe_invoice_id,
          reason:
            liaisonTotal === null
              ? "a line carries several taxes, so no single rate can be issued"
              : `Stripe charged ${money(total, p.currency)}, Liaison computes ${money(liaisonTotal, p.currency)}`,
          resolved: false,
        },
      })
    }
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }

  const lines = invoiceLines(p)
  if (residual !== 0n) {
    lines.push({
      position: lines.length + 1,
      description: "Rounding adjustment",
      quantity: "1",
      unit_price_minor: residual,
      line_kind: "service",
      tax_rate_bp_override: 0,
      product_source: null,
      external_id: null,
    })
  }
  // 7. The e-invoicing gate, before any number.
  const gate = await checkEinvoiceGate(ctx, { type: "invoice", issuer, counterparty, lines })
  if (!gate.ok) {
    const code = String(gate.error.error.code ?? "einvoice_gate")
    const def = await parkInvoice(ctx, p, "awaiting_data", code, EINVOICE_IDENTITY_PARK_KIND, {
      contact_id: counterparty.contact_id,
      code,
    })
    if ((GATE_CODES as readonly string[]).includes(code)) {
      await raiseIdentityAttention(ctx, {
        park: def,
        contact_id: counterparty.contact_id,
        code: code as GateCode,
        data: {
          order_label: p.number ?? p.stripe_invoice_id,
          contact_label: counterparty.legal_name,
        },
      })
    }
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }

  // 8. Above the threshold a person approves first; the payload waits parked under its key.
  const threshold =
    issuer.invoice_approval_threshold_minor != null
      ? toBigInt(issuer.invoice_approval_threshold_minor)
      : null
  if (!opts.byPerson && !ctx.approval && threshold != null && total > threshold) {
    const def = await parkInvoice(
      ctx,
      p,
      "awaiting_dependency",
      "approval_pending",
      STRIPE_APPROVAL_PARK,
    )
    if (!def.created)
      return { status: "deferred", deferred_id: def.id, reason: "awaiting_dependency" }
    const approval = await ctx.requestApproval({
      tool_name: "invoicing:invoice_from_stripe_payment",
      summary: `Issue the invoice of Stripe invoice ${p.number ?? p.stripe_invoice_id} (${money(total, p.currency)}) for ${counterparty.legal_name}`,
      summary_detail: {
        subtitle: "Above the approval threshold of this issuer",
        lines: [
          `It takes the next number of ${issuer.legal_name}'s invoices, dated the day it is approved.`,
        ],
      },
      current_payload: { stripeInvoiceId: p.stripe_invoice_id },
    })
    return { status: "pending_approval", approval_id: approval.approval_id }
  }

  // 9. Issue.
  const when = await issueDateParts(ctx, issuer)
  if (!when.ok) return { status: "error", error: when.error.error }
  let settlement: { paid_at: string; source: string } | null = null
  if (p.status === "paid" && p.paid_at) {
    const paid = await civilDateOf(ctx, issuer, p.paid_at)
    if (paid.ok) settlement = { paid_at: paid.date, source: "stripe" }
  }
  const issued = await issueWithFxRate(ctx, {
    type: "invoice",
    issuer,
    counterparty,
    external_ref: ref,
    // Issued with no person: its e-invoice goes out like every other no-person issue (the card
    // stream's standing authorization when on, else the daily send card), never its own card.
    einvoice_send: opts.byPerson ? "stage" : "batch",
    ...(settlement ? { settlement } : {}),
    draft: {
      currency: p.currency.toUpperCase(),
      incoterm: "DAP",
      year_of_issue: when.year_of_issue,
      issued_at: when.issued_at,
      due_at: when.issued_at,
      external_refs: {
        stripe_invoice_id: p.stripe_invoice_id,
        ...(p.number ? { stripe_invoice_number: p.number } : {}),
        ...(p.charge_id ? { stripe_charge_id: p.charge_id } : {}),
        ...(p.subscription_id ? { stripe_subscription_id: p.subscription_id } : {}),
        ...(p.customer_id ? { stripe_customer_id: p.customer_id } : {}),
      },
      lines,
    },
  })
  if (!issued.ok) return { status: "error", error: issued.error.error }
  await resolveOpenParks(ctx, ref, "issued")
  await linkBack(ctx, p.stripe_invoice_id, issued.result.document_id, issued.result.number ?? null)
  return { status: "ok", document_id: issued.result.document_id, number: issued.result.number }
}

/** Tell the Stripe app that Stripe's own invoice stands (no Liaison document), so its safety job
 *  walks past it. Best effort: the next run asks again. */
async function markIssuedBy(
  ctx: StripeCtx,
  stripeInvoiceId: string,
  issuedBy: "stripe" | "before_connection",
): Promise<void> {
  if (!ctx.executeTool) return
  try {
    await ctx.executeTool("stripe:invoice_document_link", { stripeInvoiceId, issuedBy })
  } catch {
    // Examined again on the next run; it decides the same.
  }
}

/** Tell the Stripe app which document its invoice became (`liaison_document_id`, set once). Best effort. */
export async function linkBack(
  ctx: StripeCtx,
  stripeInvoiceId: string,
  documentId: string,
  documentNumber: string | null = null,
): Promise<void> {
  if (!ctx.executeTool) return
  try {
    await ctx.executeTool("stripe:invoice_document_link", {
      stripeInvoiceId,
      documentId,
      ...(documentNumber ? { documentNumber } : {}),
    })
  } catch {
    // The safety job finds it again; the document itself is what counts.
  }
}
