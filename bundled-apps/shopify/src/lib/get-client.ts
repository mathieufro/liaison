// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared Shopify-client factory.
//
// Resolves the shop domain from `install_metadata`, finds the org-owned
// connection account, and constructs a `ShopifyClient` wired to `ctx.fetch`
// with an `auth` naming that account: the host adds the offline token to each
// request, so it never enters app code (one path on every executor). Centralised so
// every read / mutation / job / webhook path uses the same resolution
// rules (previously duplicated across six modules).
//
// A fresh client is built on every call (binding the current `ctx.fetch`), but the bucket-aware throttle watermark (`nextEarliestCallAt`)
// is persisted per (orgId, shopDomain) so back-pressure survives across calls
// within the same org and shop — rebuilding the client must not reset the
// watermark and defeat the throttle. Caching the whole client would instead pin
// a stale per-invocation fetch closure. Watermarks
// expire after 5 minutes.
import type { AppContext } from "@liaison/app-sdk"
import { API_VERSION, SHOPIFY_DOMAIN_RE } from "./constants"
import { type InstallMetadata, loadInstallMetadata } from "./install-metadata"
import { ShopifyClient, type ShopifyFetch } from "./shopify-client"

interface ClientError extends Error {
  code: "INSTALL_METADATA_MISSING" | "CONNECTION_MISSING"
}

function makeError(code: ClientError["code"], message: string): ClientError {
  const e = new Error(message) as ClientError
  e.code = code
  return e
}

function isClientError(err: unknown): err is ClientError {
  return (
    err instanceof Error &&
    ((err as ClientError).code === "INSTALL_METADATA_MISSING" ||
      (err as ClientError).code === "CONNECTION_MISSING")
  )
}

const SHOP_CONNECTION = "shop"
const THROTTLE_TTL_MS = 5 * 60 * 1000 // 5 minutes

interface CachedWatermark {
  /** Epoch-ms the next call may start (bucket-aware throttle watermark). */
  at: number
  expiresAt: number
}

// Module-level throttle-watermark cache, keyed by (orgId, shopDomain). A FRESH
// `ShopifyClient` is built on every call so each invocation binds the current
// `ctx.fetch` and offline token; only the bucket-aware throttle watermark is
// persisted here so back-pressure survives across nearby tool calls. Module state
// can outlive one run and be shared by every run the runtime keeps loaded, so an
// entry is only ever read under its own org, a run without an org id neither
// reads nor writes one, and expired entries are pruned on write. The value is a
// timestamp: nothing about the shop or its data is kept.
const throttleWatermarks = new Map<string, CachedWatermark>()

function pruneExpiredWatermarks(now: number): void {
  for (const [key, entry] of throttleWatermarks) {
    if (entry.expiresAt <= now) throttleWatermarks.delete(key)
  }
}

interface ConnAccount {
  /** `kernel.connected_accounts.id` — used as `install_metadata.connectionId`. */
  id?: string
  ownerType?: string
  identifier: string
}

/**
 * Pick the org-owned account (falling back to the first) from the connection's
 * account list — the same rule `getShopifyClient` uses to choose which token to
 * mint. Centralised so the self-heal writes the exact `connectionId` the read
 * path will later authenticate with.
 */
function pickShopAccount(accounts: ConnAccount[]): ConnAccount | undefined {
  return accounts.find((a) => a.ownerType === "org") ?? accounts[0]
}

/**
 * The shop account of the live `shop` connection, when it carries a Shopify
 * domain. Read-only: one connections-bridge lookup, no storage access.
 */
async function connectedShopAccount(
  ctx: AppContext,
): Promise<{ domain: string; account: ConnAccount } | null> {
  const shopConn = resolveShopConnection(ctx)
  if (!shopConn) return null
  let accounts: ConnAccount[]
  try {
    accounts = await shopConn.getAccounts()
  } catch {
    return null
  }
  const account = pickShopAccount(accounts)
  const domain = account?.identifier
  if (!account || !domain || !SHOPIFY_DOMAIN_RE.test(domain)) return null
  return { domain, account }
}

/**
 * The shop domains this organization has a CONNECTED `shop` account for (the
 * connections bridge lists active accounts only). Empty when none, or when the
 * bridge cannot answer.
 */
export async function connectedShopDomains(ctx: AppContext): Promise<string[]> {
  const shopConn = resolveShopConnection(ctx)
  if (!shopConn) return []
  try {
    return (await shopConn.getAccounts())
      .map((a) => a.identifier)
      .filter((d): d is string => typeof d === "string" && SHOPIFY_DOMAIN_RE.test(d))
  } catch {
    return []
  }
}

/** The in-memory stand-in for a missing row, built from the connection record. */
function inMemoryInstallMetadata(ctx: AppContext, domain: string, account: ConnAccount): InstallMetadata {
  return {
    id: "",
    orgId: ctx.orgId,
    shopDomain: domain,
    apiBaseUrl: null,
    apiVersion: API_VERSION,
    connectionId: account.id ?? "",
    connectionStatus: "connected",
  }
}

/**
 * Resolve `install_metadata` for a READ, never writing.
 *
 * The row is written by `onConnectionEstablished` when the kernel emits
 * `connected_account:create`. That event is a best-effort live pub/sub delivery
 * (outbox Phase 2b): if the app's subscriber isn't registered at the exact
 * instant it publishes (a boot / redeploy race), the event is lost and never
 * replays, leaving an ACTIVE kernel connection with NO `install_metadata`.
 *
 * A connected shop's reads must still work in that state, so when the row is
 * missing but an active `shop` connection exists we derive the row in memory
 * from the connection record (shop domain + connection id) and persist nothing.
 * Reads have to stay write-free: scope taint refuses every tool that is not
 * `readOnly` on a turn that has read scoped data, and a read that inserts can
 * never be `readOnly`. The persisting heal is `ensureInstallMetadata`, run from
 * the job path. Returns the existing (domainless) row or null when there is no
 * usable connection; `getShopifyClient` turns that into `INSTALL_METADATA_MISSING`.
 */
export async function resolveInstallMetadata(ctx: AppContext): Promise<InstallMetadata | null> {
  const existing = await loadInstallMetadata(ctx)
  if (existing?.shopDomain) return existing
  const shop = await connectedShopAccount(ctx)
  if (!shop) return existing
  return inMemoryInstallMetadata(ctx, shop.domain, shop.account)
}

/**
 * Resolve `install_metadata`, PERSISTING the connected-but-uninitialised heal.
 *
 * Same recovery as `resolveInstallMetadata`, but it inserts the reconstructed
 * row, so it belongs on the job path only (the hourly unfulfilled scan), never
 * on a read. This is idempotent and safe under the outbox's at-least-once
 * contract: a later `connected_account:create` (operator reconcile /
 * registration sweep) takes the existing-row branch and, unlike this heal, also
 * (re)registers the Shopify webhook subscriptions. It makes NO external Shopify
 * calls; webhook recovery is left to those event-driven paths.
 */
export async function ensureInstallMetadata(ctx: AppContext): Promise<InstallMetadata | null> {
  const existing = await loadInstallMetadata(ctx)
  if (existing?.shopDomain) return existing

  const shop = await connectedShopAccount(ctx)
  if (!shop) return existing
  const { domain, account } = shop

  // Best-effort persist. Even if the write is blocked (RLS / concurrent insert),
  // return an in-memory row so THIS call still proceeds.
  try {
    await ctx.db.insert("install_metadata", {
      shopDomain: domain,
      connectionId: account.id ?? null,
      apiVersion: API_VERSION,
      grantedOAuthScopes: [],
      connectionStatus: "connected",
      installedAt: new Date(),
      inventoryLocationAllowlist: null,
      unfulfilledThresholdHours: 24,
      consecutiveScopeMirrorFailures: 0,
    })
    ctx.logger?.warn?.(
      "self-healed missing install_metadata from active shop connection (connect event was lost)",
      { shopDomain: domain },
    )
  } catch {
    // Unique-violation race or read-only context — fall through to a reload,
    // then to the in-memory synthesis below.
  }

  const reloaded = await loadInstallMetadata(ctx)
  if (reloaded?.shopDomain) return reloaded
  return inMemoryInstallMetadata(ctx, domain, account)
}

/**
 * `ctx.connections` has two runtime shapes, and `getShopifyClient` is reached
 * from both contexts:
 *   - FLAT group `{ getAccounts(name), ... }` — what the sandbox worker AND the
 *     in-process executor actually build (the bridge methods
 *     `connections_getAccounts` / ... grouped by prefix).
 *   - RECORD `{ [name]: { getAccounts(), ... } }` — the `@liaison/app-sdk`
 *     type and the unit-test mock (`apps/test-helpers`).
 * Normalize to one accessor so the resolver is correct under both. Only the
 * account list is read: the token itself stays host-side (`shopFetchAuth`).
 */
export function resolveShopConnection(ctx: AppContext): {
  getAccounts: () => Promise<ConnAccount[]>
} | null {
  const conns = ctx.connections as unknown
  const flat = conns as {
    getAccounts?: (name: string) => Promise<ConnAccount[]>
  }
  if (typeof flat.getAccounts === "function") {
    return {
      // The flat sandbox bridge call passes a primitive arg, so the host shim's
      // `__wrap` takes its RAW path and returns the JSON-stringified account list
      // unparsed (only object/array *args* trigger result parsing). Parse here so
      // the result is an array regardless of which shape produced it.
      getAccounts: async () => {
        const raw = (await flat.getAccounts!(SHOP_CONNECTION)) as unknown
        return (typeof raw === "string" ? JSON.parse(raw) : (raw ?? [])) as ConnAccount[]
      },
    }
  }
  const record = conns as Record<string, { getAccounts?: () => Promise<ConnAccount[]> } | undefined>
  const shop = record?.[SHOP_CONNECTION]
  if (shop && typeof shop.getAccounts === "function") {
    return {
      getAccounts: () => shop.getAccounts!(),
    }
  }
  return null
}

/**
 * The `ctx.fetch` auth that sends the shop account's offline token as
 * `X-Shopify-Access-Token`. The host adds it (only to `*.myshopify.com`, the
 * connection's own hosts) and redacts it from the answer.
 */
export function shopFetchAuth(identifier: string): {
  connection: string
  identifier: string
  scheme: "header:X-Shopify-Access-Token"
} {
  return { connection: SHOP_CONNECTION, identifier, scheme: "header:X-Shopify-Access-Token" }
}

/**
 * Build a Shopify client bound to the org's offline-token connection.
 * Throws `INSTALL_METADATA_MISSING` or `CONNECTION_MISSING` when prerequisites
 * are absent.
 *
 * The bucket-aware throttle watermark is persisted per `(orgId, shopDomain)` for
 * `THROTTLE_TTL_MS` so back-pressure survives across tool invocations — without
 * it, each fresh client would reset the watermark and negate the throttle.
 */
export async function getShopifyClient(
  ctx: AppContext,
  opts: {
    /** Per-request deadline (tightens the host's default); set, the client also fails fast on 429. */
    timeoutMs?: number
  } = {},
): Promise<ShopifyClient> {
  const row = await resolveInstallMetadata(ctx)
  const domain = row?.shopDomain
  if (!domain) throw makeError("INSTALL_METADATA_MISSING", "install_metadata row not found")

  const shopConn = resolveShopConnection(ctx)
  if (!shopConn) throw makeError("CONNECTION_MISSING", "ctx.connections.shop is unavailable")
  const accounts = await shopConn.getAccounts()
  const account = pickShopAccount(accounts)
  if (!account) throw makeError("CONNECTION_MISSING", "No Shopify connection")
  const auth = shopFetchAuth(account.identifier)
  const fetchImpl: ShopifyFetch = async (req) => {
    const res = await ctx.fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      auth,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    })
    return { status: res.status, headers: res.headers, body: res.body }
  }
  // P2a: when the test harness (or a future multi-region setup) writes
  // `apiBaseUrl` into `install_metadata`, route Admin API calls there
  // instead of the canonical `https://<shop>.myshopify.com` host. The
  // value is written post-install by the test fixture; in production it
  // stays null and the canonical host is used.
  const baseUrlOverride =
    typeof row?.apiBaseUrl === "string" && row.apiBaseUrl.length > 0 ? row.apiBaseUrl : undefined

  // Restore the persisted throttle watermark (if still fresh) and keep it
  // updated as this client makes calls, so back-pressure carries across
  // invocations without caching the client's per-call fetch closure.
  const orgId = typeof ctx.orgId === "string" && ctx.orgId.length > 0 ? ctx.orgId : null
  const cacheKey = orgId ? `${orgId}:${domain.toLowerCase()}` : null
  const cached = cacheKey ? throttleWatermarks.get(cacheKey) : undefined
  const initialThrottleAt = cached && cached.expiresAt > Date.now() ? cached.at : 0
  return new ShopifyClient({
    shop: domain.replace(/\.myshopify\.com$/i, ""),
    fetch: fetchImpl,
    baseUrlOverride,
    initialThrottleAt,
    failFast: !!opts.timeoutMs,
    onThrottleChange: (at) => {
      if (!cacheKey) return
      const now = Date.now()
      pruneExpiredWatermarks(now)
      throttleWatermarks.set(cacheKey, { at, expiresAt: now + THROTTLE_TTL_MS })
    },
  })
}

/**
 * Tool-dispatch-level normalization: not-connected is an EXPECTED state, not a
 * crash. The kernel redacts sandboxed handler throws in production ("Tool
 * execution failed"), which hides the actionable "connect Shopify in app
 * settings" message from the agent/UI. `getShopifyClient` (and every read/
 * mutation/job built on it, ~30 tool handlers across reads.ts, mutations.ts,
 * analytics.ts, etc.) throws a typed `ClientError` for the missing-connection
 * case — rather than touching every call site's heterogeneous return type,
 * wrap each exported handler ONCE at the barrel (handlers.ts) with this HOF so
 * the not-connected throw is caught at the single point where every tool
 * result funnels through the same manifest-resolved shape (a plain object),
 * and merged in as `{ error: { code: "shopify_not_connected", message } }` —
 * same envelope contract as boxtal/ads. Any OTHER thrown error (a real bug, a
 * downstream Shopify API failure) still propagates as a throw.
 *
 * getShopifyClient itself keeps throwing: get-client.test.ts pins the
 * throwing contract, and background jobs (scan-unfulfilled, etc.) already
 * catch it themselves to degrade silently rather than surface an envelope.
 */
export function withShopifyConnectionEnvelope<Args extends unknown[], R>(
  fn: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R | { error: { code: string; message: string } }> {
  return async (...args: Args) => {
    try {
      return await fn(...args)
    } catch (err) {
      if (isClientError(err)) {
        return { error: { code: "shopify_not_connected", message: err.message } }
      }
      throw err
    }
  }
}
