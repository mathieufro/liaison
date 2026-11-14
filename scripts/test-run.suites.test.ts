// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Suite-coverage lint (Phase 1, Tasks 1.6 and 1.7).
//
// `scripts/test-run.ts` is the only dispatcher CI uses, and two of its suites
// enumerate paths by hand: `integration` lists individual files, and every
// workspace package needs its own suite entry plus a FULL_ORDER entry. A test
// file that no suite lists is decoration: it sits on disk, it is never run, and
// nobody notices. This lint is what stops the next one from being written.
//
// Two exemption arrays below record the debt that already existed when the
// lint was introduced. They may only ever SHRINK. Their exact lengths are
// asserted, so appending to one is a test failure rather than a quiet habit.

import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { apiE2eScenarioFiles, apiE2eTestFiles, CELL_DIR, isCellPath } from "./lib/api-e2e-files"
import { PENDING_SUITES } from "./lib/pending-suites"
import { readSuiteExtras, withExtraListings } from "./lib/suite-extras"

const ROOT = path.resolve(import.meta.dir, "..")
const SOURCE = readFileSync(path.join(ROOT, "scripts/test-run.ts"), "utf8")

/**
 * WHY A FILE IS IN NO SUITE, PER FILE.
 *
 * The first version of this list was 19 names under one prose sentence saying
 * they "need a live substrate". That reason was never true of most of them:
 * the `integration` suite provisions Postgres, Redis and the sandbox, and 18
 * of the 19 ran green against exactly that, so they were not exempt, they were
 * forgotten. A blanket reason cannot go stale, which is the same as saying it
 * can never be checked.
 *
 * So each entry now names WHAT the file needs, and `needs` is a literal the
 * file must still contain. The day the file stops naming it, this list is
 * wrong and says so.
 */
interface UnroutedReason {
  reason: string
  /** A literal that must appear in the file's source, so the reason is checkable. */
  needs: string
}

const KNOWN_UNROUTED_INTEGRATION: Record<string, UnroutedReason> = {
  // Empty since P8-FX21 (A45): calls-webhook.integration.test.ts was the last
  // entry, exempt on a product question (should a webhook ingestion gate at
  // all). The answer is no, so the file is routed in the integration suite and
  // the exemption is gone. The list may only ever shrink.
}

/**
 * Integration files the suite lists that later phases of the mailbox-encryption
 * blueprint still have to create. Bun treats a missing path in a multi-path
 * `bun test` invocation as a filter that matches nothing, NOT as an error, so a
 * listed-but-absent file is silent. This array is the loud half: the phase that
 * creates one of these files must delete its entry here, which is what makes
 * the creation visible. It may only ever shrink.
 */
const PENDING_INTEGRATION_FILES: string[] = [
  // Emptied by Phase 14: all four files exist on disk now, so the suite lists
  // no phantom at all. This is the strictest state the assertion has, and the
  // list may only ever shrink, never grow.
]

/**
 * Workspace packages carrying tests that no suite runs.
 *
 * EMPTY, and it has to stay derivable: the six names that used to sit here
 * were exempted under the same blanket "needs a substrate" sentence as the
 * integration files, and all six run green with nothing but the repo. Five are
 * in the `workspace-packages` suite now; `test-helpers` was already covered by
 * `worker-env`, whose cwd IS that package.
 */
const KNOWN_UNROUTED_PACKAGES: Record<string, UnroutedReason> = {}

/**
 * Repo-root scripts/*.test.ts files that no suite routed when this lint was
 * written. Unlike bundled-apps/ and src/tests/integration/, no earlier guard
 * ever looked at scripts/ directly -- scripts/report-skills.test.ts sat in
 * FULL_ORDER for months naming a file that was never committed here (see the
 * git history on the "report-skills" suite entry), and it took a manual audit
 * to find it. These are the files discovered unrouted at that audit. Each is
 * exercised by its own `bun run` invocation in package.json instead, which is
 * why this is debt rather than an emergency. May only ever shrink.
 */
const KNOWN_UNROUTED_SCRIPTS = [
  "check-bundled-app-purity.test.ts",
  "check-claude-md.test.ts",
  "check-migration-baseline.test.ts",
  "check-runbook-sections.test.ts",
  "check-spdx.test.ts",
  "create-app.test.ts",
  "docs-link-check.test.ts",
  "freeze-app.test.ts",
  "i18n-gen-dictionaries.test.ts",
  "lint-db-connection-import.test.ts",
  "lint-i18n-strings.test.ts",
  "preflight.test.ts",
  "skill-validate.test.ts",
  "strobe-runner.test.ts",
  "validate-compose.test.ts",
]

/** Split the SUITES object into `{ suiteName: blockText }`. */
function suiteBlocks(source: string = SOURCE): Record<string, string> {
  const start = source.indexOf("const SUITES")
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start)
  const blocks: Record<string, string> = {}
  const header = /^ {2}"?([a-z0-9-]+)"?: \{$/gm
  const matches = Array.from(body.matchAll(header))
  for (let i = 0; i < matches.length; i++) {
    const from = (matches[i].index ?? 0) + matches[i][0].length
    const to = i + 1 < matches.length ? (matches[i + 1].index ?? body.length) : body.length
    blocks[matches[i][1]] = body.slice(from, to)
  }
  // A suite's extra files (scripts/test-suites.d) read as listings of that suite.
  if (source === SOURCE) {
    const extras = readSuiteExtras()
    for (const name of Object.keys(blocks)) {
      blocks[name] = withExtraListings(name, blocks[name], extras)
    }
  }
  return blocks
}

/**
 * The `src/<dir>` prefixes the `unit` suite selects WHOLE, read from the suite
 * itself. Hardcoding the list here meant a ninth directory added to the runner
 * was silently outside every check this file makes of "what a gate suite
 * selects whole" — the guard would keep passing while the new directory took
 * live tests nobody ran.
 */
function unitDirs(source: string = SOURCE): string[] {
  const block = suiteBlocks(source).unit
  expect(block).toBeDefined()
  const dirs = Array.from(block.matchAll(/"src\/([A-Za-z0-9_-]+)"/g)).map((m) => m[1])
  expect(dirs.length).toBeGreaterThan(0)
  return [...new Set(dirs)]
}

function fullOrder(): string[] {
  const match = SOURCE.match(/const FULL_ORDER = \[([\s\S]*?)\]/)
  expect(match).not.toBeNull()
  return Array.from((match as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)).map((m) => m[1])
}

describe("test-run.ts suite coverage: integration files", () => {
  const onDisk = readdirSync(path.join(ROOT, "apps/api/src/tests/integration")).filter((f) =>
    f.endsWith(".test.ts"),
  )

  it("finds the integration directory and the suite block", () => {
    expect(onDisk.length).toBeGreaterThanOrEqual(6)
    expect(suiteBlocks().integration).toBeDefined()
  })

  it("lists every integration test file in exactly one suite, exemptions aside", () => {
    const blocks = suiteBlocks()
    const counts = new Map<string, number>()
    for (const file of onDisk) counts.set(file, 0)
    for (const block of Object.values(blocks)) {
      for (const file of onDisk) {
        if (block.includes(`src/tests/integration/${file}`)) {
          counts.set(file, (counts.get(file) ?? 0) + 1)
        }
      }
    }
    const missing = onDisk.filter(
      (f) => (counts.get(f) ?? 0) === 0 && !(f in KNOWN_UNROUTED_INTEGRATION),
    )
    const duplicated = onDisk.filter((f) => (counts.get(f) ?? 0) > 1)
    expect(missing).toEqual([])
    expect(duplicated).toEqual([])
  })

  it("keeps every file the integration suite names present on disk", () => {
    const listed = Array.from(
      suiteBlocks().integration.matchAll(/"(src\/tests\/integration\/[^"]+)"/g),
    ).map((m) => path.basename(m[1]))
    expect(listed.length).toBeGreaterThanOrEqual(6)
    // Files a later phase creates are allowed to be absent for now: the loud
    // failure of `bun test` on a missing path is the red state that phase owns.
    // What is NOT allowed is an exemption entry for a file that no longer exists.
    for (const exempt of Object.keys(KNOWN_UNROUTED_INTEGRATION)) {
      expect(onDisk, `stale exemption ${exempt}`).toContain(exempt)
    }
  })

  it("lists no phantom file beyond the ones later phases still owe", () => {
    const listed = Array.from(
      suiteBlocks().integration.matchAll(/"(src\/tests\/integration\/[^"]+)"/g),
    ).map((m) => path.basename(m[1]))
    expect(listed.length).toBeGreaterThanOrEqual(6)
    const absent = listed.filter((f) => !onDisk.includes(f)).sort()
    expect(absent).toEqual([...PENDING_INTEGRATION_FILES].sort())
  })

  it("holds the integration exemption list at its size, so it can only shrink", () => {
    expect(Object.keys(KNOWN_UNROUTED_INTEGRATION).length).toBe(0)
  })

  it("every integration exemption still names the thing its reason blames", () => {
    for (const [file, { reason, needs }] of Object.entries(KNOWN_UNROUTED_INTEGRATION)) {
      expect(reason.length, file).toBeGreaterThan(20)
      const source = readFileSync(path.join(ROOT, "apps/api/src/tests/integration", file), "utf8")
      expect(source.includes(needs), `${file} no longer names ${needs}`).toBe(true)
    }
  })
})

// THE LIVE SUITE (P8-FX10).
//
// A test that talks to a real third party over a real credential answers a
// question about the credential as much as about the code. Two of them sat in
// directories the `unit` suite selects whole (src/apps, src/services), so an
// expired GitLab read-only token turned 9082 unit tests red on an HTTP 401. The
// files are not deleted and not weakened: they live in src/tests/live, which no
// gate suite selects, and the `live` suite runs them on demand. This describe is
// what keeps them accounted for rather than quietly unreachable.
describe("test-run.ts suite coverage: the live suite", () => {
  const LIVE_DIR = path.join(ROOT, "apps/api/src/tests/live")
  const onDisk = readdirSync(LIVE_DIR).filter((f) => f.endsWith(".test.ts"))

  it("has a live suite that names the live directory", () => {
    const block = suiteBlocks().live
    expect(block).toBeDefined()
    expect(block).toContain('"src/tests/live"')
    expect(block).toContain('cwd: path.join(ROOT, "apps/api")')
  })

  it("keeps the live files on disk, so the suite points at something", () => {
    expect(onDisk).toContain("real-gitlab.live.test.ts")
    expect(onDisk).toContain("agent-deferred-tools.live.test.ts")
  })

  it("keeps each live file gated on the credential it needs", () => {
    const gates: Record<string, string> = {
      "real-gitlab.live.test.ts": "GITLAB_TEST_TOKEN",
      "agent-deferred-tools.live.test.ts": "GOOGLE_API_KEY",
    }
    for (const [file, envVar] of Object.entries(gates)) {
      const source = readFileSync(path.join(LIVE_DIR, file), "utf8")
      expect(source.includes(envVar), `${file} no longer names ${envVar}`).toBe(true)
      expect(source.includes("skipIf"), `${file} no longer skips without it`).toBe(true)
    }
  })

  it("leaves no live file in a directory a gate suite selects whole", () => {
    const stragglers: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith(".live.test.ts")) stragglers.push(full.slice(ROOT.length + 1))
      }
    }
    for (const dir of unitDirs()) walk(path.join(ROOT, "apps/api/src", dir))
    expect(stragglers).toEqual([])
  })

  it("reads the unit directories from the runner, so a ninth one is covered too", () => {
    // The real runner, and then a scratch source with a directory the
    // hardcoded list never had: the derivation has to pick it up on its own.
    expect(unitDirs()).toContain("modules")
    expect(unitDirs()).toContain("cli")
    const scratch = `const SUITES = {
  unit: {
    cmd: ["bun", "test", "src/modules", "src/infra", "src/ninthdir"],
    cwd: path.join(ROOT, "apps/api"),
  },
  guards: {
    cmd: ["bun", "test", "scripts"],
    cwd: ROOT,
  },
}`
    expect(unitDirs(scratch)).toEqual(["modules", "infra", "ninthdir"])
  })

  it("keeps the live suite out of a full run, since it needs credentials", () => {
    expect(fullOrder()).not.toContain("live")
  })
})

// A suite whose files all belong to a parallel line of work is SKIPPED by the
// runner rather than failed (see scripts/lib/pending-suites.ts). That is only
// safe while the declaration stays true: the day one of the files lands, the
// suite must go back into the run, and nothing but this would say so.
describe("test-run.ts suite coverage: pending suites", () => {
  function suiteCwd(block: string): string {
    const match = block.match(/cwd: (?:path\.join\(ROOT, "([^"]+)"\)|ROOT)/)
    return match?.[1] ? path.join(ROOT, match[1]) : ROOT
  }

  function namedFiles(block: string): string[] {
    return Array.from(block.matchAll(/"([^"]+\.test\.tsx?)"/g)).map((m) => m[1])
  }

  it("declares a pending suite that test-run.ts really has", () => {
    const blocks = suiteBlocks()
    expect(Object.keys(PENDING_SUITES).length).toBeGreaterThan(0)
    for (const name of Object.keys(PENDING_SUITES)) {
      expect(blocks[name], `pending suite ${name} has no suite block`).toBeDefined()
      expect(fullOrder()).toContain(name)
    }
  })

  it("lists exactly the files the suite names and cannot find on disk", () => {
    const blocks = suiteBlocks()
    for (const [name, pending] of Object.entries(PENDING_SUITES)) {
      const cwd = suiteCwd(blocks[name])
      const absent = namedFiles(blocks[name])
        .filter((f) => !existsSync(path.join(cwd, f)))
        .sort()
      // Red the day one of these files lands: the entry must come out and the
      // suite must start running again.
      expect(absent, `pending list for ${name} is stale`).toEqual([...pending.files].sort())
    }
  })

  it("skips a pending suite with a reason and exit 0, instead of failing it", async () => {
    const name = Object.keys(PENDING_SUITES)[0]
    const proc = Bun.spawn({
      cmd: ["bun", "scripts/test-run.ts", name],
      cwd: ROOT,
      env: { ...process.env, LIAISON_TEST_DRY_RUN: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    expect(code).toBe(0)
    expect(out).toContain(`Skipping ${name}: pending: `)
    expect(out).toContain(PENDING_SUITES[name].reason)
    for (const file of PENDING_SUITES[name].files) {
      expect(out).toContain(`pending file: ${file}`)
    }
  }, 60_000)
})

describe("test-run.ts suite coverage: workspace packages", () => {
  const packagesDir = path.join(ROOT, "packages")

  function hasTests(dir: string): boolean {
    const stack = [dir]
    while (stack.length > 0) {
      const current = stack.pop() as string
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) stack.push(full)
        else if (entry.name.endsWith(".test.ts")) return true
      }
    }
    return false
  }

  const tested = readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && hasTests(path.join(packagesDir, e.name)))
    .map((e) => e.name)

  it("finds tested packages", () => {
    expect(tested.length).toBeGreaterThan(0)
    expect(tested).toContain("mailbox-crypto")
  })

  it("gives every tested package a suite that FULL_ORDER runs, exemptions aside", () => {
    const blocks = suiteBlocks()
    const order = fullOrder()
    expect(order.length).toBeGreaterThan(0)
    const missing: string[] = []
    for (const name of tested) {
      if (name in KNOWN_UNROUTED_PACKAGES) continue
      const owners = Object.entries(blocks).filter(([, block]) =>
        block.includes(`path.join(ROOT, "packages/${name}")`),
      )
      // A package may be run in TWO halves, and only two: `bun test` for its
      // plain modules plus one `<name>-ui` vitest suite for the Solid JSX bun
      // cannot transform (packages/app-ui's CardTable). Each half has its own
      // file pattern, so nothing runs twice. Any other double ownership is a
      // file running in two suites, which is what this gate exists to catch.
      const uiHalves = owners.filter(([suite]) => suite.endsWith("-ui"))
      if (owners.length - uiHalves.length !== 1 || uiHalves.length > 1) {
        missing.push(`${name}: ${owners.length} suites`)
        continue
      }
      for (const [suite] of owners) {
        if (!order.includes(suite)) missing.push(`${name}: ${suite} not in FULL_ORDER`)
      }
    }
    expect(missing).toEqual([])
  })

  it("holds the package exemption list at its size, so it can only shrink", () => {
    expect(Object.keys(KNOWN_UNROUTED_PACKAGES).length).toBe(0)
    for (const name of Object.keys(KNOWN_UNROUTED_PACKAGES)) {
      expect(tested, `stale exemption ${name}`).toContain(name)
    }
  })
})

// The no-dash copy lint is a repo-root lint like the i18n one: it runs in the
// `root` suite, not in an exemption list. Neither
// exemption array above may grow to hold it.
describe("test-run.ts suite coverage: the copy lint", () => {
  const FILE = "scripts/lint-copy-dashes.test.ts"

  it("lists lint-copy-dashes.test.ts in the root suite", () => {
    const root = suiteBlocks().root
    expect(root).toBeDefined()
    expect(root).toContain(FILE)
  })

  it("routes lint-copy-dashes.test.ts in exactly one suite", () => {
    const owners = Object.entries(suiteBlocks()).filter(([, block]) => block.includes(FILE))
    expect(owners.length).toBe(1)
  })

  // The scanner unit tests can pass while customer copy carries dashes: only a
  // run over the real repo fails the build on a dash that shipped.
  // The sweep moved to the `guards` suite with the other repo-root gates: it
  // is the half that fails on a dash that actually shipped, and `root` is run
  // by no gate.
  it("lists the repo-wide copy sweep in the guards suite", () => {
    expect(suiteBlocks().guards).toContain("scripts/lint-copy-dashes.repo.test.ts")
  })

  it("routes the repo-wide copy sweep in exactly one suite", () => {
    const owners = Object.entries(suiteBlocks()).filter(([, block]) =>
      block.includes("scripts/lint-copy-dashes.repo.test.ts"),
    )
    expect(owners.length).toBe(1)
  })

  it("keeps the copy lint out of every unrouted exemption list", () => {
    expect(Object.keys(KNOWN_UNROUTED_INTEGRATION)).not.toContain("lint-copy-dashes.test.ts")
    expect(Object.keys(KNOWN_UNROUTED_PACKAGES)).not.toContain("lint-copy-dashes")
  })

  it("exposes a lint:copy script next to lint:i18n", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts["lint:i18n"]).toBeDefined()
    expect(pkg.scripts["lint:copy"]).toBe("bun run scripts/lint-copy-dashes.ts")
  })
})

describe("test-run.ts suite coverage: the desktop bun half", () => {
  const DESKTOP = path.join(ROOT, "apps/desktop")

  function onDiskBunTests(): string[] {
    const found: string[] = []
    for (const dir of [".", "ci", "sidecar", "src/tests/e2e"]) {
      const absolute = path.join(DESKTOP, dir)
      for (const name of readdirSync(absolute)) {
        if (!name.endsWith(".test.ts")) continue
        found.push(dir === "." ? name : `${dir}/${name}`)
      }
    }
    return found.sort()
  }

  async function dryRunCommand(): Promise<string> {
    const proc = Bun.spawn({
      cmd: ["bun", "scripts/test-run.ts", "desktop"],
      cwd: ROOT,
      env: { ...process.env, LIAISON_TEST_DRY_RUN: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out
  }

  it("finds desktop test files on disk at all, so an empty read cannot pass", () => {
    const onDisk = onDiskBunTests()
    expect(onDisk.length).toBeGreaterThan(8)
    expect(onDisk).toContain("capabilities.test.ts")
    expect(onDisk).toContain("sidecar/index.test.ts")
    // The overlay's own components run under vitest, but its live e2e scenario
    // is a bun file under src/tests/e2e: unlisted, it ran in no suite at all.
    expect(onDisk).toContain("src/tests/e2e/local-session-full-loop.scenario.test.ts")
  })

  it("runs every bun test file apps/desktop carries", async () => {
    const command = await dryRunCommand()
    const missing = onDiskBunTests().filter((file) => !command.includes(` ${file}`))
    expect(missing).toEqual([])
  })

  // The release scripts live in apps/desktop/ci, and a test written NEXT TO
  // the script it pins is the natural place to write it. That directory was
  // not in the glob, so such a file ran in no suite and nothing said so: the
  // same failure the hand written list had, one directory along. The fixture
  // is written and removed here rather than asserted from the source text,
  // because what matters is the command the runner actually builds.
  it("collects a test file living next to the ci scripts", async () => {
    const fixture = path.join(DESKTOP, "ci", "collected-fixture.test.ts")
    writeFileSync(fixture, 'import { it } from "bun:test"\nit("is collected", () => {})\n')
    try {
      expect(await dryRunCommand()).toContain(" ci/collected-fixture.test.ts")
    } finally {
      rmSync(fixture, { force: true })
    }
  })

  // It is the slowest file in the suite (it shells out to cargo), which is
  // exactly why somebody would drop it. It stays.
  it("keeps the scaffold check in the suite", async () => {
    expect(await dryRunCommand()).toContain(" scaffold.test.ts")
  })

  // src/** is vitest's half. A bun run over a Solid component file fails on
  // the JSX, so the glob must not reach into it. The ONE src path the bun half
  // owns is src/tests/e2e, the live scenario: no JSX, a real sidecar, a real
  // server, and vitest excludes that directory for the same reason.
  it("leaves the Solid components to the vitest half", async () => {
    const command = await dryRunCommand()
    const srcFiles = [...command.matchAll(/\ssrc\/\S+/g)].map((match) => match[0].trim())
    expect(srcFiles.every((file) => file.startsWith("src/tests/e2e/"))).toBe(true)
    expect(command).not.toContain(" src/session/")
    expect(command).not.toContain(" src/onboarding/")
  })
})

// The desktop package has TWO test halves: pure modules on `bun test` and the
// overlay's Solid components on vitest. A half that no suite runs is exactly
// the decoration this lint exists to stop, and the vitest half is the easy one
// to forget because the `desktop` suite already looks like it covers apps/desktop.
describe("test-run.ts suite coverage: the desktop overlay components", () => {
  it("routes the vitest half of apps/desktop through its own suite", () => {
    const block = suiteBlocks()["desktop-ui"]
    expect(block).toBeDefined()
    expect(block).toContain("vitest")
    expect(block).toContain('path.join(ROOT, "apps/desktop")')
  })

  it("runs that suite in a full run", () => {
    expect(fullOrder()).toContain("desktop-ui")
  })
})

// THE REPO-ROOT GUARDS. Four checks that fail a DEPLOY or a shipped string,
// not a feature: the API image's workspace list, the no-Node gate for the
// desktop stack, the repo-wide copy sweep and this lint itself. They lived in
// `root`, which no gate runs, so each of them was a guard nobody consulted:
// the Dockerfile one was red for a whole slice before anybody looked. They are
// their own suite now, cheap enough to run on any change.
describe("test-run.ts suite coverage: the guards suite", () => {
  const GUARDS = [
    "scripts/dockerfile-workspaces.test.ts",
    "scripts/check-desktop-no-node.test.ts",
    "scripts/lint-copy-dashes.repo.test.ts",
    "scripts/test-run.suites.test.ts",
  ]

  /** The path as a LISTED entry, not as a mention inside a comment. */
  const listed = (guard: string) => `"${guard}"`

  it("holds every repo-root guard", () => {
    const block = suiteBlocks().guards
    expect(block).toBeDefined()
    for (const guard of GUARDS) expect(block).toContain(listed(guard))
  })

  it("routes each guard in exactly one suite", () => {
    for (const guard of GUARDS) {
      const owners = Object.entries(suiteBlocks()).filter(([, block]) =>
        block.includes(listed(guard)),
      )
      expect(owners.map(([name]) => name)).toEqual(["guards"])
    }
  })

  it("runs in a full run", () => {
    expect(fullOrder()).toContain("guards")
  })

  // A SUITE NO SCRIPT NAMES IS A SUITE NO GATE RUNS. These four files used to
  // ride along in `root`, which `test:unit` runs, so moving them out quietly
  // made them rarer than they had been. The suite gets its own script and
  // `test:unit` runs it, which is at least as often as before.
  it("has a script of its own", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts["test:guards"]).toBe("bun run scripts/test-run.ts guards")
  })

  it("is run by test:unit, as root ran these files before", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts["test:unit"]).toContain("test:guards")
  })

  // And a path-targeted run has to reach it too: the map is what
  // `run-tests --files` consults, and an unmapped guard is one a targeted run
  // never picks up.
  it("routes every guard through the test map", () => {
    const map = readFileSync(path.join(ROOT, ".claude/test-map.ts"), "utf8")
    for (const guard of GUARDS) {
      const stem = guard.replace(/\.test\.ts$/, "")
      const entry = map
        .split("\n")
        .find((line) => line.includes(`glob: "${stem}`) || line.includes(`glob: "${guard}"`))
      expect(entry, `no test-map entry for ${guard}`).toBeDefined()
      expect(entry).toContain('"guards"')
    }
  })
})

// EVERY `bun test` suite has to name its own --timeout on the command line.
// bun 1.3.11 ignores `[test] timeout` in bunfig.toml: both bunfig files ask for
// 60 s and bun runs at its built-in 5 s default anyway. A 91-minute sweep of
// apps/api reported 435 failures of which 307 were that default and nothing
// else (every one of those scopes is green when re-run with --timeout 60000).
// A suite without the flag is therefore not a suite that runs slowly, it is a
// suite that reports failures it does not have. Asserted against the command
// the runner ACTUALLY builds, not against the source text, because the flag is
// injected after the table is declared.
describe("test-run.ts: the per-test timeout every bun suite runs under", () => {
  async function dryRun(name: string): Promise<string> {
    const proc = Bun.spawn({
      cmd: ["bun", "scripts/test-run.ts", name],
      cwd: ROOT,
      env: { ...process.env, LIAISON_TEST_DRY_RUN: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out
  }

  it("gives every bun-test suite an explicit --timeout of at least 60 seconds", async () => {
    const names = Object.keys(suiteBlocks())
    expect(names.length).toBeGreaterThan(10)
    const commands = await Promise.all(names.map(async (n) => [n, await dryRun(n)] as const))
    const offenders: string[] = []
    for (const [name, out] of commands) {
      const line = out.split("\n").find((l) => l.startsWith("cmd: "))
      if (!line) {
        offenders.push(`${name}: no cmd line`)
        continue
      }
      const argv = line.slice("cmd: ".length).trim().split(" ")
      if (argv[0] !== "bun" || argv[1] !== "test") continue
      const at = argv.indexOf("--timeout")
      if (at === -1) {
        offenders.push(`${name}: no --timeout`)
        continue
      }
      const ms = Number(argv[at + 1])
      if (!Number.isFinite(ms) || ms < 60000) offenders.push(`${name}: --timeout ${argv[at + 1]}`)
    }
    expect(offenders).toEqual([])
  })

  // The injection must not clobber a suite that asked for a longer cap of its
  // own: desktop shells out to cargo, demo-seed seeds whole demo worlds.
  it("leaves a suite's own longer cap alone", async () => {
    for (const [name, ms] of [
      ["desktop", 600000],
      ["demo-seed", 180000],
    ] as const) {
      const out = await dryRun(name)
      expect(out, `${name}`).toContain(`--timeout ${ms}`)
    }
  })

  // bunfig's [test] timeout is the thing that does NOT work. It stays in the
  // file for Strobe and for a bare `bun test`, but nothing may rely on it, so
  // the comment above it has to keep saying why the command-line flag exists.
  it("records in test-run.ts why the flag is not left to bunfig", () => {
    expect(SOURCE).toContain("bunfig")
    expect(SOURCE).toContain("BUN_TEST_TIMEOUT_MS")
  })
})

// THE STATIC GUARDS UNDER apps/api/src/tests AND THE db-gate APP.
//
// `unit` lists src/modules, src/infra, src/middleware, src/lib, src/db,
// src/apps, src/services and src/cli. src/tests is in NONE of them, and the
// `integration` suite enumerates that directory by hand, so a guard written
// there runs in no suite unless somebody remembers to list it. Three did not
// get listed: raw-fetch-discipline and no-stripe-imports were red for an entire
// epic with no gate to say so, and apps/db-gate (an app, so outside the
// packages/* sweep above) had all 26 of its tests running nowhere.
describe("test-run.ts suite coverage: apps/api/src/tests and apps/db-gate", () => {
  const API_TESTS = path.join(ROOT, "apps/api/src/tests")

  /**
   * Files in apps/api/src/tests that no suite lists.
   *
   * EMPTY. The sixteen names that used to sit here shared one sentence saying
   * they needed "a live substrate (Postgres, the sandbox, a spawned server)",
   * with no per-file reason and nothing that could ever make the claim go
   * stale. Every one of them was then run against the substrate the
   * `integration` suite already provisions, and every one was green, so the
   * reason was never true: they were forgotten, not exempt. They are routed.
   */
  const KNOWN_UNROUTED_API_TESTS: Record<string, UnroutedReason> = {}

  const onDisk = readdirSync(API_TESTS).filter((f) => f.endsWith(".test.ts"))

  it("finds the api test directory, so an empty read cannot pass", () => {
    expect(onDisk.length).toBeGreaterThan(20)
    expect(onDisk).toContain("raw-fetch-discipline.test.ts")
    expect(onDisk).toContain("no-stripe-imports.test.ts")
  })

  it("routes every apps/api/src/tests file through exactly one suite, exemptions aside", () => {
    const blocks = suiteBlocks()
    const problems: string[] = []
    for (const file of onDisk) {
      if (file in KNOWN_UNROUTED_API_TESTS) continue
      const owners = Object.entries(blocks).filter(([, block]) =>
        block.includes(`"src/tests/${file}"`),
      )
      if (owners.length !== 1) problems.push(`${file}: ${owners.length} suites`)
    }
    expect(problems).toEqual([])
  })

  it("holds the api-test exemption list at its size, so it can only shrink", () => {
    expect(Object.keys(KNOWN_UNROUTED_API_TESTS).length).toBe(0)
    for (const [name, { reason, needs }] of Object.entries(KNOWN_UNROUTED_API_TESTS)) {
      expect(onDisk, `stale exemption ${name}`).toContain(name)
      expect(reason.length, name).toBeGreaterThan(20)
      const source = readFileSync(path.join(API_TESTS, name), "utf8")
      expect(source.includes(needs), `${name} no longer names ${needs}`).toBe(true)
    }
  })

  it("keeps the three oracles that ran nowhere in a suite a gate runs", () => {
    const order = fullOrder()
    const blocks = suiteBlocks()
    for (const file of [
      "raw-fetch-discipline.test.ts",
      "no-stripe-imports.test.ts",
      "db-import-enforcement.test.ts",
    ]) {
      const owners = Object.entries(blocks).filter(([, block]) =>
        block.includes(`"src/tests/${file}"`),
      )
      expect(owners.length, file).toBe(1)
      expect(order, `${file} suite in FULL_ORDER`).toContain(owners[0][0])
    }
  })

  it("gives apps/db-gate a suite of its own that a full run reaches", () => {
    const block = suiteBlocks()["db-gate"]
    expect(block).toBeDefined()
    expect(block).toContain('path.join(ROOT, "apps/db-gate")')
    expect(fullOrder()).toContain("db-gate")
  })

  it("finds tests in apps/db-gate, so the suite is not pointing at an empty app", () => {
    const found = readdirSync(path.join(ROOT, "apps/db-gate/src")).filter((f) =>
      f.endsWith(".test.ts"),
    )
    expect(found.length).toBeGreaterThan(0)
  })
})

describe("test-run.ts suite coverage: repo-root scripts/ files", () => {
  // Direct children of scripts/ only --
  // bundled-apps/<app>/scripts/ is a different directory entirely (owned by
  // the bundled-app guard's cwd-aware resolution below).
  const onDisk = readdirSync(path.join(ROOT, "scripts"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts"))
    .map((e) => e.name)

  it("finds the scripts directory and at least one repo-root suite block", () => {
    expect(onDisk.length).toBeGreaterThanOrEqual(10)
    expect(suiteBlocks().root).toBeDefined()
  })

  it("routes every scripts/*.test.ts file into some suite, exemptions aside", () => {
    const blocks = suiteBlocks()
    const unrouted = onDisk.filter((file) => {
      if (KNOWN_UNROUTED_SCRIPTS.includes(file)) return false
      return !Object.values(blocks).some((block) => block.includes(`scripts/${file}"`))
    })
    expect(unrouted).toEqual([])
  })

  it("keeps every scripts/ exemption entry present on disk", () => {
    for (const exempt of KNOWN_UNROUTED_SCRIPTS) {
      expect(onDisk, `stale exemption ${exempt}`).toContain(exempt)
    }
  })

  it("holds the scripts/ exemption list at its introduction size, so it can only shrink", () => {
    expect(KNOWN_UNROUTED_SCRIPTS.length).toBe(15)
  })

  it("names no phantom test file, in ANY suite, at a path that does not exist on disk", () => {
    // The bug this closes: scripts/test-run.ts named scripts/report-skills.test.ts
    // in FULL_ORDER for months. The file was never committed on this branch, so
    // `bun test` silently matched zero files (bun treats a missing path in a
    // multi-path invocation as a filter, not an error) and the suite "passed"
    // having run nothing. This resolves every listed *.test.ts / *.test.tsx path
    // against ITS OWN suite's cwd (ROOT, or path.join(ROOT, "...")) and fails if
    // the resolved path is not a real file, for every suite, not only scripts/.
    const blocks = suiteBlocks()
    const phantoms: string[] = []
    for (const [name, block] of Object.entries(blocks)) {
      // A PENDING suite names a file that is deliberately not on this branch
      // yet: the runner skips it with a reason and exit 0, and the pending
      // block above is what holds that declaration honest. Failing it here as
      // well would make the two guards contradict each other.
      if (name in PENDING_SUITES) continue
      const cwdMatch = block.match(/cwd:\s*(?:ROOT|path\.join\(ROOT,\s*"([^"]+)"\))/)
      const cwdDir = cwdMatch ? (cwdMatch[1] ?? ".") : null
      if (cwdDir === null) continue // suite has no static cwd this lint can resolve
      // An entry written as `path.join(ROOT, "x/y.test.ts")` is ROOT-relative
      // whatever the suite's cwd is (the `demo-seed` suite runs in apps/api and
      // names repo-root scripts that way). Resolve those against ROOT and take
      // them out of the text before reading the cwd-relative bare strings.
      const rootEntries: string[] = []
      const cwdText = block.replace(
        /path\.join\(ROOT,\s*"([^"]+\.tsx?)"\)/g,
        (_whole, entry: string) => {
          rootEntries.push(entry)
          return ""
        },
      )
      const isTest = (p: string) => p.endsWith(".test.ts") || p.endsWith(".test.tsx")
      const cwdEntries = Array.from(cwdText.matchAll(/"([^"\s]+\.tsx?)"/g))
        .map((m) => m[1])
        .filter(isTest)
      for (const entry of rootEntries.filter(isTest)) {
        if (!existsSync(path.join(ROOT, entry))) phantoms.push(`${name}: ${entry}`)
      }
      for (const entry of cwdEntries) {
        if (!existsSync(path.join(ROOT, cwdDir, entry))) phantoms.push(`${name}: ${entry}`)
      }
    }
    expect(phantoms).toEqual([])
  })
})

// P2-7: the cell scenarios boot about three `src/index.ts` processes each. The
// `cell` suite runs them one file at a time; the `e2e` suite and the
// `e2e-parallel` lanes must never pick them up (N lanes would boot 3N servers).
describe("test-run.ts suite coverage: the cell suite owns src/tests/e2e/cell", () => {
  const E2E_DIR = path.join(ROOT, "apps/api/src/tests/e2e")
  const CELL = path.join(E2E_DIR, CELL_DIR)

  const dryRun = async (cmd: string[]): Promise<string> => {
    const proc = Bun.spawn({
      cmd,
      cwd: ROOT,
      env: { ...process.env, LIAISON_TEST_DRY_RUN: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    return out
  }

  it("finds cell scenarios on disk, so the exclusion is not vacuous", () => {
    const cellFiles = readdirSync(CELL).filter((f) => f.endsWith(".scenario.test.ts"))
    expect(cellFiles.length).toBeGreaterThanOrEqual(2)
    expect(isCellPath("cell/process-roles.scenario.test.ts")).toBe(true)
    expect(isCellPath("agent-memory/cell.scenario.test.ts")).toBe(false)
  })

  it("lists no cell file among the e2e files, and every other e2e test file", () => {
    const files = apiE2eTestFiles(E2E_DIR)
    expect(files.some((f) => f.startsWith(`${CELL_DIR}/`))).toBe(false)
    expect(files).toContain("tickets.scenario.test.ts")
    expect(files.some((f) => f.startsWith("agent-memory/"))).toBe(true)
    expect(apiE2eScenarioFiles(E2E_DIR).some((f) => f.startsWith(`${CELL}/`))).toBe(false)
  })

  it("keeps cell files out of the e2e suite's command", async () => {
    const out = await dryRun(["bun", "scripts/test-run.ts", "e2e"])
    const cmd = out.split("\n").find((l) => l.startsWith("cmd: ")) ?? ""
    expect(cmd).toContain("src/tests/e2e/tickets.scenario.test.ts")
    // Not the bare directory, which `bun test` would walk into cell/.
    expect(cmd.split(" ")).not.toContain("src/tests/e2e")
    expect(cmd).not.toContain("src/tests/e2e/cell")
  }, 60_000)

  it("keeps cell files out of the e2e-parallel lanes", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "scripts/test-e2e-parallel.ts", "--list"],
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    const listed = out.split("\n").filter((l) => l.endsWith(".test.ts"))
    expect(listed.some((l) => l.endsWith("/tickets.scenario.test.ts"))).toBe(true)
    expect(listed.filter((l) => l.includes("/e2e/cell/"))).toEqual([])
  }, 60_000)

  it("runs the cell directory and the cell clients' test, after e2e-parallel in a full run", async () => {
    const out = await dryRun(["bun", "scripts/test-run.ts", "cell"])
    const cmd = out.split("\n").find((l) => l.startsWith("cmd: ")) ?? ""
    expect(cmd.split(" ")).toContain("src/tests/e2e/cell")
    expect(cmd).toContain("packages/test-helpers/src/cell-clients.test.ts")
    const order = fullOrder()
    expect(order.indexOf("cell")).toBe(order.indexOf("e2e-parallel") + 1)
  }, 60_000)
})

describe("test-run.ts suite coverage: the api scripts", () => {
  // The test map sends apps/api/scripts/** to api-guards, and api-guards names
  // its files one by one: a test there that it does not name runs nowhere.
  it("lists every apps/api/scripts test in the api-guards suite", () => {
    const dir = path.join(ROOT, "apps/api/scripts")
    const tests = readdirSync(dir).filter((f) => f.endsWith(".test.ts"))
    expect(tests.length).toBeGreaterThan(0)
    const block = suiteBlocks()["api-guards"] ?? ""
    expect(tests.filter((f) => !block.includes(`"scripts/${f}"`))).toEqual([])
  })
})

describe("test-run.ts suite coverage: the seed engine", () => {
  const API = path.join(ROOT, "apps/api")

  function testFilesUnder(dir: string): string[] {
    const found: string[] = []
    for (const entry of readdirSync(path.join(API, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) found.push(...testFilesUnder(rel))
      else if (entry.name.endsWith(".test.ts")) found.push(rel)
    }
    return found.sort()
  }

  /** Test files no suite block names, by path or by a directory above them. */
  function unlisted(files: string[], source: string = SOURCE): string[] {
    const blocks = Object.values(suiteBlocks(source))
    return files.filter((file) => {
      const parts = file.split("/")
      const names = parts.map((_, i) => parts.slice(0, i + 1).join("/"))
      return !blocks.some((block) => names.some((n) => block.includes(`"${n}"`)))
    })
  }

  /**
   * Seed test files no suite lists, and why. A file needs the built app
   * catalog (`app-catalog/`, gitignored, built by scripts/build-app-catalog.ts),
   * which no suite builds, so a suite that listed it would fail in a gate. The
   * `needs` literal must still appear in the file. The list may only shrink.
   */
  const KNOWN_UNROUTED_SEED_TESTS: Record<string, UnroutedReason> = {
    "src/seed/tiers/demo/sales-quote-bundle.integration.test.ts": {
      reason: "installs invoicing from the app catalog, which only a local catalog build provides",
      needs: "build-app-catalog",
    },
  }

  const files = [...testFilesUnder("src/seed"), ...testFilesUnder("test-support/seed")].filter(
    (f) => !(f in KNOWN_UNROUTED_SEED_TESTS),
  )

  it("keeps each unrouted seed test's reason checkable", () => {
    for (const [file, { reason, needs }] of Object.entries(KNOWN_UNROUTED_SEED_TESTS)) {
      expect(reason.length, file).toBeGreaterThan(20)
      expect(readFileSync(path.join(API, file), "utf8").includes(needs), file).toBe(true)
    }
    expect(Object.keys(KNOWN_UNROUTED_SEED_TESTS).length).toBe(1)
  })

  it("finds the seed engine's test files, so an empty read cannot pass", () => {
    expect(files.length).toBeGreaterThan(30)
    expect(files).toContain("src/seed/worlds/worlds.test.ts")
  })

  it("every test file under the seed engine is listed by a suite", () => {
    expect(unlisted(files)).toEqual([])
  })

  it("notices a seed test file whose entry is dropped from its suite", () => {
    const target = "src/seed/seed-determinism.test.ts"
    const mutated = SOURCE.replaceAll(`"${target}"`, `"src/seed/other.test.ts"`)
    // A mutated source reads without the suite extras, so the files they list are left aside.
    const extra = new Set([...readSuiteExtras().values()].flat())
    expect(unlisted(files, mutated).filter((f) => !extra.has(f))).toEqual([target])
  })
})
