// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Documents — the unified primary view (`/invoicing/documents/:typeFilter`).
//
// This is the single, powerful documents surface that absorbed the former
// All-sales / B2B / By-market dashboards: one filterable table with a "Group
// by" switch (List / By customer / By market). The sidebar's All / Invoices /
// Quotes / Proformas / Purchase orders links drive the `:typeFilter` segment
// (passed as the `entityId` prop). Awaiting-payment and Customs remain separate
// focused views (a payment worklist and an export-compliance view) — they
// answer different questions, not just a different grouping of the same table.

import { app, currentPath, fetchBlob, onEntityChange, openFile } from "@liaison/host"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js"
import {
  ALL_SALES_COLUMNS,
  B2B_COLUMNS,
  BY_MARKET_COLUMNS,
  type DashboardColumn,
  emptyListText,
  toCsv,
} from "./dashboards/columns"
import { DataTable } from "./dashboards/DataTable"
import { groupByCountry, groupByCustomer, perCurrencyRollup } from "./dashboards/groupings"
import { orderGid, searchDocuments, searchParamsFromFilter } from "./dashboards/loader"
import { downloadPair } from "./dashboards/pair-download"
import {
  creditedIndicatorOf,
  pairLabelOf,
  pairMemberIds,
  pairSplitDocuments,
} from "./dashboards/pair-split"
import { Toolbar } from "./dashboards/Toolbar"
import {
  applyFilter,
  type DashboardFilter,
  DEFAULT_FILTER,
  type DocumentRow,
  filterRowsForTab,
} from "./dashboards/types"
import { tr, uiLocale } from "./i18n"
import { Segmented } from "./kit"
import { documentSearch, searchInPath, setDocumentSearch } from "./search-store"
import { rememberDocumentLabel } from "./tab-labels"

type DocType = "invoice" | "quote" | "proforma" | "purchase_order" | "credit_note"

const TYPE_FOR_FILTER: Record<string, DocType | undefined> = {
  invoices: "invoice",
  quotes: "quote",
  proformas: "proforma",
  "purchase-orders": "purchase_order",
  "credit-notes": "credit_note",
  // "all" (and anything unrecognised) → no type filter. There is no drafts
  // segment any more: draft is not a user-facing document category, so draft
  // rows are stripped from every tab client-side.
}

const TYPE_NOUN: Record<string, { one: string; other: string }> = {
  invoices: { one: "invoice", other: "invoices" },
  quotes: { one: "quote", other: "quotes" },
  proformas: { one: "proforma", other: "proformas" },
  "purchase-orders": { one: "purchase order", other: "purchase orders" },
  "credit-notes": { one: "credit note", other: "credit notes" },
}
const DEFAULT_NOUN = { one: "document", other: "documents" }

type GroupMode = "flat" | "customer" | "market"
const GROUP_OPTS: ReadonlyArray<{ value: GroupMode; label: string }> = [
  { value: "flat", label: "List" },
  { value: "customer", label: "By customer" },
  { value: "market", label: "By market" },
]

// Payment column — appended to the flat List view only (spec §12's
// ALL_SALES_COLUMNS pin stays exact; this is a local addition layered on
// top so a synced Shopify invoice reads as "Paid" in the list the user
// scans, not just "Issued"). Reuses `kind: "status"` so DataTable's
// StatusBadge renders it (its tone table already maps paid -> success,
// refunded -> muted; partial/unpaid fall back to the neutral tone like any
// other unmapped status). Credit notes are never payable and carry no
// meaningful payment_status, but DataTable's empty-cell dash fallback is
// skipped for `kind: "status"` cells — so `get` always returns a real
// string ("unpaid" default) rather than "" to avoid rendering a bare,
// label-less badge dot on those rows.
const PAYMENT_COLUMN: DashboardColumn = {
  key: "payment",
  label: "Payment",
  get: (r: DocumentRow) => r.payment_status ?? "unpaid",
  kind: "status",
}
// The customer's PO number — another local addition on top of the pinned ALL_SALES_COLUMNS
// (same reasoning as PAYMENT_COLUMN above): visible in the list, not just the detail page, so
// a search result is recognisable without opening each row. Blank for documents with none.
const PO_NUMBER_COLUMN: DashboardColumn = {
  key: "po_number",
  label: "PO number",
  get: (r: DocumentRow) => r.po_number ?? "",
  // The operator reads this one against a paper purchase order, character by
  // character, so it takes its content width rather than sharing the squeeze
  // with every other column.
  fit: true,
}
// Exported so pair-split.test.ts can render the real DataTable with exactly
// the columns this list passes it, no re-derivation.
export const LIST_COLUMNS: DashboardColumn[] = [
  ...ALL_SALES_COLUMNS,
  PAYMENT_COLUMN,
  PO_NUMBER_COLUMN,
]

/**
 * THE FLAT LIST IS TOO WIDE FOR A 1440 px WINDOW.
 *
 * CardTable keeps a 7.5rem floor under every visible column, so ten columns
 * ask for 1200 px. The documents pane at 1440 is about 1130 px wide: the table
 * overflowed it by roughly 68 px, and since the container scrolls sideways
 * with no affordance the overflow read as "PO number does not exist" rather
 * than "PO number is off to the right". The lowest priority column steps out
 * below the width where all ten fit, which is exactly what the tablet tier
 * already does one size down.
 *
 * Channel is the one that goes: it says Shopify or Manual, which the Order
 * column beside it already implies, and it is the only column here nobody
 * reconciles against paperwork. It stays in the CSV export at every width, so
 * nothing is actually lost.
 */
export const NARROWED_LIST_COLUMN_KEY = "channel"

/** The narrowest viewport that fits all ten columns in the documents pane. */
export const FULL_LIST_MIN_VIEWPORT = 1536

export function listColumnsForWidth(viewportWidth: number): DashboardColumn[] {
  if (viewportWidth >= FULL_LIST_MIN_VIEWPORT) return LIST_COLUMNS
  return LIST_COLUMNS.filter((c) => c.key !== NARROWED_LIST_COLUMN_KEY)
}

/** Reactive `true` while `query` matches; `false` with no `matchMedia`, so a
 *  non-DOM render is the full table. */
function createMediaMatch(query: string): () => boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => false
  const list = window.matchMedia(query)
  const [matches, setMatches] = createSignal(list.matches)
  const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
  if (typeof list.addEventListener === "function") {
    list.addEventListener("change", onChange)
    onCleanup(() => list.removeEventListener("change", onChange))
  }
  return matches
}

export const InvoicingDocumentsList: Component<{ entityId?: string }> = (props) => {
  // A search in the route (`?q=`, the sidebar's Enter) wins: framed, the
  // sidebar is another frame and the shared signal never reaches this one.
  const routeSearch = searchInPath(currentPath())
  if (routeSearch !== null && routeSearch !== documentSearch()) setDocumentSearch(routeSearch)
  const [filter, setFilter] = createSignal<DashboardFilter>({
    ...DEFAULT_FILTER,
    query: documentSearch(),
  })
  onMount(() => {
    const followRoute = () => {
      const q = searchInPath(currentPath())
      if (q !== null && q !== documentSearch()) setDocumentSearch(q)
    }
    window.addEventListener("popstate", followRoute)
    onCleanup(() => window.removeEventListener("popstate", followRoute))
  })
  const [group, setGroup] = createSignal<GroupMode>("flat")
  const typeKey = () => props.entityId ?? "all"

  // Two-way sync with the sidebar search box (shared module signal). The
  // sidebar drives the table's query; edits in the toolbar reflect back so the
  // sidebar box stays in step. Equality guards prevent an update loop.
  createEffect(() => {
    const q = documentSearch()
    setFilter((f) => (f.query === q ? f : { ...f, query: q }))
  })
  const onFilterChange = (next: DashboardFilter) => {
    setFilter(next)
    if (next.query !== documentSearch()) setDocumentSearch(next.query)
  }

  const [data, { refetch }] = createResource(
    () => ({ f: filter(), type: TYPE_FOR_FILTER[typeKey()] }),
    async ({ f, type }): Promise<DocumentRow[]> => {
      // Every tab shows issued-and-later documents. Draft is not a user-facing
      // category, so draft rows are stripped client-side (the status filter is
      // single-value equality server-side, so "not draft" cannot be expressed
      // there). Legacy draft rows stay reachable by direct link only.
      const rows = await searchDocuments({ ...searchParamsFromFilter(f), type })
      return filterRowsForTab(applyFilter(rows, f), false)
    },
  )

  // Live: an invoice the app issues while the list is open (an order's
  // invoice, seconds after the order lands) shows without a reload.
  onEntityChange("invoicing:document", () => void refetch())

  // Split-order pairing applies to the FLAT list only. The grouped views
  // aggregate rows into synthetic per-customer/per-market lines, where an
  // individual document -- and therefore its other half -- no longer exists.
  const paired = createMemo(() => pairSplitDocuments(data() ?? []))
  const rows = createMemo<DocumentRow[]>(() => {
    const base = data() ?? []
    if (group() === "customer") return groupByCustomer(base)
    if (group() === "market") return groupByCountry(base)
    return paired().map((p) => p.row)
  })
  const pairingOf = (r: DocumentRow) => {
    if (group() !== "flat") return null
    const hit = paired().find((p) => p.row.id === r.id)
    return hit?.pairKey ? { key: hit.pairKey, position: hit.position } : null
  }
  // The co-resident adjacency label wins when the credit note is on screen (it names exactly
  // what is visibly paired); otherwise fall back to the invoice's own lifecycle_log-derived
  // indicator, so "this invoice was credited" is never lost just because the credit note is on
  // another page or a different tab.
  const pairLabel = (r: DocumentRow) =>
    group() === "flat" ? (pairLabelOf(paired(), r.id) ?? creditedIndicatorOf(r)) : null
  const belowFullList = createMediaMatch(`(max-width: ${FULL_LIST_MIN_VIEWPORT - 1}px)`)
  /** What the TABLE draws. */
  const columns = createMemo<DashboardColumn[]>(() =>
    group() === "customer"
      ? B2B_COLUMNS
      : group() === "market"
        ? BY_MARKET_COLUMNS
        : listColumnsForWidth(
            belowFullList() ? FULL_LIST_MIN_VIEWPORT - 1 : FULL_LIST_MIN_VIEWPORT,
          ),
  )
  /** What the CSV carries: every column, whatever the window is doing. A
   *  narrow window is a drawing constraint, not an export one. */
  const csvColumns = createMemo<DashboardColumn[]>(() =>
    group() === "customer" ? B2B_COLUMNS : group() === "market" ? BY_MARKET_COLUMNS : LIST_COLUMNS,
  )
  const nounForms = () => {
    const forms = TYPE_NOUN[typeKey()] ?? DEFAULT_NOUN
    return { one: tr(forms.one), other: tr(forms.other) }
  }
  const noun = () => nounForms().other

  // Both halves of a split order, saved as two separate files. Never merged:
  // one PDF containing both would put the software lines in front of the
  // customs officer reading the goods invoice, which is the exact thing the
  // split exists to prevent.
  const [downloading, setDownloading] = createSignal<string | null>(null)
  const downloadBoth = async (pairKey: string) => {
    if (downloading()) return
    setDownloading(pairKey)
    try {
      const ids = pairMemberIds(paired(), pairKey)
      const byId = new Map((data() ?? []).map((d) => [d.id, d]))
      await downloadPair(
        ids.map((id) => ({ id, number: byId.get(id)?.number ?? null })),
        {
          resolveUrl: async (id) => {
            const res = await app.invokeTool<{ url: string | null }>("documents_download_pdf", {
              id,
            })
            return res?.url ?? null
          },
          // Through the host: bound server + bearer. A page-relative fetch
          // lands on the desktop or mobile shell's own index.html.
          fetchBlob: (url) => fetchBlob(url),
          save: async (blob, filename) => {
            // The desktop webview saves no blob download: the host opens the PDF instead.
            if (await openFile(blob, filename)) return
            const url = URL.createObjectURL(blob)
            const a = document.createElement("a")
            a.href = url
            a.download = filename
            a.click()
            setTimeout(() => URL.revokeObjectURL(url), 60_000)
          },
        },
      )
    } finally {
      setDownloading(null)
    }
  }

  const exportCsv = () => {
    const csv = toCsv(csvColumns(), rows())
    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `invoicing-documents-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div data-testid="invoicing-documents-list" class="flex h-full min-h-0 flex-col">
      <Toolbar
        filter={filter()}
        onChange={onFilterChange}
        onExportCsv={exportCsv}
        trailing={
          <Segmented
            options={GROUP_OPTS.map((o) => ({ ...o, label: tr(o.label) }))}
            value={group()}
            onChange={setGroup}
            testidPrefix="invoicing-documents-group"
            ariaLabel={tr("Group documents by")}
          />
        }
      />
      <DataTable
        columns={columns()}
        rows={rows()}
        emptyState={
          group() === "flat"
            ? // A date-only ISO string is read as UTC midnight.
              emptyListText(filter(), tr, (iso) =>
                new Intl.DateTimeFormat(uiLocale(), {
                  dateStyle: "medium",
                  timeZone: "UTC",
                }).format(new Date(iso)),
              )
            : tr("No {{noun}} to group.", { noun: noun() })
        }
        testid="invoicing-documents-table"
        rowTestid={() => "invoicing-documents-row"}
        // The order the row bills, as the Shopify app names it (its gid): a
        // guided tour rings the invoice of the order it just watched arrive.
        rowData={(r): Record<string, string> =>
          r.shopify_order_id ? { "data-shopify-order-id": orderGid(r.shopify_order_id) } : {}
        }
        footer={() => perCurrencyRollup(data() ?? [], nounForms())}
        pairing={group() === "flat" ? pairingOf : undefined}
        pairLabel={group() === "flat" ? pairLabel : undefined}
        pairAction={(key) => {
          // Two members (a split pair, or one invoice + one credit note):
          // "Both PDFs". Three or more (an invoice with several credit
          // notes): "Both" no longer describes it.
          const count = pairMemberIds(paired(), key).length
          const label = count > 2 ? "All PDFs" : "Both PDFs"
          const title =
            count > 2
              ? "Download every document in this group"
              : "Download both documents in this group"
          return (
            <button
              type="button"
              // shrink-0 + nowrap: it shares the payment cell with the status
              // badge, and on the wider EUR figures it was wrapping to "Both /
              // PDFs" -- a two-line control that reads as broken layout.
              class="shrink-0 whitespace-nowrap rounded border border-border px-1.5 py-0.5 text-[10.5px] font-medium text-text-secondary opacity-70 transition-opacity hover:bg-surface-hover hover:opacity-100"
              title={title}
              onClick={(e) => {
                // The row itself is a link to the goods document; without this the
                // click would navigate away mid-download.
                e.stopPropagation()
                void downloadBoth(key)
              }}
            >
              {label}
            </button>
          )
        }}
        rowHref={
          group() === "flat"
            ? (r) => {
                // The row already knows the document number — remember it so
                // the detail tab opens ALREADY named "INV-2026-0001" instead
                // of the generic view label (idempotent re-set is a no-op).
                rememberDocumentLabel(r.id, r.number ?? `${r.type} draft`)
                return `/invoicing/document/${r.id}`
              }
            : undefined
        }
      />
    </div>
  )
}
