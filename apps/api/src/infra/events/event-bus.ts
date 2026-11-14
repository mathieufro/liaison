// SPDX-License-Identifier: FSL-1.1-ALv2
import { AsyncLocalStorage } from "node:async_hooks"
import { eventsLogger as log } from "~/lib/logger"
import { REDIS_PREFIX, redis, redisSub } from "~/lib/redis"
import { declaredEmits } from "~/modules/apps/app-registries"

export { declaredEmits }

export interface AppEvent {
  app: string
  entity: string
  action: string
  entityId?: string
  data?: unknown
  actorId?: string | null
  orgId: string
  timestamp?: string
  actorType?: "user" | "agent" | "system" | "mcp"
  /**
   * The `kernel.agents` row acting in the turn that emitted this event, when
   * one is known. INDEPENDENT of `actorId` (the human on whose behalf it acted)
   * and of `actorType`: an agent turn's app post is authored by the system and
   * still names its agent.
   *
   * Stamped at EMIT time from the run frame, or from a frame captured before a
   * hop that loses it. Deliberately NOT read from the ALS store by the outbox
   * worker or `writeAuditLog`: the worker runs outside the turn's async
   * context, so that path would see no frame and would silently miss exactly
   * the durable rows this exists for. Both audit consumers persist it into
   * `kernel.audit_log.agent_id`, which is what makes "what did this agent do"
   * answerable (spec A11).
   *
   * Absent or null means no agent could be resolved. The audit row is still
   * written, naming no agent: identity fails closed, the write does not.
   */
  agentId?: string | null
  metadata?: unknown
  ephemeral?: boolean
  /**
   * WS replay sequence id, assigned once via `assignWsReplayId` — by the
   * outbox worker at claim time (before durable consumers run) on the
   * single-writer outbox path, or lazily in `_publishEventInternal` for
   * non-outbox callers — and propagated to every process, so the WS fan-out
   * broadcasts a consistent id while only the originator writes the replay
   * buffer.
   */
  _wsEventId?: number
  /**
   * Set when the event arrived via the Redis subscriber (published by another
   * process). The WS fan-out then broadcasts to local connections only and does
   * NOT re-write the replay buffer (the originating process already did).
   */
  _remote?: boolean
}

/**
 * Where a bus handler runs (A5).
 * - `once`: only in the process that published the event (the outbox drain, or
 *   a direct publisher). A peer's `_remote` copy never reaches it. For anything
 *   that writes (rows, jobs, outside calls): run on every process, it would act
 *   once per process.
 * - `per-replica`: in every process, the publisher's and each peer's. For
 *   process-local state: caches, projected tools, this process's sockets.
 */
export type Delivery = "once" | "per-replica"

export interface EventHandlerOptions {
  delivery: Delivery
  /**
   * Names a `once` handler for the test sink: with `LIAISON_TEST_EVENT_SINK=1`
   * each call increments `test:event-sink:{name}:{app}:{entity}:{action}:{entityId}`,
   * so a multi-process test can count how often a once handler ran cell-wide.
   */
  name?: string
}

type EventHandler = (event: AppEvent) => Promise<void>

/**
 * The running dispatch's abort signal, read with `currentHandlerSignal()`: it
 * fires when the dispatch gives up on the handler (HANDLER_TIMEOUT_MS), so work
 * the handler is still waiting for (a pinned-job admission, say) can stop
 * waiting. Async context, not a handler argument: handlers keep one parameter.
 */
const handlerSignal = new AsyncLocalStorage<AbortSignal>()

/** The abort signal of the event dispatch running this code, if any. */
export function currentHandlerSignal(): AbortSignal | undefined {
  return handlerSignal.getStore()
}

interface RegisteredHandler {
  fn: EventHandler
  delivery: Delivery
  name?: string
}

// In-process subscriber handlers (per-channel)
const handlers = new Map<string, RegisteredHandler[]>()

// Global handlers (run for every event — registered via onEvent)
const globalHandlers: RegisteredHandler[] = []

/** The handlers a peer's `_remote` copy reaches: only the per-replica ones. */
function perReplicaOnly(list: readonly RegisteredHandler[]): RegisteredHandler[] {
  return list.filter((h) => h.delivery === "per-replica")
}

/**
 * Test sink (test env only): count a named once handler's call in Redis. A sink
 * failure never affects the handler.
 */
async function noteOnceCall(entry: RegisteredHandler, event: AppEvent): Promise<void> {
  if (entry.delivery !== "once" || !entry.name) return
  await noteOnceDelivery(entry.name, event)
}

/**
 * The same test sink for a target a shared `once` handler routes the event to
 * (one handler per event type serves every event routine on it: the sink still
 * counts per routine). No-op outside the test sink.
 */
export async function noteOnceDelivery(name: string, event: AppEvent): Promise<void> {
  if (process.env.LIAISON_TEST_EVENT_SINK !== "1") return
  const key = `test:event-sink:${name}:${event.app}:${event.entity}:${event.action}:${event.entityId ?? "-"}`
  try {
    await redis.incr(key)
  } catch (err) {
    log.warn({ err, key }, "test event sink increment failed")
  }
}

/**
 * An event of an org moving to another instance (frozen, incoming or moved,
 * modules/org/transfer-state/), or of an org whose move state cannot be read:
 * not published now. The outbox worker releases the row unprocessed with its
 * attempts untouched (retry later, not a failure); its claim then skips the
 * org until the move is over, here after an abort or on the target, which
 * receives the row unprocessed.
 */
export class EventDeferredError extends Error {
  constructor(
    readonly orgId: string,
    readonly reason: "moving" | "state-unreadable",
    cause?: unknown,
  ) {
    super(`Event of org ${orgId} deferred: ${reason}`, cause === undefined ? undefined : { cause })
    this.name = "EventDeferredError"
  }
}

/**
 * Count the event's handlers as live writes of its org, then check the org
 * takes them (in this order, so a freeze that lands between the two is seen
 * by the quiesce). Returns the end of the count; throws `EventDeferredError`
 * when the org is moving or its state cannot be read (fail closed, never
 * skipped).
 */
async function beginOrgEventWork(orgId: string): Promise<() => void> {
  const { beginOrgActivity, orgTransferStateOf, refusesWrites } = await import(
    "~/modules/org/transfer-state/state"
  )
  const end = beginOrgActivity(orgId, "writes")
  let rec: Awaited<ReturnType<typeof orgTransferStateOf>>
  try {
    rec = await orgTransferStateOf(orgId)
  } catch (err) {
    end()
    throw new EventDeferredError(orgId, "state-unreadable", err)
  }
  if (rec !== null && refusesWrites(rec.state)) {
    end()
    throw new EventDeferredError(orgId, "moving")
  }
  return end
}

/** The org setup a `once` dispatch awaits first (`awaitOrgApps`; replaceable in tests). */
const defaultEnsureEventOrg = async (orgId: string): Promise<void> => {
  const { awaitOrgApps } = await import("~/modules/apps/init")
  await awaitOrgApps(orgId)
}
let ensureEventOrg: (orgId: string) => Promise<void> = defaultEnsureEventOrg

// Process-local dedup to skip messages we published ourselves (not shared Redis).
// Redis payloads stored as plain JSON. Internal-only; consider encryption if Redis moves to managed shared tenancy.
export const MAX_LOCAL_IDS = 50_000
const localPublishedIds = new Set<string>()
const localPublishedQueue: string[] = []

export function trackLocalPublish(id: string): void {
  localPublishedIds.add(id)
  localPublishedQueue.push(id)
  while (localPublishedQueue.length > MAX_LOCAL_IDS) {
    localPublishedIds.delete(localPublishedQueue.shift()!)
  }
}

// Peer messages already dispatched, by `_msgId`: a channel subscribed both
// explicitly and through the events pattern delivers each message twice.
const remoteSeenIds = new Set<string>()
const remoteSeenQueue: string[] = []

/** Records a peer `_msgId`; false when it was already seen. */
function firstRemoteSighting(id: string): boolean {
  if (remoteSeenIds.has(id)) return false
  remoteSeenIds.add(id)
  remoteSeenQueue.push(id)
  while (remoteSeenQueue.length > MAX_LOCAL_IDS) {
    remoteSeenIds.delete(remoteSeenQueue.shift()!)
  }
  return true
}

// Bounded concurrency for handler dispatches — prevents unbounded parallelism
const MAX_CONCURRENT_DISPATCHES = 50
let activeDispatches = 0

// Each queued waiter carries the resolver plus enough context to identify and
// drop it if the queue backs up: `ephemeral` (drop-oldest-ephemeral-only
// candidates) and a `cancel` the cap-eviction path invokes to unblock a
// dropped dispatch instead of leaving it hanging forever.
interface DispatchWaiter {
  ephemeral: boolean
  resolve: () => void
  /** Marks the waiter as dropped so it settles false when it eventually runs. */
  dropped: boolean
}
const waitQueue: DispatchWaiter[] = []

// Cap on the number of dispatches allowed to queue behind the concurrency
// limit. Under sustained event storms (many events, slow handlers) the queue
// would otherwise grow unboundedly — one Promise + closure per queued
// dispatch, forever, until the process runs out of memory. Once at cap, drop
// the OLDEST **ephemeral** waiter to make room (ephemeral events have no
// outbox behind them, so dropping one only means a live UI signal — typing,
// presence — is skipped once; durable/persisted dispatches always ride the
// outbox and must never be silently dropped here).
export const MAX_DISPATCH_WAIT_QUEUE = 10_000
let _waitQueueCap = MAX_DISPATCH_WAIT_QUEUE

/**
 * How long a single handler dispatch may run before its concurrency slot is
 * force-released. Without this, a handler that never resolves (a hung fetch,
 * a wedged DB call) permanently pins one of the 50 concurrency slots — enough
 * hangs wedge the whole event bus (every subsequent event queues forever).
 * The handler's own promise is not cancelled (JS cannot cancel an in-flight
 * async function) — only the slot bookkeeping is released, so a late
 * resolution/rejection from the hung handler is simply ignored.
 */
export const HANDLER_TIMEOUT_MS = 60_000
let _handlerTimeoutMs = HANDLER_TIMEOUT_MS

async function acquireDispatchSlot(ephemeral: boolean): Promise<boolean> {
  if (activeDispatches < MAX_CONCURRENT_DISPATCHES) {
    activeDispatches++
    return true
  }
  if (waitQueue.length >= _waitQueueCap) {
    // Queue is at cap — drop the oldest EPHEMERAL waiter (scan from the
    // front; ephemeral waiters are typically the earliest queued since they
    // have no retry pressure behind them). Persisted/durable dispatches are
    // never evicted — they always outlast the queue.
    const idx = waitQueue.findIndex((w) => w.ephemeral)
    if (idx !== -1) {
      const [dropped] = waitQueue.splice(idx, 1)
      dropped.dropped = true
      dropped.resolve()
      log.error(
        { waitQueueLength: waitQueue.length },
        "Event-bus dispatch wait queue at capacity — dropped oldest ephemeral waiter",
      )
    } else {
      log.error(
        { waitQueueLength: waitQueue.length },
        "Event-bus dispatch wait queue at capacity with no ephemeral waiter to drop — durable dispatch will queue past cap",
      )
    }
  }
  return new Promise<boolean>((resolve) => {
    const waiter: DispatchWaiter = {
      ephemeral,
      dropped: false,
      resolve: () => {
        if (waiter.dropped) {
          resolve(false)
          return
        }
        activeDispatches++
        resolve(true)
      },
    }
    waitQueue.push(waiter)
  })
}

function releaseDispatchSlot(): void {
  activeDispatches--
  const next = waitQueue.shift()
  if (next) next.resolve()
}

/**
 * Run one handler with a hard wall-clock cap so a hung handler cannot
 * permanently pin a dispatch concurrency slot (event-bus wedge, E1). On
 * timeout, logs and returns — the caller's existing retry-once logic still
 * applies on genuine (non-timeout) rejections; a timeout is treated as a
 * terminal failure for this dispatch (no retry — the handler is still
 * running in the background and a second concurrent invocation could
 * double-process). The timeout aborts the handler's signal (currentHandlerSignal).
 */
async function runHandlerWithTimeout(
  handler: EventHandler,
  event: AppEvent,
  channel: string,
): Promise<void> {
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = new AbortController()
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      abort.abort(new Error(`event handler timed out after ${_handlerTimeoutMs} ms`))
      resolve()
    }, _handlerTimeoutMs)
  })
  try {
    await Promise.race([handlerSignal.run(abort.signal, () => handler(event)), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (timedOut) {
    log.error({ channel, entityId: event.entityId }, "event handler timeout")
  }
}

// Bounded retry for cross-process (Redis-path) subscriber handlers (infra-6).
// In multi-process mode, audit/timeline and other per-channel subscribers run
// from the Redis `message` callback — a transient failure there has no outbox
// behind it to replay, so without a retry the event is silently dropped. Retry a
// small bounded number of times with short backoff, then log on final failure.
// Exported for colocated tests.
export const SUBSCRIBER_RETRY_ATTEMPTS = 3
export const SUBSCRIBER_RETRY_BASE_DELAY_MS = process.env.NODE_ENV === "test" ? 1 : 50

export async function dispatchWithRetry(
  handler: (event: AppEvent) => Promise<void>,
  event: AppEvent,
  channel: string,
): Promise<void> {
  for (let attempt = 1; attempt <= SUBSCRIBER_RETRY_ATTEMPTS; attempt++) {
    try {
      await handler(event)
      return
    } catch (err) {
      if (attempt < SUBSCRIBER_RETRY_ATTEMPTS) {
        log.warn({ err, channel, attempt }, "Event subscriber handler error (Redis) — retrying")
        await new Promise((resolve) =>
          setTimeout(resolve, 2 ** (attempt - 1) * SUBSCRIBER_RETRY_BASE_DELAY_MS),
        )
      } else {
        log.error(
          { err, channel, attempts: attempt },
          "Event subscriber handler failed after retries (Redis) — event dropped for this handler",
        )
      }
    }
  }
}

// Exposed for tests: track all pending handler dispatches so tests can await completion
const _pendingDispatches = new Set<Promise<void>>()
/** Wait for all pending handler dispatches to complete — test use only */
export async function flushEventHandlers(): Promise<void> {
  await Promise.allSettled([..._pendingDispatches])
}

function channelName(app: string, entity: string, action: string): string {
  return `${REDIS_PREFIX}events:${app}:${entity}:${action}`
}

/** Reset all in-process state — for test isolation only */
export function resetEventBus(): void {
  globalHandlers.length = 0
  handlers.clear()
  declaredEmits.clear()
  localPublishedIds.clear()
  localPublishedQueue.length = 0
  _pendingDispatches.clear()
  activeDispatches = 0
  waitQueue.length = 0
  remoteSeenIds.clear()
  remoteSeenQueue.length = 0
  patternSubscription = null
  initialized = false
}

export function onEvent(handler: EventHandler, opts: EventHandlerOptions): void {
  globalHandlers.push({ fn: handler, delivery: opts.delivery, name: opts.name })
  // A per-replica global handler must see every peer's publication, not only
  // those on channels this process subscribed with `subscribeToEvent`. A once
  // handler never runs on a peer's copy, so it needs no subscription.
  if (opts.delivery === "per-replica") ensureEventPatternSubscription()
}

/**
 * The one pattern subscription covering every events channel of this
 * deployment (REDIS_PREFIX-scoped, glob characters escaped). Held while any
 * per-replica `onEvent` handler exists: every process then receives every
 * event and filters locally, the documented cell design (each event costs one
 * delivery per subscribed process). A channel also subscribed explicitly
 * arrives twice (`message` and `pmessage`); `onRemoteMessage` dedupes by
 * `_msgId`.
 */
const EVENTS_PATTERN = `${REDIS_PREFIX.replace(/[\\*?[\]]/g, "\\$&")}events:*`
let patternSubscription: Promise<void> | null = null

function ensureEventPatternSubscription(): void {
  if (patternSubscription) return
  patternSubscription = redisSub
    .psubscribe(EVENTS_PATTERN)
    .then(() => {
      log.debug({ pattern: EVENTS_PATTERN }, "Subscribed to the events pattern")
    })
    .catch((err: unknown) => {
      // Fail loud and let the next per-replica registration retry.
      log.error({ err, pattern: EVENTS_PATTERN }, "Failed to subscribe to the events pattern")
      patternSubscription = null
    })
}

export function _getGlobalHandlerCount(): number {
  return globalHandlers.length
}

async function publishToRedis(channel: string, payload: string, retries = 3): Promise<boolean> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await redis.publish(channel, payload)
      return true
    } catch (err) {
      if (attempt < retries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 100))
      } else {
        log.error({ err, channel, attempt }, "Failed to publish event after retries")
        return false
      }
    }
  }
  return false
}

/**
 * Publish an event via Redis pub/sub and dispatch to in-process handlers.
 * INTERNAL — only the outbox worker and broadcastEphemeral should call this.
 * All durable events must go through tx.queueEvent() → outbox → here.
 */
/**
 * Assign the WS replay sequence id exactly once per stored event (single-writer
 * invariant). The OUTBOX WORKER calls this at claim time — BEFORE durable
 * consumers run — because the durable `ws-fanout` consumer (phase 2a) must
 * buffer + broadcast with the id, and `_publishEventInternal` (phase 2b) then
 * reuses the same id so remote replicas broadcast exactly the id the
 * originator buffered. Mutates `event._wsEventId` in place. No-op for
 * ephemeral events (never buffered/replayed) and events already carrying an id
 * (at-least-once retries within one attempt reuse it; a fresh outbox retry
 * builds a fresh event object and gets a fresh id, which clients dedup by
 * entity-level idempotency exactly as before).
 */
export async function assignWsReplayId(event: AppEvent): Promise<void> {
  if (event.ephemeral || event._wsEventId !== undefined) return
  try {
    event._wsEventId = await redis.incr(event.orgId ? `ws:seq:${event.orgId}` : "ws:seq:global")
  } catch (err) {
    log.warn(
      { err, app: event.app, entity: event.entity },
      "WS replay seq increment failed — broadcasting without a replay id",
    )
  }
}

export async function _publishEventInternal(event: AppEvent): Promise<void> {
  const { app, entity, action } = event

  // Validate against declared emits (if app has declared emits).
  // Try org-scoped key first (non-kernel apps), then bare name (kernel).
  const appEmits =
    declaredEmits.get(app) ??
    (event.orgId ? declaredEmits.get(`${event.orgId}:${app}`) : undefined) ??
    declaredEmits.get(`*:${app}`)
  if (appEmits && !appEmits.has(`${entity}:${action}`)) {
    throw new Error(`App "${app}" did not declare event type "${entity}:${action}" in emits`)
  }

  // An org moving to another instance takes none of its handlers now: the
  // event is deferred, not dropped (EventDeferredError). Otherwise its
  // handlers count as the org's live writes until the dispatch settles.
  const endOrgWork = event.orgId ? await beginOrgEventWork(event.orgId) : () => {}
  try {
    await publishCounted(event, endOrgWork)
  } catch (err) {
    // Nothing was dispatched: the org's count must not stay up (every move of
    // the org would then wait at its quiesce until this process restarts).
    endOrgWork()
    throw err
  }
}

/** The rest of `_publishEventInternal`, once the org's work is counted (ended by the dispatch). */
async function publishCounted(event: AppEvent, endOrgWork: () => void): Promise<void> {
  const { app, entity, action } = event
  const channel = channelName(app, entity, action)
  const msgId = crypto.randomUUID()
  // Process-local dedup: track this msgId so the Redis subscriber skips it
  trackLocalPublish(msgId)

  // Ensure the WS replay id exists. The outbox worker normally assigns it via
  // `assignWsReplayId` BEFORE running durable consumers (phase 2a), because the
  // durable `ws-fanout` consumer needs the id to buffer + broadcast — this call
  // is then a no-op reuse. It only assigns here for non-outbox callers (tests,
  // legacy direct publishes) so those still broadcast a replayable id.
  await assignWsReplayId(event)
  const wsEventId = event._wsEventId
  const stamped = {
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
    ...(wsEventId !== undefined ? { _wsEventId: wsEventId } : {}),
  }

  if (process.env.CHAOS_DEBUG === "1" && process.env.RUN_ID) {
    const chaosChannel = `${REDIS_PREFIX}chaos:${process.env.RUN_ID}:events`
    try {
      await redis.publish(chaosChannel, JSON.stringify({ ...stamped, _eventId: msgId }))
    } catch (err) {
      log.warn({ err, chaosChannel }, "Chaos debug publish failed")
    }
  }

  const published = await publishToRedis(channel, JSON.stringify({ ...stamped, _msgId: msgId }))
  if (published) {
    log.debug({ channel, entityId: event.entityId }, "Event published")
  } else {
    log.error({ channel }, "Event publish failed — durable events will be retried by outbox worker")
  }

  // Dispatch to global and per-channel handlers asynchronously.
  // This prevents audit/timeline/websocket handlers from blocking the request path.
  // Snapshot handler arrays at publish time so concurrent resetEventBus() calls
  // don't clear them before the async dispatch executes.
  const snapshotGlobal = [...globalHandlers]
  let channelHandlers = [...(handlers.get(channel) ?? [])]
  const dispatchHandlers = async () => {
    // A `once` handler acts for the event's org (routines, app subscriptions):
    // boot registers no org, so the org is set up here first (H3). Free for an
    // org this process registered; a failure is logged and dispatch goes on.
    if (
      event.orgId &&
      (snapshotGlobal.some((e) => e.delivery === "once") ||
        channelHandlers.some((e) => e.delivery === "once"))
    ) {
      try {
        await ensureEventOrg(event.orgId)
        // The org's setup subscribes its apps' handlers to this channel: read
        // the list again, or the event that set the org up would miss them.
        const current = handlers.get(channel)
        if (current) channelHandlers = [...current]
      } catch (err) {
        log.error({ err, orgId: event.orgId, channel }, "Org setup before event dispatch failed")
      }
    }
    for (const entry of snapshotGlobal) {
      const handler = entry.fn
      await noteOnceCall(entry, stamped)
      try {
        await runHandlerWithTimeout(handler, stamped, channel)
      } catch (err) {
        log.error({ err, channel }, "Global event handler error, retrying once")
        try {
          await runHandlerWithTimeout(handler, stamped, channel)
        } catch (retryErr) {
          log.error({ err: retryErr, channel }, "Global event handler retry failed")
        }
      }
    }
    // Per-channel handlers — one retry on failure (matching global handler behavior)
    for (const entry of channelHandlers) {
      const handler = entry.fn
      await noteOnceCall(entry, stamped)
      try {
        await runHandlerWithTimeout(handler, stamped, channel)
      } catch (err) {
        log.error({ err, channel }, "Per-channel handler failed — retrying once")
        try {
          await runHandlerWithTimeout(handler, stamped, channel)
        } catch (retryErr) {
          log.error({ err: retryErr, channel }, "Per-channel handler retry failed")
        }
      }
    }
  }
  // Fire-and-forget: handlers run in the background after Redis publish succeeds.
  // Bounded by semaphore to prevent unbounded parallelism. This is the durable
  // (outbox) path — `event.ephemeral` is always false/undefined here — so this
  // dispatch is never a drop-eviction candidate; a dropped waiter can only be
  // an ephemeral one (see acquireDispatchSlot).
  let dispatchPromise!: Promise<void>
  dispatchPromise = (async () => {
    const acquired = await acquireDispatchSlot(false)
    if (!acquired) {
      // Never expected on the durable path (only ephemeral waiters are
      // eviction candidates), but guard defensively rather than proceed
      // without a slot.
      log.error({ channel }, "Durable dispatch waiter was dropped unexpectedly")
      endOrgWork()
      _pendingDispatches.delete(dispatchPromise)
      return
    }
    try {
      await dispatchHandlers()
    } catch (err) {
      log.error({ err, channel }, "Handler dispatch failed")
    } finally {
      endOrgWork()
      releaseDispatchSlot()
      _pendingDispatches.delete(dispatchPromise)
    }
  })()
  _pendingDispatches.add(dispatchPromise)
}

/**
 * Broadcast an ephemeral event (typing, presence) without writing to the outbox.
 * Ephemeral events are delivered via WebSocket but NOT persisted in audit/timeline.
 * They are NOT replayed on reconnect (no Redis buffer).
 */
export async function broadcastEphemeral(event: Omit<AppEvent, "ephemeral">): Promise<void> {
  const stamped: AppEvent = {
    ...event,
    ephemeral: true,
    timestamp: event.timestamp ?? new Date().toISOString(),
  }

  const { app, entity, action } = stamped
  const channel = channelName(app, entity, action)
  const msgId = crypto.randomUUID()
  trackLocalPublish(msgId)

  await publishToRedis(channel, JSON.stringify({ ...stamped, _msgId: msgId }))

  // Dispatch only to global handlers (WebSocket fan-out) — skip per-channel handlers
  // since ephemeral events don't go through audit/timeline.
  // Bounded by semaphore to prevent unbounded parallelism.
  const snapshotGlobal = [...globalHandlers]
  let dispatchPromise!: Promise<void>
  dispatchPromise = (async () => {
    // Ephemeral: eligible for drop-oldest eviction when the wait queue is at
    // cap (no outbox behind this event, so skipping it once is safe).
    const acquired = await acquireDispatchSlot(true)
    if (!acquired) {
      log.error({ channel }, "Ephemeral dispatch dropped — wait queue was at capacity")
      _pendingDispatches.delete(dispatchPromise)
      return
    }
    try {
      for (const entry of snapshotGlobal) {
        await noteOnceCall(entry, stamped)
        try {
          await runHandlerWithTimeout(entry.fn, stamped, channel)
        } catch (err) {
          log.error({ err, channel }, "Ephemeral event handler error")
        }
      }
    } catch (err) {
      log.error({ err, channel }, "Ephemeral dispatch failed")
    } finally {
      releaseDispatchSlot()
      _pendingDispatches.delete(dispatchPromise)
    }
  })()
  _pendingDispatches.add(dispatchPromise)
}

/**
 * A disposer returned by {@link subscribeToEvent}. Calling it removes the
 * handler from the in-process channel map and, when no handlers remain on that
 * channel, unsubscribes the Redis subscriber. Idempotent — calling twice is a
 * no-op. Used by app registration rollback and uninstall to tear down the
 * subscriptions an app registered, so a reinstall does not stack duplicate
 * handlers (Phase 16 cluster 5 lifecycle fix).
 */
export type EventSubscriptionDisposer = () => Promise<void>

export async function subscribeToEvent(
  app: string,
  entity: string,
  action: string,
  handler: EventHandler,
  opts: EventHandlerOptions,
): Promise<EventSubscriptionDisposer> {
  const channel = channelName(app, entity, action)

  const entry: RegisteredHandler = { fn: handler, delivery: opts.delivery, name: opts.name }
  const existing = handlers.get(channel) ?? []
  existing.push(entry)
  handlers.set(channel, existing)

  // Subscribe via Redis for cross-process delivery
  await redisSub.subscribe(channel)

  log.debug({ channel }, "Subscribed to event channel")

  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    const current = handlers.get(channel)
    if (!current) return
    const idx = current.indexOf(entry)
    if (idx !== -1) current.splice(idx, 1)
    if (current.length === 0) {
      handlers.delete(channel)
      // No in-process handlers remain on this channel — drop the Redis
      // subscription so we stop receiving cross-process deliveries for it.
      try {
        await redisSub.unsubscribe(channel)
      } catch (err) {
        log.warn({ err, channel }, "Failed to unsubscribe from event channel")
      }
    }
    log.debug({ channel }, "Unsubscribed handler from event channel")
  }
}

/**
 * The AUTHORITATIVE set of event types the kernel emits — the single source of
 * truth. `initEventBus` registers it under both `"kernel"` (bare, read by
 * assertKernelEventDeclared + the publish path) and `"*:kernel"` (the
 * global-org key the routine-event catalog reads). `initAppsForOrg` re-asserts
 * the SAME set under `"*:kernel"` so a per-org runtime init (which may run
 * without initEventBus in tests) still exposes the full catalog rather than a
 * partial hand-maintained slice. Exported so both call sites import ONE list
 * and can never drift (a kernel event added here is instantly subscribable by
 * kind:'event' routines).
 */
export const KERNEL_DECLARED_EMITS: ReadonlySet<string> = new Set([
  // A feature inside an app switched on or off (modules/apps/org-features.ts): the
  // catalog changed, so live MCP sessions are told (modules/mcp/catalog-notifier.ts).
  "app:feature_update",
  "user:registered",
  "user:deactivate",
  "user:reactivate",
  "user:updated",
  // An import placeholder linked to its real person (modules/users/merge-placeholder.ts).
  "user:merge",
  // A per-user state change sent from inside a transaction the writer does not
  // own (read-state-broadcast.ts queueReadState); the socket fan-out delivers
  // it to that user's own devices only.
  "read_state:update",
  "auth:login",
  "auth:login_fail",
  "auth:logout",
  "auth:totp_verify",
  "auth:password_reset",
  "auth:password_change",
  "device_flow:approve",
  "device_flow:deny",
  "invitation:create",
  "thread:create",
  "thread:update",
  "message:create",
  "message:update",
  "message:delete",
  "participant:add",
  "participant:remove",
  "reaction:add",
  "reaction:remove",
  "reference:add",
  "typing:start",
  "typing:stop",
  "agent_stream:start",
  "agent_stream:delta",
  "agent_stream:reasoning",
  "agent_stream:tool_call",
  "agent_stream:tool_result",
  "agent_stream:done",
  "agent_stream:error",
  // F2 — durable terminal transitions. Non-terminal sub_run/routine deltas
  // (queued -> running, routine:status) stay EPHEMERAL (broadcastEphemeral,
  // which skips declaredEmits). Only the terminal/durable transitions ride
  // the outbox and so must be declared here, or tx.queueEvent throws at
  // assertKernelEventDeclared:
  //   - sub_run:update terminal states (done|failed|cancelled)
  //   - routine:run_completed
  // (thread:update — the auto-title update — is already declared below.)
  "sub_run:update",
  "routine:run_completed",
  // A routine was created (by hand or from a template). Ids and shape only, never
  // the name or prompt (skills-routines-tools.ts queueRoutineCreated).
  "routine:create",
  // A routine's enabled flag changed (routines PUT route). Ids and the flag
  // only, like routine:create; a guided tour can complete on it.
  "routine:update",
  // A node session was created (node-sessions/store.ts createSessionForJob): the
  // live row without its prompt, owner-only on the socket (OWNER_ONLY_NODE_ENTITIES).
  // Its later changes stay ephemeral (fanOut).
  "node_session:create",
  // A step of a demo org's recorded (replayed) node session that a guided tour
  // completes on, e.g. the owner approving its permission request. Owner-only
  // on the socket, like the node session itself; every other change of a
  // session stays ephemeral.
  "node_session:replay_step",
  // A guided tour started for a user (CLI, help menu, deep link) or moved on
  // (a beat completed, skipped, paused, resumed, finished). Owner-only on the
  // socket; the frame tells the owner's tabs to refetch progress
  // (modules/tours).
  "tour:start",
  "tour:update",
  // A security signal for an org (modules/security/security-events.ts): the
  // attention translator alerts its admins. Socket frames go to org admins only
  // (websocket.ts).
  "security_event:create",
  "credit:usage",
  "credit:low_balance",
  "contact:create",
  "contact:update",
  "contact:delete",
  "contact:merge",
  "contact:share",
  // A company was created, edited, merged into another or closed (the relationship ended).
  "company:create",
  "company:update",
  "company:merge",
  "company:closed",
  // A company's general access or grants changed (modules/contacts/companies.ts).
  "company:share",
  // A company was deleted: its search document and open rows go.
  "company:delete",
  "presence:update",
  "org:update",
  // One field of an app's declarative settings page written (modules/apps/settings-routes.ts).
  "app_setting:updated",
  "role:create",
  "role:update",
  "role:delete",
  "role_scope:grant",
  "role_scope:revoke",
  "role_dimension:grant",
  "role_dimension:revoke",
  "role_assignment:assign",
  "role_assignment:unassign",
  "user_scope:grant",
  "user_scope:revoke",
  // An app turned On/Off, removed or restricted in the workspace: every member's
  // effective scopes may change (modules/apps/org-app-service.ts).
  "user_scope:org_app",
  // Who may use an organization MCP server changed, or a server was added or deleted:
  // every member's `mcp:<slug>` may change (afterOrgAccessChange, org-app-service.ts).
  "user_scope:access",
  "user_dimension:grant",
  "user_dimension:revoke",
  "auth:totp_enable",
  "auth:totp_disable",
  "connected_account:create",
  "connected_account:disconnect",
  // A personal connect refused because another owner holds the account
  // (connections/service.ts announceConnectRefused): an alert to that person.
  "connected_account:refuse",
  "file:create",
  "file:delete",
  "agent_notification:create",
  // S17: an agent tool changed the user's own notification settings. Audited
  // with the before/after diff and announced in the feed (system_alert).
  "notification_settings:update",
  "approval_request:create",
  "approval_request:update",
  "scope_request:create",
  "scope_request:update",
  // A secret card filed, saved, cancelled or expired (modules/secret-requests).
  "secret_request:create",
  "secret_request:update",
  // An import run was created or changed status (modules/imports/runs.ts): its
  // id and status only. Its progress between batches is ephemeral.
  "import_run:create",
  "import_run:update",
  "saved_view:created",
  "saved_view:updated",
  "saved_view:deleted",
  // Dashboards (modules/dashboards/service.ts): ids and visibility only, scoped per viewer.
  "dashboard:created",
  "dashboard:updated",
  "dashboard:deleted",
  // Dashboard tables (modules/dashboards/tables/service.ts): ids, changed keys and the audience,
  // never a cell or a name. Row events are routine triggers (filter {tableId, column?, to?}).
  "dashboard_table:created",
  "dashboard_table:updated",
  "dashboard_table:deleted",
  "dashboard_table_row:created",
  "dashboard_table_row:updated",
  "dashboard_table_row:deleted",
  // Module H — market-intelligence web-watch: `web_watch` queues this to the
  // outbox (not ephemeral) when a watched source's normalized extraction
  // changes across ticks, so downstream subscribers (timeline/notifications)
  // see the diff. Must be declared here or the outbox insert throws at
  // assertKernelEventDeclared and the diff event is silently dead-lettered.
  "routine_watch:changed",
  // Staff marked or unmarked a trusted sender (modules/contacts/trusted-senders.ts). Audited
  // through the outbox; undeclared, every "Trust this sender" click failed with a 500.
  "trusted_sender:create",
  "trusted_sender:delete",
  // An org export started from Settings finished: the attention translator tells
  // the admin who asked (modules/export/org-archive/store.ts completeOrgExport).
  "org_export:complete",
  // An org cap crossed 80 % or 100 %: the attention translator tells the org
  // admins (modules/org/caps.ts emitCapNotice).
  "org_cap:threshold",
  // An org moved to this instance and its MCP connections were revoked: the
  // attention translator tells the org admins (modules/org/transfer/after-commit.ts).
  "org_move:reconnect",
  // A bug report sent only to the Liaison team ended undelivered: the attention
  // translator tells the org admins (modules/liaison-team/team-only.ts).
  "liaison_team_forward:undelivered",
])

// Initialize message handler (call once at startup)
let initialized = false
export function initEventBus(): void {
  if (initialized) return
  initialized = true

  // Register kernel's known event types (typos in kernel event publishing are
  // caught by assertKernelEventDeclared) under BOTH keys:
  //  - bare "kernel": read directly by assertKernelEventDeclared
  //    (db/queue-event.ts) and the publish path's primary lookup.
  //  - "*:kernel" (the global-org key that setDeclaredEmits("*","kernel")
  //    produces): read by the routine-event catalog — getDeclaredEmits("*",
  //    "kernel") + getAllDeclaredEmits — which powers list_routine_events and
  //    validateRoutineEvent. Without this second key, kind:'event' routines on
  //    ANY kernel event (contact:create, message:create, …) were rejected as
  //    "No in-tree event exists". One shared Set reference, so the two keys can
  //    never drift.
  const kernelEmits = new Set(KERNEL_DECLARED_EMITS)
  declaredEmits.set("kernel", kernelEmits)
  declaredEmits.set("*:kernel", kernelEmits)

  redisSub.on("message", onRemoteMessage)
  // Re-init (tests) must not stack a second pattern listener.
  redisSub.off("pmessage", onPatternMessage)
  redisSub.on("pmessage", onPatternMessage)
}

function onPatternMessage(_pattern: string, channel: string, message: string): void {
  onRemoteMessage(channel, message)
}

/** A message on an events channel, from the explicit or the pattern subscription. */
function onRemoteMessage(channel: string, message: string): void {
  // The subscriber connection also carries other modules' channels (auth-cache
  // invalidation); only events channels are bus messages.
  if (!channel.startsWith(`${REDIS_PREFIX}events:`)) return
  let parsed: any
  try {
    parsed = JSON.parse(message)
  } catch {
    log.error({ channel, message }, "Failed to parse event message")
    return
  }
  // Process-local dedup: skip messages we published (already dispatched in publishEvent)
  if (parsed._msgId && localPublishedIds.has(parsed._msgId)) {
    return
  }
  // A channel subscribed explicitly and through the pattern arrives twice.
  if (parsed._msgId && !firstRemoteSighting(parsed._msgId)) {
    return
  }

  const event: AppEvent = parsed
  // Arrived from another process — the WS fan-out broadcasts to this process's
  // local connections but must NOT re-write the replay buffer (the originating
  // process is the single writer).
  event._remote = true

  // Only per-replica handlers run on a peer's copy (A5): a once handler
  // already ran in the publishing process.
  // Dispatch with backpressure — same semaphore as local publish path
  const snapshotGlobal = perReplicaOnly(globalHandlers)
  const channelHandlers = perReplicaOnly(handlers.get(channel) ?? [])
  let dispatchPromise!: Promise<void>
  dispatchPromise = (async () => {
    const acquired = await acquireDispatchSlot(event.ephemeral === true)
    if (!acquired) {
      log.error(
        { channel },
        "Redis-path dispatch dropped — wait queue was at capacity (ephemeral event)",
      )
      _pendingDispatches.delete(dispatchPromise)
      return
    }
    try {
      for (const { fn: handler } of snapshotGlobal) {
        try {
          await runHandlerWithTimeout(handler, event, channel)
        } catch (err) {
          log.error({ err, channel }, "Global event handler error (Redis), retrying once")
          try {
            await runHandlerWithTimeout(handler, event, channel)
          } catch (retryErr) {
            log.error({ err: retryErr, channel }, "Global event handler retry failed (Redis)")
          }
        }
      }
      for (const { fn: handler } of channelHandlers) {
        // Bounded retry (infra-6): no outbox replays the Redis-path delivery,
        // so a transient subscriber failure must be retried in-place or the
        // audit/timeline event is lost in multi-process mode.
        await dispatchWithRetry(handler, event, channel)
      }
    } finally {
      releaseDispatchSlot()
      _pendingDispatches.delete(dispatchPromise)
    }
  })()
  _pendingDispatches.add(dispatchPromise)
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const EventBusTestAccess = {
  /** Replace the org setup a `once` dispatch awaits; `undefined` restores `awaitOrgApps`. */
  setEnsureEventOrg(fn: ((orgId: string) => Promise<void>) | undefined): void {
    ensureEventOrg = fn ?? defaultEnsureEventOrg
  },
  /** Test-only: returns whether `id` is currently tracked in the ring buffer. */
  hasLocalPublished(id: string): boolean {
    return localPublishedIds.has(id)
  },
  /** Test-only: returns the current size of the ring buffer. */
  localPublishedIdsSize(): number {
    return localPublishedIds.size
  },
  /** Test-only — override the wait-queue cap so eviction can be exercised without 10k waiters. */
  setDispatchWaitQueueCap(cap: number | null): void {
    _waitQueueCap = cap ?? MAX_DISPATCH_WAIT_QUEUE
  },
  /** Test-only — override the handler dispatch timeout so the wedge case can be exercised without waiting 60s. */
  setHandlerTimeoutMs(ms: number | null): void {
    _handlerTimeoutMs = ms ?? HANDLER_TIMEOUT_MS
  },
  /**
   * Test-only: returns the current number of waiters parked behind the
   * concurrency cap.
   */
  dispatchWaitQueueLength(): number {
    return waitQueue.length
  },
  /**
   * Test-only: drop every global (`onEvent`) handler registered after the first
   * `count`, so a test that ran the real `registerEventSubscribers` leaves the
   * process's handler list as it found it.
   */
  truncateGlobalHandlers(count: number): void {
    globalHandlers.length = Math.min(globalHandlers.length, count)
  },
  /** Test-only: how many handlers registered under `name` are live, across every channel. */
  handlerCount(name: string): number {
    let n = 0
    for (const list of handlers.values()) for (const h of list) if (h.name === name) n++
    return n
  },
}
