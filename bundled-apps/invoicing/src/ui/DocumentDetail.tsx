// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DocumentDetail — side-panel surface for inspecting a single document.
// Spec §12: Header strip (type chip, number, status chip, counterparty,
// issuer profile, dates) | Body tabs (Overview / Customs / PDF /
// Lifecycle, plus any external contributions via K5 slot
// `invoicing.document_detail.tabs`). The actions (Mark paid / Send to
// customer / Convert to invoice / Preview PDF / Download PDF) sit in the
// header row, at the top of the panel.
//
// External-tab contract. Other apps (Phase 18 Boxtal — its shipment
// tab) extend this surface by declaring a manifest entry under
// `slots.invoicing.document_detail.tabs[]`. K5's slot host enumerates
// those at render time; we fetch the list via the standard slot RPC
// and merge with the built-in tab set, sorting by (order, label) so
// the layout stays deterministic across installs.
//
// pdf_status renders. The four document.pdf_status values from the
// manifest schema drive distinct affordances:
//   - pending  → spinner + disabled download
//   - ready    → enabled download, "Open PDF" link
//   - failed   → "Retry render" button (calls
//                invoicing:documents.retry_pdf), disabled download
//   - pdf_a3_normalization_skipped → enabled download + small note
//                "Long-term archival metadata absent"
//
// Header actions are wired by testid: G6's Playwright killer scenario
// targets these to assert the approval-card → mail send loop.

import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import { app, fetchBlob, navigate, openFile } from "@liaison/host"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
  Suspense,
} from "solid-js"
import { formatMoneyMinor } from "../money"
import { RegimeLine } from "./einvoicing/RegimeLine"
import { TransmissionPanel } from "./einvoicing/TransmissionPanel"
import { tr } from "./i18n"
import {
  Badge,
  type BadgeTone,
  Button,
  ConfirmDialog,
  cx,
  Money,
  SectionLabel,
  StatusBadge,
  TypeLabel,
} from "./kit"
import { type EinvoiceFacts, einvoiceStatusWord } from "./RecurringStates"
import { rememberDocumentLabel } from "./tab-labels"

// ─────────────────────────────────────────────────────────────────────────
// Types.
// ─────────────────────────────────────────────────────────────────────────
export interface DocumentDetailProps {
  documentId: string
  /** Optional callback fired after a successful header-action tool call so
   *  the caller (sidebar / dashboard) can refresh its list. */
  onMutate?: () => void
}

export interface DocumentSummary {
  id: string
  type: "invoice" | "quote" | "proforma" | "purchase_order" | "credit_note"
  status: string
  payment_status?: string
  number?: string | null
  currency: string
  subtotal_minor: string | number
  tax_total_minor: string | number
  grand_total_minor: string | number
  tax_treatment?: string | null
  incoterm?: string | null
  issued_at?: string | null
  due_at?: string | null
  pdf_file_id?: string | null
  pdf_status?: PdfStatus | null
  counterparty_contact_id?: string | null
  counterparty_name?: string | null
  counterparty_address?: string | null
  counterparty_shipping_address?: string | null
  counterparty_shipping_name?: string | null
  counterparty_vat_id?: string | null
  counterparty_email?: string | null
  counterparty_country?: string | null
  issuer_profile_id?: string | null
  external_refs?: Record<string, unknown>
  /** The HUMAN store order reference ("#1149") this document bills, resolved by
   *  documents_get from the column or external_refs. Absent on manual documents. */
  shopify_order_number?: string | null
  /** Set when this document IS a Shopify draft order (a quote created in, or
   *  synced from, a mapped Shopify shop). `documents_get` mirrors both fields
   *  off the columns; older rows carry neither. */
  shopify_draft_order_id?: string | null
  shopify_draft_order_name?: string | null
  /** The customer's purchase order number, resolved by documents_get from the column or
   *  external_refs. Absent when the customer gave none. */
  po_number?: string | null
  /** Free-text notes printed on the document (contract reference, customs details, special
   *  mentions). Editable from the Editor on every editable status. */
  notes?: string | null
  lifecycle_log?: LifecycleEntry[]
  /** E-invoicing columns (documents_get): the draft's customer type, operation type and
   *  structured billing, and the regime recorded at issue. */
  customer_kind?: "business" | "individual" | "public_entity" | "non_registered_entity" | null
  operation_category?: "goods" | "services" | "mixed" | null
  billing_line1?: string | null
  billing_line2?: string | null
  billing_postcode?: string | null
  billing_city?: string | null
  billing_country_code?: string | null
  regime?: string | null
  regime_reasons?: unknown[]
}

export interface DocumentLine {
  id: string
  position: number
  description: string
  quantity: string
  unit_price_minor: string | number
  /** Null when the line has no explicit per-line VAT override (issuing uses the issuer's
   *  classified rate); an explicit 0 is a deliberate exemption and stays distinct from null. */
  tax_rate_bp: number | null
  subtotal_minor: string | number
  tax_minor: string | number
  total_minor: string | number
  hs_code?: string | null
  country_of_origin?: string | null
  customs_description?: string | null
}

export interface LifecycleEntry {
  event: string
  at: string
  actor?: { type: string; id?: string }
  note?: string
}

export type PdfStatus = "pending" | "ready" | "failed" | "pdf_a3_normalization_skipped"

export interface DocumentDetailTabContribution {
  id: string
  label: string
  /** Name re-exported from the contributing app's UI bundle. */
  component: string
  order: number
  /** Contributing app — present on external (slot-host) tabs, absent on built-ins.
   *  Used to resolve the cross-app body via the host bridge. */
  app?: string
}

// ─────────────────────────────────────────────────────────────────────────
// Built-in tabs (spec §12). Order 10/20/30/40 leaves 25, 35 etc. open for
// external contributions to interleave naturally.
// ─────────────────────────────────────────────────────────────────────────
export const BUILT_IN_TABS: DocumentDetailTabContribution[] = [
  { id: "overview", label: "Overview", component: "OverviewTab", order: 10 },
  { id: "customs", label: "Customs", component: "CustomsTab", order: 20 },
  { id: "pdf", label: "PDF", component: "PdfTab", order: 30 },
  { id: "lifecycle", label: "Lifecycle", component: "LifecycleTab", order: 40 },
]

/** Ids rendered inline by this app; everything else is an external (slot-host)
 *  contribution mounted via the host bridge. */
const BUILT_IN_IDS = new Set(BUILT_IN_TABS.map((t) => t.id))

/** Merge external tab contributions with the built-in set, sorting by
 *  (order asc, label asc). Stable so equal-order ties land in label
 *  order regardless of input order — important when two apps fight for
 *  the same slot position. */
export function mergeTabs(
  external: DocumentDetailTabContribution[],
): DocumentDetailTabContribution[] {
  const all = [...BUILT_IN_TABS, ...external]
  return all.slice().sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    return a.label.localeCompare(b.label)
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Header actions (the FOOTER_ACTIONS name predates their move to the top).
// Each declares the tool name it invokes; the component's click handler
// reads `tool` and calls `app.invokeTool(tool, payload)`.
// ─────────────────────────────────────────────────────────────────────────
// Each action's `idParam` names the manifest-required id key for its tool
// (see app.manifest.json params.required) — the tools do NOT all agree on
// `id`, so `invoke()` below keys the payload off this field rather than
// hardcoding `id` for every call.
export const FOOTER_ACTIONS = {
  mark_paid: { tool: "documents_mark_paid", label: "Mark paid", idParam: "document_id" },
  send_to_customer: {
    tool: "documents_send_to_customer",
    label: "Send to customer",
    idParam: "document_id",
  },
  convert_to_invoice: {
    tool: "documents_convert_to_invoice",
    label: "Convert to invoice",
    idParam: "source_document_id",
  },
  preview_pdf: { tool: "documents_preview_pdf", label: "Preview PDF", idParam: "id" },
  download_pdf: { tool: "documents_download_pdf", label: "Download PDF", idParam: "id" },
  // Draft-only. Invoked directly rather than through `invoke()`: discarding a
  // draft needs a confirm prompt and a navigation away from the now-deleted
  // document, neither of which the shared helper does.
  delete_draft: { tool: "drafts_discard", label: "Delete draft", idParam: "draft_id" },
} as const

// ─────────────────────────────────────────────────────────────────────────
// Convert to invoice.
//
// Converting is irreversible and, for a quote that IS a Shopify draft order,
// it reaches into Shopify and creates a real order. So the button opens a
// confirmation dialog rather than firing the tool straight away; the human
// confirmation IS the approval (agents still hit the kernel gate).
// ─────────────────────────────────────────────────────────────────────────

/** A quote can be converted once it is out with the customer (`sent`) or the
 *  customer said yes (`accepted`); a proforma once it is `sent`. Nothing else
 *  converts: invoices and credit notes are already terminal, and a draft or a
 *  rejected/expired/invoiced document has nothing to convert. */
export function canConvertToInvoice(doc: {
  type: DocumentSummary["type"]
  status: string
}): boolean {
  if (doc.type === "quote") return doc.status === "sent" || doc.status === "accepted"
  if (doc.type === "proforma") return doc.status === "sent"
  return false
}

const CONVERT_SOURCE_NOUN: Partial<Record<DocumentSummary["type"], string>> = {
  quote: "quote",
  proforma: "proforma",
}

/** Confirmation-dialog body. A Shopify-linked quote says what happens in
 *  Shopify, because the click leaves this app. */
export function convertConfirmBody(doc: {
  type: DocumentSummary["type"]
  shopify_draft_order_name?: string | null
}): string {
  const name = doc.shopify_draft_order_name
  if (doc.type === "quote" && typeof name === "string" && name.length > 0) {
    return tr(
      "This completes draft order {{name}} in Shopify and creates the order. The invoice is issued from that order automatically.",
      { name },
    )
  }
  return tr("This issues an invoice from this {{noun}}.", {
    noun: tr(CONVERT_SOURCE_NOUN[doc.type] ?? "document"),
  })
}

/** True when a tool result is the kernel's gated-call envelope, `{ blocked:
 *  { approvalRequestId, ... } }` — returned in place of the handler's normal
 *  result when the call needs a human approval instead of running. */
function isBlockedResult(result: unknown): boolean {
  return !!result && typeof result === "object" && "blocked" in (result as Record<string, unknown>)
}

/** How long a success confirmation stays before it fades on its own. */
export const ACTION_NOTE_DISMISS_MS = 4000

export interface FooterActionNote {
  text: string
  isError: boolean
  /** Set on a plain success confirmation: the note clears itself after this many ms. */
  autoDismissMs?: number
}

/**
 * The note a header action leaves after it returns (thrown errors are handled by the caller).
 * A gated call reports that it went for approval and stays until the next action; a handler
 * error envelope (returned, not thrown) shows its message; a completed send to the customer
 * confirms discreetly and clears itself. Every other success says nothing: the refetched
 * document already shows the new state.
 */
export function footerActionResultNote(tool: string, result: unknown): FooterActionNote | null {
  if (isBlockedResult(result)) return { text: tr("Sent for approval."), isError: false }
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>
    if (r.status === "pending_approval") return { text: tr("Sent for approval."), isError: false }
    if (r.status === "error") {
      const err = r.error as { code?: string; message?: string } | undefined
      return { text: err?.message ?? err?.code ?? tr("The action failed."), isError: true }
    }
  }
  if (tool === FOOTER_ACTIONS.send_to_customer.tool) {
    return {
      text: tr("Sent to the customer."),
      isError: false,
      autoDismissMs: ACTION_NOTE_DISMISS_MS,
    }
  }
  return null
}

/** Inline note for a `documents_convert_to_invoice` result. Returns null when
 *  there is nothing to say (a local conversion: the refetched document already
 *  shows the new state). */
export function convertResultNote(result: unknown): string | null {
  if (!result || typeof result !== "object") return null
  const r = result as Record<string, unknown>
  if (r.status === "error") {
    const err = r.error as { code?: string; message?: string } | undefined
    return err?.message ?? err?.code ?? tr("The conversion failed.")
  }
  if (r.status === "pending_approval") return tr("Sent for approval.")
  // Gated call: the kernel returns `{ blocked: {...} }` instead of running the
  // handler, not a `pending_approval` status field, so the branch above never
  // matches a real gated conversion.
  if (isBlockedResult(r)) return tr("Sent for approval.")
  if (r.mode === "shopify_order_created") {
    const number = r.shopify_order_number
    return typeof number === "string" && number.length > 0
      ? tr("Order {{number}} created in Shopify. The invoice is being issued.", { number })
      : tr("Order created in Shopify. The invoice is being issued.")
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────
// pdf_status → affordance map.
// ─────────────────────────────────────────────────────────────────────────
export interface PdfAffordance {
  showRetry: boolean
  downloadEnabled: boolean
  showA3SkippedNote: boolean
  statusLabel: string
}

/** What the header's Preview and Download say when there is no PDF to open. */
export function pdfNotReadyNote(s: PdfStatus | undefined | null): string {
  return s === "failed"
    ? tr("This PDF could not be rendered. Use Retry render on the PDF tab.")
    : tr("This PDF is not ready yet. If it stays that way, use Retry render on the PDF tab.")
}

export function pdfStatusAffordance(s: PdfStatus | undefined | null): PdfAffordance {
  switch (s) {
    case "ready":
      return {
        showRetry: false,
        downloadEnabled: true,
        showA3SkippedNote: false,
        statusLabel: "Ready",
      }
    case "failed":
      return {
        showRetry: true,
        downloadEnabled: false,
        showA3SkippedNote: false,
        statusLabel: "Render failed",
      }
    case "pending":
      // Normally a moment. A render that never ran stays pending until someone asks for it again.
      return {
        showRetry: true,
        downloadEnabled: false,
        showA3SkippedNote: false,
        statusLabel: "Rendering…",
      }
    case "pdf_a3_normalization_skipped":
      return {
        showRetry: false,
        downloadEnabled: true,
        showA3SkippedNote: true,
        statusLabel: "Ready (archival metadata absent)",
      }
    default:
      return {
        showRetry: false,
        downloadEnabled: false,
        showA3SkippedNote: false,
        statusLabel: "-",
      }
  }
}

/** Statuses that make a document permanently immutable (mirrors mutations.ts
 *  NOT_EDITABLE_STATUSES / Editor.tsx isEditableStatus) — the Edit header
 *  action is hidden for these; every other status (draft, issued, sent,
 *  paid, overdue, …) is editable via the editor. */
const NOT_EDITABLE_STATUSES = new Set(["voided", "cancelled"])
export function isEditableDocumentStatus(status: string): boolean {
  return !NOT_EDITABLE_STATUSES.has(status)
}

// ─────────────────────────────────────────────────────────────────────────
// Data loader. K5 slot-host enumeration goes through the kernel's
// `/api/v1/slots/<slot>` route (B9) — bundled apps reach it via the
// app-sdk `app.invokeTool("kernel:slots.list", ...)` shim. The document
// detail itself comes from the app's own `invoicing:documents.get`.
// ─────────────────────────────────────────────────────────────────────────
interface LoadedDocument {
  document: DocumentSummary
  lines: DocumentLine[]
  externalTabs: DocumentDetailTabContribution[]
}

async function loadDocument(id: string): Promise<LoadedDocument | null> {
  const [doc, slot] = await Promise.all([
    // `documents_get` returns the document FLAT — every header/customs field plus
    // a top-level `lines[]` — NOT a `{ document, lines }` envelope (see
    // `reads.ts documentsGet` → `DocumentFull`). Reading `doc.document` left the
    // summary `undefined`, so the PDF-status memo (`data().document.pdf_status`)
    // threw `Cannot read properties of undefined` on every cold detail open.
    app.invokeTool<unknown>("documents_get", { id }),
    app
      .invokeTool<{ panels: DocumentDetailTabContribution[] }>("kernel:slots.list", {
        slot: "invoicing.document_detail.tabs",
      })
      .catch(() => ({ panels: [] as DocumentDetailTabContribution[] })),
  ])
  const loaded = toLoadedDocument(doc, slot?.panels ?? [])
  // Name the tab after the document number (cold opens — deep links, agent
  // references — where no list row primed the label registry).
  if (loaded) {
    rememberDocumentLabel(id, loaded.document.number ?? `${loaded.document.type} draft`)
  }
  return loaded
}

/**
 * The `documents_get` result as the detail view reads it, or null when there is no document (an
 * id from another org, a deleted draft). Anything without an id and a status is "not found": a
 * shape the view cannot render must land on the not-found state, never on a half-empty document
 * whose undefined fields crash the tab.
 */
export function toLoadedDocument(
  raw: unknown,
  externalTabs: DocumentDetailTabContribution[] = [],
): LoadedDocument | null {
  if (!raw || typeof raw !== "object") return null
  // A tool error is an error, not an absent document: let the tab say what failed.
  const failed = raw as { status?: unknown; error?: { message?: string; code?: string } }
  if (failed.status === "error" && failed.error) {
    throw new Error(failed.error.message ?? failed.error.code ?? "Failed to load the document.")
  }
  // Defensive: tolerate either the flat shape (current contract) or a legacy
  // `{ document, lines }` envelope, so a future tool-shape change can't silently
  // re-break this surface.
  const legacy = raw as { document?: DocumentSummary; lines?: DocumentLine[] }
  const document = legacy.document ?? (raw as DocumentSummary)
  if (!document || typeof document.id !== "string" || typeof document.status !== "string") {
    return null
  }
  const lines = Array.isArray(legacy.lines) ? legacy.lines : []
  return { document, lines, externalTabs }
}

// ─────────────────────────────────────────────────────────────────────────
// Display helpers.
// ─────────────────────────────────────────────────────────────────────────
function fmtMoney(minor: string | number | undefined, currency: string): string {
  if (minor == null) return "-"
  const n = typeof minor === "string" ? Number(minor) : minor
  if (!Number.isFinite(n)) return "-"
  return formatMoneyMinor(BigInt(Math.round(n)), currency)
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "-"
  return iso.slice(0, 10)
}

function typeLabel(t: DocumentSummary["type"]): string {
  switch (t) {
    case "invoice":
      return tr("Invoice")
    case "quote":
      return tr("Quote")
    case "proforma":
      return tr("Proforma")
    case "purchase_order":
      return "PO"
    case "credit_note":
      return tr("Credit note")
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Shopify order deep link. A document auto-issued from a paid Shopify order
// carries `external_refs.shopify_order_id` (numeric order id string) and
// `external_refs.shopify_shop_domain` (full myshopify domain). Invoicing
// cannot import the shopify bundle (cross-bundle imports are forbidden by
// the purity guard), so this is a small local equivalent of the shopify
// app's `shopSubdomain` / order-URL helper (see
// bundled-apps/shopify/src/ui/panels/url-template.ts).
// ─────────────────────────────────────────────────────────────────────────

/** Reduce a stored myshopify domain to a bare host, tolerating a stray
 *  scheme or path. Returns null when nothing usable remains. */
function shopifyHost(shopDomain: string | null | undefined): string | null {
  if (!shopDomain) return null
  const host = shopDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
  return host || null
}

/** Shopify-admin order URL for a document's external_refs, or null when the
 *  document is not Shopify-sourced (manual documents carry no external_refs
 *  and must show no link). */
export function shopifyOrderUrl(refs: Record<string, unknown> | undefined): string | null {
  const orderId = refs?.shopify_order_id
  const shopDomain = refs?.shopify_shop_domain
  if (typeof orderId !== "string" || !orderId) return null
  if (typeof shopDomain !== "string" || !shopDomain) return null
  const host = shopifyHost(shopDomain)
  if (!host) return null
  return `https://${host}/admin/orders/${orderId}`
}

/** The payment processor's records an invoice it collects names, or null for any other invoice. */
export function stripeCollection(
  refs: Record<string, unknown> | undefined,
): { invoiceId: string; customerId: string | null } | null {
  const invoiceId = refs?.stripe_invoice_id
  if (typeof invoiceId !== "string" || !invoiceId) return null
  const customerId = refs?.stripe_customer_id
  return { invoiceId, customerId: typeof customerId === "string" && customerId ? customerId : null }
}

// ─────────────────────────────────────────────────────────────────────────
// Payment-status badge. `payment_status` is a separate axis from the
// lifecycle `status` (an "issued" invoice can be paid/partial/refunded
// underneath) — a Shopify-sourced invoice that auto-issues on a paid order
// stays `status: "issued"` (boxtal still ships it) but `payment_status:
// "paid"`, so without this badge the header only ever read "Issued" even
// once the customer had paid. Credit notes are never payable, so they never
// render this badge (mirrors the header's mark-paid gate).
// ─────────────────────────────────────────────────────────────────────────
/** What the header chips read: who issued an invoice and who took its payment. */
export interface MoneyChipFacts {
  status: string
  type: string
  stream: "card" | "transfer" | null
  payment_status: string | null
}

/**
 * "Issued by Liaison" on an issued invoice from a Stripe payment or a recurring schedule, and
 * "Collected by Stripe" once a card payment through Stripe is in. Nothing on drafts or other types.
 */
export function moneyChips(f: MoneyChipFacts): string[] {
  if (f.type !== "invoice" || f.status === "draft" || !f.stream) return []
  const chips = ["Issued by Liaison"]
  if (f.stream === "card" && f.payment_status === "paid") chips.push("Collected by Stripe")
  return chips
}

/** The header's quiet chips and the e-invoice status word, from the transmission read. */
function MoneyChips(p: { documentId: string; status: string; type: string }): JSX.Element {
  const [facts] = createResource(
    () => (p.type === "invoice" && p.status !== "draft" ? p.documentId : null),
    async (id) => {
      try {
        return await app.invokeTool<
          EinvoiceFacts & { status?: string; stream?: "card" | "transfer" | null }
        >("einvoice_transmission_get", { document_id: id })
      } catch {
        return null
      }
    },
  )
  // Read only once settled: a pending read here would take the page's Suspense, and with it the
  // whole detail (tab strip included), back to "Loading…" until the chips' read returns.
  return (
    <Show when={facts.state === "ready" ? facts() : undefined}>
      {(f) => (
        <>
          <For
            each={moneyChips({
              status: p.status,
              type: p.type,
              stream: f().stream ?? null,
              payment_status: f().payment_status ?? null,
            })}
          >
            {(chip) => (
              <Badge
                tone="neutral"
                testid={`document-detail-chip-${chip.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {tr(chip)}
              </Badge>
            )}
          </For>
          <Show when={einvoiceStatusWord(f())}>
            {(word) => (
              <Badge tone="neutral" testid="document-detail-einvoice-word">
                {tr("E-invoice: {{word}}", { word: tr(word()) })}
              </Badge>
            )}
          </Show>
        </>
      )}
    </Show>
  )
}

const PAYMENT_TONE: Record<string, BadgeTone> = {
  paid: "success",
  partial: "warning",
  refunded: "muted",
  unpaid: "neutral",
}

const PAYMENT_LABEL: Record<string, string> = {
  paid: "Paid",
  partial: "Partial",
  refunded: "Refunded",
  unpaid: "Unpaid",
}

function PaymentBadge(p: { paymentStatus: string }): JSX.Element {
  return (
    <Badge tone={PAYMENT_TONE[p.paymentStatus] ?? "neutral"} testid="document-detail-payment-chip">
      {PAYMENT_LABEL[p.paymentStatus]
        ? tr(PAYMENT_LABEL[p.paymentStatus]!)
        : humanizePaymentStatus(p.paymentStatus)}
    </Badge>
  )
}

function humanizePaymentStatus(s: string): string {
  return s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
}

// ─────────────────────────────────────────────────────────────────────────
// Tab body renderers. Built-in tabs render inline; external tabs render a
// placeholder (component-by-name resolution lands when the UI loader is
// taught to map `(app, component)` → registered component).
// ─────────────────────────────────────────────────────────────────────────
function CustomerBlock(p: { doc: DocumentSummary }): JSX.Element {
  const dash = (v: string | null | undefined) => (v && v.trim() ? v : "-")
  return (
    <div data-testid="document-detail-customer" class="flex flex-col gap-2.5">
      <SectionLabel>{tr("Customer")}</SectionLabel>
      <div class="grid grid-cols-2 gap-x-6 gap-y-1.5">
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-text-secondary">{tr("Name")}</span>
          <span data-testid="document-detail-customer-name" class="text-right text-text">
            {dash(p.doc.counterparty_name)}
          </span>
        </div>
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-text-secondary">{tr("Country")}</span>
          <span
            data-testid="document-detail-customer-country"
            class="text-right font-mono text-text"
          >
            {dash(p.doc.counterparty_country)}
          </span>
        </div>
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-text-secondary">{tr("Email")}</span>
          <span data-testid="document-detail-customer-email" class="text-right text-text">
            {dash(p.doc.counterparty_email)}
          </span>
        </div>
        <div class="flex items-baseline justify-between gap-3">
          <span class="text-text-secondary">{tr("VAT ID")}</span>
          <span data-testid="document-detail-customer-vat" class="text-right font-mono text-text">
            {dash(p.doc.counterparty_vat_id)}
          </span>
        </div>
        <div class="col-span-2 flex items-baseline justify-between gap-3">
          <span class="text-text-secondary">{tr("Address")}</span>
          <span data-testid="document-detail-customer-address" class="text-right text-text">
            {dash(p.doc.counterparty_address)}
          </span>
        </div>
        <div class="col-span-2 flex items-baseline justify-between gap-3">
          <span class="text-text-secondary">{tr("Ship to")}</span>
          <span
            data-testid="document-detail-customer-shipping-address"
            class="text-right text-text"
          >
            {dash(p.doc.counterparty_shipping_address)}
          </span>
        </div>
        <div class="col-span-2 flex items-baseline justify-between gap-3">
          <span class="text-text-secondary">{tr("Ship to name")}</span>
          <span data-testid="document-detail-customer-shipping-name" class="text-right text-text">
            {dash(p.doc.counterparty_shipping_name)}
          </span>
        </div>
      </div>
    </div>
  )
}

function OverviewBody(p: { doc: DocumentSummary; lines: DocumentLine[] }): JSX.Element {
  return (
    <div data-testid="document-detail-overview" class="flex flex-col gap-6 px-5 py-5 text-[12.5px]">
      <CustomerBlock doc={p.doc} />
      <Show when={p.doc.type === "invoice" || p.doc.type === "credit_note"}>
        <RegimeLine
          documentId={p.doc.id}
          contactId={p.doc.counterparty_contact_id ?? null}
          originalDocumentId={
            typeof p.doc.external_refs?.original_document_id === "string"
              ? (p.doc.external_refs.original_document_id as string)
              : null
          }
        />
        <TransmissionPanel documentId={p.doc.id} />
      </Show>
      {/* Credit notes (or any correcting document) reference the original
          invoice via external_refs.original_document_id — surface it as a
          navigable link so the reversal chain is one click away. */}
      <Show when={typeof p.doc.external_refs?.original_document_id === "string"}>
        <div class="flex items-center gap-2">
          <SectionLabel>{tr("Original invoice")}</SectionLabel>
          <a
            data-testid="document-detail-original-invoice"
            class="cursor-pointer text-[12.5px] text-accent hover:underline"
            onClick={(e) => {
              e.preventDefault()
              navigate(`/invoicing/document/${p.doc.external_refs?.original_document_id as string}`)
            }}
            href={`/invoicing/document/${p.doc.external_refs?.original_document_id as string}`}
          >
            {String(
              (p.doc.external_refs?.original_document_number as string | undefined) ??
                (p.doc.external_refs?.original_document_id as string),
            )}
          </a>
        </div>
      </Show>
      <div class="flex flex-col gap-2.5">
        <SectionLabel>{tr("Lines")}</SectionLabel>
        <Show
          when={p.lines.length > 0}
          fallback={<div class="text-text-tertiary">{tr("No lines.")}</div>}
        >
          <CardTable
            rows={p.lines}
            rowKey={(l) => String(l.position)}
            rowTestid={(l) => `document-detail-line-${l.position}`}
            columns={
              [
                {
                  key: "description",
                  header: tr("Description"),
                  role: "anchor",
                  cell: (l) => l.description,
                },
                {
                  key: "qty",
                  header: tr("Qty"),
                  role: "secondary",
                  cell: (l) => <span class="font-mono tabular-nums">{l.quantity}</span>,
                },
                {
                  key: "unit",
                  header: tr("Unit"),
                  role: "meta",
                  align: "right",
                  cell: (l) => (
                    <Money
                      minor={l.unit_price_minor}
                      currency={p.doc.currency}
                      codeless
                      class="text-text-secondary"
                    />
                  ),
                },
                {
                  key: "total",
                  header: tr("Total"),
                  role: "meta",
                  numeric: true,
                  align: "right",
                  cell: (l) => <Money minor={l.total_minor} currency={p.doc.currency} codeless />,
                },
              ] as Array<CardTableColumn<DocumentLine>>
            }
          />
        </Show>
      </div>

      {/* Totals — right-aligned summary, grand total emphasised. */}
      <div class="ml-auto w-full max-w-xs flex-col gap-1.5">
        <div class="flex items-center justify-between py-1">
          <span class="text-text-secondary">{tr("Subtotal")}</span>
          <Money
            minor={p.doc.subtotal_minor}
            currency={p.doc.currency}
            class="text-text-secondary"
          />
        </div>
        <div class="flex items-center justify-between py-1">
          <span class="text-text-secondary">{tr("Tax")}</span>
          <Money
            minor={p.doc.tax_total_minor}
            currency={p.doc.currency}
            class="text-text-secondary"
          />
        </div>
        <div class="mt-1 flex items-center justify-between border-t border-border pt-2">
          <span class="font-medium text-text">{tr("Grand total")}</span>
          <Money
            minor={p.doc.grand_total_minor}
            currency={p.doc.currency}
            emphasis
            class="text-[14px]"
          />
        </div>
      </div>
    </div>
  )
}

function CustomsBody(p: { doc: DocumentSummary; lines: DocumentLine[] }): JSX.Element {
  return (
    <div data-testid="document-detail-customs" class="flex flex-col gap-3 px-4 py-3 text-[12.5px]">
      <div>
        <div class="mb-1 text-text-secondary text-[11px] uppercase tracking-wider">
          {tr("Treatment")}
        </div>
        <div class="font-medium text-text">{p.doc.tax_treatment ?? "-"}</div>
      </div>
      <div>
        <div class="mb-1 text-text-secondary text-[11px] uppercase tracking-wider">
          {tr("Incoterm")}
        </div>
        <div class="font-mono text-text">{p.doc.incoterm ?? "DAP"}</div>
      </div>

      <div>
        <div class="mb-1 text-text-secondary text-[11px] uppercase tracking-wider">
          {tr("Per-line customs")}
        </div>
        <Show
          when={p.lines.length > 0}
          fallback={<div class="text-text-tertiary">{tr("No lines.")}</div>}
        >
          <CardTable
            rows={p.lines}
            rowKey={(l) => String(l.position)}
            rowTestid={(l) => `document-detail-customs-line-${l.position}`}
            columns={
              [
                {
                  key: "description",
                  header: tr("Description"),
                  role: "anchor",
                  cell: (l) => l.description,
                },
                {
                  key: "hs",
                  header: "HS",
                  role: "meta",
                  cell: (l) => <span class="font-mono">{l.hs_code ?? "-"}</span>,
                },
                {
                  key: "coo",
                  header: "CoO",
                  role: "meta",
                  cell: (l) => <span class="font-mono">{l.country_of_origin ?? "-"}</span>,
                },
              ] as Array<CardTableColumn<DocumentLine>>
            }
          />
        </Show>
      </div>
    </div>
  )
}

/** Fetch a document's rendered-PDF bytes (bearer-authenticated, same pattern
 *  as DocumentDetail's openPdf) and resolve a blob URL for inline embedding.
 *  Returns null when the PDF is not yet renderable (pending/failed) or the
 *  fetch fails — the caller falls back to the status-only affordance. */
async function fetchPdfBlobUrl(documentId: string): Promise<string | null> {
  try {
    const res = await app.invokeTool<{ file_id: string | null; url: string | null }>(
      "documents_preview_pdf",
      { id: documentId },
    )
    if (!res?.url) return null
    const blob = await fetchBlob(res.url)
    const pdfBlob =
      blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" })
    return URL.createObjectURL(pdfBlob)
  } catch {
    return null
  }
}

/** False in a browser that downloads a PDF instead of showing it, such as most phones. */
function hasPdfViewer(): boolean {
  return typeof navigator === "undefined" || navigator.pdfViewerEnabled !== false
}

function PdfBody(p: {
  doc: DocumentSummary
  affordance: PdfAffordance
  onRetry: () => void
  onPreview: () => void
  onDownload: () => void
}): JSX.Element {
  // Keys the resource on (documentId, pdf_file_id) so an edit that re-renders
  // the PDF (new file id) triggers a fresh fetch — a stale blob URL would show
  // the PRE-edit PDF. `pdf_file_id` null (pending/failed) resolves to no fetch.
  const [embed] = createResource(
    () => (p.doc.pdf_file_id ? { id: p.doc.id, fileId: p.doc.pdf_file_id } : null),
    (key) => fetchPdfBlobUrl(key.id),
  )
  // Read only once settled: a pending read would hold back the PDF tab's own status and buttons.
  const embedUrl = () => (embed.state === "ready" ? embed() : undefined)
  createEffect(() => {
    const url = embedUrl()
    onCleanup(() => {
      if (url) URL.revokeObjectURL(url)
    })
  })

  return (
    <div
      data-testid="document-detail-pdf"
      class="flex h-full flex-col gap-2 px-4 py-3 text-[12.5px]"
    >
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="mb-1 text-text-secondary text-[11px] uppercase tracking-wider">
            {tr("PDF status")}
          </div>
          {/* `downloadEnabled` is true only once the render reached a usable PDF
              (ready / a3-skipped). The distinct testid lets the chaos visual
              checkpoint wait for the PDF to actually finish generating. */}
          <div
            data-testid={
              p.affordance.downloadEnabled
                ? "document-detail-pdf-ready"
                : "document-detail-pdf-status"
            }
            class="text-text"
          >
            {p.affordance.statusLabel}
          </div>
        </div>
        <div class="flex items-center gap-2">
          <Button
            variant="secondary"
            testid="document-detail-pdf-preview-inline"
            onClick={p.onPreview}
          >
            {tr("Preview")}
          </Button>
          <Button
            variant="primary"
            testid="document-detail-pdf-download-inline"
            onClick={p.onDownload}
            disabled={!p.affordance.downloadEnabled}
          >
            {tr("Download")}
          </Button>
        </div>
      </div>
      <Show when={p.doc.pdf_file_id}>
        <div class="text-text-tertiary">
          {tr("file_id:")} <span class="font-mono">{p.doc.pdf_file_id}</span>
        </div>
      </Show>
      <Show when={p.affordance.showRetry}>
        <button
          type="button"
          data-testid="document-detail-action-retry-pdf"
          onClick={p.onRetry}
          class="self-start rounded-md border border-border-subtle bg-surface px-3 py-1 text-text hover:bg-surface-hover"
        >
          {tr("Retry render")}
        </button>
      </Show>
      <Show when={p.affordance.showA3SkippedNote}>
        <div class="text-text-tertiary text-[11.5px]">
          {tr("Long-term archival metadata absent (PDF/A-3 normalization skipped).")}
        </div>
      </Show>
      <Show when={embedUrl()}>
        {(url) => (
          <Show
            when={hasPdfViewer()}
            fallback={
              <div data-testid="document-detail-pdf-unavailable" class="p-3 text-text-tertiary">
                {tr("Inline preview unavailable: use Preview or Download above.")}
              </div>
            }
          >
            {/* A frame, not a plugin element: the app's CSP allows no plugin content (object-src 'none'),
                and allows a frame from a blob: URL, which only this page can make. */}
            <iframe
              data-testid="document-detail-pdf-embed"
              src={url()}
              title={tr("PDF preview")}
              class="w-full flex-1 rounded-md border border-border-subtle"
              style={{ "min-height": "70vh", width: "100%" }}
            />
          </Show>
        )}
      </Show>
    </div>
  )
}

function LifecycleBody(p: { doc: DocumentSummary }): JSX.Element {
  const log = createMemo(() => p.doc.lifecycle_log ?? [])
  return (
    <div
      data-testid="document-detail-lifecycle"
      class="flex flex-col gap-2 px-4 py-3 text-[12.5px]"
    >
      <Show
        when={log().length > 0}
        fallback={<div class="text-text-tertiary">{tr("No lifecycle events yet.")}</div>}
      >
        <ul class="flex flex-col gap-1">
          <For each={log()}>
            {(entry) => (
              <li
                data-testid={`document-detail-lifecycle-${entry.event}`}
                class="flex gap-2 border-l-2 border-border-subtle pl-2"
              >
                <span class="font-mono text-text-tertiary">{fmtDate(entry.at)}</span>
                <span class="font-medium text-text">{entry.event}</span>
                <Show when={entry.actor}>
                  <span class="text-text-secondary">
                    {tr("by")} {entry.actor?.type}
                  </span>
                </Show>
                <Show when={entry.note}>
                  <span class="text-text-tertiary">({entry.note})</span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// DocumentDetail component.
// ─────────────────────────────────────────────────────────────────────────
export const DocumentDetail: Component<DocumentDetailProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<string>("overview")
  const [data, { refetch }] = createResource(() => props.documentId, loadDocument)
  // The document once it has loaded, kept on screen while a refetch runs. Everything outside the
  // detail's own <Suspense> reads it through this, never through `data()`: a pending read there
  // would suspend the host's tab boundary instead, leaving a blank pane (no "Loading…") on a cold
  // open and blanking the whole detail, tab strip included, on every refetch.
  const loaded = () =>
    data.state === "ready" || data.state === "refreshing" ? data.latest : undefined

  const tabs = createMemo(() => mergeTabs(loaded()?.externalTabs ?? []))
  const affordance = createMemo(() =>
    pdfStatusAffordance(loaded()?.document?.pdf_status ?? undefined),
  )
  // The active external (non-built-in) tab, if any. Carries the contributing
  // `app` needed to resolve the cross-app body via the host bridge.
  const activeExternalTab = createMemo(() =>
    tabs().find((t) => t.id === activeTab() && !BUILT_IN_IDS.has(t.id) && t.app),
  )

  // Inline note surfaced by `invoke()` for a header action that either threw
  // (ApiError/Error message) or came back as the kernel's gated-call envelope
  // (`{ blocked: {...} }`, resolved not thrown — `assertKnownParams` 400s are
  // caught too, since an unknown-param mismatch throws the same way).
  const [footerActionNote, setFooterActionNote] = createSignal<FooterActionNote | null>(null)
  let noteTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(noteTimer))
  const showActionNote = (note: FooterActionNote | null) => {
    clearTimeout(noteTimer)
    setFooterActionNote(note)
    if (note?.autoDismissMs) {
      noteTimer = setTimeout(() => {
        if (footerActionNote() === note) setFooterActionNote(null)
      }, note.autoDismissMs)
    }
  }

  const invoke = async (
    action: { tool: string; idParam: string },
    payload: Record<string, unknown> = {},
  ) => {
    showActionNote(null)
    try {
      const result = await app.invokeTool<unknown>(action.tool, {
        [action.idParam]: props.documentId,
        ...payload,
      })
      const note = footerActionResultNote(action.tool, result)
      showActionNote(note)
      if (isBlockedResult(result) || note?.isError) return
      props.onMutate?.()
      refetch()
    } catch (e) {
      showActionNote({
        text: e instanceof Error ? e.message : tr("The action failed."),
        isError: true,
      })
    }
  }

  const retryPdf = () => void invoke({ tool: "documents_retry_pdf", idParam: "id" })
  const markPaid = () => void invoke(FOOTER_ACTIONS.mark_paid)
  const sendToCustomer = () => void invoke(FOOTER_ACTIONS.send_to_customer)
  // Convert to invoice: confirm first, then invoke. The result is kept so a
  // Shopify conversion can say the order was created (the invoice itself
  // arrives asynchronously through the shopify/order:created auto-flow).
  const [confirmConvert, setConfirmConvert] = createSignal(false)
  const [converting, setConverting] = createSignal(false)
  const [convertNote, setConvertNote] = createSignal<string | null>(null)
  const askConvertToInvoice = () => {
    setConvertNote(null)
    setConfirmConvert(true)
  }
  const runConvertToInvoice = async () => {
    setConverting(true)
    try {
      const result = await app.invokeTool<unknown>(FOOTER_ACTIONS.convert_to_invoice.tool, {
        [FOOTER_ACTIONS.convert_to_invoice.idParam]: props.documentId,
      })
      setConvertNote(convertResultNote(result))
      props.onMutate?.()
      refetch()
    } catch (e) {
      setConvertNote(e instanceof Error ? e.message : "The conversion failed.")
    } finally {
      setConverting(false)
      setConfirmConvert(false)
    }
  }
  // Preview/Download resolve the rendered-PDF URL via the tool, then fetch the
  // bytes through the host (bound server + bearer) and open a blob URL. Auth is
  // bearer-in-memory (no session cookie), so a bare `window.open("/api/files/…/inline")`
  // navigation carries no credentials and the file route answers
  // {"error":"Unauthorized"}. A page-relative fetch is wrong too: under the
  // desktop or mobile shell it lands on the shell's own index.html.
  // Says so if the PDF has not rendered yet (the tool returns url: null).
  const openPdf = async (tool: string, mode: "preview" | "download") => {
    try {
      const res = await app.invokeTool<{ file_id: string | null; url: string | null }>(tool, {
        id: props.documentId,
      })
      if (!res?.url) {
        showActionNote({ text: pdfNotReadyNote(data()?.document?.pdf_status), isError: false })
        return
      }
      const blob = await fetchBlob(res.url)
      // Force the PDF mime so the browser renders a preview tab instead of
      // downloading (the inline route serves non-image mimes as attachment).
      const pdfBlob =
        blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" })
      // The desktop webview opens no tab and saves no blob download: there the host opens the PDF
      // in the system viewer, for preview and download alike.
      if (await openFile(pdfBlob, `${data()?.document.number ?? props.documentId}.pdf`)) return
      const url = URL.createObjectURL(pdfBlob)
      if (mode === "preview") {
        window.open(url, "_blank", "noopener")
      } else {
        const a = document.createElement("a")
        a.href = url
        a.download = `${data()?.document.number ?? props.documentId}.pdf`
        a.click()
      }
      // Give the new tab/download a moment to grab the blob before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch {
      // surfaced through the kernel sandbox-error channel / toast
    }
  }
  const previewPdf = () => void openPdf(FOOTER_ACTIONS.preview_pdf.tool, "preview")
  const downloadPdf = () => void openPdf(FOOTER_ACTIONS.download_pdf.tool, "download")
  const editDraft = () => navigate(`/invoicing/editor/${props.documentId}`)
  // Draft delete. Confirm-gated, so it can't ride the shared `invoke()` helper.
  // After a successful discard the document no longer exists, so we leave the
  // detail tab for the All-documents list rather than refetching a now-404
  // document (there is no Drafts route any more).
  const deleteDraft = async () => {
    if (!window.confirm(tr("Delete this draft? This cannot be undone."))) return
    try {
      await app.invokeTool(FOOTER_ACTIONS.delete_draft.tool, { draft_id: props.documentId })
      props.onMutate?.()
      navigate("/invoicing/documents/all")
    } catch {
      // Failure surfaces via the kernel's sandbox-error channel.
    }
  }

  return (
    <Suspense
      fallback={
        <div data-testid="document-detail-loading" class="p-4 text-text-tertiary">
          {tr("Loading…")}
        </div>
      }
    >
      {/* `data()` is read here, under the detail's own boundary, for the first load only; a
          refetch keeps the loaded document on screen (`loaded()`) instead of going back to it. */}
      <Show
        when={loaded() ?? data()}
        fallback={
          <Show when={data.state === "ready"}>
            <div
              data-testid="document-detail-not-found"
              class="p-6 text-[13px] text-text-secondary"
            >
              <p class="font-medium text-text">{tr("Document not found")}</p>
              <p class="mt-1">
                {tr("It may have been deleted, or it belongs to another organization.")}
              </p>
            </div>
          </Show>
        }
      >
        {(d) => {
          const doc = () => d().document
          const lines = () => d().lines
          return (
            <section data-testid="document-detail" class="flex h-full min-h-0 flex-col">
              {/* Header strip */}
              <header class="flex flex-col gap-1.5 border-b border-border-subtle px-5 py-3.5">
                <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div class="flex items-center gap-3">
                    <span
                      data-testid="document-detail-number"
                      class="font-mono text-[14px] font-medium text-text"
                    >
                      {doc().number ?? tr("Draft")}
                    </span>
                    <TypeLabel
                      type={doc().type}
                      testid="document-detail-type-chip"
                      class="text-[11px] uppercase tracking-wide text-text-tertiary"
                    />
                    <StatusBadge status={doc().status} testid="document-detail-status-chip" />
                    {/* payment_status is a separate axis from lifecycle status — a
                        Shopify-sourced invoice can be "issued" (boxtal still ships
                        it) yet already paid underneath. Credit notes are never
                        payable, so they never carry a meaningful payment_status. */}
                    <Show when={doc().type !== "credit_note" && doc().payment_status}>
                      {(paymentStatus) => <PaymentBadge paymentStatus={paymentStatus()} />}
                    </Show>
                    {/* Its own boundary: a secondary read can only hold back these chips. */}
                    <Suspense>
                      <MoneyChips documentId={doc().id} status={doc().status} type={doc().type} />
                    </Suspense>
                  </div>
                  {/* Actions — spec §12. Pinned to the top of the panel: the chat dock
                      floats over the panel's bottom-right corner, so a bottom action row
                      would sit under it. */}
                  <div
                    data-testid="document-detail-actions"
                    class="flex flex-wrap items-center justify-end gap-2"
                  >
                    {/* Delete draft — destructive, first in the group and set apart
                        from the positive actions by a divider. Only a draft can be
                        deleted; issued documents are legally immutable and are
                        reversed via a credit note, never deleted. */}
                    <Show when={doc().status === "draft"}>
                      <Button
                        variant="danger"
                        testid="document-detail-action-delete-draft"
                        onClick={deleteDraft}
                      >
                        {tr(FOOTER_ACTIONS.delete_draft.label)}
                      </Button>
                      <span aria-hidden="true" class="mx-1 h-5 w-px self-center bg-border-subtle" />
                    </Show>
                    <Show when={isEditableDocumentStatus(doc().status)}>
                      {/* Every editable status gets `document-detail-action-edit`. A draft ALSO keeps the
                          legacy `document-detail-action-edit-draft` testid (existing tests reference it) —
                          rendered as a second, visually-identical button is wasteful, so instead the draft
                          case sets BOTH testids via a wrapping span with data-testid duplication avoided by
                          picking the legacy id as primary and aliasing the new one underneath in the DOM. */}
                      <Show
                        when={doc().status === "draft"}
                        fallback={
                          <Button
                            variant="secondary"
                            testid="document-detail-action-edit"
                            onClick={editDraft}
                          >
                            {tr("Edit")}
                          </Button>
                        }
                      >
                        <span data-testid="document-detail-action-edit" class="contents">
                          <Button
                            variant="secondary"
                            testid="document-detail-action-edit-draft"
                            onClick={editDraft}
                          >
                            {tr("Edit draft")}
                          </Button>
                        </span>
                      </Show>
                    </Show>
                    {/* Credit notes are never payable, and Stripe settles an invoice it collects: no mark-paid. */}
                    <Show
                      when={doc().type !== "credit_note" && !stripeCollection(doc().external_refs)}
                    >
                      <Button
                        variant="ghost"
                        testid="document-detail-action-mark-paid"
                        onClick={markPaid}
                      >
                        {tr(FOOTER_ACTIONS.mark_paid.label)}
                      </Button>
                    </Show>
                    <Button
                      variant="secondary"
                      testid="document-detail-action-send-to-customer"
                      onClick={sendToCustomer}
                    >
                      {tr(FOOTER_ACTIONS.send_to_customer.label)}
                    </Button>
                    <Show when={canConvertToInvoice(doc())}>
                      <Button
                        variant="secondary"
                        testid="document-detail-action-convert-to-invoice"
                        onClick={askConvertToInvoice}
                      >
                        {tr(FOOTER_ACTIONS.convert_to_invoice.label)}
                      </Button>
                    </Show>
                    <Button
                      variant="secondary"
                      testid="document-detail-action-preview-pdf"
                      onClick={previewPdf}
                    >
                      {tr(FOOTER_ACTIONS.preview_pdf.label)}
                    </Button>
                    <Button
                      variant="primary"
                      testid="document-detail-action-download-pdf"
                      onClick={downloadPdf}
                      disabled={!affordance().downloadEnabled}
                    >
                      {FOOTER_ACTIONS.download_pdf.label}
                    </Button>
                  </div>
                </div>
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-text-tertiary">
                  <span>
                    {tr("Issued")}{" "}
                    <span class="text-text-secondary">{fmtDate(doc().issued_at)}</span>
                  </span>
                  <span>
                    {tr("Due")} <span class="text-text-secondary">{fmtDate(doc().due_at)}</span>
                  </span>
                  {/* Shopify-sourced invoices carry external_refs pointing back at
                      the originating order — link out to the real Shopify admin
                      page (no in-app order detail exists here; invoicing only
                      renders documents). Manual documents have no external_refs
                      and show nothing. */}
                  {/* The human order reference ("#1149") is what a customer
                      quotes and what support searches for — show it as text
                      whenever the document carries one, even for imported
                      documents whose refs hold no shop domain to link to. */}
                  <Show when={doc().shopify_order_number}>
                    {(orderNumber) => (
                      <span data-testid="document-detail-order-number">
                        {tr("Order")} <span class="text-text-secondary">{orderNumber()}</span>
                      </span>
                    )}
                  </Show>
                  {/* The customer's purchase order number, when they gave one — shown next to
                      the Shopify order reference so an operator sees both at a glance. */}
                  <Show when={doc().po_number}>
                    {(poNumber) => (
                      <span data-testid="document-detail-po-number">
                        {tr("PO number")} <span class="text-text-secondary">{poNumber()}</span>
                      </span>
                    )}
                  </Show>
                  {/* A quote that IS a Shopify draft order names it, so the
                      operator knows the two are the same object. */}
                  <Show when={doc().shopify_draft_order_name}>
                    {(draftOrderName) => (
                      <span data-testid="document-detail-draft-order-ref">
                        {tr("Shopify draft order")}{" "}
                        <span class="text-text-secondary">{draftOrderName()}</span>
                      </span>
                    )}
                  </Show>
                  {/* The hops out: the customer's contact (their company is on it), and the Stripe
                      customer whose invoice this one is, when Stripe collects it. */}
                  <Show when={doc().counterparty_contact_id}>
                    {(contactId) => (
                      <a
                        data-testid="document-detail-open-contact"
                        class="inline-flex items-center gap-1 text-accent hover:underline"
                        href={`/contacts/${encodeURIComponent(contactId())}`}
                        onClick={(e) => {
                          e.preventDefault()
                          navigate(`/contacts/${encodeURIComponent(contactId())}`)
                        }}
                      >
                        {tr("Open the customer")}
                      </a>
                    )}
                  </Show>
                  <Show when={stripeCollection(doc().external_refs)}>
                    {(stripe) => (
                      <span
                        data-testid="document-detail-stripe"
                        class="inline-flex items-center gap-1"
                      >
                        {tr("Collected by Stripe")}{" "}
                        <Show
                          when={stripe().customerId}
                          fallback={
                            <span class="font-mono text-text-secondary">{stripe().invoiceId}</span>
                          }
                        >
                          {(customerId) => (
                            <a
                              data-testid="document-detail-open-stripe"
                              class="font-mono text-accent hover:underline"
                              href={`/stripe/customers/${encodeURIComponent(customerId())}`}
                              onClick={(e) => {
                                e.preventDefault()
                                navigate(`/stripe/customers/${encodeURIComponent(customerId())}`)
                              }}
                            >
                              {stripe().invoiceId}
                            </a>
                          )}
                        </Show>
                      </span>
                    )}
                  </Show>
                  <Show when={shopifyOrderUrl(doc().external_refs)}>
                    {(href) => (
                      <a
                        data-testid="document-detail-open-shopify-order"
                        class="inline-flex items-center gap-1 text-accent hover:underline"
                        href={href()}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {tr("Open Shopify order")}
                        <span aria-hidden="true">↗</span>
                      </a>
                    )}
                  </Show>
                </div>
                {/* Free-text notes printed on the document, shown right under the PO-number
                    strip. Line breaks are meaningful (customs mentions, addresses), so the
                    text keeps its own whitespace. Editing happens in the Editor, reachable
                    for every editable status (isEditableDocumentStatus). */}
                <Show when={doc().notes}>
                  {(notes) => (
                    <p
                      data-testid="document-detail-notes"
                      class="whitespace-pre-wrap text-[11.5px] text-text-secondary"
                    >
                      <span class="text-text-tertiary">{tr("Notes")} </span>
                      {notes()}
                    </p>
                  )}
                </Show>
              </header>

              {/* Action outcome (mark paid / send to customer / retry
                  render). Reuses the same note-strip styling as the convert
                  outcome below; an error (thrown ApiError, or a rejected
                  `assertKnownParams`) renders in the error tone instead of
                  the neutral one, so a broken call is visible instead of
                  silently doing nothing. */}
              <Show when={footerActionNote()}>
                {(note) => (
                  <div
                    data-testid="document-detail-action-note"
                    class={cx(
                      "border-b px-5 py-2.5 text-[12px]",
                      note().isError
                        ? "border-error-border bg-error-glow text-error"
                        : "border-border-subtle bg-surface text-text-secondary",
                    )}
                  >
                    {note().text}
                  </div>
                )}
              </Show>

              {/* Conversion outcome. A Shopify conversion lands as an ORDER
                  first; the invoice follows asynchronously through the
                  order-created auto-flow, so say so instead of leaving the
                  screen looking unchanged. */}
              <Show when={convertNote()}>
                {(note) => (
                  <div
                    data-testid="document-detail-convert-result"
                    class="border-b border-border-subtle bg-surface px-5 py-2.5 text-[12px] text-text-secondary"
                  >
                    {note()}
                  </div>
                )}
              </Show>

              {/* Tab strip */}
              <nav
                data-testid="document-detail-tabs"
                class="flex items-center gap-1 border-b border-border-subtle px-2"
              >
                <For each={tabs()}>
                  {(tab) => (
                    <button
                      type="button"
                      data-testid={`document-detail-tab-${tab.id}`}
                      onClick={() => setActiveTab(tab.id)}
                      class={`px-3 py-1.5 text-[12.5px] transition-colors ${
                        activeTab() === tab.id
                          ? "border-b-2 border-accent text-text"
                          : "text-text-secondary hover:text-text"
                      }`}
                    >
                      {tr(tab.label)}
                    </button>
                  )}
                </For>
              </nav>

              {/* Tab body, under its own boundary: a panel's pending read (the PDF preview, the
                  regime line, the e-invoice panel, a contributed tab) can only hold back the body,
                  never the header and tab strip above it. */}
              <div class="flex-1 overflow-y-auto">
                <Suspense
                  fallback={
                    <div data-testid="document-detail-body-loading" class="p-4 text-text-tertiary">
                      {tr("Loading…")}
                    </div>
                  }
                >
                  <Show when={activeTab() === "overview"}>
                    <OverviewBody doc={doc()} lines={lines()} />
                  </Show>
                  <Show when={activeTab() === "customs"}>
                    <CustomsBody doc={doc()} lines={lines()} />
                  </Show>
                  <Show when={activeTab() === "pdf"}>
                    <PdfBody
                      doc={doc()}
                      affordance={affordance()}
                      onRetry={retryPdf}
                      onPreview={previewPdf}
                      onDownload={downloadPdf}
                    />
                  </Show>
                  <Show when={activeTab() === "lifecycle"}>
                    <LifecycleBody doc={doc()} />
                  </Show>
                  {/* External (slot-host) tab body. The host bridge resolves the
                    contributing app's registered component and mounts it into
                    the anchor — invoicing never imports the contributor's
                    component (portable to the future iframe boundary). On a
                    genuine resolution miss (bundle-load failure) the K5
                    "Tab unavailable" fallback is preserved. */}
                  <Show when={activeExternalTab()}>
                    {(tab) => {
                      let anchor!: HTMLDivElement
                      const [resolved, setResolved] = createSignal(true)
                      createEffect(() => {
                        const ext = tab()
                        const handle = app.mountSlot(anchor, {
                          slot: "invoicing.document_detail.tabs",
                          app: ext.app as string,
                          id: ext.id,
                          entityId: props.documentId,
                        })
                        setResolved(handle.resolved)
                        onCleanup(() => handle.dispose())
                      })
                      return (
                        <div data-testid={`document-detail-tab-body-${tab().id}`} class="h-full">
                          <div ref={anchor} class="h-full" />
                          <Show when={!resolved()}>
                            {/* K5 contract: agreed copy when the contributing app's
                              component fails to resolve (genuine bundle-load failure). */}
                            <div class="px-4 py-3 text-[12.5px] text-text-tertiary">
                              {tr(
                                "Tab unavailable: the contributing app's component is not loaded.",
                              )}
                            </div>
                          </Show>
                        </div>
                      )
                    }}
                  </Show>
                </Suspense>
              </div>

              <ConfirmDialog
                open={confirmConvert()}
                title={tr(FOOTER_ACTIONS.convert_to_invoice.label)}
                body={convertConfirmBody(doc())}
                confirmLabel={tr(FOOTER_ACTIONS.convert_to_invoice.label)}
                busy={converting()}
                onConfirm={() => void runConvertToInvoice()}
                onCancel={() => setConfirmConvert(false)}
                testid="document-detail-confirm-convert"
              />
            </section>
          )
        }}
      </Show>
    </Suspense>
  )
}
