// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sync jobs against an in-memory copy of the app's tables (unique on
// `stripe_id`, `event_id` and `resource`, as the manifest declares) and a Stripe
// API that serves lists (newest first, `starting_after` paging), objects by id
// and events.
import { beforeEach, describe, expect, it } from "bun:test"
import { handleStripeEvent } from "./dispatch"
import { eventsHandler } from "./handlers"
import { HELD, moneyActionHold, syncProgress } from "./states"
import { runBackfill } from "./sync/backfill"
import { advanceState, type SyncCtx } from "./sync/common"
import { homeLoad } from "./sync/home"
import { onDisconnect, runCatchup } from "./sync/maintenance"
import { runProbe } from "./sync/probe"
import { runReconcile } from "./sync/reconcile"

type Row = Record<string, unknown> & { id: string }

const UNIQUE: Record<string, string> = {
  webhook_deliveries: "event_id",
  stripe_customers: "stripe_id",
  stripe_subscriptions: "stripe_id",
  stripe_invoices: "stripe_id",
  stripe_payments: "stripe_id",
  stripe_refunds: "stripe_id",
  stripe_disputes: "stripe_id",
  sync_state: "resource",
}

class MemDb {
  tables = new Map<string, Row[]>()
  /** Throw on the n-th conditional update of an entity (a run killed half way). */
  crashAt: { entity: string; n: number } | null = null
  private updates = 0
  private seq = 0
  rows(entity: string): Row[] {
    if (!this.tables.has(entity)) this.tables.set(entity, [])
    return this.tables.get(entity) as Row[]
  }
  private matches(r: Row, where?: Record<string, unknown>): boolean {
    return Object.entries(where ?? {}).every(([k, v]) => {
      if (v === null) return r[k] == null
      if (v && typeof v === "object" && Array.isArray((v as { in?: unknown[] }).in)) {
        return ((v as { in: unknown[] }).in as unknown[]).includes(r[k])
      }
      return r[k] === v
    })
  }
  async findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      limit?: number
      orderBy?: Record<string, "asc" | "desc">
    },
  ): Promise<unknown[]> {
    await Promise.resolve()
    const out = this.rows(entity).filter((r) => this.matches(r, opts?.where))
    const [key, dir] = Object.entries(opts?.orderBy ?? {})[0] ?? []
    if (key)
      out.sort((a, b) => (String(a[key]) < String(b[key]) ? -1 : 1) * (dir === "desc" ? -1 : 1))
    return structuredClone(out.slice(0, opts?.limit ?? out.length))
  }
  async insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }> {
    await Promise.resolve()
    const key = UNIQUE[entity]
    if (key && this.rows(entity).some((r) => r[key] === data[key]))
      throw new Error("duplicate key value")
    const id = `row-${++this.seq}`
    this.rows(entity).push({ ...structuredClone(data), id })
    return { id }
  }
  async update(entity: string, id: string, data: Record<string, unknown>): Promise<void> {
    await Promise.resolve()
    const r = this.rows(entity).find((x) => x.id === id)
    if (r) Object.assign(r, structuredClone(data))
  }
  async updateMany(
    entity: string,
    opts: { where: Record<string, unknown>; data: Record<string, unknown> },
  ) {
    await Promise.resolve()
    if (this.crashAt?.entity === entity && ++this.updates === this.crashAt.n)
      throw new Error("the worker died")
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
  async count(entity: string, opts?: { where?: Record<string, unknown> }): Promise<number> {
    return this.rows(entity).filter((r) => this.matches(r, opts?.where)).length
  }
  one(entity: string, where: Record<string, unknown>): Row | undefined {
    return this.rows(entity).find((r) => this.matches(r, where))
  }
}

type Obj = Record<string, unknown>

/** Stripe: lists by path (newest first), objects by id, events; a forced status per path. */
class StripeApi {
  lists = new Map<string, Obj[]>()
  objects = new Map<string, Obj>()
  events: Obj[] = []
  forced = new Map<string, number>()
  calls: string[] = []
  /** A loop under test that asks for more pages than this is a loop that does not end: fail instead of hanging. */
  maxCalls = 200
  /** Runs before a request is answered (another run moving in between). */
  beforeFetch: ((path: string) => void) | null = null
  /** Answer every request with this status (a revoked key). */
  all: number | null = null
  list(path: string, items: Obj[]) {
    const withMode: Obj[] = items.map((o) => ({ livemode: false, ...o }))
    this.lists.set(path, withMode)
    for (const o of withMode) this.objects.set(`${path}/${o.id}`, o)
  }
  async fetch(url: string, opts?: { headers?: Record<string, string> }) {
    const u = new URL(url)
    const path = u.pathname
    this.calls.push(`${path}${u.search}`)
    if (this.calls.length > this.maxCalls)
      throw new Error(`more than ${this.maxCalls} Stripe requests: the loop does not end`)
    this.beforeFetch?.(path)
    if (opts?.headers?.["Stripe-Version"] === undefined)
      return { status: 400, headers: {}, body: "{}" }
    const status = this.all ?? this.forced.get(path)
    if (status)
      return { status, headers: {}, body: JSON.stringify({ error: { message: "forced" } }) }
    const ok = (b: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(b) })
    if (path === "/v1/events") {
      const gt = Number(u.searchParams.get("created[gt]") ?? 0)
      const data = this.events
        .filter((e) => (e.created as number) > gt)
        .sort((a, b) => (b.created as number) - (a.created as number))
      return ok({ data, has_more: false })
    }
    if (path.startsWith("/v1/events/")) {
      const e = this.events.find((x) => x.id === path.slice("/v1/events/".length))
      return e ? ok(e) : { status: 404, headers: {}, body: "{}" }
    }
    const list = this.lists.get(path)
    if (list) {
      const limit = Number(u.searchParams.get("limit") ?? 10)
      const after = u.searchParams.get("starting_after")
      const start = after ? list.findIndex((o) => o.id === after) + 1 : 0
      const data = list.slice(start, start + limit)
      return ok({ object: "list", data, has_more: start + limit < list.length })
    }
    const obj = this.objects.get(path)
    return obj
      ? ok(obj)
      : { status: 404, headers: {}, body: JSON.stringify({ error: { message: "No such object" } }) }
  }
}

let db: MemDb
let api: StripeApi
let emitted: Array<{ entity: string; action: string; entityId?: string; data?: unknown }>
let clock: number
const now = () => new Date(clock)

function ctx(): SyncCtx {
  return {
    db: db as unknown as SyncCtx["db"],
    fetch: (url, opts) => api.fetch(url, opts),
    emit: async (e) => {
      emitted.push(e)
    },
  }
}

const RESOURCE_LISTS = [
  "/v1/customers",
  "/v1/subscriptions",
  "/v1/invoices",
  "/v1/charges",
  "/v1/refunds",
  "/v1/disputes",
]

function customers(n: number): Obj[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `cus_${String(i).padStart(4, "0")}`,
    object: "customer",
    email: `c${i}@acme.example`,
    created: 1767000000 + i,
  }))
}

function subscription(id: string, customer: string, status = "active"): Obj {
  return {
    id,
    object: "subscription",
    customer,
    status,
    currency: "eur",
    items: {
      data: [
        {
          quantity: 1,
          price: {
            id: "price_1",
            unit_amount: 4900,
            currency: "eur",
            recurring: { interval: "month" },
          },
          current_period_start: 1767225600,
          current_period_end: 1769904000,
        },
      ],
    },
  }
}

function install(state: string, extra: Obj = {}) {
  db.rows("install_metadata").push({
    id: "inst-1",
    state,
    livemode: false,
    permissions: {},
    connected_at: "2026-11-01T00:00:00.000Z",
    webhook_confirmed_at: state.startsWith("connected") ? "2026-11-02T00:00:00.000Z" : null,
    last_event_at: null,
    ...extra,
  })
}

function mirrorRow(entity: string, data: Obj) {
  db.rows(entity).push({
    id: `m-${data.stripe_id}`,
    stripe_updated: "2026-11-01T00:00:00.000Z",
    deleted_at: null,
    ...data,
  })
}

function emptyLists() {
  for (const p of RESOURCE_LISTS) if (!api.lists.has(p)) api.list(p, [])
}

const typed = () =>
  emitted.filter((e) => !(e.entity === "connection" && e.action === "state_changed"))

beforeEach(() => {
  db = new MemDb()
  api = new StripeApi()
  emitted = []
  clock = Date.parse("2026-11-10T12:00:00.000Z")
})

describe("the first import", () => {
  it("an import killed half way resumes at its cursor with no duplicate", async () => {
    install("waiting_first_event")
    api.list("/v1/customers", customers(250))
    emptyLists()
    // The worker dies after writing page 2, before its place is recorded (start, page 1, page 2).
    db.crashAt = { entity: "sync_state", n: 3 }
    await expect(runBackfill(ctx(), { now })).rejects.toThrow("the worker died")
    const stopped = db.one("sync_state", { resource: "customers" })
    expect(stopped?.cursor).toBe("cus_0099")
    expect(stopped?.done_count).toBe(100)

    db.crashAt = null
    api.calls = []
    const res = await runBackfill(ctx(), { now })
    expect(res.outcome).toBe("done")
    // Mutation caught: restarting at zero sends no starting_after on the first page.
    expect(api.calls.find((c) => c.startsWith("/v1/customers?"))).toContain(
      "starting_after=cus_0099",
    )
    expect(db.count("stripe_customers")).resolves.toBe(250)
    expect(new Set(db.rows("stripe_customers").map((r) => r.stripe_id)).size).toBe(250)
    expect(db.one("sync_state", { resource: "customers" })).toMatchObject({
      status: "done",
      done_count: 250,
    })
    expect(typed()).toEqual([])
  })

  it("a 429 stops the run at once with its place kept, and the next run carries on from there", async () => {
    install("waiting_first_event")
    api.list("/v1/customers", customers(150))
    emptyLists()
    // Page 1 answers, page 2 is refused with 429.
    api.beforeFetch = (path) => {
      if (path === "/v1/customers" && db.one("sync_state", { resource: "customers" })?.cursor)
        api.forced.set("/v1/customers", 429)
    }
    const started = Date.now()
    const first = await runBackfill(ctx(), { now })
    // Mutation caught: a wait or a retry inside the run (one call for the refused page, no time spent).
    expect(first).toMatchObject({ outcome: "paused", detail: "rate_limited" })
    expect(api.calls.filter((c) => c.startsWith("/v1/customers?"))).toHaveLength(2)
    expect(Date.now() - started).toBeLessThan(200)
    expect(db.one("sync_state", { resource: "customers" })).toMatchObject({
      cursor: "cus_0099",
      done_count: 100,
      status: "running",
    })

    api.beforeFetch = null
    api.forced.delete("/v1/customers")
    api.calls = []
    const next = await runBackfill(ctx(), { now })
    expect(next.outcome).toBe("done")
    expect(api.calls.find((c) => c.startsWith("/v1/customers?"))).toContain(
      "starting_after=cus_0099",
    )
    expect(new Set(db.rows("stripe_customers").map((r) => r.stripe_id)).size).toBe(150)
  })

  it("two import runs at once write and count each object once", async () => {
    install("waiting_first_event")
    api.list("/v1/customers", customers(230))
    emptyLists()
    await Promise.all([runBackfill(ctx(), { now }), runBackfill(ctx(), { now })])
    await runBackfill(ctx(), { now })
    expect(db.rows("stripe_customers").length).toBe(230)
    expect(db.one("sync_state", { resource: "customers" })).toMatchObject({
      status: "done",
      done_count: 230,
    })
  })

  it("a run whose place was moved by another run is refused at the cursor and leaves the winner's cursor", async () => {
    install("waiting_first_event")
    api.list("/v1/customers", customers(230))
    emptyLists()
    // Another run wins the page 1 swap between this run's read and its write.
    let moved = false
    api.beforeFetch = (path) => {
      if (path !== "/v1/customers" || moved) return
      moved = true
      Object.assign(db.one("sync_state", { resource: "customers" }) as Row, {
        cursor: "cus_0099",
        done_count: 100,
        status: "running",
      })
    }
    const res = await runBackfill(ctx(), { now })
    expect(res).toMatchObject({ outcome: "stopped", detail: "another run moved the import on" })
    expect(db.one("sync_state", { resource: "customers" })).toMatchObject({
      cursor: "cus_0099",
      done_count: 100,
      status: "running",
    })
  })

  it("the cursor swap refuses a write made from a place that has moved on", async () => {
    install("waiting_first_event")
    db.rows("sync_state").push({
      id: "s1",
      resource: "customers",
      status: "running",
      cursor: "cus_0099",
      done_count: 100,
    })
    const stale = {
      id: "s1",
      resource: "customers",
      status: "running",
      cursor: null,
      done_count: 0,
    } as Parameters<typeof advanceState>[1]
    expect(await advanceState(ctx().db, stale, { cursor: "cus_0049", done_count: 50 }, now())).toBe(
      false,
    )
    expect(db.one("sync_state", { resource: "customers" })).toMatchObject({
      cursor: "cus_0099",
      done_count: 100,
    })
    const fresh = { ...stale, cursor: "cus_0099", done_count: 100 }
    expect(
      await advanceState(ctx().db, fresh, { cursor: "cus_0199", done_count: 200 }, now()),
    ).toBe(true)
    expect(db.one("sync_state", { resource: "customers" })).toMatchObject({
      cursor: "cus_0199",
      done_count: 200,
    })
  })

  it("an invoice finalized before the connection is mirrored as before_connection and announced to nobody", async () => {
    install("waiting_first_event")
    api.list("/v1/invoices", [
      {
        id: "in_old",
        object: "invoice",
        customer: "cus_1",
        status: "paid",
        total: 100,
        currency: "eur",
        status_transitions: { finalized_at: 1793318400 },
      },
      {
        id: "in_new",
        object: "invoice",
        customer: "cus_1",
        status: "open",
        total: 100,
        currency: "eur",
        status_transitions: { finalized_at: 1793750400 },
      },
    ])
    emptyLists()
    await runBackfill(ctx(), { now })
    expect(db.one("stripe_invoices", { stripe_id: "in_old" })?.issuer).toBe("before_connection")
    expect(db.one("stripe_invoices", { stripe_id: "in_new" })?.issuer).toBeUndefined()
    expect(typed()).toEqual([])
  })

  it("while importing no number, no routine tick and no issuing event", async () => {
    install("importing", { webhook_confirmed_at: "2026-11-02T00:00:00.000Z" })
    db.rows("sync_state").push({
      id: "s1",
      resource: "customers",
      status: "running",
      cursor: null,
      done_count: 0,
      catchup_due: false,
    })
    const inv = {
      id: "in_W",
      object: "invoice",
      customer: "cus_1",
      status: "open",
      total: 900,
      currency: "eur",
      status_transitions: { finalized_at: 1762900000 },
    }
    api.objects.set("/v1/invoices/in_W", { livemode: false, ...inv })
    const evt = {
      id: "evt_W",
      object: "event",
      type: "invoice.finalized",
      created: 1762900001,
      livemode: false,
      data: { object: { id: "in_W" } },
    }
    api.events.push(evt)

    expect((await eventsHandler(evt, ctx() as never)).status).toBe(200)
    // Mutation caught: without the hold, invoice:finalized (what issuing and routines listen to) goes out now.
    expect(typed()).toEqual([])
    expect(db.one("webhook_deliveries", { event_id: "evt_W" })?.status).toBe(HELD)
    expect((await syncProgress(db as never)).partial).toBe(true)
    const home = await homeLoad({}, { db: db as never })
    expect(home.mrr).toBeNull()
    expect(home.sync.importing).toBe(true)

    // The import ends: the held delivery is played once through the dispatch.
    api.list("/v1/customers", [])
    emptyLists()
    const res = await runBackfill(ctx(), { now })
    expect(res).toMatchObject({ outcome: "done", released: 1 })
    expect(typed().filter((e) => e.entity === "invoice" && e.action === "finalized")).toHaveLength(
      1,
    )
    expect(db.one("webhook_deliveries", { event_id: "evt_W" })?.status).toBe("processed")
    expect(String(db.one("install_metadata", {})?.state)).toBe("connected")
  })

  it("a 403 on one resource reads partial with that resource, and the others are imported", async () => {
    install("waiting_first_event")
    api.list("/v1/customers", customers(3))
    emptyLists()
    api.forced.set("/v1/charges", 403)
    const res = await runBackfill(ctx(), { now })
    expect(res.outcome).toBe("done")
    expect(db.one("sync_state", { resource: "charges" })).toMatchObject({
      status: "failed",
      last_error_code: "permission_missing",
    })
    expect(db.one("sync_state", { resource: "disputes" })?.status).toBe("done")
    expect(String(db.one("install_metadata", {})?.state)).toBe("waiting_first_event+partial")
    const home = await homeLoad({}, { db: db as never })
    expect(home.sync.missing).toEqual(["charges"])
    expect(home.sync.partial).toBe(true)
  })
})

describe("the nightly reconcile", () => {
  beforeEach(() => {
    install("connected")
    for (const r of ["customers", "subscriptions", "invoices", "charges", "refunds", "disputes"]) {
      db.rows("sync_state").push({
        id: `s-${r}`,
        resource: r,
        status: "done",
        cursor: null,
        done_count: 0,
        catchup_due: false,
      })
    }
  })

  it("the nightly job heals a lost update and writes no document", async () => {
    mirrorRow("stripe_customers", { stripe_id: "cus_A", email: "old@acme.example" })
    mirrorRow("stripe_subscriptions", {
      stripe_id: "sub_A",
      customer_id: "cus_A",
      status: "active",
      mrr_minor: 4900,
    })
    api.list("/v1/customers", [
      { id: "cus_A", object: "customer", email: "new@acme.example", created: 1767000000 },
    ])
    api.list("/v1/subscriptions", [subscription("sub_A", "cus_A", "canceled")])
    emptyLists()
    const res = await runReconcile(ctx(), { now })
    expect(res.outcome).toBe("done")
    expect(db.one("stripe_customers", { stripe_id: "cus_A" })?.email).toBe("new@acme.example")
    expect(db.one("stripe_subscriptions", { stripe_id: "sub_A" })).toMatchObject({
      status: "canceled",
      mrr_minor: 0,
    })
    // Nothing announced: no invoice event, so no document anywhere.
    expect(emitted).toEqual([])
  })

  it("a list page that omits a live customer and subscription, a clock customer among them, leaves both rows unchanged", async () => {
    mirrorRow("stripe_customers", { stripe_id: "cus_CLOCK", email: "clock@acme.example" })
    mirrorRow("stripe_customers", { stripe_id: "cus_B", email: "b@acme.example" })
    mirrorRow("stripe_subscriptions", {
      stripe_id: "sub_CLOCK",
      customer_id: "cus_CLOCK",
      status: "active",
      mrr_minor: 4900,
    })
    // The lists leave out the test-clock customer and its subscription; by id Stripe still has both.
    api.list("/v1/customers", [
      { id: "cus_B", object: "customer", email: "b@acme.example", created: 1767000000 },
    ])
    api.list("/v1/subscriptions", [])
    emptyLists()
    api.objects.set("/v1/customers/cus_CLOCK", {
      id: "cus_CLOCK",
      object: "customer",
      livemode: false,
      email: "clock@acme.example",
      test_clock: "clock_1",
      created: 1767000000,
    })
    api.objects.set("/v1/subscriptions/sub_CLOCK", {
      livemode: false,
      ...subscription("sub_CLOCK", "cus_CLOCK"),
    })
    await runReconcile(ctx(), { now })
    // Mutation caught: soft-deleting rows absent from the page sets deleted_at / cancels.
    expect(db.one("stripe_customers", { stripe_id: "cus_CLOCK" })).toMatchObject({
      deleted_at: null,
      email: "clock@acme.example",
    })
    expect(db.one("stripe_subscriptions", { stripe_id: "sub_CLOCK" })).toMatchObject({
      status: "active",
      mrr_minor: 4900,
    })

    // Stripe not answering by id changes nothing either.
    api.forced.set("/v1/customers/cus_CLOCK", 500)
    api.forced.set("/v1/subscriptions/sub_CLOCK", 500)
    await runReconcile(ctx(), { now })
    expect(db.one("stripe_customers", { stripe_id: "cus_CLOCK" })?.deleted_at).toBeNull()
    expect(db.one("stripe_subscriptions", { stripe_id: "sub_CLOCK" })?.status).toBe("active")
  })

  it("a customer Stripe answers 404 for is marked deleted only once the same account is confirmed", async () => {
    mirrorRow("stripe_customers", { stripe_id: "cus_GONE" })
    mirrorRow("stripe_customers", { stripe_id: "cus_B" })
    api.list("/v1/customers", [{ id: "cus_B", object: "customer", created: 1767000000 }])
    emptyLists()
    const res = await runReconcile(ctx(), { now })
    expect(res.deleted).toBe(1)
    expect(db.one("stripe_customers", { stripe_id: "cus_GONE" })?.deleted_at).toBeTruthy()
    expect(db.one("stripe_customers", { stripe_id: "cus_B" })?.deleted_at).toBeNull()
  })

  it("a key swapped to another account makes reconcile write nothing and flag different_account", async () => {
    mirrorRow("stripe_customers", { stripe_id: "cus_A", email: "a@acme.example" })
    mirrorRow("stripe_subscriptions", {
      stripe_id: "sub_A",
      customer_id: "cus_A",
      status: "active",
    })
    // The other account: none of our ids exists, and its lists hold its own objects.
    api.list("/v1/customers", [{ id: "cus_OTHER", object: "customer", created: 1767000000 }])
    api.list("/v1/subscriptions", [subscription("sub_OTHER", "cus_OTHER")])
    emptyLists()
    api.objects.delete("/v1/customers/cus_A")
    const res = await runReconcile(ctx(), { now })
    expect(res).toMatchObject({ outcome: "different_account", written: 0, deleted: 0 })
    // Mutation caught: deleting on a 404 marks cus_A deleted.
    expect(db.one("stripe_customers", { stripe_id: "cus_A" })?.deleted_at).toBeNull()
    expect(db.one("stripe_customers", { stripe_id: "cus_OTHER" })).toBeUndefined()
    expect(db.one("stripe_subscriptions", { stripe_id: "sub_OTHER" })).toBeUndefined()
    expect(String(db.one("install_metadata", {})?.state)).toBe("connected+different_account")
  })

  it("a 401 marks the key invalid, waiting approvals stay, and approving a refund fails with no effect and says why", async () => {
    mirrorRow("stripe_customers", { stripe_id: "cus_A", email: "a@acme.example" })
    api.all = 401
    const res = await runReconcile(ctx(), { now })
    expect(res.outcome).toBe("key_invalid")
    expect(String(db.one("install_metadata", {})?.state)).toBe("connected+key_invalid")
    expect(emitted).toEqual([
      {
        entity: "connection",
        action: "state_changed",
        entityId: "inst-1",
        data: { from: "connected", to: "connected+key_invalid" },
      },
    ])
    expect(db.one("stripe_customers", { stripe_id: "cus_A" })?.email).toBe("a@acme.example")
    // The money action refuses before any call, and says the request stays waiting.
    api.calls = []
    const hold = await moneyActionHold(db as never)
    expect(hold).toMatchObject({ error: { code: "key_invalid" } })
    expect(JSON.stringify(hold)).toContain("nothing was sent to Stripe")
    expect(JSON.stringify(hold)).toContain("stays waiting")
    expect(api.calls).toEqual([])
    // The jobs stop asking Stripe until a person fixes the key.
    expect((await runReconcile(ctx(), { now })).outcome).toBe("blocked")
    expect(api.calls).toEqual([])
  })
})

describe("the upstream probe", () => {
  function evt(id: string, createdIso: string) {
    return {
      id,
      object: "event",
      type: "customer.updated",
      created: Date.parse(createdIso) / 1000,
      livemode: false,
      data: { object: { id: "cus_A" } },
    }
  }

  it("newer events upstream and none received for two hours stall the connection; a quiet account never stalls", async () => {
    install("connected", { last_event_at: "2026-11-10T09:00:00.000Z" })
    api.objects.set("/v1/customers/cus_A", {
      id: "cus_A",
      object: "customer",
      livemode: false,
      email: "a@acme.example",
      created: 1767000000,
    })
    api.events.push(evt("evt_M1", "2026-11-10T09:30:00.000Z"))
    const res = await runProbe(ctx(), { now })
    expect(res).toMatchObject({
      stalled: true,
      missed: 1,
      replayed: 1,
      upstreamActivityAt: "2026-11-10T09:30:00.000Z",
    })
    const inst = db.one("install_metadata", {})
    expect(String(inst?.state)).toBe("connected+stalled")
    // The replay applied the event but is not a delivery: the record and the mark stay.
    expect(inst?.last_event_at).toBe("2026-11-10T09:00:00.000Z")
    expect(db.one("stripe_customers", { stripe_id: "cus_A" })?.email).toBe("a@acme.example")
    expect(db.one("webhook_deliveries", { event_id: "evt_M1" })?.status).toBe("processed")
    expect(emitted.filter((e) => e.entity === "connection")).toHaveLength(1)

    // A quiet account: nothing newer upstream, ten days of silence, never stalled.
    db = new MemDb()
    emitted = []
    install("connected", { last_event_at: "2026-10-31T12:00:00.000Z" })
    api.events = [evt("evt_OLD", "2026-10-30T12:00:00.000Z")]
    expect(await runProbe(ctx(), { now })).toMatchObject({ stalled: false, missed: 0 })
    expect(String(db.one("install_metadata", {})?.state)).toBe("connected")
    expect(emitted).toEqual([])
  })

  it("one hour fifty-nine of silence with a newer event upstream is not yet stalled", async () => {
    install("connected", { last_event_at: "2026-11-10T10:01:00.000Z" })
    api.events.push(evt("evt_N", "2026-11-10T10:30:00.000Z"))
    expect(await runProbe(ctx(), { now })).toMatchObject({ stalled: false, missed: 1 })
    clock = Date.parse("2026-11-10T12:01:00.000Z")
    expect(await runProbe(ctx(), { now })).toMatchObject({ stalled: true })
  })
})

describe("catch-up and disconnect", () => {
  it("a delivery failed on a refused key is applied once when the key works again", async () => {
    install("connected")
    db.rows("sync_state").push({
      id: "s1",
      resource: "invoices",
      status: "done",
      cursor: null,
      done_count: 0,
      catchup_due: false,
    })
    const evt = {
      id: "evt_K",
      object: "event",
      type: "invoice.paid",
      created: 1762900001,
      livemode: false,
      data: { object: { id: "in_K" } },
    }
    api.events.push(evt)
    api.objects.set("/v1/invoices/in_K", {
      id: "in_K",
      object: "invoice",
      livemode: false,
      customer: "cus_1",
      status: "paid",
      total: 5,
      currency: "eur",
    })
    api.forced.set("/v1/invoices/in_K", 401)
    await handleStripeEvent(evt, ctx() as never)
    expect(db.one("webhook_deliveries", { event_id: "evt_K" })?.status).toBe("failed")
    expect(db.one("sync_state", { resource: "invoices" })?.catchup_due).toBe(true)
    // A person saves a working key (the key check clears the overlay).
    api.forced.clear()
    db.one("install_metadata", {})!.state = "connected"
    const res = await runCatchup(ctx(), { now })
    expect(res).toMatchObject({ replayed: 1, cleared: true })
    expect(db.one("webhook_deliveries", { event_id: "evt_K" })?.status).toBe("processed")
    expect(db.rows("stripe_invoices")).toHaveLength(1)
    expect(db.one("sync_state", { resource: "invoices" })?.catchup_due).toBe(false)
  })

  it("disconnecting removes every mirror row and touches nothing of another app", async () => {
    install("connected")
    mirrorRow("stripe_customers", { stripe_id: "cus_A" })
    mirrorRow("stripe_invoices", { stripe_id: "in_A", liaison_document_id: "doc-1" })
    db.rows("webhook_deliveries").push({ id: "d1", event_id: "evt_1", status: "processed" })
    db.rows("sync_state").push({ id: "s1", resource: "customers", status: "done" })
    expect(await onDisconnect({ data: { appName: "shopify" } }, ctx())).toBeNull()
    expect(db.rows("stripe_customers")).toHaveLength(1)
    const res = await onDisconnect({ data: { appName: "stripe" } }, ctx())
    expect(res).toMatchObject({ done: true, removed: 5 })
    for (const [, rows] of db.tables) expect(rows).toEqual([])
  })
})
