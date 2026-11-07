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
// These tests cover the connection-event handler only — no live OAuth
// exchange, no live Shopify call. The handler runs inside the sandbox; we
// mock the AppContext bridge surfaces it touches.
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import {
  onBeforeDisconnect,
  onConnectionDisconnected,
  onConnectionEstablished,
  subscribeShopifyTopics,
  webhooksRepairHandler,
} from "./connection"

const API_VERSION = "2026-04"
const SHOP = "demo.myshopify.com"
const ORG = "00000000-0000-0000-0000-000000000001"
const USER = "00000000-0000-0000-0000-000000000002"
const ACCOUNT_ID = "00000000-0000-0000-0000-000000000003"

type StoredRow = { id: string } & Record<string, unknown>

interface MockCtx {
  inserts: Array<{ entity: string; data: Record<string, unknown> }>
  updates: Array<{ entity: string; id: string; data: Record<string, unknown> }>
  rows: Map<string, StoredRow[]>
  emits: Array<Parameters<AppContext["emit"]>[0]>
}

function makeMockCtx(): { ctx: AppContext; spy: MockCtx } {
  const spy: MockCtx = {
    inserts: [],
    updates: [],
    rows: new Map(),
    emits: [],
  }
  let nextId = 100
  const seedRow = (entity: string, row: StoredRow) => {
    const arr = spy.rows.get(entity) ?? []
    arr.push(row)
    spy.rows.set(entity, arr)
  }
  const ctx = {
    userId: USER,
    orgId: ORG,
    db: {
      findMany: async (
        entity: string,
        opts?: { where?: Record<string, unknown> },
      ): Promise<unknown[]> => {
        const all = spy.rows.get(entity) ?? []
        if (!opts?.where) return all
        return all.filter((r) =>
          Object.entries(opts.where ?? {}).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
        )
      },
      findOne: async (entity: string, id: string) => {
        const all = spy.rows.get(entity) ?? []
        return all.find((r) => r.id === id) ?? null
      },
      insert: async (entity: string, data: Record<string, unknown>) => {
        spy.inserts.push({ entity, data })
        const id = `row-${nextId++}`
        const row = Object.assign({}, data, { id }) as StoredRow
        seedRow(entity, row)
        return { id }
      },
      update: async (entity: string, id: string, data: Record<string, unknown>) => {
        spy.updates.push({ entity, id, data })
        const arr = spy.rows.get(entity) ?? []
        const idx = arr.findIndex((r) => r.id === id)
        const existing = idx >= 0 ? arr[idx] : undefined
        if (existing) arr[idx] = Object.assign({}, existing, data, { id }) as StoredRow
      },
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async () => 0,
    },
    emit: async (e: Parameters<AppContext["emit"]>[0]) => {
      spy.emits.push(e)
    },
    enqueueJob: async () => undefined,
    resolveContact: async () => ({}),
    connections: {} as never,
    fetch: async () => ({ status: 200, headers: {}, body: "" }),
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agent_run: async () => "{}",
    realtime_publish: async () => "{}",
    grants_setUserScopes: async () => "{}",
    bulk: {
      fetchToBlob: async () => ({ blobId: "x", sizeBytes: 0 }),
      iterateJsonl: async function* () {},
      deleteBlob: async () => undefined,
    },
  } as unknown as AppContext
  return { ctx, spy }
}

function makeConnectEvent(overrides: Partial<{ appName: string; identifier: string }> = {}) {
  return {
    app: "kernel" as const,
    entity: "connected_account" as const,
    action: "create" as const,
    entityId: ACCOUNT_ID,
    orgId: ORG,
    actorId: USER,
    actorType: "user" as const,
    timestamp: new Date().toISOString(),
    data: {
      id: ACCOUNT_ID,
      orgId: ORG,
      appName: overrides.appName ?? "shopify",
      connectionName: "shop",
      ownerType: "org" as const,
      ownerId: null,
      providerType: "oauth2",
      identifier: overrides.identifier ?? SHOP,
      status: "active",
    },
  }
}

describe("onConnectionEstablished — kernel/connected_account:create", () => {
  it("ignores events for other apps", async () => {
    const { ctx, spy } = makeMockCtx()
    await onConnectionEstablished(makeConnectEvent({ appName: "mail" }), ctx)
    expect(spy.inserts).toHaveLength(0)
    expect(spy.updates).toHaveLength(0)
  })

  it("inserts install_metadata row with shopDomain, apiVersion, connectionStatus=connected", async () => {
    const { ctx, spy } = makeMockCtx()
    await onConnectionEstablished(makeConnectEvent(), ctx)
    expect(spy.inserts).toHaveLength(1)
    expect(spy.inserts[0]!.entity).toBe("install_metadata")
    expect(spy.inserts[0]!.data).toMatchObject({
      shopDomain: SHOP,
      apiVersion: API_VERSION,
      connectionStatus: "connected",
      connectionId: ACCOUNT_ID,
    })
  })

  it("captures grantedOAuthScopes from the event when present", async () => {
    const { ctx, spy } = makeMockCtx()
    const ev = makeConnectEvent()
    ;(ev.data as any).grantedOAuthScopes = ["read_orders", "write_orders"]
    await onConnectionEstablished(ev, ctx)
    expect(spy.inserts[0]!.data.grantedOAuthScopes).toEqual(["read_orders", "write_orders"])
  })

  it("falls back to empty grantedOAuthScopes when absent", async () => {
    const { ctx, spy } = makeMockCtx()
    await onConnectionEstablished(makeConnectEvent(), ctx)
    expect(spy.inserts[0]!.data.grantedOAuthScopes).toEqual([])
  })

  it("is idempotent — repeated OAuth flips existing row back to connected instead of inserting twice", async () => {
    const { ctx, spy } = makeMockCtx()
    // Seed a previously-disconnected row for the same shop.
    await ctx.db.insert("install_metadata", {
      shopDomain: SHOP,
      connectionId: "old-account",
      apiVersion: API_VERSION,
      connectionStatus: "disconnected",
      grantedOAuthScopes: ["read_orders"],
      installedAt: new Date(),
    })
    spy.inserts.length = 0 // reset spy after seed
    await onConnectionEstablished(makeConnectEvent(), ctx)
    expect(spy.inserts).toHaveLength(0)
    expect(spy.updates).toHaveLength(1)
    expect(spy.updates[0]!.entity).toBe("install_metadata")
    expect(spy.updates[0]!.data).toMatchObject({
      connectionStatus: "connected",
      connectionId: ACCOUNT_ID,
    })
  })

  it("validates shop domain against *.myshopify.com — non-matching identifier no-ops", async () => {
    const { ctx, spy } = makeMockCtx()
    await onConnectionEstablished(makeConnectEvent({ identifier: "evil.example.com" }), ctx)
    expect(spy.inserts).toHaveLength(0)
    expect(spy.updates).toHaveLength(0)
  })
})

describe("onConnectionDisconnected — kernel/connected_account:disconnect", () => {
  it("ignores events for other apps", async () => {
    const { ctx, spy } = makeMockCtx()
    await onConnectionDisconnected(
      {
        app: "kernel" as const,
        entity: "connected_account" as const,
        action: "disconnect" as const,
        orgId: ORG,
        data: { id: ACCOUNT_ID, appName: "mail" },
      },
      ctx,
    )
    expect(spy.updates).toHaveLength(0)
  })

  it("flips install_metadata.connectionStatus to disconnected for the matched connectionId", async () => {
    const { ctx, spy } = makeMockCtx()
    await ctx.db.insert("install_metadata", {
      shopDomain: SHOP,
      connectionId: ACCOUNT_ID,
      apiVersion: API_VERSION,
      connectionStatus: "connected",
      grantedOAuthScopes: [],
      installedAt: new Date(),
    })
    spy.updates.length = 0
    await onConnectionDisconnected(
      {
        app: "kernel" as const,
        entity: "connected_account" as const,
        action: "disconnect" as const,
        orgId: ORG,
        data: { id: ACCOUNT_ID, appName: "shopify" },
      },
      ctx,
    )
    expect(spy.updates).toHaveLength(1)
    expect(spy.updates[0]!.data).toMatchObject({ connectionStatus: "disconnected" })
  })

  it("no-ops gracefully when no install_metadata row exists yet", async () => {
    const { ctx, spy } = makeMockCtx()
    await onConnectionDisconnected(
      {
        app: "kernel" as const,
        entity: "connected_account" as const,
        action: "disconnect" as const,
        orgId: ORG,
        data: { id: ACCOUNT_ID, appName: "shopify" },
      },
      ctx,
    )
    expect(spy.updates).toHaveLength(0)
  })

  // X3d — a connected shop whose install_metadata row is missing (the connect
  // event was lost) used to find no row here, no-op, and keep believing it is
  // connected. Heal from the active connection first, then flip.
  it("heals a missing install_metadata row from the active connection, then flips it to disconnected (X3d)", async () => {
    const { ctx, spy } = makeMockCtx()
    ;(ctx as { connections: Record<string, unknown> }).connections = {
      getAccounts: async (_name: string) => [
        { id: ACCOUNT_ID, ownerType: "org", identifier: SHOP },
      ],
      getToken: async (_name: string) => "token",
    }
    await onConnectionDisconnected(
      {
        app: "kernel" as const,
        entity: "connected_account" as const,
        action: "disconnect" as const,
        orgId: ORG,
        data: { id: ACCOUNT_ID, appName: "shopify" },
      },
      ctx,
    )
    const rows = spy.rows.get("install_metadata") ?? []
    expect(rows).toHaveLength(1)
    expect(rows[0]?.shopDomain).toBe(SHOP)
    expect(rows[0]?.connectionStatus).toBe("disconnected")
  })
})

// The settings page cannot refetch on the kernel's `connected_account:create`:
// that broadcast goes out before this subscriber records the new grant, so a
// refetch on it reads the old grant and "Permissions update required" stays up
// after a completed Reconnect. The app announces `connection:updated` once the
// row holds the new state, and the page refetches on that.
describe("connection:updated -> the settings page refetches after the grant is recorded", () => {
  const NEW_GRANT = ["read_orders", "write_orders", "read_all_orders"]

  it("a Reconnect emits connection:updated only after install_metadata holds the new grant", async () => {
    const { ctx, spy } = makeMockCtx()
    await ctx.db.insert("install_metadata", {
      shopDomain: SHOP,
      connectionId: ACCOUNT_ID,
      apiVersion: API_VERSION,
      connectionStatus: "connected",
      grantedOAuthScopes: ["read_orders"],
      installedAt: new Date(),
    })
    let grantAtEmit: unknown = "never emitted"
    ;(ctx as { emit: unknown }).emit = async (e: { entity: string; action: string }) => {
      spy.emits.push(e)
      if (e.entity === "connection" && e.action === "updated") {
        grantAtEmit = (spy.rows.get("install_metadata") ?? [])[0]?.grantedOAuthScopes
      }
    }
    const ev = makeConnectEvent()
    ;(ev.data as { grantedOAuthScopes?: string[] }).grantedOAuthScopes = NEW_GRANT
    await onConnectionEstablished(ev, ctx)
    const updates = spy.emits.filter((e) => e.entity === "connection" && e.action === "updated")
    expect(updates).toHaveLength(1)
    expect(updates[0]!.data).toEqual({ shopDomain: SHOP, status: "connected" })
    expect(grantAtEmit).toEqual(NEW_GRANT)
  })

  it("a first connect emits connection:updated after inserting the row", async () => {
    const { ctx, spy } = makeMockCtx()
    await onConnectionEstablished(makeConnectEvent(), ctx)
    expect(spy.emits).toContainEqual({
      entity: "connection",
      action: "updated",
      entityId: undefined,
      data: { shopDomain: SHOP, status: "connected" },
      metadata: undefined,
    })
  })

  it("a disconnect emits connection:updated with status disconnected", async () => {
    const { ctx, spy } = makeMockCtx()
    await ctx.db.insert("install_metadata", {
      shopDomain: SHOP,
      connectionId: ACCOUNT_ID,
      apiVersion: API_VERSION,
      connectionStatus: "connected",
      grantedOAuthScopes: [],
      installedAt: new Date(),
    })
    await onConnectionDisconnected(
      {
        app: "kernel" as const,
        entity: "connected_account" as const,
        action: "disconnect" as const,
        orgId: ORG,
        data: { id: ACCOUNT_ID, appName: "shopify" },
      },
      ctx,
    )
    const updates = spy.emits.filter((e) => e.entity === "connection" && e.action === "updated")
    expect(updates.map((e) => e.data)).toEqual([{ shopDomain: SHOP, status: "disconnected" }])
  })

  it("a failed emit does not fail the connect bookkeeping", async () => {
    const { ctx, spy } = makeMockCtx()
    ;(ctx as { emit: unknown }).emit = async () => {
      throw new Error("emit guard refused")
    }
    await onConnectionEstablished(makeConnectEvent(), ctx)
    expect(spy.inserts).toHaveLength(1)
  })
})

// C1 — subscribeShopifyTopics: idempotent registration of webhook topics
// against Shopify Admin API. Tests use a fetch spy so we can assert the
// callback URLs sent + verify already-subscribed topics are skipped.
describe("subscribeShopifyTopics", () => {
  function makeCtxWithShopifyFetch(opts: {
    existingSubs?: Array<{ topic: string; callbackUrl: string }>
    failFirstCreate?: boolean
    // "record" (default) = the @liaison/app-sdk type + unit-test mock shape
    // `{ shop: { getToken, getAccounts } }`. "flat" = what the QuickJS sandbox
    // ACTUALLY builds: `{ getToken(name, id), getAccounts(name) }` (bridge methods
    // `connections_getToken`/`connections_getAccounts` grouped by prefix, no
    // per-name member). The flat shape is the real chaos/runtime condition.
    connectionsShape?: "record" | "flat"
  }): { ctx: AppContext; fetches: Array<{ url: string; body?: string }> } {
    const { ctx, spy } = makeMockCtx()
    const fetches: Array<{ url: string; body?: string }> = []
    let createCount = 0
    const shopFetch = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      fetches.push({ url, body: init?.body })
      const body = init?.body ?? ""
      if (body.includes("WebhookSubscriptionList")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: {
              webhookSubscriptions: {
                edges: (opts.existingSubs ?? []).map((s) => ({
                  node: {
                    id: "gid://shopify/WebhookSubscription/1",
                    topic: s.topic,
                    endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: s.callbackUrl },
                  },
                })),
              },
            },
          }),
        }
      }
      if (body.includes("WebhookSubscriptionCreate")) {
        createCount += 1
        if (opts.failFirstCreate && createCount === 1) {
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              data: {
                webhookSubscriptionCreate: {
                  webhookSubscription: null,
                  userErrors: [{ field: ["callbackUrl"], message: "invalid" }],
                },
              },
            }),
          }
        }
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: { id: "gid://shopify/WebhookSubscription/x" },
                userErrors: [],
              },
            },
          }),
        }
      }
      return { status: 200, headers: {}, body: "{}" }
    }
    ;(ctx as { fetch: typeof shopFetch }).fetch = shopFetch
    const accounts = [
      { id: ACCOUNT_ID, ownerType: "org", ownerId: null, identifier: SHOP, displayName: SHOP },
    ]
    ;(ctx as { connections: Record<string, unknown> }).connections =
      opts.connectionsShape === "flat"
        ? {
            // FLAT sandbox shape — keyed by connection NAME as the first arg, no
            // `.shop` member. This is what `buildShopifyClient` sees at runtime.
            getToken: async (_name: string) => "shpat_TEST",
            getAccounts: async (_name: string) => accounts,
          }
        : {
            shop: {
              getToken: async () => "shpat_TEST",
              getAccounts: async () => accounts,
            },
          }
    // Reference spy to keep linter happy; tests below assert via fetches.
    void spy
    return { ctx, fetches }
  }

  it("issues one webhookSubscriptionCreate per declared topic when none exist", async () => {
    const { ctx, fetches } = makeCtxWithShopifyFetch({ existingSubs: [] })
    const result = await subscribeShopifyTopics(ctx, {
      shopDomain: SHOP,
      orgId: ORG,
      identifier: SHOP,
      kernelPublicBaseUrl: "https://kernel.example.com",
    })
    expect(result.created.length).toBe(17)
    expect(result.skipped.length).toBe(0)
    // List + 17 creates = 18 fetches. (17 = 12 original + products-create + products-update + the 3 draft-orders topics.)
    expect(fetches.length).toBe(18)
    // Every create URL points back at the kernel webhook route with the kebab
    // endpoint. Cluster-2: the kernel mounts webhooks at `/webhooks` (NO `/api`
    // prefix), so the callback path is `${base}/webhooks/${orgId}/shopify/...`.
    const createBodies = fetches.filter((f) => (f.body ?? "").includes("WebhookSubscriptionCreate")).map((f) => f.body ?? "")
    expect(createBodies.some((b) => b.includes("/webhooks/" + ORG + "/shopify/orders-create"))).toBe(true)
    expect(createBodies.some((b) => b.includes("/webhooks/" + ORG + "/shopify/customers-delete"))).toBe(true)
    // The wrong `/api/webhooks/...` path must NOT appear anywhere — that was the
    // 404 bug that killed every real Shopify delivery.
    expect(createBodies.some((b) => b.includes("/api/webhooks/"))).toBe(false)
    // Topic enum is the slash form upper-cased (`ORDERS_CREATE`).
    expect(createBodies.some((b) => b.includes(`"topic":"ORDERS_CREATE"`))).toBe(true)
    // Underscore topics convert correctly: `inventory_levels/update` →
    // `INVENTORY_LEVELS_UPDATE` (slash→underscore, then uppercase — the slash
    // separator and the existing underscore both become `_`).
    expect(createBodies.some((b) => b.includes(`"topic":"INVENTORY_LEVELS_UPDATE"`))).toBe(true)
    // And the `app/uninstalled` topic → `APP_UNINSTALLED`.
    expect(createBodies.some((b) => b.includes(`"topic":"APP_UNINSTALLED"`))).toBe(true)
  })

  it("registers webhooks under the FLAT sandbox connections shape (regression: ctx.connections.shop is undefined in QuickJS)", async () => {
    // REGRESSION for the chaos-discovered defect: `buildShopifyClient` read
    // `ctx.connections.shop` directly, which only exists in the RECORD shape.
    // In the QuickJS sandbox `ctx.connections` is the FLAT group
    // `{ getToken(name, id), getAccounts(name) }`, so `.shop` was undefined →
    // null client → ZERO webhookSubscriptionCreate calls → no Shopify deliveries
    // → invoice reconciliation never fired. With the shared `resolveShopConnection`,
    // the flat shape must register every topic exactly like the record shape.
    const { ctx, fetches } = makeCtxWithShopifyFetch({ existingSubs: [], connectionsShape: "flat" })
    const result = await subscribeShopifyTopics(ctx, {
      shopDomain: SHOP,
      orgId: ORG,
      identifier: SHOP,
      kernelPublicBaseUrl: "https://kernel.example.com",
    })
    expect(result.created.length).toBe(17)
    expect(result.skipped.length).toBe(0)
    expect(result.failed.length).toBe(0)
    const createBodies = fetches
      .filter((f) => (f.body ?? "").includes("WebhookSubscriptionCreate"))
      .map((f) => f.body ?? "")
    expect(createBodies.some((b) => b.includes("/webhooks/" + ORG + "/shopify/orders-create"))).toBe(
      true,
    )
    expect(createBodies.some((b) => b.includes(`"topic":"ORDERS_CREATE"`))).toBe(true)
  })

  it("completes when `process` is undefined (sandbox parity: an unguarded process.env read killed the flow)", async () => {
    // REGRESSION for a chaos-discovered defect: buildShopifyClient read
    // `process.env.LIAISON_TEST_SHOPIFY_BASE_URL` UNGUARDED. Bundled-app handlers run
    // inside the QuickJS sandbox where `process` is NOT defined, so this threw
    // ReferenceError at the top of the connection flow ("subscribeShopifyTopics
    // top-level failure: 'process' is not defined") → ZERO webhook topics registered
    // live. The typeof-guarded read must let the flow complete (no test override in
    // the sandbox → the real Shopify base URL). Use the FLAT shape — the real sandbox.
    const { ctx, fetches } = makeCtxWithShopifyFetch({ existingSubs: [], connectionsShape: "flat" })
    const g = globalThis as { process?: unknown }
    const savedProcess = g.process
    try {
      g.process = undefined // simulate the sandbox: no `process` global
      const result = await subscribeShopifyTopics(ctx, {
        shopDomain: SHOP,
        orgId: ORG,
        identifier: SHOP,
        kernelPublicBaseUrl: "https://kernel.example.com",
      })
      // Flow completed (not aborted by ReferenceError): every topic registered.
      expect(result.created.length).toBe(17)
      expect(result.failed.length).toBe(0)
      const createBodies = fetches
        .filter((f) => (f.body ?? "").includes("WebhookSubscriptionCreate"))
        .map((f) => f.body ?? "")
      expect(createBodies.some((b) => b.includes(`"topic":"ORDERS_CREATE"`))).toBe(true)
    } finally {
      g.process = savedProcess
    }
  })

  it("is idempotent — skips topics already subscribed to the right callback URL", async () => {
    const base = "https://kernel.example.com"
    const { ctx, fetches } = makeCtxWithShopifyFetch({
      existingSubs: [
        { topic: "ORDERS_CREATE", callbackUrl: `${base}/webhooks/${ORG}/shopify/orders-create` },
        { topic: "CUSTOMERS_CREATE", callbackUrl: `${base}/webhooks/${ORG}/shopify/customers-create` },
      ],
    })
    const result = await subscribeShopifyTopics(ctx, {
      shopDomain: SHOP,
      orgId: ORG,
      identifier: SHOP,
      kernelPublicBaseUrl: base,
    })
    expect(result.skipped.length).toBe(2)
    expect(result.created.length).toBe(15) // 17 declared − 2 already subscribed
    // Verify no create was issued for the already-subscribed topics.
    const createBodies = fetches.filter((f) => (f.body ?? "").includes("WebhookSubscriptionCreate")).map((f) => f.body ?? "")
    expect(createBodies.some((b) => b.includes(`"topic":"ORDERS_CREATE"`))).toBe(false)
    expect(createBodies.some((b) => b.includes(`"topic":"CUSTOMERS_CREATE"`))).toBe(false)
  })

  it("logs but does not throw when a single subscription has userErrors", async () => {
    const { ctx } = makeCtxWithShopifyFetch({ existingSubs: [], failFirstCreate: true })
    const result = await subscribeShopifyTopics(ctx, {
      shopDomain: SHOP,
      orgId: ORG,
      identifier: SHOP,
      kernelPublicBaseUrl: "https://kernel.example.com",
    })
    expect(result.failed.length).toBe(1)
    expect(result.created.length).toBe(16)
  })

  it("short-circuits when ctx.connections.shop is missing (returns empty)", async () => {
    const { ctx } = makeMockCtx()
    const result = await subscribeShopifyTopics(ctx, {
      shopDomain: SHOP,
      orgId: ORG,
      identifier: SHOP,
      kernelPublicBaseUrl: "https://kernel.example.com",
    })
    expect(result.created.length).toBe(0)
    expect(result.skipped.length).toBe(0)
    expect(result.failed.length).toBe(0)
  })
})

// `webhooks_repair` tool — re-registers the declared webhook topics for an
// ALREADY-connected shop, without going through OAuth again (needed so a prod
// shop connected before a topic-adding release, e.g. draft_orders/*, picks up
// the new subscriptions without a disconnect/reconnect round trip).
describe("webhooksRepairHandler", () => {
  const KERNEL_BASE = "https://kernel.example.com"

  function makeRepairCtx(opts: {
    existingSubs?: Array<{ topic: string; callbackUrl: string }>
    shopDomain?: string | null
  }): { ctx: AppContext; fetches: Array<{ url: string; body?: string }> } {
    const { ctx, spy } = makeMockCtx()
    if (opts.shopDomain !== null) {
      // Seed the row `loadInstallMetadata` reads — the shop is already
      // connected (this tool never runs the OAuth dance).
      void ctx.db.insert("install_metadata", {
        shopDomain: opts.shopDomain ?? SHOP,
        connectionId: ACCOUNT_ID,
        apiVersion: API_VERSION,
        connectionStatus: "connected",
        grantedOAuthScopes: [],
        installedAt: new Date(),
      })
    }
    const fetches: Array<{ url: string; body?: string }> = []
    const shopFetch = async (
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ) => {
      fetches.push({ url, body: init?.body })
      const body = init?.body ?? ""
      if (body.includes("WebhookSubscriptionList")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: {
              webhookSubscriptions: {
                edges: (opts.existingSubs ?? []).map((s) => ({
                  node: {
                    id: "gid://shopify/WebhookSubscription/1",
                    topic: s.topic,
                    endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: s.callbackUrl },
                  },
                })),
              },
            },
          }),
        }
      }
      if (body.includes("WebhookSubscriptionCreate")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: {
              webhookSubscriptionCreate: {
                webhookSubscription: { id: "gid://shopify/WebhookSubscription/x" },
                userErrors: [],
              },
            },
          }),
        }
      }
      return { status: 200, headers: {}, body: "{}" }
    }
    ;(ctx as { fetch: typeof shopFetch }).fetch = shopFetch
    const accounts = [{ id: ACCOUNT_ID, ownerType: "org", ownerId: null, identifier: SHOP, displayName: SHOP }]
    ;(ctx as { connections: Record<string, unknown> }).connections = {
      shop: {
        getToken: async () => "shpat_TEST",
        getAccounts: async () => accounts,
      },
    }
    void spy
    return { ctx, fetches }
  }

  it("derives the callback base URL from an existing subscription and only creates the missing topics", async () => {
    const { ctx, fetches } = makeRepairCtx({
      existingSubs: [
        { topic: "ORDERS_CREATE", callbackUrl: `${KERNEL_BASE}/webhooks/${ORG}/shopify/orders-create` },
      ],
    })
    const result = await webhooksRepairHandler({}, ctx)
    expect(result.status).toBe("completed")
    if (result.status !== "completed") throw new Error("unreachable")
    // 1 topic already subscribed (derived correctly, so recognised as a
    // match and skipped) + all other declared topics created.
    expect(result.skipped).toEqual(["orders/create"])
    expect(result.created.length).toBe(16)
    expect(result.failed.length).toBe(0)
    // The recovered base must be used for every newly-created subscription —
    // never a re-derived or malformed URL.
    const createBodies = fetches.filter((f) => (f.body ?? "").includes("WebhookSubscriptionCreate")).map((f) => f.body ?? "")
    expect(createBodies.every((b) => b.includes(`${KERNEL_BASE}/webhooks/${ORG}/shopify/`))).toBe(true)
    expect(createBodies.some((b) => b.includes(`"topic":"DRAFT_ORDERS_CREATE"`))).toBe(true)
  })

  it("uses an explicitly passed callback_base_url instead of deriving one", async () => {
    const { ctx, fetches } = makeRepairCtx({ existingSubs: [] })
    const result = await webhooksRepairHandler({ callback_base_url: "https://explicit.example.com/" }, ctx)
    expect(result.status).toBe("completed")
    if (result.status !== "completed") throw new Error("unreachable")
    expect(result.created.length).toBe(17)
    const createBodies = fetches.filter((f) => (f.body ?? "").includes("WebhookSubscriptionCreate")).map((f) => f.body ?? "")
    // Trailing slash on the passed URL must be normalised away (no double slash).
    expect(createBodies.every((b) => b.includes(`https://explicit.example.com/webhooks/${ORG}/shopify/`))).toBe(true)
    expect(createBodies.some((b) => b.includes("https://explicit.example.com//webhooks"))).toBe(false)
  })

  it("returns a shop_not_connected error when no shop is installed", async () => {
    const { ctx } = makeRepairCtx({ shopDomain: null })
    const result = await webhooksRepairHandler({}, ctx)
    expect(result.status).toBe("error")
    if (result.status !== "error") throw new Error("unreachable")
    expect(result.error.code).toBe("shop_not_connected")
  })

  it("returns a callback_base_unknown error when there are no existing subscriptions to derive from and no explicit URL", async () => {
    const { ctx } = makeRepairCtx({ existingSubs: [] })
    const result = await webhooksRepairHandler({}, ctx)
    expect(result.status).toBe("error")
    if (result.status !== "error") throw new Error("unreachable")
    expect(result.error.code).toBe("callback_base_unknown")
  })
})

// N29: a disconnect (and an org purge) used to leave the org's 17 webhook
// subscriptions on the store, and nothing could reach them once the token was
// gone. The kernel's `beforeDisconnect` hook runs while the token still works;
// a connect also clears this org's own stale subscriptions first.
describe("webhook subscription cleanup (beforeDisconnect hook + connect)", () => {
  const BASE = "https://kernel.example.com"
  const OTHER_ORG = "00000000-0000-0000-0000-0000000000ff"
  const ours = (endpoint: string) => `${BASE}/webhooks/${ORG}/shopify/${endpoint}`

  interface FakeSub {
    id: string
    topic: string
    callbackUrl: string
  }

  /** A fake store: paginated list (pageSize), delete by id, create appends. */
  function makeStore(opts: {
    subs: FakeSub[]
    pageSize?: number
    failDeleteIds?: string[]
    token?: "ok" | "missing"
  }) {
    const { ctx } = makeMockCtx()
    const store = {
      subs: [...opts.subs],
      deleteCalls: [] as string[],
      listCalls: 0,
      creates: 0,
      auths: [] as unknown[],
    }
    const pageSize = opts.pageSize ?? 250
    let nextId = 1000
    const json = (data: unknown) => ({ status: 200, headers: {}, body: JSON.stringify({ data }) })
    ;(ctx as { fetch: unknown }).fetch = async (
      _url: string,
      init?: { body?: string; auth?: { connection: string; identifier?: string; scheme: string } },
    ) => {
      // The host adds the token named by `auth`; with none stored it refuses the call.
      store.auths.push(init?.auth ?? null)
      if (opts.token === "missing") throw new Error("No access token stored")
      const req = JSON.parse(init?.body ?? "{}") as { query?: string; variables?: Record<string, unknown> }
      const q = req.query ?? ""
      if (q.includes("WebhookSubscriptionList")) {
        store.listCalls += 1
        const start = typeof req.variables?.after === "string" ? Number(req.variables.after) : 0
        const page = store.subs.slice(start, start + pageSize)
        const end = start + page.length
        return json({
          webhookSubscriptions: {
            edges: page.map((s) => ({
              node: {
                id: s.id,
                topic: s.topic,
                endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: s.callbackUrl },
              },
            })),
            pageInfo: { hasNextPage: end < store.subs.length, endCursor: String(end) },
          },
        })
      }
      if (q.includes("WebhookSubscriptionDelete")) {
        const id = String(req.variables?.id)
        store.deleteCalls.push(id)
        if (opts.failDeleteIds?.includes(id)) {
          return json({
            webhookSubscriptionDelete: {
              deletedWebhookSubscriptionId: null,
              userErrors: [{ field: ["id"], message: "nope" }],
            },
          })
        }
        store.subs = store.subs.filter((s) => s.id !== id)
        return json({ webhookSubscriptionDelete: { deletedWebhookSubscriptionId: id, userErrors: [] } })
      }
      if (q.includes("WebhookSubscriptionCreate")) {
        store.creates += 1
        const v = req.variables as { topic: string; webhookSubscription: { callbackUrl: string } }
        store.subs.push({ id: `gid://new/${nextId++}`, topic: v.topic, callbackUrl: v.webhookSubscription.callbackUrl })
        return json({ webhookSubscriptionCreate: { webhookSubscription: { id: "x" }, userErrors: [] } })
      }
      return { status: 200, headers: {}, body: "{}" }
    }
    const accounts = [{ id: ACCOUNT_ID, ownerType: "org", ownerId: null, identifier: SHOP, displayName: SHOP }]
    ;(ctx as { connections: unknown }).connections = {
      getAccounts: async () => accounts,
    }
    const warns: Array<{ msg: string; data: unknown }> = []
    ;(ctx as { logger: unknown }).logger = {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: (msg: string, data: unknown) => warns.push({ msg, data }),
    }
    return { ctx, store, warns }
  }

  const hookEvent = (overrides: Partial<{ appName: string; kernelPublicBaseUrl: string }> = {}) => ({
    id: ACCOUNT_ID,
    orgId: ORG,
    appName: overrides.appName ?? "shopify",
    connectionName: "shop",
    ownerType: "org",
    ownerId: null,
    identifier: SHOP,
    kernelPublicBaseUrl: overrides.kernelPublicBaseUrl ?? BASE,
    reason: "disconnect" as const,
  })

  it("deletes only this org's subscriptions on this host, across pages", async () => {
    const subs: FakeSub[] = [
      { id: "a1", topic: "ORDERS_CREATE", callbackUrl: ours("orders-create") },
      { id: "x1", topic: "ORDERS_CREATE", callbackUrl: `${BASE}/webhooks/${OTHER_ORG}/shopify/orders-create` },
      { id: "x2", topic: "ORDERS_CREATE", callbackUrl: `https://retired.example.com/webhooks/${ORG}/shopify/orders-create` },
      { id: "x3", topic: "ORDERS_CREATE", callbackUrl: "https://another-app.example.com/hooks/orders" },
      { id: "a2", topic: "APP_UNINSTALLED", callbackUrl: ours("app-uninstalled") },
      { id: "a3", topic: "CUSTOMERS_UPDATE", callbackUrl: ours("customers-update") },
    ]
    const { ctx, store } = makeStore({ subs, pageSize: 2 })
    const result = await onBeforeDisconnect(hookEvent(), ctx)
    expect(result).toEqual({ deleted: 3, failed: 0 })
    expect(store.listCalls).toBe(3)
    expect(store.deleteCalls.sort()).toEqual(["a1", "a2", "a3"])
    expect(store.subs.map((s) => s.id).sort()).toEqual(["x1", "x2", "x3"])
  })

  it("ignores another app's connection", async () => {
    const { ctx, store } = makeStore({
      subs: [{ id: "a1", topic: "ORDERS_CREATE", callbackUrl: ours("orders-create") }],
    })
    expect(await onBeforeDisconnect(hookEvent({ appName: "mail" }), ctx)).toEqual({ deleted: 0, failed: 0 })
    expect(store.listCalls).toBe(0)
    expect(store.deleteCalls).toHaveLength(0)
  })

  it("logs the store and the count when deletes fail, and never throws", async () => {
    const { ctx, store, warns } = makeStore({
      subs: [
        { id: "a1", topic: "ORDERS_CREATE", callbackUrl: ours("orders-create") },
        { id: "a2", topic: "APP_UNINSTALLED", callbackUrl: ours("app-uninstalled") },
      ],
      failDeleteIds: ["a2"],
    })
    const result = await onBeforeDisconnect(hookEvent(), ctx)
    expect(result).toEqual({ deleted: 1, failed: 1 })
    expect(store.subs.map((s) => s.id)).toEqual(["a2"])
    const summary = warns.find((w) => w.msg.includes("could not be deleted"))
    expect(summary?.data).toMatchObject({ shopDomain: SHOP, found: 2, deleted: 1, failed: 1 })
  })

  it("logs loudly and returns when the host has no token for the store", async () => {
    const { ctx, store, warns } = makeStore({
      subs: [{ id: "a1", topic: "ORDERS_CREATE", callbackUrl: ours("orders-create") }],
      token: "missing",
    })
    expect(await onBeforeDisconnect(hookEvent(), ctx)).toEqual({ deleted: 0, failed: 0 })
    expect(store.subs).toHaveLength(1)
    expect(warns.some((w) => w.msg.includes("cleanup failed"))).toBe(true)
  })

  it("names the shop account in ctx.fetch auth and never handles the token", async () => {
    const { ctx, store } = makeStore({ subs: [] })
    await onBeforeDisconnect(hookEvent(), ctx)
    expect(store.auths.length).toBeGreaterThan(0)
    for (const auth of store.auths) {
      expect(auth).toEqual({ connection: "shop", identifier: SHOP, scheme: "header:X-Shopify-Access-Token" })
    }
  })

  it("a failing list call is logged, not thrown", async () => {
    const { ctx, warns } = makeStore({ subs: [] })
    ;(ctx as { fetch: unknown }).fetch = async () => ({ status: 500, headers: {}, body: "boom" })
    expect(await onBeforeDisconnect(hookEvent(), ctx)).toEqual({ deleted: 0, failed: 0 })
    expect(warns.some((w) => w.msg.includes("cleanup failed"))).toBe(true)
  })

  it("a reconnect removes this org's stale and duplicate subscriptions, keeps current ones, never others", async () => {
    const subs: FakeSub[] = [
      // current, kept
      { id: "k1", topic: "ORDERS_CREATE", callbackUrl: ours("orders-create") },
      // duplicate of a current pair
      { id: "d1", topic: "ORDERS_CREATE", callbackUrl: ours("orders-create") },
      // this org, a route no longer declared
      { id: "s1", topic: "RETURNS_REQUEST", callbackUrl: ours("returns-request-old") },
      // another org and another host: untouched
      { id: "x1", topic: "ORDERS_CREATE", callbackUrl: `${BASE}/webhooks/${OTHER_ORG}/shopify/orders-create` },
      { id: "x2", topic: "ORDERS_CREATE", callbackUrl: `https://retired.example.com/webhooks/${ORG}/shopify/orders-create` },
    ]
    const { ctx, store } = makeStore({ subs, pageSize: 2 })
    const result = await subscribeShopifyTopics(ctx, {
      shopDomain: SHOP,
      orgId: ORG,
      identifier: SHOP,
      kernelPublicBaseUrl: BASE,
    })
    expect(store.deleteCalls.sort()).toEqual(["d1", "s1"])
    expect(result.skipped).toEqual(["orders/create"])
    expect(result.created.length).toBe(16)
    const mine = store.subs.filter((s) => s.callbackUrl.startsWith(`${BASE}/webhooks/${ORG}/shopify/`))
    expect(mine).toHaveLength(17)
    expect(new Set(mine.map((s) => `${s.topic} ${s.callbackUrl}`)).size).toBe(17)
    expect(store.subs.some((s) => s.id === "x1")).toBe(true)
    expect(store.subs.some((s) => s.id === "x2")).toBe(true)
  })

  it("webhooks_repair derives the base from THIS org's subscriptions, not another instance's", async () => {
    const { ctx, store } = makeStore({
      subs: [
        { id: "x2", topic: "ORDERS_CREATE", callbackUrl: `https://retired.example.com/webhooks/${OTHER_ORG}/shopify/orders-create` },
        { id: "k1", topic: "ORDERS_CREATE", callbackUrl: ours("orders-create") },
      ],
    })
    await ctx.db.insert("install_metadata", {
      shopDomain: SHOP,
      connectionId: ACCOUNT_ID,
      apiVersion: API_VERSION,
      connectionStatus: "connected",
    })
    const result = await webhooksRepairHandler({}, ctx)
    expect(result.status).toBe("completed")
    const created = store.subs.filter((s) => s.id.startsWith("gid://new/"))
    expect(created).toHaveLength(16)
    expect(created.every((s) => s.callbackUrl.startsWith(`${BASE}/webhooks/${ORG}/shopify/`))).toBe(true)
  })
})
