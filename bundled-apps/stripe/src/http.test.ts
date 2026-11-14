// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  formEncode,
  STRIPE_API_VERSION,
  StripeApiError,
  type StripeHttpCtx,
  stripeFetch,
} from "./http"

type Call = { url: string; opts: Parameters<StripeHttpCtx["fetch"]>[1] }

function fakeCtx(answers: Array<{ status: number; body: unknown }>): {
  ctx: StripeHttpCtx
  calls: Call[]
} {
  const calls: Call[] = []
  const ctx: StripeHttpCtx = {
    async fetch(url, opts) {
      calls.push({ url, opts })
      // The pinned version is the mock's precondition, as in the e2e harness.
      if (opts?.headers?.["Stripe-Version"] !== STRIPE_API_VERSION) {
        return {
          status: 400,
          headers: {},
          body: JSON.stringify({ error: { message: "Stripe-Version missing" } }),
        }
      }
      const a = answers.shift() ?? { status: 200, body: {} }
      return { status: a.status, headers: {}, body: JSON.stringify(a.body) }
    },
  }
  return { ctx, calls }
}

describe("stripeFetch", () => {
  it("every request carries the pinned API version", async () => {
    const { ctx, calls } = fakeCtx([
      { status: 200, body: { object: "list", data: [] } },
      { status: 200, body: { id: "re_1" } },
    ])
    await stripeFetch(ctx, "/v1/customers", { params: { limit: 1 } })
    await stripeFetch(ctx, "/v1/refunds", {
      method: "POST",
      params: { charge: "ch_1" },
      idempotencyKey: "k1",
    })
    expect(calls).toHaveLength(2)
    for (const c of calls) expect(c.opts?.headers?.["Stripe-Version"]).toBe(STRIPE_API_VERSION)
  })

  it("only reaches api.stripe.com and lets the host add the key", async () => {
    const { ctx, calls } = fakeCtx([{ status: 200, body: {} }])
    await stripeFetch(ctx, "/v1/customers/cus_1")
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/customers/cus_1")
    expect(calls[0]?.opts?.auth).toEqual({
      connection: "stripe",
      scheme: "bearer",
      fields: ["restrictedKey"],
    })
    expect(JSON.stringify(calls[0]?.opts?.headers)).not.toContain("Authorization")
  })

  it("a GET sends its parameters in the query and a POST as a form", async () => {
    const { ctx, calls } = fakeCtx([
      { status: 200, body: {} },
      { status: 200, body: {} },
    ])
    await stripeFetch(ctx, "/v1/charges", { params: { customer: "cus_1", limit: 3 } })
    await stripeFetch(ctx, "/v1/refunds", {
      method: "POST",
      params: { charge: "ch_1", amount: 500 },
      idempotencyKey: "k",
    })
    expect(calls[0]?.url).toBe("https://api.stripe.com/v1/charges?customer=cus_1&limit=3")
    expect(calls[0]?.opts?.body).toBeUndefined()
    expect(calls[1]?.opts?.body).toBe("charge=ch_1&amount=500")
    expect(calls[1]?.opts?.headers?.["Content-Type"]).toBe("application/x-www-form-urlencoded")
    expect(calls[1]?.opts?.headers?.["Idempotency-Key"]).toBe("k")
  })

  it("encodes nested objects and arrays the way Stripe reads them", () => {
    expect(formEncode({ expand: ["data.customer"], metadata: undefined, a: { b: "c d" } })).toBe(
      "expand%5B0%5D=data.customer&a%5Bb%5D=c%20d",
    )
  })

  it("a 401 is key_invalid and a 403 names the resource as permission_missing", async () => {
    const a = fakeCtx([{ status: 401, body: { error: { message: "Invalid API Key" } } }])
    const e1 = (await stripeFetch(a.ctx, "/v1/customers").catch((e) => e)) as StripeApiError
    expect(e1).toBeInstanceOf(StripeApiError)
    expect([e1.code, e1.status]).toEqual(["key_invalid", 401])
    const b = fakeCtx([{ status: 403, body: { error: { message: "no access" } } }])
    const e2 = (await stripeFetch(b.ctx, "/v1/disputes?limit=1").catch((e) => e)) as StripeApiError
    expect([e2.code, e2.status, e2.resource]).toEqual(["permission_missing", 403, "disputes"])
  })

  it("a 429 answers rate_limited at once: one call, no wait and no retry inside the run", async () => {
    const busy = fakeCtx([
      { status: 429, body: {} },
      { status: 200, body: { id: "cus_1" } },
    ])
    const started = Date.now()
    const e = (await stripeFetch(busy.ctx, "/v1/customers/cus_1").catch((x) => x)) as StripeApiError
    expect(e).toBeInstanceOf(StripeApiError)
    expect([e.code, e.status, e.resource]).toEqual(["rate_limited", 429, "customers"])
    expect(busy.calls).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(100)
  })
})
