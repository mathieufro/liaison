// SPDX-License-Identifier: FSL-1.1-ALv2
// The fairness gate (fairness.ts) against real Redis and BullMQ: stage 1's turn
// order at enqueue, stage 2's cap under contention with parking and promotion,
// tokens, trusted nesting and failing open. Every test has its own queue.
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { DelayedError, Job, Queue, Worker } from "bullmq"
import Redis from "ioredis"
import { env } from "~/lib/env"
import { bullPrefix, REDIS_PREFIX, RESP_PROTOCOL, redis, redisBullMQ } from "~/lib/redis"
import {
  FAIR_TIER,
  FairnessTestAccess,
  fairEnqueue,
  NESTED_PRIORITY,
  parkDelayMs,
  readQueueFairness,
  releaseToken,
  renewTokens,
  tryAdmit,
} from "./fairness"
import { runAsJob } from "./job-origin"
import { addFanoutJobs } from "./jobs"

const uuid = () => crypto.randomUUID()
const rand = () => Math.random().toString(36).slice(2, 8)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const K = FairnessTestAccess.keys

const queues: Queue[] = []
const workers: Worker[] = []
const extraClients: Redis[] = []

const sharedQueues: Queue[] = []
/** A fresh app queue (obliterated at the end), or a named shared one (never obliterated). */
function freshQueue(name?: string): Queue {
  const q = new Queue(name ?? `app-fairtest-${rand()}`, {
    connection: redisBullMQ,
    prefix: bullPrefix,
  })
  ;(name ? sharedQueues : queues).push(q)
  return q
}

const orgJob = (orgId: string, i: number, priority?: number, delay?: number) => ({
  name: "work",
  data: { orgId, i },
  opts: { ...(priority ? { priority } : {}), ...(delay ? { delay } : {}) },
})

/** A worker that records the order it runs jobs in (no gate). */
function orderWorker(q: Queue, order: string[]): Worker {
  const w = new Worker(
    q.name,
    async (job) => {
      order.push(`${job.data.orgId ?? "none"}:${job.data.i}`)
    },
    { connection: redisBullMQ, prefix: bullPrefix, concurrency: 1 },
  )
  workers.push(w)
  return w
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const start = Date.now()
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error("waitFor: condition never met")
    await sleep(10)
  }
}

afterEach(async () => {
  for (const w of workers.splice(0)) await w.close(true)
  FairnessTestAccess.reset()
})
afterAll(async () => {
  for (const q of queues) await q.obliterate({ force: true }).catch(() => {})
  for (const q of [...queues, ...sharedQueues]) await q.close()
  for (const c of extraClients) c.disconnect()
})

describe("stage 1: turns at enqueue", () => {
  it("A's 100 jobs then B's 1: one worker runs A1, B1, A2 (fairness off: B runs 101st)", async () => {
    const A = uuid()
    const B = uuid()
    for (const on of [true, false]) {
      FairnessTestAccess.setEnabled(on)
      const q = freshQueue()
      await fairEnqueue(
        q,
        Array.from({ length: 100 }, (_, i) => orgJob(A, i + 1)),
      )
      await fairEnqueue(q, [orgJob(B, 1)])
      const order: string[] = []
      orderWorker(q, order)
      await waitFor(() => order.length === 101)
      if (on) expect(order.slice(0, 3)).toEqual([`${A}:1`, `${B}:1`, `${A}:2`])
      else expect(order.indexOf(`${B}:1`)).toBe(100)
    }
  })

  it("tiers keep the class order: orgless unprioritized first, then an org's unprioritized job, then any YIELD job", async () => {
    const q = freshQueue()
    const A = uuid()
    await fairEnqueue(q, [orgJob(A, 1, 10)])
    await fairEnqueue(q, [orgJob(uuid(), 2, 5)])
    await fairEnqueue(q, [orgJob(A, 3)])
    await fairEnqueue(q, [{ name: "work", data: { i: 4 }, opts: {} }])
    const order: string[] = []
    orderWorker(q, order)
    await waitFor(() => order.length === 4)
    expect(order.map((o) => o.split(":")[1])).toEqual(["4", "3", "2", "1"])
    expect(FAIR_TIER[0] < FAIR_TIER[5] && FAIR_TIER[5] < FAIR_TIER[10]).toBe(true)
  })

  it("a deduplicated add leaves fair:q unchanged", async () => {
    const q = freshQueue()
    const A = uuid()
    const job = { name: "work", data: { orgId: A }, opts: { deduplication: { id: "same" } } }
    const [first] = await fairEnqueue(q, [job])
    const [second] = await fairEnqueue(q, [job])
    expect(second?.id).toBe(first?.id)
    expect(await redis.zcard(K.qKey(q.name, A))).toBe(1)
  })
})

describe("cron fan-out behind the sweeps (T6, M5)", () => {
  it("with 300 per-org materialize jobs queued, an every-minute sweep enqueued after them starts first (fairness off: last)", async () => {
    for (const on of [true, false]) {
      FairnessTestAccess.setEnabled(on)
      const q = freshQueue()
      const epoch = Date.now()
      await addFanoutJobs(
        q.name,
        Array.from({ length: 300 }, (_, i) => ({
          name: "attention-state-email-materialize-org",
          data: { orgId: uuid(), i },
          jobId: `fo.attn.mat.${i}.${epoch}`,
          delay: 0,
          attempts: 3,
          backoff: { type: "exponential", delay: 1000 },
          retainMs: 600_000,
        })),
      )
      await fairEnqueue(q, [{ name: "approval-expiry-sweep", data: { i: "sweep" }, opts: {} }])
      const order: string[] = []
      orderWorker(q, order)
      await waitFor(() => order.length === 301)
      expect(order.indexOf("none:sweep")).toBe(on ? 0 : 300)
    }
  })
})

describe("stage 2: the cap under contention", () => {
  async function admitAll(q: Queue, orgId: string, ids: string[]): Promise<number> {
    let n = 0
    for (const id of ids) if ((await tryAdmit(q.name, orgId, id, uuid())).admitted) n++
    return n
  }

  it("a lone org with 2×C jobs gets C admitted", async () => {
    FairnessTestAccess.setCellConcurrency(4)
    const q = freshQueue()
    const A = uuid()
    const jobs = await fairEnqueue(
      q,
      Array.from({ length: 8 }, (_, i) => orgJob(A, i)),
    )
    expect(
      await admitAll(
        q,
        A,
        jobs.map((j) => j.id as string),
      ),
    ).toBe(4)
  })

  it("another org's due waiting job caps the busy org at ceil(C/2); its delayed job does not", async () => {
    FairnessTestAccess.setCellConcurrency(4)
    const A = uuid()
    const q1 = freshQueue()
    const a1 = await fairEnqueue(
      q1,
      Array.from({ length: 8 }, (_, i) => orgJob(A, i)),
    )
    await fairEnqueue(q1, [orgJob(uuid(), 1)])
    expect(
      await admitAll(
        q1,
        A,
        a1.map((j) => j.id as string),
      ),
    ).toBe(2)

    const q2 = freshQueue()
    const a2 = await fairEnqueue(
      q2,
      Array.from({ length: 8 }, (_, i) => orgJob(A, i)),
    )
    await fairEnqueue(q2, [orgJob(uuid(), 1, undefined, 60_000)])
    expect(
      await admitAll(
        q2,
        A,
        a2.map((j) => j.id as string),
      ),
    ).toBe(4)
  })

  it("a job enqueued with no delay is due at once on the gate's clock, even from a producer whose clock runs ahead", async () => {
    // Stage 2 reads "now" from Redis; a producer a few ms ahead of it (another
    // host, or the same host's clock against a container's) must not record its
    // fresh job as due in the future, or the busy org runs past ceil(C/2).
    FairnessTestAccess.setCellConcurrency(4)
    const A = uuid()
    const q = freshQueue()
    const a = await fairEnqueue(
      q,
      Array.from({ length: 8 }, (_, i) => orgJob(A, i)),
    )
    const realNow = Date.now
    Date.now = () => realNow() + 5_000
    try {
      await fairEnqueue(q, [orgJob(uuid(), 1)])
    } finally {
      Date.now = realNow
    }
    expect(
      await admitAll(
        q,
        A,
        a.map((j) => j.id as string),
      ),
    ).toBe(2)
  })

  it("an org whose fair:q expired drops out of fair:orgs", async () => {
    FairnessTestAccess.setCellConcurrency(4)
    const q = freshQueue()
    const A = uuid()
    const ghost = uuid()
    await redis.zadd(K.orgsKey(q.name), Date.now() - 1000, ghost)
    const jobs = await fairEnqueue(
      q,
      Array.from({ length: 4 }, (_, i) => orgJob(A, i)),
    )
    expect(
      await admitAll(
        q,
        A,
        jobs.map((j) => j.id as string),
      ),
    ).toBe(4)
    expect(await redis.zscore(K.orgsKey(q.name), ghost)).toBeNull()
  })

  it("release promotes one parked job of the same org; it starts within 200 ms", async () => {
    FairnessTestAccess.setCellConcurrency(1)
    const q = freshQueue()
    const A = uuid()
    const started = new Map<number, number>()
    let releaseFirst: () => void = () => {}
    const firstHeld = new Promise<void>((r) => {
      releaseFirst = r
    })
    const w = new Worker(
      q.name,
      async (job: Job, token?: string) => {
        const v = await tryAdmit(q.name, job.data.orgId, job.id as string, token as string)
        if (!v.admitted) {
          // The safety-net timer is a minute away: only a promotion brings it back.
          await job.moveToDelayed(Date.now() + 60_000, token)
          throw new DelayedError()
        }
        started.set(job.data.i, Date.now())
        try {
          if (job.data.i === 1) await firstHeld
        } finally {
          await releaseToken(q.name, job.data.orgId, v.member, async (id) => {
            const parked = await Job.fromId(q, id)
            if (!parked || !(await parked.isDelayed())) return false
            await parked.promote()
            return true
          })
        }
      },
      { connection: redisBullMQ, prefix: bullPrefix, concurrency: 2 },
    )
    workers.push(w)
    await fairEnqueue(q, [orgJob(A, 1), orgJob(A, 2)])
    await waitFor(() => started.has(1))
    await waitFor(async () => (await redis.zcard(K.parkKey(q.name, A))) === 1)
    const releasedAt = Date.now()
    releaseFirst()
    await waitFor(() => started.has(2), 5_000)
    expect((started.get(2) as number) - releasedAt).toBeLessThan(200)
  })

  it("one over the cap after 100 denials: parked < 1 s (the delay follows the backlog, not the history)", async () => {
    FairnessTestAccess.setCellConcurrency(1)
    const q = freshQueue()
    const A = uuid()
    const [j1, j2] = await fairEnqueue(q, [orgJob(A, 1), orgJob(A, 2)])
    expect((await tryAdmit(q.name, A, j1?.id as string, "t1")).admitted).toBe(true)
    for (let i = 0; i < 100; i++) {
      const v = await tryAdmit(q.name, A, j2?.id as string, `t2-${i}`)
      expect(v.admitted).toBe(false)
      if (!v.admitted) expect(v.parkMs).toBeLessThan(1_000)
    }
  })

  it("park delays at P = 10 000 spread over [0, 60 s) with no 1 s bucket above 3 %", () => {
    // 60 000 draws: a fair bucket holds 1 000 +- 32, so 3 % (1 800) is never hit by chance
    // (1 000 draws flaked: the max of 60 buckets of mean 17 passes 30 a few % of runs).
    const draws = 60_000
    const buckets = new Array(60).fill(0)
    for (let i = 0; i < draws; i++) {
      const d = parkDelayMs(10_000)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(60_000)
      buckets[Math.floor(d / 1000)]++
    }
    expect(Math.max(...buckets)).toBeLessThanOrEqual(draws * 0.03)
  })
})

describe("tokens", () => {
  it("an expired token is pruned; renew keeps a long job's token; renew after release does not resurrect", async () => {
    FairnessTestAccess.setCellConcurrency(1)
    FairnessTestAccess.setTokenTtlMs(300)
    const q = freshQueue()
    const A = uuid()
    // Expired: a token never renewed (a SIGKILLed holder) frees the slot after its TTL.
    const v1 = await tryAdmit(q.name, A, "j1", "t1")
    expect(v1.admitted).toBe(true)
    expect((await tryAdmit(q.name, A, "j2", "t2")).admitted).toBe(false)
    await sleep(400)
    const v2 = await tryAdmit(q.name, A, "j2", "t2")
    expect(v2.admitted).toBe(true)
    // Renewed: a long job keeps its token past the TTL.
    for (let i = 0; i < 4; i++) {
      await sleep(150)
      await renewTokens()
    }
    expect((await tryAdmit(q.name, A, "j3", "t3")).admitted).toBe(false)
    // Released, then renewed: the token stays gone.
    if (v2.admitted) await releaseToken(q.name, A, v2.member, async () => false)
    await renewTokens()
    expect(await redis.zscore(K.tokKey(q.name, A), "j2|t2")).toBeNull()
  })

  it("hand back, readmit on another token, old release: the org still holds 1", async () => {
    FairnessTestAccess.setCellConcurrency(4)
    const q = freshQueue()
    const A = uuid()
    const first = await tryAdmit(q.name, A, "j1", "lock-a")
    if (!first.admitted) throw new Error("not admitted")
    await releaseToken(q.name, A, first.member, async () => false)
    const again = await tryAdmit(q.name, A, "j1", "lock-b")
    expect(again.admitted).toBe(true)
    await releaseToken(q.name, A, first.member, async () => false)
    expect(await redis.zcard(K.tokKey(q.name, A))).toBe(1)
  })

  it("two processes racing 100 tryAdmit never exceed the limit", async () => {
    const q = freshQueue()
    const A = uuid()
    const other = new Redis(env.REDIS_URL, { keyPrefix: REDIS_PREFIX, protocol: RESP_PROTOCOL })
    extraClients.push(other)
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        FairnessTestAccess.admitWith(i % 2 === 0 ? redis : other, q.name, A, `j${i}`, "t", 8),
      ),
    )
    expect(results.filter(Boolean).length).toBe(8)
    expect(await redis.zcard(K.tokKey(q.name, A))).toBe(8)
  })

  it("only the first admission ZREMs fair:q (and so records the wait)", async () => {
    FairnessTestAccess.setCellConcurrency(4)
    const q = freshQueue()
    const A = uuid()
    const [job] = await fairEnqueue(q, [orgJob(A, 1)])
    const id = job?.id as string
    const v1 = await tryAdmit(q.name, A, id, "a")
    expect(v1.admitted && v1.first).toBe(true)
    if (v1.admitted) await releaseToken(q.name, A, v1.member, async () => false)
    const v2 = await tryAdmit(q.name, A, id, "b")
    expect(v2.admitted && !v2.first).toBe(true)
  })
})

describe("trusted nesting", () => {
  it("a sub-run enqueued from an admitted job is minted nested and admitted over the cap up to cap × 2, then parked", async () => {
    FairnessTestAccess.setCellConcurrency(2)
    const q = freshQueue("kernel-agent")
    // Nesting needs a kernel queue, and this process hosts a worker on it once any
    // earlier file in the same process registered a kernel-agent handler. That
    // worker would take B's job and run it, and B would no longer be waiting.
    // Paused, the queue keeps B's job waiting whatever ran before this file.
    await q.pause()
    try {
      const A = uuid()
      // The parent holds the org's only token (cap 1: org B has a due job waiting).
      const B = uuid()
      const [bJob] = await fairEnqueue(q, [{ name: "agent-subrun", data: { orgId: B }, opts: {} }])
      expect((await tryAdmit(q.name, A, "parent", "p")).admitted).toBe(true)
      const children = await runAsJob(
        null,
        () =>
          fairEnqueue(
            q,
            Array.from({ length: 3 }, (_, i) => ({
              name: "agent-subrun",
              data: { orgId: A, i },
              // Kept out of any worker's reach.
              opts: { delay: 3_600_000 },
            })),
          ),
        { queue: q.name, orgId: A, jobId: "parent", admitted: true },
      )
      expect(children.every((c) => c.id?.startsWith("n."))).toBe(true)
      expect(children.every((c) => c.opts.priority === NESTED_PRIORITY)).toBe(true)
      const verdicts = []
      for (const c of children) verdicts.push(await tryAdmit(q.name, A, c.id as string, "x"))
      expect(verdicts.map((v) => v.admitted)).toEqual([true, true, false])
      for (const c of children) await c.remove()
      await bJob?.remove()
      await redis.del(K.qKey(q.name, B), K.tokKey(q.name, A), K.ntokKey(q.name, A))
      await redis.zrem(K.orgsKey(q.name), B, A)
    } finally {
      await q.resume()
    }
  })

  it("an n. id without a fair:nested entry is gated like any job", async () => {
    FairnessTestAccess.setCellConcurrency(1)
    const q = freshQueue("kernel-agent")
    const A = uuid()
    expect((await tryAdmit(q.name, A, "j1", "t")).admitted).toBe(true)
    expect((await tryAdmit(q.name, A, `n.${uuid()}`, "t")).admitted).toBe(false)
    await redis.del(K.tokKey(q.name, A), K.parkKey(q.name, A))
  })

  it("an app job enqueued from inside an admitted app job of the same org is not nested", async () => {
    const q = freshQueue()
    const A = uuid()
    const [child] = await runAsJob(null, () => fairEnqueue(q, [orgJob(A, 1)]), {
      queue: q.name,
      orgId: A,
      jobId: "parent",
      admitted: true,
    })
    expect(child?.id?.startsWith("n.")).toBe(false)
    expect(child?.opts.priority).toBe(FAIR_TIER[0] + 1)
  })
})

describe("stale turn records", () => {
  /** A job run with no gate (failed open, or a worker of an older release) leaves its entry behind. */
  it("another org's entries whose jobs are gone or finished do not cap a lone org (and are pruned)", async () => {
    FairnessTestAccess.setCellConcurrency(4)
    const q = freshQueue()
    const A = uuid()
    const B = uuid()
    const [gone, finished] = await fairEnqueue(q, [orgJob(B, 1), orgJob(B, 2)])
    await gone?.remove()
    await redisBullMQ.hset(`${bullPrefix}:${q.name}:${finished?.id}`, "finishedOn", Date.now())
    const jobs = await fairEnqueue(
      q,
      Array.from({ length: 8 }, (_, i) => orgJob(A, i)),
    )
    let n = 0
    for (const j of jobs) if ((await tryAdmit(q.name, A, j.id as string, uuid())).admitted) n++
    expect(n).toBe(4)
    expect(await redis.zcard(K.qKey(q.name, B))).toBe(0)
  })

  it("a waiting org behind a full look-ahead of stale orgs still caps a busy org", async () => {
    FairnessTestAccess.setCellConcurrency(4)
    const q = freshQueue()
    const A = uuid()
    const B = uuid()
    const aJobs = await fairEnqueue(
      q,
      Array.from({ length: 3 }, (_, i) => orgJob(A, i)),
    )
    // Alone, A takes the cap (2) without contention.
    for (const j of aJobs.slice(0, 2)) {
      expect((await tryAdmit(q.name, A, j.id as string, uuid())).admitted).toBe(true)
    }
    // Four orgs whose jobs ran ungated (their entries stale), due before B's waiting job.
    const stale = Array.from({ length: 4 }, () => uuid())
    for (const D of stale) {
      const [d] = await fairEnqueue(q, [orgJob(D, 1)])
      await d?.remove()
      await sleep(2)
    }
    await fairEnqueue(q, [orgJob(B, 1)])
    // B waits behind the stale orgs: A is held to the cap, not given C.
    expect((await tryAdmit(q.name, A, aJobs[2]?.id as string, uuid())).admitted).toBe(false)
    // The window (A itself and the first three) was checked and its stale orgs pruned.
    for (const D of stale.slice(0, 3)) expect(await redis.zscore(K.orgsKey(q.name), D)).toBeNull()
  })

  it("a fail-open admit drops the job's entry, and the token of an admit that answered late", async () => {
    FairnessTestAccess.setCellConcurrency(4)
    const q = freshQueue()
    const A = uuid()
    const [j1, j2] = await fairEnqueue(q, [orgJob(A, 1), orgJob(A, 2)])
    // eval refused: the gate never ran.
    const refusing = new Proxy(redis, {
      get(target, prop) {
        if (prop === "eval") return () => Promise.reject(new Error("redis says no"))
        const v = Reflect.get(target, prop)
        return typeof v === "function" ? v.bind(target) : v
      },
    })
    FairnessTestAccess.setClient(refusing)
    const v1 = await tryAdmit(q.name, A, j1?.id as string, "t1")
    expect(v1.admitted && v1.member === null).toBe(true)
    // eval ran, but its answer came after the 250 ms budget.
    const slow = new Proxy(redis, {
      get(target, prop) {
        if (prop === "eval")
          return (...args: Parameters<typeof redis.eval>) =>
            target.eval(...args).then(async (r) => {
              await sleep(400)
              return r
            })
        const v = Reflect.get(target, prop)
        return typeof v === "function" ? v.bind(target) : v
      },
    })
    FairnessTestAccess.setClient(slow)
    const v2 = await tryAdmit(q.name, A, j2?.id as string, "t2")
    expect(v2.admitted && v2.member === null).toBe(true)
    FairnessTestAccess.setClient(undefined)
    await waitFor(
      async () =>
        (await redis.zcard(K.qKey(q.name, A))) === 0 &&
        (await redis.zcard(K.tokKey(q.name, A))) === 0,
      2_000,
    )
  })

  it("/diag counts: denied is the lifetime count, parkedNow the jobs parked now", async () => {
    FairnessTestAccess.setCellConcurrency(1)
    const q = freshQueue()
    const A = uuid()
    const B = uuid()
    const [b] = await fairEnqueue(q, [orgJob(B, 1)])
    const [a1, a2, a3] = await fairEnqueue(q, [orgJob(A, 1), orgJob(A, 2), orgJob(A, 3)])
    expect((await tryAdmit(q.name, A, a1?.id as string, "t")).admitted).toBe(true)
    expect((await tryAdmit(q.name, A, a2?.id as string, "t")).admitted).toBe(false)
    expect((await tryAdmit(q.name, A, a3?.id as string, "t")).admitted).toBe(false)
    let f = await readQueueFairness(q.name)
    expect(f.denied).toBe(2)
    expect(f.parkedNow).toBe(2)
    await redis.zpopmin(K.parkKey(q.name, A), 1)
    f = await readQueueFairness(q.name)
    expect(f.denied).toBe(2)
    expect(f.parkedNow).toBe(1)
    expect("parked" in f).toBe(false)
    await b?.remove()
  })
})

describe("failing open and the escape", () => {
  it("a 250 ms timeout admits; JOB_ORG_FAIRNESS=off skips both stages", async () => {
    FairnessTestAccess.setCellConcurrency(1)
    const q = freshQueue()
    const A = uuid()
    const hung = new Proxy(redis, {
      get(target, prop) {
        if (prop === "eval") return () => new Promise(() => {})
        const v = Reflect.get(target, prop)
        return typeof v === "function" ? v.bind(target) : v
      },
    })
    FairnessTestAccess.setClient(hung)
    const t0 = Date.now()
    for (let i = 0; i < 3; i++)
      expect((await tryAdmit(q.name, A, `j${i}`, "t")).admitted).toBe(true)
    expect(Date.now() - t0).toBeLessThan(1_500)
    FairnessTestAccess.setClient(undefined)
    await waitFor(async () => (await readQueueFairness(q.name)).failopen >= 3, 2_000)
    expect((await readQueueFairness(q.name)).degraded).toBe(true)

    FairnessTestAccess.setEnabled(false)
    const [job] = await fairEnqueue(q, [orgJob(A, 1, 5)])
    expect(job?.opts.priority).toBe(5)
    expect(await redis.exists(K.qKey(q.name, A))).toBe(0)
    for (let i = 0; i < 3; i++) {
      const v = await tryAdmit(q.name, A, `k${i}`, "t")
      expect(v.admitted && v.member === null).toBe(true)
    }
  })
})
