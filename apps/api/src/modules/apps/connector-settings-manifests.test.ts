// SPDX-License-Identifier: FSL-1.1-ALv2
// The in-tree connectors (settings overhaul P2 T10) declare `kind: "connector"`
// and their settings as a declarative page, a card on Settings > Connectors:
// no `views.settings` entry left, every block bound to a tool the app has, and
// the status read never approval-gated.
import { describe, expect, it } from "bun:test"
import apiConnector from "../../../../../bundled-apps/api-connector/app.manifest.json"
import database from "../../../../../bundled-apps/database/app.manifest.json"
import github from "../../../../../bundled-apps/github/app.manifest.json"
import gitlab from "../../../../../bundled-apps/gitlab/app.manifest.json"
import googleDrive from "../../../../../bundled-apps/google-drive/app.manifest.json"
import { validateAppManifest } from "./contract"

interface Manifest {
  name: string
  kind?: string
  views?: { settings?: unknown }
  tools?: Record<string, { gated?: boolean; readOnly?: boolean }>
  settings?: {
    sections: Array<{
      id: string
      scope: string
      adminScope?: string
      blocks: Array<{ block: string; names?: string[]; status?: { tool: string } }>
    }>
  }
}

const CONNECTORS: Array<{ manifest: Manifest; adminScope?: string; status?: string }> = [
  {
    manifest: gitlab as Manifest,
    adminScope: "gitlab:accounts:admin",
    status: "gitlab_list_projects",
  },
  {
    manifest: github as Manifest,
    adminScope: "github:accounts:admin",
    status: "github_list_repos",
  },
  // No accounts scope of its own: the default org-section scope administers it.
  { manifest: database as Manifest, adminScope: undefined, status: "db_probe" },
  {
    manifest: googleDrive as Manifest,
    adminScope: "google-drive:accounts:admin",
    status: "search",
  },
  // Adapter connections: the accounts list plus the adapter editor (custom).
  { manifest: apiConnector as Manifest, adminScope: "api-connector:admin" },
]

/** A section that names its own scope: who may open report access is the apps admin. */
const SECTION_SCOPE: Record<string, string> = { "report-access": "database:access:admin" }

describe.each(CONNECTORS)("connector $manifest.name", ({ manifest, adminScope, status }) => {
  it("validates as a manifest", () => {
    const result = validateAppManifest(manifest)
    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
  })

  it("is a connector with a declarative settings page and no views.settings", () => {
    expect(manifest.kind).toBe("connector")
    expect(manifest.settings?.sections.length ?? 0).toBeGreaterThan(0)
    expect(manifest.views?.settings).toBeUndefined()
  })

  it("its org sections are administered by the app's accounts scope (or the default)", () => {
    for (const s of manifest.settings?.sections ?? []) {
      if (s.scope === "org") expect(s.adminScope).toBe(SECTION_SCOPE[s.id] ?? adminScope)
    }
  })

  it("its status read is a read-only, ungated tool of the app", () => {
    const blocks = (manifest.settings?.sections ?? []).flatMap((s) => s.blocks)
    const tools = blocks.flatMap((b) => (b.status ? [b.status.tool] : []))
    expect(tools).toEqual(status ? [status] : [])
    for (const t of tools) {
      expect(manifest.tools?.[t]).toBeDefined()
      expect(manifest.tools?.[t]?.gated).not.toBe(true)
      expect(manifest.tools?.[t]?.readOnly).toBe(true)
    }
  })
})
