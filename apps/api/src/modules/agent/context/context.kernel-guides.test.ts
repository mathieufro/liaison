// SPDX-License-Identifier: FSL-1.1-ALv2
// The kernel's own guides that are not the kernel overview (kernel-config,
// kernel-admin, kernel-notifications) are registered under keys that are not
// app names, so discovering one of their tools never mapped to them: the agent
// configuring an org through kernel__config_* only ever saw the guide's one-line
// summary, which promised the full guide "loads automatically once you discover
// one of its tools". Each guide now names its tools, and the first of them a
// turn loads brings the guide in full, as the agent loop's guide note; the
// system prompt keeps the summary line whatever the thread loaded.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { guideCoversLoaded } from "~/modules/agent/context/app-guide"
import { agentInstructionsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { selectAppGuideToSurface } from "~/modules/mcp/app-guide-surfacing"
import { bootstrapAdminThread } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  assembleContext,
  coveringGuideKeys,
  resetSystemPromptCache,
  systemPartsToText,
  undeliveredGuideBlocks,
} from "./context"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const GUIDES = [
  {
    key: "kernel-config",
    tool: "kernel__config_mail",
    body: "Read before you change: call `kernel__config_export` first",
  },
  { key: "kernel-admin", tool: "kernel__roles_list", body: "Silent-filter contract" },
  {
    key: "kernel-notifications",
    tool: "kernel__notifications_set",
    body: "Map the request to the smallest change",
  },
]

describe("kernel guides follow their tools", () => {
  beforeEach(() => resetSystemPromptCache())

  test("an ordinary turn carries each kernel guide as its summary line only", async () => {
    const { orgId, actor, threadId } = await bootstrapAdminThread()
    const text = systemPartsToText(
      (await assembleContext({ threadId, orgId, actor, discoveredTools: new Set() })).system,
    )
    for (const g of GUIDES) {
      expect(text).toContain(`- **${g.key}**:`)
      expect(text).not.toContain(`### ${g.key}\n`)
      expect(text).not.toContain(g.body)
    }
  })

  test("a discovered tool leaves the system prompt as it was: its guide is the agent loop's note", async () => {
    const { orgId, actor, threadId } = await bootstrapAdminThread()
    const base = systemPartsToText(
      (await assembleContext({ threadId, orgId, actor, discoveredTools: new Set() })).system,
    )
    for (const g of GUIDES) {
      resetSystemPromptCache()
      const assembled = await assembleContext({
        threadId,
        orgId,
        actor,
        discoveredTools: new Set([g.tool]),
      })
      // The system prompt does not depend on what the thread loaded (guide-notes.ts).
      expect(systemPartsToText(assembled.system)).toBe(base)
      expect(assembled.systemGuideParts.has(g.key)).toBe(false)
      // The agent loop's note carries the guide the discovered tool names.
      expect(coveringGuideKeys(orgId, [g.tool])).toEqual([g.key])
    }
  })

  test("every tool a kernel guide names is a registered kernel tool", async () => {
    const { orgId } = await bootstrapAdminThread()
    const kernelTools = [...toolRegistry.entries()]
      .filter(([k]) => k[0] === orgId && k[1] === "kernel")
      .map(([k]) => `kernel__${k[2]}`)
    for (const g of GUIDES) {
      const raw = agentInstructionsRegistry.get([orgId, g.key])
      const covered = typeof raw === "string" ? undefined : raw?.coveredTools
      expect(covered?.length ?? 0).toBeGreaterThan(0)
      for (const pattern of covered ?? []) {
        const matches = kernelTools.filter((n) =>
          guideCoversLoaded({ core: "", coveredTools: [pattern] }, [n]),
        )
        expect({ pattern, matches: matches.length > 0 }).toEqual({ pattern, matches: true })
      }
    }
    // The overview stays the always-on kernel guide: its core is never tool-gated.
    const overview = agentInstructionsRegistry.get([orgId, "kernel"])
    expect(overview).toBeDefined()
    expect(typeof overview === "string" ? undefined : overview?.coveredTools).toBeUndefined()
  })
})

/** A phrase only the kernel guide's section about each tool carries. */
const SECTION_MARKS = {
  kernel__create_role: "A vague 'created with the requested scopes' is INCOMPLETE",
  kernel__describe_user_access: "DETERMINISTIC SCOPE CHECK",
  kernel__data_subject_export: "CRITICAL ANTI-FABRICATION: the deliverable",
  kernel__run_on_my_computer: "SUGGEST it (ask first, do not call)",
} as const
type SectionTool = keyof typeof SECTION_MARKS
const SECTION_TOOLS = Object.keys(SECTION_MARKS) as SectionTool[]

describe("kernel guide sections follow the loaded kernel tools", () => {
  beforeEach(() => resetSystemPromptCache())

  test("main run: a loaded kernel tool's section arrives in the guide note, an unloaded one's never", async () => {
    const { orgId, actor, threadId } = await bootstrapAdminThread()
    for (const tool of SECTION_TOOLS) {
      resetSystemPromptCache()
      const assembled = await assembleContext({
        threadId,
        orgId,
        actor,
        discoveredTools: new Set([tool]),
      })
      const system = systemPartsToText(assembled.system)
      // The overview's core rides every turn; no section about a deferred tool does.
      expect(assembled.systemGuideParts.has("kernel")).toBe(true)
      for (const t of SECTION_TOOLS) expect(system).not.toContain(SECTION_MARKS[t])
      // The agent loop's note, after the system prompt's parts: this tool's section only.
      const note = undeliveredGuideBlocks(orgId, new Set([tool]), assembled.systemGuideParts)
      const text = note.blocks.join("\n")
      expect(text).toContain(SECTION_MARKS[tool])
      for (const t of SECTION_TOOLS) {
        if (t !== tool) expect(text).not.toContain(SECTION_MARKS[t])
      }
      expect(note.parts.some((p) => p.startsWith("kernel#"))).toBe(true)
      expect(note.parts).not.toContain("kernel")
    }
  })

  test("main run: a section about a hot kernel tool rides in the system prompt; one about a deferred tool does not", async () => {
    const { orgId, actor, threadId } = await bootstrapAdminThread()
    const hot = [...toolRegistry.entries()].find(
      ([k, def]) =>
        k[0] === orgId &&
        k[1] === "kernel" &&
        (def as { deferLoading?: boolean }).deferLoading === false &&
        (def as { agentVisible?: boolean }).agentVisible !== false,
    )
    expect(hot).toBeDefined()
    const hotName = `kernel__${hot![0][2]}`
    const key = "kernel-section-probe"
    agentInstructionsRegistry.set([orgId, key], {
      core: "PROBE CORE",
      sections: [
        { tools: [hotName], text: "PROBE HOT SECTION" },
        { tools: ["kernel__create_role"], text: "PROBE DEFERRED SECTION" },
      ],
      coveredTools: [hotName, "kernel__create_role"],
    })
    try {
      const assembled = await assembleContext({
        threadId,
        orgId,
        actor,
        discoveredTools: new Set(),
      })
      const system = systemPartsToText(assembled.system)
      expect(system).toContain("PROBE CORE")
      expect(system).toContain("PROBE HOT SECTION")
      expect(system).not.toContain("PROBE DEFERRED SECTION")
    } finally {
      agentInstructionsRegistry.delete([orgId, key])
      resetSystemPromptCache()
    }
  })

  test("main run: a hot tool the caller lacks the scope for selects no section, for a kernel guide and an app's alike", async () => {
    const { orgId, actor, threadId } = await bootstrapAdminThread()
    const hot = (name: string, scope: string) => ({
      appName: "kernel" as string,
      name,
      description: `Probe ${name}`,
      requiredScopes: [scope],
      deferLoading: false,
      handler: async () => ({ ok: true }),
    })
    toolRegistry.set([orgId, "kernel", "probe_held"], hot("probe_held", "probe:held:read"))
    toolRegistry.set([orgId, "kernel", "probe_unheld"], hot("probe_unheld", "probe:unheld:read"))
    toolRegistry.set([orgId, "probeapp", "held"], {
      ...hot("held", "probe:held:read"),
      appName: "probeapp",
    })
    toolRegistry.set([orgId, "probeapp", "unheld"], {
      ...hot("unheld", "probe:unheld:read"),
      appName: "probeapp",
    })
    agentInstructionsRegistry.set([orgId, "kernel-scope-probe"], {
      core: "PROBE KERNEL CORE",
      sections: [
        { tools: ["kernel__probe_held"], text: "PROBE KERNEL HELD SECTION" },
        { tools: ["kernel__probe_unheld"], text: "PROBE KERNEL UNHELD SECTION" },
      ],
      coveredTools: ["kernel__probe_held", "kernel__probe_unheld"],
    })
    agentInstructionsRegistry.set([orgId, "probeapp"], {
      core: "PROBE APP CORE",
      sections: [
        { tools: ["probeapp__held"], text: "PROBE APP HELD SECTION" },
        { tools: ["probeapp__unheld"], text: "PROBE APP UNHELD SECTION" },
      ],
    })
    try {
      const assembled = await assembleContext({
        threadId,
        orgId,
        actor: { ...actor, scopes: ["probe:held:read"] },
        discoveredTools: new Set(),
      })
      const system = systemPartsToText(assembled.system)
      expect(system).toContain("PROBE KERNEL HELD SECTION")
      expect(system).toContain("PROBE APP HELD SECTION")
      expect(system).not.toContain("PROBE KERNEL UNHELD SECTION")
      expect(system).not.toContain("PROBE APP UNHELD SECTION")
    } finally {
      for (const key of [
        ["kernel", "probe_held"],
        ["kernel", "probe_unheld"],
        ["probeapp", "held"],
        ["probeapp", "unheld"],
      ] as const) {
        toolRegistry.delete([orgId, key[0], key[1]])
      }
      agentInstructionsRegistry.delete([orgId, "kernel-scope-probe"])
      agentInstructionsRegistry.delete([orgId, "probeapp"])
      resetSystemPromptCache()
    }
  })

  test("MCP: a kernel tool's first result carries its section once, never another tool's", async () => {
    const { orgId } = await bootstrapAdminThread()
    const surfaced = new Set<string>()
    for (const tool of SECTION_TOOLS) {
      const canonical = tool.replace("__", ":")
      const first = selectAppGuideToSurface(orgId, canonical, surfaced)
      expect(first?.text).toContain(SECTION_MARKS[tool])
      for (const t of SECTION_TOOLS) {
        if (t !== tool) expect(first?.text ?? "").not.toContain(SECTION_MARKS[t])
      }
      for (const k of first?.keys ?? []) surfaced.add(k)
      // Once delivered, the next call of the same tool carries nothing more.
      expect(selectAppGuideToSurface(orgId, canonical, surfaced)).toBeNull()
    }
  })
})
