// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Workers executor: one app run on the remote V8 isolate loader.
//
//   1. admission (admission.ts): per-org queue, holdsTx cap, nested never queued
//   2. registerRun (run-registry.ts): the run's own bridge, built by the
//      dispatching code in its frame, behind a one-run bearer token
//   3. POST <loaderUrl>/run, signed (sign.ts), with the run token, the
//      bridge URL and the method list; the isolate calls back on
//      /api/app-bridge/<runId> (bridge-route.ts)
//   4. the loader's answer becomes the run's result, or an Error shaped like
//      the worker pool's for the same failure (a timeout is
//      "App execution timed out"; a handler's message, name, status and code,
//      and an app-sdk ToolError's safe/code/retryable, are kept)
//   5. finally: the token is revoked (settle) and the admission slot freed
//
// Nothing secret goes in the request: the run token is the run's only
// credential and dies with it; provider secrets never leave this server
// (forWorkersRun, sandbox/bridge/secret-free.ts, applied by runApp).

import { sandboxCancelledError } from "~/lib/failure-severity"
import { rootLogger } from "~/lib/logger"
import { type WorkersAdmission, workersAdmission } from "./admission"
import { bridgeUrlFor, type WorkersConfig } from "./config"
import { type RunBridge, type RunRegistry, runRegistry } from "./run-registry"
import { signCellRequest } from "./sign"
import type { LoaderTimings } from "./timings"

const log = rootLogger.child({ module: "apps-workers-executor" })

/** Same default as the worker pool's (worker-pool.ts DEFAULT_TIMEOUT). */
export function defaultWorkersTimeoutMs(): number {
  return process.env.NODE_ENV === "production" ? 5_000 : 60_000
}
/** The cell's own fetch to the loader outlives the run's deadline by this much. */
export const LOADER_FETCH_GRACE_MS = 5_000
/** Fixed per-run limits the loader applies (it caps them itself too). */
export const WORKERS_RUN_LIMITS = { cpuMs: 30_000, subRequests: 10_000 } as const

export interface WorkersRunOptions {
  config: WorkersConfig
  appName: string
  orgId: string
  version: string
  /** sha256 of the Worker module (LIAISON_WORKERS_BUNDLES), not of the package. */
  bundleSha256: string
  exportName: string
  params: unknown
  extraArgs?: unknown[]
  /** The K6 approval literal (`ctx.approval`). */
  approval?: unknown
  bridge: RunBridge
  timeoutMs?: number
  signal?: AbortSignal
  holdsTx: boolean
  nested?: boolean
  nestedParentKey?: string
  /** Seams for tests. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  admission?: WorkersAdmission
  registry?: RunRegistry
}

/** What a run reports besides its result (for the run timing line). */
export interface WorkersRunInfo {
  runId?: string
  loader?: LoaderTimings
  sleepMs?: number
  sleepExact?: boolean
}

interface LoaderError {
  message?: unknown
  kind?: unknown
  status?: unknown
  code?: unknown
  name?: unknown
  safe?: unknown
  retryable?: unknown
}

interface LoaderAnswer {
  ok?: unknown
  result?: unknown
  error?: LoaderError
  timings?: Record<string, unknown>
}

function loaderTimings(t: Record<string, unknown> | undefined): LoaderTimings | undefined {
  if (!t || typeof t !== "object") return undefined
  const out: LoaderTimings = {}
  for (const k of ["loadMs", "runMs", "bridgeCalls", "bridgeMsTotal", "workerRunMs"] as const) {
    if (typeof t[k] === "number") out[k] = t[k] as number
  }
  if (typeof t.cold === "boolean") out.cold = t.cold
  return out
}

/** A loader `{ok:false}` error -> the Error the worker pool raises for the same failure. */
export function errorFromLoader(error: LoaderError | undefined, httpStatus: number): Error {
  const message = typeof error?.message === "string" ? error.message : "Unknown sandbox error"
  const kind = typeof error?.kind === "string" ? error.kind : "load"
  if (kind === "timeout") return new Error("App execution timed out")
  if (kind === "handler") {
    if (error?.safe === true) {
      const e = new Error(message) as Error & { safe: true; code: string; retryable: boolean }
      e.name = "ToolError"
      e.safe = true
      e.code = typeof error.code === "string" ? error.code : "tool_error"
      e.retryable = error.retryable === true
      if (typeof error.status === "number") (e as Error & { status?: number }).status = error.status
      return e
    }
    const e = new Error(message) as Error & { status?: number; code?: string }
    if (typeof error?.name === "string" && error.name) e.name = error.name.slice(0, 64)
    if (typeof error?.status === "number") {
      e.status = error.status
      if (typeof error.code === "string") e.code = error.code
    }
    return e
  }
  // The loader refused or could not run the module: an infrastructure fault,
  // never the app's own error (no status, so it is not mistaken for one).
  const e = new Error(`App loader could not run the app (${kind}, HTTP ${httpStatus}): ${message}`)
  e.name = "WorkersRunError"
  return e
}

/** Run one export on the loader. `onInfo` gets the run's id and timings, whatever the outcome. */
export async function executeOnWorkers(
  opts: WorkersRunOptions,
  onInfo?: (info: WorkersRunInfo) => void,
): Promise<unknown> {
  const admission = opts.admission ?? workersAdmission
  const registry = opts.registry ?? runRegistry
  const fetchImpl = opts.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init))
  const timeoutMs = opts.timeoutMs ?? defaultWorkersTimeoutMs()
  const info: WorkersRunInfo = {}

  const release = await admission.acquire({
    orgId: opts.orgId,
    holdsTx: opts.holdsTx,
    nested: opts.nested === true,
    ...(opts.nestedParentKey !== undefined ? { nestedParentKey: opts.nestedParentKey } : {}),
    waitMs: timeoutMs,
    ...(opts.signal ? { signal: opts.signal } : {}),
    appName: opts.appName,
  })
  let run: ReturnType<RunRegistry["registerRun"]> | undefined
  try {
    // Exactly what the pool hands its subprocess: every key of the bridge.
    const bridgeMethods = Object.keys(opts.bridge)
    run = registry.registerRun({
      bridge: opts.bridge,
      bridgeMethods,
      orgId: opts.orgId,
      appName: opts.appName,
      version: opts.version,
      timeoutMs,
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    info.runId = run.runId
    const body = JSON.stringify({
      runId: run.runId,
      orgId: opts.orgId,
      app: opts.appName,
      version: opts.version,
      sha256: opts.bundleSha256,
      exportName: opts.exportName,
      params: opts.params ?? null,
      extraArgs: opts.extraArgs ?? [],
      approval: opts.approval ?? null,
      bridgeMethods,
      bridgeUrl: bridgeUrlFor(opts.config, run.runId),
      runToken: run.runToken,
      deadlineMs: timeoutMs,
      limits: WORKERS_RUN_LIMITS,
    })
    const headers = {
      "content-type": "application/json",
      ...signCellRequest(opts.config.cellId, opts.config.loaderKey, body),
    }
    const fetchTimeout = AbortSignal.timeout(timeoutMs + LOADER_FETCH_GRACE_MS)
    const signal = opts.signal ? AbortSignal.any([opts.signal, fetchTimeout]) : fetchTimeout

    let res: Response
    let text: string
    try {
      res = await fetchImpl(`${opts.config.loaderUrl}/run`, {
        method: "POST",
        headers,
        body,
        signal,
      })
      text = await res.text()
    } catch (err) {
      if (opts.signal?.aborted) throw sandboxCancelledError()
      if (fetchTimeout.aborted) throw new Error("App execution timed out")
      log.error(
        { err, app: opts.appName, orgId: opts.orgId, runId: run.runId },
        "App loader unreachable",
      )
      const e = new Error(`App loader unreachable: ${(err as Error)?.message ?? String(err)}`)
      e.name = "WorkersRunError"
      throw e
    }

    let answer: LoaderAnswer | null = null
    try {
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        answer = parsed as LoaderAnswer
      }
    } catch {
      answer = null
    }
    const t = answer?.timings
    const lt = loaderTimings(t)
    if (lt) info.loader = lt
    if (t && typeof t.sleepMs === "number") info.sleepMs = t.sleepMs
    if (t && typeof t.sleepExact === "boolean") info.sleepExact = t.sleepExact

    if (res.status === 200 && answer?.ok === true) {
      return answer.result === undefined ? null : answer.result
    }
    const err = errorFromLoader(answer?.error, res.status)
    if (err.name === "WorkersRunError") {
      log.error(
        {
          app: opts.appName,
          orgId: opts.orgId,
          runId: run.runId,
          status: res.status,
          kind: answer?.error?.kind,
          code: answer?.error?.code,
          message: answer?.error?.message ?? text.slice(0, 200),
        },
        "App loader refused or failed the run",
      )
    }
    throw err
  } finally {
    if (run) {
      const stats = run.settle()
      info.loader = info.loader ?? {}
      // The cell's own view of the bridge, when the loader said nothing.
      info.loader.bridgeCalls ??= stats.bridgeCalls
      info.loader.bridgeMsTotal ??= stats.bridgeMsTotal
    }
    release()
    onInfo?.(info)
  }
}
