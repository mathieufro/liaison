// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Roll the kernel queue classes back: move every scheduler and every queued
 * job from the class queues (kernel-cron, kernel-agent, kernel-media,
 * kernel-bulk) to the pre-class `app-kernel` queue, in the form a build from
 * before the split reads.
 *
 * WHY. A build from before the queue classes only has an `app-kernel` worker.
 * Rolled back to it, anything still on a class queue would sit there forever:
 * a routine's scheduler, an approval's delayed expiry, a queued sub-run. This
 * script puts them back where that build looks. The forward direction needs no
 * script: the new build's boot migration and its `app-kernel` drain worker
 * handle it (infra/jobs/legacy-kernel-queue.ts).
 *
 * HOW TO RUN IT, in this order:
 *   1. Deploy the previous image. It registers its own crons on `app-kernel`
 *      at boot and runs no worker on the class queues.
 *   2. With the NEW image (the only one that has this script), dry run, then
 *      apply, against the production Redis:
 *        bun apps/api/scripts/kernel-queues-rollback.ts            # report only
 *        bun apps/api/scripts/kernel-queues-rollback.ts --apply
 *
 * SAFETY. It refuses to apply while any worker is connected to a class queue
 * (the new build still running would consume what it moves). Order is
 * add-then-remove: a crash leaves a job in both queues, never in neither. A
 * scheduler the previous build already re-created on `app-kernel` is kept and
 * only the class-queue copy removed. Jobs a worker is running (active) cannot
 * be moved and are reported.
 */
import { type Job, Queue } from "bullmq"
import { encodeLegacyJobId } from "~/infra/jobs/legacy-job-ids"
import { KERNEL_QUEUE_CLASSES, LEGACY_KERNEL_QUEUE } from "~/infra/jobs/queue-classes"
import { bullPrefix, redisBullMQ } from "~/lib/redis"

export interface RollbackReport {
  schedulersMoved: number
  jobsMoved: number
  /** Jobs a worker holds right now: they finish (or stall back) on the class queue. */
  activeLeft: number
  /** Workers still connected to a class queue (applying is refused while > 0). */
  workersConnected: number
  applied: boolean
}

const STATES = ["wait", "prioritized", "delayed", "paused"] as const

function openQueue(name: string, prefix: string): Queue {
  return new Queue(name, { connection: redisBullMQ, prefix })
}

async function moveJob(job: Job, legacy: Queue, now: number): Promise<void> {
  const logicalId = job.deduplicationId
  const { priority: _priority, deduplication: _dedup, jobId: _jobId, ...opts } = job.opts
  await legacy.add(job.name, job.data, {
    ...opts,
    // The previous build dedupes by BullMQ id, in its own encoding.
    ...(logicalId ? { jobId: encodeLegacyJobId(logicalId) } : {}),
    // A delayed job keeps its due time; a runnable one stays runnable.
    delay: job.delay > 0 ? Math.max(0, job.timestamp + job.delay - now) : 0,
    timestamp: job.timestamp,
  })
  await job.remove()
}

export async function rollbackKernelQueues(opts: {
  apply: boolean
  now?: number
  /** The BullMQ key prefix; the process's own by default. A test passes a private one. */
  prefix?: string
}): Promise<RollbackReport> {
  const now = opts.now ?? Date.now()
  const prefix = opts.prefix ?? bullPrefix
  const legacy = openQueue(LEGACY_KERNEL_QUEUE, prefix)
  const classQueues = Object.values(KERNEL_QUEUE_CLASSES).map((c) => openQueue(c.queueName, prefix))
  const report: RollbackReport = {
    schedulersMoved: 0,
    jobsMoved: 0,
    activeLeft: 0,
    workersConnected: 0,
    applied: false,
  }
  try {
    for (const q of classQueues) report.workersConnected += (await q.getWorkers()).length
    const apply = opts.apply && report.workersConnected === 0
    for (const q of classQueues) {
      for (const s of await q.getJobSchedulers(0, -1)) {
        report.schedulersMoved++
        if (!apply) continue
        if (!(await legacy.getJobScheduler(s.key))) {
          const { priority: _priority, ...templateOpts } = s.template?.opts ?? {}
          await legacy.upsertJobScheduler(
            s.key,
            {
              ...(s.pattern ? { pattern: s.pattern } : {}),
              ...(s.every ? { every: s.every } : {}),
              ...(s.tz ? { tz: s.tz } : {}),
              ...(s.endDate ? { endDate: s.endDate } : {}),
              ...(s.limit ? { limit: s.limit } : {}),
            },
            { name: s.name, data: s.template?.data, opts: templateOpts },
          )
        }
        await q.removeJobScheduler(s.key)
      }
      report.activeLeft += await q.getActiveCount()
      for (const job of await q.getJobs([...STATES], 0, -1)) {
        // A scheduler's next tick went with its scheduler above.
        if (!job || job.repeatJobKey || String(job.id).startsWith("repeat:")) continue
        report.jobsMoved++
        if (apply) await moveJob(job, legacy, now)
      }
    }
    report.applied = apply
    return report
  } finally {
    await Promise.all([legacy, ...classQueues].map((q) => q.close()))
  }
}

if (import.meta.main) {
  const apply = process.argv.includes("--apply")
  const report = await rollbackKernelQueues({ apply })
  console.log(JSON.stringify(report))
  if (apply && !report.applied) {
    console.error(
      `Refused: ${report.workersConnected} worker(s) still connected to the class queues. ` +
        "Deploy the previous image first (see the header), then re-run.",
    )
    process.exit(1)
  }
  process.exit(0)
}
