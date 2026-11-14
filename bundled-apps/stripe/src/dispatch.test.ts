// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One verified Stripe event through the handler, against an in-memory copy of
// the app's tables (unique on `stripe_id` and `event_id`, as the manifest
// declares) and a Stripe API that serves the CURRENT object by id. These tests
// call the handler directly, so the kernel's Redis replay claim is not there:
// the ledger is what stops a second delivery.
import { beforeEach, describe, expect, it } from "bun:test"
import { handleStripeEvent, type IngestCtx } from "./dispatch"
import { type MirrorDb, writeMirror } from "./mirror"
import { claimDelivery, DELIVERY_LEASE_MS } from "./webhooks"

const PAN = "4917484589897107"
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
  failInsertInto = new Set<string>()
  failUpdateOf = new Set<string>()
  private seq = 0
  rows(entity: string): Row[] {
    if (!this.tables.has(entity)) this.tables.set(entity, [])
    return this.tables.get(entity) as Row[]
  }
  private matches(r: Row, where?: Record<string, unknown>): boolean {
    return Object.entries(where ?? {}).every(([k, v]) => (v === null ? r[k] == null : r[k] === v))
  }
  async findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; limit?: number },
  ): Promise<unknown[]> {
    const out = this.rows(entity).filter((r) => this.matches(r, opts?.where))
    return structuredClone(out.slice(0, opts?.limit ?? out.length))
  }
  async insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }> {
    if (this.failInsertInto.has(entity)) throw new Error(`${entity}: the insert failed`)
    const key = UNIQUE[entity]
    if (key && this.rows(entity).some((r) => r[key] === data[key]))
      throw new Error("duplicate key value")
    const id = `row-${++this.seq}`
    this.rows(entity).push({ ...structuredClone(data), id })
    return { id }
  }
  async update(entity: string, id: string, data: Record<string, unknown>): Promise<void> {
    if (this.failUpdateOf.has(entity)) throw new Error(`update of ${entity} failed`)
    const r = this.rows(entity).find((x) => x.id === id)
    if (r) Object.assign(r, structuredClone(data))
  }
  async updateMany(
    entity: string,
    opts: { where: Record<string, unknown>; data: Record<string, unknown> },
  ) {
    // As the host does: a bulk update never selects by row id.
    if ("id" in opts.where) throw new Error("where.id is not allowed here")
    if (this.failUpdateOf.has(entity)) throw new Error(`update of ${entity} failed`)
    let count = 0
    for (const r of this.rows(entity)) {
      if (this.matches(r, opts.where)) {
        Object.assign(r, structuredClone(opts.data))
        count++
      }
    }
    return { count }
  }
  count(entity: string): number {
    return this.rows(entity).length
  }
}

/** Stripe's API: the current objects by path, and the calls made. */
class StripeApi {
  objects = new Map<string, Record<string, unknown>>()
  failNext = new Map<string, number>()
  calls: string[] = []
  set(path: string, obj: Record<string, unknown>) {
    this.objects.set(path, { livemode: false, ...obj })
  }
  async fetch(url: string, opts?: { headers?: Record<string, string> }) {
    const path = new URL(url).pathname
    this.calls.push(path)
    if (opts?.headers?.["Stripe-Version"] === undefined)
      return { status: 400, headers: {}, body: "{}" }
    const forced = this.failNext.get(path)
    if (forced) {
      this.failNext.delete(path)
      return { status: forced, headers: {}, body: JSON.stringify({ error: { message: "forced" } }) }
    }
    const obj = this.objects.get(path)
    return obj
      ? { status: 200, headers: {}, body: JSON.stringify(obj) }
      : { status: 404, headers: {}, body: JSON.stringify({ error: { message: "No such object" } }) }
  }
}

let db: MemDb
let api: StripeApi
let emitted: Array<{ entity: string; action: string; data?: unknown }>
let clock: number

function ctx(): IngestCtx {
  return {
    db: db as unknown as IngestCtx["db"],
    fetch: (url, opts) => api.fetch(url, opts),
    emit: async (e) => {
      emitted.push(e)
    },
  }
}

const now = () => new Date((clock += 1000))

function event(
  id: string,
  type: string,
  object: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    object: "event",
    type,
    created: 1767229300,
    livemode: false,
    data: { object },
    ...extra,
  }
}

function invoice(status: string, total = 17640, extra: Record<string, unknown> = {}) {
  return {
    id: "in_A1",
    object: "invoice",
    customer: "cus_A1",
    status,
    total,
    amount_paid: status === "paid" ? total : 0,
    amount_due: total,
    currency: "eur",
    number: "A1-0001",
    total_taxes: [{ amount: 2940 }],
    status_transitions: {
      finalized_at: 1767229200,
      paid_at: status === "paid" ? 1767229300 : null,
    },
    ...extra,
  }
}

function connect(state = "waiting_first_event", extra: Record<string, unknown> = {}) {
  db.rows("install_metadata").push({
    id: "install-1",
    state,
    livemode: false,
    account_id: null,
    permissions: {},
    connected_at: "2026-11-01T00:00:00.000Z",
    webhook_confirmed_at: null,
    ...extra,
  })
}

const install = () => db.rows("install_metadata")[0] as Row
const counts = () =>
  Object.fromEntries([...db.tables.entries()].map(([k, v]) => [k, v.length])) as Record<
    string,
    number
  >

beforeEach(() => {
  db = new MemDb()
  api = new StripeApi()
  emitted = []
  clock = Date.UTC(2026, 10, 10, 12, 0, 0)
})

describe("stripe event dispatch", () => {
  it("a duplicate event changes nothing", async () => {
    connect("connected", { webhook_confirmed_at: "2026-11-02T00:00:00.000Z" })
    api.set("/v1/invoices/in_A1", invoice("paid"))
    const ev = event("evt_dup1", "invoice.paid", { id: "in_A1" })
    expect((await handleStripeEvent(ev, ctx(), { now })).status).toBe(200)
    const before = {
      counts: counts(),
      mirror: structuredClone(db.rows("stripe_invoices")),
      calls: api.calls.length,
      emits: emitted.length,
    }
    expect(before.counts.stripe_invoices).toBe(1)
    expect(before.emits).toBe(1)

    // Mutation caught: a ledger that never stops a second delivery (re-fetch, rewrite, re-emit).
    const second = await handleStripeEvent(ev, ctx(), { now })
    expect(second.status).toBe(200)
    expect(second.body).toContain("already handled")
    expect({
      counts: counts(),
      mirror: db.rows("stripe_invoices"),
      calls: api.calls.length,
      emits: emitted.length,
    }).toEqual(before)
    expect(db.rows("webhook_deliveries").map((r) => r.status)).toEqual(["processed"])
  })

  it("paid before finalized ends as in order", async () => {
    const run = async (order: string[]) => {
      db = new MemDb()
      emitted = []
      connect("connected", { webhook_confirmed_at: "2026-11-02T00:00:00.000Z" })
      api.set("/v1/invoices/in_A1", invoice("paid"))
      for (const [i, type] of order.entries()) {
        const r = await handleStripeEvent(
          event(`evt_ord${i}${type}`, type, { id: "in_A1" }),
          ctx(),
          { now },
        )
        expect(r.status).toBe(200)
      }
      const [row] = db.rows("stripe_invoices")
      const { id: _id, stripe_updated: _u, ...rest } = row as Row
      return rest
    }
    const inOrder = await run(["invoice.finalized", "invoice.paid"])
    const reversed = await run(["invoice.paid", "invoice.finalized"])
    expect(reversed).toEqual(inOrder)
    expect(reversed.status).toBe("paid")
  })

  it("the mirror holds the fetched amount, not the event's", async () => {
    connect("connected", { webhook_confirmed_at: "2026-11-02T00:00:00.000Z" })
    api.set("/v1/invoices/in_A1", invoice("paid", 2))
    // The event's own copy says 1: it must never be used.
    await handleStripeEvent(event("evt_amt1", "invoice.paid", invoice("paid", 1)), ctx(), { now })
    const [row] = db.rows("stripe_invoices")
    expect(row?.total_minor).toBe(2)
    // The invoice is read once by id; the buyer is read from the mirror, else from Stripe by id.
    expect(api.calls.filter((c) => c.startsWith("/v1/invoices"))).toEqual(["/v1/invoices/in_A1"])
    const paid = emitted.find((e) => e.entity === "invoice" && e.action === "paid")
    expect((paid!.data as { total_minor: string }).total_minor).toBe("2")
  })

  it("invoice.created answers 200 within 2 seconds while the mirror write fails, and marks the catch-up", async () => {
    connect("connected")
    db.failInsertInto.add("webhook_deliveries")
    const started = performance.now()
    const r = await handleStripeEvent(event("evt_cr1", "invoice.created", { id: "in_A1" }), ctx(), {
      now,
    })
    expect(performance.now() - started).toBeLessThan(2000)
    expect(r.status).toBe(200)
    // Nothing was fetched for it, and the invoices catch-up is due.
    expect(api.calls).toEqual([])
    expect(db.rows("sync_state")).toEqual([
      expect.objectContaining({
        resource: "invoices",
        catchup_due: true,
        last_error_code: "ledger_write_failed",
      }),
    ])
    // Even when the catch-up mark fails too, Stripe still gets a 200.
    db.failInsertInto.add("sync_state")
    db.failUpdateOf.add("sync_state")
    expect(
      (
        await handleStripeEvent(event("evt_cr2", "invoice.created", { id: "in_A2" }), ctx(), {
          now,
        })
      ).status,
    ).toBe(200)
  })

  it("a card number in a customer description or invoice memo is stored masked and raises one attention item", async () => {
    connect("connected", { webhook_confirmed_at: "2026-11-02T00:00:00.000Z" })
    api.set("/v1/customers/cus_A1", {
      id: "cus_A1",
      object: "customer",
      name: `Acme card ${PAN}`,
      email: "billing@acme.example",
      description: `Pays with ${PAN.replace(/(\d{4})/g, "$1 ").trim()} exp 12/30`,
      created: 1767225600,
    })
    await handleStripeEvent(event("evt_pan1", "customer.updated", { id: "cus_A1" }), ctx(), { now })
    const stored = JSON.stringify(db.tables.get("stripe_customers"))
    expect(stored).toContain("7107")
    expect(stored).not.toContain(PAN)
    expect(stored).not.toContain("Pays with")
    let alerts = emitted.filter((e) => e.entity === "card_number" && e.action === "masked")
    expect(alerts.length).toBe(1)
    expect((alerts[0]!.data as { fields: string }).fields).toBe(
      "customer description, customer name",
    )

    api.set("/v1/invoices/in_A1", {
      ...invoice("open"),
      description: `Memo: card ${PAN}`,
      lines: { data: [{ description: `Seat for ${PAN}`, amount: 4900, quantity: 1 }] },
    })
    emitted = []
    await handleStripeEvent(event("evt_pan2", "invoice.finalized", { id: "in_A1" }), ctx(), { now })
    const all = JSON.stringify({ tables: [...db.tables.entries()], emitted })
    expect(all).not.toContain(PAN)
    alerts = emitted.filter((e) => e.entity === "card_number")
    expect(alerts.length).toBe(1)
    expect((alerts[0]!.data as { fields: string }).fields).toBe("invoice memo, invoice line")

    // Mutation caught (positive control): a clean object raises nothing.
    emitted = []
    api.set("/v1/customers/cus_A1", {
      id: "cus_A1",
      object: "customer",
      name: "Acme",
      created: 1767225600,
    })
    await handleStripeEvent(event("evt_pan3", "customer.updated", { id: "cus_A1" }), ctx(), { now })
    expect(emitted.filter((e) => e.entity === "card_number")).toEqual([])
  })

  it("the first verified event flips the connection to connected and names the event", async () => {
    connect("waiting_first_event")
    api.set("/v1/customers/cus_A1", {
      id: "cus_A1",
      object: "customer",
      name: "Acme",
      created: 1767225600,
    })
    await handleStripeEvent(event("evt_first", "customer.created", { id: "cus_A1" }), ctx(), {
      now,
    })
    expect(install()).toEqual(
      expect.objectContaining({
        state: "connected",
        last_event_type: "customer.created",
        webhook_confirmed_at: expect.any(String),
      }),
    )
    expect(install().last_event_at).toBe(install().webhook_confirmed_at)
    expect(emitted).toContainEqual(
      expect.objectContaining({
        entity: "connection",
        action: "state_changed",
        data: { from: "waiting_first_event", to: "connected" },
      }),
    )
    // While a first import still runs, the state reads importing instead.
    db = new MemDb()
    connect("waiting_first_event")
    db.rows("sync_state").push({ id: "s1", resource: "customers", status: "running" })
    await handleStripeEvent(event("evt_first2", "customer.created", { id: "cus_A1" }), ctx(), {
      now,
    })
    expect(install().state).toBe("importing")
  })

  it("a key swapped to another account writes nothing on a 404 and flags different_account", async () => {
    connect("connected", { webhook_confirmed_at: "2026-11-02T00:00:00.000Z" })
    db.rows("stripe_customers").push({
      id: "c1",
      stripe_id: "cus_A1",
      name: "Acme",
      deleted_at: null,
      stripe_updated: "2026-11-01T00:00:00.000Z",
    })
    db.rows("stripe_customers").push({
      id: "c2",
      stripe_id: "cus_B2",
      name: "Beta",
      deleted_at: null,
      stripe_updated: "2026-11-01T00:00:00.000Z",
    })
    const before = structuredClone(db.rows("stripe_customers"))
    // The other account answers 404 for every object Liaison holds.
    const r = await handleStripeEvent(
      event("evt_swap", "customer.updated", { id: "cus_A1" }),
      ctx(),
      { now },
    )
    expect(r.status).toBe(200)
    // Mutation caught: treating the 404 as a deletion.
    expect(db.rows("stripe_customers")).toEqual(before)
    expect(install().state).toBe("connected+different_account")
    expect(db.rows("webhook_deliveries").map((x) => x.status)).toEqual(["different_account"])

    // The same account confirmed (another known customer resolves in this mode): the 404 is a deletion.
    db = new MemDb()
    connect("connected", { webhook_confirmed_at: "2026-11-02T00:00:00.000Z" })
    db.rows("stripe_customers").push({
      id: "c1",
      stripe_id: "cus_A1",
      name: "Acme",
      deleted_at: null,
      stripe_updated: "2026-11-01T00:00:00.000Z",
    })
    db.rows("stripe_customers").push({
      id: "c2",
      stripe_id: "cus_B2",
      name: "Beta",
      deleted_at: null,
      stripe_updated: "2026-11-01T00:00:00.000Z",
    })
    api.set("/v1/customers/cus_B2", { id: "cus_B2", object: "customer" })
    await handleStripeEvent(event("evt_gone", "customer.updated", { id: "cus_A1" }), ctx(), { now })
    expect(db.rows("stripe_customers").find((x) => x.stripe_id === "cus_A1")?.deleted_at).toEqual(
      expect.any(String),
    )
    expect(install().state).toBe("connected")
  })

  it("a live event on a test install changes no row", async () => {
    connect("connected", { webhook_confirmed_at: "2026-11-02T00:00:00.000Z" })
    api.set("/v1/invoices/in_A1", invoice("paid"))
    const r = await handleStripeEvent(
      event("evt_live", "invoice.paid", { id: "in_A1" }, { livemode: true }),
      ctx(),
      { now },
    )
    expect(r.status).toBe(200)
    expect(api.calls).toEqual([])
    expect(db.rows("stripe_invoices")).toEqual([])
    expect(emitted).toEqual([])
    expect(db.rows("webhook_deliveries").map((x) => x.status)).toEqual(["mode_mismatch"])
  })

  it("a refused key answers 200, marks the key invalid and the catch-up due, and writes no mirror row", async () => {
    connect("connected", { webhook_confirmed_at: "2026-11-02T00:00:00.000Z" })
    api.set("/v1/invoices/in_A1", invoice("paid"))
    api.failNext.set("/v1/invoices/in_A1", 401)
    const r = await handleStripeEvent(event("evt_401", "invoice.paid", { id: "in_A1" }), ctx(), {
      now,
    })
    expect(r.status).toBe(200)
    expect(install().state).toBe("connected+key_invalid")
    expect(db.rows("stripe_invoices")).toEqual([])
    expect(db.rows("sync_state")).toEqual([
      expect.objectContaining({
        resource: "invoices",
        catchup_due: true,
        last_error_code: "key_invalid",
      }),
    ])
    expect(db.rows("webhook_deliveries").map((x) => x.status)).toEqual(["failed"])
  })

  it("a Stripe or database failure answers 500, leaves the delivery failed, and the retry converges on one row", async () => {
    connect("connected", { webhook_confirmed_at: "2026-11-02T00:00:00.000Z" })
    api.set("/v1/invoices/in_A1", invoice("paid"))
    api.failNext.set("/v1/invoices/in_A1", 500)
    const ev = event("evt_500", "invoice.paid", { id: "in_A1" })
    const r = await handleStripeEvent(ev, ctx(), { now })
    expect(r.status).toBe(500)
    expect(db.rows("webhook_deliveries")).toEqual([
      expect.objectContaining({ status: "failed", failure_count: 1 }),
    ])

    const retry = await handleStripeEvent(ev, ctx(), { now })
    expect(retry.status).toBe(200)
    expect(db.rows("webhook_deliveries")).toEqual([
      expect.objectContaining({ status: "processed", failure_count: 1 }),
    ])
    expect(db.count("stripe_invoices")).toBe(1)
  })

  it("a delivery another run still holds is not acknowledged: the retry answers 503, and past the lease it is applied", async () => {
    connect("connected", { webhook_confirmed_at: "2026-11-02T00:00:00.000Z" })
    api.set("/v1/invoices/in_A1", invoice("paid"))
    const ev = event("evt_stuck", "invoice.paid", { id: "in_A1" })
    // A run claimed it 10 s ago and was killed before it settled the row.
    const t = now().getTime()
    db.rows("webhook_deliveries").push({
      id: "d-1",
      event_id: "evt_stuck",
      topic: "invoice.paid",
      status: "processing",
      failure_count: 0,
      received_at: new Date(t - 10_000).toISOString(),
      claimed_at: new Date(t - 10_000).toISOString(),
    })
    // Mutation caught: a held claim answered 200 (the inbox settles it done and it is never applied).
    const fresh = await handleStripeEvent(ev, ctx(), { now })
    expect(fresh.status).toBe(503)
    expect(db.count("stripe_invoices")).toBe(0)
    expect(db.rows("webhook_deliveries")).toEqual([
      expect.objectContaining({ id: "d-1", status: "processing" }),
    ])
    // Past the lease, the next retry takes it over and applies it.
    clock += DELIVERY_LEASE_MS
    const late = await handleStripeEvent(ev, ctx(), { now })
    expect(late.status).toBe(200)
    expect(db.rows("webhook_deliveries")).toEqual([
      expect.objectContaining({ id: "d-1", status: "processed" }),
    ])
    expect(db.count("stripe_invoices")).toBe(1)
  })

  it("a run killed after its claim: the replays answer 503 until the lease lapses, then the event is applied exactly once", async () => {
    connect("connected", { webhook_confirmed_at: "2026-11-02T00:00:00.000Z" })
    api.set("/v1/invoices/in_A1", invoice("paid"))
    const ev = event("evt_killed", "invoice.paid", { id: "in_A1" })
    // The first run claims, then hangs in its re-fetch for ever: a killed run runs no catch.
    const fetchOf = api.fetch.bind(api)
    let hang = true
    const killed: IngestCtx = {
      ...ctx(),
      fetch: (url, opts) => (hang ? ((hang = false), new Promise(() => {})) : fetchOf(url, opts)),
    }
    void handleStripeEvent(ev, killed, { now })
    await new Promise((r) => setTimeout(r, 5))
    expect(db.rows("webhook_deliveries")).toEqual([
      expect.objectContaining({ status: "processing" }),
    ])

    const early = await handleStripeEvent(ev, ctx(), { now })
    expect(early.status).toBe(503)
    expect(db.count("stripe_invoices")).toBe(0)

    clock += DELIVERY_LEASE_MS
    const late = await handleStripeEvent(ev, ctx(), { now })
    expect(late.status).toBe(200)
    const again = await handleStripeEvent(ev, ctx(), { now })
    expect(again.status).toBe(200)
    expect(again.body).toContain("already handled")
    expect(db.count("stripe_invoices")).toBe(1)
    expect(emitted.filter((e) => e.entity === "invoice")).toHaveLength(1)
  })

  it("the lease outlasts any webhook run and stays short, so a takeover comes on an early replay", () => {
    expect(DELIVERY_LEASE_MS).toBe(45_000)
  })

  it("two retries of one failed delivery at the same time: only one takes it up", async () => {
    db.rows("webhook_deliveries").push({
      id: "d-2",
      event_id: "evt_twice",
      topic: "invoice.paid",
      status: "failed",
      failure_count: 1,
      received_at: now().toISOString(),
      claimed_at: null,
    })
    const at = now()
    const claims = await Promise.all([
      claimDelivery(db as unknown as IngestCtx["db"], "evt_twice", "invoice.paid", at),
      claimDelivery(db as unknown as IngestCtx["db"], "evt_twice", "invoice.paid", at),
    ])
    expect(claims.map((c) => c.kind).sort()).toEqual(["in_flight", "new"])
    expect(db.rows("webhook_deliveries")).toEqual([
      expect.objectContaining({ status: "processing", claimed_at: at.toISOString() }),
    ])
  })

  it("an event type the app does not handle is acknowledged and recorded as ignored", async () => {
    connect("connected")
    const r = await handleStripeEvent(
      event("evt_other", "product.created", { id: "prod_1" }),
      ctx(),
      { now },
    )
    expect(r.status).toBe(200)
    expect(api.calls).toEqual([])
    expect(db.rows("webhook_deliveries").map((x) => x.status)).toEqual(["ignored"])
  })
})

describe("mirror write", () => {
  it("an older re-fetch never overwrites a newer row", async () => {
    const mem = new MemDb()
    const d = mem as unknown as MirrorDb
    expect(
      await writeMirror(
        d,
        "stripe_invoices",
        { stripe_id: "in_1", status: "paid" },
        "2026-11-10T12:00:02.000Z",
      ),
    ).toBe("inserted")
    expect(
      await writeMirror(
        d,
        "stripe_invoices",
        { stripe_id: "in_1", status: "open" },
        "2026-11-10T12:00:01.000Z",
      ),
    ).toBe("stale")
    expect(mem.rows("stripe_invoices")[0]?.status).toBe("paid")
    expect(
      await writeMirror(
        d,
        "stripe_invoices",
        { stripe_id: "in_1", status: "void" },
        "2026-11-10T12:00:03.000Z",
      ),
    ).toBe("updated")
    expect(mem.rows("stripe_invoices")[0]?.status).toBe("void")
  })
})
