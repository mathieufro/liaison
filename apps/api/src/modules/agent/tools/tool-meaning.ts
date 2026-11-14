// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Meaning for tool search: how close a query is to what each tool does, read
 * from text embeddings, added to the keyword ranker's score (tool-rank.ts).
 *
 * The keyword ranker reads words; a person often says what they want without
 * the words a tool is named or described with ("Marc left, cut his access" for
 * deactivating a user). An embedding of the query and of each tool's name and
 * description places both by meaning, so a tool can rank on a request that
 * shares no word with it.
 *
 * Rules the ranker keeps:
 * - Only tools in the catalog it is handed can rank. The caller builds that
 *   catalog from the actor's scopes, Off apps and hidden tools, so a tool the
 *   caller cannot reach never surfaces, whatever its vector says.
 * - A tool the keyword search loads (a strong match) keeps its place ahead.
 * - Meaning adds to a tool's score only when the tool stands out from the
 *   catalog for this query (a z-score above MEANING_FLOOR_Z), so a query close
 *   to nothing adds nothing.
 * - Tool vectors are computed once per tool text and kept; only the query is
 *   embedded per search. Without an embedder, or past the query's time budget,
 *   the search is the keyword search alone.
 * - The model runs once per host, in the embedding process (embedder-main.ts),
 *   asked over a local socket (embedder-socket.ts). While it is down or slow,
 *   searches rank by keywords and the tool vectors wait; they fill again once
 *   it answers.
 */
import { toolMeaningEnabled } from "~/lib/edition"
import { env } from "~/lib/env"
import { defaultEmbedderSocketPath, EmbedderUnavailable, socketEmbedder } from "./embedder-socket"
import { withoutCourtesy } from "./tool-lexicon"

/** Weight of one standard deviation of meaning above the floor, in keyword-score points. */
export const MEANING_WEIGHT = 4
/** A tool adds meaning only this many standard deviations above the catalog's mean. */
export const MEANING_FLOOR_Z = 2
/**
 * The floor for a tool the query's words matched only in part. Its closeness
 * is partly the very word that matched, which its keyword score already
 * counts, so it must stand out a little more before meaning lifts it past a
 * tool that matched another word of the request.
 */
export const MEANING_PARTIAL_FLOOR_Z = 2.6
/** Below this many tools with vectors, the catalog's spread says nothing: no meaning. */
const MIN_TOOLS_FOR_MEANING = 20

export type Vector = Float32Array | readonly number[]

/** What a search knows by meaning: the query's vector and each tool's. */
export interface ToolMeaning {
  query: Vector
  vectorOf(sdkName: string): Vector | undefined
}

function dot(a: Vector, b: Vector): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += (a[i] as number) * (b[i] as number)
  return s
}

/**
 * Meaning points per tool of `catalog` (sdkName to points, absent for none):
 * the query's similarity to each tool, as standard deviations above the
 * catalog's mean, past the floor, times the weight. Vectors are unit length.
 */
export function meaningPoints(
  catalog: ReadonlyArray<{ sdkName: string }>,
  meaning: ToolMeaning,
  /** The tools held to MEANING_PARTIAL_FLOOR_Z instead of MEANING_FLOOR_Z. */
  partial: ReadonlySet<string> = new Set(),
): Map<string, number> {
  const sims: Array<{ name: string; sim: number }> = []
  for (const t of catalog) {
    const v = meaning.vectorOf(t.sdkName)
    if (v) sims.push({ name: t.sdkName, sim: dot(meaning.query, v) })
  }
  const points = new Map<string, number>()
  if (sims.length < MIN_TOOLS_FOR_MEANING) return points
  const mean = sims.reduce((a, s) => a + s.sim, 0) / sims.length
  const sd = Math.sqrt(sims.reduce((a, s) => a + (s.sim - mean) ** 2, 0) / sims.length)
  if (!(sd > 0)) return points
  for (const s of sims) {
    const z = (s.sim - mean) / sd
    // A trace of z on every tool breaks keyword ties by meaning.
    const floor = partial.has(s.name) ? MEANING_PARTIAL_FLOOR_Z : MEANING_FLOOR_Z
    const p = MEANING_WEIGHT * Math.max(0, z - floor) + 1e-6 * z
    points.set(s.name, p)
  }
  return points
}

/** What a tool's embedded text is made of. */
export interface MeaningTextTool {
  appName: string
  toolName: string
  description: string
  keywords?: readonly string[]
}

/**
 * The text a tool is embedded from: its app, its name as words, its
 * description's opening, then its search keywords. The keywords are the words
 * people use for the tool (often French, where the name and description are
 * English), so they place it nearer the requests that use them.
 */
export function toolMeaningText(t: MeaningTextTool): string {
  const name = t.toolName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_.]+/g, " ")
    .toLowerCase()
  const keywords = t.keywords?.length ? ` (${t.keywords.join(", ")})` : ""
  return `${t.appName} ${name}: ${t.description.slice(0, 400)}${keywords}`
}

// ── The embedder and the tool vectors ────────────────────────────────────

/** Turns texts into unit vectors. `kind` lets a model tell a query from a document. */
export interface TextEmbedder {
  readonly id: string
  embed(texts: string[], kind: "query" | "document"): Promise<Vector[]>
}

/** How long a search waits for its query's vector before it ranks by keywords alone. */
export const QUERY_BUDGET_MS = 150
/** Tool texts embedded per call while the vectors fill. */
const DOCUMENT_BATCH = 4
/** How long one batch of tool texts may take on the embedding process. */
export const DOCUMENT_DEADLINE_MS = 30_000
/** After the embedding process failed to answer, how long the vectors wait before trying again. */
export const RETRY_AFTER_MS = 5_000

/**
 * Tool vectors, one per tool text, filled in the background the first time a
 * catalog is seen and kept for the life of the process. A changed description
 * is a new text and gets a new vector; nothing is embedded twice.
 */
export class ToolMeaningIndex {
  private readonly vectors = new Map<string, Vector>()
  private readonly pending = new Set<string>()
  private filling: Promise<void> | null = null
  private failed = false
  private retryAt = 0
  private readonly queryBudgetMs: number
  private readonly retryMs: number

  constructor(
    private readonly embedder: TextEmbedder,
    opts: { queryBudgetMs?: number; retryMs?: number } = {},
  ) {
    this.queryBudgetMs = opts.queryBudgetMs ?? QUERY_BUDGET_MS
    this.retryMs = opts.retryMs ?? RETRY_AFTER_MS
  }

  /** Queue the catalog's tools whose text has no vector yet. Never waits. */
  prepare(catalog: ReadonlyArray<MeaningTextTool>) {
    if (this.failed) return
    for (const t of catalog) {
      const text = toolMeaningText(t)
      if (!this.vectors.has(text)) this.pending.add(text)
    }
    if (!this.filling && this.pending.size > 0 && Date.now() >= this.retryAt)
      this.filling = this.fill()
  }

  /** Resolves when every queued text has its vector (tests and warm-up). */
  async ready(): Promise<void> {
    while (this.filling) await this.filling
  }

  private async fill(): Promise<void> {
    try {
      while (this.pending.size > 0) {
        const batch = [...this.pending].slice(0, DOCUMENT_BATCH)
        const out = await this.embedder.embed(batch, "document")
        batch.forEach((text, i) => {
          const v = out[i]
          if (v) this.vectors.set(text, v)
          this.pending.delete(text)
        })
        // Yield between batches so requests keep their turn on the event loop.
        await new Promise((r) => setTimeout(r, 0))
      }
    } catch (err) {
      if (err instanceof EmbedderUnavailable) {
        // The embedding process is down or slow (its client logged it once):
        // the queued texts wait, and a search after the pause tries again.
        this.retryAt = Date.now() + this.retryMs
        return
      }
      // A model that cannot run leaves the search on keywords; it is not retried.
      this.failed = true
      this.pending.clear()
      const embedder = this.embedder.id
      void import("~/lib/logger")
        .then(({ rootLogger }) =>
          rootLogger.warn(
            { err, embedder },
            "tool search: the embedding model could not run, so tools rank by words alone",
          ),
        )
        .catch(() => {})
    } finally {
      this.filling = null
    }
  }

  /**
   * The meaning for one search over `catalog`, or null when there is none to
   * add: no tool vectors yet, the query embedding failed, or it took longer
   * than the budget.
   */
  async meaningFor<T extends MeaningTextTool & { sdkName: string }>(
    query: string,
    catalog: readonly T[],
    budgetMs: number = this.queryBudgetMs,
  ): Promise<ToolMeaning | null> {
    this.prepare(catalog)
    const byName = new Map<string, Vector>()
    for (const t of catalog) {
      const v = this.vectors.get(toolMeaningText(t))
      if (v) byName.set(t.sdkName, v)
    }
    if (byName.size < MIN_TOOLS_FOR_MEANING) return null
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), budgetMs)
    })
    const vector = await Promise.race([
      this.embedder.embed([withoutCourtesy(query)], "query").then(
        (v) => v[0] ?? null,
        () => null,
      ),
      late,
    ])
    clearTimeout(timer)
    if (!vector) return null
    return { query: vector, vectorOf: (n) => byName.get(n) }
  }
}

// ── The process's index ──────────────────────────────────────────────────

let index: ToolMeaningIndex | null | undefined

/**
 * The embedder tool search uses, chosen once per process: with meaning off
 * (lib/edition.ts toolMeaningEnabled: `LIAISON_TOOL_MEANING`, unset follows
 * the edition) the search ranks by words; on, it asks the host's embedding
 * process over its socket (`LIAISON_EMBEDDER_SOCKET`, within
 * `LIAISON_EMBEDDER_DEADLINE_MS` per query), and stays on keywords while that
 * process does not answer. A test sets its own with setToolEmbedder.
 */
export function toolMeaningIndex(): ToolMeaningIndex | null {
  if (index !== undefined) return index
  // A test process ranks by words unless its test sets an embedder: results stay
  // deterministic and no model is fetched.
  const testProcess = process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
  if (testProcess || !toolMeaningEnabled()) {
    index = null
    return index
  }
  const deadline = env.LIAISON_EMBEDDER_DEADLINE_MS
  index = new ToolMeaningIndex(
    socketEmbedder({
      socketPath: defaultEmbedderSocketPath({
        LIAISON_EMBEDDER_SOCKET: env.LIAISON_EMBEDDER_SOCKET,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      }),
      queryDeadlineMs: deadline,
      documentDeadlineMs: DOCUMENT_DEADLINE_MS,
    }),
    { queryBudgetMs: deadline },
  )
  return index
}

/** Tests: the embedder tool search uses (null for none); undefined restores the default. */
export function setToolEmbedder(embedder: TextEmbedder | null | undefined): void {
  index = embedder === undefined ? undefined : embedder ? new ToolMeaningIndex(embedder) : null
}
