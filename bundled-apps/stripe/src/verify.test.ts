// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The webhook verifier against a bridge that behaves like the host's: secrets
// are read by key, `config_has` is false for an unset or empty one, and the HMAC
// is computed bridge-side. The fake is deliberately WEAKER than the host in one
// way: its verify call signs with whatever is stored, the empty string
// included, so the verifier's own refusal of an empty secret is what is tested.
import { describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import {
  PREVIOUS_SECRET_KEY,
  PREVIOUS_SECRET_UNTIL_KEY,
  SIGNING_SECRET_KEY,
  type StripeVerifyBridge,
  type StripeVerifyParams,
  verifyStripeDelivery,
} from "./verify"

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0)
const NOW_S = Math.floor(NOW / 1000)
const CURRENT = "whsec_currentSecretForTheOrgAAAAAAAA"
const PREVIOUS = "whsec_previousSecretForTheOrgBBBBBBB"
const OTHER_ORG = "whsec_anotherOrgsSecretCCCCCCCCCCCC"
const BODY = JSON.stringify({
  id: "evt_1Abc",
  type: "invoice.paid",
  data: { object: { id: "in_1" } },
})

function sign(secret: string, t: number, body = BODY): string {
  return createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex")
}

function bridge(config: Record<string, string | undefined>) {
  const calls: Array<{ method: string; key: string }> = []
  const b: StripeVerifyBridge = {
    config_has: async (key) => {
      calls.push({ method: "config_has", key })
      const v = config[key]
      return typeof v === "string" && v.length > 0
    },
    config_get: async (key) => {
      calls.push({ method: "config_get", key })
      return config[key] ?? null
    },
    crypto_verifyHmacForConfig: async (key, data, sig) => {
      calls.push({ method: "crypto_verifyHmacForConfig", key })
      const secret = config[key]
      if (secret === undefined) return false
      return createHmac("sha256", secret).update(data, "utf8").digest("hex") === sig
    },
  }
  return { b, calls }
}

function params(header: string | undefined, body = BODY): StripeVerifyParams {
  return {
    headers: header === undefined ? {} : { "Stripe-Signature": header },
    body,
    method: "POST",
    query: {},
  }
}

describe("stripe webhook verifier", () => {
  it("a valid signature passes and a bad one answers 401 without taking a replay slot", async () => {
    const { b } = bridge({ [SIGNING_SECRET_KEY]: CURRENT })
    const good = await verifyStripeDelivery(params(`t=${NOW_S},v1=${sign(CURRENT, NOW_S)}`), b, NOW)
    expect(good).toEqual({ ok: true, replayKey: "evt_1Abc", replayTtlSeconds: 4 * 24 * 60 * 60 })

    const bad = await verifyStripeDelivery(
      params(`t=${NOW_S},v1=${sign("whsec_wrongwrongwrong", NOW_S)}`),
      b,
      NOW,
    )
    expect(bad).toEqual({ ok: false, reason: "signature_mismatch" })
    // No replay key on a refusal: the kernel takes no slot and answers 401.
    expect("replayKey" in bad).toBe(false)

    // The body changed after signing: refused too.
    const tampered = await verifyStripeDelivery(
      params(`t=${NOW_S},v1=${sign(CURRENT, NOW_S)}`, BODY.replace("in_1", "in_2")),
      b,
      NOW,
    )
    expect(tampered.ok).toBe(false)
  })

  it("a delivery signed with another org's secret is refused", async () => {
    const { b } = bridge({ [SIGNING_SECRET_KEY]: CURRENT })
    const r = await verifyStripeDelivery(params(`t=${NOW_S},v1=${sign(OTHER_ORG, NOW_S)}`), b, NOW)
    expect(r).toEqual({ ok: false, reason: "signature_mismatch" })
  })

  it("an empty secret verifies nothing for current and previous alike", async () => {
    // Mutation caught: trusting the stored value without the emptiness check,
    // so HMAC("", body) would verify between the key card and the secret card.
    const until = new Date(NOW + 60 * 60 * 1000).toISOString()
    const { b, calls } = bridge({
      [SIGNING_SECRET_KEY]: "",
      [PREVIOUS_SECRET_KEY]: "",
      [PREVIOUS_SECRET_UNTIL_KEY]: until,
    })
    const r = await verifyStripeDelivery(params(`t=${NOW_S},v1=${sign("", NOW_S)}`), b, NOW)
    expect(r).toEqual({ ok: false, reason: "missing_secret" })
    expect(calls.filter((c) => c.method === "crypto_verifyHmacForConfig")).toEqual([])

    // Only the previous one empty: the current still verifies, the empty one never does.
    const { b: b2 } = bridge({
      [SIGNING_SECRET_KEY]: CURRENT,
      [PREVIOUS_SECRET_KEY]: "",
      [PREVIOUS_SECRET_UNTIL_KEY]: until,
    })
    expect(
      (await verifyStripeDelivery(params(`t=${NOW_S},v1=${sign("", NOW_S)}`), b2, NOW)).ok,
    ).toBe(false)
  })

  it("a malformed signature header is refused before the body is read", async () => {
    for (const header of [
      undefined,
      "",
      "garbage",
      `t=${NOW_S}`,
      `v1=${sign(CURRENT, NOW_S)}`,
      `t=abc,v1=${sign(CURRENT, NOW_S)}`,
      `t=${NOW_S},v1=nothex`,
      `t=${NOW_S},t=${NOW_S},v1=${sign(CURRENT, NOW_S)}`,
      `t=${NOW_S},v1=${"a".repeat(64)},${"x=1,".repeat(600)}`,
    ]) {
      let bodyRead = false
      const { b, calls } = bridge({ [SIGNING_SECRET_KEY]: CURRENT })
      const headers: Record<string, string> =
        header === undefined ? {} : { "stripe-signature": header }
      const p = {
        headers,
        get body(): string {
          bodyRead = true
          return BODY
        },
        method: "POST",
        query: {},
      }
      const r = await verifyStripeDelivery(p, b, NOW)
      expect({ header, r }).toEqual({
        header,
        r: { ok: false, reason: "malformed_signature_header" },
      })
      expect({ header, bodyRead, calls: calls.length }).toEqual({
        header,
        bodyRead: false,
        calls: 0,
      })
    }
  })

  it("299 and 300 seconds pass and 301 does not", async () => {
    // Mutation caught: `>=` instead of `>` (300 refused), or no window (301 passes).
    const { b } = bridge({ [SIGNING_SECRET_KEY]: CURRENT })
    for (const [age, ok] of [
      [299, true],
      [300, true],
      [301, false],
      [-299, true],
      [-300, true],
      [-301, false],
    ] as const) {
      const t = NOW_S - age
      const r = await verifyStripeDelivery(params(`t=${t},v1=${sign(CURRENT, t)}`), b, NOW)
      expect({ age, ok: r.ok }).toEqual({ age, ok })
      if (!ok) expect(r).toEqual({ ok: false, reason: "timestamp_outside_tolerance" })
    }
  })

  it("during a roll both secrets verify and the previous stops after 24 hours", async () => {
    const rolledAt = NOW
    const until = new Date(rolledAt + 24 * 60 * 60 * 1000).toISOString()
    const { b } = bridge({
      [SIGNING_SECRET_KEY]: CURRENT,
      [PREVIOUS_SECRET_KEY]: PREVIOUS,
      [PREVIOUS_SECRET_UNTIL_KEY]: until,
    })
    const at = (ms: number, secret: string) => {
      const t = Math.floor(ms / 1000)
      return verifyStripeDelivery(params(`t=${t},v1=${sign(secret, t)}`), b, ms)
    }
    // Right after the roll: both.
    expect((await at(rolledAt + 1000, CURRENT)).ok).toBe(true)
    expect((await at(rolledAt + 1000, PREVIOUS)).ok).toBe(true)
    // A signature header carrying both signatures, as Stripe sends during a roll.
    const t = Math.floor((rolledAt + 1000) / 1000)
    const both = await verifyStripeDelivery(
      params(`t=${t},v1=${sign(PREVIOUS, t)},v1=${sign(CURRENT, t)}`),
      b,
      rolledAt + 1000,
    )
    expect(both.ok).toBe(true)
    // At 24 hours exactly: still. One second later: the previous verifies nothing.
    expect((await at(rolledAt + 24 * 60 * 60 * 1000, PREVIOUS)).ok).toBe(true)
    expect((await at(rolledAt + 24 * 60 * 60 * 1000 + 1000, PREVIOUS)).ok).toBe(false)
    expect((await at(rolledAt + 24 * 60 * 60 * 1000 + 1000, CURRENT)).ok).toBe(true)
  })

  it("a previous secret with no deadline, or one further than 24 hours away, verifies nothing", async () => {
    for (const until of [
      undefined,
      "not a date",
      new Date(NOW + 25 * 60 * 60 * 1000).toISOString(),
    ]) {
      const { b } = bridge({
        [SIGNING_SECRET_KEY]: CURRENT,
        [PREVIOUS_SECRET_KEY]: PREVIOUS,
        [PREVIOUS_SECRET_UNTIL_KEY]: until,
      })
      const r = await verifyStripeDelivery(params(`t=${NOW_S},v1=${sign(PREVIOUS, NOW_S)}`), b, NOW)
      expect({ until, ok: r.ok }).toEqual({ until, ok: false })
    }
  })

  it("the secret never enters the sandbox: only the host verifies with it", async () => {
    const { b, calls } = bridge({ [SIGNING_SECRET_KEY]: CURRENT })
    await verifyStripeDelivery(params(`t=${NOW_S},v1=${sign(CURRENT, NOW_S)}`), b, NOW)
    // No call that hands a secret back: `config_get` is only ever asked for the deadline.
    expect(
      calls.filter((c) => c.method === "config_get" && c.key !== PREVIOUS_SECRET_UNTIL_KEY),
    ).toEqual([])
    expect(
      calls.some((c) => c.method === "crypto_verifyHmacForConfig" && c.key === SIGNING_SECRET_KEY),
    ).toBe(true)
  })

  it("a verified body with no event id is refused", async () => {
    const body = JSON.stringify({ type: "invoice.paid" })
    const { b } = bridge({ [SIGNING_SECRET_KEY]: CURRENT })
    const r = await verifyStripeDelivery(
      params(`t=${NOW_S},v1=${sign(CURRENT, NOW_S, body)}`, body),
      b,
      NOW,
    )
    expect(r).toEqual({ ok: false, reason: "missing_event_id" })
  })
})
