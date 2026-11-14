// SPDX-License-Identifier: FSL-1.1-ALv2
//
// tool_search ranks by meaning over the tools the caller can reach, and only
// those: a tool hidden from agents never surfaces, even when its vector is the
// query's own. A stub embedder with fixed vectors stands in for the model.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  setToolEmbedder,
  type TextEmbedder,
  toolMeaningIndex,
} from "~/modules/agent/tools/tool-meaning"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import { toolRegistry } from "~/modules/apps/app-registries"

const ORG = "00000000-0000-0000-0000-000000000b31"
const USER = "00000000-0000-0000-0000-000000000b32"
const SCOPES = ["gadgets:gadgets:read", "gadgets:gadgets:write"]
const DIM = 40

const FILLER = Array.from({ length: 24 }, (_, i) => `chore_${i}`)
const TOOLS: Array<{ name: string; description: string; agentVisible?: boolean }> = [
  ...FILLER.map((name, i) => ({ name, description: `Does unrelated chore number ${i}.` })),
  { name: "deactivate_member", description: "Turn off a member's account." },
  { name: "wipe_everything", description: "Erase every record.", agentVisible: false },
]

// Each tool on its own axis; the query and both "access" tools on axis 0.
const axisOf = (text: string): number => {
  if (text.includes("deactivate member") || text.includes("wipe everything")) return 0
  const m = text.match(/chore (\d+)/)
  return m ? 1 + Number(m[1]) : DIM - 1
}
const unit = (axis: number) => Array.from({ length: DIM }, (_, i) => (i === axis ? 1 : 0))
const embedder: TextEmbedder = {
  id: "stub",
  async embed(texts, kind) {
    return texts.map((t) => (kind === "query" ? unit(0) : unit(axisOf(t))))
  },
}

beforeAll(() => {
  for (const t of TOOLS)
    toolRegistry.set([ORG, "gadgets", t.name], {
      appName: "gadgets",
      name: t.name,
      description: t.description,
      requiredScopes: ["gadgets:gadgets:read"],
      handler: async () => ({ ok: true }),
      deferLoading: true,
      ...(t.agentVisible === false ? { agentVisible: false } : {}),
    } as never)
  setToolEmbedder(embedder)
})

afterAll(() => {
  for (const t of TOOLS) toolRegistry.delete([ORG, "gadgets", t.name])
  setToolEmbedder(undefined)
})

const search = (query: string) =>
  handleToolSearch({ query }, { orgId: ORG, userId: USER, scopes: SCOPES })

describe("tool_search by meaning", () => {
  it("finds a tool by what it does once the tool vectors are ready, and never a hidden one", async () => {
    const query = "Marc left the company, cut his access"
    // The first search queues the reachable tools' vectors and ranks by words.
    const first = await search(query)
    expect(first.matches.map((m) => m.name)).not.toContain("gadgets__deactivate_member")
    // The hidden tool gets a vector too, as if another catalog had held it.
    toolMeaningIndex()?.prepare([
      { appName: "gadgets", toolName: "wipe_everything", description: "Erase every record." },
    ])
    await toolMeaningIndex()?.ready()

    const names = (await search(query)).matches.map((m) => m.name)
    expect(names[0]).toBe("gadgets__deactivate_member")
    expect(names).not.toContain("gadgets__wipe_everything")
  })
})
