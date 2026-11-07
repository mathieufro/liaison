// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression for quote_batch (BL-270 — the whole-wall pricing / cost-rollup tool):
//   • businessDaysBetween counts weekdays only (a calendar-N-days delivery can be
//     fewer business days; a weekend-spanning ETA excludes Sat/Sun).
//   • pickCheapestWithinEta picks the CHEAPEST offer WITHIN the ETA — the absolute-
//     cheapest-but-too-slow offer (the DPD trap) is EXCLUDED, and a route with no
//     within-ETA offer returns null (flagged, never summed at a slower price).
//   • quoteBatch fans out over many orders, picks cheapest-within-ETA per order,
//     SUMS the selected prices into one authoritative aggregate, and reports the
//     honest covered/total bound when the wall exceeds the cap.
import { describe, expect, it } from "bun:test"
import { businessDaysBetween, pickCheapestWithinEta, quoteBatch } from "./quote-batch"
import { createMockDb } from "./test-db"
import type { Offer } from "./lib/boxtal-v1-client"
import { makeOrderScanStub } from "./__fixtures__/order-scan"

// The international cotation fixture the boxtal mock serves for an EXPORT route
// (FR→US). Three offers encoding the cheapest-vs-ETA trap, collection Tue 2026-06-02:
//   DPD   41.30 → delivery 06-12 (8 business days — ABSOLUTE cheapest, TOO SLOW)
//   UPS   48.90 → delivery 06-05 (3 business days — CHEAPEST WITHIN 5 days, CORRECT)
//   FedEx 54.20 → delivery 06-04 (2 business days — fastest, priciest)
const INTERNATIONAL_XML = `<?xml version="1.0"?><cotation><shipment>
  <offer><mode>COM</mode><operator><code>UPSE</code><label>UPS</label></operator><service><code>ExpressSaver</code><label>UPS Express Saver</label></service><price><currency>EUR</currency><tax-exclusive>48.90</tax-exclusive><tax-inclusive>58.68</tax-inclusive></price><collection><date>2026-06-02</date></collection><delivery><date>2026-06-05</date><type><code>DELIVERY</code></type></delivery></offer>
  <offer><mode>COM</mode><operator><code>FEDX</code><label>FedEx</label></operator><service><code>IntlPriority</code><label>FedEx International Priority</label></service><price><currency>EUR</currency><tax-exclusive>54.20</tax-exclusive><tax-inclusive>65.04</tax-inclusive></price><collection><date>2026-06-02</date></collection><delivery><date>2026-06-04</date><type><code>DELIVERY</code></type></delivery></offer>
  <offer><mode>COM</mode><operator><code>DPDI</code><label>DPD</label></operator><service><code>IntlClassic</code><label>DPD International Classic</label></service><price><currency>EUR</currency><tax-exclusive>41.30</tax-exclusive><tax-inclusive>49.56</tax-inclusive></price><collection><date>2026-06-02</date></collection><delivery><date>2026-06-12</date><type><code>DELIVERY</code></type></delivery></offer>
</shipment></cotation>`

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

const CREDS = { v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" }

/** Build one US-bound export invoice (resolves RAL-44 → a clean draft + customs). */
function usInvoice(id: string, name: string, units = 1) {
  return {
    id,
    currency: "EUR",
    incoterm: "DAP",
    counterparty_country: "US",
    counterparty_name: name,
    counterparty_contact_id: `contact-${id}`,
    lines: [
      {
        id: `line-${id}`,
        description: "Kestrel 6 (RAL-44)",
        quantity: units,
        unit_price_minor: "69900",
        hs_code: "9207.90",
        country_of_origin: "FR",
        customs_description: "Electronic musical instrument",
        product_source: "shopify",
        external_id: "RAL-44",
      },
    ],
  }
}

/**
 * A ctx whose fetch serves the international cotation XML (so the real fan-out runs
 * draft→quote→ETA-filter→cheapest-pick) and whose executeTool returns the seeded
 * invoices. `invoices` keys the to-prepare worklist (documents_search) AND the
 * per-id documents_get / documents_search-by-ref the draft resolver uses.
 */
function makeCtx(invoices: Array<ReturnType<typeof usInvoice>>) {
  const byId = new Map(invoices.map((d) => [d.id, d]))
  const db = createMockDb({
    seed: {
      shipping_profile: [
        { id: "p-ral44", product_source: "shopify", product_id: "RAL-44", unit_weight: 2.5, solo_length: 30, solo_width: 25, solo_height: 20, content_category: "content:v1:10250" },
      ],
      app_config: [{ id: "cfg-sender", key: "sender_address", value: SENDER_PARTY }],
    },
  })
  const fetch = async (url: string, o?: { method?: string; body?: string }) => {
    if (url.includes("/iam/account-app/token")) {
      return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
    }
    if (url.includes("/cotation")) {
      return { status: 200, headers: {}, body: INTERNATIONAL_XML }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
  }
  // The worklist is ORDER-driven: the fixture invoices reach it as the documents of synthetic
  // open Shopify orders (see __fixtures__/order-scan.ts).
  const scanStub = makeOrderScanStub(invoices as never)
  const executeTool = async (target: string, args: unknown) => {
    const scanned = scanStub(target, args as Record<string, unknown>)
    if (scanned) return scanned
    if (target === "invoicing:documents_search") {
      // The to-prepare worklist enumerates issued invoices; the draft resolver also
      // resolves a non-UUID ref via documents_search. Return all (the resolver
      // matches by id within the result array).
      return { status: "completed", result: invoices.map((d) => ({ channel: "shopify", ...d })) }
    }
    if (target === "invoicing:documents_get") {
      const ref =
        typeof args === "string"
          ? args
          : (args as { id?: string; document_ref?: string }).id ??
            (args as { document_ref?: string }).document_ref
      return { status: "completed", result: (ref && byId.get(ref)) ?? null }
    }
    return { status: "error", error: { code: "unmocked", message: target } }
  }
  return {
    orgId: "org-1",
    db,
    fetch,
    executeTool,
    connections: { boxtal: { getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }), getToken: async () => { throw new Error("no") }, getAccounts: async () => [] } },
    config: { get: async () => "whsecret", has: async () => true },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as never
}

describe("businessDaysBetween", () => {
  it("counts weekdays only — collection Tue 06-02 → Fri 06-05 = 3 business days", () => {
    expect(businessDaysBetween("2026-06-02", "2026-06-05")).toBe(3)
  })
  it("excludes the weekend — collection Tue 06-02 → next-week Fri 06-12 = 8 business days", () => {
    // 06-12 is 10 calendar days out but only 8 business days (two weekends skipped).
    expect(businessDaysBetween("2026-06-02", "2026-06-12")).toBe(8)
  })
  it("returns null when a date is missing or unparseable", () => {
    expect(businessDaysBetween(null, "2026-06-05")).toBeNull()
    expect(businessDaysBetween("2026-06-02", null)).toBeNull()
    expect(businessDaysBetween("not-a-date", "2026-06-05")).toBeNull()
  })
})

function offer(partial: Partial<Offer> & Pick<Offer, "offer_code" | "carrier" | "price_ht" | "collection_date" | "delivery_date">): Offer {
  return {
    carrier_code: partial.carrier_code ?? "X",
    service: partial.service ?? "svc",
    service_code: partial.service_code ?? "svc",
    price_ttc: partial.price_ttc ?? partial.price_ht * 1.2,
    currency: partial.currency ?? "EUR",
    insurance_ht: partial.insurance_ht ?? null,
    needs_relay_point: partial.needs_relay_point ?? false,
    ...partial,
    collection_type: partial.collection_type ?? null,
    pickup_at_sender: partial.pickup_at_sender ?? false,
  }
}

describe("pickCheapestWithinEta", () => {
  const OFFERS: Offer[] = [
    offer({ offer_code: "UPSE-x", carrier: "UPS", price_ht: 48.9, collection_date: "2026-06-02", delivery_date: "2026-06-05" }), // 3 biz days
    offer({ offer_code: "FEDX-x", carrier: "FedEx", price_ht: 54.2, collection_date: "2026-06-02", delivery_date: "2026-06-04" }), // 2 biz days
    offer({ offer_code: "DPDI-x", carrier: "DPD", price_ht: 41.3, collection_date: "2026-06-02", delivery_date: "2026-06-12" }), // 8 biz days
  ]

  it("picks the CHEAPEST offer WITHIN the ETA — UPS (48.90), not the absolute-cheaper-but-too-slow DPD (41.30)", () => {
    const sel = pickCheapestWithinEta(OFFERS, 5)
    expect(sel).not.toBeNull()
    expect(sel?.carrier).toBe("UPS")
    expect(sel?.price_ht).toBe(48.9)
    expect(sel?.price_minor).toBe(4890)
    expect(sel?.eta_business_days).toBe(3)
  })

  it("EXCLUDES every offer that exceeds the ETA — a 2-business-day cap leaves only FedEx", () => {
    const sel = pickCheapestWithinEta(OFFERS, 2)
    expect(sel?.carrier).toBe("FedEx") // UPS (3d) now too slow; DPD (8d) too slow
  })

  it("returns null when NO offer meets the ETA (never summed at a slower price)", () => {
    const sel = pickCheapestWithinEta(OFFERS, 1)
    expect(sel).toBeNull()
  })

  it("breaks a price tie by the faster ETA", () => {
    const tied: Offer[] = [
      offer({ offer_code: "A", carrier: "A", price_ht: 30, collection_date: "2026-06-02", delivery_date: "2026-06-05" }), // 3 biz
      offer({ offer_code: "B", carrier: "B", price_ht: 30, collection_date: "2026-06-02", delivery_date: "2026-06-04" }), // 2 biz
    ]
    expect(pickCheapestWithinEta(tied, 5)?.carrier).toBe("B")
  })
})

describe("quoteBatch (end-to-end fan-out)", () => {
  it("prices the whole US wall: cheapest-within-5-days per order (UPS 48.90) and an authoritative summed total", async () => {
    const invoices = [
      usInvoice("inv-1", "Brad Whitfield"),
      usInvoice("inv-2", "Denise Carrington", 2),
      usInvoice("inv-3", "Travis Holloway"),
    ]
    const ctx = makeCtx(invoices)
    const res = await quoteBatch(ctx, { destination_country: "US", max_eta_business_days: 5 })

    // Every order picked UPS (the cheapest WITHIN 5 business days), never DPD (the
    // absolute-cheapest-but-7+-day trap).
    expect(res.rows).toHaveLength(3)
    for (const row of res.rows) {
      expect(row.selected?.carrier).toBe("UPS")
      expect(row.selected?.price_minor).toBe(4890)
      expect(row.selected?.eta_business_days).toBe(3)
      expect(row.no_offer_within_eta).toBe(false)
      expect(row.offers_considered).toBe(3)
    }
    // Authoritative aggregate = 3 × 48.90 = 146.70 EUR (14670 minor units).
    expect(res.aggregate.total_projected_spend_minor).toBe(3 * 4890)
    expect(res.aggregate.total_projected_spend).toBeCloseTo(146.7, 5)
    expect(res.aggregate.currency).toBe("EUR")
    expect(res.aggregate.covered_count).toBe(3)
    expect(res.aggregate.total_count).toBe(3)
    expect(res.aggregate.priced_count).toBe(3)
    expect(res.aggregate.no_offer_count).toBe(0)
    expect(res.aggregate.max_eta_business_days).toBe(5)
    // The honesty notice keeps the gated-label-buy + point-in-time-estimate framing.
    expect(res.notice).toMatch(/point-in-time/i)
    expect(res.notice).toMatch(/gated create_shipment/i)
  })

  it("prices a normal wall (9 US orders) in ONE call under the DEFAULT cap — covered == total, authoritative whole-batch total", async () => {
    // The default cap must comfortably exceed a typical day's wall so the rollup yields ONE authoritative
    // total, not a split "priced N of M" that forces a fragile second pass (the l715 gate run-1 failure:
    // a default of 8 split the 9-order wall and the agent fell back to a domestic single-quote for order 9).
    const invoices = Array.from({ length: 9 }, (_, i) => usInvoice(`inv-${i}`, `Customer ${i}`))
    const ctx = makeCtx(invoices)
    const res = await quoteBatch(ctx, { destination_country: "US", max_eta_business_days: 5 })
    expect(res.aggregate.covered_count).toBe(9)
    expect(res.aggregate.total_count).toBe(9)
    expect(res.aggregate.priced_count).toBe(9)
    expect(res.aggregate.total_projected_spend_minor).toBe(9 * 4890) // all 9 priced authoritatively
    expect(res.notice).not.toMatch(/Priced \d+ of \d+/) // no bound disclosure forced — the whole wall fit
  })

  it("honestly bounds a wall bigger than `limit`: priced N of M via covered/total counts", async () => {
    const invoices = Array.from({ length: 5 }, (_, i) => usInvoice(`inv-${i}`, `Customer ${i}`))
    const ctx = makeCtx(invoices)
    const res = await quoteBatch(ctx, { destination_country: "US", max_eta_business_days: 5, limit: 2 })

    expect(res.aggregate.covered_count).toBe(2) // only 2 priced
    expect(res.aggregate.total_count).toBe(5) // 5 in scope
    expect(res.aggregate.priced_count).toBe(2)
    expect(res.aggregate.total_projected_spend_minor).toBe(2 * 4890) // total over the priced subset only
    expect(res.notice).toMatch(/Priced 2 of 5/)
    expect(res.notice).toMatch(/3 remain/)
  })

  it("flags an order with NO within-ETA offer instead of summing it at the slower DPD price", async () => {
    const ctx = makeCtx([usInvoice("inv-1", "Brad Whitfield")])
    // A 1-business-day cap: no offer (UPS 3d / FedEx 2d / DPD 8d) meets it.
    const res = await quoteBatch(ctx, { destination_country: "US", max_eta_business_days: 1 })
    expect(res.rows[0]?.no_offer_within_eta).toBe(true)
    expect(res.rows[0]?.selected).toBeNull()
    expect(res.rows[0]?.reason).toMatch(/no offer arrives within 1 business day/i)
    // Nothing summed — the order is flagged, not fabricated at a slower price.
    expect(res.aggregate.total_projected_spend_minor).toBe(0)
    expect(res.aggregate.no_offer_count).toBe(1)
    expect(res.aggregate.priced_count).toBe(0)
  })

  it("prices explicit order_refs directly (bypassing the to-prepare worklist)", async () => {
    const ctx = makeCtx([usInvoice("inv-1", "Brad Whitfield"), usInvoice("inv-2", "Denise Carrington")])
    const res = await quoteBatch(ctx, { order_refs: ["inv-1", "inv-2"], max_eta_business_days: 5 })
    expect(res.aggregate.covered_count).toBe(2)
    expect(res.aggregate.total_count).toBe(2)
    expect(res.aggregate.total_projected_spend_minor).toBe(2 * 4890)
    expect(res.rows.every((r) => r.selected?.carrier === "UPS")).toBe(true)
  })

  it("refuses to sum a heterogeneous-currency batch: the first priced order fixes the currency; a later order in a different currency is flagged per-row, NOT silently summed", async () => {
    // Today every order is EUR (FR ship-from), so this is inert — but the guard must
    // not silently sum minor units across currencies and stamp whichever currency came
    // last. Serve EUR cotation for the first order, USD for the second.
    const usdXml = INTERNATIONAL_XML.replace(/<currency>EUR<\/currency>/g, "<currency>USD</currency>")
    const invoices = [usInvoice("inv-1", "Brad Whitfield"), usInvoice("inv-2", "Denise Carrington")]
    const byId = new Map(invoices.map((d) => [d.id, d]))
    const db = createMockDb({
      seed: {
        shipping_profile: [
          { id: "p-ral44", product_source: "shopify", product_id: "RAL-44", unit_weight: 2.5, solo_length: 30, solo_width: 25, solo_height: 20, content_category: "content:v1:10250" },
        ],
        app_config: [{ id: "cfg-sender", key: "sender_address", value: SENDER_PARTY }],
      },
    })
    let cotationCalls = 0
    const fetch = async (url: string) => {
      if (url.includes("/iam/account-app/token")) {
        return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
      }
      if (url.includes("/cotation")) {
        cotationCalls += 1
        // First priced order EUR, second order USD.
        return { status: 200, headers: {}, body: cotationCalls === 1 ? INTERNATIONAL_XML : usdXml }
      }
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
    }
    const executeTool = async (target: string, args: unknown) => {
      if (target === "invoicing:documents_search") return { status: "completed", result: invoices }
      if (target === "invoicing:documents_get") {
        const ref =
          typeof args === "string"
            ? args
            : (args as { id?: string; document_ref?: string }).id ??
              (args as { document_ref?: string }).document_ref
        return { status: "completed", result: (ref && byId.get(ref)) ?? null }
      }
      return { status: "error", error: { code: "unmocked", message: target } }
    }
    const ctx = {
      orgId: "org-1",
      db,
      fetch,
      executeTool,
      connections: { boxtal: { getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }), getToken: async () => { throw new Error("no") }, getAccounts: async () => [] } },
      config: { get: async () => "whsecret", has: async () => true },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    } as never

    const res = await quoteBatch(ctx, { order_refs: ["inv-1", "inv-2"], max_eta_business_days: 5 })

    // The EUR order is priced and feeds the total; the USD order is FLAGGED, excluded.
    expect(res.aggregate.currency).toBe("EUR")
    expect(res.aggregate.total_projected_spend_minor).toBe(4890) // ONLY the EUR order, NOT 2×4890
    expect(res.aggregate.priced_count).toBe(1)
    const eurRow = res.rows.find((r) => r.order_ref === "inv-1")
    const usdRow = res.rows.find((r) => r.order_ref === "inv-2")
    expect(eurRow?.reason).toBeUndefined()
    expect(eurRow?.selected?.currency).toBe("EUR")
    // The USD order keeps its selected offer (so the caller sees it) but is excluded
    // from the aggregate with a grounded reason — never summed across currencies.
    expect(usdRow?.selected?.currency).toBe("USD")
    expect(usdRow?.no_offer_within_eta).toBe(false)
    expect(usdRow?.reason).toMatch(/USD/)
    expect(usdRow?.reason).toMatch(/EUR/)
    expect(usdRow?.reason).toMatch(/across currencies/i)
  })
})
