#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Build an app's Worker module (the remote V8 isolate executor). Build only:
// nothing is uploaded.
//
//   bun run apps:build-worker-bundle <app> [--app-dir <dir>] [--out <dir>]
//
// <app> is a directory under bundled-apps/ (or --app-dir points at any app
// directory with app.manifest.json + handlers.ts). The version comes from its
// app.manifest.json. Output, under --out (default <repo>/dist-worker, gitignored):
//
//   <out>/<app>/<version>/worker.js       ES module for the Workers loader:
//                                         default export = WorkerEntrypoint with
//                                         run(req, bridge) (worker-entry.ts).
//                                         Imports only `cloudflare:workers`.
//   <out>/<app>/<version>/worker-core.js  the same app + core with no Cloudflare
//                                         import, for a plain JS host (the test
//                                         fake loader): `export function
//                                         run(req, bridge)`, same contract.
//
// Both: `bun build` (run from the repo root) of a generated entry, target "browser", format esm, no
// `node:` import (the build fails if one remains). Prints the sha256 of
// worker.js (hex, over its bytes) and the LIAISON_WORKERS_BUNDLES entry
// `{"<app>@<version>":"<sha256>"}`. The generated entries are written under
// <repo>/dist-worker/.entries at a fixed path per app (the bundle's path
// comments name it, so a fixed path keeps the sha stable) and removed after
// the build. The sha is the one to put in LIAISON_WORKERS_BUNDLES and the R2
// key `<app>/<version>/<sha256>.js` (wire protocol).

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "..")
const CORE = join(REPO_ROOT, "apps/api/src/modules/apps/workers/worker-core.ts")
const ENTRY = join(REPO_ROOT, "apps/api/src/modules/apps/workers/worker-entry.ts")

export interface WorkerBundleBuild {
  app: string
  version: string
  sha256: string
  workerPath: string
  corePath: string
  workerBytes: number
  coreBytes: number
  /** The LIAISON_WORKERS_BUNDLES entry for this build. */
  bundlesEntry: string
}

function readManifest(appDir: string): { name: string; version: string } {
  const path = join(appDir, "app.manifest.json")
  if (!existsSync(path)) throw new Error(`No app.manifest.json at ${path}`)
  const raw = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown }
  if (typeof raw.name !== "string" || typeof raw.version !== "string") {
    throw new Error(`${path}: name and version must be strings`)
  }
  return { name: raw.name, version: raw.version }
}

async function bundle(entry: string, outDir: string, naming: string): Promise<string> {
  const out = join(outDir, naming)
  // The CLI, run from the repo root: the bundle's module path comments are
  // relative to the build's cwd, so a fixed cwd keeps the sha independent of
  // where this script was started from.
  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      entry,
      "--outfile",
      out,
      "--target",
      "browser",
      "--format",
      "esm",
      "--external",
      "cloudflare:workers",
    ],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code !== 0) {
    throw new Error(
      `Worker bundle failed (${naming}): ${(stderr || stdout).trim() || `exit ${code}`}`,
    )
  }
  const text = readFileSync(out, "utf8")
  const nodeImport = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']node:[^"']+["']/.exec(text)
  if (nodeImport) throw new Error(`${naming} still imports a Node builtin: ${nodeImport[0]}`)
  return out
}

export async function buildWorkerBundle(opts: {
  app?: string
  appDir?: string
  outRoot?: string
}): Promise<WorkerBundleBuild> {
  const appDir = resolve(opts.appDir ?? join(REPO_ROOT, "bundled-apps", opts.app ?? ""))
  const handlers = join(appDir, "handlers.ts")
  if (!existsSync(handlers)) throw new Error(`No handlers.ts at ${handlers}`)
  const { name, version } = readManifest(appDir)
  const outDir = join(resolve(opts.outRoot ?? join(REPO_ROOT, "dist-worker")), name, version)
  mkdirSync(outDir, { recursive: true })

  const entriesDir = join(REPO_ROOT, "dist-worker/.entries")
  mkdirSync(entriesDir, { recursive: true })
  const workerEntry = join(entriesDir, `${name}.worker.ts`)
  const coreEntry = join(entriesDir, `${name}.core.ts`)
  writeFileSync(
    workerEntry,
    [
      `import * as handlers from ${JSON.stringify(handlers)}`,
      `import { createWorkerEntrypoint } from ${JSON.stringify(ENTRY)}`,
      `export default createWorkerEntrypoint(handlers as Record<string, unknown>)`,
      "",
    ].join("\n"),
  )
  writeFileSync(
    coreEntry,
    [
      `import * as handlers from ${JSON.stringify(handlers)}`,
      `import { runWithBridge, type WorkerBridge, type WorkerRunRequest } from ${JSON.stringify(CORE)}`,
      "export function run(req: WorkerRunRequest, bridge: WorkerBridge) {",
      "  return runWithBridge(handlers as Record<string, unknown>, req, bridge)",
      "}",
      "",
    ].join("\n"),
  )
  try {
    const workerPath = await bundle(workerEntry, outDir, "worker.js")
    const corePath = await bundle(coreEntry, outDir, "worker-core.js")
    const bytes = readFileSync(workerPath)
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    return {
      app: name,
      version,
      sha256,
      workerPath,
      corePath,
      workerBytes: bytes.length,
      coreBytes: readFileSync(corePath).length,
      bundlesEntry: JSON.stringify({ [`${name}@${version}`]: sha256 }),
    }
  } finally {
    rmSync(workerEntry, { force: true })
    rmSync(coreEntry, { force: true })
    // Leave no empty scaffolding behind (another build may still use it).
    for (const dir of [entriesDir, join(REPO_ROOT, "dist-worker")]) {
      try {
        rmdirSync(dir)
      } catch {
        /* not empty */
      }
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (n: string) => {
    const i = args.indexOf(n)
    if (i === -1) return undefined
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  const appDir = flag("--app-dir")
  const outRoot = flag("--out")
  const app = args[0]
  if (!app && !appDir) {
    console.error("usage: bun run apps:build-worker-bundle <app> [--app-dir <dir>] [--out <dir>]")
    process.exit(2)
  }
  try {
    const r = await buildWorkerBundle({ app, appDir, outRoot })
    console.log(`worker.js       ${r.workerPath} (${r.workerBytes} bytes)`)
    console.log(`worker-core.js  ${r.corePath} (${r.coreBytes} bytes)`)
    console.log(`sha256          ${r.sha256}`)
    console.log(`LIAISON_WORKERS_BUNDLES entry: ${r.bundlesEntry}`)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}
