// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type ConnectionCtx,
  decodeState,
  encodeState,
  PERMISSION_READS,
  REFUND_PROBE_CHARGE,
  runConnectionCheck,
  transition,
} from "./connection"
import { STRIPE_API_VERSION } from "./http"

type Answer = { status: number; body?: unknown }
type Call = { method: string; path: string; body?: string }

/** A Stripe stand-in: answers per path, records every call, refuses a call without the pinned version. */
function fakeStripe(overrides: Record<string, Answer> = {}, livemode = false) {
  const calls: Call[] = []
  const fetch: ConnectionCtx["fetch"] = async (url, opts) => {
    const u = new URL(url)
    const method = opts?.method ?? "GET"
    calls.push({ method, path: u.pathname, body: opts?.body })
    if (opts?.headers?.["Stripe-Version"] !== STRIPE_API_VERSION) {
      return { status: 400, headers: {}, body: "{}" }
    }
    const a = overrides[`${method} ${u.pathname}`]
    if (a)
      return {
        status: a.status,
        headers: {},
        body: JSON.stringify(a.body ?? { error: { message: "x" } }),
      }
    if (method === "POST" && u.pathname === "/v1/refunds") {
      return {
        status: 404,
        headers: {},
        body: JSON.stringify({ error: { code: "resource_missing" } }),
      }
    }
    if (method === "GET" && u.pathname.split("/").length === 3) {
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ object: "list", data: [{ id: "x_1", livemode }] }),
      }
    }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify({ id: u.pathname.split("/").pop(), livemode }),
    }
  }
  return { fetch, calls }
}

function memDb(seed: Record<string, Array<Record<string, unknown>>> = {}) {
  const tables: Record<string, Array<Record<string, unknown>>> = structuredClone(seed)
  let n = 0
  return {
    tables,
    db: {
      async findMany(entity: string, opts?: { limit?: number }) {
        return (tables[entity] ?? []).slice(0, opts?.limit ?? 1000)
      },
      async insert(entity: string, data: Record<string, unknown>) {
        const id = `row_${++n}`
        tables[entity] = [...(tables[entity] ?? []), { id, ...data }]
        return { id }
      },
      async update(entity: string, id: string, data: Record<string, unknown>) {
        tables[entity] = (tables[entity] ?? []).map((r) => (r.id === id ? { ...r, ...data } : r))
      },
    },
  }
}

const EXPECTED_CALLS = [...PERMISSION_READS.map((r) => `GET ${r.path}`), "POST /v1/refunds"]

describe("the key check", () => {
  it("the check makes one read per permission and writes nothing", async () => {
    const { fetch, calls } = fakeStripe()
    const { db } = memDb()
    const result = await runConnectionCheck({ fetch, db })
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(EXPECTED_CALLS)
    // The only POST is the probe on a charge that cannot exist; it answered 404.
    const posts = calls.filter((c) => c.method !== "GET")
    expect(posts).toHaveLength(1)
    expect(posts[0]?.body).toBe(`charge=${REFUND_PROBE_CHARGE}`)
    if ("status" in result) throw new Error("refused")
    expect(result.checks).toHaveLength(10)
    expect(result.checks.every((c) => c.state === "ok")).toBe(true)
    expect(result.mode).toBe("test")
    expect(result.state).toBe("key_stored")
  })

  it("a missing disputes read is one error row and the connection stays usable", async () => {
    const { fetch } = fakeStripe({ "GET /v1/disputes": { status: 403 } })
    const { db, tables } = memDb()
    const result = await runConnectionCheck({ fetch, db })
    if ("status" in result) throw new Error("refused")
    const bad = result.checks.filter((c) => c.state !== "ok")
    expect(bad).toEqual([
      {
        label: "Disputes",
        level: "Read",
        state: "missing",
        meta: "Missing: give Read to Disputes",
      },
    ])
    expect(result.state).toBe("key_stored+partial")
    expect(result.next).toContain("Disputes to Read")
    expect(tables.install_metadata?.[0]?.state).toBe("key_stored+partial")
  })

  it("a refund probe answered 403 is a missing write row, and nothing was created", async () => {
    const { fetch } = fakeStripe({ "POST /v1/refunds": { status: 403 } })
    const { db } = memDb()
    const result = await runConnectionCheck({ fetch, db })
    if ("status" in result) throw new Error("refused")
    expect(result.checks.at(-1)).toMatchObject({
      label: "Refunds",
      level: "Write",
      state: "missing",
    })
  })

  it("a key Stripe refuses is the typed key_invalid refusal with the next step", async () => {
    const { fetch, calls } = fakeStripe({ "GET /v1/customers": { status: 401 } })
    const { db, tables } = memDb({
      install_metadata: [{ id: "i1", state: "connected", permissions: null }],
    })
    const result = await runConnectionCheck({ fetch, db })
    expect(result).toMatchObject({ status: "error", error: { code: "key_invalid", refusal: true } })
    if (!("status" in result)) throw new Error("not refused")
    expect(result.error.message).toContain("Next step")
    expect(calls).toHaveLength(1)
    expect(tables.install_metadata?.[0]?.state).toBe("connected+key_invalid")
  })

  it("a key of another account is refused as different_account and nothing is replaced", async () => {
    const before = {
      install_metadata: [
        {
          id: "i1",
          state: "connected",
          livemode: false,
          permissions: { mode: "test", checks: [], checkedAt: "2026-11-01T00:00:00.000Z" },
        },
      ],
      stripe_customers: [
        { id: "c1", stripe_id: "cus_A" },
        { id: "c2", stripe_id: "cus_B" },
      ],
      stripe_subscriptions: [
        { id: "s1", stripe_id: "sub_A" },
        { id: "s2", stripe_id: "sub_B" },
      ],
    }
    const { fetch, calls } = fakeStripe({
      "GET /v1/customers/cus_A": { status: 404 },
      "GET /v1/customers/cus_B": { status: 404 },
      "GET /v1/subscriptions/sub_A": { status: 404 },
    })
    const { db, tables } = memDb(before)
    const result = await runConnectionCheck({ fetch, db })
    expect(result).toMatchObject({ status: "error", error: { code: "different_account" } })
    // Up to 3 known ids, then nothing more: no permission read, no probe.
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/customers/cus_A",
      "/v1/customers/cus_B",
      "/v1/subscriptions/sub_A",
    ])
    expect(tables).toEqual(before)
  })

  it("a key of the same account goes on when one known id answers", async () => {
    const { fetch } = fakeStripe({ "GET /v1/customers/cus_A": { status: 404 } })
    const { db } = memDb({
      stripe_customers: [
        { id: "c1", stripe_id: "cus_A" },
        { id: "c2", stripe_id: "cus_B" },
      ],
    })
    const result = await runConnectionCheck({ fetch, db })
    expect("status" in result).toBe(false)
  })

  it("a live key where test data is held is refused as mode_changed and nothing is replaced", async () => {
    const before = {
      install_metadata: [
        {
          id: "i1",
          state: "connected",
          livemode: false,
          permissions: { mode: "test", checks: [], checkedAt: "x" },
        },
      ],
    }
    const { fetch } = fakeStripe({}, true)
    const { db, tables } = memDb(before)
    const result = await runConnectionCheck({ fetch, db })
    expect(result).toMatchObject({ status: "error", error: { code: "mode_changed" } })
    if (!("status" in result)) throw new Error("not refused")
    expect(result.error.message).toContain("rk_test_")
    expect(tables).toEqual(before)
  })
})

describe("the check of a key before it is stored", () => {
  it("answers like the check and records nothing, even when Stripe refuses the key", async () => {
    const before = { install_metadata: [{ id: "i1", state: "connected", permissions: null }] }
    const ok = memDb(before)
    const result = await runConnectionCheck(
      { fetch: fakeStripe().fetch, db: ok.db },
      { dryRun: true },
    )
    expect("status" in result).toBe(false)
    expect(ok.tables).toEqual(before)
    const refused = memDb(before)
    const r401 = await runConnectionCheck(
      { fetch: fakeStripe({ "GET /v1/customers": { status: 401 } }).fetch, db: refused.db },
      { dryRun: true },
    )
    expect(r401).toMatchObject({ status: "error", error: { code: "key_invalid" } })
    // Nothing was saved, so the refusal never speaks of "the saved key".
    if ("status" in r401) expect(r401.error.message).not.toContain("the saved key")
    expect(refused.tables).toEqual(before)
  })
})

describe("the secret key refusal declared by the connection", () => {
  const field = JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"))
    .connections.stripe.credentialFields[0]
  const refuses = (v: string) => new RegExp(field.refusePattern.pattern).test(v)

  it("a secret key is refused, nothing is stored and the card says why", () => {
    expect(refuses(`sk_live_${"a".repeat(24)}`)).toBe(true)
    expect(refuses(`sk_test_${"a".repeat(24)}`)).toBe(true)
    expect(refuses(`rk_test_${"a".repeat(24)}`)).toBe(false)
    expect(refuses(`rk_live_${"a".repeat(24)}`)).toBe(false)
    expect(field.refusePattern.message).toStartWith(
      "That is your secret key, so I did not keep it.",
    )
    expect(field.refusePattern.messageKey).toBe("kernel.stripeSecretKeyRefused")
  })
})

describe("the connection state", () => {
  it("moves forward and an overlay sits on any base", () => {
    let s = decodeState(undefined)
    expect(encodeState(s)).toBe("not_connected")
    s = transition(s, { kind: "key_checked", missing: 1 })
    expect(encodeState(s)).toBe("key_stored+partial")
    s = transition(s, { kind: "webhook_secret_stored" })
    s = transition(s, { kind: "first_event" })
    s = transition(s, { kind: "import_done" })
    expect(encodeState(s)).toBe("connected+partial")
    s = transition(s, { kind: "key_checked", missing: 0 })
    expect(encodeState(s)).toBe("connected")
    s = transition(s, { kind: "stalled" })
    expect(encodeState(s)).toBe("connected+stalled")
    s = transition(s, { kind: "event_received" })
    expect(encodeState(s)).toBe("connected")
    s = transition(s, { kind: "key_refused" })
    expect(encodeState(transition(s, { kind: "stalled" }))).toBe("connected+key_invalid")
    expect(encodeState(transition(s, { kind: "disconnected" }))).toBe("not_connected")
  })
})
