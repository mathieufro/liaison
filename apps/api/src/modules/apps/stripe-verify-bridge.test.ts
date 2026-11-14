// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe verifier on the kernel's own verify bridge, built as the Workers
// executor builds it: every call that would hand a secret back is refused, so a
// verifier that read its secret would fail here. It passes because the HMAC is
// computed and compared host-side, with the org's own stored secret.
import { describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { buildVerifyBridge } from "~/modules/webhooks/verify-bridge"
import {
  type StripeVerifyBridge,
  verifyStripeDelivery,
} from "../../../../../bundled-apps/stripe/src/verify"

const SECRET = "whsec_orgOwnSigningSecret0123456789"
const BODY = JSON.stringify({ id: "evt_W1", type: "customer.updated" })

function workersBridge(stored: Record<string, string>): StripeVerifyBridge {
  return buildVerifyBridge({
    readConfig: async (key) => stored[key] ?? null,
    secretConfigKeys: ["webhookSigningSecret", "webhookSigningSecretPrevious"],
    workersRun: true,
  }) as unknown as StripeVerifyBridge
}

describe("payments webhook verifier on the Workers bridge", () => {
  it("the secret never enters the sandbox, and a Workers-built bridge verifies", async () => {
    const bridge = workersBridge({ webhookSigningSecret: SECRET })
    // The secret itself cannot be read on this bridge.
    await expect(bridge.config_get("webhookSigningSecret")).rejects.toThrow()
    const t = Math.floor(Date.now() / 1000)
    const sig = createHmac("sha256", SECRET).update(`${t}.${BODY}`).digest("hex")
    const ok = await verifyStripeDelivery(
      {
        headers: { "stripe-signature": `t=${t},v1=${sig}` },
        body: BODY,
        method: "POST",
        query: {},
      },
      bridge,
    )
    expect(ok).toEqual(expect.objectContaining({ ok: true, replayKey: "evt_W1" }))
    // Signed with another org's secret: refused.
    const other = createHmac("sha256", "whsec_someoneElse000000000000")
      .update(`${t}.${BODY}`)
      .digest("hex")
    const bad = await verifyStripeDelivery(
      {
        headers: { "stripe-signature": `t=${t},v1=${other}` },
        body: BODY,
        method: "POST",
        query: {},
      },
      bridge,
    )
    expect(bad).toEqual({ ok: false, reason: "signature_mismatch" })
  })
})
