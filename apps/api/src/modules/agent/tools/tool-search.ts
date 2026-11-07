// SPDX-License-Identifier: FSL-1.1-ALv2
import type { UserContext } from "~/db/rls"
import {
  connectorSearchHints,
  loadConnectedSystems,
} from "~/modules/agent/context/connected-systems"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { turnToolScopes } from "~/modules/agent/scopes/effective-scope"
import { listDeferredTools } from "~/modules/agent/tools/tool-bridge"
import {
  CONNECTOR_APP,
  rankDeferredTools,
  type ScorableDeferredTool,
  scoreDeferredTools,
} from "~/modules/agent/tools/tool-rank"
import { toolRegistry } from "~/modules/apps/app-registries"
import { ensureOrgToolLists } from "~/modules/mcp-client/index"

export { scoreDeferredTools }

/**
 * The SDK name of a tool THIS turn can call right now without a search (in
 * its own tool set, not one of the deferred ones) whose name matches `wanted`
 * (compared by `key`), or null. A bare tool name is looked up in the kernel.
 * Judged on the turn's own built tool set: its scopes, hidden apps, read-only
 * and allowlist filters already applied, so a tool the turn cannot call is
 * never announced as loaded. No set on the frame, no claim.
 */
function loadedToolNamed(
  turnToolNames: ReadonlySet<string> | undefined,
  deferred: ReadonlySet<string>,
  wanted: string,
  key: (s: string) => string,
): string | null {
  if (!turnToolNames) return null
  for (const sdkName of turnToolNames) {
    if (deferred.has(sdkName)) continue
    if (key(sdkName) === wanted) return sdkName
    if (sdkName.startsWith("kernel__") && key(sdkName.slice("kernel__".length)) === wanted)
      return sdkName
  }
  return null
}

/**
 * The kernel-tool ctx the real dispatch hands every handler: the `AppContext`
 * built by `createAppContext`, of which this reads the org, the calling user
 * and `scopes` (the actor's scopes, injected by execute-tool). There is NO
 * `actor` on it: an earlier version read `ctx.actor`, which production never
 * set, so every match came back usable and nothing was ever flagged locked.
 */
interface ToolSearchContext {
  orgId: string
  userId?: string
  scopes?: string[]
}

interface ToolSearchResult {
  matches: Array<{
    name: string
    appName: string
    description: string
    // Present + true when the tool EXISTS but the actor lacks the RBAC scope to use it.
    // `requiredScope` is the exact scope to request via request_scope. Surfacing these
    // (rather than silently omitting them) is what stops a weak agent from FABRICATING
    // that it performed a scope-locked action it never could. [[BL-254]] / DECISIONS l500.
    locked?: boolean
    requiredScope?: string
    // Present + true when the tool is CALLABLE only inside a routine tick (web_watch /
    // watch_state). Discoverable here so the routine-authoring agent learns it exists and
    // references it in the routine PROMPT; it cannot be called directly from chat.
    routineOnly?: boolean
  }>
  query: string
  totalDeferredTools: number
  // True when the keyword query matched NOTHING but deferred tools exist, so `matches` is the
  // available deferred catalog (capped) rather than scored keyword hits — a present tool is never
  // invisible behind an imperfect query. The agent should enumerate these, not declare the
  // capability absent. (tool-ergonomics — marco-bulk-import-carrier-rate-sheet.)
  fellBackToCatalog?: boolean
  // With fellBackToCatalog: the apps whose tools this search reads, by name, with
  // how many tools each has. Nothing is listed as a tool and nothing is loaded,
  // so a weak model cannot take an unrelated sample tool for an answer.
  apps?: Array<{ name: string; tools: number }>
  // Present when usable matches were just LOADED into the run's tool set — tells the model
  // (weak ones especially) it can now call them directly instead of re-searching or refusing.
  note?: string
}

/** "it" or "them", for a note naming `n` tools. */
function itOrThem(n: number): string {
  return n === 1 ? "it" : "them"
}

/**
 * Discovery side-effect: every USABLE match tool_search returns is unlocked for
 * the rest of the run — added to the run frame's `discoveredTools`, which the
 * agent loop's `prepareStep` folds into `activeTools` on the next step (and the
 * chat service persists per-thread). A tool registered after the run built its
 * tool set (an MCP server's list arriving with this search's own dial) joins
 * the set first (`admitTools`), so "call it now" is true on the next step of
 * THIS turn; a match the run still cannot hold is never announced as loaded.
 * Locked matches (missing scope) and routine-only tools are surfaced but never
 * unlocked. Outside a run frame (MCP gateway, direct API) this is a no-op —
 * those callers manage their own state.
 */
function unlockMatches(
  matches: Array<{ name: string; locked?: boolean; routineOnly?: boolean }>,
  /** Matches shown but NOT loaded (weak keyword hits): named so the model knows the door. */
  listedOnly: Array<{ name: string }> = [],
): string | undefined {
  const frame = currentRunContext()
  const discovered = frame?.discoveredTools
  if (!discovered) return undefined
  const usable = matches.filter((m) => !m.locked && !m.routineOnly).map((m) => m.name)
  const callable = frame?.admitTools ? frame.admitTools(usable) : new Set(usable)
  const unlocked: string[] = []
  const already: string[] = []
  const unavailable: string[] = []
  for (const name of usable) {
    if (!callable.has(name)) unavailable.push(name)
    else if (discovered.has(name)) already.push(name)
    else {
      discovered.add(name)
      unlocked.push(name)
    }
  }
  const notLoaded = listedOnly.filter((m) => !discovered.has(m.name)).map((m) => m.name)
  const parts: string[] = []
  if (unlocked.length > 0) {
    // Asked for: a tool an earlier turn listed by name only gets its schema
    // in the next note too.
    frame?.fixedToolList?.requestSchemas?.(unlocked)
    parts.push(
      `LOADED: ${unlocked.join(", ")}. ${howToCall(unlocked, "now")} Do not search for ${itOrThem(unlocked.length)} again.`,
    )
  }
  if (already.length > 0) parts.push(alreadyLoadedNote(already))
  if (unavailable.length > 0) {
    parts.push(
      `Not available to you in this turn: ${unavailable.join(", ")}. Say so rather than searching again.`,
    )
  }
  if (parts.length === 0 && notLoaded.length > 0) {
    parts.push("Nothing loaded: no listed match satisfied every term of the query.")
  }
  if (notLoaded.length > 0) {
    parts.push(
      `Listed but NOT loaded: ${notLoaded.join(", ")}; call one directly or query "select:<name>" to load it.`,
    )
  }
  return parts.length > 0 ? parts.join(" ") : undefined
}

/**
 * Load the named deferred tools into this run, as a tool result that hands the
 * next step does: the step it names is then one call away, not a search. Only
 * tools the turn may call are loaded (its scopes, Off apps and filters, judged
 * as `tool_search` judges them); the note says what was loaded and what is not
 * available. Outside a run frame it loads nothing and says nothing.
 */
export async function loadToolsForNextStep(
  ctx: ToolSearchContext,
  sdkNames: readonly string[],
): Promise<string | undefined> {
  if (!currentRunContext()?.discoveredTools) return undefined
  const actor: UserContext = {
    actorType: "user",
    userId: ctx.userId ?? "",
    orgId: ctx.orgId,
    scopes: turnToolScopes(ctx.scopes ?? [], currentRunContext()),
    dimensionGrants: {},
  }
  const catalog = new Map(
    listDeferredTools(ctx.orgId, actor, "agent", true).map((t) => [t.sdkName, t] as const),
  )
  const matches = sdkNames.map((name) => {
    const t = catalog.get(name)
    // A deferred tool the turn cannot see at all (an Off app, no such tool)
    // is reported as not available, like a locked one.
    return t ? { name, ...(t.locked ? { locked: true } : {}) } : { name, locked: true }
  })
  const note = unlockMatches(matches)
  const unavailable = matches.filter((m) => m.locked).map((m) => m.name)
  return (
    [
      note,
      unavailable.length > 0
        ? `Not available to you in this turn: ${unavailable.join(", ")} (a missing scope or an app that is off). Say so in plain words; an administrator can do this step.`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ") || undefined
  )
}

/**
 * What a search for tools the turn already holds answers: their exact names,
 * call now. Naming them in a search is asking for them: a tool loaded by name
 * only gets its schema in the note after this step (requestSchemas).
 */
function alreadyLoadedNote(names: readonly string[]): string {
  const unique = [...new Set(names)]
  currentRunContext()?.fixedToolList?.requestSchemas?.(unique)
  return `ALREADY LOADED: ${unique.join(", ")}. ${howToCall(unique, "now")} No search needed.`
}

/**
 * How the loaded `names` are called. On a thread with a fixed tool list
 * (providers/fixed-tool-list.ts) a tool loaded after the list was set is not
 * in it: it is called through kernel__call_tool, and its description and
 * parameters come in the note after this result (guide-notes.ts).
 */
function howToCall(names: readonly string[], when: string): string {
  const listed = currentRunContext()?.fixedToolList?.listed
  const direct = listed ? names.filter((n) => listed.has(n)) : [...names]
  const viaEntry = listed ? names.filter((n) => !listed.has(n)) : []
  const out: string[] = []
  if (direct.length > 0) {
    out.push(
      `Call ${direct.length === names.length ? itOrThem(direct.length) : direct.join(", ")} ${when} by ${direct.length === 1 ? "this exact name" : "these exact names"}.`,
    )
  }
  if (viaEntry.length > 0) {
    out.push(
      `${viaEntry.length === names.length ? (viaEntry.length === 1 ? "It is" : "They are") : `${viaEntry.join(", ")} ${viaEntry.length === 1 ? "is" : "are"}`} not in your tool list: call ${viaEntry.length === 1 ? "it" : "each"} ${when} through kernel__call_tool with {"name": "<exact name>", "arguments": {...}}; ${viaEntry.length === 1 ? "its" : "their"} description and parameters are in a "tools just loaded" note in this conversation.`,
    )
  }
  return out.join(" ")
}

/**
 * True when every usable tool a search would load is already loaded for this
 * run (and callable). Such a search loads nothing new, so it does not count
 * toward the per-turn search limit: it answers with the exact names instead.
 */
function allAlreadyLoaded(
  matches: ReadonlyArray<{ name: string; locked?: boolean; routineOnly?: boolean }>,
): boolean {
  const frame = currentRunContext()
  const discovered = frame?.discoveredTools
  if (!discovered) return false
  const usable = matches.filter((m) => !m.locked && !m.routineOnly).map((m) => m.name)
  if (usable.length === 0) return false
  if (!usable.every((n) => discovered.has(n))) return false
  const callable = frame?.admitTools ? frame.admitTools(usable) : new Set(usable)
  return usable.every((n) => callable.has(n))
}

/** Mark a locked tool's description so the agent (and, via its reply, the chat UI / persona /
 *  judge) sees the capability exists but is permission-blocked, plus the exact next step. */
function describeLocked(description: string, scope: string): string {
  return `🔒 LOCKED — you do NOT have the "${scope}" scope this tool requires. Do NOT call it, pretend you used it or fabricate its result; tell the user in ordinary words which access is missing (never the scope string or the tool name) and offer kernel__request_scope, which takes "${scope}". ${description}`
}

/** Mark a routine-only tool's description so the authoring agent understands it is REFERENCED in a
 *  routine prompt (it runs inside the routine's ticks) — NOT callable from this chat turn. This is
 *  what lets a weak agent learn the real stateful-diff path (web_watch + per-routine watermark)
 *  exists and author a routine prompt around it, instead of improvising a manual dedup workaround. */
function describeRoutineOnly(description: string): string {
  return `⏱ ROUTINE-ONLY — this tool runs INSIDE a routine tick, not in this chat. You CANNOT call it here; instead, REFERENCE it in the prompt of a kernel__create_routine you author (the routine's ticks will call it). ${description}`
}

// Hard limits on what a tool-search RESULT may carry. Discovery is an index,
// not a schema dump: a broad query ("update knowledge document") used to return
// every score>0 tool with its full multi-KB description over MCP — ~100KB in
// one result, blowing the client's tool-result token cap and forcing a
// spill-to-file. The full schema/description still reaches the client through
// the normal catalog surfacing (tools/list after discovery); the search result
// itself stays a compact, grep-able list.
export const TOOL_SEARCH_MAX_RESULTS = 20
export const TOOL_SEARCH_BYTE_BUDGET = 6_000
export const TOOL_SEARCH_SYNOPSIS_CHARS = 140

/**
 * Tool searches a demo visitor's turn may make. A weak model on a turn whose
 * tools were not loaded searched again and again (one live demo turn: eight
 * searches, two of them `select:` with a near-miss name, and no write) until
 * the turn's steps or time ran out. Past the limit a search unlocks nothing
 * more; it still names the tools that exist but are locked. Other orgs have
 * no limit: a request across several apps needs a search per app, and their
 * turns have no step budget for the loop to burn.
 */
export const TOOL_SEARCH_LIMIT_PER_TURN = 6

/** How many loaded tool names the over-the-limit answer lists. */
const LOADED_TOOLS_LISTED = 60

/** One-line synopsis of a tool description: whitespace-flattened, hard-capped. */
export function toolSynopsis(description: string, max = TOOL_SEARCH_SYNOPSIS_CHARS): string {
  const flat = description.replace(/\s+/g, " ").trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 3).trimEnd()}...`
}

export interface CompactToolHit {
  name: string
  description: string
  score: number
}

/**
 * Project scored matches (already filtered to score>0 and sorted best-first)
 * into the compact index the MCP gateway returns: per hit only
 * { name, one-line description, score }, capped by count AND total bytes, with
 * an honest note when matches were dropped.
 */
export function compactToolSearchResult(
  scored: ReadonlyArray<{ tool: { sdkName: string; description: string }; score: number }>,
  opts?: { maxResults?: number; byteBudget?: number },
): { tools: CompactToolHit[]; totalMatches: number; note?: string } {
  const maxResults = opts?.maxResults ?? TOOL_SEARCH_MAX_RESULTS
  const byteBudget = opts?.byteBudget ?? TOOL_SEARCH_BYTE_BUDGET
  const tools: CompactToolHit[] = []
  let bytes = 0
  for (const s of scored) {
    if (tools.length >= maxResults) break
    const hit: CompactToolHit = {
      name: s.tool.sdkName,
      description: toolSynopsis(s.tool.description),
      score: s.score,
    }
    const hitBytes = JSON.stringify(hit).length + 1
    if (tools.length > 0 && bytes + hitBytes > byteBudget) break
    tools.push(hit)
    bytes += hitBytes
  }
  const omitted = scored.length - tools.length
  return {
    tools,
    totalMatches: scored.length,
    ...(omitted > 0
      ? {
          note: `${omitted} more matches not shown, refine your query to narrow the results. Each shown tool is now in tools/list with its full schema, call it by its exact name.`,
        }
      : {}),
  }
}

/** Every app with a tool registered for the org, On or Off, hot or deferred. */
function orgAppNames(orgId: string): Set<string> {
  const names = new Set<string>()
  for (const [key] of toolRegistry.entriesOf(orgId)) names.add(key[1])
  names.delete("kernel")
  return names
}

/**
 * The connector tools with this org's connections folded in: the operation
 * names and system as keywords, and a summary leading the description, given
 * enough synopsis room to survive the cut.
 */
function withConnectorHints<T extends ScorableDeferredTool>(
  tools: T[],
  hints: Map<string, { keywords: string[]; summary: string }>,
): Array<T & { synopsisChars?: number }> {
  if (hints.size === 0) return tools
  return tools.map((t) => {
    const hint = t.appName === CONNECTOR_APP ? hints.get(t.toolName) : undefined
    if (!hint) return t
    return {
      ...t,
      keywords: [...(t.keywords ?? []), ...hint.keywords],
      description: `${hint.summary} ${t.description}`,
      synopsisChars: Math.min(Math.max(TOOL_SEARCH_SYNOPSIS_CHARS, hint.summary.length + 80), 480),
    }
  })
}

/**
 * Search deferred (app) tools by name or keyword. Returns matching tools
 * so the model can discover and use them on demand.
 *
 * Follows the Claude Code ToolSearch pattern:
 * - "select:tool_name1,tool_name2" → direct selection by name
 * - keyword search → searches tool names and descriptions
 */
export async function handleToolSearch(
  params: { query: string; maxResults?: number },
  ctx: ToolSearchContext,
): Promise<ToolSearchResult> {
  const { query, maxResults = 5 } = params
  const cap = Math.min(maxResults, 20)

  // THE PER-TURN LIMIT, on a demo visitor's turn only (counted on its run
  // frame). Applied below, once the catalog is known, so a locked tool is
  // still named past it.
  // A search for tools the turn already holds loads nothing, so it answers
  // with their exact names and is not counted: a weak model re-searched
  // loaded tools until the limit, then said it could not run them.
  const frame = currentRunContext()
  const overLimit =
    frame?.visitorTurn === true && (frame.toolSearchCount ?? 0) >= TOOL_SEARCH_LIMIT_PER_TURN
  const countSearch = () => {
    if (frame?.visitorTurn) frame.toolSearchCount = (frame.toolSearchCount ?? 0) + 1
  }

  // includeLocked: surface tools the actor lacks scope for (flagged locked) so a missing
  // permission is a VISIBLE signal at discovery time, not a silent omission the agent
  // papers over with a fabricated result. [[BL-254]] / DECISIONS l500.
  // Judged against the TURN's scope (ceiling ∩ grants), not the actor's alone:
  // a tool outside the acting agent's ceiling is refused at call time, so
  // reporting it as usable ("LOADED") told the agent it could do what it could
  // not, and the refusal that followed read as a failure to cover up.
  const actor: UserContext = {
    actorType: "user",
    userId: ctx.userId ?? "",
    orgId: ctx.orgId,
    scopes: turnToolScopes(ctx.scopes ?? [], currentRunContext()),
    dimensionGrants: {},
  }
  // An MCP connection last dialed before its tool list was stored gets its one dial now
  // (bounded wait), so its tools are in the catalogue this search reads.
  await ensureOrgToolLists(ctx.orgId)
  const allDeferred = withConnectorHints(
    listDeferredTools(ctx.orgId, actor, "agent", true),
    connectorSearchHints(await loadConnectedSystems(ctx.orgId, actor.scopes ?? [])),
  )

  // Discovery result = index, not schema dump: the base description is cut to a
  // one-line synopsis (the full description arrives with the tool itself once
  // loaded). The locked/routine-only behavioral prefixes are added AFTER the
  // cut so they always survive intact.
  const toMatch = (t: (typeof allDeferred)[number]) => {
    const short = toolSynopsis(t.description, t.synopsisChars)
    return {
      name: t.sdkName,
      appName: t.appName,
      description: t.locked
        ? describeLocked(short, t.requiredScope ?? "?")
        : t.routineOnly
          ? describeRoutineOnly(short)
          : short,
      ...(t.locked ? { locked: true, requiredScope: t.requiredScope } : {}),
      ...(t.routineOnly ? { routineOnly: true } : {}),
    }
  }

  // Past the limit: no tool is unlocked, but a tool that exists and is
  // locked is still named, so a missing permission stays a visible fact
  // rather than a gap the agent fills with a made-up result.
  const overLimitAnswer = (): ToolSearchResult => {
    const selectKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "")
    const selectNames = query.startsWith("select:")
      ? query.slice("select:".length).split(",").map(selectKey).filter(Boolean)
      : null
    const locked = allDeferred.filter((t) => t.locked)
    const lockedMatches = (
      selectNames
        ? locked.filter((t) =>
            selectNames.some((n) => selectKey(t.toolName) === n || selectKey(t.sdkName) === n),
          )
        : scoreDeferredTools(locked, query)
            .filter((s) => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((s) => s.tool)
    )
      .slice(0, cap)
      .map(toMatch)
    const loaded = [...(frame?.discoveredTools ?? [])].sort()
    const listed = loaded.slice(0, LOADED_TOOLS_LISTED)
    return {
      matches: lockedMatches,
      query,
      totalDeferredTools: allDeferred.length,
      note:
        `Search limit reached: this turn has already searched for tools ${TOOL_SEARCH_LIMIT_PER_TURN} times, so no more tools were loaded. ` +
        (lockedMatches.length > 0
          ? "The matches shown exist but are LOCKED: this turn lacks the scope they need, so say so instead of doing their work another way. "
          : "") +
        (listed.length > 0
          ? `The app tools loaded for this turn are: ${listed.join(", ")}${loaded.length > listed.length ? ", and more" : ""}. `
          : "") +
        "Call one of the tools you have now, or answer with what you have and say what you could not do.",
    }
  }

  // Direct selection: "select:tool1,tool2". Models write tool names in every
  // separator style — `tickets__reply`, `tickets:reply`, `tickets.reply`, bare
  // `reply` — so match on a normalized form (any separator run → `__`), not the
  // literal string. A near-miss select that returns [] sends a weak model into
  // a blind-call loop.
  if (query.startsWith("select:")) {
    // Compared with every separator removed: `projects_get`, `projects:get`,
    // `projects.get` and `projects__get` all name `projects__get`. A single
    // underscore between app and tool missed, and the model searched again.
    const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "")
    const names = query.slice("select:".length).split(",").map(key).filter(Boolean)
    // A bare tool name two apps both use (`refunds_create`: two shop and
    // payment apps) loads neither: each moves money in a different system, and a
    // guess parks an approval against the wrong one. Both are listed, so the
    // next call names the one meant.
    const ambiguousNames = names.filter((n) => {
      if (allDeferred.some((t) => key(t.sdkName) === n)) return false
      return (
        new Set(allDeferred.filter((t) => key(t.toolName) === n).map((t) => t.appName)).size > 1
      )
    })
    const ambiguous = allDeferred
      .filter((t) => ambiguousNames.includes(key(t.toolName)))
      .map(toMatch)
    const matches = allDeferred.filter((t) =>
      names.some(
        (n) => !ambiguousNames.includes(n) && (key(t.toolName) === n || key(t.sdkName) === n),
      ),
    )
    const selected = matches.map(toMatch)
    // A name that is no deferred tool may be one the turn already has (a core
    // kernel tool such as memory_view): say so, so it is called, not searched.
    const matchedKeys = new Set([
      ...matches.flatMap((t) => [key(t.toolName), key(t.sdkName)]),
      ...ambiguousNames,
    ])
    const deferredSdkNames = new Set(allDeferred.map((t) => t.sdkName))
    const hotLoaded: string[] = []
    let unresolved = 0
    for (const n of names) {
      if (matchedKeys.has(n)) continue
      const held = loadedToolNamed(frame?.turnToolNames, deferredSdkNames, n, key)
      if (held) hotLoaded.push(held)
      else unresolved++
    }
    // Every name it asks for is held already: nothing to load, nothing counted.
    const nothingNew =
      ambiguous.length === 0 &&
      unresolved === 0 &&
      selected.length + hotLoaded.length > 0 &&
      selected.every((m) => !m.locked && !m.routineOnly) &&
      (selected.length === 0 || allAlreadyLoaded(selected))
    if (nothingNew) {
      return {
        matches: selected,
        query,
        totalDeferredTools: allDeferred.length,
        note: alreadyLoadedNote([...selected.map((m) => m.name), ...hotLoaded]),
      }
    }
    if (overLimit) return overLimitAnswer()
    countSearch()
    const unlockNote = unlockMatches(selected)
    const loadedNote = hotLoaded.length > 0 ? alreadyLoadedNote(hotLoaded) : undefined
    const ambiguousNote =
      ambiguous.length > 0
        ? `Not loaded: ${ambiguousNames.map((n) => `"${n}"`).join(", ")} names a tool in more than one app (${ambiguous.map((m) => m.name).join(", ")}). Load the one you mean by its full name, for example "select:${ambiguous[0]?.name}".`
        : undefined
    const note = [unlockNote, loadedNote, ambiguousNote].filter(Boolean).join(" ")
    return {
      matches: [...selected, ...ambiguous],
      query,
      totalDeferredTools: allDeferred.length,
      ...(note ? { note } : {}),
    }
  }

  // Keyword search: score by name, keywords and description (tool-rank.ts).
  const {
    ranked,
    all,
    strongNames: strong,
    wholeApp,
  } = rankDeferredTools(allDeferred, query, {
    cap,
    appNames: orgAppNames(ctx.orgId),
  })
  const matches = ranked.map((s) => toMatch(s.tool))
  const strongHits = matches.filter((m) => strong.has(m.name))
  if (allAlreadyLoaded(strongHits)) {
    return {
      matches,
      query,
      totalDeferredTools: allDeferred.length,
      note: alreadyLoadedNote(
        strongHits.filter((m) => !m.locked && !m.routineOnly).map((m) => m.name),
      ),
    }
  }
  if (overLimit) return overLimitAnswer()
  countSearch()

  // A query nothing scores on answers with the apps, by name, never with tools.
  // It used to list an arbitrary sample of five deferred tools so the catalog was
  // never invisible, and a weak model then called one of them as if it were the
  // answer. The apps' names keep the catalog visible: searching one lists its
  // tools.
  if (matches.length === 0 && allDeferred.length > 0) {
    const counts = new Map<string, number>()
    for (const t of allDeferred) counts.set(t.appName, (counts.get(t.appName) ?? 0) + 1)
    const apps = [...counts]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, tools]) => ({ name, tools }))
    return {
      matches: [],
      query,
      totalDeferredTools: allDeferred.length,
      fellBackToCatalog: true,
      apps,
      note: `No tool matched "${query}", so nothing was loaded. Apps you can search: ${apps.map((a) => `${a.name} (${a.tools})`).join(", ")}. Search again with other words for what you want to do, or with an app's name to list its tools.`,
    }
  }

  const ofApp = (list: typeof all) =>
    list.filter((s) => s.tool.appName.toLowerCase() === wholeApp).length
  const leftOut = wholeApp ? ofApp(all) - ofApp(ranked) : 0
  const note = [
    unlockMatches(
      strongHits,
      matches.filter((m) => !strong.has(m.name) && !m.locked && !m.routineOnly),
    ),
    leftOut > 0
      ? `${leftOut} more ${wholeApp} tools were left out of this list. Search with ${wholeApp} and a word for what you want to do to reach them.`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ")
  return {
    matches,
    query,
    totalDeferredTools: allDeferred.length,
    ...(note ? { note } : {}),
  }
}
