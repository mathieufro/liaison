// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE APPS A TURN IS ABOUT.
//
// A turn starts with a lean tool surface: app tools are deferred, one
// tool_search away, and the tool schema and system prompt budgets
// (context.ts) shed whole apps and skill bodies to keep each step small. In an
// org with every app installed those budgets shed the very app the request
// was about: a reply asked for from a ticket lost every tickets tool (largest
// app, dropped first) and the reply-voice skill, and a weak model then spent
// its steps searching for tools and reading until the turn ran out.
//
// Two kinds of evidence name the request's app before the first step.
//
// - HARD: what the server itself holds about the turn. The entity a thread
//   was made for (a task's discussion, a ticket's thread), and the app whose
//   event fired a routine tick. Neither changes from one turn of the thread
//   to the next. On a demo visitor's turn the view the message was sent from
//   counts too: a visitor's turn has a step budget, and a tool search costs it
//   a step. A hard focus app's tools are loaded from the first step and shed
//   last (focusOverflow).
// - SOFT: the view a person's message was sent from, in every other org. It
//   is the client's word and it changes with the active tab, so it never
//   pushes out what the conversation already loaded: its app's tools only
//   fill the room left under the tool schema budget (focusHeadroomFill).
//
// An entity merely attached to a conversation is not evidence: a ticket opened
// a while ago made every later request in the same chat (an order to ship)
// carry the tickets app.
//
// An entity type counts only when the app registered it (a manifest entity or
// tab type) and its name has at least three characters: `invoicing:_` named
// every tool with any `...Id` input as acting on the entity. The tools acting
// on an entity the server read (an input naming it, `ticketId` on a ticket,
// `parentTaskId` on a task) are kept past the budget, up to a bound; those
// acting on an entity the client named are only loaded first.
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { routines, threads } from "~/db/schema/kernel"
import { estimateToolSchemaTokens } from "~/modules/agent/context/context"
import { sdkToolName } from "~/modules/agent/tools/tool-bridge"
import { entityRegistry, toolRegistry, viewRegistry } from "~/modules/apps/app-registries"
import { tabEntity } from "~/modules/threads/reference-display"

export interface FocusApp {
  /** Loaded from the first step and shed last; otherwise it only fills headroom. */
  hard: boolean
  /** Entity types the server read (the thread's own entity, the routine's event). */
  verifiedEntityTypes: Set<string>
  /** Entity types the client's view named. */
  viewEntityTypes: Set<string>
}

/** The apps a turn is about. */
export type TurnFocus = Map<string, FocusApp>

/** The app and entity type of an `app:entity[:action]` tab type or event name; null for the kernel. */
export function parseQualifiedName(
  name: string | null | undefined,
): { app: string; entityType: string | null } | null {
  if (!name) return null
  const parts = name.split(":")
  const app = parts[0]
  if (!app || parts.length < 2 || app === "kernel") return null
  return { app, entityType: parts[1] || null }
}

const keyOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")

/** Shorter entity keys match too many inputs (`_` made every `...Id` input count). */
const MIN_ENTITY_KEY_CHARS = 3

/**
 * Whether `app` registered `entityType` in this org: a manifest entity or a
 * tab type. Anything else is a name the client made up.
 */
export function isRegisteredEntityType(orgId: string, app: string, entityType: string): boolean {
  if (keyOf(entityType).length < MIN_ENTITY_KEY_CHARS) return false
  if (entityRegistry.has([orgId, app, entityType]) || entityRegistry.has(["*", app, entityType]))
    return true
  const tabTypes = (viewRegistry.get([orgId, app]) ?? viewRegistry.get(["*", app]))?.tabTypes
  if (Array.isArray(tabTypes))
    return tabTypes.some((t) => (t as { id?: string })?.id === entityType || t === entityType)
  return !!tabTypes && typeof tabTypes === "object" && entityType in tabTypes
}

export interface TurnFocusInput {
  orgId: string
  threadId: string
  currentView?: { tabType: string; entityId: string } | null
  routineId?: string | null
  /** A demo visitor's turn: its view counts as hard evidence (see the header). */
  visitorTurn?: boolean
  /** The apps with tools in this turn's tool set: a focus app must be one of them. */
  appsWithTools: ReadonlySet<string>
}

/** The apps this turn is about (see the header). Never throws: no evidence, no focus. */
export async function resolveTurnFocus(input: TurnFocusInput): Promise<TurnFocus> {
  const focus: TurnFocus = new Map()
  const add = (
    app: string | null | undefined,
    entityType: string | null | undefined,
    source: "server" | "view",
  ) => {
    if (!app || app === "kernel" || !input.appsWithTools.has(app)) return
    const entry = focus.get(app) ?? {
      hard: false,
      verifiedEntityTypes: new Set<string>(),
      viewEntityTypes: new Set<string>(),
    }
    if (source === "server" || input.visitorTurn) entry.hard = true
    if (entityType && isRegisteredEntityType(input.orgId, app, entityType)) {
      const named = tabEntity(input.orgId, app, entityType)
      ;(source === "server" ? entry.verifiedEntityTypes : entry.viewEntityTypes).add(
        named?.app === app ? named.entityType : entityType,
      )
    }
    focus.set(app, entry)
  }
  const view = parseQualifiedName(input.currentView?.tabType)
  if (view) add(view.app, view.entityType, "view")
  try {
    await withPrivilegedDb(input.orgId, "agent-turn-focus", async (tx) => {
      const [thread] = await tx
        .select({ createdFrom: threads.createdFrom })
        .from(threads)
        .where(and(eq(threads.id, input.threadId), eq(threads.orgId, input.orgId)))
        .limit(1)
      add(thread?.createdFrom?.app, thread?.createdFrom?.entityType, "server")
      if (input.routineId) {
        const [routine] = await tx
          .select({ event: routines.event, appName: routines.appName })
          .from(routines)
          .where(and(eq(routines.id, input.routineId), eq(routines.orgId, input.orgId)))
          .limit(1)
        const event = parseQualifiedName(routine?.event)
        if (event) add(event.app, event.entityType, "server")
        add(routine?.appName, null, "server")
      }
    })
  } catch {
    // Focus is an optimisation of the tool surface: without it the turn keeps
    // the lean rule and can still search for what it needs.
  }
  return focus
}

/** The apps of a focus, hard ones only when `hardOnly`. */
export function focusAppNames(focus: TurnFocus, hardOnly = false): Set<string> {
  return new Set([...focus].filter(([, f]) => !hardOnly || f.hard).map(([app]) => app))
}

/** The app of an SDK tool name (`tickets__reply` → `tickets`). */
export function appOfSdkToolName(name: string): string {
  const sep = name.indexOf("__")
  return sep > 0 ? name.slice(0, sep) : name
}

/**
 * The property names of a tool's input schema, in the forms a tool can hold:
 * the SDK's `Schema` the bridge hands a model (`providerInputSchemaOf`), a Zod
 * object, or a bare JSON Schema object.
 */
function inputPropertyNames(inputSchema: unknown): string[] {
  const schema = inputSchema as
    | {
        shape?: Record<string, unknown>
        properties?: Record<string, unknown>
        jsonSchema?: { properties?: Record<string, unknown> }
      }
    | undefined
  const props = schema?.shape ?? schema?.jsonSchema?.properties ?? schema?.properties
  return props && typeof props === "object" ? Object.keys(props) : []
}

/** Whether a tool acts on one of these entity types: an input named `<entity>Id` (or ending so). */
export function actsOnEntity(inputSchema: unknown, entityTypes: ReadonlySet<string>): boolean {
  const suffixes = [...entityTypes]
    .map(keyOf)
    .filter((k) => k.length >= MIN_ENTITY_KEY_CHARS)
    .map((k) => `${k}id`)
  if (suffixes.length === 0) return false
  return inputPropertyNames(inputSchema).some((p) => {
    const k = keyOf(p)
    return suffixes.some((s) => k === s || k.endsWith(s))
  })
}

type ToolDefs = Record<
  string,
  {
    description?: string
    inputSchema?: unknown
    /** The manifest's `focusCore`, when the tool declares one (focusCorePreload). */
    focusCore?: boolean | string
  }
>

/**
 * How far past the tool schema cap the tools acting on a server-read entity
 * may keep a turn. They are what the turn is for, but the bound holds whatever
 * an app declares.
 */
export const FOCUS_ENTITY_TOOLS_CEILING_FACTOR = 1.5

/** Which entity a focus tool acts on: one the server read, one the view named, or none. */
export function entityRank(name: string, tools: ToolDefs, focus: TurnFocus): 0 | 1 | 2 {
  const f = focus.get(appOfSdkToolName(name))
  if (!f) return 0
  const core = tools[name]?.focusCore
  if (typeof core === "string" && f.verifiedEntityTypes.has(core)) return 2
  const schema = tools[name]?.inputSchema
  if (actsOnEntity(schema, f.verifiedEntityTypes)) return 2
  if (actsOnEntity(schema, f.viewEntityTypes)) return 1
  return 0
}

/** Whether a tool is on its app's core list for this focus: `true`, or the entity type the server read. */
function isFocusCore(name: string, tools: ToolDefs, focus: TurnFocus): boolean {
  const core = tools[name]?.focusCore
  if (core === true) return true
  return (
    typeof core === "string" &&
    focus.get(appOfSdkToolName(name))?.verifiedEntityTypes.has(core) === true
  )
}

/**
 * The turn's tools with the `focusCore` their manifests declare, for the apps
 * in `apps` (the hard focus ones). The tool set the provider gets carries no
 * manifest keys, so the budget reads them here. Tools that declare none are
 * handed back unchanged.
 */
export function withFocusCore(orgId: string, apps: ReadonlySet<string>, tools: ToolDefs): ToolDefs {
  if (apps.size === 0) return tools
  let out: ToolDefs | null = null
  for (const [key, def] of toolRegistry.entriesOf(orgId)) {
    const core = (def as { focusCore?: unknown }).focusCore
    if (!apps.has(key[1]) || (core !== true && typeof core !== "string")) continue
    const name = sdkToolName(key[1], key[2])
    const tool = tools[name]
    if (!tool) continue
    out ??= { ...tools }
    out[name] = { description: tool.description, inputSchema: tool.inputSchema, focusCore: core }
  }
  return out ?? tools
}

/**
 * What a hard focus app loads from the first step. An app whose manifest
 * declares a core list (`focusCore` on its tools) loads that list with its
 * schemas, and its other tools are known by name and purpose only
 * (`indexOnly`): a turn about an invoice holds the dozen tools that act on
 * documents, not the 65 of the app, of which the budget then shed the largest,
 * the very ones the turn was for. A tool known by name still runs on a first
 * call with fitting arguments, and its schema follows once the model asks
 * for it. An app with no core list loads every tool, as before.
 * `candidates`: the deferred tools of the hard focus apps the turn has not
 * loaded; `tools`: every tool of the turn, to read each app's declarations.
 */
export function focusCorePreload(params: {
  candidates: readonly string[]
  tools: ToolDefs
  focus: TurnFocus
}): { preload: string[]; indexOnly: string[] } {
  const { tools, focus } = params
  const declaring = new Set<string>()
  for (const [name, def] of Object.entries(tools)) {
    if (def?.focusCore === true || typeof def?.focusCore === "string")
      declaring.add(appOfSdkToolName(name))
  }
  const preload: string[] = []
  const indexOnly: string[] = []
  for (const name of params.candidates) {
    if (!declaring.has(appOfSdkToolName(name)) || isFocusCore(name, tools, focus))
      preload.push(name)
    else indexOnly.push(name)
  }
  return { preload, indexOnly }
}

/**
 * Which visible tools of the hard focus apps to send back to the catalog (they
 * stay deferred, one tool_search away) so the turn's visible schemas fit `cap`.
 * `candidates` is every visible, deferred tool of those apps, the ones the
 * thread had already loaded included; `visibleTokens` is the turn's schema
 * total with all of them in. Largest first: the tools acting on no entity,
 * then those acting on the entity the view named, and last, only while the
 * turn is over FOCUS_ENTITY_TOOLS_CEILING_FACTOR times the cap, those acting
 * on the entity the server read.
 */
export function focusOverflow(params: {
  candidates: readonly string[]
  tools: ToolDefs
  focus: TurnFocus
  visibleTokens: number
  cap: number
}): string[] {
  const { candidates, tools, focus, cap } = params
  let total = params.visibleTokens
  if (total <= cap) return []
  const ranked = candidates
    .map((name) => ({
      name,
      rank: entityRank(name, tools, focus),
      tokens: estimateToolSchemaTokens(name, tools[name]),
    }))
    .sort((a, b) => a.rank - b.rank || b.tokens - a.tokens || a.name.localeCompare(b.name))
  const ceiling = Math.round(cap * FOCUS_ENTITY_TOOLS_CEILING_FACTOR)
  const out: string[] = []
  for (const t of ranked) {
    if (total <= (t.rank === 2 ? ceiling : cap)) {
      if (t.rank === 2) break
      continue
    }
    total -= t.tokens
    out.push(t.name)
  }
  return out
}

/**
 * Which tools of the soft focus apps to load into the room left under `cap`
 * (`candidates`: their deferred tools the turn has not loaded). The tools
 * acting on the entity in view first, then the others, smallest first within
 * each, while they fit. Nothing the turn already loaded is touched.
 */
export function focusHeadroomFill(params: {
  candidates: readonly string[]
  tools: ToolDefs
  focus: TurnFocus
  visibleTokens: number
  cap: number
}): string[] {
  const { candidates, tools, focus, cap } = params
  let total = params.visibleTokens
  const ranked = candidates
    .map((name) => ({
      name,
      acting: entityRank(name, tools, focus) > 0,
      tokens: estimateToolSchemaTokens(name, tools[name]),
    }))
    .sort(
      (a, b) =>
        Number(b.acting) - Number(a.acting) || a.tokens - b.tokens || a.name.localeCompare(b.name),
    )
  const out: string[] = []
  for (const t of ranked) {
    if (total + t.tokens > cap) continue
    total += t.tokens
    out.push(t.name)
  }
  return out
}
