// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN APP'S ATTENTION ITEMS ARE STORED STATE.
//
// An app that declares an attention provider (`views.attentionItems` in its
// manifest) lists what needs a person's attention: their overdue tasks, the
// tickets at risk of breaching their SLA, the findings to triage. The provider
// is app code (a sandbox run for a sandboxed app), so the attention feed does
// not call it: the feed reads `kernel.app_attention_items` and runs no app
// code (attention-aggregator.ts).
//
// The platform runs the provider when what it lists can have changed, as each
// person who may see the app's items AND is around (`attentionAudience`: online
// now, or read their feed within SEEN_WINDOW_MS), and stores each person's whole
// list (replacing the last one, so an item the provider no longer lists is
// cleared). A person who is away is not recomputed on every wake: when they come
// back, their first feed read finds them not seen and queues a refresh of the
// org's apps, which now includes them. So a refresh costs one run per person
// around, not one per member of the org.
//   - after a run of the app that may have written (`onRunSettled`): an event
//     handler, a job, a webhook, a poll, a tool not declared read-only. A run
//     that only reads (a read-only tool, a search, an export, a preview, a
//     summarizer, a preflight, an attention run itself) wakes nothing;
//   - after an event of the app was delivered (`onEvent`, once, in the outbox
//     leader), which covers the app's data written by server code with no run;
//   - on the attention minute tick (state-materializer.ts), which bounds what
//     time alone changes (an SLA closing in, a task falling overdue): the next
//     minute for an org that changed, within HEARTBEAT_MINUTES otherwise;
//   - when the feed finds no stored list for the reader (a new person, a new
//     app), or one computed more than STORED_LIST_MAX_AGE_MS ago (a person away
//     since, whose list was left out of the refreshes): that read shows nothing
//     for the app until then, never a list that may no longer be true (a dated
//     line past its day, a task done since). The refresh tells their devices to
//     reload the feed, even when the list came out the same.
//
// A wake never runs a provider where it happens (a request, a tool call): it
// queues a refresh job on the attention queue (`app-attention-refresh`, its
// own worker with ATTENTION_REFRESH_CONCURRENCY slots, never the shared cron
// class). Wakes of one (org, app) share one job per REFRESH_MIN_INTERVAL_MS:
// the job is due at the end of the interval the wake fell in, so it reads
// every write of that interval, and an (org, app) refreshes at most once per
// interval however busy it is. An org runs at most ORG_REFRESHES_PER_MINUTE
// refreshes and ORG_PROVIDER_RUNS_PER_MINUTE provider runs (one per person of
// a refresh) a minute, all its apps together; the rest move to the next minute.
//
// Two refreshes of one (org, app) may still overlap (two processes, a slow
// refresh and the next interval's): each person's list is written with the
// time its provider run started, and a write never replaces a list computed
// from a later start, so the newer list always wins.
//
// When a person's list changed, their devices are told to reload the feed
// (an `attention` read-state frame, the one the feed already reloads on).

import type { AttentionItem, AttentionProviderError } from "@liaison/shared"
import { and, eq, inArray, sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type ActorContext, createRlsSession, type UserContext, withRlsContext } from "~/db/rls"
import { appAttentionItems } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { type AppEvent, onEvent } from "~/infra/events/event-bus"
import { enqueueAppJob, registerJobWorker } from "~/infra/jobs/jobs"
import { bounded } from "~/infra/websocket-state/redis"
import { appsLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { isReadOnlyTool } from "~/modules/agent/runtime/read-only-run"
import { readStandingInFor } from "~/modules/approvals/route-world"
import {
  appBridgeManifest,
  attentionItemsRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { isAppUnavailableFor, primeOrgApps } from "~/modules/apps/org-apps"
import { withAppDimensionAliases } from "~/modules/apps/runtime-helpers"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { runApp } from "~/modules/apps/sandbox/run-app"
import { onRunSettled, type RunSettledInfo } from "~/modules/apps/workers/run-settled"
import { writeUnlessMoving } from "~/modules/org/transfer-state/skip-moving"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"
import { broadcastReadState } from "~/modules/threads/read-state-broadcast"

const K = sql.raw(schemaRef("kernel"))

/** How long one provider run for one person may take (a background run, not a feed poll). */
export const PROVIDER_RUN_TIMEOUT_MS = 15_000
/** The most items stored per (app, person). */
export const PROVIDER_ITEM_CAP = 200
/** Wakes of one (org, app) within one such interval share one refresh, due at its end. */
export const REFRESH_MIN_INTERVAL_MS = 15_000
/** Refreshes one org runs per minute at most, all its apps together. */
export const ORG_REFRESHES_PER_MINUTE = 12
/** Provider runs (one per person of a refresh) one org runs per minute at most. */
export const ORG_PROVIDER_RUNS_PER_MINUTE = 120
/** A person who read their feed this recently is refreshed even when not online. */
export const SEEN_WINDOW_MS = 30 * 60_000
/**
 * The oldest stored list the feed serves. A person around is refreshed within
 * the minute tick's heartbeat (10 minutes), so a list older than this was left
 * out of the refreshes while its person was away: it is recomputed, not shown.
 */
export const STORED_LIST_MAX_AGE_MS = SEEN_WINDOW_MS
/** How long a feed read or a refresh waits on Redis for the audience. */
const REDIS_ANSWER_MS = 2_000
const seenKey = (orgId: string) => `attention:seen:${orgId}`
const presenceKey = (orgId: string, userId: string) => `presence:${orgId}:${userId}`
/** The attention queue (`app-attention-refresh`): its own worker, never the cron class. */
export const ATTENTION_REFRESH_QUEUE_APP = "attention-refresh"
export const ATTENTION_REFRESH_JOB = "attention-refresh"
/** Refresh jobs one process runs at once. */
export const ATTENTION_REFRESH_CONCURRENCY = 2
/** People of one refresh run at once. */
const PEOPLE_CONCURRENCY = 2

const TIMEOUT_SENTINEL = "__attention_provider_timeout__"

/** The entry kind of an attention run (runApp `entry`): its own runs never wake a refresh. */
export const ATTENTION_ENTRY_PREFIX = "attention:"

interface ProviderRegistration {
  handler: string
  scope?: string
  bundlePath: string
  core: boolean
  /** Declared `passesOn`: also given the people away today who name the person next in line. */
  passesOn?: boolean
}

/** The (org, app) entries that are app providers: org-scoped, not the kernel's wildcard ones. */
function providerOf(orgId: string, appName: string): ProviderRegistration | undefined {
  return attentionItemsRegistry.get([orgId, appName]) as ProviderRegistration | undefined
}

export function compareAttentionItems(a: AttentionItem, b: AttentionItem): number {
  if (b.urgency !== a.urgency) return b.urgency - a.urgency
  return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
}

/** Runs one app's provider as one person (a sandbox run for a sandboxed app). */
export async function invokeAppProvider(
  reg: ProviderRegistration,
  appName: string,
  actor: ActorContext,
  orgId: string,
  forUserIds: readonly string[] = [],
): Promise<AttentionItem[]> {
  const source = await loadBundle(reg.bundlePath)
  // Only a provider that declared `passesOn` hears of anyone but the person.
  const passOn =
    reg.passesOn === true && forUserIds.length > 0 ? { forUserIds: [...forUserIds] } : {}
  const aliasedActor = withAppDimensionAliases(actor, appName)
  const userId = aliasedActor.actorType === "user" ? aliasedActor.userId : "system"
  // The bridge must carry the app's REAL manifest: db_findMany validates every
  // entity/orderBy key against `manifest.schema`, so an empty stub makes every
  // provider db read fail ("Entity not found in app schema").
  const bridgeManifest = appBridgeManifest(orgId, appName)
  if (!bridgeManifest) {
    throw new Error(`No bridge manifest registered for app "${appName}" (org ${orgId})`)
  }
  // Bridge-owned transactions: the session bridge acquires a connection per
  // bridge db call, never for the whole sandbox run.
  const session = createRlsSession(aliasedActor)
  const bridge = createSessionRpcBridge(
    appName,
    userId,
    orgId,
    session,
    bridgeManifest,
    aliasedActor.scopes,
    aliasedActor.actorType,
    undefined,
    { actor: aliasedActor },
  )
  // runApp runs a core app's provider as server code, any other sandboxed.
  return (await runApp({
    appName,
    orgId,
    bundlePath: reg.bundlePath,
    bundleSource: source,
    exportName: reg.handler,
    entry: `${ATTENTION_ENTRY_PREFIX}${reg.handler}`,
    params: { actor: aliasedActor, ...passOn },
    bridge,
    holdsTx: false,
    appId: appName,
    timeoutMs: PROVIDER_RUN_TIMEOUT_MS,
  })) as AttentionItem[]
}

/**
 * Collapse items that target the same entity into one row. Providers emit one
 * item per matching rule, so a single ticket can surface as awaiting_agent AND
 * unassigned AND sla_risk: three feed rows for one thing to do. The input is
 * already sorted, so the first occurrence is the highest-urgency one; the
 * merged-away kinds land in `alsoKinds` for the UI to badge.
 */
export function dedupeByEntity(sorted: AttentionItem[]): AttentionItem[] {
  const byEntity = new Map<string, AttentionItem>()
  const out: AttentionItem[] = []
  for (const item of sorted) {
    const key = `${item.app}\u0000${item.entity}\u0000${item.entityId}`
    const existing = byEntity.get(key)
    if (!existing) {
      byEntity.set(key, item)
      out.push(item)
      continue
    }
    if (item.kind !== existing.kind && !existing.alsoKinds?.includes(item.kind)) {
      existing.alsoKinds = [...(existing.alsoKinds ?? []), item.kind]
    }
  }
  return out
}

/**
 * The provider's answer as stored: well-formed items only (a malformed one is
 * dropped and reported, never allowed to crash the feed UI), sorted, capped.
 */
export function normalizeProviderItems(raw: unknown): {
  items: AttentionItem[]
  error: Omit<AttentionProviderError, "app"> | null
} {
  if (!Array.isArray(raw)) {
    return {
      items: [],
      error: { reason: "error", message: "Provider returned non-array attention items" },
    }
  }
  const wellFormed = (raw as AttentionItem[]).filter(
    (i) =>
      i &&
      typeof i === "object" &&
      typeof i.id === "string" &&
      typeof i.entityId === "string" &&
      typeof i.kind === "string" &&
      typeof i.summary === "string" &&
      typeof i.urgency === "number" &&
      i.action &&
      typeof (i.action as { type?: unknown }).type === "string",
  )
  // Several rules about one record are one thing to do: merged before the cap, so the cap
  // counts distinct records and a long queue keeps its most urgent ones.
  const distinct = dedupeByEntity([...wellFormed].sort(compareAttentionItems))
  const items =
    distinct.length > PROVIDER_ITEM_CAP ? distinct.slice(0, PROVIDER_ITEM_CAP) : distinct
  // A queue longer than the cap is an answer, not a failure: the feed shows its most urgent
  // items. Reporting it as an error told the reader the app "did not answer".
  if (items.length < distinct.length) {
    log.info(
      { returned: distinct.length, kept: PROVIDER_ITEM_CAP },
      "Attention provider list capped to its most urgent items",
    )
  }
  const error: Omit<AttentionProviderError, "app"> | null =
    wellFormed.length < raw.length
      ? {
          reason: "error",
          message: `Dropped ${raw.length - wellFormed.length} malformed attention item(s)`,
        }
      : null
  return { items, error }
}

export interface AttentionStoreDeps {
  /** The people a refresh runs for (default: the org's active members who are around). */
  listActiveUsers: (orgId: string) => Promise<string[]>
  loadPersonActor: (orgId: string, userId: string) => Promise<UserContext>
  invoke: (
    reg: ProviderRegistration,
    appName: string,
    actor: ActorContext,
    orgId: string,
    forUserIds?: readonly string[],
  ) => Promise<unknown>
  /** Tell a person's devices that their feed changed. */
  notify: (orgId: string, userId: string, appName: string) => Promise<void>
}

/** Every active person of the org, around or not: who a refresh that must store every list runs for. */
export async function listEveryActiveUser(orgId: string): Promise<string[]> {
  return withPrivilegedDb(orgId, "attention-store:list-users", async (tx) => {
    const rows = (await tx.execute(
      sql`SELECT id::text AS id FROM ${K}.users WHERE org_id = ${orgId} AND status = 'active'`,
    )) as unknown as Array<{ id: string }>
    return rows.map((r) => r.id)
  })
}

async function defaultLoadPersonActor(orgId: string, userId: string): Promise<UserContext> {
  const { scopes, dimensionGrants } = await withPrivilegedDb(
    orgId,
    "attention-store:load-scopes",
    (tx) => loadEffectivePermissions(tx, userId, orgId),
  )
  return { actorType: "user", userId, orgId, scopes, dimensionGrants }
}

/**
 * Of `active`, the people around: online now (a live presence entry that is not
 * "offline") or seen reading their feed within SEEN_WINDOW_MS. Redis unanswered:
 * everyone (a refresh is never skipped for want of an answer).
 */
export async function attentionAudience(
  orgId: string,
  active: string[],
  now = Date.now(),
): Promise<string[]> {
  if (active.length === 0) return []
  try {
    const [presence, seen] = await bounded(
      Promise.all([
        redis.mget(...active.map((u) => presenceKey(orgId, u))),
        redis.zrangebyscore(seenKey(orgId), now - SEEN_WINDOW_MS, "+inf"),
      ]),
      REDIS_ANSWER_MS,
      "attention audience",
    )
    const recent = new Set(seen)
    return active.filter((u, i) => {
      const status = presence[i]
      return (typeof status === "string" && status !== "offline") || recent.has(u)
    })
  } catch (err) {
    log.warn({ err, orgId }, "Attention audience unavailable; refreshing everyone")
    return active
  }
}

/**
 * The reader read their feed: they are around. Answers whether they were away
 * (not seen within SEEN_WINDOW_MS), so their stored lists may be stale.
 */
export async function markAttentionReader(
  orgId: string,
  userId: string,
  now = Date.now(),
): Promise<boolean> {
  const key = seenKey(orgId)
  try {
    const res = await bounded(
      redis
        .multi()
        .zscore(key, userId)
        .zadd(key, now, userId)
        .zremrangebyscore(key, "-inf", now - SEEN_WINDOW_MS)
        .expire(key, Math.ceil((2 * SEEN_WINDOW_MS) / 1000))
        .exec(),
      REDIS_ANSWER_MS,
      "attention reader mark",
    )
    const last = Number(res?.[0]?.[1] ?? Number.NaN)
    return !Number.isFinite(last) || last < now - SEEN_WINDOW_MS
  } catch (err) {
    log.warn({ err, orgId }, "Attention reader mark unavailable")
    return false
  }
}

const defaultDeps: AttentionStoreDeps = {
  listActiveUsers: async (orgId) => attentionAudience(orgId, await listEveryActiveUser(orgId)),
  loadPersonActor: defaultLoadPersonActor,
  invoke: invokeAppProvider,
  notify: (orgId, userId, appName) =>
    broadcastReadState(orgId, userId, { kind: "attention", app: appName }),
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        handle = setTimeout(() => rej(new Error(TIMEOUT_SENTINEL)), ms)
      }),
    ])
  } finally {
    if (handle) clearTimeout(handle)
  }
}

async function readStoredLists(
  orgId: string,
  appName: string,
): Promise<Map<string, { items: AttentionItem[]; error: unknown; computedAt: Date }>> {
  const rows = await withPrivilegedDb(orgId, "attention-store:read", (tx) =>
    tx
      .select({
        userId: appAttentionItems.userId,
        items: appAttentionItems.items,
        error: appAttentionItems.error,
        computedAt: appAttentionItems.computedAt,
      })
      .from(appAttentionItems)
      .where(and(eq(appAttentionItems.orgId, orgId), eq(appAttentionItems.app, appName))),
  )
  return new Map(
    rows.map((r) => [r.userId, { items: r.items ?? [], error: r.error, computedAt: r.computedAt }]),
  )
}

/**
 * Store one person's list, computed by a provider run that started at
 * `startedAt`. A stored list computed from a later start is kept: an older
 * refresh finishing last never replaces a newer list. Returns whether it wrote.
 */
async function writeStoredList(
  orgId: string,
  appName: string,
  userId: string,
  items: AttentionItem[] | null,
  error: Omit<AttentionProviderError, "app"> | null,
  startedAt: Date,
): Promise<boolean> {
  const target = [appAttentionItems.orgId, appAttentionItems.app, appAttentionItems.userId]
  const newer = sql`${appAttentionItems.computedAt} <= excluded.computed_at`
  return withPrivilegedDb(orgId, "attention-store:write", async (tx) => {
    if (items === null) {
      // A failed run keeps the last good list, with the failure beside it.
      const rows = await tx
        .insert(appAttentionItems)
        .values({ orgId, app: appName, userId, items: [], error, computedAt: startedAt })
        .onConflictDoUpdate({ target, set: { error, computedAt: startedAt }, setWhere: newer })
        .returning({ userId: appAttentionItems.userId })
      return rows.length > 0
    }
    const rows = await tx
      .insert(appAttentionItems)
      .values({ orgId, app: appName, userId, items, error, computedAt: startedAt })
      .onConflictDoUpdate({ target, set: { items, error, computedAt: startedAt }, setWhere: newer })
      .returning({ userId: appAttentionItems.userId })
    return rows.length > 0
  })
}

/**
 * Run one app's provider for every active person of the org who may see its
 * items, and store each list. A person without the provider's scope, or to
 * whom the app is not available, gets an empty list. One person's failure is
 * stored beside their last good list and does not stop the others. Returns
 * how many people's lists changed.
 */
export async function refreshAppAttention(
  orgId: string,
  appName: string,
  partial: Partial<AttentionStoreDeps> & { userIds?: string[] } = {},
): Promise<{ people: number; changed: number }> {
  const deps: AttentionStoreDeps = { ...defaultDeps, ...partial }
  const reg = providerOf(orgId, appName)
  if (!reg) return { people: 0, changed: 0 }
  await primeOrgApps(orgId)
  const people = partial.userIds ?? (await deps.listActiveUsers(orgId))
  const previous = await readStoredLists(orgId, appName)
  let changed = 0
  const refreshOne = async (userId: string): Promise<void> => {
    let items: AttentionItem[] | null = []
    let error: Omit<AttentionProviderError, "app"> | null = null
    // What this run reads is the state as of now: its list is stamped with it.
    const startedAt = new Date()
    try {
      const loaded = await deps.loadPersonActor(orgId, userId)
      // The run is always this org's and this person's, whatever was loaded.
      const actor: UserContext = { ...loaded, actorType: "user", userId, orgId }
      const scopes = withAppDimensionAliases(actor, appName).scopes ?? []
      const allowed =
        !isAppUnavailableFor(orgId, appName, userId) && (!reg.scope || hasScope(reg.scope, scopes))
      if (allowed) {
        // A provider that passes items on also lists those of the people away today who name
        // this person next in line (read as this person; unreadable means nobody). The minute
        // tick re-reads it, so a return from leave clears within a minute.
        const forUserIds =
          reg.passesOn === true
            ? await withRlsContext(actor, (tx) => readStandingInFor(tx, orgId, userId)).catch(
                (err: unknown) => {
                  log.warn({ err, orgId, userId }, "could not read whom the person stands in for")
                  return [] as string[]
                },
              )
            : []
        const raw = await withTimeout(
          deps.invoke(reg, appName, actor, orgId, forUserIds),
          PROVIDER_RUN_TIMEOUT_MS + 1_000,
        )
        const normalized = normalizeProviderItems(raw)
        items = normalized.items
        error = normalized.error
      }
    } catch (err) {
      const isTimeout = err instanceof Error && err.message === TIMEOUT_SENTINEL
      error = isTimeout
        ? { reason: "timeout", message: `Provider exceeded ${PROVIDER_RUN_TIMEOUT_MS / 1000}s` }
        : { reason: "error", message: err instanceof Error ? err.message : "unknown" }
      items = null
      log.warn({ app: appName, orgId, userId, ...error }, "Attention provider run failed")
    }
    const before = previous.get(userId)
    try {
      // A newer list is stored already (a later refresh finished first): this one is dropped.
      if (!(await writeStoredList(orgId, appName, userId, items, error, startedAt))) return
    } catch (err) {
      log.warn({ err, app: appName, orgId, userId }, "Attention list could not be stored")
      return
    }
    const itemsChanged =
      items !== null && JSON.stringify(before?.items ?? []) !== JSON.stringify(items)
    // The feed did not serve a list this old (readStoredAttention): it reloads once stored.
    const wasHidden =
      before !== undefined && isStoredListTooOld(before.computedAt, startedAt.getTime())
    if (itemsChanged || (items !== null && (before === undefined || wasHidden))) {
      changed++
      await deps.notify(orgId, userId, appName).catch(() => {})
    }
  }
  let next = 0
  const lanes = Array.from({ length: Math.min(PEOPLE_CONCURRENCY, people.length) }, async () => {
    while (next < people.length) {
      const userId = people[next++]
      if (userId) await refreshOne(userId)
    }
  })
  await Promise.all(lanes)
  return { people: people.length, changed }
}

/**
 * Every app provider of the org, refreshed now, in this process, one app after
 * the other, for every active member (around or not): for a caller that must
 * find the lists stored when it returns (a seeded demo workspace, one just
 * claimed), never a wake. Wakes and the minute
 * tick queue jobs instead (scheduleAttentionRefresh,
 * scheduleAllAppAttentionRefresh). The people and each one's permissions are
 * read once for the whole pass, not once per app.
 */
export async function refreshAllAppAttention(
  orgId: string,
  partial: Partial<AttentionStoreDeps> & { userIds?: string[] } = {},
): Promise<void> {
  const apps = [...attentionItemsRegistry.entriesOf(orgId)]
    .map(([[entryOrg, appName]]) => (entryOrg === orgId ? appName : null))
    .filter((a): a is string => a !== null)
  if (apps.length === 0) return
  let userIds: string[]
  try {
    // Every active member, not only the people around: the caller needs every
    // list stored when this returns (nobody is around in a workspace just seeded).
    userIds = partial.userIds ?? (await (partial.listActiveUsers ?? listEveryActiveUser)(orgId))
  } catch (err) {
    log.warn({ err, orgId }, "Attention refresh failed: the org's people could not be read")
    return
  }
  const loadOnce = partial.loadPersonActor ?? defaultDeps.loadPersonActor
  const actors = new Map<string, Promise<UserContext>>()
  const loadPersonActor = (o: string, userId: string): Promise<UserContext> => {
    let loaded = actors.get(userId)
    if (!loaded) {
      loaded = loadOnce(o, userId)
      // A failed read is not kept: the next app asks again.
      loaded.catch(() => actors.delete(userId))
      actors.set(userId, loaded)
    }
    return loaded
  }
  for (const appName of apps) {
    try {
      await refreshAppAttention(orgId, appName, { ...partial, userIds, loadPersonActor })
    } catch (err) {
      log.warn({ err, orgId, app: appName }, "Attention refresh failed")
    }
  }
}

// --- Wakes: a queued job per (org, app) and interval -----------------------------

/** One queued refresh: the job id deduplicates (BullMQ), the delay makes it due. */
export interface AttentionRefreshPayload {
  org: string
  app: string
}
export interface AttentionRefreshJob {
  jobId: string
  delay: number
  payload: AttentionRefreshPayload
}

type WakeDeps = Partial<AttentionStoreDeps> & {
  ensureOrgApps?: (orgId: string) => Promise<void>
  /** Queue a refresh job (default: the attention queue). */
  enqueue?: (job: AttentionRefreshJob) => Promise<void>
  now?: () => number
  /** Count one refresh against the org's minute; false once the cap is spent. */
  takeOrgBudget?: (orgId: string, now: number) => Promise<boolean>
  /** Count `runs` provider runs against the org's minute; false once the cap is spent. */
  takeOrgRunBudget?: (orgId: string, runs: number, now: number) => Promise<boolean>
  /** Mark a feed reader seen; true when they were away (default: Redis). */
  markReader?: (orgId: string, userId: string) => Promise<boolean>
}

/** What a woken refresh runs with: the defaults, unless a test set its doubles. */
let wakeDeps: WakeDeps = {}
/** The interval each (org, app) last queued its job for, in this process: saves a Redis round trip per wake. */
const queuedInterval = new Map<string, number>()
const QUEUED_INTERVAL_MAX_KEYS = 10_000
/** Enqueues not yet answered (tests wait on them). */
const inFlight = new Set<Promise<void>>()

function keyOf(orgId: string, appName: string): string {
  return `${orgId}\u0000${appName}`
}

function jobIdOf(orgId: string, appName: string, suffix: string): string {
  return `${ATTENTION_REFRESH_JOB}:${orgId}:${appName}:${suffix}`
}

async function defaultEnqueue(job: AttentionRefreshJob): Promise<void> {
  await enqueueAppJob(ATTENTION_REFRESH_QUEUE_APP, ATTENTION_REFRESH_JOB, job.payload, {
    jobId: job.jobId,
    delay: job.delay,
    attempts: 1,
  })
}

/** INCR of the org's minute counter; a Redis failure lets the refresh run. */
async function defaultTakeOrgBudget(orgId: string, now: number): Promise<boolean> {
  const key = `attention:refresh-budget:${orgId}:${Math.floor(now / 60_000)}`
  try {
    const res = await redis.multi().incr(key).expire(key, 120).exec()
    const count = Number(res?.[0]?.[1] ?? 0)
    return count <= ORG_REFRESHES_PER_MINUTE
  } catch (err) {
    log.warn({ err, orgId }, "Attention refresh budget unavailable; refreshing")
    return true
  }
}

/**
 * INCRBY of the org's provider-run minute counter. A refresh larger than the
 * whole cap still runs as the minute's first (else it would never run); a
 * refused one gives its count back. A Redis failure lets the refresh run.
 */
async function defaultTakeOrgRunBudget(orgId: string, runs: number, now: number): Promise<boolean> {
  if (runs <= 0) return true
  const key = `attention:run-budget:${orgId}:${Math.floor(now / 60_000)}`
  try {
    const res = await redis.multi().incrby(key, runs).expire(key, 120).exec()
    const total = Number(res?.[0]?.[1] ?? 0)
    if (total <= ORG_PROVIDER_RUNS_PER_MINUTE || total === runs) return true
    await redis.decrby(key, runs)
    return false
  } catch (err) {
    log.warn({ err, orgId }, "Attention run budget unavailable; refreshing")
    return true
  }
}

function track(p: Promise<void>): void {
  inFlight.add(p)
  void p.finally(() => inFlight.delete(p))
}

function enqueueRefresh(job: AttentionRefreshJob, onFailure?: () => void): void {
  const enqueue = wakeDeps.enqueue ?? defaultEnqueue
  track(
    enqueue(job).catch((err: unknown) => {
      onFailure?.()
      log.warn(
        { err, orgId: job.payload.org, app: job.payload.app },
        "Attention refresh not queued",
      )
    }),
  )
}

/**
 * Ask for the app's stored attention to be recomputed (after a wake): queues
 * the (org, app)'s job for the end of the current interval, once. Synchronous
 * and cheap; runs no app code; a no-op for an app with no provider in the org.
 */
export function scheduleAttentionRefresh(orgId: string, appName: string): void {
  if (!providerOf(orgId, appName)) return
  const now = (wakeDeps.now ?? Date.now)()
  const interval = Math.floor(now / REFRESH_MIN_INTERVAL_MS) + 1
  const key = keyOf(orgId, appName)
  if (queuedInterval.get(key) === interval) return
  if (queuedInterval.size >= QUEUED_INTERVAL_MAX_KEYS) queuedInterval.clear()
  queuedInterval.set(key, interval)
  enqueueRefresh(
    {
      jobId: jobIdOf(orgId, appName, String(interval)),
      delay: interval * REFRESH_MIN_INTERVAL_MS - now,
      payload: { org: orgId, app: appName },
    },
    () => {
      if (queuedInterval.get(key) === interval) queuedInterval.delete(key)
    },
  )
}

/**
 * The minute tick's refresh of every app provider of the org: one job per
 * app, due now, at most once a minute per (org, app).
 */
export async function scheduleAllAppAttentionRefresh(orgId: string): Promise<void> {
  if (wakeDeps.ensureOrgApps) await wakeDeps.ensureOrgApps(orgId)
  else {
    const { awaitOrgApps } = await import("~/modules/apps/init")
    await awaitOrgApps(orgId)
  }
  const minute = Math.floor((wakeDeps.now ?? Date.now)() / 60_000)
  for (const [[entryOrg, appName]] of attentionItemsRegistry.entriesOf(orgId)) {
    if (entryOrg !== orgId) continue
    enqueueRefresh({
      jobId: jobIdOf(orgId, appName, `t${minute}`),
      delay: 0,
      payload: { org: orgId, app: appName },
    })
  }
}

/**
 * The refresh job: within the org's minute budget, the app's provider runs
 * for each person and their lists are stored; past it, the job moves to the
 * next minute.
 */
export async function processAttentionRefreshJob(
  payload: AttentionRefreshPayload,
  partial: WakeDeps = {},
): Promise<void> {
  const deps: WakeDeps = { ...wakeDeps, ...partial }
  const { org: orgId, app: appName } = payload
  // A wake from now on falls after this run started: it queues a new job.
  queuedInterval.delete(keyOf(orgId, appName))
  const now = (deps.now ?? Date.now)()
  const nextMinute = async (): Promise<void> => {
    const minute = Math.floor(now / 60_000) + 1
    await (deps.enqueue ?? defaultEnqueue)({
      jobId: jobIdOf(orgId, appName, `m${minute}`),
      delay: minute * 60_000 - now,
      payload: { org: orgId, app: appName },
    })
  }
  if (!(await (deps.takeOrgBudget ?? defaultTakeOrgBudget)(orgId, now))) return nextMinute()
  if (deps.ensureOrgApps) await deps.ensureOrgApps(orgId)
  else {
    const { awaitOrgApps } = await import("~/modules/apps/init")
    await awaitOrgApps(orgId)
  }
  if (!providerOf(orgId, appName)) return
  // The people around, counted against the org's provider runs of the minute.
  const userIds = await (deps.listActiveUsers ?? defaultDeps.listActiveUsers)(orgId)
  if (!(await (deps.takeOrgRunBudget ?? defaultTakeOrgRunBudget)(orgId, userIds.length, now))) {
    return nextMinute()
  }
  // An org being moved is left alone (the transfer hold keys on `orgId`, which
  // this payload does not carry): its new home recomputes on its first read.
  await writeUnlessMoving(orgId, () => refreshAppAttention(orgId, appName, { ...deps, userIds }))
}

/** Resolves once no enqueue (or, under a test double, no refresh) is in flight. */
export async function attentionRefreshesSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight])
}

let wired = false

/** Entry kinds whose runs only read: what a provider lists cannot have changed. */
const READ_ONLY_ENTRY_KINDS: ReadonlySet<string> = new Set([
  "attention",
  "search",
  "export",
  "preview",
  "summarizer",
  "preflight",
  "webhook-verify",
  "pdf-template",
  "import-transform",
])

/**
 * Could this run have changed what the app's provider lists? Not a run of a
 * read-only entry kind, nor of a tool the app declares read-only (and that
 * declares no write target): the read-only-run rule (isReadOnlyTool). Any
 * other run (a write, an event handler, a job, a webhook, a poll, an
 * undeclared tool) may have.
 */
export function runCouldChangeAttention(
  info: Pick<RunSettledInfo, "orgId" | "app" | "entry">,
): boolean {
  const colon = info.entry.indexOf(":")
  const kind = colon < 0 ? info.entry : info.entry.slice(0, colon)
  if (READ_ONLY_ENTRY_KINDS.has(kind)) return false
  if (kind === "tool") {
    const def = toolRegistry.get([info.orgId, info.app, info.entry.slice(colon + 1)])
    if (def && isReadOnlyTool(def)) return false
  }
  return true
}

/** A run of an app settled (any executor): its stored attention may have changed. */
function wakeOnRunSettled(info: RunSettledInfo): void {
  // The org and app of the run itself, as runApp reported it.
  if (!runCouldChangeAttention(info)) return
  scheduleAttentionRefresh(info.orgId, info.app)
}

/** An event of an app was delivered (once, in the outbox leader). */
async function wakeOnAppEvent(event: AppEvent): Promise<void> {
  // The event's own org and app.
  if (event.ephemeral || !event.orgId || !event.app || event.app === "kernel") return
  scheduleAttentionRefresh(event.orgId, event.app)
}

/** Register the refresh job's worker (every process; only a job host runs it). */
export function registerAttentionRefreshWorker(): void {
  registerJobWorker<AttentionRefreshPayload>(
    ATTENTION_REFRESH_QUEUE_APP,
    ATTENTION_REFRESH_JOB,
    async (payload) => {
      await processAttentionRefreshJob(payload)
    },
    { concurrency: ATTENTION_REFRESH_CONCURRENCY },
  )
}

/**
 * Register the refresh job, and wake it after every run of an app that may
 * have written and after every delivered event of an app. Idempotent.
 */
export function wireAttentionRefreshWakes(): void {
  if (wired) return
  wired = true
  registerAttentionRefreshWorker()
  onRunSettled(wakeOnRunSettled)
  onEvent(wakeOnAppEvent, { delivery: "once", name: "app-attention-refresh" })
}

// --- The feed's read -----------------------------------------------------------

export interface StoredAttention {
  items: AttentionItem[]
  error: Omit<AttentionProviderError, "app"> | null
}

/** Was this list computed too long ago to be served (STORED_LIST_MAX_AGE_MS)? */
export function isStoredListTooOld(computedAt: Date | string, now: number): boolean {
  const at = new Date(computedAt).getTime()
  return !Number.isFinite(at) || at < now - STORED_LIST_MAX_AGE_MS
}

/**
 * The reader's stored lists of these apps, under the reader's RLS context. An
 * app with no stored list for the reader, or with one computed more than
 * STORED_LIST_MAX_AGE_MS ago, is absent from the map (and is scheduled for a
 * refresh in the background): the feed never shows a list that may no longer
 * be true.
 */
export async function readStoredAttention(
  tx: RlsClient,
  orgId: string,
  userId: string,
  apps: string[],
): Promise<Map<string, StoredAttention>> {
  const out = new Map<string, StoredAttention>()
  if (apps.length === 0 || !userId) return out
  const rows = await tx
    .select({
      app: appAttentionItems.app,
      items: appAttentionItems.items,
      error: appAttentionItems.error,
      computedAt: appAttentionItems.computedAt,
    })
    .from(appAttentionItems)
    .where(
      and(
        eq(appAttentionItems.orgId, orgId),
        eq(appAttentionItems.userId, userId),
        inArray(appAttentionItems.app, apps),
      ),
    )
  const now = Date.now()
  for (const r of rows) {
    if (isStoredListTooOld(r.computedAt, now)) continue
    out.set(r.app, {
      items: Array.isArray(r.items) ? r.items : [],
      error: (r.error as StoredAttention["error"]) ?? null,
    })
  }
  // Queued, never run here: the read runs no app code. A reader back from
  // away was left out of the refreshes meanwhile: every app is recomputed.
  // The mark is not awaited here: the read may hold a transaction.
  for (const app of apps) if (!out.has(app)) scheduleAttentionRefresh(orgId, app)
  track(
    (wakeDeps.markReader ?? markAttentionReader)(orgId, userId).then((returning) => {
      if (returning) for (const app of out.keys()) scheduleAttentionRefresh(orgId, app)
    }),
  )
  return out
}

/** Test seams: the doubles a woken refresh runs with. */
export const AttentionStoreTestAccess = {
  setWakeDeps(deps: WakeDeps): void {
    wakeDeps = deps
    queuedInterval.clear()
  },
  reset(): void {
    wakeDeps = {}
    queuedInterval.clear()
  },
}
