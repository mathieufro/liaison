// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scheduled tracking reconciliation — the safety net under the webhook stream.
//
// The app learns a parcel's journey from Boxtal's TRACKING_CHANGED /
// DOCUMENT_CREATED webhooks. That stream is the ONLY writer of `tracking_status`
// outside a manual `track` / `get_shipment` call, and it is a single point of
// failure with NO alarm on it: when the kernel webhook secret and Boxtal's
// registered subscription secret drift apart, every delivery is rejected at the
// verifier with 401 `signature_mismatch` BEFORE it reaches a handler — so not
// even a `webhook_delivery` ledger row is written. Nothing anywhere goes red.
//
// That is not hypothetical: it is exactly what happened in prod between
// 2026-06-30 and 2026-07-31. One single delivery was ever recorded, 19 of 23
// shipments never received a status at all, and delivered parcels sat in the
// operator's "Ready to ship" queue for weeks while Boxtal had known they were
// DELIVERED all along. `webhooks_repair` clears the secret drift, but a fix that
// relies on someone NOTICING a silent stream is not a fix.
//
// So this job re-reads the authoritative state from Boxtal on a schedule and
// writes it back, exactly as `get_shipment` does for one row. Webhooks stay the
// fast path (near-real-time); this is the slow path that GUARANTEES convergence.
// A missed, rejected, or never-sent event now costs one cron interval of
// staleness instead of being lost forever.
//
// Deliberately bounded and boring:
//   * only NON-TERMINAL rows are polled — a DELIVERED/RETURNED/LOST/CANCELLED
//     parcel is done and is never re-fetched, so steady-state cost is the size
//     of the in-flight fleet, not the size of history;
//   * oldest-checked-first (`status_fetched_at` ascending, never-checked first),
//     so a bounded batch still round-robins the whole fleet across runs;
//   * one shipment's failure is logged and skipped, never fatal to the batch;
//   * writes ONLY when a value actually changed, so an unchanged fleet produces
//     no writes and no events.

import { getClientOrError } from "./lib/get-client"
import { isBoxtalNotReady, latestEventTimestamp } from "./reads"
import { ToolError } from "@liaison/app-sdk"
import {
  ABANDONED_LINK_STATE,
  isStaleReservation,
  STALE_RESERVATION_MS,
  UNFINISHED_LINK_STATES,
} from "./link-store"
import { sourceTrackingFromLabel } from "./label-tracking"
import { findShipmentsInAny, shipmentHasLabel } from "./queues"
import { BoxtalApiError, type NormalizedOrder } from "./lib/boxtal-v3-client"
import type { BoxtalToolCtx } from "./ctx"
import { checkMissingLabels, type LabelMissingResult } from "./label-missing"

/**
 * Terminal tracking states: the parcel's journey is over and Boxtal will not
 * report anything further, so re-polling it forever is pure waste. RETURNED and
 * LOST are terminal too — they need an operator/claim, not another poll.
 */
const TERMINAL_TRACKING: ReadonlySet<string> = new Set(["DELIVERED", "RETURNED", "LOST"])
/** The tracking states still worth polling: every modelled state that is not terminal. */
const NON_TERMINAL_TRACKING = [
  "",
  "ANNOUNCED",
  "SHIPPED",
  "IN_TRANSIT",
  "OUT_FOR_DELIVERY",
  "FAILED_ATTEMPT",
  "REACHED_DELIVERY_PICKUP_POINT",
  "EXCEPTION",
  "INCIDENT",
]

/** Default rows per run. Bounded so one run stays well inside `timeoutMs`. */
export const DEFAULT_RECONCILE_BATCH = 40

export interface ReconcileRow {
  id: string | number
  boxtal_order_id?: string | null
  order_status?: string | null
  tracking_status?: string | null
  tracking_number?: string | null
  /** The EVENT-TIME watermark: the timestamp of the last tracking event actually applied to
   *  this row. It is the link-store's replay guard, NOT a record of when we last looked. */
  status_fetched_at?: string | null
  /** When this job last POLLED the row. Drives the round-robin only. */
  polled_at?: string | null
  offer_code?: string | null
  /** The held tracking number was read off the label, not reported by the carrier. */
  tracking_from_label?: boolean | null
  tracking_to_confirm?: boolean | null
}

/** Rows per run for the orphaned-reservation sweep. Small on purpose: prod
 *  steady state is ZERO such rows, and each one costs a live Boxtal read that
 *  shares this job's `timeoutMs` with the tracking batch. */
export const DEFAULT_ORPHAN_BATCH = 10

export interface OrphanSweepResult {
  /** Reservations old enough to be considered orphaned. */
  candidates: number
  /** Orphans actually probed against Boxtal this run (bounded by the batch). */
  checked: number
  /** Orphans matched to a live Boxtal order and flipped to `created`. */
  resolved: number
  /** Orphans Boxtal could not be asked about, or had no answer for. They stay
   *  exactly as they are and surface in stuck_list for a human. */
  unresolved: number
  /** Probes that errored: logged, skipped, retried next run. */
  failed: number
}

export interface ReconcileResult {
  /** Rows considered in-flight and therefore eligible for a refresh. */
  candidates: number
  /** Rows actually fetched from Boxtal this run (bounded by `limit`). */
  checked: number
  /** Rows whose order/tracking state actually moved (a write happened). */
  updated: number
  /** Rows whose fetch failed — logged, skipped, retried next run. */
  failed: number
  /** The orphaned-reservation sweep that rides along on this cron. */
  orphans: OrphanSweepResult
}

/** A shipment is worth polling while it is neither cancelled nor terminal. */
export function isReconcilable(row: ReconcileRow): boolean {
  if (row.order_status === "CANCELLED") return false
  const t = row.tracking_status
  if (t != null && t !== "" && TERMINAL_TRACKING.has(t)) return false
  // No boxtal order id => nothing to ask Boxtal about (a local-only draft row).
  return typeof row.boxtal_order_id === "string" && row.boxtal_order_id.length > 0
}

/**
 * Never-checked rows sort FIRST (a row we have never fetched is the most likely
 * to be wrong), then oldest-checked first. Ties broken by id so the order is
 * deterministic and a batch boundary can never starve one row forever.
 */
export function byStalestFirst(a: ReconcileRow, b: ReconcileRow): number {
  // Rows written before `polled_at` existed fall back to the old column, so the first run after
  // the upgrade still round-robins sensibly instead of treating the whole fleet as never-checked.
  const av = a.polled_at ?? a.status_fetched_at ?? ""
  const bv = b.polled_at ?? b.status_fetched_at ?? ""
  if (av !== bv) return av < bv ? -1 : 1
  return String(a.id) < String(b.id) ? -1 : 1
}


// ── orphaned-reservation sweep ───────────────────────────────────────────────
//
// `create_shipment` is NOT atomic and the sandbox worker pool kills a handler at
// 62s with no rollback. A kill landing between `createShippingOrder` returning
// (the label is PAID) and `finalizeCreated` writing the order id leaves a row in
// `create_in_flight` with `boxtal_order_id: null`. Such a row has no
// `tracking_status`, so every tracking-based queue classifies it as nothing and a
// PAID label is invisible to every operator. Prod is clean today (78 rows, all
// `created`): this closes the hole before it costs money.
//
// WHAT THIS SWEEP DOES TO A ROW: read Boxtal, and at most flip the row to
// `created` with the order id and status Boxtal just reported.
// WHAT IT NEVER DOES: buy, re-buy, cancel, release or delete anything. There is
// no write path here that can spend or destroy money, by construction. Anything
// it cannot resolve is left EXACTLY as it is and surfaced in `stuck_list`
// (family `create_orphan`) for a human to settle against the Boxtal dashboard.
//
// MATCHING, honestly bounded: Boxtal's API has NO endpoint that lists or searches
// an account's shipping orders (see import.ts), so the only order a reservation
// can be matched to by API is one whose id we already hold. `orderProbe` is
// therefore pluggable: it reads back `boxtal_order_id` when the row has one, and
// otherwise asks the client for an external-id lookup IF the client exposes one
// (`v3.findShippingOrderByExternalId`, which Boxtal does not offer today). When
// no lookup is possible the row is reported, never guessed at.
//
// SETTLING BY A PERSON: `settleOrphanedCreate` (tool `settle_orphan_create`) is
// how an operator closes a row the sweep cannot: after checking the Boxtal
// dashboard they either ADOPT the order they found (the sweep's own write, after
// a read-back of that order id) or RELEASE the reservation as never bought
// (`create_abandoned`: a terminal local state that frees the document for a new
// label, leaves stuck_list, is never swept again, and writes NO Boxtal status).
//
// LOG CADENCE: an orphan nobody has settled yet is logged once, then at most
// once per ORPHAN_REPORT_INTERVAL_MS (stamped on the row as
// `orphan_reported_at`), not on every 15-minute tick. stuck_list is the place it
// stays visible; the log is only the first nudge.

/** The subset of a shipment row the orphan sweep reads. */
export interface OrphanRow {
  id: string | number
  link_state?: string | null
  order_status?: string | null
  boxtal_order_id?: string | null
  external_id?: string | null
  document_ref?: string | null
  created_at?: string | null
  /** When the sweep last logged this row as needing a human (log cadence). */
  orphan_reported_at?: string | null
}

/** An unsettled orphan is re-logged at most this often (the first sighting logs at once). */
export const ORPHAN_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Should the sweep log this unresolved orphan now? Never logged, or logged long enough ago. */
export function orphanReportDue(row: OrphanRow, nowMs: number): boolean {
  const last = row.orphan_reported_at ? Date.parse(row.orphan_reported_at) : Number.NaN
  if (Number.isNaN(last)) return true
  return nowMs - last >= ORPHAN_REPORT_INTERVAL_MS
}

/** A read-only probe: "does Boxtal have an order for this reservation?".
 *  Returns the live order, or null for "no answer" (which means REPORT, never
 *  assume). It must never mutate anything at Boxtal. */
export type OrphanOrderProbe = (row: OrphanRow) => Promise<NormalizedOrder | null>

/** Client shape the default probe needs. `findShippingOrderByExternalId` is
 *  optional because the live Boxtal API has no such read yet; when one exists,
 *  exposing it on the client is all this sweep needs to use it. */
export interface OrphanProbeClient {
  v3: {
    getShippingOrder(id: string): Promise<NormalizedOrder>
    findShippingOrderByExternalId?(externalId: string): Promise<NormalizedOrder | null>
  }
}

/** The default read-only probe: order id first, external id second. */
export function boxtalOrderProbe(client: OrphanProbeClient): OrphanOrderProbe {
  return async (row: OrphanRow) => {
    const orderId = typeof row.boxtal_order_id === "string" ? row.boxtal_order_id : ""
    if (orderId) return client.v3.getShippingOrder(orderId)
    const externalId = typeof row.external_id === "string" ? row.external_id : ""
    if (externalId && typeof client.v3.findShippingOrderByExternalId === "function") {
      return client.v3.findShippingOrderByExternalId(externalId)
    }
    // Nothing to ask Boxtal with: report it (stuck_list) rather than guess.
    return null
  }
}

/**
 * Sweep reservations that were started and never confirmed, and are now older
 * than `staleMs` (default STALE_RESERVATION_MS). A reservation that is
 * legitimately in flight right now is younger than that and is never touched.
 *
 * Resolve or report, nothing else.
 */
export async function reconcileOrphanedCreates(
  ctx: BoxtalToolCtx,
  rows: OrphanRow[],
  probe: OrphanOrderProbe,
  opts: { limit?: number; staleMs?: number; now?: () => number } = {},
): Promise<OrphanSweepResult> {
  const limit = opts.limit ?? DEFAULT_ORPHAN_BATCH
  const staleMs = opts.staleMs ?? STALE_RESERVATION_MS
  const nowMs = (opts.now ?? (() => Date.now()))()
  const candidates = rows.filter((r) => isStaleReservation(r, nowMs, staleMs))
  const batch = candidates.slice(0, limit)

  let resolved = 0
  let unresolved = 0
  let failed = 0
  for (const row of batch) {
    try {
      const order = await probe(row)
      if (!order || !order.id) {
        unresolved++
        // Once per row, then at a low cadence: it stays listed in stuck_list either way.
        if (orphanReportDue(row, nowMs)) {
          ctx.logger?.warn?.("boxtal reconcile: orphaned create reservation needs a human", {
            shipmentId: String(row.id),
            documentRef: row.document_ref ?? null,
            externalId: row.external_id ?? null,
            note:
              "check the Boxtal dashboard for a paid label, then settle it with settle_orphan_create; nothing was bought, cancelled or retried",
          })
          await ctx.db.update("shipment", String(row.id), {
            orphan_reported_at: new Date(nowMs).toISOString(),
          })
        }
        continue
      }
      // The ONLY write this sweep makes: adopt the order Boxtal just confirmed.
      // It keeps the row on the same (document_ref, kind, batch_seq) slot the
      // reservation already held, so the partial-unique backstop in link-store
      // is untouched, and it never writes a CANCELLED status.
      await ctx.db.update("shipment", String(row.id), {
        link_state: "created",
        boxtal_order_id: order.id,
        ...(order.order_status ? { order_status: order.order_status } : {}),
      })
      resolved++
      ctx.logger?.info?.("boxtal reconcile: orphaned create reservation resolved", {
        shipmentId: String(row.id),
        boxtalOrderId: order.id,
      })
    } catch (err) {
      failed++
      ctx.logger?.warn?.("boxtal reconcile: orphan probe failed", {
        shipmentId: String(row.id),
        err: String(err),
      })
    }
  }

  return { candidates: candidates.length, checked: batch.length, resolved, unresolved, failed }
}

// ── settling an orphan by hand ───────────────────────────────────────────────

export interface SettleOrphanInput {
  /** The shipment row id stuck_list reports (family `create_orphan`). */
  id: string
  /** `adopt`: Boxtal HAS an order for it (give its id). `release`: no label was bought. */
  outcome: "adopt" | "release"
  /** Required for `adopt`: the Boxtal order id found in the dashboard. */
  boxtal_order_id?: string
  /** Optional: what the person checked, kept on the row. */
  note?: string
}

export interface SettleOrphanResult {
  id: string
  outcome: "adopt" | "release"
  link_state: string
  boxtal_order_id: string | null
  order_status: string | null
  document_ref: string | null
}

type SettleClient = { v3: { getShippingOrder(id: string): Promise<NormalizedOrder> } }

interface SettlePlan {
  row: OrphanRow
  patch: Record<string, unknown>
  result: SettleOrphanResult
}

/** Every check, no write: shared by the stage-time preflight and the handler. */
async function planSettle(
  ctx: BoxtalToolCtx,
  input: SettleOrphanInput,
  nowMs: number,
  clientFor: () => Promise<SettleClient | { error: { code: string; message: string } }>,
): Promise<SettlePlan> {
  const id = typeof input.id === "string" ? input.id.trim() : ""
  if (!id) throw new ToolError("Give the shipment row id stuck_list reports.", { code: "invalid_input" })
  if (input.outcome !== "adopt" && input.outcome !== "release") {
    throw new ToolError("outcome must be 'adopt' or 'release'.", { code: "invalid_input" })
  }
  const [row] = (await ctx.db.findMany("shipment", { where: { id }, limit: 1 })) as OrphanRow[]
  if (!row) throw new ToolError(`No shipment ${id}.`, { code: "not_found" })
  if (!isStaleReservation(row, nowMs)) {
    const why =
      row.link_state === ABANDONED_LINK_STATE
        ? "it was already released"
        : row.order_status === "CANCELLED"
          ? "it is cancelled"
          : row.link_state != null && UNFINISHED_LINK_STATES.has(row.link_state)
            ? "its create may still be running (a reservation is only orphaned after 15 minutes)"
            : "it is not an unfinished label purchase"
    throw new ToolError(
      `Shipment ${id} is not an orphaned label purchase: ${why}. Only a stuck_list row of family create_orphan can be settled.`,
      { code: "not_orphan" },
    )
  }
  const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : null
  const settledAt = new Date(nowMs).toISOString()
  const base = { id: String(row.id), outcome: input.outcome, document_ref: row.document_ref ?? null }

  if (input.outcome === "release") {
    const held = typeof row.boxtal_order_id === "string" ? row.boxtal_order_id : ""
    if (held) {
      throw new ToolError(
        `Shipment ${id} already carries Boxtal order ${held}, so a label may exist. Adopt it (outcome 'adopt' with that id), or cancel it in Boxtal first.`,
        { code: "has_order_id" },
      )
    }
    return {
      row,
      // Local only: Boxtal is never told anything, and no fake CANCELLED status is written.
      patch: { link_state: ABANDONED_LINK_STATE, orphan_settled_at: settledAt, orphan_settle_note: note },
      result: { ...base, link_state: ABANDONED_LINK_STATE, boxtal_order_id: null, order_status: null },
    }
  }

  const orderId = typeof input.boxtal_order_id === "string" ? input.boxtal_order_id.trim() : ""
  if (!orderId) {
    throw new ToolError("Adopting needs the Boxtal order id you found in the Boxtal dashboard (boxtal_order_id).", {
      code: "invalid_input",
    })
  }
  const linked = (await ctx.db.findMany("shipment", { where: { boxtal_order_id: orderId }, limit: 2 })) as OrphanRow[]
  const other = linked.find((r) => String(r.id) !== String(row.id))
  if (other) {
    throw new ToolError(
      `Boxtal order ${orderId} is already linked to shipment ${String(other.id)}, so it cannot also be this reservation's label. Re-check the id in the Boxtal dashboard.`,
      { code: "already_linked" },
    )
  }
  const client = await clientFor()
  if ("error" in client) throw new ToolError(client.error.message, { code: client.error.code })
  let order: NormalizedOrder
  try {
    order = await client.v3.getShippingOrder(orderId)
  } catch (err) {
    if (err instanceof BoxtalApiError && (err.status === 404 || err.status === 410)) {
      throw new ToolError(`Boxtal has no shipping order ${orderId}. Re-check the id in the Boxtal dashboard.`, {
        code: "order_not_found",
      })
    }
    throw err
  }
  const orderStatus = order.order_status || null
  return {
    row,
    // The sweep's own write, after a read-back of the order the person named.
    patch: {
      link_state: "created",
      boxtal_order_id: orderId,
      ...(orderStatus ? { order_status: orderStatus } : {}),
      orphan_settled_at: settledAt,
      orphan_settle_note: note,
    },
    result: { ...base, link_state: "created", boxtal_order_id: orderId, order_status: orderStatus ?? row.order_status ?? null },
  }
}

const defaultSettleClient = (ctx: BoxtalToolCtx) => async () => {
  const c = await getClientOrError(ctx)
  return "error" in c ? { error: c.error } : c
}

/**
 * Settle an orphaned create reservation after a person checked the Boxtal dashboard: ADOPT the
 * Boxtal order they found, or RELEASE the reservation as never bought. Never buys, cancels or
 * writes anything at Boxtal; adopt only reads the named order back.
 */
export async function settleOrphanedCreate(
  ctx: BoxtalToolCtx,
  input: SettleOrphanInput,
  opts: { now?: () => number; client?: () => Promise<SettleClient | { error: { code: string; message: string } }> } = {},
): Promise<SettleOrphanResult> {
  const nowMs = (opts.now ?? (() => Date.now()))()
  const plan = await planSettle(ctx, input, nowMs, opts.client ?? defaultSettleClient(ctx))
  await ctx.db.update("shipment", String(plan.row.id), plan.patch)
  ctx.logger?.info?.("boxtal: orphaned create reservation settled", {
    shipmentId: String(plan.row.id),
    outcome: plan.result.outcome,
    boxtalOrderId: plan.result.boxtal_order_id,
  })
  return plan.result
}

/** Stage-time preflight for the gated agent call: the same checks, read-only. */
export async function settleOrphanedCreatePreflight(
  ctx: BoxtalToolCtx,
  input: SettleOrphanInput,
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  try {
    await planSettle(ctx, input, Date.now(), defaultSettleClient(ctx))
    return { ok: true }
  } catch (err) {
    if (err instanceof ToolError) return { error: { code: err.code, message: err.message } }
    throw err
  }
}

const EMPTY_ORPHAN_SWEEP: OrphanSweepResult = {
  candidates: 0,
  checked: 0,
  resolved: 0,
  unresolved: 0,
  failed: 0,
}

/**
 * Re-read live order + tracking state for the stalest in-flight shipments and
 * persist any change. Mirrors `get_shipment`'s write set exactly, so the two
 * paths can never disagree about what "refreshed" means.
 */
export async function reconcileTracking(
  ctx: BoxtalToolCtx,
  opts: { limit?: number; orphanLimit?: number; orphanStaleMs?: number } = {},
): Promise<ReconcileResult> {
  const limit = opts.limit ?? DEFAULT_RECONCILE_BATCH
  const client = await getClientOrError(ctx)
  if ("error" in client) {
    // Not connected is a normal state (app installed, credentials not yet
    // entered) — report an empty run rather than failing the scheduled job.
    ctx.logger?.info?.("boxtal reconcile-tracking: not connected, skipping run")
    return { candidates: 0, checked: 0, updated: 0, failed: 0, orphans: { ...EMPTY_ORPHAN_SWEEP } }
  }

  // Every row still in play, bounded by state (an arbitrary 500-row window left some live parcels
  // never reconciled once the table outgrew it): live orders whose parcel is not terminal yet, plus
  // the unfinished create reservations the orphan sweep below settles.
  const rows = (await findShipmentsInAny(ctx, [
    { order_status: { in: ["PENDING", "REQUESTED", "CONFIRMED"] }, tracking_status: null },
    { order_status: { in: ["PENDING", "REQUESTED", "CONFIRMED"] }, tracking_status: { in: NON_TERMINAL_TRACKING } },
    { link_state: { in: [...UNFINISHED_LINK_STATES] } },
  ])) as unknown as Array<ReconcileRow & OrphanRow>
  const candidates = rows.filter(isReconcilable).sort(byStalestFirst)
  const batch = candidates.slice(0, limit)

  let updated = 0
  let failed = 0
  for (const row of batch) {
    const orderId = String(row.boxtal_order_id)
    try {
      const order = await client.v3.getShippingOrder(orderId)
      let tracking_status: string | null = null
      let tracking_number: string | null = null
      // The number the CARRIER reported on this poll, as opposed to one we already held (possibly
      // read off the label). Only a carrier number clears the label flag.
      let carrierNumber: string | null = null
      let eventAt: string | null = null
      try {
        const tracking = await client.v3.getTracking(orderId)
        tracking_status = tracking.tracking_status
        carrierNumber = tracking.tracking_number || null
        // A read without a number never wipes the one the row holds (a label-read AWB included).
        tracking_number = carrierNumber ?? row.tracking_number ?? null
        eventAt = latestEventTimestamp(tracking)
      } catch (err) {
        // A parcel whose label exists but whose carrier tracking has not been
        // generated yet is NORMAL, not a failure — keep the order status we just
        // read and leave tracking untouched for the next run.
        if (!isBoxtalNotReady(err, "tracking")) throw err
        tracking_status = row.tracking_status ?? null
        tracking_number = row.tracking_number ?? null
      }

      // Not scanned yet and no number held: take the one the label prints. Only then: a row that
      // already has a number (carrier or label) is never re-downloaded, and sourceTrackingFromLabel
      // skips carriers whose label it cannot read.
      if (!tracking_number && shipmentHasLabel(row as { documents?: Array<{ type?: string }> | null })) {
        tracking_number = await sourceTrackingFromLabel(ctx, { ...row, tracking_number: null })
      }
      const clearLabelFlag = carrierNumber != null && row.tracking_from_label === true
      const clearToConfirm = carrierNumber != null && row.tracking_to_confirm === true

      const changed =
        order.order_status !== row.order_status ||
        tracking_status !== (row.tracking_status ?? null) ||
        tracking_number !== (row.tracking_number ?? null) ||
        clearLabelFlag ||
        clearToConfirm

      // Stamp `polled_at` (the round-robin key), NEVER `status_fetched_at`.
      //
      // Prod, 2026-09-14: this job used to stamp `status_fetched_at = now()` on every row it
      // looked at. That column is ALSO the link-store's replay guard, which drops any incoming
      // event whose own timestamp is older than it. Boxtal stamps an ANNOUNCED event at MIDNIGHT
      // (date precision), so one poll made every tracking webhook for that day permanently
      // older-than-stored, and the guard threw them all away: five parcels sat with a null
      // tracking number for hours while Boxtal had the numbers all along. The DOCUMENT_CREATED
      // webhook has no such guard, which is why the same rows did get their label and CONFIRMED
      // status — the tell that separated this from a dead webhook stream.
      //
      // The two meanings now live in two columns: `polled_at` = when we last looked,
      // `status_fetched_at` = the event time of the last state we applied. A reconcile that
      // genuinely moves the state advances the watermark to that EVENT's timestamp when Boxtal
      // gave one, so a later webhook replaying the same event is still correctly ignored.
      await ctx.db.update("shipment", String(row.id), {
        ...(changed
          ? {
              order_status: order.order_status,
              tracking_status,
              tracking_number,
              ...(clearLabelFlag ? { tracking_from_label: false } : {}),
              ...(clearToConfirm ? { tracking_to_confirm: false } : {}),
              ...(eventAt ? { status_fetched_at: eventAt } : {}),
            }
          : {}),
        polled_at: new Date().toISOString(),
      })
      if (changed) updated++
    } catch (err) {
      failed++
      ctx.logger?.warn?.("boxtal reconcile-tracking: shipment refresh failed", {
        shipmentId: String(row.id),
        boxtalOrderId: orderId,
        err: String(err),
      })
    }
  }

  // Same rows, same client, same cron: sweep the orphaned create reservations
  // the tracking pass structurally cannot see (they have no tracking_status).
  const orphans = await reconcileOrphanedCreates(ctx, rows, boxtalOrderProbe(client), {
    limit: opts.orphanLimit,
    staleMs: opts.orphanStaleMs,
  })

  const result: ReconcileResult = {
    candidates: candidates.length,
    checked: batch.length,
    updated,
    failed,
    orphans,
  }
  ctx.logger?.info?.("boxtal reconcile-tracking run", result)
  return result
}

/** Kernel-shaped `(payload, ctx)` wrapper the manifest `jobs` entry names. */
export const reconcileTrackingJobHandler = async (
  payload: { limit?: number; orphanLimit?: number; orphanStaleMs?: number } | undefined,
  ctx: BoxtalToolCtx,
): Promise<ReconcileResult & { labels_missing?: LabelMissingResult }> => {
  const result = await reconcileTracking(ctx, payload ?? {})
  // Same cron: a bought label that never got its document (label-missing.ts). Never fails the run.
  try {
    return { ...result, labels_missing: await checkMissingLabels(ctx) }
  } catch (err) {
    ctx.logger?.warn?.("boxtal reconcile-tracking: missing-label check failed", { err: String(err) })
    return result
  }
}
