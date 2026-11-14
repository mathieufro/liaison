// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The movement log rebuilt from Stripe's events of the last 30 days, inside the
// nightly reconcile and before its heal pass. A current-state mirror holds no
// history, so a movement lost between a mirror write and its append (a crash)
// can only be found again in the events.
//
// WHAT IT WRITES. Per subscription, the events newer than the log's last
// movement are played in order; each one whose subscription amount differs from
// the one before it is appended (id = the event's id, source `reconcile`, dated
// by the event). Events at or before the log's last movement are covered by it
// and skipped, so a movement the webhook or a heal already wrote is never
// written twice, and the heal that follows finds the log already at today's
// amount and adds nothing.
//
// WHAT IT CANNOT. Stripe keeps events 30 days. When the last complete rebuild is
// older than that (the app was down for longer), changes in between are not
// recoverable: the nightly heal still brings the amounts right, and the log
// records `mrr_gap` (the date before which movements are incomplete), which the
// query reports as "Movements incomplete before <date>".
import { StripeApiError, stripeFetch } from "./http"
import { newTally, subscriptionRow } from "./mirror"
import { discountsOfRow } from "./mrr"
import { appendMovement, chainAfter } from "./mrr-events"
import type { Install } from "./states"
import { asPage, type Budget, PAGE_SIZE, type SyncCtx } from "./sync/common"

type Obj = Record<string, unknown>

export const REBUILD_DAYS = 30
const DAY_MS = 86_400_000
export const COVERAGE = "mrr_rebuild"
export const GAP = "mrr_gap"

const TYPES = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]

export interface RebuildResult {
  appended: number
  complete: boolean
  gapBefore: string | null
}

async function putMarker(ctx: SyncCtx, resource: string, cursor: string, now: Date): Promise<void> {
  const rows = (await ctx.db.findMany("sync_state", { where: { resource }, limit: 1 })) as Array<{
    id: string
  }>
  const data = { cursor, status: "done", updated: now.toISOString() }
  if (rows[0]) await ctx.db.update("sync_state", rows[0].id, data)
  else await ctx.db.insert("sync_state", { resource, done_count: 0, catchup_due: false, ...data })
}

async function marker(ctx: SyncCtx, resource: string): Promise<string | null> {
  const rows = (await ctx.db.findMany("sync_state", { where: { resource }, limit: 1 })) as Obj[]
  return typeof rows[0]?.cursor === "string" ? rows[0].cursor : null
}

export async function runMrrRebuild(
  ctx: SyncCtx,
  install: Install,
  opts: { now: () => Date; budget: Budget },
): Promise<RebuildResult> {
  const now = opts.now()
  const windowStart = new Date(now.getTime() - REBUILD_DAYS * DAY_MS)
  const connected =
    typeof install.connected_at === "string" ? install.connected_at : now.toISOString()
  const coverage = new Date((await marker(ctx, COVERAGE)) ?? connected)
  const result: RebuildResult = { appended: 0, complete: false, gapBefore: null }
  if (coverage.getTime() < windowStart.getTime()) {
    result.gapBefore = windowStart.toISOString()
    const known = await marker(ctx, GAP)
    if (!known || known < result.gapBefore) await putMarker(ctx, GAP, result.gapBefore, now)
  }
  const from = Math.max(coverage.getTime(), windowStart.getTime())

  const events: Obj[] = []
  let cursor: string | null = null
  while (true) {
    if (opts.budget.spent) return result
    let body: unknown
    try {
      body = await stripeFetch(ctx, "/v1/events", {
        params: {
          limit: PAGE_SIZE,
          types: TYPES,
          created: { gte: Math.floor(from / 1000) },
          ...(cursor ? { starting_after: cursor } : {}),
        },
      })
    } catch (err) {
      if (err instanceof StripeApiError) return result
      throw err
    }
    const page = asPage(body)
    events.push(...page.data)
    const last = page.data[page.data.length - 1]
    if (!page.has_more || typeof last?.id !== "string") break
    cursor = last.id
  }

  events.sort(
    (a, b) => Number(a.created) - Number(b.created) || String(a.id).localeCompare(String(b.id)),
  )
  const state = new Map<
    string,
    { prev: number | null; lastAt: number; kept: ReturnType<typeof discountsOfRow> } | null
  >()
  for (const e of events) {
    const obj = ((e.data as Obj | undefined)?.object ?? null) as Obj | null
    const subId = typeof obj?.id === "string" ? obj.id : null
    if (!obj || !subId || typeof e.id !== "string" || typeof e.created !== "number") continue
    let st = state.get(subId)
    if (st === undefined) {
      const stored = (
        (await ctx.db.findMany("stripe_subscriptions", {
          where: { stripe_id: subId },
          limit: 1,
        })) as Obj[]
      )[0]
      const chain = await chainAfter(ctx.db, subId)
      st = {
        prev: chain ? chain.after : null,
        lastAt: chain ? Date.parse(chain.at) : Number.NEGATIVE_INFINITY,
        kept: stored ? discountsOfRow(stored) : [],
      }
      state.set(subId, st)
    }
    if (!st) continue
    const at = e.created * 1000
    if (at <= st.lastAt) continue
    const row = subscriptionRow(obj, newTally(), new Date(at), st.kept)
    const value = Number(row.mrr_minor) || 0
    if (st.prev === null) {
      // No history for it: a creation starts from nothing; anything else starts here, unmeasured.
      st.prev = e.type === "customer.subscription.created" ? 0 : value
      if (st.prev === value) continue
    }
    if (value !== st.prev) {
      const added = await appendMovement(ctx.db, {
        eventId: e.id,
        subscriptionId: subId,
        customerId: String(row.customer_id ?? ""),
        currency: String(row.currency ?? ""),
        before: st.prev,
        after: value,
        at: new Date(at).toISOString(),
        source: "reconcile",
      })
      if (added) result.appended++
      st.prev = value
    }
  }
  await putMarker(ctx, COVERAGE, now.toISOString(), now)
  result.complete = true
  return result
}
