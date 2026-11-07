// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tool-finding bench, with no server, database or env: the corpus against
// the catalog read from source, the baseline of each typed form, the catalog
// lint and the known bad answers. Runs in the guards suite on every change.

import { describe, expect, it } from "bun:test"
import { rankDeferredTools } from "../tool-rank"
import {
  type Baseline,
  bar,
  type CorpusLine,
  catalogBars,
  corpusShapeErrors,
  type FormRun,
  type LintInput,
  lint,
  loadGuides,
  mustNotBroken,
  regressions,
  runForms,
  toolsFromMain,
  unknownCorpusTools,
  updatedBaseline,
} from "./bench"
import { type BenchTool, loadBenchCatalog, searchableTools } from "./catalog"
import { readBenchFiles, runBench } from "./run"

const started = performance.now()
const catalog = loadBenchCatalog()
const files = readBenchFiles()

function tool(sdkName: string, over: Partial<BenchTool> = {}): BenchTool {
  const [appName, toolName] = sdkName.split("__") as [string, string]
  return {
    sdkName,
    toolName,
    appName,
    description: `Does ${toolName.replace(/_/g, " ")}.`,
    keywords: ["faire"],
    deferred: true,
    agentVisible: true,
    routineOnly: false,
    schemaChars: 40,
    ...over,
  }
}

function line(id: string, typed: string[], any: string[]): CorpusLine {
  return { id, set: "seed", lang: "en", say: typed[0] ?? "", typed, any }
}

describe("the corpus", () => {
  it("every line has the corpus shape", () => {
    expect(corpusShapeErrors(files.corpus)).toEqual([])
  })

  it("a line with an unknown field is refused", () => {
    expect(corpusShapeErrors([{ ...line("X1", ["a"], ["a__b"]), stage: "later" }])).toEqual([
      'X1: unknown field "stage"',
    ])
  })

  it("every tool a line names exists in the catalog", () => {
    expect(unknownCorpusTools(files.corpus, catalog)).toEqual([])
  })
})

describe("each typed form against the baseline", () => {
  it("no form that reached its tool has fallen out of the top 5", () => {
    expect(regressions(runForms(catalog, files.corpus), files.baseline)).toEqual([])
  })

  it("every form has a baseline result", () => {
    const missing = runForms(catalog, files.corpus)
      .map((r) => r.key)
      .filter((k) => files.baseline.forms[k] === undefined)
    expect(missing).toEqual([])
  })

  it("a fixture adding invoice_everything fails naming it", () => {
    // Four tools outrank the wanted one, and the new tool ties with it at the
    // cut. Registered last, it would rank below the wanted tool by order alone;
    // counted against it, the tie pushes the wanted tool out of the top 5.
    const base = [
      ...["one", "two", "three", "four"].map((n) => tool(`invoicing__find_invoice_${n}`)),
      tool("invoicing__invoice_search", { keywords: ["find"] }),
    ]
    const corpus = [line("X1", ["find invoice"], ["invoicing__invoice_search"])]
    const before = updatedBaseline(base, runForms(base, corpus), {
      tools: Object.fromEntries(base.map((t) => [t.sdkName, { desc: 0, schema: 0 }])),
      forms: {},
    })
    expect(before.forms["X1|find invoice"]).toContain("t")
    const after = [...base, tool("invoicing__invoice_everything", { keywords: ["find"] })]
    const [failure] = regressions(runForms(after, corpus), before)
    expect(failure).toContain("invoicing__invoice_everything (new)")
    expect(failure).toContain('X1 "find invoice"')
  })

  // The bench stays cheap enough to run on every change. Its cost is one ranking of the searchable
  // catalog per typed form, so the bound is on that work: the number of tool scorings, and the CPU
  // time the ranking itself takes. Wall clock is only printed: a loaded CI runner stretches it with
  // no change here. Today: 326 forms over 603 tools, about 0.2 M scorings and 0.7 s of CPU.
  it("ranks within its budget of tool scorings and CPU time", () => {
    const scorings =
      files.corpus.reduce((n, l) => n + l.typed.length, 0) * searchableTools(catalog).length
    const cpuBefore = process.cpuUsage()
    runForms(catalog, files.corpus)
    const cpu = process.cpuUsage(cpuBefore)
    const rankingCpuMs = (cpu.user + cpu.system) / 1000
    const report = runBench(files, catalog)
    const ms = performance.now() - started
    console.log(
      `tool-bench: ${Math.round(ms)} ms wall, ${Math.round(rankingCpuMs)} ms ranking CPU, ${scorings} scorings\n${report.lines.join("\n")}`,
    )
    expect(scorings).toBeLessThan(400_000)
    expect(rankingCpuMs).toBeLessThan(5_000)
  })
})

describe("the catalog lint", () => {
  const known = tool("shop__orders_get")
  const baseline: Baseline = {
    tools: { [known.sdkName]: { desc: known.description.length, schema: 10 } },
    forms: {},
  }
  const input = (tools: BenchTool[], over: Partial<LintInput> = {}): LintInput => ({
    catalog: [known, ...tools],
    corpus: [line("X1", ["x"], tools.map((t) => t.sdkName).concat(known.sdkName))],
    baseline,
    screenWords: [],
    allowedDuplicates: [],
    guides: [],
    ...over,
  })

  it("the catalog breaks no lint rule", () => {
    expect(
      lint({
        catalog,
        corpus: files.corpus,
        baseline: files.baseline,
        screenWords: files.screenWords,
        allowedDuplicates: files.allowedDuplicates,
        guides: loadGuides(),
      }),
    ).toEqual([])
  })

  it("a fixture tool written by the rules passes", () => {
    expect(lint(input([tool("shop__refunds_send")]))).toEqual([])
  })

  it("new tool with no line", () => {
    const t = tool("shop__refunds_send")
    expect(lint(input([t], { corpus: [] }))).toContain(
      "shop__refunds_send: a new agent-visible tool with no corpus line",
    )
  })

  it("kernel tool with no explicit deferLoading", () => {
    const t = tool("kernel__away_set", { deferred: false })
    expect(lint(input([t]))).toContain(
      "kernel__away_set: a new kernel tool must state deferLoading",
    )
    expect(lint(input([{ ...t, declaredDeferLoading: false }]))).toEqual([])
  })

  it("no French keywords", () => {
    const t = tool("shop__refunds_send", { keywords: ["refunds", "send"] })
    expect(lint(input([t]))).toContain("shop__refunds_send: no French searchKeywords")
    expect(lint(input([{ ...t, keywords: ["remboursement"] }]))).toEqual([])
  })

  it("duplicate bare name with no reason", () => {
    const t = tool("pay__orders_get")
    expect(lint(input([t])).join("\n")).toContain(
      'the bare name "orders_get" is also shop__orders_get',
    )
    expect(
      lint(input([t], { allowedDuplicates: [{ name: "orders_get", reason: "two systems" }] })),
    ).toEqual([])
  })

  it("same first 140 characters", () => {
    const description = `${"Read an order of the shop with its lines and totals. ".repeat(3)}Then more.`
    const a = tool("shop__orders_read", { description })
    const b = tool("shop__orders_peek", { description: `${description} Also refunds.` })
    expect(lint(input([a, b])).join("\n")).toContain("the same first 140 characters")
  })

  it("description 601 characters, 600 passes", () => {
    const at = (n: number) => tool("shop__refunds_send", { description: "a".repeat(n) })
    expect(lint(input([at(600)]))).toEqual([])
    expect(lint(input([at(601)]))).toContain(
      "shop__refunds_send: description 601 characters, over 600",
    )
  })

  it("an existing description may not grow", () => {
    const grown = { ...known, description: `${known.description} More.` }
    expect(lint({ ...input([]), catalog: [grown] }).join("\n")).toContain(
      "shop__orders_get: description grew",
    )
  })

  it("schema 601 tokens, 600 passes", () => {
    const at = (tokens: number) => tool("shop__refunds_send", { schemaChars: tokens * 4 })
    expect(lint(input([at(600)]))).toEqual([])
    expect(lint(input([at(601)]))).toContain(
      "shop__refunds_send: schema about 601 tokens, over 600",
    )
  })

  it("screen word not a keyword", () => {
    const words = [{ word: "Next in line", tool: "shop__orders_get" }]
    expect(lint(input([], { screenWords: words }))).toContain(
      'screen word "Next in line" is not a keyword of shop__orders_get',
    )
    expect(lint(input([], { screenWords: [{ word: "FAIRE", tool: "shop__orders_get" }] }))).toEqual(
      [],
    )
  })

  it("a guide names a tool that does not exist", () => {
    const guides = [{ where: "guide.md", text: "Call shop__orders_get, then shop__orders_gone." }]
    expect(lint(input([], { guides }))).toEqual([
      "guide.md names shop__orders_gone, which is not a tool",
    ])
  })
})

describe("known bad answers stay fixed", () => {
  const searchable = searchableTools(catalog)
  const appNames = new Set(searchable.map((t) => t.appName).filter((a) => a !== "kernel"))

  it("every known bad answer in must-not.json stays fixed", () => {
    expect(files.mustNot.length).toBeGreaterThanOrEqual(7)
    expect(mustNotBroken(catalog, files.mustNot)).toEqual([])
  })

  it("a broken line is reported", () => {
    const loud = [tool("shop__la_list", { keywords: ["la"] })]
    expect(mustNotBroken(loud, [{ query: "list", loadsOnlyApps: [] }])).toEqual([
      '"list" loads shop__la_list',
    ])
    expect(mustNotBroken(loud, [{ query: "list", notFirst: "shop__la_list" }])).toEqual([
      '"list" leads with shop__la_list',
    ])
  })

  it("a French filler word alone loads nothing", () => {
    for (const word of ["la", "le", "de", "du", "des", "une"]) {
      const { strongNames } = rankDeferredTools(searchable, word, { cap: 5, appNames })
      expect([...strongNames], word).toEqual([])
    }
  })

  it("a word under 3 letters matches no part of a longer word", () => {
    const tools = [tool("shop__xylophone_list", { keywords: [], description: "Xylophones." })]
    expect(rankDeferredTools(tools, "xy", { cap: 5, appNames: [] }).all).toEqual([])
    expect(rankDeferredTools(tools, "xyl", { cap: 5, appNames: [] }).all).toHaveLength(1)
  })

  it("a word matches the start of a word, never its middle", () => {
    const tools = [tool("shop__abandoned_list", { keywords: [], description: "Abandoned carts." })]
    expect(rankDeferredTools(tools, "done", { cap: 5, appNames: [] }).all).toEqual([])
  })

  it("a word found only in descriptions lists tools but loads none", () => {
    const tools = [
      {
        ...tool("shop__orders_get"),
        keywords: [],
        description: "Read an order and its signature.",
      },
    ].map((t) => ({ ...t, sdkName: t.sdkName }))
    const { ranked, strongNames } = rankDeferredTools(tools, "signature", { cap: 5, appNames: [] })
    expect(ranked.map((s) => s.tool.sdkName)).toEqual(["shop__orders_get"])
    expect([...strongNames]).toEqual([])
  })
})

describe("tools that arrive from main", () => {
  it("a tool arriving by merge is listed by --update --from-main, a tool written on the branch is not", () => {
    const old = tool("shop__orders_get")
    const merged = tool("shop__orders_cancel")
    const ours = tool("shop__refunds_send")
    const baseline: Baseline = { tools: { [old.sdkName]: { desc: 1, schema: 1 } }, forms: {} }
    const arrived = toolsFromMain([old, merged, ours], baseline, [old, merged])
    expect(arrived.map((t) => t.sdkName)).toEqual(["shop__orders_cancel"])
    const next = updatedBaseline([old, merged, ours], [], baseline, arrived)
    expect(Object.keys(next.tools)).toEqual(["shop__orders_cancel", "shop__orders_get"])
  })

  it("--update alone adds no tool", () => {
    const old = tool("shop__orders_get")
    const ours = tool("shop__refunds_send")
    const baseline: Baseline = { tools: { [old.sdkName]: { desc: 1, schema: 1 } }, forms: {} }
    expect(Object.keys(updatedBaseline([old, ours], [], baseline).tools)).toEqual([
      "shop__orders_get",
    ])
  })
})

describe("bars", () => {
  it("a class of 10 lines or more is held to its share", () => {
    expect(bar(17, 20, 85).ok).toBe(true)
    expect(bar(16, 20, 85).ok).toBe(false)
  })

  it("from 5 to 9 lines, at most 1 missed; under 5, reported only", () => {
    expect(bar(8, 9, 85)).toMatchObject({ kind: "count", ok: true })
    expect(bar(7, 9, 85)).toMatchObject({ kind: "count", ok: false })
    expect(bar(0, 4, 85)).toMatchObject({ kind: "none", ok: true })
  })
})

describe("bars hold on the catalog", () => {
  const run = (lang: "fr" | "en", reached: boolean): FormRun => ({
    key: `${lang}${Math.random()}`,
    form: "x",
    line: { id: "L", set: "seed", lang, say: "x", typed: ["x"], any: ["a__b"] },
    result: {
      top1: reached,
      top5: reached,
      top5Ties: reached,
      loaded: reached,
      zeroHit: false,
      above: [],
    },
  })
  /** 100 forms, `fr` of them French; `miss` English and `frMiss` French forms missed. */
  const fixture = (miss: number, frMiss: number) => [
    ...Array.from({ length: 80 }, (_, i) => run("en", i >= miss)),
    ...Array.from({ length: 20 }, (_, i) => run("fr", i >= frMiss)),
  ]

  it("85% overall: 84 of 100 misses, 85 and 86 hold", () => {
    expect(catalogBars(fixture(16, 0)).overall.ok).toBe(false) // 84
    expect(catalogBars(fixture(15, 0)).overall.ok).toBe(true) // 85
    expect(catalogBars(fixture(14, 0)).overall.ok).toBe(true) // 86
  })

  it("80% French: 15 of 20 misses by one, 16 and 17 hold", () => {
    expect(catalogBars(fixture(0, 5)).french.ok).toBe(false) // 15 of 20 = 75
    expect(catalogBars(fixture(0, 4)).french.ok).toBe(true) // 16 of 20 = 80
    expect(catalogBars(fixture(0, 3)).french.ok).toBe(true) // 17 of 20
  })

  it("a French class under 10 forms is held to a count bar, not a share", () => {
    const few = [...Array.from({ length: 8 }, (_, i) => run("fr", i > 0)), run("en", true)]
    expect(catalogBars(few).french).toMatchObject({ kind: "count", ok: true })
  })

  it("the catalog holds both bars", () => {
    const bars = catalogBars(runForms(catalog, files.corpus))
    expect(bars.overall.ok).toBe(true)
    expect(bars.french.ok).toBe(true)
  })
})
