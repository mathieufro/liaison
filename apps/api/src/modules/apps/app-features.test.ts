// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A switch inside an app, per org: its tools leave what a turn is given, not only
// the catalog. The real agent loop and the real bridge run here; only the model's
// tokens are scripted, and the request it receives is what these tests read.

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { NoSuchToolError, streamText } from "ai"
import { z } from "zod"
import { app } from "~/app"
import { sql } from "~/db"
import * as privileged from "~/db/privileged"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel"
import * as eventBus from "~/infra/events/event-bus"
import { flushEventHandlers } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import * as jobs from "~/infra/jobs/jobs"
import { appsLogger } from "~/lib/logger"
import * as scriptedProvider from "~/modules/agent/providers/scripted-model-provider"
import { AgentServiceTestAccess, runAgentChat } from "~/modules/agent/runtime/agent-service"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { spawnAgent } from "~/modules/agent/subruns/spawn-agent"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { awaitSubRunResult } from "~/modules/agent/subruns/subrun-await"
import { startSubrunWorker } from "~/modules/agent/subruns/subrun-worker"
import { handleCallTool } from "~/modules/agent/tools/call-tool"
import {
  ALL_DEFERRED_TOOLS_UNLOCKED,
  buildToolSet,
  listDeferredTools,
  listGatewayTools,
  listLockedCapabilities,
} from "~/modules/agent/tools/tool-bridge"
import {
  isUnresolvedToolCallError,
  repairHeldToolCall,
} from "~/modules/agent/tools/tool-name-resolve"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import { decideApproval } from "~/modules/approvals/decide"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool, executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import {
  enabledFeaturesFor,
  forgetOrgApps,
  isFeatureOffForTool,
  primeOrgApps,
  reloadOrgApps,
  rememberOrgAppStates,
} from "~/modules/apps/org-apps"
import { OrgFeatureError, setOrgAppFeature } from "~/modules/apps/org-features"
import { registerApps } from "~/modules/apps/runtime"
import {
  __resetCatalogNotifier,
  registerActiveServer,
  unregisterActiveServer,
} from "~/modules/mcp/catalog-notifier"
import {
  cleanupSeededOrg,
  manifestWithBundle,
  seedOrgWithTicketsApp,
} from "~/modules/mcp/test-helpers"
import { handleToolCall } from "~/modules/mcp/tool-call"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"
import { seededApps } from "~/tests/helpers/seeded-app-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const ORIG_PROVIDER = process.env.LIAISON_MODEL_PROVIDER

const FEATURE = "budgets"
const GUIDE_SECTION = "Budget rules: every budget line names its owner."
/** Hot: in the turn's first tool list unless the gate holds. */
const HOT_TOOL = "test__createItem"
/** Deferred: reached through the catalog. */
const DEFERRED_TOOL = "test__listItems"
/** Gated: parks an approval. */
const GATED_TOOL = "test__riskyAction"
const FEATURE_TOOLS = [HOT_TOOL, DEFERRED_TOOL, GATED_TOOL]
/** The same app's tool with no feature key. */
const PLAIN_TOOL = "test__externalSearch"
/** Three times the notifier's 250 ms debounce. */
const LIST_CHANGED_SETTLE_MS = 750

function featuredManifest() {
  const base = manifestWithBundle()
  const withFeature = (name: string, extra: Record<string, unknown> = {}) => ({
    ...base.tools[name],
    feature: FEATURE,
    ...extra,
  })
  return {
    ...base,
    version: "1.0.1",
    features: {
      [FEATURE]: { adminScope: "test:items:write", labelKey: "apps.test.features.budgets" },
    },
    agentInstructions: {
      core: "The test app.",
      sections: [{ tools: ["createItem"], text: GUIDE_SECTION }],
    },
    tools: {
      ...base.tools,
      createItem: withFeature("createItem", { deferLoading: false }),
      listItems: withFeature("listItems"),
      riskyAction: withFeature("riskyAction"),
    },
  }
}

const SEEDED = seededApps()
let orgId: string
let owner: minimal.Session
let agentId: string

function actor(scopes: string[] = ["*"], org = orgId, userId = owner.userId): UserContext {
  return { actorType: "user", userId, orgId: org, scopes, dimensionGrants: {} }
}

async function flip(enabled: boolean, org = orgId, userId: string | null = owner.userId) {
  return setOrgAppFeature({
    orgId: org,
    app: "test",
    feature: FEATURE,
    enabled,
    actor: { userId, scopes: ["*"] },
  })
}

async function setUpOrg(): Promise<{ orgId: string; owner: minimal.Session }> {
  const id = (await createTestOrg()).id
  const session = await minimal.adminSession(id)
  await ensureAppsForOrg(id)
  await registerApps([featuredManifest()], id)
  await primeOrgApps(id, 0)
  return { orgId: id, owner: session }
}

async function freshThread(): Promise<string> {
  const threadId = await minimal.thread(orgId, owner.userId)
  await sql.unsafe(
    insertSql("kernel.thread_participants", {
      thread_id: threadId,
      agent_id: agentId,
      org_id: orgId,
      participant_type: "agent",
    }),
  )
  return threadId
}

/** What one real turn was given: the SDK's tool set, active set, and the provider's request. */
interface TurnSeen {
  tools: string[]
  active: string[]
  providerTools: string[]
  providerPrompt: string
}

/** The loop's `prepareStep` answers with `computeActiveTools()`: read each answer. */
function watchingActiveTools(
  params: Record<string, any>,
  see: (active: string[]) => void,
): Record<string, any> {
  if (Array.isArray(params.activeTools)) see(params.activeTools)
  const prepareStep = params.prepareStep
  if (!prepareStep) return params
  return {
    ...params,
    prepareStep: async (options: unknown) => {
      const step = await prepareStep(options)
      if (Array.isArray(step?.activeTools)) see(step.activeTools)
      return step
    },
  }
}

/**
 * Run one real turn, reading the request at the model. `createScriptedModel` is the
 * token source the loop resolves; only its `doStream` is watched.
 */
async function runTurn(threadId: string, scopes: string[] = ["*"]): Promise<TurnSeen> {
  const seen: TurnSeen = { tools: [], active: [], providerTools: [], providerPrompt: "" }
  const realCreate = scriptedProvider.createScriptedModel
  const modelSpy = spyOn(scriptedProvider, "createScriptedModel").mockImplementation((key) => {
    const model = realCreate(key)
    const doStream = model.doStream.bind(model)
    model.doStream = (options: unknown) => {
      const o = options as { tools?: Array<{ name: string }>; prompt?: unknown }
      seen.providerTools = (o.tools ?? []).map((t) => t.name)
      seen.providerPrompt = JSON.stringify(o.prompt ?? "")
      return doStream(options)
    }
    return model
  })
  AgentServiceTestAccess.setStreamText(((params: Record<string, any>) => {
    seen.tools = Object.keys(params.tools ?? {})
    return streamText(watchingActiveTools(params, (active) => (seen.active = active)) as never)
  }) as never)
  try {
    await scriptedProvider.setScriptedTurn(threadId, [{ text: "done" }])
    const r = await runAgentChat({
      threadId,
      content: "hello",
      actor: actor(scopes),
      orgId,
      actingAgentId: agentId,
    } as never)
    let text = ""
    for await (const part of r.fullStream as AsyncIterable<any>) {
      if (part.type === "text-delta") text += part.text
    }
    await r.finalize({
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: "stop",
      text,
      steps: [],
    } as never)
  } finally {
    modelSpy.mockRestore()
    AgentServiceTestAccess.setStreamText()
    await scriptedProvider.clearScriptedTurns(threadId)
  }
  return seen
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
  process.env.LIAISON_MODEL_PROVIDER = "scripted"
  registerEventSubscribers()
  ;({ orgId, owner } = await setUpOrg())
  const [agent] = await sql.unsafe<{ id: string }[]>(
    insertSql(
      "kernel.agents",
      {
        org_id: orgId,
        kind: "personal",
        handle: `@ff-${crypto.randomUUID().slice(0, 8)}`,
        display_name: "Sam",
        scope_ceiling: '["*"]',
        owner_user_id: owner.userId,
      },
      { returning: "id" },
    ),
  )
  agentId = agent!.id
  await sql.unsafe(
    insertSql(
      "kernel.credit_balances",
      {
        org_id: orgId,
        included_balance: "10.00000000",
        purchased_balance: "0.00000000",
        currency: "EUR",
      },
      { onConflictDoNothing: true },
    ),
  )
  await sql.unsafe(
    insertSql(
      "kernel.model_pricing",
      {
        provider: "anthropic",
        model_id: "claude-haiku-4-5",
        display_name: "Claude Haiku 4.5",
        input_cost_per_m: "1.00000000",
        output_cost_per_m: "5.00000000",
        context_window: 200000,
        auto_eligible: true,
        tier_minimum: "starter",
      },
      { onConflictDoNothing: true },
    ),
  )
}, 120_000)

afterEach(async () => {
  await flip(false)
})

afterAll(async () => {
  await SEEDED.cleanup()
  forgetOrgApps()
  if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
  else delete process.env.LIAISON_ANTHROPIC_API_KEY
  if (ORIG_PROVIDER !== undefined) process.env.LIAISON_MODEL_PROVIDER = ORIG_PROVIDER
  else delete process.env.LIAISON_MODEL_PROVIDER
  await releaseTestLock()
})

describe("the catalog", () => {
  it("absent from listCatalogTools for both audiences and tool_search", async () => {
    const names = (list: Array<{ sdkName: string }>) => list.map((t) => t.sdkName)
    const inApp = names(listDeferredTools(orgId, actor()))
    const gateway = names(listGatewayTools(orgId, actor()))
    expect(inApp).not.toContain(DEFERRED_TOOL)
    for (const tool of FEATURE_TOOLS) expect(gateway).not.toContain(tool)
    expect(gateway).toContain(PLAIN_TOOL)

    const found = await handleToolSearch({ query: "select:test__listItems" }, {
      orgId,
      userId: owner.userId,
      scopes: ["*"],
    } as never)
    expect(JSON.stringify(found)).not.toContain(`"${DEFERRED_TOOL}"`)
  })

  it("row true: appears", async () => {
    await flip(true)
    const gateway = listGatewayTools(orgId, actor()).map((t) => t.sdkName)
    for (const tool of FEATURE_TOOLS) expect(gateway).toContain(tool)
    expect(listDeferredTools(orgId, actor()).map((t) => t.sdkName)).toContain(DEFERRED_TOOL)
  })

  it("no feature key: unaffected", () => {
    expect(isFeatureOffForTool(orgId, { appName: "test" })).toBe(false)
    expect(
      Object.keys(buildToolSet(orgId, actor(), undefined, ALL_DEFERRED_TOOLS_UNLOCKED)),
    ).toContain(PLAIN_TOOL)
  })

  it("listLockedCapabilities omits it", async () => {
    const locked = (scopes: string[]) =>
      listLockedCapabilities(scopes, orgId, owner.userId).map((t) => t.name)
    expect(locked(["kernel:threads:read"])).not.toContain(DEFERRED_TOOL)
    expect(locked(["kernel:threads:read"])).toContain(PLAIN_TOOL)
    await flip(true)
    expect(locked(["kernel:threads:read"])).toContain(DEFERRED_TOOL)
  })
})

describe("what a turn is given", () => {
  it("a real turn's buildToolSet, computeActiveTools, a sub-run's and the captured provider payload hold none of the feature's tools", async () => {
    const turn = await runTurn(await freshThread())
    expect(turn.providerTools.length).toBeGreaterThan(0)
    for (const tool of FEATURE_TOOLS) {
      expect(turn.tools).not.toContain(tool)
      expect(turn.active).not.toContain(tool)
      expect(turn.providerTools).not.toContain(tool)
    }
    expect(turn.tools).toContain(PLAIN_TOOL)

    // A sub-run builds its own set and its own catalog.
    const agentType = `feat-${crypto.randomUUID().slice(0, 6)}`
    const scopes = ["test:items:read", "test:items:write", "test:external:read"]
    const owningApp = SEEDED.track(`feat-${crypto.randomUUID().slice(0, 8)}`)
    await withSystemDb("feature-test-install-app", async (db) => {
      await db.insert(appsInstalled).values({
        name: owningApp,
        version: "1.0.0",
        sourceUrl: `file:///tmp/${owningApp}.liaisonapp`,
        sha256: "0".repeat(64),
        grantedScopes: scopes,
        installedBy: owner.userId,
      })
      await db.insert(appsActiveVersion).values({ name: owningApp, version: "1.0.0" })
    })
    await createSubAgentDefinition({
      orgId,
      appName: owningApp,
      agentType,
      whenToUse: "test",
      scopeCeiling: scopes,
      systemPrompt: "Do the task.",
    })
    let subTools: string[] = []
    let subActive: string[] = []
    AgentServiceTestAccess.setStreamText(((params: Record<string, any>) => {
      subTools = Object.keys(params.tools ?? {})
      subActive = subTools
      return streamText(watchingActiveTools(params, (active) => (subActive = active)) as never)
    }) as never)
    try {
      await startSubrunWorker()
      const handle = await spawnAgent({
        parentRun: {
          id: null,
          threadId: await freshThread(),
          actor: actor(scopes),
          nestingDepth: 0,
        },
        subagentType: agentType,
        description: "feature gate",
        prompt: "go",
      })
      // Whether it produced anything is not the question here: what it was given is.
      await awaitSubRunResult(handle.runId, orgId, { timeoutMs: 30_000 }).catch(() => null)
    } finally {
      AgentServiceTestAccess.setStreamText()
    }
    expect(subTools.length).toBeGreaterThan(0)
    for (const tool of FEATURE_TOOLS) {
      expect(subTools).not.toContain(tool)
      expect(subActive).not.toContain(tool)
    }
    expect(subTools).toContain(PLAIN_TOOL)
  }, 90_000)

  it("with the row true the same turn does hold them, hot in the provider payload", async () => {
    await flip(true)
    const turn = await runTurn(await freshThread())
    expect(turn.tools).toEqual(expect.arrayContaining(FEATURE_TOOLS))
    expect(turn.providerTools).toContain(HOT_TOOL)
  }, 60_000)

  it("no app guide section naming only that feature's tools reaches the provider payload", async () => {
    const off = await runTurn(await freshThread())
    expect(off.providerPrompt).not.toContain(GUIDE_SECTION)
    await flip(true)
    const on = await runTurn(await freshThread())
    expect(on.providerPrompt).toContain(GUIDE_SECTION)
  }, 60_000)
})

describe("a call that still names the tool", () => {
  it("refused feature_off for an admin holding *", async () => {
    const envelope = await executeToolCore({
      toolName: "test:listItems",
      orgId,
      actor: actor(["*"]),
      params: {},
    } as never)
    const error = (envelope as { error: Record<string, any> }).error
    expect(error.code).toBe("feature_off")
    expect(error.retryable).toBe(false)
    expect(error.body.feature).toBe(FEATURE)
    expect(error.message).toContain("did not run")
    expect(error.body.next).toContain("test:items:write")
  })

  it("the scope check comes first: without the scope the refusal is the missing scope", async () => {
    const envelope = await executeToolCore({
      toolName: "test:listItems",
      orgId,
      actor: actor(["kernel:threads:read"]),
      params: {},
    } as never)
    expect((envelope as { error: { code: string } }).error.code).toBe("forbidden")
  })

  const inFixedList = (run: () => Promise<unknown>) =>
    runContextStore.run(
      {
        fixedToolList: { listed: new Set<string>(), isLoaded: () => false },
        turnToolNames: new Set<string>(),
      } as never,
      run,
    )

  it("call_tool with an old name: holder reads feature_off with message and next", async () => {
    const answer = (await inFixedList(() =>
      handleCallTool({ name: DEFERRED_TOOL }, { orgId, userId: owner.userId, scopes: ["*"] }),
    )) as Record<string, unknown>
    expect(answer.code).toBe("feature_off")
    expect(answer.feature).toBe(FEATURE)
    expect(answer.retryable).toBe(false)
    expect(String(answer.message)).toContain("did not run")
    expect(String(answer.next)).toContain("test:items:write")
  })

  it("without scope: No tool is named", async () => {
    await expect(
      inFixedList(() =>
        handleCallTool(
          { name: DEFERRED_TOOL },
          { orgId, userId: owner.userId, scopes: ["kernel:threads:read"] },
        ),
      ),
    ).rejects.toThrow(/No tool named/)
  })

  const repairCall = (tools: Record<string, unknown>) =>
    repairHeldToolCall(tools as never)({
      toolCall: { toolCallId: "c1", toolName: DEFERRED_TOOL, input: "{}" },
      tools,
      error: new NoSuchToolError({ toolName: DEFERRED_TOOL, availableTools: [] }),
    })

  it("a direct call by an old name: holder reads feature_off, without the scope no tool", async () => {
    const held = buildToolSet(orgId, actor(), undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const refusal = await repairCall(held).catch((err: Error) => err.message)
    expect(refusal).toContain('"code":"feature_off"')
    // The SDK flattens it to this, and it stays a model's mistake, not a page.
    expect(isUnresolvedToolCallError(`Error repairing tool call: ${refusal}`)).toBe(true)
    const narrow = buildToolSet(
      orgId,
      actor(["kernel:threads:read"]),
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
    )
    await expect(repairCall(narrow)).rejects.toThrow(/No tool named/)
  })

  it("an MCP call by an old name: holder reads feature_off, without the scope not found", async () => {
    const call = (scopes: string[]) =>
      handleToolCall(
        { orgId, actor: actor(scopes), connectionId: crypto.randomUUID() } as never,
        DEFERRED_TOOL,
        {},
      )
    const holder = (await call(["*"])) as { structuredContent: Record<string, unknown> }
    expect(holder.structuredContent.code).toBe("feature_off")
    expect(holder.structuredContent.next).toContain("test:items:write")
    const other = (await call(["kernel:threads:read"])) as {
      structuredContent: Record<string, unknown>
    }
    expect(other.structuredContent.code).toBe("tool_not_found")
  })
})

describe("the row", () => {
  it("write through the module checks adminScope and records who", async () => {
    const refused = setOrgAppFeature({
      orgId,
      app: "test",
      feature: FEATURE,
      enabled: true,
      actor: { userId: owner.userId, scopes: ["test:items:read"] },
    })
    await expect(refused).rejects.toBeInstanceOf(OrgFeatureError)
    const [before] = await sql<{ enabled: boolean }[]>`
      SELECT enabled FROM kernel.org_app_features
      WHERE org_id = ${orgId} AND app_name = 'test' AND feature = ${FEATURE}`
    expect(before?.enabled ?? false).toBe(false)

    const write = await setOrgAppFeature({
      orgId,
      app: "test",
      feature: FEATURE,
      enabled: true,
      actor: { userId: owner.userId, scopes: ["test:items:write"] },
    })
    expect(write.changed).toBe(true)
    const [row] = await sql<{ enabled: boolean; changed_by: string; changed_at: Date }[]>`
      SELECT enabled, changed_by, changed_at FROM kernel.org_app_features
      WHERE org_id = ${orgId} AND app_name = 'test' AND feature = ${FEATURE}`
    expect(row?.enabled).toBe(true)
    expect(row?.changed_by).toBe(owner.userId)
    expect(row?.changed_at).toBeTruthy()
  })

  it("the same value again changes nothing and tells nobody", async () => {
    await flip(true)
    const spy = spyOn(eventBus, "broadcastEphemeral")
    try {
      expect((await flip(true)).changed).toBe(false)
      expect(spy.mock.calls.length).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })

  it("a feature the app does not declare is refused", async () => {
    await expect(
      setOrgAppFeature({
        orgId,
        app: "test",
        feature: "not-declared",
        enabled: true,
        actor: { userId: owner.userId, scopes: ["*"] },
      }),
    ).rejects.toMatchObject({ code: "not_found" })
  })

  it("read throwing gives off and logs", async () => {
    await flip(true)
    const real = privileged.withPrivilegedDb
    const spy = spyOn(privileged, "withPrivilegedDb").mockImplementation(((
      org: string,
      reason: string,
      fn: never,
      opts: never,
    ) => {
      if (reason === "org-features-read") throw new Error("feature row unreadable")
      return real(org, reason, fn, opts)
    }) as never)
    const logged = spyOn(appsLogger, "error")
    const reads: unknown[] = []
    try {
      await reloadOrgApps(orgId, { fresh: true })
      reads.push(isFeatureOffForTool(orgId, { appName: "test", feature: FEATURE }))
      const refused = await executeToolCore({
        toolName: "test:listItems",
        orgId,
        actor: actor(["*"]),
        params: {},
      } as never)
      reads.push((refused as { error: { code: string } }).error.code)
      expect(logged.mock.calls.some(([, msg]) => String(msg).includes("unreadable"))).toBe(true)
    } finally {
      spy.mockRestore()
      logged.mockRestore()
    }
    expect(reads).toEqual([true, "feature_off"])
    await reloadOrgApps(orgId, { fresh: true })
    expect(isFeatureOffForTool(orgId, { appName: "test", feature: FEATURE })).toBe(false)
  })

  it("an unprimed org reads a featured tool as off and a plain tool as on", () => {
    const unprimed = crypto.randomUUID()
    expect(isFeatureOffForTool(unprimed, { appName: "test", feature: FEATURE })).toBe(true)
    expect(isFeatureOffForTool(unprimed, { appName: "test" })).toBe(false)
  })

  it("route returns enabled features", async () => {
    const read = async () => {
      const res = await app.request("/api/apps/features", {
        headers: { Authorization: `Bearer ${owner.bearer}` },
      })
      expect(res.status).toBe(200)
      return (await res.json()) as { data: Array<{ app: string; feature: string }> }
    }
    expect((await read()).data).toEqual([])
    await flip(true)
    expect((await read()).data).toEqual([{ app: "test", feature: FEATURE }])
  })

  it("cross-org", async () => {
    const other = await seedOrgWithTicketsApp()
    try {
      resetOrgRuntimeForTest(other.orgId)
      await registerApps([featuredManifest()], other.orgId)
      await primeOrgApps(other.orgId, 0)
      await flip(true)
      const tool = { appName: "test", feature: FEATURE }
      expect(isFeatureOffForTool(orgId, tool)).toBe(false)
      expect(isFeatureOffForTool(other.orgId, tool)).toBe(true)
      expect(enabledFeaturesFor(other.orgId)).toEqual([])
      const held = buildToolSet(
        other.orgId,
        actor(["*"], other.orgId, other.ownerId),
        undefined,
        ALL_DEFERRED_TOOLS_UNLOCKED,
      )
      expect(Object.keys(held)).not.toContain(DEFERRED_TOOL)
    } finally {
      resetOrgRuntimeForTest(other.orgId)
      forgetOrgApps(other.orgId)
      await cleanupSeededOrg(other.orgId)
    }
  }, 60_000)
})

describe("a flip", () => {
  it("invalidate reaches open tabs", async () => {
    const spy = spyOn(eventBus, "broadcastEphemeral")
    try {
      await flip(true)
      const update = spy.mock.calls
        .map(([event]) => event)
        .find((e) => e.entity === "org_app" && e.action === "update")
      expect(update?.app).toBe("kernel")
      expect(update?.orgId).toBe(orgId)
      expect(update?.data).toEqual({ app: "test", feature: FEATURE, enabled: true })
    } finally {
      spy.mockRestore()
    }
  })

  it("a flip emits entity app and a live MCP session gets it", async () => {
    // Nothing else drains the outbox in this file, so the org's setup and every earlier
    // flip are still undelivered. A session opened on that backlog hears one notice per
    // debounce window the delivery spans, none of them about this flip.
    while ((await processOutboxBatch()) > 0) {
      // Delivered before the session opens.
    }
    await flushEventHandlers()
    let listChanged = 0
    registerActiveServer({
      connectionId: "feature-flip",
      orgId,
      ownerId: owner.userId,
      sendListChanged: () => {
        listChanged += 1
      },
    })
    try {
      await flip(true)
      const [event] = await sql<{ payload: { entity: string; action: string } }[]>`
        SELECT payload FROM kernel.pending_events
        WHERE org_id = ${orgId} AND payload->>'entity' = 'app'
        ORDER BY seq DESC LIMIT 1`
      expect(event?.payload.action).toBe("feature_update")
      // The outbox delivers it to this process's subscribers, as to every other's.
      await processOutboxBatch()
      await flushEventHandlers()
      const deadline = Date.now() + 10_000
      while (listChanged === 0 && Date.now() < deadline) await Bun.sleep(50)
      // Past another debounce window, so a second notice would have landed by now.
      await Bun.sleep(LIST_CHANGED_SETTLE_MS)
      expect(listChanged).toBe(1)
    } finally {
      unregisterActiveServer("feature-flip")
      __resetCatalogNotifier()
    }
  }, 30_000)

  it("a flip reaches a second process through the Redis channel", async () => {
    const peer = Bun.spawn(
      ["bun", "run", "src/modules/apps/org-features.peer.test-helpers.ts", orgId, "test", FEATURE],
      { cwd: `${import.meta.dir}/../../..`, env: process.env, stdout: "pipe", stderr: "inherit" },
    )
    const lines = peer.stdout.pipeThrough(new TextDecoderStream()).getReader()
    const firstLine = (await lines.read()).value ?? ""
    expect(firstLine.trim()).toBe("off")
    await flip(true)
    await peer.exited
    let rest = ""
    for (let read = await lines.read(); !read.done; read = await lines.read()) rest += read.value
    expect(rest.trim()).toBe("on")
  }, 60_000)

  it("approving a parked row after the flip closes it final with the feature's message", async () => {
    await flip(true)
    const threadId = await freshThread()
    const parked = await executeTool({
      toolName: "test:riskyAction",
      orgId,
      actor: actor(["*"]),
      params: { itemId: "item-1", action: "archive" },
      threadId,
    } as never)
    const requestId = parked.blocked?.approvalRequestId
    expect(requestId).toBeTruthy()

    await flip(false)
    await expect(
      decideApproval({
        orgId,
        requestId: requestId as string,
        actor: actor(["*"]),
        decision: "approve",
      } as never),
    ).rejects.toMatchObject({ status: 422 })

    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM kernel.approval_requests WHERE id = ${requestId as string}`
    expect(row?.status).toBe("cancelled")
    const notices = await sql<{ content: string }[]>`
      SELECT content FROM kernel.messages
      WHERE thread_id = ${threadId} AND metadata->>'type' = 'approval-error'
      ORDER BY created_at DESC LIMIT 1`
    expect(notices[0]?.content).toContain("did not run")
    expect(notices[0]?.content).toContain("closed")
  }, 60_000)
})

describe("an approved call whose feature has since gone off", () => {
  const runs = { write: 0, read: 0, step: 0, dependent: 0 }
  const NAMES = ["laterWrite", "laterRead", "plainStep", "laterDependent"]

  const register = (
    name: string,
    extra: Record<string, unknown>,
    handler: (params: Record<string, unknown>) => unknown,
  ) =>
    toolRegistry.set([orgId, "test", name], {
      appName: "test",
      name,
      description: name,
      requiredScopes: ["test:items:write"],
      gated: true,
      handler: async (params: Record<string, unknown>) => handler(params),
      ...extra,
    } as never)

  beforeAll(() => {
    register("laterWrite", { feature: FEATURE }, () => {
      runs.write += 1
      return { written: true }
    })
    register("laterRead", { feature: FEATURE, readOnly: true }, () => {
      runs.read += 1
      return { found: true }
    })
    register("plainStep", { referenceableOutputs: ["value"] }, () => {
      runs.step += 1
      return { value: "from-the-first-step" }
    })
    register("laterDependent", { feature: FEATURE }, () => {
      runs.dependent += 1
      return { done: true }
    })
  })

  afterAll(() => {
    for (const name of NAMES) toolRegistry.delete([orgId, "test", name])
  })

  const park = async (tool: string, threadId: string, params: Record<string, unknown> = {}) => {
    const parked = await executeTool({
      toolName: `test:${tool}`,
      orgId,
      actor: actor(["*"]),
      params,
      threadId,
    } as never)
    const requestId = parked.blocked?.approvalRequestId
    expect(requestId).toBeTruthy()
    return requestId as string
  }
  const approve = (requestId: string) =>
    decideApproval({ orgId, requestId, actor: actor(["*"]), decision: "approve" } as never)
  const statusOf = async (requestId: string) => {
    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM kernel.approval_requests WHERE id = ${requestId}`
    return row?.status
  }
  const executionOf = async (requestId: string) => {
    const [row] = await sql<{ status: string; error: { code?: string } | null }[]>`
      SELECT status, error FROM kernel.approved_handler_executions
      WHERE approval_request_id = ${requestId}`
    return row
  }
  const noticeIn = async (threadId: string) => {
    const [row] = await sql<{ content: string }[]>`
      SELECT content FROM kernel.messages
      WHERE thread_id = ${threadId} AND metadata->>'type' = 'approval-error'
      ORDER BY created_at DESC LIMIT 1`
    return row?.content ?? ""
  }

  it("a write runs while the feature is on and not after: closed, final, in plain words", async () => {
    await flip(true)
    const threadId = await freshThread()
    const before = runs.write
    const ran = await park("laterWrite", threadId)
    await approve(ran)
    expect(runs.write).toBe(before + 1)
    expect(await statusOf(ran)).toBe("approved")

    const parked = await park("laterWrite", threadId)
    await flip(false)
    await expect(approve(parked)).rejects.toMatchObject({ status: 422 })

    expect(runs.write).toBe(before + 1)
    expect(await statusOf(parked)).toBe("cancelled")
    const execution = await executionOf(parked)
    expect(execution?.status).toBe("failed_no_effect")
    expect(execution?.error?.code).toBe("feature_off")
    const notice = await noticeIn(threadId)
    expect(notice).toContain("test__laterWrite did not run and nothing changed")
    expect(notice).toContain("Someone holding test:items:write can turn it on")
    expect(notice).toContain("The request is closed")
    // It stays closed: approving again runs nothing.
    await expect(approve(parked)).rejects.toThrow()
    expect(runs.write).toBe(before + 1)
  }, 60_000)

  const failFeatureReads = () => {
    const real = privileged.withPrivilegedDb
    const reads = { count: 0 }
    const spy = spyOn(privileged, "withPrivilegedDb").mockImplementation(((
      org: string,
      reason: string,
      fn: never,
      opts: never,
    ) => {
      if (reason === "org-features-read") {
        reads.count += 1
        throw new Error("feature row unreadable")
      }
      return real(org, reason, fn, opts)
    }) as never)
    return { reads, spy }
  }

  it("a features read that throws during an approval leaves the request pending and retryable", async () => {
    await flip(true)
    const threadId = await freshThread()
    const before = runs.write
    const parked = await park("laterWrite", threadId)
    const { spy } = failFeatureReads()
    const logged = spyOn(appsLogger, "error").mockImplementation((() => {}) as never)
    try {
      await reloadOrgApps(orgId, { fresh: true })
      await expect(approve(parked)).rejects.toThrow()
    } finally {
      spy.mockRestore()
      logged.mockRestore()
    }
    expect(runs.write).toBe(before)
    expect(await statusOf(parked)).toBe("pending")
    expect((await executionOf(parked))?.error?.code).not.toBe("feature_off")

    // The read recovers: the same request is approved again and runs.
    await approve(parked)
    expect(runs.write).toBe(before + 1)
    expect(await statusOf(parked)).toBe("approved")
  }, 60_000)

  it("the next prime after a failed read reads the table again", async () => {
    await flip(true)
    const { reads, spy } = failFeatureReads()
    const logged = spyOn(appsLogger, "error").mockImplementation((() => {}) as never)
    try {
      await reloadOrgApps(orgId, { fresh: true })
      expect(reads.count).toBeGreaterThan(0)
      expect(isFeatureOffForTool(orgId, { appName: "test", feature: FEATURE })).toBe(true)
    } finally {
      spy.mockRestore()
      logged.mockRestore()
    }
    // A plain prime, well inside the TTL: the failed answer was not kept, so it reads again.
    await primeOrgApps(orgId)
    expect(isFeatureOffForTool(orgId, { appName: "test", feature: FEATURE })).toBe(false)
  })

  it("a read closes the same way, never reading as a tool that ran and failed", async () => {
    await flip(true)
    const threadId = await freshThread()
    const before = runs.read
    const parked = await park("laterRead", threadId)
    await flip(false)
    await expect(approve(parked)).rejects.toMatchObject({ status: 422 })

    expect(runs.read).toBe(before)
    expect(await statusOf(parked)).toBe("cancelled")
    expect((await executionOf(parked))?.status).toBe("failed_no_effect")
    expect(await noticeIn(threadId)).toContain("test__laterRead did not run")
    const said = await sql<{ content: string }[]>`
      SELECT content FROM kernel.messages WHERE thread_id = ${threadId}`
    expect(said.map((m) => m.content).join("\n")).not.toContain("The tool ran")
  }, 60_000)

  it("a later step of a sequence does not run, the sequence ends and says why", async () => {
    const reinvokes = spyOn(jobs, "enqueueAppJob").mockImplementation((async () => "stub") as never)
    try {
      await flip(true)
      const threadId = await freshThread()
      const before = { step: runs.step, dependent: runs.dependent }
      const head = await park("plainStep", threadId)
      const dependent = await park("laterDependent", threadId, { note: `@ref:${head}:value` })
      await flip(false)
      await approve(head)

      expect(runs.step).toBe(before.step + 1)
      expect(await statusOf(head)).toBe("approved")
      expect(runs.dependent).toBe(before.dependent)
      expect(await statusOf(dependent)).toBe("cancelled")
      const [row] = await sql<{ failure: { reason: string } }[]>`
        SELECT metadata->'executionFailure' AS failure FROM kernel.approval_requests
        WHERE id = ${dependent}`
      expect(row?.failure.reason).toContain("test__laterDependent did not run")
    } finally {
      reinvokes.mockRestore()
    }
  }, 60_000)
})

describe("the breaker", () => {
  const STALE_APP = "staleness"
  const freshFrame = (): RunContext => ({
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: "root",
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator({ orgId }),
  })

  beforeAll(() => {
    toolRegistry.set([orgId, STALE_APP, "edit"], {
      appName: STALE_APP,
      name: "edit",
      description: "A write two people race on",
      requiredScopes: ["kernel:threads:read"],
      params: z.object({ revision: z.number() }),
      handler: async () => {
        throw Object.assign(new Error("Revision conflict"), {
          status: 409,
          code: "stale_revision",
        })
      },
    } as never)
  })

  afterAll(() => {
    toolRegistry.delete([orgId, STALE_APP, "edit"])
  })

  const callThreeSteps = async (name: string, args: Record<string, unknown>) => {
    const tools = buildToolSet(orgId, actor(), undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const tool = tools[name] as {
      execute: (a: unknown, o: { toolCallId: string; messages: unknown[] }) => Promise<unknown>
    }
    return runContextStore.run(freshFrame(), async () => {
      const results: unknown[] = []
      for (let step = 1; step <= 4; step++) {
        results.push(
          await tool.execute(args, {
            toolCallId: `c${step}`,
            messages: Array.from({ length: step }),
          }),
        )
      }
      return results as Array<{ error: string }>
    })
  }

  it("three stale results leave the breaker closed", async () => {
    const results = await callThreeSteps(`${STALE_APP}__edit`, { revision: 1 })
    expect(results[0]?.error).toContain("Read it again")
    expect(results[3]?.error).not.toContain("BLOCKED")
    expect(results[3]?.error).toContain("stale_revision")
  })

  it("three feature_off open it", async () => {
    // Built while on, so the call goes through the tool a turn already holds.
    await flip(true)
    const tools = buildToolSet(orgId, actor(), undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    await flip(false)
    const tool = tools[DEFERRED_TOOL] as {
      execute: (a: unknown, o: { toolCallId: string; messages: unknown[] }) => Promise<unknown>
    }
    const results = await runContextStore.run(freshFrame(), async () => {
      const out: Array<{ error: string }> = []
      for (let step = 1; step <= 4; step++) {
        out.push(
          (await tool.execute(
            {},
            { toolCallId: `c${step}`, messages: Array.from({ length: step }) },
          )) as { error: string },
        )
      }
      return out
    })
    expect(results[0]?.error).toContain("feature_off")
    expect(results[0]?.error).toContain("did not run")
    expect(results[3]?.error).toContain("BLOCKED")
  })
})

describe("the seam itself", () => {
  it("rememberOrgAppStates plants features for walks that never prime", () => {
    const planted = crypto.randomUUID()
    rememberOrgAppStates(planted, [{ app: "test", status: "active" }], {
      features: { test: [FEATURE] },
    })
    expect(isFeatureOffForTool(planted, { appName: "test", feature: FEATURE })).toBe(false)
    forgetOrgApps(planted)
  })
})
