// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A bulk action's derived agent tool takes search words as any tool does: a
// bulk entry's `searchKeywords` reach the registered tool, which tool_search
// reads; a grouped agent tool answers to the words of each of its actions.
import { afterAll, describe, expect, it } from "bun:test"
import { toolRegistry } from "~/modules/apps/app-registries"
import { registerBulkAgentTools } from "~/modules/apps/bulk-agent-tools"
import { validateAppManifest } from "~/modules/apps/contract"

const ORG = "00000000-0000-0000-0000-00000000b0c1"
const APP = "bulkwords"

const TOOLS = {
  close: { requiredScopes: [`${APP}:items:close`] },
  update: { requiredScopes: [`${APP}:items:write`] },
}

afterAll(() => {
  for (const name of ["bulkClose", "bulkUpdate"]) toolRegistry.delete([ORG, APP, name])
})

describe("bulk agent tools: search words", () => {
  it("a single action's searchKeywords reach its agent tool", () => {
    registerBulkAgentTools({
      orgId: ORG,
      appName: APP,
      bulk: {
        close: {
          label: "Close items",
          underlyingTool: "close",
          dispatchMode: "perItem",
          perItemParam: "id",
          agentTool: "bulkClose",
          searchKeywords: ["fermer", "masse"],
        },
      },
      tools: TOOLS,
    })
    expect(toolRegistry.get([ORG, APP, "bulkClose"])?.searchKeywords).toEqual(["fermer", "masse"])
  })

  it("a grouped agent tool answers to every action's words, once each", () => {
    registerBulkAgentTools({
      orgId: ORG,
      appName: APP,
      bulk: {
        setStatus: {
          label: "Change status",
          underlyingTool: "update",
          dispatchMode: "perItem",
          perItemParam: "id",
          agentTool: "bulkUpdate",
          searchKeywords: ["statut", "lot"],
        },
        assign: {
          label: "Assign",
          underlyingTool: "update",
          dispatchMode: "perItem",
          perItemParam: "id",
          agentTool: "bulkUpdate",
          searchKeywords: ["assigner", "lot"],
        },
      },
      tools: TOOLS,
    })
    expect(toolRegistry.get([ORG, APP, "bulkUpdate"])?.searchKeywords).toEqual([
      "statut",
      "lot",
      "assigner",
    ])
  })

  it("an action with no words leaves its tool without the field", () => {
    registerBulkAgentTools({
      orgId: ORG,
      appName: APP,
      bulk: {
        close: {
          label: "Close items",
          underlyingTool: "close",
          dispatchMode: "perItem",
          perItemParam: "id",
          agentTool: "bulkClose",
        },
      },
      tools: TOOLS,
    })
    expect(toolRegistry.get([ORG, APP, "bulkClose"])?.searchKeywords).toBeUndefined()
  })

  const manifest = (searchKeywords: unknown) => ({
    name: "x",
    version: "1.0.0",
    tools: { close: { description: "c", requiredScopes: ["x:y:z"], handler: "h" } },
    bulk: {
      close: {
        label: "Close",
        underlyingTool: "close",
        dispatchMode: "perItem",
        perItemParam: "id",
        agentTool: "bulkClose",
        searchKeywords,
      },
    },
  })

  it("the manifest accepts single words on a bulk action", () => {
    expect(validateAppManifest(manifest(["fermer", "clôturer"])).success).toBe(true)
  })

  it("the manifest refuses a bulk keyword of two words, as on a tool", () => {
    expect(validateAppManifest(manifest(["close all"])).success).toBe(false)
  })
})
