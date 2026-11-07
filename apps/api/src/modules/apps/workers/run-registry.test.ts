// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { RUN_DEADLINE_GRACE_MS, RunRegistry } from "./run-registry"

function reg(now = () => 0) {
  return new RunRegistry({ now })
}
const base = {
  orgId: "00000000-0000-0000-0000-00000000a001",
  appName: "fixture",
  version: "1.0.0",
  timeoutMs: 1000,
}

describe("run registry", () => {
  it("mints a 32-byte base64url token and keeps only its hash", () => {
    const r = reg()
    const run = r.registerRun({ ...base, bridge: { m: async () => 1 }, bridgeMethods: ["m"] })
    expect(Buffer.from(run.runToken, "base64url")).toHaveLength(32)
    const auth = r.authenticate(run.runId, run.runToken, "n")
    expect(auth.kind).toBe("ok")
    if (auth.kind !== "ok") return
    expect(JSON.stringify(Object.values(auth.entry))).not.toContain(run.runToken)
    expect(run.deadline).toBe(1000 + RUN_DEADLINE_GRACE_MS)
    run.settle()
  })

  it("binds the token to its run: another live run's token is wrong_run", () => {
    const r = reg()
    const a = r.registerRun({ ...base, bridge: { m: async () => 1 }, bridgeMethods: ["m"] })
    const b = r.registerRun({
      ...base,
      orgId: "00000000-0000-0000-0000-00000000b001",
      bridge: { m: async () => 1 },
      bridgeMethods: ["m"],
    })
    expect(r.authenticate(a.runId, b.runToken, "n").kind).toBe("wrong_run")
    expect(r.authenticate(b.runId, a.runToken, "n").kind).toBe("wrong_run")
    a.settle()
    b.settle()
  })

  it("keeps only listed own function properties as methods", () => {
    const r = reg()
    const bridge = Object.assign(Object.create({ inherited: async () => 1 }), {
      own: async () => 1,
      notFn: 3,
    }) as Record<string, unknown>
    const run = r.registerRun({
      ...base,
      bridge,
      bridgeMethods: ["own", "inherited", "notFn", "constructor"],
    })
    const auth = r.authenticate(run.runId, run.runToken, "n")
    if (auth.kind !== "ok") throw new Error(auth.kind)
    expect([...auth.entry.bridgeMethods]).toEqual(["own"])
    run.settle()
  })

  it("settle is idempotent and revokes; a settled token stays 410, not 401", () => {
    const r = reg()
    const run = r.registerRun({ ...base, bridge: {}, bridgeMethods: [] })
    run.settle()
    run.settle()
    expect(r.size()).toBe(0)
    expect(r.authenticate(run.runId, run.runToken, "n").kind).toBe("settled")
    expect(r.authenticate(run.runId, "other", "n").kind).toBe("bad_token")
  })

  it("an already-aborted signal settles at once", () => {
    const r = reg()
    const ac = new AbortController()
    ac.abort()
    const run = r.registerRun({ ...base, bridge: {}, bridgeMethods: [], signal: ac.signal })
    expect(r.authenticate(run.runId, run.runToken, "n").kind).toBe("settled")
  })

  it("the deadline timer retires the run as expired", async () => {
    const r = new RunRegistry({ graceMs: 0 })
    const run = r.registerRun({ ...base, timeoutMs: 20, bridge: {}, bridgeMethods: [] })
    await new Promise((res) => setTimeout(res, 60))
    expect(r.size()).toBe(0)
    expect(r.authenticate(run.runId, run.runToken, "n").kind).toBe("expired")
  })
})
