// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The stand-in's answers: the processor's API, for one demo org, from that
// org's own mirror rows and its outside state.
//
// READS. An object by id is the outside object when one exists, else the
// mirror row turned back into the object (objects.ts), else the processor's own
// 404. A list is every mirror row merged with the outside objects of that kind
// (outside wins), filtered by the parameters the payments app sends, newest
// first, paged by `starting_after` and `limit` as the processor pages. The
// account is the one the install row names. Events are the outside events the
// world or the QA harness recorded: every outside change is delivered when it
// is made, so nothing waits upstream and a probe finds nothing missed.
//
// WRITES, modelled: a refund on a charge, and a subscription set to end (or
// not) at its period's end. Each writes the outside state first, answers what
// the processor would, and then delivers the matching event to the app's own
// webhook handler, which reads the objects back by id and updates the mirror
// exactly as it would for the real account. An idempotency key answers its
// first result again.
//
// ANYTHING ELSE is refused by name (`refuse`), never answered empty: an empty
// list would tell a visitor something false about their account.

import type { MirrorSource } from "./mirror-source"
import { ID, invoiceLines, STANDIN_RESOURCES, type StandInResource } from "./objects"

type Obj = Record<string, unknown>

/** The outside state, as the answers use it (overlay.ts in production, a map in tests). */
export interface OutsideStore {
  get(id: string): Promise<Obj | null>
  ofKind(kind: string): Promise<Obj[]>
  put(objects: Obj[]): Promise<void>
  idempotent(key: string): Promise<string | null>
  remember(key: string, id: string): Promise<void>
}

export interface StandInDeps {
  mirror: MirrorSource
  outside: OutsideStore
  /** Deliver one event to the app's handler, after this answer is returned. */
  deliver(type: string, object: Obj): void
  /** The refusal of an unmodelled request: thrown, never returned. */
  refuse(what: string): Error
  now(): Date
  newId(prefix: string): string
}

export interface StandInRequest {
  method: string
  url: URL
  body: string | undefined
  idempotencyKey: string | null
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 100

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function apiError(status: number, code: string, message: string, param?: string): Response {
  return json(
    { error: { type: "invalid_request_error", code, message, ...(param ? { param } : {}) } },
    status,
  )
}

const missing = (kind: string, id: string) =>
  apiError(404, "resource_missing", `No such ${kind}: '${id}'`, "id")

const RESOURCE_BY_SEGMENT = new Map(STANDIN_RESOURCES.map((r) => [r.segment, r]))

/** The livemode of the install (false for every seeded stand-in). */
async function livemodeOf(deps: StandInDeps): Promise<boolean> {
  const install = await deps.mirror.install()
  return install?.livemode === true
}

async function objectById(
  res: StandInResource,
  id: string,
  deps: StandInDeps,
  livemode: boolean,
): Promise<Obj | null> {
  const outside = await deps.outside.get(id)
  const row = outside && outside.object === res.kind ? null : await deps.mirror.row(res.table, id)
  const obj =
    outside && outside.object === res.kind ? outside : row ? res.build(row, livemode) : null
  // An invoice read by id carries its first page of lines, as the processor embeds them.
  if (obj && res.kind === "invoice" && !obj.lines) {
    return {
      ...obj,
      lines: { object: "list", data: invoiceLines(obj, await planOf(obj, deps)), has_more: false },
    }
  }
  return obj
}

/** The plan name of an invoice's subscription (its line's description), or null. */
async function planOf(invoice: Obj, deps: StandInDeps): Promise<string | null> {
  const subId = idOf(
    ((invoice.parent as Obj | null)?.subscription_details as Obj | undefined)?.subscription,
  )
  if (!subId) return null
  const sub = await deps.mirror.row("subscriptions", subId)
  return typeof sub?.plan_name === "string" && sub.plan_name ? sub.plan_name : null
}

async function allOf(res: StandInResource, deps: StandInDeps, livemode: boolean): Promise<Obj[]> {
  const byId = new Map<string, Obj>()
  for (const row of await deps.mirror.rows(res.table))
    byId.set(String(row[ID]), res.build(row, livemode))
  for (const obj of await deps.outside.ofKind(res.kind)) byId.set(String(obj.id), obj)
  return [...byId.values()]
}

function newestFirst(a: Obj, b: Obj): number {
  return Number(b.created ?? 0) - Number(a.created ?? 0) || String(b.id).localeCompare(String(a.id))
}

/** One page of `items` (already filtered), as the processor pages a list. */
function page(items: Obj[], params: URLSearchParams, url: string): Response {
  const sorted = [...items].sort(newestFirst)
  const raw = Number(params.get("limit") ?? DEFAULT_LIMIT)
  const limit =
    Number.isFinite(raw) && raw >= 1 ? Math.min(MAX_LIMIT, Math.floor(raw)) : DEFAULT_LIMIT
  const after = params.get("starting_after")
  let start = 0
  if (after) {
    const at = sorted.findIndex((o) => o.id === after)
    if (at < 0)
      return apiError(400, "resource_missing", `No such object: '${after}'`, "starting_after")
    start = at + 1
  }
  const data = sorted.slice(start, start + limit)
  return json({ object: "list", url, data, has_more: start + limit < sorted.length })
}

const idOf = (v: unknown): string | null =>
  typeof v === "string"
    ? v
    : v && typeof v === "object" && typeof (v as Obj).id === "string"
      ? String((v as Obj).id)
      : null

/** The created-at window of a list (`created[gt]`, `created[gte]`, `created[lt]`, `created[lte]`). */
function createdFilter(params: URLSearchParams): (o: Obj) => boolean {
  const bound = (k: string) => {
    const v = params.get(`created[${k}]`)
    return v === null ? null : Number(v)
  }
  const [gt, gte, lt, lte] = [bound("gt"), bound("gte"), bound("lt"), bound("lte")]
  return (o) => {
    const c = Number(o.created ?? 0)
    return (
      (gt === null || c > gt) &&
      (gte === null || c >= gte) &&
      (lt === null || c < lt) &&
      (lte === null || c <= lte)
    )
  }
}

/** The list parameters the payments app sends, per resource. Anything else is refused by name. */
const LIST_FILTERS: Record<string, Record<string, (o: Obj, v: string) => boolean>> = {
  customers: { email: (o, v) => o.email === v },
  subscriptions: {
    customer: (o, v) => idOf(o.customer) === v,
    status: (o, v) => v === "all" || o.status === v,
  },
  invoices: {
    customer: (o, v) => idOf(o.customer) === v,
    status: (o, v) => o.status === v,
    subscription: (o, v) =>
      idOf(((o.parent as Obj | null)?.subscription_details as Obj | undefined)?.subscription) === v,
  },
  charges: {
    customer: (o, v) => idOf(o.customer) === v,
    payment_intent: (o, v) => idOf(o.payment_intent) === v,
  },
  refunds: { charge: (o, v) => idOf(o.charge) === v },
  disputes: { charge: (o, v) => idOf(o.charge) === v },
}

/** Parameters that shape the answer but filter nothing. */
const PASSIVE = /^(limit|starting_after|expand(\[\d*\])?|created\[(gt|gte|lt|lte)\])$/

async function list(
  res: StandInResource,
  url: URL,
  deps: StandInDeps,
  livemode: boolean,
): Promise<Response> {
  const filters = LIST_FILTERS[res.segment] ?? {}
  const active: Array<[string, string]> = []
  for (const [k, v] of url.searchParams) {
    if (PASSIVE.test(k)) continue
    if (!filters[k]) throw deps.refuse(`${url.pathname}?${k}`)
    active.push([k, v])
  }
  let items = (await allOf(res, deps, livemode)).filter(createdFilter(url.searchParams))
  if (res.kind === "customer") items = items.filter((o) => o.deleted !== true)
  // The processor's default subscription list leaves the canceled out.
  if (res.kind === "subscription" && !url.searchParams.has("status"))
    items = items.filter((o) => o.status !== "canceled")
  for (const [k, v] of active) items = items.filter((o) => filters[k]?.(o, v) ?? false)
  return page(items, url.searchParams, url.pathname)
}

async function events(url: URL, deps: StandInDeps): Promise<Response> {
  const types = [...url.searchParams].filter(([k]) => /^types(\[\d*\])?$/.test(k)).map(([, v]) => v)
  const typeFilter = url.searchParams.get("type")
  let items = (await deps.outside.ofKind("event")).filter(createdFilter(url.searchParams))
  if (types.length > 0) items = items.filter((e) => types.includes(String(e.type)))
  if (typeFilter) items = items.filter((e) => e.type === typeFilter)
  return page(items, url.searchParams, url.pathname)
}

async function invoicePayments(url: URL, deps: StandInDeps, livemode: boolean): Promise<Response> {
  const intent = url.searchParams.get("payment[payment_intent]")
  const invoice = url.searchParams.get("invoice")
  if (!intent && !invoice) throw deps.refuse(url.pathname)
  const charges = await allOf(RESOURCE_BY_SEGMENT.get("charges") as StandInResource, deps, livemode)
  const data = charges
    .filter(
      (c) =>
        idOf(c.invoice) &&
        (intent ? idOf(c.payment_intent) === intent : idOf(c.invoice) === invoice),
    )
    .map((c) => ({
      id: `inpay_${String(c.id).replace(/^ch_/, "")}`,
      object: "invoice_payment",
      invoice: idOf(c.invoice),
      payment: { type: "payment_intent", payment_intent: idOf(c.payment_intent) },
      status: c.status === "succeeded" ? "paid" : "open",
    }))
  return page(data, url.searchParams, url.pathname)
}

async function invoiceLineList(
  id: string,
  url: URL,
  deps: StandInDeps,
  livemode: boolean,
): Promise<Response> {
  const invoices = RESOURCE_BY_SEGMENT.get("invoices") as StandInResource
  const invoice = await objectById(invoices, id, deps, livemode)
  if (!invoice) return missing("invoice", id)
  return page(invoiceLines(invoice, await planOf(invoice, deps)), url.searchParams, url.pathname)
}

async function account(deps: StandInDeps, livemode: boolean): Promise<Response> {
  const install = await deps.mirror.install()
  const id =
    typeof install?.account_id === "string" && install.account_id ? install.account_id : null
  if (!id) return apiError(404, "resource_missing", "No account is recorded for this install.")
  const name = typeof install?.account_name === "string" ? install.account_name : null
  return json({
    id,
    object: "account",
    livemode,
    business_profile: { name },
    charges_enabled: true,
  })
}

// ---------------------------------------------------------------------------
// Writes

function form(body: string | undefined): URLSearchParams {
  return new URLSearchParams(body ?? "")
}

async function createRefund(
  req: StandInRequest,
  deps: StandInDeps,
  livemode: boolean,
): Promise<Response> {
  const p = form(req.body)
  for (const k of p.keys()) {
    if (!/^(charge|amount|reason|metadata\[[A-Za-z0-9_]+\])$/.test(k))
      throw deps.refuse(`${req.url.pathname} ${k}`)
  }
  const chargeId = p.get("charge") ?? ""
  if (req.idempotencyKey) {
    const earlierId = await deps.outside.idempotent(req.idempotencyKey)
    const earlier = earlierId ? await deps.outside.get(earlierId) : null
    if (earlier) return json(earlier)
  }
  const charges = RESOURCE_BY_SEGMENT.get("charges") as StandInResource
  const charge = chargeId ? await objectById(charges, chargeId, deps, livemode) : null
  if (!charge) return missing("charge", chargeId)
  const amountTotal = Number(charge.amount ?? 0)
  const refunded = Number(charge.amount_refunded ?? 0)
  const left = amountTotal - refunded
  const amount = p.has("amount") ? Number(p.get("amount")) : left
  if (!Number.isInteger(amount) || amount <= 0)
    return apiError(400, "parameter_invalid_integer", "Invalid positive integer", "amount")
  if (amount > left) {
    return apiError(
      400,
      left <= 0 ? "charge_already_refunded" : "amount_too_large",
      `Refund amount (${amount}) is greater than unrefunded amount on charge (${left})`,
      "amount",
    )
  }
  const metadata: Obj = {}
  for (const [k, v] of p) {
    const m = /^metadata\[([A-Za-z0-9_]+)\]$/.exec(k)
    if (m) metadata[m[1] as string] = v
  }
  const created = Math.floor(deps.now().getTime() / 1000)
  const refund: Obj = {
    id: deps.newId("re"),
    object: "refund",
    livemode,
    charge: chargeId,
    amount,
    currency: charge.currency,
    status: "succeeded",
    reason: p.get("reason"),
    metadata,
    created,
  }
  const after: Obj = {
    ...charge,
    amount_refunded: refunded + amount,
    refunded: refunded + amount >= amountTotal,
  }
  await deps.outside.put([refund, after])
  if (req.idempotencyKey) await deps.outside.remember(req.idempotencyKey, String(refund.id))
  deps.deliver("charge.refunded", after)
  return json(refund)
}

async function updateSubscription(
  id: string,
  req: StandInRequest,
  deps: StandInDeps,
  livemode: boolean,
): Promise<Response> {
  const p = form(req.body)
  for (const k of p.keys()) {
    if (k !== "cancel_at_period_end") throw deps.refuse(`${req.url.pathname} ${k}`)
  }
  const subs = RESOURCE_BY_SEGMENT.get("subscriptions") as StandInResource
  const sub = await objectById(subs, id, deps, livemode)
  if (!sub) return missing("subscription", id)
  if (!p.has("cancel_at_period_end")) return json(sub)
  if (sub.status === "canceled" || sub.status === "incomplete_expired") {
    return apiError(
      400,
      "resource_missing",
      `A canceled subscription can only update its cancellation_details and metadata.`,
    )
  }
  const ending = p.get("cancel_at_period_end") === "true"
  const items = ((sub.items as Obj | undefined)?.data ?? []) as Obj[]
  const periodEnd = (items[0]?.current_period_end as number | null | undefined) ?? null
  const after: Obj = {
    ...sub,
    cancel_at_period_end: ending,
    cancel_at: ending ? periodEnd : null,
  }
  await deps.outside.put([after])
  deps.deliver("customer.subscription.updated", after)
  return json(after)
}

// ---------------------------------------------------------------------------

/** The answer to one request of the payments app, for one demo org. */
export async function answerStandIn(req: StandInRequest, deps: StandInDeps): Promise<Response> {
  const method = req.method.toUpperCase()
  const parts = req.url.pathname.replace(/\/+$/, "").split("/").filter(Boolean)
  if (parts[0] !== "v1") throw deps.refuse(req.url.pathname)
  const livemode = await livemodeOf(deps)
  const [, segment, id, sub] = parts

  if (method === "GET") {
    if (segment === "account" && !id) return account(deps, livemode)
    if (segment === "events") {
      if (!id) return events(req.url, deps)
      const event = await deps.outside.get(id)
      return event && event.object === "event" && !sub ? json(event) : missing("event", id)
    }
    if (segment === "invoice_payments" && !id) return invoicePayments(req.url, deps, livemode)
    const res = segment ? RESOURCE_BY_SEGMENT.get(segment) : undefined
    if (res) {
      if (!id) return list(res, req.url, deps, livemode)
      if (!sub) {
        const obj = await objectById(res, id, deps, livemode)
        return obj ? json(obj) : missing(res.kind, id)
      }
      if (res.segment === "invoices" && sub === "lines" && parts.length === 4)
        return invoiceLineList(id, req.url, deps, livemode)
    }
  }
  if (method === "POST") {
    if (segment === "refunds" && !id) return createRefund(req, deps, livemode)
    if (segment === "subscriptions" && id && !sub)
      return updateSubscription(id, req, deps, livemode)
  }
  throw deps.refuse(`${method} ${req.url.pathname}`)
}
