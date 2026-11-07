// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The WORKLIST SCAN itself (orders.ts), straight at `openOrdersScan` rather than through prep_list.
//
// Each case here pins a defect the scan actually shipped with, and the pins are deliberately at
// this level because they are about what the scan ASKS Shopify and what it does with a Shopify
// answer it does not like: the queue's definition (which fulfillment states are shipping work), the
// fail-soft rule (a read failure returns the cached rows, never an empty queue), the row-scoped
// read's parity with the list read, the pending-proforma re-key, money scaling, anchor determinism
// and the untrusted order number that reaches a Shopify search query.

import { describe, expect, it } from "bun:test"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import {
  lookupOrderForPrefill,
  openOrdersScan,
  OPEN_ORDERS_QUERY,
  OPEN_ORDER_FULFILLMENT_VALUES,
  pickGoodsInvoice,
  type OrderDocumentLink,
} from "./orders"
import { createMockDb } from "./test-db"

interface OrderFixture {
  order_id: string
  name?: string
  customer?: string
  email?: string
  fulfillmentStatus?: string
  financialStatus?: string | null
  cancelledAt?: string | null
  currency?: string
  totalAmount?: string | number
  createdAt?: string
  tags?: string[]
  note?: string | null
}

function hitFor(o: OrderFixture): Record<string, unknown> {
  return {
    id: `gid://shopify/Order/${o.order_id}`,
    name: o.name ?? `#${o.order_id}`,
    title: o.name ?? `#${o.order_id}`,
    currency: o.currency ?? "EUR",
    attributes: {
      tags: o.tags ?? [],
      note: o.note ?? null,
      financialStatus: o.financialStatus === undefined ? "PAID" : o.financialStatus,
      fulfillmentStatus: o.fulfillmentStatus ?? "UNFULFILLED",
      cancelledAt: o.cancelledAt ?? null,
      createdAt: o.createdAt ?? "2026-08-01T10:00:00.000Z",
      totalAmount: o.totalAmount ?? "100.00",
      shippingCountryCode: "FR",
      shippingAddress1: "12 rue de la Paix",
      shippingCity: "Paris",
      shippingZip: "75002",
      customer: { displayName: o.customer ?? "Customer", email: o.email ?? "buyer@example.com" },
      lineItems: [],
    },
  }
}

/** Which `fulfillment_status` search term matches which displayFulfillmentStatus (shopify.dev). */
const TERM_MATCHES: Record<string, Set<string>> = {
  unfulfilled: new Set(["UNFULFILLED"]),
  unshipped: new Set(["UNFULFILLED", "PARTIALLY_FULFILLED", "IN_PROGRESS", "PENDING_FULFILLMENT"]),
  partial: new Set(["PARTIALLY_FULFILLED"]),
  on_hold: new Set(["ON_HOLD"]),
  scheduled: new Set(["SCHEDULED"]),
  request_declined: new Set(["REQUEST_DECLINED"]),
  fulfilled: new Set(["FULFILLED"]),
  shipped: new Set(["FULFILLED"]),
}

interface ScanCtxOpts {
  orders?: OrderFixture[]
  seed?: Record<string, Array<Record<string, unknown>>>
  /** Documents per numeric order id. */
  documents?: Record<string, OrderDocumentLink[]>
  ordersSearchError?: string
  ordersGetError?: string
  /** Order ids Shopify answers about with a null result (the order is gone). */
  ordersGetAbsent?: string[]
  issuedProformas?: Array<Record<string, unknown>>
}

function makeCtx(opts: ScanCtxOpts = {}): {
  ctx: BoxtalToolCtx
  db: ReturnType<typeof createMockDb>
  calls: Array<{ target: string; args: unknown }>
} {
  const db = createMockDb({ seed: opts.seed ?? {} })
  const calls: Array<{ target: string; args: unknown }> = []
  const byId = new Map((opts.orders ?? []).map((o) => [o.order_id, o] as const))
  const executeTool = async (target: string, rawArgs: unknown): Promise<CrossAppEnvelope> => {
    calls.push({ target, args: rawArgs })
    const args = (typeof rawArgs === "string" ? {} : rawArgs) as Record<string, unknown>
    if (target === "shopify:orders_search") {
      if (opts.ordersSearchError) {
        return { status: "error", error: { code: "upstream", message: opts.ordersSearchError } }
      }
      const query = String(args.query ?? "")
      const wanted = [...query.matchAll(/fulfillment_status:([a-z_]+)/g)].map((m) => m[1]!)
      const nameTerm = /name:"?(#[0-9]+)"?/.exec(query)?.[1] ?? null
      const results = (opts.orders ?? [])
        .filter((o) => {
          if (nameTerm) return (o.name ?? `#${o.order_id}`) === nameTerm
          if (wanted.length > 0) {
            const status = o.fulfillmentStatus ?? "UNFULFILLED"
            if (!wanted.some((t) => TERM_MATCHES[t]?.has(status))) return false
          }
          if (query.includes("status:open") && o.cancelledAt) return false
          return true
        })
        .map(hitFor)
      return { status: "completed", result: { results, nextCursor: null } }
    }
    if (target === "shopify:orders_get") {
      if (opts.ordersGetError) {
        return { status: "error", error: { code: "upstream", message: opts.ordersGetError } }
      }
      const id = String(args.id ?? "").replace(/^.*\//, "")
      if (opts.ordersGetAbsent?.includes(id)) return { status: "completed", result: null }
      const found = byId.get(id)
      return { status: "completed", result: found ? hitFor(found) : null }
    }
    if (target === "invoicing:documents_for_orders") {
      const ids = (args.shopify_order_ids as string[] | undefined) ?? []
      const links = ids.flatMap((id) => opts.documents?.[id] ?? [])
      return { status: "completed", result: { links } }
    }
    if (target === "invoicing:documents_search") {
      return { status: "completed", result: { results: opts.issuedProformas ?? [] } }
    }
    return { status: "error", error: { code: "unmocked", message: `no stub for ${target}` } }
  }
  return {
    ctx: {
      orgId: "org-1",
      db,
      fetch: (async () => ({ status: 200, headers: {}, body: "{}" })) as never,
      connections: {},
      config: { get: async () => null, has: async () => false },
      executeTool,
    } as unknown as BoxtalToolCtx,
    db,
    calls,
  }
}

const GOODS = (id: string, number: string, orderId = "5001"): OrderDocumentLink => ({
  shopify_order_id: orderId,
  id,
  number,
  type: "invoice",
  scope: "goods",
  status: "issued",
  payment_status: "paid",
})

describe("the worklist query", () => {
  it("asks for every fulfillment state that still has units to pack, not only UNFULFILLED", () => {
    // fulfillment_status is a DISTINCT-VALUE filter on the real API, so the old single
    // `fulfillment_status:unfulfilled` term provably excluded ON_HOLD, SCHEDULED and
    // PARTIALLY_FULFILLED orders: a Shopify-held order and a half-packed order left the queue.
    expect(OPEN_ORDERS_QUERY).toContain("status:open")
    for (const value of ["unfulfilled", "partial", "on_hold", "scheduled"] as const) {
      expect(OPEN_ORDER_FULFILLMENT_VALUES).toContain(value)
      expect(OPEN_ORDERS_QUERY).toContain(`fulfillment_status:${value}`)
    }
    // Grouped with the documented connectives, so the states are alternatives of ONE open-order set.
    expect(OPEN_ORDERS_QUERY).toBe(
      `status:open AND (${OPEN_ORDER_FULFILLMENT_VALUES.map((v) => `fulfillment_status:${v}`).join(" OR ")})`,
    )
    expect(OPEN_ORDERS_QUERY).not.toContain("fulfillment_status:fulfilled")
  })

  it("lists an ON_HOLD and a PARTIALLY_FULFILLED order, and never a FULFILLED one", async () => {
    const { ctx } = makeCtx({
      orders: [
        { order_id: "5001", fulfillmentStatus: "UNFULFILLED" },
        { order_id: "5002", fulfillmentStatus: "ON_HOLD" },
        { order_id: "5003", fulfillmentStatus: "PARTIALLY_FULFILLED" },
        { order_id: "5004", fulfillmentStatus: "SCHEDULED" },
        { order_id: "5005", fulfillmentStatus: "FULFILLED" },
      ],
    })
    const scan = await openOrdersScan(ctx)
    expect(scan.candidates.map((c) => c.order_key).sort()).toEqual([
      "so:5001",
      "so:5002",
      "so:5003",
      "so:5004",
    ])
  })
})

describe("the Shopify staff note rides on the row", () => {
  it("maps the search hit's attributes.note onto staff_note, null when the order carries none", async () => {
    const { ctx } = makeCtx({
      orders: [
        { order_id: "5001", note: "Add the free strap, customer asked twice" },
        { order_id: "5002" },
      ],
    })
    const scan = await openOrdersScan(ctx)
    const byKey = new Map(scan.candidates.map((c) => [c.order_key, c]))
    expect(byKey.get("so:5001")!.staff_note).toBe("Add the free strap, customer asked twice")
    expect(byKey.get("so:5002")!.staff_note).toBeNull()
  })

  it("a row asked for by the order's name or gid reads under the order's own id, with its invoice", async () => {
    const { ctx } = makeCtx({
      orders: [{ order_id: "5001", name: "#1042" }],
      documents: { "5001": [GOODS("inv-1", "F-2026-0001")] },
    })
    // orders_get resolves an order by its name as well as by its id.
    const base = ctx.executeTool
    ctx.executeTool = async (target, args) => {
      if (target === "shopify:orders_get" && (args as { id?: string }).id === "#1042") {
        return base(target, { id: "5001" })
      }
      return base(target, args)
    }
    for (const key of ["so:#1042", "so:gid://shopify/Order/5001"]) {
      const scan = await openOrdersScan(ctx, { order_keys: [key] })
      expect(scan.candidates.map((c) => c.order_key), key).toEqual(["so:5001"])
      expect(scan.candidates[0]!.anchor_ref, key).toBe("inv-1")
      expect(scan.key_aliases?.get(key)).toBe("so:5001")
    }
  })

  it("a scoped re-read takes the note from orders_get's top-level `note`", async () => {
    const { ctx } = makeCtx({ orders: [{ order_id: "5001" }] })
    // orders_get puts the note at the top level, not under attributes; the fixture only fills
    // attributes.note, so answer this read by hand.
    const base = ctx.executeTool
    ctx.executeTool = async (target, args) => {
      if (target === "shopify:orders_get") {
        return { status: "completed", result: { id: "gid://shopify/Order/5001", name: "#5001", note: "Ship Friday" } }
      }
      return base(target, args)
    }
    const scan = await openOrdersScan(ctx, { order_keys: ["so:5001"] })
    expect(scan.candidates[0]!.staff_note).toBe("Ship Friday")
  })

  it("falls back to the cached note when Shopify cannot be read", async () => {
    const { ctx } = makeCtx({
      ordersSearchError: "Shopify is unreachable",
      seed: {
        prep_meta: [
          {
            id: "m1",
            document_ref: "inv-1",
            shopify_order_id: "5001",
            order_name: "#1042",
            order_tags: [],
            staff_note: "Gift wrap",
            financial_status: "PAID",
            fetched_at: new Date().toISOString(),
          },
        ],
      },
      documents: { "5001": [GOODS("inv-1", "F-2026-0001")] },
    })
    const scan = await openOrdersScan(ctx)
    expect(scan.candidates[0]!.staff_note).toBe("Gift wrap")
  })
})

describe("fail soft: a Shopify read failure never empties the worklist", () => {
  it("returns the CACHED rows plus last_sync_error when orders_search fails", async () => {
    const { ctx } = makeCtx({
      ordersSearchError: "Shopify is unreachable",
      seed: {
        prep_meta: [
          {
            id: "m1",
            document_ref: "inv-1",
            shopify_order_id: "5001",
            order_name: "#1042",
            order_tags: ["dealer"],
            order_created_at: "2026-08-01T10:00:00.000Z",
            financial_status: "PAID",
            fetched_at: new Date().toISOString(),
          },
        ],
      },
      documents: { "5001": [GOODS("inv-1", "F-2026-0001")] },
    })
    const scan = await openOrdersScan(ctx)
    expect(scan.last_sync_error).toBe("Shopify is unreachable")
    // The whole point: the operator's queue is still there, stale and saying so.
    expect(scan.candidates.map((c) => c.order_key)).toEqual(["so:5001"])
    const row = scan.candidates[0]!
    expect(row.order_name).toBe("#1042")
    expect(row.order_tags).toEqual(["dealer"])
    expect(row.anchor_ref).toBe("inv-1")
  })

  it("does not resurrect a cached row that is refunded, cancelled or long stale", async () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
    const { ctx } = makeCtx({
      ordersSearchError: "Shopify is unreachable",
      seed: {
        prep_meta: [
          { id: "m1", document_ref: "inv-1", shopify_order_id: "5001", financial_status: "REFUNDED", fetched_at: new Date().toISOString() },
          { id: "m2", document_ref: "inv-2", shopify_order_id: "5002", cancelled_at: "2026-08-02T00:00:00Z", fetched_at: new Date().toISOString() },
          { id: "m3", document_ref: "inv-3", shopify_order_id: "5003", fetched_at: old },
        ],
      },
    })
    const scan = await openOrdersScan(ctx)
    expect(scan.candidates.map((c) => c.order_key)).toEqual([])
    expect(scan.last_sync_error).toBe("Shopify is unreachable")
  })
})

describe("the row-scoped read agrees with the list read", () => {
  it("keeps the row, its order name and its error when orders_get fails", async () => {
    const { ctx } = makeCtx({
      ordersGetError: "Shopify timed out",
      seed: {
        prep_meta: [
          {
            id: "m1",
            document_ref: "inv-1",
            shopify_order_id: "5001",
            order_name: "#1042",
            order_tags: ["dealer"],
            fetched_at: new Date().toISOString(),
          },
        ],
      },
      documents: { "5001": [GOODS("inv-1", "F-2026-0001")] },
    })
    const scan = await openOrdersScan(ctx, { order_keys: ["so:5001"] })
    // The row is NOT dropped (dropping it removes it from the grid) and NOT blanked either.
    expect(scan.candidates.map((c) => c.order_key)).toEqual(["so:5001"])
    expect(scan.candidates[0]!.order_name).toBe("#1042")
    expect(scan.candidates[0]!.order_tags).toEqual(["dealer"])
    expect(scan.last_sync_error).toBe("Shopify did not answer, so these rows were not refreshed.")
  })

  it("drops a row whose order came back REFUNDED since the list read", async () => {
    const { ctx } = makeCtx({ orders: [{ order_id: "5001", financialStatus: "REFUNDED" }] })
    const scan = await openOrdersScan(ctx, { order_keys: ["so:5001"] })
    expect(scan.candidates).toEqual([])
    // A refused row is not a read failure: nothing to report.
    expect(scan.last_sync_error).toBeNull()
  })

  it("drops a row Shopify no longer knows about, and says nothing failed", async () => {
    const { ctx } = makeCtx({ orders: [{ order_id: "5001" }], ordersGetAbsent: ["5001"] })
    const scan = await openOrdersScan(ctx, { order_keys: ["so:5001"] })
    expect(scan.candidates).toEqual([])
    expect(scan.last_sync_error).toBeNull()
  })

  it("follows the re-key when the row's pending proforma settles during this very read", async () => {
    const { ctx, db } = makeCtx({
      seed: {
        prep_order_state: [
          {
            id: "s1",
            order_key: "pending:tok9",
            status: "to_prepare",
            category: "repair",
            excluded: false,
            proforma_pending_approval_id: "ap-1",
            recipient: { name: "Repair Owner", countryIsoCode: "FR" },
          },
        ],
      },
      issuedProformas: [{ id: "prof-9", number: "PF-9", shipment_ref: "prep:pending:tok9" }],
    })
    const scan = await openOrdersScan(ctx, { order_keys: ["pending:tok9"] })
    // Asked for the OLD key: the answer must be the row under its NEW identity, not a phantom
    // document-less sale row (no anchor, category sale, customer "-").
    expect(scan.candidates.map((c) => c.order_key)).toEqual(["doc:prof-9"])
    const row = scan.candidates[0]!
    expect(row.anchor_ref).toBe("prof-9")
    expect(row.anchor_kind).toBe("proforma")
    expect(row.category).toBe("repair")
    expect(row.customer).toBe("Repair Owner")
    expect(db.__all("prep_order_state")[0]!.order_key).toBe("doc:prof-9")
  })

  it("a read's scan (bestEffortWrites) still answers with the settled row when recording it fails", async () => {
    const seed = {
      prep_order_state: [
        {
          id: "s1",
          order_key: "pending:tok9",
          status: "to_prepare",
          category: "repair",
          excluded: false,
          proforma_pending_approval_id: "ap-1",
          recipient: { name: "Repair Owner", countryIsoCode: "FR" },
        },
      ],
    }
    const issuedProformas = [{ id: "prof-9", number: "PF-9", shipment_ref: "prep:pending:tok9" }]
    const { ctx, db } = makeCtx({ seed, issuedProformas })
    db.update = async () => {
      throw new Error("E_READ_ONLY_RUN_BLOCKED: ctx.db.update would write")
    }
    const scan = await openOrdersScan(ctx, { order_keys: ["pending:tok9"], bestEffortWrites: true })
    expect(scan.candidates.map((c) => c.order_key)).toEqual(["doc:prof-9"])
    // Not recorded: the next scan settles it again.
    expect(db.__all("prep_order_state")[0]!.order_key).toBe("pending:tok9")
    // Any other caller of the scan still fails loudly on the same write.
    const strict = makeCtx({ seed, issuedProformas })
    strict.db.update = db.update
    await expect(openOrdersScan(strict.ctx, { order_keys: ["pending:tok9"] })).rejects.toThrow(
      "E_READ_ONLY_RUN_BLOCKED",
    )
  })
})

describe("money and anchor determinism", () => {
  it("scales the order total by the currency exponent, not by a hardcoded 100", async () => {
    const { ctx } = makeCtx({
      orders: [
        { order_id: "5001", currency: "JPY", totalAmount: "5000" },
        { order_id: "5002", currency: "EUR", totalAmount: "50.00" },
      ],
    })
    const scan = await openOrdersScan(ctx)
    const byKey = new Map(scan.candidates.map((c) => [c.order_key, c]))
    // JPY is zero-decimal: 5000 JPY is 5000 minor units, not 500000.
    expect(byKey.get("so:5001")!.order_total_minor).toBe(5000)
    expect(byKey.get("so:5002")!.order_total_minor).toBe(5000)
  })

  it("picks the same goods invoice whatever order documents_for_orders happens to return them in", () => {
    const older = GOODS("inv-a", "F-2026-0007")
    const newer = GOODS("inv-b", "F-2026-0008")
    // documents_for_orders reads with no orderBy, so postgres row order is arbitrary and can flip
    // between two reads: the anchor must not move with it.
    expect(pickGoodsInvoice([older, newer])!.id).toBe("inv-b")
    expect(pickGoodsInvoice([newer, older])!.id).toBe("inv-b")
  })
})

describe("order-number prefill lookup", () => {
  it("refuses an order number carrying extra search syntax instead of running it", async () => {
    const { ctx, calls } = makeCtx({ orders: [{ order_id: "5001", name: "#1042" }] })
    expect(await lookupOrderForPrefill(ctx, "1042 tag:vip")).toBeNull()
    expect(await lookupOrderForPrefill(ctx, 'x" OR name:#1043')).toBeNull()
    // Nothing was asked of Shopify at all: the input is not an order number.
    expect(calls.filter((c) => c.target === "shopify:orders_search")).toHaveLength(0)
  })

  it("quotes the order name and returns nothing when no hit matches it exactly", async () => {
    const { ctx, calls } = makeCtx({ orders: [{ order_id: "5001", name: "#1042" }] })
    const found = await lookupOrderForPrefill(ctx, "1042")
    expect(found?.shopify_order_id).toBe("5001")
    expect((calls[0]!.args as { query: string }).query).toBe('name:"#1042"')
    // A near miss must NOT silently prefill a different customer's address and items.
    const { ctx: ctx2 } = makeCtx({ orders: [{ order_id: "5001", name: "#1042" }] })
    expect(await lookupOrderForPrefill(ctx2, "9999")).toBeNull()
  })
})
