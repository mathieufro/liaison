// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B9 — HMAC-SHA256 verifier for inbound Shopify webhooks.
//
// Shopify signs every webhook body with HMAC-SHA256 (base64) using the
// app's webhook signing secret, and sends the digest in the
// `X-Shopify-Hmac-Sha256` header. The secret never enters the bundle: the
// host-side `crypto_verifyHmacForConfig` bridge (apps/api
// modules/webhooks/verify-bridge.ts) reads it by config key, computes the
// digest and compares in constant time; `config_has` tells an unset secret
// apart. The same call works on every executor.
//
// IMPORTANT: This file MUST NOT import from `node:crypto` (the bundle is
// loaded into QuickJS which can't resolve it). The pure-node helper for
// unit tests lives in a sibling file `hmac.testutil.ts` so it doesn't
// pollute the production bundle.

import { lowercaseHeaderKeys } from "@liaison/app-sdk/webhook-verify"

export interface VerifyResult {
  ok: boolean
  replayKey?: string
  replayTtlSeconds?: number
  reason?: string
}

const HEADER_HMAC = "x-shopify-hmac-sha256"
const HEADER_WEBHOOK_ID = "x-shopify-webhook-id"
/** The app's signing secret in `apps.config` (the connection's `clientSecretConfigKey`). */
export const SHOPIFY_WEBHOOK_SECRET_KEY = "shopifyWebhookSecret"

export interface ShopifyVerifyBridge {
  config_has: (key: string) => Promise<boolean>
  crypto_verifyHmacForConfig: (
    key: string,
    data: string,
    signature: string,
    encoding: "base64" | "hex",
  ) => Promise<boolean>
  /** Only ever called with the public "shopify-delivery" label (the replay key). */
  crypto_hmacSha256Base64: (secret: string, body: string) => Promise<string>
}

/**
 * Manifest-format webhook verifier. The kernel webhook router calls
 * this with a serialized request descriptor (body + headers). The
 * router expects a structured outcome of shape
 * `{ ok: true, replayKey, replayTtlSeconds }` — see
 * `liaison/apps/api/src/modules/webhooks/verification.ts`.
 *
 * The replay key is the digest of the signed body (see below). We pin
 * replay TTL to 7 days to cover Shopify's documented 19-attempt / 48-hour
 * retry window with head-room.
 *
 * The comparison is the host's (timing safe, unequal lengths included): the
 * bundle never short-circuits on the signature's length.
 */
export async function shopifyWebhookVerifier(
  params: {
    headers: Record<string, string>
    body: string
    method: string
    query: Record<string, string>
  },
  bridge: ShopifyVerifyBridge,
): Promise<VerifyResult> {
  const headers = lowercaseHeaderKeys(params.headers)
  if (!(await bridge.config_has(SHOPIFY_WEBHOOK_SECRET_KEY))) {
    return { ok: false, reason: "missing_secret" }
  }
  const sig = headers[HEADER_HMAC]
  const valid =
    typeof sig === "string" &&
    sig.length > 0 &&
    (await bridge.crypto_verifyHmacForConfig(SHOPIFY_WEBHOOK_SECRET_KEY, params.body, sig, "base64"))
  if (!valid) return { ok: false, reason: "signature_mismatch" }
  const webhookId = headers[HEADER_WEBHOOK_ID]
  if (!webhookId) return { ok: false, reason: "missing_webhook_id" }
  return {
    ok: true,
    // X-Shopify-Webhook-Id is not covered by the HMAC, so it cannot key replay
    // protection (a captured body re-sent under a new id would read as new).
    // Shopify redelivers the identical body on retry, so the digest dedups those.
    replayKey: await bridge.crypto_hmacSha256Base64("shopify-delivery", params.body),
    replayTtlSeconds: 7 * 24 * 60 * 60,
  }
}
