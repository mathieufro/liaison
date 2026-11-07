// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Free reads: track, get_shipment, get_documents, list_content_categories.
// Each re-fetches live from Boxtal and returns ONLY the normalized projected
// fields — never the raw payload, and never a stored document URL (documents
// re-fetch a fresh signed URL on every read; only url-stripped descriptors are
// persisted by the webhook/link store).

import { getClientOrError } from "./lib/get-client"
import { sourceTrackingFromLabel } from "./label-tracking"
import { applyTrackingChanged, isOperatorVisibleRef, shipmentRefFromLabelUrl } from "./link-store"
import { BoxtalApiError } from "./lib/boxtal-v3-client"
import type {
  NormalizedTracking,
  ShippingDocument,
} from "./lib/boxtal-v3-client"
import type { BoxtalToolCtx } from "./ctx"

type ReadsCtx = BoxtalToolCtx

/**
 * Boxtal returns a functional 4xx (NoShippingDocumentException /
 * NoPackageTrackingFoundException) when the label or tracking is not yet
 * available for a freshly-created order. That is a normal "not ready yet"
 * state, NOT a tool failure — callers surface it as an empty/pending result so
 * an agent/operator polling right after create gets a 200, not a 500. (Live
 * Boxtal raised these where the mock always returned data — M0.3.)
 */
export function isBoxtalNotReady(err: unknown, resource: string): boolean {
  // BoxtalApiError carries status+body in-process, but across the sandbox-worker
  // IPC boundary (worker-pool) the error is flattened to a plain Error that keeps
  // only its message ("Boxtal v3 GET .../{resource} failed (422)"). Match either
  // form: a 404/422 — from the status OR the message — on the {resource} endpoint
  // is the "not generated yet" signal. A GET has no request body to validate, so
  // a 4xx on a read endpoint is always "not ready," never a validation error.
  const status = err instanceof BoxtalApiError ? err.status : undefined
  const message = err instanceof Error ? err.message : String(err)
  const body = err instanceof BoxtalApiError ? err.body : ""
  const is404or422 = status === 404 || status === 422 || /\((?:404|422)\)/.test(message)
  return is404or422 && `${message} ${body}`.includes(resource)
}

const EMPTY_TRACKING: NormalizedTracking = {
  tracking_number: null,
  tracking_status: null,
  events: [],
  pickup_deadline: null,
}

/**
 * Reject an unresolved `@ref:<uuid>:<key>` token passed as a shipment/order id.
 * These tokens are minted by create_shipment for a SEQUENCED bundle and are
 * resolved to a concrete id ONLY on the host-side approvals cascade path — a
 * standalone track/get_shipment/get_documents tool call never runs through that
 * resolution, so the raw token would otherwise flow into the DB query (against a
 * uuid/text order column) and surface as an opaque Postgres "22P02 invalid input
 * syntax" 500. Fail early with an agent-actionable message instead. Resolution
 * is not reachable from the sandbox, so rejecting is the only correct option.
 */
function assertNotRefToken(id: string): void {
  if (/^@ref:/i.test(id)) {
    throw new Error(
      `id "${id}" looks like an unresolved @ref token; pass the actual shipment/order id. ` +
        `@ref tokens only resolve inside a sequenced bundle (create_shipment then act on its output), ` +
        `not in a standalone track/get_shipment/get_documents call.`,
    )
  }
}

/** Resolve a shipment row by EITHER its Boxtal order id OR its local row id.
 *  ready_list / search surface the local `id`, and the read tools' docs say both
 *  are accepted, so match on both (Boxtal order id first, then the local id). */
async function findRowByOrderId(ctx: ReadsCtx, id: string) {
  const byOrder = (await ctx.db.findMany("shipment", { where: { boxtal_order_id: id }, limit: 1 })) as Array<Record<string, unknown>>
  if (byOrder[0]) return byOrder[0]
  const byRowId = (await ctx.db.findMany("shipment", { where: { id }, limit: 1 })) as Array<Record<string, unknown>>
  return byRowId[0] ?? null
}

/** The Boxtal ORDER id to call the carrier API with, resolved from whatever id the
 *  caller passed (order id OR local row id): a caller passing the local shipment id
 *  (as ready_list / search surface it) must still reach Boxtal with the REAL order
 *  id, or the carrier read silently returns nothing (get_documents came back empty,
 *  track/get_shipment missed the row). Falls back to the raw id when there is no
 *  local row (a bare Boxtal order id for a shipment not indexed locally). */
async function resolveShipment(
  ctx: ReadsCtx,
  id: string,
): Promise<{ row: Record<string, unknown> | null; orderId: string }> {
  const row = await findRowByOrderId(ctx, id)
  const oid = row?.boxtal_order_id
  return { row, orderId: typeof oid === "string" && oid ? oid : id }
}

export interface TrackResult {
  tracking_number: string | null
  tracking_status: string | null
  events: NormalizedTracking["events"]
  recipient_summary: string | null
  // The external order reference (Shopify order number / merchant order id) this shipment is for —
  // so a per-shipment track read also yields the ORDER for the dossier without a separate shopify call.
  external_id: string | null
  // The carrier-reported collection deadline for a parcel sitting at a pickup point
  // (REACHED_DELIVERY_PICKUP_POINT) — the date it must be collected by before it returns
  // to sender. Null for any non-pickup-point parcel. Authoritative (carrier-set, never
  // fabricated): an agent deciding which relay parcels are "about to expire" must read THIS,
  // not estimate a deadline from the arrival date.
  pickup_deadline: string | null
  /** Present when Boxtal is not connected — see getClientOrError. */
  error?: { code: string; message: string }
}

/** Live tracking merged with the local link row (response-filtered). */
export async function track(ctx: ReadsCtx, input: { id: string }): Promise<TrackResult> {
  assertNotRefToken(input.id)
  const client = await getClientOrError(ctx)
  if ("error" in client) {
    return { ...EMPTY_TRACKING, events: [], recipient_summary: null, external_id: null, error: client.error }
  }
  // Resolve the row + Boxtal order id ONCE up front, so a caller passing the local
  // shipment row id (as ready_list/search surface) still reaches Boxtal with the
  // real order id AND finds its link row for recipient/external fields.
  const { row, orderId } = await resolveShipment(ctx, input.id)
  let tracking: NormalizedTracking
  try {
    tracking = await client.v3.getTracking(orderId)
  } catch (err) {
    // Tracking not available yet (NoPackageTrackingFoundException) for a just-
    // created order → empty tracking, not a tool error.
    if (isBoxtalNotReady(err, "tracking")) {
      return {
        ...EMPTY_TRACKING,
        events: [],
        recipient_summary: (row?.recipient_summary as string | null) ?? null,
        external_id: (row?.external_id as string | null) ?? null,
      }
    }
    throw err
  }
  if (tracking.tracking_status) {
    // Use the latest event's OWN timestamp. When the live response carries no
    // dated event, DO NOT stamp now() — a wall-clock stamp always wins the
    // link-store guard and would suppress a later, correctly-timestamped
    // webhook for the same status (I4). Skip the snapshot write instead.
    const at = latestEventTimestamp(tracking)
    if (at) {
      // Best effort, like get_documents' reference backfill: the snapshot holds Boxtal's own
      // status, never the caller's data, so a write that fails (or a run that may not write)
      // never fails the read. The TRACKING_CHANGED webhook or the next read writes it.
      try {
        await applyTrackingChanged(ctx, orderId, {
          tracking_status: tracking.tracking_status,
          tracking_number: tracking.tracking_number,
          at,
        })
      } catch (err) {
        ctx.logger?.warn?.("boxtal: track could not refresh the shipment snapshot", {
          orderId,
          err: String(err),
        })
      }
    }
  }
  return {
    tracking_number: tracking.tracking_number,
    tracking_status: tracking.tracking_status,
    events: tracking.events,
    recipient_summary: (row?.recipient_summary as string | null) ?? null,
    external_id: (row?.external_id as string | null) ?? null,
    pickup_deadline: tracking.pickup_deadline,
  }
}

/** Epoch ms of a Boxtal event time, for ORDERING only. Boxtal sends zoneless times
 *  ("2026-07-24 17:03:00"); they are all read the same way here, so their order is right
 *  whatever zone they are in. Null when unparseable. */
export function eventSortMs(at: string): number | null {
  const s = at.trim()
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)
  const ms = Date.parse(zoned ? s : `${s.replace(" ", "T")}Z`)
  return Number.isFinite(ms) ? ms : null
}

/** The timestamp of the newest dated event in a tracking read: the EVENT time to stamp as
 *  the replay watermark, never a wall clock. Boxtal returns history newest first and carriers
 *  report checkpoints out of order, so the newest is found by time, never by position. The
 *  string is returned exactly as Boxtal sent it, so it compares like a webhook's own time. */
export function latestEventTimestamp(tracking: NormalizedTracking): string | null {
  let best: string | null = null
  let bestMs = Number.NEGATIVE_INFINITY
  let fallback: string | null = null
  for (const e of tracking.events) {
    if (!e?.at) continue
    fallback ??= e.at
    const ms = eventSortMs(e.at)
    if (ms !== null && ms > bestMs) {
      best = e.at
      bestMs = ms
    }
  }
  return best ?? fallback
}

export interface ShipmentView {
  id: string
  order_status: string
  tracking_status: string | null
  tracking_number: string | null
  recipient_summary: string | null
  offer_code: string | null
  /** When the shipment record itself was created (the auto-injected `shipment.created_at`
   *  column) — the most operator-useful date for a cancel/claim approval card, since a
   *  shipment carries no separate "ship date" field. Null when there is no local row yet. */
  created_at: string | null
  /** Set when there is no tracking number yet: says why, and where the real one is. */
  tracking_note?: string
  /** Present when Boxtal is not connected — see getClientOrError. */
  error?: { code: string; message: string }
}

/**
 * Boxtal's tracking endpoint knows nothing until the carrier's first scan, and a label bought at
 * create_shipment normally shows the carrier's tracking number. A null here must never read as
 * "this parcel has no tracking". Nothing here reads the label, so the note states no fact about it.
 */
export const TRACKING_NOT_SCANNED_NOTE =
  "No tracking number from Boxtal yet: the carrier has not scanned the parcel. Do not conclude the parcel has no tracking. The label may show one (get_documents, LABEL)."

/** On-demand refresh: live order + tracking, update the snapshot, merged view. */
export async function getShipment(ctx: ReadsCtx, input: { id: string }): Promise<ShipmentView> {
  assertNotRefToken(input.id)
  const client = await getClientOrError(ctx)
  if ("error" in client) {
    return {
      id: input.id,
      order_status: "",
      tracking_status: null,
      tracking_number: null,
      recipient_summary: null,
      offer_code: null,
      created_at: null,
      error: client.error,
    }
  }
  // Resolve the row + Boxtal order id ONCE up front (accepts the local row id too).
  const { row, orderId } = await resolveShipment(ctx, input.id)
  const order = await client.v3.getShippingOrder(orderId)
  let tracking: NormalizedTracking
  try {
    tracking = await client.v3.getTracking(orderId)
  } catch (err) {
    // Tracking not ready yet → still return the order view with empty tracking.
    if (!isBoxtalNotReady(err, "tracking")) throw err
    tracking = { ...EMPTY_TRACKING, events: [] }
  }
  // A tracking read with nothing in it (not scanned yet) never wipes what the row already knows:
  // a stored tracking number or status stays until Boxtal reports a real one.
  let trackingNumber =
    tracking.tracking_number ?? ((row?.tracking_number as string | null | undefined) ?? null)
  // Not scanned yet: the label already prints the carrier's number (FedEx Regional Economy,
  // Domestic Express), so read it from there rather than report none.
  if (!trackingNumber && row) {
    trackingNumber = await sourceTrackingFromLabel(ctx, {
      id: row.id as string,
      boxtal_order_id: orderId,
      tracking_number: null,
      offer_code: (row.offer_code as string | null | undefined) ?? null,
      tracking_to_confirm: (row.tracking_to_confirm as boolean | null | undefined) ?? null,
      queue_facts: row.queue_facts,
      contact_ref: (row.contact_ref as string | null | undefined) ?? null,
      kind: (row.kind as string | null | undefined) ?? null,
      tracking_label_attempts: (row.tracking_label_attempts as number | null | undefined) ?? null,
    })
  }
  const trackingStatus =
    tracking.tracking_status ?? ((row?.tracking_status as string | null | undefined) ?? null)
  if (row) {
    // Best effort, like track: only Boxtal's own order and tracking state is written back, so a
    // failed write never fails the read; the view below is the live one either way.
    try {
      await ctx.db.update("shipment", String(row.id), {
        order_status: order.order_status,
        tracking_status: trackingStatus,
        tracking_number: trackingNumber,
        // The carrier reported its own number: it is no longer only the label's.
        ...(tracking.tracking_number ? { tracking_from_label: false, tracking_to_confirm: false } : {}),
        status_fetched_at: new Date().toISOString(),
      })
    } catch (err) {
      ctx.logger?.warn?.("boxtal: get_shipment could not refresh the shipment snapshot", {
        shipmentId: String(row.id),
        err: String(err),
      })
    }
  }
  return {
    id: input.id,
    order_status: order.order_status,
    tracking_status: trackingStatus,
    tracking_number: trackingNumber,
    recipient_summary: (row?.recipient_summary as string | null) ?? null,
    offer_code: (row?.offer_code as string | null) ?? null,
    created_at: (row?.created_at as string | null) ?? null,
    ...(trackingNumber ? {} : { tracking_note: TRACKING_NOT_SCANNED_NOTE }),
  }
}

export interface DocumentsResult {
  documents: ShippingDocument[]
  generating: boolean
  /** Present when Boxtal is not connected — see getClientOrError. */
  error?: { code: string; message: string }
}

/** Live document fetch — always re-mints signed URLs; never returns a stored URL. */
export async function getDocuments(ctx: ReadsCtx, input: { id: string }): Promise<DocumentsResult> {
  assertNotRefToken(input.id)
  const { row, orderId } = await resolveShipment(ctx, input.id)
  if (!row) return { documents: [], generating: false }
  const client = await getClientOrError(ctx)
  if ("error" in client) {
    return { documents: [], generating: false, error: client.error }
  }
  let documents: ShippingDocument[]
  try {
    documents = await client.v3.getDocuments(orderId)
  } catch (err) {
    // Label not generated yet → Boxtal raises a 4xx (NoShippingDocumentException)
    // instead of an empty list. Treat as "still generating," not a tool error.
    if (isBoxtalNotReady(err, "shipping-document")) {
      return { documents: [], generating: true }
    }
    throw err
  }
  // No LABEL yet → label still generating (PENDING/REQUESTED orders).
  const generating = documents.length === 0
  // Capture Boxtal's operator-visible shipment reference off the label name while we hold the
  // signed URLs (they are never stored). Best effort and write-once: a read must not fail over
  // a cosmetic backfill, and the reference never changes.
  if (!isOperatorVisibleRef(row.boxtal_shipment_ref)) {
    const ref = documents.map((d) => shipmentRefFromLabelUrl(d.url)).find((r) => r != null) ?? null
    if (ref) {
      try {
        await ctx.db.update("shipment", String(row.id), { boxtal_shipment_ref: ref })
      } catch {
        // ignore: the next read (or the DOCUMENT_CREATED webhook) writes it
      }
    }
  }
  return { documents, generating }
}

export interface ContentCategoriesResult {
  categories: Array<{ id: string; label: string }>
  /** Present when Boxtal is not connected — see getClientOrError. */
  error?: { code: string; message: string }
}

export async function listContentCategories(
  ctx: ReadsCtx,
  _input: Record<string, never>,
): Promise<ContentCategoriesResult> {
  const client = await getClientOrError(ctx)
  if ("error" in client) {
    return { categories: [], error: client.error }
  }
  const categories = await client.v3.listContentCategories()
  return { categories }
}
