// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The card-payments stand-in: its answers in the processor's shape, its
// refusals by name, and its gates, proved at the wire.
//
// The answers are driven with an in-memory mirror and outside state; every
// object the stand-in returns is written back through the payments app's own
// row builders, which must give back the row it came from (so a reconcile over
// the stand-in changes nothing). The gates are driven through the real sandbox
// egress bridge with a recorder where the transport sits: "went out" and "did
// not go out" are read off that recorder.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { Hono } from "hono"
import { type AppEnv, app } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { LoadHarnessTestAccess, signHarnessRequest } from "~/lib/load-harness"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { DemoRestrictionError } from "~/modules/demo/demo-egress"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  customerRow,
  disputeRow,
  invoiceRow,
  newTally,
  paymentRow,
  refundRow,
  subscriptionRow,
} from "../../../../../../../../bundled-apps/stripe/src/mirror"
import { answerStandIn, type OutsideStore, type StandInDeps } from "./answer"
import { demoPaymentsHarnessRoutes } from "./harness-route"
import { ID } from "./objects"
import {
  countOutsideObjects,
  forgetDemoPaymentsOutside,
  outsideObject,
  putOutsideObjects,
} from "./overlay"
import { DEMO_PAYMENTS_SENTINEL_KEY } from "./sentinel"
import { DemoPaymentsStandInTestAccess } from "./standin"

type Obj = Record<string, unknown>

const HOST = "api.stripe.com"
const DECLARED = [HOST]
const CREATED = "created_at_stripe"

// ---------------------------------------------------------------------------
// The answers, on an in-memory mirror

const customers: Obj[] = Array.from({ length: 23 }, (_, i) => ({
  [ID]: `cus_standin${String(i).padStart(2, "0")}`,
  email: `billing${i}@client${i}.example`,
  name: `Client ${i}`,
  currency: "eur",
  delinquent: i === 3,
  address: {
    country: "FR",
    line1: `${i} rue Neuve`,
    line2: null,
    postal_code: "69001",
    city: "Lyon",
  },
  tax_ids: i === 0 ? [{ type: "eu_vat", value: "FR40902000009" }] : null,
  deleted_at: null,
  [CREATED]: new Date(Date.UTC(2026, 0, 1 + i, 9)).toISOString(),
}))
const subscription: Obj = {
  [ID]: "sub_standin01",
  customer_id: "cus_standin01",
  status: "active",
  plan_name: "Team",
  items: [
    {
      price_id: "price_team",
      product_name: "Team",
      unit_amount: 49000,
      currency: "eur",
      interval: "month",
      interval_count: 1,
      quantity: 1,
      usage_type: "licensed",
      tax_behavior: "exclusive",
      tax_percent: 20,
    },
  ],
  discount_percent: 10,
  discount_amount_minor: null,
  mrr_minor: 44100,
  currency: "eur",
  current_period_start: "2026-11-01T00:00:00.000Z",
  current_period_end: "2026-12-01T00:00:00.000Z",
  trial_end: null,
  cancel_at: null,
  canceled_at: null,
}
const invoice: Obj = {
  [ID]: "in_standin01",
  customer_id: "cus_standin01",
  subscription_id: "sub_standin01",
  number: "TF-0042",
  status: "open",
  total_minor: 52920,
  tax_minor: 8820,
  amount_paid_minor: 0,
  amount_due_minor: 52920,
  currency: "eur",
  period_start: "2026-11-01T00:00:00.000Z",
  period_end: "2026-12-01T00:00:00.000Z",
  billing_reason: "subscription_cycle",
  hosted_invoice_url: "https://billing.payments-standin.example/i/in_standin01",
  next_payment_attempt: "2026-11-14T00:00:00.000Z",
  finalized_at: "2026-11-01T01:00:00.000Z",
  paid_at: null,
}
const charge: Obj = {
  [ID]: "ch_standin01",
  payment_intent: "pi_standin01",
  invoice_id: "in_standin01",
  customer_id: "cus_standin01",
  amount_minor: 52920,
  refunded_minor: 0,
  currency: "eur",
  status: "succeeded",
  failure_code: null,
  failure_message: null,
  card_brand: "visa",
  card_last4: "4242",
  card_exp: "04/29",
  [CREATED]: "2026-11-01T01:01:00.000Z",
  disputed: false,
}
const refund: Obj = {
  [ID]: "re_standin01",
  payment_id: "ch_standin01",
  amount_minor: 1000,
  currency: "eur",
  status: "succeeded",
  reason: "requested_by_customer",
  [CREATED]: "2026-11-02T10:00:00.000Z",
}
const dispute: Obj = {
  [ID]: "dp_standin01",
  payment_id: "ch_standin01",
  amount_minor: 52920,
  currency: "eur",
  reason: "fraudulent",
  status: "needs_response",
  evidence_due_by: "2026-11-20T23:59:59.000Z",
  [CREATED]: "2026-11-05T10:00:00.000Z",
}

const TABLES: Record<string, Obj[]> = {
  customers,
  subscriptions: [subscription],
  invoices: [invoice],
  payments: [charge],
  refunds: [refund],
  disputes: [dispute],
}

function memoryOutside(): OutsideStore & { objects: Map<string, Obj> } {
  const objects = new Map<string, Obj>()
  const idem = new Map<string, string>()
  return {
    objects,
    get: async (id) => objects.get(id) ?? null,
    ofKind: async (kind) => [...objects.values()].filter((o) => o.object === kind),
    put: async (list) => {
      for (const o of list) objects.set(String(o.id), structuredClone(o))
    },
    idempotent: async (k) => idem.get(k) ?? null,
    remember: async (k, id) => {
      idem.set(k, id)
    },
  }
}

class Refused extends Error {}

function deps(outside = memoryOutside(), delivered: Array<[string, Obj]> = []): StandInDeps {
  let n = 0
  return {
    mirror: {
      rows: async (t) => TABLES[t] ?? [],
      row: async (t, id) => (TABLES[t] ?? []).find((r) => r[ID] === id) ?? null,
      install: async () => ({
        account_id: "acct_standin",
        account_name: "Stand-in",
        livemode: false,
      }),
    },
    outside,
    deliver: (type, obj) => {
      delivered.push([type, obj])
    },
    refuse: (what) => new Refused(`not modelled: ${what}`),
    now: () => new Date("2026-11-11T09:00:00Z"),
    newId: (p) => `${p}_new${++n}`,
  }
}

async function call(
  d: StandInDeps,
  path: string,
  method = "GET",
  body?: string,
  idempotencyKey: string | null = null,
) {
  const res = await answerStandIn(
    { method, url: new URL(`https://${HOST}${path}`), body, idempotencyKey },
    d,
  )
  return { status: res.status, body: (await res.json()) as Obj }
}

describe("the stand-in's answers", () => {
  it("a list read pages through the org's mirror rows in the processor's shape", async () => {
    const d = deps()
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const q: string = `/v1/customers?limit=10${cursor ? `&starting_after=${cursor}` : ""}`
      const { status, body } = await call(d, q)
      expect(status).toBe(200)
      expect(body.object).toBe("list")
      const data = body.data as Obj[]
      pages++
      for (const o of data) {
        expect(o.object).toBe("customer")
        expect(o.livemode).toBe(false)
        seen.push(String(o.id))
      }
      if (!body.has_more) break
      cursor = String(data[data.length - 1]?.id)
    }
    expect(pages).toBe(3)
    expect(seen).toHaveLength(23)
    expect(new Set(seen).size).toBe(23)
    // Newest first, as the processor lists.
    expect(seen[0]).toBe("cus_standin22")

    // Each object written back through the app's own row builders is the row it came from.
    const builders: Array<[string, string, (o: Obj) => Obj]> = [
      ["customers", "/v1/customers/", (o) => customerRow(o, newTally())],
      [
        "subscriptions",
        "/v1/subscriptions/",
        (o) => subscriptionRow(o, newTally(), new Date("2026-11-11T09:00:00Z")),
      ],
      ["invoices", "/v1/invoices/", (o) => invoiceRow(o, newTally())],
      ["payments", "/v1/charges/", (o) => paymentRow(o, newTally())],
      ["refunds", "/v1/refunds/", (o) => refundRow(o, newTally())],
      ["disputes", "/v1/disputes/", (o) => disputeRow(o, newTally())],
    ]
    for (const [table, path, build] of builders) {
      for (const row of TABLES[table] ?? []) {
        const { status, body } = await call(d, `${path}${String(row[ID])}`)
        expect(status).toBe(200)
        const back = build(body)
        const expected: Obj = {}
        for (const k of Object.keys(back)) expected[k] = row[k] === undefined ? back[k] : row[k]
        expect({ table, row: back }).toEqual({ table, row: expected })
      }
    }

    // An unknown id is the processor's 404, never an empty object.
    expect((await call(d, "/v1/customers/cus_nobody")).status).toBe(404)
    // The account is the install's.
    expect((await call(d, "/v1/account")).body).toMatchObject({
      id: "acct_standin",
      object: "account",
    })
    // Filters the app sends are honoured.
    const subs = await call(d, "/v1/subscriptions?status=all&expand[0]=data.discounts&limit=100")
    expect((subs.body.data as Obj[]).map((s) => s.id)).toEqual(["sub_standin01"])
    const refunds = await call(d, "/v1/refunds?charge=ch_standin01&limit=100")
    expect((refunds.body.data as Obj[]).map((r) => r.id)).toEqual(["re_standin01"])
  })

  it("an unmodelled path is refused by name, never answered empty", async () => {
    const d = deps()
    for (const [method, path] of [
      ["GET", "/v1/payouts"],
      ["GET", "/v1/balance"],
      ["POST", "/v1/billing_portal/sessions"],
      ["POST", "/v1/customers"],
      ["DELETE", "/v1/subscriptions/sub_standin01"],
      ["GET", "/v1/customers?created_by=me"],
    ] as const) {
      let refused: unknown = null
      let answered: unknown = null
      try {
        answered = await call(d, path, method)
      } catch (err) {
        refused = err
      }
      expect({ method, path, answered }).toEqual({ method, path, answered: null })
      expect(refused).toBeInstanceOf(Refused)
      expect(String((refused as Error).message)).toContain(path.split("?")[0] as string)
    }
  })

  it("a refund is written to the outside state, answered once per idempotency key, and delivered as the charge's refund event", async () => {
    const outside = memoryOutside()
    const delivered: Array<[string, Obj]> = []
    const d = deps(outside, delivered)
    const body =
      "charge=ch_standin01&amount=2000&reason=requested_by_customer&metadata[liaison_approval_id]=apr_1"
    const first = await call(d, "/v1/refunds", "POST", body, "apr_1")
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({
      object: "refund",
      charge: "ch_standin01",
      amount: 2000,
      status: "succeeded",
    })
    const again = await call(d, "/v1/refunds", "POST", body, "apr_1")
    expect(again.body.id).toBe(first.body.id)
    expect(delivered.map(([t]) => t)).toEqual(["charge.refunded"])
    const chargeNow = await call(d, "/v1/charges/ch_standin01")
    expect(chargeNow.body.amount_refunded).toBe(2000)
    const listed = await call(d, "/v1/refunds?charge=ch_standin01&limit=100")
    const mine = (listed.body.data as Obj[]).find(
      (r) => (r.metadata as Obj)?.liaison_approval_id === "apr_1",
    )
    expect(mine?.id).toBe(first.body.id)
    // More than is left is the processor's own refusal; the permission probe's unknown charge is a 404.
    expect((await call(d, "/v1/refunds", "POST", "charge=ch_standin01&amount=999999")).status).toBe(
      400,
    )
    expect((await call(d, "/v1/refunds", "POST", "charge=ch_liaison_probe")).status).toBe(404)
  })

  it("cancel at period end is written to the outside state and delivered as the subscription's update", async () => {
    const outside = memoryOutside()
    const delivered: Array<[string, Obj]> = []
    const d = deps(outside, delivered)
    const res = await call(
      d,
      "/v1/subscriptions/sub_standin01",
      "POST",
      "cancel_at_period_end=true",
    )
    expect(res.body).toMatchObject({
      cancel_at_period_end: true,
      cancel_at: Date.UTC(2026, 11, 1) / 1000,
    })
    expect(delivered.map(([t]) => t)).toEqual(["customer.subscription.updated"])
    expect(
      subscriptionRow((await call(d, "/v1/subscriptions/sub_standin01")).body, newTally())
        .cancel_at,
    ).toBe("2026-12-01T00:00:00.000Z")
    // The app's permission probe on an unknown subscription is a 404.
    expect((await call(d, "/v1/subscriptions/sub_liaison_probe", "POST", "")).status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// The gates, at the wire

let onTheWire: string[] = []

function sandboxFetch(orgId: string, userId: string, appName = "stripe") {
  const methods = createEgressMethods({
    orgId,
    userId,
    appName,
    actorType: "user",
    egress: async () => ({ allowedDomains: DECLARED, manifest: { name: appName } }),
    callerScopes: [],
    inheritedActor: { actorType: "user" as const },
    manifest: { name: appName },
    txDb: null,
    resolveCredentials: async () => ({}),
  } as unknown as BridgeContext)
  return async (path: string, key: string) => {
    const raw = (await methods.fetch(
      `https://${HOST}${path}`,
      JSON.stringify({ method: "GET", headers: { Authorization: `Bearer ${key}` } }),
    )) as string
    const envelope = JSON.parse(raw) as { status: number; body: string }
    return { status: envelope.status, body: JSON.parse(envelope.body) as Obj }
  }
}

describe("the stand-in's gates", () => {
  let demoOrgId: string
  let normalOrgId: string
  let demoUserId: string
  let normalUserId: string

  beforeAll(async () => {
    await acquireTestLock()
    demoOrgId = (await ensureOrg({ slug: "payments-standin-demo", name: "Stand-in Demo" })).orgId
    normalOrgId = (await ensureOrg({ slug: "payments-standin-normal", name: "Stand-in Normal" }))
      .orgId
    const user = async (orgId: string, email: string) =>
      (await ensureUser({ orgId, email, name: "Admin", password: "Passw0rd!", role: "admin" }))
        .userId
    demoUserId = await user(demoOrgId, "standin-demo@example.com")
    normalUserId = await user(normalOrgId, "standin-normal@example.com")
    await markOrgAsDemo(demoOrgId, visitorMarker(24))
    // The unit database holds no app schemas: the stand-in reads an empty mirror here
    // (its reads of a real mirror are in the integration file).
    DemoPaymentsStandInTestAccess.setMirror(() => ({
      rows: async () => [],
      row: async () => null,
      install: async () => ({ livemode: false }),
    }))
    SandboxBridgeTestAccess.setFetchInterceptsHost(() => true)
    SandboxBridgeTestAccess.setFetch((async (input: unknown) => {
      onTheWire.push(String(input))
      return new Response(
        JSON.stringify({ object: "list", data: [{ id: "cus_REAL" }], has_more: false }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }) as unknown as typeof fetch)
  })

  afterAll(async () => {
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    DemoModeTestAccess.set(null)
    LoadHarnessTestAccess.setKey(undefined)
    DemoPaymentsStandInTestAccess.setMirror()
    await forgetDemoPaymentsOutside(demoOrgId)
    await releaseTestLock()
  })

  afterEach(() => {
    onTheWire = []
    invalidateDemoMarker()
  })

  it("a non-demo org's call goes to the wire untouched", async () => {
    for (const demo of [false, true]) {
      DemoModeTestAccess.set(demo)
      const before = env.LIAISON_DEMO_PAYMENTS_FIXTURES
      env.LIAISON_DEMO_PAYMENTS_FIXTURES = demo
      try {
        const res = await sandboxFetch(normalOrgId, normalUserId)(
          "/v1/customers?limit=1",
          "rk_test_customerOwnKey",
        )
        expect(res.body.data).toEqual([{ id: "cus_REAL" }])
      } finally {
        env.LIAISON_DEMO_PAYMENTS_FIXTURES = before
      }
    }
    expect(onTheWire).toEqual([
      `https://${HOST}/v1/customers?limit=1`,
      `https://${HOST}/v1/customers?limit=1`,
    ])
  })

  it("a demo org's sentinel call is answered by the stand-in and never reaches the wire, with demo mode or the QA flag", async () => {
    for (const [demo, flag] of [
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      DemoModeTestAccess.set(demo)
      const before = env.LIAISON_DEMO_PAYMENTS_FIXTURES
      env.LIAISON_DEMO_PAYMENTS_FIXTURES = flag
      try {
        const res = await sandboxFetch(demoOrgId, demoUserId)(
          "/v1/customers/cus_nobody",
          DEMO_PAYMENTS_SENTINEL_KEY,
        )
        expect({ demo, flag, status: res.status }).toEqual({ demo, flag, status: 404 })
      } finally {
        env.LIAISON_DEMO_PAYMENTS_FIXTURES = before
      }
    }
    expect(onTheWire).toEqual([])
  })

  it("a real key in a demo org is refused with the connector sentence and never sent", async () => {
    DemoModeTestAccess.set(true)
    let refused: unknown = null
    try {
      await sandboxFetch(demoOrgId, demoUserId)(
        "/v1/customers?limit=1",
        `rk_live_${"aRealRestrictedKey123"}`,
      )
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(DemoRestrictionError)
    expect((refused as DemoRestrictionError).message).toContain(
      "cannot store real connector credentials",
    )
    expect(onTheWire).toEqual([])
  })

  it("a demo org's call to the payments host from any app is refused on every box and never sent", async () => {
    for (const appName of ["api-connector", "stripe"]) {
      for (const flag of [true, false]) {
        DemoModeTestAccess.set(false)
        const before = env.LIAISON_DEMO_PAYMENTS_FIXTURES
        env.LIAISON_DEMO_PAYMENTS_FIXTURES = flag
        let refused: unknown = null
        try {
          await sandboxFetch(
            demoOrgId,
            demoUserId,
            appName,
          )("/v1/customers?limit=1", `rk_live_${"aRealRestrictedKey123"}`)
        } catch (err) {
          refused = err
        } finally {
          env.LIAISON_DEMO_PAYMENTS_FIXTURES = before
        }
        expect({ appName, flag, refused: refused instanceof DemoRestrictionError }).toEqual({
          appName,
          flag,
          refused: true,
        })
      }
    }
    expect(onTheWire).toEqual([])
  })

  it("a non-demo org's call to the payments host from another app goes to the wire", async () => {
    DemoModeTestAccess.set(false)
    const res = await sandboxFetch(
      normalOrgId,
      normalUserId,
      "api-connector",
    )("/v1/customers?limit=1", "rk_test_customerOwnKey")
    expect(res.body.data).toEqual([{ id: "cus_REAL" }])
    expect(onTheWire).toEqual([`https://${HOST}/v1/customers?limit=1`])
  })

  it("a sentinel request from an org without the demo marker is refused, never forwarded", async () => {
    DemoModeTestAccess.set(false)
    const res = await sandboxFetch(normalOrgId, normalUserId)(
      "/v1/customers?limit=1",
      DEMO_PAYMENTS_SENTINEL_KEY,
    )
    expect(res.status).toBe(403)
    expect(onTheWire).toEqual([])
  })

  it("an unmodelled path from a demo org is refused by name through the demo refusal", async () => {
    DemoModeTestAccess.set(true)
    let refused: unknown = null
    try {
      await sandboxFetch(demoOrgId, demoUserId)("/v1/payouts", DEMO_PAYMENTS_SENTINEL_KEY)
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(DemoRestrictionError)
    expect((refused as DemoRestrictionError).code).toBe("DEMO_RESTRICTED")
    expect((refused as DemoRestrictionError).message).toContain("/v1/payouts")
    expect(onTheWire).toEqual([])
  })

  it("a visitor replacing the payments key is refused with the connector sentence", async () => {
    DemoModeTestAccess.set(true)
    let refused: unknown = null
    try {
      await withPrivilegedDb(demoOrgId, "standin-replace-key", (tx) =>
        createCredentialConnection(tx, demoOrgId, demoUserId, "stripe", "stripe", {
          identifier: "replaced",
          ownerType: "org",
          credentials: { restrictedKey: `rk_live_${"aRealRestrictedKey123"}` },
        }),
      )
    } catch (err) {
      refused = err
    }
    expect(refused).toBeInstanceOf(DemoRestrictionError)
    expect((refused as Error).message).toContain("cannot store real connector credentials")
  })

  it("an outside object written by one process is read by another", async () => {
    await forgetDemoPaymentsOutside(demoOrgId)
    const script = `
      import { putOutsideObjects } from "${import.meta.dir}/overlay"
      await putOutsideObjects(String(process.env.STANDIN_ORG), [{ id: "in_outside01", object: "invoice", status: "paid", total: 100 }])
      process.exit(0)
    `
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: `${import.meta.dir}/../../../../../..`,
      env: { ...process.env, STANDIN_ORG: demoOrgId },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(await child.exited).toBe(0)
    expect(await outsideObject(demoOrgId, "in_outside01")).toMatchObject({
      status: "paid",
      total: 100,
    })
    await forgetDemoPaymentsOutside(demoOrgId)
    expect(await countOutsideObjects(demoOrgId)).toBe(0)
  })

  it("an outside object holding a key-shaped string is refused before anything is stored", async () => {
    await expect(
      putOutsideObjects(demoOrgId, [
        { id: "cus_bad", object: "customer", note: `sk_live_${"abcdefghijkl"}` },
      ]),
    ).rejects.toThrow(/key-shaped/)
    expect(await countOutsideObjects(demoOrgId)).toBe(0)
  })

  it("the outside-state route is not mounted without the flag", () => {
    expect(env.LIAISON_DEMO_PAYMENTS_FIXTURES).toBe(false)
    expect(app.routes.filter((r) => r.path.startsWith("/api/demo-payments"))).toEqual([])
  })

  it("the outside-state route answers 404 without the flag, without a signature or for a non-demo org", async () => {
    // Mounted as app.ts mounts it on a box with the flag set at boot; the
    // route still checks the flag on every request.
    const mounted = new Hono<AppEnv>().route("/api/demo-payments", demoPaymentsHarnessRoutes)
    const key = randomBytes(32).toString("hex")
    LoadHarnessTestAccess.setKey(key)
    const send = async (orgId: string, signed: boolean) => {
      const body = JSON.stringify({
        orgId,
        objects: [{ id: "ch_outside01", object: "charge", status: "succeeded" }],
      })
      const timestamp = Date.now()
      const nonce = randomBytes(16).toString("hex")
      const path = "/api/demo-payments/outside"
      const headers: Record<string, string> = { "content-type": "application/json" }
      if (signed) {
        headers["x-liaison-harness-timestamp"] = String(timestamp)
        headers["x-liaison-harness-nonce"] = nonce
        headers["x-liaison-harness-signature"] = signHarnessRequest(
          { method: "POST", path, timestamp, nonce, body },
          key,
        )
      }
      return (await mounted.request(path, { method: "POST", headers, body })).status
    }
    const before = env.LIAISON_DEMO_PAYMENTS_FIXTURES
    try {
      env.LIAISON_DEMO_PAYMENTS_FIXTURES = false
      expect(await send(demoOrgId, true)).toBe(404)
      env.LIAISON_DEMO_PAYMENTS_FIXTURES = true
      expect(await send(demoOrgId, false)).toBe(404)
      expect(await send(normalOrgId, true)).toBe(404)
      expect(await outsideObject(demoOrgId, "ch_outside01")).toBeNull()
      expect(await send(demoOrgId, true)).toBe(200)
      expect(await outsideObject(demoOrgId, "ch_outside01")).toMatchObject({ status: "succeeded" })
    } finally {
      env.LIAISON_DEMO_PAYMENTS_FIXTURES = before
      await forgetDemoPaymentsOutside(demoOrgId)
    }
  })
})
