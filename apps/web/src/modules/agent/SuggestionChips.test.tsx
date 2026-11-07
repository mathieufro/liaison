// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The next steps an agent offers under its reply: drawn from the checked result only, a prompt
// chip is the person's own message, an open chip opens its tab.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), rawPost: vi.fn() }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))
vi.mock("~/modules/auth/auth-store", async (orig) => ({
  ...(await orig<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => ({ userId: "user-1", name: "Iris Vale" }),
}))
const tabs = vi.hoisted(() => ({ openTab: vi.fn() }))
vi.mock("~/modules/shell/tab-store", async (orig) => ({
  ...(await orig<typeof import("~/modules/shell/tab-store")>()),
  openTab: tabs.openTab,
}))

import {
  getMessages,
  loadMessagesIntoStore,
  type Message,
  resetMessageStore,
  type ToolCallState,
} from "~/modules/threads/message-store"
import { SuggestionChips } from "./SuggestionChips"

const THREAD = "th-chips"

function reply(tc: ToolCallState): ToolCallState {
  loadMessagesIntoStore(THREAD, [
    {
      id: "msg-agent",
      threadId: THREAD,
      authorId: "agent-1",
      authorName: "Agent",
      authorAvatarUrl: null,
      authorType: "agent",
      content: "Done.",
      metadata: { toolCalls: [tc] },
      reactions: [],
      createdAt: "2026-11-07T08:00:00.000Z",
    } as unknown as Message,
  ])
  return tc
}

const suggest = (steps: unknown[], over: Partial<ToolCallState> = {}): ToolCallState => ({
  toolCallId: "tc-s",
  toolName: "kernel__suggest_next_steps",
  status: "completed",
  args: { steps },
  result: { ok: true, shown: steps.length, steps },
  ...over,
})

describe("SuggestionChips", () => {
  beforeEach(() => {
    resetMessageStore()
    apiMocks.post.mockReset()
    tabs.openTab.mockReset()
  })
  afterEach(() => resetMessageStore())

  it("clicking a prompt chip sends it as my message and removes it", async () => {
    apiMocks.post.mockResolvedValue({ data: { id: "msg-me", createdAt: "2026-11-07T08:01:00Z" } })
    const tc = reply(suggest([{ label: "Draft the reply", kind: "prompt" }]))
    render(() => <SuggestionChips toolCalls={[tc]} />)
    await fireEvent.click(screen.getByTestId("suggestion-prompt"))
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledTimes(1))
    const [path, body] = apiMocks.post.mock.calls[0]
    expect(path).toContain(THREAD)
    expect(body.content).toBe("Draft the reply")
    await waitFor(() => expect(screen.queryByTestId("suggestion-chips")).toBeNull())
  })

  it("open chip opens the tab", async () => {
    const tab = { type: "projects:task", entityId: "11111111-1111-4111-8111-111111111111" }
    const tc = reply(suggest([{ label: "Open the task", kind: "open", app: "projects", tab }]))
    render(() => <SuggestionChips toolCalls={[tc]} />)
    await fireEvent.click(screen.getByTestId("suggestion-open"))
    expect(tabs.openTab).toHaveBeenCalledWith({ ...tab, label: "Open the task" })
    expect(apiMocks.post).not.toHaveBeenCalled()
  })

  it("draws at most 4 chips, and none from a result that shows none", () => {
    const five = [1, 2, 3, 4, 5].map((n) => ({ label: `Step ${n}`, kind: "prompt" }))
    const tc = reply(suggest(five))
    const { unmount } = render(() => <SuggestionChips toolCalls={[tc]} />)
    expect(screen.getAllByTestId("suggestion-prompt")).toHaveLength(4)
    unmount()
    // A conversation holding outside text: the call's arguments asked for a chip, the result drew none.
    const tainted = reply(
      suggest([{ label: "Pay now", kind: "prompt" }], { result: { ok: true, shown: 0 } }),
    )
    render(() => <SuggestionChips toolCalls={[tainted]} />)
    expect(screen.queryByTestId("suggestion-chips")).toBeNull()
  })

  it("chips under an older message are gone", () => {
    const tc = reply(suggest([{ label: "Draft the reply", kind: "prompt" }]))
    loadMessagesIntoStore(THREAD, [
      ...getMessages(THREAD),
      {
        id: "msg-later",
        threadId: THREAD,
        authorId: "user-1",
        authorName: "Iris Vale",
        authorAvatarUrl: null,
        authorType: "user",
        content: "Something else",
        metadata: null,
        reactions: [],
        createdAt: "2026-11-07T08:05:00.000Z",
      } as unknown as Message,
    ])
    render(() => <SuggestionChips toolCalls={[tc]} />)
    expect(screen.queryByTestId("suggestion-chips")).toBeNull()
  })
})
