// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dashboard column shapes + CSV export logic. Pulled out of the SolidJS
// components so the per-dashboard column contract is unit-testable under
// `bun:test` without jsdom — the components are then thin presentational
// shells over these contracts.
//
// Each `*_COLUMNS` array is the source-of-truth for column ordering, label,
// and CSV header. `toCsv()` consumes the array + a row list and emits a
// spec-compliant CSV with field-escaping (commas, quotes, newlines).
import { csvCell } from "../../csv"
import { currencyExponent } from "../../money"
import { type DashboardFilter, DEFAULT_FILTER, type DocumentRow } from "./types"

export interface DashboardColumn<R = DocumentRow> {
  /** Header label (used by both the table head and the CSV header row). */
  key: string
  /** Display label — table header text. */
  label: string
  /** Accessor producing a string for the table cell + CSV cell. */
  get: (row: R) => string
  /**
   * Cell render hint for `DataTable` (presentation only — never affects CSV,
   * which always uses `get`). "status" → StatusBadge, "type" → TypeLabel,
   * "channel" → quiet tag, "money"/"num" → mono tabular figures. Absent →
   * plain text.
   */
  kind?: "status" | "type" | "channel" | "money" | "num" | "text"
  /** Right-align header + cell (figures / counts). */
  align?: "right"
  /**
   * The column takes its CONTENT width and never wraps, so the identity
   * column absorbs whatever is left instead of every column being squeezed
   * alike. For a value the operator matches character by character against
   * their own paperwork: a truncated identifier is a WRONG identifier, not a
   * shorter one. A numeric column is fitted already, by `kind`.
   */
  fit?: boolean
  /**
   * Phone width (spec-responsive.md): a documents table is a comparison table,
   * so it declares which columns survive at 390 px rather than collapsing to
   * cards. A column array in which NO column declares this keeps every column
   * at every width, which is what the grouped dashboards want.
   */
  survivesPhone?: boolean
}

// ─────────────────────────────────────────────────────────────────────────
// Per-dashboard columns — pinned to spec §12 "Dashboards" exactly. Any
// drift here is caught by `dashboards.test.ts` (column-shape assertion).
// ─────────────────────────────────────────────────────────────────────────

export const ALL_SALES_COLUMNS: DashboardColumn[] = [
  { key: "date", label: "Date", get: (r) => (r.issued_at ?? "").slice(0, 10) },
  { key: "number", label: "Number", get: (r) => r.number ?? "", survivesPhone: true },
  { key: "type", label: "Type", get: (r) => r.type, kind: "type" },
  {
    key: "customer",
    label: "Customer",
    get: (r) => r.counterparty_name ?? "",
    survivesPhone: true,
  },
  // The store order this document bills ("#1149"). Free-text search matches it,
  // so without the column a row could match a query with nothing on screen
  // explaining why -- and reconciling a document against an order meant opening
  // it one by one. Blank for manual documents.
  { key: "order", label: "Order", get: (r) => r.shopify_order_number ?? "" },
  { key: "channel", label: "Channel", get: (r) => r.channel ?? "manual", kind: "channel" },
  { key: "status", label: "Status", get: (r) => r.status, kind: "status" },
  {
    key: "total",
    label: "Total",
    get: (r) => formatMoney(r.grand_total_minor, r.currency),
    kind: "money",
    align: "right",
    survivesPhone: true,
  },
]

export const AWAITING_PAYMENT_COLUMNS: DashboardColumn[] = [
  { key: "date", label: "Date", get: (r) => (r.issued_at ?? "").slice(0, 10) },
  { key: "number", label: "Number", get: (r) => r.number ?? "" },
  { key: "customer", label: "Customer", get: (r) => r.counterparty_name ?? "" },
  {
    key: "total",
    label: "Total",
    get: (r) => formatMoney(r.grand_total_minor, r.currency),
    kind: "money",
    align: "right",
  },
  { key: "currency", label: "Currency", get: (r) => r.currency },
  {
    key: "days_overdue",
    label: "Days overdue",
    get: (r) => String(r.days_overdue ?? 0),
    kind: "num",
    align: "right",
  },
  { key: "last_action", label: "Last action", get: (r) => r.last_action ?? "" },
]

export const B2B_COLUMNS: DashboardColumn[] = [
  { key: "customer", label: "Customer", get: (r) => r.counterparty_name ?? "" },
  {
    key: "count",
    label: "Count",
    get: (r) => String(r.group_count ?? 1),
    kind: "num",
    align: "right",
  },
  {
    key: "total",
    label: "Total",
    get: (r) => formatMoney(r.grand_total_minor, r.currency),
    kind: "money",
    align: "right",
  },
  { key: "currency", label: "Currency", get: (r) => r.currency },
  {
    key: "last_document_date",
    label: "Last document date",
    get: (r) => (r.issued_at ?? "").slice(0, 10),
  },
]

export const BY_MARKET_COLUMNS: DashboardColumn[] = [
  { key: "country", label: "Country", get: (r) => r.destination_country ?? "" },
  {
    key: "count",
    label: "Count",
    get: (r) => String(r.group_count ?? 1),
    kind: "num",
    align: "right",
  },
  {
    key: "revenue",
    label: "Revenue",
    get: (r) => formatMoney(r.grand_total_minor, r.currency),
    kind: "money",
    align: "right",
  },
  { key: "currency", label: "Currency", get: (r) => r.currency },
  {
    key: "vat_collected",
    label: "VAT collected",
    get: (r) => formatMoney(r.tax_total_minor, r.currency),
    kind: "money",
    align: "right",
  },
  {
    key: "customs_documents_count",
    label: "Customs documents count",
    get: (r) => String(r.customs_documents_count ?? 0),
    kind: "num",
    align: "right",
  },
]

// ─────────────────────────────────────────────────────────────────────────
// CSV emit. Field-level escape: any value containing `,`, `"`, `\r`, or
// `\n` is wrapped in quotes; embedded quotes are doubled. RFC 4180.
// ─────────────────────────────────────────────────────────────────────────
const csvEscape = csvCell

export function toCsv<R = DocumentRow>(columns: DashboardColumn<R>[], rows: R[]): string {
  const header = columns.map((c) => csvEscape(c.label)).join(",")
  const body = rows.map((r) => columns.map((c) => csvEscape(c.get(r))).join(",")).join("\r\n")
  return rows.length === 0 ? `${header}\r\n` : `${header}\r\n${body}\r\n`
}

// ─────────────────────────────────────────────────────────────────────────
// Money formatter — bigint minor units → human string. Currency-symbol-free
// (currency code is a separate column on most dashboards).
// ─────────────────────────────────────────────────────────────────────────
export function formatMoney(minor: bigint | number | null | undefined, currency: string): string {
  if (minor === null || minor === undefined) return ""
  const n = typeof minor === "bigint" ? Number(minor) : minor
  const abs = Math.abs(n)
  const sign = n < 0 ? "-" : ""
  // The currency's ISO 4217 exponent decides the minor-unit split: zero-decimal
  // currencies (JPY, KRW, ...) have no fractional unit, so their minor amount is
  // their major amount and must NOT be divided by 100.
  const exp = currencyExponent(currency)
  if (exp === 0) {
    const whole = String(Math.round(abs)).replace(/\B(?=(\d{3})+(?!\d))/g, " ")
    return `${sign}${whole} ${currency}`
  }
  const scale = 10 ** exp
  const major = Math.floor(abs / scale)
  const cents = abs % scale
  // Major-unit grouping with non-breaking space thousands separators (matches
  // FR/DE/etc.); decimal dot for cross-locale CSV readability.
  const majorStr = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return `${sign}${majorStr}.${String(cents).padStart(exp, "0")} ${currency}`
}

// ─────────────────────────────────────────────────────────────────────────
// Empty-state copy — one line per dashboard, pinned to spec §12.
// ─────────────────────────────────────────────────────────────────────────
export const EMPTY_STATE: Record<DashboardKey, string> = {
  all_sales: "No documents in this period.",
  awaiting_payment: "All issued documents are paid. ✓",
  b2b_sales: "No documents to group by customer.",
  by_market: "No documents to group by market.",
}

/**
 * The list's empty line, naming the period it looked at: "in this period" with no dates set read
 * as if a period were chosen. No dates and no other filter means there are no documents yet.
 * `t` translates and fills; `date` writes an ISO day in the reader's language.
 */
export function emptyListText(
  f: DashboardFilter,
  t: (english: string, params?: Record<string, string>) => string,
  date: (iso: string) => string,
): string {
  if (f.date_from && f.date_to) {
    return t("No documents from {{from}} to {{to}}.", {
      from: date(f.date_from),
      to: date(f.date_to),
    })
  }
  if (f.date_from) return t("No documents since {{from}}.", { from: date(f.date_from) })
  if (f.date_to) return t("No documents up to {{to}}.", { to: date(f.date_to) })
  const filtered = (["query", "status", "market", "channel", "buyer_type"] as const).some(
    (k) => f[k] !== DEFAULT_FILTER[k],
  )
  return filtered ? t("No documents match these filters.") : t("No documents yet.")
}

export type DashboardKey = "all_sales" | "awaiting_payment" | "b2b_sales" | "by_market"
