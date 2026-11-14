// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Exfiltration guardrails for the agent's web reads (web_search, web_fetch).
//
// A web read never parks for an approval (scope-taint.ts, rule 9, 2026-10-29): it is a read.
// Its one way out is the request it sends, so a prompt-injected turn could try to smuggle org data
// through a search query or a fetch URL. These checks bound that channel in code, at the dispatch
// (execute-tool.ts), for every surface (chat, routines, sub-runs, the MCP gateway). A refusal is an
// inline tool error naming the limit and the remedy, never a park.
//
//   SHAPE (always): a query of at most LIAISON_WEB_SEARCH_MAX_QUERY_CHARS; a URL of at most
//   LIAISON_WEB_FETCH_MAX_URL_CHARS with a query string of at most
//   LIAISON_WEB_FETCH_MAX_QUERY_CHARS and no `user:pass@`. A research query or a page address
//   never needs more, and a check that depends on nothing is one a model cannot steer around.
//   PAYLOAD (on a turn that read org data, or whose reads are unknown, as across a hop that lost
//   the turn's frame): no long opaque run (32+ characters of base64, hex or digits in one piece,
//   raw or percent-decoded), no run of 11+ percent-escaped ASCII characters (text that needed no
//   escaping), no email address, IBAN-like, card-like or phone-like number, no secret-like token,
//   and in a query no run of 9+ digits. Searching a company's public name stays fine; carrying a
//   customer's address, number or a document out does not. Not applied on a turn that read no
//   org data: it holds nothing to leak, and content-addressed pages (a commit, a shared document)
//   are legitimately opaque. A fetch of exactly one of this turn's own search results
//   (claimSearchResultFetch) skips SHAPE and PAYLOAD: the provider produced that URL, the model
//   did not compose it.
//   RATE (always): LIAISON_WEB_READS_PER_TURN reads per turn, LIAISON_WEB_READS_CONSECUTIVE
//   in a row with no other tool call between them, LIAISON_WEB_FETCH_HOSTS_PER_TURN distinct
//   fetched hosts per turn (in the turn's memory, `TurnWebReads`), and
//   LIAISON_WEB_READS_PER_THREAD_HOUR per conversation in a rolling hour (Redis, so a turn
//   that loses its frame, a sub-run or an MCP client is still bounded).

import { luhnValid } from "@liaison/shared"
import type { Redis } from "ioredis"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import type { TurnWebReads } from "~/modules/agent/scopes/turn-scope-accumulator"

const log = rootLogger.child({ module: "web-read-guardrails" })

export interface WebReadLimits {
  maxQueryChars: number
  maxUrlChars: number
  maxUrlQueryChars: number
  perTurn: number
  consecutive: number
  fetchHostsPerTurn: number
  perThreadHour: number
}

export function webReadLimits(): WebReadLimits {
  return {
    maxQueryChars: env.LIAISON_WEB_SEARCH_MAX_QUERY_CHARS,
    maxUrlChars: env.LIAISON_WEB_FETCH_MAX_URL_CHARS,
    maxUrlQueryChars: env.LIAISON_WEB_FETCH_MAX_QUERY_CHARS,
    perTurn: env.LIAISON_WEB_READS_PER_TURN,
    consecutive: env.LIAISON_WEB_READS_CONSECUTIVE,
    fetchHostsPerTurn: env.LIAISON_WEB_FETCH_HOSTS_PER_TURN,
    perThreadHour: env.LIAISON_WEB_READS_PER_THREAD_HOUR,
  }
}

/** A refusal is a bad request from the agent (422), never a server fault: the message says the
 *  limit and what to do instead. */
export interface WebReadRefusal {
  code: "web_read_refused"
  message: string
  retryable: false
  status: 422
}

const refuse = (message: string): WebReadRefusal => ({
  code: "web_read_refused",
  message,
  retryable: false,
  status: 422,
})

// ── Patterns ────────────────────────────────────────────────────────────────

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/
// An IBAN, spaced or not: country, check digits, then 11 to 30 alphanumerics, mostly digits
// (counted below, so "FY24 revenue growth" is no IBAN).
const IBAN = /\b[A-Za-z]{2}\d{2}(?:[ ]?[A-Za-z0-9]){11,30}\b/g
// Well-known credential shapes: provider API keys and tokens, a JWT, a PEM block.
const SECRET_PREFIXES =
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)[-_A-Za-z0-9]{12,}|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{16,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{30,}|\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]+-----/
// A token-like run of 24+ characters mixing digits, upper and lower case (no word does).
const MIXED_TOKEN = /[A-Za-z0-9]{24,}/g
// A run of 32+ characters with no separator that a word, a slug or a path never needs.
const OPAQUE_RUN = /[A-Za-z0-9]{32,}/g
// 11+ percent-escapes of ASCII bytes in a row: text that needed no escaping.
const ESCAPED_ASCII_RUN = /(?:%[0-7][0-9A-Fa-f]){11,}/

/**
 * The digits of every run of digits joined by single spaces, dots or dashes. A run made only of
 * years ("2024 2025 2026", "2019-2024") is a range, not a number, and is left out.
 */
function digitRuns(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\+?\d(?:[ .-]?\d)*/g)) {
    const groups = m[0].replace(/^\+/, "").split(/[ .-]/)
    if (groups.every((g) => /^(?:19|20)\d\d$/.test(g))) continue
    out.push(m[0].replace(/\D/g, ""))
  }
  return out
}

function ibanLike(text: string): boolean {
  for (const m of text.matchAll(IBAN)) if (m[0].replace(/\D/g, "").length >= 10) return true
  return false
}

function mixedToken(text: string): boolean {
  for (const m of text.matchAll(MIXED_TOKEN)) {
    const t = m[0]
    if (/\d/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t)) return true
  }
  return false
}

function opaqueRun(text: string): boolean {
  for (const m of text.matchAll(OPAQUE_RUN)) if (/\d/.test(m[0])) return true
  return false
}

/** What org data `text` looks like it carries, in words, or null. */
function dataPattern(text: string, opts: { anyLongDigitRun: boolean }): string | null {
  if (EMAIL.test(text)) return "an email address"
  if (ibanLike(text)) return "an IBAN-like number"
  if (SECRET_PREFIXES.test(text) || mixedToken(text)) return "a secret-like token"
  for (const raw of digitRuns(text)) {
    // Payment card numbers start with 2 to 6 (a status or post id usually with 1).
    if (raw.length >= 13 && raw.length <= 19 && /^[2-6]/.test(raw) && luhnValid(raw)) {
      return "a card-like number"
    }
  }
  // A phone-like number: an international number written with its leading "+", anywhere; and,
  // in a search query, any run of 9 or more digits (a phone, account or card number).
  for (const m of text.matchAll(/\+\d(?:[ .-]?\d){7,}/g)) if (m[0]) return "a phone-like number"
  if (opts.anyLongDigitRun && digitRuns(text).some((d) => d.length >= 9)) {
    return "a long number (phone, account or card-like)"
  }
  return null
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "))
  } catch {
    return text
  }
}

// ── Checks ──────────────────────────────────────────────────────────────────

/** SHAPE and PAYLOAD of a web_search query; null when it may be sent. */
export function webSearchQueryRefusal(
  query: unknown,
  opts: { orgDataRead: boolean; limits?: WebReadLimits },
): WebReadRefusal | null {
  if (typeof query !== "string") return null
  const limits = opts.limits ?? webReadLimits()
  if (query.length > limits.maxQueryChars) {
    return refuse(
      `web_search refused: the query is ${query.length} characters and the limit is ${limits.maxQueryChars}. Search for the subject in a few words, one query per subject.`,
    )
  }
  if (opts.orgDataRead) {
    const found = dataPattern(query, { anyLongDigitRun: true })
    if (found) {
      return refuse(
        `web_search refused: the query contains ${found}. This turn read organization data, and a search query leaves the organization, so it may not carry personal or account data. Search for the public subject (a company, a product, a topic) instead.`,
      )
    }
    if (opaqueRun(query)) {
      return refuse(
        "web_search refused: the query carries a long encoded or opaque string. This turn read organization data, and a search query leaves the organization. Search in plain words for the public subject.",
      )
    }
  }
  return null
}

/** SHAPE and PAYLOAD of a web_fetch URL; null when it may be fetched. */
export function webFetchUrlRefusal(
  url: unknown,
  opts: { orgDataRead: boolean; limits?: WebReadLimits },
): WebReadRefusal | null {
  if (typeof url !== "string") return null
  const limits = opts.limits ?? webReadLimits()
  if (url.length > limits.maxUrlChars) {
    return refuse(
      `web_fetch refused: the URL is ${url.length} characters and the limit is ${limits.maxUrlChars}. Fetch the page's plain address, or find it with web_search and fetch the result as returned.`,
    )
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null // the call's own validation answers an unparsable URL
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return refuse("web_fetch refused: the URL carries a user name or password (user:pass@host).")
  }
  const query = parsed.search.replace(/^\?/, "")
  if (query.length > limits.maxUrlQueryChars) {
    return refuse(
      `web_fetch refused: the URL's query string is ${query.length} characters and the limit is ${limits.maxUrlQueryChars}. Fetch the page without the extra parameters, or fetch a web_search result exactly as returned.`,
    )
  }
  if (opts.orgDataRead) {
    // The path and query as sent, and as decoded: an encoding never hides a pattern.
    const outbound = `${parsed.pathname}${parsed.search}`
    const decoded = safeDecode(outbound)
    if (ESCAPED_ASCII_RUN.test(outbound) || opaqueRun(outbound) || opaqueRun(decoded)) {
      return refuse(
        "web_fetch refused: the URL carries a long encoded or opaque string in its path or query. This turn read organization data, and a fetched URL leaves the organization. Fetch the page's plain address, or a web_search result exactly as returned.",
      )
    }
    const found = dataPattern(decoded, { anyLongDigitRun: false })
    if (found) {
      return refuse(
        `web_fetch refused: the URL contains ${found}. This turn read organization data, and a fetched URL leaves the organization, so it may not carry personal or account data. Fetch the page's plain address, or a web_search result exactly as returned.`,
      )
    }
  }
  return null
}

/**
 * RATE within the turn: refuses when this read would pass a per-turn limit, and counts it
 * otherwise. `host` is a fetch's host (searches have none).
 */
export function takeTurnWebRead(
  reads: TurnWebReads,
  opts: { host?: string; limits?: WebReadLimits },
): WebReadRefusal | null {
  const limits = opts.limits ?? webReadLimits()
  if (reads.total >= limits.perTurn) {
    return refuse(
      `Web read refused: this turn already made ${reads.total} web searches and fetches, the limit per turn is ${limits.perTurn}. Answer from what you found, and say what is still missing.`,
    )
  }
  if (reads.consecutive >= limits.consecutive) {
    return refuse(
      `Web read refused: ${reads.consecutive} web searches and fetches in a row, the limit is ${limits.consecutive}. Work with what you found before reading more of the web.`,
    )
  }
  const host = opts.host?.toLowerCase()
  if (host && !reads.fetchHosts.has(host) && reads.fetchHosts.size >= limits.fetchHostsPerTurn) {
    return refuse(
      `web_fetch refused: this turn already fetched pages from ${reads.fetchHosts.size} different sites, the limit per turn is ${limits.fetchHostsPerTurn}. Fetch from a site already read this turn, or answer from what you found.`,
    )
  }
  reads.total++
  reads.consecutive++
  if (host) reads.fetchHosts.add(host)
  return null
}

/** A tool call that is not a web read ends a run of web reads. */
export function noteNonWebToolCall(reads: TurnWebReads): void {
  reads.consecutive = 0
}

/**
 * RATE across turns: LIAISON_WEB_READS_PER_THREAD_HOUR per conversation (or, without one, per
 * acting user) in a rolling hour. Fails closed with the real reason when Redis cannot answer.
 */
export async function takeThreadWebRead(opts: {
  orgId: string
  threadId?: string
  actorKey: string
  limits?: WebReadLimits
  redis?: Redis
}): Promise<WebReadRefusal | null> {
  const limits = opts.limits ?? webReadLimits()
  const identifier = opts.threadId
    ? `web-read:thread:${opts.orgId}:${opts.threadId}`
    : `web-read:actor:${opts.orgId}:${opts.actorKey}`
  try {
    const { checkRateLimit } = await import("~/middleware/rate-limiter")
    const client = opts.redis ?? (await import("~/lib/redis")).redis
    const result = await checkRateLimit(client, [
      { identifier, limit: limits.perThreadHour, windowSeconds: 3600 },
    ])
    if (result.allowed) return null
    const minutes = Math.max(1, Math.ceil(result.failed.retryAfterSeconds / 60))
    return refuse(
      `Web read refused: this conversation made ${limits.perThreadHour} web searches and fetches in the last hour, the limit. The next one is possible in about ${minutes} minute(s); answer from what you found meanwhile.`,
    )
  } catch (err) {
    log.error({ err, orgId: opts.orgId, threadId: opts.threadId }, "web-read rate check failed")
    return refuse(
      `Web read refused: the web-read rate limit could not be checked (${err instanceof Error ? err.message : String(err)}). Try again shortly.`,
    )
  }
}
