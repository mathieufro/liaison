// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Admission for runs on the Workers executor. The isolate costs this server
// nothing while it runs, but its bridge does: every run holds a registry entry
// and its bridge calls, and a run whose bridge holds a database transaction
// (atomic tools, primary webhook delivery, ambient jobs and events) keeps a
// pool connection open across internet round trips for its whole duration.
//
//   top-level runs  at most PER_ORG in flight per org; the rest wait in one
//                   FIFO queue (bounded by the run's own timeout, and by its
//                   caller's abort signal)
//   holdsTx runs    at most HOLDS_TX_GLOBAL in flight across the process, the
//                   worker pool's background cap (maxSize - reserved
//                   interactive), so Workers never holds more transactions
//                   open than the pool could; top-level ones queue for it
//   nested runs     NEVER queue: the parent holds its own slot while it waits
//                   for the child, so a queued child can wait on its own
//                   parent (worker-pool.ts executeNested has the same rule).
//                   They take no per-org or holdsTx slot from the queue's
//                   point of view, are counted, and are bounded by a breadth
//                   per parent execution; past it they are refused at once.

import { sandboxCancelledError } from "~/lib/failure-severity"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "apps-workers-admission" })

export const WORKERS_MAX_IN_FLIGHT_PER_ORG = 16
export const WORKERS_MAX_NESTED_BREADTH_PER_PARENT = 8

/** The worker pool's background cap with its own defaults (worker-pool.ts). */
export function poolBackgroundCap(): number {
  const maxSize = Number(process.env.APP_WORKER_POOL_MAX) || 8
  const reserved = Number(process.env.APP_WORKER_POOL_RESERVED_INTERACTIVE) || 1
  return Math.max(1, maxSize - Math.max(0, Math.min(reserved, maxSize - 1)))
}

const UNKEYED_PARENT = "(unkeyed parent)"

export interface AdmissionLimits {
  perOrg: number
  nestedBreadthPerParent: number
  holdsTxGlobal: number
}

export interface AdmissionRequest {
  orgId: string
  holdsTx: boolean
  nested: boolean
  nestedParentKey?: string
  /** How long a top-level run may wait in the queue. */
  waitMs: number
  signal?: AbortSignal
  appName?: string
}

interface Waiter {
  req: AdmissionRequest
  admit: () => void
}

export class WorkersAdmission {
  private limits: AdmissionLimits
  private readonly perOrg = new Map<string, number>()
  private holdsTx = 0
  private readonly nestedByParent = new Map<string, number>()
  private readonly queue: Waiter[] = []

  constructor(limits?: Partial<AdmissionLimits>) {
    this.limits = {
      perOrg: WORKERS_MAX_IN_FLIGHT_PER_ORG,
      nestedBreadthPerParent: WORKERS_MAX_NESTED_BREADTH_PER_PARENT,
      holdsTxGlobal: poolBackgroundCap(),
      ...limits,
    }
  }

  /** Tests: change the limits (queued runs are re-examined). */
  setLimits(limits: Partial<AdmissionLimits>): void {
    this.limits = { ...this.limits, ...limits }
    this.drain()
  }

  getLimits(): AdmissionLimits {
    return { ...this.limits }
  }

  /** In-flight counters (tests, diagnostics). */
  stats(): { orgs: Record<string, number>; holdsTx: number; queued: number; nested: number } {
    let nested = 0
    for (const n of this.nestedByParent.values()) nested += n
    return {
      orgs: Object.fromEntries(this.perOrg),
      holdsTx: this.holdsTx,
      queued: this.queue.length,
      nested,
    }
  }

  /** Resolves with the release function once the run may start. */
  acquire(req: AdmissionRequest): Promise<() => void> {
    if (req.signal?.aborted) return Promise.reject(sandboxCancelledError())
    if (req.nested) {
      try {
        return Promise.resolve(this.admitNested(req))
      } catch (err) {
        return Promise.reject(err)
      }
    }
    // Never jump ahead of a queued run competing for the same slot.
    const behind = this.queue.some(
      (w) => w.req.orgId === req.orgId || (req.holdsTx && w.req.holdsTx),
    )
    if (!behind && this.fits(req)) return Promise.resolve(this.take(req))
    return new Promise<() => void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const leave = () => {
        const i = this.queue.indexOf(waiter)
        if (i !== -1) this.queue.splice(i, 1)
        if (timer) clearTimeout(timer)
        req.signal?.removeEventListener("abort", onAbort)
      }
      const onAbort = () => {
        leave()
        reject(sandboxCancelledError())
      }
      const waiter: Waiter = {
        req,
        admit: () => {
          leave()
          resolve(this.take(req))
        },
      }
      timer = setTimeout(
        () => {
          leave()
          log.warn(
            { orgId: req.orgId, app: req.appName, runHoldsTx: req.holdsTx, ...this.stats() },
            "Workers run timed out waiting for admission",
          )
          reject(new Error("Queued sandbox request timed out waiting for a free worker"))
          // A waiter that left may unblock the next one (FIFO head).
          this.drain()
        },
        Math.max(0, req.waitMs),
      )
      req.signal?.addEventListener("abort", onAbort, { once: true })
      this.queue.push(waiter)
    })
  }

  private fits(req: AdmissionRequest): boolean {
    if ((this.perOrg.get(req.orgId) ?? 0) >= this.limits.perOrg) return false
    if (req.holdsTx && this.holdsTx >= this.limits.holdsTxGlobal) return false
    return true
  }

  private take(req: AdmissionRequest): () => void {
    this.perOrg.set(req.orgId, (this.perOrg.get(req.orgId) ?? 0) + 1)
    if (req.holdsTx) this.holdsTx++
    let released = false
    return () => {
      if (released) return
      released = true
      const n = (this.perOrg.get(req.orgId) ?? 1) - 1
      if (n > 0) this.perOrg.set(req.orgId, n)
      else this.perOrg.delete(req.orgId)
      if (req.holdsTx) this.holdsTx--
      this.drain()
    }
  }

  private admitNested(req: AdmissionRequest): () => void {
    const key = req.nestedParentKey ?? UNKEYED_PARENT
    const outstanding = this.nestedByParent.get(key) ?? 0
    if (outstanding >= this.limits.nestedBreadthPerParent) {
      log.error(
        { orgId: req.orgId, app: req.appName, parentKey: key, outstanding },
        "Nested Workers dispatch refused: per-parent breadth reached",
      )
      const err = new Error(
        `Sandbox reentrancy limit reached: nested tool call refused (per-parent breadth ${this.limits.nestedBreadthPerParent})`,
      )
      err.name = "SandboxReentrancyLimit"
      throw err
    }
    this.nestedByParent.set(key, outstanding + 1)
    // Counted (so top-level runs see the load) but never blocked by the caps.
    this.perOrg.set(req.orgId, (this.perOrg.get(req.orgId) ?? 0) + 1)
    if (req.holdsTx) this.holdsTx++
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (this.nestedByParent.get(key) ?? 1) - 1
      if (left > 0) this.nestedByParent.set(key, left)
      else this.nestedByParent.delete(key)
      const n = (this.perOrg.get(req.orgId) ?? 1) - 1
      if (n > 0) this.perOrg.set(req.orgId, n)
      else this.perOrg.delete(req.orgId)
      if (req.holdsTx) this.holdsTx--
      this.drain()
    }
  }

  /** Admit queued runs in order; a head that does not fit does not block others of other orgs. */
  private drain(): void {
    for (let i = 0; i < this.queue.length; ) {
      const w = this.queue[i] as Waiter
      if (this.fits(w.req)) {
        w.admit() // splices itself out
      } else {
        i++
      }
    }
  }
}

/** The process's admission (the Workers executor's). */
export const workersAdmission = new WorkersAdmission()
