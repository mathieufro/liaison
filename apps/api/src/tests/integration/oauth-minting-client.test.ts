// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A connected account keeps the OAuth client that minted its tokens. A refresh
// token works only with the client it was issued to, and Shopify signs a store's
// webhooks with the secret of the app the store connected through, so:
//   - a workspace that saves its own client after connecting through the
//     instance's keeps refreshing (and verifying webhooks) with the instance's;
//   - an account connected before the record existed ("legacy") resolves in the
//     order that applied then (Drive: the instance's client before its row);
//   - when the minting client is gone (the instance stopped providing it), the
//     account is marked for reconnect, never left failing silently.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { apps, connectedAccounts, oauthProviders } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { connectionConfigRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import {
  accountsMintedByAnotherClient,
  MINTING_CLIENT_GONE_MESSAGE,
} from "~/modules/apps/connections/oauth-client"
import { upsertConnectionOAuthClient } from "~/modules/apps/connections/oauth-client-provisioning"
import {
  decryptConnectionConfigValue,
  getTokenFromAccount,
  handleOAuthCallback,
} from "~/modules/apps/connections/service"
import { buildVerifyBridge } from "~/modules/webhooks/verify-bridge"
import { shopifyWebhookVerifier } from "../../../../../bundled-apps/shopify/src/lib/hmac"

type InstanceVars = Partial<
  Record<
    | "SHOPIFY_APP_CLIENT_ID"
    | "SHOPIFY_APP_CLIENT_SECRET"
    | "GOOGLE_DRIVE_OAUTH_CLIENT_ID"
    | "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET",
    string
  >
>
const mutableEnv = env as InstanceVars
const saved: InstanceVars = { ...mutableEnv }

const INSTANCE_SHOPIFY = { id: "instance-shopify-id", secret: "instance-shopify-secret" }
const ORG_SHOPIFY = { id: "org-shopify-id", secret: "org-shopify-secret" }
const INSTANCE_DRIVE = {
  id: "instance-drive.apps.googleusercontent.com",
  secret: "instance-drive-secret",
}
const ROW_DRIVE = { id: "row-drive.apps.googleusercontent.com", secret: "row-drive-secret" }

let orgId: string
let userId: string
let tokenServer: ReturnType<typeof Bun.serve> | null = null
let tokenUrl: string
/** Every form the token endpoint received, oldest first. */
const tokenForms: URLSearchParams[] = []

function setInstance(vars: InstanceVars): void {
  mutableEnv.SHOPIFY_APP_CLIENT_ID = vars.SHOPIFY_APP_CLIENT_ID
  mutableEnv.SHOPIFY_APP_CLIENT_SECRET = vars.SHOPIFY_APP_CLIENT_SECRET
  mutableEnv.GOOGLE_DRIVE_OAUTH_CLIENT_ID = vars.GOOGLE_DRIVE_OAUTH_CLIENT_ID
  mutableEnv.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = vars.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET
}

const ALL_INSTANCE: InstanceVars = {
  SHOPIFY_APP_CLIENT_ID: INSTANCE_SHOPIFY.id,
  SHOPIFY_APP_CLIENT_SECRET: INSTANCE_SHOPIFY.secret,
  GOOGLE_DRIVE_OAUTH_CLIENT_ID: INSTANCE_DRIVE.id,
  GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: INSTANCE_DRIVE.secret,
}

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Minting client org', ${`minting-client-${suffix}`})
      RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`minting-${suffix}@test.com`}, 'Installer', 'active', 'hash', 1, 1)
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
      tokenForms.push(new URLSearchParams(await req.text()))
      return Response.json({
        access_token: `access-${tokenForms.length}`,
        refresh_token: "refresh-token",
        expires_in: 3600,
        token_type: "bearer",
      })
    },
  })
  tokenUrl = `http://127.0.0.1:${tokenServer.port}/token`
  connectionConfigRegistry.set([orgId, "shopify", "shop"], {
    type: "oauth2",
    authorizationUrl: "https://{shop}/admin/oauth/authorize",
    tokenUrl,
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
  connectionConfigRegistry.set([orgId, "google-drive", "drive"], {
    type: "oauth2",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    allowedDomains: [],
  })
})

afterEach(async () => {
  setInstance(saved)
  tokenForms.length = 0
  await db.delete(oauthProviders).where(eq(oauthProviders.orgId, orgId))
  await db.delete(connectedAccounts).where(eq(connectedAccounts.orgId, orgId))
})

afterAll(async () => {
  setInstance(saved)
  tokenServer?.stop(true)
  resetAppRegistries()
  await db.delete(apps).where(eq(apps.orgId, orgId))
  await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}::uuid`)
})

/** Connect the store through the real callback, with whatever client resolves now. */
async function connectShop(shop: string) {
  const state = randomUUID()
  await redis.set(
    `oauth:state:${state}`,
    JSON.stringify({
      orgId,
      userId,
      appName: "shopify",
      connectionName: "shop",
      codeVerifier: "verifier",
      tokenUrl,
      ownerType: "org",
      ownerId: null,
      shopDomain: shop,
    }),
    "EX",
    900,
  )
  await handleOAuthCallback("code", state, { shop })
  const [row] = await db
    .select()
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.orgId, orgId),
        eq(connectedAccounts.identifier, shop),
        eq(connectedAccounts.status, "active"),
      ),
    )
  if (!row) throw new Error("no connected account")
  return row
}

/** Make the account's access token lapse so the next read refreshes it. */
async function expire(id: string) {
  const [row] = await db
    .update(connectedAccounts)
    .set({ tokenExpiresAt: new Date(Date.now() - 60_000) })
    .where(eq(connectedAccounts.id, id))
    .returning()
  if (!row) throw new Error("no account")
  return row
}

/** The secret the webhook route's config_get answers: the copy stored at connect. */
async function storedWebhookSecret(): Promise<string> {
  const [appRow] = await db
    .select({ config: apps.config })
    .from(apps)
    .where(and(eq(apps.orgId, orgId), eq(apps.name, "shopify")))
  const value = (appRow?.config as Record<string, unknown> | null)?.shopifyWebhookSecret
  const plain = await decryptConnectionConfigValue(
    orgId,
    "shopify",
    "shopifyWebhookSecret",
    value,
    undefined,
    {
      shop: { clientSecretConfigKey: "shopifyWebhookSecret" },
    },
  )
  if (typeof plain !== "string") throw new Error("no stored webhook secret")
  return plain
}

async function verifySignedWith(secret: string, verifierSecret: string) {
  const body = JSON.stringify({ id: 7 })
  return shopifyWebhookVerifier(
    {
      headers: {
        "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body, "utf8").digest("base64"),
        "x-shopify-webhook-id": randomUUID(),
      },
      body,
      method: "POST",
      query: {},
    },
    // The webhook route's verify bridge, its config reader answering `verifierSecret`.
    buildVerifyBridge({
      readConfig: async () => verifierSecret,
      secretConfigKeys: ["shopifyWebhookSecret"],
    }) as never,
  )
}

describe("the connect records the minting client", () => {
  it("an instance-minted account records source instance and the instance's client id", async () => {
    setInstance(ALL_INSTANCE)
    const account = await connectShop("rec-store.myshopify.com")
    expect(account.oauthClientSource).toBe("instance")
    expect(account.oauthClientId).toBe(INSTANCE_SHOPIFY.id)
  })
})

describe("instance → org switch", () => {
  it("the refresh still uses the instance client that minted the account", async () => {
    setInstance(ALL_INSTANCE)
    const account = await connectShop("switch-store.myshopify.com")
    await upsertConnectionOAuthClient({
      orgId,
      appName: "shopify",
      connectionName: "shop",
      clientId: ORG_SHOPIFY.id,
      clientSecret: ORG_SHOPIFY.secret,
    })
    tokenForms.length = 0
    const token = await getTokenFromAccount(await expire(account.id), env.ENCRYPTION_KEY)
    expect(token).toBe("access-1")
    expect(tokenForms[0]?.get("grant_type")).toBe("refresh_token")
    expect(tokenForms[0]?.get("client_id")).toBe(INSTANCE_SHOPIFY.id)
    expect(tokenForms[0]?.get("client_secret")).toBe(INSTANCE_SHOPIFY.secret)
  })

  it("a webhook signed with the instance's secret is still accepted", async () => {
    setInstance(ALL_INSTANCE)
    await connectShop("hook-store.myshopify.com")
    await upsertConnectionOAuthClient({
      orgId,
      appName: "shopify",
      connectionName: "shop",
      clientId: ORG_SHOPIFY.id,
      clientSecret: ORG_SHOPIFY.secret,
    })
    const stored = await storedWebhookSecret()
    expect((await verifySignedWith(INSTANCE_SHOPIFY.secret, stored)).ok).toBe(true)
    expect((await verifySignedWith(ORG_SHOPIFY.secret, stored)).ok).toBe(false)
  })

  it("saving the org client reports the accounts a reconnect would move", async () => {
    setInstance(ALL_INSTANCE)
    await connectShop("count-store.myshopify.com")
    expect(await accountsMintedByAnotherClient(orgId, ["shopify:shop"], ORG_SHOPIFY.id)).toBe(1)
    expect(await accountsMintedByAnotherClient(orgId, ["shopify:shop"], INSTANCE_SHOPIFY.id)).toBe(
      0,
    )
  })
})

describe("legacy accounts (connected before the minting client was recorded)", () => {
  it("an old Drive account refreshes with the instance's client first, as when it connected", async () => {
    setInstance(ALL_INSTANCE)
    await upsertConnectionOAuthClient({
      orgId,
      appName: "google-drive",
      connectionName: "drive",
      clientId: ROW_DRIVE.id,
      clientSecret: ROW_DRIVE.secret,
    })
    const [account] = await db
      .insert(connectedAccounts)
      .values({
        orgId,
        appName: "google-drive",
        connectionName: "drive",
        ownerType: "org",
        providerType: "oauth2",
        identifier: "drive@example.com",
        accessTokenEncrypted: encryptSecret(
          "old",
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountAccessToken,
        ),
        refreshTokenEncrypted: encryptSecret(
          "refresh",
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountRefreshToken,
        ),
        tokenExpiresAt: new Date(Date.now() - 60_000),
        status: "active",
        createdBy: userId,
        // As migration 0217 backfills every OAuth row that existed before it.
        oauthClientSource: "legacy",
      })
      .returning()
    if (!account) throw new Error("no account")
    await getTokenFromAccount(account, env.ENCRYPTION_KEY)
    expect(tokenForms[0]?.get("client_id")).toBe(INSTANCE_DRIVE.id)
    expect(tokenForms[0]?.get("client_secret")).toBe(INSTANCE_DRIVE.secret)
  })
})

describe("the minting client is gone", () => {
  it("removing the instance client marks the account for reconnect with a clear status", async () => {
    setInstance(ALL_INSTANCE)
    const account = await connectShop("gone-store.myshopify.com")
    setInstance({})
    tokenForms.length = 0
    await expect(
      getTokenFromAccount(await expire(account.id), env.ENCRYPTION_KEY),
    ).rejects.toThrow()
    expect(tokenForms).toHaveLength(0)
    const [reloaded] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, account.id))
    expect(reloaded?.status).toBe("error")
    expect(reloaded?.statusMessage).toBe(MINTING_CLIENT_GONE_MESSAGE)
  })

  it("a different instance client (another id) is not the minting client either", async () => {
    setInstance(ALL_INSTANCE)
    const account = await connectShop("rotated-store.myshopify.com")
    setInstance({ ...ALL_INSTANCE, SHOPIFY_APP_CLIENT_ID: "another-app-id" })
    tokenForms.length = 0
    await expect(
      getTokenFromAccount(await expire(account.id), env.ENCRYPTION_KEY),
    ).rejects.toThrow()
    expect(tokenForms).toHaveLength(0)
  })
})
