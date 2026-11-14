// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An interactive turn's input budget (turn-input-budget.ts), through the real
// runAgentChat wiring: the loop's own onStepFinish counts each step's input,
// and once the turn has sent its budget the next step runs with tool calls off
// and the check-in note, and the loop stops after it.
//
// Demo 2026-10-12: a one-word "yes" ran 18 steps and 550,000 input tokens.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import {
  AgentServiceTestAccess,
  ROUTINE_CHAIN_ONLY_RESULT,
  ROUTINE_CHAIN_RETRIES,
  ROUTINE_RUN_PAUSE_ANSWER_ONLY_RESULT,
  ROUTINE_RUN_PAUSE_NOTE,
} from "~/modules/agent/runtime/agent-service"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import {
  TURN_BUDGET_ANSWER_ONLY_RESULT,
  TURN_BUDGET_CHECK_IN_NOTE,
  TURN_BUDGET_FLOOR_TOKENS,
  TURN_BUDGET_OPENING_REREADS,
  turnInputBudgetFor,
} from "~/modules/agent/runtime/turn-input-budget"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

const ORG_ID = "00000000-0000-0000-0000-000000e70001"
const USER_ID = "00000000-0000-0000-0000-000000e70002"
const THREAD_ID = "00000000-0000-0000-0000-000000e70003"
const MODEL_ID = "claude-haiku-4-5-turn-budget"

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

type StepOut = {
  toolChoice?: unknown
  activeTools?: string[]
  messages?: Array<{ role: string; content: unknown }>
}

async function prepare(stepNumber: number): Promise<StepOut> {
  return (await capturedParams.prepareStep({
    steps: [],
    stepNumber,
    messages: [{ role: "user", content: "yes" }],
  })) as StepOut
}

async function finishStep(inputTokens: number): Promise<void> {
  await capturedParams.onStepFinish({ usage: { inputTokens, outputTokens: 50 } })
}

async function stops(steps: unknown[]): Promise<boolean> {
  const conds = Array.isArray(capturedParams.stopWhen)
    ? capturedParams.stopWhen
    : [capturedParams.stopWhen]
  for (const c of conds) if (await c({ steps })) return true
  return false
}

function carriesCheckIn(out: StepOut): boolean {
  return JSON.stringify(out.messages ?? []).includes(TURN_BUDGET_CHECK_IN_NOTE)
}

type TurnKind = "chat" | "background" | "routine" | "coordination" | "agentDispatched"

async function startTurn(kind: TurnKind | boolean) {
  capturedParams = null
  const k: TurnKind = kind === true ? "background" : kind === false ? "chat" : kind
  const { runAgentChat } = await import("./agent-service")
  const result = await runAgentChat({
    threadId: THREAD_ID,
    content: "yes",
    actor: ACTOR,
    orgId: ORG_ID,
    ...(k === "background" ? { background: true } : {}),
    ...(k === "routine" ? { routineId: "00000000-0000-0000-0000-000000e70009" } : {}),
    ...(k === "coordination"
      ? {
          coordination: {
            callerAgentId: null,
            parentMessageId: "00000000-0000-0000-0000-000000e70008",
          },
        }
      : {}),
    ...(k === "agentDispatched" ? { agentDispatched: true } : {}),
  } as never)
  expect(capturedParams).not.toBeNull()
  return result
}

async function endTurn(result: { finalize: (p: never) => Promise<unknown> }) {
  await result.finalize({
    usage: { promptTokens: 1000, completionTokens: 10 },
    finishReason: "stop",
    text: "ok",
    steps: [],
  } as never)
}

describe("an interactive turn's input budget", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    AgentServiceTestAccess.setStreamText(capturingStreamText as never)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'TurnBudgetOrg', 'turn-budget-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'turnbudget@test.com', 'Turn Budget')`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${USER_ID}, ${ORG_ID}, '*')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_model_id) VALUES (${THREAD_ID}, ${ORG_ID}, 'turn-budget-chat', 'agent_chat', ${USER_ID}, ${MODEL_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    // The message a coordination turn hangs under.
    await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes) VALUES ('00000000-0000-0000-0000-000000e70008', ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'user', 'the ask', '{}'::text[])`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '0', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Turn budget test', '1.00', '5.00', 200000, true, 'starter') ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    await releaseTestLock()
  })

  it("past its budget a chat turn checks in: answer only, the note on the step, and the loop stops after it", async () => {
    const result = await startTurn(false)
    // The demo turn's shape: about 30,000 tokens a step, step after step.
    const perStep = 30_000
    const budget = Math.max(TURN_BUDGET_FLOOR_TOKENS, TURN_BUDGET_OPENING_REREADS * perStep)
    let step = 0
    let sent = 0
    while (sent < budget) {
      const out = await prepare(step)
      expect(out.toolChoice).toBeUndefined()
      expect(carriesCheckIn(out)).toBe(false)
      await finishStep(perStep)
      sent += perStep
      step++
      expect(await stops([{}])).toBe(false)
    }
    // The budget is spent: the next step is the check-in.
    const checkIn = await prepare(step)
    // The check-in keeps the turn's tools (the prompt cache), and a call in it is not run.
    expect(checkIn.toolChoice).toBeUndefined()
    expect(result.stepCtx.answerOnly).toBe(TURN_BUDGET_ANSWER_ONLY_RESULT)
    expect(carriesCheckIn(checkIn)).toBe(true)
    await finishStep(perStep + 1_000)
    // Whatever that step did, the loop ends there.
    expect(await stops([{}])).toBe(true)
    // The budget plus one check-in step, and never fewer steps than the old
    // STEP_LIMIT (40) at the opening size.
    expect(step).toBe(Math.ceil(budget / perStep))
    expect(step).toBeGreaterThanOrEqual(40)
    await endTurn(result)
  }, 60_000)

  it("a turn under its budget never sees the check-in", async () => {
    const result = await startTurn(false)
    for (let step = 0; step < 4; step++) {
      const out = await prepare(step)
      expect(out.toolChoice).toBeUndefined()
      expect(carriesCheckIn(out)).toBe(false)
      await finishStep(30_000)
      expect(await stops([{}])).toBe(false)
    }
    await endTurn(result)
  }, 60_000)

  // Review finding 2 (2026-10-12): 15x the opening, floor 200,000, stopped a
  // 50k-opening turn adding about 3k a step after about 12 steps: a monthly
  // report (many kpi_run calls, gate-fix loops) would have been interrupted.
  it("the budget is the 40-step parity of the opening, never below 1.5M", () => {
    expect(turnInputBudgetFor(10_000)).toBe(1_500_000)
    expect(turnInputBudgetFor(50_000)).toBe(2_000_000)
  })

  it("a long legitimate turn (50k opening, +3k a step) runs 24 steps without a check-in", async () => {
    const result = await startTurn("chat")
    for (let step = 0; step < 24; step++) {
      const out = await prepare(step)
      expect(out.toolChoice).toBeUndefined()
      expect(carriesCheckIn(out)).toBe(false)
      await finishStep(50_000 + 3_000 * step)
      expect(await stops([{}])).toBe(false)
    }
    await endTurn(result)
  }, 60_000)

  for (const kind of ["routine", "coordination", "agentDispatched"] as const) {
    it(`a ${kind} turn is not budgeted here: no person is there to say "continue"`, async () => {
      const result = await startTurn(kind)
      for (let step = 0; step < 45; step++) {
        const out = await prepare(step)
        expect(out.toolChoice).toBeUndefined()
        expect(carriesCheckIn(out)).toBe(false)
        await finishStep(60_000)
      }
      await endTurn(result)
    }, 60_000)
  }

  it("a background run (routine tick) is not budgeted here: it has its own limit", async () => {
    const result = await startTurn(true)
    for (let step = 0; step < TURN_BUDGET_OPENING_REREADS + 3; step++) {
      const out = await prepare(step)
      expect(out.toolChoice).toBeUndefined()
      expect(carriesCheckIn(out)).toBe(false)
      await finishStep(30_000)
    }
    await endTurn(result)
  }, 60_000)

  // A routine run waits for its gated calls (routine-run-resume.ts): after the
  // step that parked one, one step says what it waits for, tools off, and the
  // loop stops there, so nothing after the pause guesses the call's result.
  const parkedStep = {
    usage: { inputTokens: 1000, outputTokens: 10 },
    toolResults: [
      {
        toolCallId: "c1",
        toolName: "web_fetch",
        output: { blocked: true, status: "pending_approval", approvalRequestId: "a1" },
      },
    ],
  }

  it("a routine turn that parked a call takes one answer-only step, then stops", async () => {
    const result = await startTurn("routine")
    const first = await prepare(0)
    expect(first.toolChoice).toBeUndefined()
    await capturedParams.onStepFinish(parkedStep)
    expect(await stops([{}])).toBe(false)
    const pause = await prepare(1)
    expect(pause.toolChoice).toBeUndefined()
    expect(result.stepCtx.answerOnly).toBe(ROUTINE_RUN_PAUSE_ANSWER_ONLY_RESULT)
    expect(JSON.stringify(pause.messages ?? [])).toContain(
      JSON.stringify(ROUTINE_RUN_PAUSE_NOTE).slice(1, 60),
    )
    await finishStep(1000)
    expect(await stops([{}])).toBe(true)
    await endTurn(result)
  }, 60_000)

  // A parked call that hands out @ref tokens: the run proposes the calls that
  // cite them before it pauses (one request, approved once).
  const chainableStep = (id: string, toolName = "connector_write") => ({
    usage: { inputTokens: 1000, outputTokens: 10 },
    toolResults: [
      {
        toolCallId: id,
        toolName,
        output: {
          blocked: true,
          status: "pending_approval",
          approvalRequestId: id,
          outputs: { record_id: `@ref:${id}:record_id` },
        },
      },
    ],
  })
  const lookupStep = {
    usage: { inputTokens: 1000, outputTokens: 10 },
    toolResults: [{ toolCallId: "s1", toolName: "kernel__tool_search", output: { tools: [] } }],
  }

  it("a routine turn chains on a parked call's tokens, then pauses at the call with nothing to chain on", async () => {
    const result = await startTurn("routine")
    await prepare(0)
    await capturedParams.onStepFinish(chainableStep("a1"))
    // Tools stay on: the next call cites the token.
    expect((await prepare(1)).toolChoice).toBeUndefined()
    await capturedParams.onStepFinish(lookupStep)
    expect((await prepare(2)).toolChoice).toBeUndefined()
    // A self-parked tool (conditionally gated) with tokens chains too.
    await capturedParams.onStepFinish({
      usage: { inputTokens: 1000, outputTokens: 10 },
      toolResults: [
        {
          toolCallId: "q1",
          toolName: "invoicing__quote_create_and_issue",
          output: {
            status: "pending_approval",
            approval_id: "q1",
            outputs: { number: "@ref:q1:number" },
          },
        },
      ],
    })
    expect((await prepare(3)).toolChoice).toBeUndefined()
    await capturedParams.onStepFinish(parkedStep)
    const pause = await prepare(4)
    expect(pause.toolChoice).toBeUndefined()
    expect(result.stepCtx.answerOnly).toBe(ROUTINE_RUN_PAUSE_ANSWER_ONLY_RESULT)
    expect(JSON.stringify(pause.messages ?? [])).toContain(
      JSON.stringify(ROUTINE_RUN_PAUSE_NOTE).slice(1, 60),
    )
    await finishStep(1000)
    expect(await stops([{}])).toBe(true)
    await endTurn(result)
  }, 60_000)

  // Review 2026-10-30: while it chains, the run proposes steps only. An ungated
  // write would run at once, before the person decides what it follows.
  it("a routine turn chaining on a parked call keeps its tools and runs only calls that park", async () => {
    const result = await startTurn("routine")
    const before = (await prepare(0)).activeTools ?? []
    expect(result.stepCtx.chainOnly).toBeNull()
    await capturedParams.onStepFinish(chainableStep("a1"))
    const chaining = await prepare(1)
    expect(chaining.activeTools ?? []).toEqual(before)
    expect(chaining.toolChoice).toBeUndefined()
    expect(result.stepCtx.chainOnly).toBe(ROUTINE_CHAIN_ONLY_RESULT)
    expect(result.stepCtx.answerOnly).toBeNull()
    await endTurn(result)
  }, 60_000)

  // A refused call changed nothing and its error says how to fix it: the run
  // may correct it (up to ROUTINE_CHAIN_RETRIES times) before it pauses.
  it("a routine turn retries a refused chained call, then pauses", async () => {
    const result = await startTurn("routine")
    await prepare(0)
    await capturedParams.onStepFinish(chainableStep("a1"))
    const refused = {
      usage: { inputTokens: 1000, outputTokens: 10 },
      toolResults: [
        {
          toolCallId: "x",
          toolName: "mail__reply",
          output: { error: "invalid_ref: use :pdf_file_id" },
        },
      ],
    }
    for (let i = 0; i < ROUTINE_CHAIN_RETRIES; i++) {
      await prepare(1 + i)
      await capturedParams.onStepFinish(refused)
    }
    await prepare(1 + ROUTINE_CHAIN_RETRIES)
    expect(result.stepCtx.answerOnly).toBeNull()
    await capturedParams.onStepFinish(refused)
    await prepare(2 + ROUTINE_CHAIN_RETRIES)
    expect(result.stepCtx.answerOnly).toBe(ROUTINE_RUN_PAUSE_ANSWER_ONLY_RESULT)
    await endTurn(result)
  }, 60_000)

  it("a routine turn that does other work after a parked call pauses", async () => {
    const result = await startTurn("routine")
    await prepare(0)
    await capturedParams.onStepFinish(chainableStep("a1"))
    await prepare(1)
    await capturedParams.onStepFinish({
      usage: { inputTokens: 1000, outputTokens: 10 },
      toolResults: [{ toolCallId: "r1", toolName: "tickets__get", output: { id: "t1" } }],
    })
    await prepare(2)
    expect(result.stepCtx.answerOnly).toBe(ROUTINE_RUN_PAUSE_ANSWER_ONLY_RESULT)
    await endTurn(result)
  }, 60_000)

  // A follow-up routine stages drafts and runs on: no pause after a parked
  // call, no chain-only step, and the loop does not stop there.
  it("a follow-up routine turn that parks calls in two steps runs on without pausing", async () => {
    const routineId = "00000000-0000-0000-0000-000000e70009"
    const result = await runContextStore.run(
      {
        runId: "00000000-0000-0000-0000-000000e7000a",
        parentRunId: null,
        rootRunId: "00000000-0000-0000-0000-000000e7000a",
        nestingDepth: 0,
        background: true,
        routineId,
        routineFollowUp: true,
      },
      () => startTurn("routine"),
    )
    await prepare(0)
    await capturedParams.onStepFinish({
      usage: { inputTokens: 1000, outputTokens: 10 },
      toolResults: [parkedStep.toolResults[0], { ...parkedStep.toolResults[0], toolCallId: "c2" }],
    })
    const second = await prepare(1)
    expect(result.stepCtx.answerOnly).toBeNull()
    expect(result.stepCtx.chainOnly).toBeNull()
    expect(JSON.stringify(second.messages ?? [])).not.toContain(
      JSON.stringify(ROUTINE_RUN_PAUSE_NOTE).slice(1, 60),
    )
    await capturedParams.onStepFinish(parkedStep)
    await prepare(2)
    expect(result.stepCtx.answerOnly).toBeNull()
    expect(result.stepCtx.chainOnly).toBeNull()
    expect(await stops([{}, {}])).toBe(false)
    await endTurn(result)
  }, 60_000)

  it("a routine tick frame for another routine does not make this turn a follow-up", async () => {
    const result = await runContextStore.run(
      {
        runId: "00000000-0000-0000-0000-000000e7000b",
        parentRunId: null,
        rootRunId: "00000000-0000-0000-0000-000000e7000b",
        nestingDepth: 0,
        background: true,
        routineId: "00000000-0000-0000-0000-000000e7000c",
        routineFollowUp: true,
      },
      () => startTurn("routine"),
    )
    await prepare(0)
    await capturedParams.onStepFinish(parkedStep)
    await prepare(1)
    expect(result.stepCtx.answerOnly).toBe(ROUTINE_RUN_PAUSE_ANSWER_ONLY_RESULT)
    await endTurn(result)
  }, 60_000)

  it("a chat turn that parked a call carries on as before", async () => {
    const result = await startTurn("chat")
    await prepare(0)
    await capturedParams.onStepFinish(parkedStep)
    const next = await prepare(1)
    expect(next.toolChoice).toBeUndefined()
    expect(result.stepCtx.answerOnly).toBeNull()
    expect(JSON.stringify(next.messages ?? [])).not.toContain("This routine run is now paused")
    expect(await stops([{}])).toBe(false)
    await endTurn(result)
  }, 60_000)
})
