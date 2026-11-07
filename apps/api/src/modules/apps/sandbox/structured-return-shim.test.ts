// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression: the sandbox ctx shim must hand SDK-convention kernel reads
// (`ctx.kernel.*`, `ctx.db.*`) ALREADY-PARSED structured data — even when the
// handler passes all-primitive args.
//
// Root cause this guards against: the generic `__wrap` shim decided whether to
// JSON.parse a string return value by inspecting whether any *argument* was
// non-primitive ("SDK shape"). The kernel read affordances always return
// `JSON.stringify(...)` of structured data but take all-primitive args
// (`ctx.kernel.listApprovals("invoicing:", 50)`, `ctx.db.findOne(entity, id)`),
// so `__wrap` skipped the parse and leaked the raw JSON string. The handler's
// `rows.map(...)` then threw "not a function" (invoicing pending_approvals_list
// 500s) — and `ctx.db.findOne` callers silently saw a string where they
// expected an object.
//
// The fix routes the nested members of the `kernel` / `db` groups through
// `__wrapStructured`, which always best-effort JSON.parses a string return
// regardless of arg shape, while leaving the RAW host-app groups
// (`tickets`/`mail`/…) untouched. This test drives the REAL sandbox executors
// (out-of-process worker pool + in-process executor), not a mock ctx, so it
// exercises the actual shim wiring that reads.test.ts's mock masks.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createCtx } from "~/modules/apps/sandbox/ctx-shim"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { createSandboxPool, type SandboxPool } from "~/modules/apps/sandbox/pool"
import { SandboxWorkerPool } from "~/modules/apps/sandbox/worker-pool"

type AnyBridge = Record<string, (...args: any[]) => unknown>

interface ShimRun {
  bundleSource: string
  exportName: string
  params: unknown
  bridge: AnyBridge
}

// createCtx (V8 isolate path) runs the handler natively against the same
// bridge; the args and data cross JSON, as on the wire.
async function runOnCreateCtx(opts: ShimRun): Promise<unknown> {
  const wire = (v: unknown) => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
  const ctx = createCtx(Object.keys(opts.bridge), null, async (method, args) =>
    wire(await opts.bridge[method]!(...(wire(args) as unknown[]))),
  )
  const handler = new Function(`${opts.bundleSource}\nreturn ${opts.exportName}`)() as (
    p: unknown,
    c: unknown,
  ) => Promise<unknown>
  return wire(await handler(opts.params, ctx))
}

describe("sandbox structured-return shim (kernel/db reads)", () => {
  let pool: SandboxWorkerPool

  beforeAll(async () => {
    pool = new SandboxWorkerPool({ size: 1, maxSize: 2 })
    await pool.init()
  })

  afterAll(async () => {
    if (pool) await pool.shutdown()
  })

  const runners: Array<[string, (opts: ShimRun) => Promise<unknown>]> = [
    [
      "out-of-process worker pool (untrusted path — used by installed apps)",
      (opts) => pool.execute(opts),
    ],
    ["createCtx (isolate path, same rule table)", runOnCreateCtx],
  ]

  for (const [label, run] of runners)
    describe(label, () => {
      it("ctx.kernel.listApprovals(prefix, limit) — all-primitive args — returns a parsed Array", async () => {
        // Mirrors the real bridge contract: kernel_listApprovals returns
        // JSON.stringify(...) (rpc-bridge.ts) and the handler maps over the rows
        // exactly like bundled-apps/invoicing/src/reads.ts:300.
        const bridge: AnyBridge = {
          kernel_listApprovals: async (prefix: string, limit: number) =>
            JSON.stringify(
              [
                { id: "ap1", toolName: `${prefix}issue` },
                { id: "ap2", toolName: `${prefix}credit_note` },
              ].slice(0, limit),
            ),
        }
        const result = (await run({
          bundleSource: `async function probe(params, ctx) {
          var rows = await ctx.kernel.listApprovals("invoicing:", 50)
          return {
            isArray: Array.isArray(rows),
            typeofRows: typeof rows,
            // The exact operation that threw "not a function" before the fix:
            ids: rows.map(function (r) { return r.id }),
          }
        }`,
          exportName: "probe",
          params: {},
          bridge,
        })) as Record<string, unknown>

        expect(result.typeofRows).toBe("object")
        expect(result.isArray).toBe(true)
        expect(result.ids).toEqual(["ap1", "ap2"])
      })

      it("ctx.db.findOne(entity, id) — all-primitive args — returns a parsed object", async () => {
        // Guards the same latent defect that affected shopify's
        // `ctx.db.findOne(entity, id)` (webhooks.ts / staff-overrides.ts).
        const bridge: AnyBridge = {
          db_findOne: async (entity: string, id: string) =>
            JSON.stringify({ id, entity, ok: true }),
        }
        const result = (await run({
          bundleSource: `async function probe(params, ctx) {
          var row = await ctx.db.findOne("staff_overrides", "row-1")
          return { typeofRow: typeof row, id: row && row.id, ok: row && row.ok }
        }`,
          exportName: "probe",
          params: {},
          bridge,
        })) as Record<string, unknown>

        expect(result.typeofRow).toBe("object")
        expect(result.id).toBe("row-1")
        expect(result.ok).toBe(true)
      })

      it("ctx.db.findMany(entity, opts) — object arg (SDK shape) — still marshals args and parses return", async () => {
        // Ensures arg-marshalling is preserved by __wrapStructured: the opts
        // object must reach the bridge as a JSON string, and the return parses.
        const seen: { entity?: string; opts?: unknown } = {}
        const bridge: AnyBridge = {
          db_findMany: async (entity: string, optsJson: string) => {
            seen.entity = entity
            seen.opts = JSON.parse(optsJson)
            return JSON.stringify([{ id: "doc-1" }])
          },
        }
        const result = (await run({
          bundleSource: `async function probe(params, ctx) {
          var rows = await ctx.db.findMany("documents", { where: { id: "doc-1" }, limit: 1 })
          return { isArray: Array.isArray(rows), first: rows[0] }
        }`,
          exportName: "probe",
          params: {},
          bridge,
        })) as Record<string, unknown>

        expect(result.isArray).toBe(true)
        expect(result.first).toEqual({ id: "doc-1" })
        expect(seen.entity).toBe("documents")
        expect(seen.opts).toEqual({ where: { id: "doc-1" }, limit: 1 })
      })

      it("RAW host-app groups (tickets) keep verbatim string passthrough — not over-parsed", async () => {
        // The fix must NOT change the RAW convention used by host apps
        // (mail/tickets/projects/knowledge): they pre-serialize args AND parse
        // the JSON-string return themselves, so the shim must hand them the
        // string unchanged.
        const bridge: AnyBridge = {
          tickets_get: async (paramsJson: string) => {
            // Echo back the structured payload as a JSON string, as the real
            // host bridges do.
            const p = JSON.parse(paramsJson) as { id: string }
            return JSON.stringify({ id: p.id, subject: "hi" })
          },
        }
        const result = (await run({
          bundleSource: `async function probe(params, ctx) {
          var raw = await ctx.tickets.get(JSON.stringify({ id: "t1" }))
          return { typeofRaw: typeof raw }
        }`,
          exportName: "probe",
          params: {},
          bridge,
        })) as Record<string, unknown>

        // RAW group: the return is still a STRING (host handler parses it itself).
        expect(result.typeofRaw).toBe("string")
      })

      it("ctx.logger.* is defined and routes to the log_* bridge (guards the undefined-logger throw)", async () => {
        // Regression: the shim grouped `log_*` bridges into `ctx.log.*` ONLY, so
        // `ctx.logger` (the SDK-documented accessor — packages/app-sdk types — that
        // every bundled app calls) was `undefined`. Optional `ctx.logger?.warn?.()`
        // then silently no-op'd (this is what HID the Shopify webhook-registration
        // failure), and NON-optional `ctx.logger.warn()` (shopify webhooks.ts:330/366,
        // scope-seed.ts:290, …) THROWS "undefined is not an object" in-sandbox. The
        // shim now mirrors the `log` group as `logger` so both names resolve.
        const seen: Array<{ level: string; msg: string; dataJson?: string }> = []
        const bridge: AnyBridge = {
          log_warn: async (msg: string, dataJson?: string) => {
            seen.push({ level: "warn", msg, dataJson })
          },
          log_info: async (msg: string, dataJson?: string) => {
            seen.push({ level: "info", msg, dataJson })
          },
        }
        const result = (await run({
          bundleSource: `async function probe(params, ctx) {
          var hasLogger = !!ctx.logger && typeof ctx.logger.warn === "function"
          // Non-optional call (mirrors webhooks.ts) — must NOT throw pre-return.
          await ctx.logger.warn("subscribe failed", { created: 0 })
          await ctx.logger.info("ok")
          return { hasLogger: hasLogger, hasLog: !!ctx.log }
        }`,
          exportName: "probe",
          params: {},
          bridge,
        })) as Record<string, unknown>

        expect(result.hasLogger).toBe(true)
        // `ctx.log` stays available too (back-compat — nothing should break).
        expect(result.hasLog).toBe(true)
        const warn = seen.find((s) => s.level === "warn")
        expect(warn?.msg).toBe("subscribe failed")
        expect(JSON.parse(warn?.dataJson ?? "{}")).toEqual({ created: 0 })
        expect(seen.some((s) => s.level === "info" && s.msg === "ok")).toBe(true)
      })
    })

  describe("in-process executor (trusted path)", () => {
    let pool: SandboxPool // shadows the worker pool above

    beforeAll(async () => {
      pool = await createSandboxPool({ initialSize: 1, maxSize: 1 })
    }, 60_000)

    afterAll(async () => {
      if (pool) await pool.shutdown()
    }, 60_000)

    it("ctx.kernel.listApprovals(prefix, limit) — all-primitive args — returns a parsed Array", async () => {
      const result = (await executeInSandbox({
        pool,
        bundleSource: `async function probe(params, ctx) {
          var rows = await ctx.kernel.listApprovals("invoicing:", 50)
          return { isArray: Array.isArray(rows), ids: rows.map(function (r) { return r.id }) }
        }`,
        exportName: "probe",
        params: {},
        bridge: {
          kernel_listApprovals: async () => JSON.stringify([{ id: "ap1" }, { id: "ap2" }]),
        },
      })) as Record<string, unknown>

      expect(result.isArray).toBe(true)
      expect(result.ids).toEqual(["ap1", "ap2"])
    })
  })
})
