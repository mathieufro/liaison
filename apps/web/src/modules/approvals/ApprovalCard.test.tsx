// SPDX-License-Identifier: FSL-1.1-ALv2
import { APPROVING_WEDGE_GRACE_MS } from "@liaison/shared"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { formatDateTime } from "~/lib/relative-time"
import { DecisionQueueTestAccess } from "~/modules/approvals/decision-queue"
import { HeldKeptTestAccess, keepHolding } from "~/modules/approvals/held-kept"
import { setMarkdown } from "~/modules/editor/test-helpers"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { appHue } from "~/modules/shell/app-color"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import ApprovalCard from "./ApprovalCard"
import { getById, handleWsCreate, handleWsUpdate, resetApprovalsStore } from "./approvals-store"

// These tests pin the card's decide wiring; the 5 s Undo window itself is
// decision-queue.test.ts's.
beforeEach(() => {
  DecisionQueueTestAccess.reset()
  DecisionQueueTestAccess.setUndoWindow(0)
  localStorage.removeItem("liaison:heldKept.v1")
  HeldKeptTestAccess.reload()
})

let currentScope: string[] = ["mail:approve"]
let currentUserId = "u-approver"
const apiMocks = {
  get: vi.fn().mockResolvedValue(undefined),
  post: vi.fn(),
}

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))

vi.mock("~/modules/auth/auth-store", () => ({
  hasScope: (s: string) => currentScope.includes(s),
  userFromToken: () => ({ userId: currentUserId, name: "Test User", scopes: currentScope }),
}))

const toastMock = vi.fn()
vi.mock("~/modules/shell/toast-store", () => ({
  addToast: (t: any) => toastMock(t),
}))

vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
}))

const redraftMocks = vi.hoisted(() => ({
  ensureDm: vi.fn(async () => "dm-1"),
  send: vi.fn(async () => {}),
}))
vi.mock("~/modules/threads/personal-dm-store", () => ({
  ensurePersonalAgentDm: redraftMocks.ensureDm,
}))
vi.mock("~/modules/threads/message-store", async (orig) => ({
  ...(await orig<object>()),
  sendMessage: redraftMocks.send,
}))

const baseRow = (over: Partial<any> = {}): any => ({
  id: "ar-1",
  handle: "request-0001",
  status: "pending",
  createdAt: "2026-04-30T12:00:00.000Z",
  expiresAt: "2026-04-30T13:00:00.000Z",
  toolName: "mail:reply",
  summary: { kind: "mail.reply", title: "Re: Test", lines: ["body line"] },
  editableFields: [{ field: "textBody", label: "Body", widget: "richtext" }],
  currentPayload: { textBody: "original" },
  threadId: "t-1",
  originatingThreadId: "t-1",
  requestedBy: { id: "u-requester" },
  requester: { kind: "user", id: "u-requester", name: "Bob" },
  notifyUserIds: ["u-approver", "u-requester"],
  lastEdit: null,
  lastFailure: null,
  ...over,
})

beforeEach(() => {
  resetApprovalsStore()
  currentScope = ["mail:approve"]
  currentUserId = "u-approver"
  apiMocks.get.mockReset().mockResolvedValue(undefined)
  apiMocks.post.mockReset()
  toastMock.mockReset()
})

describe("ApprovalCard", () => {
  // S23: a ticket card leads with the ticket id people use, as a mono chip,
  // then the subject as title and "action + customer" as subtitle.
  it("leads with the summary ref as a monospace chip, before the title", async () => {
    currentScope = ["tickets:approve"]
    handleWsCreate(
      baseRow({
        id: "ar-ref",
        toolName: "tickets:reply",
        summary: {
          kind: "tickets.reply",
          ref: "ticket-B2B-123",
          title: "Where is my order",
          subtitle: "Reply to Jean Dupont",
          lines: [],
        },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-ref" />)
    const ref = await screen.findByTestId("approval-card-ref")
    expect(ref).toHaveTextContent("ticket-B2B-123")
    expect(ref.className).toContain("font-mono")
    const title = screen.getByTestId("approval-card-title")
    expect(title).toHaveTextContent("Where is my order")
    expect(title).not.toHaveTextContent("ticket-B2B-123")
    expect(ref.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // D10 (APR-01): a French reader gets the card in French, the same words as
  // the Home row: subtitle template, "Last message:" line, the "Open ticket"
  // link and the kind label; the ref chip leads the header, before the kind.
  it("renders a ticket card in French, with the ref chip leading the header", async () => {
    currentScope = ["tickets:approve"]
    handleWsCreate(
      baseRow({
        id: "ar-fr",
        toolName: "tickets:reply",
        summary: {
          kind: "tickets.reply",
          ref: "ticket-B2B-1",
          title: "Facturation partenaire",
          subtitle: "Reply to Claire Durand (Partner Mall)",
          lines: ["Last message: 2026-09-28 22:03"],
          links: [{ label: "Open ticket", app: "tickets", entityType: "ticket", entityId: "tk-1" }],
        },
      }),
      "u-approver",
    )
    render(() => (
      <I18nProvider initialLocale="fr">
        <ApprovalCard requestId="ar-fr" />
      </I18nProvider>
    ))
    const card = await screen.findByTestId("approval-card")
    const text = card.textContent ?? ""
    expect(text).toContain("Réponse à Claire Durand (Partner Mall)")
    expect(text).not.toContain("Reply to")
    expect(text).toContain(`Dernier message : ${formatDateTime("2026-09-28T22:03:00Z", "fr")}`)
    expect(text).not.toContain("Last message")
    expect(text).toContain("Ouvrir le ticket")
    expect(text).not.toContain("Open ticket")
    const kind = screen.getByTestId("approval-card-kind")
    expect(kind).toHaveTextContent("Tickets : répondre")
    expect(text).not.toContain("tickets.reply")
    const ref = screen.getByTestId("approval-card-ref")
    expect(ref.compareDocumentPosition(kind) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("renders the kind label in English for an English reader, never the raw kind", async () => {
    currentScope = ["tickets:approve"]
    handleWsCreate(
      baseRow({
        id: "ar-en",
        toolName: "tickets:reply",
        summary: { kind: "tickets.reply", title: "Hello", lines: [] },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-en" />)
    const kind = await screen.findByTestId("approval-card-kind")
    expect(kind).toHaveTextContent("Tickets: reply")
    // The kind is the app-coloured pill the Home row carries (AppPill).
    expect(kind).toHaveAttribute("data-app", "tickets")
    expect(kind.style.getPropertyValue("--app-pill-fg-light")).toBe(
      `hsl(${appHue("tickets")} 55% 28%)`,
    )
  })

  it("shows no ref chip when the summary has none", async () => {
    handleWsCreate(baseRow({ id: "ar-noref" }), "u-approver")
    render(() => <ApprovalCard requestId="ar-noref" />)
    await screen.findByTestId("approval-card-title")
    expect(screen.queryByTestId("approval-card-ref")).toBeNull()
  })

  it("prints the handle AND the uuid's first segment, always visible; click copies the full uuid", async () => {
    // Agents cite approvals by uuid in chat. Hidden behind a hover, the uuid
    // could not be matched to any card by eye.
    const id = "3f2a9c1e-7b1d-4c2a-9e0f-1234567890ab"
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    handleWsCreate(baseRow({ id, handle: "request-42" }), "u-approver")
    render(() => <ApprovalCard requestId={id} />)
    const handle = await screen.findByTestId("approval-card-handle")
    expect(handle).toHaveTextContent("request-42")
    expect(screen.getByTestId("approval-card-short-id")).toHaveTextContent("3f2a9c1e")
    expect(handle).toHaveAttribute("title", expect.stringContaining(id))
    fireEvent.click(handle)
    expect(writeText).toHaveBeenCalledWith(id)
    vi.unstubAllGlobals()
  })

  // Cold walk 2026-11-08: Details on a Home row opened the card and the decision went out of
  // view under a long diff, and the card's header led with "request-42 · 97f1b404".
  it("opened from a Home row: no handle or id in the header, the decision leads the card, sticky at the top", async () => {
    const id = "3f2a9c1e-7b1d-4c2a-9e0f-1234567890ab"
    handleWsCreate(baseRow({ id, handle: "request-42" }), "u-approver")
    render(() => <ApprovalCard requestId={id} inFeed />)
    await screen.findByTestId("approval-card-title")
    expect(screen.queryByTestId("approval-card-handle")).toBeNull()
    expect(screen.queryByTestId("approval-card-short-id")).toBeNull()
    const row = screen.getByTestId("actions-inline-row")
    expect(row.className).toContain("sticky")
    expect(row.className).toContain("top-0")
    expect(row.className).not.toContain("bottom-0")
    expect(row.className).toContain("bg-elevated")
    // At the top of the card: before its title, so the chat dock at the bottom never covers it.
    const title = screen.getByTestId("approval-card-title")
    expect(row.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getAllByTestId("actions-inline-row")).toHaveLength(1)
  })

  it("outside Home the card keeps its handle and its decision where it was", async () => {
    const id = "3f2a9c1e-7b1d-4c2a-9e0f-1234567890ac"
    handleWsCreate(baseRow({ id, handle: "request-43" }), "u-approver")
    render(() => <ApprovalCard requestId={id} />)
    expect(await screen.findByTestId("approval-card-handle")).toBeInTheDocument()
    const row = screen.getByTestId("actions-inline-row")
    expect(row.className).not.toContain("sticky")
    // It closes the card, after the title.
    const title = screen.getByTestId("approval-card-title")
    expect(row.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it("renders skeleton while ensureLoaded is in flight", async () => {
    apiMocks.get.mockImplementation(() => new Promise(() => {}))
    render(() => <ApprovalCard requestId="ar-pending" />)
    expect(await screen.findByTestId("approval-card-skeleton")).toBeInTheDocument()
  })

  it("shows Approve+Deny+Edit when actor has approve scope and is not requester (eligible approvers may deny)", async () => {
    // An eligible approver may REJECT, not only the requester — mirrors the
    // backend decide authz (decide.ts). Previously Deny was gated on isRequester
    // only, so an approver could approve but never deny.
    handleWsCreate(baseRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("approval-card-action-approve")).toBeInTheDocument()
    expect(screen.getByTestId("approval-card-action-edit")).toBeInTheDocument()
    expect(screen.getByTestId("approval-card-action-deny")).toBeInTheDocument()
  })

  it("collapses the action row to a single more trigger at phone width", async () => {
    handleWsCreate(baseRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("actions-more-trigger")).toBeInTheDocument()
    const inline = screen.getByTestId("actions-inline-row")
    // Desktop keeps the inline row, phone paints the trigger: one primitive, no branch.
    expect(inline.className).toContain("hidden")
    expect(inline.className).toContain("md:flex")
    expect(inline.contains(screen.getByTestId("approval-card-action-approve"))).toBe(true)
  })

  it("deny from the phone action sheet still asks for a reason", async () => {
    apiMocks.post.mockResolvedValue({ id: "ar-1", status: "denied" })
    handleWsCreate(baseRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("actions-more-trigger"))
    fireEvent.click(await screen.findByTestId("approval-card-action-deny-sheet"))
    expect(await screen.findByTestId("approval-card-deny-reason")).toBeInTheDocument()
  })

  it("shows Deny+Edit for requester without approve scope", async () => {
    currentScope = []
    currentUserId = "u-requester"
    handleWsCreate(baseRow(), "u-requester")
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("approval-card-action-deny")).toBeInTheDocument()
    expect(screen.getByTestId("approval-card-action-edit")).toBeInTheDocument()
    expect(screen.queryByTestId("approval-card-action-approve")).toBeNull()
  })

  it("shows Approve+Deny+Edit when requester also has approve scope", async () => {
    currentScope = ["mail:approve"]
    currentUserId = "u-requester"
    handleWsCreate(
      baseRow({
        requestedBy: { id: "u-requester" },
        requester: { kind: "user", id: "u-requester", name: "Me" },
      }),
      "u-requester",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("approval-card-action-approve")).toBeInTheDocument()
    expect(screen.getByTestId("approval-card-action-deny")).toBeInTheDocument()
    expect(screen.getByTestId("approval-card-action-edit")).toBeInTheDocument()
  })

  it("hides Edit when editableFields is empty", async () => {
    handleWsCreate(baseRow({ editableFields: [] }), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("approval-card-action-approve")).toBeInTheDocument()
    expect(screen.queryByTestId("approval-card-action-edit")).toBeNull()
  })

  it("renders a persistent inline failure banner when the card carries lastFailure", async () => {
    // The silent-no-op bug: a prior approve executed the handler, it failed with
    // no effect and the card reverted to pending. The reason must persist ON the
    // card in the attention feed (a one-shot toast is missed on 99% of decides).
    handleWsCreate(
      baseRow({
        lastFailure: {
          code: "already_fulfilled",
          message: "This order was already fulfilled in Shopify.",
          at: "2026-04-30T12:05:00.000Z",
        },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    const banner = await screen.findByTestId("approval-card-last-failure")
    expect(banner).toBeInTheDocument()
    expect(banner).toHaveTextContent("This order was already fulfilled in Shopify.")
    // The approve action is still available (the card is pending again).
    expect(screen.getByTestId("approval-card-action-approve")).toBeInTheDocument()
  })

  it("a request cancelled by a ticket merge shows its readable sentence, in French too", async () => {
    handleWsCreate(
      baseRow({
        status: "cancelled",
        reason: "Cancelled: the ticket was merged into another",
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    const line = await screen.findByTestId("approval-card-cancelled-reason")
    expect(line).toHaveTextContent("Cancelled: the ticket was merged into another")
    expect(line).not.toHaveTextContent("ticket_merged")
    cleanup()
    render(() => (
      <I18nProvider initialLocale="fr">
        <ApprovalCard requestId="ar-1" />
      </I18nProvider>
    ))
    expect(await screen.findByTestId("approval-card-cancelled-reason")).toHaveTextContent(
      "Annulée : le ticket a été fusionné dans un autre",
    )
  })

  it("shows no failure banner when lastFailure is null", async () => {
    handleWsCreate(baseRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    await screen.findByTestId("approval-card-action-approve")
    expect(screen.queryByTestId("approval-card-last-failure")).toBeNull()
  })

  it("Approve transitions to Executing and reverts to terminal state on WS update", async () => {
    apiMocks.post.mockResolvedValue({ id: "ar-1", status: "approved" })
    handleWsCreate(baseRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-approve"))
    await waitFor(() => expect(screen.queryByTestId("approval-card-executing")).toBeInTheDocument())
    handleWsUpdate(baseRow({ status: "approved", decidedBy: "u-approver" }))
    await waitFor(() => {
      expect(screen.queryByTestId("approval-card-executing")).toBeNull()
      expect(screen.getByTestId("approval-card-status-badge")).toHaveTextContent("Approved")
    })
  })

  it("a card opened after an edit binds Approve to the version it shows, not the one first loaded elsewhere", async () => {
    apiMocks.post.mockResolvedValue({ id: "ar-1", status: "approved" })
    // Loaded at sign-in (Home), then edited by the agent before this card ever opened.
    handleWsCreate(baseRow({ payloadHash: "seen" }), "u-approver")
    handleWsUpdate(baseRow({ payloadHash: "edited", currentPayload: { textBody: "changed" } }))
    apiMocks.get.mockResolvedValue(
      baseRow({ payloadHash: "edited", currentPayload: { textBody: "changed" } }),
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    await screen.findByTestId("approval-card-action-approve")
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId("approval-card-changed-notice")).toBeNull())
    fireEvent.click(screen.getByTestId("approval-card-action-approve"))
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalled())
    expect(toastMock).not.toHaveBeenCalled()
    expect(apiMocks.post.mock.calls[0]?.[1]).toMatchObject({
      decision: "approve",
      payloadHash: "edited",
    })
  })

  it("a card re-reads a row the store already held, so it shows an edit this device missed", async () => {
    handleWsCreate(baseRow({ payloadHash: "seen" }), "u-approver")
    apiMocks.get.mockResolvedValue(
      baseRow({ payloadHash: "edited", currentPayload: { textBody: "missed edit" } }),
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    await waitFor(() => expect(getById("ar-1")?.payloadHash).toBe("edited"))
    expect(screen.queryByTestId("approval-card-changed-notice")).toBeNull()
  })

  it("an edit by someone else while the card is open is flagged, and Approve waits until it is read", async () => {
    apiMocks.post.mockResolvedValue({ id: "ar-1", status: "approved" })
    handleWsCreate(baseRow({ payloadHash: "seen" }), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    await screen.findByTestId("approval-card-action-approve")
    handleWsUpdate(baseRow({ payloadHash: "edited", currentPayload: { textBody: "changed" } }))
    expect(await screen.findByTestId("approval-card-changed-notice")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("approval-card-action-approve"))
    await waitFor(() => expect(toastMock).toHaveBeenCalled())
    expect(apiMocks.post).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("approval-card-changed-ack"))
    await waitFor(() => expect(screen.queryByTestId("approval-card-changed-notice")).toBeNull())
    fireEvent.click(screen.getByTestId("approval-card-action-approve"))
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalled())
    expect(apiMocks.post.mock.calls[0]?.[1]).toMatchObject({
      decision: "approve",
      payloadHash: "edited",
    })
  })

  it("renders backend approving status as Executing without action buttons", async () => {
    handleWsCreate(baseRow({ status: "approving" }), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("approval-card-executing")).toBeInTheDocument()
    expect(screen.queryByTestId("approval-card-action-approve")).toBeNull()
    expect(screen.queryByTestId("approval-card-action-deny")).toBeNull()
    expect(screen.queryByTestId("approval-card-action-edit")).toBeNull()
  })

  it("30 seconds without a WS update reverts the optimistic executing UI", async () => {
    vi.useFakeTimers()
    apiMocks.post.mockImplementation(() => new Promise(() => {}))
    handleWsCreate(baseRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-approve"))
    expect(await screen.findByTestId("approval-card-executing")).toBeInTheDocument()
    vi.advanceTimersByTime(30_000)
    await waitFor(() => expect(screen.queryByTestId("approval-card-executing")).toBeNull())
    expect(await screen.findByTestId("approval-card-action-approve")).toBeInTheDocument()
    expect(toastMock).toHaveBeenCalledWith({
      message: "Still executing in the background; refresh if needed.",
      type: "info",
    })
    vi.useRealTimers()
  })

  it("a RESOLVED decide keeps the card locked past the 30s timeout (no re-clickable window before the WS terminal state)", async () => {
    vi.useFakeTimers()
    apiMocks.post.mockResolvedValue({ id: "ar-1", status: "approved" })
    handleWsCreate(baseRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-approve"))
    await waitFor(() => expect(screen.queryByTestId("approval-card-executing")).toBeInTheDocument())
    // Let the mocked decide fully resolve (multi-hop microtask chain), then
    // cross the optimistic timeout: the buttons must NOT come back while the
    // terminal WS row is still in flight.
    await vi.advanceTimersByTimeAsync(30_000)
    expect(screen.queryByTestId("approval-card-action-approve")).toBeNull()
    expect(screen.queryByTestId("approval-card-action-deny")).toBeNull()
    // Terminal state lands -> card flips to Approved as usual.
    handleWsUpdate(baseRow({ status: "approved", decidedBy: "u-approver" }))
    await waitFor(() =>
      expect(screen.getByTestId("approval-card-status-badge")).toHaveTextContent("Approved"),
    )
    vi.useRealTimers()
  })

  it("inactive tab: the stale-approving ticker does not flip the card across mocked ticks; reactivation recomputes once", async () => {
    // Fresh `decidedAt`, not yet stale at mount, so the card starts in
    // "executing". It crosses the shared grace window only once the fake clock
    // is advanced past it.
    const decidedAt = new Date(Date.now() - 10_000).toISOString()
    handleWsCreate(baseRow({ status: "approving", decidedAt }), "u-approver")

    const [isActive, setIsActive] = createSignal(false)
    render(() => (
      <TabVisibilityProvider value={isActive}>
        <ApprovalCard requestId="ar-1" />
      </TabVisibilityProvider>
    ))
    // Let the initial ensureLoaded()/getById() resource settle on real timers
    // before switching to fake ones for the ticker assertions below.
    expect(await screen.findByTestId("approval-card-executing")).toBeInTheDocument()

    vi.useFakeTimers()
    try {
      // Ticker gated inactive: two 30s ticks must not (re)compute nowTick, so
      // even though real elapsed time (60s) is still under the grace window
      // either way, the point is the interval callback never fires
      // setNowTick while inactive: assert no unexpected DOM churn.
      vi.advanceTimersByTime(30_000 * 2)
      expect(screen.getByTestId("approval-card-executing")).toBeInTheDocument()
      expect(screen.queryByTestId("approval-card-stale-approving")).toBeNull()

      // Advance well past the grace window while STILL inactive: the gated
      // ticker must not pick this up.
      vi.advanceTimersByTime(APPROVING_WEDGE_GRACE_MS)
      expect(screen.getByTestId("approval-card-executing")).toBeInTheDocument()
      expect(screen.queryByTestId("approval-card-stale-approving")).toBeNull()

      // Reactivating recomputes immediately: now that elapsed time is past the
      // grace window, the card flips to the stale-review state.
      setIsActive(true)
      expect(screen.getByTestId("approval-card-stale-approving")).toBeInTheDocument()
      expect(screen.queryByTestId("approval-card-executing")).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // The server refuses the stale-request deny inside APPROVING_WEDGE_GRACE_MS
  // (decide.ts). A card that offered the close earlier showed a button that only
  // produced a 409.
  it.each([
    ["inside", -60_000, false],
    ["past", 60_000, true],
  ])(
    "stale close is offered only past the shared grace window (%s it)",
    async (_where, offsetMs, offered) => {
      const decidedAt = new Date(Date.now() - APPROVING_WEDGE_GRACE_MS - offsetMs).toISOString()
      handleWsCreate(baseRow({ status: "approving", decidedAt }), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card")
      if (offered) {
        expect(await screen.findByTestId("approval-card-stale-close")).toBeInTheDocument()
      } else {
        expect(await screen.findByTestId("approval-card-executing")).toBeInTheDocument()
        expect(screen.queryByTestId("approval-card-stale-close")).toBeNull()
      }
    },
  )

  describe("a request wedged at approving (the walk's 77-day-old RGPD delete)", () => {
    const wedgedRow = () =>
      baseRow({
        status: "approving",
        decidedAt: "2026-07-07T10:00:00.000Z",
        expiresAt: "2026-07-08T10:00:00.000Z",
        toolName: "remediation:rgpd_delete_customer",
        summary: {
          kind: "remediation:rgpd_delete_customer",
          title: "remediation:rgpd_delete_customer",
          subtitle: "Pending approval",
          lines: ['{"hub_id":"h-1","customer_id":"c-12"}'],
        },
        currentPayload: { hub_id: "h-1", customer_id: "c-12" },
        editableFields: [],
      })

    it("never re-offers Approve/Reject, reads as Approved, and drops the stale 'Pending approval'", async () => {
      currentScope = ["remediation:approve"]
      handleWsCreate(wedgedRow(), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      expect(await screen.findByTestId("approval-card-stale-approving")).toBeInTheDocument()
      expect(screen.queryByTestId("approval-card-action-approve")).toBeNull()
      expect(screen.queryByTestId("approval-card-action-deny")).toBeNull()
      expect(screen.queryByTestId("approval-card-deadline")).toBeNull()
      expect(screen.getByTestId("approval-card-status-badge")).toHaveTextContent("Approved")
      expect(screen.getByTestId("approval-card").textContent).not.toContain("Pending approval")
    })

    // Walk D47: a booked shipment's card still read "Pending approval,
    // nothing is shipped or bought yet" after it was approved.
    it("drops an app's own 'Pending approval, ...' subtitle once the request is decided", async () => {
      currentScope = ["remediation:approve"]
      handleWsCreate(
        baseRow({
          status: "approved",
          decidedAt: "2026-07-07T10:00:00.000Z",
          summary: {
            kind: "create_shipment",
            title: "Create shipment",
            subtitle: "Pending approval, nothing is shipped or bought yet",
            lines: ["Carrier: UPSE-ExpressSaver, 66.60 EUR TTC"],
          },
        }),
        "u-approver",
      )
      render(() => <ApprovalCard requestId="ar-1" />)
      expect(await screen.findByTestId("approval-card-status-badge")).toHaveTextContent("Approved")
      expect(screen.getByTestId("approval-card").textContent).not.toContain("Pending approval")
    })

    it("renders a legacy one-line JSON summary as key: value lines", async () => {
      currentScope = ["remediation:approve"]
      handleWsCreate(wedgedRow(), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-stale-approving")
      const card = screen.getByTestId("approval-card")
      expect(card.textContent).toContain("hub_id: h-1")
      expect(card.textContent).not.toContain('{"hub_id"')
    })

    it("offers the close-out, which denies with a reason saying the outcome is unknown", async () => {
      currentScope = ["remediation:approve"]
      apiMocks.post.mockResolvedValue({ id: "ar-1", status: "denied" })
      handleWsCreate(wedgedRow(), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      fireEvent.click(await screen.findByTestId("approval-card-stale-close"))
      await waitFor(() => expect(apiMocks.post).toHaveBeenCalled())
      const [path, body] = apiMocks.post.mock.calls[0]
      expect(path).toContain("/approvals/ar-1/decide")
      expect(body.decision).toBe("deny")
      expect(body.reason).toMatch(/outcome/)
    })
  })

  it("Cancel reverts edits to entry-time snapshot without calling the API", async () => {
    handleWsCreate(baseRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-edit"))
    setMarkdown(await screen.findByTestId("approval-card-field-textBody"), "edited body")
    fireEvent.click(screen.getByTestId("approval-card-action-cancel"))
    await waitFor(() =>
      expect(screen.queryByTestId("approval-card-action-edit")).toBeInTheDocument(),
    )
    expect(apiMocks.post).not.toHaveBeenCalled()
  })

  it("Save is disabled when widget values match the entry-time snapshot", async () => {
    handleWsCreate(baseRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-edit"))
    const save = (await screen.findByTestId("approval-card-action-save")) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    setMarkdown(await screen.findByTestId("approval-card-field-textBody"), "new body")
    await waitFor(() =>
      expect((screen.getByTestId("approval-card-action-save") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    )
  })

  it("Save submits only changed editable fields", async () => {
    apiMocks.post.mockResolvedValue({ id: "ar-1", currentPayload: {}, lastEdit: null })
    handleWsCreate(
      baseRow({
        editableFields: [
          { field: "subject", label: "Subject", widget: "text" },
          { field: "textBody", label: "Body", widget: "richtext" },
        ],
        currentPayload: {
          conversationId: "locked-conversation",
          subject: "Original subject",
          textBody: "original",
        },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-edit"))
    setMarkdown(await screen.findByTestId("approval-card-field-textBody"), "edited body")
    fireEvent.click(screen.getByTestId("approval-card-action-save"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("/approvals/ar-1/payload", {
        fields: { textBody: "edited body" },
      }),
    )
  })

  // A customer email body is edited with the editor of the surface it writes
  // to (formatting shows as formatting), and the card saves its markdown.
  it("edits a ticket reply with the shared editor and saves its markdown", async () => {
    currentScope = ["tickets:approve"]
    apiMocks.post.mockResolvedValue({ id: "ar-1", currentPayload: {}, lastEdit: null })
    handleWsCreate(
      baseRow({
        toolName: "tickets:reply",
        currentPayload: { ticketId: "t-1", textBody: "Bonjour" },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-edit"))
    const field = await screen.findByTestId("approval-card-field-textBody")
    expect(field.tagName).not.toBe("TEXTAREA")
    expect(field.getAttribute("contenteditable")).toBe("true")
    setMarkdown(field, "Bonjour **Anna**")
    fireEvent.click(screen.getByTestId("approval-card-action-save"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("/approvals/ar-1/payload", {
        fields: { textBody: "Bonjour **Anna**" },
      }),
    )
  })

  it("opens Edit on an agent drafted ticket reply prefilled with the proposed draft", async () => {
    currentScope = ["tickets:approve"]
    handleWsCreate(
      baseRow({
        toolName: "tickets:reply",
        currentPayload: {
          ticketId: "t-1",
          textBody: [
            "Hello Damian,",
            "",
            "What you are observing is expected behavior: the controller registers the initial touch.",
            "",
            "1. **Map via Tessera Lab / MIDI Learn inside Fernwave carefully:**",
            "   - Place your finger at the top edge and move strictly vertically.",
            "   - Alternatively, temporarily assign different CC numbers to the X and Y axes.",
            "",
            "2. **Check your USB MIDI Port selection in Fernwave:**",
            "   - Ensure Fernwave is receiving from `Tessera 2 MIDI` (Cable 0). ",
            "",
            "Best regards,",
            "Fabrikam Support",
          ].join("\n"),
        },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-edit"))
    const field = await screen.findByTestId("approval-card-field-textBody")
    await waitFor(() => expect(field.textContent).toContain("What you are observing"))
    expect(field.textContent).toContain("Tessera 2 MIDI")
    expect(field.textContent).toContain("Fabrikam Support")
  })

  it("opens Edit prefilled when the drafted reply carries only an htmlBody", async () => {
    currentScope = ["tickets:approve"]
    handleWsCreate(
      baseRow({
        toolName: "tickets:reply",
        editableFields: [
          { field: "textBody", label: "Body", widget: "richtext", invalidates: ["htmlBody"] },
        ],
        currentPayload: {
          ticketId: "t-1",
          htmlBody: "<p>Hi Greg,</p><p>The looper only snaps note starts at record time.</p>",
        },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-edit"))
    const field = await screen.findByTestId("approval-card-field-textBody")
    await waitFor(() => expect(field.textContent).toContain("Hi Greg,"))
    expect(field.textContent).toContain("snaps note starts at record time")
    // Opening Edit alone is not an edit.
    expect((screen.getByTestId("approval-card-action-save") as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it("keeps a plain textarea for a body that is not a customer email", async () => {
    currentScope = ["tickets:approve"]
    handleWsCreate(
      baseRow({
        toolName: "tickets:editNote",
        editableFields: [{ field: "text", label: "Note text", widget: "richtext" }],
        currentPayload: { noteId: "n-1", text: "note" },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-edit"))
    expect((await screen.findByTestId("approval-card-field-text")).tagName).toBe("TEXTAREA")
  })

  // iPhone walk 2026-10-19: a reply drafted for a customer rendered as grey text
  // on a white sheet in dark mode (and a tall empty white scroll zone on the
  // desktop). The body renders like every other message, in the app's theme.
  it("renders a customer email body as markdown in the app theme, not a white email sheet", async () => {
    handleWsCreate(
      baseRow({
        toolName: "tickets:reply",
        currentPayload: { ticketId: "t-1", textBody: "Merci **beaucoup**\n\n- un\n- deux" },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    const body = await screen.findByTestId("approval-card-message-body")
    await waitFor(() => expect(body.querySelector("strong")?.textContent).toBe("beaucoup"))
    expect(body.querySelectorAll("li")).toHaveLength(2)
    expect(body.querySelector("iframe")).toBeNull()
    expect(screen.queryByTestId("approval-card-email-preview")).toBeNull()
    expect(body.textContent).not.toContain("**")
  })

  // A draft's HTML is written by an agent, so it must not share a document with
  // the approve / reject buttons: its <style> and the app's utility classes
  // would restyle or overlay them. The card shows the markdown body only.
  it("never puts a draft's own HTML into the card's document", async () => {
    handleWsCreate(
      baseRow({
        toolName: "mail:compose",
        currentPayload: {
          to: ["a@example.com"],
          textBody: "Bonjour",
          htmlBody:
            '<style>[data-testid="approval-card-action-approve"]{display:none}</style><div class="fixed inset-0 z-50">cover</div><img src="https://evil.example/p.png">',
        },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    const body = await screen.findByTestId("approval-card-message-body")
    await waitFor(() => expect(body).toHaveTextContent("Bonjour"))
    expect(document.querySelector(".fixed.inset-0")).toBeNull()
    expect(document.body.innerHTML).not.toContain("evil.example")
    expect(document.body.textContent).not.toContain("display:none")
  })

  it("lists a customer email's HTML part once, as the message", async () => {
    handleWsCreate(
      baseRow({
        toolName: "tickets:reply",
        currentPayload: { ticketId: "t-1", textBody: "Bonjour", htmlBody: "<p>Bonjour</p>" },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    await screen.findByTestId("approval-card-message-body")
    expect(screen.queryByTestId("approval-payload-value-htmlBody")).toBeNull()
    expect(screen.getByTestId("approval-payload-value-ticketId")).toHaveTextContent("t-1")
  })

  // The summary line named the attachments; the exact payload printed their raw
  // ids. The payload shows the names too, with the id kept on the value for audit,
  // and the stored payload is left as it was.
  it("names the attached files in the exact payload, keeping each id as its tooltip", async () => {
    const pdf = "0f3c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f"
    const hidden = "7d6c5b4a-3f2e-4d1c-9b8a-7f6e5d4c3b2a"
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path === `/files/${pdf}/metadata`) return { id: pdf, filename: "rma-label.pdf" }
      if (path === `/files/${hidden}/metadata`) throw new Error("Not found")
      return undefined
    })
    const payload = { ticketId: "t-1", textBody: "Label attached.", attachments: [pdf, hidden] }
    handleWsCreate(baseRow({ toolName: "tickets:reply", currentPayload: payload }), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    await screen.findByTestId("approval-card-payload")
    const named = screen.getByTestId("approval-payload-value-attachments[0]")
    await waitFor(() => expect(named).toHaveTextContent("rma-label.pdf"))
    expect(named).not.toHaveTextContent(pdf)
    expect(named.getAttribute("title")).toBe(pdf)
    expect(named.getAttribute("data-file-id")).toBe(pdf)
    // A file the reviewer cannot read keeps its id, with nothing to claim.
    const unnamed = screen.getByTestId("approval-payload-value-attachments[1]")
    expect(unnamed).toHaveTextContent(hidden)
    expect(unnamed.getAttribute("data-file-id")).toBeNull()
    expect(apiMocks.get).toHaveBeenCalledWith(`/files/${pdf}/metadata`, {
      suppressGlobalError: true,
    })
    expect(payload.attachments).toEqual([pdf, hidden])
  })

  it("Save errors keep edit mode open and show a toast", async () => {
    const { ApiError } = await import("~/lib/api-error")
    apiMocks.post.mockRejectedValue(new ApiError("invalid", 400, "invalid_edit"))
    handleWsCreate(baseRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-edit"))
    setMarkdown(await screen.findByTestId("approval-card-field-textBody"), "bad edit")
    fireEvent.click(screen.getByTestId("approval-card-action-save"))
    await waitFor(() => expect(toastMock).toHaveBeenCalled())
    expect(screen.getByTestId("approval-card-action-save")).toBeInTheDocument()
  })

  it("Deny submits the reason when the operator fills it in", async () => {
    apiMocks.post.mockResolvedValue({ id: "ar-1", status: "denied" })
    currentScope = []
    currentUserId = "u-requester"
    handleWsCreate(
      baseRow({
        requestedBy: { id: "u-requester" },
        requester: { kind: "user", id: "u-requester", name: "Me" },
      }),
      "u-requester",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-deny"))
    const reasonInput = (await screen.findByTestId("approval-card-deny-reason")) as HTMLInputElement
    fireEvent.input(reasonInput, { target: { value: "no thanks" } })
    const submit = await screen.findByText("Submit")
    fireEvent.click(submit)
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        "/approvals/ar-1/decide",
        { decision: "deny", reason: "no thanks" },
        { suppressGlobalError: true },
      ),
    )
  })

  it("Deny submits with an empty reason (reason is optional)", async () => {
    apiMocks.post.mockResolvedValue({ id: "ar-1", status: "denied" })
    currentScope = []
    currentUserId = "u-requester"
    handleWsCreate(
      baseRow({
        requestedBy: { id: "u-requester" },
        requester: { kind: "user", id: "u-requester", name: "Me" },
      }),
      "u-requester",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-deny"))
    // Do not fill the reason input; submit straight away.
    const submit = await screen.findByText("Submit")
    fireEvent.click(submit)
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        "/approvals/ar-1/decide",
        { decision: "deny", reason: "" },
        { suppressGlobalError: true },
      ),
    )
  })

  it("renders cold-load 404 inline error when the request cannot be loaded", async () => {
    const { ApiError } = await import("~/lib/api-error")
    apiMocks.get.mockRejectedValue(new ApiError("not found", 404, "not_found"))
    render(() => <ApprovalCard requestId="ar-cold" />)
    expect(await screen.findByTestId("approval-card-error")).toHaveTextContent(
      "Approval request no longer exists.",
    )
  })

  describe("sub-run breadcrumb (T14)", () => {
    it("shows the breadcrumb when metadata.runId + metadata.parentRunId are set", async () => {
      handleWsCreate(
        baseRow({
          metadata: {
            runId: "r-sub-1",
            parentRunId: "r-root-0",
            subagentType: "ticket-investigator",
            label: "JIRA-1234",
            hiddenThreadId: "t-hidden-1",
          },
        }),
        "u-approver",
      )
      render(() => <ApprovalCard requestId="ar-1" />)
      const crumb = await screen.findByTestId("approval-card-subrun-breadcrumb")
      expect(crumb).toBeInTheDocument()
      expect(crumb.textContent ?? "").toContain("ticket-investigator")
      expect(crumb.textContent ?? "").toContain("JIRA-1234")
      // M8 fix — the deep-link points at the existing /threads/:id route
      // pointed at the sub-run's hidden thread, since no /runs/:id SPA route
      // exists. When `hiddenThreadId` is absent the breadcrumb shows a
      // "(transcript unavailable)" hint instead of a broken link.
      const link = screen.getByTestId("approval-card-subrun-link")
      expect((link as HTMLAnchorElement).getAttribute("href")).toBe("#/threads/t-hidden-1")
    })

    it("renders the missing-transcript hint when hiddenThreadId is absent", async () => {
      handleWsCreate(
        baseRow({
          metadata: {
            runId: "r-sub-2",
            parentRunId: "r-root-0",
            subagentType: "ticket-investigator",
            label: "JIRA-9999",
          },
        }),
        "u-approver",
      )
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-subrun-breadcrumb")
      expect(screen.queryByTestId("approval-card-subrun-link")).toBeNull()
      expect(screen.getByTestId("approval-card-subrun-link-missing")).toBeInTheDocument()
    })

    it("shows the breadcrumb for a sub-run a chat turn spawned (no parent run)", async () => {
      handleWsCreate(
        baseRow({
          metadata: {
            runId: "r-sub-3",
            parentRunId: null,
            subagentType: "researcher",
            label: "dealers",
            hiddenThreadId: "t-hidden-3",
          },
        }),
        "u-approver",
      )
      render(() => <ApprovalCard requestId="ar-1" />)
      const crumb = await screen.findByTestId("approval-card-subrun-breadcrumb")
      expect(crumb.textContent ?? "").toContain("researcher")
      const link = screen.getByTestId("approval-card-subrun-link")
      expect((link as HTMLAnchorElement).getAttribute("href")).toBe("#/threads/t-hidden-3")
    })

    it("does NOT show the breadcrumb when metadata is absent", async () => {
      handleWsCreate(baseRow(), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      // The approve button should be present (smoke check that the card rendered).
      await screen.findByTestId("approval-card-action-approve")
      expect(screen.queryByTestId("approval-card-subrun-breadcrumb")).toBeNull()
    })
  })

  describe("manifest defaults on the payload (A47b)", () => {
    it("marks the paths the tool schema supplied and leaves the rest unmarked", async () => {
      handleWsCreate(
        baseRow({
          currentPayload: { ticketId: "t-1", textBody: "original", notify: true },
          metadata: { defaultedParams: ["notify"] },
        }),
        "u-approver",
      )
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-payload")

      expect(screen.getByTestId("approval-payload-default-notify")).toHaveTextContent("(default)")
      expect(screen.queryByTestId("approval-payload-default-ticketId")).toBeNull()
      expect(screen.queryByTestId("approval-payload-default-textBody")).toBeNull()
    })

    it("marks nothing when no path was defaulted", async () => {
      handleWsCreate(baseRow({ currentPayload: { ticketId: "t-1", notify: true } }), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-payload")

      expect(screen.queryByTestId("approval-payload-default-notify")).toBeNull()
    })
  })

  describe("payload value expand/collapse", () => {
    // `note` rather than `textBody`: the message body is rendered ONCE, in the
    // Message block above, and is deliberately absent from this list.
    it("renders no Show more control for a short payload field", async () => {
      handleWsCreate(baseRow({ currentPayload: { note: "short reply body" } }), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-payload")
      expect(screen.getByTestId("approval-payload-value-note")).toHaveTextContent(
        "short reply body",
      )
      expect(screen.queryByTestId("approval-payload-toggle-note")).toBeNull()
    })

    it("truncates a payload field over 300 chars and reveals the full value on Show more", async () => {
      const long = "x".repeat(500)
      handleWsCreate(baseRow({ currentPayload: { note: long } }), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-payload")

      const valueEl = screen.getByTestId("approval-payload-value-note")
      // Preview is capped, not the full 500-char value.
      expect(valueEl.textContent?.length).toBeLessThan(long.length)
      expect(valueEl.textContent).toContain("...")

      const toggle = screen.getByTestId("approval-payload-toggle-note")
      expect(toggle).toHaveTextContent("Show more")

      fireEvent.click(toggle)

      const expandedEl = screen.getByTestId("approval-payload-value-note")
      expect(expandedEl.textContent).toBe(long)
      expect(screen.getByTestId("approval-payload-toggle-note")).toHaveTextContent("Show less")
    })

    it("expands only the targeted field, leaving other long fields collapsed", async () => {
      const longA = "a".repeat(400)
      const longB = "b".repeat(400)
      handleWsCreate(
        baseRow({
          editableFields: [],
          currentPayload: { fieldA: longA, fieldB: longB },
        }),
        "u-approver",
      )
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-payload")

      fireEvent.click(screen.getByTestId("approval-payload-toggle-fieldA"))

      expect(screen.getByTestId("approval-payload-value-fieldA").textContent).toBe(longA)
      expect(screen.getByTestId("approval-payload-value-fieldB").textContent).not.toBe(longB)
      expect(screen.getByTestId("approval-payload-toggle-fieldB")).toHaveTextContent("Show more")
    })
  })

  describe("full message block", () => {
    // jsdom lays nothing out, so the message block's heights are stubbed: the
    // toggle's whole rule is "does the content outgrow the clamped box", and a
    // test that cannot set those two numbers cannot state the rule. The box is
    // clamped to a number of LINES now, so this is the height those lines come
    // to, not a ceiling written into the class.
    const MESSAGE_BOX_PX = 320
    let contentPx = 0
    beforeEach(() => {
      contentPx = 0
      for (const [prop, read] of [
        ["scrollHeight", (el: HTMLElement) => (isMessageBody(el) ? contentPx : 0)],
        [
          "clientHeight",
          (el: HTMLElement) =>
            isMessageBody(el)
              ? el.dataset.expanded === "true"
                ? contentPx
                : Math.min(contentPx, MESSAGE_BOX_PX)
              : 0,
        ],
      ] as const) {
        Object.defineProperty(HTMLElement.prototype, prop, {
          configurable: true,
          get(this: HTMLElement) {
            return read(this)
          },
        })
      }
    })
    afterEach(() => {
      for (const prop of ["scrollHeight", "clientHeight"]) {
        Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, value: 0 })
      }
    })
    const isMessageBody = (el: HTMLElement): boolean =>
      el.dataset?.testid === "approval-card-message-body"
    const messageText = (body: HTMLElement): string => (body.textContent ?? "").replace(/\s+/g, " ")

    it("surfaces the complete outgoing message in a box clamped to whole lines", async () => {
      const long = `Hi Dieter, ${"detail ".repeat(200)}Best, Fabrikam Team`
      handleWsCreate(baseRow({ currentPayload: { ticketId: "t-1", textBody: long } }), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-message")

      // The whole message is there, clamped to a line count rather than to a
      // pixel height: a pixel ceiling sliced the last line through the middle.
      const body = screen.getByTestId("approval-card-message-body")
      expect(messageText(body)).toContain("Best, Fabrikam Team")
      expect(body.className).toMatch(/\bline-clamp-\d+\b/)
      expect(body.className).not.toMatch(/max-h-\[/)
      expect(body.className).not.toContain("break-all")
    })

    // F6. The clamp cut mid line and offered no way to read the rest: a
    // reviewer could not see what they were approving.
    it("offers Show more on a long message, and Show less once expanded", async () => {
      const long = `Hi Dieter, ${"detail ".repeat(200)}Best, Fabrikam Team`
      contentPx = 1400
      handleWsCreate(baseRow({ currentPayload: { ticketId: "t-1", textBody: long } }), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-message")

      const body = screen.getByTestId("approval-card-message-body")
      expect(body.dataset.expanded).toBe("false")
      expect(body.className).toMatch(/\bline-clamp-\d+\b/)

      const toggle = screen.getByTestId("approval-card-message-toggle")
      expect(toggle).toHaveTextContent("Show more")

      fireEvent.click(toggle)

      expect(screen.getByTestId("approval-card-message-body").dataset.expanded).toBe("true")
      expect(screen.getByTestId("approval-card-message-body").className).not.toMatch(
        /\bline-clamp-\d+\b/,
      )
      expect(screen.getByTestId("approval-card-message-toggle")).toHaveTextContent("Show less")

      fireEvent.click(screen.getByTestId("approval-card-message-toggle"))
      expect(screen.getByTestId("approval-card-message-body").dataset.expanded).toBe("false")
    })

    it("offers no toggle on a message that fits", async () => {
      contentPx = 90
      handleWsCreate(
        baseRow({ currentPayload: { ticketId: "t-1", textBody: "Hi Dieter, all set. Best." } }),
        "u-approver",
      )
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-message")
      expect(screen.queryByTestId("approval-card-message-toggle")).not.toBeInTheDocument()
    })

    // A 542 character message, comfortably under the old 600 character rule,
    // broken every few words: it overflowed the 320px box, was cut mid word,
    // and offered NO toggle at all, because the rule counted characters
    // instead of asking the box.
    it("offers Show more on a short message that is TALL", async () => {
      const shortButTall = Array.from({ length: 26 }, (_, i) => `Line ${i} of note.`).join("\n")
      expect(shortButTall.length).toBeLessThan(600)
      contentPx = 880
      handleWsCreate(
        baseRow({ currentPayload: { ticketId: "t-1", textBody: shortButTall } }),
        "u-approver",
      )
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-message")

      const toggle = await screen.findByTestId("approval-card-message-toggle")
      expect(toggle).toHaveTextContent("Show more")
      fireEvent.click(toggle)
      expect(screen.getByTestId("approval-card-message-body").dataset.expanded).toBe("true")
      // Still offered once expanded, or there is no way back to the clamp.
      expect(screen.getByTestId("approval-card-message-toggle")).toHaveTextContent("Show less")
    })

    // The mirror image: a long single-paragraph message that FITS must not
    // offer a toggle just because it passed a character count.
    it("offers no toggle on a long message that fits the box", async () => {
      const long = `Hi Dieter, ${"detail ".repeat(200)}Best, Fabrikam Team`
      expect(long.length).toBeGreaterThan(600)
      contentPx = 210
      handleWsCreate(baseRow({ currentPayload: { ticketId: "t-1", textBody: long } }), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-message")
      await Promise.resolve()
      expect(screen.queryByTestId("approval-card-message-toggle")).not.toBeInTheDocument()
    })

    it("renders the body as markdown, not as its source", async () => {
      handleWsCreate(
        baseRow({
          currentPayload: {
            ticketId: "t-1",
            textBody: "## Tone\n\nBe **direct** with the customer.",
          },
        }),
        "u-approver",
      )
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-message")
      const body = screen.getByTestId("approval-card-message-body")
      await waitFor(() => expect(body.querySelector("strong")?.textContent).toBe("direct"))
      expect(messageText(body)).not.toContain("**direct**")
      expect(messageText(body)).not.toContain("## Tone")
    })

    it("shows a short message in full", async () => {
      handleWsCreate(
        baseRow({ currentPayload: { ticketId: "t-1", textBody: "Hi Dieter, all set. Best." } }),
        "u-approver",
      )
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-message")
      expect(messageText(screen.getByTestId("approval-card-message-body"))).toContain(
        "Hi Dieter, all set. Best.",
      )
    })

    // The kernel:update_skill card printed the whole playbook twice, once under
    // MESSAGE and again under EXACT PAYLOAD: two full screens of the same text
    // on a phone. The field is shown once, where it is readable.
    it("does not repeat the message body in the exact payload list", async () => {
      const body = "Answer in the customer's own language, always."
      handleWsCreate(baseRow({ currentPayload: { ticketId: "t-1", textBody: body } }), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-payload")
      expect(screen.queryByTestId("approval-payload-value-textBody")).toBeNull()
      // Every other field is still listed.
      expect(screen.getByTestId("approval-payload-value-ticketId")).toHaveTextContent("t-1")
      // Shown once, in the message block.
      const shown = screen.getByTestId("approval-card-message-body")
      await waitFor(() => expect(messageText(shown)).toContain(body))
      expect(screen.queryAllByText(body).filter((el) => !shown.contains(el))).toHaveLength(0)
    })

    // The message is the field Edit writes. A payload carrying its text under a
    // key the tool does not read (`body` on a reply whose editable message is
    // `textBody`) showed that text as MESSAGE; an edit then wrote `textBody`, and
    // the card showed the new MESSAGE above an exact payload still holding the
    // old `body`. The stray key is listed in the exact payload, never as the message.
    it("shows the editable message field as the message, never another body key", async () => {
      handleWsCreate(
        baseRow({ currentPayload: { ticketId: "t-1", body: "stale text the tool never reads" } }),
        "u-approver",
      )
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-payload")
      expect(screen.queryByTestId("approval-card-message")).toBeNull()
      expect(screen.getByTestId("approval-payload-value-body")).toHaveTextContent(
        "stale text the tool never reads",
      )

      handleWsUpdate(
        baseRow({
          currentPayload: {
            ticketId: "t-1",
            body: "stale text the tool never reads",
            textBody: "edited",
          },
          payloadHash: "after-edit",
        }),
      )
      await waitFor(() =>
        expect(messageText(screen.getByTestId("approval-card-message-body"))).toContain("edited"),
      )
      expect(screen.queryByTestId("approval-payload-value-textBody")).toBeNull()
    })

    it("falls back to a body key when no editable field names the message", async () => {
      handleWsCreate(
        baseRow({ editableFields: [], currentPayload: { ticketId: "t-1", body: "the only body" } }),
        "u-approver",
      )
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-message")
      expect(messageText(screen.getByTestId("approval-card-message-body"))).toContain(
        "the only body",
      )
      expect(screen.queryByTestId("approval-payload-value-body")).toBeNull()
    })

    it("renders no message block for an approval with no message body", async () => {
      handleWsCreate(baseRow({ currentPayload: { orderId: "1234", refund: true } }), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-payload")
      expect(screen.queryByTestId("approval-card-message")).toBeNull()
    })

    it("prints a summary line's markup as text: an MCP tool's argument text never becomes HTML or markdown", async () => {
      const line =
        'Properties › Note body: <img src=x onerror="alert(1)"> # Approve now [click](javascript:alert(1)) **bold**'
      handleWsCreate(
        baseRow({
          toolName: "mcp:crm:manage_crm_objects",
          summary: {
            kind: "crm:manage_crm_objects",
            title: "Acme CRM · Manage CRM objects",
            lines: [line],
          },
          currentPayload: { createRequest: { objects: [{ properties: { note_body: "x" } }] } },
        }),
        "u-approver",
      )
      const { container } = render(() => <ApprovalCard requestId="ar-1" />)
      expect(await screen.findByText(line)).toBeInTheDocument()
      expect(screen.getByText("Acme CRM · Manage CRM objects")).toBeInTheDocument()
      expect(container.querySelector("img")).toBeNull()
      expect(container.querySelector('a[href^="javascript"]')).toBeNull()
      expect(container.querySelector("strong, h1")).toBeNull()
    })

    it("drops a summary line that duplicates the (possibly clipped) message body, but keeps metadata lines", async () => {
      // Mirrors a real tickets.reply summary: a clipped body-preview line (as a
      // summarizer's `clip(preview, 220)` would push, sometimes stripped of its
      // trailing ellipsis by the shared truncateApprovalSummary 200-char re-slice)
      // sitting alongside a genuine metadata line. The card must render the full
      // Message block, DROP the duplicated/cropped preview, and KEEP the metadata.
      const fullBody =
        "Hello Dieter, thanks for reaching out. Your order has shipped and should arrive automatically within 3 to 5 business days. Let us know if you have any other questions!"
      const clippedNoEllipsis = fullBody.slice(0, 80) // well past the 60-char threshold, no ellipsis: covers truncateApprovalSummary stripping it
      const clippedWithEllipsis = `${fullBody.slice(0, 40)}…`
      handleWsCreate(
        baseRow({
          summary: {
            kind: "tickets.reply",
            title: "Re: Test",
            lines: ["Last message: 2026-07-07 11:55", clippedNoEllipsis, clippedWithEllipsis],
          },
          currentPayload: { ticketId: "t-1", textBody: fullBody },
        }),
        "u-approver",
      )
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-message")

      expect(
        screen.getByText(`Last message: ${formatDateTime("2026-07-07T11:55:00Z", "en")}`),
      ).toBeInTheDocument()
      expect(screen.queryByText(clippedNoEllipsis)).toBeNull()
      expect(screen.queryByText(clippedWithEllipsis)).toBeNull()
      // The full body appears exactly once, inside the Message block.
      expect(messageText(screen.getByTestId("approval-card-message-body"))).toContain(fullBody)
    })
  })

  describe("no discussion thread", () => {
    // Approval discussion threads are gone: to talk about an approval you paste
    // its URL into the DM or thread where that conversation belongs. The card
    // must offer no control that opens or creates one.
    it("renders no Discuss control on a pending approval", async () => {
      handleWsCreate(baseRow(), "u-approver")
      render(() => <ApprovalCard requestId="ar-1" />)
      await screen.findByTestId("approval-card-provenance")
      expect(screen.queryByTestId("approval-card-discuss")).toBeNull()
      expect(apiMocks.post).not.toHaveBeenCalledWith("/approvals/ar-1/thread", {})
    })
  })
})

// The 2026-08-06 regression, card-side: a dimension-constrained approval
// (approveScope = kernel:skills:approve) rendered WITHOUT Approve/Deny for the
// people actually holding that scope, because the card recomputed
// `<app>:approve` (= admin-grade kernel:approve) from the tool name. Decide
// eligibility now comes from the shared authority module over the row's own
// persisted approveScope.
describe("ApprovalCard custom deciding scope", () => {
  const skillRow = (over: Partial<any> = {}): any =>
    baseRow({
      id: "ar-skill",
      toolName: "kernel:update_skill",
      approveScope: "kernel:skills:approve",
      summary: { kind: "update_skill", title: "Update skill", lines: [] },
      editableFields: [],
      notifyUserIds: ["u-approver", "u-requester"],
      ...over,
    })

  it("renders Approve/Deny for a notified kernel:skills:approve holder (no kernel:approve)", async () => {
    currentScope = ["kernel:skills:approve"]
    handleWsCreate(skillRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-skill" />)
    expect(await screen.findByTestId("approval-card-action-approve")).toBeInTheDocument()
    expect(screen.getByTestId("approval-card-action-deny")).toBeInTheDocument()
  })

  it("does NOT render Approve for a holder of only admin-grade kernel:approve", async () => {
    currentScope = ["kernel:approve"]
    handleWsCreate(skillRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-skill" />)
    await screen.findByTestId("approval-card-title")
    expect(screen.queryByTestId("approval-card-action-approve")).toBeNull()
  })

  it("shows the governing scope in the provenance strip", async () => {
    currentScope = ["kernel:skills:approve"]
    handleWsCreate(skillRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-skill" />)
    const chip = await screen.findByTestId("approval-card-scope")
    // The chip reads as words; the raw scope stays on it for whoever needs it.
    expect(chip.textContent).toBe("needs Workspace approval")
    expect(chip.getAttribute("data-scope")).toBe("kernel:skills:approve")
  })
})

describe("ApprovalCard provenance strip", () => {
  it("shows N-eyes sign-off progress while pending under a minApprovers policy", async () => {
    handleWsCreate(
      baseRow({ metadata: { minApprovers: 2, approvedBy: ["u-someone"] } }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    const chip = await screen.findByTestId("approval-card-neyes")
    expect(chip.textContent).toContain("1 of 2 sign-offs")
  })

  it("shows the private-routing badge instead of a scope chip on owner-routed rows", async () => {
    currentUserId = "u-owner"
    currentScope = []
    handleWsCreate(baseRow({ resourceOwnerId: "u-owner", notifyUserIds: ["u-owner"] }), "u-owner")
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("approval-card-private-badge")).toBeInTheDocument()
    expect(screen.queryByTestId("approval-card-scope")).toBeNull()
    // The owner can decide their own draft without any approve scope.
    expect(screen.getByTestId("approval-card-action-approve")).toBeInTheDocument()
  })

  it("names the decider on a decided row", async () => {
    handleWsCreate(
      baseRow({
        status: "approved",
        decidedBy: "u-boss",
        decidedByName: "Alice",
        decidedAt: "2026-04-30T12:30:00.000Z",
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    const line = await screen.findByTestId("approval-card-decided-by")
    expect(line.textContent).toContain("Approved by Alice")
  })

  it("says the viewer approved it when the viewer is the decider", async () => {
    // A requester approving their own card read "Approved by a teammate".
    currentUserId = "u-self"
    handleWsCreate(
      baseRow({
        status: "approved",
        decidedBy: "u-self",
        decidedByName: null,
        decidedAt: "2026-04-30T12:30:00.000Z",
      }),
      "u-self",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    const line = await screen.findByTestId("approval-card-decided-by")
    expect(line.textContent).toContain("Approved by you")
    expect(line.textContent).not.toContain("teammate")
  })
})

describe("ApprovalCard - who asked", () => {
  // The card names `requester`, the one answer the server resolves: the role
  // agent whose turn raised the request, else the person. It never prints
  // `requestedBy`, the accountable human: a ticket draft the @support routine
  // wrote read "Requested by Avery" because the card did.
  it("names the agent that asked, and not the accountable human", async () => {
    handleWsCreate(
      baseRow({
        requestedBy: { id: "u-requester" },
        requester: { kind: "agent", id: "a-support", name: "Support" },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    const provenance = await screen.findByTestId("approval-card-provenance")
    expect(provenance).toHaveTextContent("Requested by Support")
    expect(provenance).not.toHaveTextContent("Bob")
    expect(provenance).not.toHaveTextContent("via")
  })

  it("names the person when a person asked", async () => {
    handleWsCreate(baseRow(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    const provenance = await screen.findByTestId("approval-card-provenance")
    expect(provenance).toHaveTextContent("Requested by Bob")
  })
})

describe("ApprovalCard - a row with no summary", () => {
  // `kernel.approval_requests.summary` is nullable, and a row inserted outside
  // the summarizer (fixture, import, older gated tool) arrives with
  // `summary: null`. The card used to dereference `summary.lines` and
  // `summary.title` straight off the row, so ONE such row took the entire tab
  // down with "Cannot read properties of undefined (reading 'length')" and
  // every other pending decision with it.
  it("renders the decision instead of throwing when summary is null", async () => {
    handleWsCreate(baseRow({ summary: null }), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    const title = await screen.findByTestId("approval-card-title")
    // Never the raw tool id (iPhone walk 2026-10-19: "tickets:reply" headed a card).
    expect(title.textContent).not.toContain("mail:reply")
    expect(title).toHaveTextContent(/^Mail/)
    expect(await screen.findByTestId("approval-card-action-approve")).toBeInTheDocument()
  })

  it("renders a bundle step whose summary carries a title but no lines", async () => {
    handleWsCreate(
      baseRow({
        bundleId: "b-1",
        bundlePosition: 0,
        summary: { kind: "mail.reply", title: "Head" },
      }),
      "u-approver",
    )
    handleWsCreate(
      baseRow({
        id: "ar-2",
        handle: "request-0002",
        bundleId: "b-1",
        bundlePosition: 1,
        status: "deferred",
        summary: { kind: "tickets.reply", title: "Step one" },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    const step = await screen.findByTestId("approval-bundle-step-1")
    expect(step).toHaveTextContent("Step one")
  })
})

// QA APR-02: a ticket reclassified while its pending approval card is open on
// /approvals kept the old ref chip (still ticket-B2B-1 after 45 s) until a
// reload, while the Home row for the same approval followed live. Home follows
// because every ticket event reloads the attention feed; the card now follows
// the same event, re-reading the pending approvals of that ticket.
describe("ApprovalCard follows its ticket live", () => {
  it("re-reads the ref chip when the ticket it acts on changes", async () => {
    const { setAttentionApi } = await import("~/modules/shell/attention-store")
    const { handleTicketEvent } = await import("~/modules/tickets/ticket-detail-store")
    currentScope = ["tickets:approve"]
    const row = (ref: string) =>
      baseRow({
        id: "ar-live",
        toolName: "tickets:reply",
        currentPayload: { ticketId: "tk-live", textBody: "Bonjour" },
        summary: { kind: "tickets.reply", ref, title: "Facturation partenaire", lines: [] },
      })
    handleWsCreate(row("ticket-B2B-1"), "u-approver")
    apiMocks.get.mockImplementation(async (path: string) =>
      path === "/approvals/ar-live" ? row("ticket-B2C-1") : { data: [] },
    )
    setAttentionApi(apiMocks as never)
    render(() => <ApprovalCard requestId="ar-live" />)
    expect(await screen.findByTestId("approval-card-ref")).toHaveTextContent("ticket-B2B-1")

    handleTicketEvent("update", { id: "tk-live", changes: { audience: "b2c" } })

    await waitFor(() =>
      expect(screen.getByTestId("approval-card-ref")).toHaveTextContent("ticket-B2C-1"),
    )
    expect(apiMocks.get).toHaveBeenCalledWith("/approvals/ar-live")
  })

  it("leaves a card about another ticket alone", async () => {
    const { setAttentionApi } = await import("~/modules/shell/attention-store")
    const { handleTicketEvent } = await import("~/modules/tickets/ticket-detail-store")
    currentScope = ["tickets:approve"]
    handleWsCreate(
      baseRow({
        id: "ar-other",
        toolName: "tickets:reply",
        currentPayload: { ticketId: "tk-other" },
        summary: { kind: "tickets.reply", ref: "ticket-B2B-2", title: "Autre", lines: [] },
      }),
      "u-approver",
    )
    apiMocks.get.mockImplementation(async () => ({ data: [] }))
    setAttentionApi(apiMocks as never)
    handleTicketEvent("update", { id: "tk-live", changes: { audience: "b2c" } })
    await new Promise((r) => setTimeout(r, 50))
    expect(apiMocks.get).not.toHaveBeenCalledWith("/approvals/ar-other")
  })
})

// The curated summary said what approving does, yet the raw field dump sat open under it
// ("id: f620184e-...", "lines[0].unit_price_minor: 200"). With a summary it is closed behind
// "Technical details" (still there: it is the record of what runs); without one it stays open.
describe("ApprovalCard exact payload behind Technical details", () => {
  it("closes the payload behind Technical details when the app wrote a summary", async () => {
    currentScope = ["invoicing:approve"]
    handleWsCreate(
      baseRow({
        toolName: "invoicing:documents_update",
        summary: {
          kind: "document_update",
          title: "Change proforma PRO-2026-0029 (Thomas Raz) total from 0.00 USD to 1.00 USD",
          lines: ["Total: 0.00 USD -> 1.00 USD"],
        },
        editableFields: [],
        currentPayload: {
          id: "f620184e-1c7a-4d2b-9a51-3f0d2a9b7c11",
          lines: [{ unit_price_minor: 200 }],
        },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    const payload = await screen.findByTestId("approval-card-payload")
    expect(payload.tagName).toBe("DETAILS")
    expect((payload as HTMLDetailsElement).open).toBe(false)
    expect(payload.querySelector("summary")?.textContent).toBe("Technical details")
    // Kept, one click away.
    expect(payload).toHaveTextContent("f620184e-1c7a-4d2b-9a51-3f0d2a9b7c11")
  })

  it("keeps the payload open when the card has no summary lines", async () => {
    currentScope = ["invoicing:approve"]
    handleWsCreate(
      baseRow({
        toolName: "invoicing:documents_update",
        summary: { kind: "documents_update", title: "invoicing:documents_update", lines: [] },
        editableFields: [],
        currentPayload: { id: "f620184e-1c7a-4d2b-9a51-3f0d2a9b7c11" },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    const payload = await screen.findByTestId("approval-card-payload")
    expect((payload as HTMLDetailsElement).open).toBe(true)
    expect(payload.querySelector("summary")?.textContent).toBe("Exact payload")
  })
})

describe("ApprovalCard: the send check on an agent's mail draft", () => {
  const guarded = (sendGuard: Record<string, unknown>) =>
    baseRow({ toolName: "mail:compose", payloadHash: "seen", sendGuard })

  it("a plain agent mail to a contact shows the recipient facts the composer shows: basis, consumer or business, opted out", async () => {
    handleWsCreate(
      guarded({
        state: "clear",
        recipients: [
          {
            email: "lea@dealer.example",
            name: "Lea Martin",
            basis: "customer",
            isConsumer: false,
            optedOutAt: null,
          },
          {
            email: "pierre@gmail.com",
            name: null,
            basis: null,
            isConsumer: null,
            optedOutAt: "2026-10-02T09:00:00.000Z",
          },
        ],
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    const facts = await screen.findByTestId("approval-card-recipient-facts")
    const rows = facts.querySelectorAll("[data-testid=approval-card-recipient-facts-row]")
    expect(rows[0]?.textContent).toBe(
      "Lea Martin · Basis: Existing customer · Business · Not opted out",
    )
    expect(rows[1]?.textContent).toContain(
      "pierre@gmail.com · No recorded basis · Consumer or business not recorded · Opted out on",
    )
    // Facts, not a stop: the person still decides.
    expect(screen.getAllByTestId("approval-card-action-approve").length).toBeGreaterThan(0)
  })

  it("a stopped card has no Approve", async () => {
    handleWsCreate(
      guarded({
        state: "replied",
        who: "client@example.test",
        at: "2026-11-06T10:00:00.000Z",
        quote: "Thanks, we already ordered.",
        record: { kind: "conversation", id: "c-1" },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    const line = await screen.findByTestId("approval-card-send-guard")
    expect(line).toHaveTextContent("Not sent: client@example.test replied after this was drafted.")
    expect(screen.getByTestId("approval-card-send-guard-quote")).toHaveTextContent(
      "Thanks, we already ordered.",
    )
    expect(screen.queryByTestId("approval-card-action-approve")).toBeNull()
    expect(screen.queryByTestId("approval-card-action-send-now")).toBeNull()
    // Dismiss closes it; Reject and Edit have nothing left to act on.
    expect(screen.getAllByTestId("approval-card-action-dismiss").length).toBeGreaterThan(0)
    expect(screen.queryByTestId("approval-card-action-deny")).toBeNull()
    expect(screen.queryByTestId("approval-card-action-edit")).toBeNull()
  })

  it("a stopped card reads Not sent and offers a new reply, the conversation and Dismiss only", async () => {
    apiMocks.post.mockResolvedValue({ id: "ar-1", status: "denied" })
    handleWsCreate(
      guarded({
        state: "replied",
        who: "client@example.test",
        at: "2026-11-06T10:00:00.000Z",
        record: { kind: "conversation", id: "c-1" },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("approval-card-status-badge")).toHaveTextContent("Not sent")
    const actions = screen
      .getAllByTestId(/^approval-card-action-/)
      .map((b) => b.getAttribute("data-testid"))
    expect([...new Set(actions)]).toEqual([
      "approval-card-action-redraft",
      "approval-card-action-open-record",
      "approval-card-action-dismiss",
    ])
    expect(screen.getAllByTestId("approval-card-action-redraft")[0]).toHaveTextContent(
      "Draft a new reply from their message",
    )
    expect(screen.getAllByTestId("approval-card-action-open-record")[0]).toHaveTextContent(
      "Open conversation",
    )
    // Dismiss puts the draft away through its own decision, with no reason asked.
    fireEvent.click(screen.getAllByTestId("approval-card-action-dismiss")[0] as HTMLElement)
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalled())
    expect(apiMocks.post.mock.calls[0]?.[1]).toMatchObject({ decision: "deny" })
    expect(screen.queryByTestId("approval-card-deny-reason")).toBeNull()
  })

  it("Draft a new reply starts a turn in the Personal agent conversation on the message", async () => {
    const { openTab } = await import("~/modules/shell/tab-store")
    redraftMocks.send.mockClear()
    handleWsCreate(
      guarded({
        state: "replied",
        who: "client@example.test",
        record: { kind: "ticket", id: "tk-1" },
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findAllByTestId("approval-card-action-open-record")).not.toHaveLength(0)
    expect(screen.getAllByTestId("approval-card-action-open-record")[0]).toHaveTextContent(
      "Open ticket",
    )
    fireEvent.click(screen.getAllByTestId("approval-card-action-redraft")[0] as HTMLElement)
    await waitFor(() => expect(redraftMocks.send).toHaveBeenCalled())
    const call = redraftMocks.send.mock.calls[0] as unknown[]
    expect(call[1]).toBe("dm-1")
    expect(call[2]).toContain("client@example.test")
    expect(call[4]).toMatchObject({ currentView: { tabType: "tickets:ticket", entityId: "tk-1" } })
    expect(vi.mocked(openTab)).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread", entityId: "dm-1" }),
    )
    expect(apiMocks.post).not.toHaveBeenCalled()
  })

  it("a stop the viewer cannot open offers Dismiss alone", async () => {
    handleWsCreate(guarded({ state: "replied", who: "client@example.test" }), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findAllByTestId("approval-card-action-dismiss")).not.toHaveLength(0)
    expect(screen.queryByTestId("approval-card-action-redraft")).toBeNull()
    expect(screen.queryByTestId("approval-card-action-open-record")).toBeNull()
    expect(screen.queryByTestId("approval-card-action-edit")).toBeNull()
    expect(screen.queryByTestId("approval-card-action-deny")).toBeNull()
  })

  it("a reply on a ticket the viewer cannot open names a ticket", async () => {
    handleWsCreate(
      guarded({ state: "replied", who: "client@example.test", source: "ticket" }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("approval-card-send-guard")).toHaveTextContent(
      "Not sent: a reply came in on a ticket.",
    )
  })

  it("Held: badge Held, Keep holding first, and it folds to one line with no call", async () => {
    handleWsCreate(
      guarded({
        state: "held",
        who: "client@example.test",
        at: "2026-11-06T10:00:00.000Z",
        holdUntil: "2026-11-17T08:00:00.000Z",
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("approval-card-status-badge")).toHaveTextContent("Held")
    const actions = screen
      .getAllByTestId(/^approval-card-action-/)
      .map((b) => b.getAttribute("data-testid"))
    expect([...new Set(actions)]).toEqual([
      "approval-card-action-keep-holding",
      "approval-card-action-send-now",
      "approval-card-action-discard",
    ])
    const keep = screen.getAllByTestId("approval-card-action-keep-holding")[0] as HTMLElement
    expect(keep).toHaveTextContent("Keep holding until 17 Nov")
    apiMocks.get.mockClear()
    fireEvent.click(keep)
    expect(await screen.findByTestId("approval-card-held-folded")).toHaveTextContent(
      "Held until 17 Nov. It comes back to Home that morning.",
    )
    expect(screen.queryByTestId("approval-card-send-guard")).toBeNull()
    expect(screen.queryByTestId("approval-card-action-send-now")).toBeNull()
    // The WHOLE card is the one line: no title, no recipients, no message, no details.
    expect(screen.getByTestId("approval-card").textContent?.trim()).toBe(
      "Held until 17 Nov. It comes back to Home that morning.",
    )
    expect(apiMocks.post).not.toHaveBeenCalled()
    expect(apiMocks.get).not.toHaveBeenCalled()
    // A reload keeps it folded, in this browser, for this hold.
    cleanup()
    HeldKeptTestAccess.reload()
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("approval-card-held-folded")).toBeInTheDocument()
    expect(screen.queryByTestId("approval-card-action-keep-holding")).toBeNull()
  })

  it("Held: a new hold date unfolds a kept card", async () => {
    keepHolding("ar-1", "2026-11-17T08:00:00.000Z")
    handleWsCreate(guarded({ state: "held", holdUntil: "2026-11-20T08:00:00.000Z" }), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findAllByTestId("approval-card-action-keep-holding")).not.toHaveLength(0)
    expect(screen.queryByTestId("approval-card-held-folded")).toBeNull()
  })

  it("a held or stopped card shows no request handle and no expiry", async () => {
    handleWsCreate(
      guarded({ state: "replied", who: "client@example.test", source: "ticket" }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    await screen.findByTestId("approval-card-send-guard")
    expect(screen.queryByTestId("approval-card-handle")).toBeNull()
    expect(screen.getByTestId("approval-card").textContent).not.toContain("request-")
    expect(screen.getByTestId("approval-card").textContent).not.toMatch(/Expires in/)
    cleanup()
    resetApprovalsStore()
    handleWsCreate(guarded({ state: "held", holdUntil: "2026-11-17T08:00:00.000Z" }), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    await screen.findByTestId("approval-card-send-guard")
    expect(screen.queryByTestId("approval-card-handle")).toBeNull()
    expect(screen.getByTestId("approval-card").textContent).not.toMatch(/Expires in/)
  })

  it("Held: Discard is the reject", async () => {
    handleWsCreate(guarded({ state: "held", holdUntil: "2026-11-17T08:00:00.000Z" }), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(
      (await screen.findAllByTestId("approval-card-action-discard"))[0] as HTMLElement,
    )
    expect(await screen.findByTestId("approval-card-deny-reason")).toBeInTheDocument()
  })

  it("a reply in a mailbox the viewer cannot read says so, with no quote", async () => {
    handleWsCreate(guarded({ state: "replied", who: "client@example.test" }), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("approval-card-send-guard")).toHaveTextContent(
      "Not sent: a reply came in to another mailbox.",
    )
    expect(screen.queryByTestId("approval-card-send-guard-quote")).toBeNull()
  })

  it("Held: Send now replaces Approve", async () => {
    apiMocks.post.mockResolvedValue({ id: "ar-1", status: "approved" })
    handleWsCreate(
      guarded({
        state: "held",
        who: "client@example.test",
        at: "2026-11-06T10:00:00.000Z",
        holdUntil: "2026-11-17T00:00:00.000Z",
      }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("approval-card-send-guard")).toHaveTextContent(
      "Held: client@example.test sent an automatic reply.",
    )
    expect(screen.queryByTestId("approval-card-action-approve")).toBeNull()
    fireEvent.click(screen.getByTestId("approval-card-action-send-now"))
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalled())
    expect(apiMocks.post.mock.calls[0]?.[1]).toMatchObject({
      decision: "approve",
      payloadHash: "seen",
      sendGuardOverride: "auto_reply",
    })
  })

  it("a clear draft keeps its Approve, and the approve carries no override", async () => {
    apiMocks.post.mockResolvedValue({ id: "ar-1", status: "approved" })
    handleWsCreate(guarded({ state: "clear" }), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    fireEvent.click(await screen.findByTestId("approval-card-action-approve"))
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalled())
    expect(apiMocks.post.mock.calls[0]?.[1]).not.toHaveProperty("sendGuardOverride")
    expect(screen.queryByTestId("approval-card-send-guard")).toBeNull()
  })

  it("Send now that comes back not held reloads the card", async () => {
    const { ApiError } = await import("~/lib/api-error")
    apiMocks.post.mockRejectedValue(new ApiError("no longer held", 422, "send_guard_not_held"))
    handleWsCreate(guarded({ state: "held", holdUntil: "2026-11-17T00:00:00.000Z" }), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    apiMocks.get.mockClear()
    fireEvent.click(await screen.findByTestId("approval-card-action-send-now"))
    // The card's own reload, not its panel list (`/v1/slots/...`).
    await waitFor(() =>
      expect(apiMocks.get.mock.calls.some((c) => !String(c[0]).startsWith("/v1/slots/"))).toBe(
        true,
      ),
    )
    expect(toastMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("no longer held") }),
    )
  })
})
