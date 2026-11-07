// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The "To prepare" page open fires prep_list, queue_counts and several other tool calls
// concurrently. prep_list's unscoped list read and queue_counts each ran a FULL paged live Shopify
// order scan (openOrdersScan's live branch), so two of the seven page-open calls duplicated the
// same live scan and deadlocked the sandbox's 6-worker pool against itself (prod: 39 queue_counts
// timeouts in 72h, chain:["boxtal:prep_list","shopify:orders_search"] 14 times in 72h).
//
// The plumbing built to fix that (`source: "cache" | "live"` on openOrdersScan/worklistCandidates,
// the shipped-parcel safety rule for cache mode) is real and stays. Flipping prep_list's and
// queue_counts's own DEFAULT to cache mode is HELD: nothing warms `prep_meta` for an order that was
// never prep_synced, so a cache-only default would return an empty queue for it. prep_list and
// queue_counts therefore still default to the LIVE scan (see prep.ts/queues.ts). These tests pin
// cache mode directly through `worklistCandidates`, the seam both call sites share, so the
// capability keeps its teeth even though neither call site opts into it yet. The SCOPED prep_list
// read (order_keys) and prep_sync stay live on purpose, pinned here too so nobody "fixes" the
// cache-only path into swallowing them as well.

import { describe, expect, it } from "bun:test"
import { prepList, prepSync } from "./prep"
import { queueCounts, worklistCandidates } from "./queues"
import { createMockDb } from "./test-db"
import { makeOrderScanStub, orderKeysFor, type OrderScanStubOptions } from "./__fixtures__/order-scan"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"

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

/**
 * A ctx whose `executeTool` THROWS on any `shopify:` target and whose `fetch` THROWS on any call --
 * the falsifiable guard against a live Shopify or Boxtal call sneaking into the cache-only list
 * read. `invoicingLinks` (keyed by numeric Shopify order id) answers `invoicing:documents_for_orders`
 * -- a same-org local DB read the manifest's FREE READ promise explicitly allows.
 */
function makeCacheOnlyCtx(opts: {
  seed?: Record<string, Array<Record<string, unknown>>>
  invoicingLinks?: Record<string, Array<Record<string, unknown>>>
}): { ctx: BoxtalToolCtx; calls: string[] } {
  const db = createMockDb({
    seed: {
      app_config: [{ id: "cfg-sender", key: "sender_address", value: SENDER_PARTY }],
      ...opts.seed,
    },
  })
  const calls: string[] = []
  const executeTool = async (target: string, args: unknown): Promise<CrossAppEnvelope> => {
    calls.push(target)
    if (target.startsWith("shopify:")) {
      throw new Error(`unexpected LIVE shopify call from the cache-only list read: ${target}`)
    }
    if (target === "invoicing:documents_for_orders") {
      const ids = Array.isArray((args as { shopify_order_ids?: unknown[] })?.shopify_order_ids)
        ? ((args as { shopify_order_ids: string[] }).shopify_order_ids)
        : []
      const links = ids.flatMap((id) => opts.invoicingLinks?.[id] ?? [])
      return { status: "completed", result: { links } }
    }
    return { status: "error", error: { code: "unmocked", message: target } }
  }
  const fetch = (async (url: string) => {
    throw new Error(`unexpected LIVE boxtal HTTP call from the cache-only list read: ${url}`)
  }) as unknown as BoxtalToolCtx["fetch"]
  return {
    ctx: {
      orgId: "org-1",
      db,
      fetch,
      executeTool,
      connections: {
        boxtal: {
          getSettings: async () => {
            throw new Error("no boxtal credentials expected on the cache-only list read")
          },
          getToken: async () => {
            throw new Error("no boxtal token expected on the cache-only list read")
          },
          getAccounts: async () => [],
        },
      },
      config: { get: async () => null, has: async () => false },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    } as never,
    calls,
  }
}

function seededOrder(overrides?: Partial<Record<string, unknown>>) {
  return {
    document_ref: "doc-A",
    shopify_order_id: "5001",
    order_name: "#1001",
    order_tags: [],
    order_created_at: "2026-07-01T10:00:00.000Z",
    financial_status: "PAID",
    cancelled_at: null,
    fetched_at: new Date().toISOString(),
    ...overrides,
  }
}

describe("worklistCandidates cache mode", () => {
  it("makes no live shopify call and returns the seeded candidate", async () => {
    const { ctx, calls } = makeCacheOnlyCtx({
      seed: { prep_meta: [seededOrder()] },
    })
    const { candidates } = await worklistCandidates(ctx, { source: "cache" })
    expect(calls.some((t) => t.startsWith("shopify:"))).toBe(false)
    expect(candidates.length).toBe(1)
    expect(candidates[0]!.order_key).toBe("so:5001")
  })

  it("drops an order row whose shipment is already live (shipped parcel safety)", async () => {
    const { ctx } = makeCacheOnlyCtx({
      seed: {
        prep_meta: [seededOrder()],
        shipment: [
          {
            id: "ship-1",
            kind: "sale",
            order_status: "CONFIRMED",
            document_ref: "doc-A",
            line_quantities: null,
          },
        ],
      },
      invoicingLinks: {
        "5001": [
          {
            shopify_order_id: "5001",
            id: "doc-A",
            number: "INV-1",
            type: "invoice",
            scope: "goods",
            status: "issued",
            payment_status: "paid",
          },
        ],
      },
    })
    const { candidates } = await worklistCandidates(ctx, { source: "cache" })
    expect(candidates.some((c) => c.order_key === "so:5001")).toBe(false)
  })
})

describe("prep_list and queue_counts default to the live scan", () => {
  it("prep_list's unscoped read still reaches the live shopify scan", async () => {
    const { ctx, calls } = makeLiveCtx()
    await prepList(ctx, {})
    expect(calls).toContain("shopify:orders_search")
  })

  it("queue_counts still reaches the live shopify scan", async () => {
    const { ctx, calls } = makeLiveCtx()
    await queueCounts(ctx)
    expect(calls).toContain("shopify:orders_search")
  })
})

// ── the deliberate LIVE exceptions, pinned so the cache-only fix never swallows them ──────────────

function invoice(id: string) {
  return {
    id,
    currency: "EUR",
    incoterm: "DAP",
    counterparty_country: "FR",
    counterparty_name: `Customer ${id}`,
    counterparty_contact_id: `contact-${id}`,
    shopify_order_id: `gid://shopify/Order/${id}`,
    issued_at: "2026-07-01",
    lines: [],
  }
}

function makeLiveCtx(scan: OrderScanStubOptions = {}) {
  const invoices = [invoice("inv-1")]
  const db = createMockDb({
    seed: { app_config: [{ id: "cfg-sender", key: "sender_address", value: SENDER_PARTY }] },
  })
  const scanStub = makeOrderScanStub(invoices as never, scan)
  const calls: string[] = []
  const executeTool = async (target: string, args: unknown): Promise<CrossAppEnvelope> => {
    calls.push(target)
    const scanned = scanStub(target, args as Record<string, unknown>)
    if (scanned) return scanned
    if (target === "invoicing:documents_search") {
      return { status: "completed", result: invoices.map((d) => ({ channel: "shopify", ...d })) }
    }
    return { status: "error", error: { code: "unmocked", message: target } }
  }
  const ctx = {
    orgId: "org-1",
    db,
    fetch: async () => {
      throw new Error("no boxtal http expected")
    },
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
  } as never as BoxtalToolCtx
  return { ctx, calls, keys: [...orderKeysFor(invoices as never, scan).values()] }
}

describe("prep_sync stays live", () => {
  it("still runs the live open orders scan on the unscoped path", async () => {
    const { ctx, calls } = makeLiveCtx()
    await prepSync(ctx, {})
    expect(calls).toContain("shopify:orders_search")
  })
})

describe("prep_list scoped read stays live", () => {
  it("refreshes exactly the named rows live via shopify orders_get", async () => {
    const { ctx, calls, keys } = makeLiveCtx()
    await prepList(ctx, { order_keys: keys })
    expect(calls).toContain("shopify:orders_get")
  })
})
