// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { bridgeReplyData, runHandler, runWithBridge, type WorkerRunRequest } from "./worker-core"

const METHODS = ["db_findMany", "kernel_getOrg", "log_info", "config_get"]

function req(exportName: string, extra: Partial<WorkerRunRequest> = {}): WorkerRunRequest {
  return { exportName, params: { n: 2 }, bridgeMethods: METHODS, approval: null, ...extra }
}

describe("runHandler", () => {
  it("calls the export with params, a ctx over dispatch and the extra args", async () => {
    const calls: Array<[string, unknown[]]> = []
    const mod = {
      handler: async (params: { n: number }, ctx: any, headers: unknown) => {
        const rows = await ctx.db.findMany("items", { limit: params.n })
        await ctx.logger.info("seen")
        return { rows, headers, approval: ctx.approval, missing: undefined }
      },
    }
    const out = await runHandler(
      mod,
      req("handler", { extraArgs: [{ "x-h": "1" }], approval: { id: "a1" } }),
      async (m, a) => {
        calls.push([m, a])
        return m === "db_findMany" ? JSON.stringify([{ id: 1 }]) : null
      },
    )
    expect(out).toMatchObject({
      ok: true,
      result: { rows: [{ id: 1 }], headers: { "x-h": "1" }, approval: { id: "a1" } },
      timings: { bridgeCalls: 2 },
    })
    expect(calls).toEqual([
      ["db_findMany", ["items", JSON.stringify({ limit: 2 })]],
      ["log_info", ["seen"]],
    ])
    // JSON-safe: undefined members dropped, undefined result -> null.
    expect(Object.hasOwn((out as any).result, "missing")).toBe(false)
    const none = await runHandler({ h: async () => undefined }, req("h"), async () => null)
    expect(none).toMatchObject({ ok: true, result: null })
  })

  it("builds a fresh ctx for every run", async () => {
    const seen = new WeakSet<object>()
    let reused = false
    const mod = {
      h: async (_p: unknown, ctx: object) => {
        if (seen.has(ctx)) reused = true
        seen.add(ctx)
        return 1
      },
    }
    await runHandler(mod, req("h"), async () => null)
    await runHandler(mod, req("h"), async () => null)
    expect(reused).toBe(false)
  })

  it("answers a missing or invalid export with the subprocess's structured error", async () => {
    const mod = { notFn: 3 } as Record<string, unknown>
    const missing = await runHandler(mod, req("nope"), async () => null)
    expect(missing).toMatchObject({
      ok: false,
      error: { message: 'Export "nope" not found (got undefined)', kind: "handler" },
    })
    const notFn = await runHandler(mod, req("notFn"), async () => null)
    expect(notFn).toMatchObject({
      ok: false,
      error: { message: 'Export "notFn" not found (got number)' },
    })
    const bad = await runHandler(mod, req("a-b"), async () => null)
    expect(bad).toMatchObject({ ok: false, error: { message: 'Invalid export name: "a-b"' } })
    // A prototype member is not an export.
    const proto = await runHandler({}, req("toString"), async () => null)
    expect(proto).toMatchObject({
      ok: false,
      error: { message: 'Export "toString" not found (got undefined)' },
    })
  })

  it("carries a thrown error's message, name, status and code; a ToolError's safe fields", async () => {
    const typed = await runHandler(
      {
        h: async () => {
          throw Object.assign(new TypeError("upstream said no"), { status: 422, code: "bad_input" })
        },
      },
      req("h"),
      async () => null,
    )
    expect(typed).toMatchObject({
      ok: false,
      error: {
        message: "upstream said no",
        name: "TypeError",
        status: 422,
        code: "bad_input",
        kind: "handler",
      },
    })
    const tool = await runHandler(
      {
        h: async () => {
          throw Object.assign(new Error("pick a shop"), {
            name: "ToolError",
            code: "need_shop",
            retryable: true,
          })
        },
      },
      req("h"),
      async () => null,
    )
    expect(tool).toMatchObject({
      ok: false,
      error: { message: "pick a shop", safe: true, code: "need_shop", retryable: true },
    })
    const str = await runHandler(
      {
        h: async () => {
          throw "plain"
        },
      },
      req("h"),
      async () => null,
    )
    expect(str).toMatchObject({ ok: false, error: { message: "plain", kind: "handler" } })
  })

  it("reports an unserializable result as a handler error", async () => {
    const out = await runHandler({ h: async () => ({ n: 1n }) }, req("h"), async () => null)
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.message).toContain("not serializable")
  })
})

describe("bridge replies", () => {
  it("maps {data}, {} and the error envelope", () => {
    expect(bridgeReplyData({ data: { a: 1 } })).toEqual({ a: 1 })
    expect(bridgeReplyData({})).toBeUndefined()
    expect(() =>
      bridgeReplyData({ error: "nope", errorStatus: 404, errorCode: "not_found" }),
    ).toThrow(expect.objectContaining({ message: "nope", status: 404, code: "not_found" }))
    expect(() => bridgeReplyData("x")).toThrow(
      expect.objectContaining({ message: "Malformed app bridge reply" }),
    )
  })

  it("a bridge error reaches the handler as on QuickJS: plain string, or Error with status/code", async () => {
    const replies: Record<string, unknown> = {
      kernel_getOrg: { error: "Task not found", errorStatus: 404, errorCode: "not_found" },
      config_get: { error: "boom" },
      db_findMany: { data: [{ id: 7 }] },
    }
    const mod = {
      h: async (_p: unknown, ctx: any) => {
        const out: Record<string, unknown> = {}
        try {
          await ctx.kernel.getOrg()
        } catch (e: any) {
          out.typed = {
            isError: e instanceof Error,
            message: e.message,
            status: e.status,
            code: e.code,
          }
        }
        try {
          await ctx.config_get("k")
        } catch (e) {
          out.plain = e
        }
        out.rows = await ctx.db.findMany("t", {})
        return out
      },
    }
    const out = await runWithBridge(mod, req("h"), { call: async (m) => replies[m] })
    expect(out).toMatchObject({
      ok: true,
      result: {
        typed: { isError: true, message: "Task not found", status: 404, code: "not_found" },
        plain: "boom",
        rows: [{ id: 7 }],
      },
      timings: { bridgeCalls: 3 },
    })
  })

  it("a Bridge that throws (non-200 answer) rejects the handler's call with its message", async () => {
    const mod = {
      h: async (_p: unknown, ctx: any) => {
        try {
          await ctx.config_get("k")
          return "no"
        } catch (e) {
          return e
        }
      },
    }
    const out = await runWithBridge(mod, req("h"), {
      call: async () => {
        throw new Error("App bridge 410 settled: Run settled")
      },
    })
    expect(out).toMatchObject({ ok: true, result: "App bridge 410 settled: Run settled" })
  })
})

describe("sleep accounting", () => {
  const sleeper = {
    h: async (p: { ms: number[] }) => {
      for (const ms of p.ms) await new Promise((r) => setTimeout(r, ms))
      return "done"
    },
  }

  it("charges a run the time it waited in its own timers, and restores setTimeout", async () => {
    const before = globalThis.setTimeout
    const out = await runHandler(sleeper, req("h", { params: { ms: [30, 30] } }), async () => null)
    expect(out.ok).toBe(true)
    expect(out.timings.sleepMs).toBeGreaterThanOrEqual(55)
    expect(out.timings.sleepMs).toBeLessThanOrEqual(out.timings.runMs + 5)
    expect(out.timings.sleepExact).toBe(true)
    expect(globalThis.setTimeout).toBe(before)
    const idle = await runHandler(sleeper, req("h", { params: { ms: [] } }), async () => null)
    expect(idle.timings).toMatchObject({ sleepMs: 0, sleepExact: true })
  })

  it("marks overlapping runs as inexact (upper bound)", async () => {
    const [a, b] = await Promise.all([
      runHandler(sleeper, req("h", { params: { ms: [40] } }), async () => null),
      runHandler(sleeper, req("h", { params: { ms: [10] } }), async () => null),
    ])
    expect(a.timings.sleepExact).toBe(false)
    expect(b.timings.sleepExact).toBe(false)
    expect(a.timings.sleepMs).toBeGreaterThanOrEqual(35)
  })
})
