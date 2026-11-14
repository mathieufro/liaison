// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hash of what one month-end row bills. It covers the draft's customer, currency, terms, notes,
// PO reference and lines; the row's own state, note, end date and pending "from now on" patch; and
// the issuer's legal and bank details. Any write a person or an agent makes to a row changes it, a
// change of the issuer's IBAN changes every row of that issuer, and a write that changes nothing
// leaves it as it was. The card carries it per row, approval records it, and the issue step checks
// it again before a number is taken.
import { sha256Hex } from "../einvoicing/backfill-sha256"
import { utf8Bytes } from "../legal-originals/bytes"

type Row = Record<string, unknown>

function day(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

function json(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value ?? null
}

/** The issuer's fields a row's invoice prints and is paid to. */
export function issuerSnapshot(issuer: Row | null | undefined): unknown[] {
  if (!issuer) return []
  return [
    issuer.legal_name,
    issuer.vat_id,
    issuer.siren,
    issuer.siret,
    issuer.legal_form,
    issuer.share_capital,
    issuer.rcs_city,
    issuer.address,
    issuer.address_line1,
    issuer.address_line2,
    issuer.postcode,
    issuer.city,
    issuer.country_code,
    issuer.iban,
    issuer.swift_bic,
    issuer.bank_name,
  ].map((v) => (v === undefined ? null : v))
}

export function itemContentHash(item: Row, draft: Row, lines: Row[], issuer: Row | null): string {
  const canonical = JSON.stringify({
    item: [
      item.id,
      item.state === "left_out" ? "left_out" : "in",
      item.schedule_id ?? null,
      item.schedule_version ?? null,
      item.note ?? null,
      day(item.ends_on_before),
      json(item.schedule_patch),
    ],
    draft: [
      draft.counterparty_contact_id ?? null,
      draft.counterparty_name ?? null,
      draft.counterparty_address ?? null,
      draft.counterparty_country ?? null,
      draft.counterparty_vat_id ?? null,
      draft.counterparty_email ?? null,
      draft.billing_line1 ?? null,
      draft.billing_postcode ?? null,
      draft.billing_city ?? null,
      draft.billing_country_code ?? null,
      draft.currency ?? null,
      day(draft.due_at),
      draft.notes ?? null,
      draft.po_number ?? null,
    ],
    lines: lines.map((l) => [
      String(l.description ?? ""),
      String(l.quantity ?? ""),
      String(l.unit_price_minor ?? ""),
      String(l.discount_minor ?? "0"),
      l.tax_rate_bp ?? null,
      l.line_kind ?? null,
    ]),
    issuer: issuerSnapshot(issuer),
  })
  return sha256Hex(utf8Bytes(canonical))
}

interface HashDb {
  db: {
    findOne(entity: string, id: string): Promise<unknown>
    findMany(entity: string, opts: Record<string, unknown>): Promise<unknown[]>
  }
}

/** The hash of a row as it stands now, read from the store. */
export async function currentItemHash(ctx: HashDb, item: Row, draft: Row): Promise<string> {
  const lines = (await ctx.db.findMany("document_lines", {
    where: { document_id: String(draft.id) },
    orderBy: { position: "asc" },
    limit: 500,
  })) as Row[]
  const issuer = (await ctx.db.findOne(
    "issuer_profiles",
    String(draft.issuer_profile_id),
  )) as Row | null
  return itemContentHash(item, draft, lines, issuer)
}
