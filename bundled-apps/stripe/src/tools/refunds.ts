// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `refunds_create`: a refund on one charge, decided by a person.
//
// STAGING (the preflight). The charge is read from Stripe, never from the
// mirror, and four cases are refused before any approval exists: the charge is
// already refunded, it is disputed, the amount is above what is left, or (when
// Liaison issues the invoices) no Liaison invoice explains it. A refusal parks
// nothing.
//
// AFTER APPROVAL (the handler). Nothing moves without `ctx.approval`. The
// handler first looks in Stripe for a refund this approval already made (its
// `metadata[liaison_approval_id]`); one found is the answer and nothing is sent.
// This is what makes a retry safe after Stripe's 24-hour idempotency window.
// Then it reads the charge again and refuses against what is left now, so two
// approvals racing on one charge never refund more than it holds. The POST
// carries `Idempotency-Key = <approval id>`. A lost answer is recorded
// ambiguous, never retried blind; a refusal by Stripe is recorded as no effect.
//
// A card number in the reason is refused, and logs carry brand, last 4 and
// expiry only.
import { refuseTool, type ToolRefusal } from "@liaison/app-sdk/errors"
import { StripeApiError, type StripeHttpCtx, stripeFetch } from "../http"
import {
  chargedAt,
  invoiceOfCharge,
  listRefunds,
  refundItem,
  stripeDocumentRef,
} from "../money-events"
import { maskCardNumbers } from "../pan-scan"
import { moneyActionHold, type StateDb } from "../states"
import type { ReadCtx } from "./read-common"

type Obj = Record<string, unknown>

/** The approval the kernel replays this call under, and its outcome recorders. */
export interface ApprovalBridges {
  approval?: { approvalRequestId: string; approvalDeciderId: string; toolName: string }
  approval_recordStarted?: (toolName: string) => Promise<void>
  approval_recordSucceeded?: (toolName: string, externalRefJson?: string) => Promise<void>
  approval_recordFailedNoEffect?: (toolName: string, errJson: string) => Promise<void>
  approval_recordAmbiguous?: (toolName: string, errJson: string) => Promise<void>
}

export interface MoneyLogger {
  info(msg: string, data?: unknown): void
  warn(msg: string, data?: unknown): void
}

export interface MoneyCtx extends StripeHttpCtx, ApprovalBridges {
  db: StateDb & ReadCtx["db"]
  executeTool?: ReadCtx["executeTool"]
  logger?: MoneyLogger
  /** The typed event bus: the refund's `refund:created` goes to invoicing at once. */
  emit?: (event: {
    entity: string
    action: string
    entityId?: string
    data?: unknown
  }) => Promise<void>
}

interface Charge {
  id: string
  amount: number
  amount_refunded: number
  refunded: boolean
  disputed: boolean
  currency: string
  customer: string | null
  card: { brand: string | null; last4: string | null; exp: string | null } | null
}

interface Refund {
  id: string
  amount: number
  status: string
  currency: string
  metadata: Record<string, string>
}

const ID = /^ch_[A-Za-z0-9_]+$/

export function money(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`
}

/** The charge as these tools may show and log it: card as brand, last 4 and expiry. */
function toCharge(raw: Obj): Charge {
  const card = ((raw.payment_method_details as Obj | undefined)?.card ?? null) as Obj | null
  return {
    id: String(raw.id),
    amount: Number(raw.amount) || 0,
    amount_refunded: Number(raw.amount_refunded) || 0,
    refunded: raw.refunded === true,
    disputed: raw.disputed === true,
    currency: String(raw.currency ?? ""),
    customer: typeof raw.customer === "string" ? raw.customer : null,
    card: card
      ? {
          brand: typeof card.brand === "string" ? card.brand : null,
          last4: typeof card.last4 === "string" ? card.last4 : null,
          exp:
            card.exp_month && card.exp_year
              ? `${String(card.exp_month).padStart(2, "0")}/${card.exp_year}`
              : null,
        }
      : null,
  }
}

/** Refused when a text holds a card number: no tool takes one. */
export function cardNumberRefusal(field: string, text: unknown): ToolRefusal | null {
  if (typeof text !== "string" || maskCardNumbers(text).masked === 0) return null
  return refuseTool(
    "card_number_refused",
    `The ${field} holds a card number. Liaison never takes card numbers, so nothing was staged or sent. Next step: remove the number; a card is named by its brand and last 4 digits.`,
  )
}

/** A Stripe failure while reading, as a refusal that names what did not happen. */
export function readRefusal(err: unknown, what: string, id: string): ToolRefusal {
  if (err instanceof StripeApiError) {
    if (err.code === "key_invalid") {
      return refuseTool(
        "key_invalid",
        `Stripe refuses the saved key (401), so ${what} ${id} could not be read and nothing was sent to Stripe. Next step: an admin saves a working restricted key in the Stripe card.`,
      )
    }
    if (err.status === 404) {
      return refuseTool(
        `${what.replace(/ /g, "_")}_not_found`,
        `Stripe has no ${what} ${id}, so nothing was staged or sent.`,
      )
    }
    if (err.code === "permission_missing") {
      return refuseTool(
        "permission_missing",
        `The restricted key cannot read ${err.resource}, so ${what} ${id} could not be checked and nothing was sent. Next step: an admin gives the key that permission in Stripe, then runs the Stripe key check.`,
      )
    }
  }
  return refuseTool(
    "stripe_unreachable",
    `Stripe did not answer for ${what} ${id}, so nothing was staged or sent. Next step: try again in a few minutes.`,
    { retryable: true },
  )
}

export async function readCharge(
  ctx: StripeHttpCtx,
  chargeId: string,
): Promise<Charge | ToolRefusal> {
  try {
    return toCharge(await stripeFetch<Obj>(ctx, `/v1/charges/${encodeURIComponent(chargeId)}`))
  } catch (err) {
    return readRefusal(err, "charge", chargeId)
  }
}

const isRefusal = (v: unknown): v is ToolRefusal => (v as ToolRefusal | null)?.status === "error"

/**
 * Who issues the legal invoice for card payments, as invoicing's "Who issues what" records it:
 * `liaison` (mode A: each charge has a Liaison invoice, and a refund a credit note), or anything
 * else (Stripe issues, or nobody decided yet). Invoicing off or absent: no Liaison invoice exists.
 */
async function cardStreamIssuer(ctx: MoneyCtx): Promise<string | null | ToolRefusal> {
  if (!ctx.executeTool) return null
  const env = await ctx.executeTool("invoicing:card_stream_issuer", {})
  if (env.status === "completed") {
    const issuer = (env.result as { issuer?: unknown } | null)?.issuer
    return typeof issuer === "string" ? issuer : null
  }
  if (env.status === "error" && env.error.code === "tool_not_found") return null
  return refuseTool(
    "issuer_unknown",
    "Liaison could not read who issues the invoices for card payments, so it cannot tell whether a credit note must follow; nothing was staged or sent. Next step: try again in a minute.",
  )
}

/** When Liaison issues the invoices (mode A), the Liaison invoice behind this charge, or null. */
async function invoiceBehind(
  ctx: MoneyCtx,
  chargeId: string,
): Promise<{ modeA: boolean; documentId: string | null } | ToolRefusal> {
  const issuer = await cardStreamIssuer(ctx)
  if (isRefusal(issuer)) return issuer
  if (issuer !== "liaison") return { modeA: false, documentId: null }
  const db = ctx.db
  const payment = (
    (await db.findMany("stripe_payments", { where: { stripe_id: chargeId }, limit: 1 })) as Obj[]
  )[0]
  const invoiceId = typeof payment?.invoice_id === "string" ? payment.invoice_id : null
  if (!invoiceId) return { modeA: true, documentId: null }
  const invoice = (
    (await db.findMany("stripe_invoices", { where: { stripe_id: invoiceId }, limit: 1 })) as Obj[]
  )[0]
  const documentId =
    typeof invoice?.liaison_document_id === "string" ? invoice.liaison_document_id : null
  return { modeA: true, documentId }
}

/** What is left to refund on the charge, or the refusal that stops this refund. */
function refusalFor(
  charge: Charge,
  amountMinor: number | null,
): ToolRefusal | { left: number; amount: number } {
  const left = charge.amount - charge.amount_refunded
  if (charge.disputed) {
    return refuseTool(
      "charge_disputed",
      `Charge ${charge.id} is disputed, so it cannot be refunded and nothing was staged or sent. Next step: answer the dispute in Stripe's dashboard; a refund now would lose the money twice.`,
    )
  }
  if (charge.refunded || left <= 0) {
    return refuseTool(
      "already_refunded",
      `Charge ${charge.id} is already refunded in full (${money(charge.amount_refunded, charge.currency)}), so nothing was staged or sent.`,
    )
  }
  const amount = amountMinor ?? left
  if (amount > left) {
    return refuseTool(
      "amount_over_refundable",
      `Charge ${charge.id} has ${money(left, charge.currency)} left to refund, less than the ${money(amount, charge.currency)} asked, so nothing was staged or sent. Next step: refund at most ${money(left, charge.currency)}.`,
    )
  }
  return { left, amount }
}

function amountOf(v: unknown): number | null | ToolRefusal {
  if (v === undefined || v === null) return null
  const n = Number(v)
  if (Number.isInteger(n) && n > 0) return n
  return refuseTool(
    "amount_invalid",
    "amountMinor must be a whole number of cents above 0, so nothing was staged or sent. Next step: pass the amount in minor units, or omit it to refund what is left.",
  )
}

async function checks(
  params: Obj,
  ctx: MoneyCtx,
): Promise<ToolRefusal | { charge: Charge; amount: number; left: number }> {
  const hold = await moneyActionHold(ctx.db)
  if (hold) return hold
  const chargeId = typeof params.chargeId === "string" ? params.chargeId.trim() : ""
  if (!ID.test(chargeId)) {
    return refuseTool(
      "charge_ref_missing",
      "No Stripe charge (ch_...) was named, so nothing was staged or sent. Next step: find it with payments_search.",
    )
  }
  const card = cardNumberRefusal("reason", params.reason)
  if (card) return card
  const amount = amountOf(params.amountMinor)
  if (isRefusal(amount)) return amount
  // Stripe's answer now, never the mirror's: a refund made in Stripe meanwhile counts.
  const charge = await readCharge(ctx, chargeId)
  if (isRefusal(charge)) return charge
  const verdict = refusalFor(charge, amount)
  if (isRefusal(verdict)) return verdict
  return { charge, ...verdict }
}

export async function refundsCreatePreflight(params: Obj | undefined, ctx: MoneyCtx) {
  const p = params ?? {}
  const checked = await checks(p, ctx)
  if (isRefusal(checked)) return checked
  const behind = await invoiceBehind(ctx, checked.charge.id)
  if (isRefusal(behind)) return behind
  const { modeA, documentId } = behind
  if (modeA && !documentId) {
    return refuseTool(
      "no_invoice_for_refund",
      `Charge ${checked.charge.id} has no Liaison invoice (it predates the connection or was never invoiced), so no credit note can follow it and nothing was staged. Next step: ask the person whether to refund in Stripe and then record a credit note against which invoice.`,
    )
  }
  return { ok: true, noAutoApprove: true, pinnedParams: { chargeId: checked.charge.id } }
}

/** A refund this approval already made, found by its metadata (never by a second POST). */
async function refundOfApproval(
  ctx: MoneyCtx,
  chargeId: string,
  approvalId: string,
): Promise<Refund | null> {
  const list = await stripeFetch<{ data?: Refund[] }>(ctx, "/v1/refunds", {
    params: { charge: chargeId, limit: 100 },
  })
  return (list.data ?? []).find((r) => r.metadata?.liaison_approval_id === approvalId) ?? null
}

async function noEffect(ctx: MoneyCtx, refusal: ToolRefusal): Promise<ToolRefusal> {
  const a = ctx.approval
  if (a) await ctx.approval_recordFailedNoEffect?.(a.toolName, JSON.stringify(refusal.error))
  return refusal
}

/**
 * `refund:created` for the charge, from the tool's own result: whichever of this and
 * Stripe's `charge.refunded` reaches invoicing first makes the credit note, once. Every
 * refund of the charge is listed by id; a failure here never undoes the refund (the
 * webhook and the safety job still carry it).
 */
async function announceRefund(ctx: MoneyCtx, chargeId: string, refund: Refund): Promise<void> {
  if (!ctx.emit) return
  try {
    const [row] = (await ctx.db.findMany("stripe_payments", {
      where: { stripe_id: chargeId },
      limit: 1,
    })) as Obj[]
    let invoice = typeof row?.invoice_id === "string" && row.invoice_id ? row.invoice_id : null
    let charged = chargedAt(row)
    if (!invoice || !charged) {
      const charge = await stripeFetch<Obj>(ctx, `/v1/charges/${encodeURIComponent(chargeId)}`, {})
      invoice ??= await invoiceOfCharge(ctx, charge)
      charged ??= chargedAt(null, charge)
    }
    let refunds: Obj[] = []
    try {
      refunds = await listRefunds(ctx, chargeId)
    } catch {
      refunds = []
    }
    if (!refunds.some((r) => r.id === refund.id)) refunds = [refund as unknown as Obj, ...refunds]
    const items = refunds.filter((r) => typeof r.id === "string").map(refundItem)
    const main = refundItem(refund as unknown as Obj)
    await ctx.emit({
      entity: "refund",
      action: "created",
      entityId: refund.id,
      data: {
        refund_id: refund.id,
        charge_id: chargeId,
        invoice_id: invoice,
        document_ref: stripeDocumentRef({ id: chargeId, invoice }),
        amount_minor: main.amount_minor,
        currency: main.currency,
        status: main.status,
        refunds: items,
        charged_at: charged,
      },
    })
  } catch (err) {
    ctx.logger?.warn("stripe refund not announced", {
      chargeId,
      refundId: refund.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function addTicketNote(
  ctx: MoneyCtx,
  ticketId: unknown,
  refund: Refund,
  charge: Charge,
): Promise<string | null> {
  if (typeof ticketId !== "string" || !ticketId.trim() || !ctx.executeTool) return null
  const card = charge.card?.last4
    ? ` to the ${charge.card.brand ?? "card"} ending ${charge.card.last4}`
    : ""
  try {
    const out = await ctx.executeTool("tickets:addNote", {
      ticketId: ticketId.trim(),
      text: `Refund ${refund.id} of ${money(refund.amount, refund.currency)} on charge ${charge.id}${card}: ${refund.status} in Stripe.`,
      idempotencyKey: `stripe-refund-note:${refund.id}`,
    })
    return out.status === "completed"
      ? `An internal note was added to ticket ${ticketId}; no reply was sent.`
      : `The internal note on ticket ${ticketId} was not added (${out.status}); no reply was sent.`
  } catch {
    return `The internal note on ticket ${ticketId} was not added; no reply was sent.`
  }
}

function result(refund: Refund, charge: Charge, note: string | null, found: boolean) {
  const left = charge.amount - charge.amount_refunded - (found ? 0 : refund.amount)
  return {
    refundId: refund.id,
    status: refund.status,
    chargeId: charge.id,
    amountMinor: refund.amount,
    currency: refund.currency,
    leftMinor: Math.max(0, left),
    card: charge.card,
    creditNote: null,
    summary: [
      found
        ? `Refund ${refund.id} of ${money(refund.amount, refund.currency)} on charge ${charge.id} was already made for this approval; nothing was sent again.`
        : `Refund ${refund.id} of ${money(refund.amount, refund.currency)} on charge ${charge.id} is ${refund.status} in Stripe.`,
      `${money(Math.max(0, left), charge.currency)} is left to refund on that charge.`,
      note,
    ]
      .filter(Boolean)
      .join(" "),
  }
}

export async function refundsCreate(params: Obj | undefined, ctx: MoneyCtx) {
  const p = params ?? {}
  const approval = ctx.approval
  if (!approval) {
    return refuseTool(
      "approval_required",
      "A refund runs only after a person approves it, so nothing was sent to Stripe. Next step: call refunds_create through its approval.",
    )
  }
  const chargeId = typeof p.chargeId === "string" ? p.chargeId.trim() : ""
  const hold = await moneyActionHold(ctx.db)
  if (hold) return noEffect(ctx, hold)

  // 1. Already made by this approval? Then that is the answer, whatever the time since.
  let existing: Refund | null = null
  if (ID.test(chargeId)) {
    try {
      existing = await refundOfApproval(ctx, chargeId, approval.approvalRequestId)
    } catch (err) {
      return noEffect(ctx, readRefusal(err, "charge", chargeId))
    }
  }
  if (existing) {
    const charge = await readCharge(ctx, chargeId)
    if (isRefusal(charge)) return noEffect(ctx, charge)
    await ctx.approval_recordSucceeded?.(
      approval.toolName,
      JSON.stringify({ refundId: existing.id }),
    )
    await announceRefund(ctx, chargeId, existing)
    return result(existing, charge, await addTicketNote(ctx, p.ticketId, existing, charge), true)
  }

  // 2. Read the charge again and refuse against what is left now.
  const checked = await checks(p, ctx)
  if (isRefusal(checked)) return noEffect(ctx, checked)
  const { charge, amount } = checked

  await ctx.approval_recordStarted?.(approval.toolName)
  let refund: Refund
  try {
    refund = await stripeFetch<Refund>(ctx, "/v1/refunds", {
      method: "POST",
      params: {
        charge: charge.id,
        amount,
        reason: "requested_by_customer",
        metadata: {
          liaison_approval_id: approval.approvalRequestId,
          ...(typeof p.reason === "string" && p.reason.trim()
            ? { liaison_reason: p.reason.trim().slice(0, 450) }
            : {}),
        },
      },
      idempotencyKey: approval.approvalRequestId,
    })
  } catch (err) {
    const definite = err instanceof StripeApiError && err.status < 500
    if (definite) {
      const refusal = refuseTool(
        err.code === "key_invalid" ? "key_invalid" : "stripe_refused",
        `Stripe refused refund of ${money(amount, charge.currency)} on charge ${charge.id} (${err.message}), so no money moved and no credit note follows.${err.code === "key_invalid" ? " Next step: an admin saves a working restricted key, then approve again." : ""}`,
      )
      ctx.logger?.warn("stripe refund refused", {
        chargeId: charge.id,
        amountMinor: amount,
        status: err.status,
        card: charge.card,
      })
      return noEffect(ctx, refusal)
    }
    const refusal = refuseTool(
      "refund_outcome_unknown",
      `Stripe's answer to refund ${money(amount, charge.currency)} on charge ${charge.id} was lost, so it is not known whether money moved. Nothing will be sent again blindly. Next step: approve again later; Stripe is searched for this approval's refund first and nothing is sent if it exists.`,
      { retryable: true },
    )
    ctx.logger?.warn("stripe refund outcome unknown", {
      chargeId: charge.id,
      amountMinor: amount,
      card: charge.card,
    })
    await ctx.approval_recordAmbiguous?.(approval.toolName, JSON.stringify(refusal.error))
    return refusal
  }
  await ctx.approval_recordSucceeded?.(approval.toolName, JSON.stringify({ refundId: refund.id }))
  await announceRefund(ctx, charge.id, refund)
  ctx.logger?.info("stripe refund created", {
    refundId: refund.id,
    chargeId: charge.id,
    amountMinor: refund.amount,
    currency: refund.currency,
    card: charge.card,
  })
  return result(refund, charge, await addTicketNote(ctx, p.ticketId, refund, charge), false)
}
