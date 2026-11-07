// SPDX-License-Identifier: FSL-1.1-ALv2
// D21: Home's sidebar model. "Needs you" is the Home badge by construction;
// queues and agents hold the rest; conversations are not Home's.
import type { AttentionItem } from "@liaison/shared"
import { describe, expect, it } from "vitest"
import { homeActionItems } from "~/modules/shell/home-action-count"
import { buildHomeSections, filterSection, queueOf } from "~/modules/shell/home-sections"

const item = (over: Partial<AttentionItem> & { id: string }): AttentionItem => ({
  app: "tickets",
  entity: "ticket",
  entityId: over.id,
  kind: "sla_risk",
  summary: over.id,
  urgency: 50,
  occurredAt: "2026-10-12T08:00:00.000Z",
  action: { type: "open_entity", tabType: "tickets:ticket", entityId: over.id },
  ...over,
})

const approval = (id: string, tool = "mail:reply"): AttentionItem =>
  item({
    id,
    app: "kernel",
    entity: "approval_request",
    kind: "approval_pending",
    action: { type: "decide_approval", approvalId: id },
    metadata: { toolName: tool },
  })

const admin = { userId: "me", canGrantAccess: true }
const member = { userId: "me", canGrantAccess: false }

const feed: AttentionItem[] = [
  approval("a1"),
  approval("a2", "contacts:group_delete"),
  item({ id: "sla", kind: "sla_risk", urgency: 80 }),
  item({ id: "sys", app: "kernel", kind: "system_alert", urgency: 50 }),
  item({ id: "scope", app: "kernel", kind: "scope_request", urgency: 60 }),
  // A ticket awaiting a reply: someone's, and one assigned to me.
  item({ id: "wait-any", kind: "awaiting_agent", urgency: 60, metadata: { assignedTo: null } }),
  item({ id: "wait-mine", kind: "awaiting_agent", urgency: 60, metadata: { assignedTo: "me" } }),
  item({ id: "overdue", app: "projects", entity: "task", kind: "task_overdue", urgency: 40 }),
  // Agent notifications: one routine alert, one FYI.
  item({
    id: "rt",
    app: "kernel",
    kind: "agent_notification",
    urgency: 60,
    metadata: { routineAlert: { routineId: "r1", status: "failed" } },
  }),
  item({ id: "fyi", app: "kernel", kind: "agent_notification", urgency: 30 }),
  // Conversations: Messages', never Home's.
  item({ id: "mention", app: "kernel", entity: "thread", kind: "mention", urgency: 60 }),
  item({ id: "reply", app: "kernel", entity: "thread", kind: "thread_reply", urgency: 30 }),
  item({
    id: "follow",
    app: "kernel",
    entity: "reply_thread",
    kind: "thread_followup",
    urgency: 30,
  }),
]

describe("buildHomeSections", () => {
  it("Needs you is the badge's own list, split into rows that add up to it", () => {
    const s = buildHomeSections(feed, { viewer: admin })
    expect(s.needs.total).toBe(homeActionItems(feed, true, admin).length)
    const rows = s.needs.timeLimited.length + s.needs.approvals.length + s.needs.alerts.length
    expect(rows).toBe(s.needs.total)
    // The access request is a decision: it is in the approvals list, not the alerts.
    expect(s.needs.approvals.map((i) => i.id)).toEqual(["a1", "a2", "scope"])
    expect(s.needs.alerts.map((i) => i.id).sort()).toEqual(["sla", "sys", "wait-mine"])
  })

  it("files a ticket awaiting a reply under Your queues unless it is assigned to the viewer", () => {
    const s = buildHomeSections(feed, { viewer: admin })
    const support = s.queues.find((g) => g.app === "tickets")
    expect(support?.items.map((i) => i.id)).toEqual(["wait-any"])
    expect(s.needs.alerts.some((i) => i.id === "wait-any")).toBe(false)
    expect(homeActionItems(feed, true, admin).some((i) => i.id === "wait-any")).toBe(false)
  })

  it("shows access requests only to someone who can grant them", () => {
    const s = buildHomeSections(feed, { viewer: member })
    expect(s.needs.approvals.some((i) => i.id === "scope")).toBe(false)
    expect(s.needs.alerts.some((i) => i.id === "scope")).toBe(false)
    expect(s.needs.approvalFacets.some((f) => f.key === "kernel:access_requests")).toBe(false)
    expect(s.needs.total).toBe(homeActionItems(feed, true, member).length)
    expect(homeActionItems(feed, true, member).some((i) => i.id === "scope")).toBe(false)
  })

  it("files a routine that failed under Agents, not under notifications or Needs you", () => {
    const s = buildHomeSections(feed, { viewer: admin })
    expect(s.agents.failed.map((i) => i.id)).toEqual(["rt"])
    expect(s.agents.notifications.map((i) => i.id)).toEqual(["fyi"])
    expect(homeActionItems(feed, true, admin).some((i) => i.id === "rt")).toBe(false)
  })

  it("keeps conversations out of Home: no mention, reply or followed thread anywhere", () => {
    const s = buildHomeSections(feed, { viewer: admin })
    const everywhere = [
      ...s.needs.timeLimited,
      ...s.needs.approvals,
      ...s.needs.alerts,
      ...s.queues.flatMap((g) => g.items),
      ...s.agents.failed,
      ...s.agents.notifications,
    ].map((i) => i.id)
    expect(everywhere).not.toContain("mention")
    expect(everywhere).not.toContain("reply")
    expect(everywhere).not.toContain("follow")
    expect(s.queueTotal).toBe(s.queues.reduce((n, g) => n + g.items.length, 0))
  })

  // Walk 2026-10-12 (demo, appreview): a social app's reply suggestions
  // (`social` mention and approval_pending rows, opened rather than decided
  // inline) are NOW kinds the badge does not count, so they fell out of every
  // section. They are the "Social replies" queue.
  it("files another app's mentions and reply suggestions under Your queues", () => {
    const social = [
      item({ id: "s-m", app: "social", entity: "comment", kind: "mention", urgency: 60 }),
      item({ id: "s-a", app: "social", entity: "reply", kind: "approval_pending", urgency: 60 }),
    ]
    const s = buildHomeSections([...feed, ...social], { viewer: admin })
    const group = s.queues.find((g) => g.app === "social")
    expect(group?.items.map((i) => i.id).sort()).toEqual(["s-a", "s-m"])
    expect(s.needs.total).toBe(homeActionItems([...feed, ...social], true, admin).length)
  })

  it("puts an expiring prompt first, apart from the approvals", () => {
    const soon = new Date(Date.now() + 8 * 60_000).toISOString()
    const prompt = item({
      id: "node",
      app: "kernel",
      kind: "agent_notification",
      urgency: 80,
      metadata: { nodePermission: { expiresAt: soon } },
    })
    const s = buildHomeSections([prompt, ...feed], { viewer: admin })
    expect(s.needs.timeLimited.map((i) => i.id)).toEqual(["node"])
    expect(s.needs.total).toBe(homeActionItems([prompt, ...feed], true, admin).length)
  })

  // D21a: S9's new-email cards are a production feature. D21 dropped them
  // (mail was carded on Home's old Mail card, so splitFeed's groups skip it).
  // They live under Your queues as "New mail": not Needs you, not the badge.
  it("files new emails under Your queues as New mail, outside Needs you and the badge", () => {
    const mail = item({
      id: "mail:new_email:m1",
      app: "mail",
      entity: "new_email",
      entityId: "m1",
      kind: "new_email" as AttentionItem["kind"],
      urgency: 40,
      persisted: true,
      action: { type: "open_entity", tabType: "mail:conversation", entityId: "c1" },
    })
    const replyApproval = approval("mail-approval")
    const s = buildHomeSections([mail, replyApproval], { viewer: admin })
    const group = s.queues.find((g) => g.key === "mail")
    expect(group?.items.map((i) => i.id)).toEqual(["mail:new_email:m1"])
    expect(group?.labelKey).toBe("kernel.homeSidebar.newMail")
    expect(s.queueTotal).toBe(1)
    // A mail reply approval is still a decision in Needs you.
    expect(s.needs.approvals.map((i) => i.id)).toEqual(["mail-approval"])
    expect(s.needs.total).toBe(1)
    expect(homeActionItems([mail, replyApproval], false, admin)).toHaveLength(1)
  })

  it("an empty feed has nothing anywhere", () => {
    const s = buildHomeSections([], { viewer: admin })
    expect(s.needs.total).toBe(0)
    expect(s.queues).toEqual([])
    expect(s.agents.failed).toEqual([])
    expect(s.agents.notifications).toEqual([])
  })
})

describe("filters", () => {
  it("map each filter to its section", () => {
    expect(filterSection("needs:approvals:mail:reply")).toBe("needs")
    expect(filterSection("queue:tickets|awaiting_agent")).toBe("queues")
    expect(filterSection("agents:waiting")).toBe("agents")
    expect(filterSection("today")).toBe("today")
    expect(filterSection("overview")).toBe("overview")
    expect(queueOf("queue:tickets|awaiting_agent")).toEqual({
      key: "tickets",
      kind: "awaiting_agent",
    })
    expect(queueOf("queue:projects")).toEqual({ key: "projects", kind: null })
  })
})

describe("a routine run waiting for the viewer's private mailbox", () => {
  const waitItem = (id: string, expiresAt: string): AttentionItem =>
    item({
      id,
      app: "kernel",
      entity: "agent_notification",
      entityId: `routine-mailbox-wait:${id}`,
      kind: "routine_mailbox_wait",
      urgency: 60,
      action: { type: "open_entity", tabType: "thread", entityId: "t-1" },
      metadata: {
        routineMailboxWait: { routineId: "r-1", routineName: "Inbox", runId: id, expiresAt },
      },
    })
  const soon = () => new Date(Date.now() + 20 * 3600 * 1000).toISOString()
  const past = () => new Date(Date.now() - 1000).toISOString()

  it("is in the approvals list, once, and nowhere else on Home", () => {
    const withWait = [...feed, waitItem("w1", soon())]
    const s = buildHomeSections(withWait, { viewer: admin })
    expect(s.needs.approvals.map((i) => i.id)).toEqual(["a1", "a2", "scope", "w1"])
    expect(s.needs.alerts.some((i) => i.id === "w1")).toBe(false)
    expect(s.needs.timeLimited.some((i) => i.id === "w1")).toBe(false)
    expect(s.agents.notifications.some((i) => i.id === "w1")).toBe(false)
    expect(s.agents.failed.some((i) => i.id === "w1")).toBe(false)
    expect(s.queues.flatMap((g) => g.items).some((i) => i.id === "w1")).toBe(false)
    expect(homeActionItems(withWait, true, admin).filter((i) => i.id === "w1")).toHaveLength(1)
    // It has no tool: it and the access request each file under a kind facet.
    expect(s.needs.approvalFacets.map((f) => f.key).sort()).toEqual([
      "contacts:group_delete",
      "kernel:access_requests",
      "kernel:routine_runs",
      "mail:reply",
    ])
    const kinds = s.needs.approvalFacets.filter((f) => f.labelKey)
    expect(kinds.map((f) => f.labelKey).sort()).toEqual([
      "kernel.approvalKinds.accessRequests",
      "kernel.approvalKinds.routineRuns",
    ])
  })

  it("once expired it has left the list (and the badge)", () => {
    const withWait = [...feed, waitItem("w2", past())]
    const s = buildHomeSections(withWait, { viewer: admin })
    expect(s.needs.approvals.map((i) => i.id)).toEqual(["a1", "a2", "scope"])
    expect(homeActionItems(withWait, true, admin).some((i) => i.id === "w2")).toBe(false)
    expect(s.agents.notifications.some((i) => i.id === "w2")).toBe(false)
  })
})
