// SPDX-License-Identifier: FSL-1.1-ALv2
// The contact page's discussion is the task's own (threads/EntityDiscussion):
// it lists the contact's messages oldest first, sends through the thread send,
// shows a teammate's or an agent's message as its socket event lands, and its
// box docks above the phone keyboard. Driven through the real message store.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { editorOf, typeInto } from "~/modules/editor/test-helpers"
import {
  handleWsMessageEvent,
  loadMessagesIntoStore,
  type Message,
  resetMessageStore,
} from "~/modules/threads/message-store"

const THREAD = "t-contact-c1"

const mocks = vi.hoisted(() => ({
  api: {
    get: vi.fn(async (..._args: unknown[]) => ({ panels: [] })),
    rawGet: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
  },
  sendMessage: vi.fn(async (..._args: unknown[]) => {}),
  detailStore: {
    contacts: {} as Record<string, any>,
    optOuts: {} as Record<string, any>,
    discussions: {} as Record<string, string>,
  },
}))

vi.mock("~/modules/shell/ApiContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/shell/ApiContext")>()),
  useApi: () => mocks.api,
  useOptionalApi: () => mocks.api,
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  userFromToken: () => ({ userId: "u-me", name: "Me Myself" }),
}))
vi.mock("~/modules/shell/SlotPanels", () => ({ SlotPanels: () => null }))
vi.mock("~/modules/contacts/contact-detail-store", () => ({
  contactDetailStore: mocks.detailStore,
  loadContact: vi.fn(async () => undefined),
  loadOptOut: vi.fn(async () => undefined),
  openContactDiscussion: vi.fn(async () => THREAD),
  updateContact: vi.fn(),
  deleteContact: vi.fn(),
}))
// The real store draws the messages; only the POST is stubbed.
vi.mock("~/modules/threads/message-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/threads/message-store")>()),
  sendMessage: mocks.sendMessage,
}))

const row = (id: string, minute: number, content: string, extra: Partial<Message> = {}) =>
  ({
    id,
    threadId: THREAD,
    authorId: "u-giulia",
    authorName: "Giulia Rossi",
    authorType: "user",
    content,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(Date.UTC(2026, 9, 1, 9, minute)).toISOString(),
    ...extra,
  }) as Message

const bodies = () =>
  screen.getAllByTestId("contact-discussion.message-body").map((b) => b.textContent?.trim())

beforeEach(() => {
  mocks.detailStore.contacts = {
    c1: { id: "c1", name: "Ines Duarte", email: "ines@example.com", externalIds: {} },
  }
  mocks.detailStore.discussions = { c1: THREAD }
  loadMessagesIntoStore(THREAD, [
    row("m-1", 0, "New prospect at Northwind Acoustics.", {
      authorType: "agent",
      authorName: "Sales Desk",
      authorAgentId: "agent-desk",
    } as Partial<Message>),
    row("m-2", 12, "Called her this morning."),
  ])
})

afterEach(() => {
  cleanup()
  resetMessageStore()
  mocks.sendMessage.mockClear()
})

async function renderPage() {
  const { ContactDetail } = await import("./ContactDetail")
  const view = render(() => <ContactDetail entityId="c1" />)
  // The discussion is a lazy chunk (its editor): a cold load under a busy run
  // takes longer than waitFor's default second.
  await screen.findByTestId("contact-discussion", {}, { timeout: 15_000 })
  return view
}

describe("ContactDetail discussion", () => {
  it("lists the contact's messages oldest first, the box under the newest, named for the contact", async () => {
    await renderPage()
    await waitFor(() =>
      expect(bodies()).toEqual([
        "New prospect at Northwind Acoustics.",
        "Called her this morning.",
      ]),
    )
    const list = screen.getByTestId("contact-discussion.messages")
    const box = screen.getByTestId("contact-discussion.dropzone")
    expect(list.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId("contact-detail.discussion-pane").contains(box)).toBe(true)
    expect(screen.getByTestId("contact-discussion.composer").innerHTML).toContain(
      "Write about Ines Duarte, or @ an agent",
    )
  })

  it("sends what is typed into the contact's thread, then empties the box", async () => {
    await renderPage()
    const field = await screen.findByTestId("contact-discussion.composer")
    typeInto(editorOf(field), "Sending the dealer terms")
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true })
    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledTimes(1))
    expect(mocks.sendMessage.mock.calls[0]?.[1]).toBe(THREAD)
    expect(mocks.sendMessage.mock.calls[0]?.[2]).toBe("Sending the dealer terms")
    await waitFor(() => expect(field.textContent).toBe(""))
  })

  it("an agent's message arriving on the socket appears at the bottom", async () => {
    await renderPage()
    await waitFor(() => expect(bodies()).toHaveLength(2))
    handleWsMessageEvent(
      "create",
      row("m-3", 20, "Here is the change for her record.", {
        authorType: "agent",
        authorName: "Sales Desk",
        authorAgentId: "agent-desk",
      } as Partial<Message>),
    )
    await waitFor(() => expect(bodies().at(-1)).toBe("Here is the change for her record."))
  })

  it("its box is an inline DockedComposer, so it docks above the phone keyboard", async () => {
    await renderPage()
    const box = await screen.findByTestId("contact-discussion.dropzone")
    const dock = box.closest("[data-composer-dock]")
    expect(dock?.getAttribute("data-composer-dock")).toBe("inline")
    expect(dock?.contains(screen.getByTestId("contact-discussion.send"))).toBe(true)
  })
})
