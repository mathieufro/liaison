// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The nightly reconcile: the mirror healed from Stripe's current objects, for
// whatever events were lost.
//
// SAME ACCOUNT FIRST. Before anything is written, up to 3 objects the mirror
// already holds are read back by id. When none resolves in the install's mode,
// the key now answers for another account (or the other mode): the connection
// reads `different_account` and the run writes nothing at all.
//
// ABSENT IS NOT DELETED. A list read updates what it returns and nothing else.
// An object missing from a page (a test-clock customer, an object the list
// filters out, a page that moved) keeps its row as it is. Rows the lists did not
// return are read back BY ID: an answer updates the row; a 404 marks a customer
// deleted only because the same account was confirmed in this run. No other
// change of state comes from a 404 here: subscriptions, invoices and charges are
// never deleted by Stripe, only moved to a final status, which a read returns.
//
// WRITES. Through the mirror's one conditional write (mirror.ts), so a row a
// webhook wrote after this run's read is left alone. No typed event, no document.
import { StripeApiError, stripeFetch } from "../http"
import { newTally, writeMirror } from "../mirror"
import { recordMovement } from "../mrr-events"
import { runMrrRebuild } from "../mrr-rebuild"
import { blockedOverlay, type Install, moveState, readInstall } from "../states"
import {
  asPage,
  Budget,
  DEFAULT_BUDGET_MS,
  PAGE_SIZE,
  RESOURCES,
  readAllSyncState,
  type SyncCtx,
  type SyncOptions,
  type SyncResource,
} from "./common"

type Obj = Record<string, unknown>

export interface ReconcileResult {
  outcome:
    | "not_connected"
    | "blocked"
    | "importing"
    | "different_account"
    | "key_invalid"
    | "done"
    | "paused"
  written: number
  deleted: number
}

/** Rows not seen in a list that are read back by id, per resource and run. */
const BY_ID_PER_RESOURCE = 25

type Canary = "same" | "other" | "key_invalid" | "unknown" | "nothing_known"

/** The same account, confirmed: at least one object the mirror holds resolves in the install's mode. */
async function confirmAccount(ctx: SyncCtx, install: Install): Promise<Canary> {
  const live = install.livemode === true
  const known: string[] = []
  for (const res of RESOURCES.slice(0, 3)) {
    if (known.length >= 3) break
    const rows = (await ctx.db.findMany(res.entity, { limit: 3 - known.length })) as Obj[]
    for (const r of rows)
      if (typeof r.stripe_id === "string")
        known.push(`${res.byId}${encodeURIComponent(r.stripe_id)}`)
  }
  if (known.length === 0) return "nothing_known"
  let notFound = 0
  for (const path of known) {
    try {
      const obj = await stripeFetch<Obj>(ctx, path, {})
      if (obj?.livemode === live) return "same"
      notFound++
    } catch (err) {
      if (!(err instanceof StripeApiError)) throw err
      if (err.code === "key_invalid") return "key_invalid"
      if (err.status === 404) notFound++
    }
  }
  return notFound === known.length ? "other" : "unknown"
}

/** A subscription healed here leaves one movement, dated now, unless the log already carries the change. */
function healed(ctx: SyncCtx, res: SyncResource, row: Obj) {
  return res.entity === "stripe_subscriptions"
    ? recordMovement(ctx.db, row, { source: "reconcile", at: new Date().toISOString() })
    : undefined
}

export async function runReconcile(ctx: SyncCtx, opts: SyncOptions = {}): Promise<ReconcileResult> {
  const now = opts.now ?? (() => new Date())
  const budget = new Budget(now, opts.budgetMs ?? DEFAULT_BUDGET_MS)
  const result: ReconcileResult = { outcome: "done", written: 0, deleted: 0 }
  const install = await readInstall(ctx.db)
  if (!install) return { ...result, outcome: "not_connected" }
  if (blockedOverlay(install)) return { ...result, outcome: "blocked" }
  if (
    (await readAllSyncState(ctx.db)).some((r) => r.status === "pending" || r.status === "running")
  ) {
    return { ...result, outcome: "importing" }
  }

  const canary = await confirmAccount(ctx, install)
  if (canary === "key_invalid") {
    await moveState(ctx, install, [{ kind: "key_refused" }])
    return { ...result, outcome: "key_invalid" }
  }
  if (canary === "other") {
    await moveState(ctx, install, [{ kind: "account_unconfirmed" }])
    return { ...result, outcome: "different_account" }
  }
  // "unknown" (Stripe did not answer): read and update, but delete nothing this run.
  const mayDelete = canary === "same"

  // The movement log first: what the events of the last 30 days say, before a heal writes its own.
  await runMrrRebuild(ctx, install, { now, budget })

  for (const res of RESOURCES) {
    const listed = await reconcileList(ctx, install, res, budget, result)
    if (result.outcome !== "done") return result
    if (listed === null) continue
    await readBackAbsent(ctx, res, listed, mayDelete, budget, now, result)
    if (result.outcome !== "done") return result
  }
  return result
}

/** List the resource in full and write what it returns. The ids seen, or null when the list was cut short. */
async function reconcileList(
  ctx: SyncCtx,
  install: Install,
  res: SyncResource,
  budget: Budget,
  result: ReconcileResult,
): Promise<Set<string> | null> {
  const seen = new Set<string>()
  let cursor: string | null = null
  while (true) {
    if (budget.spent) {
      result.outcome = "paused"
      return null
    }
    const started = new Date().toISOString()
    let body: unknown
    try {
      body = await stripeFetch(ctx, res.list, {
        params: {
          limit: PAGE_SIZE,
          ...(res.params ?? {}),
          ...(cursor ? { starting_after: cursor } : {}),
        },
      })
    } catch (err) {
      if (!(err instanceof StripeApiError)) throw err
      if (err.code === "key_invalid") {
        await moveState(ctx, install, [{ kind: "key_refused" }])
        result.outcome = "key_invalid"
        return null
      }
      if (err.code === "permission_missing") {
        await moveState(ctx, install, [{ kind: "permission_refused" }])
        return null
      }
      result.outcome = "paused"
      return null
    }
    const page = asPage(body)
    if (
      page.data.some(
        (o) => typeof o.livemode === "boolean" && o.livemode !== (install.livemode === true),
      )
    ) {
      await moveState(ctx, install, [{ kind: "account_unconfirmed" }])
      result.outcome = "different_account"
      return null
    }
    const tally = newTally()
    for (const obj of page.data) {
      if (typeof obj.id !== "string") continue
      seen.add(obj.id)
      const row = res.row(obj, tally)
      const outcome = await writeMirror(ctx.db, res.entity, row, started, healed(ctx, res, row))
      if (outcome !== "stale") result.written++
    }
    const last = page.data[page.data.length - 1]
    if (!page.has_more || typeof last?.id !== "string") return seen
    cursor = last.id
  }
}

/** Rows the list did not return, read back by id. Only a 404 after a confirmed account deletes, and only a customer. */
async function readBackAbsent(
  ctx: SyncCtx,
  res: SyncResource,
  listed: Set<string>,
  mayDelete: boolean,
  budget: Budget,
  now: () => Date,
  result: ReconcileResult,
): Promise<void> {
  const where = res.entity === "stripe_customers" ? { deleted_at: null } : undefined
  const rows = (await ctx.db.findMany(res.entity, {
    ...(where ? { where } : {}),
    limit: 500,
  })) as Obj[]
  const absent = rows
    .map((r) => r.stripe_id)
    .filter((id): id is string => typeof id === "string" && !listed.has(id))
    .slice(0, BY_ID_PER_RESOURCE)
  const tally = newTally()
  for (const id of absent) {
    if (budget.spent) {
      result.outcome = "paused"
      return
    }
    const started = now().toISOString()
    try {
      const obj = await stripeFetch<Obj>(
        ctx,
        `${res.byId}${encodeURIComponent(id)}`,
        res.entity === "stripe_subscriptions"
          ? { params: { expand: ["discounts", "default_payment_method"] } }
          : {},
      )
      if (obj?.deleted === true) {
        if (res.entity === "stripe_customers" && mayDelete)
          await markDeleted(ctx, id, started, result)
      } else if (obj) {
        const row = res.row(obj, tally)
        if (
          (await writeMirror(ctx.db, res.entity, row, started, healed(ctx, res, row))) !== "stale"
        )
          result.written++
      }
    } catch (err) {
      if (!(err instanceof StripeApiError)) throw err
      if (err.status === 404 && res.entity === "stripe_customers" && mayDelete) {
        await markDeleted(ctx, id, started, result)
      }
      // Anything else: the row stays as it is.
    }
  }
}

async function markDeleted(
  ctx: SyncCtx,
  id: string,
  at: string,
  result: ReconcileResult,
): Promise<void> {
  const { count } = await ctx.db.updateMany("stripe_customers", {
    where: { stripe_id: id, deleted_at: null },
    data: { deleted_at: at },
  })
  result.deleted += count
}
