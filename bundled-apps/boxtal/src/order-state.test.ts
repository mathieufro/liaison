// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-ORDER prep state: the single status enum, the legacy-flag seeding that must survive the
// first write against a row created before the rework, and the re-keyed exclusion.

import { describe, expect, it } from "bun:test"
import {
  effectiveStatus,
  excludedOrderKeys,
  isExcluded,
  orderKeyForDocumentRef,
  parseOrderKey,
  prepExclude,
  prepRestore,
  prepSetStatus,
  prepSetValidated,
  upsertPrepOrderState,
} from "./order-state"
import { createMockDb } from "./test-db"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"

/** The default cross-app answer is a SUCCESSFUL `invoicing:documents_get` that reports no linked
 *  order: that is what invoicing really answers for an order-less document, and it is the only
 *  answer that licenses the `doc:<ref>` fallback. A test that wants the failure path says so. */
function makeCtx(
  seed: Record<string, Array<Record<string, unknown>>> = {},
  executeTool: (target: string, args: unknown) => Promise<CrossAppEnvelope> = async () => ({
    status: "completed",
    result: { id: "doc-9", shopify_order_id: null },
  }),
): {
  ctx: BoxtalToolCtx
  db: ReturnType<typeof createMockDb>
} {
  const db = createMockDb({ seed })
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
  }
}

function orderState(db: ReturnType<typeof createMockDb>, key: string) {
  return db.__all("prep_order_state").find((r) => r.order_key === key) as
    | Record<string, unknown>
    | undefined
}

describe("order_key parsing", () => {
  it("recognises the three row kinds and rejects anything else", () => {
    expect(parseOrderKey("so:5123")).toEqual({ kind: "order", id: "5123" })
    expect(parseOrderKey("doc:abc-def")).toEqual({ kind: "document", id: "abc-def" })
    expect(parseOrderKey("pending:tok1")).toEqual({ kind: "pending", id: "tok1" })
    expect(parseOrderKey("5123")).toBeNull()
    expect(parseOrderKey("so:")).toBeNull()
  })
})

describe("prep_set_status", () => {
  it("(a) creates the order-state row and stamps status_changed_at", async () => {
    const { ctx, db } = makeCtx()
    const row = await prepSetStatus(ctx, { order_key: "so:5123", status: "on_hold", note: "waiting on stock" })
    expect(row.status).toBe("on_hold")
    const stored = orderState(db, "so:5123")!
    expect(stored.status).toBe("on_hold")
    expect(stored.status_note).toBe("waiting on stock")
    expect(typeof stored.status_changed_at).toBe("string")
    expect(stored.shopify_order_id).toBe("5123")
  })

  it("(f) refuses an unknown status with invalid_status", async () => {
    const { ctx } = makeCtx()
    let thrown: unknown
    try {
      await prepSetStatus(ctx, { order_key: "so:5123", status: "shipped" as never })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string })?.code).toBe("invalid_status")
  })

  it("(g) a same-status rewrite does not bump status_changed_at", async () => {
    const { ctx, db } = makeCtx()
    await prepSetStatus(ctx, { order_key: "so:5123", status: "validated" })
    const first = orderState(db, "so:5123")!.status_changed_at as string
    await prepSetStatus(ctx, { order_key: "so:5123", status: "validated" })
    expect(orderState(db, "so:5123")!.status_changed_at).toBe(first)
    // A real status CHANGE does bump it (pinned against a stamp from the past, so the
    // assertion cannot be satisfied by two writes landing in the same millisecond).
    await ctx.db.update("prep_order_state", orderState(db, "so:5123")!.id as string, {
      status_changed_at: "2020-01-01T00:00:00.000Z",
    })
    await prepSetStatus(ctx, { order_key: "so:5123", status: "to_prepare" })
    expect(orderState(db, "so:5123")!.status_changed_at).not.toBe("2020-01-01T00:00:00.000Z")
    expect(first.length).toBeGreaterThan(0)
  })
})

describe("prep_set_validated alias", () => {
  it("(b) maps validated true/false onto the status enum", async () => {
    const { ctx, db } = makeCtx({
      prep_meta: [{ id: "m1", document_ref: "doc-1", shopify_order_id: "5123" }],
    })
    await prepSetValidated(ctx, { document_ref: "doc-1", validated: true })
    expect(orderState(db, "so:5123")!.status).toBe("validated")
    await prepSetValidated(ctx, { document_ref: "doc-1", validated: false })
    expect(orderState(db, "so:5123")!.status).toBe("to_prepare")
  })

  it("resolves an unlinked document to a doc: key", async () => {
    const { ctx, db } = makeCtx()
    await prepSetValidated(ctx, { document_ref: "doc-9", validated: true })
    expect(orderState(db, "doc:doc-9")!.status).toBe("validated")
    expect(await orderKeyForDocumentRef(ctx, "doc-9")).toBe("doc:doc-9")
  })
})

describe("prep_set_status by document_ref", () => {
  it("resolves the row from the invoice id, as the alias does", async () => {
    const { ctx, db } = makeCtx({
      prep_meta: [{ id: "m1", document_ref: "doc-1", shopify_order_id: "5123" }],
    })
    await prepSetStatus(ctx, { document_ref: "doc-1", status: "on_hold" })
    expect(orderState(db, "so:5123")!.status).toBe("on_hold")
  })

  it("an order_key and a document_ref naming different rows are refused, and nothing is written", async () => {
    const { ctx, db } = makeCtx({
      prep_meta: [{ id: "m1", document_ref: "doc-1", shopify_order_id: "5123" }],
    })
    await expect(
      prepSetStatus(ctx, { order_key: "so:777", document_ref: "doc-1", status: "validated" }),
    ).rejects.toMatchObject({ code: "order_key_mismatch", message: expect.stringContaining("so:5123") })
    expect(db.__all("prep_order_state")).toHaveLength(0)
  })

  it("an order_key and a document_ref naming the same row write it", async () => {
    const { ctx, db } = makeCtx({
      prep_meta: [{ id: "m1", document_ref: "doc-1", shopify_order_id: "5123" }],
    })
    await prepSetStatus(ctx, { order_key: "so:5123", document_ref: "doc-1", status: "validated" })
    expect(orderState(db, "so:5123")!.status).toBe("validated")
  })

  it("refuses a call with neither, and with an empty one, saying what to pass", async () => {
    const { ctx } = makeCtx()
    for (const input of [{}, { document_ref: "" }, { order_key: " " }]) {
      await expect(prepSetStatus(ctx, { ...input, status: "validated" })).rejects.toMatchObject({
        code: "invalid_order_key",
        message: expect.stringContaining("order_key"),
      })
    }
  })

  // The walk's case: `so:not-real` answered success and wrote that row into the worklist.
  it("refuses an order_key that names nothing, and writes no row", async () => {
    const answers: Record<string, CrossAppEnvelope> = {
      "shopify:orders_get": { status: "completed", result: null },
      "invoicing:documents_get": { status: "completed", result: null },
    }
    const refused: Array<[string, string]> = [
      ["so:not-real", "invalid_order_key"],
      ["bogus", "invalid_order_key"],
      ["pending:never-made", "invalid_order_key"],
      ["so:424242", "order_not_found"],
      ["doc:not-a-document", "document_not_found"],
    ]
    for (const [key, code] of refused) {
      const { ctx, db } = makeCtx({}, async (target) => answers[target]!)
      await expect(prepSetStatus(ctx, { order_key: key, status: "validated" })).rejects.toMatchObject({ code })
      await expect(prepExclude(ctx, { order_key: key })).rejects.toMatchObject({ code })
      await expect(prepSetValidated(ctx, { order_key: key, validated: true })).rejects.toMatchObject({ code })
      expect(db.__all("prep_order_state")).toHaveLength(0)
    }
  })

  it("a read that failed is not an answer: the order_key is refused as retryable", async () => {
    const { ctx, db } = makeCtx({}, async () => ({
      status: "error",
      error: { code: "throttled", message: "429", retryable: true },
    }))
    await expect(prepSetStatus(ctx, { order_key: "so:5123", status: "validated" })).rejects.toMatchObject({
      code: "order_key_unresolved",
      retryable: true,
    })
    expect(db.__all("prep_order_state")).toHaveLength(0)
  })

  it("a key that already has a row is its own proof: no read, so an old row can still be restored", async () => {
    let reads = 0
    const { ctx, db } = makeCtx({ prep_order_state: [{ id: "s1", order_key: "pending:tok", status: "to_prepare" }] }, async () => {
      reads++
      return { status: "completed", result: null }
    })
    await prepRestore(ctx, { order_key: "pending:tok" })
    expect(reads).toBe(0)
    expect(orderState(db, "pending:tok")!.excluded).toBe(false)
  })
})

describe("order_key resolution from a document_ref", () => {
  it("uses the LIVE documents_get answer when prep_meta has never been written", async () => {
    // The cached branch is the fast path; this one is the authoritative path the comment calls out,
    // and it takes both shapes invoicing can carry the order in.
    const gid = makeCtx({}, async () => ({
      status: "completed",
      result: { id: "doc-7", shopify_order_id: "gid://shopify/Order/8123" },
    }))
    expect(await orderKeyForDocumentRef(gid.ctx, "doc-7")).toBe("so:8123")
    const bare = makeCtx({}, async () => ({
      status: "completed",
      result: { id: "doc-7", shopify_order_id: "8123" },
    }))
    expect(await orderKeyForDocumentRef(bare.ctx, "doc-7")).toBe("so:8123")
  })

  it("refuses to guess when documents_get FAILS, so a row cannot fork a second identity", async () => {
    // Falling through to doc:<ref> on a failed read minted a SECOND row for an order-linked
    // invoice: the scan lists every doc: state row as an order-less row, so the grid grew a
    // duplicate while the real so: row kept its flags (an exclude appeared to do nothing).
    const failing = makeCtx({}, async () => ({
      status: "error",
      error: { code: "upstream", message: "invoicing is unreachable" },
    }))
    let thrown: unknown
    try {
      await orderKeyForDocumentRef(failing.ctx, "doc-7")
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string })?.code).toBe("order_key_unresolved")
    expect((thrown as { retryable?: boolean })?.retryable).toBe(true)
    expect(failing.db.__all("prep_order_state")).toHaveLength(0)

    const throwing = makeCtx({}, async () => {
      throw new Error("bridge timeout")
    })
    let thrown2: unknown
    try {
      await orderKeyForDocumentRef(throwing.ctx, "doc-7")
    } catch (e) {
      thrown2 = e
    }
    expect((thrown2 as { code?: string })?.code).toBe("order_key_unresolved")
  })

  it("refuses a reference that names no document, with a typed error and no row written", async () => {
    const missing = makeCtx({}, async () => ({ status: "completed", result: null }))
    let thrown: unknown
    try {
      await prepSetStatus(missing.ctx, { document_ref: "not-a-uuid", status: "validated" })
    } catch (e) {
      thrown = e
    }
    expect((thrown as { code?: string })?.code).toBe("document_not_found")
    expect((thrown as { retryable?: boolean })?.retryable).toBe(false)
    expect(missing.db.__all("prep_order_state")).toHaveLength(0)
  })

  it("keys an order-less document by its own id when the reference was its number", async () => {
    const byNumber = makeCtx({}, async () => ({
      status: "completed",
      result: { id: "doc-uuid-1", shopify_order_id: null },
    }))
    expect(await orderKeyForDocumentRef(byNumber.ctx, "INV-2026-0016")).toBe("doc:doc-uuid-1")
  })

  it("still prefers the cached prep_meta order over any live read", async () => {
    const { ctx } = makeCtx(
      { prep_meta: [{ id: "m1", document_ref: "doc-1", shopify_order_id: "5123" }] },
      async () => {
        throw new Error("must not be called")
      },
    )
    expect(await orderKeyForDocumentRef(ctx, "doc-1")).toBe("so:5123")
  })
})

describe("legacy flag read-through and first-write seeding", () => {
  it("(c) reads the legacy validated flag when no order-state row exists", () => {
    expect(effectiveStatus(undefined, { document_ref: "doc-1", validated: true })).toBe("validated")
    expect(effectiveStatus(undefined, { document_ref: "doc-1", validated: false })).toBe("to_prepare")
    // Once an order-state row exists it is authoritative, legacy is ignored.
    expect(effectiveStatus({ order_key: "so:1", status: "to_prepare" }, { document_ref: "doc-1", validated: true })).toBe(
      "to_prepare",
    )
  })

  it("(d) a FIRST write that is not about status keeps a legacy validated row validated", async () => {
    const { ctx, db } = makeCtx({
      prep_meta: [{ id: "m1", document_ref: "doc-1", shopify_order_id: "5123" }],
      prep_state: [{ id: "s1", document_ref: "doc-1", validated: true, excluded: false, category: "gift" }],
    })
    // The first write is a category change, nothing to do with validation.
    await upsertPrepOrderState(ctx, "so:5123", { category: "repair" })
    const stored = orderState(db, "so:5123")!
    expect(stored.status).toBe("validated")
    expect(stored.category).toBe("repair")
  })

  it("(e) a FIRST write seeds the legacy excluded flag the same way", async () => {
    const { ctx, db } = makeCtx({
      prep_meta: [{ id: "m1", document_ref: "doc-1", shopify_order_id: "5123" }],
      prep_state: [{ id: "s1", document_ref: "doc-1", excluded: true }],
    })
    await prepSetStatus(ctx, { order_key: "so:5123", status: "on_hold" })
    expect(orderState(db, "so:5123")!.excluded).toBe(true)
  })

  it("a first write with NO legacy rows at all lands on the schema defaults, explicitly", async () => {
    const { ctx, db } = makeCtx()
    await upsertPrepOrderState(ctx, "so:9001", { status_note: "waiting on the customer" })
    const stored = orderState(db, "so:9001")!
    expect(stored.category).toBe("sale")
    expect(stored.excluded).toBe(false)
    expect(stored.status).toBe("to_prepare")
    expect(stored.shopify_order_id).toBe("9001")
  })

  it("converges instead of failing when two FIRST writes race the same row", async () => {
    const { ctx, db } = makeCtx()
    // The bridge has no upsert, so this is a read-then-insert against UNIQUE(order_key): the loser
    // of the race must apply its patch as an update, not hand the operator a raw pg error.
    const realInsert = db.insert.bind(db)
    let first = true
    ;(db as unknown as { insert: typeof db.insert }).insert = async (entity, data) => {
      if (entity === "prep_order_state" && first) {
        first = false
        // The concurrent writer committed its row a moment ago.
        await realInsert(entity, { order_key: "so:9002", status: "to_prepare", category: "sale", excluded: false })
        throw new Error('pg: duplicate key value violates unique constraint "prep_order_state_org_id_order_key_key" (23505)')
      }
      return realInsert(entity, data)
    }
    const row = await upsertPrepOrderState(ctx, "so:9002", { status: "on_hold" })
    expect(row.status).toBe("on_hold")
    expect(db.__all("prep_order_state").filter((r) => r.order_key === "so:9002")).toHaveLength(1)
    expect(orderState(db, "so:9002")!.status).toBe("on_hold")
  })

  it("isExcluded prefers the order-state row over the legacy flag", () => {
    expect(isExcluded(undefined, { document_ref: "d", excluded: true })).toBe(true)
    expect(isExcluded({ order_key: "so:1", excluded: false }, { document_ref: "d", excluded: true })).toBe(false)
  })
})

describe("exclusion by order_key", () => {
  it("excludes and restores a row that has no document at all", async () => {
    const { ctx, db } = makeCtx()
    await prepExclude(ctx, { order_key: "so:7001" })
    expect(orderState(db, "so:7001")!.excluded).toBe(true)
    expect(await excludedOrderKeys(ctx)).toEqual(new Set(["so:7001"]))
    await prepRestore(ctx, { order_key: "so:7001" })
    expect(await excludedOrderKeys(ctx)).toEqual(new Set())
  })

  it("reads legacy per-document exclusions through as order keys", async () => {
    const { ctx } = makeCtx({
      prep_meta: [{ id: "m1", document_ref: "doc-1", shopify_order_id: "5123" }],
      prep_state: [{ id: "s1", document_ref: "doc-1", excluded: true }],
    })
    expect(await excludedOrderKeys(ctx)).toEqual(new Set(["so:5123"]))
  })

  it("a restore of a legacy-excluded row wins over the legacy flag", async () => {
    const { ctx } = makeCtx({
      prep_meta: [{ id: "m1", document_ref: "doc-1", shopify_order_id: "5123" }],
      prep_state: [{ id: "s1", document_ref: "doc-1", excluded: true }],
    })
    await prepRestore(ctx, { order_key: "so:5123" })
    expect(await excludedOrderKeys(ctx)).toEqual(new Set())
  })
})
