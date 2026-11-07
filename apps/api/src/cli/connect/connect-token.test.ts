// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison connect <app>/<connection> --token-env <VAR>`: a static access token
 * stored through the OAuth callback's own storage (connectWithAccessToken ->
 * persistOAuthGrant), against the real test DB. The connection declaration is
 * registered directly (the shape a Shopify-like manifest registers), so no app
 * bundle is needed; everything after that is the production code.
 *
 * Discriminators: the stored token is ciphertext that decrypts to the token
 * under the access-token context; the client secret lands encrypted under the
 * declared `clientSecretConfigKey`; a `connected_account:create` event is in
 * the outbox; the same account's earlier row is retired; the token never
 * reaches the log; a credentials connection is refused.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel } from "~/apps/tickets/schema-refs"
import { type ConnectDeps, createConnect } from "~/cli/connect"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { seedAppRow } from "~/seed/factories/org/platform-rows"
import { acquireTestLock, releaseTestLock, truncateOrgTables } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const APP = "tokenprobe"
const TOKEN = `shpat_${crypto.randomBytes(16).toString("hex")}`
const SECRET = `whsec_${crypto.randomBytes(16).toString("hex")}`

let orgId: string
let orgSlug: string
let adminId: string

beforeEach(async () => {
  await truncateOrgTables()
  orgSlug = `cli-token-${crypto.randomUUID().slice(0, 12)}`
  orgId = (await ensureOrg({ slug: orgSlug, name: "TokenTestOrg" })).orgId
  adminId = (
    await ensureUser({
      orgId,
      email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
      name: "Owner",
      password: "pw-connect-1!",
      role: "admin",
    })
  ).userId
  await seedAppRow({ orgId, name: APP, version: "1.0.0", config: { keep: "me" } })
  connectionConfigRegistry.set([orgId, APP, "shop"], {
    type: "oauth2",
    authorizationUrl: "https://{shop}/admin/oauth/authorize",
    tokenUrl: "https://{shop}/admin/oauth/access_token",
    scopes: ["read_orders"],
    allowedDomains: ["myshopify.com"],
    templateVars: {
      shop: {
        lowercase: true,
        pattern: "^[a-z0-9][a-z0-9-]*(\\.myshopify\\.com)?$",
        appendSuffix: ".myshopify.com",
      },
    },
    identifierVar: "shop",
    clientSecretConfigKey: "probeWebhookSecret",
  })
  connectionConfigRegistry.set([orgId, APP, "api"], {
    type: "credentials",
    allowedDomains: ["api.example.com"],
  })
})

function makeDeps(envVars: Record<string, string>): { deps: ConnectDeps; lines: string[] } {
  const lines: string[] = []
  const deps: ConnectDeps = {
    ensureAppsForOrg: async () => {},
    saveGoogleIntegrationConfig: async () => {},
    startOAuthFlow: async () => {
      throw new Error("no OAuth flow in a --token-env connect")
    },
    log: (msg) => lines.push(msg),
    pollIntervalMs: 1,
    pollTimeoutMs: 50,
    sleep: () => Promise.resolve(),
    guide: async () => ({ refuse: false, lines: [] }),
    readEnv: (name) => envVars[name],
  }
  return { deps, lines }
}

async function accounts() {
  return withPrivilegedDb(orgId, "test-token-accounts", async (tx) =>
    extractRows<{
      id: string
      identifier: string
      status: string
      owner_type: string
      provider_type: string
      access_token_encrypted: string | null
      oauth_client_source: string | null
      metadata: { grantedOAuthScopes?: string[] } | null
    }>(
      await tx.execute(drizzleSql`
        SELECT id, identifier, status, owner_type, provider_type, access_token_encrypted,
               oauth_client_source, metadata
        FROM ${kernelRel("connected_accounts")}
        WHERE org_id = ${orgId}::uuid AND app_name = ${APP}
        ORDER BY created_at ASC
      `),
    ),
  )
}

describe("connect --token-env", () => {
  test("stores the token encrypted, mirrors the client secret, queues the connect event", async () => {
    const { deps, lines } = makeDeps({ PROBE_TOKEN: TOKEN, PROBE_SECRET: SECRET })
    const run = createConnect(deps)
    const first = await run({
      ref: `${APP}/shop`,
      org: orgSlug,
      tokenEnv: "PROBE_TOKEN",
      account: "Acme-Store",
      clientSecretEnv: "PROBE_SECRET",
      scopes: "read_orders, write_orders",
    })
    expect(first.exitCode).toBe(0)

    const rows = await accounts()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    // The identifier is the template rule's canonical value.
    expect(row.identifier).toBe("acme-store.myshopify.com")
    expect(row.status).toBe("active")
    expect(row.owner_type).toBe("org")
    expect(row.provider_type).toBe("oauth2")
    expect(row.oauth_client_source).toBeNull()
    expect(row.metadata?.grantedOAuthScopes).toEqual(["read_orders", "write_orders"])
    // Ciphertext at rest, the token under the access-token context.
    expect(row.access_token_encrypted).not.toContain(TOKEN)
    expect(
      decryptSecret(
        row.access_token_encrypted!,
        env.ENCRYPTION_KEY,
        CryptoContext.connectedAccountAccessToken,
      ),
    ).toBe(TOKEN)

    const [app] = await withPrivilegedDb(orgId, "test-token-app-config", async (tx) =>
      extractRows<{ config: Record<string, string> }>(
        await tx.execute(
          drizzleSql`SELECT config FROM ${kernelRel("apps")} WHERE org_id = ${orgId}::uuid AND name = ${APP}`,
        ),
      ),
    )
    expect(app!.config.keep).toBe("me")
    expect(app!.config.probeWebhookSecret).not.toBe(SECRET)
    expect(
      decryptSecret(
        app!.config.probeWebhookSecret!,
        process.env.ENCRYPTION_KEY ?? env.ENCRYPTION_KEY,
        CryptoContext.appConfigConnectionSecret,
      ),
    ).toBe(SECRET)

    const events = await withPrivilegedDb(orgId, "test-token-events", async (tx) =>
      extractRows<{ payload: Record<string, unknown> }>(
        await tx.execute(drizzleSql`
          SELECT payload FROM ${kernelRel("pending_events")}
          WHERE org_id = ${orgId}::uuid
            AND payload->>'entity' = 'connected_account' AND payload->>'action' = 'create'
        `),
      ),
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({
      app: "kernel",
      entityId: row.id,
      actorId: adminId,
      data: {
        appName: APP,
        connectionName: "shop",
        identifier: "acme-store.myshopify.com",
        ownerType: "org",
        grantedOAuthScopes: ["read_orders", "write_orders"],
      },
    })

    // The token and the secret never reach the output.
    expect(lines.join("\n")).not.toContain(TOKEN)
    expect(lines.join("\n")).not.toContain(SECRET)
    expect(lines.join("\n")).toContain("acme-store.myshopify.com")

    // A second connect of the same account replaces the row, as an OAuth reconnect does.
    const second = await run({
      ref: `${APP}/shop`,
      org: orgId,
      tokenEnv: "PROBE_TOKEN",
      account: "acme-store.myshopify.com",
    })
    expect(second.exitCode).toBe(0)
    const after = await accounts()
    expect(after.map((r) => r.status)).toEqual(["disconnected", "active"])
    expect(after[0]!.access_token_encrypted).toBeNull()
    // Without --client-secret-env the operator is told what it means.
    expect(lines.some((l) => l.includes("no --client-secret-env"))).toBe(true)
  })

  test("refuses a connection that is not OAuth, and an unset or empty variable", async () => {
    const { deps, lines } = makeDeps({ PROBE_TOKEN: TOKEN, EMPTY: "  " })
    const run = createConnect(deps)
    expect((await run({ ref: `${APP}/api`, org: orgSlug, tokenEnv: "PROBE_TOKEN" })).exitCode).toBe(
      2,
    )
    expect(lines.some((l) => l.includes("not an OAuth connection"))).toBe(true)
    expect(
      (await run({ ref: `${APP}/shop`, org: orgSlug, tokenEnv: "MISSING", account: "acme" }))
        .exitCode,
    ).toBe(2)
    expect(
      (await run({ ref: `${APP}/shop`, org: orgSlug, tokenEnv: "EMPTY", account: "acme" }))
        .exitCode,
    ).toBe(2)
    // A connection identified by a template variable needs the account.
    expect(
      (await run({ ref: `${APP}/shop`, org: orgSlug, tokenEnv: "PROBE_TOKEN" })).exitCode,
    ).toBe(2)
    // An account the rule refuses stores nothing.
    expect(
      (
        await run({
          ref: `${APP}/shop`,
          org: orgSlug,
          tokenEnv: "PROBE_TOKEN",
          account: "bad shop!",
        })
      ).exitCode,
    ).toBe(1)
    expect(await accounts()).toHaveLength(0)
    expect(lines.join("\n")).not.toContain(TOKEN)
  })
})
