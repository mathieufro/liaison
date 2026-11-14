// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Measures tool search with and without the meaning score, on a real
 * embedder: the corpus's typed forms, plus any line files given with `--file`
 * (`{ v: 1, lines: [{ id, lang, class, text, mustReach }] }`). Not a test: it
 * loads a model and prints counts, query latency and memory.
 *
 *   bun apps/api/src/modules/agent/tools/tool-bench/meaning.ts [--file <lines.json>]...
 *
 * The local model (local-embedder.ts), its files in LIAISON_MODEL_CACHE_DIR.
 */
import { readFileSync } from "node:fs"
import { loadLocalEmbedder } from "../local-embedder"
import { ToolMeaningIndex } from "../tool-meaning"
import { appNamesOf, type CorpusLine, rankForm } from "./bench"
import { loadBenchCatalog, REPO_ROOT, searchableTools } from "./catalog"

interface Line {
  set: string
  id: string
  lang: string
  cls: string
  text: string
  want: string[]
}

const args = process.argv.slice(2)
const lines: Line[] = []
const corpus = JSON.parse(
  readFileSync(new URL("./corpus.json", import.meta.url), "utf8"),
) as CorpusLine[]
for (const l of corpus)
  for (const f of l.typed)
    lines.push({ set: "corpus", id: l.id, lang: l.lang, cls: l.set, text: f, want: l.any })
for (let i = 0; i < args.length; i++) {
  if (args[i] !== "--file") continue
  const file = args[++i] ?? ""
  const set = file.replace(/^.*\//, "").replace(/\.json$/, "")
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    lines: Array<{ id: string; lang: string; class: string; text: string; mustReach: string[] }>
  }
  for (const l of parsed.lines)
    lines.push({ set, id: l.id, lang: l.lang, cls: l.class, text: l.text, want: l.mustReach })
}

const mb = () => Math.round(process.memoryUsage().rss / 1e6)
const catalog = loadBenchCatalog(REPO_ROOT)
const searchable = searchableTools(catalog)
const appNames = appNamesOf(catalog)
const held = new Set(
  catalog.filter((t) => t.agentVisible && !t.deferred && !t.routineOnly).map((t) => t.sdkName),
)

const rssBefore = mb()
let t0 = performance.now()
const embedder = await loadLocalEmbedder()
const index = new ToolMeaningIndex(embedder)
index.prepare(searchable)
await index.ready()
console.log(
  `${embedder.id}: ${searchable.length} tools embedded in ${Math.round(performance.now() - t0)} ms; rss ${rssBefore} -> ${mb()} MB`,
)

const hits: Array<{ line: Line; before: boolean; after: boolean }> = []
const latency: number[] = []
for (const line of lines) {
  const isHeld = line.want.some((n) => held.has(n))
  t0 = performance.now()
  const meaning = await index.meaningFor(line.text, searchable, 10_000)
  const after = isHeld || rankForm(searchable, appNames, line.text, line.want, meaning).top5Ties
  latency.push(performance.now() - t0)
  const before = isHeld || rankForm(searchable, appNames, line.text, line.want).top5Ties
  hits.push({ line, before, after })
}
latency.sort((a, b) => a - b)
const pct = (p: number) =>
  latency[Math.min(latency.length - 1, Math.floor(latency.length * p))] ?? 0
console.log(
  `query (embed + rank, ${searchable.length} tools): p50 ${pct(0.5).toFixed(1)} ms, p95 ${pct(0.95).toFixed(1)} ms; rss ${mb()} MB`,
)

for (const set of [...new Set(lines.map((l) => l.set))]) {
  const of = hits.filter((h) => h.line.set === set)
  const cut = (name: string, pred: (l: Line) => boolean) => {
    const o = of.filter((h) => pred(h.line))
    if (o.length === 0) return ""
    return ` ${name} ${o.filter((h) => h.before).length}->${o.filter((h) => h.after).length}/${o.length}`
  }
  const lost = of.filter((h) => h.before && !h.after).map((h) => h.line.id)
  console.log(
    `${set}: ${of.filter((h) => h.before).length} -> ${of.filter((h) => h.after).length}/${of.length};` +
      cut("indirect", (l) => l.cls === "indirect") +
      cut("typo", (l) => l.cls === "typo") +
      cut("en", (l) => l.lang === "en") +
      cut("fr", (l) => l.lang === "fr") +
      `; lost ${lost.length}${lost.length ? ` (${lost.join(" ")})` : ""}`,
  )
}
