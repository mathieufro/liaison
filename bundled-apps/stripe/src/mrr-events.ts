// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The MRR movement log: one append-only row each time a subscription's counted
// monthly amount changes. APPEND ONLY: this module inserts and reads
// `stripe_mrr_events`; no code anywhere updates or deletes one (a guard test
// reads the sources for it).
//
// ONCE. A movement is written by the call whose own mirror write changed the
// stored `mrr_minor` (mirror.ts hands that call the row as it was). Two writers
// (the webhook and the nightly heal) race on the mirror's compare-and-swap: one
// wins and appends, the other finds the stored value already equal and appends
// nothing. A change already carried by the log (the rebuild wrote it first) is
// not written again. A webhook that lands after a heal, or a heal after a
// webhook, therefore never counts a change twice, whatever their ids.
//
// A movement lost between the mirror write and its append (a crash) is written
// again by the rebuild (mrr-rebuild.ts) from Stripe's events of the last 30 days.

import type { MirrorDb } from "./mirror"
import { movementKind } from "./mrr"

type Obj = Record<string, unknown>

export type MovementSource = "webhook" | "reconcile"

export interface Movement {
  eventId: string
  subscriptionId: string
  customerId: string
  currency: string
  before: number
  after: number
  at: string
  source: MovementSource
}

/** The latest `after_minor` the log holds for a subscription, or null when it holds none. */
export async function chainAfter(
  db: MirrorDb,
  subscriptionId: string,
): Promise<{ after: number; at: string } | null> {
  const rows = (await db.findMany("stripe_mrr_events", {
    where: { subscription_id: subscriptionId },
    orderBy: { at: "desc" },
    limit: 1,
  })) as Obj[]
  const r = rows[0]
  if (!r) return null
  const at = r.at instanceof Date ? r.at.toISOString() : String(r.at)
  return { after: Number(r.after_minor), at }
}

/** Append one movement. False when a row with this id is already there (a replay adds nothing). */
export async function appendMovement(db: MirrorDb, m: Movement): Promise<boolean> {
  const data = {
    stripe_event_id: m.eventId,
    subscription_id: m.subscriptionId,
    customer_id: m.customerId,
    at: m.at,
    kind: movementKind(m.before, m.after),
    delta_minor: m.after - m.before,
    before_minor: m.before,
    after_minor: m.after,
    currency: m.currency,
    source: m.source,
  }
  try {
    await db.insert("stripe_mrr_events", data)
    return true
  } catch (err) {
    const same = await db.findMany("stripe_mrr_events", {
      where: { stripe_event_id: m.eventId },
      limit: 1,
    })
    if (same.length > 0) return false
    throw err
  }
}

export interface RecordOptions {
  source: MovementSource
  /** The Stripe event id for a webhook; ignored for a heal, which names itself. */
  eventId?: string
  /** When the change happened (the event's time) or was found (the heal's time). */
  at: string
}

/**
 * The callback `writeMirror` takes for a subscription row: append the movement
 * this write made, if it made one.
 */
export function recordMovement(
  db: MirrorDb,
  row: Obj,
  opts: RecordOptions,
): (before: Obj | null) => Promise<void> {
  return async (seen) => {
    const before = seen ? Number(seen.mrr_minor) || 0 : 0
    const after = Number(row.mrr_minor) || 0
    if (before === after) return
    const subscriptionId = String(row.stripe_id)
    const chain = await chainAfter(db, subscriptionId)
    if (chain && chain.after === after) return
    const period = String(row.current_period_start ?? "")
    const healId = `reconcile:${subscriptionId}:${after}:${period}`
    let eventId = opts.source === "webhook" && opts.eventId ? opts.eventId : healId
    if (opts.source === "reconcile") {
      const taken = (await db.findMany("stripe_mrr_events", {
        where: { stripe_event_id: eventId },
        limit: 1,
      })) as Obj[]
      // The same heal id in the same period for another change: keep both.
      if (taken[0] && Number(taken[0].before_minor) !== before)
        eventId = `${healId}:${before}:${opts.at}`
    }
    await appendMovement(db, {
      eventId,
      subscriptionId,
      customerId: String(row.customer_id ?? ""),
      currency: String(row.currency ?? ""),
      before,
      after,
      at: opts.at,
      source: opts.source,
    })
  }
}
