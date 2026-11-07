// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bridge a manifest webhook verifier runs against (inline: no transaction).
//
// `readConfig` is the verifier's `config_get` logic: the cell's value for a
// key the cell owns, the stored value (a declared connection secret decrypted
// host-side), else the connection's current client secret (a provider that
// signs with it, Shopify), else the instance default. The verifier itself
// should only need `config_has` and the *ForConfig crypto methods, which use
// the secret here and return a digest or a verdict (bridge/secret-free.ts).
// `workersRun` (a verifier whose isolate lives off this server) refuses
// `config_get` of a declared secret with `secret_not_available_on_workers`.

import { timingSafeEqual } from "node:crypto"
import { env } from "~/lib/env"
import { webhooksLogger as log } from "~/lib/logger"
import { cellConfigOverride } from "~/modules/apps/cell-locked-config"
import { connectionClientSecretForConfigKey } from "~/modules/apps/connections/oauth-client"
import {
  type ConnectionSecretKeySource,
  decryptConnectionConfigValue,
} from "~/modules/apps/connections/service"
import { instanceConfigDefault } from "~/modules/apps/instance-config-defaults"
import {
  createConfigSecretMethods,
  forWorkersRun,
  manifestSecretConfigKeys,
} from "~/modules/apps/sandbox/bridge/secret-free"

export interface WebhookVerifyBridgeInput {
  appOrgId: string
  appName: string
  /** The app's stored `apps.config` (a jsonb object, or its JSON text). */
  appConfig: unknown
  manifestConnections: Record<string, ConnectionSecretKeySource> | undefined
  /** The verifier runs on the Workers executor: no secret is handed back. */
  workersRun?: boolean
}

/** The verifier's `config_get` answer for `key`, host-side. */
export function webhookConfigReader(
  input: Omit<WebhookVerifyBridgeInput, "workersRun">,
): (key: string) => Promise<unknown> {
  const { appOrgId, appName, appConfig, manifestConnections } = input
  return async (key: string) => {
    const rawConfig = appConfig
    const config =
      typeof rawConfig === "string"
        ? (JSON.parse(rawConfig) as Record<string, unknown>)
        : (rawConfig as Record<string, unknown> | null | undefined)
    const value = config?.[key]
    // A key the managed cell owns answers the cell's value (cell-locked-config.ts).
    const cell = await cellConfigOverride(appOrgId, appName, key, value)
    if (cell !== undefined) return cell
    if (value === undefined || value === null) {
      // No copy stored at connect (a provider that signs with the app's
      // client secret, Shopify): the connection's current client, the
      // org's own or else the instance's, through the one resolver. The
      // stored copy wins when present: it is the secret of the client
      // that minted the store's connection and created its subscriptions.
      try {
        const clientSecret = await connectionClientSecretForConfigKey(
          appOrgId,
          appName,
          key,
          manifestConnections,
        )
        // Else the instance's answer for every workspace (e.g. the Gmail
        // push audience of the server's shared topic), as `config_get` in
        // the app sandbox gives it.
        return clientSecret ?? instanceConfigDefault(appName, key)
      } catch (err) {
        log.warn(
          { err, orgId: appOrgId, appName },
          "webhook client secret unresolved and none stored at connect",
        )
        return null
      }
    }
    // Connection secrets (OAuth client secret / minted webhook secret)
    // are stored encrypted in apps.config; decrypt ONLY those keys here so
    // the verifier receives the same plaintext secret it would have read
    // before encryption-at-rest (HMAC round-trips). Every other config
    // key (e.g. gmailPushAudience) passes through verbatim. The
    // ENCRYPTION_KEY stays host-side — only the decrypted secret string
    // crosses into the sandbox, exactly as the plaintext did before.
    //
    // "Which keys are secret" is derived from the app MANIFEST attached to
    // the webhook registration (`_manifest.connections`) — the stable
    // source always present at this call site. Relying on the in-memory
    // `connectionConfigRegistry` here is fragile: after a process restart
    // (or a path that didn't repopulate it) it can be empty, the decrypt
    // would silently not fire, and the verifier would receive raw
    // ciphertext as the HMAC secret — failing every signature in
    // production. The registry stays as a fallback inside the service.
    return decryptConnectionConfigValue(
      appOrgId,
      appName,
      key,
      value,
      undefined,
      manifestConnections,
    )
  }
}

/** The verifier bridge over one config reader (tests pass their own reader). */
export function buildVerifyBridge(opts: {
  readConfig: (key: string) => Promise<unknown>
  secretConfigKeys: Iterable<string>
  workersRun?: boolean
}): Record<string, (...args: any[]) => Promise<unknown>> {
  const secretConfigKeys = new Set(opts.secretConfigKeys)
  const bridge: Record<string, (...args: any[]) => Promise<unknown>> = {
    config_get: async (key: string) => opts.readConfig(key),
    ...createConfigSecretMethods({ readConfig: opts.readConfig, secretConfigKeys }),
    // Lets a verify handler fail closed in production when its strong
    // verification config is absent, instead of trusting a weaker
    // fallback (e.g. a static query-string token).
    env_allowInsecurePush: async () => env.ALLOW_INSECURE_PUSH,
    crypto_timingSafeEqual: async (a: string, b: string) => {
      const left = Buffer.from(a)
      const right = Buffer.from(b)
      if (left.length !== right.length) return false
      return timingSafeEqual(left, right)
    },
    // Phase 16 — HMAC-SHA256 bridge for sandboxed bundles. QuickJS has
    // no `node:crypto`; bundles call this to compute the digest the
    // signature header should contain, then compare via crypto_timingSafeEqual.
    crypto_hmacSha256Base64: async (secret: string, body: string) => {
      const { createHmac: createHmacFn } = await import("node:crypto")
      return createHmacFn("sha256", secret).update(body, "utf8").digest("base64")
    },
    // Hex variant for providers that send the digest as hex (e.g. Meta's
    // X-Hub-Signature-256: `sha256=<hex>`). Same QuickJS rationale.
    crypto_hmacSha256Hex: async (secret: string, body: string) => {
      const { createHmac: createHmacFn } = await import("node:crypto")
      return createHmacFn("sha256", secret).update(body, "utf8").digest("hex")
    },
    pubsub_verifyGoogleOidcJwt: async (
      token: string,
      expectedAudience: string,
      expectedServiceAccount: string,
    ) => {
      const { verifyGoogleOidcJwt } = await import("~/modules/webhooks/google-oidc")
      const overrideJwks = process.env.TICKETS_GMAIL_PUSH_JWKS_URL
      const overrideIss = process.env.TICKETS_GMAIL_PUSH_ISSUER
      const result = await verifyGoogleOidcJwt(token, {
        expectedAudience,
        expectedServiceAccount,
        issuer: overrideIss,
        jwksUrl: overrideJwks,
      })
      return JSON.stringify(result)
    },
  }
  return opts.workersRun ? forWorkersRun(bridge, { secretConfigKeys }) : bridge
}

export function createWebhookVerifyBridge(
  input: WebhookVerifyBridgeInput,
): Record<string, (...args: any[]) => Promise<unknown>> {
  return buildVerifyBridge({
    readConfig: webhookConfigReader(input),
    secretConfigKeys: manifestSecretConfigKeys(input.manifestConnections),
    ...(input.workersRun ? { workersRun: true } : {}),
  })
}
