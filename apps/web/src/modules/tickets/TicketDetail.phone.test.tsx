// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-1 T11. The phone ticket screen: its own nav bar, the metadata as pills,
// the pinned action bar, the composer opening full screen, and the agent draft
// deciding through the approvals endpoint.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const reactive = vi.hoisted(
  () =>
    ({}) as {
      setStore: import("solid-js/store").SetStoreFunction<{ byId: Record<string, any> }>
      reconcile: typeof import("solid-js/store").reconcile
    },
)

const state = vi.hoisted(() => ({
  api: { post: vi.fn(), getEnvelope: vi.fn() } as any,
  openTab: vi.fn(),
  decide: vi.fn(async () => ({})),
  draft: null as any,
  setPriority: vi.fn(),
  setCategory: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/auth/auth-store", () => ({
  hasScope: () => true,
  userFromToken: () => ({ userId: "u-1", name: "Tester" }),
}))
vi.mock("~/modules/shell/tab-store", () => ({
  makeTabId: (type: string, entityId: string) => `${type}:${entityId}`,
  openTab: state.openTab,
  tabStore: {
    get activeTabId() {
      return "tickets:ticket:t1"
    },
  },
}))
vi.mock("~/modules/approvals/approvals-store", () => ({ decide: state.decide }))
vi.mock("~/modules/tickets/ticket-agent-draft", () => ({
  agentDraftFor: () => state.draft,
}))
vi.mock("~/modules/tickets/ticket-detail-store", async () => {
  const { createStore, reconcile } = await import("solid-js/store")
  const [store, setStore] = createStore<{
    byId: Record<string, any>
    loadFailedById: Record<string, string>
  }>({ byId: {}, loadFailedById: {} })
  reactive.setStore = setStore as any
  reactive.reconcile = reconcile
  return {
    loadTicket: vi.fn(async () => {}),
    markRead: vi.fn(),
    reopenTicket: vi.fn(),
    setStatus: vi.fn(),
    setPriority: state.setPriority,
    setCategory: state.setCategory,
    assignTicket: vi.fn(),
    setTicketFollowup: vi.fn(),
    clearTicketFollowup: vi.fn(),
    getComposeSignature: () => null,
    ticketDetailStore: store,
  }
})
vi.mock("~/modules/tickets/ticket-message-store", () => ({
  latestInboundCc: () => [],
  loadMessages: vi.fn(),
}))
vi.mock("~/modules/tickets/ticket-category-store", () => ({
  loadCategories: vi.fn(),
  ticketCategoryStore: {
    categories: [{ id: "cat-1", parentId: null, name: "Billing", sortOrder: 0, archivedAt: null }],
    loaded: true,
    loading: false,
  },
}))
vi.mock("~/modules/tickets/TicketComposer", () => ({
  TicketComposer: (props: any) => (
    <div data-testid="tickets-composer-mock" data-mode={props.initialMode ?? "reply"}>
      <button
        type="button"
        data-testid="tickets-composer-mock-sent"
        onClick={() => props.onSubmitted?.(props.initialMode ?? "reply")}
      />
    </div>
  ),
  canReplyOnTickets: () => true,
  canNoteOnTickets: () => true,
}))
vi.mock("~/modules/tickets/TicketConversationStream", () => ({
  TicketConversationStream: () => <div data-testid="tickets-stream-mock" />,
}))
vi.mock("~/modules/tickets/TicketSummaryCard", () => ({
  TicketSummaryCard: () => <div data-testid="tickets-summary-mock" />,
}))
vi.mock("~/lib/mention-service", () => ({ searchMentions: vi.fn(async () => []) }))

import { closeTicketMoreSheet } from "~/modules/tickets/ticket-phone-header-store"
import { setShellTier } from "~/tests/helpers/shell-tier"
import { TICKET_DETAIL_ACTIONS_SLOT, TICKET_DETAIL_PANEL_SLOT, TicketDetail } from "./TicketDetail"

const TICKET = {
  id: "t1",
  handle: "ticket-1",
  subject: "Pedal not detected",
  status: "awaiting_customer",
  priority: "high",
  sensitivity: "internal",
  slaDeadline: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
  firstResponseAt: null,
  category: { id: "cat-1", name: "Billing" },
  assignee: { id: "u9", name: "Dana Ops", avatarUrl: null },
  internalThreadId: "th-1",
}

beforeEach(() => {
  state.openTab.mockReset()
  state.decide.mockClear()
  state.draft = null
  reactive.setStore("byId", reactive.reconcile({}) as any)
  reactive.setStore("byId", "t1", { ...TICKET })
  setShellTier("phone")
})

afterEach(() => {
  cleanup()
  setShellTier("desktop")
  // The sheet's open flag lives in a module-level shared store now (G1) —
  // reset it so a sheet left open by one test doesn't leak into the next.
  closeTicketMoreSheet()
})

describe("TicketDetail at phone tier", () => {
  // G1: the nav bar (back / handle / ⋯) used to render a SECOND time here
  // while MainPanel's phone top bar rendered its own generic bar above it. It
  // now lives ONLY in TicketPhoneHeader (own test file), registered onto the
  // tab type at runtime — this screen renders none of it.
  it("renders no in-screen nav bar: that lives in TicketPhoneHeader now", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("ticket-phone-meta")).toBeTruthy())
    expect(screen.queryByTestId("ticket-phone-header")).toBeNull()
    expect(screen.queryByTestId("ticket-phone-back")).toBeNull()
    expect(screen.queryByTestId("ticket-phone-handle")).toBeNull()
    expect(screen.queryByTestId("ticket-phone-more")).toBeNull()
  })

  it("states the ticket as pills under the subject", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("ticket-phone-meta")).toBeTruthy())
    expect(screen.getByTestId("tickets-detail-subject").textContent).toBe("Pedal not detected")
    expect(screen.getByTestId("ticket-phone-pill-sla").getAttribute("data-sla-tone")).toBe(
      "approaching",
    )
    expect(screen.getByTestId("ticket-phone-pill-status").textContent).toContain("Awaiting")
    expect(screen.getByTestId("ticket-phone-pill-category").textContent).toBe("Billing")
    expect(screen.getByTestId("ticket-phone-pill-assignee").textContent).toBe("Dana Ops")
  })

  it("pins the action bar at phone width only", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("ticket-action-bar")).toBeTruthy())
    const bar = screen.getByTestId("ticket-action-bar")
    expect(bar.textContent).toContain("Note")
    expect(bar.textContent).toContain("Reply")
    expect(bar.textContent).toContain("More")
    // Off the phone tier the desktop composer is inline and no bar exists.
    cleanup()
    setShellTier("desktop")
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("tickets-composer-mock")).toBeTruthy())
    expect(screen.queryByTestId("ticket-action-bar")).toBeNull()
    expect(screen.queryByTestId("ticket-phone-header")).toBeNull()
  })

  it("Reply opens the existing composer full screen, Note opens it on the note tab", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("ticket-action-bar")).toBeTruthy())
    // Nothing is composing until asked.
    expect(screen.queryByTestId("tickets-composer-mock")).toBeNull()

    fireEvent.click(screen.getByTestId("ticket-action-reply"))
    await waitFor(() => expect(screen.getByTestId("ticket-composer-sheet")).toBeTruthy())
    expect(screen.getByTestId("tickets-composer-mock").getAttribute("data-mode")).toBe("reply")
    const sheet = screen
      .getByTestId("ticket-composer-sheet")
      .closest("[data-overlay-sheet]") as HTMLElement
    expect(sheet.getAttribute("data-variant")).toBe("full")

    fireEvent.click(screen.getByTestId("overlay-sheet-close"))
    await waitFor(() => expect(screen.queryByTestId("ticket-composer-sheet")).toBeNull())

    fireEvent.click(screen.getByTestId("ticket-action-note"))
    await waitFor(() =>
      expect(screen.getByTestId("tickets-composer-mock").getAttribute("data-mode")).toBe("note"),
    )
  })

  it("the full-screen composer closes once the note or reply is sent", async () => {
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("ticket-action-note")).toBeTruthy())
    fireEvent.click(screen.getByTestId("ticket-action-note"))
    await waitFor(() => expect(screen.getByTestId("ticket-composer-sheet")).toBeTruthy())
    fireEvent.click(screen.getByTestId("tickets-composer-mock-sent"))
    await waitFor(() => expect(screen.queryByTestId("ticket-composer-sheet")).toBeNull())
  })

  it("the actions sheet lists the ticket actions the desktop header offers", async () => {
    // The sheet's trigger normally lives in TicketPhoneHeader (a separate
    // component now — own test file); the pinned action bar's own "More"
    // button opens the SAME shared sheet, so it drives this from here.
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("ticket-action-more")).toBeTruthy())
    fireEvent.click(screen.getByTestId("ticket-action-more"))
    await waitFor(() => expect(screen.getByTestId("ticket-more-sheet")).toBeTruthy())
    for (const id of [
      "ticket-more-assign",
      "ticket-more-category",
      "ticket-more-priority",
      "ticket-more-nudge",
      "ticket-more-convert-mail",
      "ticket-more-close",
    ]) {
      expect(screen.getByTestId(id)).toBeTruthy()
    }
    fireEvent.click(screen.getByTestId("ticket-more-priority"))
    await waitFor(() => expect(screen.getByTestId("ticket-priority-sheet")).toBeTruthy())
    fireEvent.click(screen.getByTestId("ticket-priority-sheet-urgent"))
    expect(state.setPriority).toHaveBeenCalledWith(state.api, "t1", "urgent")
  })

  it("what other apps add to the ticket (the customer card) is one row away under More", async () => {
    const { registerContribution, unregisterContributions } = await import(
      "~/framework/app-registry"
    )
    // The server lists the panel for this viewer; the app's UI registered its component.
    state.api.get = vi.fn(async (path: string) =>
      path === "/v1/slots/ticket:detail:panel"
        ? { panels: [{ id: "panel", app: "fixture-crm", label: "Panel" }] }
        : { panels: [] },
    )
    registerContribution(TICKET_DETAIL_PANEL_SLOT, {
      appId: "fixture-crm",
      id: "panel",
      label: "Customer",
      component: ((p: { ticketId: string }) => (
        <div data-testid="customer-card" data-ticket={p.ticketId} />
      )) as never,
    })
    try {
      render(() => <TicketDetail entityId="t1" />)
      await waitFor(() => expect(screen.getByTestId("ticket-action-more")).toBeTruthy())
      expect(screen.queryByTestId("customer-card")).toBeNull()
      fireEvent.click(screen.getByTestId("ticket-action-more"))
      fireEvent.click(await screen.findByTestId("ticket-more-customer"))
      const card = await screen.findByTestId("customer-card")
      expect(card.dataset.ticket).toBe("t1")
    } finally {
      unregisterContributions("fixture-crm")
      delete state.api.get
    }
  })

  it("what other apps add as ticket actions sit in the More sheet, each given the ticket", async () => {
    const { registerContribution, unregisterContributions } = await import(
      "~/framework/app-registry"
    )
    state.api.get = vi.fn(async (path: string) =>
      path === `/v1/slots/${TICKET_DETAIL_ACTIONS_SLOT}`
        ? { panels: [{ id: "act", app: "fixture-crm", label: "Act" }] }
        : { panels: [] },
    )
    registerContribution(TICKET_DETAIL_ACTIONS_SLOT, {
      appId: "fixture-crm",
      id: "act",
      label: "Act",
      component: ((p: { entityId: string }) => (
        <button type="button" data-testid="fixture-action" data-ticket={p.entityId} />
      )) as never,
    })
    try {
      render(() => <TicketDetail entityId="t1" />)
      fireEvent.click(await screen.findByTestId("ticket-action-more"))
      const sheet = await screen.findByTestId("ticket-more-sheet")
      const action = await screen.findByTestId("fixture-action")
      expect(sheet.contains(action)).toBe(true)
      expect(action.dataset.ticket).toBe("t1")
    } finally {
      unregisterContributions("fixture-crm")
      delete state.api.get
    }
  })

  it("no More row for an empty panel slot", async () => {
    render(() => <TicketDetail entityId="t1" />)
    fireEvent.click(await screen.findByTestId("ticket-action-more"))
    await screen.findByTestId("ticket-more-sheet")
    expect(screen.queryByTestId("ticket-more-customer")).toBeNull()
  })

  // The draft already has its own card in the conversation (where opening the
  // ticket scrolls to it): a second "Agent draft ready / Send as is / Edit"
  // bar above the composer only repeated it.
  it("a pending agent draft adds no bar above the action bar", async () => {
    state.draft = {
      id: "ar-1",
      status: "pending",
      toolName: "tickets:reply",
      currentPayload: { ticketId: "t1", textBody: "We have shipped a replacement." },
    }
    render(() => <TicketDetail entityId="t1" />)
    await waitFor(() => expect(screen.getByTestId("ticket-action-bar")).toBeTruthy())
    expect(screen.queryByTestId("ticket-agent-draft")).toBeNull()
    expect(screen.queryByTestId("ticket-draft-send")).toBeNull()
    expect(screen.queryByTestId("ticket-draft-edit")).toBeNull()
  })
})
