// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { ShopifyClient, type ShopifyFetchResponse } from "./shopify-client"
import { createPollPacer, pollBackoffMs, sleep } from "./timers"
import { withTimer } from "./timers.testutil"

const COST_OK = { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } }
const COST_LOW = { cost: { throttleStatus: { currentlyAvailable: 50, restoreRate: 50 } } }

function okResponse(body: object): ShopifyFetchResponse {
  return { status: 200, headers: {}, body: JSON.stringify(body) }
}

describe("ShopifyClient", () => {
  it("query returns data on a 200 response", async () => {
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => okResponse({ data: { ok: true }, extensions: COST_OK }),
    })
    const r = await client.query<{ ok: boolean }>("query { ok }", {})
    expect(r.ok).toBe(true)
  })

  it("retries once with after:null when the API rejects a malformed cursor", async () => {
    const bodies: string[] = []
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async (req) => {
        bodies.push(typeof req.body === "string" ? req.body : "")
        n++
        // First call (carrying the bad cursor) → Shopify "Malformed cursor"; the
        // fallback retry (after:null) → ok.
        if (n === 1) return okResponse({ errors: [{ message: "Malformed cursor" }], extensions: COST_OK })
        return okResponse({ data: { orders: { edges: [] } }, extensions: COST_OK })
      },
    })
    const r = await client.query<{ orders: { edges: unknown[] } }>(
      "query($after:String){ orders }",
      { after: "garbage-cursor" },
    )
    expect(r.orders.edges).toEqual([])
    expect(n).toBe(2) // initial + exactly one cursor-fallback retry
    expect(JSON.parse(bodies[0]!).variables.after).toBe("garbage-cursor")
    expect(JSON.parse(bodies[1]!).variables.after).toBe(null)
  })

  it("does NOT retry a malformed-cursor error when no cursor was sent (after is null)", async () => {
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => {
        n++
        return okResponse({ errors: [{ message: "Malformed cursor" }], extensions: COST_OK })
      },
    })
    await expect(client.query("query{ orders }", { after: null })).rejects.toThrow(/Malformed cursor/)
    expect(n).toBe(1) // nothing to degrade to → no fallback retry
  })

  it("does NOT retry a non-cursor GraphQL error even with a cursor present", async () => {
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => {
        n++
        return okResponse({ errors: [{ message: "Field 'foo' doesn't exist" }], extensions: COST_OK })
      },
    })
    await expect(
      client.query("query($after:String){ orders }", { after: "c" }),
    ).rejects.toThrow(/doesn't exist/)
    expect(n).toBe(1)
  })

  it("pauses ~1s between calls when throttleStatus drops below 100", async () => {
    const calls: number[] = []
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => {
        calls.push(Date.now())
        return okResponse({ data: { ok: true }, extensions: COST_LOW })
      },
      // shorten the pause for the test
      throttlePauseMs: 50,
      throttleLowWatermark: 100,
    })
    await client.query("query { ok }", {})
    await client.query("query { ok }", {})
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(45)
  })

  it("retries 429 up to 3 times then throws", async () => {
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => {
        n++
        return { status: 429, headers: { "retry-after": "0" }, body: "" }
      },
      retryDelayMs: 0,
    })
    await expect(client.query("query{}", {})).rejects.toThrow(/429/)
    expect(n).toBe(4) // initial + 3 retries
  })

  it("propagates 401 immediately as CONNECTION_LOST (no retry)", async () => {
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => {
        n++
        return { status: 401, headers: {}, body: "" }
      },
    })
    await expect(client.query("query{}", {})).rejects.toMatchObject({ code: "CONNECTION_LOST" })
    expect(n).toBe(1)
  })

  it("propagates 403 as SCOPE_DENIED (no retry)", async () => {
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => ({ status: 403, headers: {}, body: "" }),
    })
    await expect(client.query("query{}", {})).rejects.toMatchObject({ code: "SCOPE_DENIED" })
  })

  it("paginate iterates edges across multiple GraphQL pages", async () => {
    const pages = [
      {
        data: {
          customers: { edges: [{ node: { id: "1" } }], pageInfo: { hasNextPage: true, endCursor: "c1" } },
        },
        extensions: COST_OK,
      },
      {
        data: {
          customers: { edges: [{ node: { id: "2" } }], pageInfo: { hasNextPage: false, endCursor: null } },
        },
        extensions: COST_OK,
      },
    ]
    let i = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => okResponse(pages[i++]!),
    })
    const ids: string[] = []
    for await (const node of client.paginate<{ id: string }>({ query: "...", path: "customers" })) {
      ids.push(node.id)
    }
    expect(ids).toEqual(["1", "2"])
  })

  it("baseUrlOverride routes the GraphQL call to the override host (P2a)", async () => {
    const urls: string[] = []
    const client = new ShopifyClient({
      shop: "demo",
      baseUrlOverride: "http://127.0.0.1:40001",
      fetch: async (req) => {
        urls.push(req.url)
        return okResponse({ data: { ok: true }, extensions: COST_OK })
      },
    })
    await client.query("query { ok }", {})
    expect(urls[0]).toBe("http://127.0.0.1:40001/admin/api/2026-04/graphql.json")
  })

  it("baseUrlOverride strips a trailing slash", async () => {
    const urls: string[] = []
    const client = new ShopifyClient({
      shop: "demo",
      baseUrlOverride: "http://127.0.0.1:40001/",
      fetch: async (req) => {
        urls.push(req.url)
        return okResponse({ data: { ok: true }, extensions: COST_OK })
      },
    })
    await client.query("query { ok }", {})
    expect(urls[0]).toBe("http://127.0.0.1:40001/admin/api/2026-04/graphql.json")
  })

  it("without baseUrlOverride, falls back to the canonical Shopify host", async () => {
    const urls: string[] = []
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async (req) => {
        urls.push(req.url)
        return okResponse({ data: { ok: true }, extensions: COST_OK })
      },
    })
    await client.query("query { ok }", {})
    expect(urls[0]).toBe("https://demo.myshopify.com/admin/api/2026-04/graphql.json")
  })

  it("malformed extensions.cost defaults to 'no throttle' (no pause forced)", async () => {
    const calls: number[] = []
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => {
        calls.push(Date.now())
        return okResponse({ data: { ok: true } })
      },
      throttlePauseMs: 500,
    })
    await client.query("query {}", {})
    await client.query("query {}", {})
    expect(calls[1]! - calls[0]!).toBeLessThan(100)
  })
})

describe("ShopifyClient on a runtime without timers", () => {
  it("a throttle wait is a no-op instead of a ReferenceError", async () => {
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => {
        n++
        return okResponse({ data: { ok: true }, extensions: COST_LOW })
      },
      throttlePauseMs: 60_000,
      throttleLowWatermark: 100,
    })
    await withTimer("absent", async () => {
      await client.query("query {}", {})
      // The bucket is low, so this call must wait first: with no timer it proceeds at once.
      await client.query("query {}", {})
    })
    expect(n).toBe(2)
  })

  it("a 429 retry proceeds without a timer", async () => {
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => {
        n++
        if (n === 1) return { status: 429, headers: { "retry-after": "2" }, body: "" }
        return okResponse({ data: { ok: true }, extensions: COST_OK })
      },
    })
    const r = await withTimer("absent", () => client.query<{ ok: boolean }>("query {}", {}))
    expect(r.ok).toBe(true)
    expect(n).toBe(2)
  })
})

describe("sleep", () => {
  it("resolves at once and touches no timer when the runtime has none", async () => {
    await withTimer("absent", async () => {
      await expect(sleep(1_000)).resolves.toBeUndefined()
    })
  })

  it("waits through setTimeout when the runtime has one", async () => {
    const delays = await withTimer("recording", async (d) => {
      await sleep(750)
      return d
    })
    expect(delays).toEqual([750])
  })

  it("never schedules a zero or negative wait", async () => {
    const delays = await withTimer("recording", async (d) => {
      await sleep(0)
      await sleep(-5)
      return d
    })
    expect(delays).toEqual([])
  })
})

describe("createPollPacer", () => {
  it("backs off 250 ms doubling to a 2 s cap", () => {
    expect([0, 1, 2, 3, 4, 9].map(pollBackoffMs)).toEqual([250, 500, 1000, 2000, 2000, 2000])
  })

  it("clips the waits to the budget, then stops waiting", async () => {
    const waits: number[] = []
    const pace = createPollPacer(2_500, async (ms) => {
      waits.push(ms)
    })
    for (let i = 0; i < 6; i++) await pace(i)
    expect(waits).toEqual([250, 500, 1000, 750])
  })
})
