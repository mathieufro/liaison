// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A stored result card is drawn under its message, never folded into the "Used N tools" line.
// Live, a turn draws its cards in place; a saved turn with no timeline (reasoning off) is drawn
// by the row's flat layout, which folded every call, so after a reload the cards appeared only
// once the line was opened. Only the calls without a card fold.
import type { ResolvedCard } from "@liaison/shared"
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import type { JSX } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import AgentTurnBlock from "~/modules/agent/AgentTurnBlock"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import MessageRow from "~/modules/threads/MessageRow"
import type { Message, ToolCallState } from "~/modules/threads/message-store"

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

const noop = () => {}

const entityCard: ResolvedCard = {
  kind: "entity",
  pill: { label: "Ticket" },
  title: "Volume pricing",
  rows: [{ label: { label: "Assignee" }, value: "Giulia" }],
}
const numberCard: ResolvedCard = {
  kind: "number",
  pill: { label: "Open tickets" },
  value: { t: "number", n: 55 },
  how: { label: "Open tickets on the desk" },
  source: "Tickets",
}

const withCard = (id: string, card: ResolvedCard): ToolCallState => ({
  toolCallId: id,
  toolName: "tickets__get",
  status: "completed",
  readOnly: true,
  card,
})
const plain: ToolCallState = {
  toolCallId: "tc-plain",
  toolName: "search_threads",
  status: "completed",
}

function agentMessage(toolCalls: ToolCallState[]): Message {
  return {
    id: "m-agent",
    threadId: "dm-1",
    authorId: "agent-1",
    authorName: "Agent",
    authorAvatarUrl: null,
    authorType: "agent",
    authorAgentId: null,
    content: "Here is what I read.",
    mentions: null,
    metadata: { toolCalls },
    reactions: [],
    attachments: [],
    editedAt: null,
    deletedAt: null,
    createdAt: new Date("2026-11-08T04:54:00Z").toISOString(),
  } as unknown as Message
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
              renderContent={(c: string): JSX.Element => c}
            />
          </I18nProvider>
        )}
      />
    </Router>
  ))
}

afterEach(cleanup)

describe("a saved turn's result cards", () => {
  it("are drawn under the message without opening the tools line", () => {
    renderRow(agentMessage([withCard("tc-1", entityCard), withCard("tc-2", numberCard), plain]))
    expect(screen.getByTestId("card-entity")).toBeInTheDocument()
    expect(screen.getByTestId("card-number")).toBeInTheDocument()
    // Only the call with no card folds, and the line counts only it.
    const toggle = screen.getByTestId("message-row-tools-toggle")
    expect(toggle).toHaveTextContent("Used 1 tool")
    expect(screen.queryByText("Search Threads")).toBeNull()
  })

  it("draws no tools line when every call drew a card", () => {
    renderRow(agentMessage([withCard("tc-1", entityCard), withCard("tc-2", numberCard)]))
    expect(screen.getByTestId("card-entity")).toBeInTheDocument()
    expect(screen.getByTestId("card-number")).toBeInTheDocument()
    expect(screen.queryByTestId("message-row-tools-toggle")).toBeNull()
  })

  it("opening the line shows the folded calls, and each card is still drawn once", async () => {
    renderRow(agentMessage([withCard("tc-1", entityCard), plain]))
    await fireEvent.click(screen.getByTestId("message-row-tools-toggle"))
    expect(screen.getByText("Search Threads")).toBeInTheDocument()
    expect(screen.getAllByTestId("card-entity")).toHaveLength(1)
  })

  it("a collapsed turn draws its cards outside its tools line too", () => {
    render(() => (
      <I18nProvider initialLocale="en">
        <AgentTurnBlock
          mode="collapsed"
          toolCalls={[withCard("tc-1", entityCard), plain]}
          content="Done."
        />
      </I18nProvider>
    ))
    expect(screen.getByTestId("card-entity")).toBeInTheDocument()
    expect(screen.getByText(/Used 1 tool/)).toBeInTheDocument()
  })
})
