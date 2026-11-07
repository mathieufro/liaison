// SPDX-License-Identifier: FSL-1.1-ALv2
//
// @liaison/test-helpers/webhook-hmac: pure node:crypto doubles for the host
// `crypto_*` + `config_get` bridge that bundled-app webhook verifiers receive.
// Test-only: the `node:crypto` import must never reach a sandbox bundle, so
// verifiers import nothing from here.
import { createHmac, timingSafeEqual } from "node:crypto"

/** HMAC-SHA256 base64 of `body` under `secret`. */
export function hmacBase64(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64")
}

/** HMAC-SHA256 hex of `body` under `secret`. */
export function hmacHex(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex")
}

/** Constant-time string compare with the host bridge's unequal-length rule. */
export function utf8TimingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8")
  const bb = Buffer.from(b, "utf8")
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export interface HmacTestBridge {
  config_get: (key: string) => Promise<unknown>
  config_has: (key: string) => Promise<boolean>
  crypto_hmacSha256Base64ForConfig: (key: string, data: string) => Promise<string | null>
  crypto_verifyHmacForConfig: (
    key: string,
    data: string,
    signature: string,
    encoding: "base64" | "hex",
  ) => Promise<boolean>
  crypto_hmacSha256Base64: (s: string, b: string) => Promise<string>
  crypto_hmacSha256Hex?: (s: string, b: string) => Promise<string>
  crypto_timingSafeEqual: (a: string, b: string) => Promise<boolean>
}

/**
 * A bridge stub mirroring the host surface. `config_get(secretKey)` returns
 * `secret`, any other key reads `extraConfig` (null when absent). The by-key
 * methods (`config_has`, `crypto_hmacSha256Base64ForConfig`,
 * `crypto_verifyHmacForConfig`) behave as the host's (secret-free.ts): only
 * `secretKey` may be named, an unset secret signs to null and verifies false.
 * `withHex` adds `crypto_hmacSha256Hex`; leave it off to model a host bridge
 * that predates the hex variant.
 */
export function makeHmacTestBridge(opts: {
  secretKey: string
  secret: string | null
  extraConfig?: Record<string, unknown>
  withHex?: boolean
}): HmacTestBridge {
  const extraConfig = opts.extraConfig ?? {}
  const secretOf = (key: string): string | null => {
    if (key !== opts.secretKey) throw new Error(`config key "${key}" is not a declared secret`)
    return opts.secret || null
  }
  return {
    config_get: async (key: string) =>
      key === opts.secretKey ? opts.secret : (extraConfig[key] ?? null),
    config_has: async (key: string) => {
      const v = key === opts.secretKey ? opts.secret : extraConfig[key]
      return v !== undefined && v !== null && v !== ""
    },
    crypto_hmacSha256Base64ForConfig: async (key: string, data: string) => {
      const secret = secretOf(key)
      return secret === null ? null : hmacBase64(secret, data)
    },
    crypto_verifyHmacForConfig: async (key, data, signature, encoding) => {
      const secret = secretOf(key)
      if (secret === null || !signature) return false
      const expected = encoding === "hex" ? hmacHex(secret, data) : hmacBase64(secret, data)
      return utf8TimingSafeEqual(signature, expected)
    },
    crypto_hmacSha256Base64: async (s: string, b: string) => hmacBase64(s, b),
    ...(opts.withHex
      ? { crypto_hmacSha256Hex: async (s: string, b: string) => hmacHex(s, b) }
      : {}),
    crypto_timingSafeEqual: async (a: string, b: string) => utf8TimingSafeEqual(a, b),
  }
}
