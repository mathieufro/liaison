// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SECRET-FREE BRIDGE CONTRACT.
//
// App code never needs a provider token, an API key or a webhook secret in its
// own memory: the host holds them and uses them on the app's behalf.
//
//   - `ctx.fetch(url, {auth})` adds a connection's credential to the request
//     host-side, after the allowlist check (egress.ts).
//   - `ctx.fetch(url, {configSecrets})` writes a declared config secret into
//     the request body host-side (a provider subscription that must carry the
//     signing secret).
//   - `crypto_hmacSha256Base64ForConfig` / `crypto_verifyHmacForConfig` sign
//     and verify with a config secret read host-side; `config_has` says whether
//     one is set.
//
// Both executors use these calls (one code path). A run whose isolate lives
// off this server (the Workers executor: every ctx.* call crosses HTTPS) is
// additionally built with `forWorkersRun`, which turns every method that would
// hand a secret back into a typed refusal, so a regression fails loudly rather
// than shipping a token into the isolate. The QuickJS executors keep the old
// methods for the apps that still read their credentials themselves.
//
// No key storage, encryption or KDF lives here: the secrets are read through
// the same decrypt paths `config_get` and `connections_get*` always used.

import { timingSafeEqual } from "node:crypto"

export const SECRET_NOT_AVAILABLE_ON_WORKERS = "secret_not_available_on_workers"

/** Bridge methods whose answer IS a secret, refused outright on a Workers run. */
export const SECRET_RETURNING_BRIDGE_METHODS: readonly string[] = [
  "connections_getToken",
  "connections_getCredentials",
]

/** Marks a bridge built for a Workers run (non-enumerable, so not a method). */
export const WORKERS_RUN_BRIDGE: unique symbol = Symbol("liaison.workersRunBridge")

/**
 * Carries, on a bridge, the resolver of the config keys its `config_get`
 * decrypts (non-enumerable, so not a method). A Workers run refuses exactly
 * those keys, read from the same source at the moment of the call.
 */
export const BRIDGE_SECRET_CONFIG_KEYS: unique symbol = Symbol("liaison.bridgeSecretConfigKeys")

/** The config keys a bridge's `config_get` treats as secrets. */
export type SecretConfigKeyResolver = () => Promise<Iterable<string>>

/** Record on `bridge` (in place) which config keys its `config_get` decrypts. */
export function markSecretConfigKeys<B extends object>(
  bridge: B,
  resolve: SecretConfigKeyResolver,
): B {
  Object.defineProperty(bridge, BRIDGE_SECRET_CONFIG_KEYS, {
    value: resolve,
    enumerable: false,
    configurable: true,
  })
  return bridge
}

/** The resolver `markSecretConfigKeys` recorded on `bridge`, or null when it has none. */
export function secretConfigKeysOf(bridge: unknown): SecretConfigKeyResolver | null {
  if (!bridge || typeof bridge !== "object") return null
  const resolve = (bridge as Record<symbol, unknown>)[BRIDGE_SECRET_CONFIG_KEYS]
  return typeof resolve === "function" ? (resolve as SecretConfigKeyResolver) : null
}

export interface SecretNotAvailableOnWorkersError extends Error {
  status: 403
  code: typeof SECRET_NOT_AVAILABLE_ON_WORKERS
}

export function secretNotAvailableOnWorkers(what: string): SecretNotAvailableOnWorkersError {
  const err = new Error(
    `${what} would return a secret, which is not available to an app running on Workers. ` +
      "Use ctx.fetch auth, configSecrets or the *ForConfig crypto methods instead.",
  ) as SecretNotAvailableOnWorkersError
  err.status = 403
  err.code = SECRET_NOT_AVAILABLE_ON_WORKERS
  return err
}

/** An Error carrying an HTTP status and code, which the bridge carries to the app. */
export function typedError(status: number, code: string, message: string): Error {
  const err = new Error(message) as Error & { status: number; code: string }
  err.status = status
  err.code = code
  return err
}

interface SecretKeySource {
  clientSecretConfigKey?: string
  webhookSecretConfigKey?: string
  appSecretConfigKeys?: string[]
}

/**
 * The `apps.config` keys a manifest declares as connection secrets: the same
 * declarations `config_get` decrypts (connections/service.ts
 * resolveConnectionSecretConfigKeys, its primary source).
 */
export function manifestSecretConfigKeys(
  connections: Record<string, SecretKeySource | undefined> | null | undefined,
): Set<string> {
  const keys = new Set<string>()
  for (const conn of Object.values(connections ?? {})) {
    if (conn?.clientSecretConfigKey) keys.add(conn.clientSecretConfigKey)
    if (conn?.webhookSecretConfigKey) keys.add(conn.webhookSecretConfigKey)
    for (const k of conn?.appSecretConfigKeys ?? []) keys.add(k)
  }
  return keys
}

/** The connection whose declaration names `key` as one of its secrets. */
export function connectionOfSecretKey<C extends SecretKeySource>(
  connections: Record<string, C | undefined> | null | undefined,
  key: string,
): { name: string; declaration: C } | null {
  for (const [name, conn] of Object.entries(connections ?? {})) {
    if (!conn) continue
    if (
      conn.clientSecretConfigKey === key ||
      conn.webhookSecretConfigKey === key ||
      (conn.appSecretConfigKeys ?? []).includes(key)
    ) {
      return { name, declaration: conn }
    }
  }
  return null
}

/**
 * Mark `bridge` as serving a Workers run, IN PLACE (and return it): every
 * secret-returning method rejects with `secret_not_available_on_workers`, and
 * `config_get` does for a key in `secretConfigKeys` (other keys read as
 * before). `secretConfigKeys` is a fixed set, or a resolver read at each call
 * (the source `config_get` decrypts from). Fail closed: with `null`, or a
 * resolver that throws, every `config_get` is refused, since no key can be
 * shown not to be a secret. Methods that are absent stay absent. Refusals are
 * `async` functions, so the executors' AsyncFunction dispatch is unchanged.
 */
export function forWorkersRun<B extends Record<string, any>>(
  bridge: B,
  opts: { secretConfigKeys: Iterable<string> | SecretConfigKeyResolver | null },
): B {
  const target = bridge as Record<string, any>
  for (const name of SECRET_RETURNING_BRIDGE_METHODS) {
    if (typeof target[name] !== "function") continue
    target[name] = async () => {
      throw secretNotAvailableOnWorkers(`ctx.${name}`)
    }
  }
  const source = opts.secretConfigKeys
  const fixed = source === null || typeof source === "function" ? null : new Set(source)
  const isSecret = async (key: string): Promise<boolean> => {
    if (fixed) return fixed.has(key)
    if (source === null || typeof source !== "function") return true
    try {
      return new Set(await source()).has(key)
    } catch {
      return true
    }
  }
  const configGet = target.config_get
  if (typeof configGet === "function") {
    target.config_get = async (key: string, ...rest: unknown[]) => {
      if (await isSecret(String(key))) {
        throw secretNotAvailableOnWorkers(`ctx.config.get("${String(key)}")`)
      }
      return configGet(key, ...rest)
    }
  }
  Object.defineProperty(target, WORKERS_RUN_BRIDGE, { value: true, enumerable: false })
  return bridge
}

export function isWorkersRunBridge(bridge: unknown): boolean {
  return (
    !!bridge &&
    typeof bridge === "object" &&
    (bridge as Record<symbol, unknown>)[WORKERS_RUN_BRIDGE] === true
  )
}

/** One HMAC-SHA256 digest, in the encoding a provider sends it. */
async function hmacSha256(
  secret: string,
  data: string,
  encoding: "base64" | "hex",
): Promise<string> {
  const { createHmac } = await import("node:crypto")
  return createHmac("sha256", secret).update(data, "utf8").digest(encoding)
}

/** Constant-time compare; unequal lengths still pay one comparison. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  if (left.length !== right.length) {
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

/**
 * The secret-by-key methods, over one config reader (the bridge's own
 * `config_get` logic, before any Workers refusal). Only a declared secret key
 * may be named: a plain config value needs no host-side signing.
 *
 *   config_has(key)                                     -> boolean
 *   crypto_hmacSha256Base64ForConfig(key, data)         -> base64 digest, or null when unset
 *   crypto_verifyHmacForConfig(key, data, sig, enc)     -> boolean (false when unset)
 */
export function createConfigSecretMethods(opts: {
  readConfig: (key: string) => Promise<unknown>
  secretConfigKeys: Iterable<string>
}): Record<string, (...args: any[]) => Promise<unknown>> {
  const secretKeys = new Set(opts.secretConfigKeys)
  const readSecret = async (key: unknown): Promise<string | null> => {
    const k = String(key)
    if (!secretKeys.has(k)) {
      throw typedError(400, "not_a_secret_config_key", `config key "${k}" is not a declared secret`)
    }
    const value = await opts.readConfig(k)
    return typeof value === "string" && value.length > 0 ? value : null
  }
  return {
    config_has: async (key: string): Promise<boolean> => {
      const value = await opts.readConfig(String(key))
      if (value === undefined || value === null) return false
      return typeof value === "string" ? value.length > 0 : true
    },
    crypto_hmacSha256Base64ForConfig: async (key: string, data: string): Promise<string | null> => {
      const secret = await readSecret(key)
      if (secret === null) return null
      return hmacSha256(secret, String(data ?? ""), "base64")
    },
    crypto_verifyHmacForConfig: async (
      key: string,
      data: string,
      signature: string,
      encoding: string = "base64",
    ): Promise<boolean> => {
      if (encoding !== "base64" && encoding !== "hex") {
        throw typedError(400, "invalid_input", `unsupported HMAC encoding "${String(encoding)}"`)
      }
      const secret = await readSecret(key)
      if (secret === null || typeof signature !== "string" || signature.length === 0) return false
      const expected = await hmacSha256(secret, String(data ?? ""), encoding)
      return constantTimeEqual(signature, expected)
    },
  }
}
