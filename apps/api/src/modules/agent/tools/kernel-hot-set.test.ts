// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The HOT kernel tool set is what the provider is shown on EVERY step of every
// turn: its names, descriptions and JSON schemas are re-serialized into each
// request. A deferred tool costs nothing until the model discovers it (its name
// is still announced in the system prompt's deferred catalog, so deferring never
// makes a capability unreachable), which makes the hot set a budget, not a
// default.
//
// This guard pins three things at once: WHICH kernel tools are hot, what the
// whole hot set costs, and the one rule that keeps the cost there — a
// description names the capability, and the behavioural rules ride on the
// tool's own result, error or argument schema, where the model reads them at
// the moment it acts.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { sql } from "~/db"
import { estimateTokens } from "~/modules/agent/context/compaction"
import { isDeferredTool, listGatewayTools } from "~/modules/agent/tools/tool-bridge"
import { approvalActionRequiredClause } from "~/modules/approvals/agent-guidance"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { orgSetupStamp } from "~/modules/apps/setup-stamp"

const ORG_ID = "00000000-0000-0000-0000-000000db0001"

/** Every kernel tool the provider pays for on every step. Adding a name here is
 *  a deliberate budget decision, not a default: an app-shaped capability belongs
 *  behind `deferLoading: true` and tool_search. */
const EXPECTED_HOT = [
  "kernel__agents_ask",
  "kernel__approvals_list",
  // The stable entry for a tool loaded outside the thread's fixed tool list
  // (providers/fixed-tool-list.ts): without it, such a tool is uncallable.
  "kernel__call_tool",
  "kernel__contacts_read",
  "kernel__contacts_search",
  "kernel__files_list",
  "kernel__files_read",
  "kernel__list_locked_capabilities",
  "kernel__memory_create",
  "kernel__memory_insert",
  "kernel__memory_search",
  "kernel__memory_str_replace",
  "kernel__memory_view",
  "kernel__notify_user",
  "kernel__open_app",
  "kernel__request_scope",
  "kernel__skill_read",
  "kernel__skill_search",
  "kernel__suggest_next_steps",
  "kernel__threads_create",
  "kernel__threads_read",
  "kernel__threads_reply",
  "kernel__threads_search",
  "kernel__tool_search",
  "kernel__users_search",
  "kernel__web_fetch",
  "kernel__web_search",
]

/** The whole hot set, measured the way a provider request pays for it. */
const HOT_TOKEN_BUDGET = 6000
const DESCRIPTION_MAX = 240
/** tool_search is the door to every deferred tool, so it buys more room. */
const DESCRIPTION_MAX_BY_TOOL: Record<string, number> = { kernel__tool_search: 480 }

interface HotTool {
  sdkName: string
  description: string
  tokens: number
}

function hotKernelTools(): HotTool[] {
  const out: HotTool[] = []
  for (const [key, def] of toolRegistry.entries()) {
    if (key[0] !== ORG_ID || key[1] !== "kernel") continue
    if (isDeferredTool(key[1], def as { deferLoading?: boolean })) continue
    const sdkName = `${key[1]}__${key[2]}`
    const params = (def as { params?: z.ZodType }).params ?? z.object({})
    out.push({
      sdkName,
      description: def.description,
      tokens: estimateTokens(
        `${sdkName}\n${def.description}\n${JSON.stringify(z.toJSONSchema(params))}`,
      ),
    })
  }
  return out.sort((a, b) => a.sdkName.localeCompare(b.sdkName))
}

describe("kernel hot tool set budget", () => {
  beforeAll(async () => {
    // This fixed org keeps its row across runs while afterAll deletes its roles:
    // registration must re-seed them, so its setup stamp never matches.
    orgSetupStamp.enabled = false
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'HotSetOrg', 'hot-set-org') ON CONFLICT (id) DO NOTHING`
    await ensureAppsForOrg(ORG_ID)
    const { registerKernelAgentTools } = await import("./kernel-tools")
    await registerKernelAgentTools(ORG_ID)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG_ID])
    skillRegistry.deleteByPrefix([ORG_ID])
    agentInstructionsRegistry.deleteByPrefix([ORG_ID])
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${ORG_ID})`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
    orgSetupStamp.enabled = true
  })

  it("the hot kernel set is exactly the pinned list", () => {
    const hot = hotKernelTools().map((t) => t.sdkName)
    // web_search is only advertised when an Exa key resolves for the org, so it
    // is expected only when it is actually registered.
    const expected = toolRegistry.get([ORG_ID, "kernel", "web_search"])
      ? EXPECTED_HOT
      : EXPECTED_HOT.filter((n) => n !== "kernel__web_search")
    expect(hot).toEqual(expected)
  })

  it("the hot set fits the per-step token budget", () => {
    const hot = hotKernelTools()
    const total = hot.reduce((sum, t) => sum + t.tokens, 0)
    const worst = [...hot]
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 5)
      .map((t) => `${t.sdkName}=${t.tokens}`)
      .join(", ")
    expect(
      total,
      `hot kernel tool schemas measured ${total} tokens across ${hot.length} tools (budget ${HOT_TOKEN_BUDGET}); worst offenders: ${worst}`,
    ).toBeLessThanOrEqual(HOT_TOKEN_BUDGET)
  })

  it("suggest_next_steps over MCP is absent from tools/list", () => {
    const actor = {
      actorType: "user" as const,
      userId: "00000000-0000-0000-0000-000000db0002",
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }
    const names = listGatewayTools(ORG_ID, actor).map((t) => `${t.appName}:${t.toolName}`)
    expect(names.length).toBeGreaterThan(0)
    expect(names).toContain("kernel:threads_read")
    expect(names).not.toContain("kernel:suggest_next_steps")
    expect(toolRegistry.get([ORG_ID, "kernel", "suggest_next_steps"])).toBeDefined()
  })

  it("every hot description names the capability instead of carrying the rulebook", () => {
    const offenders = hotKernelTools()
      .filter((t) => t.description.length > (DESCRIPTION_MAX_BY_TOOL[t.sdkName] ?? DESCRIPTION_MAX))
      .map((t) => `${t.sdkName}=${t.description.length} chars`)
    expect(
      offenders,
      `these hot descriptions exceed their limit (${DESCRIPTION_MAX} chars, ${DESCRIPTION_MAX_BY_TOOL.kernel__tool_search} for tool_search): ${offenders.join(", ")}. A rule that no longer fits belongs on the tool's result, its error text, or an argument's .describe().`,
    ).toEqual([])
  })

  it("the tools the standing prompt and the approval guidance name by hand are hot on every turn", () => {
    const hot = hotKernelTools().map((t) => t.sdkName)
    const prompt = readFileSync(join(import.meta.dir, "../prompts/system.md"), "utf8")
    for (const name of ["kernel__users_search", "kernel__threads_create"]) {
      expect(prompt, `system.md no longer names ${name}`).toContain(name)
      expect(hot).toContain(name)
    }
    // Every kernel tool the messaging paragraph names must be hot too, not only the two pinned above.
    const messaging = prompt.split("\n").find((l) => l.includes("use a Liaison conversation")) ?? ""
    const named = [...messaging.matchAll(/kernel__[a-z_]+/g)].map((m) => m[0])
    expect(named.length, "the messaging paragraph names no kernel tool").toBeGreaterThan(0)
    for (const name of named)
      expect(hot, `${name} is named in the standing prompt but not hot`).toContain(name)
    expect(approvalActionRequiredClause(true)).toContain("kernel__approvals_list")
    expect(hot).toContain("kernel__approvals_list")
  })
})
