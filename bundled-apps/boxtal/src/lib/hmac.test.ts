// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { boxtalWebhookVerifier } from "./hmac"
import { hmacBase64, hmacHex, makeTestBridge } from "./hmac.testutil"

const SECRET = "whsecret-123"
const BODY = JSON.stringify({ eventType: "TRACKING_CHANGED", orderId: "ord-1" })

function params(headers: Record<string, string>, body = BODY) {
  return { headers, body, method: "POST", query: {} }
}

describe("boxtalWebhookVerifier", () => {
  it("good signature → ok with a replayKey + 7-day TTL", async () => {
    const sig = hmacBase64(SECRET, BODY)
    const res = await boxtalWebhookVerifier(
      params({ "x-bxt-signature": sig, "x-bxt-delivery-id": "del-1" }),
      makeTestBridge(SECRET),
    )
    expect(res.ok).toBe(true)
    // Unsigned delivery-id header: a fresh id on the same signed body is the same key.
    const again = await boxtalWebhookVerifier(
      params({ "x-bxt-signature": sig, "x-bxt-delivery-id": "del-other" }),
      makeTestBridge(SECRET),
    )
    expect(again.replayKey).toBe(res.replayKey)
    expect(res.replayKey).not.toBe("del-1")
    expect(res.replayTtlSeconds).toBe(7 * 24 * 60 * 60)
  })

  it("bad signature (computed over a TAMPERED body) → signature_mismatch", async () => {
    // signature is valid for B' but the verifier HMACs the actual body B
    const tamperedSig = hmacBase64(SECRET, JSON.stringify({ tampered: true }))
    const res = await boxtalWebhookVerifier(
      params({ "x-bxt-signature": tamperedSig }),
      makeTestBridge(SECRET),
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("signature_mismatch")
  })

  // The prod bug: the digest encoding is NOT pinned by Boxtal's doc sentence, the
  // original verifier assumed base64, and every genuine delivery was refused for
  // the integration's entire life. Signing here with the OTHER encoding of the
  // same HMAC is what the base64-only verifier fails.
  it("accepts a HEX-encoded digest of the same HMAC", async () => {
    const sig = hmacHex(SECRET, BODY)
    const res = await boxtalWebhookVerifier(
      params({ "x-bxt-signature": sig, "x-bxt-delivery-id": "del-hex" }),
      makeTestBridge(SECRET),
    )
    expect(res.ok).toBe(true)
    expect(res.replayKey).toBeTruthy()
  })

  it("accepts an upper-case hex digest and a sha256= scheme prefix", async () => {
    for (const sig of [
      hmacHex(SECRET, BODY).toUpperCase(),
      `sha256=${hmacHex(SECRET, BODY)}`,
      `sha256=${hmacBase64(SECRET, BODY)}`,
    ]) {
      const res = await boxtalWebhookVerifier(params({ "x-bxt-signature": sig }), makeTestBridge(SECRET))
      expect(res.ok).toBe(true)
    }
  })

  it("a wrong secret is still refused in BOTH encodings", async () => {
    for (const sig of [hmacHex("wrong-secret", BODY), hmacBase64("wrong-secret", BODY)]) {
      const res = await boxtalWebhookVerifier(params({ "x-bxt-signature": sig }), makeTestBridge(SECRET))
      expect(res.ok).toBe(false)
      expect(res.reason).toBe("signature_mismatch")
    }
  })

  it("reports the rejected signature's shape, never its value", async () => {
    const badHex = hmacHex("wrong-secret", BODY)
    const res = await boxtalWebhookVerifier(params({ "x-bxt-signature": badHex }), makeTestBridge(SECRET))
    expect(res.sigShape).toBe("len=64,charset=hex")
    expect(res.sigShape).not.toContain(badHex)

    const badB64 = hmacBase64("wrong-secret", BODY)
    const res2 = await boxtalWebhookVerifier(params({ "x-bxt-signature": badB64 }), makeTestBridge(SECRET))
    expect(res2.sigShape).toBe("len=44,charset=base64")
  })

  it("never reads the secret: it verifies by config key on the host", async () => {
    const bridge = makeTestBridge(SECRET)
    const seen: string[] = []
    const spy = {
      ...bridge,
      config_get: async (k: string) => {
        seen.push(k)
        return bridge.config_get(k)
      },
    }
    const res = await boxtalWebhookVerifier(params({ "x-bxt-signature": hmacHex(SECRET, BODY) }), spy)
    expect(res.ok).toBe(true)
    expect(seen).toEqual([])
  })

  it("missing secret (config_has false) → missing_secret", async () => {
    const sig = hmacBase64(SECRET, BODY)
    const res = await boxtalWebhookVerifier(
      params({ "x-bxt-signature": sig }),
      makeTestBridge(null),
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("missing_secret")
  })

  it("missing signature header → missing_signature", async () => {
    const res = await boxtalWebhookVerifier(params({}), makeTestBridge(SECRET))
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("missing_signature")
  })

  it("derives a stable delivery id from the body when no delivery-id header is present", async () => {
    const sig = hmacBase64(SECRET, BODY)
    const a = await boxtalWebhookVerifier(params({ "x-bxt-signature": sig }), makeTestBridge(SECRET))
    const b = await boxtalWebhookVerifier(params({ "x-bxt-signature": sig }), makeTestBridge(SECRET))
    expect(a.ok).toBe(true)
    expect(a.replayKey).toBe(b.replayKey) // same body → same dedup key
  })
})
