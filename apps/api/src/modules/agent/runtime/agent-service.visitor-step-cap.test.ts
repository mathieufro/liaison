// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A demo visitor's turn takes at most LIAISON_DEMO_STEPS_PER_TURN model steps,
// whatever the model does, through the real agent loop (the AI SDK's own
// stopWhen and prepareStep) with a scripted model:
//
// - a model that calls a tool at every step stops at the cap, its last step is
//   the check-in, the call it makes there is not run, and the check-in carries
//   what the turn's tool results show;
// - a turn that ends on an announced action and is corrected spends the
//   correction's steps from the same budget: a correction that ends on an
//   announcement again at the check-in gets no further continuation (live demo:
//   visitor turns ran 9 to 17 steps against a cap of 8).
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Drop the step budget's stop condition and the continuation gates
//    (agent-service.ts, `stepsLeft`): the corrected turn makes a 9th model call.
//  * Answer the check-in from the current stream's steps only: the corrected
//    turn's check-in says no tool was called.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { streamText } from "ai"
import { MockLanguageModelV3 } from "ai/test"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { agents } from "~/db/schema/kernel/agents"
import { userScopeGrants } from "~/db/schema/kernel/roles"
import { threadParticipants, threads } from "~/db/schema/kernel/threads"
import { env } from "~/lib/env"
import {
  noteTokens,
  readGuideNotes,
  THREAD_GUIDE_NOTES_TOKEN_CAP,
} from "~/modules/agent/context/guide-notes"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { TURN_BUDGET_CHECK_IN_NOTE } from "~/modules/agent/runtime/turn-input-budget"
import { toolRegistry } from "~/modules/apps/app-registries"
import { registerDemoAlertMailer } from "~/modules/demo/demo-alerts"
import { DemoBudgetTestAccess } from "~/modules/demo/demo-budget"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo } from "~/modules/demo/demo-org"
import { sendMessage } from "~/modules/threads/message"
import { seedOrgRow, seedUserRows } from "~/seed/factories/org/rows"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-0000-0000-000000f31001"
const USER_ID = "00000000-0000-0000-0000-000000f31002"

const USAGE = {
  inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
}

type Prompt = Array<{ role: string; content: unknown }>
type Reply = { kind: "call"; tool?: string; input?: unknown } | { kind: "text"; text: string }

/** The tool a scripted step calls: a plain read every visitor turn holds. */
const READ_TOOL = "kernel__threads_list"

function streamOf(reply: Reply, n: number) {
  const parts =
    reply.kind === "call"
      ? [
          {
            type: "tool-call" as const,
            toolCallId: `cap-call-${n}`,
            toolName: reply.tool ?? READ_TOOL,
            input: JSON.stringify(reply.input ?? {}),
          },
          {
            type: "finish" as const,
            finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
            usage: USAGE,
          },
        ]
      : [
          { type: "text-start" as const, id: `t${n}` },
          { type: "text-delta" as const, id: `t${n}`, delta: reply.text },
          { type: "text-end" as const, id: `t${n}` },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: USAGE,
          },
        ]
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] })
      for (const p of parts) controller.enqueue(p)
      controller.close()
    },
  })
}

/** A model that answers each call with `pick(prompt, n)`, and records every prompt it saw. */
function scriptedModel(pick: (prompt: Prompt, n: number) => Reply) {
  const prompts: Prompt[] = []
  const model = new MockLanguageModelV3({
    doStream: async (opts: { prompt: unknown }) => {
      const prompt = opts.prompt as Prompt
      prompts.push(prompt)
      return { stream: streamOf(pick(prompt, prompts.length), prompts.length) } as never
    },
  })
  return { model, prompts }
}

const carriesCheckIn = (prompt: Prompt) =>
  JSON.stringify(prompt).includes(TURN_BUDGET_CHECK_IN_NOTE)

const saved = {
  key: process.env.OPENROUTER_API_KEY,
  alert: env.LIAISON_DEMO_ALERT_EMAIL,
  capture: env.LIAISON_DEMO_MAIL_CAPTURE,
  budgets: {
    perEmail: env.LIAISON_DEMO_BUDGET_PER_EMAIL_EUR,
    perNetwork: env.LIAISON_DEMO_BUDGET_PER_NETWORK_EUR,
    daily: env.LIAISON_DEMO_BOX_DAILY_EUR,
    hourly: env.LIAISON_DEMO_BOX_HOURLY_EUR,
  },
}

async function seedThread(): Promise<string> {
  const threadId = crypto.randomUUID()
  await withPrivilegedDb(ORG_ID, "test-cap-thread", async (tx) => {
    await tx.insert(threads).values({
      id: threadId,
      orgId: ORG_ID,
      handle: `cap-${threadId.slice(0, 8)}`,
      type: "agent_chat",
      createdBy: USER_ID,
    })
    await tx.insert(threadParticipants).values({ threadId, userId: USER_ID, orgId: ORG_ID })
  })
  return threadId
}

/** One visitor turn on the scripted model; the stored reply and the prompts the model saw. */
async function visitorTurn(pick: (prompt: Prompt, n: number) => Reply, inThread?: string) {
  const threadId = inThread ?? (await seedThread())
  const msg = await withPrivilegedDb(ORG_ID, "test-cap-msg", (tx) =>
    sendMessage(tx as unknown as RlsClient, {
      requiredScopes: [],
      orgId: ORG_ID,
      userId: USER_ID,
      threadId,
      content: "Break the task into subtasks and create them now.",
      authorType: "user",
    }),
  )
  if (!msg) throw new Error("could not post into the test thread")
  const script = scriptedModel(pick)
  AgentServiceTestAccess.setStreamText(((params: Parameters<typeof streamText>[0]) =>
    streamText({ ...params, model: script.model })) as never)
  try {
    await invokeAgentForThread(
      threadId,
      msg.id,
      { userId: USER_ID, orgId: ORG_ID, scopes: ["*"], dimensionGrants: {} },
      ORG_ID,
    )
  } finally {
    AgentServiceTestAccess.setStreamText()
  }
  const rows = await sql<{ content: string; metadata: { stepCount?: number } }[]>`
    SELECT content, metadata FROM kernel.messages
    WHERE thread_id = ${threadId} AND author_type = 'agent' ORDER BY created_at`
  return { rows, prompts: script.prompts, threadId }
}

/** Apps whose one tool carries a long description: each load of one is a large note. */
const NOTE_APPS = Array.from({ length: 10 }, (_, i) => `capnotes${i}`)

describe("a demo visitor's conversation stays within its budgets", () => {
  beforeAll(async () => {
    await acquireTestLock()
    DemoModeTestAccess.set(true)
    process.env.OPENROUTER_API_KEY = "sk-or-visitor-step-cap-box-key"
    env.LIAISON_DEMO_BUDGET_PER_EMAIL_EUR = 10_000
    env.LIAISON_DEMO_BUDGET_PER_NETWORK_EUR = 10_000
    env.LIAISON_DEMO_BOX_DAILY_EUR = 10_000
    env.LIAISON_DEMO_BOX_HOURLY_EUR = 10_000
    env.LIAISON_DEMO_ALERT_EMAIL = "owner@example.com"
    env.LIAISON_DEMO_MAIL_CAPTURE = true
    registerDemoAlertMailer(async () => {})
    DemoBudgetTestAccess.setVerifiedIdentity(async () => ({
      emailNormalized: `visitor-step-cap-${Date.now()}@example.com`,
      network: "192.0.2.0/24",
    }))
    await seedOrgRow(
      { id: ORG_ID, name: "VisitorStepCapOrg", slug: "visitor-step-cap-org" },
      { onConflict: "skip" },
    )
    await seedUserRows(
      [
        {
          id: USER_ID,
          orgId: ORG_ID,
          email: "visitor-step-cap@visitor.demo.invalid",
          name: "Visitor",
        },
      ],
      { onConflict: "skip" },
    )
    await withPrivilegedDb(ORG_ID, "test-cap-grant", (tx) =>
      tx
        .insert(userScopeGrants)
        .values({ userId: USER_ID, orgId: ORG_ID, scope: "*" })
        .onConflictDoNothing(),
    )
    await withPrivilegedDb(ORG_ID, "test-cap-agent", (tx) =>
      tx
        .insert(agents)
        .values({
          orgId: ORG_ID,
          kind: "personal",
          handle: "@visitor-step-cap",
          displayName: "Liaison",
          ownerUserId: USER_ID,
          scopeCeiling: ["*"],
        })
        .onConflictDoNothing(),
    )
    await markOrgAsDemo(ORG_ID, {
      variant: "visitor",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    })
    invalidateDemoMarker(ORG_ID)
    for (const app of NOTE_APPS) {
      toolRegistry.set([ORG_ID, app, "ping"], {
        appName: app,
        name: "ping",
        description: `Ping the ${app} app. ${"It answers with the app's state and every field it holds. ".repeat(110)}`,
        requiredScopes: ["kernel:threads:read"],
        handler: async () => ({ ok: true }),
      } as never)
    }
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    await clearRedisPatterns(["demo:*"])
    if (saved.key === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = saved.key
    env.LIAISON_DEMO_ALERT_EMAIL = saved.alert
    env.LIAISON_DEMO_MAIL_CAPTURE = saved.capture
    env.LIAISON_DEMO_BUDGET_PER_EMAIL_EUR = saved.budgets.perEmail
    env.LIAISON_DEMO_BUDGET_PER_NETWORK_EUR = saved.budgets.perNetwork
    env.LIAISON_DEMO_BOX_DAILY_EUR = saved.budgets.daily
    env.LIAISON_DEMO_BOX_HOURLY_EUR = saved.budgets.hourly
    registerDemoAlertMailer(null)
    DemoBudgetTestAccess.setVerifiedIdentity(null)
    DemoModeTestAccess.set(null)
    for (const app of NOTE_APPS) toolRegistry.delete([ORG_ID, app, "ping"])
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("a model that calls a tool at every step stops at the cap, and its last step checks in with what the results show", async () => {
    const cap = env.LIAISON_DEMO_STEPS_PER_TURN
    const { rows, prompts } = await visitorTurn(() => ({ kind: "call" }))

    expect(prompts.length).toBe(cap)
    // The last step is the check-in, and only the last.
    expect(prompts.map(carriesCheckIn)).toEqual([...Array(cap - 1).fill(false), true])
    const checkIn = JSON.stringify(prompts[cap - 1])
    expect(checkIn).toContain(`${READ_TOOL} ran`)
    expect(rows.length).toBe(1)
    expect(rows[0]?.metadata.stepCount ?? 0).toBeLessThanOrEqual(cap)
  }, 60_000)

  it("a correction of an announced action takes its steps from the same cap, and gets none past it", async () => {
    const cap = env.LIAISON_DEMO_STEPS_PER_TURN
    const ANNOUNCED = "I'll create the subtasks now."
    // Tools for every step but the last one with tools, which announces instead
    // of calling; the correction's check-in announces again.
    const { rows, prompts } = await visitorTurn((prompt, n) =>
      n < cap - 1 && !carriesCheckIn(prompt) ? { kind: "call" } : { kind: "text", text: ANNOUNCED },
    )

    expect(prompts.length).toBeLessThanOrEqual(cap)
    expect(carriesCheckIn(prompts[prompts.length - 1] ?? [])).toBe(true)
    // The check-in lists the calls the turn made before the correction began.
    expect(JSON.stringify(prompts[prompts.length - 1])).toContain(`${READ_TOOL} ran`)
    expect(rows.length).toBe(1)
    expect(rows[0]?.metadata.stepCount ?? 0).toBeLessThanOrEqual(cap)
  }, 60_000)

  it("a long conversation that loads app after app keeps its stored notes within the conversation's budget", async () => {
    const threadId = await seedThread()
    const turns = 30
    for (let t = 0; t < turns; t++) {
      const app = NOTE_APPS[t % NOTE_APPS.length]
      await visitorTurn(
        (_prompt, n) =>
          n === 1
            ? { kind: "call", tool: "kernel__tool_search", input: { query: `select:${app}__ping` } }
            : { kind: "text", text: `Done with ${app}.` },
        threadId,
      )
    }
    const rows = await sql<{ metadata: unknown }[]>`
      SELECT metadata FROM kernel.messages WHERE thread_id = ${threadId} AND author_type = 'agent'`
    expect(rows.length).toBe(turns)
    const total = rows.reduce(
      (n, r) => n + readGuideNotes(r.metadata).reduce((m, note) => m + noteTokens(note.content), 0),
      0,
    )
    // The conversation did load more than the budget holds, and stored no more than it.
    const all = JSON.stringify(rows.map((r) => readGuideNotes(r.metadata)))
    for (const app of NOTE_APPS) expect(all).toContain(`${app}__ping`)
    expect(total).toBeGreaterThan(THREAD_GUIDE_NOTES_TOKEN_CAP / 2)
    expect(total).toBeLessThanOrEqual(THREAD_GUIDE_NOTES_TOKEN_CAP)
  }, 300_000)
})
