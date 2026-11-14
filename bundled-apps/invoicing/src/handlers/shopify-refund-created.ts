// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E4 — `onShopifyRefundCreated` handler.
//
// Refund flow: update the target invoice's `payment_status` to `refunded` or
// `partial` and append to `lifecycle_log` AND auto-issue the credit note(s) that
// legally reverse the refunded invoice(s). A Shopify refund is authoritative and
// irreversible, so the reversal document is generated automatically (no approval
// gate) the moment the refund arrives — bookkeeping always has the matching
// credit note. (A mistaken refund is corrected by hand-editing/deleting the
// credit note, not by withholding it.)
//
// Credit-note issuance needs the full issue pipeline (numbering, PDF, cross-app
// customs). The kernel injects that same pipeline into every `events.subscribes`
// handler (it is what lets onShopifyOrderPaid issue invoices), so at runtime this
// handler's ctx carries `pdf`/`db.batch`/`requestApproval`/`executeTool`. Those
// are typed OPTIONAL below so the handler stays unit-testable with a db-only ctx:
// when the pipeline is absent the refund is still recorded, the credit note is
// simply skipped.

import { park } from "../deferred"
import {
  autoCreditNoteCounterparty,
  issueOrParkAutoCreditNote,
} from "../einvoicing/parked-credit-note"
import { type LineKind, storedTaxCountry } from "../issue"
import { lineSubtotal, lineTax, majorDecimalToMinor } from "../money"
import { creditNoteCreateAndIssue, type MutationsCtx } from "../mutations"
import { toBigInt } from "../mutations/shared"
import { findBillingDocumentsForOrder } from "./billing-documents"
import type { DeferredEventInsert } from "./shopify-order-paid"

export interface RefundPayload {
  id: string // refund id (numeric or gid — normalized for dedup)
  order_id: string // shopify order id — joins to documents.external_refs.shopify_order_id
  /**
   * Refund amount in integer minor units. Programmatic/unit callers pass this
   * directly. The `refunds/create` webhook instead carries a major-unit
   * `amount` + `currency` (Shopify amounts are decimal strings in the major
   * unit) — `resolveRefundMinor` converts when this is absent.
   */
  refund_amount_minor?: bigint | number | string
  amount?: string
  currency?: string
  shop_id?: string
  createdAt?: string
  /**
   * Per-line attribution of a PARTIAL refund on a split order (goods invoice + software
   * invoice), when the caller has it. Each entry's `external_id` is matched against
   * `document_lines.external_id` (the Shopify variant gid a line was issued with) to find
   * which document actually carries the refunded line, so a software-only refund credits the
   * software invoice and never the goods invoice (or vice versa). `amount_minor` is that
   * line's own share of the refund, in integer minor units.
   *
   * Only consulted when the order has MORE THAN ONE billing document (a split order) and the
   * refund is not a full-order refund -- a single-document order is never ambiguous, and a
   * full refund already reverses every document in full regardless of which line moved.
   * Absent, or any entry that cannot be matched to exactly one document: this handler refuses
   * to guess and DEFERS the event for manual attribution rather than crediting the wrong
   * document (see `attributeRefundLineItems` below).
   */
  refund_line_items?: Array<{ external_id?: string | null; amount_minor: bigint | number | string }>
  /**
   * Gross shipping (net + tax, minor units) this refund gives back, when the shopify app could read
   * it off the refund (its shipping lines or "shipping_refund" adjustments). A shipping refund
   * carries no `refund_line_items`, so without this it was credited on the goods invoice, which
   * never carried the shipping line. Routed to the document that does, at the shipping line's rate.
   */
  shipping_refund_minor?: bigint | number | string
}

export interface DocumentForRefund {
  id: string
  scope: string | null
  grand_total_minor: bigint
  payment_status: string
  lifecycle_log: Array<Record<string, unknown>>
}

export interface RefundDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      limit?: number
    },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<unknown>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
}

export interface RefundCtx {
  getUserId(): Promise<string>
  db: RefundDb
  // Full issue pipeline — present on the kernel-injected event ctx (identical to
  // onShopifyOrderPaid's), absent on minimal unit-test ctxs. When present, the
  // refund also AUTO-ISSUES the reversing credit note(s). Typed against
  // MutationsCtx's fields so `creditNoteCreateAndIssue` can run with this ctx.
  pdf?: MutationsCtx["pdf"]
  requestApproval?: MutationsCtx["requestApproval"]
  executeTool?: MutationsCtx["executeTool"]
  messages?: MutationsCtx["messages"]
  emit?: MutationsCtx["emit"]
  // Kernel-injected logger (real ctx only; absent on minimal unit-test ctxs, so every
  // call site guards with `ctx.logger?.error?.(...)`, matching the idiom already used
  // across the other bundled apps, e.g. bundled-apps/boxtal/src/webhooks.ts).
  logger?: {
    error(msg: string, data?: unknown): void
    warn?(msg: string, data?: unknown): void
  }
}

/** True when the runtime ctx carries the issue pipeline (so a credit note can be issued). */
function hasIssuePipeline(ctx: RefundCtx): boolean {
  return (
    typeof ctx.pdf?.render === "function" &&
    typeof (ctx.db as { batch?: unknown }).batch === "function"
  )
}

/** The shape of an original invoice line this builder needs to allocate a partial reversal. */
export interface ReversalSourceLine {
  unit_price_minor: bigint
  quantity: string | number
  tax_rate_bp: number
  /** The source line's kind. When EVERY source line is shipping, the reversal is a shipping
   *  refund and its lines are labelled shipping (not software). Absent reads as unknown. */
  line_kind?: LineKind
}

/**
 * The adjustment credit-note shape for a reversal that does not cover an invoice's full total:
 * `remainingGrossMinor` is allocated across the ORIGINAL invoice's own tax rates, in proportion to
 * each rate's share of the invoice's total gross, and one negative line per rate is emitted at that
 * rate -- so a two-rate invoice reverses both rates in proportion, instead of losing the VAT on a
 * single 0-tax adjustment line (the pre-fix shape: gross landed right, tax was silently dropped on
 * every partial reversal). Shared by a Shopify partial refund (below) and a cancellation that
 * reverses only what a prior partial credit note left outstanding (shopify-order-cancelled.ts), so
 * the two never carry their own drifting copy of this shape.
 *
 * `originalLines` are the reversed invoice's `document_lines` rows. Their `unit_price_minor` is
 * always NET regardless of the issuer's `prices_include_tax` mode: an issuer that types gross
 * prices has them divided net-of-tax exactly ONCE, at line-entry time (`netLinesForIssuer` in
 * mutations.ts) -- by the time a line reaches `document_lines` it is net either way, so this
 * allocation needs no separate inclusive-mode branch.
 *
 * Exactness: the remaining gross is allocated to each rate GROUP with a largest-remainder method
 * (the group allocations always sum to exactly `remainingGrossMinor`), each group is split into
 * net/tax with a FLOORED inverse of the forward issuance derivation (`floorNetOfIncludedTax` then
 * `lineTax`) that never overshoots the group's target gross, and whatever that floor leaves short
 * is swept onto ONE deterministic 0-tax "Rounding adjustment" line. The emitted lines' net plus tax
 * therefore always sums to `remainingGrossMinor` exactly, in bigint, for any rate mix, split, or
 * currency exponent (including zero-decimal currencies like JPY) -- AND, because the per-group
 * split never overshoots, the sweep line's net is never positive: a credit note only ever credits.
 */
/**
 * Strip an included tax rate off a gross minor amount like `netOfIncludedTax`, but rounded STRICTLY
 * DOWN instead of to nearest. Used only by `buildAdjustmentReversalItems`'s per-group split: with a
 * floored net, `net + lineTax(net, rate)` can never exceed `gross` (the continuous quotient
 * `gross/(1+rate)` already satisfies `net*(1+rate/10000) <= gross`, and rounding the tax term up by
 * at most half a minor unit cannot push an integer sum past an integer target) -- so the residual
 * this split leaves for the sweep line is always >= 0, which is what keeps that sweep line from
 * ever emitting a positive `unit_price_minor` on a reversal.
 */
function floorNetOfIncludedTax(gross: bigint, rateBp: number): bigint {
  if (rateBp <= 0) return gross
  return (gross * 10_000n) / BigInt(10_000 + rateBp)
}

export function buildAdjustmentReversalItems(
  originalLines: ReversalSourceLine[],
  remainingGrossMinor: bigint,
  scope: string | null,
): Array<Record<string, unknown>> {
  // A reversal of nothing but carriage is a shipping refund: label it as one. Otherwise the kind
  // the original's other lines share (a services invoice credits services), and when they mix,
  // the scope decides (the services document of a split order is scope "software").
  const allShipping =
    originalLines.length > 0 && originalLines.every((l) => l.line_kind === "shipping")
  const kinds = new Set(
    originalLines.filter((l) => l.line_kind !== "shipping").map((l) => l.line_kind),
  )
  const shared = kinds.size === 1 ? [...kinds][0] : undefined
  const lineKind = (
    allShipping ? "shipping" : (shared ?? (scope === "software" ? "software" : "goods"))
  ) as LineKind
  const refundLabel = allShipping ? "Shipping refund" : "Refund"
  const item = (unitPriceMinor: bigint, rateBp: number, description: string) => ({
    description: description === "Refund" ? refundLabel : description,
    quantity: "1",
    unit_price_minor: unitPriceMinor,
    tax_rate_bp_override: rateBp,
    line_kind: lineKind,
    hs_code: null,
    customs_description: null,
    country_of_origin: null,
    product_source: null,
    external_id: null,
  })

  const remAbs = remainingGrossMinor < 0n ? -remainingGrossMinor : remainingGrossMinor

  // Group the ORIGINAL lines' own gross contribution (net subtotal + tax, at the line's own rate)
  // by rate.
  const grossByRate = new Map<number, bigint>()
  for (const l of originalLines) {
    const subtotal = lineSubtotal({ quantity: l.quantity, unit_price_minor: l.unit_price_minor })
    const tax = lineTax({ subtotal_minor: subtotal, tax_rate_bp: l.tax_rate_bp })
    const gross = subtotal + tax
    grossByRate.set(l.tax_rate_bp, (grossByRate.get(l.tax_rate_bp) ?? 0n) + gross)
  }

  // Only POSITIVE rate groups take part in the proportional allocation: a discount or adjustment
  // line at a rate with no offsetting positive line leaves that rate's group gross <= 0, and
  // allocating against a non-positive group turns floorNetOfIncludedTax's "floor" into a ceiling
  // (BigInt division truncates toward zero, not toward -Infinity), which would emit a POSITIVE
  // unit_price_minor on what must always be a credit-only document. `totalGross` here is
  // renormalised to the sum of ONLY the positive groups, so the allocation still divides evenly
  // across them; the residual sweep below absorbs whatever the exclusion leaves outstanding.

  // Excluding negative groups means their VAT is not reversed. Partial reversals thus
  // under-reverse VAT rather than over-reversing, and since the gross credited is exact
  // either way, the residual error falls in the tax authority's favour. Strictly, such
  // groups should never exist separately: discounts should fold into the rate group of
  // the line they discount, which Shopify order allocations already do via toNetLineMoney.
  // A standalone negative line reaches here only from hand-authored entries.
  let totalGross = 0n
  for (const gross of grossByRate.values()) {
    if (gross > 0n) totalGross += gross
  }

  if (totalGross <= 0n || grossByRate.size === 0) {
    // No original lines, or none with a positive gross to allocate proportionally against
    // (a zero, negative, or net-negative invoice) -- fall back to a single 0-tax line for the
    // full remaining amount rather than divide by zero or risk a positive line.
    return [item(-remainingGrossMinor, 0, "Refund")]
  }

  const rates = [...grossByRate.keys()]
    .filter((rate) => grossByRate.get(rate)! > 0n)
    .sort((a, b) => a - b)

  // Largest-remainder allocation of remAbs across rate groups, proportional to each group's share
  // of totalGross -- integer-exact, no floats: the per-group allocations always sum to remAbs.
  const floors = new Map<number, bigint>()
  const remainders = new Map<number, bigint>()
  let allocated = 0n
  for (const rate of rates) {
    const groupGross = grossByRate.get(rate)!
    const numerator = remAbs * groupGross
    const floor = numerator / totalGross
    floors.set(rate, floor)
    remainders.set(rate, numerator - floor * totalGross)
    allocated += floor
  }
  let leftover = remAbs - allocated
  // Distribute the leftover minor units to the groups with the largest fractional remainder first,
  // tie-broken by rate ascending, so the split is deterministic.
  const byRemainderDesc = [...rates].sort((a, b) => {
    const diff = remainders.get(b)! - remainders.get(a)!
    if (diff > 0n) return 1
    if (diff < 0n) return -1
    return a - b
  })
  const groupAbsGross = new Map<number, bigint>(floors)
  for (const rate of byRemainderDesc) {
    if (leftover <= 0n) break
    groupAbsGross.set(rate, groupAbsGross.get(rate)! + 1n)
    leftover -= 1n
  }

  // Split each group's allocated gross into net + tax with a FLOORED inverse of the forward
  // issuance derivation (netOfIncludedTax rounds to nearest; this rounds the net strictly DOWN,
  // then derives tax from that floored net with the same lineTax the forward pipeline uses).
  // Flooring net guarantees net + lineTax(net, rate) <= groupGross for every rate: with net at or
  // below the true continuous quotient gross/(1+rate), net + net*rate/10000 <= gross exactly, and
  // rounding that tax term up by at most half a minor unit still cannot push an integer sum past
  // an integer target. So this split never OVERSHOOTS its group's allocated gross -- only ever
  // undershoots or lands exact -- which is what keeps the residual sweep below non-positive (see
  // below): a "Rounding adjustment" line only ever ADDS more credit, never turns positive.
  const items: Array<Record<string, unknown>> = []
  let achievedAbs = 0n
  for (const rate of rates) {
    const groupGross = groupAbsGross.get(rate) ?? 0n
    if (groupGross === 0n) continue
    const net = floorNetOfIncludedTax(groupGross, rate)
    const tax = lineTax({ subtotal_minor: net, tax_rate_bp: rate })
    achievedAbs += net + tax
    items.push(item(-net, rate, "Refund"))
  }

  // Sweep any residual from the forward-rounding mismatch onto ONE deterministic 0-tax line, so the
  // emitted lines' net+tax sums to remainingGrossMinor exactly.
  const residualAbs = remAbs - achievedAbs
  if (residualAbs !== 0n) {
    items.push(item(-residualAbs, 0, "Rounding adjustment"))
  }

  return items
}

/**
 * Issue ONE reversing credit note against `doc`. `fullReversal: true` mirrors every one of
 * `doc`'s own lines negated (the whole-invoice reversal shape); `fullReversal: false` emits a
 * single proportional adjustment for `amount` via `buildAdjustmentReversalItems`. Idempotent
 * for a full reversal via `doc`'s own `credit_note_issued` lifecycle marker (never stacks a
 * second full credit note on an invoice that already carries one); a partial/adjustment
 * reversal is per-refund-id de-duped by its caller instead, since each distinct partial refund
 * legitimately issues its own adjustment credit note. Shared by the single-document refund path
 * and the split-order per-document attribution path (see `attributeRefundLineItems` below) so
 * the two never carry their own drifting copy of the issuance shape.
 */
async function issueOneRefundCreditNote(
  ctx: RefundCtx,
  args: {
    doc: DocumentForRefund
    amount: bigint
    fullReversal: boolean
    refundId: string
    /** The part of `amount` that is refunded SHIPPING: reversed on the document's shipping lines,
     *  at their own rate, instead of spread over every rate the document carries. */
    shippingAmount?: bigint
  },
): Promise<void> {
  const mctx = ctx as unknown as MutationsCtx
  const fresh = (await mctx.db.findOne("documents", args.doc.id)) as Record<string, unknown> | null
  if (!fresh) return
  if (args.fullReversal) {
    const lifecycle = (fresh.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? []
    if (lifecycle.some((e) => String(e.event ?? "") === "credit_note_issued")) return
  }

  // The credit note inherits the ORIGINAL invoice's recipient snapshot verbatim (see
  // autoCreditNoteCounterparty): an incomplete one refuses and parks until it is completed.
  const counterparty = autoCreditNoteCounterparty(fresh)
  const currency = String(fresh.currency ?? "EUR")

  const lineRows = (await mctx.db.findMany("document_lines", {
    where: { document_id: args.doc.id },
  })) as Array<Record<string, unknown>>

  let items: Array<Record<string, unknown>>
  if (args.fullReversal) {
    items = lineRows.map((l) => ({
      description: String(l.description ?? "Item"),
      quantity: String(l.quantity ?? "1"),
      unit_price_minor: -toBigInt(l.unit_price_minor),
      // Mirror each line's own tax rate so an export (0) reverses at 0 and a
      // domestic-VAT line reverses its VAT exactly.
      tax_rate_bp_override: Number(l.tax_rate_bp ?? 0),
      line_kind: ((l.line_kind as LineKind | undefined) ?? "goods") as LineKind,
      hs_code: (l.hs_code as string | null) ?? null,
      customs_description: (l.customs_description as string | null) ?? null,
      country_of_origin: (l.country_of_origin as string | null) ?? null,
      product_source: (l.product_source as string | null) ?? null,
      external_id: (l.external_id as string | null) ?? null,
    }))
  } else {
    const sources = lineRows.map((l) => ({
      unit_price_minor: toBigInt(l.unit_price_minor),
      quantity: (l.quantity as string | number | undefined) ?? "1",
      tax_rate_bp: Number(l.tax_rate_bp ?? 0),
      line_kind: ((l.line_kind as LineKind | undefined) ?? "goods") as LineKind,
    }))
    const shippingSources = sources.filter((l) => l.line_kind === "shipping")
    const requestedShipping = args.shippingAmount ?? 0n
    const shipping =
      shippingSources.length > 0 && requestedShipping > 0n
        ? requestedShipping > args.amount
          ? args.amount
          : requestedShipping
        : 0n
    const rest = args.amount - shipping
    const otherSources = sources.filter((l) => l.line_kind !== "shipping")
    items = [
      // Shipping reversed on the shipping lines' own rate only: a refund of the carriage never
      // reverses tax the carriage did not bear.
      ...(shipping > 0n
        ? buildAdjustmentReversalItems(shippingSources, shipping, args.doc.scope)
        : []),
      ...(rest > 0n
        ? buildAdjustmentReversalItems(
            shipping > 0n && otherSources.length > 0 ? otherSources : sources,
            rest,
            args.doc.scope,
          )
        : []),
    ]
  }

  // The refund authorises the reversal (no approval). An e-invoicing refusal parks THIS credit
  // note on the buyer's identity, with its own arguments, for the retry sweep to re-issue alone.
  await issueOrParkAutoCreditNote(
    { ...mctx, logger: ctx.logger },
    {
      source: "refund",
      original_document_id: args.doc.id,
      amount_minor: args.amount,
      full_reversal: args.fullReversal,
      refund_id: args.refundId,
      issuer_profile_id: (fresh.issuer_profile_id as string | null) ?? null,
      counterparty,
      currency,
      items,
      reason: `Auto-generated on Shopify refund ${args.refundId}`,
      order_label: String(fresh.shopify_order_number ?? fresh.shopify_order_id ?? args.doc.id),
    },
  )
}

/**
 * Auto-issue the credit note(s) that reverse a refund. On a FULL refund every
 * order invoice (goods + software) is reversed with a line-for-line mirror
 * (negated unit prices, each line's own tax rate preserved). On a PARTIAL refund
 * the primary invoice gets a single negative "Refund" adjustment line for the
 * refunded amount. Best-effort: a failure here never unwinds the recorded refund.
 */
async function autoIssueRefundCreditNotes(
  ctx: RefundCtx,
  args: {
    invoices: DocumentForRefund[]
    primaryDocId: string
    fullyRefunded: boolean
    refundAmt: bigint
    refundId: string
  },
): Promise<void> {
  const targets = args.fullyRefunded
    ? args.invoices.map((doc) => ({
        doc,
        amount: doc.grand_total_minor < 0n ? -doc.grand_total_minor : doc.grand_total_minor,
        fullReversal: true,
      }))
    : args.invoices
        .filter((d) => d.id === args.primaryDocId)
        .map((doc) => ({ doc, amount: args.refundAmt, fullReversal: false }))

  // Each target is isolated in its own try/catch: a failure issuing the credit note for
  // one document (e.g. the first invoice of a split order) must not prevent the remaining
  // targets from being issued. Before this, one throw aborted the whole loop and the
  // caller's catch swallowed it silently, dropping every credit note after the failing one.
  for (const t of targets) {
    try {
      await issueOneRefundCreditNote(ctx, {
        doc: t.doc,
        amount: t.amount,
        fullReversal: t.fullReversal,
        refundId: args.refundId,
      })
    } catch (err) {
      ctx.logger?.error?.("invoicing: auto refund credit note failed for one target, continuing", {
        refund_id: args.refundId,
        document_id: t.doc.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/**
 * Match each `refund_line_items` entry to the ONE billing document whose `document_lines`
 * carries that Shopify variant (`external_id`), and sum the entries per document. Returns
 * `unattributed` > 0 the moment any entry's `external_id` is missing or matches no document
 * line among `docs` — the caller must refuse to guess in that case (see `onShopifyRefundCreated`)
 * rather than crediting the wrong half of a split order.
 */
async function attributeRefundLineItems(
  db: RefundDb,
  docs: DocumentForRefund[],
  items: Array<{ external_id?: string | null; amount_minor: bigint | number | string }>,
): Promise<{ byDoc: Map<string, bigint>; unattributed: number; shippingDocIds: string[] }> {
  const externalIdToDocId = new Map<string, string>()
  const shippingDocIds: string[] = []
  for (const doc of docs) {
    const lines = (await db.findMany("document_lines", {
      where: { document_id: doc.id },
    })) as Array<Record<string, unknown>>
    for (const l of lines) {
      const extId = l.external_id as string | null | undefined
      if (extId) externalIdToDocId.set(extId, doc.id)
    }
    if (lines.some((l) => l.line_kind === "shipping")) shippingDocIds.push(doc.id)
  }

  const byDoc = new Map<string, bigint>()
  let unattributed = 0
  for (const item of items) {
    const docId = item.external_id ? externalIdToDocId.get(item.external_id) : undefined
    if (!docId) {
      unattributed += 1
      continue
    }
    byDoc.set(docId, (byDoc.get(docId) ?? 0n) + toBigInt(item.amount_minor))
  }
  return { byDoc, unattributed, shippingDocIds }
}

export type RefundResult =
  | { status: "ok"; document_id: string; payment_status: string }
  | { status: "deferred"; deferred_id: string; reason: string }

/** Convert a Shopify major-unit decimal string ("12.50") to integer minor units. */
function majorToMinor(amount: string, currency: string): bigint {
  return majorDecimalToMinor(amount, currency)
}

/** Prefer explicit minor units; otherwise derive from the webhook's major amount. */
function resolveRefundMinor(payload: Partial<RefundPayload>): bigint {
  if (payload.refund_amount_minor != null) return toBigInt(payload.refund_amount_minor)
  return majorToMinor(payload.amount ?? "0", payload.currency ?? "EUR")
}

/**
 * Normalize a refund id for dedup. The webhook emits a numeric id; the
 * programmatic `refunds_create` mutation emits a `gid://shopify/Refund/<n>` —
 * collapse both to the bare numeric id so the same refund delivered via two
 * paths (or a webhook retry) is recorded once.
 */
function normalizeRefundId(id: string): string {
  const m = /\/Refund\/(\d+)/.exec(id)
  return m ? (m[1] as string) : id
}

/**
 * Lifecycle-log event names that record a refund against a document. Both the
 * agent path (documents.record_refund → *_refund_recorded) and this webhook
 * path (partially_refunded / refunded) write into the same lifecycle_log, so
 * the cumulative-refund total must recognise every shape. `refund_amount_minor`
 * is persisted as a STRING in minor units on each entry.
 */
const REFUND_RECORDED_EVENTS = new Set([
  "partial_refund_recorded",
  "full_refund_recorded",
  "partially_refunded",
  "refunded",
])

/**
 * Sum, in minor units, the refunds already recorded in a document's
 * lifecycle_log, optionally skipping a specific (already-deduped) Shopify
 * refund id so the current refund is not double-counted. Entries with no
 * parseable amount contribute 0. All money stays in minor units.
 */
function sumPriorRefundedMinor(
  lifecycleLog: Array<Record<string, unknown>>,
  skipRefundId: string,
): bigint {
  let total = 0n
  for (const entry of lifecycleLog) {
    if (!REFUND_RECORDED_EVENTS.has(String(entry.event ?? ""))) continue
    if (
      skipRefundId !== "" &&
      normalizeRefundId(String(entry.shopify_refund_id ?? "")) === skipRefundId
    ) {
      continue
    }
    const raw = entry.refund_amount_minor
    if (raw == null || raw === "") continue
    total += toBigInt(raw)
  }
  return total
}

async function findDocumentsByShopifyOrderId(
  db: RefundDb,
  shopifyOrderId: string,
): Promise<DocumentForRefund[]> {
  // Indexed equality on the top-level shopify_order_id column — an unordered
  // bounded slice would return a noop refund once the org exceeds the slice.
  // A split order (goods + software scopes) carries several documents.
  //
  // CREDIT NOTES are EXCLUDED — they inherit the original invoice's
  // shopify_order_id (creditNoteCreateAndIssue) and are always issued with
  // scope: null, so leaving them in this set let `docs.find(d => d.scope ===
  // "goods" || d.scope === null)` below select the CREDIT NOTE (a negative
  // document) as the target of a refund, and let `combinedTotal` sum a
  // negative credit note into the invoice's total — understating it enough
  // that a small partial refund reads as covering the whole (already
  // credited) balance and flips every document to "refunded".
  // Exclusion is centralised in findBillingDocumentsForOrder (billing-documents.ts).
  const rows = await findBillingDocumentsForOrder(db, shopifyOrderId, 10)
  return rows.map((r) => ({
    id: String(r.id),
    scope: (r.scope as string | null) ?? null,
    grand_total_minor: toBigInt(r.grand_total_minor),
    payment_status: String(r.payment_status ?? "unpaid"),
    lifecycle_log: (r.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? [],
  }))
}

// Idempotent per (event, blocker): a redelivered refund webhook refreshes its open park.
async function insertDeferred(db: RefundDb, row: DeferredEventInsert): Promise<{ id: string }> {
  return park({ db }, row)
}

/**
 * Route a refund that carries per-line attribution (`payload.refund_line_items`) on a SPLIT
 * order (a goods invoice and a software invoice, both live for the same `shopify_order_id`) to
 * the document(s) that actually carry the refunded line, instead of always defaulting to the
 * goods invoice. Each attributed document gets its OWN payment-status update and its OWN
 * reversing credit note, sized to its own share — a refund spanning both halves credits BOTH
 * documents, each for its own amount. When `attributeRefundLineItems` cannot place every entry
 * on exactly one document (an unknown or missing `external_id`), this refuses to guess: the
 * event is deferred for manual attribution rather than crediting the wrong document.
 */
async function handleAttributedRefund(
  ctx: RefundCtx,
  args: {
    docs: DocumentForRefund[]
    orderId: string
    refundId: string
    payload: Partial<RefundPayload>
    lineItems: Array<{ external_id?: string | null; amount_minor: bigint | number | string }>
    /** Gross refunded shipping (minor units), 0 when none. */
    shippingRefund: bigint
    /** The whole refund (minor units). */
    refundAmt: bigint
  },
): Promise<RefundResult> {
  const { docs, orderId, refundId, payload, lineItems, shippingRefund, refundAmt } = args
  const { byDoc, unattributed, shippingDocIds } = await attributeRefundLineItems(
    ctx.db,
    docs,
    lineItems,
  )
  // Refunded shipping goes to the document that carried the shipping line (the services half of
  // a split order), never to the goods invoice. A refund that names no line and is not all
  // shipping keeps its historical home (the goods document) for the remainder: a tax only or
  // goodwill refund has no line of its own to follow.
  const shippingByDoc = new Map<string, bigint>()
  if (shippingRefund > 0n) {
    const shippingDocId = shippingDocIds.length === 1 ? shippingDocIds[0]! : null
    if (!shippingDocId) {
      const def = await insertDeferred(ctx.db, {
        event_id: `${refundId || orderId}:line_attribution`,
        event_payload_json: payload,
        status: "awaiting_data",
        reason: "refund_shipping_unattributable",
        blocked_on: {
          kind: "refund_shipping",
          shopify_order_id: orderId,
          shopify_refund_id: refundId,
        },
      })
      return { status: "deferred", deferred_id: def.id, reason: "refund_shipping_unattributable" }
    }
    shippingByDoc.set(shippingDocId, shippingRefund)
    byDoc.set(shippingDocId, (byDoc.get(shippingDocId) ?? 0n) + shippingRefund)
    if (lineItems.length === 0) {
      const remainder = refundAmt - shippingRefund
      if (remainder > 0n) {
        const fallback = docs.find((d) => d.scope === "goods" || d.scope === null) ?? docs[0]!
        byDoc.set(fallback.id, (byDoc.get(fallback.id) ?? 0n) + remainder)
      }
    }
  }
  if (unattributed > 0 || byDoc.size === 0) {
    const def = await insertDeferred(ctx.db, {
      event_id: `${refundId || orderId}:line_attribution`,
      event_payload_json: payload,
      status: "awaiting_data",
      reason: "refund_line_item_unattributable",
      blocked_on: {
        kind: "refund_line_item",
        shopify_order_id: orderId,
        shopify_refund_id: refundId,
      },
    })
    return { status: "deferred", deferred_id: def.id, reason: "refund_line_item_unattributable" }
  }

  const actor = await ctx.getUserId()
  let lastDocId: string | null = null
  let lastStatus = "unpaid"

  for (const [docId, amount] of byDoc) {
    if (amount <= 0n) continue
    const doc = docs.find((d) => d.id === docId)
    if (!doc) continue
    const alreadyRecorded =
      refundId !== "" &&
      doc.lifecycle_log.some(
        (e) => normalizeRefundId(String(e.shopify_refund_id ?? "")) === refundId,
      )
    const docTotal = doc.grand_total_minor < 0n ? -doc.grand_total_minor : doc.grand_total_minor
    const cumulative = sumPriorRefundedMinor(doc.lifecycle_log, refundId) + amount
    const docFullyRefunded = doc.payment_status === "refunded" || cumulative >= docTotal
    const newStatus = docFullyRefunded ? "refunded" : "partial"
    const newLog = [
      ...doc.lifecycle_log,
      {
        event: newStatus === "refunded" ? "refunded" : "partially_refunded",
        actor,
        ts: new Date().toISOString(),
        refund_amount_minor: amount.toString(),
        shopify_refund_id: refundId,
      },
    ]
    // Recorded once per refund id. A re-run (the event's retry after a run that died between the
    // record and the credit note: nothing is held across the run) skips the record and still
    // issues the credit note, which is found instead of issued twice when it already exists.
    if (!alreadyRecorded) {
      await ctx.db.update("documents", doc.id, { payment_status: newStatus, lifecycle_log: newLog })
    }

    if (hasIssuePipeline(ctx)) {
      try {
        await issueOneRefundCreditNote(ctx, {
          doc,
          amount: docFullyRefunded ? docTotal : amount,
          fullReversal: docFullyRefunded,
          refundId,
          shippingAmount: shippingByDoc.get(doc.id) ?? 0n,
        })
      } catch (err) {
        // Credit-note issuance is best-effort; the refund status change stands. Still logged
        // with real context so a swallowed failure never goes unrecorded.
        ctx.logger?.error?.("invoicing: attributed refund credit note failed, continuing", {
          refund_id: refundId,
          shopify_order_id: orderId,
          document_id: doc.id,
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    lastDocId = doc.id
    lastStatus = alreadyRecorded ? doc.payment_status : newStatus
  }

  if (!lastDocId) {
    // Every attributed amount was zero or negative -- nothing to record against a real
    // document. Defer rather than report a fabricated "ok" with no document behind it.
    const def = await insertDeferred(ctx.db, {
      event_id: `${refundId || orderId}:line_attribution`,
      event_payload_json: payload,
      status: "awaiting_data",
      reason: "refund_line_item_unattributable",
      blocked_on: {
        kind: "refund_line_item",
        shopify_order_id: orderId,
        shopify_refund_id: refundId,
      },
    })
    return { status: "deferred", deferred_id: def.id, reason: "refund_line_item_unattributable" }
  }
  return { status: "ok", document_id: lastDocId, payment_status: lastStatus }
}

export async function onShopifyRefundCreated(
  event: Partial<RefundPayload> & { data?: Partial<RefundPayload> },
  ctx: RefundCtx,
): Promise<RefundResult> {
  // The kernel delivers the full event envelope ({ entity, action, data, … });
  // the refund lives in `event.data`. Fall back to the bare payload for direct
  // unit calls. (Previously this read `payload.order_id` off the envelope,
  // which is undefined for real events — so the refund→invoice update never
  // fired in production, only in unit tests.)
  const payload: Partial<RefundPayload> = event?.data ?? event
  const orderId = String(payload.order_id ?? "")
  const refundId = normalizeRefundId(String(payload.id ?? ""))

  const docs = await findDocumentsByShopifyOrderId(ctx.db, orderId)
  if (docs.length === 0) {
    const def = await insertDeferred(ctx.db, {
      event_id: refundId,
      event_payload_json: payload,
      status: "awaiting_data",
      reason: "invoice_not_found_for_refund",
      blocked_on: { kind: "invoice", shopify_order_id: orderId },
    })
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }

  // A split order carries a goods document and a software document, deliberately separate
  // legal documents with their own tax treatment. When the refund carries per-line attribution,
  // route each line's share to the document that actually issued it (see handleAttributedRefund
  // above) instead of defaulting to one document regardless of which line was refunded. Only
  // consulted for a genuinely split order (more than one billing document) -- a single-document
  // order is never ambiguous, so it always takes the path below unchanged.
  const lineItems = payload.refund_line_items ?? []
  const rawShipping = toBigInt(payload.shipping_refund_minor)
  const shippingRefund = rawShipping < 0n ? -rawShipping : rawShipping
  if (docs.length > 1 && (lineItems.length > 0 || shippingRefund > 0n)) {
    return handleAttributedRefund(ctx, {
      docs,
      orderId,
      refundId,
      payload,
      lineItems,
      shippingRefund,
      refundAmt: resolveRefundMinor(payload),
    })
  }

  // No attribution data: for a single-document order this is unambiguous (there is only one
  // document to credit). For a split order with no line attribution, this remains the historical
  // fallback -- record it on the goods document (physical returns dominate; it is also the
  // larger one) and fall back to whichever exists.
  const doc = docs.find((d) => d.scope === "goods" || d.scope === null) ?? docs[0]!
  const combinedTotal = docs.reduce((sum, d) => sum + d.grand_total_minor, 0n)

  // Idempotency: a single Shopify refund can reach us twice (the programmatic
  // tool emits `refund:created` AND Shopify then delivers the `refunds/create`
  // webhook; webhooks also retry). Record each refund id at most once.
  const alreadyRecorded =
    refundId !== "" &&
    doc.lifecycle_log.some((e) => normalizeRefundId(String(e.shopify_refund_id ?? "")) === refundId)
  const refundAmt = resolveRefundMinor(payload)
  // Status must reflect the CUMULATIVE refund total, not this webhook alone —
  // a refund split across multiple `refunds/create` events (or a webhook plus a
  // programmatic record_refund) would otherwise stay stuck at 'partial' even
  // once the sum reaches the document total. Exclude the current refund id from
  // the prior sum (it has just passed the dedup check and isn't in the log yet,
  // but a retry could be) and add this refund's amount.
  const cumulativeRefunded = sumPriorRefundedMinor(doc.lifecycle_log, refundId) + refundAmt
  // Never downgrade an already-fully-refunded document: a prior full refund may
  // have been recorded without a parseable minor amount (legacy `{ event:
  // "refunded" }`), so the cumulative sum alone would understate it.
  const fullyRefunded = doc.payment_status === "refunded" || cumulativeRefunded >= combinedTotal
  const newStatus = fullyRefunded ? "refunded" : "partial"
  const actor = await ctx.getUserId()
  const newLog = [
    ...doc.lifecycle_log,
    {
      event: newStatus === "refunded" ? "refunded" : "partially_refunded",
      actor,
      ts: new Date().toISOString(),
      refund_amount_minor: refundAmt.toString(),
      shopify_refund_id: refundId,
    },
  ]
  // Recorded once per refund id; a re-run skips the record and still makes sure of the credit
  // notes below (each found instead of issued twice when an earlier run already issued it).
  if (!alreadyRecorded) {
    await ctx.db.update("documents", doc.id, {
      payment_status: newStatus,
      lifecycle_log: newLog,
    })
  }
  if (fullyRefunded && !alreadyRecorded) {
    // The whole order's money came back — the sibling document(s) are refunded
    // too (their lifecycle carries a reference entry, amount attributed above).
    for (const sibling of docs) {
      if (sibling.id === doc.id || sibling.payment_status === "refunded") continue
      await ctx.db.update("documents", sibling.id, {
        payment_status: "refunded",
        lifecycle_log: [
          ...sibling.lifecycle_log,
          {
            event: "refunded",
            actor,
            ts: new Date().toISOString(),
            shopify_refund_id: refundId,
            detail: "full order refund recorded on sibling document",
          },
        ],
      })
    }
  }
  // Auto-issue the reversing credit note(s). Best-effort and gated on the issue
  // pipeline being present (it is on the real kernel event ctx; absent in db-only
  // unit ctxs). A failure here must NOT unwind the refund we just recorded.
  if (hasIssuePipeline(ctx)) {
    try {
      await autoIssueRefundCreditNotes(ctx, {
        invoices: docs,
        primaryDocId: doc.id,
        fullyRefunded,
        refundAmt,
        refundId,
      })
    } catch (err) {
      // Credit-note issuance is best-effort; the refund status change stands. Still logged
      // with real context so a swallowed failure never goes unrecorded.
      ctx.logger?.error?.(
        "invoicing: auto refund credit note issuance failed, refund status stands",
        {
          refund_id: refundId,
          shopify_order_id: orderId,
          document_id: doc.id,
          err: err instanceof Error ? err.message : String(err),
        },
      )
    }
  }

  return {
    status: "ok",
    document_id: doc.id,
    payment_status: alreadyRecorded ? doc.payment_status : newStatus,
  }
}
