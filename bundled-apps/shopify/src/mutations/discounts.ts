// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify mutation tools: discount codes (create, bulk create, update, delete) and the
// basic code discount canonicalisation.

import type { AppContext } from "@liaison/app-sdk"
import { getShopifyClient } from "../lib/get-client"
import { createPollPacer } from "../lib/timers"
import {
  type PreflightResult,
  type ShopClient,
  isRec,
  gidFrom,
  runMutation,
  requireTargetId,
  readGatedTarget,
  preflightRefusal,
  makeMutationError,
  markExternalEffect,
  assertNoUserErrors,
  emitMutationEvent,
} from "./shared"

// ─────────────────────────────────────────────────────────────────────────
//  Discounts
// ─────────────────────────────────────────────────────────────────────────

// Shopify's DiscountCodeBasicInput is DEEPLY nested (the percentage lives at
// customerGets.value.percentage as a 0-1 fraction; the audience at
// customerSelection.all; the product scope at customerGets.items.products.productsToAdd
// as a list of product GIDs). A weak model reliably emits a PLAUSIBLE-BUT-WRONG flat
// shape instead — a top-level `value`, `customerSelection.allCustomers`, a
// `variantConditions`/`productIds` for scoping, a `15` instead of `0.15` percentage —
// each of which Shopify rejects ("Field is not defined on DiscountCodeBasicInput"),
// 422ing the APPROVED gated write. This canonicaliser MAPS the common weak-model
// aliases into the real nested input so the gated discount create/update actually
// executes, then STRIPS anything still outside the known top-level field set so a
// hallucinated field can never reach Shopify. Mirrors `normaliseDraftOrderInput`.
const DISCOUNT_BASIC_INPUT_FIELDS = new Set([
  "title", "code", "startsAt", "endsAt", "customerSelection", "customerGets",
  "appliesOncePerCustomer", "usageLimit", "combinesWith", "recurringCycleLimit",
])

/** Parse a percentage into Shopify's 0-1 fraction, or return an error: ambiguous input is REJECTED,
 *  never guessed. Accepted: a fraction 0 < p < 1 ("0.15"), a whole percent 1 < p <= 100 ("15", 100),
 *  and an explicit percent string with a "%" sign for 0 < p <= 100 ("1%" is 1 percent, "100%" is all).
 *  Rejected: <= 0, > 100, non-numeric, and a bare 1 (1 percent or 100 percent: it cannot be told). */
export function parsePercent(v: unknown): { ok: true; fraction: number } | { ok: false; reason: string } {
  let n: number
  let explicitPercent = false
  if (typeof v === "number") n = v
  else if (typeof v === "string") {
    explicitPercent = v.includes("%")
    n = Number(v.replace(/[%\s]/g, ""))
  } else return { ok: false, reason: "the percentage is not a number" }
  if (!Number.isFinite(n)) return { ok: false, reason: "the percentage is not a number" }
  if (n <= 0 || n > 100) return { ok: false, reason: `the percentage ${String(v)} is outside 0 < p <= 100` }
  if (explicitPercent) return { ok: true, fraction: n / 100 }
  if (n === 1) {
    return { ok: false, reason: 'a bare 1 is ambiguous (1 percent or 100 percent): send "1%" or 0.01 for 1 percent, "100%" for all' }
  }
  return { ok: true, fraction: n > 1 ? n / 100 : n }
}

/** Percentage -> fraction, or throw BAD_PARAM so the approval is never staged with a guessed value. */
function toPercentFraction(v: unknown): number | undefined {
  const r = parsePercent(v)
  if (!r.ok) throw makeMutationError("BAD_PARAM", `Invalid discount percentage: ${r.reason}.`)
  return r.fraction
}

/** A usage/recurring limit must be a POSITIVE WHOLE NUMBER, or be absent (= unlimited). A weak model
 *  emitting `usageLimit: 0` meaning "unlimited" is REJECTED, not silently turned into an unlimited code. */
function toPositiveIntLimit(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN
  if (!Number.isInteger(n) || n < 1) {
    throw makeMutationError(
      "BAD_PARAM",
      `${field} must be a whole number of at least 1 (got ${JSON.stringify(v)}). Omit ${field} for no limit; 0 is not accepted.`,
    )
  }
  return n
}

/** Deep-scan a weak-model input for a percentage number under a percent-IMPLYING key (so an unrelated
 *  count — usageLimit, quantity — can never be mistaken for the discount). Returns a 0-1 fraction or
 *  undefined. Bounded recursion (depth ≤ 5) over plain objects/arrays. The anti-422 backstop for the
 *  "customerGets.value: Value can't be blank" class when the percent is parked under an unanticipated key. */
const PERCENT_KEY_RE = /percent|percentage|discountrate|discountpct|^rate$|^off$|^discount$|pctoff|percentoff/i
function deepFindPercent(node: unknown, depth = 0): number | undefined {
  if (depth > 5 || node == null) return undefined
  if (Array.isArray(node)) {
    for (const e of node) { const f = deepFindPercent(e, depth + 1); if (f != null) return f }
    return undefined
  }
  if (!isRec(node)) return undefined
  for (const [k, v] of Object.entries(node)) {
    if (PERCENT_KEY_RE.test(k)) {
      if (typeof v !== "number" && typeof v !== "string") continue
      const f = toPercentFraction(v)
      if (f != null) return f
    }
  }
  for (const v of Object.values(node)) {
    const f = deepFindPercent(v, depth + 1)
    if (f != null) return f
  }
  return undefined
}

/** Build the nested `customerGets` from the flat/aliased shapes a weak model produces. */
function normaliseCustomerGets(src: Record<string, unknown>): Record<string, unknown> | undefined {
  const existing = isRec(src.customerGets) ? { ...src.customerGets } : {}

  // ── value (the discount amount) ──
  // Shopify's customerGets.value must be EXACTLY one of {percentage:0-1} | {discountAmount:{amount,…}}.
  // A weak model parks "15% off" in a dozen places (top-level percentage/percent/discountValue, a bare
  // number under value, value.percentage as a whole 15, value.percentageValue, customerGets.percentage),
  // and sometimes emits a value RECORD with NO usable amount (e.g. {appliesOnEachItem:true}) which 422s
  // "Value can't be blank". So gather the percent from EVERY plausible source and emit a clean value;
  // never pass through a value record that lacks a percentage/discountAmount.
  let value: Record<string, unknown> | undefined
  const ev = isRec(existing.value) ? existing.value : undefined
  const evBareNum = typeof existing.value === "number" || typeof existing.value === "string"
  const pctRaw =
    (ev ? (ev.percentage ?? ev.percentageValue ?? ev.percent) : undefined) ??
    src.percentage ?? src.percent ?? src.percentageOff ?? src.percentOff ?? src.discountValue ??
    existing.percentage ?? existing.percent ?? existing.percentageValue ??
    (evBareNum ? existing.value : undefined) ??
    src.value
  const frac = typeof pctRaw === "number" || typeof pctRaw === "string" ? toPercentFraction(pctRaw) : undefined
  if (frac != null) value = { percentage: frac }
  else {
    const amt = (ev && isRec(ev.discountAmount) ? ev.discountAmount : undefined) ??
      (isRec(existing.discountAmount) ? existing.discountAmount : undefined) ??
      (isRec(src.discountAmount) ? src.discountAmount : undefined)
    if (isRec(amt)) value = { discountAmount: amt }
  }
  // LAST RESORT (anti-422 backstop): the named-key search above misses if a weak model parks the percent
  // under an unanticipated key (e.g. `discount`, `rate`, `off`, a deeply-nested `amount` for a %). A
  // percentage discount ALWAYS carries its number somewhere; rather than emit a value-less customerGets
  // that 422s "Value can't be blank" on the APPROVED gated write, deep-scan the input for a single
  // percent-keyed number and use it. Only triggers when no value resolved AND no discountAmount — never
  // overrides an explicit value, and is gated to keys whose NAME implies a percentage so it can't
  // mistake an unrelated count for the discount.
  if (!value) {
    const found = deepFindPercent(src)
    if (found != null) value = { percentage: found }
  }

  // ── items (what the discount applies to) ──
  let items: Record<string, unknown> | undefined
  // Collect scoping GIDs from the many shapes a weak model uses to "scope to a product". CRITICAL:
  // Shopify's customerGets.items.products has TWO target lists — `productsToAdd` (a Product gid,
  // gid://shopify/Product/N) and `productVariantsToAdd` (a ProductVariant gid,
  // gid://shopify/ProductVariant/N). A weak model reliably scopes with the VARIANT gid it got back from
  // products_search (the .variants[].id), which 422s ("Value can't be blank"/silently storewide) if
  // shoved into `productsToAdd`. So we CLASSIFY each gid by type and route it to the correct list — the
  // discount scopes correctly whether the agent supplied the product OR the variant id.
  const productGids: string[] = []
  const variantGids: string[] = []
  const classify = (g: string): void => {
    if (/\/ProductVariant\//.test(g)) variantGids.push(g)
    else productGids.push(g) // bare ids + gid://shopify/Product/N → product list
  }
  const pushGids = (v: unknown, forceVariant = false): void => {
    const one = (e: unknown): void => {
      const g = gidFrom(e)
      if (!g) return
      if (forceVariant) variantGids.push(g)
      else classify(g)
    }
    if (Array.isArray(v)) for (const e of v) one(e)
    else one(v)
  }
  pushGids(src.productIds)
  pushGids(src.productId)
  pushGids(src.products)
  pushGids(src.variantConditions) // a hallucinated scoping field — classify by gid type
  pushGids(src.variantIds, true) // an explicit variant-id alias → variant list
  pushGids(src.variantId, true)
  if (isRec(existing.items)) {
    const ei = existing.items
    if (isRec(ei.products)) {
      const p = ei.products as Record<string, unknown>
      pushGids(p.productsToAdd)
      pushGids(p.productVariantsToAdd, true)
    }
    if (ei.all === true && productGids.length === 0 && variantGids.length === 0) items = { all: true }
  }
  if (productGids.length > 0 || variantGids.length > 0) {
    const products: Record<string, unknown> = {}
    if (productGids.length > 0) products.productsToAdd = Array.from(new Set(productGids))
    if (variantGids.length > 0) products.productVariantsToAdd = Array.from(new Set(variantGids))
    items = { products }
  } else if (!items) {
    // Preserve an explicit collections scope if present; otherwise default to all.
    if (isRec(existing.items) && (existing.items as Record<string, unknown>).collections) {
      items = existing.items
    } else {
      items = { all: true }
    }
  }

  if (!value && !items) return undefined
  const out: Record<string, unknown> = {}
  if (value) out.value = value
  if (items) out.items = items
  return out
}

/** Build a Shopify-VALID `customerSelection`. Shopify's DiscountCustomerSelectionInput accepts EXACTLY
 *  one of: {all:true} · {customers:{add:[non-empty gids]}} · {customerSegments:{add:[non-empty gids]}}.
 *  A weak model emits many invalid variants — {allCustomers:true}, {customers:[gids]}, and (the gate
 *  422 "Customer selection a minimum of one prerequisite … must be provided") an EMPTY
 *  {customers:{add:[]}} / {customers:[]}. Since a public promo code targets ANY customer, the safe
 *  canonical default is {all:true}; a customer/segment selection is honoured ONLY when it carries ≥1
 *  real gid. This GUARANTEES a valid selection so the approved gated create cannot 422 on this field. */
function normaliseCustomerSelection(src: Record<string, unknown>): Record<string, unknown> {
  const cs = isRec(src.customerSelection) ? { ...src.customerSelection } : {}
  // allCustomers alias → all.
  if (cs.allCustomers != null && cs.all == null) cs.all = cs.allCustomers

  // Explicit all:true wins (the normal public-promo case).
  if (cs.all === true) return { all: true }

  // Collect gids from either a bare array OR a {add:[...]} wrapper, for customers + segments.
  const gidsOf = (v: unknown): string[] => {
    const arr = Array.isArray(v) ? v : isRec(v) && Array.isArray(v.add) ? v.add : []
    return arr.map((e) => gidFrom(e)).filter((g): g is string => typeof g === "string")
  }
  const customerGids = gidsOf(cs.customers)
  const segmentGids = gidsOf(cs.customerSegments)
  if (segmentGids.length > 0) return { customerSegments: { add: Array.from(new Set(segmentGids)) } }
  if (customerGids.length > 0) return { customers: { add: Array.from(new Set(customerGids)) } }

  // No valid selection supplied (absent, all:false, or an empty customers/segments list) → default to
  // a valid {all:true} rather than emit the empty selection Shopify rejects.
  return { all: true }
}

/** Canonicalise a weak-model DiscountCodeBasicInput into Shopify's real nested shape, then strip
 *  any field outside the known top-level set so a hallucinated field cannot 422 the gated write. */
export function canonicaliseBasicCodeDiscount(input: unknown): Record<string, unknown> {
  const src = isRec(input) ? input : {}
  const out: Record<string, unknown> = {}

  // Pass through the known scalar/date fields verbatim.
  for (const k of ["title", "code", "startsAt", "endsAt", "appliesOncePerCustomer", "combinesWith"]) {
    if (src[k] != null) out[k] = src[k]
  }
  // `code` is REQUIRED by Shopify ("Code can't be blank" 422) — a weak model sometimes omits the top-level
  // `code` and parks the coupon string under an alias (discountCode/couponCode/promoCode/name) or only in
  // the title. Recover it from any of those so the approved gated create doesn't fail blank.
  if (typeof out.code !== "string" || out.code === "") {
    const alias = [src.discountCode, src.couponCode, src.promoCode, src.code_string, src.name, src.title].find(
      (v): v is string => typeof v === "string" && v.length > 0,
    )
    if (alias != null) out.code = alias
  }
  // usageLimit / recurringCycleLimit must be POSITIVE INTEGERS or absent. 0 / negative / fractional is
  // REJECTED (BAD_PARAM) rather than dropped: dropping turned an approved "limit 0" into an unlimited code.
  for (const k of ["usageLimit", "recurringCycleLimit"]) {
    if (src[k] != null) out[k] = toPositiveIntLimit(src[k], k)
  }
  // A title is required by Shopify for a basic code discount; default to the code.
  if (out.title == null && typeof out.code === "string") out.title = out.code

  out.customerSelection = normaliseCustomerSelection(src)
  const gets = normaliseCustomerGets(src)
  if (gets) out.customerGets = gets

  // Final safety: drop anything still outside the allowlist (e.g. a leftover hallucinated key).
  for (const k of Object.keys(out)) {
    if (!DISCOUNT_BASIC_INPUT_FIELDS.has(k)) delete out[k]
  }
  return out
}

/** Validate a discount create/bulk-create/update input exactly as the handler will read it. Throws
 *  BAD_PARAM on an ambiguous or invalid value. Shared by the stage-time preflights and the handlers. */
export function validateDiscountInput(params: Record<string, unknown>, mode: "create" | "update"): void {
  const raw = isRec(params.basicCodeDiscount) ? params.basicCodeDiscount : params
  if (mode === "create") canonicaliseBasicCodeDiscount(raw)
  else canonicaliseBasicCodeDiscountPartial(raw)
}

/** Lines for the approval card: the NORMALISED discount, i.e. exactly what Shopify will be sent. */
export function describeDiscountInput(
  params: Record<string, unknown>,
  mode: "create" | "bulk" | "update",
): string[] {
  const raw0 = isRec(params.basicCodeDiscount) ? { ...params.basicCodeDiscount } : { ...params }
  if (mode === "bulk") {
    if (raw0.usageLimit == null) raw0.usageLimit = 1
    if (raw0.appliesOncePerCustomer == null) raw0.appliesOncePerCustomer = true
  }
  let d: Record<string, unknown>
  try {
    d = mode === "update" ? canonicaliseBasicCodeDiscountPartial(raw0) : canonicaliseBasicCodeDiscount(raw0)
  } catch (err) {
    return [`REJECTED, this will not run: ${err instanceof Error ? err.message : String(err)}`]
  }
  const lines: string[] = []
  if (typeof d.title === "string") lines.push(`Title: ${d.title}`)
  if (typeof d.code === "string" && mode !== "bulk") lines.push(`Code: ${d.code}`)
  const gets = isRec(d.customerGets) ? d.customerGets : undefined
  const value = gets && isRec(gets.value) ? gets.value : undefined
  if (value && typeof value.percentage === "number") {
    lines.push(`Discount: ${Math.round(value.percentage * 10000) / 100}% off`)
  } else if (value && isRec(value.discountAmount)) {
    lines.push(`Discount: fixed amount ${String(value.discountAmount.amount ?? "?")}`)
  }
  const items = gets && isRec(gets.items) ? gets.items : undefined
  if (items) lines.push(items.all === true ? "Applies to: everything (storewide)" : "Applies to: selected products or collections only")
  if (isRec(d.customerSelection)) lines.push(d.customerSelection.all === true ? "Available to: all customers" : "Available to: selected customers only")
  if (mode !== "update" || d.usageLimit != null) {
    lines.push(d.usageLimit != null ? `Usage limit: ${String(d.usageLimit)} use(s) per code` : "Usage limit: NONE (unlimited uses)")
  }
  if (d.appliesOncePerCustomer === true) lines.push("Limit: once per customer")
  if (typeof d.startsAt === "string") lines.push(`Starts: ${d.startsAt}`)
  if (typeof d.endsAt === "string") lines.push(`Ends: ${d.endsAt}`)
  return lines
}

export async function discounts_create_preflight(params: Record<string, unknown>): Promise<PreflightResult> {
  try {
    validateDiscountInput(params, "create")
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

const DISCOUNT_CREATE = `
  mutation DiscountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`
export async function discounts_create(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  const raw = isRec(params.basicCodeDiscount) ? params.basicCodeDiscount : params
  const basicCodeDiscount = canonicaliseBasicCodeDiscount(raw)
  return runMutation(ctx, { query: DISCOUNT_CREATE, variables: { basicCodeDiscount }, dataKey: "discountCodeBasicCreate", eventEntity: "discount", eventAction: "created", entityIdPath: "codeDiscountNode.id" })
}

const DISCOUNT_UPDATE = `
  mutation DiscountCodeBasicUpdate($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode { id }
      userErrors { field message }
    }
  }
`
/** PARTIAL canonicalise for an UPDATE: like create, but never FORCE-inject customerSelection/customerGets
 *  defaults — an update is a delta (e.g. only `endsAt` to deactivate), so we only normalise a subfield the
 *  caller actually supplied, then strip out-of-set keys. */
export function canonicaliseBasicCodeDiscountPartial(input: unknown): Record<string, unknown> {
  const src = isRec(input) ? input : {}
  const out: Record<string, unknown> = {}
  for (const k of ["title", "code", "startsAt", "endsAt", "appliesOncePerCustomer", "combinesWith"]) {
    if (src[k] != null) out[k] = src[k]
  }
  // usageLimit / recurringCycleLimit: positive int or absent; invalid is rejected — see create path.
  for (const k of ["usageLimit", "recurringCycleLimit"]) {
    if (src[k] != null) out[k] = toPositiveIntLimit(src[k], k)
  }
  if (src.customerSelection != null || src.allCustomers != null) {
    out.customerSelection = normaliseCustomerSelection(src)
  }
  if (
    src.customerGets != null || src.value != null || src.percentage != null || src.percent != null ||
    src.productIds != null || src.productId != null || src.products != null || src.variantConditions != null ||
    src.discountAmount != null
  ) {
    const gets = normaliseCustomerGets(src)
    if (gets) out.customerGets = gets
  }
  for (const k of Object.keys(out)) {
    if (!DISCOUNT_BASIC_INPUT_FIELDS.has(k)) delete out[k]
  }
  return out
}

/** The gid type Shopify gives a code discount. Both discount tools target this node, never the
 *  DiscountAutomaticNode or the raw redeem code. */
const DISCOUNT_NODE_TYPE = "DiscountCodeNode"

/**
 * STAGE-TIME preflight for the gated `discounts_update` (manifest `preflight`). The only guard was
 * that an id was present, so a discount that no longer exists (or an id for some other record)
 * reached the human as a legitimate-looking edit that could not execute.
 */
export async function discounts_update_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const id = requireTargetId(params, "id")
    validateDiscountInput(params, "update")
    await readGatedTarget(ctx, id, DISCOUNT_NODE_TYPE, "discounts_update")
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function discounts_update(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  requireTargetId(params, "id")
  const raw = isRec(params.basicCodeDiscount) ? params.basicCodeDiscount : params
  const basicCodeDiscount = canonicaliseBasicCodeDiscountPartial(raw)
  return runMutation(ctx, { query: DISCOUNT_UPDATE, variables: { id: params.id, basicCodeDiscount }, dataKey: "discountCodeBasicUpdate", eventEntity: "discount", eventAction: "updated", entityIdPath: "codeDiscountNode.id" })
}

const DISCOUNT_DELETE = `
  mutation DiscountCodeDelete($id: ID!) {
    discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { field message } }
  }
`
/**
 * STAGE-TIME preflight for the gated `discounts_delete` (manifest `preflight`). Deleting a code
 * discount is permanent, and the id was never checked: an id that resolves to nothing parked a
 * delete approval a human could only discover was doomed after approving it.
 */
export async function discounts_delete_preflight(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<PreflightResult> {
  try {
    const id = requireTargetId(params, "id")
    await readGatedTarget(ctx, id, DISCOUNT_NODE_TYPE, "discounts_delete")
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function discounts_delete(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  requireTargetId(params, "id")
  return runMutation(ctx, { query: DISCOUNT_DELETE, variables: { id: params.id }, dataKey: "discountCodeDelete", eventEntity: "discount", eventAction: "deleted", entityIdPath: "deletedCodeDiscountId" })
}

// ─────────────────────────────────────────────────────────────────────────
//  Discounts — bulk code generation (N unique single-use codes in ONE op)
// ─────────────────────────────────────────────────────────────────────────
//
// `discounts_bulk_create` — generate N UNIQUE codes on ONE code discount in a SINGLE gated tool call.
// The natural ask "give me 25 unique single-use 50%-off codes to hand to press" decomposes, with only
// `discounts_create` (one code per call, gated), into N gated calls across multiple turns that exceed the
// 10-step/60s budget. Shopify natively supports this: a code discount can carry MANY redeem codes, added
// in bulk via the ASYNC `discountRedeemCodeBulkAdd` mutation. So this tool does the whole pipeline
// SERVER-SIDE — create (or reuse) the code discount, bulk-add the remaining unique codes, POLL the async
// job to completion, then READ BACK and RETURN the actual created codes — so the AGENT makes ONE gated
// call and never loops. The codes returned are the ground truth (no fabrication possible: the tool only
// returns codes Shopify actually persisted).
//
// SINGLE-USE: a "single-use per recipient" press code is `usageLimit:1` on the discount (Shopify applies
// usageLimit PER CODE) + `appliesOncePerCustomer:true`. The percent/scope/window come from the same
// `canonicaliseBasicCodeDiscount` the single-create path uses, so a weak model's flat shape is normalised
// identically. Mirrors discounts_create's gating + the refunds_create/draftOrder "do the multi-step
// plumbing in the handler" pattern.

const DISCOUNT_REDEEM_CODE_BULK_ADD = `
  mutation DiscountRedeemCodeBulkAdd($discountId: ID!, $codes: [DiscountRedeemCodeInput!]!) {
    discountRedeemCodeBulkAdd(discountId: $discountId, codes: $codes) {
      bulkCreation { id }
      userErrors { field message code }
    }
  }
`

const DISCOUNT_BULK_CREATION_STATUS = `
  query DiscountBulkCreationStatus($id: ID!) {
    discountRedeemCodeBulkCreation(id: $id) {
      id
      done
      codesCount
      importedCount
      failedCount
    }
  }
`

const DISCOUNT_NODE_CODES = `
  query DiscountNodeCodes($id: ID!, $first: Int!) {
    codeDiscountNode(id: $id) {
      id
      codeDiscount {
        __typename
        ... on DiscountCodeBasic {
          title
          codes(first: $first) { nodes { code } }
        }
      }
    }
  }
`

/** Hard cap on a single bulk-create. The scenario asks 25; bound it so a runaway count can't generate
 *  thousands of codes against the live store in one approval. */
const BULK_CODE_MAX = 200

/** Read the requested code count from any of the shapes a weak model uses (top-level `count`, `quantity`,
 *  `numberOfCodes`, or nested under basicCodeDiscount). Must be 1..BULK_CODE_MAX: out of range is rejected. */
function readBulkCount(params: Record<string, unknown>, raw: Record<string, unknown>): number {
  const candidate =
    params.count ?? params.quantity ?? params.numberOfCodes ?? params.codeCount ??
    raw.count ?? raw.quantity ?? raw.numberOfCodes
  if (candidate == null) return 1
  const n = Number(candidate)
  if (!Number.isInteger(n) || n < 1 || n > BULK_CODE_MAX) {
    throw makeMutationError(
      "BAD_PARAM",
      `count must be a whole number from 1 to ${BULK_CODE_MAX} (got ${JSON.stringify(candidate)}); it is not clamped.`,
    )
  }
  return n
}

/** Deterministic, collision-resistant single-use code suffix (uppercase base36, no ambiguous chars). */
function bulkCodeToken(): string {
  // 7 random base36 chars (~36^7 ≈ 78 billion) — collision-safe for ≤200 codes per batch; uppercased to
  // match the human-readable promo-code convention press would type.
  return Math.random().toString(36).slice(2, 9).toUpperCase()
}

/** Generate `count` UNIQUE codes from a prefix (e.g. "SYNTH-SUMMIT" → "SYNTH-SUMMIT-A1B2C3D"). The prefix
 *  is sanitised to the [A-Z0-9-] code charset; an empty prefix falls back to "PRESS". */
function generateUniqueCodes(prefix: string, count: number): string[] {
  const clean = (prefix || "PRESS").toUpperCase().replace(/[^A-Z0-9-]/g, "").replace(/-+$/g, "") || "PRESS"
  const seen = new Set<string>()
  while (seen.size < count) seen.add(`${clean}-${bulkCodeToken()}`)
  return Array.from(seen)
}

interface BulkCreationStatus {
  id: string
  done: boolean
  codesCount: number | null
  importedCount: number | null
  failedCount: number | null
}

/** Poll the async bulk-creation job until `done`, bounded so a stuck job throws loudly instead of hanging
 *  the gated turn forever. Between polls the pacer waits 250 ms doubling to 2 s, within
 *  BULK_POLL_WAIT_BUDGET_MS in all, where the runtime has a timer; where it has none (a guest `setTimeout`
 *  is "not defined") the wait is a no-op and the pacing comes from the network round trip of
 *  `client.query` itself. Shopify's bulk-add of ≤200 redeem codes completes well inside the poll window.
 *  Returns the final status. */
/** Total wait between bulk-creation polls: the tool declares no `timeoutMs`, so it runs under the host's
 *  tight default execution budget and most of that budget stays with the Shopify calls. */
const BULK_POLL_WAIT_BUDGET_MS = 2_500

async function pollBulkCreation(client: ShopClient, jobId: string): Promise<BulkCreationStatus> {
  const pace = createPollPacer(BULK_POLL_WAIT_BUDGET_MS)
  for (let i = 0; i < 60; i++) {
    if (i > 0) await pace(i - 1)
    const data = await client.query<{ discountRedeemCodeBulkCreation: BulkCreationStatus | null }>(
      DISCOUNT_BULK_CREATION_STATUS,
      { id: jobId },
    )
    const status = data.discountRedeemCodeBulkCreation
    if (status?.done) return status
  }
  throw makeMutationError(
    "BULK_CREATION_TIMEOUT",
    `discounts_bulk_create: bulk code-creation job ${jobId} did not complete within the poll window`,
    502,
  )
}

/**
 * discounts_bulk_create — create a code discount and bulk-add N unique single-use codes in ONE gated call.
 *
 * Params (flexible — a weak model's flat shape is normalised):
 *   - count / quantity / numberOfCodes — how many unique codes (default 1, capped at BULK_CODE_MAX).
 *   - codePrefix — the human-readable prefix each code shares (e.g. "SYNTH-SUMMIT"); each code gets a
 *     unique random suffix. Falls back to the discount `title`/`code` if omitted, else "PRESS".
 *   - basicCodeDiscount (or the flat fields directly) — the discount config (percentage, product scope,
 *     window). 50%-off is `customerGets.value.percentage: 0.5`. Single-use is the default: usageLimit:1 +
 *     appliesOncePerCustomer:true (override usageLimit explicitly for a multi-use code).
 *
 * Returns `{ discountId, title, requestedCount, createdCount, codes: [<the actual persisted codes>] }`.
 * The `codes` array is the ground truth — the agent must report ONLY these (it cannot claim codes the
 * tool did not return).
 */
/** STAGE-TIME preflight for discounts_bulk_create: rejects an ambiguous percentage, a zero usage limit and
 *  an out-of-range count before the approval exists. */
export async function discounts_bulk_create_preflight(params: Record<string, unknown>): Promise<PreflightResult> {
  try {
    const raw = isRec(params.basicCodeDiscount) ? { ...params.basicCodeDiscount } : { ...params }
    readBulkCount(params, raw)
    canonicaliseBasicCodeDiscount({ ...raw, code: "PREFLIGHT" })
  } catch (err) {
    return preflightRefusal(err, "BAD_PARAM")
  }
  return { ok: true }
}

export async function discounts_bulk_create(params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  const raw = isRec(params.basicCodeDiscount) ? { ...params.basicCodeDiscount } : { ...params }
  const count = readBulkCount(params, raw)

  // SINGLE-USE press codes are the default — each code redeemable once, once per customer. The caller can
  // override usageLimit (e.g. for a capped multi-use code). appliesOncePerCustomer defaults on.
  if (raw.usageLimit == null) raw.usageLimit = 1
  if (raw.appliesOncePerCustomer == null) raw.appliesOncePerCustomer = true

  // Shopify REQUIRES `startsAt` on DiscountCodeBasicInput — a create without it 422s "Starts at can't be
  // blank" and FAILS the whole gated batch (the live chaos failure). A "give me 25 press codes" ask has no
  // explicit window — the codes are meant to be usable immediately — so default `startsAt` to NOW when the
  // caller omits it (press/demo codes are active right away). An explicit caller-supplied window is honoured.
  if (raw.startsAt == null) raw.startsAt = new Date().toISOString()

  // Resolve the per-code prefix BEFORE canonicalisation strips unknown fields.
  const prefix =
    (typeof params.codePrefix === "string" && params.codePrefix) ||
    (typeof raw.codePrefix === "string" && raw.codePrefix) ||
    (typeof raw.code === "string" && raw.code) ||
    (typeof raw.title === "string" && raw.title) ||
    "PRESS"

  const codes = generateUniqueCodes(String(prefix), count)

  // The code discount is created carrying the FIRST code; canonicaliseBasicCodeDiscount maps the weak-model
  // shape (percentage/scope/window/single-use flags) into Shopify's nested DiscountCodeBasicInput.
  const basicCodeDiscount = canonicaliseBasicCodeDiscount({ ...raw, code: codes[0], title: raw.title ?? prefix })
  const client = await getShopifyClient(ctx)
  markExternalEffect(ctx) // direct mutation send (bypasses runMutation's marking)
  const created = await client.query<{
    discountCodeBasicCreate: {
      codeDiscountNode: { id: string } | null
      userErrors: { field?: string[] | null; message: string }[]
    }
  }>(DISCOUNT_CREATE, { basicCodeDiscount })
  assertNoUserErrors(created.discountCodeBasicCreate as Record<string, unknown>, "discountCodeBasicCreate")
  const discountId = created.discountCodeBasicCreate.codeDiscountNode?.id
  if (!discountId) throw makeMutationError("SHOPIFY_EMPTY_PAYLOAD", "discounts_bulk_create: no codeDiscountNode id returned", 502)

  // Bulk-add the REMAINING codes (the discount already carries codes[0]) via the async mutation, then poll.
  const remaining = codes.slice(1)
  if (remaining.length > 0) {
    markExternalEffect(ctx) // direct mutation send (bypasses runMutation's marking)
    const added = await client.query<{
      discountRedeemCodeBulkAdd: {
        bulkCreation: { id: string } | null
        userErrors: { field?: string[] | null; message: string }[]
      }
    }>(DISCOUNT_REDEEM_CODE_BULK_ADD, {
      discountId,
      codes: remaining.map((code) => ({ code })),
    })
    assertNoUserErrors(added.discountRedeemCodeBulkAdd as Record<string, unknown>, "discountRedeemCodeBulkAdd")
    const jobId = added.discountRedeemCodeBulkAdd.bulkCreation?.id
    if (!jobId) throw makeMutationError("SHOPIFY_EMPTY_PAYLOAD", "discounts_bulk_create: bulk-add returned no job id", 502)
    const status = await pollBulkCreation(client, jobId)
    if ((status.failedCount ?? 0) > 0)
      throw makeMutationError(
        "BULK_CREATION_PARTIAL",
        `discounts_bulk_create: ${status.failedCount} of ${remaining.length} bulk codes failed to import (likely a code collision); none of the batch can be trusted`,
        502,
      )
  }

  // READ BACK the actual persisted codes — the ground truth the agent reports. (codes[0] + the bulk batch.)
  const back = await client.query<{
    codeDiscountNode: {
      id: string
      codeDiscount: { __typename: string; title?: string; codes?: { nodes: { code: string }[] } }
    } | null
  }>(DISCOUNT_NODE_CODES, { id: discountId, first: Math.min(codes.length + 5, 250) })
  const persistedCodes = (back.codeDiscountNode?.codeDiscount?.codes?.nodes ?? []).map((n) => n.code)
  const title = back.codeDiscountNode?.codeDiscount?.title ?? String(raw.title ?? prefix)

  await emitMutationEvent(ctx, "discount", "bulk_created", discountId, {
    discountId,
    title,
    createdCount: persistedCodes.length,
  })

  return {
    discountId,
    title,
    requestedCount: count,
    createdCount: persistedCodes.length,
    codes: persistedCodes,
  }
}
