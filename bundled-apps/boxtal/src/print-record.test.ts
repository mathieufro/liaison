// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shipment's print record (print_record_get): the buy-time snapshot, the live tracking number,
// FedEx's "AWB", and nothing that the sources do not hold.
import { describe, expect, it } from "bun:test"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import {
  buildPrintSnapshot,
  carrierFamilyOf,
  printRecordGet,
  readPrintSnapshot,
  trackingLabelOf,
} from "./print-record"
import { createMockDb } from "./test-db"

const DRAFT = {
  document_number: "INV-2026-0042",
  invoice_issued_at: "2026-10-30",
  order_name: "#1001",
  lineSummaries: [
    {
      line_id: "l1",
      external_id: "SKU-PLATE",
      description: "Mounting plate",
      line_kind: "goods",
      quantity: 2,
      unit_price_minor: 1250,
      currency: "USD",
      hs_code: "7326.90",
      country_of_origin: "FR",
    },
    {
      line_id: "l2",
      external_id: null,
      description: "Shipping",
      line_kind: "shipping",
      quantity: 1,
      unit_price_minor: 2000,
      currency: "USD",
    },
  ],
  // The declared article (an operator corrected its HS code on the customs card) wins.
  customsArticles: [{ line_id: "l1", tariffNumber: "7326.90.85", originCountry: "FR" }],
}

const CUSTOMER = {
  contact: { firstName: "Ada", lastName: "Example", email: "ada@example.com", phone: "+15550100", company: "" },
  location: { street: "1 Main St", postalCode: "10001", city: "New York", state: "NY", countryIsoCode: "us" },
}

function ctxWith(rows: Array<Record<string, unknown>>, attributes: Array<Record<string, unknown>> = []) {
  const calls: string[] = []
  const executeTool = async (target: string): Promise<CrossAppEnvelope> => {
    calls.push(target)
    if (target === "kernel:product_attributes_list") return { status: "completed", result: { attributes } }
    return { status: "error", error: { code: "unmocked", message: target } }
  }
  const ctx: BoxtalToolCtx = {
    orgId: "org_1",
    db: createMockDb({ seed: { shipment: rows } }),
    fetch: (async () => new Response("")) as unknown as BoxtalToolCtx["fetch"],
    connections: {},
    config: { get: async () => null, has: async () => false },
    executeTool: executeTool as BoxtalToolCtx["executeTool"],
  }
  return { ctx, calls }
}

describe("carrier family and tracking label", () => {
  it("reads the family off the offer code, and FedEx calls its number an AWB", () => {
    expect(carrierFamilyOf("FEDX-InternationalEconomy")).toBe("fedex")
    expect(carrierFamilyOf("UPSE-StandardAP")).toBe("ups")
    expect(carrierFamilyOf(null)).toBeNull()
    expect(trackingLabelOf("fedex")).toBe("AWB")
    expect(trackingLabelOf("ups")).toBe("Tracking number")
    expect(trackingLabelOf(null)).toBe("Tracking number")
  })
})

describe("buildPrintSnapshot", () => {
  it("keeps the goods lines as they shipped, the declared HS code, and the label's customer", () => {
    const snap = buildPrintSnapshot(DRAFT, { offerCode: "FEDX-InternationalEconomy", carrierName: "FedEx", customer: CUSTOMER })
    expect(snap).toEqual({
      invoice: { number: "INV-2026-0042", date: "2026-10-30" },
      order: {
        name: "#1001",
        customer: "Ada Example",
        company: null,
        email: "ada@example.com",
        phone: "+15550100",
        address: { street: "1 Main St", postal_code: "10001", city: "New York", state: "NY", country_iso2: "US" },
      },
      carrier_name: "FedEx",
      carrier_family: "fedex",
      lines: [
        {
          description: "Mounting plate",
          sku: "SKU-PLATE",
          hts: "7326.90.85",
          origin: "FR",
          quantity: 2,
          value: 25,
          unit_value: 12.5,
          currency: "USD",
        },
      ],
    })
  })

  it("holds null for whatever the draft does not carry, never a default", () => {
    const snap = buildPrintSnapshot({ lineSummaries: [{ description: "Thing", quantity: 1 }] }, {})
    expect(snap.invoice).toEqual({ number: null, date: null })
    expect(snap.order.customer).toBeNull()
    expect(snap.carrier_family).toBeNull()
    expect(snap.carrier_name).toBeNull()
    expect(snap.lines[0]).toMatchObject({ sku: null, hts: null, origin: null, value: null, currency: null })
  })
})

describe("printRecordGet", () => {
  const snapshot = buildPrintSnapshot(DRAFT, { offerCode: "FEDX-InternationalEconomy", carrierName: "FedEx", customer: CUSTOMER })

  it("a row with no tracking number yet reads tracking_number null (not empty), labelled AWB for FedEx", async () => {
    const { ctx } = ctxWith([
      { id: "s1", offer_code: "FEDX-InternationalEconomy", tracking_number: null, queue_facts: { print: snapshot } },
    ])
    const rec = await printRecordGet(ctx, { shipment_id: "s1" })
    if ("error" in rec) throw new Error(rec.error.message)
    expect(rec.shipment.tracking_number).toBeNull()
    expect(rec.shipment.tracking_label).toBe("AWB")
    expect(rec.shipment.carrier_name).toBe("FedEx")
  })

  it("reads the snapshot taken at buy, the row's current tracking number and the product attributes", async () => {
    const { ctx, calls } = ctxWith(
      [{ id: "s2", offer_code: "UPSE-StandardAP", tracking_number: "1Z999", queue_facts: JSON.stringify({ print: snapshot }) }],
      [{ sku: "SKU-PLATE", key: "material", value: "steel" }],
    )
    const rec = await printRecordGet(ctx, { shipment_id: "s2" })
    if ("error" in rec) throw new Error(rec.error.message)
    expect(rec.invoice.number).toBe("INV-2026-0042")
    expect(rec.order.address.city).toBe("New York")
    expect(rec.destination.iso2).toBe("US")
    expect(rec.shipment.tracking_number).toBe("1Z999")
    // The family is the buy-time snapshot's, whatever the code says.
    expect(rec.shipment.carrier_family).toBe("fedex")
    expect(rec.lines).toHaveLength(1)
    expect(rec.lines[0]?.attributes).toEqual({ material: "steel" })
    expect(calls).toEqual(["kernel:product_attributes_list"])
  })

  it("the record holds only the documented keys: nothing a source does not have", async () => {
    const { ctx } = ctxWith([{ id: "s3", offer_code: "UPSE-StandardAP", queue_facts: { print: snapshot, extra: "x" } }])
    const rec = await printRecordGet(ctx, { shipment_id: "s3" })
    if ("error" in rec) throw new Error(rec.error.message)
    expect(Object.keys(rec).sort()).toEqual(["destination", "invoice", "lines", "order", "shipment"])
    expect(Object.keys(rec.shipment).sort()).toEqual([
      "carrier_family",
      "carrier_name",
      "id",
      "tracking_label",
      "tracking_number",
    ])
    expect(Object.keys(rec.lines[0] ?? {}).sort()).toEqual([
      "attributes",
      "currency",
      "description",
      "hts",
      "origin",
      "quantity",
      "sku",
      "unit_value",
      "value",
    ])
  })

  it("a row bought before the snapshot reads as blanks (and no product read), never as guesses", async () => {
    const { ctx, calls } = ctxWith([{ id: "s4", offer_code: "UPSE-StandardAP", tracking_number: null, queue_facts: { destination: "FR" } }])
    const rec = await printRecordGet(ctx, { shipment_id: "s4" })
    if ("error" in rec) throw new Error(rec.error.message)
    expect(rec.invoice).toEqual({ number: null, date: null })
    expect(rec.order.customer).toBeNull()
    expect(rec.lines).toEqual([])
    expect(rec.shipment).toMatchObject({ carrier_family: "ups", carrier_name: "UPS", tracking_number: null })
    expect(calls).toEqual([])
  })

  it("an unknown shipment answers a single error object (the kernel reports it as unavailable)", async () => {
    const { ctx } = ctxWith([])
    expect(await printRecordGet(ctx, { shipment_id: "nope" })).toEqual({
      error: { code: "not_found", message: 'No shipment row matches "nope".' },
    })
  })

  it("readPrintSnapshot is null for a row without one", () => {
    expect(readPrintSnapshot(null)).toBeNull()
    expect(readPrintSnapshot({ destination: "US" })).toBeNull()
    expect(readPrintSnapshot("not json")).toBeNull()
  })
})
