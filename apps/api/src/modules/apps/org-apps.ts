// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Per-workspace app state (S18–S20, A4–A6, A24): THE reader.
 *
 * An app installed on the server is, per workspace (`kernel.apps` row of the
 * org), one of:
 *  - active (On), or `error` (registration failed; not Off, its tools are
 *    simply absent),
 *  - `disabled` (Off): everything stops (tools, jobs, events, webhooks, routes,
 *    attention), its data stays; re-enabling resumes it,
 *  - `removed`: taken out of this workspace (data kept, listed as Available);
 *    gated exactly like Off.
 * plus an access mode: `everyone`, or `restricted` to the roles and people
 * listed in `kernel.org_app_access` (org admins holding `*` are exempt).
 *
 * Enforcement is FAIL-CLOSED: every gate awaits `primeOrgApps` (or uses the
 * async `getOrgAppState` / `assertAppActive`), which loads the org's state when
 * this process has none or it is older than the TTL, and THROWS when it cannot
 * load it and has no previous answer, so an unknown state refuses instead of
 * reading as On. A stale entry whose reload fails keeps its last persisted
 * answer (bounded staleness, logged).
 *
 * The features switched on inside each app (`kernel.org_app_features`) load with
 * the same entry, so `isFeatureOffForTool` answers as synchronously and a change
 * travels the same invalidation (org-features.ts writes them).
 *
 * The synchronous `isAppOffForOrg` serves the tool-bridge, slot and context
 * walks, which run after their async entry point primed the org. It reads only
 * the cache; the dispatch behind those surfaces (`executeToolCore`, jobs,
 * events, routes) re-checks through the async reader, so a walk reached
 * without a prime can at worst list a tool that then refuses to run.
 *
 * Writes go through `org-app-service.ts`, which updates the row, calls
 * `noteOrgAppsChanged` (this process at once, peers over Redis) and broadcasts
 * the `kernel:org_app:update` WebSocket event.
 */
import { APP_DISABLED_CODE, APP_DISABLED_MESSAGE } from "@liaison/shared"
import { and, eq, inArray } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import {
  apps,
  orgAppAccess,
  orgAppFeatures,
  organizations,
  roleScopeGrants,
  userRoles,
  userScopeGrants,
} from "~/db/schema/kernel"
import { appsLogger, rootLogger } from "~/lib/logger"
import { publishRedis, REDIS_PREFIX, redisSub } from "~/lib/redis"
import { UUID_RE } from "~/lib/uuid"
import { appVisibleToOrg } from "~/modules/apps/app-org-scope"

const log = rootLogger.child({ module: "apps/org-apps" })

export type OrgAppStatus = "active" | "disabled" | "error" | "removed"
export type OrgAppAccessMode = "everyone" | "restricted"

export interface OrgAppState {
  app: string
  status: OrgAppStatus
  accessMode: OrgAppAccessMode
  /** Role ids that keep a restricted app. */
  roleIds: readonly string[]
  /** User ids that keep a restricted app. */
  userIds: readonly string[]
  /**
   * Restricted apps only: every member who keeps it (listed, holder of a listed
   * role, or holder of `*`), resolved at load. Surfaces read it; the security
   * path (effective scopes, SQL) resolves membership itself.
   */
  allowedUserIds: ReadonlySet<string>
}

/** The state could not be read: the gate refuses (fail-closed), retryable. */
export const APP_STATE_UNAVAILABLE_CODE = "app_state_unavailable"

/** Thrown by `assertAppActive` for an Off or removed app. */
export class AppDisabledError extends Error {
  readonly code = APP_DISABLED_CODE
  constructor(
    readonly orgId: string,
    readonly app: string,
  ) {
    super(APP_DISABLED_MESSAGE)
    this.name = "AppDisabledError"
  }
}

/** Thrown when the org's app state cannot be loaded and no previous answer exists. */
export class AppStateUnavailableError extends Error {
  readonly code = APP_STATE_UNAVAILABLE_CODE
  constructor(
    readonly orgId: string,
    cause: unknown,
  ) {
    super("The workspace's app state could not be read; try again.", { cause })
    this.name = "AppStateUnavailableError"
  }
}

/** A tool of a feature that is off for the workspace was asked for: not retryable. */
export const FEATURE_OFF_CODE = "feature_off"

/** Backstop for a missed invalidation: an entry older than this is reloaded on prime. */
export const ORG_APPS_TTL_MS = 15_000
const ORG_APPS_INVALIDATE_CHANNEL = `${REDIS_PREFIX}org-apps:invalidate`

/** An org id shape: anything else names no organization row. */
export { UUID_RE }

interface Entry {
  apps: ReadonlyMap<string, OrgAppState>
  /** App name to the features switched on for the org. A feature absent here is off. */
  enabledFeatures: ReadonlyMap<string, ReadonlySet<string>>
  /**
   * The feature rows could not be read: every feature reads off for listing and
   * new calls, but an approved call answers a retryable unavailable instead of a
   * final off, and the entry is stamped stale so the next prime reads again.
   */
  featuresUnreadable?: boolean
  /** The id is a UUID that no organization row carries: the org was deleted. */
  orgMissing: boolean
  /** The org row has `deleting_at` set: its deletion has started (modules/org/purge/). */
  orgDeleting?: boolean
  loadedAt: number
}

const cache = new Map<string, Entry>()
const inFlight = new Map<string, Promise<void>>()
/**
 * Per-org newest load: only the load holding it writes the cache. The values
 * come from one process-wide sequence, never reused, so a dropped counter
 * (forgetOrgApps) cannot hand a later load the number an older, untracked load
 * still holds.
 */
const generation = new Map<string, number>()
let generationSeq = 0

/** Off for gating: disabled or removed. `error` is not Off (the app is simply toolless). */
export function isOffStatus(status: OrgAppStatus | undefined): boolean {
  return status === "disabled" || status === "removed"
}

async function readOrgApps(
  orgId: string,
): Promise<{ apps: Map<string, OrgAppState>; orgMissing: boolean; orgDeleting: boolean }> {
  // An id that is not a UUID can own no kernel.apps row (org_id is a uuid):
  // nothing is Off there, and the query would only fail on the cast.
  if (!UUID_RE.test(orgId)) return { apps: new Map(), orgMissing: false, orgDeleting: false }
  return withPrivilegedDb(orgId, "org-apps-read", async (db) => {
    const rows = await db
      .select({ name: apps.name, status: apps.status, accessMode: apps.accessMode })
      .from(apps)
      .where(eq(apps.orgId, orgId))
    // The org row: missing (deleted), or being deleted (`deleting_at`, whose
    // requests answer 410 and whose jobs are dropped).
    const [orgRow] = await db
      .select({ id: organizations.id, deletingAt: organizations.deletingAt })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
    const orgMissing = !orgRow
    const orgDeleting = orgRow?.deletingAt != null
    const access = await db
      .select({
        app: orgAppAccess.app,
        principalType: orgAppAccess.principalType,
        principalId: orgAppAccess.principalId,
      })
      .from(orgAppAccess)
      .where(eq(orgAppAccess.orgId, orgId))
    const restricted = rows.filter((r) => r.accessMode === "restricted").map((r) => r.name)
    const allowed = new Map<string, Set<string>>()
    if (restricted.length > 0) {
      // Members who keep each restricted app: listed directly, through a
      // listed role, or exempt as `*` holders (A3/D20).
      const listedRoles = [
        ...new Set(access.filter((x) => x.principalType === "role").map((x) => x.principalId)),
      ]
      const roleMembers =
        listedRoles.length === 0
          ? []
          : await db
              .select({ userId: userRoles.userId, roleId: userRoles.roleId })
              .from(userRoles)
              .where(and(eq(userRoles.orgId, orgId), inArray(userRoles.roleId, listedRoles)))
      const directStars = await db
        .select({ userId: userScopeGrants.userId })
        .from(userScopeGrants)
        .where(and(eq(userScopeGrants.orgId, orgId), eq(userScopeGrants.scope, "*")))
      const roleStars = await db
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .innerJoin(roleScopeGrants, eq(roleScopeGrants.roleId, userRoles.roleId))
        .where(and(eq(userRoles.orgId, orgId), eq(roleScopeGrants.scope, "*")))
      const stars = [...directStars, ...roleStars].map((r) => r.userId)
      for (const app of restricted) allowed.set(app, new Set(stars))
      for (const x of access) {
        const set = allowed.get(x.app)
        if (!set) continue
        if (x.principalType === "user") set.add(x.principalId)
        else for (const m of roleMembers) if (m.roleId === x.principalId) set.add(m.userId)
      }
    }
    const out = new Map<string, OrgAppState>()
    for (const r of rows) {
      const roleIds: string[] = []
      const userIds: string[] = []
      for (const a of access) {
        if (a.app !== r.name) continue
        if (a.principalType === "role") roleIds.push(a.principalId)
        else userIds.push(a.principalId)
      }
      out.set(r.name, {
        app: r.name,
        status: r.status,
        accessMode: r.accessMode,
        roleIds,
        userIds,
        allowedUserIds: allowed.get(r.name) ?? new Set<string>(),
      })
    }
    return { apps: out, orgMissing, orgDeleting }
  })
}

/**
 * The org's switched-on features, in their own read: a failure here answers that
 * every feature is off (logged) and says the read failed (`ok: false`), while the
 * app state above keeps its own rules.
 */
async function readOrgFeatures(
  orgId: string,
): Promise<{ ok: boolean; features: Map<string, Set<string>> }> {
  const out = new Map<string, Set<string>>()
  if (!UUID_RE.test(orgId)) return { ok: true, features: out }
  try {
    const rows = await withPrivilegedDb(orgId, "org-features-read", (db) =>
      db
        .select({ app: orgAppFeatures.appName, feature: orgAppFeatures.feature })
        .from(orgAppFeatures)
        .where(and(eq(orgAppFeatures.orgId, orgId), eq(orgAppFeatures.enabled, true))),
    )
    for (const row of rows) {
      const features = out.get(row.app) ?? new Set<string>()
      features.add(row.feature)
      out.set(row.app, features)
    }
  } catch (err) {
    appsLogger.error({ err, orgId }, "org feature rows unreadable; every feature reads off")
    return { ok: false, features: new Map() }
  }
  return { ok: true, features: out }
}

/** Reload the org's entry now (an invalidation, a write, a stale entry). Throws on a load failure. */
export async function reloadOrgApps(orgId: string, opts: { fresh?: boolean } = {}): Promise<void> {
  // A load already running is shared, unless the caller just WROTE the state
  // (`fresh`): that load may have read before the write committed, so a new
  // read starts and the older one, finishing later, does not overwrite it.
  const pending = inFlight.get(orgId)
  if (pending && !opts.fresh) return pending
  const gen = ++generationSeq
  generation.set(orgId, gen)
  const load: Promise<void> = readOrgApps(orgId)
    .then(async (read) => {
      const features = await readOrgFeatures(orgId)
      return { ...read, enabledFeatures: features.features, featuresUnreadable: !features.ok }
    })
    .then(async (read) => {
      if (generation.get(orgId) === gen) {
        const prev = cache.get(orgId)
        // A failed feature read is not an answer to keep: stamped stale, the next
        // prime reads the table again instead of serving "all off" for the TTL.
        cache.set(orgId, { ...read, loadedAt: read.featuresUnreadable ? 0 : Date.now() })
        const ended = read.orgDeleting || read.orgMissing
        if (ended && !(prev?.orgDeleting || prev?.orgMissing)) notifyOrgEnded(orgId)
        return
      }
      // A newer load overtook this one and its answer is the one cached: the
      // caller (a writer reading its own write) resumes once that answer lands.
      const newer = inFlight.get(orgId)
      if (newer && newer !== load) await newer
    })
    .finally(() => {
      if (inFlight.get(orgId) === load) inFlight.delete(orgId)
    })
  inFlight.set(orgId, load)
  return load
}

/**
 * Make sure the org's state is loaded and no older than `maxAgeMs`. Every gate
 * awaits this. Throws `AppStateUnavailableError` when nothing is cached and the
 * load fails (fail-closed); a stale entry whose reload fails keeps its answer.
 */
export async function primeOrgApps(
  orgId: string,
  maxAgeMs: number = ORG_APPS_TTL_MS,
): Promise<void> {
  const entry = cache.get(orgId)
  if (entry && Date.now() - entry.loadedAt < maxAgeMs) return
  try {
    await reloadOrgApps(orgId)
  } catch (err) {
    if (!cache.has(orgId)) throw new AppStateUnavailableError(orgId, err)
    log.warn({ err, orgId }, "org app state reload failed; keeping the last persisted answer")
  }
}

/** The org's state for one app (null: no row, the app was never registered in this org). */
export async function getOrgAppState(orgId: string, app: string): Promise<OrgAppState | null> {
  await primeOrgApps(orgId)
  return cache.get(orgId)?.apps.get(app) ?? null
}

/** Every app row of the org (admin listing). */
export async function listOrgAppStates(orgId: string): Promise<OrgAppState[]> {
  await primeOrgApps(orgId)
  return [...(cache.get(orgId)?.apps.values() ?? [])]
}

/**
 * Is the app On for the org? Async, load-on-miss, fail-closed (throws when the
 * state cannot be read). `kernel` is always On. An app with no row in a loaded
 * org has never been turned Off (registration writes the row), so it is On.
 */
export async function isAppActiveForOrgAsync(orgId: string, app: string): Promise<boolean> {
  if (app === "kernel") return true
  // Another org's custom app is never On here (app-org-scope.ts): this is the
  // gate the tool, job, webhook, event, PDF and connection paths all read.
  if (!(await appVisibleToOrg(app, orgId))) return false
  await primeOrgApps(orgId)
  return !isOffStatus(cache.get(orgId)?.apps.get(app)?.status)
}

/**
 * Was the org deleted? True when the id is a UUID that no organization row
 * carries. Async, load-on-miss, fail-closed like the gates (throws when the
 * state cannot be read). The job dispatch drops a deleted org's jobs with it.
 */
export async function isOrgMissingAsync(orgId: string): Promise<boolean> {
  await primeOrgApps(orgId)
  return cache.get(orgId)?.orgMissing === true
}

/**
 * Has the org's deletion started (`organizations.deleting_at` set)? Async,
 * load-on-miss, fail-closed like the gates. The request guard answers 410 and
 * the job dispatch drops the org's jobs. A peer learns it through the org-apps
 * invalidation the deletion publishes, or at the latest after the TTL
 * (`ORG_APPS_TTL_MS`), which is why the purge waits that long before its
 * destructive steps.
 */
export async function isOrgDeletingAsync(orgId: string): Promise<boolean> {
  await primeOrgApps(orgId)
  return cache.get(orgId)?.orgDeleting === true
}

/**
 * Is the org gone for live traffic: its deletion has started, or its row is
 * gone (the purge finished)? Same loading and failure direction as
 * `isOrgDeletingAsync`.
 */
export async function isOrgEndedAsync(orgId: string): Promise<boolean> {
  await primeOrgApps(orgId)
  const entry = cache.get(orgId)
  return entry?.orgDeleting === true || entry?.orgMissing === true
}

const orgEndedListeners = new Set<(orgId: string) => void>()

/**
 * Be told, in this process, when an org's state first loads as deleting or
 * missing: the deletion's own reload, a peer's invalidation, or a TTL reload.
 * The realtime server closes the org's open sockets on it. Listeners run
 * synchronously and must not throw (a throw is logged). Returns the unsubscribe.
 */
export function onOrgEnded(fn: (orgId: string) => void): () => void {
  orgEndedListeners.add(fn)
  return () => {
    orgEndedListeners.delete(fn)
  }
}

function notifyOrgEnded(orgId: string): void {
  for (const fn of orgEndedListeners) {
    try {
      fn(orgId)
    } catch (err) {
      log.warn({ err, orgId }, "org ended listener failed")
    }
  }
}

/**
 * For an unauthenticated route keyed by an org id in its path (webhooks, the
 * tickets public routes, the queued-webhook worker): the app's state for that
 * org. `deleting`: the org's deletion has started, nothing more is served for
 * it (S2.5); `off`: the app is Off or removed. A path whose org id is not a
 * UUID answers `on` (the route's own 404 handles it). Fail-closed: throws
 * `AppStateUnavailableError` when the state cannot be read.
 */
export async function pathOrgAppState(
  orgId: string,
  app: string,
): Promise<"on" | "off" | "deleting"> {
  if (!UUID_RE.test(orgId)) return "on"
  if (await isOrgDeletingAsync(orgId)) return "deleting"
  return (await isAppActiveForOrgAsync(orgId, app)) ? "on" : "off"
}

/** `pathOrgAppState` as a boolean: is the app Off (or the org being deleted)? */
export async function isAppOffForPathOrg(orgId: string, app: string): Promise<boolean> {
  return (await pathOrgAppState(orgId, app)) !== "on"
}

/** Throws `AppDisabledError` when the app is Off or removed (or `AppStateUnavailableError`). */
export async function assertAppActive(orgId: string, app: string): Promise<void> {
  if (!(await isAppActiveForOrgAsync(orgId, app))) throw new AppDisabledError(orgId, app)
}

/**
 * Synchronous: is the app Off (or removed) for the org, per this process's
 * cache? For the walks that run after their entry point awaited `primeOrgApps`
 * (see the header). `kernel` is never Off.
 */
export function isAppOffForOrg(orgId: string, app: string): boolean {
  if (app === "kernel") return false
  return isOffStatus(cache.get(orgId)?.apps.get(app)?.status)
}

/**
 * Synchronous: does the feature this tool declares stand off for the org? The one
 * answer for every surface that lists or runs a tool. Its miss goes the other way
 * from `isAppOffForOrg`: an org this process has not primed reads a featured tool
 * as off and a plain tool as on, so a walk reached without a prime hides a feature
 * rather than showing one.
 */
export function isFeatureOffForTool(
  orgId: string,
  tool: { appName: string; feature?: string },
): boolean {
  if (!tool.feature) return false
  return !cache.get(orgId)?.enabledFeatures.get(tool.appName)?.has(tool.feature)
}

/**
 * Sync, after a prime: did the last read of the org's feature rows fail? Then an
 * off answer from `isFeatureOffForTool` is "unknown", not a row that says off.
 */
export function orgFeaturesUnreadable(orgId: string): boolean {
  return cache.get(orgId)?.featuresUnreadable === true
}

/** Sync, after a prime: every feature switched on for the org. */
export function enabledFeaturesFor(orgId: string): Array<{ app: string; feature: string }> {
  const out: Array<{ app: string; feature: string }> = []
  for (const [app, features] of cache.get(orgId)?.enabledFeatures ?? []) {
    for (const feature of features) out.push({ app, feature })
  }
  return out.sort((a, b) => `${a.app}:${a.feature}`.localeCompare(`${b.app}:${b.feature}`))
}

/** Synchronous state read from the cache (after a prime). */
export function peekOrgAppState(orgId: string, app: string): OrgAppState | null {
  return cache.get(orgId)?.apps.get(app) ?? null
}

/**
 * Is a restricted app out of reach for this person (S20)? Holders of `*` are
 * exempt; a listed user or a holder of a listed role keeps it. Sync, from the
 * cache (after a prime). An app in `everyone` mode is never restricted away.
 */
export function isAppRestrictedAway(
  state: OrgAppState | null,
  userId: string | null | undefined,
): boolean {
  if (state?.accessMode !== "restricted") return false
  return !userId || !state.allowedUserIds.has(userId)
}

/**
 * Apps the person cannot use in this workspace: Off/removed for the org, or
 * restricted away from them. Sync, after a prime. Drives the manifest feed's
 * `unavailableApps` (the shell drops their in-tree navigation) and the locked
 * capability listing.
 */
export function unavailableAppsFor(orgId: string, userId: string | null | undefined): string[] {
  const entry = cache.get(orgId)
  if (!entry) return []
  const out: string[] = []
  for (const state of entry.apps.values()) {
    if (isOffStatus(state.status) || isAppRestrictedAway(state, userId)) out.push(state.app)
  }
  return out.sort()
}

/** Sync: is the app unavailable to this person (Off, removed, or restricted away)? After a prime. */
export function isAppUnavailableFor(
  orgId: string,
  app: string,
  userId: string | null | undefined,
): boolean {
  if (app === "kernel") return false
  const state = cache.get(orgId)?.apps.get(app) ?? null
  return isOffStatus(state?.status) || isAppRestrictedAway(state, userId)
}

/**
 * A write changed the org's app state: reload this process's entry now and tell
 * peer processes (node-a / node-b) to reload theirs.
 */
export async function noteOrgAppsChanged(orgId: string): Promise<void> {
  await reloadOrgApps(orgId, { fresh: true })
  void publishRedis(ORG_APPS_INVALIDATE_CHANNEL, JSON.stringify({ orgId })).catch((err) => {
    log.warn({ err, orgId }, "org-apps invalidation publish failed; peers converge on TTL")
  })
}

/**
 * A registration committed the app's row for the org (a new install, or the
 * app's first registration there). An entry loaded before it lacks the app, so
 * the admin's list and the add / enable / access routes would not find it
 * until the TTL: drop that entry (the next read loads it, the app included)
 * and tell peers. No read here: registration can run while its caller holds a
 * privileged connection, and a cold entry or one that already has the app
 * needs nothing, so a boot's registrations cost nothing.
 */
export function noteAppRegistered(orgId: string, app: string): void {
  const entry = cache.get(orgId)
  if (!entry || entry.apps.has(app)) return
  // An older load still in flight must neither write its answer back nor be
  // shared with the next read: that read starts its own.
  generation.set(orgId, ++generationSeq)
  inFlight.delete(orgId)
  cache.delete(orgId)
  void publishRedis(ORG_APPS_INVALIDATE_CHANNEL, JSON.stringify({ orgId })).catch((err) => {
    log.warn({ err, orgId }, "org-apps invalidation publish failed; peers converge on TTL")
  })
}

/**
 * A peer process wrote the org's app state: reload this process's entry when it
 * holds one. `fresh`: a load already in flight here may have read before the
 * peer's write committed, so it is not shared (its later answer is discarded).
 */
export async function reloadOrgAppsAfterPeerWrite(orgId: string): Promise<void> {
  if (!cache.has(orgId)) return
  await reloadOrgApps(orgId, { fresh: true })
}

/** Permission events that change who keeps a restricted app (role membership, `*` holders). */
const PRINCIPAL_ENTITIES: ReadonlySet<string> = new Set([
  "role_assignment",
  "user_scope",
  "role_scope",
  "role",
])

/**
 * A committed permission change (role assigned or unassigned, a scope grant
 * that may add or drop a `*` holder, a role deleted): a restricted app's
 * resolved members (`allowedUserIds`) may have changed, so the org's state is
 * reloaded. Skipped when this process holds a fresh entry with no restricted
 * app (nothing to recompute).
 *
 * The event reaches every process (per-replica delivery), so each reloads its
 * own entry; only the publishing process's copy also tells peers. A peer's
 * copy (`_remote`) publishing too would make N processes each reload every
 * other one, N^2 reloads per permission change.
 */
export async function noteOrgPrincipalsChanged(event: {
  app?: string
  entity: string
  orgId?: string | null
  _remote?: boolean
}): Promise<void> {
  if (event.app !== "kernel" || !event.orgId || !PRINCIPAL_ENTITIES.has(event.entity)) return
  const entry = cache.get(event.orgId)
  if (entry && Date.now() - entry.loadedAt < ORG_APPS_TTL_MS) {
    const anyRestricted = [...entry.apps.values()].some((a) => a.accessMode === "restricted")
    if (!anyRestricted) return
  }
  if (event._remote) await reloadOrgApps(event.orgId, { fresh: true })
  else await noteOrgAppsChanged(event.orgId)
}

/** Drop the org's entry (test harness resets, org deletion). The next gate reloads. */
export function forgetOrgApps(orgId?: string): void {
  if (orgId) cache.delete(orgId)
  else cache.clear()
  // A counter no load holds is dead weight (a released org would keep it
  // forever); one an in-flight load holds still decides whether it writes.
  for (const id of orgId ? [orgId] : [...generation.keys()]) {
    if (!inFlight.has(id)) generation.delete(id)
  }
}

/** Test seam: plant a state without the database (unit tests of the walks). */
export function rememberOrgAppStates(
  orgId: string,
  states: ReadonlyArray<Partial<OrgAppState> & Pick<OrgAppState, "app" | "status">>,
  org: { deleting?: boolean; features?: Readonly<Record<string, readonly string[]>> } = {},
): void {
  const full = states.map(
    (s): OrgAppState => ({
      accessMode: "everyone",
      roleIds: [],
      userIds: [],
      allowedUserIds: new Set<string>(),
      ...s,
    }),
  )
  cache.set(orgId, {
    apps: new Map(full.map((s) => [s.app, s])),
    enabledFeatures: new Map(
      Object.entries(org.features ?? {}).map(([app, features]) => [app, new Set(features)]),
    ),
    orgMissing: false,
    orgDeleting: org.deleting === true,
    loadedAt: Date.now(),
  })
}

let subscribed = false

/** Subscribe to peer invalidations. Idempotent; called once at startup. */
export async function initOrgAppsInvalidation(): Promise<void> {
  if (subscribed) return
  subscribed = true
  redisSub.on("message", (channel, message) => {
    if (channel !== ORG_APPS_INVALIDATE_CHANNEL) return
    try {
      const { orgId } = JSON.parse(message) as { orgId: string }
      void reloadOrgAppsAfterPeerWrite(orgId).catch((err) =>
        log.warn({ err, orgId }, "org-apps reload after invalidation failed; TTL converges"),
      )
    } catch (err) {
      log.warn({ err, channel }, "failed to parse org-apps invalidation message")
    }
  })
  await redisSub.subscribe(ORG_APPS_INVALIDATE_CHANNEL)
}
