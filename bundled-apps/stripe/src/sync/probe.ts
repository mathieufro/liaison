// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Is Stripe's webhook still reaching us? (`probe-webhook-upstream`, every 15 min.)
//
// EVIDENCE, NOT SILENCE. A quiet account sends nothing for days and is fine. So
// the probe asks the Events API for events newer than the last one we received.
// The connection is `stalled` only when there are such events AND none reached
// us for 2 hours (and the oldest missed one is more than 5 minutes old, so a
// delivery still in flight does not count). A quiet account with no newer event
// upstream is never stalled.
//
// CATCH-UP. While stalled, each probe plays the missed events, oldest first,
// through the same dispatch as a webhook (ledger, re-fetch, mirror, events), so
// the mirror and invoicing do not wait for the webhook to be fixed. A replayed
// event is not a delivery: it leaves the connection's last-event record and the
// `stalled` mark alone, so the state keeps saying the webhook is broken until a
// real delivery arrives.
//
// The kernel reads the answer too (`webhookHealth`): the newest upstream
// activity, or `probed: false` when Stripe could not be asked.
import type { UpstreamProbeResult } from "@liaison/app-sdk"
import { decodeState } from "../connection"
import { handleStripeEvent, type IngestCtx } from "../dispatch"
import { StripeApiError, stripeFetch } from "../http"
import { blockedOverlay, type Install, importInProgress, moveState, readInstall } from "../states"
import { Budget, DEFAULT_BUDGET_MS, type SyncCtx, type SyncOptions } from "./common"

type Obj = Record<string, unknown>

/** No delivery for this long, with newer events upstream: stalled. */
export const STALL_AFTER_MS = 2 * 60 * 60 * 1000
/** A missed event younger than this may still be on its way. */
export const IN_FLIGHT_MS = 5 * 60 * 1000
/** Missed events replayed per probe. */
const REPLAY_PER_RUN = 100

function msOf(v: unknown): number {
  if (v instanceof Date) return v.getTime()
  return typeof v === "string" ? Date.parse(v) : Number.NaN
}

export interface ProbeOutcome extends Record<string, unknown> {
  stalled: boolean
  missed: number
  replayed: number
}

export async function runProbe(
  ctx: SyncCtx,
  opts: SyncOptions = {},
): Promise<UpstreamProbeResult & Partial<ProbeOutcome>> {
  const now = opts.now ?? (() => new Date())
  const install = await readInstall(ctx.db)
  if (!install || decodeState(install.state).base === "not_connected")
    return { upstreamActivityAt: null }
  if (blockedOverlay(install))
    return { probed: false, reason: `the connection reads ${String(install.state)}` }

  const lastMs = msOf(install.last_event_at)
  const sinceMs = Number.isFinite(lastMs) ? lastMs : msOf(install.connected_at)
  let page: { data?: Obj[] }
  try {
    page = await stripeFetch<{ data?: Obj[] }>(ctx, "/v1/events", {
      params: {
        limit: REPLAY_PER_RUN,
        ...(Number.isFinite(sinceMs) ? { "created[gt]": Math.floor(sinceMs / 1000) } : {}),
      },
    })
  } catch (err) {
    if (err instanceof StripeApiError && err.code === "key_invalid") {
      await moveState(ctx, install, [{ kind: "key_refused" }])
    }
    return {
      probed: false,
      reason: err instanceof Error ? err.message : "Stripe could not be asked",
    }
  }
  // Newest first, as Stripe lists them.
  const missed = (Array.isArray(page.data) ? page.data : []).filter(
    (e) => typeof e.id === "string" && typeof e.created === "number",
  )
  const newestMs = missed.length > 0 ? (missed[0]?.created as number) * 1000 : lastMs
  const upstreamActivityAt = Number.isFinite(newestMs) ? new Date(newestMs).toISOString() : null
  if (missed.length === 0) return { upstreamActivityAt, stalled: false, missed: 0, replayed: 0 }

  const oldestMissedMs = (missed[missed.length - 1]?.created as number) * 1000
  const t = now().getTime()
  const silentFor = Number.isFinite(sinceMs) ? t - sinceMs : Number.POSITIVE_INFINITY
  const stalled = silentFor >= STALL_AFTER_MS && t - oldestMissedMs >= IN_FLIGHT_MS
  if (!stalled) return { upstreamActivityAt, stalled: false, missed: missed.length, replayed: 0 }

  if (decodeState(install.state).overlay !== "stalled")
    await moveState(ctx, install, [{ kind: "stalled" }])
  // During the first import the objects come from the import itself.
  if (await importInProgress(ctx.db))
    return { upstreamActivityAt, stalled: true, missed: missed.length, replayed: 0 }
  const budget = new Budget(now, opts.budgetMs ?? DEFAULT_BUDGET_MS)
  const replayed = await replayEvents(ctx, install, [...missed].reverse(), budget)
  return { upstreamActivityAt, stalled: true, missed: missed.length, replayed }
}

/**
 * Play events through the dispatch with the connection's delivery record left
 * alone: an update that records an event (`last_event_at`) is not written, and
 * the state change it would announce is not announced.
 */
export async function replayEvents(
  ctx: SyncCtx,
  _install: Install,
  events: Obj[],
  budget: Budget,
): Promise<number> {
  let skipNextStateChange = false
  const replayCtx: IngestCtx = {
    fetch: (url, o) => ctx.fetch(url, o),
    emit: async (e) => {
      if (e.entity === "connection" && e.action === "state_changed" && skipNextStateChange) {
        skipNextStateChange = false
        return
      }
      await ctx.emit(e)
    },
    db: {
      findMany: (e, o) => ctx.db.findMany(e, o),
      insert: (e, d) => ctx.db.insert(e, d),
      updateMany: (e, o) => ctx.db.updateMany(e, o),
      update: async (e, id, d) => {
        if (e === "install_metadata" && "last_event_at" in d) {
          skipNextStateChange = true
          return
        }
        skipNextStateChange = false
        await ctx.db.update(e, id, d)
      },
    },
  }
  let n = 0
  for (const event of events) {
    if (budget.spent) break
    await handleStripeEvent(event, replayCtx)
    n++
  }
  return n
}
