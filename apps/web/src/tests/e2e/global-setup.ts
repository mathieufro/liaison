// SPDX-License-Identifier: FSL-1.1-ALv2
import { type ChildProcess, execSync, spawn } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { bundledAppTarball } from "./bundled-app-tarball"
import { APP_CATALOG_DIR_ENV, LANE_CATALOG_APPS, stageLaneCatalog } from "./lane-catalog"
import { buildPwWeb, PW_LANE_REGISTRY_ENV, startPwLaneRegistry } from "./pw-lanes"

const thisDir = dirname(new URL(import.meta.url).pathname)
const serverScript = resolve(thisDir, "mock-oidc-server.ts")
const openRouterStubScript = resolve(thisDir, "openrouter-stub-server.ts")
const PORT = 4580

// Ensure each first-party bundled-app `.liaisonapp` is built once per
// Playwright run. The bundles are consumed by the per-test install fixtures
// (`installShopifyApp` — Phase 16 H1; `installInvoicingApp` — Phase 17 I1).
// Skip if already on disk (developer convenience) — CI starts from a clean
// checkout (dist/ is gitignored) so the absence-path runs the builder.
const liaisonRoot = resolve(thisDir, "..", "..", "..", "..", "..")
const buildBundledAppScript = resolve(liaisonRoot, "scripts", "build-bundled-app.sh")

// Tarball filenames derive from each app's manifest `version` (the freeze
// tool names them `<app>-<version>.liaisonapp`) — a hardcoded version here
// made the exists-check permanently stale after every app bump.
// Every bundled app a scenario installs (boxtal and monitoring were missing,
// so a fresh checkout failed those scenarios on "bundle missing").
// The catalog apps every lane installs (lane-catalog.ts) are built here too.
const BUNDLED_APPS: string[] = [
  "shopify",
  "invoicing",
  "ads",
  "boxtal",
  "monitoring",
  "social",
  "stripe",
  ...LANE_CATALOG_APPS,
]

function buildBundledAppsIfMissing() {
  if (!existsSync(buildBundledAppScript)) return
  for (const name of BUNDLED_APPS) {
    const appDir = resolve(liaisonRoot, "bundled-apps", name)
    const bundlePath = bundledAppTarball(liaisonRoot, name)
    if (existsSync(bundlePath) || !existsSync(appDir)) continue
    try {
      execSync(`bash ${buildBundledAppScript} ${name} --skip-sign`, {
        stdio: "inherit",
        cwd: liaisonRoot,
      })
    } catch (err) {
      // Surface the failure but don't kill OIDC startup — the absence of a
      // bundle blocks only that app's install-dependent scenarios.
      console.warn(`[global-setup] ${name} bundle build failed: ${(err as Error).message}`)
    }
  }
}

let oidcProcess: ChildProcess | null = null
let openRouterProcess: ChildProcess | null = null

/**
 * The OpenRouter stub (openrouter-stub-server.ts) on a free port. Its URL goes
 * into this process's env as OPENROUTER_BASE_URL BEFORE any lane exists, so
 * every API server the run boots (worker-env forwards it) calls the stub for
 * the catalogue, key checks and model test calls, never openrouter.ai.
 */
async function startOpenRouterStub(): Promise<void> {
  const child = spawn("bun", ["run", openRouterStubScript], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  openRouterProcess = child
  const url = await new Promise<string>((ok, fail) => {
    const timeout = setTimeout(() => {
      fail(new Error("OpenRouter stub did not start within 10s"))
    }, 10_000)
    child.stdout?.on("data", (data: Buffer) => {
      const match = data.toString().match(/openrouter-stub listening on (\S+)/)
      if (match?.[1]) {
        clearTimeout(timeout)
        ok(match[1])
      }
    })
    child.on("error", (err) => {
      clearTimeout(timeout)
      fail(err)
    })
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout)
        fail(new Error(`OpenRouter stub exited with code ${code}`))
      }
    })
  })
  process.env.OPENROUTER_BASE_URL = url
}

/** Kill any process occupying our port — leftover from a previous crashed run. */
function freePort(port: number) {
  try {
    const pids = execSync(`lsof -ti:${port} 2>/dev/null`, { encoding: "utf-8" }).trim()
    if (pids) {
      for (const pid of pids.split("\n")) {
        try {
          process.kill(Number(pid), "SIGKILL")
        } catch {}
      }
      // Brief wait for OS to release the port
      execSync("sleep 0.5")
    }
  } catch {
    // No process on port — fine
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Build the first-party bundled-app bundles (shopify, invoicing) if missing.
  buildBundledAppsIfMissing()

  // The lanes' app catalog (lane-catalog.ts), read by every API server the run
  // boots: the apps that ship only through the catalog install from it.
  const catalogDir = stageLaneCatalog(liaisonRoot)
  process.env[APP_CATALOG_DIR_ENV] = catalogDir

  // E2E_WEB_PREVIEW=1 with per-worker stacks: serve a real production build.
  // Built once per run, here, because every worker's `vite preview` serves the
  // same `dist/`. Shared lanes always serve a production build (below).
  const shared = process.env.LIAISON_PW_SHARED_STACK !== "0"
  if (shared) process.env.E2E_WEB_PREVIEW = "1"
  if (process.env.E2E_WEB_PREVIEW === "1" && !shared) {
    execSync("bunx vite build", { stdio: "inherit", cwd: resolve(thisDir, "..", "..", "..") })
  }

  // Clean up any leftover OIDC server from previous runs
  freePort(PORT)

  oidcProcess = spawn("bun", ["run", serverScript, String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
  })

  // Wait until the server is listening
  await new Promise<void>((ok, fail) => {
    const timeout = setTimeout(() => {
      fail(new Error("Mock OIDC did not start within 10s"))
    }, 10_000)

    oidcProcess?.stdout?.on("data", (data: Buffer) => {
      if (data.toString().includes("mock-oidc listening")) {
        clearTimeout(timeout)
        ok()
      }
    })

    oidcProcess?.on("error", (err) => {
      clearTimeout(timeout)
      fail(err)
    })

    oidcProcess?.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout)
        fail(new Error(`Mock OIDC exited with code ${code}`))
      }
    })
  })

  // A real-OpenRouter live run (helpers/live-llm.ts REAL_OPENROUTER) keeps
  // openrouter.ai: the stub serves no speech to text.
  if (
    !(process.env.PLAYWRIGHT_LIVE_LLM === "1" && process.env.PLAYWRIGHT_REAL_OPENROUTER === "1")
  ) {
    await startOpenRouterStub()
  }

  // Shared lanes (pw-lanes.ts): the runner process owns one API server
  // (serving this web build) + seeded world per worker slot, created when a
  // worker of that slot first asks. LIAISON_PW_SHARED_STACK=0 lets every
  // worker boot its own instead.
  const removeCatalog = () => rmSync(catalogDir, { recursive: true, force: true })
  if (!shared) return async () => removeCatalog()
  buildPwWeb()
  const logDir = process.env.LOG_DIR ?? resolve(thisDir, "..", "..", "..", "logs")
  const registry = startPwLaneRegistry(logDir)
  process.env[PW_LANE_REGISTRY_ENV] = registry.url
  return async () => {
    await registry.close()
    removeCatalog()
  }
}

export function teardownOidc() {
  if (oidcProcess) {
    oidcProcess.kill("SIGKILL") // SIGKILL — no zombie risk
    oidcProcess = null
  }
  // Also free the port in case the process didn't die cleanly
  freePort(PORT)
  if (openRouterProcess) {
    openRouterProcess.kill("SIGKILL")
    openRouterProcess = null
  }
}
