// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine's run, in the conversation it posts to (routine-report.ts on the
// server): the "is running" line settles in place, and an approval the run
// asked for is drawn as the live card of that one request, so deciding it in
// Home shows here too.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import ApprovalCard from "~/modules/approvals/ApprovalCard"
import {
  handleWsCreate,
  handleWsUpdate,
  resetApprovalsStore,
} from "~/modules/approvals/approvals-store"
import { DecisionQueueTestAccess } from "~/modules/approvals/decision-queue"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import MessageRow from "~/modules/threads/MessageRow"
import type { Message } from "~/modules/threads/message-store"

const apiMocks = {
  get: vi.fn().mockResolvedValue(undefined),
  post: vi.fn(),
  getEnvelope: vi.fn().mockResolvedValue({ data: [] }),
}

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
  ApiProvider: (p: { children: JSX.Element }) => p.children,
}))

vi.mock("~/modules/auth/auth-store", () => ({
  hasScope: () => true,
  userFromToken: () => ({ userId: "owner", name: "Owner", scopes: ["*"] }),
  onAuthCleared: () => () => {},
}))

vi.mock("~/modules/shell/toast-store", () => ({ addToast: vi.fn() }))
vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: vi.fn().mockResolvedValue(undefined),
}))

const renderContent = (content: string): JSX.Element => content
const noop = () => {}

function message(overrides: Partial<Message>): Message {
  return {
    id: "m1",
    threadId: "dm-1",
    authorId: "owner",
    authorName: "Routine prospects",
    authorAvatarUrl: null,
    authorType: "agent",
    authorAgentId: "agent-1",
    content: "Approval request request-0007 is waiting for a decision.",
    mentions: null,
    metadata: null,
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-10-27T10:00:00Z").toISOString(),
    ...overrides,
  }
}

function renderRow(msg: Message) {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <I18nProvider initialLocale="en">
            <MessageRow
              message={msg}
              grouped={false}
              currentUserId="owner"
              onEdit={noop}
              onDelete={noop}
              onReaction={noop}
              onRemoveReaction={noop}
              renderContent={renderContent}
            />
            {/* The same request as Home's approvals screen draws it. */}
            <div data-testid="home">
              <ApprovalCard requestId="ar-7" />
            </div>
          </I18nProvider>
        )}
      />
    </Router>
  ))
}

const request = (over: Record<string, unknown> = {}) =>
  ({
    id: "ar-7",
    handle: "request-0007",
    status: "pending",
    createdAt: "2026-10-27T10:00:00.000Z",
    expiresAt: "2026-10-27T11:00:00.000Z",
    toolName: "kernel:web_fetch",
    summary: { kind: "web_fetch", title: "Read northwind.example", lines: [] },
    editableFields: [],
    currentPayload: { url: "https://northwind.example/" },
    threadId: "out-1",
    originatingThreadId: "out-1",
    requestedBy: { id: "owner" },
    requester: { kind: "agent", id: "agent-1", name: "Personal agent" },
    notifyUserIds: ["owner"],
    lastEdit: null,
    lastFailure: null,
    ...over,
  }) as never

beforeEach(() => {
  DecisionQueueTestAccess.reset()
  DecisionQueueTestAccess.setUndoWindow(0)
  resetApprovalsStore()
})

afterEach(cleanup)

describe("a routine's approval, in the conversation the routine posts to", () => {
  const ask = () =>
    message({
      metadata: {
        agentAuthorLabel: "Routine prospects",
        routineApproval: {
          requestId: "ar-7",
          handle: "request-0007",
          toolName: "kernel:web_fetch",
          routineId: "r1",
          routineName: "prospects",
          outputThreadId: "out-1",
        },
      },
    })

  it("is drawn as the request's card, not as text", async () => {
    handleWsCreate(request(), "owner")
    renderRow(ask())
    const row = await screen.findByTestId("message-row-routine-approval")
    const card = row.querySelector('[data-testid="approval-card"]')
    expect(card?.getAttribute("data-request-id")).toBe("ar-7")
    expect(card?.getAttribute("data-tool-name")).toBe("kernel:web_fetch")
    expect(row.textContent).not.toContain("is waiting for a decision")
  })

  it("shows the decision taken in Home, the one request both cards stand for", async () => {
    handleWsCreate(request(), "owner")
    renderRow(ask())
    await screen.findByTestId("message-row-routine-approval")
    handleWsUpdate(request({ status: "denied", decidedAt: "2026-10-27T10:05:00.000Z" }))
    await waitFor(() => {
      const here = screen.getByTestId("message-row-routine-approval")
      expect(here.textContent).toContain("Denied")
    })
    expect(screen.getByTestId("home").textContent).toContain("Denied")
  })
})

describe("a routine's 'is running' line", () => {
  const line = (status: "running" | "succeeded" | "failed", draftsWaiting?: number) =>
    message({
      id: "run-1",
      authorType: "system",
      content: "Routine prospects is running.",
      metadata: {
        type: "routine-run",
        routineRun: {
          routineId: "r1",
          routineName: "prospects",
          outputThreadId: "out-1",
          ownerUserId: "owner",
          runKey: "k1",
          status,
          ...(draftsWaiting === undefined ? {} : { draftsWaiting }),
        },
      } as never,
    })

  it("says the routine runs, with its owner's link to the full run", () => {
    renderRow(line("running"))
    const row = screen.getByTestId("message-row-routine-run")
    expect(row.getAttribute("data-run-status")).toBe("running")
    expect(row.textContent).toContain("Routine prospects is running")
    expect(screen.getByTestId("message-row-routine-run-line-link").textContent).toBe(
      "[See the full run](thread:out-1)",
    )
  })

  it("says how the run ended once it settled", () => {
    renderRow(line("failed"))
    expect(screen.getByTestId("message-row-routine-run").textContent).toContain(
      "Routine prospects did not finish",
    )
  })

  it("says how many drafts wait for a person when a follow-up run ended with some", () => {
    renderRow(line("succeeded", 1))
    expect(screen.getByTestId("message-row-routine-run").textContent).toContain(
      "Routine prospects finished: 1 draft waits for a person",
    )
    cleanup()
    renderRow(line("succeeded", 3))
    expect(screen.getByTestId("message-row-routine-run").textContent).toContain(
      "Routine prospects finished: 3 drafts wait for a person",
    )
  })
})
