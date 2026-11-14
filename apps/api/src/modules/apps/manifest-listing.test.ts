// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Store listing on the runtime `app.manifest.json` (validateAppManifest), and the
// first-party data: every in-tree and bundled app carries a listing, an SPDX
// license and a sourceRepository that points at its own directory in the public repo.
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { APP_LISTING_CATEGORIES } from "@liaison/app-sdk"
import { validateAppManifest } from "~/modules/apps/contract"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const PUBLIC_REPO = "https://github.com/liaison-sh/liaison/tree/main"

const LISTING = {
  category: "Support",
  icon: "ticket",
  summary: "Answer customer requests from one shared queue.",
  sourceRepository: "https://github.com/example/helpdesk",
}

function manifest(extra: Record<string, unknown>) {
  return { name: "listed-app", version: "1.0.0", description: "A listed app", ...extra }
}

describe("runtime manifest listing", () => {
  it("accepts a listing beside an SPDX license", () => {
    const r = validateAppManifest(manifest({ license: "MIT", listing: LISTING }))
    expect(r.error ?? null).toBeNull()
  })

  it("refuses a listing without a license", () => {
    const r = validateAppManifest(manifest({ listing: LISTING }))
    expect(r.success).toBe(false)
    expect(r.error).toContain("a listed app needs a top-level SPDX license")
  })

  it.each(["price", "pricing", "plan"])("refuses listing.%s", (key) => {
    const r = validateAppManifest(manifest({ license: "MIT", listing: { ...LISTING, [key]: 0 } }))
    expect(r.success).toBe(false)
    expect(r.error).toContain(`listing.${key}`)
    expect(r.error).toContain("no price, pricing or plan")
  })

  it("refuses a listing without sourceRepository", () => {
    const { sourceRepository: _r, ...noRepo } = LISTING
    const r = validateAppManifest(manifest({ license: "MIT", listing: noRepo }))
    expect(r.success).toBe(false)
    expect(r.error).toContain("listing.sourceRepository")
  })

  it("still refuses a top-level price key (unknown manifest keys stay refused)", () => {
    const r = validateAppManifest(manifest({ license: "MIT", listing: LISTING, price: 5 }))
    expect(r.success).toBe(false)
  })
})

interface FirstPartyApp {
  dir: string
  manifest: Record<string, unknown>
}

function firstPartyApps(): FirstPartyApp[] {
  const out: FirstPartyApp[] = []
  for (const root of ["apps/api/src/apps", "bundled-apps"]) {
    for (const e of readdirSync(join(REPO_ROOT, root), { withFileTypes: true })) {
      const path = join(REPO_ROOT, root, e.name, "app.manifest.json")
      if (!e.isDirectory() || !existsSync(path)) continue
      out.push({ dir: `${root}/${e.name}`, manifest: JSON.parse(readFileSync(path, "utf8")) })
    }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir))
}

describe("first-party listings", () => {
  const apps = firstPartyApps()

  it("finds all 21 first-party apps (the checks below are not vacuous)", () => {
    expect(apps).toHaveLength(21)
  })

  for (const { dir, manifest: m } of apps) {
    it(`${dir}: has a listing, an SPDX license and its own source path`, () => {
      expect(typeof m.license).toBe("string")
      const listing = m.listing as Record<string, unknown> | undefined
      expect(listing).toBeDefined()
      expect(listing?.sourceRepository).toBe(`${PUBLIC_REPO}/${dir}`)
      expect(APP_LISTING_CATEGORIES as readonly unknown[]).toContain(listing?.category)
      expect(typeof listing?.summary).toBe("string")
      expect(typeof listing?.icon).toBe("string")
      const r = validateAppManifest(m)
      expect(r.error ?? null).toBeNull()
    })
  }

  it("the in-tree apps that lacked a licence now carry FSL-1.1-ALv2", () => {
    const byName = new Map(apps.map((a) => [a.manifest.name, a.manifest.license]))
    for (const name of [
      "calendar",
      "contacts",
      "google-drive",
      "knowledge",
      "mail",
      "mcp-manager",
      "projects",
      "tickets",
    ]) {
      expect(byName.get(name)).toBe("FSL-1.1-ALv2")
    }
  })
})
