// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The approval cards of the money actions. Each one reads the params and the
// result of its declared context read (`summarizerContext`), never Stripe.
type Obj = Record<string, unknown>

interface SummarizerMeta {
  connectionIdentifier?: string | null
  context?: unknown
}

const rec = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {})
const money = (minor: number, currency: string) =>
  `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`

/** `refunds_create`: payment, card (brand and last 4), amount, what follows. */
export function summarizeRefundsCreate(params: unknown, _ctx?: unknown, meta?: SummarizerMeta) {
  const p = rec(params)
  const chargeId = String(p.chargeId ?? "")
  const items = rec(meta?.context).items
  const pay = rec(Array.isArray(items) ? items[0] : undefined)
  const currency = String(pay.currency ?? "eur")
  const total = Number(pay.amountMinor ?? pay.amount_minor ?? 0)
  const refunded = Number(pay.refundedMinor ?? pay.refunded_minor ?? 0)
  const left = total - refunded
  const amount = Number(p.amountMinor ?? left)
  const card = rec(pay.card)
  const lines = [
    `Payment: ${chargeId}${total ? `, ${money(total, currency)}` : ""}${pay.invoiceId ? `, invoice ${String(pay.invoiceId)}` : ""}`,
    card.last4
      ? `To: ${String(card.brand ?? "card")} ending ${String(card.last4)}`
      : "To: the card that paid",
    amount > 0
      ? `Amount: ${money(amount, currency)}${p.amountMinor === undefined ? " (all that is left)" : ""}`
      : "Amount: all that is left",
    "Stripe goes first: the refund is sent only once you approve, and checked again against what is left.",
    ...(typeof p.ticketId === "string"
      ? [`An internal note is added to ticket ${p.ticketId}; no reply is sent.`]
      : []),
  ]
  return Promise.resolve({
    kind: "refunds_create",
    title: amount > 0 ? `Refund ${money(amount, currency)} on ${chargeId}` : `Refund ${chargeId}`,
    subtitle: "Money goes back to the customer",
    lines,
  })
}

/** `subscription_cancel`: when it ends, and what that changes. */
export function summarizeSubscriptionCancel(
  params: unknown,
  _ctx?: unknown,
  meta?: SummarizerMeta,
) {
  const p = rec(params)
  const id = String(p.subscriptionId ?? "")
  const effect = rec(meta?.context)
  const atPeriodEnd = p.atPeriodEnd !== false
  const lines = [
    atPeriodEnd ? "Ends at the end of the current period." : "Ends now.",
    typeof effect.mrrEffect === "string"
      ? effect.mrrEffect
      : "MRR effect unknown until the mirror holds it.",
    typeof effect.invoiceEffect === "string" ? effect.invoiceEffect : null,
    typeof effect.dealNote === "string" ? effect.dealNote : null,
  ].filter((l): l is string => typeof l === "string")
  return Promise.resolve({
    kind: "subscription_cancel",
    title: `Cancel ${effect.plan ? `${String(effect.plan)} (${id})` : id}`,
    subtitle: atPeriodEnd ? "At period end" : "Immediately",
    lines,
  })
}
