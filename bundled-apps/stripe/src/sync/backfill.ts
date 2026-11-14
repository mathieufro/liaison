// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The first import: every customer, subscription, invoice, charge, refund and
// dispute the account holds, read by list into the mirror.
//
// RESUMABLE. Each resource keeps its place in `sync_state` (`cursor` = the last
// object id written, `done_count`). A page is written first, then the row moves
// on by compare-and-swap; a run killed in between reads the same page again and
// writes the same rows (the mirror's write is idempotent), so nothing is counted
// or stored twice and nothing is skipped. A second run racing this one loses the
// swap and stops.
//
// QUIET. The import emits no typed event: invoices and charges already in Stripe
// are history, not news. An invoice finalized before the connection is kept with
// `issuer = 'before_connection'`, so it never becomes a Liaison invoice.
//
// PACED. About 10 requests a second; a 429 is retried with a growing wait, and
// one that persists ends the run (the next tick carries on). The run stops on its
// own before its budget is spent.
//
// FAILURES. A 401: the key is marked invalid and the run stops. A 403 on one
// resource: that resource is `failed` with `permission_missing`, the connection
// reads `partial`, and the others carry on. An object of the other mode: the
// connection reads `different_account` and nothing more is written.
//
// THE END. When no resource is left pending or running, the connection moves
// from importing to connected, and the deliveries whose events were held during
// the import are played again through the same dispatch (states.ts).
import { handleStripeEvent, type IngestCtx } from "../dispatch"
import { StripeApiError, stripeFetch } from "../http"
import { newTally, writeMirror } from "../mirror"
import { blockedOverlay, HELD, type Install, moveState, readInstall } from "../states"
import {
  advanceState,
  asPage,
  Budget,
  DEFAULT_BUDGET_MS,
  ensureSyncState,
  PAGE_SIZE,
  RESOURCES,
  readAllSyncState,
  type SyncCtx,
  type SyncOptions,
  type SyncResource,
} from "./common"

type Obj = Record<string, unknown>

export interface BackfillResult {
  outcome: "not_connected" | "blocked" | "done" | "paused" | "stopped"
  written: number
  released: number
  detail?: string
}

/** Held deliveries played again per run. */
const RELEASE_PER_RUN = 50

function msOf(v: unknown): number {
  if (v instanceof Date) return v.getTime()
  return typeof v === "string" ? Date.parse(v) : Number.NaN
}

export async function runBackfill(ctx: SyncCtx, opts: SyncOptions = {}): Promise<BackfillResult> {
  const now = opts.now ?? (() => new Date())
  const budget = new Budget(now, opts.budgetMs ?? DEFAULT_BUDGET_MS)
  const install = await readInstall(ctx.db)
  if (!install) return { outcome: "not_connected", written: 0, released: 0 }
  if (blockedOverlay(install))
    return { outcome: "blocked", written: 0, released: 0, detail: String(install.state) }
  const connectedMs = msOf(install.connected_at)
  let written = 0

  for (const res of RESOURCES) {
    let row = await ensureSyncState(ctx.db, res.resource, now())
    if (row.status === "done" || row.status === "failed") continue
    if (row.status === "pending") {
      if (!(await advanceState(ctx.db, row, { status: "running" }, now()))) {
        return {
          outcome: "stopped",
          written,
          released: 0,
          detail: "another run moved the import on",
        }
      }
      row = { ...row, status: "running" }
    }
    while (true) {
      if (budget.spent) return { outcome: "paused", written, released: 0 }
      const started = now().toISOString()
      let body: unknown
      try {
        body = await stripeFetch(ctx, res.list, {
          params: {
            limit: PAGE_SIZE,
            ...(res.params ?? {}),
            ...(row.cursor ? { starting_after: row.cursor } : {}),
          },
        })
      } catch (err) {
        if (!(err instanceof StripeApiError)) throw err
        if (err.code === "key_invalid") {
          await moveState(ctx, install, [{ kind: "key_refused" }])
          return { outcome: "stopped", written, released: 0, detail: "key_invalid" }
        }
        if (err.code === "permission_missing") {
          await advanceState(
            ctx.db,
            row,
            { status: "failed", last_error_code: "permission_missing" },
            now(),
          )
          await moveState(ctx, install, [{ kind: "permission_refused" }])
          break
        }
        // A 429 (never waited out in the run), a Stripe 5xx: the next tick carries on from the same place.
        return { outcome: "paused", written, released: 0, detail: err.code }
      }
      const page = asPage(body)
      if (
        page.data.some(
          (o) => typeof o.livemode === "boolean" && o.livemode !== (install.livemode === true),
        )
      ) {
        await moveState(ctx, install, [{ kind: "account_unconfirmed" }])
        return { outcome: "stopped", written, released: 0, detail: "different_account" }
      }
      written += await writePage(ctx, res, page.data, started, connectedMs)
      const last = page.data[page.data.length - 1]
      const cursor = typeof last?.id === "string" ? last.id : row.cursor
      const next = {
        cursor,
        done_count: row.done_count + page.data.length,
        status: page.has_more && last ? "running" : "done",
      }
      if (!(await advanceState(ctx.db, row, next, now()))) {
        return {
          outcome: "stopped",
          written,
          released: 0,
          detail: "another run moved the import on",
        }
      }
      row = { ...row, ...next }
      if (row.status === "done") break
    }
  }

  const rows = await readAllSyncState(ctx.db)
  if (rows.some((r) => r.status === "pending" || r.status === "running")) {
    return { outcome: "paused", written, released: 0 }
  }
  await finishImport(ctx, install)
  const released = await releaseHeld(ctx, budget)
  return { outcome: "done", written, released }
}

async function writePage(
  ctx: SyncCtx,
  res: SyncResource,
  objects: Obj[],
  started: string,
  connectedMs: number,
) {
  const tally = newTally()
  let n = 0
  for (const obj of objects) {
    if (typeof obj.id !== "string") continue
    const row = res.row(obj, tally)
    if (res.entity === "stripe_invoices") {
      const finalizedMs = msOf(row.finalized_at)
      if (
        Number.isFinite(finalizedMs) &&
        Number.isFinite(connectedMs) &&
        finalizedMs < connectedMs
      ) {
        row.issuer = "before_connection"
      }
    }
    await writeMirror(ctx.db, res.entity, row, started)
    n++
  }
  if (tally.cards > 0) {
    await ctx.emit({
      entity: "card_number",
      action: "masked",
      entityId: res.resource,
      data: { object: res.resource, fields: tally.fields.join(", "), count: tally.cards },
    })
  }
  return n
}

async function finishImport(ctx: SyncCtx, install: Install): Promise<void> {
  const fresh = (await readInstall(ctx.db)) ?? install
  // Before the first event, the import is simply done: that event moves the connection on.
  if (String(fresh.state ?? "").startsWith("importing"))
    await moveState(ctx, fresh, [{ kind: "import_done" }])
}

/** Play the held deliveries again, oldest first, through the same dispatch. */
export async function releaseHeld(ctx: SyncCtx, budget: Budget): Promise<number> {
  const held = (await ctx.db.findMany("webhook_deliveries", {
    where: { status: HELD },
    orderBy: { received_at: "asc" },
    limit: RELEASE_PER_RUN,
  })) as Array<{ id: string; event_id: string }>
  let released = 0
  for (const d of held) {
    if (budget.spent) break
    let event: unknown
    try {
      event = await stripeFetch(ctx, `/v1/events/${encodeURIComponent(d.event_id)}`, {})
    } catch (err) {
      if (err instanceof StripeApiError && err.status === 404) {
        // Older than Stripe keeps events (30 days): the nightly reconcile has the object.
        await ctx.db.update("webhook_deliveries", d.id, { status: "ignored" })
        continue
      }
      break
    }
    // `failed` is the status the ledger takes up again: the replay applies it once.
    await ctx.db.update("webhook_deliveries", d.id, { status: "failed" })
    await handleStripeEvent(event, ctx as unknown as IngestCtx)
    released++
  }
  return released
}
