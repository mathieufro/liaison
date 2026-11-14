// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tools hidden from the agent because another tool does the same job. Each stays registered
// and callable by the screens that use it; only the agent's way to it is gone, so the tool
// that replaces it must stay visible and carry everything the agent needed.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "../../../../..")

interface Manifest {
  tools: Record<
    string,
    {
      agentVisible?: boolean
      handler?: string
      requiredScopes?: string[]
      params?: { properties?: Record<string, unknown>; required?: string[] }
    }
  >
  agentInstructions?: { sections?: Array<{ tools?: string[] }> }
}

const manifest = (path: string): Manifest =>
  JSON.parse(readFileSync(join(ROOT, path, "app.manifest.json"), "utf8"))

const HIDDEN: Array<[path: string, hidden: string, replacement: string]> = [
  ["bundled-apps/invoicing", "documents_preview_pdf", "documents_download_pdf"],
  ["bundled-apps/boxtal", "prep_set_validated", "prep_set_status"],
  ["apps/api/src/apps/mail", "getSyncStatus", "listAccounts"],
  ["bundled-apps/ads", "counts", "campaigns_list"],
  ["apps/api/src/apps/mail", "getAccount", "listAccounts"],
  ["bundled-apps/pennylane", "home_load", "pnl_summary"],
]

describe("duplicates hidden from the agent", () => {
  for (const [path, hidden, replacement] of HIDDEN) {
    const m = manifest(path)
    it(`${hidden} is hidden, still has its handler, and ${replacement} stays visible`, () => {
      expect(m.tools[hidden]?.agentVisible).toBe(false)
      expect(m.tools[hidden]?.handler).toBeTruthy()
      expect(m.tools[replacement]?.agentVisible).not.toBe(false)
      expect(m.tools[replacement]?.requiredScopes).toEqual(m.tools[hidden]?.requiredScopes)
    })
    it(`no guide section points the agent at ${hidden}`, () => {
      const named = (m.agentInstructions?.sections ?? []).flatMap((s) => s.tools ?? [])
      expect(named).not.toContain(hidden)
    })
  }

  it("prep_set_status takes every input the alias took", () => {
    const m = manifest("bundled-apps/boxtal")
    const status = m.tools.prep_set_status?.params
    expect(Object.keys(status?.properties ?? {})).toEqual(
      expect.arrayContaining(["order_key", "document_ref"]),
    )
    expect(status?.required).toEqual(["status"])
  })

  it("social counts stays visible: it is the only exact count of open DMs", () => {
    expect(manifest("bundled-apps/social").tools.counts?.agentVisible).not.toBe(false)
  })
})
