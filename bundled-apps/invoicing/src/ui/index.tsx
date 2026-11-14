// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 — Invoicing UI module entrypoint.
//
// Every component name referenced from `app.manifest.json` (under
// `views.activityBar.icon`, `views.tabTypes.*.component|sidebar|icon`,
// `slots.*.component`, `views.settings[].component`) must be re-exported
// from here so freeze-app's UI bundling picks them up.

import { app } from "@liaison/host"
import { type Component, createResource, Show } from "solid-js"
import { tr } from "./i18n"

export { CompanyMoneyPanel } from "./CompanyMoneyPanel"
export { ContactDocumentsPanel } from "./ContactDocumentsPanel"
export { InvoicingDeferred } from "./DeferredList"
export { DocumentDetail } from "./DocumentDetail"
export { AwaitingPayment } from "./dashboards/AwaitingPayment"
export { Editor } from "./Editor"
export { EditorSummary } from "./EditorSummary"
export { EinvoicingRegistration } from "./einvoicing/EinvoicingRegistration"
export { InvoicingIssuerStreams } from "./IssuerStreams"
export { InvoicingAppIcon } from "./icon"
export { InvoicingIdentity } from "./identity/IdentityEditor"
export { MonthEndRunPanel } from "./MonthEndRunPanel"
export { InvoicingRecurringList } from "./RecurringList"
export { RecurringStates } from "./RecurringStates"
export { InvoicingRunDetail } from "./RunDetail"
export { InvoicingReadiness } from "./readiness/Readiness"
export { InvoicingReceivedDetail } from "./received/ReceivedDetail"
export { InvoicingReceived } from "./received/ReceivedList"
export { InvoicingScheduleEditor } from "./ScheduleEditor"
export { InvoicingIssuerProfiles } from "./settings"
export { InvoicingSidebar } from "./sidebar"
export { resolveDocumentTabLabel } from "./tab-labels"

import {
  type DocumentLine as DetailDocumentLine,
  DocumentDetail,
  type DocumentSummary,
} from "./DocumentDetail"
import { InvoicingDocumentsList } from "./DocumentsList"
// The `dashboard` tabType (`/invoicing/dashboards/:dashboardId`) now serves only
// the Awaiting-payment worklist. The former All-sales / B2B / By-market
// dashboards collapsed into the unified Documents view (DocumentsList) with a
// "Group by" switch; there is no separate customs view — export documents are
// just invoices carrying extra fields, shown inside the document itself.
import { AwaitingPayment } from "./dashboards/AwaitingPayment"
import { type DocType, type DraftDocument, type DraftLine, defaultDraft, Editor } from "./Editor"

export const InvoicingDashboard: Component<{ entityId?: string }> = () => <AwaitingPayment />

/** Maps a `documents_get` line (documentId's `lines[]`) to the editor's
 *  `DraftLine` shape. Field names carry over exactly — `documents_get`'s
 *  lines expose `unit_price_minor` as a STRING (see DocumentDetail.tsx),
 *  which is what `DraftLine.unit_price_minor` expects too.
 *
 *  `tax_rate_bp` is nullable on the wire: null means the line has never had an explicit per-line
 *  VAT override, and issuing falls back to the issuer's classified rate. `tax_rate_bp_overridden`
 *  carries that distinction into the Editor's own state so `buildItems` never echoes a rate back
 *  as an override for a line that never had one (see Editor.tsx buildItems). A null reads as 0
 *  here ONLY as a placeholder DraftLine.tax_rate_bp always needs a concrete number for
 *  display/math; `applyNetToGrossOnLoad` corrects it to the issuer's actual classified rate (via
 *  `classify()`, the SAME function the server re-applies at save/issue) once the matching issuer
 *  profile resolves, so the gross-up on load and the re-net on save use the identical rate and the
 *  net -> gross -> net round trip stays exact. */
function mapLine(l: DetailDocumentLine): DraftLine {
  const overridden = l.tax_rate_bp != null
  return {
    position: l.position,
    description: l.description,
    quantity: l.quantity,
    unit_price_minor: String(l.unit_price_minor),
    tax_rate_bp: overridden ? (l.tax_rate_bp as number) : 0,
    tax_rate_bp_overridden: overridden,
    hs_code: l.hs_code ?? null,
    country_of_origin: l.country_of_origin ?? null,
    customs_description: l.customs_description ?? null,
  }
}

/** Maps a loaded `documents_get` document + lines into the editor's
 *  `DraftDocument` shape. Non-draft statuses map through unchanged —
 *  Editor's `readOnly()` derives the read-only banner from `status`. Fields
 *  `documents_get` doesn't carry (language / issuer_country / issuer_vat_id /
 *  invoice_approval_threshold_minor) fall back to `defaultDraft()`'s values;
 *  they only drive soft UI affordances (EU-VAT warning, approval badge), not
 *  save/issue correctness. */
export function mapDocumentToDraft(
  doc: DocumentSummary,
  lines: DetailDocumentLine[],
): DraftDocument {
  const base = defaultDraft(doc.type)
  return {
    id: doc.id,
    type: doc.type,
    status: doc.status as DraftDocument["status"],
    currency: doc.currency,
    language: base.language,
    incoterm: (doc.incoterm as DraftDocument["incoterm"]) ?? base.incoterm,
    issuer_profile_id: doc.issuer_profile_id ?? null,
    issuer_country: base.issuer_country,
    issuer_vat_id: null,
    counterparty_name: doc.counterparty_name ?? null,
    counterparty_email: doc.counterparty_email ?? null,
    counterparty_vat_id: doc.counterparty_vat_id ?? null,
    counterparty_address: doc.counterparty_address ?? null,
    counterparty_shipping_address: doc.counterparty_shipping_address ?? null,
    counterparty_shipping_name: doc.counterparty_shipping_name ?? null,
    counterparty_country: doc.counterparty_country ?? null,
    counterparty_contact_id: doc.counterparty_contact_id ?? null,
    // documents_get returns pg timestamps ("2026-08-15 00:00:00+00"); the
    // editor's <input type="date"> needs bare ISO dates.
    issued_at: doc.issued_at ? String(doc.issued_at).slice(0, 10) : null,
    due_at: doc.due_at ? String(doc.due_at).slice(0, 10) : null,
    tax_treatment: doc.tax_treatment ?? base.tax_treatment,
    notes: doc.notes ?? null,
    customer_kind: doc.customer_kind ?? null,
    operation_category: doc.operation_category ?? null,
    billing_line1: doc.billing_line1 ?? null,
    billing_line2: doc.billing_line2 ?? null,
    billing_postcode: doc.billing_postcode ?? null,
    billing_city: doc.billing_city ?? null,
    billing_country_code: doc.billing_country_code ?? null,
    lines: lines.length > 0 ? lines.map(mapLine) : base.lines,
  }
}

interface LoadedEditorDoc {
  document: DocumentSummary
  lines: DetailDocumentLine[]
}

interface ToolErrorPayload {
  status: "error"
  error: { code: string; message: string }
}

function isToolError(v: unknown): v is ToolErrorPayload {
  return (
    typeof v === "object" &&
    v !== null &&
    "status" in v &&
    (v as { status: unknown }).status === "error" &&
    "error" in v
  )
}

export async function loadEditorDocument(id: string): Promise<LoadedEditorDoc> {
  const doc = await app.invokeTool<
    (DocumentSummary & { lines?: DetailDocumentLine[] }) | ToolErrorPayload | null
  >("documents_get", { id })
  if (!doc) throw new Error(`document not found: ${id}`)
  if (isToolError(doc)) {
    throw new Error(doc.error?.message ?? doc.error?.code ?? "Failed to load the document.")
  }
  return { document: doc, lines: doc.lines ?? [] }
}

const NEW_ENTITY_PREFIX = "new:"

/** True for the "create a new document" entityIds: bare `"new"`, the legacy
 *  bare-undefined case, or the type-encoded `"new:<type>"` form. */
export function isNewDocumentEntityId(entityId: string | undefined): boolean {
  return !entityId || entityId === "new" || entityId.startsWith(NEW_ENTITY_PREFIX)
}

/** Parses the doc type encoded IN the entityId path segment (`new:quote`),
 *  defaulting to `"quote"` for the bare `"new"` form or an unrecognized
 *  type. Only quote / proforma / purchase order can be started by hand:
 *  invoices come from orders or from converting a quote or proforma, credit
 *  notes come from refunds, so `new:invoice` / `new:credit_note` are no
 *  longer recognized and fall back to `quote` too.
 *  The type is encoded in the entityId — NOT a `?type=` query param —
 *  because the kernel's tab router only ever forwards the `entityId` prop to
 *  a tab's component (MainPanel renders `<Dynamic entityId={tab.entityId} />`);
 *  the query string never reaches here. Reading `window.location.search`
 *  directly read whichever tab happened to be current in the address bar
 *  rather than the tab actually being rendered — a wrong-tab-URL bug under
 *  keep-alive tab rendering (C3). */
export function parseDocTypeFromEntityId(entityId: string | undefined): DocType {
  const raw = entityId?.startsWith(NEW_ENTITY_PREFIX)
    ? entityId.slice(NEW_ENTITY_PREFIX.length)
    : undefined
  return raw === "quote" || raw === "proforma" || raw === "purchase_order" ? raw : "quote"
}

// Editor tab surface (`/invoicing/editor/:documentId`). A NEW document (see
// `isNewDocumentEntityId`) starts from `defaultDraft(type)` where `type` comes
// from `parseDocTypeFromEntityId`. An EXISTING document id (no `new`/`new:`
// prefix) loads the real draft via `documents_get` and maps it into the
// editor's DraftDocument shape; non-draft statuses still render (read-only,
// per Editor's readOnly()).
export const InvoicingEditor: Component<{ entityId?: string }> = (props) => {
  const isNew = () => isNewDocumentEntityId(props.entityId)
  const type = () => parseDocTypeFromEntityId(props.entityId)

  const [loaded] = createResource(
    () => (isNew() ? null : (props.entityId ?? null)),
    async (id) => loadEditorDocument(id as string),
  )

  return (
    <Show when={!isNew()} fallback={<Editor initial={defaultDraft(type())} />}>
      <Show
        when={loaded()}
        fallback={
          <Show when={loaded.error}>
            <div
              data-testid="invoicing-editor-load-error"
              class="flex h-full items-center justify-center p-6 text-[12.5px] text-error"
            >
              {loaded.error instanceof Error
                ? loaded.error.message
                : tr("Failed to load the document.")}
            </div>
          </Show>
        }
      >
        {(d) => (
          <Editor
            initial={mapDocumentToDraft(d().document, d().lines)}
            documentId={props.entityId}
          />
        )}
      </Show>
    </Show>
  )
}

// Document detail tab surface (`/invoicing/document/:documentId`). The kernel
// passes the document id as the `entityId` prop; DocumentDetail loads it via
// `documents_get`.
export const InvoicingDocumentDetail: Component<{ entityId?: string }> = (props) => (
  <DocumentDetail documentId={props.entityId ?? ""} />
)

// The Invoicing activity-bar entry lands here — it IS the documents view
// (all types), not a separate placeholder surface. The former Phase-17-F
// "Invoicing Home — coming soon" stub survived long past F-stage and made
// the app's main entry point look dead.
export const InvoicingHome: Component = () => <InvoicingDocumentsList entityId="all" />
export { InvoicingDocumentsList } from "./DocumentsList"
