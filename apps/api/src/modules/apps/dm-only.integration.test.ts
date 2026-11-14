// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A DM-only tool (manifest `dmOnly`, first-party apps only): an in-app agent runs it only in its
// DM with the person, placed by `resolveRoomFloor`; in a shared thread or an approval thread it
// is refused before any gate with the "Continue in a DM" wording. A person in the app and an MCP
// client are in no room and pass. The sample app's `items_count_in_dm` declares it.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { threadParticipants, threads } from "~/db/schema/kernel"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { appCrossAppCallsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { DM_ONLY_CODE, executeToolCore, statusForToolError } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { createSession } from "~/modules/auth/auth"
import { handleToolCall } from "~/modules/mcp/tool-call"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { exampleAppManifest } from "../../../test-support/apps/example/manifest-descriptor"

const TOOL = "example:items_count_in_dm"

let orgId: string
let owner: minimal.Session
let colleagueId: string

function actor(): UserContext {
  return { actorType: "user", userId: owner.userId, orgId, scopes: ["*"], dimensionGrants: {} }
}

async function seedThread(type: string, participantIds: string[]): Promise<string> {
  return withPrivilegedDb(orgId, "test-dm-only-seed-thread", async (tx) => {
    const [t] = await tx
      .insert(threads)
      .values({
        orgId,
        handle: `dm-${crypto.randomUUID().slice(0, 8)}`,
        type,
        createdBy: owner.userId,
      })
      .returning({ id: threads.id })
    if (!t) throw new Error("thread not created")
    for (const userId of participantIds) {
      await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId })
    }
    return t.id
  })
}

/** The in-app agent's call in `threadId`, on a turn the person typed. */
function agentCall(threadId: string) {
  return runContextStore.run(
    {
      runId: crypto.randomUUID(),
      parentRunId: null,
      rootRunId: crypto.randomUUID(),
      nestingDepth: 0,
      humanTurn: true,
    } as RunContext,
    () =>
      executeToolCore({
        toolName: TOOL,
        orgId,
        actor: actor(),
        params: {},
        threadId,
        origin: "in-app-agent",
      } as never),
  )
}

type Envelope = { data?: unknown; error?: Record<string, any> }
const codeOf = (e: unknown) => (e as Envelope).error?.code ?? "ran"

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.adminSession(orgId)
  colleagueId = (await minimal.person(orgId)).id
  await ensureAppsForOrg(orgId)
  await registerApps([exampleAppManifest as never], orgId)
  await primeOrgApps(orgId, 0)
})

afterAll(releaseTestLock)

describe("dmOnly", () => {
  it("the sample app's tool carries the key onto its registry entry", () => {
    expect(toolRegistry.get([orgId, "example", "items_count_in_dm"])?.dmOnly).toBe(true)
  })

  it("a DM-only tool refuses in a shared thread and an approval thread with the DM wording, and runs in a DM, from the UI and over MCP", async () => {
    const shared = await agentCall(await seedThread("thread", [owner.userId, colleagueId]))
    const approval = await agentCall(await seedThread("approval", [owner.userId, colleagueId]))
    const dm = await agentCall(await seedThread("agent_chat", [owner.userId]))

    const { accessToken } = await createSession(owner.userId, orgId)
    const ui = await app.request("/api/apps/example/tools/items_count_in_dm", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ params: {} }),
    })
    const mcp = (await handleToolCall(
      { orgId, actor: actor(), connectionId: crypto.randomUUID() } as never,
      "example__items_count_in_dm",
      {},
    )) as { isError?: boolean; structuredContent?: Record<string, unknown> }

    expect({ shared: codeOf(shared), approval: codeOf(approval), dm: codeOf(dm) }).toEqual({
      shared: DM_ONLY_CODE,
      approval: DM_ONLY_CODE,
      dm: "ran",
    })
    for (const refused of [shared, approval] as Envelope[]) {
      expect(refused.error?.message).toContain("example__items_count_in_dm did not run")
      expect(refused.error?.message).toContain("nothing changed")
      expect(refused.error?.body.next).toContain("Continue in a DM")
      expect(refused.error?.retryable).toBe(false)
      expect(refused.error?.status).toBe(409)
    }
    expect(typeof (dm as { data: { count: unknown } }).data.count).toBe("number")
    expect(ui.status).toBe(200)
    expect(typeof ((await ui.json()) as { data: { count?: unknown } }).data.count).toBe("number")
    expect(mcp.isError ?? false).toBe(false)
    expect(typeof mcp.structuredContent?.count).toBe("number")
    expect(statusForToolError(DM_ONLY_CODE)).toBe(409)
  }, 60_000)

  it("a routine's own thread and a thread that does not exist are not a DM", async () => {
    const routine = await agentCall(await seedThread("routine", [owner.userId]))
    const missing = await agentCall(crypto.randomUUID())
    expect([codeOf(routine), codeOf(missing)]).toEqual([DM_ONLY_CODE, DM_ONLY_CODE])
  })

  it("an in-app agent's call with no thread is not a DM", async () => {
    const noThread = await runContextStore.run(
      {
        runId: crypto.randomUUID(),
        parentRunId: null,
        rootRunId: crypto.randomUUID(),
        nestingDepth: 0,
        humanTurn: true,
      } as RunContext,
      () =>
        executeToolCore({
          toolName: TOOL,
          orgId,
          actor: actor(),
          params: {},
          origin: "in-app-agent",
        } as never),
    )
    expect(codeOf(noThread)).toBe(DM_ONLY_CODE)
  })

  it("another app's call to it is refused, even a declared one inside an approved action in a DM", async () => {
    const dm = await seedThread("agent_chat", [owner.userId])
    appCrossAppCallsRegistry.set([orgId, "caller_app"], { targets: [TOOL] })
    try {
      const nested = await runContextStore.run(
        {
          runId: crypto.randomUUID(),
          parentRunId: null,
          rootRunId: crypto.randomUUID(),
          nestingDepth: 0,
          humanTurn: true,
        } as RunContext,
        () =>
          executeToolCore({
            toolName: TOOL,
            orgId,
            actor: actor(),
            params: {},
            threadId: dm,
            origin: "in-app-agent",
            internalCall: {
              callerApp: "caller_app",
              humanAuthorized: true,
              humanAuthorizedVia: "approval",
            },
          } as never),
      )
      expect(codeOf(nested)).toBe(DM_ONLY_CODE)
    } finally {
      appCrossAppCallsRegistry.delete([orgId, "caller_app"])
    }
  })
})
