// SPDX-License-Identifier: FSL-1.1-ALv2

import { readFileSync } from "node:fs"
import { join } from "node:path"
import enKernel from "@liaison/shared/src/i18n/locales/en/kernel.json"
import enMail from "@liaison/shared/src/i18n/locales/en/mail.json"
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { loadMessages } from "~/modules/mail/mail-message-store"
import { MAILBOX_UNLOCK_EVENT } from "~/modules/mailbox/mailbox-unlock-bus"
import { threadMapAvailable } from "~/ui/thread-map-store"
import { MailConversation } from "./MailConversation"

// A Foxmail reply wrapped in leading cite blockquotes over a chain of seven
// earlier emails (synthetic, real structure). Read before any render.
const fixtures = vi.hoisted(() => ({ foxmail: "" }))
fixtures.foxmail = readFileSync(
  join(import.meta.dirname, "../../lib/__fixtures__/foxmail-nested-thread.html"),
  "utf8",
)

const mocks = vi.hoisted(() => {
  // The slot lists: the server says which banner and action this viewer gets.
  const slotLists = async (path: string) => {
    if (path === "/v1/slots/mail:conversation:banner") {
      return {
        panels: [{ id: "MailConvertToTicketBanner", app: "tickets", label: "Ticket banner" }],
      }
    }
    if (path === "/v1/slots/mail:conversation:actions") {
      return { panels: [{ id: "MailConvertToTicketAction", app: "tickets", label: "Convert" }] }
    }
    return undefined
  }
  return {
    slotLists,
    api: {
      get: vi.fn(slotLists),
      post: vi.fn(),
      getEnvelope: vi.fn(async () => ({ data: [] })),
    },
    claimConversation: vi.fn(),
    reassignConversation: vi.fn(),
  }
})

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => mocks.api,
  // The attachment strip's card reads it, so the fixture with an attachment
  // needs it present.
  useOptionalApi: () => mocks.api,
}))

vi.mock("~/modules/mail/mail-conversation-store", () => ({
  claimConversation: mocks.claimConversation,
  conversationStore: {
    byId: {
      "conv-1": {
        subject: "Test Subject",
        snippet: "Preview text",
        accountId: "acc-1",
        assignedTo: null,
        contactId: "contact-1",
        internalThreadId: null,
      },
      "conv-no-cc": {
        subject: "No Cc Subject",
        snippet: "Preview text",
        accountId: "acc-1",
        assignedTo: null,
        contactId: null,
        internalThreadId: null,
      },
      "conv-assigned": {
        subject: "Assigned Subject",
        snippet: "Preview text",
        accountId: "acc-1",
        assignedTo: "user-1",
        contactId: null,
        internalThreadId: null,
      },
      "conv-locked": {
        subject: "Locked Subject",
        snippet: "",
        accountId: "acc-1",
        assignedTo: null,
        contactId: null,
        internalThreadId: null,
      },
      "conv-outbound": {
        subject: "Outbound Subject",
        snippet: "Preview text",
        accountId: "acc-1",
        assignedTo: null,
        contactId: null,
        internalThreadId: null,
      },
      "conv-quoted": {
        subject: "Display stands",
        snippet: "Preview text",
        accountId: "acc-1",
        assignedTo: null,
        contactId: null,
        internalThreadId: null,
      },
      "conv-native-outbound": {
        subject: "Native Outbound Subject",
        snippet: "Preview text",
        accountId: "acc-1",
        assignedTo: null,
        contactId: null,
        internalThreadId: null,
      },
    },
  },
  reassignConversation: mocks.reassignConversation,
}))

vi.mock("~/modules/mail/mail-account-store", () => ({
  getAccount: () => ({ id: "acc-1", ownerType: "org" }),
  // The encryption enrollment banner reads the account list. An org account is
  // never in the encryption regime, so this fixture renders no banner.
  allAccounts: () => [{ id: "acc-1", ownerType: "org" }],
}))

vi.mock("~/modules/approvals/ApprovalCard", () => ({
  default: (props: { requestId: string }) => (
    <div data-testid={`approval-card-mock-${props.requestId}`}>{props.requestId}</div>
  ),
}))

vi.mock("~/modules/auth/auth-store", () => ({
  userFromToken: () => ({ userId: "current-user-id" }),
}))

vi.mock("~/modules/mail/AssigneePicker", () => ({
  AssigneePicker: (props: any) => (
    <button type="button" data-testid="assignee-chip" onClick={() => props.onReassign("user-2")}>
      Assigned {props.assignedTo}
    </button>
  ),
}))

vi.mock("~/modules/shell/entity-preview/EntityPreview", () => ({
  default: (props: any) => (
    <span
      data-testid="entity-preview"
      data-app={props.app}
      data-entity-type={props.entityType}
      data-entity-id={props.entityId}
    >
      {props.children}
    </span>
  ),
}))

vi.mock("~/modules/mail/mail-message-store", () => ({
  getDiscussionMarkers: () => [],
  getMessages: (conversationId: string) => {
    if (conversationId === "conv-outbound") {
      return [
        {
          id: "msg-outbound",
          fromAddress: { email: "support@acme.com" },
          toAddresses: [{ email: "customer@example.com" }],
          ccAddresses: [],
          htmlBody: null,
          textBody: "Hello",
          sentAt: "2026-04-13T10:00:00Z",
          direction: "outbound",
          sentByUser: { id: "u1", name: "Alice", avatarUrl: null },
        },
      ]
    }

    if (conversationId === "conv-quoted") {
      return [
        {
          id: "msg-earlier",
          fromAddress: { name: "Hugo Lambert", email: "hugo@lumen-displays.example" },
          toAddresses: [{ email: "sales@clearform-acrylic.example" }],
          ccAddresses: [],
          htmlBody: null,
          textBody:
            "Hi Mei,\n\nThe pro forma matches what we agreed. The deposit will follow before Friday.\n\nHugo",
          sentAt: "2026-10-26T22:09:00Z",
          direction: "outbound",
          sentByUser: null,
        },
        {
          id: "msg-quoted",
          fromAddress: { name: "Rosa", email: "sales@clearform-acrylic.example" },
          toAddresses: [{ email: "hugo@lumen-displays.example" }],
          ccAddresses: [],
          htmlBody: fixtures.foxmail,
          textBody: "",
          sentAt: "2026-11-04T16:14:00Z",
          direction: "inbound",
        },
        {
          id: "msg-written-here",
          fromAddress: { email: "hugo@lumen-displays.example" },
          toAddresses: [{ email: "sales@clearform-acrylic.example" }],
          ccAddresses: [],
          htmlBody:
            "<p>Bonjour,</p><blockquote><p>Le montant semblait plus élevé que d'habitude, pouvez-vous vérifier ?</p></blockquote><p>Voici la facture corrigée.</p>",
          textBody: "",
          sentAt: "2026-11-04T17:00:00Z",
          direction: "outbound",
          sentByUser: { id: "u1", name: "Alice", avatarUrl: null },
        },
      ]
    }

    if (conversationId === "conv-native-outbound") {
      return [
        {
          id: "msg-native-outbound",
          fromAddress: { email: "support@acme.com" },
          toAddresses: [{ email: "customer@example.com" }],
          ccAddresses: [],
          htmlBody: null,
          textBody: "Hello",
          sentAt: "2026-04-13T10:00:00Z",
          direction: "outbound",
          sentByUser: null,
        },
      ]
    }

    if (conversationId === "conv-locked") {
      return [
        {
          id: "msg-locked",
          fromAddress: { name: "Alice", email: "alice@example.com" },
          toAddresses: [],
          ccAddresses: [],
          htmlBody: "",
          textBody: "",
          sentAt: "2026-04-13T10:00:00Z",
          direction: "inbound",
          encVersion: 1,
          encState: "locked",
        },
      ]
    }

    // Three messages, the newest sealed and unopened.
    if (conversationId === "conv-locked-long") {
      return ["a", "b", "c"].map((key, i) => ({
        id: `msg-long-${key}`,
        fromAddress: { name: "Alice", email: "alice@example.com" },
        toAddresses: [],
        ccAddresses: [],
        htmlBody: "",
        textBody: i < 2 ? `Readable message ${key}` : "",
        sentAt: `2026-04-1${i + 1}T10:00:00Z`,
        direction: "inbound",
        ...(i === 2 ? { encVersion: 1, encState: "locked" } : {}),
      }))
    }

    if (conversationId === "conv-no-cc") {
      return [
        {
          id: "msg-2",
          fromAddress: { name: "Alice", email: "alice@example.com" },
          toAddresses: [{ email: "nameless@example.com" }],
          ccAddresses: [],
          htmlBody: null,
          textBody: "Hello",
          sentAt: "2026-04-13T10:00:00Z",
          direction: "inbound",
        },
      ]
    }

    return [
      {
        id: "msg-1",
        fromAddress: { name: "Alice", email: "alice@example.com" },
        toAddresses: [
          { name: "Bob", email: "bob@example.com" },
          { name: "Charlie", email: "charlie@example.com" },
        ],
        ccAddresses: [{ name: "Diana", email: "diana@example.com" }],
        htmlBody: null,
        textBody: "Hello",
        sentAt: "2026-04-13T10:00:00Z",
        direction: "inbound",
        attachments: [
          {
            id: "file-1",
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1024,
            disposition: "attachment",
          },
        ],
      },
    ]
  },
  loadMessages: vi.fn(),
  loadOlderMessages: vi.fn(),
}))

vi.mock("~/modules/shell/tab-store", () => ({
  tabStore: { activeTabId: "test-tab", tabs: [] },
  openTab: vi.fn(),
  makeTabId: (type: string, entityId: string) => `${type}:${entityId}`,
  updateTabLabel: vi.fn(),
}))

vi.mock("~/modules/mail/MailMessageRenderer", () => ({
  MailMessageRenderer: (props: {
    htmlBody: string | null
    textBody: string | null
    flattenQuotes?: boolean
  }) => (
    <div
      data-testid="mock-renderer"
      data-html={props.htmlBody ?? ""}
      data-text={props.textBody ?? ""}
      data-flatten={props.flattenQuotes ? "1" : "0"}
    />
  ),
}))

vi.mock("~/modules/mail/MailReplyBar", () => ({
  MailReplyBar: () => <div data-testid="mock-reply-bar" />,
}))

vi.mock("~/framework/app-registry", () => ({
  getContributions: (slotId: string) => {
    if (slotId === "mail:conversation:banner") {
      return [
        {
          appId: "tickets",
          id: "MailConvertToTicketBanner",
          label: "Ticket banner",
          component: (props: { mailConversationId: string }) => (
            <div data-testid="mail-conversation-banner-slot">{props.mailConversationId}</div>
          ),
        },
      ]
    }
    if (slotId === "mail:conversation:actions") {
      return [
        {
          appId: "tickets",
          id: "MailConvertToTicketAction",
          label: "Convert to ticket",
          component: (props: { mailConversationId: string }) => (
            <button type="button" data-testid="mail-conversation-action-slot">
              {props.mailConversationId}
            </button>
          ),
        },
      ]
    }
    return []
  },
}))

describe("MailConversation — participant display", () => {
  test("renders To recipients in message header", () => {
    render(() => <MailConversation entityId="conv-1" />)
    expect(screen.getByTestId("mail-message-to").textContent).toContain("Bob")
    expect(screen.getByTestId("mail-message-to").textContent).toContain("Charlie")
  })

  test("renders Cc recipients when present", () => {
    render(() => <MailConversation entityId="conv-1" />)
    expect(screen.getByTestId("mail-message-cc").textContent).toContain("Diana")
  })

  test("hides Cc when absent and falls back to recipient email", () => {
    render(() => <MailConversation entityId="conv-no-cc" />)
    expect(screen.getByTestId("mail-message-to").textContent).toContain("nameless@example.com")
    expect(screen.queryByTestId("mail-message-cc")).toBeNull()
  })

  test("wraps sender header with contact EntityPreview when conversation has a contact", () => {
    render(() => <MailConversation entityId="conv-1" />)

    const preview = screen.getByTestId("entity-preview")
    expect(preview).toHaveAttribute("data-app", "kernel")
    expect(preview).toHaveAttribute("data-entity-type", "contact")
    expect(preview).toHaveAttribute("data-entity-id", "contact-1")
    expect(preview).toHaveTextContent("Alice")
  })
})

// One avatar family for the whole app. Mail kept its own vivid `bg-*-600`
// palette, so the same person wore an orange disc in their mailbox and a
// dimmed one in a thread. Every initials disc reads the `--avatar-N` pairs now.
describe("MailConversation avatars read the one app wide palette", () => {
  test("a message avatar is painted from --avatar-N, never an hsl or hex literal", () => {
    render(() => <MailConversation entityId="conv-1" />)
    const discs = screen.getAllByTestId("mail-message-avatar")
    expect(discs.length).toBeGreaterThan(0)
    for (const disc of discs) {
      const bg = disc.style.backgroundColor
      const fg = disc.style.color
      expect(bg).toMatch(/^var\(--avatar-\d-bg\)$/)
      expect(fg).toMatch(/^var\(--avatar-\d-text\)$/)
      expect(bg).not.toMatch(/hsl|rgb|#/)
      // The vivid Tailwind palette is gone with it.
      expect(disc.className).not.toMatch(/bg-(emerald|pink|sky|amber|violet|rose)-600/)
      expect(disc.className).not.toContain("text-white")
    }
  })
})

describe("MailConversation - locked mailbox", () => {
  // T-WEB-3. A sealed message the browser cannot open is a STATE, not a
  // failure. The reader gets one large unlock panel in place of the thread:
  // never a column of senders over empty bodies, never an error.
  test("T-WEB-3 a locked conversation renders the unlock panel and no empty body", () => {
    render(() => <MailConversation entityId="conv-locked" />)
    const area = screen.getByTestId("mail-conversation-locked")
    const panel = screen.getByTestId("mailbox-locked-notice")
    expect(area.contains(panel)).toBe(true)
    expect(panel).toHaveAttribute("data-variant", "page")
    expect(panel).toHaveTextContent(enKernel.mailboxEncryption.locked.panelTitle)
    expect(panel).toHaveTextContent(enKernel.mailboxEncryption.locked.panelBody)
    expect(panel.textContent).not.toMatch(/error|failed|corrupt|encrypt/i)
    // No message card at all: no sender row, no body, no renderer.
    expect(screen.queryByTestId("mail-message-content")).toBeNull()
    expect(screen.queryByTestId("mail-message-body")).toBeNull()
    expect(screen.queryByTestId("mail-message-avatar")).toBeNull()
    expect(screen.queryByTestId("mock-renderer")).toBeNull()
    // The subject line is never blank.
    expect(screen.getByTestId("mail-conversation-subject").textContent?.trim()).not.toBe("")
  })

  test("the panel's Unlock button asks for the unlock modal", () => {
    const onUnlock = vi.fn()
    window.addEventListener(MAILBOX_UNLOCK_EVENT, onUnlock)
    try {
      render(() => <MailConversation entityId="conv-locked" />)
      const button = screen.getByTestId("mailbox-locked-notice.unlock")
      expect(button).toHaveTextContent(enKernel.mailboxEncryption.locked.panelButton)
      fireEvent.click(button)
      expect(onUnlock).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(MAILBOX_UNLOCK_EVENT, onUnlock)
    }
  })

  test("an unlocked conversation renders no unlock panel", () => {
    render(() => <MailConversation entityId="conv-1" />)
    expect(screen.queryByTestId("mail-conversation-locked")).toBeNull()
    expect(screen.queryByTestId("mailbox-locked-notice")).toBeNull()
  })
})

describe("MailConversation — Discuss button", () => {
  test("renders as icon button with tooltip, no visible text", () => {
    render(() => <MailConversation entityId="conv-1" />)
    const btn = screen.getByTestId("mail-add-note")
    expect(btn.getAttribute("aria-label")).toBe("Discuss")
    expect(btn.querySelector("svg")).not.toBeNull()
    expect(btn.textContent?.trim()).toBe("")
  })

  // Surface 28: the desktop affordance and the phone "..." sheet row call the
  // SAME handler, so they carry the same name. The desktop one said "Add note"
  // while the sheet said "Discuss".
  test("carries the phone sheet row's kernel string, not the old note wording", () => {
    render(() => <MailConversation entityId="conv-1" />)
    const label = screen.getByTestId("mail-add-note").getAttribute("aria-label")
    // The phone sheet row (`mail-more-discuss`, pinned in the phone test) reads
    // `kernel.mailDiscuss`; the desktop icon must read the same entry.
    expect(label).toBe(enKernel.mailDiscuss)
    expect(label).not.toBe(enMail.addNote)
  })
})

describe("MailConversation — app contributions", () => {
  test("renders registered banner and action contributions for the active conversation", async () => {
    render(() => <MailConversation entityId="conv-1" />)

    expect(await screen.findByTestId("mail-conversation-banner-slot")).toHaveTextContent("conv-1")
    expect(await screen.findByTestId("mail-conversation-action-slot")).toHaveTextContent("conv-1")
  })
})

describe("MailConversation — assignment controls", () => {
  test("renders Claim in the header for unassigned shared conversations", async () => {
    render(() => <MailConversation entityId="conv-1" />)

    await fireEvent.click(screen.getByRole("button", { name: "Claim" }))

    expect(mocks.claimConversation).toHaveBeenCalledWith(mocks.api, "conv-1", "current-user-id")
  })

  test("renders assignee chip in the header for assigned shared conversations", async () => {
    render(() => <MailConversation entityId="conv-assigned" />)

    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull()
    await fireEvent.click(screen.getByTestId("assignee-chip"))

    expect(mocks.reassignConversation).toHaveBeenCalledWith(mocks.api, "conv-assigned", "user-2")
  })
})

describe("MailConversation — outbound sender attribution", () => {
  test("outbound message with sentByUser renders replied-via attribution", () => {
    render(() => <MailConversation entityId="conv-outbound" />)

    expect(screen.getByText(/Alice replied via support@acme.com/)).toBeInTheDocument()
  })

  test("outbound message with sentByUser null falls back to Sent badge", () => {
    render(() => <MailConversation entityId="conv-native-outbound" />)

    expect(screen.getByText("Sent")).toBeInTheDocument()
    expect(screen.queryByText(/replied via/)).toBeNull()
  })
})

describe("MailConversation — inline pending approvals", () => {
  test("renders a pending mail draft approval inline in the message stream", async () => {
    mocks.api.getEnvelope = vi.fn(async () => ({
      data: [
        { id: "ar-mail-1", status: "pending" },
        { id: "ar-mail-2", status: "approved" },
      ],
    })) as any
    render(() => <MailConversation entityId="conv-1" />)
    await waitFor(() =>
      expect(mocks.api.getEnvelope).toHaveBeenCalledWith("/approvals?conversationId=conv-1"),
    )
    await waitFor(() => expect(screen.getByTestId("approval-card-mock-ar-mail-1")).toBeTruthy())
    expect(screen.queryByTestId("approval-card-mock-ar-mail-2")).toBeNull()
    // Inline: the card lives inside the conversation scroll container.
    const scroll = screen.getByTestId("mail-conversation-scroll")
    expect(scroll.contains(screen.getByTestId("mail-conversation-approval-card"))).toBe(true)
  })

  test("re-fetches approvals on mail:approvals-invalidated for this conversation only", async () => {
    mocks.api.getEnvelope = vi.fn(async () => ({ data: [] })) as any
    render(() => <MailConversation entityId="conv-1" />)
    await waitFor(() => expect(mocks.api.getEnvelope).toHaveBeenCalledTimes(1))
    window.dispatchEvent(
      new CustomEvent("mail:approvals-invalidated", { detail: { conversationId: "conv-other" } }),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(mocks.api.getEnvelope).toHaveBeenCalledTimes(1)
    window.dispatchEvent(
      new CustomEvent("mail:approvals-invalidated", { detail: { conversationId: "conv-1" } }),
    )
    await waitFor(() => expect(mocks.api.getEnvelope).toHaveBeenCalledTimes(2))
  })

  test("opens an attachment through the decrypting path, not the raw bytes", async () => {
    // A sealed attachment served straight to disk saves ciphertext under the
    // original filename, which looks to the user exactly like a corrupt file.
    mocks.api.get = vi.fn(async () => ({})) as any
    render(() => <MailConversation entityId="conv-1" />)
    const button = await screen.findByTestId("attachment-download-file-1")
    fireEvent.click(button)
    await waitFor(() =>
      expect(mocks.api.get).toHaveBeenCalledWith(expect.stringContaining("/files/file-1/metadata")),
    )
  })
})

describe("MailConversation: a conversation that cannot be loaded", () => {
  beforeEach(() => vi.mocked(loadMessages).mockReset())

  test("a 404 says the conversation is not readable by this user and offers no Retry", async () => {
    vi.mocked(loadMessages).mockRejectedValueOnce(new ApiError("Conversation not found", 404))
    render(() => <MailConversation entityId="conv-gone" />)
    const error = await screen.findByTestId("mail-conversation-load-error")
    expect(error.textContent).toBe(enMail.conversationUnavailable)
    expect(screen.queryByText(enKernel.common.retry2)).toBeNull()
  })

  test("Retry after a failed load handles its own rejection instead of leaking it", async () => {
    // A rejected promise nobody calls `then` on is an unhandled rejection in the
    // browser. Count the handlers attached to each one: the mock itself attaches
    // one (vitest records settled results), the component must attach another.
    const handled: number[] = []
    class TrackedPromise<T> extends Promise<T> {
      index = -1
      // biome-ignore lint/suspicious/noThenProperty: the point is to observe then()
      override then<A = T, B = never>(
        onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
        onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
      ): Promise<A | B> {
        if (this.index >= 0) handled[this.index] = (handled[this.index] ?? 0) + 1
        return super.then(onFulfilled, onRejected)
      }
    }
    const rejected = () => {
      const p = TrackedPromise.reject(new ApiError("Server error", 500)) as TrackedPromise<void>
      p.index = handled.length
      handled.push(0)
      return p
    }
    vi.mocked(loadMessages).mockImplementationOnce(rejected).mockImplementationOnce(rejected)
    render(() => <MailConversation entityId="conv-flaky" />)
    fireEvent.click(await screen.findByText(enKernel.common.retry2))
    await waitFor(() => expect(vi.mocked(loadMessages)).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(handled.every((count) => count >= 2)).toBe(true)
    expect(screen.getByTestId("mail-conversation-load-error").textContent).toBe(
      enMail.conversationLoadFailed,
    )
  })
})

// A tall banner (a customer card opened full) must not push the reply bar
// below the panel's edge: the column then overflowed, the bar's bottom
// reserve was clipped, and the dock's bar sat on Send.
describe("MailConversation — banners never push the reply bar off screen", () => {
  beforeEach(() => {
    mocks.api.get = vi.fn(mocks.slotLists) as any
  })
  test("the banners share the column as a shrinkable, scrolling region; the reply bar does not shrink", async () => {
    render(() => <MailConversation entityId="conv-1" />)
    await screen.findByTestId("mail-conversation-banner-slot")
    const region = screen.getByTestId("mail-conversation-banners")
    expect(region.contains(screen.getByTestId("mail-conversation-banner-slot"))).toBe(true)
    for (const cls of ["min-h-0", "overflow-y-auto"]) expect(region.className).toContain(cls)
    // The cap and the shrink sit on the frame around the scrolling region.
    const frame = region.parentElement!
    for (const cls of ["min-h-0", "shrink"]) expect(frame.className).toContain(cls)
    expect(frame.className).toMatch(/max-h-/)
  })

  // Walk D64: the cap cut the customer card mid-row, right against the
  // thread's first message, which then read as drawn over the card's rows.
  test("a cut banner fades out at the column's edge", async () => {
    render(() => <MailConversation entityId="conv-1" />)
    await screen.findByTestId("mail-conversation-banner-slot")
    const frame = screen.getByTestId("mail-conversation-banners").parentElement!
    expect(within(frame).getByTestId("scroll-fade-end")).toBeTruthy()
    expect(within(frame).getByTestId("scroll-fade-start")).toBeTruthy()
  })
})

describe("MailConversation — quoted history", () => {
  const messageRoot = (id: string) =>
    screen.getAllByTestId("mail-message").find((el) => el.dataset.messageId === id)

  test("renders only the reply of a Foxmail message and folds its chain", () => {
    render(() => <MailConversation entityId="conv-quoted" />)
    const root = messageRoot("msg-quoted")
    expect(root).toBeTruthy()
    const html = within(root!).getByTestId("mock-renderer").dataset.html ?? ""
    expect(html).toContain("production of the stands starts on Monday")
    expect(html).not.toContain("The deposit went out this morning")
    expect(screen.getByTestId("mail-message-quote-toggle-msg-quoted").textContent).toContain(
      "7 earlier emails · 1 already in this thread",
    )
  })

  test("lists the earlier emails and jumps to the one already in the thread", () => {
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView")
    render(() => <MailConversation entityId="conv-quoted" />)
    fireEvent.click(screen.getByTestId("mail-message-quote-toggle-msg-quoted"))
    const rows = screen.getAllByTestId(/^mail-message-quote-row-msg-quoted-/)
    expect(rows).toHaveLength(7)
    expect(rows[1].textContent).toContain("Mei")
    fireEvent.click(screen.getByTestId("mail-message-quote-jump-msg-quoted-2"))
    expect(scrollIntoView.mock.contexts[0]).toBe(messageRoot("msg-earlier"))
    scrollIntoView.mockRestore()
  })

  test("Show original renders the raw chain with nested quotes flattened", () => {
    render(() => <MailConversation entityId="conv-quoted" />)
    fireEvent.click(screen.getByTestId("mail-message-quote-toggle-msg-quoted"))
    fireEvent.click(screen.getByTestId("mail-message-quote-original-msg-quoted"))
    const original = within(
      screen.getByTestId("mail-message-quote-original-body-msg-quoted"),
    ).getByTestId("mock-renderer")
    expect(original.dataset.flatten).toBe("1")
    expect(original.dataset.html).toContain("The deposit went out this morning")
  })

  test("shows a reply written in Liaison whole, quote included", () => {
    render(() => <MailConversation entityId="conv-quoted" />)
    const root = messageRoot("msg-written-here")
    expect(within(root!).getByTestId("mock-renderer").dataset.html).toContain("Le montant semblait")
    expect(screen.queryByTestId("mail-message-quote-toggle-msg-written-here")).toBeNull()
  })
})

describe("MailConversation — quoted history state across remounts", () => {
  test("keeps Show original open when the rows remount", () => {
    const [entityId, setEntityId] = createSignal("conv-quoted")
    render(() => <MailConversation entityId={entityId()} />)
    fireEvent.click(screen.getByTestId("mail-message-quote-toggle-msg-quoted"))
    fireEvent.click(screen.getByTestId("mail-message-quote-original-msg-quoted"))
    const before = screen.getByTestId("mail-message-quote-original-body-msg-quoted")
    // Every row re-derives, so every row remounts.
    setEntityId("conv-no-cc")
    setEntityId("conv-quoted")
    const after = screen.getByTestId("mail-message-quote-original-body-msg-quoted")
    expect(after).not.toBe(before)
    expect(within(after).getByTestId("mock-renderer").dataset.html).toContain(
      "The deposit went out this morning",
    )
  })
})

describe("MailConversation — thread drawer availability", () => {
  beforeEach(() => vi.mocked(loadMessages).mockReset())

  test("offers the drawer for three readable messages", () => {
    render(() => <MailConversation entityId="conv-quoted" />)
    expect(threadMapAvailable("mail:conv-quoted")).toBe(true)
  })

  test("hides the drawer button while a message is locked", () => {
    render(() => <MailConversation entityId="conv-locked-long" />)
    expect(threadMapAvailable("mail:conv-locked-long")).toBe(false)
  })

  test("hides the drawer button when the load failed", async () => {
    vi.mocked(loadMessages).mockRejectedValueOnce(new ApiError("Server error", 500))
    render(() => <MailConversation entityId="conv-quoted" />)
    await screen.findByTestId("mail-conversation-load-error")
    expect(threadMapAvailable("mail:conv-quoted")).toBe(false)
  })
})
