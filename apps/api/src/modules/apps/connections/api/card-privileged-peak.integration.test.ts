// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The api's privileged-pool floor (db/pool-plan.ts API_PRIVILEGED_FLOOR),
// measured: one person opening one conversation fires the conversation's reads
// and the customer card's two requests at once, through the real auth
// middleware. This counts the privileged slots they hold at once, how long each
// acquisition waits and holds, and whether any is nested (an acquisition made
// while the same call already holds a privileged slot), for both connector
// transports: the demo's in-process fixture CRM and plain HTTP.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as dnsPromises from "node:dns/promises"
import { type Adapter, validateAdapter } from "@liaison/api-connector-core"
import { app } from "~/app"
import { createPool } from "~/db/connection"
import { nestedPrivilegedAcquisitions } from "~/db/pool-diag"
import { API_PRIVILEGED_FLOOR } from "~/db/pool-plan"
import {
  type PrivilegedAcquisition,
  PrivilegedDbTestAccess,
  withPrivilegedDb,
} from "~/db/privileged"
import { env } from "~/lib/env"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import {
  registerApiConnectorApp,
  testApiConn,
} from "~/modules/apps/connections/api/app.test-helpers"
import { invalidateConnectionCaches } from "~/modules/apps/connections/api/cache"
import { upsertAdapterRow } from "~/modules/apps/connections/api/store"
import { createCredentialConnection } from "~/modules/apps/connections/service"
import {
  DEMO_API_CONNECTOR_IDENTIFIER,
  installDemoApiConnectorConnection,
} from "~/modules/demo/api-connector"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

/** Upstream latency of the plain-HTTP CRM: a card's calls overlap as they do against a real API. */
const UPSTREAM_MS = 150

const CRM: Adapter = (() => {
  const op = (name: string, role: string, path: string, fields: string[], extra = {}) => ({
    name,
    description: name,
    kind: "read",
    method: "GET",
    path,
    params: {
      type: "object",
      properties: { customerId: { type: "string" } },
      required: ["customerId"],
    },
    items: "/data",
    fields,
    role,
    ...extra,
  })
  const r = validateAdapter({
    id: "crm",
    name: "Fixture CRM",
    version: "1",
    baseUrl: "https://crm.example.com",
    auth: { type: "bearer" },
    operations: [
      {
        ...op("find", "customer.lookup", "/companies", ["id", "name"], {
          query: { email: "{email}" },
        }),
        params: { type: "object", properties: { email: { type: "string" } } },
      },
      op("summary", "customer.summary", "/companies/{customerId}", ["tier"], { items: "" }),
      op("orders", "customer.orders", "/companies/{customerId}/orders", ["id"]),
      op("invoices", "customer.invoices", "/companies/{customerId}/invoices", ["id"]),
      op("deals", "deal.list", "/companies/{customerId}/deals", ["id"]),
    ],
  })
  if (!r.ok) throw new Error(JSON.stringify(r.issues))
  return r.adapter
})()

interface View {
  name: string
  orgId: string
  token: string
  threadId: string
  email: string
}

let plain: View
let demo: View
let lookupSpy: ReturnType<typeof spyOn>

async function viewer(name: string): Promise<{ orgId: string; userId: string; view: View }> {
  const { orgId, adminUserId } = await minimal.secondOrg()
  const threadId = await minimal.thread(orgId, adminUserId)
  const token = await minimal.token(adminUserId)
  return { orgId, userId: adminUserId, view: { name, orgId, token, threadId, email: "" } }
}

/** What one conversation view sends at once: the conversation's reads and the customer card's two. */
async function openConversation(v: View): Promise<number[]> {
  const get = async (path: string) => {
    const res = await app.request(path, { headers: { Authorization: `Bearer ${v.token}` } })
    await res.arrayBuffer()
    return res.status
  }
  // The app's settings list and its customer card: tools of the app, run in its sandbox.
  const tool = async (name: string, params: Record<string, unknown>) => {
    const res = await app.request(`/api/apps/api-connector/tools/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${v.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(params),
    })
    await res.arrayBuffer()
    return res.status
  }
  return Promise.all([
    get(`/api/threads/${v.threadId}`),
    get(`/api/threads/${v.threadId}/messages`),
    tool("settings_connections", {}),
    tool("customer_lookup", { email: v.email }),
  ])
}

async function forgetLookups(): Promise<void> {
  await invalidateConnectionCaches(testApiConn(plain.orgId), "crm")
  await invalidateConnectionCaches(testApiConn(demo.orgId), DEMO_API_CONNECTOR_IDENTIFIER)
}

function summarize(acq: PrivilegedAcquisition[]) {
  const holds = acq.map((a) => a.holdMs).sort((a, b) => a - b)
  const waits = acq.map((a) => a.waitMs).sort((a, b) => a - b)
  const round = (n: number | undefined) => Math.round((n ?? 0) * 10) / 10
  return {
    acquisitions: acq.length,
    holdP50Ms: round(holds[Math.floor(holds.length / 2)]),
    holdMaxMs: round(holds.at(-1)),
    waitMaxMs: round(waits.at(-1)),
    nested: acq.filter((a) => a.nested).map((a) => a.reason),
    longest: acq
      .slice()
      .sort((a, b) => b.holdMs - a.holdMs)
      .slice(0, 3)
      .map((a) => `${a.reason} ${round(a.holdMs)}ms`),
  }
}

beforeAll(async () => {
  await acquireTestLock()
  const p = await viewer("plain")
  plain = { ...p.view, email: "jane@acme.test" }
  await registerApiConnectorApp(p.orgId)
  await upsertAdapterRow(testApiConn(p.orgId), "crm", CRM, p.userId)
  await withPrivilegedDb(p.orgId, "card-peak-test", (tx) =>
    createCredentialConnection(tx, p.orgId, p.userId, "api-connector", "api", {
      identifier: "crm",
      credentials: { token: "tok-crm" },
      ownerType: "org",
    }),
  )
  const d = await viewer("demo")
  demo = { ...d.view, email: "jane.doe@acme-instruments.example" }
  await registerApiConnectorApp(d.orgId)
  await markOrgAsDemo(d.orgId, visitorMarker(24))
  DemoModeTestAccess.set(true)
  invalidateDemoMarker()
  await installDemoApiConnectorConnection({ orgId: d.orgId, createdByUserId: d.userId })
}, 180_000)

afterAll(async () => {
  PrivilegedDbTestAccess.usePool(null)
  DemoModeTestAccess.set(null)
  invalidateDemoMarker()
  await releaseTestLock()
})

beforeEach(async () => {
  lookupSpy = spyOn(dnsPromises, "lookup").mockImplementation((async () => [
    { address: "93.184.216.34", family: 4 },
  ]) as never)
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request) => {
    const url = new URL(String(input))
    await new Promise((r) => setTimeout(r, UPSTREAM_MS))
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    if (url.pathname === "/companies") {
      // Three matches: the most a card follows per connection (customer.ts).
      return json({ data: ["c1", "c2", "c3"].map((id) => ({ id, name: id })) })
    }
    if (/^\/companies\/c\d$/.test(url.pathname)) return json({ tier: "gold" })
    return json({ data: [{ id: "x1" }] })
  }) as typeof fetch)
  await forgetLookups()
})

// The suite may run strict already: put back whatever was there before each case.
let strictBefore: string | undefined
beforeEach(() => {
  strictBefore = process.env.NESTED_PRIVILEGED_STRICT
})

afterEach(() => {
  OutboundFetchTestAccess.setFetch(null)
  lookupSpy.mockRestore()
  if (strictBefore === undefined) delete process.env.NESTED_PRIVILEGED_STRICT
  else process.env.NESTED_PRIVILEGED_STRICT = strictBefore
})

describe("one conversation view with its customer card", () => {
  for (const which of ["plain", "demo"] as const) {
    it(`holds at most API_PRIVILEGED_FLOOR privileged slots at once, none nested (${which} transport)`, async () => {
      const v = which === "plain" ? plain : demo
      process.env.NESTED_PRIVILEGED_STRICT = "1"
      const nestedBefore = nestedPrivilegedAcquisitions()
      PrivilegedDbTestAccess.resetPeak()
      PrivilegedDbTestAccess.record()
      const statuses = await openConversation(v)
      const acq = PrivilegedDbTestAccess.recorded()
      const peak = PrivilegedDbTestAccess.peak()
      console.log(
        `[card-privileged-peak] ${which}: peak ${peak} privileged slots`,
        JSON.stringify(summarize(acq)),
      )
      expect(statuses).toEqual([200, 200, 200, 200])
      expect(peak).toBeLessThanOrEqual(API_PRIVILEGED_FLOOR)
      expect(nestedPrivilegedAcquisitions() - nestedBefore).toBe(0)
    }, 60_000)
  }
})

describe("two views at once on the api's privileged pool", () => {
  const ten = createPool(API_PRIVILEGED_FLOOR)
  const three = createPool(3)
  afterAll(async () => {
    PrivilegedDbTestAccess.usePool(null)
    await ten.client.end()
    await three.client.end()
  })

  async function twoViewsOn(pool: ReturnType<typeof createPool>, size: number) {
    // Every connection of the pool is open before the views start. A fresh pool connects on
    // first use, one login (and its SCRAM proof, worked out on this event loop) per slot, so a
    // busy process staggers the first transactions by its connect times, and the peak measured
    // how fast it logs in rather than what the two views ask for at once.
    const warm = await Promise.all(Array.from({ length: size }, () => pool.client.reserve()))
    for (const conn of warm) conn.release()
    await forgetLookups()
    PrivilegedDbTestAccess.usePool({ db: pool.db, acquireTimeoutMs: env.DB_ACQUIRE_TIMEOUT_MS })
    PrivilegedDbTestAccess.resetPeak()
    PrivilegedDbTestAccess.record()
    const started = performance.now()
    let statuses: number[][]
    try {
      statuses = await Promise.all([openConversation(plain), openConversation(demo)])
    } finally {
      PrivilegedDbTestAccess.usePool(null)
    }
    const acq = PrivilegedDbTestAccess.recorded()
    const elapsedMs = performance.now() - started
    const peak = PrivilegedDbTestAccess.peak()
    const waitTotalMs = acq.reduce((n, a) => n + a.waitMs, 0)
    console.log(
      `[card-privileged-peak] two views on ${size}: peak ${peak}, ${Math.round(elapsedMs)}ms, waits ${Math.round(waitTotalMs)}ms`,
      JSON.stringify(summarize(acq)),
    )
    return { statuses, elapsedMs, peak, waitTotalMs }
  }

  // Measured (holds of 3-55 ms, no nested acquisition): the card's privileged
  // work is many short transactions, so a small pool queues them rather than
  // deadlocking. Since the card runs as the app's tools (each call a sandboxed
  // run around short platform reads), two views want 3 to 4 slots at once: the
  // floor of 10 keeps room beside them for auth checks and other requests, and
  // a pool of 3 still serves both views, its callers queueing behind each other.
  it("complete within DB_ACQUIRE_TIMEOUT_MS on a pool of API_PRIVILEGED_FLOOR, and on a pool of 3", async () => {
    const roomy = await twoViewsOn(ten, API_PRIVILEGED_FLOOR)
    expect(roomy.statuses).toEqual([
      [200, 200, 200, 200],
      [200, 200, 200, 200],
    ])
    expect(roomy.elapsedMs).toBeLessThan(env.DB_ACQUIRE_TIMEOUT_MS)
    expect(roomy.peak).toBeLessThan(API_PRIVILEGED_FLOOR)

    const tight = await twoViewsOn(three, 3)
    expect(tight.statuses).toEqual(roomy.statuses)
    expect(tight.elapsedMs).toBeLessThan(env.DB_ACQUIRE_TIMEOUT_MS)
    expect(tight.peak).toBeLessThanOrEqual(3)
  }, 90_000)
})
