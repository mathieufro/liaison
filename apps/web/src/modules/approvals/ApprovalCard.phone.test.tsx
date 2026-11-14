// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-1 T12. The approval card at phone width: the deadline chip and its amber
// threshold, three decision buttons on screen, and Deny asking its reason in a
// sheet before it submits.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

let currentScope: string[] = ["mail:approve"]
let currentUserId = "u-approver"
const apiMocks = { get: vi.fn().mockResolvedValue(undefined), post: vi.fn() }

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))
vi.mock("~/modules/auth/auth-store", () => ({
  hasScope: (s: string) => currentScope.includes(s),
  userFromToken: () => ({ userId: currentUserId, name: "Test User", scopes: currentScope }),
}))
vi.mock("~/modules/shell/toast-store", () => ({ addToast: vi.fn() }))
vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: vi.fn() }))
const { nativeHapticMock } = vi.hoisted(() => ({ nativeHapticMock: vi.fn() }))
vi.mock("~/lib/native-bridge", () => ({ nativeHaptic: nativeHapticMock }))

import { DecisionQueueTestAccess } from "~/modules/approvals/decision-queue"
import { setShellTier } from "~/tests/helpers/shell-tier"
import ApprovalCard, {
  DEADLINE_URGENT_MINUTES,
  deadlineIsUrgent,
  minutesLeft,
} from "./ApprovalCard"
import { handleWsCreate, resetApprovalsStore } from "./approvals-store"

// These tests pin each surface's decide wiring; the 5 s Undo window itself is
// decision-queue.test.ts's.
beforeEach(() => {
  DecisionQueueTestAccess.reset()
  DecisionQueueTestAccess.setUndoWindow(0)
})

const NOW = Date.parse("2026-04-30T12:00:00.000Z")

const row = (over: Partial<any> = {}): any => ({
  id: "ar-1",
  handle: "request-0001",
  status: "pending",
  createdAt: "2026-04-30T11:00:00.000Z",
  expiresAt: new Date(Date.now() + 40 * 60_000).toISOString(),
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

describe("minutesLeft / deadlineIsUrgent", () => {
  it("counts whole minutes and never goes below zero", () => {
    expect(minutesLeft(new Date(NOW + 30 * 60_000).toISOString(), NOW)).toBe(30)
    expect(minutesLeft(new Date(NOW + 90_000).toISOString(), NOW)).toBe(2)
    expect(minutesLeft(new Date(NOW - 60_000).toISOString(), NOW)).toBe(0)
    expect(minutesLeft(undefined, NOW)).toBeNull()
    expect(minutesLeft("not a date", NOW)).toBeNull()
  })

  it("turns urgent strictly under the threshold, not at it", () => {
    expect(deadlineIsUrgent(DEADLINE_URGENT_MINUTES)).toBe(false)
    expect(deadlineIsUrgent(DEADLINE_URGENT_MINUTES - 1)).toBe(true)
    expect(deadlineIsUrgent(null)).toBe(false)
  })
})

describe("ApprovalCard at phone tier", () => {
  beforeEach(() => {
    resetApprovalsStore()
    currentScope = ["mail:approve"]
    currentUserId = "u-approver"
    apiMocks.get.mockReset().mockResolvedValue(undefined)
    apiMocks.post.mockReset().mockResolvedValue({
      status: "approved",
      decidedBy: "u-approver",
      decidedAt: new Date().toISOString(),
    })
    nativeHapticMock.mockReset()
    setShellTier("phone")
  })
  afterEach(() => {
    cleanup()
    setShellTier("desktop")
  })

  // The card said "4123 min left" about the deadline the feed row called
  // "3d left": two formatters, one figure. Both read formatTimeLeft now.
  it("shows the time left, plain while there is room and amber once there is not", async () => {
    handleWsCreate(row(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    const chip = await screen.findByTestId("approval-card-deadline")
    expect(chip.textContent).toContain("Expires in 40 minutes")
    expect(chip.getAttribute("data-urgent")).toBe("false")

    cleanup()
    resetApprovalsStore()
    handleWsCreate(
      row({ id: "ar-2", expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-2" />)
    const urgent = await screen.findByTestId("approval-card-deadline")
    expect(urgent.textContent).toContain("Expires in 5 minutes")
    expect(urgent.getAttribute("data-urgent")).toBe("true")
  })

  it("puts Deny, Edit and Approve on screen instead of behind a more trigger", async () => {
    handleWsCreate(row(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    await screen.findByTestId("approval-card-actions")
    expect(screen.getByTestId("approval-card-action-deny")).toBeTruthy()
    expect(screen.getByTestId("approval-card-action-edit")).toBeTruthy()
    expect(screen.getByTestId("approval-card-action-approve")).toBeTruthy()
    // The desktop collapse-into-a-sheet trigger is gone at this width.
    expect(screen.queryByTestId("actions-more-trigger")).toBeNull()
  })

  it("Deny asks for the reason in a sheet and submits it", async () => {
    handleWsCreate(row(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    await screen.findByTestId("approval-card-actions")
    expect(screen.queryByTestId("approval-deny-sheet")).toBeNull()

    fireEvent.click(screen.getByTestId("approval-card-action-deny"))
    await waitFor(() => expect(screen.getByTestId("approval-deny-sheet")).toBeTruthy())
    const sheet = screen
      .getByTestId("approval-deny-sheet")
      .closest("[data-overlay-sheet]") as HTMLElement
    expect(sheet.getAttribute("data-variant")).toBe("bottom")

    const input = screen.getByTestId("approval-card-deny-reason") as HTMLInputElement
    fireEvent.input(input, { target: { value: "Wrong customer" } })
    fireEvent.click(screen.getByTestId("approval-card-action-deny-submit"))

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        "/approvals/ar-1/decide",
        { decision: "deny", reason: "Wrong customer" },
        { suppressGlobalError: true },
      ),
    )
    expect(nativeHapticMock).toHaveBeenCalledWith("warning")
  })

  it("Approve decides through the existing endpoint", async () => {
    handleWsCreate(row(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    await screen.findByTestId("approval-card-actions")
    fireEvent.click(screen.getByTestId("approval-card-action-approve"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        "/approvals/ar-1/decide",
        { decision: "approve" },
        { suppressGlobalError: true },
      ),
    )
    expect(nativeHapticMock).toHaveBeenCalledWith("success")
  })

  // G2: the first line used to pack the hourglass, the kind, the request id
  // AND the deadline onto one row, which wrapped onto three lines at 390px.
  it("reduces the first line to the kind and the deadline, with no request id on it", async () => {
    handleWsCreate(row(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    const chip = await screen.findByTestId("approval-card-deadline")
    const kind = screen.getByTestId("approval-card-kind")

    // What the line SAYS, not what order the nodes sit in: the id and its
    // separator are the two things that made it wrap at 390px.
    const line = kind.closest("div")?.parentElement
    expect(line).not.toBeNull()
    const text = (line?.textContent ?? "").trim()
    expect(text).toContain(kind.textContent?.trim() ?? "")
    expect(text).toContain(chip.textContent?.trim() ?? "")
    expect(text).not.toMatch(/request-\d+/)
    expect(text).not.toContain("·")
    expect(screen.queryByTestId("approval-card-handle")).toBeNull()
  })

  it("shows the request id at desktop", async () => {
    setShellTier("desktop")
    handleWsCreate(row(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    expect(await screen.findByTestId("approval-card-handle")).toBeTruthy()
  })

  it("keeps the desktop card unchanged: no deadline chip, actions in the inline row", async () => {
    setShellTier("desktop")
    handleWsCreate(row(), "u-approver")
    render(() => <ApprovalCard requestId="ar-1" />)
    await screen.findByTestId("approval-card-title")
    expect(screen.queryByTestId("approval-card-deadline")).toBeNull()
    expect(screen.queryByTestId("approval-card-actions")).toBeNull()
    expect(screen.getByTestId("actions-inline-row")).toBeTruthy()
  })

  // A deadline days away read as "4123 min left" on the card while the feed row
  // for the SAME request read "3d left". One humanised formatter, shared.
  it("humanises a deadline days away exactly as the feed row does", async () => {
    handleWsCreate(
      row({ id: "ar-3", expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString() }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-3" />)
    const chip = await screen.findByTestId("approval-card-deadline")
    expect(chip.textContent).toContain("Expires in 3 days")
    expect(chip.textContent).not.toContain("min left")
    // What happens when it runs out, on the chip itself.
    expect(chip.getAttribute("title")).toBe(
      "If nobody decides by then, it lapses and nothing is done.",
    )
  })

  it("opened from a Home row, the phone decide row leads the card, sticky at the top", async () => {
    handleWsCreate(row({ id: "ar-9" }), "u-approver")
    render(() => <ApprovalCard requestId="ar-9" inFeed />)
    const actions = await screen.findByTestId("approval-card-actions")
    expect(actions.className).toContain("sticky")
    expect(actions.className).toContain("top-0")
    expect(actions.className).not.toContain("bottom-0")
    // At the top it needs no clearance for the bottom tab bar.
    expect(actions.style.paddingBottom).toBe("")
    const title = screen.getByTestId("approval-card-title")
    expect(actions.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId("approval-card-action-approve")).toBeTruthy()
  })

  // The payload wrapped mid-word on a phone: `break-all` cuts wherever the
  // line happens to end, so a long value read as gibberish split across every
  // line. `break-words` breaks between words and only breaks INSIDE a word
  // that is longer than the line.
  it("wraps a payload value between words, never mid-word", async () => {
    handleWsCreate(
      row({ id: "ar-wrap", currentPayload: { note: "a readable sentence that has to wrap" } }),
      "u-approver",
    )
    render(() => <ApprovalCard requestId="ar-wrap" />)
    const value = await screen.findByTestId("approval-payload-value-note")
    expect(value.className).toContain("break-words")
    expect(value.className).not.toContain("break-all")
  })

  // Two live pairs with different wording ("Approve / Reject" on the row,
  // "Deny / Approve" on the card) sat on one phone screen. One pair, one
  // wording: the card's verb is the row's verb.
  it("names rejection the same way the feed row does", async () => {
    handleWsCreate(row({ id: "ar-verb" }), "u-approver")
    render(() => <ApprovalCard requestId="ar-verb" />)
    const deny = await screen.findByTestId("approval-card-action-deny")
    expect(deny).toHaveTextContent("Reject")
    expect(deny.textContent).not.toContain("Deny")
  })
})
