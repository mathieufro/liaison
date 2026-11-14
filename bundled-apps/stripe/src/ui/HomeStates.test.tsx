// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The less common situations of the Stripe page: each connection state shows the
// right page and its next step; a revoked key shows rows as of their time and
// held approvals with no working Approve.
import { afterEach, describe, expect, it } from "bun:test"
import { HomeStates } from "./HomeStates"
import {
  approveState,
  asOfLine,
  type HomeLoad,
  importingView,
  pageKind,
  staleNotice,
  stateCard,
} from "./home-model"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
})

const sync = (over: Record<string, unknown> = {}) => ({
  importing: false,
  partial: false,
  missing: [] as string[],
  resources: [] as Array<{
    resource: string
    status: string
    done: number
    total: number | null
    error: string | null
  }>,
  ...over,
})
const NO_ROWS = {
  customers: 0,
  subscriptions: 0,
  invoices: 0,
  payments: 0,
  refunds: 0,
  disputes: 0,
}
const load = (state: string, over: Partial<HomeLoad> = {}): HomeLoad => {
  const [base, overlay] = state.split("+")
  return {
    connection: {
      state,
      base: base ?? "",
      overlay: overlay ?? null,
      mode: "test",
      lastEventAt: "2026-11-10T07:42:00.000Z",
      lastEventType: "invoice.paid",
      connectedAt: "2026-11-01T08:00:00.000Z",
    },
    sync: sync(),
    counts: {
      customers: 214,
      subscriptions: 178,
      invoices: 1,
      payments: 1,
      refunds: 0,
      disputes: 0,
    },
    attention: null,
    summary: "",
    ...over,
  }
}

describe("every connection state shows the right page and the next step", () => {
  it("picks the page from the state and the import", () => {
    expect(pageKind(null)).toBe("not_connected")
    expect(pageKind(load("not_connected"))).toBe("not_connected")
    expect(pageKind(load("key_stored"))).toBe("waiting")
    expect(pageKind(load("waiting_first_event"))).toBe("waiting")
    expect(pageKind(load("importing", { sync: sync({ importing: true }) }))).toBe("importing")
    expect(pageKind(load("connected", { sync: sync({ importing: true }) }))).toBe("importing")
    expect(pageKind(load("connected", { counts: NO_ROWS }))).toBe("empty")
    expect(pageKind(load("connected"))).toBe("home")
    expect(pageKind(load("connected+key_invalid"))).toBe("revoked")
    expect(pageKind(load("connected+different_account"))).toBe("other_account")
    expect(pageKind(load("connected+stalled"))).toBe("stalled")
    expect(pageKind(load("connected+partial", { sync: sync({ missing: ["invoices"] }) }))).toBe(
      "partial",
    )
    // A revoked key wins over an import still running: the key is what a person fixes first.
    expect(pageKind(load("connected+key_invalid", { sync: sync({ importing: true }) }))).toBe(
      "revoked",
    )
  })

  it("every state but the healthy one carries a title, a next step and an action", () => {
    const cases: Array<[string, Partial<HomeLoad>]> = [
      ["not_connected", {}],
      ["key_stored", {}],
      ["waiting_first_event", {}],
      [
        "importing",
        {
          sync: sync({
            importing: true,
            resources: [
              { resource: "customers", status: "running", done: 3, total: 10, error: null },
            ],
          }),
        },
      ],
      ["connected+key_invalid", {}],
      ["connected+different_account", {}],
      ["connected+stalled", {}],
      ["connected+partial", { sync: sync({ missing: ["invoices"] }) }],
    ]
    for (const [state, over] of cases) {
      const card = stateCard(load(state, over), "en", new Date("2026-11-10T10:02:00.000Z"))
      expect(card, state).not.toBeNull()
      expect(card?.title.length, state).toBeGreaterThan(5)
      expect(card?.steps.length, state).toBeGreaterThan(0)
      expect(card?.actions.length, state).toBeGreaterThan(0)
    }
    expect(stateCard(load("connected"), "en", new Date())).toBeNull()
    expect(typeof HomeStates).toBe("function")
  })

  it("an empty account with a test key says the test key only sees test data", () => {
    const l = load("connected", { counts: NO_ROWS })
    const card = stateCard(l, "en", new Date())
    expect(card?.steps.join(" ")).toContain("rk_live_")
    const live = stateCard(
      { ...l, connection: { ...l.connection, mode: "live" } },
      "en",
      new Date(),
    )
    expect(live?.steps.join(" ")).not.toContain("rk_live_")
  })

  it("stalled says since when, and that Stripe resends for 72 hours", () => {
    const card = stateCard(
      load("connected+stalled"),
      "en",
      new Date("2026-11-10T10:02:00.000Z"),
      "UTC",
    )
    expect(card?.title).toContain("07:42")
    expect(card?.steps.join(" ")).toContain("72 hours")
  })

  it("partial names the permission the key lost and the fix", () => {
    const card = stateCard(
      load("connected+partial", { sync: sync({ missing: ["invoices"] }) }),
      "en",
      new Date(),
    )
    expect(card?.title).toContain("invoices")
    expect(card?.steps.join(" ")).toContain("Read")
  })
})

describe("importing", () => {
  it("shows each resource's progress and holds MRR until every subscription is read", () => {
    const view = importingView(
      sync({
        importing: true,
        resources: [
          { resource: "customers", status: "done", done: 214, total: 214, error: null },
          { resource: "subscriptions", status: "running", done: 140, total: 178, error: null },
          { resource: "invoices", status: "pending", done: 0, total: null, error: null },
        ],
      }),
    )
    expect(view.rows.map((r) => [r.resource, r.done, r.total, r.percent])).toEqual([
      ["customers", 214, 214, 100],
      ["subscriptions", 140, 178, 79],
      ["invoices", 0, null, 0],
    ])
    expect(view.mrrLine).toBe("MRR shows once all 178 subscriptions are read.")
  })

  it("without a known subscriptions total the line does not invent one", () => {
    const view = importingView(
      sync({
        importing: true,
        resources: [
          { resource: "subscriptions", status: "running", done: 4, total: null, error: null },
        ],
      }),
    )
    expect(view.mrrLine).toBe("MRR shows once every subscription is read.")
  })
})

describe("a revoked key", () => {
  it("shows rows as of their time and Held approvals with no working Approve", () => {
    const l = load("connected+key_invalid")
    const notice = staleNotice(
      { ...l, connection: { ...l.connection, lastEventAt: "2026-11-10T09:08:00.000Z" } },
      "en",
      "UTC",
    )
    expect(notice).toMatch(/as of 09:08/i)
    expect(asOfLine("2026-11-10T09:08:00.000Z", "en", "UTC")).toContain("09:08")
    // The approval stays open for the person; its Approve cannot work until the key does.
    const held = approveState(pageKind(l))
    expect(held.enabled).toBe(false)
    expect(held.label).toBe("Held")
    expect(held.hint).toBe("Waits for the key")
    // A healthy page keeps Approve working.
    expect(approveState("home")).toEqual({ enabled: true, label: "Approve", hint: null })
    // Nothing is read or written while the account is unconfirmed either.
    expect(approveState("other_account").enabled).toBe(false)
  })
})
