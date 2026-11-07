// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The runs whose app code executes on a remote isolate, by run id, with the
// bridge object the DISPATCHING code built for that run (in its own frame:
// read-only mark, RLS actor, signal), and the bearer token that alone may drive
// it over /api/app-bridge/:runId. The route never builds a bridge.
//
// One process: Workers is selected only under role "all" (config.ts), so the
// process that registered a run is the one its isolate calls back.
//
// A token is 32 random bytes (base64url); only its sha256 is kept. It is bound
// to one run, hence to one org and one app; it dies when the run settles (its
// handler returned, its caller aborted, or its deadline passed).

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"

/** Extra time past the run's own timeout before its token expires. */
export const RUN_DEADLINE_GRACE_MS = 10_000
/** How long a settled run is remembered (410 instead of 401 unknown_run). */
const TOMBSTONE_TTL_MS = 10 * 60_000
const TOMBSTONE_MAX = 10_000

/** A bridge as the dispatching code builds it: method name -> function. */
export type RunBridge = Record<string, unknown>

export interface RegisterRunOptions {
  bridge: RunBridge
  /** The methods the run may call: the shim's list, a subset of the bridge's own keys. */
  bridgeMethods: readonly string[]
  orgId: string
  appName: string
  version: string
  timeoutMs: number
  /** Aborting it settles the run. */
  signal?: AbortSignal
  /** Overrides the registry's grace past `timeoutMs` for this run (test probes). */
  graceMs?: number
}

export interface RunStats {
  bridgeCalls: number
  bridgeMsTotal: number
}

export interface RegisteredRun {
  runId: string
  /** The bearer token, handed to the loader once; never stored in clear. */
  runToken: string
  /** Epoch ms after which the token is refused. */
  deadline: number
  /** Revokes the token. Idempotent; returns the run's bridge call counters. */
  settle(): RunStats
}

export interface RunEntry {
  readonly runId: string
  readonly orgId: string
  readonly appName: string
  readonly version: string
  readonly bridge: RunBridge
  readonly bridgeMethods: ReadonlySet<string>
  readonly deadline: number
  readonly tokenHash: Buffer
  nonce: string | undefined
  stats: RunStats
}

interface Tombstone {
  tokenHash: Buffer
  reason: "settled" | "expired"
  at: number
}

export type RunAuthResult =
  | { kind: "ok"; entry: RunEntry }
  /** 401: no run of that id (never registered, or forgotten long ago). */
  | { kind: "unknown_run" }
  /** 401: no token, or one that belongs to no live run. */
  | { kind: "bad_token" }
  /** 403: a valid token of ANOTHER run. */
  | { kind: "wrong_run" }
  /** 401: the run's deadline passed. */
  | { kind: "expired" }
  /** 410: the run settled. */
  | { kind: "settled" }
  /** 409: a second execution (another nonce) tried to drive this run. */
  | { kind: "nonce_mismatch" }

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest()
}

function sameHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface RunRegistryOptions {
  now?: () => number
  /** Overrides RUN_DEADLINE_GRACE_MS (tests). */
  graceMs?: number
}

export class RunRegistry {
  private readonly runs = new Map<string, RunEntry>()
  /** sha256(token) hex -> runId, to tell "another run's token" from garbage. */
  private readonly byToken = new Map<string, string>()
  private readonly tombstones = new Map<string, Tombstone>()
  /** The registry's clock; deadlines are in its time. */
  readonly now: () => number
  private readonly graceMs: number

  constructor(opts: RunRegistryOptions = {}) {
    this.now = opts.now ?? Date.now
    this.graceMs = opts.graceMs ?? RUN_DEADLINE_GRACE_MS
  }

  registerRun(opts: RegisterRunOptions): RegisteredRun {
    const runId = randomUUID()
    const runToken = randomBytes(32).toString("base64url")
    const tokenHash = sha256(runToken)
    const deadline =
      this.now() + Math.max(0, opts.timeoutMs) + Math.max(0, opts.graceMs ?? this.graceMs)
    // Only the methods the bridge itself owns (no prototype lookups), and that
    // the dispatching code listed.
    const methods = new Set(
      opts.bridgeMethods.filter(
        (m) => Object.hasOwn(opts.bridge, m) && typeof opts.bridge[m] === "function",
      ),
    )
    const entry: RunEntry = {
      runId,
      orgId: opts.orgId,
      appName: opts.appName,
      version: opts.version,
      bridge: opts.bridge,
      bridgeMethods: methods,
      deadline,
      tokenHash,
      nonce: undefined,
      stats: { bridgeCalls: 0, bridgeMsTotal: 0 },
    }
    this.runs.set(runId, entry)
    this.byToken.set(tokenHash.toString("hex"), runId)

    const timer = setTimeout(() => this.retire(runId, "expired"), deadline - this.now())
    timer.unref?.()
    const onAbort = () => this.retire(runId, "settled")
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()

    return {
      runId,
      runToken,
      deadline,
      settle: () => {
        clearTimeout(timer)
        opts.signal?.removeEventListener("abort", onAbort)
        this.retire(runId, "settled")
        return { ...entry.stats }
      },
    }
  }

  /**
   * Authenticates one bridge call: the run, its token (constant-time), its
   * state, its deadline, and the execution nonce (the first one seen is pinned).
   */
  authenticate(runId: string, token: string | undefined, nonce: string | undefined): RunAuthResult {
    const entry = this.runs.get(runId)
    const tomb = entry ? undefined : this.tombstones.get(runId)
    if (!entry && !tomb) return { kind: "unknown_run" }
    if (!token) return { kind: "bad_token" }

    const presented = sha256(token)
    const expected = entry ? entry.tokenHash : (tomb as Tombstone).tokenHash
    if (!sameHash(presented, expected)) {
      const other = this.byToken.get(presented.toString("hex"))
      return other !== undefined && other !== runId ? { kind: "wrong_run" } : { kind: "bad_token" }
    }
    if (tomb) return { kind: tomb.reason }
    const live = entry as RunEntry
    if (this.now() > live.deadline) {
      this.retire(runId, "expired")
      return { kind: "expired" }
    }
    if (!nonce) return { kind: "nonce_mismatch" }
    if (live.nonce === undefined) live.nonce = nonce
    else if (!sameHash(sha256(live.nonce), sha256(nonce))) return { kind: "nonce_mismatch" }
    return { kind: "ok", entry: live }
  }

  /** Live runs (tests and diagnostics). */
  size(): number {
    return this.runs.size
  }

  private retire(runId: string, reason: Tombstone["reason"]): void {
    const entry = this.runs.get(runId)
    if (!entry) return
    this.runs.delete(runId)
    this.byToken.delete(entry.tokenHash.toString("hex"))
    const at = this.now()
    this.tombstones.set(runId, { tokenHash: entry.tokenHash, reason, at })
    this.pruneTombstones(at)
  }

  private pruneTombstones(now: number): void {
    for (const [id, t] of this.tombstones) {
      if (this.tombstones.size <= TOMBSTONE_MAX && now - t.at <= TOMBSTONE_TTL_MS) break
      this.tombstones.delete(id)
    }
  }
}

/** The process's registry (the bridge route and the Workers executor share it). */
export const runRegistry = new RunRegistry()

export function registerRun(opts: RegisterRunOptions): RegisteredRun {
  return runRegistry.registerRun(opts)
}
