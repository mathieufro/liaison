// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gated-tool approval summarizers (host-side runtime import, TRUSTED bundled app).
// Bundled into the freeze entrypoint via the `export * from "./summarizers"`
// re-export in src/handlers.ts, so the host's `loadTrustedBundleFunction` can
// resolve them from the built bundle (mirrors the boxtal bundled-app convention).
//
// An approval summarizer turns a gated tool's params into the human-reviewable
// ApprovalSummary that the kernel records on the approval request AND echoes back
// to the agent inside the BLOCKED envelope. These are pure (no DB / no fetch) so
// they are safe to run synchronously at gate time. A gated tool WITHOUT one gets
// the kernel's fallback card, a raw "field: value" dump nobody can decide on, so
// every gated tool of this app declares one (manifest.test.ts pins that).
//
// Most declare a manifest `summarizerContext`: the kernel runs an UNGATED read of
// this app (documents_get on the document the call acts on, the issuer list, ...)
// at gate time and passes the result as `meta.context`, the third argument.
// Summarizers read it defensively (`meta?.context`) so a card still renders,
// from params alone, if hydration is unavailable or degraded.
//
// Wording rules (approval-cards.ts): a plain sentence of the effect, then labelled
// facts; the document by number and type, the customer by name, money with its
// currency, the order by its store name; never an id, a gid, JSON, a snake_case
// field name or a minor-unit amount; no dash punctuation.

import {
  type ApprovalCard,
  type CardLineItem,
  capitalize,
  consumerOverrideCardLines,
  day,
  docLink,
  docName,
  docTypeLabel,
  finishCard,
  isOpaqueId,
  issueCard,
  linesTotal,
  lineText,
  lineTexts,
  money,
  orderName,
  shown,
  text,
  toMinor,
} from "./approval-cards"

import type { BuyerVatFacts } from "./buyer-vat"
import { formatMoneyGrouped } from "./money"
import { planTax, type TaxPlanLine } from "./tax-plan"

type ApprovalSummaryShape = ApprovalCard

/** Third positional arg the kernel passes to a gated tool's summarizer. */
interface SummarizerMeta {
  connectionIdentifier?: string | null
  context?: unknown
}

/** The documents_get read result (src/reads.ts DocumentFull), narrowed to what the cards read.
 *  Money fields come back as numeric STRINGS (see reads.ts toDocumentHeader). */
interface DocumentGetContext {
  id?: string
  type?: string
  number?: string | null
  status?: string
  currency?: string
  subtotal_minor?: string | number
  tax_total_minor?: string | number
  grand_total_minor?: string | number
  payment_status?: string
  tax_treatment?: string | null
  counterparty_name?: string | null
  counterparty_email?: string | null
  counterparty_country?: string | null
  shopify_order_number?: string | null
  shopify_draft_order_name?: string | null
  due_at?: string | null
  lines?: Array<CardLineItem & { tax_rate_bp?: unknown }>
  [key: string]: unknown
}

function docOf(meta: SummarizerMeta | undefined): DocumentGetContext | null {
  const c = meta?.context
  return c && typeof c === "object" && !Array.isArray(c) ? (c as DocumentGetContext) : null
}

const done = (card: ApprovalCard): Promise<ApprovalSummaryShape> =>
  Promise.resolve(finishCard(card))

/** "proforma PRO-2026-0029 (Thomas Raz)" or, unhydrated, "the document". */
function docWithCustomer(doc: DocumentGetContext | null, fallback = "the document"): string {
  if (!doc) return fallback
  const name = text(doc.counterparty_name, 60)
  return `${docName(doc)}${name ? ` (${name})` : ""}`
}

/** The labelled facts every document card opens with. */
function docFacts(doc: DocumentGetContext | null, opts: { total?: boolean } = {}): string[] {
  if (!doc) return ["Document details could not be read; check the document before approving"]
  const currency = doc.currency ?? "EUR"
  const out = [`Document: ${capitalize(docName(doc))}`]
  const customer = text(doc.counterparty_name, 80)
  if (customer) out.push(`Customer: ${customer}`)
  if (opts.total !== false) {
    const total = money(doc.grand_total_minor, currency)
    if (total) out.push(`Total: ${total}`)
  }
  const order = orderName(doc.shopify_order_number)
  if (order) out.push(`Order: ${order}`)
  return out
}

function openLink(id: unknown, doc: DocumentGetContext | null): ApprovalCard["links"] {
  return doc ? docLink(id, `Open ${docName(doc)}`) : []
}

// ─────────────────────────────────────────────────────────────────────────
// order_reissue_apply
// ─────────────────────────────────────────────────────────────────────────

interface OrderReissueApplyParams {
  original_document_id?: string
  shopify_order_id?: string
  shopify_order_number?: string | null
  billing_signature?: string
  items?: CardLineItem[]
  currency?: string
}

export function summarizeOrderReissueApply(
  params: OrderReissueApplyParams,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const ctxDoc = docOf(meta)
  const currency = params.currency ?? ctxDoc?.currency ?? "EUR"
  const originalNumber = text(ctxDoc?.number, 40) ?? "the original invoice"
  const originalTotalMinor = toMinor(ctxDoc?.grand_total_minor) ?? 0n
  const paymentStatus = ctxDoc?.payment_status ?? "unknown"
  const order = orderName(params.shopify_order_number ?? ctxDoc?.shopify_order_number)

  const items = params.items ?? []
  // Pre-tax subtotal only: the exact tax-aware grand total is computed at issue time.
  const newTotalMinor = linesTotal(items)
  const diffMinor = newTotalMinor - originalTotalMinor
  const fmt = (m: bigint) => money(m, currency) ?? ""

  const paidLine =
    paymentStatus === "paid"
      ? `Payment already recorded: ${fmt(originalTotalMinor)} paid against ${originalNumber}. It stays recorded against the original invoice; the replacement issues unpaid. Re-apply or refund the difference by hand.`
      : paymentStatus === "partial"
        ? `Original invoice ${originalNumber} has a partial payment recorded. It stays recorded against the original invoice; the replacement issues unpaid.`
        : `No payment is recorded against ${originalNumber} yet. The replacement invoice issues unpaid, same as any new invoice.`

  const lines: string[] = [
    `Original invoice ${originalNumber}: ${fmt(originalTotalMinor)}`,
    ...(order ? [`Order: ${order}`] : []),
    `Credit note to be issued: ${fmt(-originalTotalMinor)}, fully reversing ${originalNumber}`,
    `Replacement invoice new line set (${items.length} line${items.length === 1 ? "" : "s"}), new subtotal: ${fmt(newTotalMinor)}`,
    `Difference from the original: ${diffMinor >= 0n ? "+" : ""}${fmt(diffMinor)}`,
    paidLine,
  ]

  return done({
    kind: "order_reissue_apply",
    title: `Reissue invoice ${originalNumber}${order ? ` for the edited order ${order}` : " for the edited order"}`,
    subtitle: ctxDoc?.counterparty_name
      ? `Credit note and replacement invoice for ${text(ctxDoc.counterparty_name, 80)}`
      : "Credit note and replacement invoice for the order edit",
    lines,
    links: ctxDoc ? docLink(params.original_document_id, `Original invoice ${originalNumber}`) : [],
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Issuer-profile settings card: each changed setting as `old -> new`, by its
// human name. The kernel hydrates `meta.context` with settings_issuer_profile_list,
// so the current row is found by id; without it the card lists the new values.
// ─────────────────────────────────────────────────────────────────────────

const ISSUER_FIELD_LABEL: Record<string, string> = {
  legal_name: "Legal name",
  country: "Country",
  vat_id: "VAT number",
  tax_registration_id: "Tax registration number",
  address: "Address",
  iban: "IBAN",
  swift_bic: "SWIFT/BIC",
  bank_name: "Bank name",
  logo_file_id: "Logo",
  default_currency: "Default currency",
  default_language: "Default language",
  default_payment_terms_days: "Payment terms (days)",
  prefix_invoice: "Invoice number prefix",
  prefix_quote: "Quote number prefix",
  prefix_proforma: "Proforma number prefix",
  prefix_po: "Purchase order number prefix",
  prefix_credit_note: "Credit note number prefix",
  invoice_approval_threshold_minor: "Invoice approval threshold",
  po_approval_threshold_minor: "Purchase order approval threshold",
  require_two_eyes: "Two people must approve",
  auto_email_enabled: "Email documents automatically",
  mail_account_id: "Send from mailbox",
  timezone: "Time zone",
  email_templates: "Email templates",
  shopify_shop_id: "Linked Shopify shop",
  prices_include_tax: "Typed prices include tax",
}

/** "some_field_name" -> "Some field name", for a setting the label table does not know. */
function humanKey(key: string): string {
  return capitalize(
    key
      .replace(/_minor$/, "")
      .replace(/_id$/, "")
      .replace(/_/g, " "),
  )
}

function cardValue(key: string, v: unknown, currency: string): string {
  if (v === undefined || v === null || v === "") return "(empty)"
  if (key.endsWith("_minor")) return money(v, currency) ?? "(empty)"
  // An id-valued setting (mailbox, logo, shop) names a thing the card cannot look up: say it changes.
  if (isOpaqueId(v) || key.endsWith("_file_id") || key === "mail_account_id") return "(set)"
  if (typeof v === "object") return "(structured value)"
  return shown(v, 80)
}

/** Full-value comparison key: a difference past the displayed prefix still counts. */
function compareValue(v: unknown): string {
  if (v === undefined || v === null || v === "") return ""
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

/** Settings that redirect money or loosen a control: always listed, first, never cut. */
// Always shown, never folded into "and N other settings": the legal identity
// (name, country, address, VAT number, tax id) and the bank details are what
// every invoice prints, and the person approving must see each value.
const ISSUER_CARD_SENSITIVE = [
  "legal_name",
  "country",
  "address",
  "vat_id",
  "tax_registration_id",
  "iban",
  "swift_bic",
  "bank_name",
  "invoice_approval_threshold_minor",
  "po_approval_threshold_minor",
  "require_two_eyes",
  "auto_email_enabled",
  "mail_account_id",
  "shopify_shop_id",
]

export function summarizeIssuerProfileChange(
  params: Record<string, unknown>,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const items = ((meta?.context as { items?: Array<Record<string, unknown>> } | null)?.items ??
    []) as Array<Record<string, unknown>>
  const id = typeof params.id === "string" ? params.id : null
  const current = id ? (items.find((r) => String(r.id) === id) ?? null) : null
  const name = text(params.legal_name ?? current?.legal_name, 80) ?? "issuer profile"
  const currency = String(params.default_currency ?? current?.default_currency ?? "EUR")
  const sensitive: string[] = []
  const other: string[] = []
  for (const [key, next] of Object.entries(params)) {
    if (key === "id") continue
    // An update the card cannot diff (current row not readable) shows every
    // value it sets, so nothing is approved blind.
    if (current && compareValue(current[key]) === compareValue(next)) continue
    const label = ISSUER_FIELD_LABEL[key] ?? humanKey(key)
    const line = current
      ? `${label}: ${cardValue(key, current[key], currency)} -> ${cardValue(key, next, currency)}`
      : `${label}: ${cardValue(key, next, currency)}`
    if (ISSUER_CARD_SENSITIVE.includes(key)) sensitive.push(line)
    else other.push(line)
  }
  const budget = Math.max(0, 8 - sensitive.length)
  const lines = [
    ...sensitive,
    ...other.slice(0, other.length > budget ? Math.max(0, budget - 1) : budget),
    ...(other.length > budget
      ? [`and ${other.length - Math.max(0, budget - 1)} other settings`]
      : []),
  ]
  const isDelete = Object.keys(params).filter((k) => k !== "id").length === 0
  return done({
    kind: "issuer_profile_change",
    title: isDelete
      ? `Delete issuer profile ${name}`
      : id
        ? `Change issuer profile ${name}`
        : `Create issuer profile ${name}`,
    subtitle:
      "Bank details, approval thresholds, two-person approval, automatic email and the send-from mailbox change what every invoice says and which controls apply",
    lines: isDelete ? ["Documents already issued keep their issuer details"] : lines,
  })
}

// ─────────────────────────────────────────────────────────────────────────
// documents_send_to_customer: the document and the exact address the PDF goes to
// (explicit `to`, else the address recorded on the document), so approval is never blind.
// ─────────────────────────────────────────────────────────────────────────

export function summarizeDocumentSend(
  params: { document_id?: string; to?: string; subject?: string },
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const doc = docOf(meta)
  const to = (params.to ?? "").trim() || (doc?.counterparty_email ?? "").trim()
  const label = doc ? docName(doc) : "the document"
  return done({
    kind: "document_send",
    title: `Email ${label} to ${to || "the linked contact's email on file"}`,
    ...(doc?.counterparty_name ? { subtitle: `Customer: ${text(doc.counterparty_name, 80)}` } : {}),
    lines: [
      `Recipient: ${to || "resolved from the linked contact at send time"}`,
      ...(doc ? docFacts(doc) : []),
      ...(params.subject ? [`Subject: ${String(params.subject).slice(0, 120)}`] : []),
      "The PDF is attached; the customer receives it as soon as this is approved",
    ],
    links: openLink(params.document_id, doc),
  })
}

// ─────────────────────────────────────────────────────────────────────────
// documents_update: what the edit changes, field by field, before -> after.
// ─────────────────────────────────────────────────────────────────────────

const DOC_FIELD_LABEL: Record<string, string> = {
  counterparty_name: "Customer name",
  counterparty_address: "Billing address",
  counterparty_shipping_address: "Shipping address",
  counterparty_shipping_name: "Ship to name",
  counterparty_vat_id: "Customer VAT number",
  counterparty_email: "Customer email",
  counterparty_country: "Customer country",
  counterparty_contact_id: "Linked contact",
  incoterm: "Incoterm",
  issued_at: "Issue date",
  due_at: "Due date",
  po_number: "Customer PO number",
  notes: "Notes",
  tax_treatment: "Tax treatment",
}

const TAX_TREATMENT_LABEL: Record<string, string> = {
  eu_domestic: "EU domestic VAT",
  eu_reverse_charge: "EU reverse charge",
  eu_b2c_oss: "EU distance sale (OSS)",
  eu_export_non_eu: "export outside the EU",
  uk_domestic: "UK domestic VAT",
  uk_export_eu: "UK export to the EU",
  uk_export_non_eu: "UK export outside the EU",
  us_domestic: "US domestic",
  us_export: "US export",
  ambiguous: "to be decided",
}

/** Treatments that carry no tax: the lines total IS the document total. */
const ZERO_TAX_TREATMENTS = new Set([
  "eu_reverse_charge",
  "eu_export_non_eu",
  "uk_export_eu",
  "uk_export_non_eu",
  "us_export",
])

function docFieldValue(key: string, v: unknown): string {
  if (key === "issued_at" || key === "due_at") return day(v) ?? shown(v)
  if (key === "tax_treatment" && typeof v === "string") return TAX_TREATMENT_LABEL[v] ?? shown(v)
  if (key === "counterparty_contact_id") return v ? "(a contact)" : "(none)"
  return shown(v, 80)
}

function sameLine(a: CardLineItem, b: CardLineItem): boolean {
  return (
    String(a.description ?? "").trim() === String(b.description ?? "").trim() &&
    Number(a.quantity ?? 1) === Number(b.quantity ?? 1) &&
    (toMinor(a.unit_price_minor) ?? 0n) === (toMinor(b.unit_price_minor) ?? 0n)
  )
}

export function summarizeDocumentUpdate(
  params: Record<string, unknown>,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const doc = docOf(meta)
  const currency = doc?.currency ?? "EUR"
  const label = docWithCustomer(doc)
  const fieldLines: string[] = []
  const changedLabels: string[] = []
  for (const [key, next] of Object.entries(params)) {
    if (key === "id" || key === "lines" || next === undefined) continue
    const fieldLabel = DOC_FIELD_LABEL[key] ?? humanKey(key)
    if (doc) {
      if (compareValue(doc[key]) === compareValue(next)) continue
      changedLabels.push(fieldLabel.toLowerCase())
      fieldLines.push(
        `${fieldLabel}: ${docFieldValue(key, doc[key])} -> ${docFieldValue(key, next)}`,
      )
    } else {
      changedLabels.push(fieldLabel.toLowerCase())
      fieldLines.push(`${fieldLabel}: set to ${docFieldValue(key, next)}`)
    }
  }

  const newLines = Array.isArray(params.lines) ? (params.lines as CardLineItem[]) : null
  const oldLines = Array.isArray(doc?.lines) ? (doc!.lines as CardLineItem[]) : null
  const lineLines: string[] = []
  let totalLine: string | null = null
  let titleTotal: string | null = null
  if (newLines) {
    if (oldLines) {
      const n = Math.max(oldLines.length, newLines.length)
      for (let i = 0; i < n; i++) {
        const before = oldLines[i]
        const after = newLines[i]
        if (before && after) {
          if (!sameLine(before, after))
            lineLines.push(
              `Line ${i + 1}: ${lineText(before, currency)} -> ${lineText(after, currency)}`,
            )
        } else if (after) lineLines.push(`Line ${i + 1} added: ${lineText(after, currency)}`)
        else if (before) lineLines.push(`Line ${i + 1} removed: ${lineText(before, currency)}`)
      }
      if (lineLines.length === 0) lineLines.push("Lines: replaced with the same lines (no change)")
    } else {
      lineLines.push(
        ...lineTexts(newLines, currency, 3).map((l) => l.replace(/^Line:/, "New line:")),
      )
    }
    const newSub = linesTotal(newLines)
    const treatment =
      typeof params.tax_treatment === "string" ? params.tax_treatment : doc?.tax_treatment
    const oldTax = toMinor(doc?.tax_total_minor) ?? 0n
    const oldSub = toMinor(doc?.subtotal_minor) ?? 0n
    // The new tax is computed on save; the card can name the total only when no tax applies.
    const noTax =
      (!!treatment && ZERO_TAX_TREATMENTS.has(treatment)) || (oldTax === 0n && oldSub > 0n)
    const after = money(newSub, currency) ?? ""
    if (doc) {
      const before = money(noTax ? doc.grand_total_minor : doc.subtotal_minor, currency) ?? ""
      totalLine = noTax
        ? `Total: ${before} -> ${after}`
        : `Subtotal before tax: ${before} -> ${after} (tax recomputed on save)`
      titleTotal = noTax
        ? `total from ${before} to ${after}`
        : `subtotal from ${before} to ${after}`
    } else {
      totalLine = `New lines total: ${after} (before tax)`
    }
  }

  const fieldNames =
    changedLabels.length <= 3
      ? changedLabels.join(", ").replace(/, ([^,]*)$/, " and $1")
      : `${changedLabels.slice(0, 2).join(", ")} and ${changedLabels.length - 2} other fields`
  const linesPart = titleTotal ?? (newLines ? "lines" : null)
  const title =
    !linesPart && changedLabels.length === 0
      ? `Save ${label} unchanged`
      : titleTotal && changedLabels.length === 0
        ? `Change ${label} ${titleTotal}`
        : `Edit ${label}: ${[linesPart && titleTotal ? `change ${titleTotal}` : linesPart, changedLabels.length ? fieldNames : null].filter(Boolean).join(", plus ")}`
  const issued = doc && doc.status && doc.status !== "draft"
  const facts = doc
    ? [
        `Document: ${capitalize(docName(doc))}${issued ? " (already issued, the PDF is re-rendered)" : ""}`,
        ...(text(doc.counterparty_name, 80)
          ? [`Customer: ${text(doc.counterparty_name, 80)}`]
          : []),
        ...(orderName(doc.shopify_order_number)
          ? [`Order: ${orderName(doc.shopify_order_number)}`]
          : []),
      ]
    : ["Document details could not be read; check the document before approving"]
  // A buyer the agent declares a private consumer against business evidence: the evidence comes
  // first (documents_update_preview, buyer-vat.ts), as on the create cards.
  const preview = (meta?.context ?? null) as {
    buyer_preview?: Partial<BuyerVatFacts> | null
    buyer_refusal?: unknown
  } | null
  const override = consumerOverrideCardLines(preview?.buyer_preview)
  const refusal =
    typeof preview?.buyer_refusal === "string" && preview.buyer_refusal
      ? ["WARNING: this will be REFUSED, the buyer looks like a business but has no VAT number"]
      : []
  // Totals and field changes first: they are the decision. Line detail fills the rest.
  const lines = [
    ...refusal,
    ...override,
    ...facts,
    ...(totalLine ? [totalLine] : []),
    ...fieldLines,
  ]
  const room = Math.max(0, 8 - lines.length)
  const shownLineDetail =
    lineLines.length > room
      ? [
          ...lineLines.slice(0, Math.max(0, room - 1)),
          `and ${lineLines.length - Math.max(0, room - 1)} more line changes`,
        ]
      : lineLines
  return done({
    kind: "document_update",
    title,
    subtitle:
      newLines && doc
        ? "Replaces every line; totals are recomputed exactly like issuing"
        : undefined,
    lines: [...lines, ...shownLineDetail],
    links: openLink(params.id, doc),
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Issue a saved draft (invoice_issue, quote_issue, proforma_issue): context = the draft.
// ─────────────────────────────────────────────────────────────────────────

/** A card line stating what the call itself declares: the kernel's card reads params, not the org's data. */
const DECLARED_CONSUMER_LINE =
  "This call declares the buyer a private consumer (consumer VAT, no reverse charge). Approve only if you know it is a private person."

/**
 * The drafts tools. These two park in more than one way, and this card must hold for all of them:
 * a consumer declared against evidence parks with its own card (mutations/drafts.ts
 * parkConsumerDeclaration), so what lands here is every other park, a tainted turn above all. The
 * card therefore says what the call does, and names a private consumer only when the call declares one.
 */
export function summarizeDraftCreate(
  params: Record<string, unknown>,
): Promise<ApprovalSummaryShape> {
  const type = docTypeLabel(params.type)
  const customer = text(params.counterparty_name, 80)
  const currency = text(params.currency, 3) ?? "EUR"
  const items = Array.isArray(params.items) ? (params.items as CardLineItem[]) : []
  const order = orderName(params.shopify_order_number)
  return done({
    kind: "drafts_create",
    title: `Create a draft ${type}${customer ? ` for ${customer}` : ""}`,
    lines: [
      ...(params.buyer_is_consumer === true ? [DECLARED_CONSUMER_LINE] : []),
      ...(customer ? [`Customer: ${customer}`] : []),
      ...(order ? [`Order: ${order}`] : []),
      ...lineTexts(items, currency),
    ],
  })
}

export function summarizeDraftUpdate(
  params: { patch?: unknown },
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const doc = docOf(meta)
  const patch =
    params.patch && typeof params.patch === "object"
      ? (params.patch as Record<string, unknown>)
      : {}
  const changes: string[] = []
  for (const [key, next] of Object.entries(patch)) {
    if (key === "buyer_is_consumer" || next === undefined) continue
    if (key === "lines") {
      const count = Array.isArray(next) ? next.length : 0
      changes.push(`Lines: replaced with ${count} line${count === 1 ? "" : "s"}`)
    } else {
      changes.push(`${DOC_FIELD_LABEL[key] ?? humanKey(key)}: set to ${docFieldValue(key, next)}`)
    }
  }
  return done({
    kind: "drafts_update",
    title: `Update ${docWithCustomer(doc, "a draft")}`,
    lines: [
      ...(patch.buyer_is_consumer === true ? [DECLARED_CONSUMER_LINE] : []),
      ...(patch.buyer_is_consumer === false
        ? ["This call removes the declaration that the buyer is a private consumer."]
        : []),
      ...docFacts(doc, { total: false }),
      ...changes,
    ],
    links: openLink(doc?.id, doc),
  })
}
/**
 * Discard a draft. On a month-end run's row the call says how far: this month only, or the
 * schedule ends after a given month. The card names which one, since the two do different things.
 */
export function summarizeDraftDiscard(
  params: { applies?: unknown; ends_on?: unknown },
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const doc = docOf(meta)
  const named = docWithCustomer(doc, "a draft")
  const endsOn = text(params.ends_on, 10)
  const title =
    params.applies === "end_schedule"
      ? `End the schedule of ${named}${endsOn ? ` after ${endsOn}` : ""}`
      : params.applies === "this_month"
        ? `Take ${named} out of this month's run`
        : `Discard ${named}`
  return done({
    kind: "drafts_discard",
    title,
    lines: docFacts(doc, { total: false }),
    links: openLink(doc?.id, doc),
  })
}
function draftIssueSummarizer(type: string, kind: string) {
  return (
    params: { draft_id?: string; due_at?: string },
    _ctx?: unknown,
    meta?: SummarizerMeta,
  ): Promise<ApprovalSummaryShape> => {
    const draft = docOf(meta)
    const lines = (draft?.lines ?? []) as CardLineItem[]
    const grand = toMinor(draft?.grand_total_minor)
    // A consumer declared against business evidence when the draft was saved: the evidence stays
    // in front of whoever issues it (buyer-vat.ts).
    const refs = (draft?.external_refs ?? null) as Record<string, unknown> | null
    const evidence = Array.isArray(refs?.buyer_is_consumer_evidence)
      ? refs.buyer_is_consumer_evidence.filter((e): e is string => typeof e === "string")
      : []
    return Promise.resolve(
      issueCard({
        buyer:
          refs?.buyer_is_consumer === true
            ? { buyer_is_consumer: true, consumer_override_evidence: evidence }
            : null,
        kind,
        type: draft?.type ?? type,
        fromDraft: true,
        customer: draft?.counterparty_name ?? null,
        country: draft?.counterparty_country ?? null,
        currency: draft?.currency ?? "EUR",
        lines,
        // What issuing it would write, read by the code that writes it (draft_issue_preview). A
        // draft's own totals carry no tax; they stand in only where the read did not run.
        totalMinor:
          toMinor(draft?.issue_total_minor) ?? (grand !== null && grand !== 0n ? grand : null),
        orderNumber: draft?.shopify_order_number ?? null,
        draftOrderName: draft?.shopify_draft_order_name ?? null,
        originalNumber:
          typeof refs?.original_document_number === "string" ? refs.original_document_number : null,
        dueAt: params.due_at ?? draft?.due_at ?? null,
        draftId: params.draft_id ?? null,
      }),
    )
  }
}

export const summarizeInvoiceIssue = draftIssueSummarizer("invoice", "invoice_issue")
export const summarizeQuoteIssue = draftIssueSummarizer("quote", "quote_issue")
export const summarizeProformaIssue = draftIssueSummarizer("proforma", "proforma_issue")
export const summarizePoIssue = draftIssueSummarizer("purchase_order", "po_issue")
export const summarizeCreditNoteIssue = draftIssueSummarizer("credit_note", "credit_note_issue")

// ─────────────────────────────────────────────────────────────────────────
// Create and issue in one call: context = the issuer profiles (who issues, in which currency).
// ─────────────────────────────────────────────────────────────────────────

interface CreateAndIssueParams {
  counterparty?: CounterpartyParam | string
  buyer_is_consumer?: boolean
  items?: CardLineItem[]
  issuer_profile_id?: string
  currency?: string
  issued_at?: string | null
  due_at?: string
  shopify_order_number?: string | null
  shopify_draft_order_name?: string | null
  po_number?: string | null
  customer_reference?: string | null
  reason?: string | null
  declared_value_minor?: unknown
}

function issuerOf(
  params: { issuer_profile_id?: string | null },
  meta?: SummarizerMeta,
): Record<string, unknown> | null {
  const items = (
    (meta?.context as { items?: Array<Record<string, unknown>> } | null)?.items ?? []
  ).filter((r) => !r.archived_at)
  if (params.issuer_profile_id)
    return items.find((r) => String(r.id) === params.issuer_profile_id) ?? null
  return items.length === 1 ? items[0]! : null
}

interface CounterpartyParam {
  legal_name?: string
  country?: string
  tax_country?: string | null
  vat_id?: string | null
}

/** The counterparty an agent passed, as an object (it sometimes arrives as a JSON string). */
function counterpartyOf(v: unknown): CounterpartyParam {
  if (v && typeof v === "object") return v as CounterpartyParam
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown
      if (parsed && typeof parsed === "object") return parsed as CounterpartyParam
    } catch {
      return { legal_name: v }
    }
  }
  return {}
}

function createAndIssueSummarizer(type: string, kind: string) {
  return (
    params: CreateAndIssueParams,
    _ctx?: unknown,
    meta?: SummarizerMeta,
  ): Promise<ApprovalSummaryShape> => {
    const issuer = issuerOf(params, meta)
    const cp = counterpartyOf(params.counterparty)
    // The buyer's VAT status the preview read resolved (VIES, a number filled in from an earlier
    // document); absent, the params alone.
    const preview = meta?.context as {
      buyer?: Partial<BuyerVatFacts> | null
      refusal?: unknown
    } | null
    const buyerCtx = preview?.buyer ?? null
    const refusal = typeof preview?.refusal === "string" && preview.refusal ? preview.refusal : null
    const buyer: Partial<BuyerVatFacts> = buyerCtx ?? {
      vat_id: typeof cp.vat_id === "string" && cp.vat_id.trim() ? cp.vat_id.trim() : null,
      vat_id_source: cp.vat_id ? "caller" : null,
      buyer_is_consumer: params.buyer_is_consumer === true,
    }
    const taxCountry =
      (typeof cp.tax_country === "string" && cp.tax_country.trim()) || cp.country || null
    const items = Array.isArray(params.items) ? params.items : []
    // The plan is computed when the issuer's country is known: the total any document issues at,
    // a purchase order's included (issuing classifies it like the others).
    const tax =
      issuer && typeof issuer.country === "string" && issuer.country
        ? planTax({
            issuerCountry: issuer.country,
            pricesIncludeTax: issuer.prices_include_tax === true,
            taxCountry,
            hasVatId: !!buyer.vat_id,
            lines: items as TaxPlanLine[],
          })
        : null
    const card = issueCard({
      kind,
      type,
      fromDraft: false,
      customer: cp.legal_name ?? null,
      country: cp.country ?? null,
      tax,
      taxCountry,
      buyer,
      currency: params.currency ?? (issuer?.default_currency as string | undefined) ?? "EUR",
      lines: Array.isArray(params.items) ? params.items : [],
      orderNumber: params.shopify_order_number ?? null,
      draftOrderName: params.shopify_draft_order_name ?? null,
      poNumber: params.po_number ?? null,
      customerReference: params.customer_reference ?? null,
      issuedAt: params.issued_at ?? null,
      dueAt: params.due_at ?? null,
      reason: params.reason ?? null,
      declaredValueMinor: params.declared_value_minor,
      issuerName: (issuer?.legal_name as string | undefined) ?? null,
    })
    // A call that skipped the stage-time check (chained to an earlier step) still shows, first,
    // that executing it will be refused: the buyer looks like a business and has no VAT number.
    if (refusal) {
      return Promise.resolve({
        ...card,
        lines: [
          "WARNING: this will be REFUSED, the buyer looks like a business but has no VAT number",
          ...card.lines,
        ].slice(0, 8),
      })
    }
    return Promise.resolve(card)
  }
}

export const summarizeInvoiceCreateAndIssue = createAndIssueSummarizer(
  "invoice",
  "invoice_create_and_issue",
)
// A quote staged as a step of a sequence (a CRM record, then this quote, then the reply that
// attaches it) is gated before its handler runs: the card states the customer, every line with
// its quantity, price and discount, the total, the validity and the customer reference.
export const summarizeQuoteCreateAndIssue = createAndIssueSummarizer(
  "quote",
  "quote_create_and_issue",
)
export const summarizeProformaCreateAndIssue = createAndIssueSummarizer(
  "proforma",
  "proforma_create_and_issue",
)
export const summarizePoCreateAndIssue = createAndIssueSummarizer(
  "purchase_order",
  "po_create_and_issue",
)

interface CreditNoteCreateAndIssueParams extends CreateAndIssueParams {
  original_document_id?: string | null
}

/**
 * An agent's credit note parked by the host (an org policy, what the turn read) never reaches the
 * handler's own card, so this one states the same: the amount, the lines, the date and the invoice
 * it reverses. The total is computed as issuing computes it: a credit note's lines are net as typed.
 */
export function summarizeCreditNoteCreateAndIssue(
  params: CreditNoteCreateAndIssueParams,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const issuer = issuerOf(params, meta)
  const cp = counterpartyOf(params.counterparty)
  const original = (
    meta?.context as {
      original?: { number?: unknown; issued_at?: unknown; grand_total_minor?: unknown } | null
    } | null
  )?.original
  const stated = params.original_document_id
  const taxCountry =
    (typeof cp.tax_country === "string" && cp.tax_country.trim()) || cp.country || null
  const items = Array.isArray(params.items) ? params.items : []
  const tax =
    issuer && typeof issuer.country === "string" && issuer.country
      ? planTax({
          issuerCountry: issuer.country,
          pricesIncludeTax: false,
          linesAreNet: true,
          taxCountry,
          hasVatId: !!cp.vat_id,
          lines: items as TaxPlanLine[],
        })
      : null
  return Promise.resolve(
    issueCard({
      kind: "credit_note_create_and_issue",
      type: "credit_note",
      fromDraft: false,
      customer: cp.legal_name ?? null,
      country: cp.country ?? null,
      tax,
      taxCountry,
      buyer: {
        vat_id: typeof cp.vat_id === "string" && cp.vat_id.trim() ? cp.vat_id.trim() : null,
      },
      currency: params.currency ?? "EUR",
      lines: items,
      reason: params.reason ?? null,
      issuedAt: params.issued_at ?? null,
      // The read gives the number and date; unread, a number the caller passed still names it.
      originalNumber:
        text(original?.number, 40) ??
        (stated && !isOpaqueId(stated) ? stated : stated ? "the invoice referenced" : null),
      originalDate: day(original?.issued_at),
      originalTotalMinor: original?.grand_total_minor,
      issuerName: (issuer?.legal_name as string | undefined) ?? null,
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Payments, refunds, conversion: context = the document the call acts on.
// ─────────────────────────────────────────────────────────────────────────

export function summarizeMarkPaid(
  params: { document_id?: string; paid_date?: string; payment_note?: string },
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const doc = docOf(meta)
  const total = doc ? money(doc.grand_total_minor, doc.currency ?? "EUR") : null
  const note = text(params.payment_note, 120)
  return done({
    kind: "document_mark_paid",
    title: `Mark ${docWithCustomer(doc)} as paid${total ? `, ${total}` : ""}`,
    subtitle: "Records the payment in Liaison; no money is moved and the customer is not emailed",
    lines: [
      ...docFacts(doc),
      `Paid on: ${day(params.paid_date) ?? "today"}`,
      ...(note ? [`Payment note: ${note}`] : []),
    ],
    links: openLink(params.document_id, doc),
  })
}

export function summarizeRecordRefund(
  params: { document_id?: string; refund_amount_minor?: unknown; refund_kind?: string },
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const doc = docOf(meta)
  const currency = doc?.currency ?? "EUR"
  const amount = money(params.refund_amount_minor, currency) ?? "an amount"
  const kind = params.refund_kind === "full" ? "full" : "partial"
  return done({
    kind: "document_record_refund",
    title: `Record a ${kind} refund of ${amount} on ${docWithCustomer(doc)}`,
    subtitle:
      "Records the refund on the document; it does not send money back (refund the payment itself where it was taken)",
    lines: [
      ...docFacts(doc),
      `Refund: ${amount} (${kind === "full" ? "full refund, the document is marked refunded" : "partial refund"})`,
    ],
    links: openLink(params.document_id, doc),
  })
}

export function summarizeConvertToInvoice(
  params: { source_document_id?: string; notes?: string | null },
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const doc = docOf(meta)
  const total = doc ? money(doc.grand_total_minor, doc.currency ?? "EUR") : null
  const draftOrder = orderName(doc?.shopify_draft_order_name)
  const notes = text(params.notes, 120)
  return done({
    kind: "document_convert_to_invoice",
    title: `Convert ${docWithCustomer(doc)} into an invoice${total ? `, ${total}` : ""}`,
    subtitle: "Issues a new invoice with its legal number from this document's lines",
    lines: [
      ...docFacts(doc),
      ...(draftOrder
        ? [`Shopify draft order ${draftOrder} is completed in Shopify with payment pending`]
        : []),
      ...(notes ? [`Invoice notes: ${notes}`] : []),
    ],
    links: openLink(params.source_document_id, doc),
  })
}

// ─────────────────────────────────────────────────────────────────────────
// E-invoicing
// ─────────────────────────────────────────────────────────────────────────

export function summarizeEinvoiceSend(
  params: {
    document_id?: string
    buyer_siren?: string
    routing_address?: string
    attempt?: number | null
  },
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const doc = docOf(meta)
  const siren = text(params.buyer_siren, 20)
  const routing = text(params.routing_address, 80)
  return done({
    kind: "einvoice_send",
    title: `${params.attempt && params.attempt > 1 ? "Send again" : "Send"} ${docWithCustomer(doc)} as an e-invoice`,
    subtitle:
      "Transmits the legal original to the buyer's e-invoicing platform. This cannot be undone.",
    lines: [
      ...docFacts(doc),
      ...(siren ? [`Buyer SIREN: ${siren}`] : []),
      ...(routing ? [`Routing address: ${routing}`] : []),
    ],
    links: openLink(params.document_id, doc),
  })
}

export function summarizeEinvoiceBookBatch(): Promise<ApprovalSummaryShape> {
  return done({
    kind: "einvoice_book_batch",
    title: "Book the reported sales in the e-invoicing platform's ledger",
    subtitle: "Ledger entries only: nothing is transmitted to any customer.",
    lines: ["The documents and totals are listed on the batch in the E-invoicing tab"],
  })
}

export function summarizeEinvoiceSendBatch(): Promise<ApprovalSummaryShape> {
  return done({
    kind: "einvoice_send_batch",
    title: "Send the day's e-invoices issued with no person",
    subtitle:
      "Each document is transmitted to its buyer's e-invoicing platform. This cannot be undone.",
    lines: ["The documents and the oldest wait are listed on the batch in the E-invoicing tab"],
  })
}

const RECEIVED_VERB: Record<string, string> = {
  refuse: "Refuse",
  dispute: "Dispute",
  undispute: "Withdraw the dispute on",
}

export function summarizeReceivedSetStatus(
  params: { action?: string; reason?: string | null; comment?: string | null },
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const inv = ((meta?.context as { invoice?: Record<string, unknown> } | null)?.invoice ??
    null) as Record<string, unknown> | null
  const supplier =
    text((inv?.supplier as { name?: unknown } | undefined)?.name, 80) ?? "the supplier"
  const number = text(inv?.invoice_number, 40)
  // A received invoice's totals are the decimal amounts its file states, not minor units.
  const statedTotal = text((inv?.totals as { total?: unknown } | undefined)?.total, 40)
  const total = statedTotal ? `${statedTotal} ${String(inv?.currency ?? "EUR")}` : null
  const verb = RECEIVED_VERB[String(params.action)] ?? capitalize(String(params.action ?? "Update"))
  const comment = text(params.comment, 120)
  return done({
    kind: "received_einvoice_set_status",
    title: `${verb} supplier invoice ${number ?? ""} from ${supplier}`.replace(/\s{2,}/g, " "),
    subtitle: "Sent to the supplier's e-invoicing platform once approved.",
    lines: [
      `Supplier: ${supplier}`,
      ...(number
        ? [`Invoice: ${number}${day(inv?.issue_date) ? ` of ${day(inv?.issue_date)}` : ""}`]
        : []),
      ...(total ? [`Total: ${total}`] : []),
      ...(text(params.reason, 80)
        ? [`Reason: ${text(params.reason, 80)!.replace(/_/g, " ").toLowerCase()}`]
        : []),
      ...(comment ? [`Comment kept in Liaison: ${comment}`] : []),
      params.action === "refuse"
        ? "A refusal is final: the supplier's platform is told and the invoice is closed."
        : params.action === "dispute"
          ? "The supplier's platform is told the invoice is disputed; the dispute can be withdrawn later."
          : "The supplier's platform is told the dispute is over.",
    ],
  })
}

const GATE_MODE_LABEL: Record<string, string> = {
  warn: "warn only (issue anyway)",
  enforce: "enforce (refuse to issue an incomplete e-invoice)",
}

export function summarizeEinvoicingSettingsSet(
  params: Record<string, unknown>,
): Promise<ApprovalSummaryShape> {
  const label: Record<string, string> = {
    gate_mode: "Checks before issuing",
    cibs_switch_date: "Switch date",
    provider_app: "E-invoicing platform",
    cutover_date: "Cut-over date (invoices from this day are sent)",
    send_enabled: "Send e-invoices",
    book_enabled: "Book reported sales",
  }
  const lines: string[] = []
  for (const [key, v] of Object.entries(params)) {
    if (v === undefined) continue
    const value =
      key === "gate_mode" && typeof v === "string"
        ? (GATE_MODE_LABEL[v] ?? v)
        : key === "provider_app" && typeof v === "string"
          ? capitalize(v)
          : typeof v === "boolean"
            ? v
              ? "on"
              : "off"
            : (day(v) ?? shown(v))
    lines.push(`${label[key] ?? humanKey(key)}: ${v === null ? "cleared" : value}`)
  }
  const turnsOn = params.send_enabled === true || params.book_enabled === true
  return done({
    kind: "einvoicing_settings_set",
    title: `Change the e-invoicing settings${turnsOn ? " (turns sending or booking on)" : ""}`,
    subtitle: "Decides which invoices go to the e-invoicing platform and from when",
    lines: lines.length > 0 ? lines : ["No setting changes"],
  })
}

export function summarizeBackfillIdentities(params: {
  dry_run?: boolean | null
  limit?: number | null
}): Promise<ApprovalSummaryShape> {
  const dry = params.dry_run !== false
  return done({
    kind: "einvoicing_backfill_identities",
    title: dry
      ? "Preview the customer e-invoicing identities that would be filled in (dry run, nothing saved)"
      : "Fill in customer e-invoicing identities from past documents",
    lines: [
      `Dry run: ${dry ? "yes, only a report" : "no, identities are saved"}`,
      ...(params.limit ? [`At most ${params.limit} customers this run`] : []),
    ],
  })
}

export function summarizeBackfillLegacyOriginals(params: {
  dry_run?: boolean | null
  limit?: number | null
  retry_failed?: boolean | null
}): Promise<ApprovalSummaryShape> {
  const dry = params.dry_run !== false
  return done({
    kind: "einvoicing_backfill_legacy_originals",
    title: dry
      ? "Preview the legal originals that would be recorded for imported documents (dry run, nothing saved)"
      : "Record the legal originals of imported documents",
    lines: [
      `Dry run: ${dry ? "yes, only a report" : "no, originals are stored and kept as legal records"}`,
      ...(params.limit ? [`At most ${params.limit} documents this run`] : []),
      ...(params.retry_failed ? ["Retries documents that failed before"] : []),
    ],
  })
}

const TERRITORY_LABEL: Record<string, string> = {
  as_fr: "as a French customer (French VAT and e-invoicing rules)",
  as_foreign: "as a foreign customer (export or EU rules)",
}

export function summarizeTerritorySet(
  params: { treatment?: string; reason?: string },
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const name =
    text((meta?.context as { counterparty_name?: unknown } | null)?.counterparty_name, 80) ??
    "this customer"
  const treatment = TERRITORY_LABEL[String(params.treatment)] ?? shown(params.treatment)
  return done({
    kind: "counterparty_territory_set",
    title: `Treat ${name} ${treatment}`,
    subtitle:
      "Applies to the next documents issued to this customer; issued ones keep their treatment",
    lines: [
      `Customer: ${name}`,
      ...(text(params.reason, 160) ? [`Reason: ${text(params.reason, 160)}`] : []),
    ],
  })
}

const TAX_MODE_LABEL: Record<string, string> = {
  shopify_reported: "the tax Shopify reported on each line",
  as_computed: "the tax treatment's own rate on every line",
}

export function summarizeDeferredTaxOverride(
  params: { deferred_id?: string; mode?: string },
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const items = ((meta?.context as { items?: Array<Record<string, unknown>> } | null)?.items ??
    []) as Array<Record<string, unknown>>
  const row = items.find((r) => String(r.id) === String(params.deferred_id)) ?? null
  const order = orderName(row?.order_number)
  const mode = TAX_MODE_LABEL[String(params.mode)] ?? shown(params.mode)
  return done({
    kind: "deferred_tax_override",
    title: `Issue the invoice for ${order ? `order ${order}` : "the parked Shopify order"} with ${mode}`,
    subtitle: "The order was parked for a tax review; approving issues its invoice now",
    lines: [
      ...(order ? [`Order: ${order}`] : []),
      `Tax used: ${mode}`,
      ...(text(row?.reason, 120)
        ? [`Parked because: ${text(row?.reason, 120)!.replace(/_/g, " ")}`]
        : []),
    ],
  })
}

const REPEATS_LABEL: Record<string, string> = {
  month: "every month",
  quarter: "every quarter",
  year: "every year",
}

function billingDayLabel(billingDay: unknown): string | null {
  if (billingDay === "last") return "the last day of the period"
  if (typeof billingDay === "string" && /^\d{1,2}$/.test(billingDay)) return `day ${billingDay}`
  if (typeof billingDay === "string" && /^\d{2}-\d{2}$/.test(billingDay))
    return `on ${billingDay.slice(3)}/${billingDay.slice(0, 2)}`
  return null
}

function scheduleLines(params: Record<string, unknown>, currency: string | null): string[] {
  const out: string[] = []
  const repeats = typeof params.repeats === "string" ? REPEATS_LABEL[params.repeats] : null
  if (repeats) out.push(`Bills: ${repeats}`)
  const when = billingDayLabel(params.billing_day)
  if (when) out.push(`Billing day: ${when}`)
  const ends = day(params.ends_on)
  if (ends) out.push(`Last billing: ${ends}`)
  if (Array.isArray(params.lines)) {
    const lines = params.lines as Array<CardLineItem & { qty?: unknown }>
    for (const l of lines.slice(0, 4)) {
      // The price is shown only with the issuer's currency; without it the card names the line alone.
      out.push(
        currency
          ? lineText(
              { description: l.description, quantity: l.qty, unit_price_minor: l.unit_price_minor },
              currency,
            )
          : (text(l.description, 80) ?? "(no description)"),
      )
    }
  }
  if (params.issue_mode === "auto") out.push("Issues by itself, with no card to approve each month")
  if (params.issue_mode === "review") out.push("Each period is drafted for review")
  return out
}

export function summarizeRecurringScheduleCreate(
  params: Record<string, unknown>,
  _ctx?: unknown,
  meta?: SummarizerMeta,
): Promise<ApprovalSummaryShape> {
  const issuer = issuerOf(params as { issuer_profile_id?: string }, meta)
  const currency = typeof issuer?.default_currency === "string" ? issuer.default_currency : null
  return done({
    kind: "recurring_schedule_create",
    title: "Start a recurring invoice schedule",
    subtitle: "A draft is made each period and a person approves it before it is issued",
    lines: scheduleLines(params, currency),
  })
}

export function summarizeRecurringScheduleUpdate(
  params: Record<string, unknown>,
): Promise<ApprovalSummaryShape> {
  const auto = params.issue_mode === "auto"
  const ended = params.status === "ended"
  const lines = scheduleLines(params, null)
  if (params.status === "active")
    lines.unshift("Resumes billing from today, without the days it was paused")
  if (ended) lines.unshift("Ends the schedule: nothing more is billed")
  return done({
    kind: "recurring_schedule_update",
    title: auto
      ? "Let a recurring schedule issue its invoices by itself"
      : ended
        ? "End a recurring invoice schedule"
        : "Change a recurring invoice schedule",
    subtitle: auto
      ? "Invoices under the approval threshold go out with no card to approve; a person must turn this on"
      : "Drafts already made keep their amounts; the change applies from the next period",
    lines: lines.length > 0 ? lines : ["No field changes"],
  })
}

export function summarizeRecurringSchedulePause(
  params: Record<string, unknown>,
): Promise<ApprovalSummaryShape> {
  const until = day(params.until)
  return done({
    kind: "recurring_schedule_pause",
    title: "Pause a recurring invoice schedule",
    subtitle: "Nothing is drafted while it is paused",
    lines: [
      until
        ? `Resumes on ${until}, without billing the days in between`
        : "Stays paused until someone resumes it",
    ],
  })
}

/**
 * A month-end run card's lines, from its payload items: who is billed, in one line, and the total.
 * The panel under the card lists each row with its amounts, so the lines do not repeat them. Used
 * when the card is staged and when its summary is rebuilt after a restage, so both read the same.
 */
export function runCardLines(rawItems: unknown): string[] {
  const items = (Array.isArray(rawItems) ? rawItems : []) as Array<Record<string, unknown>>
  const names: string[] = []
  let total = 0n
  let currency: string | null = null
  for (const it of items) {
    total +=
      typeof it.total_minor === "string" && /^-?\d+$/.test(it.total_minor)
        ? BigInt(it.total_minor)
        : 0n
    const cur = typeof it.currency === "string" ? it.currency : "EUR"
    currency = currency === null || currency === cur ? cur : "mixed"
    if (typeof it.customer === "string" && it.customer) names.push(it.customer)
  }
  const lines: string[] = []
  if (names.length > 0) {
    const shown = names.slice(0, 5).join(", ")
    lines.push((names.length > 5 ? `${shown} and ${names.length - 5} more` : shown).slice(0, 200))
  }
  if (items.length > 0 && currency && currency !== "mixed")
    lines.push(`Total: ${moneyLine(total, currency)} incl. VAT`)
  return lines
}

/**
 * What the run card reads for these rows. The kernel rebuilds the card with it after a restage,
 * so the card says the same thing either way.
 */
export function runCardSummary(
  rawItems: unknown,
  period: string | null,
): { title: string; subtitle: string; lines: string[] } {
  const items = Array.isArray(rawItems) ? rawItems : []
  const lines = runCardLines(items)
  return {
    title: `Issue ${items.length} invoice${items.length === 1 ? "" : "s"} for ${period ?? "a month-end run"}`,
    subtitle: "Numbers are taken on the issue day from 08:00, never at approval",
    lines: lines.length > 0 ? lines : [period ? `Month-end run for ${period}` : "Month-end run"],
  }
}

export function summarizeRecurringRunIssue(
  params: Record<string, unknown>,
): Promise<ApprovalSummaryShape> {
  const period = typeof params.period === "string" && params.period ? params.period : null
  return done({ kind: "recurring_run_issue", ...runCardSummary(params.items, period) })
}

function moneyLine(v: bigint, currency: string): string {
  return `${formatMoneyGrouped(v, currency)} ${currency}`
}

export function summarizeRecurringItemIssue(
  params: Record<string, unknown>,
): Promise<ApprovalSummaryShape> {
  return done({
    kind: "recurring_item_issue",
    title: "Issue one invoice of an approved month-end run",
    subtitle: "Takes the next number only if the draft still matches what was approved",
    lines: [`Run item ${String(params.item_id ?? "")}`],
  })
}

export function summarizeRecurringRunUnapprove(
  params: Record<string, unknown>,
): Promise<ApprovalSummaryShape> {
  return done({
    kind: "recurring_run_unapprove",
    title: "Undo the approval of a month-end run",
    subtitle: "Every edit is kept and a new card asks again; refused once a number is taken",
    lines: [`Run ${String(params.run_id ?? "")}`],
  })
}

export function summarizeIssuerStreamSet(
  params: Record<string, unknown>,
): Promise<ApprovalSummaryShape> {
  const issuer =
    params.issuer === "liaison" ? "Liaison" : params.issuer === "stripe" ? "Stripe" : null
  return done({
    kind: "issuer_stream_set",
    title: issuer
      ? `${issuer} issues the invoices of card subscriptions on Stripe`
      : "Who issues the invoices of card subscriptions on Stripe?",
    subtitle: "Starts with the next renewal, after you confirm",
    lines: [
      "Liaison: a legal invoice from Liaison for each charge, in your series; Stripe only takes the payment.",
      "Stripe: Stripe's invoice is the legal one; Liaison keeps a copy marked Issued by Stripe.",
      "Invoices already issued keep their issuer and numbers. Check the change with your accountant.",
    ],
  })
}

export function summarizeIssuerEmailsConfirm(): Promise<ApprovalSummaryShape> {
  return done({
    kind: "issuer_emails_confirm",
    title: "Confirm that Stripe's emails to customers are off",
    subtitle: "Liaison cannot read this setting; only a person who checked can say so",
    lines: [
      "In Stripe, Settings, Billing: finalized invoices, credit notes and payment receipts should not email customers.",
    ],
  })
}

export function summarizeInvoiceFromStripePayment(
  params: Record<string, unknown>,
): Promise<ApprovalSummaryShape> {
  const id = String(params.stripeInvoiceId ?? params.chargeId ?? "")
  const rate =
    typeof params.vatRateBp === "number"
      ? `${params.vatRateBp / 100}% VAT included in the amount`
      : null
  return done({
    kind: "invoice_from_stripe_payment",
    title: `Create the invoice of Stripe ${id} now`,
    subtitle: "It takes the next number of your invoices",
    lines: [...(rate ? [rate] : []), "One invoice per Stripe payment: a second one is refused."],
  })
}

export function summarizePaymentLinkToInvoice(
  params: Record<string, unknown>,
): Promise<ApprovalSummaryShape> {
  return done({
    kind: "payment_link_to_invoice",
    title: `Link Stripe payment ${String(params.chargeId ?? "")} to an invoice`,
    subtitle: "No number is taken and nothing changes in Stripe",
    lines: [`Invoice ${String(params.documentId ?? "")}`],
  })
}
