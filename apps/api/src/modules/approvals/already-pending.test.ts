// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A second reply draft on a ticket (or mail conversation) that already holds a colleague's is
// refused. The refusal must tell the agent, before anything else, that a draft exists and that it
// updates THAT draft with kernel__approval_update_payload, naming the id and the editable fields;
// a refusal that only said "tell the user it is waiting" left the agent unable to redo the draft.
import { describe, expect, it } from "bun:test"
import { alreadyPendingMessage } from "~/modules/approvals/already-pending"

describe("alreadyPendingMessage", () => {
  const message = alreadyPendingMessage({
    toolName: "tickets:reply",
    keyParam: "ticketId",
    keyValue: "t-1",
    approvalRequestId: "appr-1",
    editableFields: ["textBody"],
  })

  it("opens with the existing draft and orders the update, not a second draft", () => {
    expect(message.startsWith("NOT STAGED: a draft ALREADY EXISTS.")).toBe(true)
    expect(message).toContain("Do NOT call tickets:reply again")
    expect(message).toContain("UPDATE THAT DRAFT")
  })

  it("spells out the edit call: tool, the draft's id as requestId, the editable fields", () => {
    expect(message).toContain("kernel__approval_update_payload with requestId appr-1")
    expect(message).toContain("editable fields: textBody")
  })

  it("says a colleague's draft may be edited, and the user is told only when the edit fails", () => {
    expect(message).toContain("Editing a colleague's waiting draft is expected")
    expect(message).toMatch(/Only if that update is refused, tell the user/)
  })

  it("with no editable field, points at the waiting card instead of an edit", () => {
    const m = alreadyPendingMessage({
      toolName: "x:y",
      keyParam: "k",
      keyValue: "v",
      approvalRequestId: "a",
      editableFields: [],
    })
    expect(m.startsWith("NOT STAGED:")).toBe(true)
    expect(m).toContain("Do NOT call x:y again")
    expect(m).toContain("approvalRequestId a")
    expect(m).not.toContain("approval_update_payload")
    expect(m).toContain("no tool decides it")
  })
})
