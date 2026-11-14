// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The money tools against the Stripe mock the API tests use (the harness's
// `api.stripe.com` stand-in: pinned version, recorded calls, refunds and
// cancellations that change the stored objects), through a `ctx.fetch` shaped
// like the sandbox's, and the in-memory tables.
import {
  makeStripeMockFetch,
  stripeMockSeed,
} from "../../../apps/api/test-support/harness/stripe-mock-fetch"
import { MemDb } from "./mem-db.testkit"
import type { MoneyCtx } from "./tools/refunds"

export * from "../../../apps/api/test-support/harness/stripe-mock-fetch"

const mock = makeStripeMockFetch(async () => new Response("not stripe", { status: 599 }))

export const mockFetch: MoneyCtx["fetch"] = async (url, opts) => {
  const res = await mock(url, {
    method: opts?.method,
    headers: { ...(opts?.headers ?? {}), Authorization: "Bearer rk_test_mockkey" },
    body: opts?.body,
  })
  return { status: res.status, headers: {}, body: await res.text() }
}

export interface Recorded {
  started: number
  succeeded: string[]
  noEffect: Array<{ code: string }>
  ambiguous: Array<{ code: string }>
  calls: Array<{ tool: string; params: Record<string, unknown> }>
  logs: Array<{ level: string; msg: string; data: unknown }>
}

export function connectedDb(state = "connected"): MemDb {
  const db = new MemDb()
  db.seed("install_metadata", [{ state, livemode: false, permissions: null }])
  return db
}

/** A ctx for one approval (`approvalId`), or for staging when it is null. */
export function moneyCtx(
  db: MemDb,
  approvalId: string | null,
  opts: { cardIssuer?: string | null } = {},
): MoneyCtx & { rec: Recorded } {
  const rec: Recorded = {
    started: 0,
    succeeded: [],
    noEffect: [],
    ambiguous: [],
    calls: [],
    logs: [],
  }
  const tool = "stripe:refunds_create"
  return {
    rec,
    db: db as unknown as MoneyCtx["db"],
    fetch: mockFetch,
    executeTool: async (t, params) => {
      rec.calls.push({ tool: t, params })
      if (t === "projects:deals_search")
        return { status: "completed", result: { items: [{ id: "d1", title: "Renewal 2027" }] } }
      // Who issues card payments' invoices, as invoicing's "Who issues what" records it.
      if (t === "invoicing:card_stream_issuer")
        return { status: "completed", result: { issuer: opts.cardIssuer ?? null } }
      return { status: "completed", result: { ok: true } }
    },
    logger: {
      info: (msg, data) => rec.logs.push({ level: "info", msg, data }),
      warn: (msg, data) => rec.logs.push({ level: "warn", msg, data }),
    },
    ...(approvalId
      ? {
          approval: { approvalRequestId: approvalId, approvalDeciderId: "decider", toolName: tool },
          approval_recordStarted: async () => {
            rec.started++
          },
          approval_recordSucceeded: async (_t, ref) => {
            rec.succeeded.push(ref ?? "")
          },
          approval_recordFailedNoEffect: async (_t, err) => {
            rec.noEffect.push(JSON.parse(err))
          },
          approval_recordAmbiguous: async (_t, err) => {
            rec.ambiguous.push(JSON.parse(err))
          },
        }
      : {}),
  }
}

/** A charge of `amount` with `refunded` already refunded, in Stripe (the mock) only. */
export function seedCharge(
  id: string,
  amount: number,
  refunded = 0,
  extra: Record<string, unknown> = {},
) {
  return stripeMockSeed("charges", {
    id,
    amount,
    amount_captured: amount,
    amount_refunded: refunded,
    refunded: refunded >= amount,
    disputed: false,
    ...extra,
  })
}
