// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Dashboard-layer tests. Bundled-apps suites use bun:test (no jsdom), so
// these tests target the data + presentation contracts (column shape, CSV
// emit, filter logic, customs aggregations, empty-state copy). The thin
// SolidJS shells over these contracts are exercised via Playwright in G6.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isOutstanding } from "./AwaitingPayment"
import {
  ALL_SALES_COLUMNS,
  AWAITING_PAYMENT_COLUMNS,
  B2B_COLUMNS,
  BY_MARKET_COLUMNS,
  EMPTY_STATE,
  emptyListText,
  toCsv,
} from "./columns"
import { perCurrencyRollup } from "./groupings"
import { documentsSearchArgs, LIST_PAGE_LIMIT, searchParamsFromFilter } from "./loader"
import {
  applyFilter,
  DEFAULT_FILTER,
  type DocumentRow,
  EU_COUNTRIES,
  filterRowsForTab,
} from "./types"

// ─────────────────────────────────────────────────────────────────────────
// Fixtures.
// ─────────────────────────────────────────────────────────────────────────
const baseRow: DocumentRow = {
  id: "doc-1",
  type: "invoice",
  status: "issued",
  number: "INV-2026-001",
  counterparty_name: "Acme SAS",
  destination_country: "FR",
  channel: "manual",
  currency: "EUR",
  grand_total_minor: 12345n,
  tax_total_minor: 2058n,
  incoterm: "DAP",
  issued_at: "2026-05-10",
}

const rowExportDE: DocumentRow = {
  ...baseRow,
  id: "doc-2",
  number: "INV-2026-002",
  destination_country: "DE",
  grand_total_minor: 50000n,
}

const rowExportUS: DocumentRow = {
  ...baseRow,
  id: "doc-3",
  number: "INV-2026-003",
  destination_country: "US",
  channel: "shopify",
  grand_total_minor: 100000n,
  incoterm: "DDP",
}

describe("dashboard columns (spec §12 pinning)", () => {
  test("All sales: date, number, type, customer, channel, status, total", () => {
    expect(ALL_SALES_COLUMNS.map((c) => c.key)).toEqual([
      "date",
      "number",
      "type",
      "customer",
      "order",
      "channel",
      "status",
      "total",
    ])
  })

  test("Awaiting payment: date, number, customer, total, currency, days_overdue, last_action", () => {
    expect(AWAITING_PAYMENT_COLUMNS.map((c) => c.key)).toEqual([
      "date",
      "number",
      "customer",
      "total",
      "currency",
      "days_overdue",
      "last_action",
    ])
  })

  test("B2B sales: customer, count, total, currency, last_document_date", () => {
    expect(B2B_COLUMNS.map((c) => c.key)).toEqual([
      "customer",
      "count",
      "total",
      "currency",
      "last_document_date",
    ])
  })

  test("By market: country, count, revenue, currency, vat_collected, customs_documents_count", () => {
    expect(BY_MARKET_COLUMNS.map((c) => c.key)).toEqual([
      "country",
      "count",
      "revenue",
      "currency",
      "vat_collected",
      "customs_documents_count",
    ])
  })
})

describe("CSV export (RFC 4180 escape)", () => {
  test("empty rows still emits header line", () => {
    const csv = toCsv(ALL_SALES_COLUMNS, [])
    expect(csv).toBe("Date,Number,Type,Customer,Order,Channel,Status,Total\r\n")
  })

  test("populated rows include data + CRLF", () => {
    const csv = toCsv(ALL_SALES_COLUMNS, [baseRow])
    const lines = csv.split("\r\n")
    expect(lines[0]).toBe("Date,Number,Type,Customer,Order,Channel,Status,Total")
    expect(lines[1]).toContain("INV-2026-001")
    expect(lines[1]).toContain("Acme SAS")
  })

  test("escapes commas in customer name", () => {
    const row: DocumentRow = { ...baseRow, counterparty_name: "Smith, Jones & Co" }
    const csv = toCsv(ALL_SALES_COLUMNS, [row])
    expect(csv).toContain('"Smith, Jones & Co"')
  })

  test("escapes embedded quotes by doubling", () => {
    const row: DocumentRow = { ...baseRow, counterparty_name: 'O"Reilly' }
    const csv = toCsv(ALL_SALES_COLUMNS, [row])
    expect(csv).toContain('"O""Reilly"')
  })

  test("escapes embedded newlines", () => {
    const row: DocumentRow = { ...baseRow, counterparty_name: "Line1\nLine2" }
    const csv = toCsv(ALL_SALES_COLUMNS, [row])
    expect(csv).toContain('"Line1\nLine2"')
  })
})

describe("filter logic (date boundary off-by-one, market, channel, buyer_type)", () => {
  const rows: DocumentRow[] = [baseRow, rowExportDE, rowExportUS]

  test("date_from inclusive on boundary day", () => {
    const out = applyFilter(rows, { ...DEFAULT_FILTER, date_from: "2026-05-10" })
    expect(out.length).toBe(3)
  })

  test("date_to inclusive on boundary day", () => {
    const out = applyFilter(rows, { ...DEFAULT_FILTER, date_to: "2026-05-10" })
    expect(out.length).toBe(3)
  })

  // Prod returns issued_at as a full timestamp string ("2026-07-24 00:00:00+00"),
  // not a bare date. The bounds are bare "YYYY-MM-DD". These pin that the filter
  // compares on the date PORTION so the boundary day is inclusive — the real
  // "date filter returns nothing" bug.
  test("timestamp issued_at: date_to inclusive on the boundary day", () => {
    const ts: DocumentRow = { ...baseRow, id: "ts-1", issued_at: "2026-07-24 00:00:00+00" }
    const out = applyFilter([ts], { ...DEFAULT_FILTER, date_to: "2026-07-24" })
    expect(out.map((r) => r.id)).toEqual(["ts-1"])
  })

  test("timestamp issued_at: single-day range (from=to) keeps the same-day row", () => {
    const ts: DocumentRow = { ...baseRow, id: "ts-2", issued_at: "2026-07-24 12:30:00+00" }
    const out = applyFilter([ts], {
      ...DEFAULT_FILTER,
      date_from: "2026-07-24",
      date_to: "2026-07-24",
    })
    expect(out.map((r) => r.id)).toEqual(["ts-2"])
  })

  test("timestamp issued_at: date_to still excludes a later day", () => {
    const ts: DocumentRow = { ...baseRow, id: "ts-3", issued_at: "2026-07-25 00:00:00+00" }
    const out = applyFilter([ts], { ...DEFAULT_FILTER, date_to: "2026-07-24" })
    expect(out).toEqual([])
  })

  test("date_from excludes earlier rows", () => {
    const out = applyFilter(rows, { ...DEFAULT_FILTER, date_from: "2026-05-11" })
    expect(out.length).toBe(0)
  })

  test("market=eu keeps FR + DE, drops US", () => {
    const out = applyFilter(rows, { ...DEFAULT_FILTER, market: "eu" })
    expect(out.map((r) => r.id).sort()).toEqual(["doc-1", "doc-2"])
  })

  test("market=non_eu keeps US only", () => {
    const out = applyFilter(rows, { ...DEFAULT_FILTER, market: "non_eu" })
    expect(out.map((r) => r.id)).toEqual(["doc-3"])
  })

  test("market=<country-code> drills to one country", () => {
    const out = applyFilter(rows, { ...DEFAULT_FILTER, market: "DE" })
    expect(out.map((r) => r.id)).toEqual(["doc-2"])
  })

  test("channel=shopify drops manual", () => {
    const out = applyFilter(rows, { ...DEFAULT_FILTER, channel: "shopify" })
    expect(out.map((r) => r.id)).toEqual(["doc-3"])
  })

  test("EU_COUNTRIES covers EU-27 (sanity check)", () => {
    expect(EU_COUNTRIES.size).toBe(27)
    expect(EU_COUNTRIES.has("FR")).toBe(true)
    expect(EU_COUNTRIES.has("US")).toBe(false)
  })
})

describe("filterRowsForTab: drafts get their own tab (kept out of the type tabs)", () => {
  const draft: DocumentRow = { ...baseRow, id: "d-1", status: "draft", number: null }
  const issued: DocumentRow = { ...baseRow, id: "i-1", status: "issued" }
  const paid: DocumentRow = { ...baseRow, id: "p-1", status: "paid" }
  const rows = [draft, issued, paid]

  test("non-drafts tab excludes every draft", () => {
    expect(filterRowsForTab(rows, false).map((r) => r.id)).toEqual(["i-1", "p-1"])
  })

  test("Drafts tab keeps ONLY drafts", () => {
    expect(filterRowsForTab(rows, true).map((r) => r.id)).toEqual(["d-1"])
  })
})

describe("searchParamsFromFilter forwards the free-text query (search wiring)", () => {
  test("passes a non-empty query through to the search params", () => {
    const p = searchParamsFromFilter({ ...DEFAULT_FILTER, query: "Acme" })
    expect(p.query).toBe("Acme")
  })

  test("omits the query when empty or whitespace-only", () => {
    expect(searchParamsFromFilter({ ...DEFAULT_FILTER, query: "" }).query).toBeUndefined()
    expect(searchParamsFromFilter({ ...DEFAULT_FILTER, query: "   " }).query).toBeUndefined()
  })
})

describe("documentsSearchArgs: what a list load sends to documents_search", () => {
  // The tool declares each date bound as an optional string. Picking only a start date used to
  // send { from, to: null } and the call was refused as invalid parameters (an unexpected error
  // in the list). Every value sent must fit the declared schema.
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "..", "app.manifest.json"), "utf8"),
  ) as {
    tools: Record<
      string,
      {
        params: {
          properties: Record<string, { properties?: Record<string, { type: string | string[] }> }>
        }
      }
    >
  }
  const rangeProps = manifest.tools.documents_search!.params.properties.date_range!.properties!
  const fitsDeclared = (key: "from" | "to", v: unknown) => {
    const t = rangeProps[key]!.type
    const types = Array.isArray(t) ? t : [t]
    return types.includes(v === null ? "null" : typeof v)
  }

  test("a range with only a start date omits the empty end bound", () => {
    const args = documentsSearchArgs(
      searchParamsFromFilter({ ...DEFAULT_FILTER, date_from: "2026-09-01" }),
    )
    expect(args.date_range).toEqual({ from: "2026-09-01" })
  })

  test("a range with only an end date omits the empty start bound", () => {
    const args = documentsSearchArgs(
      searchParamsFromFilter({ ...DEFAULT_FILTER, date_to: "2026-09-30" }),
    )
    expect(args.date_range).toEqual({ to: "2026-09-30" })
  })

  test("every bound sent fits the manifest's declared type", () => {
    for (const f of [
      { ...DEFAULT_FILTER, date_from: "2026-09-01" },
      { ...DEFAULT_FILTER, date_to: "2026-09-30" },
      { ...DEFAULT_FILTER, date_from: "2026-09-01", date_to: "2026-09-30" },
    ]) {
      const range = documentsSearchArgs(searchParamsFromFilter(f)).date_range as Record<
        string,
        unknown
      >
      for (const [k, v] of Object.entries(range))
        expect(fitsDeclared(k as "from" | "to", v)).toBe(true)
    }
  })

  test("no date picked sends no range at all", () => {
    expect(documentsSearchArgs(searchParamsFromFilter(DEFAULT_FILTER)).date_range).toBeUndefined()
  })

  test("the sort choice reaches the tool and the load asks for a full page", () => {
    const oldest = documentsSearchArgs(
      searchParamsFromFilter({ ...DEFAULT_FILTER, sort: "oldest" }),
    )
    expect(oldest.sort).toBe("oldest")
    expect(oldest.limit).toBe(LIST_PAGE_LIMIT)
    expect(documentsSearchArgs(searchParamsFromFilter(DEFAULT_FILTER)).sort).toBeUndefined()
  })
})

describe("empty-state copy (spec §12 pinning)", () => {
  test("Awaiting payment uses the spec's exact line", () => {
    expect(EMPTY_STATE.awaiting_payment).toBe("All issued documents are paid. ✓")
  })

  test("every dashboard has a named (non-generic) empty state", () => {
    for (const v of Object.values(EMPTY_STATE)) {
      expect(v).not.toBe("No data")
      expect(v.length).toBeGreaterThan(0)
    }
  })
})

describe("isOutstanding — awaiting-payment eligibility", () => {
  test("an issued, unpaid invoice is outstanding", () => {
    expect(
      isOutstanding({ ...baseRow, type: "invoice", status: "issued", payment_status: "unpaid" }),
    ).toBe(true)
  })

  test("a paid invoice is NOT outstanding", () => {
    expect(
      isOutstanding({ ...baseRow, type: "invoice", status: "issued", payment_status: "paid" }),
    ).toBe(false)
  })

  test("a credit note is NEVER outstanding, even though it issues to status='issued' with payment_status='unpaid'", () => {
    // Credit notes are not payable (no due date, no mark_paid), so their payment_status stays at the
    // default 'unpaid' — without the explicit type gate they would incorrectly show up as an
    // outstanding receivable on the Awaiting-payment dashboard.
    expect(
      isOutstanding({
        ...baseRow,
        type: "credit_note",
        status: "issued",
        payment_status: "unpaid",
      }),
    ).toBe(false)
  })
})

describe("module surface", () => {
  test("the unified Documents view + Awaiting-payment + Toolbar export the named Solid Components their mounts import (module surface)", async () => {
    // All-sales / B2B / By-market collapsed into the unified Documents view
    // (../DocumentsList) with a Group-by switch. Awaiting payment stays as the
    // one focused view. There is no separate customs view — export documents
    // are just invoices carrying extra fields, shown inside the document.
    //
    // The shells are mounted by NAME (the app's ui/index.tsx imports
    // `InvoicingDocumentsList` and `AwaitingPayment`; AwaitingPayment imports
    // `Toolbar`); the duplicate default exports were removed as dead code. The
    // contract guarded here: each module exports, under the exact name its
    // mount imports, a typed Solid `Component` that is a callable function.
    const dir = join(import.meta.dir)
    const shells: Array<[file: string, name: string, mountFile: string]> = [
      [
        join(dir, "..", "DocumentsList.tsx"),
        "InvoicingDocumentsList",
        join(dir, "..", "index.tsx"),
      ],
      [join(dir, "AwaitingPayment.tsx"), "AwaitingPayment", join(dir, "..", "index.tsx")],
      [join(dir, "Toolbar.tsx"), "Toolbar", join(dir, "AwaitingPayment.tsx")],
    ]
    for (const [file, name, mountFile] of shells) {
      const src = readFileSync(file, "utf-8")
      expect(src, `${name} is exported as a typed Solid Component`).toMatch(
        new RegExp(`export const ${name}: Component\\b`),
      )
      const mod: Record<string, unknown> = await import(file)
      expect(typeof mod[name], `${name} is a mountable function at runtime`).toBe("function")
      expect(
        readFileSync(mountFile, "utf-8"),
        `${name} is imported by name where it is mounted`,
      ).toMatch(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from`))
    }
  })

  // Regression B1: the Total column and the per-currency footer must honor the
  // currency's ISO 4217 exponent. A 23900 JPY order (goods 20300 + services
  // 3600) once rendered as 239.00 JPY (100x too small); a 2015800 EUR total is
  // a normal 2-decimal amount. Also asserts the footer no longer uses a dash.
  test("Total column renders JPY whole units and EUR two-decimal", () => {
    const totalCol = ALL_SALES_COLUMNS.find((c) => c.key === "total")!
    const jpy: DocumentRow = { ...baseRow, currency: "JPY", grand_total_minor: 23900n }
    const eur: DocumentRow = { ...baseRow, currency: "EUR", grand_total_minor: 2015800n }
    expect(totalCol.get(jpy)).toBe("23 900 JPY")
    expect(totalCol.get(eur)).toBe("20 158.00 EUR")
  })

  test("per-currency footer honors currency exponent and uses no dash", () => {
    const jpyA: DocumentRow = { ...baseRow, currency: "JPY", grand_total_minor: 20300n }
    const jpyB: DocumentRow = { ...baseRow, currency: "JPY", grand_total_minor: 3600n }
    const footer = perCurrencyRollup([jpyA, jpyB], "documents")
    expect(footer).toBe("2 documents: 23\u00a0900 JPY")
    expect(footer).not.toContain("—") // em-dash
    expect(footer).not.toContain(" — ")
  })

  test("per-currency footer groups digits like the rows, and gives a mixed-type list its count only", () => {
    const inv: DocumentRow = {
      ...baseRow,
      type: "invoice",
      currency: "EUR",
      grand_total_minor: 13162280n,
    }
    const invoiceForms = { one: "invoice", other: "invoices" }
    expect(perCurrencyRollup([inv], invoiceForms)).toBe("1 invoice: 131\u00a0622.80 EUR")
    expect(perCurrencyRollup([inv, inv], invoiceForms)).toBe("2 invoices: 263\u00a0245.60 EUR")
    // Invoices, quotes, purchase orders and credit notes summed together is no usable figure.
    const po: DocumentRow = {
      ...baseRow,
      type: "purchase_order",
      currency: "EUR",
      grand_total_minor: 50000n,
    }
    const cn: DocumentRow = {
      ...baseRow,
      type: "credit_note",
      currency: "EUR",
      grand_total_minor: -1000n,
    }
    expect(perCurrencyRollup([inv, po, cn], "documents")).toBe("3 documents")
  })

  test("source files declare their empty-state line + grouping/filter wiring", () => {
    const dir = join(import.meta.dir)
    const documents = readFileSync(join(dir, "..", "DocumentsList.tsx"), "utf-8")
    const awaiting = readFileSync(join(dir, "AwaitingPayment.tsx"), "utf-8")
    // Unified Documents view drives all three grouping presets.
    expect(documents).toContain("ALL_SALES_COLUMNS")
    expect(documents).toContain("groupByCustomer")
    expect(documents).toContain("groupByCountry")
    expect(awaiting).toContain("All issued documents are paid")
  })
})

describe("the documents list's empty line", () => {
  const t = (en: string, p?: Record<string, string>) =>
    en.replace(/\{\{(\w+)\}\}/g, (_, k: string) => p?.[k] ?? "")
  const day = (iso: string) => iso
  test("names the period it looked at, and never says 'this period' with no dates set", () => {
    expect(emptyListText(DEFAULT_FILTER, t, day)).toBe("No documents yet.")
    expect(
      emptyListText({ ...DEFAULT_FILTER, date_from: "2026-10-01", date_to: "2026-10-31" }, t, day),
    ).toBe("No documents from 2026-10-01 to 2026-10-31.")
    expect(emptyListText({ ...DEFAULT_FILTER, date_from: "2026-10-01" }, t, day)).toBe(
      "No documents since 2026-10-01.",
    )
    expect(emptyListText({ ...DEFAULT_FILTER, date_to: "2026-10-31" }, t, day)).toBe(
      "No documents up to 2026-10-31.",
    )
    expect(emptyListText({ ...DEFAULT_FILTER, market: "eu" } as never, t, day)).toBe(
      "No documents match these filters.",
    )
  })
})
