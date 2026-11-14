// SPDX-License-Identifier: FSL-1.1-ALv2
// test:gate's planner, pinned on a fixed map and fixed suite selections: which
// suites a change runs, narrowed to which files, and what it skips and why.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { TEST_MAP } from "../.claude/test-map"
import {
  BROAD_SUITES,
  colocatedTests,
  GATE_LANES,
  GATE_OUTPUT_FILES,
  gateMatrix,
  laneOrder,
  NOT_HOSTED_SUITES,
  PR_CI_SUITES,
  planGate,
  type SuiteInfo,
  withoutGateOutputs,
} from "./test-gate"

const MAP: Array<{ re: RegExp; suites: string[] }> = [
  { re: /^apps\/api\/src\/tests\/e2e\//, suites: ["e2e-parallel"] },
  { re: /^apps\/api\/src\/tests\//, suites: ["integration", "integration-extra"] },
  { re: /^apps\/api\/src\/modules\//, suites: ["unit", "integration"] },
  { re: /^scripts\/lib\//, suites: ["root"] },
]
const mapFor = (f: string) => MAP.find((m) => m.re.test(f))?.suites ?? null

const INFO: Record<string, SuiteInfo> = {
  unit: { cwd: "apps/api", selects: ["apps/api/src/modules", "apps/api/test-support"] },
  integration: { cwd: "apps/api", selects: ["apps/api/src/tests/contacts.test.ts"] },
  "integration-extra": { cwd: "apps/api", selects: ["apps/api/src/tests/mail-accounts.test.ts"] },
  "e2e-parallel": { cwd: "", selects: [] },
  root: { cwd: "", selects: ["scripts/lib/test-lock.test.ts"] },
}

const DIRS: Record<string, string[]> = {
  "apps/api/src/modules/foo": [
    "service.ts",
    "service.test.ts",
    "service.rls.test.ts",
    "service.soak.test.ts",
    "other.ts",
  ],
}
const listDir = (d: string) => DIRS[d] ?? []

const plan = (changed: string[]) => planGate(changed, INFO, listDir, mapFor)

describe("planGate", () => {
  it("runs a changed scenario on its own in e2e-parallel", () => {
    const p = plan(["apps/api/src/tests/e2e/healthz.scenario.test.ts"])
    expect(p.run).toEqual([
      {
        suite: "e2e-parallel",
        files: ["apps/api/src/tests/e2e/healthz.scenario.test.ts"],
        why: expect.any(Array),
      },
    ])
  })

  it("runs an e2e helper change as the whole e2e-parallel suite", () => {
    const p = plan(["apps/api/src/tests/e2e/helpers/run-cron.ts"])
    expect(p.run.map((r) => [r.suite, r.files])).toEqual([["e2e-parallel", []]])
  })

  it("narrows a unit source change to its co-located tests, and runs the rest whole", () => {
    const p = plan(["apps/api/src/modules/foo/service.ts"])
    const unit = p.run.find((r) => r.suite === "unit")
    expect(unit?.files).toEqual([
      "apps/api/src/modules/foo/service.rls.test.ts",
      "apps/api/src/modules/foo/service.test.ts",
    ])
    // The map also routes modules to integration, which cannot narrow a source file.
    expect(p.run.find((r) => r.suite === "integration")?.files).toEqual([])
  })

  it("runs a unit source change with no co-located test as the whole unit suite", () => {
    const p = plan(["apps/api/src/modules/foo/other.ts"])
    expect(p.run.find((r) => r.suite === "unit")?.files).toEqual([])
  })

  it("runs a changed test file only in the suite that lists it, and says why the others skip", () => {
    const p = plan(["apps/api/src/tests/contacts.test.ts"])
    expect(p.run.map((r) => [r.suite, r.files])).toEqual([
      ["integration", ["apps/api/src/tests/contacts.test.ts"]],
    ])
    expect(p.skipped).toEqual([
      { suite: "integration-extra", why: expect.stringContaining("other suites") },
    ])
  })

  it("never hands a bundled app's bun tests to its vitest screen suite", () => {
    const boxtal = ["bundled-boxtal", "bundled-boxtal-ui"]
    const p = planGate(
      ["bundled-apps/boxtal/src/manifest.test.ts", "bundled-apps/boxtal/src/catalog.test.ts"],
      {
        "bundled-boxtal": { cwd: "bundled-apps/boxtal", selects: [] },
        "bundled-boxtal-ui": { cwd: "bundled-apps/boxtal", selects: [] },
      },
      listDir,
      (f) => (f.startsWith("bundled-apps/boxtal/") ? boxtal : null),
    )
    expect(p.run.map((r) => [r.suite, r.files])).toEqual([
      [
        "bundled-boxtal",
        ["bundled-apps/boxtal/src/catalog.test.ts", "bundled-apps/boxtal/src/manifest.test.ts"],
      ],
    ])
    expect(p.skipped.map((s) => s.suite)).toEqual(["bundled-boxtal-ui"])
  })

  it("ignores docs, and runs the BROAD set for a path the map does not know", () => {
    expect(plan(["docs/testing.md", "README.md"]).run).toEqual([])
    const p = plan(["some/new/thing.ts"])
    expect(p.broad).toEqual(["some/new/thing.ts"])
    expect(p.run.map((r) => r.suite).sort()).toEqual([...BROAD_SUITES].sort())
    for (const r of p.run) expect(r.files).toEqual([])
  })

  it("merges several changes into one plan per suite", () => {
    const p = plan([
      "apps/api/src/modules/foo/service.ts",
      "apps/api/src/modules/foo/service.test.ts",
      "scripts/lib/test-lock.ts",
    ])
    expect(p.run.map((r) => r.suite)).toEqual(["integration", "root", "unit"])
    expect(p.run.find((r) => r.suite === "unit")?.files).toEqual([
      "apps/api/src/modules/foo/service.rls.test.ts",
      "apps/api/src/modules/foo/service.test.ts",
    ])
    // A non-test change in the root suite's area runs the root suite whole.
    expect(p.run.find((r) => r.suite === "root")?.files).toEqual([])
  })
})

describe("colocatedTests", () => {
  it("finds <name>.test.ts and <name>.*.test.ts only, never a soak test", () => {
    expect(colocatedTests("apps/api/src/modules/foo/service.ts", listDir)).toEqual([
      "apps/api/src/modules/foo/service.rls.test.ts",
      "apps/api/src/modules/foo/service.test.ts",
    ])
    expect(colocatedTests("apps/api/src/modules/foo/other.ts", listDir)).toEqual([])
  })
})

describe("laneOrder", () => {
  it("runs the re-cloning suites last in the db lane, after the reusing ones", () => {
    const run = [
      "e2e-parallel",
      "playwright",
      "unit",
      "root",
      "integration",
      "web-unit",
      "security",
    ].map((suite) => ({ suite }))
    const { dbLane, light } = laneOrder(run)
    // e2e-parallel and playwright rename the namespace database aside while
    // they prepare; the light pool (root, web-unit) must be done by then.
    expect(dbLane.map((r) => r.suite)).toEqual([
      "unit",
      "integration",
      "security",
      "e2e-parallel",
      "playwright",
    ])
    expect(light.map((r) => r.suite)).toEqual(["root", "web-unit"])
  })
})

describe("gateMatrix", () => {
  it("shards each heavy lane the plan names, and only those", () => {
    const plan = planGate(
      ["apps/api/src/modules/foo/other.ts", "scripts/lib/x.ts"],
      INFO,
      listDir,
      mapFor,
    )
    const m = gateMatrix(plan, INFO)
    expect(m.filter((e) => e.suite === "integration").map((e) => `${e.shard}/${e.of}`)).toEqual(
      Array.from(
        { length: GATE_LANES.integration ?? 0 },
        (_, i) => `${i + 1}/${GATE_LANES.integration}`,
      ),
    )
    expect(m.every((e) => e.files.length === 0)).toBe(true)
    expect(new Set(m.map((e) => e.suite))).toEqual(new Set(["integration"]))
  })

  it("hands a narrowed lane its files, cwd-relative, with no more shards than files", () => {
    const plan = planGate(["apps/api/src/tests/contacts.test.ts"], INFO, listDir, mapFor)
    const m = gateMatrix(plan, INFO).filter((e) => e.suite === "integration")
    expect(m).toEqual([
      { suite: "integration", shard: 1, of: 1, files: ["src/tests/contacts.test.ts"] },
    ])
  })
})

describe("the gate workflow's lanes", () => {
  const named = new Set([...TEST_MAP.flatMap((e) => e.suites), ...BROAD_SUITES])

  it("runs every suite the test map names, except the ones per-PR CI runs", () => {
    const missing = [...named].filter(
      (s) => !(s in GATE_LANES) && !PR_CI_SUITES.includes(s) && !(s in NOT_HOSTED_SUITES),
    )
    expect(missing).toEqual([])
  })

  it("leaves no suite both to per-PR CI and to a gate lane", () => {
    expect(PR_CI_SUITES.filter((s) => s in GATE_LANES)).toEqual([])
  })

  it("gives every suite it cannot host a reason, and none of them a lane", () => {
    expect(Object.keys(NOT_HOSTED_SUITES).filter((s) => s in GATE_LANES)).toEqual([])
    expect(Object.values(NOT_HOSTED_SUITES).every((why) => why.length > 20)).toBe(true)
  })

  it("names only suites test-run.ts knows, and shards only the ones it can shard", () => {
    for (const [suite, shards] of Object.entries(GATE_LANES)) {
      const r = Bun.spawnSync({
        cmd: [
          "bun",
          "scripts/test-run.ts",
          suite,
          ...(shards > 1 ? ["--shard", `1/${shards}`] : []),
        ],
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, LIAISON_TEST_DRY_RUN: "1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      expect({ suite, exit: r.exitCode, err: r.stderr.toString().slice(0, 200) }).toEqual({
        suite,
        exit: 0,
        err: "",
      })
    }
  })

  it("derives its lanes from the planner, with no suite list of its own", () => {
    const yml = readFileSync(path.resolve(import.meta.dir, "../.github/workflows/gate.yml"), "utf8")
    expect(yml).toContain("scripts/test-gate.ts --base")
    expect(yml).toContain("--matrix-json")
    expect(yml).not.toMatch(/suite:\s*\[/)
  })

  it("does not count the files its own plan step writes as changed paths", () => {
    const yml = readFileSync(path.resolve(import.meta.dir, "../.github/workflows/gate.yml"), "utf8")
    const plan = yml.slice(yml.indexOf("name: Plan the lanes"), yml.indexOf("\n  lane:"))
    const written = [...new Set(plan.match(/\bgate-[\w.-]+\.(?:txt|json)\b/g) ?? [])]
    expect(written.length).toBeGreaterThan(0)
    for (const f of written) expect(GATE_OUTPUT_FILES).toContain(f)
    const changed = ["apps/api/src/modules/foo/service.ts", ...written, "out/m.json"]
    expect(withoutGateOutputs(changed, path.resolve(import.meta.dir, "../out/m.json"))).toEqual([
      "apps/api/src/modules/foo/service.ts",
    ])
    // Narrow with them in the list: the changed source alone, not the broad set.
    const narrow = planGate(withoutGateOutputs(changed.slice(0, -1)), INFO, listDir, mapFor)
    expect(narrow.broad).toEqual([])
  })
})
