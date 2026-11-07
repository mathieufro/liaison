// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Reactive ticket store mock — Solid memos only re-run when reading a reactive
// proxy, so the mocked ticketDetailStore is a real createStore. It is created
// inside the vi.mock factory below with the SAME solid-js/store instance the
// component imports: a `require()` here loads a second Solid instance whose
// proxies never register with the component's reactive context, silently
// killing store→UI updates (async seeds then never render).
type TicketStoreShape = {
  byId: Record<string, any>
  loadFailedById: Record<string, "not_found" | "error">
}

const reactive = vi.hoisted(
  () =>
    ({}) as {
      store: TicketStoreShape
      setStore: import("solid-js/store").SetStoreFunction<TicketStoreShape>
      reconcile: typeof import("solid-js/store").reconcile
    },
)

const state = vi.hoisted(() => ({
  api: { post: vi.fn(), getEnvelope: vi.fn() } as any,
  loadTicket: vi.fn(),
  loadMessages: vi.fn(),
  markRead: vi.fn(),
  setStatus: vi.fn(),
  setPriority: vi.fn(),
  setCategory: vi.fn(),
  reopenTicket: vi.fn(),
  assignTicket: vi.fn(),
  setTicketFollowup: vi.fn(),
  clearTicketFollowup: vi.fn(),
  loadCategories: vi.fn(),
  openTab: vi.fn(),
  activeTabId: "tickets:ticket:t1",
}))

const CATEGORIES = vi.hoisted(() => [
  { id: "cat-root", parentId: null, name: "Billing", sortOrder: 0, archivedAt: null },
  { id: "cat-child", parentId: "cat-root", name: "Refunds", sortOrder: 0, archivedAt: null },
  { id: "cat-other", parentId: null, name: "Shipping", sortOrder: 1, archivedAt: null },
])

const TICKET = {
  id: "t1",
  handle: "ticket-1",
  subject: "Important",
  status: "open",
  priority: "high",
  slaDeadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  sensitivity: "internal",
  readByCount: 2,
  readByRecent: [
    { userId: "u1", name: "Alice", readAt: "2026-01-01T00:00:00Z" },
    { userId: "u2", name: "Bob", readAt: "2026-01-01T00:00:01Z" },
  ],
}

state.loadTicket.mockImplementation(async () => {
  // Clone: setStore MERGES objects, so inserting the shared constant would let
  // later per-test seeds mutate TICKET itself and leak state across tests.
  reactive.setStore("byId", "t1", { ...TICKET })
})

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/shell/tab-store", () => ({
  makeTabId: (type: string, entityId: string) => `${type}:${entityId}`,
  openTab: state.openTab,
  tabStore: {
    get activeTabId() {
      return state.activeTabId
    },
  },
}))
vi.mock("~/modules/tickets/ticket-detail-store", async () => {
  const { createStore, reconcile } = await import("solid-js/store")
  const [store, setStore] = createStore<TicketStoreShape>({ byId: {}, loadFailedById: {} })
  reactive.store = store
  reactive.setStore = setStore
  reactive.reconcile = reconcile
  return {
    loadTicket: state.loadTicket,
    markRead: state.markRead,
    reopenTicket: state.reopenTicket,
    setStatus: state.setStatus,
    setPriority: state.setPriority,
    setCategory: state.setCategory,
    assignTicket: state.assignTicket,
    setTicketFollowup: state.setTicketFollowup,
    clearTicketFollowup: state.clearTicketFollowup,
    ticketDetailStore: store,
  }
})
vi.mock("~/modules/tickets/ticket-message-store", () => ({
  latestInboundCc: () => [],
  loadMessages: state.loadMessages,
}))
vi.mock("~/modules/tickets/ticket-category-store", () => ({
  loadCategories: state.loadCategories,
  ticketCategoryStore: { categories: CATEGORIES, loaded: true, loading: false },
}))
vi.mock("~/modules/tickets/TicketComposer", () => ({
  TicketComposer: () => <div data-testid="tickets-composer-mock" />,
  canReplyOnTickets: () => true,
  canNoteOnTickets: () => true,
}))
vi.mock("~/modules/tickets/TicketConversationStream", () => ({
  TicketConversationStream: (props: any) => (
    <div data-testid="tickets-stream-mock" data-approval-thread-id={props.approvalThreadId ?? ""} />
  ),
}))
vi.mock("~/modules/tickets/TicketSummaryCard", () => ({
  TicketSummaryCard: () => <div data-testid="tickets-summary-mock" />,
}))

const mentionState = vi.hoisted(() => ({ searchMentions: vi.fn() }))
vi.mock("~/lib/mention-service", () => ({
  searchMentions: mentionState.searchMentions,
}))

// Flatten PopupMenu for unit tests: render the trigger and the content
// inline (no portal, no Kobalte focus traps) so fireEvent.click works.
// Root reports itself open on mount so lazy on-open loads (assign member
// fetch) run without a real Kobalte trigger interaction.
vi.mock("~/ui/PopupMenu", () => {
  const Root = (props: any) => {
    props.onOpenChange?.(true)
    return <>{props.children}</>
  }
  const Trigger = (props: any) => <>{props.children}</>
  const Content = (props: any) => <div role="menu">{props.children}</div>
  const Group = (props: any) => <>{props.children}</>
  const Item = (props: any) => (
    <div
      role="menuitem"
      tabindex="0"
      onClick={() => props.onSelect?.()}
      onKeyDown={(e: any) => {
        if (e.key === "Enter" || e.key === " ") props.onSelect?.()
      }}
    >
      {props.children}
    </div>
  )
  const Label = (props: any) => <div>{props.children}</div>
  const Separator = () => <hr />
  const PopupMenu = Object.assign(Root, { Trigger, Content, Group, Item, Label, Separator })
  return { PopupMenu }
})

import { TicketDetail } from "./TicketDetail"

describe("TicketDetail", () => {
  beforeEach(() => {
    // reconcile, not a bare {}: setStore merges objects, so setting {} leaves
    // the previous test's t1 entry in place and per-test seeds merge into it.
    reactive.setStore("byId", reactive.reconcile({}))
    state.loadTicket.mockReset()
    // Re-arm the default seed implementation (a test may have overridden it,
    // e.g. the parallel-kickoff test's never-resolving loadTicket).
    state.loadTicket.mockImplementation(async () => {
      reactive.setStore("byId", "t1", { ...TICKET })
    })
    state.loadMessages.mockReset()
    state.markRead.mockClear()
    state.setStatus.mockClear()
    state.setPriority.mockClear()
    state.setCategory.mockClear()
    state.setCategory.mockResolvedValue(undefined)
    state.reopenTicket.mockClear()
    state.assignTicket.mockClear()
    mentionState.searchMentions.mockReset()
    mentionState.searchMentions.mockResolvedValue([])
    state.setTicketFollowup.mockClear()
    state.clearTicketFollowup.mockClear()
    state.loadCategories.mockClear()
    state.openTab.mockClear()
    state.activeTabId = "tickets:ticket:t1"
    state.api.getEnvelope = vi.fn().mockResolvedValue({ data: [] })
  })

  it("loads ticket and marks read on mount", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(state.loadTicket).toHaveBeenCalledWith(state.api, "t1"))
    await waitFor(() => expect(state.markRead).toHaveBeenCalledWith(state.api, "t1"))
  })

  it("kicks off the conversation load in PARALLEL, before loadTicket resolves", async () => {
    // loadTicket never resolves in this test — the messages fetch must fire
    // anyway (it only needs the ticket id, not the loaded ticket).
    state.loadTicket.mockImplementation(() => new Promise(() => {}))
    render(() => <TicketDetail entityId="t1" />)
    expect(state.loadMessages).toHaveBeenCalledWith(state.api, "t1")
    expect(state.loadTicket).toHaveBeenCalledWith(state.api, "t1")
  })

  it("does not mark read while this keep-alive ticket tab is inactive", async () => {
    state.activeTabId = "tickets:ticket:other"
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(state.loadTicket).toHaveBeenCalledWith(state.api, "t1"))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(state.markRead).not.toHaveBeenCalled()
    fireEvent.focus(window)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(state.markRead).not.toHaveBeenCalled()
  })

  it("[SC5] renders header subject + read-by-N pill once ticket is loaded", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-subject")).toBeTruthy())
    expect(screen.getByTestId("tickets-detail-subject").textContent).toBe("Important")
    // Read-by list lives inside the popup content, which the test mock flattens.
    expect(screen.getByTestId("tickets-readby-list")).toBeTruthy()
    expect(screen.getByTestId("tickets-readby-item-u1")).toBeTruthy()
    expect(screen.getByTestId("tickets-readby-item-u2")).toBeTruthy()
  })

  it("picking a status from the popup calls setStatus", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-status")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-detail-status"))
    await waitFor(() =>
      expect(screen.getByTestId("tickets-status-option-awaiting_customer")).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId("tickets-status-option-awaiting_customer"))
    expect(state.setStatus).toHaveBeenCalledWith(state.api, "t1", "awaiting_customer")
  })

  it("does not expose closed as a direct setStatus option", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-status")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-detail-status"))
    expect(screen.queryByTestId("tickets-status-option-closed")).toBeNull()
  })

  it("offers Close in the status dropdown (opens the reason dialog, not a raw status set)", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-status")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-detail-status"))
    // Present as a close action, but never as a direct `closed` status option —
    // closing must go through the close-with-reason dialog.
    expect(screen.getByTestId("tickets-status-close")).toBeTruthy()
    expect(screen.queryByTestId("tickets-status-option-closed")).toBeNull()
    expect(state.setStatus).not.toHaveBeenCalled()
  })

  it("picking a priority from the popup calls setPriority", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-priority")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-detail-priority"))
    await waitFor(() => expect(screen.getByTestId("tickets-priority-option-urgent")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-priority-option-urgent"))
    expect(state.setPriority).toHaveBeenCalledWith(state.api, "t1", "urgent")
  })

  it("opens the registered contact detail tab from the contact pill", async () => {
    reactive.setStore("byId", "t1", { ...TICKET, contactId: "contact-1" })
    state.loadTicket.mockResolvedValueOnce(undefined)
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-contact-chip")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-detail-contact-chip"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "contacts:contact-detail", entityId: "contact-1" }),
    )
  })

  it("shows the contact name (not the generic label) when the contact is resolved", async () => {
    reactive.setStore("byId", "t1", {
      ...TICKET,
      contactId: "contact-1",
      contact: { id: "contact-1", name: "Hans Weber", email: "hans@example.com" },
    })
    state.loadTicket.mockResolvedValueOnce(undefined)
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-contact-chip")).toBeTruthy())
    expect(screen.getByTestId("tickets-detail-contact-chip").textContent).toContain("Hans Weber")
  })

  it("self-assigns from the assign chip menu", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-assign-empty")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-detail-assign-me"))
    // No auth token in the unit-test env, so the self-assign falls back to the
    // "me" sentinel with no optimistic display name.
    expect(state.assignTicket).toHaveBeenCalledWith(state.api, "t1", "me", null)
  })

  // The assignee menu reads the member directory, never the people search.
  function routeMembers(
    members:
      | { id: string; name: string; email: string; away?: { until: string | null } | null }[]
      | Error,
    total?: number,
  ) {
    const membersCalls: string[] = []
    state.api.getEnvelope = vi.fn(async (path: string) => {
      if (path.startsWith("/mentions/members")) {
        membersCalls.push(path)
        if (members instanceof Error) throw members
        return { data: members, meta: { total: total ?? members.length } }
      }
      return { data: [] }
    })
    return membersCalls
  }

  it("lists org members in the assign menu and assigns with the display name", async () => {
    routeMembers([
      { id: "u-morgan", name: "Morgan Lee", email: "morgan@x.test" },
      { id: "u-alice", name: "Alice Chen", email: "alice@x.test" },
    ])
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-assign-empty")).toBeTruthy())
    await waitFor(() =>
      expect(screen.getAllByTestId("tickets-detail-assign-member").length).toBe(2),
    )
    const morgan = screen
      .getAllByTestId("tickets-detail-assign-member")
      .find((el) => el.textContent?.includes("Morgan Lee"))!
    fireEvent.click(morgan.closest("[role=menuitem]")!)
    expect(state.assignTicket).toHaveBeenCalledWith(state.api, "t1", "u-morgan", "Morgan Lee")
  })

  it("shows away until a date beside a teammate who is away; the list is unchanged", async () => {
    routeMembers([
      { id: "u-morgan", name: "Morgan Lee", email: "morgan@x.test", away: { until: "2099-12-20" } },
      { id: "u-alice", name: "Alice Chen", email: "alice@x.test", away: null },
    ])
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() =>
      expect(screen.getAllByTestId("tickets-detail-assign-member").length).toBe(2),
    )
    expect(screen.getByTestId("tickets-detail-assign-away-u-morgan").textContent).toMatch(
      /away until (20 Dec|Dec 20)/,
    )
    expect(screen.queryByTestId("tickets-detail-assign-away-u-alice")).toBeNull()
  })

  it("offers teammates while the people search is unavailable (only 'Assign to me' was left)", async () => {
    // The people search answers 503 while the index is not ready; the menu
    // used to swallow that and show nothing but "Assign to me".
    mentionState.searchMentions.mockRejectedValue(new Error("Mention search unavailable"))
    routeMembers([
      { id: "u-morgan", name: "Morgan Lee", email: "morgan@x.test" },
      { id: "u-alice", name: "Alice Chen", email: "alice@x.test" },
      { id: "u-sam", name: "Sam Roy", email: "sam@x.test" },
    ])
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() =>
      expect(screen.getAllByTestId("tickets-detail-assign-member").length).toBe(3),
    )
    expect(screen.getByTestId("tickets-detail-assign-me")).toBeTruthy()
  })

  it("shows an error with a retry when teammates cannot be loaded", async () => {
    routeMembers(new Error("boom"))
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-assignee-error")).toBeTruthy())
    expect(screen.queryAllByTestId("tickets-detail-assign-member")).toHaveLength(0)
    routeMembers([{ id: "u-sam", name: "Sam Roy", email: "sam@x.test" }])
    fireEvent.click(screen.getByTestId("tickets-assignee-retry"))
    await waitFor(() =>
      expect(screen.getAllByTestId("tickets-detail-assign-member").length).toBe(1),
    )
    expect(screen.queryByTestId("tickets-assignee-error")).toBeNull()
  })

  it("searches teammates by name past the first page", async () => {
    const calls = routeMembers(
      Array.from({ length: 50 }, (_, i) => ({
        id: `u-${i}`,
        name: `Member ${i}`,
        email: `m${i}@x.test`,
      })),
      64,
    )
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() =>
      expect(screen.getAllByTestId("tickets-detail-assign-member").length).toBe(50),
    )
    expect(screen.getByTestId("tickets-assignee-more").textContent).toContain("14")
    routeMembers([{ id: "u-63", name: "Member 63", email: "m63@x.test" }])
    fireEvent.input(screen.getByTestId("tickets-assignee-search"), {
      target: { value: "Member 63" },
    })
    await waitFor(() =>
      expect(screen.getAllByTestId("tickets-detail-assign-member").length).toBe(1),
    )
    expect(calls[0]).toContain("limit=50")
    expect((state.api.getEnvelope as any).mock.calls.at(-1)[0]).toContain("q=Member+63")
  })

  it("schedules a follow-up from the follow-up chip menu", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-followup-empty")).toBeTruthy())
    fireEvent.click(screen.getByText("Tomorrow"))
    expect(state.setTicketFollowup).toHaveBeenCalledWith(
      state.api,
      "t1",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    )
  })

  it("exposes nudge, convert-to-mail and close inside the more-actions menu", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-kebab")).toBeTruthy())
    expect(screen.getByTestId("tickets-detail-nudge-button")).toBeTruthy()
    expect(screen.getByTestId("tickets-detail-convert-mail-button")).toBeTruthy()
    expect(screen.getByTestId("tickets-detail-close-button")).toBeTruthy()
  })

  it("[SC9] renders only a footer reopen CTA for resolved closed tickets", async () => {
    reactive.setStore("byId", "t1", { ...TICKET, status: "closed", closedReason: "resolved" })
    state.loadTicket.mockResolvedValueOnce(undefined)
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-footer-reopen")).toBeTruthy())
    expect(screen.queryByTestId("tickets-detail-reopen-button")).toBeNull()
    expect(screen.queryByTestId("tickets-detail-footer-open-mail")).toBeNull()
    expect(screen.queryByTestId("tickets-detail-footer-open-target")).toBeNull()
    fireEvent.click(screen.getByTestId("tickets-detail-footer-reopen"))
    expect(state.reopenTicket).toHaveBeenCalledWith(state.api, "t1")
  })

  it("opens the linked mail conversation for converted closed tickets", async () => {
    reactive.setStore("byId", "t1", {
      ...TICKET,
      status: "closed",
      closedReason: "converted_to_mail",
      convertedToMailConversationId: "m1",
    })
    state.loadTicket.mockResolvedValueOnce(undefined)
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-footer-open-mail")).toBeTruthy())
    expect(screen.queryByTestId("tickets-detail-footer-reopen")).toBeNull()
    fireEvent.click(screen.getByTestId("tickets-detail-footer-open-mail"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mail:conversation", entityId: "m1" }),
    )
  })

  it("opens the target ticket for merged closed tickets", async () => {
    reactive.setStore("byId", "t1", {
      ...TICKET,
      status: "closed",
      closedReason: "merged",
      mergedIntoTicketId: "target-1",
    })
    state.loadTicket.mockResolvedValueOnce(undefined)
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() =>
      expect(screen.getByTestId("tickets-detail-footer-open-target")).toBeTruthy(),
    )
    expect(screen.queryByTestId("tickets-detail-footer-reopen")).toBeNull()
    fireEvent.click(screen.getByTestId("tickets-detail-footer-open-target"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tickets:ticket", entityId: "target-1" }),
    )
  })

  it("shows an empty category chip when the ticket has no category", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-category-empty")).toBeTruthy())
    expect(screen.queryByTestId("tickets-detail-category-chip")).toBeNull()
  })

  it("renders 'Parent / Child' for a child category", async () => {
    reactive.setStore("byId", "t1", { ...TICKET, categoryId: "cat-child", categoryName: "Refunds" })
    state.loadTicket.mockResolvedValueOnce(undefined)
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-category-chip")).toBeTruthy())
    expect(screen.getByTestId("tickets-detail-category-chip").textContent).toContain(
      "Billing / Refunds",
    )
  })

  it("renders just the name for a root category", async () => {
    reactive.setStore("byId", "t1", { ...TICKET, categoryId: "cat-root", categoryName: "Billing" })
    state.loadTicket.mockResolvedValueOnce(undefined)
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-category-chip")).toBeTruthy())
    expect(screen.getByTestId("tickets-detail-category-chip").textContent).toContain("Billing")
    expect(screen.getByTestId("tickets-detail-category-chip").textContent).not.toContain("/")
  })

  it("picking a category from the popup calls setCategory with id + name", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-category-empty")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-detail-category-empty"))
    await waitFor(() => expect(screen.getByTestId("tickets-category-option-cat-root")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-category-option-cat-root"))
    expect(state.setCategory).toHaveBeenCalledWith(state.api, "t1", "cat-root", "Billing")
  })

  it("picking a child category calls setCategory with the child id + name", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-category-empty")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-detail-category-empty"))
    await waitFor(() =>
      expect(screen.getByTestId("tickets-category-option-cat-child")).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId("tickets-category-option-cat-child"))
    expect(state.setCategory).toHaveBeenCalledWith(state.api, "t1", "cat-child", "Refunds")
  })

  it("clearing the category calls setCategory with null", async () => {
    reactive.setStore("byId", "t1", { ...TICKET, categoryId: "cat-root", categoryName: "Billing" })
    state.loadTicket.mockResolvedValueOnce(undefined)
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-category-chip")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-detail-category-chip"))
    await waitFor(() => expect(screen.getByTestId("tickets-category-option-none")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-category-option-none"))
    expect(state.setCategory).toHaveBeenCalledWith(state.api, "t1", null, null)
  })

  it("shows an error message and does not crash when setCategory rejects", async () => {
    state.setCategory.mockRejectedValueOnce(new Error("category update failed"))
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-detail-category-empty")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-detail-category-empty"))
    await waitFor(() => expect(screen.getByTestId("tickets-category-option-cat-root")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-category-option-cat-root"))
    await waitFor(() =>
      expect(screen.getByTestId("tickets-detail-category-error").textContent).toContain(
        "category update failed",
      ),
    )
  })

  // Approval-card rendering itself lives in TicketConversationStream (inline
  // with the conversation) — TicketDetail's contract is just forwarding the
  // internal/approval thread id to the stream.
  it("forwards the ticket's internalThreadId to the conversation stream as approvalThreadId", async () => {
    reactive.setStore("byId", "t1", { ...TICKET, internalThreadId: "thread-1" })
    state.loadTicket.mockResolvedValueOnce(undefined)
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() =>
      expect(
        screen.getByTestId("tickets-stream-mock").getAttribute("data-approval-thread-id"),
      ).toBe("thread-1"),
    )
  })
})

// Layout (2026-08-05): the detail was one vertical column with FIVE stacked
// children and only the stream flexible, so every metadata block shortened the
// conversation one-for-one ("window is not tall enough"). Metadata and actions
// now live in a collapsible right sidepanel; the conversation column keeps the
// stream and the composer.
describe("TicketDetail layout", () => {
  beforeEach(() => {
    reactive.setStore("byId", reactive.reconcile({}))
    state.loadTicket.mockReset()
    state.loadTicket.mockImplementation(async () => {
      reactive.setStore("byId", "t1", { ...TICKET })
    })
    state.loadMessages.mockReset()
    localStorage.removeItem("tickets.detailPanelOpen")
  })

  it("renders the details sidepanel and the conversation column side by side", async () => {
    const { getByTestId } = render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => getByTestId("tickets-detail"))
    const root = getByTestId("tickets-detail")
    // A ROW, not a column: the panel sits beside the conversation.
    expect(root.className).toContain("flex h-full")
    expect(root.className).not.toContain("flex-col")
    await waitFor(() => getByTestId("tickets-detail-panel"))
    getByTestId("tickets-detail-stream")
  })

  // Invariant: approval cards render
  // INLINE in the stream and the stream must never collapse to zero height.
  // The stream keeps the only flex-1 in its column.
  it("keeps the stream as the flexible child of the conversation column", async () => {
    const { getByTestId } = render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => getByTestId("tickets-detail-stream"))
    const stream = getByTestId("tickets-detail-stream")
    expect(stream.className).toContain("flex-1")
    expect(stream.className).toContain("min-h-0")
  })

  it("stacks the columns through ResponsiveDetail, content before metadata", async () => {
    const { getByTestId } = render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => getByTestId("tickets-detail-panel"))
    const detail = getByTestId("tickets-detail").querySelector("[data-responsive=detail]")
    expect(detail).toBeTruthy()
    // Phone stacks, desktop is a row: both come from the primitive, no branch here.
    expect(detail?.className).toContain("flex-col")
    expect(detail?.className).toContain("md:flex-row")
    const content = detail?.querySelector("[data-responsive=content]")
    const metadata = detail?.querySelector("[data-responsive=metadata]")
    expect(content?.contains(getByTestId("tickets-detail-stream"))).toBe(true)
    expect(metadata?.contains(getByTestId("tickets-detail-panel"))).toBe(true)
    // Content first in DOM order, so a stacked phone layout reads content then metadata.
    const order = content?.compareDocumentPosition(metadata as Node) ?? 0
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("collapses the sidepanel, and the conversation survives without it", async () => {
    const { getByTestId, queryByTestId } = render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => getByTestId("tickets-detail-panel-toggle"))
    fireEvent.click(getByTestId("tickets-detail-panel-toggle"))
    await waitFor(() => expect(queryByTestId("tickets-detail-panel")).toBeNull())
    getByTestId("tickets-detail-stream")
  })

  // An app can add a panel to the details sidepanel (the CRM customer card is
  // one) through the `ticket:detail:panel` contribution slot; the panel gets
  // the ticket id and sits in the sidepanel, never outside it.
  it("shows the header actions other apps add to the ticket, with the ticket id", async () => {
    const { registerContribution, unregisterContributions } = await import(
      "~/framework/app-registry"
    )
    state.api.get = vi.fn(async (path: string) =>
      path === "/v1/slots/ticket:detail:actions"
        ? { panels: [{ id: "action", app: "fixture-app", label: "Act" }] }
        : { panels: [] },
    )
    registerContribution("ticket:detail:actions", {
      appId: "fixture-app",
      id: "action",
      label: "Act",
      component: ((props: { entityId?: string }) => (
        <button type="button" data-testid="ticket-action-contribution">
          {props.entityId}
        </button>
      )) as never,
    })
    try {
      render(() => <TicketDetail entityId="t1" />)
      const action = await screen.findByTestId("ticket-action-contribution")
      expect(action.textContent).toBe("t1")
      expect(screen.getByTestId("tickets-detail-header").contains(action)).toBe(true)
    } finally {
      unregisterContributions("fixture-app")
      delete state.api.get
    }
  })

  it("renders the ticket:detail:panel contributions inside the sidepanel with the ticket id", async () => {
    const { registerContribution, unregisterContributions } = await import(
      "~/framework/app-registry"
    )
    // The server lists the panel for this viewer; the app's UI registered its component.
    state.api.get = vi.fn(async (path: string) =>
      path === "/v1/slots/ticket:detail:panel"
        ? { panels: [{ id: "panel", app: "test-panel-app", label: "Panel" }] }
        : { panels: [] },
    )
    registerContribution("ticket:detail:panel", {
      appId: "test-panel-app",
      id: "panel",
      label: "Test panel",
      component: ((props: { ticketId: string }) => (
        <div data-testid="ticket-panel-contribution">{props.ticketId}</div>
      )) as never,
    })
    try {
      render(() => <TicketDetail entityId="t1" />)
      await waitFor(() => expect(screen.getByTestId("ticket-panel-contribution")).toBeTruthy())
      const panel = screen.getByTestId("tickets-detail-panel")
      expect(panel.contains(screen.getByTestId("ticket-panel-contribution"))).toBe(true)
      expect(screen.getByTestId("ticket-panel-contribution").textContent).toBe("t1")
    } finally {
      unregisterContributions("test-panel-app")
      delete state.api.get
    }
  })
})
