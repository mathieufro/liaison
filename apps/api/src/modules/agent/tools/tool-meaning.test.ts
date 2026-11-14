// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tool search adds meaning to its keyword ranking: a tool that shares no word
// with a request can rank on what it does. Fixed vectors stand in for the
// model, so every result here is deterministic.
import { describe, expect, it } from "bun:test"
import {
  MEANING_FLOOR_Z,
  MEANING_PARTIAL_FLOOR_Z,
  MEANING_WEIGHT,
  meaningPoints,
  type TextEmbedder,
  type ToolMeaning,
  ToolMeaningIndex,
  toolMeaningText,
} from "./tool-meaning"
import { rankDeferredTools } from "./tool-rank"

interface Row {
  sdkName: string
  toolName: string
  appName: string
  description: string
  locked?: boolean
}

const row = (appName: string, toolName: string, description: string): Row => ({
  sdkName: `${appName}__${toolName}`,
  toolName,
  appName,
  description,
})

// Thirty filler tools give the catalog a spread to measure "stands out" against.
const FILLER = Array.from({ length: 30 }, (_, i) =>
  row("misc", `thing_${i}`, `Does unrelated chore number ${i}.`),
)
const DEACTIVATE = row("kernel", "deactivate_user", "Turn off a member's account.")
const ARCHIVE = row("projects", "archive_project", "Archive a project.")
const LABELS = row("projects", "labels_archive", "Archive a label.")
const HIDDEN = row("admin", "wipe_org", "Delete every record of the organization.")
const CATALOG: Row[] = [...FILLER, DEACTIVATE, ARCHIVE, LABELS]

// Unit vectors on a few axes: axis 0 is "someone leaves", axis 1 "archiving labels".
const DIM = 40
const unit = (axis: number, lean = 0, leanAxis = 0) => {
  const v = new Array(DIM).fill(0)
  v[axis] = 1
  if (lean) v[leanAxis] = lean
  const n = Math.hypot(...v)
  return v.map((x) => x / n)
}
const VECTORS = new Map<string, number[]>([
  ...FILLER.map((t, i) => [t.sdkName, unit(5 + (i % 30))] as [string, number[]]),
  [DEACTIVATE.sdkName, unit(0)],
  [ARCHIVE.sdkName, unit(2)],
  [LABELS.sdkName, unit(1)],
  [HIDDEN.sdkName, unit(0)],
])
const meaningOf = (query: number[]): ToolMeaning => ({
  query,
  vectorOf: (n) => VECTORS.get(n),
})
const opts = (meaning?: ToolMeaning) => ({
  cap: 5,
  appNames: ["misc", "projects", "admin"],
  meaning,
})

describe("tool search by meaning", () => {
  it("ranks a tool no word of the request matches when its meaning stands out", () => {
    const query = "Marc left the company, cut his access"
    const words = rankDeferredTools(CATALOG, query, opts())
    expect(words.ranked.map((s) => s.tool.sdkName)).not.toContain(DEACTIVATE.sdkName)
    const both = rankDeferredTools(CATALOG, query, opts(meaningOf(unit(0))))
    expect(both.ranked[0]?.tool.sdkName).toBe(DEACTIVATE.sdkName)
  })

  it("keeps what the keywords load ahead of a closer meaning", () => {
    const words = rankDeferredTools(CATALOG, "archive project", opts())
    expect(words.strongNames.has(ARCHIVE.sdkName)).toBe(true)
    // The query's meaning points at labels, not at the project tool.
    const both = rankDeferredTools(CATALOG, "archive project", opts(meaningOf(unit(1))))
    expect(both.ranked[0]?.tool.sdkName).toBe(ARCHIVE.sdkName)
    expect(both.strongNames).toEqual(words.strongNames)
  })

  it("never surfaces a tool outside the catalog it is handed, whatever its vector", () => {
    // HIDDEN's vector is the query's own, but the caller cannot reach it.
    const both = rankDeferredTools(CATALOG, "cut his access", opts(meaningOf(unit(0))))
    const names = both.all.map((s) => s.tool.sdkName)
    expect(names).not.toContain(HIDDEN.sdkName)
    expect(meaningPoints(CATALOG, meaningOf(unit(0))).has(HIDDEN.sdkName)).toBe(false)
  })

  it("adds nothing for a query close to no tool", () => {
    const flat = new Array(DIM).fill(1 / Math.sqrt(DIM))
    const words = rankDeferredTools(CATALOG, "zzz qqq", opts())
    const both = rankDeferredTools(CATALOG, "zzz qqq", opts(meaningOf(flat)))
    expect(both.all.map((s) => s.tool.sdkName)).toEqual(words.all.map((s) => s.tool.sdkName))
    expect(both.ranked).toHaveLength(0)
  })

  it("ranks a usable tool above a locked one, meaning or not", () => {
    const locked = { ...DEACTIVATE, locked: true }
    const catalog = [
      ...FILLER,
      locked,
      ARCHIVE,
      LABELS,
      row("kernel", "remove_member", "Remove a member."),
    ]
    VECTORS.set("kernel__remove_member", unit(0, 0.3, 3))
    const both = rankDeferredTools(catalog, "Marc left", opts(meaningOf(unit(0))))
    const order = both.ranked.map((s) => s.tool.sdkName)
    expect(order.indexOf("kernel__remove_member")).toBeLessThan(order.indexOf(DEACTIVATE.sdkName))
  })

  it("leaves the keyword ranking unchanged without meaning", () => {
    const a = rankDeferredTools(CATALOG, "archive", opts())
    const b = rankDeferredTools(CATALOG, "archive", { ...opts(), meaning: null })
    expect(b.all.map((s) => [s.tool.sdkName, s.score])).toEqual(
      a.all.map((s) => [s.tool.sdkName, s.score]),
    )
  })

  it("gives a tool points only past the floor", () => {
    const points = meaningPoints(CATALOG, meaningOf(unit(0)))
    expect(points.get(DEACTIVATE.sdkName) ?? 0).toBeGreaterThan(MEANING_FLOOR_Z)
    expect(points.get(FILLER[0]?.sdkName ?? "") ?? 0).toBeLessThan(0.01)
  })

  it("holds a tool the words matched in part to the higher floor", () => {
    const full = meaningPoints(CATALOG, meaningOf(unit(0)))
    const held = meaningPoints(CATALOG, meaningOf(unit(0)), new Set([DEACTIVATE.sdkName]))
    const gap = (full.get(DEACTIVATE.sdkName) ?? 0) - (held.get(DEACTIVATE.sdkName) ?? 0)
    expect(gap).toBeCloseTo(MEANING_WEIGHT * (MEANING_PARTIAL_FLOOR_Z - MEANING_FLOOR_Z), 5)
    expect(held.get(ARCHIVE.sdkName)).toBe(full.get(ARCHIVE.sdkName))
  })
})

describe("tool vectors", () => {
  const stub = () => {
    const seen: string[] = []
    let queries = 0
    let fail = false
    let delayMs = 0
    const embedder: TextEmbedder = {
      id: "stub",
      async embed(texts, kind) {
        if (kind === "query") {
          queries++
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
          if (fail) throw new Error("model down")
          return texts.map(() => unit(0))
        }
        seen.push(...texts)
        return texts.map((t) => {
          const tool = CATALOG.find((c) => toolMeaningText(c) === t)
          return tool ? (VECTORS.get(tool.sdkName) ?? unit(39)) : unit(39)
        })
      },
    }
    return {
      embedder,
      seen,
      queries: () => queries,
      failQueries: () => {
        fail = true
      },
      slowQueries: (ms: number) => {
        delayMs = ms
      },
    }
  }

  it("embeds each tool text once across searches and again when it changes", async () => {
    const s = stub()
    const index = new ToolMeaningIndex(s.embedder)
    index.prepare(CATALOG)
    await index.ready()
    await index.meaningFor("q one", CATALOG)
    await index.meaningFor("q two", CATALOG)
    await index.ready()
    expect(s.seen).toHaveLength(CATALOG.length)
    expect(s.queries()).toBe(2)
    const changed = CATALOG.map((t) =>
      t === ARCHIVE ? { ...t, description: "Archive a project and its tasks." } : t,
    )
    index.prepare(changed)
    await index.ready()
    expect(s.seen).toHaveLength(CATALOG.length + 1)
  })

  it("answers with no meaning while the tool vectors are not ready, and spends no query", async () => {
    const s = stub()
    const index = new ToolMeaningIndex(s.embedder)
    expect(await index.meaningFor("q", CATALOG)).toBeNull()
    expect(s.queries()).toBe(0)
    await index.ready()
    expect(await index.meaningFor("q", CATALOG)).not.toBeNull()
  })

  it("falls back to keywords when the query embedding fails or is late", async () => {
    const s = stub()
    const index = new ToolMeaningIndex(s.embedder)
    index.prepare(CATALOG)
    await index.ready()
    s.slowQueries(50)
    expect(await index.meaningFor("q", CATALOG, 5)).toBeNull()
    s.slowQueries(0)
    s.failQueries()
    expect(await index.meaningFor("q", CATALOG)).toBeNull()
  })

  it("stays on keywords, without retrying, when the model cannot embed the tools", async () => {
    let calls = 0
    const broken: TextEmbedder = {
      id: "broken",
      async embed() {
        calls++
        throw new Error("model files missing")
      },
    }
    const index = new ToolMeaningIndex(broken)
    index.prepare(CATALOG)
    await index.ready()
    index.prepare(CATALOG)
    await index.ready()
    expect(await index.meaningFor("q", CATALOG)).toBeNull()
    expect(calls).toBe(1)
  })

  it("knows only the vectors of the catalog it is asked about", async () => {
    const s = stub()
    const index = new ToolMeaningIndex(s.embedder)
    index.prepare([...CATALOG, HIDDEN])
    await index.ready()
    const meaning = await index.meaningFor("cut access", CATALOG)
    expect(meaning?.vectorOf(HIDDEN.sdkName)).toBeUndefined()
    expect(meaning?.vectorOf(DEACTIVATE.sdkName)).toBeDefined()
  })
})

describe("the text a tool is embedded from", () => {
  const close = { appName: "tickets", toolName: "close", description: "Close a ticket." }

  it("carries the tool's search keywords after its description's opening", () => {
    const text = toolMeaningText({ ...close, keywords: ["fermer", "resolve"] })
    expect(text.startsWith(toolMeaningText(close))).toBe(true)
    expect(text).toContain("fermer")
    expect(text).toContain("resolve")
  })

  it("is a new text when a keyword changes, so the tool gets a new vector", () => {
    expect(toolMeaningText({ ...close, keywords: ["fermer"] })).not.toBe(
      toolMeaningText({ ...close, keywords: ["clore"] }),
    )
  })
})
