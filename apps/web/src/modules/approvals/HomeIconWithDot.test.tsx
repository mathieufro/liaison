// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { render } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it } from "vitest"
import { attentionStore } from "~/modules/shell/attention-store"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"
import HomeIconWithDot from "./HomeIconWithDot"

function makeThread(id: string, unreadCount: number, isMuted = false, title: string | null = "T") {
  return {
    id,
    handle: `thread-${id}`,
    title,
    isPinned: false,
    isPinnedByUser: false,
    isMuted,
    participants: [],
    updatedAt: new Date().toISOString(),
    unreadCount,
  }
}

const item = (over: Partial<AttentionItem>): AttentionItem => ({
  id: over.id ?? "att-1",
  app: over.app ?? "tickets",
  entity: over.entity ?? "ticket",
  entityId: over.entityId ?? "T-1",
  kind: over.kind ?? "sla_risk",
  summary: over.summary ?? "needs you",
  urgency: over.urgency ?? 70,
  occurredAt: "2026-05-06T12:00:00.000Z",
  action: { type: "open_entity", tabType: "tickets:ticket", entityId: "T-1" },
})

beforeEach(() => {
  attentionStore._setForTest({ items: [], errors: [], loading: false })
  resetThreadStore()
})

describe("HomeIconWithDot", () => {
  it("hides the dot when attention store is empty", () => {
    const { queryByTestId } = render(() => <HomeIconWithDot />)
    expect(queryByTestId("activity-bar-home-dot")).toBeNull()
  })

  // The dot marks Home content that needs no action (volume work, FYIs).
  const quiet = () => item({ app: "projects", kind: "task_due_this_week", urgency: 30 })

  it("shows the dot reactively when an attention item is present", () => {
    attentionStore._setForTest({ items: [quiet()], errors: [] })
    const { queryByTestId } = render(() => <HomeIconWithDot />)
    expect(queryByTestId("activity-bar-home-dot")).toBeTruthy()
  })

  it("hides the dot when items are cleared", () => {
    attentionStore._setForTest({ items: [quiet()], errors: [] })
    const { queryByTestId } = render(() => <HomeIconWithDot />)
    expect(queryByTestId("activity-bar-home-dot")).toBeTruthy()
    attentionStore._setForTest({ items: [] })
    expect(queryByTestId("activity-bar-home-dot")).toBeNull()
  })

  // --- Numeric badge: Home's own action count, never the unread messages ---
  // The Home icon used to draw the unread-message total, the same number the
  // Messages entry shows (owner, 2026-10-12: "the number on home and messages
  // are the same, which doesn't make sense"). Home counts what Home presents
  // as needing action; unread threads are the Messages badge's.
  describe("action badge", () => {
    const approval = (id: string, extra: Partial<AttentionItem> = {}): AttentionItem => ({
      ...item({
        id,
        app: "kernel",
        entity: "approval_request",
        entityId: id,
        kind: "approval_pending",
        urgency: 50,
      }),
      ...extra,
      action: { type: "decide_approval", approvalId: id },
    })

    // The rows of Needs you, nothing the section cannot open (owner, 2026-11-06).
    it("counts pending approvals and an SLA risk, not a channel's traffic", () => {
      addThread(makeThread("t1", 5))
      attentionStore._setForTest({
        items: [approval("a1"), item({ id: "sla-1" })],
        errors: [],
      })
      const { queryByTestId } = render(() => <HomeIconWithDot />)
      expect(queryByTestId("activity-bar-home-badge")?.textContent).toBe("2")
      expect(queryByTestId("activity-bar-home-dot")).toBeNull()
    })

    it("shows no number for an unread channel alone", () => {
      addThread(makeThread("t1", 5))
      const { queryByTestId } = render(() => <HomeIconWithDot />)
      expect(queryByTestId("activity-bar-home-badge")).toBeNull()
    })

    it("leaves the unread messages of a direct conversation to Messages", () => {
      addThread(makeThread("dm1", 3, false, null))
      addThread(makeThread("dm2", 4, true, null))
      const { queryByTestId } = render(() => <HomeIconWithDot />)
      expect(queryByTestId("activity-bar-home-badge")).toBeNull()
    })

    it("leaves a mention and a channel reply to Messages, with the quiet dot", () => {
      attentionStore._setForTest({
        items: [
          item({ id: "r1", app: "kernel", kind: "thread_reply", urgency: 30 }),
          item({ id: "m1", app: "kernel", kind: "mention", urgency: 60 }),
        ],
        errors: [],
      })
      const { queryByTestId } = render(() => <HomeIconWithDot />)
      expect(queryByTestId("activity-bar-home-badge")).toBeNull()
      expect(queryByTestId("activity-bar-home-dot")).not.toBeNull()
    })

    it("does not count peer requests Home folds away", () => {
      attentionStore._setForTest({
        items: [approval("a1"), approval("a2", { metadata: { placement: "others" } })],
        errors: [],
      })
      const { queryByTestId } = render(() => <HomeIconWithDot />)
      expect(queryByTestId("activity-bar-home-badge")?.textContent).toBe("1")
    })

    // D21, owner recommendation 1: a ticket awaiting a reply is queue volume
    // ("Your queues"), not a personal decision, so it is not in the badge.
    it("does not count tickets awaiting a reply", () => {
      attentionStore._setForTest({
        items: [
          approval("a1"),
          item({ id: "w1", kind: "awaiting_agent", urgency: 60 }),
          {
            ...item({ id: "w2", kind: "awaiting_agent", urgency: 60 }),
            metadata: { assignedTo: null },
          },
        ],
        errors: [],
      })
      const { queryByTestId } = render(() => <HomeIconWithDot />)
      expect(queryByTestId("activity-bar-home-badge")?.textContent).toBe("1")
    })

    it("does not count a routine that failed: Home files it under Agents", () => {
      attentionStore._setForTest({
        items: [
          {
            ...item({ id: "rt", app: "kernel", kind: "agent_notification", urgency: 75 }),
            metadata: { routineAlert: { routineId: "r1", status: "failed" } },
          },
        ],
        errors: [],
      })
      const { queryByTestId } = render(() => <HomeIconWithDot />)
      expect(queryByTestId("activity-bar-home-badge")).toBeNull()
    })

    it("follows the attention store live", () => {
      const { queryByTestId } = render(() => <HomeIconWithDot />)
      expect(queryByTestId("activity-bar-home-badge")).toBeNull()
      attentionStore._setForTest({ items: [approval("a1")], errors: [] })
      expect(queryByTestId("activity-bar-home-badge")?.textContent).toBe("1")
      attentionStore._setForTest({ items: [] })
      expect(queryByTestId("activity-bar-home-badge")).toBeNull()
    })

    it("caps the displayed text at 99+", () => {
      attentionStore._setForTest({
        items: Array.from({ length: 120 }, (_, i) => approval(`a${i}`)),
        errors: [],
      })
      const { queryByTestId } = render(() => <HomeIconWithDot />)
      expect(queryByTestId("activity-bar-home-badge")?.textContent).toBe("99+")
    })

    it("shows nothing when there is nothing on Home", () => {
      const { queryByTestId } = render(() => <HomeIconWithDot />)
      expect(queryByTestId("activity-bar-home-badge")).toBeNull()
      expect(queryByTestId("activity-bar-home-dot")).toBeNull()
    })
  })
})
