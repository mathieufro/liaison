// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The secret-free bridge contract (secret-free.ts, fetch-auth.ts): a
// credential reaches the provider without ever being returned to app code;
// config secrets sign and verify host-side; a Workers-run bridge refuses every
// method that would hand a secret back.
import { afterEach, describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import type { RlsClient } from "~/db"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import {
  type FetchAuthDeps,
  FetchAuthTestAccess,
  injectFetchAuth,
  parseFetchAuth,
} from "~/modules/apps/sandbox/bridge/fetch-auth"
import {
  createConfigSecretMethods,
  forWorkersRun,
  isWorkersRunBridge,
  manifestSecretConfigKeys,
  SECRET_NOT_AVAILABLE_ON_WORKERS,
  secretConfigKeysOf,
} from "~/modules/apps/sandbox/bridge/secret-free"
import {
  type AppManifestForBridge,
  SandboxBridgeTestAccess,
} from "~/modules/apps/sandbox/bridge/shared"
import {
  createRpcBridge,
  createSessionRpcBridge,
  inlinePgCauseOnBridge,
} from "~/modules/apps/sandbox/rpc-bridge"
import { assertNoSecretsIn, findSecretsIn } from "~/modules/apps/workers/secret-scan"
import { buildVerifyBridge } from "~/modules/webhooks/verify-bridge"

const ORG = "00000000-0000-0000-0000-00000000c0de"
const USER = "00000000-0000-0000-0000-000000000001"
const SHOP_TOKEN = "shpat_offline_token_0123456789abcdef"
const KEY = "carrier-key-1234"
const SECRET = "carrier-secret-5678"
const BEARER = "bearer-from-exchange-abcdef"
const WEBHOOK_SECRET = "minted-webhook-secret-0f1e2d3c"

const MANIFEST: AppManifestForBridge = {
  name: "carrier",
  network: { allowedDomains: ["docs.carrier.test"] },
  connections: {
    shop: {
      type: "oauth2",
      allowedDomains: ["*.myshopify.com"],
      clientSecretConfigKey: "shopSecret",
    },
    carrier: {
      type: "credentials",
      allowedDomains: ["api.carrier.test"],
      webhookSecretConfigKey: "carrierWebhookSecret",
      credentialFields: [
        { name: "key", type: "text" },
        { name: "secret", type: "password" },
        { name: "environment", type: "text", readable: true },
        { name: "unused", type: "text", readable: true },
      ],
    },
  },
}
const ALLOWED = ["*.myshopify.com", "api.carrier.test", "docs.carrier.test"]
const CREDS = { key: KEY, secret: SECRET, environment: "sandbox" }

type Seen = { url: string; method: string; headers: Record<string, string>; body: string | null }

function upstream(answer: (req: Seen) => Response): Seen[] {
  const seen: Seen[] = []
  SandboxBridgeTestAccess.setFetchInterceptsHost(() => true)
  SandboxBridgeTestAccess.setFetch((async (url: string, init?: RequestInit) => {
    const req: Seen = {
      url: String(url),
      method: String(init?.method ?? "GET"),
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: typeof init?.body === "string" ? init.body : null,
    }
    seen.push(req)
    return answer(req)
  }) as unknown as typeof fetch)
  return seen
}

function egress(
  config: Record<string, unknown> = {},
  creds: () => Record<string, unknown> = () => CREDS,
): Record<string, any> {
  return createEgressMethods({
    orgId: ORG,
    userId: USER,
    appName: "carrier",
    actorType: "user",
    allowedDomains: ALLOWED,
    callerScopes: [],
    inheritedActor: { actorType: "user" as const },
    manifest: MANIFEST,
    txDb: null,
    // readAppConfigValue reads config through this: answer it like the apps row.
    appTable: () => "apps",
    kernelSchema: "kernel",
    bridgeOptions: {
      withShortTx: async (fn: (db: unknown) => Promise<unknown>) =>
        fn({ execute: async () => [{ config }] }),
    },
    resolveCredentials: async (name: string) => (name === "carrier" ? creds() : {}),
  } as unknown as BridgeContext)
}

const guestFetch = async (b: Record<string, any>, url: string, opts: Record<string, unknown>) =>
  b.fetch(url, JSON.stringify(opts)) as Promise<string>

afterEach(() => {
  SandboxBridgeTestAccess.setFetch(null)
  SandboxBridgeTestAccess.setFetchInterceptsHost(null)
  FetchAuthTestAccess.reset()
})

describe("ctx.fetch auth: the credential is added host-side", () => {
  it("header:<Name> from a credentials field reaches the provider, never the guest (even when echoed)", async () => {
    const seen = upstream(
      (req) =>
        new Response(JSON.stringify({ echoed: req.headers["X-Api-Key"] }), {
          status: 200,
          headers: { "x-echo": req.headers["X-Api-Key"] ?? "" },
        }),
    )
    const out = await guestFetch(egress(), "https://api.carrier.test/v1/rates", {
      method: "GET",
      // An app-set header of the same name is replaced, not kept beside it.
      headers: { "x-api-key": "app-guess" },
      auth: { connection: "carrier", scheme: "header:X-Api-Key", fields: ["secret"] },
    })
    expect(seen[0]!.headers["X-Api-Key"]).toBe(SECRET)
    expect(seen[0]!.headers["x-api-key"]).toBeUndefined()
    expect(JSON.parse(out).status).toBe(200)
    assertNoSecretsIn(out, { secret: SECRET })
    expect(out).toContain("[redacted]")
  })

  it("basic sends base64(user:password) and none of the three values comes back", async () => {
    const seen = upstream((req) => new Response(req.headers.Authorization ?? "", { status: 200 }))
    const out = await guestFetch(egress(), "https://api.carrier.test/v1/cotation", {
      auth: { connection: "carrier", scheme: "basic", fields: ["key", "secret"] },
    })
    expect(seen[0]!.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString("base64")}`,
    )
    assertNoSecretsIn(out, { key: KEY, secret: SECRET })
  })

  it("an oauth2 connection sends its token under the named header", async () => {
    const headers: Record<string, string> = {}
    const deps = fakeDeps()
    await injectFetchAuth(
      "https://demo-store.myshopify.com/admin/api/2026-04/graphql.json",
      headers,
      parseFetchAuth({
        connection: "shop",
        identifier: "demo-store.myshopify.com",
        scheme: "header:X-Shopify-Access-Token",
      })!,
      deps,
    )
    expect(headers["X-Shopify-Access-Token"]).toBe(SHOP_TOKEN)
    expect(deps.tokenCalls).toEqual([["shop", "demo-store.myshopify.com"]])
  })

  it("an oauth2 account that is a host sends its token to that host only, not another shop under the wildcard", async () => {
    const otherShop = "https://other-store.myshopify.com/admin/api/2026-04/graphql.json"
    const refusedWith = async (identifier: string | undefined) => {
      const headers: Record<string, string> = {}
      const deps = fakeDeps()
      const err = (await injectFetchAuth(
        otherShop,
        headers,
        parseFetchAuth({
          connection: "shop",
          ...(identifier ? { identifier } : {}),
          scheme: "header:X-Shopify-Access-Token",
        })!,
        deps,
      ).catch((e: unknown) => e)) as { status?: number; code?: string }
      return { err, headers, deps }
    }
    // Named account: refused before its token is read.
    const named = await refusedWith("demo-store.myshopify.com")
    expect(named.err.status).toBe(403)
    expect(named.err.code).toBe("credential_host_not_allowed")
    expect(named.headers).toEqual({})
    expect(named.deps.tokenCalls).toEqual([])
    // Default account (it resolves to demo-store): refused, no header added.
    const byDefault = await refusedWith(undefined)
    expect(byDefault.err.code).toBe("credential_host_not_allowed")
    expect(byDefault.headers).toEqual({})
    expect(byDefault.deps.tokenCalls).toEqual([["shop", undefined]])
    // Its own host still gets it, and the injection names the host it is bound to.
    const headers: Record<string, string> = {}
    const ok = await injectFetchAuth(
      "https://Demo-Store.myshopify.com/admin/api/2026-04/graphql.json",
      headers,
      parseFetchAuth({ connection: "shop", scheme: "header:X-Shopify-Access-Token" })!,
      fakeDeps(),
    )
    expect(headers["X-Shopify-Access-Token"]).toBe(SHOP_TOKEN)
    expect(ok.boundHost).toBe("demo-store.myshopify.com")
  })

  it("refuses a host outside the connection's own domains, before reading the credential", async () => {
    const seen = upstream(() => new Response("{}", { status: 200 }))
    const err = (await guestFetch(egress(), "https://docs.carrier.test/x", {
      auth: { connection: "carrier", scheme: "header:X-Api-Key", fields: ["secret"] },
    }).catch((e: unknown) => e)) as { status?: number; code?: string }
    expect(err.status).toBe(403)
    expect(err.code).toBe("credential_host_not_allowed")
    expect(seen).toHaveLength(0)
  })

  it("refuses an undeclared field, a credential header like Cookie, and an unknown scheme", () => {
    expect(() => parseFetchAuth({ connection: "carrier", scheme: "header:Cookie" })).toThrow(
      /may not carry/,
    )
    expect(() => parseFetchAuth({ connection: "carrier", scheme: "digest" })).toThrow(
      /unknown scheme/,
    )
  })

  it("bearer exchange: one token POST for two calls, the bearer never reaches the guest, a 401 re-exchanges", async () => {
    let bizCalls = 0
    const seen = upstream((req) => {
      if (req.url.endsWith("/token")) {
        return new Response(JSON.stringify({ accessToken: BEARER, expiresIn: 3600 }), {
          status: 200,
        })
      }
      bizCalls++
      return new Response(JSON.stringify({ seen: req.headers.Authorization }), {
        status: bizCalls === 3 ? 401 : 200,
      })
    })
    const b = egress()
    const auth = {
      connection: "carrier",
      scheme: "bearer",
      exchange: { url: "https://api.carrier.test/token", fields: ["key", "secret"] },
    }
    const first = await guestFetch(b, "https://api.carrier.test/v3/orders", { auth })
    await guestFetch(b, "https://api.carrier.test/v3/orders", { auth })
    const tokenPosts = () => seen.filter((s) => s.url.endsWith("/token"))
    expect(tokenPosts()).toHaveLength(1)
    expect(tokenPosts()[0]!.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString("base64")}`,
    )
    expect(
      seen
        .filter((s) => !s.url.endsWith("/token"))
        .every((s) => s.headers.Authorization === `Bearer ${BEARER}`),
    ).toBe(true)
    assertNoSecretsIn(first, { bearer: BEARER, key: KEY, secret: SECRET })
    // Third call answers 401: the cached bearer is dropped, the next call exchanges again.
    expect(
      JSON.parse(await guestFetch(b, "https://api.carrier.test/v3/orders", { auth })).status,
    ).toBe(401)
    await guestFetch(b, "https://api.carrier.test/v3/orders", { auth })
    expect(tokenPosts()).toHaveLength(2)
  })

  it("bearer exchange: a reconnect with other keys exchanges again, never reusing the old bearer", async () => {
    let issued = 0
    const seen = upstream((req) => {
      if (req.url.endsWith("/token")) {
        issued++
        return new Response(
          JSON.stringify({ accessToken: `${BEARER}-${issued}`, expiresIn: 3600 }),
          {
            status: 200,
          },
        )
      }
      return new Response("{}", { status: 200 })
    })
    let stored: Record<string, unknown> = CREDS
    const b = egress({}, () => stored)
    const auth = {
      connection: "carrier",
      scheme: "bearer",
      exchange: { url: "https://api.carrier.test/token", fields: ["key", "secret"] },
    }
    await guestFetch(b, "https://api.carrier.test/v3/orders", { auth })
    await guestFetch(b, "https://api.carrier.test/v3/orders", { auth })
    // The account is reconnected with another key pair (same connection, same account slot).
    stored = { key: "other-account-key-9876", secret: "other-account-secret-5432" }
    await guestFetch(b, "https://api.carrier.test/v3/orders", { auth })
    const tokenPosts = seen.filter((s) => s.url.endsWith("/token"))
    expect(tokenPosts).toHaveLength(2)
    expect(tokenPosts[1]!.headers.Authorization).toBe(
      `Basic ${Buffer.from("other-account-key-9876:other-account-secret-5432").toString("base64")}`,
    )
    const business = seen.filter((s) => !s.url.endsWith("/token"))
    expect(business.map((s) => s.headers.Authorization)).toEqual([
      `Bearer ${BEARER}-1`,
      `Bearer ${BEARER}-1`,
      `Bearer ${BEARER}-2`,
    ])
    // The old account's bearer is dropped, not kept beside the new one.
    expect(FetchAuthTestAccess.cachedCount()).toBe(1)
  })

  it("a failed exchange answers the guest with the token endpoint's status and no business call", async () => {
    const seen = upstream((req) =>
      req.url.endsWith("/token")
        ? new Response('{"message":"bad credentials"}', { status: 401 })
        : new Response("{}", { status: 200 }),
    )
    const out = JSON.parse(
      await guestFetch(egress(), "https://api.carrier.test/v3/orders", {
        auth: {
          connection: "carrier",
          scheme: "bearer",
          exchange: { url: "https://api.carrier.test/token", fields: ["key", "secret"] },
        },
      }),
    )
    expect(out.status).toBe(401)
    expect(seen.map((s) => s.url)).toEqual(["https://api.carrier.test/token"])
  })

  it("configSecrets writes the declared secret into the body host-side and redacts an echo", async () => {
    const seen = upstream((req) => new Response(req.body ?? "", { status: 200 }))
    const out = await guestFetch(
      egress({ carrierWebhookSecret: WEBHOOK_SECRET }),
      "https://api.carrier.test/v3/subscription",
      {
        method: "POST",
        body: JSON.stringify({ webhookSecret: "__CONFIG_SECRET_carrierWebhookSecret__" }),
        configSecrets: { __CONFIG_SECRET_carrierWebhookSecret__: "carrierWebhookSecret" },
      },
    )
    expect(JSON.parse(seen[0]!.body!)).toEqual({ webhookSecret: WEBHOOK_SECRET })
    assertNoSecretsIn(out, { webhook: WEBHOOK_SECRET })
  })

  it("configSecrets refuses a key that is not a declared secret", async () => {
    upstream(() => new Response("{}", { status: 200 }))
    const err = (await guestFetch(
      egress({ plain: "x" }),
      "https://api.carrier.test/v3/subscription",
      {
        method: "POST",
        body: "__CONFIG_SECRET_plain_____",
        configSecrets: { __CONFIG_SECRET_plain_____: "plain" },
      },
    ).catch((e: unknown) => e)) as { code?: string }
    expect(err.code).toBe("not_a_secret_config_key")
  })
})

describe("connections_getSettings", () => {
  it("returns only readable non-password values, and names the empty fields", async () => {
    const out = JSON.parse(await egress().connections_getSettings("carrier"))
    expect(out).toEqual({ values: { environment: "sandbox" }, missing: ["unused"] })
  })
})

describe("HMAC by config key", () => {
  // A Shopify-style delivery: base64 HMAC-SHA256 of the raw body under the app secret.
  const BODY = '{"id":820982911946154508,"email":"jon@example.com"}'
  const SIG = createHmac("sha256", WEBHOOK_SECRET).update(BODY, "utf8").digest("base64")
  const methods = createConfigSecretMethods({
    readConfig: async (k) =>
      k === "carrierWebhookSecret" ? WEBHOOK_SECRET : k === "plain" ? "v" : null,
    secretConfigKeys: manifestSecretConfigKeys(MANIFEST.connections),
  })

  it("verifies a real signature and rejects a wrong one", async () => {
    expect(
      await methods.crypto_verifyHmacForConfig!("carrierWebhookSecret", BODY, SIG, "base64"),
    ).toBe(true)
    expect(
      await methods.crypto_verifyHmacForConfig!("carrierWebhookSecret", `${BODY} `, SIG, "base64"),
    ).toBe(false)
    expect(
      await methods.crypto_verifyHmacForConfig!("carrierWebhookSecret", BODY, "short", "base64"),
    ).toBe(false)
    const hex = createHmac("sha256", WEBHOOK_SECRET).update(BODY, "utf8").digest("hex")
    expect(
      await methods.crypto_verifyHmacForConfig!("carrierWebhookSecret", BODY, hex, "hex"),
    ).toBe(true)
  })

  it("signs with the config secret, and answers null/false while it is unset", async () => {
    expect(await methods.crypto_hmacSha256Base64ForConfig!("carrierWebhookSecret", BODY)).toBe(SIG)
    expect(await methods.crypto_hmacSha256Base64ForConfig!("shopSecret", BODY)).toBeNull()
    expect(await methods.crypto_verifyHmacForConfig!("shopSecret", BODY, SIG, "base64")).toBe(false)
    expect(await methods.config_has!("carrierWebhookSecret")).toBe(true)
    expect(await methods.config_has!("shopSecret")).toBe(false)
  })

  it("refuses a config key that is not a declared secret", async () => {
    const err = (await methods.crypto_hmacSha256Base64ForConfig!("plain", BODY).catch(
      (e: unknown) => e,
    )) as {
      code?: string
    }
    expect(err.code).toBe("not_a_secret_config_key")
  })
})

describe("Workers mode", () => {
  const secretMethods = ["connections_getToken", "connections_getCredentials"] as const

  async function refusal(p: Promise<unknown>): Promise<{ status?: number; code?: string }> {
    return (await p.then(
      () => ({}),
      (e: unknown) => e,
    )) as { status?: number; code?: string }
  }

  it("a Workers-run rpc bridge refuses each secret method with the typed code (before any db read)", async () => {
    const poison = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("db touched")
        },
      },
    ) as unknown as RlsClient
    const bridge = createRpcBridge("carrier", USER, ORG, poison, MANIFEST, [], "user", undefined, {
      workersRun: true,
    })
    expect(isWorkersRunBridge(bridge)).toBe(true)
    for (const name of secretMethods) {
      expect(bridge[name].constructor.name).toBe("AsyncFunction")
      const err = await refusal(bridge[name]("carrier"))
      expect(err.status).toBe(403)
      expect(err.code).toBe(SECRET_NOT_AVAILABLE_ON_WORKERS)
    }
    for (const key of ["carrierWebhookSecret", "shopSecret"]) {
      const err = await refusal(bridge.config_get(key))
      expect(err.code).toBe(SECRET_NOT_AVAILABLE_ON_WORKERS)
    }
    // The secret-free calls stay.
    for (const name of [
      "fetch",
      "connections_getSettings",
      "config_has",
      "crypto_verifyHmacForConfig",
    ]) {
      expect(typeof bridge[name]).toBe("function")
    }
  })

  it("the session bridge carries the mode into every per-call rebuild", async () => {
    // Each call rebuilds the bridge on the call's transaction (a poison one here).
    const poison = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("db touched")
        },
      },
    ) as unknown as RlsClient
    const session = { run: async <T>(fn: (tx: RlsClient) => Promise<T>) => fn(poison) }
    const bridge = createSessionRpcBridge(
      "carrier",
      USER,
      ORG,
      session,
      MANIFEST,
      [],
      "user",
      undefined,
      {
        workersRun: true,
      },
    )
    expect(isWorkersRunBridge(bridge)).toBe(true)
    const err = await refusal(bridge.connections_getToken("shop"))
    expect(err.code).toBe(SECRET_NOT_AVAILABLE_ON_WORKERS)
  })

  it("a QuickJS bridge (no workersRun) keeps the methods", () => {
    const bridge = createRpcBridge("carrier", USER, ORG, null as unknown as RlsClient, MANIFEST)
    expect(isWorkersRunBridge(bridge)).toBe(false)
    expect(bridge.connections_getToken.toString()).not.toContain("secretNotAvailableOnWorkers")
  })

  it("a bridge records the secret keys its config_get decrypts, so runApp's forWorkersRun refuses them (no registry)", async () => {
    // The connection registry is empty in this process: the keys come from the manifest.
    const session = { run: async <T>(fn: (tx: RlsClient) => Promise<T>) => fn(null as never) }
    const session2 = createSessionRpcBridge("carrier", USER, ORG, session, MANIFEST, [], "user")
    const ambient = inlinePgCauseOnBridge(
      createRpcBridge("carrier", USER, ORG, null as unknown as RlsClient, MANIFEST),
    )
    for (const built of [session2, ambient]) {
      expect(isWorkersRunBridge(built)).toBe(false)
      const resolve = secretConfigKeysOf(built)
      expect(resolve).not.toBeNull()
      expect(new Set(await resolve!())).toEqual(new Set(["shopSecret", "carrierWebhookSecret"]))
      const b = forWorkersRun(built, { secretConfigKeys: resolve })
      for (const key of ["carrierWebhookSecret", "shopSecret"]) {
        expect((await refusal(b.config_get(key))).code).toBe(SECRET_NOT_AVAILABLE_ON_WORKERS)
      }
    }
  })

  it("forWorkersRun fails closed: no key source, or one that throws, refuses every config_get", async () => {
    const plain = () => ({ config_get: async (k: string) => `value-of-${k}` })
    const none = forWorkersRun(plain(), { secretConfigKeys: null })
    expect((await refusal(none.config_get("plain"))).code).toBe(SECRET_NOT_AVAILABLE_ON_WORKERS)
    const broken = forWorkersRun(plain(), {
      secretConfigKeys: async () => {
        throw new Error("manifest unavailable")
      },
    })
    expect((await refusal(broken.config_get("plain"))).code).toBe(SECRET_NOT_AVAILABLE_ON_WORKERS)
    const resolved = forWorkersRun(plain(), { secretConfigKeys: async () => ["s"] })
    expect(await resolved.config_get("plain")).toBe("value-of-plain")
    expect((await refusal(resolved.config_get("s"))).code).toBe(SECRET_NOT_AVAILABLE_ON_WORKERS)
  })

  it("forWorkersRun lets a non-secret config key through", async () => {
    const b = forWorkersRun(
      { config_get: async (k: string) => `value-of-${k}` },
      { secretConfigKeys: ["s"] },
    )
    expect(await b.config_get("plain")).toBe("value-of-plain")
    expect((await refusal(b.config_get("s"))).code).toBe(SECRET_NOT_AVAILABLE_ON_WORKERS)
  })

  it("the webhook verifier's inline bridge refuses its secret on Workers, and still verifies by key", async () => {
    const BODY = '{"tracking":"in_transit"}'
    const sig = createHmac("sha256", WEBHOOK_SECRET).update(BODY).digest("base64")
    const bridge = buildVerifyBridge({
      readConfig: async (k) => (k === "carrierWebhookSecret" ? WEBHOOK_SECRET : null),
      secretConfigKeys: manifestSecretConfigKeys(MANIFEST.connections),
      workersRun: true,
    })
    expect((await refusal(bridge.config_get!("carrierWebhookSecret"))).code).toBe(
      SECRET_NOT_AVAILABLE_ON_WORKERS,
    )
    expect(
      await bridge.crypto_verifyHmacForConfig!("carrierWebhookSecret", BODY, sig, "base64"),
    ).toBe(true)
    const plain = buildVerifyBridge({
      readConfig: async () => WEBHOOK_SECRET,
      secretConfigKeys: ["carrierWebhookSecret"],
    })
    expect(await plain.config_get!("carrierWebhookSecret")).toBe(WEBHOOK_SECRET)
  })
})

describe("assertNoSecretsIn", () => {
  it("finds a secret raw, base64 or JSON-escaped, and names it by label", () => {
    expect(
      findSecretsIn(`x ${Buffer.from("s3cret!!").toString("base64")}`, { api: "s3cret!!" }),
    ).toEqual(["api"])
    expect(() => assertNoSecretsIn({ body: 'a"quoted"secret' }, ['a"quoted"secret'])).toThrow(
      /secret #0/,
    )
    expect(() => assertNoSecretsIn("clean", { api: "s3cret!!" })).not.toThrow()
  })
})

function fakeDeps(): FetchAuthDeps & { tokenCalls: Array<[string, string | undefined]> } {
  const tokenCalls: Array<[string, string | undefined]> = []
  return {
    manifest: MANIFEST,
    orgId: ORG,
    userId: USER,
    appName: "carrier",
    readToken: async (c, id) => {
      tokenCalls.push([c, id])
      return { token: SHOP_TOKEN, identifier: id ?? "demo-store.myshopify.com" }
    },
    readCredentials: async () => CREDS,
    readConfigSecret: async () => null,
    send: async () => {
      throw new Error("no exchange here")
    },
    tokenCalls,
  }
}
