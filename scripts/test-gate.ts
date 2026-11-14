#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run test:gate [--base origin/main] [--dry-run] [--matrix-json <file>]`
//
// The tests a change needs, and only those. The changed paths (committed since
// the merge base with --base, plus the working tree and untracked files) go
// through `.claude/test-map.ts` to the suites they affect, and each suite runs
// through scripts/test-run.ts:
//
//   - narrowed to FILES where the change allows it: a changed test file runs on
//     its own in the suite that lists it; a changed unit source file runs its
//     co-located `<name>.test.ts` / `<name>.*.test.ts`; a changed scenario runs
//     on its own in e2e-parallel. Anything else runs the whole suite.
//   - fail-safe: a path the map does not cover (and that is not plain docs)
//     triggers the BROAD set below.
//   - concurrently where safe: suites that touch no database share a small pool
//     beside the database lane, which runs its suites one after another (they
//     share this checkout's namespace database). The gate holds the namespace,
//     its port block and one test slot for all of them.
//
// It prints what ran, what was skipped and why, and each suite's wall clock.
//
// `--matrix-json <file>` (with --dry-run) also writes the plan's heavy lanes
// ({@link GATE_LANES}) as a GitHub Actions matrix, one entry per shard: what the
// hand-started `gate` workflow runs on hosted runners.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { NO_CODE_PATHS, suitesFor } from "../.claude/test-map"
import {
  namespaceEnv,
  namespaceForCheckout,
  resolveTestCoordinates,
} from "../packages/test-helpers/src/test-namespace"
import { CELL_DIR } from "./lib/api-e2e-files"
import { computeMemBudget } from "./lib/mem-budget"
import { formatMemGuard, startMemGuard } from "./lib/mem-guard"
import { acquireNamespaceLock, acquireTestLock, leasePortBlock, slotCount } from "./lib/test-lock"
import { CLEAN_SUBSTRATE_SUITES, prepareNamespaceDb } from "./lib/test-template"

const ROOT = path.resolve(import.meta.dir, "..")

/** What an unmappable change runs: every core suite. */
export const BROAD_SUITES = [
  "unit",
  "integration",
  "integration-extra",
  "integration-mocked",
  "relations",
  "e2e-parallel",
  "security",
  "web-unit",
  "playwright",
  "workspace-packages",
  "shared",
  "api-guards",
  "guards",
  "root",
]

/**
 * The heavy lanes the `gate` workflow runs on hosted runners, with the number
 * of runners each is split over (`scripts/test-run.ts --shard`). None needs a
 * model provider key. The light suites are the per-PR `ci` workflow's.
 */
export const GATE_LANES: Record<string, number> = {
  integration: 4,
  "integration-extra": 2,
  "integration-mocked": 1,
  security: 1,
  "e2e-parallel": 2,
  "demo-seed": 1,
  playwright: 6,
  // The multi-process scenarios: about 17 minutes in one process.
  cell: 3,
  "api-guards": 1,
  shared: 1,
  "workspace-packages": 1,
  "worker-env": 1,
  "unsplit-logins": 1,
  "bundled-freeze": 1,
  "bundled-ads": 1,
  "bundled-shopify": 1,
  "bundled-invoicing": 2,
  "bundled-boxtal": 2,
  "bundled-monitoring": 1,
  "bundled-database": 1,
  "bundled-google-drive": 1,
  "bundled-gitlab": 1,
  "bundled-github": 1,
  "bundled-api-connector": 1,
  "bundled-pennylane": 1,
  "bundled-stripe": 1,
  "bundled-calls": 1,
  "bundled-social": 1,
  // The vitest suites do not take --shard: one runner each.
  "bundled-boxtal-ui": 1,
  "bundled-monitoring-ui": 1,
  "bundled-social-ui": 1,
  "desktop-ui": 1,
  mobile: 1,
}

/**
 * The suites the per-PR `ci` workflow already runs on every pull request (root,
 * guards, unit, web-unit, and the relation cells as a step of its `unit` job): the
 * gate leaves them out. Every other suite the test
 * map names must be a {@link GATE_LANES} key, or the gate would plan it and
 * never run it (scripts/test-gate.test.ts pins that).
 */
/**
 * Suites a hosted Linux runner cannot run, with why: the plan lists them as
 * not run so the owner runs them on a Mac (`bun run test:desktop`).
 */
export const NOT_HOSTED_SUITES: Record<string, string> = {
  desktop:
    "its session-broker tests drive the Mac shell's zsh shims, sockets and signed app bundle; they hang on a Linux runner",
}

export const PR_CI_SUITES = ["unit", "web-unit", "root", "guards", "relations"]

export interface GateShard {
  suite: string
  shard: number
  of: number
  /** `--file` values for the suite (cwd-relative), empty for the whole suite. */
  files: string[]
}

/** The file arguments test-run.ts takes for a planned suite. */
export function fileArgsFor(r: SuitePlan, info: SuiteInfo | undefined): string[] {
  // e2e-parallel resolves repo-relative paths itself; bun suites want cwd-relative ones.
  return r.files.map((f) =>
    r.suite === "e2e-parallel" || !info ? f : path.posix.relative(info.cwd, f),
  )
}

/** The plan's heavy lanes, one matrix entry per shard; a narrowed lane gets at most one shard per file. */
export function gateMatrix(plan: GatePlan, infos: Record<string, SuiteInfo>): GateShard[] {
  const out: GateShard[] = []
  for (const r of plan.run) {
    const lane = GATE_LANES[r.suite]
    if (!lane) continue
    const files = fileArgsFor(r, infos[r.suite])
    const of = files.length > 0 ? Math.min(lane, files.length) : lane
    for (let shard = 1; shard <= of; shard++) out.push({ suite: r.suite, shard, of, files })
  }
  return out
}

/** Suites that read or write the namespace database (or its Redis/Meili/ports). */
export const DB_SUITES = new Set([
  "all",
  "unit",
  "integration",
  "integration-extra",
  "integration-mocked",
  "relations",
  "live",
  "e2e",
  "e2e-parallel",
  "cell",
  "playwright",
  "security",
  "worker-env",
  "db-gate",
  "demo-seed",
])

/**
 * Splits the planned suites into the serial db lane and the light pool. In the
 * db lane the suites that reuse the namespace database go first, so they
 * overlap the light pool, and the re-cloning ones ({@link CLEAN_SUBSTRATE_SUITES})
 * go last: those must not start while a light suite can still touch the
 * database, and the gate holds them until the light pool is done.
 */
export function laneOrder<T extends { suite: string }>(run: T[]): { dbLane: T[]; light: T[] } {
  const db = run.filter((r) => DB_SUITES.has(r.suite))
  return {
    dbLane: [
      ...db.filter((r) => !CLEAN_SUBSTRATE_SUITES.has(r.suite)),
      ...db.filter((r) => CLEAN_SUBSTRATE_SUITES.has(r.suite)),
    ],
    light: run.filter((r) => !DB_SUITES.has(r.suite)),
  }
}

export const UNIT_SOURCE_PREFIXES = [
  "apps/api/src/modules/",
  "apps/api/src/infra/",
  "apps/api/src/middleware/",
  "apps/api/src/lib/",
  "apps/api/src/db/",
  "apps/api/src/apps/",
  "apps/api/src/services/",
  "apps/api/src/cli/",
  "apps/api/test-support/",
]

export interface SuiteInfo {
  /** Repo-relative cwd of the suite's command. */
  cwd: string
  /** Repo-relative paths the unfiltered suite selects (files or dirs). Empty: all of cwd. */
  selects: string[]
}

export interface SuitePlan {
  suite: string
  /** Repo-relative test files to run; empty means the whole suite. */
  files: string[]
  why: string[]
}

export interface GatePlan {
  run: SuitePlan[]
  skipped: Array<{ suite: string; why: string }>
  ignored: string[]
  broad: string[]
}

const isTestFile = (p: string) => /\.test\.tsx?$/.test(p)

/**
 * A bundled app's rendered-screen suite (`bundled-<app>-ui`) is vitest over its
 * `src/**\/*.vitest.tsx` only (each app's vitest.config.ts `include`). Its cwd is
 * the app's directory, which also holds the app's bun tests: those belong to
 * `bundled-<app>`, and handed to vitest as filters they match nothing.
 */
const BUNDLED_UI_SUITE = /^bundled-[\w-]+-ui$/

function belongs(file: string, suite: string, info: SuiteInfo | undefined): boolean {
  if (BUNDLED_UI_SUITE.test(suite) && !file.endsWith(".vitest.tsx")) return false
  if (suite === "e2e-parallel" || suite === "e2e") {
    return (
      file.startsWith("apps/api/src/tests/e2e/") &&
      !file.startsWith(`apps/api/src/tests/e2e/${CELL_DIR}/`) &&
      file.endsWith(".scenario.test.ts")
    )
  }
  if (!info) return false
  // A file the suite names outside its cwd (the cell suite runs a
  // packages/test-helpers test from apps/api).
  if (info.selects.includes(file)) return true
  if (!(file === info.cwd || file.startsWith(`${info.cwd}/`) || info.cwd === "")) return false
  if (info.selects.length === 0) return true
  return info.selects.some((s) => file === s || file.startsWith(`${s}/`))
}

/**
 * The co-located tests of a unit source file: `<name>.test.ts` and
 * `<name>.*.test.ts`, except `*.soak.test.ts` (opt-in with LIAISON_SOAK=1,
 * minutes long, never part of a gate).
 */
export function colocatedTests(file: string, listDir: (dir: string) => string[]): string[] {
  const dir = path.posix.dirname(file)
  const base = path.posix.basename(file).replace(/\.tsx?$/, "")
  return listDir(dir)
    .filter((n) => n === `${base}.test.ts` || (n.startsWith(`${base}.`) && n.endsWith(".test.ts")))
    .filter((n) => !n.endsWith(".soak.test.ts"))
    .map((n) => `${dir}/${n}`)
    .sort()
}

/**
 * Pure planning: changed paths in, suites and files out. `suiteInfo` and
 * `listDir` are injected so the plan can be pinned by tests.
 */
export function planGate(
  changed: string[],
  suiteInfo: Record<string, SuiteInfo>,
  listDir: (dir: string) => string[],
  mapFor: (file: string) => string[] | null = suitesFor,
): GatePlan {
  const triggers = new Map<string, string[]>()
  const ignored: string[] = []
  const broad: string[] = []
  for (const file of [...new Set(changed)].sort()) {
    const suites = mapFor(file)
    if (suites) {
      for (const s of suites) triggers.set(s, [...(triggers.get(s) ?? []), file])
    } else if (NO_CODE_PATHS.some((re) => re.test(file))) {
      ignored.push(file)
    } else {
      broad.push(file)
    }
  }
  if (broad.length > 0) {
    for (const s of BROAD_SUITES) triggers.set(s, [...(triggers.get(s) ?? []), ...broad])
  }

  const run: SuitePlan[] = []
  const skipped: GatePlan["skipped"] = []
  for (const [suite, files] of triggers) {
    const info = suiteInfo[suite]
    const unmappedHere = files.filter((f) => broad.includes(f))
    const tests = files.filter((f) => isTestFile(f) && !broad.includes(f))
    const sources = files.filter((f) => !isTestFile(f) && !broad.includes(f))
    const own = tests.filter((f) => belongs(f, suite, info))
    const why: string[] = []

    // Any unmapped path or any source change the suite cannot narrow: the whole suite.
    let whole = unmappedHere.length > 0
    if (unmappedHere.length > 0) why.push(`unmapped: ${unmappedHere.join(", ")}`)
    const narrowed = new Set(own)
    for (const src of sources) {
      const colocated =
        suite === "unit" && UNIT_SOURCE_PREFIXES.some((p) => src.startsWith(p))
          ? colocatedTests(src, listDir)
          : []
      if (colocated.length > 0) {
        for (const t of colocated) narrowed.add(t)
        why.push(`${src} -> co-located ${colocated.map((t) => path.posix.basename(t)).join(", ")}`)
      } else {
        whole = true
        why.push(`${src} (no narrower test)`)
      }
    }
    if (own.length > 0) why.push(`changed tests: ${own.join(", ")}`)

    if (whole) {
      run.push({ suite, files: [], why })
    } else if (narrowed.size > 0) {
      run.push({ suite, files: [...narrowed].sort(), why })
    } else {
      skipped.push({
        suite,
        why: `only test files of other suites changed (${tests.join(", ")})`,
      })
    }
  }
  run.sort((a, b) => a.suite.localeCompare(b.suite))
  return { run, skipped, ignored, broad }
}

// ── CLI ───────────────────────────────────────────────────────────────

function git(args: string[]): string {
  const r = Bun.spawnSync({ cmd: ["git", ...args], cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`)
  return r.stdout.toString()
}

/**
 * The files the gate workflow's plan step writes into the checkout while this
 * planner runs (`tee gate-plan.txt` opens its file first): untracked, so they
 * would read as unmapped changes and widen every narrow plan to the broad set.
 */
export const GATE_OUTPUT_FILES = ["gate-plan.txt", "gate-matrix.json", "gate-matrix.pw.json"]

/** The changed paths without the planner's own outputs (and `--matrix-json`'s file). */
export function withoutGateOutputs(paths: readonly string[], matrixFile?: string): string[] {
  const own = new Set(GATE_OUTPUT_FILES)
  if (matrixFile) own.add(path.relative(ROOT, path.resolve(matrixFile)))
  return paths.filter((p) => !own.has(p))
}

function changedPaths(base: string, matrixFile?: string): string[] {
  const mergeBase = git(["merge-base", base, "HEAD"]).trim()
  const lines = [
    ...git(["diff", "--name-only", mergeBase]).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
  ]
  return withoutGateOutputs([...new Set(lines.map((l) => l.trim()).filter(Boolean))], matrixFile)
}

/** A suite's cwd and what it selects, read from test-run.ts's own dry run. */
async function readSuiteInfo(suite: string): Promise<SuiteInfo | null> {
  const proc = Bun.spawn({
    cmd: ["bun", path.join(ROOT, "scripts/test-run.ts"), suite],
    cwd: ROOT,
    env: { ...process.env, LIAISON_TEST_DRY_RUN: "1" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const out = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) return null
  const cmdLine = out.split("\n").find((l) => l.startsWith("cmd: "))
  const cwdLine = out.split("\n").find((l) => l.startsWith("cwd: "))
  if (!cmdLine || cwdLine === undefined) return null
  const cwd = cwdLine.slice("cwd: ".length).trim()
  const argv = cmdLine.slice("cmd: ".length).trim().split(" ")
  const selects = argv
    .filter((a) => !a.startsWith("-") && !/^(bun|bunx|test|run|vitest|playwright)$/.test(a))
    .filter((a) => !a.endsWith("scripts/test-unit-parallel.ts") && !/^\d+$/.test(a))
    // The vitest binary and its config file are not test selections.
    .filter((a) => !a.includes("node_modules/") && !/config\.[cm]?ts$/.test(a))
    .map((a) => path.relative(ROOT, path.resolve(ROOT, cwd, a)))
  return { cwd, selects }
}

function fmt(ms: number): string {
  return ms < 60_000
    ? `${(ms / 1000).toFixed(1)}s`
    : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const baseAt = argv.indexOf("--base")
  const base = baseAt === -1 ? "origin/main" : (argv[baseAt + 1] ?? "origin/main")
  const dryRun = argv.includes("--dry-run")
  const matrixAt = argv.indexOf("--matrix-json")
  const matrixFile = matrixAt === -1 ? undefined : argv[matrixAt + 1]

  const changed = changedPaths(base, matrixFile)
  const mapped = new Set<string>(BROAD_SUITES)
  for (const f of changed) for (const s of suitesFor(f) ?? []) mapped.add(s)
  const infos: Record<string, SuiteInfo> = {}
  await Promise.all(
    [...mapped].map(async (s) => {
      const info = await readSuiteInfo(s)
      if (info) infos[s] = info
    }),
  )
  const listDir = (dir: string) => {
    try {
      return readdirSync(path.join(ROOT, dir))
    } catch {
      return []
    }
  }
  const plan = planGate(changed, infos, listDir)

  console.log(`test:gate: ${changed.length} changed path(s) since merge-base with ${base}`)
  if (plan.broad.length > 0) {
    console.log(`  ! not in .claude/test-map.ts, so the BROAD set runs: ${plan.broad.join(", ")}`)
  }
  if (plan.ignored.length > 0) console.log(`  no code: ${plan.ignored.join(", ")}`)
  for (const s of plan.skipped) console.log(`  skip ${s.suite}: ${s.why}`)
  for (const r of plan.run) {
    const scope = r.files.length > 0 ? `${r.files.length} file(s)` : "whole suite"
    console.log(`  run  ${r.suite} (${scope}${DB_SUITES.has(r.suite) ? ", db lane" : ""})`)
    for (const w of r.why) console.log(`         ${w}`)
  }
  if (matrixFile) {
    const include = gateMatrix(plan, infos)
    writeFileSync(matrixFile, `${JSON.stringify({ include })}\n`)
    const lanes = [...new Set(include.map((m) => `${m.suite} x${m.of}`))]
    console.log(`  gate lanes: ${lanes.length > 0 ? lanes.join(", ") : "none"}`)
    for (const r of plan.run) {
      const why = NOT_HOSTED_SUITES[r.suite]
      if (why) console.log(`  ! not run on hosted runners, run it on a Mac: ${r.suite} (${why})`)
    }
  }
  if (plan.run.length === 0) {
    console.log("nothing to run.")
    return 0
  }
  if (dryRun) return 0

  // One namespace, one port block and one slot for the whole gate; every
  // suite child inherits them (as the `full` flow's children do).
  const ns = namespaceForCheckout(ROOT)
  await acquireNamespaceLock(ns, { cmd: "test:gate" })
  const portBase = String(leasePortBlock(ns, { cmd: "test:gate" }).base)
  const slots = slotCount()
  await acquireTestLock({ cmd: "test:gate", ns })
  const budget = computeMemBudget(undefined, undefined, process.env, slots)
  const ts = new Date().toISOString().replace(/[T:]/g, "-").replace(/\..+/, "")
  const logDir = path.join(ROOT, "logs", `${ts}_gate`)
  mkdirSync(logDir, { recursive: true })
  const guard = startMemGuard({
    budgetMb: budget.budgetMb,
    reserveMb: budget.reserveMb,
    logDir,
    label: "test:gate",
  })
  console.log(formatMemGuard(budget.budgetMb, budget.reserveMb))
  const coords = resolveTestCoordinates({
    ...process.env,
    LIAISON_TEST_NS: ns,
    LIAISON_TEST_PORT_BASE: portBase,
  })
  if (plan.run.some((r) => DB_SUITES.has(r.suite))) {
    await prepareNamespaceDb({ root: ROOT, coords, fresh: false })
  }

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...budget.env(),
    ...namespaceEnv(coords),
    LIAISON_TEST_LOCK_HELD: "1",
    LIAISON_TEST_NS_HELD: "1",
  }
  delete childEnv.NODE_ENV

  const results: Array<{ suite: string; code: number; ms: number; log: string }> = []
  async function runSuite(r: SuitePlan): Promise<void> {
    const info = infos[r.suite]
    const fileArgs = fileArgsFor(r, info).flatMap((f) => ["--file", f])
    const log = path.join(logDir, `${r.suite}.log`)
    const t0 = Date.now()
    const proc = Bun.spawn({
      cmd: ["bun", "run", path.join(ROOT, "scripts/test-run.ts"), r.suite, ...fileArgs],
      cwd: ROOT,
      env: childEnv,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    const ms = Date.now() - t0
    writeFileSync(log, `${out}\n${err}`)
    results.push({ suite: r.suite, code, ms, log })
    console.log(
      `  ${code === 0 ? "✓" : "✗"} ${r.suite.padEnd(22)} ${fmt(ms).padStart(7)}  ${path.relative(ROOT, log)}`,
    )
    if (code !== 0) {
      const tail = `${out}\n${err}`
        .split("\n")
        .filter((l) => l.trim())
        .slice(-15)
      for (const l of tail) console.log(`      ${l}`)
    }
  }

  const t0 = Date.now()
  const { dbLane, light } = laneOrder(plan.run)
  const POOL = 3
  console.log(
    `\n▸ running ${plan.run.length} suite(s) in namespace ${ns}: db lane ${dbLane.length}, light pool ${light.length} (x${POOL})`,
  )
  const lightDone = (async () => {
    const queue = [...light]
    await Promise.all(
      Array.from({ length: Math.min(POOL, queue.length) }, async () => {
        for (let r = queue.shift(); r; r = queue.shift()) await runSuite(r)
      }),
    )
  })()
  await Promise.all([
    (async () => {
      for (const r of dbLane) {
        // A re-cloning suite renames the namespace database aside and kills
        // its connections; a light suite starting (its preflight queries the
        // database) or running then finds no database. Hold it until the
        // light pool has finished.
        if (CLEAN_SUBSTRATE_SUITES.has(r.suite)) await lightDone
        await runSuite(r)
      }
    })(),
    lightDone,
  ])
  guard.stop()
  const failed = results.filter((r) => r.code !== 0)
  console.log(
    `\ntest:gate: ${results.length - failed.length}/${results.length} suite(s) passed in ${fmt(Date.now() - t0)}${failed.length > 0 ? `; failed: ${failed.map((f) => f.suite).join(", ")}` : ""}`,
  )
  return failed.length > 0 ? 1 : 0
}

if (import.meta.main) {
  if (!existsSync(path.join(ROOT, ".claude/test-map.ts"))) {
    console.error("missing .claude/test-map.ts")
    process.exit(2)
  }
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err)
      process.exit(1)
    })
}
