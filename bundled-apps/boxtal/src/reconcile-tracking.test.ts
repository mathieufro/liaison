// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The scheduled tracking-reconciliation safety net.
//
// Context (prod, 2026-06-30 → 2026-07-31): every Boxtal webhook was rejected at
// the verifier with 401 signature_mismatch, BEFORE any handler or ledger row, so
// the failure was completely silent. tracking_status stopped being written for a
// month: 19 of 23 shipments had none at all, and delivered parcels sat in the
// operator's Ready-to-ship queue. These tests pin the job that makes the local
// index converge on Boxtal regardless of whether a single webhook ever lands.
import { describe, expect, it } from "bun:test"
import {
  byStalestFirst,
  isReconcilable,
  boxtalOrderProbe,
  type OrphanRow,
  reconcileOrphanedCreates,
  reconcileTracking,
  reconcileTrackingJobHandler,
  ORPHAN_REPORT_INTERVAL_MS,
  settleOrphanedCreate,
  settleOrphanedCreatePreflight,
} from "./reconcile-tracking"
import { BoxtalApiError } from "./lib/boxtal-v3-client"
import { createMockDb } from "./test-db"
import { applyTrackingChanged, reserveCreate } from "./link-store"

const CREDS = { v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" }

/** Per-order canned live state, keyed by boxtal_order_id. */
interface LiveState {
  order: string
  tracking?: { status: string; number?: string; history?: Array<{ status: string; trackingDateTime: string }> } | "not_ready" | "boom"
}

function makeCtx(opts: {
  shipments: Array<Record<string, unknown>>
  live: Record<string, LiveState>
  connected?: boolean
}) {
  const db = createMockDb({ seed: { shipment: opts.shipments } })
  const calls: string[] = []
  const orderIdOf = (url: string): string => {
    const m = url.match(/\/(?:shipping-order|shipping-order\/[^/]+\/tracking)\/?/)
    void m
    // Both endpoints embed the order id as the segment after /shipping-order/.
    const seg = url.split("/shipping-order/")[1] ?? ""
    return seg.split("/")[0] ?? ""
  }
  const fetch = async (url: string, o?: { method?: string }) => {
    calls.push(`${o?.method ?? "GET"} ${url}`)
    if (url.includes("/iam/account-app/token")) {
      return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
    }
    const id = orderIdOf(url)
    const state = opts.live[id]
    if (url.includes("/tracking")) {
      if (!state || state.tracking === undefined) {
        return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: [] }) }
      }
      if (state.tracking === "not_ready") {
        // The real Boxtal "tracking not generated yet" shape isBoxtalNotReady matches.
        return { status: 404, headers: {}, body: "NoPackageTrackingFoundException tracking" }
      }
      if (state.tracking === "boom") {
        return { status: 500, headers: {}, body: "upstream exploded" }
      }
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          status: 200,
          timestamp: "t",
          content: [
            {
              status: state.tracking.status,
              trackingNumber: state.tracking.number ?? null,
              trackingDateTime: "2026-07-31T00:00:00Z",
              // A real payload carries the checkpoint history; the EVENT timestamp in it is
              // what the replay watermark must be stamped from (never a wall clock).
              history: state.tracking.history ?? [
                { status: state.tracking.status, trackingDateTime: "2026-07-31T00:00:00Z", message: "ok" },
              ],
            },
          ],
        }),
      }
    }
    if (url.includes("/shipping-order")) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          status: 200,
          timestamp: "t",
          content: { id, status: state?.order ?? "PENDING" },
        }),
      }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
  }
  const ctx = {
    orgId: "org-1",
    db,
    fetch,
    connections:
      opts.connected === false
        ? {}
        : { boxtal: { getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }), getToken: async () => { throw new Error("no") }, getAccounts: async () => [] } },
    config: { get: async () => "whsecret", has: async () => true },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as any
  return { ctx, db, calls }
}

describe("isReconcilable", () => {
  it("polls in-flight rows and skips terminal / cancelled / order-less ones", () => {
    const inFlight = { id: "1", boxtal_order_id: "o1", order_status: "CONFIRMED", tracking_status: "IN_TRANSIT" }
    expect(isReconcilable(inFlight)).toBe(true)
    // Never-tracked is the MOST important case: it is the silent-webhook signature.
    expect(isReconcilable({ id: "2", boxtal_order_id: "o2", order_status: "PENDING", tracking_status: null })).toBe(true)
    // Terminal — the journey is over, re-polling forever is pure waste.
    for (const t of ["DELIVERED", "RETURNED", "LOST"]) {
      expect(isReconcilable({ id: "3", boxtal_order_id: "o3", order_status: "CONFIRMED", tracking_status: t })).toBe(false)
    }
    expect(isReconcilable({ id: "4", boxtal_order_id: "o4", order_status: "CANCELLED" })).toBe(false)
    // A local draft with no Boxtal order has nothing to ask about.
    expect(isReconcilable({ id: "5", order_status: "PENDING" })).toBe(false)
    expect(isReconcilable({ id: "6", boxtal_order_id: "", order_status: "PENDING" })).toBe(false)
  })
})

describe("byStalestFirst", () => {
  it("puts never-checked rows first, then oldest-checked, deterministically", () => {
    const rows = [
      { id: "c", boxtal_order_id: "o", status_fetched_at: "2026-07-31T10:00:00Z" },
      { id: "a", boxtal_order_id: "o" },
      { id: "b", boxtal_order_id: "o", status_fetched_at: "2026-07-01T10:00:00Z" },
    ]
    expect([...rows].sort(byStalestFirst).map((r) => r.id)).toEqual(["a", "b", "c"])
  })
})

describe("reconcileTracking", () => {
  it("recovers the state a dead webhook stream never delivered", async () => {
    // Exactly the prod shape: rows frozen at their creation state while Boxtal
    // has long since moved them on.
    const { ctx, db } = makeCtx({
      shipments: [
        { id: "s1", boxtal_order_id: "o1", order_status: "PENDING", tracking_status: null, tracking_number: null },
        { id: "s2", boxtal_order_id: "o2", order_status: "CONFIRMED", tracking_status: "ANNOUNCED", tracking_number: "T2" },
      ],
      live: {
        o1: { order: "CONFIRMED", tracking: { status: "DELIVERED", number: "T1" } },
        o2: { order: "CONFIRMED", tracking: { status: "IN_TRANSIT", number: "T2" } },
      },
    })
    const res = await reconcileTracking(ctx)
    expect(res).toMatchObject({ candidates: 2, checked: 2, updated: 2, failed: 0 })

    const s1 = (await db.findOne("shipment", "s1")) as Record<string, unknown>
    expect(s1.order_status).toBe("CONFIRMED")
    expect(s1.tracking_status).toBe("DELIVERED")
    expect(s1.tracking_number).toBe("T1")
    expect(s1.status_fetched_at).toBeTruthy()

    const s2 = (await db.findOne("shipment", "s2")) as Record<string, unknown>
    expect(s2.tracking_status).toBe("IN_TRANSIT")
  })

  it("stamps polled_at but writes no status change when nothing moved", async () => {
    const { ctx, db } = makeCtx({
      shipments: [
        { id: "s1", boxtal_order_id: "o1", order_status: "CONFIRMED", tracking_status: "IN_TRANSIT", tracking_number: "T1" },
      ],
      live: { o1: { order: "CONFIRMED", tracking: { status: "IN_TRANSIT", number: "T1" } } },
    })
    const res = await reconcileTracking(ctx)
    expect(res.updated).toBe(0)
    expect(res.checked).toBe(1)
    const s1 = (await db.findOne("shipment", "s1")) as Record<string, unknown>
    expect(s1.tracking_status).toBe("IN_TRANSIT")
    expect(s1.polled_at).toBeTruthy()
    // NEVER the wall clock on this column: it is the webhook replay guard, not a poll log.
    expect(s1.status_fetched_at).toBeUndefined()
  })

  // Prod, 2026-09-14. This job used to stamp `status_fetched_at = now()` on every row it polled,
  // but that column is ALSO the link-store's replay guard: an incoming event older than it is
  // dropped. Boxtal stamps an ANNOUNCED event at MIDNIGHT (date precision), so a single poll made
  // every tracking webhook for the rest of that day "older than stored" and the guard threw them
  // all away — five parcels held a null tracking number for hours while Boxtal had the numbers.
  it("a poll does not silence the tracking webhooks for the rest of the day", async () => {
    const { ctx, db } = makeCtx({
      shipments: [
        { id: "s1", boxtal_order_id: "o1", order_status: "CONFIRMED", tracking_status: null, tracking_number: null },
      ],
      // Nothing has moved yet: the poll writes no status, only its own timestamp.
      live: { o1: { order: "CONFIRMED", tracking: "not_ready" } },
    })
    await reconcileTracking(ctx)

    // Now the webhook lands, carrying Boxtal's midnight-stamped ANNOUNCED event.
    const applied = await applyTrackingChanged(ctx, "o1", {
      tracking_status: "ANNOUNCED",
      tracking_number: "877164440733",
      at: "2026-09-14 00:00:00",
    })
    expect(applied).toEqual({ applied: true })
    const s1 = (await db.findOne("shipment", "s1")) as Record<string, unknown>
    expect(s1.tracking_status).toBe("ANNOUNCED")
    expect(s1.tracking_number).toBe("877164440733")
  })

  it("advances the replay watermark to the EVENT time, not the wall clock", async () => {
    // When a poll DOES move the state it owns the watermark, so a webhook replaying that same
    // event is still correctly ignored — the guard keeps working, it just stops over-reaching.
    const { ctx, db } = makeCtx({
      shipments: [
        { id: "s1", boxtal_order_id: "o1", order_status: "CONFIRMED", tracking_status: null, tracking_number: null },
      ],
      live: { o1: { order: "CONFIRMED", tracking: { status: "IN_TRANSIT", number: "T1" } } },
    })
    await reconcileTracking(ctx)
    const s1 = (await db.findOne("shipment", "s1")) as Record<string, unknown>
    expect(s1.tracking_status).toBe("IN_TRANSIT")
    // The harness dates every tracking event 2026-07-31T00:00:00Z.
    expect(s1.status_fetched_at).toBe("2026-07-31T00:00:00Z")
    expect(s1.polled_at).toBeTruthy()
  })

  it("stamps the NEWEST event as the watermark from a newest-first, out-of-order history", async () => {
    // The live shape: Boxtal lists history newest first, and a carrier can report a checkpoint
    // after a later one. Taking the last entry stamped the oldest event (ANNOUNCED at midnight),
    // which moves the replay guard backwards.
    const { ctx, db } = makeCtx({
      shipments: [
        { id: "s1", boxtal_order_id: "o1", order_status: "CONFIRMED", tracking_status: null, tracking_number: null },
      ],
      live: {
        o1: {
          order: "CONFIRMED",
          tracking: {
            status: "IN_TRANSIT",
            number: "T1",
            history: [
              { status: "IN_TRANSIT", trackingDateTime: "2026-07-24 17:03:00" },
              { status: "DELIVERED", trackingDateTime: "2026-07-24 11:12:00" },
              { status: "IN_TRANSIT", trackingDateTime: "2026-07-24 08:48:59" },
              { status: "ANNOUNCED", trackingDateTime: "2026-07-22 00:00:00" },
            ],
          },
        },
      },
    })
    await reconcileTracking(ctx)
    const s1 = (await db.findOne("shipment", "s1")) as Record<string, unknown>
    expect(s1.status_fetched_at).toBe("2026-07-24 17:03:00")
  })

  it("skips terminal and cancelled rows entirely (no Boxtal call for them)", async () => {
    const { ctx, calls } = makeCtx({
      shipments: [
        { id: "done", boxtal_order_id: "o-done", order_status: "CONFIRMED", tracking_status: "DELIVERED" },
        { id: "void", boxtal_order_id: "o-void", order_status: "CANCELLED" },
        { id: "live", boxtal_order_id: "o-live", order_status: "CONFIRMED", tracking_status: "IN_TRANSIT" },
      ],
      live: { "o-live": { order: "CONFIRMED", tracking: { status: "OUT_FOR_DELIVERY" } } },
    })
    const res = await reconcileTracking(ctx)
    expect(res.candidates).toBe(1)
    expect(calls.some((u) => u.includes("o-done"))).toBe(false)
    expect(calls.some((u) => u.includes("o-void"))).toBe(false)
    expect(calls.some((u) => u.includes("o-live"))).toBe(true)
  })

  it("keeps the order status when tracking is not generated yet", async () => {
    // A label bought seconds ago has an order but no carrier tracking. That is a
    // normal state, not a failure, and must not blank an existing tracking value.
    const { ctx, db } = makeCtx({
      shipments: [
        { id: "s1", boxtal_order_id: "o1", order_status: "PENDING", tracking_status: null, tracking_number: null },
      ],
      live: { o1: { order: "CONFIRMED", tracking: "not_ready" } },
    })
    const res = await reconcileTracking(ctx)
    expect(res.failed).toBe(0)
    const s1 = (await db.findOne("shipment", "s1")) as Record<string, unknown>
    expect(s1.order_status).toBe("CONFIRMED")
    expect(s1.tracking_status).toBeNull()
  })

  it("one failing shipment does not abort the batch", async () => {
    const { ctx, db } = makeCtx({
      shipments: [
        { id: "bad", boxtal_order_id: "o-bad", order_status: "CONFIRMED", tracking_status: "ANNOUNCED" },
        { id: "good", boxtal_order_id: "o-good", order_status: "CONFIRMED", tracking_status: "ANNOUNCED" },
      ],
      live: {
        "o-bad": { order: "CONFIRMED", tracking: "boom" },
        "o-good": { order: "CONFIRMED", tracking: { status: "DELIVERED" } },
      },
    })
    const res = await reconcileTracking(ctx)
    expect(res.failed).toBe(1)
    expect(res.updated).toBe(1)
    const good = (await db.findOne("shipment", "good")) as Record<string, unknown>
    expect(good.tracking_status).toBe("DELIVERED")
  })

  it("bounds one run and round-robins the stalest rows first", async () => {
    const { ctx } = makeCtx({
      shipments: [
        { id: "fresh", boxtal_order_id: "o-fresh", order_status: "CONFIRMED", tracking_status: "ANNOUNCED", status_fetched_at: "2026-07-31T12:00:00Z" },
        { id: "never", boxtal_order_id: "o-never", order_status: "CONFIRMED", tracking_status: null },
      ],
      live: {
        "o-never": { order: "CONFIRMED", tracking: { status: "IN_TRANSIT" } },
        "o-fresh": { order: "CONFIRMED", tracking: { status: "IN_TRANSIT" } },
      },
    })
    const res = await reconcileTracking(ctx, { limit: 1 })
    expect(res.candidates).toBe(2)
    expect(res.checked).toBe(1)
    // The never-checked row is the one that got the slot.
    expect(res.updated).toBe(1)
  })

  it("reports an empty run instead of failing when the app is not connected", async () => {
    const { ctx } = makeCtx({
      shipments: [{ id: "s1", boxtal_order_id: "o1", order_status: "PENDING" }],
      live: {},
      connected: false,
    })
    const res = await reconcileTracking(ctx)
    expect(res).toEqual({
      candidates: 0,
      checked: 0,
      updated: 0,
      failed: 0,
      orphans: { candidates: 0, checked: 0, resolved: 0, unresolved: 0, failed: 0 },
    })
  })

  it("exposes a kernel-shaped (payload, ctx) job handler", async () => {
    const { ctx } = makeCtx({
      shipments: [{ id: "s1", boxtal_order_id: "o1", order_status: "PENDING", tracking_status: null }],
      live: { o1: { order: "CONFIRMED", tracking: { status: "DELIVERED" } } },
    })
    const res = await reconcileTrackingJobHandler(undefined, ctx)
    expect(res.updated).toBe(1)
  })
})

// ── orphaned create reservations ────────────────────────────────────────────
//
// create_shipment is NOT atomic and the sandbox worker pool kills a handler at
// 62s with no rollback: a kill between createShippingOrder returning (the label
// is PAID) and finalizeCreated writing the order id leaves a create_in_flight
// row with no boxtal_order_id and no tracking_status, which every tracking-based
// queue is structurally blind to. This sweep resolves what it can prove and
// reports the rest. It can never buy, re-buy or cancel anything.
// The label reader is a download plus a decode: reconcile must not repeat it on every 15 minute run.
describe("reconcileTracking: the label-read tracking number", () => {
  const labelled = { order_status: "CONFIRMED", tracking_status: null, documents: [{ type: "LABEL", format: "PDF_A4" }] }

  it("never re-downloads the label of a row whose number is already held, already marked to confirm, or of a carrier it cannot read", async () => {
    const { ctx, calls } = makeCtx({
      shipments: [
        { id: "s1", boxtal_order_id: "o1", ...labelled, offer_code: "FEDX-FedexRegionalEconomy", tracking_number: "877740925574", tracking_from_label: true },
        { id: "s2", boxtal_order_id: "o2", ...labelled, offer_code: "UPSE-Standard", tracking_number: null, tracking_to_confirm: true },
        { id: "s3", boxtal_order_id: "o3", ...labelled, offer_code: "MONR-CpourToi", tracking_number: null },
      ],
      live: {
        o1: { order: "CONFIRMED", tracking: { status: "ANNOUNCED" } },
        o2: { order: "CONFIRMED", tracking: "not_ready" },
        o3: { order: "CONFIRMED", tracking: "not_ready" },
      },
    })
    await reconcileTracking(ctx)
    expect(calls.filter((c) => c.includes("/shipping-document"))).toEqual([])
  })

  it("a tracking read without a number keeps the label-read one", async () => {
    const { ctx, db } = makeCtx({
      shipments: [
        { id: "s1", boxtal_order_id: "o1", ...labelled, offer_code: "FEDX-FedexRegionalEconomy", tracking_number: "877740925574", tracking_from_label: true },
      ],
      live: { o1: { order: "CONFIRMED", tracking: { status: "ANNOUNCED" } } },
    })
    await reconcileTracking(ctx)
    const s1 = (await db.findOne("shipment", "s1")) as Record<string, unknown>
    expect(s1.tracking_number).toBe("877740925574")
    expect(s1.tracking_from_label).toBe(true)
  })

  it("the carrier's own number, found by polling, clears the label flag", async () => {
    const { ctx, db } = makeCtx({
      shipments: [
        { id: "s1", boxtal_order_id: "o1", ...labelled, offer_code: "FEDX-FedexRegionalEconomy", tracking_number: "877740925574", tracking_from_label: true },
      ],
      live: { o1: { order: "CONFIRMED", tracking: { status: "IN_TRANSIT", number: "877740925574" } } },
    })
    await reconcileTracking(ctx)
    const s1 = (await db.findOne("shipment", "s1")) as Record<string, unknown>
    expect(s1.tracking_from_label).toBe(false)
  })
})

describe("reconcileOrphanedCreates", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
  const STALE = ago(45 * 60 * 1000)
  const FRESH = ago(20 * 1000)

  function sweepCtx(rows: Array<Record<string, unknown>>) {
    const db = createMockDb({ seed: { shipment: rows } })
    const ctx = { orgId: "org-1", db, logger: { info() {}, warn() {} } } as any
    return { ctx, db }
  }

  /** A probe client that would SPEND money if the sweep ever called it. */
  function probeClient(opts: { byId?: Record<string, string>; byExternalId?: Record<string, string> }) {
    const spend: string[] = []
    const client = {
      v3: {
        getShippingOrder: async (id: string) => {
          const status = opts.byId?.[id]
          if (!status) throw new Error(`(404) ShippingOrderNotFoundException ${id}`)
          return { id, order_status: status } as any
        },
        findShippingOrderByExternalId: async (externalId: string) => {
          const hit = opts.byExternalId?.[externalId]
          return hit ? ({ id: hit, order_status: "CONFIRMED" } as any) : null
        },
        createShippingOrder: async () => {
          spend.push("createShippingOrder")
          throw new Error("the sweep must never buy a label")
        },
        cancel: async () => {
          spend.push("cancel")
          throw new Error("the sweep must never cancel a shipment")
        },
      },
    }
    return { client, spend }
  }

  it("resolves a stale create_in_flight row whose Boxtal order matches by external_id", async () => {
    const { ctx, db } = sweepCtx([
      { id: "o1", link_state: "create_in_flight", order_status: null, boxtal_order_id: null, external_id: "#1042", document_ref: "doc-1", created_at: STALE },
    ])
    const { client, spend } = probeClient({ byExternalId: { "#1042": "BX-RECOVERED" } })
    const res = await reconcileOrphanedCreates(ctx, db.__all("shipment") as unknown as OrphanRow[], boxtalOrderProbe(client))
    expect(res).toMatchObject({ candidates: 1, checked: 1, resolved: 1, unresolved: 0, failed: 0 })
    const row = db.__all("shipment")[0]!
    expect(row.link_state).toBe("created")
    expect(row.boxtal_order_id).toBe("BX-RECOVERED")
    expect(row.order_status).toBe("CONFIRMED")
    // No buy, no cancel: this sweep cannot spend money.
    expect(spend).toEqual([])
  })

  it("resolves a stale create_uncertain row by reading its order id back", async () => {
    const { ctx, db } = sweepCtx([
      { id: "o2", link_state: "create_uncertain", order_status: null, boxtal_order_id: "BX-7", created_at: STALE },
    ])
    const { client, spend } = probeClient({ byId: { "BX-7": "PENDING" } })
    const res = await reconcileOrphanedCreates(ctx, db.__all("shipment") as unknown as OrphanRow[], boxtalOrderProbe(client))
    expect(res.resolved).toBe(1)
    expect(db.__all("shipment")[0]!.link_state).toBe("created")
    expect(spend).toEqual([])
  })

  it("REPORTS, never guesses, when Boxtal has no match: the row is left exactly as it is", async () => {
    const { ctx, db } = sweepCtx([
      { id: "o3", link_state: "create_in_flight", order_status: null, boxtal_order_id: null, external_id: "#NOPE", created_at: STALE },
    ])
    const { client, spend } = probeClient({})
    const res = await reconcileOrphanedCreates(ctx, db.__all("shipment") as unknown as OrphanRow[], boxtalOrderProbe(client))
    expect(res).toMatchObject({ candidates: 1, checked: 1, resolved: 0, unresolved: 1, failed: 0 })
    const row = db.__all("shipment")[0]!
    expect(row.link_state).toBe("create_in_flight")
    expect(row.boxtal_order_id).toBeNull()
    expect(row.order_status).toBeNull()
    expect(spend).toEqual([])
  })

  it("leaves a FRESH in-flight reservation completely alone (never probed, never written)", async () => {
    const { ctx, db } = sweepCtx([
      { id: "o4", link_state: "create_in_flight", order_status: null, boxtal_order_id: null, external_id: "#LIVE", created_at: FRESH },
    ])
    let probed = 0
    const res = await reconcileOrphanedCreates(ctx, db.__all("shipment") as unknown as OrphanRow[], async () => {
      probed++
      return null
    })
    expect(res).toMatchObject({ candidates: 0, checked: 0, resolved: 0, unresolved: 0, failed: 0 })
    expect(probed).toBe(0)
    expect(db.__all("shipment")[0]!.link_state).toBe("create_in_flight")
  })

  it("never touches finished, cancelled, or age-unknown rows", async () => {
    const { ctx, db } = sweepCtx([
      { id: "d1", link_state: "created", order_status: "PENDING", boxtal_order_id: "BX-OK", created_at: STALE },
      { id: "d2", link_state: "create_in_flight", order_status: "CANCELLED", created_at: STALE },
      { id: "d3", link_state: "create_in_flight", order_status: null, created_at: null },
    ])
    const res = await reconcileOrphanedCreates(ctx, db.__all("shipment") as unknown as OrphanRow[], async () => {
      throw new Error("must not probe")
    })
    expect(res.candidates).toBe(0)
    expect(res.checked).toBe(0)
  })

  it("rides along on the reconcile-tracking cron and issues no POST or DELETE to Boxtal", async () => {
    const { ctx, db, calls } = makeCtx({
      shipments: [
        { id: "s1", boxtal_order_id: "o1", order_status: "PENDING", tracking_status: null, link_state: "created", created_at: STALE },
        { id: "s2", link_state: "create_in_flight", order_status: null, boxtal_order_id: null, external_id: "#ORPHAN", created_at: STALE },
      ],
      live: { o1: { order: "CONFIRMED", tracking: { status: "IN_TRANSIT", number: "TRK" } } },
    })
    const res = await reconcileTracking(ctx)
    // The orphan is seen, cannot be matched (Boxtal has no list/search read), and
    // is reported for a human instead of being guessed at.
    expect(res.orphans).toMatchObject({ candidates: 1, checked: 1, resolved: 0, unresolved: 1 })
    expect(db.__all("shipment").find((r) => r.id === "s2")!.link_state).toBe("create_in_flight")
    // Read-only: no create POST, no cancel DELETE anywhere in the run.
    // (the only POST in a healthy run is the /iam token exchange)
    const writes = calls.filter((c) => /^(POST|DELETE|PUT|PATCH) /.test(c) && c.includes("/shipping-order"))
    expect(writes).toEqual([])
  })
})

// ── orphan sweep log cadence ────────────────────────────────────────────────
// An orphan nobody has settled used to log "needs a human" on every 15-minute
// tick, forever. It now logs once, then at most once a day; stuck_list keeps it
// visible in between.
describe("reconcileOrphanedCreates: log cadence", () => {
  const T0 = Date.parse("2026-11-01T10:00:00.000Z")
  const STALE = new Date(T0 - 45 * 60 * 1000).toISOString()

  it("logs an unresolved orphan once, stays quiet on later ticks, and logs again after the interval", async () => {
    const db = createMockDb({
      seed: { shipment: [{ id: "q1", link_state: "create_in_flight", order_status: null, boxtal_order_id: null, created_at: STALE }] },
    })
    const warns: string[] = []
    const ctx = { orgId: "org-1", db, logger: { info() {}, warn: (m: string) => warns.push(m) } } as any
    const tick = async (atMs: number) =>
      reconcileOrphanedCreates(ctx, db.__all("shipment") as unknown as OrphanRow[], async () => null, { now: () => atMs })
    const r1 = await tick(T0)
    expect(r1.unresolved).toBe(1)
    expect(warns).toHaveLength(1)
    expect(db.__all("shipment")[0]!.orphan_reported_at).toBe(new Date(T0).toISOString())
    // 96 more ticks inside the interval (one day of 15-minute runs, minus one): silent.
    for (let i = 1; i < 96; i++) await tick(T0 + i * 15 * 60 * 1000)
    expect(warns).toHaveLength(1)
    // Still counted as unresolved every run (so the job's result stays honest).
    expect((await tick(T0 + 60 * 1000)).unresolved).toBe(1)
    await tick(T0 + ORPHAN_REPORT_INTERVAL_MS)
    expect(warns).toHaveLength(2)
    // The row itself is untouched apart from the report stamp.
    expect(db.__all("shipment")[0]!.link_state).toBe("create_in_flight")
  })
})

// ── settling an orphan by hand ──────────────────────────────────────────────
describe("settleOrphanedCreate", () => {
  const T0 = Date.parse("2026-11-01T10:00:00.000Z")
  const STALE = new Date(T0 - 45 * 60 * 1000).toISOString()
  const YOUNG = new Date(T0 - 60 * 1000).toISOString()
  const now = () => T0

  function settleCtx(rows: Array<Record<string, unknown>>, orders: Record<string, string> = {}) {
    const db = createMockDb({ seed: { shipment: rows } })
    const ctx = { orgId: "org-1", db, logger: { info() {}, warn() {} } } as any
    const spend: string[] = []
    const reads: string[] = []
    const client = async () => ({
      v3: {
        getShippingOrder: async (id: string) => {
          reads.push(id)
          const status = orders[id]
          if (!status) throw new BoxtalApiError(`ShippingOrderNotFoundException ${id}`, 404)
          return { id, order_status: status } as any
        },
        createShippingOrder: async () => {
          spend.push("create")
        },
        cancel: async () => {
          spend.push("cancel")
        },
      },
    })
    return { ctx, db, client, spend, reads }
  }

  const orphan = { id: "x1", link_state: "create_in_flight", order_status: null, boxtal_order_id: null, document_ref: "doc-9", kind: "outbound", batch_seq: 1, created_at: STALE }

  it("adopt: reads the named order back and links it, the sweep's own write", async () => {
    const { ctx, db, client, spend, reads } = settleCtx([orphan], { "BX-FOUND": "CONFIRMED" })
    const res = await settleOrphanedCreate(ctx, { id: "x1", outcome: "adopt", boxtal_order_id: " BX-FOUND ", note: "seen in dashboard" }, { now, client })
    expect(res).toMatchObject({ id: "x1", outcome: "adopt", link_state: "created", boxtal_order_id: "BX-FOUND", order_status: "CONFIRMED" })
    const row = db.__all("shipment")[0]!
    expect(row).toMatchObject({ link_state: "created", boxtal_order_id: "BX-FOUND", order_status: "CONFIRMED", orphan_settle_note: "seen in dashboard" })
    expect(row.orphan_settled_at).toBe(new Date(T0).toISOString())
    expect(reads).toEqual(["BX-FOUND"])
    expect(spend).toEqual([])
  })

  it("adopt: refuses an order id Boxtal does not know, and one already linked to another row", async () => {
    const { ctx, db, client } = settleCtx(
      [orphan, { id: "other", link_state: "created", order_status: "PENDING", boxtal_order_id: "BX-TAKEN", document_ref: "doc-2", created_at: STALE }],
      { "BX-TAKEN": "PENDING" },
    )
    await expect(settleOrphanedCreate(ctx, { id: "x1", outcome: "adopt", boxtal_order_id: "BX-NOPE" }, { now, client })).rejects.toMatchObject({ code: "order_not_found" })
    await expect(settleOrphanedCreate(ctx, { id: "x1", outcome: "adopt", boxtal_order_id: "BX-TAKEN" }, { now, client })).rejects.toMatchObject({ code: "already_linked" })
    await expect(settleOrphanedCreate(ctx, { id: "x1", outcome: "adopt" }, { now, client })).rejects.toMatchObject({ code: "invalid_input" })
    expect(db.__all("shipment").find((r) => r.id === "x1")!.link_state).toBe("create_in_flight")
  })

  it("release: closes the reservation locally, writes no Boxtal status, never calls Boxtal", async () => {
    const { ctx, db, client, spend, reads } = settleCtx([orphan])
    const res = await settleOrphanedCreate(ctx, { id: "x1", outcome: "release", note: "no order in the dashboard" }, { now, client })
    expect(res).toMatchObject({ outcome: "release", link_state: "create_abandoned", boxtal_order_id: null, order_status: null })
    const row = db.__all("shipment")[0]!
    expect(row.link_state).toBe("create_abandoned")
    // Never a fake CANCELLED: order_status stays what Boxtal never set.
    expect(row.order_status).toBeNull()
    expect(row.orphan_settle_note).toBe("no order in the dashboard")
    expect(reads).toEqual([])
    expect(spend).toEqual([])
  })

  it("release frees the slot: a new reservation for the same document succeeds, and the row is never swept again", async () => {
    const { ctx, db, client } = settleCtx([orphan])
    expect(await reserveCreate(ctx, { document_ref: "doc-9" })).toEqual({ ok: false, reason: "duplicate" })
    await settleOrphanedCreate(ctx, { id: "x1", outcome: "release" }, { now, client })
    const again = await reserveCreate(ctx, { document_ref: "doc-9" })
    expect(again.ok).toBe(true)
    const fresh = db.__all("shipment").find((r) => r.id === (again as { id: string }).id)!
    expect(fresh.batch_seq).toBe(2)
    // The sweep no longer sees the released row (the fresh reservation is young, so nothing at all).
    let probed = 0
    const sweep = await reconcileOrphanedCreates(ctx, db.__all("shipment") as unknown as OrphanRow[], async () => {
      probed++
      return null
    }, { now: () => T0 + 60 * 60 * 1000, staleMs: 15 * 60 * 1000 })
    // The released row is out of the sweep for good; the fresh reservation is not yet stale.
    expect(sweep.candidates).toBe(0)
    expect(probed).toBe(0)
    expect(db.__all("shipment").find((r) => r.id === "x1")!.link_state).toBe("create_abandoned")
  })

  it("release is refused on a row that already carries a Boxtal order id", async () => {
    const { ctx, client } = settleCtx([{ ...orphan, link_state: "create_uncertain", boxtal_order_id: "BX-HELD" }])
    await expect(settleOrphanedCreate(ctx, { id: "x1", outcome: "release" }, { now, client })).rejects.toMatchObject({ code: "has_order_id" })
  })

  it("refuses non-orphan rows: young, created, cancelled, already released, unknown", async () => {
    const { ctx, db, client } = settleCtx([
      { ...orphan, id: "young", created_at: YOUNG },
      { id: "done", link_state: "created", order_status: "PENDING", boxtal_order_id: "BX-1", created_at: STALE },
      { id: "gone", link_state: "create_in_flight", order_status: "CANCELLED", created_at: STALE },
      { ...orphan, id: "released", link_state: "create_abandoned" },
    ])
    for (const id of ["young", "done", "gone", "released"]) {
      await expect(settleOrphanedCreate(ctx, { id, outcome: "release" }, { now, client })).rejects.toMatchObject({ code: "not_orphan" })
    }
    await expect(settleOrphanedCreate(ctx, { id: "missing", outcome: "release" }, { now, client })).rejects.toMatchObject({ code: "not_found" })
    expect(db.__all("shipment").find((r) => r.id === "young")!.link_state).toBe("create_in_flight")
    expect(db.__all("shipment").find((r) => r.id === "done")!.link_state).toBe("created")
  })

  it("preflight returns the refusal as a typed error instead of parking a doomed approval", async () => {
    const { ctx } = settleCtx([{ id: "done", link_state: "created", order_status: "PENDING", boxtal_order_id: "BX-1", created_at: STALE }])
    const pre = await settleOrphanedCreatePreflight(ctx, { id: "done", outcome: "release" })
    expect(pre).toMatchObject({ error: { code: "not_orphan" } })
  })
})
