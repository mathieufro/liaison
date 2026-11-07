// SPDX-License-Identifier: FSL-1.1-ALv2
//
// When the order's own ship-to and the customer's VERIFIED delivery address are not the same place,
// the label is held until a person picks (prep_set_address_choice); a later change to either
// address voids the pick; the approval card says which address is used and whether it is verified.
// A customer with NO verified address sees none of it: no hold, no chip, the same card.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type PrepSetAddressChoiceInput, prepSetAddressChoice, prepSetAddressChoicePreflight } from "./address-choice"
import { deriveDraftFacts } from "./draft-cache"
import { type GoldenCase, type GoldenShopifyAddress, goldenCases } from "./__fixtures__/address-golden"
import { docId, goldenCtx } from "./__fixtures__/address-harness"
import { buildRow } from "./prep"
import { cacheShipToIfStale, SHIP_TO_CACHE_TTL_MS, shipToTtlMs } from "./prep-meta"
import type { CrossAppEnvelope } from "./ctx"
import { createShipment, createShipmentPreflight, shipmentDraftCreate } from "./shipment"
import { summarizeAddressChoice, summarizeCreateShipment } from "./summarizers"

const ORDER_SITE: GoldenShopifyAddress = {
  name: "Lena Brandt",
  company: "Werkton Distribution GmbH",
  address1: "Werkstr. 6",
  address2: null,
  city: "Remagen",
  zip: "53424",
  countryCode: "DE",
  phone: "+492642111111",
}

function verifiedRow(over: Record<string, string | boolean | null> = {}): Record<string, string | boolean | null> {
  return {
    role: "delivery",
    name: "Lena Brandt",
    company: "Werkton Distribution GmbH",
    street1: "Industriepark 3",
    city: "Remagen",
    postalCode: "53424",
    countryIso2: "DE",
    phone: "+492642000000",
    email: "lager@werkton.example",
    origin: "manual",
    verified: true,
    verifiedAt: "2026-10-20T09:00:00.000Z",
    verifiedBy: "user-1",
    verifiedByName: "Sam Operator",
    verificationSource: "purchase_order",
    ...over,
  }
}

function differsCase(over: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: "case-95",
    doc: {
      counterparty_country: "DE",
      counterparty_name: "Werkton Distribution GmbH",
      counterparty_email: "orders@werkton.example",
      counterparty_contact_id: "22222222-2222-4222-8222-222222222222",
      counterparty_address: "Werkton Distribution GmbH\nWerkstr. 6\n53424 Remagen",
      shopify_order_id: "7300001",
    },
    order: { shippingAddress: { ...ORDER_SITE }, customerAddress: null, email: "orders@werkton.example" },
    book: [verifiedRow()],
    ...over,
  }
}

type Ctx = Parameters<typeof prepSetAddressChoice>[0]

/** The params the kernel stages: the caller's, with what the preflight pinned. */
async function staged(ctx: Ctx, input: PrepSetAddressChoiceInput): Promise<PrepSetAddressChoiceInput> {
  const res = await prepSetAddressChoicePreflight(ctx, input)
  if ("error" in res) throw new Error(`the preflight refused: ${res.error.code}`)
  return { ...input, ...res.pinnedParams }
}

/** A pick made the way the kernel runs it: staged, then executed. */
async function pickAddress(ctx: Ctx, input: PrepSetAddressChoiceInput) {
  return prepSetAddressChoice(ctx, await staged(ctx, input))
}

const stageParams = (c: GoldenCase) => ({ draft_id: docId(c), offer_code: "MONR-CpourToi", quoted_price_ttc: 9.5 })

describe("address differs: the label is held until a person picks", () => {
  it("preflight refuses to stage while the order and the verified address differ and nobody picked", async () => {
    const c = differsCase()
    const { ctx } = goldenCtx(c)
    const res = await createShipmentPreflight(ctx, stageParams(c))
    expect(res).toMatchObject({ error: { code: "address_differs" } })
    expect("error" in res && res.error.message).toContain("Address differs: a person must pick")
  })

  it("a pick lets it stage and ships to the picked address", async () => {
    const c = differsCase()
    const { ctx } = goldenCtx(c)
    const picked = await pickAddress(ctx, { document_ref: docId(c), choice: "verified" })
    expect(picked.address_check?.choice?.pick).toBe("verified")
    const draft = await shipmentDraftCreate(ctx, { document_ref: docId(c) })
    expect(draft.recipient_address).toMatchObject({ street: "Industriepark 3", phone: "+492642000000" })
    expect(draft.address_check).toMatchObject({
      state: "differs",
      used: { source: "operator_choice", address_id: "addr-case-95-0", verified_by_name: "Sam Operator" },
      choice: { pick: "verified" },
    })
    expect(await createShipmentPreflight(ctx, stageParams(c))).toEqual({ ok: true })
  })

  it("picking the order's address ships to the order's address", async () => {
    const c = differsCase()
    const { ctx } = goldenCtx(c)
    await pickAddress(ctx, { document_ref: docId(c), choice: "order" })
    const draft = await shipmentDraftCreate(ctx, { document_ref: docId(c) })
    expect(draft.recipient_address).toMatchObject({ street: "Werkstr. 6", phone: "+492642111111" })
    expect(draft.address_check?.choice?.pick).toBe("order")
  })

  it("a pick then an address change: refused again", async () => {
    const c = differsCase()
    const { ctx } = goldenCtx(c)
    await pickAddress(ctx, { document_ref: docId(c), choice: "order" })
    // The order is edited in the store: another street at the same postal code.
    c.order!.shippingAddress = { ...ORDER_SITE, address1: "Werkstr. 9" }
    const res = await createShipmentPreflight(ctx, stageParams(c))
    expect(res).toMatchObject({ error: { code: "address_differs" } })

    // Same for an edit of the verified address.
    const c2 = differsCase({ id: "case-96" })
    const two = goldenCtx(c2)
    await pickAddress(two.ctx, { document_ref: docId(c2), choice: "verified" })
    c2.book = [verifiedRow({ street1: "Industriepark 5" })]
    expect(await createShipmentPreflight(two.ctx, stageParams(c2))).toMatchObject({ error: { code: "address_differs" } })
  })

  it("refuses a pick when there is nothing to pick, before anyone is asked", async () => {
    const c = differsCase({ book: [verifiedRow({ street1: "Werkstrasse 6" })] })
    const { ctx } = goldenCtx(c)
    expect(await prepSetAddressChoicePreflight(ctx, { document_ref: docId(c), choice: "order" })).toMatchObject({
      error: { code: "address_choice_not_needed", message: expect.stringContaining("Nothing to pick") },
    })
  })

  it("the stage-time preflight refuses what the pick would refuse, and writes nothing", async () => {
    const same = differsCase({ book: [verifiedRow({ street1: "Werkstrasse 6" })] })
    const a = goldenCtx(same)
    expect(await prepSetAddressChoicePreflight(a.ctx, { document_ref: docId(same), choice: "order" })).toMatchObject({
      error: { code: "address_choice_not_needed" },
    })
    expect(
      await prepSetAddressChoicePreflight(a.ctx, { document_ref: docId(same), choice: "nope" as "order" }),
    ).toMatchObject({ error: { code: "invalid_choice" } })
    const c = differsCase()
    const b = goldenCtx(c)
    expect(
      await prepSetAddressChoicePreflight(b.ctx, { document_ref: docId(c), choice: "verified", address_id: "stale-id" }),
    ).toMatchObject({ error: { code: "address_choice_stale" } })
    expect(await prepSetAddressChoicePreflight(b.ctx, { document_ref: docId(c), choice: "verified" })).toMatchObject({ ok: true })
    // Read-only: the label is still held after an accepted preflight (no pick was stored).
    expect(await createShipmentPreflight(b.ctx, stageParams(c))).toMatchObject({ error: { code: "address_differs" } })
  })

  it("the prep row carries the comparison only when there is a verified address", async () => {
    const c = differsCase({ cachedShipTo: true })
    const { ctx } = goldenCtx(c)
    const draft = await shipmentDraftCreate(ctx, { document_ref: docId(c), orderShipTo: false })
    const facts = deriveDraftFacts(draft, docId(c))
    // Cached for the grid (the worklist read never resolves a draft).
    expect(facts.address_check?.state).toBeDefined()
    const plain = goldenCases().find((g) => g.doc.shopify_order_id && !g.book)!
    const plainCtx = goldenCtx(plain)
    const plainFacts = deriveDraftFacts(
      await shipmentDraftCreate(plainCtx.ctx, { document_ref: docId(plain), orderShipTo: false }),
      docId(plain),
    )
    const row = (cached: typeof facts, state?: unknown) =>
      buildRow({
        candidate: {
          order_key: "so:1",
          anchor_ref: cached.document_ref,
          anchor_kind: "invoice",
          anchor_number: "INV-1",
          order_name: "#1",
          order_created_at: null,
          customer: "Werkton",
          destination: "DE",
          order_tags: [],
          line_items: [],
          order_total_minor: null,
          currency: "EUR",
          category: "sale",
          status: "to_prepare",
          status_note: null,
          staff_note: null,
          excluded: false,
          recipient: null,
          state,
        } as never,
        cached,
        cachedQuote: undefined,
        legacyState: undefined,
        shipment: null,
        coverage: undefined,
        invoicingAvailable: true,
      })
    expect(row(facts).address_check).toMatchObject({
      state: "differs",
      order_address: { street: "Werkstr. 6" },
      verified_address: { street: "Industriepark 3", verified_by_name: "Sam Operator" },
    })
    expect("address_check" in row(plainFacts)).toBe(false)
    // Only a recipient a person stored on the row is sent with a Ship click.
    expect(row(facts).recipient_edited).toBeUndefined()
    expect(row(facts, { recipient: { street: "Am Bahnhof 1", city: "Remagen", postalCode: "53424" } }).recipient_edited).toBe(true)
  })
})

describe("worklist cache: an order with no address is an answer, not a miss", () => {
  it("caches 'no address' so the order is not read again on every sync", async () => {
    const c = differsCase({ order: { shippingAddress: null, customerAddress: null, email: null } })
    const { ctx } = goldenCtx(c)
    let reads = 0
    const read = async () => {
      reads++
      return null
    }
    expect(await cacheShipToIfStale(ctx, docId(c), read)).toBe(true)
    expect(await cacheShipToIfStale(ctx, docId(c), read)).toBe(false)
    expect(reads).toBe(1)
  })

  it("a sync run refreshes a capped number of expired ship-tos; a first read is never capped", async () => {
    const stale = differsCase({ cachedShipTo: true })
    const { ctx } = goldenCtx(stale)
    let reads = 0
    const read = async () => {
      reads++
      return null
    }
    const spent = { remaining: 0 }
    expect(await cacheShipToIfStale(ctx, docId(stale), read, spent)).toBe(false)
    expect(reads).toBe(0)
    const one = { remaining: 1 }
    expect(await cacheShipToIfStale(ctx, docId(stale), read, one)).toBe(true)
    expect(one.remaining).toBe(0)
    // Never cached before: read whatever the budget says.
    const fresh = differsCase({ id: "case-97" })
    const f = goldenCtx(fresh)
    expect(await cacheShipToIfStale(f.ctx, docId(fresh), read, { remaining: 0 })).toBe(true)
    expect(reads).toBe(2)
  })

  it("spreads expiry: each document's TTL is 12 h plus a fixed share of up to 6 h", () => {
    const ttls = Array.from({ length: 20 }, (_, i) => shipToTtlMs(`11111111-1111-4111-8111-${String(i).padStart(12, "0")}`))
    for (const t of ttls) {
      expect(t).toBeGreaterThanOrEqual(SHIP_TO_CACHE_TTL_MS)
      expect(t).toBeLessThan(SHIP_TO_CACHE_TTL_MS * 1.5)
    }
    expect(new Set(ttls).size).toBeGreaterThan(10)
    expect(shipToTtlMs("doc-a")).toBe(shipToTtlMs("doc-a"))
  })

  it("a worklist draft whose order is known to have no address uses the verified one, as the label does", async () => {
    const c = differsCase({ order: { shippingAddress: null, customerAddress: null, email: null } })
    const { ctx } = goldenCtx(c)
    await cacheShipToIfStale(ctx, docId(c), async () => null)
    const draft = await shipmentDraftCreate(ctx, { document_ref: docId(c), orderShipTo: false })
    expect(draft.address_check?.state).toBe("verified_only")
    expect(draft.recipient_address?.street).toBe("Industriepark 3")
  })
})

describe("approval card: which address, and whether it is verified", () => {
  const card = async (c: GoldenCase, draft: Awaited<ReturnType<typeof shipmentDraftCreate>>) =>
    (await summarizeCreateShipment(stageParams(c), undefined, { context: JSON.parse(JSON.stringify(draft)) })).lines

  it("names a verified address, its date, who verified it and from what", async () => {
    const c = differsCase({ book: [verifiedRow({ street1: "Werkstrasse 6" })] })
    const { ctx } = goldenCtx(c)
    const lines = await card(c, await shipmentDraftCreate(ctx, { document_ref: docId(c) }))
    expect(lines).toContain("Address: from the order, verified 2026-10-20 by Sam Operator from a purchase order")
  })

  it("says not verified when a person picked the order's address over the verified one", async () => {
    const c = differsCase()
    const { ctx } = goldenCtx(c)
    await pickAddress(ctx, { document_ref: docId(c), choice: "order" })
    const lines = await card(c, await shipmentDraftCreate(ctx, { document_ref: docId(c) }))
    expect(lines).toContain("Address: from the order, picked by a person, not verified")
  })

  it("customers with no verified address: no new line, the card is exactly what it was", async () => {
    // Card lines recorded with main's summarizer from before the address book (957e747585), on
    // these same drafts: a change to this summarizer cannot move both sides of the comparison.
    const was = JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__", "address-card.main.json"), "utf8")) as Record<
      string,
      string[]
    >
    for (const c of goldenCases()) {
      const { ctx } = goldenCtx(c)
      const draft = await shipmentDraftCreate(ctx, { document_ref: docId(c) })
      expect(draft.address_check?.state).toBe("no_verified")
      const now = await card(c, draft)
      expect(was[c.id]).toBeDefined()
      expect(now).toEqual(was[c.id]!)
      expect(now.some((l) => l.startsWith("Address:"))).toBe(false)
      // And no hold.
      const res = await createShipmentPreflight(ctx, stageParams(c))
      expect("error" in res ? res.error.code : "ok").not.toBe("address_differs")
    }
  })
})

/** The same case, but every `shopify:orders_get` fails (a store outage, a timeout). */
function failingOrderRead(c: GoldenCase) {
  const h = goldenCtx(c)
  let boxtalCalls = 0
  const ctx = {
    ...h.ctx,
    executeTool: async (target: string, args: string | Record<string, unknown>): Promise<CrossAppEnvelope> =>
      target === "shopify:orders_get"
        ? { status: "error", error: { code: "upstream_unavailable", message: "store timed out" } }
        : h.ctx.executeTool(target, args),
    fetch: async () => {
      boxtalCalls++
      return { status: 500, headers: {}, body: "" }
    },
    connections: {
      boxtal: {
        getSettings: async () => ({ values: { environment: "sandbox" }, missing: [] }),
        getToken: async () => {
          throw new Error("no token")
        },
        getAccounts: async () => [],
      },
    },
  }
  return { ctx, boxtalCalls: () => boxtalCalls }
}

describe("a failed order read on the label path refuses, never guesses", () => {
  it("no cache: refuses instead of shipping to the verified address", async () => {
    // The order says Werkstr. 6, the verified address is Industriepark 3, the read fails.
    const c = differsCase()
    const { ctx, boxtalCalls } = failingOrderRead(c)
    const draft = await shipmentDraftCreate(ctx, { document_ref: docId(c) })
    expect(draft.address_check?.order_read).toBe("failed")
    expect(draft.address_check?.state).not.toBe("verified_only")
    const staged = await createShipmentPreflight(ctx, stageParams(c))
    expect(staged).toMatchObject({ error: { code: "order_unreadable" } })
    expect("error" in staged && staged.error.message).toContain("Could not read the order's address from the store; try again")
    const bought = await createShipment(ctx, stageParams(c))
    expect(bought).toMatchObject({ error: { code: "order_unreadable" } })
    expect(boxtalCalls()).toBe(0)
  })

  it("with a cached ship-to: refuses instead of using it", async () => {
    const c = differsCase({ cachedShipTo: true })
    const { ctx } = failingOrderRead(c)
    const draft = await shipmentDraftCreate(ctx, { document_ref: docId(c) })
    expect(draft.address_check?.order_read).toBe("failed")
    expect(await createShipmentPreflight(ctx, stageParams(c))).toMatchObject({ error: { code: "order_unreadable" } })
    // Nor can a pick be made against an order nobody could read.
    expect(await prepSetAddressChoicePreflight(ctx, { document_ref: docId(c), choice: "order" })).toMatchObject({
      error: { code: "order_unreadable", retryable: true, message: expect.stringContaining("Could not read the order's address") },
    })
  })

  it("a customer with no verified address is not refused: the legacy precedence, as before the address book", async () => {
    // Nothing verified exists, so a failed read cannot route a label to a verified address.
    // Cached ship-to or not, the draft falls to the contact and invoice text exactly as it did.
    for (const cachedShipTo of [false, true]) {
      const c = differsCase({ id: `case-97-${cachedShipTo}`, book: [], cachedShipTo })
      const { ctx } = failingOrderRead(c)
      const draft = await shipmentDraftCreate(ctx, { document_ref: docId(c) })
      expect(draft.address_check?.order_read).toBeUndefined()
      expect(draft.address_check?.state).toBe("no_verified")
      // The invoice text parse, which is all main kept when the order could not be read.
      expect(draft.recipient_address).toMatchObject({
        street: "Werkton Distribution GmbH, Werkstr. 6",
        city: "Remagen",
        postalCode: "53424",
      })
      const staged = await createShipmentPreflight(ctx, stageParams(c))
      expect("error" in staged ? staged.error.code : "ok").not.toBe("order_unreadable")
    }
  })

  it("a read that succeeds is not flagged, and the worklist build never reads", async () => {
    const c = differsCase({ book: [verifiedRow({ street1: "Werkstrasse 6" })] })
    const { ctx } = goldenCtx(c)
    const draft = await shipmentDraftCreate(ctx, { document_ref: docId(c) })
    expect(draft.address_check?.order_read).toBeUndefined()
    const { ctx: failing } = failingOrderRead(differsCase({ cachedShipTo: true }))
    const worklist = await shipmentDraftCreate(failing, { document_ref: docId(c), orderShipTo: false })
    expect(worklist.address_check?.order_read).toBeUndefined()
  })
})

describe("an address typed in the call", () => {
  const card = async (c: GoldenCase, draft: Awaited<ReturnType<typeof shipmentDraftCreate>>, typed: Record<string, string>) =>
    (
      await summarizeCreateShipment({ ...stageParams(c), recipient_address: typed }, undefined, {
        context: JSON.parse(JSON.stringify(draft)),
      })
    ).lines

  it("another place than the resolved one: the card says it was typed and is not verified", async () => {
    const c = differsCase({ book: [verifiedRow({ street1: "Werkstrasse 6" })] })
    const { ctx } = goldenCtx(c)
    const draft = await shipmentDraftCreate(ctx, { document_ref: docId(c) })
    const lines = await card(c, draft, { street: "Am Bahnhof 1" })
    expect(lines).toContain("Address: typed in the call, not verified")
    expect(lines.some((l) => l.includes("verified 2026-10-20"))).toBe(false)
  })

  it("the same place re-typed: the provenance line stays", async () => {
    const c = differsCase({ book: [verifiedRow({ street1: "Werkstrasse 6" })] })
    const { ctx } = goldenCtx(c)
    const draft = await shipmentDraftCreate(ctx, { document_ref: docId(c) })
    const lines = await card(c, draft, { street: "Werkstraße 6", city: "Remagen", postalCode: "53424" })
    expect(lines).toContain("Address: from the order, verified 2026-10-20 by Sam Operator from a purchase order")
  })
})

describe("a return whose addresses differ", () => {
  it("names the tool that makes the pick, and the pick lets the return through", async () => {
    const c = differsCase()
    const { ctx } = goldenCtx(c)
    const params = { ...stageParams(c), is_return: true }
    const held = await createShipmentPreflight(ctx, params)
    expect(held).toMatchObject({ error: { code: "address_differs" } })
    expect("error" in held && held.error.message).toContain("prep_set_address_choice")
    expect("error" in held && held.error.message).not.toContain("To prepare row")
    await pickAddress(ctx, { document_ref: docId(c), choice: "order" })
    const after = await createShipmentPreflight(ctx, params)
    expect("error" in after ? after.error.code : "ok").not.toBe("address_differs")
  })
})

describe("who picked", () => {
  it("records the person whose own click made the pick", async () => {
    const c = differsCase()
    const h = goldenCtx(c)
    const ctx = { ...h.ctx, getUserId: async () => "user-42" }
    await pickAddress(ctx, { document_ref: docId(c), choice: "order" })
    const rows = (await ctx.db.findMany("prep_order_state", { limit: 10 })) as Array<{ address_choice?: unknown }>
    const stored = rows.map((r) => (typeof r.address_choice === "string" ? JSON.parse(r.address_choice) : r.address_choice))
    expect(stored.find(Boolean)).toMatchObject({ pick: "order", chosen_by: "user-42" })
  })
})

describe("a pick is bound to the addresses on its card", () => {
  const storedPicks = async (ctx: Ctx) => {
    const rows = (await ctx.db.findMany("prep_order_state", { limit: 10 })) as Array<{ address_choice?: unknown }>
    return rows.map((r) => r.address_choice).filter(Boolean)
  }

  it("the tool declares the preflight and the pin, and carries no exemption from them", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))
    const tool = manifest.tools.prep_set_address_choice
    expect(tool.preflight).toBe("prepSetAddressChoicePreflight")
    expect(tool.pinnedParams).toEqual(["shown_addresses"])
    expect(tool.params.properties.shown_addresses).toBeDefined()
    expect(tool.editableFields).toBeUndefined()
  })

  it("staging pins the addresses it read and writes nothing", async () => {
    const c = differsCase()
    const { ctx } = goldenCtx(c)
    const res = await prepSetAddressChoicePreflight(ctx, { document_ref: docId(c), choice: "verified" })
    if ("error" in res) throw new Error(res.error.message)
    expect(res.pinnedParams.shown_addresses.order_address).toMatchObject({ street: "Werkstr. 6" })
    expect(res.pinnedParams.shown_addresses.verified_address).toMatchObject({ street: "Industriepark 3" })
    expect(res.pinnedParams.shown_addresses.hash).toMatch(/^[0-9a-f]+$/)
    expect(await storedPicks(ctx)).toEqual([])
  })

  it("the card shows the pinned addresses, not a later read", async () => {
    const c = differsCase()
    const { ctx } = goldenCtx(c)
    const params = await staged(ctx, { document_ref: docId(c), choice: "verified" })
    const later = { address_check: { order_address: { street: "Somewhere else" }, verified_address: { street: "Elsewhere" } } }
    const card = await summarizeAddressChoice(params, undefined, { context: later })
    const text = card.lines.join("\n")
    expect(text).toContain("Werkstr. 6")
    expect(text).toContain("Industriepark 3")
    expect(text).not.toContain("Somewhere else")
    expect(text).toContain("The label goes to the verified address")
  })

  it.each([
    ["the order is edited", (c: GoldenCase) => { c.order!.shippingAddress = { ...ORDER_SITE, address1: "Werkstr. 9" } }],
    ["the verified address is edited", (c: GoldenCase) => { c.book = [verifiedRow({ street1: "Industriepark 5" })] }],
    ["the two come to agree", (c: GoldenCase) => { c.order!.shippingAddress = { ...ORDER_SITE, address1: "Industriepark 3" } }],
  ])("%s after staging: the approved pick is void, and says so", async (_what, change) => {
    const c = differsCase()
    const { ctx } = goldenCtx(c)
    const params = await staged(ctx, { document_ref: docId(c), choice: "order" })
    change(c)
    const err = await prepSetAddressChoice(ctx, params).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: "address_choice_stale", retryable: false })
    expect((err as Error).message).toContain("changed after this pick was requested")
    expect(await storedPicks(ctx)).toEqual([])
  })

  it("the row stays held after a voided pick", async () => {
    const c = differsCase()
    const { ctx } = goldenCtx(c)
    const params = await staged(ctx, { document_ref: docId(c), choice: "order" })
    c.order!.shippingAddress = { ...ORDER_SITE, address1: "Werkstr. 9" }
    await prepSetAddressChoice(ctx, params).catch(() => {})
    expect(await createShipmentPreflight(ctx, stageParams(c))).toMatchObject({ error: { code: "address_differs" } })
  })

  it("a call staged without pinned addresses is refused, not applied", async () => {
    const c = differsCase()
    const { ctx } = goldenCtx(c)
    await expect(prepSetAddressChoice(ctx, { document_ref: docId(c), choice: "order" })).rejects.toMatchObject({
      code: "address_choice_stale",
    })
    expect(await storedPicks(ctx)).toEqual([])
  })

  it("refuses at staging: a verified address that is not this row's, a bad choice", async () => {
    const c = differsCase()
    const { ctx } = goldenCtx(c)
    expect(
      await prepSetAddressChoicePreflight(ctx, { document_ref: docId(c), choice: "verified", address_id: "addr-other" }),
    ).toMatchObject({ error: { code: "address_choice_stale" } })
    expect(
      await prepSetAddressChoicePreflight(ctx, { document_ref: docId(c), choice: "nope" as "order" }),
    ).toMatchObject({ error: { code: "invalid_choice" } })
  })
})
