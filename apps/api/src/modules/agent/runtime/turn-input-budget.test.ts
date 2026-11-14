// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A step budget (a demo visitor's turn): the last allowed step is the
// check-in, tools off, so the turn ends with an answer at its cap.
import { describe, expect, it } from "bun:test"
import {
  callOutcome,
  checkInFacts,
  createTurnInputBudget,
  stepBudgetPromptLine,
} from "./turn-input-budget"

describe("a turn with a step budget", () => {
  it("checks in on its last step, however small its input", () => {
    const budget = createTurnInputBudget({ maxSteps: 6 })
    for (let step = 0; step < 5; step++) {
      expect(budget.checkInDue()).toBe(false)
      budget.recordStep(20_000)
    }
    expect(budget.checkInDue()).toBe(true)
    budget.markCheckInSent()
    expect(budget.checkInDue()).toBe(false)
    expect(budget.checkInSent).toBe(true)
  })

  it("without one, only the input budget calls the check-in", () => {
    const budget = createTurnInputBudget()
    for (let step = 0; step < 30; step++) budget.recordStep(20_000)
    expect(budget.checkInDue()).toBe(false)
  })
})

// Live demo: a support routine spent all five tool steps reading and was then
// told, tools off, to say how far it got: no note and no draft were written.
describe("a step budget's last step with tools", () => {
  it("is announced on the step before the check-in, and only there", () => {
    const budget = createTurnInputBudget({ maxSteps: 6 })
    const due: boolean[] = []
    for (let step = 0; step < 5; step++) {
      due.push(budget.lastToolStepDue())
      budget.recordStep(20_000)
    }
    expect(due).toEqual([false, false, false, false, true])
    expect(budget.checkInDue()).toBe(true)
    expect(budget.lastToolStepDue()).toBe(false)
  })

  it("is never announced without a step budget", () => {
    const budget = createTurnInputBudget()
    for (let step = 0; step < 10; step++) {
      expect(budget.lastToolStepDue()).toBe(false)
      budget.recordStep(20_000)
    }
  })
})

describe("the prompt line of a step budget", () => {
  it("names the steps with tools and the step the writes must land by", () => {
    const line = stepBudgetPromptLine(6)
    expect(line).toContain("at most 6 steps")
    expect(line).toContain("5 that can call tools")
    expect(line).toContain("by step 5")
  })
})

describe("the check-in's facts", () => {
  it("names each call and how its result says it ended, and nothing the turn did not do", () => {
    const facts = checkInFacts([
      {
        toolCalls: [
          { toolName: "kernel__tool_search", toolCallId: "s1", input: { query: "stripe" } },
          { toolName: "stripe__customers_get", toolCallId: "c1", input: {} },
        ],
        toolResults: [
          { toolCallId: "s1", output: { tools: [] } },
          { toolCallId: "c1", output: { type: "json", value: { customer: { id: "cus_1" } } } },
        ],
      },
      {
        toolCalls: [
          {
            toolName: "kernel__call_tool",
            toolCallId: "m1",
            input: { name: "mail__compose", arguments: {} },
          },
          { toolName: "invoicing__documents_get", toolCallId: "d1", input: {} },
        ],
        toolResults: [
          { toolCallId: "m1", output: { blocked: true, status: "pending_approval" } },
          { toolCallId: "d1", output: { error: "not_found" } },
        ],
      },
    ])
    expect(facts).toBe(
      "What this turn's tool results show: stripe__customers_get ran; mail__compose waits for a person's approval; invoicing__documents_get failed. Nothing else was done.",
    )
    expect(checkInFacts([])).toBe("This turn called no tool: nothing was read, done or changed.")
  })
})

describe("how a call ended, as the check-in states it", () => {
  it("work a call started is not called finished, and a refusal is not called a run", () => {
    expect(callOutcome({ status: "started", sessionId: "s1" })).toBe(
      "started and has not finished (started)",
    )
    expect(callOutcome({ type: "json", value: { status: "queued" } })).toBe(
      "started and has not finished (queued)",
    )
    expect(callOutcome({ status: "refused", reason: "no_node" })).toBe(
      "was refused: nothing was done",
    )
    expect(callOutcome({ status: "waiting", title: "Fix" })).toBe("ran (its result says: waiting)")
    expect(callOutcome({ ok: false })).toBe("failed")
    expect(callOutcome({ status: "Some free text the record holds" })).toBe("ran")
  })

  it("a parked call inside a larger result waits for approval", () => {
    expect(
      callOutcome({ results: [{ blocked: { reason: "gated", approvalRequestId: "a1" } }] }),
    ).toBe("waits for a person's approval")
    // A list of approvals someone else holds is a read, not a parked call of this turn.
    expect(callOutcome({ approvals: [{ status: "pending_approval" }] })).toBe("ran")
  })
})

describe("the steps a step budget leaves", () => {
  it("counts every recorded step, and none without a step budget", () => {
    const budget = createTurnInputBudget({ maxSteps: 3 })
    expect(budget.stepsLeft()).toBe(3)
    budget.recordStep(10)
    budget.recordStep(10)
    expect(budget.stepsLeft()).toBe(1)
    budget.recordStep(10)
    budget.recordStep(10)
    expect(budget.stepsLeft()).toBe(0)
    expect(createTurnInputBudget().stepsLeft()).toBeNull()
  })
})
