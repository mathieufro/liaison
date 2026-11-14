// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe webhook verifier. The kernel calls it before anything else touches
// a delivery; nothing is trusted until it says yes.
//
// ORDER. The `Stripe-Signature` header is checked first (shape, then the age of
// its `t`), before the body is read at all, so a malformed or stale delivery
// costs nothing. Then each candidate secret is tried against every `v1`
// signature of `${t}.${body}`.
//
// THE SECRET NEVER ENTERS THE SANDBOX. The HMAC is computed and compared by the
// host (`crypto_verifyHmacForConfig`, hex), which reads the org's own stored
// secret. So a delivery signed with another org's secret fails here, and the
// Workers executor (which refuses every call that would hand a secret back)
// runs this verifier unchanged.
//
// EMPTY IS NOTHING. A candidate secret that is unset or empty is skipped before
// any HMAC: `HMAC("", body)` must never verify, for the current secret as for
// the previous one.
//
// ROLLING. During a roll the previous secret verifies too, until the deadline
// stored beside it (`webhookSigningSecretPreviousUntil`, an ISO instant, at
// most 24 hours after the roll). No deadline, a deadline in the past or one
// further than 24 hours away: the previous secret verifies nothing.
//
// SUCCESS. The replay key is the event id, and only on success: a refused
// delivery takes no replay slot.

export const SIGNING_SECRET_KEY = "webhookSigningSecret"
export const PREVIOUS_SECRET_KEY = "webhookSigningSecretPrevious"
export const PREVIOUS_SECRET_UNTIL_KEY = "webhookSigningSecretPreviousUntil"

/** A signature older or newer than this many seconds is refused (300 passes). */
export const TOLERANCE_SECONDS = 300
/** The longest a previous secret may keep verifying after a roll. */
export const PREVIOUS_SECRET_MAX_MS = 24 * 60 * 60 * 1000
/** Stripe retries for up to 3 days in live mode; the claim outlives that. */
export const REPLAY_TTL_SECONDS = 4 * 24 * 60 * 60

/** The longest header accepted: a few `v1` entries, never a body-sized string. */
const MAX_HEADER_LENGTH = 2048
const HEADER_NAME = "stripe-signature"

export interface StripeVerifyBridge {
  config_has(key: string): Promise<boolean>
  config_get(key: string): Promise<unknown>
  crypto_verifyHmacForConfig(
    key: string,
    data: string,
    signature: string,
    encoding: "hex",
  ): Promise<boolean>
}

export interface StripeVerifyParams {
  headers: Record<string, string>
  body: string
  method: string
  query: Record<string, string>
}

export type StripeVerifyResult =
  | { ok: true; replayKey: string; replayTtlSeconds: number }
  | { ok: false; reason: StripeVerifyRefusal }

export type StripeVerifyRefusal =
  | "malformed_signature_header"
  | "timestamp_outside_tolerance"
  | "missing_secret"
  | "signature_mismatch"
  | "missing_event_id"

export interface ParsedSignature {
  t: number
  v1: string[]
}

/**
 * `t=<unix seconds>,v1=<64 hex>[,v1=…][,v0=…]`, or null when the header has any
 * other shape. Entries other than `t` and `v1` are allowed and ignored.
 */
export function parseSignatureHeader(header: unknown): ParsedSignature | null {
  if (typeof header !== "string" || header.length === 0 || header.length > MAX_HEADER_LENGTH)
    return null
  let t: number | null = null
  const v1: string[] = []
  for (const part of header.split(",")) {
    const eq = part.indexOf("=")
    if (eq <= 0) return null
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key === "t") {
      if (t !== null || !/^\d{1,12}$/.test(value)) return null
      t = Number(value)
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/.test(value)) return null
      v1.push(value)
    } else if (!/^[a-z0-9]{1,8}$/.test(key)) {
      return null
    }
  }
  if (t === null || v1.length === 0) return null
  return { t, v1 }
}

function headerOf(headers: Record<string, string>): string | undefined {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === HEADER_NAME) return v
  return undefined
}

/** Whether the previous secret may still verify at `nowMs`. */
async function previousStillValid(bridge: StripeVerifyBridge, nowMs: number): Promise<boolean> {
  const until = await bridge.config_get(PREVIOUS_SECRET_UNTIL_KEY)
  const untilMs = typeof until === "string" ? Date.parse(until) : Number.NaN
  if (!Number.isFinite(untilMs)) return false
  return nowMs <= untilMs && untilMs - nowMs <= PREVIOUS_SECRET_MAX_MS
}

/** Verify one delivery. `nowMs` is injectable for tests. */
export async function verifyStripeDelivery(
  params: StripeVerifyParams,
  bridge: StripeVerifyBridge,
  nowMs: number = Date.now(),
): Promise<StripeVerifyResult> {
  // 1. The header, before the body is read.
  const sig = parseSignatureHeader(headerOf(params.headers))
  if (!sig) return { ok: false, reason: "malformed_signature_header" }
  if (Math.abs(Math.floor(nowMs / 1000) - sig.t) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp_outside_tolerance" }
  }

  // 2. The candidate secrets: set and non-empty only.
  const candidates: string[] = []
  if (await bridge.config_has(SIGNING_SECRET_KEY)) candidates.push(SIGNING_SECRET_KEY)
  if ((await bridge.config_has(PREVIOUS_SECRET_KEY)) && (await previousStillValid(bridge, nowMs))) {
    candidates.push(PREVIOUS_SECRET_KEY)
  }
  if (candidates.length === 0) return { ok: false, reason: "missing_secret" }

  // 3. The host computes and compares; the secret stays there.
  const body = params.body
  const signed = `${sig.t}.${body}`
  let valid = false
  for (const key of candidates) {
    for (const v of sig.v1) {
      if (await bridge.crypto_verifyHmacForConfig(key, signed, v, "hex")) {
        valid = true
        break
      }
    }
    if (valid) break
  }
  if (!valid) return { ok: false, reason: "signature_mismatch" }

  // 4. The replay key: the event id.
  let id: unknown
  try {
    id = (JSON.parse(body) as { id?: unknown })?.id
  } catch {
    id = undefined
  }
  if (typeof id !== "string" || !/^evt_[A-Za-z0-9_]+$/.test(id))
    return { ok: false, reason: "missing_event_id" }
  return { ok: true, replayKey: id, replayTtlSeconds: REPLAY_TTL_SECONDS }
}
