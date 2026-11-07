// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EVERY MODEL CALL IS METERED. On a managed cell a model call made for an org
// spends the cell's key, so it must reach `finalizeUsage` (directly, or through
// `meterSideCall` for a side call) and debit that org's allowance; a call that
// does not is spend the usage report never sees. Side calls (memory consolidation, checkpoint
// briefs, auto-titles, web extraction) were once unmetered; this guard keeps
// every model call metered.
//
// This guard lists every file that builds a model on a key or sends a request
// to a model provider, with its metering disposition:
//   - "meters": the file itself reaches a metering entry point;
//   - { via: [...] }: a primitive whose callers meter; each caller must be a
//     "meters" file that really does;
//   - { none: "..." }: no paid call (a catalogue read) or not a call made for
//     an org, with the reason.
// A new file that calls a model fails here until it is added WITH its
// disposition, so a model call cannot appear unmetered and unreviewed.
//
// PER CALL SITE. A file-level check is not enough: a file that meters one call
// can carry a second, unmetered one (the memory flush inside the compaction
// file, next to the metered summary, was exactly that). So every call site is
// also checked on its own (`checkCallSites`): a site is a call that spends on a
// provider (the AI SDK's generateText/streamText/generateObject/streamObject/
// embed/embedMany, Gemini's `models.generateContent`, a raw request to
// `chat/completions`, `embeddings` or `audio/transcriptions`) or a call to a
// reviewed "metered by its callers" function (DELEGATED). For each site, the
// nearest enclosing function that holds a metering call must hold at least as
// many metering calls as it holds sites; a site with no such function fails.
// A DELEGATED function's own sites are skipped, and every call to it, in any
// file, is a site of its caller. EXEMPT names a function whose sites are
// reviewed by hand, with the reason.
//
// THE MUTATIONS THAT PROVE THIS BITES
//  * Add a `generateText(` call in a new file: "lists exactly the files" fails.
//  * Drop `meterSideCall` from auto-title.ts: "meters" files must meter fails.
//  * Drop the memory flush's `meterSideCall` (the original gap, in a file that
//    still meters its summary): the per-site check fails, pinned below by
//    "would have caught the unmetered memory flush".
//  * Add a second, unmetered generateText next to a metered one: per-site fails.
// What a static check cannot see is a meter skipped at run time: the original
// flush metered only when handed a credit, and its compaction caller handed it
// none. That half is closed by the type (`runMemoryFlush`'s `credit` is
// required) and by managed-side-call-metering.test.ts.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const SRC = path.resolve(import.meta.dir, "..", "..", "..")

/** Building a model on a key, or sending a request to a model provider. */
const MODEL_CALL =
  /\b(generateText|streamText|generateObject|streamObject|embedMany|resolveModelFromCredit|resolveSideCallModel|createOpenRouterModel|openRouterFetch|openRouterThreadFetch|openRouterEmbed|openRouterWebSearch|runModelTestCall|createGoogle|createOpenAICompatible|createAnthropic|createOpenAI|createMistral)\(|["'`/]chat\/completions|["'`/]embeddings["'`]|["'`]\/audio\/transcriptions/

/** The metering entry points: every usage row is written by `finalizeUsage`. */
const METERS = /\b(finalizeUsage|meterSideCall)\(/

type Disposition = "meters" | { via: string[] } | { none: string }

const REVIEWED: Record<string, Disposition> = {
  "modules/agent/runtime/agent-service.ts": "meters", // a turn: finalizeUsage per turn
  "modules/agent/subruns/subrun-worker.ts": "meters", // a sub-run: finalizeUsage per run
  "modules/agent/context/compaction.ts": "meters", // summary finalizeUsage, memory flush meterSideCall
  "modules/agent/context/checkpoint.ts": "meters", // brief + brief rows: meterSideCall
  "modules/agent/context/warm-compaction.ts": "meters", // idle brief: meterSideCall
  "modules/agent/memory/consolidation.ts": "meters", // flush (via runMemoryFlush), facts, episode
  "modules/agent/runtime/auto-title.ts": "meters", // preCheck + meterSideCall
  "modules/agent/tools/web-tools.ts": "meters", // web_search finalizeUsage, extraction meterSideCall
  "modules/apps/sandbox/bridge/tickets.ts": "meters", // ticket summary finalizeUsage
  "modules/assist/proofread-service.ts": "meters", // magic wand finalizeUsage
  "modules/assist/transcribe-service.ts": "meters", // dictation finalizeUsage
  "modules/search/message-indexer.ts": "meters", // managed embed batch finalizeUsage (self-hosted Google: no credits, S19)
  "modules/settings/ai-models-admin.ts": "meters", // add-model test call: finalizeUsage on the cell's key
  "modules/agent/credits/unreported-generations.ts": "meters", // GET /generation recovers a stopped step's cost into finalizeUsage
  "modules/agent/credits/model-test-call.ts": { via: ["modules/settings/ai-models-admin.ts"] },
  "modules/agent/media/media-analysis-client.ts": {
    via: ["modules/agent/media/media-analysis-tool.ts", "modules/files/media-analysis-job.ts"],
  },
  "modules/agent/providers/openrouter-embeddings.ts": {
    via: ["modules/search/message-indexer.ts"],
  },
  "modules/agent/tools/web-search-openrouter.ts": { via: ["modules/agent/tools/web-tools.ts"] },
  "modules/agent/providers/side-call-model.ts": {
    via: [
      "modules/agent/context/compaction.ts",
      "modules/agent/context/checkpoint.ts",
      "modules/agent/memory/consolidation.ts",
      "modules/agent/runtime/auto-title.ts",
      "modules/agent/tools/web-tools.ts",
      "modules/apps/sandbox/bridge/tickets.ts",
      "modules/assist/proofread-service.ts",
      "modules/assist/transcribe-service.ts",
    ],
  },
  "modules/agent/providers/provider.ts": {
    via: [
      "modules/agent/runtime/agent-service.ts",
      "modules/agent/subruns/subrun-worker.ts",
      "modules/settings/ai-models-admin.ts",
    ],
  },
  "modules/agent/providers/openrouter.ts": {
    none: "the OpenRouter model factory and fetch: callers are the files listed here",
  },
  "modules/agent/providers/scripted-model-provider.ts": {
    none: "the e2e lane's scripted model (LIAISON_MODEL_PROVIDER=scripted): no provider, no spend",
  },
  "modules/settings/ai-models-routes.ts": {
    none: "only the custom model server test: the org's own server and key (its one site is marked)",
  },
  "modules/agent/providers/model-server.ts": {
    none: "an org's own model server (its key, its bill); runs through provider.ts",
  },
  "modules/agent/credits/openrouter-catalogue.ts": { none: "GET /models: no spend" },
  "modules/agent/providers/openrouter-host-ranking.ts": {
    none: "GET /models/:id/endpoints: no spend",
  },
  "modules/demo/demo-alerts.ts": { none: "GET /models price drift check: no spend" },
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name)
    if (statSync(abs).isDirectory()) {
      if (name === "tests" || name === "node_modules" || name === "__fixtures__") continue
      out.push(...sourceFiles(abs))
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(abs)
    }
  }
  return out
}

function read(rel: string): string {
  return readFileSync(path.join(SRC, rel), "utf-8")
}

/** Functions metered by their callers: their sites move to every call of them. */
const DELEGATED: Record<string, string> = {
  "modules/agent/runtime/agent-service.ts#runAgentStream":
    "the turn loop: runAgentChatTurn and runSubRun finalize each stream",
  "modules/agent/credits/model-test-call.ts#runModelTestCall":
    "the test call: adding an OpenRouter model finalizes it on the cell's key",
  "modules/agent/media/media-analysis-client.ts#analyzeWithOpenRouter": "returned by planModelCall",
  "modules/agent/media/media-analysis-client.ts#analyzeWithGemini": "returned by planModelCall",
  "modules/agent/media/media-analysis-tool.ts#planModelCall":
    "its run() is metered by runInlineModelCall",
  "modules/agent/providers/openrouter-embeddings.ts#openRouterEmbed":
    "the managed embedder finalizes each batch",
  "modules/agent/tools/web-search-openrouter.ts#openRouterWebSearch":
    "searchOnOpenRouter finalizes it",
  "modules/assist/transcribe-service.ts#callOpenRouter": "behind callProvider",
  "modules/assist/transcribe-service.ts#callGemini": "behind callProvider",
  "modules/assist/transcribe-service.ts#callProvider": "transcribe finalizes each provider call",
}

/** Functions whose sites were reviewed by hand. */
const EXEMPT: Record<string, string> = {
  "modules/agent/context/warm-compaction.ts#defaultSend":
    "injected send: warmBriefWriter settles every brief through creditCheck.settle (meterSideCall)",
  "modules/search/message-indexer.ts#resolveOrgEmbedder":
    "the Google embedder: self-hosted only, no credits (S19); the managed embedder meters",
}

/**
 * Single call sites reviewed by hand, marked in the source by an
 * `// unmetered-model-call: <reason>` comment on the line above the call; the
 * count per file is pinned so a new marker needs a review here too.
 */
const SITE_EXEMPT: Record<string, number> = {
  "modules/settings/ai-models-routes.ts": 1, // the custom model server test: the org's own server and key
}
const SITE_MARKER = "// unmetered-model-call:"

/** Model calls that spend, reached as a bare identifier (the AI SDK and its injected stand-in). */
const SDK_SPEND = new Set([
  "generateText",
  "streamText",
  "generateObject",
  "streamObject",
  "embed",
  "embedMany",
  "streamTextForAgent",
])
/** Model calls that spend, reached as a method (Gemini's SDK). */
const METHOD_SPEND = new Set(["generateContent"])
const RAW_ENDPOINT = /["'`/](chat\/completions|embeddings|audio\/transcriptions)["'`]/
const METER_NAMES = new Set(["finalizeUsage", "meterSideCall"])

function calleeName(call: ts.CallExpression): { name: string; method: boolean } | null {
  const e = call.expression
  if (ts.isIdentifier(e)) return { name: e.text, method: false }
  if (ts.isPropertyAccessExpression(e)) return { name: e.name.text, method: true }
  return null
}

type FnNode = ts.FunctionLikeDeclaration

function isFn(n: ts.Node): n is FnNode {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isArrowFunction(n) ||
    ts.isFunctionExpression(n)
  )
}

function fnName(n: FnNode): string {
  if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText()
  const p = n.parent
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p))) return p.name.getText()
  return "<anonymous>"
}

/**
 * The per-call-site check over `files` (path relative to SRC -> source).
 * Returns one line per unmetered site, delegated function without callers, or
 * stale entry.
 */
function checkCallSites(
  files: Map<string, string>,
  delegated: Record<string, string> = DELEGATED,
  exempt: Record<string, string> = EXEMPT,
  siteExempt: Record<string, number> = SITE_EXEMPT,
): string[] {
  const delegatedNames = new Set(Object.keys(delegated).map((k) => k.split("#")[1]))
  const used = new Set<string>()
  const callers = new Map<string, number>()
  const problems: string[] = []
  for (const [rel, text] of files) {
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
    const sites: { node: ts.CallExpression; chain: FnNode[] }[] = []
    const meters: { chain: FnNode[] }[] = []
    const visit = (n: ts.Node, chain: FnNode[]) => {
      const next = isFn(n) ? [n, ...chain] : chain
      if (ts.isCallExpression(n)) {
        const callee = calleeName(n)
        const first = n.arguments[0]
        const spends =
          (callee && !callee.method && SDK_SPEND.has(callee.name)) ||
          (callee?.method && METHOD_SPEND.has(callee.name)) ||
          (callee && delegatedNames.has(callee.name)) ||
          (first !== undefined && RAW_ENDPOINT.test(first.getText(sf)))
        if (spends) sites.push({ node: n, chain })
        if (callee && METER_NAMES.has(callee.name)) meters.push({ chain })
        if (callee && delegatedNames.has(callee.name))
          callers.set(callee.name, (callers.get(callee.name) ?? 0) + 1)
      }
      ts.forEachChild(n, (c) => visit(c, next))
    }
    visit(sf, [])
    const lines = text.split("\n")
    const markedLine = (s: ts.CallExpression) => {
      const line = sf.getLineAndCharacterOfPosition(s.getStart(sf)).line
      return (lines[line - 1] ?? "").includes(SITE_MARKER)
    }
    const marked = sites.filter((s) => markedLine(s.node)).length
    const markers = lines.filter((l) => l.includes(SITE_MARKER)).length
    if (marked !== (siteExempt[rel] ?? 0) || markers !== marked)
      problems.push(
        `${rel}: ${markers} unmetered-model-call markers (${marked} on a model call), ${siteExempt[rel] ?? 0} reviewed`,
      )
    const inside = (chain: FnNode[], fn: FnNode) => chain.includes(fn)
    for (const site of sites) {
      const line = sf.getLineAndCharacterOfPosition(site.node.getStart(sf)).line + 1
      const covering = site.chain.map((f) => `${rel}#${fnName(f)}`)
      if (markedLine(site.node)) continue
      const hand = covering.find((k) => k in delegated || k in exempt)
      if (hand) {
        used.add(hand)
        continue
      }
      const meteringFn = site.chain.find((f) => meters.some((m) => inside(m.chain, f)))
      if (!meteringFn) {
        problems.push(`${rel}:${line}: model call not metered`)
        continue
      }
      const meterCount = meters.filter((m) => inside(m.chain, meteringFn)).length
      const siteCount = sites.filter(
        (s) =>
          inside(s.chain, meteringFn) &&
          !markedLine(s.node) &&
          !s.chain.some(
            (f) => `${rel}#${fnName(f)}` in delegated || `${rel}#${fnName(f)}` in exempt,
          ),
      ).length
      if (meterCount < siteCount)
        problems.push(
          `${rel}:${line}: ${fnName(meteringFn)} makes ${siteCount} model calls but meters ${meterCount}`,
        )
    }
  }
  for (const key of [...Object.keys(delegated), ...Object.keys(exempt)]) {
    const [file] = key.split("#")
    if (!files.has(file)) continue
    if (!used.has(key)) problems.push(`${key}: reviewed entry has no model call (stale)`)
  }
  for (const key of Object.keys(delegated)) {
    const name = key.split("#")[1]
    if (files.has(key.split("#")[0]) && !callers.get(name))
      problems.push(`${key}: metered by its callers, but nothing calls it`)
  }
  return [...new Set(problems)]
}

describe("model calls: every call site is metered", () => {
  it("lists exactly the files that call a model", () => {
    const found = sourceFiles(SRC)
      .filter((f) => MODEL_CALL.test(readFileSync(f, "utf-8")))
      .map((f) => path.relative(SRC, f))
      .sort()
    expect(found).toEqual(Object.keys(REVIEWED).sort())
  })

  it('"meters" files reach a metering entry point', () => {
    const unmetered = Object.entries(REVIEWED)
      .filter(([, d]) => d === "meters")
      .map(([f]) => f)
      .filter((f) => !METERS.test(read(f)))
    expect(unmetered).toEqual([])
  })

  it("a primitive's callers are reviewed files that meter", () => {
    const problems: string[] = []
    for (const [file, d] of Object.entries(REVIEWED)) {
      if (typeof d !== "object" || !("via" in d)) continue
      for (const caller of d.via) {
        const exists = (() => {
          try {
            statSync(path.join(SRC, caller))
            return true
          } catch {
            return false
          }
        })()
        if (!exists) problems.push(`${file}: caller ${caller} does not exist`)
        else if (!METERS.test(read(caller)))
          problems.push(`${file}: caller ${caller} meters nothing`)
      }
    }
    expect(problems).toEqual([])
  })

  it("each call site is metered at the call or by every caller", () => {
    const anySpend = new RegExp(
      `\\b(${[...SDK_SPEND, ...METHOD_SPEND, ...Object.keys(DELEGATED).map((k) => k.split("#")[1])].join("|")})\\(|${RAW_ENDPOINT.source}`,
    )
    const files = new Map<string, string>()
    for (const abs of sourceFiles(SRC)) {
      const text = readFileSync(abs, "utf-8")
      if (anySpend.test(text)) files.set(path.relative(SRC, abs), text)
    }
    for (const key of [...Object.keys(DELEGATED), ...Object.keys(EXEMPT)])
      expect(files.has(key.split("#")[0])).toBe(true)
    expect(checkCallSites(files)).toEqual([])
  })

  it("would have caught the unmetered memory flush (the original gap)", () => {
    const rel = "modules/agent/context/compaction.ts"
    const source = read(rel)
    const flushMeter = "await meterSideCall(orgId, params.credit, result.totalUsage"
    expect(source).toContain(flushMeter)
    // The file still meters its summary (finalizeUsage), as it did before the fix.
    const mutated = source.replace(
      flushMeter,
      "await Promise.resolve(orgId, params.credit, result.totalUsage",
    )
    expect(METERS.test(mutated)).toBe(true)
    const problems = checkCallSites(new Map([[rel, mutated]]))
    expect(problems.some((p) => p.startsWith(`${rel}:`) && p.includes("not metered"))).toBe(true)
    expect(checkCallSites(new Map([[rel, source]]))).toEqual([])
  })

  it("a second, unmetered call next to a metered one fails", () => {
    const rel = "x.ts"
    const ok = `async function f() { const r = await generateText({}); await meterSideCall(o, c, r.usage) }`
    const two = `async function f() { const r = await generateText({}); await generateText({}); await meterSideCall(o, c, r.usage) }`
    expect(checkCallSites(new Map([[rel, ok]]), {}, {})).toEqual([])
    expect(checkCallSites(new Map([[rel, two]]), {}, {})).toEqual([
      "x.ts:1: f makes 2 model calls but meters 1",
    ])
  })

  it("a delegated function's callers must meter each call", () => {
    const lib = `export async function helper() { return generateText({}) }`
    const good = `async function g() { const r = await helper(); await finalizeUsage(o, r) }`
    const bad = `async function g() { await helper() }`
    const d = { "lib.ts#helper": "callers meter" }
    expect(
      checkCallSites(
        new Map([
          ["lib.ts", lib],
          ["a.ts", good],
        ]),
        d,
        {},
      ),
    ).toEqual([])
    expect(
      checkCallSites(
        new Map([
          ["lib.ts", lib],
          ["a.ts", bad],
        ]),
        d,
        {},
      ),
    ).toEqual(["a.ts:1: model call not metered"])
  })
})
