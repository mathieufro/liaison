// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "bun:test"
import {
  makeStripeMockFetch,
  STRIPE_MOCK_API_VERSION,
  type StripeMockResource,
  stripeFixture,
  stripeMockFailNext,
  stripeMockRequests,
  stripeMockReset,
  stripeMockSeed,
} from "./stripe-mock-fetch"

const passThrough = async () => new Response("real", { status: 299 })
const mock = makeStripeMockFetch(passThrough)
const V = { "Stripe-Version": STRIPE_MOCK_API_VERSION }
const RESOURCES: StripeMockResource[] = [
  "customers",
  "subscriptions",
  "invoices",
  "charges",
  "refunds",
  "disputes",
  "events",
]

/** Every key path of a JSON value, `a.b[].c` style, so a nested drift shows too. */
function keyPaths(v: unknown, prefix = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => keyPaths(x, `${prefix}[]`))
  if (v && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => [
      `${prefix}${k}`,
      ...keyPaths(x, `${prefix}${k}.`),
    ])
  }
  return []
}

describe("stripe mock", () => {
  beforeEach(() => stripeMockReset())

  it("a call without the pinned Stripe-Version is refused with 400 and recorded", async () => {
    const res = await mock("https://api.stripe.com/v1/customers")
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "api_version_missing",
    )
    expect(stripeMockRequests()[0]?.stripeVersion).toBeNull()
  })

  it("every mock response has exactly the keys of its recorded fixture", async () => {
    for (const r of RESOURCES) {
      const fixture = stripeFixture(r)
      const one = await mock(`https://api.stripe.com/v1/${r}/${fixture.id}`, { headers: V })
      expect(keyPaths(await one.json()).sort()).toEqual(keyPaths(fixture).sort())
      const list = (await (
        await mock(`https://api.stripe.com/v1/${r}?limit=5`, { headers: V })
      ).json()) as {
        object: string
        data: unknown[]
      }
      expect(list.object).toBe("list")
      for (const item of list.data) expect(keyPaths(item).sort()).toEqual(keyPaths(fixture).sort())
    }
  })

  it("a seeded object keeps the fixture's shape and an unknown id answers resource_missing", async () => {
    stripeMockSeed("customers", { id: "cus_SEEDED", email: "a@client.example" })
    const got = (await (
      await mock("https://api.stripe.com/v1/customers/cus_SEEDED", { headers: V })
    ).json()) as {
      email: string
    }
    expect(got.email).toBe("a@client.example")
    const missing = await mock("https://api.stripe.com/v1/customers/cus_NONE", { headers: V })
    expect(missing.status).toBe(404)
  })

  it("a forced failure answers once with Stripe's error shape", async () => {
    stripeMockFailNext("/v1/disputes", 403)
    expect((await mock("https://api.stripe.com/v1/disputes", { headers: V })).status).toBe(403)
    expect((await mock("https://api.stripe.com/v1/disputes", { headers: V })).status).toBe(200)
  })

  it("another host goes to the wrapped fetch", async () => {
    expect((await mock("https://elsewhere.example/v1/customers")).status).toBe(299)
    expect(stripeMockRequests()).toHaveLength(0)
  })
})
