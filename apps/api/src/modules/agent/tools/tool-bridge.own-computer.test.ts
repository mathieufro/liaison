// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool that reads the person's own computer (its repositories, the ones its
// signed-in gh and glab reach, its Claude Code sessions) is not offered to a
// person with no computer set up for Liaison. Offered anyway, its description
// ("the repositories the person's own computer can reach with its signed-in
// GitHub CLI") read to a model as a fact: it told a person with no computer
// that their computer was signed in to GitHub.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { z } from "zod"
import type { ActorContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { toolRegistry } from "~/modules/apps/app-registries"
import { forgetOrgApps, rememberOrgAppStates } from "~/modules/apps/org-apps"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet, listDeferredTools } from "./tool-bridge"

const ORG_ID = "11111111-1111-1111-1111-aaaaaaaa0c01"

const PERSON: ActorContext = {
  actorType: "user",
  userId: "22222222-2222-2222-2222-bbbbbbbb0c01",
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

function plant(tool: string, needsOwnComputer: boolean) {
  toolRegistry.set([ORG_ID, "kernel", tool], {
    appName: "kernel",
    name: tool,
    description: `kernel ${tool}`,
    requiredScopes: ["kernel:threads:read"],
    deferLoading: true,
    ...(needsOwnComputer ? { needsOwnComputer: true } : {}),
    params: z.object({}),
    handler: async () => ({ ok: true }),
  } as unknown as Parameters<typeof toolRegistry.set>[1])
}

const frame = (extra: Partial<RunContext>): RunContext =>
  ({
    runId: "r",
    parentRunId: null,
    rootRunId: "r",
    nestingDepth: 0,
    ...extra,
  }) as RunContext

const deferredNames = () => listDeferredTools(ORG_ID, PERSON).map((t) => t.sdkName)

describe("tools that need the person's own computer", () => {
  beforeEach(() => {
    plant("list_my_remote_repos", true)
    plant("threads_search", false)
    rememberOrgAppStates(ORG_ID, [])
  })
  afterEach(() => {
    toolRegistry.deleteByPrefix([ORG_ID])
    forgetOrgApps(ORG_ID)
  })

  it("discriminator: offered in a turn of a person who has a computer", () => {
    runContextStore.run(frame({}), () => {
      expect(deferredNames()).toContain("kernel__list_my_remote_repos")
    })
    const tools = buildToolSet(
      ORG_ID,
      PERSON,
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      frame({}),
    )
    expect(Object.keys(tools)).toContain("kernel__list_my_remote_repos")
  })

  it("not in the catalog tool_search reads in a turn of a person with no computer", () => {
    runContextStore.run(frame({ noOwnComputer: true }), () => {
      expect(deferredNames()).not.toContain("kernel__list_my_remote_repos")
      expect(deferredNames()).toContain("kernel__threads_search")
    })
  })

  it("not in the catalog announced to a person with no computer (explicit, outside a frame)", () => {
    const names = listDeferredTools(ORG_ID, PERSON, "agent", false, { noOwnComputer: true }).map(
      (t) => t.sdkName,
    )
    expect(names).not.toContain("kernel__list_my_remote_repos")
    expect(names).toContain("kernel__threads_search")
  })

  it("not in the tool set of a turn of a person with no computer", () => {
    const tools = buildToolSet(
      ORG_ID,
      PERSON,
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      frame({ noOwnComputer: true }),
    )
    expect(Object.keys(tools)).not.toContain("kernel__list_my_remote_repos")
    expect(Object.keys(tools)).toContain("kernel__threads_search")
  })
})
