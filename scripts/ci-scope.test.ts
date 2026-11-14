// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { bundledApps, classify, docsRelevant, projects, testOutputs, testScope } from "./ci-scope"

const m = (path: string) => ({ status: "M", path })

describe("ci-scope classify", () => {
  it("runs everything outside a pull request", () => {
    const s = classify([], undefined)
    expect(s.full).toBe(true)
    expect(s.docs).toBe(true)
  })

  it.each([
    "package.json",
    "apps/web/package.json",
    "bun.lock",
    "tsconfig.json",
    "packages/shared/tsconfig.json",
    "biome.json",
    ".github/workflows/ci.yml",
    "scripts/ci-scope.ts",
  ])("falls back to a full run when %s changes", (path) => {
    const s = classify([m("apps/web/src/App.tsx"), m(path)], "origin/main")
    expect(s.full).toBe(true)
    expect(s.reason).toContain(path)
  })

  it("scopes a pull request to its changed files", () => {
    const s = classify(
      [
        m("apps/web/src/lib/x.ts"),
        { status: "A", path: "docs/a.md" },
        { status: "D", path: "notes.txt" },
      ],
      "origin/main",
    )
    expect(s.full).toBe(false)
    expect(s.biomeFiles).toEqual(["apps/web/src/lib/x.ts", "docs/a.md"])
    expect(s.typescript).toBe(true)
    expect(s.typescriptAll).toBe(false)
  })

  it("type checks everything when a TypeScript file is deleted", () => {
    const s = classify([{ status: "D", path: "packages/shared/src/csv.ts" }], "origin/main")
    expect(s.typescriptAll).toBe(true)
  })

  it("needs no type check for a docs-only change", () => {
    const s = classify([m("docs/agents/models.md"), m("README.md")], "origin/main")
    expect(s.typescript).toBe(false)
    expect(s.docs).toBe(true)
  })
})

describe("ci-scope testScope", () => {
  const pr = (...paths: string[]) => testScope("pull_request", paths.map(m), "origin/main")

  it("runs every test job on a merge group: it is the full gate", () => {
    const t = testScope("merge_group", [], undefined)
    expect(t).toMatchObject({ unit: true, web: true, gate: true })
    expect(testOutputs(t)).toMatchObject({
      unit: "true",
      unit_of: "3",
      unit_parts: "[1,2,3]",
      web: "shards",
      web_parts: "[1,2]",
    })
  })

  it("runs a pull request's suites in as few jobs as possible", () => {
    const t = pr("packages/shared/src/csv.ts")
    expect(t.gate).toBe(false)
    expect(testOutputs(t)).toMatchObject({ unit_of: "2", unit_parts: "[1,2]", web: "inline" })
    expect(testOutputs(pr("docs/a.md"))).toMatchObject({ unit: "false", web: "none" })
  })

  it("runs no test job on a push to main: the merge group tested that tree", () => {
    expect(testScope("push", [], undefined)).toMatchObject({ unit: false, web: false })
  })

  it("runs only the jobs the test map attributes to the change", () => {
    expect(pr("apps/web/src/ui/Button.tsx")).toMatchObject({ unit: false, web: true })
    expect(pr("apps/api/src/modules/threads/service.ts")).toMatchObject({ unit: true, web: false })
    expect(pr("apps/api/src/tests/e2e/a.scenario.test.ts")).toMatchObject({
      unit: false,
      web: false,
    })
    expect(pr("packages/shared/src/csv.ts")).toMatchObject({ unit: true, web: true })
  })

  it("runs the relation cells for a path a relation link names, and on a merge group", () => {
    const t = pr("apps/api/src/tests/relations/classes.ts")
    expect(t).toMatchObject({ unit: false, web: false, relations: true })
    expect(testOutputs(t)).toMatchObject({ unit: "false", relations: "true", unit_parts: "[1]" })
    expect(pr("apps/api/src/apps/tickets/merge.ts")).toMatchObject({ unit: true, relations: true })
    expect(pr("apps/web/src/ui/Button.tsx")).toMatchObject({ relations: false })
    expect(testScope("merge_group", [], undefined)).toMatchObject({ relations: true })
    expect(testScope("push", [], undefined)).toMatchObject({ relations: false })
  })

  it("runs nothing for a docs-only change", () => {
    expect(pr("docs/agents/models.md", "README.md")).toMatchObject({ unit: false, web: false })
  })

  it.each([
    "some/unmapped/file.ts",
    "package.json",
    "bun.lock",
    "apps/web/tsconfig.json",
    ".github/workflows/ci.yml",
    ".claude/test-map.ts",
  ])("runs everything when %s changes (fail-safe)", (path) => {
    const t = pr("docs/a.md", path)
    expect(t).toMatchObject({ unit: true, web: true })
    expect(t.reason).toContain(path)
  })
})

describe("ci-scope docsRelevant", () => {
  it.each([
    ["docs/agents/models.md", true],
    ["scripts/docs/gen-reference.ts", true],
    [".claude/docs-map.ts", true],
    // Generated reference pages read api sources, exempt modules included.
    ["apps/api/src/modules/admin/routes.ts", true],
    ["bundled-apps/shopify/app.manifest.json", true],
    ["apps/web/src/modules/agent/AgentPanel.tsx", true],
    // Exempt, or outside every docs input.
    ["apps/api/src/modules/admin/routes.test.ts", false],
    ["apps/web/src/ui/Button.tsx", false],
    ["packages/test-helpers/src/x.ts", false],
    ["scripts/lib/deploy-counters.ts", false],
    ["qa/notifications/run.ts", false],
  ])("%s → %p", (file, expected) => {
    expect(docsRelevant(file)).toBe(expected)
  })
})

describe("ci-scope projects", () => {
  it("lists every typechecked workspace package and scripts/", () => {
    const dirs = projects().map((p) => p.dir)
    expect(dirs).toContain("apps/api")
    expect(dirs).toContain("apps/web")
    expect(dirs).toContain("apps/desktop/sidecar")
    expect(dirs).toContain("packages/shared")
    expect(dirs.at(-1)).toBe("scripts")
  })

  it("lists the bundled apps apart: the workspace projects never reach them", () => {
    const apps = bundledApps().map((p) => p.dir)
    expect(apps).toContain("bundled-apps/invoicing")
    expect(apps).toContain("bundled-apps/shopify")
    const workspace = new Set(projects().map((p) => p.dir))
    expect(apps.filter((dir) => workspace.has(dir))).toEqual([])
  })
})
