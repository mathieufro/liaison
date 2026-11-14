// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The small jobs: the catch-up of failed deliveries, the ledger's prune, and the
// mirror's removal when Stripe is disconnected.
//
// CATCH-UP (`catchup-retry`, each minute while a resource is marked due). A
// delivery the dispatch could not apply (Stripe refused the key or a permission,
// Stripe or the database failed) stays `failed` in the ledger. Each is played
// again from Stripe's copy of the event, through the same dispatch, which takes
// a `failed` row up again and applies it once. When none is left failed, the
// marks are cleared. Nothing runs while the key is refused or the account is
// unconfirmed: that waits for a person.
//
// PRUNE (`prune-webhook-deliveries`, nightly). Ledger rows older than 30 days
// are removed (Stripe stops retrying after 3 days); held and failed rows stay.
//
// DISCONNECT. Every `app_stripe` row of the org goes, the connection's row
// first, so nothing is written for it any more; no invoicing document is
// touched (the app cannot reach them). A removal cut short by its time budget
// is carried on by `purge-mirror`, which stops as soon as Stripe is connected
// again.
import { handleStripeEvent, type IngestCtx } from "../dispatch"
import { StripeApiError, stripeFetch } from "../http"
import { blockedOverlay, holdWhileImporting, readInstall } from "../states"
import { Budget, DEFAULT_BUDGET_MS, type SyncCtx, type SyncOptions } from "./common"

type Obj = Record<string, unknown>

const CATCHUP_PER_RUN = 50

export async function runCatchup(
  ctx: SyncCtx,
  opts: SyncOptions = {},
): Promise<{ replayed: number; cleared: boolean; detail?: string }> {
  const now = opts.now ?? (() => new Date())
  const budget = new Budget(now, opts.budgetMs ?? DEFAULT_BUDGET_MS)
  const install = await readInstall(ctx.db)
  if (!install) return { replayed: 0, cleared: false, detail: "not connected" }
  const blocked = blockedOverlay(install)
  if (blocked) return { replayed: 0, cleared: false, detail: blocked }

  const failed = (await ctx.db.findMany("webhook_deliveries", {
    where: { status: "failed" },
    orderBy: { received_at: "asc" },
    limit: CATCHUP_PER_RUN,
  })) as Array<{ id: string; event_id: string }>
  let replayed = 0
  for (const d of failed) {
    if (budget.spent) return { replayed, cleared: false, detail: "time budget spent" }
    let event: unknown
    try {
      event = await stripeFetch(ctx, `/v1/events/${encodeURIComponent(d.event_id)}`, {})
    } catch (err) {
      if (err instanceof StripeApiError && err.status === 404) {
        // Older than Stripe keeps events: the nightly reconcile reads the object itself.
        await ctx.db.update("webhook_deliveries", d.id, { status: "ignored" })
        continue
      }
      return {
        replayed,
        cleared: false,
        detail: err instanceof Error ? err.message : "Stripe did not answer",
      }
    }
    await holdWhileImporting(event, ctx, (c) => handleStripeEvent(event, c as unknown as IngestCtx))
    replayed++
    const fresh = await readInstall(ctx.db)
    if (fresh && blockedOverlay(fresh))
      return { replayed, cleared: false, detail: String(fresh.state) }
  }
  const left = await ctx.db.findMany("webhook_deliveries", {
    where: { status: "failed" },
    limit: 1,
  })
  if (left.length > 0) return { replayed, cleared: false }
  await ctx.db.updateMany("sync_state", {
    where: { catchup_due: true },
    data: { catchup_due: false, last_error_code: null, updated: now().toISOString() },
  })
  return { replayed, cleared: true }
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const PRUNE_CAP = 1000
const KEEP = new Set(["held", "failed", "processing"])

export async function runPrune(ctx: SyncCtx, opts: SyncOptions = {}): Promise<{ pruned: number }> {
  const now = opts.now ?? (() => new Date())
  const budget = new Budget(now, opts.budgetMs ?? DEFAULT_BUDGET_MS)
  const cutoff = now().getTime() - RETENTION_MS
  let pruned = 0
  let offsetGuard = 0
  while (pruned < PRUNE_CAP && !budget.spent && offsetGuard < 20) {
    offsetGuard++
    const rows = (await ctx.db.findMany("webhook_deliveries", {
      orderBy: { received_at: "asc" },
      limit: 200,
    })) as Obj[]
    let removed = 0
    for (const r of rows) {
      const at =
        r.received_at instanceof Date ? r.received_at.getTime() : Date.parse(String(r.received_at))
      if (!Number.isFinite(at) || at >= cutoff) return { pruned }
      if (KEEP.has(String(r.status))) continue
      await ctx.db.delete("webhook_deliveries", String(r.id))
      pruned++
      removed++
    }
    if (removed === 0) break
  }
  return { pruned }
}

/** Every app table, the connection's row first. */
export const PURGE_ORDER = [
  "install_metadata",
  "sync_state",
  "webhook_deliveries",
  "stripe_mrr_events",
  "stripe_disputes",
  "stripe_refunds",
  "stripe_payments",
  "stripe_invoices",
  "stripe_subscriptions",
  "stripe_customers",
] as const

export interface PurgeCtx extends SyncCtx {
  enqueueJob?(jobName: string, payload: unknown): Promise<void>
}

/** Remove every mirror row of the org. `reconnected`: Stripe was connected again, nothing more is removed. */
export async function purgeMirror(
  ctx: PurgeCtx,
  opts: SyncOptions & { first?: boolean } = {},
): Promise<{ removed: number; done: boolean; reconnected?: boolean }> {
  const now = opts.now ?? (() => new Date())
  const budget = new Budget(now, opts.budgetMs ?? DEFAULT_BUDGET_MS)
  if (!opts.first && (await readInstall(ctx.db)))
    return { removed: 0, done: true, reconnected: true }
  let removed = 0
  for (const entity of PURGE_ORDER) {
    while (true) {
      if (budget.spent) {
        await ctx.enqueueJob?.("purge-mirror", {})
        return { removed, done: false }
      }
      const rows = (await ctx.db.findMany(entity, { limit: 200 })) as Obj[]
      if (rows.length === 0) break
      for (const r of rows) {
        await ctx.db.delete(entity, String(r.id))
        removed++
      }
    }
  }
  return { removed, done: true }
}

/** `kernel/connected_account:disconnect`: the org's Stripe connection was removed. */
export async function onDisconnect(
  event: { data?: { appName?: unknown } | null },
  ctx: PurgeCtx,
  opts: SyncOptions = {},
): Promise<{ removed: number; done: boolean } | null> {
  if (event?.data?.appName !== "stripe") return null
  return purgeMirror(ctx, { ...opts, first: true })
}
