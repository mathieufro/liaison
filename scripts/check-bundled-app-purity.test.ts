// SPDX-License-Identifier: FSL-1.1-ALv2
//
// G7 — bundled-app purity guard tests. Asserts the live `bundled-apps/`
// tree is clean (regression test) and that the matcher catches each
// forbidden pattern when fed synthetic source.
import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkBundledAppPurity } from "./check-bundled-app-purity"

describe("checkBundledAppPurity (Phase 17 G7)", () => {
  it("the live bundled-apps tree is clean", () => {
    // Resolves from this script's directory upwards (../bundled-apps) just
    // like main(). Asserts zero issues across the actual repo.
    const issues = checkBundledAppPurity()
    if (issues.length > 0) {
      console.error(issues)
    }
    expect(issues).toEqual([])
  })

  it("flags @liaison/api / @liaison/web imports", () => {
    const root = mkdtempSync(join(tmpdir(), "purity-"))
    try {
      const dir = join(root, "myapp", "src")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "bad.ts"), `import { x } from "@liaison/api"\n`)
      const issues = checkBundledAppPurity(root)
      expect(issues.length).toBe(1)
      expect(issues[0].reason).toContain("@liaison/api")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("flags ../../apps/... relative imports", () => {
    const root = mkdtempSync(join(tmpdir(), "purity-"))
    try {
      const dir = join(root, "myapp", "src")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "bad.ts"), `import x from "../../apps/api/x"\n`)
      const issues = checkBundledAppPurity(root)
      expect(issues.length).toBe(1)
      expect(issues[0].reason).toContain("relative import")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("flags a raw window.fetch in an app UI, honours the absolute-url opt-out, skips tests and testkits", () => {
    const root = mkdtempSync(join(tmpdir(), "purity-"))
    try {
      const dir = join(root, "myapp", "src", "ui")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "bad.ts"),
        `const r = await window.fetch(\`/api/files/\${id}/inline\`)\n` +
          `await window.fetch(presign.uploadUrl, { method: "PUT" }) // purity-allow: absolute-url\n`,
      )
      writeFileSync(join(dir, "bad.test.ts"), `window.fetch("/api/x")\n`)
      writeFileSync(
        join(dir, "mock.testkit.ts"),
        `export * from "../../../apps/api/test-support/x"\nwindow.fetch("/api/y")\n`,
      )
      const issues = checkBundledAppPurity(root)
      expect(issues.length).toBe(1)
      expect(issues[0].reason).toContain("raw window.fetch")
      expect(issues[0].match).toContain("/api/files/")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("flags ~/modules and friends", () => {
    const root = mkdtempSync(join(tmpdir(), "purity-"))
    try {
      const dir = join(root, "myapp", "src")
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "bad.ts"), `import { db } from "~/db/client"\n`)
      const issues = checkBundledAppPurity(root)
      expect(issues.length).toBe(1)
      expect(issues[0].reason).toContain("apps/api tsconfig paths")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("permits @liaison/app-sdk + @liaison/host + relative imports", () => {
    const root = mkdtempSync(join(tmpdir(), "purity-"))
    try {
      const dir = join(root, "myapp", "src")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "ok.ts"),
        `import { app } from "@liaison/host"\nimport type { Ctx } from "@liaison/app-sdk"\nimport { y } from "./sibling"\n`,
      )
      const issues = checkBundledAppPurity(root)
      expect(issues).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
