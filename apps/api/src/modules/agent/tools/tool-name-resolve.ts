// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Mapping a tool name the model CALLED onto a tool the turn HOLDS.
 *
 * Every agent tool is named `<app>__<tool>` (two underscores). Models still
 * write the same tool as `knowledge:search`, `kernel.tool_search` or a bare
 * `tool_search`, because that is how prose (skills, routines, guides written
 * by people) tends to name it. The SDK parses a call by exact name only, so
 * each such call used to fail and cost the model a step.
 *
 * `resolveHeldToolName` is deliberately narrow:
 *   - a separator variant (`app:tool`, `app.tool`, `app/tool`, `app::tool`)
 *     resolves when it names exactly one held tool;
 *   - a bare name resolves when exactly one held tool ends in `__<name>`;
 *   - anything else is ambiguous or unknown and resolves to NOTHING, with the
 *     closest held names as suggestions.
 * It only ever answers with a name from `held`, so it can never widen what a
 * turn may execute: scope filtering happened when `held` was built.
 */
import {
  asSchema,
  type FlexibleSchema,
  InvalidToolInputError,
  NoSuchToolError,
  type ToolSet,
} from "ai"
import { rootLogger } from "~/lib/logger"
import { checkToolScopes } from "~/modules/agent/scopes/required-scopes"
import { toolRegistry } from "~/modules/apps/app-registries"
import { isFeatureOffForTool } from "~/modules/apps/org-apps"
import { type FeatureOffAnswer, featureOffAnswer } from "~/modules/apps/org-features"

const log = rootLogger.child({ module: "tool-name-resolve" })

export type ToolNameResolution =
  | { kind: "exact"; name: string }
  | { kind: "resolved"; name: string; via: "separator" | "bare" }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "unknown"; suggestions: string[] }

const SEPARATOR = /::|[:./]/g
const HAS_SEPARATOR = /[:./]/
const MAX_SUGGESTIONS = 5

function lastSegment(name: string): string {
  const i = name.lastIndexOf("__")
  return i === -1 ? name : name.slice(i + 2)
}

/** `knowledge:search` / `knowledge.search` -> `knowledge__search`, lower-cased. */
function canonical(name: string): string {
  return name.trim().replace(SEPARATOR, "__").toLowerCase()
}

export function resolveHeldToolName(called: string, held: readonly string[]): ToolNameResolution {
  if (held.includes(called)) return { kind: "exact", name: called }
  const trimmed = called.trim()
  if (HAS_SEPARATOR.test(trimmed) || trimmed.includes("__")) {
    const key = canonical(trimmed)
    const matches = held.filter((h) => h.toLowerCase() === key)
    if (matches.length === 1) return { kind: "resolved", name: matches[0], via: "separator" }
    if (matches.length > 1) return { kind: "ambiguous", candidates: [...matches].sort() }
  } else if (trimmed.length > 0) {
    const bare = trimmed.toLowerCase()
    const matches = held.filter((h) => h.includes("__") && lastSegment(h).toLowerCase() === bare)
    if (matches.length === 1) return { kind: "resolved", name: matches[0], via: "bare" }
    if (matches.length > 1) return { kind: "ambiguous", candidates: [...matches].sort() }
  }
  return { kind: "unknown", suggestions: suggestToolNames(trimmed, held) }
}

/** Levenshtein distance, two rows. */
function distance(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * The held names closest to `called`: a held tool whose own name (after the
 * app prefix) matches or contains the called tool part ranks first, then
 * edit distance over the full canonical name.
 */
export function suggestToolNames(called: string, held: readonly string[]): string[] {
  const key = canonical(called)
  const tail = lastSegment(key)
  const scored = held.map((h) => {
    const lower = h.toLowerCase()
    const hTail = lastSegment(lower)
    let score = Math.min(distance(key, lower), distance(tail, hTail) + 1)
    if (tail.length >= 3 && (hTail.includes(tail) || tail.includes(hTail)))
      score = Math.min(score, 1)
    return { h, score }
  })
  const limit = Math.max(3, Math.ceil(tail.length * 0.5))
  return scored
    .filter((s) => s.score <= limit)
    .sort((a, b) => a.score - b.score || a.h.localeCompare(b.h))
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => s.h)
}

/**
 * The tool error the model reads when its call maps to no single held tool.
 * It names the closest held tools so the next step can call one exactly.
 */
export function unresolvedToolCallMessage(
  called: string,
  resolution: Extract<ToolNameResolution, { kind: "ambiguous" | "unknown" }>,
  opts: { canSearch: boolean },
): string {
  const form = "Tool names are app__tool, with two underscores."
  if (resolution.kind === "ambiguous") {
    return `No tool is named "${called}" and several tools you hold match it: ${resolution.candidates.join(", ")}. ${form} Call the one you mean by its exact name.`
  }
  const search = opts.canSearch ? " or find it with kernel__tool_search" : ""
  if (resolution.suggestions.length === 0) {
    return `No tool named "${called}" is available to you. ${form} Call a tool you hold by its exact name${search}.`
  }
  return `No tool named "${called}" is available to you. Closest tools you hold: ${resolution.suggestions.join(", ")}. ${form} Call one of them by its exact name${search}.`
}

/**
 * The answer for a call naming a tool that left with its feature, from a schema in
 * the history or a stale list. Null when the name is no such tool, or the caller does
 * not hold its scope: they read "no tool" as they would for any tool out of their
 * reach. Looks in the org's whole registry, not in what the turn holds.
 */
export function featureOffAnswerForCall(
  orgId: string,
  called: string,
  scopes: readonly string[],
): FeatureOffAnswer | null {
  const off = new Map<string, Parameters<typeof featureOffAnswer>[1]>()
  for (const [key, def] of toolRegistry.entriesOf(orgId)) {
    if (!isFeatureOffForTool(orgId, def)) continue
    if (!checkToolScopes(def, [...scopes]).authorized) continue
    off.set(`${key[1]}__${key[2].replace(/[^a-zA-Z0-9_-]/g, "_")}`, def)
  }
  if (off.size === 0) return null
  const resolution = resolveHeldToolName(called, [...off.keys()])
  if (resolution.kind !== "exact" && resolution.kind !== "resolved") return null
  const tool = off.get(resolution.name)
  return tool ? featureOffAnswer(orgId, tool) : null
}

/**
 * Whose a built tool set is. The repair hook gets only the set, and a call naming no
 * tool in it may name one that left with its feature.
 */
const heldToolSetOwners = new WeakMap<object, { orgId: string; scopes: readonly string[] }>()

/** Record whose this tool set is (`buildToolSet`, `buildScopedToolSet`). */
export function rememberHeldToolSet(
  tools: object,
  owner: { orgId: string; scopes: readonly string[] },
): void {
  heldToolSetOwners.set(tools, owner)
}

/** Marks the error a refused call carries, so its log line stays a warn. */
export const UNRESOLVED_TOOL_CALL_MARKER = "No tool named"
const AMBIGUOUS_TOOL_CALL_MARKER = "No tool is named"
const FEATURE_OFF_CALL_MARKER = '"code":"feature_off"'

/** True when a tool-error (object or the SDK's flattened string) is the model naming a tool wrongly. */
export function isUnresolvedToolCallError(error: unknown): boolean {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : ""
  // AI SDK 7 flattens a tool error to "<name>: <message>" on the stream's
  // tool-error chunk ("AI_ToolCallRepairError: Error repairing tool call: ...");
  // AI SDK 6 sent the bare message. Read the message either way.
  const text = raw.replace(/^(?:AI_[A-Za-z]+Error: )+/, "")
  return (
    text.startsWith("Model tried to call unavailable tool") ||
    text.startsWith("Invalid input for tool") ||
    (text.startsWith("Error repairing tool call:") &&
      (text.includes(UNRESOLVED_TOOL_CALL_MARKER) ||
        text.includes(AMBIGUOUS_TOOL_CALL_MARKER) ||
        text.includes(FEATURE_OFF_CALL_MARKER)))
  )
}

type RepairedCall = { type: "tool-call"; toolCallId: string; toolName: string; input: string }

/**
 * The SDK's tool-call repair hook for an agent turn. `held` is the turn's full
 * executable set (already scope filtered); the SDK passes the step's ACTIVE
 * set as `tools`. A call whose name is not exact:
 *   - maps to one held tool that is active: the call runs under its real name;
 *   - maps to one held tool that is deferred: it becomes that tool's discovery,
 *     `kernel__tool_search select:<name>`, so it is callable on the next step;
 *   - maps to none or several: the call is refused with the closest held
 *     names, so the model corrects itself in one step.
 * A tool outside `held` is never executed.
 */
export function repairHeldToolCall(held: ToolSet) {
  return async ({
    toolCall,
    tools: active,
    error,
  }: {
    toolCall: { toolCallId: string; toolName: string; input: string }
    tools?: Record<string, unknown>
    error: unknown
  }): Promise<RepairedCall | null> => {
    if (InvalidToolInputError.isInstance(error)) {
      return repairStringifiedArrays(
        toolCall,
        active?.[toolCall.toolName] ?? held[toolCall.toolName],
      )
    }
    if (!NoSuchToolError.isInstance(error)) return null
    const canSearch = Boolean(held.kernel__tool_search)
    // Read per call: a run's set grows mid-turn (admitLateTools in tool-bridge.ts).
    const resolution = resolveHeldToolName(toolCall.toolName, Object.keys(held))
    if (resolution.kind === "ambiguous" || resolution.kind === "unknown") {
      const owner = heldToolSetOwners.get(held)
      const off = owner && featureOffAnswerForCall(owner.orgId, toolCall.toolName, owner.scopes)
      if (off) {
        log.warn({ toolName: toolCall.toolName }, "Tool call names a tool whose feature is off")
        throw new Error(JSON.stringify(off))
      }
      log.warn(
        { toolName: toolCall.toolName, resolution: resolution.kind },
        "Tool call names no single held tool, refused with suggestions",
      )
      throw new Error(unresolvedToolCallMessage(toolCall.toolName, resolution, { canSearch }))
    }
    const name = resolution.name
    if (active?.[name]) {
      log.warn({ toolName: toolCall.toolName, resolvedTo: name }, "Tool call name normalized")
      return {
        type: "tool-call",
        toolCallId: toolCall.toolCallId,
        toolName: name,
        input: toolCall.input,
      }
    }
    if (!canSearch) {
      throw new Error(
        unresolvedToolCallMessage(
          toolCall.toolName,
          { kind: "unknown", suggestions: suggestToolNames(name, Object.keys(active ?? {})) },
          { canSearch },
        ),
      )
    }
    log.warn(
      { toolName: toolCall.toolName, resolvedTo: name },
      "Blind call to a tool the provider was not shown, rewritten into tool_search select",
    )
    return {
      type: "tool-call",
      toolCallId: toolCall.toolCallId,
      toolName: "kernel__tool_search",
      input: JSON.stringify({ query: `select:${name}` }),
    }
  }
}

/** True when a JSON Schema node admits an array: `type` names it, or one `anyOf`/`oneOf` branch does. */
function acceptsArray(node: unknown): boolean {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false
  const n = node as { type?: unknown; anyOf?: unknown; oneOf?: unknown }
  if (n.type === "array" || (Array.isArray(n.type) && n.type.includes("array"))) return true
  const variants = [n.anyOf, n.oneOf].filter(Array.isArray).flat()
  return variants.some(acceptsArray)
}

/**
 * A STRINGIFIED ARRAY, repaired at the SDK seam. A weak model sends an array
 * parameter JSON-encoded inside a string (`"status": "[\"open\", \"closed\"]"`);
 * the SDK validates the call against the tool's schema before it ever reaches
 * the bridge, so the coercion `executeTool` applies never ran and the call came
 * back as an input error, a wasted step. A top-level parameter whose schema
 * admits an array and whose value is a string that parses to an array takes
 * the parsed array, and the call is rewritten only when the whole rewritten
 * input passes the tool's own schema (so every item is acceptable). Only
 * string to array: nothing else is ever coerced, and a call this cannot make
 * valid is left to the SDK's normal input error.
 */
async function repairStringifiedArrays(
  toolCall: { toolCallId: string; toolName: string; input: string },
  toolDef: unknown,
): Promise<RepairedCall | null> {
  const inputSchema = (toolDef as { inputSchema?: FlexibleSchema<unknown> } | undefined)
    ?.inputSchema
  if (!inputSchema) return null
  let input: unknown
  try {
    input = JSON.parse(toolCall.input)
  } catch {
    return null
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const schema = asSchema(inputSchema)
  const json = (await schema.jsonSchema) as { properties?: Record<string, unknown> }
  const props = json.properties ?? {}
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) }
  const coerced: string[] = []
  for (const [key, value] of Object.entries(out)) {
    if (typeof value !== "string" || !acceptsArray(props[key])) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    out[key] = parsed
    coerced.push(key)
  }
  if (coerced.length === 0) return null
  if (schema.validate) {
    const checked = await schema.validate(out)
    if (!checked.success) return null
  }
  log.warn(
    { toolName: toolCall.toolName, params: coerced },
    "Tool call sent an array parameter as a JSON string, parsed into the array",
  )
  return {
    type: "tool-call",
    toolCallId: toolCall.toolCallId,
    toolName: toolCall.toolName,
    input: JSON.stringify(out),
  }
}
