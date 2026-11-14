// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun install && bun run typecheck` must pass in a FRESH CLONE.
//
// `bundled-apps/*` are not workspaces: their dependencies are installed per app
// by the app build script, so a clone that has only run the root install has no
// `bundled-apps/<name>/node_modules`. Two apps/web test files import a bundled
// app's UI source directly, which drags those modules into `@liaison/web`'s
// typecheck, and every bare package they name then has to resolve from the ROOT
// install or the typecheck fails on a clone while passing on a machine that
// happens to have built the app once.
//
// That is exactly how the public export gate failed: the exported tree is a
// fresh clone by construction. This guard fails on the next import added to one
// of those modules that the root does not carry.
import { describe, expect, it } from "bun:test"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const ROOT = path.resolve(import.meta.dir, "..")
const SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]

const SOURCE_RE = /\.[cm]?[jt]sx?$/

/**
 * Module specifiers a source file names: static and dynamic imports, re-exports and type-only
 * imports (they count for a typecheck). TypeScript's own pre-processing scan reads them, so a
 * word in a string ("Invoice from", "the import's progress") is never taken for one. A file that
 * is not a script (a JSON manifest) names none.
 */
function specifiers(file: string, text: string): string[] {
  if (!SOURCE_RE.test(file)) return []
  return ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName)
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function resolveLocal(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec)
  for (const s of SUFFIXES) {
    const candidate = `${base}${s}`
    if (isFile(candidate)) return candidate
  }
  return null
}

/** Files under apps/web/src that import a bundled app's source directly. */
function webEntryImports(): { file: string; target: string }[] {
  const out: { file: string; target: string }[] = []
  const glob = new Bun.Glob("apps/web/src/**/*.{ts,tsx}")
  for (const rel of glob.scanSync({ cwd: ROOT })) {
    const file = path.join(ROOT, rel)
    const text = readFileSync(file, "utf8")
    if (!text.includes("bundled-apps/")) continue
    for (const spec of specifiers(file, text)) {
      if (!spec.includes("bundled-apps/")) continue
      const target = resolveLocal(file, spec)
      if (target) out.push({ file: rel, target })
    }
  }
  return out
}

/** Every bare package named by the bundled-app modules reachable from apps/web. */
function reachableBarePackages(entries: readonly string[]): Map<string, string> {
  const seen = new Set<string>()
  const packages = new Map<string, string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    for (const spec of specifiers(file, readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        const next = resolveLocal(file, spec)
        if (next) queue.push(next)
        continue
      }
      if (spec.startsWith("node:") || spec.startsWith("bun:")) continue
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
      if (name) packages.set(name, path.relative(ROOT, file))
    }
  }
  return packages
}

describe("the root install carries what a fresh clone has to typecheck", () => {
  const entries = webEntryImports()
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ])

  it("finds the apps/web files that reach into a bundled app's source", () => {
    // If this ever drops to zero the rest of the guard is vacuous, so it is
    // asserted rather than assumed.
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((e) => e.target.includes(`${path.sep}bundled-apps${path.sep}`))).toBe(true)
  })

  it("declares every package those modules import, since bundled apps are not workspaces", () => {
    const missing: string[] = []
    for (const [name, from] of reachableBarePackages(entries.map((e) => e.target))) {
      if (!declared.has(name)) missing.push(`${name} (imported by ${from})`)
    }
    expect(missing).toEqual([])
  })
})
