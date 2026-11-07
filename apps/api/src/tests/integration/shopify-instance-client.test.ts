// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Shopify app the instance provides for every workspace (SHOPIFY_APP_CLIENT_*):
// a workspace with no client of its own starts OAuth with the instance's client
// id, exchanges the code with the instance's secret, and verifies the store's
// webhooks (Shopify signs them with the app's secret) with that same secret. A
// workspace with its own client keeps using its own.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { app } from "~/app"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { apps, connectedAccounts, oauthProviders } from "~/db/schema/kernel"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import {
  connectionConfigRegistry,
  resetAppRegistries,
  webhookHandlers,
} from "~/modules/apps/app-registries"
import { connectionClientSecretForConfigKey } from "~/modules/apps/connections/oauth-client"
import { upsertConnectionOAuthClient } from "~/modules/apps/connections/oauth-client-provisioning"
import { handleOAuthCallback, startOAuthFlow } from "~/modules/apps/connections/service"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { buildVerifyBridge } from "~/modules/webhooks/verify-bridge"
import { shopifyWebhookVerifier } from "../../../../../bundled-apps/shopify/src/lib/hmac"

type ShopifyInstanceVars = { SHOPIFY_APP_CLIENT_ID?: string; SHOPIFY_APP_CLIENT_SECRET?: string }
const mutableEnv = env as ShopifyInstanceVars
const saved = { ...mutableEnv }

const INSTANCE_ID = "instance-shopify-client-id"
const INSTANCE_SECRET = "instance-shopify-client-secret"
const SHOPIFY_CONNECTIONS = { shop: { clientSecretConfigKey: "shopifyWebhookSecret" } }

let orgId: string
let userId: string
let tokenServer: ReturnType<typeof Bun.serve> | null = null
let tokenUrl: string
/** The form the token endpoint last received (client_id, client_secret, code). */
let lastTokenForm: URLSearchParams | null = null

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Shopify instance client org', ${`shopify-instance-${suffix}`})
      RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`shopify-instance-${suffix}@test.com`}, 'Installer', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user.id
  await db
    .insert(apps)
    .values({ orgId, name: "shopify", version: "1.0.0", config: null })
    .onConflictDoNothing()

  tokenServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      lastTokenForm = new URLSearchParams(await req.text())
      return Response.json({ access_token: "shpat_instance_token", token_type: "bearer" })
    },
  })
  tokenUrl = `http://127.0.0.1:${tokenServer.port}/admin/oauth/access_token`
  connectionConfigRegistry.set([orgId, "shopify", "shop"], {
    type: "oauth2",
    authorizationUrl: "https://{shop}/admin/oauth/authorize",
    // The flow start requires https; the callback below exchanges the code at the
    // local endpoint carried in its state, as shopify-oauth-callback.test.ts does.
    tokenUrl: "https://{shop}/admin/oauth/access_token",
    scopes: ["read_orders"],
    allowedDomains: ["*.myshopify.com"],
    templateVars: {
      shop: {
        lowercase: true,
        pattern: "^[a-z0-9][a-z0-9-]*(\\.myshopify\\.com)?$",
        appendSuffix: ".myshopify.com",
      },
    },
    identifierVar: "shop",
    clientSecretConfigKey: "shopifyWebhookSecret",
  })
  mutableEnv.SHOPIFY_APP_CLIENT_ID = INSTANCE_ID
  mutableEnv.SHOPIFY_APP_CLIENT_SECRET = INSTANCE_SECRET
})

afterEach(async () => {
  await db.delete(oauthProviders).where(eq(oauthProviders.orgId, orgId))
})

afterAll(async () => {
  mutableEnv.SHOPIFY_APP_CLIENT_ID = saved.SHOPIFY_APP_CLIENT_ID
  mutableEnv.SHOPIFY_APP_CLIENT_SECRET = saved.SHOPIFY_APP_CLIENT_SECRET
  tokenServer?.stop(true)
  resetAppRegistries()
  await db.delete(connectedAccounts).where(eq(connectedAccounts.orgId, orgId))
  await db.delete(apps).where(eq(apps.orgId, orgId))
  await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}::uuid`)
})

/** The OAuth start: the authorize URL's client_id. */
async function start(): Promise<{ clientId: string | null }> {
  const url = await startOAuthFlow(orgId, userId, "shopify", "shop", {
    ownerType: "org",
    shop: "instance-store",
  })
  return { clientId: new URL(url).searchParams.get("client_id") }
}

/** An OAuth state as the start stores it, pointing the exchange at the local endpoint. */
async function seedState(): Promise<string> {
  const state = randomUUID()
  await redis.set(
    `oauth:state:${state}`,
    JSON.stringify({
      orgId,
      userId,
      appName: "shopify",
      connectionName: "shop",
      codeVerifier: "test-verifier",
      tokenUrl,
      ownerType: "org",
      ownerId: null,
      shopDomain: "instance-store.myshopify.com",
    }),
    "EX",
    900,
  )
  return state
}

/** A Shopify webhook delivery signed with `secret`, through the app's own verifier. */
async function verifyDelivery(secret: string) {
  const body = JSON.stringify({ id: 1, name: "#1001" })
  const signature = createHmac("sha256", secret).update(body, "utf8").digest("base64")
  return shopifyWebhookVerifier(
    {
      headers: { "X-Shopify-Hmac-Sha256": signature, "X-Shopify-Webhook-Id": randomUUID() },
      body,
      method: "POST",
      query: {},
    },
    // The webhook route's verify bridge; its config reader answers what the
    // route's does for the signing key.
    buildVerifyBridge({
      readConfig: (key) =>
        connectionClientSecretForConfigKey(orgId, "shopify", key, SHOPIFY_CONNECTIONS),
      secretConfigKeys: ["shopifyWebhookSecret"],
    }) as never,
  )
}

describe("Shopify with an instance-provided app, the org having no client of its own", () => {
  it("OAuth starts with the instance's client id", async () => {
    const { clientId } = await start()
    expect(clientId).toBe(INSTANCE_ID)
  })

  it("the code exchange uses the instance's secret, mirrored as the webhook key", async () => {
    const state = await seedState()
    await handleOAuthCallback("instance-code", state, { shop: "instance-store.myshopify.com" })
    expect(lastTokenForm?.get("client_id")).toBe(INSTANCE_ID)
    expect(lastTokenForm?.get("client_secret")).toBe(INSTANCE_SECRET)

    const [row] = await db
      .select({ identifier: connectedAccounts.identifier })
      .from(connectedAccounts)
      .where(and(eq(connectedAccounts.orgId, orgId), eq(connectedAccounts.appName, "shopify")))
      .limit(1)
    expect(row?.identifier).toBe("instance-store.myshopify.com")
    const [appRow] = await db
      .select({ config: apps.config })
      .from(apps)
      .where(and(eq(apps.orgId, orgId), eq(apps.name, "shopify")))
    const mirrored = (appRow?.config as { shopifyWebhookSecret?: string } | null)
      ?.shopifyWebhookSecret
    expect(
      decryptSecret(mirrored ?? "", env.ENCRYPTION_KEY, CryptoContext.appConfigConnectionSecret),
    ).toBe(INSTANCE_SECRET)
  })

  it("webhook HMAC verifies with the instance's secret and refuses another", async () => {
    expect((await verifyDelivery(INSTANCE_SECRET)).ok).toBe(true)
    const wrong = await verifyDelivery("some-other-secret")
    expect(wrong).toEqual({ ok: false, reason: "signature_mismatch" })
  })
})

describe("Shopify when the org brings its own app", () => {
  it("OAuth and webhook HMAC use the org's client, not the instance's", async () => {
    await upsertConnectionOAuthClient({
      orgId,
      appName: "shopify",
      connectionName: "shop",
      clientId: "org-own-shopify-id",
      clientSecret: "org-own-shopify-secret",
    })
    const { clientId } = await start()
    expect(clientId).toBe("org-own-shopify-id")
    expect((await verifyDelivery("org-own-shopify-secret")).ok).toBe(true)
    expect((await verifyDelivery(INSTANCE_SECRET)).ok).toBe(false)
  })
})

// The real webhook route (POST /webhooks/:org/shopify/:topic) with the Shopify
// app's own verifier running in the sandbox: which secret its config_get gets.
describe("the webhook route verifies with the right Shopify secret", () => {
  const ENDPOINT = "orders-create-route-test"
  const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
  const shopifyVersion = (
    JSON.parse(
      readFileSync(join(REPO, "bundled-apps", "shopify", "app.manifest.json"), "utf8"),
    ) as {
      version: string
    }
  ).version

  beforeAll(async () => {
    await initSandboxPool()
  }, 120_000)

  afterAll(async () => {
    webhookHandlers.delete([orgId, "shopify", ENDPOINT])
    await shutdownSandboxPool()
  })

  function register(withConnections: boolean): void {
    webhookHandlers.set([orgId, "shopify", ENDPOINT], {
      appName: "shopify",
      orgId,
      verify: {
        bundlePath: join(REPO, "bundled-apps", "shopify", shopifyVersion, "bundle.js"),
        exportName: "shopifyWebhookVerifier",
      },
      handler: async () => ({ status: 200 }),
      ...(withConnections ? { _manifest: { connections: SHOPIFY_CONNECTIONS } } : {}),
    } as never)
  }

  async function setStoredCopy(secret: string | null): Promise<void> {
    const config =
      secret === null
        ? {}
        : {
            shopifyWebhookSecret: encryptSecret(
              secret,
              env.ENCRYPTION_KEY,
              CryptoContext.appConfigConnectionSecret,
            ),
          }
    await db
      .update(apps)
      .set({ config })
      .where(and(eq(apps.orgId, orgId), eq(apps.name, "shopify")))
  }

  /** POST a delivery signed with `secret`; the route's status. */
  async function deliver(secret: string): Promise<number> {
    const body = JSON.stringify({ id: randomUUID() })
    const res = await app.request(`/webhooks/${orgId}/shopify/${ENDPOINT}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body, "utf8").digest("base64"),
        "x-shopify-webhook-id": randomUUID(),
        "x-shopify-shop-domain": "instance-store.myshopify.com",
      },
      body,
    })
    return res.status
  }

  it("a copy stored at connect wins: the instance's secret it holds verifies, the org's newer one does not", async () => {
    register(true)
    await setStoredCopy(INSTANCE_SECRET)
    await upsertConnectionOAuthClient({
      orgId,
      appName: "shopify",
      connectionName: "shop",
      clientId: "org-own-shopify-id",
      clientSecret: "org-own-shopify-secret",
    })
    expect(await deliver(INSTANCE_SECRET)).toBe(200)
    expect(await deliver("org-own-shopify-secret")).toBe(401)
  }, 60_000)

  it("no stored copy: the live client through the resolver (the instance's here)", async () => {
    register(true)
    await setStoredCopy(null)
    expect(await deliver(INSTANCE_SECRET)).toBe(200)
    expect(await deliver("some-other-secret")).toBe(401)
  }, 60_000)

  it("no stored copy and no manifest connections wired: nothing names the key, refused", async () => {
    register(false)
    await setStoredCopy(null)
    expect(await deliver(INSTANCE_SECRET)).toBe(401)
  }, 60_000)

  it("no stored copy and the live lookup throws: refused (401), never a 500", async () => {
    register(true)
    await setStoredCopy(null)
    // A stored client whose secret cannot be decrypted makes the resolver throw.
    await db.insert(oauthProviders).values({
      orgId,
      name: "shopify:shop",
      issuerUrl: "https://app-connection.invalid/shopify:shop",
      clientId: "broken-client",
      clientSecretEncrypted: "not-a-ciphertext",
    })
    expect(await deliver(INSTANCE_SECRET)).toBe(401)
  }, 60_000)
})
