// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN MCP CLIENT INHERITS THE IN-APP GUIDANCE. Asked to "send a message" to a
// colleague of the same organization, an external client connected over MCP
// staged a mail__compose: its instructions were a separate hand-written text
// that never said Liaison has conversations between teammates, while the
// in-app prompt and the app guides it lacked were the real rules. Now one
// source (prompts/system.md, sections marked by audience) feeds both, and the
// app guides ride on MCP tool results.
import { describe, expect, it } from "bun:test"
import mailManifest from "~/apps/mail/app.manifest.json"
import type { RosterRow } from "~/modules/agent/context/agent-roster"
import { composeTurnSystemText, loadPrompt } from "~/modules/agent/context/context"
import {
  parseGuidanceSections,
  renderGuidance,
  systemGuidanceTemplate,
} from "~/modules/agent/context/shared-guidance"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { agentInstructionsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { MAX_HEADLINE_ENTRIES } from "~/modules/mcp/agent-directory"
import { appGuideSurfacedKey, selectAppGuideToSurface } from "~/modules/mcp/app-guide-surfacing"
import { createMcpServer } from "~/modules/mcp/server-factory"

/** What a client keeps of `instructions` (agent-directory.ts). */
const KEPT_CHARS = 2048

function instructionsFor(agentDirectory: RosterRow[] = []): string {
  const server = createMcpServer({
    userId: crypto.randomUUID(),
    orgId: crypto.randomUUID(),
    scopes: ["kernel:threads:write"] as never,
    dimensionGrants: {},
    connectionId: crypto.randomUUID(),
    agentDirectory,
  })
  return String((server as unknown as { _instructions?: string })._instructions ?? "")
}

// The longest headline an org can produce: more agents than the headline
// lists, each with a long handle and display name.
const LARGE_DIRECTORY: RosterRow[] = Array.from({ length: MAX_HEADLINE_ENTRIES + 8 }, (_, i) => ({
  id: crypto.randomUUID(),
  handle: `@department-agent-${String(i).padStart(2, "0")}`,
  kind: "role",
  displayName: `Department Operations Agent ${i}`,
  systemPrompt: "Handles one department.",
  purpose: null,
}))

describe("shared guidance: one source, two surfaces", () => {
  it("every section of system.md declares its audience", () => {
    const raw = systemGuidanceTemplate()
    const headings = raw.split("\n").filter((l) => l.startsWith("## "))
    const lines = raw.split("\n")
    for (const h of headings) {
      expect(`${h} -> ${lines[lines.indexOf(h) + 1]}`).toMatch(/-> <!-- audience: .+ -->$/)
    }
  })

  it("a section marked for both reaches both, and an in-app section stays in-app", () => {
    const template = [
      "## Shared rule",
      "<!-- audience: in-app mcp -->",
      "Both surfaces follow this.",
      "",
      "## Persona",
      "<!-- audience: in-app -->",
      "Only the in-app agent is this.",
    ].join("\n")
    expect(renderGuidance(template, "in-app")).toContain("Both surfaces follow this.")
    expect(renderGuidance(template, "mcp")).toContain("Both surfaces follow this.")
    expect(renderGuidance(template, "mcp")).not.toContain("Only the in-app agent")
    expect(renderGuidance(template, "in-app")).not.toContain("<!--")
  })

  it("the MCP instructions carry every section of system.md marked for MCP", () => {
    const text = instructionsFor()
    const { sections } = parseGuidanceSections(systemGuidanceTemplate())
    const forMcp = sections.filter((s) => s.audiences.has("mcp") || s.audiences.has("mcp-core"))
    expect(forMcp.length).toBeGreaterThan(0)
    for (const s of forMcp) expect(text).toContain(s.text)
    for (const s of sections.filter((s) => !forMcp.includes(s))) {
      expect(text).not.toContain(`## ${s.heading}\n`)
    }
    expect(text).not.toContain("<!-- audience")
  })

  it("the in-app prompt carries every in-app section, markers removed", async () => {
    const text = composeTurnSystemText(await loadPrompt("system.md", ""), "Acme")
    for (const s of parseGuidanceSections(systemGuidanceTemplate()).sections) {
      expect(text).toContain(s.text.replaceAll("{{orgName}}", "Acme"))
    }
    expect(text).not.toContain("<!-- audience")
  })

  it("keeps the core rules inside the characters a client keeps, even with a large agent directory", () => {
    const core = renderGuidance(systemGuidanceTemplate(), "mcp-core")
    expect(core).toContain("## Teammates")
    for (const directory of [[], LARGE_DIRECTORY]) {
      expect(instructionsFor(directory).slice(0, KEPT_CHARS)).toContain(core)
    }
  })

  it("tells both surfaces to message a teammate in a Liaison conversation, not by email", () => {
    const core = renderGuidance(systemGuidanceTemplate(), "mcp-core")
    for (const name of [
      "kernel__threads_create",
      "kernel__users_search",
      "kernel__threads_reply",
      "`mail__compose` sends a real email",
    ]) {
      expect(core).toContain(name)
    }
    expect(core).toContain("outside the organization")
  })

  it("says the same on the tool descriptions", async () => {
    const orgId = crypto.randomUUID()
    await registerKernelAgentTools(orgId)
    try {
      const create = toolRegistry.get([orgId, "kernel", "threads_create"])
      const reply = toolRegistry.get([orgId, "kernel", "threads_reply"])
      expect(create?.description).toContain("message a teammate directly")
      expect(create?.description).toContain("Never email a teammate with mail__compose")
      expect(reply?.description).toContain("how to message teammates in this organization")
    } finally {
      toolRegistry.deleteByPrefix([orgId])
    }
    const compose = (mailManifest.tools as unknown as Record<string, { description: string }>)
      .compose
    expect(compose?.description).toContain("This sends a REAL EMAIL")
    expect(compose?.description).toContain("kernel__threads_create")
  })
})

describe("app guides over MCP", () => {
  it("delivers an app's core once and each section with its first tool", () => {
    const orgId = crypto.randomUUID()
    agentInstructionsRegistry.set([orgId, "demoapp"], {
      core: "DEMO CORE RULE",
      sections: [
        { tools: ["send"], text: "SEND SECTION" },
        { tools: ["list"], text: "LIST SECTION" },
      ],
    })
    agentInstructionsRegistry.set([orgId, "kernel-demo"], {
      core: "COVERING GUIDE",
      coveredTools: ["demoapp__list"],
    })
    try {
      const surfaced = new Set<string>()
      const first = selectAppGuideToSurface(orgId, "demoapp:send", surfaced)
      expect(first?.text).toContain("DEMO CORE RULE")
      expect(first?.text).toContain("SEND SECTION")
      expect(first?.text).not.toContain("LIST SECTION")
      for (const k of first?.keys ?? []) surfaced.add(k)
      expect(selectAppGuideToSurface(orgId, "demoapp:send", surfaced)).toBeNull()

      const second = selectAppGuideToSurface(orgId, "demoapp:list", surfaced)
      expect(second?.text).toContain("LIST SECTION")
      expect(second?.text).toContain("COVERING GUIDE")
      expect(second?.text).not.toContain("DEMO CORE RULE")
      expect(second?.keys).toContain(appGuideSurfacedKey("kernel-demo"))
    } finally {
      agentInstructionsRegistry.deleteByPrefix([orgId])
    }
  })
})
