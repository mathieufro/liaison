// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B5 — OAuth connection lifecycle.
//
// The kernel owns the OAuth dance (per liaison/apps/api/src/modules/apps/
// connections/service.ts:415,513). On completion the kernel inserts a row
// in kernel.connected_accounts and emits `kernel/connected_account:create`.
// The Shopify app subscribes to that event (via `events.subscribes` in
// app.manifest.json) and writes its own `install_metadata` row.
//
// On `kernel/connected_account:disconnect` (e.g. the user revokes the app
// in Shopify → Shopify sends `app/uninstalled` → the connections module
// flips the row to `status=disconnected`), the same handler flips our
// install_metadata.connectionStatus back to `disconnected`. The Shopify
// `app/uninstalled` webhook itself is registered separately (Task B9) for
// the case where Shopify is our source of truth on uninstall.
import type { AppContext } from "@liaison/app-sdk"
import { API_VERSION, SHOPIFY_DOMAIN_RE } from "./lib/constants"
import { emitEvent } from "./lib/emit"
import { ensureInstallMetadata, getShopifyClient, resolveShopConnection, shopFetchAuth } from "./lib/get-client"
import { loadInstallMetadata } from "./lib/install-metadata"
import { ShopifyClient, type ShopifyFetch } from "./lib/shopify-client"

/**
 * Map from kernel webhook endpoint slug (kebab, matches `app.manifest.json#webhooks` keys
 * and the kernel route segment) to Shopify's canonical topic identifier (slash-form,
 * matches the `Shopify-Topic` header and the `topic` argument on
 * `webhookSubscriptionCreate`). Keys are exactly the endpoint route names; values are
 * the Shopify canonical strings.
 */
const TOPIC_ENDPOINT_TABLE: ReadonlyArray<{ endpoint: string; shopifyTopic: string }> = [
  { endpoint: "orders-create", shopifyTopic: "orders/create" },
  { endpoint: "orders-updated", shopifyTopic: "orders/updated" },
  { endpoint: "orders-fulfilled", shopifyTopic: "orders/fulfilled" },
  { endpoint: "orders-cancelled", shopifyTopic: "orders/cancelled" },
  { endpoint: "customers-create", shopifyTopic: "customers/create" },
  { endpoint: "customers-update", shopifyTopic: "customers/update" },
  { endpoint: "customers-delete", shopifyTopic: "customers/delete" },
  { endpoint: "refunds-create", shopifyTopic: "refunds/create" },
  // Shopify's topic for a return being requested is `returns/request`
  // (enum `RETURNS_REQUEST`); there is NO `returns/request_created` topic, so
  // registering it made `webhookSubscriptionCreate` reject the whole call with
  // "Variable $topic … provided invalid value" (observed live). The kebab
  // endpoint slug stays `returns-request-created` — it's the internal route +
  // manifest key, decoupled from the Shopify topic string.
  { endpoint: "returns-request-created", shopifyTopic: "returns/request" },
  { endpoint: "fulfillments-create", shopifyTopic: "fulfillments/create" },
  { endpoint: "inventory-levels-update", shopifyTopic: "inventory_levels/update" },
  { endpoint: "products-create", shopifyTopic: "products/create" },
  { endpoint: "products-update", shopifyTopic: "products/update" },
  { endpoint: "draft-orders-create", shopifyTopic: "draft_orders/create" },
  { endpoint: "draft-orders-update", shopifyTopic: "draft_orders/update" },
  { endpoint: "draft-orders-delete", shopifyTopic: "draft_orders/delete" },
  { endpoint: "app-uninstalled", shopifyTopic: "app/uninstalled" },
]

const WEBHOOK_SUBSCRIPTION_LIST = `
  query WebhookSubscriptionList($first: Int!, $after: String) {
    webhookSubscriptions(first: $first, after: $after) {
      edges {
        node {
          id
          topic
          endpoint {
            __typename
            ... on WebhookHttpEndpoint { callbackUrl }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

const WEBHOOK_SUBSCRIPTION_DELETE = `
  mutation WebhookSubscriptionDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`

/** Page cap for the subscription list (250 per page): a store holding more is
 *  not one this app's own registrations explain, and the rest is left alone. */
const SUBSCRIPTION_LIST_MAX_PAGES = 20

const WEBHOOK_SUBSCRIPTION_CREATE = `
  mutation WebhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`

interface KernelConnectionEventData {
  id: string
  appName: string
  orgId?: string
  connectionName: string
  ownerType: "user" | "org"
  ownerId: string | null
  identifier: string
  grantedOAuthScopes?: string[]
  /** Kernel public base URL — injected by `connections/service.ts` so the
   *  app can build webhook callback URLs that loop back here. */
  kernelPublicBaseUrl?: string
}

interface KernelConnectionEvent {
  app: "kernel"
  entity: "connected_account"
  action: "create" | "disconnect"
  orgId: string
  actorId?: string
  data: KernelConnectionEventData | { id: string; appName: string }
}

interface InstallMetadataRow {
  id: string
  shopDomain: string
  connectionId: string
  apiVersion: string
  connectionStatus: "connected" | "disconnected"
  grantedOAuthScopes?: unknown
}

/**
 * Build a Shopify GraphQL client bound to the freshly-OAuth'd shop. Kept
 * separate from the read-path `getShopifyClient` because the OAuth-establishment
 * path takes the shop domain explicitly (it must not depend on the read-path's
 * `install_metadata` lookup / `apiBaseUrl` override, which may not exist yet).
 * For the test harness, accept a `LIAISON_TEST_SHOPIFY_BASE_URL` env var as
 * a fallback — it has no production effect (unset by default).
 *
 * Connection resolution goes through the shared `resolveShopConnection` so it is
 * correct under BOTH `ctx.connections` shapes. The previous direct
 * `ctx.connections.shop` read only matched the RECORD shape (the `@liaison/app-sdk`
 * type + unit-test mock); in the QuickJS sandbox `ctx.connections` is the FLAT
 * group `{ getToken(name, id), getAccounts(name) }`, so `.shop` was always
 * `undefined` → null client → `subscribeShopifyTopics` registered ZERO webhooks
 * (silently, via a sandbox-swallowed warn) → Shopify delivered nothing →
 * order reconciliation never fired. Resolve the org account → token exactly the
 * way every other (working) Shopify path does.
 */
async function buildShopifyClient(
  ctx: AppContext,
  shopDomain: string,
  identifier: string,
): Promise<ShopifyClient | null> {
  const shopConn = resolveShopConnection(ctx)
  if (!shopConn) return null
  let accountIdentifier: string
  try {
    const accounts = await shopConn.getAccounts()
    const account = accounts.find((a) => a.ownerType === "org") ?? accounts[0]
    accountIdentifier = account?.identifier ?? identifier
  } catch {
    return null
  }
  // The token stays host-side: the fetch names the account, the host adds it.
  const auth = shopFetchAuth(accountIdentifier)
  const fetchImpl: ShopifyFetch = async (req) => {
    const res = await ctx.fetch(req.url, { method: req.method, headers: req.headers, body: req.body, auth })
    return { status: res.status, headers: res.headers, body: res.body }
  }
  // Bundled-app handlers run inside the QuickJS sandbox, where `process` is NOT
  // defined — an unguarded `process.env` read throws ReferenceError and kills the
  // whole connection flow (observed live: "subscribeShopifyTopics top-level failure:
  // 'process' is not defined" → ZERO webhook topics registered). The test base-URL
  // redirect only applies to Node-hosted unit tests; in the sandbox (chaos + prod)
  // it's correctly absent → use the real Shopify base URL. `typeof` on an undeclared
  // global is safe (returns "undefined" without throwing).
  const envOverride =
    typeof process !== "undefined" ? process.env?.LIAISON_TEST_SHOPIFY_BASE_URL : undefined
  const baseUrlOverride = envOverride && envOverride.length > 0 ? envOverride : undefined
  return new ShopifyClient({
    shop: shopDomain.replace(/\.myshopify\.com$/i, ""),
    fetch: fetchImpl,
    baseUrlOverride,
  })
}

interface ExistingSubscription {
  id: string
  topic: string
  endpoint?: { __typename?: string; callbackUrl?: string }
}

/**
 * The callback URL prefix of every subscription THIS org registers on a store:
 * `${base}/webhooks/${orgId}/shopify/`. Cleanup matches on it so it never
 * touches a subscription of another org, another instance or another app on the
 * same store.
 */
export function orgCallbackPrefix(kernelPublicBaseUrl: string, orgId: string): string {
  return `${kernelPublicBaseUrl.replace(/\/$/, "")}/webhooks/${orgId}/shopify/`
}

/** Every webhook subscription on the store, following the cursor. Throws on a failed page. */
async function listWebhookSubscriptions(client: ShopifyClient): Promise<ExistingSubscription[]> {
  const out: ExistingSubscription[] = []
  let after: string | null = null
  for (let page = 0; page < SUBSCRIPTION_LIST_MAX_PAGES; page++) {
    const data: {
      webhookSubscriptions?: {
        edges?: Array<{ node: ExistingSubscription }>
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
      }
    } = await client.query(WEBHOOK_SUBSCRIPTION_LIST, { first: 250, after })
    const conn = data.webhookSubscriptions
    for (const e of conn?.edges ?? []) out.push(e.node)
    const next = conn?.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null
    if (!next) break
    after = next
  }
  return out
}

/** Delete subscriptions by id. Never throws: each failure is counted. */
async function deleteWebhookSubscriptions(
  ctx: AppContext,
  client: ShopifyClient,
  subs: ExistingSubscription[],
  shopDomain: string,
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0
  let failed = 0
  for (const sub of subs) {
    try {
      const result = await client.query<{
        webhookSubscriptionDelete?: {
          deletedWebhookSubscriptionId?: string | null
          userErrors?: Array<{ field?: string[]; message: string }>
        }
      }>(WEBHOOK_SUBSCRIPTION_DELETE, { id: sub.id })
      const errs = result.webhookSubscriptionDelete?.userErrors ?? []
      if (errs.length > 0) {
        failed += 1
        ctx.logger?.warn?.("webhookSubscriptionDelete userErrors", {
          shopDomain,
          id: sub.id,
          topic: sub.topic,
          errs,
        })
      } else {
        deleted += 1
      }
    } catch (err) {
      failed += 1
      ctx.logger?.warn?.("webhookSubscriptionDelete threw", {
        shopDomain,
        id: sub.id,
        topic: sub.topic,
        err: String(err),
      })
    }
  }
  return { deleted, failed }
}

/**
 * Idempotently subscribe to every webhook topic the manifest declares. For each
 * topic in TOPIC_ENDPOINT_TABLE:
 *   - if a subscription already exists pointing at `<callbackBase>/<endpoint>`, skip;
 *   - otherwise issue `webhookSubscriptionCreate` against Shopify Admin API.
 *
 * Topic strings sent to Shopify use the canonical slash form (`orders/create`)
 * which is also the form Shopify echoes in the `X-Shopify-Topic` header. The
 * kernel webhook route requires the kebab slug (`orders-create`) — the table
 * above maps between them.
 *
 * Failures during subscription are logged but do not throw — re-OAuth will
 * retry. (The kernel webhook router 404s on unsubscribed topics anyway.)
 */
export async function subscribeShopifyTopics(
  ctx: AppContext,
  args: { shopDomain: string; orgId: string; identifier: string; kernelPublicBaseUrl: string },
): Promise<{ created: string[]; skipped: string[]; failed: string[] }> {
  const out = { created: [] as string[], skipped: [] as string[], failed: [] as string[] }
  const client = await buildShopifyClient(ctx, args.shopDomain, args.identifier)
  if (!client) {
    ctx.logger?.warn?.("subscribeShopifyTopics: ShopifyClient unavailable; skipping", {
      shopDomain: args.shopDomain,
    })
    return out
  }
  const base = args.kernelPublicBaseUrl.replace(/\/$/, "")
  // Convert "shopify-topic" → enum form WebhookSubscriptionTopic expects
  // (`ORDERS_CREATE`, `CUSTOMERS_DELETE`, etc.). Slash → underscore, uppercase.
  const enumOf = (t: string) => t.replace(/\//g, "_").toUpperCase()

  // Existing subscriptions, every page (a store can hold other apps' and other
  // instances' subscriptions besides ours).
  let existing: ExistingSubscription[] = []
  let listed = false
  try {
    existing = await listWebhookSubscriptions(client)
    listed = true
  } catch (err) {
    ctx.logger?.warn?.("subscribeShopifyTopics: webhookSubscriptions query failed", {
      err: String(err),
    })
  }

  // This org's own stale subscriptions go first: a callback under this org's
  // prefix that is not a current (topic, endpoint) pair (a topic since renamed or
  // dropped), or a duplicate of one. Subscriptions of other orgs, other hosts
  // and other apps never match the prefix and are left alone.
  if (listed) {
    const prefix = orgCallbackPrefix(base, args.orgId)
    const wanted = new Set(
      TOPIC_ENDPOINT_TABLE.map(({ endpoint, shopifyTopic }) => `${enumOf(shopifyTopic)} ${prefix}${endpoint}`),
    )
    const kept = new Set<string>()
    const stale: ExistingSubscription[] = []
    for (const sub of existing) {
      const url = sub.endpoint?.callbackUrl
      if (!url?.startsWith(prefix)) continue
      const key = `${sub.topic} ${url}`
      if (wanted.has(key) && !kept.has(key)) kept.add(key)
      else stale.push(sub)
    }
    if (stale.length > 0) {
      const { deleted, failed } = await deleteWebhookSubscriptions(
        ctx,
        client,
        stale,
        args.shopDomain,
      )
      const staleIds = new Set(stale.map((s) => s.id))
      existing = existing.filter((s) => !staleIds.has(s.id))
      const log = failed > 0 ? ctx.logger?.warn : ctx.logger?.info
      log?.("subscribeShopifyTopics: removed this org's stale webhook subscriptions", {
        shopDomain: args.shopDomain,
        stale: stale.length,
        deleted,
        failed,
      })
    }
  }

  for (const { endpoint, shopifyTopic } of TOPIC_ENDPOINT_TABLE) {
    // Cluster-2 fix: the kernel mounts webhookRoutes at `/webhooks` (app.ts),
    // route `/:orgId/:appName/:endpointName` (webhooks/routes.ts) — there is
    // NO `/api` prefix. Registering `/api/webhooks/...` caused every real
    // Shopify delivery to 404. The full callback path is
    // `${base}/webhooks/${orgId}/shopify/${endpoint}`.
    const callbackUrl = `${base}/webhooks/${args.orgId}/shopify/${endpoint}`
    const already = existing.find(
      (s) => s.topic === enumOf(shopifyTopic) && s.endpoint?.callbackUrl === callbackUrl,
    )
    if (already) {
      out.skipped.push(shopifyTopic)
      continue
    }
    try {
      const result = await client.query<{
        webhookSubscriptionCreate: {
          webhookSubscription: { id: string } | null
          userErrors: Array<{ field?: string[]; message: string }>
        }
      }>(WEBHOOK_SUBSCRIPTION_CREATE, {
        topic: enumOf(shopifyTopic),
        webhookSubscription: { callbackUrl, format: "JSON" },
      })
      const errs = result.webhookSubscriptionCreate?.userErrors ?? []
      if (errs.length > 0) {
        ctx.logger?.warn?.("webhookSubscriptionCreate userErrors", {
          shopifyTopic,
          callbackUrl,
          errs,
        })
        out.failed.push(shopifyTopic)
      } else {
        out.created.push(shopifyTopic)
      }
    } catch (err) {
      ctx.logger?.warn?.("webhookSubscriptionCreate threw", {
        shopifyTopic,
        callbackUrl,
        err: String(err),
      })
      out.failed.push(shopifyTopic)
    }
  }
  return out
}

/**
 * `webhooks_repair` tool (manifest.tools.webhooks_repair.handler) — re-run
 * `subscribeShopifyTopics` for the ALREADY-connected shop, without going
 * through OAuth again. `onConnectionEstablished` only fires on a fresh
 * connect/reconnect event, so an app upgrade that adds new webhook topics
 * (e.g. the draft_orders/* set) never reaches an already-connected prod shop
 * until the customer disconnects and reconnects. This tool lets an admin (or
 * the deploy runbook) repair the subscription set in place.
 *
 * `subscribeShopifyTopics` is idempotent (it skips any topic already pointed
 * at the correct callback URL), so calling this after every topic-adding
 * release is safe and only creates the missing subscriptions.
 *
 * The kernel callback base URL is not persisted anywhere the app can read it
 * directly, so when `callback_base_url` is not passed we recover it from an
 * EXISTING subscription's `callbackUrl` (every prior topic was registered
 * against `${kernelPublicBaseUrl}/webhooks/${orgId}/shopify/${endpoint}` — see
 * `subscribeShopifyTopics` above), stripping everything from `/webhooks/`
 * onward. A shop with zero existing subscriptions (should not happen for an
 * already-connected install, but tolerate it) has no base to recover from and
 * must pass `callback_base_url` explicitly.
 */
export async function webhooksRepairHandler(
  params: { callback_base_url?: string },
  ctx: AppContext,
): Promise<
  | { status: "completed"; created: string[]; skipped: string[]; failed: string[] }
  | { status: "error"; error: { code: string; message: string } }
> {
  const meta = await loadInstallMetadata(ctx)
  const shopDomain = meta?.shopDomain
  if (!shopDomain) {
    return {
      status: "error",
      error: { code: "shop_not_connected", message: "no connected Shopify shop found" },
    }
  }

  let kernelPublicBaseUrl: string | null =
    typeof params.callback_base_url === "string" && params.callback_base_url.length > 0
      ? params.callback_base_url.replace(/\/$/, "")
      : null

  if (!kernelPublicBaseUrl) {
    try {
      const client = await getShopifyClient(ctx)
      // Only this org's own subscriptions say where this instance lives: a store
      // can also hold other orgs' or other instances' callbacks.
      const marker = `/webhooks/${ctx.orgId}/shopify/`
      for (const sub of await listWebhookSubscriptions(client)) {
        const url = sub.endpoint?.callbackUrl
        const idx = url ? url.indexOf(marker) : -1
        if (url && idx >= 0) {
          kernelPublicBaseUrl = url.slice(0, idx)
          break
        }
      }
    } catch (err) {
      ctx.logger?.warn?.(
        "webhooksRepairHandler: could not derive callback base from existing subscriptions",
        { err: String(err) },
      )
    }
  }

  if (!kernelPublicBaseUrl) {
    return {
      status: "error",
      error: {
        code: "callback_base_unknown",
        message:
          "could not determine the callback base URL from existing webhook subscriptions; pass callback_base_url explicitly",
      },
    }
  }

  const result = await subscribeShopifyTopics(ctx, {
    shopDomain,
    orgId: ctx.orgId,
    identifier: shopDomain,
    kernelPublicBaseUrl,
  })
  return { status: "completed", ...result }
}

/**
 * Subscribed via `events.subscribes["kernel/connected_account:create"]`.
 * Writes `install_metadata` so the rest of the app (settings panel, tools,
 * webhook routing) can read the shop domain + apiVersion + connection status
 * without reaching back into the kernel. Also subscribes to every Shopify
 * webhook topic declared in the manifest (C1 fix).
 */
export async function onConnectionEstablished(
  event: KernelConnectionEvent,
  ctx: AppContext,
): Promise<void> {
  if (event.data?.appName !== "shopify") return
  const data = event.data as KernelConnectionEventData
  const shopDomain = data.identifier
  if (!SHOPIFY_DOMAIN_RE.test(shopDomain)) {
    ctx.logger?.warn?.("ignoring connection event with non-Shopify identifier", { shopDomain })
    return
  }

  const grantedOAuthScopes = Array.isArray(data.grantedOAuthScopes)
    ? data.grantedOAuthScopes
    : []

  const existing = (await ctx.db.findMany("install_metadata", {
    where: { shopDomain },
    limit: 1,
  })) as InstallMetadataRow[]

  if (existing.length > 0) {
    // Idempotent re-OAuth — flip status and refresh the connection pointer.
    // A reconcile replay carries NO token data (empty grantedOAuthScopes), so
    // only overwrite the recorded grant when the event actually carries one —
    // otherwise a reconcile would erase the scopes a real OAuth just recorded.
    const row = existing[0] as InstallMetadataRow
    await ctx.db.update("install_metadata", row.id, {
      connectionId: data.id,
      connectionStatus: "connected",
      ...(grantedOAuthScopes.length > 0 ? { grantedOAuthScopes } : {}),
      apiVersion: API_VERSION,
      consecutiveScopeMirrorFailures: 0,
    })
  } else {
    await ctx.db.insert("install_metadata", {
      shopDomain,
      connectionId: data.id,
      apiVersion: API_VERSION,
      grantedOAuthScopes,
      connectionStatus: "connected",
      installedAt: new Date(),
      inventoryLocationAllowlist: null,
      unfulfilledThresholdHours: 24,
      consecutiveScopeMirrorFailures: 0,
    })
  }
  await announceConnectionChange(ctx, shopDomain, "connected")

  // C1 fix: register webhook subscriptions with Shopify so deliveries flow.
  // Without this, every spec success criterion that depends on webhook
  // delivery (eager customer sync, attention items, Phase 17 contract,
  // periodic reconcile) is dead. The kernel injects kernelPublicBaseUrl
  // into the event data so we can build absolute callback URLs back into
  // /api/webhooks/<orgId>/shopify/<endpoint>.
  if (data.kernelPublicBaseUrl) {
    try {
      const orgId = (event as { orgId?: string }).orgId ?? data.orgId ?? ctx.orgId
      const sub = await subscribeShopifyTopics(ctx, {
        shopDomain,
        orgId,
        identifier: shopDomain,
        kernelPublicBaseUrl: data.kernelPublicBaseUrl,
      })
      // Defense-in-depth: SURFACE the registration outcome. A registration miss
      // used to be invisible (the inner warns were swallowed by an undefined
      // ctx.logger — now aliased), letting Shopify deliver nothing while the run
      // looked healthy. A fully-empty result (nothing created AND nothing already
      // subscribed) means deliveries will never arrive — log it loudly.
      if (sub.created.length === 0 && sub.skipped.length === 0) {
        ctx.logger?.warn?.(
          "subscribeShopifyTopics registered NO webhook topics — Shopify deliveries will not arrive",
          { shopDomain, orgId, created: sub.created, skipped: sub.skipped, failed: sub.failed },
        )
      } else {
        ctx.logger?.info?.("subscribeShopifyTopics complete", {
          shopDomain,
          created: sub.created.length,
          skipped: sub.skipped.length,
          failed: sub.failed,
        })
      }
    } catch (err) {
      // Failures are logged inside the function; re-OAuth retries.
      ctx.logger?.warn?.("subscribeShopifyTopics top-level failure", { err: String(err) })
    }
  } else {
    ctx.logger?.warn?.("kernelPublicBaseUrl missing on connected_account:create event; webhook subscription skipped")
  }
}

/**
 * Subscribed via `events.subscribes["kernel/connected_account:disconnect"]`.
 * Flips connectionStatus to `disconnected`. Background sync jobs read the
 * status before running (Task B11/B12) so this single flip stops the work
 * without coupling to the job system here.
 */
export async function onConnectionDisconnected(
  event: KernelConnectionEvent,
  ctx: AppContext,
): Promise<void> {
  if (event.data?.appName !== "shopify") return
  const connectionId = event.data.id
  // Heal first: a connected shop with no row (the connect event was lost)
  // must still get a row to flip — otherwise this silently no-ops and the
  // app keeps believing it is connected after the kernel disconnect fires.
  await ensureInstallMetadata(ctx)
  const rows = (await ctx.db.findMany("install_metadata", {
    where: { connectionId },
    limit: 1,
  })) as InstallMetadataRow[]
  const row = rows[0]
  if (!row) return
  await ctx.db.update("install_metadata", row.id, {
    connectionStatus: "disconnected",
  })
  await announceConnectionChange(ctx, row.shopDomain, "disconnected")
}

/** Params of the kernel's `beforeDisconnect` hook (connections/before-disconnect.ts). */
interface BeforeDisconnectEvent {
  id: string
  orgId?: string
  appName: string
  connectionName: string
  identifier: string
  kernelPublicBaseUrl?: string
  reason?: "disconnect" | "org_purge"
}

/**
 * The shop connection's `beforeDisconnect` hook (manifest
 * `connections.shop.beforeDisconnect`). The kernel runs it before a disconnect,
 * and before an org purge deletes the connection, while the token still works:
 * it deletes every webhook subscription this org registered on the store
 * (`${base}/webhooks/${orgId}/shopify/...`). After the disconnect the token is
 * gone and nothing could reach them again, so each disconnect left 17 dead
 * subscriptions on the store. Subscriptions of other orgs or other hosts are
 * never touched. Best effort but loud: a failure is logged with the store and
 * the count left behind, and never fails the disconnect.
 */
export async function onBeforeDisconnect(
  event: BeforeDisconnectEvent,
  ctx: AppContext,
): Promise<{ deleted: number; failed: number }> {
  const out = { deleted: 0, failed: 0 }
  if (event?.appName !== "shopify" || event.connectionName !== "shop") return out
  const shopDomain = event.identifier
  if (!SHOPIFY_DOMAIN_RE.test(shopDomain)) return out
  if (!event.kernelPublicBaseUrl) {
    ctx.logger?.warn?.("beforeDisconnect: no callback base; webhook subscriptions left on the store", {
      shopDomain,
    })
    return out
  }
  const orgId = event.orgId ?? ctx.orgId
  const prefix = orgCallbackPrefix(event.kernelPublicBaseUrl, orgId)
  try {
    const client = await buildShopifyClient(ctx, shopDomain, shopDomain)
    if (!client) {
      ctx.logger?.warn?.(
        "beforeDisconnect: store unreachable (no token); this org's webhook subscriptions are left on it",
        { shopDomain, prefix },
      )
      return out
    }
    const ours = (await listWebhookSubscriptions(client)).filter((s) =>
      s.endpoint?.callbackUrl?.startsWith(prefix),
    )
    if (ours.length === 0) return out
    const result = await deleteWebhookSubscriptions(ctx, client, ours, shopDomain)
    if (result.failed > 0) {
      ctx.logger?.warn?.("beforeDisconnect: some webhook subscriptions could not be deleted", {
        shopDomain,
        found: ours.length,
        deleted: result.deleted,
        failed: result.failed,
      })
    } else {
      ctx.logger?.info?.("beforeDisconnect: deleted this org's webhook subscriptions", {
        shopDomain,
        deleted: result.deleted,
      })
    }
    return result
  } catch (err) {
    ctx.logger?.warn?.("beforeDisconnect: webhook subscription cleanup failed", {
      shopDomain,
      prefix,
      err: String(err),
    })
    return out
  }
}

/**
 * Tells open views the recorded connection changed (`shopify:connection`).
 *
 * The kernel stores the grant and broadcasts `connected_account:create` BEFORE
 * this app's subscriber runs (the WebSocket fan-out is a durable outbox
 * consumer, app subscribers come after it), so a settings page that reloads
 * or refetches on the kernel event can still read the OLD `install_metadata`
 * grant and keep showing "Permissions update required". This event goes out
 * only once the row holds the new state, so a view that refetches on it reads
 * the fresh grant in every shell (browser redirect, desktop system browser,
 * mobile authentication session).
 */
async function announceConnectionChange(
  ctx: AppContext,
  shopDomain: string,
  status: "connected" | "disconnected",
): Promise<void> {
  try {
    await emitEvent(ctx, { entity: "connection", action: "updated", data: { shopDomain, status } })
  } catch (err) {
    // A lost refresh hint must never fail the connect/disconnect bookkeeping.
    ctx.logger?.warn?.("connection:updated emit failed", { err: String(err) })
  }
}
