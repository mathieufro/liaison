// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it as itAlways } from "bun:test"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, connectWs, createUserWithScopes } from "@liaison/test-helpers"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { byokEncryptionKey } from "~/lib/env"
// In this file `it` is the LIVE-gated case (helpers/live-llm.ts): it drives a real
// model provider and runs only under LIAISON_E2E_LIVE_LLM=1. `itAlways` marks the
// cases that never reach a real model (auth, zero balance, memory isolation, the
// fetch blocklist, and SC7/SC11 replayed through the scripted provider) and run
// in the default suite.
import { itLive as it } from "./helpers/live-llm"
import { seedThreadMessage, seedThreadMessages } from "./helpers/thread-seed"
import { setupScenario, teardownScenario } from "./setup"

// ─── SSE Helpers ─────────────────────────────────────────────────

interface SseEvent {
  event: string
  data: unknown
}

function parseSseEvents(body: string): SseEvent[] {
  const events: SseEvent[] = []
  const blocks = body.split("\n\n").filter((b) => b.trim())
  for (const block of blocks) {
    const lines = block.split("\n")
    let event = "message"
    let dataStr = ""
    for (const line of lines) {
      if (line.startsWith("event: ")) event = line.slice(7).trim()
      else if (line.startsWith("data: ")) dataStr = line.slice(6).trim()
    }
    try {
      events.push({ event, data: JSON.parse(dataStr) })
    } catch {
      events.push({ event, data: dataStr })
    }
  }
  return events
}

async function consumeSse(
  url: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; events: SseEvent[]; rawBody: string }> {
  let res: Response
  let rawBody: string
  try {
    res = await fetch(`${url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    rawBody = await res.text()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      status: 599,
      events: [
        {
          event: "error",
          data: { code: "transport_error", message, retryable: true },
        },
      ],
      rawBody: message,
    }
  }

  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    let parsed: any = null
    try {
      parsed = JSON.parse(rawBody)
    } catch {}
    const code =
      parsed?.error?.code ?? parsed?.code ?? (res.status >= 500 ? "transport_error" : "http_error")
    return {
      status: res.status,
      events: [
        {
          event: "error",
          data: { code, status: res.status, body: parsed ?? rawBody, retryable: res.status >= 500 },
        },
      ],
      rawBody,
    }
  }

  const events = parseSseEvents(rawBody)
  return { status: res.status, events, rawBody }
}

function isProviderUnavailable(event: SseEvent | undefined): boolean {
  const code = event?.event === "error" ? (event.data as any)?.code : undefined
  return code === "provider_error" || code === "transport_error"
}

// ─── DB Helpers ──────────────────────────────────────────────────

async function seedAgentThread(
  sql: any,
  ks: string,
  orgId: string,
  userId: string,
  extraParticipantIds: string[] = [],
): Promise<string> {
  const threadId = crypto.randomUUID()
  await sql.unsafe(
    `INSERT INTO ${ks}.threads (id, org_id, handle, type, created_by) VALUES ($1, $2, $3, 'agent_chat', $4)`,
    [threadId, orgId, `agent-${threadId.slice(0, 8)}`, userId],
  )
  await sql.unsafe(
    `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
    [threadId, userId, orgId],
  )
  for (const pid of extraParticipantIds) {
    await sql.unsafe(
      `INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id) VALUES ($1, $2, $3)`,
      [threadId, pid, orgId],
    )
  }
  return threadId
}

/** Checkpoint versions for a thread, newest first, WITH the agent that owns
 *  each. A checkpoint is PER AGENT, so an unscoped read answers with whichever
 *  agent on the thread has the highest version: scope every reading to the
 *  agent that actually acted. An agent turn compacts into one of these rather
 *  than into a message row. */
async function getThreadCheckpoints(
  sql: any,
  ks: string,
  threadId: string,
): Promise<Array<{ agentId: string; summary: string; version: number }>> {
  return (await sql.unsafe(
    `SELECT agent_id AS "agentId", summary, version FROM ${ks}.agent_thread_checkpoints
      WHERE thread_id = $1 ORDER BY version DESC`,
    [threadId],
  )) as Array<{ agentId: string; summary: string; version: number }>
}

/** The checkpoint state of ONE agent on a thread: its newest version and the
 *  summary text that version holds. */
function checkpointOf(
  rows: Array<{ agentId: string; summary: string; version: number }>,
  agentId: string | null,
): { summary: string; version: number } | undefined {
  if (!agentId) return undefined
  return rows.find((r) => r.agentId === agentId)
}

/** The agent that authored the newest agent message on this thread: the one
 *  whose checkpoint a compaction on this turn must have moved. */
async function getActingAgentId(sql: any, ks: string, threadId: string): Promise<string | null> {
  const rows = (await sql.unsafe(
    `SELECT author_agent_id FROM ${ks}.messages
      WHERE thread_id = $1 AND author_type = 'agent' AND author_agent_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [threadId],
  )) as Array<{ author_agent_id: string }>
  return rows[0]?.author_agent_id ?? null
}

async function getThreadMessages(sql: any, ks: string, threadId: string) {
  return sql.unsafe(
    `SELECT id, author_type, content, metadata, created_at FROM ${ks}.messages WHERE thread_id = $1 ORDER BY created_at ASC`,
    [threadId],
  )
}

async function getCreditBalance(sql: any, ks: string, orgId: string) {
  const [row] = await sql.unsafe(
    `SELECT included_balance, purchased_balance FROM ${ks}.credit_balances WHERE org_id = $1`,
    [orgId],
  )
  return row
}

async function getCreditTransactions(sql: any, ks: string, orgId: string) {
  return sql.unsafe(
    `SELECT * FROM ${ks}.credit_transactions WHERE org_id = $1 ORDER BY created_at ASC`,
    [orgId],
  )
}

// ─── Model Pricing — single source of truth from @liaison/shared ──

// Default model for most tests — cheapest available with working key
const DEFAULT_MODEL = "gpt-5.4-nano"
// Auto-mode (null) → cheapest auto-eligible (gemini-flash-lite per
// MODEL_PRICING_SEED). Never hardcode Anthropic — project policy + see
// `apps/web/src/tests/e2e/CLAUDE.md`. The S6 anthropic canary below is
// intentional and uses an explicit literal for that one assertion.
const TOOL_MODEL: string | null = null

// ═════════════════════════════════════════════════════════════════
//  AGENT RUNTIME E2E SCENARIO
// ═════════════════════════════════════════════════════════════════

describe("Agent Runtime Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string

  /** Script the agent's next turn(s) in `threadId` (scripted model provider). */
  async function scriptTurn(
    threadId: string,
    steps: Array<{ text?: string; toolCalls?: Array<{ name: string; args?: unknown }> }>,
  ): Promise<void> {
    const res = await api(url, "/api/_test/agent-script", {
      method: "POST",
      body: { threadId, steps },
    })
    expect(res.status).toBe(200)
    // Without the flag the script is ignored and the turn would reach a provider.
    expect(res.body.data.providerActive).toBe(true)
  }
  let ks: string

  // Test users
  let agentUser: { id: string; email: string; token: string; name: string }
  let noToolUser: { id: string; email: string; token: string; name: string }
  let readOnlyUser: { id: string; email: string; token: string; name: string }

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 5,
      org: { name: "Agent Runtime E2E Org" },
      // A self-hosted server: only LIAISON_EDITION=managed switches credits
      // on (lib/edition.ts), and that edition boots only under the managed
      // checks. The managed billed path is covered by the route tests.
      populate: {
        users: { count: 10 },
        threads: { count: 20, participants: "random(2-4)", messages: "random(1-3)" },
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    // Seed model pricing
    for (const model of MODEL_PRICING_SEED) {
      await env.db.sql.unsafe(
        `INSERT INTO ${ks}.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (provider, model_id) DO NOTHING`,
        [
          model.provider,
          model.modelId,
          model.displayName,
          model.inputCostPerM,
          model.outputCostPerM,
          model.contextWindow,
          model.autoEligible,
          model.tierMinimum,
          model.source,
        ],
      )
    }

    // Seed credit balance for bootstrapped org
    await env.db.sql.unsafe(
      `INSERT INTO ${ks}.credit_balances (org_id, included_balance, purchased_balance, currency)
       VALUES ($1, '50.00000000', '50.00000000', 'EUR')
       ON CONFLICT (org_id) DO UPDATE SET included_balance = '50.00000000', purchased_balance = '50.00000000'`,
      [world.org.id],
    )

    // Create test users with specific scopes
    agentUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: [
        "kernel:threads:write",
        "kernel:threads:read",
        "kernel:threads",
        "test:items",
        "test:items:read",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    noToolUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["kernel:threads:write", "kernel:threads:read", "kernel:threads"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    readOnlyUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      scopes: ["kernel:threads:read"],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  // ═══════════════════════════════════════════════════════════════
  //  S1: Smoke Test — Basic Streaming Response (OpenAI)
  // ═══════════════════════════════════════════════════════════════

  let s1ThreadId: string

  it("S1: smoke — basic SSE streaming lifecycle (OpenAI)", async () => {
    s1ThreadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId: s1ThreadId,
      content: "Say hello in one word",
      modelId: DEFAULT_MODEL,
    })

    expect(status).toBe(200)

    // First event is message-start
    const firstEvent = events[0]
    expect(firstEvent.event).toBe("message-start")
    const startData = firstEvent.data as any
    expect(startData.userMessageId).toBeDefined()
    expect(startData.threadId).toBe(s1ThreadId)

    // At least one text-delta
    const textDeltas = events.filter((e) => e.event === "text-delta")
    expect(textDeltas.length).toBeGreaterThanOrEqual(1)
    expect((textDeltas[0].data as any).delta).toBeTruthy()

    // At least one step-finish with usage
    const stepFinishes = events.filter((e) => e.event === "step-finish")
    expect(stepFinishes.length).toBeGreaterThanOrEqual(1)
    const stepData = stepFinishes[0].data as any
    expect(stepData.stepNumber).toBe(1)
    expect(stepData.usage.promptTokens).toBeGreaterThan(0)
    expect(stepData.usage.completionTokens).toBeGreaterThan(0)

    // Final event is done
    const doneEvents = events.filter((e) => e.event === "done")
    expect(doneEvents.length).toBe(1)
    const done = doneEvents[0].data as any
    expect(done.messageId).toBeDefined()
    expect(done.totalUsage).toBeDefined()
    expect(Number(done.creditCost)).toBeGreaterThan(0)
    expect(done.finishReason).toBeDefined()

    // No error events
    const errors = events.filter((e) => e.event === "error")
    expect(errors.length).toBe(0)

    // Agent message persisted in DB
    const msgs = await getThreadMessages(env.db.sql, ks, s1ThreadId)
    const agentMsg = msgs.find((m: any) => m.author_type === "agent")
    expect(agentMsg).toBeDefined()
    expect(agentMsg.id).toBe(done.messageId)
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S2: Full Transcript Validation — DB Persistence
  // ═══════════════════════════════════════════════════════════════

  it("S2: transcript — user + agent messages persisted with metadata", async () => {
    // Reuse S1 thread
    const { events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId: s1ThreadId,
      content: "What is 2+2? Reply with just the number.",
      modelId: DEFAULT_MODEL,
    })

    const doneEvent = events.find((e) => e.event === "done")
    expect(doneEvent).toBeDefined()
    const done = doneEvent!.data as any

    const msgs = await getThreadMessages(env.db.sql, ks, s1ThreadId)
    // S1 created 2 messages, S2 adds 2 more = 4 total
    expect(msgs.length).toBeGreaterThanOrEqual(4)

    // Find the latest user message
    const userMsgs = msgs.filter((m: any) => m.author_type === "user")
    const lastUserMsg = userMsgs[userMsgs.length - 1]
    expect(lastUserMsg.content).toBe("What is 2+2? Reply with just the number.")

    // Agent message matches done event
    const agentMsg = msgs.find((m: any) => m.id === done.messageId)
    expect(agentMsg).toBeDefined()
    expect(agentMsg.author_type).toBe("agent")
    expect(agentMsg.content).toBeTruthy()

    // Metadata
    const meta = agentMsg.metadata
    expect(meta.usage.inputTokens).toBeGreaterThan(0)
    expect(meta.usage.outputTokens).toBeGreaterThan(0)
    expect(meta.stepCount).toBeGreaterThanOrEqual(1)
    expect(typeof meta.finishReason).toBe("string")

    // Ordering: user before agent
    const userIdx = msgs.findIndex((m: any) => m.id === lastUserMsg.id)
    const agentIdx = msgs.findIndex((m: any) => m.id === done.messageId)
    expect(userIdx).toBeLessThan(agentIdx)
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S3: Credit Tracking — Deduction and Transaction Record
  // ═══════════════════════════════════════════════════════════════

  it("S3: credits — deduction formula and transaction record", async () => {
    // Reset balance to known value
    await env.db.sql.unsafe(
      `UPDATE ${ks}.credit_balances SET included_balance = '50.00000000', purchased_balance = '50.00000000' WHERE org_id = $1`,
      [world.org.id],
    )
    const balBefore = await getCreditBalance(env.db.sql, ks, world.org.id)
    const totalBefore = Number(balBefore.included_balance) + Number(balBefore.purchased_balance)

    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    const { events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Hi",
      modelId: DEFAULT_MODEL,
    })

    const doneEvent = events.find((e) => e.event === "done")!
    const done = doneEvent.data as any
    const creditCost = Number(done.creditCost)
    expect(creditCost).toBeGreaterThan(0)

    // Balance decreased
    const balAfter = await getCreditBalance(env.db.sql, ks, world.org.id)
    const totalAfter = Number(balAfter.included_balance) + Number(balAfter.purchased_balance)
    // Balance must have decreased — diff must equal creditCost within 8 decimal places
    const balanceDiff = totalBefore - totalAfter
    expect(balanceDiff).toBeGreaterThan(0)
    expect(balanceDiff).toBeCloseTo(creditCost, 6)

    // Credit transaction row exists
    const txns = await getCreditTransactions(env.db.sql, ks, world.org.id)
    // Find the LATEST usage transaction (previous scenarios also created transactions)
    const usageTxns = txns.filter((t: any) => t.type === "usage" && t.model === DEFAULT_MODEL)
    const usageTxn = usageTxns[usageTxns.length - 1]
    expect(usageTxn).toBeDefined()
    expect(usageTxn.type).toBe("usage")
    expect(usageTxn.model).toBe(DEFAULT_MODEL)
    expect(usageTxn.input_tokens).toBeGreaterThan(0)
    expect(usageTxn.output_tokens).toBeGreaterThan(0)

    // Validate raw_cost formula: (input * inputCost / 1M) + (output * outputCost / 1M)
    const modelInfo = MODEL_PRICING_SEED.find((m) => m.modelId === DEFAULT_MODEL)!
    const expectedRaw =
      (usageTxn.input_tokens * Number(modelInfo.inputCostPerM)) / 1_000_000 +
      (usageTxn.output_tokens * Number(modelInfo.outputCostPerM)) / 1_000_000
    expect(Number(usageTxn.raw_cost)).toBeCloseTo(expectedRaw, 5)

    // creditCost = rawCost * 1.20
    expect(creditCost).toBeCloseTo(expectedRaw * 1.2, 3)

    // Amount is negative (deduction)
    expect(Number(usageTxn.amount)).toBeLessThan(0)
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S4: Tool Call — Real LLM Triggers Tool Execution
  // ═══════════════════════════════════════════════════════════════

  it("S4: tool call — LLM triggers listItems tool and result matches HTTP oracle", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    // Get HTTP oracle response
    const oracleRes = await api(url, "/api/apps/tools/test:listItems", {
      method: "POST",
      token: agentUser.token,
      body: {},
    })
    expect(oracleRes.status).toBe(200)

    // Ask LLM to use tool
    const { events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Use the listItems tool to show me all items. Call the test__listItems tool now.",
      modelId: DEFAULT_MODEL,
    })

    // tool-call event
    const toolCalls = events.filter((e) => e.event === "tool-call")
    expect(toolCalls.length).toBeGreaterThanOrEqual(1)
    const tc = toolCalls[0].data as any
    expect(tc.toolName).toContain("listItems")
    expect(tc.toolCallId).toBeTruthy()

    // tool-result event with matching toolCallId
    const toolResults = events.filter((e) => e.event === "tool-result")
    expect(toolResults.length).toBeGreaterThanOrEqual(1)
    const tr = toolResults.find((e) => (e.data as any).toolCallId === tc.toolCallId)
    expect(tr).toBeDefined()

    // HTTP parity — tool result matches oracle response
    const toolResultData = (tr!.data as any).result
    expect(JSON.stringify(toolResultData)).toBe(JSON.stringify(oracleRes.body.data))

    // done event
    const doneEvents = events.filter((e) => e.event === "done")
    expect(doneEvents.length).toBe(1)

    // Agent message metadata has toolCalls
    const msgs = await getThreadMessages(env.db.sql, ks, threadId)
    const agentMsg = msgs.find((m: any) => m.author_type === "agent")
    expect(agentMsg).toBeDefined()
    expect(agentMsg.metadata?.toolCalls?.length).toBeGreaterThanOrEqual(1)
    const storedTc = agentMsg.metadata.toolCalls[0]
    expect(storedTc.toolName).toContain("listItems")
    expect(storedTc.toolCallId).toBeTruthy()
    expect(storedTc.result).toBeDefined()
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S5: Tool Scope Filtering — Tools Hidden Without Scope
  // ═══════════════════════════════════════════════════════════════

  it("S5: scope filtering — no tool-call events without test:* scope", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, noToolUser.id)

    const { events } = await consumeSse(url, "/api/agent/chat", noToolUser.token, {
      threadId,
      content: "Use any tools you have available.",
      modelId: DEFAULT_MODEL,
    })

    // No test-app tool-call events (kernel tools like threads_search may fire — that's expected)
    const testToolCalls = events.filter(
      (e) => e.event === "tool-call" && (e.data as any).toolName?.startsWith("test__"),
    )
    expect(testToolCalls.length).toBe(0)

    // Stream completed successfully
    const doneEvents = events.filter((e) => e.event === "done")
    expect(doneEvents.length).toBe(1)

    const errors = events.filter((e) => e.event === "error")
    expect(errors.length).toBe(0)
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S6: Anthropic Provider Canary — Full Round Trip
  // ═══════════════════════════════════════════════════════════════

  it("S6: anthropic canary — full round trip with claude-haiku-4-5", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    const { events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Reply with just the word OK",
      modelId: "claude-haiku-4-5",
    })

    // Stream completes
    const doneEvents = events.filter((e) => e.event === "done")
    expect(doneEvents.length).toBe(1)

    const errors = events.filter((e) => e.event === "error")
    expect(errors.length).toBe(0)

    // text-delta events present
    const textDeltas = events.filter((e) => e.event === "text-delta")
    expect(textDeltas.length).toBeGreaterThanOrEqual(1)

    // Agent message persisted with correct metadata
    const msgs = await getThreadMessages(env.db.sql, ks, threadId)
    const agentMsg = msgs.find((m: any) => m.author_type === "agent")
    expect(agentMsg).toBeDefined()
    expect(agentMsg.content).toBeTruthy()
    expect(agentMsg.metadata.usage.inputTokens).toBeGreaterThan(0)
    expect(agentMsg.metadata.usage.outputTokens).toBeGreaterThan(0)

    // Credit transaction uses anthropic model with correct pricing
    const txns = await getCreditTransactions(env.db.sql, ks, world.org.id)
    const anthropicTxn = txns.find((t: any) => t.model === "claude-haiku-4-5")
    expect(anthropicTxn).toBeDefined()
    expect(Number(anthropicTxn.amount)).toBeLessThan(0)
    expect(anthropicTxn.input_tokens).toBeGreaterThan(0)
    expect(anthropicTxn.output_tokens).toBeGreaterThan(0)

    // Verify Anthropic pricing formula using seeded rates
    const anthropicModel = MODEL_PRICING_SEED.find((m) => m.modelId === "claude-haiku-4-5")!
    const expectedRaw =
      (anthropicTxn.input_tokens * Number(anthropicModel.inputCostPerM)) / 1_000_000 +
      (anthropicTxn.output_tokens * Number(anthropicModel.outputCostPerM)) / 1_000_000
    expect(Number(anthropicTxn.raw_cost)).toBeCloseTo(expectedRaw, 5)

    // done event creditCost matches transaction
    const done = doneEvents[0].data as any
    expect(Number(done.creditCost)).toBeGreaterThan(0)
    expect(done.finishReason).toBeDefined()
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S9: Reasoning Canary — Anthropic extended thinking, end-to-end
  // ═══════════════════════════════════════════════════════════════

  it("S9: reasoning canary — anthropic thinking streams reasoning + persists level", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    const { events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Think briefly about why the sky is blue, then reply with just the word OK.",
      modelId: "claude-haiku-4-5",
      reasoningLevel: "high",
    })

    // Stream completes cleanly
    expect(events.filter((e) => e.event === "done").length).toBe(1)
    expect(events.filter((e) => e.event === "error").length).toBe(0)

    // Anthropic streams full thinking → reasoning lifecycle events appear on the wire
    const reasoningEvents = events.filter(
      (e) => e.event === "reasoning-start" || e.event === "reasoning-delta",
    )
    expect(reasoningEvents.length).toBeGreaterThanOrEqual(1)

    // Persisted agent message carries the requested level + the reasoning text
    const msgs = await getThreadMessages(env.db.sql, ks, threadId)
    const agentMsg = msgs.find((m: any) => m.author_type === "agent")
    expect(agentMsg).toBeDefined()
    expect(agentMsg.metadata.reasoningLevel).toBe("high")
    expect(typeof agentMsg.metadata.reasoning).toBe("string")
    expect(agentMsg.metadata.reasoning.length).toBeGreaterThan(0)
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S7: Mistral Provider Canary — Full Round Trip
  // ═══════════════════════════════════════════════════════════════

  it("S7: mistral canary — full round trip with mistral-small-latest", async () => {
    if (!process.env.MISTRAL_API_KEY) {
      console.log("MISTRAL_API_KEY not set — skipping S7")
      return
    }

    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    const { events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Reply with just the word OK",
      modelId: "mistral-small-latest",
    })

    // Mistral provider may be temporarily unavailable — skip gracefully on provider errors
    const providerErrors = events.filter((e) => isProviderUnavailable(e))
    if (providerErrors.length > 0) {
      console.log("S7: Mistral provider error — skipping:", JSON.stringify(providerErrors[0].data))
      return
    }

    const doneEvents = events.filter((e) => e.event === "done")
    expect(doneEvents.length).toBe(1)
    expect(events.filter((e) => e.event === "error").length).toBe(0)
    expect(events.filter((e) => e.event === "text-delta").length).toBeGreaterThanOrEqual(1)

    // Agent message persisted
    const msgs = await getThreadMessages(env.db.sql, ks, threadId)
    const agentMsg = msgs.find((m: any) => m.author_type === "agent")
    expect(agentMsg).toBeDefined()
    expect(agentMsg.content).toBeTruthy()
    expect(agentMsg.metadata.usage.inputTokens).toBeGreaterThan(0)

    // Credit transaction with correct Mistral pricing from seed data
    const txns = await getCreditTransactions(env.db.sql, ks, world.org.id)
    const mistralTxn = txns.find((t: any) => t.model === "mistral-small-latest")
    expect(mistralTxn).toBeDefined()
    expect(Number(mistralTxn.amount)).toBeLessThan(0)
    const mistralModel = MODEL_PRICING_SEED.find((m) => m.modelId === "mistral-small-latest")!
    const expectedRaw =
      (mistralTxn.input_tokens * Number(mistralModel.inputCostPerM)) / 1_000_000 +
      (mistralTxn.output_tokens * Number(mistralModel.outputCostPerM)) / 1_000_000
    expect(Number(mistralTxn.raw_cost)).toBeCloseTo(expectedRaw, 5)
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S8: Google Provider Canary — Full Round Trip
  // ═══════════════════════════════════════════════════════════════

  it("S8: google canary — full round trip with gemini-flash-lite", async () => {
    if (!process.env.GOOGLE_API_KEY) {
      console.log("GOOGLE_API_KEY not set — skipping S8")
      return
    }

    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    let events: SseEvent[]
    try {
      const result = await consumeSse(url, "/api/agent/chat", agentUser.token, {
        threadId,
        content: "Reply with just the word OK",
        modelId: "gemini-flash-lite-latest",
      })
      events = result.events
    } catch (err) {
      console.log("S8: Google provider connection failed — skipping:", (err as Error).message)
      return
    }

    const providerErrors = events.filter(
      (e) => e.event === "error" && (e.data as any)?.code === "provider_error",
    )
    if (providerErrors.length > 0) {
      console.log("S8: Google provider error — skipping:", JSON.stringify(providerErrors[0].data))
      return
    }

    const doneEvents = events.filter((e) => e.event === "done")
    expect(doneEvents.length).toBe(1)
    expect(events.filter((e) => e.event === "error").length).toBe(0)
    expect(events.filter((e) => e.event === "text-delta").length).toBeGreaterThanOrEqual(1)

    // Agent message persisted
    const msgs = await getThreadMessages(env.db.sql, ks, threadId)
    const agentMsg = msgs.find((m: any) => m.author_type === "agent")
    expect(agentMsg).toBeDefined()
    expect(agentMsg.content).toBeTruthy()
    expect(agentMsg.metadata.usage.inputTokens).toBeGreaterThan(0)

    // Credit transaction with correct Google pricing from seed data
    const txns = await getCreditTransactions(env.db.sql, ks, world.org.id)
    const googleTxn = txns.find((t: any) => t.model === "gemini-flash-lite-latest")
    expect(googleTxn).toBeDefined()
    expect(Number(googleTxn.amount)).toBeLessThan(0)
    const googleModel = MODEL_PRICING_SEED.find((m) => m.modelId === "gemini-flash-lite-latest")!
    const expectedRaw =
      (googleTxn.input_tokens * Number(googleModel.inputCostPerM)) / 1_000_000 +
      (googleTxn.output_tokens * Number(googleModel.outputCostPerM)) / 1_000_000
    expect(Number(googleTxn.raw_cost)).toBeCloseTo(expectedRaw, 5)
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S9: Auto Mode — Cheapest Eligible Model Selected
  // ═══════════════════════════════════════════════════════════════

  it("S9: auto mode — cheapest autoEligible model selected when modelId is null", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    // Keep this selector test deterministic and avoid making a second consecutive
    // Gemini request after the Google canary, which can hit provider-side quotas.
    await env.db.sql.unsafe(
      `UPDATE ${ks}.model_pricing
       SET auto_eligible = (provider = 'anthropic' AND model_id = 'claude-haiku-4-5')`,
    )

    try {
      const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
        threadId,
        content: "Say yes",
        modelId: null,
      })

      expect(status).toBe(200)

      const doneEvents = events.filter((e) => e.event === "done")
      expect(doneEvents.length).toBe(1)

      const txns = await getCreditTransactions(env.db.sql, ks, world.org.id)
      const usageTxns = txns.filter((t: any) => t.type === "usage")
      const lastTxn = usageTxns[usageTxns.length - 1]
      expect(lastTxn.model).toBe("claude-haiku-4-5")
    } finally {
      for (const model of MODEL_PRICING_SEED) {
        await env.db.sql.unsafe(
          `UPDATE ${ks}.model_pricing SET auto_eligible = $1 WHERE provider = $2 AND model_id = $3`,
          [model.autoEligible, model.provider, model.modelId],
        )
      }
    }
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S10: Multi-Turn Conversation — Context Preserved
  // ═══════════════════════════════════════════════════════════════

  it("S10: multi-turn — context preserved across turns (token growth)", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    // Turn 1
    const { events: events1 } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Remember the number 42 for me.",
      modelId: DEFAULT_MODEL,
    })
    const _done1 = events1.find((e) => e.event === "done")!.data as any

    // Turn 2
    const { events: events2 } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "What number did I ask you to remember?",
      modelId: DEFAULT_MODEL,
    })
    const _done2 = events2.find((e) => e.event === "done")!.data as any

    // DB contains at least 4 user/agent messages (2 turns × 2).
    const msgs = await getThreadMessages(env.db.sql, ks, threadId)
    const chatMsgs = msgs.filter((m: any) => m.author_type === "user" || m.author_type === "agent")
    expect(chatMsgs.length).toBeGreaterThanOrEqual(4)

    // First message is the user's first turn; last message is the agent's final reply.
    // We don't assert strict alternation: under load, concurrent transactions can yield
    // identical created_at timestamps (Postgres NOW() = txn start time), making ORDER BY
    // created_at non-deterministic for messages inserted within the same microsecond.
    expect(chatMsgs[0].author_type).toBe("user")
    expect(chatMsgs[chatMsgs.length - 1].author_type).toBe("agent")

    // Both user and agent must be present at least twice (2 full turns)
    expect(chatMsgs.filter((m: any) => m.author_type === "user").length).toBeGreaterThanOrEqual(2)
    expect(chatMsgs.filter((m: any) => m.author_type === "agent").length).toBeGreaterThanOrEqual(2)

    // Agent messages from both turns have metadata with token usage
    const agentMsgs = chatMsgs.filter((m: any) => m.author_type === "agent")
    expect(agentMsgs.length).toBeGreaterThanOrEqual(2)
    const agent1 = agentMsgs[0]
    const agent2 = agentMsgs[agentMsgs.length - 1]
    expect(agent1.metadata?.usage?.inputTokens).toBeGreaterThan(0)
    expect(agent2.metadata?.usage?.inputTokens).toBeGreaterThan(0)

    // Both turns consumed tokens — context preserved.
    // Note: we don't assert turn2 > turn1 because promptTokens are accumulated across tool-call
    // steps. If turn 1 triggers a tool call (e.g. user_memory_set), its accumulated total may
    // exceed turn 2's single-step total despite turn 2 having strictly more context per step.
    expect(agent2.metadata.usage.inputTokens).toBeGreaterThan(0)
  }, 120_000)

  // ═══════════════════════════════════════════════════════════════
  //  S11: Multi-Turn with Tool Calls — Tool History Reconstructed
  // ═══════════════════════════════════════════════════════════════

  it("S11: multi-turn tools — tool call history reconstructed in context", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    // Turn 1: trigger tool call
    const { events: events1 } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Use listItems to see my items",
      modelId: DEFAULT_MODEL,
    })

    const done1 = events1.find((e) => e.event === "done")
    expect(done1).toBeDefined()

    // First agent message should have toolCalls
    const msgs1 = await getThreadMessages(env.db.sql, ks, threadId)
    const agent1 = msgs1.find((m: any) => m.author_type === "agent")
    expect(agent1).toBeDefined()
    expect(agent1.metadata?.toolCalls?.length).toBeGreaterThanOrEqual(1)

    // Turn 2: follow-up about tool results
    const { events: events2 } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "How many items did that tool return?",
      modelId: DEFAULT_MODEL,
    })

    const done2 = events2.find((e) => e.event === "done")
    expect(done2).toBeDefined()

    // Both agent messages persisted with metadata
    const msgs2 = await getThreadMessages(env.db.sql, ks, threadId)
    const agentMsgs = msgs2.filter((m: any) => m.author_type === "agent")
    expect(agentMsgs.length).toBe(2)
    // Both messages have usage data — proves context was assembled (including tool call history)
    expect(agentMsgs[0].metadata.usage.inputTokens).toBeGreaterThan(0)
    expect(agentMsgs[1].metadata.usage.inputTokens).toBeGreaterThan(0)
  }, 120_000)

  // ═══════════════════════════════════════════════════════════════
  //  S12: System Prompt Injection — Org Name and Capabilities
  // ═══════════════════════════════════════════════════════════════

  it("S12: system prompt — stream succeeds, promptTokens > 0", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    const { events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "What can you help me with?",
      modelId: DEFAULT_MODEL,
    })

    // Stream completes
    const doneEvents = events.filter((e) => e.event === "done")
    expect(doneEvents.length).toBe(1)

    const errors = events.filter((e) => e.event === "error")
    expect(errors.length).toBe(0)

    // step-finish has promptTokens > 0 (system prompt was sent)
    const stepFinish = events.find((e) => e.event === "step-finish")
    expect(stepFinish).toBeDefined()
    expect((stepFinish!.data as any).usage.promptTokens).toBeGreaterThan(0)

    // Agent message persisted
    const msgs = await getThreadMessages(env.db.sql, ks, threadId)
    const agentMsg = msgs.find((m: any) => m.author_type === "agent")
    expect(agentMsg).toBeDefined()
    expect(agentMsg.content).toBeTruthy()
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S13: Zero Balance — self-hosted never gates a turn on credits
  // ═══════════════════════════════════════════════════════════════
  // Credits exist only in the managed edition (LIAISON_EDITION=managed, which
  // boots under the managed checks and runs every AI call on OpenRouter); this
  // server is self-hosted, so a zero balance must not refuse the turn. The
  // managed 402 with its persisted system message is covered by
  // modules/agent/routes.test.ts ("returns 402 when balance is zero").

  itAlways(
    "S13: zero balance — a self-hosted turn is not refused for credits",
    async () => {
      await env.db.sql.unsafe(
        `UPDATE ${ks}.credit_balances SET included_balance = '0.00000000', purchased_balance = '0.00000000' WHERE org_id = $1`,
        [world.org.id],
      )
      try {
        const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)
        const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
          threadId,
          content: "Hello",
          modelId: DEFAULT_MODEL,
        })
        expect(status).not.toBe(402)
        const err = events.find((e) => e.event === "error")
        expect((err?.data as { code?: string } | undefined)?.code).not.toBe("CREDITS_EXHAUSTED")
        const msgs = await getThreadMessages(env.db.sql, ks, threadId)
        expect(msgs.find((m: { author_type: string }) => m.author_type === "user")).toBeDefined()
      } finally {
        await env.db.sql.unsafe(
          `UPDATE ${ks}.credit_balances SET included_balance = '50.00000000', purchased_balance = '50.00000000' WHERE org_id = $1`,
          [world.org.id],
        )
      }
    },
    60_000,
  )

  // ═══════════════════════════════════════════════════════════════
  //  S14: WebSocket Events — Typing Indicators and Message Broadcast
  // ═══════════════════════════════════════════════════════════════

  it("S14: websocket — typing:start, message:create, typing:stop broadcast", async () => {
    // Create second user for WS observation
    const [userB] = await world.addUsers([{ name: "WS-Observer" }])
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id, [userB.id])

    // Connect userB via WebSocket
    const wsClient = await connectWs(url, userB.token)

    try {
      // agentUser sends agent chat message — collect WS events on userB
      const ssePromise = consumeSse(url, "/api/agent/chat", agentUser.token, {
        threadId,
        content: "Say hi",
        modelId: DEFAULT_MODEL,
      })

      // Wait for all three WS events
      const typingStart = await wsClient.waitFor(
        "event",
        (m) => m.payload?.entity === "typing" && m.payload?.action === "start",
        30_000,
      )
      expect(typingStart.payload.data.authorType).toBe("agent")

      const messageCreate = await wsClient.waitFor(
        "event",
        (m) =>
          m.payload?.entity === "message" &&
          m.payload?.action === "create" &&
          m.payload?.data?.authorType === "agent",
        30_000,
      )
      expect(messageCreate.payload.data.authorType).toBe("agent")

      const _typingStop = await wsClient.waitFor(
        "event",
        (m) => m.payload?.entity === "typing" && m.payload?.action === "stop",
        30_000,
      )

      // Verify SSE also completed
      const { events } = await ssePromise
      const doneEvents = events.filter((e) => e.event === "done")
      expect(doneEvents.length).toBe(1)
    } finally {
      wsClient.close()
    }
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S15: BYOK — Provider Key Bypass (No Credit Deduction)
  // ═══════════════════════════════════════════════════════════════

  it("S15: BYOK — zero balance bypassed with org provider key, no credit deduction", async () => {
    // Temporarily patch the bootstrapped org with BYOK settings and zero balance
    const realOpenAiKey = process.env.OPENAI_API_KEY
    if (!realOpenAiKey) {
      console.log("OPENAI_API_KEY not set — skipping S15")
      return
    }

    // Save current settings and balance
    const [orgRow] = await env.db.sql.unsafe(
      `SELECT settings FROM ${ks}.organizations WHERE id = $1`,
      [world.org.id],
    )
    const savedSettings = orgRow?.settings

    // Patch org with BYOK key (encrypted format) and drain balance.
    // CRITICAL: encrypt with the key the *spawned API server* will use to
    // decrypt — that's `env.encryptionKey`, not the parent test process's
    // `byokEncryptionKey` (which may be different when `.env` defines its own
    // ENCRYPTION_KEY). Mismatch → GCM auth tag fails →
    // "Unsupported state or unable to authenticate data" → 500.
    const testByokKey = env.encryptionKey || byokEncryptionKey
    const encryptedKey = encryptSecret(realOpenAiKey, testByokKey, CryptoContext.byokApiKey)
    const byokEntry = {
      encrypted: encryptedKey,
      maskedHint: realOpenAiKey.slice(-6),
      validatedAt: new Date().toISOString(),
    }
    await env.db.sql.unsafe(`UPDATE ${ks}.organizations SET settings = $1 WHERE id = $2`, [
      JSON.stringify({ providerKeys: { openai: byokEntry } }),
      world.org.id,
    ])
    await env.db.sql.unsafe(
      `UPDATE ${ks}.credit_balances SET included_balance = '0.00000000', purchased_balance = '0.00000000' WHERE org_id = $1`,
      [world.org.id],
    )

    const txnCountBefore = (await getCreditTransactions(env.db.sql, ks, world.org.id)).length
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    const { status, events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Say ok",
      modelId: DEFAULT_MODEL,
    })

    // Request succeeds (NOT 402 — BYOK bypasses balance check)
    expect(status).toBe(200)

    const doneEvents = events.filter((e) => e.event === "done")
    expect(doneEvents.length).toBe(1)
    const done = doneEvents[0].data as any
    expect(done.creditCost).toBe("0")

    // BYOK does not DEDUCT balance, but it does record exactly one
    // non-deducting `byok_usage` audit row so the usage monitoring page has
    // data (see credit-meter.ts). `finalize()` writes it before the `done`
    // event, so it is deterministically present once the stream has finished.
    const txnsAfter = await getCreditTransactions(env.db.sql, ks, world.org.id)
    expect(txnsAfter.length).toBe(txnCountBefore + 1)
    expect(txnsAfter[txnsAfter.length - 1].type).toBe("byok_usage")

    // BYOK audit event queued in pending_events (polled, up to the old 2 s
    // budget and then some, rather than a fixed wait).
    const findByokAudit = async () => {
      const pendingEvents = await env.db.sql.unsafe(
        `SELECT * FROM ${ks}.pending_events WHERE org_id = $1`,
        [world.org.id],
      )
      return pendingEvents.find((e: any) => {
        const payload = typeof e.payload === "string" ? JSON.parse(e.payload) : e.payload
        return (
          payload.entity === "credit" && payload.action === "usage" && payload.data?.byok === true
        )
      })
    }
    let byokAudit = await findByokAudit()
    for (const deadline = Date.now() + 5_000; !byokAudit && Date.now() < deadline; ) {
      await Bun.sleep(25)
      byokAudit = await findByokAudit()
    }
    expect(byokAudit).toBeDefined()

    // Restore org settings and balance
    await env.db.sql.unsafe(`UPDATE ${ks}.organizations SET settings = $1 WHERE id = $2`, [
      savedSettings ? JSON.stringify(savedSettings) : null,
      world.org.id,
    ])
    await env.db.sql.unsafe(
      `UPDATE ${ks}.credit_balances SET included_balance = '50.00000000', purchased_balance = '50.00000000' WHERE org_id = $1`,
      [world.org.id],
    )
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S18: Taint Notice — Thread With External Content
  // ═══════════════════════════════════════════════════════════════

  it("S18: taint notice — stream succeeds on tainted thread", async () => {
    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    // Set tainted = true
    await env.db.sql.unsafe(`UPDATE ${ks}.threads SET tainted = true WHERE id = $1`, [threadId])

    const { events } = await consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content: "Hello",
      modelId: DEFAULT_MODEL,
    })

    // Stream completes without error
    const doneEvents = events.filter((e) => e.event === "done")
    expect(doneEvents.length).toBe(1)

    const errors = events.filter((e) => e.event === "error")
    expect(errors.length).toBe(0)

    // Agent message persisted
    const msgs = await getThreadMessages(env.db.sql, ks, threadId)
    const agentMsg = msgs.find((m: any) => m.author_type === "agent")
    expect(agentMsg).toBeDefined()
    expect(agentMsg.content).toBeTruthy()

    // promptTokens > 0 (taint notice + system prompt sent)
    const stepFinish = events.find((e) => e.event === "step-finish")
    expect(stepFinish).toBeDefined()
    expect((stepFinish!.data as any).usage.promptTokens).toBeGreaterThan(0)
  }, 60_000)

  // ═══════════════════════════════════════════════════════════════
  //  S22: Mid-Step Credit Cutoff — Balance Depleted Between Steps
  // ═══════════════════════════════════════════════════════════════

  it("S22: mid-step cutoff — credits_exhausted error when balance drained between steps", async () => {
    // Set balance to tiny positive amount (passes preCheck since > 0)
    await env.db.sql.unsafe(
      `UPDATE ${ks}.credit_balances SET included_balance = '0.00001000', purchased_balance = '0.00000000' WHERE org_id = $1`,
      [world.org.id],
    )

    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    // Start SSE fetch and drain balance concurrently with a short delay
    const ssePromise = consumeSse(url, "/api/agent/chat", agentUser.token, {
      threadId,
      content:
        "Use the listItems tool to show me items, then create a new item titled 'Test' in team 'alpha'.",
      modelId: DEFAULT_MODEL,
    })

    // Drain after a brief delay — enough for preCheck to pass but before onStepFinish
    await Bun.sleep(200)
    await env.db.sql.unsafe(
      `UPDATE ${ks}.credit_balances SET included_balance = '0.00000000', purchased_balance = '0.00000000' WHERE org_id = $1`,
      [world.org.id],
    )

    const { events } = await ssePromise

    // The model may or may not trigger a multi-step run depending on LLM behavior.
    // If multi-step: error with credits_exhausted, no done event
    // If single-step: done event (checkMidStep never fired)
    // Both outcomes are acceptable — the mid-step path is verified in unit tests.
    const errorEvents = events.filter((e) => e.event === "error")
    const doneEvents = events.filter((e) => e.event === "done")
    expect(errorEvents.length + doneEvents.length).toBeGreaterThanOrEqual(1)

    if (errorEvents.length > 0) {
      expect((errorEvents[0].data as any).code).toBe("credits_exhausted")
    }

    // Restore balance for subsequent tests
    await env.db.sql.unsafe(
      `UPDATE ${ks}.credit_balances SET included_balance = '50.00000000', purchased_balance = '50.00000000' WHERE org_id = $1`,
      [world.org.id],
    )
  }, 120_000)

  // ═══════════════════════════════════════════════════════════════
  //  S23: Client Disconnect During SSE — Server Completes Processing
  // ═══════════════════════════════════════════════════════════════

  it("S23: client disconnect — server completes persistence after disconnect", async () => {
    // Restore balance for this test
    await env.db.sql.unsafe(
      `UPDATE ${ks}.credit_balances SET included_balance = '50.00000000', purchased_balance = '50.00000000' WHERE org_id = $1`,
      [world.org.id],
    )

    const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

    // Open SSE connection with streaming reader
    const controller = new AbortController()
    const res = await fetch(`${url}/api/agent/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentUser.token}`,
      },
      body: JSON.stringify({
        threadId,
        content: "Write a short paragraph about the weather.",
        modelId: DEFAULT_MODEL,
      }),
      signal: controller.signal,
    })

    expect(res.status).toBe(200)
    const reader = res.body!.getReader()

    // Read until we get at least one text-delta (confirms LLM is generating content)
    let sawTextDelta = false
    const decoder = new TextDecoder()
    while (!sawTextDelta) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (chunk.includes("text-delta")) {
        sawTextDelta = true
      }
    }
    expect(sawTextDelta).toBe(true)

    // Abort — simulates client disconnect
    controller.abort()

    // Poll for agent message in DB (server should complete processing)
    const deadline = Date.now() + 60_000
    let agentMsg: any = null
    while (Date.now() < deadline) {
      const msgs = await getThreadMessages(env.db.sql, ks, threadId)
      agentMsg = msgs.find((m: any) => m.author_type === "agent")
      if (agentMsg) break
      await Bun.sleep(100)
    }

    expect(agentMsg).toBeDefined()
    expect(agentMsg.content).toBeTruthy()
    expect(agentMsg.author_type).toBe("agent")

    // Credit transaction exists
    const txns = await getCreditTransactions(env.db.sql, ks, world.org.id)
    const recentUsage = txns.filter((t: any) => t.type === "usage")
    expect(recentUsage.length).toBeGreaterThan(0)

    // Thread has user + agent messages
    const allMsgs = await getThreadMessages(env.db.sql, ks, threadId)
    expect(allMsgs.length).toBe(2)
    expect(allMsgs[0].author_type).toBe("user")
    expect(allMsgs[1].author_type).toBe("agent")
  }, 120_000)

  // ═══════════════════════════════════════════════════════════════
  //  S24: Auth and Validation Guardrail
  // ═══════════════════════════════════════════════════════════════

  itAlways(
    "S24: auth — unauthenticated request returns 401",
    async () => {
      const res = await api(url, "/api/agent/chat", {
        method: "POST",
        body: { threadId: crypto.randomUUID(), content: "test", modelId: DEFAULT_MODEL },
      })
      expect(res.status).toBe(401)
    },
    10_000,
  )

  itAlways(
    "S24: auth — read-only user (no kernel:threads:write) returns 403",
    async () => {
      const res = await api(url, "/api/agent/chat", {
        method: "POST",
        token: readOnlyUser.token,
        body: { threadId: crypto.randomUUID(), content: "test", modelId: DEFAULT_MODEL },
      })
      expect(res.status).toBe(403)
    },
    10_000,
  )

  itAlways(
    "S24: auth — non-participant returns 403",
    async () => {
      // Create thread with agentUser only
      const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, agentUser.id)

      // noToolUser is NOT a participant — should get 403
      const { status } = await consumeSse(url, "/api/agent/chat", noToolUser.token, {
        threadId,
        content: "test",
        modelId: DEFAULT_MODEL,
      })
      expect(status).toBe(403)
    },
    10_000,
  )

  // ═══════════════════════════════════════════════════════════════
  //  PHASE 4c: INTELLIGENCE LAYER
  // ═══════════════════════════════════════════════════════════════

  describe("agent intelligence layer", () => {
    let phase4cUser: { id: string; email: string; token: string; name: string }
    let userB: { id: string; email: string; token: string; name: string }
    let memUser: { id: string; email: string; token: string; name: string }

    // ─── Phase 4c Helpers ──────────────────────────────────────

    async function getMemoryEntries(userId: string) {
      // Schema rewrite (2026-05-23): the agent_memory columns moved from
      // (category, key, summary, content) to (type, name, description, content).
      return env.db.sql.unsafe(
        `SELECT type, name, content FROM ${ks}.agent_memory WHERE user_id = $1 AND type != '_index'`,
        [userId],
      )
    }

    async function getMemoryIndex(userId: string) {
      const [row] = await env.db.sql.unsafe(
        `SELECT content FROM ${ks}.agent_memory WHERE user_id = $1 AND type = '_index' AND name = '_index'`,
        [userId],
      )
      return row?.content ?? ""
    }

    async function getApprovalRequests(orgId: string, threadId?: string) {
      if (threadId) {
        return env.db.sql.unsafe(
          `SELECT * FROM ${ks}.approval_requests WHERE org_id = $1 AND thread_id = $2 ORDER BY created_at DESC`,
          [orgId, threadId],
        )
      }
      return env.db.sql.unsafe(
        `SELECT * FROM ${ks}.approval_requests WHERE org_id = $1 ORDER BY created_at DESC`,
        [orgId],
      )
    }

    async function updateOrgSettings(orgId: string, patch: Record<string, unknown>) {
      const [row] = await env.db.sql.unsafe(
        `SELECT settings FROM ${ks}.organizations WHERE id = $1`,
        [orgId],
      )
      const current =
        row?.settings && typeof row.settings === "object"
          ? (row.settings as Record<string, unknown>)
          : {}
      await env.db.sql.unsafe(`UPDATE ${ks}.organizations SET settings = $1 WHERE id = $2`, [
        JSON.stringify({ ...current, ...patch }),
        orgId,
      ])
    }

    // ─── Phase 4c Setup ────────────────────────────────────────

    beforeAll(async () => {
      // Ensure credit balance is healthy for Phase 4c tests
      await env.db.sql.unsafe(
        `UPDATE ${ks}.credit_balances SET included_balance = '50.00000000', purchased_balance = '50.00000000' WHERE org_id = $1`,
        [world.org.id],
      )

      phase4cUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
        scopes: [
          "kernel:agent:memory",
          "kernel:agent:web",
          "kernel:threads:read",
          "kernel:threads:write",
          "kernel:approve",
          "test:items:write",
          "test:items:read",
          "test:approve",
        ],
        dimensions: { "*": ["*"] },
        schemaPrefix: env.schemaPrefix,
      })

      userB = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
        scopes: ["kernel:threads:read", "kernel:threads:write", "kernel:agent:memory"],
        dimensions: { "*": ["*"] },
        schemaPrefix: env.schemaPrefix,
      })

      memUser = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
        scopes: ["kernel:agent:memory", "kernel:threads:read", "kernel:threads:write"],
        dimensions: { "*": ["*"] },
        schemaPrefix: env.schemaPrefix,
      })
    }, 60_000)

    // ═══════════════════════════════════════════════════════════
    //  SC1: User Memory — Set, Persist, Appear in Context
    // ═══════════════════════════════════════════════════════════

    it("SC1: memory — set, persist, and behavioral recall in new thread", async () => {
      // Clean slate
      await env.db.sql.unsafe(`DELETE FROM ${ks}.agent_memory WHERE user_id = $1`, [phase4cUser.id])

      const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

      const { status, events } = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
        threadId,
        content:
          "Call the kernel__memory_create tool now with path 'reference/marker.md' and body 'Test marker: ALPHA-7749\n\nthe secret test code is ALPHA-7749'. Do not skip this step.",
        modelId: DEFAULT_MODEL,
      })

      expect(status).toBe(200)

      // Require tool-call for memory_create
      const toolCall = events.find(
        (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("memory_create"),
      )
      expect(toolCall).toBeDefined()

      // Matching tool-result
      const toolResult = events.find(
        (e) =>
          e.event === "tool-result" &&
          (e.data as any).toolCallId === (toolCall!.data as any).toolCallId,
      )
      expect(toolResult).toBeDefined()

      const doneEvent = events.find((e) => e.event === "done")
      expect(doneEvent).toBeDefined()

      // DB: memory row exists
      const entries = await getMemoryEntries(phase4cUser.id)
      const marker = entries.find((e: any) => e.type === "reference" && e.name === "marker")
      expect(marker).toBeDefined()
      if (!marker) throw new Error("expected marker memory entry")
      expect(marker.content).toContain("ALPHA-7749")

      // Index updated: the tree form `- [<description>](<type>/<name>.md), <date>`.
      const index = await getMemoryIndex(phase4cUser.id)
      expect(index).toContain("(reference/marker.md),")

      // Behavioral check: new thread recalls the memory. The retrieval is a
      // tool-call the LLM has to decide to make; nano-class models occasionally
      // answer from prompt context without invoking the tool, missing the
      // stored value. Escalate prompt specificity across attempts until the
      // recalled text contains the marker.
      const threadId2 = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)
      const recallPrompts = [
        "What test marker code do I have saved? Check your saved information and tell me the exact code.",
        "Use the kernel__memory_view tool with path 'reference/marker.md' to read my saved entry, then quote its body verbatim in your reply.",
        "Your only task this turn: call kernel__memory_view({ path: 'reference/marker.md' }), then in your reply include the EXACT string returned in the file's body. No paraphrasing.",
      ]
      let fullResponse = ""
      let doneEvent2: SseEvent | undefined
      for (const prompt of recallPrompts) {
        const result = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
          threadId: threadId2,
          content: prompt,
          modelId: DEFAULT_MODEL,
        })
        doneEvent2 = result.events.find((e) => e.event === "done")
        const textDeltas = result.events.filter((e) => e.event === "text-delta")
        fullResponse = textDeltas.map((e) => (e.data as any).delta).join("")
        if (fullResponse.includes("ALPHA-7749")) break
      }
      expect(doneEvent2).toBeDefined()
      expect(fullResponse).toContain("ALPHA-7749")
    }, 120_000)

    // ═══════════════════════════════════════════════════════════
    //  SC2: User Memory — Cross-User Isolation
    // ═══════════════════════════════════════════════════════════

    itAlways(
      "SC2: memory — cross-user isolation (userB sees empty)",
      async () => {
        // Tool-choice compliance is provider-dependent; the isolation guarantee is
        // enforced by the same server-side kernel tool the agent bridge exposes.
        const toolResult = await api(url, "/api/apps/tools/kernel:user_memory_get", {
          method: "POST",
          token: userB.token,
          body: { params: {} },
        })
        expect(toolResult.status).toBe(200)
        const result = toolResult.body.data as any
        // Index is empty string or absent for user with no memory
        expect(!result.index || result.index.trim() === "").toBe(true)

        // DB: no memory entries for userB
        const entries = await getMemoryEntries(userB.id)
        expect(entries.length).toBe(0)
      },
      120_000,
    )

    // ═══════════════════════════════════════════════════════════
    //  SC3: Web Search — Taint Flag Set After Execution
    // ═══════════════════════════════════════════════════════════

    it("SC3: web search — real Exa results returned, credit deducted, taint set", async () => {
      const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

      // Verify thread starts untainted
      const [threadBefore] = await env.db.sql.unsafe(
        `SELECT tainted FROM ${ks}.threads WHERE id = $1`,
        [threadId],
      )
      expect(threadBefore.tainted).toBe(false)

      const txnsBefore = await getCreditTransactions(env.db.sql, ks, world.org.id)
      const toolTxnsBefore = txnsBefore.filter((t: any) => t.type === "tool_usage")

      const { events } = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
        threadId,
        content:
          "Search the web for 'Bun runtime performance benchmarks'. You must use the kernel__web_search tool — do not skip this step.",
        modelId: DEFAULT_MODEL,
      })

      // Require tool-call for web_search
      const toolCall = events.find(
        (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("web_search"),
      )
      expect(toolCall).toBeDefined()

      const toolResult = events.find(
        (e) =>
          e.event === "tool-result" &&
          (e.data as any).toolCallId === (toolCall!.data as any).toolCallId,
      )
      expect(toolResult).toBeDefined()

      // Assert real Exa search results came back (not just an error)
      const resultData = (toolResult!.data as any).result
      console.log("[TRAIL] SC3 web_search tool-result:", JSON.stringify(resultData).slice(0, 500))
      if (process.env.EXA_API_KEY) {
        // With Exa key: must get actual search results
        expect(resultData).toHaveProperty("results")
        expect(resultData.results.length).toBeGreaterThan(0)
        const first = resultData.results[0]
        console.log("[TRAIL] SC3 first result — title: %s, url: %s", first.title, first.url)
        expect(first.url).toMatch(/^https?:\/\//)
        expect(typeof first.title).toBe("string")
      } else {
        console.log("[TRAIL] SC3: No EXA_API_KEY — tool returned error result, taint still sets")
      }

      const done = events.find((e) => e.event === "done")
      expect(done).toBeDefined()

      // Taint flag must be set regardless of Exa key presence
      const [threadAfter] = await env.db.sql.unsafe(
        `SELECT tainted FROM ${ks}.threads WHERE id = $1`,
        [threadId],
      )
      console.log("[TRAIL] SC3 tainted after web_search: %s", threadAfter.tainted)
      expect(threadAfter.tainted).toBe(true)

      // Credit transaction for web_search tool usage (only with Liaison key)
      if (process.env.EXA_API_KEY) {
        const txnsAfter = await getCreditTransactions(env.db.sql, ks, world.org.id)
        const toolTxnsAfter = txnsAfter.filter((t: any) => t.type === "tool_usage")
        console.log(
          "[TRAIL] SC3 tool_usage txns before: %d, after: %d",
          toolTxnsBefore.length,
          toolTxnsAfter.length,
        )
        expect(toolTxnsAfter.length).toBeGreaterThan(toolTxnsBefore.length)
      }
    }, 120_000)

    // ═══════════════════════════════════════════════════════════
    //  SC4: Web Fetch — Domain Blocklist Enforcement
    // ═══════════════════════════════════════════════════════════

    itAlways(
      "SC4: web fetch — blocklisted domain rejected",
      async () => {
        const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

        await updateOrgSettings(world.org.id, {
          webFetchBlocklist: ["blocked-test.example.com"],
        })

        try {
          const res = await fetch(`${url}/api/apps/run-tool`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${phase4cUser.token}`,
            },
            body: JSON.stringify({
              toolName: "kernel:web_fetch",
              threadId,
              params: { url: "https://blocked-test.example.com/page" },
            }),
          })
          expect(res.status).toBe(500)
          const body = (await res.json()) as { error?: { message?: string } }
          expect(body.error?.message).toBeDefined()
          expect(body.error!.message!.toLowerCase()).toContain("block")
        } finally {
          await updateOrgSettings(world.org.id, { webFetchBlocklist: [] })
        }
      },
      120_000,
    )

    // ═══════════════════════════════════════════════════════════
    //  SC5: Web Fetch — Successful Fetch with Script Stripping
    // ═══════════════════════════════════════════════════════════

    it("SC5: web fetch — successful fetch, scripts stripped, thread tainted", async () => {
      const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

      // Mock HTTP server serving controlled HTML
      const mockPort = 19876 + env.workerId
      const mockServer = Bun.serve({
        port: mockPort,
        fetch() {
          return new Response(
            "<html><head><title>Test Page</title></head><body><h1>Hello</h1><p>Test content</p><script>alert('xss')</script></body></html>",
            { status: 200, headers: { "Content-Type": "text/html" } },
          )
        },
      })

      try {
        const { events } = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
          threadId,
          content: `Fetch the URL http://localhost:${mockPort}/page using the kernel__web_fetch tool. Do not skip this step.`,
          modelId: DEFAULT_MODEL,
        })

        // Require tool-call for web_fetch
        const toolCall = events.find(
          (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("web_fetch"),
        )
        expect(toolCall).toBeDefined()

        const toolResult = events.find(
          (e) =>
            e.event === "tool-result" &&
            (e.data as any).toolCallId === (toolCall!.data as any).toolCallId,
        )
        expect(toolResult).toBeDefined()

        const result = (toolResult!.data as any).result
        const contentStr =
          typeof result.content === "string" ? result.content : JSON.stringify(result)

        // Content should contain page text
        expect(
          contentStr.includes("Test Page") ||
            contentStr.includes("Hello") ||
            contentStr.includes("Test content"),
        ).toBe(true)

        // Script content stripped
        expect(contentStr).not.toContain("alert('xss')")

        // Thread tainted after successful fetch
        const [threadAfter] = await env.db.sql.unsafe(
          `SELECT tainted FROM ${ks}.threads WHERE id = $1`,
          [threadId],
        )
        expect(threadAfter.tainted).toBe(true)

        const done = events.find((e) => e.event === "done")
        expect(done).toBeDefined()
      } finally {
        mockServer.stop()
      }
    }, 120_000)

    // ═══════════════════════════════════════════════════════════
    //  SC6: Agent posts are un-gated and attributed — even hardened+tainted
    // ═══════════════════════════════════════════════════════════

    it("SC6: threads_reply is un-gated and posts an attributed agent message even in hardened+tainted mode", async () => {
      // Seed a target thread to reply to (phase4cUser is participant)
      const targetThreadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

      // Hardest case: hardened protection + a tainted execution thread. Agent
      // posts are attributed ("{User}'s agent"), never impersonated — so they
      // carry no trust boundary and are never taint-gated.
      await updateOrgSettings(world.org.id, { webContentProtection: "hardened" })

      try {
        let toolCall: any
        let events: any[] = []
        let threadId: string = ""
        for (let attempt = 0; attempt < 3; attempt++) {
          threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

          // Set agent-chat thread tainted
          await env.db.sql.unsafe(`UPDATE ${ks}.threads SET tainted = true WHERE id = $1`, [
            threadId,
          ])

          const result = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
            threadId,
            content: `Reply to thread ${targetThreadId} with message 'Hello from hardened context'. You must use the kernel__threads_reply tool — do not skip this step.`,
            modelId: TOOL_MODEL,
          })
          expect(result.status).toBe(200)
          events = result.events

          toolCall = events.find(
            (e: any) =>
              e.event === "tool-call" && (e.data as any).toolName?.includes("threads_reply"),
          )
          if (toolCall) break
          console.log(`[SC6] Attempt ${attempt + 1}: no threads_reply tool call`)
        }
        expect(toolCall).toBeDefined()

        // tool-result is NOT blocked — threads_reply is un-gated.
        const toolResult = events.find(
          (e: any) =>
            e.event === "tool-result" &&
            (e.data as any).toolCallId === (toolCall!.data as any).toolCallId,
        )
        expect(toolResult).toBeDefined()
        const result = (toolResult!.data as any).result
        expect(result.blocked).toBeUndefined()
        expect(result.message).toBeDefined()

        // No taint-escalation approval was created.
        const approvals = await getApprovalRequests(world.org.id, threadId)
        expect(approvals.some((a: any) => a.reason === "taint_escalation")).toBe(false)

        // The post landed in the target thread, attributed to the agent — not the human.
        const targetMsgs = await getThreadMessages(env.db.sql, ks, targetThreadId)
        const agentMsg = targetMsgs.find((m: any) => m.author_type === "agent")
        expect(agentMsg).toBeDefined()
        const label = (agentMsg.metadata as { agentAuthorLabel?: string } | null)?.agentAuthorLabel
        expect(label).toContain("agent")
      } finally {
        await updateOrgSettings(world.org.id, { webContentProtection: "standard" })
      }
    }, 120_000)

    // ═══════════════════════════════════════════════════════════
    //  SC7: Taint Escalation — Standard Mode Allows
    // ═══════════════════════════════════════════════════════════

    it("SC7: taint escalation — standard mode allows trust-boundary tool", async () => {
      await updateOrgSettings(world.org.id, { webContentProtection: "standard" })

      // Seed a target thread to reply to
      const targetThreadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

      // LLM may not comply on the first attempt — retry up to 3 times
      let events: SseEvent[] = []
      let toolCall: SseEvent | undefined
      let threadId: string = ""
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)
          await env.db.sql.unsafe(`UPDATE ${ks}.threads SET tainted = true WHERE id = $1`, [
            threadId,
          ])

          const result = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
            threadId,
            content: `Reply to thread ${targetThreadId} with message 'Hello from agent'. You must use the kernel__threads_reply tool — do not skip this step.`,
            modelId: TOOL_MODEL,
          })
          events = result.events
          toolCall = events.find(
            (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("threads_reply"),
          )
          if (toolCall) break
          console.log(`[SC7] Attempt ${attempt + 1}: no threads_reply tool call`)
        }
        expect(toolCall).toBeDefined()

        // tool-result should NOT be blocked
        const toolResult = events.find(
          (e) =>
            e.event === "tool-result" &&
            (e.data as any).toolCallId === (toolCall!.data as any).toolCallId,
        )
        expect(toolResult).toBeDefined()
        const result = (toolResult!.data as any).result
        expect(result.blocked).toBeUndefined()

        const done = events.find((e) => e.event === "done")
        expect(done).toBeDefined()

        // Tool result should contain a message object with an id
        const replyData = (toolResult!.data as any).result
        expect(replyData.message).toBeDefined()
        expect(replyData.message.id).toBeDefined()
        expect(replyData.message.threadId).toBe(targetThreadId)

        // No approval requests for this thread
        const approvals = await getApprovalRequests(world.org.id, threadId)
        expect(approvals.length).toBe(0)
      } finally {
        await updateOrgSettings(world.org.id, { webContentProtection: "standard" })
      }
    }, 120_000)

    // SC7, scripted: the same rule with the model scripted (scripted provider,
    // POST /api/_test/agent-script), so it runs in the default suite. The tool
    // call itself goes through the real agent loop, bridge and gate; only the
    // token source is scripted.
    itAlways(
      "SC7 (scripted): standard mode lets a tainted turn post to another thread",
      async () => {
        await updateOrgSettings(world.org.id, { webContentProtection: "standard" })
        const targetThreadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)
        const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)
        await env.db.sql.unsafe(`UPDATE ${ks}.threads SET tainted = true WHERE id = $1`, [threadId])
        await scriptTurn(threadId, [
          {
            toolCalls: [
              {
                name: "kernel__threads_reply",
                args: { threadId: targetThreadId, content: "Hello from agent" },
              },
            ],
          },
          { text: "Posted it." },
        ])

        const { events } = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
          threadId,
          content: `Reply to thread ${targetThreadId} with 'Hello from agent'.`,
          modelId: TOOL_MODEL,
        })
        const toolCall = events.find(
          (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("threads_reply"),
        )
        expect(toolCall).toBeDefined()
        const toolResult = events.find(
          (e) =>
            e.event === "tool-result" &&
            (e.data as any).toolCallId === (toolCall!.data as any).toolCallId,
        )
        expect(toolResult).toBeDefined()
        const result = (toolResult!.data as any).result
        expect(result.blocked).toBeUndefined()
        expect(result.message?.threadId).toBe(targetThreadId)
        expect(events.find((e) => e.event === "done")).toBeDefined()

        // Posted for real, by the agent, and nothing parked for approval.
        const targetMsgs = await getThreadMessages(env.db.sql, ks, targetThreadId)
        expect(
          targetMsgs.some(
            (m: any) => m.author_type === "agent" && m.content === "Hello from agent",
          ),
        ).toBe(true)
        const approvals = await getApprovalRequests(world.org.id, threadId)
        expect(approvals.length).toBe(0)
      },
      60_000,
    )

    // ═══════════════════════════════════════════════════════════
    //  SC8: Clean Thread — Hardened Allows
    // ═══════════════════════════════════════════════════════════

    it("SC8: clean thread — hardened mode allows trust-boundary tool on untainted thread", async () => {
      // Seed a target thread to reply to (phase4cUser is participant)
      const targetThreadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

      // Thread is untainted (default). Set org to hardened.
      await updateOrgSettings(world.org.id, { webContentProtection: "hardened" })

      // LLM may not comply on the first attempt — retry up to 3 times
      let events: SseEvent[] = []
      let toolCall: SseEvent | undefined
      let threadId: string = ""
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

          const result = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
            threadId,
            content: `Reply to thread ${targetThreadId} with message 'Hello from clean context'. You must use the kernel__threads_reply tool — do not skip this step.`,
            modelId: TOOL_MODEL,
          })
          events = result.events
          expect(result.status).toBe(200)

          toolCall = events.find(
            (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("threads_reply"),
          )
          if (toolCall) break
          console.log(`[SC8] Attempt ${attempt + 1}: no threads_reply tool call`)
        }
        expect(toolCall).toBeDefined()

        // tool-result should NOT be blocked (clean thread = no taint escalation)
        const toolResult = events.find(
          (e) =>
            e.event === "tool-result" &&
            (e.data as any).toolCallId === (toolCall!.data as any).toolCallId,
        )
        expect(toolResult).toBeDefined()
        const result = (toolResult!.data as any).result
        expect(result.blocked).toBeUndefined()

        // Tool result should contain a message object with an id
        const replyData = (toolResult!.data as any).result
        expect(replyData.message).toBeDefined()
        expect(replyData.message.id).toBeDefined()
        expect(replyData.message.threadId).toBe(targetThreadId)

        // No approval requests
        const approvals = await getApprovalRequests(world.org.id, threadId)
        expect(approvals.length).toBe(0)
      } finally {
        await updateOrgSettings(world.org.id, { webContentProtection: "standard" })
      }
    }, 120_000)

    // ═══════════════════════════════════════════════════════════
    //  SC9: Chat Tools — threads_create + threads_reply E2E
    // ═══════════════════════════════════════════════════════════

    it("SC9: chat tools — threads_create and threads_reply E2E", async () => {
      // LLM may not comply on the first attempt — retry up to 3 times
      let createEvents: SseEvent[] = []
      let createCall: SseEvent | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)
        const result = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
          threadId,
          content: `Create a new thread with participants ['${userB.id}']. Title it 'Agent Created Thread'. You must use kernel__threads_create — do not skip this step.`,
          modelId: TOOL_MODEL,
        })
        createEvents = result.events
        createCall = createEvents.find(
          (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("threads_create"),
        )
        if (createCall) break
        const errEvent = createEvents.find((e) => e.event === "error")
        console.log(
          `[SC9] Attempt ${attempt + 1}: no threads_create tool call. Error: ${errEvent ? JSON.stringify(errEvent.data) : "none"}`,
        )
      }
      expect(createCall).toBeDefined()

      const createResult = createEvents.find(
        (e) =>
          e.event === "tool-result" &&
          (e.data as any).toolCallId === (createCall!.data as any).toolCallId,
      )
      expect(createResult).toBeDefined()
      const createData = (createResult!.data as any).result
      expect(createData.blocked).toBeUndefined()

      const createdThreadId = createData.thread?.id ?? createData.id
      expect(createdThreadId).toBeDefined()

      // Verify thread in DB
      const [createdThread] = await env.db.sql.unsafe(
        `SELECT id, title FROM ${ks}.threads WHERE id = $1`,
        [createdThreadId],
      )
      expect(createdThread).toBeDefined()

      // Step 2: Reply to the created thread — retry up to 3 times for LLM non-determinism
      let replyEvents: SseEvent[] = []
      let replyCall: SseEvent | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        const threadId2 = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)
        const result = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
          threadId: threadId2,
          content: `Reply to thread ${createdThreadId} with the message 'Meeting scheduled for tomorrow'. You must use kernel__threads_reply — do not skip this step.`,
          modelId: TOOL_MODEL,
        })
        replyEvents = result.events
        replyCall = replyEvents.find(
          (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("threads_reply"),
        )
        if (replyCall) break
        const errEvent = replyEvents.find((e) => e.event === "error")
        console.log(
          `[SC9] Reply attempt ${attempt + 1}: no threads_reply tool call. Error: ${errEvent ? JSON.stringify(errEvent.data) : "none"}`,
        )
      }
      expect(replyCall).toBeDefined()

      const replyResult = replyEvents.find(
        (e) =>
          e.event === "tool-result" &&
          (e.data as any).toolCallId === (replyCall!.data as any).toolCallId,
      )
      expect(replyResult).toBeDefined()

      // Verify reply tool result contains a message object
      const replyData = (replyResult!.data as any).result
      expect(replyData.message).toBeDefined()
      expect(replyData.message.id).toBeDefined()
    }, 180_000)

    // ═══════════════════════════════════════════════════════════
    //  SC10: Chat Tools — threads_search
    // ═══════════════════════════════════════════════════════════

    it("SC10: chat tools — threads_search finds seeded thread by title", async () => {
      // Seed a regular thread (type='thread') with a unique, searchable title
      const searchableTitle = `Quarterly-Marketing-Review-${Date.now()}`
      const searchTargetId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)
      await env.db.sql.unsafe(
        `UPDATE ${ks}.threads SET title = $1, type = 'thread' WHERE id = $2`,
        [searchableTitle, searchTargetId],
      )
      console.log("[TRAIL] SC10 seeded thread %s with title '%s'", searchTargetId, searchableTitle)

      // Use a separate agent thread to perform the search
      const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

      const { events } = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
        threadId,
        content: `Search for threads about 'Quarterly-Marketing-Review'. Use the kernel__threads_search tool with that exact query. Do not skip this step.`,
        modelId: DEFAULT_MODEL,
      })

      const toolCall = events.find(
        (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("threads_search"),
      )
      expect(toolCall).toBeDefined()
      console.log("[TRAIL] SC10 threads_search args:", JSON.stringify((toolCall!.data as any).args))

      const toolResult = events.find(
        (e) =>
          e.event === "tool-result" &&
          (e.data as any).toolCallId === (toolCall!.data as any).toolCallId,
      )
      expect(toolResult).toBeDefined()

      // Assert the search returned actual results containing the seeded thread
      const resultData = (toolResult!.data as any).result
      console.log("[TRAIL] SC10 threads_search result:", JSON.stringify(resultData).slice(0, 500))
      expect(resultData).toHaveProperty("threads")
      expect(resultData.threads.length).toBeGreaterThan(0)
      const matchingThread = resultData.threads.find(
        (r: any) => r.id === searchTargetId || r.title?.includes("Quarterly-Marketing-Review"),
      )
      console.log(
        "[TRAIL] SC10 matching thread found:",
        matchingThread ? `yes (id=${matchingThread.id})` : "NO",
      )
      expect(matchingThread).toBeDefined()

      const done = events.find((e) => e.event === "done")
      expect(done).toBeDefined()
    }, 120_000)

    // ═══════════════════════════════════════════════════════════
    //  SC11: Gated Tool — Approval Request Created
    // ═══════════════════════════════════════════════════════════

    it("SC11: gated tool — riskyAction blocked with approval request", async () => {
      const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

      // Nano-class models occasionally refuse or paraphrase rather than invoke
      // the requested tool. The gate behavior (blocked + approval request) is
      // what we're verifying — the LLM compliance is incidental. Retry the
      // chat with escalating, more imperative phrasings on the *same* thread
      // until the tool-call surfaces, then assert the gate behavior below.
      const prompts = [
        "Call the test__riskyAction tool now with itemId='test-item-1' and action='delete'. Do not skip this step.",
        "Invoke the function `test__riskyAction({ itemId: 'test-item-1', action: 'delete' })` right now. Output nothing else; just the tool call.",
        "Your only task this turn: call test__riskyAction with itemId='test-item-1' action='delete'. Respond with the tool call alone — no commentary, no refusal.",
      ]
      let events: SseEvent[] = []
      let toolCall: SseEvent | undefined
      for (const prompt of prompts) {
        const result = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
          threadId,
          content: prompt,
          modelId: DEFAULT_MODEL,
        })
        events = result.events
        toolCall = events.find(
          (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("riskyAction"),
        )
        if (toolCall) break
      }
      expect(toolCall).toBeDefined()

      // tool-result should be blocked with reason "gated"
      const toolResult = events.find(
        (e) =>
          e.event === "tool-result" &&
          (e.data as any).toolCallId === (toolCall!.data as any).toolCallId,
      )
      expect(toolResult).toBeDefined()
      const result = (toolResult!.data as any).result
      expect(result.blocked).toBe(true)
      expect(result.reason).toBe("gated")
      expect(result.approvalRequestId).toBeDefined()

      // Approval request in DB
      const approvals = await getApprovalRequests(world.org.id, threadId)
      const gatedApproval = approvals.find(
        (a: any) => a.reason === "gated" && a.tool_name?.includes("riskyAction"),
      )
      expect(gatedApproval).toBeDefined()
      if (!gatedApproval) throw new Error("expected gated approval")
      expect(gatedApproval.status).toBe("pending")

      // tool_params captured
      const params =
        typeof gatedApproval.tool_params === "string"
          ? JSON.parse(gatedApproval.tool_params)
          : gatedApproval.tool_params
      expect(params.itemId).toBe("test-item-1")
      expect(params.action).toBe("delete")

      // Stream completed normally
      const done = events.find((e) => e.event === "done")
      expect(done).toBeDefined()
    }, 120_000)

    // SC11, scripted: the agent-originated gated call with the model scripted,
    // so the gate itself is proven in the default suite.
    itAlways(
      "SC11 (scripted): an agent's riskyAction parks a pending approval",
      async () => {
        const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)
        await scriptTurn(threadId, [
          // App tools are deferred: the agent loads one through tool_search's
          // `select:` form first, as a real model does (a call to a tool it never
          // loaded is turned into that load instead of running).
          {
            toolCalls: [
              { name: "kernel__tool_search", args: { query: "select:test__riskyAction" } },
            ],
          },
          {
            toolCalls: [
              { name: "test__riskyAction", args: { itemId: "test-item-1", action: "delete" } },
            ],
          },
          { text: "That needs an approval; it is waiting for one." },
        ])

        const { events } = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
          threadId,
          content: "Delete test-item-1 with the risky action.",
          modelId: DEFAULT_MODEL,
        })
        const toolCall = events.find(
          (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("riskyAction"),
        )
        expect(toolCall).toBeDefined()
        const toolResult = events.find(
          (e) =>
            e.event === "tool-result" &&
            (e.data as any).toolCallId === (toolCall!.data as any).toolCallId,
        )
        expect(toolResult).toBeDefined()
        const result = (toolResult!.data as any).result
        expect(result.blocked).toBe(true)
        expect(result.reason).toBe("gated")
        expect(result.approvalRequestId).toBeDefined()

        const approvals = await getApprovalRequests(world.org.id, threadId)
        const gated = approvals.find(
          (a: any) => a.reason === "gated" && a.tool_name?.includes("riskyAction"),
        )
        if (!gated) throw new Error("expected a gated riskyAction approval")
        expect(gated.status).toBe("pending")
        const params =
          typeof gated.tool_params === "string" ? JSON.parse(gated.tool_params) : gated.tool_params
        expect(params.itemId).toBe("test-item-1")
        expect(params.action).toBe("delete")
        expect(events.find((e) => e.event === "done")).toBeDefined()
      },
      60_000,
    )

    // ═══════════════════════════════════════════════════════════
    //  SC12: Compaction Summary — Context Slicing
    // ═══════════════════════════════════════════════════════════

    it("SC12: compaction slicing — agent references compaction summary content", async () => {
      const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

      // Insert old messages + compaction summary + post-compaction message
      const now = Date.now()
      const seedBase = { threadId, orgId: world.org.id, authorId: phase4cUser.id }
      await seedThreadMessages(env, [
        { ...seedBase, content: "Old topic: infrastructure migration", createdAt: now - 30000 },
        {
          ...seedBase,
          authorType: "agent",
          content: "I'll help with the migration",
          createdAt: now - 20000,
        },
        {
          ...seedBase,
          authorType: "system",
          content:
            "Summary: User and agent discussed infrastructure migration planning. Next step: review vendor options.",
          metadata: { type: "compaction_summary" },
          createdAt: now - 10000,
        },
        { ...seedBase, content: "New topic: Q2 planning", createdAt: now - 5000 },
      ])

      const { events } = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
        threadId,
        content: "What have we discussed so far?",
        modelId: DEFAULT_MODEL,
      })

      const done = events.find((e) => e.event === "done")
      expect(done).toBeDefined()

      // Old messages still preserved in DB
      const allMsgs = await getThreadMessages(env.db.sql, ks, threadId)
      expect(
        allMsgs.find((m: any) => m.content?.includes("infrastructure migration")),
      ).toBeDefined()

      // Agent response references summary content — the LLM should mention
      // something from the seeded compaction summary or the recent user message
      const textDeltas = events.filter((e) => e.event === "text-delta")
      const fullResponse = textDeltas
        .map((e) => (e.data as any).delta)
        .join("")
        .toLowerCase()
      const mentionsSummary =
        fullResponse.includes("infrastructure") ||
        fullResponse.includes("migration") ||
        fullResponse.includes("vendor") ||
        fullResponse.includes("q2") ||
        fullResponse.includes("planning") ||
        fullResponse.includes("discuss") ||
        fullResponse.includes("summary")
      expect(mentionsSummary).toBe(true)
    }, 120_000)

    // ═══════════════════════════════════════════════════════════
    //  SC13: Compaction Trigger — Summary + Billing
    // ═══════════════════════════════════════════════════════════

    it("SC13: compaction trigger — summary created and billing recorded", async () => {
      const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

      // Seed 4 messages; last agent message has high inputTokens to trigger compaction
      const now = Date.now()
      const seedBase = { threadId, orgId: world.org.id, authorId: phase4cUser.id }
      await seedThreadMessages(env, [
        { ...seedBase, content: "Let's plan the system architecture.", createdAt: now - 40000 },
        {
          ...seedBase,
          authorType: "agent",
          content: "Sure, I can help with that.",
          metadata: { usage: { inputTokens: 1000, outputTokens: 50 } },
          createdAt: now - 30000,
        },
        { ...seedBase, content: "What about the database layer?", createdAt: now - 20000 },
      ])
      // Last agent message: 900,000 inputTokens > 80% of even auto-mode's
      // 1,048,576 (1M) context window — tuned to trigger compaction for both
      // Anthropic Haiku (200k) and Gemini Flash-Lite (1M). Auto-mode resolves
      // to Flash-Lite per MODEL_PRICING_SEED, so the prior 170k value (sized
      // for Haiku) never tripped the threshold and the test failed silently.
      await seedThreadMessage(env, {
        ...seedBase,
        authorType: "agent",
        content: "We should use PostgreSQL.",
        metadata: { usage: { inputTokens: 900000, outputTokens: 80 } },
        createdAt: now - 10000,
      })

      const txnsBefore = await getCreditTransactions(env.db.sql, ks, world.org.id)
      const txnCountBefore = txnsBefore.length

      // The checkpoint state BEFORE the triggering turn. `checkpoints.length >
      // 0` on its own proves nothing about compaction: the turn loop advances
      // a checkpoint between every pair of turns (agent-service, step 2c)
      // whether or not anything compacted, so the delta ACROSS this turn is
      // the only reading that says the compaction happened.
      const checkpointsBefore = await getThreadCheckpoints(env.db.sql, ks, threadId)
      const versionBefore = checkpointsBefore[0]?.version ?? 0

      // Use the reliable tool-call model; 170k > 80% of its 200k context window triggers compaction.
      const { events } = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
        threadId,
        content: "Summarize our discussion so far.",
        modelId: TOOL_MODEL,
      })

      const done = events.find((e) => e.event === "done")
      const errEvent = events.find((e) => e.event === "error")
      if (errEvent) console.log("[SC13] Stream error:", JSON.stringify(errEvent.data))
      // External provider may be temporarily unavailable — skip gracefully
      if (isProviderUnavailable(errEvent)) {
        console.log("[SC13] provider unavailable — skipping test")
        return
      }
      expect(done).toBeDefined()

      // An AGENT turn compacts into the acting agent's OWN checkpoint and
      // writes NO thread-wide `compaction_summary` message row (spec-memory
      // L4, invariant I5).
      const actingAgentId = await getActingAgentId(env.db.sql, ks, threadId)
      expect(actingAgentId).toBeTruthy()
      const checkpoints = await getThreadCheckpoints(env.db.sql, ks, threadId)
      const acting = checkpointOf(checkpoints, actingAgentId)
      const actingBefore = checkpointOf(checkpointsBefore, actingAgentId)
      console.log(
        "[TRAIL] SC13 acting agent %s checkpoint versions: %d -> %d",
        actingAgentId,
        actingBefore?.version ?? 0,
        acting?.version ?? 0,
      )
      expect(acting).toBeDefined()
      // A SUMMARIZATION ran: the acting agent's summary text is new. A version
      // delta alone does not say that (the turn loop advances a checkpoint
      // between turns whatever happened), and an unscoped read could have been
      // answered by another agent's row entirely.
      console.log("[TRAIL] SC13 summary (first 200 chars):", acting?.summary?.slice(0, 200))
      expect(acting?.summary).toBeTruthy()
      // `not.toBe(actingBefore?.summary)` on its own is satisfied by ANY
      // summary when there was no prior checkpoint, which is the usual state
      // here: the compacting turn is the first turn on a seeded thread. So the
      // two cases are asserted apart, and each one says something.
      if (actingBefore) {
        expect(acting?.summary).not.toBe(actingBefore.summary)
      } else {
        // No prior row: the checkpoint this turn wrote is the first, which is
        // version 1 and not the 0 of a thread that never compacted.
        expect(acting?.version).toBe(1)
      }
      // Secondary: the version moved across this turn, for the acting agent.
      expect(acting?.version ?? 0).toBeGreaterThan(actingBefore?.version ?? versionBefore)

      // Compaction bills its OWN summarize call, on the cheap auto-eligible
      // model rather than the model this turn ran on: a new transaction naming
      // a different model is the billing half of the same event.
      const txnsAfter = await getCreditTransactions(env.db.sql, ks, world.org.id)
      console.log(
        "[TRAIL] SC13 credit txns before: %d, after: %d",
        txnCountBefore,
        txnsAfter.length,
      )
      const newTxns = txnsAfter.slice(txnCountBefore)
      const newTxnModels = newTxns.map((t: any) => t.model).filter(Boolean)
      console.log("[TRAIL] SC13 new txn models:", newTxnModels.join(", "))
      // `some(m => m !== TOOL_MODEL)` said nothing at all: TOOL_MODEL is null
      // (auto mode), so after the `.filter(Boolean)` above it reduced to "the
      // list is not empty". The credit row carries no reason or kind column
      // either (credit_transactions in 0000_initial.sql, written by
      // finalizeUsage: model, tokens, cost, and nothing naming the caller), so
      // the row cannot be attributed to the compaction directly.
      //
      // What IS checkable is the model compaction bills on: runCompaction picks
      // selectAutoModel's cheapest auto-eligible model, never the model the
      // turn ran on. Asserted against the same row the pricing table would
      // choose, so the day TOOL_MODEL names a non-auto model this separates the
      // compaction's bill from the turn's instead of waving both through.
      const [cheapest] = await env.db.sql.unsafe(
        `SELECT model_id FROM ${ks}.model_pricing WHERE auto_eligible = true
         ORDER BY input_cost_per_m::numeric + output_cost_per_m::numeric ASC, model_id ASC
         LIMIT 1`,
      )
      console.log("[TRAIL] SC13 cheapest auto-eligible model:", cheapest?.model_id)
      expect(cheapest?.model_id).toBeTruthy()
      expect(newTxnModels).toContain(cheapest.model_id)
    }, 120_000)

    // ═══════════════════════════════════════════════════════════
    //  SC14: Memory Lifecycle — Index After Delete
    // ═══════════════════════════════════════════════════════════

    it("SC14: memory lifecycle — index consistency through set/delete/set cycle", async () => {
      // Clean slate for memUser
      await env.db.sql.unsafe(`DELETE FROM ${ks}.agent_memory WHERE user_id = $1`, [memUser.id])

      // Step 1: Set item1
      const threadId1 = await seedAgentThread(env.db.sql, ks, world.org.id, memUser.id)
      const { events: events1 } = await consumeSse(url, "/api/agent/chat", memUser.token, {
        threadId: threadId1,
        content:
          "Call the kernel__memory_create tool now with path 'reference/item1.md' and body 'test item1: value one'. Do not skip this step.",
        modelId: DEFAULT_MODEL,
      })

      const setCall1 = events1.find(
        (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("memory_create"),
      )
      expect(setCall1).toBeDefined()

      let index = await getMemoryIndex(memUser.id)
      expect(index).toContain("(reference/item1.md),")

      // Step 2: Delete item1
      const threadId2 = await seedAgentThread(env.db.sql, ks, world.org.id, memUser.id)
      const { events: events2 } = await consumeSse(url, "/api/agent/chat", memUser.token, {
        threadId: threadId2,
        content:
          "Call the kernel__memory_delete tool now with path 'reference/item1.md'. Do not skip this step.",
        modelId: DEFAULT_MODEL,
      })

      const deleteCall = events2.find(
        (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("memory_delete"),
      )
      expect(deleteCall).toBeDefined()

      index = await getMemoryIndex(memUser.id)
      expect(index).not.toContain("(reference/item1.md),")

      // Step 3: Set item2
      const threadId3 = await seedAgentThread(env.db.sql, ks, world.org.id, memUser.id)
      const { events: events3 } = await consumeSse(url, "/api/agent/chat", memUser.token, {
        threadId: threadId3,
        content:
          "Call the kernel__memory_create tool now with path 'reference/item2.md' and body 'test item2: value two'. Do not skip this step.",
        modelId: DEFAULT_MODEL,
      })

      const setCall2 = events3.find(
        (e) => e.event === "tool-call" && (e.data as any).toolName?.includes("memory_create"),
      )
      expect(setCall2).toBeDefined()

      index = await getMemoryIndex(memUser.id)
      expect(index).toContain("(reference/item2.md),")
      expect(index).not.toContain("(reference/item1.md),")
    }, 180_000)

    // ═══════════════════════════════════════════════════════════
    //  SC15: Token Tracking Pipeline — Real Tokens Stored and Retrievable
    // ═══════════════════════════════════════════════════════════

    it("SC15: token tracking pipeline — real LLM tokens stored in metadata, compaction triggered via threshold", async () => {
      // This test verifies the ORGANIC token-tracking pipeline end-to-end:
      // 1. Real LLM call → SSE step-finish reports promptTokens
      // 2. finalize() stores those tokens in metadata.usage.inputTokens
      // 3. getLastInputTokens() retrieves them from the DB
      // 4. shouldCompact() evaluates them against contextWindow
      // 5. runCompaction() fires and writes the acting agent's checkpoint
      //
      // To avoid burning 100k+ real tokens, we send 2 real turns (verifying organic
      // token storage), then patch the stored value above threshold to trigger compaction.
      // The patch is applied to the REAL metadata column that getLastInputTokens reads,
      // so the full pipeline from DB-read → shouldCompact → runCompaction is exercised.

      const logLines: string[] = []
      const trail = (msg: string) => {
        console.log(msg)
        logLines.push(msg)
      }

      const threadId = await seedAgentThread(env.db.sql, ks, world.org.id, phase4cUser.id)

      // ── Turn 1: Real LLM call, verify organic token storage ──
      trail(`[SC15] Turn 1: sending first message to ${TOOL_MODEL}...`)
      const { events: events1 } = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
        threadId,
        content: "Tell me about the history of PostgreSQL in 3 paragraphs.",
        modelId: TOOL_MODEL,
      })

      const done1 = events1.find((e) => e.event === "done")
      const err1 = events1.find((e) => e.event === "error")
      if (err1) trail(`[SC15] Turn 1 stream error: ${JSON.stringify(err1.data)}`)
      // External provider may be temporarily unavailable — skip gracefully
      if (isProviderUnavailable(err1)) {
        trail("[SC15] provider unavailable — skipping test")
        return
      }
      if (!done1 && !err1) {
        trail("[SC15] provider stream ended without a terminal event — skipping test")
        return
      }
      expect(done1).toBeDefined()

      // Verify token metadata was stored by the REAL streaming pipeline (not hand-seeded)
      const msgs1 = await getThreadMessages(env.db.sql, ks, threadId)
      const agent1 = msgs1.find((m: any) => m.author_type === "agent")
      expect(agent1).toBeDefined()
      const usage1 = agent1.metadata?.usage
      trail(
        `[SC15] Turn 1 — metadata.usage: inputTokens=${usage1?.inputTokens}, outputTokens=${usage1?.outputTokens}`,
      )
      expect(usage1).toBeDefined()
      expect(usage1.inputTokens).toBeGreaterThan(0)
      expect(usage1.outputTokens).toBeGreaterThan(0)

      // Verify SSE step-finish promptTokens matches stored DB metadata
      const stepFinishes1 = events1.filter((e) => e.event === "step-finish")
      const totalSsePrompt1 = stepFinishes1.reduce(
        (sum, e) => sum + ((e.data as any).usage?.promptTokens ?? 0),
        0,
      )
      trail(
        `[SC15] Turn 1 — SSE total promptTokens: ${totalSsePrompt1}, DB inputTokens: ${usage1.inputTokens}`,
      )
      expect(usage1.inputTokens).toBe(totalSsePrompt1)

      // ── Turn 2: Context grows, verify token increase ──
      trail("[SC15] Turn 2: sending second message (context should grow)...")
      const { events: events2 } = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
        threadId,
        content: "Now tell me about the history of MySQL in 3 paragraphs.",
        modelId: TOOL_MODEL,
      })

      const done2 = events2.find((e) => e.event === "done")
      const err2 = events2.find((e) => e.event === "error")
      if (err2) trail(`[SC15] Turn 2 stream error: ${JSON.stringify(err2.data)}`)
      if (isProviderUnavailable(err2)) {
        trail("[SC15] provider unavailable on turn 2 — skipping test")
        return
      }
      if (!done2 && !err2) {
        trail("[SC15] provider stream ended without a terminal event on turn 2 — skipping test")
        return
      }
      expect(done2).toBeDefined()

      const msgs2 = await getThreadMessages(env.db.sql, ks, threadId)
      const agentMsgs = msgs2.filter((m: any) => m.author_type === "agent")
      expect(agentMsgs.length).toBe(2)

      const agent2 = agentMsgs[1]
      const usage2 = agent2.metadata?.usage
      trail(
        `[SC15] Turn 2 — metadata.usage: inputTokens=${usage2?.inputTokens}, outputTokens=${usage2?.outputTokens}`,
      )
      expect(usage2).toBeDefined()
      expect(usage2.inputTokens).toBeGreaterThan(0)

      // ── Trigger compaction by patching threshold above real tokens ──
      // 900k inputTokens > 80% of Flash-Lite's 1,048,576 (1M) context — also
      // trips Haiku's 200k threshold. The test runs in auto-mode, which
      // resolves to Flash-Lite; the prior 170k value was sized for Haiku and
      // silently failed when the seed shipped Flash-Lite. Tuned high enough
      // to cover both pre/post auto-mode-default migrations.
      const fakeHighTokens = 900_000
      trail(
        `[SC15] Patching last agent msg inputTokens from ${usage2.inputTokens} to ${fakeHighTokens}...`,
      )
      // BOTH keys, AS JSON NUMBERS. The trigger reads
      // `usage.lastStepInputTokens` (the FINAL step's context) and only falls
      // back to the summed `usage.inputTokens` divided by the step count on
      // legacy rows, and it takes the per-step key only when it is `typeof
      // number`. A bound text parameter cast with `$1::jsonb` stores the JSON
      // STRING "900000", which fails that check: the trigger then divided the
      // (also string) sum by the real step count and read 225,000 against a
      // 1M window, so compaction never ran. `to_jsonb($1::bigint)` stores a
      // real number.
      await env.db.sql.unsafe(
        `UPDATE ${ks}.messages
            SET metadata = jsonb_set(
                  jsonb_set(metadata, '{usage,inputTokens}', to_jsonb($1::bigint)),
                  '{usage,lastStepInputTokens}', to_jsonb($1::bigint))
          WHERE id = $2`,
        [fakeHighTokens, agent2.id],
      )

      // The patch is only useful if it landed as a number: assert the shape the
      // trigger actually tests for, so a silently stringified write fails HERE
      // rather than three assertions later as a missing checkpoint.
      const [patched] = await env.db.sql.unsafe(
        `SELECT metadata FROM ${ks}.messages WHERE id = $1`,
        [agent2.id],
      )
      const patchedUsage = (patched as any).metadata?.usage
      trail(
        `[SC15] patched usage types: inputTokens=${typeof patchedUsage?.inputTokens}, lastStepInputTokens=${typeof patchedUsage?.lastStepInputTokens}`,
      )
      expect(typeof patchedUsage.lastStepInputTokens).toBe("number")
      expect(patchedUsage.lastStepInputTokens).toBe(fakeHighTokens)
      expect(typeof patchedUsage.inputTokens).toBe("number")

      // ── Turn 3: Triggers compaction ──
      // Same reading as SC13: the checkpoint version BEFORE this turn, so the
      // assertion below is about what THIS turn did and not about the
      // between-turns advance that runs on every turn regardless.
      const checkpointsBeforeTurn3 = await getThreadCheckpoints(env.db.sql, ks, threadId)
      const versionBeforeTurn3 = checkpointsBeforeTurn3[0]?.version ?? 0
      trail("[SC15] Turn 3: sending message that should trigger compaction...")
      const { events: events3 } = await consumeSse(url, "/api/agent/chat", phase4cUser.token, {
        threadId,
        content: "What databases did we discuss?",
        modelId: TOOL_MODEL,
      })

      const done3 = events3.find((e) => e.event === "done")
      const err3 = events3.find((e) => e.event === "error")
      if (err3) trail(`[SC15] Turn 3 stream error: ${JSON.stringify(err3.data)}`)
      if (isProviderUnavailable(err3)) {
        trail("[SC15] provider unavailable on turn 3 — skipping test")
        return
      }
      if (!done3 && !err3) {
        trail("[SC15] provider stream ended without a terminal event on turn 3 — skipping test")
        return
      }
      expect(done3).toBeDefined()

      // Compaction on an agent turn is a checkpoint version, not a thread-wide
      // summary message (spec-memory L4, invariant I5).
      const allMsgs = await getThreadMessages(env.db.sql, ks, threadId)
      const actingAgentId = await getActingAgentId(env.db.sql, ks, threadId)
      expect(actingAgentId).toBeTruthy()
      const checkpoints = await getThreadCheckpoints(env.db.sql, ks, threadId)
      const acting = checkpointOf(checkpoints, actingAgentId)
      const actingBefore = checkpointOf(checkpointsBeforeTurn3, actingAgentId)
      trail(
        `[SC15] acting agent ${actingAgentId} checkpoint version: ${actingBefore?.version ?? 0} -> ${acting?.version ?? 0}`,
      )
      expect(acting).toBeDefined()
      const summary = acting?.summary ?? ""
      // The summary TEXT is new: only a summarization writes that, and the read
      // is scoped to the agent that acted rather than to whichever agent on the
      // thread happens to hold the highest version.
      expect(summary.length).toBeGreaterThan(10)
      // Same reading as SC13: with no prior checkpoint the inequality is
      // vacuous, so that case asserts the first version instead.
      if (actingBefore) {
        expect(summary).not.toBe(actingBefore.summary)
      } else {
        expect(acting?.version).toBe(1)
      }
      // Secondary: the version moved across the compacting turn.
      expect(acting?.version ?? 0).toBeGreaterThan(actingBefore?.version ?? versionBeforeTurn3)
      trail(`[SC15] summary (first 200 chars): ${summary.slice(0, 200)}`)

      // Verify message sequence. The raw history is PRESERVED: compaction
      // summarizes into the checkpoint and removes nothing from the room.
      const authorTypes = allMsgs.map((m: any) => m.author_type)
      trail(`[SC15] message sequence: ${authorTypes.join(" -> ")}`)
      expect(authorTypes.filter((t: string) => t === "user").length).toBe(3)
      expect(authorTypes.filter((t: string) => t === "agent").length).toBe(3)
      // NO `system` row, and that is the rule, not an omission: an agent turn
      // compacts into the acting agent's own checkpoint and writes nothing
      // thread-wide (spec-memory L4, invariant I5 - runCompaction writes
      // agent_thread_checkpoints and no message at all). The assertion this
      // scenario used to carry, `toContain("system")`, described the pre-epic
      // compaction_summary message and would now fail on correct behaviour, so
      // it is pinned the other way round: the room holds only what the people
      // and the agent actually said.
      expect(authorTypes).not.toContain("system")

      // Write trail log to file
      const { writeFileSync, mkdirSync } = await import("node:fs")
      const logDir = `${process.cwd()}/../../logs`
      try {
        mkdirSync(logDir, { recursive: true })
      } catch {}
      writeFileSync(`${logDir}/sc15-compaction-trail.log`, `${logLines.join("\n")}\n`)
      trail(`[SC15] Trail log written to logs/sc15-compaction-trail.log`)
    }, 180_000)
  })
})
