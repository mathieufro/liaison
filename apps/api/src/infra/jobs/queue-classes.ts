// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The kernel's queue classes, and the ONE table that says which class each
// kernel job runs in.
//
// WHY CLASSES. Every kernel job used to share one BullMQ queue (`app-kernel`,
// five slots, FIFO). A burst of search indexing therefore queued in front of
// every kernel cron: in production on 2026-09-30 the urgent digest, the
// approval sweeps and the lapsed desktop-claim sweep waited 58 minutes behind
// ~3,000 search jobs, and because a BullMQ scheduler only mints its next tick
// once the current one is picked up, a backlog silently turns a cron into
// "never". A class is a queue with its own worker and its own slots, so work of
// one kind can only ever wait behind work of the same kind:
//
//   cron   short sweeps, digests, reapers, expiries: must run on time
//   agent  LLM loops (sub-runs, re-invocations, routine ticks, consolidation)
//   media  file work (thumbnails, object deletion, link ingest, media analysis)
//   bulk   background volume (search indexing, reindex, backfills, purges)
//   webhook  the webhook inbox: replays of stored deliveries, their sweep and
//          retention (a burst of replays must not hold the cron lane)
//
// Within a class, BullMQ `priority` orders the jobs: a job without a priority
// runs before any prioritized one, and a larger number runs later. It is used
// for the few jobs that are allowed to yield inside their class (a daily
// retention sweep yields to the every-minute sweeps; a routine tick yields to a
// sub-run a user is waiting on).
//
// ONE TABLE, NO SCATTERED STRINGS. Call sites keep naming a job by
// `("kernel", jobName)`; `resolveJobQueue` turns that into the physical queue.
// Registering or enqueuing a kernel job that is not in `KERNEL_JOBS` throws, so
// a new kernel job cannot land in some default line by accident: it has to be
// classified here. App queues (`app-<name>`, one per installed app, and the
// search flusher's `app-search-index`) are outside the kernel and keep their
// own queue each.
//
// DEPENDENCY FREE on purpose (no env, no Redis): e2e helpers in both apps
// import it to address the real class queues.
//
// LEGACY. `app-kernel` is the pre-class queue. Jobs already in it at deploy
// time are still processed: the job host keeps a drain worker on it that runs
// each job by its name, and `legacy-kernel-queue.ts` moves its schedulers and
// delayed jobs to their class queues at boot.

export type KernelQueueClass = "cron" | "agent" | "media" | "bulk" | "webhook"

export interface QueueClassSpec {
  /** Physical BullMQ queue name. Not `app-` prefixed, so it can never collide with an app's queue. */
  queueName: string
  /** Worker slots, overridable per class with `JOB_QUEUE_CONCURRENCY` ("agent=8,bulk=2"). */
  concurrency: number
  /** The oldest waiting job older than this is reported stale on /diag (the alert threshold). */
  alertAfterSec: number
  /** Enqueues refused once Redis memory crosses the SOFT ratio (bulk) or only the HARD one. */
  shedAtSoftMemory: boolean
}

export const KERNEL_QUEUE_CLASSES: Readonly<Record<KernelQueueClass, QueueClassSpec>> = {
  // cron: two slots; its third went to `webhook` with the inbox's replays,
  // the one cron tenant that ran an app's handler for up to its wall clock.
  cron: { queueName: "kernel-cron", concurrency: 2, alertAfterSec: 120, shedAtSoftMemory: false },
  // agent: a sub-agent chain holds one slot per waiting level. Rooted in a job of
  // this class (a routine tick or a re-invocation), a full chain (root plus
  // MAX_NESTING_DEPTH = 2 sub-runs, spawn-agent.ts) holds three, so four slots
  // keep one free for every other LLM loop.
  agent: { queueName: "kernel-agent", concurrency: 4, alertAfterSec: 300, shedAtSoftMemory: false },
  media: { queueName: "kernel-media", concurrency: 2, alertAfterSec: 600, shedAtSoftMemory: false },
  // bulk: backlog tolerant by design (alert after an hour; the live search
  // flusher has its own queue), so it gave its second slot to agent.
  bulk: { queueName: "kernel-bulk", concurrency: 1, alertAfterSec: 3600, shedAtSoftMemory: true },
  // webhook: a replay runs an app's handler (up to its wall clock, holding a
  // pinned jobs slot); the minute sweep wakes every due row, and at UTC
  // midnight every delivery held at a day cap comes due at once. Its own lane,
  // so such a burst waits behind itself only; never shed (a refused wake is
  // only re-woken by the next sweep). The slot came from cron: the kernel's
  // total is unchanged (THE SLOT BUDGET below).
  webhook: {
    queueName: "kernel-webhook",
    concurrency: 1,
    alertAfterSec: 600,
    shedAtSoftMemory: false,
  },
}

/** Slots of the legacy `app-kernel` drain worker: leftovers only, one at a time. */
export const LEGACY_DRAIN_CONCURRENCY = 1

/** The pre-class shared queue, drained by name after the split (see header). */
export const LEGACY_KERNEL_QUEUE = "app-kernel"

/** Priority for work that yields to the rest of its class (BullMQ: larger runs later). */
const YIELD = 10

export interface KernelJobSpec {
  queueClass: KernelQueueClass
  priority?: number
}

/**
 * Every kernel job, by name. The single source of truth for where a kernel job
 * runs; `queue-classes.test.ts` checks every name registered in the codebase
 * appears here.
 */
export const KERNEL_JOBS: Readonly<Record<string, KernelJobSpec>> = {
  // cron: scheduled sweeps and short per-request timers.
  "check-device-flow-expiry": { queueClass: "cron" },
  "approval-expiry": { queueClass: "cron" },
  "control-plane-heartbeat": { queueClass: "cron" },
  "cloud-usage-report": { queueClass: "cron" },
  "app-usage-loader-pull": { queueClass: "cron" },
  "app-deferred-event": { queueClass: "cron" },
  "approval-expiry-sweep": { queueClass: "cron" },
  "approval-reminder-sweep": { queueClass: "cron" },
  "approval-routed-reminder-sweep": { queueClass: "cron" },
  "approval-approving-reaper": { queueClass: "cron" },
  "approval-deferred-step-reaper": { queueClass: "cron" },
  "approval-poll-output": { queueClass: "cron" },
  "notify-desktop-fallback": { queueClass: "cron" },
  "notify-burst-flush": { queueClass: "cron" },
  "notify-badge-sync": { queueClass: "cron" },
  "subrun-stuck-sweep": { queueClass: "cron" },
  "local-claim-lapse-sweep": { queueClass: "cron" },
  "routine-mailbox-wait-expiry": { queueClass: "cron" },
  "routine-flow-sweep": { queueClass: "cron" },
  "node-lease-sweep": { queueClass: "cron" },
  "control-plane-outbox": { queueClass: "cron" },
  "attention-digest-urgent": { queueClass: "cron" },
  "attention-digest-cadence": { queueClass: "cron" },
  "attention-digest-hourly": { queueClass: "cron" },
  "attention-digest-daily": { queueClass: "cron" },
  "attention-state-email-materialize": { queueClass: "cron" },
  "attention-state-email-materialize-org": { queueClass: "cron" },
  // One tick per (app, job) manifest schedule, fanned out over orgs (fanout.ts).
  "app-cron-fanout": { queueClass: "cron" },
  "agent-side-thread-reaper": { queueClass: "cron" },
  "routine-event-reconcile": { queueClass: "cron" },
  // The previous release's webhook retries; drained into the inbox.
  "retry-webhook": { queueClass: "cron" },
  "mailbox-backfill": { queueClass: "cron", priority: YIELD },
  // Daily/weekly maintenance: still crons, but they yield to the sweeps above.
  "cleanup-expired-sessions": { queueClass: "cron", priority: YIELD },
  "audit-log-retention": { queueClass: "cron", priority: YIELD },
  "agent-turn-retention": { queueClass: "cron", priority: YIELD },
  "effect-ledger-retention": { queueClass: "cron", priority: YIELD },
  "away-ranges-prune": { queueClass: "cron", priority: YIELD },
  "calendar-away-refresh": { queueClass: "cron", priority: YIELD },
  "reconcile-sweep": { queueClass: "cron", priority: YIELD },
  "days-off-calendar": { queueClass: "cron", priority: YIELD },
  "capacity-lines": { queueClass: "cron", priority: YIELD },
  "task-time-anonymise": { queueClass: "cron", priority: YIELD },
  "attention-events-retention": { queueClass: "cron", priority: YIELD },
  "dashboard-table-changes-retention": { queueClass: "cron", priority: YIELD },
  "app-logs-retention": { queueClass: "cron", priority: YIELD },
  "suppression-links-prune": { queueClass: "cron", priority: YIELD },
  "prospect-retention": { queueClass: "cron", priority: YIELD },
  "app-draft-store-retention": { queueClass: "cron", priority: YIELD },
  "app-code-modules-retention": { queueClass: "cron", priority: YIELD },
  "notification-deliveries-retention": { queueClass: "cron", priority: YIELD },
  "sync-model-pricing": { queueClass: "cron", priority: YIELD },
  "sync-openrouter-prices": { queueClass: "cron", priority: YIELD },
  "files-orphan-gc": { queueClass: "cron", priority: YIELD },
  "import-uploads-reaper": { queueClass: "cron", priority: YIELD },
  "secret-request-expiry": { queueClass: "cron", priority: YIELD },
  "demo-reset": { queueClass: "cron", priority: YIELD },
  // Not YIELD: a YIELD cron waits behind every org's job on the queue, and on a
  // demo box with hundreds of workspaces the per-org fan-outs (one job per org
  // a minute) never leave the queue empty, so the reaper never ran and expired
  // workspaces piled up, each one more org for every fan-out to touch.
  "demo-reap": { queueClass: "cron" },
  "imports-stale-sweep": { queueClass: "cron", priority: YIELD },
  // Whole-org exports: stalled runs fail, expired archives are deleted (org-archive/store.ts).
  "org-export-sweep": { queueClass: "cron", priority: YIELD },
  // One run at a time box-wide (a Redis lock in demo-pool.ts), so it holds at
  // most one cron slot however many claims kick it. Not YIELD, for the reason
  // demo-reap is not: behind a busy box's per-org fan-outs the refill sat in
  // the queue for minutes while signups drained the pool.
  "demo-pool-refill": { queueClass: "cron" },

  // agent: LLM loops. A sub-run or a re-invocation has a user waiting on it.
  "agent-subrun": { queueClass: "agent" },
  "agent-reinvoke": { queueClass: "agent" },
  // A posted message's dispatch, handed over by a process shutting down.
  "agent-turn-dispatch": { queueClass: "agent" },
  "agent-turn-resume": { queueClass: "agent" },
  "scope-request-decision-turn": { queueClass: "agent" },
  "secret-request-turn": { queueClass: "agent" },
  "app-page-result-turn": { queueClass: "agent" },
  "setup-kickoff": { queueClass: "agent" },
  "approval-result-turn": { queueClass: "agent" },
  "approval-reminder-turn": { queueClass: "agent" },
  "routine-tick": { queueClass: "agent", priority: 5 },
  // A routine flow's wait came due (0303): it may go on to an agent step.
  "routine-flow-resume": { queueClass: "agent", priority: 5 },
  "agent-memory-consolidation": { queueClass: "agent", priority: YIELD },
  // Due just before a prompt cache expires: late is the same as not at all.
  "agent-warm-compaction": { queueClass: "agent" },
  // The load harness's synthetic agent-class job (load-synthetic.ts): load orgs only.
  "load-synthetic": { queueClass: "agent" },

  // media: file work.
  "files-thumbnail": { queueClass: "media" },
  "files-delete-object": { queueClass: "media" },
  "files-link-ingest": { queueClass: "media" },
  "files-media-analysis": { queueClass: "media", priority: 5 },

  // bulk: background volume. The live search flusher has its own queue
  // (`app-search-index`); these are the per-entity names it superseded, which
  // only record a request now, plus the long-running search maintenance.
  "org-storage-estimate": { queueClass: "bulk" },
  "search-index-upsert": { queueClass: "bulk" },
  "search-index-delete": { queueClass: "bulk" },
  "search-task-verify": { queueClass: "bulk" },
  "search-message-index-upsert": { queueClass: "bulk" },
  "search-message-index-delete": { queueClass: "bulk" },
  "search-brief-index-upsert": { queueClass: "bulk" },
  "search-brief-index-delete": { queueClass: "bulk" },
  "search-reindex-full": { queueClass: "bulk", priority: YIELD },
  "search-embedding-backfill": { queueClass: "bulk", priority: YIELD },
  "search-near-duplicate-clusters": { queueClass: "bulk", priority: YIELD },
  // Summaries of pending approvals that have none, a paced batch per job
  // (modules/approvals/summary-backfill.ts).
  "approval-summary-backfill": { queueClass: "bulk", priority: YIELD },
  "mailbox-purge": { queueClass: "bulk" },
  "imports-run": { queueClass: "bulk" },
  // One whole-org export archive (modules/export/org-archive/job.ts).
  "org-export": { queueClass: "bulk" },
  // An operator's org deletion: legal archive + purge (modules/org/delete/job.ts).
  "org-delete": { queueClass: "bulk" },

  // webhook: the webhook inbox (modules/webhooks/inbox.ts): one row's replay,
  // the minute sweep that wakes due rows, and the hourly retention.
  "webhook-inbox-replay": { queueClass: "webhook" },
  "webhook-inbox-sweep": { queueClass: "webhook" },
  "webhook-inbox-retention": { queueClass: "webhook", priority: YIELD },
}

/** Thrown when a kernel job is registered or enqueued without a class. */
export class UnclassifiedKernelJobError extends Error {
  constructor(jobName: string) {
    super(
      `Kernel job "${jobName}" has no queue class: add it to KERNEL_JOBS in infra/jobs/queue-classes.ts`,
    )
    this.name = "UnclassifiedKernelJobError"
  }
}

const KERNEL_APP = "kernel"

export function isKernelApp(appName: string): boolean {
  return appName === KERNEL_APP
}

export function kernelJobSpec(jobName: string): KernelJobSpec {
  const spec = KERNEL_JOBS[jobName]
  if (!spec) throw new UnclassifiedKernelJobError(jobName)
  return spec
}

/**
 * Where a logical job (appName, jobName) runs: its physical queue, the
 * BullMQ priority to stamp on it, and its class when it is a kernel job.
 */
export interface JobRoute {
  queueName: string
  priority?: number
  queueClass?: KernelQueueClass
}

export function resolveJobQueue(appName: string, jobName: string): JobRoute {
  if (!isKernelApp(appName)) return { queueName: `app-${appName}` }
  const spec = kernelJobSpec(jobName)
  return {
    queueName: KERNEL_QUEUE_CLASSES[spec.queueClass].queueName,
    queueClass: spec.queueClass,
    ...(spec.priority ? { priority: spec.priority } : {}),
  }
}

/** Is this physical queue one of the kernel's (a class queue or the legacy one)? */
export function isKernelQueueName(queueName: string): boolean {
  return queueName === LEGACY_KERNEL_QUEUE || kernelQueueClassOf(queueName) !== undefined
}

export function kernelQueueClassOf(queueName: string): KernelQueueClass | undefined {
  for (const [cls, spec] of Object.entries(KERNEL_QUEUE_CLASSES)) {
    if (spec.queueName === queueName) return cls as KernelQueueClass
  }
  return undefined
}

/** Parse `JOB_QUEUE_CONCURRENCY` ("agent=8,bulk=2"); unknown classes and bad numbers are ignored. */
export function parseConcurrencyOverrides(
  raw: string | undefined,
): Partial<Record<KernelQueueClass, number>> {
  const out: Partial<Record<KernelQueueClass, number>> = {}
  if (!raw) return out
  for (const part of raw.split(",")) {
    const [name, value] = part.split("=").map((s) => s.trim())
    const n = Number(value)
    if (name && name in KERNEL_QUEUE_CLASSES && Number.isInteger(n) && n >= 1 && n <= 64) {
      out[name as KernelQueueClass] = n
    }
  }
  return out
}

// THE SLOT BUDGET. Kernel handlers open their own short transactions on the
// PRIVILEGED pool (withPrivilegedDb / withSystemDb), the same pool every
// request's nested privileged read uses. A kernel slot is therefore, at worst,
// one privileged connection held, and the kernel as a whole must leave room
// for the request path: every kernel slot (all classes plus the legacy drain)
// adds up to at most the privileged pool minus PRIVILEGED_POOL_HEADROOM. With
// production's pool of 15 that is 11: the defaults above (2 + 4 + 2 + 1 + 1)
// plus the legacy drain (1). Most handlers hold a connection only for their short
// transactions, not their whole run, so this is a worst case, and the four
// connections left over are the request path's. (The one shared queue this
// replaces had 5 slots, and a single search burst took all of them.) An override
// that asks for more is scaled down, the biggest classes first, never below
// one slot, with a warning.
export const PRIVILEGED_POOL_HEADROOM = 4

/**
 * What the kernel classes want before any cap (db/pool-plan.ts KernelNeed):
 * every slot (classes plus the legacy drain), and the agent + cron slots, whose
 * agent turns run their tool transactions on the request pool.
 */
export function kernelSlotsWanted(overrides: Partial<Record<KernelQueueClass, number>>): {
  total: number
  requestSlots: number
} {
  const slot = (c: KernelQueueClass) => overrides[c] ?? KERNEL_QUEUE_CLASSES[c].concurrency
  const classes = Object.keys(KERNEL_QUEUE_CLASSES) as KernelQueueClass[]
  return {
    total: classes.reduce((n, c) => n + slot(c), LEGACY_DRAIN_CONCURRENCY),
    // webhook counts as cron did when the replays ran there (its slot came
    // from cron): a replay's handler may write through the request login.
    requestSlots: slot("agent") + slot("cron") + slot("webhook"),
  }
}

/**
 * Slots per kernel class after overrides, capped so the whole kernel (classes
 * plus the legacy drain) fits in `poolMax - PRIVILEGED_POOL_HEADROOM`.
 */
export function planKernelSlots(
  overrides: Partial<Record<KernelQueueClass, number>>,
  poolMax: number,
): { slots: Record<KernelQueueClass, number>; budget: number; scaledDown: boolean } {
  const classes = Object.keys(KERNEL_QUEUE_CLASSES) as KernelQueueClass[]
  const minimum = classes.length + LEGACY_DRAIN_CONCURRENCY
  const budget = Math.max(minimum, poolMax - PRIVILEGED_POOL_HEADROOM)
  const slots = Object.fromEntries(
    classes.map((c) => [c, overrides[c] ?? KERNEL_QUEUE_CLASSES[c].concurrency]),
  ) as Record<KernelQueueClass, number>
  const total = () => classes.reduce((sum, c) => sum + slots[c], LEGACY_DRAIN_CONCURRENCY)
  let scaledDown = false
  while (total() > budget) {
    const biggest = classes.reduce((a, b) => (slots[b] > slots[a] ? b : a))
    if (slots[biggest] <= 1) break
    slots[biggest]--
    scaledDown = true
  }
  return { slots, budget, scaledDown }
}
