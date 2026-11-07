// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createCtx, SHIM_RULES, type ShimRules } from "~/modules/apps/sandbox/ctx-shim"
import { SandboxWorkerPool } from "~/modules/apps/sandbox/worker-pool"

type AnyBridge = Record<string, (...args: any[]) => unknown>

// Three data pages, then the end marker, exactly as bridge/db.ts
// `bulk_iterateJsonl_next` returns them (JSON strings).
function bulkBridge(calls: Array<{ method: string; args: unknown[] }>): AnyBridge {
  const pages = [[{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 4 }], [{ id: 5 }]]
  let page = 0
  return {
    bulk_fetchToBlob: async (...args: unknown[]) => {
      calls.push({ method: "bulk_fetchToBlob", args })
      return JSON.stringify({ blobId: "blob-1", sizeBytes: 42 })
    },
    bulk_iterateJsonl_next: async (...args: unknown[]) => {
      calls.push({ method: "bulk_iterateJsonl_next", args })
      if (page >= pages.length) return JSON.stringify({ batch: [], done: true })
      return JSON.stringify({ batch: pages[page++], done: false })
    },
    bulk_deleteBlob: async (...args: unknown[]) => {
      calls.push({ method: "bulk_deleteBlob", args })
      return JSON.stringify({ ok: true })
    },
  }
}

// Backfill-shaped handler (bundled-apps/shopify backfill-customers.ts streamAndImport).
const BACKFILL_FIXTURE = `async function backfill(params, ctx) {
  var fetched = await ctx.bulk.fetchToBlob("https://example.com/bulk.jsonl")
  var ids = []
  var batches = 0
  for await (var batch of ctx.bulk.iterateJsonl(fetched.blobId, { batchSize: 2 })) {
    batches++
    for (var i = 0; i < batch.length; i++) ids.push(batch[i].id)
  }
  await ctx.bulk.deleteBlob(fetched.blobId)
  return { blobId: fetched.blobId, sizeBytes: fetched.sizeBytes, ids: ids, batches: batches }
}`

// Fixed method list for the parity runs. Each responds the way the real host
// bridges do (JSON strings, a non-JSON digest, undefined from log_*).
function parityBridge(calls: Array<{ method: string; args: unknown[] }>): AnyBridge {
  const rec =
    (method: string, fn: (...args: any[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args })
      return fn(...args)
    }
  const bulk = bulkBridge([])
  return {
    emit: rec("emit", () => JSON.stringify({ ok: true })),
    getUserId: rec("getUserId", () => "user-1"),
    callerHasScope: rec("callerHasScope", () => true),
    kernel_get: rec("kernel_get", (id: string) => JSON.stringify({ id, kind: "kernel" })),
    db_findMany: rec("db_findMany", () => JSON.stringify([{ id: "r1" }])),
    db_findOne: rec("db_findOne", (_e: string, id: string) => JSON.stringify({ id })),
    tickets_get: rec("tickets_get", (json: string) => JSON.stringify({ echo: JSON.parse(json) })),
    crypto_sha256: rec("crypto_sha256", () => "bm90LWpzb24="),
    log_info: rec("log_info", () => undefined),
    approval_recordStarted: rec("approval_recordStarted", () => JSON.stringify({ started: true })),
    _approvalContext_get: rec("_approvalContext_get", () => JSON.stringify({ hidden: true })),
    fails_now: rec("fails_now", () => {
      throw new Error("boom from host")
    }),
    fails_typed: rec("fails_typed", () => {
      throw Object.assign(new Error("no such task"), { status: 404, code: "NOT_FOUND" })
    }),
    bulk_fetchToBlob: rec("bulk_fetchToBlob", () => bulk.bulk_fetchToBlob!()),
    bulk_iterateJsonl_next: rec("bulk_iterateJsonl_next", (blobId: string) =>
      blobId === "bad"
        ? JSON.stringify({
            error: { code: "BLOB_GONE", message: "blob expired", retryable: false },
          })
        : bulk.bulk_iterateJsonl_next!(),
    ),
    bulk_deleteBlob: rec("bulk_deleteBlob", () => bulk.bulk_deleteBlob!()),
  }
}

const PARITY_FIXTURE = `async function probe(params, ctx) {
  var groups = {}
  var keys = Object.keys(ctx)
  for (var i = 0; i < keys.length; i++) {
    var v = ctx[keys[i]]
    if (keys[i] !== "approval" && v !== null && typeof v === "object") groups[keys[i]] = Object.keys(v)
  }
  var out = []
  out.push(await ctx.emit("already-serialized"))
  out.push(await ctx.emit({ type: "x", n: 1 }))
  out.push(await ctx.emit(undefined, null))
  out.push(await ctx.getUserId())
  out.push(await ctx.callerHasScope("app:res"))
  out.push(await ctx.kernel.get("k1"))
  out.push(await ctx.kernel_get("k1"))
  out.push(await ctx.db.findOne("things", "r9"))
  out.push(await ctx.db.findMany("things", { where: { id: "r1" }, limit: 1 }))
  out.push(await ctx.db_findOne("things", "r9"))
  out.push(await ctx.tickets.get(JSON.stringify({ id: "t1" })))
  out.push(await ctx.crypto.sha256({ a: 1 }))
  out.push(await ctx.log_info("m"))
  out.push(await ctx.logger.info("m", { x: 1 }))
  out.push(await ctx.approval_recordStarted("key-1"))
  out.push(await ctx.bulk.fetchToBlob("https://example.com/b.jsonl", { headers: { a: "b" } }))
  var batches = []
  for await (var batch of ctx.bulk.iterateJsonl("blob-1", { batchSize: 2 })) batches.push(batch)
  out.push(batches)
  var after = []
  for await (var b2 of ctx.bulk.iterateJsonl("blob-1")) after.push(b2)
  out.push(after)
  try {
    for await (var b3 of ctx.bulk.iterateJsonl("bad", null)) out.push(b3)
    out.push("no-throw")
  } catch (e) {
    out.push({ iterErr: String(e.message), code: e.code })
  }
  var shape = function (e) {
    return typeof e === "string"
      ? { string: e }
      : { error: String(e.message), isError: e instanceof Error, status: e.status, code: e.code }
  }
  try {
    await ctx.fails.now("x")
    out.push("no-throw")
  } catch (e) {
    out.push(shape(e))
  }
  try {
    await ctx.fails_typed({ id: "t" })
    out.push("no-throw")
  } catch (e) {
    out.push(shape(e))
  }
  out.push(await ctx.bulk.deleteBlob("blob-1"))
  return {
    keys: keys,
    groups: groups,
    approval: ctx.approval,
    hidden: typeof ctx._approvalContext_get,
    out: out,
  }
}`

type Approval = { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null

interface RunOutput {
  result: unknown
  calls: Array<{ method: string; args: unknown[] }>
}

// What crosses a wire (IPC or HTTP): JSON, undefined in arrays becomes null.
const wire = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

async function runV8(
  source: string,
  exportName: string,
  approval: Approval,
  rules: ShimRules = SHIM_RULES,
): Promise<RunOutput> {
  const calls: RunOutput["calls"] = []
  const bridge = parityBridge(calls)
  const ctx = createCtx(
    Object.keys(bridge),
    approval,
    async (method, args) => wire(await bridge[method]!(...wire(args))),
    rules,
  )
  const handler = new Function(`${source}\nreturn ${exportName}`)() as (
    p: unknown,
    c: unknown,
  ) => Promise<unknown>
  const result = wire(await handler({}, ctx))
  return { result, calls }
}

describe("ctx shim: QuickJS source and createCtx agree", () => {
  let pool: SandboxWorkerPool

  beforeAll(async () => {
    pool = new SandboxWorkerPool({ size: 1, maxSize: 1 })
    await pool.init()
  })

  afterAll(async () => {
    if (pool) await pool.shutdown()
  })

  async function runQuickJs(approval: Approval): Promise<RunOutput> {
    const calls: RunOutput["calls"] = []
    const result = await pool.execute({
      bundleSource: PARITY_FIXTURE,
      exportName: "probe",
      params: {},
      bridge: parityBridge(calls),
      syncContext: { approval },
    })
    return { result, calls }
  }

  for (const approval of [
    null,
    { approvalRequestId: "ar-1", approvalDeciderId: "u-2", toolName: "app:do" },
  ] as Approval[]) {
    it(`same dispatch sequence and returns (approval ${approval ? "set" : "null"})`, async () => {
      const q = await runQuickJs(approval)
      const v = await runV8(PARITY_FIXTURE, "probe", approval)
      expect(v.result).toEqual(q.result)
      expect(v.calls).toEqual(q.calls)

      // Pin the semantics themselves, not only their equality.
      const r = q.result as {
        keys: string[]
        groups: Record<string, string[]>
        approval: unknown
        hidden: string
        out: unknown[]
      }
      expect(r.approval).toEqual(approval)
      expect(r.hidden).toBe("undefined")
      expect(r.groups.approval).toBeUndefined()
      expect(r.groups.logger).toEqual(r.groups.log)
      expect(r.groups.bulk).toContain("iterateJsonl")
      expect(r.out[0]).toBe('{"ok":true}') // raw: string passes through
      expect(r.out[1]).toEqual({ ok: true }) // SDK shape: parsed
      expect(r.out[5]).toEqual({ id: "k1", kind: "kernel" }) // kernel group: always parsed
      expect(r.out[6]).toBe('{"id":"k1","kind":"kernel"}') // flat name: raw
      expect(r.out[7]).toEqual({ id: "r9" })
      expect(r.out[10]).toBe('{"echo":{"id":"t1"}}') // raw host-app group
      expect(r.out[11]).toBe("bm90LWpzb24=") // non-JSON string falls back
      expect(r.out[12]).toBeNull() // undefined data arrives as null
      expect(r.out[15]).toEqual({ blobId: "blob-1", sizeBytes: 42 })
      expect(r.out[16]).toEqual([[{ id: 1 }, { id: 2 }], [{ id: 3 }, { id: 4 }], [{ id: 5 }]])
      expect(r.out[17]).toEqual([])
      expect(r.out[18]).toEqual({ iterErr: "blob expired", code: "BLOB_GONE" })
      expect(r.out[19]).toEqual({ string: "boom from host" }) // statusless: plain string
      expect(r.out[20]).toEqual({
        error: "no such task",
        isError: true,
        status: 404,
        code: "NOT_FOUND",
      })
      const findMany = q.calls.find((c) => c.method === "db_findMany")
      expect(findMany?.args).toEqual(["things", '{"where":{"id":"r1"},"limit":1}'])
      expect(q.calls.some((c) => c.method === "_approvalContext_get")).toBe(false)
    })
  }

  it("discriminates: one rule changed in createCtx's path only breaks parity", async () => {
    const q = await runQuickJs(null)
    const altered: ShimRules = {
      ...SHIM_RULES,
      structuredReturnGroups: SHIM_RULES.structuredReturnGroups.filter((g) => g !== "kernel"),
    }
    const v = await runV8(PARITY_FIXTURE, "probe", null, altered)
    expect(v.result).not.toEqual(q.result)
  })
})

describe("ctx shim: bulk iterator on the subprocess pool", () => {
  let pool: SandboxWorkerPool

  beforeAll(async () => {
    pool = new SandboxWorkerPool({ size: 1, maxSize: 1 })
    await pool.init()
  })

  afterAll(async () => {
    if (pool) await pool.shutdown()
  })

  it("fetchToBlob returns a parsed object and iterateJsonl walks every page", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = []
    const result = await pool.execute({
      bundleSource: BACKFILL_FIXTURE,
      exportName: "backfill",
      params: {},
      bridge: bulkBridge(calls),
    })
    expect(result).toEqual({ blobId: "blob-1", sizeBytes: 42, ids: [1, 2, 3, 4, 5], batches: 3 })
    expect(calls.map((c) => c.method)).toEqual([
      "bulk_fetchToBlob",
      "bulk_iterateJsonl_next",
      "bulk_iterateJsonl_next",
      "bulk_iterateJsonl_next",
      "bulk_iterateJsonl_next",
      "bulk_deleteBlob",
    ])
    expect(calls[1]!.args).toEqual(["blob-1", 2])
  })
})
