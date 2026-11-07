// SPDX-License-Identifier: FSL-1.1-ALv2
//
// prep_set_note: the grid's inline edit of the Shopify order's staff note, saved through the
// Shopify app's ungated internal order_note_set with a compare-and-set on the note last shown.

import { describe, expect, it } from "bun:test"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import { prepSetNote } from "./staff-note"
import { createMockDb } from "./test-db"

function makeCtx(
  answer: (target: string, args: Record<string, unknown>) => CrossAppEnvelope,
  seed: Record<string, Array<Record<string, unknown>>> = {},
) {
  const db = createMockDb({ seed })
  const calls: Array<{ target: string; args: Record<string, unknown> }> = []
  const ctx = {
    orgId: "org-1",
    db,
    fetch: (async () => ({ status: 200, headers: {}, body: "{}" })) as never,
    connections: {},
    config: { get: async () => null, has: async () => false },
    executeTool: async (target: string, rawArgs: string | Record<string, unknown>) => {
      const args = typeof rawArgs === "string" ? {} : rawArgs
      calls.push({ target, args })
      return answer(target, args)
    },
  } as unknown as BoxtalToolCtx
  return { ctx, db, calls }
}

const SAVED = (note: string | null): CrossAppEnvelope => ({
  status: "completed",
  result: { ok: true, order_id: "gid://shopify/Order/5001", note, previous_note: null },
})

describe("prep_set_note", () => {
  it("writes through shopify:order_note_set with the order gid and the compare-and-set guard", async () => {
    const { ctx, calls } = makeCtx(() => SAVED("Ship Friday"))
    const res = await prepSetNote(ctx, { order_key: "so:5001", note: " Ship Friday ", expected_note: null })
    expect(res).toEqual({ ok: true, order_key: "so:5001", note: "Ship Friday" })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.target).toBe("shopify:order_note_set")
    expect(calls[0]!.args).toEqual({ order_id: "gid://shopify/Order/5001", note: "Ship Friday", expected_note: null })
  })

  it("omits expected_note when the caller did not pass one (unconditional overwrite)", async () => {
    const { ctx, calls } = makeCtx(() => SAVED(null))
    await prepSetNote(ctx, { order_key: "so:5001", note: "" })
    expect(calls[0]!.args).toEqual({ order_id: "gid://shopify/Order/5001", note: null })
  })

  it("surfaces a conflict with Shopify's current note instead of reporting a save", async () => {
    const { ctx, db } = makeCtx(
      () => ({
        status: "completed",
        result: { ok: false, reason: "conflict", order_id: "gid://shopify/Order/5001", current_note: "Changed in admin" },
      }),
      { prep_meta: [{ id: "m1", document_ref: "inv-1", shopify_order_id: "5001", staff_note: "old" }] },
    )
    const res = await prepSetNote(ctx, { order_key: "so:5001", note: "mine", expected_note: "old" })
    expect(res).toEqual({ ok: false, reason: "conflict", order_key: "so:5001", current_note: "Changed in admin" })
    // The cache is not touched by a refused write.
    expect(db.__all("prep_meta")[0]!.staff_note).toBe("old")
  })

  it("updates the cached order facts so an offline read shows the saved note", async () => {
    const { ctx, db } = makeCtx(() => SAVED("Gift wrap"), {
      prep_meta: [
        { id: "m1", document_ref: "inv-1", shopify_order_id: "5001", staff_note: null },
        { id: "m2", document_ref: "inv-9", shopify_order_id: "5009", staff_note: "other order" },
      ],
    })
    await prepSetNote(ctx, { order_key: "so:5001", note: "Gift wrap" })
    const metas = db.__all("prep_meta")
    expect(metas.find((m) => m.id === "m1")!.staff_note).toBe("Gift wrap")
    expect(metas.find((m) => m.id === "m2")!.staff_note).toBe("other order")
  })

  it("refuses an order-less row and a malformed key without calling Shopify", async () => {
    const { ctx, calls } = makeCtx(() => SAVED(null))
    await expect(prepSetNote(ctx, { order_key: "doc:inv-1", note: "x" })).rejects.toThrow(/order-less/)
    await expect(prepSetNote(ctx, { order_key: "nope", note: "x" })).rejects.toThrow(/not a prep row key/)
    expect(calls).toHaveLength(0)
  })

  it("never reports a parked or failed write as saved", async () => {
    const parked = makeCtx(() => ({ status: "pending_approval", approval_id: "ap-1" }))
    await expect(prepSetNote(parked.ctx, { order_key: "so:5001", note: "x" })).rejects.toThrow(/not saved/)
    const failed = makeCtx(() => ({ status: "error", error: { code: "upstream", message: "boom" } }))
    await expect(prepSetNote(failed.ctx, { order_key: "so:5001", note: "x" })).rejects.toThrow(/boom/)
  })
})
