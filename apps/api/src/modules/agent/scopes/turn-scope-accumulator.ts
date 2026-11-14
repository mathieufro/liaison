// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-turn requiredScopes accumulator. As each tool call executes, its declared scope set
// (resolved through resolveRequiredScopes, the single resolver) is unioned into the turn's set.
// The snapshot answers only "which scopes has this turn's tool use touched so far"; telling an
// empty snapshot apart from "the computation never ran" is the message-write boundary's job.
//
// The snapshot is also what an abnormally ended turn is stamped with (turnEndRequiredScopes,
// 2026-11-03): each tool call is recorded before it runs, so the set is the turn's faithful
// record even when the turn is cut off. There is no widening to the ceiling any more.
//
// Every scope that enters the set is PROJECTED onto the read scopes it implies, and a scope that
// implies no read is dropped (taint-read-scopes.ts): a write or action scope classifies no data.
// That holds for a tool's own scopes, for an injected stamp (history, memory, skills, a caller's
// or parent's taint) alike, so the set never holds one, nor a grant wildcard (rule 10b).

import {
  resolveRequiredScopes,
  type ScopeDeclaringToolDef,
} from "~/modules/agent/scopes/required-scopes"
import type { TaintOriginRows } from "~/modules/agent/scopes/scope-taint"
import { projectTaintScopes, taintReadCatalog } from "~/modules/agent/scopes/taint-read-scopes"

export interface TurnScopeAccumulator {
  record: (toolDef: ScopeDeclaringToolDef) => void
  recordInjected: (requiredScopes: string[]) => void
  /** `recordInjected` for scopes a read's RESULT carried (a tool's `resultTaintWhen`), also kept
   *  until `takeResultScopes` so the caller can stamp them as read now. */
  recordResultScopes: (requiredScopes: string[]) => void
  /** The scopes recorded by `recordResultScopes` since the last take, cleared. */
  takeResultScopes: () => string[]
  /** Unions the stamp of the turn's OWN INSTRUCTIONS (the routine tick's prompt, the agent's
   *  skills) into the set exactly as `recordInjected` does, without counting it as org data the
   *  turn read (`readInternalData`). Writes are judged on the set, so nothing changes for them. */
  recordInstructions: (requiredScopes: string[]) => void
  /** Counts org data as read by the turn whatever its stamp (a memory row with no scope). */
  markInternalRead: () => void
  /** Has this turn read any org data: an app or kernel read, memory, a knowledge document, a
   *  customer card, another thread's messages, a caller's or parent's taint? Its own instructions
   *  and public web content are not org data. */
  readInternalData: () => boolean
  snapshot: () => string[]
  /** Where this turn's scoped reads came from: the row ids read out of one
   *  table. Backs the same-resource allowance (A46), which lets a tainted turn
   *  write back to a row it read and to no other. */
  recordOriginRows: (table: string, rowIds: readonly string[]) => void
  /** The origin rows accumulated so far, by table. */
  originRows: () => TaintOriginRows
  /** Records one `web_search` of this turn: the result URLs it returned, normalized
   *  (normalizeSearchResultUrl; an unparsable URL is not recorded), with the turn's scope set as
   *  it stood when the search ran. */
  recordSearchResults: (urls: readonly unknown[]) => void
  /** Is a fetch of `url` one of this turn's own search results, so the web-read guardrails skip
   *  its shape and payload checks? True, and the use is
   *  counted, when `url` (normalized) is a result of a search of this turn after which the turn
   *  read no new scope but the web's own, the URL was not already fetched this way this turn, and
   *  that search has exempted fewer than MAX_EXEMPT_FETCHES_PER_SEARCH fetches. */
  claimSearchResultFetch: (url: unknown) => boolean
  /** This turn's web-read counters (web-read-guardrails.ts), mutated in place by the dispatch. */
  webReads: () => TurnWebReads
}

/** How many web reads a turn made, how many in a row, and the hosts it fetched. */
export interface TurnWebReads {
  total: number
  consecutive: number
  fetchHosts: Set<string>
}

/** The scope a web search or fetch records on the turn: public web content, no org data. */
const PUBLIC_WEB_SCOPE = "kernel:agent:web"

/**
 * At most this many fetches are exempted per search. Which results the model fetches, and in
 * what order, is a choice an injected turn can steer; deduplication and this cap bound what that
 * choice can carry to a few bits.
 */
export const MAX_EXEMPT_FETCHES_PER_SEARCH = 3

/**
 * The one normalization a fetch URL is compared under against this turn's search results: the
 * fragment removed (it never leaves the client), the scheme and host lowercased. Nothing else is
 * changed: the path, the query string, the port and their percent-encoding are kept verbatim, so a
 * URL that differs from a result in any of them (an added, removed or changed parameter, an
 * extra segment) does not match. Null, so it never matches, for anything but an absolute http(s)
 * URL that parses with a plain host[:port] authority (no credentials, no backslash).
 */
export function normalizeSearchResultUrl(url: unknown): string | null {
  if (typeof url !== "string" || url === "") return null
  const hash = url.indexOf("#")
  const withoutFragment = hash === -1 ? url : url.slice(0, hash)
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/s.exec(withoutFragment)
  if (!match) return null
  const scheme = (match[1] ?? "").toLowerCase()
  const host = (match[2] ?? "").toLowerCase()
  const rest = match[3] ?? ""
  if (scheme !== "http" && scheme !== "https") return null
  // Only a plain ASCII host[:port]: anything else in the authority (credentials, a backslash the
  // URL parser reads as a path separator, an encoded or non-ASCII host) is never matched, so the
  // lowercasing above can only ever touch the host itself.
  if (!/^[a-z0-9.-]+(:[0-9]+)?$|^\[[0-9a-f:.]+\](:[0-9]+)?$/.test(host)) return null
  if (!URL.canParse(withoutFragment)) return null
  return `${scheme}://${host}${rest}`
}

/**
 * `orgId`, when known, widens the projection's catalog with that org's installed apps (a
 * `:write` scope of an app outside the build lands on its read sibling instead of dropping).
 */
export function createTurnScopeAccumulator(opts: { orgId?: string } = {}): TurnScopeAccumulator {
  const scopes = new Set<string>()
  // INTERNAL DATA (2026-10-27, owner ruling). An outward web read (web_fetch, web_search) can leak
  // only what the turn holds, so its payload guardrails apply only once the turn read org data
  // (web-read-guardrails.ts; a web read never parks, scope-taint.ts rule 9). Kept apart from
  // `scopes`, which also carries the stamps of the turn's own instructions (a routine tick's
  // prompt is stamped with the tick's whole effective scope). Fails closed: a tool call that
  // records no scope at all, or any scope but the public web's, counts as org data.
  let internal = false
  const countsAsOrgData = (projected: readonly string[]): boolean =>
    projected.some((scope) => scope !== PUBLIC_WEB_SCOPE)
  const origins = new Map<string, Set<string>>()
  const resultScopes = new Set<string>()
  let catalog: string[] | undefined
  // This turn's own searches: each one's result URLs, the scopes the turn held when it ran, and
  // how many fetches it has exempted. Per turn by construction: a new turn builds a new
  // accumulator, so a result from a previous turn's search never matches.
  const searches: Array<{ urls: Set<string>; scopesAtSearch: Set<string>; exempted: number }> = []
  // The result URLs already fetched as exempt this turn: each is exempt once.
  const claimedUrls = new Set<string>()
  const webReads: TurnWebReads = { total: 0, consecutive: 0, fetchHosts: new Set() }
  const project = (raw: readonly string[]): string[] => {
    if (raw.length === 0) return []
    catalog ??= taintReadCatalog(opts.orgId)
    return projectTaintScopes(raw, catalog)
  }
  const inject = (requiredScopes: string[]): string[] => {
    const projected = project(requiredScopes)
    if (countsAsOrgData(projected)) internal = true
    for (const scope of projected) scopes.add(scope)
    return projected
  }
  return {
    record(toolDef) {
      const projected = project(resolveRequiredScopes(toolDef))
      if (projected.length === 0 || countsAsOrgData(projected)) internal = true
      for (const scope of projected) scopes.add(scope)
    },
    // Filled by the slice that adds requiredScopes columns to agent_memory/messages and reads
    // them in assembleContext (spec-security.md D5). Unions an already-resolved requiredScopes
    // array, e.g. from an injected agent_memory row, knowledge document, thread-search result
    // or prior message read as history, into the same accumulated set as record().
    recordInjected: inject,
    recordResultScopes(requiredScopes) {
      for (const scope of inject(requiredScopes)) resultScopes.add(scope)
    },
    takeResultScopes() {
      const taken = [...resultScopes].sort()
      resultScopes.clear()
      return taken
    },
    recordInstructions(requiredScopes) {
      for (const scope of project(requiredScopes)) scopes.add(scope)
    },
    markInternalRead() {
      internal = true
    },
    readInternalData() {
      return internal
    },
    snapshot() {
      return [...scopes].sort()
    },
    // The origin rows are additive and never reset.
    recordOriginRows(table, rowIds) {
      if (!table) return
      let seen = origins.get(table)
      if (!seen) {
        seen = new Set<string>()
        origins.set(table, seen)
      }
      for (const id of rowIds) if (typeof id === "string" && id !== "") seen.add(id)
    },
    originRows() {
      const out: Record<string, string[]> = {}
      for (const [table, ids] of origins) out[table] = [...ids].sort()
      return out
    },
    recordSearchResults(urls) {
      const recorded = new Set<string>()
      for (const url of urls) {
        const normalized = normalizeSearchResultUrl(url)
        if (normalized) recorded.add(normalized)
      }
      if (recorded.size === 0) return
      searches.push({ urls: recorded, scopesAtSearch: new Set(scopes), exempted: 0 })
    },
    claimSearchResultFetch(url) {
      const normalized = normalizeSearchResultUrl(url)
      if (normalized === null || claimedUrls.has(normalized)) return false
      const search = searches.find(
        (s) =>
          s.urls.has(normalized) &&
          s.exempted < MAX_EXEMPT_FETCHES_PER_SEARCH &&
          [...scopes].every((scope) => scope === PUBLIC_WEB_SCOPE || s.scopesAtSearch.has(scope)),
      )
      if (!search) return false
      search.exempted++
      claimedUrls.add(normalized)
      return true
    },
    webReads() {
      return webReads
    },
  }
}
