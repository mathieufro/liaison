// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Live Oracle walk: after a 38 KB kpi_list_metrics result, Gemini ended the
// turn with an empty step (no text, no call, clean stop) and the person got no
// answer. The agent loop now asks the model once to answer.
import { describe, expect, it } from "bun:test"
import { simulateReadableStream, stepCountIs, tool } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { z } from "zod"
import {
  ANSWER_AFTER_TOOLS_NUDGE,
  stepContextInputTokens,
} from "~/modules/agent/providers/answer-after-tools"
import { readProviderCostUsd } from "~/modules/agent/providers/step-usage"
import { runAgentStream } from "~/modules/agent/runtime/agent-service"

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
}

const finish = (unified: "stop" | "tool-calls" | "length" = "stop") => ({
  type: "finish" as const,
  finishReason: { unified, raw: unified.toUpperCase() },
  usage: USAGE,
})

function toolCallStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: "c1",
          toolName: "kpi__kpi_list_metrics",
          input: "{}",
        },
        finish("tool-calls"),
      ],
    }),
  }
}

/** A step whose finish carries OpenRouter's reported cost. */
function costedStep(step: { stream: ReadableStream<unknown> }, cost: number) {
  return {
    stream: step.stream.pipeThrough(
      new TransformStream({
        transform(part: { type?: string }, controller) {
          controller.enqueue(
            part.type === "finish"
              ? { ...part, providerMetadata: { openrouter: { usage: { cost } } } }
              : part,
          )
        },
      }),
    ),
  }
}

function emptyStep(unified: "stop" | "length" = "stop") {
  return {
    stream: simulateReadableStream({
      chunks: [{ type: "stream-start" as const, warnings: [] }, finish(unified)],
    }),
  }
}

function textStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: text },
        { type: "text-end" as const, id: "t1" },
        finish(),
      ],
    }),
  }
}

/** A step that writes `text` and then calls `toolName`, in one step. */
function textThenCallStep(text: string, toolName: string, id = "c2") {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        { type: "text-start" as const, id: "t0" },
        { type: "text-delta" as const, id: "t0", delta: text },
        { type: "text-end" as const, id: "t0" },
        {
          type: "tool-call" as const,
          toolCallId: id,
          toolName,
          input: '{"steps":[{"label":"Hand over"}]}',
        },
        finish("tool-calls"),
      ],
    }),
  }
}

function callStep(toolName: string, id: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        {
          type: "tool-call" as const,
          toolCallId: id,
          toolName,
          input: '{"steps":[{"label":"Hand over"}]}',
        },
        finish("tool-calls"),
      ],
    }),
  }
}

const SUGGEST = "kernel__suggest_next_steps"

/** Every text delta of every step, joined: what the agent loop stores as the reply. */
async function allText(result: ReturnType<typeof runAgentStream>): Promise<string> {
  let text = ""
  for await (const part of result.fullStream) if (part.type === "text-delta") text += part.text
  return text
}

function run(steps: Array<{ stream: ReadableStream<unknown> }>) {
  const model = new MockLanguageModelV4({ doStream: steps as never })
  const result = runAgentStream({
    model,
    stepTokenCap: null,
    system: "sys",
    messages: [{ role: "user", content: "Quelles métriques existent ?" }],
    tools: {
      kpi__kpi_list_metrics: tool({
        description: "list metrics",
        inputSchema: z.object({}),
        execute: async () => ({ metrics: "x".repeat(38_000) }),
      }),
      [SUGGEST]: tool({
        description: "chips under the reply",
        inputSchema: z.object({ steps: z.array(z.object({ label: z.string() })) }),
        execute: async () => ({ ok: true, shown: 1, message: "1 shown under your reply." }),
      }),
    },
    stopWhen: stepCountIs(8),
  })
  return { model, result }
}

describe("a step after tool results that says nothing", () => {
  it("is asked once to answer, and the answer becomes the turn's text", async () => {
    const { model, result } = run([toolCallStep(), emptyStep(), textStep("Il y a 12 métriques.")])
    expect(await result.text).toBe("Il y a 12 métriques.")
    expect(model.doStreamCalls.length).toBe(3)
    const last = model.doStreamCalls[2]?.prompt as Array<{ role: string; content: unknown }>
    expect(last[last.length - 1]?.role).toBe("user")
    expect(JSON.stringify(last[last.length - 1]?.content)).toContain(ANSWER_AFTER_TOOLS_NUDGE)
    // Both calls are billed: the empty one and the answer.
    const usage = await result.totalUsage
    expect(usage.inputTokens).toBe(30)
  })

  // Demo 2026-10-12: a two-step turn reported its last step at 66,356 input
  // tokens, twice its real context (about 33,000), because the re-issued step
  // sums both calls. Billing wants the sum; the context size (what compaction
  // reads) is the answering request's own input.
  it("keeps the billed sum on the step but reports the answering request's own input as the context size", async () => {
    const { result } = run([toolCallStep(), emptyStep(), textStep("Il y a 12 métriques.")])
    await result.text
    const steps = await result.steps
    const last = steps[steps.length - 1]
    expect(last?.usage.inputTokens).toBe(20)
    expect(stepContextInputTokens(last?.usage.inputTokens, last?.providerMetadata)).toBe(10)
    // A step that was not re-issued reports its own input.
    expect(stepContextInputTokens(steps[0]?.usage.inputTokens, steps[0]?.providerMetadata)).toBe(10)
  })

  it("reports the cost of both calls on the re-issued step", async () => {
    const { result } = run([
      costedStep(toolCallStep(), 0.001),
      costedStep(emptyStep(), 0.002),
      costedStep(textStep("Il y a 12 métriques."), 0.003),
    ])
    await result.text
    const steps = await result.steps
    expect(readProviderCostUsd(steps[0]?.providerMetadata)).toBe(0.001)
    expect(readProviderCostUsd(steps[steps.length - 1]?.providerMetadata)).toBeCloseTo(0.005, 10)
  })

  it("reports no cost on the re-issued step when either call reported none", async () => {
    const { result } = run([
      toolCallStep(),
      costedStep(emptyStep(), 0.002),
      textStep("Il y a 12 métriques."),
    ])
    await result.text
    const steps = await result.steps
    expect(readProviderCostUsd(steps[steps.length - 1]?.providerMetadata)).toBeUndefined()
  })

  it("is asked only once per turn", async () => {
    const { model, result } = run([toolCallStep(), emptyStep(), emptyStep(), textStep("never")])
    expect(await result.text).toBe("")
    expect(model.doStreamCalls.length).toBe(3)
  })

  it("leaves a first step with no tool results alone", async () => {
    const { model, result } = run([emptyStep(), textStep("never")])
    expect(await result.text).toBe("")
    expect(model.doStreamCalls.length).toBe(1)
  })

  it("leaves a length cut alone (the supervisor owns that)", async () => {
    const { model } = run([toolCallStep(), emptyStep("length"), textStep("never")])
    await new Promise((r) => setTimeout(r, 50))
    expect(model.doStreamCalls.length).toBeLessThanOrEqual(2)
  })
})

describe("a silent step after chips closed an answer already written", () => {
  const ANSWER = "Noted: Tobias is off in week 51. Want me to do anything with it?"

  it("is the end of the turn: the answer is not asked for again, so it is never written twice", async () => {
    const { model, result } = run([
      textThenCallStep(ANSWER, SUGGEST),
      emptyStep(),
      textStep("Tobias is off in week 51."),
    ])
    expect(await allText(result)).toBe(ANSWER)
    expect(model.doStreamCalls.length).toBe(2)
  })

  it("holds across several chip calls after the answer", async () => {
    const { model, result } = run([
      textThenCallStep(ANSWER, SUGGEST),
      callStep(SUGGEST, "c3"),
      emptyStep(),
      textStep("again"),
    ])
    expect(await allText(result)).toBe(ANSWER)
    expect(model.doStreamCalls.length).toBe(3)
  })

  it("still asks when the only text was a note before a tool that gathered", async () => {
    const { model, result } = run([
      textThenCallStep("I'll list the metrics.", "kpi__kpi_list_metrics", "c1"),
      callStep(SUGGEST, "c3"),
      emptyStep(),
      textStep("Il y a 12 métriques."),
    ])
    expect(await allText(result)).toBe("I'll list the metrics.Il y a 12 métriques.")
    expect(model.doStreamCalls.length).toBe(4)
  })
})
