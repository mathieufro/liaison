// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { validateAppManifest } from "~/modules/apps/contract"

// Repo root: apps/api/src/modules/apps → ../../../../.. = liaison/
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

// Every connection that ships an authored setup guide (T6). Each must keep
// validating against the manifest schema and carry a non-empty, well-formed,
// tenant-generic setupGuide.
const GUIDED: Array<{ path: string; connection: string }> = [
  { path: "bundled-apps/gitlab/app.manifest.json", connection: "gitlab" },
  { path: "bundled-apps/github/app.manifest.json", connection: "github" },
  { path: "apps/api/src/apps/mail/app.manifest.json", connection: "gmail" },
  { path: "apps/api/src/apps/mail/app.manifest.json", connection: "imap" },
  { path: "apps/api/src/apps/tickets/app.manifest.json", connection: "gmail" },
  { path: "apps/api/src/apps/tickets/app.manifest.json", connection: "imap" },
  { path: "bundled-apps/google-drive/app.manifest.json", connection: "drive" },
  { path: "bundled-apps/boxtal/app.manifest.json", connection: "boxtal" },
  { path: "bundled-apps/shopify/app.manifest.json", connection: "shop" },
  { path: "bundled-apps/pennylane/app.manifest.json", connection: "pennylane" },
]

function readManifest(path: string): any {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), "utf8"))
}

describe("connection setup guides (T6)", () => {
  for (const { path, connection } of GUIDED) {
    it(`${path} still validates against the manifest schema`, () => {
      const r = validateAppManifest(readManifest(path))
      expect(r.success).toBe(true)
    })

    it(`${path}#${connection} declares a non-empty, well-formed setupGuide`, () => {
      const guide = readManifest(path).connections?.[connection]?.setupGuide
      expect(guide).toBeDefined()
      expect(typeof guide.summary).toBe("string")
      expect(guide.summary.length).toBeGreaterThan(20)
      expect(Array.isArray(guide.steps)).toBe(true)
      expect(guide.steps.length).toBeGreaterThan(0)
      // Structured steps (connection-setup.ts SetupStep): who does it and its text.
      for (const step of guide.steps) {
        expect(["human", "agent"]).toContain(step.who)
        expect(typeof step.text).toBe("string")
        expect(step.text.length).toBeGreaterThan(0)
      }
      expect(guide.docsUrl).toMatch(/^https:\/\//)
    })

    it(`${path}#${connection} guide contains no tenant-specific data`, () => {
      const blob = JSON.stringify(
        readManifest(path).connections[connection].setupGuide,
      ).toLowerCase()
      for (const banned of ["fabrikam", "tessera", "tailspin", "mathieu", "@test.com", "dogfood"]) {
        expect(blob).not.toContain(banned)
      }
    })
  }
})
