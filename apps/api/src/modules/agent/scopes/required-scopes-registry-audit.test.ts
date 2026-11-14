// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveRequiredScopes } from "~/modules/agent/scopes/required-scopes"
import { toolRegistry } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { createTestOrg } from "~/tests/helpers/org"

// Full-registry fail-closed audit. A tool that resolves to no required scope is
// refused to everyone, so a typo that leaves `scope`/`requiredScopes` unset
// silently kills the tool; per-tool fixtures never see it. This sweeps what an
// org actually registers.
//
// createTestOrg -> bootstrapRegister -> ensureAppsForOrg registers every in-tree
// host app plus the kernel agent tools (the hij-reachability pattern). Bundled
// apps install per org at runtime, so they are registered from source with the
// same descriptor shape app-guides.test.ts uses (LIAISON_BUNDLED_APPS_FROM_SOURCE).

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")
const BUNDLED_ROOT = join(REPO_ROOT, "bundled-apps")

function bundledAppNames(): string[] {
  return readdirSync(BUNDLED_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      try {
        readFileSync(join(BUNDLED_ROOT, name, "app.manifest.json"))
        return true
      } catch {
        return false
      }
    })
    .sort()
}

function bundledDescriptor(name: string): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(BUNDLED_ROOT, name, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  const version = (manifest.version as string) ?? "0.1.0"
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(BUNDLED_ROOT, name, version, "bundle.js"),
  }
}

let orgId: string
const bundled = bundledAppNames()

function orgTools() {
  return [...toolRegistry.entries()].filter(([[org]]) => org === orgId)
}

describe("required scopes registry audit", () => {
  beforeAll(async () => {
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    const org = await createTestOrg()
    orgId = org.id
    await registerApps(bundled.map(bundledDescriptor) as never, orgId)
  })

  it("the sweep covers kernel tools and every bundled app (non-vacuous)", () => {
    const apps = new Set(orgTools().map(([[, app]]) => app))
    expect(bundled.length).toBeGreaterThanOrEqual(5)
    // registerApps drops an invalid descriptor with only a log line, so a
    // missing app here means the audit below never saw its tools. An app that
    // declares no tool (a connector whose tools come later) registers none.
    const withTools = bundled.filter(
      (name) => Object.keys((bundledDescriptor(name).tools as object | undefined) ?? {}).length > 0,
    )
    expect(withTools.length).toBeGreaterThanOrEqual(5)
    expect(withTools.filter((name) => !apps.has(name))).toEqual([])
    expect(apps.has("kernel")).toBe(true)
  })

  it("every non-routine-only registered tool declares at least one required scope after the fail-closed fix", () => {
    const tools = orgTools()
    expect(tools.length).toBeGreaterThan(0)
    const offenders = tools
      .filter(([, def]) => !def.routineOnly)
      .filter(([, def]) => resolveRequiredScopes(def).length === 0)
      .map(([[, app, tool]]) => `${app}:${tool}`)
      .sort()
    // toEqual prints the whole array, so one failing run names every offender.
    expect(offenders).toEqual([])
  })
})
