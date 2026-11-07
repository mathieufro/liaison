// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Partial shipments: ship a subset of an invoice's lines now, the rest later.
// The legal invoice is never split (French e-invoicing); each batch is its own
// shipment row (document_ref, kind, batch_seq) carrying a line_quantities
// snapshot, and the to-prepare worklist keeps the invoice visible until every
// unit has a live batch.

import { describe, expect, it } from "bun:test"
import { reserveCreate } from "./link-store"
import { readyList, toPrepareList } from "./queues"
import { issueBatchProforma, shipmentDraftCreate } from "./shipment"
import { createMockDb } from "./test-db"
// The netting proforma_create_and_issue applies to a typed price under prices_include_tax.
import { netOfIncludedTax } from "../../invoicing/src/money"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import { makeOrderScanStub, type OrderScanStubOptions } from "./__fixtures__/order-scan"

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

/** A 5-unit single-line invoice to a non-EU country (customs required). */
function bulkInvoice(id: string, opts?: { quantity?: number; country?: string }) {
  return {
    id,
    currency: "EUR",
    incoterm: "DAP",
    counterparty_country: opts?.country ?? "US",
    counterparty_name: `Dealer ${id}`,
    counterparty_contact_id: `contact-${id}`,
    shopify_order_id: `gid://shopify/Order/${id}`,
    shopify_order_number: `#${id}`,
    issued_at: "2026-07-01",
    lines: [
      {
        id: `line-${id}`,
        description: "Tessera 2",
        quantity: opts?.quantity ?? 5,
        unit_price_minor: "69900",
        hs_code: "9207.90",
        country_of_origin: "FR",
        customs_description: "RAL-44",
        product_source: "shopify",
        external_id: "RAL-44",
      },
    ],
  }
}

function makeCtx(opts: {
  invoices: Array<ReturnType<typeof bulkInvoice>>
  seed?: Record<string, Array<Record<string, unknown>>>
  scan?: OrderScanStubOptions
}): { ctx: BoxtalToolCtx; db: ReturnType<typeof createMockDb> } {
  const byId = new Map(opts.invoices.map((d) => [d.id, d]))
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
      app_config: [{ id: "cfg-sender", key: "sender_address", value: SENDER_PARTY }],
      ...opts.seed,
    },
  })
  const scanStub = makeOrderScanStub(opts.invoices as never, opts.scan ?? {})
  const executeTool = async (target: string, args: unknown): Promise<CrossAppEnvelope> => {
    const scanned = scanStub(target, args as Record<string, unknown>)
    if (scanned) return scanned
    if (target === "invoicing:documents_search") {
      return { status: "completed", result: opts.invoices.map((d) => ({ channel: "shopify", ...d })) }
    }
    if (target === "invoicing:documents_get") {
      const ref =
        typeof args === "string"
          ? args
          : ((args as { id?: string }).id ?? (args as { document_ref?: string }).document_ref)
      return { status: "completed", result: (ref && byId.get(ref)) ?? null }
    }
    return { status: "error", error: { code: "unmocked", message: target } }
  }
  return {
    ctx: {
      orgId: "org-1",
      db,
      fetch: async () => ({ status: 200, headers: {}, body: "{}" }),
      executeTool,
      connections: {
        boxtal: {
          getSettings: async () => ({ values: { environment: "sandbox" }, missing: [] }),
          getToken: async () => {
            throw new Error("no")
          },
          getAccounts: async () => [],
        },
      },
      config: { get: async () => null, has: async () => false },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    } as never,
    db,
  }
}

describe("partial shipments — subset drafts", () => {
  it("shipmentDraftCreate with a line subset derives parcels, customs and totals from the subset only", async () => {
    const inv = bulkInvoice("inv-1", { quantity: 5 })
    const { ctx } = makeCtx({ invoices: [inv] })
    const draft = await shipmentDraftCreate(ctx, {
      document_ref: "inv-1",
      lines: [{ line_id: "line-inv-1", quantity: 2 }],
    })
    // Customs article carries the SHIPPED quantity, not the invoice quantity.
    expect(draft.customsArticles).toHaveLength(1)
    expect(draft.customsArticles[0]?.quantity).toBe(2)
    // Parcels pack 2 units, not 5.
    const totalWeight = draft.parcels.reduce((s, p) => s + p.weight, 0)
    expect(totalWeight).toBe(5) // 2 units x 2.5kg
    // Line summaries reflect the subset.
    expect(draft.lineSummaries[0]?.quantity).toBe(2)
  })

  it("requesting more than the invoice line quantity is rejected", async () => {
    const inv = bulkInvoice("inv-1", { quantity: 5 })
    const { ctx } = makeCtx({ invoices: [inv] })
    await expect(
      shipmentDraftCreate(ctx, {
        document_ref: "inv-1",
        lines: [{ line_id: "line-inv-1", quantity: 9 }],
      }),
    ).rejects.toThrow(/exceed/i)
  })

  it("an unknown line_id is rejected", async () => {
    const inv = bulkInvoice("inv-1")
    const { ctx } = makeCtx({ invoices: [inv] })
    await expect(
      shipmentDraftCreate(ctx, {
        document_ref: "inv-1",
        lines: [{ line_id: "nope", quantity: 1 }],
      }),
    ).rejects.toThrow(/line/i)
  })
})

describe("partial shipments — batch reservation", () => {
  it("a second outbound batch reserves with the next batch_seq while a partial batch is live", async () => {
    const { ctx } = makeCtx({
      invoices: [bulkInvoice("inv-1", { quantity: 5 })],
      seed: {
        shipment: [
          {
            id: "ship-1",
            document_ref: "inv-1",
            kind: "outbound",
            order_status: "CONFIRMED",
            link_state: "created",
            batch_seq: 1,
            line_quantities: [{ line_id: "line-inv-1", external_id: "RAL-44", quantity: 2 }],
          },
        ],
      },
    })
    const res = await reserveCreate(ctx as never, {
      document_ref: "inv-1",
      kind: "outbound",
      line_quantities: [{ line_id: "line-inv-1", external_id: "RAL-44", quantity: 3 }],
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      const row = (await (ctx as never as { db: ReturnType<typeof createMockDb> }).db.findMany("shipment", {
        where: { id: res.id },
        limit: 1,
      })) as Array<Record<string, unknown>>
      expect(row[0]?.batch_seq).toBe(2)
    }
  })

  it("a FULL (no line_quantities) reserve is still rejected while any outbound batch is live", async () => {
    const { ctx } = makeCtx({
      invoices: [bulkInvoice("inv-1")],
      seed: {
        shipment: [
          {
            id: "ship-1",
            document_ref: "inv-1",
            kind: "outbound",
            order_status: "CONFIRMED",
            link_state: "created",
            batch_seq: 1,
            line_quantities: [{ line_id: "line-inv-1", external_id: "RAL-44", quantity: 2 }],
          },
        ],
      },
    })
    const res = await reserveCreate(ctx as never, { document_ref: "inv-1", kind: "outbound" })
    expect(res.ok).toBe(false)
  })

  it("a live FULL shipment still blocks any further batch (unchanged legacy behavior)", async () => {
    const { ctx } = makeCtx({
      invoices: [bulkInvoice("inv-1")],
      seed: {
        shipment: [
          {
            id: "ship-1",
            document_ref: "inv-1",
            kind: "outbound",
            order_status: "CONFIRMED",
            link_state: "created",
          },
        ],
      },
    })
    const res = await reserveCreate(ctx as never, {
      document_ref: "inv-1",
      kind: "outbound",
      line_quantities: [{ line_id: "line-inv-1", external_id: "RAL-44", quantity: 1 }],
    })
    expect(res.ok).toBe(false)
  })
})

describe("partial shipments — to-prepare worklist", () => {
  it("an invoice with a live PARTIAL batch stays in the worklist with remaining units", async () => {
    const { ctx } = makeCtx({
      invoices: [bulkInvoice("inv-1", { quantity: 5 })],
      seed: {
        shipment: [
          {
            id: "ship-1",
            document_ref: "inv-1",
            kind: "outbound",
            order_status: "CONFIRMED",
            link_state: "created",
            batch_seq: 1,
            line_quantities: [{ line_id: "line-inv-1", external_id: "RAL-44", quantity: 2 }],
          },
        ],
      },
    })
    const list = await toPrepareList(ctx, {})
    const row = list.rows.find((r) => r.id === "inv-1")
    expect(row).toBeTruthy()
    expect(row?.partially_shipped).toBe(true)
    expect(row?.remaining_units).toBe(3)
  })

  // POST-REWORK: the worklist is ORDER-driven, so a fully covered invoice does not vanish the
  // instant the last label is bought -- the order is still unfulfilled and the parcels are still on
  // the bench. The row says there is nothing left to pack, and it leaves when Shopify reports the
  // order fulfilled (which the label webhook does).
  it("an invoice whose batches cover every unit shows nothing left to pack, and leaves once the order is fulfilled", async () => {
    const { ctx } = makeCtx({
      invoices: [bulkInvoice("inv-1", { quantity: 5 })],
      seed: {
        shipment: [
          {
            id: "ship-1",
            document_ref: "inv-1",
            kind: "outbound",
            order_status: "CONFIRMED",
            link_state: "created",
            batch_seq: 1,
            line_quantities: [{ line_id: "line-inv-1", external_id: "RAL-44", quantity: 2 }],
          },
          {
            id: "ship-2",
            document_ref: "inv-1",
            kind: "outbound",
            order_status: "CONFIRMED",
            link_state: "created",
            batch_seq: 2,
            line_quantities: [{ line_id: "line-inv-1", external_id: "RAL-44", quantity: 3 }],
          },
        ],
      },
    })
    const list = await toPrepareList(ctx, {})
    const row = list.rows.find((r) => r.id === "inv-1")!
    expect(row.prep_status).toBe("needs_fix")
    expect(row.reason).toBe("Every unit already has a live shipment")

    const fulfilled = makeCtx({
      invoices: [bulkInvoice("inv-1", { quantity: 5 })],
      scan: { orderOverrides: { "inv-1": { fulfillmentStatus: "FULFILLED" } } },
    })
    expect((await toPrepareList(fulfilled.ctx, {})).rows).toHaveLength(0)
  })

  it("a live FULL shipment (null line_quantities) moves the row to the Ready queue right away", async () => {
    const { ctx } = makeCtx({
      invoices: [bulkInvoice("inv-1")],
      seed: {
        shipment: [
          {
            id: "ship-1",
            document_ref: "inv-1",
            kind: "outbound",
            order_status: "PENDING",
            link_state: "created",
          },
        ],
      },
    })
    // A live shipment with no line_quantities is the legacy "covers the whole invoice" shape:
    // coverage.full flips true on it alone, so the row leaves the worklist as soon as the
    // shipment exists, whether the row is order keyed or not, and without waiting on Shopify to
    // report the order fulfilled. The work did not vanish, it moved to the Ready queue.
    const list = await toPrepareList(ctx, {})
    expect(list.rows.find((r) => r.id === "inv-1")).toBeUndefined()
    const ready = await readyList(ctx)
    expect(ready.rows.find((r) => r.invoice_ref === "inv-1")).toBeDefined()

    // Shopify later reporting the order fulfilled changes nothing here: the local shipment table
    // alone already settled it.
    const fulfilled = makeCtx({
      invoices: [bulkInvoice("inv-1")],
      scan: { orderOverrides: { "inv-1": { fulfillmentStatus: "FULFILLED" } } },
    })
    expect((await toPrepareList(fulfilled.ctx, {})).rows).toHaveLength(0)
  })
})

describe("partial shipments — preflight overship guard", () => {
  it("createShipmentPreflight rejects a batch exceeding the remaining units", async () => {
    const { createShipmentPreflight } = await import("./shipment")
    const inv = bulkInvoice("inv-1", { quantity: 5 })
    const { ctx } = makeCtx({
      invoices: [inv],
      seed: {
        shipment: [
          {
            id: "ship-1",
            document_ref: "inv-1",
            kind: "outbound",
            order_status: "CONFIRMED",
            link_state: "created",
            batch_seq: 1,
            line_quantities: [{ line_id: "line-inv-1", external_id: "RAL-44", quantity: 3 }],
          },
        ],
      },
    })
    const res = await createShipmentPreflight(ctx as never, {
      draft_id: "inv-1",
      offer_code: "CHRP-Chrono13",
      lines: [{ line_id: "line-inv-1", quantity: 4 }],
      recipient_address: {
        name: "Dealer",
        street: "1 Main St",
        city: "NYC",
        postalCode: "10001",
        countryIsoCode: "US",
        email: "d@x.com",
        phone: "+12125550100",
      },
    } as never)
    expect("error" in res && res.error.code).toBe("partial_overship")
    expect("error" in res ? res.error.message : "").toContain("2 of 5")
  })
})

describe("partial shipments — end-to-end journey (two batches, proformas, worklist, fulfillment)", () => {
  it("batch 1 ships 2 of 5 with its proforma; worklist shows 3 remaining; batch 2 ships the rest; worklist empties; each batch fulfills only its lines", async () => {
    const { createShipment } = await import("./shipment")
    const { documentCreatedHandler } = await import("./webhooks")
    const inv = bulkInvoice("11111111-1111-4111-8111-111111111111", { quantity: 5 })
    const crossCalls: Array<{ target: string; args: Record<string, unknown> }> = []
    const base = makeCtx({ invoices: [inv] })
    let orderSeq = 0
    const ctx = {
      ...(base.ctx as unknown as Record<string, unknown>),
      fetch: async (url: string, o?: { method?: string }) => {
        if (url.includes("/iam/account-app/token")) {
          return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
        }
        if (url.includes("/shipping-order") && url.includes("/tracking")) {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ status: 200, timestamp: "t", content: [{ status: "ANNOUNCED", trackingNumber: `TRK${orderSeq}`, trackingDateTime: "2026-07-17T00:00:00Z", history: [] }] }),
          }
        }
        if (url.includes("/shipping-order") && url.includes("/shipping-document")) {
          return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: [] }) }
        }
        if (url.includes("/shipping-order") && (o?.method ?? "GET") === "POST") {
          orderSeq += 1
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({ status: 200, timestamp: "t", content: { id: `ord-${orderSeq}`, status: "PENDING", deliveryPriceExclTax: { value: 7.8, currency: "EUR" } } }),
          }
        }
        return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
      },
      config: { get: async () => "whsecret", has: async () => true },
      executeTool: async (target: string, args: unknown): Promise<CrossAppEnvelope> => {
        crossCalls.push({ target, args: args as Record<string, unknown> })
        if (target === "invoicing:proforma_create_and_issue") {
          return { status: "completed", result: { id: `pro-${crossCalls.length}` } }
        }
        if (target === "shopify:fulfillments_create") {
          return { status: "completed", result: { id: "ff-1" } }
        }
        return (base.ctx as unknown as { executeTool: typeof base.ctx.executeTool }).executeTool(
          target,
          args as never,
        )
      },
    } as never
    const address = {
      name: "Dealer",
      street: "1 Main St",
      city: "NYC",
      postalCode: "10001",
      countryIsoCode: "US",
      state: "NY",
      email: "d@x.com",
      phone: "+12125550100",
    }

    // Batch 1: 2 of 5 units.
    const res1 = await createShipment(ctx, {
      draft_id: inv.id,
      offer_code: "",
      lines: [{ line_id: `line-${inv.id}`, quantity: 2 }],
      recipient_address: address,
    } as never)
    expect("error" in res1).toBe(false)
    const r1 = res1 as { partial_batch?: boolean; batch_proforma_id?: string | null }
    expect(r1.partial_batch).toBe(true)
    expect(r1.batch_proforma_id).toBeTruthy()
    const pro1 = crossCalls.find((c) => c.target === "invoicing:proforma_create_and_issue")
    expect(pro1).toBeDefined()
    expect((pro1!.args.items as Array<{ quantity: number }>)[0]?.quantity).toBe(2)
    expect(pro1!.args.shipment_ref).toBeTruthy()
    expect(pro1!.args.shopify_order_id).toBe(inv.shopify_order_id)
    // The batch proforma travels with the parcel, so it must name the ORDER the
    // customer knows, not only the numeric handle.
    expect(pro1!.args.shopify_order_number).toBe(inv.shopify_order_number)

    // Worklist: invoice still visible, 3 units remaining.
    const midList = await toPrepareList(ctx, {})
    const midRow = midList.rows.find((r) => r.id === inv.id)
    expect(midRow?.partially_shipped).toBe(true)
    expect(midRow?.remaining_units).toBe(3)

    // Webhook for batch 1: fulfills ONLY 2 units of RAL-44.
    ;(await import("./test-db")) // keep import shape stable
    const db = (ctx as never as { db: ReturnType<typeof createMockDb> }).db
    const batch1 = db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!
    db.__all("prep_meta").length === 0 &&
      (await db.insert("prep_meta", { document_ref: inv.id, shopify_order_id: inv.shopify_order_id }))
    await documentCreatedHandler(
      { eventType: "DOCUMENT_CREATED", orderId: "ord-1" },
      ctx,
      { "x-bxt-delivery-id": "d-1" },
    )
    const ff1 = crossCalls.filter((c) => c.target === "shopify:fulfillments_create").at(-1)
    expect(ff1).toBeDefined()
    expect(ff1!.args.lineItems).toEqual([{ sku: "RAL-44", quantity: 2 }])
    expect(db.__all("shipment").find((s) => s.id === batch1.id)?.fulfillment_synced).toBe(true)

    // Batch 2: the remaining 3 units.
    const res2 = await createShipment(ctx, {
      draft_id: inv.id,
      offer_code: "",
      lines: [{ line_id: `line-${inv.id}`, quantity: 3 }],
      recipient_address: address,
    } as never)
    expect("error" in res2).toBe(false)
    const batches = db.__all("shipment").filter((s) => s.document_ref === inv.id)
    expect(batches.map((b) => b.batch_seq).sort()).toEqual([1, 2])

    // Worklist: fully covered. The order-driven row stays until Shopify reports it fulfilled, and
    // says plainly that there is nothing left to pack.
    const endList = await toPrepareList(ctx, {})
    const endRow = endList.rows.find((r) => r.id === inv.id)!
    expect(endRow.reason).toBe("Every unit already has a live shipment")

    // Overship: a third batch of 1 unit must be rejected.
    const res3 = await createShipment(ctx, {
      draft_id: inv.id,
      offer_code: "",
      lines: [{ line_id: `line-${inv.id}`, quantity: 1 }],
      recipient_address: address,
    } as never)
    expect("error" in res3 && (res3 as { error: { code: string } }).error.code).toBe("partial_overship")
  })
})

describe("issueBatchProforma (partial batch customs proforma)", () => {
  const draft = {
    document_ref: "inv-77",
    recipient: "Dealer Inc",
    recipient_country: "US",
    batch_lines: [{ description: "RAL-44", quantity: 2, unit_price_minor: 10_000 }],
  } as never
  const sourceInvoice = {
    shopify_order_id: "7001",
    shopify_order_number: "#1149",
    currency: "USD",
    counterparty_name: "Dealer Inc",
    counterparty_country: "US",
    counterparty_address: "1 Main St, 10001 NYC",
    counterparty_email: "d@x.com",
    counterparty_vat_id: null,
    counterparty_contact_id: "contact-9",
  }
  function stubCtx(proformaReply: CrossAppEnvelope) {
    const calls: Array<{ target: string; args: Record<string, unknown> }> = []
    const warns: Array<{ msg: string; meta: unknown }> = []
    const ctx = {
      logger: { warn: (msg: string, meta: unknown) => warns.push({ msg, meta }) },
      executeTool: async (target: string, args: unknown): Promise<CrossAppEnvelope> => {
        calls.push({ target, args: args as Record<string, unknown> })
        if (target === "invoicing:documents_get") return { status: "completed", result: sourceInvoice }
        return proformaReply
      },
    } as never
    return { ctx, calls, warns }
  }

  it("sends a complete `counterparty` object from the source invoice, in its currency", async () => {
    const { ctx, calls } = stubCtx({
      status: "completed",
      result: { status: "completed", document_id: "pro-1", number: "PRO-2026-0001" },
    })
    const out = await issueBatchProforma(ctx, draft, "ship-1")
    expect(out).toEqual({ status: "completed", document_id: "pro-1" })
    const call = calls.find((c) => c.target === "invoicing:proforma_create_and_issue")!
    expect(call.args.counterparty).toEqual({
      legal_name: "Dealer Inc",
      country: "US",
      address: "1 Main St, 10001 NYC",
      email: "d@x.com",
      contact_id: "contact-9",
    })
    expect("counterparty_name" in call.args).toBe(false)
    expect(call.args.currency).toBe("USD")
    expect(call.args.shipment_ref).toBe("ship-1")
  })

  it("an invoicing refusal is logged and returned, never a silent null", async () => {
    const { ctx, warns } = stubCtx({
      status: "completed",
      result: { status: "error", error: { code: "counterparty_incomplete", message: "email is missing" } },
    })
    const out = await issueBatchProforma(ctx, draft, "ship-2")
    expect(out).toEqual({ status: "error", code: "counterparty_incomplete", message: "email is missing" })
    expect(warns).toHaveLength(1)
    expect(warns[0]!.msg).toMatch(/batch proforma/)
  })

  it("under an issuer with prices_include_tax, the proforma stores exactly the invoice's NET price", async () => {
    // Invoice line: net 8333 at 20% (a typed gross of 10000). The tool divides the tax out of
    // the price it receives, so receiving the net figure stored 6944 (double netting).
    const taxedDraft = {
      document_ref: "inv-78",
      recipient: "Dealer Inc",
      recipient_country: "FR",
      batch_lines: [
        { description: "RAL-44", quantity: 1, unit_price_minor: 8_333, tax_rate_bp: 2000 },
        { description: "Cable", quantity: 3, unit_price_minor: 417, tax_rate_bp: 550 },
      ],
    } as never
    const calls: Array<{ target: string; args: Record<string, unknown> }> = []
    const ctx = {
      logger: { warn: () => {} },
      executeTool: async (target: string, args: unknown): Promise<CrossAppEnvelope> => {
        calls.push({ target, args: args as Record<string, unknown> })
        if (target === "invoicing:documents_get") {
          return { status: "completed", result: { ...sourceInvoice, currency: "EUR", issuer_profile_id: "iss-incl" } }
        }
        if (target === "invoicing:settings_issuer_profile_list") {
          return { status: "completed", result: { items: [{ id: "iss-incl", prices_include_tax: true }] } }
        }
        return { status: "completed", result: { status: "completed", document_id: "pro-3" } }
      },
    } as never
    const out = await issueBatchProforma(ctx, taxedDraft, "ship-3")
    expect(out.status).toBe("completed")
    const call = calls.find((c) => c.target === "invoicing:proforma_create_and_issue")!
    const items = call.args.items as Array<{ unit_price_minor: number; tax_rate_bp_override?: number }>
    // Without an override the tool nets at the classified rate: 20% for this FR domestic recipient.
    const stored = items.map((i) => Number(netOfIncludedTax(BigInt(i.unit_price_minor), i.tax_rate_bp_override ?? 2000)))
    expect(stored).toEqual([8_333, 417])
    expect(call.args.issuer_profile_id).toBe("iss-incl")
  })
})
