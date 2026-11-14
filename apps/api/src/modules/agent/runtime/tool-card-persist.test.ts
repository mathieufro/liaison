// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool's result card, through a real agent turn: the model's tokens are scripted, the tool runs
// through the real bridge, and the row is read back as a reload reads it. Then the card's life
// after the turn: a person's card action replacing it, a newer card of the same key, an app
// removing its own cards, and what the next turn sends the model.

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { z } from "zod"
import { app } from "~/app"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import * as eventBusModule from "~/infra/events/event-bus"
import { advanceCheckpoint } from "~/modules/agent/context/checkpoint"
import {
  clearScriptedTurns,
  setScriptedTurn,
} from "~/modules/agent/providers/scripted-model-provider"
import {
  AgentServiceTestAccess,
  invokeAgentForThread,
  withPriorSteps,
} from "~/modules/agent/runtime/agent-service"
import { foldTurn } from "~/modules/agent/runtime/stream-fold"
import { AgentStreamRegistryTestAccess } from "~/modules/agent/runtime/stream-registry"
import {
  clearToolCardsByKey,
  replaceToolCard,
  type StoredToolCall,
  ToolCardStoreTestAccess,
  withToolCardFieldsOnSteps,
} from "~/modules/agent/runtime/tool-card-store"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { sendMessage } from "~/modules/threads/message"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MODEL_ID = "claude-haiku-4-5-tool-card"
/** In a card's fixed label only, so finding it anywhere proves a card travelled there. */
const CARD_ONLY = "Pill-only-in-the-card"
const READ_SCOPE = "cardy:items:read"

type Stored = StoredToolCall & { args: unknown; status?: string }
type Frame = { entity: string; action: string; data?: Record<string, unknown> }

let orgId: string
let userId: string
let token: string
let strangerToken: string
let threadId: string
let agentId: string
let updateRuns = 0
let strictReceived: unknown
let updateResult: () => unknown | Promise<unknown> = () => ({
  id: "item-1",
  title: "After the click",
})

const entityCard = {
  kind: "entity",
  pill: { label: CARD_ONLY },
  title: "{{result.title}}",
}
const keyedCard = (key: string) => ({
  kind: "groups",
  pill: { label: CARD_ONLY },
  title: "{{result.title}}",
  columns: [],
  groups: {
    path: "result.groups",
    label: "{{group.name}}",
    rows: { path: "group.rows", id: "row.id", name: "{{row.name}}", cells: {} },
  },
  latestKey: key,
  supersededLabel: { label: "First version" },
})

function registerFixtures(): void {
  manifestRegistry.set([orgId, "cardy"], { name: "cardy", displayName: "Cardy" } as never)
  const tool = (appName: string, name: string, def: Record<string, unknown>) =>
    toolRegistry.set([orgId, appName, name], {
      appName,
      name,
      description: `Card fixture ${name}`,
      requiredScopes: [READ_SCOPE],
      params: z.object({}).passthrough(),
      handler: async () => ({ id: "item-1", title: "A title" }),
      ...def,
    } as never)
  tool("cardy", "get", {
    readOnly: true,
    runningLabel: "Reading items",
    resultCard: entityCard,
  })
  // Over the model's cap even after its long strings are cut: stored as `truncatedResult`.
  tool("cardy", "big", {
    readOnly: true,
    deferLoading: false,
    resultCard: entityCard,
    handler: async () => ({
      title: "A large result",
      rows: Array.from({ length: 4000 }, (_, i) => ({ id: `row-${i}`, note: "x".repeat(30) })),
    }),
  })
  tool("cardy", "keyed", {
    readOnly: true,
    resultCard: keyedCard("month-end"),
    handler: async () => ({
      title: "Month end",
      groups: [{ name: "Work", rows: [{ id: "line-1", name: "A line" }] }],
    }),
  })
  tool("cardy", "update", {
    // The card it draws offers the same call again, so a second click acts from the new card.
    resultCard: {
      ...entityCard,
      actions: [
        { kind: "tool", label: { label: "Again" }, tool: "update", params: { id: "result.id" } },
      ],
    },
    handler: async () => {
      updateRuns++
      const out = await updateResult()
      if (out instanceof Error) throw out
      return out
    },
  })
  tool("cardy", "broken", {
    readOnly: true,
    resultCard: entityCard,
    handler: async () => {
      throw Object.assign(new Error("the upstream refused"), { status: 502, code: "upstream" })
    },
  })
  tool("cardy", "refuses", {
    readOnly: true,
    resultCard: entityCard,
    handler: async () => ({ error: "Nothing to read here" }),
  })
  tool("cardy", "strict", {
    params: z.object({ id: z.string() }).strict(),
    resultCard: entityCard,
    handler: async (params: unknown) => {
      strictReceived = params
      return { title: "Strict" }
    },
  })
  tool("cardy", "plain", {
    handler: async () => {
      updateRuns++
      return { ok: true }
    },
  })
  tool("cardy", "wider", {
    requiredScopes: ["cardy:secrets:read"],
    resultCard: entityCard,
    handler: async () => ({ title: "Wider than the row" }),
  })
  tool("otherapp", "update", { resultCard: entityCard })
  // Not one of mail's envelope-only tools, and names no account: redaction fails closed.
  tool("mail", "read", {
    readOnly: true,
    resultCard: { kind: "entity", pill: { label: "Mail" }, title: "{{result.subject}}" },
    handler: async () => ({ subject: "Sealed subject line", body: "Sealed body" }),
  })
}

/** A scripted model: one step per call, each run through the tool the real bridge built. */
function scriptedTurn(
  calls: Array<{ id: string; tool: string }>,
  capture?: { messages?: unknown },
) {
  return ((params: { tools: Record<string, any>; messages: unknown }) => {
    if (capture) capture.messages = params.messages
    return {
      fullStream: (async function* () {
        for (const call of calls) {
          yield { type: "tool-call", toolCallId: call.id, toolName: call.tool, input: {} }
          try {
            const output = await params.tools[call.tool]?.execute?.(
              {},
              { toolCallId: call.id, messages: [] },
            )
            yield { type: "tool-result", toolCallId: call.id, toolName: call.tool, output }
          } catch (error) {
            // What the SDK turns a throw past the bridge into.
            yield { type: "tool-error", toolCallId: call.id, toolName: call.tool, error }
          }
          yield {
            type: "finish-step",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        }
        yield { type: "text-delta", text: "Done." }
        yield {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        }
        yield { type: "finish", finishReason: "stop" }
      })(),
    }
  }) as never
}

async function postTrigger(thread = threadId): Promise<string> {
  const msg = await withPrivilegedDb(orgId, "test-tool-card-trigger", (tx) =>
    sendMessage(tx as unknown as RlsClient, {
      requiredScopes: [],
      orgId,
      userId,
      threadId: thread,
      content: "Show me the item",
      authorType: "user",
    }),
  )
  if (!msg) throw new Error("could not post the trigger")
  return msg.id
}

async function runTurn(
  calls: Array<{ id: string; tool: string }>,
  opts: { capture?: { messages?: unknown }; trigger?: string; thread?: string } = {},
): Promise<{ frames: Frame[]; row: { id: string; metadata: { toolCalls?: Stored[] } } }> {
  const thread = opts.thread ?? threadId
  const trigger = opts.trigger ?? (await postTrigger(thread))
  const frames: Frame[] = []
  const spy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async (event) => {
    frames.push(event as Frame)
  })
  AgentServiceTestAccess.setStreamText(scriptedTurn(calls, opts.capture))
  try {
    await invokeAgentForThread(
      thread,
      trigger,
      { userId, orgId, scopes: ["*"], dimensionGrants: {} },
      orgId,
    )
  } finally {
    spy.mockRestore()
    AgentServiceTestAccess.setStreamText()
  }
  const [row] = await sql<{ id: string; metadata: { toolCalls?: Stored[] } }[]>`
    SELECT id, metadata FROM kernel.messages
    WHERE thread_id = ${thread} AND author_type = 'agent'
    ORDER BY created_at DESC LIMIT 1`
  if (!row) throw new Error("the turn stored no reply")
  return { frames, row }
}

const liveCall = (frames: Frame[], id: string) => {
  const stream = frames.filter((f) => f.entity === "agent_stream")
  const data = (action: string) =>
    stream.find((f) => f.action === action && f.data?.toolCallId === id)?.data
  return { call: data("tool_call"), result: data("tool_result") }
}

/** The card a seeded row holds: the actions and the edit the tests below click. */
const toolAction = (tool: string, params: Record<string, string | number> = {}) => ({
  kind: "tool",
  label: { label: tool },
  tool,
  params,
})
const SEEDED_CARD = {
  kind: "entity",
  pill: { label: "P" },
  title: "Before",
  actions: [
    toolAction("update", { id: "item-1" }),
    toolAction("update"),
    toolAction("strict", { id: "a" }),
    toolAction("plain"),
    toolAction("wider"),
  ],
  groups: [
    {
      label: "Lines",
      rows: [{ id: "line-1", name: "A line", cells: {}, links: [], edit: { qty: { value: 1 } } }],
    },
  ],
  edit: {
    openLabel: { label: "Edit" },
    doneLabel: { label: "Done" },
    tool: "update",
    params: { id: "item-1" },
    rowParam: "line",
    fields: [{ param: "qty", label: { label: "Qty" }, kind: "quantity" }],
  },
}
/** An edit of the seeded card's one line. */
const editQty = (qty: number) => ({ id: "item-1", line: "line-1", qty })

/** A stored agent row holding one card, stamped as a turn that read `READ_SCOPE` stamps it. */
async function seedCard(opts: {
  toolName?: string
  card?: unknown
  requiredScopes?: string[]
  thread?: string
  extra?: Record<string, unknown>
}): Promise<{ messageId: string; toolCallId: string }> {
  const toolCallId = crypto.randomUUID()
  const metadata = {
    usage: { inputTokens: 7 },
    toolCalls: [
      {
        toolCallId,
        toolName: opts.toolName ?? "cardy__get",
        args: {},
        result: { id: "item-1", title: "Before" },
        status: "completed",
        ...(opts.card === null ? {} : { card: opts.card ?? SEEDED_CARD }),
        ...opts.extra,
      },
    ],
  }
  const [row] = await sql.unsafe<{ id: string }[]>(
    insertSql(
      "kernel.messages",
      {
        thread_id: opts.thread ?? threadId,
        org_id: orgId,
        author_id: userId,
        author_type: "agent",
        author_agent_id: agentId,
        content: "Seeded",
        required_scopes: `{${(opts.requiredScopes ?? [READ_SCOPE]).join(",")}}`,
        metadata: JSON.stringify(metadata),
      },
      { returning: "id" },
    ),
  )
  return { messageId: row?.id as string, toolCallId }
}

async function storedCall(messageId: string, toolCallId: string): Promise<Stored | undefined> {
  const [row] = await sql<{ metadata: { toolCalls?: Stored[] } }[]>`
    SELECT metadata FROM kernel.messages WHERE id = ${messageId}`
  return row?.metadata.toolCalls?.find((tc) => tc.toolCallId === toolCallId)
}

function post(path: string, body: unknown, bearer = token) {
  return app.request(`/api/apps/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
  orgId = (await createTestOrg()).id
  const admin = await minimal.orgAdmin(orgId)
  userId = admin.id
  await minimal.grantScope(userId, READ_SCOPE)
  await minimal.grantScope(userId, "cardy:secrets:read")
  token = await minimal.token(userId)
  const stranger = await minimal.person(orgId)
  await minimal.grantScope(stranger.id, READ_SCOPE)
  strangerToken = await minimal.token(stranger.id)
  threadId = await minimal.thread(orgId, userId)
  const [agent] = await sql<{ id: string }[]>`
    SELECT id FROM kernel.agents WHERE org_id = ${orgId} AND owner_user_id = ${userId} LIMIT 1`
  agentId = agent?.id as string
  registerFixtures()
  await sql.unsafe(
    insertSql(
      "kernel.credit_balances",
      { org_id: orgId, included_balance: "10.00000000", purchased_balance: "0", currency: "EUR" },
      { onConflictDoNothing: true },
    ),
  )
  await sql`UPDATE kernel.credit_balances SET included_balance = '10.00000000' WHERE org_id = ${orgId}`
  await sql.unsafe(
    insertSql(
      "kernel.model_pricing",
      {
        provider: "anthropic",
        model_id: MODEL_ID,
        display_name: "Tool card fixture",
        input_cost_per_m: "1.00",
        output_cost_per_m: "5.00",
        context_window: 200000,
        auto_eligible: true,
        tier_minimum: "starter",
      },
      { onConflictDoNothing: true },
    ),
  )
})

afterEach(() => {
  ToolCardStoreTestAccess.setResolver()
  updateRuns = 0
  updateResult = () => ({ id: "item-1", title: "After the click" })
})

afterAll(async () => {
  AgentServiceTestAccess.setStreamText()
  for (const a of ["cardy", "otherapp", "mail"]) toolRegistry.deleteByPrefix([orgId, a])
  manifestRegistry.delete([orgId, "cardy"])
  await AgentStreamRegistryTestAccess.reset()
  await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
  await releaseTestLock()
})

describe("a card through a real turn", () => {
  it("a real agent turn persists card; reload deep-equals live when the result is clipped to truncatedResult", async () => {
    const { frames, row } = await runTurn([{ id: "big-1", tool: "cardy__big" }])
    const stored = row.metadata.toolCalls?.[0]
    expect(JSON.stringify(stored?.result)).toContain("truncatedResult")
    expect(stored?.card).toEqual({
      kind: "entity",
      pill: { label: CARD_ONLY },
      title: "A large result",
    })
    expect(stored?.card).toEqual(liveCall(frames, "big-1").result?.card as never)
  })

  it("reload deep-equals live for readOnly, appLabel, runningLabel and card", async () => {
    const { frames, row } = await runTurn([{ id: "get-1", tool: "cardy__get" }])
    const stored = row.metadata.toolCalls?.[0] as Stored
    const live = liveCall(frames, "get-1")
    expect(stored.readOnly).toBe(true)
    expect(stored.appLabel).toBe("Cardy")
    expect(stored.runningLabel).toBe("Reading items")
    expect({
      readOnly: stored.readOnly,
      appLabel: stored.appLabel,
      runningLabel: stored.runningLabel,
      card: stored.card,
    }).toEqual({
      readOnly: live.call?.readOnly as boolean,
      appLabel: live.call?.appLabel as string,
      runningLabel: live.call?.runningLabel as string,
      card: live.result?.card as never,
    })
  })

  it("the live fold keeps the card and the row's facts for a late joiner", () => {
    const at = 1
    const entry = (seq: number, action: string, data: Record<string, unknown>) => ({
      seq,
      action,
      at,
      data,
      itemId: "c1",
      scopes: null,
    })
    const snap = foldTurn(
      {
        threadId: "t",
        agentId: null,
        turnId: "x",
        askId: null,
        orgId: "o",
        requesterId: null,
        lastSeenAt: at,
      } as never,
      [
        entry(1, "tool_call", {
          toolCallId: "c1",
          toolName: "cardy__get",
          args: {},
          readOnly: true,
          appLabel: "Cardy",
          runningLabel: "Reading items",
        }),
        entry(2, "tool_result", {
          toolCallId: "c1",
          result: { title: "T" },
          card: { kind: "entity", pill: { label: "P" }, title: "T" },
        }),
      ] as never,
    )
    expect(snap.toolCalls[0]).toMatchObject({
      readOnly: true,
      appLabel: "Cardy",
      runningLabel: "Reading items",
      card: { title: "T" },
    })
  })

  it("a sealed mail value never reaches a card", async () => {
    const { frames, row } = await runTurn([{ id: "mail-1", tool: "mail__read" }])
    const stored = row.metadata.toolCalls?.[0] as Stored
    expect(stored.card).toBeUndefined()
    expect(JSON.stringify(stored)).not.toContain("Sealed subject line")
    expect(JSON.stringify(liveCall(frames, "mail-1").result)).not.toContain("Sealed subject line")
  })

  it("resolveToolCard throwing leaves the turn running, card null", async () => {
    ToolCardStoreTestAccess.setResolver(() => {
      throw new Error("a resolver bug")
    })
    const { row } = await runTurn([{ id: "throw-1", tool: "cardy__get" }])
    const stored = row.metadata.toolCalls?.[0] as Stored
    expect(stored.card ?? null).toBeNull()
    expect(stored.status).toBe("completed")
    expect(stored.result).toEqual({ id: "item-1", title: "A title" })
  })

  it("a result carrying an error stores the template's pill as cardError, with no card", async () => {
    const { row } = await runTurn([{ id: "err-2", tool: "cardy__refuses" }])
    const stored = row.metadata.toolCalls?.[0] as Stored
    expect(stored.card).toBeUndefined()
    expect(stored.cardError).toEqual({ pill: { label: CARD_ONLY } })
  })

  it("a tool's error result stores the template's pill as cardError, with no card", async () => {
    const { frames, row } = await runTurn([{ id: "err-1", tool: "cardy__broken" }])
    const stored = row.metadata.toolCalls?.[0] as Stored
    expect(stored.card).toBeUndefined()
    expect(stored.cardError).toEqual({ pill: { label: CARD_ONLY } })
    expect(liveCall(frames, "err-1").result?.cardError).toEqual({ pill: { label: CARD_ONLY } })
  })
})

describe("a card on the other paths a turn takes", () => {
  it("the real stream keeps the whole result reachable for the card when the bridge clipped it", async () => {
    const thread = await minimal.thread(orgId, userId)
    const trigger = await postTrigger(thread)
    process.env.LIAISON_MODEL_PROVIDER = "scripted"
    try {
      await setScriptedTurn(thread, [{ toolCalls: [{ name: "cardy__big" }] }, { text: "Done." }])
      await invokeAgentForThread(
        thread,
        trigger,
        { userId, orgId, scopes: ["*"], dimensionGrants: {} },
        orgId,
      )
    } finally {
      await clearScriptedTurns(thread)
      delete process.env.LIAISON_MODEL_PROVIDER
    }
    const [row] = await sql<{ metadata: { toolCalls?: Stored[] } }[]>`
      SELECT metadata FROM kernel.messages
      WHERE thread_id = ${thread} AND author_type = 'agent' ORDER BY created_at DESC LIMIT 1`
    const stored = row?.metadata.toolCalls?.[0]
    expect(JSON.stringify(stored?.result)).toContain("truncatedResult")
    expect(stored?.card?.title).toBe("A large result")
  })

  it("the chat route streams and stores the card, and redacts what it streams and stores", async () => {
    const thread = await minimal.thread(orgId, userId)
    AgentServiceTestAccess.setStreamText(
      scriptedTurn([
        { id: "sse-1", tool: "cardy__get" },
        { id: "sse-2", tool: "mail__read" },
      ]),
    )
    let streamed = ""
    try {
      const res = await app.request("/api/agent/chat", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ threadId: thread, content: "Show me the item" }),
      })
      expect(res.status).toBe(200)
      streamed = await res.text()
    } finally {
      AgentServiceTestAccess.setStreamText()
    }
    expect(streamed).toContain(CARD_ONLY)
    expect(streamed).toContain('"appLabel":"Cardy"')
    expect(streamed).not.toContain("Sealed subject line")
    const [row] = await sql<{ metadata: { toolCalls?: Stored[] } }[]>`
      SELECT metadata FROM kernel.messages
      WHERE thread_id = ${thread} AND author_type = 'agent' ORDER BY created_at DESC LIMIT 1`
    const calls = row?.metadata.toolCalls ?? []
    expect(calls.find((c) => c.toolCallId === "sse-1")?.card?.title).toBe("A title")
    expect(calls.find((c) => c.toolCallId === "sse-1")?.appLabel).toBe("Cardy")
    expect(JSON.stringify(calls)).not.toContain("Sealed subject line")
  })

  it("a resumed turn keeps the card and the row's facts of the steps its earlier attempt ran", async () => {
    const views = await withToolCardFieldsOnSteps(orgId, [
      {
        text: "",
        reasoning: "",
        timeline: [],
        toolCalls: [{ toolCallId: "res-1", toolName: "cardy__get", args: {} }],
        toolResults: [{ toolCallId: "res-1", result: { id: "item-1", title: "From the journal" } }],
        toolErrors: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ] as never)
    const merged = withPriorSteps(
      {
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: "stop",
        text: "",
        steps: [],
      },
      views as never,
    )
    const [stored] = AgentServiceTestAccess.extractToolCalls(merged.steps as never)
    expect(stored?.card?.title).toBe("From the journal")
    expect(stored?.appLabel).toBe("Cardy")
    expect(stored?.readOnly).toBe(true)
  })
})

describe("what the model is sent", () => {
  it("the next turn's captured provider payload is byte-equal with and without a stored card", async () => {
    const thread = await minimal.thread(orgId, userId)
    await runTurn([{ id: "pay-1", tool: "cardy__get" }], { thread })
    const trigger = await postTrigger(thread)
    const withCard: { messages?: unknown } = {}
    const second = await runTurn([], { thread, trigger, capture: withCard })
    await sql`DELETE FROM kernel.messages WHERE id = ${second.row.id}`
    await sql`
      UPDATE kernel.messages m SET metadata = jsonb_set(m.metadata, '{toolCalls}', (
        SELECT jsonb_agg(tc - 'card' - 'readOnly' - 'appLabel' - 'runningLabel')
        FROM jsonb_array_elements(m.metadata -> 'toolCalls') tc))
      WHERE m.thread_id = ${thread} AND m.metadata ? 'toolCalls'`
    const withoutCard: { messages?: unknown } = {}
    await runTurn([], { thread, trigger, capture: withoutCard })
    // The request's tail names the time it was sent, the one thing that differs between runs.
    const sent = (c: { messages?: unknown }) =>
      JSON.stringify(c.messages).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<now>")
    expect(sent(withCard)).toContain("A title")
    expect(sent(withCard)).not.toContain(CARD_ONLY)
    expect(sent(withCard)).toBe(sent(withoutCard))
  })

  it("the checkpoint carries no card text", async () => {
    const thread = await minimal.thread(orgId, userId)
    await runTurn([{ id: "chk-1", tool: "cardy__get" }], { thread })
    await runTurn([{ id: "chk-2", tool: "cardy__get" }], { thread })
    await runTurn([{ id: "chk-3", tool: "cardy__get" }], { thread })
    const [seat] = await sql<{ agent_id: string }[]>`
      SELECT author_agent_id AS agent_id FROM kernel.messages
      WHERE thread_id = ${thread} AND author_type = 'agent' LIMIT 1`
    let briefInput = ""
    const result = await advanceCheckpoint({
      threadId: thread,
      agentId: seat?.agent_id,
      orgId,
      actor: { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} },
      force: true,
      tailReserveTokens: 0,
      beforeSummary: async () => true,
      writer: async ({ messages }: { messages: unknown }) => {
        briefInput = JSON.stringify(messages)
        return "A brief of the conversation."
      },
    } as never)
    expect(result.advanced).toBe(true)
    expect(briefInput).toContain("cardy__get")
    expect(briefInput).not.toContain(CARD_ONLY)
  })
})

describe("replacing a stored card", () => {
  it("cardRef overwrites from the tool's own resultCard", async () => {
    const seeded = await seedCard({ toolName: "cardy__get" })
    const res = await post("cardy/tools/update", { id: "item-1", cardRef: seeded })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown; meta: Record<string, unknown> }
    expect(body.data).toEqual({ id: "item-1", title: "After the click" })
    expect(body.meta.cardStored).toBe(true)
    expect(body.meta.cardRevision).toBe(2)
    const stored = await storedCall(seeded.messageId, seeded.toolCallId)
    expect(stored?.card?.title).toBe("After the click")
    expect(stored?.card).toEqual(body.meta.card as never)
    expect(stored?.cardRevision).toBe(2)
    // The result stays what the model saw, so the history replays unchanged.
    expect(stored?.result).toEqual({ id: "item-1", title: "Before" })
  })

  it("a card action sends the update other readers apply, with the calls and not the whole metadata", async () => {
    const seeded = await seedCard({})
    const res = await post("cardy/tools/update", { id: "item-1", cardRef: seeded })
    expect(res.status).toBe(200)
    const [queued] = await sql<{ event: { action: string; data: Record<string, unknown> } }[]>`
      SELECT payload AS event FROM kernel.pending_events
      WHERE payload ->> 'entityId' = ${seeded.messageId} AND payload ->> 'entity' = 'message'
      ORDER BY seq DESC LIMIT 1`
    expect(queued?.event.action).toBe("update")
    expect(queued?.event.data.requiredScopes).toEqual([READ_SCOPE])
    expect(JSON.stringify(queued?.event.data.toolCalls)).toContain("After the click")
    expect(queued?.event.data).not.toHaveProperty("metadata")
  })

  it("a cardRef does not reach the tool's parameters", async () => {
    const seeded = await seedCard({})
    const res = await post("cardy/tools/strict", { id: "a", cardRef: seeded })
    expect(res.status).toBe(200)
    expect(strictReceived).toEqual({ id: "a" })
  })

  it("a card action naming a thread other than the card's is 422 and nothing runs", async () => {
    const seeded = await seedCard({})
    const other = await minimal.thread(orgId, userId)
    for (const body of [
      { id: "item-1", threadId: other, cardRef: seeded },
      { params: { id: "item-1" }, threadId: other, cardRef: seeded },
    ]) {
      const res = await post("cardy/tools/update", body)
      expect(res.status).toBe(422)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        "card_action_unknown",
      )
    }
    expect(updateRuns).toBe(0)
    expect((await storedCall(seeded.messageId, seeded.toolCallId))?.card?.title).toBe("Before")
  })

  it("a card action naming the card's own thread gets exactly the offered params", async () => {
    const seeded = await seedCard({})
    const res = await post("cardy/tools/strict", { id: "a", threadId, cardRef: seeded })
    expect(res.status).toBe(200)
    expect(strictReceived).toEqual({ id: "a" })
  })

  it("cardRef in an unreadable thread 404 and unchanged", async () => {
    const seeded = await seedCard({})
    const res = await post("cardy/tools/update", { id: "x", cardRef: seeded }, strangerToken)
    expect(res.status).toBe(404)
    expect(updateRuns).toBe(0)
    expect((await storedCall(seeded.messageId, seeded.toolCallId))?.card?.title).toBe("Before")
  })

  it("another app's tool call 422", async () => {
    const seeded = await seedCard({ toolName: "otherapp__update" })
    const res = await post("cardy/tools/update", { id: "x", cardRef: seeded })
    expect(res.status).toBe(422)
    expect(updateRuns).toBe(0)
    expect((await storedCall(seeded.messageId, seeded.toolCallId))?.card?.title).toBe("Before")
  })

  it("a malformed cardRef refuses before the tool runs", async () => {
    const res = await post("cardy/tools/update", { cardRef: { messageId: "nope" } })
    expect(res.status).toBe(422)
    expect(updateRuns).toBe(0)
  })

  it("one field, stale revision answers card_changed", async () => {
    const seeded = await seedCard({ extra: { cardRevision: 3 } })
    const cardRef = { ...seeded, revision: 2 }
    const res = await post("cardy/tools/update", { ...editQty(4), cardRef })
    expect(res.status).toBe(409)
    expect(updateRuns).toBe(0)
    const body = (await res.json()) as { error: Record<string, any> }
    expect(body.error.code).toBe("card_changed")
    expect(body.error.card.title).toBe("Before")
    expect(body.error.cardRevision).toBe(3)
    expect(body.error.message).toContain("Nothing was saved")
  })

  it("the current revision passes, and the next stale one refuses", async () => {
    const seeded = await seedCard({})
    const first = await post("cardy/tools/update", {
      ...editQty(1),
      cardRef: { ...seeded, revision: 1 },
    })
    expect(first.status).toBe(200)
    const again = await post("cardy/tools/update", {
      ...editQty(2),
      cardRef: { ...seeded, revision: 1 },
    })
    expect(again.status).toBe(409)
    const next = await post("cardy/tools/update", {
      id: "item-1",
      cardRef: { ...seeded, revision: 2 },
    })
    expect(next.status).toBe(200)
    expect(updateRuns).toBe(2)
    expect((await storedCall(seeded.messageId, seeded.toolCallId))?.cardRevision).toBe(3)
  })

  it("a tool refusing with card_changed draws what is stored, unchanged", async () => {
    updateResult = () =>
      Object.assign(new Error("the reconciliation moved on"), { status: 409, code: "card_changed" })
    const seeded = await seedCard({})
    const res = await post("cardy/tools/update", { ...editQty(1), cardRef: seeded })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: Record<string, any> }
    expect(body.error.code).toBe("card_changed")
    expect(body.error.card.title).toBe("Before")
    const stored = await storedCall(seeded.messageId, seeded.toolCallId)
    expect(stored?.card?.title).toBe("Before")
    expect(stored?.cardRevision).toBeUndefined()
  })

  it("a refused value leaves the stored card and answers the tool's own message", async () => {
    updateResult = () =>
      Object.assign(new Error("Quantity must be positive"), { status: 422, code: "bad_quantity" })
    const seeded = await seedCard({})
    const res = await post("cardy/tools/update", { ...editQty(-1), cardRef: seeded })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      "Quantity must be positive",
    )
    expect((await storedCall(seeded.messageId, seeded.toolCallId))?.card?.title).toBe("Before")
  })

  it("a result the template does not fit leaves the stored card, and the answer says so", async () => {
    updateResult = () => ({ id: "item-1" })
    const seeded = await seedCard({})
    const res = await post("cardy/tools/update", { cardRef: seeded })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { meta: Record<string, any> }
    expect(body.meta.cardStored).toBe(false)
    expect(body.meta.why).toBe("did_not_fit")
    expect(body.meta.card.title).toBe("Before")
  })

  it("a tool with no card runs and leaves the stored card", async () => {
    const seeded = await seedCard({})
    const res = await post("cardy/tools/plain", { cardRef: seeded })
    expect(res.status).toBe(200)
    expect(updateRuns).toBe(1)
    const body = (await res.json()) as { meta: Record<string, any> }
    expect(body.meta.cardStored).toBe(false)
    expect(body.meta.why).toBe("no_template")
    expect((await storedCall(seeded.messageId, seeded.toolCallId))?.card?.title).toBe("Before")
  })

  it("a tool reading beyond what the row's readers may read answers the clicker and leaves the row", async () => {
    const seeded = await seedCard({ requiredScopes: [READ_SCOPE] })
    const res = await post("cardy/tools/wider", { cardRef: seeded })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { meta: Record<string, any> }
    expect(body.meta.card.title).toBe("Wider than the row")
    expect(body.meta.cardStored).toBe(false)
    expect(body.meta.why).toBe("wider_than_message")
    expect((await storedCall(seeded.messageId, seeded.toolCallId))?.card?.title).toBe("Before")
  })

  it("a cardRef naming a tool that is not one of the card's actions is 422 and the card is unchanged", async () => {
    const card = { ...SEEDED_CARD, actions: [toolAction("update", { id: "item-1" })] }
    const seeded = await seedCard({ card })
    const res = await post("cardy/tools/plain", { cardRef: seeded })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("card_action_unknown")
    expect(body.error.message).toContain("Nothing ran")
    expect(updateRuns).toBe(0)
    expect((await storedCall(seeded.messageId, seeded.toolCallId))?.card).toEqual(card as never)
  })

  it("a cardRef action with an id other than the card's is 422", async () => {
    const seeded = await seedCard({})
    const res = await post("cardy/tools/update", { id: "item-2", cardRef: seeded })
    expect(res.status).toBe(422)
    expect(updateRuns).toBe(0)
    expect((await storedCall(seeded.messageId, seeded.toolCallId))?.card?.title).toBe("Before")
  })

  it("an edit may change one offered field of one offered row, and nothing else", async () => {
    const seeded = await seedCard({})
    const refused = [
      { ...editQty(2), title: "Rewritten" },
      { ...editQty(2), line: "line-9" },
      { ...editQty(2), id: "item-2" },
      { id: "item-1", line: "line-1" },
    ]
    for (const params of refused) {
      const res = await post("cardy/tools/update", { ...params, cardRef: seeded })
      expect(res.status).toBe(422)
    }
    expect(updateRuns).toBe(0)
    const res = await post("cardy/tools/update", { ...editQty(2), cardRef: seeded })
    expect(res.status).toBe(200)
    expect(updateRuns).toBe(1)
  })

  it("a card on a deleted message is not rewritten", async () => {
    const seeded = await seedCard({})
    await sql`UPDATE kernel.messages SET deleted_at = now() WHERE id = ${seeded.messageId}`
    const replaced = await replaceToolCard(seeded, {
      orgId,
      actorId: userId,
      appName: "cardy",
      toolName: "update",
      result: { id: "item-1", title: "After the click" },
    })
    expect(replaced.stored).toBe(false)
    expect(replaced.why).toBe("gone")
    expect((await storedCall(seeded.messageId, seeded.toolCallId))?.card?.title).toBe("Before")
  })

  it("two edits on the same revision at once: one runs, the other answers card_changed", async () => {
    updateResult = async () => {
      await Bun.sleep(300)
      return { id: "item-1", title: "After the click" }
    }
    const seeded = await seedCard({})
    const cardRef = { ...seeded, revision: 1 }
    const answers = await Promise.all([
      post("cardy/tools/update", { ...editQty(2), cardRef }),
      post("cardy/tools/update", { ...editQty(3), cardRef }),
    ])
    expect(answers.map((r) => r.status).sort()).toEqual([200, 409])
    const lost = answers.find((r) => r.status === 409) as Response
    expect(((await lost.json()) as { error: { code: string } }).error.code).toBe("card_changed")
    expect(updateRuns).toBe(1)
    expect((await storedCall(seeded.messageId, seeded.toolCallId))?.cardRevision).toBe(2)
  })

  it("a call with no cardRef answers as it always did and touches no card", async () => {
    const res = await post("cardy/tools/update", { id: "item-1" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { id: "item-1", title: "After the click" } })
  })
})

describe("cards sharing a key", () => {
  it("of cards sharing a key only the newest stays live", async () => {
    const thread = await minimal.thread(orgId, userId)
    const first = await runTurn([{ id: "key-1", tool: "cardy__keyed" }], { thread })
    expect(first.row.metadata.toolCalls?.[0]?.cardSuperseded).toBeUndefined()
    const second = await runTurn(
      [
        { id: "key-2", tool: "cardy__keyed" },
        { id: "key-3", tool: "cardy__keyed" },
      ],
      { thread },
    )
    expect((await storedCall(first.row.id, "key-1"))?.cardSuperseded).toBe(true)
    expect((await storedCall(second.row.id, "key-2"))?.cardSuperseded).toBe(true)
    expect((await storedCall(second.row.id, "key-3"))?.cardSuperseded).toBeUndefined()
  })

  it("another app's card with the same key stays live", async () => {
    const thread = await minimal.thread(orgId, userId)
    const card = { kind: "entity", pill: { label: "P" }, title: "T", latestKey: "month-end" }
    const other = await seedCard({ thread, toolName: "otherapp__update", card })
    await runTurn([{ id: "key-4", tool: "cardy__keyed" }], { thread })
    const stored = await storedCall(other.messageId, other.toolCallId)
    expect(stored?.cardSuperseded).toBeUndefined()
    const removed = await clearToolCardsByKey({
      orgId,
      actorId: userId,
      threadId: thread,
      app: "cardy",
      key: "month-end",
    })
    expect(removed).toBe(1)
    expect((await storedCall(other.messageId, other.toolCallId))?.card).toEqual(card as never)
  })

  it("an action from a superseded card answers card_changed with the newest card", async () => {
    const thread = await minimal.thread(orgId, userId)
    const old = await seedCard({
      thread,
      card: { kind: "entity", pill: { label: "P" }, title: "Old", latestKey: "k" },
      extra: { cardSuperseded: true },
    })
    await seedCard({
      thread,
      card: { kind: "entity", pill: { label: "P" }, title: "Newest", latestKey: "k" },
    })
    const res = await post("cardy/tools/update", { cardRef: old })
    expect(res.status).toBe(409)
    expect(updateRuns).toBe(0)
    const body = (await res.json()) as { error: Record<string, any> }
    expect(body.error.card.title).toBe("Newest")
  })

  it("clearToolCardsByKey removes card and stored result, fallback row stays", async () => {
    const thread = await minimal.thread(orgId, userId)
    const { row } = await runTurn([{ id: "clear-1", tool: "cardy__keyed" }], { thread })
    const removed = await clearToolCardsByKey({
      orgId,
      actorId: userId,
      threadId: thread,
      app: "cardy",
      key: "month-end",
    })
    expect(removed).toBe(1)
    const stored = (await storedCall(row.id, "clear-1")) as Stored
    expect(stored.card).toBeUndefined()
    expect(stored.result).toBeNull()
    expect(stored.toolName).toBe("cardy__keyed")
    expect(stored.status).toBe("completed")
    const res = await post("cardy/tools/update", {
      cardRef: { messageId: row.id, toolCallId: "clear-1" },
    })
    expect(res.status).toBe(409)
    expect(updateRuns).toBe(0)
  })
})
