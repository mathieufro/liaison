// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `customers_search` and `customers_get`: the mirror's customers, masked (no
// address, no tax id; a card is its brand, last 4 and expiry). Names, emails
// and descriptions are text a paying customer wrote, so both tools declare
// `taintSource`. The app database answers equality and `in` only: an id or an
// email is one exact read, a name is matched over at most `SCAN_CAP` rows.
import { refuseTool } from "@liaison/app-sdk/errors"
import { existingContactByEmail, matchCustomer } from "../match"
import {
  customerIdsFor,
  customerItem,
  invoiceItem,
  limitOf,
  offsetOf,
  pageOf,
  type ReadCtx,
  readPage,
  SCAN_CAP,
  subscriptionItem,
  syncedAt,
  UUID,
} from "./read-common"

type Obj = Record<string, unknown>

const SUB_FILTER: Record<string, string> = {
  past_due: "past_due",
  trial: "trialing",
  cancelled: "canceled",
}

async function customerIdsWithStatus(ctx: ReadCtx, status: string): Promise<string[]> {
  const rows = (await ctx.db.findMany("stripe_subscriptions", {
    where: { status },
    limit: 1000,
  })) as Obj[]
  return [...new Set(rows.map((r) => String(r.customer_id)))]
}

export async function customersSearch(params: Obj | undefined, ctx: ReadCtx) {
  const p = params ?? {}
  const limit = limitOf(p.limit)
  const offset = offsetOf(p.cursor)
  const query = typeof p.query === "string" ? p.query.trim() : ""
  const filter = typeof p.filter === "string" ? p.filter : ""
  const where: Obj = {}
  if (filter === "unlinked") {
    where.company_id = null
    where.contact_id = null
  } else if (SUB_FILTER[filter]) {
    where.stripe_id = { in: await customerIdsWithStatus(ctx, SUB_FILTER[filter] as string) }
  }
  if (query.startsWith("cus_")) {
    where.stripe_id = query
  } else if (query.includes("@")) {
    where.email = { in: [...new Set([query, query.toLowerCase()])] }
  } else if (query) {
    // A name: scan the mirror in a fixed order and keep the rows that contain it.
    const needle = query.toLowerCase()
    const hits: Obj[] = []
    for (let at = 0; at < SCAN_CAP; at += 1000) {
      const batch = (await ctx.db.findMany("stripe_customers", {
        where,
        orderBy: { name: "asc", id: "asc" },
        limit: 1000,
        offset: at,
      })) as Obj[]
      for (const r of batch)
        if (
          String(r.name ?? "")
            .toLowerCase()
            .includes(needle)
        )
          hits.push(r)
      if (batch.length < 1000) break
    }
    const rows = hits.slice(offset, offset + limit)
    return pageOf(
      rows.map(customerItem),
      rows,
      offset,
      limit,
      "customers",
      hits.length > offset + limit,
    )
  }
  const { rows, more } = await readPage(ctx, "stripe_customers", where, offset, limit, {
    name: "asc",
    id: "asc",
  })
  return pageOf(rows.map(customerItem), rows, offset, limit, "customers", more)
}

/** A company on this domain the caller can read, through the kernel's company search. */
async function companyOnDomain(
  ctx: ReadCtx,
  domain: string,
): Promise<{ id: string; name: string } | null> {
  if (!ctx.executeTool) return null
  try {
    const env = await ctx.executeTool("kernel:companies_search", { query: domain, limit: 5 })
    if (env.status !== "completed") return null
    const items = ((env.result as { items?: unknown } | null)?.items ?? []) as Obj[]
    const hit = items.find((c) => typeof c.domain === "string" && c.domain.toLowerCase() === domain)
    return hit && typeof hit.id === "string" ? { id: hit.id, name: String(hit.name ?? "") } : null
  } catch {
    return null
  }
}

export async function customersGet(params: Obj | undefined, ctx: ReadCtx) {
  const p = params ?? {}
  let row: Obj | undefined
  if (typeof p.id === "string" && p.id) {
    // A Stripe id (cus_...), or the row's own id, which is what a customer page's address carries.
    const where = UUID.test(p.id) ? { id: p.id } : { stripe_id: p.id }
    row = ((await ctx.db.findMany("stripe_customers", { where, limit: 1 })) as Obj[])[0]
  } else if (typeof p.contactId === "string" && UUID.test(p.contactId)) {
    const [id] = await customerIdsFor(ctx, { contactId: p.contactId })
    if (id)
      row = (
        (await ctx.db.findMany("stripe_customers", { where: { stripe_id: id }, limit: 1 })) as Obj[]
      )[0]
  } else if (typeof p.companyId === "string" && UUID.test(p.companyId)) {
    const [id] = await customerIdsFor(ctx, { companyId: p.companyId })
    if (id)
      row = (
        (await ctx.db.findMany("stripe_customers", { where: { stripe_id: id }, limit: 1 })) as Obj[]
      )[0]
  } else {
    return refuseTool(
      "customer_ref_missing",
      "No customer was named, so nothing was read. Next step: pass a Stripe customer id (id), a contactId or a companyId.",
    )
  }
  if (!row) {
    // A contact or company with no Stripe customer is an answer, not a failure: it is
    // not billed in Stripe (a prospect, or billed another way). Only a named Stripe id
    // that matches nothing is refused.
    const named =
      typeof p.contactId === "string"
        ? "contact"
        : typeof p.companyId === "string"
          ? "company"
          : null
    if (named) {
      return {
        customer: null,
        subscriptions: [],
        openInvoices: [],
        suggestion: null,
        contactSuggestion: null,
        syncedAt: null,
        summary: `No Stripe customer is linked to this ${named}, so it has no subscription or invoice in Stripe. If it does pay by card, find the customer with customers_search and a person links it with customer_link.`,
      }
    }
    return refuseTool(
      "customer_not_found",
      "No Stripe customer in the mirror matches that, so nothing was read. Next step: search with customers_search, or link the customer to the contact or company first.",
    )
  }
  const stripeId = String(row.stripe_id)
  const subs = (await ctx.db.findMany("stripe_subscriptions", {
    where: { customer_id: stripeId },
    orderBy: { current_period_end: "desc" },
    limit: 20,
  })) as Obj[]
  const invoices = (await ctx.db.findMany("stripe_invoices", {
    where: { customer_id: stripeId, status: "open" },
    limit: 20,
  })) as Obj[]
  const linked = row.company_id != null || row.contact_id != null
  // Only the domain lookup runs here: a read suggests, it never links.
  const suggestion = linked
    ? null
    : (
        await matchCustomer(
          { stripe_id: stripeId, email: typeof row.email === "string" ? row.email : null },
          {
            contactByEmail: async () => null,
            contactByExternalId: async () => null,
            companyByDomain: async (d) => companyOnDomain(ctx, d),
          },
        )
      ).suggestion
  // The customer's email is not verified: a contact with that email is shown for a person to confirm.
  let contactSuggestion: { contactId: string; email: string } | null = null
  if (!linked && typeof row.email === "string" && row.email.includes("@")) {
    const existing = await existingContactByEmail(ctx, row.email)
    if (existing && existing !== "unknown")
      contactSuggestion = { contactId: existing.id, email: row.email.trim().toLowerCase() }
  }
  const all = [row, ...subs, ...invoices]
  const customer = customerItem(row)
  return {
    customer,
    subscriptions: subs.map(subscriptionItem),
    openInvoices: invoices.map(invoiceItem),
    suggestion,
    contactSuggestion,
    syncedAt: syncedAt(all),
    summary: `Stripe customer ${stripeId}${customer.name ? ` (${customer.name})` : ""}: ${subs.length} subscription${subs.length === 1 ? "" : "s"}, ${invoices.length} open invoice${invoices.length === 1 ? "" : "s"}, ${linked ? "linked" : "not linked to a contact or company"}. From the Stripe mirror${syncedAt(all) ? `, last synced ${syncedAt(all)}` : ""}.${contactSuggestion ? ` Its email is not verified: contact ${contactSuggestion.contactId} has this email; if it is them, a person links it with customer_link.` : ""}`,
  }
}
