// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which Liaison contact and company a Stripe customer is, in a fixed order:
//   1. its exact email names a contact (through `ctx.resolveContact`);
//   2. that contact's company is the customer's company;
//   3. else a contact carrying this customer's id in `external_ids.stripe`.
// A company whose domain is the email's domain is only a suggestion: the link
// stays empty until a person makes it. A free-mail address (gmail.com and the
// like) never names a company, not even as a suggestion. A link a person made
// (`match_method: person`) is never replaced by a match.
//
// A Stripe customer's email is typed by whoever pays and is never verified, so
// it never links the customer to a contact that already exists: an existing
// contact with that email is a suggestion a person confirms (`customer_link`),
// and nothing is written to the customer or the contact. Only an email that
// names no contact yet creates one, linked to the customer.
import type { CrossAppEnvelope } from "@liaison/app-sdk"
import { isConsumerMailDomain } from "./consumer-domains"

export type MatchMethod = "email" | "contact_company" | "external_id"

export interface MatchContact {
  id: string
  companyId: string | null
}

export interface MatchDeps {
  /** The contact whose email is exactly this address, or null. */
  contactByEmail(email: string): Promise<MatchContact | null>
  /** The contact carrying this Stripe customer id, or null. */
  contactByExternalId(stripeId: string): Promise<MatchContact | null>
  /** A company on this domain, or null. Only ever a suggestion. */
  companyByDomain?(domain: string): Promise<{ id: string; name: string } | null>
}

export interface MatchResult {
  contactId: string | null
  companyId: string | null
  method: MatchMethod | null
  /** A company on the email's domain, for a person to confirm. Never written by the match. */
  suggestion: { companyId: string; name: string; domain: string } | null
  /** An existing contact with the customer's email, for a person to confirm. Never written by the match. */
  contactSuggestion?: { contactId: string; email: string } | null
}

const NONE: MatchResult = { contactId: null, companyId: null, method: null, suggestion: null }

/** The domain of an address, lower-cased, or null. */
export function emailDomain(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null
  const at = email.lastIndexOf("@")
  if (at <= 0) return null
  const d = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
  return d.includes(".") ? d : null
}

export async function matchCustomer(
  customer: { stripe_id: string; email?: string | null },
  deps: MatchDeps,
): Promise<MatchResult> {
  const email = typeof customer.email === "string" ? customer.email.trim() : ""
  const domain = emailDomain(email)
  const free = domain !== null && isConsumerMailDomain(domain)

  let contact: MatchContact | null = null
  let method: MatchMethod | null = null
  if (email.includes("@")) {
    contact = await deps.contactByEmail(email)
    if (contact) method = contact.companyId ? "contact_company" : "email"
  }
  if (!contact) {
    contact = await deps.contactByExternalId(customer.stripe_id)
    if (contact) method = "external_id"
  }
  const companyId = contact?.companyId ?? null

  let suggestion: MatchResult["suggestion"] = null
  if (!companyId && domain && !free && deps.companyByDomain) {
    const company = await deps.companyByDomain(domain)
    if (company) suggestion = { companyId: company.id, name: company.name, domain }
  }
  if (!contact) return { ...NONE, suggestion }
  return { contactId: contact.id, companyId, method, suggestion }
}

type Obj = Record<string, unknown>

export interface MatchRunCtx {
  db: {
    findMany(
      entity: string,
      opts?: { where?: Record<string, unknown>; limit?: number },
    ): Promise<unknown[]>
    update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  }
  resolveContact(params: { email?: string; name?: string; externalId?: string }): Promise<unknown>
  executeTool?(tool: string, params: Record<string, unknown>): Promise<CrossAppEnvelope>
}

/**
 * The existing contact whose email is exactly `email`, through the kernel's contact search (a
 * read: nothing is created or changed). Null when there is none; "unknown" when the search could
 * not run, so the caller links nothing.
 */
export async function existingContactByEmail(
  ctx: Pick<MatchRunCtx, "executeTool">,
  email: string,
): Promise<{ id: string } | null | "unknown"> {
  if (!ctx.executeTool) return "unknown"
  const wanted = email.trim().toLowerCase()
  try {
    const env = await ctx.executeTool("kernel:contacts_search", { query: wanted, limit: 20 })
    if (env.status !== "completed") return "unknown"
    const items = ((env.result as { items?: unknown } | null)?.items ?? []) as Obj[]
    const hit = items.find(
      (c) => typeof c.primaryEmail === "string" && c.primaryEmail.trim().toLowerCase() === wanted,
    )
    return hit && typeof hit.id === "string" ? { id: hit.id } : null
  } catch {
    return "unknown"
  }
}

function asContact(raw: unknown): MatchContact | null {
  const c = (typeof raw === "string" ? JSON.parse(raw) : raw) as Obj | null
  if (!c || typeof c.id !== "string") return null
  const company = c.companyId ?? c.company_id
  return { id: c.id, companyId: typeof company === "string" ? company : null }
}

/**
 * Match one mirrored customer and write the link when it changed. A person's
 * link is never replaced, and a link is never removed because a match found
 * nothing: only a person unlinks.
 */
export async function runCustomerMatch(
  stripeId: unknown,
  ctx: MatchRunCtx,
): Promise<MatchResult | null> {
  if (typeof stripeId !== "string" || !stripeId) return null
  const row = (
    (await ctx.db.findMany("stripe_customers", {
      where: { stripe_id: stripeId },
      limit: 1,
    })) as Obj[]
  )[0]
  if (!row || row.deleted_at != null || row.match_method === "person") return null
  const name = typeof row.name === "string" && row.name ? row.name : undefined
  const email = typeof row.email === "string" ? row.email.trim() : ""
  if (email.includes("@")) {
    const existing = await existingContactByEmail(ctx, email)
    // The search could not run: link and create nothing now; the next change of the customer retries.
    if (existing === "unknown") return null
    if (existing && existing.id !== row.contact_id) {
      return { ...NONE, contactSuggestion: { contactId: existing.id, email: email.toLowerCase() } }
    }
  }
  const result = await matchCustomer(
    { stripe_id: stripeId, email: typeof row.email === "string" ? row.email : null },
    {
      contactByEmail: async (email) =>
        asContact(await ctx.resolveContact({ email, name, externalId: stripeId })),
      contactByExternalId: async (id) =>
        asContact(await ctx.resolveContact({ externalId: id, name })),
    },
  )
  if (!result.contactId) return result
  const companyId = result.companyId ?? (typeof row.company_id === "string" ? row.company_id : null)
  if (
    row.contact_id === result.contactId &&
    row.company_id === companyId &&
    row.match_method === result.method
  )
    return result
  await ctx.db.update("stripe_customers", String(row.id), {
    contact_id: result.contactId,
    company_id: companyId,
    match_method: result.method,
    match_by: null,
  })
  return result
}
