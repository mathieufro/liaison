// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn() } as any,
  ticket: { id: "t1", summaryText: "All good" } as any,
  collapsed: false,
  status: "idle" as "idle" | "generating" | "error",
  applyTicketSummaryResult: vi.fn((ticketId: string, result: any, _sinceVersion?: number) => {
    if (ticketId !== "t1") return false
    if ("summary" in result) state.ticket.summaryText = result.summary
    if ("summaryStatus" in result) state.ticket.summaryStatus = result.summaryStatus
    if ("summaryError" in result) state.ticket.summaryError = result.summaryError
    return true
  }),
  handleTicketSummaryEvent: vi.fn((data: any) => {
    if (data.ticketId === "t1" && data.summaryStatus) state.status = data.summaryStatus
  }),
  toggleSummary: vi.fn(() => {
    state.collapsed = !state.collapsed
  }),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/tickets/ticket-detail-store", () => ({
  applyTicketSummaryResult: state.applyTicketSummaryResult,
  ticketSummaryVersion: () => 0,
  ticketDetailStore: {
    get byId() {
      return { t1: state.ticket }
    },
  },
}))
vi.mock("~/modules/tickets/ticket-summary-store", () => ({
  handleTicketSummaryEvent: state.handleTicketSummaryEvent,
  isCollapsed: () => state.collapsed,
  toggleSummary: state.toggleSummary,
  ticketSummaryStore: {
    get statusByTicketId() {
      return { t1: state.status }
    },
  },
}))

import { TicketSummaryCard } from "./TicketSummaryCard"

describe("TicketSummaryCard", () => {
  beforeEach(() => {
    state.api.post = vi.fn().mockResolvedValue({})
    state.ticket = { id: "t1", summaryText: "All good", summaryStatus: "idle", messageCount: 2 }
    state.collapsed = false
    state.status = "idle"
    state.applyTicketSummaryResult.mockClear()
    state.handleTicketSummaryEvent.mockClear()
    state.toggleSummary.mockClear()
  })

  it("renders summary text when expanded", () => {
    render(() => <TicketSummaryCard ticketId="t1" />)
    expect(screen.getByTestId("tickets-summary-text").textContent).toBe("All good")
  })

  it("[SC6] ensures a summary on mount", () => {
    render(() => <TicketSummaryCard ticketId="t1" />)
    expect(state.api.post).toHaveBeenCalledWith(
      "/apps/run-tool",
      expect.objectContaining({
        toolName: "tickets:ensureSummary",
        params: { ticketId: "t1" },
      }),
    )
  })

  it("does not call ensureSummary when ticketId is missing", () => {
    render(() => <TicketSummaryCard ticketId="" />)
    expect(state.api.post).not.toHaveBeenCalled()
  })

  it("consumes ensureSummary results into the summary stores", async () => {
    state.ticket.summaryText = null
    state.api.post = vi.fn().mockResolvedValue({
      summary: "Fresh summary",
      summaryStatus: "idle",
      summaryError: null,
    })
    render(() => <TicketSummaryCard ticketId="t1" />)
    await waitFor(() =>
      expect(state.applyTicketSummaryResult).toHaveBeenCalledWith(
        "t1",
        expect.objectContaining({ summary: "Fresh summary" }),
        0,
      ),
    )
    expect(state.handleTicketSummaryEvent).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: "t1", summaryStatus: "idle" }),
    )
  })

  it("toggle button reflects collapsed state via data attribute", () => {
    state.collapsed = true
    render(() => <TicketSummaryCard ticketId="t1" />)
    const card = screen.getByTestId("tickets-summary-card")
    expect(card.getAttribute("data-collapsed")).toBe("true")
  })

  it("clicking toggle calls toggleSummary store action", () => {
    render(() => <TicketSummaryCard ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-summary-toggle"))
    expect(state.toggleSummary).toHaveBeenCalledWith("t1")
  })

  it("regenerate button posts tickets:regenerateSummary tool", () => {
    render(() => <TicketSummaryCard ticketId="t1" />)
    fireEvent.click(screen.getByTestId("tickets-summary-regenerate"))
    expect(state.api.post).toHaveBeenCalledWith(
      "/apps/run-tool",
      expect.objectContaining({
        toolName: "tickets:regenerateSummary",
        params: { ticketId: "t1" },
      }),
    )
  })

  it("renders old summary plus updating state while regenerating", () => {
    state.status = "generating"
    render(() => <TicketSummaryCard ticketId="t1" />)
    expect(screen.getByTestId("tickets-summary-text").textContent).toBe("All good")
    expect(screen.getByTestId("tickets-summary-updating").textContent).toContain("Updating")
  })

  it("renders generating placeholder when no old summary exists", () => {
    state.status = "generating"
    state.ticket.summaryText = null
    render(() => <TicketSummaryCard ticketId="t1" />)
    expect(screen.getByTestId("tickets-summary-generating")).toBeTruthy()
  })

  it("renders error reason and retry action when status is error", () => {
    state.status = "error"
    state.ticket.summaryError = "insufficient credits"
    render(() => <TicketSummaryCard ticketId="t1" />)
    expect(screen.getByTestId("tickets-summary-error").textContent).toContain(
      "insufficient credits",
    )
    fireEvent.click(screen.getByTestId("tickets-summary-retry"))
    expect(state.api.post).toHaveBeenCalledWith(
      "/apps/run-tool",
      expect.objectContaining({ toolName: "tickets:regenerateSummary" }),
    )
  })

  it("hides the summary card for zero-message tickets", () => {
    state.ticket.messageCount = 0
    render(() => <TicketSummaryCard ticketId="t1" />)
    expect(screen.queryByTestId("tickets-summary-card")).toBeNull()
  })
})
