// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The tool-finding bench, deterministic half: every typed form of the corpus
 * through the real ranker over the catalog read from source, compared with the
 * committed baseline, plus the static lint of the catalog and the known bad
 * answers that must stay fixed. Pure functions over their inputs; `run.ts` is
 * the command.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { rankDeferredTools } from "../tool-rank"
import { type BenchTool, REPO_ROOT, searchableTools } from "./catalog"

export const CORPUS_SETS = ["seed", "screen", "heldout"] as const
export const CORPUS_LANGS = ["fr", "en"] as const

export interface CorpusLine {
  id: string
  set: (typeof CORPUS_SETS)[number]
  lang: (typeof CORPUS_LANGS)[number]
  /** What a person says. */
  say: string
  /** What a model plausibly types into the search. */
  typed: string[]
  /** Must reach: one of these in the top 5. */
  any: string[]
  /** Tools a run of this line may rightly park or run; defaults to `any`. */
  mayWrite?: string[]
  persona?: string
  /** The page the person is on; defaults to Home. */
  page?: string
  /** Also run by the model half. */
  modelRun?: boolean
}

const LINE_KEYS = new Set([
  "id",
  "set",
  "lang",
  "say",
  "typed",
  "any",
  "mayWrite",
  "persona",
  "page",
  "modelRun",
])

/** Shape errors of a corpus, one string per error. */
export function corpusShapeErrors(corpus: readonly unknown[]): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  const strings = (v: unknown) =>
    Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0)
  for (const raw of corpus) {
    const line = raw as Record<string, unknown>
    const id = String(line.id ?? "?")
    for (const key of Object.keys(line)) {
      if (!LINE_KEYS.has(key)) errors.push(`${id}: unknown field "${key}"`)
    }
    if (typeof line.id !== "string" || line.id === "") errors.push(`${id}: no id`)
    else if (ids.has(line.id)) errors.push(`${id}: id used twice`)
    else ids.add(line.id)
    if (!CORPUS_SETS.includes(line.set as never)) errors.push(`${id}: set "${line.set}"`)
    if (!CORPUS_LANGS.includes(line.lang as never)) errors.push(`${id}: lang "${line.lang}"`)
    if (typeof line.say !== "string") errors.push(`${id}: no say`)
    if (!strings(line.typed)) errors.push(`${id}: typed must list forms`)
    if (!strings(line.any)) errors.push(`${id}: any must list tools`)
    if (line.mayWrite !== undefined && !strings(line.mayWrite))
      errors.push(`${id}: mayWrite must list tools`)
    for (const key of ["persona", "page"] as const) {
      if (line[key] !== undefined && typeof line[key] !== "string")
        errors.push(`${id}: ${key} must be a string`)
    }
    if (line.modelRun !== undefined && typeof line.modelRun !== "boolean")
      errors.push(`${id}: modelRun must be true or false`)
  }
  return errors
}

/** Tools a line names (`any`, `mayWrite`) that the catalog does not hold. */
export function unknownCorpusTools(
  corpus: readonly CorpusLine[],
  catalog: readonly BenchTool[],
): string[] {
  const names = new Set(catalog.map((t) => t.sdkName))
  return corpus.flatMap((l) =>
    [...l.any, ...(l.mayWrite ?? [])].filter((n) => !names.has(n)).map((n) => `${l.id}: ${n}`),
  )
}

// ── Per form ─────────────────────────────────────────────────────────────

export interface FormResult {
  top1: boolean
  top5: boolean
  /** In the top 5 when every tool tied with it counts as ranked above it. */
  top5Ties: boolean
  loaded: boolean
  zeroHit: boolean
  /** Tools ranked above the wanted one, ties counted against it. */
  above: string[]
}

export const TOP = 5

/** The org's apps as the search reads them: every app in the catalog but the kernel. */
export function appNamesOf(catalog: readonly BenchTool[]): Set<string> {
  const apps = new Set(catalog.map((t) => t.appName))
  apps.delete("kernel")
  return apps
}

export function rankForm(
  searchable: readonly BenchTool[],
  appNames: Set<string>,
  form: string,
  want: readonly string[],
): FormResult {
  const { ranked, all, strongNames } = rankDeferredTools(searchable, form, {
    cap: TOP,
    appNames,
  })
  const hit = all.find((s) => want.includes(s.tool.sdkName))
  // A tool tied at the cut takes the last tied place, so registration order
  // cannot rescue it.
  const above = hit
    ? all.filter((s) => s !== hit && s.score >= hit.score).map((s) => s.tool.sdkName)
    : ranked.map((s) => s.tool.sdkName)
  return {
    top1: want.includes(ranked[0]?.tool.sdkName ?? ""),
    top5: ranked.some((s) => want.includes(s.tool.sdkName)),
    top5Ties: hit !== undefined && above.length < TOP,
    loaded: want.some((n) => strongNames.has(n)),
    zeroHit: all.length === 0,
    above,
  }
}

/** A form's result as the baseline stores it: "1" top 1, "5" top 5, "t" top 5 with ties, "l" loaded, "0" zero hit. */
export function formCode(r: FormResult): string {
  return `${r.top1 ? "1" : ""}${r.top5 ? "5" : ""}${r.top5Ties ? "t" : ""}${r.loaded ? "l" : ""}${r.zeroHit ? "0" : ""}`
}

export const formKey = (line: CorpusLine, form: string) => `${line.id}|${form}`

export interface FormRun {
  key: string
  line: CorpusLine
  form: string
  result: FormResult
}

export function runForms(catalog: readonly BenchTool[], corpus: readonly CorpusLine[]): FormRun[] {
  const searchable = searchableTools(catalog)
  const appNames = appNamesOf(catalog)
  // A tool the model already holds on every turn needs no search: a form for it
  // is reached. It is ranked for real the day it is deferred.
  const held = new Set(
    catalog.filter((t) => t.agentVisible && !t.deferred && !t.routineOnly).map((t) => t.sdkName),
  )
  return corpus.flatMap((line) =>
    line.typed.map((form) => ({
      key: formKey(line, form),
      line,
      form,
      result: line.any.some((n) => held.has(n))
        ? { top1: true, top5: true, top5Ties: true, loaded: true, zeroHit: false, above: [] }
        : rankForm(searchable, appNames, form, line.any),
    })),
  )
}

// ── Baseline ─────────────────────────────────────────────────────────────

export interface ToolSize {
  /** Description characters. */
  desc: number
  /** Schema size in estimated tokens. */
  schema: number
}

export interface Baseline {
  /**
   * Every tool the rules treat as existing: the catalog where this branch
   * started, extended only by tools that arrived from main (`--from-main`).
   * A tool not here was written on this branch, and the new-tool rules hold it.
   */
  tools: Record<string, ToolSize>
  /** Each form's result, by `<line id>|<form>`. */
  forms: Record<string, string>
}

/** Characters per token, the estimate the context budget uses. */
const CHARS_PER_TOKEN = 4

export function toolSize(t: BenchTool): ToolSize {
  return { desc: t.description.length, schema: Math.ceil(t.schemaChars / CHARS_PER_TOKEN) }
}

/**
 * A form that passed (top 5, ties counted against) and now does not. The
 * message names the tools now above it, marking those the baseline does not
 * know (written on this branch) as new.
 */
export function regressions(runs: readonly FormRun[], baseline: Baseline): string[] {
  const out: string[] = []
  for (const run of runs) {
    const before = baseline.forms[run.key]
    if (before === undefined || !before.includes("t") || run.result.top5Ties) continue
    const above = run.result.above
      .slice(0, 8)
      .map((n) => (baseline.tools[n] ? n : `${n} (new)`))
      .join(", ")
    out.push(
      `${run.line.id} "${run.form}" fell out of the top ${TOP} for ${run.line.any.join(" or ")}. Now above it: ${above || "nothing scored it"}`,
    )
  }
  return out
}

/** Tools in the catalog the baseline does not know, that main already has: they arrived by merge. */
export function toolsFromMain(
  catalog: readonly BenchTool[],
  baseline: Baseline,
  mainCatalog: readonly BenchTool[],
): BenchTool[] {
  const atMain = new Set(mainCatalog.map((t) => t.sdkName))
  return catalog.filter((t) => !baseline.tools[t.sdkName] && atMain.has(t.sdkName))
}

/** The baseline after `--update`: forms and known tools' sizes rewritten, no tool added. */
export function updatedBaseline(
  catalog: readonly BenchTool[],
  runs: readonly FormRun[],
  baseline: Baseline,
  arrived: readonly BenchTool[] = [],
): Baseline {
  const tools: Record<string, ToolSize> = {}
  const known = new Set([...Object.keys(baseline.tools), ...arrived.map((t) => t.sdkName)])
  for (const t of catalog) if (known.has(t.sdkName)) tools[t.sdkName] = toolSize(t)
  const forms: Record<string, string> = {}
  for (const r of runs) forms[r.key] = formCode(r.result)
  return { tools: sortKeys(tools), forms: sortKeys(forms) }
}

function sortKeys<V>(o: Record<string, V>): Record<string, V> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
}

// ── Bars ─────────────────────────────────────────────────────────────────

export interface BarResult {
  passed: number
  total: number
  /** "percent" at 10 lines or more, "count" (at most 1 missed) from 5 to 9, "none" under 5. */
  kind: "percent" | "count" | "none"
  ok: boolean
}

/** A class of lines against its bar: a share at 10 or more, at most 1 missed from 5, reported under 5. */
export function bar(passed: number, total: number, percent: number): BarResult {
  if (total >= 10) return { passed, total, kind: "percent", ok: passed * 100 >= percent * total }
  if (total >= 5) return { passed, total, kind: "count", ok: total - passed <= 1 }
  return { passed, total, kind: "none", ok: true }
}

/** Top 5 with ties counted against, over every typed form: the bar of any catalog. */
export const BAR_OVERALL_PERCENT = 85
/** The same, over French lines. */
export const BAR_FRENCH_PERCENT = 80

export interface CatalogBars {
  overall: BarResult
  french: BarResult
}

/** The catalog's two bars (85% overall, 80% French) over a run of the corpus. */
export function catalogBars(runs: readonly FormRun[]): CatalogBars {
  const french = runs.filter((r) => r.line.lang === "fr")
  const reached = (of: readonly FormRun[]) => of.filter((r) => r.result.top5Ties).length
  return {
    overall: bar(reached(runs), runs.length, BAR_OVERALL_PERCENT),
    french: bar(reached(french), french.length, BAR_FRENCH_PERCENT),
  }
}

// ── Lint ─────────────────────────────────────────────────────────────────

export const MAX_NEW_DESCRIPTION = 600
export const MAX_NEW_SCHEMA_TOKENS = 600
const SYNOPSIS_CHARS = 140

export interface ScreenWord {
  word: string
  tool: string
}

export interface AllowedDuplicate {
  name: string
  reason: string
}

export interface LintInput {
  catalog: readonly BenchTool[]
  corpus: readonly CorpusLine[]
  baseline: Baseline
  screenWords: readonly ScreenWord[]
  allowedDuplicates: readonly AllowedDuplicate[]
  /** Model-facing guidance text (prompts, guides, skills, routine templates), by where it lives. */
  guides: ReadonlyArray<{ where: string; text: string }>
}

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

const ACCENT = /[àâäéèêëîïôöùûüÿçœæ]/i

/**
 * A keyword reads as French when it carries a French letter or is not a word
 * of the tool's own English name and description: an approximation, which a
 * keyword list in English only fails.
 */
function hasFrenchKeyword(t: BenchTool): boolean {
  const own = new Set(fold(`${t.toolName} ${t.description}`).split(/[^a-z0-9]+/))
  return (t.keywords ?? []).some((k) => ACCENT.test(k) || !own.has(fold(k)))
}

/** One string per rule broken, naming the tool and the rule. */
export function lint(input: LintInput): string[] {
  const { catalog, corpus, baseline } = input
  const out: string[] = []
  const visible = catalog.filter((t) => t.agentVisible)
  const isNew = (t: BenchTool) => baseline.tools[t.sdkName] === undefined
  const named = new Set(corpus.flatMap((l) => l.any))
  const allowed = new Set(input.allowedDuplicates.filter((d) => d.reason.trim()).map((d) => d.name))

  for (const t of visible) {
    if (!isNew(t)) continue
    if (!named.has(t.sdkName))
      out.push(`${t.sdkName}: a new agent-visible tool with no corpus line`)
    if (t.appName === "kernel" && t.declaredDeferLoading === undefined)
      out.push(`${t.sdkName}: a new kernel tool must state deferLoading`)
    if (!hasFrenchKeyword(t)) out.push(`${t.sdkName}: no French searchKeywords`)
    const sameName = visible.filter((o) => o.toolName === t.toolName && o.appName !== t.appName)
    if (sameName.length > 0 && !allowed.has(t.toolName))
      out.push(
        `${t.sdkName}: the bare name "${t.toolName}" is also ${sameName.map((o) => o.sdkName).join(", ")}; give a reason in allowed-duplicates.json`,
      )
  }

  for (const t of catalog) {
    const size = toolSize(t)
    const before = baseline.tools[t.sdkName]
    if (!before) {
      if (size.desc > MAX_NEW_DESCRIPTION)
        out.push(`${t.sdkName}: description ${size.desc} characters, over ${MAX_NEW_DESCRIPTION}`)
      if (size.schema > MAX_NEW_SCHEMA_TOKENS)
        out.push(`${t.sdkName}: schema about ${size.schema} tokens, over ${MAX_NEW_SCHEMA_TOKENS}`)
    } else {
      if (size.desc > before.desc)
        out.push(`${t.sdkName}: description grew from ${before.desc} to ${size.desc} characters`)
      if (size.schema > before.schema)
        out.push(`${t.sdkName}: schema grew from about ${before.schema} to ${size.schema} tokens`)
    }
  }

  // What a search result shows of each tool must tell it from its neighbours.
  const bySynopsis = new Map<string, BenchTool[]>()
  for (const t of visible) {
    const k = `${t.appName}\n${t.description.replace(/\s+/g, " ").trim().slice(0, SYNOPSIS_CHARS)}`
    bySynopsis.set(k, [...(bySynopsis.get(k) ?? []), t])
  }
  for (const tools of bySynopsis.values()) {
    if (tools.length > 1 && tools.some(isNew))
      out.push(
        `${tools.map((t) => t.sdkName).join(", ")}: the same first ${SYNOPSIS_CHARS} characters of description`,
      )
  }

  const byName = new Map(catalog.map((t) => [t.sdkName, t]))
  for (const s of input.screenWords) {
    const t = byName.get(s.tool)
    if (!t) out.push(`screen word "${s.word}": ${s.tool} is not in the catalog`)
    else if (!(t.keywords ?? []).some((k) => fold(k) === fold(s.word)))
      out.push(`screen word "${s.word}" is not a keyword of ${s.tool}`)
  }

  const apps = new Set(catalog.map((t) => t.appName))
  for (const g of input.guides) {
    for (const m of g.text.matchAll(/\b([a-z][a-z0-9-]*)__([A-Za-z][A-Za-z0-9_]*)\b(?![*<])/g)) {
      // A pattern over several tools (`kernel__config_*`) names none.
      if (!apps.has(m[1]) || m[2].endsWith("_")) continue
      if (!byName.has(`${m[1]}__${m[2]}`)) out.push(`${g.where} names ${m[0]}, which is not a tool`)
    }
  }
  return [...new Set(out)]
}

// ── Known bad answers ────────────────────────────────────────────────────

export interface MustNotLine {
  query: string
  /** The search loads no tool outside these apps (none: loads nothing). */
  loadsOnlyApps?: string[]
  /** This tool is not the first hit. */
  notFirst?: string
  /** Tools this query may load anyway, each for a stated reason (another meaning of the word). */
  allow?: Array<{ tool: string; reason: string }>
}

export function mustNotBroken(
  catalog: readonly BenchTool[],
  lines: readonly MustNotLine[],
): string[] {
  const searchable = searchableTools(catalog)
  const appNames = appNamesOf(catalog)
  const out: string[] = []
  for (const line of lines) {
    const { ranked, strongNames } = rankDeferredTools(searchable, line.query, {
      cap: TOP,
      appNames,
    })
    if (line.loadsOnlyApps) {
      const allowed = new Set((line.allow ?? []).filter((a) => a.reason.trim()).map((a) => a.tool))
      const outside = [...strongNames].filter(
        (n) => !allowed.has(n) && !line.loadsOnlyApps?.some((app) => n.startsWith(`${app}__`)),
      )
      if (outside.length > 0) out.push(`"${line.query}" loads ${outside.join(", ")}`)
    }
    if (line.notFirst && ranked[0]?.tool.sdkName === line.notFirst)
      out.push(`"${line.query}" leads with ${line.notFirst}`)
  }
  return out
}

// ── Guidance text, read from source ──────────────────────────────────────

/**
 * The model-facing guidance that can name tools: the agent prompt files, the
 * apps' skills and prompt files, and the manifests' agent instructions,
 * prompts and routine templates.
 */
export function loadGuides(root: string = REPO_ROOT): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = []
  const md = (dir: string) => {
    const full = join(root, dir)
    if (!existsSync(full)) return
    for (const e of readdirSync(full, { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) md(rel)
      else if (e.name.endsWith(".md"))
        out.push({ where: rel, text: readFileSync(join(root, rel), "utf8") })
    }
  }
  md("apps/api/src/modules/agent/prompts")
  for (const base of ["apps/api/src/apps", "bundled-apps"]) {
    const dir = join(root, base)
    if (!existsSync(dir)) continue
    for (const app of readdirSync(dir)) {
      if (app === "example") continue
      md(`${base}/${app}/skills`)
      md(`${base}/${app}/prompts`)
      const manifest = join(dir, app, "app.manifest.json")
      if (!existsSync(manifest)) continue
      const m = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>
      for (const key of [
        "agentInstructions",
        "prompts",
        "skills",
        "routineTemplates",
        "routines",
      ]) {
        if (m[key] !== undefined)
          out.push({
            where: `${base}/${app}/app.manifest.json ${key}`,
            text: JSON.stringify(m[key]),
          })
      }
    }
  }
  return out
}
