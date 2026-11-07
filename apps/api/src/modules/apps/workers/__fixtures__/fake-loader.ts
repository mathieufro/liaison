// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test support: a local stand-in for the app loader Worker, close enough that
// what passes against it passes against the real one.
//
// It does what the loader does, in the same order: cell lookup by x-cell-id,
// signature + ±60 s skew (sign.ts verifyCellRequest), body validation,
// bridgeUrl origin == the cell's registered bridgeOrigin (403), bundle lookup
// at `<app>/<version>/<sha256>.js` and a sha256 re-check of the Worker module
// bytes (409), then ONE module instance per Dynamic Worker id
// `<cellId>:<orgId>:<app>@<version>#<sha256>`, cached like the loader's
// `LOADER.get(id, cb)` (module globals persist across runs of one id). Each
// /run mints a fresh execNonce and hands the module a per-run Bridge (never
// in the module's env) whose `call(method, args)` POSTs the cell's
// /api/app-bridge with the run token and nonce, exactly like the loader's
// bridge.ts. The run races `deadlineMs`; a timeout answers
// `{ok:false, error:{kind:"timeout"}}` while the module keeps running (as an
// isolate would until its CPU limit), and its later bridge calls meet a
// settled run.
//
// Differences, on purpose: the module is the build's `worker-core.js` (no
// `cloudflare:workers` import) instead of `worker.js`, imported in this
// process (one import per id, via a query string), and fetch is not blocked
// inside it. It also passes the module's `sleepMs` / `sleepExact` through in
// `timings` (the real loader needs the same two fields in its merge).

import { readFileSync } from "node:fs"
import type { Server } from "bun"
import {
  CELL_ID_HEADER,
  CELL_SIGNATURE_HEADER,
  CELL_TS_HEADER,
  sha256Hex,
  verifyCellRequest,
} from "../sign"

export interface FakeLoaderBundle {
  /** The Worker module whose sha256 is the bundle's identity (worker.js). */
  workerPath: string
  /** The same build without the Cloudflare entry (worker-core.js), what runs here. */
  corePath: string
}

export interface FakeLoaderOptions {
  cells: Record<string, { key: string; bridgeOrigin: string }>
  /** `<app>/<version>/<sha256>.js` -> files, the R2 bucket's analogue. */
  bundles: Record<string, FakeLoaderBundle>
  now?: () => number
}

export interface RecordedRun {
  headers: Record<string, string>
  body: string
}

export interface FakeLoader {
  url: string
  stop(): void
  /** Every signed /run that reached the loader, raw (for replay tests). */
  runs: RecordedRun[]
  /** Every bridge-route answer body the isolate received (for secret scans). */
  bridgeResponses: string[]
  /** How many times a Dynamic Worker id was loaded cold. */
  coldLoads: number
  /** Add or replace a bundle while running. */
  setBundle(key: string, bundle: FakeLoaderBundle): void
}

type ErrorKind = "handler" | "timeout" | "limit" | "load" | "auth"
type CoreModule = {
  run(req: unknown, bridge: { call(m: string, a: unknown): Promise<unknown> }): Promise<unknown>
}

const SAFE = /^[A-Za-z0-9._-]{1,128}$/
const SHA = /^[0-9a-f]{64}$/
const MAX_DEADLINE_MS = 15 * 60_000

function fail(status: number, kind: ErrorKind, message: string, extra: { code?: string } = {}) {
  return Response.json({ ok: false, error: { message, kind, ...extra } }, { status })
}

function validateBody(r: Record<string, unknown>): string | null {
  for (const k of ["runId", "orgId", "app", "version", "exportName"] as const) {
    if (typeof r[k] !== "string" || !SAFE.test(r[k] as string)) return `invalid ${k}`
  }
  if (typeof r.sha256 !== "string" || !SHA.test(r.sha256)) return "invalid sha256"
  if (typeof r.bridgeUrl !== "string") return "invalid bridgeUrl"
  if (typeof r.runToken !== "string" || r.runToken.length < 16) return "invalid runToken"
  if (!Array.isArray(r.bridgeMethods) || !r.bridgeMethods.every((m) => typeof m === "string")) {
    return "invalid bridgeMethods"
  }
  if (r.extraArgs !== undefined && !Array.isArray(r.extraArgs)) return "invalid extraArgs"
  if (typeof r.deadlineMs !== "number" || !(r.deadlineMs > 0)) return "invalid deadlineMs"
  return null
}

function isRunVerdict(
  v: unknown,
): v is { ok: boolean; result?: unknown; error?: unknown; timings?: Record<string, unknown> } {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { ok?: unknown }).ok === "boolean" &&
    ("result" in (v as object) || "error" in (v as object))
  )
}

export function startFakeLoader(opts: FakeLoaderOptions): FakeLoader {
  const now = opts.now ?? Date.now
  const bundles = { ...opts.bundles }
  const modules = new Map<string, Promise<CoreModule>>()
  const verified = new Map<string, true>()
  const loader: FakeLoader = {
    url: "",
    stop: () => server.stop(true),
    runs: [],
    bridgeResponses: [],
    coldLoads: 0,
    setBundle: (key, bundle) => {
      bundles[key] = bundle
    },
  }

  async function callBridge(
    props: { bridgeUrl: string; runToken: string; execNonce: string; bridgeMethods: string[] },
    stats: { calls: number; ms: number },
    method: string,
    args: unknown,
  ): Promise<unknown> {
    if (typeof method !== "string" || !props.bridgeMethods.includes(method)) {
      return {
        error: `Unknown bridge method: ${String(method)}`,
        errorStatus: 404,
        errorCode: "unknown_method",
      }
    }
    const t0 = now()
    try {
      const res = await fetch(props.bridgeUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${props.runToken}`,
          "x-exec-nonce": props.execNonce,
          "content-type": "application/json",
        },
        body: JSON.stringify({ callId: crypto.randomUUID(), method, args }),
      })
      const text = await res.text()
      loader.bridgeResponses.push(text)
      let body: Record<string, unknown> | null = null
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed
      } catch {}
      if (res.ok && body && "data" in body) return { data: body.data }
      if (body && typeof body.error === "string") {
        const out: Record<string, unknown> = {
          error: body.error,
          errorStatus: typeof body.errorStatus === "number" ? body.errorStatus : res.status,
        }
        if (typeof body.errorCode === "string") out.errorCode = body.errorCode
        else if (typeof body.reason === "string") out.errorCode = body.reason
        return out
      }
      if (body && typeof body.reason === "string") {
        return { error: body.reason, errorStatus: res.status, errorCode: body.reason }
      }
      // A bare `{}` 200 (undefined data) is `{data: undefined}` to the isolate.
      if (res.ok && body) return { data: undefined }
      return {
        error: `Bridge returned ${res.status}`,
        errorStatus: res.status >= 400 ? res.status : 502,
        errorCode: "bridge_bad_response",
      }
    } catch (e) {
      return {
        error: `Bridge unreachable: ${e instanceof Error ? e.message : String(e)}`,
        errorStatus: 502,
        errorCode: "bridge_unreachable",
      }
    } finally {
      stats.calls++
      stats.ms += now() - t0
    }
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === "/health") return Response.json({ ok: true })
    if (url.pathname !== "/run") return new Response("not found", { status: 404 })
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 })
    const t0 = now()
    const raw = new Uint8Array(await req.arrayBuffer())
    loader.runs.push({
      headers: Object.fromEntries(req.headers.entries()),
      body: new TextDecoder().decode(raw),
    })
    const cellId = req.headers.get(CELL_ID_HEADER)
    const cell = cellId && Object.hasOwn(opts.cells, cellId) ? opts.cells[cellId] : undefined
    if (!cellId || !cell) return fail(401, "auth", "unknown cell")
    const v = verifyCellRequest(
      cell.key,
      req.headers.get(CELL_TS_HEADER),
      req.headers.get(CELL_SIGNATURE_HEADER),
      raw,
      now(),
    )
    if (!v.ok) return fail(401, "auth", `signature rejected: ${v.reason}`)

    let body: Record<string, unknown>
    try {
      body = JSON.parse(new TextDecoder().decode(raw))
    } catch {
      return fail(400, "load", "body is not JSON")
    }
    const invalid = validateBody(body)
    if (invalid) return fail(400, "load", invalid)
    let origin: string
    try {
      origin = new URL(body.bridgeUrl as string).origin
    } catch {
      return fail(400, "load", "invalid bridgeUrl")
    }
    if (origin !== cell.bridgeOrigin)
      return fail(403, "auth", "bridgeUrl origin not allowed for this cell")

    const id = `${cellId}:${body.orgId}:${body.app}@${body.version}#${body.sha256}`
    let cold = false
    if (!verified.has(id)) {
      const bundle = bundles[`${body.app}/${body.version}/${body.sha256}.js`]
      if (!bundle) return fail(404, "load", "bundle not found", { code: "bundle_missing" })
      if (sha256Hex(readFileSync(bundle.workerPath)) !== body.sha256) {
        return fail(409, "load", "bundle hash mismatch", { code: "hash_mismatch" })
      }
      verified.set(id, true)
      modules.set(
        id,
        import(`${bundle.corePath}?id=${encodeURIComponent(id)}`) as Promise<CoreModule>,
      )
      loader.coldLoads++
      cold = true
    }
    const loadMs = now() - t0

    const execNonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")
    const stats = { calls: 0, ms: 0 }
    const props = {
      bridgeUrl: body.bridgeUrl as string,
      runToken: body.runToken as string,
      execNonce,
      bridgeMethods: body.bridgeMethods as string[],
    }
    const bridge = { call: (m: string, a: unknown) => callBridge(props, stats, m, a) }
    const workerReq = {
      runId: body.runId,
      orgId: body.orgId,
      app: body.app,
      version: body.version,
      exportName: body.exportName,
      params: body.params,
      extraArgs: (body.extraArgs as unknown[] | undefined) ?? [],
      approval: body.approval ?? null,
      bridgeMethods: body.bridgeMethods,
    }
    const t1 = now()
    const timings = () => ({
      loadMs,
      runMs: now() - t1,
      bridgeCalls: stats.calls,
      bridgeMsTotal: stats.ms,
      cold,
    })
    const deadlineMs = body.deadlineMs as number
    const duration = Math.max(
      0,
      Math.min(deadlineMs > 1e12 ? deadlineMs - now() : deadlineMs, MAX_DEADLINE_MS),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const TIMEOUT = Symbol("timeout")
    try {
      const mod = (await modules.get(id)) as CoreModule
      const outcome = await Promise.race([
        mod.run(workerReq, bridge),
        new Promise<typeof TIMEOUT>((r) => {
          timer = setTimeout(() => r(TIMEOUT), duration)
        }),
      ])
      if (outcome === TIMEOUT) {
        return Response.json({
          ok: false,
          error: { message: "App execution timed out", kind: "timeout" },
          timings: timings(),
        })
      }
      if (isRunVerdict(outcome)) {
        const inner = outcome.timings && typeof outcome.timings === "object" ? outcome.timings : {}
        const merged = {
          ...timings(),
          workerRunMs: inner.runMs,
          sleepMs: inner.sleepMs,
          sleepExact: inner.sleepExact,
        }
        return Response.json(
          outcome.ok
            ? {
                ok: true,
                result: outcome.result === undefined ? null : outcome.result,
                timings: merged,
              }
            : {
                ok: false,
                error: { kind: "handler", ...(outcome.error as object) },
                timings: merged,
              },
        )
      }
      return Response.json({
        ok: true,
        result: outcome === undefined ? null : outcome,
        timings: timings(),
      })
    } catch (e) {
      const err = e as { message?: unknown; status?: unknown; code?: unknown }
      const message = typeof err?.message === "string" ? err.message : String(e)
      const error: Record<string, unknown> = { message, kind: "handler" }
      if (typeof err?.status === "number") error.status = err.status
      if (typeof err?.code === "string") error.code = err.code
      return Response.json({ ok: false, error, timings: timings() })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const server: Server<undefined> = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle })
  loader.url = `http://127.0.0.1:${server.port}`
  return loader
}
