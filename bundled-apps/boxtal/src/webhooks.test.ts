// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { documentCreatedHandler, trackingChangedHandler } from "./webhooks"
import { createMockDb } from "./test-db"
import { buildLabelPdf, FEDEX_LABEL_LINES } from "./__fixtures__/label-pdf"

const CREDS = { v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" }

function makeCtx(opts?: { documents?: Array<{ url: string; type: string; format: string }> }) {
  const db = createMockDb({
    seed: {
      shipment: [
        {
          id: "s1",
          boxtal_order_id: "ord-1",
          document_ref: "doc-1",
          order_status: "PENDING",
          tracking_status: null,
          tracking_number: null,
          status_fetched_at: null,
          documents: [],
        },
      ],
    },
  })
  const fetch = async (url: string) => {
    if (url.includes("/iam/account-app/token")) {
      return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
    }
    if (url.includes("/shipping-document")) {
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: opts?.documents ?? [{ url: "https://signed/label.pdf", type: "LABEL", format: "PDF_A4" }] }) }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
  }
  const ctx = {
    orgId: "org-1",
    db,
    fetch,
    connections: { boxtal: { getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }), getToken: async () => { throw new Error("no") }, getAccounts: async () => [] } },
    config: { get: async () => "whsecret", has: async () => true },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as any
  return { ctx, db }
}

const trackingPayload = (over?: Record<string, unknown>) => ({
  eventType: "TRACKING_CHANGED",
  orderId: "ord-1",
  status: "IN_TRANSIT",
  trackingNumber: "TRK1",
  trackingDateTime: "2026-06-02T10:00:00Z",
  ...over,
})

describe("trackingChangedHandler", () => {
  it("applies the tracking change and dedups by delivery id", async () => {
    const { ctx, db } = makeCtx()
    const r1 = await trackingChangedHandler(trackingPayload(), ctx, { "x-bxt-delivery-id": "del-1" })
    expect(r1.status).toBe(200)
    let row = db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!
    expect(row.tracking_status).toBe("IN_TRANSIT")
    // duplicate delivery → 200 without re-applying (status already set)
    const r2 = await trackingChangedHandler(
      trackingPayload({ status: "DELIVERED" }),
      ctx,
      { "x-bxt-delivery-id": "del-1" },
    )
    expect(r2.status).toBe(200)
    row = db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!
    // dedup blocked the second application → still IN_TRANSIT
    expect(row.tracking_status).toBe("IN_TRANSIT")
  })

  it("ignores an out-of-order (older) event", async () => {
    const { ctx, db } = makeCtx()
    await trackingChangedHandler(trackingPayload(), ctx, { "x-bxt-delivery-id": "del-1" })
    await trackingChangedHandler(
      trackingPayload({ status: "SHIPPED", trackingDateTime: "2026-06-01T08:00:00Z" }),
      ctx,
      { "x-bxt-delivery-id": "del-2" },
    )
    const row = db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!
    expect(row.tracking_status).toBe("IN_TRANSIT")
  })

  it("an unknown order id → 200, no state change", async () => {
    const { ctx } = makeCtx()
    const r = await trackingChangedHandler(
      trackingPayload({ orderId: "ghost" }),
      ctx,
      { "x-bxt-delivery-id": "del-9" },
    )
    expect(r.status).toBe(200)
  })

  it("two distinct-status events with NO delivery-id header both apply (I3 — no fallback collision)", async () => {
    const { ctx, db } = makeCtx()
    // No x-bxt-delivery-id header → the fallback dedup key is derived locally.
    // The two events differ only in status + timestamp; the OLD fallback
    // (`eventType:orderId`) collided and dropped the 2nd, freezing the status.
    await trackingChangedHandler(
      trackingPayload({ status: "ANNOUNCED", trackingDateTime: "2026-06-01T09:00:00Z" }),
      ctx,
      {},
    )
    let row = db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!
    expect(row.tracking_status).toBe("ANNOUNCED")
    await trackingChangedHandler(
      trackingPayload({ status: "IN_TRANSIT", trackingDateTime: "2026-06-02T10:00:00Z" }),
      ctx,
      {},
    )
    row = db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!
    // The status advanced — the second event was NOT dropped as a dup.
    expect(row.tracking_status).toBe("IN_TRANSIT")
    // Two distinct ledger rows were claimed (no collision).
    expect(db.__all("webhook_delivery")).toHaveLength(2)
  })

  it("a genuine resend (same status + timestamp, no header) still dedups", async () => {
    const { ctx, db } = makeCtx()
    const payload = trackingPayload({ status: "IN_TRANSIT", trackingDateTime: "2026-06-02T10:00:00Z" })
    await trackingChangedHandler(payload, ctx, {})
    await trackingChangedHandler(payload, ctx, {})
    // Identical event → identical fallback key → one ledger row.
    expect(db.__all("webhook_delivery")).toHaveLength(1)
  })
})

describe("documentCreatedHandler", () => {
  it("fetches documents, persists url-stripped descriptors, bumps order_status", async () => {
    const { ctx, db } = makeCtx()
    const r = await documentCreatedHandler(
      { eventType: "DOCUMENT_CREATED", orderId: "ord-1" },
      ctx,
      { "x-bxt-delivery-id": "del-doc-1" },
    )
    expect(r.status).toBe(200)
    const row = db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!
    const docs = row.documents as Array<Record<string, unknown>>
    expect(docs).toHaveLength(1)
    expect(docs[0]).toEqual({ type: "LABEL", format: "PDF_A4" })
    expect("url" in docs[0]!).toBe(false)
    expect(row.order_status).toBe("CONFIRMED")
  })

  it("a duplicate document delivery dedups (single application)", async () => {
    const { ctx, db } = makeCtx()
    await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "dd-1" })
    await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "dd-1" })
    expect(db.__all("webhook_delivery").filter((d) => d.delivery_id === "dd-1")).toHaveLength(1)
  })
})

// ── auto-fulfillment (the automation-gap fix) ─────────────────────────────────
//
// On the shipment CONFIRMED transition (DOCUMENT_CREATED) or the first tracking number
// (TRACKING_CHANGED), the webhook should call shopify:fulfillments_create for the order's linked
// Shopify order — idempotently (a `fulfillment_synced` flag on the shipment row), log-and-continue
// on failure (never fails the webhook itself).

function makeAutoFulfillCtx(opts?: {
  shipment?: Record<string, unknown>
  prepMeta?: Record<string, unknown> | null
  fulfillResult?: { status: string; error?: { code: string; message: string } }
  /** Envelope `shopify:orders_get` returns for the already-fulfilled pre-check.
   *  Defaults to the unmocked error envelope (the pre-check finds nothing). */
  ordersGetResult?: unknown
  /** Make `shopify:orders_get` throw instead of returning an envelope. */
  ordersGetThrows?: boolean
  executeToolCalls?: Array<{ target: string; args: unknown }>
  /** Body served at the label's signed URL (a label PDF). Defaults to a non-PDF body. */
  labelBody?: string
}) {
  const shipmentSeed = {
    id: "s1",
    boxtal_order_id: "ord-1",
    document_ref: "doc-1",
    order_status: "PENDING",
    tracking_status: null,
    tracking_number: null,
    status_fetched_at: null,
    documents: [],
    fulfillment_synced: false,
    ...opts?.shipment,
  }
  const db = createMockDb({
    seed: {
      shipment: [shipmentSeed],
      // `shopify_order_id` is seeded in the shape prep_sync ACTUALLY persists: the BARE NUMERIC id,
      // because that is what Shopify's REST webhooks deliver and what invoicing stores. Seeding a
      // gid here is what let the auto-fulfillment gid bug reach prod on 2026-09-16: the fixture
      // handed the handler a value that needed no normalization, so the missing normalization was
      // invisible to every test while every real parcel failed.
      ...(opts?.prepMeta === null ? {} : { prep_meta: [{ id: "m1", document_ref: "doc-1", shopify_order_id: "1", ...opts?.prepMeta }] }),
    },
  })
  const fetch = async (url: string) => {
    if (url.includes("/iam/account-app/token")) {
      return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
    }
    if (url.includes("/shipping-document")) {
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: [{ url: "https://signed/label.pdf", type: "LABEL", format: "PDF_A4" }] }) }
    }
    if (url === "https://signed/label.pdf" && opts?.labelBody !== undefined) {
      return { status: 200, headers: {}, body: opts.labelBody }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
  }
  const executeTool = async (target: string, args: unknown) => {
    opts?.executeToolCalls?.push({ target, args })
    if (target === "shopify:orders_get") {
      if (opts?.ordersGetThrows) throw new Error("shopify unreachable")
      if (opts?.ordersGetResult !== undefined) return opts.ordersGetResult
    }
    if (target === "shopify:fulfillments_create") {
      return opts?.fulfillResult ?? { status: "completed", result: { id: "fulfillment-1" } }
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
  } as any
  return { ctx, db }
}

describe("auto-fulfillment on shipment CONFIRMED / first tracking number", () => {
  it("DOCUMENT_CREATED (CONFIRMED transition) with an already-known tracking number calls shopify:fulfillments_create and marks synced", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx, db } = makeAutoFulfillCtx({ shipment: { tracking_number: "TRK1" }, executeToolCalls: calls })
    await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "del-1" })
    const fulfillCall = calls.find((c) => c.target === "shopify:fulfillments_create")
    expect(fulfillCall).toBeDefined()
    // The GID, not the stored numeric id: shopify:fulfillments_create binds this to a GraphQL `ID!`,
    // which rejects the numeric form outright, and the log-and-continue above swallows the throw, so
    // the only symptom in prod was a shipped parcel whose order stayed unfulfilled.
    expect((fulfillCall!.args as { orderId: string }).orderId).toBe("gid://shopify/Order/1")
    const row = db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!
    expect(row.fulfillment_synced).toBe(true)
  })

  it("the carrier-scan fulfilment sends the tracking with its Shopify carrier and leaves the email to the shopify policy", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx } = makeAutoFulfillCtx({
      shipment: { tracking_number: "1Z999", offer_code: "UPSE-Standard" },
      executeToolCalls: calls,
    })
    await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "del-2" })
    const fulfillCall = calls.find((c) => c.target === "shopify:fulfillments_create")!
    // Same payload as the packed tick: the shopify app's customerShippingEmail policy turns the
    // caller's false into true for a retail order (and keeps it false for B2B).
    expect((fulfillCall.args as { fulfillment: unknown }).fulfillment).toEqual({
      trackingInfo: { number: "1Z999", company: "UPS" },
      notifyCustomer: false,
    })
  })

  it("a shopify_order_id already stored in gid form is passed through untouched", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx } = makeAutoFulfillCtx({
      shipment: { tracking_number: "TRK1" },
      prepMeta: { shopify_order_id: "gid://shopify/Order/1" },
      executeToolCalls: calls,
    })
    await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "del-1" })
    const fulfillCall = calls.find((c) => c.target === "shopify:fulfillments_create")
    expect((fulfillCall!.args as { orderId: string }).orderId).toBe("gid://shopify/Order/1")
  })

  it("TRACKING_CHANGED carrying the first trackingNumber calls shopify:fulfillments_create", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx, db } = makeAutoFulfillCtx({ executeToolCalls: calls })
    await trackingChangedHandler(
      { eventType: "TRACKING_CHANGED", orderId: "ord-1", status: "ANNOUNCED", trackingNumber: "TRK1", trackingDateTime: "2026-06-02T10:00:00Z" },
      ctx,
      { "x-bxt-delivery-id": "del-1" },
    )
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(true)
    expect(db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!.fulfillment_synced).toBe(true)
  })

  it("does NOT double-fulfill: a second webhook after fulfillment_synced=true skips the call", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx } = makeAutoFulfillCtx({ shipment: { tracking_number: "TRK1", fulfillment_synced: true }, executeToolCalls: calls })
    await trackingChangedHandler(
      { eventType: "TRACKING_CHANGED", orderId: "ord-1", status: "IN_TRANSIT", trackingNumber: "TRK1", trackingDateTime: "2026-06-03T10:00:00Z" },
      ctx,
      { "x-bxt-delivery-id": "del-2" },
    )
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(false)
  })

  it("no linked Shopify order (prep_meta missing/no shopify_order_id) skips the call without failing the webhook", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx } = makeAutoFulfillCtx({ shipment: { tracking_number: "TRK1" }, prepMeta: null, executeToolCalls: calls })
    const r = await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "del-1" })
    expect(r.status).toBe(200)
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(false)
  })

  it("a shopify:fulfillments_create error is logged and the webhook still returns 200 (log-and-continue)", async () => {
    const { ctx, db } = makeAutoFulfillCtx({
      shipment: { tracking_number: "TRK1" },
      fulfillResult: { status: "error", error: { code: "already_fulfilled", message: "order already fulfilled" } },
    })
    const r = await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "del-1" })
    expect(r.status).toBe(200)
    // Not marked synced on a failed call — a later retry may still succeed.
    expect(db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!.fulfillment_synced).toBe(false)
  })

  it("no tracking number yet: DOCUMENT_CREATED skips the fulfillment call", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx } = makeAutoFulfillCtx({ executeToolCalls: calls }) // tracking_number: null by default
    await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "del-1" })
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(false)
  })

  // FedEx Regional Economy / Domestic Express: Boxtal's tracking endpoint stays empty until the
  // first carrier scan, but the label already prints the AWB. The label is read at DOCUMENT_CREATED,
  // the number stored, and the order fulfilled with it.
  // The label-read number is stored and shown, but it does NOT fulfil: Shopify's shipping email
  // must not reach the customer before the parcel is packed. The trigger stays the carrier's first
  // tracking event, or the operator's tick.
  it("DOCUMENT_CREATED with a label-read AWB stores tracking but does NOT call fulfillments_create", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx, db } = makeAutoFulfillCtx({ executeToolCalls: calls, labelBody: buildLabelPdf(FEDEX_LABEL_LINES) })
    await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "del-lbl" })
    const row = db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!
    expect(row.tracking_number).toBe("877740925574")
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(false)
    expect(row.fulfillment_state ?? null).toBeNull()
    // The carrier's first event with its number is what fulfils.
    await trackingChangedHandler(
      { eventType: "TRACKING_CHANGED", orderId: "ord-1", status: "IN_TRANSIT", trackingNumber: "877740925574", trackingDateTime: "2026-06-03T10:00:00Z" },
      ctx,
      { "x-bxt-delivery-id": "del-lbl-2" },
    )
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(true)
  })

  // A failed auto-fulfillment used to be log-and-continue only: the row looked fine while Shopify
  // stayed unfulfilled. The failure is now on the row, where the queue and stuck_list show it.
  it("a failed auto-fulfillment is recorded on the shipment row", async () => {
    const { ctx, db } = makeAutoFulfillCtx({
      shipment: { tracking_number: "TRK1" },
      fulfillResult: { status: "error", error: { code: "NO_FULFILLABLE_ITEMS", message: "Order has no OPEN fulfillment orders" } },
    })
    await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "del-fail" })
    const row = db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!
    expect(row.fulfillment_state).toBe("failed")
    expect(String(row.fulfillment_error)).toContain("Order has no OPEN fulfillment orders")
  })

  it("an operator-cancelled fulfillment is not redone by a later carrier event", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx } = makeAutoFulfillCtx({ shipment: { tracking_number: "TRK1", fulfillment_state: "cancelled" }, executeToolCalls: calls })
    await trackingChangedHandler(
      { eventType: "TRACKING_CHANGED", orderId: "ord-1", status: "IN_TRANSIT", trackingNumber: "TRK1", trackingDateTime: "2026-06-03T10:00:00Z" },
      ctx,
      { "x-bxt-delivery-id": "del-cx" },
    )
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(false)
  })

  // The gated path in production: fulfillments_create staged an approval, a human granted it, Shopify
  // fulfilled the order with our tracking number, but nothing ever flipped fulfillment_synced -- so
  // every later tracking event re-staged the same approval card. The pre-check retires the row.
  it("an order already fulfilled with THIS tracking number skips fulfillments_create and marks synced", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx, db } = makeAutoFulfillCtx({
      shipment: { tracking_number: "TRK1" },
      ordersGetResult: {
        status: "completed",
        result: {
          name: "#3442",
          fulfillmentStatus: "FULFILLED",
          fulfillments: [{ id: "f1", status: "SUCCESS", trackingInfo: [{ number: "TRK1" }] }],
        },
      },
      executeToolCalls: calls,
    })
    const r = await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "del-heal-1" })
    expect(r.status).toBe(200)
    expect(calls.some((c) => c.target === "shopify:orders_get")).toBe(true)
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(false)
    expect(db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!.fulfillment_synced).toBe(true)
  })

  // Several parcels legitimately share one order: another parcel's tracking number on the order must
  // never be read as "this shipment is done", or the second box never reaches Shopify.
  it("an order fulfilled with a DIFFERENT tracking number still calls fulfillments_create", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx, db } = makeAutoFulfillCtx({
      shipment: { tracking_number: "TRK1" },
      ordersGetResult: {
        status: "completed",
        result: {
          fulfillmentStatus: "PARTIALLY_FULFILLED",
          fulfillments: [{ id: "f1", status: "SUCCESS", trackingInfo: [{ number: "OTHER-PARCEL" }] }],
        },
      },
      executeToolCalls: calls,
    })
    await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "del-heal-2" })
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(true)
    expect(db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!.fulfillment_synced).toBe(true)
  })

  // The pre-check is a convenience read: a Shopify outage must not stop the parcel being fulfilled.
  it("an orders_get that throws still falls through to fulfillments_create (log-and-continue)", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx } = makeAutoFulfillCtx({
      shipment: { tracking_number: "TRK1" },
      ordersGetThrows: true,
      executeToolCalls: calls,
    })
    const r = await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "del-heal-3" })
    expect(r.status).toBe(200)
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(true)
  })

  it("an orders_get error envelope still falls through to fulfillments_create (log-and-continue)", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx } = makeAutoFulfillCtx({
      shipment: { tracking_number: "TRK1" },
      ordersGetResult: { status: "error", error: { code: "upstream", message: "shopify 500" } },
      executeToolCalls: calls,
    })
    const r = await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "del-heal-4" })
    expect(r.status).toBe(200)
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(true)
  })

  it("a pending_approval envelope does NOT mark synced — a later webhook may re-attempt", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx, db } = makeAutoFulfillCtx({
      shipment: { tracking_number: "TRK1" },
      fulfillResult: { status: "pending_approval", approval_id: "appr-1" } as unknown as {
        status: string
        error?: { code: string; message: string }
      },
      executeToolCalls: calls,
    })
    const r = await documentCreatedHandler({ eventType: "DOCUMENT_CREATED", orderId: "ord-1" }, ctx, { "x-bxt-delivery-id": "del-1" })
    expect(r.status).toBe(200)
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(true)
    // NOT marked synced — an eventual rejection must let a later webhook re-attempt.
    expect(db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!.fulfillment_synced).toBe(false)
  })
})

describe("auto-fulfillment — PARTIAL batches fulfill only their own lines", () => {
  it("a shipment with line_quantities passes lineItems (sku + quantity) to shopify:fulfillments_create", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx, db } = makeAutoFulfillCtx({
      shipment: {
        tracking_number: "TRK1",
        line_quantities: [
          { line_id: "l1", external_id: "RAL-44", quantity: 2 },
          { line_id: "l2", external_id: "EMB-FS", quantity: 1 },
        ],
      },
      executeToolCalls: calls,
    })
    await documentCreatedHandler(
      { eventType: "DOCUMENT_CREATED", orderId: "ord-1" },
      ctx,
      { "x-bxt-delivery-id": "del-p1" },
    )
    const fulfillCall = calls.find((c) => c.target === "shopify:fulfillments_create")
    expect(fulfillCall).toBeDefined()
    const args = fulfillCall!.args as { orderId: string; lineItems?: Array<{ sku: string; quantity: number }> }
    expect(args.lineItems).toEqual([
      { sku: "RAL-44", quantity: 2 },
      { sku: "EMB-FS", quantity: 1 },
    ])
    const row = db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!
    expect(row.fulfillment_synced).toBe(true)
  })

  it("a partial batch with a sku-less line skips fulfillment instead of over-fulfilling the order", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx, db } = makeAutoFulfillCtx({
      shipment: {
        tracking_number: "TRK1",
        line_quantities: [{ line_id: "l1", external_id: null, quantity: 2 }],
      },
      executeToolCalls: calls,
    })
    await documentCreatedHandler(
      { eventType: "DOCUMENT_CREATED", orderId: "ord-1" },
      ctx,
      { "x-bxt-delivery-id": "del-p2" },
    )
    expect(calls.find((c) => c.target === "shopify:fulfillments_create")).toBeUndefined()
    const row = db.__all("shipment").find((s) => s.boxtal_order_id === "ord-1")!
    expect(row.fulfillment_synced).toBe(false)
  })

  it("a FULL shipment (no line_quantities) keeps the legacy whole-order call (no lineItems)", async () => {
    const calls: Array<{ target: string; args: unknown }> = []
    const { ctx } = makeAutoFulfillCtx({ shipment: { tracking_number: "TRK1" }, executeToolCalls: calls })
    await documentCreatedHandler(
      { eventType: "DOCUMENT_CREATED", orderId: "ord-1" },
      ctx,
      { "x-bxt-delivery-id": "del-p3" },
    )
    const args = calls.find((c) => c.target === "shopify:fulfillments_create")!.args as Record<string, unknown>
    expect(args.lineItems).toBeUndefined()
  })
})

describe("real Boxtal v3.1 delivery shape (WebhookEventTrackingChanged)", () => {
  // No genuine delivery was ever parsed before 2026-08-04 (all rejected at the
  // signature layer first): the real body nests the status under
  // payload.trackings[] and names the order shippingOrderId. The flat shape
  // the handlers historically consumed only ever came from synthetic tests.
  const realPayload = () => ({
    id: "evt-abc-123",
    type: "TRACKING_CHANGED",
    shippingOrderId: "ord-1",
    shipmentExternalId: "ext-9",
    payload: {
      trackings: [
        { status: "DELIVERED", trackingNumber: "TRK-REAL", trackingDateTime: "2026-08-04T15:18:00Z" },
      ],
    },
  })

  it("applies a real-shaped tracking event (status from payload.trackings[0])", async () => {
    const { ctx, db } = makeCtx()
    const r = await trackingChangedHandler(realPayload() as never, ctx, {})
    expect(r.status).toBe(200)
    const s = db.__all("shipment").find((x) => x.boxtal_order_id === "ord-1")!
    expect(s.tracking_status).toBe("DELIVERED")
    expect(s.tracking_number).toBe("TRK-REAL")
  })

  it("dedups by the event's own id when no delivery header is present", async () => {
    const { ctx, db } = makeCtx()
    await trackingChangedHandler(realPayload() as never, ctx, {})
    const r2 = await trackingChangedHandler(realPayload() as never, ctx, {})
    expect(r2.status).toBe(200)
    // one claimed delivery row, second call deduped on evt:<event id>
    expect(db.__all("webhook_delivery")).toHaveLength(1)
  })

  it("applies a real-shaped DOCUMENT_CREATED via shippingOrderId", async () => {
    const { ctx, db } = makeCtx()
    const r = await documentCreatedHandler(
      { id: "evt-doc-1", type: "DOCUMENT_CREATED", shippingOrderId: "ord-1", payload: { documents: [] } } as never,
      ctx,
      {},
    )
    expect(r.status).toBe(200)
    const s = db.__all("shipment").find((x) => x.boxtal_order_id === "ord-1")!
    expect(s.order_status).toBe("CONFIRMED")
  })
})
