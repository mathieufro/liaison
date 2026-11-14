// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `customer_context` (hidden, a context provider): a few lines the agent reads
// when a ticket, a contact or a company with a linked Stripe customer is open.
// Plan, status, card brand and last 4, and the unpaid invoices: masked fields
// only, at most 10 lines. A ticket names its contact through the tickets app's
// own read, as the person whose turn it is.
import { customerIdsFor, iso, type ReadCtx, syncedAt, UUID } from "./read-common"

type Obj = Record<string, unknown>

export const CONTEXT_MAX_LINES = 10
const SUBS_SHOWN = 3
const INVOICES_SHOWN = 3

const TICKET_KINDS = new Set(["tickets:ticket"])
const CONTACT_KINDS = new Set(["kernel:contact", "contacts:contact-detail"])
const COMPANY_KINDS = new Set(["kernel:company", "contacts:company-detail"])

/** The tab kinds the kernel may hand this provider (`contextProviders[].on`). */
export const CONTEXT_KINDS = [...TICKET_KINDS, ...CONTACT_KINDS, ...COMPANY_KINDS]

function money(minor: unknown, currency: unknown): string {
  const n = Number(minor)
  if (!Number.isFinite(n)) return ""
  return `${(n / 100).toFixed(2)} ${String(currency ?? "").toUpperCase()}`.trim()
}

async function ticketContact(ctx: ReadCtx, ticketId: string): Promise<string | null> {
  if (!ctx.executeTool) return null
  try {
    const env = await ctx.executeTool("tickets:get", { ticketId, messagesLimit: 1 })
    if (env.status !== "completed") return null
    const r = (env.result ?? {}) as Obj
    const t = (r.ticket ?? r) as Obj
    const id = t.contactId ?? t.contact_id
    return typeof id === "string" && UUID.test(id) ? id : null
  } catch {
    return null
  }
}

export async function customerContext(params: Obj | undefined, ctx: ReadCtx) {
  const subject = ((params ?? {}).subject ?? {}) as {
    app?: string
    entityType?: string
    entityId?: string
  }
  const kind = `${subject.app}:${subject.entityType}`
  const id = String(subject.entityId ?? "")
  if (!UUID.test(id)) return { lines: [] }
  let customerIds: string[] = []
  if (TICKET_KINDS.has(kind)) {
    const contactId = await ticketContact(ctx, id)
    if (contactId) customerIds = await customerIdsFor(ctx, { contactId })
  } else if (CONTACT_KINDS.has(kind)) {
    customerIds = await customerIdsFor(ctx, { contactId: id })
  } else if (COMPANY_KINDS.has(kind)) {
    customerIds = await customerIdsFor(ctx, { companyId: id })
  }
  if (customerIds.length === 0) return { lines: [] }
  const subs = (await ctx.db.findMany("stripe_subscriptions", {
    where: { customer_id: { in: customerIds } },
    orderBy: { current_period_end: "desc" },
    limit: 20,
  })) as Obj[]
  const live = subs.filter((s) => s.status !== "canceled" && s.status !== "incomplete_expired")
  const unpaid = (await ctx.db.findMany("stripe_invoices", {
    where: { customer_id: { in: customerIds }, status: "open" },
    limit: 20,
  })) as Obj[]
  const lines: string[] = [
    `Stripe customer ${customerIds.slice(0, 2).join(", ")}${customerIds.length > 2 ? ` +${customerIds.length - 2}` : ""}: ${live.length} live subscription${live.length === 1 ? "" : "s"}, ${unpaid.length} unpaid invoice${unpaid.length === 1 ? "" : "s"}.`,
  ]
  for (const s of live.slice(0, SUBS_SHOWN)) {
    const card = s.card_last4
      ? `, ${String(s.card_brand ?? "card")} ending ${String(s.card_last4)}`
      : ""
    const since = iso(s.past_due_since)
    lines.push(
      `${String(s.plan_name ?? "Plan")}: ${String(s.status)}${since ? ` since ${since.slice(0, 10)}` : ""}${card}.`,
    )
  }
  for (const i of unpaid.slice(0, INVOICES_SHOWN)) {
    const retry = iso(i.next_payment_attempt)
    lines.push(
      `Unpaid ${String(i.number ?? i.stripe_id)}: ${money(i.amount_due_minor, i.currency)} due${retry ? `, next retry ${retry.slice(0, 10)}` : ""}.`,
    )
  }
  const more = Math.max(0, live.length - SUBS_SHOWN) + Math.max(0, unpaid.length - INVOICES_SHOWN)
  if (more > 0) lines.push(`${more} more in Stripe: customers_get has them all.`)
  return {
    lines: lines.slice(0, CONTEXT_MAX_LINES),
    customerIds: customerIds.slice(0, 5),
    source: { label: "Stripe", syncedAt: syncedAt([...subs, ...unpaid]) },
  }
}
