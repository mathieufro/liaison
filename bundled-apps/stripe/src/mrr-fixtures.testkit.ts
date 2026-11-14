// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared by the MRR tests: an in-memory copy of the app's tables (unique keys as
// the manifest declares, `in` filters, order, offset), a Stripe API that serves
// objects by id, lists and the events list, and a zone clock like the host's.
export type Row = Record<string, unknown> & { id: string }
export type Obj = Record<string, unknown>

const UNIQUE: Record<string, string> = {
  webhook_deliveries: "event_id",
  stripe_customers: "stripe_id",
  stripe_subscriptions: "stripe_id",
  stripe_invoices: "stripe_id",
  stripe_payments: "stripe_id",
  stripe_refunds: "stripe_id",
  stripe_disputes: "stripe_id",
  stripe_mrr_events: "stripe_event_id",
  sync_state: "resource",
}

export class MemDb {
  tables = new Map<string, Row[]>()
  private seq = 0
  rows(entity: string): Row[] {
    if (!this.tables.has(entity)) this.tables.set(entity, [])
    return this.tables.get(entity) as Row[]
  }
  private matches(r: Row, where?: Obj): boolean {
    return Object.entries(where ?? {}).every(([k, v]) => {
      if (v === null) return r[k] == null
      if (v && typeof v === "object" && Array.isArray((v as { in?: unknown[] }).in))
        return (v as { in: unknown[] }).in.includes(r[k])
      return r[k] === v
    })
  }
  async findMany(
    entity: string,
    opts?: {
      where?: Obj
      limit?: number
      offset?: number
      orderBy?: Record<string, "asc" | "desc">
    },
  ): Promise<unknown[]> {
    await Promise.resolve()
    const out = this.rows(entity).filter((r) => this.matches(r, opts?.where))
    const keys = Object.entries(opts?.orderBy ?? {})
    out.sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = String(a[k] ?? "")
        const y = String(b[k] ?? "")
        if (x !== y) return (x < y ? -1 : 1) * (dir === "desc" ? -1 : 1)
      }
      return 0
    })
    const from = opts?.offset ?? 0
    return structuredClone(out.slice(from, from + (opts?.limit ?? out.length)))
  }
  async insert(entity: string, data: Obj): Promise<{ id: string }> {
    await Promise.resolve()
    const key = UNIQUE[entity]
    if (key && this.rows(entity).some((r) => r[key] === data[key]))
      throw new Error("duplicate key value")
    const id = `row-${++this.seq}`
    this.rows(entity).push({ ...structuredClone(data), id })
    return { id }
  }
  async update(entity: string, id: string, data: Obj): Promise<void> {
    await Promise.resolve()
    const r = this.rows(entity).find((x) => x.id === id)
    if (r) Object.assign(r, structuredClone(data))
  }
  async updateMany(entity: string, opts: { where: Obj; data: Obj }) {
    await Promise.resolve()
    let count = 0
    for (const r of this.rows(entity)) {
      if (this.matches(r, opts.where)) {
        Object.assign(r, structuredClone(opts.data))
        count++
      }
    }
    return { count }
  }
  async delete(entity: string, id: string): Promise<void> {
    this.tables.set(
      entity,
      this.rows(entity).filter((r) => r.id !== id),
    )
  }
  async count(entity: string, opts?: { where?: Obj }): Promise<number> {
    return this.rows(entity).filter((r) => this.matches(r, opts?.where)).length
  }
}

export class StripeApi {
  lists = new Map<string, Obj[]>()
  objects = new Map<string, Obj>()
  events: Obj[] = []
  list(path: string, items: Obj[]) {
    const withMode: Obj[] = items.map((o) => ({ livemode: false, ...o }))
    this.lists.set(path, withMode)
    for (const o of withMode) this.objects.set(`${path}/${o.id}`, o)
  }
  async fetch(url: string, opts?: { headers?: Record<string, string> }) {
    const u = new URL(url)
    const path = u.pathname
    if (opts?.headers?.["Stripe-Version"] === undefined)
      return { status: 400, headers: {}, body: "{}" }
    const ok = (b: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(b) })
    if (path === "/v1/events") {
      const gte = Number(u.searchParams.get("created[gte]") ?? 0)
      const data = this.events
        .filter((e) => (e.created as number) >= gte)
        .sort((a, b) => (b.created as number) - (a.created as number))
      return ok({ data, has_more: false })
    }
    const list = this.lists.get(path)
    if (list) return ok({ object: "list", data: list, has_more: false })
    const obj = this.objects.get(path)
    return obj
      ? ok(obj)
      : { status: 404, headers: {}, body: JSON.stringify({ error: { message: "No such object" } }) }
  }
}

/** The host's `ctx.time.civil`, from Intl (the tests run outside the sandbox). */
export function civil(p: { timezone: string; at?: string | number }) {
  const zone = p.timezone === "UTC" ? "Pacific/Auckland" : p.timezone
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(p.at ?? Date.now()))
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value)
  const year = get("year")
  const month = get("month")
  const day = get("day")
  return Promise.resolve({
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    year,
    month,
    day,
  })
}

export function sub(
  id: string,
  o: {
    status?: string
    unit?: number
    qty?: number
    interval?: string
    count?: number
    currency?: string
    usage?: string
    discounts?: Obj[]
    tax?: { behavior: string; pct: number }
    cancelAt?: number
    plan?: string
  } = {},
): Obj {
  const currency = o.currency ?? "eur"
  return {
    id,
    object: "subscription",
    customer: `cus_${id}`,
    status: o.status ?? "active",
    currency,
    cancel_at: o.cancelAt ?? null,
    ...(o.discounts ? { discounts: o.discounts } : {}),
    items: {
      data: [
        {
          quantity: o.qty ?? 1,
          ...(o.tax ? { tax_rates: [{ percentage: o.tax.pct }] } : {}),
          current_period_start: 1_793_000_000,
          current_period_end: 1_795_600_000,
          price: {
            id: `price_${o.plan ?? "std"}`,
            product: o.plan ?? "Standard",
            unit_amount: o.unit ?? 4900,
            currency,
            tax_behavior: o.tax?.behavior ?? "exclusive",
            recurring: {
              interval: o.interval ?? "month",
              interval_count: o.count ?? 1,
              usage_type: o.usage ?? "licensed",
            },
          },
        },
      ],
    },
  }
}
