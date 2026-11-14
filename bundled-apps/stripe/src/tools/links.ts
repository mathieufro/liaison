// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `card_update_link`: a Stripe-hosted page where a customer can pay with a new
// card, by a ladder, first that applies:
//   1. the customer portal's login link an admin pasted (`portalLoginUrl`):
//      they sign in by email on a Stripe page and replace the card;
//   2. the hosted page of the customer's open invoice: it pays THAT invoice with
//      a new card, and later renewals may still use the old card (Stripe keeps a
//      new card only when no default exists). A link older than 30 days is read
//      again from Stripe first;
//   3. none, with the reason.
// `effect` is the sentence that is true for the rung used, so a reminder says
// exactly what the link does. Only Stripe's own hosts are returned, and the
// link is never written anywhere: not to the mirror, not to a log. A stand-in
// install (the demo's, `standin.ts`) returns its own host instead, and only it.
import { stripeFetch } from "../http"
import { readStandIn, STANDIN_HOSTED_INVOICE, STANDIN_PORTAL_LOGIN } from "../standin"
import { type ReadCtx, str } from "./read-common"

type Obj = Record<string, unknown>

export interface CardLinkCtx extends ReadCtx {
  fetch: Parameters<typeof stripeFetch>[0]["fetch"]
  config?: { get(key: string): Promise<unknown> }
  now?: () => Date
}

export const PORTAL_LOGIN = /^https:\/\/billing\.stripe\.com\/p\/login\/[A-Za-z0-9_-]+$/
const HOSTED_INVOICE = /^https:\/\/invoice\.stripe\.com\//
const STALE_MS = 30 * 24 * 60 * 60 * 1000

export const EFFECT = {
  portal_login: "They sign in by email on a Stripe page and replace the card.",
  hosted_invoice: "Pays this invoice with a new card. Later renewals may still use the old card.",
} as const

export async function cardUpdateLink(params: Obj | undefined, ctx: CardLinkCtx) {
  const customerId = typeof params?.customerId === "string" ? params.customerId.trim() : ""
  if (!/^cus_[A-Za-z0-9_]+$/.test(customerId)) {
    const why = "No Stripe customer (cus_...) was named. Next step: find it with customers_search."
    return { url: null, kind: null, effect: null, why, summary: why }
  }
  const standIn = await readStandIn(ctx.db)
  const portalHost = standIn ? STANDIN_PORTAL_LOGIN : PORTAL_LOGIN
  const invoiceHost = standIn ? STANDIN_HOSTED_INVOICE : HOSTED_INVOICE
  const portal = str(await ctx.config?.get("portalLoginUrl").catch(() => null))
  if (portal && portalHost.test(portal)) {
    return {
      url: portal,
      kind: "portal_login",
      effect: EFFECT.portal_login,
      summary: `Customer ${customerId} can replace the card through the customer portal login link. ${EFFECT.portal_login}`,
    }
  }
  const open = (await ctx.db.findMany("stripe_invoices", {
    where: { customer_id: customerId, status: "open" },
    orderBy: { finalized_at: "desc" },
    limit: 1,
  })) as Obj[]
  let invoice: Obj | undefined = open[0]
  if (invoice) {
    const finalized = Date.parse(String(invoice.finalized_at ?? ""))
    const now = (ctx.now?.() ?? new Date()).getTime()
    if (!Number.isFinite(finalized) || now - finalized > STALE_MS) {
      // An old link is read again: the invoice may be paid, voided, or its page renewed.
      try {
        const live = await stripeFetch<Obj>(
          ctx,
          `/v1/invoices/${encodeURIComponent(String(invoice.stripe_id))}`,
        )
        invoice =
          live.status === "open"
            ? { ...invoice, hosted_invoice_url: live.hosted_invoice_url }
            : undefined
      } catch {
        invoice = undefined
      }
    }
  }
  const hosted = str(invoice?.hosted_invoice_url)
  if (invoice && hosted && invoiceHost.test(hosted)) {
    const number = String(invoice.number ?? invoice.stripe_id)
    return {
      url: hosted,
      kind: "hosted_invoice",
      effect: EFFECT.hosted_invoice,
      invoiceId: String(invoice.stripe_id),
      summary: `The link is the Stripe page of open invoice ${number}. ${EFFECT.hosted_invoice}`,
    }
  }
  const why = `No link for customer ${customerId}: no customer portal login link is set and the customer has no open invoice with a Stripe page. Next step: turn on the customer portal in Stripe and paste its login link in the Stripe settings.`
  // Every answer carries the same fields (the manifest's `returns`), a "no link" one too.
  return { url: null, kind: null, effect: null, why, summary: why }
}
