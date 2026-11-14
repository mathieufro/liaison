// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { retractedAttempt, withPriorSteps } from "~/modules/agent/runtime/agent-service"
import { retractFromTimeline } from "~/modules/agent/runtime/false-approval-guard"
import { createReplyText, joinStepTexts } from "~/modules/agent/runtime/reply-flatten"

describe("the stored reply of a turn", () => {
  it("a stored reply of three steps keeps a blank line between them", () => {
    const reply = createReplyText()
    for (const step of [["I checked ", "these."], ["Drafted the invoice."], ["Done."]]) {
      for (const delta of step) reply.add(delta)
      reply.endStep()
    }
    expect(reply.text).toBe("I checked these.\n\nDrafted the invoice.\n\nDone.")
  })

  it("text within one step is kept exactly as streamed", () => {
    const reply = createReplyText()
    for (const delta of ["Line one.\n", "Line two ", "and more."]) reply.add(delta)
    expect(reply.text).toBe("Line one.\nLine two and more.")
  })

  it("a step that wrote nothing, or only whitespace, adds no blank paragraph", () => {
    const reply = createReplyText()
    reply.add("First.")
    reply.endStep()
    reply.endStep()
    reply.add("\n")
    reply.endStep()
    reply.add(" Second.")
    expect(reply.text).toBe("First.\n\nSecond.")
  })

  it("a step's own trailing newlines are not doubled", () => {
    expect(joinStepTexts(["First.\n\n", "\nSecond."])).toBe("First.\n\nSecond.")
  })

  it("a resumed turn's earlier steps and its new text are separated the same way", () => {
    const view = (text: string) => ({
      text,
      reasoning: "",
      timeline: [],
      toolCalls: [],
      toolResults: [],
      toolErrors: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    })
    const merged = withPriorSteps(
      {
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: "stop",
        text: "Third.",
        steps: [],
      },
      [view("First."), view("Second.")] as never,
    )
    expect(merged.text).toBe("First.\n\nSecond.\n\nThird.")
  })

  describe("a resumed turn whose new attempt corrected a false claim", () => {
    const earlier = "Checked the invoice for Maison Lenoir. "
    const falseClaim = "I sent the reminder.\n\n"
    const correction = "Correction: the reminder is not sent; it waits for your approval."
    const prior = [
      {
        text: earlier,
        reasoning: "",
        timeline: [{ kind: "text" as const, text: earlier }],
        toolCalls: [],
        toolResults: [],
        toolErrors: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]
    const attempt = {
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: "stop",
      text: falseClaim + correction,
      stepTexts: [falseClaim + correction],
      timeline: [{ kind: "text" as const, text: falseClaim + correction }],
      steps: [],
    }
    // Measured on the attempt's own streamed text, as the guard counts it.
    const retraction = { end: falseClaim.length, text: falseClaim }

    it("keeps the earlier attempt's words whole and drops the false sent line", () => {
      const merged = withPriorSteps(
        retractedAttempt(attempt, { first: retraction, second: null }),
        prior as never,
      )
      expect(merged.text).toBe(`Checked the invoice for Maison Lenoir.\n\n${correction}`)
      expect(merged.timeline).toEqual([
        { kind: "text", text: earlier },
        { kind: "text", text: correction },
      ])
      expect(merged.text).not.toContain("I sent the reminder")
    })

    it("a cut whose text is not where it was measured leaves the timeline as it is", () => {
      const merged = withPriorSteps(attempt, prior as never)
      expect(retractFromTimeline(merged.timeline ?? [], retraction)).toEqual(merged.timeline ?? [])
    })
  })
})
