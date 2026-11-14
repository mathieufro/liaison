// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `mrr_query`: monthly recurring revenue from the mirror, per currency, with
// the plan split and the movements since the first of the month in the issuer's
// time zone. It reads the mirror only. While the first import runs, or a
// resource the key may not read is missing, it answers `partial` and no number.
//
// Identity: the amount at the start of the month is the amount now less the
// month's movements; each currency is its own line and is never converted.
import { MRR_RULES, mrrRuleLines } from "../mrr"
import { syncProgress } from "../states"
import { iso, type ReadCtx, SCAN_CAP, syncedAt } from "./read-common"

type Obj = Record<string, unknown>

export interface MrrCtx extends ReadCtx {
  time: {
    civil(p: {
      timezone: string
      at?: string | number
    }): Promise<{ date: string; year: number; month: number; day: number }>
  }
  /**
   * Test seam: the clock. Unset, the host's clock answers through
   * `ctx.time.civil`, so the month is the one the product reads, never the
   * sandbox's own wall clock.
   */
  now?: () => Date
}

const PAGE = 500
const PLANS_SHOWN = 10

/**
 * The instant a month starts in a zone: the first minute whose local date is the first of it.
 * `now` unset: the month of the host's current instant.
 */
export async function monthStartInstant(
  ctx: Pick<MrrCtx, "time">,
  zone: string,
  now?: Date,
): Promise<{ at: Date; date: string }> {
  const local = await ctx.time.civil(
    now ? { timezone: zone, at: now.getTime() } : { timezone: zone },
  )
  const date = `${String(local.year).padStart(4, "0")}-${String(local.month).padStart(2, "0")}-01`
  const base = Date.UTC(local.year, local.month - 1, 1)
  // Every zone's offset is within +/- 15 hours, so the answer lies in this window, a minute at a time.
  let lo = Math.floor((base - 15 * 3600_000) / 60_000)
  let hi = Math.floor((base + 15 * 3600_000) / 60_000)
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const c = await ctx.time.civil({ timezone: zone, at: mid * 60_000 })
    const d = `${String(c.year).padStart(4, "0")}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`
    if (d >= date) hi = mid
    else lo = mid + 1
  }
  return { at: new Date(lo * 60_000), date }
}

async function readAll(
  ctx: ReadCtx,
  entity: string,
  where: Obj,
  orderBy: Record<string, "asc" | "desc">,
  stopAt?: (r: Obj) => boolean,
) {
  const out: Obj[] = []
  const capped = false
  for (let offset = 0; ; offset += PAGE) {
    const page = (await ctx.db.findMany(entity, { where, orderBy, limit: PAGE, offset })) as Obj[]
    for (const r of page) {
      if (stopAt?.(r)) return { rows: out, capped }
      out.push(r)
    }
    if (page.length < PAGE) return { rows: out, capped }
    if (out.length >= SCAN_CAP) return { rows: out, capped: true }
  }
}

const n = (v: unknown) => Number(v) || 0

export async function mrrQuery(params: Obj | undefined, ctx: MrrCtx) {
  const p = params ?? {}
  const only = typeof p.currency === "string" && p.currency ? p.currency.toLowerCase() : null
  const sync = await syncProgress(ctx.db)
  const rules = mrrRuleLines("en")
  if (sync.partial) {
    return {
      partial: true,
      lines: [],
      asOf: null,
      rules,
      summary: sync.importing
        ? "The Stripe import is still running, so no MRR figure is given and nothing was changed. Next step: ask again once every resource is read."
        : `The key may not read ${sync.missing.join(", ")}, so no MRR figure is given. Next step: give the key Read on them and run the key check.`,
    }
  }

  const now = ctx.now?.()
  // "UTC" is the unset value of a zone: the host answers with the organization's own zone.
  const { at: monthStart, date: monthStartDate } = await monthStartInstant(ctx, "UTC", now)
  const subs = await readAll(
    ctx,
    "stripe_subscriptions",
    { status: { in: [...MRR_RULES.countedStatuses] } },
    { id: "asc" },
  )
  const events = await readAll(
    ctx,
    "stripe_mrr_events",
    {},
    { at: "desc", id: "asc" },
    (r) => (Date.parse(iso(r.at) ?? "") || 0) < monthStart.getTime(),
  )

  type MoveKind = "new" | "upgrade" | "downgrade" | "cancelled"
  const isMoveKind = (k: string): k is MoveKind =>
    k === "new" || k === "upgrade" || k === "downgrade" || k === "cancelled"
  type Line = {
    currency: string
    mrrMinor: number
    pastDueMinor: number
    activeCount: number
    byPlan: Map<string, { mrrMinor: number; count: number }>
    mv: Record<MoveKind, number>
  }
  const lines = new Map<string, Line>()
  const line = (currency: string): Line => {
    let l = lines.get(currency)
    if (!l) {
      l = {
        currency,
        mrrMinor: 0,
        pastDueMinor: 0,
        activeCount: 0,
        byPlan: new Map(),
        mv: { new: 0, upgrade: 0, downgrade: 0, cancelled: 0 },
      }
      lines.set(currency, l)
    }
    return l
  }
  for (const s of subs.rows) {
    const mrr = n(s.mrr_minor)
    if (mrr <= 0) continue
    const l = line(String(s.currency ?? "").toLowerCase())
    l.mrrMinor += mrr
    l.activeCount++
    if (s.status === "past_due") l.pastDueMinor += mrr
    const plan = String(s.plan_name ?? "")
    const e = l.byPlan.get(plan) ?? { mrrMinor: 0, count: 0 }
    e.mrrMinor += mrr
    e.count++
    l.byPlan.set(plan, e)
  }
  for (const ev of events.rows) {
    const l = line(String(ev.currency ?? "").toLowerCase())
    const kind = String(ev.kind)
    if (isMoveKind(kind)) l.mv[kind] += n(ev.delta_minor)
  }

  const shown = [...lines.values()]
    .filter((l) => !only || l.currency === only)
    .sort((a, b) => b.mrrMinor - a.mrrMinor || a.currency.localeCompare(b.currency))
    .map((l) => {
      const net = l.mv.new + l.mv.upgrade + l.mv.downgrade + l.mv.cancelled
      const plans = [...l.byPlan.entries()]
        .map(([plan, v]) => ({ plan, mrrMinor: v.mrrMinor, count: v.count }))
        .sort((a, b) => b.mrrMinor - a.mrrMinor || a.plan.localeCompare(b.plan))
      return {
        currency: l.currency,
        mrrMinor: l.mrrMinor,
        pastDueMinor: l.pastDueMinor,
        activeCount: l.activeCount,
        byPlan: p.breakdown === true ? plans : plans.slice(0, PLANS_SHOWN),
        movements: {
          newMinor: l.mv.new,
          upgradeMinor: l.mv.upgrade,
          downgradeMinor: l.mv.downgrade,
          cancelledMinor: l.mv.cancelled,
          netMinor: net,
          startMinor: l.mrrMinor - net,
        },
        monthStart: monthStartDate,
      }
    })

  const gapRows = (await ctx.db.findMany("sync_state", {
    where: { resource: "mrr_gap" },
    limit: 1,
  })) as Obj[]
  const gap = typeof gapRows[0]?.cursor === "string" ? gapRows[0].cursor.slice(0, 10) : null
  // A gap found this month: the changes it hides were written by the heal, dated the day it ran.
  const foundAt = Date.parse(iso(gapRows[0]?.updated) ?? "")
  const incomplete = gap && foundAt >= monthStart.getTime() ? gap : null
  const capped = subs.capped || events.capped
  return {
    partial: capped,
    lines: shown,
    asOf: syncedAt(subs.rows),
    rules,
    ...(incomplete
      ? {
          movementsIncompleteBefore: incomplete,
          note: `Movements incomplete before ${incomplete}.`,
        }
      : {}),
    summary:
      shown.length === 0
        ? "No counted Stripe subscription in the mirror, so there is no MRR line."
        : `MRR for ${shown.map((l) => l.currency.toUpperCase()).join(", ")} from the Stripe mirror, month start ${monthStartDate}${capped ? "; the mirror is larger than one read, so the figure is partial" : ""}.`,
  }
}
