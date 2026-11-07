// SPDX-License-Identifier: FSL-1.1-ALv2
//
// import_shipments — pull existing Boxtal orders into the local `shipment`
// table by their Boxtal order id.
//
// WHY per-id and not a backfill: Boxtal's API (v3 AND legacy v1) has NO
// endpoint that lists or searches an account's shipping orders — the only
// reads are GET shipping-order/{id} (+ /tracking, /shipping-document), and
// webhook subscriptions only fire for orders created through the same API
// application. An account's web-UI order history is therefore unreachable by
// API; the honest capability is "import the orders you can name", not "sync
// everything". The notice on the result states this so an agent never
// promises a full backfill.
//
// LOCAL-ONLY writes: this tool creates/updates rows in the app's own table —
// it never creates anything at Boxtal — so it is ungated (unlike
// create_shipment). Document descriptors are stored url-stripped ({type,
// format} only), same discipline as the webhook/link store; signed URLs are
// always re-minted on read via get_documents.

import { getClientOrError } from "./lib/get-client"
import { isBoxtalNotReady } from "./reads"
import {
  BoxtalApiError,
  type NormalizedTracking,
  type ShippingDocument,
} from "./lib/boxtal-v3-client"
import type { BoxtalToolCtx } from "./ctx"

/** Max ids per call — each id costs up to 3 live Boxtal reads. */
const MAX_IDS = 20

const API_LIMIT_NOTICE =
  "Boxtal's API has no order-list endpoint: only orders created through this API application can be fetched, by id. " +
  "Orders created directly in the Boxtal web interface are not reachable by API and cannot be imported."

export interface ImportShipmentsInput {
  /** Boxtal v3 shipping-order ids to import (deduped; max 20 per call). */
  ids: string[]
}

export type ImportOutcome = "imported" | "updated" | "not_found" | "error"

export interface ImportRowResult {
  id: string
  outcome: ImportOutcome
  order_status?: string | null
  tracking_status?: string | null
  message?: string
}

export interface ImportShipmentsResult {
  rows: ImportRowResult[]
  imported: number
  updated: number
  failed: number
  /** The API-capability limitation, stated on every result (see header). */
  notice: string
  /** Present when Boxtal is not connected — see getClientOrError. */
  error?: { code: string; message: string }
}

const EMPTY_TRACKING: NormalizedTracking = {
  tracking_number: null,
  tracking_status: null,
  events: [],
  pickup_deadline: null,
}

function isOrderNotFound(err: unknown): boolean {
  const status = err instanceof BoxtalApiError ? err.status : undefined
  const message = err instanceof Error ? err.message : String(err)
  return (
    status === 404 ||
    status === 422 ||
    /\((?:404|422)\)/.test(message) ||
    message.includes("ShippingOrderNotFoundException")
  )
}

export async function importShipments(
  ctx: BoxtalToolCtx,
  input: ImportShipmentsInput,
): Promise<ImportShipmentsResult> {
  const ids = [...new Set((input.ids ?? []).map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS)
  const client = await getClientOrError(ctx)
  if ("error" in client) {
    return { rows: [], imported: 0, updated: 0, failed: 0, notice: API_LIMIT_NOTICE, error: client.error }
  }

  const rows: ImportRowResult[] = []
  let imported = 0
  let updated = 0
  let failed = 0

  for (const id of ids) {
    let order: Awaited<ReturnType<typeof client.v3.getShippingOrder>>
    try {
      order = await client.v3.getShippingOrder(id)
    } catch (err) {
      failed++
      if (isOrderNotFound(err)) {
        rows.push({
          id,
          outcome: "not_found",
          message:
            "Boxtal doesn't know this order id via the API. Only orders created through this API application are fetchable. Web-interface orders are not.",
        })
      } else {
        rows.push({ id, outcome: "error", message: err instanceof Error ? err.message : String(err) })
      }
      continue
    }

    let tracking: NormalizedTracking = { ...EMPTY_TRACKING, events: [] }
    try {
      tracking = await client.v3.getTracking(id)
    } catch (err) {
      // Tracking not generated yet is a normal state for a fresh order.
      if (!isBoxtalNotReady(err, "tracking")) {
        rows.push({ id, outcome: "error", message: err instanceof Error ? err.message : String(err) })
        failed++
        continue
      }
    }

    let documents: ShippingDocument[] = []
    try {
      documents = await client.v3.getDocuments(id)
    } catch (err) {
      if (!isBoxtalNotReady(err, "shipping-document")) {
        rows.push({ id, outcome: "error", message: err instanceof Error ? err.message : String(err) })
        failed++
        continue
      }
    }

    const patch = {
      order_status: order.order_status,
      tracking_status: tracking.tracking_status,
      tracking_number: tracking.tracking_number,
      // URL-stripped descriptors only — signed URLs are re-minted on read.
      documents: documents.map((d) => ({ type: d.type, format: d.format })),
      status_fetched_at: new Date().toISOString(),
    }

    const existing = (await ctx.db.findMany("shipment", {
      where: { boxtal_order_id: id },
      limit: 1,
    })) as Array<{ id: string | number }>

    if (existing[0]) {
      await ctx.db.update("shipment", String(existing[0].id), patch)
      updated++
      rows.push({ id, outcome: "updated", order_status: patch.order_status, tracking_status: patch.tracking_status })
    } else {
      await ctx.db.insert("shipment", {
        ...patch,
        boxtal_order_id: id,
        link_state: "created",
        kind: "outbound",
        created_by: "user",
      })
      imported++
      rows.push({ id, outcome: "imported", order_status: patch.order_status, tracking_status: patch.tracking_status })
    }
  }

  return { rows, imported, updated, failed, notice: API_LIMIT_NOTICE }
}
