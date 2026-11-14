// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `invoices_search`: the mirror's Stripe invoices. Descriptions and numbers come
// from Stripe, so the tool declares `taintSource`.
import { invoiceItem, limitOf, offsetOf, pageOf, type ReadCtx, readPage } from "./read-common"

type Obj = Record<string, unknown>

export async function invoicesSearch(params: Obj | undefined, ctx: ReadCtx) {
  const p = params ?? {}
  const limit = limitOf(p.limit)
  const offset = offsetOf(p.cursor)
  const where: Obj = {}
  if (typeof p.customerId === "string" && p.customerId) where.customer_id = p.customerId
  if (typeof p.status === "string" && p.status) where.status = p.status
  const { rows, more } = await readPage(ctx, "stripe_invoices", where, offset, limit, {
    finalized_at: "desc",
    id: "asc",
  })
  return pageOf(rows.map(invoiceItem), rows, offset, limit, "invoices", more)
}
