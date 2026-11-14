// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { carriedGuideNotesRow, trimHistoryToBudget } from "~/modules/agent/context/checkpoint"
import { convertToCoreMessages } from "~/modules/agent/context/context"
import {
  GUIDE_NOTES_META_KEY,
  guidePartsInMessages,
  lastToolResultCallId,
  readGuideNotes,
  renderGuideNote,
  withGuideNotes,
} from "~/modules/agent/context/guide-notes"

describe("guide notes", () => {
  it("names the parts it carries, and only a guide note counts", () => {
    const note = renderGuideNote(["### tickets\nUse tickets."], ["tickets", "tickets#2"])
    expect(note.startsWith("<runtime-context")).toBe(true)
    const parts = guidePartsInMessages([
      { role: "user", content: note },
      { role: "user", content: '<runtime-context note="ephemeral" parts="mail">' },
      { role: "assistant", content: note },
    ])
    expect([...parts].sort()).toEqual(["tickets", "tickets#2"])
  })

  it("keeps each note where it was sent among the step responses", () => {
    const n1 = { role: "user", content: "n1" }
    const n2 = { role: "user", content: "n2" }
    const r = ["a0", "t0", "a1", "t1"].map((content) => ({ role: "x", content }))
    expect(
      withGuideNotes(r, [
        { at: 2, message: n1 },
        { at: 4, message: n2 },
      ]).map((m) => m.content),
    ).toEqual(["a0", "t0", "n1", "a1", "t1", "n2"])
    expect(withGuideNotes(r, []).map((m) => m.content)).toEqual(["a0", "t0", "a1", "t1"])
  })

  it("finds the last tool result's call", () => {
    expect(
      lastToolResultCallId([
        { role: "tool", content: [{ type: "tool-result", toolCallId: "c1" }] },
        { role: "assistant", content: "x" },
        {
          role: "tool",
          content: [
            { type: "tool-result", toolCallId: "c2" },
            { type: "tool-result", toolCallId: "c3" },
          ],
        },
      ]),
    ).toBe("c3")
    expect(lastToolResultCallId([{ role: "assistant", content: "x" }])).toBeNull()
  })

  it("reads only well-formed stored notes", () => {
    expect(
      readGuideNotes({
        [GUIDE_NOTES_META_KEY]: [
          { afterToolCallId: null, content: "a" },
          { afterToolCallId: "c1", content: "b" },
          { afterToolCallId: 3, content: "c" },
          { afterToolCallId: "c2" },
        ],
      }),
    ).toEqual([
      { afterToolCallId: null, content: "a" },
      { afterToolCallId: "c1", content: "b" },
    ])
    expect(readGuideNotes(null)).toEqual([])
  })

  it("replays a turn's notes where the turn sent them", () => {
    const call = (id: string) => ({
      toolCallId: id,
      toolName: "kernel__tool_search",
      args: { query: id },
      result: { ok: id },
    })
    const rows = [
      { id: "u1", authorType: "user", content: "find it", metadata: null },
      {
        id: "a1",
        authorType: "agent",
        content: "Looking.Done.",
        metadata: {
          toolCalls: [call("c1"), call("c2")],
          timeline: [
            { kind: "text", text: "Looking." },
            { kind: "tool", toolCallId: "c1" },
            { kind: "tool", toolCallId: "c2" },
            { kind: "text", text: "Done." },
          ],
          [GUIDE_NOTES_META_KEY]: [
            { afterToolCallId: null, content: "start-note" },
            { afterToolCallId: "c2", content: "step-note" },
          ],
        },
      },
    ]
    const out = convertToCoreMessages(rows)
    expect(out.map((m) => (typeof m.content === "string" ? m.content : m.role))).toEqual([
      "find it",
      "start-note",
      "assistant",
      "tool",
      "step-note",
      "Done.",
    ])
  })

  it("a guide sent in a row the tail cap dropped stays in the history, so it is not sent again", () => {
    const tickets = renderGuideNote(["### tickets\nUse tickets."], ["tickets"])
    const mail = renderGuideNote(["### mail\nUse mail."], ["mail"])
    const row = (id: string, authorType: string, content: string, notes: string[] = []) => ({
      id,
      authorType,
      content,
      metadata: notes.length
        ? { [GUIDE_NOTES_META_KEY]: notes.map((c) => ({ afterToolCallId: null, content: c })) }
        : {},
    })
    const rows = [
      row("u1", "user", "x".repeat(4_000)),
      row("a1", "agent", "y".repeat(4_000), [tickets]),
      row("u2", "user", "z".repeat(4_000)),
      row("a2", "agent", "w".repeat(4_000), [mail, tickets]),
      row("a3", "agent", "short answer", [mail]),
      row("u3", "user", "last question"),
    ]
    const trimmed = trimHistoryToBudget(rows, 1_200)
    expect(trimmed.droppedRows).toBeGreaterThan(1)
    const carried = carriedGuideNotesRow(rows.slice(0, trimmed.droppedRows), trimmed.rows, {
      threadId: "t",
      orgId: "o",
    })
    expect(carried).not.toBeNull()
    const replayed = convertToCoreMessages([carried as never, ...trimmed.rows] as never)
    expect([...guidePartsInMessages(replayed as never)]).toContain("tickets")
    // Each note once, however many dropped rows carried it.
    expect(replayed.filter((m) => m.content === tickets)).toHaveLength(1)
    expect(replayed.filter((m) => m.content === mail)).toHaveLength(1)
    expect(trimmed.rows.map((r) => r.id)).toEqual(["a3", "u3"])
    expect(carriedGuideNotesRow([rows[0] as never], [], { threadId: "t", orgId: "o" })).toBeNull()
  })
})
