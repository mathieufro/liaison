// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Stripe payment no invoice explains, after the connection: one row in the deferred queue and
// one attention item, never silent, never twice for one charge. A person resolves it with one of
// two gated tools, never auto-approved:
//   invoice_from_stripe_payment: issue the Liaison invoice now (it takes the next number), keyed
//     like any document made from that charge (`stripeDocumentRef`), so it never doubles a
//     finalized invoice; with `stripeInvoiceId` it issues a Stripe invoice that waited for a
//     decision (the card stream undecided, or above the approval threshold);
//   payment_link_to_invoice: link the charge to an invoice already issued, once.
import { park, resolveOpenParks } from "../deferred"
import { lineTax, netOfIncludedTax } from "../money"
import { toBigInt } from "../mutations/shared"
import { isoOf, streamRows, stripeDocumentRef } from "../streams"
import {
  documentByRef,
  type FinalizedResult,
  onStripeInvoiceFinalized,
  payloadOf,
  type StripeCtx,
  type StripeInvoicePayload,
  stripeRef,
} from "./stripe-invoice-finalized"

type Row = Record<string, unknown>

export interface StripePaymentPayload {
  charge_id: string
  invoice_id?: string | null
  customer_id?: string | null
  contact_id?: string | null
  amount_minor: string | number
  currency: string
  created?: string | null
  description?: string | null
  customer?: StripeInvoicePayload["customer"]
}

export const STRIPE_UNMATCHED_PARK = "stripe_unmatched_payment"

const fail = (code: string, message: string) => ({
  status: "error" as const,
  error: { code, message },
})
const money = (minor: bigint, currency: string) =>
  `${(Number(minor) / 100).toFixed(2)} ${currency.toUpperCase()}`

async function connectedSince(ctx: StripeCtx): Promise<string | null> {
  const rows = (await streamRows(ctx)).filter((r) => r.stripe_connected === true)
  const times = rows
    .map((r) => isoOf(r.created_at))
    .filter((t): t is string => !!t)
    .sort()
  return rows.length === 0 ? null : (times[0] ?? "")
}

export async function onStripePaymentUnmatched(event: unknown, ctx: StripeCtx) {
  const p = payloadOf<StripePaymentPayload>(event)
  if (!p || typeof p.charge_id !== "string" || !p.charge_id)
    return { status: "skipped" as const, reason: "invalid_payload" }
  if (p.invoice_id) return { status: "skipped" as const, reason: "has_invoice" }
  const since = await connectedSince(ctx)
  if (since === null) return { status: "skipped" as const, reason: "not_connected" }
  const created = isoOf(p.created)
  if (since && created && created < since)
    return { status: "skipped" as const, reason: "before_connection" }
  const ref = stripeRef(p.charge_id)
  if (await documentByRef(ctx, ref))
    return { status: "skipped" as const, reason: "already_invoiced" }
  if (await invoiceLinkedTo(ctx, p.charge_id)) {
    return { status: "skipped" as const, reason: "already_linked" }
  }
  const def = await park(
    { db: ctx.db },
    {
      event_id: ref,
      event_payload_json: { ...p, kind: STRIPE_UNMATCHED_PARK },
      status: "awaiting_data",
      reason: "stripe_payment_unmatched",
      blocked_on: {
        kind: STRIPE_UNMATCHED_PARK,
        charge_id: p.charge_id,
        contact_id: p.contact_id ?? null,
      },
    },
  )
  if (def.created) {
    await ctx.emit({
      entity: "stripe_payment",
      action: "unmatched",
      entityId: p.charge_id,
      data: {
        deferred_id: def.id,
        charge_id: p.charge_id,
        amount: money(toBigInt(p.amount_minor), p.currency),
        customer: p.customer?.name ?? p.customer?.email ?? p.customer_id ?? "unknown",
        resolved: false,
      },
    })
  }
  return { status: "deferred" as const, deferred_id: def.id, created: def.created }
}

const PAGE = 500

/** The invoice a charge was linked to by hand (`external_refs.stripe_charge_id`), read a page at a
 *  time through every invoice, so an organization with many never misses it. */
export async function invoiceLinkedTo(ctx: StripeCtx, chargeId: string): Promise<Row | null> {
  for (let offset = 0; ; offset += PAGE) {
    const page = (await ctx.db.findMany("documents", {
      where: { type: "invoice" },
      orderBy: { id: "asc" },
      limit: PAGE,
      offset,
    })) as Row[]
    const hit = page.find((d) => (d.external_refs as Row | null)?.stripe_charge_id === chargeId)
    if (hit) return hit
    if (page.length < PAGE) return null
  }
}

async function openPark(ctx: StripeCtx, eventId: string): Promise<Row | null> {
  const rows = (await ctx.db.findMany("deferred_events", {
    where: { event_id: eventId },
    limit: 20,
  })) as Row[]
  return rows.find((r) => r.status !== "resolved" && r.status !== "dead_letter") ?? null
}

export interface InvoiceFromStripeInput {
  chargeId?: string
  stripeInvoiceId?: string
  /** The VAT rate in the charge's amount (basis points), for a payment with no Stripe invoice. */
  vatRateBp?: number
  description?: string
}

/** Stage-time check: there is something waiting to issue, and it is not issued already. */
export async function invoiceFromStripePaymentPreflight(
  ctx: StripeCtx,
  input: InvoiceFromStripeInput,
) {
  const found = await waiting(ctx, input)
  return "status" in found ? found : { ok: true, noAutoApprove: true }
}

async function waiting(ctx: StripeCtx, input: InvoiceFromStripeInput) {
  const id = input.stripeInvoiceId?.trim() || input.chargeId?.trim() || ""
  if (!id)
    return fail(
      "payment_ref_missing",
      "Name the Stripe payment (chargeId, ch_...) or the Stripe invoice (stripeInvoiceId, in_...); nothing was issued.",
    )
  const existing = await documentByRef(ctx, stripeRef(id))
  if (existing) {
    return fail(
      "already_invoiced",
      `${id} is already invoiced by ${String(existing.number ?? existing.id)}; nothing was issued again.`,
    )
  }
  const row = await openPark(ctx, stripeRef(id))
  if (!row)
    return fail(
      "nothing_waiting",
      `No Stripe payment or invoice ${id} is waiting to be invoiced; nothing was issued. List the waiting ones with deferred_list.`,
    )
  if (
    input.chargeId &&
    !input.stripeInvoiceId &&
    (typeof input.vatRateBp !== "number" || input.vatRateBp < 0)
  ) {
    return fail(
      "vat_rate_required",
      `Charge ${id} has no Stripe invoice, so its VAT rate is not known; nothing was issued. Ask the person which rate the amount includes and pass vatRateBp (2000 for 20%).`,
    )
  }
  return { row, id }
}

/**
 * The lines of an invoice for a charge of `gross` that includes VAT at `rateBp`: the net whose
 * net plus its tax is the charge, and when no net is (9.99 at 20%: 8.32 gives 9.98, 8.33 gives
 * 10.00), the nearest one below plus a 0-tax "Rounding adjustment" line, so the invoice always
 * totals what was charged.
 */
export function chargeLines(
  gross: bigint,
  rateBp: number,
  description: string,
): StripeInvoicePayload["lines"] {
  const gross_of = (n: bigint) => n + lineTax({ subtotal_minor: n, tax_rate_bp: rateBp })
  let net = netOfIncludedTax(gross, rateBp)
  while (net > 0n && gross_of(net) > gross) net -= 1n
  while (gross_of(net + 1n) <= gross) net += 1n
  const residual = gross - gross_of(net)
  const lines: NonNullable<StripeInvoicePayload["lines"]> = [
    { description, quantity: 1, unit_amount_excl_minor: net.toString(), tax_rate_bp: rateBp },
  ]
  if (residual !== 0n)
    lines.push({
      description: "Rounding adjustment",
      quantity: 1,
      unit_amount_excl_minor: residual.toString(),
      tax_rate_bp: 0,
    })
  return lines
}

export async function invoiceFromStripePayment(ctx: StripeCtx, input: InvoiceFromStripeInput) {
  const found = await waiting(ctx, input)
  if ("status" in found) return found
  const stored = (found.row.event_payload_json ?? {}) as Row
  let outcome: FinalizedResult
  if (input.stripeInvoiceId) {
    outcome = await onStripeInvoiceFinalized(stored, ctx, { byPerson: true })
  } else {
    const p = stored as unknown as StripePaymentPayload
    const gross = toBigInt(p.amount_minor)
    const rate = Number(input.vatRateBp ?? 0)
    outcome = await onStripeInvoiceFinalized(
      {
        // One document per charge: keyed by its invoice when it has one, else by itself.
        stripe_invoice_id: stripeDocumentRef({
          id: p.charge_id,
          invoice: p.invoice_id ?? null,
        }).slice("stripe:".length),
        customer_id: p.customer_id ?? null,
        contact_id: p.contact_id ?? null,
        total_minor: gross.toString(),
        currency: p.currency,
        finalized_at: p.created ?? null,
        paid_at: p.created ?? null,
        status: "paid",
        charge_id: p.charge_id,
        customer: p.customer ?? null,
        lines: chargeLines(
          gross,
          rate,
          input.description?.trim() || p.description || `Payment ${p.charge_id}`,
        ),
      } satisfies StripeInvoicePayload,
      ctx,
      { byPerson: true },
    )
  }
  if (outcome.status === "ok") {
    await resolveOpenParks(ctx, stripeRef(found.id), "issued")
    return {
      status: "completed" as const,
      document_id: outcome.document_id,
      number: outcome.number,
      summary: `Invoice ${outcome.number} was issued for ${found.id} and took the next number. Send it with documents_send_to_customer.`,
    }
  }
  if (outcome.status === "pending_approval")
    return { status: "pending_approval" as const, approval_id: outcome.approval_id }
  if (outcome.status === "error") return { status: "error" as const, error: outcome.error }
  return fail(
    "not_issued",
    `${found.id} was not invoiced (${outcome.reason}); no number was taken. It stays in the queue.`,
  )
}

export interface PaymentLinkInput {
  chargeId: string
  documentId: string
}

async function linkCheck(ctx: StripeCtx, input: PaymentLinkInput) {
  const chargeId = input.chargeId?.trim() ?? ""
  if (!/^(ch|py)_/.test(chargeId))
    return fail(
      "payment_ref_missing",
      "Name the Stripe payment (chargeId, ch_...); nothing was linked.",
    )
  const doc = (await ctx.db.findOne("documents", String(input.documentId ?? ""))) as Row | null
  if (!doc || doc.type !== "invoice" || doc.status === "draft") {
    return fail(
      "invoice_not_found",
      `No issued invoice ${input.documentId}; nothing was linked. Find it with documents_search.`,
    )
  }
  const byRef = await documentByRef(ctx, stripeRef(chargeId))
  const holder = byRef ?? (await invoiceLinkedTo(ctx, chargeId))
  if (holder) {
    return fail(
      "already_linked",
      `Payment ${chargeId} is already linked to ${String(holder.number ?? holder.id)}; nothing changed.`,
    )
  }
  return { doc, chargeId }
}

export async function paymentLinkToInvoicePreflight(ctx: StripeCtx, input: PaymentLinkInput) {
  const r = await linkCheck(ctx, input)
  return "status" in r ? r : { ok: true, noAutoApprove: true }
}

export async function paymentLinkToInvoice(ctx: StripeCtx, input: PaymentLinkInput) {
  const r = await linkCheck(ctx, input)
  if ("status" in r) return r
  const { doc, chargeId } = r
  const refs = ((doc.external_refs as Row | null) ?? {}) as Row
  const log = Array.isArray(doc.lifecycle_log) ? (doc.lifecycle_log as Row[]) : []
  await ctx.db.update("documents", String(doc.id), {
    ...(doc.external_ref ? {} : { external_ref: stripeRef(chargeId) }),
    external_refs: { ...refs, stripe_charge_id: chargeId },
    lifecycle_log: [
      ...log,
      {
        event: "stripe_payment_linked",
        actor: await ctx.getUserId(),
        ts: new Date().toISOString(),
        charge_id: chargeId,
      },
    ],
  })
  await resolveOpenParks(ctx, stripeRef(chargeId), "linked")
  return {
    status: "completed" as const,
    document_id: String(doc.id),
    summary: `Payment ${chargeId} is linked to invoice ${String(doc.number ?? doc.id)}; no number was taken and nothing changed in Stripe.`,
  }
}
