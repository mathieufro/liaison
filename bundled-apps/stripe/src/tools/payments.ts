// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `payments_search`: the mirror's charges, card as brand, last 4 and expiry.
// `id` returns that one charge. `unmatched` keeps the charges no invoice of the mirror explains. Failure
// messages come from Stripe, so the tool declares `taintSource`.
import { limitOf, offsetOf, pageOf, paymentItem, type ReadCtx, readPage } from "./read-common"

type Obj = Record<string, unknown>

export async function paymentsSearch(params: Obj | undefined, ctx: ReadCtx) {
  const p = params ?? {}
  const limit = limitOf(p.limit)
  const offset = offsetOf(p.cursor)
  const where: Obj = {}
  if (typeof p.id === "string" && p.id) where.stripe_id = p.id
  if (typeof p.customerId === "string" && p.customerId) where.customer_id = p.customerId
  if (typeof p.status === "string" && p.status) where.status = p.status
  if (typeof p.invoiceId === "string" && p.invoiceId) where.invoice_id = p.invoiceId
  if (p.unmatched === true) where.invoice_id = null
  const { rows, more } = await readPage(ctx, "stripe_payments", where, offset, limit, {
    created_at_stripe: "desc",
    id: "asc",
  })
  return pageOf(
    rows.map(paymentItem),
    rows,
    offset,
    limit,
    p.unmatched === true ? "unmatched payments" : "payments",
    more,
  )
}
