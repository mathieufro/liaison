// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The card-payments stand-in's blast radius, asserted from the source tree.
//
//   1. `installDemoPaymentsConnection` is reachable only from the demo seeders.
//      No route, no sandbox bridge method, no tool wraps it, and it takes no key
//      from its caller: that is what makes it safe for a shipped product to
//      carry a function that writes a connection past the demo-mode refusal.
//   2. The hot path stays cheap: the egress bridge imports `provider.ts` on
//      every deployment, so the stand-in itself is behind a dynamic import and
//      the process gate is asked before anything else.
//   3. The stand-in's fixtures and seeded strings hold no key-shaped string.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { DEMO_PAYMENTS_SENTINEL_KEY, KEY_SHAPED } from "./sentinel"

const SRC = path.resolve(import.meta.dir, "..", "..", "..", "..", "..")
const REPO = path.resolve(SRC, "..", "..", "..")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function callers(symbol: string, roots: string[]): string[] {
  const hits: string[] = []
  for (const root of roots) {
    if (!statSync(root, { throwIfNoEntry: false })) continue
    for (const file of walk(root)) {
      if (/\.test\.tsx?$/.test(file)) continue
      if (new RegExp(`\\b${symbol}\\s*\\(`).test(readFileSync(file, "utf8")))
        hits.push(path.relative(REPO, file))
    }
  }
  return hits.sort()
}

describe("the payments stand-in's boundary", () => {
  it("nothing outside the seeder reaches the demo payments connection installer", () => {
    const hits = callers("installDemoPaymentsConnection", [
      SRC,
      path.join(REPO, "scripts"),
      path.join(REPO, "apps", "web", "src"),
      path.join(REPO, "bundled-apps"),
    ])
    for (const hit of hits) {
      const allowed =
        hit.startsWith("apps/api/src/modules/demo/worlds/saas/payments/") ||
        hit.startsWith("apps/api/src/seed/worlds/saas/") ||
        hit.startsWith("apps/api/src/seed/tiers/demo/")
      expect({ hit, allowed }).toEqual({ hit, allowed: true })
    }
    // No route file, sandbox bridge file or tool file names it at all.
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      if (/\.test\.tsx?$/.test(file)) continue
      const rel = path.relative(REPO, file)
      const surface =
        rel.includes("routes") || rel.includes("/sandbox/bridge/") || rel.includes("/tools/")
      if (surface && readFileSync(file, "utf8").includes("installDemoPaymentsConnection"))
        offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it("the installer takes no key and no account from its caller", () => {
    const src = readFileSync(path.join(import.meta.dir, "connection.ts"), "utf8")
    const signature = src.slice(src.indexOf("export async function installDemoPaymentsConnection"))
    const params = signature.slice(0, signature.indexOf("}): Promise")).toLowerCase()
    expect(params).toContain("orgid")
    expect(params).toContain("createdbyuserid")
    for (const forbidden of ["key", "credential", "token", "secret", "account", "identifier"]) {
      expect({ forbidden, present: params.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      })
    }
  })

  it("the egress bridge reaches the stand-in only past the request gate and the demo marker, through a dynamic import", () => {
    const src = readFileSync(path.join(import.meta.dir, "provider.ts"), "utf8")
    const staticImports = [...src.matchAll(/^\s*import[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1])
    expect(staticImports.sort()).toEqual([
      "./sentinel",
      "~/modules/demo/demo-egress",
      "~/modules/demo/demo-org",
      "~/modules/demo/fixture-credential",
    ])
    expect(src).toContain('await import("./standin")')
    const body = src.slice(src.indexOf("export async function maybeDemoPaymentsResponse"))
    // A call that is neither for the payments host nor carries the sentinel
    // returns before any read of the org.
    const requestGate = body.indexOf("if (!paymentsHost && !fixture) return null")
    expect(requestGate).toBeGreaterThan(-1)
    expect(requestGate).toBeLessThan(body.indexOf("loadDemoOrg("))
    // An org without the demo marker never reaches the stand-in.
    const markerGate = body.indexOf("if (!marker) return")
    expect(markerGate).toBeGreaterThan(body.indexOf("loadDemoOrg("))
    expect(markerGate).toBeLessThan(body.indexOf('await import("./standin")'))
    const egress = readFileSync(
      path.join(SRC, "modules", "apps", "sandbox", "bridge", "egress.ts"),
      "utf8",
    )
    expect(egress).toContain("maybeDemoPaymentsResponse({")
  })

  it("no stand-in source holds a key-shaped string, and the sentinel has no key shape", () => {
    expect(KEY_SHAPED.test(DEMO_PAYMENTS_SENTINEL_KEY)).toBe(false)
    expect(DEMO_PAYMENTS_SENTINEL_KEY).not.toMatch(/^(rk|sk|pk|whsec)_/)
    for (const file of walk(import.meta.dir)) {
      if (/\.test\.tsx?$/.test(file)) continue
      const text = readFileSync(file, "utf8").replace(/KEY_SHAPED = .*$/m, "")
      expect({ file: path.basename(file), keyShaped: KEY_SHAPED.test(text) }).toEqual({
        file: path.basename(file),
        keyShaped: false,
      })
    }
  })
})
