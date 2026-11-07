// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { exceptionsList, queueCounts, readyList, returnsList, shipmentHasLabel, stuckList, toPrepareList } from "./queues"
import { readySetPacked } from "./packed"
import { buildOfferWithInsurance } from "./shipment"
import type { Offer } from "./lib/boxtal-v1-client"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import { createMockDb } from "./test-db"
import { makeOrderScanStub, type OrderScanStubOptions } from "./__fixtures__/order-scan"

function baseOffer(): Offer {
  return {
    offer_code: "CHRP-Chrono13",
    carrier: "Chronopost",
    carrier_code: "CHRP",
    service: "Chrono 13",
    service_code: "Chrono13",
    price_ht: 10,
    price_ttc: 12,
    currency: "EUR",
    collection_date: null,
    delivery_date: null,
    insurance_ht: 4.5,
    needs_relay_point: false,
    collection_type: null,
    pickup_at_sender: null,
  }
}

// A ctx whose `executeTool` is routed by target → canned K4 envelope. `db` is the
// real MockDb so the reads exercise actual where/filter logic.
function makeCtx(opts: {
  seed?: Record<string, Array<Record<string, unknown>>>
  invoices?: Array<{ id: string; number?: string; channel?: string; counterparty_name?: string; counterparty_country?: string }>
  // A SINGLE doc (all candidates resolve to it — the common single-invoice test), OR a list of distinct
  // docs routed by `id` (a MULTI-invoice worklist test, where documents_get must return the matching doc).
  docs?: Record<string, unknown> | Array<{ id: string; [k: string]: unknown }>
  /** Order-scan fixture knobs (extra document-less orders, refunded orders, failures). */
  scan?: OrderScanStubOptions
}): BoxtalToolCtx {
  const db = createMockDb({ seed: opts.seed ?? {} })
  // The worklist is ORDER-driven now: one synthetic open order per invoice fixture, joined back to
  // it through documents_for_orders, so a test still expresses itself as "these invoices exist".
  const scanStub = makeOrderScanStub(opts.invoices ?? [], opts.scan ?? {})
  const executeTool = async (target: string, args?: Record<string, unknown>): Promise<CrossAppEnvelope> => {
    const scanned = scanStub(target, args)
    if (scanned) return scanned
    if (target === "invoicing:documents_search") {
      // Fixture invoices stand in for Shopify-generated goods invoices (the only
      // kind the worklist covers); a test can override channel to assert exclusion.
      return { status: "completed", result: (opts.invoices ?? []).map((d) => ({ channel: "shopify", ...d })) }
    }
    if (target === "invoicing:documents_get") {
      // toPrepareList calls documents_get per candidate via shipmentDraftCreate. The id is passed in
      // args; when `docs` is a LIST, return the doc whose id matches (per-candidate distinct docs) — else
      // (single object) return it for every candidate (the common single-invoice case).
      if (Array.isArray(opts.docs)) {
        const id = args?.id
        const match = opts.docs.find((d) => d.id === id) ?? null
        return { status: "completed", result: match }
      }
      return { status: "completed", result: opts.docs ?? null }
    }
    return { status: "error", error: { code: "unmocked", message: target } }
  }
  return {
    orgId: "org_1",
    db,
    fetch: (async () => new Response("")) as unknown as BoxtalToolCtx["fetch"],
    connections: {},
    config: { get: async () => null, has: async () => false },
    executeTool: executeTool as BoxtalToolCtx["executeTool"],
  }
}

describe("readyList", () => {
  it("returns PENDING and CONFIRMED non-return shipments, with has_label derived from documents", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "s1", order_status: "CONFIRMED", recipient_summary: "Globex", offer_code: "CHRP-Chrono13", tracking_number: "T1", declared_total: 899, label_cost_ttc: 25, document_ref: "inv-1", documents: [{ type: "LABEL", format: "PDF_A4" }] },
          // A freshly bought label sits at PENDING until Boxtal confirms; the print
          // station must still see it (regression: the day's labels were invisible).
          { id: "s2", order_status: "PENDING", recipient_summary: "Acme", document_ref: "inv-2", documents: [{ type: "LABEL", format: "PDF_A4" }] },
          { id: "s3", order_status: "CONFIRMED", recipient_summary: "Returned Co", kind: "return", document_ref: "pro-1" },
          { id: "s4", order_status: "CONFIRMED", recipient_summary: "NoLabel", document_ref: "inv-4", documents: [] },
          { id: "s5", order_status: "CANCELLED", recipient_summary: "Void Co", document_ref: "inv-5" },
        ],
      },
    })
    const { rows } = await readyList(ctx)
    expect(rows.map((r) => r.id).sort()).toEqual(["s1", "s2", "s4"]) // return + CANCELLED excluded
    const s1 = rows.find((r) => r.id === "s1")!
    expect(s1).toMatchObject({ recipient: "Globex", carrier: "CHRP-Chrono13", tracking_number: "T1", cost: 25, has_label: true, invoice_ref: "inv-1" })
    expect(rows.find((r) => r.id === "s2")!.has_label).toBe(true)
    expect(rows.find((r) => r.id === "s4")!.has_label).toBe(false)
  })

  // Prod, 2026-07-31: the Ready-to-ship queue only ever grew. It filtered on
  // `order_status` (Boxtal's ORDER lifecycle, which never advances past
  // CONFIRMED) and ignored `tracking_status` entirely, so a parcel the carrier
  // had collected — or already DELIVERED — stayed in the print station's queue
  // forever. 19 of 23 live shipments were in that state.
  it("drops shipments the carrier has already taken, keeping only warehouse-side ones", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          // Still on the bench: no carrier event at all.
          { id: "w1", order_status: "PENDING", recipient_summary: "Not announced", document_ref: "inv-1" },
          // Announced to the carrier but NOT yet collected — still the operator's work.
          { id: "w2", order_status: "CONFIRMED", tracking_status: "ANNOUNCED", recipient_summary: "Awaiting pickup", document_ref: "inv-2" },
          // Everything below has left the building.
          { id: "g1", order_status: "CONFIRMED", tracking_status: "IN_TRANSIT", recipient_summary: "Moving", document_ref: "inv-3" },
          { id: "g2", order_status: "CONFIRMED", tracking_status: "OUT_FOR_DELIVERY", recipient_summary: "Last mile", document_ref: "inv-4" },
          { id: "g3", order_status: "CONFIRMED", tracking_status: "DELIVERED", recipient_summary: "Delivered", document_ref: "inv-5" },
          { id: "g4", order_status: "CONFIRMED", tracking_status: "EXCEPTION", recipient_summary: "Customs hold", document_ref: "inv-6" },
          { id: "g5", order_status: "CONFIRMED", tracking_status: "RETURNED", recipient_summary: "Back to sender", document_ref: "inv-7" },
          // A PENDING order can be delivered too: order_status simply never moved.
          // This is the "already delivered but still shows pending" report.
          { id: "g6", order_status: "PENDING", tracking_status: "DELIVERED", recipient_summary: "Pending yet delivered", document_ref: "inv-8" },
        ],
      },
    })
    const { rows } = await readyList(ctx)
    expect(rows.map((r) => r.id).sort()).toEqual(["w1", "w2"])
  })

  it("orders the products column by the org's display rank, and keeps the stored order without one", async () => {
    const shipment = [
      { id: "r1", order_status: "CONFIRMED", recipient_summary: "A", document_ref: "inv-1", queue_facts: { products: "1xMP, 1xBSkin, 1xSOUND, 1xET2" } },
      { id: "r2", order_status: "CONFIRMED", recipient_summary: "B", document_ref: "inv-2", queue_facts: { products: "1xSOUND, 1xET2, 1xBSkin, 1xMP" } },
    ]
    const ranked = makeCtx({
      seed: {
        shipment,
        app_config: [{ id: "pc", key: "product_code_aliases", value: { aliases: {}, ranks: { ET2: 1, MP: 2, SOUND: 1000 } } }],
      },
    })
    const { rows } = await readyList(ranked)
    expect(rows.map((r) => r.products)).toEqual(["1xET2, 1xMP, 1xBSkin, 1xSOUND", "1xET2, 1xMP, 1xBSkin, 1xSOUND"])
    const plain = await readyList(makeCtx({ seed: { shipment } }))
    expect(plain.rows.map((r) => r.products)).toEqual(["1xMP, 1xBSkin, 1xSOUND, 1xET2", "1xSOUND, 1xET2, 1xBSkin, 1xMP"])
  })

  it("treats an unmodelled carrier status as handed over, not as warehouse work", async () => {
    // Fail-safe direction: a carrier only reports once it holds the parcel, so an
    // unknown status must not silently re-fill the queue we just fixed.
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "u1", order_status: "CONFIRMED", tracking_status: "SOME_NEW_CARRIER_STATE", recipient_summary: "Unknown", document_ref: "inv-9" },
          { id: "u2", order_status: "CONFIRMED", tracking_status: null, recipient_summary: "Null", document_ref: "inv-10" },
          { id: "u3", order_status: "CONFIRMED", tracking_status: "", recipient_summary: "Empty", document_ref: "inv-11" },
        ],
      },
    })
    const { rows } = await readyList(ctx)
    expect(rows.map((r) => r.id).sort()).toEqual(["u2", "u3"])
  })

  // ticket-10505: a parcel put on hold must look held on every screen, not just the one where the
  // hold was set. The status travels from the ORDER state to the shipment row through its document.
  it("carries the operator status so the whole row can be tinted", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "held", order_status: "CONFIRMED", document_ref: "inv-held", recipient_summary: "Held Co" },
          { id: "plain", order_status: "CONFIRMED", document_ref: "inv-plain", recipient_summary: "Plain Co" },
        ],
        prep_meta: [
          { id: "m1", document_ref: "inv-held", shopify_order_id: "5551" },
          { id: "m2", document_ref: "inv-plain", shopify_order_id: "5552" },
        ],
        prep_order_state: [{ id: "st1", order_key: "so:5551", status: "on_hold" }],
      },
    })
    const { rows } = await readyList(ctx)
    expect(rows.find((r) => r.id === "held")!.status).toBe("on_hold")
    expect(rows.find((r) => r.id === "plain")!.status).toBeNull()
  })

  // Prod, 2026-09-14: a FedEx domestic parcel had its label (and a tracking number PRINTED on
  // that label) while Boxtal's tracking endpoint still returned nothing for it, so the queue
  // showed an empty Tracking cell and the operator read it as a broken sync. The row carries
  // Boxtal's own shipment reference instead, which exists as soon as the label does.
  it("surfaces Boxtal's shipment reference so a row is never unmatchable", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "s1", order_status: "CONFIRMED", recipient_summary: "No carrier number yet", document_ref: "inv-1", boxtal_shipment_ref: "2609141542FEDX1CS3FR" },
          { id: "s2", order_status: "CONFIRMED", recipient_summary: "Tracked", document_ref: "inv-2", tracking_number: "877164440733", boxtal_shipment_ref: "2609141542FEDX1CS0US" },
        ],
      },
    })
    const { rows } = await readyList(ctx)
    const s1 = rows.find((r) => r.id === "s1")!
    expect(s1.tracking_number).toBeNull()
    expect(s1.shipment_ref).toBe("2609141542FEDX1CS3FR")
    // An internal numeric id is NOT a reference anyone can look up: it reads as a tracking
    // number beside one and sends the operator hunting for a parcel that code cannot find.
    const internal = await readyList(
      makeCtx({ seed: { shipment: [{ id: "n1", order_status: "CONFIRMED", document_ref: "inv-9", boxtal_shipment_ref: "24315896" }] } }),
    )
    expect(internal.rows[0]!.shipment_ref).toBeNull()
    // The two references coexist: the reference never replaces a real carrier number.
    const s2 = rows.find((r) => r.id === "s2")!
    expect(s2.tracking_number).toBe("877164440733")
    expect(s2.shipment_ref).toBe("2609141542FEDX1CS0US")
  })

  // Prod, 2026-09-14: Quinn's Ready-to-ship queue lost rows. The filter allow-listed PENDING and
  // CONFIRMED, but Boxtal's order lifecycle is PENDING -> REQUESTED -> CONFIRMED, and a REQUESTED
  // shipment is ALSO subtracted from the To-prepare worklist (it is a live shipment), so those
  // orders sat in NEITHER queue. Five real orders were invisible.
  it("keeps REQUESTED shipments: every live order state is the print station's work", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "r1", order_status: "REQUESTED", recipient_summary: "Irsi Leka", document_ref: "inv-1" },
          { id: "r2", order_status: "PENDING", recipient_summary: "Fresh label", document_ref: "inv-2" },
          { id: "r3", order_status: "CONFIRMED", recipient_summary: "Confirmed", document_ref: "inv-3" },
          { id: "r4", order_status: "CANCELLED", recipient_summary: "Void", document_ref: "inv-4" },
        ],
      },
    })
    const { rows } = await readyList(ctx)
    expect(rows.map((r) => r.id).sort()).toEqual(["r1", "r2", "r3"])
    // And the badge cannot disagree with the list it badges.
    expect((await queueCounts(ctx)).ready).toBe(3)
  })

  // The print station works the queue top-down, so the row order IS the packing order: the
  // operator (Quinn) lost track when it came back in shipment-id order, which is label-purchase
  // order, not order order.
  it("sorts by REQUEST date, oldest first, with unknown dates last", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "s1", order_status: "CONFIRMED", recipient_summary: "Newest", document_ref: "inv-new", created_at: "2026-09-14 13:42:43.000000+00" },
          { id: "s2", order_status: "CONFIRMED", recipient_summary: "Oldest", document_ref: "inv-old", created_at: "2026-09-12 09:15:00.000000+00" },
          { id: "s3", order_status: "CONFIRMED", recipient_summary: "Middle", document_ref: "inv-mid", created_at: "2026-09-14 13:42:39.000000+00" },
          { id: "s4", order_status: "CONFIRMED", recipient_summary: "No date", document_ref: "inv-none" },
        ],
        prep_meta: [
          { id: "m1", document_ref: "inv-new", order_created_at: "2026-09-10T08:00:00.000Z" },
          { id: "m2", document_ref: "inv-old", order_created_at: "2026-08-21T08:00:00.000Z" },
        ],
      },
    })
    const { rows } = await readyList(ctx)
    // Same-day rows are separated by the TIME, not just the day (s3 13:42:39 before s1 13:42:43).
    expect(rows.map((r) => r.id)).toEqual(["s2", "s3", "s1", "s4"])
    expect(rows.map((r) => r.requested_at)).toEqual([
      "2026-09-12 09:15:00.000000+00",
      "2026-09-14 13:42:39.000000+00",
      "2026-09-14 13:42:43.000000+00",
      null,
    ])
    // The order date is still carried for the column beside it, sync-cache permitting.
    expect(rows.find((r) => r.id === "s2")!.order_created_at).toBe("2026-08-21T08:00:00.000Z")
    expect(rows.find((r) => r.id === "s4")!.order_created_at).toBeNull()
  })

  // Shipment ids are random UUIDs, and every queue read used to be `orderBy id desc, limit 100`: an
  // arbitrary sample of the table, not the latest 100. Past 100 shipments a bought label could be
  // absent from Ready to ship with nothing on screen saying so.
  it("lists every live label past 100 shipments, whatever the ids sort to", async () => {
    const history = Array.from({ length: 150 }, (_, i) => ({
      // ids that sort ABOVE the live ones, so an id-desc window of 100 holds only history
      id: `zz-${String(i).padStart(4, "0")}`,
      order_status: "CONFIRMED",
      tracking_status: "DELIVERED",
      document_ref: `inv-old-${i}`,
      created_at: `2026-08-01 10:${String(i % 60).padStart(2, "0")}:00+00`,
    }))
    const live = [
      { id: "aa-1", order_status: "CONFIRMED", tracking_status: null, document_ref: "inv-a", created_at: "2026-10-01 09:00:00+00" },
      { id: "aa-2", order_status: "PENDING", document_ref: "inv-b", created_at: "2026-10-01 08:00:00+00" },
      { id: "aa-3", order_status: "CONFIRMED", tracking_status: "ANNOUNCED", document_ref: "inv-c", created_at: "2026-10-01 10:00:00+00" },
    ]
    const stuck = [
      { id: "ab-1", order_status: "CONFIRMED", tracking_status: "EXCEPTION", document_ref: "inv-x" },
      { id: "ab-2", order_status: "CONFIRMED", tracking_status: "FAILED_ATTEMPT", document_ref: "inv-y" },
    ]
    const ctx = makeCtx({ seed: { shipment: [...history, ...live, ...stuck] } })
    const { rows } = await readyList(ctx)
    expect(rows.map((r) => r.id)).toEqual(["aa-2", "aa-1", "aa-3"])
    expect((await exceptionsList(ctx)).rows.map((r) => r.id)).toEqual(["ab-1"])
    expect((await stuckList(ctx)).rows.map((r) => r.id).sort()).toEqual(["ab-1", "ab-2"])
  })

  it("queue_counts.ready agrees with the list it badges", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "a", order_status: "CONFIRMED", document_ref: "inv-1" },
          { id: "b", order_status: "CONFIRMED", tracking_status: "DELIVERED", document_ref: "inv-2" },
        ],
      },
      invoices: [],
    })
    const counts = await queueCounts(ctx)
    const { rows } = await readyList(ctx)
    expect(counts.ready).toBe(rows.length)
    expect(counts.ready).toBe(1)
  })
})

describe("every queue speaks the same row shape", () => {
  // Ready-to-ship, Returns and the stuck queues each used to expose a different subset, so the
  // same parcel read differently depending on which list you stood in: after the label was bought
  // the cartons, the weight and the category (sale vs repair) simply vanished from view.
  const FACTS = {
    customer: "Irsi Leka",
    destination: "US",
    items: 2,
    weight: 10.5,
    parcels: [{ length: 30, width: 20, height: 10, weight: 2.5 }],
    package_count: 1,
    category: "repair",
    order_name: "#3438",
    order_created_at: "2026-09-09T02:58:42.000Z",
    staff_note: "fragile",
  }

  function ctxWith(extra: Record<string, unknown>) {
    return makeCtx({
      seed: {
        shipment: [
          { id: "s1", order_status: "CONFIRMED", recipient_summary: "Irsi Leka", document_ref: "inv-1", queue_facts: FACTS, ...extra },
        ],
      },
    })
  }

  it("ready_list carries the buy-time snapshot", async () => {
    const { rows } = await readyList(ctxWith({}))
    expect(rows[0]).toMatchObject({ items: 2, weight: 10.5, package_count: 1, category: "repair", order_name: "#3438", staff_note: "fragile" })
  })

  it("returns_list carries it too", async () => {
    const { rows } = await returnsList(ctxWith({ kind: "return" }))
    expect(rows[0]).toMatchObject({ items: 2, weight: 10.5, category: "repair", order_name: "#3438" })
  })

  it("exceptions_list and stuck_list carry it too", async () => {
    const ctx = ctxWith({ tracking_status: "EXCEPTION" })
    expect((await exceptionsList(ctx)).rows[0]).toMatchObject({ items: 2, category: "repair" })
    expect((await stuckList(ctx)).rows[0]).toMatchObject({ items: 2, category: "repair" })
  })

  it("a row bought before the snapshot existed reads as dashes, not as an error", async () => {
    const ctx = makeCtx({
      seed: { shipment: [{ id: "old", order_status: "CONFIRMED", recipient_summary: "Legacy", document_ref: "inv-old" }] },
    })
    const row = (await readyList(ctx)).rows[0]!
    expect(row.items).toBeNull()
    expect(row.weight).toBeNull()
    expect(row.category).toBeNull()
    expect(row.parcels).toEqual([])
  })

  it("the row's own fields win where the names meet", async () => {
    // returns_list defines `customer` itself; the snapshot must not overwrite it.
    const { rows } = await returnsList(ctxWith({ kind: "return", recipient_summary: "Live Name" }))
    expect(rows[0]!.customer).toBe("Live Name")
  })
})

// ticket-10507 / ticket-10522: the packer marks which parcels are already boxed and waiting for
// the carrier, so the rows still to do are distinguishable from the ones that are done. The mark
// lives on the SHIPMENT row as a timestamp, ships nothing, and is reversible.
describe("ready_set_packed: the warehouse bench mark", () => {
  // Shipment row ids are UUIDs (findShipmentByRef only asks the id column for a UUID-shaped reference).
  const S1_ID = "11111111-1111-4111-8111-111111111111"
  const S2_ID = "22222222-2222-4222-8222-222222222222"
  function packedCtx() {
    return makeCtx({
      seed: {
        shipment: [
          { id: S1_ID, order_status: "CONFIRMED", recipient_summary: "Globex", document_ref: "inv-1", boxtal_order_id: "BX-777" },
          { id: S2_ID, order_status: "CONFIRMED", recipient_summary: "Acme", document_ref: "inv-2" },
        ],
      },
    })
  }

  it("sets the mark: stamps packed_at on that row only", async () => {
    const ctx = packedCtx()
    const before = Date.now()
    const res = await readySetPacked(ctx, { shipment_id: S1_ID, packed: true })
    expect(res.error).toBeUndefined()
    expect(res.shipment_id).toBe(S1_ID)
    expect(res.packed).toBe(true)
    expect(typeof res.packed_at).toBe("string")
    expect(new Date(res.packed_at as string).getTime()).toBeGreaterThanOrEqual(before - 1000)
    const stored = (await ctx.db.findMany("shipment", { where: { id: S1_ID }, limit: 1 })) as Array<{ packed_at?: string | null }>
    expect(stored[0]!.packed_at).toBe(res.packed_at)
    // The sibling row is untouched: the mark is per parcel.
    const other = (await ctx.db.findMany("shipment", { where: { id: S2_ID }, limit: 1 })) as Array<{ packed_at?: string | null }>
    expect(other[0]!.packed_at ?? null).toBeNull()
  })

  it("clears the mark: un-ticking sets packed_at back to null", async () => {
    const ctx = packedCtx()
    await readySetPacked(ctx, { shipment_id: S1_ID, packed: true })
    const res = await readySetPacked(ctx, { shipment_id: S1_ID, packed: false })
    expect(res.error).toBeUndefined()
    expect(res.packed).toBe(false)
    expect(res.packed_at).toBeNull()
    const stored = (await ctx.db.findMany("shipment", { where: { id: S1_ID }, limit: 1 })) as Array<{ packed_at?: string | null }>
    expect(stored[0]!.packed_at).toBeNull()
  })

  it("resolves a row by boxtal_order_id the way print_pack does", async () => {
    const ctx = packedCtx()
    const res = await readySetPacked(ctx, { shipment_id: "BX-777", packed: true })
    expect(res.error).toBeUndefined()
    // Answers with the LOCAL row id, whichever reference came in.
    expect(res.shipment_id).toBe(S1_ID)
    expect(res.packed).toBe(true)
  })

  it("returns a clean not_found error for an unknown reference, and writes nothing", async () => {
    const ctx = packedCtx()
    const res = await readySetPacked(ctx, { shipment_id: "nope", packed: true })
    expect(res.error?.code).toBe("not_found")
    expect(res.packed).toBe(false)
    expect(res.packed_at).toBeNull()
    const all = (await ctx.db.findMany("shipment", {})) as Array<{ packed_at?: string | null }>
    expect(all.every((r) => (r.packed_at ?? null) === null)).toBe(true)
  })

  it("ready_list reports the flag back on the row it was set on", async () => {
    const ctx = packedCtx()
    const fresh = await readyList(ctx)
    expect(fresh.rows.every((r) => r.packed === false)).toBe(true)
    expect(fresh.rows.every((r) => r.packed_at === null)).toBe(true)
    const set = await readySetPacked(ctx, { shipment_id: S1_ID, packed: true })
    const after = await readyList(ctx)
    const s1 = after.rows.find((r) => r.id === S1_ID)!
    expect(s1.packed).toBe(true)
    expect(s1.packed_at).toBe(set.packed_at)
    expect(after.rows.find((r) => r.id === S2_ID)!.packed).toBe(false)
    // The mark must not reorder the queue: the print station works it top down.
    expect(after.rows.map((r) => r.id)).toEqual(fresh.rows.map((r) => r.id))
  })
})

describe("shipmentHasLabel: one definition of \"the label is ready\"", () => {
  it("is true only when the shipment carries a LABEL document", () => {
    expect(shipmentHasLabel({ documents: [{ type: "LABEL" }] })).toBe(true)
    expect(shipmentHasLabel({ documents: [{ type: "LABEL" }, { type: "CN23" }] })).toBe(true)
  })

  it("is false for a shipment with no documents, or with documents that are not the label", () => {
    // Boxtal generates the label asynchronously, so a CONFIRMED order proves nothing about it.
    expect(shipmentHasLabel({ documents: [] })).toBe(false)
    expect(shipmentHasLabel({ documents: null })).toBe(false)
    expect(shipmentHasLabel({})).toBe(false)
    expect(shipmentHasLabel({ documents: [{ type: "CN23" }, { type: "PROFORMA" }] })).toBe(false)
  })
})

describe("returnsList", () => {
  it("returns only kind=return rows, maps created_by + label_ready", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "r1", kind: "return", recipient_summary: "Globex", return_reason: "Defective", document_ref: "pro-220", order_status: "CONFIRMED", tracking_status: "IN_TRANSIT", created_by: "agent", documents: [{ type: "LABEL", format: "PDF_A4" }] },
          { id: "r2", kind: "return", recipient_summary: "Stark", return_reason: "Wrong item", document_ref: "pro-221", order_status: "PENDING", created_by: "user" },
          { id: "r3", kind: "return", recipient_summary: "Cancelled", order_status: "CANCELLED" },
          { id: "o1", order_status: "CONFIRMED", recipient_summary: "Outbound" }, // not a return
        ],
      },
    })
    const { rows } = await returnsList(ctx)
    expect(rows.map((r) => r.id).sort()).toEqual(["r1", "r2"]) // cancelled + outbound excluded
    expect(rows.find((r) => r.id === "r1")).toMatchObject({ customer: "Globex", reason: "Defective", proforma_ref: "pro-220", created_by: "agent", label_ready: true })
    expect(rows.find((r) => r.id === "r2")).toMatchObject({ created_by: "user", label_ready: false })
  })

  it("names each return's proforma by its NUMBER, never its raw id", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "r1", kind: "return", recipient_summary: "Globex", document_ref: "pro-220", order_status: "CONFIRMED" },
          { id: "r2", kind: "return", recipient_summary: "Stark", document_ref: "pro-unknown", order_status: "PENDING" },
        ],
      },
      invoices: [{ id: "pro-220", number: "PRO-2026-0007" }],
    })
    const { rows } = await returnsList(ctx)
    expect(rows.find((r) => r.id === "r1")).toMatchObject({ proforma_ref: "pro-220", proforma_number: "PRO-2026-0007" })
    // Unresolvable: no number, and the UI shows a neutral label rather than the id.
    expect(rows.find((r) => r.id === "r2")?.proforma_number).toBeNull()
  })

  // ONE definition of "label ready" across the print queue, the returns list and the prep grid:
  // a LABEL document exists. CONFIRMED is Boxtal's ORDER lifecycle and says nothing about whether
  // the label PDF has been generated, so it used to light up a Label button with nothing behind it.
  it("label_ready is false for a CONFIRMED return that has no LABEL document yet", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "r9", kind: "return", recipient_summary: "Waiting", order_status: "CONFIRMED", documents: [] },
        ],
      },
    })
    const { rows } = await returnsList(ctx)
    expect(rows[0]!.label_ready).toBe(false)
  })
})

// toPrepareList exercises the shipmentDraftCreate resolver per candidate. We seed
// the catalog + app_config sender and route documents_get through the stub.
const SENDER_CONFIG = { id: "cfg1", key: "sender_address", value: JSON.stringify({ name: "Fabrikam", phone: "+33100000000", street: "1 rue", city: "Paris", postalCode: "75001", countryIsoCode: "FR" }) }

function invoiceDoc(over: Partial<{ id: string; counterparty_country: string; counterparty_name: string; lines: unknown[]; requires_hs_code: boolean | null }> = {}) {
  return {
    id: over.id ?? "inv-x",
    currency: "EUR",
    incoterm: "DAP",
    counterparty_country: over.counterparty_country ?? "US",
    counterparty_name: over.counterparty_name ?? "Globex US",
    requires_hs_code: over.requires_hs_code === undefined ? true : over.requires_hs_code,
    lines: over.lines ?? [
      { id: "l1", description: "Kestrel 2", quantity: 1, unit_price_minor: "59900", hs_code: "92071000", country_of_origin: "FR", customs_description: "Controller", product_source: "shopify", external_id: "V1" },
    ],
  }
}

describe("toPrepareList", () => {
  it("covers ONLY Shopify-generated invoices: manual/repair (non-shopify channel) invoices never enter the worklist", async () => {
    const ctx = makeCtx({
      seed: { app_config: [SENDER_CONFIG] },
      invoices: [
        { id: "inv-shop", counterparty_name: "Globex US", counterparty_country: "US" },
        { id: "inv-repair", channel: "manual", counterparty_name: "Adam Lindsay", counterparty_country: "AU" },
      ],
      docs: invoiceDoc({ id: "inv-shop" }),
    })
    const { rows, total } = await toPrepareList(ctx)
    expect(rows.map((r) => r.id)).toEqual(["inv-shop"])
    expect(total).toBe(1)
  })

  // POST-REWORK: the worklist is order-driven, so an order is NEVER silently dropped -- a
  // shipping-charge-only invoice becomes a visible needs_fix row instead of an absent one
  // (ticket-10224: an invisible order is how an order goes unshipped).
  it("keeps a shipping-charge-only order as a visible needs-fix row rather than dropping it", async () => {
    const ctx = makeCtx({
      seed: { app_config: [SENDER_CONFIG] },
      invoices: [
        {
          id: "inv-shiponly",
          counterparty_name: "Bruce Lagace",
          counterparty_country: "CA",
          lines: [{ product_source: null }],
        } as never,
        { id: "inv-goods", counterparty_name: "Globex US", counterparty_country: "US", lines: [{ product_source: "shopify" }] } as never,
      ],
      docs: invoiceDoc({ id: "inv-goods" }),
    })
    const { rows, total } = await toPrepareList(ctx)
    expect(total).toBe(2)
    const shipOnly = rows.find((r) => r.id === "inv-shiponly")!
    expect(shipOnly.prep_status).toBe("needs_fix")
    expect(rows.find((r) => r.id === "inv-goods")).toBeDefined()
  })

  it("surfaces an invoice with no shippable lines as needs-fix instead of dropping it", async () => {
    const ctx = makeCtx({
      seed: { app_config: [SENDER_CONFIG] },
      invoices: [{ id: "inv-svc", counterparty_name: "Consulting Co", counterparty_country: "FR" }],
      docs: invoiceDoc({ id: "inv-svc", lines: [{ id: "l1", line_kind: "software", description: "Consulting", quantity: 1, unit_price_minor: "10000", hs_code: null, country_of_origin: null, customs_description: null, product_source: null, external_id: null }] }),
    })
    const { rows } = await toPrepareList(ctx)
    // Previously dropped as "services-only" — but the badge estimate counts every
    // unlinked issued invoice, so a dropped row makes the badge point at an empty
    // list (free-text/backfilled invoices hit this constantly). Now a blocked row.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: "inv-svc", customer: "Consulting Co", destination: "FR", prep_status: "needs_fix", reason: "No shippable lines" })
  })

  it("flags a physical line with no shipping profile as needs-fix (Unresolved pack)", async () => {
    const ctx = makeCtx({
      seed: { app_config: [SENDER_CONFIG] }, // no shipping_profile → unresolved
      invoices: [{ id: "inv-x", counterparty_name: "Globex US", counterparty_country: "US" }],
      docs: invoiceDoc({ id: "inv-x" }),
    })
    const { rows } = await toPrepareList(ctx)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: "inv-x", customer: "Globex US", destination: "US", prep_status: "needs_fix" })
    expect(rows[0]!.reason).toMatch(/Unresolved pack|Missing/)
  })

  // A row leaves the worklist as soon as a live local shipment fully covers its invoice, order
  // keyed or not, no matter whether the scan that found it was live or cached. This exercises the
  // LIVE scan path (toPrepareList's default), since that path never dropped an order row before.
  it("a live scan drops an order row whose shipment is already live", async () => {
    const ctx = makeCtx({
      seed: { app_config: [SENDER_CONFIG], shipment: [{ id: "s1", document_ref: "inv-x", order_status: "PENDING" }] },
      invoices: [{ id: "inv-x", counterparty_name: "Globex", counterparty_country: "US" }],
      docs: invoiceDoc({ id: "inv-x" }),
    })
    const { rows } = await toPrepareList(ctx)
    expect(rows.map((r) => r.id)).toEqual([])
  })

  it("excludes an invoice marked prep_state.excluded from the default worklist (agrees with queue_counts/prep_list)", async () => {
    const ctx = makeCtx({
      seed: {
        app_config: [SENDER_CONFIG],
        prep_state: [{ id: "s1", document_ref: "inv-x", category: "sale", excluded: true }],
      },
      invoices: [{ id: "inv-x", counterparty_name: "Globex", counterparty_country: "US" }],
      docs: invoiceDoc({ id: "inv-x" }),
    })
    const { rows } = await toPrepareList(ctx)
    expect(rows).toHaveLength(0)
    // includeExcluded:true surfaces it back (the prep_list include_excluded=true path).
    const { rows: withExcluded } = await toPrepareList(ctx, { includeExcluded: true })
    expect(withExcluded.map((r) => r.id)).toEqual(["inv-x"])
  })

  // marco-morning-to-prepare-triage (l-this): an EXPORT row whose parcel resolves but whose customs
  // declaration is incomplete must NOT be classified ready — the operator needs the per-item "missing
  // info" reason before opening the box. Previously to_prepare_list inspected only `unresolved` (parcel
  // side), so a US/JP export missing its HS code or customs value resolved a parcel and was reported
  // READY (a silent hide of the exact defect the morning triage exists to flag). The draft already KNOWS
  // each defect; these three cases assert the per-item reason is surfaced.
  it("flags an export whose customs line has no HS code as needs-fix (Missing HS code)", async () => {
    const ctx = makeCtx({
      seed: {
        app_config: [SENDER_CONFIG],
        // profile resolves a parcel (weight + dims), so the line is NOT parcel-unresolved …
        shipping_profile: [{ id: "p1", product_source: "shopify", product_id: "V1", unit_weight: 0.8, solo_length: 30, solo_width: 20, solo_height: 12, content_category: "content:v1:50360" }],
      },
      invoices: [{ id: "inv-x", counterparty_name: "Globex US", counterparty_country: "US" }],
      // … but the export customs article has no hs_code → incomplete.
      docs: invoiceDoc({ id: "inv-x", lines: [{ id: "l1", description: "Kestrel 2", quantity: 1, unit_price_minor: "59900", hs_code: null, country_of_origin: "FR", customs_description: "Controller", product_source: "shopify", external_id: "V1" }] }),
    })
    const { rows } = await toPrepareList(ctx)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: "inv-x", prep_status: "needs_fix", reason: "Missing HS code" })
  })

  it("flags an export whose customs line has a zero customs value as needs-fix (Missing customs value)", async () => {
    const ctx = makeCtx({
      seed: {
        app_config: [SENDER_CONFIG],
        shipping_profile: [{ id: "p1", product_source: "shopify", product_id: "V1", unit_weight: 0.8, solo_length: 30, solo_width: 20, solo_height: 12, content_category: "content:v1:50360" }],
      },
      invoices: [{ id: "inv-x", counterparty_name: "Tokyo Modular KK", counterparty_country: "JP" }],
      // hs_code present (so it is NOT a HS-code defect) but the unit price is zero → no customs value.
      docs: invoiceDoc({ id: "inv-x", lines: [{ id: "l1", description: "Kestrel 6", quantity: 1, unit_price_minor: "0", hs_code: "92079000", country_of_origin: "FR", customs_description: "Instrument", product_source: "shopify", external_id: "V1" }] }),
    })
    const { rows } = await toPrepareList(ctx)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: "inv-x", prep_status: "needs_fix", reason: "Missing customs value" })
  })

  it("does NOT apply customs defects to an intra-EU (customs-free) row — it stays ready", async () => {
    const ctx = makeCtx({
      seed: {
        app_config: [SENDER_CONFIG],
        shipping_profile: [{ id: "p1", product_source: "shopify", product_id: "V1", unit_weight: 0.8, solo_length: 30, solo_width: 20, solo_height: 12, content_category: "content:v1:50360" }],
      },
      invoices: [{ id: "inv-eu", counterparty_name: "Klangbau GmbH", counterparty_country: "DE" }],
      // DE (intra-EU) export, no hs_code — but intra-EU needs no customs, so this is READY not needs-fix.
      docs: invoiceDoc({ id: "inv-eu", counterparty_country: "DE", requires_hs_code: null, lines: [{ id: "l1", description: "Kestrel 6", quantity: 1, unit_price_minor: "59900", hs_code: null, country_of_origin: null, customs_description: null, product_source: "shopify", external_id: "V1" }] }),
    })
    const { rows } = await toPrepareList(ctx)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: "inv-eu", prep_status: "ready_to_prepare" })
    expect(rows[0]!.reason).toBeUndefined()
  })

  it("marks ready when the line resolves to a parcel and the address is present", async () => {
    const ctx = makeCtx({
      seed: {
        app_config: [SENDER_CONFIG],
        shipping_profile: [{ id: "p1", product_source: "shopify", product_id: "V1", unit_weight: 0.8, solo_length: 30, solo_width: 20, solo_height: 12, content_category: "content:v1:50360" }],
      },
      invoices: [{ id: "inv-x", counterparty_name: "Globex US", counterparty_country: "US" }],
      docs: invoiceDoc({ id: "inv-x" }),
    })
    const { rows } = await toPrepareList(ctx)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ prep_status: "ready_to_prepare", customer: "Globex US" })
    expect(rows[0]!.weight).toBeGreaterThan(0)
    expect(rows[0]!.reason).toBeUndefined()
  })

  // BL-258 anti-fabrication relabel guard: the to-prepare worklist must NOT expose a `ready:boolean`
  // field. A weak model reads `ready:true` as "this shipment is already staged/ready to ship" and
  // narrates a staged shipment with no matching gated create_shipment call (fabrication). The field
  // is `prep_status` — an explicit string ("ready_to_prepare" | "needs_fix") whose value names the
  // INVOICE's draftability, never a staged shipment. Lock both the absence of `ready` and the value set.
  it("exposes prep_status as a string enum, never a `ready` boolean (anti-fabrication relabel guard)", async () => {
    // A draftable invoice → prep_status "ready_to_prepare", and there must be NO `ready` boolean
    // anywhere on the row (the ambiguous staged-vs-draftable field a weak model misreads as "shipped").
    const okCtx = makeCtx({
      seed: {
        app_config: [SENDER_CONFIG],
        shipping_profile: [{ id: "p1", product_source: "shopify", product_id: "V1", unit_weight: 0.8, solo_length: 30, solo_width: 20, solo_height: 12, content_category: "content:v1:50360" }],
      },
      invoices: [{ id: "inv-ok", counterparty_name: "Globex US", counterparty_country: "US" }],
      // intra-EU (DE) so no customs articles are required → resolves clean → ready_to_prepare.
      docs: invoiceDoc({ id: "inv-ok", counterparty_country: "DE", requires_hs_code: null, lines: [{ id: "l1", description: "Kestrel 6", quantity: 1, unit_price_minor: "59900", product_source: "shopify", external_id: "V1" }] }),
    })
    const { rows: okRows } = await toPrepareList(okCtx)
    expect(okRows).toHaveLength(1)
    const ok = okRows[0]!
    expect(Object.keys(ok)).not.toContain("ready")
    expect(ok).not.toHaveProperty("ready")
    expect(typeof ok.prep_status).toBe("string")
    expect(ok.prep_status).toBe("ready_to_prepare")

    // An unprofiled physical line → prep_status "needs_fix", same field-shape guarantees.
    const badCtx = makeCtx({
      seed: { app_config: [SENDER_CONFIG] }, // no shipping_profile → the line never resolves
      invoices: [{ id: "inv-bad", counterparty_name: "Acme NoProfile", counterparty_country: "US" }],
      docs: invoiceDoc({ id: "inv-bad", lines: [{ id: "l1", description: "Kestrel 6", quantity: 1, unit_price_minor: "59900", product_source: "shopify", external_id: "V-NONE" }] }),
    })
    const { rows: badRows } = await toPrepareList(badCtx)
    expect(badRows).toHaveLength(1)
    const bad = badRows[0]!
    expect(Object.keys(bad)).not.toContain("ready")
    expect(bad).not.toHaveProperty("ready")
    expect(bad.prep_status).toBe("needs_fix")
  })

  // journey-16 (marco_week_fulfillment) anti-fabrication ROOT: in the journey's shared world the
  // to-prepare queue is INFLATED (sibling slices seed more issued invoices), so the flat `{rows}` list
  // forced the agent to partition + count + enumerate a long mixed list in-context — and under a
  // multi-turn "give me a clean ready list I can trust" demand it FABRICATED invoice references
  // (INV-2026-9300…9308) absent from every tool result AND re-listed two needs_fix invoices (Osaka,
  // Manchester) as ready. The root fix is a SERVER-SIDE authoritative partition + denominators so the
  // caller RENDERS the split verbatim instead of re-deriving it: `total`/`ready_count`/`needs_fix_count`
  // and disjoint, covering `ready_to_prepare[]` + `needs_fix[]` buckets. This test pins all three.
  it("returns a server-side partition + denominators (total/ready_count/needs_fix_count, disjoint ready_to_prepare + needs_fix) so a long worklist is rendered, not guessed (journey-16 anti-fabrication)", async () => {
    const ctx = makeCtx({
      seed: {
        app_config: [SENDER_CONFIG],
        // ONE good profile (resolves V1) → the V1 export is READY; V-MISS has no profile → needs_fix.
        shipping_profile: [{ id: "p1", product_source: "shopify", product_id: "V1", unit_weight: 0.8, solo_length: 30, solo_width: 20, solo_height: 12, content_category: "content:v1:50360" }],
      },
      invoices: [
        { id: "inv-ready-eu", counterparty_name: "Paris Modular", counterparty_country: "FR" },
        { id: "inv-ready-export", counterparty_name: "Boston Modular", counterparty_country: "US" },
        { id: "inv-needsfix-hs", counterparty_name: "Manchester Modular", counterparty_country: "GB" },
        { id: "inv-needsfix-profile", counterparty_name: "Osaka Modular", counterparty_country: "JP" },
      ],
      docs: [
        // intra-EU customs-free, V1 resolves → READY
        invoiceDoc({ id: "inv-ready-eu", counterparty_country: "FR", requires_hs_code: null, lines: [{ id: "l1", description: "Kestrel 6", quantity: 1, unit_price_minor: "59900", product_source: "shopify", external_id: "V1" }] }),
        // US export, full customs snapshot, V1 resolves → READY
        invoiceDoc({ id: "inv-ready-export", counterparty_country: "US", lines: [{ id: "l1", description: "Kestrel 6", quantity: 1, unit_price_minor: "59900", hs_code: "92079000", country_of_origin: "FR", customs_description: "Instrument", product_source: "shopify", external_id: "V1" }] }),
        // GB export missing its HS code → needs_fix (Missing HS code)
        invoiceDoc({ id: "inv-needsfix-hs", counterparty_country: "GB", lines: [{ id: "l1", description: "Kestrel 6", quantity: 1, unit_price_minor: "59900", hs_code: null, country_of_origin: "FR", customs_description: "Instrument", product_source: "shopify", external_id: "V1" }] }),
        // JP export whose line has no resolving profile (V-MISS) → needs_fix (Unresolved pack)
        invoiceDoc({ id: "inv-needsfix-profile", counterparty_country: "JP", lines: [{ id: "l1", description: "Kestrel 6", quantity: 1, unit_price_minor: "59900", product_source: "shopify", external_id: "V-MISS" }] }),
      ],
    })
    const out = await toPrepareList(ctx)

    // Denominators present + self-consistent with the flat list.
    expect(out.total).toBe(out.rows.length)
    expect(out.total).toBe(4)
    expect(out.ready_count).toBe(out.ready_to_prepare.length)
    expect(out.needs_fix_count).toBe(out.needs_fix.length)
    expect(out.ready_count + out.needs_fix_count).toBe(out.total)
    expect(out.ready_count).toBe(2)
    expect(out.needs_fix_count).toBe(2)

    // Buckets are DISJOINT (a row is never in both) and cover the flat list.
    const readyIds = out.ready_to_prepare.map((r) => r.id).sort()
    const needsIds = out.needs_fix.map((r) => r.id).sort()
    expect(readyIds).toEqual(["inv-ready-eu", "inv-ready-export"])
    expect(needsIds).toEqual(["inv-needsfix-hs", "inv-needsfix-profile"])
    expect(readyIds.some((id) => needsIds.includes(id))).toBe(false)
    expect([...readyIds, ...needsIds].sort()).toEqual(out.rows.map((r) => r.id).sort())

    // Every ready row really is ready_to_prepare; every needs_fix row carries a reason.
    expect(out.ready_to_prepare.every((r) => r.prep_status === "ready_to_prepare")).toBe(true)
    expect(out.needs_fix.every((r) => r.prep_status === "needs_fix" && typeof r.reason === "string")).toBe(true)
  })
})

describe("queueCounts", () => {
  it("counts ready (CONFIRMED), returns, and un-linked issued invoices", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "s1", order_status: "CONFIRMED", document_ref: "inv-1" },
          { id: "s2", order_status: "PENDING", document_ref: "inv-2" },
          { id: "r1", kind: "return", order_status: "CONFIRMED" },
        ],
      },
      invoices: [{ id: "inv-1" }, { id: "inv-2" }, { id: "inv-3" }], // inv-1/2 linked, inv-3 open
    })
    const counts = await queueCounts(ctx)
    expect(counts.ready).toBe(2) // s1 + s2 (PENDING labels count as ready; r1 is a return)
    expect(counts.returns).toBe(1) // r1
    // The badge counts OPEN ORDERS, and a row leaves as soon as a live local shipment fully covers
    // it: inv-1 (CONFIRMED) and inv-2 (PENDING) both have one, so only inv-3 is still shipping work.
    // The badge equals the grid's default row count by construction: both come from
    // worklistCandidates.
    expect(counts.to_prepare).toBe(1)
    expect(counts.exceptions).toBe(0) // no shipment is in an exception state here
  })

  // monday-cross-app-business-pulse — the badge must surface the stuck-parcel count from the SAME
  // authoritative source as exceptions_list, so a "what's stuck in shipping" read off queue_counts
  // cannot mistake an empty prep queue for a clean exceptions check (the weak agent declared shipping
  // "healthy / no exceptions" off queue_counts alone, omitting a real EXCEPTION parcel).
  it("surfaces a non-zero `exceptions` count when a shipment is in an EXCEPTION/INCIDENT/LOST state", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "ok", order_status: "CONFIRMED", tracking_status: "IN_TRANSIT" },
          { id: "stuck1", order_status: "CONFIRMED", tracking_status: "EXCEPTION" },
          { id: "stuck2", order_status: "CONFIRMED", tracking_status: "INCIDENT" },
        ],
      },
      invoices: [],
    })
    const counts = await queueCounts(ctx)
    expect(counts.exceptions).toBe(2) // stuck1 (EXCEPTION) + stuck2 (INCIDENT); the IN_TRANSIT one is healthy
  })

  it("excludes prep_state.excluded rows from to_prepare, so the sidebar badge agrees with prep_list's default view", async () => {
    const ctx = makeCtx({
      seed: {
        prep_state: [{ id: "s1", document_ref: "inv-2", category: "sale", excluded: true }],
      },
      invoices: [{ id: "inv-1" }, { id: "inv-2" }], // both open (no live shipment); inv-2 excluded
    })
    const counts = await queueCounts(ctx)
    expect(counts.to_prepare).toBe(1) // inv-2 excluded from the count, matching toPrepareList's default
  })
})

describe("queue_counts and to_prepare_list are reads: the proforma settle is best effort", () => {
  // A pending order-less proforma that has since been issued: the scan settles it, which writes to
  // prep_order_state. That write is Boxtal's own state, so when it throws the read still answers
  // (the same stance prep_list takes).
  function settlingCtx(): { ctx: BoxtalToolCtx; updates: () => number } {
    const base = makeCtx({
      invoices: [],
      seed: {
        prep_order_state: [
          {
            id: "os-pending",
            order_key: "pending:tok-1",
            category: "gift",
            status: "to_prepare",
            excluded: false,
            proforma_pending_approval_id: "appr-1",
            proforma_requested_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          },
        ],
      },
    })
    let attempts = 0
    const ctx = {
      ...base,
      db: {
        ...base.db,
        update: async () => {
          attempts++
          throw new Error("write refused")
        },
      },
      executeTool: async (target: string, args?: Record<string, unknown>) => {
        if (target === "invoicing:documents_search" && args?.type === "proforma") {
          return {
            status: "completed",
            result: [{ id: "prof-77", number: "PF-77", shipment_ref: "prep:pending:tok-1" }],
          } as CrossAppEnvelope
        }
        return base.executeTool(target, args ?? {})
      },
    } as BoxtalToolCtx
    return { ctx, updates: () => attempts }
  }

  it("queue_counts still answers when the settle write throws", async () => {
    const { ctx, updates } = settlingCtx()
    const counts = await queueCounts(ctx)
    expect(updates()).toBeGreaterThan(0)
    expect(counts.to_prepare).toBe(1)
  })

  it("to_prepare_list (given no scan) still answers when the settle write throws", async () => {
    const { ctx, updates } = settlingCtx()
    const list = await toPrepareList(ctx, { skipResolve: true })
    expect(updates()).toBeGreaterThan(0)
    expect(list.total).toBe(1)
  })
})

describe("boxtal exceptions_list", () => {
  it("returns only shipments in exception tracking states (INCIDENT/RETURNED/LOST)", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "S1", tracking_status: "DELIVERED", recipient_summary: "Globex", offer_code: "CHRP", tracking_number: "T1", order_status: "CONFIRMED" },
          { id: "S2", tracking_status: "INCIDENT", recipient_summary: "Acme", offer_code: "CHRP", tracking_number: "T2", order_status: "CONFIRMED" },
          { id: "S3", tracking_status: "LOST", recipient_summary: "Stark", offer_code: "MONR", tracking_number: "T3", order_status: "CONFIRMED" },
          { id: "S4", tracking_status: "IN_TRANSIT", recipient_summary: "Wayne", order_status: "CONFIRMED" },
        ],
      },
    })
    const out = await exceptionsList(ctx)
    expect(out.rows.map((r) => r.id).sort()).toEqual(["S2", "S3"])
    expect(
      out.rows.every((r) => ["INCIDENT", "RETURNED", "LOST"].includes(r.tracking_status ?? "")),
    ).toBe(true)
  })

  // Regression (ops-daily-exception-triage-cross-app-works): exceptions_list previously omitted external_id
  // (the order ref), unlike search/track which surface it. An agent that found a customs-hold exception via
  // exceptions_list then quoted the order ref → the judge saw it as FABRICATED (the ref was in no tool
  // output it received). exceptions_list must surface external_id so the order ref is grounded.
  it("surfaces external_id (the order ref) on each exception row, like search/track", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "E1", tracking_status: "EXCEPTION", external_id: "#EMB-2026-00731", recipient_summary: "Aki Sato", offer_code: "UPS", tracking_number: "1Z-9", order_status: "CONFIRMED" },
          { id: "E2", tracking_status: "DELIVERED", external_id: "#EMB-2026-00701", recipient_summary: "Healthy", order_status: "CONFIRMED" },
        ],
      },
    })
    const out = await exceptionsList(ctx)
    expect(out.rows.map((r) => r.id)).toEqual(["E1"])
    expect(out.rows[0]?.external_id).toBe("#EMB-2026-00731")
  })

  it("returns an empty list (not an error) when no shipments are in exception", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "H1", tracking_status: "DELIVERED" },
          { id: "H2", tracking_status: "IN_TRANSIT" },
        ],
      },
    })
    const out = await exceptionsList(ctx)
    expect(out.rows).toEqual([])
  })

  it("surfaces the parsed insurance cost as insurancePriceExclTax when insurance_value is requested", () => {
    const offer = buildOfferWithInsurance(baseOffer(), { insurance_value: 800 })
    expect(offer.insurancePriceExclTax).toBeGreaterThan(0)
  })

  it("omitting insurance_value yields no insurance cost (opt-in, not default)", () => {
    const offer = buildOfferWithInsurance(baseOffer(), {})
    expect(offer.insurancePriceExclTax).toBeNull()
  })
})

// stuck_list — the single needs-attention queue (BL-275 stuck-shipment-customs-exception-routine).
// The server-side UNION of the three stuck families exceptions_list does NOT span. These tests pin the
// EXACT classification contract the flash-lite watcher routine relies on (it RENDERS stuck_list's rows
// instead of classifying tracking_status enums in-context): all three families surfaced + labelled, the
// healthy/cancelled distractors excluded.
describe("boxtal stuck_list", () => {
  it("returns the UNION of all three stuck families, each labelled, and EXCLUDES healthy + cancelled", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          // family=exception (customs hold) — carries a merchant external_id
          { id: "X1", tracking_status: "EXCEPTION", external_id: "#ORD-CUSTOMS", boxtal_order_id: "BX-CUST", recipient_summary: "Aki Sato", offer_code: "UPS", tracking_number: "1Z-CUST", order_status: "CONFIRMED" },
          // family=failed_delivery
          { id: "X2", tracking_status: "FAILED_ATTEMPT", external_id: "#ORD-FAILED", boxtal_order_id: "BX-FAIL", recipient_summary: "Mason Reed", offer_code: "Chronopost", tracking_number: "CHR-FAIL", order_status: "CONFIRMED" },
          // family=pickup_expiring — NO merchant external_id (the exception-sweep fixture shape) → order_ref falls back to boxtal_order_id
          { id: "X3", tracking_status: "REACHED_DELIVERY_PICKUP_POINT", external_id: null, boxtal_order_id: "BX-PICK", recipient_summary: "Lena Vogt", offer_code: "Mondial Relay", tracking_number: "MR-PICK", order_status: "CONFIRMED" },
          // healthy distractors — MUST NOT appear
          { id: "H1", tracking_status: "IN_TRANSIT", external_id: "#ORD-IT", recipient_summary: "Healthy InTransit", order_status: "CONFIRMED" },
          { id: "H2", tracking_status: "OUT_FOR_DELIVERY", external_id: "#ORD-OFD", recipient_summary: "Healthy OFD", order_status: "CONFIRMED" },
          { id: "H3", tracking_status: "DELIVERED", external_id: "#ORD-DLV", recipient_summary: "Healthy Delivered", order_status: "CONFIRMED" },
          { id: "H4", tracking_status: "ANNOUNCED", external_id: "#ORD-ANN", recipient_summary: "Healthy Announced", order_status: "CONFIRMED" },
          // a CANCELLED exception — MUST NOT appear (no longer in play)
          { id: "C1", tracking_status: "EXCEPTION", external_id: "#ORD-CXL", recipient_summary: "Cancelled", order_status: "CANCELLED" },
          // a row with no tracking_status — MUST NOT appear
          { id: "N1", tracking_status: null, external_id: "#ORD-NULL", recipient_summary: "No status", order_status: "CONFIRMED" },
        ],
      },
    })
    const out = await stuckList(ctx)
    // Exactly the three stuck families, no healthy/cancelled/null rows.
    expect(out.rows.map((r) => r.id).sort()).toEqual(["X1", "X2", "X3"])
    const byId = Object.fromEntries(out.rows.map((r) => [r.id, r]))
    expect(byId.X1?.family).toBe("exception")
    expect(byId.X2?.family).toBe("failed_delivery")
    expect(byId.X3?.family).toBe("pickup_expiring")
    // Each row carries the order ref + tracking number + the exact tracking_status (grounded, citable).
    expect(byId.X1?.external_id).toBe("#ORD-CUSTOMS")
    // order_ref prefers the merchant external_id when present …
    expect(byId.X1?.order_ref).toBe("#ORD-CUSTOMS")
    expect(byId.X1?.tracking_number).toBe("1Z-CUST")
    expect(byId.X1?.tracking_status).toBe("EXCEPTION")
    expect(byId.X2?.external_id).toBe("#ORD-FAILED")
    expect(byId.X2?.order_ref).toBe("#ORD-FAILED")
    // … and FALLS BACK to the Boxtal order id when the shipment has no merchant external_id (the
    // exception-sweep fixture shape) — so the dossier ALWAYS has a real, tool-backed order reference.
    expect(byId.X3?.external_id).toBeNull()
    expect(byId.X3?.boxtal_order_id).toBe("BX-PICK")
    expect(byId.X3?.order_ref).toBe("BX-PICK")
    expect(byId.X3?.tracking_status).toBe("REACHED_DELIVERY_PICKUP_POINT")
    // Every row has a non-empty grounded reason / next-action.
    expect(out.rows.every((r) => typeof r.reason === "string" && r.reason.length > 0)).toBe(true)
    // The pickup-expiring reason names the return-to-sender risk (the spec's discriminator).
    expect(byId.X3?.reason.toLowerCase()).toContain("return to sender")
  })

  it("is a strict SUPERSET of exceptions_list (catches FAILED_ATTEMPT + pickup-expiring exceptions_list misses)", async () => {
    const seed = {
      shipment: [
        { id: "E1", tracking_status: "EXCEPTION", external_id: "#A", recipient_summary: "Customs", order_status: "CONFIRMED" },
        { id: "F1", tracking_status: "FAILED_ATTEMPT", external_id: "#B", recipient_summary: "Failed", order_status: "CONFIRMED" },
        { id: "P1", tracking_status: "REACHED_DELIVERY_PICKUP_POINT", external_id: "#C", recipient_summary: "Pickup", order_status: "CONFIRMED" },
      ],
    }
    const exc = await exceptionsList(makeCtx({ seed }))
    const stuck = await stuckList(makeCtx({ seed }))
    // exceptions_list catches ONLY the hard EXCEPTION row …
    expect(exc.rows.map((r) => r.id)).toEqual(["E1"])
    // … while stuck_list catches all three — the exact gap this tool closes.
    expect(stuck.rows.map((r) => r.id).sort()).toEqual(["E1", "F1", "P1"])
  })

  it("returns an empty list (not an error) for a fully healthy fleet", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          { id: "H1", tracking_status: "DELIVERED" },
          { id: "H2", tracking_status: "IN_TRANSIT" },
          { id: "H3", tracking_status: "OUT_FOR_DELIVERY" },
        ],
      },
    })
    const out = await stuckList(ctx)
    expect(out.rows).toEqual([])
  })
})

// An ORPHANED create reservation: create_shipment is not atomic and the sandbox
// worker pool kills a handler at 62s with no rollback, so a kill between the
// Boxtal order being PAID and finalizeCreated writing its id leaves a row in
// create_in_flight with no boxtal_order_id and no tracking_status at all. Every
// queue classified on tracking_status was structurally blind to it, so a paid
// label was invisible to every operator. stuck_list now shows it.
describe("boxtal stuck_list - orphaned create reservations", () => {
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

  it("surfaces a STALE unfinished reservation as family=create_orphan and leaves a FRESH one alone", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          // Stale: the create was interrupted 45 minutes ago and never finished.
          {
            id: "O1",
            link_state: "create_in_flight",
            order_status: null,
            tracking_status: null,
            boxtal_order_id: null,
            external_id: "#ORD-ORPHAN",
            document_ref: "doc-orphan",
            recipient_summary: "Orphan Reservation",
            created_at: ago(45 * 60 * 1000),
          },
          // Stale and indeterminate (a 5xx at create): same family.
          {
            id: "O2",
            link_state: "create_uncertain",
            order_status: null,
            tracking_status: null,
            external_id: null,
            boxtal_order_id: "BX-UNCERTAIN",
            recipient_summary: "Uncertain Reservation",
            created_at: ago(45 * 60 * 1000),
          },
          // FRESH: a create that is legitimately running right now. NEVER listed.
          {
            id: "F1",
            link_state: "create_in_flight",
            order_status: null,
            tracking_status: null,
            external_id: "#ORD-LIVE",
            recipient_summary: "In flight right now",
            created_at: ago(20 * 1000),
          },
          // A finished row with no tracking yet is NOT an orphan.
          {
            id: "D1",
            link_state: "created",
            order_status: "PENDING",
            tracking_status: null,
            boxtal_order_id: "BX-OK",
            created_at: ago(45 * 60 * 1000),
          },
        ],
      },
    })
    const out = await stuckList(ctx)
    expect(out.rows.map((r) => r.id).sort()).toEqual(["O1", "O2"])
    const byId = Object.fromEntries(out.rows.map((r) => [r.id, r]))
    expect(byId.O1?.family).toBe("create_orphan")
    expect(byId.O2?.family).toBe("create_orphan")
    // The operator gets the order reference to look up at Boxtal, and a reason
    // that promises no automatic buying, cancelling or retrying.
    expect(byId.O1?.order_ref).toBe("#ORD-ORPHAN")
    expect(byId.O2?.order_ref).toBe("BX-UNCERTAIN")
    expect(byId.O1?.reason).toContain("Boxtal dashboard")
    expect(byId.O1?.reason).toContain("Nothing is bought, cancelled or retried automatically.")
    // Operator-visible copy carries no dash punctuation.
    expect(byId.O1?.reason).not.toMatch(/[–—]|--/)
  })

  it("never shows a CANCELLED unfinished reservation (no longer in play)", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          {
            id: "O3",
            link_state: "create_in_flight",
            order_status: "CANCELLED",
            tracking_status: null,
            created_at: ago(2 * 60 * 60 * 1000),
          },
        ],
      },
    })
    expect((await stuckList(ctx)).rows).toEqual([])
  })

  it("never shows a reservation a person released (create_abandoned), and points at the settle tool", async () => {
    const ctx = makeCtx({
      seed: {
        shipment: [
          {
            id: "R1",
            link_state: "create_abandoned",
            order_status: null,
            tracking_status: null,
            boxtal_order_id: null,
            document_ref: "doc-released",
            created_at: ago(2 * 60 * 60 * 1000),
          },
          {
            id: "O4",
            link_state: "create_in_flight",
            order_status: null,
            tracking_status: null,
            boxtal_order_id: null,
            document_ref: "doc-orphan-2",
            created_at: ago(2 * 60 * 60 * 1000),
          },
        ],
      },
    })
    const rows = (await stuckList(ctx)).rows
    expect(rows.map((r) => r.id)).toEqual(["O4"])
    expect(rows[0]?.reason).toContain("settle_orphan_create")
  })
})

describe("readyList: the documents the org's document rules ask for", () => {
  const TSCA = { id: "tpl-tsca", name: "TSCA certificate" }
  const STEEL = { id: "tpl-steel", name: "Steel content statement" }
  const SMELT = { id: "tpl-smelt", name: "Smelt and cast declaration" }

  function rulesCtx(opts: { fail?: boolean } = {}) {
    const calls: Array<{ target: string; args: Record<string, unknown> }> = []
    const base = makeCtx({
      seed: {
        shipment: [
          // A plate-only parcel to the US: the snapshot carries its SKU.
          { id: "p1", order_status: "CONFIRMED", recipient_summary: "US buyer", offer_code: "FEDX-InternationalEconomy", document_ref: "inv-1", queue_facts: { destination: "US", products: "1xMP", skus: ["SKU-PLATE"], carrier_family: "fedex" } },
          // The same, bought before SKUs were kept: no skus sent, never a throw.
          { id: "p2", order_status: "CONFIRMED", recipient_summary: "Old row", offer_code: "UPSE-StandardAP", document_ref: "inv-2", queue_facts: { destination: "US" } },
          { id: "p3", order_status: "PENDING", recipient_summary: "EU buyer", document_ref: "inv-3", queue_facts: { destination: "DE", skus: ["SKU-PLATE"] } },
          // Billed to FR, shipped to the US: the rule must see the US.
          { id: "p4", order_status: "CONFIRMED", recipient_summary: "FR billed", document_ref: "inv-4", queue_facts: { destination: "FR", to_country: "US", skus: ["SKU-PLATE"] } },
          // Billed and shipped to FR: the rule must not see the US.
          { id: "p5", order_status: "CONFIRMED", recipient_summary: "FR shipped", document_ref: "inv-5", queue_facts: { destination: "FR", to_country: "FR", skus: ["SKU-PLATE"] } },
        ],
      },
    })
    const inner = base.executeTool
    const ctx: BoxtalToolCtx = {
      ...base,
      executeTool: (async (target: string, args: Record<string, unknown>) => {
        if (target !== "kernel:document_rules_match") return inner(target, args)
        calls.push({ target, args })
        if (opts.fail) throw new Error("kernel unavailable")
        const records = args.records as Array<{ id: string; skus?: string[]; countryIso2?: string }>
        const matches = records
          .filter((r) => r.countryIso2 === "US" && (r.skus ?? []).includes("SKU-PLATE"))
          .map((r) => ({ recordId: r.id, rules: [{ id: "rule-1", name: "Plate to the US" }], templates: [TSCA, STEEL, SMELT] }))
        return { status: "completed", result: { matches } } satisfies CrossAppEnvelope
      }) as BoxtalToolCtx["executeTool"],
    }
    return { ctx, calls }
  }

  it("asks the kernel ONCE for the whole list, with each row's buy-time facts", async () => {
    const { ctx, calls } = rulesCtx()
    await readyList(ctx)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args.recordType).toBe("boxtal:shipment")
    const records = calls[0]!.args.records as Array<Record<string, unknown>>
    expect(records.find((r) => r.id === "p1")).toEqual({ id: "p1", skus: ["SKU-PLATE"], countryIso2: "US", carrier_family: "fedex" })
    // The old row sends no SKUs; its carrier family comes from its (unchanging) offer code.
    expect(records.find((r) => r.id === "p2")).toEqual({ id: "p2", countryIso2: "US", carrier_family: "ups" })
  })

  it("a plate-only US parcel gets ONE mark naming the three templates, and their ids for the print control", async () => {
    const { ctx } = rulesCtx()
    const { rows } = await readyList(ctx)
    const p1 = rows.find((r) => r.id === "p1")!
    expect(p1.attention).not.toBeNull()
    expect(p1.attention!.documents.map((d) => d.template_id)).toEqual(["tpl-tsca", "tpl-steel", "tpl-smelt"])
    expect(p1.attention!.rules).toEqual(["Plate to the US"])
    expect(p1.attention!.summary).toBe(
      "Needs: TSCA certificate, Steel content statement, Smelt and cast declaration (Plate to the US)",
    )
    expect(p1.needed_template_ids).toEqual(["tpl-tsca", "tpl-steel", "tpl-smelt"])
    const p2 = rows.find((r) => r.id === "p2")!
    expect(p2.attention).toBeNull()
    expect(p2.needed_template_ids).toEqual([])
    expect(rows.find((r) => r.id === "p3")!.attention).toBeNull()
  })

  it("matches on the country the parcel ships to, not the billed country", async () => {
    const { ctx, calls } = rulesCtx()
    await readyList(ctx)
    const records = calls[0]!.args.records as Array<Record<string, unknown>>
    expect(records.find((r) => r.id === "p4")).toMatchObject({ countryIso2: "US" })
    expect(records.find((r) => r.id === "p5")).toMatchObject({ countryIso2: "FR" })
  })

  it("a failed kernel read still paints the list, with no template marks", async () => {
    const { ctx, calls } = rulesCtx({ fail: true })
    const { rows } = await readyList(ctx)
    expect(calls).toHaveLength(1)
    expect(rows).toHaveLength(5)
    expect(rows.every((r) => r.attention === null && r.needed_template_ids.length === 0)).toBe(true)
  })
})
