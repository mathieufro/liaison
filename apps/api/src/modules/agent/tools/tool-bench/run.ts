// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `bun run tool-bench [--update] [--from-main [--ref <ref>]]`
 *
 * Ranks every typed form of corpus.json over the catalog read from source and
 * fails when a form that reached its tool no longer does, when the catalog
 * breaks a lint rule, or when a known bad answer comes back. `--update`
 * rewrites baseline.json's forms and sizes after a real improvement.
 * `--from-main` adds to the baseline the tools that arrived from main by a
 * merge, and lists them, so only tools written on this branch count as new.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AllowedDuplicate,
  type Baseline,
  bar,
  type CorpusLine,
  catalogBars,
  corpusShapeErrors,
  lint,
  loadGuides,
  type MustNotLine,
  mustNotBroken,
  regressions,
  runForms,
  type ScreenWord,
  toolsFromMain,
  unknownCorpusTools,
  updatedBaseline,
} from "./bench"
import { type BenchTool, loadBenchCatalog, REPO_ROOT } from "./catalog"

const HERE = import.meta.dir
const readJson = <T>(name: string, fallback?: T): T => {
  try {
    return JSON.parse(readFileSync(join(HERE, name), "utf8")) as T
  } catch (err) {
    if (fallback !== undefined) return fallback
    throw err
  }
}

export interface BenchFiles {
  corpus: CorpusLine[]
  baseline: Baseline
  screenWords: ScreenWord[]
  allowedDuplicates: AllowedDuplicate[]
  mustNot: MustNotLine[]
}

export function readBenchFiles(): BenchFiles {
  return {
    corpus: readJson<CorpusLine[]>("corpus.json"),
    baseline: readJson<Baseline>("baseline.json", { tools: {}, forms: {} }),
    screenWords: readJson<ScreenWord[]>("screen-words.json", []),
    allowedDuplicates: readJson<AllowedDuplicate[]>("allowed-duplicates.json", []),
    mustNot: readJson<MustNotLine[]>("must-not.json", []),
  }
}

/** The catalog at a git ref, read from that ref's sources in a scratch folder. */
export function catalogAtRef(ref: string, root: string = REPO_ROOT): BenchTool[] {
  const dir = mkdtempSync(join(tmpdir(), "tool-bench-"))
  try {
    const tar = execFileSync(
      "git",
      ["archive", ref, "--", "apps/api/src", ":(glob)bundled-apps/*/app.manifest.json"],
      { cwd: root, maxBuffer: 1 << 30 },
    )
    execFileSync("tar", ["-x", "-C", dir], { input: tar })
    return loadBenchCatalog(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface BenchReport {
  failures: string[]
  lines: string[]
}

export function runBench(files: BenchFiles, catalog: BenchTool[]): BenchReport {
  const failures: string[] = [
    ...corpusShapeErrors(files.corpus),
    ...unknownCorpusTools(files.corpus, catalog).map(
      (e) => `corpus names a tool not in the catalog: ${e}`,
    ),
  ]
  const runs = runForms(catalog, files.corpus)
  failures.push(...regressions(runs, files.baseline))
  failures.push(
    ...lint({
      catalog,
      corpus: files.corpus,
      baseline: files.baseline,
      screenWords: files.screenWords,
      allowedDuplicates: files.allowedDuplicates,
      guides: loadGuides(),
    }),
  )
  failures.push(...mustNotBroken(catalog, files.mustNot).map((e) => `known bad answer: ${e}`))
  const bars = catalogBars(runs)
  if (!bars.overall.ok)
    failures.push(
      `bar missed: ${bars.overall.passed}/${bars.overall.total} forms reached, 85% overall`,
    )
  if (!bars.french.ok)
    failures.push(
      `bar missed: ${bars.french.passed}/${bars.french.total} French forms reached, 80%`,
    )

  const count = (pick: (r: (typeof runs)[number]) => boolean, of = runs) =>
    `${of.filter(pick).length}/${of.length}`
  const fr = runs.filter((r) => r.line.lang === "fr")
  const lines = [
    `forms ${runs.length}: top 1 ${count((r) => r.result.top1)}, top 5 ${count((r) => r.result.top5)}, top 5 ties counted ${count((r) => r.result.top5Ties)}, loaded ${count((r) => r.result.loaded)}, zero hit ${count((r) => r.result.zeroHit)}`,
    `French forms: top 5 ties counted ${count((r) => r.result.top5Ties, fr)}`,
  ]
  for (const set of new Set(runs.map((r) => r.line.set))) {
    for (const lang of ["fr", "en"]) {
      const of = runs.filter((r) => r.line.set === set && r.line.lang === lang)
      if (of.length === 0) continue
      const b = bar(of.filter((r) => r.result.top5Ties).length, of.length, lang === "fr" ? 80 : 85)
      lines.push(
        `  ${set}/${lang}: ${b.passed}/${b.total} (${b.kind} bar ${b.ok ? "held" : "missed"})`,
      )
    }
  }
  return { failures, lines }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const started = performance.now()
  const files = readBenchFiles()
  const catalog = loadBenchCatalog()
  if (args.includes("--from-main")) {
    const at = args.indexOf("--ref")
    const ref = at >= 0 ? (args[at + 1] ?? "origin/main") : "origin/main"
    const arrived = toolsFromMain(catalog, files.baseline, catalogAtRef(ref))
    console.log(
      arrived.length === 0
        ? `No tool arrived from ${ref}.`
        : `Tools that arrived from ${ref}, now in the baseline:\n${arrived.map((t) => `  ${t.sdkName}`).join("\n")}`,
    )
    const runs = runForms(catalog, files.corpus)
    const next = updatedBaseline(catalog, runs, files.baseline, arrived)
    // Only the arrivals and their sizes: forms move with --update alone.
    if (!args.includes("--update")) next.forms = files.baseline.forms
    writeFileSync(join(HERE, "baseline.json"), `${JSON.stringify(next, null, 2)}\n`)
  } else if (args.includes("--update")) {
    const runs = runForms(catalog, files.corpus)
    writeFileSync(
      join(HERE, "baseline.json"),
      `${JSON.stringify(updatedBaseline(catalog, runs, files.baseline), null, 2)}\n`,
    )
    console.log("baseline.json updated.")
  }
  const report = runBench(readBenchFiles(), catalog)
  for (const l of report.lines) console.log(l)
  console.log(`${Math.round(performance.now() - started)} ms`)
  if (report.failures.length > 0) {
    console.error(
      `\n${report.failures.length} failing:\n${report.failures.map((f) => `  ${f}`).join("\n")}`,
    )
    process.exit(1)
  }
}
