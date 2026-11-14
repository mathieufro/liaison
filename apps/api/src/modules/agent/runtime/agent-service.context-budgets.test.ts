// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EVERY MODEL CALL'S INPUT RESPECTS THE DECLARED BUDGETS. A routine tick in
// prod started with 168 tool schemas (85,000 tokens) pre-seeded from its
// scopes, and a system prompt of 47,000 tokens while the log claimed it had
// been "truncated to 8000 token cap": the cap measured the app, owner and
// prior read text only, and the seeded apps' full guides were counted as
// undroppable. These cases run a real turn through the agent loop with a
// capturing model and measure what the provider is actually handed.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import { rootLogger } from "~/lib/logger"
import { estimateTokens } from "~/modules/agent/context/compaction"
import {
  enforceSystemPromptTokenCap,
  estimateToolSchemaTokens,
  NO_TOOL_DISCOVERY_MARKER,
  TURN_SYSTEM_PROMPT_TOKEN_CAP,
  TURN_TOOL_SCHEMA_TOKEN_CAP,
} from "~/modules/agent/context/context"
import {
  DISCOVERED_TOOLS_META_KEY,
  TOOL_ORDER_META_KEY,
} from "~/modules/agent/context/discovery-window"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { planTurnToolBudget } from "~/modules/agent/runtime/turn-tool-budget"
import {
  agentInstructionsRegistry,
  entityRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

const ORG_ID = "00000000-0000-0000-0000-000000d60001"
const USER_ID = "00000000-0000-0000-0000-000000d60002"
const THREAD_ID = "00000000-0000-0000-0000-000000d60003"
const MODEL_ID = "claude-haiku-4-5-ctx-budgets"

// Two big apps whose seeded schemas together are far over the tool budget,
// each ~500 tokens a tool, and one small app that fits beside the core set.
const BIG_APPS = ["bulkship", "bulkbill"] as const
const BIG_TOOL_COUNT = 40
const SMALL_APP = "tinyapp"
const BIG_GUIDE = (app: string) =>
  `The ${app} app.\n\n${app.toUpperCase()}-FULL-GUIDE-MARKER ${"guide text ".repeat(1500)}`
// An app anchored skill on the small app: its body alone fits beside the
// app/owner/prior-read text the old cap measured, but not beside the whole
// system prompt the request actually carries.
const SKILL_NAME = "tiny-playbook"
// Sized from the cap (about three quarters of it, at ~4 chars a token) so the
// case keeps binding whatever the cap is tuned to.
const SKILL_BODY = `TINY-PLAYBOOK-BODY-MARKER ${"step ".repeat(
  Math.round((TURN_SYSTEM_PROMPT_TOKEN_CAP * 0.75 * 4) / 5),
)}`

let capturedParams: any = null

function capturingStreamText(params: any) {
  capturedParams = params
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "ok" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1000, outputTokens: 10 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

const ACTOR = {
  actorType: "user" as const,
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

function registerTool(
  app: string,
  name: string,
  description: string,
  requiredScopes: string[] = ["kernel:threads:read"],
  extra: { focusCore?: true | string } = {},
) {
  toolRegistry.set([ORG_ID, app, name], {
    appName: app,
    name,
    description,
    requiredScopes,
    ...extra,
    handler: async () => ({ ok: true, tool: `${app}__${name}` }),
  } as any)
}

const bigToolNames = (app: string) =>
  Array.from({ length: BIG_TOOL_COUNT }, (_, i) => `${app}__op_${String(i).padStart(2, "0")}`)

function sentSystemTokens(system: unknown): number {
  const parts = system as Array<{ content: string }>
  return parts.reduce((n, p) => n + estimateTokens(p.content), 0)
}

function sentToolSchemaTokens(tools: Record<string, any>, active: string[]): number {
  return active.reduce((n, name) => n + estimateToolSchemaTokens(name, tools[name]), 0)
}

describe("context budgets hold on the request a turn actually sends", () => {
  beforeAll(async () => {
    await acquireTestLock()
    AgentServiceTestAccess.setStreamText(capturingStreamText as never)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'CtxBudgetsOrg', 'ctx-budgets-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'ctxbudgets@test.com', 'Ctx Budgets') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${ORG_ID}, 'personal', '@ctxbudgets', 'Budget agent', ${USER_ID}, '["*"]'::jsonb) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER_ID}, ${ORG_ID}, '*') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'ctx-budgets-chat', 'agent_chat', ${USER_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '0', 'EUR') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku Budgets', '1.00', '5.00', 200000, true, 'starter') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.skills (org_id, name, description, body, enabled, auto_attach, created_by_actor_type)
      VALUES (${ORG_ID}, ${SKILL_NAME}, 'How to work the tiny app', ${SKILL_BODY}, true, ${JSON.stringify({ apps: [SMALL_APP] })}::jsonb, 'user')`

    for (const app of BIG_APPS) {
      agentInstructionsRegistry.set([ORG_ID, app], BIG_GUIDE(app))
      for (const sdk of bigToolNames(app)) {
        registerTool(app, sdk.split("__")[1], `${sdk}: ${"does one bulk thing. ".repeat(95)}`)
      }
    }
    agentInstructionsRegistry.set([ORG_ID, SMALL_APP], "The tiny app. TINYAPP-GUIDE-MARKER")
    registerTool(SMALL_APP, "ping", "Ping the tiny app.")
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    for (const app of BIG_APPS) {
      agentInstructionsRegistry.delete([ORG_ID, app])
      for (const sdk of bigToolNames(app)) toolRegistry.delete([ORG_ID, app, sdk.split("__")[1]])
    }
    agentInstructionsRegistry.delete([ORG_ID, SMALL_APP])
    toolRegistry.delete([ORG_ID, SMALL_APP, "ping"])
    await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    await releaseTestLock()
  })

  it("a turn seeded with oversized apps ships tool schemas and a system prompt within their caps, and a trimmed tool stays one tool_search away", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const seed = new Set<string>([
        ...BIG_APPS.flatMap((app) => bigToolNames(app)),
        `${SMALL_APP}__ping`,
      ])
      const seededNames = [...seed]
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID,
        content: "run the tiny ping",
        actor: ACTOR,
        orgId: ORG_ID,
        seedDiscoveredTools: seed,
      })
      expect(capturedParams).not.toBeNull()
      const step0 = await capturedParams.prepareStep({ steps: [], stepNumber: 0 })
      const active: string[] = step0.activeTools

      // The seed alone was far over budget: this is what the fix trims.
      const seededTokens = seededNames.reduce(
        (n, name) => n + estimateToolSchemaTokens(name, capturedParams.tools[name]),
        0,
      )
      expect(seededTokens).toBeGreaterThan(TURN_TOOL_SCHEMA_TOKEN_CAP)

      const toolTokens = sentToolSchemaTokens(capturedParams.tools, active)
      const systemTokens = sentSystemTokens(capturedParams.system)
      console.log(
        JSON.stringify({ seededTokens, toolCount: active.length, toolTokens, systemTokens }),
      )
      expect(toolTokens).toBeLessThanOrEqual(TURN_TOOL_SCHEMA_TOKEN_CAP)
      expect(systemTokens).toBeLessThanOrEqual(TURN_SYSTEM_PROMPT_TOKEN_CAP)

      // Whole apps go, never half an app, and the small app survives.
      expect(active).toContain(`${SMALL_APP}__ping`)
      const droppedBig = BIG_APPS.filter((app) => !active.includes(bigToolNames(app)[0]))
      expect(droppedBig.length).toBeGreaterThan(0)
      for (const app of droppedBig) {
        for (const name of bigToolNames(app)) expect(active).not.toContain(name)
        // Its full guide left the prefix with its tools.
        expect(JSON.stringify(capturedParams.system)).not.toContain(
          `${app.toUpperCase()}-FULL-GUIDE-MARKER`,
        )
      }
      // The oversized app anchored body was the droppable block that went.
      expect(JSON.stringify(capturedParams.system)).not.toContain("TINY-PLAYBOOK-BODY-MARKER")

      // A trimmed tool is still announced, discoverable and callable.
      const target = bigToolNames(droppedBig[0])[0]
      expect(JSON.stringify(capturedParams.system)).toContain(droppedBig[0])
      expect(JSON.stringify(capturedParams.system)).toContain("FIRST call kernel__tool_search")
      expect(JSON.stringify(capturedParams.system)).not.toContain(NO_TOOL_DISCOVERY_MARKER)
      await capturedParams.tools.kernel__tool_search.execute({ query: `select:${target}` })
      expect(result.discoveredTools.has(target)).toBe(true)
      const step1 = await capturedParams.prepareStep({ steps: [], stepNumber: 1, messages: [] })
      expect(step1.activeTools).toContain(target)
      const out = await capturedParams.tools[target].execute({})
      expect(JSON.stringify(out)).toContain(target)

      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  // A regular org: the thread has been working one app, and the main panel
  // still shows a tab of another. The tab is the client's word and changes
  // with every click: it must never push out what the conversation loaded.
  it("a regular org's open tab of another app never pushes out the tools the thread loaded", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      // Half of bulkship: what the thread loaded, and it fits the budget.
      const loaded = bigToolNames("bulkship").slice(0, BIG_TOOL_COUNT / 2)
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID,
        content: "refund that order too",
        actor: ACTOR,
        orgId: ORG_ID,
        seedDiscoveredTools: new Set(loaded),
        currentView: { tabType: "bulkbill:invoice", entityId: crypto.randomUUID() },
      })
      const step0 = await capturedParams.prepareStep({ steps: [], stepNumber: 0 })
      const active: string[] = step0.activeTools
      for (const name of loaded) expect(active).toContain(name)
      // The tab's app only took the room left.
      expect(sentToolSchemaTokens(capturedParams.tools, active)).toBeLessThanOrEqual(
        TURN_TOOL_SCHEMA_TOKEN_CAP,
      )
      expect(active.filter((n) => n.startsWith("bulkbill__")).length).toBeLessThan(BIG_TOOL_COUNT)
      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  // Live demo (an org with every app): a reply asked for on a ticket's own
  // thread lost the whole tickets app, the largest one and so the first
  // trimmed; the agent then searched for tools until its turn ran out. The
  // thread's own entity is the server's word, so its app is shed last, and
  // still within the budget: its own loaded tools are trimmable too.
  it("the app of the thread's own entity keeps its tools over another app's, within the budget", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    await sql`UPDATE kernel.threads SET created_from = ${JSON.stringify({ app: "bulkbill", entityType: "invoice", entityId: crypto.randomUUID() })}::jsonb WHERE id = ${THREAD_ID}`
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID,
        content: "draft the reply",
        actor: ACTOR,
        orgId: ORG_ID,
        // Both big apps loaded: each alone is about the whole budget.
        seedDiscoveredTools: new Set<string>(BIG_APPS.flatMap((app) => bigToolNames(app))),
      })
      const step0 = await capturedParams.prepareStep({ steps: [], stepNumber: 0 })
      const active: string[] = step0.activeTools
      // The other big app went whole; the thread's app kept most of its tools.
      for (const name of bigToolNames("bulkship")) expect(active).not.toContain(name)
      const kept = active.filter((n) => n.startsWith("bulkbill__"))
      expect(kept.length).toBeGreaterThan(BIG_TOOL_COUNT / 2)
      // And the turn still fits: the focus app's own tools were trimmed to it.
      expect(sentToolSchemaTokens(capturedParams.tools, active)).toBeLessThanOrEqual(
        TURN_TOOL_SCHEMA_TOKEN_CAP,
      )
      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      await sql`UPDATE kernel.threads SET created_from = NULL WHERE id = ${THREAD_ID}`
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  // Live demo: the last turns staged a shipment in one app while the turn's
  // focus app (here the thread's own entity) preloaded its whole catalog. The
  // budget shed the app the conversation was working, the thread column
  // forgot it, and a vague follow-up ("HELLO ?") had no tool to go on with.
  it("the tools the last turns used stay loaded after a vague message, beside a capped focus preload", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${THREAD_ID}`
    await sql`UPDATE kernel.threads SET agent_discovered_tools = '[]'::jsonb, created_from = ${JSON.stringify({ app: "bulkbill", entityType: "invoice", entityId: crypto.randomUUID() })}::jsonb WHERE id = ${THREAD_ID}`
    const [agent] = await sql<
      { id: string }[]
    >`SELECT id FROM kernel.agents WHERE org_id = ${ORG_ID} AND handle = '@ctxbudgets'`
    const used = bigToolNames("bulkship").slice(0, 3)
    for (const [i, name] of used.entries()) {
      const metadata = {
        toolCalls: [{ toolCallId: `c${i}`, toolName: name, args: {}, result: { ok: true } }],
      }
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes, created_at)
        VALUES (${crypto.randomUUID()}, ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'agent', ${agent.id}, 'Staged.', ${JSON.stringify(metadata)}::jsonb, '{}', now() - ${`${10 - i} minutes`}::interval)`
    }
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID,
        content: "HELLO ?",
        actor: ACTOR,
        orgId: ORG_ID,
      })
      const step0 = await capturedParams.prepareStep({ steps: [], stepNumber: 0 })
      const active: string[] = step0.activeTools
      for (const name of used) expect(active).toContain(name)
      expect(active).toContain("kernel__tool_search")
      // The focus app is loaded, within its share, not to the whole budget.
      const focusKept = active.filter((n) => n.startsWith("bulkbill__"))
      expect(focusKept.length).toBeGreaterThan(0)
      expect(focusKept.length).toBeLessThan(BIG_TOOL_COUNT)
      expect(sentToolSchemaTokens(capturedParams.tools, active)).toBeLessThanOrEqual(
        TURN_TOOL_SCHEMA_TOKEN_CAP,
      )
      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      await sql`UPDATE kernel.threads SET created_from = NULL WHERE id = ${THREAD_ID}`
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("a regular org's tab app fills the room the budget left, and its playbook stays under the prompt cap", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID,
        content: "what about this one",
        actor: ACTOR,
        orgId: ORG_ID,
        seedDiscoveredTools: new Set<string>(BIG_APPS.flatMap((app) => bigToolNames(app))),
        currentView: { tabType: `${SMALL_APP}:thing`, entityId: crypto.randomUUID() },
      })
      const step0 = await capturedParams.prepareStep({ steps: [], stepNumber: 0 })
      expect(step0.activeTools).toContain(`${SMALL_APP}__ping`)
      expect(sentSystemTokens(capturedParams.system)).toBeLessThanOrEqual(
        TURN_SYSTEM_PROMPT_TOKEN_CAP,
      )
      expect(JSON.stringify(capturedParams.system)).not.toContain("TINY-PLAYBOOK-BODY-MARKER")
      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
      // Recorded as the turn's own discovery: the next turn keeps it, so
      // switching tabs does not change the tool set on every message.
      const [reply] = await sql<{ discovered: string[] | null }[]>`
        SELECT metadata->'${sql.unsafe(DISCOVERED_TOOLS_META_KEY)}' AS discovered FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
        ORDER BY created_at DESC LIMIT 1`
      expect(reply?.discovered ?? []).toContain(`${SMALL_APP}__ping`)
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  // An app whose manifest names a core list (`focusCore`): on a thread made
  // for one of its entities the turn loads that list with its schemas. With a
  // fixed tool list (kernel__call_tool held) every other tool of the app is
  // held for the SDK and listed by name only, so a first call through
  // kernel__call_tool runs; without one they stay in the deferred catalog.
  describe("a thread's own app with a core list", () => {
    const CORE_APP = "corebill"
    const coreNames = Array.from({ length: 30 }, (_, i) => `op_${String(i).padStart(2, "0")}`)
    const sdk = (name: string) => `${CORE_APP}__${name}`
    const turn = async (withCallTool: boolean) => {
      capturedParams = null
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      agentInstructionsRegistry.set([ORG_ID, CORE_APP], "The core bill app.")
      entityRegistry.set([ORG_ID, CORE_APP, "invoice"], { labelField: "number", handlePrefix: "I" })
      const declared: Record<string, true | string> = {
        op_00: true,
        op_01: "invoice",
        op_02: "credit_note",
      }
      for (const name of coreNames) {
        const focusCore = declared[name]
        registerTool(
          CORE_APP,
          name,
          `${sdk(name)}: ${"does one billing thing. ".repeat(20)}`,
          ["kernel:threads:read"],
          focusCore ? { focusCore } : {},
        )
      }
      // The kernel's tools are registered by the first turn of this file: a
      // turn without a fixed list is one whose tool set holds no call_tool.
      const callTool = toolRegistry.get([ORG_ID, "kernel", "call_tool"])
      if (!withCallTool) toolRegistry.delete([ORG_ID, "kernel", "call_tool"])
      else expect(callTool).toBeDefined()
      await sql`DELETE FROM kernel.messages WHERE thread_id = ${THREAD_ID}`
      await sql`UPDATE kernel.threads SET agent_discovered_tools = '[]'::jsonb, created_from = ${JSON.stringify({ app: CORE_APP, entityType: "invoice", entityId: crypto.randomUUID() })}::jsonb WHERE id = ${THREAD_ID}`
      try {
        const { runAgentChat } = await import("./agent-service")
        const result = await runAgentChat({
          threadId: THREAD_ID,
          content: "mark it paid",
          actor: ACTOR,
          orgId: ORG_ID,
        })
        const step0 = await capturedParams.prepareStep({ steps: [], stepNumber: 0 })
        const active = step0.activeTools as string[]
        const messages = JSON.stringify(capturedParams.messages)
        await result.finalize({
          usage: { promptTokens: 1000, completionTokens: 10 },
          finishReason: "stop",
          text: "ok",
          steps: [],
        })
        // The list the provider was sent, as the reply records it for the next turn.
        const [reply] = await sql<{ order: string[] | null }[]>`
          SELECT metadata->'${sql.unsafe(TOOL_ORDER_META_KEY)}' AS order FROM kernel.messages
          WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
          ORDER BY created_at DESC LIMIT 1`
        return { active, sent: reply?.order ?? [], messages }
      } finally {
        await sql`UPDATE kernel.threads SET created_from = NULL WHERE id = ${THREAD_ID}`
        await sql`DELETE FROM kernel.messages WHERE thread_id = ${THREAD_ID}`
        if (!withCallTool && callTool) toolRegistry.set([ORG_ID, "kernel", "call_tool"], callTool)
        agentInstructionsRegistry.delete([ORG_ID, CORE_APP])
        entityRegistry.delete([ORG_ID, CORE_APP, "invoice"])
        for (const name of coreNames) toolRegistry.delete([ORG_ID, CORE_APP, name])
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    }

    it("sends that list's schemas and holds every other tool, listed by name, for a call", async () => {
      const { active, sent, messages } = await turn(true)
      expect(sent).toContain("kernel__call_tool")
      // A tool named for an entity type the thread is not about is by name only.
      expect(sent.filter((n) => n.startsWith(`${CORE_APP}__`)).sort()).toEqual([
        sdk("op_00"),
        sdk("op_01"),
      ])
      for (const name of coreNames) expect(active).toContain(sdk(name))
      expect(messages).toContain(`- ${sdk("op_05")}`)
      expect(messages).toContain(`- ${sdk("op_02")}`)
      expect(messages).not.toContain(`- ${sdk("op_00")}`)
    })

    it("without a fixed list, loads that list and leaves the others in the deferred catalog", async () => {
      const { active, sent } = await turn(false)
      expect(sent).not.toContain("kernel__call_tool")
      const loaded = active.filter((n) => n.startsWith(`${CORE_APP}__`))
      expect(loaded.sort()).toEqual([sdk("op_00"), sdk("op_01")])
    })
  })
})

// A routine's scopes name its domain apps and may omit `kernel:threads:read`,
// the gate of tool_search (prod: the support routine's tick). Trimming an app
// from such a turn loses it for the whole tick, since nothing can load it
// back, so the seed must reach the provider whole.
describe("a turn that cannot call tool_search keeps its seeded apps", () => {
  const NO_SEARCH_APPS = ["ticketsx", "billx"] as const
  // In the turn's scope but not seeded: it stays deferred, so the prompt has
  // a catalog to announce.
  const SPARE_APP = "sparex"
  // A real scope that is not tool_search's gate, like a routine's domain scope.
  const scopeOf = (_app: string) => "kernel:files:read"

  beforeAll(async () => {
    await acquireTestLock()
    AgentServiceTestAccess.setStreamText(capturingStreamText as never)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'CtxBudgetsOrg', 'ctx-budgets-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'ctxbudgets@test.com', 'Ctx Budgets') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${ORG_ID}, 'personal', '@ctxbudgets', 'Budget agent', ${USER_ID}, '["*"]'::jsonb) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER_ID}, ${ORG_ID}, '*') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'ctx-budgets-chat', 'agent_chat', ${USER_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '0', 'EUR') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku Budgets', '1.00', '5.00', 200000, true, 'starter') ON CONFLICT DO NOTHING`
    for (const app of NO_SEARCH_APPS) {
      for (const sdk of bigToolNames(app)) {
        registerTool(app, sdk.split("__")[1], `${sdk}: ${"does one bulk thing. ".repeat(95)}`, [
          scopeOf(app),
        ])
      }
    }
    agentInstructionsRegistry.set([ORG_ID, SPARE_APP], "The spare app. SPAREX-SUMMARY-MARKER")
    registerTool(SPARE_APP, "lookup", "Look a spare thing up.", [scopeOf(SPARE_APP)])
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    for (const app of NO_SEARCH_APPS) {
      for (const sdk of bigToolNames(app)) toolRegistry.delete([ORG_ID, app, sdk.split("__")[1]])
    }
    agentInstructionsRegistry.delete([ORG_ID, SPARE_APP])
    toolRegistry.delete([ORG_ID, SPARE_APP, "lookup"])
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    await releaseTestLock()
  })

  it("an over budget seed is not trimmed when the turn cannot call tool_search", async () => {
    capturedParams = null
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const seededNames = NO_SEARCH_APPS.flatMap((app) => bigToolNames(app))
      const seed = new Set<string>(seededNames)
      const { runAgentChat } = await import("./agent-service")
      const result = await runAgentChat({
        threadId: THREAD_ID,
        content: "triage the ticket",
        // The routine tick's actor: its scopes, without kernel:threads:read.
        actor: { ...ACTOR, scopes: [...new Set(NO_SEARCH_APPS.map(scopeOf))] },
        orgId: ORG_ID,
        seedDiscoveredTools: seed,
      })
      expect(capturedParams).not.toBeNull()
      expect(capturedParams.tools.kernel__tool_search).toBeUndefined()
      const seededTokens = seededNames.reduce(
        (n, name) => n + estimateToolSchemaTokens(name, capturedParams.tools[name]),
        0,
      )
      expect(seededTokens).toBeGreaterThan(TURN_TOOL_SCHEMA_TOKEN_CAP)

      const step0 = await capturedParams.prepareStep({ steps: [], stepNumber: 0 })
      const active: string[] = step0.activeTools
      for (const name of seededNames) {
        expect(active).toContain(name)
        expect(result.discoveredTools.has(name)).toBe(true)
      }

      // The prompt never sends this turn to a tool it cannot call.
      const system = JSON.stringify(capturedParams.system)
      expect(active).not.toContain(`${SPARE_APP}__lookup`)
      expect(system).not.toContain("FIRST call kernel__tool_search")
      expect(system).not.toContain("discover one of its tools via kernel__tool_search")
      expect(system).toContain(NO_TOOL_DISCOVERY_MARKER)
      expect(system).toMatch(new RegExp(`cannot be loaded here: [a-z0-9_, -]*\\b${SPARE_APP}\\b`))

      await result.finalize({
        usage: { promptTokens: 1000, completionTokens: 10 },
        finishReason: "stop",
        text: "ok",
        steps: [],
      })
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })
})

describe("the budget functions warn with the numbers whenever they bind", () => {
  const warnings = (fn: () => void): Array<[Record<string, unknown>, string]> => {
    const warn = spyOn(Object.getPrototypeOf(rootLogger.child({ module: "spy" })), "warn")
    try {
      warn.mockClear()
      fn()
      return warn.mock.calls as never
    } finally {
      warn.mockRestore()
    }
  }
  const tool = (chars: number) => ({ description: "d".repeat(chars) })

  const plan = (
    tools: Record<string, { description?: string }>,
    droppable: (n: string) => boolean,
    cap: number,
  ) =>
    planTurnToolBudget({
      visible: Object.keys(tools),
      tools,
      droppable,
      preloaded: new Set(),
      hardFocusApps: new Set(),
      focus: new Map(),
      recency: new Map(),
      cap,
    })

  it("tool budget drops whole unused apps, largest first, and never a core tool", () => {
    const tools = {
      kernel__core: tool(4000),
      big__a: tool(4000),
      big__b: tool(4000),
      mid__a: tool(2000),
      small__a: tool(400),
    }
    let out: ReturnType<typeof planTurnToolBudget> | undefined
    const calls = warnings(() => {
      out = plan(tools, (n) => !n.startsWith("kernel__"), 1_500)
    })
    expect(out?.drop).toEqual(["big__a", "big__b", "mid__a"])
    expect(out?.toolSchemaTokens).toBeLessThanOrEqual(1_500)
    const line = calls.find((c) => String(c[1]).includes("trimmed to the 1500 token budget"))
    expect(line?.[0]).toMatchObject({
      droppedApps: ["big", "mid"],
      droppedToolCount: 3,
      cap: 1_500,
    })
  })

  it("tool budget and system cap each warn when what is left cannot be dropped", () => {
    const toolCalls = warnings(() => plan({ kernel__core: tool(40_000) }, () => false, 100))
    const over = toolCalls.find((c) => String(c[1]).includes("over their 100 token budget"))
    expect(over?.[0]).toMatchObject({ protectedToolCount: 1, droppedToolCount: 0 })
    expect(Number(over?.[0].toolSchemaTokens)).toBeGreaterThan(100)
    const sysCalls = warnings(() =>
      enforceSystemPromptTokenCap({ fixedParts: ["x".repeat(40_000)], blocks: [], cap: 100 }),
    )
    const line = sysCalls.find((c) => String(c[1]).includes("nothing left to drop"))
    expect(line?.[0]).toMatchObject({ estimatedTokens: 10_000, fixedTokens: 10_000, cap: 100 })
  })

  // A demo visitor's turn keeps the playbook of the app it is about past the cap (it cannot
  // spare a skill_read step). An overshoot that playbook accounts for is the design: the
  // box logged it as a broken budget on every visitor turn.
  it("does not warn when only the request's own kept app playbook puts the prompt over", () => {
    const calls = warnings(() =>
      enforceSystemPromptTokenCap({
        fixedParts: ["x".repeat(360)],
        blocks: [
          { name: "focus-playbook", kind: "focus_anchored", text: "y".repeat(400) },
        ] as never,
        cap: 100,
      }),
    )
    expect(calls.some((c) => String(c[1]).includes("token cap"))).toBe(false)
    const over = warnings(() =>
      enforceSystemPromptTokenCap({
        fixedParts: ["x".repeat(800)],
        blocks: [
          { name: "focus-playbook", kind: "focus_anchored", text: "y".repeat(400) },
        ] as never,
        cap: 100,
      }),
    )
    const line = over.find((c) => String(c[1]).includes("nothing left to drop"))
    expect(line?.[0]).toMatchObject({ fixedTokens: 200, focusTokens: 100 })
  })

  it("stays silent under budget", () => {
    const calls = warnings(() => {
      plan({ a__x: tool(40) }, () => true, 100)
      enforceSystemPromptTokenCap({ fixedParts: ["x"], blocks: [], cap: 100 })
    })
    expect(calls).toHaveLength(0)
  })
})
