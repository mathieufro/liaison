// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tools hidden from the agent stay registered. Screens and parked approvals still reach them; an
// agent (including a stored routine that names one) gets a refusal that says which visible tool
// does the job now.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import {
  ALL_DEFERRED_TOOLS_UNLOCKED,
  buildToolSet,
  listDeferredTools,
  listGatewayTools,
} from "~/modules/agent/tools/tool-bridge"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { executeToolCore, hiddenToolRefusal } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import {
  RequesterLostScopeError,
  runApprovedToolHandler,
} from "~/modules/apps/run-approved-handler"
import { orgSetupStamp } from "~/modules/apps/setup-stamp"
import { seedOrgRow } from "~/seed/factories/org/rows"

const ORG = "00000000-0000-0000-0000-000000db0036"
const ROOT = join(import.meta.dir, "../../../../..")

/** Kernel tools the agent no longer sees, with the visible tool that replaces each. */
const HIDDEN_KERNEL: Array<[hidden: string, useInstead: string]> = [
  ["user_memory_get", "memory_view"],
  ["user_memory_set", "memory_create"],
  ["user_memory_delete", "memory_delete"],
]

/** Manifest tools hidden from the agent, with the tool to use instead (`app__tool` is another app's). */
const HIDDEN_MANIFEST: Array<[dir: string, hidden: string, useInstead: string]> = [
  ["bundled-apps/invoicing", "documents_preview_pdf", "documents_download_pdf"],
  ["bundled-apps/boxtal", "prep_set_validated", "prep_set_status"],
  ["apps/api/src/apps/mail", "getSyncStatus", "listAccounts"],
  ["bundled-apps/ads", "counts", "campaigns_list"],
  ["bundled-apps/ads", "pending_approvals_list", "kernel__approvals_list"],
  ["bundled-apps/invoicing", "pending_approvals_list", "kernel__approvals_list"],
  ["bundled-apps/github", "github_list_issues", "github_list"],
  ["bundled-apps/github", "github_list_pull_requests", "github_list"],
  ["bundled-apps/github", "github_list_milestones", "github_list"],
  ["bundled-apps/github", "github_list_labels", "github_list"],
  ["bundled-apps/github", "github_list_releases", "github_list"],
  ["bundled-apps/github", "github_list_tags", "github_list"],
  ["bundled-apps/github", "github_list_tree", "github_list"],
  ["bundled-apps/github", "github_list_commits", "github_list"],
  ["apps/api/src/apps/mail", "getAccount", "listAccounts"],
  ["bundled-apps/pennylane", "home_load", "pnl_summary"],
  ["bundled-apps/shopify", "settings_load", "home_load"],
]

let panelReadRuns = 0

const AGENT = {
  actorType: "agent" as const,
  userId: "00000000-0000-0000-0000-000000db0037",
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
} as never

const PERSON = {
  actorType: "user" as const,
  userId: "00000000-0000-0000-0000-000000db0038",
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

interface ManifestTool {
  agentVisible?: boolean
  useInstead?: string
  handler?: string
}

const manifestTools = (dir: string): Record<string, ManifestTool> =>
  JSON.parse(readFileSync(join(ROOT, dir, "app.manifest.json"), "utf8")).tools

describe("tools hidden from the agent", () => {
  beforeAll(async () => {
    orgSetupStamp.enabled = false
    await seedOrgRow(
      { id: ORG, name: "HiddenToolsOrg", slug: "hidden-tools-org" },
      { onConflict: "skip" },
    )
    await ensureAppsForOrg(ORG)
    const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
    await registerKernelAgentTools(ORG)
    toolRegistry.set([ORG, "screens", "panel_read"], {
      appName: "screens",
      name: "panel_read",
      description: "a read only a screen calls",
      requiredScopes: ["screens:panel:read"],
      agentVisible: false,
      useInstead: "list_panels",
      handler: async () => {
        panelReadRuns += 1
        return { rows: 3 }
      },
    } as never)
    toolRegistry.set([ORG, "screens", "list_panels"], {
      appName: "screens",
      name: "list_panels",
      description: "the visible read",
      requiredScopes: ["screens:panel:read"],
      handler: async () => ({ rows: 3 }),
    } as never)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${ORG})`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    orgSetupStamp.enabled = true
  })

  it("each hidden kernel tool is absent from the agent's catalog and the gateway", () => {
    const loaded = Object.keys(buildToolSet(ORG, AGENT, undefined, ALL_DEFERRED_TOOLS_UNLOCKED))
    const deferred = listDeferredTools(ORG, AGENT).map((t) => `${t.appName}:${t.toolName}`)
    const gateway = listGatewayTools(ORG, AGENT).map((t) => `${t.appName}:${t.toolName}`)
    for (const [hidden] of HIDDEN_KERNEL) {
      expect(toolRegistry.get([ORG, "kernel", hidden])).toBeDefined()
      expect(loaded).not.toContain(`kernel__${hidden}`)
      expect(deferred).not.toContain(`kernel:${hidden}`)
      expect(gateway).not.toContain(`kernel:${hidden}`)
    }
  })

  it("an agent call is refused, and the refusal names the visible tool", async () => {
    for (const [hidden, instead] of HIDDEN_KERNEL) {
      const env = await executeToolCore({
        toolName: `kernel:${hidden}`,
        orgId: ORG,
        actor: AGENT,
        params: {},
        origin: "in-app-agent",
      })
      expect("error" in env).toBe(true)
      if ("error" in env) {
        expect(env.error.code).toBe("forbidden")
        expect(env.error.message).toContain(`kernel__${instead}`)
      }
    }
  })

  it("a stored routine prompt naming a hidden tool gets an answer naming the visible tool to use", async () => {
    const env = await executeToolCore({
      toolName: "screens:panel_read",
      orgId: ORG,
      actor: AGENT,
      params: {},
      origin: "in-app-agent",
    })
    expect("error" in env && env.error.message).toBe(
      "tool screens:panel_read is not callable by an agent. Use screens__list_panels instead.",
    )
  })

  it("a hidden tool without a redirect keeps the plain refusal", () => {
    expect(hiddenToolRefusal("a:b", "a", undefined)).toBe("tool a:b not callable by agent")
    expect(hiddenToolRefusal("a:b", "a", "kernel__approvals_list")).toBe(
      "tool a:b is not callable by an agent. Use kernel__approvals_list instead.",
    )
  })

  it("a screen's human-ui call still runs", async () => {
    const env = await executeToolCore({
      toolName: "screens:panel_read",
      orgId: ORG,
      actor: PERSON,
      params: {},
      origin: "human-ui",
    })
    expect("data" in env && env.data).toEqual({ rows: 3 })
  })

  it("a parked row of a just-hidden tool still executes on Approve", async () => {
    const requester: UserContext = { ...PERSON, scopes: ["screens:panel:read"] }
    const before = panelReadRuns
    const err = await runApprovedToolHandler({
      orgId: ORG,
      requesterContext: requester,
      deciderId: requester.userId,
      toolName: "screens:panel_read",
      payload: {},
      approvalRequestId: crypto.randomUUID(),
      threadId: crypto.randomUUID(),
    }).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(RequesterLostScopeError)
    expect(String((err as Error | undefined)?.message ?? "")).not.toMatch(/not callable/)
    expect(panelReadRuns).toBe(before + 1)
  })

  it("useInstead names a visible tool: of the same app, or another app's by its model name", () => {
    for (const [hidden, instead] of HIDDEN_KERNEL) {
      expect(toolRegistry.get([ORG, "kernel", hidden])?.useInstead).toBe(instead)
      expect(toolRegistry.get([ORG, "kernel", instead])?.agentVisible).not.toBe(false)
    }
    for (const [dir, hidden, instead] of HIDDEN_MANIFEST) {
      const tools = manifestTools(dir)
      expect(tools[hidden]?.agentVisible).toBe(false)
      expect(tools[hidden]?.handler).toBeTruthy()
      expect(tools[hidden]?.useInstead).toBe(instead)
      if (instead.includes("__")) {
        const [app, tool] = instead.split("__")
        expect(app).toBe("kernel")
        expect(toolRegistry.get([ORG, "kernel", tool ?? ""])?.agentVisible).not.toBe(false)
      } else {
        expect(tools[instead]).toBeDefined()
        expect(tools[instead]?.agentVisible).not.toBe(false)
      }
    }
  })
})
