// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { importShipments } from "./import"
import { createMockDb } from "./test-db"

const CREDS = { v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" }

// Per-order-id canned responses; ids not present 422 like live Boxtal
// (ShippingOrderNotFoundException).
function makeCtx(opts?: {
  orders?: Record<string, { status: string; tracking?: { status: string; number: string }; documents?: Array<{ url: string; type: string; format: string }> }>
  seedShipment?: Array<Record<string, unknown>>
}) {
  const db = createMockDb({ seed: { shipment: opts?.seedShipment ?? [] } })
  const orders = opts?.orders ?? {}
  const fetch = async (url: string) => {
    if (url.includes("/iam/account-app/token")) {
      return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
    }
    const m = url.match(/\/shipping-order\/([^/?]+)(\/(tracking|shipping-document))?/)
    const id = m ? decodeURIComponent(m[1] ?? "") : ""
    const order = orders[id]
    if (!order) {
      return { status: 422, headers: {}, body: JSON.stringify({ status: 422, errors: [{ code: "ShippingOrderNotFoundException" }] }) }
    }
    if (url.includes("/tracking")) {
      const t = order.tracking
      const content = t ? [{ status: t.status, trackingNumber: t.number, trackingDateTime: "2026-06-02T00:00:00Z", history: [] }] : []
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content }) }
    }
    if (url.includes("/shipping-document")) {
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: order.documents ?? [] }) }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: { id, status: order.status } }) }
  }
  const ctx = {
    orgId: "org-1",
    db,
    fetch,
    connections: { boxtal: { getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }) } },
    config: { get: async () => null, has: async () => false },
    // biome-ignore lint/suspicious/noExplicitAny: test ctx (same idiom as reads.test.ts)
  } as any
  return { ctx, db }
}

describe("importShipments", () => {
  it("imports a fetchable order with tracking + url-stripped document descriptors", async () => {
    const { ctx } = makeCtx({
      orders: {
        "ord-a": {
          status: "CONFIRMED",
          tracking: { status: "IN_TRANSIT", number: "TRK-A" },
          documents: [{ url: "https://signed/label", type: "LABEL", format: "PDF_A4" }],
        },
      },
    })
    const res = await importShipments(ctx, { ids: ["ord-a"] })
    expect(res.imported).toBe(1)
    expect(res.failed).toBe(0)
    expect(res.rows[0]).toMatchObject({ id: "ord-a", outcome: "imported", order_status: "CONFIRMED", tracking_status: "IN_TRANSIT" })
    const rows = (await ctx.db.findMany("shipment", {})) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      boxtal_order_id: "ord-a",
      link_state: "created",
      kind: "outbound",
      created_by: "user",
      order_status: "CONFIRMED",
      tracking_status: "IN_TRANSIT",
      tracking_number: "TRK-A",
    })
    // Signed URL never persisted — only {type, format} descriptors.
    expect(rows[0]!.documents).toEqual([{ type: "LABEL", format: "PDF_A4" }])
  })

  it("updates the existing row instead of duplicating when the order is already linked", async () => {
    const { ctx } = makeCtx({
      orders: { "ord-a": { status: "CONFIRMED", tracking: { status: "DELIVERED", number: "TRK-A" } } },
      seedShipment: [{ id: "s1", boxtal_order_id: "ord-a", link_state: "created", order_status: "PENDING", documents: [] }],
    })
    const res = await importShipments(ctx, { ids: ["ord-a"] })
    expect(res.updated).toBe(1)
    expect(res.imported).toBe(0)
    const rows = (await ctx.db.findMany("shipment", {})) as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ order_status: "CONFIRMED", tracking_status: "DELIVERED" })
  })

  it("reports an unknown id as not_found (web-interface orders are unreachable by API) and keeps importing the rest", async () => {
    const { ctx } = makeCtx({ orders: { "ord-b": { status: "PENDING" } } })
    const res = await importShipments(ctx, { ids: ["ord-missing", "ord-b"] })
    expect(res.failed).toBe(1)
    expect(res.imported).toBe(1)
    const missing = res.rows.find((r) => r.id === "ord-missing")!
    expect(missing.outcome).toBe("not_found")
    // The clause as it actually ships. The house copy pass split the sentence
    // (no dash punctuation in anything a customer reads), which capitalised the
    // word, and this assertion still looked for the mid-sentence lowercase one.
    expect(missing.message).toContain("Web-interface orders are not.")
    // The capability limitation is stated on every result.
    expect(res.notice).toContain("no order-list endpoint")
  })

  it("dedupes ids and tolerates missing tracking/documents", async () => {
    const { ctx } = makeCtx({ orders: { "ord-a": { status: "PENDING" } } })
    const res = await importShipments(ctx, { ids: ["ord-a", "ord-a", " ", ""] })
    expect(res.imported).toBe(1)
    expect(res.rows).toHaveLength(1)
    const rows = (await ctx.db.findMany("shipment", {})) as Array<Record<string, unknown>>
    expect(rows[0]).toMatchObject({ tracking_status: null, tracking_number: null, documents: [] })
  })
})
