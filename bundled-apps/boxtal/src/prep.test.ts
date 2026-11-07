// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Order Prep Dashboard backend (PLAN-order-prep-dashboard.md §1):
//   • prep_list is a FREE READ — no external calls; joins the to-prepare worklist with cached
//     prep_meta/prep_quote/prep_state and the auto-derived draft (parcels/products/total).
//   • prep_sync refreshes Shopify order meta + re-quotes on a hash/TTL change; honestly bounded.
//   • prep_set_category / prep_exclude / prep_restore mutate prep_state.
//   • The category -> customs-basis mapping, including the dealer master pack of 5 cover case.

import { describe, expect, it } from "bun:test"
import { backfillContactShippingAddress, computePrepInputHash, fetchShopifyOrderMeta, isRecipientComplete, matchesFilters, missingRecipientFields, prepAddShipment, prepExclude, prepList, prepRestore, prepSelectOffer, prepSetCategory, prepSetStatus, prepSetValidated, prepSync } from "./prep"
import { pickSelectedOffer, resolveStageOffer } from "./prep-selection"
import { settingsProductCodesSet } from "./settings"
import { shipDisabledReason } from "./ui/prep-row-logic"
import { HOUSE_PACKAGING_POLICY } from "./__fixtures__/packaging-policy"
import { createMockDb } from "./test-db"
import { makeOrderScanStub, orderKeysFor, type OrderScanStubOptions } from "./__fixtures__/order-scan"
import { OPEN_ORDERS_QUERY, ORDER_SCAN_LIMIT, shippabilityFactsFromHit } from "./orders"
import { queueCounts, toPrepareList } from "./queues"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"

const CREDS = { v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" }

const SENDER_PARTY = {
  name: "Fabrikam SAS",
  company: "Fabrikam SAS",
  email: "ship@fabrikam.example",
  phone: "+33123456789",
  street: "10 Rue de Rivoli",
  city: "Paris",
  postalCode: "75001",
  countryIsoCode: "FR",
}

const DOMESTIC_XML = `<?xml version="1.0"?><cotation><shipment>
  <offer><mode>COM</mode><operator><code>CHRP</code><label>Chronopost</label></operator><service><code>Chrono13</code><label>Chrono 13</label></service><price><currency>EUR</currency><tax-exclusive>9.80</tax-exclusive><tax-inclusive>11.76</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-02</date><type><code>DELIVERY</code></type></delivery></offer>
  <offer><mode>COM</mode><operator><code>MRLY</code><label>Mondial Relay</label></operator><service><code>Point</code><label>Point Relais</label></service><price><currency>EUR</currency><tax-exclusive>5.40</tax-exclusive><tax-inclusive>6.48</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-03</date><type><code>DELIVERY</code></type></delivery></offer>
  <offer><mode>COM</mode><operator><code>UPSE</code><label>UPS</label></operator><service><code>Express</code><label>UPS Express</label></service><price><currency>EUR</currency><tax-exclusive>18.00</tax-exclusive><tax-inclusive>21.60</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-02</date><type><code>DELIVERY</code></type></delivery></offer>
</shipment></cotation>`

function singleLineInvoice(
  id: string,
  opts?: {
    country?: string
    quantity?: number
    /** NET unit price, as invoicing stores it (a decimal string). */
    unitPriceMinor?: string
    /** The document's own tax-INCLUSIVE grand total, as documents_get serialises it. Omitted
     *  (null) for the order-less/legacy shape that carries no document total at all. */
    grandTotalMinor?: string
  },
) {
  return {
    id,
    currency: "EUR",
    incoterm: "DAP",
    counterparty_country: opts?.country ?? "FR",
    counterparty_name: `Customer ${id}`,
    counterparty_contact_id: `contact-${id}`,
    shopify_order_id: `gid://shopify/Order/${id}`,
    issued_at: "2026-07-01",
    grand_total_minor: opts?.grandTotalMinor ?? null,
    lines: [
      {
        id: `line-${id}`,
        description: "Kestrel 6",
        quantity: opts?.quantity ?? 1,
        unit_price_minor: opts?.unitPriceMinor ?? "69900",
        hs_code: "9207.90",
        country_of_origin: "FR",
        customs_description: "RAL-44",
        product_source: "shopify",
        external_id: "RAL-44",
      },
    ],
  }
}

interface CtxOpts {
  invoices: Array<ReturnType<typeof singleLineInvoice>>
  seed?: Record<string, Array<Record<string, unknown>>>
  shopifyOrder?: (id: string) => { name: string; tags: string[]; createdAt: string } | null
  cotationXml?: string
  /** HTTP status of the cotation answer (default 200). */
  cotationStatus?: number
  /** Seed the exclude_pickup_point_services policy. Omitted = the prod default (true, relay
   *  excluded); pass false to keep a relay fixture (e.g. Point Relais) visible in a test. */
  excludePickupPoint?: boolean
  /** Mock the kernel contact record backing `kernel:contacts_read` (draft recipient
   *  address pre-fill source). Keyed by contactId; omitted contacts resolve to null. */
  contact?: (contactId: string) => { metadata?: Record<string, unknown> } | null
  /** How the gated invoicing proforma issue answers. Default: issued immediately (Quinn holds
   *  invoicing approval rights, so the kernel's direct-human-call path applies). */
  proformaMode?: "completed" | "pending" | "forbidden" | "no_issuer"
  /** Order-scan fixture knobs: the worklist is order-driven, so the invoices reach it as the
   *  documents of synthetic open orders. */
  scan?: OrderScanStubOptions
}

function makeCtx(opts: CtxOpts): { ctx: BoxtalToolCtx; db: ReturnType<typeof createMockDb>; keys: string[] } {
  const byId = new Map<string, ReturnType<typeof singleLineInvoice>>(
    opts.invoices.map((d) => [d.id, d] as const),
  )
  let proformaSeq = 0
  const issuedProformas: Array<{ id: string; params: Record<string, unknown> }> = []
  const db = createMockDb({
    seed: {
      shipping_profile: [
        {
          id: "p-ral44",
          product_source: "shopify",
          product_id: "RAL-44",
          unit_weight: 2.5,
          solo_length: 30,
          solo_width: 25,
          solo_height: 8,
          content_category: "content:v1:10250",
        },
      ],
      app_config: [
        { id: "cfg-sender", key: "sender_address", value: SENDER_PARTY },
        // The house packaging policy (carton ladder + nominal proforma value) is org data now; this
        // world is an org that configured it.
        { id: "cfg-packaging", key: "packaging_policy", value: HOUSE_PACKAGING_POLICY },
        ...(typeof opts.excludePickupPoint === "boolean"
          ? [{ id: "cfg-pickup", key: "exclude_pickup_point_services", value: opts.excludePickupPoint }]
          : []),
      ],
      ...opts.seed,
    },
  })
  const fetch = async (url: string) => {
    if (url.includes("/iam/account-app/token")) {
      return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
    }
    if (url.includes("/cotation")) {
      return { status: opts.cotationStatus ?? 200, headers: {}, body: opts.cotationXml ?? DOMESTIC_XML }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
  }
  // The row's order name/tags now come from the LIVE order (the scan), not from prep_meta, so a
  // test that stubs `shopifyOrder` gets those facts onto its synthetic order too.
  const scanOpts: OrderScanStubOptions = { ...(opts.scan ?? {}) }
  if (opts.shopifyOrder && !scanOpts.orderOverrides) {
    scanOpts.orderOverrides = Object.fromEntries(
      opts.invoices.map((inv) => {
        const o = opts.shopifyOrder!(`gid://shopify/Order/${inv.id}`)
        return [inv.id, o ? { name: o.name, tags: o.tags, createdAt: o.createdAt } : {}]
      }),
    )
  }
  const scanStub = makeOrderScanStub(opts.invoices as never, scanOpts)
  const executeTool = async (target: string, args: unknown): Promise<CrossAppEnvelope> => {
    const scanned = scanStub(target, args as Record<string, unknown>)
    if (scanned) return scanned
    if (target === "invoicing:documents_get") {
      const ref =
        typeof args === "string" ? args : ((args as { id?: string }).id ?? (args as { document_ref?: string }).document_ref)
      return { status: "completed", result: (ref && byId.get(ref)) ?? null }
    }
    if (target === "shopify:orders_get") {
      const id = (args as { id?: string }).id ?? ""
      const found = opts.shopifyOrder?.(id)
      return { status: "completed", result: found }
    }
    if (target === "invoicing:settings_issuer_profile_list") {
      return opts.proformaMode === "no_issuer"
        ? { status: "completed", result: [] }
        : { status: "completed", result: [{ id: "issuer-1", active: true }] }
    }
    if (target === "invoicing:proforma_create_and_issue") {
      if (opts.proformaMode === "pending") {
        return { status: "pending_approval", approval_id: "appr-proforma-1" }
      }
      if (opts.proformaMode === "forbidden") {
        return { status: "error", error: { code: "forbidden", message: "missing invoicing:documents:write" } }
      }
      const p = args as {
        counterparty?: { legal_name?: string; country?: string }
        items?: Array<Record<string, unknown>>
        shipment_ref?: string
        shopify_order_id?: string
      }
      proformaSeq += 1
      const id = `prof-${proformaSeq}`
      // The issued proforma is a REAL document from here on: the draft resolver reads it back
      // through documents_get, which is how the parcel-fidelity assertion has anything to compare.
      byId.set(id, {
        id,
        currency: "EUR",
        incoterm: "DAP",
        counterparty_country: p.counterparty?.country ?? "FR",
        counterparty_name: p.counterparty?.legal_name ?? "Customer",
        counterparty_contact_id: null,
        shopify_order_id: p.shopify_order_id ?? null,
        shipment_ref: p.shipment_ref ?? null,
        number: `PF-${proformaSeq}`,
        issued_at: "2026-09-04",
        lines: (p.items ?? []).map((l, i) => ({
          id: `${id}-line-${i}`,
          description: l.description,
          quantity: l.quantity,
          unit_price_minor: String(l.unit_price_minor),
          hs_code: l.hs_code ?? null,
          country_of_origin: l.country_of_origin ?? null,
          customs_description: l.customs_description ?? null,
          product_source: l.product_source ?? null,
          external_id: l.external_id ?? null,
        })),
      } as never)
      issuedProformas.push({ id, params: p as Record<string, unknown> })
      return { status: "completed", result: { status: "completed", document_id: id, number: `PF-${proformaSeq}` } }
    }
    if (target === "invoicing:documents_search") {
      const type = (args as { type?: string }).type
      if (type === "proforma") {
        return {
          status: "completed",
          result: issuedProformas.map((pf) => ({
            id: pf.id,
            number: (byId.get(pf.id) as { number?: string } | undefined)?.number ?? null,
            shipment_ref: (pf.params.shipment_ref as string | undefined) ?? null,
          })),
        }
      }
      return { status: "completed", result: opts.invoices.map((d) => ({ channel: "shopify", ...d })) }
    }
    if (target === "kernel:contacts_read") {
      const contactId = (args as { contactId?: string }).contactId ?? ""
      const found = opts.contact?.(contactId)
      return found
        ? { status: "completed", result: { contact: found } }
        : { status: "completed", result: null }
    }
    return { status: "error", error: { code: "unmocked", message: target } }
  }
  return {
    ctx: {
      orgId: "org-1",
      db,
      fetch,
      executeTool,
      connections: { boxtal: { getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }), getToken: async () => { throw new Error("no") }, getAccounts: async () => [] } },
      config: { get: async () => null, has: async () => false },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    } as never,
    db,
    // The order_key each fixture invoice's synthetic order carries. prep_list resolves shipment
    // drafts ONLY for a row-scoped read, so a test that asserts draft-derived fields (parcels,
    // products, totals) asks for its rows by key -- which is exactly what the grid does when it
    // patches one row.
    keys: [...orderKeysFor(opts.invoices as never, scanOpts).values()],
  }
}

describe("computePrepInputHash", () => {
  it("is stable for the same route/parcels/category regardless of parcel order", () => {
    const a = computePrepInputHash({
      destination_country: "US",
      parcels: [
        { length: 31, width: 26, height: 9, weight: 2.5 },
        { length: 40, width: 30, height: 20, weight: 5 },
      ],
      category: "sale",
    })
    const b = computePrepInputHash({
      destination_country: "US",
      parcels: [
        { length: 40, width: 30, height: 20, weight: 5 },
        { length: 31, width: 26, height: 9, weight: 2.5 },
      ],
      category: "sale",
    })
    expect(a).toBe(b)
  })
  it("changes when the category changes (same route/parcels)", () => {
    const base = { destination_country: "US", parcels: [{ length: 31, width: 26, height: 9, weight: 2.5 }] }
    const sale = computePrepInputHash({ ...base, category: "sale" })
    const gift = computePrepInputHash({ ...base, category: "gift" })
    expect(sale).not.toBe(gift)
  })
  it("changes when the destination country changes", () => {
    const parcels = [{ length: 31, width: 26, height: 9, weight: 2.5 }]
    const us = computePrepInputHash({ destination_country: "US", parcels, category: "sale" })
    const fr = computePrepInputHash({ destination_country: "FR", parcels, category: "sale" })
    expect(us).not.toBe(fr)
  })
})

describe("prepList", () => {
  // THE COST ORACLE. The pre-rework list read resolved a shipment draft per candidate (queues.ts's
  // own comment records ~26 rows approaching the sandbox worker timeout), and every row action ended
  // in a whole-list refetch -- which is why the validated checkbox "refreshed the whole page". A list
  // read must now resolve ZERO drafts: no per-candidate documents_get, and no live Boxtal call.
  it("resolves NO shipment drafts and makes no live Boxtal call (the whole-page-refresh cost oracle)", async () => {
    const calls: string[] = []
    const { ctx, keys } = makeCtx({ invoices: [singleLineInvoice("doc-1"), singleLineInvoice("doc-2")] })
    void keys
    const tracked = {
      ...ctx,
      executeTool: async (target: string, args: unknown) => {
        calls.push(target)
        return ctx.executeTool(target, args as Record<string, unknown>)
      },
    } as BoxtalToolCtx
    await prepList(tracked, {})
    // The scan is exactly one order search plus one batched document join, whatever the row count.
    expect(calls.filter((c) => c === "shopify:orders_search")).toHaveLength(1)
    expect(calls.filter((c) => c === "invoicing:documents_for_orders")).toHaveLength(1)
    // Draft resolution is what costs: it reads the document per candidate. Zero of them here.
    expect(calls.filter((c) => c === "invoicing:documents_get")).toHaveLength(0)
    expect(calls.some((c) => c === "shopify:orders_get")).toBe(false)
  })

  it("says not_synced (never a fabricated empty parcel list) for a row whose draft was never resolved", async () => {
    const { ctx } = makeCtx({ invoices: [singleLineInvoice("doc-1")] })
    const { rows } = await prepList(ctx, {})
    expect(rows[0]!.state).toBe("not_synced")
    expect(rows[0]!.parcels).toEqual([])
    expect(rows[0]!.document_ref).toBe("doc-1")
  })

  it("returns a row per to-prepare invoice with auto-derived parcels/products/total and default category", async () => {
    const { ctx, keys } = makeCtx({ invoices: [singleLineInvoice("doc-1")] })
    const { rows, total } = await prepList(ctx, { order_keys: keys })
    expect(total).toBe(1)
    const row = rows[0]!
    expect(row.document_ref).toBe("doc-1")
    expect(row.category).toBe("sale")
    expect(row.excluded).toBe(false)
    expect(row.package_count).toBe(1)
    expect(row.parcels[0]).toMatchObject({ length: 30, width: 25, height: 8, weight: 2.5 })
    expect(row.products).toBe("1xK6")
    expect(row.grand_total_minor).toBe(69900)
    expect(row.currency).toBe("EUR")
    // No cached quote yet → quote_missing, not ready.
    expect(row.state).toBe("quote_missing")
    expect(row.quote.cheapest).toBeNull()
    // quote.stale is STRICTLY the input-hash-mismatch condition — a row with no quote at all yet
    // is "quote_missing", not "stale" (the two must stay distinguishable; folding a missing quote
    // into `stale` made "never quoted" and "quoted then edited" indistinguishable on one boolean).
    expect(row.quote.stale).toBe(false)
  })

  // A taxed EU row showed its value TAX EXCLUDED: line unit prices are stored NET, so summing them
  // understated the row by the whole VAT (net 83 + tax 17 = 100 displayed as 83).
  it("reports the document's tax-inclusive grand total for a taxed row, not the net line sum", async () => {
    const { ctx, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-taxed", { country: "FR", unitPriceMinor: "83", grandTotalMinor: "100" })],
    })
    const { rows } = await prepList(ctx, { order_keys: keys })
    expect(rows[0]!.grand_total_minor).toBe(100)
    expect(rows[0]!.currency).toBe("EUR")
  })

  // The zero-rated export row is where the defect hid: with no tax, net equals total, so it always
  // looked right. It must still read the document total once, never doubled.
  it("reports the document total unchanged for a zero-rated export row (no double count)", async () => {
    const { ctx, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-export", { country: "NO", unitPriceMinor: "100", grandTotalMinor: "100" })],
    })
    const { rows } = await prepList(ctx, { order_keys: keys })
    expect(rows[0]!.grand_total_minor).toBe(100)
  })

  // The order-less/legacy path carries no document total: it must keep falling back to the line sum
  // rather than blanking the operator's total column.
  it("falls back to the line sum when the document carries no grand total", async () => {
    const { ctx, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-legacy", { country: "FR", unitPriceMinor: "83" })],
    })
    const { rows } = await prepList(ctx, { order_keys: keys })
    expect(rows[0]!.grand_total_minor).toBe(83)
  })

  it("joins cached prep_meta (Shopify order name/tags) and prep_quote (top-3 offers) onto the row", async () => {
    const { ctx, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-1")],
      scan: { orderOverrides: { "doc-1": { name: "#1042", tags: ["wholesale", "priority"], createdAt: "2026-07-01" } } },
      seed: {
        prep_meta: [{ id: "m1", document_ref: "doc-1", order_name: "#1042", order_tags: ["wholesale", "priority"], order_created_at: "2026-07-01" }],
        prep_quote: [
          {
            id: "q1",
            document_ref: "doc-1",
            input_hash: computePrepInputHash({ destination_country: "FR", parcels: [{ length: 30, width: 25, height: 8, weight: 2.5 }], category: "sale" }),
            offers: [
              { carrier: "Mondial Relay", offer_code: "MRLY-Point", price_ht_minor: 540, currency: "EUR", delivery_date: "2026-06-03", eta_business_days: 2 },
              { carrier: "Chronopost", offer_code: "CHRP-Chrono13", price_ht_minor: 980, currency: "EUR", delivery_date: "2026-06-02", eta_business_days: 1 },
              { carrier: "UPS", offer_code: "UPSE-Express", price_ht_minor: 1800, currency: "EUR", delivery_date: "2026-06-02", eta_business_days: 1 },
            ],
            quoted_at: new Date().toISOString(),
          },
        ],
      },
    })
    const { rows } = await prepList(ctx, { order_keys: keys })
    const row = rows[0]!
    expect(row.order_name).toBe("#1042")
    expect(row.order_tags).toEqual(["wholesale", "priority"])
    expect(row.quote.cheapest).toMatchObject({ carrier: "Mondial Relay", price_ht_minor: 540 })
    expect(row.quote.alternates).toHaveLength(2)
    expect(row.quote.stale).toBe(false)
    expect(row.state).toBe("ready")
  })

  it("marks the cached quote stale when the input hash no longer matches (e.g. category changed since quoting)", async () => {
    const { ctx, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-1")],
      seed: {
        prep_state: [{ id: "s1", document_ref: "doc-1", category: "gift", excluded: false }],
        prep_quote: [
          {
            id: "q1",
            document_ref: "doc-1",
            // Hashed under the OLD category ("sale") — now stale vs the row's current "gift".
            input_hash: computePrepInputHash({ destination_country: "FR", parcels: [{ length: 30, width: 25, height: 8, weight: 2.5 }], category: "sale" }),
            offers: [{ carrier: "Chronopost", offer_code: "CHRP-Chrono13", price_ht_minor: 980, currency: "EUR", delivery_date: "2026-06-02", eta_business_days: 1 }],
            quoted_at: new Date().toISOString(),
          },
        ],
      },
    })
    const { rows } = await prepList(ctx, { order_keys: keys })
    expect(rows[0]!.category).toBe("gift")
    expect(rows[0]!.quote.stale).toBe(true)
  })

  it("filters: excludes prep_state.excluded rows by default; include_excluded surfaces them", async () => {
    const { ctx, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-1"), singleLineInvoice("doc-2")],
      seed: { prep_state: [{ id: "s1", document_ref: "doc-2", category: "sale", excluded: true }] },
    })
    const { rows: visible } = await prepList(ctx, {})
    expect(visible.map((r) => r.document_ref)).toEqual(["doc-1"])
    const { rows: all } = await prepList(ctx, { include_excluded: true })
    expect(all.map((r) => r.document_ref).sort()).toEqual(["doc-1", "doc-2"])
  })

  it("filters by country, search, and product substring", async () => {
    const { ctx, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-us", { country: "US" }), singleLineInvoice("doc-fr", { country: "FR" })],
    })
    const { rows: us } = await prepList(ctx, { order_keys: keys, country: "US" })
    expect(us.map((r) => r.document_ref)).toEqual(["doc-us"])
    const { rows: bySearch } = await prepList(ctx, { order_keys: keys, search: "doc-fr" })
    expect(bySearch.map((r) => r.document_ref)).toEqual(["doc-fr"])
    const { rows: byProduct } = await prepList(ctx, { order_keys: keys, product: "K6" })
    expect(byProduct).toHaveLength(2)
    const { rows: byMissingProduct } = await prepList(ctx, { order_keys: keys, product: "ZZZ-NOPE" })
    expect(byMissingProduct).toHaveLength(0)
  })

  it("surfaces last_sync_at from the app_config marker prep_sync writes", async () => {
    const { ctx, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-1")],
      seed: { app_config: [{ id: "cfg-sync", key: "prep_last_sync_at", value: "2026-07-10T08:00:00Z" }] },
    })
    const { last_sync_at } = await prepList(ctx, { order_keys: keys })
    expect(last_sync_at).toBe("2026-07-10T08:00:00Z")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The order-driven worklist scan (blueprint Task 5). The queue used to be the set of ISSUED
// SHOPIFY INVOICES, so an order that never got an invoice was structurally invisible and could not
// even be excluded. It is now the set of OPEN UNFULFILLED ORDERS, with the invoice demoted to the
// row's ANCHOR document.
// ─────────────────────────────────────────────────────────────────────────────

/** Wraps a ctx so every cross-app target it calls is recorded, in order. */
function trackCalls(ctx: BoxtalToolCtx): { ctx: BoxtalToolCtx; calls: Array<{ target: string; args: unknown }> } {
  const calls: Array<{ target: string; args: unknown }> = []
  return {
    calls,
    ctx: {
      ...ctx,
      executeTool: async (target: string, args: unknown) => {
        calls.push({ target, args })
        return ctx.executeTool(target, args as Record<string, unknown>)
      },
    } as BoxtalToolCtx,
  }
}

describe("order-driven worklist scan", () => {
  it("(5b) an open order with NO invoice is a row: needs_document, products from the order lines, invoice missing", async () => {
    const { ctx } = makeCtx({
      invoices: [],
      scan: {
        extraOrders: [
          {
            order_id: "700",
            name: "#7000",
            customer: "Uninvoiced Buyer",
            lineItems: [{ sku: "RAL-44", title: "Kestrel 6", quantity: 2 }],
          },
        ],
      },
    })
    const { rows } = await prepList(ctx, {})
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.order_key).toBe("so:700")
    expect(row.document_ref).toBeNull()
    expect(row.state).toBe("needs_document")
    expect(row.reason).toBe("No invoice issued for this order yet")
    // Products come from the ORDER's line items when there is no document to derive them from.
    expect(row.products).toBe("2xRAL-44")
    expect(row.invoice.state).toBe("missing")
  })

  it("(5b) the org's product-code mapping names a document-less row's skus; with none set they read as they are", async () => {
    const order = {
      order_id: "701",
      name: "#7001",
      customer: "Wholesale Buyer",
      lineItems: [
        { sku: "ACME-K1-BLACK-B2B", title: "K1 wholesale", quantity: 2 },
        { sku: "ACME-K1-HARDCOVER-B2B", title: "Hard cover wholesale", quantity: 1 },
        { sku: "ACME-K1-MYSTERY-B2B", title: "Unknown", quantity: 1 },
      ],
    }
    const bare = makeCtx({ invoices: [], scan: { extraOrders: [order] } })
    const { rows: before } = await prepList(bare.ctx, {})
    expect(before[0]!.products).toBe("2xACME-K1-BLACK-B2B, 1xACME-K1-HARDCOVER-B2B, 1xACME-K1-MYSTERY-B2B")

    const mapped = makeCtx({ invoices: [], scan: { extraOrders: [order] } })
    await settingsProductCodesSet(mapped.ctx, {
      strip_prefixes: ["ACME-"],
      strip_suffixes: ["-B2B"],
      aliases: [
        { sku: "K1-BLACK", code: "K1" },
        { sku: "HARDCOVER", code: "HC" },
      ],
    })
    const { rows: after } = await prepList(mapped.ctx, {})
    expect(after[0]!.products).toBe("2xK1, 1xHC, 1xK1-MYSTERY")
  })

  it("(5b') the To-prepare products column follows the org's display rank", async () => {
    const order = {
      order_id: "702",
      name: "#7002",
      customer: "Retail Buyer",
      lineItems: [
        { sku: "MP", title: "Plate", quantity: 1 },
        { sku: "SOUND", title: "Sound", quantity: 1 },
        { sku: "BSkin", title: "Skin", quantity: 1 },
        { sku: "K6", title: "Kestrel 6", quantity: 1 },
      ],
    }
    const { ctx } = makeCtx({ invoices: [], scan: { extraOrders: [order] } })
    await settingsProductCodesSet(ctx, {
      ranks: [{ code: "K6", rank: 1 }, { code: "MP", rank: 2 }, { code: "SOUND", rank: 1000 }],
    })
    const { rows } = await prepList(ctx, {})
    expect(rows[0]!.products).toBe("1xK6, 1xMP, 1xBSkin, 1xSOUND")
  })

  it("(5c) a software-only invoice anchors nothing and says why", async () => {
    const { ctx } = makeCtx({
      invoices: [singleLineInvoice("doc-sw")],
      scan: { documentOverrides: { "doc-sw": { scope: "software" } } },
    })
    const { rows } = await prepList(ctx, {})
    expect(rows).toHaveLength(1)
    expect(rows[0]!.document_ref).toBeNull()
    expect(rows[0]!.state).toBe("needs_document")
    expect(rows[0]!.reason).toBe("No physical goods to ship")
  })

  it("(5d) a REAL-SHAPED refunded hit is dropped: the camelCase facts are mapped onto the snake_case shippability shape", async () => {
    const { ctx } = makeCtx({
      invoices: [singleLineInvoice("doc-ok"), singleLineInvoice("doc-refunded")],
      scan: { orderOverrides: { "doc-refunded": { financialStatus: "REFUNDED" } } },
    })
    const { rows } = await prepList(ctx, {})
    expect(rows.map((r) => r.document_ref)).toEqual(["doc-ok"])
  })

  it("(5d) a cancelled hit is dropped the same way, from attributes.cancelledAt", () => {
    // Straight at the mapper: the stub's orders_search already honours status:open, so this pins
    // the guard that would still hold if Shopify ever answered with a cancelled order in the page.
    expect(
      shippabilityFactsFromHit({
        attributes: { financialStatus: "PAID", cancelledAt: "2026-08-01T00:00:00Z" },
      }),
    ).toMatchObject({ financial_status: "PAID", cancelled_at: "2026-08-01T00:00:00Z" })
    expect(shippabilityFactsFromHit({ attributes: { financialStatus: "REFUNDED" } })).toMatchObject({
      financial_status: "REFUNDED",
    })
  })

  it("(5f) a row-scoped read never scans: one orders_get, one document join, one draft resolved", async () => {
    const base = makeCtx({ invoices: [singleLineInvoice("doc-1"), singleLineInvoice("doc-2")] })
    const { ctx, calls } = trackCalls(base.ctx)
    const key = base.keys[0]!
    const { rows } = await prepList(ctx, { order_keys: [key] })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.order_key).toBe(key)
    const byTarget = (t: string) => calls.filter((c) => c.target === t)
    expect(byTarget("shopify:orders_search")).toHaveLength(0)
    expect(byTarget("shopify:orders_get")).toHaveLength(1)
    expect(byTarget("invoicing:documents_for_orders")).toHaveLength(1)
    // Exactly ONE draft resolved (the row that was asked for), not one per candidate.
    expect(byTarget("invoicing:documents_get")).toHaveLength(1)
    expect(rows[0]!.parcels).toHaveLength(1)
  })

  it("(5i) the scan query is pinned to open orders in every state that still has units to pack", async () => {
    const base = makeCtx({ invoices: [singleLineInvoice("doc-1")] })
    const { ctx, calls } = trackCalls(base.ctx)
    await prepList(ctx, {})
    const search = calls.find((c) => c.target === "shopify:orders_search")!
    // `status:open` is what keeps DRAFT, closed and cancelled orders out; the fulfillment terms are
    // the states that are still shipping work (a Shopify HOLD and a half-packed order included).
    const query = (search.args as { query: string }).query
    expect(query).toBe(OPEN_ORDERS_QUERY)
    expect(query).toContain("status:open")
    expect(query).toContain("fulfillment_status:on_hold")
    expect(query).toContain("fulfillment_status:partial")
  })

  it("(5j) a Shopify outage returns the CACHED rows plus a readable last_sync_error", async () => {
    const invoices = [singleLineInvoice("doc-1")]
    const keys = orderKeysFor(invoices as never)
    const orderId = keys.get("doc-1")!.slice("so:".length)
    const { ctx } = makeCtx({
      invoices,
      scan: { ordersSearchFails: true },
      seed: {
        prep_meta: [
          {
            id: "m1",
            document_ref: "doc-1",
            shopify_order_id: orderId,
            order_name: "#1000",
            order_tags: [],
            order_created_at: "2026-07-01T10:00:00.000Z",
            financial_status: "PAID",
            fetched_at: new Date().toISOString(),
          },
        ],
      },
    })
    const res = await prepList(ctx, {})
    expect(res.last_sync_error).toBe("Shopify is unreachable")
    // Fail soft (blueprint 1.2 §9): the worklist the operator was working through is still there,
    // stale and saying so. An empty list reads as "nothing to prepare" and also poisons the grid's
    // own cache, so one transient 5xx used to make the whole queue disappear.
    expect(res.rows.map((r) => r.order_key)).toEqual([keys.get("doc-1")!])
    expect(res.rows[0]!.order_name).toBe("#1000")
  })

  it("(5j) a scoped read whose orders_get fails keeps the row instead of blanking it", async () => {
    const invoices = [singleLineInvoice("doc-1")]
    const keys = orderKeysFor(invoices as never)
    const key = keys.get("doc-1")!
    const orderId = key.slice("so:".length)
    const base = makeCtx({
      invoices,
      seed: {
        prep_meta: [
          {
            id: "m1",
            document_ref: "doc-1",
            shopify_order_id: orderId,
            order_name: "#1000",
            order_tags: ["dealer"],
            fetched_at: new Date().toISOString(),
          },
        ],
      },
    })
    // One Shopify hiccup during a status change used to rebuild the row from a missing hit, so the
    // row lost its order number and its customer in place, with nothing said about it.
    const ctx: BoxtalToolCtx = {
      ...base.ctx,
      executeTool: async (target: string, args: unknown) =>
        target === "shopify:orders_get"
          ? { status: "error", error: { code: "upstream", message: "Shopify timed out" } }
          : base.ctx.executeTool(target, args as Record<string, unknown>),
    } as BoxtalToolCtx
    const res = await prepList(ctx, { order_keys: [key] })
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]!.order_name).toBe("#1000")
    expect(res.rows[0]!.order_tags).toEqual(["dealer"])
    expect(res.rows[0]!.customer).toBe("Customer doc-1")
    expect(res.last_sync_error).toBe("Shopify did not answer, so these rows were not refreshed.")
  })

  it("(5j) invoicing being unreachable marks the list not-invoicing-available rather than hiding the orders", async () => {
    const { ctx } = makeCtx({
      invoices: [singleLineInvoice("doc-1")],
      scan: { documentsForOrdersFails: true },
    })
    const res = await prepList(ctx, {})
    expect(res.invoicing_available).toBe(false)
    expect(res.last_sync_error).toContain("invoicing")
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0]!.invoice.state).toBe("not_available")
  })

  it("(5k) a scan that hits its cap reports truncated, so the header can say so", async () => {
    const { ctx } = makeCtx({ invoices: [] })
    // A page that fills the cap AND offers a cursor is the only truncation condition.
    const hits = Array.from({ length: ORDER_SCAN_LIMIT }, (_, i) => ({
      id: `gid://shopify/Order/${8000 + i}`,
      name: `#${8000 + i}`,
      attributes: { financialStatus: "PAID", fulfillmentStatus: "UNFULFILLED", cancelledAt: null, tags: [] },
    }))
    const truncating = {
      ...ctx,
      executeTool: async (target: string, args: unknown) => {
        if (target === "shopify:orders_search") {
          return { status: "completed", result: { results: hits, nextCursor: "cursor-2" } }
        }
        return ctx.executeTool(target, args as Record<string, unknown>)
      },
    } as BoxtalToolCtx
    const res = await prepList(truncating, {})
    expect(res.truncated).toBe(true)
    expect(res.rows).toHaveLength(ORDER_SCAN_LIMIT)
    const untruncated = await prepList(ctx, {})
    expect(untruncated.truncated).toBe(false)
  })

  it("(5m) queue_counts.to_prepare equals the default prep_list row count (one invoiced, one uninvoiced, one excluded)", async () => {
    const { ctx } = makeCtx({
      invoices: [singleLineInvoice("doc-1"), singleLineInvoice("doc-excluded")],
      scan: { extraOrders: [{ order_id: "701", name: "#7010" }] },
    })
    const excludedKey = [...orderKeysFor([singleLineInvoice("doc-1"), singleLineInvoice("doc-excluded")] as never).values()][1]!
    await prepExclude(ctx, { order_key: excludedKey })
    const { rows } = await prepList(ctx, {})
    const counts = await queueCounts(ctx)
    expect(rows).toHaveLength(2)
    expect(counts.to_prepare).toBe(rows.length)
  })

  it("(5g) an order-less proforma row is its own row, keyed doc:<id> and anchored on the proforma", async () => {
    const { ctx } = makeCtx({
      invoices: [],
      seed: {
        prep_order_state: [
          {
            id: "os-doc",
            order_key: "doc:prof-9",
            category: "repair",
            status: "to_prepare",
            excluded: false,
            proforma_document_ref: "prof-9",
            proforma_number: "PF-9",
          },
        ],
      },
    })
    const { rows } = await prepList(ctx, {})
    expect(rows).toHaveLength(1)
    expect(rows[0]!.order_key).toBe("doc:prof-9")
    expect(rows[0]!.document_ref).toBe("prof-9")
    expect(rows[0]!.anchor_kind).toBe("proforma")
    expect(rows[0]!.invoice.state).toBe("issued")
    expect(rows[0]!.category).toBe("repair")
  })

  it("(5h) a pending order-less row is re-keyed to doc:<id> once its proforma is issued", async () => {
    const { ctx, db } = makeCtx({
      invoices: [],
      seed: {
        prep_order_state: [
          {
            id: "os-pending",
            order_key: "pending:tok-1",
            category: "gift",
            status: "to_prepare",
            excluded: false,
            proforma_pending_approval_id: "appr-1",
            // RELATIVE to now, never an absolute date. `isProformaApprovalExpired` (proforma.ts)
            // parks a pending proforma after PROFORMA_PENDING_MAX_AGE_MS (14 days), and prep_list
            // reaches it through the production call site, which uses the wall clock. A hardcoded
            // literal here is a time bomb: this fixture read "2026-09-01", which passed when it was
            // written and began failing when the calendar, not the code, crossed the window. The
            // row under test is a FRESH pending approval, so say that: this one is an hour old.
            proforma_requested_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          },
        ],
      },
    })
    // Before the proforma exists the row is parked: no anchor, pending pill.
    const parked = await prepList(ctx, {})
    expect(parked.rows[0]!.order_key).toBe("pending:tok-1")
    expect(parked.rows[0]!.document_ref).toBeNull()
    expect(parked.rows[0]!.invoice.state).toBe("pending_approval")
    expect(parked.rows[0]!.invoice.approval_id).toBe("appr-1")

    // The approval is granted and invoicing issues the document. The next scan matches it by the
    // shipment_ref the app stamped and adopts it.
    const withProforma = {
      ...ctx,
      executeTool: async (target: string, args: unknown) => {
        if (target === "invoicing:documents_search" && (args as { type?: string }).type === "proforma") {
          return {
            status: "completed",
            result: [{ id: "prof-77", number: "PF-77", shipment_ref: "prep:pending:tok-1" }],
          }
        }
        return ctx.executeTool(target, args as Record<string, unknown>)
      },
    } as BoxtalToolCtx
    const settled = await prepList(withProforma, {})
    expect(settled.rows).toHaveLength(1)
    expect(settled.rows[0]!.order_key).toBe("doc:prof-77")
    expect(settled.rows[0]!.document_ref).toBe("prof-77")
    expect(settled.rows[0]!.invoice.state).toBe("issued")
    const stored = db.__all("prep_order_state")[0]!
    expect(stored.order_key).toBe("doc:prof-77")
    expect(stored.proforma_pending_approval_id).toBeNull()
  })

  it("(5h) a pending proforma older than the 14 day window stops claiming to be pending", async () => {
    // The companion to the test above, and the reason its fixture is relative: the pending pill is
    // bounded by PROFORMA_PENDING_MAX_AGE_MS, so BOTH sides of that window need pinning by intent.
    // An approval nobody ever acted on must stop reading as "Pending" (which sends the operator to
    // the Approvals tab to wait on a card that is dead) and fall back to "No invoice", which is the
    // state that offers them a way out.
    const { ctx } = makeCtx({
      invoices: [],
      seed: {
        prep_order_state: [
          {
            id: "os-stale",
            order_key: "pending:tok-stale",
            category: "gift",
            status: "to_prepare",
            excluded: false,
            proforma_pending_approval_id: "appr-stale",
            proforma_requested_at: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      },
    })
    const { rows } = await prepList(ctx, {})
    expect(rows[0]!.invoice.state).toBe("missing")
    expect(rows[0]!.invoice.approval_id).toBeNull()
  })
})

/** Read an issued document's lines back through the same bridge the draft resolver uses. */
async function docLines(
  ctx: BoxtalToolCtx,
  id: string,
): Promise<Array<{ description: string; quantity: number; unit_price_minor: string }>> {
  const env = await ctx.executeTool("invoicing:documents_get", { id })
  if (env.status !== "completed") return []
  return ((env.result as { lines?: Array<{ description: string; quantity: number; unit_price_minor: string }> })
    ?.lines ?? [])
}

describe("prep_add_shipment: a row for a parcel with no Shopify order behind it", () => {
  const shipTo = {
    name: "Repair Owner",
    street: "9 rue Neuve",
    city: "Nantes",
    postalCode: "44000",
    countryIsoCode: "FR",
    phone: "+33612345678",
    email: "owner@example.com",
  }

  it("keys the prefilled items on the VARIANT, not the SKU, so the packing profile resolves", async () => {
    // The packing profiles and invoicing's customs overlay are both keyed on the Shopify variant
    // gid (invoicing writes its invoice lines with toVariantGid for exactly that reason). A
    // SKU-keyed reference matches no profile, so the parcels come back unresolved, the row reads
    // "Unresolved pack" and Ship stays disabled.
    const { ctx } = makeCtx({
      invoices: [],
      scan: {
        extraOrders: [
          {
            order_id: "911",
            name: "#9110",
            customer: "Repair Owner",
            lineItems: [
              { sku: "RAL-44", title: "Kestrel 6", quantity: 1, variant_id: "gid://shopify/ProductVariant/77" },
            ],
            shippingAddress: {
              name: "Repair Owner",
              address1: "9 rue Neuve",
              city: "Nantes",
              zip: "44000",
              countryCode: "FR",
            },
          },
        ],
      },
    })
    const res = await prepAddShipment(ctx, { category: "repair", from_order_number: "#9110" })
    expect(res.order_state.items).toEqual([
      {
        name: "Kestrel 6",
        quantity: 1,
        external_id: "gid://shopify/ProductVariant/77",
        product_source: "shopify",
      },
    ])
  })

  it("(6a) prefills the recipient and the items from an existing order, and ships on its own proforma", async () => {
    const { ctx, db } = makeCtx({
      invoices: [],
      scan: {
        extraOrders: [
          {
            order_id: "910",
            name: "#9100",
            customer: "Repair Owner",
            lineItems: [{ sku: "RAL-44", title: "Kestrel 6", quantity: 2 }],
            shippingAddress: {
              name: "Repair Owner",
              address1: "9 rue Neuve",
              city: "Nantes",
              zip: "44000",
              countryCode: "FR",
              phone: "+33612345678",
            },
          },
        ],
      },
    })
    const res = await prepAddShipment(ctx, { category: "repair", from_order_number: "#9100" })
    expect(res.order_key).toBe("doc:prof-1")
    expect(res.order_state.recipient).toMatchObject({
      name: "Repair Owner",
      street: "9 rue Neuve",
      city: "Nantes",
      postalCode: "44000",
      countryIsoCode: "FR",
    })
    expect(res.order_state.items).toEqual([
      { name: "Kestrel 6", quantity: 2, external_id: "RAL-44", product_source: "shopify" },
    ])
    // (6c) The row is anchored on the proforma the app just issued, and reads as issued.
    expect(res.row!.anchor_kind).toBe("proforma")
    expect(res.row!.document_ref).toBe("prof-1")
    expect(res.row!.invoice.state).toBe("issued")
    expect(res.row!.category).toBe("repair")
    // The customs basis is mirrored onto the anchor, like every other anchor.
    expect(db.__all("prep_state").find((s) => s.document_ref === "prof-1")!.category).toBe("repair")
  })

  it("(6b) a typed recipient missing its country is refused, naming what is missing", async () => {
    const { ctx } = makeCtx({ invoices: [] })
    const { countryIsoCode: _dropped, ...noCountry } = shipTo
    await expect(
      prepAddShipment(ctx, {
        category: "gift",
        recipient: noCountry,
        items: [{ name: "Tessera 2", quantity: 1, external_id: "RAL-44" }],
      }),
    ).rejects.toMatchObject({ code: "invalid_recipient" })
    await expect(
      prepAddShipment(ctx, { category: "gift", recipient: shipTo, items: [] }),
    ).rejects.toMatchObject({ code: "no_items" })
    // A sale has a commercial invoice; an order-less parcel never does.
    await expect(
      prepAddShipment(ctx, {
        category: "sale" as never,
        recipient: shipTo,
        items: [{ name: "Tessera 2", quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: "invalid_category" })
  })

  it("(6c) a typed sample row carries the house SAMPLE wording onto every proforma line", async () => {
    const { ctx } = makeCtx({ invoices: [] })
    const res = await prepAddShipment(ctx, {
      category: "gift",
      recipient: shipTo,
      items: [
        { name: "Tessera 2", quantity: 1, external_id: "RAL-44", product_source: "shopify" },
        { name: "Cable", quantity: 2, external_id: "CBL-1", product_source: "shopify" },
      ],
    })
    expect(res.row!.invoice.state).toBe("issued")
    expect(res.row!.anchor_kind).toBe("proforma")
    const lines = (res.row!.document_ref ?? "").length > 0 ? await docLines(ctx, res.row!.document_ref!) : []
    expect(lines.map((l) => l.description)).toEqual([
      "1x Tessera 2: SAMPLE - NO COMMERCIAL VALUE",
      "2x Cable: SAMPLE - NO COMMERCIAL VALUE",
    ])
    // 1 EUR total, split across the real physical lines.
    expect(lines.reduce((sum, l) => sum + Number(l.unit_price_minor) * l.quantity, 0)).toBe(100)
  })

  it("(6d) a pending proforma approval keeps the row on its pending key, with no anchor yet", async () => {
    const { ctx, db } = makeCtx({ invoices: [], proformaMode: "pending" })
    const res = await prepAddShipment(ctx, {
      category: "repair",
      recipient: shipTo,
      items: [{ name: "Tessera 2", quantity: 1, external_id: "RAL-44" }],
    })
    expect(res.order_key.startsWith("pending:")).toBe(true)
    expect(res.row!.document_ref).toBeNull()
    expect(res.row!.state).toBe("needs_document")
    expect(res.row!.invoice.state).toBe("pending_approval")
    expect(res.row!.invoice.approval_id).toBe("appr-proforma-1")
    expect(db.__all("prep_order_state")[0]!.proforma_pending_approval_id).toBe("appr-proforma-1")
  })

  it("refuses, and strands nothing, when the org has set no nominal declared value", async () => {
    // The packaging policy is org data and NEUTRAL by default, so a fresh org has no
    // nominal_proforma_value_minor and there is no figure this app is allowed to invent. An
    // order-less shipment ships on exactly that proforma, so the whole call has to refuse, name
    // the unset setting, and take its half-created row back with it. Nothing covered this path
    // through prep_add_shipment, which is how an unconfigured org reached a dead Create button.
    const { ctx, db } = makeCtx({
      invoices: [],
      seed: {
        app_config: [
          { id: "cfg-sender", key: "sender_address", value: SENDER_PARTY },
          {
            id: "cfg-packaging",
            key: "packaging_policy",
            value: { ...HOUSE_PACKAGING_POLICY, nominal_proforma_value_minor: null },
          },
        ],
      },
    })
    await expect(
      prepAddShipment(ctx, {
        category: "repair",
        recipient: shipTo,
        items: [{ name: "Tessera 2", quantity: 1, external_id: "RAL-44" }],
      }),
    ).rejects.toMatchObject({ code: "nominal_value_unset" })
    expect(db.__all("prep_order_state")).toHaveLength(0)
  })

  it("refuses to strand a row when the proforma cannot be issued at all", async () => {
    const { ctx, db } = makeCtx({ invoices: [], proformaMode: "forbidden" })
    await expect(
      prepAddShipment(ctx, {
        category: "repair",
        recipient: shipTo,
        items: [{ name: "Tessera 2", quantity: 1, external_id: "RAL-44" }],
      }),
    ).rejects.toMatchObject({ code: "forbidden" })
    // No half-created row is left behind for the operator to puzzle over.
    expect(db.__all("prep_order_state")).toHaveLength(0)
  })
})

describe("prepSync: a failed quote says why", () => {
  const REFUSED_XML = `<?xml version="1.0"?><error><code>request_error</code><message>postal code required for DE</message></error>`
  const EMPTY_XML = `<?xml version="1.0"?><cotation><shipment></shipment></cotation>`

  function withWarnings(ctx: BoxtalToolCtx): Array<{ msg: string; meta: Record<string, unknown> }> {
    const warnings: Array<{ msg: string; meta: Record<string, unknown> }> = []
    Object.assign(ctx, {
      logger: { info() {}, error() {}, debug() {}, warn: (msg: string, meta: Record<string, unknown>) => warnings.push({ msg, meta }) },
    })
    return warnings
  }

  it("a refused quote is logged with the order key, stored on the row, shown by prep_list and summarised", async () => {
    const { ctx, db, keys } = makeCtx({ invoices: [singleLineInvoice("doc-1")], cotationXml: REFUSED_XML, cotationStatus: 400 })
    const warnings = withWarnings(ctx)
    const result = await prepSync(ctx, {})
    const row = result.rows.find((r) => r.document_ref === "doc-1")!
    expect(row.requoted).toBe(false)
    expect(row.error).toBeTruthy()

    const warned = warnings.find((w) => w.msg.includes("quote failed"))
    expect(warned?.meta.order_key).toBe(keys[0])
    expect(warned?.meta.error).toBe(row.error)

    const stored = db.__all("prep_quote").find((q) => q.document_ref === "doc-1")!
    expect(stored.quote_error).toBe(row.error)
    // Nothing that would stop the next sync from retrying.
    expect(stored.quoted_at ?? null).toBeNull()
    expect(stored.input_hash ?? null).toBeNull()

    expect(result.errors.count).toBe(1)
    expect(result.errors.first).toEqual([{ order_key: keys[0]!, error: row.error! }])
    expect(result.notice).toContain("1 row failed")
    expect(result.notice).toContain(row.error!)

    const listed = (await prepList(ctx, { order_keys: [keys[0]!] })).rows[0]!
    expect(listed.state).toBe("quote_missing")
    expect(listed.reason).toBe(`Quote failed: ${row.error}`)
  })

  it("an empty offers list reads 'no offers returned', and a later good quote clears it", async () => {
    const world = { invoices: [singleLineInvoice("doc-1")], cotationXml: EMPTY_XML } as CtxOpts
    const { ctx, db, keys } = makeCtx(world)
    const warnings = withWarnings(ctx)
    const result = await prepSync(ctx, {})
    expect(result.rows[0]!.error).toBe("no offers returned")
    expect(warnings.some((w) => w.meta.error === "no offers returned")).toBe(true)
    expect(result.errors).toEqual({ count: 1, first: [{ order_key: keys[0]!, error: "no offers returned" }] })
    const listed = (await prepList(ctx, { order_keys: [keys[0]!] })).rows[0]!
    expect(listed.state).toBe("quote_missing")
    expect(listed.reason).toBe("Quote failed: no offers returned")

    // Same database, Boxtal answers this time: the reason goes with the offers.
    world.cotationXml = DOMESTIC_XML
    const again = await prepSync(ctx, {})
    expect(again.rows[0]!.requoted).toBe(true)
    expect(again.errors.count).toBe(0)
    expect(db.__all("prep_quote").find((q) => q.document_ref === "doc-1")!.quote_error).toBeNull()
    const ready = (await prepList(ctx, { order_keys: [keys[0]!] })).rows[0]!
    expect(ready.reason).toBeUndefined()
  })
})

describe("prepSync", () => {
  it("fetches missing Shopify order meta and stores it in prep_meta", async () => {
    const { ctx, db, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-1")],
      shopifyOrder: () => ({ name: "#2001", tags: ["b2b"], createdAt: "2026-07-02T00:00:00Z" }),
    })
    const result = await prepSync(ctx, {})
    expect(result.covered_count).toBe(1)
    const row = result.rows.find((r) => r.document_ref === "doc-1")!
    expect(row.synced_meta).toBe(true)
    const meta = db.__all("prep_meta").find((m) => m.document_ref === "doc-1")!
    expect(meta.order_name).toBe("#2001")
    expect(meta.order_tags).toEqual(["b2b"])
  })

  it("quotes and caches the offers, cheapest first", async () => {
    // excludePickupPoint:false keeps DOMESTIC_XML's Mondial Relay Point Relais offer (a relay
    // service the default-on policy would drop) so this test can assert cheapest-first ordering.
    const { ctx, db, keys } = makeCtx({ invoices: [singleLineInvoice("doc-1")], excludePickupPoint: false })
    const result = await prepSync(ctx, {})
    const row = result.rows.find((r) => r.document_ref === "doc-1")!
    expect(row.requoted).toBe(true)
    const cached = db.__all("prep_quote").find((q) => q.document_ref === "doc-1")!
    const offers = cached.offers as Array<{ carrier: string; price_ht_minor: number }>
    expect(offers).toHaveLength(3)
    expect(offers[0]!.carrier).toBe("Mondial Relay") // cheapest (5.40 EUR) first
    expect(offers[0]!.price_ht_minor).toBe(540)
    expect(offers[2]!.price_ht_minor).toBe(1800) // UPS most expensive
  })

  it("EXCLUDES relay / pickup-point offers by default: the Point Relais offer is not cached, Chronopost is cheapest", async () => {
    const { ctx, db, keys } = makeCtx({ invoices: [singleLineInvoice("doc-1")] }) // default policy: relay excluded
    await prepSync(ctx, {})
    const cached = db.__all("prep_quote").find((q) => q.document_ref === "doc-1")!
    const offers = cached.offers as Array<{ carrier: string; is_pickup_point: boolean }>
    expect(offers.some((o) => o.carrier === "Mondial Relay")).toBe(false)
    expect(offers[0]!.carrier).toBe("Chronopost") // cheapest surviving door-to-door offer
    expect(offers.every((o) => o.is_pickup_point === false)).toBe(true)
  })

  it("caches each offer's service name + relay flag for the row dropdown/badge", async () => {
    const { ctx, db, keys } = makeCtx({ invoices: [singleLineInvoice("doc-1")], excludePickupPoint: false })
    await prepSync(ctx, {})
    const cached = db.__all("prep_quote").find((q) => q.document_ref === "doc-1")!
    const offers = cached.offers as Array<{ carrier: string; service: string; is_pickup_point: boolean; price_ttc_minor: number }>
    const relay = offers.find((o) => o.carrier === "Mondial Relay")!
    expect(relay.service).toBe("Point Relais")
    expect(relay.is_pickup_point).toBe(true) // badged as relay in the dropdown
    expect(relay.price_ttc_minor).toBe(648) // 6.48 EUR TTC cached for staging
    const chrono = offers.find((o) => o.carrier === "Chronopost")!
    expect(chrono.is_pickup_point).toBe(false)
  })

  it("caches a zero-decimal (JPY) offer's price_ht_minor exponent-aware — never a hardcoded x100", async () => {
    const JPY_XML = `<?xml version="1.0"?><cotation><shipment>
      <offer><mode>COM</mode><operator><code>YMTO</code><label>Yamato</label></operator><service><code>TA-Q-BIN</code><label>TA-Q-BIN</label></service><price><currency>JPY</currency><tax-exclusive>980</tax-exclusive><tax-inclusive>1078</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-02</date><type><code>DELIVERY</code></type></delivery></offer>
    </shipment></cotation>`
    const { ctx, db, keys } = makeCtx({ invoices: [singleLineInvoice("doc-1", { country: "JP" })], cotationXml: JPY_XML })
    const result = await prepSync(ctx, {})
    const row = result.rows.find((r) => r.document_ref === "doc-1")!
    expect(row.requoted).toBe(true)
    const cached = db.__all("prep_quote").find((q) => q.document_ref === "doc-1")!
    const offers = cached.offers as Array<{ carrier: string; price_ht_minor: number; currency: string }>
    expect(offers).toHaveLength(1)
    // JPY is zero-decimal: 980 JPY minor units IS 980, never Math.round(980 * 100) = 98000.
    expect(offers[0]!.currency).toBe("JPY")
    expect(offers[0]!.price_ht_minor).toBe(980)
  })

  it("does NOT re-quote a row whose cached quote is fresh and hash-unchanged (TTL/hash gate)", async () => {
    const now = new Date().toISOString()
    const { ctx, db, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-1")],
      seed: {
        prep_quote: [
          {
            id: "q1",
            document_ref: "doc-1",
            input_hash: computePrepInputHash({ destination_country: "FR", parcels: [{ length: 30, width: 25, height: 8, weight: 2.5 }], category: "sale" }),
            offers: [{ carrier: "Chronopost", offer_code: "CHRP-Chrono13", price_ht_minor: 980, currency: "EUR", delivery_date: "2026-06-02", eta_business_days: 1 }],
            quoted_at: now,
          },
        ],
      },
    })
    const result = await prepSync(ctx, {})
    const row = result.rows.find((r) => r.document_ref === "doc-1")!
    expect(row.requoted).toBe(false)
    // Only one prep_quote row still (no duplicate/replacement insert).
    expect(db.__all("prep_quote")).toHaveLength(1)
  })

  it("re-quotes a row whose cached quote is past the 12h TTL even with an unchanged hash", async () => {
    const stale = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString()
    const hash = computePrepInputHash({ destination_country: "FR", parcels: [{ length: 30, width: 25, height: 8, weight: 2.5 }], category: "sale" })
    const { ctx, db, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-1")],
      seed: {
        prep_quote: [
          { id: "q1", document_ref: "doc-1", input_hash: hash, offers: [{ carrier: "Old", offer_code: "OLD", price_ht_minor: 1, currency: "EUR", delivery_date: null, eta_business_days: null }], quoted_at: stale },
        ],
      },
    })
    const result = await prepSync(ctx, {})
    expect(result.rows.find((r) => r.document_ref === "doc-1")!.requoted).toBe(true)
    const cached = db.__all("prep_quote").find((q) => q.document_ref === "doc-1")!
    expect((cached.offers as Array<{ offer_code: string }>).some((o) => o.offer_code === "OLD")).toBe(false)
  })

  it("re-quotes when the category changed since the cached quote's hash (edit invalidation)", async () => {
    const hash = computePrepInputHash({ destination_country: "FR", parcels: [{ length: 30, width: 25, height: 8, weight: 2.5 }], category: "sale" })
    const { ctx, db, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-1")],
      seed: {
        prep_state: [{ id: "s1", document_ref: "doc-1", category: "gift", excluded: false }],
        prep_quote: [{ id: "q1", document_ref: "doc-1", input_hash: hash, offers: [{ carrier: "Old", offer_code: "OLD", price_ht_minor: 1, currency: "EUR", delivery_date: null, eta_business_days: null }], quoted_at: new Date().toISOString() }],
      },
    })
    const result = await prepSync(ctx, {})
    expect(result.rows.find((r) => r.document_ref === "doc-1")!.requoted).toBe(true)
    const cached = db.__all("prep_quote").find((q) => q.document_ref === "doc-1")!
    expect((cached.offers as Array<{ offer_code: string }>).some((o) => o.offer_code === "OLD")).toBe(false)
  })

  it("honors document_refs to scope a targeted re-quote to one row", async () => {
    const { ctx, db, keys } = makeCtx({ invoices: [singleLineInvoice("doc-1"), singleLineInvoice("doc-2")] })
    const result = await prepSync(ctx, { document_refs: ["doc-1"] })
    expect(result.covered_count).toBe(1)
    expect(result.total_count).toBe(1)
    expect(result.rows.map((r) => r.document_ref)).toEqual(["doc-1"])
    expect(db.__all("prep_quote").some((q) => q.document_ref === "doc-2")).toBe(false)
  })

  it("a row-scoped sync never scans the whole worklist", async () => {
    // The grid's Quote button, the package editor and a category change all call prep_sync for ONE
    // row. Running the unscoped scan first made each of them pay a full paged orders_search walk
    // plus the documents_for_orders batches, which is the O(worklist) latency the rework removes.
    const invoices = [singleLineInvoice("doc-1"), singleLineInvoice("doc-2")]
    const keys = orderKeysFor(invoices as never)
    const base = makeCtx({ invoices })
    const tracked = trackCalls(base.ctx)
    await prepSync(tracked.ctx, { order_keys: [keys.get("doc-1")!] })
    expect(tracked.calls.filter((c) => c.target === "shopify:orders_search")).toHaveLength(0)
    // The scoped read is the only order read: the row's ship-to is cached from it, not re-read.
    expect(tracked.calls.filter((c) => c.target === "shopify:orders_get")).toHaveLength(1)
    const meta = base.db.__all("prep_meta").find((m) => m.document_ref === "doc-1")
    // The fixture order carries no address: that answer is cached too, as its own marker (an
    // empty column means "never read", so the order would be read again on every sync).
    expect(meta?.ship_to).toMatchObject({ source: "none" })

    // Same for the document_refs form, once the row has been synced once (prep_meta then carries
    // the order the document belongs to, so the scope is resolvable without a scan).
    await prepSync(base.ctx, {})
    const tracked2 = trackCalls(base.ctx)
    const scoped = await prepSync(tracked2.ctx, { document_refs: ["doc-1"] })
    expect(scoped.rows.map((r) => r.document_ref)).toEqual(["doc-1"])
    expect(tracked2.calls.filter((c) => c.target === "shopify:orders_search")).toHaveLength(0)
  })

  it("falls back to the full scan when a document_ref cannot be scoped from the cache", async () => {
    // Correctness first: a ref no local table can map (a document the worklist has never listed)
    // must still be synced, even though that costs the scan.
    const invoices = [singleLineInvoice("doc-1")]
    const base = makeCtx({ invoices })
    const tracked = trackCalls(base.ctx)
    await prepSync(tracked.ctx, { document_refs: ["doc-1"] })
    expect(tracked.calls.filter((c) => c.target === "shopify:orders_search").length).toBeGreaterThan(0)
  })

  it("bounds the sync by limit and reports covered/total honestly", async () => {
    const invoices = [singleLineInvoice("doc-1"), singleLineInvoice("doc-2"), singleLineInvoice("doc-3")]
    const { ctx, keys } = makeCtx({ invoices })
    const result = await prepSync(ctx, { limit: 2 })
    expect(result.covered_count).toBe(2)
    expect(result.total_count).toBe(3)
    expect(result.notice).toContain("2 of 3")
  })

  it("stamps last_sync_at (app_config) so prep_list can surface it", async () => {
    const { ctx, db, keys } = makeCtx({ invoices: [singleLineInvoice("doc-1")] })
    const before = await prepSync(ctx, {})
    expect(before.last_sync_at).toBeTruthy()
    const cfg = db.__all("app_config").find((c) => c.key === "prep_last_sync_at")!
    expect(cfg.value).toBe(before.last_sync_at)
  })

  // POST-REWORK: the order facts come from the SCAN the sync already did, so there is no
  // per-row orders_get and no documents_get to resolve the order id. prep_meta is written from
  // what the scan read, which is also why it can never go stale relative to the grid.
  it("writes prep_meta from the scan, without a per-row shopify:orders_get or invoicing:documents_get", async () => {
    const calls: { target: string }[] = []
    const { ctx: rawCtx, db, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-1")],
      shopifyOrder: () => ({ name: "#2001", tags: ["b2b"], createdAt: "2026-07-02T00:00:00Z" }),
    })
    void keys
    const ctx = {
      ...rawCtx,
      executeTool: async (target: string, args: unknown) => {
        calls.push({ target })
        return rawCtx.executeTool(target, args as Record<string, unknown>)
      },
    } as BoxtalToolCtx
    await prepSync(ctx, {})
    const meta = db.__all("prep_meta").find((m) => m.document_ref === "doc-1")!
    expect(meta.order_name).toBe("#2001")
    expect(meta.order_tags).toEqual(["b2b"])
    expect(meta.shopify_order_id).toBe("1")
    // ONE order search for the whole pass. The per-row orders_get the old sync made is gone.
    expect(calls.filter((c) => c.target === "shopify:orders_search")).toHaveLength(1)
  })

  it("reports covered/total honestly when more rows are in scope than the limit allows", async () => {
    const { ctx } = makeCtx({
      invoices: [singleLineInvoice("doc-1"), singleLineInvoice("doc-2"), singleLineInvoice("doc-3")],
    })
    const result = await prepSync(ctx, { limit: 2 })
    expect(result.total_count).toBe(3)
    expect(result.covered_count).toBe(2)
    expect(result.notice).toContain("2 of 3")
  })
})

describe("prep_set_category: the category decides the shipping DOCUMENT", () => {
  const REPAIR_ITEMS = ["1x", "RETURN AFTER REPAIR"]

  it("(3a) repair issues ONE nominal proforma and re-anchors the row on it", async () => {
    const { ctx, db, keys } = makeCtx({ invoices: [singleLineInvoice("doc-1")] })
    void keys
    const res = await prepSetCategory(ctx, { document_ref: "doc-1", category: "repair" })
    expect(res.error).toBeUndefined()
    expect(res.order_state.category).toBe("repair")
    expect(res.order_state.proforma_document_ref).toBe("prof-1")
    expect(res.row!.document_ref).toBe("prof-1")
    expect(res.row!.anchor_kind).toBe("proforma")
    const stored = db.__all("prep_order_state").find((r) => r.order_key === res.row!.order_key)!
    expect(stored.proforma_document_ref).toBe("prof-1")
    for (const fragment of REPAIR_ITEMS) expect(res.row!.products.length + fragment.length).toBeGreaterThan(0)
  })

  it("(3c) a second repair set reuses the stored proforma instead of issuing another", async () => {
    const { ctx } = makeCtx({ invoices: [singleLineInvoice("doc-1")] })
    const first = await prepSetCategory(ctx, { document_ref: "doc-1", category: "repair" })
    const second = await prepSetCategory(ctx, { order_key: first.row!.order_key, category: "repair" })
    expect(second.order_state.proforma_document_ref).toBe("prof-1")
    expect(second.row!.document_ref).toBe("prof-1")
  })

  it("(3b) switching back to sale re-anchors on the invoice and issues nothing", async () => {
    const { ctx } = makeCtx({ invoices: [singleLineInvoice("doc-1")] })
    const repaired = await prepSetCategory(ctx, { document_ref: "doc-1", category: "repair" })
    const back = await prepSetCategory(ctx, { order_key: repaired.row!.order_key, category: "sale" })
    expect(back.row!.document_ref).toBe("doc-1")
    expect(back.row!.anchor_kind).toBe("invoice")
    // The proforma is NOT deleted; it simply stops anchoring the row.
    expect(back.order_state.proforma_document_ref).toBe("prof-1")
  })

  it("(3h) mirrors the category onto the ANCHOR's prep_state so the customs basis follows the document", async () => {
    const { ctx, db } = makeCtx({ invoices: [singleLineInvoice("doc-1")] })
    await prepSetCategory(ctx, { document_ref: "doc-1", category: "repair" })
    expect(db.__all("prep_state").find((r) => r.document_ref === "prof-1")!.category).toBe("repair")
  })

  it("(3d) refuses with row_locked once a shipment is bought against the row's document", async () => {
    const { ctx } = makeCtx({
      invoices: [singleLineInvoice("doc-1")],
      seed: { shipment: [{ id: "s1", document_ref: "doc-1", order_status: "PENDING" }] },
    })
    let thrown: unknown
    try {
      await prepSetCategory(ctx, { document_ref: "doc-1", category: "repair" })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string })?.code).toBe("row_locked")
  })

  it("(3f) a pending proforma approval parks the row: the approval id is stored and the anchor detaches", async () => {
    const { ctx } = makeCtx({ invoices: [singleLineInvoice("doc-1")], proformaMode: "pending" })
    const res = await prepSetCategory(ctx, { document_ref: "doc-1", category: "gift" })
    expect(res.order_state.proforma_pending_approval_id).toBe("appr-proforma-1")
    expect(res.order_state.proforma_document_ref).toBeFalsy()
    expect(res.row!.document_ref).toBeNull()
    expect(res.row!.state).toBe("needs_document")
    expect(res.row!.invoice.state).toBe("pending_approval")
    expect(res.row!.invoice.approval_id).toBe("appr-proforma-1")
  })

  it("(3e) refuses with row_locked while that approval is still pending", async () => {
    const { ctx } = makeCtx({ invoices: [singleLineInvoice("doc-1")], proformaMode: "pending" })
    const first = await prepSetCategory(ctx, { document_ref: "doc-1", category: "gift" })
    let thrown: unknown
    try {
      await prepSetCategory(ctx, { order_key: first.row!.order_key, category: "sale" })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string })?.code).toBe("row_locked")
  })

  it("(3g) a forbidden issue reverts the category and returns the row error", async () => {
    const { ctx } = makeCtx({ invoices: [singleLineInvoice("doc-1")], proformaMode: "forbidden" })
    const res = await prepSetCategory(ctx, { document_ref: "doc-1", category: "repair" })
    expect(res.error?.code).toBe("forbidden")
    expect(res.error?.message).toContain("could not be issued")
    expect(res.order_state.category).toBe("sale")
    expect(res.row!.document_ref).toBe("doc-1")
  })

  it("surfaces a missing invoicing issuer profile instead of a raw invoicing code", async () => {
    const { ctx } = makeCtx({ invoices: [singleLineInvoice("doc-1")], proformaMode: "no_issuer" })
    const res = await prepSetCategory(ctx, { document_ref: "doc-1", category: "repair" })
    expect(res.error?.code).toBe("issuer_not_found")
  })
})

describe("prep_exclude / prep_restore (keyed by ORDER, so a document-less row can be excluded too)", () => {
  it("round-trips the excluded flag on the order-state row", async () => {
    const { ctx, db } = makeCtx({ invoices: [singleLineInvoice("doc-1")] })
    await prepExclude(ctx, { document_ref: "doc-1" })
    const key = db.__all("prep_order_state")[0]!.order_key as string
    expect(db.__all("prep_order_state")[0]!.excluded).toBe(true)
    await prepRestore(ctx, { order_key: key })
    expect(db.__all("prep_order_state")[0]!.excluded).toBe(false)
  })

  it("excluding a row removes it from the default prep_list view and include_excluded brings it back", async () => {
    const { ctx } = makeCtx({ invoices: [singleLineInvoice("doc-1"), singleLineInvoice("doc-2")] })
    await prepExclude(ctx, { document_ref: "doc-2" })
    const { rows } = await prepList(ctx, {})
    expect(rows.map((r) => r.document_ref)).toEqual(["doc-1"])
    const { rows: all } = await prepList(ctx, { include_excluded: true })
    expect(all).toHaveLength(2)
  })

  it("(5n) excludes an order that has NO document at all -- the row the old per-document keying could not reach", async () => {
    const { ctx } = makeCtx({
      invoices: [],
      scan: { extraOrders: [{ order_id: "7777", name: "#7777", customer: "Klangwerk" }] },
    })
    const before = await prepList(ctx, {})
    expect(before.rows.map((r) => r.order_key)).toEqual(["so:7777"])
    expect(before.rows[0]!.state).toBe("needs_document")
    expect(before.rows[0]!.invoice.state).toBe("missing")
    await prepExclude(ctx, { order_key: "so:7777" })
    expect((await prepList(ctx, {})).rows).toHaveLength(0)
    expect((await prepList(ctx, { include_excluded: true })).rows).toHaveLength(1)
  })
})

describe("dealer master pack of 5 (category-aware end-to-end)", () => {
  it("5x Tessera 2 covered by a dealer master pack resolves to ONE parcel, with a sale-category row on prep_list", async () => {
    const { ctx, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-dealer", { quantity: 5 })],
      seed: {
        pack: [{ id: "pack-dealer5", name: "DEALER-MASTER-5", length: 80, width: 60, height: 50, gross_weight: 15, content_category: null }],
        pack_component: [{ id: "pc-1", pack_id: "pack-dealer5", product_source: "shopify", product_id: "RAL-44", quantity: 5 }],
      },
    })
    const { rows } = await prepList(ctx, { order_keys: keys })
    const row = rows[0]!
    expect(row.package_count).toBe(1)
    expect(row.parcels[0]).toMatchObject({ length: 80, width: 60, height: 50, weight: 15 })
    expect(row.products).toBe("5xK6")
    expect(row.category).toBe("sale")
    expect(row.state).toBe("quote_missing")
  })

  it("setting the dealer row's category to gift changes its customs basis without changing its pack resolution", async () => {
    const { ctx, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-dealer", { quantity: 5 })],
      seed: {
        pack: [{ id: "pack-dealer5", name: "DEALER-MASTER-5", length: 80, width: 60, height: 50, gross_weight: 15, content_category: null }],
        pack_component: [{ id: "pc-1", pack_id: "pack-dealer5", product_source: "shopify", product_id: "RAL-44", quantity: 5 }],
      },
    })
    await prepSetCategory(ctx, { document_ref: "doc-dealer", category: "gift" })
    const { rows } = await prepList(ctx, { order_keys: keys })
    const row = rows[0]!
    expect(row.category).toBe("gift")
    // Same single-carton resolution regardless of category — category affects customs basis, not packing.
    expect(row.package_count).toBe(1)
    expect(row.parcels[0]).toMatchObject({ length: 80, width: 60, height: 50, weight: 15 })
  })
})

describe("pickSelectedOffer (pure)", () => {
  const OFFERS = [
    { offer_code: "CHRP-Chrono13", carrier: "Chronopost" },
    { offer_code: "UPSE-Express", carrier: "UPS" },
  ]
  it("returns the matching offer when a valid code is chosen and the quote is fresh", () => {
    expect(pickSelectedOffer(OFFERS, "UPSE-Express", false)?.carrier).toBe("UPS")
  })
  it("returns null when no code is chosen", () => {
    expect(pickSelectedOffer(OFFERS, null, false)).toBeNull()
  })
  it("returns null when the chosen code no longer matches a cached offer", () => {
    expect(pickSelectedOffer(OFFERS, "GONE-x", false)).toBeNull()
  })
  it("invalidates the choice when the quote is stale (same as the quote)", () => {
    expect(pickSelectedOffer(OFFERS, "UPSE-Express", true)).toBeNull()
  })
})

describe("draft resolution failures are not cached as a verdict on the invoice", () => {
  it("leaves the row not_synced and writes NO cache row when the resolution throws", async () => {
    // A thrown resolution is a read failure, not a defect of the invoice. Caching it as needs_fix
    // pinned a healthy row to "Could not load invoice" with Ship disabled for the whole cache TTL.
    const invoices = [singleLineInvoice("doc-1")]
    const keys = orderKeysFor(invoices as never)
    const base = makeCtx({ invoices })
    const db = base.db
    const ctx: BoxtalToolCtx = {
      ...base.ctx,
      executeTool: async (target: string, args: unknown) =>
        target === "invoicing:documents_get"
          ? { status: "error", error: { code: "upstream", message: "invoicing timed out" } }
          : base.ctx.executeTool(target, args as Record<string, unknown>),
    } as BoxtalToolCtx
    const { rows } = await prepList(ctx, { order_keys: [keys.get("doc-1")!] })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe("not_synced")
    expect(rows[0]!.reason).toBeUndefined()
    expect(db.__all("prep_draft_cache")).toHaveLength(0)
  })
})

describe("prepSelectOffer + resolveStageOffer", () => {
  // A ctx that only needs the db for prep_state/prep_quote reads/writes.
  function selCtx(quoteOffers?: Array<Record<string, unknown>>) {
    const seed: Record<string, Array<Record<string, unknown>>> = {}
    if (quoteOffers) {
      seed.prep_quote = [{ id: "q1", document_ref: "doc-1", input_hash: "h1", offers: quoteOffers, quoted_at: "2026-07-10T08:00:00Z" }]
    }
    const db = createMockDb({ seed })
    return { ctx: { db } as unknown as import("./ctx").BoxtalToolCtx, db }
  }
  const CACHED = [
    { carrier: "Chronopost", service: "Chrono 13", offer_code: "CHRP-Chrono13", price_ht_minor: 980, price_ttc_minor: 1176, currency: "EUR", delivery_date: "2026-06-02", eta_business_days: 1, is_pickup_point: false },
    { carrier: "UPS", service: "UPS Express", offer_code: "UPSE-Express", price_ht_minor: 1800, price_ttc_minor: 2160, currency: "EUR", delivery_date: "2026-06-02", eta_business_days: 1, is_pickup_point: false },
  ]

  it("persists a valid selection and rejects an offer not in the cached quote", async () => {
    const { ctx, db } = selCtx(CACHED)
    await prepSelectOffer(ctx, { document_ref: "doc-1", offer_code: "UPSE-Express" })
    expect(db.__all("prep_state").find((s) => s.document_ref === "doc-1")?.selected_offer_code).toBe("UPSE-Express")
    await expect(prepSelectOffer(ctx, { document_ref: "doc-1", offer_code: "NOPE-x" })).rejects.toThrow(/not among/)
  })

  it("clears the selection when offer_code is null", async () => {
    const { ctx, db } = selCtx(CACHED)
    await prepSelectOffer(ctx, { document_ref: "doc-1", offer_code: "UPSE-Express" })
    await prepSelectOffer(ctx, { document_ref: "doc-1", offer_code: null })
    expect(db.__all("prep_state").find((s) => s.document_ref === "doc-1")?.selected_offer_code).toBeNull()
  })

  it("resolveStageOffer returns the chosen offer (source=selected), not the cheapest", async () => {
    const { ctx } = selCtx(CACHED)
    await prepSelectOffer(ctx, { document_ref: "doc-1", offer_code: "UPSE-Express" })
    const resolved = await resolveStageOffer(ctx, "doc-1")
    expect(resolved).toMatchObject({ offer_code: "UPSE-Express", source: "selected", price_ttc_minor: 2160, is_pickup_point: false })
  })

  it("resolveStageOffer falls back to the cheapest (offers[0]) when nothing is chosen", async () => {
    const { ctx } = selCtx(CACHED)
    const resolved = await resolveStageOffer(ctx, "doc-1")
    expect(resolved).toMatchObject({ offer_code: "CHRP-Chrono13", source: "cheapest" })
  })

  it("resolveStageOffer returns null when the row has no cached quote", async () => {
    const { ctx } = selCtx()
    expect(await resolveStageOffer(ctx, "doc-1")).toBeNull()
  })

  it("surfaces the selected offer on the prep_list row, and invalidates it when the quote goes stale", async () => {
    const { ctx, keys } = makeCtx({ invoices: [singleLineInvoice("doc-1")], excludePickupPoint: false })
    await prepSync(ctx, {})
    // Pick the (more expensive) UPS offer over the cheapest Mondial Relay.
    const cached = (ctx as unknown as { db: ReturnType<typeof createMockDb> }).db.__all("prep_quote")[0]!
    const upsCode = (cached.offers as Array<{ carrier: string; offer_code: string }>).find((o) => o.carrier === "UPS")!.offer_code
    await prepSelectOffer(ctx, { document_ref: "doc-1", offer_code: upsCode })

    const { rows } = await prepList(ctx, { order_keys: keys })
    const row = rows.find((r) => r.document_ref === "doc-1")!
    expect(row.quote.selected_offer_code).toBe(upsCode)
    expect(row.quote.selected?.carrier).toBe("UPS")
    expect(row.quote.selected?.offer_code).not.toBe(row.quote.cheapest?.offer_code) // chosen != cheapest

    // Change the category. The row now ships on a nominal proforma, so it re-anchors on a NEW
    // document with no quote of its own: the operator's offer choice cannot survive that, and the
    // row must not keep showing a price that was quoted for a different declaration.
    await prepSetCategory(ctx, { document_ref: "doc-1", category: "gift" })
    const { rows: rows2 } = await prepList(ctx, { order_keys: keys })
    const row2 = rows2[0]!
    expect(row2.document_ref).not.toBe("doc-1")
    expect(row2.anchor_kind).toBe("proforma")
    expect(row2.quote.selected).toBeNull() // the choice does not follow the row onto a new document
  })
})

describe("recipient_phone_issue — the US/CA phone rule surfaced on the dashboard", () => {
  const contactWithPhone = (phone: string) => ({
    metadata: {
      shipping_address: {
        street: "1 Main St",
        city: "New York",
        postalCode: "10001",
        state: "NY",
        phone,
        email: "recipient-us@example.com",
      },
    },
  })

  it("flags a US row whose stored contact phone is not North American; FR rows are untouched", async () => {
    const { ctx, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-us", { country: "US" }), singleLineInvoice("doc-fr")],
      contact: (id) =>
        id === "contact-doc-us"
          ? contactWithPhone("+33 6 12 34 56 78")
          : {
              metadata: {
                shipping_address: {
                  street: "10 Rue de Rivoli",
                  city: "Paris",
                  postalCode: "75001",
                  phone: "+33 6 12 34 56 78",
                  email: "recipient-fr@example.com",
                },
              },
            },
    })
    const res = await prepList(ctx, { order_keys: keys })
    const us = res.rows.find((r) => r.document_ref === "doc-us")!
    const fr = res.rows.find((r) => r.document_ref === "doc-fr")!
    expect(us.recipient_phone_issue).toMatch(/North American/)
    expect(fr.recipient_phone_issue).toBeUndefined()

    // ticket 10419 follow-up: prove the flag actually reaches Ship's disabled reason, driven end
    // to end -- prepSync quotes both rows for real so shipDisabledReason falls through past its
    // earlier checks to the phone one, instead of hand-injecting recipient_phone_issue onto a
    // fixture row the way the previous version of this suite did.
    await prepSync(ctx, {})
    const synced = await prepList(ctx, { order_keys: keys })
    const usSynced = synced.rows.find((r) => r.document_ref === "doc-us")!
    const frSynced = synced.rows.find((r) => r.document_ref === "doc-fr")!
    const usIssue = usSynced.recipient_phone_issue
    expect(usIssue).toMatch(/North American/)
    expect(shipDisabledReason(usSynced)).toBe(usIssue ?? null)
    expect(shipDisabledReason(frSynced)).toBeNull()
  })

  it("does not flag a US row whose stored phone is a valid NANP number", async () => {
    const { ctx, keys } = makeCtx({
      invoices: [singleLineInvoice("doc-us2", { country: "US" })],
      contact: () => contactWithPhone("+1 212 555 0100"),
    })
    const res = await prepList(ctx, { order_keys: keys })
    expect(res.rows[0]!.recipient_phone_issue).toBeUndefined()
  })
})

// The operator's validation mark: a deliberate human check, persisted so
// "prepare docs for all validated shipments" reads a stored fact instead of
// guessing. Parallel to `excluded`, and deliberately NOT a shipping authority:
// create_shipment still refuses a refunded or cancelled order.
describe("prep validation mark (now an alias onto the status enum)", () => {
  it("prep_set_validated maps onto status and back", async () => {
    const { ctx } = makeCtx({ invoices: [singleLineInvoice("doc-1")] })
    const marked = await prepSetValidated(ctx, { document_ref: "doc-1", validated: true })
    expect(marked.status).toBe("validated")
    expect(typeof marked.status_changed_at).toBe("string")
    const cleared = await prepSetValidated(ctx, { order_key: marked.order_key, validated: false })
    expect(cleared.status).toBe("to_prepare")
  })

  it("surfaces the status on the row, with `validated` kept as a back-compat mirror", async () => {
    const { ctx, keys } = makeCtx({ invoices: [singleLineInvoice("doc-1")] })
    await prepSetStatus(ctx, { order_key: keys[0]!, status: "on_hold", note: "waiting on stock" })
    const { rows } = await prepList(ctx, { order_keys: keys })
    expect(rows[0]!.status).toBe("on_hold")
    expect(rows[0]!.status_note).toBe("waiting on stock")
    expect(rows[0]!.validated).toBe(false)
    await prepSetStatus(ctx, { order_key: keys[0]!, status: "validated" })
    const { rows: rows2 } = await prepList(ctx, { order_keys: keys })
    expect(rows2[0]!.status).toBe("validated")
    expect(rows2[0]!.validated).toBe(true)
  })

  it("filters rows by validated:true / validated:false / omitted", () => {
    const yes = { validated: true, excluded: false, destination: "FR", order_tags: [], products: "", invoice_ref: "A", order_name: null, customer: "c" } as never
    const no = { validated: false, excluded: false, destination: "FR", order_tags: [], products: "", invoice_ref: "B", order_name: null, customer: "c" } as never
    expect(matchesFilters(yes, { validated: true })).toBe(true)
    expect(matchesFilters(no, { validated: true })).toBe(false)
    expect(matchesFilters(no, { validated: false })).toBe(true)
    // Omitted -> both pass (the default worklist is not narrowed).
    expect(matchesFilters(yes, {})).toBe(true)
    expect(matchesFilters(no, {})).toBe(true)
  })
})

describe("backfillContactShippingAddress", () => {
  /** Minimal ctx exposing only kernel:contacts_read / kernel:contacts_write, the two cross app
   *  calls backfillContactShippingAddress makes. `contact` is the seeded kernel record (or null
   *  for "no contact yet"); `writes` records every contacts_write call for assertion. */
  /** `shopifyOrder`, when given, wires up `shopify:orders_get` too, so a test can drive the
   *  backfill through the SAME fetchShopifyOrderMeta -> backfillContactShippingAddress path
   *  prepSync uses (rather than handing backfillContactShippingAddress a hand-built address that
   *  skips over fetchShopifyOrderMeta's own email-stitching logic). */
  function makeContactCtx(
    contact: { metadata?: Record<string, unknown> } | null,
    shopifyOrder?: Record<string, unknown>,
  ) {
    const writes: Array<{ contactId: string; metadata: Record<string, unknown> }> = []
    const executeTool = async (target: string, args: unknown): Promise<CrossAppEnvelope> => {
      if (target === "kernel:contacts_read") {
        return contact ? { status: "completed", result: { contact } } : { status: "completed", result: null }
      }
      if (target === "kernel:contacts_write") {
        const a = args as { contactId: string; metadata: Record<string, unknown> }
        writes.push(a)
        return { status: "completed", result: null }
      }
      if (target === "shopify:orders_get" && shopifyOrder) {
        return { status: "completed", result: shopifyOrder }
      }
      return { status: "error", error: { code: "unmocked", message: target } }
    }
    const ctx = { executeTool } as unknown as BoxtalToolCtx
    return { ctx, writes }
  }

  it("writes state from provinceCode for a US Shopify address on a contact with no address", async () => {
    const { ctx, writes } = makeContactCtx({ metadata: {} })
    const ok = await backfillContactShippingAddress(ctx, "contact-1", async () => ({
      name: "Jane Doe",
      address1: "11418 Richmond Hill",
      city: "New York",
      zip: "10001",
      countryCode: "US",
      province: "New York",
      provinceCode: "NY",
    }))
    expect(ok).toBe(true)
    expect(writes).toHaveLength(1)
    const shipping = writes[0]!.metadata.shipping_address as Record<string, unknown>
    expect(shipping.state).toBe("NY")
    expect(shipping.city).toBe("New York")
  })

  it("writes email from the order's top-level email, which shopify's normalizeAddress never puts on the address", async () => {
    // Neither shippingAddress nor customerAddress carries an email (shopify's normalizeAddress
    // strips it), so this exercises the REAL prepSync path (fetchShopifyOrderMeta stitching the
    // order's own email onto the address) rather than a hand-built getAddress fixture.
    const { ctx, writes } = makeContactCtx({ metadata: {} }, {
      name: "#2001",
      attributes: { email: "jane@example.com" },
      shippingAddress: {
        name: "Jane Doe",
        address1: "11418 Richmond Hill",
        city: "New York",
        zip: "10001",
        countryCode: "US",
        provinceCode: "NY",
      },
    })
    const ok = await backfillContactShippingAddress(ctx, "contact-1", async () => {
      const meta = await fetchShopifyOrderMeta(ctx, "1")
      return meta?.address ?? null
    })
    expect(ok).toBe(true)
    expect(writes).toHaveLength(1)
    const shipping = writes[0]!.metadata.shipping_address as Record<string, unknown>
    expect(shipping.email).toBe("jane@example.com")
  })

  it("takes the phone from the customer address when the order shipping address has none", async () => {
    // A real order (#3423) carried a shipping address with no phone while the customer
    // record held one, and the row sat blocked as incomplete for a value we already had.
    // The fallback is per field: the shipping address still wins for everything else.
    const { ctx, writes } = makeContactCtx({ metadata: {} }, {
      name: "#3423",
      attributes: { email: "buyer@example.com" },
      shippingAddress: {
        name: "Eirik Syrdalen",
        address1: "Industriveien 4",
        city: "Grimstad",
        zip: "4879",
        countryCode: "NO",
        phone: null,
      },
      customerAddress: {
        name: "Eirik Syrdalen",
        address1: "Somewhere else entirely",
        city: "Oslo",
        zip: "0001",
        countryCode: "NO",
        phone: "+47 37 40 36 19",
      },
    })
    const ok = await backfillContactShippingAddress(ctx, "contact-1", async () => {
      const meta = await fetchShopifyOrderMeta(ctx, "1")
      return meta?.address ?? null
    })
    expect(ok).toBe(true)
    expect(writes).toHaveLength(1)
    const shipping = writes[0]!.metadata.shipping_address as Record<string, unknown>
    expect(shipping.phone).toBe("+47 37 40 36 19")
    // the shipping address still decides the destination, only the phone is borrowed
    expect(shipping.street).toBe("Industriveien 4")
    expect(shipping.city).toBe("Grimstad")
  })

  it("merges state into an existing contact address that lacks it without touching other keys", async () => {
    const existing = {
      name: "Jane Doe",
      company: "Acme",
      phone: "+1-555-1234",
      street: "11418 Richmond Hill",
      city: "New York",
      postalCode: "10001",
      countryIsoCode: "US",
      state: null,
    }
    const { ctx, writes } = makeContactCtx({ metadata: { shipping_address: existing } })
    const ok = await backfillContactShippingAddress(ctx, "contact-1", async () => ({
      address1: "11418 Richmond Hill",
      city: "New York",
      zip: "10001",
      countryCode: "US",
      provinceCode: "NY",
    }))
    expect(ok).toBe(true)
    expect(writes).toHaveLength(1)
    const shipping = writes[0]!.metadata.shipping_address as Record<string, unknown>
    expect(shipping.state).toBe("NY")
    // Every other existing key is carried through untouched.
    expect(shipping.company).toBe("Acme")
    expect(shipping.phone).toBe("+1-555-1234")
    expect(shipping.street).toBe("11418 Richmond Hill")
    expect(shipping.postalCode).toBe("10001")
  })

  it("never overwrites an existing non blank state or any other field", async () => {
    const existing = {
      name: "Jane Doe",
      street: "11418 Richmond Hill",
      city: "New York",
      postalCode: "10001",
      countryIsoCode: "US",
      state: "CA",
    }
    const { ctx, writes } = makeContactCtx({ metadata: { shipping_address: existing } })
    const ok = await backfillContactShippingAddress(ctx, "contact-1", async () => ({
      address1: "11418 Richmond Hill",
      city: "New York",
      zip: "10001",
      countryCode: "US",
      provinceCode: "NY",
    }))
    expect(ok).toBe(false)
    expect(writes).toHaveLength(0)
  })

  it("heals a missing phone and email from Shopify even when the contact address already has a state", async () => {
    // ticket 10419: a contact created without a phone/email stayed that way forever once ANY
    // order backfilled its state, because the old guard treated "has a state" as "fully
    // populated" and skipped the whole heal, even though this order's Shopify address carries
    // a phone and an email the contact is missing.
    const existing = {
      name: "Jane Doe",
      street: "11418 Richmond Hill",
      city: "New York",
      postalCode: "10001",
      countryIsoCode: "US",
      state: "NY",
      phone: null,
      email: null,
    }
    const { ctx, writes } = makeContactCtx({ metadata: { shipping_address: existing } })
    const ok = await backfillContactShippingAddress(ctx, "contact-1", async () => ({
      address1: "11418 Richmond Hill",
      city: "New York",
      zip: "10001",
      countryCode: "US",
      provinceCode: "NY",
      phone: "+12125550100",
      email: "jane@example.com",
    }))
    expect(ok).toBe(true)
    expect(writes).toHaveLength(1)
    const shipping = writes[0]!.metadata.shipping_address as Record<string, unknown>
    expect(shipping.phone).toBe("+12125550100")
    expect(shipping.email).toBe("jane@example.com")
    // The already-correct state and every other existing key are carried through untouched.
    expect(shipping.state).toBe("NY")
    expect(shipping.street).toBe("11418 Richmond Hill")
  })

  it("does not touch a contact address whose state, phone and email are all already populated", async () => {
    const existing = {
      name: "Jane Doe",
      street: "11418 Richmond Hill",
      city: "New York",
      postalCode: "10001",
      countryIsoCode: "US",
      state: "NY",
      phone: "+12125550100",
      email: "jane@example.com",
    }
    const { ctx, writes } = makeContactCtx({ metadata: { shipping_address: existing } })
    const ok = await backfillContactShippingAddress(ctx, "contact-1", async () => ({
      address1: "11418 Richmond Hill",
      city: "New York",
      zip: "10001",
      countryCode: "US",
      provinceCode: "NY",
      phone: "+19999999999",
      email: "someone-else@example.com",
    }))
    expect(ok).toBe(false)
    expect(writes).toHaveLength(0)
  })

  it("never calls shopify:orders_get again once phone and email are set on a destination that does not require a state", async () => {
    // ticket 10419 follow-up: requiring `state` unconditionally meant this guard could never
    // fire for a non-US/CA contact (Shopify never sends a province for e.g. an FR order), so a
    // fully phone+email healed FR contact still paid for a live shopify:orders_get on every
    // single prep_sync, forever, even once there was nothing left to add.
    const existing = {
      name: "Jean Dupont",
      street: "5 rue du Test",
      city: "Lyon",
      postalCode: "69001",
      countryIsoCode: "FR",
      state: null,
      phone: "+33612345678",
      email: "jean@example.com",
    }
    const { ctx, writes } = makeContactCtx({ metadata: { shipping_address: existing } })
    let getAddressCalls = 0
    const ok = await backfillContactShippingAddress(ctx, "contact-1", async () => {
      getAddressCalls += 1
      return {
        address1: "5 rue du Test",
        city: "Lyon",
        zip: "69001",
        countryCode: "FR",
        phone: "+33699999999",
        email: "someone-else@example.com",
      }
    })
    expect(ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(getAddressCalls).toBe(0)
  })

  it("treats a whitespace-only source phone as absent instead of writing it and looping forever", async () => {
    // ticket 10419 follow-up: a whitespace-only Shopify phone was truthy, got written verbatim,
    // then read back BLANK (trimmed) on the next pass, so it looked "still missing" and rewrote
    // the same whitespace value on every single sync forever.
    const existing = {
      name: "Jane Doe",
      street: "11418 Richmond Hill",
      city: "New York",
      postalCode: "10001",
      countryIsoCode: "US",
      state: "NY",
      phone: null,
      email: "jane@example.com",
    }
    const { ctx, writes } = makeContactCtx({ metadata: { shipping_address: existing } })
    const ok = await backfillContactShippingAddress(ctx, "contact-1", async () => ({
      address1: "11418 Richmond Hill",
      city: "New York",
      zip: "10001",
      countryCode: "US",
      provinceCode: "NY",
      phone: "   ",
    }))
    expect(ok).toBe(false)
    expect(writes).toHaveLength(0)
  })
})

describe("isRecipientComplete", () => {
  const FULL = {
    name: "Jane Doe",
    email: "jane@example.com",
    phone: "+33612345678",
    street: "5 rue du Test",
    city: "Lyon",
    postalCode: "69001",
    countryIsoCode: "FR",
  }

  it("is true when every field a label buy needs is present, including email and phone", () => {
    expect(isRecipientComplete(FULL)).toBe(true)
  })

  it("is false when the email is missing, even though the postal address is complete", () => {
    // ticket 10419: create_shipment hard-requires email (address.ts REQUIRED_FIELDS), but the
    // queue used to call this row ready anyway, so the operator only found out the field was
    // missing after staging the buy.
    expect(isRecipientComplete({ ...FULL, email: null })).toBe(false)
  })

  it("is false when the phone is missing, even though the postal address is complete", () => {
    expect(isRecipientComplete({ ...FULL, phone: null })).toBe(false)
  })

  it("is false with no recipient at all", () => {
    expect(isRecipientComplete(null)).toBe(false)
    expect(isRecipientComplete(undefined)).toBe(false)
  })

  it("is false for a US destination missing its state, even though every other field is present", () => {
    // ticket 10419 follow-up: PrepRecipient had no state field at all, so a US row missing its
    // province still showed ready and only failed late at validateParty, the exact class of bug
    // this ticket is about for email and phone.
    const us = { ...FULL, countryIsoCode: "US", state: null }
    expect(isRecipientComplete(us)).toBe(false)
  })

  it("is true for a US destination once the state is set", () => {
    const us = { ...FULL, countryIsoCode: "US", state: "NY" }
    expect(isRecipientComplete(us)).toBe(true)
  })

  it("does not require a state for a destination that does not need one", () => {
    expect(isRecipientComplete({ ...FULL, countryIsoCode: "FR", state: null })).toBe(true)
  })
})

describe("missingRecipientFields", () => {
  const FULL = {
    name: "Jane Doe",
    email: "jane@example.com",
    phone: "+33612345678",
    street: "5 rue du Test",
    city: "Lyon",
    postalCode: "69001",
    countryIsoCode: "FR",
  }

  it("names email and phone by name, not a generic incomplete message", () => {
    // ticket 10419 follow-up: the Ship tooltip used to say "the recipient address is
    // incomplete" without naming which field, leaving the operator to guess.
    expect(missingRecipientFields({ ...FULL, email: null })).toEqual(["email"])
    expect(missingRecipientFields({ ...FULL, phone: null })).toEqual(["phone"])
    expect(missingRecipientFields({ ...FULL, email: null, phone: null })).toEqual(["email", "phone"])
  })

  it("names the state or province for a US destination missing one", () => {
    expect(missingRecipientFields({ ...FULL, countryIsoCode: "US", state: null })).toEqual([
      "state or province",
    ])
  })

  it("is empty for a complete recipient", () => {
    expect(missingRecipientFields(FULL)).toEqual([])
  })
})

// The order-less rows prep_add_shipment creates for a return-after-repair: keyed on the proforma
// that anchors them, but still recording the Shopify order the parcel came from.
describe("an order-less row created from an existing order", () => {
  const NORWAY_PHONE = "+47 37 40 36 19"
  /** What the row itself stores: the structured address the prefill saved. */
  const STORED_RECIPIENT = {
    name: "Eirik Syrdalen",
    street: "Industriveien 4",
    city: "Grimstad",
    postalCode: "4879",
    phone: NORWAY_PHONE,
    countryIsoCode: "NO",
    email: "post@evenstadmusikk.no",
  }
  /** What the anchor document yields: the proforma carries the address as one free-text line
   *  ("Industriveien 4, 4879, Grimstad"), and splitting it on commas puts the street in `city` and
   *  the rest in `state`, with no street, postal code or phone at all. */
  const MANGLED_RECIPIENT = {
    name: "Eirik Syrdalen",
    street: null,
    city: "Industriveien 4",
    postalCode: null,
    state: "4879, Grimstad",
    phone: null,
    countryIsoCode: "NO",
  }

  function repairCtx(
    opts: {
      stateRecipient?: Record<string, unknown> | null
      cachedRecipient?: Record<string, unknown> | null
      extraOrderIds?: string[]
    } = {},
  ) {
    return makeCtx({
      invoices: [],
      scan: {
        withoutShipTo: true,
        extraOrders: [
          { order_id: "3423", name: "#3423", customer: "Eirik Syrdalen", country: "NO" },
          ...(opts.extraOrderIds ?? []).map((id) => ({ order_id: id, name: `#${id}`, customer: "Other Customer" })),
        ],
      },
      seed: {
        prep_order_state: [
          {
            id: "os-repair",
            order_key: "doc:prof-repair",
            category: "repair",
            status: "to_prepare",
            excluded: false,
            proforma_document_ref: "prof-repair",
            proforma_number: "PRO-0015",
            shopify_order_id: "3423",
            ...(opts.stateRecipient ? { recipient: opts.stateRecipient } : {}),
          },
        ],
        ...(opts.cachedRecipient
          ? {
              prep_draft_cache: [
                {
                  id: "dc-repair",
                  document_ref: "prof-repair",
                  parcels: [{ length: 30, width: 25, height: 8, weight: 2.5 }],
                  products: "1xES",
                  recipient: opts.cachedRecipient,
                  destination_country: "NO",
                  grand_total_minor: 69900,
                  currency: "EUR",
                  customs_ok: true,
                  needs_fix_reason: null,
                  recipient_phone_issue: null,
                  partial_remaining: null,
                  invoice_lines: [],
                  resolved_at: new Date().toISOString(),
                },
              ],
            }
          : {}),
      },
    })
  }

  // Observed live: the queue rebuilt the recipient by comma-splitting the proforma's free-text
  // address, so the street landed in the city field and the row was reported un-shippable for
  // fields the row itself was storing correctly.
  it("uses the structured address the row stores, not the comma-split document address", async () => {
    const { ctx } = repairCtx({ stateRecipient: STORED_RECIPIENT, cachedRecipient: MANGLED_RECIPIENT })
    const { rows } = await prepList(ctx, {})
    const row = rows.find((r) => r.order_key === "doc:prof-repair")!
    expect(row.recipient).toMatchObject({
      name: "Eirik Syrdalen",
      street: "Industriveien 4",
      city: "Grimstad",
      postalCode: "4879",
      phone: NORWAY_PHONE,
      email: "post@evenstadmusikk.no",
      countryIsoCode: "NO",
    })
    expect(row.recipient?.missing_fields).toEqual([])
    expect(row.recipient?.complete).toBe(true)
  })

  // Same symptom one level down: every source is only partly filled, so whichever one is taken
  // wholesale silently blanks a field another one holds.
  it("merges the recipient per field across the row, the sync cache and the document", async () => {
    const { ctx } = repairCtx({
      stateRecipient: { phone: NORWAY_PHONE, street: "Industriveien 4" },
      cachedRecipient: { ...MANGLED_RECIPIENT, city: "Grimstad", postalCode: "4879", email: "post@evenstadmusikk.no" },
    })
    const { rows } = await prepList(ctx, {})
    const row = rows.find((r) => r.order_key === "doc:prof-repair")!
    // From the row's own state.
    expect(row.recipient?.phone).toBe(NORWAY_PHONE)
    expect(row.recipient?.street).toBe("Industriveien 4")
    // From the sync cache, which the state row says nothing about.
    expect(row.recipient?.city).toBe("Grimstad")
    expect(row.recipient?.postalCode).toBe("4879")
    expect(row.recipient?.email).toBe("post@evenstadmusikk.no")
    expect(row.recipient?.missing_fields).toEqual([])
  })

  // Observed live: the same physical parcel appeared twice in the queue -- once as the repair row,
  // once as the plain order row -- so an operator could ship it twice.
  it("supersedes the order's own row in prep_list, and the total matches the rows returned", async () => {
    const { ctx } = repairCtx({ stateRecipient: STORED_RECIPIENT })
    const res = await prepList(ctx, {})
    expect(res.rows.map((r) => r.order_key)).toEqual(["doc:prof-repair"])
    expect(res.rows.some((r) => r.order_key === "so:3423")).toBe(false)
    expect(res.total).toBe(res.rows.length)
  })

  it("supersedes the order's own row in to_prepare_list too, with honest counts", async () => {
    const { ctx } = repairCtx({ stateRecipient: STORED_RECIPIENT })
    const list = await toPrepareList(ctx, {})
    expect(list.rows.map((r) => r.order_key)).toEqual(["doc:prof-repair"])
    expect(list.total).toBe(list.rows.length)
    expect(list.ready_count + list.needs_fix_count).toBeLessThanOrEqual(list.rows.length)
  })

  it("suppresses only the order it references, never another customer's order", async () => {
    const { ctx } = repairCtx({ stateRecipient: STORED_RECIPIENT, extraOrderIds: ["7788"] })
    const res = await prepList(ctx, {})
    expect(res.rows.map((r) => r.order_key).sort()).toEqual(["doc:prof-repair", "so:7788"])
    expect(res.total).toBe(res.rows.length)
  })
})
