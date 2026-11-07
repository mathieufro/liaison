// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Order Prep Dashboard e2e chain (PLAN-order-prep-dashboard.md section 4, boxtal half):
//   orders/paid webhook -> invoicing auto-issues the goods invoice -> prep_list shows the row
//   with auto-resolved parcels -> prep_sync populates order meta + a cached quote -> edit
//   weight (shipment_draft_set_package) + a targeted prep_sync re-quotes (hash change) ->
//   create_shipment preflight passes -> the shipment CONFIRMED webhook (documentCreatedHandler)
//   triggers shopify:fulfillments_create and the row disappears from prep_list.
//
// HARNESS DECISION (see PLAN-order-prep-dashboard-ui-report.md, "E2e chain + stale-meta tests"):
// no precedent exists anywhere in bundled-apps/ for one bundled app's tests importing and
// driving another bundled app's real handler/tool functions directly (every existing bundled-app
// test file only exercises its own app; executeTool is always the mock boundary between apps).
// So this test does NOT introduce a novel cross-package import. It drives the REAL boxtal
// functions (prepList, prepSync, shipmentDraftSetPackagePersist, createShipmentPreflight,
// documentCreatedHandler) end to end, stubbing invoicing at the executeTool bridge boundary
// (invoicing:documents_search / invoicing:documents_get) with a fixture invoice shaped to match
// what bundled-apps/invoicing's real onShopifyOrderPaid handler would have issued for the same
// order (see __fixtures__/order-prep-chain.ts, and the invoicing-side coverage note below). The
// invoicing half (webhook -> auto-issued goods invoice) is ALREADY covered by
// bundled-apps/invoicing/src/handlers/shopify-order-paid.test.ts's "end-to-end: paid order with
// mapped issuer -> issued invoice + PDF in contact thread" test (assert docs[0].scope === "goods",
// external_refs.shopify_order_id set) — not duplicated here.

import { describe, expect, it } from "bun:test"
import {
  computePrepInputHash,
  prepList,
  prepSelectOffer,
  prepSetCategory,
  prepSetStatus,
  prepSync,
} from "./prep"
import { shipDisabledReason, shipParams } from "./ui/prep-row-logic"
import { resolveStageOffer } from "./prep-selection"
import { createShipment, createShipmentPreflight, shipmentDraftSetPackagePersist } from "./shipment"
import { documentCreatedHandler } from "./webhooks"
import { readyList } from "./queues"
import { printRecordGet } from "./print-record"
import { HOUSE_PACKAGING_POLICY } from "./__fixtures__/packaging-policy"
import { createMockDb } from "./test-db"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import { makeOrderScanStub } from "./__fixtures__/order-scan"
import {
  CHAIN_PRODUCT_EXTERNAL_ID,
  CHAIN_SHOPIFY_ORDER_ID,
  chainGoodsInvoiceFixture,
  chainShopifyOrderMeta,
} from "./__fixtures__/order-prep-chain"

const CREDS = { v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" }

/** The Boxtal order id the mocked v3 buy returns. The DOCUMENT_CREATED webhook is addressed to it. */
const BOXTAL_ORDER_ID = "boxtal-order-journey-1"

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

// Two carriers so a re-quote after a weight edit is meaningfully checkable (cheapest changes).
const DOMESTIC_XML_LIGHT = `<?xml version="1.0"?><cotation><shipment>
  <offer><mode>COM</mode><operator><code>MRLY</code><label>Mondial Relay</label></operator><service><code>Point</code><label>Point Relais</label></service><price><currency>EUR</currency><tax-exclusive>5.40</tax-exclusive><tax-inclusive>6.48</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-03</date><type><code>DELIVERY</code></type></delivery></offer>
  <offer><mode>COM</mode><operator><code>CHRP</code><label>Chronopost</label></operator><service><code>Chrono13</code><label>Chrono 13</label></service><price><currency>EUR</currency><tax-exclusive>9.80</tax-exclusive><tax-inclusive>11.76</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-02</date><type><code>DELIVERY</code></type></delivery></offer>
</shipment></cotation>`

// The heavier package (after the weight edit) only clears for the pricier carrier — a distinct
// cheapest offer proves the re-quote actually re-ran against the new weight, not a stale cache hit.
const DOMESTIC_XML_HEAVY = `<?xml version="1.0"?><cotation><shipment>
  <offer><mode>COM</mode><operator><code>UPSE</code><label>UPS</label></operator><service><code>Express</code><label>UPS Express</label></service><price><currency>EUR</currency><tax-exclusive>22.00</tax-exclusive><tax-inclusive>26.40</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-02</date><type><code>DELIVERY</code></type></delivery></offer>
</shipment></cotation>`

// Three offers: a cheap Mondial Relay Point Relais (a RELAY the default policy excludes) plus two
// door-to-door offers (Chronopost cheapest, UPS pricier) — for the pickup-policy + offer-selection e2e.
const DOMESTIC_XML_MIXED = `<?xml version="1.0"?><cotation><shipment>
  <offer><mode>COM</mode><operator><code>MRLY</code><label>Mondial Relay</label></operator><service><code>Point</code><label>Point Relais</label></service><price><currency>EUR</currency><tax-exclusive>5.40</tax-exclusive><tax-inclusive>6.48</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-03</date><type><code>DELIVERY</code></type></delivery></offer>
  <offer><mode>COM</mode><operator><code>CHRP</code><label>Chronopost</label></operator><service><code>Chrono13</code><label>Chrono 13</label></service><price><currency>EUR</currency><tax-exclusive>9.80</tax-exclusive><tax-inclusive>11.76</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-02</date><type><code>DELIVERY</code></type></delivery></offer>
  <offer><mode>COM</mode><operator><code>UPSE</code><label>UPS</label></operator><service><code>Express</code><label>UPS Express</label></service><price><currency>EUR</currency><tax-exclusive>18.00</tax-exclusive><tax-inclusive>21.60</tax-inclusive></price><collection><date>2026-06-01</date></collection><delivery><date>2026-06-02</date><type><code>DELIVERY</code></type></delivery></offer>
</shipment></cotation>`

interface ChainCtxState {
  cotationXml: string
  fulfillCalls: Array<{ target: string; args: unknown }>
  /** What Shopify reports for the chain order. The worklist scan reads it, so flipping this to
   *  FULFILLED is how the test says "the order has been fulfilled" (which is what drops the row). */
  fulfillmentStatus: string
}

function makeChainCtx(
  documentRef: string,
  opts?: { excludePickupPoint?: boolean; documentsForOrder?: boolean },
): {
  ctx: BoxtalToolCtx
  db: ReturnType<typeof createMockDb>
  state: ChainCtxState
  invoice: ReturnType<typeof chainGoodsInvoiceFixture>
} {
  const state: ChainCtxState = {
    cotationXml: DOMESTIC_XML_LIGHT,
    fulfillCalls: [],
    fulfillmentStatus: "UNFULFILLED",
  }
  const invoice = chainGoodsInvoiceFixture(documentRef)
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
        ...(typeof opts?.excludePickupPoint === "boolean"
          ? [{ id: "cfg-pickup", key: "exclude_pickup_point_services", value: opts.excludePickupPoint }]
          : []),
      ],
    },
  })
  const fetch = async (url: string, init?: { method?: string }) => {
    // The v3 order buy. Without a real order id here the shipment row carries none and the
    // DOCUMENT_CREATED webhook has nothing to match, so the label half of the chain is untestable.
    if (url.endsWith("/shipping-order") && (init?.method ?? "GET").toUpperCase() === "POST") {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          status: 200,
          timestamp: "t",
          content: {
            id: BOXTAL_ORDER_ID,
            status: "PENDING",
            deliveryPriceExclTax: { amount: 9.8, currency: "EUR" },
            expectedTakingOverDate: "2026-06-01",
            estimatedDeliveryDate: "2026-06-02",
          },
        }),
      }
    }
    if (url.includes("/iam/account-app/token")) {
      return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
    }
    if (url.includes("/cotation")) {
      return { status: 200, headers: {}, body: state.cotationXml }
    }
    if (url.includes("/shipping-document")) {
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: [{ url: "https://signed/label.pdf", type: "LABEL", format: "PDF_A4" }] }) }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
  }
  // The worklist scan is order-driven, so the chain's order reaches it through
  // shopify:orders_search + invoicing:documents_for_orders. Its name/tags/date are the ones the
  // fixture's shopify:orders_get would report, so prep_meta reads the same facts either way.
  let proformaSeq = 0
  const issuedProformaDocs = new Map<string, Record<string, unknown>>()
  const proformaLinesByDoc = new Map<
    string,
    Array<{ description: string; quantity: number; unit_price_minor: string; external_id: string | null }>
  >()
  const chainMeta = chainShopifyOrderMeta()
  // Rebuilt per call so the test can flip the order's fulfillment status mid-chain.
  const scanStub = (target: string, args?: Record<string, unknown>) =>
    makeOrderScanStub(opts?.documentsForOrder === false ? [] : [invoice as unknown as { id: string }], {
      ...(opts?.documentsForOrder === false
        ? {
            // The same open order, with NO document behind it: what an order looks like before
            // (or without) its invoice.
            extraOrders: [
              {
                order_id: CHAIN_SHOPIFY_ORDER_ID,
                name: chainShopifyOrderMeta().name,
                customer: "Acme France SAS",
                country: "FR",
              },
            ],
          }
        : {}),
      orderOverrides: {
        [documentRef]: {
          name: chainMeta.name,
          tags: chainMeta.tags,
          createdAt: chainMeta.createdAt,
          fulfillmentStatus: state.fulfillmentStatus,
        },
      },
    })(target, args)
  const executeTool = async (target: string, args: unknown): Promise<CrossAppEnvelope> => {
    const scanned = scanStub(target, args as Record<string, unknown>)
    if (scanned) return scanned
    if (target === "invoicing:documents_search") {
      return { status: "completed", result: [{ channel: "shopify", ...invoice }] }
    }
    if (target === "invoicing:documents_get") {
      const ref = typeof args === "string" ? args : ((args as { id?: string }).id ?? (args as { document_ref?: string }).document_ref)
      if (ref === documentRef) return { status: "completed", result: invoice }
      return { status: "completed", result: (ref && issuedProformaDocs.get(ref)) ?? null }
    }
    if (target === "kernel:contacts_read") {
      // The row's recipient comes from the linked contact record, exactly as in production, so the
      // ship-time address checks in these journeys are the real ones.
      const contactId = (args as { contactId?: string }).contactId ?? ""
      if (contactId !== "contact-chain-1") return { status: "completed", result: null }
      return {
        status: "completed",
        result: {
          contact: {
            metadata: {
              shipping_address: {
                name: "Prep Customer",
                email: "prep-customer@example.com",
                phone: "+33612345678",
                street: "5 rue du Test",
                city: "Lyon",
                postalCode: "69001",
                countryIsoCode: "FR",
              },
            },
          },
        },
      }
    }
    if (target === "invoicing:settings_issuer_profile_list") {
      return { status: "completed", result: [{ id: "issuer-chain", active: true }] }
    }
    if (target === "invoicing:proforma_create_and_issue") {
      // The issued proforma becomes a REAL document from here on: the draft resolver reads it back
      // through documents_get, which is what makes the parcel-fidelity assertion mean anything.
      const p = args as {
        counterparty?: { legal_name?: string; country?: string }
        items?: Array<Record<string, unknown>>
        shipment_ref?: string
      }
      proformaSeq += 1
      const id = `prof-chain-${proformaSeq}`
      const lines = (p.items ?? []).map((l, i) => ({
        id: `${id}-line-${i}`,
        description: String(l.description),
        quantity: Number(l.quantity),
        unit_price_minor: String(l.unit_price_minor),
        hs_code: (l.hs_code as string | undefined) ?? null,
        country_of_origin: (l.country_of_origin as string | undefined) ?? null,
        customs_description: (l.customs_description as string | undefined) ?? null,
        product_source: (l.product_source as string | undefined) ?? null,
        external_id: (l.external_id as string | undefined) ?? null,
      }))
      issuedProformaDocs.set(id, {
        id,
        currency: "EUR",
        incoterm: "DAP",
        counterparty_country: p.counterparty?.country ?? "FR",
        counterparty_name: p.counterparty?.legal_name ?? "Customer",
        counterparty_contact_id: null,
        shipment_ref: p.shipment_ref ?? null,
        number: `PF-${proformaSeq}`,
        issued_at: "2026-09-04",
        lines,
      })
      proformaLinesByDoc.set(id, lines)
      return { status: "completed", result: { status: "completed", document_id: id, number: `PF-${proformaSeq}` } }
    }
    if (target === "shopify:orders_get") {
      const id = (args as { id?: string }).id ?? ""
      return { status: "completed", result: id === CHAIN_SHOPIFY_ORDER_ID ? chainShopifyOrderMeta() : null }
    }
    if (target === "shopify:fulfillments_create") {
      state.fulfillCalls.push({ target, args })
      return { status: "completed", result: { id: "fulfillment-chain-1" } }
    }
    return { status: "error", error: { code: "unmocked", message: target } }
  }
  const ctx = {
      orgId: "org-1",
      db,
      fetch,
      executeTool,
      connections: { boxtal: { getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }), getToken: async () => { throw new Error("no") }, getAccounts: async () => [] } },
      config: { get: async () => null, has: async () => false },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    } as never as BoxtalToolCtx
  chainIssuedProformas.set(ctx as object, proformaLinesByDoc)
  return { ctx, db, state, invoice }
}

/** The lines the app actually issued on a row's proforma, read back through the same bridge the
 *  draft resolver uses. */
function chainProformaLines(
  ctx: BoxtalToolCtx,
  documentRef: string,
): Array<{ description: string; quantity: number; unit_price_minor: string; external_id: string | null }> {
  const issued = chainIssuedProformas.get(ctx)?.get(documentRef)
  return issued ?? []
}

/** Per-ctx record of what `invoicing:proforma_create_and_issue` was asked to issue. */
const chainIssuedProformas = new WeakMap<
  object,
  Map<string, Array<{ description: string; quantity: number; unit_price_minor: string; external_id: string | null }>>
>()

describe("order prep dashboard e2e chain (webhook -> invoice -> prep_list -> re-quote -> preflight -> fulfillment)", () => {
  it("drives the full chain to a real output: the row appears, re-quotes on a real weight change, preflight passes, and the row leaves prep_list once the shipment is live", async () => {
    const documentRef = "doc-chain-1"
    // excludePickupPoint:false keeps the light-package fixture's Mondial Relay Point Relais offer
    // (a relay service the default-on policy would exclude) so the cheapest-changes-on-re-quote
    // chain stays checkable. The pickup-point policy itself is exercised in its own e2e below.
    const { ctx, db, state } = makeChainCtx(documentRef, { excludePickupPoint: false })

    // Step 1: prep_list shows the row with auto-resolved parcels (from the shipping_profile
    // resolver, no Shopify/quote calls yet — the goods invoice already exists per the invoicing
    // fixture, standing in for the real onShopifyOrderPaid webhook already covered in
    // bundled-apps/invoicing/src/handlers/shopify-order-paid.test.ts).
    const initialList = await prepList(ctx, {})
    expect(initialList.rows).toHaveLength(1)
    const initialRow = initialList.rows[0]!
    expect(initialRow.document_ref).toBe(documentRef)
    // The list read is now order-driven and resolves NO drafts: an anchor with no cache entry is
    // honestly reported as not_synced with an empty parcel list, never a fabricated one.
    expect(initialRow.parcels).toHaveLength(0)
    expect(initialRow.state).toBe("not_synced")

    // Step 2: prep_sync populates order meta (from shopify:orders_get) + a cached quote.
    const firstSync = await prepSync(ctx, {})
    const firstSyncRow = firstSync.rows.find((r) => r.document_ref === documentRef)!
    expect(firstSyncRow.synced_meta).toBe(true)
    expect(firstSyncRow.requoted).toBe(true)
    const metaAfterSync = db.__all("prep_meta").find((m) => m.document_ref === documentRef)!
    expect(metaAfterSync.order_name).toBe("#5001")
    const quoteAfterFirstSync = db.__all("prep_quote").find((q) => q.document_ref === documentRef)!
    const firstOffers = quoteAfterFirstSync.offers as Array<{ carrier: string; price_ht_minor: number }>
    expect(firstOffers[0]!.carrier).toBe("Mondial Relay") // cheapest of the light-package offers
    const listAfterFirstSync = await prepList(ctx, {})
    const rowAfterFirstSync = listAfterFirstSync.rows.find((r) => r.document_ref === documentRef)!
    expect(rowAfterFirstSync.state).toBe("ready")
    // prep_sync resolved the draft into prep_draft_cache, so the parcels and the product summary
    // are now on the row (they were absent before the sync, above).
    expect(rowAfterFirstSync.parcels).toHaveLength(1)
    expect(rowAfterFirstSync.parcels[0]).toMatchObject({ length: 30, width: 25, height: 8, weight: 2.5 })
    expect(rowAfterFirstSync.products).toBe("1xK6")
    expect(rowAfterFirstSync.quote.cheapest).toMatchObject({ carrier: "Mondial Relay" })
    expect(rowAfterFirstSync.quote.stale).toBe(false)

    // Step 3: edit the weight via shipment_draft_set_package (a heavier carton only the pricier
    // carrier's cotation offer covers) — the persisted override changes the draft's parcels, so
    // the row's input_hash changes.
    const hashBeforeEdit = computePrepInputHash({
      destination_country: "FR",
      parcels: [{ length: 30, width: 25, height: 8, weight: 2.5 }],
      category: "sale",
    })
    expect(quoteAfterFirstSync.input_hash).toBe(hashBeforeEdit)
    await shipmentDraftSetPackagePersist(ctx, {
      draft_id: documentRef,
      override: { length: 40, width: 35, height: 30, weight: 12 },
    })
    state.cotationXml = DOMESTIC_XML_HEAVY // the heavier parcel now only clears UPS in this fixture

    // Step 4: a targeted prep_sync (scoped via document_refs) re-quotes because the hash changed —
    // must NOT be a stale cache hit: assert the quote content actually changed (new cheapest
    // carrier, not the old Mondial Relay cache) and that a fresh cotation call happened.
    const targetedSync = await prepSync(ctx, { document_refs: [documentRef] })
    const targetedRow = targetedSync.rows.find((r) => r.document_ref === documentRef)!
    expect(targetedRow.requoted).toBe(true)
    const quoteAfterEdit = db.__all("prep_quote").find((q) => q.document_ref === documentRef)!
    const hashAfterEdit = computePrepInputHash({
      destination_country: "FR",
      parcels: [{ length: 40, width: 35, height: 30, weight: 12 }],
      category: "sale",
    })
    expect(quoteAfterEdit.input_hash).not.toBe(hashBeforeEdit)
    expect(quoteAfterEdit.input_hash).toBe(hashAfterEdit)
    const offersAfterEdit = quoteAfterEdit.offers as Array<{ carrier: string; price_ht_minor: number }>
    expect(offersAfterEdit[0]!.carrier).toBe("UPS")
    expect(offersAfterEdit.some((o) => o.carrier === "Mondial Relay")).toBe(false)
    const listAfterEdit = await prepList(ctx, {})
    const rowAfterEdit = listAfterEdit.rows.find((r) => r.document_ref === documentRef)!
    expect(rowAfterEdit.parcels[0]).toMatchObject({ length: 40, width: 35, height: 30, weight: 12 })
    expect(rowAfterEdit.quote.cheapest).toMatchObject({ carrier: "UPS" })
    expect(rowAfterEdit.quote.stale).toBe(false)

    // Step 5: create_shipment preflight passes given the edited package (no unresolved lines, no
    // blocked customs articles, no duplicate in-flight shipment for this document).
    const preflight = await createShipmentPreflight(ctx, {
      draft_id: documentRef,
      offer_code: "UPSE-Express",
      quoted_price_ttc: 12.5,
      // Stage-time party validation (0.2.11) requires the full recipient
      // contact — the operator confirms these on the prep dashboard.
      recipient_phone: "+33612345678",
      recipient_address: {
        name: "Prep Customer",
        email: "prep-customer@example.com",
        street: "5 rue du Test",
        city: "Lyon",
        postalCode: "69001",
        countryIsoCode: "FR",
      },
    })
    expect(preflight).toEqual({ ok: true })

    // Step 6: simulate the shipment reaching CONFIRMED (a live create_shipment would insert this
    // "shipment" row and call the v3 API; here we seed the row a create_shipment call would have
    // produced, then fire the real CONFIRMED webhook to prove auto-fulfillment still runs even
    // though the worklist no longer waits on it).
    await db.insert("shipment", {
      boxtal_order_id: "boxtal-order-chain-1",
      document_ref: documentRef,
      order_status: "PENDING",
      tracking_status: null,
      tracking_number: "TRK-CHAIN-1",
      status_fetched_at: null,
      documents: [],
      fulfillment_synced: false,
    })

    // The row leaves prep_list the moment this live shipment covers the whole invoice (no
    // partial line split was requested, so coverage.full flips true on insert), well before
    // Shopify has heard anything. The work is not lost: it moved to the Ready queue, where the
    // shipment is reachable by its own invoice ref for printing and packing.
    const listAfterBuy = await prepList(ctx, {})
    expect(listAfterBuy.rows.some((r) => r.document_ref === documentRef)).toBe(false)
    const readyAfterBuy = await readyList(ctx)
    expect(readyAfterBuy.rows.some((r) => r.invoice_ref === documentRef)).toBe(true)

    const webhookResult = await documentCreatedHandler(
      { eventType: "DOCUMENT_CREATED", orderId: "boxtal-order-chain-1" },
      ctx,
      { "x-bxt-delivery-id": "del-chain-1" },
    )
    expect(webhookResult.status).toBe(200)
    // shopify:fulfillments_create still runs off the CONFIRMED webhook (real output, not a proxy):
    // the worklist stopped waiting on Shopify's fulfilment signal for THIS decision, but the app
    // still reports the order fulfilled once Boxtal confirms it.
    expect(state.fulfillCalls).toHaveLength(1)
    // The GID, not the bare numeric id the chain stores. shopify:fulfillments_create binds this to
    // the GraphQL `ID!` of its fulfillment-order lookup, which rejects the numeric form outright, so
    // asserting the stored shape here is asserting the bug: in prod on 2026-09-16 every parcel
    // shipped with its Shopify order left unfulfilled and no tracking mail sent.
    expect((state.fulfillCalls[0]!.args as { orderId: string }).orderId).toBe(
      `gid://shopify/Order/${CHAIN_SHOPIFY_ORDER_ID}`,
    )
    const shipmentRow = db.__all("shipment").find((s) => s.boxtal_order_id === "boxtal-order-chain-1")!
    expect(shipmentRow.fulfillment_synced).toBe(true)
    expect(shipmentRow.order_status).toBe("CONFIRMED")

    // The row stays out of prep_list whether or not Shopify ever reports the order fulfilled: the
    // local shipment table, not Shopify's fulfilment signal, is the authority this queue relies on.
    state.fulfillmentStatus = "FULFILLED"
    const finalList = await prepList(ctx, {})
    expect(finalList.rows.some((r) => r.document_ref === documentRef)).toBe(false)
  })

  it("default policy keeps relay offers out of the cached cheapest, and the operator's chosen offer drives staging", async () => {
    const documentRef = "doc-chain-pick"
    // Default (prod) policy: relay / pickup-point offers excluded.
    const { ctx, state } = makeChainCtx(documentRef)
    state.cotationXml = DOMESTIC_XML_MIXED

    await prepSync(ctx, {})
    const listed = await prepList(ctx, {})
    const row = listed.rows.find((r) => r.document_ref === documentRef)!

    // Part 1: the cached cheapest is a DOOR-TO-DOOR offer, never the (cheaper) Mondial Relay Point
    // Relais — a B2C order is not quoted at a relay price. No relay offer survives into the cache.
    expect(row.quote.cheapest?.carrier).toBe("Chronopost")
    expect(row.quote.offers.some((o) => o.carrier === "Mondial Relay")).toBe(false)
    expect(row.quote.offers.some((o) => o.is_pickup_point)).toBe(false)

    // Part 2: the operator picks the pricier UPS offer; staging then resolves to THAT, not the cheapest.
    const upsCode = row.quote.offers.find((o) => o.carrier === "UPS")!.offer_code
    await prepSelectOffer(ctx, { document_ref: documentRef, offer_code: upsCode })
    const listed2 = await prepList(ctx, {})
    const row2 = listed2.rows.find((r) => r.document_ref === documentRef)!
    expect(row2.quote.selected?.carrier).toBe("UPS")
    expect(row2.quote.selected?.offer_code).not.toBe(row2.quote.cheapest?.offer_code)

    const stage = await resolveStageOffer(ctx, documentRef)
    expect(stage).toMatchObject({ offer_code: upsCode, source: "selected" })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The reworked row lifecycle, through the REAL handlers (blueprint Task 10).
//
// The chain above proves the pre-rework sale path still works end to end. These prove the parts the
// rework added: an order with no invoice is a row, a repair row ships on a proforma the app issues,
// a hold blocks the buy, a refusal leaves the row unshipped, and the label only lights up once
// Boxtal has produced one.
// ─────────────────────────────────────────────────────────────────────────────

describe("prep row lifecycle (order-driven)", () => {
  const RECIPIENT = {
    name: "Prep Customer",
    email: "prep-customer@example.com",
    street: "5 rue du Test",
    city: "Lyon",
    postalCode: "69001",
    countryIsoCode: "FR",
  }

  it("journey A (sale): open order -> not_synced -> synced -> validated -> label bought -> row moves to the Ready queue", async () => {
    const documentRef = "doc-journey-a"
    const { ctx, db, state } = makeChainCtx(documentRef)
    const orderKey = `so:${CHAIN_SHOPIFY_ORDER_ID}`

    // 1. The row exists off the ORDER, and is honest about never having been synced.
    const first = await prepList(ctx, {})
    expect(first.rows).toHaveLength(1)
    expect(first.rows[0]).toMatchObject({ order_key: orderKey, document_ref: documentRef, state: "not_synced" })
    expect(first.rows[0]!.invoice.state).toBe("issued")

    // 2. Pull orders resolves the draft and quotes it.
    await prepSync(ctx, {})
    const synced = (await prepList(ctx, { order_keys: [orderKey] })).rows[0]!
    expect(synced.state).toBe("ready")
    expect(shipDisabledReason(synced)).toBeNull()

    // 3. The operator validates the row. The status is per ORDER, and the row carries it.
    await prepSetStatus(ctx, { order_key: orderKey, status: "validated" })
    const validated = (await prepList(ctx, { order_keys: [orderKey] })).rows[0]!
    expect(validated.status).toBe("validated")
    expect(validated.validated).toBe(true)

    // 4. Ship: the params come from the SAME pure builder the grid uses, so the price handed to
    //    create_shipment is in major units (a minor-unit price would pass every price check).
    const params = shipParams(validated)!
    expect(params.quoted_price_ttc).toBeCloseTo(validated.quote.cheapest!.price_ttc_minor / 100, 6)
    const bought = await createShipment(ctx, {
      ...params,
      recipient_address: RECIPIENT,
      recipient_phone: "+33612345678",
    })
    expect("error" in bought ? bought.error : null).toBeNull()

    // 5. The row leaves prep_list the moment the shipment is live: this buy covers the whole
    //    invoice (no line split was requested), so coverage.full flips true as soon as the
    //    shipment is reserved, not when Shopify later reports the order fulfilled. The work is
    //    not gone, it moved: the shipment is now reachable in the Ready queue, with no label yet
    //    (Boxtal produces it asynchronously).
    expect((await prepList(ctx, { order_keys: [orderKey] })).rows).toHaveLength(0)
    const readyBeforeLabel = (await readyList(ctx)).rows.find((r) => r.invoice_ref === documentRef)
    expect(readyBeforeLabel).toBeDefined()
    expect(readyBeforeLabel!.has_label).toBe(false)

    // 6. The DOCUMENT_CREATED webhook lands the label. The row stays out of prep_list; the SAME
    //    Ready row now carries the label.
    const hook = await documentCreatedHandler(
      { eventType: "DOCUMENT_CREATED", orderId: BOXTAL_ORDER_ID },
      ctx,
      { "x-bxt-delivery-id": "del-journey-a" },
    )
    expect(hook.status).toBe(200)
    const readyAfterLabel = (await readyList(ctx)).rows.find((r) => r.invoice_ref === documentRef)
    expect(readyAfterLabel).toBeDefined()
    expect(readyAfterLabel!.has_label).toBe(true)

    // 7. And the label the button opens is a real Boxtal document with a URL behind it. (The
    //    import + PDF-normalization half of print_pack has its own suite in print-pack.test.ts;
    //    what this journey owns is that the shipment reached a state where a label exists to
    //    print.)
    const docs = db.__all("shipment")[0]!.documents as Array<{ type: string; format?: string }>
    expect(docs.some((d) => d.type === "LABEL")).toBe(true)

    // 8. The label alone does NOT fulfill the order in Shopify: Boxtal assigns the tracking
    //    number later, and auto-fulfillment waits for it (maybeAutoFulfill returns early without
    //    one). prep_list has already dropped the row regardless: it no longer waits on Shopify's
    //    fulfilment signal for this decision.
    expect(state.fulfillCalls).toHaveLength(0)
    expect((await prepList(ctx, {})).rows).toHaveLength(0)

    // Shopify eventually reporting the order fulfilled changes nothing here: the row was already
    // out of prep_list on the strength of the local shipment alone.
    state.fulfillmentStatus = "FULFILLED"
    expect((await prepList(ctx, {})).rows).toHaveLength(0)
  })

  it("the label buy snapshots the print record: an invoice amended afterwards does not change it", async () => {
    const documentRef = "doc-journey-print"
    const { ctx, db, invoice } = makeChainCtx(documentRef)
    const orderKey = `so:${CHAIN_SHOPIFY_ORDER_ID}`
    await prepSync(ctx, {})
    await prepSetStatus(ctx, { order_key: orderKey, status: "validated" })
    const row = (await prepList(ctx, { order_keys: [orderKey] })).rows[0]!
    const bought = await createShipment(ctx, {
      ...shipParams(row)!,
      recipient_address: RECIPIENT,
      recipient_phone: "+33612345678",
    })
    expect("error" in bought ? bought.error : null).toBeNull()
    const shipmentId = String(db.__all("shipment")[0]!.id)
    const facts = db.__all("shipment")[0]!.queue_facts as { skus?: unknown; carrier_family?: unknown }
    expect(facts.skus).toEqual([invoice.lines[0]!.external_id])
    expect(typeof facts.carrier_family === "string" || facts.carrier_family === null).toBe(true)

    const before = await printRecordGet(ctx, { shipment_id: shipmentId })
    if ("error" in before) throw new Error(before.error.message)
    expect(before.invoice.date).toBe("2026-07-01")
    expect(before.order.address).toMatchObject({ street: "5 rue du Test", city: "Lyon", postal_code: "69001", country_iso2: "FR" })
    expect(before.lines).toHaveLength(1)
    expect(before.lines[0]).toMatchObject({ sku: invoice.lines[0]!.external_id, hts: "9207.90", origin: "FR", quantity: 1 })
    expect(before.shipment.tracking_number).toBeNull()

    // The invoice is amended after the buy: new SKU, HS code, origin and date.
    invoice.issued_at = "2026-08-15"
    invoice.lines[0]!.external_id = "SKU-CHANGED"
    invoice.lines[0]!.hs_code = "0000.00"
    invoice.lines[0]!.country_of_origin = "CN"
    const after = await printRecordGet(ctx, { shipment_id: shipmentId })
    expect(after).toEqual(before)
    const ready = (await readyList(ctx)).rows.find((r) => r.id === shipmentId)!
    // The rules still match on the SKU that shipped, not the amended one.
    expect(ready.skus).toEqual([before.lines[0]?.sku ?? "missing"])
  })

  it("journey B (repair): the category issues a per-item proforma and the parcel declares every item on it", async () => {
    const documentRef = "doc-journey-b"
    const { ctx } = makeChainCtx(documentRef)
    const orderKey = `so:${CHAIN_SHOPIFY_ORDER_ID}`

    const res = await prepSetCategory(ctx, { order_key: orderKey, category: "repair" })
    expect(res.error).toBeUndefined()
    const row = res.row!
    // The row is now anchored on the PROFORMA, not on the sale invoice.
    expect(row.anchor_kind).toBe("proforma")
    expect(row.document_ref).not.toBe(documentRef)
    expect(row.category).toBe("repair")
    expect(row.invoice.state).toBe("issued")

    // PARCEL FIDELITY: the proforma carries one line per physical item with the SAME catalog
    // reference the invoice used, so the draft resolves to the same parcels. A single "1x repair"
    // summary line would resolve to one parcel and declare nothing that is in the box.
    const proformaLines = chainProformaLines(ctx, row.document_ref!)
    expect(proformaLines).toHaveLength(1)
    expect(proformaLines[0]!.description).toContain("RETURN AFTER REPAIR - NO COMMERCIAL VALUE")
    expect(proformaLines[0]!.external_id).toBe(CHAIN_PRODUCT_EXTERNAL_ID)
    expect(row.parcels).toHaveLength(1)
    expect(row.parcels[0]).toMatchObject({ length: 30, width: 25, height: 8, weight: 2.5 })
    // 1 EUR total, and the customs basis follows the DOCUMENT.
    const totalMinor = proformaLines.reduce((s, l) => s + Number(l.unit_price_minor) * l.quantity, 0)
    expect(totalMinor).toBe(100)
  })

  it("journey C (hold): on hold blocks the buy and says so; clearing it restores the button", async () => {
    const documentRef = "doc-journey-c"
    const { ctx } = makeChainCtx(documentRef)
    const orderKey = `so:${CHAIN_SHOPIFY_ORDER_ID}`
    await prepSync(ctx, {})

    await prepSetStatus(ctx, { order_key: orderKey, status: "on_hold", note: "waiting on a part" })
    const held = (await prepList(ctx, { order_keys: [orderKey] })).rows[0]!
    expect(held.status).toBe("on_hold")
    expect(held.status_note).toBe("waiting on a part")
    expect(shipDisabledReason(held)).toContain("on hold")

    await prepSetStatus(ctx, { order_key: orderKey, status: "to_prepare" })
    const cleared = (await prepList(ctx, { order_keys: [orderKey] })).rows[0]!
    expect(shipDisabledReason(cleared)).toBeNull()
  })

  it("journey D (refusal): a refused buy leaves the row unshipped and returns the reason unchanged", async () => {
    const documentRef = "doc-journey-d"
    const { ctx } = makeChainCtx(documentRef)
    const orderKey = `so:${CHAIN_SHOPIFY_ORDER_ID}`
    await prepSync(ctx, {})
    const row = (await prepList(ctx, { order_keys: [orderKey] })).rows[0]!

    // A price that no longer matches the live re-quote: the price oracle refuses the buy.
    const refused = await createShipment(ctx, {
      ...shipParams(row)!,
      quoted_price_ttc: 0.01,
      recipient_address: RECIPIENT,
      recipient_phone: "+33612345678",
    })
    expect("error" in refused).toBe(true)
    const after = (await prepList(ctx, { order_keys: [orderKey] })).rows[0]!
    expect(after.shipment).toBeNull()
    expect(shipDisabledReason(after)).toBeNull() // still shippable, nothing was consumed
  })

  it("journey E (no invoice): the order is still a row, and flips to issued when the invoice lands", async () => {
    const documentRef = "doc-journey-e"
    const { ctx } = makeChainCtx(documentRef, { documentsForOrder: false })
    const orderKey = `so:${CHAIN_SHOPIFY_ORDER_ID}`

    const before = (await prepList(ctx, {})).rows[0]!
    expect(before.order_key).toBe(orderKey)
    expect(before.document_ref).toBeNull()
    expect(before.state).toBe("needs_document")
    expect(before.invoice.state).toBe("missing")
    expect(shipDisabledReason(before)).toContain("No invoice issued for this order yet")

    // The invoicing app issues the goods invoice. The SAME row now anchors on it.
    const { ctx: withInvoice } = makeChainCtx(documentRef)
    const after = (await prepList(withInvoice, { order_keys: [orderKey] })).rows[0]!
    expect(after.document_ref).toBe(documentRef)
    expect(after.invoice.state).toBe("issued")
  })

  it("journey A (sale): Ship stays enabled once every recipient field, including phone shape, resolves clean", async () => {
    // ticket 10419: a complete, correctly-shaped recipient (real chain: order -> contact ->
    // resolved draft) must not be blocked. The NEGATIVE case -- a bad phone actually blocking
    // Ship, driven end to end rather than hand-injected onto a fixture row -- lives in
    // prep.test.ts's "recipient_phone_issue" suite, which exercises a genuine US destination
    // carrying a French-shaped phone through the same real resolveDraftCache path.
    const documentRef = "doc-journey-a-phone"
    const { ctx } = makeChainCtx(documentRef)
    const orderKey = `so:${CHAIN_SHOPIFY_ORDER_ID}`
    await prepSync(ctx, {})
    const synced = (await prepList(ctx, { order_keys: [orderKey] })).rows[0]!
    expect(shipDisabledReason(synced)).toBeNull()
  })
})
