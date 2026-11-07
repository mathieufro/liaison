// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The packed tick fulfils the Shopify order (ticket-10647, ticket-10507, ticket-10522).
// Real failure, order #3475 on 2026-09-29: the tick stamped packed_at, said nothing, and the
// Shopify order stayed unfulfilled with no tracking for the customer.
import { describe, expect, it } from "bun:test"
import { readySetPacked } from "./packed"
import { trackingChangedHandler } from "./webhooks"
import { readyList, stuckList } from "./queues"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import { createMockDb } from "./test-db"
import { buildLabelPdf, FEDEX_LABEL_LINES } from "./__fixtures__/label-pdf"

/** Shipment row ids are UUIDs: only a UUID-shaped ref is looked up by row id. */
const S1 = "5a1e0000-0000-4000-8000-000000000001"

const CREDS = { v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" }

function makeCtx(opts: {
  shipment?: Record<string, unknown>
  linked?: boolean
  create?: CrossAppEnvelope
  cancel?: CrossAppEnvelope
  orderFulfillments?: Array<{ id: string; status: string; trackingInfo: Array<{ number: string }> }>
  labelBody?: string
  withdraw?: CrossAppEnvelope
}) {
  const calls: Array<{ target: string; args: Record<string, unknown> }> = []
  const db = createMockDb({
    seed: {
      shipment: [
        {
          id: S1,
          boxtal_order_id: "ord-1",
          document_ref: "doc-1",
          order_status: "CONFIRMED",
          tracking_status: null,
          tracking_number: "TRK1",
          documents: [{ type: "LABEL", format: "PDF_10x15" }],
          queue_facts: { order_name: "#3475" },
          ...opts.shipment,
        },
      ],
      ...(opts.linked === false ? {} : { prep_meta: [{ id: "m1", document_ref: "doc-1", shopify_order_id: "3475" }] }),
    },
  })
  const fetch = async (url: string) => {
    if (url.includes("/iam/account-app/token")) {
      return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
    }
    if (url.includes("/shipping-document")) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ status: 200, timestamp: "t", content: [{ url: "https://signed/label.pdf", type: "LABEL", format: "PDF_A4" }] }),
      }
    }
    if (url === "https://signed/label.pdf") return { status: 200, headers: {}, body: opts.labelBody ?? "" }
    return { status: 404, headers: {}, body: "" }
  }
  const executeTool = async (target: string, args: Record<string, unknown>): Promise<CrossAppEnvelope> => {
    calls.push({ target, args })
    if (target === "shopify:orders_get") {
      return { status: "completed", result: { fulfillments: opts.orderFulfillments ?? [] } }
    }
    if (target === "shopify:fulfillments_create") {
      return opts.create ?? { status: "completed", result: { fulfillment: { id: "gid://shopify/Fulfillment/9", status: "SUCCESS" } } }
    }
    if (target === "kernel:approval_withdraw") {
      return opts.withdraw ?? { status: "completed", result: { status: "withdrawn" } }
    }
    if (target === "shopify:fulfillments_cancel") {
      return opts.cancel ?? { status: "completed", result: { fulfillment: { id: args.id, status: "CANCELLED" } } }
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
  } as unknown as BoxtalToolCtx
  const row = () => db.__all("shipment").find((r) => r.id === S1)!
  return { ctx, calls, row }
}

describe("ready_set_packed: ticking fulfils the Shopify order", () => {
  it("the tick sends the tracking with the carrier Shopify knows, so a policy email carries a working link", async () => {
    const { ctx, calls } = makeCtx({ shipment: { offer_code: "MONR-CpourToi" } })
    await readySetPacked(ctx, { shipment_id: S1, packed: true })
    const create = calls.find((c) => c.target === "shopify:fulfillments_create")!
    expect(create.args.fulfillment).toEqual({ trackingInfo: { number: "TRK1", company: "Mondial Relay" }, notifyCustomer: false })
  })

  it("an unknown carrier sends the number alone (never a guessed company)", async () => {
    const { ctx, calls } = makeCtx({ shipment: { offer_code: "ZZZZ-Unknown" } })
    await readySetPacked(ctx, { shipment_id: S1, packed: true })
    const create = calls.find((c) => c.target === "shopify:fulfillments_create")!
    expect(create.args.fulfillment).toEqual({ trackingInfo: { number: "TRK1" }, notifyCustomer: false })
  })

  it("ticking calls fulfillments_create with the tracking number and lands the tick", async () => {
    const { ctx, calls, row } = makeCtx({})
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: true })
    expect(res.error).toBeUndefined()
    const create = calls.find((c) => c.target === "shopify:fulfillments_create")!
    expect(create.args.orderId).toBe("gid://shopify/Order/3475")
    expect((create.args.fulfillment as { trackingInfo: { number: string } }).trackingInfo.number).toBe("TRK1")
    // Explicit false is this caller's default only; the shopify app's customerShippingEmail policy
    // decides the email for real (retail orders yes, B2B never, under retail_only).
    expect((create.args.fulfillment as { notifyCustomer?: unknown }).notifyCustomer).toBe(false)
    expect(res.packed).toBe(true)
    expect(res.fulfillment_state).toBe("fulfilled")
    expect(row().packed_at).toBe(res.packed_at)
    expect(row().shopify_fulfillment_id).toBe("gid://shopify/Fulfillment/9")
    // The row stays green on the next read of the queue.
    const r = (await readyList(ctx)).rows.find((x) => x.id === S1)!
    expect(r.packed).toBe(true)
    expect(r.fulfillment_state).toBe("fulfilled")
  })

  it("a failed fulfillment refuses the tick and puts the reason on the row", async () => {
    const { ctx, row } = makeCtx({
      create: { status: "error", error: { code: "NO_FULFILLABLE_ITEMS", message: "Order has no OPEN fulfillment orders" } },
    })
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: true })
    expect(res.error?.message).toContain("Order has no OPEN fulfillment orders")
    // Shopify refused it for the order's state: a 409 refusal, not an upstream fault (502).
    expect(res.error?.code).toBe("shopify_refused")
    expect(res.packed).toBe(false)
    expect(row().packed_at ?? null).toBeNull()
    expect(row().fulfillment_state).toBe("failed")
    const r = (await readyList(ctx)).rows.find((x) => x.id === S1)!
    expect(r.fulfillment_error).toContain("Order has no OPEN fulfillment orders")
    // And the needs-attention sweep sees it.
    expect((await stuckList(ctx)).rows.map((x) => x.family)).toContain("fulfillment_failed")
  })

  it("a Shopify failure that is not a refusal stays an upstream error", async () => {
    const { ctx } = makeCtx({
      create: { status: "error", error: { code: "tool_error", message: "Shopify HTTP 500" } },
    })
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: true })
    expect(res.error?.code).toBe("shopify_error")
  })

  // Only the order's own state (already fulfilled, cancelled, closed) is a refusal. A bad
  // parameter or an unknown id means the call we built was wrong: an error to fix, not a 409.
  for (const error of [
    { code: "BAD_PARAM", message: "Provide `orderId` alongside `lineItems`" },
    { code: "NOT_FOUND", message: "Order not found" },
    { code: "ORDER_NOT_FOUND", message: "order 3475 not found" },
    { code: "SHOPIFY_USER_ERROR", message: "fulfillmentCreate: trackingInfo.url: is invalid" },
  ]) {
    it(`${error.code} (${error.message}) stays shopify_error`, async () => {
      const { ctx } = makeCtx({ create: { status: "error", error } })
      const res = await readySetPacked(ctx, { shipment_id: S1, packed: true })
      expect(res.error?.code).toBe("shopify_error")
    })
  }

  for (const message of [
    "fulfillmentCreate: fulfillmentOrderId: Fulfillment order is already fulfilled",
    "fulfillmentCreate: : The order has been cancelled",
    "fulfillmentCreate: : Fulfillment order is closed",
  ]) {
    it(`a Shopify user error caused by the order's state (${message}) is shopify_refused`, async () => {
      const { ctx } = makeCtx({ create: { status: "error", error: { code: "SHOPIFY_USER_ERROR", message } } })
      const res = await readySetPacked(ctx, { shipment_id: S1, packed: true })
      expect(res.error?.code).toBe("shopify_refused")
    })
  }

  it("a fulfillment parked for approval does not tick the row", async () => {
    const { ctx, row } = makeCtx({ create: { status: "pending_approval", approval_id: "ap-1" } })
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: true })
    expect(res.error?.code).toBe("pending_approval")
    expect(res.packed).toBe(false)
    expect(row().packed_at ?? null).toBeNull()
  })

  it("with no tracking number yet, the number printed on the label is used", async () => {
    const { ctx, calls, row } = makeCtx({ shipment: { tracking_number: null }, labelBody: buildLabelPdf(FEDEX_LABEL_LINES) })
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: true })
    expect(res.error).toBeUndefined()
    const create = calls.find((c) => c.target === "shopify:fulfillments_create")!
    expect((create.args.fulfillment as { trackingInfo: { number: string } }).trackingInfo.number).toBe("877740925574")
    expect(row().tracking_number).toBe("877740925574")
  })

  it("with no tracking number at all, nothing is fulfilled and the tick is refused", async () => {
    const { ctx, calls } = makeCtx({ shipment: { tracking_number: null } })
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: true })
    expect(res.error?.code).toBe("no_tracking")
    expect(res.packed).toBe(false)
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(false)
  })

  it("an order already fulfilled with this parcel's number is not fulfilled twice", async () => {
    const { ctx, calls, row } = makeCtx({
      orderFulfillments: [{ id: "gid://shopify/Fulfillment/5", status: "SUCCESS", trackingInfo: [{ number: "TRK1" }] }],
    })
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: true })
    expect(res.packed).toBe(true)
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(false)
    expect(row().shopify_fulfillment_id).toBe("gid://shopify/Fulfillment/5")
  })

  it("a parcel with no Shopify order is packed with a notice, nothing fulfilled", async () => {
    const { ctx, calls } = makeCtx({ linked: false })
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: true })
    expect(res.packed).toBe(true)
    expect(res.notice).toBeDefined()
    expect(calls.some((c) => c.target === "shopify:fulfillments_create")).toBe(false)
  })
})

describe("ready_set_packed: unticking a fulfilled row cancels the fulfillment", () => {
  const fulfilled = {
    packed_at: "2026-10-01T10:00:00.000Z",
    fulfillment_synced: true,
    fulfillment_state: "fulfilled",
    shopify_fulfillment_id: "gid://shopify/Fulfillment/9",
  }

  it("asks for confirmation first and changes nothing without it", async () => {
    const { ctx, calls, row } = makeCtx({ shipment: fulfilled })
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: false })
    expect(res.error?.code).toBe("confirm_required")
    expect(res.error?.message).toBe("Confirm unfulfilling order #3475? The Shopify fulfillment will be cancelled.")
    expect(res.packed).toBe(true)
    expect(row().packed_at).toBe(fulfilled.packed_at)
    expect(calls.some((c) => c.target === "shopify:fulfillments_cancel")).toBe(false)
  })

  it("once confirmed, cancels the Shopify fulfillment and unticks", async () => {
    const { ctx, calls, row } = makeCtx({ shipment: fulfilled })
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: false, confirm_unfulfill: true })
    expect(res.error).toBeUndefined()
    expect(calls.find((c) => c.target === "shopify:fulfillments_cancel")!.args.id).toBe("gid://shopify/Fulfillment/9")
    expect(res.packed).toBe(false)
    expect(row().packed_at).toBeNull()
    expect(row().fulfillment_state).toBe("cancelled")
    expect(row().fulfillment_synced).toBe(false)
  })

  it("a refused cancellation keeps the row ticked", async () => {
    const { ctx, row } = makeCtx({
      shipment: fulfilled,
      cancel: { status: "error", error: { code: "BAD_PARAM", message: "fulfillment already cancelled" } },
    })
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: false, confirm_unfulfill: true })
    expect(res.error?.message).toContain("fulfillment already cancelled")
    expect(res.packed).toBe(true)
    expect(row().packed_at).toBe(fulfilled.packed_at)
  })

  it("a row fulfilled before ids were stored finds its fulfillment by tracking number", async () => {
    const { ctx, calls } = makeCtx({
      shipment: { packed_at: "2026-10-01T10:00:00.000Z", fulfillment_synced: true },
      orderFulfillments: [{ id: "gid://shopify/Fulfillment/7", status: "SUCCESS", trackingInfo: [{ number: "TRK1" }] }],
    })
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: false, confirm_unfulfill: true })
    expect(res.error).toBeUndefined()
    expect(calls.find((c) => c.target === "shopify:fulfillments_cancel")!.args.id).toBe("gid://shopify/Fulfillment/7")
  })
})

// One fulfillment intent per parcel. Each tick while an approval was parked, and each later carrier
// event, used to park ANOTHER fulfillments_create (label number one time, carrier number the next),
// so the kernel never deduplicated them, granting two over-fulfilled a partial shipment, and an
// untick left the parked request live.
describe("one fulfillment request per parcel", () => {
  const parked = { status: "pending_approval", approval_id: "ap-1" } as CrossAppEnvelope
  const creates = (calls: Array<{ target: string }>) => calls.filter((c) => c.target === "shopify:fulfillments_create").length

  it("a re-tick withdraws the parked request before staging the current one", async () => {
    const { ctx, calls, row } = makeCtx({ create: parked })
    await readySetPacked(ctx, { shipment_id: S1, packed: true })
    expect(row().fulfillment_approval_id).toBe("ap-1")
    await readySetPacked(ctx, { shipment_id: S1, packed: true })
    const order = calls.map((c) => c.target).filter((t) => t !== "shopify:orders_get")
    expect(order).toEqual(["shopify:fulfillments_create", "kernel:approval_withdraw", "shopify:fulfillments_create"])
    expect(calls.find((c) => c.target === "kernel:approval_withdraw")!.args.requestId).toBe("ap-1")
  })

  it("when the parked request cannot be withdrawn, it is reused and nothing new is staged", async () => {
    const { ctx, calls } = makeCtx({
      create: parked,
      withdraw: { status: "error", error: { code: "forbidden", message: "only the requester may withdraw" } },
    })
    await readySetPacked(ctx, { shipment_id: S1, packed: true })
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: true })
    expect(res.error?.code).toBe("pending_approval")
    expect(creates(calls)).toBe(1)
  })

  it("a carrier event while a request is parked does not stage a second one", async () => {
    const { ctx, calls } = makeCtx({
      create: parked,
      withdraw: { status: "error", error: { code: "forbidden", message: "forbidden" } },
    })
    await readySetPacked(ctx, { shipment_id: S1, packed: true })
    await trackingChangedHandler(
      { eventType: "TRACKING_CHANGED", orderId: "ord-1", status: "IN_TRANSIT", trackingNumber: "TRK1", trackingDateTime: "2026-10-05T10:00:00Z" },
      ctx,
      { "x-bxt-delivery-id": "del-p1" },
    )
    expect(creates(calls)).toBe(1)
  })

  it("a parked request that was denied is replaced on the next tick", async () => {
    const { ctx, calls } = makeCtx({
      create: parked,
      withdraw: { status: "error", error: { code: "stale_status", message: "this request is already denied and cannot be withdrawn" } },
    })
    await readySetPacked(ctx, { shipment_id: S1, packed: true })
    await readySetPacked(ctx, { shipment_id: S1, packed: true })
    expect(creates(calls)).toBe(2)
  })

  it("unticking withdraws the parked request", async () => {
    const { ctx, calls, row } = makeCtx({
      shipment: { fulfillment_state: "pending_approval", fulfillment_approval_id: "ap-9" },
    })
    const res = await readySetPacked(ctx, { shipment_id: S1, packed: false })
    expect(res.error).toBeUndefined()
    expect(calls.find((c) => c.target === "kernel:approval_withdraw")!.args.requestId).toBe("ap-9")
    expect(row().fulfillment_state ?? null).toBeNull()
    expect(row().fulfillment_approval_id ?? null).toBeNull()
  })
})
