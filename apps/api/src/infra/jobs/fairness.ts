// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-org fairness on job queues (A7).
//
// THE CELL'S SLOTS (C). Each job host publishes the worker slots it runs per
// queue in its instance record (instance-registry.ts `jobSlots`) while its
// workers run, and none once it stops fetching. C for a queue is the sum over
// live records, read at most every 5 s per process, and never less than this
// process's own slots (a host before its first beat). A read error falls back
// to this process's own slots: fairness fails open.
//
// STAGE 1, AT ENQUEUE: TURNS. BullMQ OSS has no groups, but it serves its
// prioritized set by number, lowest first and FIFO within a number. An
// org-scoped job is enqueued with priority TIER[class priority] + 1 + d, d =
// the org's not-yet-admitted jobs on the queue due no later than it. Every
// org's first job gets TIER + 1, so a quiet org's job runs before a flooding
// org's second. The tiers keep the class order (an unprioritized-class job
// before any YIELD job), and orgless unprioritized jobs keep priority 0 (the
// wait list, served first of all). Bookkeeping: `fair:q:<queue>:<org>` (job id
// -> due time) and `fair:orgs:<queue>` (org -> its earliest due time).
//
// STAGE 2, AT DISPATCH: A CAP ONLY UNDER CONTENTION. One Lua script per
// fetched org job. While another org has due work waiting, an org holds at
// most ceil(C/2) tokens on the queue; alone, it may use all C. Over the limit
// the job is parked (`fair:park:<queue>:<org>`) and delayed by U[0, B), B set
// by the org's parked count; a release by the same org promotes its oldest
// parked job at once, so the timer is only a safety net. Tokens
// (`fair:tok:<queue>:<org>`, member `<jobId>|<lockToken>`) expire after 60 s
// unless renewed every 20 s, so a SIGKILLed process leaks a token for at most
// the TTL.
//
// TRUSTED NESTING. A job enqueued from inside an admitted job of the same org
// and queue, whose name is in NESTED_AWAITED_JOBS (its parent waits in-slot for
// it), gets a server-minted `n.<uuid>` id recorded in `fair:nested` before the
// add, and passes the cap up to cap x MAX_NESTING_DEPTH nested tokens. No job
// data feeds that decision.
//
// FAIL OPEN. Any Redis error, or no answer in 250 ms, admits the job (logged,
// counted): no gate is the behaviour before it. `JOB_ORG_FAIRNESS=off` skips
// both stages.

import crypto from "node:crypto"
import type { Job, JobsOptions, Queue } from "bullmq"
import {
  LIVE_INSTANCE_KEY,
  LIVE_INSTANCES_SET,
  setInstanceJobSlots,
} from "~/infra/instance-registry"
import { boundedBy } from "~/lib/bounded"
import { env } from "~/lib/env"
import { isLoadOrg } from "~/lib/load-harness"
import { jobsLogger as log } from "~/lib/logger"
import { bullPrefix, REDIS_PREFIX, redis } from "~/lib/redis"
import { currentJobFairFrame } from "./job-origin"
import { planOrgJobDelay } from "./org-job-cap"
import { KERNEL_QUEUE_CLASSES, kernelQueueClassOf, LEGACY_KERNEL_QUEUE } from "./queue-classes"

/** Where the instance records are read (the shared client and set, or a test's). */
export interface CellSlotsSource {
  client: {
    smembers(key: string): Promise<string[]>
    mget(...keys: string[]): Promise<Array<string | null>>
  }
  setKey: string
}

const defaultSlotsSource = (): CellSlotsSource => ({ client: redis, setKey: LIVE_INSTANCES_SET })

/** Sum of the job slots every live instance publishes, per queue. */
export async function readCellJobSlots(
  src: CellSlotsSource = defaultSlotsSource(),
): Promise<Record<string, number>> {
  return (await readCellSlots(src)).slots
}

/** Default worker slots of a job host that publishes none: its class's, or an app queue's. */
export function defaultQueueSlots(queue: string): number {
  const cls = kernelQueueClassOf(queue)
  return cls ? KERNEL_QUEUE_CLASSES[cls].concurrency : DEFAULT_APP_QUEUE_SLOTS
}

/** The published slots per queue, and the live job hosts that publish none. */
async function readCellSlots(
  src: CellSlotsSource,
): Promise<{ slots: Record<string, number>; legacyHosts: number }> {
  const ids = await src.client.smembers(src.setKey)
  const out: Record<string, number> = {}
  let legacyHosts = 0
  if (ids.length === 0) return { slots: out, legacyHosts }
  const raws = await src.client.mget(...ids.map((id) => LIVE_INSTANCE_KEY(id)))
  for (const raw of raws) {
    // No record: the instance is dead (its record expired), so it runs nothing.
    if (!raw) continue
    let rec: { jobSlots?: unknown; role?: unknown }
    try {
      rec = JSON.parse(raw) as { jobSlots?: unknown; role?: unknown }
    } catch {
      continue
    }
    const slots = rec.jobSlots
    if (slots === undefined) {
      // A job host of a release from before the slots were published (a
      // rolling deploy's overlap): counted with the default slots per queue.
      if (rec.role === "all" || rec.role === "worker") legacyHosts++
      continue
    }
    if (!slots || typeof slots !== "object") continue
    for (const [queue, n] of Object.entries(slots as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isFinite(n) && n > 0) out[queue] = (out[queue] ?? 0) + n
    }
  }
  return { slots: out, legacyHosts }
}

/** This process's own worker slots per queue (set by jobs.ts as its workers run or stop). */
let localSlots: Record<string, number> = {}
let slotsSource: CellSlotsSource | undefined
const CELL_SLOTS_CACHE_MS = 5_000
/** An app queue's worker slots when its registration names none (jobs.ts). */
const DEFAULT_APP_QUEUE_SLOTS = 5
let cellSlotsCache: { at: number; slots: Record<string, number>; legacyHosts: number } | undefined

/** Publish this process's worker slots (an empty map: it runs none now). */
export function setLocalJobSlots(slots: Record<string, number>): void {
  localSlots = { ...slots }
  setInstanceJobSlots(localSlots)
}

/** C: the cell's worker slots on `queue`, at least this process's own. */
export async function cellQueueConcurrency(queue: string): Promise<number> {
  const own = localSlots[queue] ?? 0
  const now = Date.now()
  if (!cellSlotsCache || now - cellSlotsCache.at >= CELL_SLOTS_CACHE_MS) {
    try {
      cellSlotsCache = { at: now, ...(await readCellSlots(slotsSource ?? defaultSlotsSource())) }
    } catch (err) {
      log.warn(
        { err, queue },
        "fairness: could not read the cell's job slots; using this process's",
      )
      return Math.max(1, own)
    }
  }
  const published = cellSlotsCache.slots[queue] ?? 0
  const legacy = cellSlotsCache.legacyHosts * defaultQueueSlots(queue)
  return Math.max(1, own, published + legacy)
}

// --- Shared definitions ----------------------------------------------------

/** Tier start per class priority (queue-classes.ts uses 0, 5 and 10). */
export const FAIR_TIER: Readonly<Record<0 | 5 | 10, number>> = { 0: 2, 5: 2 ** 19, 10: 2 ** 20 }
/** BullMQ's highest priority number (job.js PRIORITY_LIMIT). */
const PRIORITY_LIMIT = 2 ** 21 - 1
/** A nested child's priority: before every org's turn-ordered job. */
export const NESTED_PRIORITY = 1
/** Kernel jobs whose enqueuer waits in its worker slot for them (spawn-agent.ts). */
export const NESTED_AWAITED_JOBS: ReadonlySet<string> = new Set(["agent-subrun"])
/** spawn-agent.ts MAX_NESTING_DEPTH: nested tokens per org are bounded by cap x this. */
const NESTED_DEPTH_FACTOR = 2
const TOKEN_TTL_MS = 60_000
const RENEW_EVERY_MS = 20_000
const QUEUE_KEY_TTL_MS = 15 * 60_000
const NESTED_MINT_TTL_MS = 15 * 60_000
const GATE_TIMEOUT_MS = 250
const PARK_MIN_MS = 500
const PARK_MAX_MS = 60_000
const PARK_PER_JOB_MS = 20
const FAILOPEN_DEGRADED_MS = 5 * 60_000

const qKey = (queue: string, orgId: string) => `fair:q:${queue}:${orgId}`
const orgsKey = (queue: string) => `fair:orgs:${queue}`
const tokKey = (queue: string, orgId: string) => `fair:tok:${queue}:${orgId}`
const ntokKey = (queue: string, orgId: string) => `fair:ntok:${queue}:${orgId}`
const parkKey = (queue: string, orgId: string) => `fair:park:${queue}:${orgId}`
const nestedKey = (queue: string, orgId: string) => `fair:nested:${queue}:${orgId}`
/** Fairness counters of one queue (cell-wide; /diag reads them). */
export const fairMetricsKey = (queue: string) => `jobs:metrics:${queue}`
/** Job-wait histogram of one queue for one minute (`yyyymmddhhmm`, UTC). */
export const waitHistogramKey = (queue: string, minute: string, orgId?: string) =>
  orgId ? `jobs:wait:${queue}:${orgId}:${minute}` : `jobs:wait:${queue}:${minute}`
/**
 * Bucket upper bounds (ms) of the wait histograms; the last bucket is +Inf. A
 * p95 is read as its bucket's top, so the buckets are fine below the 5 s that
 * the fairness bound is judged at: a p95 under 4.5 s reads under 5 s.
 */
export const WAIT_BUCKETS_MS = [
  100, 250, 500, 1_000, 2_000, 3_000, 4_000, 4_500, 5_000, 10_000, 30_000, 60_000,
] as const
const WAIT_HISTOGRAM_TTL_S = 2 * 3600
/** The p95 a histogram reports when it lies past the top bucket. */
export const WAIT_P95_ABOVE_TOP_MS = 60_001

let enabledOverride: boolean | undefined
/** Trusted nesting on (a test turns it off to prove a chain needs it). */
let nestedMinting = true
/** The load-org flag reader for the per-org histogram (a test's, or the harness's). */
let loadOrgCheck: (orgId: string) => Promise<boolean> = isLoadOrg
/** Both stages run unless the operator turned them off (`JOB_ORG_FAIRNESS=off`). */
export function fairnessEnabled(): boolean {
  return enabledOverride ?? env.JOB_ORG_FAIRNESS !== "off"
}

/** The queues the gate applies to: the kernel class queues and every app queue but the legacy drain. */
export function isFairQueue(queueName: string): boolean {
  if (queueName === LEGACY_KERNEL_QUEUE) return false
  return kernelQueueClassOf(queueName) !== undefined || queueName.startsWith("app-")
}

/** The fairness client: the shared one, or a test's. */
type FairRedis = typeof redis
let client: FairRedis = redis
let cellConcurrencyOverride: number | undefined
let tokenTtlMs = TOKEN_TTL_MS
let parkDelayOverride: number | undefined

function orgOf(data: unknown): string | undefined {
  const orgId = (data as { orgId?: unknown } | null | undefined)?.orgId
  return typeof orgId === "string" && orgId !== "" ? orgId : undefined
}

function tierStart(base: number): number {
  if (base >= 10) return FAIR_TIER[10]
  if (base >= 5) return FAIR_TIER[5]
  return FAIR_TIER[0]
}

function tierEnd(start: number): number {
  if (start === FAIR_TIER[0]) return FAIR_TIER[5] - 1
  if (start === FAIR_TIER[5]) return FAIR_TIER[10] - 1
  return PRIORITY_LIMIT
}

/**
 * The priority a scheduler's template gives the jobs it mints on `queueName`:
 * on a fair queue a class priority above 0 takes its tier start (a routine
 * tick at 5 yields to every org's waiting agent job; a YIELD cron at 10 to
 * every org job), as stage 1 gives an orgless job. 0 stays unprioritized.
 * Independent of JOB_ORG_FAIRNESS, so turning the gate off never churns
 * scheduler templates.
 */
export function schedulerPriority(queueName: string, base: number | undefined): number | undefined {
  if (!base || base <= 0) return undefined
  return isFairQueue(queueName) ? tierStart(base) : base
}

/** The priority of an org's job with `d` of its jobs ahead of it, in the tier of `base`. */
export function fairPriority(base: number, d: number): number {
  const start = tierStart(base)
  return Math.min(tierEnd(start), start + 1 + Math.max(0, d))
}

function gated<T>(p: Promise<T>, what: string): Promise<T> {
  return boundedBy(p, GATE_TIMEOUT_MS, () => new Error(`fairness: ${what} timed out`))
}

let failOpenCount = 0
let lastFailOpenAt = 0
let lastFailOpenLog = 0
function failOpen(queue: string, what: string, err: unknown): void {
  failOpenCount++
  lastFailOpenAt = Date.now()
  if (lastFailOpenAt - lastFailOpenLog > 10_000) {
    lastFailOpenLog = lastFailOpenAt
    log.warn({ err, queue, what, failOpenCount }, "fairness gate failed open")
  }
  void gated(client.hincrby(fairMetricsKey(queue), "failopen", 1), "count").catch(() => {})
  void gated(client.hset("jobs:fairness:failopen_at", queue, String(lastFailOpenAt)), "mark").catch(
    () => {},
  )
}

/** True when this process failed open in the last 5 minutes (/diag `degraded`). */
export function fairnessDegradedLocally(): boolean {
  return lastFailOpenAt > 0 && Date.now() - lastFailOpenAt < FAILOPEN_DEGRADED_MS
}

// --- Stage 1: enqueue -----------------------------------------------------

/** One job to add: its BullMQ options carry the class priority, which stage 1 replaces. */
export interface FairEntry {
  name: string
  data: unknown
  opts: JobsOptions
}

/**
 * Add jobs to one queue in turn order (stage 1). Org-scoped jobs get their
 * per-org priority and are recorded in `fair:q`; orgless ones keep priority 0
 * or their tier start. A deduplicated add records nothing. Returns BullMQ's
 * jobs, in order.
 */
export async function fairEnqueue(
  queue: Queue,
  input: ReadonlyArray<FairEntry>,
  opts: {
    /** Scheduler-made jobs (the cron fan-out): counted against the org's job
     *  cap when they start, never delayed (org-job-cap.ts). */
    scheduled?: boolean
  } = {},
): Promise<Job[]> {
  if (input.length === 0) return []
  const queueName = queue.name
  // The org's background-job cap (org-job-cap.ts): a job over it is delayed to
  // the first hour with room, never refused. Before stage 1, so the turn order
  // sees the delayed due time.
  const entries = opts.scheduled ? input : await applyOrgJobCap(queueName, input)
  if (!fairnessEnabled() || !isFairQueue(queueName)) {
    return queue.addBulk(entries.map((e) => ({ name: e.name, data: e.data, opts: e.opts })))
  }
  const now = await gateNow()
  const frame = currentJobFairFrame()
  const isKernelQueue = kernelQueueClassOf(queueName) !== undefined
  const planned = entries.map((e) => {
    const orgId = orgOf(e.data)
    const base = e.opts.priority ?? 0
    const due = now + Math.max(0, e.opts.delay ?? 0)
    const nested =
      orgId !== undefined &&
      isKernelQueue &&
      e.opts.jobId === undefined &&
      frame?.admitted === true &&
      frame.queue === queueName &&
      frame.orgId === orgId &&
      nestedMinting &&
      NESTED_AWAITED_JOBS.has(e.name)
    // An id of our own on every org job without one: a deduplicated add answers
    // with another id, so it is told apart and records nothing.
    const mintedId =
      orgId !== undefined && e.opts.jobId === undefined
        ? nested
          ? `n.${crypto.randomUUID()}`
          : crypto.randomUUID()
        : undefined
    return { e, orgId, base, due, nested, mintedId }
  })

  // d per org: its jobs not yet admitted that are due no later than the batch's first.
  const depth = new Map<string, number>()
  const orgIds = [
    ...new Set(planned.filter((p) => p.orgId && !p.nested).map((p) => p.orgId as string)),
  ]
  const nestedMints = planned.filter((p) => p.nested)
  if (orgIds.length > 0 || nestedMints.length > 0) {
    try {
      const pipe = client.pipeline()
      for (const orgId of orgIds) {
        const minDue = Math.min(...planned.filter((p) => p.orgId === orgId).map((p) => p.due))
        pipe.zcount(qKey(queueName, orgId), "-inf", minDue)
      }
      for (const p of nestedMints) {
        const key = nestedKey(queueName, p.orgId as string)
        pipe.zadd(key, now + NESTED_MINT_TTL_MS, p.mintedId as string)
        pipe.pexpire(key, NESTED_MINT_TTL_MS)
      }
      const res = await gated(pipe.exec(), "enqueue depth")
      orgIds.forEach((orgId, i) => {
        const [err, n] = res?.[i] ?? [null, 0]
        depth.set(orgId, err ? 0 : Number(n))
      })
    } catch (err) {
      failOpen(queueName, "enqueue", err)
    }
  }
  // A delayed job a `replace` deduplication will swap out: its fair:q member
  // goes with it once the new one is in.
  const replaced = await Promise.all(
    planned.map((p) => {
      const dedup = p.e.opts.deduplication
      return p.orgId && dedup?.replace
        ? queue.getDeduplicationJobId(dedup.id).catch(() => null)
        : Promise.resolve(null)
    }),
  )
  const seen = new Map<string, number>()
  const jobs = await queue.addBulk(
    planned.map((p) => {
      let priority: number | undefined
      if (p.nested) priority = NESTED_PRIORITY
      else if (p.orgId) {
        const k = seen.get(p.orgId) ?? 0
        seen.set(p.orgId, k + 1)
        priority = fairPriority(p.base, (depth.get(p.orgId) ?? 0) + k)
      } else priority = p.base > 0 ? tierStart(p.base) : undefined
      const { priority: _drop, ...rest } = p.e.opts
      return {
        name: p.e.name,
        data: p.e.data,
        opts: {
          ...rest,
          ...(p.mintedId ? { jobId: p.mintedId } : {}),
          ...(priority ? { priority } : {}),
        },
      }
    }),
  )
  // Record the org jobs that were really added.
  const added = planned
    .map((p, i) => ({ p, id: jobs[i]?.id }))
    .filter(({ p, id }) => p.orgId && id && (p.mintedId === undefined || id === p.mintedId))
  if (added.length > 0) {
    try {
      const pipe = client.pipeline()
      for (const { p, id } of added) {
        const key = qKey(queueName, p.orgId as string)
        pipe.zadd(key, "NX", p.due, id as string)
        pipe.pexpire(key, QUEUE_KEY_TTL_MS)
        pipe.zadd(orgsKey(queueName), "LT", p.due, p.orgId as string)
      }
      planned.forEach((p, i) => {
        const prev = replaced[i]
        if (prev && prev !== jobs[i]?.id) pipe.zrem(qKey(queueName, p.orgId as string), prev)
      })
      await gated(pipe.exec(), "enqueue record")
    } catch (err) {
      failOpen(queueName, "enqueue record", err)
    }
  }
  return jobs
}

/**
 * Now on the gate's clock. Stage 2 reads it from Redis TIME, so the due times
 * stage 1 records are taken from the same clock: a producer whose clock runs
 * even a millisecond ahead of Redis's would record a job enqueued with no
 * delay as due in the future, and the gate would not see the contention it
 * brings (a busy org admitted past ceil(C/2) right after another org's job
 * arrived). Without an answer from Redis, this process's clock (the rest of
 * the enqueue then fails open as before).
 */
async function gateNow(): Promise<number> {
  try {
    const [s, us] = await gated(client.time(), "time")
    return Number(s) * 1000 + Math.floor(Number(us) / 1000)
  } catch {
    return Date.now()
  }
}

/** Each entry with the delay its org's job cap gives it (unchanged when none). */
async function applyOrgJobCap(
  queueName: string,
  entries: ReadonlyArray<FairEntry>,
): Promise<ReadonlyArray<FairEntry>> {
  const now = Date.now()
  const out: FairEntry[] = []
  for (const e of entries) {
    const delay = await planOrgJobDelay({
      orgId: orgOf(e.data),
      queueName,
      jobName: e.name,
      data: e.data,
      dueMs: now + Math.max(0, e.opts.delay ?? 0),
      now,
    })
    out.push(delay === null ? e : { ...e, opts: { ...e.opts, delay } })
  }
  return out
}

/**
 * A job removed before it ran (`removeAppJob`): its turn record goes with it,
 * or its org would look busy to the gate until the key expires. Never throws.
 */
export async function forgetFairJob(
  queueName: string,
  orgId: string | undefined,
  jobId: string | undefined,
): Promise<void> {
  if (!orgId || !jobId || !isFairQueue(queueName)) return
  try {
    await gated(client.zrem(qKey(queueName, orgId), jobId), "forget")
  } catch (err) {
    log.debug({ err, queueName }, "fairness: could not forget a removed job")
  }
}

// --- Stage 2: dispatch ----------------------------------------------------

// KEYS: tok, ntok, q, orgs, park, nested, metrics.
// ARGV: prefix, queue, orgId, jobId, member, C, ttl ms, nested factor, park ttl ms,
// the queue's BullMQ job key prefix.
// Returns { 1, first admission (ZREM q), nested } or { 0, parked count, 0 }.
const ADMIT_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttl = tonumber(ARGV[7])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZSCORE', KEYS[1], ARGV[5]) or redis.call('ZSCORE', KEYS[2], ARGV[5]) then
  return { 1, 0, 0 }
end
local C = tonumber(ARGV[6])
local cap = math.max(1, math.ceil(C / 2))
local contention = 0
local others = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now, 'LIMIT', 0, 4)
for _, m in ipairs(others) do
  if m ~= ARGV[3] then
    -- The org waits only while the head of its turn record is a job still to
    -- run: one gone or finished ran ungated (failed open, an older release's
    -- worker) and is pruned, up to 3 per check; past that it still counts.
    local qk = ARGV[1] .. 'fair:q:' .. ARGV[2] .. ':' .. m
    local live = 0
    for _ = 1, 3 do
      local h = redis.call('ZRANGE', qk, 0, 0)
      if not h[1] then break end
      local jk = ARGV[10] .. h[1]
      if redis.call('EXISTS', jk) == 1 and redis.call('HEXISTS', jk, 'finishedOn') == 0 then
        live = 1
        break
      end
      redis.call('ZREM', qk, h[1])
    end
    if live == 0 and redis.call('EXISTS', qk) == 1 then live = 1 end
    if live == 1 then
      contention = 1
      break
    end
    redis.call('ZREM', KEYS[4], m)
  end
end
-- A full window of stale orgs, all pruned above, must not hide an org behind
-- it: any other org still due was never checked, so it counts as waiting.
if contention == 0 and #others == 4 then
  local rest = redis.call('ZRANGEBYSCORE', KEYS[4], '-inf', now, 'LIMIT', 0, 2)
  for _, m in ipairs(rest) do
    if m ~= ARGV[3] then
      contention = 1
      break
    end
  end
end
local limit = C
if contention == 1 then limit = cap end
local nested = 0
if string.sub(ARGV[4], 1, 2) == 'n.' then
  redis.call('ZREMRANGEBYSCORE', KEYS[6], '-inf', now)
  if redis.call('ZSCORE', KEYS[6], ARGV[4]) and redis.call('ZCARD', KEYS[2]) < cap * tonumber(ARGV[8]) then
    nested = 1
  end
end
local admitted = 0
if nested == 1 then
  redis.call('ZADD', KEYS[2], now + ttl, ARGV[5])
  redis.call('PEXPIRE', KEYS[2], ttl * 2)
  admitted = 1
elseif redis.call('ZCARD', KEYS[1]) < limit then
  redis.call('ZADD', KEYS[1], now + ttl, ARGV[5])
  redis.call('PEXPIRE', KEYS[1], ttl * 2)
  admitted = 1
end
if admitted == 1 then
  local first = redis.call('ZREM', KEYS[3], ARGV[4])
  redis.call('ZREM', KEYS[5], ARGV[4])
  local head = redis.call('ZRANGE', KEYS[3], 0, 0, 'WITHSCORES')
  if head[1] then
    redis.call('ZADD', KEYS[4], head[2], ARGV[3])
  else
    redis.call('ZREM', KEYS[4], ARGV[3])
  end
  if nested == 1 then
    redis.call('HINCRBY', KEYS[7], 'admitted_nested', 1)
  else
    redis.call('HINCRBY', KEYS[7], 'admitted', 1)
  end
  return { 1, first, nested }
end
local due = redis.call('ZSCORE', KEYS[3], ARGV[4]) or now
redis.call('ZADD', KEYS[5], due, ARGV[4])
redis.call('PEXPIRE', KEYS[5], tonumber(ARGV[9]))
redis.call('HINCRBY', KEYS[7], 'denied', 1)
return { 0, redis.call('ZCARD', KEYS[5]), 0 }
`

// KEYS: tok, ntok, park. ARGV: member. Returns the oldest parked job id to
// promote ("" when none), or false when the member held no token.
const RELEASE_LUA = `
local r = redis.call('ZREM', KEYS[1], ARGV[1]) + redis.call('ZREM', KEYS[2], ARGV[1])
if r == 0 then return false end
local p = redis.call('ZPOPMIN', KEYS[3], 1)
if p[1] then return p[1] end
return ''
`

// KEYS: tok, ntok. ARGV: ttl ms, members... Extends only tokens still held.
const RENEW_LUA = `
local t = redis.call('TIME')
local exp = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000) + tonumber(ARGV[1])
for i = 2, #ARGV do
  redis.call('ZADD', KEYS[1], 'XX', exp, ARGV[i])
  redis.call('ZADD', KEYS[2], 'XX', exp, ARGV[i])
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) * 2)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[1]) * 2)
return 1
`

/** The verdict of stage 2 on one fetched job. */
export type AdmitVerdict =
  | {
      admitted: true
      /** The token member to release, or null when the gate did not run (off, orgless, failed open). */
      member: string | null
      /** This was the job's first admission (drives the wait histogram). */
      first: boolean
      nested: boolean
    }
  | { admitted: false; parkMs: number; parked: number }

/** The park delay of a denied job: U[0, B), B from its org's parked count. */
export function parkDelayMs(parked: number): number {
  if (parkDelayOverride !== undefined) return parkDelayOverride
  const bound = Math.min(PARK_MAX_MS, Math.max(PARK_MIN_MS, parked * PARK_PER_JOB_MS))
  return Math.floor(Math.random() * bound)
}

/** Tokens this process holds, for renewal: member -> its keys. */
const held = new Map<string, { queue: string; orgId: string }>()

async function runAdmit(
  c: FairRedis,
  queue: string,
  orgId: string,
  jobId: string,
  member: string,
  C: number,
): Promise<unknown> {
  return c.eval(
    ADMIT_LUA,
    7,
    tokKey(queue, orgId),
    ntokKey(queue, orgId),
    qKey(queue, orgId),
    orgsKey(queue),
    parkKey(queue, orgId),
    nestedKey(queue, orgId),
    fairMetricsKey(queue),
    REDIS_PREFIX,
    queue,
    orgId,
    jobId,
    member,
    String(C),
    String(tokenTtlMs),
    String(NESTED_DEPTH_FACTOR),
    String(QUEUE_KEY_TTL_MS),
    `${bullPrefix}:${queue}:`,
  )
}

/**
 * Stage 2 for one fetched job: may it start now? `lockToken` is the token
 * BullMQ handed the worker; the member it is admitted with names this run only.
 */
export async function tryAdmit(
  queue: string,
  orgId: string | undefined,
  jobId: string,
  lockToken: string,
): Promise<AdmitVerdict> {
  if (!orgId || !fairnessEnabled() || !isFairQueue(queue)) {
    return { admitted: true, member: null, first: false, nested: false }
  }
  const member = `${jobId}|${lockToken}`
  try {
    const C = cellConcurrencyOverride ?? (await cellQueueConcurrency(queue))
    const res = (await gated(runAdmit(client, queue, orgId, jobId, member, C), "admit")) as number[]
    if (Number(res[0]) === 1) {
      held.set(member, { queue, orgId })
      return { admitted: true, member, first: Number(res[1]) === 1, nested: Number(res[2]) === 1 }
    }
    const parked = Number(res[1])
    return { admitted: false, parkMs: parkDelayMs(parked), parked }
  } catch (err) {
    failOpen(queue, "admit", err)
    forgetUngatedRun(queue, orgId, jobId, member)
    return { admitted: true, member: null, first: false, nested: false }
  }
}

/**
 * A job that runs ungated after a failed admit: its turn record goes (or its
 * org would look waiting to every other org), and so does a token the admit
 * may still have written before its answer came too late (nothing would
 * release it). Sent on the same connection after the admit, so it lands
 * after it. Best effort, never awaited.
 */
function forgetUngatedRun(queue: string, orgId: string, jobId: string, member: string): void {
  client
    .multi()
    .zrem(qKey(queue, orgId), jobId)
    .zrem(tokKey(queue, orgId), member)
    .zrem(ntokKey(queue, orgId), member)
    .exec()
    .catch((err) => log.debug({ err, queue }, "fairness: could not forget an ungated run"))
}

/**
 * Give a token back (only the member it was admitted with), and promote the
 * oldest parked job of the same org: `promote(jobId)` answers whether the job
 * was still delayed. Up to 3 parked ids are tried. Never throws.
 */
export async function releaseToken(
  queue: string,
  orgId: string,
  member: string | null,
  promote: (jobId: string) => Promise<boolean>,
): Promise<void> {
  if (!member) return
  held.delete(member)
  try {
    let next = (await gated(
      client.eval(
        RELEASE_LUA,
        3,
        tokKey(queue, orgId),
        ntokKey(queue, orgId),
        parkKey(queue, orgId),
        member,
      ),
      "release",
    )) as string | null
    for (let tries = 0; tries < 3 && next; tries++) {
      if (await promote(next).catch(() => false)) {
        void client.hincrby(fairMetricsKey(queue), "promoted", 1).catch(() => {})
        return
      }
      const popped = await gated(client.zpopmin(parkKey(queue, orgId), 1), "release pop")
      next = popped[0] ?? null
    }
  } catch (err) {
    log.warn({ err, queue, orgId }, "fairness: could not release a token; it expires with its TTL")
  }
}

/** Extend every token this process holds. Never throws. */
export async function renewTokens(): Promise<void> {
  const byKey = new Map<string, { queue: string; orgId: string; members: string[] }>()
  for (const [member, h] of held) {
    const k = `${h.queue}\u0000${h.orgId}`
    const entry = byKey.get(k) ?? { ...h, members: [] }
    entry.members.push(member)
    byKey.set(k, entry)
  }
  await Promise.all(
    [...byKey.values()].map(({ queue, orgId, members }) =>
      gated(
        client.eval(
          RENEW_LUA,
          2,
          tokKey(queue, orgId),
          ntokKey(queue, orgId),
          String(tokenTtlMs),
          ...members,
        ),
        "renew",
      ).catch((err) => log.warn({ err, queue }, "fairness: token renew failed")),
    ),
  )
}

let renewTimer: ReturnType<typeof setInterval> | undefined
/** Renew this process's tokens every 20 s (a job host, from its first worker). */
export function startTokenRenewal(): void {
  if (renewTimer) return
  renewTimer = setInterval(() => void renewTokens(), RENEW_EVERY_MS)
  renewTimer.unref?.()
}
export function stopTokenRenewal(): void {
  if (renewTimer) clearInterval(renewTimer)
  renewTimer = undefined
}

// --- Wait histogram -------------------------------------------------------

function minuteOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace(/[-T:]/g, "")
}

/** The bucket label of a wait: its upper bound in ms, or "inf". */
export function waitBucket(waitMs: number): string {
  for (const b of WAIT_BUCKETS_MS) if (waitMs <= b) return String(b)
  return "inf"
}

/**
 * Record a job's wait (start minus due) at its first admission, in the queue's
 * per-minute histogram and, for a load org, the org's own. A load flag that
 * cannot be read counts the job as not load. Never throws.
 */
export async function recordJobWait(queue: string, orgId: string, waitMs: number): Promise<void> {
  const now = Date.now()
  const minute = minuteOf(now)
  const bucket = waitBucket(Math.max(0, waitMs))
  let load = false
  try {
    load = await loadOrgCheck(orgId)
  } catch (err) {
    log.debug({ err, orgId }, "fairness: load flag unreadable; wait recorded as not load")
  }
  try {
    const pipe = client.pipeline()
    const keys = [
      waitHistogramKey(queue, minute),
      ...(load ? [waitHistogramKey(queue, minute, orgId)] : []),
    ]
    for (const key of keys) {
      pipe.hincrby(key, bucket, 1)
      pipe.expire(key, WAIT_HISTOGRAM_TTL_S)
    }
    await gated(pipe.exec(), "wait histogram")
  } catch (err) {
    log.debug({ err, queue }, "fairness: could not record a job wait")
  }
}

/** Most minutes one histogram read sums (the buckets live 2 h). */
const MAX_HISTOGRAM_MINUTES = 120

/** The span `readWaitHistogram` really reads for a window: its last 120 minutes at most. */
export function waitHistogramSpan(fromMs: number, toMs: number): { fromMs: number; toMs: number } {
  return { fromMs: Math.max(fromMs, toMs - (MAX_HISTOGRAM_MINUTES - 1) * 60_000), toMs }
}

/**
 * A wait histogram summed over the minutes of `[fromMs, toMs]` (at most the
 * last 120 of them): the queue's, or a load org's own. Bucket label -> count.
 */
export async function readWaitHistogram(
  queue: string,
  fromMs: number,
  toMs: number,
  orgId?: string,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  if (toMs < fromMs) return counts
  const first = waitHistogramSpan(fromMs, toMs).fromMs
  const pipe = client.pipeline()
  const lastMinute = minuteOf(toMs)
  for (let t = first; ; t += 60_000) {
    const m = minuteOf(Math.min(t, toMs))
    pipe.hgetall(waitHistogramKey(queue, m, orgId))
    if (m === lastMinute) break
  }
  const res = await pipe.exec()
  for (const [err, h] of res ?? []) {
    if (err || !h) continue
    for (const [b, n] of Object.entries(h as Record<string, string>)) {
      counts[b] = (counts[b] ?? 0) + Number(n)
    }
  }
  return counts
}

/** The p95 (ms, bucket upper bound) of a histogram; null when it is empty. */
export function histogramP95Ms(counts: Readonly<Record<string, number>>): number | null {
  const order = [...WAIT_BUCKETS_MS.map(String), "inf"]
  const total = order.reduce((s, b) => s + (counts[b] ?? 0), 0)
  if (total === 0) return null
  let acc = 0
  for (const b of order) {
    acc += counts[b] ?? 0
    // Past the top bucket: reported as one ms above it.
    if (acc >= 0.95 * total) return b === "inf" ? WAIT_P95_ABOVE_TOP_MS : Number(b)
  }
  return null
}

/** The p95 wait (ms, bucket upper bound) of a queue over the last `minutes` minutes; null when empty. */
export async function readWaitP95Ms(queue: string, minutes = 5): Promise<number | null> {
  const now = Date.now()
  return histogramP95Ms(await readWaitHistogram(queue, now - (minutes - 1) * 60_000, now))
}

/** Orgs whose parked jobs /diag counts (the oldest waiting first). */
const PARKED_NOW_ORGS = 500

/**
 * The fairness counters of a queue (lifetime, since the metrics hash began),
 * the jobs parked right now and the count of orgs with work waiting (never
 * their ids).
 */
export async function readQueueFairness(queue: string): Promise<{
  admitted: number
  /** Admissions refused, lifetime (each one parked its job). */
  denied: number
  /** Jobs parked now, over the first 500 waiting orgs. */
  parkedNow: number
  promoted: number
  failopen: number
  busyOrgs: number
  degraded: boolean
}> {
  const [m, busy, failAt, orgs] = await Promise.all([
    client.hgetall(fairMetricsKey(queue)),
    client.zcard(orgsKey(queue)),
    client.hget("jobs:fairness:failopen_at", queue),
    client.zrange(orgsKey(queue), "0", String(PARKED_NOW_ORGS - 1)),
  ])
  let parkedNow = 0
  if (orgs.length > 0) {
    const pipe = client.pipeline()
    for (const o of orgs) pipe.zcard(parkKey(queue, o))
    for (const [err, n] of (await pipe.exec()) ?? []) if (!err) parkedNow += Number(n)
  }
  const n = (k: string) => Number(m[k] ?? 0)
  return {
    admitted: n("admitted") + n("admitted_nested"),
    denied: n("denied"),
    parkedNow,
    promoted: n("promoted"),
    failopen: n("failopen"),
    busyOrgs: busy,
    degraded: failAt !== null && Date.now() - Number(failAt) < FAILOPEN_DEGRADED_MS,
  }
}

/** Test access to this module's private state. Production code never calls it. */
export const FairnessTestAccess = {
  reset(): void {
    localSlots = {}
    slotsSource = undefined
    cellSlotsCache = undefined
    enabledOverride = undefined
    client = redis
    cellConcurrencyOverride = undefined
    tokenTtlMs = TOKEN_TTL_MS
    parkDelayOverride = undefined
    held.clear()
    stopTokenRenewal()
    nestedMinting = true
    loadOrgCheck = isLoadOrg
  },
  setNestedMinting(on: boolean): void {
    nestedMinting = on
  },
  setLoadOrgCheck(fn: ((orgId: string) => Promise<boolean>) | undefined): void {
    loadOrgCheck = fn ?? isLoadOrg
  },
  /** Force the gate on or off (`undefined`: follow JOB_ORG_FAIRNESS). */
  setEnabled(on: boolean | undefined): void {
    enabledOverride = on
  },
  /** Replace the gate's Redis client (a hanging one, a second "process"). */
  setClient(c: FairRedis | undefined): void {
    client = c ?? redis
  },
  /** Pin C instead of reading the instance records. */
  setCellConcurrency(n: number | undefined): void {
    cellConcurrencyOverride = n
  },
  /** Park every denied job for exactly `ms` (a long park proves the release promotes). */
  setParkDelayMs(ms: number | undefined): void {
    parkDelayOverride = ms
  },
  setTokenTtlMs(ms: number | undefined): void {
    tokenTtlMs = ms ?? TOKEN_TTL_MS
  },
  /** Stage 2 through another client, as a second process would run it. */
  async admitWith(
    c: FairRedis,
    queue: string,
    orgId: string,
    jobId: string,
    lockToken: string,
    C: number,
  ): Promise<boolean> {
    const res = (await runAdmit(c, queue, orgId, jobId, `${jobId}|${lockToken}`, C)) as number[]
    return Number(res[0]) === 1
  },
  keys: { qKey, orgsKey, tokKey, ntokKey, parkKey, nestedKey },
  setLocalSlots(slots: Record<string, number>): void {
    localSlots = { ...slots }
    cellSlotsCache = undefined
  },
  setSlotsSource(src: CellSlotsSource | undefined): void {
    slotsSource = src
    cellSlotsCache = undefined
  },
  cellQueueConcurrency(queue: string): Promise<number> {
    return cellQueueConcurrency(queue)
  },
}
