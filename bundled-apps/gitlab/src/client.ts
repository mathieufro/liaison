// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GitLab REST v4 over `ctx.fetch`. The token never enters the app: every call
// names the `gitlab` connection and the host adds its `token` field as
// `Authorization: Bearer` (fetch-auth; GitLab takes personal, group and
// project access tokens there as well as OAuth tokens), only towards the
// connection's own allowedDomains, and paces the call through the
// connection's `limits`.
//
// Errors come back typed (`GitlabHttpError`: AUTH_REVOKED, FORBIDDEN,
// NOT_FOUND, RATE_LIMITED or HTTP_<status>), never carrying the request.
//
// Pagination: list endpoints follow `x-next-page` (offset) up to MAX_PAGES
// pages and say `truncated` when more were left; the tree follows the keyset
// `Link: rel="next"` URL one page at a time.
// The tools that follow pages declare `timeoutMs` in the manifest: up to
// MAX_PAGES sequential calls of about a second each do not fit the 5 s base
// wall clock of a tool run.

import { readConnectionSettings } from "@liaison/app-sdk/connection-credentials"

export const API_BASE = "https://gitlab.com/api/v4"
export const WEB_BASE = "https://gitlab.com"
const CONNECTION = "gitlab"
/** Pages one list read follows (100 items each). */
export const MAX_PAGES = 10

export interface FetchAnswer {
  status: number
  headers: Record<string, string>
  body: string
}

export interface GitlabCtx {
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

export class GitlabHttpError extends Error {
  readonly status: number
  readonly code: string
  readonly gitlabMessage?: string
  readonly retryAfter?: number
  constructor(
    status: number,
    code: string,
    message: string,
    gitlabMessage?: string,
    retryAfter?: number,
  ) {
    super(message)
    this.name = "GitlabHttpError"
    this.status = status
    this.code = code
    if (gitlabMessage !== undefined) this.gitlabMessage = gitlabMessage
    if (retryAfter !== undefined) this.retryAfter = retryAfter
  }
}

/** No usable `gitlab` connection for the caller. */
export class GitlabNotConnectedError extends Error {
  constructor(message = "No GitLab connection for this organization.") {
    super(message)
    this.name = "GitlabNotConnectedError"
  }
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase()
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (k.toLowerCase() === wanted) return v
  }
  return undefined
}

function errorFor(answer: FetchAnswer): GitlabHttpError {
  let gitlabMessage: string | undefined
  try {
    const parsed = JSON.parse(answer.body) as { message?: unknown; error?: unknown }
    const m = parsed.message ?? parsed.error
    if (typeof m === "string") gitlabMessage = m
    else if (m !== undefined) gitlabMessage = JSON.stringify(m)
  } catch {
    // Not JSON: the status alone says it.
  }
  // The typed code sits in the message too: a sync failure keeps only the
  // message as the source's last error.
  switch (answer.status) {
    case 401:
      return new GitlabHttpError(
        401,
        "AUTH_REVOKED",
        "GitLab authentication failed (AUTH_REVOKED)",
        gitlabMessage,
      )
    case 403:
      return new GitlabHttpError(
        403,
        "FORBIDDEN",
        "GitLab access forbidden (FORBIDDEN)",
        gitlabMessage,
      )
    case 404:
      return new GitlabHttpError(
        404,
        "NOT_FOUND",
        "GitLab resource not found (NOT_FOUND)",
        gitlabMessage,
      )
    case 429: {
      const ra = Number(header(answer.headers, "retry-after"))
      return new GitlabHttpError(
        429,
        "RATE_LIMITED",
        "GitLab rate limit reached (RATE_LIMITED)",
        gitlabMessage,
        Number.isFinite(ra) ? ra : undefined,
      )
    }
    default:
      return new GitlabHttpError(
        answer.status,
        `HTTP_${answer.status}`,
        `GitLab HTTP ${answer.status}`,
        gitlabMessage,
      )
  }
}

export function encodeId(id: string | number): string {
  return encodeURIComponent(String(id))
}

/** One authenticated GET: an API path (`/projects/…`) or an absolute gitlab.com URL. */
export async function gitlabGet(ctx: GitlabCtx, pathOrUrl: string): Promise<FetchAnswer> {
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${API_BASE}${pathOrUrl}`
  if (!url.startsWith(`${API_BASE}/`)) {
    throw new GitlabHttpError(400, "INVALID_URL", "GitLab egress refused: not a gitlab.com API URL")
  }
  const answer = await ctx.fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
    auth: { connection: CONNECTION, scheme: "bearer", fields: ["token"] },
  })
  if (answer.status >= 200 && answer.status < 300) return answer
  throw errorFor(answer)
}

export async function getJson<T>(ctx: GitlabCtx, pathOrUrl: string): Promise<T> {
  const answer = await gitlabGet(ctx, pathOrUrl)
  return JSON.parse(answer.body) as T
}

/** `url` asking for page `page` (no `URL`: it is not on every executor). */
export function withPage(url: string, page: string): string {
  const [base = "", query = ""] = url.split("?", 2)
  const kept = query.split("&").filter((p) => p !== "" && !p.startsWith("page="))
  return `${base}?${[...kept, `page=${encodeURIComponent(page)}`].join("&")}`
}

/** An offset-paginated list, at most `maxPages` pages. */
export async function getList<T>(
  ctx: GitlabCtx,
  path: string,
  maxPages: number = MAX_PAGES,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = []
  let url = path.startsWith("https://") ? path : `${API_BASE}${path}`
  for (let page = 1; ; page++) {
    const answer = await gitlabGet(ctx, url)
    const body = JSON.parse(answer.body) as unknown
    if (Array.isArray(body)) items.push(...(body as T[]))
    const next = header(answer.headers, "x-next-page")
    if (!next) return { items, truncated: false }
    if (page >= maxPages) return { items, truncated: true }
    url = withPage(url, next)
  }
}

/** The keyset `Link: <url>; rel="next"` of an answer, when there is one. */
export function nextLink(answer: FetchAnswer): string | null {
  const link = header(answer.headers, "link")
  if (!link) return null
  for (const part of link.split(",")) {
    const m = part.trim().match(/^<([^>]+)>;\s*rel="next"/)
    if (m?.[1]) return m[1]
  }
  return null
}

/** The connected group (a readable field of the connection), or not connected. */
export async function connectedGroup(ctx: GitlabCtx): Promise<string> {
  const read = await readConnectionSettings(ctx.connections, CONNECTION, [
    "token",
    "group",
  ] as const)
  if (!read.ok) {
    if (read.reason === "incomplete") {
      throw new GitlabNotConnectedError(
        `The GitLab connection is missing: ${read.missing.join(", ")}`,
      )
    }
    throw new GitlabNotConnectedError()
  }
  const group = read.values.group
  if (!group) throw new GitlabNotConnectedError("The GitLab connection has no group.")
  return group
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
    acc = (acc << 6) | B64.indexOf(clean[i]!)
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
    const b = bytes[i]!
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
        const c = bytes[i + j]!
        if ((c & 0xc0) !== 0x80) ok = false
        else v = (v << 6) | (c & 0x3f)
      }
      if (
        ok &&
        v >= [0, 0, 0x80, 0x800, 0x10000][len]! &&
        v <= 0x10ffff &&
        (v < 0xd800 || v > 0xdfff)
      ) {
        cp = v
      } else {
        len = 1
      }
    }
    out += String.fromCodePoint(cp)
    i += len
  }
  return out
}

export interface GitlabFile {
  content: string
  blob_id: string
  last_commit_id: string
  file_path: string
}

/** A repository file: its decoded text, blob id and last commit. */
export async function readFile(
  ctx: GitlabCtx,
  project: string,
  path: string,
  ref: string,
): Promise<{ text: string; blobId: string; lastCommitId: string }> {
  const file = await getJson<GitlabFile>(
    ctx,
    `/projects/${encodeId(project)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(ref)}`,
  )
  return {
    text: utf8Text(base64Bytes(file.content ?? "")),
    blobId: file.blob_id,
    lastCommitId: file.last_commit_id,
  }
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
