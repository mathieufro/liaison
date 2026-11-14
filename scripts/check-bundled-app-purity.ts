#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run check:bundled-app-purity`
//
// Phase 17 G7 — bundled-app boundary guard. Asserts that every TS/TSX file
// under `bundled-apps/*/src/` only imports from the public SDK surface:
//   - `@liaison/app-sdk`
//   - `@liaison/app-ui`         (shared plugin UI kit)
//   - `@liaison/host`           (sandbox-side runtime shim)
//   - `@liaison/host-sdk`       (host-side companion surface)
//   - `@liaison/shared`         (shared types + zod schemas)
//   - relative imports (./… or ../…) staying inside the bundled-app
//   - bare-package imports from npm (no `~/` prefix, no apps/ relative)
//
// Banned (any match → exit code 1):
//   (a) `from "@liaison/api"` or `from "@liaison/web"`
//   (b) relative imports walking up into `apps/` (`../../apps/...`)
//   (c) `~/` prefix paths that resolve to apps/api's tsconfig paths
//       (`~/modules`, `~/db`, `~/infra`, `~/services`, `~/lib`)
//
// Note: `@liaison/kernel` is NOT a real package and was dropped from the
// grep (resolves review M5).
import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, resolve } from "node:path"

const REPO_ROOT = process.env.LIAISON_ROOT
  ? resolve(process.env.LIAISON_ROOT)
  : resolve(new URL("..", import.meta.url).pathname)

const BUNDLED_APPS_ROOT = resolve(REPO_ROOT, "bundled-apps")

const EXTENSIONS = new Set([".ts", ".tsx"])

const FORBIDDEN_PATTERNS: Array<{ rx: RegExp; reason: string }> = [
  { rx: /from\s+["']@liaison\/(api|web)["']/g, reason: "imports @liaison/api or @liaison/web" },
  { rx: /from\s+["']\.\.\/(?:\.\.\/)+apps\//g, reason: "relative import walks into apps/" },
  {
    rx: /from\s+["']~\/(modules|db|infra|services|lib)\b/g,
    reason: "imports from apps/api tsconfig paths (~/modules etc.)",
  },
]

// A bundled-app UI never calls `window.fetch` itself. A relative kernel path
// resolves against the PAGE origin, which under the desktop and mobile shells
// is the shell's own bundle: its SPA fallback answers index.html with a 200,
// and a PDF download saved that web page as the "PDF". Kernel reads go through
// `@liaison/host` (`fetch` for JSON, `fetchBlob` for bytes). A call to an
// ABSOLUTE external URL (a presigned upload) opts out on its own line with
// `purity-allow: absolute-url`.
const RAW_FETCH_RX = /\bwindow\.fetch\s*\(/g
const RAW_FETCH_ALLOW = "purity-allow: absolute-url"
const RAW_FETCH_REASON =
  "raw window.fetch in an app UI (use @liaison/host fetch or fetchBlob; relative paths break under the desktop and mobile shells)"

// `*.testkit.ts` files are test helpers (a mock harness, an in-memory table):
// only tests import them, so they never reach the frozen bundle either.
function isTestFile(file: string): boolean {
  return /\.test(kit)?\.tsx?$/.test(file)
}

function* walk(dir: string): Generator<string> {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist") continue
    const full = join(dir, e.name)
    if (e.isDirectory()) yield* walk(full)
    else if (e.isFile()) yield full
  }
}

export interface PurityIssue {
  path: string
  reason: string
  match: string
}

export function checkBundledAppPurity(rootDir: string = BUNDLED_APPS_ROOT): PurityIssue[] {
  const issues: PurityIssue[] = []
  let exists: boolean
  try {
    exists = statSync(rootDir).isDirectory()
  } catch {
    return issues
  }
  if (!exists) return issues

  for (const file of walk(rootDir)) {
    if (!EXTENSIONS.has(extname(file))) continue
    // Only scan src/ trees — manifests, templates outside src/, scripts
    // (which legitimately import kernel paths in dev validators) are
    // exempt.
    if (!file.includes("/src/")) continue
    // Test files never reach the frozen bundle (it is built from the app's
    // entry points), so the boundary does not bind them: a test may import a
    // kernel helper (the hardcoded-copy scan) or stub `window.fetch`.
    if (isTestFile(file)) continue
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const { rx, reason } of FORBIDDEN_PATTERNS) {
      // Reset lastIndex when re-using a /g regex on a new string
      rx.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = rx.exec(text)) !== null) {
        issues.push({ path: file, reason, match: m[0] })
      }
    }
    for (const line of text.split("\n")) {
      RAW_FETCH_RX.lastIndex = 0
      if (RAW_FETCH_RX.test(line) && !line.includes(RAW_FETCH_ALLOW)) {
        issues.push({ path: file, reason: RAW_FETCH_REASON, match: line.trim() })
      }
    }
  }
  return issues
}

async function main() {
  const issues = checkBundledAppPurity()
  if (issues.length === 0) {
    console.log("✓ check:bundled-app-purity — all bundled-apps respect the SDK boundary")
    return
  }
  for (const i of issues) {
    console.error(`${i.reason}: ${i.path}\n    ${i.match}`)
  }
  process.exit(1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
