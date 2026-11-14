// SPDX-License-Identifier: FSL-1.1-ALv2
// A rollback to a build from before the queue classes must not strand jobs on
// the class queues: the script puts schedulers and queued jobs back on
// `app-kernel`, in the id form that build reads, and refuses while a worker
// still consumes the class queues.
import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { Queue, Worker } from "bullmq"
import { encodeLegacyJobId } from "~/infra/jobs/legacy-job-ids"
import { KERNEL_QUEUE_CLASSES, LEGACY_KERNEL_QUEUE } from "~/infra/jobs/queue-classes"
import { bullPrefix, redisBullMQ } from "~/lib/redis"
import { rollbackKernelQueues } from "./kernel-queues-rollback"

// A prefix of this file's own: another test of the same run, in this process or a parallel one,
// may start the kernel workers on the run's prefix, and they would consume the jobs queued here
// or count as a connected worker. Nothing else ever uses this prefix.
const prefix = `${bullPrefix}-rollback-test-${process.pid}`
const open = (name: string) => new Queue(name, { connection: redisBullMQ, prefix })
const legacy = open(LEGACY_KERNEL_QUEUE)
const cron = open(KERNEL_QUEUE_CLASSES.cron.queueName)
const agent = open(KERNEL_QUEUE_CLASSES.agent.queueName)
const all = [legacy, ...Object.values(KERNEL_QUEUE_CLASSES).map((c) => open(c.queueName))]

describe("kernel queue classes rollback", () => {
  beforeEach(async () => {
    for (const q of all) await q.obliterate({ force: true })
  })
  afterAll(async () => {
    for (const q of all) {
      await q.obliterate({ force: true })
      await q.close()
    }
  })

  it("moves schedulers and queued jobs back to app-kernel in the old id form", async () => {
    const now = Date.now()
    await cron.upsertJobScheduler(
      "approval-expiry-sweep-scheduler",
      { pattern: "*/2 * * * *" },
      { name: "approval-expiry-sweep", data: { a: 1 } },
    )
    await cron.add(
      "approval-expiry",
      { requestId: "r1" },
      { deduplication: { id: "approval-expiry:r1" }, delay: 600_000, timestamp: now },
    )
    await agent.add("agent-subrun", { runId: "x" }, { priority: 0 })

    const dry = await rollbackKernelQueues({ apply: false, now, prefix })
    expect(dry).toMatchObject({ schedulersMoved: 1, jobsMoved: 2, applied: false })
    expect(await legacy.getJobSchedulers(0, -1)).toEqual([])

    const report = await rollbackKernelQueues({ apply: true, now, prefix })
    expect(report).toMatchObject({ schedulersMoved: 1, jobsMoved: 2, applied: true })
    expect((await legacy.getJobScheduler("approval-expiry-sweep-scheduler"))?.pattern).toBe(
      "*/2 * * * *",
    )
    expect(await cron.getJobSchedulers(0, -1)).toEqual([])
    const expiry = await legacy.getJob(encodeLegacyJobId("approval-expiry:r1"))
    expect(expiry?.data).toEqual({ requestId: "r1" })
    expect(
      Math.abs((expiry?.timestamp ?? 0) + (expiry?.delay ?? 0) - (now + 600_000)),
    ).toBeLessThan(5_000)
    expect((await legacy.getWaiting()).map((j) => j.name)).toEqual(["agent-subrun"])
    expect(await cron.getDelayedCount()).toBe(0)
    expect(await agent.getWaitingCount()).toBe(0)
  })

  it("refuses to apply while a worker still consumes a class queue", async () => {
    await agent.add("agent-subrun", { runId: "y" }, { delay: 600_000 })
    const worker = new Worker(KERNEL_QUEUE_CLASSES.agent.queueName, async () => {}, {
      connection: redisBullMQ,
      prefix,
      autorun: true,
    })
    await worker.waitUntilReady()
    try {
      const report = await rollbackKernelQueues({ apply: true, prefix })
      expect(report.applied).toBe(false)
      expect(report.workersConnected).toBeGreaterThan(0)
      expect(await agent.getDelayedCount()).toBe(1)
    } finally {
      await worker.close(true)
    }
  })
})
