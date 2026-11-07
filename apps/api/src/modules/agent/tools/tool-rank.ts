// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The keyword ranker behind `tool_search` and the MCP gateway's
 * `liaison_tool_search`. Pure: it reads the catalog it is handed and imports
 * nothing with a side effect, so a test can run it over the real catalog with
 * no server.
 */

/** The app whose tools connect any outside system (see creditOutsideSystemNames). */
export const CONNECTOR_APP = "api-connector"

/** Lower case with accents gone, so "réclamation" and "reclamation" are one word. */
function foldSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
}

/**
 * One query word, folded. A word under 3 letters stays as typed: folded, "à" or
 * "où" would become a substring of most tool names, where as typed it matches
 * none of them.
 */
function foldSearchTerm(term: string): string {
  const folded = foldSearchText(term)
  return folded.length < 3 ? term.toLowerCase() : folded
}

/**
 * The shortest query word matched as the start of a longer word: a name part
 * ("sub" in `subagent_create`), an app's name or a description word. Never the
 * middle of a word: "du" is not in "duplicates", "la" not in "pennylane",
 * "done" not in "abandoned". A shorter word matches only a whole name part, a
 * keyword or an app's name.
 */
const MIN_SUBSTRING_TERM = 3

function substringOk(term: string): boolean {
  return term.length >= MIN_SUBSTRING_TERM
}

/** What a word found only in a tool's description scores. */
const DESCRIPTION_SCORE = 2

interface ScoringWords {
  nameParts: string[]
  keywords: string[] | undefined
  appLower: string
  appParts: string[]
  descWords: string[]
}

/**
 * A tool's words, folded once per tool row rather than once per query word.
 * Keyed by the row object: a catalog listing builds fresh rows, so a changed
 * description never meets an old entry.
 */
const scoringWordsCache = new WeakMap<ScorableDeferredTool, ScoringWords>()

function scoringWords(t: ScorableDeferredTool): ScoringWords {
  const cached = scoringWordsCache.get(t)
  if (cached) return cached
  const appLower = t.appName.toLowerCase()
  const words: ScoringWords = {
    // camelCase splits too: `bulkDeactivateUsers` is bulk, deactivate, users.
    nameParts: t.toolName
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .split(/[^a-z0-9]+/),
    keywords: t.keywords?.map(foldSearchText),
    appLower,
    appParts: appLower.split(/[^a-z0-9]+/),
    descWords: foldSearchText(t.description).split(/[^\p{L}\p{N}]+/u),
  }
  scoringWordsCache.set(t, words)
  return words
}

/** The minimal shape the keyword scorer needs from a deferred-tool row. */
export interface ScorableDeferredTool {
  toolName: string
  appName: string
  description: string
  /**
   * Words the tool answers to beyond its name, weighed almost like a name part:
   * a connector tool's operation names and connected system ("add_company_note",
   * "crm"), which its static description cannot know.
   */
  keywords?: readonly string[]
}

/**
 * Tokenized keyword scoring shared by the in-agent `tool_search` and the MCP
 * gateway's `liaison_tool_search`. Tokenizes the query on the separators models
 * (and humans) actually type — whitespace, `,` `:` `.` `/` `_` `-` — so
 * "create skill" matches `create_skill` instead of requiring the exact
 * underscore form (the naive single-substring match this replaces made the
 * MCP discovery search return nothing for it).
 */
export function scoreDeferredTools<T extends ScorableDeferredTool>(
  tools: readonly T[],
  query: string,
  /** The org's app names, so a kernel tool is not held to match the app it acts on. */
  opts?: { appNames?: Iterable<string> },
): Array<{ tool: T; score: number; termsMatched: number; termCount: number }> {
  let terms = query
    .toLowerCase()
    .split(/[\s,:./_'’-]+/)
    .filter(Boolean)
    .map(foldSearchTerm)
  const appTerms = new Set([...(opts?.appNames ?? [])].map((n) => n.toLowerCase()))
  // Filler words ("an", "de") name nothing, so a tool is not held to match
  // them, unless the query is nothing but filler.
  const named = terms.filter((term) => !FILLER_WORDS.has(term))
  if (named.length > 0) terms = named
  return tools.map((t) => {
    let score = 0
    let termsMatched = 0
    let termCount = 0
    const { nameParts, keywords, appLower, appParts, descWords } = scoringWords(t)
    const isKernel = t.appName === "kernel"

    for (const term of terms) {
      const before = score
      // Exact name part match (high weight); a singular term also names its
      // plural part ("app" names `apps_set_enabled`).
      if (nameParts.some((p) => p === term || p === `${term}s`)) score += 10
      // A keyword the tool declares for this org (singular or plural either way)
      else if (keywords?.some((k) => k === term || k === `${term}s` || `${k}s` === term)) score += 8
      // Partial name match: the start of a name part ("invoice" in `invoices`),
      // never the middle of one ("done" is not in `abandoned`).
      else if (substringOk(term) && nameParts.some((p) => p.startsWith(term))) score += 5
      // App name match
      else if (appLower === term || (substringOk(term) && appParts.some((p) => p.startsWith(term))))
        score += 6
      // Description match (lower weight), at the start of a word
      else if (substringOk(term) && descWords.some((w) => w.startsWith(term)))
        score += DESCRIPTION_SCORE
      if (score > before) termsMatched++
      // Another app's name is the ARGUMENT of a kernel tool, which acts on
      // apps ("turn the social app off"), not a term the tool must match.
      else if (isKernel && appTerms.has(term)) continue
      termCount++
    }

    return { tool: t, score, termsMatched, termCount }
  })
}

/**
 * The matches a keyword search LOADS, as opposed to lists. A query for
 * `mail:read` used to load its five padded hits: mail__read and then
 * google-drive__read, database__db_read, gitlab__gitlab_read_file and
 * mail__listAccounts, each of those a whole app whose full instruction guide
 * then rode in the cached prefix for the life of the thread. A strong match
 * satisfies EVERY query term and ties the best score; the rest stay listed,
 * one direct call or one `select:` away. A bare app name is a request for that
 * app's whole surface, so every usable hit is strong.
 */
export function strongMatches<T extends { score: number; termsMatched: number; termCount: number }>(
  scored: readonly T[],
  wholeAppQuery: boolean,
): T[] {
  if (wholeAppQuery) return [...scored]
  const top = scored.reduce((best, s) => Math.max(best, s.score), 0)
  // A tool whose every word was found only in its description is listed, not
  // loaded: "signature" loaded a mail-inbox setter for the word in its prose.
  return scored.filter(
    (s) =>
      s.score === top &&
      s.termsMatched === s.termCount &&
      s.score > DESCRIPTION_SCORE * s.termCount,
  )
}

/** Words of a request that name no capability ("connect OUR crm"). */
const FILLER_WORDS = new Set([
  ..."a an the our my your their its it we us i you me to for of in on at with and or from please can could would some do does what how is are be this that".split(
    " ",
  ),
  // French. Words under 3 letters are compared as typed, so "à" and "où" keep their accent.
  ..."le la les l d de du des un une et ou au aux en pour par sur dans avec sans mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs ce cet cette ces qui que quoi est sont je tu il elle on nous vous ils elles me te se y à moi toi lui tout tous toute toutes stp svp peux pouvez".split(
    " ",
  ),
])

/** What a word must score alone to be kept: a tool's name part (10) or keyword (8). */
const NAMED_TERM_SCORE = 8

/**
 * The query a keyword search scores with. A strong match must satisfy every
 * term, so "connect our CRM" loaded nothing for want of "our", and a weak model
 * concluded the capability was missing. Filler words and words no tool answers
 * to at all (a vendor's name: "connect HubSpot") are dropped, but only when
 * every word kept NAMES a tool (a name part or a keyword) or an installed app:
 * a word found only in descriptions ("post" in "post to facebook" with the
 * social app off) must not load whatever mentions it. Null: the query is
 * scored as typed. `outside` holds the dropped words no tool answers to: the
 * name of a system Liaison has no app for (creditOutsideSystemNames).
 */
function loadingTerms(
  tools: readonly ScorableDeferredTool[],
  terms: readonly string[],
  appNames: Iterable<string>,
): { query: string; outside: string[] } | null {
  const apps = [...appNames].map((a) => a.toLowerCase())
  const best = (term: string) =>
    Math.max(0, ...scoreDeferredTools(tools, term, { appNames: apps }).map((s) => s.score))
  const kept = terms.filter((term) => !FILLER_WORDS.has(term) && best(term) > 0)
  if (kept.length === 0 || kept.length === terms.length) return null
  const named = kept.every((term) => best(term) >= NAMED_TERM_SCORE || apps.includes(term))
  if (!named) return null
  const outside = terms.filter((term) => !FILLER_WORDS.has(term) && !kept.includes(term))
  return { query: kept.join(" "), outside }
}

/**
 * A word no tool answers to is the name of a system Liaison has no app for
 * ("connect HubSpot"), and the API connector is the app that connects any such
 * system: its tools answer to that name as a keyword, exactly as they answer
 * to the name of a system already connected (withConnectorHints). So a
 * connector tool is scored on the kept words plus that name, every other tool
 * on the kept words alone. Without it, dropping the name left "connect", and
 * the tool with "connect" in its own name (sending a member a link for their
 * own Gmail) outscored the adapter save that connects the system named.
 */
function creditOutsideSystemNames<T extends ScorableDeferredTool>(
  scored: Array<{ tool: T; score: number; termsMatched: number; termCount: number }>,
  loading: { query: string; outside: string[] },
  appNames: Iterable<string>,
): Array<{ tool: T; score: number; termsMatched: number; termCount: number }> {
  if (loading.outside.length === 0) return scored
  const query = [loading.query, ...loading.outside].join(" ")
  return scored.map((s) => {
    if (s.tool.appName !== CONNECTOR_APP) return s
    const credited = { ...s.tool, keywords: [...(s.tool.keywords ?? []), ...loading.outside] }
    const [rescored] = scoreDeferredTools([credited], query, { appNames })
    return { ...rescored, tool: s.tool }
  })
}

/**
 * One keyword search over a catalog: the tools to list, best first, and which of
 * them the search LOADS. A usable tool always ranks above a locked one. `appNames`
 * is the org's apps (On or Off, without the kernel); `cap` the hits to list.
 */
export function rankDeferredTools<
  T extends ScorableDeferredTool & { sdkName: string; locked?: boolean },
>(
  catalog: readonly T[],
  query: string,
  opts: { cap: number; appNames: Iterable<string> },
): {
  ranked: Array<{ tool: T; score: number; termsMatched: number; termCount: number }>
  /** Every tool that scored, best first: `ranked` is its head. */
  all: Array<{ tool: T; score: number; termsMatched: number; termCount: number }>
  strongNames: Set<string>
  /** The app a bare app-name query asked for, or null. */
  wholeApp: string | null
} {
  // An apostrophe splits too: French elides "de" and "le" ("d'approbation").
  // Tokenized on the separators models actually type (`tickets:reply`,
  // `tickets.reply`, `mail/compose`): whitespace-only splitting scored those
  // queries 0 against everything and dumped the agent into the catalog fallback.
  const terms = query
    .toLowerCase()
    .split(/[\s,:./'’]+/)
    .filter(Boolean)
    .map(foldSearchTerm)

  // A query that names an app exactly (e.g. "tickets") means "show me this
  // app's tools": return ALL of them (up to the hard cap) instead of an
  // arbitrary cap-sized slice of a same-score tie. The tie slice is how
  // `tickets__reply` got crowded out by search/get/create/addNote/assign.
  const catalogApps = new Set(catalog.map((t) => t.appName.toLowerCase()))
  const wholeAppQuery = terms.length === 1 && catalogApps.has(terms[0])
  const effectiveCap = wholeAppQuery ? Math.max(opts.cap, 20) : opts.cap

  const loading = loadingTerms(catalog, terms, opts.appNames)
  const scored = loading
    ? creditOutsideSystemNames(
        scoreDeferredTools(catalog, loading.query, { appNames: opts.appNames }),
        loading,
        opts.appNames,
      )
    : scoreDeferredTools(catalog, query, { appNames: opts.appNames })

  const all = scored
    .filter((s) => s.score > 0)
    // Available tools first, then locked ones (so a usable tool is never crowded out of
    // the cap by a locked one), each group by descending score.
    .sort((a, b) => {
      const al = a.tool.locked ? 1 : 0
      const bl = b.tool.locked ? 1 : 0
      if (al !== bl) return al - bl
      return b.score - a.score
    })
  const ranked = all.slice(0, effectiveCap)

  // Words that name no capability ("what can you do") load nothing, however many
  // descriptions happen to contain them. They still list.
  const namesNothing = terms.every((term) => FILLER_WORDS.has(term))
  const strongNames = new Set(
    namesNothing ? [] : strongMatches(ranked, wholeAppQuery).map((s) => s.tool.sdkName),
  )
  return { ranked, all, strongNames, wholeApp: wholeAppQuery ? terms[0] : null }
}
