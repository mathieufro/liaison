// SPDX-License-Identifier: FSL-1.1-ALv2
// The load harness's fan-out report (fanout-report.ts) and the per-org run
// counters it reads (fanout-keys.ts): judged from Redis keys alone.
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { redis } from "~/lib/redis"
import { histogramP95Ms, waitBucket } from "./fairness"
import { expectedEpochs, maxSlicePct, spreadDelays, spreadWindowMs } from "./fanout"
import {
  countFanoutRun,
  countFanoutRunsFor,
  fanoutCoalescedKey,
  fanoutRunAtKey,
  fanoutRunsKey,
  fanoutSkippedKey,
  fanoutSpreadOrgsKey,
  fanoutStartsKey,
  fanoutTestState,
  fanoutWatchKey,
  uncountFanoutRun,
  watchFanoutEpoch,
} from "./fanout-keys"
import { buildFanoutReport, FanoutReportTestAccess, summariseSyntheticDrain } from "./fanout-report"

const written: string[] = []
async function setKey(key: string, value: string): Promise<void> {
  written.push(key)
  await redis.set(key, value, "EX", 600)
}

afterEach(() => {
  FanoutReportTestAccess.setSchedulers(undefined)
  fanoutTestState.listOrgs = undefined
  fanoutTestState.isLoadOrg = undefined
})

afterAll(async () => {
  if (written.length > 0) await redis.del(...written)
})

describe("the fan-out report", () => {
  it("the report counts a doubled and a missed epoch from fixture keys", async () => {
    const app = `rep${crypto.randomUUID().slice(0, 8)}`
    const job = "tick"
    const orgs = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]
    // Three */5 epochs, all closed long ago.
    const base = Date.UTC(2026, 0, 1, 10, 0, 0)
    const epochs = [base, base + 300_000, base + 600_000]
    FanoutReportTestAccess.setSchedulers(
      async () => [{ template: { app, job, cron: "*/5 * * * *" } }],
      async () => 7,
    )
    // The three report orgs plus one org the report was not asked about.
    fanoutTestState.listOrgs = async () => [
      ...orgs.map((orgId) => ({ orgId, status: null })),
      { orgId: crypto.randomUUID(), status: "active" as const },
    ]
    for (const e of epochs) {
      for (const [i, orgId] of orgs.entries()) {
        // org 1 misses the second epoch; org 2 runs the third twice;
        // org 0 is coalesced on the third.
        if (i === 1 && e === epochs[1]) continue
        if (i === 0 && e === epochs[2]) {
          await setKey(fanoutCoalescedKey(app, job, orgId, e), "1")
          continue
        }
        const runs = i === 2 && e === epochs[2] ? 2 : 1
        await setKey(fanoutRunsKey(app, job, orgId, e), String(runs))
        await setKey(fanoutRunAtKey(app, job, orgId, e), String(e + 1_000 * (i + 1)))
      }
    }
    const report = await buildFanoutReport({
      orgIds: orgs,
      fromMs: base,
      toMs: base + 600_000,
      queues: ["kernel-agent"],
      now: base + 3_600_000,
    })
    const row = report.byJob[`${app}:${job}`]
    expect(row).toBeDefined()
    expect(row?.epochs).toBe(3)
    expect(row?.expected).toBe(9)
    expect(row?.missed).toBe(1)
    expect(row?.doubled).toBe(1)
    expect(row?.coalesced).toBe(1)
    expect(row?.runs).toBe(8)
    expect(report.missedRuns).toEqual([
      { app, job, orgId: orgs[1] as string, epoch: epochs[1] as number, runs: 0 },
    ])
    expect(report.doubledRuns[0]).toMatchObject({ orgId: orgs[2], epoch: epochs[2], runs: 2 })
    expect(report.totals).toMatchObject({ missed: 1, doubled: 1, coalesced: 1, notDue: 0 })
    expect(report.schedulers).toBe(7)
    expect(report.fanoutSchedulers).toBe(1)

    // An epoch whose spread window has not closed is not judged.
    const early = await buildFanoutReport({
      orgIds: orgs,
      fromMs: base,
      toMs: base + 600_000,
      queues: [],
      now: base + 600_000 + 1_000,
    })
    expect(early.byJob[`${app}:${job}`]).toMatchObject({ missed: 1, notDue: 3, expected: 6 })
  })

  it("an org the tick skipped on runsFor is not missed; the spread is judged on the orgs the tick ran", async () => {
    const app = `rf${crypto.randomUUID().slice(0, 8)}`
    const job = "tick"
    const ran = Array.from({ length: 5 }, () => crypto.randomUUID())
    const skipped = crypto.randomUUID()
    const nonLoad = crypto.randomUUID()
    // One */5 epoch, closed long ago. The box has 20 eligible orgs; the tick ran 5.
    const epoch = Date.UTC(2026, 0, 1, 11, 0, 0)
    FanoutReportTestAccess.setSchedulers(
      async () => [{ template: { app, job, cron: "*/5 * * * *" } }],
      async () => 1,
    )
    const others: string[] = Array.from({ length: 13 }, () => crypto.randomUUID())
    fanoutTestState.listOrgs = async () =>
      [...ran, skipped, nonLoad, ...others].map((orgId) => ({ orgId, status: null }))
    fanoutTestState.isLoadOrg = async (o) => o !== nonLoad && !others.includes(o)
    written.push(
      fanoutSkippedKey(app, job, skipped, epoch),
      fanoutSkippedKey(app, job, nonLoad, epoch),
      fanoutSpreadOrgsKey(app, job, epoch),
    )
    await countFanoutRunsFor(app, job, [skipped, nonLoad], ran.length, epoch)
    expect(await redis.get(fanoutSkippedKey(app, job, skipped, epoch))).toBe("1")
    expect(await redis.get(fanoutSkippedKey(app, job, nonLoad, epoch))).toBeNull()
    expect(await redis.get(fanoutSpreadOrgsKey(app, job, epoch))).toBe("5")
    // The 5 runs spread over the tick's own window (5 orgs x 2 s = 10 s): one per 2 s.
    for (const [i, orgId] of ran.entries()) {
      await setKey(fanoutRunsKey(app, job, orgId, epoch), "1")
      await setKey(fanoutRunAtKey(app, job, orgId, epoch), String(epoch + 1_000 + 2_000 * i))
    }
    const report = await buildFanoutReport({
      orgIds: [...ran, skipped],
      fromMs: epoch,
      toMs: epoch + 60_000,
      queues: [],
      now: epoch + 3_600_000,
    })
    expect(report.byJob[`${app}:${job}`]).toMatchObject({
      expected: 5,
      runs: 5,
      missed: 0,
      skippedRunsFor: 1,
      spreadMaxSlicePct: 20,
    })
    expect(report.totals).toMatchObject({ missed: 0, skippedRunsFor: 1 })
    expect(report.missedRuns).toEqual([])
  })

  it("the spread is the tick's: judged on every org it ran, not on the load orgs' sample of its ranks", async () => {
    // A tick of 22 orgs on a */5 job spreads them by rank, one every 2 s over
    // 44 s, so no tenth holds more than 3 of 22 (13.6 %). 10 of them are load
    // orgs; when 3 load orgs hold neighbouring ranks in one tenth, the load
    // orgs alone read 3 of 10 (30 %, over the 20 % bar) though the tick is even.
    const job = "tick"
    const epoch = Date.UTC(2026, 0, 1, 12, 0, 0)
    const gapMs = 300_000
    let app = ""
    let orgs: string[] = []
    let load: string[] = []
    for (let tries = 0; load.length === 0 && tries < 500; tries++) {
      app = `sp${crypto.randomUUID().slice(0, 8)}`
      orgs = Array.from({ length: 22 }, () => crypto.randomUUID())
      const w = spreadWindowMs(gapMs, orgs.length)
      const delays = spreadDelays(orgs, app, job, w)
      const byTenth = new Map<number, string[]>()
      for (const [orgId, d] of delays) {
        // Bucketed where the report reads the start: 50 ms after the planned delay (below).
        const tenth = Math.min(9, Math.floor(((d + 50) / w) * 10))
        byTenth.set(tenth, [...(byTenth.get(tenth) ?? []), orgId])
      }
      const full = [...byTenth.values()].find((ids) => ids.length === 3)
      if (!full) continue
      const rest = orgs.filter((o) => !full.includes(o)).slice(0, 7)
      load = [...full, ...rest]
    }
    expect(load).toHaveLength(10)
    const windowMs = spreadWindowMs(gapMs, orgs.length)
    const delays = spreadDelays(orgs, app, job, windowMs)
    FanoutReportTestAccess.setSchedulers(
      async () => [{ template: { app, job, cron: "*/5 * * * *" } }],
      async () => 1,
    )
    fanoutTestState.listOrgs = async () => orgs.map((orgId) => ({ orgId, status: null }))
    fanoutTestState.isLoadOrg = async (o) => load.includes(o)
    // Each org starts 50 ms after its planned delay.
    for (const orgId of load) {
      await setKey(fanoutRunsKey(app, job, orgId, epoch), "1")
      await setKey(
        fanoutRunAtKey(app, job, orgId, epoch),
        String(epoch + (delays.get(orgId) ?? 0) + 50),
      )
    }
    const input = {
      orgIds: load,
      fromMs: epoch,
      toMs: epoch + 60_000,
      queues: [],
      now: epoch + 3_600_000,
    }
    // Unwatched (no record of the tick's other runs): the load orgs' sample.
    const sample = await buildFanoutReport(input)
    expect(sample.byJob[`${app}:${job}`]).toMatchObject({
      runs: 10,
      spreadMaxSlicePct: 30,
      spreadStarts: 10,
    })

    // Watched: the tick recorded every org's start.
    written.push(fanoutWatchKey(app, job, epoch), fanoutStartsKey(app, job, epoch))
    await watchFanoutEpoch(app, job, orgs, epoch)
    expect(await redis.get(fanoutWatchKey(app, job, epoch))).toBe("22")
    for (const orgId of orgs) {
      await redis.hset(
        fanoutStartsKey(app, job, epoch),
        orgId,
        String(epoch + (delays.get(orgId) ?? 0) + 50),
      )
    }
    const tick = await buildFanoutReport(input)
    const row = tick.byJob[`${app}:${job}`]
    expect(row).toMatchObject({ runs: 10, missed: 0, doubled: 0, spreadStarts: 22 })
    expect(row?.spreadMaxSlicePct).toBeLessThanOrEqual(13.6)
    expect(tick.totals.spreadStarts).toBe(22)

    // Late starts still fail it: every org starting at the window's end clumps the tick.
    for (const orgId of orgs) {
      await redis.hset(fanoutStartsKey(app, job, epoch), orgId, String(epoch + windowMs + 1_000))
    }
    const late = await buildFanoutReport(input)
    expect(late.byJob[`${app}:${job}`]?.spreadMaxSlicePct).toBe(100)
  })

  it("a watched epoch records every org's first start; an unwatched one records none", async () => {
    const loadOrg = crypto.randomUUID()
    const otherOrg = crypto.randomUUID()
    fanoutTestState.isLoadOrg = async (o) => o === loadOrg
    const watched = 1_700_000_600_000
    const unwatched = 1_700_000_900_000
    const id = (org: string, e: number) => `fo.ws.tick.${org}.${e}`
    written.push(
      fanoutWatchKey("ws", "tick", watched),
      fanoutStartsKey("ws", "tick", watched),
      fanoutWatchKey("ws", "tick", unwatched),
      fanoutStartsKey("ws", "tick", unwatched),
      fanoutRunsKey("ws", "tick", loadOrg, watched),
      fanoutRunAtKey("ws", "tick", loadOrg, watched),
      fanoutRunsKey("ws", "tick", loadOrg, unwatched),
      fanoutRunAtKey("ws", "tick", loadOrg, unwatched),
    )
    // A tick without a load org is not watched.
    await watchFanoutEpoch("ws", "tick", [otherOrg], unwatched)
    await watchFanoutEpoch("ws", "tick", [loadOrg, otherOrg], watched)
    expect(await redis.get(fanoutWatchKey("ws", "tick", unwatched))).toBeNull()
    expect(await redis.get(fanoutWatchKey("ws", "tick", watched))).toBe("2")
    for (const e of [watched, unwatched]) {
      await countFanoutRun(id(loadOrg, e), 0)
      await countFanoutRun(id(otherOrg, e), 0)
    }
    const first = await redis.hgetall(fanoutStartsKey("ws", "tick", watched))
    expect(Object.keys(first).sort()).toEqual([loadOrg, otherOrg].sort())
    const runAt = await redis.get(fanoutRunAtKey("ws", "tick", loadOrg, watched))
    expect(runAt).not.toBeNull()
    expect(first[loadOrg]).toBe(runAt ?? "")
    expect(await redis.exists(fanoutStartsKey("ws", "tick", unwatched))).toBe(0)
    // A retry and a second start keep the first one.
    await countFanoutRun(id(otherOrg, watched), 1)
    await new Promise((r) => setTimeout(r, 5))
    await countFanoutRun(id(otherOrg, watched), 0)
    expect(await redis.hget(fanoutStartsKey("ws", "tick", watched), otherOrg)).toBe(
      first[otherOrg] ?? "",
    )
  })

  it("a load org's first attempt is counted once; a retry, a non-fo id and a non-load org are not", async () => {
    const loadOrg = crypto.randomUUID()
    const otherOrg = crypto.randomUUID()
    fanoutTestState.isLoadOrg = async (o) => o === loadOrg
    const epoch = 1_700_000_000_000
    const id = (org: string) => `fo.cnt.tick.${org}.${epoch}`
    written.push(
      fanoutRunsKey("cnt", "tick", loadOrg, epoch),
      fanoutRunAtKey("cnt", "tick", loadOrg, epoch),
      fanoutRunsKey("cnt", "tick", otherOrg, epoch),
    )
    await countFanoutRun(id(loadOrg), 0)
    await countFanoutRun(id(loadOrg), 1)
    await countFanoutRun(`n.${loadOrg}`, 0)
    await countFanoutRun(id(otherOrg), 0)
    expect(await redis.get(fanoutRunsKey("cnt", "tick", loadOrg, epoch))).toBe("1")
    expect(await redis.get(fanoutRunAtKey("cnt", "tick", loadOrg, epoch))).not.toBeNull()
    expect(await redis.get(fanoutRunsKey("cnt", "tick", otherOrg, epoch))).toBeNull()
    // A first attempt that starts again (a stalled job) is a doubled run.
    await countFanoutRun(id(loadOrg), 0)
    expect(await redis.get(fanoutRunsKey("cnt", "tick", loadOrg, epoch))).toBe("2")
  })

  it("a fan-out job handed back by a drain is taken back, so its rerun is not a double", async () => {
    const loadOrg = crypto.randomUUID()
    fanoutTestState.isLoadOrg = async (o) => o === loadOrg
    const epoch = 1_700_000_300_000
    const id = `fo.hb.tick.${loadOrg}.${epoch}`
    const key = fanoutRunsKey("hb", "tick", loadOrg, epoch)
    written.push(key, fanoutRunAtKey("hb", "tick", loadOrg, epoch))
    await countFanoutRun(id, 0)
    await uncountFanoutRun(id, 0)
    expect(await redis.get(key)).toBe("0")
    await countFanoutRun(id, 0)
    expect(await redis.get(key)).toBe("1")
    // A retry (attempt > 0) was never counted, so nothing is taken back.
    await uncountFanoutRun(id, 1)
    expect(await redis.get(key)).toBe("1")
  })

  it("expected epochs and the slice share are computed from the schedule", () => {
    const base = Date.UTC(2026, 0, 1, 10, 0, 0)
    expect(expectedEpochs({ cron: "*/10 * * * *" }, base, base + 1_800_000)).toEqual([
      base,
      base + 600_000,
      base + 1_200_000,
      base + 1_800_000,
    ])
    expect(expectedEpochs({ everyMs: 1_000, nextMs: base + 5_500 }, base, base + 3_000)).toEqual([
      base + 500,
      base + 1_500,
      base + 2_500,
    ])
    expect(maxSlicePct([0, 10, 20, 30, 40, 50, 60, 70, 80, 90], 100)).toBe(10)
    expect(maxSlicePct([0, 1, 2, 3, 90], 100)).toBe(80)
    expect(maxSlicePct([], 100)).toBe(0)
  })

  it("a p95 under 4.5 s reads under the 5 s bound; one between 4.5 and 5 s reads 5 s", () => {
    const hist = (ms: number, n = 100) => ({ [waitBucket(ms)]: n })
    expect(histogramP95Ms(hist(4_400))).toBe(4_500)
    expect(histogramP95Ms(hist(4_600))).toBe(5_000)
    expect(histogramP95Ms({ ...hist(200, 95), ...hist(70_000, 5) })).toBe(250)
    expect(histogramP95Ms({ ...hist(200, 94), ...hist(70_000, 6) })).toBe(60_001)
  })

  it("the synthetic drain: rate over the window's completion seconds, dispatch and timer lag p95", () => {
    const s0 = 1_800_000_000
    const timings = [
      ...Array.from({ length: 19 }, (_, i) => ({ second: s0 + (i % 10), dispatchMs: 5, lagMs: 1 })),
      { second: s0 + 9, dispatchMs: 400, lagMs: 900 },
      // Outside the window: not counted.
      { second: s0 + 60, dispatchMs: 9_999, lagMs: 9_999 },
    ]
    expect(summariseSyntheticDrain(timings, s0 * 1000, (s0 + 10) * 1000 - 1)).toEqual({
      runs: 20,
      ratePerSec: 2,
      dispatchP95Ms: 400,
      dispatchMaxMs: 400,
      lagP95Ms: 900,
      lagMaxMs: 900,
    })
    expect(summariseSyntheticDrain(timings, 0, 1_000)).toBeNull()
  })
})
