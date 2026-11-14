// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `disputes_list`: the mirror's disputes, read only (no tool answers or
// submits one). A dispute's reason is text the cardholder's bank or the
// customer set, so the tool declares `taintSource`.
import { disputeItem, limitOf, offsetOf, pageOf, type ReadCtx, readPage } from "./read-common"

type Obj = Record<string, unknown>

export async function disputesList(params: Obj | undefined, ctx: ReadCtx) {
  const p = params ?? {}
  const limit = limitOf(p.limit)
  const offset = offsetOf(p.cursor)
  const where: Obj = {}
  if (typeof p.status === "string" && p.status) where.status = p.status
  if (typeof p.customerId === "string" && p.customerId) {
    const pays = (await ctx.db.findMany("stripe_payments", {
      where: { customer_id: p.customerId },
      limit: 1000,
    })) as Obj[]
    where.payment_id = { in: pays.map((r) => String(r.stripe_id)) }
  }
  const { rows, more } = await readPage(ctx, "stripe_disputes", where, offset, limit, {
    created_at_stripe: "desc",
    id: "asc",
  })
  return pageOf(rows.map(disputeItem), rows, offset, limit, "disputes", more)
}
