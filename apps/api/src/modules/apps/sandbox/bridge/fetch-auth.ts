// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Host-side credentials for `ctx.fetch` (secret-free.ts has the contract).
//
//   auth: {
//     connection: "<name>",          // a connection the manifest declares
//     identifier?: "<account>",      // which account (as for connections_getToken)
//     scheme: "header:<Name>" | "bearer" | "basic",
//     fields?: [...],                // a credentials connection: the field(s) to send
//     exchange?: {                   // bearer only: client-credentials token exchange
//       url, method?, fields: [keyField, secretField],
//       tokenField?: "accessToken", expiresInField?: "expiresIn",
//     },
//   }
//   configSecrets: { "<placeholder>": "<config key>" }   // written into the string body
//
// An oauth2 connection's value is its access token (the same lookup as
// connections_getToken); a credentials connection's values are its stored
// fields (connections_getCredentials' lookup). The credential goes only to a
// host of that connection's own `allowedDomains` (every redirect hop is held to
// them too), replaces any header of the same name the app set, and every value
// injected is redacted from what comes back, in case the upstream echoes it.
//
// A bearer `exchange` posts Basic(keyField:secretField) to the provider's token
// URL host-side, caches the bearer until 60 s before its declared expiry, and
// drops it when the provider answers 401, so the app's own retry re-exchanges.
// A failed exchange answers the app with the token endpoint's own status and
// body (no token in it), which is what the app saw when it exchanged itself.

import { createHmac, randomBytes } from "node:crypto"
import { connectionOfSecretKey, typedError } from "~/modules/apps/sandbox/bridge/secret-free"
import type { AppManifestForBridge } from "~/modules/apps/sandbox/bridge/shared"
import { matchesDomain } from "~/modules/apps/sandbox/bridge/shared"

export interface FetchAuthExchange {
  url: string
  method?: string
  fields: [string, string]
  tokenField?: string
  expiresInField?: string
}

export interface FetchAuth {
  connection: string
  identifier?: string
  scheme: string
  fields?: string[]
  exchange?: FetchAuthExchange
}

export interface FetchAuthDeps {
  manifest: AppManifestForBridge
  orgId: string
  userId: string
  appName: string
  /** The connection's access token and the account it belongs to (connections_getToken's lookup). */
  readToken: (
    connection: string,
    identifier?: string,
  ) => Promise<{ token: string; identifier: string }>
  /** The connection's stored fields (connections_getCredentials' lookup). */
  readCredentials: (connection: string, identifier?: string) => Promise<Record<string, unknown>>
  /** A declared config secret, decrypted (config_get's lookup); null when unset. */
  readConfigSecret: (key: string) => Promise<string | null>
  /** This bridge's own fetch, for the token exchange (returns its JSON answer). */
  send: (url: string, optsJson: string) => Promise<string>
}

export interface FetchResult {
  status: number
  headers: Record<string, string>
  body: string
}

const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "cookie",
  "connection",
  "transfer-encoding",
  "x-liaison-actor",
])
const IDENT_RE = /^[A-Za-z0-9_.:-]{1,128}$/
const PLACEHOLDER_RE = /^[A-Za-z0-9_{}:.-]{12,128}$/
const TOKEN_SKEW_MS = 60_000
/** A value shorter than this is never redacted (it would mangle unrelated text). */
const MIN_REDACT_LENGTH = 6

function invalid(message: string): Error {
  return typedError(400, "invalid_fetch_auth", `ctx.fetch auth: ${message}`)
}

function ident(value: unknown, what: string): string {
  if (typeof value !== "string" || !IDENT_RE.test(value)) throw invalid(`${what} must be a name`)
  return value
}

/** Validate `opts.auth` as the app sent it; null when absent. */
export function parseFetchAuth(raw: unknown): FetchAuth | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("must be an object")
  const r = raw as Record<string, unknown>
  const connection = ident(r.connection, "connection")
  const scheme = r.scheme
  if (typeof scheme !== "string") throw invalid("scheme is required")
  if (scheme !== "bearer" && scheme !== "basic" && !scheme.startsWith("header:")) {
    throw invalid(`unknown scheme "${scheme}"`)
  }
  if (scheme.startsWith("header:")) {
    const name = scheme.slice("header:".length)
    if (!HEADER_NAME_RE.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw invalid(`header "${name}" may not carry a credential`)
    }
  }
  const out: FetchAuth = { connection, scheme }
  if (r.identifier !== undefined && r.identifier !== null) {
    if (typeof r.identifier !== "string" || r.identifier.length > 512) {
      throw invalid("identifier must be a string")
    }
    out.identifier = r.identifier
  }
  if (r.fields !== undefined) {
    if (!Array.isArray(r.fields) || r.fields.length === 0 || r.fields.length > 2) {
      throw invalid("fields must name one or two credential fields")
    }
    out.fields = r.fields.map((f) => ident(f, "field"))
  }
  if (r.exchange !== undefined) {
    if (scheme !== "bearer") throw invalid("exchange is for the bearer scheme")
    const e = r.exchange as Record<string, unknown> | null
    if (!e || typeof e !== "object") throw invalid("exchange must be an object")
    if (typeof e.url !== "string") throw invalid("exchange.url is required")
    if (!Array.isArray(e.fields) || e.fields.length !== 2) {
      throw invalid("exchange.fields must name the key and secret fields")
    }
    const method = e.method === undefined ? "POST" : String(e.method).toUpperCase()
    if (method !== "POST" && method !== "GET") throw invalid("exchange.method must be POST or GET")
    out.exchange = {
      url: e.url,
      method,
      fields: [ident(e.fields[0], "field"), ident(e.fields[1], "field")],
      tokenField: e.tokenField === undefined ? "accessToken" : ident(e.tokenField, "tokenField"),
      expiresInField:
        e.expiresInField === undefined ? "expiresIn" : ident(e.expiresInField, "expiresInField"),
    }
  }
  return out
}

/** Validate `opts.configSecrets` ({placeholder: configKey}); null when absent. */
export function parseConfigSecrets(raw: unknown): Record<string, string> | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw typedError(400, "invalid_fetch_auth", "ctx.fetch configSecrets: must be an object")
  }
  const out: Record<string, string> = {}
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length === 0 || entries.length > 8) {
    throw typedError(400, "invalid_fetch_auth", "ctx.fetch configSecrets: one to eight entries")
  }
  for (const [placeholder, key] of entries) {
    if (!PLACEHOLDER_RE.test(placeholder)) {
      throw typedError(
        400,
        "invalid_fetch_auth",
        "ctx.fetch configSecrets: a placeholder is 12 to 128 characters of [A-Za-z0-9_{}:.-]",
      )
    }
    out[placeholder] = ident(key, "config key")
  }
  return out
}

function connectionDeclaration(manifest: AppManifestForBridge, name: string) {
  const declaration = manifest.connections?.[name]
  if (!declaration) {
    throw typedError(400, "invalid_fetch_auth", `Connection "${name}" not declared in app manifest`)
  }
  return declaration
}

/** Whether `url` is a host of `connection` (any host when it declares none). */
export function matchesConnectionHost(
  manifest: AppManifestForBridge,
  connection: string,
  url: string | URL,
): boolean {
  const domains = manifest.connections?.[connection]?.allowedDomains ?? []
  return domains.length === 0 || matchesDomain(url, domains)
}

/** The credential may only go to its own connection's hosts. */
export function assertConnectionHost(
  manifest: AppManifestForBridge,
  connection: string,
  url: string,
): void {
  connectionDeclaration(manifest, connection)
  if (!matchesConnectionHost(manifest, connection, url)) {
    let host = url
    try {
      host = new URL(url).hostname
    } catch {
      /* keep the raw url */
    }
    throw typedError(
      403,
      "credential_host_not_allowed",
      `ctx.fetch auth: ${host} is not a host of connection "${connection}"`,
    )
  }
}

/**
 * The one host an oauth2 account's token may go to, when the account names a
 * host of its own: an account whose identifier is itself one of the
 * connection's hosts (a shop domain under a wildcard such as `*.myshopify.com`)
 * is bound to that host, so one account's token never reaches another
 * account's host under the same wildcard. `null` for an account that names no
 * host (the connection's domains then bound it, as before).
 */
export function accountBoundHost(
  manifest: AppManifestForBridge,
  connection: string,
  identifier: string | undefined,
): string | null {
  if (!identifier || !/^[a-z0-9.-]+$/i.test(identifier) || !identifier.includes(".")) return null
  const host = identifier.toLowerCase()
  return matchesConnectionHost(manifest, connection, `https://${host}/`) &&
    (manifest.connections?.[connection]?.allowedDomains ?? []).length > 0
    ? host
    : null
}

function assertAccountHost(boundHost: string | null, connection: string, url: string): void {
  if (!boundHost) return
  let host = ""
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    /* an unparsable url names no host: refused below */
  }
  if (host !== boundHost) {
    throw typedError(
      403,
      "credential_host_not_allowed",
      `ctx.fetch auth: ${host || url} is not the host of this "${connection}" account`,
    )
  }
}

function fieldValue(
  creds: Record<string, unknown>,
  connection: string,
  field: string,
  declared: Set<string>,
): string {
  if (!declared.has(field)) {
    throw invalid(`"${field}" is not a declared field of connection "${connection}"`)
  }
  const v = creds[field]
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  if (typeof v !== "string" || v.length === 0) {
    throw typedError(
      409,
      "credential_missing",
      `Connection "${connection}" has no ${field} stored. Reconnect it in Settings.`,
    )
  }
  return v
}

// -- Token exchange cache (per process; a bearer never leaves it) -------------

interface CachedBearer {
  token: string
  expiresAtMs: number
}
const bearerCache = new Map<string, CachedBearer>()
const bearerInflight = new Map<string, Promise<CachedBearer | FetchResult>>()
/** Account slot -> the full cache key (with its credential fingerprint) last cached there. */
const bearerSlots = new Map<string, string>()
/** Per-process key for the credential fingerprint, so the cache holds no plain digest of a secret. */
const FINGERPRINT_KEY = randomBytes(32)

export const FetchAuthTestAccess = {
  reset(): void {
    bearerCache.clear()
    bearerInflight.clear()
    bearerSlots.clear()
  },
  cachedCount(): number {
    return bearerCache.size
  },
}

/** The account slot of an exchange: who, which connection account, which token endpoint. */
function exchangeSlot(deps: FetchAuthDeps, auth: FetchAuth, exchange: FetchAuthExchange): string {
  return [
    deps.orgId,
    deps.appName,
    deps.userId,
    auth.connection,
    auth.identifier ?? "",
    exchange.url,
    exchange.fields.join(","),
  ].join("\u0000")
}

async function runExchange(
  deps: FetchAuthDeps,
  auth: FetchAuth,
  exchange: FetchAuthExchange,
  timeoutMs: number | undefined,
): Promise<CachedBearer | FetchResult> {
  const answer = JSON.parse(
    await deps.send(
      exchange.url,
      JSON.stringify({
        method: exchange.method ?? "POST",
        headers: { "Content-Type": "application/json" },
        auth: {
          connection: auth.connection,
          ...(auth.identifier !== undefined ? { identifier: auth.identifier } : {}),
          scheme: "basic",
          fields: exchange.fields,
        },
        ...(timeoutMs ? { timeoutMs } : {}),
      }),
    ),
  ) as FetchResult
  if (answer.status >= 400) return answer
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(answer.body) as Record<string, unknown>
  } catch {
    throw typedError(502, "auth_exchange_invalid", "token endpoint answered with no JSON")
  }
  const token = parsed[exchange.tokenField ?? "accessToken"]
  const expiresIn = parsed[exchange.expiresInField ?? "expiresIn"]
  if (typeof token !== "string" || token.length === 0 || typeof expiresIn !== "number") {
    throw typedError(
      502,
      "auth_exchange_invalid",
      "token endpoint answered with no token or expiry",
    )
  }
  return { token, expiresAtMs: Date.now() + Math.max(expiresIn * 1000 - TOKEN_SKEW_MS, 0) }
}

/**
 * The cache key: the account slot plus a keyed fingerprint of the stored
 * credential pair the exchange sends. Reconnecting the account with other keys
 * (or rotating them) changes the fingerprint, so the old account's bearer is
 * never answered for the new credentials; the slot's previous entry is dropped.
 */
async function exchangeKey(
  deps: FetchAuthDeps,
  auth: FetchAuth,
  exchange: FetchAuthExchange,
  declared: Set<string>,
): Promise<string> {
  const creds = await deps.readCredentials(auth.connection, auth.identifier)
  const user = fieldValue(creds, auth.connection, exchange.fields[0], declared)
  const pass = fieldValue(creds, auth.connection, exchange.fields[1], declared)
  const fingerprint = createHmac("sha256", FINGERPRINT_KEY)
    .update(`${user.length}:${user}\u0000${pass}`, "utf8")
    .digest("hex")
  const slot = exchangeSlot(deps, auth, exchange)
  const key = `${slot}\u0000${fingerprint}`
  const previous = bearerSlots.get(slot)
  if (previous !== undefined && previous !== key) bearerCache.delete(previous)
  bearerSlots.set(slot, key)
  return key
}

async function exchangedBearer(
  deps: FetchAuthDeps,
  auth: FetchAuth,
  exchange: FetchAuthExchange,
  declared: Set<string>,
  timeoutMs: number | undefined,
): Promise<{ key: string; bearer: CachedBearer } | { failed: FetchResult }> {
  const key = await exchangeKey(deps, auth, exchange, declared)
  const cached = bearerCache.get(key)
  if (cached && Date.now() < cached.expiresAtMs) return { key, bearer: cached }
  let inflight = bearerInflight.get(key)
  if (!inflight) {
    inflight = runExchange(deps, auth, exchange, timeoutMs).finally(() => {
      bearerInflight.delete(key)
    })
    bearerInflight.set(key, inflight)
  }
  const out = await inflight
  if ("token" in out) {
    bearerCache.set(key, out)
    return { key, bearer: out }
  }
  return { failed: out }
}

export interface InjectedAuth {
  /** Every value written into the request, for redaction. */
  secrets: string[]
  /** Set when a cached bearer was used: a 401 answer drops it. */
  bearerKey?: string
  /** The token exchange failed: answer the app with this instead of fetching. */
  failed?: FetchResult
  /** The one host the injected credential may reach (an account bound to its own host). */
  boundHost?: string
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) delete headers[k]
  }
  headers[name] = value
}

/**
 * Add `auth`'s credential to `headers` (mutated). Call after the allowlist
 * check: this adds the connection-host check on top.
 */
export async function injectFetchAuth(
  url: string,
  headers: Record<string, string>,
  auth: FetchAuth,
  deps: FetchAuthDeps,
  timeoutMs?: number,
): Promise<InjectedAuth> {
  assertConnectionHost(deps.manifest, auth.connection, url)
  const declaration = connectionDeclaration(deps.manifest, auth.connection)
  const isCredentials = declaration.type === "credentials"
  const declared = new Set((declaration.credentialFields ?? []).map((f) => f.name))

  if (auth.exchange) {
    if (!isCredentials) throw invalid("a bearer exchange needs a credentials connection")
    const got = await exchangedBearer(deps, auth, auth.exchange, declared, timeoutMs)
    if ("failed" in got) return { secrets: [], failed: got.failed }
    setHeader(headers, "Authorization", `Bearer ${got.bearer.token}`)
    return { secrets: [got.bearer.token], bearerKey: got.key }
  }

  if (auth.scheme === "basic") {
    if (!isCredentials || auth.fields?.length !== 2) {
      throw invalid("basic needs a credentials connection and its two fields [user, password]")
    }
    const creds = await deps.readCredentials(auth.connection, auth.identifier)
    const user = fieldValue(creds, auth.connection, auth.fields[0]!, declared)
    const pass = fieldValue(creds, auth.connection, auth.fields[1]!, declared)
    const encoded = Buffer.from(`${user}:${pass}`, "utf8").toString("base64")
    setHeader(headers, "Authorization", `Basic ${encoded}`)
    return { secrets: [user, pass, encoded] }
  }

  let value: string
  let boundHost: string | null = null
  if (isCredentials) {
    if (auth.fields?.length !== 1) {
      throw invalid("a credentials connection names the one field to send")
    }
    const creds = await deps.readCredentials(auth.connection, auth.identifier)
    value = fieldValue(creds, auth.connection, auth.fields[0]!, declared)
  } else {
    if (auth.fields) throw invalid("an oauth2 connection sends its token; fields do not apply")
    // A named account that is itself a host is checked before its token is read.
    assertAccountHost(
      accountBoundHost(deps.manifest, auth.connection, auth.identifier),
      auth.connection,
      url,
    )
    const account = await deps.readToken(auth.connection, auth.identifier)
    value = account.token
    if (typeof value !== "string" || value.length === 0) {
      throw typedError(409, "credential_missing", `Connection "${auth.connection}" has no token`)
    }
    boundHost = accountBoundHost(deps.manifest, auth.connection, account.identifier)
    assertAccountHost(boundHost, auth.connection, url)
  }
  if (auth.scheme === "bearer") {
    setHeader(headers, "Authorization", `Bearer ${value}`)
  } else {
    setHeader(headers, auth.scheme.slice("header:".length), value)
  }
  return { secrets: [value], ...(boundHost ? { boundHost } : {}) }
}

/** The bearer a 401 answered: drop it so the next call exchanges again. */
export function dropBearer(key: string | undefined): void {
  if (key) bearerCache.delete(key)
}

/**
 * Write each declared config secret into the string `body` where its
 * placeholder stands (verbatim). Each key must be a declared secret, the URL a
 * host of the connection that declares it, and the placeholder must occur.
 */
export async function substituteConfigSecrets(
  url: string,
  body: unknown,
  map: Record<string, string>,
  deps: FetchAuthDeps,
): Promise<{ body: string; secrets: string[] }> {
  if (typeof body !== "string") {
    throw typedError(400, "invalid_fetch_auth", "ctx.fetch configSecrets: needs a string body")
  }
  let out = body
  const secrets: string[] = []
  for (const [placeholder, key] of Object.entries(map)) {
    const owner = connectionOfSecretKey(deps.manifest.connections, key)
    if (!owner) {
      throw typedError(
        400,
        "not_a_secret_config_key",
        `config key "${key}" is not a declared secret`,
      )
    }
    assertConnectionHost(deps.manifest, owner.name, url)
    if (!out.includes(placeholder)) {
      throw typedError(
        400,
        "invalid_fetch_auth",
        "ctx.fetch configSecrets: placeholder not in body",
      )
    }
    const secret = await deps.readConfigSecret(key)
    if (!secret) {
      throw typedError(409, "config_secret_missing", `config secret "${key}" is not set`)
    }
    out = out.split(placeholder).join(secret)
    secrets.push(secret)
  }
  return { body: out, secrets }
}

/** Replace every injected value (and its base64 form) in `text`. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
  for (const s of secrets) {
    if (s.length < MIN_REDACT_LENGTH) continue
    if (out.includes(s)) out = out.split(s).join("[redacted]")
  }
  return out
}
