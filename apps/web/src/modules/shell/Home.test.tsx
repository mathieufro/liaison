// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Tester" }),
}))

const apiGet = vi.fn()
const apiGetEnvelope = vi.fn()
const apiPost = vi.fn(async () => ({}))
const apiPatch = vi.fn(async () => ({}))
const apiPut = vi.fn(async () => ({}))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({
    get: apiGet,
    getEnvelope: apiGetEnvelope,
    post: apiPost,
    patch: apiPatch,
    put: apiPut,
  }),
  useOptionalApi: () => ({
    get: apiGet,
    getEnvelope: apiGetEnvelope,
    post: apiPost,
    patch: apiPatch,
    put: apiPut,
  }),
}))

import { createSignal } from "solid-js"
import { registerEntityOpener, resetRegistry } from "~/framework/app-registry"
import { attentionStore } from "~/modules/shell/attention-store"
import { resetHomeCardLayout } from "~/modules/shell/home-card-layout"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import { tabStore } from "~/modules/shell/tab-store"
import { addThread, handleMessageEvent, resetThreadStore } from "~/modules/threads/thread-store"
import Home from "./Home"

const makeOpenEntityItem = (over: Partial<AttentionItem>): AttentionItem => ({
  id: over.id ?? "att-1",
  app: over.app ?? "projects",
  entity: over.entity ?? "task",
  entityId: over.entityId ?? "T1",
  kind: over.kind ?? "task_overdue",
  summary: over.summary ?? "Task is overdue",
  urgency: over.urgency ?? 60,
  occurredAt: over.occurredAt ?? "2026-05-06T12:00:00.000Z",
  action: over.action ?? {
    type: "open_entity",
    tabType: `${over.app ?? "projects"}:${over.entity ?? "task"}`,
    entityId: over.entityId ?? "T1",
  },
  metadata: over.metadata,
})

beforeEach(() => {
  attentionStore._setForTest({ items: [], errors: [], loading: false })
  resetRegistry()
  resetHomeCardLayout()
  resetThreadStore()
  apiGet.mockReset().mockResolvedValue([])
  apiGetEnvelope.mockReset().mockResolvedValue({ data: { items: [], errors: [] } })
  apiPost.mockReset().mockResolvedValue({})
  apiPatch.mockReset().mockResolvedValue({})
  apiPut.mockReset().mockResolvedValue({})
})

const makeMentionItem = (over: Partial<AttentionItem>): AttentionItem => ({
  id: over.id ?? "att-mention-1",
  app: "kernel",
  entity: "thread",
  entityId: over.entityId ?? "thread-1",
  kind: "mention",
  summary: over.summary ?? "Alice mentioned you",
  urgency: 60,
  occurredAt: over.occurredAt ?? "2026-05-06T12:00:00.000Z",
  action: over.action ?? {
    type: "open_entity",
    tabType: "kernel:thread",
    entityId: over.entityId ?? "thread-1",
  },
  persisted: true,
})

const makeApprovalItem = (over: Partial<AttentionItem>): AttentionItem => ({
  id: over.id ?? `att-approval-${Math.random().toString(36).slice(2)}`,
  app: "invoicing",
  entity: "document",
  entityId: over.entityId ?? "doc-1",
  kind: "approval_pending",
  summary: over.summary ?? "Mark invoice paid",
  urgency: over.urgency ?? 40,
  occurredAt: "2026-05-06T12:00:00.000Z",
  action: { type: "decide_approval", approvalId: over.entityId ?? "doc-1" },
  metadata: over.metadata,
})

function makeThread(over: Partial<Parameters<typeof addThread>[0]> = {}) {
  return {
    id: over.id ?? "thread-1",
    handle: over.handle ?? "thread-1",
    title: over.title ?? "Team sync",
    type: "thread",
    isPinned: false,
    isPinnedByUser: false,
    isMuted: false,
    participants: [{ id: "u-1", name: "Tester", avatarUrl: null }],
    lastMessage: over.lastMessage ?? {
      content: "hey",
      authorId: "u-2",
      authorName: "Alice",
      createdAt: "2026-05-06T12:00:00.000Z",
    },
    unreadCount: over.unreadCount ?? 2,
    updatedAt: over.updatedAt ?? "2026-05-06T12:00:00.000Z",
    ...over,
  }
}

describe("home.unified-feed-no-approvals-store", () => {
  it("home.unified-feed-no-approvals-store", () => {
    attentionStore._setForTest({
      items: [makeOpenEntityItem({ app: "projects", entity: "task" })],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-feed")).toBeTruthy()
    // ApprovalCard should not appear because Home no longer reads approvals-store.
    expect(screen.queryByTestId("approval-card-stub")).toBeNull()
  })

  it("home.attention-row-open-entity-opens-through-opener", async () => {
    const item = makeOpenEntityItem({
      app: "projects",
      entity: "task",
      entityId: "T1",
    })
    attentionStore._setForTest({ items: [item], errors: [] })
    registerEntityOpener("projects", "task", (_api, id) => ({
      tabType: "projects:task",
      entityId: id,
      label: `Task ${id}`,
    }))
    render(() => <Home entityId="home" />)
    fireEvent.click(screen.getByTestId("attention-row-projects-task-T1"))
    // openEntity is async — wait a microtask.
    await Promise.resolve()
    await Promise.resolve()
    expect(tabStore.activeTabId).toContain("projects:task")
  })

  it("renders empty state when there are no items", () => {
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-empty-state")).toBeTruthy()
  })

  it("last-updated label advances from just now to 1m ago as the clock ticks", async () => {
    vi.useFakeTimers()
    const base = new Date("2026-05-06T10:00:00.000Z").getTime()
    vi.setSystemTime(base)
    attentionStore._setForTest({
      items: [makeOpenEntityItem({})],
      errors: [],
      lastFetchedAt: base,
    })
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-status").textContent).toContain("just now")

    // Advance past 60s and fire the 30s ticking signal.
    vi.setSystemTime(base + 65_000)
    vi.advanceTimersByTime(30_000)
    await Promise.resolve()
    expect(screen.getByTestId("home-status").textContent).toContain("1m ago")
    vi.useRealTimers()
  })

  it("activation with a stale attention store triggers a reload; a fresh one does not", async () => {
    const reloadSpy = vi.spyOn(attentionStore, "markStaleAndReload").mockImplementation(() => {})
    try {
      // Stale: lastFetchedAt well older than the 60s threshold.
      attentionStore._setForTest({
        items: [makeOpenEntityItem({})],
        errors: [],
        lastFetchedAt: Date.now() - 120_000,
      })
      const [active, setActive] = createSignal(false)
      render(() => (
        <TabVisibilityProvider value={active}>
          <Home entityId="home" />
        </TabVisibilityProvider>
      ))
      expect(reloadSpy).not.toHaveBeenCalled()
      setActive(true)
      await Promise.resolve()
      expect(reloadSpy).toHaveBeenCalledTimes(1)
    } finally {
      reloadSpy.mockRestore()
    }
  })

  it("activation with a fresh attention store does not reload", async () => {
    const reloadSpy = vi.spyOn(attentionStore, "markStaleAndReload").mockImplementation(() => {})
    try {
      attentionStore._setForTest({
        items: [makeOpenEntityItem({})],
        errors: [],
        lastFetchedAt: Date.now(), // fresh
      })
      const [active, setActive] = createSignal(false)
      render(() => (
        <TabVisibilityProvider value={active}>
          <Home entityId="home" />
        </TabVisibilityProvider>
      ))
      setActive(true)
      await Promise.resolve()
      expect(reloadSpy).not.toHaveBeenCalled()
    } finally {
      reloadSpy.mockRestore()
    }
  })

  it("greeting flips from morning to afternoon across a clock tick", async () => {
    vi.useFakeTimers()
    const morning = new Date("2026-05-06T09:00:00.000Z").getTime()
    vi.setSystemTime(morning)
    render(() => <Home entityId="home" />)
    const heading = () => document.querySelector("h1")?.textContent ?? ""
    const local9 = new Date(morning).getHours()
    // Only assert the flip when the fixture's local hour actually starts in the
    // morning band; otherwise the UTC hour maps to a different local band.
    if (local9 < 12) {
      expect(heading()).toContain("Good morning")
      vi.setSystemTime(new Date("2026-05-06T14:00:00.000Z").getTime())
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
      const localAfternoon = new Date("2026-05-06T14:00:00.000Z").getHours()
      if (localAfternoon >= 12 && localAfternoon < 18) {
        expect(heading()).toContain("Good afternoon")
      }
    }
    vi.useRealTimers()
  })
})

describe("home.cards", () => {
  it("empty approvals card is absent when there are no pending approvals", () => {
    attentionStore._setForTest({
      items: [makeOpenEntityItem({ app: "projects", entity: "task" })],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("home-card-approvals")).toBeNull()
  })

  it("5 rows no fold, 6 rows fold to 3", () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        makeApprovalItem({ id: `att-approval-${i}`, entityId: `doc-${i}` }),
      )
    attentionStore._setForTest({ items: make(5), errors: [] })
    const five = render(() => <Home entityId="home" />)
    let body = screen.getByTestId("home-card-body-approvals")
    expect(body.querySelectorAll("li[data-testid^='attention-row-']")).toHaveLength(5)
    expect(screen.queryByTestId("home-approvals-fold")).toBeNull()
    five.unmount()

    attentionStore._setForTest({ items: make(6), errors: [] })
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-card-count-approvals").textContent).toBe("6")
    body = screen.getByTestId("home-card-body-approvals")
    expect(body.className).not.toContain("overflow-y-auto")
    expect(body.querySelectorAll("li[data-testid^='attention-row-']")).toHaveLength(3)
    const fold = screen.getByTestId("home-approvals-fold")
    expect(fold.textContent).toContain("3")
    fireEvent.click(fold)
    expect(body.querySelectorAll("li[data-testid^='attention-row-']")).toHaveLength(6)
    expect(screen.getByTestId("home-approvals-fold").textContent).toContain("Show fewer")
  })

  it("order kept: the first three are the most urgent, and unfolding keeps the order", () => {
    const items = [10, 90, 50, 70, 30, 80].map((urgency, i) =>
      makeApprovalItem({ id: `att-approval-${i}`, entityId: `doc-${urgency}`, urgency }),
    )
    attentionStore._setForTest({ items, errors: [] })
    render(() => <Home entityId="home" />)
    const body = screen.getByTestId("home-card-body-approvals")
    const ids = () =>
      [...body.querySelectorAll("li[data-testid^='attention-row-']")].map((el) =>
        el.getAttribute("data-testid")?.replace("attention-row-invoicing-document-", ""),
      )
    const folded = ids()
    fireEvent.click(screen.getByTestId("home-approvals-fold"))
    const all = ids()
    expect(all.slice(0, 3)).toEqual(folded)
    expect(new Set(all)).toEqual(new Set(items.map((i) => i.entityId)))
  })

  // D21: conversations left Home for Messages. An unread thread and a pinned
  // mention used to fill a "Messages" card here; neither renders now.
  it("lists no conversation on Home: no unread thread, no mention", () => {
    addThread(makeThread({ id: "thread-a", title: "Team sync", unreadCount: 2 }))
    addThread(makeThread({ id: "thread-c", title: "Roadmap", unreadCount: 1 }))
    attentionStore._setForTest({
      items: [makeMentionItem({ entityId: "thread-c" })],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("home-message-row-thread-a")).toBeNull()
    expect(screen.queryByTestId("attention-row-kernel-thread-thread-c")).toBeNull()
    expect(screen.queryByTestId("home-card-messages")).toBeNull()
  })

  // QA THR-09: a hidden reply (not also sent to the channel), and the seat
  // line an agent mention posts in the reply thread, belong to the reply
  // thread. Live, they raised a Home row "Bob: Bob added Personal agent" for
  // the channel, gone on reload.
  it("a hidden reply or a reply-thread system line arriving live adds no Home row for the channel", () => {
    addThread(makeThread({ id: "thread-hidden", title: "QA threads", unreadCount: 0 }))
    attentionStore._setForTest({ items: [], errors: [] })
    render(() => <Home entityId="home" />)
    for (const [id, authorType, content] of [
      ["m-reply", "user", "thread only"],
      ["m-seat", "system", "Bob added Personal agent"],
    ]) {
      handleMessageEvent("create", {
        id,
        threadId: "thread-hidden",
        content,
        authorId: "u-bob",
        authorName: "Bob",
        authorType,
        replyRootId: "root-1",
        alsoInChannel: false,
        createdAt: new Date().toISOString(),
      })
    }
    expect(screen.queryByTestId("home-message-row-thread-hidden")).toBeNull()
  })

  it("mail-app attention items stay in Mail: Home shows no Mail card (D21)", () => {
    attentionStore._setForTest({
      items: [
        makeOpenEntityItem({
          app: "mail",
          entity: "conversation",
          entityId: "conv-1",
          kind: "unassigned",
        }),
      ],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("home-card-mail")).toBeNull()
    expect(screen.queryByTestId("home-card-feed")).toBeNull()
  })

  it("shows the empty state, not a blank home-feed, when the only attention item is carded-but-unrenderable (thread outside the client's thread cap)", () => {
    // A thread_reply item is excluded from the grouped Activity ledger
    // (carded by the Messages card instead) -- but if its thread is absent
    // from the client's thread-store (outside the 50-thread cap, or before
    // hydration), the Messages card renders nothing for it either. `total()`
    // still counts this item, so a total()-based hasAnyContent gate rendered
    // a blank home-feed container under "NOTHING URGENT" instead of the
    // empty state.
    attentionStore._setForTest({
      items: [
        makeOpenEntityItem({
          app: "kernel",
          entity: "thread",
          entityId: "thread-outside-cap",
          kind: "thread_reply",
          urgency: 30,
        }),
      ],
      errors: [],
    })
    // Deliberately NOT added to the thread-store.
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-empty-state")).toBeTruthy()
    expect(screen.queryByTestId("home-feed")).toBeNull()
  })

  it("an access request is a row of the Approvals card, never an alert", () => {
    attentionStore._setForTest({
      items: [
        makeOpenEntityItem({
          app: "kernel",
          entity: "scope_request",
          kind: "scope_request",
          metadata: { requestedScopes: ["shopify:orders:read"], agentName: "Sales agent" },
        }),
      ],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    const card = screen.getByTestId("home-card-approvals")
    expect(card.querySelector('[data-testid="attention-row-kernel-scope_request-T1"]')).toBeTruthy()
    // Decided with Grant / Deny right on the row.
    expect(screen.getByTestId("attention-row-kernel-scope_request-T1-grant").textContent).toBe(
      "Grant",
    )
    expect(screen.queryByTestId("home-alerts-list")).toBeNull()
    expect(screen.queryByTestId("alert-cluster-kernel::scope_request")).toBeNull()
  })

  // --- Merged Alerts & messages card (2026-09-11) ---
  //
  // A support inbox breaching SLA emits one `sla_risk` item per ticket. Those
  // rendered as an uncapped strip ABOVE the cards, so 24 of them buried the
  // Approvals card and the operator never saw the decisions waiting on them.

  const slaAlerts = (n: number): AttentionItem[] =>
    Array.from({ length: n }, (_, i) =>
      makeOpenEntityItem({
        id: `att-sla-${i}`,
        app: "tickets",
        entity: "ticket",
        entityId: `t-${i}`,
        kind: "sla_risk",
        summary: `SLA approaching for ticket-${i}`,
        urgency: 80,
      }),
    )

  it("collapses identical alerts into one counted, expandable row", () => {
    attentionStore._setForTest({ items: slaAlerts(24), errors: [] })
    render(() => <Home entityId="home" />)

    // 24 items, ONE row.
    const cluster = screen.getByTestId("alert-cluster-tickets::sla_risk")
    expect(cluster).toBeTruthy()
    expect(cluster.textContent).toContain("24 tickets approaching SLA")
    // The individual rows are not rendered until asked for.
    expect(screen.queryByTestId("attention-row-tickets-ticket-t-0")).toBeNull()
    expect(screen.queryByTestId("alert-cluster-items-tickets::sla_risk")).toBeNull()

    // Nothing is hidden: expanding reveals every underlying alert.
    fireEvent.click(cluster.querySelector("button")!)
    expect(screen.getByTestId("alert-cluster-items-tickets::sla_risk")).toBeTruthy()
    expect(screen.getByTestId("attention-row-tickets-ticket-t-0")).toBeTruthy()
    expect(screen.getByTestId("attention-row-tickets-ticket-t-23")).toBeTruthy()
  })

  it("alerts render inside the Messages card, so Approvals is never pushed below them", () => {
    attentionStore._setForTest({
      items: [
        ...slaAlerts(24),
        makeApprovalItem({
          id: "att-appr",
          entityId: "a-1",
          summary: "Create Shopify draft order",
        }),
      ],
      errors: [],
    })
    render(() => <Home entityId="home" />)

    // The separate strip above the cards is gone — alerts live in the card.
    expect(screen.queryByTestId("home-urgent-strip")).toBeNull()
    const list = screen.getByTestId("home-alerts-list")
    expect(list.querySelector('[data-testid="alert-cluster-tickets::sla_risk"]')).toBeTruthy()
    // And 24 alerts cost ONE row, so the approval row still renders.
    expect(screen.getByTestId("attention-row-invoicing-document-a-1")).toBeTruthy()
  })

  it("caps the merged list with an internal scroll once it passes five rows", () => {
    // Six DISTINCT kinds: nothing clusters, so six real rows survive.
    const kinds = [
      "sla_risk",
      "system_alert",
      "task_overdue",
      "admin_action",
      "dm_window_closing",
      "approval_decision",
    ]
    attentionStore._setForTest({
      items: kinds.map((kind, i) =>
        makeOpenEntityItem({
          id: `att-${kind}`,
          app: `app-${i}`,
          entity: "thing",
          entityId: `e-${i}`,
          kind: kind as AttentionItem["kind"],
          urgency: 80,
        }),
      ),
      errors: [],
    })
    render(() => <Home entityId="home" />)
    const list = screen.getByTestId("home-alerts-list")
    expect(list.getAttribute("data-scrollable")).toBe("true")
    expect(list.style.overflowY).toBe("auto")
    expect(list.style.maxHeight).toBe("285px")
  })

  it("a loud alert stream never buries the approval queue", () => {
    // The whole point of the merged card (2026-09-11): everything that matters
    // stays on one normally sized screen. 24 alerts + approvals must both
    // render, the loud one bounded on its own.
    attentionStore._setForTest({
      items: [
        ...slaAlerts(24),
        makeApprovalItem({
          id: "att-appr",
          entityId: "a-1",
          summary: "Create Shopify draft order",
        }),
      ],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    const alerts = screen.getByTestId("home-alerts-list")
    expect(screen.getByTestId("attention-row-invoicing-document-a-1")).toBeTruthy()
    // 24 alerts cost ONE row, so they never need the scroll cap at all here.
    expect(alerts.querySelector('[data-testid="alert-cluster-tickets::sla_risk"]')).toBeTruthy()
    expect(alerts.getAttribute("data-scrollable")).toBeNull()
    // The card counts ITEMS, so 24 clustered alerts still read as 24.
    expect(screen.getByTestId("home-card-count-messages").textContent).toContain("24")
  })

  it("caps a section even when it renders few rows — expanding a cluster must not escape it", () => {
    // The hole a gestalt walk of this fix found: three rows is under any
    // threshold, but one was a cluster of 24, and expanding it grew the section
    // to 27 rows and pushed unread messages back off the page. The cap is
    // therefore unconditional: content that grows after render cannot escape it.
    attentionStore._setForTest({ items: slaAlerts(24), errors: [] })
    render(() => <Home entityId="home" />)
    const list = screen.getByTestId("home-alerts-list")
    // One cluster row only, so the first-render overflow flag is correctly absent...
    expect(list.getAttribute("data-scrollable")).toBeNull()
    // ...but the bound is on regardless.
    expect(list.style.maxHeight).toBe("285px")
    expect(list.style.overflowY).toBe("auto")

    // Expand the 24 alerts: the section holds 25 rows now and is still bounded.
    fireEvent.click(screen.getByTestId("alert-cluster-tickets::sla_risk").querySelector("button")!)
    expect(screen.getByTestId("attention-row-tickets-ticket-t-23")).toBeTruthy()
    expect(list.style.maxHeight).toBe("285px")
    expect(list.style.overflowY).toBe("auto")
  })
})

describe("home.lands-on-the-attention-feed", () => {
  beforeEach(() => {
    // Conversations are not Home content any more (D21): the feed needs an item.
    attentionStore._setForTest({
      items: [makeApprovalItem({ id: "att-landing", entityId: "a-landing" })],
      errors: [],
    })
    addThread(makeThread({ id: "c-1", title: "General", discoverable: true }))
    addThread(
      makeThread({
        id: "d-1",
        title: null,
        discoverable: false,
        participants: [{ id: "u-quinn", name: "Quinn Dupont", avatarUrl: null }],
      }),
    )
  })

  it("Home mounts the attention feed as its landing view", () => {
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home")).toBeTruthy()
    expect(screen.getByTestId("home-greeting")).toBeTruthy()
    expect(screen.getByTestId("home-feed")).toBeTruthy()
  })

  it("the landing is not a conversation list, and holds no second copy of the feed", () => {
    render(() => <Home entityId="home" />)
    // The Channels / Direct messages grouping belongs to the Home SIDEBAR.
    expect(screen.queryByTestId("home-threads-landing")).toBeNull()
    expect(screen.queryByTestId("home-landing-row-c-1")).toBeNull()
    // No side pane placement survives: exactly one feed on the surface.
    expect(screen.queryByTestId("attention-side-pane")).toBeNull()
    expect(screen.queryByTestId("attention-pane-toggle")).toBeNull()
    expect(screen.getAllByTestId("home-feed")).toHaveLength(1)
  })

  it("a deep link to the feed lands on the same single feed", () => {
    render(() => <Home entityId="feed" />)
    expect(screen.getAllByTestId("home-feed")).toHaveLength(1)
    expect(screen.queryByTestId("attention-side-pane")).toBeNull()
  })
})

describe("home and a computer chat's permission request", () => {
  // The decision is chat business: Allow / Deny is drawn in its conversation
  // (ThreadNodePermissions). Home only says the agent needs you.
  it("shows the request as a notification that the agent needs you, without Allow / Deny", () => {
    const inTenMinutes = new Date(Date.now() + 10 * 60_000 - 5_000).toISOString()
    attentionStore._setForTest({
      items: [
        makeOpenEntityItem({
          id: "att-routine-failed",
          app: "kernel",
          entity: "agent_notification",
          entityId: "n-1",
          kind: "agent_notification",
          summary: "Routine Bug Fixer run failed",
          urgency: 80,
        }),
        makeOpenEntityItem({
          id: "att-node-prompt",
          app: "kernel",
          entity: "agent_notification",
          entityId: "n-2",
          kind: "agent_notification",
          summary: "Data on Minimac asks to use Bash",
          urgency: 80,
          metadata: {
            nodePermissionPromptId: "prompt-1",
            nodePermission: {
              promptId: "prompt-1",
              jobId: "job-1",
              nodeName: "Minimac",
              agentName: "Data",
              toolName: "Bash",
              summary: "ls",
              expiresAt: inTenMinutes,
            },
          },
        }),
      ],
      errors: [],
    })
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId("node-permission-card")).toBeNull()
    expect(screen.queryByTestId("node-permission-allow")).toBeNull()
    expect(screen.getByText("Data needs your OK in the chat")).toBeInTheDocument()
  })
})

describe("home decisions", () => {
  beforeEach(async () => {
    const { DecisionQueueTestAccess } = await import("~/modules/approvals/decision-queue")
    DecisionQueueTestAccess.reset()
  })
  const approval = (id: string, metadata: Record<string, unknown> = {}): AttentionItem => ({
    id: `kernel:approval_pending:${id}`,
    app: "kernel",
    entity: "approval_request",
    entityId: id,
    kind: "approval_pending",
    summary: "Refund Café Ombre, €178.80",
    urgency: 60,
    occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
    action: { type: "decide_approval", approvalId: id },
    metadata: {
      toolName: "invoicing:refund",
      actionLabel: "Invoicing: refund",
      ref: "F-2026-0391",
      requestHandle: "request-7",
      requesterName: "Inès Caron's agent",
      summaryLines: ["Charged on 14 Oct, two days after they cancelled."],
      expiresInSeconds: 5 * 86_400,
      ...metadata,
    },
  })
  const attention = (id: string, over: Partial<AttentionItem> = {}): AttentionItem => ({
    id,
    app: "kernel",
    entity: "notification",
    entityId: `n-${id}`,
    kind: "system_alert",
    summary: "Marc Sauvan asked for group pricing for 11 sites",
    urgency: 90,
    occurredAt: "2026-05-06T12:00:00.000Z",
    action: { type: "open_entity", tabType: "kernel:notification", entityId: `n-${id}` },
    persisted: true,
    ...over,
  })
  const row = (item: AttentionItem) => `attention-row-${item.app}-${item.entity}-${item.entityId}`

  it("approval and attention rows", () => {
    const a = approval("ap-1")
    const n = attention("ev-1")
    attentionStore._setForTest({ items: [a, n], errors: [] })
    render(() => <Home entityId="home" />)
    const id = row(a)
    expect(screen.getByTestId(`${id}-action-chip`).textContent).toBe("Invoicing: refund")
    expect(screen.getByTestId(`${id}-record-ref`).textContent).toBe("F-2026-0391")
    expect(screen.getByTestId(id).textContent).toContain("Refund Café Ombre")
    expect(screen.getByTestId(`${id}-lines`).textContent).toContain("Charged on 14 Oct")
    expect(screen.getByTestId(`${id}-requester`).textContent).toContain("Inès Caron's agent")
    expect(screen.getByTestId(`${id}-metric`).textContent).not.toBe("")
    expect(screen.getByTestId(`${id}-approve`)).toBeTruthy()
    expect(screen.getByTestId(`${id}-reject`)).toBeTruthy()
    // Details expands the request in place, on Home.
    fireEvent.click(screen.getByTestId(`${id}-details`))
    expect(screen.getByTestId(`${id}-expanded`)).toBeTruthy()
    // An attention row: Ask agent to draft, and Not now; no decision buttons.
    const nid = row(n)
    expect(screen.getByTestId(`${nid}-ask-draft`)).toBeTruthy()
    expect(screen.getByTestId(`${nid}-not-now`)).toBeTruthy()
    expect(screen.queryByTestId(`${nid}-approve`)).toBeNull()
  })

  it("Approve removes at once, done line, Undo, count updates", async () => {
    const { decisionToastItems, undoDecision, DecisionQueueTestAccess } = await import(
      "~/modules/approvals/decision-queue"
    )
    DecisionQueueTestAccess.reset()
    const items = [approval("ap-1"), approval("ap-2")]
    attentionStore._setForTest({ items, errors: [] })
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId("home-card-count-approvals").textContent).toBe("2")
    fireEvent.click(screen.getByTestId(`${row(items[0]!)}-approve`))
    // The row leaves at once, the count follows, and nothing is sent yet.
    expect(screen.queryByTestId(row(items[0]!))).toBeNull()
    expect(screen.getByTestId("home-card-count-approvals").textContent).toBe("1")
    expect(apiPost).not.toHaveBeenCalledWith(
      "/approvals/ap-1/decide",
      expect.anything(),
      expect.anything(),
    )
    // The done line: the decision toast names it and offers Undo for its window.
    expect(decisionToastItems()).toEqual([
      expect.objectContaining({
        id: "ap-1",
        decision: "approve",
        phase: "queued",
        windowMs: 8_000,
      }),
    ])
    expect(undoDecision("approval", "ap-1")).toBe(true)
    expect(await screen.findByTestId(row(items[0]!))).toBeTruthy()
    expect(screen.getByTestId("home-card-count-approvals").textContent).toBe("2")
    DecisionQueueTestAccess.reset()
  })

  it("fixture pill Billing: payment reminder", () => {
    const a = approval("ap-1", {
      toolName: "mail:compose",
      actionLabel: "Mail: compose",
      pill: { label: "Billing: payment reminder" },
    })
    const plain = approval("ap-2", { toolName: "mail:compose", actionLabel: "Mail: compose" })
    attentionStore._setForTest({ items: [a, plain], errors: [] })
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId(`${row(a)}-action-chip`).textContent).toBe(
      "Billing: payment reminder",
    )
    expect(screen.getByTestId(`${row(plain)}-action-chip`).textContent).toBe("Mail: compose")
  })

  it("a mail draft's row says what the send check says", () => {
    const a = approval("ap-1", {
      toolName: "mail:compose",
      actionLabel: "Mail: compose",
      sendGuard: { state: "clear" },
    })
    attentionStore._setForTest({ items: [a], errors: [] })
    render(() => <Home entityId="home" />)
    expect(screen.getByTestId(`${row(a)}-guard`).textContent).toBe(
      "Will not go out if they reply first, even after you approve.",
    )
  })

  it("stopped shows reason, Dismiss only, uncounted", () => {
    const notice = attention("ev-stop", {
      app: "mail",
      entity: "conversation",
      entityId: "c-1",
      // As the event provider hands an app event's kind over.
      kind: "mail:send_guard.stopped" as AttentionItem["kind"],
      summary: "Marc replied 2 hours ago, so this did not go out",
      urgency: 50,
      action: { type: "open_entity", tabType: "mail:conversation", entityId: "c-1" },
    })
    const stoppedDraft = approval("ap-stop", {
      toolName: "mail:compose",
      actionLabel: "Mail: compose",
      sendGuard: { state: "replied", who: "Marc Sauvan", quote: "Thanks" },
      uncounted: true,
    })
    attentionStore._setForTest({ items: [notice, stoppedDraft], errors: [] })
    render(() => <Home entityId="home" />)
    const list = screen.getByTestId("home-stopped-list")
    expect(list.textContent).toContain("Marc replied 2 hours ago")
    expect(screen.getByTestId(`${row(stoppedDraft)}-guard`).textContent).toContain(
      "Marc Sauvan replied",
    )
    for (const item of [notice, stoppedDraft]) {
      const id = row(item)
      expect(screen.getByTestId(`${id}-dismiss`)).toBeTruthy()
      expect(screen.queryByTestId(`${id}-approve`)).toBeNull()
      expect(screen.queryByTestId(`${id}-not-now`)).toBeNull()
      expect(screen.queryByTestId(`${id}-ask-draft`)).toBeNull()
      expect(screen.queryByTestId(`${id}-mark-read`)).toBeNull()
    }
    // Neither is counted: no approvals card, and the status says nothing needs you.
    expect(screen.queryByTestId("home-card-approvals")).toBeNull()
    expect(screen.getByTestId("home-status").textContent).not.toMatch(/\d+\s*NEED/)
  })

  it("a computed row has no Not now", () => {
    const computed = attention("c-1", { persisted: undefined, kind: "sla_risk", summary: "SLA" })
    const persisted = attention("p-1")
    attentionStore._setForTest({ items: [computed, persisted], errors: [] })
    render(() => <Home entityId="home" />)
    expect(screen.queryByTestId(`${row(computed)}-not-now`)).toBeNull()
    expect(screen.getByTestId(`${row(persisted)}-not-now`)).toBeTruthy()
  })

  describe("who a row is for", () => {
    const person = (why: "asked" | "on_item" | "manager", extra: Record<string, unknown> = {}) => ({
      to: "person",
      userId: "u-elodie",
      why,
      awayUntil: null,
      standIn: null,
      blockedStandIn: null,
      ...extra,
    })
    const routed = (id: string, placement: string, route: unknown, names = {}) =>
      approval(id, {
        placement,
        route,
        routeLine: { forName: "Élodie Renard", ...names },
        ...(placement === "others" ? { peerSelfApprovable: true } : {}),
      })

    it("no pill row above the list", () => {
      attentionStore._setForTest({
        items: [
          approval("a-1"),
          approval("a-2", { toolName: "tickets:reply", actionLabel: "Tickets: reply" }),
          approval("a-3", { toolName: "mail:send", actionLabel: "Mail: send" }),
        ],
        errors: [],
      })
      render(() => <Home entityId="home" />)
      expect(screen.queryByTestId("approval-facet-bar")).toBeNull()
      expect(screen.queryByTestId("home-approval-peer-toggle")).toBeNull()
      expect(screen.getByTestId("home-card-approvals").querySelectorAll("[role=tab]").length).toBe(
        0,
      )
    })

    it("one why line on every routed row, each table line", () => {
      const rows = [
        routed("w-on", "mine", { ...person("on_item"), userId: "u-1" }),
        routed("w-ask", "mine", { ...person("asked"), userId: "u-1" }),
        routed(
          "w-stand",
          "standing_in",
          person("on_item", { awayUntil: "2026-12-20", standIn: "u-1" }),
        ),
        routed(
          "w-block",
          "mine",
          person("on_item", { blockedStandIn: "u-tom", awayUntil: "2026-12-20" }),
          { blockedName: "Tom Reyes" },
        ),
        routed("w-oth", "others", person("on_item")),
        routed("w-usual", "mine", { to: "usual" }),
        routed("w-owner", "mine", { to: "owner", userId: "u-1" }),
      ]
      attentionStore._setForTest({ items: rows, errors: [] })
      render(() => <Home entityId="home" />)
      const why = (item: AttentionItem) => screen.queryByTestId(`${row(item)}-why`)?.textContent
      // Six of the viewer's own rows fold to three: unfold to read them all.
      fireEvent.click(screen.getByTestId("home-approvals-fold"))
      expect(why(rows[0]!)).toBe("For you: assigned to you")
      expect(why(rows[1]!)).toBe("You asked for this")
      expect(why(rows[2]!)).toMatch(
        /^For Élodie Renard, away until (20 Dec|Dec 20)\. You are next in line\.$/,
      )
      expect(why(rows[3]!)).toBe(
        "For you: Tom Reyes cannot approve this while Élodie Renard is away",
      )
      // A row for others sits in the closed group; open it to read its line.
      fireEvent.click(screen.getByTestId("home-approvals-others-summary"))
      expect(why(rows[4]!)).toBe("For Élodie Renard, assigned to them. You can also approve")
      // The usual deciders and an owner-routed row: no route line.
      expect(why(rows[5]!)).toBeUndefined()
      expect(why(rows[6]!)).toBeUndefined()
    })

    it("the group closed with its count", () => {
      const others = [
        routed("o-1", "others", person("on_item")),
        routed("o-2", "others", person("asked")),
      ]
      attentionStore._setForTest({ items: [approval("m-1"), ...others], errors: [] })
      render(() => <Home entityId="home" />)
      const group = screen.getByTestId("home-approvals-others") as HTMLDetailsElement
      expect(group.open).toBe(false)
      expect(screen.getByTestId("home-approvals-others-summary").textContent).toContain(
        "For others, you can also approve",
      )
      expect(screen.getByTestId("home-approvals-others-count").textContent).toBe("2")
      // The card counts the viewer's own row only.
      expect(screen.getByTestId("home-card-approvals").textContent).toContain("1")
    })

    it("the peer toggle gone with its rows in the group as asked", () => {
      const peer = routed("p-1", "others", person("asked", { userId: "u-tom" }), {
        forName: "Tom Reyes",
      })
      attentionStore._setForTest({ items: [peer], errors: [] })
      render(() => <Home entityId="home" />)
      expect(screen.queryByTestId("home-approval-peer-toggle")).toBeNull()
      fireEvent.click(screen.getByTestId("home-approvals-others-summary"))
      expect(screen.getByTestId(`${row(peer)}-why`).textContent).toBe(
        "For Tom Reyes, who asked for this. You can also approve",
      )
    })

    it("a passed-on row has no Not now", () => {
      const passed = attention("pass-1", {
        kind: "task_overdue",
        summary: "Élodie's task is overdue",
        metadata: { forUserId: "u-elodie" },
      })
      const own = attention("own-1", { kind: "sla_risk", summary: "Your ticket is at risk" })
      attentionStore._setForTest({ items: [passed, own], errors: [] })
      render(() => <Home entityId="home" />)
      expect(screen.queryByTestId(`${row(passed)}-not-now`)).toBeNull()
      expect(screen.getByTestId(`${row(own)}-not-now`)).toBeTruthy()
    })

    it("a fixture provider returning a computed row with Not now fails", () => {
      // A provider that marks a stand-in's computed row as persisted still gets no Not now.
      const wrong = attention("comp-1", {
        persisted: true,
        kind: "task_overdue",
        metadata: { forUserId: "u-elodie" },
      })
      attentionStore._setForTest({ items: [wrong], errors: [] })
      render(() => <Home entityId="home" />)
      expect(screen.getByTestId(row(wrong))).toBeTruthy()
      expect(screen.queryByTestId(`${row(wrong)}-not-now`)).toBeNull()
    })

    it("While you were away lists at most 3 lines, and N more, with Dismiss", async () => {
      const recap = attention("kernel:away_recap:r-1", {
        entity: "away_range",
        entityId: "r-1",
        kind: "kernel:away.recap" as AttentionItem["kind"],
        summary: "While you were away",
        urgency: 30,
        persisted: undefined,
        action: { type: "open_entity", tabType: "kernel:approvals", entityId: "approvals" },
        metadata: {
          awayRecap: {
            lines: [1, 2, 3].map((n) => ({
              approvalId: `ap-${n}`,
              title: `Refund ${n}`,
              outcome: "approved",
              decidedByName: "Tom Reyes",
            })),
            more: 2,
          },
        },
      })
      attentionStore._setForTest({ items: [recap], errors: [] })
      render(() => <Home entityId="home" />)
      const id = row(recap)
      expect(screen.getAllByTestId(`${id}-recap-line`)).toHaveLength(3)
      expect(screen.getAllByTestId(`${id}-recap-line`)[0]?.textContent).toBe(
        "Refund 1: approved by Tom Reyes",
      )
      expect(screen.getByTestId(`${id}-recap-more`).textContent).toBe("and 2 more")
      expect(screen.getByTestId(id).textContent).toContain("While you were away")
      expect(screen.queryByTestId(`${id}-ask-draft`)).toBeNull()
      expect(screen.queryByTestId(`${id}-not-now`)).toBeNull()
      fireEvent.click(screen.getByTestId(`${id}-dismiss`))
      expect(apiPost).toHaveBeenCalledWith("/attention-items/away-recap/dismiss", {
        rangeId: "r-1",
      })
      await vi.waitFor(() => expect(screen.queryByTestId(id)).toBeNull())
    })
  })

  it("Not now sets the event aside and the row leaves", async () => {
    const persisted = attention("p-1")
    attentionStore._setForTest({ items: [persisted], errors: [] })
    render(() => <Home entityId="home" />)
    fireEvent.click(screen.getByTestId(`${row(persisted)}-not-now`))
    expect(apiPost).toHaveBeenCalledWith("/attention-items/set-aside", { eventId: "p-1" })
    await vi.waitFor(() => expect(screen.queryByTestId(row(persisted))).toBeNull())
  })

  it("failed source names itself with Retry and the rest shows", () => {
    attentionStore._setForTest({
      items: [approval("ap-1")],
      errors: [{ app: "billing", reason: "timeout", message: "timed out" }],
    })
    render(() => <Home entityId="home" />)
    const card = screen.getByTestId("home-source-failed-billing")
    expect(card.textContent).toContain("Could not load what Billing has for you")
    expect(card.textContent).toContain("Anything waiting there is safe and still waiting.")
    expect(screen.getByTestId(row(approval("ap-1")))).toBeTruthy()
    apiGetEnvelope.mockClear()
    fireEvent.click(screen.getByTestId("home-source-failed-billing-retry"))
    expect(apiGetEnvelope).toHaveBeenCalledWith("/attention-items")
  })

  it("brief with a time", async () => {
    apiGet.mockImplementation(async (path: string) =>
      path === "/home/brief"
        ? {
            routineId: "r-1",
            routineName: "Morning brief",
            message: {
              id: "m-1",
              threadId: "t-1",
              text: "Monthly recurring revenue is €84,708.",
              at: "2026-11-09T06:30:00.000Z",
            },
          }
        : [],
    )
    render(() => <Home entityId="home" />)
    expect((await screen.findByTestId("home-brief-text")).textContent).toContain(
      "Monthly recurring revenue",
    )
    expect(screen.getByTestId("home-brief-time").textContent).toMatch(/\d{1,2}:\d{2}/)
  })

  it("No brief set up with Set up", async () => {
    apiGet.mockImplementation(async (path: string) => (path === "/home/brief" ? null : []))
    render(() => <Home entityId="home" />)
    expect((await screen.findByTestId("home-brief-none")).textContent).toContain("No brief set up")
    expect(screen.getByTestId("home-brief-setup").textContent).toBe("Set up a morning brief")
  })
})
