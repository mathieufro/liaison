#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run scripts/ci-scope.ts scope|tests|biome|typecheck|typecheck-apps [--base <ref>] [--all] [--tool tsgo|tsc]`
//
// What a pull request has to check, and the checks themselves run on that
// scope. A pull request (GITHUB_BASE_REF set, or --base given) is scoped to the
// files it changes against the merge base; anything else (a push to main, a
// local run without --base, --all) checks everything.
//
//   scope      prints the scope; under Actions, writes `docs=true|false` to
//              $GITHUB_OUTPUT so the docs step can be skipped.
//   tests      which of the `ci` workflow's test suites run, through the test map
//              (.claude/test-map.ts): the api unit suite and web-unit. A pull
//              request runs the ones its changed files map to, each in as few
//              jobs as possible; a path the map does not cover (and that is not
//              plain docs) runs both. The relation cells (`relations`) run as a
//              step of the first `unit` job when the map attributes a change to
//              them, and on every full run. A merge group, or any run without a base,
//              runs both split over several runners: it is the full gate before
//              main. A push to main runs neither, the merge group already tested
//              that tree. Writes the outputs of `testOutputs` to $GITHUB_OUTPUT.
//   biome      Biome on the changed files (all files on a full run).
//   typecheck  every TypeScript project whose program contains a changed file.
//              The program is the project's own file list (`tsgo --listFilesOnly`),
//              so imports across packages, path aliases and relative reaches
//              into another package are all followed exactly; no hand-kept graph.
//              --tool tsgo (default) or tsc. Both are incremental: tsc keeps its
//              build info at the path in the project's tsconfig, tsgo beside it in
//              <name>.tsgo.tsbuildinfo (the formats differ, they must not share a file).
//   typecheck-apps  the same for the bundled apps, which are not workspaces: each
//              installs its own dependencies, then runs its own `typecheck` script,
//              the check a default `build-bundled-app.sh` stops on.
//
// Anything that can change every program or every lint result falls back to a
// full run: a package.json, the lockfile, a tsconfig, the Biome config, the CI
// workflow, this script. So does a deleted TypeScript file (resolution may now
// pick a different, unchanged file).

import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { DOCS_EXEMPT, DOCS_FAILSAFE_ROOTS, DOCS_MAP } from "../.claude/docs-map"
import { NO_CODE_PATHS, suitesFor } from "../.claude/test-map"

const ROOT = resolve(import.meta.dir, "..")

/** Changes that make every check run in full. */
export const FULL_RUN_GLOBS = [
  "package.json",
  "**/package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig*.json",
  "**/tsconfig*.json",
  "biome.json",
  "biome.jsonc",
  ".github/workflows/**",
  "scripts/ci-scope.ts",
]

/** Files that can be part of a TypeScript program. */
const TS_LIKE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/

/** Sources the docs check reads beyond the docs map: its own code, the docs
 * themselves and the generated reference pages' inputs (api sources, app manifests). */
const DOCS_SOURCE_GLOBS = [
  "docs/**",
  "scripts/docs/**",
  "scripts/check-docs.ts",
  ".claude/docs-map.ts",
  "apps/api/src/**",
  "bundled-apps/*/app.manifest.json",
]
const TEST_FILE =
  /(\.test\.tsx?$|\.testutil\.ts$|(^|\/)(tests|__fixtures__|fixtures|__snapshots__|test-support|__test-helpers__)\/)/

export type Change = { status: string; path: string }

export type Scope = {
  full: boolean
  reason: string
  base?: string
  changed: Change[]
  /** Existing changed files for Biome; ignored when `full`. */
  biomeFiles: string[]
  /** True when a changed file can reach a TypeScript program; ignored when `full`. */
  typescript: boolean
  /** Deleted TypeScript files force every project to check. */
  typescriptAll: boolean
  docs: boolean
}

function match(glob: string, file: string): boolean {
  return new Bun.Glob(glob).match(file)
}

export function docsRelevant(file: string): boolean {
  if (DOCS_SOURCE_GLOBS.some((g) => match(g, file))) {
    return !(file.startsWith("apps/api/src/") && TEST_FILE.test(file))
  }
  if (DOCS_MAP.some((e) => match(e.glob, file))) return true
  // A file under a fail-safe root that no entry maps or exempts fails the docs
  // check: the check has to run to say so.
  return (
    DOCS_FAILSAFE_ROOTS.some((r) => file.startsWith(r)) &&
    !DOCS_EXEMPT.some((e) => match(e.glob, file))
  )
}

export function classify(changed: Change[], base?: string): Scope {
  const empty = { changed, biomeFiles: [], typescript: false, typescriptAll: false }
  if (!base) return { ...empty, full: true, reason: "not a pull request", docs: true }
  const trigger = changed.find((c) => FULL_RUN_GLOBS.some((g) => match(g, c.path)))
  if (trigger) {
    return { ...empty, base, full: true, reason: `${trigger.path} changed`, docs: true }
  }
  const live = changed.filter((c) => c.status !== "D")
  return {
    full: false,
    reason: `${changed.length} changed files`,
    base,
    changed,
    biomeFiles: live.map((c) => c.path),
    typescript: live.some((c) => TS_LIKE.test(c.path)),
    typescriptAll: changed.some((c) => c.status === "D" && TS_LIKE.test(c.path)),
    docs: changed.some((c) => docsRelevant(c.path)),
  }
}

// ── Test jobs ─────────────────────────────────────────────────────────────

/** Changes that run every test job: the full-run triggers, and the map itself. */
export const TEST_FULL_RUN_GLOBS = [...FULL_RUN_GLOBS, ".claude/test-map.ts"]

export type TestScope = {
  /** The api unit suite (the `unit` job or jobs). */
  unit: boolean
  /** The web unit suite. */
  web: boolean
  /** The relation cells: a step of the first `unit` job, which then runs even without `unit`. */
  relations: boolean
  /**
   * The full gate (a merge group, or any run that is not a pull request): the
   * suites split over several runners for wall clock. A pull request runs each
   * suite in as few jobs as possible instead (runners are the scarce resource):
   * the api unit suite in two jobs (one took ~23 min, the long pole), the web
   * unit suite inside the static job.
   */
  gate: boolean
  reason: string
}

/** Runners each suite is split over on the full gate (TEST_UNIT_PART, vitest --shard). */
export const GATE_PARTS = { unit: 3, web: 2 }

/** Runners the api unit suite is split over on a pull request. */
export const PR_UNIT_PARTS = 2

/** The `ci` workflow's view of a {@link TestScope}, written to $GITHUB_OUTPUT. */
export function testOutputs(t: TestScope): Record<string, string> {
  const parts = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => i + 1))
  // A run for the relation cells alone needs one unit job, not the suite's split.
  const unitOf = t.gate ? GATE_PARTS.unit : t.unit ? PR_UNIT_PARTS : 1
  return {
    unit: String(t.unit),
    relations: String(t.relations),
    unit_of: String(unitOf),
    unit_parts: parts(unitOf),
    // `shards`: the web-unit jobs; `inline`: a step of the static job.
    web: t.web ? (t.gate ? "shards" : "inline") : "none",
    web_of: String(GATE_PARTS.web),
    web_parts: parts(GATE_PARTS.web),
  }
}

/**
 * Which test jobs a run needs. `event` is GITHUB_EVENT_NAME; `base` is set only
 * for a pull request (see {@link resolveBase}).
 */
export function testScope(
  event: string | undefined,
  changed: Change[],
  base: string | undefined,
  mapFor: (file: string) => string[] | null = suitesFor,
): TestScope {
  if (event === "push") {
    return {
      unit: false,
      web: false,
      relations: false,
      gate: false,
      reason: "push: the merge queue tested this tree",
    }
  }
  if (!base) {
    const reason = event === "merge_group" ? "merge group: full gate" : "not a pull request"
    return { unit: true, web: true, relations: true, gate: true, reason }
  }
  const all = (reason: string): TestScope => ({
    unit: true,
    web: true,
    relations: true,
    gate: false,
    reason,
  })
  const trigger = changed.find((c) => TEST_FULL_RUN_GLOBS.some((g) => match(g, c.path)))
  if (trigger) return all(`${trigger.path} changed`)
  const suites = new Set<string>()
  for (const c of changed) {
    const mapped = mapFor(c.path)
    if (mapped) for (const s of mapped) suites.add(s)
    else if (!NO_CODE_PATHS.some((re) => re.test(c.path)))
      return all(`${c.path} is not in the test map`)
  }
  return {
    unit: suites.has("unit"),
    web: suites.has("web-unit"),
    relations: suites.has("relations"),
    gate: false,
    reason: `${changed.length} changed files mapped to ${[...suites].sort().join(", ") || "no suite"}`,
  }
}

function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`)
  return r.stdout
}

export function changedFiles(base: string): Change[] {
  // Three dots: against the merge base, so commits on the base branch since the
  // PR branched are not counted. No rename detection: a rename is a delete and an add.
  return git(["diff", "--name-status", "--no-renames", `${base}...HEAD`])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split("\t")
      return { status: status.charAt(0), path }
    })
}

function resolveBase(argv: string[], env = process.env): string | undefined {
  if (argv.includes("--all")) return undefined
  const at = argv.indexOf("--base")
  if (at !== -1 && argv[at + 1]) return argv[at + 1]
  return env.GITHUB_EVENT_NAME === "pull_request" && env.GITHUB_BASE_REF
    ? `origin/${env.GITHUB_BASE_REF}`
    : undefined
}

export function computeScope(argv: string[]): Scope {
  const base = resolveBase(argv)
  return classify(base ? changedFiles(base) : [], base)
}

// ── TypeScript projects ───────────────────────────────────────────────────

export type Project = { dir: string; tsconfig: string }

/** Every workspace package with a `typecheck` script, plus scripts/. */
export function projects(root: string = ROOT): Project[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces: string[]
  }
  const dirs: string[] = []
  for (const pattern of pkg.workspaces) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2)
      for (const d of readdirSync(join(root, parent)).sort()) dirs.push(`${parent}/${d}`)
    } else dirs.push(pattern)
  }
  const out = typecheckedDirs(root, [...new Set(dirs)].sort())
  out.push({ dir: "scripts", tsconfig: "scripts/tsconfig.json" })
  return out
}

/** Every bundled app with a `typecheck` script. */
export function bundledApps(root: string = ROOT): Project[] {
  const parent = "bundled-apps"
  const dirs = readdirSync(join(root, parent)).map((d) => `${parent}/${d}`)
  return typecheckedDirs(root, dirs.sort())
}

function typecheckedDirs(root: string, dirs: string[]): Project[] {
  const out: Project[] = []
  for (const dir of dirs) {
    const manifest = join(root, dir, "package.json")
    if (!existsSync(manifest) || !existsSync(join(root, dir, "tsconfig.json"))) continue
    const scripts = (JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {}) as Record<
      string,
      string
    >
    if (scripts.typecheck) out.push({ dir, tsconfig: `${dir}/tsconfig.json` })
  }
  return out
}

function bin(name: string): string {
  return join(ROOT, "node_modules/.bin", name)
}

/** The project's buildinfo for `tool`: tsc's from its tsconfig, tsgo's beside it. */
function buildInfoArgs(p: Project, tool: "tsc" | "tsgo"): string[] {
  if (tool === "tsc") return []
  const config = readFileSync(join(ROOT, p.tsconfig), "utf8")
  const m = config.match(/"tsBuildInfoFile"\s*:\s*"([^"]+)\.tsbuildinfo"/)
  if (!m)
    throw new Error(`${p.tsconfig} sets no tsBuildInfoFile: typecheck is incremental everywhere`)
  return ["--incremental", "--tsBuildInfoFile", resolve(ROOT, p.dir, `${m[1]}.tsgo.tsbuildinfo`)]
}

export function programFiles(p: Project): Set<string> {
  const r = spawnSync(bin("tsgo"), ["-p", join(ROOT, p.tsconfig), "--listFilesOnly"], {
    cwd: join(ROOT, p.dir),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`listing ${p.tsconfig} failed: ${r.stderr || r.stdout}`)
  return new Set(
    r.stdout
      .split("\n")
      .filter((f) => f && !f.includes("/node_modules/"))
      .map((f) => relative(ROOT, resolve(ROOT, p.dir, f))),
  )
}

export function selectProjects(scope: Scope, all: Project[] = projects()): Project[] {
  if (scope.full || scope.typescriptAll) return all
  if (!scope.typescript) return []
  const touched = scope.changed.filter((c) => c.status !== "D").map((c) => c.path)
  return all.filter((p) => {
    const files = programFiles(p)
    return touched.some((f) => files.has(f))
  })
}

function run(cmd: string[], cwd = ROOT): number {
  console.log(
    `$ ${cmd.map((c) => relative(ROOT, c) || c).join(" ")}  (in ${relative(ROOT, cwd) || "."})`,
  )
  return spawnSync(cmd[0], cmd.slice(1), { cwd, stdio: "inherit" }).status ?? 1
}

function describe(scope: Scope): string {
  if (scope.full) return `full run (${scope.reason})`
  return `${scope.reason} vs ${scope.base}`
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv
  const scope = computeScope(argv)
  if (command === "tests") {
    const t = testScope(process.env.GITHUB_EVENT_NAME, scope.changed, scope.base)
    const out = testOutputs(t)
    console.log(
      `api unit: ${t.unit ? `runs on ${out.unit_of} runner(s)` : "skipped"}; web unit: ${out.web}; relations: ${t.relations ? "runs" : "skipped"} (${t.reason})`,
    )
    if (process.env.GITHUB_OUTPUT) {
      const lines = Object.entries(out).map(([k, v]) => `${k}=${v}\n`)
      appendFileSync(process.env.GITHUB_OUTPUT, lines.join(""))
    }
    return 0
  }
  if (command === "scope") {
    console.log(`scope: ${describe(scope)}`)
    console.log(
      `docs check: ${scope.docs ? "runs" : "skipped (no file the docs check reads changed)"}`,
    )
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `docs=${scope.docs}\n`)
    }
    return 0
  }
  if (command === "biome") {
    if (scope.full) return run([bin("biome"), "check", "."])
    if (scope.biomeFiles.length === 0) {
      console.log(`biome: no changed files (${describe(scope)})`)
      return 0
    }
    console.log(`biome: ${scope.biomeFiles.length} changed files (${describe(scope)})`)
    return run([
      bin("biome"),
      "check",
      "--files-ignore-unknown=true",
      "--no-errors-on-unmatched",
      ...scope.biomeFiles,
    ])
  }
  if (command === "typecheck") {
    const at = argv.indexOf("--tool")
    const tool = (at !== -1 ? argv[at + 1] : "tsgo") as "tsc" | "tsgo"
    if (tool !== "tsc" && tool !== "tsgo")
      throw new Error(`--tool must be tsc or tsgo, not ${tool}`)
    const all = projects()
    const selected = selectProjects(scope, all)
    const skipped = all.filter((p) => !selected.includes(p)).map((p) => p.dir)
    console.log(
      `typecheck (${tool}): ${selected.length}/${all.length} projects (${describe(scope)})` +
        (skipped.length > 0
          ? `; skipped, no changed file in their program: ${skipped.join(", ")}`
          : ""),
    )
    let failed = 0
    for (const p of selected) {
      const cmd = [bin(tool), "--noEmit", "-p", join(ROOT, p.tsconfig), ...buildInfoArgs(p, tool)]
      if (run(cmd, join(ROOT, p.dir)) !== 0) failed++
    }
    return failed === 0 ? 0 : 1
  }
  if (command === "typecheck-apps") {
    if (!scope.full && !scope.typescript && !scope.typescriptAll) {
      console.log(`typecheck-apps: no TypeScript file changed (${describe(scope)})`)
      return 0
    }
    const all = bundledApps()
    // An app's program lists its dependencies, so they come first.
    for (const p of all) {
      if (run(["bun", "install"], join(ROOT, p.dir)) !== 0) return 1
    }
    const selected = selectProjects(scope, all)
    console.log(`typecheck-apps: ${selected.length}/${all.length} apps (${describe(scope)})`)
    let failed = 0
    for (const p of selected) {
      if (run(["bun", "run", "typecheck"], join(ROOT, p.dir)) !== 0) failed++
    }
    return failed === 0 ? 0 : 1
  }
  console.error(
    "Usage: bun run scripts/ci-scope.ts scope|tests|biome|typecheck|typecheck-apps [--base <ref>] [--all] [--tool tsgo|tsc]",
  )
  return 2
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
