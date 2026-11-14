// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The card claim check (card-claim.ts, wired through the false approval
// guard's continuation in agent-service.ts), through a real turn:
// invokeAgentForThread consumes the stream and the row asserted on is the
// stored reply. The model is scripted, one script per model run.
//
// Measured failures (walk of agent-driven configuration, N8): after an
// approval, with no tool call, "Please enter them in the secure card that just
// appeared" when no card existed; and "Please approve the approval card above"
// written before a tool call that found nothing left to approve.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { threadParticipants, threads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { FALSE_CARD_NOTE } from "~/modules/agent/runtime/card-claim"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-false-card"

const CARD_CLAIM =
  "I have saved the HubSpot connection. Please enter your token in the secure card that just appeared."
const FOLLOW_UP = "The HubSpot connection is saved. Enter its token in the secure card below."

type Chunk = Record<string, unknown>
type ModelOpts = {
  messages: Array<{ role: string; content: unknown }>
  tools?: Record<string, { execute?: (input: unknown, o: unknown) => Promise<unknown> }>
}
type Run = {
  chunks: Chunk[] | ((opts: ModelOpts) => Promise<Chunk[]>)
  beforeEnd?: () => Promise<void>
}

const finishStep = (finishReason: string): Chunk => ({
  type: "finish-step",
  usage: { inputTokens: 10, outputTokens: 1 },
  finishReason,
})

/** A run that writes `text` and stops. */
const answer = (text: string): Run => ({
  chunks: [
    { type: "text-delta", text },
    finishStep("stop"),
    { type: "finish", finishReason: "stop" },
  ],
})

/** The turn's tool executions, by name. */
const executed: string[] = []

/** A run that EXECUTES the turn's real `toolName` tool, then writes `text`. */
const realToolThenAnswer = (toolName: string, input: unknown, text: string): Run => ({
  chunks: async (opts) => {
    const tool = opts.tools?.[toolName]
    if (!tool?.execute) throw new Error(`the continuation has no executable ${toolName}`)
    const output = await tool.execute(input, { toolCallId: "call-fc-1", messages: opts.messages })
    executed.push(toolName)
    return [
      { type: "tool-call", toolCallId: "call-fc-1", toolName, input },
      { type: "tool-result", toolCallId: "call-fc-1", toolName, input, output },
      finishStep("tool-calls"),
      { type: "text-delta", text },
      finishStep("stop"),
      { type: "finish", finishReason: "stop" },
    ]
  },
})

/** Plays one run per model call, and records each call's messages. */
function scripted(runs: Run[]) {
  const calls: Array<Array<{ role: string; content: unknown }>> = []
  const fn = (opts: ModelOpts) => {
    const run = runs[calls.length]
    calls.push(opts.messages)
    if (!run) throw new Error(`unexpected model run #${calls.length}`)
    const chunks = typeof run.chunks === "function" ? run.chunks(opts) : Promise.resolve(run.chunks)
    const text = chunks.then((cs) =>
      cs
        .filter((c) => c.type === "text-delta")
        .map((c) => c.text as string)
        .join(""),
    )
    return {
      fullStream: (async function* () {
        for (const c of await chunks) {
          if (c.type === "finish" && run.beforeEnd) await run.beforeEnd()
          yield c
        }
      })(),
      responseMessages: text.then((t) => [
        { role: "assistant", content: [{ type: "text", text: t }] },
      ]),
    }
  }
  return { fn, calls }
}

describe("a claimed card must exist in the conversation", () => {
  let orgId: string
  let userId: string
  let actor: UserContext

  async function seedChat(): Promise<string> {
    return withPrivilegedDb(orgId, "test-fc-thread", async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({
          orgId,
          handle: `fc-${crypto.randomUUID().slice(0, 8)}`,
          type: "agent_chat",
          createdBy: userId,
          agentModelId: MODEL_ID,
        })
        .returning({ id: threads.id })
      await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId })
      return t.id
    })
  }

  async function insertSecretRequest(threadId: string, status = "pending"): Promise<void> {
    await sql`INSERT INTO kernel.secret_requests (org_id, thread_id, requested_by, kind, target, target_key, status)
      VALUES (${orgId}, ${threadId}, ${userId}, 'api_connector_credentials', '{"identifier":"hubspot"}'::jsonb,
        ${`api_connector_credentials:hubspot:${crypto.randomUUID()}`}, ${status})`
  }

  /** An approval in the conversation; a decided one was made in an earlier turn. */
  /** Approvals made by earlier tests belong to earlier turns, not this one. */
  async function ageApprovals(): Promise<void> {
    await sql`UPDATE kernel.approval_requests SET created_at = now() - interval '1 hour'
      WHERE org_id = ${orgId}`
  }

  async function insertApproval(
    threadId: string,
    handle: string,
    status = "pending",
  ): Promise<void> {
    const age = status === "pending" ? "0 seconds" : "1 hour"
    await sql`INSERT INTO kernel.approval_requests
      (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params, current_payload, expires_at, requested_by, status, created_at)
      VALUES (${orgId}, ${handle}, ${threadId}, ${threadId}, 'kernel:import_undo', '{}'::jsonb, '{}'::jsonb,
        now() + interval '1 day', ${userId}, ${status}, now() - ${age}::interval)`
  }

  /** One real turn; returns the stored reply and the model calls made. */
  async function turn(threadId: string, runs: Run[]) {
    const msg = await withPrivilegedDb(orgId, "test-fc-msg", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        requiredScopes: [],
        orgId,
        userId,
        threadId,
        content: "Connect our HubSpot.",
        authorType: "user",
      }),
    )
    if (!msg) throw new Error("could not post into the test thread")
    const script = scripted(runs)
    AgentServiceTestAccess.setStreamText(script.fn as never)
    try {
      await invokeAgentForThread(threadId, msg.id, actor, orgId)
    } finally {
      AgentServiceTestAccess.setStreamText()
    }
    const rows = await sql<
      {
        content: string
        metadata: {
          timeline?: Array<{ kind: string; toolCallId?: string; text?: string }>
          falseCardCorrected?: boolean
          contradictedTextWithheld?: boolean
        }
      }[]
    >`SELECT content, metadata FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent' ORDER BY created_at`
    if (rows.length !== 1) throw new Error(`expected one agent reply, saw ${rows.length}`)
    return { reply: rows[0], calls: script.calls }
  }

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId)).id
    const { scopes } = await withPrivilegedDb(orgId, "test-fc-actor", (tx) =>
      loadEffectivePermissions(tx, userId, orgId),
    )
    actor = { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
    await withPrivilegedDb(orgId, "test-fc-agent", (tx) =>
      tx.insert(agents).values({
        orgId,
        kind: "personal",
        handle: `@fc-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Liaison",
        ownerUserId: userId,
        scopeCeiling: ["*"],
      }),
    )
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}, '10.00000000', '0', 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'False card test', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.secret_requests WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  test("a secure card claimed with none open gets one correction, which replaces it", async () => {
    const threadId = await seedChat()
    executed.length = 0
    const { reply, calls } = await turn(threadId, [
      answer(CARD_CLAIM),
      realToolThenAnswer("kernel__tool_search", { query: "request secret" }, FOLLOW_UP),
    ])

    expect(calls.length).toBe(2)
    const second = calls[1]
    expect(second[second.length - 1]).toEqual({ role: "user", content: FALSE_CARD_NOTE })
    expect(executed).toEqual(["kernel__tool_search"])
    expect(reply.content).toBe(FOLLOW_UP)
    expect(reply.content).not.toContain("just appeared")
    expect(reply.metadata.falseCardCorrected).toBe(true)
  })

  test("the same words with a secure card open in the conversation pass", async () => {
    const threadId = await seedChat()
    await insertSecretRequest(threadId)
    const { reply, calls } = await turn(threadId, [answer(CARD_CLAIM)])

    expect(calls.length).toBe(1)
    expect(reply.content).toBe(CARD_CLAIM)
    expect(reply.metadata.falseCardCorrected).toBeUndefined()
  })

  test("a card of that kind in any status backs the claim: a saved secret request", async () => {
    const threadId = await seedChat()
    await insertSecretRequest(threadId, "saved")
    const { reply, calls } = await turn(threadId, [answer(CARD_CLAIM)])

    expect(calls.length).toBe(1)
    expect(reply.content).toBe(CARD_CLAIM)
    expect(reply.metadata.falseCardCorrected).toBeUndefined()
  })

  test("a correct answer after an approval, in the past tense, is never wiped", async () => {
    const threadId = await seedChat()
    const text =
      "You approved the card above, so the import is running. The secure card above has been used."
    const { reply, calls } = await turn(threadId, [answer(text)])

    expect(calls.length).toBe(1)
    expect(reply.content).toBe(text)
    expect(reply.metadata.falseCardCorrected).toBeUndefined()
  })

  test("a card claim written before a tool call is replaced too, with the rest of the text", async () => {
    const threadId = await seedChat()
    const early =
      "I have initiated the undo. Please approve the approval card above to complete it."
    const late = "The import has already been undone: nothing is left to remove."
    const honest =
      "The import was already undone, so there is nothing left to remove and nothing to approve."
    const { reply, calls } = await turn(threadId, [
      {
        chunks: async (opts) => {
          const tool = opts.tools?.kernel__tool_search
          const output = await tool?.execute?.(
            { query: "import undo" },
            {
              toolCallId: "call-fc-2",
              messages: opts.messages,
            },
          )
          return [
            { type: "text-delta", text: early },
            {
              type: "tool-call",
              toolCallId: "call-fc-2",
              toolName: "kernel__tool_search",
              input: {},
            },
            {
              type: "tool-result",
              toolCallId: "call-fc-2",
              toolName: "kernel__tool_search",
              input: {},
              output,
            },
            finishStep("tool-calls"),
            { type: "text-delta", text: late },
            finishStep("stop"),
            { type: "finish", finishReason: "stop" },
          ]
        },
      },
      answer(honest),
    ])

    expect(calls.length).toBe(2)
    expect(reply.content).toBe(honest)
    expect(reply.content).not.toContain("approval card above")
    expect(reply.metadata.falseCardCorrected).toBe(true)
    // The tool call stays in the stored turn; only the false text goes.
    expect(reply.metadata.timeline?.some((e) => e.toolCallId === "call-fc-2")).toBe(true)
  })

  test("an approval card claimed while one waits in the conversation passes", async () => {
    const threadId = await seedChat()
    await insertApproval(threadId, `request-${Math.floor(Math.random() * 1e9)}`)
    const text = "Please approve the approval card above to complete the undo."
    const { reply, calls } = await turn(threadId, [answer(text)])

    expect(calls.length).toBe(1)
    expect(reply.content).toBe(text)
  })
  test("an approval card claimed with only a decided approval in the conversation is false", async () => {
    const threadId = await seedChat()
    await insertApproval(threadId, `request-${Math.floor(Math.random() * 1e9)}`, "approved")
    await ageApprovals()
    // ("pending approval" in the final text is the false approval guard's own catch.)
    const claim = "Please approve the approval card above to complete the undo."
    const honest = "Nothing is waiting for your approval."
    const { reply, calls } = await turn(threadId, [answer(claim), answer(honest)])

    expect(calls.length).toBe(2)
    const second = calls[1]
    expect(second[second.length - 1]).toEqual({ role: "user", content: FALSE_CARD_NOTE })
    expect(reply.content).toBe(honest)
    expect(reply.metadata.falseCardCorrected).toBe(true)
  })

  // Live check 2026-10-27 (N47): the outcome written before the call returns.
  /** A run that writes `early`, gets `output` for one tool call, then writes `late`. */
  const preCallRun = (early: string, toolName: string, output: unknown, late: string): Run => ({
    chunks: [
      { type: "text-delta", text: early },
      { type: "tool-call", toolCallId: "call-pc-1", toolName, input: {} },
      { type: "tool-result", toolCallId: "call-pc-1", toolName, input: {}, output },
      finishStep("tool-calls"),
      { type: "text-delta", text: late },
      finishStep("stop"),
      { type: "finish", finishReason: "stop" },
    ],
  })
  const TICKETS_EARLY =
    "I have submitted a request to enable the Tickets app. Please approve the pending approval card in this conversation to complete it."

  test("a no-op enable under 'approve the pending card' keeps only the answer after the result", async () => {
    const threadId = await seedChat()
    // An approval decided earlier in the conversation backs no pending card.
    await insertApproval(threadId, `request-${Math.floor(Math.random() * 1e9)}`, "approved")
    await ageApprovals()
    const late = "Tickets is already enabled."
    const { reply, calls } = await turn(threadId, [
      preCallRun(
        TICKETS_EARLY,
        "kernel__config_apps",
        { tellThePerson: late, section: "apps", changed: false, plan: [] },
        late,
      ),
    ])

    expect(calls.length).toBe(1)
    expect(reply.content).toBe(late)
    expect(reply.content).not.toContain("approval card")
    expect(reply.metadata.contradictedTextWithheld).toBe(true)
    expect(reply.metadata.timeline?.some((e) => e.toolCallId === "call-pc-1")).toBe(true)
  })

  test("a real approval parked by the call passes untouched", async () => {
    const threadId = await seedChat()
    const late = "It needs your go-ahead first."
    const { reply, calls } = await turn(threadId, [
      preCallRun(
        TICKETS_EARLY,
        "kernel__config_apps",
        { blocked: true, status: "pending_approval", handle: "request-1" },
        late,
      ),
    ])

    expect(calls.length).toBe(1)
    // Each step's text is a paragraph of its own in the stored reply.
    expect(reply.content).toBe(`${TICKETS_EARLY}\n\n${late}`)
    expect(reply.metadata.contradictedTextWithheld).toBeUndefined()
    expect(reply.metadata.falseCardCorrected).toBeUndefined()
  })

  test("'posted the card again' over an already_posted dedupe keeps only the truthful answer", async () => {
    const threadId = await seedChat()
    await insertSecretRequest(threadId)
    const early = "I have posted the connect card again above. Please click Connect on the card."
    const late = "The connection card is already right above in this conversation."
    const { reply, calls } = await turn(threadId, [
      preCallRun(
        early,
        "kernel__request_secret",
        {
          requestId: crypto.randomUUID(),
          kind: "oauth_connect",
          target: {},
          card: "already_posted",
          note: "This card was already posted in this conversation and is still waiting.",
        },
        late,
      ),
    ])

    expect(calls.length).toBe(1)
    expect(reply.content).toBe(late)
    expect(reply.content).not.toContain("again")
    expect(reply.metadata.contradictedTextWithheld).toBe(true)
  })
})
