// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one door to the Stripe API. Every call the app makes goes through
// `stripeFetch`, so every request:
//   - reaches `api.stripe.com` only (the connection's `allowedDomains`),
//   - carries the pinned `Stripe-Version`, whatever the account's default is,
//   - is authenticated by the HOST: the restricted key is added to the request
//     by `ctx.fetch({ auth })` after the allow-list check, and never enters the
//     sandbox (the app never reads the credential),
//   - never waits inside a run: a 429 is answered at once as `rate_limited`, so a
//     job stops and its next run carries on from its stored place, and a tool
//     reports it. Pacing is the connection's `limits` block in the manifest: the
//     host spaces calls to one account across every run and process, and pauses
//     the account on a 429 with `Retry-After`;
//   - answers typed errors for 401 and 403.
import type { FetchAuth } from "@liaison/app-sdk"

/** The API version every request is pinned to. */
export const STRIPE_API_VERSION = "2026-10-28.endive"
export const STRIPE_API_BASE = "https://api.stripe.com"
export const STRIPE_CONNECTION = "stripe"

/** The host adds the stored restricted key as a bearer token. */
export const STRIPE_AUTH: FetchAuth = {
  connection: STRIPE_CONNECTION,
  scheme: "bearer",
  fields: ["restrictedKey"],
}

export interface StripeFetchResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** The slice of the app context this module uses. */
export interface StripeHttpCtx {
  fetch(
    url: string,
    opts?: {
      method?: string
      headers?: Record<string, string>
      body?: string
      timeoutMs?: number
      auth?: FetchAuth
    },
  ): Promise<StripeFetchResponse>
}

export type StripeErrorCode = "key_invalid" | "permission_missing" | "rate_limited" | "stripe_error"

/** A failed Stripe call: what failed, on which resource, with the HTTP status. */
export class StripeApiError extends Error {
  constructor(
    readonly code: StripeErrorCode,
    readonly status: number,
    readonly resource: string,
    message: string,
  ) {
    super(message)
    this.name = "StripeApiError"
  }
}

export type FormValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | FormValue[]
  | { [k: string]: FormValue }

/**
 * Stripe's form encoding: nested objects as `a[b]=…`, arrays as `a[0]=…`.
 * `undefined` and `null` are left out.
 */
export function formEncode(params: Record<string, FormValue>): string {
  const parts: string[] = []
  const walk = (key: string, value: FormValue): void => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      for (const [i, v] of value.entries()) walk(`${key}[${i}]`, v)
      return
    }
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(`${key}[${k}]`, v)
      return
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  for (const [k, v] of Object.entries(params)) walk(k, v)
  return parts.join("&")
}

/** The resource a path names: `/v1/customers/cus_1` is `customers`. */
export function resourceOf(path: string): string {
  const seg = path.replace(/^\/?v1\//, "").split(/[/?]/)[0]
  return seg || path
}

function stripeMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } }
    return typeof parsed.error?.message === "string" ? parsed.error.message : null
  } catch {
    return null
  }
}

export interface StripeFetchInit {
  method?: "GET" | "POST" | "DELETE"
  /** Query parameters for a GET, form fields for a POST. */
  params?: Record<string, FormValue>
  /** Sent as `Idempotency-Key` on a POST. */
  idempotencyKey?: string
  timeoutMs?: number
}

/**
 * Call the Stripe API and return the parsed JSON body. Throws `StripeApiError`:
 * `key_invalid` on 401, `permission_missing` (with the resource) on 403,
 * `rate_limited` on 429 (never retried in the run), `stripe_error` otherwise.
 */
export async function stripeFetch<T = unknown>(
  ctx: StripeHttpCtx,
  path: string,
  init: StripeFetchInit = {},
): Promise<T> {
  const method = init.method ?? "GET"
  const encoded = init.params ? formEncode(init.params) : ""
  const url =
    method === "GET" && encoded
      ? `${STRIPE_API_BASE}${path}${path.includes("?") ? "&" : "?"}${encoded}`
      : `${STRIPE_API_BASE}${path}`
  const headers: Record<string, string> = { "Stripe-Version": STRIPE_API_VERSION }
  if (method !== "GET") headers["Content-Type"] = "application/x-www-form-urlencoded"
  if (method === "POST" && init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey
  const resource = resourceOf(path)

  const res = await ctx.fetch(url, {
    method,
    headers,
    body: method === "GET" ? undefined : encoded,
    timeoutMs: init.timeoutMs,
    auth: STRIPE_AUTH,
  })
  if (res.status >= 200 && res.status < 300) return JSON.parse(res.body) as T
  const detail = stripeMessage(res.body)
  if (res.status === 429) {
    // No wait and no retry inside the run: a job's next run resumes from its stored place.
    throw new StripeApiError(
      "rate_limited",
      429,
      resource,
      `Stripe answered 429 (too many requests) for ${resource}; nothing was retried in this run.`,
    )
  }
  if (res.status === 401) {
    throw new StripeApiError(
      "key_invalid",
      401,
      resource,
      "Stripe refused the restricted key (401): it was revoked, rolled or mistyped.",
    )
  }
  if (res.status === 403) {
    throw new StripeApiError(
      "permission_missing",
      403,
      resource,
      `The restricted key has no permission for ${resource} (403).`,
    )
  }
  throw new StripeApiError(
    "stripe_error",
    res.status,
    resource,
    `Stripe answered ${res.status} for ${resource}${detail ? `: ${detail}` : "."}`,
  )
}
