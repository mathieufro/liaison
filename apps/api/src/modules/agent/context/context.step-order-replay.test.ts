// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An earlier turn replays in the order the model produced it (context.ts,
// THE TURN'S STEPS, IN THE ORDER THE MODEL PRODUCED THEM): one assistant
// message per step (its words, then its calls), each followed by its results,
// and the closing words last. Before, the whole turn replayed as one assistant
// message with every step's words run together, the final answer included,
// ahead of every call.
import { describe, expect, it } from "bun:test"
import { convertToCoreMessages, stepsFromTimeline } from "~/modules/agent/context/context"

const call = (id: string, name = "kernel__web_search") => ({
  toolCallId: id,
  toolName: name,
  args: { q: id },
  result: { found: id },
})

const turn = (timeline: unknown, content: string, toolCalls = [call("a"), call("b")]) => ({
  authorType: "agent",
  content,
  metadata: { toolCalls, timeline },
})

const TIMELINE = [
  { kind: "reasoning", text: "Plan." },
  { kind: "text", text: "Looking." },
  { kind: "tool", toolCallId: "a" },
  { kind: "reasoning", text: "More." },
  { kind: "text", text: "Found it." },
  { kind: "tool", toolCallId: "b" },
  { kind: "text", text: "Done." },
]

describe("replaying an earlier turn step by step", () => {
  it("replays each step's words and calls, then its results, and the answer last", () => {
    const out = convertToCoreMessages([turn(TIMELINE, "Looking.Found it.Done.")]) as Array<{
      role: string
      content: unknown
    }>
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool", "assistant", "tool", "assistant"])
    const parts = (i: number) => out[i]?.content as Array<{ type: string; text?: string }>
    expect(parts(0).map((p) => p.type)).toEqual(["text", "tool-call"])
    expect(parts(0)[0]?.text).toBe("Looking.")
    expect(parts(2)[0]?.text).toBe("Found it.")
    expect(parts(1)).toHaveLength(1)
    expect(parts(3)).toHaveLength(1)
    expect(out[4]?.content).toBe("Done.")
    // Reasoning is never replayed.
    expect(JSON.stringify(out)).not.toContain("Plan.")
  })

  it("replays step by step a stored text whose steps are set apart as paragraphs", () => {
    const steps = stepsFromTimeline(TIMELINE, "Looking.\n\nFound it.\n\nDone.", [
      call("a"),
      call("b"),
    ])
    expect(steps?.map((s) => s.text)).toEqual(["Looking.", "Found it.", "Done."])
    // Different words are still a rewrite, whatever the spacing.
    expect(
      stepsFromTimeline(TIMELINE, "Looking.\n\nFound it.\n\nDone, and more.", [
        call("a"),
        call("b"),
      ]),
    ).toBeNull()
  })

  it("groups parallel calls of one step into one message", () => {
    const steps = stepsFromTimeline(
      [
        { kind: "tool", toolCallId: "a" },
        { kind: "tool", toolCallId: "b" },
        { kind: "text", text: "Both done." },
      ],
      "Both done.",
      [call("a"), call("b")],
    )
    expect(steps?.map((s) => [s.text, s.calls.map((c) => c.toolCallId)])).toEqual([
      ["", ["a", "b"]],
      ["Both done.", []],
    ])
  })

  it("falls back to the one-message form when the timeline does not match the row", () => {
    // A guard rewrote the stored text after the turn.
    expect(stepsFromTimeline(TIMELINE, "Rewritten.", [call("a"), call("b")])).toBeNull()
    // A stored call the timeline does not place.
    expect(
      stepsFromTimeline(TIMELINE, "Looking.Found it.Done.", [call("a"), call("b"), call("c")]),
    ).toBeNull()
    // No timeline, or one with no tool entry.
    expect(stepsFromTimeline(undefined, "x", [call("a")])).toBeNull()
    expect(stepsFromTimeline([{ kind: "text", text: "x" }], "x", [call("a")])).toBeNull()
    const out = convertToCoreMessages([turn(undefined, "All at once.")]) as Array<{ role: string }>
    expect(out.map((m) => m.role)).toEqual(["assistant", "tool"])
  })

  it("skips calls the replay leaves out where they stood", () => {
    const steps = stepsFromTimeline(TIMELINE, "Looking.Found it.Done.", [call("b")])
    expect(steps?.map((s) => [s.text, s.calls.map((c) => c.toolCallId)])).toEqual([
      ["Looking.Found it.", ["b"]],
      ["Done.", []],
    ])
  })
})
