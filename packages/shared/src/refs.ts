// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

// UUID hex is matched case-insensitively (the `i` flag) because approval ids may
// arrive either case; it is lowercased on parse. Output KEYS are lowercase-only
// by deliberate design — `referenceableOutputs` keys are validated lowercase at
// tool registration (Task 3), so a token's key is always lowercase and matches
// the handler's returned object key exactly. Keeping KEY_RE strictly lowercase
// (and NOT relying on the `i` flag for the key segment) means a "dumb model"
// pasting a token can never produce a key whose case mismatches the lookup map.
const UUID_RE = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
const KEY_RE = "[a-z][a-z0-9_]*"
// `i` flag covers ONLY the UUID hex; KEY_RE is already lowercase-only so the
// flag does not widen the key charset.
const TOKEN_RE = new RegExp(`^@ref:(${UUID_RE}):(${KEY_RE})$`, "i")
const EMBED_RE = new RegExp(`@ref:(${UUID_RE}):(${KEY_RE})`, "gi")

export const refTokenSchema = z.string().regex(TOKEN_RE)

/** Build a ref token. `outputKey` MUST be lowercase (snake_case) — callers pass
 *  `referenceableOutputs` entries, which Task 3 validates lowercase at registration. */
export function buildRefToken(approvalId: string, outputKey: string): string {
  return `@ref:${approvalId}:${outputKey}`
}

export function parseRefToken(s: unknown): { approvalId: string; outputKey: string } | null {
  if (typeof s !== "string") return null
  const m = TOKEN_RE.exec(s)
  // UUID lowercased; key is already lowercase-only per KEY_RE.
  const [, approvalId, outputKey] = m ?? []
  return approvalId && outputKey ? { approvalId: approvalId.toLowerCase(), outputKey } : null
}

/** Accept either a concrete value of `inner`'s type, or a ref token resolved later. */
export function deferrableRef<T extends z.ZodTypeAny>(inner: T) {
  return z.union([refTokenSchema, inner])
}

export interface FoundRef {
  approvalId: string
  outputKey: string
  /** Dotted JSON path where the token was found (e.g. `attachments.0`, `body`). */
  path: string
}

/** Walk any JSON value; return every ref token (whole-string or embedded-in-string). */
export function findRefTokens(value: unknown, path = ""): FoundRef[] {
  const out: FoundRef[] = []
  if (typeof value === "string") {
    for (const m of value.matchAll(EMBED_RE)) {
      const [, approvalId, outputKey] = m
      if (approvalId && outputKey)
        out.push({ approvalId: approvalId.toLowerCase(), outputKey, path })
    }
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      out.push(...findRefTokens(value[i], path ? `${path}.${i}` : String(i)))
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(...findRefTokens(v, path ? `${path}.${k}` : k))
    }
  }
  return out
}

type ResultMap = Record<string, Record<string, unknown>>

function lookup(results: ResultMap, approvalId: string, key: string): unknown {
  const r = results[approvalId.toLowerCase()]
  if (!r) {
    throw new Error(
      `Unresolvable ref token @ref:${approvalId}:${key} — the step ${approvalId} has no result`,
    )
  }
  if (!(key in r)) {
    const returned = Object.keys(r)
    throw new Error(
      `Unresolvable ref token @ref:${approvalId}:${key} — missing output "${key}": that step returned ${returned.length > 0 ? returned.map((k) => `"${k}"`).join(", ") : "no keys"}`,
    )
  }
  return r[key]
}

/** The earlier step a token points at, as a person reads it: its place in the
 *  sequence (1-based), the tool it runs and that step's own arguments. */
export interface RefSource {
  step: number
  toolName: string
  payload?: Record<string, unknown> | null
  /** The request's label (`request-N`), the one the person can find. */
  handle?: string | null
  /** What the step returned, once it ran: a token on one of its keys reads as the value. */
  result?: Record<string, unknown> | null
}

/** Looks up the step an `@ref` token's approval id names, when known. */
export type RefSourceLookup = (approvalId: string) => RefSource | undefined

/** What a step's output IS, by its output key ("pdf_file_id" -> "PDF"). The
 *  web's French reading maps the same keys (approval-copy.ts), so the English
 *  words here are matched back to their key there. */
export const REF_OUTPUT_WORDS: Readonly<Record<string, string>> = {
  pdf_file_id: "PDF",
  file_id: "file",
  record_id: "record",
  document_id: "document",
  number: "number",
  grand_total_minor: "total",
  total_minor: "total",
  currency: "currency",
  url: "link",
  message_id: "message",
  id: "record",
}

const ACRONYMS = new Set(["pdf", "crm", "url", "vat", "id", "sku", "api"])

/** Generic words for a key no table names: `tracking_number` -> "tracking number". */
function keyWords(key: string): string {
  const words = key
    .replace(/_(id|minor)$/, "")
    .split(/_+/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w))
  return words.length > 0 ? words.join(" ") : key
}

/** Verbs and glue a tool name carries around the thing it makes. */
const TOOL_VERBS = new Set([
  "create",
  "and",
  "issue",
  "update",
  "send",
  "write",
  "set",
  "add",
  "make",
  "new",
  "run",
  "upsert",
  "save",
  "connector",
  "draft",
])

/** The thing the source step makes, when its tool says it ("quote_create_and_issue" -> "quote";
 *  an API connector write -> its connection, "crm" -> "CRM"). Null when nothing names it. */
export function refSourceNoun(source: RefSource): string | null {
  const [app, tool = ""] = source.toolName.split(":")
  if (app === "api-connector") {
    const connection = source.payload?.connection
    if (typeof connection === "string" && connection.trim()) {
      const c = connection.trim()
      return /^[a-z]{2,3}$/.test(c) ? c.toUpperCase() : c
    }
    return null
  }
  const noun = tool
    .split(/[_.]+/)
    .filter(Boolean)
    .find((w) => !TOOL_VERBS.has(w.toLowerCase()))
  return noun ? noun.toLowerCase() : null
}

/** "quote PDF from step 2": what an `@ref` token stands for, without an article.
 *  With no known source, the output's own words ("record id" stays as before). */
export function describeRefOutput(key: string, source?: RefSource): string {
  if (!source) return key.replace(/_/g, " ")
  const output = REF_OUTPUT_WORDS[key] ?? keyWords(key)
  const noun = refSourceNoun(source)
  const what = noun && noun.toLowerCase() !== output.toLowerCase() ? `${noun} ${output}` : output
  return `${what} from step ${source.step}`
}

/** Says a value is not known yet: it is filled in when the step it comes from runs. */
export const REF_FILLED_LATER = "filled in when that step runs"

/** The value a step that already ran returned for `key`, as text; undefined when it has not. */
export function resolvedText(key: string, source?: RefSource): string | undefined {
  const result = source?.result
  if (!result || typeof result !== "object" || !(key in result)) return undefined
  const value = result[key]
  if (value === null || value === undefined) return undefined
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value).slice(0, 200)
}

/** "the shipment tracking number from step 1 (request-12, filled in when that step runs)". */
export function pendingRef(key: string, source: RefSource): string {
  const handle = source.handle?.trim()
  return `the ${describeRefOutput(key, source)} (${handle ? `${handle}, ` : ""}${REF_FILLED_LATER})`
}

/** Replace every `@ref:<uuid>:<key>` token with readable provenance — display
 *  only, so a human never sees a raw token. Single source of truth for the
 *  token regex (no duplicate copies).
 *
 *  A token whose step already ran reads as the value it returned (what the call
 *  will carry). A token whose step is known but has not run names it, its
 *  request and that the value comes later: "the shipment tracking number from
 *  step 1 (request-12, filled in when that step runs)". Without any source a
 *  token reads as its key's words "from an earlier step". Never a bracketed
 *  stand-in a person could take for the value itself. */
export function humanizeRefTokens(text: string, sources?: RefSourceLookup): string {
  const whole = sources ? parseRefToken(text.trim()) : null
  if (whole && sources) {
    const source = sources(whole.approvalId)
    if (source) return resolvedText(whole.outputKey, source) ?? pendingRef(whole.outputKey, source)
  }
  return text.replace(EMBED_RE, (_m, id: string, key: string) => {
    const source = sources?.(id.toLowerCase())
    if (!source) return `the ${describeRefOutput(key)} from an earlier step (${REF_FILLED_LATER})`
    return resolvedText(key, source) ?? pendingRef(key, source)
  })
}

/** True when `value` is a string carrying at least one `@ref:` token.
 *  Uses a fresh per-call regex (built from the same source as `EMBED_RE`) to
 *  avoid the mutable-`lastIndex` hazard a shared `.test()` would introduce. */
export function containsRefToken(value: unknown): boolean {
  if (typeof value !== "string") return false
  return new RegExp(`@ref:${UUID_RE}:${KEY_RE}`, "i").test(value)
}

/** Substitute tokens. Whole-string token → raw value (any type); embedded → stringified. */
export function resolveRefTokens(value: unknown, results: ResultMap): unknown {
  if (typeof value === "string") {
    const whole = parseRefToken(value)
    if (whole) return lookup(results, whole.approvalId, whole.outputKey)
    return value.replace(EMBED_RE, (_m, id: string, key: string) =>
      String(lookup(results, id, key)),
    )
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefTokens(v, results))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveRefTokens(v, results)]),
    )
  }
  return value
}
