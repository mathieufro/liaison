// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool that needs a person (manifest `humanTurnOnly`, first-party apps only) runs on a
// person's own turn and is refused from anywhere else, before any gate. The sample app's
// `items_count_on_turn` declares it: registered through the real runtime, called through the
// real core, the MCP gateway and the REST route, with the run frames the routine worker, the
// sub-run worker and a chat turn build.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import type { UserContext } from "~/db/rls"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { appCrossAppCallsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import {
  executeToolCore,
  HUMAN_TURN_ONLY_CODE,
  statusForToolError,
} from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { createSession } from "~/modules/auth/auth"
import { handleToolCall } from "~/modules/mcp/tool-call"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { exampleAppManifest } from "../../../test-support/apps/example/manifest-descriptor"

const TOOL = "example:items_count_on_turn"

let orgId: string
let owner: minimal.Session

function actor(): UserContext {
  return { actorType: "user", userId: owner.userId, orgId, scopes: ["*"], dimensionGrants: {} }
}

const frame = (extra: Partial<RunContext>): RunContext =>
  ({
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    ...extra,
  }) as RunContext

/** The core, as the in-app tool bridge calls it, inside `runFrame` (none: no frame at all). */
function call(origin: "in-app-agent" | "system" | "human-ui", runFrame?: RunContext) {
  const run = () =>
    executeToolCore({ toolName: TOOL, orgId, actor: actor(), params: {}, origin } as never)
  return runFrame ? runContextStore.run(runFrame, run) : run()
}

type Envelope = { data?: unknown; error?: Record<string, any> }
const codeOf = (e: unknown) => (e as Envelope).error?.code ?? "ran"

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.adminSession(orgId)
  await ensureAppsForOrg(orgId)
  await registerApps([exampleAppManifest as never], orgId)
  await primeOrgApps(orgId, 0)
})

afterAll(releaseTestLock)

describe("humanTurnOnly", () => {
  it("the sample app's tool carries the key onto its registry entry", () => {
    expect(toolRegistry.get([orgId, "example", "items_count_on_turn"])?.humanTurnOnly).toBe(true)
  })

  it("a tool that needs a person refuses from a routine tick, a sub-run and a job, and runs from a chat turn and over MCP", async () => {
    const routineTick = await call(
      "in-app-agent",
      frame({ background: true, routineId: crypto.randomUUID() }),
    )
    const subRun = await call("in-app-agent", frame({ background: true }))
    const job = await call("system")
    const chatTurn = await call("in-app-agent", frame({ humanTurn: true }))
    const mcp = (await handleToolCall(
      { orgId, actor: actor(), connectionId: crypto.randomUUID() } as never,
      "example__items_count_on_turn",
      {},
    )) as { isError?: boolean; structuredContent?: Record<string, unknown> }

    expect({
      routineTick: codeOf(routineTick),
      subRun: codeOf(subRun),
      job: codeOf(job),
      chatTurn: codeOf(chatTurn),
    }).toEqual({
      routineTick: HUMAN_TURN_ONLY_CODE,
      subRun: HUMAN_TURN_ONLY_CODE,
      job: HUMAN_TURN_ONLY_CODE,
      chatTurn: "ran",
    })
    expect(typeof (chatTurn as { data: { count: unknown } }).data.count).toBe("number")
    expect(mcp.isError ?? false).toBe(false)
    expect(mcp.structuredContent?.code).toBeUndefined()
    expect(typeof mcp.structuredContent?.count).toBe("number")
  }, 60_000)

  it("another app's call to it is refused, even a declared one inside an approved action on a person's turn", async () => {
    appCrossAppCallsRegistry.set([orgId, "caller_app"], { targets: [TOOL] })
    try {
      const nested = await runContextStore.run(frame({ humanTurn: true }), () =>
        executeToolCore({
          toolName: TOOL,
          orgId,
          actor: actor(),
          params: {},
          origin: "in-app-agent",
          internalCall: {
            callerApp: "caller_app",
            humanAuthorized: true,
            humanAuthorizedVia: "approval",
          },
        } as never),
      )
      expect(codeOf(nested)).toBe(HUMAN_TURN_ONLY_CODE)
    } finally {
      appCrossAppCallsRegistry.delete([orgId, "caller_app"])
    }
  })

  it("an agent's question to another agent is not a person's turn", async () => {
    const asked = await call("in-app-agent", frame({ coordinated: true }))
    expect(codeOf(asked)).toBe(HUMAN_TURN_ONLY_CODE)
  })

  it("a person's own call from the app runs it with no run frame", async () => {
    const { accessToken } = await createSession(owner.userId, orgId)
    const res = await app.request("/api/apps/example/tools/items_count_on_turn", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ params: {} }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { count?: unknown } }
    expect(typeof body.data.count).toBe("number")
    const direct = await call("human-ui")
    expect(codeOf(direct)).toBe("ran")
  }, 30_000)

  it("the refusal says what did not run and what to do, is final and answers 409", async () => {
    const refused = (await call("system")) as Envelope
    const error = refused.error as Record<string, any>
    expect(error.message).toContain("example__items_count_on_turn did not run")
    expect(error.message).toContain("nothing changed")
    expect(error.body.next).toContain("they ask for it themselves")
    expect(error.retryable).toBe(false)
    expect(error.status).toBe(409)
    expect(statusForToolError(HUMAN_TURN_ONLY_CODE)).toBe(409)
  })
})
