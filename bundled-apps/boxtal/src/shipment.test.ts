// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { ToolError } from "@liaison/app-sdk"
import {
  createShipment,
  pollCreateShipmentOutput,
  normalizeRecipientAddress,
  normalizePostalCode,
  parseInvoiceAddress,
  createShipmentPreflight,
  importLabelDocument,
  importLabelFile,
  LABEL_IMPORT_ATTEMPTS,
  LABEL_IMPORT_BUDGET_MS,
  quote,
  shipmentDraftCreate,
  shipmentDraftSetCustoms,
  shipmentDraftSetCustomsPersist,
  shipmentDraftSetPackage,
  shipmentDraftSetPackagePersist,
} from "./shipment"
import { createMockDb } from "./test-db"
import { deriveDraftFacts } from "./draft-cache"
import { BOXTAL_CALL_BUDGET_MS } from "./lib/http-budget"

const CREDS = { v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" }

const MULTI_XML = `<?xml version="1.0"?><cotation><shipment>
  <offer><mode>COM</mode><operator><code>CHRP</code><label>Chronopost</label></operator><service><code>Chrono18</code><label>Chrono 18</label></service><price><currency>EUR</currency><tax-exclusive>7.80</tax-exclusive><tax-inclusive>9.36</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-02</date><type><code>DELIVERY</code></type></delivery></offer>
</shipment></cotation>`

// Four carriers on one route — Chronopost plus the express trio — for the
// carrier-allowlist filter tests. Ascending price so the sort order is stable.
const FOUR_CARRIER_XML = `<?xml version="1.0"?><cotation><shipment>
  <offer><mode>COM</mode><operator><code>CHRP</code><label>Chronopost</label></operator><service><code>Chrono2ShopEurope</code><label>Chrono 2Shop Europe</label></service><price><currency>EUR</currency><tax-exclusive>9.66</tax-exclusive><tax-inclusive>11.59</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-04</date><type><code>DELIVERY</code></type></delivery></offer>
  <offer><mode>COM</mode><operator><code>FEDX</code><label>FedEx</label></operator><service><code>FedexRegionalEconomy</code><label>FedEx Regional Economy</label></service><price><currency>EUR</currency><tax-exclusive>15.46</tax-exclusive><tax-inclusive>18.54</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-03</date><type><code>DELIVERY</code></type></delivery></offer>
  <offer><mode>COM</mode><operator><code>UPSE</code><label>UPS</label></operator><service><code>StandardAP</code><label>UPS Standard Access Point</label></service><price><currency>EUR</currency><tax-exclusive>16.20</tax-exclusive><tax-inclusive>19.44</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-03</date><type><code>DELIVERY</code></type></delivery></offer>
  <offer><mode>COM</mode><operator><code>DHLE</code><label>DHL Express</label></operator><service><code>EconomySelect</code><label>DHL Express Economy Select</label></service><price><currency>EUR</currency><tax-exclusive>42.01</tax-exclusive><tax-inclusive>50.41</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-03</date><type><code>DELIVERY</code></type></delivery></offer>
</shipment></cotation>`

/** A complete sender (ship-from) party — the Boxtal settings surface persists this. */
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

/** A complete recipient address the operator supplies on the create call. */
const RECIPIENT_ADDRESS = {
  name: "Acme Corp",
  email: "ops@acme.example",
  phone: "+12125550100",
  street: "350 5th Ave",
  city: "New York",
  postalCode: "10118",
  countryIsoCode: "US",
  state: "NY",
}

/** Invoice doc returned by the cross-app documents_get read. */
const INVOICE = {
  id: "doc-1",
  currency: "EUR",
  incoterm: "DAP",
  counterparty_country: "US",
  counterparty_name: "Acme Corp",
  counterparty_contact_id: "contact-1",
  lines: [
    {
      id: "line-1",
      description: "Touchpad",
      quantity: 1,
      unit_price_minor: "10000",
      hs_code: "851762",
      country_of_origin: "FR",
      customs_description: "Tessera touchpad",
      product_source: "shopify",
      external_id: "V1",
    },
  ],
}

function makeCtx(opts?: {
  v3Status?: number
  v3Body?: string
  trackingBody?: string
  cotationBody?: string
  cotationStatus?: number
  documentsBody?: string
  executeTool?: any
  /** Stub of the binary-safe host import bridge; records its parsed args. */
  filesImportFromUrl?: (args: Record<string, unknown>) => Promise<string>
  /** Omit the seeded sender address (to exercise the sender-required hard-fail). */
  noSender?: boolean
  /** Seed a carrier_allowlist app_config row (brand keys). Omitted = no restriction. */
  allowlist?: string[]
  /** Seed the exclude_pickup_point_services policy. Omitted = the prod default (true,
   *  relay excluded); pass false to isolate a test from the pickup-point filter. */
  excludePickupPoint?: boolean
}) {
  const appConfigRows: Array<Record<string, unknown>> = []
  if (!opts?.noSender) appConfigRows.push({ id: "cfg-sender", key: "sender_address", value: SENDER_PARTY })
  if (opts?.allowlist) appConfigRows.push({ id: "cfg-allowlist", key: "carrier_allowlist", value: opts.allowlist })
  if (typeof opts?.excludePickupPoint === "boolean")
    appConfigRows.push({ id: "cfg-pickup", key: "exclude_pickup_point_services", value: opts.excludePickupPoint })
  const db = createMockDb({
    seed: {
      shipping_profile: [
        { id: "p1", product_source: "shopify", product_id: "V1", unit_weight: 0.5, solo_length: 30, solo_width: 20, solo_height: 10, content_category: "content:v1:10120" },
      ],
      ...(appConfigRows.length ? { app_config: appConfigRows } : {}),
    },
  })
  const fetchCalls: Array<{ url: string; method: string; body?: string }> = []
  const fetch = async (url: string, o?: { method?: string; body?: string }) => {
    const method = o?.method ?? "GET"
    fetchCalls.push({ url, method, body: o?.body })
    if (url.includes("/iam/account-app/token")) {
      return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
    }
    if (url.includes("/cotation")) {
      return { status: opts?.cotationStatus ?? 200, headers: {}, body: opts?.cotationBody ?? MULTI_XML }
    }
    if (url.includes("/shipping-order") && url.includes("/tracking")) {
      return { status: 200, headers: {}, body: opts?.trackingBody ?? JSON.stringify({ status: 200, timestamp: "t", content: [{ status: "ANNOUNCED", trackingNumber: "TRK1", trackingDateTime: "2026-06-01T00:00:00Z", history: [] }] }) }
    }
    if (url.includes("/shipping-order") && url.includes("/shipping-document")) {
      return { status: 200, headers: {}, body: opts?.documentsBody ?? JSON.stringify({ status: 200, timestamp: "t", content: [] }) }
    }
    if (url.includes("/shipping-order")) {
      const status = opts?.v3Status ?? 200
      return {
        status,
        headers: {},
        body: opts?.v3Body ?? JSON.stringify({ status: 200, timestamp: "t", content: { id: "ord-1", status: "PENDING", deliveryPriceExclTax: { value: 7.8, currency: "EUR" } } }),
      }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
  }
  const executeTool =
    opts?.executeTool ??
    (async (target: string, _args: unknown) => {
      // shipmentDraftCreate resolves a non-UUID document_ref via documents_search before documents_get
      // (the l712 robustness fix). The default mock answers BOTH: documents_search returns the INVOICE in
      // an array (so the resolver finds its id), documents_get returns the INVOICE object.
      if (target === "invoicing:documents_search") {
        return { status: "completed", result: [INVOICE] }
      }
      return { status: "completed", result: INVOICE }
    })
  const importCalls: Array<Record<string, unknown>> = []
  const ctx = {
    orgId: "org-1",
    db,
    fetch,
    executeTool,
    connections: { boxtal: { getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }), getToken: async () => { throw new Error("no") }, getAccounts: async () => [] } },
    config: { get: async () => "whsecret", has: async () => true },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ...(opts?.filesImportFromUrl
      ? {
          files_importFromUrl: async (argsJson: string) => {
            const parsed = JSON.parse(argsJson) as Record<string, unknown>
            importCalls.push(parsed)
            return opts.filesImportFromUrl!(parsed)
          },
        }
      : {}),
  } as any
  return { ctx, db, fetchCalls, importCalls }
}

describe("normalizePostalCode", () => {
  it("truncates a US ZIP+4 to the 5-digit ZIP (Boxtal 400s the +4 form)", () => {
    expect(normalizePostalCode("19003-2385", "US")).toBe("19003")
    expect(normalizePostalCode("19003", "US")).toBe("19003")
  })
  it("restores a US ZIP's dropped leading zero and drops what is not a US ZIP", () => {
    expect(normalizePostalCode("2501", "US")).toBe("02501")
    expect(normalizePostalCode("250", "US")).toBeNull()
    expect(normalizePostalCode("W 57th", "US")).toBeNull()
  })
  it("leaves non-US codes untouched", () => {
    expect(normalizePostalCode("75018", "FR")).toBe("75018")
    expect(normalizePostalCode("SW1A 1AA", "GB")).toBe("SW1A 1AA")
    expect(normalizePostalCode("123-4567", "JP")).toBe("123-4567")
  })
})

describe("parseInvoiceAddress", () => {
  const fb = { name: "Xavier Thibaud", email: "x@example.com", countryIsoCode: "FR" }
  it("parses street + zip city from the flattened invoice string", () => {
    expect(parseInvoiceAddress("50 rue des TROIS ROIS\n44000 NANTES", fb)).toMatchObject({
      street: "50 rue des TROIS ROIS",
      postalCode: "44000",
      city: "NANTES",
      name: "Xavier Thibaud",
      countryIsoCode: "FR",
    })
  })
  it("keeps multi street lines and strips a trailing province", () => {
    expect(
      parseInvoiceAddress("Fabrikam\n81 rue des Exemples\n75018 Paris, Île-de-France", fb),
    ).toMatchObject({ street: "Fabrikam, 81 rue des Exemples", postalCode: "75018", city: "Paris" })
  })
  it("reads a US address ZIP-last: the street number is never the postal code", () => {
    const us = { ...fb, countryIsoCode: "US" }
    expect(parseInvoiceAddress("250 W 57th St, New York, NY 10019", us)).toMatchObject({
      street: "250 W 57th St",
      city: "New York",
      postalCode: "10019",
      state: "NY",
    })
    expect(parseInvoiceAddress("Acme Inc\n250 W 57th St\nNew York, NY 10019-1234", us)).toMatchObject({
      street: "Acme Inc, 250 W 57th St",
      city: "New York",
      postalCode: "10019",
      state: "NY",
    })
    // The zip-first form invoicing writes keeps working.
    expect(parseInvoiceAddress("11418 Richmond Hill\n10001 New York, New York", us)).toMatchObject({
      postalCode: "10001",
      city: "New York",
    })
  })
  it("drops a trailing country, as its own line or as the last comma part", () => {
    const us = { ...fb, countryIsoCode: "US" }
    const want = { street: "250 W 94th St, Apt. 8j", city: "New York", postalCode: "10025", state: "NY" }
    expect(parseInvoiceAddress("250 W 94th St, Apt. 8j, New York, NY 10025, USA", us)).toMatchObject(want)
    expect(parseInvoiceAddress("250 W 94th St, Apt. 8j\nNew York, NY 10025\nUnited States", us)).toMatchObject(
      want,
    )
    expect(parseInvoiceAddress("50 rue des TROIS ROIS\n44000 NANTES\nFrance", fb)).toMatchObject({
      street: "50 rue des TROIS ROIS",
      postalCode: "44000",
      city: "NANTES",
    })
  })
  it("reads labelled lines (City: / Postal Code: / State:)", () => {
    const us = { ...fb, countryIsoCode: "US" }
    expect(
      parseInvoiceAddress("250 W 94th St, Apt. 8j\nCity: New York\nPostal Code: 10025\nState: NY\nUSA\n", us),
    ).toMatchObject({ street: "250 W 94th St, Apt. 8j", city: "New York", postalCode: "10025", state: "NY" })
    expect(
      parseInvoiceAddress("Street: 12 rue Oberkampf\nZip: 75011\nCity: Paris\nCountry: France", fb),
    ).toMatchObject({ street: "12 rue Oberkampf", city: "Paris", postalCode: "75011" })
  })
  it("reads a US address whose state is spelled out before the ZIP", () => {
    const us = { ...fb, countryIsoCode: "US" }
    expect(parseInvoiceAddress("250 W 94th St\nNew York, New York 10025", us)).toMatchObject({
      street: "250 W 94th St",
      city: "New York",
      postalCode: "10025",
      state: "NY",
    })
  })
  it("null for an empty or missing string", () => {
    expect(parseInvoiceAddress(null, fb)).toBeNull()
    expect(parseInvoiceAddress("  \n ", fb)).toBeNull()
  })
})

describe("quote", () => {
  it("passes parcels through to v1 and returns sorted offers", async () => {
    const { ctx } = makeCtx()
    const res = await quote(ctx, {
      from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
      to: { country: "US", postalCode: "10001", city: "NYC", type: "particulier", state: "NY" },
      parcels: [{ weight: 0.5, length: 30, width: 20, height: 10 }],
      content_code: "10120",
    })
    expect(res.offers).toHaveLength(1)
    expect(res.offers[0]!.offer_code).toBe("CHRP-Chrono18")
  })

  it("applies the org carrier allowlist at the quote chokepoint: only UPS/FedEx/DHL survive, Chronopost is dropped", async () => {
    // excludePickupPoint:false isolates the ALLOWLIST axis — FOUR_CARRIER_XML's UPS
    // offer is a "Standard Access Point" service the pickup-point policy would also
    // drop; disabling that policy keeps this test focused on the brand filter.
    const { ctx } = makeCtx({ cotationBody: FOUR_CARRIER_XML, allowlist: ["ups", "fedex", "dhl"], excludePickupPoint: false })
    const res = await quote(ctx, {
      from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
      to: { country: "DE", postalCode: "04289", city: "Leipzig", type: "particulier" },
      parcels: [{ weight: 4.2, length: 58, width: 38, height: 10 }],
      content_code: "50360",
    })
    const codes = res.offers.map((o) => o.carrier_code)
    expect(codes).toEqual(expect.arrayContaining(["FEDX", "UPSE", "DHLE"]))
    expect(codes).not.toContain("CHRP")
    expect(res.offers).toHaveLength(3)
  })

  it("ignore_allowlist:true bypasses a SET allowlist for one quote: Chronopost survives alongside UPS/FedEx/DHL", async () => {
    // Same fixture + SAME allowlist as the chokepoint test above (which drops CHRP);
    // the only difference is ignore_allowlist:true, so if the flag works the
    // non-allowlisted Chronopost offer must now come through. excludePickupPoint:false
    // isolates the allowlist axis (FOUR_CARRIER_XML's UPS offer is an access-point service).
    const { ctx } = makeCtx({ cotationBody: FOUR_CARRIER_XML, allowlist: ["ups", "fedex", "dhl"], excludePickupPoint: false })
    const res = await quote(ctx, {
      from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
      to: { country: "DE", postalCode: "04289", city: "Leipzig", type: "particulier" },
      parcels: [{ weight: 4.2, length: 58, width: 38, height: 10 }],
      content_code: "50360",
      ignore_allowlist: true,
    })
    const codes = res.offers.map((o) => o.carrier_code)
    expect(codes).toContain("CHRP")
    expect(codes).toEqual(expect.arrayContaining(["CHRP", "FEDX", "UPSE", "DHLE"]))
    expect(res.offers).toHaveLength(4)
  })

  it("ignore_allowlist does NOT disable the pickup-point exclusion (the two policies are independent)", async () => {
    // The bypass is scoped to the carrier allowlist ONLY: with a SET allowlist and
    // ignore_allowlist:true but the (default-on) relay exclusion left in place, the
    // cheaper UPS Access Point relay offer must still be dropped, so the door-to-door
    // Chronopost is the sole survivor -- proving ignore_allowlist did not leak into
    // the pickup-point axis.
    const { ctx } = makeCtx({ cotationBody: RELAY_CHEAPEST_XML, allowlist: ["ups", "fedex", "dhl"] })
    const res = await quote(ctx, {
      to: { country: "FR", postalCode: "75001", city: "Paris", type: "particulier" },
      parcels: [{ weight: 1, length: 20, width: 15, height: 10 }],
      content_code: "10120",
      ignore_allowlist: true,
    })
    expect(res.offers.map((o) => o.offer_code)).toEqual(["CHRP-Chrono13"])
    expect(res.offers.some((o) => o.offer_code === "UPSE-EconomyAccessPoint")).toBe(false)
  })

  it("with NO allowlist set, every carrier including Chronopost is returned (back-compat)", async () => {
    // Back-compat is about the allowlist being absent; the UPS access-point offer here
    // is dropped by the (default-on) pickup policy, so disable it to assert all four.
    const { ctx } = makeCtx({ cotationBody: FOUR_CARRIER_XML, excludePickupPoint: false })
    const res = await quote(ctx, {
      from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
      to: { country: "DE", postalCode: "04289", city: "Leipzig", type: "particulier" },
      parcels: [{ weight: 4.2, length: 58, width: 38, height: 10 }],
      content_code: "50360",
    })
    expect(res.offers.map((o) => o.carrier_code)).toEqual(
      expect.arrayContaining(["CHRP", "FEDX", "UPSE", "DHLE"]),
    )
    expect(res.offers).toHaveLength(4)
  })

  // A route where the CHEAPEST offer is a relay: a UPS access-point service (flagged
  // in metadata via PICKUP_POINT delivery type) at 9.07 undercuts a door-to-door
  // Chronopost at 12.40 — the exact "cheapest is a relay" trap the policy prevents.
  const RELAY_CHEAPEST_XML = `<?xml version="1.0"?><cotation><shipment>
    <offer><mode>COM</mode><operator><code>UPSE</code><label>UPS</label></operator><service><code>EconomyAccessPoint</code><label>UPS Economy Access Point</label></service><price><currency>EUR</currency><tax-exclusive>9.07</tax-exclusive><tax-inclusive>10.88</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-03</date><type><code>PICKUP_POINT</code></type></delivery></offer>
    <offer><mode>COM</mode><operator><code>CHRP</code><label>Chronopost</label></operator><service><code>Chrono13</code><label>Chrono 13</label></service><price><currency>EUR</currency><tax-exclusive>12.40</tax-exclusive><tax-inclusive>14.88</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-02</date><type><code>DELIVERY</code></type></delivery></offer>
  </shipment></cotation>`

  it("excludes relay / pickup-point offers by DEFAULT: the door-to-door Chronopost wins, not the cheaper UPS Access Point", async () => {
    const { ctx } = makeCtx({ cotationBody: RELAY_CHEAPEST_XML })
    const res = await quote(ctx, {
      to: { country: "FR", postalCode: "75001", city: "Paris", type: "particulier" },
      parcels: [{ weight: 1, length: 20, width: 15, height: 10 }],
      content_code: "10120",
    })
    expect(res.offers.map((o) => o.offer_code)).toEqual(["CHRP-Chrono13"])
    expect(res.offers.some((o) => o.offer_code === "UPSE-EconomyAccessPoint")).toBe(false)
  })

  it("keeps relay offers when the policy is off (exclude_pickup_point_services=false)", async () => {
    const { ctx } = makeCtx({ cotationBody: RELAY_CHEAPEST_XML, excludePickupPoint: false })
    const res = await quote(ctx, {
      to: { country: "FR", postalCode: "75001", city: "Paris", type: "particulier" },
      parcels: [{ weight: 1, length: 20, width: 15, height: 10 }],
      content_code: "10120",
    })
    expect(res.offers).toHaveLength(2)
    expect(res.offers[0]!.offer_code).toBe("UPSE-EconomyAccessPoint") // cheapest again
  })

  it("include_pickup_point:true bypasses the default exclusion for one call", async () => {
    const { ctx } = makeCtx({ cotationBody: RELAY_CHEAPEST_XML })
    const res = await quote(ctx, {
      to: { country: "FR", postalCode: "75001", city: "Paris", type: "particulier" },
      parcels: [{ weight: 1, length: 20, width: 15, height: 10 }],
      content_code: "10120",
      include_pickup_point: true,
    })
    expect(res.offers).toHaveLength(2)
    expect(res.offers.some((o) => o.offer_code === "UPSE-EconomyAccessPoint")).toBe(true)
  })

  it("surfaces a typed cotation <error> as { offers:[], error } carrying the verbatim message", async () => {
    const ERROR_XML = `<?xml version="1.0"?><error><code>RESULT_ERROR</code><message>Le code postal du destinataire est invalide.</message></error>`
    const { ctx } = makeCtx({ cotationBody: ERROR_XML })
    const res = await quote(ctx, {
      from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
      to: { country: "FR", postalCode: "BAD", city: "X", type: "particulier" },
      parcels: [{ weight: 1, length: 10, width: 10, height: 10 }],
      content_code: "10120",
    })
    expect(res.offers).toEqual([])
    expect(res.error?.code).toBe("cotation_invalid")
    expect(res.error?.message).toContain("Le code postal du destinataire est invalide")
  })

  it("an HTTP 400 refusing the route's data is cotation_invalid, a 5xx stays cotation_error", async () => {
    const input = {
      from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" as const },
      to: { country: "US", postalCode: "250", city: "X", type: "particulier" as const },
      parcels: [{ weight: 1, length: 10, width: 10, height: 10 }],
      content_code: "10120",
    }
    const bad = makeCtx({
      cotationStatus: 400,
      cotationBody: `<?xml version="1.0"?><error><code>bad_request</code><message>Le code postal 250 est invalide pour le code pays US</message></error>`,
    })
    const res = await quote(bad.ctx, input)
    expect(res.error?.code).toBe("cotation_invalid")
    expect(res.error?.message).toContain("Le code postal 250 est invalide")
    const down = makeCtx({ cotationStatus: 503, cotationBody: "unavailable" })
    expect((await quote(down.ctx, input)).error?.code).toBe("cotation_error")
  })

  it("expands parcel quantity into N identical colis in the cotation query", async () => {
    const { ctx, fetchCalls } = makeCtx()
    await quote(ctx, {
      from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
      to: { country: "DE", postalCode: "96138", city: "Burgebrach", type: "entreprise" },
      parcels: [{ weight: 19, length: 58, width: 38, height: 40, quantity: 5 }],
      content_code: "50360",
    })
    const cot = fetchCalls.find((c) => c.url.includes("/cotation"))!
    expect(cot.url).toContain("colis_5.poids=19")
    expect(cot.url).not.toContain("colis_6.")
    expect(cot.url).not.toContain("quantity")
  })

  it("direct quote without content_code defaults it from the catalog's dominant content category", async () => {
    const { ctx, fetchCalls } = makeCtx()
    const res = await quote(ctx, {
      from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
      to: { country: "DE", postalCode: "96138", city: "Burgebrach", type: "entreprise" },
      parcels: [{ weight: 19, length: 58, width: 38, height: 40 }],
    })
    expect(res.error).toBeUndefined()
    const cot = fetchCalls.find((c) => c.url.includes("/cotation"))!
    expect(cot.url).toContain("code_contenu=10120")
  })

  it("direct quote without content_code and an empty catalog returns a typed content_code_required error", async () => {
    const { ctx, db } = makeCtx()
    await db.delete("shipping_profile", "p1")
    const res = await quote(ctx, {
      from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
      to: { country: "DE", postalCode: "96138", city: "Burgebrach", type: "entreprise" },
      parcels: [{ weight: 19, length: 58, width: 38, height: 40 }],
    })
    expect(res.offers).toEqual([])
    expect(res.error?.code).toBe("content_code_required")
    expect(res.error?.message).toContain("list_content_categories")
  })

  it("enriches an empty `from` from the persisted sender + normalizes party types to French", async () => {
    // Mirrors the create-shipment UI's "Get quotes": an empty sender (the ship-from is
    // org config, server-enriched) + the recipient as `to` carrying the v3 vocabulary.
    const { ctx, fetchCalls } = makeCtx()
    await quote(ctx, {
      from: { country: "", postalCode: "", city: "", type: "" },
      to: { country: "FR", postalCode: "13001", city: "Marseille", type: "BUSINESS" },
      parcels: [{ weight: 1, length: 20, width: 20, height: 20 }],
      content_code: "10120",
    })
    const cot = fetchCalls.find((c) => c.url.includes("/cotation"))
    expect(cot).toBeTruthy()
    const url = cot!.url
    // `from` enriched from SENDER_PARTY (FR / 75001 / Paris) + type → entreprise.
    expect(url).toContain("expediteur.pays=FR")
    expect(url).toContain("expediteur.code_postal=75001")
    expect(url).toContain("expediteur.type=entreprise")
    // `to.type` "BUSINESS" coerced to the French vocabulary the live v1 cotation wants.
    expect(url).toContain("destinataire.pays=FR")
    expect(url).toContain("destinataire.type=entreprise")
    // Never leak the v3 vocabulary to the live cotation (it 400s on "BUSINESS").
    expect(url).not.toContain("type=BUSINESS")
  })

  it("defaults a missing recipient type to particulier (consumer)", async () => {
    const { ctx, fetchCalls } = makeCtx()
    await quote(ctx, {
      from: { country: "FR", postalCode: "75001", city: "Paris", type: "entreprise" },
      to: { country: "FR", postalCode: "13001", city: "Marseille", type: "" },
      parcels: [{ weight: 1, length: 20, width: 20, height: 20 }],
      content_code: "10120",
    })
    const url = fetchCalls.find((c) => c.url.includes("/cotation"))!.url
    expect(url).toContain("destinataire.type=particulier")
    // Explicit French `from` is left untouched (enrichment only fires on an empty sender).
    expect(url).toContain("expediteur.type=entreprise")
  })

  // Regression for marco-prepare-single-export-shipment-jp: a weak model that hand-builds `to` for the
  // quote commonly drops the destination COUNTRY (it sent postal + city but `destinataire.pays=` empty),
  // which silently fell the route back to domestic — so an export quote returned domestic-only carriers
  // and the agent picked a service that does not serve the destination. Quoting via the draft id derives
  // the route (incl. country), parcels and content from the draft, so the cotation carries the real
  // destination country.
  it("defaults the route (destination country), parcels and content from the draft via draft_id", async () => {
    const { ctx, fetchCalls } = makeCtx()
    await quote(ctx, {
      draft_id: "doc-1",
      // The agent omits the route fields — they come from the draft (INVOICE.counterparty_country = US).
      from: { country: "", postalCode: "", city: "", type: "" },
      to: { country: "", postalCode: "", city: "", type: "" },
      parcels: [],
    } as never)
    const url = fetchCalls.find((c) => c.url.includes("/cotation"))!.url
    // Destination country is filled from the draft, NOT left empty (the silent-domestic-fallback bug).
    expect(url).toContain("destinataire.pays=US")
    expect(url).not.toContain("destinataire.pays=&")
    // Parcels come from the draft's resolved shipping profile (weight 0.5 from p1).
    expect(url).toContain("colis_1.poids=0.5")
    // Sender still enriched from org config.
    expect(url).toContain("expediteur.pays=FR")
  })

  it("is_return quotes the REVERSE leg: the resolved parties swap (expediteur=customer, destinataire=org)", async () => {
    const { ctx, fetchCalls } = makeCtx()
    await quote(ctx, {
      draft_id: "doc-1",
      is_return: true,
      from: { country: "", postalCode: "", city: "", type: "" },
      to: { country: "", postalCode: "", city: "", type: "" },
      parcels: [],
    } as never)
    const url = fetchCalls.find((c) => c.url.includes("/cotation"))!.url
    // The draft resolves the OUTBOUND route (org FR → customer US); a return prices the
    // opposite way, so the customer becomes the expediteur and the org the destinataire.
    expect(url).toContain("expediteur.pays=US")
    expect(url).toContain("destinataire.pays=FR")
    // Party types travel with each party through the swap: customer stays a consumer,
    // the org stays a business.
    expect(url).toContain("expediteur.type=particulier")
    expect(url).toContain("destinataire.type=entreprise")
    // Same goods travelling back: parcels unchanged.
    expect(url).toContain("colis_1.poids=0.5")
  })

  it("a caller-supplied route field still wins over the draft default", async () => {
    const { ctx, fetchCalls } = makeCtx()
    await quote(ctx, {
      draft_id: "doc-1",
      from: { country: "", postalCode: "", city: "", type: "" },
      // Explicit destination overrides the draft's US.
      to: { country: "JP", postalCode: "153-0063", city: "Tokyo", type: "particulier" },
      parcels: [],
    } as never)
    const url = fetchCalls.find((c) => c.url.includes("/cotation"))!.url
    expect(url).toContain("destinataire.pays=JP")
    expect(url).not.toContain("destinataire.pays=US")
  })
})

describe("shipmentDraftCreate", () => {
  it("reads the invoice, resolves parcels + customs, returns a draft with zero unresolved", async () => {
    const { ctx } = makeCtx()
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.document_ref).toBe("doc-1")
    expect(draft.parcels).toHaveLength(1)
    expect(draft.customsArticles).toHaveLength(1)
    expect(draft.customsArticles[0]).toMatchObject({ tariffNumber: "851762", originCountry: "FR" })
    expect(draft.unresolved).toHaveLength(0)
  })

  // l710 surface robustness (auto-fulfill-eu-orders BL-275 runtime-tick failure): the Boxtal "draft" is
  // VIRTUAL — re-derived from the invoice each call — so its identity IS the invoice document_ref. The
  // downstream tools (set_package / set_customs / quote / create_shipment) take a `draft_id` that === the
  // document_ref. A weak tick that looked for a `draft_id`/`id` field on the shipment_draft_create result,
  // found none, and reported a "draft identifier format / synchronization error" staged NOTHING. The
  // result now surfaces the SAME id under BOTH `document_ref` AND `draft_id`, so the tick chains it
  // straight to the next tool without having to know the document_ref IS the draft id.
  it("surfaces draft_id (=== document_ref) so the tick chains create→set_package→create_shipment", async () => {
    const { ctx } = makeCtx()
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.draft_id).toBe("doc-1")
    expect(draft.draft_id).toBe(draft.document_ref)
  })

  it("merges the invoice-parsed state into a contact address that has none, keeping the contact street and phone", async () => {
    const executeTool = async (target: string, _args: unknown) => {
      if (target === "kernel:contacts_read") {
        return {
          status: "completed",
          result: {
            contact: {
              id: "contact-1",
              metadata: {
                shipping_address: {
                  name: "Acme Corp",
                  street: "11418 Richmond Hill",
                  city: "New York",
                  postalCode: "10001",
                  countryIsoCode: "US",
                  phone: "+12125550100",
                },
              },
            },
          },
        }
      }
      const withAddress = {
        ...INVOICE,
        counterparty_country: "US",
        counterparty_address: "11418 Richmond Hill\n10001 New York, New York",
      }
      if (target === "invoicing:documents_search") return { status: "completed", result: [withAddress] }
      return { status: "completed", result: withAddress }
    }
    const { ctx } = makeCtx({ executeTool })
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.recipient_address?.state).toBe("NY")
    expect(draft.recipient_address?.street).toBe("11418 Richmond Hill")
    expect(draft.recipient_address?.phone).toBe("+12125550100")
  })

  // Walk D47: a live order's recipient had no phone where the label buy reads
  // it (the contact's stored shipping address, never written: only the prep
  // grid's sync wrote it), so the booking was refused unless the model copied
  // the phone from the Shopify order itself. The draft now writes the order's
  // ship-to onto the contact first, and carries it.
  it("fills the recipient from the invoice's Shopify order when the contact has no shipping address", async () => {
    let stored: Record<string, unknown> | null = null
    const executeTool = async (target: string, args: Record<string, unknown>) => {
      if (target === "kernel:contacts_read") {
        return {
          status: "completed",
          result: { contact: { id: "contact-1", metadata: stored ? { shipping_address: stored } : {} } },
        }
      }
      if (target === "kernel:contacts_write") {
        stored = (args.metadata as { shipping_address: Record<string, unknown> }).shipping_address
        return { status: "completed", result: { contact: { id: "contact-1" } } }
      }
      if (target === "shopify:orders_get") {
        return {
          status: "completed",
          result: {
            name: "#1097",
            shippingAddress: {
              name: "Harborlight Audio KK",
              company: "Harborlight Audio KK",
              address1: "21 Yamashitacho",
              city: "Yokohama",
              zip: "231-0023",
              countryCode: "JP",
              phone: "+81 45 100003",
            },
            attributes: { email: "orders@jptky.example" },
          },
        }
      }
      const fromOrder = {
        ...INVOICE,
        counterparty_country: "JP",
        counterparty_name: "Harborlight Audio KK",
        counterparty_address: "21 Yamashitacho\n231-0023 Yokohama",
        shopify_order_id: "6100097",
      }
      if (target === "invoicing:documents_search") return { status: "completed", result: [fromOrder] }
      return { status: "completed", result: fromOrder }
    }
    const { ctx } = makeCtx({ executeTool })
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.recipient_address).toMatchObject({
      phone: "+81 45 100003",
      street: "21 Yamashitacho",
      city: "Yokohama",
      postalCode: "231-0023",
      countryIsoCode: "JP",
    })
    // The draft carries the order's ship-to itself; it never writes the contact.
    expect(stored).toBeNull()
  })

  // Walk D59: in a conversation whose writes park for approval, the contact
  // write the draft made on every build (each quote, rate check and staged
  // booking rebuilds it) was held each time and never landed, so the next
  // build wrote again: ten identical contact-write approvals per shipment.
  it("never writes the contact while building, however often the draft is rebuilt", async () => {
    const writes: Array<Record<string, unknown>> = []
    const fromOrder = {
      ...INVOICE,
      counterparty_country: "JP",
      counterparty_name: "Harborlight Audio KK",
      counterparty_address: "21 Yamashitacho\n231-0023 Yokohama",
      shopify_order_id: "6100097",
    }
    const executeTool = async (target: string, args: Record<string, unknown>) => {
      if (target === "kernel:contacts_read") {
        return { status: "completed", result: { contact: { id: "contact-1", metadata: {} } } }
      }
      if (target === "kernel:contacts_write") {
        writes.push(args)
        return { status: "pending_approval", approval_id: `req-${writes.length}` }
      }
      if (target === "shopify:orders_get") {
        return {
          status: "completed",
          result: {
            name: "#1097",
            shippingAddress: {
              name: "Harborlight Audio KK",
              address1: "21 Yamashitacho",
              city: "Yokohama",
              zip: "231-0023",
              countryCode: "JP",
              phone: "+81 45 100003",
            },
          },
        }
      }
      if (target === "invoicing:documents_search") return { status: "completed", result: [fromOrder] }
      return { status: "completed", result: fromOrder }
    }
    const { ctx } = makeCtx({ executeTool })
    for (let i = 0; i < 4; i++) {
      const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
      expect(draft.recipient_address).toMatchObject({ phone: "+81 45 100003", postalCode: "231-0023" })
    }
    expect(writes).toHaveLength(0)
  })

  it("surfaces a pending_approval envelope verbatim", async () => {
    // A UUID document_ref so resolution is skipped and documents_get's envelope is exercised directly
    // (the l712 resolver only search-resolves a NON-UUID ref before the get).
    const { ctx } = makeCtx({
      executeTool: async () => ({ status: "pending_approval", approval_id: "ap-1" }),
    })
    await expect(
      shipmentDraftCreate(ctx, { document_ref: "11111111-2222-3333-4444-555555555555" }),
    ).rejects.toThrow(/pending_approval|approval/i)
  })

  it("raises a readable error (not a TypeError) when documents_get returns a malformed error envelope (BL-208)", async () => {
    // A runtime error envelope can omit `error` (violating the K4 type). The handler must surface a readable
    // error, NOT crash with "cannot read property 'message' of undefined" — which surfaced as
    // handler_outcome_unknown and false-failed the gated create_shipment (re-derives the draft post-approval).
    // A UUID ref so resolution is skipped and documents_get's error envelope is exercised directly.
    const { ctx } = makeCtx({ executeTool: async () => ({ status: "error" }) })
    const p = shipmentDraftCreate(ctx, { document_ref: "11111111-2222-3333-4444-555555555555" })
    await expect(p).rejects.toThrow(/documents_get failed/i)
    await expect(p).rejects.toThrow(/unknown error/i)
  })

  it("appends corrective guidance when document_ref is a number/reference, not a UUID (BL-228)", async () => {
    // The agent commonly passes the invoice NUMBER (e.g. "EMB-2026-00412") instead of its UUID id;
    // documents_get then fails opaquely and the agent gives up with a false "can't edit" claim. The
    // error must tell it to pass the id (UUID), found via invoicing:documents_search.
    const { ctx } = makeCtx({ executeTool: async () => ({ status: "error" }) })
    const p = shipmentDraftCreate(ctx, { document_ref: "EMB-2026-00412" })
    await expect(p).rejects.toThrow(/needs the invoice's id \(a UUID\)/i)
    await expect(p).rejects.toThrow(/documents_search/i)
    // A genuine UUID that fails gets NO corrective hint (the ref shape was fine — a real failure).
    const q = shipmentDraftCreate(ctx, {
      document_ref: "11111111-2222-3333-4444-555555555555",
    })
    await expect(q).rejects.not.toThrow(/needs the invoice's id/i)
  })

  it("raises a readable error (not a TypeError) when documents_get returns a completed-but-null result (BL-208)", async () => {
    // documents_get returns null for an invoice it cannot find (a wrong/foreign ref, or a non-existent
    // id) → the bridge yields { status: "completed", result: null }. Reading doc.id off the null result
    // otherwise threw "cannot read property 'id' of null" (handler_outcome_unknown) and false-failed the
    // gated create_shipment, which re-derives the draft post-approval. Must surface a readable error.
    const { ctx } = makeCtx({ executeTool: async () => ({ status: "completed", result: null }) })
    const p = shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    await expect(p).rejects.toThrow(/no invoicing document found/i)
    await expect(p).rejects.not.toThrow(/cannot read property/i)
    // A non-UUID ref on the not-found path gets the same corrective UUID-vs-number guidance (BL-228).
    const q = makeCtx({ executeTool: async () => ({ status: "completed", result: null }) })
    const r = shipmentDraftCreate(q.ctx, { document_ref: "EMB-2026-00412" })
    await expect(r).rejects.toThrow(/needs the invoice's id \(a UUID\)/i)
    await expect(r).rejects.toThrow(/documents_search/i)
  })

  it("no-invoice case throws a safe ToolError (code no_anchor_document, non-retryable) with proforma guidance", async () => {
    // A return/shipment draft must be anchored to an invoicing document. When the
    // order has no invoice (intra-EU sales often do not), the handler must throw
    // an app-sdk ToolError so the SAFE, actionable message survives untrusted-prod
    // redaction (see execute-tool-sandbox.test.ts for the boundary round-trip):
    // the agent then creates a 1 EUR proforma anchor instead of retrying the same
    // doomed call with different id formats (the ~15M-token runaway class).
    const { ctx } = makeCtx({ executeTool: async () => ({ status: "completed", result: null }) })
    let thrown: any
    try {
      await shipmentDraftCreate(ctx, { document_ref: "1846" })
      expect(true).toBe(false) // should not reach
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(ToolError)
    // The safe-surface marker fields the sandbox boundary + execute-tool read.
    expect(thrown.name).toBe("ToolError")
    expect(thrown.safe).toBe(true)
    expect(thrown.code).toBe("no_anchor_document")
    expect(thrown.retryable).toBe(false)
    // Actionable: it names the proforma anchor path so a weak model can recover.
    expect(thrown.message).toMatch(/proforma/i)
    expect(thrown.message).toMatch(/no commercial value/i)
  })

  it("auto-resolves a NON-UUID document_ref (invoice number / order reference) to the invoice UUID (l712)", async () => {
    // The l712 robustness fix: a flash-lite ROUTINE TICK very commonly passes the invoice NUMBER
    // ("EMB-2026-8201") or the Shopify ORDER reference ("#2357") as document_ref. documents_get resolves
    // only a UUID and 22P02s ("invalid input syntax for type uuid") on a number — a backend crash that
    // failed the order-check-prepare-shipment tick with "0 of 6 staged". shipment_draft_create now FIRST
    // resolves a non-UUID ref via documents_search → the invoice UUID, so the draft opens instead of
    // crashing. Mock: documents_search returns the invoice (whose id is a UUID), documents_get(id) returns
    // the full doc; the draft must succeed exactly as if the UUID had been passed.
    const docUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    const resolved = { ...INVOICE, id: docUuid, number: "EMB-2026-8201", status: "issued", shopify_order_id: "#2357" }
    const calls: { target: string; args: unknown }[] = []
    const executeTool = async (target: string, args: unknown) => {
      calls.push({ target, args })
      if (target === "invoicing:documents_search") return { status: "completed", result: [resolved] }
      // documents_get MISSES on the raw number (the pg 22P02 surfaced as an error envelope), and resolves
      // only when asked for the real UUID — so the draft succeeds ONLY via the search-resolve retry.
      const id = (args as { id?: string })?.id
      if (id === docUuid) return { status: "completed", result: resolved }
      return { status: "error", error: { code: "invalid_uuid", message: "invalid input syntax for type uuid" } }
    }
    const { ctx } = makeCtx({ executeTool })
    // Pass the invoice NUMBER (not the UUID).
    const draft = await shipmentDraftCreate(ctx, { document_ref: "EMB-2026-8201" })
    expect(draft.unresolved).toHaveLength(0)
    expect(draft.parcels).toHaveLength(1)
    // The resolver searched by the number, then documents_get was called with the resolved UUID.
    const search = calls.find((c) => c.target === "invoicing:documents_search")
    expect(search?.args).toMatchObject({ query: "EMB-2026-8201" })
    // The retry get (the LAST documents_get) is asked for the RESOLVED UUID; the first get (raw number)
    // missed and triggered the search-resolve.
    const gets = calls.filter((c) => c.target === "invoicing:documents_get")
    expect(gets[gets.length - 1]?.args).toMatchObject({ id: docUuid })
  })

  it("set_package marks requote and replaces the parcel set", async () => {
    const { ctx } = makeCtx()
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    const updated = shipmentDraftSetPackage(draft, { override: { length: 50, width: 50, height: 50, weight: 9 } })
    expect(updated.parcels[0]).toMatchObject({ length: 50, weight: 9 })
    expect(updated.requote).toBe(true)
  })

  it("set_customs overrides an article without touching the source", () => {
    const draft = { document_ref: "d", parcels: [], customsArticles: [{ line_id: "l", description: "x", quantity: 1, unitWeight: 1, unitValue: { value: 1, currency: "EUR" }, originCountry: "FR", tariffNumber: "1" }], unresolved: [], recipient: "", route: "" } as any
    const updated = shipmentDraftSetCustoms(draft, { index: 0, patch: { description: "New" } })
    expect(updated.customsArticles[0]!.description).toBe("New")
    expect(draft.customsArticles[0]!.description).toBe("x")
  })
})

describe("draft overrides reach the create body (I1)", () => {
  it("a persisted package override replaces the parcel set at create time", async () => {
    const { ctx, fetchCalls } = makeCtx()
    // Operator overrides to an ad-hoc carton via the persisting handler.
    await shipmentDraftSetPackagePersist(ctx, {
      draft_id: "doc-1",
      override: { length: 80, width: 40, height: 40, weight: 12 },
    })
    // The re-derived draft reflects the persisted override.
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.parcels).toHaveLength(1)
    expect(draft.parcels[0]).toMatchObject({ length: 80, weight: 12 })

    await createShipment(ctx, {
      draft_id: "doc-1",
      offer_code: "CHRP-Chrono18",
      recipient_phone: "+12125550100",
      recipient_address: RECIPIENT_ADDRESS,
    })
    const post = fetchCalls.find((c) => c.url.endsWith("/shipping-order") && c.method === "POST")!
    const body = JSON.parse(post.body!) as { shipment: { packages: Array<{ length: number; weight: number }> } }
    expect(body.shipment.packages[0]).toMatchObject({ length: 80, weight: 12 })
  })

  it("a MULTI-carton override (array + quantity) persists ALL parcels and every colis reaches the Boxtal create body", async () => {
    const { ctx, fetchCalls } = makeCtx()
    // A dealer-style mixed load: 6 master cartons + 1 + 2 = 9 colis, ONE call.
    // set_package used to collapse to a single carton; a real multi-box shipment must
    // reach the carrier as N packages, not one.
    await shipmentDraftSetPackagePersist(ctx, {
      draft_id: "doc-1",
      override: [
        { length: 62, width: 39, height: 36, weight: 20, quantity: 6 },
        { length: 62, width: 39, height: 22, weight: 7 },
        { length: 62, width: 39, height: 42, weight: 14, quantity: 2 },
      ],
    })
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.parcels).toHaveLength(9)
    expect(draft.parcels.filter((p) => p.weight === 20)).toHaveLength(6)
    expect(draft.parcels.filter((p) => p.weight === 7)).toHaveLength(1)
    expect(draft.parcels.filter((p) => p.weight === 14)).toHaveLength(2)

    await createShipment(ctx, {
      draft_id: "doc-1",
      offer_code: "CHRP-Chrono18",
      recipient_phone: "+12125550100",
      recipient_address: RECIPIENT_ADDRESS,
    })
    const post = fetchCalls.find((c) => c.url.endsWith("/shipping-order") && c.method === "POST")!
    const body = JSON.parse(post.body!) as { shipment: { packages: Array<{ weight: number }> } }
    expect(body.shipment.packages).toHaveLength(9)
    expect(body.shipment.packages.filter((p) => p.weight === 20)).toHaveLength(6)
  })

  it("price oracle: rejects the buy when the live price ROSE more than 5% above the approved quoted_price_ttc, with a restage patch at the new price", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    // The kernel re-runs an approved call with ctx.approval set.
    ;(ctx as { approval?: unknown }).approval = {
      approvalRequestId: "req-1",
      approvalDeciderId: "user-1",
      toolName: "boxtal:create_shipment",
    }
    // Mock cotation prices CHRP-Chrono18 at 9.36 TTC; the approval carried 8.00 (a +17% raise).
    const res = await createShipment(ctx, { ...CREATE_INPUT, quoted_price_ttc: 8.0 })
    expect("error" in res && res.error?.code).toBe("price_increased")
    expect("error" in res && res.error?.message).toMatch(/9\.36/)
    expect("error" in res && res.error?.message).toMatch(/8\.00/)
    expect("error" in res && res.error?.message).toContain("The approval is re-staged at the new price")
    // The soft error carries the payload patch the kernel applies when re-staging the
    // reverted approval, so the re-staged card quotes the CURRENT price.
    expect(
      "error" in res &&
        (res.error as { restage_payload_patch?: Record<string, unknown> }).restage_payload_patch,
    ).toEqual({ quoted_price_ttc: 9.36 })
    // Rejected BEFORE reserving or buying.
    expect(db.__all("shipment")).toHaveLength(0)
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(false)
  })

  it("price oracle: a direct Ship click (no approval) is told to re-quote, never that an approval was re-staged", async () => {
    // Someone who may approve clicks Ship: the gate is skipped, so no approval exists.
    // The row shows this message verbatim (PrepGrid runMutation -> setRowError).
    const { ctx, db } = makeCtx()
    const res = await createShipment(ctx, { ...CREATE_INPUT, quoted_price_ttc: 8.0 })
    expect("error" in res && res.error?.code).toBe("price_increased")
    const message = ("error" in res && res.error?.message) || ""
    const shown: Array<string | null> = []
    const { createRunMutation } = await import("./ui/prep-row-logic")
    const runMutation = createRunMutation({
      setRowError: (_key: string, text: string | null) => shown.push(text),
      refetch: async () => {},
      patchRow: async () => {},
    } as never)
    // The host client throws the server message for a non 2xx answer.
    await runMutation("ship", "order-1", async () => {
      throw new Error(message)
    })
    const rendered = shown[shown.length - 1]
    expect(rendered).toBe(
      "The live price for CHRP-Chrono18 is now 9.36 EUR TTC, up 17% from the quoted 8.00. Nothing was bought. " +
        "Re-quote this shipment to confirm the new price, then ship it again to buy at 9.36 EUR.",
    )
    expect(rendered).not.toMatch(/approv/i)
    expect(rendered).not.toMatch(/[\u2013\u2014]|--/)
    expect(db.__all("shipment")).toHaveLength(0)
  })

  it("price oracle: a live price LOWER than approved buys normally (the buyer only ever pays less)", async () => {
    const { ctx, fetchCalls } = makeCtx()
    // Approved at 20.00, live is 9.36: cheaper, execute.
    const res = await createShipment(ctx, { ...CREATE_INPUT, quoted_price_ttc: 20.0 })
    expect("error" in res).toBe(false)
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(true)
  })

  it("price oracle: a raise WITHIN 5% still buys (tolerance band)", async () => {
    const { ctx, fetchCalls } = makeCtx()
    // Approved at 9.00, live is 9.36 (+4%): within tolerance, execute.
    const res = await createShipment(ctx, { ...CREATE_INPUT, quoted_price_ttc: 9.0 })
    expect("error" in res).toBe(false)
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(true)
  })

  it("price oracle: a matching quoted_price_ttc buys normally", async () => {
    const { ctx, fetchCalls } = makeCtx()
    const res = await createShipment(ctx, { ...CREATE_INPUT, quoted_price_ttc: 9.36 })
    expect("error" in res).toBe(false)
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(true)
  })

  it("a persisted customs override reaches the create body", async () => {
    const { ctx, fetchCalls } = makeCtx()
    await shipmentDraftSetCustomsPersist(ctx, {
      draft_id: "doc-1",
      index: 0,
      patch: { description: "Hand-edited customs description" },
    })
    await createShipment(ctx, {
      draft_id: "doc-1",
      offer_code: "CHRP-Chrono18",
      recipient_phone: "+12125550100",
      recipient_address: RECIPIENT_ADDRESS,
    })
    const post = fetchCalls.find((c) => c.url.endsWith("/shipping-order") && c.method === "POST")!
    const body = JSON.parse(post.body!) as { shipment: { customsDeclaration: { articles: Array<{ description: string }> } } }
    expect(body.shipment.customsDeclaration.articles[0]!.description).toBe("Hand-edited customs description")
  })
})

// A created order must carry a collection date (expectedTakingOverDate) so Boxtal
// BOOKS the carrier pickup — the label-only order (no date) never scheduled a
// collection, so on-premise carriers (FedEx/UPS/DHL/Chronopost home) never came.
// MULTI_XML quotes CHRP-Chrono18 with <collection><date>2026-06-01</date>.
describe("create_shipment schedules the carrier pickup (expectedTakingOverDate)", () => {
  it("forwards the chosen offer's Boxtal collection_date as the order pickup date", async () => {
    const { ctx, fetchCalls } = makeCtx()
    const res = await createShipment(ctx, CREATE_INPUT)
    expect("error" in res).toBe(false)
    const post = fetchCalls.find((c) => c.url.endsWith("/shipping-order") && c.method === "POST")!
    const body = JSON.parse(post.body!) as { expectedTakingOverDate?: string }
    // The offer's collection_date from the pre-buy re-quote (MULTI_XML) — without
    // the fix this key is absent and Boxtal books no pickup.
    expect(body.expectedTakingOverDate).toBe("2026-06-01")
  })

  it("an explicit collection_date input overrides the offer's proposed date", async () => {
    const { ctx, fetchCalls } = makeCtx()
    const res = await createShipment(ctx, { ...CREATE_INPUT, collection_date: "2026-06-09" })
    expect("error" in res).toBe(false)
    const post = fetchCalls.find((c) => c.url.endsWith("/shipping-order") && c.method === "POST")!
    const body = JSON.parse(post.body!) as { expectedTakingOverDate?: string }
    expect(body.expectedTakingOverDate).toBe("2026-06-09")
  })

  it("rejects a malformed collection_date before reserving or buying", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    const res = await createShipment(ctx, { ...CREATE_INPUT, collection_date: "09/06/2026" })
    expect("error" in res && res.error?.code).toBe("validation")
    expect(db.__all("shipment")).toHaveLength(0)
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(false)
  })
})

// Regression for boxtal-multi-carton-pack-override-bundle: set_package must accept a NAMED-PACK
// REFERENCE (`override.pack`) and resolve the carton dims from the catalog server-side — the agent
// references "STUDIO-BOX" by name and never re-keys (or invents) its dimensions (the rubric FAILS on
// invented dims). Before the fix, the override schema/handler only took raw {length,width,height,weight},
// forcing the weak model to copy the pack's dims by hand (fragile) — a `{pack}` ref was silently dropped.
describe("set_package — named-pack reference (multi-carton override)", () => {
  // makeCtx seeds the V1 profile (the single auto-resolved parcel) PLUS a named STUDIO-BOX pack carrying
  // the authoritative dims so a `{pack:"STUDIO-BOX"}` override resolves them from the catalog.
  function makeCtxWithPack() {
    const db = createMockDb({
      seed: {
        shipping_profile: [
          { id: "p1", product_source: "shopify", product_id: "V1", unit_weight: 0.5, solo_length: 30, solo_width: 20, solo_height: 10, content_category: "content:v1:10120" },
        ],
        pack: [
          { id: "pack-studio", name: "STUDIO-BOX", length: 60, width: 42, height: 34, gross_weight: 6.8, content_category: "content:v1:10250" },
        ],
        app_config: [{ id: "cfg-sender", key: "sender_address", value: SENDER_PARTY }],
      },
    })
    const fetchCalls: Array<{ url: string; method: string; body?: string }> = []
    const fetch = async (url: string, o?: { method?: string; body?: string }) => {
      const method = o?.method ?? "GET"
      fetchCalls.push({ url, method, body: o?.body })
      if (url.includes("/iam/account-app/token")) return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
      if (url.includes("/cotation")) return { status: 200, headers: {}, body: MULTI_XML }
      if (url.includes("/shipping-order")) return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: { id: "ord-1", status: "PENDING", deliveryPriceExclTax: { value: 7.8, currency: "EUR" } } }) }
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
    }
    const ctx = {
      orgId: "org-1",
      db,
      fetch,
      executeTool: async (_t: string, _a: unknown) => ({ status: "completed", result: INVOICE }),
      connections: { boxtal: { getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }), getToken: async () => { throw new Error("no") }, getAccounts: async () => [] } },
      config: { get: async () => "whsecret", has: async () => true },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    } as any
    return { ctx, db, fetchCalls }
  }

  it("resolves a `{pack}` reference (by name) to the catalog pack's dims — agent never supplies dims", async () => {
    const { ctx } = makeCtxWithPack()
    const updated = await shipmentDraftSetPackagePersist(ctx, {
      draft_id: "doc-1",
      override: { pack: "STUDIO-BOX" },
    })
    // ONE parcel, dims/weight straight from the STUDIO-BOX catalog row — NOT supplied by the caller.
    expect(updated.parcels).toHaveLength(1)
    expect(updated.parcels[0]).toMatchObject({ length: 60, width: 42, height: 34, weight: 6.8 })
    expect(updated.requote).toBe(true)
  })

  it("matches a pack reference case-insensitively and by id", async () => {
    const lower = makeCtxWithPack()
    const byLower = await shipmentDraftSetPackagePersist(lower.ctx, { draft_id: "doc-1", override: { pack: "studio-box" } })
    expect(byLower.parcels[0]).toMatchObject({ length: 60, weight: 6.8 })
    const byId = makeCtxWithPack()
    const byPackId = await shipmentDraftSetPackagePersist(byId.ctx, { draft_id: "doc-1", override: { pack: "pack-studio" } })
    expect(byPackId.parcels[0]).toMatchObject({ length: 60, weight: 6.8 })
  })

  it("the resolved pack carton reaches the create body as a single parcel", async () => {
    const { ctx, fetchCalls } = makeCtxWithPack()
    await shipmentDraftSetPackagePersist(ctx, { draft_id: "doc-1", override: { pack: "STUDIO-BOX" } })
    await createShipment(ctx, {
      draft_id: "doc-1",
      offer_code: "CHRP-Chrono18",
      recipient_phone: "+12125550100",
      recipient_address: RECIPIENT_ADDRESS,
    })
    const post = fetchCalls.find((c) => c.url.endsWith("/shipping-order") && c.method === "POST")!
    const body = JSON.parse(post.body!) as { shipment: { packages: Array<{ length: number; weight: number }> } }
    expect(body.shipment.packages).toHaveLength(1)
    expect(body.shipment.packages[0]).toMatchObject({ length: 60, weight: 6.8 })
  })

  it("throws a recoverable error (listing available packs) when the pack ref names no pack", async () => {
    const { ctx } = makeCtxWithPack()
    await expect(
      shipmentDraftSetPackagePersist(ctx, { draft_id: "doc-1", override: { pack: "NOPE-BOX" } }),
    ).rejects.toThrow(/no pack "NOPE-BOX".*STUDIO-BOX/s)
  })

  it("still supports a raw ad-hoc carton override (backward compatible)", async () => {
    const { ctx } = makeCtxWithPack()
    const updated = await shipmentDraftSetPackagePersist(ctx, {
      draft_id: "doc-1",
      override: { length: 80, width: 40, height: 40, weight: 12 },
    })
    expect(updated.parcels[0]).toMatchObject({ length: 80, weight: 12 })
    expect(updated.requote).toBe(true)
  })
})

describe("EU-domestic customs omission (I2)", () => {
  const EU_INVOICE = {
    ...INVOICE,
    counterparty_country: "DE",
    lines: [{ ...INVOICE.lines[0], hs_code: null, country_of_origin: null }],
  }

  it("an intra-EU (FR→DE) route omits the customs declaration entirely", async () => {
    const { ctx, fetchCalls } = makeCtx({
      executeTool: async () => ({ status: "completed", result: EU_INVOICE }),
    })
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.customs_required).toBe(false)
    expect(draft.customsArticles).toHaveLength(0)

    await createShipment(ctx, {
      draft_id: "doc-1",
      offer_code: "CHRP-Chrono18",
      recipient_phone: "+4915112345678",
      recipient_address: { ...RECIPIENT_ADDRESS, countryIsoCode: "DE", postalCode: "10115", city: "Berlin", street: "Unter den Linden 1" },
    })
    const post = fetchCalls.find((c) => c.url.endsWith("/shipping-order") && c.method === "POST")!
    const body = JSON.parse(post.body!) as { shipment: { customsDeclaration?: unknown } }
    expect(body.shipment.customsDeclaration).toBeUndefined()
  })

  it("a FR→US route attaches a customs declaration", async () => {
    const { ctx } = makeCtx()
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.customs_required).toBe(true)
    expect(draft.customsArticles.length).toBeGreaterThan(0)
  })
})

/** The standard valid create input — complete recipient address + phone. */
describe("async label output — awaiting_output + poll (0.3.0)", () => {
  const LABEL_DOCS = JSON.stringify({
    status: 200,
    timestamp: "t",
    content: [{ type: "LABEL", format: "PDF", url: "https://document.boxtal.com/label.pdf" }],
  })

  it("createShipment records started + awaiting_output with the external ref when the label is not ready", async () => {
    const recorded: Array<{ fn: string; args: unknown[] }> = []
    const { ctx, db } = makeCtx() // documentsBody defaults to EMPTY -> label not ready
    ;(ctx as any).approval_recordStarted = async (t: string) => {
      recorded.push({ fn: "started", args: [t] })
    }
    ;(ctx as any).approval_recordAwaitingOutput = async (t: string, refJson?: string) => {
      recorded.push({ fn: "awaiting", args: [t, refJson] })
    }
    const res = await createShipment(ctx, CREATE_INPUT)
    expect("error" in res).toBe(false)
    expect((res as { label_file_id: string | null }).label_file_id).toBeNull()
    expect(recorded.map((r) => r.fn)).toEqual(["started", "awaiting"])
    const ref = JSON.parse(recorded[1]!.args[1] as string)
    expect(ref.boxtal_order_id).toBe("ord-1")
    expect(typeof ref.shipment_row_id).toBe("string")
    expect(db.__all("shipment")).toHaveLength(1)
  })

  it("createShipment does NOT record awaiting when the label imported inline", async () => {
    const recorded: string[] = []
    const { ctx } = makeCtx({
      documentsBody: LABEL_DOCS,
      filesImportFromUrl: async () => JSON.stringify({ id: "file-label-1" }),
    })
    ;(ctx as any).approval_recordStarted = async () => {
      recorded.push("started")
    }
    ;(ctx as any).approval_recordAwaitingOutput = async () => {
      recorded.push("awaiting")
    }
    const res = await createShipment(ctx, CREATE_INPUT)
    expect((res as { label_file_id: string | null }).label_file_id).toBe("file-label-1")
    expect(recorded).toEqual([])
  })

  it("pollCreateShipmentOutput: not ready -> {ready:false}; ready -> full outputs incl label_file_id", async () => {
    // Seed a shipment row like a created order left behind.
    const notReady = makeCtx()
    await notReady.db.insert("shipment", {
      id: "row-1",
      boxtal_order_id: "ord-1",
      order_status: "PENDING",
      tracking_number: null,
    })
    const r1 = await pollCreateShipmentOutput(notReady.ctx, {
      external_ref: { shipment_row_id: "row-1", boxtal_order_id: "ord-1" },
    })
    expect(r1.ready).toBe(false)

    const ready = makeCtx({
      documentsBody: LABEL_DOCS,
      filesImportFromUrl: async () => JSON.stringify({ id: "file-label-2" }),
    })
    await ready.db.insert("shipment", {
      id: "row-1",
      boxtal_order_id: "ord-1",
      order_status: "PENDING",
      tracking_number: null,
    })
    const r2 = await pollCreateShipmentOutput(ready.ctx, {
      external_ref: { shipment_row_id: "row-1", boxtal_order_id: "ord-1" },
    })
    expect(r2.ready).toBe(true)
    expect(r2.result).toMatchObject({
      boxtal_order_id: "ord-1",
      label_file_id: "file-label-2",
      tracking_number: "TRK1",
    })
  })

  it("pollCreateShipmentOutput without a usable external_ref stays not-ready (never throws)", async () => {
    const { ctx } = makeCtx()
    expect((await pollCreateShipmentOutput(ctx, { external_ref: null })).ready).toBe(false)
    expect((await pollCreateShipmentOutput(ctx, {})).ready).toBe(false)
  })
})

describe("stage-time party completeness (0.2.11)", () => {
  it("preflight rejects with the precise missing fields instead of staging a doomed approval", async () => {
    const { ctx } = makeCtx()
    const res = await createShipmentPreflight(ctx, {
      draft_id: "doc-1",
      offer_code: "CHRP-Chrono18",
      quoted_price_ttc: 9.36,
      // No phone, no email, no street/postal — the doomed-staging class.
      recipient_address: { name: "Patrick Schmutz", city: "Konstanz", countryIsoCode: "DE" },
    })
    expect("error" in res && res.error.code).toBe("recipient_address_required")
    expect("error" in res && res.error.message).toMatch(/missing: .*(phone|email|street|postalCode)/)
  })
})

describe("normalizeRecipientAddress — alias-dialect tolerance", () => {
  it("folds zip/address1/countryCode (the Shopify dialect models emit) onto canonical fields", () => {
    const n = normalizeRecipientAddress({
      name: "Patrick Schmutz",
      city: "Konstanz",
      // biome-ignore lint/suspicious/noExplicitAny: exercising the alias dialect
      ...( { zip: "78462", address1: "Schottenstr. 73", address2: null, country: "Germany", countryCode: "DE" } as any),
    })!
    expect(n.street).toBe("Schottenstr. 73")
    expect(n.postalCode).toBe("78462")
    expect(n.countryIsoCode).toBe("DE")
    expect(n.city).toBe("Konstanz")
    expect(n.name).toBe("Patrick Schmutz")
  })

  it("canonical fields win over aliases; blanks fall through", () => {
    const n = normalizeRecipientAddress({
      street: "1 rue de Rivoli",
      postalCode: "75001",
      countryIsoCode: "FR",
      // biome-ignore lint/suspicious/noExplicitAny: exercising the alias dialect
      ...( { zip: "99999", address1: "wrong st", countryCode: "US" } as any),
    })!
    expect(n.street).toBe("1 rue de Rivoli")
    expect(n.postalCode).toBe("75001")
    expect(n.countryIsoCode).toBe("FR")
  })

  it("execution accepts an alias-dialect address end-to-end (the prod recipient_address_required class)", async () => {
    const { ctx, fetchCalls } = makeCtx()
    const res = await createShipment(ctx, {
      ...CREATE_INPUT,
      // biome-ignore lint/suspicious/noExplicitAny: exercising the alias dialect
      recipient_address: { name: "Patrick Schmutz", city: "Konstanz", zip: "78462", address1: "Schottenstr. 73", countryCode: "DE" } as any,
    })
    expect("error" in res).toBe(false)
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(true)
  })
})

const CREATE_INPUT = {
  draft_id: "doc-1",
  offer_code: "CHRP-Chrono18",
  recipient_phone: "+12125550100",
  recipient_address: RECIPIENT_ADDRESS,
  // Mock cotation prices CHRP-Chrono18 at 9.36 EUR TTC — the price the
  // approval card shows and the execution oracle re-checks.
  quoted_price_ttc: 9.36,
}

// Regression (prod 2026-08-04): five creates failed with Boxtal's
// InvalidPaymentException and the operator saw only a raw 422 body. That is an
// ACCOUNT-level refusal (deferred-payment ceiling / invalid mandate), not a
// problem with the shipment, and the message must say so and name the remedy.
describe("createShipment maps Boxtal InvalidPaymentException to an actionable error", () => {
  const PAYMENT_422 = JSON.stringify({
    timestamp: "2026-08-04T18:55:17.538413+02:00",
    status: 422,
    errors: [{ code: "InvalidPaymentException", parameters: null }],
  })

  it("names the account, the remedy, and that nothing was bought", async () => {
    const { ctx } = makeCtx({ v3Status: 422, v3Body: PAYMENT_422 })
    const res = (await createShipment(ctx, CREATE_INPUT)) as { error?: { code?: string; message?: string } }
    expect(res.error?.code).toBe("boxtal_account_payment_blocked")
    const msg = res.error?.message ?? ""
    expect(msg).toContain("encours")
    expect(msg).toContain("Nothing was bought")
    // Must not read as "your shipment is malformed".
    expect(msg).toContain("not because of anything in this shipment")
    // House style: no dash punctuation in operator-facing copy.
    expect(msg).not.toMatch(/[—–]|--/)
  })

  it("does not swallow other 422s into the payment branch", async () => {
    const other = JSON.stringify({
      status: 422,
      errors: [{ code: "RequestValidationException", parameters: [{ code: "V1" }] }],
    })
    const { ctx } = makeCtx({ v3Status: 422, v3Body: other })
    const res = (await createShipment(ctx, CREATE_INPUT)) as { error?: { code?: string } }
    expect(res.error?.code).not.toBe("boxtal_account_payment_blocked")
  })
})

// STANDING ORACLE (wiring half) — "never ship a refunded product".
// order-shippability.test.ts pins the predicate; this pins that createShipment
// actually CONSULTS it, and refuses BEFORE any outbound POST. Prod 2026-08-05:
// refunded+cancelled order #3320 sat in the to-prepare worklist.
describe("createShipment refuses a refunded or cancelled order", () => {
  function ctxWithOrderState(state: { financial_status?: string; cancelled_at?: string }) {
    const made = makeCtx()
    // Seed the cached refund/cancel facts the guard reads first.
    made.ctx.db.insert("prep_meta", {
      document_ref: "doc-1",
      order_name: "#3320",
      shopify_order_id: "13004464685387",
      ...state,
    })
    return made
  }

  it("refuses a REFUNDED order and buys nothing", async () => {
    const { ctx, fetchCalls } = ctxWithOrderState({ financial_status: "REFUNDED" })
    const res = await createShipment(ctx, CREATE_INPUT)
    expect((res as { error?: { code?: string } }).error?.code).toBe("order_refunded")
    expect((res as { error?: { message?: string } }).error?.message).toContain("#3320")
    // The money-spending call must never have been made.
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(false)
  })

  it("refuses a CANCELLED order and buys nothing", async () => {
    const { ctx, fetchCalls } = ctxWithOrderState({
      financial_status: "PAID",
      cancelled_at: "2026-08-04T10:00:00Z",
    })
    const res = await createShipment(ctx, CREATE_INPUT)
    expect((res as { error?: { code?: string } }).error?.code).toBe("order_cancelled")
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(false)
  })

  // Control: the guard must not block ordinary shipping.
  it("does NOT refuse a normal paid order", async () => {
    const { ctx } = ctxWithOrderState({ financial_status: "PAID" })
    const res = await createShipment(ctx, CREATE_INPUT)
    expect((res as { error?: { code?: string } }).error?.code).not.toBe("order_refunded")
    expect((res as { error?: { code?: string } }).error?.code).not.toBe("order_cancelled")
  })
})

// Prod 2026-09: all 62 shipment rows carried a blank external_id, so the
// merchant order reference never showed up anywhere the local row is read
// (only the value SENT to Boxtal on the create body was ever right).
describe("createShipment persists external_id on the local shipment row", () => {
  it("stores the Shopify order name (from prep_meta) as external_id when the caller supplies none", async () => {
    const { ctx, db } = makeCtx()
    db.insert("prep_meta", { document_ref: "doc-1", order_name: "#3320" })
    const res = await createShipment(ctx, CREATE_INPUT)
    expect("error" in res).toBe(false)
    const rows = db.__all("shipment")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.external_id).toBe("#3320")
  })

  it("stores the caller-supplied external_id when given, overriding the order name", async () => {
    const { ctx, db } = makeCtx()
    db.insert("prep_meta", { document_ref: "doc-1", order_name: "#3320" })
    const res = await createShipment(ctx, { ...CREATE_INPUT, external_id: "PO-9981" })
    expect("error" in res).toBe(false)
    const rows = db.__all("shipment")
    expect(rows[0]!.external_id).toBe("PO-9981")
  })
})

/** Parse the body of the single /shipping-order POST. */
function orderPostBody(fetchCalls: Array<{ url: string; method: string; body?: string }>) {
  const post = fetchCalls.find((c) => c.url.endsWith("/shipping-order") && c.method === "POST")
  if (!post?.body) throw new Error("no /shipping-order POST captured")
  return JSON.parse(post.body) as {
    shipment: {
      fromAddress: { contact: { phone: string }; location: { countryIsoCode: string; postalCode: string; street: string; city: string } }
      toAddress: { contact: { phone: string }; location: { countryIsoCode: string; postalCode: string; street: string; city: string } }
      customsDeclaration?: { articles: Array<{ description: string; unitWeight: number }> }
      packages: Array<{ value: { value: number } }>
    }
  }
}

describe("create_shipment (gated body)", () => {
  it("reserves, POSTs once, finalizes, backfills tracking, returns link summary", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    const res = await createShipment(ctx, CREATE_INPUT)
    const orderPosts = fetchCalls.filter((c) => c.url.endsWith("/shipping-order") && c.method === "POST")
    expect(orderPosts).toHaveLength(1)
    const row = db.__all("shipment").find((r) => r.document_ref === "doc-1")!
    expect(row.link_state).toBe("created")
    expect(row.order_status).toBe("PENDING")
    expect(row.boxtal_order_id).toBe("ord-1")
    expect(row.tracking_number).toBe("TRK1")
    expect(res).toMatchObject({ boxtal_order_id: "ord-1", order_status: "PENDING" })
  })

  it("POSTs a REAL recipient + sender address and the supplied phone (B1)", async () => {
    const { ctx, fetchCalls } = makeCtx()
    await createShipment(ctx, CREATE_INPUT)
    const body = orderPostBody(fetchCalls)
    // Recipient — never empty placeholders.
    expect(body.shipment.toAddress.location.countryIsoCode).toBe("US")
    expect(body.shipment.toAddress.location.postalCode).toBe("10118")
    expect(body.shipment.toAddress.location.street).toBe("350 5th Ave")
    expect(body.shipment.toAddress.contact.phone).toBe("+12125550100")
    // Sender — assembled from the persisted ship-from config.
    expect(body.shipment.fromAddress.location.countryIsoCode).toBe("FR")
    expect(body.shipment.fromAddress.location.postalCode).toBe("75001")
    expect(body.shipment.fromAddress.contact.phone).toBe("+33123456789")
    // Customs is attached on this FR→US route, with real article values.
    expect(body.shipment.customsDeclaration).toBeDefined()
    expect(body.shipment.customsDeclaration!.articles[0]!.unitWeight).toBe(0.5)
    // Each parcel carries a non-zero declared value.
    expect(body.shipment.packages[0]!.value.value).toBeGreaterThan(0)
  })

  it("recipient_phone param overrides the address phone in the POST body", async () => {
    const { ctx, fetchCalls } = makeCtx()
    await createShipment(ctx, {
      draft_id: "doc-1",
      offer_code: "CHRP-Chrono18",
      recipient_phone: "+12120009999",
      recipient_address: { ...RECIPIENT_ADDRESS, phone: "+10000000000" },
    })
    expect(orderPostBody(fetchCalls).shipment.toAddress.contact.phone).toBe("+12120009999")
  })

  it("HARD-FAILS (no POST) when the recipient address is incomplete", async () => {
    const { ctx, fetchCalls } = makeCtx()
    const res = await createShipment(ctx, {
      draft_id: "doc-1",
      offer_code: "CHRP-Chrono18",
      recipient_phone: "+12125550100",
      recipient_address: { name: "Acme", countryIsoCode: "US" }, // no street/city/postal
    })
    expect(res.error?.code).toBe("recipient_address_required")
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(false)
  })

  // BL-242 regression: when the linked contact carries a stored shipping address and the agent passes
  // NO recipient_address, the draft pre-fills it from the contact (kernel:contacts_read →
  // metadata.shipping_address) so the gated create resolves + POSTs — instead of erroring
  // recipient_address_required on approval. This is what lets the carrier-reroute scenario's auto-
  // approved create_shipment EXECUTE without the operator re-keying an on-file address.
  it("pre-fills the recipient address from the linked contact when the agent passes none (BL-242)", async () => {
    const executeTool = async (target: string, _args: unknown) => {
      if (target === "kernel:contacts_read") {
        return {
          status: "completed",
          result: {
            contact: {
              id: "contact-1",
              name: "Acme Corp",
              phone: "+33123456701",
              metadata: {
                shipping_address: {
                  name: "Acme Corp",
                  street: "12 Rue du Faubourg",
                  city: "Paris",
                  postalCode: "75011",
                  countryIsoCode: "FR",
                  phone: "+33123456701",
                },
              },
            },
          },
        }
      }
      // FR→FR domestic invoice → no customs (keeps the create body simple).
      return { status: "completed", result: { ...INVOICE, counterparty_country: "FR" } }
    }
    const { ctx, fetchCalls } = makeCtx({ executeTool })
    // NOTE: no recipient_address / recipient_phone on the input — the pre-fill must supply them.
    const res = await createShipment(ctx, { draft_id: "doc-1", offer_code: "CHRP-Chrono18" })
    expect(res.error).toBeUndefined()
    const body = orderPostBody(fetchCalls)
    expect(body.shipment.toAddress.location.street).toBe("12 Rue du Faubourg")
    expect(body.shipment.toAddress.location.city).toBe("Paris")
    expect(body.shipment.toAddress.location.postalCode).toBe("75011")
    expect(body.shipment.toAddress.location.countryIsoCode).toBe("FR")
    expect(body.shipment.toAddress.contact.phone).toBe("+33123456701")
  })

  it("HARD-FAILS (no POST) when no sender address is configured", async () => {
    const { ctx, fetchCalls } = makeCtx({ noSender: true })
    const res = await createShipment(ctx, CREATE_INPUT)
    expect(res.error?.code).toBe("sender_address_required")
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(false)
  })

  it("a second (sequential) approval after the first commits is refused by the partial-unique — zero extra POSTs", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    await createShipment(ctx, CREATE_INPUT)
    const postsAfterFirst = fetchCalls.filter((c) => c.url.endsWith("/shipping-order") && c.method === "POST").length
    const res2 = await createShipment(ctx, CREATE_INPUT)
    const postsAfterSecond = fetchCalls.filter((c) => c.url.endsWith("/shipping-order") && c.method === "POST").length
    expect(postsAfterSecond).toBe(postsAfterFirst) // no extra POST
    expect(res2.error).toBeDefined()
    expect(db.__all("shipment")).toHaveLength(1)
  })

  it("two truly concurrent approvals (Promise.all) → exactly one POST", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    // The MockDb's check-then-insert is NOT atomic, so to exercise the durable
    // `document_ref` partial-unique guarantee (which the REAL Postgres index
    // enforces) we wrap `insert` to reject a duplicate live shipment row — the
    // exact failure mode `reserveCreate`'s check-then-insert relies on. This is
    // the app-local backstop the spec (§C.3) names as the authoritative
    // "exactly one v3 order per draft" guarantee.
    const realInsert = db.insert.bind(db)
    db.insert = async (entity, data) => {
      if (entity === "shipment" && data.document_ref) {
        const live = db
          .__all("shipment")
          .some((r) => r.document_ref === data.document_ref && r.order_status !== "CANCELLED")
        if (live) throw new Error("duplicate document_ref (partial-unique)")
      }
      return realInsert(entity, data)
    }
    const results = await Promise.all([
      createShipment(ctx, CREATE_INPUT),
      createShipment(ctx, CREATE_INPUT),
    ])
    const posts = fetchCalls.filter((c) => c.url.endsWith("/shipping-order") && c.method === "POST")
    expect(posts).toHaveLength(1)
    // exactly one succeeded, one refused.
    expect(results.filter((r) => r.error == null)).toHaveLength(1)
    expect(results.filter((r) => r.error != null)).toHaveLength(1)
  })

  it("a create 5xx → markUncertain (row kept), returns an error envelope", async () => {
    const { ctx, db } = makeCtx({ v3Status: 503 })
    const res = await createShipment(ctx, CREATE_INPUT)
    expect(res.error).toBeDefined()
    const row = db.__all("shipment").find((r) => r.document_ref === "doc-1")!
    expect(row.link_state).toBe("create_uncertain")
  })

  it("a 422 phone validation → precise error AND releases the reservation (M5)", async () => {
    const { ctx, db } = makeCtx({ v3Status: 422, v3Body: JSON.stringify({ code: "ValidationException.Phone", message: "invalid phone" }) })
    const res = await createShipment(ctx, CREATE_INPUT)
    expect(res.error?.message).toMatch(/recipient phone invalid/i)
    // A deterministic 422 releases the reservation so a corrected retry can proceed.
    expect(db.__all("shipment")).toHaveLength(0)
  })

  it("refuses when unresolved lines are present", async () => {
    const { ctx } = makeCtx({
      executeTool: async () => ({
        status: "completed",
        result: { ...INVOICE, lines: [{ ...INVOICE.lines[0], external_id: "GHOST" }] },
      }),
    })
    const res = await createShipment(ctx, CREATE_INPUT)
    expect(res.error?.code).toBe("unresolved_lines")
  })
})

describe("create_shipment — return (reverse) flow", () => {
  function bodyOf(fetchCalls: Array<{ url: string; method: string; body?: string }>) {
    const post = fetchCalls.find((c) => c.url.endsWith("/shipping-order") && c.method === "POST")
    if (!post?.body) throw new Error("no /shipping-order POST captured")
    return JSON.parse(post.body) as {
      shipment: {
        fromAddress: { location: { countryIsoCode: string } }
        toAddress: { location: { countryIsoCode: string } }
        customsDeclaration?: { reason: string }
      }
    }
  }

  it("swaps from/to (customer→us), sets customs reason RETURN, and stamps the row kind=return", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    const res = await createShipment(ctx, {
      ...CREATE_INPUT,
      is_return: true,
      return_reason: "Defective unit",
      created_by: "agent",
    })
    expect(res.boxtal_order_id).toBe("ord-1")
    const body = bodyOf(fetchCalls)
    // Reversed addressing: the parcel ships FROM the customer (US) TO the org (FR).
    expect(body.shipment.fromAddress.location.countryIsoCode).toBe("US")
    expect(body.shipment.toAddress.location.countryIsoCode).toBe("FR")
    // Customs reason flips to RETURN (vs SALE for an outbound).
    expect(body.shipment.customsDeclaration?.reason).toBe("RETURN")
    // The link row is tagged as a return → returns_list surfaces it.
    const row = db.__all("shipment").find((r) => r.document_ref === "doc-1")!
    expect(row.kind).toBe("return")
    expect(row.return_reason).toBe("Defective unit")
    expect(row.created_by).toBe("agent")
  })

  it("outbound (no is_return) is unchanged: from=org(FR), to=customer(US), reason SALE, kind outbound", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    await createShipment(ctx, CREATE_INPUT)
    const body = bodyOf(fetchCalls)
    expect(body.shipment.fromAddress.location.countryIsoCode).toBe("FR")
    expect(body.shipment.toAddress.location.countryIsoCode).toBe("US")
    expect(body.shipment.customsDeclaration?.reason).toBe("SALE")
    const row = db.__all("shipment").find((r) => r.document_ref === "doc-1")!
    expect(row.kind ?? "outbound").toBe("outbound")
  })

  it("is_return=true wins over an explicit non-sale category (gift): reason is RETURN, not GIFT — physical direction wins", async () => {
    const db = createMockDb({
      seed: {
        shipping_profile: [
          { id: "p1", product_source: "shopify", product_id: "V1", unit_weight: 0.5, solo_length: 30, solo_width: 20, solo_height: 10, content_category: "content:v1:10120" },
        ],
        app_config: [{ id: "cfg-sender", key: "sender_address", value: SENDER_PARTY }],
        prep_state: [{ id: "s1", document_ref: "doc-1", category: "gift", excluded: false }],
      },
    })
    const fetchCalls: Array<{ url: string; method: string; body?: string }> = []
    const fetch = async (url: string, o?: { method?: string; body?: string }) => {
      const method = o?.method ?? "GET"
      fetchCalls.push({ url, method, body: o?.body })
      if (url.includes("/iam/account-app/token")) {
        return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
      }
      if (url.includes("/cotation")) {
        return { status: 200, headers: {}, body: MULTI_XML }
      }
      if (url.includes("/shipping-order") && url.includes("/tracking")) {
        return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: [{ status: "ANNOUNCED", trackingNumber: "TRK1", trackingDateTime: "2026-06-01T00:00:00Z", history: [] }] }) }
      }
      if (url.includes("/shipping-order")) {
        return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: { id: "ord-1", status: "PENDING", deliveryPriceExclTax: { value: 7.8, currency: "EUR" } } }) }
      }
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
    }
    const executeTool = async (target: string, _args: unknown) => {
      if (target === "invoicing:documents_search") return { status: "completed", result: [INVOICE] }
      return { status: "completed", result: INVOICE }
    }
    const ctx = {
      orgId: "org-1",
      db,
      fetch,
      executeTool,
      connections: { boxtal: { getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }), getToken: async () => { throw new Error("no") }, getAccounts: async () => [] } },
      config: { get: async () => "whsecret", has: async () => true },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    } as any
    await createShipment(ctx, { ...CREATE_INPUT, is_return: true, return_reason: "Wrong item shipped" })
    const body = bodyOf(fetchCalls)
    expect(body.shipment.customsDeclaration?.reason).toBe("RETURN")
    const row = db.__all("shipment").find((r) => r.document_ref === "doc-1")!
    expect(row.kind).toBe("return")
  })

  it("a delivered OUTBOUND on the same invoice does NOT block the return (kind-scoped uniqueness) — the warranty-return case", async () => {
    const { ctx, db } = makeCtx()
    // The original sale already shipped: a live outbound row exists for doc-1.
    ctx.db.insert("shipment", { document_ref: "doc-1", link_state: "created", order_status: "CONFIRMED", kind: "outbound" })
    const res = await createShipment(ctx, { ...CREATE_INPUT, is_return: true, return_reason: "Warranty repair" })
    expect("error" in res ? res.error : undefined).toBeUndefined()
    expect("boxtal_order_id" in res && res.boxtal_order_id).toBe("ord-1")
    const kinds = db.__all("shipment").filter((r) => r.document_ref === "doc-1").map((r) => r.kind)
    expect(kinds.sort()).toEqual(["outbound", "return"])
  })

  it("a SECOND return for the same invoice is still refused (duplicate within the kind)", async () => {
    const { ctx } = makeCtx()
    ctx.db.insert("shipment", { document_ref: "doc-1", link_state: "created", order_status: "PENDING", kind: "return" })
    const res = await createShipment(ctx, { ...CREATE_INPUT, is_return: true, return_reason: "Warranty repair" })
    expect("error" in res && res.error?.code).toBe("duplicate")
  })

  it("unresolved lines + an explicit carton override on a customs-free route still ships (unlinked-invoice warranty return)", async () => {
    // Order 2784 class: invoice lines carry no product_source (never linkable to a
    // shipping profile), route is intra-EU (customs-free). An operator carton via
    // set_package must make the draft shippable.
    const UNLINKED_EU_INVOICE = {
      ...INVOICE,
      counterparty_country: "DE",
      requires_hs_code: false,
      lines: INVOICE.lines.map((l) => ({ ...l, product_source: null, external_id: null, hs_code: null })),
    }
    const executeTool = async (target: string, _args: unknown) => {
      if (target === "invoicing:documents_search") return { status: "completed", result: [UNLINKED_EU_INVOICE] }
      return { status: "completed", result: UNLINKED_EU_INVOICE }
    }
    const { ctx } = makeCtx({ executeTool })
    await shipmentDraftSetPackagePersist(ctx, {
      draft_id: "doc-1",
      override: { weight: 5, length: 58, width: 38, height: 10 },
    })
    const pre = await createShipmentPreflight(ctx, {
      ...CREATE_INPUT,
      is_return: true,
      recipient_address: { ...RECIPIENT_ADDRESS, countryIsoCode: "DE" },
    })
    expect(pre).toEqual({ ok: true })
    const res = await createShipment(ctx, {
      ...CREATE_INPUT,
      is_return: true,
      return_reason: "Warranty repair",
      recipient_address: { ...RECIPIENT_ADDRESS, countryIsoCode: "DE" },
    })
    expect("error" in res ? res.error : undefined).toBeUndefined()
    expect("boxtal_order_id" in res && res.boxtal_order_id).toBe("ord-1")
  })

  it("unresolved lines + carton override on a CUSTOMS route still refuse (per-line customs cannot derive)", async () => {
    const UNLINKED_US_INVOICE = {
      ...INVOICE,
      lines: INVOICE.lines.map((l) => ({ ...l, product_source: null, external_id: null })),
    }
    const executeTool = async (target: string, _args: unknown) => {
      if (target === "invoicing:documents_search") return { status: "completed", result: [UNLINKED_US_INVOICE] }
      return { status: "completed", result: UNLINKED_US_INVOICE }
    }
    const { ctx } = makeCtx({ executeTool })
    await shipmentDraftSetPackagePersist(ctx, {
      draft_id: "doc-1",
      override: { weight: 5, length: 58, width: 38, height: 10 },
    })
    const res = await createShipment(ctx, { ...CREATE_INPUT, is_return: true })
    expect("error" in res && res.error?.code).toBe("unresolved_lines")
    expect("error" in res && res.error?.message).toMatch(/customs declaration/i)
  })

  it("unresolved lines WITHOUT a carton override still refuse, and the error teaches the set_package path", async () => {
    const UNLINKED_EU_INVOICE = {
      ...INVOICE,
      counterparty_country: "DE",
      requires_hs_code: false,
      lines: INVOICE.lines.map((l) => ({ ...l, product_source: null, external_id: null, hs_code: null })),
    }
    const executeTool = async (target: string, _args: unknown) => {
      if (target === "invoicing:documents_search") return { status: "completed", result: [UNLINKED_EU_INVOICE] }
      return { status: "completed", result: UNLINKED_EU_INVOICE }
    }
    const { ctx } = makeCtx({ executeTool })
    const res = await createShipment(ctx, { ...CREATE_INPUT, is_return: true })
    expect("error" in res && res.error?.code).toBe("unresolved_lines")
    expect("error" in res && res.error?.message).toMatch(/shipment_draft_set_package/)
  })

  it("the execution-time offer validation re-quotes the RETURN leg for is_return (expediteur=customer)", async () => {
    const { ctx, fetchCalls } = makeCtx()
    await createShipment(ctx, { ...CREATE_INPUT, is_return: true, return_reason: "Warranty repair" })
    // The backstop re-quote must price the leg being shipped: customer→us, not us→customer.
    const cotation = fetchCalls.find((c) => c.url.includes("/cotation"))!.url
    expect(cotation).toContain("expediteur.pays=US")
    expect(cotation).toContain("destinataire.pays=FR")
  })
})

// Stage-time preflight for the gated create_shipment (mis-shipment-recovery-swap-overlay regression).
// The gated create returns `pending_approval` at STAGE time without running the handler, so a draft_id
// that does not resolve to a real invoice (a weak model passing a hallucinated id, the approval
// "Request ID", or the other recovery leg's id) only 422'd AFTER the human approved — an unverifiable
// gated execution that forced the run non-green. The manifest `preflight: create_shipment_preflight`
// runs createShipmentPreflight at stage time so the SAME failures surface to the agent NOW (it
// self-corrects) rather than post-approval. Without the preflight these conditions are invisible until
// execution; with it they return a structured error the gated path rejects before creating the approval.
describe("create_shipment — stage-time preflight (mis-shipment recovery)", () => {
  it("passes ({ok:true}) for a resolvable draft, with NO side effects (no shipment row, no POST)", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    const res = await createShipmentPreflight(ctx, CREATE_INPUT)
    expect(res).toEqual({ ok: true })
    // Preflight is validation-only: it must NOT reserve a shipment row or POST to Boxtal.
    expect(db.__all("shipment")).toHaveLength(0)
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(false)
  })

  it("rejects (recipient_phone_invalid) at stage time when the destination is US/CA and the phone is not North American", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    // The exact Boxtal/FedEx 422 class: a French mobile on a US label. Must be
    // rejected BEFORE the approval card is created, like a missing state.
    const res = await createShipmentPreflight(ctx, { ...CREATE_INPUT, recipient_phone: "+33 6 12 34 56 78" })
    expect("error" in res && res.error.code).toBe("recipient_phone_invalid")
    expect("error" in res && res.error.message).toMatch(/North American/)
    expect(db.__all("shipment")).toHaveLength(0)
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(false)
  })

  it("execution also HARD-FAILS (recipient_phone_invalid, no POST) on an invalid US recipient phone", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    const res = await createShipment(ctx, { ...CREATE_INPUT, recipient_phone: "0612345678" })
    expect("error" in res && res.error?.code).toBe("recipient_phone_invalid")
    expect(db.__all("shipment")).toHaveLength(0)
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(false)
  })

  it("rejects (draft_unresolved) when the draft_id does not resolve to a real invoice — the wrong-id 422 class", async () => {
    // documents_get returns a completed-but-null result for a non-invoice id (a hallucinated id / the
    // approval Request ID / the other leg's id) — the exact case that 422'd post-approval before the fix.
    const executeTool = async (_target: string, _args: unknown) => ({ status: "completed", result: null })
    const { ctx, db, fetchCalls } = makeCtx({ executeTool })
    const res = await createShipmentPreflight(ctx, { draft_id: "not-an-invoice", offer_code: "CHRP-Chrono18" })
    expect("error" in res && res.error.code).toBe("draft_unresolved")
    expect("error" in res && res.error.message).toMatch(/no invoicing document found/i)
    // Still no side effects on the failing path.
    expect(db.__all("shipment")).toHaveLength(0)
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(false)
  })

  it("rejects (duplicate) when a live shipment already exists for that invoice — the same-doc-both-legs error", async () => {
    const { ctx } = makeCtx()
    // A live (non-CANCELLED) shipment already in flight for doc-1 — staging a SECOND create for the same
    // invoice (e.g. opening both the return and the reship from the same doc) would 422 'duplicate' at
    // execution; the preflight catches it at stage time with guidance to use two DISTINCT documents.
    ctx.db.insert("shipment", { document_ref: "doc-1", link_state: "created", order_status: "PENDING", kind: "outbound" })
    const res = await createShipmentPreflight(ctx, CREATE_INPUT)
    expect("error" in res && res.error.code).toBe("duplicate")
    expect("error" in res && res.error.message).toMatch(/different document/i)
  })

  it("staging a RETURN passes when a live OUTBOUND exists for the invoice (kind-scoped duplicate) — warranty case", async () => {
    const { ctx } = makeCtx()
    // The original sale's outbound leg is live (delivered or in flight) — the warranty
    // return opens from the SAME invoice and must not be blocked by it.
    ctx.db.insert("shipment", { document_ref: "doc-1", link_state: "created", order_status: "CONFIRMED", kind: "outbound" })
    const res = await createShipmentPreflight(ctx, { ...CREATE_INPUT, is_return: true })
    expect(res).toEqual({ ok: true })
  })

  it("staging a SECOND return for the same invoice is rejected (duplicate within the kind)", async () => {
    const { ctx } = makeCtx()
    ctx.db.insert("shipment", { document_ref: "doc-1", link_state: "created", order_status: "PENDING", kind: "return" })
    const res = await createShipmentPreflight(ctx, { ...CREATE_INPUT, is_return: true })
    expect("error" in res && res.error.code).toBe("duplicate")
    expect("error" in res && res.error.message).toMatch(/return shipment is already in flight/i)
  })

  it("does NOT treat a CANCELLED prior shipment as a duplicate (a re-attempt after cancel is allowed)", async () => {
    const { ctx } = makeCtx()
    ctx.db.insert("shipment", { document_ref: "doc-1", link_state: "created", order_status: "CANCELLED", kind: "outbound" })
    const res = await createShipmentPreflight(ctx, CREATE_INPUT)
    expect(res).toEqual({ ok: true })
  })

  // OFFER-CODE ROUTE VALIDATION (the marco-day journey root): the agent must ship on a carrier the quote
  // actually returned for THIS draft's destination route. The weak-model failure mode is staging an
  // EU-domestic carrier (a Colissimo `SOGP-*` code) for an export route the quote only offered
  // international carriers for, then fabricating "Colissimo services these destinations". The mock quote
  // returns ONLY `CHRP-Chrono18`, so a `SOGP-*` offer_code is non-quoted → must be rejected at stage time.
  it("rejects (offer_not_quoted) when offer_code was NOT returned by the route's quote — the fabricated-carrier class", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    const res = await createShipmentPreflight(ctx, {
      draft_id: "doc-1",
      offer_code: "SOGP-DomicileSansSignature", // a domestic Colissimo code the quote never offered
      recipient_phone: "+12125550100",
      recipient_address: RECIPIENT_ADDRESS,
      quoted_price_ttc: 9.36,
    })
    expect("error" in res && res.error.code).toBe("offer_not_quoted")
    // The error names the actually-available quoted offer so the agent self-corrects, not fabricate.
    expect("error" in res && res.error.message).toMatch(/CHRP-Chrono18/)
    // Still validation-only — no reservation, no POST.
    expect(db.__all("shipment")).toHaveLength(0)
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(false)
  })

  it("passes ({ok:true}) when the offer_code IS one of the route's quoted offers (no false reject)", async () => {
    const { ctx } = makeCtx()
    // CREATE_INPUT uses CHRP-Chrono18, exactly what the mock quote returns — must stay stageable.
    const res = await createShipmentPreflight(ctx, CREATE_INPUT)
    expect(res).toEqual({ ok: true })
  })

  it("does NOT refuse a non-allowlisted carrier at stage-time preflight — the allowlist is advisory, not a buy gate", async () => {
    // The route quote returns CHRP-Chrono18, but the org allowlist is UPS/FedEx/DHL.
    // Before the advisory-allowlist change the preflight re-quote dropped CHRP via the
    // allowlist -> offer_not_quoted. create_shipment is GATED (human-approved), so an
    // operator who explicitly picked a non-allowlisted carrier must pass preflight and
    // reach the approval. Route-validity + relay exclusion still apply (CHRP-Chrono18 is
    // a door-to-door offer the quote genuinely returns), so this proves ONLY the
    // allowlist stopped blocking the buy.
    const { ctx } = makeCtx({ allowlist: ["ups", "fedex", "dhl"] })
    const res = await createShipmentPreflight(ctx, CREATE_INPUT)
    expect(res).toEqual({ ok: true })
  })
})

// The LABEL PDF is what the customer actually needs from a return staging: import it into
// kernel.files (parented on the shipment row) so a sequenced tickets:reply — or a manual
// attach — gets a real attachable file id, never a short-lived signed URL. Best-effort:
// Boxtal generates documents asynchronously, so a missing label is a null, not a failure.
describe("create_shipment — label import into kernel.files (label_file_id)", () => {
  const LABEL_DOCS = JSON.stringify({
    status: 200,
    timestamp: "t",
    content: [{ url: "https://api.boxtal.com/signed/label-ord-1.pdf", type: "LABEL", format: "PDF_A4" }],
  })

  it("imports the LABEL onto the shipment row and returns its kernel file id", async () => {
    const { ctx, db, importCalls } = makeCtx({
      documentsBody: LABEL_DOCS,
      filesImportFromUrl: async () => JSON.stringify({ id: "file-42", filename: "label-ord-1.pdf" }),
    })
    const res = await createShipment(ctx, CREATE_INPUT)
    expect("label_file_id" in res && res.label_file_id).toBe("file-42")
    expect(importCalls).toHaveLength(1)
    const row = db.__all("shipment").find((r) => r.document_ref === "doc-1")!
    expect(importCalls[0]).toMatchObject({
      targetApp: "boxtal",
      targetEntityType: "shipment",
      targetEntityId: row.id,
      url: "https://api.boxtal.com/signed/label-ord-1.pdf",
      mimeType: "application/pdf",
      pdfStripRotation: true,
    })
  })

  it("returns label_file_id null when Boxtal has no documents yet — the order itself still succeeds", async () => {
    const { ctx, importCalls } = makeCtx({
      filesImportFromUrl: async () => JSON.stringify({ id: "never" }),
    })
    const res = await createShipment(ctx, CREATE_INPUT)
    expect("boxtal_order_id" in res && res.boxtal_order_id).toBe("ord-1")
    expect("label_file_id" in res && res.label_file_id).toBeNull()
    expect(importCalls).toHaveLength(0)
  })

  it("an import-bridge failure (e.g. egress allowlist) degrades to null, never fails the created order", async () => {
    const { ctx } = makeCtx({
      documentsBody: LABEL_DOCS,
      filesImportFromUrl: async () => {
        throw new Error("Domain not in allowlist: cdn.example")
      },
    })
    const res = await createShipment(ctx, CREATE_INPUT)
    expect("boxtal_order_id" in res && res.boxtal_order_id).toBe("ord-1")
    expect("label_file_id" in res && res.label_file_id).toBeNull()
  })

  it("without the bridge (older runtime), label_file_id is null and nothing is attempted", async () => {
    const { ctx } = makeCtx({ documentsBody: LABEL_DOCS })
    const res = await createShipment(ctx, CREATE_INPUT)
    expect("label_file_id" in res && res.label_file_id).toBeNull()
  })

  // The label is generated ASYNCHRONOUSLY by Boxtal, so create_shipment can legitimately
  // return label_file_id null; import_label_document is the backfill (standalone or as a
  // sequenced middle step). Caught live: the first real return label existed at Boxtal but
  // could not be attached because nothing could import it after the fact.
  describe("import_label_document (backfill)", () => {
    it("resolves the row by boxtal_order_id and imports the LABEL onto it", async () => {
      const { ctx, db, importCalls } = makeCtx({
        documentsBody: LABEL_DOCS,
        filesImportFromUrl: async () => JSON.stringify({ id: "file-77" }),
      })
      const { id: rowId } = await db.insert("shipment", {
        document_ref: "doc-1",
        boxtal_order_id: "ord-1",
        link_state: "created",
        order_status: "PENDING",
        kind: "return",
      })
      const res = await importLabelDocument(ctx, { id: "ord-1" })
      expect(res.label_file_id).toBe("file-77")
      expect(importCalls[0]).toMatchObject({ targetEntityType: "shipment", targetEntityId: rowId })
    })

    it("returns label_not_ready when Boxtal serves no LABEL yet", async () => {
      const { ctx, db } = makeCtx({
        filesImportFromUrl: async () => JSON.stringify({ id: "never" }),
      })
      await db.insert("shipment", { document_ref: "doc-1", boxtal_order_id: "ord-1", link_state: "created", order_status: "PENDING" })
      const res = await importLabelDocument(ctx, { id: "ord-1" })
      expect(res.error?.code).toBe("label_not_ready")
    })

    it("returns not_found when no local shipment row matches the id", async () => {
      const { ctx } = makeCtx({
        documentsBody: LABEL_DOCS,
        filesImportFromUrl: async () => JSON.stringify({ id: "never" }),
      })
      const res = await importLabelDocument(ctx, { id: "ord-unknown" })
      expect(res.error?.code).toBe("not_found")
    })
  })
})

// EXECUTION-TIME backstop: even if a non-quoted offer_code reaches the approved create_shipment handler,
// it must NOT buy a label on a carrier the quote didn't return — reject before reserving/POSTing.
describe("create_shipment — offer-code route validation backstop (marco-day journey root)", () => {
  it("rejects (offer_not_quoted) at execution + does NOT reserve a row or POST to Boxtal", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    const res = await createShipment(ctx, {
      draft_id: "doc-1",
      offer_code: "SOGP-DomicileSansSignature", // non-quoted (mock quote returns only CHRP-Chrono18)
      recipient_phone: "+12125550100",
      recipient_address: RECIPIENT_ADDRESS,
    })
    expect("error" in res && res.error?.code).toBe("offer_not_quoted")
    // No label bought: no shipment reserved + no create POST.
    expect(db.__all("shipment").filter((r: any) => r.link_state === "created")).toHaveLength(0)
    expect(fetchCalls.some((c) => c.url.endsWith("/shipping-order") && c.method === "POST")).toBe(false)
  })

  it("creates the label when the offer_code IS quoted (CHRP-Chrono18 round-trips) — no false block", async () => {
    const { ctx } = makeCtx()
    const res = await createShipment(ctx, CREATE_INPUT)
    expect("error" in res ? res.error : undefined).toBeUndefined()
    expect("boxtal_order_id" in res && res.boxtal_order_id).toBe("ord-1")
  })

  it("ships a non-allowlisted carrier at execution when explicitly chosen — the allowlist is advisory, not a buy gate", async () => {
    // CREATE_INPUT buys CHRP-Chrono18 (the offer the mock quote returns) under a
    // UPS/FedEx/DHL allowlist. Before the change the execution re-quote dropped CHRP via
    // the allowlist -> offer_not_quoted (no POST); now the label is bought, because a
    // gated human-approved buy honours the operator's explicit carrier choice. A
    // fabricated / route-invalid code is still refused (see the backstop test above).
    const { ctx } = makeCtx({ allowlist: ["ups", "fedex", "dhl"] })
    const res = await createShipment(ctx, CREATE_INPUT)
    expect("error" in res ? res.error : undefined).toBeUndefined()
    expect("boxtal_order_id" in res && res.boxtal_order_id).toBe("ord-1")
  })
})

describe("US/CA state handling (prod 400 BAD_REQUEST on a stateless US label)", () => {
  const fb = { name: "Stanley Fortson", email: null, countryIsoCode: "US" }

  it("parseInvoiceAddress extracts and normalizes the state from 'zip city, State'", () => {
    const a = parseInvoiceAddress("116 Chickasaw Dr.\n38572 Crossville, Tennessee", fb)
    expect(a).toMatchObject({ city: "Crossville", postalCode: "38572", state: "TN" })
    const b = parseInvoiceAddress("123 E Lancaster Ave\n19003-2385 Ardmore, Pennsylvania", fb)
    expect(b).toMatchObject({ city: "Ardmore", postalCode: "19003", state: "PA" })
  })

  it("parseInvoiceAddress leaves non-US regions as-is and null when absent", () => {
    const fr = { name: "X", email: null, countryIsoCode: "FR" }
    expect(parseInvoiceAddress("81 rue des Exemples\n75018 Paris", fr)?.state ?? null).toBeNull()
    expect(
      parseInvoiceAddress("1 rue\n75018 Paris, Île-de-France", fr)?.state,
    ).toBe("Île-de-France")
  })

  it("normalizeRecipientAddress folds Shopify province aliases into state", () => {
    expect(
      normalizeRecipientAddress({ city: "Airdrie", countryIsoCode: "CA", province: "Alberta" } as never)?.state,
    ).toBe("AB")
    expect(
      normalizeRecipientAddress({ city: "NYC", countryCode: "us", provinceCode: "ny" } as never)?.state,
    ).toBe("NY")
  })
})

// A route where a UPS access-point offer (PICKUP_POINT delivery, cheapest) sits beside a
// door-to-door Chronopost — used to prove the pickup-point policy refuses the relay offer_code
// at create time and that include_pickup_point bypasses it.
const RELAY_CREATE_XML = `<?xml version="1.0"?><cotation><shipment>
  <offer><mode>COM</mode><operator><code>UPSE</code><label>UPS</label></operator><service><code>EconomyAccessPoint</code><label>UPS Economy Access Point</label></service><price><currency>EUR</currency><tax-exclusive>9.07</tax-exclusive><tax-inclusive>10.88</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-03</date><type><code>PICKUP_POINT</code></type></delivery></offer>
  <offer><mode>COM</mode><operator><code>CHRP</code><label>Chronopost</label></operator><service><code>Chrono13</code><label>Chrono 13</label></service><price><currency>EUR</currency><tax-exclusive>12.40</tax-exclusive><tax-inclusive>14.88</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-02</date><type><code>DELIVERY</code></type></delivery></offer>
</shipment></cotation>`

describe("create_shipment offer resolution (prep-dashboard selection) + pickup-point policy", () => {
  // FOUR_CARRIER re-quote offers: CHRP (cheapest, 9.66), FEDX (15.46), UPS AP (dropped by policy),
  // DHL (42.01). A cached prep_quote is what create_shipment reads to stage the operator's choice.
  const CACHED_OFFERS = [
    { carrier: "Chronopost", service: "Chrono 2Shop Europe", offer_code: "CHRP-Chrono2ShopEurope", price_ht_minor: 966, price_ttc_minor: 1159, currency: "EUR", delivery_date: "2026-06-04", eta_business_days: 3, is_pickup_point: false },
    { carrier: "FedEx", service: "FedEx Regional Economy", offer_code: "FEDX-FedexRegionalEconomy", price_ht_minor: 1546, price_ttc_minor: 1854, currency: "EUR", delivery_date: "2026-06-03", eta_business_days: 2, is_pickup_point: false },
  ]
  function seedPrep(db: ReturnType<typeof createMockDb>, opts: { selected?: string; noQuote?: boolean }) {
    if (!opts.noQuote) {
      db.__seed("prep_quote", [{ id: "q1", document_ref: "doc-1", input_hash: "h", offers: CACHED_OFFERS, quoted_at: "2026-07-10T08:00:00Z" }])
    }
    if (opts.selected) {
      db.__seed("prep_state", [{ id: "s1", document_ref: "doc-1", category: "sale", excluded: false, selected_offer_code: opts.selected }])
    }
  }

  it("stages the operator's SELECTED offer (not the cheapest) when no offer_code is passed", async () => {
    const { ctx, db, fetchCalls } = makeCtx({ cotationBody: FOUR_CARRIER_XML })
    seedPrep(db, { selected: "FEDX-FedexRegionalEconomy" })
    const res = await createShipment(ctx, {
      draft_id: "doc-1",
      recipient_phone: "+12125550100",
      recipient_address: RECIPIENT_ADDRESS,
    })
    expect("error" in res).toBe(false)
    const body = orderPostBody(fetchCalls) as unknown as { shippingOfferCode: string }
    expect(body.shippingOfferCode).toBe("FEDX-FedexRegionalEconomy") // chosen, not the cheaper CHRP
  })

  it("falls back to the cached cheapest offer when the operator has not chosen one", async () => {
    const { ctx, db, fetchCalls } = makeCtx({ cotationBody: FOUR_CARRIER_XML })
    seedPrep(db, {}) // quote cached, no selection
    const res = await createShipment(ctx, {
      draft_id: "doc-1",
      recipient_phone: "+12125550100",
      recipient_address: RECIPIENT_ADDRESS,
    })
    expect("error" in res).toBe(false)
    const body = orderPostBody(fetchCalls) as unknown as { shippingOfferCode: string }
    expect(body.shippingOfferCode).toBe("CHRP-Chrono2ShopEurope") // cheapest cached offer
  })

  it("errors offer_required when no offer_code is passed and there is no cached quote to stage", async () => {
    const { ctx } = makeCtx()
    const res = await createShipment(ctx, {
      draft_id: "doc-1",
      recipient_phone: "+12125550100",
      recipient_address: RECIPIENT_ADDRESS,
    })
    expect(res).toMatchObject({ error: { code: "offer_required" } })
  })

  it("REFUSES a relay offer_code at create time when the policy is on (offer_not_quoted, same model as the allowlist refusal)", async () => {
    const { ctx } = makeCtx({ cotationBody: RELAY_CREATE_XML }) // policy default on
    const res = await createShipment(ctx, {
      draft_id: "doc-1",
      offer_code: "UPSE-EconomyAccessPoint",
      quoted_price_ttc: 10.88,
      recipient_phone: "+12125550100",
      recipient_address: RECIPIENT_ADDRESS,
    })
    expect(res).toMatchObject({ error: { code: "offer_not_quoted" } })
  })

  it("stages a relay offer_code when include_pickup_point:true bypasses the policy for that buy", async () => {
    const { ctx, fetchCalls } = makeCtx({ cotationBody: RELAY_CREATE_XML })
    const res = await createShipment(ctx, {
      draft_id: "doc-1",
      offer_code: "UPSE-EconomyAccessPoint",
      include_pickup_point: true,
      quoted_price_ttc: 10.88,
      recipient_phone: "+12125550100",
      recipient_address: RECIPIENT_ADDRESS,
    })
    expect("error" in res).toBe(false)
    const body = orderPostBody(fetchCalls) as unknown as { shippingOfferCode: string }
    expect(body.shippingOfferCode).toBe("UPSE-EconomyAccessPoint")
  })
})

describe("customs FX: the Shopify order reference must reach orders_get in gid form", () => {
  // Invoicing persists `shopify_order_id` as the BARE NUMERIC id, but
  // shopify:orders_get runs a GraphQL `order(id: ID!)` lookup that resolves ONLY
  // the gid form. Passing the numeric id straight through made the lookup throw,
  // resolveFxToDeclared swallowed it, and every customs article on a non-EUR
  // invoice was blocked `fx_unavailable` -- surfacing in the prep grid as
  // "Customs value needs a manual EUR amount" even though the linked order
  // carried the exact rate. Four live US/JP orders sat blocked on this
  // (field report 2026-08-03).
  const NUMERIC_ORDER_ID = "13018158072139"
  const ORDER_GID = `gid://shopify/Order/${NUMERIC_ORDER_ID}`

  /** A USD invoice (customs required on the FR -> US route) linked to a Shopify
   *  order by its NUMERIC id, exactly as invoicing stores it. */
  const USD_INVOICE = {
    ...INVOICE,
    currency: "USD",
    shopify_order_id: NUMERIC_ORDER_ID,
  }

  /** orders_get mock that behaves like the real tool: the gid resolves, the bare
   *  numeric id does not. `seen` records every id the draft asked for. */
  function makeShopifyCtx(seen: string[]) {
    return makeCtx({
      executeTool: async (target: string, args: unknown) => {
        if (target === "invoicing:documents_search") {
          return { status: "completed", result: [USD_INVOICE] }
        }
        if (target === "invoicing:documents_get") {
          return { status: "completed", result: USD_INVOICE }
        }
        if (target === "shopify:orders_get") {
          const id = (args as { id?: string })?.id ?? ""
          seen.push(id)
          // The real tool throws NOT_FOUND for anything that is not a gid.
          if (id !== ORDER_GID) throw new Error(`order ${id} not found`)
          return {
            status: "completed",
            result: {
              attributes: {
                totalAmount: "200.00",
                totalAmountShop: "180.00",
                shopCurrency: "EUR",
              },
            },
          }
        }
        return { status: "completed", result: null }
      },
    })
  }

  it("asks orders_get for the gid, not the stored numeric id", async () => {
    const seen: string[] = []
    const { ctx } = makeShopifyCtx(seen)
    await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(seen).toEqual([ORDER_GID])
  })

  it("derives the rate and declares the customs value in EUR", async () => {
    const seen: string[] = []
    const { ctx } = makeShopifyCtx(seen)
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    // 200.00 USD presentment against a 180.00 EUR shop total is a 0.9 rate, so
    // the 100.00 USD line declares as 90.00 EUR.
    expect(draft.fx).toMatchObject({ from: "USD", to: "EUR", source: "shopify_order_totals" })
    expect(draft.fx?.rate).toBeCloseTo(0.9, 10)
    expect(draft.customsArticles).toHaveLength(1)
    expect(draft.customsArticles[0]!.unitValue).toMatchObject({ value: 90, currency: "EUR" })
  })

  it("leaves no article blocked fx_unavailable once the rate resolves", async () => {
    const seen: string[] = []
    const { ctx } = makeShopifyCtx(seen)
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.customsArticles.filter((a) => a.reason === "fx_unavailable")).toHaveLength(0)
    expect(draft.customsArticles.some((a) => a.blocked)).toBe(false)
  })

  it("still blocks when the invoice carries no linked Shopify order (no guessed rate)", async () => {
    // The fallback path must be preserved: with nothing to derive a rate from we
    // block rather than declaring a USD figure as EUR at customs.
    const noOrder = { ...USD_INVOICE, shopify_order_id: null }
    const { ctx } = makeCtx({
      executeTool: async (target: string) => {
        if (target === "invoicing:documents_search") return { status: "completed", result: [noOrder] }
        return { status: "completed", result: noOrder }
      },
    })
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.fx).toBeNull()
    expect(draft.customsArticles[0]!.blocked).toBe(true)
    expect(draft.customsArticles[0]!.reason).toBe("fx_unavailable")
  })

  // The blocked message tells the agent to set each article's EUR value with
  // shipment_draft_set_customs. The tool's schema takes `unitValue` as a plain
  // number, so that is what an agent sends; the override must then unblock the
  // article on the draft read AND on both create_shipment checks.
  function noRateCtx() {
    const noOrder = { ...USD_INVOICE, shopify_order_id: null }
    return makeCtx({
      executeTool: async (target: string) => {
        if (target === "invoicing:documents_search") return { status: "completed", result: [noOrder] }
        return { status: "completed", result: noOrder }
      },
    })
  }

  it("a set_customs unitValue (a number, as the tool schema takes it) unblocks an fx_unavailable article", async () => {
    const { ctx } = noRateCtx()
    const before = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(before.customsArticles[0]!.reason).toBe("fx_unavailable")

    const after = await shipmentDraftSetCustomsPersist(ctx, { draft_id: "doc-1", index: 0, patch: { unitValue: 1 } })
    expect(after.customsArticles[0]!.unitValue).toEqual({ value: 1, currency: "EUR" })
    expect(after.customsArticles[0]!.blocked).toBeFalsy()
    expect(after.customsArticles[0]!.reason).toBeUndefined()

    // A fresh read (shipment_draft_get) sees the persisted override too.
    const read = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(read.customsArticles.some((a) => a.blocked)).toBe(false)

    const pre = await createShipmentPreflight(ctx, CREATE_INPUT)
    expect("error" in pre && pre.error?.code).not.toBe("unresolved_lines")
    const res = await createShipment(ctx, CREATE_INPUT)
    expect(res.error?.code).not.toBe("unresolved_lines")
    expect(res.error).toBeUndefined()
  })

  it("an override persisted as {value, currency} still applies", async () => {
    const { ctx } = noRateCtx()
    await shipmentDraftSetCustomsPersist(ctx, {
      draft_id: "doc-1",
      index: 0,
      patch: { unitValue: { value: 2.5, currency: "EUR" } },
    })
    const read = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(read.customsArticles[0]!.unitValue).toEqual({ value: 2.5, currency: "EUR" })
    expect(read.customsArticles[0]!.blocked).toBeFalsy()
  })

  it("set_customs refuses a unitValue that is not a positive number instead of silently dropping it", async () => {
    const { ctx } = noRateCtx()
    await expect(
      shipmentDraftSetCustomsPersist(ctx, { draft_id: "doc-1", index: 0, patch: { unitValue: "1 EUR" as never } }),
    ).rejects.toThrow(/unitValue/)
  })
})

// ── The create body's order reference + label geometry ──────────────────────
//
// Both are what the operator's downstream world reads: `externalId` is echoed
// back by boxtal:search / boxtal:track as `external_id` ("the order this
// shipment is for"), and `labelType` decides whether the PDF that comes back is
// a bare thermal label or an office sheet that has to be cropped by hand.
describe("create body — order reference and label format", () => {
  async function postBody(fetchCalls: Array<{ url: string; method: string; body?: string }>) {
    const post = fetchCalls.find((c) => c.url.endsWith("/shipping-order") && c.method === "POST")!
    return JSON.parse(post.body!) as { labelType: string; shipment: { externalId?: string } }
  }

  it("stamps the linked ORDER NAME as externalId, not the invoicing document id (ticket-10202)", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    await db.insert("prep_meta", { document_ref: "doc-1", order_name: "#3332" })
    await createShipment(ctx, CREATE_INPUT)
    expect((await postBody(fetchCalls)).shipment.externalId).toBe("#3332")
  })

  it("falls back to the document_ref when the invoice has no linked order", async () => {
    const { ctx, fetchCalls } = makeCtx()
    await createShipment(ctx, CREATE_INPUT)
    expect((await postBody(fetchCalls)).shipment.externalId).toBe("doc-1")
  })

  it("an explicit external_id wins over the cached order name", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    await db.insert("prep_meta", { document_ref: "doc-1", order_name: "#3332" })
    await createShipment(ctx, { ...CREATE_INPUT, external_id: "#9001" })
    expect((await postBody(fetchCalls)).shipment.externalId).toBe("#9001")
  })

  it("asks Boxtal for the org's label format (ticket-10201)", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    await db.insert("app_config", { key: "label_format", value: "PDF_10x15" })
    await createShipment(ctx, CREATE_INPUT)
    expect((await postBody(fetchCalls)).labelType).toBe("PDF_10x15")
  })

  it("defaults to PDF_A4 when no label format is configured", async () => {
    const { ctx, fetchCalls } = makeCtx()
    await createShipment(ctx, CREATE_INPUT)
    expect((await postBody(fetchCalls)).labelType).toBe("PDF_A4")
  })

  it("a per-call label_format overrides the org default", async () => {
    const { ctx, db, fetchCalls } = makeCtx()
    await db.insert("app_config", { key: "label_format", value: "PDF_A4" })
    await createShipment(ctx, { ...CREATE_INPUT, label_format: "PDF_10x15" })
    expect((await postBody(fetchCalls)).labelType).toBe("PDF_10x15")
  })
})

// An ORDER-LESS prep row (prep_add_shipment / return-after-repair) keeps its recipient and its
// category on `prep_order_state`, not `prep_state`. The draft used to ignore that row entirely:
// the address fell back to the free-text parse (no postal code -> the cotation 400s, "No offers")
// and a warranty repair return was declared to customs as a SALE.
describe("draft from an order-less prep_order_state row", () => {
  /** A Norway proforma whose flattened address is ONE comma-joined line. */
  const ORDERLESS_INVOICE = {
    ...INVOICE,
    counterparty_country: "NO",
    counterparty_name: "Eirik Syrdalen",
    counterparty_email: "post@evenstadmusikk.no",
    counterparty_address: "Industriveien 4, 4879, Grimstad",
    counterparty_contact_id: null,
  }

  const STORED_RECIPIENT = {
    name: "Eirik Syrdalen",
    street: "Industriveien 4",
    city: "Grimstad",
    postalCode: "4879",
    phone: "+47 37 40 36 19",
    countryIsoCode: "NO",
    email: "post@evenstadmusikk.no",
  }

  function orderlessCtx(opts?: {
    row?: Record<string, unknown>
    contactShippingAddress?: Record<string, unknown>
    invoice?: Record<string, unknown>
  }) {
    const doc = opts?.invoice ?? ORDERLESS_INVOICE
    const executeTool = async (target: string, _args: unknown) => {
      if (target === "invoicing:documents_search") return { status: "completed", result: [doc] }
      if (target === "kernel:contacts_read") {
        return opts?.contactShippingAddress
          ? {
              status: "completed",
              result: { contact: { metadata: { shipping_address: opts.contactShippingAddress } } },
            }
          : { status: "completed", result: null }
      }
      return { status: "completed", result: doc }
    }
    const made = makeCtx({ executeTool })
    if (opts?.row) made.db.__seed("prep_order_state", [opts.row])
    return made
  }

  it("takes the row's structured recipient over the comma-joined invoice address", async () => {
    const { ctx } = orderlessCtx({
      row: {
        id: "os-1",
        order_key: "doc:doc-1",
        proforma_document_ref: "doc-1",
        category: "repair",
        recipient: STORED_RECIPIENT,
      },
    })
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.recipient_address).toMatchObject({
      name: "Eirik Syrdalen",
      street: "Industriveien 4",
      city: "Grimstad",
      postalCode: "4879",
      phone: "+47 37 40 36 19",
      countryIsoCode: "NO",
    })
  })

  it("declares a repair row as REPAIR, not SALE", async () => {
    const { ctx } = orderlessCtx({
      row: {
        id: "os-1",
        order_key: "doc:doc-1",
        proforma_document_ref: "doc-1",
        category: "repair",
        recipient: STORED_RECIPIENT,
      },
    })
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.category).toBe("repair")
    expect(draft.customs_basis).toBe("REPAIR")
  })

  it("merges per field: the row supplies the phone, the contact supplies the street", async () => {
    const { ctx } = orderlessCtx({
      invoice: { ...ORDERLESS_INVOICE, counterparty_contact_id: "contact-1" },
      row: {
        id: "os-1",
        order_key: "doc:doc-1",
        proforma_document_ref: "doc-1",
        recipient: { phone: "+47 37 40 36 19" },
      },
      contactShippingAddress: {
        street: "Industriveien 4",
        city: "Grimstad",
        postalCode: "4879",
        countryIsoCode: "NO",
      },
    })
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.recipient_address).toMatchObject({
      phone: "+47 37 40 36 19",
      street: "Industriveien 4",
      city: "Grimstad",
      postalCode: "4879",
    })
  })

  it("with no order-state row the draft is unchanged (falls back to prep_state)", async () => {
    const { ctx, db } = orderlessCtx()
    db.__seed("prep_state", [{ id: "s1", document_ref: "doc-1", category: "gift" }])
    const draft = await shipmentDraftCreate(ctx, { document_ref: "doc-1" })
    expect(draft.category).toBe("gift")
    expect(draft.customs_basis).toBe("GIFT")
  })
})

// The safety net for every row whose contact is not backfilled: a document address that arrives as
// one comma-joined line used to parse into city="Industriveien 4" / state="4879, Grimstad", so the
// cotation went out with no postal code at all and came back "No offers".
describe("parseInvoiceAddress on a single comma-joined line", () => {
  const no = { name: "Eirik Syrdalen", email: "post@evenstadmusikk.no", countryIsoCode: "NO" }
  it("splits '<street>, <postcode>, <city>' and leaves state null outside US/CA", () => {
    expect(parseInvoiceAddress("Industriveien 4, 4879, Grimstad", no)).toMatchObject({
      street: "Industriveien 4",
      postalCode: "4879",
      city: "Grimstad",
      state: null,
    })
  })
  it("splits '<street>, <postcode> <city>'", () => {
    expect(parseInvoiceAddress("Industriveien 4, 4879 Grimstad", no)).toMatchObject({
      street: "Industriveien 4",
      postalCode: "4879",
      city: "Grimstad",
      state: null,
    })
  })
  it("keeps a trailing region on a single line", () => {
    expect(
      parseInvoiceAddress("81 rue des Exemples, 75018 Paris, Ile-de-France", {
        name: "Fabrikam",
        email: null,
        countryIsoCode: "FR",
      }),
    ).toMatchObject({ street: "81 rue des Exemples", postalCode: "75018", city: "Paris", state: "Ile-de-France" })
  })
  it("does not regress the multiline shape", () => {
    const fb = { name: "Xavier Thibaud", email: "x@example.com", countryIsoCode: "FR" }
    expect(parseInvoiceAddress("50 rue des TROIS ROIS\n44000 NANTES", fb)).toMatchObject({
      street: "50 rue des TROIS ROIS",
      postalCode: "44000",
      city: "NANTES",
    })
    expect(
      parseInvoiceAddress("Fabrikam\n81 rue des Exemples\n75018 Paris, Ile-de-France", fb),
    ).toMatchObject({
      street: "Fabrikam, 81 rue des Exemples",
      postalCode: "75018",
      city: "Paris",
      state: "Ile-de-France",
    })
  })
})

// ── label import: bounded retries with real backoff ─────────────────────────
//
// Prod, 2026-09: operators got "Request failed" (HTTP 504 at 30s) on the
// shipping tools and print_pack was measured holding a sandbox worker for 37 to
// 39s. The label-import loop retried with a bare `continue` (no pause, no
// jitter) and print_pack reached it through a call site asking for EIGHT
// attempts, each bounded only by the sandbox-wide 10s fetch cap: 8 x 10s = 80s
// inside a 60s tool budget. These tests pin the arithmetic documented on
// importLabelFile: 3 attempts x 10s + 3s of backoff = 33s worst case.
describe("label import backoff and budget", () => {
  /** A ctx with the host import bridge present but nothing importable. */
  function bridgeCtx() {
    return makeCtx({ filesImportFromUrl: async () => JSON.stringify({ id: "never" }) }).ctx
  }
  /** A client whose LABEL document is never ready, counting its reads. */
  function notReadyClient(costMs = 0, clock?: { t: number }) {
    const reads: string[] = []
    return {
      reads,
      v3: {
        getDocuments: async (id: string) => {
          reads.push(id)
          if (clock) clock.t += costMs
          return [] as Array<{ url?: string; type: string; format: string }>
        },
      },
    }
  }

  it("sleeps between attempts (exponential with jitter) and still degrades to null, never throws", async () => {
    const client = notReadyClient()
    const slept: number[] = []
    const out = await importLabelFile(bridgeCtx(), client, "ord-1", "row-1", LABEL_IMPORT_ATTEMPTS, {
      sleep: async (ms: number) => {
        slept.push(ms)
      },
      // random()=1 is the TOP of the jitter window: the documented worst case.
      random: () => 1,
      now: () => 0,
    })
    // A label that is genuinely not ready yet is still a null, not a throw.
    expect(out).toBeNull()
    expect(client.reads).toHaveLength(3)
    // One pause between each pair of attempts: 400ms then 800ms, capped at 1500ms.
    expect(slept).toEqual([400, 800])
  })

  it("keeps the worst case (3 attempts x 10s + backoff) well under the 60s tool budget", async () => {
    const clock = { t: 0 }
    // Every Boxtal read costs a FULL call budget: the degraded-upstream case.
    const client = notReadyClient(BOXTAL_CALL_BUDGET_MS, clock)
    const out = await importLabelFile(bridgeCtx(), client, "ord-1", "row-1", LABEL_IMPORT_ATTEMPTS, {
      sleep: async (ms: number) => {
        clock.t += ms
      },
      random: () => 1,
      now: () => clock.t,
    })
    expect(out).toBeNull()
    expect(client.reads).toHaveLength(3)
    // 3 x 10_000 + 400 + 800 = 31_200ms, inside the loop's own 35s deadline and
    // leaving the rest of print_pack most of its 60s budget.
    expect(clock.t).toBe(3 * BOXTAL_CALL_BUDGET_MS + 1_200)
    expect(clock.t).toBeLessThan(LABEL_IMPORT_BUDGET_MS)
    expect(clock.t).toBeLessThan(40_000)
  })

  it("stops at its deadline instead of starting an attempt it cannot afford", async () => {
    const clock = { t: 0 }
    // A pathologically slow upstream: 20s per read (past any per-request cap).
    const client = notReadyClient(20_000, clock)
    const out = await importLabelFile(bridgeCtx(), client, "ord-1", "row-1", LABEL_IMPORT_ATTEMPTS, {
      sleep: async (ms: number) => {
        clock.t += ms
      },
      random: () => 1,
      now: () => clock.t,
    })
    expect(out).toBeNull()
    // Two reads, not three: the third would have started past LABEL_IMPORT_BUDGET_MS.
    expect(client.reads).toHaveLength(2)
    // Still under the 62s sandbox worker kill.
    expect(clock.t).toBeLessThan(62_000)
  })

  it("import_label_document (the print_pack call site) asks for 3 attempts, not 8", async () => {
    const { ctx, db, fetchCalls } = makeCtx({
      filesImportFromUrl: async () => JSON.stringify({ id: "never" }),
    })
    await db.insert("shipment", {
      document_ref: "doc-1",
      boxtal_order_id: "ord-1",
      link_state: "created",
      order_status: "PENDING",
    })
    const res = await importLabelDocument(ctx, { id: "ord-1" }, { sleep: async () => {}, random: () => 1 })
    // Degrades exactly as before: print_pack reports "Label not available yet".
    expect(res.error?.code).toBe("label_not_ready")
    const documentReads = fetchCalls.filter((c) => c.url.includes("/shipping-document"))
    expect(documentReads).toHaveLength(LABEL_IMPORT_ATTEMPTS)
    expect(documentReads.length).toBeLessThan(8)
  })
})

describe("parseInvoiceAddress: postcodes with a space that lead the locality", () => {
  const fbFor = (countryIsoCode: string) => ({ name: "Test Recipient", email: "r@example.com", countryIsoCode })
  it("keeps a Dutch postcode's two letters (4 digits + space + 2 letters)", () => {
    expect(parseInvoiceAddress("Teststraat 12\n1114 BC Amsterdam-Duivendrecht", fbFor("NL"))).toMatchObject({
      street: "Teststraat 12",
      postalCode: "1114 BC",
      city: "Amsterdam-Duivendrecht",
    })
    expect(parseInvoiceAddress("Teststraat 12\n1114BC Amsterdam\nNetherlands", fbFor("NL"))).toMatchObject({
      postalCode: "1114BC",
      city: "Amsterdam",
    })
    expect(parseInvoiceAddress("Teststraat 12, 1114 BC Amsterdam", fbFor("NL"))).toMatchObject({
      street: "Teststraat 12",
      postalCode: "1114 BC",
      city: "Amsterdam",
    })
    expect(parseInvoiceAddress("Teststraat 12, 1114 BC, Amsterdam", fbFor("NL"))).toMatchObject({
      street: "Teststraat 12",
      postalCode: "1114 BC",
      city: "Amsterdam",
    })
  })
  it("does not take a mixed-case Dutch city word for postcode letters", () => {
    expect(parseInvoiceAddress("Teststraat 12\n3731 De Bilt", fbFor("NL"))).toMatchObject({
      postalCode: "3731",
      city: "De Bilt",
    })
  })
  it("keeps 3 + 2 digit postcodes whole (SE, CZ, SK, GR)", () => {
    for (const [cc, line, code, city] of [
      ["SE", "114 55 Stockholm", "114 55", "Stockholm"],
      ["CZ", "110 00 Praha 1", "110 00", "Praha 1"],
      ["SK", "811 01 Bratislava", "811 01", "Bratislava"],
      ["GR", "105 57 Athina", "105 57", "Athina"],
    ] as const) {
      expect(parseInvoiceAddress(`Testgatan 1\n${line}`, fbFor(cc))).toMatchObject({ postalCode: code, city })
    }
  })
  it("leaves other countries' shapes as they were (PL, PT, DE, FR, GB, CA)", () => {
    expect(parseInvoiceAddress("ul. Testowa 5\n00-950 Warszawa", fbFor("PL"))).toMatchObject({
      postalCode: "00-950",
      city: "Warszawa",
    })
    expect(parseInvoiceAddress("Rua Teste 5\n1000-001 Lisboa", fbFor("PT"))).toMatchObject({
      postalCode: "1000-001",
      city: "Lisboa",
    })
    expect(parseInvoiceAddress("Teststr. 5\n10115 Berlin", fbFor("DE"))).toMatchObject({
      postalCode: "10115",
      city: "Berlin",
    })
    expect(parseInvoiceAddress("5 rue Test\n75011 Paris", fbFor("FR"))).toMatchObject({
      postalCode: "75011",
      city: "Paris",
    })
    // GB and CA postcodes start with a letter: no leading postcode is read, as before.
    expect(parseInvoiceAddress("1 Test Road\nLondon SW1A 1AA", fbFor("GB"))?.postalCode ?? null).toBeNull()
    expect(parseInvoiceAddress("1 Test Street\nOttawa ON K1A 0B1", fbFor("CA"))?.postalCode ?? null).toBeNull()
  })
})

// Staging and the worklist share ONE rule for which invoice lines are parcel lines and when the
// unresolved ones block (shippable-lines.ts). A free-text "Shipping" line kinded as goods, with no
// product link, used to show the row as ready in the worklist while Ship refused it.
describe("shippable lines: the worklist and staging agree", () => {
  const DE_RECIPIENT = { ...RECIPIENT_ADDRESS, city: "Berlin", postalCode: "10115", countryIsoCode: "DE", state: undefined }
  const DE_INPUT = { ...CREATE_INPUT, recipient_address: DE_RECIPIENT, recipient_phone: "+4930123456" }
  const goods = (id: string, external_id: string, quantity: number) => ({
    id,
    description: `Product ${external_id}`,
    quantity,
    unit_price_minor: "10000",
    hs_code: "851762",
    country_of_origin: "FR",
    customs_description: null,
    product_source: "shopify",
    external_id,
    line_kind: "goods",
  })
  const freeTextShipping = (id: string) => ({
    id,
    description: "Shipping",
    quantity: 1,
    unit_price_minor: "4500",
    hs_code: null,
    country_of_origin: null,
    customs_description: null,
    product_source: null,
    external_id: null,
    line_kind: "goods",
  })
  const kindedShipping = (id: string) => ({ ...freeTextShipping(id), description: "Shipping (Express)", line_kind: "shipping" })
  const invoice = (id: string, lines: unknown[]) => ({
    ...INVOICE,
    id,
    counterparty_country: "DE",
    counterparty_name: "Test Dealer GmbH",
    requires_hs_code: false,
    lines,
  })

  async function ctxFor(docs: Array<ReturnType<typeof invoice>>) {
    const byId = new Map(docs.map((d) => [d.id, d]))
    const { ctx, db } = makeCtx({
      executeTool: async (target: string, args: { id?: string }) => {
        if (target === "invoicing:documents_search") return { status: "completed", result: docs }
        if (target === "invoicing:documents_get") return { status: "completed", result: byId.get(String(args?.id)) ?? null }
        return { status: "completed", result: null }
      },
    })
    for (const [id, product_id, w] of [["p2", "V2", 2.0], ["p3", "V3", 5.4]] as const) {
      await db.insert("shipping_profile", {
        id,
        product_source: "shopify",
        product_id,
        unit_weight: w,
        solo_length: 50,
        solo_width: 34,
        solo_height: 16,
        content_category: "content:v1:10120",
      })
    }
    await db.insert("pack", { id: "pack-a", name: "PACK-A", length: 58, width: 38, height: 42, gross_weight: 20.5, content_category: null, carton_tare: null })
    await db.insert("pack", { id: "pack-b", name: "PACK-B", length: 60, width: 40, height: 38, gross_weight: 13, content_category: null, carton_tare: null })
    await db.insert("pack_component", { id: "pc-a", pack_id: "pack-a", product_source: "shopify", product_id: "V1", quantity: 1 })
    await db.insert("pack_component", { id: "pc-b", pack_id: "pack-b", product_source: "shopify", product_id: "V2", quantity: 1 })
    return ctx
  }

  async function verdicts(ctx: unknown, docId: string) {
    const draft = await shipmentDraftCreate(ctx as never, { document_ref: docId, orderShipTo: false })
    const facts = deriveDraftFacts(draft, docId)
    const pre = await createShipmentPreflight(ctx as never, { ...DE_INPUT, draft_id: docId })
    const stagingRefuses = "error" in pre && pre.error?.code === "unresolved_lines"
    return { draft, facts, stagingRefuses }
  }

  it("an 11-parcel dealer invoice with a free-text Shipping goods line is ready in both", async () => {
    const doc = invoice("00000000-0000-4000-8000-000000000011", [
      goods("l1", "V1", 6),
      goods("l2", "V2", 4),
      goods("l3", "V3", 1),
      freeTextShipping("l4"),
    ])
    const ctx = await ctxFor([doc])
    const { draft, facts, stagingRefuses } = await verdicts(ctx, doc.id)
    expect(draft.parcels).toHaveLength(11)
    expect(draft.unresolved).toHaveLength(0)
    expect(facts.needs_fix_reason).toBeNull()
    expect(stagingRefuses).toBe(false)
  })

  it("a two-invoice order (free-text and kinded shipping lines) is ready in both, per invoice", async () => {
    const a = invoice("00000000-0000-4000-8000-00000000000a", [goods("a1", "V1", 1), goods("a2", "V3", 1), freeTextShipping("a3")])
    const b = invoice("00000000-0000-4000-8000-00000000000b", [goods("b1", "V2", 2), kindedShipping("b2")])
    const ctx = await ctxFor([a, b])
    for (const doc of [a, b]) {
      const { draft, facts, stagingRefuses } = await verdicts(ctx, doc.id)
      expect(draft.parcels.length).toBeGreaterThan(0)
      expect(draft.unresolved).toHaveLength(0)
      expect(facts.needs_fix_reason).toBeNull()
      expect(stagingRefuses).toBe(false)
    }
  })

  it("a real product line with no product link is unresolved in BOTH the worklist and staging", async () => {
    const doc = invoice("00000000-0000-4000-8000-0000000000c1", [
      goods("c1", "V1", 1),
      { ...freeTextShipping("c2"), description: "Widget Pro stand", unit_price_minor: "9000" },
      freeTextShipping("c3"),
    ])
    const ctx = await ctxFor([doc])
    const { draft, facts, stagingRefuses } = await verdicts(ctx, doc.id)
    expect(draft.unresolved.map((u) => u.line.id)).toEqual(["c2"])
    expect(facts.needs_fix_reason).toBe("Unresolved pack")
    expect(stagingRefuses).toBe(true)
  })

  // Export (customs-required) routes: the customs declaration lists the same parcel lines the
  // resolver packs. A shipping charge is not goods, so it never becomes a weightless article that
  // blocks the label; a real product line always does, so goods are never left off a declaration.
  const exportInvoice = (id: string, lines: unknown[]) => ({
    ...invoice(id, lines),
    counterparty_country: "US",
    counterparty_name: "Test Importer Inc",
    requires_hs_code: true,
  })
  async function exportVerdicts(ctx: unknown, docId: string) {
    const draft = await shipmentDraftCreate(ctx as never, { document_ref: docId, orderShipTo: false })
    const facts = deriveDraftFacts(draft, docId)
    const pre = await createShipmentPreflight(ctx as never, { ...CREATE_INPUT, draft_id: docId })
    const stagingRefuses = "error" in pre && pre.error?.code === "unresolved_lines"
    return { draft, facts, stagingRefuses }
  }

  it("a non-EU export with a free-text Shipping line declares only the real goods, and nothing blocks", async () => {
    const doc = exportInvoice("00000000-0000-4000-8000-0000000000e1", [
      goods("e1", "V2", 2),
      goods("e2", "V3", 1),
      freeTextShipping("e3"),
      kindedShipping("e4"),
    ])
    const ctx = await ctxFor([doc])
    const { draft, facts, stagingRefuses } = await exportVerdicts(ctx, doc.id)
    expect(draft.customs_required).toBe(true)
    expect(draft.customsArticles.map((a) => a.line_id)).toEqual(["e1", "e2"])
    expect(draft.customsArticles.some((a) => a.blocked)).toBe(false)
    expect(draft.unresolved).toHaveLength(0)
    expect(facts.needs_fix_reason).toBeNull()
    expect(stagingRefuses).toBe(false)
  })

  it("a real product line with no product link stays on the export declaration, and blocks", async () => {
    const doc = exportInvoice("00000000-0000-4000-8000-0000000000e2", [
      goods("f1", "V2", 1),
      { ...freeTextShipping("f2"), description: "Widget Pro stand", unit_price_minor: "9000" },
      freeTextShipping("f3"),
    ])
    const ctx = await ctxFor([doc])
    const { draft, facts, stagingRefuses } = await exportVerdicts(ctx, doc.id)
    expect(draft.customsArticles.map((a) => a.line_id)).toEqual(["f1", "f2"])
    expect(draft.customsArticles.find((a) => a.line_id === "f2")).toMatchObject({ blocked: true, reason: "missing_weight" })
    expect(facts.needs_fix_reason).not.toBeNull()
    expect(stagingRefuses).toBe(true)
  })
})
