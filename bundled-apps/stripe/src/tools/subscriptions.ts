// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `subscriptions_search`: the mirror's subscriptions, masked. `id` returns that
// one row. Plan names come from Stripe, so the tool declares `taintSource`.
import { refuseTool, type ToolRefusal } from "@liaison/app-sdk/errors"
import { StripeApiError, stripeFetch } from "../http"
import { moneyActionHold } from "../states"
import { limitOf, offsetOf, pageOf, type ReadCtx, readPage, subscriptionItem } from "./read-common"
import { type MoneyCtx, money, readRefusal } from "./refunds"

type Obj = Record<string, unknown>

export async function subscriptionsSearch(params: Obj | undefined, ctx: ReadCtx) {
  const p = params ?? {}
  const limit = limitOf(p.limit)
  const offset = offsetOf(p.cursor)
  const where: Obj = {}
  if (typeof p.id === "string" && p.id) where.stripe_id = p.id
  if (typeof p.customerId === "string" && p.customerId) where.customer_id = p.customerId
  if (typeof p.status === "string" && p.status) where.status = p.status
  const query = typeof p.query === "string" ? p.query.trim().toLowerCase() : ""
  if (query && !where.stripe_id) {
    // A plan name: kept from at most 1 000 rows of the other filters.
    const rows = (
      (await ctx.db.findMany("stripe_subscriptions", { where, limit: 1000 })) as Obj[]
    ).filter((r) =>
      String(r.plan_name ?? "")
        .toLowerCase()
        .includes(query),
    )
    const page = rows.slice(offset, offset + limit)
    return pageOf(
      page.map(subscriptionItem),
      page,
      offset,
      limit,
      "subscriptions",
      rows.length > offset + limit,
    )
  }
  const { rows, more } = await readPage(ctx, "stripe_subscriptions", where, offset, limit, {
    current_period_end: "desc",
    id: "asc",
  })
  return pageOf(rows.map(subscriptionItem), rows, offset, limit, "subscriptions", more)
}

// ---- `subscription_cancel`: a cancellation decided by a person ----
//
// The preflight reads the subscription from Stripe and probes whether the key
// may write subscriptions (a POST on an id Stripe can never hold: 404 when it
// may, 403 when it may not, nothing changes either way). Without the
// permission the call is refused, nothing parks, and the refusal's one card
// action runs the key check, never this tool: a person's click on a gated tool
// would cancel at once. The default cancels at the period's end.

/** A subscription id Stripe can never hold: the write probe on it changes nothing. */
export const SUBSCRIPTION_PROBE = "sub_liaison_probe"
const SUB_ID = /^sub_[A-Za-z0-9_]+$/
const ENDED = new Set(["canceled", "incomplete_expired"])

interface LiveSub {
  id: string
  status: string
  cancel_at_period_end?: boolean
  cancel_at?: number | null
  items?: { data?: Array<{ current_period_end?: number }> }
}

const isRefusal = (v: unknown): v is ToolRefusal => (v as ToolRefusal | null)?.status === "error"
const periodEnd = (s: LiveSub) => s.items?.data?.[0]?.current_period_end ?? null
const day = (unix: number | null | undefined) =>
  unix ? new Date(unix * 1000).toISOString().slice(0, 10) : null

async function readSub(ctx: MoneyCtx, id: string): Promise<LiveSub | ToolRefusal> {
  try {
    return await stripeFetch<LiveSub>(ctx, `/v1/subscriptions/${encodeURIComponent(id)}`)
  } catch (err) {
    return readRefusal(err, "subscription", id)
  }
}

export const CANCEL_PERMISSION_TEXT =
  "This key cannot cancel subscriptions, so nothing was staged and nothing changed in Stripe. Next step: an admin gives the restricted key Write on Subscriptions in Stripe, then runs the Stripe key check; ask again after that."

/** Whether the key may write subscriptions, by a probe that changes nothing. */
async function canWriteSubscriptions(ctx: MoneyCtx): Promise<boolean | ToolRefusal> {
  try {
    await stripeFetch(ctx, `/v1/subscriptions/${SUBSCRIPTION_PROBE}`, {
      method: "POST",
      params: {},
    })
    return true
  } catch (err) {
    if (err instanceof StripeApiError && (err.status === 404 || err.status === 400)) return true
    if (err instanceof StripeApiError && err.status === 403) {
      return refuseTool("permission_missing", CANCEL_PERMISSION_TEXT, {
        body: {
          blocked: true,
          // The card action re-runs the key check; the cancel itself is asked again through the agent.
          actions: [
            // biome-ignore lint/suspicious/noThenProperty: the card action's follow-up field, named by the host.
            { label: "I added it, check again", tool: "connection_check", then: "message_agent" },
          ],
        },
      })
    }
    return readRefusal(err, "subscription", SUBSCRIPTION_PROBE)
  }
}

async function cancelChecks(p: Obj, ctx: MoneyCtx): Promise<ToolRefusal | LiveSub> {
  const hold = await moneyActionHold(ctx.db)
  if (hold) return hold
  const id = typeof p.subscriptionId === "string" ? p.subscriptionId.trim() : ""
  if (!SUB_ID.test(id)) {
    return refuseTool(
      "subscription_ref_missing",
      "No Stripe subscription (sub_...) was named, so nothing was staged. Next step: find it with subscriptions_search.",
    )
  }
  const sub = await readSub(ctx, id)
  if (isRefusal(sub)) return sub
  if (ENDED.has(sub.status)) {
    return refuseTool(
      "already_canceled",
      `Subscription ${id} is already ${sub.status} in Stripe, so nothing was staged.`,
    )
  }
  if (p.atPeriodEnd !== false && sub.cancel_at_period_end) {
    return refuseTool(
      "already_canceling",
      `Subscription ${id} already ends at its period's end (${day(sub.cancel_at ?? periodEnd(sub))}), so nothing was staged.`,
    )
  }
  return sub
}

export async function subscriptionCancelPreflight(params: Obj | undefined, ctx: MoneyCtx) {
  const p = params ?? {}
  const sub = await cancelChecks(p, ctx)
  if (isRefusal(sub)) return sub
  const writable = await canWriteSubscriptions(ctx)
  if (isRefusal(writable)) return writable
  return { ok: true, noAutoApprove: true, pinnedParams: { subscriptionId: sub.id } }
}

export async function subscriptionCancel(params: Obj | undefined, ctx: MoneyCtx) {
  const p = params ?? {}
  const approval = ctx.approval
  if (!approval) {
    return refuseTool(
      "approval_required",
      "A cancellation runs only after a person approves it, so nothing changed in Stripe. Next step: call subscription_cancel through its approval.",
    )
  }
  const noEffect = async (r: ToolRefusal) => {
    await ctx.approval_recordFailedNoEffect?.(approval.toolName, JSON.stringify(r.error))
    return r
  }
  const sub = await cancelChecks(p, ctx)
  if (isRefusal(sub)) return noEffect(sub)
  const atPeriodEnd = p.atPeriodEnd !== false
  await ctx.approval_recordStarted?.(approval.toolName)
  let after: LiveSub
  try {
    after = await stripeFetch<LiveSub>(
      ctx,
      `/v1/subscriptions/${encodeURIComponent(sub.id)}`,
      atPeriodEnd
        ? {
            method: "POST",
            params: { cancel_at_period_end: true },
            idempotencyKey: approval.approvalRequestId,
          }
        : { method: "DELETE", idempotencyKey: approval.approvalRequestId },
    )
  } catch (err) {
    if (err instanceof StripeApiError && err.status < 500) {
      return noEffect(
        refuseTool(
          err.code === "permission_missing" ? "permission_missing" : "stripe_refused",
          err.code === "permission_missing"
            ? CANCEL_PERMISSION_TEXT
            : `Stripe refused to cancel subscription ${sub.id} (${err.message}), so nothing changed.`,
        ),
      )
    }
    const r = refuseTool(
      "cancel_outcome_unknown",
      `Stripe's answer to cancelling subscription ${sub.id} was lost, so it is not known whether it changed. Next step: read it with subscriptions_search after the next sync, then approve again only if it is still active.`,
      { retryable: true },
    )
    await ctx.approval_recordAmbiguous?.(approval.toolName, JSON.stringify(r.error))
    return r
  }
  await ctx.approval_recordSucceeded?.(
    approval.toolName,
    JSON.stringify({ subscriptionId: sub.id }),
  )
  const cancelAt = atPeriodEnd
    ? day(after.cancel_at ?? periodEnd(after))
    : new Date().toISOString().slice(0, 10)
  return {
    subscriptionId: sub.id,
    status: after.status,
    cancelAt,
    summary: atPeriodEnd
      ? `Subscription ${sub.id} stays active until ${cancelAt}, then ends; no invoice is made after that.`
      : `Subscription ${sub.id} is cancelled now in Stripe; no further invoice is made.`,
  }
}

/** What a cancellation changes, for its approval card: MRR, invoices, and open deals of the company. */
export async function subscriptionCancelEffect(params: Obj | undefined, ctx: MoneyCtx) {
  const p = params ?? {}
  const id = typeof p.subscriptionId === "string" ? p.subscriptionId : ""
  const row = (
    (await ctx.db.findMany("stripe_subscriptions", { where: { stripe_id: id }, limit: 1 })) as Obj[]
  )[0]
  if (!row) return { subscriptionId: id, found: false }
  const currency = String(row.currency ?? "eur")
  const mrr = Number(row.mrr_minor) || 0
  const open = (await ctx.db.findMany("stripe_invoices", {
    where: { subscription_id: id, status: "open" },
    limit: 5,
  })) as Obj[]
  const atPeriodEnd = p.atPeriodEnd !== false
  const end = row.current_period_end ? String(row.current_period_end).slice(0, 10) : null
  const invoiceEffect = [
    atPeriodEnd && end ? `No invoice after ${end}.` : "No further invoice.",
    open.length > 0
      ? `Open invoice ${open.map((i) => String(i.number ?? i.stripe_id)).join(", ")} stays open.`
      : null,
  ]
    .filter(Boolean)
    .join(" ")
  const customer = (
    (await ctx.db.findMany("stripe_customers", {
      where: { stripe_id: String(row.customer_id) },
      limit: 1,
    })) as Obj[]
  )[0]
  const companyId = typeof customer?.company_id === "string" ? customer.company_id : null
  let dealNote: string | null = null
  if (companyId && ctx.executeTool) {
    try {
      const out = await ctx.executeTool("projects:deals_search", {
        companyId,
        outcome: "open",
        limit: 5,
      })
      const deals =
        out.status === "completed" ? ((out.result as { items?: Obj[] } | null)?.items ?? []) : []
      if (deals.length > 0) {
        dealNote = `Open deal${deals.length > 1 ? "s" : ""} with this company: ${deals.map((d) => String(d.title ?? d.name ?? d.id)).join(", ")}.`
      }
    } catch {
      dealNote = null
    }
  }
  return {
    subscriptionId: id,
    found: true,
    plan: String(row.plan_name ?? ""),
    mrrEffect:
      mrr > 0
        ? `MRR falls by ${money(mrr, currency)}${atPeriodEnd && end ? ` from ${end}` : ""}.`
        : "No MRR change.",
    invoiceEffect,
    dealNote,
  }
}
