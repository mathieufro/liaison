// SPDX-License-Identifier: FSL-1.1-ALv2
// D21: Home's own sidebar. Sections and counts come from the attention feed;
// "Needs you" adds up to the Home badge; every entry filters the main panel.
import type { AttentionItem } from "@liaison/shared"
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const auth = vi.hoisted(() => ({ canGrant: true, denied: new Set<string>() }))
vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: (scope: string) =>
    !auth.denied.has(scope) && (scope !== "kernel:scope_requests:admin" || auth.canGrant),
  userFromToken: () => ({ userId: "me", name: "Tester", scopes: [] }),
}))

const apiGet = vi.fn()
const apiPost = vi.fn()
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ get: apiGet, post: apiPost }),
  useOptionalApi: () => ({ get: apiGet, post: apiPost }),
}))

import HomeIconWithDot from "~/modules/approvals/HomeIconWithDot"
import { attentionStore } from "~/modules/shell/attention-store"
import { HomeAgentsTestAccess, resetHomeAgents } from "~/modules/shell/home-agents-store"
import { homeFilter, setHomeFilter } from "~/modules/shell/home-filter"
import { tabStore } from "~/modules/shell/tab-store"
import { resetSidebarSections } from "~/modules/threads/sidebar-sections"
import HomeAttentionSidebar from "./HomeAttentionSidebar"
import HomeBriefCard from "./HomeBriefCard"

const item = (over: Partial<AttentionItem> & { id: string }): AttentionItem => ({
  app: "tickets",
  entity: "ticket",
  entityId: over.id,
  kind: "sla_risk",
  summary: `summary ${over.id}`,
  urgency: 50,
  occurredAt: "2026-10-12T08:00:00.000Z",
  action: { type: "open_entity", tabType: "tickets:ticket", entityId: over.id },
  ...over,
})
const approval = (id: string, tool: string): AttentionItem =>
  item({
    id,
    app: "kernel",
    entity: "approval_request",
    kind: "approval_pending",
    action: { type: "decide_approval", approvalId: id },
    metadata: { toolName: tool, actionLabel: tool },
  })

const busy: AttentionItem[] = [
  approval("a1", "contacts:group_delete"),
  approval("a2", "contacts:group_delete"),
  approval("a3", "mail:reply"),
  item({ id: "scope", app: "kernel", kind: "scope_request", urgency: 60 }),
  item({ id: "sys1", app: "kernel", kind: "system_alert" }),
  item({ id: "sys2", app: "kernel", kind: "system_alert" }),
  item({ id: "w1", kind: "awaiting_agent", urgency: 60 }),
  item({ id: "w2", kind: "awaiting_agent", urgency: 60 }),
  item({ id: "n1", kind: "nudge_due", urgency: 40 }),
  item({ id: "t1", app: "projects", entity: "task", kind: "task_overdue", urgency: 40 }),
  item({
    id: "rt",
    app: "kernel",
    kind: "agent_notification",
    urgency: 60,
    metadata: { routineAlert: { routineId: "r1", status: "failed" } },
  }),
  item({ id: "fyi", app: "kernel", kind: "agent_notification", urgency: 30 }),
  item({ id: "dm", app: "kernel", entity: "thread", kind: "thread_reply", urgency: 30 }),
]

beforeEach(() => {
  auth.canGrant = true
  auth.denied = new Set()
  attentionStore._setForTest({ items: [], errors: [], loading: false, lastFetchedAt: null })
  resetHomeAgents()
  resetSidebarSections()
  setHomeFilter("overview")
  try {
    localStorage.clear()
  } catch {}
  apiGet.mockReset().mockImplementation(async (path: string) => {
    if (path.startsWith("/agent/routines/latest-brief")) return null
    if (path.startsWith("/nodes/me")) return { nodes: [] }
    return []
  })
  apiPost.mockReset().mockResolvedValue([])
})

const count = (testid: string) => screen.queryByTestId(`${testid}-count`)?.textContent ?? null

describe("HomeAttentionSidebar", () => {
  it("lists Needs you, Your queues and Agents with the feed's counts", () => {
    attentionStore._setForTest({ items: busy })
    render(() => <HomeAttentionSidebar />)
    // The two system alerts are one row: 4 approvals + 1 alert row.
    expect(screen.getByTestId("home-side-needs-total").textContent).toBe("5")
    // The access request is in Approvals (its own facet), not a row apart.
    expect(count("home-side-approvals")).toBe("4")
    expect(count("home-side-approvals-contacts:group_delete")).toBe("2")
    expect(count("home-side-approvals-mail:reply")).toBe("1")
    expect(count("home-side-approvals-kernel:access_requests")).toBe("1")
    expect(screen.getByTestId("home-side-approvals-kernel:access_requests").textContent).toContain(
      "Access requests",
    )
    expect(screen.queryByTestId("home-side-access")).toBeNull()
    expect(count("home-side-alerts")).toBe("1")
    // Tickets awaiting a reply are Support queue volume, with the nudge.
    expect(count("home-side-queue-tickets")).toBe("3")
    expect(count("home-side-queue-tickets-awaiting_agent")).toBe("2")
    expect(count("home-side-queue-projects")).toBe("1")
    expect(count("home-side-failed")).toBe("1")
    expect(count("home-side-notifications")).toBe("1")
    // Needs-you counts are the accent pill, queues are grey, failures red.
    expect(screen.getByTestId("home-side-approvals-count").dataset.tone).toBe("accent")
    expect(screen.getByTestId("home-side-queue-tickets-count").dataset.tone).toBe("muted")
    expect(screen.getByTestId("home-side-failed-count").dataset.tone).toBe("danger")
  })

  // Rule 6: the Home badge is THE badge (direct asks), so of Needs you it
  // counts the approvals the viewer decides; system alerts are not asks.
  it("the Home badge is the total of Needs you, its system alerts included", () => {
    attentionStore._setForTest({ items: busy })
    render(() => (
      <>
        <HomeIconWithDot />
        <HomeAttentionSidebar />
      </>
    ))
    expect(screen.getByTestId("home-side-needs-total").textContent).toBe("5")
    expect(screen.getByTestId("activity-bar-home-badge").textContent).toBe("5")
  })

  it("shows a member no access requests, and the badge agrees", () => {
    auth.canGrant = false
    attentionStore._setForTest({ items: busy })
    render(() => (
      <>
        <HomeIconWithDot />
        <HomeAttentionSidebar />
      </>
    ))
    expect(screen.queryByTestId("home-side-approvals-kernel:access_requests")).toBeNull()
    expect(count("home-side-approvals")).toBe("3")
    expect(screen.getByTestId("home-side-needs-total").textContent).toBe("4")
    expect(screen.getByTestId("activity-bar-home-badge").textContent).toBe("4")
  })

  it("says Nothing needs you, and hides the empty sections", () => {
    render(() => <HomeAttentionSidebar />)
    expect(screen.getByTestId("home-side-needs-empty")).toBeTruthy()
    expect(screen.queryByTestId("home-side-queues")).toBeNull()
    expect(screen.queryByTestId("home-side-today")).toBeNull()
    expect(screen.queryByTestId("home-side-failed")).toBeNull()
  })

  it("filters the main panel when an entry is clicked, and opens Home", () => {
    attentionStore._setForTest({ items: busy })
    render(() => <HomeAttentionSidebar />)
    fireEvent.click(screen.getByTestId("home-side-approvals-mail:reply"))
    expect(homeFilter()).toBe("needs:approvals:mail:reply")
    expect(tabStore.tabs.find((t) => t.id === tabStore.activeTabId)?.type).toBe("kernel:home")
    fireEvent.click(screen.getByTestId("home-side-queue-tickets"))
    expect(homeFilter()).toBe("queue:tickets")
    fireEvent.click(screen.getByTestId("home-side-failed"))
    expect(homeFilter()).toBe("agents:failed")
    fireEvent.click(screen.getByTestId("home-side-overview"))
    expect(homeFilter()).toBe("overview")
  })

  it("Agents: the brief, my computer, and my requests waiting on others", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith("/agent/routines/latest-brief"))
        return {
          routineId: "r",
          name: "Morning brief",
          status: "active",
          enabled: true,
          lastRunAt: "2026-10-12T08:00:00.000Z",
          lastRunStatus: "succeeded",
          outputThreadId: "th",
          messageId: null,
        }
      if (path.startsWith("/nodes/me"))
        return { nodes: [{ enabled: true, online: true }], queuedJobs: 2 }
      if (path.startsWith("/approvals?status=pending&requestedByMe=true"))
        return [
          { id: "req-1", handle: "request-1", threadId: "th1", summary: { title: "Reply" } },
          // Mine to decide too: already under Needs you, not "waiting on others".
          { id: "a3", handle: "request-3", threadId: "th3", summary: { title: "Mine" } },
        ]
      return []
    })
    attentionStore._setForTest({ items: busy })
    render(() => <HomeAttentionSidebar />)
    expect(await screen.findByTestId("home-side-brief")).toBeTruthy()
    expect((await screen.findByTestId("home-side-computer-status")).dataset.online).toBe("true")
    expect(count("home-side-computer")).toContain("2")
    expect((await screen.findByTestId("home-side-waiting-count")).textContent).toBe("1")
  })

  it("the brief shows one time, its newest message's, the same as Home's brief card", async () => {
    apiGet.mockImplementation(async (path: string) => {
      if (path.startsWith("/agent/routines/latest-brief"))
        return {
          routineId: "r",
          name: "Morning brief",
          status: "active",
          enabled: true,
          // The routine ran an hour before its brief was written.
          lastRunAt: "2026-10-12T08:00:00.000Z",
          lastRunStatus: "succeeded",
          outputThreadId: "th",
          messageId: "m1",
          messageAt: "2026-10-12T09:15:00.000Z",
        }
      if (path.startsWith("/home/brief"))
        return {
          routineId: "r",
          routineName: "Morning brief",
          message: { id: "m1", threadId: "th", text: "Today", at: "2026-10-12T09:15:00.000Z" },
        }
      return []
    })
    attentionStore._setForTest({ items: busy })
    render(() => (
      <>
        <HomeAttentionSidebar />
        <HomeBriefCard />
      </>
    ))
    const cardTime = (await screen.findByTestId("home-brief-time")).textContent
    await screen.findByTestId("home-side-brief")
    await vi.waitFor(() => expect(count("home-side-brief")).toBe(cardTime))
    const ranAt = new Date("2026-10-12T08:00:00.000Z").toLocaleTimeString("en", {
      hour: "2-digit",
      minute: "2-digit",
    })
    expect(count("home-side-brief")).not.toBe(ranAt)
  })

  it("offers to set up a morning brief when there is none", async () => {
    render(() => <HomeAttentionSidebar />)
    expect(await screen.findByTestId("home-side-brief-setup")).toBeTruthy()
  })

  // Walk 2026-10-12 (demo, matrix-nodevice): a member without the routines
  // scopes got two "Permission denied" toasts from the brief lookup, and an
  // offer to set up a brief they cannot create.
  it("never asks for the brief without the routines scopes, nor offers one", async () => {
    auth.denied = new Set(["kernel:routines:read", "kernel:routines:write"])
    render(() => <HomeAttentionSidebar />)
    await Promise.resolve()
    expect(apiGet.mock.calls.some(([p]) => String(p).includes("latest-brief"))).toBe(false)
    expect(screen.queryByTestId("home-side-brief-setup")).toBeNull()
    // Nothing in Agents: the section is hidden, not an empty header.
    expect(screen.queryByTestId("home-side-agents")).toBeNull()
  })

  it("lists today's next events", () => {
    render(() => <HomeAttentionSidebar />)
    HomeAgentsTestAccess.set({
      today: [
        { id: "e1", title: "Call with Nordlicht", start: "2026-10-12T14:00:00", allDay: false },
      ],
    })
    expect(screen.getByTestId("home-side-today")).toBeTruthy()
    expect(screen.getByTestId("home-side-event-e1").textContent).toContain("Call with Nordlicht")
  })

  // Walk 2026-10-12 (1280 px, en-US): "03:00 PM" wrapped onto two lines in the
  // 52 px time column. The time never wraps.
  it("an event's time stays on one line", () => {
    render(() => <HomeAttentionSidebar />)
    HomeAgentsTestAccess.set({
      today: [{ id: "e1", title: "Supplier call", start: "2026-10-12T15:00:00", allDay: false }],
    })
    const time = screen.getByTestId("home-side-event-e1-time")
    expect(time.className).toContain("whitespace-nowrap")
    expect(time.className).not.toMatch(/(^|\s)w-\[52px\]/)
  })

  it("Dashboards live in their own sidebar: Home neither reads nor lists them", async () => {
    render(() => <HomeAttentionSidebar />)
    await Promise.resolve()
    expect(apiGet).not.toHaveBeenCalledWith("/dashboards")
    expect(screen.queryByTestId("home-side-dashboards")).toBeNull()
  })
})
