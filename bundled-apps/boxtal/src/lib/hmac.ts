// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HMAC-SHA256 verifier for inbound Boxtal v3 webhooks.
//
// Boxtal signs every webhook body with HMAC-SHA256 using the webhook validation
// secret, and sends the digest in the `x-bxt-signature` header (liaison-v0/
// api-v3.json: "La requête contiendra un en-tête `x-bxt-signature`, avec une
// valeur égale à l'encodage HMAC SHA256 du JSON … en utilisant la clé de
// validation du webhook").
//
// DIGEST ENCODING IS NOT SPECIFIED BY THAT SENTENCE. "l'encodage HMAC SHA256"
// names the algorithm, not the transport encoding, and the original
// implementation read it as base64 — an inference, never confirmed against a
// real delivery. Prod, 2026-08-03: every genuine Boxtal delivery had been
// refused with `signature_mismatch` since the integration shipped, while the
// subscriptions were ACTIVE with the correct callback URLs and the correct
// kernel-minted secret (re-registered by `webhooks_repair` on 2026-08-02 and
// still refused). `app_boxtal.webhook_delivery` held only synthetic rows — a
// replay test and a hand-signed probe — so NO real delivery was ever accepted.
// The suite could not catch it: every test and chaos harness signs with the
// same base64 helper the verifier compares against, so the assumption verified
// itself.
//
// So: accept BOTH encodings (base64 and hex), each compared in constant time
// against the same HMAC of the same raw body under the same secret. Accepting a
// second encoding of the same digest does not weaken the check — a forger still
// has to produce a valid HMAC — it only stops us refusing a correctly signed
// delivery over a transport detail. An optional `sha256=` prefix is tolerated
// for the same reason.
//
// On mismatch the result carries `sigShape`: the received signature's LENGTH and
// CHARSET CLASS only (never the value). That is what makes the next occurrence
// of this bug class readable straight from the prod log line instead of needing
// a packet capture, which is what diagnosing this one required.
//
// The secret never enters the bundle: the host `crypto_verifyHmacForConfig`
// bridge reads it by config key, computes the digest in the encoding asked for
// and compares in constant time; `config_has` tells an unset secret apart (one
// path on every executor). This file MUST NOT import `node:*`; the pure-node
// helper for unit tests lives in @liaison/test-helpers/webhook-hmac.

import { bodyDeliveryId, lowercaseHeaderKeys } from "@liaison/app-sdk/webhook-verify"

export interface VerifyResult {
  ok: boolean
  replayKey?: string
  replayTtlSeconds?: number
  reason?: string
  /**
   * Non-secret shape of the REJECTED signature (`len=<n>,charset=<class>`), set
   * only on `signature_mismatch`. Length and charset class are enough to name a
   * transport-encoding mismatch on sight; the signature value itself is never
   * included.
   */
  sigShape?: string
}

const HEADER_SIGNATURE = "x-bxt-signature"

/** Tolerated `<scheme>=<digest>` prefixes some providers prepend. */
const SIGNATURE_PREFIXES = ["sha256=", "hmac-sha256="]

/** The kernel-minted signing secret in `apps.config` (`webhookSecretConfigKey`). */
export const BOXTAL_WEBHOOK_SECRET_KEY = "boxtalWebhookSecret"

export interface WebhookBridge {
  config_has: (key: string) => Promise<boolean>
  crypto_verifyHmacForConfig: (
    key: string,
    data: string,
    signature: string,
    encoding: "base64" | "hex",
  ) => Promise<boolean>
  /** For the replay key only (`bodyDeliveryId`, a public label as the key). */
  crypto_hmacSha256Base64: (secret: string, body: string) => Promise<string>
}

/**
 * Strip an optional scheme prefix and surrounding whitespace. Hex is normalized
 * to lower case so an upper-case digest still compares equal (the host bridge
 * emits lower-case hex); case folding a hex string leaks nothing.
 */
function normalizeSignature(raw: string): string {
  let sig = raw.trim()
  const lower = sig.toLowerCase()
  for (const prefix of SIGNATURE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      sig = sig.slice(prefix.length)
      break
    }
  }
  return /^[0-9a-fA-F]+$/.test(sig) ? sig.toLowerCase() : sig
}

/** `len=<n>,charset=<hex|base64|other>` — no signature bytes. */
function describeSignatureShape(sig: string): string {
  const charset = /^[0-9a-f]+$/.test(sig)
    ? "hex"
    : /^[A-Za-z0-9+/_-]+={0,2}$/.test(sig)
      ? "base64"
      : "other"
  return `len=${sig.length},charset=${charset}`
}

/**
 * Manifest-format webhook verifier. The kernel router calls this with a
 * serialized request descriptor and expects `{ ok, replayKey, replayTtlSeconds }`.
 * The signing secret is the kernel-minted `boxtalWebhookSecret` in apps.config,
 * used host-side by key (the bundle never reads it).
 */
export async function boxtalWebhookVerifier(
  params: {
    headers: Record<string, string>
    body: string
    method: string
    query: Record<string, string>
  },
  bridge: WebhookBridge,
): Promise<VerifyResult> {
  const headers = lowercaseHeaderKeys(params.headers)
  if (!(await bridge.config_has(BOXTAL_WEBHOOK_SECRET_KEY))) {
    return { ok: false, reason: "missing_secret" }
  }

  const rawSig = headers[HEADER_SIGNATURE]
  if (!rawSig || typeof rawSig !== "string") return { ok: false, reason: "missing_signature" }
  const sig = normalizeSignature(rawSig)

  // Same HMAC, same raw body, same secret — only the transport encoding differs,
  // so try each accepted encoding. Every comparison is the host's, which
  // handles unequal lengths in constant time (no early length-oracle return
  // here). Both are evaluated rather than short-circuited so a rejection costs
  // the same work whichever encoding arrived.
  let valid = false
  for (const encoding of ["base64", "hex"] as const) {
    if (await bridge.crypto_verifyHmacForConfig(BOXTAL_WEBHOOK_SECRET_KEY, params.body, sig, encoding)) {
      valid = true
    }
  }
  if (!valid) {
    return { ok: false, reason: "signature_mismatch", sigShape: describeSignatureShape(sig) }
  }

  // The delivery-id header is not covered by the signature, so it cannot key
  // replay protection: a captured signed body re-sent under a fresh id would
  // read as new. The digest of the signed body does.
  const deliveryId = await bodyDeliveryId("boxtal-delivery", params.body, bridge)
  return {
    ok: true,
    replayKey: deliveryId,
    replayTtlSeconds: 7 * 24 * 60 * 60,
  }
}
