// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Webhook upstream probe. The kernel trusts this report to decide whether webhook
// silence is a dead subscription or a quiet week, so each branch pins the side it
// errs on: a reachable Boxtal reports its newest tracking status change, no live
// sender reports null (never pages), and an unreachable Boxtal reports
// `probed: false` (never read as quiet).
import { describe, expect, it } from "bun:test"
import { eventInstantMs, probeWebhookUpstream, probeWebhookUpstreamJob } from "./probe-webhook-upstream"
import { createMockDb } from "./test-db"

const CREDS = { v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" }
const NOW = Date.parse("2026-10-20T12:00:00Z")

type History = Array<{ status: string; trackingDateTime: string }>
type Live = History | "not_ready" | "boom" | "forbidden"

function makeCtx(opts: {
  shipments: Array<Record<string, unknown>>
  live?: Record<string, Live>
  connected?: boolean
  tokenFails?: boolean
}) {
  const db = createMockDb({ seed: { shipment: opts.shipments } })
  const calls: string[] = []
  // The host runs the bearer exchange; a failed one answers the call with its status.
  const fetch = async (url: string, o?: { auth?: { exchange?: unknown } }) => {
    if (o?.auth?.exchange && opts.tokenFails) return { status: 503, headers: {}, body: "unavailable" }
    calls.push(url)
    const id = (url.split("/shipping-order/")[1] ?? "").split("/")[0] ?? ""
    const live = opts.live?.[id]
    if (live === "not_ready") return { status: 404, headers: {}, body: "NoPackageTrackingFoundException tracking" }
    if (live === "boom") return { status: 500, headers: {}, body: "upstream exploded" }
    if (live === "forbidden") return { status: 403, headers: {}, body: "forbidden" }
    const content = live
      ? [{ status: live[0]?.status ?? "ANNOUNCED", trackingNumber: "T", history: live }]
      : []
    return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content }) }
  }
  const ctx = {
    orgId: "org-1",
    db,
    fetch,
    connections:
      opts.connected === false ? {} : { boxtal: { getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }), getAccounts: async () => [] } },
    config: { get: async () => "whsecret", has: async () => true },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as any
  return { ctx, calls }
}

const ship = (id: string, order: string, extra: Record<string, unknown> = {}) => ({
  id,
  boxtal_order_id: order,
  order_status: "CONFIRMED",
  tracking_status: "IN_TRANSIT",
  created_at: "2026-10-18T10:00:00Z",
  ...extra,
})

const now = () => NOW

describe("probeWebhookUpstream", () => {
  it("reports the newest status change across shipments, read live from Boxtal tracking", async () => {
    const { ctx, calls } = makeCtx({
      shipments: [ship("1", "o1"), ship("2", "o2", { created_at: "2026-10-19T10:00:00Z" })],
      live: {
        // Newest-first, as Boxtal returns it.
        o1: [
          { status: "IN_TRANSIT", trackingDateTime: "2026-10-19T09:00:00Z" },
          { status: "ANNOUNCED", trackingDateTime: "2026-10-18T00:00:00Z" },
        ],
        o2: [
          { status: "DELIVERED", trackingDateTime: "2026-10-20T08:30:00Z" },
          { status: "IN_TRANSIT", trackingDateTime: "2026-10-19T15:00:00Z" },
        ],
      },
    })
    expect(await probeWebhookUpstream(ctx, { now })).toEqual({ upstreamActivityAt: "2026-10-20T08:30:00.000Z" })
    expect(calls.every((u) => u.endsWith("/tracking"))).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it("a repeated checkpoint under the same status is not a status change", async () => {
    const { ctx } = makeCtx({
      shipments: [ship("1", "o1")],
      live: {
        o1: [
          { status: "IN_TRANSIT", trackingDateTime: "2026-10-20T10:00:00Z" },
          { status: "IN_TRANSIT", trackingDateTime: "2026-10-19T10:00:00Z" },
          { status: "ANNOUNCED", trackingDateTime: "2026-10-18T00:00:00Z" },
        ],
      },
    })
    expect(await probeWebhookUpstream(ctx, { now })).toEqual({ upstreamActivityAt: "2026-10-19T10:00:00.000Z" })
  })

  it("a zoneless Boxtal time is shifted back to a lower bound, a future one is ignored", async () => {
    expect(eventInstantMs("2026-10-20 10:00:00")).toBe(Date.parse("2026-10-19T20:00:00Z"))
    expect(eventInstantMs("2026-10-20T10:00:00+02:00")).toBe(Date.parse("2026-10-20T08:00:00Z"))
    const { ctx } = makeCtx({
      shipments: [ship("1", "o1")],
      live: {
        o1: [
          { status: "DELIVERED", trackingDateTime: "2026-10-21T10:00:00Z" },
          { status: "IN_TRANSIT", trackingDateTime: "2026-10-20 10:00:00" },
        ],
      },
    })
    expect(await probeWebhookUpstream(ctx, { now })).toEqual({ upstreamActivityAt: "2026-10-19T20:00:00.000Z" })
  })

  it("not connected has no sender: null without calling Boxtal", async () => {
    const { ctx, calls } = makeCtx({ shipments: [ship("1", "o1")], connected: false })
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({ upstreamActivityAt: null })
    expect(calls).toEqual([])
  })

  it("nothing to track has no sender: null without calling Boxtal", async () => {
    const { ctx, calls } = makeCtx({
      shipments: [ship("1", "", { order_status: "PENDING" }), ship("2", "o2", { order_status: "CANCELLED" })],
    })
    expect(await probeWebhookUpstream(ctx, { now })).toEqual({ upstreamActivityAt: null })
    expect(calls).toEqual([])
  })

  it("tracking not generated yet is no activity, not a failed read: null", async () => {
    const { ctx } = makeCtx({ shipments: [ship("1", "o1")], live: { o1: "not_ready" } })
    expect(await probeWebhookUpstream(ctx, { now })).toEqual({ upstreamActivityAt: null })
  })

  it("a recent delivered shipment is still probed, an old delivered one is not", async () => {
    const old = Array.from({ length: 12 }, (_, i) =>
      ship(`old${i}`, `oo${i}`, { tracking_status: "DELIVERED", created_at: `2026-09-0${(i % 9) + 1}T10:00:00Z` }),
    )
    const { ctx, calls } = makeCtx({
      shipments: [...old, ship("new", "onew", { tracking_status: "DELIVERED", created_at: "2026-10-19T10:00:00Z" })],
      live: { onew: [{ status: "DELIVERED", trackingDateTime: "2026-10-20T09:00:00Z" }] },
    })
    expect(await probeWebhookUpstream(ctx, { now })).toEqual({ upstreamActivityAt: "2026-10-20T09:00:00.000Z" })
    expect(calls.length).toBeLessThanOrEqual(10)
  })

  it("unreachable Boxtal is no report, never a quiet one", async () => {
    const { ctx } = makeCtx({ shipments: [ship("1", "o1")], tokenFails: true })
    const result = await probeWebhookUpstream(ctx, { now })
    expect("upstreamActivityAt" in result).toBe(false)
    expect(result).toMatchObject({ probed: false })
  })

  it("a connection row whose credentials cannot be read is no report, not a disconnected app", async () => {
    const { ctx, calls } = makeCtx({ shipments: [ship("1", "o1")] })
    ctx.connections = {
      boxtal: {
        getAccounts: async () => [{ id: "ca1", ownerType: "org", ownerId: null, identifier: "boxtal", displayName: null }],
        getSettings: async () => {
          throw new Error("decrypt failed")
        },
      },
    }
    const result = await probeWebhookUpstream(ctx, { now })
    expect(result).toMatchObject({ probed: false })
    expect(calls).toEqual([])
  })

  it("no connection row (the kernel read throws for it too) has no sender: null", async () => {
    const { ctx } = makeCtx({ shipments: [ship("1", "o1")] })
    ctx.connections = {
      getAccounts: async () => "[]",
      getSettings: async () => {
        throw new Error('No connected account for connection "boxtal"')
      },
    }
    expect(await probeWebhookUpstream(ctx, { now })).toEqual({ upstreamActivityAt: null })
  })

  it("credentials Boxtal refuses (403) stop the run as no report", async () => {
    const { ctx, calls } = makeCtx({
      shipments: [ship("1", "o1", { created_at: "2026-10-19T10:00:00Z" }), ship("2", "o2")],
      live: { o1: "forbidden", o2: [{ status: "IN_TRANSIT", trackingDateTime: "2026-10-19T10:00:00Z" }] },
    })
    const result = await probeWebhookUpstream(ctx, { now })
    expect(result).toMatchObject({ probed: false })
    expect((result as { reason: string }).reason).toContain("refused")
    expect(calls).toHaveLength(1)
  })

  it("tracking reads erroring with nothing found is no report", async () => {
    const { ctx } = makeCtx({ shipments: [ship("1", "o1"), ship("2", "o2")], live: { o1: "boom", o2: "not_ready" } })
    const result = await probeWebhookUpstream(ctx, { now })
    expect("upstreamActivityAt" in result).toBe(false)
    expect(result).toMatchObject({ probed: false })
  })

  it("bounds the run to the limit, newest shipments first", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      ship(`s${i}`, `o${i}`, { created_at: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 3600_000).toISOString() }),
    )
    const { ctx, calls } = makeCtx({ shipments: many })
    await probeWebhookUpstream(ctx, { now, limit: 5 })
    expect(calls.map((u) => (u.split("/shipping-order/")[1] ?? "").split("/")[0])).toEqual([
      "o29",
      "o28",
      "o27",
      "o26",
      "o25",
    ])
  })
})
