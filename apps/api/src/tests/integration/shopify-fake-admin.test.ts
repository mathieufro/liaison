// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The fake Shopify Admin API (LIAISON_TEST_SHOPIFY_ADMIN_URL), through the real
// path: the Shopify app runs in the real sandbox, its requests go through the real
// egress bridge, and the fake is a real HTTP server on 127.0.0.1. No egress
// override is installed for the "on" cases, so a request reaches the fake only
// because the bridge sent it there.
//
// On (labelled private box): the connect's webhook registration, the disconnect
// cleanup, the backfill-customers job and a read all reach the fake, with the
// store's token. Off (every real instance): nothing reaches the fake, the same
// requests go to the store, and an app request naming the fake itself is refused.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { flushEventHandlers } from "~/infra/events/event-bus"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import type { ShopifyFakeAdminGateInput } from "~/lib/shopify-fake-admin-gate"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { runBeforeDisconnect } from "~/modules/apps/connections/before-disconnect"
import { reconcileAppConnections } from "~/modules/apps/connections/service"
import { executeTool } from "~/modules/apps/execute-tool"
import { registerApps } from "~/modules/apps/runtime"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { ShopifyFakeAdminTestAccess } from "~/modules/apps/sandbox/bridge/shopify-fake-admin"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { seedConnectedAccountRow } from "~/seed/factories/org/platform-rows"
import { seedOrgRow, seedUserRows, seedUserScopeGrantRow } from "~/seed/factories/org/rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const SHOP_DOMAIN = "fake-admin-test-store.myshopify.com"
const SHOP_TOKEN = "shpat_fake_admin_test_token_0123456789"
const ORG = "00000000-0000-4000-8000-0000000fa001"
const USER = "00000000-0000-4000-8000-0000000fa002"

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["shopify:customers:read"],
  dimensionGrants: {},
}

function bundledDescriptor(name: string): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", name, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  const version = (manifest.version as string) ?? "0.1.0"
  return {
    ...manifest,
    _format: "manifest",
    _bundlePath: join(REPO_ROOT, "bundled-apps", name, version, "bundle.js"),
  }
}

/** One request the fake received. */
interface FakeHit {
  path: string
  operation: string
  token: string | null
  shop: string | null
}

/** One request that went toward Shopify itself (gate off), caught where the transport sits. */
interface WireHit {
  url: string
  token: string | null
}

let fakeHits: FakeHit[] = []
let wireHits: WireHit[] = []
const subscriptions = new Map<string, { id: string; topic: string; callbackUrl: string }>()

/** The operation a GraphQL body names (its first `query X` / `mutation X`, or a top-level field). */
function operationOf(query: string): string {
  const named = /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query)
  if (named) return named[1]!
  const field = /\{\s*([A-Za-z0-9_]+)/.exec(query)
  return field ? field[1]! : "unknown"
}

/** The fake Admin API's answers, just enough for the paths under test. */
function answer(query: string, variables: Record<string, any>): unknown {
  if (/webhookSubscriptions\s*\(/.test(query)) {
    return {
      webhookSubscriptions: {
        edges: [...subscriptions.values()].map((s) => ({
          node: {
            id: s.id,
            topic: s.topic,
            endpoint: { __typename: "WebhookHttpEndpoint", callbackUrl: s.callbackUrl },
          },
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }
  }
  if (/webhookSubscriptionCreate\s*\(/.test(query)) {
    const id = `gid://shopify/WebhookSubscription/${subscriptions.size + 1}`
    const ws = variables.webhookSubscription ?? {}
    subscriptions.set(id, {
      id,
      topic: String(variables.topic),
      callbackUrl: String(ws.callbackUrl ?? ws.uri ?? ""),
    })
    return { webhookSubscriptionCreate: { webhookSubscription: { id }, userErrors: [] } }
  }
  if (/webhookSubscriptionDelete\s*\(/.test(query)) {
    subscriptions.delete(String(variables.id))
    return {
      webhookSubscriptionDelete: { deletedWebhookSubscriptionId: variables.id, userErrors: [] },
    }
  }
  if (/bulkOperationRunQuery\s*\(/.test(query)) {
    return {
      bulkOperationRunQuery: {
        bulkOperation: { id: "gid://shopify/BulkOperation/1", status: "CREATED" },
        userErrors: [],
      },
    }
  }
  if (/\bcustomers\s*\(/.test(query)) {
    return { customers: { edges: [], nodes: [], pageInfo: { hasNextPage: false } } }
  }
  return {}
}

let server: ReturnType<typeof Bun.serve>
let fakeOrigin = ""

const ON = (): ShopifyFakeAdminGateInput => ({
  value: fakeOrigin,
  declaredPrivate: true,
  baseUrl: "http://127.0.0.1:3000",
  managed: false,
})

/** A real instance: the setting present, the box neither labelled private nor loopback. */
const OFF_PUBLIC = (): ShopifyFakeAdminGateInput => ({
  value: fakeOrigin,
  declaredPrivate: false,
  baseUrl: "https://liaison.example.com",
  managed: false,
})

let connectionId = ""

async function connect(): Promise<void> {
  const { reconciled } = await reconcileAppConnections(ORG, USER, "shopify", "shop")
  expect(reconciled.length).toBe(1)
  for (let i = 0; i < 5; i++) {
    if ((await processOutboxBatch()) === 0) break
  }
  await flushEventHandlers()
}

async function runBackfill(): Promise<void> {
  const handler = JobsTestAccess.getHandler("shopify", "backfill-customers")
  if (!handler) throw new Error("backfill-customers job handler not registered")
  await dispatchAppJobWithContext(
    handler,
    { orgId: ORG },
    { actorType: "system", orgId: ORG, purpose: "job", scopes: ["shopify:*"] },
    "session",
    // The job's own outcome is not under test (a poll of an earlier run's export may
    // fail on the fake's answers): which host its requests reached is.
  ).catch(() => undefined)
}

async function runRead(): Promise<void> {
  await executeTool({
    toolName: "shopify:customers_search",
    orgId: ORG,
    actor,
    params: { query: "email:someone@example.com" },
  }).catch(() => undefined)
}

/** Catch every request that is NOT rewritten, where the real transport sits. */
function recordTheWire(): void {
  SandboxBridgeTestAccess.setFetchInterceptsHost((host) => host.endsWith(".myshopify.com"))
  SandboxBridgeTestAccess.setFetch((async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    wireHits.push({ url: String(url), token: headers["X-Shopify-Access-Token"] ?? null })
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      query?: string
      variables?: Record<string, unknown>
    }
    return new Response(JSON.stringify({ data: answer(body.query ?? "", body.variables ?? {}) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch)
}

describe("the fake Shopify Admin API on a test box, through the real sandbox", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const u = new URL(req.url)
        const body = (await req.json().catch(() => ({}))) as {
          query?: string
          variables?: Record<string, unknown>
        }
        const query = body.query ?? ""
        fakeHits.push({
          path: u.pathname,
          operation: operationOf(query),
          token: req.headers.get("x-shopify-access-token"),
          shop: req.headers.get("x-liaison-shop-domain"),
        })
        return Response.json({ data: answer(query, body.variables ?? {}) })
      },
    })
    fakeOrigin = `http://127.0.0.1:${server.port}`

    await seedOrgRow(
      { id: ORG, name: "Fake Admin Org", slug: "fake-admin-org" },
      { onConflict: "skip" },
    )
    await seedUserRows(
      [
        {
          id: USER,
          orgId: ORG,
          email: "fake-admin@test.com",
          passwordHash: "hash",
          name: "Fake Admin Tester",
          status: "active",
        },
      ],
      { onConflict: "skip" },
    )
    await seedUserScopeGrantRow({ userId: USER, orgId: ORG, scope: "shopify:customers:read" })

    await initSandboxPool()
    await initWorkerPool()
    await registerApps([bundledDescriptor("shopify") as never], ORG)

    await sql`DELETE FROM app_shopify.install_metadata WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG} AND app_name = 'shopify'`
    connectionId = randomUUID()
    await seedConnectedAccountRow({
      id: connectionId,
      orgId: ORG,
      appName: "shopify",
      connectionName: "shop",
      ownerType: "org",
      ownerId: null,
      providerType: "oauth2",
      identifier: SHOP_DOMAIN,
      status: "active",
      createdBy: USER,
      accessTokenEncrypted: encryptSecret(
        SHOP_TOKEN,
        env.ENCRYPTION_KEY,
        CryptoContext.connectedAccountAccessToken,
      ),
    })
  }, 90_000)

  afterEach(() => {
    ShopifyFakeAdminTestAccess.setInputs(null)
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    fakeHits = []
    wireHits = []
  })

  afterAll(async () => {
    server?.stop(true)
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await sql`DELETE FROM app_shopify.backfill_progress WHERE org_id = ${ORG}`.catch(
      () => undefined,
    )
    await sql`DELETE FROM app_shopify.install_metadata WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG} AND app_name = 'shopify'`
    await releaseTestLock()
  }, 60_000)

  it("with the setting on a real instance, nothing reaches the fake and the store gets its own calls", async () => {
    ShopifyFakeAdminTestAccess.setInputs(OFF_PUBLIC())
    recordTheWire()
    subscriptions.clear()

    await connect()
    await runBackfill()
    await runRead()

    expect(fakeHits).toEqual([])
    expect(wireHits.length).toBeGreaterThan(0)
    for (const hit of wireHits) {
      expect(new URL(hit.url).hostname).toBe(SHOP_DOMAIN)
      expect(hit.token).toBe(SHOP_TOKEN)
    }
  }, 120_000)

  it("on a labelled private box, the connect registers its webhooks on the fake, with the store's token", async () => {
    ShopifyFakeAdminTestAccess.setInputs(ON())
    subscriptions.clear()

    await connect()

    const ops = fakeHits.map((h) => h.operation)
    expect(ops).toContain("WebhookSubscriptionList")
    expect(ops.filter((o) => o === "WebhookSubscriptionCreate").length).toBeGreaterThan(10)
    for (const hit of fakeHits) {
      expect(hit.path).toBe("/admin/api/2026-04/graphql.json")
      expect(hit.token).toBe(SHOP_TOKEN)
      expect(hit.shop).toBe(SHOP_DOMAIN)
    }
    expect(
      [...subscriptions.values()].every((s) => s.callbackUrl.includes(`/webhooks/${ORG}/shopify/`)),
    ).toBe(true)
  }, 120_000)

  it("on a labelled private box, the backfill-customers job and a read reach the fake", async () => {
    ShopifyFakeAdminTestAccess.setInputs(ON())

    await runBackfill()
    // The job starts the export, or polls the one an earlier run started.
    const jobOps = fakeHits.map((h) => h.operation)
    expect(jobOps.includes("StartCustomerBackfill") || jobOps.includes("BulkOperationStatus")).toBe(
      true,
    )
    for (const hit of fakeHits) expect(hit.token).toBe(SHOP_TOKEN)

    fakeHits = []
    await runRead()
    expect(fakeHits.length).toBeGreaterThan(0)
    for (const hit of fakeHits) expect(hit.token).toBe(SHOP_TOKEN)
  }, 120_000)

  it("on a labelled private box, the disconnect cleanup deletes this org's webhooks on the fake", async () => {
    ShopifyFakeAdminTestAccess.setInputs(ON())
    expect(subscriptions.size).toBeGreaterThan(0)

    const outcome = await runBeforeDisconnect(ORG, connectionId)
    expect(outcome.status).toBe("ran")

    const ops = fakeHits.map((h) => h.operation)
    expect(ops).toContain("WebhookSubscriptionList")
    expect(ops).toContain("WebhookSubscriptionDelete")
    expect(subscriptions.size).toBe(0)
  }, 120_000)

  describe("the sandbox egress to the fake's own origin", () => {
    function shopifyBridge() {
      return createEgressMethods({
        orgId: ORG,
        userId: USER,
        appName: "shopify",
        actorType: "user",
        egress: async () => ({
          allowedDomains: ["*.myshopify.com"],
          manifest: { name: "shopify" },
        }),
        callerScopes: [],
        inheritedActor: { actorType: "user" as const },
        manifest: { name: "shopify" },
        txDb: null,
        resolveCredentials: async () => ({}),
      } as unknown as BridgeContext)
    }
    const graphql = JSON.stringify({
      method: "POST",
      headers: {},
      body: '{"query":"{ shop { id } }"}',
    })

    it("is refused when the gate is off", async () => {
      ShopifyFakeAdminTestAccess.setInputs(OFF_PUBLIC())
      await expect(
        shopifyBridge().fetch(`${fakeOrigin}/admin/api/2026-04/graphql.json`, graphql),
      ).rejects.toThrow(/not in allowlist/)
      expect(fakeHits).toEqual([])
    })

    it("is refused when the app names it directly, even with the gate on", async () => {
      ShopifyFakeAdminTestAccess.setInputs(ON())
      await expect(
        shopifyBridge().fetch(`${fakeOrigin}/admin/api/2026-04/graphql.json`, graphql),
      ).rejects.toThrow(/not in allowlist/)
      expect(fakeHits).toEqual([])
    })

    it("rewrites only the Shopify app: another app's store request is not sent to the fake", async () => {
      ShopifyFakeAdminTestAccess.setInputs(ON())
      recordTheWire()
      const other = createEgressMethods({
        orgId: ORG,
        userId: USER,
        appName: "invoicing",
        actorType: "user",
        egress: async () => ({
          allowedDomains: ["*.myshopify.com"],
          manifest: { name: "invoicing" },
        }),
        callerScopes: [],
        inheritedActor: { actorType: "user" as const },
        manifest: { name: "invoicing" },
        txDb: null,
        resolveCredentials: async () => ({}),
      } as unknown as BridgeContext)
      await other.fetch(`https://${SHOP_DOMAIN}/admin/api/2026-04/graphql.json`, graphql)
      expect(fakeHits).toEqual([])
      expect(wireHits.map((h) => new URL(h.url).hostname)).toEqual([SHOP_DOMAIN])
    })

    it("follows no redirect from the fake", async () => {
      ShopifyFakeAdminTestAccess.setInputs(ON())
      const redirecting = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          new Response(null, { status: 302, headers: { location: "https://example.com/x" } }),
      })
      try {
        ShopifyFakeAdminTestAccess.setInputs({
          ...ON(),
          value: `http://127.0.0.1:${redirecting.port}`,
        })
        const raw = (await shopifyBridge().fetch(
          `https://${SHOP_DOMAIN}/admin/api/2026-04/graphql.json`,
          graphql,
        )) as string
        // The 302 comes back to the app unfollowed: nothing goes to its location.
        expect((JSON.parse(raw) as { status: number }).status).toBe(302)
      } finally {
        redirecting.stop(true)
      }
    })
  })
})
