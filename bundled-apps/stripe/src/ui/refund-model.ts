// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The refund cards: what a pending refund approval shows, and the three other ways it can go. The card
// reads the charge in the mirror for the refundable remainder; the approval itself still re-reads Stripe
// at the moment it runs.

import { maskedCard, type PaymentItem } from "./customers-model"
import { type ApprovalItem, formatMoney } from "./home-model"
import { tr } from "./i18n"

export type RefundCardState = "pending" | "editing" | "already_refunded" | "refused"

export interface RefundApproval extends ApprovalItem {
  payload?: { chargeId?: string; amountMinor?: number | string } | null
  currentPayload?: { chargeId?: string; amountMinor?: number | string } | null
  error?: string | null
  editing?: boolean
}

export const payloadOf = (a: RefundApproval) => a.payload ?? a.currentPayload ?? null

/** Which approvals are this customer's pending refunds, by the charge they name. */
export function refundsOf(
  approvals: RefundApproval[],
  payments: PaymentItem[],
): Array<{ approval: RefundApproval; payment: PaymentItem }> {
  const byCharge = new Map(payments.map((p) => [p.id, p]))
  const out: Array<{ approval: RefundApproval; payment: PaymentItem }> = []
  for (const approval of approvals) {
    if (approval.toolName && !/refunds_create$/.test(approval.toolName)) continue
    const charge = payloadOf(approval)?.chargeId
    const payment = charge ? byCharge.get(charge) : undefined
    if (payment) out.push({ approval, payment })
  }
  return out
}

export function refundCardState(a: RefundApproval, p: PaymentItem): RefundCardState {
  if (a.error || a.status === "failed") return "refused"
  const left = (p.amountMinor ?? 0) - (p.refundedMinor ?? 0)
  if (left <= 0) return "already_refunded"
  return a.editing ? "editing" : "pending"
}

export interface RefundCardView {
  state: RefundCardState
  title: string
  /** What is still refundable on the charge. */
  remainder: string
  remainderMinor: number
  amount: string
  /** The amount this approval refunds, in minor units (the payload's, else all that is left). */
  amountMinor: number
  /** What "Try again" asks for: the refused refund's amount, capped at what is still refundable. */
  retryMinor: number
  to: string
  note: string
  canApprove: boolean
  actions: Array<{
    id: "approve" | "edit" | "reject" | "credit_note" | "dismiss" | "retry" | "open_stripe"
    label: string
    confirm?: string
  }>
}

const amountOf = (a: RefundApproval, p: PaymentItem): number => {
  const raw = payloadOf(a)?.amountMinor
  const n = raw === undefined || raw === null ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0
    ? n
    : Math.max(0, (p.amountMinor ?? 0) - (p.refundedMinor ?? 0))
}

/** Digits after the decimal point of `currency`'s minor unit (2 for EUR, 0 for JPY). */
function minorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: (currency || "eur").toUpperCase(),
      }).resolvedOptions().maximumFractionDigits ?? 2
    )
  } catch {
    return 2
  }
}

/** The amount field's text for `minor` (89.40 for 8940 EUR). */
export function amountText(minor: number, currency: string): string {
  const d = minorDigits(currency)
  return (minor / 10 ** d).toFixed(d)
}

/**
 * The edited amount, in minor units, from what a person typed ("89.40" or "89,40"), or why
 * not: it must be more than zero and at most what is still refundable.
 */
export function editedAmount(
  text: string,
  currency: string,
  leftMinor: number,
): { minor: number } | { error: string } {
  const d = minorDigits(currency)
  const t = text.trim().replace(",", ".")
  const m = /^(\d+)(?:\.(\d*))?$/.exec(t)
  if (!m || (m[2] ?? "").length > d)
    return {
      error: tr("Type an amount such as {{example}}.", { example: amountText(8940, currency) }),
    }
  const minor = Number(m[1]) * 10 ** d + Number((m[2] ?? "").padEnd(d, "0") || "0")
  if (!Number.isSafeInteger(minor) || minor <= 0)
    return { error: tr("The amount must be more than zero.") }
  if (minor > leftMinor)
    return {
      error: tr("At most {{left}} is still refundable.", { left: amountText(leftMinor, currency) }),
    }
  return { minor }
}

/** The host calls a refund card decides through (`app` from `@liaison/host`). */
export interface RefundDecider {
  editApproval(
    id: string,
    fields: Record<string, unknown>,
  ): Promise<{ payloadHash?: string } | null | undefined>
  decideApproval(id: string, decision: "approve" | "deny", payloadHash?: string): Promise<unknown>
}

/**
 * Decide a refund card. "Save and approve" passes the typed amount: it is saved on the approval
 * first (when it differs), and the approve is bound to that saved version, so what runs is the
 * amount the person typed. Answers the amount's error without deciding anything.
 */
export async function decideRefund(
  host: RefundDecider,
  a: RefundApproval,
  decision: "approve" | "deny",
  edit: { text: string; currency: string; leftMinor: number; currentMinor: number } | null,
): Promise<{ error: string } | null> {
  let payloadHash = a.payloadHash
  if (decision === "approve" && edit) {
    const parsed = editedAmount(edit.text, edit.currency, edit.leftMinor)
    if ("error" in parsed) return parsed
    if (parsed.minor !== edit.currentMinor) {
      const saved = await host.editApproval(a.id, { amountMinor: String(parsed.minor) })
      payloadHash = saved?.payloadHash ?? payloadHash
    }
  }
  await host.decideApproval(a.id, decision, payloadHash)
  return null
}

/** The sentence a "Try again" or "Issue the credit note" asks before it does anything. */
export function retryConfirm(amount: string, card: string): string {
  return tr(
    "This asks for a new refund of {{amount}} to the {{card}}. It still waits for a person's approval, and nothing moves until then.",
    { amount, card },
  )
}
export function creditNoteConfirm(amount: string): string {
  return tr(
    "This asks the agent to issue a credit note of {{amount}} for the refund already made in Stripe. It is a new approval, and nothing is issued until a person approves it.",
    { amount },
  )
}

export function refundCardView(
  a: RefundApproval,
  p: PaymentItem,
  locale: string,
  held = false,
): RefundCardView {
  const cur = p.currency ?? "eur"
  const state = refundCardState(a, p)
  const left = Math.max(0, (p.amountMinor ?? 0) - (p.refundedMinor ?? 0))
  const asked = amountOf(a, p)
  const amount = formatMoney(asked, cur, locale)
  const retryMinor = Math.min(asked, left)
  const card = maskedCard(p.card)
  const base = {
    state,
    remainderMinor: left,
    remainder: formatMoney(left, cur, locale),
    amount,
    amountMinor: asked,
    retryMinor,
    to: card,
  }
  if (state === "already_refunded") {
    return {
      ...base,
      title: tr("Already refunded in Stripe"),
      note: tr(
        "Liaison checks Stripe just before refunding, so nothing goes out twice. The refund made has no credit note yet, and it needs one.",
      ),
      canApprove: false,
      actions: [
        {
          id: "credit_note",
          label: tr("Issue the credit note for it"),
          confirm: creditNoteConfirm(formatMoney(p.refundedMinor ?? asked, cur, locale)),
        },
        { id: "dismiss", label: tr("Dismiss") },
      ],
    }
  }
  if (state === "refused") {
    return {
      ...base,
      title: tr("Stripe refused the refund"),
      note:
        a.error ??
        tr("No credit note was issued, so Stripe and your books still agree. Nothing is lost."),
      canApprove: false,
      actions: [
        {
          id: "retry",
          label: tr("Try again"),
          confirm: retryConfirm(formatMoney(retryMinor, cur, locale), card),
        },
        { id: "open_stripe", label: tr("Open in Stripe") },
      ],
    }
  }
  return {
    ...base,
    title: tr("Refund {{amount}}", { amount }),
    note: tr(
      "Will not run if this charge is already refunded in Stripe. Checked again at the moment it runs.",
    ),
    canApprove: !held,
    actions:
      state === "editing"
        ? [
            { id: "approve", label: tr("Save and approve") },
            { id: "reject", label: tr("Cancel") },
          ]
        : [
            { id: "edit", label: tr("Edit") },
            { id: "approve", label: tr("Approve") },
            { id: "reject", label: tr("Reject") },
          ],
  }
}
