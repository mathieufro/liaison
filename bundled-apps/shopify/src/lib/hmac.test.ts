// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B9 — HMAC-SHA256 verifier tests.
import { describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { makeHmacTestBridge } from "@liaison/test-helpers/webhook-hmac"
import { shopifyWebhookVerifier } from "./hmac"
import { hmacSha256Verifier } from "./hmac.testutil"

const sign = (body: string, secret: string) =>
  createHmac("sha256", secret).update(body, "utf8").digest("base64")

describe("hmacSha256Verifier", () => {
  it("returns true on valid signature", () => {
    const body = '{"x":1}'
    const secret = "s"
    const sig = sign(body, secret)
    expect(hmacSha256Verifier(body, { "x-shopify-hmac-sha256": sig }, secret)).toBe(true)
  })

  it("returns false on mismatch", () => {
    expect(
      hmacSha256Verifier('{"x":1}', { "x-shopify-hmac-sha256": "garbage" }, "s"),
    ).toBe(false)
  })

  it("returns false when header missing", () => {
    expect(hmacSha256Verifier('{"x":1}', {}, "s")).toBe(false)
  })

  it("returns false when body tampered", () => {
    const sig = sign('{"x":1}', "s")
    expect(
      hmacSha256Verifier('{"x":2}', { "x-shopify-hmac-sha256": sig }, "s"),
    ).toBe(false)
  })
})

// Production verifier — the one the kernel webhook route actually calls, run
// against a host-faithful by-key bridge (@liaison/test-helpers/webhook-hmac
// mirrors apps/api secret-free.ts: secret read by key, timing-safe compare).
describe("shopifyWebhookVerifier (manifest-format)", () => {
  const bridge = (secret: string | null) => ({
    ...makeHmacTestBridge({ secretKey: "shopifyWebhookSecret", secret }),
  })

  it("returns ok=true with replayKey when signature + webhookId present", async () => {
    const body = '{"order":1}'
    const secret = "shh"
    const sig = sign(body, secret)
    const r = await shopifyWebhookVerifier(
      {
        body,
        method: "POST",
        query: {},
        headers: {
          "X-Shopify-Hmac-Sha256": sig,
          "X-Shopify-Webhook-Id": "wh-100",
          "X-Shopify-Shop-Domain": "demo.myshopify.com",
        },
      },
      bridge(secret),
    )
    expect(r.ok).toBe(true)
    // The webhook-id header is unsigned, so the key is the digest of the signed body.
    expect(r.replayKey).toBe(createHmac("sha256", "shopify-delivery").update(body, "utf8").digest("base64"))
    const reId = await shopifyWebhookVerifier(
      {
        body,
        method: "POST",
        query: {},
        headers: { "X-Shopify-Hmac-Sha256": sig, "X-Shopify-Webhook-Id": "a-fresh-id" },
      },
      bridge(secret),
    )
    expect(reId.replayKey).toBe(r.replayKey)
    expect((r.replayTtlSeconds ?? 0) > 86_400).toBe(true)
  })

  it("never reads the secret itself: it asks the host by key", async () => {
    const body = '{"order":2}'
    const calls: string[] = []
    const b = bridge("shh")
    const spy = {
      ...b,
      config_get: async (k: string) => {
        calls.push(`config_get:${k}`)
        return b.config_get(k)
      },
      crypto_hmacSha256Base64: async (s: string, d: string) => {
        calls.push(`hmac:${s}`)
        return b.crypto_hmacSha256Base64(s, d)
      },
    }
    const r = await shopifyWebhookVerifier(
      {
        body,
        method: "POST",
        query: {},
        headers: { "x-shopify-hmac-sha256": sign(body, "shh"), "x-shopify-webhook-id": "w" },
      },
      spy,
    )
    expect(r.ok).toBe(true)
    // Only the public replay label is ever passed as a "secret".
    expect(calls).toEqual(["hmac:shopify-delivery"])
  })

  it("returns ok=false when secret unset", async () => {
    const r = await shopifyWebhookVerifier(
      { body: "{}", method: "POST", query: {}, headers: { "x-shopify-hmac-sha256": "x" } },
      bridge(null),
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("missing_secret")
  })

  it("returns ok=false on signature mismatch, a tampered body, a short or missing signature", async () => {
    const sig = sign('{"x":1}', "s")
    for (const [body, headers] of [
      ["{}", { "x-shopify-hmac-sha256": "wrong", "x-shopify-webhook-id": "wh1" }],
      ['{"x":2}', { "x-shopify-hmac-sha256": sig, "x-shopify-webhook-id": "wh1" }],
      ['{"x":1}', { "x-shopify-hmac-sha256": "short", "x-shopify-webhook-id": "wh1" }],
      ['{"x":1}', { "x-shopify-webhook-id": "wh1" }],
    ] as const) {
      const r = await shopifyWebhookVerifier({ body, method: "POST", query: {}, headers }, bridge("s"))
      expect(r.ok).toBe(false)
      expect(r.reason).toBe("signature_mismatch")
    }
  })

  it("returns ok=false when X-Shopify-Webhook-Id missing", async () => {
    const body = "{}"
    const secret = "s"
    const sig = sign(body, secret)
    const r = await shopifyWebhookVerifier(
      { body, method: "POST", query: {}, headers: { "x-shopify-hmac-sha256": sig } },
      bridge(secret),
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("missing_webhook_id")
  })
})
