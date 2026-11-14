// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MRR: the rule per subscription (mrr.ts), the movement log (mrr-events.ts), its
// rebuild from Stripe's events (mrr-rebuild.ts) and the query over both, against
// an in-memory copy of the app's tables.
import { beforeEach, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { handleStripeEvent, type IngestCtx } from "./dispatch"
import { newTally, subscriptionRow } from "./mirror"
import { civil, MemDb, type Obj, StripeApi, sub } from "./mrr-fixtures.testkit"
import type { SyncCtx } from "./sync/common"
import { runReconcile } from "./sync/reconcile"
import { mrrQuery } from "./tools/mrr-query"

const NOW = new Date("2026-11-15T10:00:00.000Z")
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const mrrOf = (o: Obj) => subscriptionRow(o, newTally(), NOW).mrr_minor
const off = (couponFields: Obj) => [{ coupon: { duration: "forever", ...couponFields } }]

let db: MemDb
let api: StripeApi
let clock = NOW.getTime()

const syncCtx = (): SyncCtx => ({
  db: db as unknown as SyncCtx["db"],
  fetch: (u, o) => api.fetch(u, o),
  emit: async () => {},
})
const ingestCtx = (): IngestCtx => ({
  db: db as unknown as IngestCtx["db"],
  fetch: (u, o) => api.fetch(u, o),
  emit: async () => {},
})
const queryCtx = () => ({ db, time: { civil }, now: () => NOW })

function connect() {
  db.rows("install_metadata").push({
    id: "install-1",
    state: "connected",
    livemode: false,
    account_id: null,
    permissions: {},
    connected_at: "2026-11-01T00:00:00.000Z",
    webhook_confirmed_at: "2026-11-02T00:00:00.000Z",
    last_event_at: null,
  })
}

/** A mirror row as the handler would have written it, at an old write time. */
function stored(o: Obj, extra: Obj = {}) {
  const row = subscriptionRow(o, newTally(), NOW)
  db.rows("stripe_subscriptions").push({
    id: `m-${o.id}`,
    stripe_updated: "2026-11-01T00:00:00.000Z",
    ...row,
    ...extra,
  })
}

function movement(
  subId: string,
  at: string,
  kind: string,
  before: number,
  after: number,
  extra: Obj = {},
) {
  db.rows("stripe_mrr_events").push({
    id: `e-${subId}-${at}`,
    stripe_event_id: `evt_${subId}_${at}`,
    subscription_id: subId,
    customer_id: `cus_${subId}`,
    at,
    kind,
    delta_minor: after - before,
    before_minor: before,
    after_minor: after,
    currency: "eur",
    source: "webhook",
    ...extra,
  })
}

const log = (subId: string) =>
  db.rows("stripe_mrr_events").filter((r) => r.subscription_id === subId)

function webhook(id: string, type: string, subId: string, createdIso: string) {
  return {
    id,
    object: "event",
    type,
    created: sec(createdIso),
    livemode: false,
    data: { object: { id: subId } },
  }
}

function lists() {
  for (const p of [
    "/v1/customers",
    "/v1/subscriptions",
    "/v1/invoices",
    "/v1/charges",
    "/v1/refunds",
    "/v1/disputes",
  ]) {
    if (!api.lists.has(p)) api.list(p, [])
  }
}

beforeEach(() => {
  db = new MemDb()
  api = new StripeApi()
  clock = NOW.getTime()
})

describe("the rule per subscription", () => {
  it("twelve subscriptions give the hand-computed MRR, case by case", () => {
    // Every expected value is written out, in minor units.
    const cases: Array<[string, Obj, number]> = [
      ["monthly 2900", sub("s1", { unit: 2900 }), 2900],
      ["yearly 120000 is a twelfth", sub("s2", { unit: 120000, interval: "year" }), 10000],
      [
        "quarterly 30000 is a third",
        sub("s3", { unit: 30000, interval: "month", count: 3 }),
        10000,
      ],
      [
        "weekly 1000 is 1000 x 52/12 = 4333.33, down",
        sub("s4", { unit: 1000, interval: "week" }),
        4333,
      ],
      ["daily 100 is 100 x 365/12 = 3041.67, up", sub("s5", { unit: 100, interval: "day" }), 3042],
      ["a half rounds up: daily 6 is 182.5", sub("s6", { unit: 6, interval: "day" }), 183],
      [
        "3 seats of 5000 with 20% off",
        sub("s7", { unit: 5000, qty: 3, discounts: off({ percent_off: 20 }) }),
        12000,
      ],
      [
        "12000 with 20% tax included is 10000 net",
        sub("s8", { unit: 12000, tax: { behavior: "inclusive", pct: 20 } }),
        10000,
      ],
      [
        "5000 with 1000 off a period",
        sub("s9", { unit: 5000, discounts: off({ amount_off: 1000 }) }),
        4000,
      ],
      [
        "yearly 60000 with 12000 off a year",
        sub("s10", { unit: 60000, interval: "year", discounts: off({ amount_off: 12000 }) }),
        4000,
      ],
      [
        "a discount that applies once is not recurring",
        sub("s11", { unit: 5000, discounts: [{ coupon: { duration: "once", percent_off: 50 } }] }),
        5000,
      ],
      ["past due counts", sub("s12", { unit: 4900, status: "past_due" }), 4900],
      ["trialing does not", sub("s13", { unit: 4900, status: "trialing" }), 0],
      ["unpaid does not", sub("s14", { unit: 4900, status: "unpaid" }), 0],
      ["paused does not", sub("s15", { unit: 4900, status: "paused" }), 0],
      ["canceled does not", sub("s16", { unit: 4900, status: "canceled" }), 0],
      ["incomplete does not", sub("s17", { unit: 4900, status: "incomplete" }), 0],
      ["metered does not", sub("s18", { unit: 4900, usage: "metered" }), 0],
      ["free does not", sub("s19", { unit: 0 }), 0],
    ]
    for (const [name, obj, expected] of cases)
      expect({ name, mrr: mrrOf(obj) }).toEqual({ name, mrr: expected })
  })
})

describe("movements", () => {
  it("movements since the month start in the issuer's zone sum to the change, and a replayed event adds nothing", async () => {
    // Zone Pacific/Auckland (UTC+13 in November): the month began 2026-10-31T11:00Z.
    stored(sub("sub_1", { unit: 3000 }))
    stored(sub("sub_2", { unit: 2000 }))
    movement("sub_0", "2026-10-31T10:30:00.000Z", "new", 0, 1000) // 23:30 on 31 October there: last month
    movement("sub_1", "2026-10-31T11:30:00.000Z", "new", 0, 2000) // 00:30 on 1 November there, still October in UTC
    movement("sub_1", "2026-11-05T09:00:00.000Z", "upgrade", 2000, 2500)
    movement("sub_1", "2026-11-08T09:00:00.000Z", "downgrade", 2500, 2200)
    movement("sub_x", "2026-11-10T09:00:00.000Z", "cancelled", 700, 0)
    const out = (await mrrQuery({}, queryCtx())) as { lines: Array<Obj & { movements: Obj }> }
    expect(out.lines).toHaveLength(1)
    expect(out.lines[0]?.mrrMinor).toBe(5000)
    expect(out.lines[0]?.monthStart).toBe("2026-11-01")
    // new 2000, upgrade 500, downgrade -300, cancelled -700 = 1500; start = 5000 - 1500.
    expect(out.lines[0]?.movements).toEqual({
      newMinor: 2000,
      upgradeMinor: 500,
      downgradeMinor: -300,
      cancelledMinor: -700,
      netMinor: 1500,
      startMinor: 3500,
    })

    // The same event delivered twice changes the log once.
    db = new MemDb()
    connect()
    stored(sub("sub_u", { unit: 4900 }))
    movement("sub_u", "2026-11-02T00:00:00.000Z", "new", 0, 4900)
    api.objects.set("/v1/subscriptions/sub_u", { livemode: false, ...sub("sub_u", { unit: 9800 }) })
    const ev = webhook(
      "evt_up",
      "customer.subscription.updated",
      "sub_u",
      "2026-11-12T09:00:00.000Z",
    )
    await handleStripeEvent(ev, ingestCtx())
    await handleStripeEvent(ev, ingestCtx())
    const after = log("sub_u")
    expect(after).toHaveLength(2)
    expect(after[1]).toMatchObject({
      stripe_event_id: "evt_up",
      kind: "upgrade",
      delta_minor: 4900,
      before_minor: 4900,
      after_minor: 9800,
      source: "webhook",
    })
  })

  it("with no clock of its own, the month is the one the host's clock answers", async () => {
    // The host reads 3 March 2027 for an instant left unnamed; any named instant is converted as usual.
    const hostCivil = (p: { timezone: string; at?: string | number }) =>
      civil({ ...p, at: p.at ?? "2027-03-03T10:00:00.000Z" })
    stored(sub("sub_1", { unit: 3000 }))
    movement("sub_1", "2026-11-05T09:00:00.000Z", "new", 0, 3000)
    const out = (await mrrQuery({}, { db, time: { civil: hostCivil } })) as {
      lines: Array<Obj & { movements: Obj }>
    }
    expect(out.lines[0]?.monthStart).toBe("2027-03-01")
    // November's movement is before March: nothing moved this month.
    expect(out.lines[0]?.movements).toMatchObject({ newMinor: 0, netMinor: 0 })
  })

  it('past due and "without it" equal the rule; a trial conversion is new on conversion; a cancel at period end counts on its date; a second currency gets its own line', async () => {
    connect()
    stored(sub("sub_past", { unit: 4900, status: "past_due" }))
    stored(sub("sub_ok", { unit: 10000 }))
    stored(sub("sub_trial", { unit: 3000, status: "trialing" }))
    stored(sub("sub_end", { unit: 5000, cancelAt: sec("2026-11-20T00:00:00.000Z") }))
    stored(sub("sub_usd", { unit: 2000, currency: "usd" }))
    const first = (await mrrQuery({}, queryCtx())) as { lines: Array<Obj> }
    const eur = first.lines.find((l) => l.currency === "eur")
    const usd = first.lines.find((l) => l.currency === "usd")
    // 4900 + 10000 + 5000 counted; the trial is not. Without the past due one: 15000.
    expect(eur).toMatchObject({ mrrMinor: 19900, pastDueMinor: 4900, activeCount: 3 })
    expect((eur?.mrrMinor as number) - (eur?.pastDueMinor as number)).toBe(15000)
    expect(usd).toMatchObject({ mrrMinor: 2000, pastDueMinor: 0, activeCount: 1 })

    // The trial converts: a new movement of 3000 on that event's time.
    api.objects.set("/v1/subscriptions/sub_trial", {
      livemode: false,
      ...sub("sub_trial", { unit: 3000 }),
    })
    await handleStripeEvent(
      webhook("evt_conv", "customer.subscription.updated", "sub_trial", "2026-11-12T08:00:00.000Z"),
      ingestCtx(),
    )
    expect(log("sub_trial")).toHaveLength(1)
    expect(log("sub_trial")[0]).toMatchObject({
      kind: "new",
      delta_minor: 3000,
      at: "2026-11-12T08:00:00.000Z",
    })

    // The subscription set to end counted until its date; on that date it is a cancellation.
    api.objects.set("/v1/subscriptions/sub_end", {
      livemode: false,
      ...sub("sub_end", { unit: 5000, status: "canceled" }),
    })
    await handleStripeEvent(
      webhook("evt_end", "customer.subscription.deleted", "sub_end", "2026-11-20T00:00:00.000Z"),
      ingestCtx(),
    )
    expect(log("sub_end")[0]).toMatchObject({
      kind: "cancelled",
      delta_minor: -5000,
      after_minor: 0,
    })
    const later = (await mrrQuery({}, queryCtx())) as { lines: Array<Obj> }
    expect(later.lines.find((l) => l.currency === "eur")).toMatchObject({
      mrrMinor: 17900,
      activeCount: 3,
    })
  })

  it("a reconcile-healed change followed by the late webhook adds one movement", async () => {
    connect()
    stored(sub("sub_p", { unit: 4900 }))
    movement("sub_p", "2026-11-02T00:00:00.000Z", "new", 0, 4900)
    api.list("/v1/customers", [{ id: "cus_sub_p", object: "customer" }])
    stored(sub("sub_p", { unit: 4900 }), {}) // a second copy must not exist: replaced below
    db.tables.set("stripe_subscriptions", [db.rows("stripe_subscriptions")[0] as never])
    db.rows("stripe_customers").push({
      id: "m-c",
      stripe_id: "cus_sub_p",
      stripe_updated: "2026-11-01T00:00:00.000Z",
      deleted_at: null,
    })
    api.list("/v1/subscriptions", [sub("sub_p", { unit: 9800 })])
    lists()
    await runReconcile(syncCtx(), { now: () => new Date(clock) })
    expect(log("sub_p")).toHaveLength(2)
    expect(log("sub_p")[1]).toMatchObject({
      source: "reconcile",
      before_minor: 4900,
      after_minor: 9800,
    })
    // The webhook of that change arrives late: the stored amount is already 9800.
    await handleStripeEvent(
      webhook("evt_late", "customer.subscription.updated", "sub_p", "2026-11-14T09:00:00.000Z"),
      ingestCtx(),
    )
    expect(log("sub_p")).toHaveLength(2)
    expect(log("sub_p").reduce((s, r) => s + Number(r.delta_minor), 0)).toBe(9800)
  })

  it("a webhook followed by the reconcile that heals the same change adds one movement", async () => {
    connect()
    stored(sub("sub_q", { unit: 4900 }))
    movement("sub_q", "2026-11-02T00:00:00.000Z", "new", 0, 4900)
    api.objects.set("/v1/subscriptions/sub_q", { livemode: false, ...sub("sub_q", { unit: 9800 }) })
    await handleStripeEvent(
      webhook("evt_first", "customer.subscription.updated", "sub_q", "2026-11-14T09:00:00.000Z"),
      ingestCtx(),
    )
    api.list("/v1/customers", [{ id: "cus_sub_q", object: "customer" }])
    db.rows("stripe_customers").push({
      id: "m-c",
      stripe_id: "cus_sub_q",
      stripe_updated: "2026-11-01T00:00:00.000Z",
      deleted_at: null,
    })
    api.list("/v1/subscriptions", [sub("sub_q", { unit: 9800 })])
    lists()
    await runReconcile(syncCtx(), { now: () => new Date(clock) })
    expect(log("sub_q")).toHaveLength(2)
    expect(log("sub_q")[1]).toMatchObject({ stripe_event_id: "evt_first", source: "webhook" })
  })
})

describe("the nightly rebuild", () => {
  it('reconcile rebuilds lost movements within 30 days and older gaps read "Movements incomplete before"', async () => {
    connect()
    // Lost append: the mirror says 9800, the log stops at 4900, and Stripe's events say when it changed.
    stored(sub("sub_l", { unit: 9800 }))
    movement("sub_l", "2026-11-02T00:00:00.000Z", "new", 0, 4900)
    db.rows("stripe_customers").push({
      id: "m-c",
      stripe_id: "cus_sub_l",
      stripe_updated: "2026-11-01T00:00:00.000Z",
      deleted_at: null,
    })
    api.list("/v1/customers", [{ id: "cus_sub_l", object: "customer" }])
    api.list("/v1/subscriptions", [sub("sub_l", { unit: 9800 })])
    lists()
    api.events = [
      {
        id: "evt_a",
        type: "customer.subscription.created",
        created: sec("2026-11-02T00:00:00.000Z"),
        data: { object: sub("sub_l", { unit: 4900 }) },
      },
      {
        id: "evt_b",
        type: "customer.subscription.updated",
        created: sec("2026-11-10T00:00:00.000Z"),
        data: { object: sub("sub_l", { unit: 9800 }) },
      },
    ]
    const run = () => runReconcile(syncCtx(), { now: () => new Date(clock) })
    await run()
    expect(log("sub_l")).toHaveLength(2)
    expect(log("sub_l")[1]).toMatchObject({
      stripe_event_id: "evt_b",
      kind: "upgrade",
      delta_minor: 4900,
      at: "2026-11-10T00:00:00.000Z",
      source: "reconcile",
    })
    await run()
    expect(log("sub_l")).toHaveLength(2)

    // An event Stripe never delivered and no event explains: the heal alone brings it right, once.
    stored(sub("sub_m", { unit: 4900 }))
    movement("sub_m", "2026-11-02T00:00:00.000Z", "new", 0, 4900)
    db.rows("stripe_customers").push({
      id: "m-c2",
      stripe_id: "cus_sub_m",
      stripe_updated: "2026-11-01T00:00:00.000Z",
      deleted_at: null,
    })
    api.list("/v1/subscriptions", [sub("sub_l", { unit: 9800 }), sub("sub_m", { unit: 7000 })])
    await run()
    await run()
    expect(log("sub_m")).toHaveLength(2)
    expect(log("sub_m")[1]).toMatchObject({
      source: "reconcile",
      before_minor: 4900,
      after_minor: 7000,
    })

    // Down for longer than Stripe keeps events: the gap is recorded and the query says so.
    const coverage = db.rows("sync_state").find((r) => r.resource === "mrr_rebuild")
    expect(coverage).toBeDefined()
    Object.assign(coverage as object, { cursor: "2026-09-20T00:00:00.000Z" })
    await run()
    const out = (await mrrQuery({}, queryCtx())) as {
      note?: string
      movementsIncompleteBefore?: string
    }
    expect(out.movementsIncompleteBefore).toBe("2026-10-16")
    expect(out.note).toBe("Movements incomplete before 2026-10-16.")
  })
})

describe("the rebuild leaves covered changes alone", () => {
  it("an event older than the log's last movement is not written again", async () => {
    connect()
    stored(sub("sub_c", { unit: 9800 }))
    movement("sub_c", "2026-11-02T00:00:00.000Z", "new", 0, 4900)
    // The 7000 step on the 10th was lost, but the webhook of the 12th wrote 4900 to 9800 from the stored amount.
    movement("sub_c", "2026-11-12T00:00:00.000Z", "upgrade", 4900, 9800)
    db.rows("stripe_customers").push({
      id: "m-c",
      stripe_id: "cus_sub_c",
      stripe_updated: "2026-11-01T00:00:00.000Z",
      deleted_at: null,
    })
    api.list("/v1/customers", [{ id: "cus_sub_c", object: "customer" }])
    api.list("/v1/subscriptions", [sub("sub_c", { unit: 9800 })])
    lists()
    api.events = [
      {
        id: "evt_1",
        type: "customer.subscription.created",
        created: sec("2026-11-02T00:00:00.000Z"),
        data: { object: sub("sub_c", { unit: 4900 }) },
      },
      {
        id: "evt_2",
        type: "customer.subscription.updated",
        created: sec("2026-11-10T00:00:00.000Z"),
        data: { object: sub("sub_c", { unit: 7000 }) },
      },
      {
        id: "evt_3",
        type: "customer.subscription.updated",
        created: sec("2026-11-12T00:00:00.000Z"),
        data: { object: sub("sub_c", { unit: 9800 }) },
      },
    ]
    await runReconcile(syncCtx(), { now: () => new Date(clock) })
    expect(log("sub_c")).toHaveLength(2)
    expect(log("sub_c").reduce((s, r) => s + Number(r.delta_minor), 0)).toBe(9800)
  })
})

describe("the movement log", () => {
  it("the append-only table has no update path", () => {
    const dir = import.meta.dir
    const files = [
      ...readdirSync(dir),
      ...readdirSync(join(dir, "sync")).map((f) => join("sync", f)),
      ...readdirSync(join(dir, "tools")).map((f) => join("tools", f)),
    ]
    const sources = files.filter(
      (f) => f.endsWith(".ts") && !f.includes(".test") && !f.includes(".testkit"),
    )
    for (const f of sources) {
      if (f === join("sync", "maintenance.ts")) continue // removes every row of the app when the connection is removed
      const text = readFileSync(join(dir, f), "utf8")
      expect({ f, bad: /(update|updateMany|delete)\(\s*"stripe_mrr_events"/.test(text) }).toEqual({
        f,
        bad: false,
      })
    }
  })
})
