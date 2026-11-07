// SPDX-License-Identifier: FSL-1.1-ALv2
//
// POST /api/app-bridge/:runId — a remote isolate's ctx.* call for one run.
//
// The HTTP analogue of the subprocess pool's bridge_call/bridge_result IPC
// (sandbox/worker-pool.ts): the body is `{callId, method, args}` exactly as the
// shim sends it, the answer is `{data}` or `{error, errorStatus?, errorCode?}`.
// Mounted before the user JWT chain: its only credential is the run's bearer
// token (run-registry.ts), which binds the call to one run, one org and one
// app. The bridge called is the one the dispatching code registered; nothing
// here builds or widens it. Every path answers 404 unless the Workers executor
// is configured (config.ts).
//
// Statuses: 401 `unknown_run` / `bad_token` / `expired`, 403 another run's
// token, 404 unknown method, 409 another execution's nonce, 410 run settled,
// 504 the call outlived the run's deadline, 400 malformed body.

import { Hono } from "hono"
import { rootLogger } from "~/lib/logger"
import { typedBridgeFailure } from "~/modules/apps/sandbox/bridge-rejection"
import { workersConfigured } from "./config"
import { type RunAuthResult, type RunRegistry, runRegistry } from "./run-registry"
import { recordBridgeTiming } from "./timings"

const log = rootLogger.child({ module: "app-bridge" })

/** The route's mount point; app.ts exempts it from the generic timeout, body cap and IP limiter. */
export const APP_BRIDGE_PATH_PREFIX = "/api/app-bridge/"
/** A bridge call body (a ctx.db.insertMany batch, a bulk page) may be large. */
export const APP_BRIDGE_BODY_MAX_BYTES = 8 * 1024 * 1024

export interface AppBridgeRouteDeps {
  registry?: RunRegistry
  isConfigured?: () => boolean
}

const AUTH_FAILURE: Record<
  Exclude<RunAuthResult["kind"], "ok">,
  { status: 401 | 403 | 409 | 410; message: string }
> = {
  unknown_run: { status: 401, message: "Unknown run" },
  bad_token: { status: 401, message: "Invalid run token" },
  expired: { status: 401, message: "Run deadline passed" },
  wrong_run: { status: 403, message: "Token belongs to another run" },
  nonce_mismatch: { status: 409, message: "Execution nonce mismatch" },
  settled: { status: 410, message: "Run settled" },
}

function bearer(header: string | undefined): string | undefined {
  if (!header) return undefined
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return m?.[1]
}

class DeadlineExceeded extends Error {}

export function createAppBridgeRoutes(deps: AppBridgeRouteDeps = {}) {
  const registry = deps.registry ?? runRegistry
  const isConfigured = deps.isConfigured ?? workersConfigured
  const now = () => registry.now()

  return new Hono().post("/:runId", async (c) => {
    if (!isConfigured()) return c.json({ error: "Not found", reason: "not_found" }, 404)

    const runId = c.req.param("runId")
    const auth = registry.authenticate(
      runId,
      bearer(c.req.header("authorization")),
      c.req.header("x-exec-nonce") || undefined,
    )
    if (auth.kind !== "ok") {
      const f = AUTH_FAILURE[auth.kind]
      log.warn({ runId, reason: auth.kind }, "App bridge call refused")
      return c.json({ error: f.message, reason: auth.kind }, f.status)
    }
    const entry = auth.entry

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: "Body is not JSON", reason: "bad_request" }, 400)
    }
    const b = body as { callId?: unknown; method?: unknown; args?: unknown } | null
    if (!b || typeof b !== "object" || typeof b.method !== "string" || !Array.isArray(b.args)) {
      return c.json({ error: "Body must be {callId, method, args[]}", reason: "bad_request" }, 400)
    }
    const method = b.method
    const args: unknown[] = b.args

    // Own property of the run's bridge AND listed for the run: never a
    // prototype member (`constructor`, `__proto__`, `toString`).
    const fn =
      entry.bridgeMethods.has(method) && Object.hasOwn(entry.bridge, method)
        ? entry.bridge[method]
        : undefined
    if (typeof fn !== "function") {
      log.warn({ runId, app: entry.appName, method }, "App bridge call to an unknown method")
      return c.json({ error: `Unknown bridge method: ${method}`, reason: "unknown_method" }, 404)
    }

    entry.stats.bridgeCalls++
    const started = now()
    const remaining = Math.max(0, entry.deadline - started)
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (status: number, ok: boolean) => {
      const ms = now() - started
      entry.stats.bridgeMsTotal += ms
      recordBridgeTiming({
        kind: "call",
        runId,
        app: entry.appName,
        executor: "workers",
        method,
        ms,
        status,
        ok,
        at: started,
      })
    }

    try {
      const data = await Promise.race([
        Promise.resolve().then(() => (fn as (...a: unknown[]) => unknown)(...args)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DeadlineExceeded()), remaining)
        }),
      ])
      let payload: string
      try {
        payload = JSON.stringify(data === undefined ? {} : { data })
      } catch (err) {
        finish(200, false)
        const message = `Bridge result of ${method} is not serializable: ${(err as Error).message}`
        log.error({ err, runId, app: entry.appName, method }, "App bridge result not serializable")
        return c.json({ error: message })
      }
      finish(200, true)
      return c.body(payload, 200, { "content-type": "application/json" })
    } catch (err) {
      if (err instanceof DeadlineExceeded) {
        finish(504, false)
        log.warn({ runId, app: entry.appName, method }, "App bridge call outlived its run")
        return c.json(
          { error: "Run deadline passed during the bridge call", reason: "expired" },
          504,
        )
      }
      // As worker-pool.ts's bridge_result: the message, plus a typed
      // refusal's HTTP class and code so the handler sees the same Error.
      const typed = typedBridgeFailure(err)
      finish(200, false)
      const message = err instanceof Error ? err.message : String(err)
      return c.json({
        error: message,
        ...(typed
          ? {
              errorStatus: typed.status,
              ...(typed.code !== undefined ? { errorCode: typed.code } : {}),
            }
          : {}),
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  })
}

export const appBridgeRoutes = createAppBridgeRoutes()
