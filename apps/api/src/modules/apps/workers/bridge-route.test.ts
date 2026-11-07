// SPDX-License-Identifier: FSL-1.1-ALv2
//
// POST /api/app-bridge/:runId: a run's token drives only that run's bridge,
// by own-property method name, within its deadline and its execution nonce,
// and errors cross with the same shape as the pool's bridge_result.

import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { type AppEnv, apiBodyLimitMiddleware, apiRequestTimeoutMiddleware, app } from "~/app"
import { env } from "~/lib/env"
import { errorHandler } from "~/middleware/error-handler"
import { createAppBridgeRoutes } from "./bridge-route"
import { type RegisterRunOptions, RunRegistry } from "./run-registry"
import { clearBridgeTimings, recentBridgeTimings } from "./timings"

let clock = 1_000_000
const registry = new RunRegistry({ now: () => clock })
let configured = true

function stack(): Hono<AppEnv> {
  const s = new Hono<AppEnv>()
  s.use("/api/*", apiBodyLimitMiddleware)
  s.use("/api/*", apiRequestTimeoutMiddleware)
  s.onError(errorHandler)
  s.route("/api/app-bridge", createAppBridgeRoutes({ registry, isConfigured: () => configured }))
  return s
}

function register(
  bridge: Record<string, unknown>,
  over: Partial<RegisterRunOptions> = {},
): ReturnType<RunRegistry["registerRun"]> {
  return registry.registerRun({
    bridge,
    bridgeMethods: Object.keys(bridge),
    orgId: "00000000-0000-0000-0000-00000000a001",
    appName: "fixture",
    version: "1.0.0",
    timeoutMs: 30_000,
    ...over,
  })
}

function call(
  s: Hono<AppEnv>,
  runId: string,
  token: string | undefined,
  method: string,
  args: unknown[] = [],
  nonce = "nonce-1",
) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (nonce) headers["x-exec-nonce"] = nonce
  return s.request(`/api/app-bridge/${runId}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ callId: 1, method, args }),
  })
}

async function body(res: Response): Promise<{ reason?: string; error?: string }> {
  return (await res.json()) as { reason?: string; error?: string }
}

beforeEach(() => {
  configured = true
  clearBridgeTimings()
})

describe("app bridge route: authentication", () => {
  it("a run's own token reaches its bridge and returns {data}", async () => {
    const run = register({ echo: async (a: string, b: number) => `${a}:${b}` })
    const res = await call(stack(), run.runId, run.runToken, "echo", ["x", 2])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: "x:2" })
    run.settle()
  })

  it("another run's token is refused with 403 and never reaches either bridge", async () => {
    let touched = false
    const a = register({
      write: async () => {
        touched = true
      },
    })
    const b = register(
      {
        write: async () => {
          touched = true
        },
      },
      {
        orgId: "00000000-0000-0000-0000-00000000b001",
      },
    )
    const res = await call(stack(), a.runId, b.runToken, "write")
    expect(res.status).toBe(403)
    expect(touched).toBe(false)
    a.settle()
    b.settle()
  })

  it("garbage or missing tokens are 401 bad_token", async () => {
    const run = register({ m: async () => 1 })
    const r1 = await call(stack(), run.runId, "not-a-token", "m")
    expect(r1.status).toBe(401)
    expect((await body(r1)).reason).toBe("bad_token")
    const r2 = await call(stack(), run.runId, undefined, "m")
    expect(r2.status).toBe(401)
    expect((await body(r2)).reason).toBe("bad_token")
    run.settle()
  })

  it("an unknown run is 401 unknown_run", async () => {
    const res = await call(stack(), "00000000-0000-0000-0000-000000000000", "t", "m")
    expect(res.status).toBe(401)
    expect((await body(res)).reason).toBe("unknown_run")
  })

  it("a run past its deadline is 401 expired", async () => {
    const run = register({ m: async () => 1 }, { timeoutMs: 1000 })
    clock += 1000 + 10_000 + 1
    const res = await call(stack(), run.runId, run.runToken, "m")
    expect(res.status).toBe(401)
    expect((await body(res)).reason).toBe("expired")
    run.settle()
  })

  it("a settled run is 410, by settle() and by its abort signal", async () => {
    const run = register({ m: async () => 1 })
    run.settle()
    const r1 = await call(stack(), run.runId, run.runToken, "m")
    expect(r1.status).toBe(410)

    const ac = new AbortController()
    const run2 = register({ m: async () => 1 }, { signal: ac.signal })
    ac.abort()
    const r2 = await call(stack(), run2.runId, run2.runToken, "m")
    expect(r2.status).toBe(410)
  })

  it("the first execution nonce is pinned: a second one is 409", async () => {
    const run = register({ m: async () => 1 })
    expect((await call(stack(), run.runId, run.runToken, "m", [], "exec-A")).status).toBe(200)
    expect((await call(stack(), run.runId, run.runToken, "m", [], "exec-A")).status).toBe(200)
    expect((await call(stack(), run.runId, run.runToken, "m", [], "exec-B")).status).toBe(409)
    expect((await call(stack(), run.runId, run.runToken, "m", [], "")).status).toBe(409)
    run.settle()
  })
})

describe("app bridge route: method lookup", () => {
  it("unknown, unlisted and prototype methods are 404", async () => {
    const bridge = { listed: async () => 1, unlisted: async () => 2 }
    const run = register(bridge, { bridgeMethods: ["listed", "constructor", "__proto__"] })
    const s = stack()
    for (const m of [
      "nope",
      "unlisted",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ]) {
      const res = await call(s, run.runId, run.runToken, m)
      expect(res.status).toBe(404)
      expect((await body(res)).error).toBe(`Unknown bridge method: ${m}`)
    }
    expect((await call(s, run.runId, run.runToken, "listed")).status).toBe(200)
    run.settle()
  })

  it("a malformed body is 400", async () => {
    const run = register({ m: async () => 1 })
    const res = await stack().request(`/api/app-bridge/${run.runId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${run.runToken}`, "x-exec-nonce": "n" },
      body: JSON.stringify({ callId: 1, method: "m", args: "nope" }),
    })
    expect(res.status).toBe(400)
    run.settle()
  })
})

describe("app bridge route: results and errors", () => {
  it("a typed bridge failure keeps its status and code; a plain one its message", async () => {
    const typed = Object.assign(new Error("Not here"), { status: 404, code: "not_found" })
    const run = register({
      typed: async () => {
        throw typed
      },
      plain: async () => {
        throw new Error("boom")
      },
    })
    const s = stack()
    const r1 = await call(s, run.runId, run.runToken, "typed")
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ error: "Not here", errorStatus: 404, errorCode: "not_found" })
    const r2 = await call(s, run.runId, run.runToken, "plain")
    expect(await r2.json()).toEqual({ error: "boom" })
    run.settle()
  })

  it("records one timing per call and counts calls on the run", async () => {
    const run = register({ m: async () => 1 })
    await call(stack(), run.runId, run.runToken, "m")
    await call(stack(), run.runId, run.runToken, "m")
    const timings = recentBridgeTimings().filter((t) => t.runId === run.runId)
    expect(timings).toHaveLength(2)
    expect(timings[0]).toMatchObject({
      app: "fixture",
      executor: "workers",
      method: "m",
      status: 200,
      ok: true,
    })
    expect(run.settle().bridgeCalls).toBe(2)
  })
})

describe("app bridge route: middleware exemptions", () => {
  const original = env.REQUEST_TIMEOUT_MS
  afterAll(() => {
    env.REQUEST_TIMEOUT_MS = original
  })

  it("a bridge call outlives the generic request timeout", async () => {
    env.REQUEST_TIMEOUT_MS = 100
    const run = register({
      slow: () => new Promise((r) => setTimeout(() => r("done"), 600)),
    })
    const res = await call(stack(), run.runId, run.runToken, "slow")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: "done" })
    run.settle()
  })

  it("a 3 MB body is accepted (the generic cap is 1 MB)", async () => {
    const run = register({ len: async (s: string) => s.length })
    const big = "x".repeat(3 * 1024 * 1024)
    const res = await call(stack(), run.runId, run.runToken, "len", [big])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: big.length })
    run.settle()
  })

  it("a body above 8 MiB is refused", async () => {
    const run = register({ len: async (s: string) => s.length })
    const res = await call(stack(), run.runId, run.runToken, "len", ["x".repeat(9 * 1024 * 1024)])
    expect(res.status).toBe(413)
    run.settle()
  })
})

describe("app bridge route: not configured", () => {
  it("answers 404 on every path, even for a live run's own token", async () => {
    configured = false
    const run = register({ m: async () => 1 })
    const res = await call(stack(), run.runId, run.runToken, "m")
    expect(res.status).toBe(404)
    run.settle()
  })

  it("is mounted in the app, before the JWT chain, 404 when unconfigured", async () => {
    const res = await app.request("/api/app-bridge/00000000-0000-0000-0000-000000000000", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callId: 1, method: "m", args: [] }),
    })
    expect(res.status).toBe(404)
    expect((await body(res)).reason).toBe("not_found")
  })
})
