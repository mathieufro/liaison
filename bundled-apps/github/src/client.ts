// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GitHub REST over `ctx.fetch`, read-only. The token never enters the app:
// every call names the `github` connection and the host adds its `token` field
// as `Authorization: Bearer`, only towards the connection's allowedDomains
// (`api.github.com`), paced by the connection's `limits`.
//
// Only GET leaves: `githubRequest` throws on any other method before a call is
// made, and refuses any URL that is not under https://api.github.com/. Every
// path segment built from a parameter goes through `segment` (dot segments
// refused, the rest percent-encoded), and a repository is always one of the
// connected owner's (`repoPath`).
//
// Errors come back typed (`GithubHttpError`): 401 auth_revoked, 403 or 429 with
// GitHub's rate headers rate_limited (with `retryAt`), any other 403
// forbidden, 404 not_found, anything else github_error with its status. None
// carries the request or the token. A classic token whose scopes can write is
// refused on its first answer (write_token_refused).
//
// Pagination follows `Link: rel="next"` up to MAX_ROWS rows and says
// `truncated` when more were left. An answer over MAX_BODY_BYTES is refused.

import { readConnectionSettings } from "@liaison/app-sdk/connection-credentials"

export const API_BASE = "https://api.github.com"
export const WEB_BASE = "https://github.com"
/** The REST API version every call pins. */
export const API_VERSION = "2022-11-28"
const CONNECTION = "github"
/** Rows one list read returns at most. */
export const MAX_ROWS = 500
/** The largest answer body read. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024

export interface FetchAnswer {
  status: number
  headers: Record<string, string>
  body: string
}

export interface GithubCtx {
  fetch(
    url: string,
    opts?: {
      method?: string
      headers?: Record<string, string>
      auth?: { connection: string; scheme: "bearer" | `header:${string}`; fields?: string[] }
    },
  ): Promise<FetchAnswer>
  connections: unknown
}

export class GithubHttpError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAt?: string
  constructor(status: number, code: string, message: string, retryAt?: string) {
    super(message)
    this.name = "GithubHttpError"
    this.status = status
    this.code = code
    if (retryAt !== undefined) this.retryAt = retryAt
  }
}

/** No usable `github` connection for the caller. */
export class GithubNotConnectedError extends Error {
  constructor(message = "No GitHub connection for this organization.") {
    super(message)
    this.name = "GithubNotConnectedError"
  }
}

/** A parameter the tool refuses before any call (another owner, a dot segment). */
export class GithubParamError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "GithubParamError"
    this.code = code
  }
}

export function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === wanted) return v
  }
  return undefined
}

/** When a rate-limited call may be retried: GitHub's reset time or its retry-after. */
function retryAtOf(answer: FetchAnswer): string | undefined {
  const reset = Number(header(answer.headers, "x-ratelimit-reset"))
  if (Number.isFinite(reset) && reset > 0) return new Date(reset * 1000).toISOString()
  const after = Number(header(answer.headers, "retry-after"))
  if (Number.isFinite(after) && after >= 0) return new Date(Date.now() + after * 1000).toISOString()
  return undefined
}

function isRateLimited(answer: FetchAnswer): boolean {
  if (answer.status === 429) return true
  return (
    answer.status === 403 &&
    (header(answer.headers, "x-ratelimit-remaining") === "0" ||
      header(answer.headers, "retry-after") !== undefined)
  )
}

function errorFor(answer: FetchAnswer): GithubHttpError {
  if (answer.status === 401) {
    return new GithubHttpError(
      401,
      "auth_revoked",
      "GitHub refused the token (expired or revoked). An admin pastes a new one in Settings → GitHub.",
    )
  }
  if (isRateLimited(answer)) {
    const retryAt = retryAtOf(answer)
    return new GithubHttpError(
      answer.status,
      "rate_limited",
      `GitHub's rate limit is reached${retryAt ? `; retry after ${retryAt}` : ""}. Nothing was read.`,
      retryAt,
    )
  }
  if (answer.status === 403) {
    return new GithubHttpError(
      403,
      "forbidden",
      "GitHub refused this read: the token has no access to it.",
    )
  }
  if (answer.status === 404) {
    return new GithubHttpError(
      404,
      "not_found",
      "GitHub found nothing there, or the token cannot see it.",
    )
  }
  return new GithubHttpError(
    answer.status,
    "github_error",
    `GitHub answered HTTP ${answer.status}. Nothing was read.`,
  )
}

/** Classic-token scopes that can write (a fine-grained token sends no scope header). */
export function writeScopesOf(scopeHeader: string | undefined): string[] {
  if (!scopeHeader) return []
  return scopeHeader
    .split(",")
    .map((s) => s.trim())
    .filter(
      (s) =>
        s === "repo" ||
        s === "public_repo" ||
        s === "delete_repo" ||
        s === "workflow" ||
        s.startsWith("write:") ||
        s.startsWith("admin:"),
    )
}

export function writeTokenError(scopes: string[]): GithubHttpError {
  return new GithubHttpError(
    403,
    "write_token_refused",
    `This GitHub token can write (classic scope ${scopes.join(", ")}), and Liaison reads GitHub read-only. ` +
      "Create a fine-grained token with read-only Contents, Metadata, Pull requests and Issues, and paste it in Settings → GitHub.",
  )
}

/**
 * The one way out: a GET to api.github.com. Any other method throws before a
 * call is made, as does a URL outside the API.
 */
export async function githubRequest(
  ctx: GithubCtx,
  pathOrUrl: string,
  opts: { method?: string; accept?: string } = {},
): Promise<FetchAnswer> {
  const method = opts.method ?? "GET"
  if (method !== "GET") {
    throw new GithubParamError("read_only", `GitHub is read-only here: ${method} is never sent.`)
  }
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${API_BASE}${pathOrUrl}`
  if (!url.startsWith(`${API_BASE}/`)) {
    throw new GithubParamError("invalid_url", "GitHub egress refused: not an api.github.com URL")
  }
  const answer = await ctx.fetch(url, {
    method: "GET",
    headers: {
      accept: opts.accept ?? "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
    },
    auth: { connection: CONNECTION, scheme: "bearer", fields: ["token"] },
  })
  if (answer.status < 200 || answer.status >= 300) throw errorFor(answer)
  const write = writeScopesOf(header(answer.headers, "x-oauth-scopes"))
  if (write.length > 0) throw writeTokenError(write)
  if ((answer.body ?? "").length > MAX_BODY_BYTES) {
    throw new GithubHttpError(
      answer.status,
      "github_error",
      "GitHub's answer is over 10 MB and was not read.",
    )
  }
  return answer
}

export async function getJson<T>(ctx: GithubCtx, pathOrUrl: string, accept?: string): Promise<T> {
  const answer = await githubRequest(ctx, pathOrUrl, accept ? { accept } : {})
  return JSON.parse(answer.body) as T
}

/** The `Link: <url>; rel="next"` of an answer, when there is one. */
export function nextLink(answer: FetchAnswer): string | null {
  const link = header(answer.headers, "link")
  if (!link) return null
  for (const part of link.split(",")) {
    const m = part.trim().match(/^<([^>]+)>;\s*rel="next"/)
    if (m?.[1]) return m[1]
  }
  return null
}

/**
 * A `Link`-paginated list, at most `maxRows` rows. `itemsOf` picks the rows of
 * one page (the page itself, or a search answer's `items`); `keep` filters
 * them before they count.
 */
export async function getList<T>(
  ctx: GithubCtx,
  path: string,
  opts: {
    maxRows?: number
    accept?: string
    itemsOf?: (page: unknown) => unknown[]
    keep?: (item: T) => boolean
    /** Ends the list at the first row it holds for (rows sorted so the rest would too). */
    stop?: (item: T) => boolean
  } = {},
): Promise<{ items: T[]; truncated: boolean }> {
  const maxRows = opts.maxRows ?? MAX_ROWS
  const itemsOf = opts.itemsOf ?? ((page) => (Array.isArray(page) ? page : []))
  const items: T[] = []
  let url: string | null = path
  while (url) {
    const answer = await githubRequest(ctx, url, opts.accept ? { accept: opts.accept } : {})
    const page = itemsOf(JSON.parse(answer.body)) as T[]
    const next = nextLink(answer)
    for (let i = 0; i < page.length; i++) {
      const item = page[i] as T
      if (opts.stop?.(item)) return { items, truncated: false }
      if (opts.keep && !opts.keep(item)) continue
      if (items.length >= maxRows) return { items, truncated: true }
      items.push(item)
    }
    url = next
  }
  return { items, truncated: false }
}

/** The connected owner (a readable field of the connection), or not connected. */
export async function connectedOwner(ctx: GithubCtx): Promise<string> {
  const read = await readConnectionSettings(ctx.connections, CONNECTION, [
    "token",
    "owner",
  ] as const)
  if (!read.ok) {
    if (read.reason === "incomplete") {
      throw new GithubNotConnectedError(
        `The GitHub connection is missing: ${read.missing.join(", ")}`,
      )
    }
    throw new GithubNotConnectedError()
  }
  const owner = (read.values.owner ?? "").trim()
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    throw new GithubNotConnectedError("The GitHub connection has no valid owner.")
  }
  return owner
}

// ---------------------------------------------------------------------------
// Paths built from parameters
// ---------------------------------------------------------------------------

/** One path segment from a parameter: never empty, never `.` or `..`, percent-encoded. */
export function segment(value: string, what: string): string {
  if (value === "" || /^\.+$/.test(value)) {
    throw new GithubParamError("invalid_path", `The ${what} "${value}" is not a valid path part.`)
  }
  return encodeURIComponent(value)
}

/** A repository path (`/repos/<owner>/<name>`), only for the connected owner's repositories. */
export function repoPath(owner: string, repo: unknown): string {
  const given = typeof repo === "string" ? repo.trim() : ""
  const slash = given.indexOf("/")
  const repoOwner = slash === -1 ? owner : given.slice(0, slash)
  const name = slash === -1 ? given : given.slice(slash + 1)
  if (repoOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new GithubParamError(
      "repo_outside_owner",
      `The repository "${given}" is not ${owner}'s. I read only the connected owner's repositories.`,
    )
  }
  if (!/^[A-Za-z0-9._-]+$/.test(name) || /^\.+$/.test(name)) {
    throw new GithubParamError(
      "invalid_repo",
      `"${given}" is not a repository name: give it as ${owner}/<name>.`,
    )
  }
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

/** A file or directory path inside a repository, one encoded segment at a time. */
export function filePath(path: unknown): string {
  const given = typeof path === "string" ? path : ""
  const parts = given.split("/").filter((p) => p !== "")
  return parts.map((p) => segment(p, "path")).join("/")
}

// ---------------------------------------------------------------------------
// Text of a repository file
// ---------------------------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/** Base64 to bytes, without Buffer or atob (neither is on every executor). */
export function base64Bytes(text: string): number[] {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "")
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64.indexOf(clean[i] as string)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  return out
}

/** UTF-8 bytes to text; an invalid sequence becomes U+FFFD. */
export function utf8Text(bytes: number[]): string {
  let out = ""
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i] as number
    let cp = 0xfffd
    let len = 1
    if (b < 0x80) cp = b
    else if (b >= 0xc2 && b < 0xe0) len = 2
    else if (b >= 0xe0 && b < 0xf0) len = 3
    else if (b >= 0xf0 && b < 0xf5) len = 4
    if (len > 1) {
      let v = b & (0xff >> (len + 1))
      let ok = i + len <= bytes.length
      for (let j = 1; ok && j < len; j++) {
        const c = bytes[i + j] as number
        if ((c & 0xc0) !== 0x80) ok = false
        else v = (v << 6) | (c & 0x3f)
      }
      const min = [0, 0, 0x80, 0x800, 0x10000][len] as number
      if (ok && v >= min && v <= 0x10ffff && (v < 0xd800 || v > 0xdfff)) cp = v
      else len = 1
    }
    out += String.fromCodePoint(cp)
    i += len
  }
  return out
}

// ---------------------------------------------------------------------------
// Secret redaction of every text body (high-confidence patterns only)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub classic, OAuth, user, server and refresh tokens
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g, // GitHub fine-grained token
  /glpat-[A-Za-z0-9_-]{20,}/g, // GitLab PAT
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  // An armoured private key of any label (PKCS#8 has no algorithm word; PGP ends in BLOCK; SSH2
  // uses four dashes and spaces), through its END line, or, when the END line is cut off (a diff's
  // context), through the end of its hunk or of the text.
  /-{4,5} ?BEGIN (?:\w+ )*PRIVATE KEY(?: BLOCK)? ?-{4,5}[\s\S]*?(?:-{4,5} ?END (?:\w+ )*PRIVATE KEY(?: BLOCK)? ?-{4,5}|(?=\n@@ |\ndiff --git )|$)/g,
  /PRIVATE-TOKEN:\s*\S+/g, // a raw header value
  /Authorization:\s*Bearer\s+\S+/gi, // a bearer token
]

export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]")
  return out
}

/** `redactSecrets` over a text field that may be absent. */
export function redacted<T extends string | null | undefined>(text: T): T {
  return (typeof text === "string" ? redactSecrets(text) : text) as T
}
