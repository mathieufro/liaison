// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The untrusted-content mark follows what a turn is SHOWN, not when the text was first read. A
// typed turn starts unmarked (taint.ts, clearTaintFlag), but its history re-sends earlier tool
// results and checkpoint summaries, outside text included. One rule decides whether it does, for
// every reader of that history: the turn start (before compaction, the checkpoint advance and its
// memory flush), context assembly, and the summaries written from it.
//
// A person can clear the mark (kernel:outside_text_clear): from then on, rows written at or before
// that moment no longer count. They decided the text read so far may be acted on; a row written
// after it (a new read, a summary folding only cleared rows into a new version) is judged as
// before.
import { wrapExternalContent } from "~/lib/external-content"
import { canonicalToolNamesBySdkName } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { loadTaintClearedAt, outsideTextSourceOf, setTaintFlag, taintSourceApplies } from "./taint"

interface StoredToolCall {
  toolName: string
  args?: unknown
  result?: unknown
  status?: "completed" | "error"
  /** Whether this call marked the turn when it ran (agent-service, extractToolCalls). */
  tainted?: boolean
}

type HistoryRow = { id?: unknown; createdAt?: unknown; metadata?: unknown }

/** Whether a person's clear (at `clearedAt`) covers this row: written at or before it. */
export function clearedByPerson(row: { createdAt?: unknown }, clearedAt: Date | null): boolean {
  if (!clearedAt) return false
  const at = row.createdAt instanceof Date ? row.createdAt : new Date(String(row.createdAt))
  return !Number.isNaN(at.getTime()) && at.getTime() <= clearedAt.getTime()
}

/** One history row's reason to mark a turn: what read the outside text there. */
export interface OutsideTextSource {
  /** The message (or checkpoint) row carrying it. */
  rowId: string | null
  at: string | null
  /** The tool whose result brought it in, or "summary" for a summary of earlier marked rows. */
  source: string
  /** The MCP server that tool belongs to (`mcp:<slug>`, taint.ts `outsideTextSourceOf`); absent
   *  for every other source, which the thread then records as unknown. */
  server?: string
  /** The call's identifying arguments (ids, a URL, a query), truncated. */
  ref: Record<string, string>
  /** A short piece of what was read, fenced as outside text: a reference, never instructions. */
  excerpt: string | null
}

const REF_KEYS = [
  "id",
  "url",
  "query",
  "path",
  "threadId",
  "ticketId",
  "messageId",
  "conversationId",
]
const EXCERPT_CHARS = 120

function refOf(args: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!args || typeof args !== "object") return out
  for (const key of REF_KEYS) {
    const v = (args as Record<string, unknown>)[key]
    if (typeof v === "string" || typeof v === "number") out[key] = String(v).slice(0, 200)
  }
  return out
}

function excerptOf(result: unknown): string | null {
  let textValue: string
  try {
    textValue = typeof result === "string" ? result : JSON.stringify(result)
  } catch {
    return null
  }
  if (!textValue) return null
  const flat = textValue.replace(/\s+/g, " ").trim()
  if (!flat) return null
  const cut = flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}…` : flat
  return wrapExternalContent(cut)
}

/**
 * Why this history carries outside text: every row that does, with what read it. A row says so
 * itself: a checkpoint or compaction summary of marked rows carries `tainted`, and a tool call
 * carries whether it marked its turn when it ran. A call stored before calls carried that answer
 * is judged by its tool's declaration, its stored name resolved the way the tool set names it; a
 * call whose tool is no longer registered counts as outside text (fail closed). Rows a person's
 * clear covers are skipped. `first` stops at the first source.
 */
export async function outsideTextSources(
  rows: ReadonlyArray<HistoryRow>,
  orgId: string,
  opts: { clearedAt?: Date | null; first?: boolean } = {},
): Promise<OutsideTextSource[]> {
  const out: OutsideTextSource[] = []
  const clearedAt = opts.clearedAt ?? null
  let canonicalBySdkName: Map<string, string> | undefined
  for (const row of rows) {
    if (clearedByPerson(row, clearedAt)) continue
    const rowId = typeof row.id === "string" ? row.id : null
    const at =
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : row.createdAt
          ? String(row.createdAt)
          : null
    const meta = row.metadata as { tainted?: unknown; toolCalls?: StoredToolCall[] } | null
    if (meta?.tainted === true) {
      out.push({ rowId, at, source: "summary", ref: {}, excerpt: null })
      if (opts.first) return out
    }
    for (const tc of meta?.toolCalls ?? []) {
      if (tc.status === "error" || tc.result == null) continue
      let marked: boolean
      const canonical = tc.toolName.includes(":")
        ? tc.toolName
        : (canonicalBySdkName ??= canonicalToolNamesBySdkName(orgId)).get(tc.toolName)
      if (typeof tc.tainted === "boolean") {
        marked = tc.tainted
      } else {
        const idx = canonical?.indexOf(":") ?? -1
        const tool =
          canonical && idx > 0
            ? toolRegistry.get([orgId, canonical.slice(0, idx), canonical.slice(idx + 1)])
            : undefined
        marked = !tool || (await taintSourceApplies(tool, tc.args, orgId, { result: tc.result }))
      }
      if (!marked) continue
      const server = outsideTextSourceOf(canonical)
      out.push({
        rowId,
        at,
        source: tc.toolName,
        ...(server ? { server } : {}),
        ref: refOf(tc.args),
        excerpt: excerptOf(tc.result),
      })
      if (opts.first) return out
    }
  }
  return out
}

/** Does this history carry outside text? (`outsideTextSources`, stopping at the first.) */
export async function replaysOutsideText(
  rows: ReadonlyArray<HistoryRow>,
  orgId: string,
  opts: { clearedAt?: Date | null } = {},
): Promise<boolean> {
  return (await outsideTextSources(rows, orgId, { ...opts, first: true })).length > 0
}

/**
 * Mark the thread when the history this turn is given carries outside text, before any tool or
 * durable write of the turn runs. Returns whether it did.
 */
export async function markTurnIfReplaysOutsideText(
  threadId: string,
  orgId: string,
  rows: ReadonlyArray<HistoryRow>,
): Promise<boolean> {
  const clearedAt = await loadTaintClearedAt(threadId, orgId)
  const sources = await outsideTextSources(rows, orgId, { clearedAt })
  if (sources.length === 0) return false
  // The mark is as old as the newest row that carries outside text, not this turn's start: a
  // person's clear covering that row lifts it (taint.ts, clearOutsideTextMark).
  const times = sources
    .map((s) => (s.at ? new Date(s.at).getTime() : Number.NaN))
    .filter((t) => !Number.isNaN(t))
  const timing = times.length === sources.length ? { sourceAt: new Date(Math.max(...times)) } : {}
  // Named sources only when every one is an MCP server; any other makes the set unknown.
  const servers = sources.map((s) => s.server)
  if (servers.some((s) => s === undefined)) {
    await setTaintFlag(threadId, orgId, timing)
  } else {
    for (const server of new Set(servers)) {
      await setTaintFlag(threadId, orgId, { ...timing, source: server })
    }
  }
  return true
}
