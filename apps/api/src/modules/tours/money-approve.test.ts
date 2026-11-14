// SPDX-License-Identifier: FSL-1.1-ALv2
// The money scenario's approve step: a rejected note leaves the scenario on
// that step, and a new draft of the reminder, approved, completes it. A
// reminder to someone else, or a note about anything but a payments invoice,
// never does.
import { describe, expect, it } from "bun:test"
import { findTour } from "@liaison/shared"
import type { AppEvent } from "~/infra/events/event-bus"
import { bindingMatches } from "~/modules/tours/consumer"

const approve = findTour("kernel.scenario-saas-money")?.beats.find((b) => b.id === "approve-note")
const binding = approve?.event
if (!binding) throw new Error("the money scenario has no approve step")

function decided(
  entityId: string,
  status: string,
  to = "claire@maison-arlon.example",
  refKind = "stripe:invoice",
): AppEvent {
  return {
    app: "kernel",
    entity: "approval_request",
    action: "update",
    entityId,
    orgId: "org",
    actorId: "owner",
    actorType: "user",
    timestamp: new Date().toISOString(),
    data: {
      status,
      toolName: "mail:compose",
      currentPayload: { to: [to], followUp: { refs: [{ kind: refKind, id: "in_x" }] } },
    },
  } as unknown as AppEvent
}

describe("the money scenario's approve step", () => {
  it("a rejected note leaves the tour at beat 4 and a new draft restores it", () => {
    if (!binding) return
    expect(bindingMatches(binding, decided("seeded-reminder", "denied"))).toBe(false)
    // The agent drafts the reminder again; the visitor approves the new one.
    expect(bindingMatches(binding, decided("new-draft", "approved"))).toBe(true)
  })

  it("a reminder to another customer, or about something else, does not complete it", () => {
    if (!binding) return
    expect(bindingMatches(binding, decided("other", "approved", "marc@lumen.example"))).toBe(false)
    expect(bindingMatches(binding, decided("deal", "approved", undefined, "projects:deal"))).toBe(
      false,
    )
  })
})
