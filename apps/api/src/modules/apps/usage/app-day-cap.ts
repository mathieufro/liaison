// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The per-org, per-UTC-day app caps (`appRunsPerDay`, `appBridgeCallsPerDay`,
// `appCpuMsPerDay`, modules/org/caps.ts), read from the Redis day counters
// (app-usage.ts counts runs and bridge calls as they settle; loader-usage.ts
// stores the CPU the Workers loader measured at its last pull, so the CPU cap
// takes effect from the first run after a pull shows it crossed).
//
// What each entry point does once a cap is reached (the cap is over when
// today's count is at or above it):
//  - tool run: refused with a CapLimitError (429, APP_*_LIMIT_REACHED, with
//    `{limit, used}`) the agent and the page read like any typed error;
//  - job (on demand): put back as delayed until the next UTC day
//    (AppDayCapHeldJobError, infra/jobs/jobs.ts), never dropped; a scheduled
//    tick is skipped (the next tick after midnight runs);
//  - webhook: the app's `verify` always runs; the handler is enqueued as the
//    kernel webhook retry job with the payload and headers, delayed to the
//    next UTC day, and the provider gets a 2xx;
//  - event subscription: the handler is enqueued as a delayed job holding the
//    event (deferred-event.ts) and the event is acknowledged;
//  - poll of an awaited output: answers "not ready", so the poll job asks again;
//  - search: refused with no hits and a typed reason;
//  - approval summarizers: exempt (they never go through runApp);
//  - a nested run (a tool called from another app's run): counted, never
//    refused, so a run already admitted completes;
//  - a core app's server code: exempt.
// Without any app cap the org costs one cached read (60 s), no Redis call.
// Redis unreachable: open (an unreadable counter never holds work back).

import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import {
  APP_DAY_CAP_KINDS,
  type AppDayCapKind,
  appDayKey,
  CapLimitError,
  capOf,
  msUntilNextUtcDay,
  normalizeCaps,
  utcDay,
} from "~/modules/org/caps"

const log = rootLogger.child({ module: "app-day-cap" })

export type AppDayCaps = Record<AppDayCapKind, number | null>

const CAP_CACHE_MS = 60_000
const capCache = new Map<string, { caps: AppDayCaps; at: number }>()

type CapsReader = (orgId: string) => Promise<AppDayCaps>

const dbCapsReader: CapsReader = async (orgId) => {
  const [row] = await withSystemDb("app-day-cap-read", (db) =>
    db
      .select({ caps: organizations.caps })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  const caps = normalizeCaps(row?.caps)
  return {
    appRunsPerDay: capOf(caps, "appRunsPerDay"),
    appBridgeCallsPerDay: capOf(caps, "appBridgeCallsPerDay"),
    appCpuMsPerDay: capOf(caps, "appCpuMsPerDay"),
  }
}
let capsReader: CapsReader = dbCapsReader

const NO_CAPS: AppDayCaps = {
  appRunsPerDay: null,
  appBridgeCallsPerDay: null,
  appCpuMsPerDay: null,
}

/** The org's app day caps, from a 60 s cache. Unreadable: no cap (open). */
export async function appDayCapsOf(orgId: string): Promise<AppDayCaps> {
  const hit = capCache.get(orgId)
  const now = Date.now()
  if (hit && now - hit.at < CAP_CACHE_MS) return hit.caps
  try {
    const caps = await capsReader(orgId)
    capCache.set(orgId, { caps, at: now })
    return caps
  } catch (err) {
    log.warn({ err, orgId }, "app day cap: could not read the caps; not limiting")
    return hit?.caps ?? NO_CAPS
  }
}

/** A cap reached today: which, its limit and today's count. */
export interface AppDayOver {
  kind: AppDayCapKind
  limit: number
  used: number
}

/** The first app day cap the org has reached today, or null. Never throws. */
export async function appDayCapReached(
  orgId: string,
  now = Date.now(),
): Promise<AppDayOver | null> {
  const caps = await appDayCapsOf(orgId)
  const kinds = APP_DAY_CAP_KINDS.filter((k) => caps[k] !== null)
  if (kinds.length === 0) return null
  const day = utcDay(now)
  let values: Array<string | null>
  try {
    values = await redis.mget(...kinds.map((k) => appDayKey(k, orgId, day)))
  } catch (err) {
    log.warn({ err, orgId }, "app day cap: Redis failed; not limiting")
    return null
  }
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i] as AppDayCapKind
    const limit = caps[kind] as number
    const used = Number(values[i] ?? 0) || 0
    if (used >= limit) return { kind, limit, used }
  }
  return null
}

/** Who is asking: a core app's server code and nested runs are never held. */
export interface AppRunGate {
  orgId: string
  core: boolean
  nested?: boolean
}

/** Refuse a top-level tool run of an org at an app day cap (CapLimitError, 429). */
export async function assertAppRunRoom(gate: AppRunGate): Promise<void> {
  if (gate.core || gate.nested) return
  const over = await appDayCapReached(gate.orgId)
  if (over) throw new CapLimitError(over.kind, over.limit, over.used)
}

/** Up to five minutes after midnight, so held work does not all start at 00:00:00. */
const HOLD_JITTER_MS = 5 * 60_000

/** How long background work of the org waits (ms), or null to run now. */
export async function appRunHoldMs(gate: AppRunGate, now = Date.now()): Promise<number | null> {
  if (gate.core || gate.nested) return null
  const over = await appDayCapReached(gate.orgId, now)
  if (!over) return null
  return msUntilNextUtcDay(now) + Math.floor(Math.random() * HOLD_JITTER_MS)
}

/**
 * Thrown by an app job's handler while its org is at an app day cap: the job
 * worker puts it back as delayed by `delayMs` with its data (jobs.ts), as it
 * does for a job held by an org move. Never a failure, never an attempt spent.
 */
export class AppDayCapHeldJobError extends Error {
  constructor(
    readonly orgId: string,
    readonly delayMs: number,
    readonly kind: AppDayCapKind,
  ) {
    super(`org ${orgId} reached its ${kind} cap; the job waits for the next UTC day`)
    this.name = "AppDayCapHeldJobError"
  }
}

/** Hold an app job of an org at an app day cap (throws AppDayCapHeldJobError). */
export async function holdAppJobIfCapped(gate: AppRunGate): Promise<void> {
  if (gate.core || gate.nested) return
  const now = Date.now()
  const over = await appDayCapReached(gate.orgId, now)
  if (!over) return
  throw new AppDayCapHeldJobError(
    gate.orgId,
    msUntilNextUtcDay(now) + Math.floor(Math.random() * HOLD_JITTER_MS),
    over.kind,
  )
}

/**
 * Say, once per hold, that a scheduled job of an app is held by the org's day cap: the job's
 * manifest `heldEvent` (one of the app's own declared events) is queued with `{job, until,
 * resolved: false}`, so the app's attention translation tells the people who act on it, instead
 * of the tick being skipped silently. The app emits the same event with `resolved: true` when
 * the job runs again. Never throws: a notice that cannot be queued is logged, the hold stays.
 */
export async function noticeHeldJob(args: {
  orgId: string
  app: string
  job: string
  heldEvent: string
  holdMs: number
  now?: number
}): Promise<boolean> {
  const colon = args.heldEvent.indexOf(":")
  if (colon <= 0) return false
  const now = args.now ?? Date.now()
  const until = new Date(now + args.holdMs).toISOString()
  try {
    // One notice per job and hold: every tick held after it adds nothing.
    const first = await redis.set(
      `app-day-cap:held:${args.orgId}:${args.app}:${args.job}:${utcDay(now)}`,
      "1",
      "PX",
      Math.max(args.holdMs, 60_000),
      "NX",
    )
    if (first !== "OK") return false
    const { withRlsContext } = await import("~/db/rls")
    await withRlsContext(
      { actorType: "system", orgId: args.orgId, purpose: "job", scopes: [`${args.app}:*`] },
      (tx) =>
        tx.queueEvent({
          app: args.app,
          entity: args.heldEvent.slice(0, colon),
          action: args.heldEvent.slice(colon + 1),
          entityId: args.job,
          data: { job: args.job, until, resolved: false },
          actorId: null,
          actorType: "system",
          orgId: args.orgId,
          timestamp: new Date(now).toISOString(),
        }),
    )
    return true
  } catch (err) {
    log.warn(
      { err, orgId: args.orgId, app: args.app, job: args.job },
      "app day cap: held-job notice not queued",
    )
    return false
  }
}

/** Test seams of the app day caps. */
export const AppDayCapTestAccess = {
  /** Read caps from here instead of the database (null restores). */
  setReader(reader: CapsReader | null): void {
    capsReader = reader ?? dbCapsReader
    capCache.clear()
  },
  clearCache(): void {
    capCache.clear()
  },
}
