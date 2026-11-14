// SPDX-License-Identifier: FSL-1.1-ALv2
// Customer kind derivation from the signals an issuing call carries, and the derived identity
// row it records. Never a guess: a French buyer without a signal stays unknown (null) unless the
// document comes from a checkout (Shopify), where no company and no VAT id means a consumer.

import { isUniqueViolation } from "../mutations/quote-proforma-po"
import type { CustomerKind } from "./classify"
import { LEGAL_FORM_TOKENS, sirenFromFrVat } from "./identity"

export interface DeriveKindInput {
  vat_id?: string | null
  /** The kernel contact's company, when the buyer is a linked contact. */
  company?: string | null
  legal_name?: string | null
  country?: string | null
  origin: "shopify" | "manual"
}

const LEGAL_SET = new Set(LEGAL_FORM_TOKENS)

function present(v: string | null | undefined): boolean {
  return typeof v === "string" && v.trim().length > 0
}

/** True when the name carries a legal-form token (SARL, SAS, GmbH, ...). */
export function hasLegalFormToken(name: string | null | undefined): boolean {
  return (name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .split(/[^a-z0-9]+/)
    .some((t) => t !== "" && LEGAL_SET.has(t))
}

/**
 * The customer kind the signals support, or null when they do not decide it:
 * - a VAT id or a company → `business`;
 * - a legal-form token in the name with no VAT id and no company → null (looks like a company,
 *   but nothing proves it: the caller must say);
 * - no signal, buyer outside France → `individual`;
 * - no signal, French buyer → `individual` only from a checkout, else null.
 */
export function deriveKind(input: DeriveKindInput): CustomerKind | null {
  if (present(input.vat_id) || present(input.company)) return "business"
  if (hasLegalFormToken(input.legal_name)) return null
  const country = (input.country ?? "").trim().toUpperCase()
  if (!country) return null
  if (country !== "FR") return "individual"
  return input.origin === "shopify" ? "individual" : null
}

interface IdentityDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; limit?: number },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<unknown>
}

/**
 * Record a derived identity for a contact that has none: the kind, and the SIREN read off a
 * French VAT id (unconfirmed until a registry check). An existing identity row is never touched.
 * Returns the inserted row's id, or null when nothing was written.
 */
export async function ensureDerivedIdentity(
  db: IdentityDb,
  input: {
    contact_id: string
    customer_kind: CustomerKind
    vat_id?: string | null
    billing_country?: string | null
  },
): Promise<string | null> {
  const existing = await db.findMany("counterparty_identities", {
    where: { contact_id: input.contact_id },
    limit: 1,
  })
  if (existing.length > 0) return null
  const siren =
    input.customer_kind === "business"
      ? sirenFromFrVat(input.vat_id, { billingCountry: input.billing_country })
      : null
  let row: { id?: unknown }
  try {
    row = (await db.insert("counterparty_identities", {
      contact_id: input.contact_id,
      customer_kind: input.customer_kind,
      siren,
      vat_id: present(input.vat_id) ? String(input.vat_id).trim() : null,
      source: "derived",
      confirmed_via: null,
      changed_at: new Date().toISOString(),
    })) as { id?: unknown }
  } catch (err) {
    // A concurrent writer (two issues for one customer at once) recorded the contact's identity
    // between the read and this insert: the contact has one now, and it is never touched.
    if (isUniqueViolation(err)) return null
    throw err
  }
  return row?.id != null ? String(row.id) : null
}
