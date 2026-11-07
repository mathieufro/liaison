// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B8 — Mutation handler tests.
//
// We exercise the shared mutation flow (refunds_create) end-to-end:
//   - calls Shopify GraphQL with the expected variables
//   - emits a `shopify:refund_created` event with the payload
//   - throws when Shopify returns userErrors
// Plus a coverage spot-check on draft-orders, fulfillments, and customer
// consent so a future bundle-shape regression bites here too.
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { withTimer } from "./lib/timers.testutil"
import {
  channelName,
  createEnforcingEmit,
  loadDeclaredEmits,
  type RecordedEmit as EmittedEvent,
} from "./lib/emit.testutil"
import {
  canonicaliseBasicCodeDiscount,
  discounts_create_preflight,
  canonicaliseBasicCodeDiscountPartial,
  canonicalizeProductInput,
  customers_tag,
  customers_update,
  discounts_create,
  discounts_bulk_create,
  discounts_update,
  draft_orders_complete,
  draft_orders_create,
  draft_orders_delete,
  draft_orders_send,
  draft_orders_update,
  fulfillments_create,
  fulfillments_update_tracking,
  inventory_adjust,
  inventory_set_on_hand,
  metafields_delete,
  metafields_set,
  normalizeDraftOrderInput,
  normalizeEmailInput,
  normalizeInventoryAdjustInput,
  normalizeInventorySetOnHandInput,
  normalizeTrackingInfo,
  withApprovalProtocol,
  order_cancel,
  order_note_set,
  order_update,
  products_create,
  products_merge,
  products_publication_targets,
  products_publish,
  products_unpublish,
  products_update,
  refunds_create,
  refunds_create_preflight,
  products_merge_preflight,
  draft_orders_create_preflight,
  fulfillments_create_preflight,
  variants_update_preflight,
  variants_delete_preflight,
  order_update_preflight,
  products_update_preflight,
  inventory_adjust_preflight,
  products_unpublish_preflight,
  products_delete_preflight,
  order_cancel_preflight,
  draft_orders_delete_preflight,
  discounts_delete_preflight,
  discounts_update_preflight,
  returns_approve_preflight,
  returns_decline_preflight,
  returns_close_preflight,
  returns_refund_preflight,
  fulfillments_cancel_preflight,
  inventory_set_on_hand_preflight,
  customers_update_preflight,
  customers_tag_preflight,
  products_publish_preflight,
  resolveMutationInput,
  returns_decline,
  variants_create,
  variants_update,
} from "./mutations"

describe("products_create — accepts bundled variant SKU/price (2-step create + default-variant set)", () => {
  it("creates the product (stripping variants) then sets the default variant's SKU/price via bulk update", async () => {
    // The natural ask "create product X with SKU RAL-48 at 749" bundles variant data, which
    // ProductInput (API 2024-04+) rejects. products_create strips it, creates the product, then
    // applies the SKU/price to the auto-created default variant.
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productCreate: { product: { id: "gid://shopify/Product/1", title: "Kestrel 8", status: "DRAFT", variants: { edges: [{ node: { id: "gid://shopify/ProductVariant/9" } }] } }, userErrors: [] } } },
        { data: { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/9", sku: "RAL-48", price: "749.00" }], userErrors: [] } } },
      ],
    })
    await products_create({ input: { title: "Kestrel 8", status: "DRAFT", variants: [{ sku: "RAL-48", price: 749 }] } }, ctx)
    // 1st call: productCreate with NO variants field on the ProductInput.
    const create = JSON.parse(calls[0]!.body) as { query: string; variables: { input: Record<string, unknown> } }
    expect(create.query).toContain("productCreate")
    expect(create.variables.input.variants).toBeUndefined()
    expect(create.variables.input.title).toBe("Kestrel 8")
    // 2nd call: productVariantsBulkUpdate sets the default variant's price + sku (under inventoryItem).
    const upd = JSON.parse(calls[1]!.body) as { query: string; variables: { productId: string; variants: Array<Record<string, unknown>> } }
    expect(upd.query).toContain("productVariantsBulkUpdate")
    expect(upd.variables.productId).toBe("gid://shopify/Product/1")
    expect(upd.variables.variants[0]!.id).toBe("gid://shopify/ProductVariant/9")
    expect(upd.variables.variants[0]!.price).toBe("749") // String(749) — Shopify accepts integer-string prices
    expect((upd.variables.variants[0]!.inventoryItem as { sku: string }).sku).toBe("RAL-48")
  })

  it("does only the productCreate when no variant data is bundled", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productCreate: { product: { id: "gid://shopify/Product/2", title: "Plain", status: "ACTIVE", variants: { edges: [{ node: { id: "gid://shopify/ProductVariant/22" } }] } }, userErrors: [] } } },
      ],
    })
    await products_create({ input: { title: "Plain", status: "ACTIVE" } }, ctx)
    expect(calls).toHaveLength(1) // no second variant-update call
  })
})

describe("products_merge — synthetic gated merge: consolidate/reassign + redirect + delete (BL-262)", () => {
  // Two listings of the SAME product (a migration duplicate) each have a single implicit-default variant.
  // CRITICAL ROOT-CAUSE REGRESSION (the live-gate 422): a single-default-option product has exactly ONE
  // variant slot, so `productVariantsBulkCreate` of a 2nd variant 422s "The variant 'Default Title'
  // already exists" — which on the live gate became an UNVERIFIABLE gated execution → verdict-override
  // fail. The fix: when the survivor is single-default, CONSOLIDATE the duplicate's on-hand inventory onto
  // the survivor's existing variant (don't mint a spurious 2nd variant) — the "don't split inventory" the
  // user asked for. Only a genuine multi-option survivor takes a recreated variant (with optionValues).
  const SURVIVOR = "gid://shopify/Product/100"
  const DUPLICATE = "gid://shopify/Product/200"
  const SURVIVOR_INV = "gid://shopify/InventoryItem/9001"
  const LOC = "gid://shopify/Location/1"

  // Single-default survivor: one "Default Title" variant, stocked 12 on-hand at LOC.
  const singleDefaultSurvivorRead = {
    data: {
      product: {
        id: SURVIVOR,
        title: "Kestrel 6 Recorder",
        handle: "kestrel-6-recorder",
        hasOnlyDefaultVariant: true,
        options: [{ name: "Title", optionValues: [{ name: "Default Title" }] }],
        variants: {
          edges: [
            {
              node: {
                id: "gid://shopify/ProductVariant/1001",
                sku: "RAL-44-A",
                price: "699.00",
                inventoryQuantity: 12,
                selectedOptions: [{ name: "Title", value: "Default Title" }],
                inventoryItem: {
                  id: SURVIVOR_INV,
                  inventoryLevels: { edges: [{ node: { location: { id: LOC }, quantities: [{ name: "on_hand", quantity: 12 }] } }] },
                },
              },
            },
          ],
        },
      },
    },
  }
  // Single-default duplicate: one "Default Title" variant, DIFFERENT SKU, stocked 5 on-hand at the same LOC.
  const singleDefaultDuplicateRead = {
    data: {
      product: {
        id: DUPLICATE,
        title: "Kestrel 6 Recorder",
        handle: "kestrel-6-recorder-1",
        hasOnlyDefaultVariant: true,
        options: [{ name: "Title", optionValues: [{ name: "Default Title" }] }],
        variants: {
          edges: [
            {
              node: {
                id: "gid://shopify/ProductVariant/2001",
                sku: "RAL-44-B",
                price: "699.00",
                inventoryQuantity: 5,
                selectedOptions: [{ name: "Title", value: "Default Title" }],
                inventoryItem: {
                  id: "gid://shopify/InventoryItem/9002",
                  inventoryLevels: { edges: [{ node: { location: { id: LOC }, quantities: [{ name: "on_hand", quantity: 5 }] } }] },
                },
              },
            },
          ],
        },
      },
    },
  }

  it("single-default survivor: CONSOLIDATES the duplicate's on-hand onto the survivor (no productVariantsBulkCreate — the 'Default Title already exists' 422), then redirects + deletes + emits product:merged", async () => {
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        singleDefaultSurvivorRead,
        singleDefaultDuplicateRead,
        // inventory_adjust first reads the survivor's live on_hand to fill changeFromQuantity…
        { data: { inventoryItem: { inventoryLevel: { quantities: [{ name: "on_hand", quantity: 12 }] } } } },
        // …then the adjust itself (delta +5).
        { data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1", reason: "movement_created", changes: [{ delta: 5, name: "on_hand", location: { id: LOC } }] }, userErrors: [] } } },
        { data: { urlRedirectCreate: { urlRedirect: { id: "gid://shopify/UrlRedirect/77", path: "/products/kestrel-6-recorder-1", target: "/products/kestrel-6-recorder" }, userErrors: [] } } },
        { data: { productDelete: { deletedProductId: DUPLICATE, userErrors: [] } } },
      ],
    })
    const out = (await products_merge({ survivorId: SURVIVOR, duplicateId: DUPLICATE }, ctx)) as {
      deletedProductId: string
      variantsConsolidated: { sku: string; onHandAdded: number }[]
      variantsReassigned: { sku: string }[]
      redirect: { path: string; target: string } | null
    }

    // The defect guard: NO productVariantsBulkCreate is ever sent for a single-default survivor.
    const bulkCreateCall = calls.find((c) => c.body.includes("productVariantsBulkCreate"))
    expect(bulkCreateCall, "single-default survivor must NOT bulk-create a 2nd variant (the Default-Title 422)").toBeUndefined()

    // The consolidation: inventoryAdjustQuantities adds the duplicate's +5 on_hand onto the survivor item @LOC.
    const adjustCall = calls.find((c) => c.body.includes("inventoryAdjustQuantities"))
    expect(adjustCall, "must consolidate the duplicate's on-hand via inventoryAdjustQuantities").toBeTruthy()
    const adjust = JSON.parse(adjustCall!.body) as { variables: { input: { name: string; changes: Array<{ inventoryItemId: string; locationId: string; delta: number; changeFromQuantity?: number }> } } }
    expect(adjust.variables.input.name).toBe("on_hand")
    expect(adjust.variables.input.changes[0]!.inventoryItemId).toBe(SURVIVOR_INV)
    expect(adjust.variables.input.changes[0]!.locationId).toBe(LOC)
    expect(adjust.variables.input.changes[0]!.delta).toBe(5)
    expect(adjust.variables.input.changes[0]!.changeFromQuantity).toBe(12) // filled from the live survivor on_hand

    // Redirect + delete still happen.
    const redirect = JSON.parse(calls.find((c) => c.body.includes("urlRedirectCreate"))!.body) as { variables: { urlRedirect: { path: string; target: string } } }
    expect(redirect.variables.urlRedirect.path).toBe("/products/kestrel-6-recorder-1")
    expect(redirect.variables.urlRedirect.target).toBe("/products/kestrel-6-recorder")
    const del = JSON.parse(calls.find((c) => c.body.includes("productDelete"))!.body) as { variables: { input: { id: string } } }
    expect(del.variables.input.id).toBe(DUPLICATE)

    // Result + event report the consolidation, not a fabricated reassigned variant.
    expect(out.deletedProductId).toBe(DUPLICATE)
    expect(out.variantsReassigned).toHaveLength(0)
    expect(out.variantsConsolidated).toEqual([{ sku: "RAL-44-B", onHandAdded: 5 }])
    expect(out.redirect).toEqual({ path: "/products/kestrel-6-recorder-1", target: "/products/kestrel-6-recorder" })
    const merged = events.find((e) => e.entity === "product" && e.action === "merged")
    expect(merged, "products_merge must emit product:merged").toBeTruthy()
    expect((merged!.data as { survivor: { id: string } }).survivor.id).toBe(SURVIVOR)
    expect((merged!.data as { duplicate: { id: string } }).duplicate.id).toBe(DUPLICATE)
  })

  it("multi-option survivor: RECREATES the non-overlapping variant carrying its optionValues, then redirects + deletes", async () => {
    // A genuine multi-variant survivor (a "Color" option) CAN take a new variant — recreate it with the
    // duplicate's optionValues so it coexists (this path is mechanically valid; only single-default 422s).
    const multiSurvivorRead = {
      data: {
        product: {
          id: SURVIVOR,
          title: "Kestrel 6 Recorder",
          handle: "kestrel-6-recorder",
          hasOnlyDefaultVariant: false,
          options: [{ name: "Color", optionValues: [{ name: "Black" }] }],
          variants: {
            edges: [
              {
                node: {
                  id: "gid://shopify/ProductVariant/1001",
                  sku: "RAL-44-BLK",
                  price: "699.00",
                  inventoryQuantity: 12,
                  selectedOptions: [{ name: "Color", value: "Black" }],
                  inventoryItem: { id: SURVIVOR_INV, inventoryLevels: { edges: [{ node: { location: { id: LOC }, quantities: [{ name: "on_hand", quantity: 12 }] } }] } },
                },
              },
            ],
          },
        },
      },
    }
    const multiDuplicateRead = {
      data: {
        product: {
          id: DUPLICATE,
          title: "Kestrel 6 Recorder",
          handle: "kestrel-6-recorder-1",
          hasOnlyDefaultVariant: false,
          options: [{ name: "Color", optionValues: [{ name: "Silver" }] }],
          variants: {
            edges: [
              {
                node: {
                  id: "gid://shopify/ProductVariant/2001",
                  sku: "RAL-44-SLV",
                  price: "699.00",
                  inventoryQuantity: 5,
                  selectedOptions: [{ name: "Color", value: "Silver" }],
                  inventoryItem: { id: "gid://shopify/InventoryItem/9002", inventoryLevels: { edges: [{ node: { location: { id: LOC }, quantities: [{ name: "on_hand", quantity: 5 }] } }] } },
                },
              },
            ],
          },
        },
      },
    }
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        multiSurvivorRead,
        multiDuplicateRead,
        { data: { productVariantsBulkCreate: { productVariants: [{ id: "gid://shopify/ProductVariant/3001", sku: "RAL-44-SLV", price: "699.00" }], userErrors: [] } } },
        { data: { urlRedirectCreate: { urlRedirect: { id: "gid://shopify/UrlRedirect/77", path: "/products/kestrel-6-recorder-1", target: "/products/kestrel-6-recorder" }, userErrors: [] } } },
        { data: { productDelete: { deletedProductId: DUPLICATE, userErrors: [] } } },
      ],
    })
    const out = (await products_merge({ survivorId: SURVIVOR, duplicateId: DUPLICATE }, ctx)) as {
      variantsReassigned: { sku: string }[]
      variantsConsolidated: { sku: string }[]
    }
    const create = JSON.parse(calls.find((c) => c.body.includes("productVariantsBulkCreate"))!.body) as { variables: { productId: string; variants: Array<{ inventoryItem?: { sku?: string }; optionValues?: Array<{ name: string; optionName: string }> }> } }
    expect(create.variables.productId).toBe(SURVIVOR)
    expect(create.variables.variants[0]!.inventoryItem?.sku).toBe("RAL-44-SLV")
    // The distinct optionValue (Color=Silver) is carried so the new variant doesn't collide with Black.
    expect(create.variables.variants[0]!.optionValues).toEqual([{ name: "Silver", optionName: "Color" }])
    expect(out.variantsReassigned.map((v) => v.sku)).toEqual(["RAL-44-SLV"])
    expect(out.variantsConsolidated).toHaveLength(0)
  })

  it("rejects a self-merge (survivorId === duplicateId) before any Shopify call", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [] })
    await expect(
      products_merge({ survivorId: SURVIVOR, duplicateId: SURVIVOR }, ctx),
    ).rejects.toThrow(/SAME product|distinct/i)
    expect(calls).toHaveLength(0) // fail fast — no half-merge
  })

  it("requires both ids — a missing duplicateId throws before touching Shopify", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [] })
    await expect(
      products_merge({ survivorId: SURVIVOR }, ctx),
    ).rejects.toThrow(/duplicate product id is required/i)
    expect(calls).toHaveLength(0)
  })

  it("surfaces a genuinely-fatal redirect userError LOUD (never a silent half-merge)", async () => {
    // A redirect userError that is NOT an idempotent 'already taken' (e.g. an invalid path) must throw —
    // not swallow it and report a misleading 'merged' while the redirect silently failed.
    const { ctx } = makeCtx({
      fetchResponses: [
        singleDefaultSurvivorRead,
        singleDefaultDuplicateRead,
        { data: { inventoryItem: { inventoryLevel: { quantities: [{ name: "on_hand", quantity: 12 }] } } } },
        { data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1", changes: [] }, userErrors: [] } } },
        { data: { urlRedirectCreate: { urlRedirect: null, userErrors: [{ field: ["path"], message: "Path is invalid" }] } } },
      ],
    })
    await expect(
      products_merge({ survivorId: SURVIVOR, duplicateId: DUPLICATE }, ctx),
    ).rejects.toThrow(/Path is invalid/i)
  })

  it("redirect leg is IDEMPOTENT: an 'already been taken' create that already points to the survivor is reconciled, not a fail", async () => {
    // A prior partial merge can leave a redirect for the same path. 'Path has already been taken' must NOT
    // 422 the whole merge — the desired end-state (path → survivor) already holds, so the merge proceeds.
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        singleDefaultSurvivorRead,
        singleDefaultDuplicateRead,
        { data: { inventoryItem: { inventoryLevel: { quantities: [{ name: "on_hand", quantity: 12 }] } } } },
        { data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1", changes: [] }, userErrors: [] } } },
        // create reports the path is already taken…
        { data: { urlRedirectCreate: { urlRedirect: null, userErrors: [{ field: ["path"], message: "Path has already been taken" }] } } },
        // …the existing redirect ALREADY targets the survivor → reconcile to success, no update needed.
        { data: { urlRedirects: { edges: [{ node: { id: "gid://shopify/UrlRedirect/55", path: "/products/kestrel-6-recorder-1", target: "/products/kestrel-6-recorder" } }] } } },
        { data: { productDelete: { deletedProductId: DUPLICATE, userErrors: [] } } },
      ],
    })
    const out = (await products_merge({ survivorId: SURVIVOR, duplicateId: DUPLICATE }, ctx)) as { redirect: { path: string; target: string } | null }
    // No urlRedirectUpdate is sent (target already correct), and the merge completes through to delete.
    expect(calls.find((c) => c.body.includes("urlRedirectUpdate")), "no update when the redirect already targets the survivor").toBeUndefined()
    expect(calls.find((c) => c.body.includes("productDelete")), "merge proceeds to delete the duplicate").toBeTruthy()
    expect(out.redirect).toEqual({ path: "/products/kestrel-6-recorder-1", target: "/products/kestrel-6-recorder" })
  })

  it("redirect leg REPOINTS a stale 'already taken' redirect that targets the wrong product onto the survivor", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        singleDefaultSurvivorRead,
        singleDefaultDuplicateRead,
        { data: { inventoryItem: { inventoryLevel: { quantities: [{ name: "on_hand", quantity: 12 }] } } } },
        { data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1", changes: [] }, userErrors: [] } } },
        { data: { urlRedirectCreate: { urlRedirect: null, userErrors: [{ field: ["path"], message: "Path has already been taken" }] } } },
        // the existing redirect points SOMEWHERE ELSE → must be updated to the survivor.
        { data: { urlRedirects: { edges: [{ node: { id: "gid://shopify/UrlRedirect/55", path: "/products/kestrel-6-recorder-1", target: "/products/some-old-product" } }] } } },
        { data: { urlRedirectUpdate: { urlRedirect: { id: "gid://shopify/UrlRedirect/55", path: "/products/kestrel-6-recorder-1", target: "/products/kestrel-6-recorder" }, userErrors: [] } } },
        { data: { productDelete: { deletedProductId: DUPLICATE, userErrors: [] } } },
      ],
    })
    await products_merge({ survivorId: SURVIVOR, duplicateId: DUPLICATE }, ctx)
    const upd = JSON.parse(calls.find((c) => c.body.includes("urlRedirectUpdate"))!.body) as { variables: { id: string; urlRedirect: { target: string } } }
    expect(upd.variables.id).toBe("gid://shopify/UrlRedirect/55")
    expect(upd.variables.urlRedirect.target).toBe("/products/kestrel-6-recorder")
  })
})

describe("variants_* use the API-2026 productVariantsBulk* mutations", () => {
  it("variants_create sends productVariantsBulkCreate(productId, variants:[…]) and strips productId from the variant", async () => {
    // API 2026-01 removed single productVariantCreate → bulk family (productId arg + variants array).
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productVariantsBulkCreate: { productVariants: [{ id: "gid://shopify/ProductVariant/9", sku: "RAL-48", price: "749.00" }], userErrors: [] } } },
      ],
    })
    await variants_create({ input: { productId: "gid://shopify/Product/1", price: "749.00", inventoryItem: { sku: "RAL-48" } } }, ctx)
    const body = JSON.parse(calls[0]!.body) as { query: string; variables: { productId: string; variants: Array<Record<string, unknown>> } }
    expect(body.query).toContain("productVariantsBulkCreate")
    expect(body.variables.productId).toBe("gid://shopify/Product/1")
    expect(body.variables.variants).toHaveLength(1)
    expect(body.variables.variants[0]!.productId).toBeUndefined() // stripped — not a ProductVariantsBulkInput field
    expect(body.variables.variants[0]!.price).toBe("749.00")
  })

  it("variants_update resolves the owning productId from the variant when not supplied", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productVariant: { product: { id: "gid://shopify/Product/7" } } } }, // resolveProductIdForVariant
        { data: { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/9", sku: "X", price: "5.00" }], userErrors: [] } } },
      ],
    })
    await variants_update({ input: { id: "gid://shopify/ProductVariant/9", price: "5.00" } }, ctx)
    const update = JSON.parse(calls[1]!.body) as { query: string; variables: { productId: string; variants: Array<Record<string, unknown>>; key?: unknown } }
    expect(update.query).toContain("productVariantsBulkUpdate")
    expect(update.variables.productId).toBe("gid://shopify/Product/7") // resolved from the variant
    expect(update.variables.variants[0]!.id).toBe("gid://shopify/ProductVariant/9")
    // Admin API 2026-04 REQUIRES the @idempotent directive on productVariantsBulk* (BL-107/BL-104 class).
    expect(update.query).toContain("@idempotent")
    expect(typeof update.variables.key).toBe("string")
  })

  it("variants_update normalizes a flat top-level sku → inventoryItem.sku (ProductVariantsBulkInput drift)", async () => {
    // A weak model (and the natural consolidate-the-variant ask in merge-duplicate-products-cleanup) passes
    // a flat `sku` on the variant. On API 2024-04+ `sku` is NOT a ProductVariantsBulkInput field — it lives
    // under `inventoryItem.sku` — so the raw call 422s ("Field is not defined on ProductVariantsBulkInput")
    // and, in a GATED flow, leaves the approval unverified (forces non-green). The handler must remap it.
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productVariant: { product: { id: "gid://shopify/Product/7" } } } }, // resolveProductIdForVariant
        { data: { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/9", sku: "RAL-44", price: "699.00" }], userErrors: [] } } },
      ],
    })
    await variants_update({ input: { id: "gid://shopify/ProductVariant/9", sku: "RAL-44", price: "699.00" } }, ctx)
    const update = JSON.parse(calls[1]!.body) as { variables: { variants: Array<Record<string, unknown>> } }
    const v = update.variables.variants[0]!
    expect(v.sku).toBeUndefined() // top-level sku removed — not a valid field
    expect((v.inventoryItem as { sku: string }).sku).toBe("RAL-44") // moved under inventoryItem
    expect(v.price).toBe("699.00") // price passes through untouched
  })

  it("variants_update normalizes hs_code → inventoryItem.harmonizedSystemCode (customs round-trip)", async () => {
    // FIELD REGRESSION (prod, 2026-07-20 and again 2026-08-04). The READ path
    // maps inventoryItem.harmonizedSystemCode → hs_code, so an agent that reads a
    // variant, edits hs_code and writes it back sends a field that does NOT exist
    // on ProductVariantsBulkInput. Shopify 422s "Field is not defined on
    // ProductVariantsBulkInput", and in a GATED flow the approval parks at
    // `approving` forever -- five HS-code approvals died exactly this way, twice,
    // and an operator saw the card vanish as if it had succeeded.
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productVariant: { product: { id: "gid://shopify/Product/7" } } } },
        { data: { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/9" }], userErrors: [] } } },
      ],
    })
    await variants_update({ input: { id: "gid://shopify/ProductVariant/9", hs_code: "854370" } }, ctx)
    const update = JSON.parse(calls[1]!.body) as { variables: { variants: Array<Record<string, unknown>> } }
    const v = update.variables.variants[0]!
    expect(v.hs_code).toBeUndefined() // the field that 422s must be gone
    expect((v.inventoryItem as { harmonizedSystemCode: string }).harmonizedSystemCode).toBe("854370")
  })

  it("variants_update normalizes country_of_origin → inventoryItem.countryCodeOfOrigin", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productVariant: { product: { id: "gid://shopify/Product/7" } } } },
        { data: { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/9" }], userErrors: [] } } },
      ],
    })
    await variants_update({ input: { id: "gid://shopify/ProductVariant/9", country_of_origin: "FR" } }, ctx)
    const update = JSON.parse(calls[1]!.body) as { variables: { variants: Array<Record<string, unknown>> } }
    const v = update.variables.variants[0]!
    expect(v.country_of_origin).toBeUndefined()
    expect((v.inventoryItem as { countryCodeOfOrigin: string }).countryCodeOfOrigin).toBe("FR")
  })

  it("variants_update merges customs fields with a caller-supplied inventoryItem instead of clobbering it", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productVariant: { product: { id: "gid://shopify/Product/7" } } } },
        { data: { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/9" }], userErrors: [] } } },
      ],
    })
    await variants_update(
      { input: { id: "gid://shopify/ProductVariant/9", sku: "EMB-ET2", hs_code: "854370", country_of_origin: "FR" } },
      ctx,
    )
    const update = JSON.parse(calls[1]!.body) as { variables: { variants: Array<Record<string, unknown>> } }
    const inv = update.variables.variants[0]!.inventoryItem as Record<string, string>
    // All three land together — sku normalization must not drop the customs keys.
    expect(inv.sku).toBe("EMB-ET2")
    expect(inv.harmonizedSystemCode).toBe("854370")
    expect(inv.countryCodeOfOrigin).toBe("FR")
  })

  it("variants_update leaves an already-correct nested harmonizedSystemCode untouched", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productVariant: { product: { id: "gid://shopify/Product/7" } } } },
        { data: { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/9" }], userErrors: [] } } },
      ],
    })
    // Idempotent: a caller who already sends the correct shape must not have it
    // overwritten by a stale flat value.
    await variants_update(
      { input: { id: "gid://shopify/ProductVariant/9", hs_code: "999999", inventoryItem: { harmonizedSystemCode: "854370" } } },
      ctx,
    )
    const update = JSON.parse(calls[1]!.body) as { variables: { variants: Array<Record<string, unknown>> } }
    const inv = update.variables.variants[0]!.inventoryItem as Record<string, string>
    expect(inv.harmonizedSystemCode).toBe("854370")
    expect(update.variables.variants[0]!.hs_code).toBeUndefined()
  })

  it("variants_update normalizes optionValues:[{value}] → [{name}] (VariantOptionValueInput drift)", async () => {
    // VariantOptionValueInput uses `name`, not `value` — a weak model's `optionValues:[{value:"X"}]` 422s
    // ("Field is not defined on VariantOptionValueInput"). The handler remaps value→name, preserving optionName.
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productVariant: { product: { id: "gid://shopify/Product/7" } } } },
        { data: { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/9" }], userErrors: [] } } },
      ],
    })
    await variants_update(
      { input: { id: "gid://shopify/ProductVariant/9", optionValues: [{ value: "Black", optionName: "Color" }] } },
      ctx,
    )
    const update = JSON.parse(calls[1]!.body) as { variables: { variants: Array<{ optionValues: Array<Record<string, unknown>> }> } }
    const ov = update.variables.variants[0]!.optionValues[0]!
    expect(ov.value).toBeUndefined()
    expect(ov.name).toBe("Black")
    expect(ov.optionName).toBe("Color") // preserved
  })

  it("variants_create normalizes a flat sku and leaves an already-correct inventoryItem.sku untouched", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productVariantsBulkCreate: { productVariants: [{ id: "gid://shopify/ProductVariant/9" }], userErrors: [] } } },
      ],
    })
    await variants_create({ input: { productId: "gid://shopify/Product/1", sku: "RAL-NEW", price: "10.00" } }, ctx)
    const body = JSON.parse(calls[0]!.body) as { variables: { variants: Array<Record<string, unknown>> } }
    const v = body.variables.variants[0]!
    expect(v.sku).toBeUndefined()
    expect((v.inventoryItem as { sku: string }).sku).toBe("RAL-NEW")
  })

  it("variants_update does NOT clobber a caller-supplied inventoryItem.sku with a stray top-level sku", async () => {
    // Idempotence + safety: if the caller already nested the sku correctly, the nested one wins.
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productVariant: { product: { id: "gid://shopify/Product/7" } } } },
        { data: { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/9" }], userErrors: [] } } },
      ],
    })
    await variants_update(
      { input: { id: "gid://shopify/ProductVariant/9", sku: "STRAY", inventoryItem: { sku: "CORRECT", tracked: true } } },
      ctx,
    )
    const update = JSON.parse(calls[1]!.body) as { variables: { variants: Array<Record<string, unknown>> } }
    const v = update.variables.variants[0]!
    expect(v.sku).toBeUndefined()
    expect((v.inventoryItem as { sku: string; tracked: boolean }).sku).toBe("CORRECT")
    expect((v.inventoryItem as { tracked: boolean }).tracked).toBe(true)
  })

  it("inventory_adjust supplies @idempotent + fills changeFromQuantity from the live quantity (BL-105)", async () => {
    // Admin API 2026-04 `inventoryAdjustQuantities` REQUIRES BOTH the @idempotent(key:) directive AND a
    // changeFromQuantity per change (verified live: without @idempotent → "The @idempotent directive is
    // required"; without changeFromQuantity → "must include changeFromQuantity"). The handler reads the
    // current quantity of `name` and fills changeFromQuantity, and passes a deterministic key.
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        // 1st call: live current "available" quantity for the change row.
        { data: { inventoryItem: { inventoryLevel: { quantities: [{ name: "available", quantity: 50 }] } } } },
        // 2nd call: the adjust mutation.
        { data: { inventoryAdjustQuantities: { inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" }, userErrors: [] } } },
      ],
    })
    await inventory_adjust(
      { input: { reason: "correction", changes: [{ inventoryItemId: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/1", delta: 5 }] } },
      ctx,
    )
    const adj = JSON.parse(calls[1]!.body) as {
      query: string
      variables: { input: { name: string; changes: Array<Record<string, unknown>> }; key?: unknown }
    }
    expect(adj.query).toContain("inventoryAdjustQuantities")
    expect(adj.query).toContain("@idempotent")
    expect(typeof adj.variables.key).toBe("string")
    expect(adj.variables.input.changes[0]!.delta).toBe(5)
    expect(adj.variables.input.changes[0]!.changeFromQuantity).toBe(50) // filled from the live read
  })
})

describe("resolveMutationInput — unwrap a weak model's redundant input wrapper", () => {
  it("unwraps a single-key *Input wrapper (the observed products_create failure)", () => {
    // Weak model sent {input: {productInput: {…}}} → Shopify 422'd "Field is not defined on
    // ProductInput". The handler must unwrap to the real ProductInput.
    expect(
      resolveMutationInput({ input: { productInput: { title: "Kestrel 8", descriptionHtml: "<p>x</p>" } } }),
    ).toEqual({ title: "Kestrel 8", descriptionHtml: "<p>x</p>" })
  })
  it("unwraps a redundant nested `input`", () => {
    expect(resolveMutationInput({ input: { input: { title: "X" } } })).toEqual({ title: "X" })
  })
  it("leaves a correct multi-field input untouched", () => {
    const inp = { reason: "correction", setQuantities: [{ inventoryItemId: "i", locationId: "l", quantity: 47 }] }
    expect(resolveMutationInput({ input: inp })).toEqual(inp)
  })
  it("does NOT unwrap a legitimate single-OBJECT field (purchasingEntity) or array fields", () => {
    expect(resolveMutationInput({ input: { purchasingEntity: { customerId: "c" } } })).toEqual({
      purchasingEntity: { customerId: "c" },
    })
    expect(resolveMutationInput({ input: { setQuantities: [{ quantity: 1 }] } })).toEqual({
      setQuantities: [{ quantity: 1 }],
    })
  })
  it("falls back to the params themselves when there is no `input` key (flat shape)", () => {
    expect(resolveMutationInput({ title: "X", descriptionHtml: "y" })).toEqual({ title: "X", descriptionHtml: "y" })
  })
})

describe("canonicalizeProductInput — maps deprecated ProductInput field names onto the API-2026 schema", () => {
  it("canonicalizes a weak model's `bodyHtml` → `descriptionHtml` (the observed launch-publish 422)", () => {
    // Shopify dropped `bodyHtml` from ProductInput (renamed → `descriptionHtml`). A weak model passes the
    // old name and Shopify 422s "Field is not defined on ProductInput … bodyHtml", failing the gated write.
    expect(canonicalizeProductInput({ bodyHtml: "<p>x</p>" })).toEqual({ descriptionHtml: "<p>x</p>" })
  })
  it("also maps the snake_case `body_html`", () => {
    expect(canonicalizeProductInput({ title: "Kestrel 8", body_html: "<p>desc</p>" })).toEqual({
      title: "Kestrel 8",
      descriptionHtml: "<p>desc</p>",
    })
  })
  it("leaves a correct `descriptionHtml` untouched and never clobbers it with a stray alias", () => {
    expect(canonicalizeProductInput({ descriptionHtml: "<p>real</p>", bodyHtml: "<p>stale</p>" })).toEqual({
      descriptionHtml: "<p>real</p>",
    })
    expect(canonicalizeProductInput({ title: "X", descriptionHtml: "<p>y</p>" })).toEqual({
      title: "X",
      descriptionHtml: "<p>y</p>",
    })
  })

  it("ALLOWLIST-STRIPS deprecated/invalid ProductInput fields (the recurring weak-model 422 class)", () => {
    // The flash-lite agent intermittently decorates ProductInput with deprecated/invalid extras —
    // `productCategory` (deprecated → dropped; the current field is `category`, a taxonomy GID we can't
    // value-map), `published` (REST-era), a hallucinated `bogusField`. Each alone 422s the whole gated
    // write. The allowlist keeps the valid core (canonicalizing bodyHtml) and drops the rest.
    expect(
      canonicalizeProductInput({
        title: "X",
        bodyHtml: "y",
        productCategory: "Synthesizers",
        published: true,
        bogusField: 1,
      }),
    ).toEqual({ title: "X", descriptionHtml: "y" })
  })
  it("keeps every CONFIRMED-valid ProductInput field (does not over-strip)", () => {
    const valid = {
      id: "gid://shopify/Product/1",
      title: "Kestrel 8",
      descriptionHtml: "<p>d</p>",
      handle: "kestrel-8",
      productType: "Synth",
      vendor: "RAL",
      tags: ["launch"],
      status: "DRAFT",
      category: "gid://shopify/TaxonomyCategory/ae-2-8",
      seo: { title: "t", description: "d" },
      metafields: [{ namespace: "x", key: "y", value: "z", type: "single_line_text_field" }],
    }
    expect(canonicalizeProductInput({ ...valid })).toEqual(valid)
  })

  it("products_create sends `descriptionHtml` to Shopify when the agent passed `bodyHtml`", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productCreate: { product: { id: "gid://shopify/Product/1", title: "Kestrel 8", status: "DRAFT", variants: { edges: [] } }, userErrors: [] } } },
      ],
    })
    await products_create({ input: { title: "Kestrel 8", status: "DRAFT", bodyHtml: "<p>v2.5 Studio Bundle</p>" } }, ctx)
    const create = JSON.parse(calls[0]!.body) as { variables: { input: Record<string, unknown> } }
    expect(create.variables.input.descriptionHtml).toBe("<p>v2.5 Studio Bundle</p>")
    expect(create.variables.input.bodyHtml).toBeUndefined()
  })

  it("products_create strips a stray `productCategory` but KEEPS the bundled variant SKU/price", async () => {
    // Regression for the ordering: the variant spec must be extracted BEFORE the allowlist runs, so a
    // create that bundles BOTH a stray invalid ProductInput field AND variant sku/price still applies the
    // variant to the default variant (2nd call) while the stray field is dropped from the ProductInput.
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { productCreate: { product: { id: "gid://shopify/Product/1", title: "Kestrel 8", status: "DRAFT", variants: { edges: [{ node: { id: "gid://shopify/ProductVariant/9" } }] } }, userErrors: [] } } },
        { data: { productVariantsBulkUpdate: { productVariants: [{ id: "gid://shopify/ProductVariant/9" }], userErrors: [] } } },
      ],
    })
    await products_create({ input: { title: "Kestrel 8", status: "DRAFT", productCategory: "Synthesizers", variants: [{ sku: "RAL-48", price: 749 }] } }, ctx)
    const create = JSON.parse(calls[0]!.body) as { variables: { input: Record<string, unknown> } }
    expect(create.variables.input.productCategory).toBeUndefined() // stray invalid field stripped
    expect(create.variables.input.variants).toBeUndefined() // variant keys not on ProductInput
    expect(create.variables.input.title).toBe("Kestrel 8")
    // 2nd call still applies the bundled variant sku/price.
    const upd = JSON.parse(calls[1]!.body) as { variables: { variants: Array<Record<string, unknown>> } }
    expect((upd.variables.variants[0]!.inventoryItem as { sku: string }).sku).toBe("RAL-48")
    expect(upd.variables.variants[0]!.price).toBe("749")
  })
})

describe("returns_decline — declineReason is an enum, free text is coerced to OTHER", () => {
  const declineResp = { data: { returnDeclineRequest: { return: { id: "gid://shopify/Return/1", status: "DECLINED" }, userErrors: [] } } }

  it("coerces a free-text declineReason to OTHER (the agent's human sentence would otherwise 422)", async () => {
    // The agent naturally passes a human sentence; Shopify's ReturnDeclineRequestInput.declineReason
    // is an enum, so an unmapped value fails the mutation. We must send a valid enum.
    const { ctx, calls } = makeCtx({ fetchResponses: [declineResp] })
    await returns_decline({ id: "gid://shopify/Return/1", declineReason: "Warranty period of 2 years has expired. We offer a goodwill repair instead." }, ctx)
    const body = JSON.parse(calls[0]!.body) as { variables: { input: { declineReason: string } } }
    expect(body.variables.input.declineReason).toBe("OTHER")
  })

  it("passes a valid enum value through unchanged", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [declineResp] })
    await returns_decline({ id: "gid://shopify/Return/1", declineReason: "RETURN_PERIOD_ENDED" }, ctx)
    const body = JSON.parse(calls[0]!.body) as { variables: { input: { declineReason: string } } }
    expect(body.variables.input.declineReason).toBe("RETURN_PERIOD_ENDED")
  })

  it("defaults to OTHER when no declineReason is given", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [declineResp] })
    await returns_decline({ id: "gid://shopify/Return/1" }, ctx)
    const body = JSON.parse(calls[0]!.body) as { variables: { input: { declineReason: string } } }
    expect(body.variables.input.declineReason).toBe("OTHER")
  })
})


describe("fulfillments_create — resolves orderId to the order's open fulfillment orders", () => {
  // Regression: fulfillmentCreateV2 takes lineItemsByFulfillmentOrder, NOT orderId — passing the agent's
  // natural { orderId } straight through 422s ("Field is not defined on FulfillmentV2Input"). The handler
  // must resolve the order's OPEN fulfillment orders and build the valid input.
  const orderFOs = {
    data: {
      order: {
        id: "gid://shopify/Order/1056",
        fulfillmentOrders: { nodes: [{ id: "gid://shopify/FulfillmentOrder/9001", status: "OPEN" }] },
      },
    },
  }
  const fulfillmentCreated = {
    data: {
      fulfillmentCreateV2: {
        fulfillment: { id: "gid://shopify/Fulfillment/1", status: "SUCCESS", trackingInfo: [] },
        userErrors: [],
      },
    },
  }

  it("builds lineItemsByFulfillmentOrder from the order's open FOs when given orderId", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [orderFOs, fulfillmentCreated] })
    await fulfillments_create({ fulfillment: { orderId: "gid://shopify/Order/1056" } }, ctx)
    expect(calls.length).toBe(2) // FO lookup, then the mutation
    const mut = JSON.parse(calls[1]!.body) as {
      variables: { fulfillment: { lineItemsByFulfillmentOrder?: Array<{ fulfillmentOrderId: string }>; orderId?: string } }
    }
    expect(mut.variables.fulfillment.lineItemsByFulfillmentOrder).toEqual([
      { fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001" },
    ])
    expect(mut.variables.fulfillment.orderId).toBeUndefined() // the invalid field must NOT be sent
  })

  it("accepts orderId at the top level too", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [orderFOs, fulfillmentCreated] })
    await fulfillments_create({ orderId: "gid://shopify/Order/1056" }, ctx)
    const mut = JSON.parse(calls[1]!.body) as {
      variables: { fulfillment: { lineItemsByFulfillmentOrder?: Array<{ fulfillmentOrderId: string }> } }
    }
    expect(mut.variables.fulfillment.lineItemsByFulfillmentOrder).toEqual([
      { fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001" },
    ])
  })

  // Regression, prod 2026-09-16: boxtal's auto fulfillment passed the BARE NUMERIC order id it holds
  // (Shopify's REST webhooks deliver that shape, and it is what prep_meta persists). The FO lookup
  // binds it to a GraphQL `ID!`, which Shopify rejects outright with "Variable $id of type ID! was
  // provided invalid value", so every parcel shipped that day left its order unfulfilled and its
  // customer without a tracking mail. The numeric form must be normalized here, at the one place
  // every fulfillment path funnels through.
  it("normalizes a bare numeric orderId to the gid form the FO lookup requires", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [orderFOs, fulfillmentCreated] })
    await fulfillments_create({ orderId: "1056" }, ctx)
    const lookup = JSON.parse(calls[0]!.body) as { variables: { id: string } }
    expect(lookup.variables.id).toBe("gid://shopify/Order/1056")
    const mut = JSON.parse(calls[1]!.body) as {
      variables: { fulfillment: { lineItemsByFulfillmentOrder?: Array<{ fulfillmentOrderId: string }> } }
    }
    expect(mut.variables.fulfillment.lineItemsByFulfillmentOrder).toEqual([
      { fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001" },
    ])
  })

  it("leaves an orderId already in gid form untouched", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [orderFOs, fulfillmentCreated] })
    await fulfillments_create({ orderId: "gid://shopify/Order/1056" }, ctx)
    const lookup = JSON.parse(calls[0]!.body) as { variables: { id: string } }
    expect(lookup.variables.id).toBe("gid://shopify/Order/1056")
  })

  it("passes an explicit lineItemsByFulfillmentOrder through unchanged (no FO lookup)", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [fulfillmentCreated] })
    await fulfillments_create(
      { fulfillment: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/7" }] } },
      ctx,
    )
    expect(calls.length).toBe(1) // no FO lookup needed
    const mut = JSON.parse(calls[0]!.body) as {
      variables: { fulfillment: { lineItemsByFulfillmentOrder: Array<{ fulfillmentOrderId: string }> } }
    }
    expect(mut.variables.fulfillment.lineItemsByFulfillmentOrder).toEqual([
      { fulfillmentOrderId: "gid://shopify/FulfillmentOrder/7" },
    ])
  })

  it("errors clearly when the order has no OPEN fulfillment orders", async () => {
    const noFOs = { data: { order: { id: "gid://shopify/Order/1056", fulfillmentOrders: { nodes: [] } } } }
    const { ctx } = makeCtx({ fetchResponses: [noFOs] })
    await expect(fulfillments_create({ orderId: "gid://shopify/Order/1056" }, ctx)).rejects.toThrow(
      /no OPEN fulfillment orders/i,
    )
  })

  // Regression (BL-247 / marco-reconcile gate run 3): the agent passed trackingInfo with a `carrier` field
  // (the natural word — Boxtal/the manifest call it "carrier"). FulfillmentTrackingInput has NO `carrier`
  // field (it is `company`), so fulfillmentCreateV2 422'd ("Field is not defined on FulfillmentTrackingInput
  // … trackingInfo.carrier") — a GATED action that EXECUTED to a non-2xx → verdict-override non-green. The
  // handler must normalize the alias onto the real schema in BOTH the resolved-orderId and pre-built paths.
  it("normalizes trackingInfo.carrier → company (resolved-orderId path) so the gated write never 422s", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [orderFOs, fulfillmentCreated] })
    await fulfillments_create(
      {
        orderId: "gid://shopify/Order/1056",
        fulfillment: {
          orderId: "gid://shopify/Order/1056",
          trackingInfo: { carrier: "Mondial Relay", trackingNumber: "MR-123", trackingUrl: "https://t/MR-123" },
        },
      },
      ctx,
    )
    const mut = JSON.parse(calls[1]!.body) as {
      variables: { fulfillment: { trackingInfo?: Record<string, unknown> } }
    }
    const ti = mut.variables.fulfillment.trackingInfo
    expect(ti).toEqual({ company: "Mondial Relay", number: "MR-123", url: "https://t/MR-123" })
    // The invalid raw aliases must NOT reach Shopify.
    expect(ti).not.toHaveProperty("carrier")
    expect(ti).not.toHaveProperty("trackingNumber")
    expect(ti).not.toHaveProperty("trackingUrl")
  })

  it("normalizes trackingInfo on the pre-built lineItemsByFulfillmentOrder path too", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [fulfillmentCreated] })
    await fulfillments_create(
      {
        fulfillment: {
          lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/7" }],
          trackingInfo: { carrier: "Colissimo", number: "CL-9" },
        },
      },
      ctx,
    )
    const mut = JSON.parse(calls[0]!.body) as {
      variables: { fulfillment: { trackingInfo?: Record<string, unknown> } }
    }
    expect(mut.variables.fulfillment.trackingInfo).toEqual({ company: "Colissimo", number: "CL-9" })
  })

  it("normalizes fulfillments_update_tracking's carrier alias too", async () => {
    const updated = {
      data: {
        fulfillmentTrackingInfoUpdateV2: {
          fulfillment: { id: "gid://shopify/Fulfillment/1", status: "SUCCESS", trackingInfo: [] },
          userErrors: [],
        },
      },
    }
    const { ctx, calls } = makeCtx({ fetchResponses: [updated] })
    await fulfillments_update_tracking(
      {
        fulfillmentId: "gid://shopify/Fulfillment/1",
        trackingInfoInput: { carrier: "Chronopost", trackingNumber: "CH-7" },
      },
      ctx,
    )
    const mut = JSON.parse(calls[0]!.body) as {
      variables: { trackingInfoInput: Record<string, unknown> }
    }
    expect(mut.variables.trackingInfoInput).toEqual({ company: "Chronopost", number: "CH-7" })
  })
})

describe("fulfillments_create — truthful PARTIAL fulfillment via friendly lineItems", () => {
  // Fixture helper: one FO line item node as the resolver query returns it.
  const foLine = (id: string, remaining: number, total: number, liId: string, sku: string | null, title: string) => ({
    id,
    remainingQuantity: remaining,
    totalQuantity: total,
    lineItem: { id: liId, sku, title },
  })
  const singleFO = {
    data: {
      order: {
        id: "gid://shopify/Order/1056",
        fulfillmentOrders: {
          nodes: [
            {
              id: "gid://shopify/FulfillmentOrder/9001",
              status: "OPEN",
              lineItems: {
                nodes: [
                  foLine("gid://shopify/FulfillmentOrderLineItem/1", 3, 5, "gid://shopify/LineItem/11", "KS6-44", "Kestrel 6"),
                  foLine("gid://shopify/FulfillmentOrderLineItem/2", 2, 2, "gid://shopify/LineItem/12", "CASE-1", "Case"),
                ],
              },
            },
          ],
        },
      },
    },
  }
  const multiFO = {
    data: {
      order: {
        id: "gid://shopify/Order/1056",
        fulfillmentOrders: {
          nodes: [
            {
              id: "gid://shopify/FulfillmentOrder/9001",
              status: "OPEN",
              lineItems: {
                nodes: [foLine("gid://shopify/FulfillmentOrderLineItem/1", 2, 5, "gid://shopify/LineItem/11", "KS6-44", "Kestrel 6")],
              },
            },
            {
              id: "gid://shopify/FulfillmentOrder/9002",
              status: "OPEN",
              lineItems: {
                nodes: [foLine("gid://shopify/FulfillmentOrderLineItem/3", 3, 3, "gid://shopify/LineItem/11", "KS6-44", "Kestrel 6")],
              },
            },
          ],
        },
      },
    },
  }
  const fulfillmentCreated = {
    data: {
      fulfillmentCreateV2: {
        fulfillment: { id: "gid://shopify/Fulfillment/1", status: "SUCCESS", trackingInfo: [] },
        userErrors: [],
      },
    },
  }

  it("baseline: plain orderId still fulfills all open FOs wholesale (no per-line quantities)", async () => {
    const orderFOs = {
      data: {
        order: {
          id: "gid://shopify/Order/1056",
          fulfillmentOrders: { nodes: [{ id: "gid://shopify/FulfillmentOrder/9001", status: "OPEN" }] },
        },
      },
    }
    const { ctx, calls } = makeCtx({ fetchResponses: [orderFOs, fulfillmentCreated] })
    await fulfillments_create({ orderId: "gid://shopify/Order/1056" }, ctx)
    const mut = JSON.parse(calls[1]!.body) as {
      variables: { fulfillment: { lineItemsByFulfillmentOrder: Array<Record<string, unknown>> } }
    }
    // Wholesale: whole-FO entries, NO fulfillmentOrderLineItems quantities in the payload.
    expect(mut.variables.fulfillment.lineItemsByFulfillmentOrder).toEqual([
      { fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001" },
    ])
  })

  // The partial branch runs its own FO lookup, so it needs the same normalization: a boxtal batch
  // shipment (line_quantities set) takes THIS path with the bare numeric id from prep_meta.
  it("normalizes a bare numeric orderId on the partial path too", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [singleFO, fulfillmentCreated] })
    await fulfillments_create({ orderId: "1056", lineItems: [{ sku: "KS6-44", quantity: 2 }] }, ctx)
    const lookup = JSON.parse(calls[0]!.body) as { variables: { id: string } }
    expect(lookup.variables.id).toBe("gid://shopify/Order/1056")
  })

  it("maps a sku + quantity to the correct FO line item id (leaving the rest unfulfilled)", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [singleFO, fulfillmentCreated] })
    await fulfillments_create(
      { orderId: "gid://shopify/Order/1056", lineItems: [{ sku: "KS6-44", quantity: 2 }] },
      ctx,
    )
    const mut = JSON.parse(calls[1]!.body) as {
      variables: { fulfillment: { lineItemsByFulfillmentOrder: Array<Record<string, unknown>> } }
    }
    expect(mut.variables.fulfillment.lineItemsByFulfillmentOrder).toEqual([
      {
        fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001",
        fulfillmentOrderLineItems: [{ id: "gid://shopify/FulfillmentOrderLineItem/1", quantity: 2 }],
      },
    ])
  })

  it("maps by explicit orderLineItemId when sku is absent", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [singleFO, fulfillmentCreated] })
    await fulfillments_create(
      { orderId: "gid://shopify/Order/1056", lineItems: [{ orderLineItemId: "gid://shopify/LineItem/12", quantity: 1 }] },
      ctx,
    )
    const mut = JSON.parse(calls[1]!.body) as {
      variables: { fulfillment: { lineItemsByFulfillmentOrder: Array<Record<string, unknown>> } }
    }
    expect(mut.variables.fulfillment.lineItemsByFulfillmentOrder).toEqual([
      {
        fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001",
        fulfillmentOrderLineItems: [{ id: "gid://shopify/FulfillmentOrderLineItem/2", quantity: 1 }],
      },
    ])
  })

  it("splits a quantity across multiple fulfillment orders", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [multiFO, fulfillmentCreated] })
    await fulfillments_create(
      { orderId: "gid://shopify/Order/1056", lineItems: [{ sku: "KS6-44", quantity: 4 }] },
      ctx,
    )
    const mut = JSON.parse(calls[1]!.body) as {
      variables: { fulfillment: { lineItemsByFulfillmentOrder: Array<Record<string, unknown>> } }
    }
    expect(mut.variables.fulfillment.lineItemsByFulfillmentOrder).toEqual([
      {
        fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001",
        fulfillmentOrderLineItems: [{ id: "gid://shopify/FulfillmentOrderLineItem/1", quantity: 2 }],
      },
      {
        fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9002",
        fulfillmentOrderLineItems: [{ id: "gid://shopify/FulfillmentOrderLineItem/3", quantity: 2 }],
      },
    ])
  })

  it("errors clearly when quantity exceeds the remaining quantity", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [singleFO] })
    await expect(
      fulfillments_create({ orderId: "gid://shopify/Order/1056", lineItems: [{ sku: "KS6-44", quantity: 9 }] }, ctx),
    ).rejects.toThrow(/exceeds.*remaining/i)
    expect(calls).toHaveLength(1) // no mutation was attempted
  })

  it("errors clearly on an unknown sku (no partial guessing)", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [singleFO] })
    await expect(
      fulfillments_create({ orderId: "gid://shopify/Order/1056", lineItems: [{ sku: "NOPE-1", quantity: 1 }] }, ctx),
    ).rejects.toThrow(/NOPE-1/)
    expect(calls).toHaveLength(1)
  })

  it("errors on an ambiguous sku (two distinct order line items share it) and asks for orderLineItemId", async () => {
    const ambiguous = {
      data: {
        order: {
          id: "gid://shopify/Order/1056",
          fulfillmentOrders: {
            nodes: [
              {
                id: "gid://shopify/FulfillmentOrder/9001",
                status: "OPEN",
                lineItems: {
                  nodes: [
                    foLine("gid://shopify/FulfillmentOrderLineItem/1", 1, 1, "gid://shopify/LineItem/11", "DUP-1", "A"),
                    foLine("gid://shopify/FulfillmentOrderLineItem/2", 1, 1, "gid://shopify/LineItem/12", "DUP-1", "B"),
                  ],
                },
              },
            ],
          },
        },
      },
    }
    const { ctx } = makeCtx({ fetchResponses: [ambiguous] })
    await expect(
      fulfillments_create({ orderId: "gid://shopify/Order/1056", lineItems: [{ sku: "DUP-1", quantity: 1 }] }, ctx),
    ).rejects.toThrow(/orderLineItemId/)
  })

  it("requires an orderId alongside lineItems", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    await expect(fulfillments_create({ lineItems: [{ sku: "KS6-44", quantity: 1 }] }, ctx)).rejects.toThrow(/orderId/)
  })

  it("keeps trackingInfo + notifyCustomer on the partial payload", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [singleFO, fulfillmentCreated] })
    await fulfillments_create(
      {
        orderId: "gid://shopify/Order/1056",
        lineItems: [{ sku: "CASE-1", quantity: 1 }],
        fulfillment: { trackingInfo: { carrier: "UPS", trackingNumber: "1Z" }, notifyCustomer: true },
      },
      ctx,
    )
    const mut = JSON.parse(calls[1]!.body) as {
      variables: { fulfillment: Record<string, unknown> }
    }
    expect(mut.variables.fulfillment.trackingInfo).toEqual({ company: "UPS", number: "1Z" })
    expect(mut.variables.fulfillment.notifyCustomer).toBe(true)
  })
})

describe("products_publish: resolves real sales channels, never an empty input", () => {
  // Prod regression: products_publish called with only `{id}` sent `input: []`, which publishes the
  // product NOWHERE, while the approval card claimed "Publishes to the default sales channel".
  const ONLINE = "gid://shopify/Publication/316255928486"
  const HEADLESS = "gid://shopify/Publication/316256092326"
  const POS = "gid://shopify/Publication/316256125094"
  const state = (publishedOn: string[]) => ({
    data: {
      product: {
        id: "gid://shopify/Product/16099791012171",
        title: "Kestrel 6",
        createdAt: "2026-10-01T10:00:00Z",
        resourcePublicationsV2: {
          edges: publishedOn.map((id) => ({ node: { publication: { id }, isPublished: true } })),
        },
      },
      publications: {
        edges: [
          { node: { id: ONLINE, name: "Online Store", catalog: null } },
          { node: { id: HEADLESS, name: "Headless", catalog: null } },
          { node: { id: POS, name: "Point of Sale", catalog: null } },
        ],
      },
    },
  })
  const published = { data: { publishablePublish: { publishable: { __typename: "Product" }, userErrors: [] } } }
  const mutationInput = (calls: Array<{ body: string }>) =>
    (JSON.parse(calls[calls.length - 1]!.body) as { variables: { input: unknown[] } }).variables.input

  it("id only: publishes on every store channel the product is not on yet", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [state([ONLINE]), published] })
    await products_publish({ id: "gid://shopify/Product/16099791012171" }, ctx)
    expect(calls).toHaveLength(2)
    expect(calls[1]!.body).toContain("PublishablePublish")
    expect(mutationInput(calls)).toEqual([{ publicationId: HEADLESS }, { publicationId: POS }])
  })

  it("ignores a fabricated channel id and a Publication gid the store does not have", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [state([]), published] })
    await products_publish(
      {
        id: "gid://shopify/Product/16099791012171",
        input: [{ publicationId: "gid://shopify/Channel/1" }, { publicationId: "gid://shopify/Publication/999" }],
      },
      ctx,
    )
    expect(mutationInput(calls)).toEqual([{ publicationId: ONLINE }, { publicationId: HEADLESS }, { publicationId: POS }])
  })

  it("keeps REAL caller-supplied channels, with their publishDate", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [state([]), published] })
    await products_publish(
      { id: "gid://shopify/Product/16099791012171", input: [{ publicationId: HEADLESS, publishDate: "2026-11-01T09:00:00Z" }] },
      ctx,
    )
    expect(mutationInput(calls)).toEqual([{ publicationId: HEADLESS, publishDate: "2026-11-01T09:00:00Z" }])
  })

  it("refuses (preflight and handler) a product already on every channel, sending no mutation", async () => {
    const all = [ONLINE, HEADLESS, POS]
    const pre = makeCtx({ fetchResponses: [state(all)] })
    const out = await products_publish_preflight({ id: "gid://shopify/Product/16099791012171" }, pre.ctx)
    expect((out as { error: { code: string } }).error.code).toBe("ALREADY_PUBLISHED")
    const run = makeCtx({ fetchResponses: [state(all), published] })
    await expect(products_publish({ id: "gid://shopify/Product/16099791012171" }, run.ctx)).rejects.toThrow(
      /already published on every sales channel/,
    )
    expect(run.calls.some((c) => c.body.includes("PublishablePublish"))).toBe(false)
  })

  it("id only never targets a catalog publication (B2B / market catalog); naming its gid does", async () => {
    const B2B = "gid://shopify/Publication/316256200000"
    const withCatalog = () => {
      const s = state([ONLINE])
      s.data.publications.edges.push({
        node: { id: B2B, name: "Wholesale", catalog: { id: "gid://shopify/CompanyLocationCatalog/7", title: "Wholesale" } },
      } as never)
      return s
    }
    const idOnly = makeCtx({ fetchResponses: [withCatalog(), published] })
    await products_publish({ id: "gid://shopify/Product/16099791012171" }, idOnly.ctx)
    expect(mutationInput(idOnly.calls)).toEqual([{ publicationId: HEADLESS }, { publicationId: POS }])

    const card = makeCtx({ fetchResponses: [withCatalog()] })
    const out = (await products_publication_targets({ id: "gid://shopify/Product/16099791012171" }, card.ctx)) as {
      attributes: { publishTargets: Array<{ name: string }> }
    }
    expect(out.attributes.publishTargets.map((t) => t.name)).toEqual(["Headless", "Point of Sale"])

    const named = makeCtx({ fetchResponses: [withCatalog(), published] })
    await products_publish({ id: "gid://shopify/Product/16099791012171", input: [{ publicationId: B2B }] }, named.ctx)
    expect(mutationInput(named.calls)).toEqual([{ publicationId: B2B }])
  })

  it("products_publication_targets names the exact channels publish and unpublish would act on", async () => {
    const { ctx } = makeCtx({ fetchResponses: [state([ONLINE])] })
    const out = (await products_publication_targets({ id: "gid://shopify/Product/16099791012171" }, ctx)) as {
      title: string
      attributes: { publishTargets: Array<{ name: string }>; unpublishTargets: Array<{ name: string }> }
    }
    expect(out.title).toBe("Kestrel 6")
    expect(out.attributes.publishTargets.map((t) => t.name)).toEqual(["Headless", "Point of Sale"])
    expect(out.attributes.unpublishTargets.map((t) => t.name)).toEqual(["Online Store"])
  })
})

describe("products_publish / products_unpublish preflight: refuses a connection without write_publications", () => {
  // Prod: the approved publish failed with "Access denied for publishablePublish field. Required
  // access: `write_publications` access scope." The human must never be asked to approve that.
  const OLD_GRANT = ["write_orders", "write_products", "write_inventory", "read_markets"]

  it("products_publish_preflight refuses with MISSING_SHOPIFY_SCOPE and never calls Shopify", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [], grantedOAuthScopes: OLD_GRANT })
    const out = await products_publish_preflight({ id: "gid://shopify/Product/1" }, ctx)
    const err = (out as { error: { code: string; message: string } }).error
    expect(err.code).toBe("MISSING_SHOPIFY_SCOPE")
    expect(err.message).toContain("write_publications")
    expect(err.message).toContain("Reconnect")
    expect(calls).toHaveLength(0)
  })

  it("products_unpublish_preflight refuses the same way", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [], grantedOAuthScopes: OLD_GRANT })
    const out = await products_unpublish_preflight({ id: "gid://shopify/Product/1" }, ctx)
    expect((out as { error: { code: string } }).error.code).toBe("MISSING_SHOPIFY_SCOPE")
    expect(calls).toHaveLength(0)
  })

  it("passes once the grant holds write_publications (read_publications implied)", async () => {
    const { ctx } = makeCtx({
      grantedOAuthScopes: [...OLD_GRANT, "write_publications"],
      fetchResponses: [
        {
          data: {
            product: { id: "gid://shopify/Product/1", title: "P", resourcePublicationsV2: { edges: [] } },
            publications: { edges: [{ node: { id: "gid://shopify/Publication/1", name: "Online Store" } }] },
          },
        },
      ],
    })
    expect(await products_publish_preflight({ id: "gid://shopify/Product/1" }, ctx)).toEqual({ ok: true })
  })
})

describe("products_unpublish — resolves real publication ids (never 422s on a fabricated channel id)", () => {
  // Regression (ines-launch-day-stockout-crisis-comms gate): `publishableUnpublish` requires
  // `input: [{ publicationId }]` — sales channels the agent has NO way to know, so a weak model
  // fabricated `gid://shopify/Channel/1` and the APPROVED gated unpublish 422'd ("Invalid id") →
  // verdict-override non-green. The handler must resolve the product's ACTUAL publications from
  // just the `id`, and ignore a bogus caller-supplied channel id.
  const productPublications = {
    data: {
      product: {
        id: "gid://shopify/Product/15370621976742",
        resourcePublicationsV2: {
          edges: [
            { node: { publication: { id: "gid://shopify/Publication/316255928486" }, isPublished: true } },
            { node: { publication: { id: "gid://shopify/Publication/316256092326" }, isPublished: true } },
          ],
        },
      },
      publications: {
        edges: [
          { node: { id: "gid://shopify/Publication/316255928486" } },
          { node: { id: "gid://shopify/Publication/316256092326" } },
          { node: { id: "gid://shopify/Publication/316256125094" } },
        ],
      },
    },
  }
  const unpublished = {
    data: { publishableUnpublish: { publishable: { __typename: "Product" }, userErrors: [] } },
  }

  it("resolves the product's current publications when called with only an id", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [productPublications, unpublished] })
    await products_unpublish({ id: "gid://shopify/Product/15370621976742" }, ctx)
    expect(calls.length).toBe(2) // publication lookup, then the unpublish mutation
    const mut = JSON.parse(calls[1]!.body) as {
      variables: { id: string; input: Array<{ publicationId: string }> }
    }
    expect(mut.variables.input).toEqual([
      { publicationId: "gid://shopify/Publication/316255928486" },
      { publicationId: "gid://shopify/Publication/316256092326" },
    ])
  })

  it("ignores a fabricated channel id (the gid://shopify/Channel/1 422 trap) and resolves real ones", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [productPublications, unpublished] })
    await products_unpublish(
      { id: "gid://shopify/Product/15370621976742", input: [{ publicationId: "gid://shopify/Channel/1" }] },
      ctx,
    )
    expect(calls.length).toBe(2) // the bogus id forces the resolution path
    const mut = JSON.parse(calls[1]!.body) as { variables: { input: Array<{ publicationId: string }> } }
    // The invalid Channel id must NOT reach Shopify; real Publication gids are sent instead.
    expect(mut.variables.input).toEqual([
      { publicationId: "gid://shopify/Publication/316255928486" },
      { publicationId: "gid://shopify/Publication/316256092326" },
    ])
  })

  it("falls back to all store publications when the product is published on none", async () => {
    const onNone = {
      data: {
        product: { id: "gid://shopify/Product/15370621976742", resourcePublicationsV2: { edges: [] } },
        publications: {
          edges: [
            { node: { id: "gid://shopify/Publication/316255928486" } },
            { node: { id: "gid://shopify/Publication/316256125094" } },
          ],
        },
      },
    }
    const { ctx, calls } = makeCtx({ fetchResponses: [onNone, unpublished] })
    await products_unpublish({ id: "gid://shopify/Product/15370621976742" }, ctx)
    const mut = JSON.parse(calls[1]!.body) as { variables: { input: Array<{ publicationId: string }> } }
    expect(mut.variables.input).toEqual([
      { publicationId: "gid://shopify/Publication/316255928486" },
      { publicationId: "gid://shopify/Publication/316256125094" },
    ])
  })

  it("passes REAL caller-supplied Publication gids through unchanged (no resolution lookup)", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [unpublished] })
    await products_unpublish(
      {
        id: "gid://shopify/Product/15370621976742",
        input: [{ publicationId: "gid://shopify/Publication/316255928486" }],
      },
      ctx,
    )
    expect(calls.length).toBe(1) // no publication lookup — the supplied gids are already valid
    const mut = JSON.parse(calls[0]!.body) as { variables: { input: Array<{ publicationId: string }> } }
    expect(mut.variables.input).toEqual([{ publicationId: "gid://shopify/Publication/316255928486" }])
  })
})

describe("normalizeTrackingInfo — maps weak-model tracking aliases onto FulfillmentTrackingInput", () => {
  it("maps carrier/carrierName → company", () => {
    expect(normalizeTrackingInfo({ carrier: "UPS" })).toEqual({ company: "UPS" })
    expect(normalizeTrackingInfo({ carrierName: "DHL" })).toEqual({ company: "DHL" })
  })
  it("maps trackingNumber/tracking_number → number and trackingUrl → url", () => {
    expect(normalizeTrackingInfo({ trackingNumber: "1Z", trackingUrl: "https://u" })).toEqual({
      number: "1Z",
      url: "https://u",
    })
  })
  it("passes an already-correct { company, number, url } through unchanged", () => {
    const t = { company: "Colissimo", number: "CL-1", url: "https://u" }
    expect(normalizeTrackingInfo(t)).toEqual(t)
  })
  it("drops unknown keys (the 422 trap) rather than forwarding them", () => {
    expect(normalizeTrackingInfo({ carrier: "UPS", bogus: "x", trackingCompany: "y" })).toEqual({
      company: "UPS",
    })
  })
  it("coerces a lone string into the array field (numbers/urls)", () => {
    expect(normalizeTrackingInfo({ numbers: "N1" })).toEqual({ numbers: ["N1"] })
  })
  it("an explicit company wins over a carrier alias (first-writer)", () => {
    // company is listed first in the alias table, so it is written before carrier is seen.
    expect(normalizeTrackingInfo({ company: "Real", carrier: "Alias" })).toEqual({ company: "Real" })
  })
  it("returns undefined for empty/absent/all-unknown input", () => {
    expect(normalizeTrackingInfo(undefined)).toBeUndefined()
    expect(normalizeTrackingInfo({})).toBeUndefined()
    expect(normalizeTrackingInfo({ bogus: "x" })).toBeUndefined()
  })

  // Regression (BL-258 / backorder-allocation-fairness-during-stockout baseline gate): the agent staged
  // gated fulfillments with a PLACEHOLDER trackingInfo.url "N/A" (it has no real label yet — it is staging,
  // not reporting a shipped parcel). Shopify 422'd every APPROVE: "Invalid url 'N/A', missing scheme" →
  // verdict-override non-green. A url/number placeholder is NOT real tracking; drop it so the gated write
  // creates the fulfillment WITHOUT tracking instead of executing-to-error.
  it("drops a placeholder url ('N/A') so the gated fulfillment write never 422s", () => {
    expect(normalizeTrackingInfo({ trackingNumber: "MR-123", trackingUrl: "N/A" })).toEqual({
      number: "MR-123",
    })
    // All-placeholder tracking → undefined (fulfillment created with no tracking at all).
    expect(normalizeTrackingInfo({ url: "N/A", number: "n/a", company: "—" })).toBeUndefined()
  })
  it("drops the full placeholder/sentinel set (N/A, none, TBD, '-', empty) case/space-insensitive", () => {
    for (const ph of ["N/A", "n/a", " NA ", "none", "None", "null", "TBD", "tba", "unknown", "pending", "-", "—", ""]) {
      expect(normalizeTrackingInfo({ url: ph, number: ph, company: ph })).toBeUndefined()
    }
  })
  it("drops a url that is not an absolute http(s) URL, but keeps a real one", () => {
    // host-only / scheme-less strings 422 Shopify — drop them.
    expect(normalizeTrackingInfo({ number: "X1", url: "track.example.com/X1" })).toEqual({ number: "X1" })
    expect(normalizeTrackingInfo({ number: "X1", url: "ftp://x" })).toEqual({ number: "X1" })
    // a real https url survives.
    expect(normalizeTrackingInfo({ number: "X1", url: "https://track.example.com/X1" })).toEqual({
      number: "X1",
      url: "https://track.example.com/X1",
    })
  })
  it("filters placeholders/invalid-urls out of array fields, dropping the field if nothing survives", () => {
    expect(normalizeTrackingInfo({ urls: ["https://a", "N/A", "not-a-url"] })).toEqual({ urls: ["https://a"] })
    expect(normalizeTrackingInfo({ urls: ["N/A", "-"] })).toBeUndefined()
    expect(normalizeTrackingInfo({ numbers: ["A1", "", "A2"] })).toEqual({ numbers: ["A1", "A2"] })
  })
})

function makeCtx(opts: {
  fetchResponses: unknown[]
  shopDomain?: string | null
  /** The OAuth grant `install_metadata` records for the connection (omitted = not recorded). */
  grantedOAuthScopes?: string[]
  /** The app's `kernel.apps.config` values `ctx.config.get` returns (omitted keys read as null). */
  config?: Record<string, unknown>
}): {
  ctx: AppContext
  calls: Array<{ url: string; body: string }>
  events: EmittedEvent[]
  channels: string[]
} {
  const calls: Array<{ url: string; body: string }> = []
  // Enforcing emit: throws (like the kernel rpc-bridge guard) if a mutation
  // emits an `${entity}:${action}` not declared in the real app.manifest.json.
  const { emit, emits: events, channels } = createEnforcingEmit()
  const responses = [...opts.fetchResponses]
  const shopDomain = opts.shopDomain === null ? null : (opts.shopDomain ?? "demo.myshopify.com")
  const ctx = {
    userId: "u",
    orgId: "o",
    db: {
      findMany: async (entity: string) => {
        if (entity === "install_metadata" && shopDomain) {
          return [
            {
              id: "i1",
              shopDomain,
              connectionId: "ca1",
              apiVersion: "2026-04",
              ...(opts.grantedOAuthScopes ? { grantedOAuthScopes: opts.grantedOAuthScopes } : {}),
            },
          ]
        }
        return []
      },
      findOne: async () => null,
      insert: async () => ({ id: "x" }),
      update: async () => undefined,
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async () => 0,
    },
    emit,
    enqueueJob: async () => undefined,
    resolveContact: async () => ({}),
    connections: {
      shop: {
        getAccounts: async () => [
          {
            id: "ca1",
            ownerType: "org" as const,
            ownerId: null,
            identifier: shopDomain ?? "demo.myshopify.com",
            displayName: null,
          },
        ],
        getToken: async () => "test-token",
      },
    },
    fetch: async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ?? "" })
      const next = responses.shift()
      return { status: 200, headers: {}, body: JSON.stringify(next ?? {}) }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    config: { get: async (key: string) => opts.config?.[key] ?? null },
    agent_run: async () => "{}",
    realtime_publish: async () => "{}",
    grants_setUserScopes: async () => "{}",
    bulk: {
      fetchToBlob: async () => ({ blobId: "x", sizeBytes: 0 }),
      iterateJsonl: async function* () {},
      deleteBlob: async () => undefined,
    },
  } as unknown as AppContext
  return { ctx, calls, events, channels }
}

describe("normalizeDraftOrderInput — maps weak-model API drift to API-2026 DraftOrderInput fields", () => {
  // The weak agent, drawing on older-API training data, sends `customer` / `lineItemsDiscount`
  // and per-line `price` / `productId` — none of which exist in 2026-01 — so the gated
  // draftOrderCreate 422s. The normaliser maps each to the real field.
  it("customer/{id} → purchasingEntity.customerId; lineItemsDiscount → appliedDiscount", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      {
        customer: { id: "gid://shopify/Customer/7" },
        lineItemsDiscount: { value: 40, valueType: "PERCENTAGE", title: "Dealer" },
      },
      ctx,
    )
    expect(out.customer).toBeUndefined()
    expect(out.purchasingEntity).toEqual({ customerId: "gid://shopify/Customer/7" })
    expect(out.lineItemsDiscount).toBeUndefined()
    expect(out.appliedDiscount).toMatchObject({ value: 40, valueType: "PERCENTAGE", title: "Dealer" })
  })

  it("strips a stray email/field nested in purchasingEntity (Shopify 422 'not defined on PurchasingEntityInput')", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    // The weak model nests an email (and other junk) inside purchasingEntity, which only accepts
    // customerId/purchasingCompany — Shopify 422s and fails the whole gated draftOrderCreate.
    const out = await normalizeDraftOrderInput(
      {
        purchasingEntity: {
          customerId: "gid://shopify/Customer/42",
          email: "sarah.donnelly@example.co.uk",
          firstName: "Sarah",
        },
        lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 8 }],
      },
      ctx,
    )
    expect(out.purchasingEntity).toEqual({ customerId: "gid://shopify/Customer/42" }) // only the valid field survives
  })

  it("salvages a purchasingEntity that carries only a stray `id` as customerId", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      { purchasingEntity: { id: "gid://shopify/Customer/7", email: "x@y.example" } },
      ctx,
    )
    expect(out.purchasingEntity).toEqual({ customerId: "gid://shopify/Customer/7" })
  })

  it("drops a purchasingEntity with no usable identifier left after stripping", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      { purchasingEntity: { email: "x@y.example", firstName: "Sarah" } },
      ctx,
    )
    expect(out.purchasingEntity).toBeUndefined()
  })

  it("shippingAddress.name → firstName/lastName; invented address fields stripped (BL-137)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      { shippingAddress: { name: "Dirk Sauer", city: "Berlin", countryCode: "DE", bogus: "x" } },
      ctx,
    )
    // `name` 422s ("Field is not defined on MailingAddressInput") — split it; drop the invented field.
    expect(out.shippingAddress).toEqual({
      firstName: "Dirk",
      lastName: "Sauer",
      city: "Berlin",
      countryCode: "DE",
    })
  })

  it("folds a human country/province onto countryCode/provinceCode instead of stripping them (ticket-10280)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      {
        shippingAddress: {
          company: "Circuit Corner",
          address1: "2015 N Lincoln St",
          city: "Burbank",
          province: "CA",
          country: "United States",
          zip: "91504",
        },
      },
      ctx,
    )
    // The allowlist used to drop `country`/`province` outright, so a complete
    // address reached the physical-goods guard with no countryCode at all.
    expect(out.shippingAddress).toEqual({
      company: "Circuit Corner",
      address1: "2015 N Lincoln St",
      city: "Burbank",
      provinceCode: "CA",
      countryCode: "US",
      zip: "91504",
    })
  })

  it("resolves a spelled-out province and an alpha-3 country code", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      { shippingAddress: { address1: "1 Rue", city: "Toronto", state: "Ontario", country: "CAN" } },
      ctx,
    )
    expect(out.shippingAddress).toMatchObject({ countryCode: "CA", provinceCode: "ON" })
  })

  it("leaves an unrecognised country unresolved so the physical-goods guard still bites", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      { shippingAddress: { address1: "1 Nowhere", city: "X", country: "Freedonia" } },
      ctx,
    )
    expect((out.shippingAddress as Record<string, unknown>).countryCode).toBeUndefined()
  })

  it("drops a shippingAddress with nothing usable after stripping (a quote needs none)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput({ shippingAddress: { bogus: "x", note: "n/a" } }, ctx)
    expect(out.shippingAddress).toBeUndefined()
  })

  it("drops a top-level email with a reserved non-deliverable TLD — Shopify 422s `.example` (BL-129)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    // The weak model fabricates a recipient like dirk.sauer@tonwerk-audio.example (the chaos world's
    // `.example` domains prime it); Shopify draftOrderCreate REJECTS it ("Email contains an invalid
    // domain name"). The normaliser must drop it so the gated create executes cleanly.
    const out = await normalizeDraftOrderInput(
      { email: "dirk.sauer@tonwerk-audio.example", lineItems: [] },
      ctx,
    )
    expect(out.email).toBeUndefined()
  })

  it("keeps a VALID-looking unlinked email — it is the only recipient a document can be issued to", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    // A plausible dealer domain passes isUsableEmail (non-reserved TLD). It is KEPT: with no linked
    // customer it is the only buyer address the draft carries, and invoicing refuses to issue a quote
    // against an incomplete counterparty. A domain Shopify actually rejects is caught at the create,
    // which retries once without the email.
    const out = await normalizeDraftOrderInput(
      { email: "orders@klangwerk-gmbh.de", lineItems: [] },
      ctx,
    )
    expect(out.email).toBe("orders@klangwerk-gmbh.de")
  })

  it("drops the email when the customer is linked — the linked customer supplies it (BL-129)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      { customer: { id: "gid://shopify/Customer/7" }, email: "anything@valid.com", lineItems: [] },
      ctx,
    )
    expect(out.purchasingEntity).toEqual({ customerId: "gid://shopify/Customer/7" })
    expect(out.email).toBeUndefined()
  })

  it("a productId+price catalog line → real variant + a list-price-derived appliedDiscount (preserves the SKU + store currency)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        { data: { product: { variants: { nodes: [{ id: "gid://shopify/ProductVariant/55" }] } } } }, // productId → default variant
        { data: { node: { price: "699.00" } } }, // variant LIST price
      ],
    })
    const out = await normalizeDraftOrderInput(
      { lineItems: [{ productId: "gid://shopify/Product/3", price: "419.40", quantity: 25 }] },
      ctx,
    )
    const line = (out.lineItems as Array<Record<string, unknown>>)[0]
    expect(line?.price).toBeUndefined()
    expect(line?.productId).toBeUndefined()
    expect(line?.variantId).toBe("gid://shopify/ProductVariant/55") // catalog link PRESERVED
    // (699 - 419.40) / 699 = 40% — discount off the variant's list price, NOT a variant-less custom line
    expect(line?.appliedDiscount).toEqual({ valueType: "PERCENTAGE", value: 40, title: "Discount" })
    expect(line?.originalUnitPriceWithCurrency).toBeUndefined()
    expect(line?.quantity).toBe(25)
  })

  it("a price line with NO resolvable variant → a custom line (fallback)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [{ data: { shop: { currencyCode: "USD" } } }] })
    const out = await normalizeDraftOrderInput(
      { lineItems: [{ title: "Bespoke panel", price: "50.00", quantity: 1 }] },
      ctx,
    )
    const line = (out.lineItems as Array<Record<string, unknown>>)[0]
    expect(line?.price).toBeUndefined()
    expect(line?.variantId).toBeUndefined()
    expect(line?.title).toBe("Bespoke panel")
    expect(line?.originalUnitPriceWithCurrency).toEqual({ amount: "50.00", currencyCode: "USD" })
  })

  it("a variant line that already pairs variantId+appliedDiscount just drops the bogus price", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      {
        lineItems: [
          {
            variantId: "gid://shopify/ProductVariant/9",
            appliedDiscount: { value: 40, valueType: "PERCENTAGE", title: "Dealer" },
            price: "419.40",
            quantity: 25,
          },
        ],
      },
      ctx,
    )
    const line = (out.lineItems as Array<Record<string, unknown>>)[0]
    expect(line?.price).toBeUndefined()
    expect(line?.variantId).toBe("gid://shopify/ProductVariant/9")
    expect(line?.appliedDiscount).toMatchObject({ value: 40, valueType: "PERCENTAGE" })
    expect(line?.originalUnitPriceWithCurrency).toBeUndefined()
  })

  it("a productId that is actually a variant gid → variantId (no lookup)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      { lineItems: [{ productId: "gid://shopify/ProductVariant/9", quantity: 2 }] },
      ctx,
    )
    const line = (out.lineItems as Array<Record<string, unknown>>)[0]
    expect(line?.variantId).toBe("gid://shopify/ProductVariant/9")
    expect(line?.productId).toBeUndefined()
  })

  it("a product-gid productId (no price) → resolves the default variant", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        { data: { product: { variants: { nodes: [{ id: "gid://shopify/ProductVariant/55" }] } } } },
      ],
    })
    const out = await normalizeDraftOrderInput(
      { lineItems: [{ productId: "gid://shopify/Product/3", quantity: 1 }] },
      ctx,
    )
    const line = (out.lineItems as Array<Record<string, unknown>>)[0]
    expect(line?.variantId).toBe("gid://shopify/ProductVariant/55")
    expect(line?.productId).toBeUndefined()
  })

  it("strips hallucinated fields outside the DraftOrderInput / line allowlists (user_id, currencyCode, line.id)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      {
        user_id: "u-1",
        currencyCode: "EUR",
        note: "keep me",
        lineItems: [{ variantId: "gid://shopify/ProductVariant/9", quantity: 1, id: "li-1" }],
      },
      ctx,
    )
    expect(out.user_id).toBeUndefined()
    expect(out.currencyCode).toBeUndefined()
    expect(out.note).toBe("keep me") // a real DraftOrderInput field survives
    const line = (out.lineItems as Array<Record<string, unknown>>)[0]
    expect(line?.id).toBeUndefined()
    expect(line?.variantId).toBe("gid://shopify/ProductVariant/9")
  })

  it("drops a redundant agent-invented email when the customer is linked (avoids the invalid-domain 422)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      { customer: { id: "gid://shopify/Customer/7" }, email: "tonwerk@dealer" },
      ctx,
    )
    expect(out.purchasingEntity).toEqual({ customerId: "gid://shopify/Customer/7" })
    expect(out.email).toBeUndefined()
  })

  it("keeps a real-looking unlinked email — stripping it left invoicing with no recipient", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    // Stripping every unlinked email meant Shopify stored `email: null`, and invoicing then logged
    // "counterparty incomplete: email is missing" and issued nothing for the draft. isUsableEmail
    // still cannot verify an arbitrary domain resolves, so the 422-domain-rejection path (a single
    // retry without the email in draft_orders_create) is what protects the gated create now.
    const out = await normalizeDraftOrderInput({ email: "real@acmeaudio.com", note: "x" }, ctx)
    expect(out.email).toBe("real@acmeaudio.com")
  })

  it("drops a reserved-TLD email (the seed's *.example) even without a linked customer (Shopify 422s it)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput({ email: "orders@tonwerk.example", note: "x" }, ctx)
    expect(out.email).toBeUndefined()
    expect(out.note).toBe("x")
  })
})

describe("normalizeDraftOrderInput — buyer-identity guard throws carry status 400", () => {
  // Pre-flight caller-input validation (a missing shipping address, missing buyer email/name) is
  // an agent-correctable mistake, not a server fault. Without a status carried on the throw, the
  // execute-tool boundary falls through to its statusless generic path and error-logs it — paging
  // the watchdog on every such rejection.
  it("a physical-goods draft order with no shipping address throws MISSING_SHIPPING_ADDRESS at status 400", async () => {
    const { ctx } = makeCtx({ fetchResponses: [{ data: { nodes: [] } }] })
    let caught: unknown
    try {
      await normalizeDraftOrderInput(
        { lineItems: [{ variantId: "gid://shopify/ProductVariant/9", quantity: 1, requiresShipping: true }] },
        ctx,
        { enforceBuyerIdentity: true },
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe("MISSING_SHIPPING_ADDRESS")
    expect((caught as { status?: number }).status).toBe(400)
  })

  it("a digital-goods draft order with no usable buyer email throws MISSING_BUYER_EMAIL at status 400", async () => {
    const { ctx } = makeCtx({ fetchResponses: [{ data: { nodes: [{ id: "gid://shopify/ProductVariant/9", inventoryItem: { requiresShipping: false } }] } }] })
    let caught: unknown
    try {
      await normalizeDraftOrderInput(
        { lineItems: [{ variantId: "gid://shopify/ProductVariant/9", quantity: 1 }] },
        ctx,
        { enforceBuyerIdentity: true },
      )
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { code?: string }).code).toBe("MISSING_BUYER_EMAIL")
    expect((caught as { status?: number }).status).toBe(400)
  })
})

describe("normalizeDraftOrderInput — whole-order discount promotion to order level (edu-bulk-quote)", () => {
  // A weak model expresses a single flat % off the whole multi-line order as a PER-LINE appliedDiscount
  // — sometimes on every line, sometimes (the dominant failure) on just ONE line. Shopify then 422s
  // "Record is invalid" on the inconsistent multi-line draft, and the order-level requirement fails.
  // The CREATE path lifts a UNIFORM per-line discount up to the order level so the gated create both
  // succeeds AND reads as order-level. (edu-bulk-quote-sarah-donnelly; the l504/l505 residual.)
  it("identical per-line discount on EVERY line of a multi-line draft → one order-level discount", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      {
        lineItems: [
          { variantId: "gid://shopify/ProductVariant/1", quantity: 8, appliedDiscount: { value: 20, valueType: "PERCENTAGE", title: "EDU 20% discount" } },
          { variantId: "gid://shopify/ProductVariant/2", quantity: 8, appliedDiscount: { value: 20, valueType: "PERCENTAGE", title: "EDU 20% discount" } },
        ],
      },
      ctx,
      { promoteWholeOrderDiscount: true },
    )
    expect(out.appliedDiscount).toMatchObject({ value: 20, valueType: "PERCENTAGE" }) // lifted to order level
    const lines = out.lineItems as Array<Record<string, unknown>>
    expect(lines[0]?.appliedDiscount).toBeUndefined() // stripped from the lines
    expect(lines[1]?.appliedDiscount).toBeUndefined()
    expect(lines[0]?.variantId).toBe("gid://shopify/ProductVariant/1") // lines otherwise intact
    expect(lines[1]?.variantId).toBe("gid://shopify/ProductVariant/2")
  })

  it("discount on JUST ONE line of a multi-line draft (the dominant weak-model failure) → order-level", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      {
        lineItems: [
          { variantId: "gid://shopify/ProductVariant/1", quantity: 8, appliedDiscount: { value: 20, valueType: "PERCENTAGE", title: "EDU" } },
          { variantId: "gid://shopify/ProductVariant/2", quantity: 8 }, // the other line carries no discount
        ],
      },
      ctx,
      { promoteWholeOrderDiscount: true },
    )
    expect(out.appliedDiscount).toMatchObject({ value: 20, valueType: "PERCENTAGE" })
    const lines = out.lineItems as Array<Record<string, unknown>>
    expect(lines[0]?.appliedDiscount).toBeUndefined()
    expect(lines[1]?.appliedDiscount).toBeUndefined()
  })

  it("DIFFERENT per-line discounts (a genuine per-line tier mix) are NOT promoted", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      {
        lineItems: [
          { variantId: "gid://shopify/ProductVariant/1", quantity: 10, appliedDiscount: { value: 30, valueType: "PERCENTAGE", title: "Dealer" } },
          { variantId: "gid://shopify/ProductVariant/2", quantity: 2, appliedDiscount: { value: 10, valueType: "PERCENTAGE", title: "Accessory" } },
        ],
      },
      ctx,
      { promoteWholeOrderDiscount: true },
    )
    expect(out.appliedDiscount).toBeUndefined() // left per-line
    const lines = out.lineItems as Array<Record<string, unknown>>
    expect(lines[0]?.appliedDiscount).toMatchObject({ value: 30 })
    expect(lines[1]?.appliedDiscount).toMatchObject({ value: 10 })
  })

  it("a SINGLE-line draft keeps its per-line discount (BL-04 round-trip; one line == whole order)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      { lineItems: [{ variantId: "gid://shopify/ProductVariant/9", quantity: 25, appliedDiscount: { value: 40, valueType: "PERCENTAGE", title: "Dealer" } }] },
      ctx,
      { promoteWholeOrderDiscount: true },
    )
    expect(out.appliedDiscount).toBeUndefined() // not lifted — single line
    const lines = out.lineItems as Array<Record<string, unknown>>
    expect(lines[0]?.appliedDiscount).toMatchObject({ value: 40, valueType: "PERCENTAGE" })
  })

  it("an explicit order-level discount already present wins (per-line untouched, no double-discount)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      {
        appliedDiscount: { value: 20, valueType: "PERCENTAGE", title: "EDU" },
        lineItems: [
          { variantId: "gid://shopify/ProductVariant/1", quantity: 8 },
          { variantId: "gid://shopify/ProductVariant/2", quantity: 8 },
        ],
      },
      ctx,
      { promoteWholeOrderDiscount: true },
    )
    expect(out.appliedDiscount).toMatchObject({ value: 20, valueType: "PERCENTAGE" })
  })

  it("the UPDATE path (no promotion flag) leaves a multi-line per-line discount per-line (BL-04)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await normalizeDraftOrderInput(
      {
        lineItems: [
          { variantId: "gid://shopify/ProductVariant/1", quantity: 8, appliedDiscount: { value: 20, valueType: "PERCENTAGE", title: "EDU" } },
          { variantId: "gid://shopify/ProductVariant/2", quantity: 8, appliedDiscount: { value: 20, valueType: "PERCENTAGE", title: "EDU" } },
        ],
      },
      ctx, // no opts → promoteWholeOrderDiscount defaults off
    )
    expect(out.appliedDiscount).toBeUndefined()
    const lines = out.lineItems as Array<Record<string, unknown>>
    expect(lines[0]?.appliedDiscount).toMatchObject({ value: 20 })
  })
})

describe("draft_orders_create — order-level discount placement (end-to-end gated payload)", () => {
  // The gated draftOrderCreate mutation must carry the whole-order discount at the ORDER level even
  // when the agent supplied it per-line on a multi-line draft — the rubric + Shopify both require it.
  it("a per-line discount on a multi-line CREATE is sent as an order-level appliedDiscount", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        // Guard's batched requiresShipping probe: both variants are physical hardware.
        {
          data: {
            nodes: [
              { id: "gid://shopify/ProductVariant/1", inventoryItem: { requiresShipping: true } },
              { id: "gid://shopify/ProductVariant/2", inventoryItem: { requiresShipping: true } },
            ],
          },
        },
        {
          data: {
            draftOrderCreate: {
              draftOrder: { id: "gid://shopify/DraftOrder/8", name: "#D8", totalPriceSet: { presentmentMoney: { amount: "4787.20", currencyCode: "USD" } } },
              userErrors: [],
            },
          },
        },
      ],
    })
    await draft_orders_create(
      {
        input: {
          note: "UK export, post-Brexit customs, commercial invoice required",
          lineItems: [
            { variantId: "gid://shopify/ProductVariant/1", quantity: 8, appliedDiscount: { value: 20, valueType: "PERCENTAGE", title: "EDU 20% discount" } },
            { variantId: "gid://shopify/ProductVariant/2", quantity: 8 },
          ],
          // Physical goods → the guard requires a ship-to address.
          shippingAddress: { firstName: "Edu", lastName: "Buyer", address1: "10 College Rd", city: "London", countryCode: "GB", zip: "EC1A 1BB" },
        },
      },
      ctx,
    )
    const sent = JSON.parse(calls[1]!.body) as {
      variables: { input: { appliedDiscount?: { value: number; valueType: string }; lineItems: Array<{ appliedDiscount?: unknown }> } }
    }
    expect(sent.variables.input.appliedDiscount).toMatchObject({ value: 20, valueType: "PERCENTAGE" })
    expect(sent.variables.input.lineItems[0]?.appliedDiscount).toBeUndefined()
    expect(sent.variables.input.lineItems[1]?.appliedDiscount).toBeUndefined()
  })
})

describe("inventory input normalisation — set-on-hand vs adjust (weak-model API drift)", () => {
  it("set_on_hand: a flat {inventoryItemId, locationId, newQuantity} → InventorySetOnHandQuantitiesInput", () => {
    // The exact failing shape: agent gave `newQuantity` (absolute) on a flat object, no setQuantities wrapper.
    expect(
      normalizeInventorySetOnHandInput({ inventoryItemId: "gid://i/1", locationId: "gid://l/2", newQuantity: 47 }),
    ).toEqual({
      reason: "correction",
      setQuantities: [{ inventoryItemId: "gid://i/1", locationId: "gid://l/2", quantity: 47 }],
    })
  })

  it("set_on_hand: maps quantity synonyms (onHand) and a string number; keeps a VALID enum reason", () => {
    expect(
      normalizeInventorySetOnHandInput({ reason: "cycle_count_available", setQuantities: [{ inventoryItemId: "i", locationId: "l", onHand: "12" }] }),
    ).toEqual({
      reason: "cycle_count_available",
      setQuantities: [{ inventoryItemId: "i", locationId: "l", quantity: 12 }],
    })
  })

  it("set_on_hand: maps an invalid free-text reason (physical_count) to the enum default 'correction'", () => {
    const out = normalizeInventorySetOnHandInput({ reason: "physical_count", setQuantities: [{ inventoryItemId: "i", locationId: "l", quantity: 47 }] })
    expect(out.reason).toBe("correction")
  })

  it("adjust: a flat {inventoryItemId, locationId, delta} → InventoryAdjustQuantitiesInput (name=available)", () => {
    expect(normalizeInventoryAdjustInput({ inventoryItemId: "i", locationId: "l", delta: -3 })).toEqual({
      reason: "correction",
      name: "available",
      changes: [{ inventoryItemId: "i", locationId: "l", delta: -3 }],
    })
  })

  it("adjust: REFUSES an absolute quantity and names inventory_set_on_hand (the set-vs-adjust confusion)", () => {
    expect(() =>
      normalizeInventoryAdjustInput({ inventoryItemId: "i", locationId: "l", newQuantity: 47 }),
    ).toThrow(/inventory_set_on_hand/)
  })

  it("inventory_set_on_hand: reads current on_hand → inventorySetQuantities(name:on_hand) with changeFromQuantity + @idempotent (API-2026)", async () => {
    // The exact scenario shape: agent gives an absolute `newQuantity` on a flat object. The handler
    // must (1) read the live current on_hand, (2) call inventorySetQuantities (NOT the removed
    // inventorySetOnHandQuantities) with changeFromQuantity + the @idempotent directive.
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { inventoryItem: { inventoryLevel: { quantities: [{ name: "on_hand", quantity: 30 }] } } } },
        { data: { inventorySetQuantities: { inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" }, userErrors: [] } } },
      ],
    })
    await inventory_set_on_hand(
      { input: { inventoryItemId: "gid://shopify/InventoryItem/9", locationId: "gid://shopify/Location/2", newQuantity: 47 } },
      ctx,
    )
    // 1st call: read current on_hand for the (item, location).
    const read = JSON.parse(calls[0]!.body) as { query: string; variables: { id: string; loc: string } }
    expect(read.query).toContain("inventoryLevel")
    expect(read.variables.id).toBe("gid://shopify/InventoryItem/9")
    expect(read.variables.loc).toBe("gid://shopify/Location/2")
    // 2nd call: inventorySetQuantities with the absolute quantity + changeFromQuantity from the read + @idempotent.
    const set = JSON.parse(calls[1]!.body) as {
      query: string
      variables: { input: { name: string; reason: string; quantities: Array<Record<string, unknown>> }; key: string }
    }
    expect(set.query).toContain("inventorySetQuantities")
    expect(set.query).toContain("@idempotent")
    expect(set.query).not.toContain("inventorySetOnHandQuantities") // the removed 2026-04 mutation
    expect(set.variables.input.name).toBe("on_hand")
    expect(set.variables.input.quantities[0]).toEqual({
      inventoryItemId: "gid://shopify/InventoryItem/9",
      locationId: "gid://shopify/Location/2",
      quantity: 47,
      changeFromQuantity: 30,
    })
    expect(typeof set.variables.key).toBe("string")
    expect(set.variables.key.length).toBeGreaterThan(0)
  })
})

describe("order_update — capability boundary: tags/note only, NOT shipping address (BL-112)", () => {
  it("REJECTS an unsupported shippingAddress field with a clear boundary (no silent accept → no false claim)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    await expect(
      order_update({ input: { id: "gid://shopify/Order/1", shippingAddress: { address1: "42 Rue", address2: "Apt 14" } } }, ctx),
    ).rejects.toThrow(/CANNOT change|shipping address/i)
  })

  it("allows the supported fields (tags/note) and sends orderUpdate", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [{ data: { orderUpdate: { order: { id: "gid://shopify/Order/1" }, userErrors: [] } } }],
    })
    await order_update({ input: { id: "gid://shopify/Order/1", tags: ["vip"], note: "address correction requested" } }, ctx)
    const body = JSON.parse(calls[0]!.body) as { query: string; variables: { input: Record<string, unknown> } }
    expect(body.query).toContain("orderUpdate")
    expect(body.variables.input.tags).toEqual(["vip"])
    expect(body.variables.input.note).toBe("address correction requested")
  })
})

describe("products_update — wrong-entity guard (Modular-Expo-leads gate fail)", () => {
  // A weak model tasked with TAGGING AN ORDER reached for products_update (it edits tags too) but passed
  // an ORDER gid. Shopify's productUpdate then 422s on EXECUTION with a cryptic "Invalid id:
  // gid://shopify/Order/…" — an unverifiable gated write that forces the run non-green. Reject the entity
  // mismatch with a precise redirect to order_update so the failure is actionable, not cryptic.
  it("REJECTS an ORDER gid with a redirect to order_update (no cryptic Invalid id 422)", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [] })
    await expect(
      products_update({ input: { id: "gid://shopify/Order/12814287863974", tags: ["Modular Expo-2026"] } }, ctx),
    ).rejects.toThrow(/order_update/i)
    // It must FAIL BEFORE any Shopify mutation call (no productUpdate sent with a bad id).
    expect(calls).toHaveLength(0)
  })

  it("accepts a real PRODUCT gid and sends productUpdate", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [{ data: { productUpdate: { product: { id: "gid://shopify/Product/1", title: "Kestrel 6", status: "ACTIVE" }, userErrors: [] } } }],
    })
    await products_update({ input: { id: "gid://shopify/Product/1", tags: ["expo"] } }, ctx)
    const body = JSON.parse(calls[0]!.body) as { query: string; variables: { input: Record<string, unknown> } }
    expect(body.query).toContain("productUpdate")
    expect(body.variables.input.id).toBe("gid://shopify/Product/1")
  })

  it("leaves a bare numeric/legacy id alone (Shopify resolves it)", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [{ data: { productUpdate: { product: { id: "gid://shopify/Product/2", title: "X", status: "ACTIVE" }, userErrors: [] } } }],
    })
    await products_update({ input: { id: "123456", tags: ["x"] } }, ctx)
    expect(calls).toHaveLength(1) // not rejected by the gid-entity guard
  })
})

describe("normalizeEmailInput — draftOrderInvoiceSend EmailInput", () => {
  it("maps a misnamed recipient (address) to `to` and strips the invalid `address` field", () => {
    expect(normalizeEmailInput({ address: "buyer@shop.com", subject: "Quote" })).toEqual({
      to: "buyer@shop.com",
      subject: "Quote",
    })
  })

  it("drops a reserved-TLD `to` → null (send to the customer on the draft)", () => {
    expect(normalizeEmailInput({ to: "orders@tonwerk.example" })).toBeNull()
  })

  it("drops a reserved 2LD `to` (…example.com subdomain) → null — Shopify 422s it (BL-129)", () => {
    // The weak model appends `.com` to a `*.example` address; `tonwerk-audio.example.com` is a
    // subdomain of the RFC-2606 reserved example.com and never resolves → the send must fall back
    // to the draft's customer email, not pass the undeliverable override.
    expect(normalizeEmailInput({ to: "dirk.sauer@tonwerk-audio.example.com", subject: "Q" })).toBeNull()
    expect(normalizeEmailInput({ to: "x@example.com" })).toBeNull()
  })

  it("returns null for a non-object / empty email arg (send to the customer on file)", () => {
    expect(normalizeEmailInput(undefined)).toBeNull()
    expect(normalizeEmailInput(null)).toBeNull()
    expect(normalizeEmailInput({})).toBeNull()
  })

  it("keeps the valid EmailInput fields and strips unknowns", () => {
    expect(
      normalizeEmailInput({ to: "x@y.com", from: "me@z.com", customMessage: "hi", foo: "bar" }),
    ).toEqual({ to: "x@y.com", from: "me@z.com", customMessage: "hi" })
  })

  it("BL-137 — drops a recipient-less EmailInput (subject/body but no usable `to`) → null", () => {
    // Previously kept {subject, customMessage} without `to` → Shopify "To can't be blank". Now null →
    // draftOrderInvoiceSend emails the draft's customer (the safe default).
    expect(normalizeEmailInput({ subject: "Your quote", customMessage: "See attached" })).toBeNull()
    expect(normalizeEmailInput({ to: "", subject: "Your quote" })).toBeNull()
    expect(normalizeEmailInput({ to: "not-an-email", customMessage: "hi" })).toBeNull()
  })
})

describe("refunds_create", () => {
  // refunds_create now issues TWO Shopify calls: (1) a REFUND_ORDER_CONTEXT query to read THIS order's
  // refundable line items + parent SALE transaction (so it can NORMALIZE cross-wired line items and
  // auto-derive the refund transaction), then (2) the refundCreate mutation. So every test supplies the
  // order-context response FIRST. This helper builds a standard 1-line, fully-paid order context.
  const orderCtxResp = (opts?: {
    orderId?: string
    lineItemId?: string
    sku?: string
    refundableQuantity?: number
    saleTxId?: string
    amount?: string
    gateway?: string
  }) => ({
    data: {
      order: {
        id: opts?.orderId ?? "gid://shopify/Order/9",
        currencyCode: "EUR",
        lineItems: {
          edges: [
            {
              node: {
                id: opts?.lineItemId ?? "gid://shopify/LineItem/100",
                quantity: opts?.refundableQuantity ?? 1,
                refundableQuantity: opts?.refundableQuantity ?? 1,
                variant: { sku: opts?.sku ?? "RAL-MOD" },
                sku: opts?.sku ?? "RAL-MOD",
              },
            },
          ],
        },
        transactions: [
          {
            id: opts?.saleTxId ?? "gid://shopify/OrderTransaction/500",
            kind: "SALE",
            status: "SUCCESS",
            gateway: opts?.gateway ?? "manual",
            amountSet: { presentmentMoney: { amount: opts?.amount ?? "789.00", currencyCode: "EUR" } },
          },
        ],
      },
    },
  })
  const refundResp = (id = "gid://shopify/Refund/1", note?: string) => ({
    data: {
      refundCreate: {
        refund: {
          id,
          note: note ?? null,
          totalRefundedSet: { presentmentMoney: { amount: "789.00", currencyCode: "EUR" } },
        },
        userErrors: [],
      },
    },
  })

  it("calls refundCreate, returns the refund, and emits shopify:refund_created", async () => {
    const { ctx, calls, events, channels } = makeCtx({
      fetchResponses: [orderCtxResp(), refundResp("gid://shopify/Refund/1", "broken")],
    })
    const out = (await refunds_create(
      { orderId: "gid://shopify/Order/9", note: "broken", refundLineItems: [] },
      ctx,
    )) as { refund: { id: string } }
    expect(out.refund.id).toMatch(/Refund\/1$/)
    // Two calls now: the order-context query, then the refundCreate mutation.
    expect(calls.length).toBe(2)
    const body = JSON.parse(calls[1]!.body) as {
      query: string
      variables: { input: { orderId: string; note: string }; idempotencyKey: string }
    }
    expect(body.variables.input.orderId).toBe("gid://shopify/Order/9")
    // Shopify API 2026-04 requires the field-level @idempotent directive on
    // refundCreate (the live chaos run 500'd without it). The handler must supply a
    // non-empty key.
    expect(body.query).toContain("refundCreate(input: $input) @idempotent(key: $idempotencyKey)")
    expect(typeof body.variables.idempotencyKey).toBe("string")
    expect(body.variables.idempotencyKey.length).toBeGreaterThan(0)
    expect(events).toHaveLength(1)
    expect(events[0]!.entity).toBe("refund")
    expect(events[0]!.action).toBe("created")
    // I5 — runMutation propagates the newly-created resource id into entityId
    // so the attention translator can interpolate `entityId` in templates.
    expect(events[0]!.entityId).toBe("gid://shopify/Refund/1")
    // Cluster-1 — the emit resolves to the canonical channel.
    expect(channels[0]).toBe(channelName("shopify", "refund", "created"))
  })

  it("builds a FULL refund (all refundable lines + derived REFUND transaction) from orderId alone", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        orderCtxResp({ lineItemId: "gid://shopify/LineItem/100", saleTxId: "gid://shopify/OrderTransaction/500", amount: "789.00" }),
        refundResp(),
      ],
    })
    await refunds_create({ orderId: "gid://shopify/Order/9" }, ctx)
    const input = (
      JSON.parse(calls[1]!.body) as {
        variables: {
          input: {
            refundLineItems: { lineItemId: string; quantity: number }[]
            transactions: { kind: string; parentId: string; amount: string; gateway: string }[]
          }
        }
      }
    ).variables.input
    // The order's own refundable line, full quantity.
    expect(input.refundLineItems).toEqual([{ lineItemId: "gid://shopify/LineItem/100", quantity: 1 }])
    // A REFUND transaction against the parent SALE for the full captured amount — so money is actually
    // returned (not a €0 line-item-only refund).
    expect(input.transactions).toHaveLength(1)
    expect(input.transactions[0]).toMatchObject({
      kind: "REFUND",
      parentId: "gid://shopify/OrderTransaction/500",
      amount: "789.00",
      gateway: "manual",
    })
  })

  it("FLAT GOODWILL amount → no-line-item refund with a derived REFUND transaction for exactly that amount", async () => {
    // mass-refund-firmware-recall-batch: a 50 EUR goodwill partial on a 699 EUR order. Without the
    // `amount` affordance the agent either omitted refundLineItems (→ a FULL ~order-total refund, not
    // 50 EUR) or hand-built a transactions entry with null gateway/orderId/parentId (Shopify 422). The
    // handler must build a NO-LINE-ITEM refund whose single REFUND transaction returns exactly 50.00,
    // threading gateway/parentId/orderId from the order's parent SALE.
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        orderCtxResp({ amount: "699.00", saleTxId: "gid://shopify/OrderTransaction/777", gateway: "manual" }),
        refundResp("gid://shopify/Refund/9", "Goodwill — firmware recall"),
      ],
    })
    await refunds_create(
      { orderId: "gid://shopify/Order/9", amount: "50.00", note: "Goodwill — firmware recall" },
      ctx,
    )
    const input = (
      JSON.parse(calls[1]!.body) as {
        variables: {
          input: {
            refundLineItems: unknown[]
            shipping: unknown
            transactions: { kind: string; parentId: string; amount: string; gateway: string; orderId: string }[]
          }
        }
      }
    ).variables.input
    // A goodwill amount is NOT tied to line items, and shipping is never split onto it.
    expect(input.refundLineItems).toEqual([])
    expect(input.shipping).toBeUndefined()
    // Exactly the goodwill amount, with the plumbing derived from the order's parent SALE (no nulls).
    expect(input.transactions).toHaveLength(1)
    expect(input.transactions[0]).toEqual({
      orderId: "gid://shopify/Order/9",
      gateway: "manual",
      kind: "REFUND",
      parentId: "gid://shopify/OrderTransaction/777",
      amount: "50.00",
    })
  })

  it("MULTI-CURRENCY order (presentment != shop currency) → RefundInput.currency = presentment currency", async () => {
    // A customer paid in USD on an EUR shop. Every amount the handler threads is presentment-side
    // (the parent SALE's presentmentMoney, the caller's flat amount), so RefundInput.currency MUST
    // be set to the presentment currency — without it Shopify interprets the transaction amount in
    // the shop currency and rejects the refund ("Currency must match parent transaction USD").
    const multiCtx = orderCtxResp({ amount: "1078.30", saleTxId: "gid://shopify/OrderTransaction/13", gateway: "shopify_payments" })
    ;(multiCtx.data.order as Record<string, unknown>).presentmentCurrencyCode = "USD"
    const { ctx, calls } = makeCtx({ fetchResponses: [multiCtx, refundResp()] })
    await refunds_create({ orderId: "gid://shopify/Order/9", amount: "200.00" }, ctx)
    const { input, idempotencyKey } = (
      JSON.parse(calls[1]!.body) as {
        variables: { input: { currency?: string; transactions: { amount: string }[] }; idempotencyKey: string }
      }
    ).variables
    expect(input.currency).toBe("USD")
    expect(input.transactions[0]!.amount).toBe("200.00")
    // The currency participates in the idempotency key: a retry of the OLD currency-less payload
    // (which Shopify already failed) must not collide with the fixed one.
    const sameCcy = makeCtx({ fetchResponses: [orderCtxResp({ amount: "1078.30" }), refundResp()] })
    await refunds_create({ orderId: "gid://shopify/Order/9", amount: "200.00" }, sameCcy.ctx)
    const singleCcy = (
      JSON.parse(sameCcy.calls[1]!.body) as { variables: { input: { currency?: string }; idempotencyKey: string } }
    ).variables
    expect(singleCcy.input.currency).toBeUndefined()
    expect(singleCcy.idempotencyKey).not.toBe(idempotencyKey)
  })

  it("SALTS the idempotency key with the approval execution id: same execution dedupes, a new approval never replays a failed one", async () => {
    // Shopify's @idempotent replays the stored outcome for a key, INCLUDING a failure.
    // With a pure content hash, one failed gated execution wedged every later approval
    // of the same refund into replaying that failure. The kernel mints one
    // approvalExecutionId per decide (stable across its transient re-invocations).
    const keyFor = async (executionId?: string) => {
      const { ctx, calls } = makeCtx({ fetchResponses: [orderCtxResp({ amount: "699.00" }), refundResp()] })
      if (executionId) {
        ;(ctx as unknown as Record<string, unknown>).approval = {
          approvalRequestId: "req-1",
          approvalDeciderId: "u",
          toolName: "shopify:refunds_create",
          approvalExecutionId: executionId,
        }
      }
      await refunds_create({ orderId: "gid://shopify/Order/9", amount: "50.00" }, ctx)
      return (JSON.parse(calls[1]!.body) as { variables: { idempotencyKey: string } }).variables.idempotencyKey
    }
    const execA1 = await keyFor("exec-a")
    const execA2 = await keyFor("exec-a")
    const execB = await keyFor("exec-b")
    const noApproval = await keyFor()
    expect(execA1).toBe(execA2) // same execution (transient retry) -> same key, still dedupes
    expect(execB).not.toBe(execA1) // fresh approval -> fresh key, cannot replay a failure
    expect(noApproval).not.toBe(execA1) // ungated call keys on content alone
  })

  it("accepts a numeric amount and a transactions-only goodwill (amount but no line items), normalizing both", async () => {
    // Weak-model variants of the same goodwill intent: amount as a NUMBER (50), and a transactions entry
    // carrying just an amount with null gateway/orderId/parentId. Both must normalize to a well-formed
    // 50.00 REFUND transaction (never a Shopify 422 on a null field).
    const num = makeCtx({
      fetchResponses: [orderCtxResp({ amount: "699.00" }), refundResp()],
    })
    await refunds_create({ orderId: "gid://shopify/Order/9", amount: 50 }, num.ctx)
    const numTx = (
      JSON.parse(num.calls[1]!.body) as { variables: { input: { refundLineItems: unknown[]; transactions: { amount: string }[] } } }
    ).variables.input
    expect(numTx.refundLineItems).toEqual([])
    expect(numTx.transactions[0]!.amount).toBe("50.00")

    const txOnly = makeCtx({
      fetchResponses: [orderCtxResp({ amount: "699.00", saleTxId: "gid://shopify/OrderTransaction/888" }), refundResp()],
    })
    await refunds_create(
      {
        orderId: "gid://shopify/Order/9",
        // The agent's hand-built transaction with the fields it can't know (the 422 source) left null.
        transactions: [{ kind: "REFUND", amount: "50.00", gateway: null, orderId: null, parentId: null }],
      },
      txOnly.ctx,
    )
    const txInput = (
      JSON.parse(txOnly.calls[1]!.body) as {
        variables: { input: { transactions: { kind: string; gateway: string; orderId: string; parentId: string; amount: string }[] } }
      }
    ).variables.input
    expect(txInput.transactions).toHaveLength(1)
    // Every previously-null internal field is now filled from the parent SALE — Shopify won't reject it.
    expect(txInput.transactions[0]).toEqual({
      orderId: "gid://shopify/Order/9",
      gateway: "manual",
      kind: "REFUND",
      parentId: "gid://shopify/OrderTransaction/888",
      amount: "50.00",
    })
  })

  it("drops a goodwill-amount `shipping` overshoot (never triggers 'Shipping must have amount <= remaining shipping')", async () => {
    // A weak model that put part of the 50 EUR goodwill onto `shipping` triggered the Shopify 422
    // "Shipping must have amount less than or equal to remaining shipping". For a flat goodwill amount,
    // shipping is dropped entirely — the courtesy sum rides the transaction, not shipping.
    const { ctx, calls } = makeCtx({
      fetchResponses: [orderCtxResp({ amount: "699.00" }), refundResp()],
    })
    await refunds_create(
      { orderId: "gid://shopify/Order/9", amount: "50.00", shipping: { amount: "50.00" } },
      ctx,
    )
    const input = (
      JSON.parse(calls[1]!.body) as { variables: { input: { shipping: unknown; transactions: { amount: string }[] } } }
    ).variables.input
    expect(input.shipping).toBeUndefined()
    expect(input.transactions[0]!.amount).toBe("50.00")
  })

  it("REMAPS a cross-wired lineItemId (belonging to ANOTHER order) onto THIS order's matching line", async () => {
    // The duplicate-order failure: the agent refunds order B but passes order A's lineItemId →
    // Shopify 422 "Line item must belong to the order which is being refunded". The handler remaps the
    // foreign id to THIS order's line (by SKU, else its only refundable line), so the gated write
    // EXECUTES instead of 422ing.
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        orderCtxResp({ lineItemId: "gid://shopify/LineItem/THIS-ORDER", sku: "RAL-MOD" }),
        refundResp(),
      ],
    })
    await refunds_create(
      {
        orderId: "gid://shopify/Order/9",
        // A lineItemId from a DIFFERENT order (the near-identical duplicate).
        refundLineItems: [{ lineItemId: "gid://shopify/LineItem/OTHER-ORDER", quantity: 1, sku: "RAL-MOD" }],
      },
      ctx,
    )
    const input = (
      JSON.parse(calls[1]!.body) as {
        variables: { input: { refundLineItems: { lineItemId: string }[] } }
      }
    ).variables.input
    expect(input.refundLineItems[0]!.lineItemId).toBe("gid://shopify/LineItem/THIS-ORDER")
  })

  it("honors an explicit idempotencyKey, else derives a deterministic one from the refund content", async () => {
    // explicit key passthrough
    const a = makeCtx({ fetchResponses: [orderCtxResp(), refundResp()] })
    await refunds_create(
      { orderId: "gid://shopify/Order/9", refundLineItems: [], idempotencyKey: "explicit-key-123" },
      a.ctx,
    )
    expect(
      (JSON.parse(a.calls[1]!.body) as { variables: { idempotencyKey: string } }).variables
        .idempotencyKey,
    ).toBe("explicit-key-123")

    // default key is deterministic for identical content (retries dedupe)
    const b = makeCtx({ fetchResponses: [orderCtxResp(), refundResp()] })
    const c = makeCtx({ fetchResponses: [orderCtxResp(), refundResp()] })
    const li = [{ lineItemId: "gid://shopify/LineItem/100", quantity: 1 }]
    await refunds_create({ orderId: "gid://shopify/Order/9", refundLineItems: li }, b.ctx)
    await refunds_create({ orderId: "gid://shopify/Order/9", refundLineItems: li }, c.ctx)
    const kb = (JSON.parse(b.calls[1]!.body) as { variables: { idempotencyKey: string } }).variables
      .idempotencyKey
    const kc = (JSON.parse(c.calls[1]!.body) as { variables: { idempotencyKey: string } }).variables
      .idempotencyKey
    expect(kb).toBe(kc)
    expect(kb.length).toBeGreaterThan(0)
  })

  it("throws on missing orderId, with status 400 (caller error, warn-logged, does not page)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    await expect(refunds_create({}, ctx)).rejects.toThrow(/orderId/)
    await expect(refunds_create({}, ctx)).rejects.toMatchObject({ status: 400 })
  })

  it("throws when the order is not found", async () => {
    const { ctx } = makeCtx({ fetchResponses: [{ data: { order: null } }] })
    await expect(
      refunds_create({ orderId: "gid://shopify/Order/missing" }, ctx),
    ).rejects.toThrow(/not found/)
  })

  it("throws when Shopify returns userErrors and skips event emission", async () => {
    const { ctx, events } = makeCtx({
      fetchResponses: [
        orderCtxResp(),
        {
          data: {
            refundCreate: {
              refund: null,
              userErrors: [{ field: ["orderId"], message: "Order is closed" }],
            },
          },
        },
      ],
    })
    await expect(
      refunds_create({ orderId: "gid://shopify/Order/9", refundLineItems: [] }, ctx),
    ).rejects.toThrow(/Order is closed/)
    expect(events).toHaveLength(0)
  })

  // STAGE-TIME preflight (manifest `preflight: refunds_create_preflight`) — the nadia_day_monday
  // step-2 hard override. The approve-batch scenario surfaces DISPLAY-only refund approvals whose
  // linked order (e.g. #1055) is not a live-store refundable order; under "approve them" pressure a
  // weak model re-PROPOSES its OWN refunds_create for that order with a malformed/stale orderId. That
  // fresh agent-proposed approval carries a populated payload (so the empty-payload display-fixture
  // skip can't catch it), and approving it 422s on execution → an UNVERIFIED gated execution hard
  // override. The preflight moves that failure to STAGE time as a clean typed error (the approval is
  // never created), while a genuine refund against a REAL refundable order still stages + executes.
  describe("refunds_create_preflight — reject a doomed refund at stage time, pass a real one", () => {
    it("returns a typed error (NOT ok) for a malformed orderId that 422s the Shopify $id:ID! variable", async () => {
      // The order NUMBER "#1055" (not a gid) makes Shopify reject the $id variable → GRAPHQL_ERROR.
      const { ctx, calls } = makeCtx({
        fetchResponses: [
          { errors: [{ message: "Variable $id of type ID! was provided invalid value" }] },
        ],
      })
      const out = await refunds_create_preflight({ orderId: "#1055" }, ctx)
      expect("error" in out).toBe(true)
      const err = (out as { error: { code: string; message: string } }).error
      expect(err.code).toBe("ORDER_UNRESOLVED")
      expect(err.message).toMatch(/gid:\/\/shopify\/Order/)
      // It probed the live order context exactly once (same query the handler runs).
      expect(calls.length).toBe(1)
    })

    it("returns a typed ORDER_NOT_FOUND error when the gid resolves to no order", async () => {
      const { ctx } = makeCtx({ fetchResponses: [{ data: { order: null } }] })
      const out = await refunds_create_preflight({ orderId: "gid://shopify/Order/missing" }, ctx)
      expect("error" in out).toBe(true)
      expect((out as { error: { code: string } }).error.code).toBe("ORDER_NOT_FOUND")
    })

    it("returns a typed NO_REFUNDABLE_LINE error when the order has nothing refundable (no goodwill amount)", async () => {
      const { ctx } = makeCtx({
        fetchResponses: [orderCtxResp({ refundableQuantity: 0 })],
      })
      const out = await refunds_create_preflight({ orderId: "gid://shopify/Order/9" }, ctx)
      expect("error" in out).toBe(true)
      expect((out as { error: { code: string } }).error.code).toBe("NO_REFUNDABLE_LINE")
    })

    it("returns BAD_PARAM when orderId is missing", async () => {
      const { ctx } = makeCtx({ fetchResponses: [] })
      const out = await refunds_create_preflight({}, ctx)
      expect("error" in out).toBe(true)
      expect((out as { error: { code: string } }).error.code).toBe("BAD_PARAM")
    })

    it("passes ({ ok: true }) a genuine refund against a REAL refundable order (does NOT skip a real refund)", async () => {
      const { ctx } = makeCtx({ fetchResponses: [orderCtxResp()] })
      const out = await refunds_create_preflight({ orderId: "gid://shopify/Order/9" }, ctx)
      expect(out).toEqual({ ok: true })
    })

    it("passes a flat-goodwill refund even when no line items are refundable (the amount path is valid)", async () => {
      const { ctx } = makeCtx({ fetchResponses: [orderCtxResp({ refundableQuantity: 0 })] })
      const out = await refunds_create_preflight(
        { orderId: "gid://shopify/Order/9", amount: "50.00" },
        ctx,
      )
      expect(out).toEqual({ ok: true })
    })

    it("passes a transactions-only goodwill refund (amount via transactions[0], no line items) on a fully-refunded order", async () => {
      // The handler's isFlatGoodwill ALSO accepts a flat amount supplied via transactions[0].amount
      // with no refundLineItems (a transactions-only courtesy refund). The preflight must agree:
      // rejecting this shape as NO_REFUNDABLE_LINE on a fully-refunded order would wrongly block a
      // refund the handler would happily process.
      const { ctx } = makeCtx({ fetchResponses: [orderCtxResp({ refundableQuantity: 0 })] })
      const out = await refunds_create_preflight(
        {
          orderId: "gid://shopify/Order/9",
          transactions: [{ amount: "50.00", kind: "REFUND", gateway: "manual" }],
        },
        ctx,
      )
      expect(out).toEqual({ ok: true })
    })

    it("still rejects NO_REFUNDABLE_LINE when transactions are present but carry NO usable amount (no goodwill intent)", async () => {
      // A transactions entry with an unparseable amount is not a flat goodwill amount → with nothing
      // refundable, the preflight must still reject (agreeing with the handler, which would derive no
      // flatAmount either).
      const { ctx } = makeCtx({ fetchResponses: [orderCtxResp({ refundableQuantity: 0 })] })
      const out = await refunds_create_preflight(
        { orderId: "gid://shopify/Order/9", transactions: [{ kind: "REFUND" }] },
        ctx,
      )
      expect("error" in out).toBe(true)
      expect((out as { error: { code: string } }).error.code).toBe("NO_REFUNDABLE_LINE")
    })
  })
})

describe("draft_orders_create", () => {
  it("calls draftOrderCreate and emits shopify:draft_order_created", async () => {
    const { ctx, events } = makeCtx({
      fetchResponses: [
        // The buyer-identity guard first batch-queries the lines' requiresShipping (one physical variant).
        { data: { nodes: [{ id: "gid://shopify/ProductVariant/1", inventoryItem: { requiresShipping: true } }] } },
        {
          data: {
            draftOrderCreate: {
              draftOrder: { id: "gid://shopify/DraftOrder/7", name: "#D7", totalPriceSet: { presentmentMoney: { amount: "50.00", currencyCode: "USD" } } },
              userErrors: [],
            },
          },
        },
      ],
    })
    // Physical goods → a shipping address is now required by the guard.
    await draft_orders_create(
      {
        input: {
          lineItems: [{ quantity: 1, variantId: "gid://shopify/ProductVariant/1" }],
          shippingAddress: { firstName: "Dana", lastName: "Reed", address1: "1 Main St", city: "Berlin", countryCode: "DE", zip: "10115" },
        },
      },
      ctx,
    )
    expect(events[0]!.entity).toBe("draft_order")
    expect(events[0]!.action).toBe("created")
  })

  it("carries poNumber on the emitted event when the created draft has one (event shape: camelCase, not the tool-result po_number)", async () => {
    const { ctx, events } = makeCtx({
      fetchResponses: [
        { data: { nodes: [{ id: "gid://shopify/ProductVariant/1", inventoryItem: { requiresShipping: true } }] } },
        {
          data: {
            draftOrderCreate: {
              draftOrder: {
                id: "gid://shopify/DraftOrder/8",
                name: "#D8",
                poNumber: "PO-4471",
                totalPriceSet: { presentmentMoney: { amount: "50.00", currencyCode: "USD" } },
              },
              userErrors: [],
            },
          },
        },
      ],
    })
    await draft_orders_create(
      {
        input: {
          poNumber: "PO-4471",
          lineItems: [{ quantity: 1, variantId: "gid://shopify/ProductVariant/1" }],
          shippingAddress: { firstName: "Dana", lastName: "Reed", address1: "1 Main St", city: "Berlin", countryCode: "DE", zip: "10115" },
        },
      },
      ctx,
    )
    const data = events[0]!.data as { draftOrder: { po_number?: string; poNumber?: string } }
    expect(data.draftOrder.poNumber).toBe("PO-4471")
    // Regression guard: if the emitted key's casing slips to po_number, this must fail.
    expect("po_number" in data.draftOrder).toBe(false)
  })

  // A draft order created for a buyer with NO linked Shopify customer used to reach Shopify with its
  // email stripped: Shopify stored `email: null`, and invoicing then refused the draft with
  // "counterparty incomplete: email is missing", so no quote was ever issued and the only trace was a
  // debug-level warn. The buyer email must ride the physical-goods create.
  it("sends a usable unlinked buyer email on a PHYSICAL draft create (invoicing needs the recipient)", async () => {
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        // Guard's batched requiresShipping probe: this dealer line is physical hardware.
        { data: { nodes: [{ id: "gid://shopify/ProductVariant/1", inventoryItem: { requiresShipping: true } }] } },
        {
          data: {
            draftOrderCreate: {
              draftOrder: { id: "gid://shopify/DraftOrder/9", name: "#D9", totalPriceSet: { presentmentMoney: { amount: "699.00", currencyCode: "EUR" } } },
              userErrors: [],
            },
          },
        },
      ],
    })
    await draft_orders_create(
      {
        input: {
          email: "orders@klangwerk-gmbh.de",
          lineItems: [{ quantity: 25, variantId: "gid://shopify/ProductVariant/1" }],
          shippingAddress: { firstName: "Klaus", lastName: "Werk", address1: "5 Ringstr", city: "Wien", countryCode: "AT", zip: "1010" },
        },
      },
      ctx,
    )
    expect(calls).toHaveLength(2) // batched requiresShipping probe, then the gated create
    const sent = JSON.parse(calls[1]!.body) as { variables: { input: Record<string, unknown> } }
    expect(sent.variables.input.email).toBe("orders@klangwerk-gmbh.de")
    expect(sent.variables.input.lineItems).toBeDefined() // the actual quote survives
    expect(events[0]!.entity).toBe("draft_order")
    expect(events[0]!.action).toBe("created")
  })

  // A fabricated-but-plausible dealer domain passes the usable-email heuristic yet Shopify rejects it
  // ("Email contains an invalid domain name"), which used to fail the whole gated create. One retry
  // without the email keeps the draft landing.
  it("retries the create once WITHOUT the email when Shopify rejects the email domain", async () => {
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        { data: { nodes: [{ id: "gid://shopify/ProductVariant/1", inventoryItem: { requiresShipping: true } }] } },
        // Shopify's domain verdict comes back as a userErrors rejection.
        { data: { draftOrderCreate: { draftOrder: null, userErrors: [{ field: ["email"], message: "Email contains an invalid domain name" }] } } },
        {
          data: {
            draftOrderCreate: {
              draftOrder: { id: "gid://shopify/DraftOrder/11", name: "#D11", totalPriceSet: { presentmentMoney: { amount: "699.00", currencyCode: "EUR" } } },
              userErrors: [],
            },
          },
        },
      ],
    })
    const out = (await draft_orders_create(
      {
        input: {
          email: "orders@nowhere-fabricated.de",
          lineItems: [{ quantity: 1, variantId: "gid://shopify/ProductVariant/1" }],
          shippingAddress: { firstName: "Klaus", lastName: "Werk", address1: "5 Ringstr", city: "Wien", countryCode: "AT", zip: "1010" },
        },
      },
      ctx,
    )) as { draftOrder: { id: string } }
    expect(calls).toHaveLength(3) // probe, rejected create, retry
    const first = JSON.parse(calls[1]!.body) as { variables: { input: Record<string, unknown> } }
    expect(first.variables.input.email).toBe("orders@nowhere-fabricated.de")
    const retry = JSON.parse(calls[2]!.body) as { variables: { input: Record<string, unknown> } }
    expect(retry.variables.input.email).toBeUndefined()
    expect(retry.variables.input.lineItems).toBeDefined()
    expect(out.draftOrder.id).toBe("gid://shopify/DraftOrder/11")
    expect(events[0]!.action).toBe("created")
  })

  // The retry is scoped to Shopify's email-domain verdict. Any other rejection must fail the create
  // as before, with Shopify's own message intact (never flattened into a generic one).
  it("does NOT retry on an unrelated Shopify rejection, and the original error propagates unchanged", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { nodes: [{ id: "gid://shopify/ProductVariant/1", inventoryItem: { requiresShipping: true } }] } },
        { data: { draftOrderCreate: { draftOrder: null, userErrors: [{ field: ["lineItems"], message: "Variant is unavailable for sale" }] } } },
      ],
    })
    let caught: unknown
    try {
      await draft_orders_create(
        {
          input: {
            email: "orders@klangwerk-gmbh.de",
            lineItems: [{ quantity: 1, variantId: "gid://shopify/ProductVariant/1" }],
            shippingAddress: { firstName: "Klaus", lastName: "Werk", address1: "5 Ringstr", city: "Wien", countryCode: "AT", zip: "1010" },
          },
        },
        ctx,
      )
    } catch (err) {
      caught = err
    }
    expect(calls).toHaveLength(2) // probe + the ONE create; no retry
    expect((caught as { code?: string }).code).toBe("SHOPIFY_USER_ERROR")
    expect((caught as Error).message).toBe("draftOrderCreate: lineItems: Variant is unavailable for sale")
  })
})

describe("draft_orders_complete: order-then-draft PO fallback", () => {
  it("prefers the completed ORDER's own poNumber when Shopify carries it through", async () => {
    const { ctx, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrderComplete: {
              draftOrder: {
                id: "gid://shopify/DraftOrder/40",
                name: "#D40",
                status: "COMPLETED",
                poNumber: "PO-DRAFT-40",
                order: { id: "gid://shopify/Order/40", name: "#1040", poNumber: "PO-ORDER-40" },
              },
              userErrors: [],
            },
          },
        },
      ],
    })
    await draft_orders_complete({ id: "gid://shopify/DraftOrder/40" }, ctx)
    const data = events[0]!.data as { draftOrder: { poNumber?: string | null } }
    expect(data.draftOrder.poNumber).toBe("PO-ORDER-40")
  })

  it("falls back to the draft's own poNumber when the completed order's field is empty", async () => {
    const { ctx, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrderComplete: {
              draftOrder: {
                id: "gid://shopify/DraftOrder/41",
                name: "#D41",
                status: "COMPLETED",
                poNumber: "PO-DRAFT-41",
                order: { id: "gid://shopify/Order/41", name: "#1041", poNumber: null },
              },
              userErrors: [],
            },
          },
        },
      ],
    })
    await draft_orders_complete({ id: "gid://shopify/DraftOrder/41" }, ctx)
    const data = events[0]!.data as { draftOrder: { poNumber?: string | null } }
    expect(data.draftOrder.poNumber).toBe("PO-DRAFT-41")
  })

  it("resolves poNumber to null (matching sibling id/name/status/order fields) when neither side carries a PO", async () => {
    const { ctx, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrderComplete: {
              draftOrder: {
                id: "gid://shopify/DraftOrder/42",
                name: "#D42",
                status: "COMPLETED",
                poNumber: null,
                order: { id: "gid://shopify/Order/42", name: "#1042", poNumber: null },
              },
              userErrors: [],
            },
          },
        },
      ],
    })
    await draft_orders_complete({ id: "gid://shopify/DraftOrder/42" }, ctx)
    const data = events[0]!.data as { draftOrder: Record<string, unknown> }
    expect(data.draftOrder.poNumber).toBeNull()
    expect("po_number" in data.draftOrder).toBe(false)
  })
})

describe("draft_orders_create — buyer-identity guard (digital needs name+email, physical needs address)", () => {
  // The comp-order incident: a 100%-off Tessera Sound (a DIGITAL license) draft was created with no buyer
  // email, so the fulfilment webhook issued NO license. The guard makes that impossible: a digital order
  // must carry a usable email + a name (or a linked customer); a physical order must carry a ship-to.
  // The digital/physical flag lives on inventoryItem.requiresShipping — the variant-level
  // field was removed from the Admin API (selecting it errors the whole probe, defaulting
  // every line to physical: the live misclassification this shape pins against).
  const digitalNodes = (id = "gid://shopify/ProductVariant/1") => ({
    data: { nodes: [{ id, inventoryItem: { requiresShipping: false } }] },
  })
  const physicalNodes = (id = "gid://shopify/ProductVariant/1") => ({
    data: { nodes: [{ id, inventoryItem: { requiresShipping: true } }] },
  })
  const createOk = {
    data: {
      draftOrderCreate: {
        draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1", totalPriceSet: { presentmentMoney: { amount: "0.00", currencyCode: "EUR" } } },
        userErrors: [],
      },
    },
  }

  it("rejects a DIGITAL order with no buyer email (the exact comp-order failure)", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [digitalNodes()] })
    await expect(
      draft_orders_create({ input: { lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }] } }, ctx),
    ).rejects.toThrow(/digital goods needs a usable buyer email/i)
    expect(calls).toHaveLength(1) // only the requiresShipping probe ran; the gated create never fired
  })

  it("rejects a DIGITAL order that has an email but no name", async () => {
    const { ctx } = makeCtx({ fetchResponses: [digitalNodes()] })
    await expect(
      draft_orders_create(
        { input: { email: "jeff@apple.com", lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }] } },
        ctx,
      ),
    ).rejects.toThrow(/digital goods needs a buyer name/i)
  })

  it("creates a DIGITAL order and PRESERVES the usable buyer email (the license is issued to it)", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [digitalNodes(), createOk] })
    await draft_orders_create(
      {
        input: {
          email: "jeff@apple.com",
          billingAddress: { firstName: "Jeff", lastName: "Cross" },
          lineItems: [
            { variantId: "gid://shopify/ProductVariant/1", quantity: 1, appliedDiscount: { value: 100, valueType: "PERCENTAGE", title: "Comp" } },
          ],
        },
      },
      ctx,
    )
    const sent = JSON.parse(calls[1]!.body) as { variables: { input: Record<string, unknown> } }
    expect(sent.variables.input.email).toBe("jeff@apple.com") // kept — unlike a physical/quote draft
  })

  it("creates a DIGITAL order with a LINKED customer and no explicit email (the customer supplies both)", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [digitalNodes(), createOk] })
    await draft_orders_create(
      {
        input: {
          customer: { id: "gid://shopify/Customer/7" },
          lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
        },
      },
      ctx,
    )
    const sent = JSON.parse(calls[1]!.body) as { variables: { input: Record<string, unknown> } }
    expect(sent.variables.input.purchasingEntity).toMatchObject({ customerId: "gid://shopify/Customer/7" })
  })

  it("rejects a PHYSICAL order with no shipping address", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [physicalNodes()] })
    await expect(
      draft_orders_create({ input: { lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }] } }, ctx),
    ).rejects.toThrow(/physical goods needs a shipping address/i)
    expect(calls).toHaveLength(1)
  })

  it("creates a PHYSICAL order once a shipping address is supplied", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [physicalNodes(), createOk] })
    await draft_orders_create(
      {
        input: {
          lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
          shippingAddress: { firstName: "Dana", lastName: "Reed", address1: "1 Main St", city: "Berlin", countryCode: "DE", zip: "10115" },
        },
      },
      ctx,
    )
    const sent = JSON.parse(calls[1]!.body) as { variables: { input: Record<string, unknown> } }
    expect(sent.variables.input.shippingAddress).toMatchObject({ address1: "1 Main St", city: "Berlin", countryCode: "DE" })
  })
})

describe("draft_orders_create — requiresShipping probe query shape", () => {
  it("selects inventoryItem.requiresShipping, never the removed variant-level field", async () => {
    // ProductVariant.requiresShipping no longer exists in the Admin API; selecting it errors the
    // whole nodes() query, the catch swallowed it, and every line defaulted to PHYSICAL — the guard
    // then demanded a shipping address for a digital license and wedged the approval. Pin the query.
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { nodes: [{ id: "gid://shopify/ProductVariant/1", inventoryItem: { requiresShipping: false } }] } },
        {
          data: {
            draftOrderCreate: {
              draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1", totalPriceSet: { presentmentMoney: { amount: "0.00", currencyCode: "EUR" } } },
              userErrors: [],
            },
          },
        },
      ],
    })
    await draft_orders_create(
      {
        input: {
          email: "buyer@real-domain.com",
          billingAddress: { firstName: "Ann", lastName: "Buyer" },
          lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }],
        },
      },
      ctx,
    )
    const probe = JSON.parse(calls[0]!.body) as { query: string }
    expect(probe.query).toContain("inventoryItem { requiresShipping }")
    expect(probe.query).not.toMatch(/ProductVariant \{ id requiresShipping/)
  })
})

describe("withApprovalProtocol — durable outcome recording on the post-approval replay", () => {
  // The wedge class: the kernel replays a gated handler after approve; a throw with no durable
  // outcome row is AMBIGUOUS and leaves the approval stuck at `approving`. The wrapper records
  // failed_no_effect for provably-effectless failures (validation errors, Shopify userErrors
  // rejections) so the kernel reverts the approval to pending and surfaces the message.
  type Recorded = { started: string[]; succeeded: string[]; failedNoEffect: Array<{ tool: string; err: unknown }> }
  const approvalCtx = (base: unknown): { ctx: AppContext; recorded: Recorded } => {
    const recorded: Recorded = { started: [], succeeded: [], failedNoEffect: [] }
    const ctx = Object.assign(base as Record<string, unknown>, {
      approval: { approvalRequestId: "ar-1", approvalDeciderId: "u-2", toolName: "shopify:tool_under_test" },
      approval_recordStarted: async (t: string) => void recorded.started.push(t),
      approval_recordSucceeded: async (t: string) => void recorded.succeeded.push(t),
      approval_recordFailedNoEffect: async (t: string, errJson: string) =>
        void recorded.failedNoEffect.push({ tool: t, err: JSON.parse(errJson) }),
    }) as unknown as AppContext
    return { ctx, recorded }
  }

  it("is a pass-through outside an approval replay (no ctx.approval)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const fn = withApprovalProtocol(async () => "ok")
    expect(await fn({}, ctx)).toBe("ok")
  })

  it("a throw BEFORE any mutation was sent records started + failed_no_effect (approval reverts to pending)", async () => {
    const { ctx, recorded } = approvalCtx(makeCtx({ fetchResponses: [] }).ctx)
    const fn = withApprovalProtocol(async () => {
      throw Object.assign(new Error("A draft order with digital goods needs a usable buyer email"), { code: "MISSING_BUYER_EMAIL" })
    })
    await expect(fn({}, ctx)).rejects.toThrow(/usable buyer email/)
    expect(recorded.started).toEqual(["shopify:tool_under_test"])
    expect(recorded.succeeded).toEqual([])
    expect(recorded.failedNoEffect).toHaveLength(1)
    expect(recorded.failedNoEffect[0]!.err).toMatchObject({ code: "MISSING_BUYER_EMAIL" })
  })

  it("a clean mutation records started + succeeded", async () => {
    const base = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrderComplete: { draftOrder: { id: "gid://shopify/DraftOrder/2", name: "#D2", status: "COMPLETED" }, userErrors: [] },
          },
        },
      ],
    })
    const { ctx, recorded } = approvalCtx(base.ctx)
    const fn = withApprovalProtocol(draft_orders_complete)
    await fn({ id: "gid://shopify/DraftOrder/2" }, ctx)
    expect(recorded.started).toEqual(["shopify:tool_under_test"])
    expect(recorded.succeeded).toEqual(["shopify:tool_under_test"])
    expect(recorded.failedNoEffect).toEqual([])
  })

  it("a Shopify userErrors rejection records failed_no_effect (definitive rejection — mutation not applied)", async () => {
    const base = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrderComplete: { draftOrder: null, userErrors: [{ field: ["email"], message: "Email contains an invalid domain name" }] },
          },
        },
      ],
    })
    const { ctx, recorded } = approvalCtx(base.ctx)
    const fn = withApprovalProtocol(draft_orders_complete)
    await expect(fn({ id: "gid://shopify/DraftOrder/3" }, ctx)).rejects.toThrow(/invalid domain name/)
    expect(recorded.failedNoEffect).toHaveLength(1)
    expect(recorded.succeeded).toEqual([])
  })

  it("an unrecognized (possibly-landed) response leaves only `started` (kernel holds it as ambiguous)", async () => {
    // Empty payload: the mutation was sent and the response shape is unknown — NOT provably
    // effect-free, so the wrapper must NOT record failed_no_effect.
    const base = makeCtx({ fetchResponses: [{ data: {} }] })
    const { ctx, recorded } = approvalCtx(base.ctx)
    const fn = withApprovalProtocol(draft_orders_complete)
    await expect(fn({ id: "gid://shopify/DraftOrder/4" }, ctx)).rejects.toThrow(/returned no payload/)
    expect(recorded.started).toEqual(["shopify:tool_under_test"])
    expect(recorded.succeeded).toEqual([])
    expect(recorded.failedNoEffect).toEqual([])
  })

  it("SHOPIFY_EMPTY_PAYLOAD carries status 502 (upstream anomaly, not a caller mistake, still pages)", async () => {
    // An empty/unexpected payload on a completed call is something Shopify did, not something
    // the caller could have avoided by fixing its input, so it must NOT default to 400 like the
    // ~40 caller-input BAD_PARAM/NOT_FOUND sites in this file.
    const { ctx } = makeCtx({ fetchResponses: [{ data: {} }] })
    await expect(draft_orders_complete({ id: "gid://shopify/DraftOrder/5" }, ctx)).rejects.toMatchObject({
      code: "SHOPIFY_EMPTY_PAYLOAD",
      status: 502,
    })
  })

  it("REGRESSION GUARD: a genuine Shopify HTTP 500 still propagates status 500 (must still page)", async () => {
    // Real upstream Shopify HTTP failures are thrown by shopify-client.ts's OWN makeError
    // (a different constructor from mutations.ts's makeMutationError), which sets status
    // straight from res.status. makeMutationError's new default-to-400 behaviour must never
    // touch that path -- a genuine Shopify 500 has to keep logging at error (paging).
    const ctx = {
      userId: "u",
      orgId: "o",
      db: {
        findMany: async (entity: string) =>
          entity === "install_metadata"
            ? [{ id: "i1", shopDomain: "demo.myshopify.com", connectionId: "ca1", apiVersion: "2026-04" }]
            : [],
        findOne: async () => null,
        insert: async () => ({ id: "x" }),
        update: async () => undefined,
        updateMany: async () => ({ count: 0 }),
        delete: async () => undefined,
        count: async () => 0,
      },
      emit: async () => undefined,
      enqueueJob: async () => undefined,
      resolveContact: async () => ({}),
      connections: {
        shop: {
          getAccounts: async () => [
            { id: "ca1", ownerType: "org" as const, ownerId: null, identifier: "demo.myshopify.com", displayName: null },
          ],
          getToken: async () => "test-token",
        },
      },
      fetch: async () => ({ status: 500, headers: {}, body: "internal server error" }),
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      agent_run: async () => "{}",
      realtime_publish: async () => "{}",
      grants_setUserScopes: async () => "{}",
      bulk: {
        fetchToBlob: async () => ({ blobId: "x", sizeBytes: 0 }),
        iterateJsonl: async function* () {},
        deleteBlob: async () => undefined,
      },
    } as unknown as AppContext
    await expect(draft_orders_complete({ id: "gid://shopify/DraftOrder/6" }, ctx)).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 500,
    })
  })

  it("an {error} envelope return (e.g. shopify_not_connected) records failed_no_effect, not succeeded", async () => {
    const { ctx, recorded } = approvalCtx(makeCtx({ fetchResponses: [] }).ctx)
    const fn = withApprovalProtocol(async () => ({ error: { code: "shopify_not_connected", message: "no connection" } }))
    await fn({}, ctx)
    expect(recorded.failedNoEffect).toHaveLength(1)
    expect(recorded.failedNoEffect[0]!.err).toMatchObject({ code: "shopify_not_connected" })
    expect(recorded.succeeded).toEqual([])
  })
})

describe("fulfillments_create", () => {
  it("calls fulfillmentCreateV2 with the `fulfillment` variable", async () => {
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            fulfillmentCreateV2: {
              fulfillment: { id: "gid://shopify/Fulfillment/1", status: "SUCCESS", trackingInfo: [] },
              userErrors: [],
            },
          },
        },
      ],
    })
    await fulfillments_create(
      { fulfillment: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/1" }] } },
      ctx,
    )
    const body = JSON.parse(calls[0]!.body) as { variables: { fulfillment: Record<string, unknown> } }
    expect(body.variables.fulfillment).toBeDefined()
    expect(events[0]!.entity).toBe("fulfillment")
    expect(events[0]!.action).toBe("created")
  })
})

describe("fulfillments_update_tracking", () => {
  it("calls fulfillmentTrackingInfoUpdateV2 and emits fulfillment:tracking_updated", async () => {
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            fulfillmentTrackingInfoUpdateV2: {
              fulfillment: {
                id: "gid://shopify/Fulfillment/7",
                status: "SUCCESS",
                trackingInfo: [{ number: "1Z999", url: "https://track", company: "UPS" }],
              },
              userErrors: [],
            },
          },
        },
      ],
    })
    await fulfillments_update_tracking(
      {
        fulfillmentId: "gid://shopify/Fulfillment/7",
        trackingInfoInput: { number: "1Z999", company: "UPS" },
        notifyCustomer: true,
      },
      ctx,
    )
    const body = JSON.parse(calls[0]!.body) as {
      variables: { fulfillmentId: string; trackingInfoInput: Record<string, unknown>; notifyCustomer: boolean }
    }
    expect(body.variables.fulfillmentId).toBe("gid://shopify/Fulfillment/7")
    expect(body.variables.notifyCustomer).toBe(true)
    expect(events[0]!.entity).toBe("fulfillment")
    expect(events[0]!.action).toBe("tracking_updated")
    expect(events[0]!.entityId).toBe("gid://shopify/Fulfillment/7")
  })

  it("throws on missing fulfillmentId", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    await expect(
      fulfillments_update_tracking({ trackingInfoInput: { number: "x" } }, ctx),
    ).rejects.toThrow(/fulfillmentId is required/)
  })

  it("throws on missing trackingInfoInput", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    await expect(
      fulfillments_update_tracking({ fulfillmentId: "gid://shopify/Fulfillment/7" }, ctx),
    ).rejects.toThrow(/trackingInfoInput is required/)
  })
})

describe("customers_update", () => {
  it("normalizes flat-shape params to { input: { id, ... } }", async () => {
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            customerUpdate: {
              customer: { id: "gid://shopify/Customer/3", email: "x@y", firstName: "X", lastName: "Y", tags: [] },
              userErrors: [],
            },
          },
        },
      ],
    })
    await customers_update({ id: "gid://shopify/Customer/3", firstName: "X" }, ctx)
    const body = JSON.parse(calls[0]!.body) as { variables: { input: { id: string; firstName?: string } } }
    expect(body.variables.input.id).toBe("gid://shopify/Customer/3")
    expect(events[0]!.entity).toBe("customer")
    expect(events[0]!.action).toBe("updated")
  })
})

// ─────────────────────────────────────────────────────────────────────────
//  C6 — Spec §3.2 mandated additional mutations
// ─────────────────────────────────────────────────────────────────────────

describe("order_update / order_cancel", () => {
  it("order_update emits shopify:order_edited with entityId", async () => {
    const { ctx, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            orderUpdate: {
              order: { id: "gid://shopify/Order/9", name: "#9", tags: ["VIP"], note: "rush" },
              userErrors: [],
            },
          },
        },
      ],
    })
    await order_update({ id: "gid://shopify/Order/9", input: { tags: ["VIP"] } }, ctx)
    expect(events[0]!.entity).toBe("order")
    expect(events[0]!.action).toBe("edited")
    expect(events[0]!.entityId).toBe("gid://shopify/Order/9")
  })

  it("order_cancel routes through orderCancel and emits entityId from orderId (not the async job GID)", async () => {
    const { ctx, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            orderCancel: {
              job: { id: "gid://shopify/Job/cancel-1" },
              userErrors: [],
            },
          },
        },
      ],
    })
    await order_cancel({ orderId: "gid://shopify/Order/9", reason: "CUSTOMER", refund: false, restock: false }, ctx)
    expect(events[0]!.entity).toBe("order")
    expect(events[0]!.action).toBe("cancel_requested")
    // entityId must be the order id, not the async job GID, so attention
    // templates can interpolate the correct order reference.
    expect(events[0]!.entityId).toBe("gid://shopify/Order/9")
  })
})

describe("order_note_set: Boxtal To prepare note sync (ungated, compare-and-set)", () => {
  const noteContract = JSON.parse(
    readFileSync(join(import.meta.dir, "__fixtures__", "contract", "order-note-contract.json"), "utf8"),
  ) as {
    orders_get: { note: string }
    order_note_set_ok: { order_id: string; note: string; previous_note: string }
    order_note_set_conflict: { order_id: string; current_note: string }
  }

  it("order_note_set accepts the long multi line non ASCII note and returns it unchanged", async () => {
    const longNote = noteContract.orders_get.note
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            orderUpdate: {
              order: { id: "gid://shopify/Order/1001", note: longNote },
              userErrors: [],
            },
          },
        },
      ],
    })
    const out = await order_note_set({ order_id: "gid://shopify/Order/1001", note: longNote }, ctx)
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.note).toBe(longNote)
      expect(out.note!.length).toBe(longNote.length)
    }
    expect(calls.length).toBe(1)
  })

  it("order_note_set matches when expected_note is the long multi line non ASCII note Shopify holds exactly", async () => {
    const longNote = noteContract.orders_get.note
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        // compare read: Shopify holds exactly the long note
        { data: { order: { id: "gid://shopify/Order/1001", note: longNote } } },
        {
          data: {
            orderUpdate: {
              order: { id: "gid://shopify/Order/1001", note: "Updated after match" },
              userErrors: [],
            },
          },
        },
      ],
    })
    const out = await order_note_set(
      { order_id: "gid://shopify/Order/1001", note: "Updated after match", expected_note: longNote },
      ctx,
    )
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.previous_note).toBe(longNote)
      expect(out.previous_note!.length).toBe(longNote.length)
    }
    // Match, not a conflict: the compare read AND the write both fire.
    expect(calls.length).toBe(2)
  })

  it("order_note_set returns the full untruncated current_note on conflict when Shopify holds a long note", async () => {
    const longNote = noteContract.order_note_set_conflict.current_note
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        // Shopify's actual note no longer matches what the editor expected.
        { data: { order: { id: "gid://shopify/Order/1001", note: longNote } } },
      ],
    })
    const out = await order_note_set(
      { order_id: "gid://shopify/Order/1001", note: "New text", expected_note: "stale expectation" },
      ctx,
    )
    expect(out).toEqual({
      ok: false,
      reason: "conflict",
      order_id: "gid://shopify/Order/1001",
      current_note: longNote,
    })
    if (!out.ok) {
      expect(out.current_note!.length).toBe(longNote.length)
    }
    // Only the compare read was sent -- no write follows a conflict.
    expect(calls.length).toBe(1)
  })

  it("order_note_set writes the note and returns the previous value", async () => {
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        // 1) compare read (expected_note present)
        { data: { order: { id: "gid://shopify/Order/1001", note: "Ship with the spare pedal" } } },
        // 2) the actual write
        {
          data: {
            orderUpdate: {
              order: { id: "gid://shopify/Order/1001", note: "New text" },
              userErrors: [],
            },
          },
        },
      ],
    })
    const out = await order_note_set(
      { order_id: "gid://shopify/Order/1001", note: "New text", expected_note: "Ship with the spare pedal" },
      ctx,
    )
    expect(out).toEqual({
      ok: true,
      order_id: "gid://shopify/Order/1001",
      note: "New text",
      previous_note: "Ship with the spare pedal",
    })
    expect(calls.length).toBe(2)
    expect(events[0]!.entity).toBe("order")
    expect(events[0]!.action).toBe("edited")
  })

  it("order_note_set refuses to clobber a note the editor never saw", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        // Quinn read "Ship with the spare pedal", but Morgan has since changed it.
        { data: { order: { id: "gid://shopify/Order/1001", note: "Morgan changed this" } } },
      ],
    })
    const out = await order_note_set(
      { order_id: "gid://shopify/Order/1001", note: "New text", expected_note: "Ship with the spare pedal" },
      ctx,
    )
    expect(out).toEqual({
      ok: false,
      reason: "conflict",
      order_id: "gid://shopify/Order/1001",
      current_note: "Morgan changed this",
    })
    // Only the compare read was sent -- no write follows a conflict.
    expect(calls.length).toBe(1)
  })

  it("order_note_set treats an expected note of null as matching an empty note in Shopify", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        // Shopify has no note at all (null).
        { data: { order: { id: "gid://shopify/Order/1006", note: null } } },
        {
          data: {
            orderUpdate: {
              order: { id: "gid://shopify/Order/1006", note: "First note" },
              userErrors: [],
            },
          },
        },
      ],
    })
    const out = await order_note_set(
      { order_id: "gid://shopify/Order/1006", note: "First note", expected_note: null },
      ctx,
    )
    expect(out).toEqual({
      ok: true,
      order_id: "gid://shopify/Order/1006",
      note: "First note",
      previous_note: null,
    })
    expect(calls.length).toBe(2)
  })

  it("order_note_set treats an expected note of empty string as matching a null note in Shopify", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { order: { id: "gid://shopify/Order/1007", note: null } } },
        {
          data: {
            orderUpdate: {
              order: { id: "gid://shopify/Order/1007", note: "First note" },
              userErrors: [],
            },
          },
        },
      ],
    })
    const out = await order_note_set(
      { order_id: "gid://shopify/Order/1007", note: "First note", expected_note: "" },
      ctx,
    )
    expect(out).toEqual({
      ok: true,
      order_id: "gid://shopify/Order/1007",
      note: "First note",
      previous_note: null,
    })
    expect(calls.length).toBe(2)
  })

  it("order_note_set reports a conflict when the editor expected an empty note and Shopify has text", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { order: { id: "gid://shopify/Order/1001", note: "Morgan changed this" } } },
      ],
    })
    const out = await order_note_set(
      { order_id: "gid://shopify/Order/1001", note: "New text", expected_note: null },
      ctx,
    )
    expect(out).toEqual({
      ok: false,
      reason: "conflict",
      order_id: "gid://shopify/Order/1001",
      current_note: "Morgan changed this",
    })
    // Only the compare read was sent -- no write follows a conflict.
    expect(calls.length).toBe(1)
  })

  it("order_note_set reports a conflict when Shopify has an empty note and the editor expected text", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { order: { id: "gid://shopify/Order/1008", note: "" } } },
      ],
    })
    const out = await order_note_set(
      { order_id: "gid://shopify/Order/1008", note: "New text", expected_note: "something" },
      ctx,
    )
    expect(out).toEqual({
      ok: false,
      reason: "conflict",
      order_id: "gid://shopify/Order/1008",
      current_note: "",
    })
    // Only the compare read was sent -- no write follows a conflict.
    expect(calls.length).toBe(1)
  })

  it("order_note_set without expected_note overwrites unconditionally", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            orderUpdate: {
              order: { id: "gid://shopify/Order/1002", note: "Last write wins" },
              userErrors: [],
            },
          },
        },
      ],
    })
    const out = await order_note_set({ order_id: "gid://shopify/Order/1002", note: "Last write wins" }, ctx)
    expect(out).toEqual({
      ok: true,
      order_id: "gid://shopify/Order/1002",
      note: "Last write wins",
      previous_note: null,
    })
    // No compare read -- straight to the write.
    expect(calls.length).toBe(1)
  })

  it("order_note_set clears the note when note is null", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        { data: { orderUpdate: { order: { id: "gid://shopify/Order/1003", note: null }, userErrors: [] } } },
      ],
    })
    const out = await order_note_set({ order_id: "gid://shopify/Order/1003", note: null }, ctx)
    expect(out).toEqual({ ok: true, order_id: "gid://shopify/Order/1003", note: null, previous_note: null })
  })

  it("order_note_set surfaces a Shopify user error instead of reporting success", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            orderUpdate: {
              order: null,
              userErrors: [{ field: ["note"], message: "Note is too long" }],
            },
          },
        },
      ],
    })
    await expect(order_note_set({ order_id: "gid://shopify/Order/1004", note: "x".repeat(9999) }, ctx)).rejects.toThrow(
      /Note is too long/,
    )
  })

  it("normalizes a bare numeric order_id to the Shopify gid before writing", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        { data: { orderUpdate: { order: { id: "gid://shopify/Order/1005", note: "hi" }, userErrors: [] } } },
      ],
    })
    await order_note_set({ order_id: "1005", note: "hi" }, ctx)
    const body = JSON.parse(calls[0]!.body) as { variables?: { input?: { id?: string } } }
    expect(body.variables?.input?.id).toBe("gid://shopify/Order/1005")
  })

  it("order note contract fixture matches the real handler output shapes", async () => {
    const contract = JSON.parse(
      readFileSync(join(import.meta.dir, "__fixtures__", "contract", "order-note-contract.json"), "utf8"),
    ) as {
      order_note_set_ok: { ok: true; order_id: string; note: string; previous_note: string }
      order_note_set_conflict: { ok: false; reason: "conflict"; order_id: string; current_note: string }
    }

    const { ctx: okCtx } = makeCtx({
      fetchResponses: [
        { data: { order: { id: contract.order_note_set_ok.order_id, note: contract.order_note_set_ok.previous_note } } },
        {
          data: {
            orderUpdate: {
              order: { id: contract.order_note_set_ok.order_id, note: contract.order_note_set_ok.note },
              userErrors: [],
            },
          },
        },
      ],
    })
    const okOut = await order_note_set(
      {
        order_id: contract.order_note_set_ok.order_id,
        note: contract.order_note_set_ok.note,
        expected_note: contract.order_note_set_ok.previous_note,
      },
      okCtx,
    )
    expect(okOut).toEqual(contract.order_note_set_ok)

    const { ctx: conflictCtx } = makeCtx({
      fetchResponses: [
        {
          data: {
            order: {
              id: contract.order_note_set_conflict.order_id,
              note: contract.order_note_set_conflict.current_note,
            },
          },
        },
      ],
    })
    const conflictOut = await order_note_set(
      {
        order_id: contract.order_note_set_conflict.order_id,
        note: "irrelevant",
        expected_note: "a note the editor saw that is no longer current",
      },
      conflictCtx,
    )
    expect(conflictOut).toEqual(contract.order_note_set_conflict)
  })
})

describe("draft_orders_update / delete / send", () => {
  it("draft_orders_update emits shopify:draft_order_updated", async () => {
    const { ctx, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrderUpdate: {
              draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1", status: "OPEN" },
              userErrors: [],
            },
          },
        },
      ],
    })
    await draft_orders_update({ id: "gid://shopify/DraftOrder/1", input: {} }, ctx)
    expect(events[0]!.action).toBe("updated")
  })

  it("draft_orders_delete sends DraftOrderDelete and emits shopify:draft_order_deleted", async () => {
    const { ctx, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrderDelete: {
              deletedId: "gid://shopify/DraftOrder/1",
              userErrors: [],
            },
          },
        },
      ],
    })
    await draft_orders_delete({ id: "gid://shopify/DraftOrder/1" }, ctx)
    expect(events[0]!.action).toBe("deleted")
    expect(events[0]!.entityId).toBe("gid://shopify/DraftOrder/1")
  })

  it("BL-137 — resolves the draft's customer email when no recipient is given", async () => {
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        // 1) resolveDraftRecipientEmail — the draft has no email of its own; the customer does.
        { data: { draftOrder: { email: null, customer: { email: "buyer@shop.com" } } } },
        // 2) the actual draftOrderInvoiceSend, now with a resolved recipient.
        {
          data: {
            draftOrderInvoiceSend: {
              draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1" },
              userErrors: [],
            },
          },
        },
      ],
    })
    await draft_orders_send({ id: "gid://shopify/DraftOrder/1" }, ctx)
    const send = JSON.parse(calls[1]!.body) as {
      query: string
      variables: { id: string; email: { to?: string } | null }
    }
    expect(send.query).toContain("DraftOrderInvoiceSend")
    expect(send.variables.email?.to).toBe("buyer@shop.com") // no more "To can't be blank"
    expect(events[0]!.action).toBe("sent")
  })

  it("uses an explicit recipient without a draft lookup", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrderInvoiceSend: {
              draftOrder: { id: "gid://shopify/DraftOrder/1", name: "#D1" },
              userErrors: [],
            },
          },
        },
      ],
    })
    await draft_orders_send({ id: "gid://shopify/DraftOrder/1", email: { to: "explicit@buyer.com" } }, ctx)
    expect(calls.length).toBe(1) // explicit recipient → no resolve query
    const send = JSON.parse(calls[0]!.body) as { query: string; variables: { email: { to?: string } } }
    expect(send.query).toContain("DraftOrderInvoiceSend")
    expect(send.variables.email.to).toBe("explicit@buyer.com")
  })
})

describe("products_publish / unpublish", () => {
  it("products_publish calls publishablePublish", async () => {
    // The handler reads the store's publications first (to validate the caller's ids), then publishes.
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            product: { id: "gid://shopify/Product/1", title: "P", resourcePublicationsV2: { edges: [] } },
            publications: { edges: [{ node: { id: "gid://shopify/Publication/1", name: "Online Store" } }] },
          },
        },
        {
          data: {
            publishablePublish: { publishable: { __typename: "Product" }, userErrors: [] },
          },
        },
      ],
    })
    await products_publish(
      { id: "gid://shopify/Product/1", input: [{ publicationId: "gid://shopify/Publication/1" }] },
      ctx,
    )
    expect(calls[1]!.body).toContain("PublishablePublish")
    expect(events[0]!.action).toBe("published")
    // I5 regression — publishablePublish returns only `publishable.__typename`,
    // so entityId must come from the input id (entityIdOverride), not the response.
    expect(events[0]!.entityId).toBe("gid://shopify/Product/1")
  })

  it("products_unpublish calls publishableUnpublish", async () => {
    // With an empty `input`, the handler resolves the product's real publications first (see the
    // dedicated regression block above), then runs PublishableUnpublish against them.
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            product: {
              id: "gid://shopify/Product/1",
              resourcePublicationsV2: {
                edges: [{ node: { publication: { id: "gid://shopify/Publication/1" }, isPublished: true } }],
              },
            },
            publications: { edges: [{ node: { id: "gid://shopify/Publication/1" } }] },
          },
        },
        {
          data: {
            publishableUnpublish: { publishable: { __typename: "Product" }, userErrors: [] },
          },
        },
      ],
    })
    await products_unpublish({ id: "gid://shopify/Product/1", input: [] }, ctx)
    expect(calls[1]!.body).toContain("PublishableUnpublish")
    expect(events[0]!.action).toBe("unpublished")
    expect(events[0]!.entityId).toBe("gid://shopify/Product/1")
  })
})

describe("customers_tag", () => {
  it("op=add (default) routes through tagsAdd and emits shopify:customer_tagged", async () => {
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        { data: { tagsAdd: { node: { id: "gid://shopify/Customer/1" }, userErrors: [] } } },
      ],
    })
    await customers_tag({ customerId: "gid://shopify/Customer/1", tags: ["VIP"] }, ctx)
    expect(calls[0]!.body).toContain("TagsAdd")
    expect(events[0]!.action).toBe("tagged")
  })

  it("op=remove routes through tagsRemove and emits shopify:customer_untagged", async () => {
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        { data: { tagsRemove: { node: { id: "gid://shopify/Customer/1" }, userErrors: [] } } },
      ],
    })
    await customers_tag({ customerId: "gid://shopify/Customer/1", tags: ["VIP"], op: "remove" }, ctx)
    expect(calls[0]!.body).toContain("TagsRemove")
    expect(events[0]!.action).toBe("untagged")
  })
})

describe("metafields_set / delete", () => {
  it("metafields_set sends metafieldsSet and emits shopify:metafield_set", async () => {
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            metafieldsSet: {
              metafields: [
                {
                  id: "gid://shopify/Metafield/1",
                  namespace: "ns",
                  key: "k",
                  value: "v",
                  type: "single_line_text_field",
                  ownerType: "PRODUCT",
                },
              ],
              userErrors: [],
            },
          },
        },
      ],
    })
    await metafields_set(
      {
        metafields: [
          {
            ownerId: "gid://shopify/Product/1",
            namespace: "ns",
            key: "k",
            value: "v",
            type: "single_line_text_field",
          },
        ],
      },
      ctx,
    )
    expect(calls[0]!.body).toContain("MetafieldsSet")
    expect(events[0]!.action).toBe("set")
    // I5 regression — entityId resolves from the first returned metafield's id
    // (entityIdPath "metafields.0.id"), not left undefined.
    expect(events[0]!.entityId).toBe("gid://shopify/Metafield/1")
  })

  it("metafields_delete sends metafieldsDelete by (ownerId,namespace,key) and emits shopify:metafield_deleted", async () => {
    // API 2026-01: metafieldDelete(id) was removed → metafieldsDelete(metafields:[MetafieldIdentifierInput]).
    const { ctx, calls, events } = makeCtx({
      fetchResponses: [
        {
          data: {
            metafieldsDelete: {
              deletedMetafields: [{ ownerId: "gid://shopify/Product/1", namespace: "custom", key: "spec" }],
              userErrors: [],
            },
          },
        },
      ],
    })
    await metafields_delete(
      { ownerId: "gid://shopify/Product/1", namespace: "custom", key: "spec" },
      ctx,
    )
    expect(calls[0]!.body).toContain("metafieldsDelete")
    expect(events[0]!.action).toBe("deleted")
    expect(events[0]!.entityId).toBe("gid://shopify/Product/1")
  })
})

// Cluster-1 (canonical event identity) — convergence guard.
//
// These tests assert that gated mutations emit `${entity}:${action}` keys that
// (a) survive the kernel emit guard (the enforcing mock would throw otherwise)
// and (b) resolve to the canonical `events:shopify:<entity>:<action>` channel.
// A drift between any emit call site and app.manifest.json#events.emits now
// fails HERE, in the unit test, instead of silently dropping the event in prod.
describe("Cluster-1 — gated mutations emit canonical entity:action keys", () => {
  it("every declared emit key is in bare `entity:action` form (no `shopify:` prefix)", () => {
    for (const key of loadDeclaredEmits()) {
      expect(key.startsWith("shopify:"), `legacy namespaced emit: ${key}`).toBe(false)
      expect(key, `not entity:action: ${key}`).toMatch(/^[a-z_]+:[a-z_]+$/)
    }
  })

  it("a gated mutation (refunds_create) emits refund:created → canonical channel", async () => {
    const { ctx, events, channels } = makeCtx({
      fetchResponses: [
        // refunds_create reads the order context first (refundable lines + parent SALE), then refunds.
        {
          data: {
            order: {
              id: "gid://shopify/Order/1",
              currencyCode: "EUR",
              lineItems: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/LineItem/1",
                      quantity: 1,
                      refundableQuantity: 1,
                      variant: { sku: "RAL-MOD" },
                      sku: "RAL-MOD",
                    },
                  },
                ],
              },
              transactions: [
                {
                  id: "gid://shopify/OrderTransaction/9",
                  kind: "SALE",
                  status: "SUCCESS",
                  gateway: "manual",
                  amountSet: { presentmentMoney: { amount: "789.00", currencyCode: "EUR" } },
                },
              ],
            },
          },
        },
        {
          data: {
            refundCreate: {
              refund: { id: "gid://shopify/Refund/77", userErrors: [] },
              userErrors: [],
            },
          },
        },
      ],
    })
    // Does NOT throw ⇒ refund:created is declared in the real manifest.
    await refunds_create({ orderId: "gid://shopify/Order/1", refundLineItems: [] }, ctx)
    expect(events.map((e) => `${e.entity}:${e.action}`)).toEqual(["refund:created"])
    expect(channels).toEqual([channelName("shopify", "refund", "created")])
  })

  it("order_update emits order:edited → canonical channel", async () => {
    const { ctx, events, channels } = makeCtx({
      fetchResponses: [
        { data: { orderUpdate: { order: { id: "gid://shopify/Order/5" }, userErrors: [] } } },
      ],
    })
    await order_update({ id: "gid://shopify/Order/5", input: { note: "x" } }, ctx)
    expect(`${events[0]!.entity}:${events[0]!.action}`).toBe("order:edited")
    expect(channels[0]).toBe(channelName("shopify", "order", "edited"))
  })
})

// BL-04 — verify the UPDATE path persists a per-line appliedDiscount. The appliedDiscount cluster was
// cured on the CREATE path (apply-on-create); it was unverified whether draft_orders_update (which runs
// the SAME normalizeDraftOrderInput then sends the full input) carries a per-line discount through to the
// draftOrderUpdate mutation. It does — pinned here so a future input-shaping change can't silently drop it.
describe("draft_orders_update — per-line appliedDiscount round-trip (BL-04)", () => {
  it("sends the line's appliedDiscount in the draftOrderUpdate mutation variables", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrderUpdate: {
              draftOrder: { id: "gid://shopify/DraftOrder/1" },
              userErrors: [],
            },
          },
        },
      ],
    })
    // A variant line already paired with an appliedDiscount needs NO normalization fetch, so the only
    // outbound call is the mutation itself.
    await draft_orders_update(
      {
        id: "gid://shopify/DraftOrder/1",
        input: {
          lineItems: [
            {
              variantId: "gid://shopify/ProductVariant/9",
              quantity: 5,
              appliedDiscount: { valueType: "PERCENTAGE", value: 40, title: "Dealer" },
            },
          ],
        },
      },
      ctx,
    )
    const mutationCall = calls.find((c) => c.body.includes("draftOrderUpdate"))
    expect(mutationCall).toBeDefined()
    const parsed = JSON.parse(mutationCall!.body) as {
      variables: { input: { lineItems: Array<{ appliedDiscount?: unknown }> } }
    }
    expect(parsed.variables.input.lineItems[0]?.appliedDiscount).toMatchObject({
      value: 40,
      valueType: "PERCENTAGE",
      title: "Dealer",
    })
  })
})

describe("canonicaliseBasicCodeDiscount — maps weak-model shapes onto Shopify DiscountCodeBasicInput", () => {
  it("reproduces the black-friday 422: flat value + allCustomers + variantConditions → nested input", () => {
    // The exact shape Flash-Lite sent that 422'd: "Field is not defined on DiscountCodeBasicInput
    // (value, customerSelection.allCustomers, variantConditions)". After canonicalisation the
    // percentage lives at customerGets.value.percentage (0.15 fraction), the audience at
    // customerSelection.all, and the product scope at customerGets.items.products.productsToAdd.
    const out = canonicaliseBasicCodeDiscount({
      title: "Black Friday Studio Bundle",
      code: "BF2026-STUDIO",
      startsAt: "2026-11-27T00:00:00Z",
      endsAt: "2026-12-01T23:59:59Z",
      value: 15,
      customerSelection: { allCustomers: true },
      variantConditions: ["gid://shopify/Product/123"],
    })
    expect(out).toEqual({
      title: "Black Friday Studio Bundle",
      code: "BF2026-STUDIO",
      startsAt: "2026-11-27T00:00:00Z",
      endsAt: "2026-12-01T23:59:59Z",
      customerSelection: { all: true },
      customerGets: {
        value: { percentage: 0.15 },
        items: { products: { productsToAdd: ["gid://shopify/Product/123"] } },
      },
    })
    // No hallucinated top-level fields survive.
    expect("value" in out).toBe(false)
    expect("variantConditions" in out).toBe(false)
  })

  it("accepts a 0.15 fraction unchanged and a '15%' string", () => {
    expect(
      (canonicaliseBasicCodeDiscount({ code: "X", percentage: 0.15 }).customerGets as Record<string, unknown>).value,
    ).toEqual({ percentage: 0.15 })
    expect(
      (canonicaliseBasicCodeDiscount({ code: "X", value: "15%" }).customerGets as Record<string, unknown>).value,
    ).toEqual({ percentage: 0.15 })
  })

  it("accepts the already-correct nested shape (idempotent), normalising a whole-percent inside it", () => {
    const out = canonicaliseBasicCodeDiscount({
      code: "Y",
      customerSelection: { all: true },
      customerGets: { value: { percentage: 15 }, items: { products: { productsToAdd: ["gid://shopify/Product/9"] } } },
    })
    expect(out.customerGets).toEqual({
      value: { percentage: 0.15 },
      items: { products: { productsToAdd: ["gid://shopify/Product/9"] } },
    })
  })

  it("falls back to {all:true} for an EMPTY/invalid customer selection (the gate 422 regression)", () => {
    // The live 422: 'Customer selection a minimum of one prerequisite … must be provided' — an empty
    // customers list. Each invalid form must canonicalise to a valid {all:true}.
    for (const sel of [{ customers: [] }, { customers: { add: [] } }, { all: false }, { customerSegments: [] }]) {
      const out = canonicaliseBasicCodeDiscount({ code: "BF2026-STUDIO", percentage: 15, customerSelection: sel })
      expect(out.customerSelection).toEqual({ all: true })
    }
  })

  it("honours a NON-empty customer/segment selection in Shopify's {add:[...]} shape", () => {
    expect(
      canonicaliseBasicCodeDiscount({ code: "X", percentage: 10, customerSelection: { customers: ["gid://shopify/Customer/5"] } }).customerSelection,
    ).toEqual({ customers: { add: ["gid://shopify/Customer/5"] } })
    expect(
      canonicaliseBasicCodeDiscount({ code: "X", percentage: 10, customerSelection: { customerSegments: { add: ["gid://shopify/Segment/9"] } } }).customerSelection,
    ).toEqual({ customerSegments: { add: ["gid://shopify/Segment/9"] } })
  })

  it("defaults to items:{all:true} and customerSelection:{all:true} when no scope/audience given", () => {
    const out = canonicaliseBasicCodeDiscount({ code: "Z", percentage: 10 })
    expect(out.customerSelection).toEqual({ all: true })
    expect((out.customerGets as Record<string, unknown>).items).toEqual({ all: true })
  })

  it("collects product GIDs from productIds / products / a {id} object", () => {
    const out = canonicaliseBasicCodeDiscount({
      code: "P",
      percentage: 20,
      products: [{ id: "gid://shopify/Product/1" }, "gid://shopify/Product/2"],
    })
    const gets = out.customerGets as { items: { products: { productsToAdd: string[] } } }
    expect(gets.items.products.productsToAdd).toEqual([
      "gid://shopify/Product/1",
      "gid://shopify/Product/2",
    ])
  })

  it("routes a ProductVariant gid to productVariantsToAdd (the weak-model products_search variant-id scope)", () => {
    // The black-friday gate failure: the agent scoped with the VARIANT gid it got from products_search.
    // A variant gid in productsToAdd 422s/blanks the scope — it must land in productVariantsToAdd.
    const out = canonicaliseBasicCodeDiscount({
      code: "BF2026-STUDIO",
      percentage: 15,
      products: ["gid://shopify/ProductVariant/56669053419686"],
    })
    const gets = out.customerGets as { items: { products: Record<string, unknown> } }
    expect(gets.items.products.productVariantsToAdd).toEqual(["gid://shopify/ProductVariant/56669053419686"])
    expect("productsToAdd" in gets.items.products).toBe(false)
  })

  it("classifies a mixed product+variant scope into the two correct Shopify lists", () => {
    const out = canonicaliseBasicCodeDiscount({
      code: "M",
      percentage: 15,
      productIds: ["gid://shopify/Product/9"],
      variantIds: ["gid://shopify/ProductVariant/77"],
    })
    const gets = out.customerGets as { items: { products: Record<string, unknown> } }
    expect(gets.items.products.productsToAdd).toEqual(["gid://shopify/Product/9"])
    expect(gets.items.products.productVariantsToAdd).toEqual(["gid://shopify/ProductVariant/77"])
  })

  it("finds the percent under varied weak-model keys so customerGets.value is never blank", () => {
    // The other live 422: 'customerGets.value: Value can't be blank' when the percent is parked off the
    // canonical path. Each of these must still resolve to value:{percentage:0.15}.
    for (const shape of [
      { code: "A", percentageOff: 15 },
      { code: "B", discountValue: 15 },
      { code: "C", customerGets: { percentage: 15 } },
      { code: "D", customerGets: { value: { percentageValue: 15 } } },
      // The exact 422 case: a value RECORD with NO amount, percent parked alongside under customerGets.
      { code: "E", customerGets: { value: { appliesOnEachItem: true }, percentage: 15 } },
      { code: "F", customerGets: { value: { appliesOnEachItem: true } }, percentage: 15 },
      // Deep-scan backstop: percent under an unanticipated percent-implying key, nested.
      { code: "G", discount: { rate: 15 } },
      { code: "H", customerGets: { discountPercentage: 15, items: { all: true } } },
      { code: "I", off: "15%" },
    ]) {
      const out = canonicaliseBasicCodeDiscount(shape)
      expect((out.customerGets as Record<string, unknown>).value).toEqual({ percentage: 0.15 })
    }
  })

  it("deep-scan never mistakes a non-percent count (usageLimit/quantity) for the discount value", () => {
    // No percent-keyed number anywhere → no fabricated value (a value-less customerGets is the genuine
    // agent error, not something to invent a discount for). usageLimit:50 must NOT become 50%.
    const out = canonicaliseBasicCodeDiscount({ code: "X", usageLimit: 50, quantity: 25 })
    expect((out.customerGets as Record<string, unknown> | undefined)?.value).toBeUndefined()
  })

  it("defaults title to the code when none given (Shopify requires a title)", () => {
    expect(canonicaliseBasicCodeDiscount({ code: "BF2026-STUDIO", percentage: 15 }).title).toBe("BF2026-STUDIO")
  })

  it("recovers `code` from an alias / title when top-level code is missing (the 'Code can't be blank' 422)", () => {
    // Shopify requires `code`; a weak model sometimes omits it and parks the coupon string elsewhere.
    expect(canonicaliseBasicCodeDiscount({ discountCode: "BF2026-STUDIO", percentage: 15 }).code).toBe("BF2026-STUDIO")
    expect(canonicaliseBasicCodeDiscount({ couponCode: "BF2026-STUDIO", percentage: 15 }).code).toBe("BF2026-STUDIO")
    expect(canonicaliseBasicCodeDiscount({ title: "BF2026-STUDIO", percentage: 15 }).code).toBe("BF2026-STUDIO")
    // An explicit code is never overridden by an alias.
    expect(canonicaliseBasicCodeDiscount({ code: "REAL", discountCode: "ALIAS", percentage: 15 }).code).toBe("REAL")
  })

  it("REJECTS usageLimit:0 instead of turning it into an unlimited code", () => {
    // Shopify 422s on 0, and dropping it silently would make an approved "limit 0" code unlimited.
    expect(() =>
      canonicaliseBasicCodeDiscount({ code: "BF2026-STUDIO", percentage: 15, usageLimit: 0 }),
    ).toThrow(/usageLimit must be a whole number of at least 1/)
  })

  it("keeps a positive whole usageLimit and rejects a fractional, negative or non-numeric one", () => {
    expect(canonicaliseBasicCodeDiscount({ code: "X", percentage: 10, usageLimit: 25 }).usageLimit).toBe(25)
    for (const bad of [5.9, -3, "lots"]) {
      expect(() => canonicaliseBasicCodeDiscount({ code: "X", percentage: 10, usageLimit: bad })).toThrow(/usageLimit/)
    }
  })

  it("rejects recurringCycleLimit:0 likewise", () => {
    expect(() => canonicaliseBasicCodeDiscount({ code: "X", percentage: 10, recurringCycleLimit: 0 })).toThrow(
      /recurringCycleLimit/,
    )
  })

  it("rejects an ambiguous or out-of-range percentage instead of guessing", () => {
    for (const bad of [1, "1", 0, -5, 150, "abc"]) {
      expect(() => canonicaliseBasicCodeDiscount({ code: "X", percentage: bad })).toThrow(/percentage/)
    }
    const pct = (v: unknown) =>
      ((canonicaliseBasicCodeDiscount({ code: "X", percentage: v }).customerGets as Record<string, unknown>)
        .value as { percentage: number }).percentage
    expect(pct("1%")).toBe(0.01)
    expect(pct("100%")).toBe(1)
    expect(pct(0.15)).toBe(0.15)
    expect(pct(15)).toBe(0.15)
  })
})

describe("discounts_create — sends the canonicalised DiscountCodeBasicInput to Shopify (no 422 passthrough)", () => {
  const createResp = { data: { discountCodeBasicCreate: { codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/77" }, userErrors: [] } } }

  it("normalises the weak-model flat shape before the mutation (end-to-end gated payload)", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [createResp] })
    await discounts_create(
      {
        title: "BF2026-STUDIO",
        code: "BF2026-STUDIO",
        startsAt: "2026-11-27T00:00:00Z",
        endsAt: "2026-12-01T23:59:59Z",
        value: 15,
        customerSelection: { allCustomers: true },
        variantConditions: ["gid://shopify/Product/123"],
      },
      ctx,
    )
    const body = JSON.parse(calls[0]!.body) as { variables: { basicCodeDiscount: Record<string, unknown> } }
    const bcd = body.variables.basicCodeDiscount
    expect(bcd.customerSelection).toEqual({ all: true })
    expect(bcd.customerGets).toEqual({
      value: { percentage: 0.15 },
      items: { products: { productsToAdd: ["gid://shopify/Product/123"] } },
    })
    expect("value" in bcd).toBe(false)
    expect("variantConditions" in bcd).toBe(false)
    expect(bcd.code).toBe("BF2026-STUDIO")
  })

  it("unwraps a basicCodeDiscount wrapper and normalises it", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [createResp] })
    await discounts_create({ basicCodeDiscount: { code: "C", percentage: 25 } }, ctx)
    const body = JSON.parse(calls[0]!.body) as { variables: { basicCodeDiscount: Record<string, unknown> } }
    expect((body.variables.basicCodeDiscount.customerGets as Record<string, unknown>).value).toEqual({ percentage: 0.25 })
  })

  it("refuses usageLimit:0 at stage time, so no approval is ever parked for it", async () => {
    const r = await discounts_create_preflight({
      code: "BF2026-STUDIO",
      percentage: 15,
      usageLimit: 0,
      customerSelection: { allCustomers: true },
    })
    expect("error" in r).toBe(true)
  })
})

describe("canonicaliseBasicCodeDiscountPartial — an update is a delta, never force-injects defaults", () => {
  it("deactivate (only endsAt) sends ONLY endsAt — no customerSelection/customerGets clobber", () => {
    expect(canonicaliseBasicCodeDiscountPartial({ endsAt: "2026-11-30T00:00:00Z" })).toEqual({
      endsAt: "2026-11-30T00:00:00Z",
    })
  })
  it("normalises a supplied value but leaves audience untouched when not supplied", () => {
    const out = canonicaliseBasicCodeDiscountPartial({ value: 20 })
    expect(out.customerGets).toBeDefined()
    expect("customerSelection" in out).toBe(false)
  })

  it("discounts_update sends only the delta", async () => {
    const updateResp = { data: { discountCodeBasicUpdate: { codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/77" }, userErrors: [] } } }
    const { ctx, calls } = makeCtx({ fetchResponses: [updateResp] })
    await discounts_update({ id: "gid://shopify/DiscountCodeNode/77", endsAt: "2026-11-30T00:00:00Z" }, ctx)
    const body = JSON.parse(calls[0]!.body) as { variables: { id: string; basicCodeDiscount: Record<string, unknown> } }
    expect(body.variables.id).toBe("gid://shopify/DiscountCodeNode/77")
    expect(body.variables.basicCodeDiscount).toEqual({ endsAt: "2026-11-30T00:00:00Z" })
  })
})

describe("discounts_bulk_create — N unique single-use codes on one code discount in ONE gated op", () => {
  const DISCOUNT_ID = "gid://shopify/DiscountCodeNode/900"

  // The four Shopify calls the tool makes, in order: (1) discountCodeBasicCreate (carries codes[0]),
  // (2) discountRedeemCodeBulkAdd (the remaining codes, async), (3) the bulk-creation status poll,
  // (4) the read-back of the actual persisted codes. `persistedCodes` is what the store returns.
  const responses = (persistedCodes: string[], opts?: { failedCount?: number }) => [
    { data: { discountCodeBasicCreate: { codeDiscountNode: { id: DISCOUNT_ID }, userErrors: [] } } },
    { data: { discountRedeemCodeBulkAdd: { bulkCreation: { id: "gid://shopify/DiscountRedeemCodeBulkCreation/1" }, userErrors: [] } } },
    { data: { discountRedeemCodeBulkCreation: { id: "gid://shopify/DiscountRedeemCodeBulkCreation/1", done: true, codesCount: persistedCodes.length, importedCount: persistedCodes.length - (opts?.failedCount ?? 0), failedCount: opts?.failedCount ?? 0 } } },
    { data: { codeDiscountNode: { id: DISCOUNT_ID, codeDiscount: { __typename: "DiscountCodeBasic", title: "Synth Summit Press — Kestrel 6", codes: { nodes: persistedCodes.map((code) => ({ code })) } } } } },
  ]

  it("creates a 50% Kestrel 6 discount and bulk-adds 25 UNIQUE single-use codes in one op; returns the real codes", async () => {
    const persisted = Array.from({ length: 25 }, (_, i) => `SYNTH-SUMMIT-CODE${String(i).padStart(2, "0")}`)
    const { ctx, calls, events } = makeCtx({ fetchResponses: responses(persisted) })
    const out = (await discounts_bulk_create(
      {
        count: 25,
        codePrefix: "SYNTH-SUMMIT",
        basicCodeDiscount: {
          title: "Synth Summit Press — Kestrel 6",
          percentage: 50, // weak-model whole-percent → coerced to 0.5
          productIds: ["gid://shopify/Product/44"],
        },
      },
      ctx,
    )) as { discountId: string; createdCount: number; requestedCount: number; codes: string[] }

    // Exactly four Shopify calls — the agent made ONE gated tool call, not 25 creates.
    expect(calls.length).toBe(4)

    // (1) The code discount create normalised the weak-model shape: 50 → 0.5 fraction, single-use defaults,
    //     scoped to the Kestrel 6 product, carrying the first code.
    const createBody = JSON.parse(calls[0]!.body) as { variables: { basicCodeDiscount: Record<string, unknown> } }
    const bcd = createBody.variables.basicCodeDiscount
    expect((bcd.customerGets as { value: { percentage: number } }).value.percentage).toBe(0.5)
    expect(bcd.usageLimit).toBe(1) // single-use per code
    expect(bcd.appliesOncePerCustomer).toBe(true)
    // Shopify REQUIRES startsAt — the press ask gives no window, so the tool defaults it to a valid ISO
    // datetime (live chaos 422'd "Starts at can't be blank" without this).
    expect(typeof bcd.startsAt).toBe("string")
    expect(() => new Date(bcd.startsAt as string).toISOString()).not.toThrow()
    expect(Number.isNaN(Date.parse(bcd.startsAt as string))).toBe(false)
    expect((bcd.customerGets as { items: { products: { productsToAdd: string[] } } }).items.products.productsToAdd)
      .toContain("gid://shopify/Product/44")
    expect(typeof bcd.code).toBe("string")

    // (2) The bulk-add carried the REMAINING 24 codes (codes[0] is on the create).
    const addBody = JSON.parse(calls[1]!.body) as { variables: { discountId: string; codes: { code: string }[] } }
    expect(addBody.variables.discountId).toBe(DISCOUNT_ID)
    expect(addBody.variables.codes.length).toBe(24)

    // The tool returns the REAL persisted codes (the ground truth), all 25, all unique, all prefixed.
    expect(out.discountId).toBe(DISCOUNT_ID)
    expect(out.requestedCount).toBe(25)
    expect(out.createdCount).toBe(25)
    expect(out.codes).toEqual(persisted)
    expect(new Set(out.codes).size).toBe(25)
    expect(out.codes.every((c) => c.startsWith("SYNTH-SUMMIT-"))).toBe(true)

    // Emits the canonical discount:bulk_created event keyed to the discount.
    expect(events).toHaveLength(1)
    expect(events[0]!.entity).toBe("discount")
    expect(events[0]!.action).toBe("bulk_created")
    expect(events[0]!.entityId).toBe(DISCOUNT_ID)
  })

  it("ANTI-FABRICATION: returns ONLY the codes the store actually persisted, never the requested count", async () => {
    // The store persisted only 23 of the 25 (a phantom drop). The tool must report the REAL 23, never claim 25.
    const persisted = Array.from({ length: 23 }, (_, i) => `PRESS-${i}`)
    const { ctx } = makeCtx({ fetchResponses: responses(persisted) })
    const out = (await discounts_bulk_create({ count: 25, codePrefix: "PRESS", basicCodeDiscount: { percentage: 50 } }, ctx)) as {
      createdCount: number
      requestedCount: number
      codes: string[]
    }
    expect(out.requestedCount).toBe(25)
    expect(out.createdCount).toBe(23) // ground truth, NOT the request
    expect(out.codes.length).toBe(23)
  })

  // Two not-yet-done status polls before the done one: the poll waits between iterations.
  const respondsAfterTwoPendingPolls = (persistedCodes: string[]) => {
    const r = responses(persistedCodes)
    const pending = { data: { discountRedeemCodeBulkCreation: { id: "gid://shopify/DiscountRedeemCodeBulkCreation/1", done: false, codesCount: null, importedCount: null, failedCount: null } } }
    return [r[0]!, r[1]!, pending, pending, r[2]!, r[3]!]
  }

  it("waits 250 ms then 500 ms between status polls where the runtime has a timer", async () => {
    const persisted = ["P-1", "P-2", "P-3"]
    const { ctx, calls } = makeCtx({ fetchResponses: respondsAfterTwoPendingPolls(persisted) })
    const delays = await withTimer("recording", async (d) => {
      const out = (await discounts_bulk_create({ count: 3, codePrefix: "P", basicCodeDiscount: { percentage: 50 } }, ctx)) as { createdCount: number }
      expect(out.createdCount).toBe(3)
      return d
    })
    expect(calls.length).toBe(6)
    expect(delays).toEqual([250, 500])
  })

  it("polls without waiting, and still completes, where the runtime has no timer", async () => {
    const persisted = ["P-1", "P-2", "P-3"]
    const { ctx, calls } = makeCtx({ fetchResponses: respondsAfterTwoPendingPolls(persisted) })
    const out = (await withTimer("absent", () =>
      discounts_bulk_create({ count: 3, codePrefix: "P", basicCodeDiscount: { percentage: 50 } }, ctx),
    )) as { createdCount: number }
    expect(out.createdCount).toBe(3)
    expect(calls.length).toBe(6)
  })

  it("THROWS LOUD when the async bulk job reports failures (never silently returns a partial batch)", async () => {
    const persisted = Array.from({ length: 25 }, (_, i) => `PRESS-${i}`)
    const { ctx } = makeCtx({ fetchResponses: responses(persisted, { failedCount: 3 }) })
    await expect(
      discounts_bulk_create({ count: 25, codePrefix: "PRESS", basicCodeDiscount: { percentage: 50 } }, ctx),
    ).rejects.toThrow(/failed to import/i)
  })

  it("honours an explicit startsAt window instead of defaulting to now", async () => {
    const persisted = ["P-0", "P-1"]
    const { ctx, calls } = makeCtx({ fetchResponses: responses(persisted) })
    await discounts_bulk_create(
      { count: 2, codePrefix: "P", basicCodeDiscount: { percentage: 50, startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-09-08T00:00:00Z" } },
      ctx,
    )
    const createBody = JSON.parse(calls[0]!.body) as { variables: { basicCodeDiscount: Record<string, unknown> } }
    expect(createBody.variables.basicCodeDiscount.startsAt).toBe("2026-09-01T00:00:00Z")
    expect(createBody.variables.basicCodeDiscount.endsAt).toBe("2026-09-08T00:00:00Z")
  })

  it("re-polls the async job until done (no setTimeout — pacing comes from the round-trip)", async () => {
    // The sandbox has NO setTimeout; the poll must simply re-query. First poll: not done; second: done.
    const persisted = ["P-0", "P-1", "P-2"]
    const { ctx, calls } = makeCtx({ fetchResponses: [
      { data: { discountCodeBasicCreate: { codeDiscountNode: { id: DISCOUNT_ID }, userErrors: [] } } },
      { data: { discountRedeemCodeBulkAdd: { bulkCreation: { id: "job/1" }, userErrors: [] } } },
      { data: { discountRedeemCodeBulkCreation: { id: "job/1", done: false, codesCount: null, importedCount: null, failedCount: null } } },
      { data: { discountRedeemCodeBulkCreation: { id: "job/1", done: true, codesCount: 3, importedCount: 3, failedCount: 0 } } },
      { data: { codeDiscountNode: { id: DISCOUNT_ID, codeDiscount: { __typename: "DiscountCodeBasic", title: "P", codes: { nodes: persisted.map((code) => ({ code })) } } } } },
    ] })
    const out = (await discounts_bulk_create({ count: 3, codePrefix: "P", basicCodeDiscount: { percentage: 50 } }, ctx)) as { createdCount: number }
    expect(out.createdCount).toBe(3)
    // create + bulk-add + 2 polls + read-back = 5 calls.
    expect(calls.length).toBe(5)
  })

  it("count=1 makes a single code with NO bulk-add call (degenerate batch)", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [
      { data: { discountCodeBasicCreate: { codeDiscountNode: { id: DISCOUNT_ID }, userErrors: [] } } },
      { data: { codeDiscountNode: { id: DISCOUNT_ID, codeDiscount: { __typename: "DiscountCodeBasic", title: "P", codes: { nodes: [{ code: "P-AAA" }] } } } } },
    ] })
    const out = (await discounts_bulk_create({ count: 1, codePrefix: "P", basicCodeDiscount: { percentage: 50 } }, ctx)) as { createdCount: number }
    // Only the create + the read-back — no bulk-add (nothing to add beyond codes[0]).
    expect(calls.length).toBe(2)
    expect(out.createdCount).toBe(1)
  })

  it("propagates a discountCodeBasicCreate userError instead of swallowing it", async () => {
    const { ctx } = makeCtx({ fetchResponses: [
      { data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ["code"], message: "Code must be unique" }] } } },
    ] })
    await expect(
      discounts_bulk_create({ count: 5, codePrefix: "P", basicCodeDiscount: { percentage: 50 } }, ctx),
    ).rejects.toThrow(/Code must be unique/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────
//  STAGE-TIME preflights on the gated mutations (manifest `preflight`)
// ─────────────────────────────────────────────────────────────────────────
//
// A gated call parks a pending approval for a human. Every check below used to run only INSIDE the
// post-approval handler, so the human approved a card that then failed on data only the agent could
// have supplied (and on products_merge, only after the merge had started). These tests pin the
// refusal at STAGE time: the preflight returns a typed error, and NO mutation reaches Shopify (the
// handler is never entered, so no approval is created either: execute-tool returns the preflight
// error before it builds one, and manifest.test.ts pins that wiring).
describe("stage-time preflights refuse a gated call whose required data is missing", () => {
  /** Every GraphQL body a preflight sent that is a WRITE. A preflight must send none. */
  const mutationBodies = (calls: Array<{ body: string }>): string[] =>
    calls.map((c) => c.body).filter((b) => /"query":\s*"[^"]*\\n?\s*mutation|mutation [A-Z]/.test(b))

  it("products_merge_preflight refuses a survivor gid that resolves to no product, before anything is deleted", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [{ data: { product: null } }] })
    const out = await products_merge_preflight(
      { survivorId: "gid://shopify/Product/1", duplicateId: "gid://shopify/Product/2" },
      ctx,
    )
    expect("error" in out).toBe(true)
    const err = (out as { error: { code: string; message: string } }).error
    expect(err.code).toBe("NOT_FOUND")
    expect(err.message).toContain("survivor (keep)")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("products_merge_preflight passes a merge whose two listings both resolve", async () => {
    const product = (id: string) => ({
      data: {
        product: {
          id,
          title: "T",
          handle: "h",
          hasOnlyDefaultVariant: true,
          options: [],
          variants: { edges: [] },
        },
      },
    })
    const { ctx, calls } = makeCtx({
      fetchResponses: [product("gid://shopify/Product/1"), product("gid://shopify/Product/2")],
    })
    const out = await products_merge_preflight(
      { survivorId: "gid://shopify/Product/1", duplicateId: "gid://shopify/Product/2" },
      ctx,
    )
    expect(out).toEqual({ ok: true })
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("draft_orders_create_preflight refuses digital goods with no usable buyer email", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        // variantsRequireShipping: the line is a license (no shipping) -> the license needs an email.
        { data: { nodes: [{ id: "gid://shopify/ProductVariant/1", inventoryItem: { requiresShipping: false } }] } },
      ],
    })
    const out = await draft_orders_create_preflight(
      { input: { lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }] } },
      ctx,
    )
    expect("error" in out).toBe(true)
    expect((out as { error: { code: string } }).error.code).toBe("MISSING_BUYER_EMAIL")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("draft_orders_create_preflight refuses physical goods with nowhere to ship", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        { data: { nodes: [{ id: "gid://shopify/ProductVariant/1", inventoryItem: { requiresShipping: true } }] } },
      ],
    })
    const out = await draft_orders_create_preflight(
      { input: { email: "buyer@tessera-test.fr", billingAddress: { firstName: "Ada" }, lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }] } },
      ctx,
    )
    expect("error" in out).toBe(true)
    expect((out as { error: { code: string } }).error.code).toBe("MISSING_SHIPPING_ADDRESS")
  })

  it("draft_orders_create_preflight REFUSES an unresolvable variant gid instead of degrading it to a custom line", async () => {
    // The whole point: the line used to lose its variantId and become a variant-less custom line, so
    // the draft that executed was not the draft on the approval card (different item, no SKU, no
    // stock decrement). It must be refused at staging.
    const { ctx, calls } = makeCtx({
      fetchResponses: [{ data: { node: null } }], // lookupVariantPrice: the variant does not resolve
    })
    const out = await draft_orders_create_preflight(
      { input: { email: "buyer@tessera-test.fr", lineItems: [{ variantId: "gid://shopify/ProductVariant/404", price: "50.00", quantity: 1 }] } },
      ctx,
    )
    expect("error" in out).toBe(true)
    const err = (out as { error: { code: string; message: string } }).error
    expect(err.code).toBe("VARIANT_UNRESOLVED")
    expect(err.message).toContain("gid://shopify/ProductVariant/404")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("draft_orders_create_preflight REFUSES a product gid with no resolvable variant (same silent-degrade path)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [{ data: { product: { variants: { nodes: [] } } } }],
    })
    const out = await draft_orders_create_preflight(
      { input: { email: "buyer@tessera-test.fr", lineItems: [{ productId: "gid://shopify/Product/404", price: "50.00", quantity: 1 }] } },
      ctx,
    )
    expect("error" in out).toBe(true)
    expect((out as { error: { code: string } }).error.code).toBe("VARIANT_UNRESOLVED")
  })

  it("draft_orders_create itself refuses the unresolvable variant gid (the guard is not preflight-only)", async () => {
    const { ctx, events } = makeCtx({ fetchResponses: [{ data: { node: null } }] })
    await expect(
      draft_orders_create(
        { input: { email: "buyer@tessera-test.fr", lineItems: [{ variantId: "gid://shopify/ProductVariant/404", price: "50.00", quantity: 1 }] } },
        ctx,
      ),
    ).rejects.toThrow(/does not resolve in this store/)
    expect(events).toHaveLength(0)
  })

  it("draft_orders_create_preflight passes a complete digital draft (does NOT block a real one)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        { data: { nodes: [{ id: "gid://shopify/ProductVariant/1", inventoryItem: { requiresShipping: false } }] } },
      ],
    })
    const out = await draft_orders_create_preflight(
      { input: { email: "buyer@tessera-test.fr", billingAddress: { firstName: "Ada", lastName: "L" }, lineItems: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 1 }] } },
      ctx,
    )
    expect(out).toEqual({ ok: true })
  })

  it("fulfillments_create_preflight refuses an order with no OPEN fulfillment orders", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [{ data: { order: { fulfillmentOrders: { nodes: [] } } } }],
    })
    const out = await fulfillments_create_preflight({ orderId: "gid://shopify/Order/9" }, ctx)
    expect("error" in out).toBe(true)
    expect((out as { error: { code: string } }).error.code).toBe("NO_FULFILLABLE_ITEMS")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("fulfillments_create_preflight refuses a call with neither orderId nor lineItemsByFulfillmentOrder", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [] })
    const out = await fulfillments_create_preflight({}, ctx)
    expect("error" in out).toBe(true)
    expect((out as { error: { code: string } }).error.code).toBe("BAD_PARAM")
    expect(calls).toHaveLength(0)
  })

  it("fulfillments_create_preflight passes an order that still has an open fulfillment order", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        { data: { order: { fulfillmentOrders: { nodes: [{ id: "gid://shopify/FulfillmentOrder/5", status: "OPEN" }] } } } },
      ],
    })
    expect(await fulfillments_create_preflight({ orderId: "gid://shopify/Order/9" }, ctx)).toEqual({ ok: true })
  })

  it("variants_update_preflight refuses a variant gid that resolves to no owning product", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [{ data: { productVariant: null } }] })
    const out = await variants_update_preflight(
      { input: { id: "gid://shopify/ProductVariant/404", price: "10.00" } },
      ctx,
    )
    expect("error" in out).toBe(true)
    const err = (out as { error: { code: string; message: string } }).error
    expect(err.code).toBe("NOT_FOUND")
    expect(err.message).toContain("cannot resolve productId")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("variants_delete_preflight refuses a variant gid that resolves to no owning product", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [{ data: { productVariant: null } }] })
    const out = await variants_delete_preflight({ id: "gid://shopify/ProductVariant/404" }, ctx)
    expect("error" in out).toBe(true)
    expect((out as { error: { code: string } }).error.code).toBe("NOT_FOUND")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("variants_update_preflight passes a variant that resolves (and one that carries its own productId)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [{ data: { productVariant: { product: { id: "gid://shopify/Product/7" } } } }],
    })
    expect(await variants_update_preflight({ input: { id: "gid://shopify/ProductVariant/9", price: "1.00" } }, ctx)).toEqual({ ok: true })
    const { ctx: ctx2, calls } = makeCtx({ fetchResponses: [] })
    expect(
      await variants_update_preflight(
        { input: { id: "gid://shopify/ProductVariant/9", productId: "gid://shopify/Product/7", price: "1.00" } },
        ctx2,
      ),
    ).toEqual({ ok: true })
    expect(calls).toHaveLength(0) // a supplied productId needs no lookup
  })

  it("order_update_preflight refuses a field orderUpdate cannot change (it would silently no-op)", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [] })
    const out = await order_update_preflight(
      { input: { id: "gid://shopify/Order/9", shippingAddress: { address1: "1 New St" } } },
      ctx,
    )
    expect("error" in out).toBe(true)
    const err = (out as { error: { code: string; message: string } }).error
    expect(err.code).toBe("ORDER_UPDATE_UNSUPPORTED_FIELD")
    expect(err.message).toContain("shippingAddress")
    expect(calls).toHaveLength(0)
  })

  it("order_update_preflight passes a tags/note edit", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    expect(await order_update_preflight({ input: { id: "gid://shopify/Order/9", tags: ["vip"] } }, ctx)).toEqual({ ok: true })
  })

  it("products_update_preflight refuses an ORDER gid passed to the product tool", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [] })
    const out = await products_update_preflight({ input: { id: "gid://shopify/Order/9", tags: ["vip"] } }, ctx)
    expect("error" in out).toBe(true)
    const err = (out as { error: { code: string; message: string } }).error
    expect(err.code).toBe("WRONG_ENTITY_FOR_TOOL")
    expect(err.message).toContain("order_update")
    expect(calls).toHaveLength(0)
  })

  it("products_update_preflight passes a real product edit", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    expect(await products_update_preflight({ input: { id: "gid://shopify/Product/1", title: "X" } }, ctx)).toEqual({ ok: true })
  })

  it("inventory_adjust_preflight refuses an absolute count handed to the relative delta tool", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [] })
    const out = await inventory_adjust_preflight(
      { input: { changes: [{ inventoryItemId: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/1", newQuantity: 47 }] } },
      ctx,
    )
    expect("error" in out).toBe(true)
    const err = (out as { error: { code: string; message: string } }).error
    expect(err.message).toContain("inventory_set_on_hand")
    expect(calls).toHaveLength(0)
  })

  it("inventory_adjust_preflight passes a genuine signed delta", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    const out = await inventory_adjust_preflight(
      { input: { changes: [{ inventoryItemId: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/1", delta: -2 }] } },
      ctx,
    )
    expect(out).toEqual({ ok: true })
  })

  it("products_unpublish_preflight refuses when the store has no sales-channel publications", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [{ data: { product: { resourcePublicationsV2: { edges: [] } }, publications: { edges: [] } } }],
    })
    const out = await products_unpublish_preflight({ id: "gid://shopify/Product/1" }, ctx)
    expect("error" in out).toBe(true)
    expect((out as { error: { code: string } }).error.code).toBe("NO_PUBLICATIONS")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("products_unpublish_preflight passes a product that is published somewhere", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        { data: { product: { resourcePublicationsV2: { edges: [{ node: { publication: { id: "gid://shopify/Publication/1" }, isPublished: true } }] } }, publications: { edges: [] } } },
      ],
    })
    expect(await products_unpublish_preflight({ id: "gid://shopify/Product/1" }, ctx)).toEqual({ ok: true })
  })
})

// ─────────────────────────────────────────────────────────────────────────
//  STAGE-TIME preflights, second batch: the destructive and state-machine tools
// ─────────────────────────────────────────────────────────────────────────
//
// A re-audit found these wrongly classified as safe to stage unchecked. Every one of them took an
// id and NOTHING ELSE was verified, so an id that resolved to nothing, an id for the wrong kind of
// record, or a record in a state that cannot admit the transition all produced an approval card
// that looked perfectly legitimate and could only fail once the human clicked approve. On
// products_delete that meant the APPROVER, not the agent, met Shopify's raw userError on a
// PERMANENT delete. Each test below pins the refusal at STAGE time and pins that NO mutation was
// sent (the handler is never entered and no approval is created).
describe("stage-time preflights refuse a destructive gated call whose target is wrong or unusable", () => {
  /** Every GraphQL body a preflight sent that is a WRITE. A preflight must send none. */
  const mutationBodies = (calls: Array<{ body: string }>): string[] =>
    calls.map((c) => c.body).filter((b) => /"query":\s*"[^"]*\\n?\s*mutation|mutation [A-Z]/.test(b))
  const errorOf = (out: unknown): { code: string; message: string } => {
    expect("error" in (out as object)).toBe(true)
    return (out as { error: { code: string; message: string } }).error
  }
  const node = (typename: string, status?: string) => ({
    data: { node: { id: `gid://shopify/${typename}/1`, __typename: typename, ...(status ? { status } : {}) } },
  })
  const NO_NODE = { data: { node: null } }

  it("products_delete_preflight refuses a product gid that resolves to nothing, before the permanent delete is staged", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [NO_NODE] })
    const err = errorOf(await products_delete_preflight({ id: "gid://shopify/Product/404" }, ctx))
    expect(err.code).toBe("NOT_FOUND")
    expect(err.message).toContain("products_delete")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("products_delete_preflight refuses an ORDER gid handed to the product delete tool, with no lookup at all", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [] })
    const err = errorOf(await products_delete_preflight({ id: "gid://shopify/Order/9" }, ctx))
    expect(err.code).toBe("WRONG_ENTITY_FOR_TOOL")
    expect(calls).toHaveLength(0)
  })

  it("products_delete_preflight passes a product that resolves", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [node("Product")] })
    expect(await products_delete_preflight({ id: "gid://shopify/Product/1" }, ctx)).toEqual({ ok: true })
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("order_cancel_preflight refuses an order id that resolves to nothing", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [NO_NODE] })
    const err = errorOf(await order_cancel_preflight({ orderId: "gid://shopify/Order/404" }, ctx))
    expect(err.code).toBe("NOT_FOUND")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("order_cancel_preflight refuses a PRODUCT gid handed to the order cancel tool", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [node("Product")] })
    const err = errorOf(await order_cancel_preflight({ orderId: "gid://shopify/Product/1" }, ctx))
    expect(err.code).toBe("WRONG_ENTITY_FOR_TOOL")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("draft_orders_delete_preflight refuses a draft gid that resolves to nothing", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [NO_NODE] })
    const err = errorOf(await draft_orders_delete_preflight({ id: "gid://shopify/DraftOrder/404" }, ctx))
    expect(err.code).toBe("NOT_FOUND")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("discounts_delete_preflight refuses a discount gid that resolves to nothing", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [NO_NODE] })
    const err = errorOf(await discounts_delete_preflight({ id: "gid://shopify/DiscountCodeNode/404" }, ctx))
    expect(err.code).toBe("NOT_FOUND")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("discounts_update_preflight refuses a discount gid that resolves to nothing", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [NO_NODE] })
    const err = errorOf(
      await discounts_update_preflight({ id: "gid://shopify/DiscountCodeNode/404", endsAt: "2026-11-30T00:00:00Z" }, ctx),
    )
    expect(err.code).toBe("NOT_FOUND")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("returns_approve_preflight refuses a return that is not awaiting a decision", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [node("Return", "OPEN")] })
    const err = errorOf(await returns_approve_preflight({ id: "gid://shopify/Return/1" }, ctx))
    expect(err.code).toBe("INVALID_STATE")
    expect(err.message).toContain("OPEN")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("returns_approve_preflight passes a return that is still REQUESTED", async () => {
    const { ctx } = makeCtx({ fetchResponses: [node("Return", "REQUESTED")] })
    expect(await returns_approve_preflight({ id: "gid://shopify/Return/1" }, ctx)).toEqual({ ok: true })
  })

  it("returns_decline_preflight refuses a return that has already been closed", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [node("Return", "CLOSED")] })
    const err = errorOf(
      await returns_decline_preflight({ id: "gid://shopify/Return/1", declineReason: "FINAL_SALE" }, ctx),
    )
    expect(err.code).toBe("INVALID_STATE")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("returns_close_preflight refuses a return that is still only REQUESTED", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [node("Return", "REQUESTED")] })
    const err = errorOf(await returns_close_preflight({ id: "gid://shopify/Return/1" }, ctx))
    expect(err.code).toBe("INVALID_STATE")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("returns_refund_preflight refuses a refund against a DECLINED return (money must not be staged)", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [node("Return", "DECLINED")] })
    const err = errorOf(
      await returns_refund_preflight(
        { returnRefundInput: { returnId: "gid://shopify/Return/1", returnRefundLineItems: [] } },
        ctx,
      ),
    )
    expect(err.code).toBe("INVALID_STATE")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("returns_refund_preflight refuses a call with no returnId at all", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [] })
    const err = errorOf(await returns_refund_preflight({ returnRefundInput: { returnRefundLineItems: [] } }, ctx))
    expect(err.code).toBe("BAD_PARAM")
    expect(calls).toHaveLength(0)
  })

  it("fulfillments_cancel_preflight refuses a fulfillment that is already cancelled", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [node("Fulfillment", "CANCELLED")] })
    const err = errorOf(await fulfillments_cancel_preflight({ id: "gid://shopify/Fulfillment/1" }, ctx))
    expect(err.code).toBe("INVALID_STATE")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("fulfillments_cancel_preflight passes a fulfillment that shipped successfully", async () => {
    const { ctx } = makeCtx({ fetchResponses: [node("Fulfillment", "SUCCESS")] })
    expect(await fulfillments_cancel_preflight({ id: "gid://shopify/Fulfillment/1" }, ctx)).toEqual({ ok: true })
  })

  it("customers_update_preflight refuses a customer gid that resolves to nothing", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [NO_NODE] })
    const err = errorOf(await customers_update_preflight({ id: "gid://shopify/Customer/404", firstName: "X" }, ctx))
    expect(err.code).toBe("NOT_FOUND")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("customers_tag_preflight refuses an ORDER gid, which tagsAdd would have tagged silently", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [node("Order")] })
    const err = errorOf(await customers_tag_preflight({ customerId: "gid://shopify/Order/9", tags: ["VIP"] }, ctx))
    expect(err.code).toBe("WRONG_ENTITY_FOR_TOOL")
    expect(err.message).toContain("Order")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("products_publish_preflight refuses a product gid that resolves to nothing", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [NO_NODE] })
    const err = errorOf(await products_publish_preflight({ id: "gid://shopify/Product/404", input: [] }, ctx))
    expect(err.code).toBe("NOT_FOUND")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("inventory_set_on_hand_preflight refuses an inventoryItemId/locationId pair that does not resolve", async () => {
    // The silent-zero: the live on-hand lookup used to report 0 for a pair that does not exist, so a
    // typo was indistinguishable from a genuine zero and became an approved write against a
    // fabricated optimistic baseline.
    const { ctx, calls } = makeCtx({ fetchResponses: [{ data: { inventoryItem: null } }] })
    const err = errorOf(
      await inventory_set_on_hand_preflight(
        { inventoryItemId: "gid://shopify/InventoryItem/404", locationId: "gid://shopify/Location/1", quantity: 12 },
        ctx,
      ),
    )
    expect(err.code).toBe("NOT_FOUND")
    expect(err.message).toContain("gid://shopify/Location/1")
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("inventory_set_on_hand_preflight passes a GENUINE zero on-hand (0 is a real count, not a missing pair)", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [{ data: { inventoryItem: { inventoryLevel: { quantities: [{ name: "on_hand", quantity: 0 }] } } } }],
    })
    const out = await inventory_set_on_hand_preflight(
      { inventoryItemId: "gid://shopify/InventoryItem/1", locationId: "gid://shopify/Location/1", quantity: 12 },
      ctx,
    )
    expect(out).toEqual({ ok: true })
    expect(mutationBodies(calls)).toHaveLength(0)
  })

  it("products_delete_preflight refuses a call with no id at all, without a single lookup", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [] })
    const err = errorOf(await products_delete_preflight({}, ctx))
    expect(err.code).toBe("BAD_PARAM")
    expect(err.message).toBe("id is required")
    expect(calls).toHaveLength(0)
  })

  it("inventory_set_on_hand_preflight refuses a row carrying a quantity but no inventoryItemId or locationId", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [] })
    const err = errorOf(await inventory_set_on_hand_preflight({ quantity: 12 }, ctx))
    expect(err.code).toBe("BAD_PARAM")
    expect(err.message).toContain("inventoryItemId")
    expect(calls).toHaveLength(0)
  })

  it("inventory_set_on_hand itself throws on the unresolvable pair and sends NO mutation (the guard is not preflight-only)", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [{ data: { inventoryItem: { inventoryLevel: null } } }] })
    await expect(
      inventory_set_on_hand(
        { inventoryItemId: "gid://shopify/InventoryItem/404", locationId: "gid://shopify/Location/1", quantity: 12 },
        ctx,
      ),
    ).rejects.toThrow(/no stock level/i)
    expect(mutationBodies(calls)).toHaveLength(0)
  })
})

describe("customerShippingEmail policy: retail orders get Shopify's shipping email, B2B never", () => {
  // The org's policy decides notifyCustomer server side for every fulfilment path, whatever the
  // caller passed. Under retail_only a retail order is emailed (with the tracking on the same
  // create), a B2B order never is, and an unreadable fact means no email (fail closed).
  const created = {
    data: {
      fulfillmentCreateV2: {
        fulfillment: { id: "gid://shopify/Fulfillment/1", status: "SUCCESS", trackingInfo: [] },
        userErrors: [],
      },
    },
  }
  const order = (extra: Record<string, unknown>) => ({
    data: {
      order: {
        id: "gid://shopify/Order/1056",
        fulfillmentOrders: { nodes: [{ id: "gid://shopify/FulfillmentOrder/9001", status: "OPEN" }] },
        ...extra,
      },
    },
  })
  const companyBuyer = { purchasingEntity: { company: { name: "Example Trading Ltd" } }, lineItems: { nodes: [] } }
  const consumerBuyer = { purchasingEntity: {}, lineItems: { nodes: [{ sku: "KS6-44" }] } }
  const markedSku = { purchasingEntity: {}, lineItems: { nodes: [{ sku: "KS6-44" }, { sku: "KS6-44-b2b" }] } }
  const retailOnly = { customerShippingEmail: "retail_only", b2bSkuSuffixes: " -WHOLESALE , -B2B " }
  const sentFulfillment = (calls: Array<{ body: string }>, index: number) =>
    (JSON.parse(calls[index]!.body) as { variables: { fulfillment: Record<string, unknown> } }).variables.fulfillment
  // The exact payload the Boxtal packed tick and the carrier-scan webhook send (fulfillment.ts).
  const boxtalCall = {
    orderId: "gid://shopify/Order/1056",
    fulfillment: { trackingInfo: { number: "1Z999", company: "UPS" }, notifyCustomer: false },
  }
  const notice = (res: unknown) => (res as { customerNotification?: { notified: boolean; reason: string; message: string } }).customerNotification

  it("asks Shopify for the buyer company and the line skus with the open fulfillment orders", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [order(consumerBuyer), created], config: retailOnly })
    await fulfillments_create(boxtalCall, ctx)
    const lookup = JSON.parse(calls[0]!.body) as { query: string }
    expect(lookup.query).toContain("PurchasingCompany")
    expect(lookup.query).toMatch(/lineItems\(first: \d+\) \{ nodes \{ sku \} \}/)
  })

  it("retail_only: Boxtal's tick / webhook payload (notifyCustomer false) emails a retail customer, with the tracking", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [order(consumerBuyer), created], config: retailOnly })
    const res = await fulfillments_create(boxtalCall, ctx)
    const sent = sentFulfillment(calls, 1)
    expect(sent.notifyCustomer).toBe(true)
    expect(sent.trackingInfo).toEqual({ number: "1Z999", company: "UPS" })
    expect(notice(res)).toMatchObject({ notified: true, reason: "retail_order" })
  })

  it("retail_only: a B2B company buyer is never emailed, even when the caller asks", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [order(companyBuyer), created], config: retailOnly })
    const res = await fulfillments_create(
      { orderId: "gid://shopify/Order/1056", fulfillment: { notifyCustomer: true } },
      ctx,
    )
    expect(sentFulfillment(calls, 1).notifyCustomer).toBe(false)
    expect(notice(res)).toMatchObject({ notified: false, reason: "b2b_company_buyer" })
    expect(notice(res)?.message).toMatch(/B2B/)
  })

  it("retail_only: a B2B sku suffix (any case, comma separated) is never emailed on the Boxtal path", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [order(markedSku), created], config: retailOnly })
    const res = await fulfillments_create(boxtalCall, ctx)
    expect(sentFulfillment(calls, 1).notifyCustomer).toBe(false)
    expect(notice(res)?.reason).toBe("b2b_sku_suffix")
  })

  it("retail_only: Boxtal's PARTIAL batch payload follows the policy too", async () => {
    const partial = (buyer: Record<string, unknown>) => ({
      data: {
        order: {
          id: "gid://shopify/Order/1056",
          ...buyer,
          fulfillmentOrders: {
            nodes: [
              {
                id: "gid://shopify/FulfillmentOrder/9001",
                status: "OPEN",
                lineItems: {
                  nodes: [
                    { id: "gid://shopify/FulfillmentOrderLineItem/1", remainingQuantity: 2, lineItem: { id: "gid://shopify/LineItem/11", sku: "KS6-44" } },
                  ],
                },
              },
            ],
          },
        },
      },
    })
    const call = { ...boxtalCall, lineItems: [{ sku: "KS6-44", quantity: 1 }] }
    const retail = makeCtx({ fetchResponses: [partial(consumerBuyer), created], config: retailOnly })
    await fulfillments_create(call, retail.ctx)
    expect(sentFulfillment(retail.calls, 1).notifyCustomer).toBe(true)
    const b2b = makeCtx({ fetchResponses: [partial(companyBuyer), created], config: retailOnly })
    await fulfillments_create(call, b2b.ctx)
    expect(sentFulfillment(b2b.calls, 1).notifyCustomer).toBe(false)
  })

  it("retail_only: a prebuilt lineItemsByFulfillmentOrder looks the order up; unreadable order = no email (fail closed)", async () => {
    const prebuilt = {
      fulfillment: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/9001" }],
        trackingInfo: { number: "1Z999" },
        notifyCustomer: true,
      },
    }
    const foOrder = (o: unknown) => ({ data: { fulfillmentOrder: { id: "gid://shopify/FulfillmentOrder/9001", order: o } } })
    const retail = makeCtx({ fetchResponses: [foOrder({ id: "gid://shopify/Order/1056", ...consumerBuyer }), created], config: retailOnly })
    await fulfillments_create(prebuilt, retail.ctx)
    expect(sentFulfillment(retail.calls, 1).notifyCustomer).toBe(true)
    const unreadable = makeCtx({ fetchResponses: [foOrder(null), created], config: retailOnly })
    const res = await fulfillments_create(prebuilt, unreadable.ctx)
    expect(sentFulfillment(unreadable.calls, 1).notifyCustomer).toBe(false)
    expect(notice(res)).toMatchObject({ notified: false, reason: "undecided_fail_closed" })
  })

  it("fail closed: the policy or the suffix setting unreadable at execution means no email, and the result says so", async () => {
    for (const config of [
      { get: async () => Promise.reject(new Error("config store down")) },
      {
        get: async (key: string) => {
          if (key === "customerShippingEmail") return "retail_only"
          throw new Error("config store down")
        },
      },
    ]) {
      const { ctx, calls } = makeCtx({ fetchResponses: [order(consumerBuyer), created] })
      ;(ctx as { config: unknown }).config = config
      const res = await fulfillments_create(
        { orderId: "gid://shopify/Order/1056", fulfillment: { notifyCustomer: true } },
        ctx,
      )
      expect(sentFulfillment(calls, 1).notifyCustomer).toBe(false)
      expect(notice(res)?.reason).toBe("undecided_fail_closed")
    }
  })

  it("policy unset: the caller's flag stands, B2B or not, with no notice (today's behaviour)", async () => {
    const b2b = makeCtx({ fetchResponses: [order(companyBuyer), created], config: { b2bSkuSuffixes: "-B2B" } })
    const res = await fulfillments_create({ orderId: "gid://shopify/Order/1056", fulfillment: { notifyCustomer: true } }, b2b.ctx)
    expect(sentFulfillment(b2b.calls, 1).notifyCustomer).toBe(true)
    expect(notice(res)).toBeUndefined()
    const boxtal = makeCtx({ fetchResponses: [order(consumerBuyer), created] })
    await fulfillments_create(boxtalCall, boxtal.ctx)
    expect(sentFulfillment(boxtal.calls, 1).notifyCustomer).toBe(false)
  })

  it("policies all and none ignore the caller and the order", async () => {
    const all = makeCtx({ fetchResponses: [order(companyBuyer), created], config: { customerShippingEmail: "all" } })
    await fulfillments_create(boxtalCall, all.ctx)
    expect(sentFulfillment(all.calls, 1).notifyCustomer).toBe(true)
    const none = makeCtx({ fetchResponses: [order(consumerBuyer), created], config: { customerShippingEmail: "none" } })
    await fulfillments_create({ orderId: "gid://shopify/Order/1056", fulfillment: { notifyCustomer: true } }, none.ctx)
    expect(sentFulfillment(none.calls, 1).notifyCustomer).toBe(false)
  })

  it("no tracking on the create: no email under retail_only or all (it goes out with the first tracking number)", async () => {
    for (const config of [retailOnly, { customerShippingEmail: "all" }]) {
      const { ctx, calls } = makeCtx({ fetchResponses: [order(consumerBuyer), created], config })
      const res = await fulfillments_create({ orderId: "gid://shopify/Order/1056", fulfillment: { notifyCustomer: true } }, ctx)
      expect(sentFulfillment(calls, 1).notifyCustomer).toBe(false)
      expect(notice(res)).toMatchObject({ notified: false, reason: "no_tracking" })
    }
    // A placeholder number ("N/A") is no tracking either.
    const { ctx, calls } = makeCtx({ fetchResponses: [order(consumerBuyer), created], config: retailOnly })
    await fulfillments_create({ orderId: "gid://shopify/Order/1056", fulfillment: { trackingInfo: { number: "N/A", company: "UPS" } } }, ctx)
    expect(sentFulfillment(calls, 1).notifyCustomer).toBe(false)
  })

  describe("fulfillments_update_tracking: one shipping email per fulfilment, sent with its first tracking number", () => {
    const updated = {
      data: {
        fulfillmentTrackingInfoUpdateV2: {
          fulfillment: { id: "gid://shopify/Fulfillment/7", status: "SUCCESS", trackingInfo: [] },
          userErrors: [],
        },
      },
    }
    const current = (buyer: Record<string, unknown>, numbers: string[]) => ({
      data: {
        fulfillment: {
          id: "gid://shopify/Fulfillment/7",
          trackingInfo: numbers.map((number) => ({ number })),
          order: { id: "gid://shopify/Order/1056", ...buyer },
        },
      },
    })
    // The tracking mutation is always the last call (the fulfilment read happens only when needed).
    const sentNotify = (calls: Array<{ body: string }>) =>
      (JSON.parse(calls[calls.length - 1]!.body) as { query: string; variables: { notifyCustomer: boolean } })
    const update = (info: Record<string, unknown>, notifyCustomer?: boolean) => ({
      fulfillmentId: "gid://shopify/Fulfillment/7",
      trackingInfoInput: info,
      ...(notifyCustomer !== undefined ? { notifyCustomer } : {}),
    })

    it("the first tracking number on an untracked fulfilment emails the customer once (retail_only and all)", async () => {
      for (const config of [retailOnly, { customerShippingEmail: "all" }]) {
        const { ctx, calls } = makeCtx({ fetchResponses: [current(consumerBuyer, []), updated], config })
        const res = await fulfillments_update_tracking(update({ number: "1Z999", company: "UPS" }), ctx)
        const sent = sentNotify(calls)
        expect(sent.query).toContain("fulfillmentTrackingInfoUpdateV2")
        expect(sent.variables.notifyCustomer).toBe(true)
        expect(notice(res)?.notified).toBe(true)
      }
    })

    it("a number change on an already tracked fulfilment never emails again", async () => {
      for (const config of [retailOnly, { customerShippingEmail: "all" }]) {
        const { ctx, calls } = makeCtx({ fetchResponses: [current(consumerBuyer, ["OLD1"]), updated], config })
        const res = await fulfillments_update_tracking(update({ number: "1Z999", company: "UPS" }, true), ctx)
        expect(sentNotify(calls).variables.notifyCustomer).toBe(false)
        expect(notice(res)).toMatchObject({ notified: false, reason: "already_notified" })
      }
    })

    it("the same number again never emails", async () => {
      const { ctx, calls } = makeCtx({ fetchResponses: [current(consumerBuyer, ["1Z999"]), updated], config: retailOnly })
      const res = await fulfillments_update_tracking(update({ number: "1Z999" }, true), ctx)
      expect(sentNotify(calls).variables.notifyCustomer).toBe(false)
      expect(notice(res)?.reason).toBe("already_notified")
    })

    it("an update changing only the carrier or the url never emails, tracked or not", async () => {
      for (const numbers of [[], ["1Z999"]]) {
        for (const config of [retailOnly, { customerShippingEmail: "all" }]) {
          // Under "all" nothing needs the fulfilment read: an update without a number never emails.
          const reads = config === retailOnly ? [current(consumerBuyer, numbers)] : []
          const { ctx, calls } = makeCtx({ fetchResponses: [...reads, updated], config })
          const res = await fulfillments_update_tracking(
            update({ company: "DHL", url: "https://track.example.com/1Z999" }, true),
            ctx,
          )
          expect(sentNotify(calls).variables.notifyCustomer).toBe(false)
          expect(notice(res)?.notified).toBe(false)
        }
      }
      const { ctx } = makeCtx({ fetchResponses: [current(consumerBuyer, []), updated], config: retailOnly })
      const res = await fulfillments_update_tracking(update({ company: "DHL" }), ctx)
      expect(notice(res)?.reason).toBe("no_tracking")
    })

    it("the fulfilment's current tracking unreadable: no email (fail closed)", async () => {
      const { ctx, calls } = makeCtx({ fetchResponses: [{ data: { fulfillment: null } }, updated], config: { customerShippingEmail: "all" } })
      const res = await fulfillments_update_tracking(update({ number: "1Z999" }), ctx)
      expect(sentNotify(calls).variables.notifyCustomer).toBe(false)
      expect(notice(res)?.reason).toBe("undecided_fail_closed")
    })

    it("retail_only: a B2B order's tracking update never emails, even its first number", async () => {
      const { ctx, calls } = makeCtx({ fetchResponses: [current(companyBuyer, []), updated], config: retailOnly })
      const res = await fulfillments_update_tracking(update({ number: "1Z999" }, true), ctx)
      expect(sentNotify(calls).variables.notifyCustomer).toBe(false)
      expect(notice(res)?.reason).toBe("b2b_company_buyer")
    })

    it("policy unset: the caller's flag stands, with no notice and no fulfilment read", async () => {
      const yes = makeCtx({ fetchResponses: [updated] })
      const res = await fulfillments_update_tracking(update({ number: "1Z999" }, true), yes.ctx)
      expect(yes.calls).toHaveLength(1)
      expect(sentNotify(yes.calls).variables.notifyCustomer).toBe(true)
      expect(notice(res)).toBeUndefined()
      const no = makeCtx({ fetchResponses: [updated] })
      await fulfillments_update_tracking(update({ company: "DHL" }), no.ctx)
      expect(sentNotify(no.calls).variables.notifyCustomer).toBe(false)
    })
  })
})
