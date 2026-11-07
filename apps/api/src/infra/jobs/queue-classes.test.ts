// SPDX-License-Identifier: FSL-1.1-ALv2
// Design audit 2026-09-30, finding 1: one `app-kernel` queue (five slots,
// FIFO) served search, agents, files and crons, and in production the kernel
// crons waited 58 minutes behind ~3,000 search jobs. These tests pin the queue
// classes: the table covers every kernel job, a cron never shares a queue with
// bulk work, and a cron runs at once while a bulk backlog is queued.
import { afterAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import {
  closeAllQueues,
  enqueueAppJob,
  getJobQueue,
  JobsTestAccess,
  registerJobWorker,
} from "./jobs"
import {
  KERNEL_JOBS,
  KERNEL_QUEUE_CLASSES,
  LEGACY_DRAIN_CONCURRENCY,
  LEGACY_KERNEL_QUEUE,
  PRIVILEGED_POOL_HEADROOM,
  parseConcurrencyOverrides,
  planKernelSlots,
  resolveJobQueue,
  UnclassifiedKernelJobError,
} from "./queue-classes"

const SRC = path.resolve(import.meta.dir, "../..")

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(full)
  }
  return out
}

describe("kernel queue classes: the table", () => {
  it("classifies every kernel job name the codebase registers, schedules or enqueues", async () => {
    // Literal call sites: fn("kernel", "job-name" ...
    const literal =
      /(?:registerJobWorker|registerScheduledJob|enqueueAppJob|upsertJobScheduler|removeScheduledJob|removeAppJob)(?:<[^>]*>)?\(\s*"kernel",\s*"([^"]+)"/g
    const names = new Set<string>()
    for (const file of sourceFiles(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(literal)) names.add(m[1]!)
    }
    // Call sites that name the job through a constant.
    const { AGENT_SUBRUN_JOB_NAME } = await import("~/modules/agent/subruns/spawn-agent")
    const { CONSOLIDATION_JOB } = await import("~/modules/agent/memory/consolidation")
    const { EMBEDDING_BACKFILL_JOB } = await import("./embedding-backfill")
    const { NEAR_DUPLICATE_JOB } = await import("./near-duplicate-clusters")
    const { STATE_MATERIALIZER_JOB } = await import("~/modules/attention/state-materializer")
    const digest = await import("~/modules/attention/digest-jobs")
    const backfill = await import("~/modules/mailbox-crypto/backfill-job")
    const { APPROVAL_REMINDER_TURN_JOB } = await import("~/modules/approvals/reminders")
    for (const n of [
      AGENT_SUBRUN_JOB_NAME,
      CONSOLIDATION_JOB,
      EMBEDDING_BACKFILL_JOB,
      NEAR_DUPLICATE_JOB,
      STATE_MATERIALIZER_JOB,
      digest.URGENT_JOB,
      digest.IMMEDIATE_JOB,
      digest.HOURLY_JOB,
      digest.DAILY_JOB,
      backfill.MAILBOX_BACKFILL_JOB_NAME,
      backfill.MAILBOX_PURGE_JOB_NAME,
      APPROVAL_REMINDER_TURN_JOB,
    ]) {
      names.add(n)
    }
    expect(names.size).toBeGreaterThan(20)
    const unclassified = [...names].filter((n) => !KERNEL_JOBS[n])
    expect(unclassified).toEqual([])
  })

  it("puts every scheduled sweep in the cron class, never with bulk or agent work", () => {
    for (const name of [
      "attention-digest-urgent",
      "attention-digest-cadence",
      "approval-expiry-sweep",
      "approval-approving-reaper",
      "local-claim-lapse-sweep",
      "subrun-stuck-sweep",
      "mailbox-backfill",
    ]) {
      expect(resolveJobQueue("kernel", name).queueName).toBe(KERNEL_QUEUE_CLASSES.cron.queueName)
    }
    expect(resolveJobQueue("kernel", "search-index-upsert").queueName).toBe("kernel-bulk")
    expect(resolveJobQueue("kernel", "agent-subrun").queueName).toBe("kernel-agent")
    expect(resolveJobQueue("kernel", "files-thumbnail").queueName).toBe("kernel-media")
    const physical = new Set(Object.values(KERNEL_QUEUE_CLASSES).map((c) => c.queueName))
    expect(physical.size).toBe(4)
    expect(physical.has(LEGACY_KERNEL_QUEUE)).toBe(false)
  })

  it("routes an app's jobs to its own queue and refuses an unclassified kernel job", () => {
    expect(resolveJobQueue("mail", "anything")).toEqual({ queueName: "app-mail" })
    expect(() => resolveJobQueue("kernel", "made-up-job")).toThrow(UnclassifiedKernelJobError)
    expect(() => registerJobWorker("kernel", "made-up-job", async () => {})).toThrow(
      UnclassifiedKernelJobError,
    )
  })

  it("orders within a class: a sub-run outranks a routine tick, sweeps outrank daily maintenance", () => {
    expect(resolveJobQueue("kernel", "agent-subrun").priority).toBeUndefined()
    expect(resolveJobQueue("kernel", "routine-tick").priority).toBeGreaterThan(0)
    expect(resolveJobQueue("kernel", "local-claim-lapse-sweep").priority).toBeUndefined()
    expect(resolveJobQueue("kernel", "audit-log-retention").priority).toBeGreaterThan(0)
  })

  // Kernel handlers take their connections from the PRIVILEGED pool (15 in
  // production), which every request's nested privileged read also uses. The
  // kernel's slots, legacy drain included, must leave that pool headroom.
  it("keeps every kernel slot within the privileged pool minus headroom", () => {
    const total = (slots: Record<string, number>) =>
      Object.values(slots).reduce((a, b) => a + b, LEGACY_DRAIN_CONCURRENCY)
    const prod = planKernelSlots({}, 15)
    expect(prod.scaledDown).toBe(false)
    expect(total(prod.slots)).toBeLessThanOrEqual(15 - PRIVILEGED_POOL_HEADROOM)
    expect(LEGACY_DRAIN_CONCURRENCY).toBe(1)

    const greedy = planKernelSlots({ agent: 20, bulk: 10 }, 15)
    expect(greedy.scaledDown).toBe(true)
    expect(total(greedy.slots)).toBeLessThanOrEqual(15 - PRIVILEGED_POOL_HEADROOM)
    for (const n of Object.values(greedy.slots)) expect(n).toBeGreaterThanOrEqual(1)

    // A tiny pool still gives every class one slot.
    const tiny = planKernelSlots({}, 3)
    expect(Object.values(tiny.slots)).toEqual([1, 1, 1, 1])
  })

  it("parses per-class concurrency overrides and ignores junk", () => {
    expect(parseConcurrencyOverrides("agent=8, bulk=2,nope=3,cron=0,media=x")).toEqual({
      agent: 8,
      bulk: 2,
    })
    expect(parseConcurrencyOverrides(undefined)).toEqual({})
  })
})

describe("kernel queue classes: isolation", () => {
  afterAll(async () => {
    await closeAllQueues()
  })

  it("a cron job runs at once while a bulk backlog is queued", async () => {
    const BULK = 150
    const BULK_MS = 40
    const bulkQueue = getJobQueue("kernel", "search-index-upsert")
    await bulkQueue.obliterate({ force: true })
    let bulkDone = 0
    registerJobWorker("kernel", "search-index-upsert", async () => {
      await new Promise((r) => setTimeout(r, BULK_MS))
      bulkDone++
    })
    let cronWaitMs = -1
    let bulkDoneAtCron = -1
    // The cron queue is shared with whatever else ran in this process or left work in Redis
    // (the sweep's own every-minute scheduler, another file's delayed job), and such a job
    // carries no start time. Only the job this test enqueued is measured.
    const token = crypto.randomUUID()
    const cronRan = new Promise<void>((resolve) => {
      registerJobWorker(
        "kernel",
        "local-claim-lapse-sweep",
        async (p: { t?: number; token?: string } | undefined) => {
          if (p?.token !== token || typeof p.t !== "number") return
          cronWaitMs = Date.now() - p.t
          bulkDoneAtCron = bulkDone
          resolve()
        },
      )
    })
    // A tick as the scheduler enqueues it, ahead of the measured job.
    await enqueueAppJob("kernel", "local-claim-lapse-sweep", {})
    for (let i = 0; i < BULK; i++) await enqueueAppJob("kernel", "search-index-upsert", { i })
    await enqueueAppJob("kernel", "local-claim-lapse-sweep", { t: Date.now(), token })
    await cronRan
    // One shared FIFO queue made the cron wait for the whole backlog
    // (150 x 40 ms / 5 slots = 1.2 s); on its own class it starts at once.
    expect(bulkDoneAtCron).toBeLessThan(BULK / 2)
    expect(cronWaitMs).toBeLessThan(500)
    await JobsTestAccess.getWorkerForQueue("kernel-bulk")?.close(true)
    await bulkQueue.obliterate({ force: true })
  }, 30_000)
})
