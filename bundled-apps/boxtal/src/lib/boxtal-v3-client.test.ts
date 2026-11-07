// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  BoxtalApiError,
  BoxtalV3Client,
  type BoxtalFetch,
  webhookSecretPlaceholder,
} from "./boxtal-v3-client"

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/** Build a fake fetch that returns canned responses in sequence (by predicate). */
function makeFetch(
  responses: Array<{
    match: (call: RecordedCall) => boolean
    status: number
    body: string
    headers?: Record<string, string>
  }>,
): { fetch: BoxtalFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetch: BoxtalFetch = async (url, opts) => {
    const call: RecordedCall = {
      url,
      method: opts?.method ?? "GET",
      headers: opts?.headers ?? {},
      body: opts?.body,
    }
    calls.push(call)
    const r = responses.find((x) => x.match(call))
    if (!r) throw new Error(`no canned response for ${call.method} ${call.url}`)
    return { status: r.status, headers: r.headers ?? {}, body: r.body }
  }
  return { fetch, calls }
}

function isBizCall(c: RecordedCall): boolean {
  return c.url.includes("/shipping/")
}

describe("BoxtalV3Client — the host authenticates (bearer exchange) and a 401 is retried once", () => {
  const EXCHANGE = (base: string) => ({
    connection: "boxtal",
    scheme: "bearer",
    exchange: { url: `${base}/iam/account-app/token`, fields: ["v3Key", "v3Secret"] },
  })

  function recordingFetch(statuses: number[]): { fetch: BoxtalFetch; seen: Array<Record<string, unknown>> } {
    const seen: Array<Record<string, unknown>> = []
    const fetch: BoxtalFetch = async (url, opts) => {
      seen.push({ url, ...opts })
      const status = statuses[Math.min(seen.length - 1, statuses.length - 1)]!
      return { status, headers: {}, body: wrap([]) }
    }
    return { fetch, seen }
  }

  it("names the v3 key pair's exchange (sandbox base) and sets no credential itself", async () => {
    const { fetch, seen } = recordingFetch([200])
    await new BoxtalV3Client({ fetch, environment: "sandbox" }).listContentCategories()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.auth).toEqual(EXCHANGE("https://api.boxtal.build"))
    expect(seen[0]!.headers).toEqual({})
  })

  it("uses the production token URL in production", async () => {
    const { fetch, seen } = recordingFetch([200])
    await new BoxtalV3Client({ fetch, environment: "production" }).listContentCategories()
    expect(seen[0]!.auth).toEqual(EXCHANGE("https://api.boxtal.com"))
  })

  it("retries once on a 401 (the host re-exchanges), then gives up", async () => {
    const { fetch, seen } = recordingFetch([401, 200])
    await new BoxtalV3Client({ fetch, environment: "sandbox" }).listContentCategories()
    expect(seen).toHaveLength(2)

    const failing = recordingFetch([401, 401])
    let err: unknown
    try {
      await new BoxtalV3Client({ fetch: failing.fetch, environment: "sandbox" }).listContentCategories()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(BoxtalApiError)
    expect((err as BoxtalApiError).status).toBe(401)
    expect((err as BoxtalApiError).message).toContain("401 after refresh")
    expect(failing.seen).toHaveLength(2)
  })
})

// — Task 3: business methods —

/** A single biz response (by status+body); the host does the token exchange. */
function clientWithBiz(
  status: number,
  body: string,
  seenOpts?: Array<Record<string, unknown> | undefined>,
): {
  client: BoxtalV3Client
  calls: RecordedCall[]
} {
  const { fetch: inner, calls } = makeFetch([
    { match: isBizCall, status, body },
  ])
  const fetch: BoxtalFetch = async (url, opts) => {
    seenOpts?.push(opts as Record<string, unknown> | undefined)
    return inner(url, opts)
  }
  const client = new BoxtalV3Client({
    fetch,
    environment: "sandbox",
  })
  return { client, calls }
}

function wrap(content: unknown): string {
  return JSON.stringify({ status: 200, timestamp: "2026-05-30T00:00:00Z", content })
}

const sampleDraft = {
  shippingOfferCode: "CHRP-Chrono18",
  fromAddress: { type: "BUSINESS" as const, contact: { email: "s@e.com", phone: "+33600000000", lastName: "S", firstName: "F" }, location: { city: "Paris", street: "1 rue", postalCode: "75001", countryIsoCode: "FR" } },
  toAddress: { type: "RESIDENTIAL" as const, contact: { email: "d@e.com", phone: "+12025550100", lastName: "D", firstName: "G" }, location: { city: "NYC", street: "5th Ave", postalCode: "10001", countryIsoCode: "US" } },
  packages: [
    { weight: 1.2, length: 30, width: 20, height: 10, value: { value: 50, currency: "EUR" } },
  ],
  content: { id: "content:v1:10120", description: "Electronics" },
  insured: false,
  labelType: "PDF_A4" as const,
}

describe("BoxtalV3Client.buildCreateBody", () => {
  it("maps a draft to the v3 shipping-order body", () => {
    const body = BoxtalV3Client.TestAccess.buildCreateBody(sampleDraft)
    expect(body.shippingOfferCode).toBe("CHRP-Chrono18")
    expect(body.insured).toBe(false)
    expect(body.labelType).toBe("PDF_A4")
    expect(body.shipment.packages).toHaveLength(1)
    expect(body.shipment.packages[0]).toMatchObject({
      weight: 1.2,
      length: 30,
      width: 20,
      height: 10,
      value: { value: 50, currency: "EUR" },
    })
    expect(body.shipment.toAddress.location.city).toBe("NYC")
    expect(body.shipment.fromAddress.location.countryIsoCode).toBe("FR")
    // EU-domestic drafts omit customsDeclaration entirely
    expect("customsDeclaration" in body.shipment).toBe(false)
  })

  it("truncates package content description to 64 chars", () => {
    const long = "x".repeat(100)
    const body = BoxtalV3Client.TestAccess.buildCreateBody({
      ...sampleDraft,
      content: { id: "content:v1:10120", description: long },
    })
    expect(body.shipment.content!.description.length).toBe(64)
  })

  it("includes customsDeclaration with truncated article descriptions when present", () => {
    const body = BoxtalV3Client.TestAccess.buildCreateBody({
      ...sampleDraft,
      customsDeclaration: {
        reason: "SALE",
        articles: [
          { description: "y".repeat(100), quantity: 2, unitWeight: 0.5, unitValue: { value: 25, currency: "EUR" }, originCountry: "FR", tariffNumber: "851762" },
        ],
      },
    })
    expect(body.shipment.customsDeclaration).toBeDefined()
    expect(body.shipment.customsDeclaration!.articles[0]!.description.length).toBe(64)
    expect(body.shipment.customsDeclaration!.articles[0]!.tariffNumber).toBe("851762")
  })

  it("round-trips a multi-package body", () => {
    const body = BoxtalV3Client.TestAccess.buildCreateBody({
      ...sampleDraft,
      packages: [
        { weight: 1, length: 10, width: 10, height: 10, value: { value: 10, currency: "EUR" } },
        { weight: 2, length: 20, width: 20, height: 20, value: { value: 20, currency: "EUR" } },
      ],
    })
    expect(body.shipment.packages).toHaveLength(2)
  })
})

describe("BoxtalV3Client business methods", () => {
  it("createShippingOrder POSTs and normalizes the response", async () => {
    const { client, calls } = clientWithBiz(
      200,
      wrap({
        id: "ord-1",
        status: "PENDING",
        shipmentId: "shp-1",
        deliveryPriceExclTax: { value: 8.5, currency: "EUR" },
        insurancePriceExclTax: { value: 0, currency: "EUR" },
        expectedTakingOverDate: "2026-06-01",
        estimatedDeliveryDate: "2026-06-03",
      }),
    )
    const res = await client.createShippingOrder(sampleDraft)
    const post = calls.find(isBizCall)!
    expect(post.method).toBe("POST")
    expect(post.url).toBe("https://api.boxtal.build/shipping/v3.1/shipping-order")
    expect(JSON.parse(post.body!).shippingOfferCode).toBe("CHRP-Chrono18")
    expect(res).toMatchObject({
      id: "ord-1",
      order_status: "PENDING",
      deliveryPriceExclTax: 8.5,
      insurancePriceExclTax: 0,
      expectedTakingOverDate: "2026-06-01",
      estimatedDeliveryDate: "2026-06-03",
    })
  })

  it("createShippingOrder reads a carrier tracking number the order response carries", async () => {
    const { client } = clientWithBiz(
      200,
      wrap({
        id: "ord-2",
        status: "PENDING",
        shipment: { packages: [{ trackingNumber: "1ZW4941Y0492530257" }] },
      }),
    )
    const res = await client.createShippingOrder(sampleDraft)
    expect(res.tracking_number).toBe("1ZW4941Y0492530257")
    const bare = await clientWithBiz(200, wrap({ id: "ord-3", status: "PENDING" })).client.createShippingOrder(sampleDraft)
    expect(bare.tracking_number).toBeNull()
  })

  it("getShippingOrder normalizes order_status", async () => {
    const { client } = clientWithBiz(200, wrap({ id: "ord-1", status: "CONFIRMED" }))
    const res = await client.getShippingOrder("ord-1")
    expect(res).toMatchObject({ id: "ord-1", order_status: "CONFIRMED" })
  })

  it("getTracking maps content to a normalized tracking view", async () => {
    const { client } = clientWithBiz(
      200,
      wrap([
        {
          status: "IN_TRANSIT",
          trackingNumber: "TRK123",
          trackingDateTime: "2026-06-02T10:00:00Z",
          history: [
            { status: "SHIPPED", trackingDateTime: "2026-06-01T08:00:00Z", message: "Picked up" },
            { status: "IN_TRANSIT", trackingDateTime: "2026-06-02T10:00:00Z", message: "In transit" },
          ],
        },
      ]),
    )
    const res = await client.getTracking("ord-1")
    expect(res.tracking_number).toBe("TRK123")
    expect(res.tracking_status).toBe("IN_TRANSIT")
    expect(res.events).toHaveLength(2)
    expect(res.events[0]).toMatchObject({ status: "SHIPPED", at: "2026-06-01T08:00:00Z", label: "Picked up" })
    // An in-transit parcel has NO pickup deadline.
    expect(res.pickup_deadline).toBeNull()
  })

  it("getTracking surfaces pickup_deadline for a parcel awaiting collection at a pickup point", async () => {
    // Regression (marco-mondial-relay-pickup-expiry-followup): a parcel at a Mondial Relay pickup
    // point carries a carrier-reported collection deadline; the agent must read THIS (not fabricate
    // one from the arrival date) to decide which relay parcels are about to expire.
    const { client } = clientWithBiz(
      200,
      wrap([
        {
          status: "REACHED_DELIVERY_PICKUP_POINT",
          trackingNumber: "MR-PU-1",
          trackingDateTime: "2026-06-18T11:00:00Z",
          pickupDeadline: "2026-06-25",
          history: [
            { status: "REACHED_DELIVERY_PICKUP_POINT", trackingDateTime: "2026-06-18T11:00:00Z", message: "Awaiting collection at the pickup point" },
          ],
        },
      ]),
    )
    const res = await client.getTracking("ord-pu")
    expect(res.tracking_status).toBe("REACHED_DELIVERY_PICKUP_POINT")
    expect(res.pickup_deadline).toBe("2026-06-25")
  })

  it("getTracking does NOT surface a pickup_deadline unless the parcel is at a pickup point", async () => {
    // A deadline on a non-pickup state is meaningless and must be dropped so an agent cannot
    // read a stray deadline for an in-transit/delivered parcel.
    const { client } = clientWithBiz(
      200,
      wrap([
        {
          status: "DELIVERED",
          trackingNumber: "MR-DLV-1",
          trackingDateTime: "2026-06-18T11:00:00Z",
          pickupDeadline: "2026-06-25",
          history: [],
        },
      ]),
    )
    const res = await client.getTracking("ord-dlv")
    expect(res.tracking_status).toBe("DELIVERED")
    expect(res.pickup_deadline).toBeNull()
  })

  it("getDocuments returns the raw descriptors (url kept here, stripped downstream)", async () => {
    const { client } = clientWithBiz(
      200,
      wrap([
        { url: "https://signed/label.pdf", type: "LABEL", format: "PDF_A4" },
        { url: "https://signed/cn23.pdf", type: "CN23", format: "PDF_A4" },
      ]),
    )
    const docs = await client.getDocuments("ord-1")
    expect(docs).toHaveLength(2)
    expect(docs[0]).toMatchObject({ url: "https://signed/label.pdf", type: "LABEL", format: "PDF_A4" })
  })

  it("cancel DELETEs and returns CANCELLED", async () => {
    const { client, calls } = clientWithBiz(200, wrap({ id: "ord-1", status: "CANCELLED" }))
    const res = await client.cancel("ord-1")
    expect(calls.find(isBizCall)!.method).toBe("DELETE")
    expect(res.order_status).toBe("CANCELLED")
  })

  it("listContentCategories returns id/label rows", async () => {
    const { client } = clientWithBiz(
      200,
      wrap([
        { id: "content:v1:10120", label: "Electronics" },
        { id: "content:v1:10130", label: "Clothing" },
      ]),
    )
    const cats = await client.listContentCategories()
    expect(cats).toHaveLength(2)
    expect(cats[0]).toMatchObject({ id: "content:v1:10120", label: "Electronics" })
  })

  it("createSubscription POSTs and returns the id; deleteSubscription DELETEs", async () => {
    const seenOpts: Array<Record<string, unknown> | undefined> = []
    const { client, calls } = clientWithBiz(200, wrap({ id: "sub-1" }), seenOpts)
    const sub = await client.createSubscription({
      eventType: "TRACKING_CHANGED",
      callbackUrl: "https://host/webhooks/org/boxtal/tracking-changed",
      webhookSecretConfigKey: "boxtalWebhookSecret",
    })
    const post = calls.find(isBizCall)!
    expect(post.method).toBe("POST")
    expect(post.url).toBe("https://api.boxtal.build/shipping/v3.1/subscription")
    const body = JSON.parse(post.body!)
    expect(body.eventType).toBe("TRACKING_CHANGED")
    // The secret is written in by the host: the body carries its placeholder only.
    const placeholder = webhookSecretPlaceholder("boxtalWebhookSecret")
    expect(body.webhookSecret).toBe(placeholder)
    expect(seenOpts[0]!.configSecrets).toEqual({ [placeholder]: "boxtalWebhookSecret" })
    expect(sub.id).toBe("sub-1")

    const { client: c2, calls: calls2 } = clientWithBiz(200, "")
    await c2.deleteSubscription("sub-1")
    expect(calls2.find(isBizCall)!.method).toBe("DELETE")
    expect(calls2.find(isBizCall)!.url).toBe(
      "https://api.boxtal.build/shipping/v3.1/subscription/sub-1",
    )
  })

  it("createSubscription coerces a NUMERIC id to a string (live returns a number)", async () => {
    // The live v3.1 endpoint returns `id` as a number; the app's subscription table
    // types subscription_id as a string and the DELETE path takes it in the URL. The
    // client must return a string id, or persisting it throws "expected string, got
    // number" and the live subscription is orphaned (uncancellable on disconnect).
    const { client } = clientWithBiz(200, wrap({ id: 1234567 }))
    const sub = await client.createSubscription({
      eventType: "DOCUMENT_CREATED",
      callbackUrl: "https://host/webhooks/org/boxtal/document-created",
      webhookSecretConfigKey: "boxtalWebhookSecret",
    })
    expect(sub.id).toBe("1234567")
    expect(typeof sub.id).toBe("string")
  })

  it("create 422 throws BoxtalApiError{status:422} carrying the body", async () => {
    const { client } = clientWithBiz(422, JSON.stringify({ code: "ValidationException.Phone" }))
    let err: unknown
    try {
      await client.createShippingOrder(sampleDraft)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(BoxtalApiError)
    expect((err as BoxtalApiError).status).toBe(422)
    expect((err as BoxtalApiError).body).toContain("ValidationException.Phone")
  })

  it("create 5xx is distinguishable as indeterminate (status >= 500)", async () => {
    const { client } = clientWithBiz(503, "upstream down")
    let err: unknown
    try {
      await client.createShippingOrder(sampleDraft)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(BoxtalApiError)
    expect((err as BoxtalApiError).status).toBeGreaterThanOrEqual(500)
  })
})

// ── per-request / per-call time budgets (http-budget.ts) ─────────────────────
//
// Prod, 2026-09: operators saw "Request failed" (HTTP 504 at 30s) on the
// shipping tools. The only bound on a Boxtal call was the sandbox-wide 10s
// fetch cap, so a degraded Boxtal could hold a sandbox worker for tens of
// seconds (print_pack was measured at 37 to 39s) inside a 60s tool budget.
describe("BoxtalV3Client - request timeout and call budget", () => {
  it("aborts a hung request on ITS OWN timeout instead of running to the sandbox limit", async () => {
    const seen: Array<{ timeoutMs?: number; hasSignal: boolean }> = []
    const fetch: BoxtalFetch = async (_url, opts) => {
      const o = opts as { timeoutMs?: number; signal?: AbortSignal } | undefined
      seen.push({ timeoutMs: o?.timeoutMs, hasSignal: Boolean(o?.signal) })
      const signal = o?.signal
      if (signal) {
        // A genuinely hung upstream: the ONLY way out is the client's own abort.
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const err = new Error("The operation was aborted")
            err.name = "AbortError"
            reject(err)
          })
        })
      }
      // No abort hint reached the fetch layer: the request would run on to the
      // sandbox-wide cap. Return a success so the assertions below fail loudly.
      return { status: 200, headers: {}, body: JSON.stringify({ status: 200, timestamp: "t", content: {} }) }
    }
    const client = new BoxtalV3Client({
      fetch,
      environment: "sandbox",
      requestTimeoutMs: 25,
    })
    const started = Date.now()
    let caught: unknown
    try {
      await client.getShippingOrder("ord-hung")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).name).toBe("AbortError")
    // Aborted at OUR deadline (25ms), nowhere near the 10s sandbox cap.
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(seen[0]).toEqual({ timeoutMs: 25, hasSignal: true })
  })

  it("refuses to start a request once the logical call budget is spent (504, nothing sent)", async () => {
    // Fake clock: the first round trip (the host's exchange inside it) costs
    // 11s, which exhausts a 10s call budget, so the 401 refresh round must NOT
    // be started.
    let clock = 0
    const calls: string[] = []
    const fetch: BoxtalFetch = async (url) => {
      calls.push(url)
      clock += 11_000
      return { status: 401, headers: {}, body: "expired" }
    }
    const client = new BoxtalV3Client({
      fetch,
      environment: "sandbox",
      now: () => clock,
      requestTimeoutMs: 5_000,
      callBudgetMs: 10_000,
    })
    let caught: unknown
    try {
      await client.getShippingOrder("ord-slow")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(BoxtalApiError)
    expect((caught as BoxtalApiError).status).toBe(504)
    // One business call only: the refresh round never left the client.
    expect(calls).toHaveLength(1)
    expect(clock).toBeLessThanOrEqual(11_000)
  })
})
