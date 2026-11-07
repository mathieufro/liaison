// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Sandbox worker subprocess.
 *
 * Runs as a separate OS process via Bun.spawn with IPC.
 * Loads the QuickJS WASM module once at startup, then processes
 * execution requests. Bridge calls are proxied back to the main
 * process over IPC — the worker never touches the database, event
 * bus, or any host resources directly.
 *
 * If this process crashes (OOM, WASM trap, bug), only this worker
 * dies. The main process detects the exit and spawns a replacement.
 */

import type {
  QuickJSAsyncContext,
  QuickJSAsyncRuntime,
  QuickJSAsyncWASMModule,
  QuickJSHandle,
} from "quickjs-emscripten"
import { newQuickJSAsyncWASMModule } from "quickjs-emscripten"
// Relative, not `~/...`: this process runs on a minimal env allowlist with no
// host secrets, and orphan-exit.ts is dependency free by contract so pulling it
// in cannot drag `~/lib/env`/logger (which would fatally fail to parse) along.
import { exitWhenOrphaned } from "../../../lib/orphan-exit"
import { applyTypedFailure, newBridgeRejection, type TypedBridgeFailure } from "./bridge-rejection"
import { buildCtxShimSource } from "./ctx-shim"

// A sandbox worker whose host API server is gone can never be handed another
// execution over IPC, so an orphan here is always garbage: unconditional, no env
// gate. Orphaned pools were measured holding hundreds of MB each and respawning
// for over an hour after their server died.
exitWhenOrphaned()

// -- Constants ---------------------------------------------------------------

const BLOCKED_GLOBALS = [
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]
const HARDEN_SCRIPT = BLOCKED_GLOBALS.map((g) => `delete globalThis.${g}`).join(";")
const DEFAULT_MAX_STACK = 256 * 1024

// -- Error marshalling -------------------------------------------------------

/**
 * Build the host-side Error to throw from a QuickJS `ctx.dump` of a handler's
 * thrown value. A bare handler throw stays a plain redactable Error. But when
 * the handler threw an app-sdk `ToolError` (a vetted-safe, caller-actionable
 * domain error), the dump preserves the custom own-enumerable fields, so we
 * detect it by `name === "ToolError"` (the robust marker: it survives even if
 * a future QuickJS build drops other custom fields) and carry `safe`/`code`/
 * `retryable` onto the host Error. The outer catch then forwards those flags
 * over IPC so the pool reconstructs the ToolError, and execute-tool surfaces
 * the real message instead of redacting it. `message` always survives the dump.
 */
function hostErrorFromDump(errVal: any): Error {
  const msg = typeof errVal === "object" && errVal?.message ? errVal.message : String(errVal)
  const err = new Error(msg)
  if (errVal && typeof errVal === "object" && errVal.name === "ToolError") {
    err.name = "ToolError"
    ;(err as any).safe = true
    ;(err as any).code = typeof errVal.code === "string" ? errVal.code : "tool_error"
    ;(err as any).retryable = errVal.retryable === true
  } else if (errVal && typeof errVal === "object" && typeof errVal.name === "string") {
    // The thrown error's class name (bounded): the host tells an app's own
    // error (GoogleAdsApiError, a plain Error) from a runtime crash
    // (TypeError, SyntaxError) by it. A name, never handler text.
    err.name = errVal.name.slice(0, 64)
  }
  // A typed throw's HTTP class and code (a connector client's upstream
  // status, a rethrown bridge refusal's `not_found`).
  return applyTypedFailure(err, errVal)
}

// -- Types -------------------------------------------------------------------

interface ExecuteRequest {
  type: "execute"
  id: string
  bundleSource: string
  exportName: string
  params: unknown
  /**
   * Extra positional arguments the handler is called with, in order
   * AFTER `(params, __ctx)`. Optional; defaults to none. Used by the
   * manifest-webhook router to pass `headers` as the third arg (see
   * `bundled-apps/shopify/src/webhooks.ts` — handlers declare
   * `(payload, ctx, headers)`).
   */
  extraArgs?: unknown[]
  bridgeMethods: string[]
  timeoutMs: number
  memoryLimitBytes: number
  /**
   * Synchronous-context pre-bake.
   *
   * `getUserId`/`getOrgId` are NOT pre-baked here — the out-of-process worker
   * handles those via async IPC roundtrip (the `getUserId`/`getOrgId` bridge
   * methods). Pre-baking sync getters is an in-process executor concern only
   * (see `executor.ts` SYNC_GETTER_NAMES).
   *
   * `approval` is the K6 post-approval re-entry signal (`ctx.approval`). It is
   * `null`/absent on first invocation and populated on the kernel's re-entry of
   * a previously-gated tool. The bridge's `_approvalContext_get` is async (IPC
   * roundtrip) so it cannot satisfy the *synchronous* `if (ctx.approval)` branch
   * untrusted handlers use to distinguish first-entry from re-entry — we embed
   * the value here as a JS literal at shim-build time instead (mirrors the
   * in-process executor's C5 pre-bake).
   */
  syncContext?: {
    approval?: { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null
  }
  /**
   * Report the QuickJS runtime's peak `memory_used_size` over the call,
   * sampled at each bridge call and at the end (`heapBytes` on the result).
   * Import transforms ask for it to prove each batch stays inside the heap
   * limit; it walks the heap, so it is opt-in.
   */
  measureHeap?: boolean
}

// -- Bridge proxy ------------------------------------------------------------

interface PendingBridgeCall {
  resolve: (data: unknown) => void
  reject: (msg: string, typed?: TypedBridgeFailure) => void
  /** Frees the call's deferred when nobody will answer it. */
  dispose: () => void
}

const pendingBridgeCalls = new Map<string, PendingBridgeCall>()
let nextCallId = 0

/** Send a JSON-safe message to the main process via IPC.
 *  JSON round-trip strips any QuickJS Lifetime objects. */
function sendMessage(msg: Record<string, unknown>): void {
  const safe = JSON.parse(JSON.stringify(msg))
  process.send!(safe)
}

// -- QuickJS helpers ---------------------------------------------------------

function hardenContext(ctx: QuickJSAsyncContext): void {
  const r = ctx.evalCode(HARDEN_SCRIPT, "sandbox-harden.js")
  if (r.error) r.error.dispose()
  else r.value.dispose()
}

// -- Execution ---------------------------------------------------------------

let module: QuickJSAsyncWASMModule
let sharedRuntime: QuickJSAsyncRuntime

/** Safe JS identifier pattern — rejects anything that could inject code into the eval string. */
const SAFE_IDENTIFIER_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/

/**
 * This worker's RSS for the pool's recycle check, or undefined when it cannot
 * be read. It is a report, never part of the execution's outcome: Bun's
 * process.memoryUsage.rss() throws "Failed to get memory usage" now and then,
 * and letting that escape turned a handler's successful result into an error.
 * The pool also samples worker RSS from outside, so a missed report is safe.
 */
function ownRssBytes(): number | undefined {
  try {
    return process.memoryUsage.rss()
  } catch {
    return undefined
  }
}

/** A QuickJS error dump is an object ({name, message, stack}): keep its text in the message. */
function describeDump(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const { name, message } = err as { name?: unknown; message?: unknown }
    return `${typeof name === "string" ? name : "Error"}: ${typeof message === "string" ? message : JSON.stringify(err)}`
  }
  return String(err)
}

/** The runtime's live heap (`memory_used_size`), or undefined when it cannot be read. */
function heapUsedBytes(ctx: QuickJSAsyncContext, rt: QuickJSAsyncRuntime): number | undefined {
  try {
    const handle = rt.computeMemoryUsage()
    const usage = ctx.dump(handle) as { memory_used_size?: unknown }
    handle.dispose()
    return typeof usage.memory_used_size === "number" ? usage.memory_used_size : undefined
  } catch {
    return undefined
  }
}

async function handleExecute(req: ExecuteRequest): Promise<void> {
  // Validate exportName before it reaches evalCode. The value comes from the
  // manifest's handler declaration (a controlled source), but an extra check
  // here ensures any unexpected value fails loudly rather than silently
  // executing arbitrary JS via string interpolation in the call code.
  if (!SAFE_IDENTIFIER_RE.test(req.exportName)) {
    try {
      sendMessage({
        type: "error",
        id: req.id,
        error: `Invalid export name: "${req.exportName}"`,
      })
    } catch {
      /* ok */
    }
    return
  }

  // Reuse the shared runtime — only create a fresh context per request.
  // This avoids the gc_obj_list assertion that fires when disposing a runtime
  // with pending promise settle callbacks from the previous request.
  const rt = sharedRuntime
  rt.setMemoryLimit(req.memoryLimitBytes)

  const deadline = Date.now() + req.timeoutMs
  rt.setInterruptHandler(() => Date.now() > deadline)

  const ctx = rt.newContext()
  hardenContext(ctx)

  // The heap high-water mark the call reached, sampled at every bridge call
  // (the handler's live data is on the heap while it waits for the host) and
  // once more at the end (measureHeap only).
  let heapPeak: number | undefined
  const sampleHeap = (): void => {
    const used = heapUsedBytes(ctx, rt)
    if (used !== undefined) heapPeak = Math.max(heapPeak ?? 0, used)
  }

  // Declared out here: every way out of the try disposes them. One live handle keeps its whole
  // context, bundle included, in the runtime every execution of this worker shares.
  const handles: QuickJSHandle[] = []
  try {
    // 1. Inject bridge proxy functions using native QuickJS promises
    for (const method of req.bridgeMethods) {
      const handle = ctx.newFunction(`__bridge_${method}`, (...argHandles) => {
        if (req.measureHeap) sampleHeap()
        const args = argHandles.map((h) => ctx.dump(h))
        const callId = String(nextCallId++)
        const deferred = ctx.newPromise()

        // Store deferred for when IPC result arrives
        pendingBridgeCalls.set(callId, {
          resolve: (data) => {
            const json = JSON.stringify(data ?? null)
            const parsed = ctx.evalCode(`(${json})`)
            if (parsed.error) {
              deferred.reject(parsed.error)
              parsed.error.dispose()
            } else {
              deferred.resolve(parsed.value)
              parsed.value.dispose()
            }
          },
          reject: (msg, typed) => {
            const errHandle = newBridgeRejection(ctx, msg, typed)
            deferred.reject(errHandle)
            errHandle.dispose()
          },
          dispose: () => deferred.dispose(),
        })

        deferred.settled.then(ctx.runtime.executePendingJobs)
        // Stamp the owning execution id so the pool can fence a stale bridge
        // call (from a previous execution whose worker was recycled/redispatched)
        // against the wrong pendingExec.
        sendMessage({ type: "bridge_call", id: req.id, callId, method, args })
        return deferred.handle
      })
      ctx.setProp(ctx.global, `__bridge_${method}`, handle)
      handles.push(handle)
    }

    // 2. Build __ctx from the shared rule table (ctx-shim.ts): flat names,
    //    `<group>_<member>` groups, structured-return groups, the reserved
    //    `approval` literal (K6, from syncContext), hidden names, the
    //    `logger` alias and `ctx.bulk.iterateJsonl`. Every method, the "sync"
    //    getters included, is an async IPC round trip here (no pre-baking).
    const shimCode = buildCtxShimSource({
      bridgeMethods: req.bridgeMethods,
      approval: req.syncContext?.approval ?? null,
    })
    const shimResult = ctx.evalCode(shimCode, "ctx-shim.js")
    if (shimResult.error) {
      const err = ctx.dump(shimResult.error)
      shimResult.error.dispose()
      throw new Error(`Context shim error: ${describeDump(err)}`)
    }
    shimResult.value.dispose()

    // 3. Evaluate handler bundle
    const bundleResult = ctx.evalCode(req.bundleSource, "handler-bundle.js")
    if (bundleResult.error) {
      const err = ctx.dump(bundleResult.error)
      bundleResult.error.dispose()
      throw new Error(`Bundle evaluation error: ${describeDump(err)}`)
    }
    bundleResult.value.dispose()

    // 4. Check export exists
    const fnHandle = ctx.getProp(ctx.global, req.exportName)
    const fnType = ctx.typeof(fnHandle)
    if (fnType !== "function") {
      fnHandle.dispose()
      throw new Error(`Export "${req.exportName}" not found (got ${fnType})`)
    }
    fnHandle.dispose()

    // 5. Call handler — evalCode returns synchronously; if the handler is async,
    //    the result is a QuickJS promise handle that we resolve via ctx.resolvePromise().
    //    Extra positional args (e.g. webhook headers) follow ctx in order.
    const extraArgsLiteral = (req.extraArgs ?? [])
      .map((a) => JSON.stringify(a))
      .map((s) => `, ${s}`)
      .join("")
    const callCode = `${req.exportName}(${JSON.stringify(req.params)}, __ctx${extraArgsLiteral})`
    const callResult = ctx.evalCode(callCode, "handler-call.js")
    if (callResult.error) {
      const errVal = ctx.dump(callResult.error)
      try {
        callResult.error.dispose()
      } catch {
        /* ok */
      }
      throw hostErrorFromDump(errVal)
    }

    // Check if the result is a promise (async handler)
    const promiseState = ctx.getPromiseState(callResult.value)
    // A settled state hands out a new handle of its own. Left undisposed it keeps the whole
    // context alive, bundle included, in the runtime every execution of this worker shares.
    if (!(promiseState as any).notAPromise) {
      if (promiseState.type === "fulfilled") promiseState.value.dispose()
      else if (promiseState.type === "rejected") promiseState.error.dispose()
    }
    let result: unknown
    if ((promiseState as any).notAPromise) {
      // Synchronous handler — dump directly
      try {
        result = ctx.dump(callResult.value)
      } finally {
        callResult.value.dispose()
      }
    } else {
      // Async handler — resolve the QuickJS promise to a native Promise.
      // Bridge calls create sub-promises resolved via deferred.settled.then(executePendingJobs).
      // Subscribe FIRST, then pump the job queue once before awaiting: an
      // async handler that settles without any bridge call (the
      // filter-and-return-early shape of manifest EVENT handlers) leaves both
      // its own reaction jobs AND resolvePromise's internal `.then`
      // subscription sitting in the QuickJS job queue with nothing to drain
      // them — the bridge-result pump never fires, so the await would hang
      // forever and the pool would kill the worker at the exec timeout. The
      // pump must run AFTER resolvePromise registers its reactions (a pump
      // before it drains the handler's jobs but not the subscription's).
      // Harmless when the handler is awaiting a bridge call — the
      // deferred.settled pump takes over from there.
      const resolvedPromise = ctx.resolvePromise(callResult.value)
      rt.executePendingJobs()
      const resolved = await resolvedPromise
      try {
        callResult.value.dispose()
      } catch {
        /* ok */
      }
      if (resolved.error) {
        const errVal = ctx.dump(resolved.error)
        try {
          resolved.error.dispose()
        } catch {
          /* ok */
        }
        throw hostErrorFromDump(errVal)
      }
      try {
        result = ctx.dump(resolved.value)
      } finally {
        resolved.value.dispose()
      }
    }

    // rssBytes lets the pool retire this worker once its footprint drifts too
    // high: the shared QuickJS WASM runtime only ever grows (WASM memory cannot
    // shrink, and the runtime accumulates interned atoms across per-request
    // bundle evals), so a long-lived worker's RSS ratchets toward the gigabyte
    // range and eventually trips the container's cgroup OOM-killer.
    if (req.measureHeap) sampleHeap()
    sendMessage({
      type: "result",
      id: req.id,
      data: result ?? null,
      rssBytes: ownRssBytes(),
      ...(req.measureHeap ? { heapBytes: heapPeak } : {}),
    })
  } catch (err: any) {
    const timedOut = Date.now() > deadline
    let msg: string
    try {
      msg = timedOut
        ? "App execution timed out"
        : typeof err?.message === "string"
          ? err.message
          : `${err}`
    } catch {
      msg = "Unknown sandbox error"
    }
    try {
      // A handler that threw a ToolError (a vetted-safe, caller-actionable
      // domain error) flags the message as safe to surface even for an
      // untrusted app in production. Carry that intent + its code/retryable
      // across IPC as plain fields so the pool can reconstruct the ToolError
      // host-side. The timeout branch stays a plain redactable message: a
      // timeout is never a deliberate safe error.
      const safe = !timedOut && err?.safe === true
      // The HTTP class of a typed throw (a connector's upstream 4xx) crosses
      // too: it is a number, never handler text, and without it the host
      // cannot tell an upstream rejection from a crash.
      const status =
        !timedOut && Number.isInteger(err?.status) && err.status >= 400 && err.status < 600
          ? (err.status as number)
          : undefined
      sendMessage({
        type: "error",
        id: req.id,
        error: msg,
        rssBytes: ownRssBytes(),
        ...(!timedOut && !safe && typeof err?.name === "string"
          ? { errorName: (err.name as string).slice(0, 64) }
          : {}),
        ...(status !== undefined
          ? {
              errorStatus: status,
              ...(!safe && typeof err?.code === "string" ? { errorCode: err.code } : {}),
            }
          : {}),
        ...(safe
          ? {
              toolErrorSafe: true,
              toolErrorCode: typeof err?.code === "string" ? err.code : "tool_error",
              toolErrorRetryable: err?.retryable === true,
            }
          : {}),
      })
    } catch {
      /* ok */
    }
  } finally {
    // Drain pending jobs first: one may still start a bridge call.
    try {
      rt.executePendingJobs()
    } catch {
      /* ok */
    }
    // A call nobody answered in time (an un-awaited `ctx.logger.*`, a timeout) still holds its
    // deferred's handles. Clear the map too, so stale callbacks don't reference the old context.
    for (const pending of pendingBridgeCalls.values()) {
      try {
        pending.dispose()
      } catch {
        /* ok */
      }
    }
    pendingBridgeCalls.clear()
    for (const h of handles) {
      try {
        h.dispose()
      } catch {
        /* ok */
      }
    }
    // The context goes; the runtime is long-lived (shared across requests).
    try {
      ctx.dispose()
    } catch {
      /* ok */
    }
    // Runtime is long-lived (shared across requests) — not disposed here
  }
}

// -- Message loop ------------------------------------------------------------

let ready = false
const messageQueue: any[] = []

function processMessage(msg: any): void {
  if (msg.type === "execute") {
    handleExecute(msg)
  } else if (msg.type === "bridge_result") {
    const pending = pendingBridgeCalls.get(msg.callId)
    if (pending) {
      pendingBridgeCalls.delete(msg.callId)
      if (msg.error) {
        pending.reject(
          msg.error,
          typeof msg.errorStatus === "number"
            ? {
                status: msg.errorStatus,
                ...(typeof msg.errorCode === "string" ? { code: msg.errorCode } : {}),
              }
            : undefined,
        )
      } else pending.resolve(msg.data)
    }
  } else if (msg.type === "shutdown") {
    process.exit(0)
  }
}

process.on("message", (msg: any) => {
  if (msg.type === "bridge_result" || msg.type === "shutdown") {
    processMessage(msg)
  } else if (!ready) {
    messageQueue.push(msg)
  } else {
    processMessage(msg)
  }
})

// -- Init --------------------------------------------------------------------

async function init() {
  module = await newQuickJSAsyncWASMModule()
  sharedRuntime = module.newRuntime()
  sharedRuntime.setMaxStackSize(DEFAULT_MAX_STACK)
  ready = true
  sendMessage({ type: "ready" })
  for (const msg of messageQueue) processMessage(msg)
  messageQueue.length = 0
}

init().catch((err) => {
  process.stderr?.write?.(`Sandbox worker init failed: ${err.message}\n`)
  process.exit(1)
})
