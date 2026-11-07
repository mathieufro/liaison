// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { connectionConfigRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import {
  createCredentialConnection,
  decryptConnectionConfigValue,
  disconnectConnection,
  getCredentialsForConnection,
  getFrontendRedirectUrl,
  getTokenFromAccount,
  reconcileConnection,
  resolveConnectionSecretConfigKeys,
  startOAuthFlow,
  validateAccountStatus,
} from "~/modules/apps/connections/service"

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
// A few tests below set `process.env.ENCRYPTION_KEY` to the local test key
// above (getCredentialsForConnection reads it, not an injected param). Bun
// runs every test file in one process, so an un-restored mutation here leaks
// into every OTHER test file that runs afterward in the same suite and reads
// `process.env.ENCRYPTION_KEY` — snapshot + restore it after each test.
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY

afterEach(() => {
  resetAppRegistries()
  process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY
})

describe("connected accounts service", () => {
  // `orderedBy` records whether the lookup applied an ORDER BY. It must: the
  // read takes LIMIT 1, so without one an org carrying two active rows for the
  // same connection gets an arbitrary winner, and a freshly entered credential
  // can silently lose to a dead one.
  function makeTxWithAccounts(rows: any[], orderedBy?: { used: boolean }) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: (...args: unknown[]) => {
              if (orderedBy) orderedBy.used = args.length > 0
              return { limit: () => Promise.resolve(rows) }
            },
            limit: () => Promise.resolve(rows),
          }),
        }),
      }),
    } as any
  }

  it("orders the connection lookup so the newest credential wins, never an arbitrary row", async () => {
    const ordered = { used: false }
    // Only the QUERY SHAPE matters here: whatever the row decrypts to, the
    // lookup must have applied an ORDER BY before its LIMIT 1.
    await getCredentialsForConnection(
      makeTxWithAccounts(
        [{ status: "active", statusMessage: null, credentialsEncrypted: "whatever" }],
        ordered,
      ),
      "org-1",
      "user-1",
      "test",
      "imap",
    ).catch(() => undefined)
    expect(ordered.used).toBe(true)
  })

  it("encrypts and decrypts access tokens round-trip", () => {
    const token = "gho_abc123secrettoken"
    const encrypted = encryptSecret(
      token,
      ENCRYPTION_KEY,
      CryptoContext.connectedAccountAccessToken,
    )
    expect(encrypted).not.toBe(token)
    expect(encrypted).toContain(".")
    const decrypted = decryptSecret(
      encrypted,
      ENCRYPTION_KEY,
      CryptoContext.connectedAccountAccessToken,
    )
    expect(decrypted).toBe(token)
  })

  it("encrypts and decrypts credential blobs round-trip", () => {
    const creds = JSON.stringify({ host: "imap.example.com", password: "secret" })
    const encrypted = encryptSecret(
      creds,
      ENCRYPTION_KEY,
      CryptoContext.connectedAccountCredentials,
    )
    const decrypted = decryptSecret(
      encrypted,
      ENCRYPTION_KEY,
      CryptoContext.connectedAccountCredentials,
    )
    expect(decrypted).toBe(creds)
  })

  it("token refresh skips refresh when token is not expired", async () => {
    const account = {
      id: "acc-1",
      accessTokenEncrypted: encryptSecret(
        "valid-token",
        ENCRYPTION_KEY,
        CryptoContext.connectedAccountAccessToken,
      ),
      refreshTokenEncrypted: encryptSecret(
        "refresh",
        ENCRYPTION_KEY,
        CryptoContext.connectedAccountRefreshToken,
      ),
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour from now
      status: "active",
    }
    const token = await getTokenFromAccount(account as any, ENCRYPTION_KEY)
    expect(token).toBe("valid-token")
  })

  it("throws for disconnected account", () => {
    const account = { status: "disconnected" }
    expect(() => validateAccountStatus(account as any)).toThrow("disconnected")
  })

  it("throws for error account", () => {
    const account = { status: "error", statusMessage: "Token revoked" }
    expect(() => validateAccountStatus(account as any)).toThrow("re-authorization")
  })

  it("returns decrypted credentials for an active credential connection", async () => {
    process.env.ENCRYPTION_KEY = ENCRYPTION_KEY
    const credentials = {
      imapHost: "imap.example.com",
      imapPort: "993",
      username: "alice",
      password: "secret",
    }

    const result = await getCredentialsForConnection(
      makeTxWithAccounts([
        {
          status: "active",
          statusMessage: null,
          credentialsEncrypted: encryptSecret(
            JSON.stringify(credentials),
            ENCRYPTION_KEY,
            CryptoContext.connectedAccountCredentials,
          ),
        },
      ]),
      "org-1",
      "user-1",
      "test",
      "imap",
      "alice@example.com",
    )

    expect(result).toEqual(credentials)
  })

  it("throws for disconnected or error credential connections", async () => {
    process.env.ENCRYPTION_KEY = ENCRYPTION_KEY

    await expect(
      getCredentialsForConnection(
        makeTxWithAccounts([
          { status: "disconnected", statusMessage: null, credentialsEncrypted: "ignored" },
        ]),
        "org-1",
        "user-1",
        "test",
        "imap",
      ),
    ).rejects.toThrow("disconnected")

    await expect(
      getCredentialsForConnection(
        makeTxWithAccounts([
          { status: "error", statusMessage: "Token revoked", credentialsEncrypted: "ignored" },
        ]),
        "org-1",
        "user-1",
        "test",
        "imap",
      ),
    ).rejects.toThrow("re-authorization")
  })

  it("throws when credentialsEncrypted is missing", async () => {
    await expect(
      getCredentialsForConnection(
        makeTxWithAccounts([{ status: "active", statusMessage: null, credentialsEncrypted: null }]),
        "org-1",
        "user-1",
        "test",
        "imap",
      ),
    ).rejects.toThrow("connection_credentials_missing")
  })

  it("rejects unsafe OAuth connection endpoints before starting the flow", async () => {
    connectionConfigRegistry.set(["org-1", "test-app", "gitlab"], {
      type: "oauth2",
      authorizationUrl: "http://127.0.0.1/oauth/authorize",
      tokenUrl: "https://203.0.113.20/oauth/token",
      scopes: ["read_user"],
      allowedDomains: ["gitlab.com"],
    })

    await expect(startOAuthFlow("org-1", "user-1", "test-app", "gitlab")).rejects.toThrow(
      "Unsafe OAuth connection endpoint",
    )
  })

  it("builds OAuth callback redirects against the frontend origin", async () => {
    const params = new URLSearchParams({ oauth_error: "access_denied" })
    expect(await getFrontendRedirectUrl(null, "/settings/mail/accounts", params)).toBe(
      "http://localhost:5173/settings/mail/accounts?oauth_error=access_denied",
    )
  })

  it("rejects a templated OAuth URL variable that has no declared validation rule", async () => {
    // `{shop}` appears in the auth/token URL but the connection declares no
    // templateVars rule for it — the kernel must refuse to substitute the raw
    // (attacker-controlled) value rather than letting it redirect the flow.
    connectionConfigRegistry.set(["org-1", "shop-app", "shopify"], {
      type: "oauth2",
      authorizationUrl: "https://{shop}.myshopify.com/admin/oauth/authorize",
      tokenUrl: "https://{shop}.myshopify.com/admin/oauth/access_token",
      scopes: ["read_products"],
      allowedDomains: ["myshopify.com"],
    })

    await expect(
      startOAuthFlow("org-1", "user-1", "shop-app", "shopify", { shop: "evil.com/" }),
    ).rejects.toThrow(/declares no templateVars rule/)
  })

  it("rejects a templated OAuth URL value that fails the declared pattern", async () => {
    // A rule is declared, but the attacker-supplied value injects a host that
    // does not match the anchored pattern → rejected before any substitution.
    connectionConfigRegistry.set(["org-1", "shop-app", "shopify"], {
      type: "oauth2",
      authorizationUrl: "https://{shop}.myshopify.com/admin/oauth/authorize",
      tokenUrl: "https://{shop}.myshopify.com/admin/oauth/access_token",
      scopes: ["read_products"],
      allowedDomains: ["myshopify.com"],
      templateVars: {
        shop: {
          lowercase: true,
          pattern: "^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$",
          appendSuffix: ".myshopify.com",
        },
      },
    })

    await expect(
      startOAuthFlow("org-1", "user-1", "shop-app", "shopify", { shop: "evil.com/" }),
    ).rejects.toThrow(/Invalid value for "shop"/)
  })

  it("throws when a required template variable value is missing", async () => {
    connectionConfigRegistry.set(["org-1", "shop-app", "shopify"], {
      type: "oauth2",
      authorizationUrl: "https://{shop}.myshopify.com/admin/oauth/authorize",
      tokenUrl: "https://{shop}.myshopify.com/admin/oauth/access_token",
      scopes: ["read_products"],
      allowedDomains: ["myshopify.com"],
      templateVars: {
        shop: {
          lowercase: true,
          pattern: "^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$",
          appendSuffix: ".myshopify.com",
        },
      },
    })

    await expect(startOAuthFlow("org-1", "user-1", "shop-app", "shopify")).rejects.toThrow(
      /requires a "shop" value/,
    )
  })
})

describe("createCredentialConnection — kernelPublicBaseUrl (K3) + webhook-secret mint (K-WEBHOOK-SECRET)", () => {
  afterEach(() => {
    resetAppRegistries()
  })

  /**
   * Programmable tx mock: records `queueEvent` payloads and `apps.config`
   * overlays, and seeds the `select` read used by the webhook-secret mint.
   *
   * `overlays` keeps the coarse "which set keys were written" view; `overlayJson`
   * captures the actual `JSON.stringify({ [key]: value })` overlay string the
   * mint interpolates into the Drizzle `config = coalesce(...) || ${overlay}`
   * fragment (it surfaces as a raw string primitive in `queryChunks`), so a test
   * can assert the STORED value is ciphertext, not plaintext.
   */
  function makeTx(opts?: { existingConfig?: Record<string, unknown>; existingAccount?: string }) {
    const events: any[] = []
    const overlays: string[] = []
    const overlayJson: Array<Record<string, unknown>> = []
    const inserts: any[] = []
    const updates: any[] = []
    const tx = {
      insert: () => ({
        values: (vals: any) => {
          inserts.push(vals)
          return { returning: () => Promise.resolve([{ id: "acc-1", status: "active" }]) }
        },
      }),
      // Two different reads go through `select` here: the EXISTING-connection
      // lookup (selects `{ id }`) that decides replace-vs-insert, and the
      // apps.config read for the webhook-secret mint (selects `{ config }`).
      // `opts.existingAccount` makes the first one return a row so the
      // replace path can be exercised.
      select: (cols?: Record<string, unknown>) => ({
        from: () => ({
          // The owner-conflict read joins the owner's name; no other holder here.
          leftJoin: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
          where: () => ({
            limit: () =>
              cols && "id" in cols
                ? Promise.resolve(opts?.existingAccount ? [{ id: opts.existingAccount }] : [])
                : Promise.resolve([{ config: opts?.existingConfig ?? {} }]),
          }),
        }),
      }),
      update: () => ({
        set: (vals: any) => {
          // The overlay is a Drizzle SQL chunk — record that a config write
          // occurred (coarse), and dig the interpolated overlay JSON out of the
          // chunk's `queryChunks` (the overlay string is a plain string primitive
          // chunk; the schema-text parts are `StringChunk` objects with `.value`).
          updates.push(vals)
          overlays.push(Object.keys(vals ?? {}).join(","))
          const chunks = (vals?.config as { queryChunks?: unknown[] })?.queryChunks ?? []
          for (const ch of chunks) {
            if (typeof ch === "string") {
              try {
                const parsed = JSON.parse(ch)
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  overlayJson.push(parsed as Record<string, unknown>)
                }
              } catch {
                // not the overlay JSON (e.g. the "{}" coalesce default) — skip
              }
            }
          }
          return {
            where: () => {
              const p: any = Promise.resolve()
              p.returning = () =>
                Promise.resolve([{ id: opts?.existingAccount ?? "acc-1", status: "active" }])
              return p
            },
          }
        },
      }),
      queueEvent: async (e: any) => {
        events.push(e)
      },
    } as any
    return { tx, events, overlays, overlayJson, inserts, updates }
  }

  const baseInput = {
    identifier: "boxtal-acct",
    credentials: {
      v1Key: "k1",
      v1Secret: "s1",
      v3Key: "k3",
      v3Secret: "s3",
      environment: "sandbox",
    },
    ownerType: "org" as const,
  }

  // Re-entering credentials is what an operator does when a token expired or was
  // revoked. Before this, it INSERTED a second row for the same (org, app,
  // connection, owner) and nothing chose deterministically between them, so the
  // freshly pasted credential could lose to the dead one (prod GitLab PAT,
  // 2026-08-02).
  it("REPLACES an existing connection's credentials instead of inserting a duplicate", async () => {
    const { tx, inserts, updates } = makeTx({ existingAccount: "acc-existing" })
    await createCredentialConnection(tx, "org-1", "user-1", "boxtal", "boxtal", baseInput)
    expect(inserts.length).toBe(0)
    const credUpdate = updates.find((u) => "credentialsEncrypted" in (u ?? {}))
    expect(credUpdate).toBeDefined()
    expect(credUpdate.status).toBe("active")
    // A previously disconnected/errored account comes back to life on re-connect.
    expect(credUpdate.disconnectedAt).toBeNull()
    expect(credUpdate.statusMessage).toBeNull()
  })

  it("still inserts when the connection does not exist yet", async () => {
    const { tx, inserts } = makeTx()
    await createCredentialConnection(tx, "org-1", "user-1", "boxtal", "boxtal", baseInput)
    expect(inserts.length).toBe(1)
    expect(inserts[0].status).toBe("active")
  })

  it("emits kernelPublicBaseUrl on the connected_account:create event", async () => {
    const { tx, events } = makeTx()
    await createCredentialConnection(tx, "org-1", "user-1", "boxtal", "boxtal", baseInput)
    const ev = events.find((e) => e.entity === "connected_account" && e.action === "create")
    expect(ev).toBeDefined()
    expect("kernelPublicBaseUrl" in ev.data).toBe(true)
  })

  it("mints a webhook secret into apps.config when webhookSecretConfigKey is declared", async () => {
    connectionConfigRegistry.set(["org-1", "boxtal", "boxtal"], {
      type: "credentials",
      allowedDomains: ["api.boxtal.build"],
      webhookSecretConfigKey: "boxtalWebhookSecret",
      credentialFields: [
        { name: "v1Key", label: "v1", type: "text" },
        { name: "v1Secret", label: "v1s", type: "password" },
        { name: "v3Key", label: "v3", type: "text" },
        { name: "v3Secret", label: "v3s", type: "password" },
        { name: "environment", label: "env", type: "text" },
      ],
    })
    const { tx, overlays } = makeTx({ existingConfig: {} })
    await createCredentialConnection(tx, "org-1", "user-1", "boxtal", "boxtal", baseInput)
    // one config overlay write occurred (the mint)
    expect(overlays.length).toBe(1)
    expect(overlays[0]).toContain("config")
  })

  it("stores the minted webhook secret ENCRYPTED (ciphertext, not plaintext) and it round-trips", async () => {
    process.env.ENCRYPTION_KEY = ENCRYPTION_KEY
    connectionConfigRegistry.set(["org-1", "boxtal", "boxtal"], {
      type: "credentials",
      allowedDomains: ["api.boxtal.build"],
      webhookSecretConfigKey: "boxtalWebhookSecret",
      credentialFields: [{ name: "v1Key", label: "v1", type: "text" }],
    })
    const { tx, overlayJson } = makeTx({ existingConfig: {} })
    await createCredentialConnection(tx, "org-1", "user-1", "boxtal", "boxtal", baseInput)

    // The overlay carries the secret under the declared key.
    const overlay = overlayJson.find((o) => "boxtalWebhookSecret" in o)
    expect(overlay).toBeDefined()
    const stored = overlay!.boxtalWebhookSecret as string

    // Stored value is AES-GCM ciphertext (iv.tag.data), NOT a bare 64-hex secret.
    expect(typeof stored).toBe("string")
    expect(stored.split(".")).toHaveLength(3)
    expect(stored).not.toMatch(/^[0-9a-f]{64}$/)

    // And it decrypts back to a well-formed 32-byte hex webhook secret.
    const decrypted = decryptSecret(stored, ENCRYPTION_KEY, CryptoContext.appConfigConnectionSecret)
    expect(decrypted).toMatch(/^[0-9a-f]{64}$/)
  })

  it("does NOT re-mint when apps.config already holds the secret (stable across re-connect)", async () => {
    connectionConfigRegistry.set(["org-1", "boxtal", "boxtal"], {
      type: "credentials",
      allowedDomains: ["api.boxtal.build"],
      webhookSecretConfigKey: "boxtalWebhookSecret",
      credentialFields: [{ name: "v1Key", label: "v1", type: "text" }],
    })
    const { tx, overlays } = makeTx({ existingConfig: { boxtalWebhookSecret: "existing-secret" } })
    await createCredentialConnection(tx, "org-1", "user-1", "boxtal", "boxtal", baseInput)
    // existing secret reused → no overlay write
    expect(overlays.length).toBe(0)
  })

  it("does NOT mint when no webhookSecretConfigKey is declared", async () => {
    const { tx, overlays } = makeTx()
    await createCredentialConnection(tx, "org-1", "user-1", "boxtal", "boxtal", baseInput)
    expect(overlays.length).toBe(0)
  })
})

describe("connection secret config-key resolution + apps.config decrypt-at-bridge", () => {
  afterEach(() => {
    resetAppRegistries()
  })

  it("resolveConnectionSecretConfigKeys unions clientSecret + webhookSecret keys for (orgId, appName)", () => {
    // Shopify: OAuth client-secret mirror.
    connectionConfigRegistry.set(["org-1", "shopify", "shopify"], {
      type: "oauth2",
      allowedDomains: ["myshopify.com"],
      clientSecretConfigKey: "shopifyWebhookSecret",
    })
    // Boxtal (different app): minted webhook secret. Must NOT leak into shopify's set.
    connectionConfigRegistry.set(["org-1", "boxtal", "boxtal"], {
      type: "credentials",
      allowedDomains: ["api.boxtal.build"],
      webhookSecretConfigKey: "boxtalWebhookSecret",
    })

    expect(resolveConnectionSecretConfigKeys("org-1", "shopify")).toEqual(
      new Set(["shopifyWebhookSecret"]),
    )
    expect(resolveConnectionSecretConfigKeys("org-1", "boxtal")).toEqual(
      new Set(["boxtalWebhookSecret"]),
    )
    // Cross-org isolation: a different org sees nothing.
    expect(resolveConnectionSecretConfigKeys("org-2", "shopify")).toEqual(new Set())
  })

  it("resolveConnectionSecretConfigKeys derives keys from the manifest (stable source), no registry", () => {
    // The manifest's connection declarations are the primary, always-available
    // source — a registry gap (process restart / unregistered path) must not
    // prevent secret-key identification. Registry is intentionally NOT populated.
    const manifestConnections = {
      shopify: { clientSecretConfigKey: "shopifyWebhookSecret" },
      boxtal: { webhookSecretConfigKey: "boxtalWebhookSecret" },
    }
    expect(resolveConnectionSecretConfigKeys("org-1", "anyapp", manifestConnections)).toEqual(
      new Set(["shopifyWebhookSecret", "boxtalWebhookSecret"]),
    )
  })

  it("decryptConnectionConfigValue decrypts a manifest-declared secret key with no registry entry", () => {
    // Registry empty — secret-key identity comes from the manifest connections.
    const plaintextSecret = "shpss_real_signing_secret"
    const ciphertext = encryptSecret(
      plaintextSecret,
      ENCRYPTION_KEY,
      CryptoContext.appConfigConnectionSecret,
    )
    expect(
      decryptConnectionConfigValue(
        "org-1",
        "shopify",
        "shopifyWebhookSecret",
        ciphertext,
        ENCRYPTION_KEY,
        {
          shopify: { clientSecretConfigKey: "shopifyWebhookSecret" },
        },
      ),
    ).toBe(plaintextSecret)
    // A non-secret key under the same manifest passes through verbatim.
    expect(
      decryptConnectionConfigValue(
        "org-1",
        "shopify",
        "gmailPushAudience",
        "projects/acme/topics/inbox",
        ENCRYPTION_KEY,
        {
          shopify: { clientSecretConfigKey: "shopifyWebhookSecret" },
        },
      ),
    ).toBe("projects/acme/topics/inbox")
  })

  it("decrypts a secret key but passes a non-secret key through verbatim", () => {
    connectionConfigRegistry.set(["org-1", "shopify", "shopify"], {
      type: "oauth2",
      allowedDomains: ["myshopify.com"],
      clientSecretConfigKey: "shopifyWebhookSecret",
    })

    // Stored shape: the secret key holds ciphertext; a sibling non-secret key
    // (e.g. an audience id) holds plaintext that must NOT be touched.
    const plaintextSecret = "shpss_real_signing_secret"
    const ciphertext = encryptSecret(
      plaintextSecret,
      ENCRYPTION_KEY,
      CryptoContext.appConfigConnectionSecret,
    )

    // Secret key → decrypts to the original plaintext the HMAC needs.
    expect(
      decryptConnectionConfigValue(
        "org-1",
        "shopify",
        "shopifyWebhookSecret",
        ciphertext,
        ENCRYPTION_KEY,
      ),
    ).toBe(plaintextSecret)

    // Non-secret key → returned unchanged (never decrypted).
    expect(
      decryptConnectionConfigValue(
        "org-1",
        "shopify",
        "gmailPushAudience",
        "projects/acme/topics/inbox",
        ENCRYPTION_KEY,
      ),
    ).toBe("projects/acme/topics/inbox")
  })

  it("falls back to the raw value for a legacy plaintext dev row under a secret key", () => {
    connectionConfigRegistry.set(["org-1", "shopify", "shopify"], {
      type: "oauth2",
      allowedDomains: ["myshopify.com"],
      clientSecretConfigKey: "shopifyWebhookSecret",
    })
    // A dev row written before encryption-at-rest: plaintext under the secret key.
    // decryptSecret throws ("Invalid ciphertext format") → return the raw value so
    // it keeps verifying until it re-saves.
    expect(
      decryptConnectionConfigValue(
        "org-1",
        "shopify",
        "shopifyWebhookSecret",
        "legacy-plaintext-secret",
        ENCRYPTION_KEY,
      ),
    ).toBe("legacy-plaintext-secret")
  })

  it("round-trips through the verifier: encrypt-at-write → decrypt-at-bridge → HMAC matches", async () => {
    // Reuse the Shopify HMAC verifier (the real bundle code) to prove a webhook
    // signed with the ORIGINAL secret still verifies after encryption-at-rest:
    // the bridge decrypt restores the exact plaintext secret the HMAC uses.
    const { createHmac } = await import("node:crypto")
    const { shopifyWebhookVerifier } = await import(
      "../../../../../../bundled-apps/shopify/src/lib/hmac"
    )
    const { buildVerifyBridge } = await import("~/modules/webhooks/verify-bridge")

    connectionConfigRegistry.set(["org-1", "shopify", "shopify"], {
      type: "oauth2",
      allowedDomains: ["myshopify.com"],
      clientSecretConfigKey: "shopifyWebhookSecret",
    })

    const realSecret = "shpss_webhook_signing_secret"
    const body = JSON.stringify({ id: 12345, topic: "orders/create" })
    // The signature Shopify would send, computed with the ORIGINAL plaintext secret.
    const signature = createHmac("sha256", realSecret).update(body, "utf8").digest("base64")

    // What is stored at rest after the write site encrypts it.
    const storedCiphertext = encryptSecret(
      realSecret,
      ENCRYPTION_KEY,
      CryptoContext.appConfigConnectionSecret,
    )

    // The bridge decrypts the stored value back to plaintext for the verifier.
    const decryptedAtBridge = decryptConnectionConfigValue(
      "org-1",
      "shopify",
      "shopifyWebhookSecret",
      storedCiphertext,
      ENCRYPTION_KEY,
    ) as string

    // The verify bridge signs with the decrypted secret host-side.
    const bridge = buildVerifyBridge({
      readConfig: async () => decryptedAtBridge,
      secretConfigKeys: ["shopifyWebhookSecret"],
    })
    const outcome = await shopifyWebhookVerifier(
      {
        body,
        method: "POST",
        query: {},
        headers: { "x-shopify-hmac-sha256": signature, "x-shopify-webhook-id": "wh-1" },
      },
      bridge as never,
    )
    const verified = outcome.ok
    expect(verified).toBe(true)
  })
})

describe("reconcileConnection — replay connected_account:create for a lost connect event", () => {
  /** tx mock: `select…limit` returns `rows`; records queueEvent payloads. */
  function makeTx(rows: Array<Record<string, unknown>>) {
    const events: any[] = []
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
      }),
      queueEvent: async (e: any) => {
        events.push(e)
      },
    } as any
    return { tx, events }
  }

  const activeRow = {
    id: "ca-1",
    appName: "shopify",
    connectionName: "shop",
    ownerType: "org",
    ownerId: null,
    providerType: "oauth2",
    identifier: "demo.myshopify.com",
    status: "active",
  }

  it("re-emits connected_account:create with the row's identity + reconcile flag", async () => {
    const { tx, events } = makeTx([activeRow])
    const out = await reconcileConnection(tx, "org-1", "user-1", "ca-1")
    expect(out.status).toBe("reconciled")

    const ev = events.find((e) => e.entity === "connected_account" && e.action === "create")
    expect(ev).toBeDefined()
    expect(ev.data.appName).toBe("shopify")
    expect(ev.data.identifier).toBe("demo.myshopify.com")
    expect(ev.data.status).toBe("active")
    expect(ev.data.reconcile).toBe(true)
    // Apps need kernelPublicBaseUrl to (re)register upstream webhooks.
    expect("kernelPublicBaseUrl" in ev.data).toBe(true)
  })

  it("returns not_found and emits nothing when the connection does not exist", async () => {
    const { tx, events } = makeTx([])
    const out = await reconcileConnection(tx, "org-1", "user-1", "missing")
    expect(out.status).toBe("not_found")
    expect(events).toHaveLength(0)
  })

  it("refuses to reconcile a disconnected connection (would re-mint severed state)", async () => {
    const { tx, events } = makeTx([{ ...activeRow, status: "disconnected" }])
    const out = await reconcileConnection(tx, "org-1", "user-1", "ca-1")
    expect(out.status).toBe("not_active")
    expect(events).toHaveLength(0)
  })
})

describe("disconnectConnection", () => {
  function makeTx(rows: Array<Record<string, unknown>>) {
    const events: any[] = []
    const updates: any[] = []
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
      }),
      update: () => ({
        set: (vals: any) => ({
          where: () => {
            updates.push(vals)
            return Promise.resolve()
          },
        }),
      }),
      queueEvent: async (e: any) => {
        events.push(e)
      },
    } as any
    return { tx, events, updates }
  }

  // A calendar Settings page passed the app's own account id: no kernel row matched, the
  // update touched nothing, and the route still answered success.
  it("answers 404 and changes nothing when no connection matches the id", async () => {
    const { tx, events, updates } = makeTx([])
    const err = await disconnectConnection(tx, "org-1", "user-1", "not-a-connection").catch(
      (e: unknown) => e,
    )
    expect((err as { status?: number }).status).toBe(404)
    expect(updates).toHaveLength(0)
    expect(events).toHaveLength(0)
  })

  it("disconnects a matching connection and emits the disconnect event", async () => {
    const { tx, events, updates } = makeTx([
      {
        id: "ca-1",
        appName: "calendar",
        connectionName: "google-calendar",
        ownerType: "user",
        ownerId: "user-1",
        identifier: "owner@example.com",
      },
    ])
    await disconnectConnection(tx, "org-1", "user-1", "ca-1")
    expect(updates[0]?.status).toBe("disconnected")
    // A disconnected connection keeps no secret.
    expect(updates[0]).toMatchObject({
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
      credentialsEncrypted: null,
    })
    expect(events.map((e) => `${e.entity}:${e.action}`)).toEqual(["connected_account:disconnect"])
    // Apps key their per-account state by the identifier, not the connection id.
    expect(events[0].data).toMatchObject({ id: "ca-1", identifier: "owner@example.com" })
    expect(events[0]).toMatchObject({ actorId: "user-1", actorType: "user" })
  })

  // `liaison config apply` without an admin user runs with an empty actor id: the event
  // carried actorId "" and actorType "user", and the audit consumer's uuid insert refused it.
  it("names no actor (a system event) when no person disconnected it", async () => {
    for (const userId of ["", "system"]) {
      const { tx, events } = makeTx([
        {
          id: "ca-1",
          appName: "calendar",
          connectionName: "google-calendar",
          ownerType: "org",
          ownerId: null,
          identifier: "team@example.com",
        },
      ])
      await disconnectConnection(tx, "org-1", userId, "ca-1")
      expect(events[0]).toMatchObject({ actorId: null, actorType: "system" })
    }
  })
})
