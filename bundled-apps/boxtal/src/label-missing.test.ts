// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { BoxtalToolCtx } from "./ctx"
import { checkMissingLabels, LABEL_MISSING_AFTER_MS, LABEL_MISSING_RECHECK_MS } from "./label-missing"
import { createMockDb } from "./test-db"

const T0 = Date.parse("2026-11-03T09:00:00Z")
const CREDS = { v1Key: "k1", v1Secret: "s1", v3Key: "k3", v3Secret: "s3", environment: "sandbox" }

function boughtRow(id: string, minutesAgo: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    boxtal_order_id: `ord-${id}`,
    external_id: `#${id}`,
    order_status: "PENDING",
    tracking_status: null,
    link_state: "created",
    documents: [],
    created_at: new Date(T0 - minutesAgo * 60_000).toISOString(),
    ...extra,
  }
}

function makeCtx(rows: Array<Record<string, unknown>>, boxtalLabels: string[] = []) {
  const db = createMockDb({ seed: { shipment: rows } })
  const events: Array<{ entity: string; action: string; entityId?: string; data?: Record<string, unknown> }> = []
  const connected = boxtalLabels.length > 0
  const documentReads: string[] = []
  const ctx: BoxtalToolCtx = {
    orgId: "org-1",
    db,
    fetch: async (url: string) => {
      if (url.includes("/shipping-order/")) documentReads.push(url)
      if (url.includes("/iam/account-app/token")) {
        return { status: 200, headers: {}, body: JSON.stringify({ accessToken: "tok", expiresIn: 3600 }) }
      }
      const id = (url.split("/shipping-order/")[1] ?? "").split("/")[0] ?? ""
      const content = boxtalLabels.includes(id) ? [{ url: "https://document.boxtal.com/l.pdf", type: "LABEL", format: "PDF" }] : []
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content }) }
    },
    connections: connected
      ? { boxtal: { getSettings: async () => ({ values: { environment: CREDS.environment }, missing: [] }), getToken: async () => { throw new Error("no") }, getAccounts: async () => [] } }
      : {},
    config: { get: async () => null, has: async () => false },
    executeTool: async () => ({ ok: true, data: null }) as never,
    logger: { info() {}, warn() {} },
    emit: async (e) => {
      events.push(e)
    },
  }
  return { ctx, db, events, documentReads }
}

describe("checkMissingLabels", () => {
  it("raises one attention item for labels still absent 15 minutes after purchase, once", async () => {
    const { ctx, db, events } = makeCtx([
      boughtRow("1", 16),
      boughtRow("2", 30),
      boughtRow("3", 5), // too recent
      boughtRow("4", 40, { documents: [{ type: "LABEL", format: "PDF" }] }), // has its label
      boughtRow("5", 40, { order_status: "CANCELLED" }),
    ])
    const first = await checkMissingLabels(ctx, { now: T0, heal: false })
    expect(first).toEqual({ missing: 2, alerted: true, resolved: false })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ entity: "queue", action: "labels_missing", entityId: "ready" })
    expect(events[0]!.data).toMatchObject({ count: 2, resolved: false })
    expect(String(events[0]!.data!.orders)).toContain("#1")

    // Next pass, nothing new: no second item.
    await checkMissingLabels(ctx, { now: T0 + 60_000, heal: false })
    expect(events).toHaveLength(1)
    expect(db.__all("shipment").filter((r) => r.label_missing_alerted).map((r) => r.id).sort()).toEqual(["1", "2"])
  })

  it("does nothing before the 15 minutes are up", async () => {
    const { ctx, events } = makeCtx([boughtRow("1", 0)])
    await checkMissingLabels(ctx, { now: T0 + LABEL_MISSING_AFTER_MS - 1, heal: false })
    expect(events).toHaveLength(0)
    await checkMissingLabels(ctx, { now: T0 + LABEL_MISSING_AFTER_MS, heal: false })
    expect(events).toHaveLength(1)
  })

  it("clears the item once every missing label has arrived", async () => {
    const { ctx, db, events } = makeCtx([boughtRow("1", 20), boughtRow("2", 20)])
    await checkMissingLabels(ctx, { now: T0, heal: false })
    await db.update("shipment", "1", { documents: [{ type: "LABEL", format: "PDF" }] })
    const partial = await checkMissingLabels(ctx, { now: T0, heal: false })
    expect(partial.resolved).toBe(false)
    expect(events).toHaveLength(2)
    expect(events[1]!.data).toMatchObject({ count: 1, resolved: false })
    await db.update("shipment", "2", { documents: [{ type: "LABEL", format: "PDF" }] })
    const done = await checkMissingLabels(ctx, { now: T0, heal: false })
    expect(done).toEqual({ missing: 0, alerted: false, resolved: true })
    expect(events.at(-1)).toMatchObject({ entity: "queue", action: "labels_missing", entityId: "ready", data: { resolved: true } })
    expect(db.__all("shipment").some((r) => r.label_missing_alerted)).toBe(false)
  })

  it("a label Boxtal has but never announced is stored, and raises nothing", async () => {
    const { ctx, db, events } = makeCtx([boughtRow("1", 20)], ["ord-1"])
    const res = await checkMissingLabels(ctx, { now: T0 })
    expect(res.missing).toBe(0)
    expect(events).toHaveLength(0)
    expect(db.__all("shipment")[0]!.documents).toEqual([{ type: "LABEL", format: "PDF" }])
  })

  it("updates the item's count and orders when part of the missing set arrives", async () => {
    const { ctx, db, events } = makeCtx([boughtRow("1", 20), boughtRow("2", 20)])
    await checkMissingLabels(ctx, { now: T0, heal: false })
    expect(events[0]!.data).toMatchObject({ count: 2 })
    await db.update("shipment", "1", { documents: [{ type: "LABEL", format: "PDF" }] })
    await checkMissingLabels(ctx, { now: T0, heal: false })
    expect(events).toHaveLength(2)
    expect(events[1]!.data).toMatchObject({ count: 1, orders: "#2", resolved: false })
    // Unchanged on the next pass: no re-emit.
    await checkMissingLabels(ctx, { now: T0, heal: false })
    expect(events).toHaveLength(2)
  })

  it("re-reads Boxtal for an alerted row only after the backoff", async () => {
    // Connected (ord-other has a label), but ord-1 still has none.
    const { ctx, documentReads } = makeCtx([boughtRow("1", 20)], ["ord-other"])
    await checkMissingLabels(ctx, { now: T0 })
    expect(documentReads).toHaveLength(1)
    // Alerted: the 15-minute passes do not ask Boxtal again.
    await checkMissingLabels(ctx, { now: T0 + 15 * 60_000 })
    await checkMissingLabels(ctx, { now: T0 + 30 * 60_000 })
    expect(documentReads).toHaveLength(1)
    // After the backoff it asks once more.
    await checkMissingLabels(ctx, { now: T0 + LABEL_MISSING_RECHECK_MS + 60_000 })
    expect(documentReads).toHaveLength(2)
  })

  it("leaves alone a label bought more than 3 days ago", async () => {
    const { ctx, events, documentReads } = makeCtx([boughtRow("1", 4 * 24 * 60)], ["ord-other"])
    const res = await checkMissingLabels(ctx, { now: T0 })
    expect(res.missing).toBe(0)
    expect(events).toHaveLength(0)
    expect(documentReads).toHaveLength(0)
  })

  it("an alerted row that ages past 3 days leaves the item", async () => {
    const { ctx, events } = makeCtx([boughtRow("1", 20), boughtRow("2", 3 * 24 * 60 - 10)])
    await checkMissingLabels(ctx, { now: T0, heal: false })
    expect(events[0]!.data).toMatchObject({ count: 2 })
    await checkMissingLabels(ctx, { now: T0 + 20 * 60_000, heal: false })
    expect(events.at(-1)!.data).toMatchObject({ count: 1, orders: "#1", resolved: false })
  })
})
