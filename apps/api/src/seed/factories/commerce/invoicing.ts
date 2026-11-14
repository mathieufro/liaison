// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The invoicing factory: an issuer profile with its tax regimes, and a
// trading history of documents and lines, computed with the app's own money
// and numbering rules and written in the app's own row shape.
//
// Privileged: the invoicing app's tables are written by its handlers inside
// the sandbox as documents are issued and paid over time; a seeded org needs
// that history at once, so the rows go in over the system connection through
// the one app-table writer (`upsertAppRow`). The app's number sequences live in
// the kernel's `app_sequences` and are advanced through Drizzle in the same
// transaction.
//
// Issued documents carry `pdf_status = 'pending'` and no file: the app's own
// "render me on demand" state, so the PDF a person asks for is rendered by the
// real template path.
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appSequences } from "~/db/schema/kernel/app-sequences"
import type { SeedContext } from "~/seed/context"
import { type AppCell, iso, jsonCell, type SeedTx, shiftTime, upsertAppRow } from "../app-tables"

// ── Money ────────────────────────────────────────────────────────────────────
//
// Mirrors `bundled-apps/invoicing/src/money.ts`: integer minor units, tax
// re-derived per line from the line subtotal and the rate with round half to
// even. Re-implemented rather than imported because the bundled app is a
// separate package that may not import kernel code and vice versa.
function divRoundHalfEven(numerator: bigint, divisor: bigint): bigint {
  const negative = numerator < 0n !== divisor < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = divisor < 0n ? -divisor : divisor
  const quotient = n / d
  const remainder = n - quotient * d
  const doubled = remainder * 2n
  let rounded: bigint
  if (doubled < d) rounded = quotient
  else if (doubled > d) rounded = quotient + 1n
  else rounded = quotient % 2n === 0n ? quotient : quotient + 1n
  return negative ? -rounded : rounded
}
function lineTax(subtotalMinor: bigint, taxRateBp: number): bigint {
  if (taxRateBp === 0) return 0n
  return divRoundHalfEven(subtotalMinor * BigInt(taxRateBp), 10_000n)
}

// ── Tax classification for a FRENCH issuer ───────────────────────────────────
//
// The four branches `bundled-apps/invoicing/src/tax.ts` takes for an FR issuer.
const EU_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
])

export interface TaxVerdict {
  treatment: string
  rateBp: number
  requiresHsCode: boolean
}

/** Standard VAT rate per EU member state, in basis points (bundled-apps/invoicing/src/tax.ts). */
const EU_STANDARD_RATE_BP: Readonly<Record<string, number>> = {
  AT: 2000,
  BE: 2100,
  BG: 2000,
  HR: 2500,
  CY: 1900,
  CZ: 2100,
  DK: 2500,
  EE: 2400,
  FI: 2550,
  FR: 2000,
  DE: 1900,
  GR: 2400,
  HU: 2700,
  IE: 2300,
  IT: 2200,
  LV: 2100,
  LT: 2100,
  LU: 1700,
  MT: 1800,
  NL: 2100,
  PL: 2300,
  PT: 2300,
  RO: 2100,
  SK: 2300,
  SI: 2200,
  ES: 2100,
  SE: 2500,
}

export function classifyForFrenchIssuer(country: string, hasVatId: boolean): TaxVerdict {
  const c = country.toUpperCase()
  if (c === "FR") return { treatment: "eu_domestic", rateBp: 2000, requiresHsCode: false }
  if (EU_COUNTRIES.has(c)) {
    if (hasVatId) return { treatment: "eu_reverse_charge", rateBp: 0, requiresHsCode: false }
    // A consumer in another member state pays THAT country's VAT (OSS), at its
    // standard rate: the same table the invoicing classifier uses.
    return {
      treatment: "eu_b2c_oss",
      rateBp: EU_STANDARD_RATE_BP[c] ?? 2000,
      requiresHsCode: false,
    }
  }
  return { treatment: "eu_export_non_eu", rateBp: 0, requiresHsCode: true }
}

/** The tax regimes an FR issuer's documents are classified into, with their legal mentions. */
export const FRENCH_ISSUER_TAX_REGIMES: {
  treatment: string
  rateBp: number
  requiresHsCode: boolean
  en: string
  fr: string
}[] = [
  {
    treatment: "eu_domestic",
    rateBp: 2000,
    requiresHsCode: false,
    en: "VAT charged at the standard French rate.",
    fr: "TVA au taux normal francais.",
  },
  {
    treatment: "eu_reverse_charge",
    rateBp: 0,
    requiresHsCode: false,
    en: "Reverse charge: VAT due by the recipient.",
    fr: "Autoliquidation: TVA due par le preneur.",
  },
  {
    treatment: "eu_b2c_oss",
    rateBp: 2000,
    requiresHsCode: false,
    en: "Intra EU distance sale, VAT declared under the One Stop Shop.",
    fr: "Vente a distance intracommunautaire, TVA declaree au guichet unique.",
  },
  {
    treatment: "eu_export_non_eu",
    rateBp: 0,
    requiresHsCode: true,
    en: "Export outside the European Union, exempt from VAT.",
    fr: "Exportation hors Union europeenne, exoneree de TVA.",
  },
]

// ── Inputs ───────────────────────────────────────────────────────────────────

export type DocumentType = "invoice" | "quote" | "proforma" | "purchase_order" | "credit_note"

/** A counterparty a document is addressed to. */
export interface InvoicingParty {
  key: string
  name: string
  email: string
  country: string
  vatId: string | null
  address: string
}

/** A catalog entry a document line can name, with its customs data. */
export interface InvoicingSku {
  sku: string
  title: string
  priceMinor: number
  productSource: string
  /** The store's own product id, carried on the line as `external_id`. */
  externalId: string
  /** The HS code and customs wording a goods line carries when the regime needs them. */
  hsCode: string
  customsDescription: string
}

export interface InvoicingLineSpec {
  /** A catalog SKU, or a free line when `description` + `unitPriceMinor` are given. */
  sku?: string
  description?: string
  unitPriceMinor?: number
  quantity: number
  lineKind?: "goods" | "software" | "shipping"
}

export interface InvoicingDocumentSpec {
  key: string
  type: DocumentType
  status: string
  paymentStatus: "unpaid" | "partial" | "paid" | "refunded"
  party: string
  lines: InvoicingLineSpec[]
  /** Days before `now` the document was issued. Null for a draft. */
  issuedDaysAgo: number | null
  /** Payment terms in days from issue. Null when the type carries no due date. */
  termsDays?: number | null
  paidDaysAgo?: number
  poNumber?: string
  notes?: string
  incoterm?: string
  /** The document's links to records outside invoicing (a payment processor's invoice). */
  externalRefs?: Record<string, string>
  /** The project the document bills (a services company's invoice). */
  billingProjectId?: string
  /** A credit note: the key of the document it corrects. */
  correctsKey?: string
}

/** Prefix per document type: the issuer profile's own defaults. */
const NUMBER_PREFIX: Record<DocumentType, string> = {
  invoice: "INV",
  quote: "QUO",
  proforma: "PRO",
  purchase_order: "PO",
  credit_note: "CN",
}

export interface ComputedLine {
  id: string
  position: number
  description: string
  quantity: number
  unitPriceMinor: bigint
  lineKind: "goods" | "software" | "shipping"
  taxRateBp: number
  subtotalMinor: bigint
  taxMinor: bigint
  totalMinor: bigint
  hsCode: string | null
  countryOfOrigin: string | null
  customsDescription: string | null
  productSource: string | null
  externalId: string | null
}

export interface ComputedDocument {
  spec: InvoicingDocumentSpec
  id: string
  party: InvoicingParty
  tax: TaxVerdict
  number: string | null
  numberInt: number | null
  yearOfIssue: number | null
  issuedAt: Date | null
  dueAt: Date | null
  paidAt: Date | null
  lines: ComputedLine[]
  subtotalMinor: bigint
  taxTotalMinor: bigint
  grandTotalMinor: bigint
}

/**
 * Price, tax and number every document, before anything is written. Numbered
 * in issue order per (type, year), so the sequence is gap free and
 * chronological, exactly as the app's own numbering produces it. Goods lines
 * on a regime that needs customs data carry the SKU's HS code and FR origin.
 */
export function computeDocuments(
  ctx: SeedContext,
  input: {
    documents: readonly InvoicingDocumentSpec[]
    parties: ReadonlyMap<string, InvoicingParty>
    skus: ReadonlyMap<string, InvoicingSku>
  },
): ComputedDocument[] {
  const ordered = [...input.documents].sort((a, b) => {
    const ax = a.issuedDaysAgo ?? -1
    const bx = b.issuedDaysAgo ?? -1
    // Oldest first; drafts (never issued) last.
    if (ax === -1 || bx === -1) return ax === bx ? 0 : ax === -1 ? 1 : -1
    return bx - ax
  })
  const counters = new Map<string, number>()
  const computed: ComputedDocument[] = []

  for (const spec of ordered) {
    const party = input.parties.get(spec.party)
    if (!party)
      throw new Error(`invoicing seed: document ${spec.key} names unknown party ${spec.party}`)
    const tax = classifyForFrenchIssuer(party.country, party.vatId !== null)
    const credit = spec.type === "credit_note"
    const issuedAt = spec.issuedDaysAgo === null ? null : shiftTime(ctx.now, -spec.issuedDaysAgo, 9)
    const dueAt =
      issuedAt !== null && spec.termsDays != null ? shiftTime(issuedAt, spec.termsDays) : null
    const paidAt = spec.paidDaysAgo === undefined ? null : shiftTime(ctx.now, -spec.paidDaysAgo, 11)

    let number: string | null = null
    let numberInt: number | null = null
    let yearOfIssue: number | null = null
    if (issuedAt !== null) {
      yearOfIssue = issuedAt.getUTCFullYear()
      const counterKey = `${spec.type}-${yearOfIssue}`
      numberInt = (counters.get(counterKey) ?? 0) + 1
      counters.set(counterKey, numberInt)
      number = `${NUMBER_PREFIX[spec.type]}-${yearOfIssue}-${String(numberInt).padStart(4, "0")}`
    }

    const lines: ComputedLine[] = []
    let position = 1
    for (const ln of spec.lines) {
      const sku = ln.sku ? input.skus.get(ln.sku) : undefined
      if (ln.sku && !sku)
        throw new Error(`invoicing seed: document ${spec.key} names unknown sku ${ln.sku}`)
      const unitPriceMinor = BigInt(sku ? sku.priceMinor : (ln.unitPriceMinor ?? 0))
      const description = sku ? sku.title : (ln.description ?? "Line")
      const lineKind = ln.lineKind ?? "goods"
      const signedQuantity = credit ? -ln.quantity : ln.quantity
      const subtotalMinor = unitPriceMinor * BigInt(signedQuantity)
      const taxMinor = lineTax(subtotalMinor, tax.rateBp)
      const needsCustoms = tax.requiresHsCode && lineKind === "goods" && sku !== undefined
      lines.push({
        id: ctx.id("document_line", `${spec.key}|${position}`),
        position,
        description,
        quantity: signedQuantity,
        unitPriceMinor,
        lineKind,
        taxRateBp: tax.rateBp,
        subtotalMinor,
        taxMinor,
        totalMinor: subtotalMinor + taxMinor,
        hsCode: needsCustoms ? sku.hsCode : null,
        countryOfOrigin: needsCustoms ? "FR" : null,
        customsDescription: needsCustoms ? sku.customsDescription : null,
        productSource: sku ? sku.productSource : null,
        externalId: sku ? sku.externalId : null,
      })
      position++
    }

    let subtotalMinor = 0n
    let taxTotalMinor = 0n
    for (const l of lines) {
      subtotalMinor += l.subtotalMinor
      taxTotalMinor += l.taxMinor
    }
    computed.push({
      spec,
      id: ctx.id("document", spec.key),
      party,
      tax,
      number,
      numberInt,
      yearOfIssue,
      issuedAt,
      dueAt,
      paidAt,
      lines,
      subtotalMinor,
      taxTotalMinor,
      grandTotalMinor: subtotalMinor + taxTotalMinor,
    })
  }
  return computed
}

/** Open and overdue receivable, from the SAME rule the product computes it by:
 *  an issued invoice that is not fully paid, overdue once its due date passed. */
export function invoicingTotals(
  documents: readonly ComputedDocument[],
  now: Date,
): { openReceivableMinor: bigint; overdueMinor: bigint } {
  let open = 0n
  let overdue = 0n
  for (const d of documents) {
    if (d.spec.type !== "invoice") continue
    if (d.spec.status !== "issued") continue
    if (d.spec.paymentStatus === "paid" || d.spec.paymentStatus === "refunded") continue
    open += d.grandTotalMinor
    if (d.dueAt !== null && d.dueAt.getTime() < now.getTime()) overdue += d.grandTotalMinor
  }
  return { openReceivableMinor: open, overdueMinor: overdue }
}

// ── Writers ──────────────────────────────────────────────────────────────────

export interface IssuerProfileInput {
  /** Keys the profile's deterministic id: `ctx.id("issuer_profile", key)`. */
  key: string
  legalName: string
  country: string
  vatId: string | null
  address: string
  iban: string
  swiftBic: string
  bankName: string
  defaultCurrency: string
  prefixes: { invoice: string; quote: string; proforma: string; po: string; creditNote: string }
  /** The shop the profile is mapped to, or null for a plain quoting profile. */
  shopifyShopId: string | null
  invoiceApprovalThresholdMinor: string
  poApprovalThresholdMinor: string
  timezone: string
}

export function issuerProfileId(ctx: SeedContext, key: string): string {
  return ctx.id("issuer_profile", key)
}

async function upsertIssuerProfile(
  tx: SeedTx,
  ctx: SeedContext,
  p: IssuerProfileInput,
): Promise<string> {
  const id = issuerProfileId(ctx, p.key)
  await upsertAppRow(tx, "invoicing", "issuer_profiles", {
    id,
    org_id: ctx.orgId,
    legal_name: p.legalName,
    country: p.country,
    vat_id: p.vatId,
    tax_registration_id: null,
    address: p.address,
    iban: p.iban,
    swift_bic: p.swiftBic,
    bank_name: p.bankName,
    default_currency: p.defaultCurrency,
    default_language: "en",
    default_payment_terms_days: 30,
    prefix_invoice: p.prefixes.invoice,
    prefix_quote: p.prefixes.quote,
    prefix_proforma: p.prefixes.proforma,
    prefix_po: p.prefixes.po,
    prefix_credit_note: p.prefixes.creditNote,
    shopify_shop_id: p.shopifyShopId,
    invoice_approval_threshold_minor: p.invoiceApprovalThresholdMinor,
    po_approval_threshold_minor: p.poApprovalThresholdMinor,
    require_two_eyes: false,
    auto_email_enabled: false,
    prices_include_tax: false,
    timezone: p.timezone,
    email_templates: jsonCell({}),
    created_at: iso(shiftTime(ctx.now, -365)),
    updated_at: iso(shiftTime(ctx.now, -30)),
  })
  for (const r of FRENCH_ISSUER_TAX_REGIMES) {
    await upsertAppRow(tx, "invoicing", "tax_regimes", {
      id: ctx.id("tax_regime", r.treatment),
      org_id: ctx.orgId,
      issuer_country: "FR",
      treatment: r.treatment,
      default_rate_bp: r.rateBp,
      legal_mention_template_en: r.en,
      legal_mention_template_fr: r.fr,
      legal_mention_template_de: null,
      requires_hs_code: r.requiresHsCode,
      created_at: iso(shiftTime(ctx.now, -365)),
      updated_at: iso(shiftTime(ctx.now, -365)),
    })
  }
  return id
}

/** An issuer profile and the FR tax regimes beside it. Idempotent. Returns its id. */
export async function seedIssuerProfile(
  ctx: SeedContext,
  profile: IssuerProfileInput,
): Promise<string> {
  return withSystemDb("seed-invoicing-issuer", (tx) => upsertIssuerProfile(tx, ctx, profile))
}

/** The audit entries the Lifecycle tab renders, in the shape issuance writes. */
function buildLifecycleLog(d: ComputedDocument): Record<string, unknown>[] {
  const log: Record<string, unknown>[] = []
  if (d.issuedAt !== null) log.push({ event: "issued", actor: null, ts: iso(d.issuedAt) })
  if (d.paidAt !== null)
    log.push({ event: "marked_paid", actor: null, ts: iso(d.paidAt), source: "manual" })
  return log
}

export interface InvoicingHistoryInput {
  issuer: IssuerProfileInput
  /** The HS code library the customs lines pick from. */
  hsCodes: readonly { code: string; description: string }[]
  /** Invoicing's view of a contact: a customer or a vendor, keyed for its id. */
  relationships: readonly { key: string; contactId: string; relationship: "customer" | "vendor" }[]
  documents: readonly ComputedDocument[]
  /** Contact id per party key, set as each document's counterparty contact. */
  contactIdsByPartyKey: Readonly<Record<string, string>>
}

/**
 * The issuer profile, its tax regimes, the HS code library, the contact
 * relationships, every document with its lines, and the app's number
 * sequences advanced past what was written. One transaction.
 */
export async function seedInvoicingHistory(
  ctx: SeedContext,
  input: InvoicingHistoryInput,
): Promise<{ issuerProfileId: string }> {
  const { orgId, now } = ctx
  return withSystemDb("seed-invoicing-history", async (tx) => {
    const profileId = await upsertIssuerProfile(tx, ctx, input.issuer)

    for (const h of input.hsCodes) {
      await upsertAppRow(tx, "invoicing", "hs_code_library", {
        id: ctx.id("hs_code", h.code),
        org_id: orgId,
        code: h.code,
        description: h.description,
        last_used_at: iso(shiftTime(now, -3)),
        created_at: iso(shiftTime(now, -300)),
        updated_at: iso(shiftTime(now, -3)),
      })
    }

    for (const r of input.relationships) {
      await upsertAppRow(tx, "invoicing", "contact_relationships", {
        id: ctx.id("contact_relationship", r.key),
        org_id: orgId,
        contact_id: r.contactId,
        relationship: r.relationship,
        source: "inferred",
        created_at: iso(shiftTime(now, -200)),
        updated_at: iso(shiftTime(now, -200)),
      })
    }

    for (const d of input.documents) {
      const issued = d.issuedAt !== null
      const row: Record<string, AppCell> & { id: string; org_id: string } = {
        id: d.id,
        org_id: orgId,
        type: d.spec.type,
        scope: null,
        status: d.spec.status,
        payment_status: d.spec.paymentStatus,
        number: d.number,
        number_int: d.numberInt,
        year_of_issue: d.yearOfIssue,
        issuer_profile_id: profileId,
        counterparty_contact_id: input.contactIdsByPartyKey[d.party.key] ?? null,
        counterparty_name: d.party.name,
        counterparty_address: d.party.address,
        counterparty_vat_id: d.party.vatId,
        counterparty_email: d.party.email,
        counterparty_country: d.party.country,
        currency: "EUR",
        subtotal_minor: d.subtotalMinor.toString(),
        tax_total_minor: d.taxTotalMinor.toString(),
        grand_total_minor: d.grandTotalMinor.toString(),
        tax_treatment: d.tax.treatment,
        incoterm: d.spec.incoterm ?? "DAP",
        issued_at: d.issuedAt === null ? null : iso(d.issuedAt),
        due_at: d.dueAt === null ? null : iso(d.dueAt),
        paid_at: d.paidAt === null ? null : iso(d.paidAt),
        voided_at: null,
        pdf_file_id: null,
        // The app's own "render me on demand" state: see the header note.
        pdf_status: issued ? "pending" : null,
        external_refs: jsonCell(d.spec.externalRefs ?? {}),
        po_number: d.spec.poNumber ?? null,
        notes: d.spec.notes ?? null,
        lifecycle_log: jsonCell(buildLifecycleLog(d)),
        ...(d.spec.billingProjectId ? { billing_project_id: d.spec.billingProjectId } : {}),
        ...(d.spec.correctsKey
          ? { original_document_id: ctx.id("document", d.spec.correctsKey) }
          : {}),
        created_at: iso(d.issuedAt ?? shiftTime(now, -1, 16)),
        updated_at: iso(d.paidAt ?? d.issuedAt ?? shiftTime(now, -1, 16)),
      }
      await upsertAppRow(tx, "invoicing", "documents", row)
      for (const l of d.lines) {
        await upsertAppRow(tx, "invoicing", "document_lines", {
          id: l.id,
          org_id: orgId,
          document_id: d.id,
          position: l.position,
          description: l.description,
          quantity: l.quantity.toFixed(3),
          unit_price_minor: l.unitPriceMinor.toString(),
          discount_minor: "0",
          line_kind: l.lineKind,
          tax_rate_bp: l.taxRateBp,
          subtotal_minor: l.subtotalMinor.toString(),
          tax_minor: l.taxMinor.toString(),
          total_minor: l.totalMinor.toString(),
          hs_code: l.hsCode,
          country_of_origin: l.countryOfOrigin,
          customs_description: l.customsDescription,
          product_source: l.productSource,
          external_id: l.externalId,
          created_at: iso(d.issuedAt ?? shiftTime(now, -1, 16)),
          updated_at: iso(d.issuedAt ?? shiftTime(now, -1, 16)),
        })
      }
    }

    // Advance the app's own number sequences past what was just written. The
    // app numbers a new document from `kernel.app_sequences` (the key its
    // `allocateNumber` builds), not from the table, so a seed that writes
    // QUO-2026-0001..0003 and leaves the sequence at zero hands the next quote
    // number 1 again, and issuing it collides on the number's unique index.
    // GREATEST, so a re-seed never winds back a sequence the org has used.
    const highest = new Map<string, number>()
    for (const d of input.documents) {
      if (d.numberInt === null || d.yearOfIssue === null) continue
      const key = `invoicing:doc_number:${profileId}:${d.spec.type}:${d.yearOfIssue}`
      highest.set(key, Math.max(highest.get(key) ?? 0, d.numberInt))
    }
    for (const [key, value] of highest) {
      await tx
        .insert(appSequences)
        .values({ orgId, appId: "invoicing", key, value, updatedAt: sql`now()` })
        .onConflictDoUpdate({
          target: [appSequences.orgId, appSequences.appId, appSequences.key],
          set: {
            value: sql`GREATEST(${appSequences.value}, excluded.value)`,
            updatedAt: sql`now()`,
          },
        })
    }
    return { issuerProfileId: profileId }
  })
}

// ── Recurring schedules ──────────────────────────────────────────────────────

export interface RecurringScheduleSpec {
  /** Keys the schedule's deterministic id: `ctx.id("recurring_schedule", key)`. */
  key: string
  contactId: string
  companyId?: string | null
  repeats: "month" | "quarter" | "year"
  /** `last`, a day from 1 to 28, or `MM-DD` for a year. */
  billingDay: string
  status: "draft" | "active" | "paused" | "ended"
  lines: readonly { description: string; qty: number; unitPriceMinor: number; vatBp: number }[]
  /** The civil dates the app would have computed from the schedule's cadence. */
  nextIssueOn: string | null
  nextDraftOn: string | null
  language?: string
  pausedUntil?: string | null
}

/** The `recurring_schedules` rows the app would have written: always `review`, never automatic. */
export function recurringScheduleRows(
  ctx: SeedContext,
  issuerId: string,
  specs: readonly RecurringScheduleSpec[],
): Array<Record<string, AppCell> & { id: string; org_id: string }> {
  return specs.map((s) => ({
    id: ctx.id("recurring_schedule", s.key),
    org_id: ctx.orgId,
    issuer_profile_id: issuerId,
    company_id: s.companyId ?? null,
    contact_id: s.contactId,
    status: s.status,
    repeats: s.repeats,
    billing_day: s.billingDay,
    ends_on: null,
    covers: "period_ended",
    issue_mode: "review",
    auto_enabled_by: null,
    auto_enabled_at: null,
    paid_by: "transfer",
    card_link_url: null,
    due_rule: "days_30",
    due_days: null,
    language: s.language ?? "en",
    lines: jsonCell(
      s.lines.map((l) => ({
        description: l.description,
        qty: l.qty,
        unit_price_minor: l.unitPriceMinor,
        vat_bp: l.vatBp,
        line_kind: "service",
      })),
    ),
    notes: null,
    paused_until: s.pausedUntil ?? null,
    next_issue_on: s.status === "active" ? s.nextIssueOn : null,
    next_draft_on: s.status === "active" ? s.nextDraftOn : null,
    version: 1,
    created_by: "seed",
    created_at: iso(shiftTime(ctx.now, -60)),
    updated_at: iso(shiftTime(ctx.now, -30)),
  }))
}

/** Recurring schedules for an issuer. Idempotent. */
export async function seedRecurringSchedules(
  ctx: SeedContext,
  issuerId: string,
  specs: readonly RecurringScheduleSpec[],
): Promise<number> {
  const rows = recurringScheduleRows(ctx, issuerId, specs)
  await withSystemDb("seed-invoicing-recurring", async (tx) => {
    for (const row of rows) await upsertAppRow(tx, "invoicing", "recurring_schedules", row)
  })
  return rows.length
}
