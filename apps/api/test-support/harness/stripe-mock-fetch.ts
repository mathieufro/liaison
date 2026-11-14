// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only Stripe API mock. Stands in for `api.stripe.com` only; every other
// host goes to the wrapped fetch. It serves the object shapes in
// `stripe-fixtures/` (the pinned API version), records every call, and refuses
// any request without the pinned `Stripe-Version` header with a 400, so a code
// path that forgets the version fails its test instead of passing on the
// account's default version.
//
// Objects live in a per-process store: `stripeMockSeed` adds or replaces one
// (cloned from its fixture with overrides), `stripeMockReset` restores the
// fixtures alone. Lists answer Stripe's list envelope; a missing id answers
// Stripe's 404 error shape. `stripeMockFailNext` makes the next call to a path
// answer a chosen status (401, 403, 429) once.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const STRIPE_MOCK_HOST = "api.stripe.com"
export const STRIPE_MOCK_API_VERSION = "2026-10-28.endive"

/** Resource name in the URL -> fixture file and id prefix. */
const RESOURCES = {
  customers: "customer",
  subscriptions: "subscription",
  invoices: "invoice",
  charges: "charge",
  refunds: "refund",
  disputes: "dispute",
  events: "event",
} as const

export type StripeMockResource = keyof typeof RESOURCES
type StripeObject = Record<string, unknown> & { id: string }

const FIXTURE_DIR = join(import.meta.dir, "stripe-fixtures")

/** The recorded (or documented) object for a resource, freshly parsed. */
export function stripeFixture(resource: StripeMockResource): StripeObject {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${RESOURCES[resource]}.json`), "utf8"))
}

export interface StripeMockRecord {
  method: string
  url: string
  path: string
  stripeVersion: string | null
  hasAuthorization: boolean
  /**
   * SHA-256 of the bearer token the host added, so a test can prove the stored
   * key reached Stripe without the key ever being recorded or returned.
   */
  authorizationSha256: string | null
  idempotencyKey: string | null
  body: string | null
}

const records: StripeMockRecord[] = []
const store = new Map<StripeMockResource, Map<string, StripeObject>>()
const failures = new Map<string, number>()
/** Paths whose next write is applied and whose answer is then lost on the way back. */
const lostAnswers = new Set<string>()
/** Stripe keeps an idempotency key for 24 hours: the first answer, replayed within that window. */
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000
const idempotent = new Map<string, { at: number; status: number; body: unknown }>()
let clockOffsetMs = 0
let refundSeq = 0
const mockNow = () => Date.now() + clockOffsetMs

function freshStore(): void {
  store.clear()
  for (const r of Object.keys(RESOURCES) as StripeMockResource[]) {
    const f = stripeFixture(r)
    store.set(r, new Map([[f.id, f]]))
  }
}
freshStore()

/** Resources the key check lists that the connector does not mirror: an empty list. */
const LIST_ONLY = new Set(["payment_methods", "products", "prices"])

/** A live key sees live-mode objects, a test key test-mode ones, as in Stripe. */
function inMode<T>(obj: T, live: boolean): T {
  return obj && typeof obj === "object" && "livemode" in (obj as object)
    ? { ...obj, livemode: live }
    : obj
}

function bearerSha256(header: string | null): string | null {
  const token = header?.replace(/^Bearer\s+/i, "")
  return token ? createHash("sha256").update(token).digest("hex") : null
}

export function stripeMockRequests(): StripeMockRecord[] {
  return [...records]
}

export function stripeMockReset(): void {
  records.length = 0
  failures.clear()
  lostAnswers.clear()
  idempotent.clear()
  clockOffsetMs = 0
  refundSeq = 0
  freshStore()
}

/** The next write to `path` takes effect in the mock and its answer never arrives (a lost response). */
export function stripeMockLoseAnswerNext(path: string): void {
  lostAnswers.add(path)
}

/** Moves the mock's clock: an idempotency key older than 24 hours is forgotten, as Stripe does. */
export function stripeMockAdvanceHours(hours: number): void {
  clockOffsetMs += hours * 60 * 60 * 1000
}

/** One stored object, as the mock holds it now. */
export function stripeMockObject(
  resource: StripeMockResource,
  id: string,
): StripeObject | undefined {
  return store.get(resource)?.get(id)
}

/** Add or replace an object: the fixture's shape with `overrides` on top. */
export function stripeMockSeed(
  resource: StripeMockResource,
  overrides: Partial<StripeObject> & { id: string },
): StripeObject {
  const obj = { ...stripeFixture(resource), ...overrides } as StripeObject
  store.get(resource)?.set(obj.id, obj)
  return obj
}

/** The next request to `path` (e.g. `/v1/disputes`) answers `status` once. */
export function stripeMockFailNext(path: string, status: 401 | 403 | 404 | 429 | 500): void {
  failures.set(path, status)
}

export function stripeMockHandlesHost(hostname: string): boolean {
  return hostname === STRIPE_MOCK_HOST
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function stripeError(status: number, type: string, message: string, code?: string): Response {
  return json({ error: { type, message, ...(code ? { code } : {}) } }, status)
}

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]
/** What the mock forwards a non-Stripe request to: only the call shape of `fetch`. */
type ForwardFetch = (input: FetchInput, init?: FetchInit) => Promise<Response>

export function makeStripeMockFetch(realFetch: ForwardFetch = fetch): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return realFetch(input, init)
    }
    if (parsed.hostname !== STRIPE_MOCK_HOST) return realFetch(input, init)

    const headers = new Headers(init?.headers)
    const method = (init?.method ?? "GET").toUpperCase()
    const record: StripeMockRecord = {
      method,
      url,
      path: parsed.pathname,
      stripeVersion: headers.get("stripe-version"),
      hasAuthorization: headers.has("authorization"),
      authorizationSha256: bearerSha256(headers.get("authorization")),
      idempotencyKey: headers.get("idempotency-key"),
      body: typeof init?.body === "string" ? init.body : null,
    }
    records.push(record)

    if (record.stripeVersion !== STRIPE_MOCK_API_VERSION) {
      return stripeError(
        400,
        "invalid_request_error",
        `Stripe-Version must be ${STRIPE_MOCK_API_VERSION}; got ${record.stripeVersion ?? "none"}.`,
        "api_version_missing",
      )
    }
    const forced = failures.get(parsed.pathname)
    if (forced !== undefined) {
      failures.delete(parsed.pathname)
      if (forced === 401)
        return stripeError(401, "invalid_request_error", "Invalid API Key provided.")
      if (forced === 403)
        return stripeError(
          403,
          "invalid_request_error",
          "The provided key does not have the required permissions.",
        )
      if (forced === 429)
        return stripeError(429, "rate_limit_error", "Too many requests.", "rate_limit")
      if (forced === 404)
        return stripeError(404, "invalid_request_error", "No such object.", "resource_missing")
      return stripeError(500, "api_error", "Internal error.")
    }

    const [, version, resource, id] = parsed.pathname.split("/")
    if (version === "v1" && method === "GET" && !id && resource && LIST_ONLY.has(resource)) {
      return json({ object: "list", data: [], has_more: false, url: `/v1/${resource}` })
    }
    // The key check's refund probe names a charge that cannot exist: Stripe's 404.
    if (version === "v1" && method === "POST" && resource === "refunds" && !id) {
      const charge = new URLSearchParams(record.body ?? "").get("charge") ?? ""
      if (!store.get("charges")?.has(charge)) {
        return stripeError(
          404,
          "invalid_request_error",
          `No such charge: '${charge}'`,
          "resource_missing",
        )
      }
    }
    if (version !== "v1" || !(resource && resource in RESOURCES)) {
      return stripeError(
        404,
        "invalid_request_error",
        `Unrecognized request URL (${method}: ${parsed.pathname}).`,
      )
    }
    const objects = store.get(resource as StripeMockResource) ?? new Map()
    const live = /^Bearer\s+(rk|sk)_live_/i.test(headers.get("authorization") ?? "")
    if (method === "GET" && !id) {
      const limit = Number(parsed.searchParams.get("limit") ?? 10)
      const charge = parsed.searchParams.get("charge")
      const all = [...objects.values()].filter((o) => !charge || o.charge === charge)
      return json({
        object: "list",
        data: all.slice(0, limit).map((o) => inMode(o, live)),
        has_more: all.length > limit,
        url: `/v1/${resource}`,
      })
    }
    if (method === "GET" && id) {
      const obj = objects.get(id)
      return obj
        ? json(inMode(obj, live))
        : stripeError(
            404,
            "invalid_request_error",
            `No such ${RESOURCES[resource as StripeMockResource]}: '${id}'`,
            "resource_missing",
          )
    }
    if (version === "v1" && method !== "GET") {
      const answer = writeAnswer(record, resource as StripeMockResource, id, method)
      if (answer) {
        if (lostAnswers.delete(parsed.pathname))
          throw new TypeError("fetch failed: the connection closed")
        return answer
      }
    }
    // Writes the connector makes are added with the tasks that make them.
    return stripeError(
      400,
      "invalid_request_error",
      `The mock does not serve ${method} ${parsed.pathname}.`,
    )
  }) as typeof fetch
}

/** Stripe's form fields, `metadata[k]` included. */
function formOf(body: string | null): {
  fields: URLSearchParams
  metadata: Record<string, string>
} {
  const fields = new URLSearchParams(body ?? "")
  const metadata: Record<string, string> = {}
  for (const [k, v] of fields) {
    const m = /^metadata\[(.+)\]$/.exec(k)
    if (m?.[1]) metadata[m[1]] = v
  }
  return { fields, metadata }
}

/**
 * The writes the connector makes: a refund (partial or whole, never above what is
 * left on the charge, replayed for the same idempotency key within 24 hours) and a
 * subscription's cancellation (at period end, or now).
 */
function writeAnswer(
  record: StripeMockRecord,
  resource: StripeMockResource,
  id: string | undefined,
  method: string,
): Response | null {
  const key = record.idempotencyKey ? `${record.path}|${record.idempotencyKey}` : null
  if (key) {
    const seen = idempotent.get(key)
    if (seen && mockNow() - seen.at < IDEMPOTENCY_WINDOW_MS) return json(seen.body, seen.status)
  }
  const answer = (status: number, body: unknown): Response => {
    if (key && status < 500) idempotent.set(key, { at: mockNow(), status, body })
    return json(body, status)
  }
  const { fields, metadata } = formOf(record.body)
  if (resource === "refunds" && method === "POST" && !id) {
    const charge = store.get("charges")?.get(fields.get("charge") ?? "")
    if (!charge) return null
    const amount = Number(charge.amount ?? 0)
    const refunded = Number(charge.amount_refunded ?? 0)
    const left = amount - refunded
    const wanted = fields.has("amount") ? Number(fields.get("amount")) : left
    if (left <= 0) {
      return answer(400, {
        error: {
          type: "invalid_request_error",
          code: "charge_already_refunded",
          message: `Charge ${charge.id} has already been refunded.`,
        },
      })
    }
    if (!(wanted > 0) || wanted > left) {
      return answer(400, {
        error: {
          type: "invalid_request_error",
          code: "amount_too_large",
          message: `Refund amount (${wanted}) is greater than unrefunded amount on charge (${left})`,
        },
      })
    }
    charge.amount_refunded = refunded + wanted
    charge.refunded = refunded + wanted >= amount
    const refund: StripeObject = {
      ...stripeFixture("refunds"),
      id: `re_MOCK${String(++refundSeq).padStart(4, "0")}`,
      amount: wanted,
      charge: charge.id,
      currency: charge.currency,
      created: Math.floor(mockNow() / 1000),
      metadata,
      reason: fields.get("reason"),
      status: "succeeded",
    }
    store.get("refunds")?.set(refund.id, refund)
    return answer(200, refund)
  }
  if (resource === "subscriptions" && id && (method === "POST" || method === "DELETE")) {
    const sub = store.get("subscriptions")?.get(id)
    if (!sub) {
      return answer(404, {
        error: {
          type: "invalid_request_error",
          code: "resource_missing",
          message: `No such subscription: '${id}'`,
        },
      })
    }
    if (method === "DELETE") {
      sub.status = "canceled"
      sub.canceled_at = Math.floor(mockNow() / 1000)
      sub.ended_at = sub.canceled_at
    } else if (fields.get("cancel_at_period_end") === "true") {
      const items =
        (sub.items as { data?: Array<{ current_period_end?: number }> } | undefined)?.data ?? []
      sub.cancel_at_period_end = true
      sub.cancel_at = items[0]?.current_period_end ?? null
    }
    return answer(200, sub)
  }
  return null
}
