// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { getDocuments, getShipment, latestEventTimestamp, listContentCategories, track } from "./reads"
import { cancelShipment, cancelShipmentPreflight } from "./shipment"
import { createMockDb } from "./test-db"

const CREDS = { v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" }

function makeCtx(opts?: {
  order?: { status: string }
  tracking?: { status: string; number?: string; pickupDeadline?: string }
  documents?: Array<{ url: string; type: string; format: string }>
  categories?: Array<{ id: string; label: string }>
  seedShipment?: Record<string, unknown>
  /** Force the /shipping-document endpoint to return a Boxtal error (M0.3 not-ready). */
  docError?: { status: number; body: string }
  /** Force the /tracking endpoint to return a Boxtal error (M0.3 not-ready). */
  trackError?: { status: number; body: string }
  /** Force the /shipping-order endpoint to return a Boxtal error (e.g. a 404 for an unknown id). */
  orderError?: { status: number; body: string }
}) {
  const db = createMockDb({
    seed: {
      shipment: opts?.seedShipment
        ? [opts.seedShipment]
        : [
            {
              id: "s1",
              boxtal_order_id: "ord-1",
              external_id: "#ORD-1001",
              document_ref: "doc-1",
              order_status: "PENDING",
              tracking_status: null,
              tracking_number: null,
              link_state: "created",
              recipient_summary: "Acme",
              offer_code: "CHRP-Chrono18",
              documents: [],
            },
          ],
    },
  })
  const calls: Array<{ url: string; method: string }> = []
  const fetch = async (url: string, o?: { method?: string }) => {
    calls.push({ url, method: o?.method ?? "GET" })
    if (url.includes("/iam/account-app/token")) {
      return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
    }
    if (url.includes("/content-category")) {
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: opts?.categories ?? [{ id: "content:v1:10120", label: "Electronics" }] }) }
    }
    if (url.includes("/tracking")) {
      if (opts?.trackError) return { status: opts.trackError.status, headers: {}, body: opts.trackError.body }
      const t = opts?.tracking ?? { status: "IN_TRANSIT", number: "TRK1" }
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: [{ status: t.status, trackingNumber: t.number, trackingDateTime: "2026-06-02T00:00:00Z", ...(t.pickupDeadline ? { pickupDeadline: t.pickupDeadline } : {}), history: [] }] }) }
    }
    if (url.includes("/shipping-document")) {
      if (opts?.docError) return { status: opts.docError.status, headers: {}, body: opts.docError.body }
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: opts?.documents ?? [] }) }
    }
    if (url.includes("/shipping-order")) {
      if (opts?.orderError) return { status: opts.orderError.status, headers: {}, body: opts.orderError.body }
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: { id: "ord-1", status: opts?.order?.status ?? "PENDING" } }) }
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
  return { ctx, db, calls }
}

describe("free reads", () => {
  it("track returns live tracking merged with the link row", async () => {
    const { ctx } = makeCtx({ tracking: { status: "IN_TRANSIT", number: "TRK1" } })
    const res = await track(ctx, { id: "ord-1" })
    expect(res.tracking_status).toBe("IN_TRANSIT")
    expect(res.tracking_number).toBe("TRK1")
    // Regression (stuck-shipment-exception-sweep): track surfaces the external ORDER reference from the
    // link row so a per-shipment track read yields the order for the dossier (no separate shopify call).
    expect(res.external_id).toBe("#ORD-1001")
    // An in-transit parcel has no pickup deadline.
    expect(res.pickup_deadline).toBeNull()
    // only projected fields, never raw Boxtal payload
    expect("history" in res).toBe(false)
  })

  it("track/get_shipment/get_documents reject an unresolved @ref token with a clear error, not a 22P02", async () => {
    // Regression (prod alert: 11 x '22P02 invalid input syntax for type uuid'): an agent passing the
    // create_shipment @ref token straight into a standalone read leaked it into a uuid/text query.
    // @ref resolution only happens on the approvals cascade path, never a standalone call, so the read
    // must reject early with an agent-actionable message.
    const refToken = "@ref:11111111-1111-4111-8111-111111111111:boxtal_order_id"
    const { ctx } = makeCtx({ tracking: { status: "IN_TRANSIT", number: "TRK1" } })
    for (const call of [
      () => track(ctx, { id: refToken }),
      () => getShipment(ctx, { id: refToken }),
      () => getDocuments(ctx, { id: refToken }),
    ]) {
      await expect(call()).rejects.toThrow(/unresolved @ref token/i)
    }
    // A real id is unaffected.
    const ok = await track(ctx, { id: "ord-1" })
    expect(ok.tracking_status).toBe("IN_TRANSIT")
  })

  it("track surfaces the carrier pickup_deadline for a parcel awaiting collection at a pickup point", async () => {
    // Regression (marco-mondial-relay-pickup-expiry-followup): track must expose the
    // authoritative carrier-reported collection deadline so the agent decides which relay
    // parcels are about to expire from THIS field, not a fabricated date.
    const { ctx } = makeCtx({
      tracking: { status: "REACHED_DELIVERY_PICKUP_POINT", number: "MR-PU-1", pickupDeadline: "2026-06-25" },
    })
    const res = await track(ctx, { id: "ord-1" })
    expect(res.tracking_status).toBe("REACHED_DELIVERY_PICKUP_POINT")
    expect(res.pickup_deadline).toBe("2026-06-25")
  })

  it("get_shipment refreshes order + tracking and updates the link snapshot", async () => {
    const { ctx, db } = makeCtx({ order: { status: "CONFIRMED" }, tracking: { status: "DELIVERED", number: "TRK9" } })
    const res = await getShipment(ctx, { id: "ord-1" })
    expect(res.order_status).toBe("CONFIRMED")
    expect(res.tracking_status).toBe("DELIVERED")
    const row = db.__all("shipment").find((r) => r.boxtal_order_id === "ord-1")!
    expect(row.order_status).toBe("CONFIRMED")
    expect(row.tracking_status).toBe("DELIVERED")
  })

  it("get_shipment before the carrier scan keeps the stored tracking and never reads as no tracking", async () => {
    // Boxtal answers the tracking endpoint with a 404 until the carrier's first scan. The refresh
    // used to write that emptiness over the row (tracking_number: null) and hand back a bare null,
    // which an agent read as "the label has no tracking" while the label carried a real number.
    const notScanned = { status: 404, body: "NoPackageTrackingFoundException tracking" }
    const stored = makeCtx({
      trackError: notScanned,
      seedShipment: {
        id: "s1",
        boxtal_order_id: "ord-1",
        document_ref: "doc-1",
        order_status: "CONFIRMED",
        tracking_status: "ANNOUNCED",
        tracking_number: "877621799594",
        link_state: "created",
        documents: [],
      },
    })
    const kept = await getShipment(stored.ctx, { id: "ord-1" })
    expect(kept.tracking_number).toBe("877621799594")
    expect(kept.tracking_status).toBe("ANNOUNCED")
    expect(kept.tracking_note).toBeUndefined()
    const row = stored.db.__all("shipment").find((r) => r.boxtal_order_id === "ord-1")!
    expect(row.tracking_number).toBe("877621799594")

    const none = makeCtx({ trackError: notScanned })
    const pending = await getShipment(none.ctx, { id: "ord-1" })
    expect(pending.tracking_number).toBeNull()
    expect(pending.tracking_note).toMatch(/not scanned/)
    expect(pending.tracking_note).toMatch(/label/i)
    // It never read the label, so it must not hand the agent a fact about one.
    expect(pending.tracking_note).not.toMatch(/already carries/)
  })

  it("get_documents re-fetches live; PENDING with no LABEL → generating:true", async () => {
    const { ctx } = makeCtx({ documents: [] })
    const res = await getDocuments(ctx, { id: "ord-1" })
    expect(res.documents).toHaveLength(0)
    expect(res.generating).toBe(true)
  })

  it("get_documents returns descriptors (never a stored URL) when present", async () => {
    const { ctx } = makeCtx({ documents: [{ url: "https://signed/label.pdf", type: "LABEL", format: "PDF_A4" }] })
    const res = await getDocuments(ctx, { id: "ord-1" })
    expect(res.documents).toHaveLength(1)
    // the live signed url IS returned for an immediate download, but is never persisted
    expect(res.documents[0]).toMatchObject({ type: "LABEL", format: "PDF_A4" })
    expect(res.generating).toBe(false)
  })

  it("get_documents on an unknown id → empty + generating:false", async () => {
    const { ctx } = makeCtx({ documents: [], seedShipment: { id: "s1", boxtal_order_id: "ord-1", order_status: "PENDING", documents: [] } })
    const res = await getDocuments(ctx, { id: "ghost" })
    expect(res.documents).toHaveLength(0)
    expect(res.generating).toBe(false)
  })

  // Regression (2026-07-24): get_documents returned {documents:[], generating:false} when
  // called with the LOCAL shipment row id (`s1`) — the id ready_list/search/the print
  // station surface — because findRowByOrderId only matched boxtal_order_id, so the row
  // was missed AND Boxtal was queried with the wrong id. It must resolve the local id to
  // the row's boxtal_order_id and fetch the real label.
  it("get_documents resolves the LOCAL row id (ready_list/UI id), not just the Boxtal order id", async () => {
    const { ctx } = makeCtx({ documents: [{ url: "https://signed/label.pdf", type: "LABEL", format: "PDF_A4" }] })
    const res = await getDocuments(ctx, { id: "s1" }) // s1 = local row id; ord-1 = boxtal order id
    expect(res.documents).toHaveLength(1)
    expect(res.documents[0]).toMatchObject({ type: "LABEL" })
    expect(res.generating).toBe(false)
  })

  it("track resolves the LOCAL row id too — merges the link row's external_id", async () => {
    const { ctx } = makeCtx({ tracking: { status: "IN_TRANSIT", number: "TRK1" } })
    const res = await track(ctx, { id: "s1" }) // local row id, not the boxtal order id
    expect(res.tracking_status).toBe("IN_TRANSIT")
    expect(res.external_id).toBe("#ORD-1001") // was null before the fix (row missed)
  })

  // M0.3 — live Boxtal raises a functional 422 (NoShippingDocumentException /
  // NoPackageTrackingFoundException) when the label/tracking is not yet ready
  // for a fresh order; the mock always returned data so this never surfaced.
  // The reads must return a typed-empty/pending result, NOT throw a tool_error.
  it("get_documents → label-not-ready 422 (NoShippingDocument) returns generating:true (no throw)", async () => {
    const { ctx } = makeCtx({
      docError: {
        status: 422,
        body: JSON.stringify({ status: 422, errors: [{ code: "NoShippingDocumentException" }] }),
      },
    })
    const res = await getDocuments(ctx, { id: "ord-1" })
    expect(res.documents).toHaveLength(0)
    expect(res.generating).toBe(true)
  })

  it("track → tracking-not-ready 422 (NoPackageTracking) returns empty tracking (no throw)", async () => {
    const { ctx } = makeCtx({
      trackError: {
        status: 422,
        body: JSON.stringify({ status: 422, errors: [{ code: "NoPackageTrackingFoundException" }] }),
      },
    })
    const res = await track(ctx, { id: "ord-1" })
    expect(res.tracking_status).toBeNull()
    expect(res.tracking_number).toBeNull()
    expect(res.events).toHaveLength(0)
    expect(res.recipient_summary).toBe("Acme")
  })

  it("get_documents still propagates a non-not-ready error (403 — not a 404/422 read miss)", async () => {
    const { ctx } = makeCtx({ docError: { status: 403, body: "forbidden" } })
    await expect(getDocuments(ctx, { id: "ord-1" })).rejects.toThrow()
  })

  it("track and get_shipment still answer when the snapshot write-back fails (best effort, readOnly)", async () => {
    const { ctx, db } = makeCtx({ order: { status: "SHIPPED" }, tracking: { status: "IN_TRANSIT", number: "TRK1" } })
    // A run that may not write refuses every db write: the read must answer anyway.
    db.update = async () => {
      throw new Error("E_READ_ONLY_RUN_BLOCKED: ctx.db.update would write")
    }
    const t = await track(ctx, { id: "ord-1" })
    expect(t.tracking_status).toBe("IN_TRANSIT")
    expect(t.tracking_number).toBe("TRK1")
    const s = await getShipment(ctx, { id: "ord-1" })
    expect(s.order_status).toBe("SHIPPED")
    expect(s.tracking_number).toBe("TRK1")
  })

  it("list_content_categories returns id/label rows", async () => {
    const { ctx } = makeCtx()
    const res = await listContentCategories(ctx, {})
    expect(res.categories[0]).toMatchObject({ id: "content:v1:10120", label: "Electronics" })
  })
})

describe("cancel_shipment (gated)", () => {
  it("cancels a not-yet-dispatched shipment and flips the row to CANCELLED", async () => {
    const { ctx, db, calls } = makeCtx({ order: { status: "PENDING" }, tracking: { status: "ANNOUNCED", number: "TRK1" } })
    const res = await cancelShipment(ctx, { id: "ord-1" })
    expect(res.order_status).toBe("CANCELLED")
    expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/shipping-order"))).toBe(true)
    const row = db.__all("shipment").find((r) => r.boxtal_order_id === "ord-1")!
    expect(row.order_status).toBe("CANCELLED")
  })

  it("refuses to cancel a dispatched/in-transit shipment", async () => {
    const { ctx, calls } = makeCtx({ order: { status: "CONFIRMED" }, tracking: { status: "IN_TRANSIT", number: "TRK1" } })
    const res = await cancelShipment(ctx, { id: "ord-1" })
    expect(res.error?.code).toBe("already_dispatched")
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
  })

  it("an already-CANCELLED shipment is an idempotent no-op success", async () => {
    const { ctx } = makeCtx({
      order: { status: "CANCELLED" },
      seedShipment: { id: "s1", boxtal_order_id: "ord-1", order_status: "CANCELLED", tracking_status: null, documents: [] },
    })
    const res = await cancelShipment(ctx, { id: "ord-1" })
    expect(res.order_status).toBe("CANCELLED")
    expect(res.error).toBeUndefined()
  })
})

// STAGE-TIME preflight (manifest `preflight: cancel_shipment_preflight`). cancel_shipment is gated, so
// before this existed a cancel aimed at an id Boxtal does not know still parked a pending approval, and
// the failure only surfaced once a human clicked approve: an error only the agent could have fixed. A
// gated call must not be parked for a human when the data it needs is missing. The already-dispatched
// check deliberately stays in the handler: a carrier can dispatch between staging and approval.
describe("cancel_shipment stage-time preflight", () => {
  it("refuses an id Boxtal does not know, without issuing a cancel", async () => {
    const { ctx, calls } = makeCtx({ orderError: { status: 404, body: '{"status":404,"errors":[]}' } })
    const res = await cancelShipmentPreflight(ctx, { id: "ord-unknown" })
    expect(res).toMatchObject({ error: { code: "shipment_not_found" } })
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
  })

  it("lets a live, not-yet-dispatched shipment through to the gate and cancels nothing itself", async () => {
    const { ctx, calls } = makeCtx({ order: { status: "PENDING" }, tracking: { status: "ANNOUNCED" } })
    const res = await cancelShipmentPreflight(ctx, { id: "ord-1" })
    expect(res).toEqual({ ok: true })
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
  })

  it("does NOT pre-refuse an already dispatched shipment: that stays a handler-side race", async () => {
    const { ctx } = makeCtx({ order: { status: "CONFIRMED" }, tracking: { status: "IN_TRANSIT" } })
    expect(await cancelShipmentPreflight(ctx, { id: "ord-1" })).toEqual({ ok: true })
    // and the handler still refuses it, unchanged
    expect((await cancelShipment(ctx, { id: "ord-1" })).error?.code).toBe("already_dispatched")
  })
})

describe("latestEventTimestamp", () => {
  const ev = (status: string, at: string | null) => ({ status, at, label: null }) as never
  const of = (events: unknown[]) =>
    ({ tracking_number: null, tracking_status: null, events, pickup_deadline: null }) as never

  it("takes the newest event by time from a newest-first, out-of-order history", () => {
    expect(
      latestEventTimestamp(
        of([
          ev("IN_TRANSIT", "2026-07-24 17:03:00"),
          ev("DELIVERED", "2026-07-24 11:12:00"),
          ev("IN_TRANSIT", "2026-07-24 08:48:59"),
          ev("ANNOUNCED", "2026-07-22 00:00:00"),
        ]),
      ),
    ).toBe("2026-07-24 17:03:00")
  })

  it("orders zoned times by instant and skips undated events", () => {
    expect(
      latestEventTimestamp(of([ev("A", "2026-07-24T10:00:00+02:00"), ev("B", null), ev("C", "2026-07-24T09:00:00Z")])),
    ).toBe("2026-07-24T09:00:00Z")
    expect(latestEventTimestamp(of([ev("A", null)]))).toBeNull()
  })
})
