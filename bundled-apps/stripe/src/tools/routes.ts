// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hidden reads other parts of Liaison call:
//   - `approval_route_read`: which company a pending approval about a Stripe
//     customer, subscription or charge is for, so it goes to that company's
//     account manager;
//   - `billing_status_for_counterparty`: whether a contact or a company pays a
//     live Stripe subscription (invoicing's guard reads this one narrow tool);
//   - `invoice_document_link`: the Liaison document a Stripe invoice became;
import { refuseTool } from "@liaison/app-sdk/errors"
import { decodeState, type InstallRow, storedPermissions } from "../connection"
import { customerIdsFor, type ReadCtx, SCAN_CAP, UUID } from "./read-common"

type Obj = Record<string, unknown>

async function one(ctx: ReadCtx, entity: string, stripeId: string): Promise<Obj | undefined> {
  return ((await ctx.db.findMany(entity, { where: { stripe_id: stripeId }, limit: 1 })) as Obj[])[0]
}

export async function approvalRouteRead(params: Obj | undefined, ctx: ReadCtx) {
  const p = params ?? {}
  const type = String(p.entityType ?? "")
  const id = String(p.entityId ?? "")
  let customerId: string | null = null
  if (type === "customer") customerId = id
  else if (type === "subscription")
    customerId = ((await one(ctx, "stripe_subscriptions", id))?.customer_id as string) ?? null
  else if (type === "charge")
    customerId = ((await one(ctx, "stripe_payments", id))?.customer_id as string) ?? null
  const customer = customerId ? await one(ctx, "stripe_customers", customerId) : undefined
  const companyId = typeof customer?.company_id === "string" ? customer.company_id : null
  return { companyId, personId: null }
}

const LIVE = new Set(["trialing", "active", "past_due", "unpaid", "paused"])
/** The import rows whose answer the guard needs before it may say "no live subscription". */
const GUARD_RESOURCES = ["customers", "subscriptions"] as const

/**
 * Why the mirror cannot answer "no live subscription" yet, or null when it can: the connection is
 * fully connected, no overlay (a refused key, a missing read, a stall, another account) and the
 * customers and subscriptions imports are done. A mirror that is importing or partial would say
 * "none" for a customer Stripe bills, so the guard is told it cannot know.
 */
async function mirrorUnavailable(ctx: ReadCtx): Promise<string | null> {
  const install = ((await ctx.db.findMany("install_metadata", { limit: 1 })) as InstallRow[])[0]
  const { base, overlay } = decodeState(install?.state)
  if (base !== "connected")
    return `the Stripe connection is ${base.replace(/_/g, " ")}, not yet connected`
  if (overlay === "partial") {
    // A missing permission elsewhere (disputes, products) leaves this answer intact; a missing
    // customers or subscriptions read does not.
    const checks = storedPermissions(install ?? null)?.checks ?? null
    const unread = GUARD_RESOURCES.find(
      (r) => !checks?.some((c) => c.resource === r && c.level === "read" && c.state === "ok"),
    )
    if (unread) return `the Stripe key cannot read ${unread}`
  } else if (overlay) return `the Stripe connection is ${overlay.replace(/_/g, " ")}`
  for (const resource of GUARD_RESOURCES) {
    const row = (
      (await ctx.db.findMany("sync_state", { where: { resource }, limit: 1 })) as Obj[]
    )[0]
    if (row?.status !== "done")
      return `the import of Stripe ${resource} is ${String(row?.status ?? "not started")}`
  }
  return null
}

const emailKey = (v: unknown): string | null =>
  typeof v === "string" && v.includes("@") ? v.trim().toLowerCase() : null

/** Mirror customers with exactly one of these emails, linked or not (an unlinked customer still pays). */
async function customerIdsByEmail(ctx: ReadCtx, emails: string[]): Promise<string[]> {
  if (emails.length === 0) return []
  const wanted = new Set(emails)
  const out: string[] = []
  // Stripe keeps the email as typed, so the comparison folds case on both sides.
  for (let offset = 0; offset < SCAN_CAP; offset += 500) {
    const rows = (await ctx.db.findMany("stripe_customers", { limit: 500, offset })) as Obj[]
    for (const r of rows) {
      const e = emailKey(r.email)
      if (e && wanted.has(e) && r.deleted_at == null) out.push(String(r.stripe_id))
    }
    if (rows.length < 500) break
  }
  return out
}

export async function billingStatusForCounterparty(params: Obj | undefined, ctx: ReadCtx) {
  const p = params ?? {}
  const contactId =
    typeof p.contactId === "string" && UUID.test(p.contactId) ? p.contactId : undefined
  const companyId =
    typeof p.companyId === "string" && UUID.test(p.companyId) ? p.companyId : undefined
  const emails = [
    ...new Set(
      (Array.isArray(p.emails) ? p.emails : [])
        .map(emailKey)
        .filter((e): e is string => e !== null),
    ),
  ]
  // Not connected at all: nothing bills from Stripe, and the caller is told so (its own record of
  // the connection may have missed the event).
  const install = ((await ctx.db.findMany("install_metadata", { limit: 1 })) as Obj[])[0]
  if (decodeState(install?.state).base === "not_connected") {
    return { live: false, connected: false, unavailable: false, subscriptions: [], customerIds: [] }
  }
  const unavailable = await mirrorUnavailable(ctx)
  if (unavailable) {
    return {
      live: null,
      connected: true,
      unavailable: true,
      reason: unavailable,
      subscriptions: [],
      customerIds: [],
      summary: `Stripe cannot say yet whether this customer pays a subscription: ${unavailable}.`,
    }
  }
  const customerIds = [
    ...new Set([
      ...(contactId ? await customerIdsFor(ctx, { contactId }) : []),
      ...(companyId ? await customerIdsFor(ctx, { companyId }) : []),
      ...(await customerIdsByEmail(ctx, emails)),
    ]),
  ]
  if (customerIds.length === 0)
    return { live: false, connected: true, unavailable: false, subscriptions: [], customerIds: [] }
  const subs = (await ctx.db.findMany("stripe_subscriptions", {
    where: { customer_id: { in: customerIds } },
    limit: 100,
  })) as Obj[]
  const live = subs.filter((s) => LIVE.has(String(s.status)))
  return {
    live: live.length > 0,
    connected: true,
    unavailable: false,
    subscriptions: live.map((s) => ({ id: String(s.stripe_id), plan: String(s.plan_name ?? "") })),
    customerIds,
  }
}

export interface DocLinkCtx extends ReadCtx {
  db: ReadCtx["db"] & {
    update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  }
}

export async function invoiceDocumentLink(params: Obj | undefined, ctx: DocLinkCtx) {
  const p = params ?? {}
  const stripeInvoiceId = typeof p.stripeInvoiceId === "string" ? p.stripeInvoiceId : ""
  const documentId = typeof p.documentId === "string" && UUID.test(p.documentId) ? p.documentId : ""
  const issuedBy = p.issuedBy === "stripe" || p.issuedBy === "before_connection" ? p.issuedBy : ""
  if (!stripeInvoiceId || !documentId === !issuedBy) {
    return refuseTool(
      "invoice_link_invalid",
      "A Stripe invoice id and either a document id or who issued it (stripe, before_connection) are needed, so nothing was linked.",
    )
  }
  const row = await one(ctx, "stripe_invoices", stripeInvoiceId)
  if (!row) {
    return refuseTool(
      "invoice_not_found",
      `No Stripe invoice ${stripeInvoiceId} is in the mirror, so nothing was linked.`,
    )
  }
  if (!documentId) {
    // Invoicing examined it and issues no document for it: the safety job walks past it.
    await ctx.db.update("stripe_invoices", String(row.id), { issuer: issuedBy })
    return {
      ok: true,
      summary: `Stripe invoice ${stripeInvoiceId} is recorded as issued by ${issuedBy === "stripe" ? "Stripe" : "Stripe before the connection"}; no Liaison document follows it.`,
    }
  }
  const documentNumber =
    typeof p.documentNumber === "string" && p.documentNumber.trim()
      ? p.documentNumber.trim().slice(0, 64)
      : null
  await ctx.db.update("stripe_invoices", String(row.id), {
    liaison_document_id: documentId,
    issuer: "liaison",
    ...(documentNumber ? { liaison_document_number: documentNumber } : {}),
  })
  return {
    ok: true,
    summary: `Stripe invoice ${stripeInvoiceId} now names document ${documentNumber ?? documentId}.`,
  }
}

/** Record the credit note a Stripe refund became, or that invoicing makes none for it. */
export async function refundDocumentLink(params: Obj | undefined, ctx: DocLinkCtx) {
  const p = params ?? {}
  const stripeRefundId = typeof p.stripeRefundId === "string" ? p.stripeRefundId : ""
  const documentId = typeof p.documentId === "string" && UUID.test(p.documentId) ? p.documentId : ""
  const skipped = p.skipped === "issued_by_stripe" || p.skipped === "nothing_left" ? p.skipped : ""
  if (!stripeRefundId || !documentId === !skipped) {
    return refuseTool(
      "refund_link_invalid",
      "A Stripe refund id and either a document id or why no credit note follows (issued_by_stripe, nothing_left) are needed, so nothing was linked.",
    )
  }
  const row = await one(ctx, "stripe_refunds", stripeRefundId)
  if (!row) {
    return refuseTool(
      "refund_not_found",
      `No Stripe refund ${stripeRefundId} is in the mirror, so nothing was linked.`,
    )
  }
  if (!documentId) {
    await ctx.db.update("stripe_refunds", String(row.id), { liaison_skipped: skipped })
    return {
      ok: true,
      summary: `Stripe refund ${stripeRefundId} gets no credit note (${skipped}).`,
    }
  }
  await ctx.db.update("stripe_refunds", String(row.id), { liaison_document_id: documentId })
  return {
    ok: true,
    summary: `Stripe refund ${stripeRefundId} now names credit note ${documentId}.`,
  }
}
