// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Loads and transpiles TypeScript app handler bundles for QuickJS execution.
 * A bundle's transform is cached per path and revalidated against the file:
 * a cheap stat fingerprint (inode, size, mtime, ctime) on every load, and a
 * content hash whenever the fingerprint moved. Reinstalling an app at the same
 * version (same path, new bytes) therefore serves the new code at once, with
 * no process restart.
 *
 * Bundled-app SIDE CHANNEL (dev/test): for first-party apps that live in-repo
 * under `bundled-apps/<name>/`, the handler bundle is built from SOURCE on
 * demand instead of read from the installed `.liaisonapp` tarball — so editing
 * a handler takes effect on the next run with NO freeze + reinstall. Off in
 * production; gated by `LIAISON_BUNDLED_APPS_FROM_SOURCE` (1/0). Only the
 * handler *logic* is hot-swapped — manifest changes (new tools/events/handler
 * names) still require a reinstall, since registration reads the manifest.
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join, resolve, sep } from "node:path"
import { CORE_MODULE_SOURCE, isCoreModulePath } from "~/modules/apps/core/registry"
import { getInstallRoot } from "~/modules/apps/discover-apps"

let repoTranspiler: Bun.Transpiler | null = null
const cache = new Map<string, string>()

/** Installed-bundle cache: one entry per path, revalidated on every load. */
interface FileEntry {
  fingerprint: string
  hash: string
  code: string
}
const fileCache = new Map<string, FileEntry>()

/** The file's identity and change stamp; null while the file does not exist. */
function fileFingerprint(path: string): string | null {
  try {
    const st = statSync(path, { bigint: true })
    return `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

/** Reads of a file that keeps changing under us before we give up caching it. */
const STABLE_READ_ATTEMPTS = 3

// bundle-loader.ts → liaison repo root (apps/api/src/modules/apps/sandbox → up 6).
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")

/** A path inside the repo's source tree and outside the install root. */
function inRepoSource(path: string): boolean {
  const p = resolve(path)
  const inside = (dir: string) => p.startsWith(resolve(dir) + sep)
  return inside(REPO_ROOT) && !inside(getInstallRoot())
}

/**
 * Bun's transform of the repo's own TypeScript (fixtures, in-tree apps), nothing
 * else: Bun runs a macro import while it parses, in this process.
 */
function transpileRepoSource(path: string, source: string): string {
  if (!inRepoSource(path)) {
    throw new BundleLoadError(
      path,
      new Error("only a .js handler bundle loads from outside the repo"),
    )
  }
  repoTranspiler ??= new Bun.Transpiler({ loader: "ts", target: "browser" })
  return repoTranspiler.transformSync(source)
}

function sourceChannelEnabled(): boolean {
  const v = process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE
  if (v === "0" || v === "false") return false
  if (v === "1" || v === "true") return true
  return process.env.NODE_ENV !== "production" // default ON outside production
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git"])
function newestMtimeMs(dir: string): number {
  let newest = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    newest = e.isDirectory()
      ? Math.max(newest, newestMtimeMs(p))
      : Math.max(newest, statSync(p).mtimeMs)
  }
  return newest
}

/**
 * If `bundlePath` (`<root>/<name>/<version>/bundle.js`) belongs to an in-repo
 * bundled app whose `handlers.ts` source exists, return its source-build inputs;
 * else null (→ load the installed bundle as usual). Kernel apps and 3rd-party
 * installs have no `bundled-apps/<name>/handlers.ts`, so they fall through.
 */
function bundledAppSource(
  bundlePath: string,
): { appName: string; appDir: string; entry: string } | null {
  if (basename(bundlePath) !== "bundle.js") return null
  const appName = basename(dirname(dirname(bundlePath)))
  if (!appName) return null
  const appDir = join(REPO_ROOT, "bundled-apps", appName)
  const entry = join(appDir, "handlers.ts")
  return existsSync(entry) ? { appName, appDir, entry } : null
}

/**
 * Message prefixes the sandbox executor and worker put on a failure to LOAD an
 * app's handler bundle (shim, evaluation, missing export). The worker pool
 * rebuilds errors from plain strings across IPC, so the prefix, not a class, is
 * what survives both execution paths.
 */
const BUNDLE_LOAD_ERROR_PREFIXES = [
  "Bundle evaluation error",
  "Context shim error",
  "Bundle load error",
  "Export ",
]

/**
 * True when the sandbox itself failed the call (its worker crashed, was killed past the memory
 * ceiling, the pool is going down or had no worker in time, the runtime ran out of memory): the code
 * never answered, which says nothing about the request. The worker pool's own wording
 * (worker-pool.test.ts pins it against this list).
 */
const SANDBOX_FAULT_PREFIXES = [
  "Sandbox worker ",
  "App execution exceeded the sandbox worker memory ceiling",
  "App execution timed out",
  "Queued sandbox request timed out",
  "Worker pool ",
  "Worker IPC deserialization error",
  "Worker startup timeout",
  "Worker exited during startup",
  "Worker message handling failed",
]

export function isSandboxFault(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (SANDBOX_FAULT_PREFIXES.some((prefix) => err.message.startsWith(prefix))) return true
  return err.message === "out of memory" || err.message.endsWith("InternalError: out of memory")
}

/** Thrown when a bundle file cannot be read or transpiled. */
export class BundleLoadError extends Error {
  constructor(bundlePath: string, cause: unknown) {
    super(`Bundle load error: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    })
    this.name = "BundleLoadError"
    this.bundlePath = bundlePath
  }
  readonly bundlePath: string
}

/**
 * True when `err` is the app bundle failing to load or evaluate (as opposed to
 * a verifier or handler rejecting a request), so callers can answer with a
 * server error and log the real cause instead of treating it as a bad request.
 */
export function isBundleLoadError(err: unknown): boolean {
  if (err instanceof BundleLoadError) return true
  if (!(err instanceof Error)) return false
  if (err.message.startsWith("Export ")) return /not found/.test(err.message)
  return BUNDLE_LOAD_ERROR_PREFIXES.some((p) => err.message.startsWith(p))
}

export async function loadBundle(bundlePath: string): Promise<string> {
  // A core app's server module is imported where it runs (runApp), never transpiled here.
  if (isCoreModulePath(bundlePath)) return CORE_MODULE_SOURCE
  try {
    return await loadBundleUnwrapped(bundlePath)
  } catch (err) {
    throw err instanceof BundleLoadError ? err : new BundleLoadError(bundlePath, err)
  }
}

async function loadBundleUnwrapped(bundlePath: string): Promise<string> {
  // SIDE CHANNEL: build the handler bundle from in-repo source (dev/test).
  if (sourceChannelEnabled()) {
    const src = bundledAppSource(bundlePath)
    if (src) {
      const key = `src:${src.appName}:${newestMtimeMs(src.appDir)}`
      const hit = cache.get(key)
      if (hit) return hit
      const built = await Bun.build({
        entrypoints: [src.entry],
        target: "bun",
        external: ["node:*"],
      })
      if (built.success && built.outputs[0]) {
        const transformed = esmExportsToGlobalThis(await built.outputs[0].text())
        cache.set(key, transformed)
        return transformed
      }
      // Build failed → fall through to the installed bundle rather than break
      // the runtime; the build error surfaces via the normal freeze/install path.
    }
  }

  const cached = fileCache.get(bundlePath)
  let fingerprint = fileFingerprint(bundlePath)
  // Gone for a moment (an uninstall/reinstall replacing the version dir): the
  // code that was there keeps serving until the new file lands.
  if (fingerprint === null) {
    if (cached) return cached.code
    throw new BundleLoadError(bundlePath, new Error("bundle file not found"))
  }
  if (cached && cached.fingerprint === fingerprint) return cached.code

  // A read taken while the file is being written is partial: read until the
  // file's stamp is the same before and after, and cache only such a read.
  let source = ""
  let stable = false
  for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS && !stable; attempt++) {
    source = await Bun.file(bundlePath).text()
    const after = fileFingerprint(bundlePath)
    stable = after === fingerprint
    if (!stable) {
      if (after === null) {
        if (cached) return cached.code
        throw new BundleLoadError(bundlePath, new Error("bundle file removed while reading"))
      }
      fingerprint = after
    }
  }
  const hash = Bun.hash(source).toString(16)
  if (cached && cached.hash === hash) {
    // Touched or copied but byte-identical: keep the transform.
    if (stable) fileCache.set(bundlePath, { ...cached, fingerprint })
    return cached.code
  }

  // Plain JS bundles don't need transpilation, but we DO need to convert
  // the Bun.build ESM `export {...}` block into globalThis assignments so
  // the QuickJS sandbox's script-mode `evalCode` can resolve the named
  // exports as globals (the executor reads them via `ctx.getProp(ctx.global, exportName)`).
  // Only the repo's own TypeScript (fixtures, in-tree apps) is transpiled here:
  // Bun runs a macro import while it parses, in this process. An installed
  // package's bundle is plain JS and is never handed to Bun.
  if (!bundlePath.endsWith(".js") && !inRepoSource(bundlePath)) {
    throw new BundleLoadError(
      bundlePath,
      new Error("only a .js handler bundle loads from outside the repo"),
    )
  }
  const code = esmExportsToGlobalThis(
    bundlePath.endsWith(".js") ? source : transpileRepoSource(bundlePath, source),
  )
  if (stable) fileCache.set(bundlePath, { fingerprint, hash, code })
  return code
}

/**
 * Rewrite the trailing `export { a, b as c, d };` block emitted by Bun.build
 * (target:"bun", format:"esm") into `globalThis.a = a; globalThis.c = c;
 * globalThis.d = d;` assignments. QuickJS evalCode is script-mode and
 * rejects the bare `export` statement; the sandbox executor then can't
 * resolve the named export as a global.
 *
 * Conservative: only matches the canonical Bun output shape (single
 * top-level `export { ... };` block at end of file) — leaves any other
 * `export` forms untouched (those would be a build-pipeline bug).
 */
export function esmExportsToGlobalThis(source: string): string {
  const match = source.match(/\nexport\s*\{([\s\S]*?)\}\s*;?\s*$/)
  if (!match) return source
  const body = source.slice(0, match.index)
  const assignments = match[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      // Handles both `foo` and `foo as bar` — alias is the exported name.
      const parts = entry.split(/\s+as\s+/)
      const local = parts[0]!.trim()
      const exported = (parts[1] ?? parts[0]!).trim()
      return `globalThis.${exported} = ${local};`
    })
    .join("\n")
  // The bundle body runs inside a function scope, NOT at script top level. In script mode
  // every top-level declaration is itself a global, so `globalThis.foo = foo2;` (a
  // bundler-renamed export, e.g. a wrapper re-exported under the name of the function it
  // wraps) would overwrite the original `foo` that other bundle code still calls: the wrapper
  // then called itself until the sandbox stack overflowed. With the body scoped, the export
  // globals are the only globals the bundle defines and its internal references stay lexical.
  return `(function () {\n${body}\n${EXPORTS_MARK}\n${assignments}\n})();\n`
}

/**
 * The line between a scoped bundle's body and its export assignments, so the
 * inverse below never takes a body's own trailing `globalThis.x = y;` for an
 * export.
 */
const EXPORTS_MARK = "// liaison:exports"

/** Clear the bundle cache (for tests). */
export function clearBundleCache(): void {
  cache.clear()
  fileCache.clear()
}

const WRAP_HEAD = "(function () {\n"
const WRAP_TAIL = "\n})();\n"
const EXPORT_LINE = /^globalThis\.([A-Za-z_$][\w$]*) = ([A-Za-z_$][\w$]*);$/

/**
 * The inverse of `esmExportsToGlobalThis`: the bundle body and its exports
 * (exported name -> local name), or null when `source` is not in that shape:
 * no export mark, or a line after it that is not an export assignment.
 */
export function unwrapGlobalThisExports(
  source: string,
): { body: string; exports: Map<string, string> } | null {
  if (!source.startsWith(WRAP_HEAD) || !source.endsWith(WRAP_TAIL)) return null
  const inner = source.slice(WRAP_HEAD.length, source.length - WRAP_TAIL.length)
  const mark = inner.lastIndexOf(`\n${EXPORTS_MARK}\n`)
  if (mark < 0) return null
  const exports = new Map<string, string>()
  for (const line of inner.slice(mark + EXPORTS_MARK.length + 2).split("\n")) {
    const m = EXPORT_LINE.exec(line)
    if (!m) return null
    exports.set(m[1] as string, m[2] as string)
  }
  if (exports.size === 0) return null
  return { body: inner.slice(0, mark), exports }
}
