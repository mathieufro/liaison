// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `saas-payment-recovered`: the money scenario's live event. The customer
// whose card failed adds a new card, and the payment goes through.
//
// As the processor would: the outside state first (a succeeded charge on the
// new card, the open invoice paid by it, the subscription active again), then
// the events the processor sends for them, each handed to the payments app's
// own webhook handler (`deliverDemoPaymentsEvent`, never the public webhook
// route). The handler reads every object back by id from the stand-in, which
// answers the outside state, and writes its mirror; invoicing hears the paid
// invoice and marks its document paid. Nothing here writes a mirror row, and
// nothing runs a model: the beat needs no verification.
//
// Fixed content and idempotent: the charge id is derived from the invoice, so
// a second pass writes the same objects and the app's ledger and mirror take
// them once. Once the invoice is paid there is nothing left to recover.
import { SAAS_PAYMENT_RECOVERED_INJECTOR } from "@liaison/shared"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { SAAS_ARLON_SUBSCRIPTION } from "~/seed/worlds/saas/plan"
import { deliverDemoPaymentsEvent, standInEvent } from "./payments/deliver"
import { dbMirrorSource } from "./payments/mirror-source"
import { ID, invoiceObject, subscriptionObject, unixOf } from "./payments/objects"
import { outsideObject, putOutsideObjects } from "./payments/overlay"

type Obj = Record<string, unknown>

/** The new card: a Visa again, valid for three more years. */
export function recoveredCard(now: Date): Obj {
  return {
    brand: "visa",
    last4: "4242",
    exp_month: 12,
    exp_year: now.getUTCFullYear() + 3,
  }
}

/** The charge that pays `invoiceId` on the new card. */
export function recoveredChargeId(invoiceId: string): string {
  return `ch_recovered_${invoiceId.replace(/^in_/, "")}`
}

const minor = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0)

/**
 * The customer's card recovers in `orgId`: the newest unpaid invoice of the
 * subscription is paid by a new card, and the subscription is active again.
 * Returns the invoice paid, or null when none was left unpaid.
 */
export async function recoverCustomerCard(
  orgId: string,
  subscriptionId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const mirror = dbMirrorSource(orgId)
  const install = await mirror.install()
  if (!install)
    throw new Error("demo payments: the payments app is not connected in this workspace")
  const livemode = install.livemode === true
  const subRow = await mirror.row("subscriptions", subscriptionId)
  if (!subRow) throw new Error(`demo payments: no subscription ${subscriptionId} in the mirror`)
  const open = (await mirror.rows("invoices"))
    .filter((r) => r.subscription_id === subscriptionId && r.status === "open")
    .sort((a, b) => (unixOf(b.finalized_at) ?? 0) - (unixOf(a.finalized_at) ?? 0))[0]
  if (!open) return null
  const invoiceId = String(open[ID])
  const already = await outsideObject(orgId, invoiceId)
  const at = Math.floor(now.getTime() / 1000)
  // A second pass keeps the first pass's payment time.
  const earlier =
    already?.status === "paid" ? (already.status_transitions as Obj | undefined)?.paid_at : null
  const paidAt = typeof earlier === "number" ? earlier : at
  const total = minor(open.total_minor)
  const chargeId = recoveredChargeId(invoiceId)
  const invoiceBase = invoiceObject(open, livemode)
  const charge: Obj = {
    id: chargeId,
    object: "charge",
    livemode,
    payment_intent: null,
    invoice: invoiceId,
    customer: invoiceBase.customer,
    amount: total,
    amount_refunded: 0,
    refunded: false,
    currency: invoiceBase.currency,
    status: "succeeded",
    failure_code: null,
    failure_message: null,
    payment_method_details: { type: "card", card: recoveredCard(now) },
    created: paidAt,
    disputed: false,
  }
  const invoice: Obj = {
    ...invoiceBase,
    status: "paid",
    amount_paid: total,
    amount_due: 0,
    charge: chargeId,
    next_payment_attempt: null,
    status_transitions: {
      ...((invoiceBase.status_transitions as Obj | undefined) ?? {}),
      paid_at: paidAt,
    },
  }
  // The subscription bills the new card from now on, as its default payment method says.
  const subscription: Obj = {
    ...subscriptionObject(subRow, livemode),
    status: "active",
    default_payment_method: {
      id: `pm_recovered_${subscriptionId.replace(/^sub_/, "")}`,
      object: "payment_method",
      type: "card",
      card: recoveredCard(now),
    },
  }
  await putOutsideObjects(orgId, [charge, invoice, subscription])
  // In the processor's order: the charge, the invoice it paid, the subscription it revived.
  for (const [type, object] of [
    ["charge.succeeded", charge],
    ["invoice.paid", invoice],
    ["customer.subscription.updated", subscription],
  ] as const) {
    await deliverDemoPaymentsEvent(
      orgId,
      standInEvent(type, { id: object.id, object: object.object, livemode }, now),
    )
  }
  return invoiceId
}

export const paymentRecoveredInjector: WorldInjector = {
  id: SAAS_PAYMENT_RECOVERED_INJECTOR,
  world: "saas",
  // A payment the processor reports: no agent turn, no routine, no spend.
  spends: false,
  async injectWorldEvent(ctx) {
    await recoverCustomerCard(ctx.orgId, SAAS_ARLON_SUBSCRIPTION)
  },
}
