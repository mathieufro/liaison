// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { warmPrepMetaForDocument } from "./prep-meta"
import type { BoxtalToolCtx } from "./ctx"
import { createMockDb } from "./test-db"

const ORDER = {
  name: "#3445",
  attributes: {
    createdAt: "2026-08-21T08:00:00.000Z",
    tags: ["vip"],
    financialStatus: "PAID",
    cancelledAt: null,
  },
}

function makeCtx(opts: {
  seed?: Record<string, Array<Record<string, unknown>>>
  document?: Record<string, unknown> | null
  order?: Record<string, unknown> | null
  onCall?: (target: string) => void
}): BoxtalToolCtx {
  const db = createMockDb({ seed: opts.seed ?? {} })
  const executeTool = async (target: string) => {
    opts.onCall?.(target)
    if (target === "invoicing:documents_get") {
      return { status: "completed", result: opts.document ?? null }
    }
    if (target === "shopify:orders_get") {
      return { status: "completed", result: opts.order ?? null }
    }
    return { status: "error", error: { code: "unmocked", message: target } }
  }
  return {
    orgId: "org_1",
    db,
    fetch: (async () => new Response("")) as unknown as BoxtalToolCtx["fetch"],
    connections: {},
    config: { get: async () => null, has: async () => false },
    executeTool: executeTool as unknown as BoxtalToolCtx["executeTool"],
  } as BoxtalToolCtx
}

async function metaRow(ctx: BoxtalToolCtx): Promise<Record<string, unknown> | undefined> {
  const rows = (await ctx.db.findMany("prep_meta", { limit: 10 })) as Array<Record<string, unknown>>
  return rows[0]
}

describe("warmPrepMetaForDocument", () => {
  // The gap this closes: only prep_sync ever wrote prep_meta, so a document nobody synced
  // reached the label buy with no order number and no ORDER DATE — an unsortable row at the
  // bottom of the print station's oldest-first queue.
  it("caches the order number and order date for a document that was never synced", async () => {
    const ctx = makeCtx({ document: { id: "doc-1", shopify_order_id: "5551" }, order: ORDER })
    expect(await warmPrepMetaForDocument(ctx, "doc-1")).toBe(true)
    expect(await metaRow(ctx)).toMatchObject({
      document_ref: "doc-1",
      shopify_order_id: "5551",
      order_name: "#3445",
      order_created_at: "2026-08-21T08:00:00.000Z",
      financial_status: "PAID",
    })
  })

  it("leaves an already-warm row alone, staff note included", async () => {
    // prep_sync knows strictly more than this path (it carries the staff note); overwriting its
    // row from here would silently drop that note on every label buy.
    const ctx = makeCtx({
      seed: {
        prep_meta: [
          {
            id: "m1",
            document_ref: "doc-1",
            shopify_order_id: "5551",
            order_name: "#3445",
            order_created_at: "2026-08-21T08:00:00.000Z",
            staff_note: "call before delivery",
          },
        ],
      },
      document: { id: "doc-1", shopify_order_id: "5551" },
      order: { ...ORDER, name: "#9999" },
    })
    expect(await warmPrepMetaForDocument(ctx, "doc-1")).toBe(false)
    expect(await metaRow(ctx)).toMatchObject({ order_name: "#3445", staff_note: "call before delivery" })
  })

  it("is a no-op for a document with no linked Shopify order", async () => {
    // A manual or repair document has no order date to cache. Normal, not a failure.
    const ctx = makeCtx({ document: { id: "doc-1", shopify_order_id: null }, order: ORDER })
    expect(await warmPrepMetaForDocument(ctx, "doc-1")).toBe(false)
    expect(await metaRow(ctx)).toBeUndefined()
  })

  it("never throws when the reads fail: a cold cache must not fail a label buy", async () => {
    const ctx = makeCtx({ document: null, order: null })
    const boom = {
      ...ctx,
      executeTool: (async () => {
        throw new Error("shopify down")
      }) as unknown as BoxtalToolCtx["executeTool"],
    } as BoxtalToolCtx
    expect(await warmPrepMetaForDocument(boom, "doc-1")).toBe(false)
  })
})
