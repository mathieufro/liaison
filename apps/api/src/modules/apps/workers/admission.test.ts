// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  poolBackgroundCap,
  WORKERS_MAX_IN_FLIGHT_PER_ORG,
  WORKERS_MAX_NESTED_BREADTH_PER_PARENT,
  WorkersAdmission,
} from "./admission"

const top = (orgId: string, extra: Record<string, unknown> = {}) => ({
  orgId,
  holdsTx: false,
  nested: false,
  waitMs: 5_000,
  ...extra,
})

describe("Workers admission", () => {
  it("defaults: 16 per org, 8 nested per parent, holdsTx at the pool's background cap", () => {
    const a = new WorkersAdmission()
    expect(a.getLimits()).toEqual({
      perOrg: WORKERS_MAX_IN_FLIGHT_PER_ORG,
      nestedBreadthPerParent: WORKERS_MAX_NESTED_BREADTH_PER_PARENT,
      holdsTxGlobal: poolBackgroundCap(),
    })
    expect(WORKERS_MAX_IN_FLIGHT_PER_ORG).toBe(16)
    expect(WORKERS_MAX_NESTED_BREADTH_PER_PARENT).toBe(8)
  })

  it("queues top-level runs past the per-org cap, FIFO, without blocking another org", async () => {
    const a = new WorkersAdmission({ perOrg: 1 })
    const r1 = await a.acquire(top("A"))
    const order: string[] = []
    const p2 = a.acquire(top("A")).then((r) => {
      order.push("A2")
      return r
    })
    const p3 = a.acquire(top("A")).then((r) => {
      order.push("A3")
      return r
    })
    const b = await a.acquire(top("B")) // another org is not behind A's queue
    expect(a.stats().queued).toBe(2)
    r1()
    const r2 = await p2
    expect(order).toEqual(["A2"])
    r2()
    ;(await p3)()
    b()
    expect(order).toEqual(["A2", "A3"])
    expect(a.stats()).toEqual({ orgs: {}, holdsTx: 0, queued: 0, nested: 0 })
  })

  it("caps holdsTx runs globally across orgs", async () => {
    const a = new WorkersAdmission({ holdsTxGlobal: 1 })
    const r1 = await a.acquire(top("A", { holdsTx: true }))
    let admitted = false
    const p = a.acquire(top("B", { holdsTx: true })).then((r) => {
      admitted = true
      return r
    })
    const free = await a.acquire(top("C")) // no tx: not capped
    await Promise.resolve()
    expect(admitted).toBe(false)
    r1()
    ;(await p)()
    free()
    expect(admitted).toBe(true)
  })

  it("never queues a nested run: admitted past every cap, refused past the breadth", async () => {
    const a = new WorkersAdmission({ perOrg: 1, holdsTxGlobal: 1, nestedBreadthPerParent: 1 })
    const parent = await a.acquire(top("A", { holdsTx: true }))
    const child = await a.acquire(top("A", { nested: true, holdsTx: true, nestedParentKey: "p1" }))
    await expect(a.acquire(top("A", { nested: true, nestedParentKey: "p1" }))).rejects.toThrow(
      /reentrancy limit reached/,
    )
    // Another parent has its own breadth.
    const other = await a.acquire(top("A", { nested: true, nestedParentKey: "p2" }))
    other()
    child()
    parent()
    expect(a.stats()).toEqual({ orgs: {}, holdsTx: 0, queued: 0, nested: 0 })
  })

  it("a queued run times out with the pool's message, and an abort cancels it", async () => {
    const a = new WorkersAdmission({ perOrg: 1 })
    const r = await a.acquire(top("A"))
    await expect(a.acquire(top("A", { waitMs: 10 }))).rejects.toThrow(
      "Queued sandbox request timed out waiting for a free worker",
    )
    const ac = new AbortController()
    const p = a.acquire(top("A", { signal: ac.signal }))
    ac.abort()
    await expect(p).rejects.toThrow()
    expect(a.stats().queued).toBe(0)
    r()
  })
})
