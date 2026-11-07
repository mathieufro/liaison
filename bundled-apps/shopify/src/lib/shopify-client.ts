// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Thin Shopify Admin GraphQL client.
//
// Hardening dimensions (each pinned by a test in shopify-client.test.ts):
// - Bucket-aware throttle: when `extensions.cost.throttleStatus.currentlyAvailable`
//   drops below `throttleLowWatermark` (default 100), the next call sleeps
//   `throttlePauseMs` (default 1000 ms) so we don't burn the cost bucket.
//   Malformed/missing `extensions.cost` is treated as "no throttle".
// - 429 retry: up to 3 retries with the `Retry-After` header (in seconds);
//   throws after the 4th try.
// - 401 → CONNECTION_LOST (no retry — connection needs admin re-auth).
// - 403 → SCOPE_DENIED (no retry — a Liaison-side scope-grant gap, not a
//   token failure; see decisions.md §0.3d).
// - `paginate({ query, path })` follows `pageInfo.endCursor` until exhausted.
//
// The client is constructor-injected with `fetch` to keep it host-free —
// tests stub the network; production wires `globalThis.fetch`.

import { sleep } from "./timers"

export interface ShopifyFetchResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * One Admin API call. The client sets no credential: the fetch it is given
 * carries the connection (`get-client.ts` passes `ctx.fetch` with an `auth`
 * the host turns into `X-Shopify-Access-Token`), so the token never enters
 * app code.
 */
export type ShopifyFetch = (input: {
  url: string
  method: "POST"
  headers: Record<string, string>
  body: string
}) => Promise<ShopifyFetchResponse>

export interface ShopifyClientOptions {
  shop: string
  fetch?: ShopifyFetch
  apiVersion?: string
  /**
   * Override the base URL used for Admin API calls. When set, replaces the
   * default `https://${shop}.myshopify.com` prefix — the apiVersion-suffixed
   * GraphQL path is still appended (`<base>/admin/api/<version>/graphql.json`).
   * Trailing slashes are stripped. Used by the test harness to route requests
   * to a Bun mock instead of real Shopify, and by future multi-region setups.
   */
  baseUrlOverride?: string
  /** Pause forced after a low-throttle response, in ms. Default 1000. */
  throttlePauseMs?: number
  /** Below this, the next call is paused. Default 100. */
  throttleLowWatermark?: number
  /** Base delay between 429 retries (multiplied by retry-after). Default 1000. */
  retryDelayMs?: number
  /**
   * A caller on a deadline (a guard with a few seconds of budget): a 429 or a low throttle bucket
   * throws RATE_LIMIT at once instead of waiting and retrying. Default false.
   */
  failFast?: boolean
  /**
   * Seed the bucket-aware throttle watermark (epoch-ms of the earliest next
   * call), restored from a previous short-lived client for the same shop so
   * back-pressure survives across tool invocations. Default 0 (no pause).
   */
  initialThrottleAt?: number
  /**
   * Called with the new watermark (epoch-ms) whenever a response updates the
   * bucket-aware throttle state. A factory uses this to persist back-pressure
   * across client instances without caching the whole client (which would pin a
   * stale per-invocation `fetch` closure and an un-rotated token).
   */
  onThrottleChange?: (nextEarliestCallAt: number) => void
}

export interface ShopifyError extends Error {
  code?: "CONNECTION_LOST" | "SCOPE_DENIED" | "RATE_LIMIT" | "GRAPHQL_ERROR" | "HTTP_ERROR"
  status?: number
}

interface PaginateOptions {
  query: string
  variables?: Record<string, unknown>
  /** Path under `data.` that points at the connection (e.g. "customers"). */
  path: string
  /** Override per-page first count; default 50. */
  first?: number
}

const DEFAULT_API_VERSION = "2026-04"

export class ShopifyClient {
  private readonly shop: string
  private readonly apiVersion: string
  private readonly baseUrlOverride: string | null
  private readonly fetchImpl: ShopifyFetch
  private readonly throttlePauseMs: number
  private readonly throttleLowWatermark: number
  private readonly retryDelayMs: number
  private readonly failFast: boolean
  private readonly onThrottleChange?: (nextEarliestCallAt: number) => void
  private nextEarliestCallAt = 0

  constructor(opts: ShopifyClientOptions) {
    this.shop = opts.shop
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION
    this.baseUrlOverride = opts.baseUrlOverride ? opts.baseUrlOverride.replace(/\/$/, "") : null
    this.fetchImpl = opts.fetch ?? defaultFetch
    this.throttlePauseMs = opts.throttlePauseMs ?? 1000
    this.throttleLowWatermark = opts.throttleLowWatermark ?? 100
    this.retryDelayMs = opts.retryDelayMs ?? 1000
    this.failFast = opts.failFast === true
    this.nextEarliestCallAt = opts.initialThrottleAt ?? 0
    this.onThrottleChange = opts.onThrottleChange
  }

  /** Run a GraphQL query/mutation against the shop's Admin API. */
  async query<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const wait = this.nextEarliestCallAt - Date.now()
    if (wait > 0 && this.failFast) throw makeError("RATE_LIMIT", "Shopify throttle bucket low (fail fast)", 429)
    if (wait > 0) await sleep(wait)

    const base = this.baseUrlOverride ?? `https://${this.shop}.myshopify.com`
    const url = `${base}/admin/api/${this.apiVersion}/graphql.json`
    // `effectiveVars`/`reqBody` are mutable so a single malformed-cursor retry can
    // resend with `after: null` (see the cursor-fallback branch below).
    let effectiveVars = variables
    let reqBody = JSON.stringify({ query, variables: effectiveVars })
    let cursorFallbackUsed = false

    let attempt = 0
    while (true) {
      const res = await this.fetchImpl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: reqBody,
      })

      if (res.status === 401) {
        throw makeError("CONNECTION_LOST", "Shopify token rejected (401)", 401)
      }
      if (res.status === 403) {
        throw makeError("SCOPE_DENIED", "Shopify denied operation (403)", 403)
      }
      if (res.status === 429) {
        if (attempt >= 3 || this.failFast) {
          throw makeError("RATE_LIMIT", "Shopify 429 (rate limit) after 3 retries", 429)
        }
        const retryAfter = parseFloat(res.headers["retry-after"] ?? "1") || 1
        await sleep(Math.max(retryAfter * this.retryDelayMs, 0))
        attempt++
        continue
      }
      if (res.status >= 400) {
        throw makeError("HTTP_ERROR", `Shopify HTTP ${res.status}: ${res.body.slice(0, 200)}`, res.status)
      }

      const parsed = safeJsonParse(res.body)
      // Bucket-aware throttle: schedule the next call's earliest start.
      // Only update the watermark when Shopify includes the cost extension —
      // absence of the header does not mean "bucket is full", so we must not
      // reset a previously-set delay in that case.
      const available = parsed?.extensions?.cost?.throttleStatus?.currentlyAvailable
      if (typeof available === "number") {
        if (available < this.throttleLowWatermark) {
          this.nextEarliestCallAt = Date.now() + this.throttlePauseMs
        } else {
          this.nextEarliestCallAt = 0
        }
        // Persist the new watermark so a factory can carry back-pressure across
        // short-lived client instances for the same shop (see get-client.ts).
        this.onThrottleChange?.(this.nextEarliestCallAt)
      }

      if (parsed?.errors && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        const message = parsed.errors.map((e: { message?: string }) => e.message ?? "?").join("; ")
        // Malformed-cursor resilience: a weak agent can pass back a fabricated or
        // stale opaque page cursor, which the Admin API rejects with a hard
        // "Malformed cursor" GraphQL error on EVERY call — derailing the agent into
        // treating an architectural wall as a fixable tool bug (chaos: detect-margin
        // l296). Degrade gracefully ONCE: resend the same query from the first page
        // (after:null) so the caller still gets a usable bounded read. A VALID cursor
        // never reaches this branch (it does not error), so real pagination is
        // unaffected; mutations carry no `$after`, so they are untouched.
        if (
          !cursorFallbackUsed &&
          effectiveVars.after != null &&
          /malformed cursor/i.test(message)
        ) {
          cursorFallbackUsed = true
          effectiveVars = { ...effectiveVars, after: null }
          reqBody = JSON.stringify({ query, variables: effectiveVars })
          continue
        }
        throw makeError("GRAPHQL_ERROR", `Shopify GraphQL: ${message}`, res.status)
      }

      return (parsed?.data ?? {}) as T
    }
  }

  /**
   * Iterate edges of a single top-level connection across pages.
   *
   * The query must accept `$first: Int` and `$after: String` and select
   * `edges { node { ... } } pageInfo { hasNextPage endCursor }` under `data.<path>`.
   */
  async *paginate<TNode>(opts: PaginateOptions): AsyncGenerator<TNode, void, unknown> {
    let cursor: string | null = null
    const first = opts.first ?? 50
    while (true) {
      const vars: Record<string, unknown> = { ...(opts.variables ?? {}), first, after: cursor }
      const data = await this.query<Record<string, unknown>>(opts.query, vars)
      const conn = (data as Record<string, unknown>)[opts.path] as
        | { edges?: Array<{ node: TNode }>; pageInfo?: { hasNextPage: boolean; endCursor: string | null } }
        | undefined
      if (!conn?.edges) return
      for (const edge of conn.edges) {
        yield edge.node
      }
      if (!conn.pageInfo?.hasNextPage) return
      cursor = conn.pageInfo.endCursor ?? null
      if (!cursor) return
    }
  }
}

// — helpers —

function makeError(
  code: ShopifyError["code"],
  message: string,
  status?: number,
): ShopifyError {
  const err = new Error(message) as ShopifyError
  err.code = code
  if (typeof status === "number") err.status = status
  return err
}

function safeJsonParse(s: string): {
  data?: Record<string, unknown>
  errors?: Array<{ message?: string }>
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } }
} | null {
  try {
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

const defaultFetch: ShopifyFetch = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body })
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v
  })
  return { status: res.status, headers, body: await res.text() }
}
