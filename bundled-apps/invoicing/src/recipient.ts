// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who a document is made out to, read from the customer's own records at the time the draft is
// made: the company's name when the customer is a company (else the contact's company, else the
// contact's name, as the editor's contact picker fills it), the contact's email, its billing
// address (else its first one) and the VAT number and customer kind recorded for the contact.
// Never copied from an earlier document: a draft made today bills the customer as it is today.
import type { CrossAppExecuteTool } from "./cross-app"
import type { IssueDb } from "./issue"

export interface RecipientCtx {
  db: Pick<IssueDb, "findMany">
  executeTool?: CrossAppExecuteTool
}

export interface Recipient {
  counterparty_name: string | null
  counterparty_address: string | null
  counterparty_country: string | null
  counterparty_vat_id: string | null
  counterparty_email: string | null
  customer_kind: string | null
  /** The same address, field by field: the e-invoice (its Factur-X and its gate) reads these. */
  billing_line1: string | null
  billing_line2: string | null
  billing_postcode: string | null
  billing_city: string | null
  billing_country_code: string | null
}

type Row = Record<string, unknown>

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null

/** A kernel read through the app's tool bridge; null when it is absent or fails. */
async function kernelRead(
  ctx: RecipientCtx,
  tool: string,
  params: Record<string, unknown>,
): Promise<Row | null> {
  if (!ctx.executeTool) return null
  try {
    const env = await ctx.executeTool(tool, params)
    return env.status === "completed" && env.result && typeof env.result === "object"
      ? (env.result as Row)
      : null
  } catch {
    return null
  }
}

/** A contact's billing address (else its first one) as a one-line address and its country. */
interface BillingAddress {
  line: string
  country: string | null
  line1: string | null
  line2: string | null
  postcode: string | null
  city: string | null
}

async function billingAddress(
  ctx: RecipientCtx,
  contactId: string,
): Promise<BillingAddress | null> {
  const list = (await kernelRead(ctx, "kernel:contacts_addresses_list", { contactId }))?.addresses
  const all = (Array.isArray(list) ? list : []) as Row[]
  const a = all.find((x) => x.role === "billing") ?? all[0]
  if (!a) return null
  const city = [text(a.postalCode), text(a.city)].filter(Boolean).join(" ")
  const line = [text(a.street1), text(a.street2), city].filter(Boolean).join(", ")
  if (!line) return null
  return {
    line,
    country: text(a.countryIso2)?.toUpperCase() ?? null,
    line1: text(a.street1),
    line2: text(a.street2),
    postcode: text(a.postalCode),
    city: text(a.city),
  }
}

/**
 * The recipient of a draft for this customer, as its records read now. An unreadable contact or
 * company leaves its fields empty, so the draft says what is missing instead of guessing.
 */
export async function recipientOf(
  ctx: RecipientCtx,
  who: { contactId: string | null; companyId: string | null },
): Promise<Recipient> {
  const contactId = text(who.contactId)
  const companyId = text(who.companyId)
  const contact = (
    contactId ? ((await kernelRead(ctx, "kernel:contacts_read", { contactId }))?.contact ?? {}) : {}
  ) as Row
  const companyName = companyId
    ? text(
        (
          (await kernelRead(ctx, "kernel:companies_read", { companyId }))?.company as
            | Row
            | undefined
        )?.name,
      )
    : null
  const identity = contactId
    ? (
        (await ctx.db.findMany("counterparty_identities", {
          where: { contact_id: contactId },
          limit: 1,
        })) as Row[]
      )[0]
    : undefined
  const address = contactId ? await billingAddress(ctx, contactId) : null
  return {
    counterparty_name:
      companyName ?? text(contact.company) ?? text(contact.name) ?? text(contact.displayName),
    counterparty_address: address?.line ?? null,
    counterparty_country: address?.country ?? text(identity?.establishment_country),
    counterparty_vat_id: text(identity?.vat_id),
    counterparty_email: text(contact.email),
    customer_kind: text(identity?.customer_kind) ?? (companyName ? "business" : null),
    billing_line1: address?.line1 ?? null,
    billing_line2: address?.line2 ?? null,
    billing_postcode: address?.postcode ?? null,
    billing_city: address?.city ?? null,
    billing_country_code: address?.country ?? null,
  }
}
