// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reading and writing the per-org demo marker (`organizations.settings.demo`).
//
// The marker's shape and its pure helpers (`isDemoOrg`, `demoVariant`) live in
// @liaison/shared next to `orgKernelSettingsSchema`, because both the api and
// the web app need to agree on what a demo org is. This file is the database
// half: how the marker is written, how it is read on a request path, and the
// small cache that keeps the read off the hot path.
import {
  type DemoEntry,
  type DemoNeed,
  type DemoOrgMarker,
  type DemoWelcomeChoice,
  type DemoWorldId,
  demoEntrySchema,
  demoMarker,
  demoOrgMarkerSchema,
  demoWelcomeChoiceSchema,
  demoWorldIdOf,
  resolveLocale,
  type ShippedLocale,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { withPrivilegedDb, withPrivilegedReusing } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { boundedBy } from "~/lib/bounded"
import { loadOrgSettingsFragment, rememberLoadOrg } from "~/lib/load-harness"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"

const log = rootLogger.child({ module: "demo-org" })

/**
 * Per-process marker cache, kept coherent across processes.
 *
 * A deployment runs several processes (api replicas, a worker), and a marker
 * written on one (a pool claim, the welcome answer, an extended expiry) must
 * not be read stale on another: a replica still holding the pool org's marker
 * would treat a visitor's fresh workspace as an unclaimed one. Every write
 * bumps the org's marker version in Redis (`bumpMarkerVersion`), and a cached
 * entry is used only while the version it was read under is still current:
 * one Redis read instead of one database read per lookup. Redis unreadable =
 * the entry is not trusted and the row is read again.
 *
 * The TTL stays for an org marked out-of-band (an operator's SQL, the
 * provisioning script marking the reserved org), which bumps no version.
 */
const CACHE_TTL_MS = 30_000
const VERSION_TTL_SECONDS = 8 * 24 * 60 * 60
/** How long a marker-version read or bump may wait on Redis. */
const REDIS_WAIT_MS = 1_000
const cache = new Map<
  string,
  { entry: DemoOrgEntry; at: number; version: string | null; pinned?: boolean }
>()

function redisTimeout(): Error {
  return new Error("demo marker: Redis did not answer")
}

function versionKey(orgId: string): string {
  return `demo:marker-version:${orgId}`
}

/**
 * Bumped once a demo org's purge has ended. It names no org, so it outlives the
 * purge's sweep of every key naming the org: a process that read the marker
 * while the purge ran (its version counter already swept, its row not yet
 * deleted) finds this changed and reads again.
 */
const PURGE_EPOCH_KEY = "demo:marker-purge-epoch"

/** A marker version: the org's counter and the purge epoch, as one string. */
function versionOf(counter: unknown, epoch: unknown): string {
  return `${counter ?? 0}.${epoch ?? 0}`
}

/** The org's current marker version, or null when Redis cannot say. */
async function markerVersion(orgId: string): Promise<string | null> {
  try {
    const [counter, epoch] = await boundedBy(
      redis.mget(versionKey(orgId), PURGE_EPOCH_KEY),
      REDIS_WAIT_MS,
      redisTimeout,
    )
    return versionOf(counter, epoch)
  } catch {
    return null
  }
}

/** Tell every process a demo org's purge ended (no key naming the org is written). */
async function bumpPurgeEpoch(orgId: string): Promise<void> {
  try {
    await boundedBy(
      redis.multi().incr(PURGE_EPOCH_KEY).expire(PURGE_EPOCH_KEY, VERSION_TTL_SECONDS).exec(),
      REDIS_WAIT_MS,
      redisTimeout,
    )
  } catch (err) {
    log.warn({ err, orgId }, "demo marker: could not tell the other processes the org is gone")
  }
}

/** Tell every process the org's marker changed. Returns the new version (null: Redis down). */
async function bumpMarkerVersion(orgId: string): Promise<string | null> {
  try {
    const key = versionKey(orgId)
    const replies = await boundedBy(
      redis.multi().incr(key).expire(key, VERSION_TTL_SECONDS).get(PURGE_EPOCH_KEY).exec(),
      REDIS_WAIT_MS,
      redisTimeout,
    )
    const counter = replies?.[0]?.[1]
    return typeof counter === "number" ? versionOf(counter, replies?.[2]?.[1]) : null
  } catch (err) {
    log.warn({ err, orgId }, "demo marker: could not tell the other processes it changed")
    return null
  }
}

/** What the marker lookup returns: the marker plus the org's own language. */
export interface DemoOrgEntry {
  marker: DemoOrgMarker | null
  /** The org's `default_locale`, narrowed to a locale the dictionaries ship. */
  locale: ShippedLocale
}

/** Narrow an arbitrary stored locale ("fr-FR", "en-GB", null) to a shipped one. */
function shippedLocale(raw: unknown): ShippedLocale {
  return resolveLocale(null, typeof raw === "string" ? raw : null)
}

/**
 * Drop a cached marker, here and (with an org) on every other process.
 * Exported for the paths that write the marker row themselves, and the tests.
 */
export async function invalidateDemoMarker(orgId?: string): Promise<void> {
  if (orgId === undefined) {
    cache.clear()
    return
  }
  cache.delete(orgId)
  await bumpMarkerVersion(orgId)
}

/**
 * Drop a purged org's cached marker, here and on every other process, once its
 * purge has ended. `invalidateDemoMarker` before the purge is not enough: the
 * purge sweeps the org's version counter before it deletes the row, and a
 * process that reads the marker in between would cache it until its TTL.
 */
export async function forgetPurgedDemoMarker(orgId: string): Promise<void> {
  cache.delete(orgId)
  await bumpPurgeEpoch(orgId)
}

/**
 * The demo marker on `orgId` plus the org's language, or a null marker. One
 * query, because every caller that needs the marker also needs the language to
 * say why it refused. Cached; see the note above.
 *
 * `on` is the caller's transaction, when it has one: a privileged transaction
 * of this org is read on directly (no second privileged slot); anything else
 * reads in its own privileged transaction, as without it. A read on the
 * caller's transaction may see its uncommitted writes, so it is not cached.
 */
export async function loadDemoOrg(
  orgId: string,
  on?: RlsClient | PrivilegedDb,
): Promise<DemoOrgEntry> {
  const pinned = cache.get(orgId)
  if (pinned?.pinned) return pinned.entry
  const version = await markerVersion(orgId)
  const hit = cache.get(orgId)
  if (hit && version !== null && hit.version === version && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.entry
  }

  const k = drizzleSql.raw(schemaRef("kernel"))
  const rows = await withPrivilegedReusing(on, orgId, "load-demo-marker", async (tx) => {
    const result = await tx.execute(
      drizzleSql`SELECT settings AS v, default_locale AS loc
                 FROM ${k}.organizations WHERE id = ${orgId}::uuid`,
    )
    return Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  })
  const row = rows[0] as { v: unknown; loc: unknown } | undefined
  const raw = row?.v ?? {}
  // postgres.js normally hands back a parsed object but returns a string under
  // some role/connection contexts, exactly as getOrgKernelSettings documents.
  const settings = typeof raw === "string" ? JSON.parse(raw) : raw
  const entry: DemoOrgEntry = { marker: demoMarker({ settings }), locale: shippedLocale(row?.loc) }
  if (!on) cache.set(orgId, { entry, at: Date.now(), version })
  return entry
}

/** The demo marker on `orgId`, or null (`on`: as for loadDemoOrg). */
export async function loadDemoMarker(
  orgId: string,
  on?: RlsClient | PrivilegedDb,
): Promise<DemoOrgMarker | null> {
  return (await loadDemoOrg(orgId, on)).marker
}

/** Is `orgId` a demo org? The database-backed counterpart of `isDemoOrg`. */
export async function isDemoOrgId(orgId: string): Promise<boolean> {
  return (await loadDemoMarker(orgId)) !== null
}

/**
 * Is `orgId` a VISITOR demo org (not the reserved review org)? What the world
 * beats and the scenario routes require: a live event is a visitor's own.
 */
export async function isVisitorDemoOrgId(orgId: string): Promise<boolean> {
  return (await loadDemoMarker(orgId))?.variant === "visitor"
}

/**
 * Write the demo marker onto an org. Merges into `settings` exactly the way the
 * BYOK key writer does (jsonb concat, not a whole-blob overwrite), so it cannot
 * clobber a setting written concurrently by another path.
 */
export async function markOrgAsDemo(
  orgId: string,
  marker: DemoOrgMarker,
  opts: { loadHarness?: boolean } = {},
): Promise<void> {
  const parsed = demoOrgMarkerSchema.parse(marker)
  const k = drizzleSql.raw(schemaRef("kernel"))
  // A load-harness start's org is flagged in the same statement as its marker
  // (lib/load-harness.ts), so no process ever reads it as a real org.
  const extra = opts.loadHarness ? loadOrgSettingsFragment() : {}
  await withPrivilegedDb(orgId, "mark-org-as-demo", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${k}.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) ||
        jsonb_build_object('demo', ${JSON.stringify(parsed)}::jsonb) ||
        ${JSON.stringify(extra)}::jsonb,
        updated_at = now()
      WHERE id = ${orgId}::uuid
    `)
  })
  if (opts.loadHarness) rememberLoadOrg(orgId)
  // Write through, so the restrictions bind from this instant rather than from
  // the next cache expiry. The locale is re-read on the next miss; it is only
  // used to choose the language of a refusal message.
  const version = await bumpMarkerVersion(orgId)
  const locale = cache.get(orgId)?.entry.locale ?? "en"
  cache.set(orgId, { entry: { marker: parsed, locale }, at: Date.now(), version })
}

/**
 * The visitor's recorded answer to the welcome popup (`marker.welcome.choice`),
 * or null before any. Like `needs`, a UI hint riding on the marker: one
 * visitor owns a visitor org, so the org's answer is theirs.
 */
export function demoWelcomeChoiceOf(marker: DemoOrgMarker | null): DemoWelcomeChoice | null {
  const welcome = marker?.welcome
  if (!welcome || typeof welcome !== "object") return null
  const parsed = demoWelcomeChoiceSchema.safeParse((welcome as { choice?: unknown }).choice)
  return parsed.success ? parsed.data : null
}

/**
 * Record the visitor's answer to the welcome popup on the marker. Sets only
 * `settings.demo.welcome`, like every UI hint written here.
 */
export async function recordDemoWelcomeChoice(
  orgId: string,
  choice: DemoWelcomeChoice,
  now: Date = new Date(),
): Promise<void> {
  await setDemoMarkerHint(orgId, "welcome", { choice, at: now.toISOString() })
}

/**
 * Has the "next steps" dialog already opened by itself in this workspace
 * (`marker.nextSteps.shownAt`)? It opens by itself once, on the first refusal
 * that says the budget is spent; a reload must not open it again.
 */
export function demoNextStepsShownOf(marker: DemoOrgMarker | null): boolean {
  const nextSteps = marker?.nextSteps
  return (
    !!nextSteps &&
    typeof nextSteps === "object" &&
    typeof (nextSteps as { shownAt?: unknown }).shownAt === "string"
  )
}

/** Record that the "next steps" dialog opened by itself (see {@link demoNextStepsShownOf}). */
export async function recordDemoNextStepsShown(
  orgId: string,
  now: Date = new Date(),
): Promise<void> {
  await setDemoMarkerHint(orgId, "nextSteps", { shownAt: now.toISOString() })
}

/**
 * The answer to the door's company question (`marker.entry`), or null when the
 * visitor skipped it. Lives and dies with the workspace, like the rest of the
 * marker. Its text is untrusted: render it as text only.
 */
export function demoEntryOf(marker: DemoOrgMarker | null): DemoEntry | null {
  const parsed = demoEntrySchema.safeParse(marker?.entry)
  return parsed.success ? parsed.data : null
}

/**
 * The demo world a marker's workspace holds (`marker.worldId`). A marker that
 * names none, or names something that is not a world, reads as the default
 * world: never as "not a demo", which only the marker's absence means. The
 * visitor administers the org, so a caller that acts on the world still checks
 * it against the worlds the box runs.
 */
export function demoWorldOf(marker: DemoOrgMarker | null): DemoWorldId {
  return demoWorldIdOf(marker?.worldId)
}

/** Record the answer to the door's company question on the marker. */
export async function recordDemoEntry(orgId: string, entry: DemoEntry): Promise<void> {
  await setDemoMarkerHint(orgId, "entry", entry)
}

/**
 * Set one UI hint on the marker. Sets only `settings.demo.<key>` (jsonb_set),
 * so the expiry and the rest of the marker are left exactly as they are, and
 * only on an org that has a marker.
 */
async function setDemoMarkerHint(
  orgId: string,
  key: "welcome" | "nextSteps" | "entry",
  value: Record<string, unknown>,
): Promise<void> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  const path = `{demo,${key}}`
  await withPrivilegedDb(orgId, `record-demo-${key}`, async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE ${k}.organizations
      SET settings = jsonb_set(settings, ${path}::text[], ${JSON.stringify(value)}::jsonb, true),
        updated_at = now()
      WHERE id = ${orgId}::uuid AND jsonb_typeof(settings->'demo') = 'object'
    `)
  })
  // Write through, like markOrgAsDemo: the next read on this process sees it,
  // and the other processes re-read the row.
  const cached = cache.get(orgId)
  const version = await bumpMarkerVersion(orgId)
  if (cached?.entry.marker) {
    cache.set(orgId, {
      entry: { ...cached.entry, marker: { ...cached.entry.marker, [key]: value } },
      at: Date.now(),
      version,
    })
  } else {
    cache.delete(orgId)
  }
}

/**
 * End a VISITOR org now: its marker's `expiresAt` becomes `now`, so every
 * request into it is refused as an ended workspace (demo-expiry.ts) and the
 * hourly reaper collects it like any other. Sets only `settings.demo.expiresAt`
 * and only on a visitor org; anything else is left alone. True when it ended one.
 */
export async function endVisitorOrg(orgId: string, now: Date = new Date()): Promise<boolean> {
  const k = drizzleSql.raw(schemaRef("kernel"))
  const ended = await withPrivilegedDb(orgId, "end-visitor-demo-org", async (tx) => {
    const result = await tx.execute(drizzleSql`
      UPDATE ${k}.organizations
      SET settings = jsonb_set(settings, '{demo,expiresAt}', to_jsonb(${now.toISOString()}::text)),
        updated_at = now()
      WHERE id = ${orgId}::uuid AND settings->'demo'->>'variant' = 'visitor'
      RETURNING id
    `)
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    return rows.length > 0
  })
  // Every process re-reads the row: the end binds from this instant.
  await invalidateDemoMarker(orgId)
  return ended
}

/**
 * Build a visitor marker expiring `ttlHours` from now. `needs` (pick order)
 * rides along as a passthrough field the web reads to order the scenarios: a
 * UI hint only, since the visitor administers the org and could rewrite it.
 * The lead row is the record of what was picked. `world` names the demo world
 * the workspace holds and, for a world that follows the month, the Paris month
 * it was seeded for (`worldMonth`, `YYYY-MM`); neither is declared in the
 * marker schema, and `demoWorldOf` reads the world back.
 */
export function visitorMarker(
  ttlHours: number,
  now: Date = new Date(),
  needs?: readonly DemoNeed[],
  world?: { worldId: DemoWorldId; worldMonth?: string | null },
): DemoOrgMarker {
  return {
    variant: "visitor",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlHours * 60 * 60 * 1000).toISOString(),
    ...(needs ? { needs: [...needs] } : {}),
    ...(world ? { worldId: world.worldId } : {}),
    ...(world?.worldMonth ? { worldMonth: world.worldMonth } : {}),
  }
}

/** A warm-pool org's `pool` field (demo-pool.ts): still seeding, or ready to claim. */
export type DemoPoolState = "seeding" | "ready"

/**
 * The pool state a marker carries, or null for an org that is not in the warm
 * pool. A pooled org has no visitor yet: nothing that acts on visitors (the
 * reaper, the signup cap) touches it.
 */
export function demoPoolStateOf(marker: unknown): DemoPoolState | null {
  if (!marker || typeof marker !== "object") return null
  const pool = (marker as { pool?: unknown }).pool
  return pool === "seeding" || pool === "ready" ? pool : null
}

/**
 * Build the RESERVED org's marker. Never expires: there is exactly one such org
 * on the box, it is handed to Apple's Beta App Review rather than offered to
 * the public, and a reaper must never take it.
 */
export function reservedMarker(now: Date = new Date()): DemoOrgMarker {
  return { variant: "reserved", createdAt: now.toISOString(), expiresAt: null }
}

/**
 * Test seam: seed the marker cache for an org, so a unit test can stand an org
 * up as a demo org without an organizations row or a module mock.
 */
export const DemoOrgTestAccess = {
  /** What another process's marker write announces, without touching this cache. */
  async bumpVersionAsAnotherProcess(orgId: string): Promise<void> {
    await bumpMarkerVersion(orgId)
  },
  /** What another process's end of a purge announces, without touching this cache. */
  async endPurgeAsAnotherProcess(orgId: string): Promise<void> {
    await bumpPurgeEpoch(orgId)
  },
  prime(orgId: string, marker: DemoOrgMarker | null): void {
    cache.set(orgId, {
      entry: { marker, locale: "en" },
      at: Date.now(),
      version: null,
      pinned: true,
    })
  },
}
