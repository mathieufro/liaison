// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, test, vi } from "vitest"
import { installAudioContext, installMic, removeMic } from "~/modules/assist/dictation-fakes"
import { editableIn, editorOf, setMarkdown } from "~/modules/editor/test-helpers"

import { heldUploads, landedRow, nextTask } from "~/tests/helpers/held-uploads"
import { MailCompose } from "./MailCompose"

// Picks run through the real uploadFile and land (or fail) when a test says.
vi.mock("~/modules/files/file-service", async (orig) =>
  (await import("~/tests/helpers/held-uploads")).withHeldUploads(orig),
)

// A presign that never answers keeps a picked file in flight.
// The composer's recipient check answers what `composeCheck` holds.
const composeCheck = vi.hoisted(() => ({
  answer: null as unknown,
  asked: 0,
  patches: [] as Array<{ path: string; body: unknown }>,
}))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({
    get: vi.fn(async (path: string) =>
      path === "/assist/capabilities" ? { dictation: true, autoClean: true } : undefined,
    ),
    post: vi.fn((path: string) => {
      if (path === "/mail/compose-check") composeCheck.asked++
      return path === "/mail/compose-check" && composeCheck.answer
        ? Promise.resolve(composeCheck.answer)
        : new Promise(() => {})
    }),
    patch: vi.fn(async (path: string, body: unknown) => {
      composeCheck.patches.push({ path, body })
      return { data: { id: path.split("/").at(-1), ...(body as object) } }
    }),
  }),
}))
vi.mock("~/modules/mail/mail-account-store", () => ({
  allAccounts: () => [{ id: "acc-1" }],
  personalAccounts: () => [{ id: "acc-1" }],
}))
vi.mock("~/modules/mail/mail-draft-store", async (orig) => ({
  mailSendErrorKey: (await orig<typeof import("~/modules/mail/mail-draft-store")>())
    .mailSendErrorKey,
  // A fresh draft per render: uploads a presign never answers stay in flight
  // for the whole file, and must not show up in the next test's composer.
  createDraft: vi.fn(async () => ({ id: `draft-${Math.random().toString(36).slice(2)}` })),
  discardDraft: vi.fn(),
  drafts: vi.fn(() => ({})),
  scheduleDraftSave: vi.fn(),
  sendDraft: vi.fn(),
}))
vi.mock("~/modules/shell/tab-store", () => ({
  closeTab: vi.fn(),
  makeTabId: (type: string, id: string) => `${type}:${id}`,
}))

describe("MailCompose — attachments", () => {
  test("stages files above the message, like chat", async () => {
    render(() => <MailCompose entityId="compose-1" />)
    const input = screen.getByTestId("attachment-upload-input") as HTMLInputElement
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "report.pdf", { type: "application/pdf" })],
    })
    fireEvent.change(input)
    const strip = await waitFor(() => screen.getByTestId("composer-attachment-strip"))
    const editor = await editableIn("mail-compose-editor")
    expect(strip.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(strip.className).not.toContain("justify-end")
  })

  // Send sits in the panel's bottom right corner, where the dock's floating
  // bar is: the footer pads its bottom by the shell's clearance for it.
  test("keeps its send row clear of the dock's bar", () => {
    render(() => <MailCompose entityId="compose-1" />)
    const row = screen.getByTestId("mail-compose-send").closest(".border-t") as HTMLElement
    expect(row.className).toContain("pb-dock-clearance")
  })
  test("shows an uploading tile while a picked file is still on its way", async () => {
    render(() => <MailCompose entityId="compose-1" />)
    const input = screen.getByTestId("attachment-upload-input") as HTMLInputElement
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "report.pdf", { type: "application/pdf" })],
    })
    fireEvent.change(input)
    await waitFor(() => expect(screen.getByTestId("composer-attachment-uploading")).toBeTruthy())
  })

  // Send sends the draft with the files already on it: one still uploading
  // went out missing, then landed on the sent draft. A press meanwhile used to
  // do nothing; it now queues the send, which goes out once the file is up.
  async function queueBehindUpload() {
    const { sendDraft } = await import("~/modules/mail/mail-draft-store")
    vi.mocked(sendDraft).mockClear()
    heldUploads.reset()
    render(() => <MailCompose entityId="compose-1" />)
    fireEvent.input(screen.getByTestId("mail-compose-to"), {
      target: { value: "client@example.com" },
    })
    const input = screen.getByTestId("attachment-upload-input") as HTMLInputElement
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "report.pdf", { type: "application/pdf" })],
    })
    fireEvent.change(input)
    await waitFor(() => expect(heldUploads.finish).toHaveLength(1))
    const send = screen.getByTestId("mail-compose-send") as HTMLButtonElement
    expect(send.disabled).toBe(false)
    expect(send.getAttribute("aria-label")).toBe("Send when files finish uploading")
    fireEvent.click(send)
    await nextTask()
    expect(sendDraft).not.toHaveBeenCalled()
    expect(send.dataset.queued).toBe("true")
    expect(send.textContent).toContain("Queued")
    return { send, sendDraft: vi.mocked(sendDraft) }
  }

  test("Send while a file uploads is queued and goes out once the file is up", async () => {
    const { send, sendDraft } = await queueBehindUpload()
    heldUploads.finish[0](landedRow("file-1", "report.pdf"))
    await waitFor(() => expect(sendDraft).toHaveBeenCalledTimes(1))
    expect(JSON.stringify(sendDraft.mock.calls[0][2])).toContain("client@example.com")
    expect(send.dataset.queued).toBeUndefined()
  })

  test("editing the message cancels a queued send", async () => {
    const { send, sendDraft } = await queueBehindUpload()
    fireEvent.input(screen.getByTestId("mail-compose-subject"), {
      target: { value: "Quarterly report" },
    })
    expect(send.dataset.queued).toBeUndefined()
    heldUploads.finish[0](landedRow("file-1", "report.pdf"))
    await waitFor(() => expect(screen.queryByTestId("composer-attachment-uploading")).toBeNull())
    await nextTask()
    expect(sendDraft).not.toHaveBeenCalled()
  })

  test("a failed upload cancels the queued send and shows the upload error", async () => {
    const { send, sendDraft } = await queueBehindUpload()
    heldUploads.fail[0](new Error("storage down"))
    await waitFor(() => expect(screen.getByTestId("composer-attachment-error")).toBeTruthy())
    await nextTask()
    expect(sendDraft).not.toHaveBeenCalled()
    expect(send.dataset.queued).toBeUndefined()
  })

  // The message is written in the shared editor: the draft keeps its
  // markdown (it reopens as written), the email goes out as HTML + text.
  test("saves the draft as written and sends formatted email", async () => {
    const { scheduleDraftSave, sendDraft } = await import("~/modules/mail/mail-draft-store")
    render(() => <MailCompose entityId="compose-1" />)
    fireEvent.input(screen.getByTestId("mail-compose-to"), { target: { value: "a@x.test" } })
    setMarkdown(await editableIn("mail-compose-editor"), "Bonjour **Anna**")
    await waitFor(() =>
      expect(vi.mocked(scheduleDraftSave)).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.objectContaining({ markdown: "Bonjour **Anna**" }),
      ),
    )
    fireEvent.click(screen.getByTestId("mail-compose-send"))
    await waitFor(() => expect(sendDraft).toHaveBeenCalled())
    expect(vi.mocked(sendDraft).mock.calls.at(-1)?.[2]).toMatchObject({
      htmlBody: '<p style="margin:0 0 1em">Bonjour <strong>Anna</strong></p>',
      textBody: "Bonjour Anna",
    })
  })

  // The body is written before the draft exists: the keystrokes share one
  // draft, and the text is never set back to an earlier keystroke's.
  test("typing before the draft exists creates one draft and keeps the text", async () => {
    const { createDraft } = await import("~/modules/mail/mail-draft-store")
    let land: (d: { id: string }) => void = () => {}
    vi.mocked(createDraft).mockClear()
    vi.mocked(createDraft).mockImplementationOnce(
      () => new Promise((resolve) => (land = resolve as typeof land)) as never,
    )
    render(() => <MailCompose entityId="compose-1" />)
    const editor = await editableIn("mail-compose-editor")
    setMarkdown(editor, "Bon")
    setMarkdown(editor, "Bonjour")
    land({ id: "draft-slow" })
    await nextTask()
    expect(createDraft).toHaveBeenCalledTimes(1)
    expect(editorOf(editor).getMarkdown()).toBe("Bonjour")
  })

  // A draft the earlier mail editor saved: its innerHTML, and that HTML's
  // plain text beside it. It must open with its content, formatting included.
  test("opens a draft the earlier mail editor saved, formatting included", async () => {
    const { drafts } = await import("~/modules/mail/mail-draft-store")
    const { htmlToText } = await import("@liaison/shared")
    const htmlBody = "Hi <b>Sam</b>,<div><br></div><ul><li>one</li><li>two</li></ul>"
    vi.mocked(drafts).mockReturnValue({
      "draft-old": {
        id: "draft-old",
        accountId: "a1",
        conversationId: null,
        replyToMessageId: null,
        to: [{ email: "sam@example.com" }],
        cc: [],
        bcc: [],
        subject: "Old draft",
        htmlBody,
        textBody: htmlToText(htmlBody),
        updatedAt: "2026-09-30T10:00:00Z",
      },
    } as never)
    try {
      render(() => <MailCompose entityId="draft-old" />)
      const editor = await editableIn("mail-compose-editor")
      await waitFor(() => expect(editorOf(editor).getMarkdown()).toContain("**Sam**"))
      expect(editorOf(editor).getMarkdown()).toContain("- one\n- two")
    } finally {
      vi.mocked(drafts).mockReturnValue({})
    }
  })
})

describe("MailCompose — dictation", () => {
  test("the mic sits immediately left of Send; the wand stays with the tools", async () => {
    installMic()
    installAudioContext()
    try {
      render(() => <MailCompose entityId="compose-1" />)
      const mic = await screen.findByTestId("voice-dictation-button")
      expect(mic.nextElementSibling).toBe(screen.getByTestId("mail-compose-send"))
      expect(screen.getByTestId("magic-wand").nextElementSibling).not.toBe(mic)
    } finally {
      removeMic()
    }
  })
})

describe("MailCompose — a prospect's mail", () => {
  test("shows what is recorded about a recipient who is a contact, even on a plain mail", async () => {
    composeCheck.answer = {
      commercial: false,
      footerLines: null,
      refusal: null,
      line: null,
      missingBasis: null,
      recipients: [
        {
          email: "lea@dealer.example",
          name: "Lea Martin",
          basis: "professional_interest",
          isConsumer: true,
          optedOutAt: null,
        },
      ],
    }
    render(() => <MailCompose entityId="compose-facts" />)
    fireEvent.input(screen.getByTestId("mail-compose-to"), {
      target: { value: "lea@dealer.example" },
    })
    const facts = await waitFor(() => screen.getByTestId("mail-compose-recipient-facts"), {
      timeout: 2000,
    })
    expect(facts.textContent).toBe(
      "Lea Martin · Basis: Professional interest · Consumer · Not opted out",
    )
    composeCheck.answer = null
  })

  test("shows the footer a prospect's mail carries as fixed text, with no way to remove it", async () => {
    composeCheck.answer = {
      commercial: true,
      footerLines: [
        "Org Test SAS, 1 rue de Test, 75001 Paris",
        "Pour ne plus recevoir de messages commerciaux de Org Test SAS : (lien de désinscription) ou répondez stop.",
      ],
      refusal: null,
      line: null,
    }
    render(() => <MailCompose entityId="compose-prospect" />)
    fireEvent.input(screen.getByTestId("mail-compose-to"), {
      target: { value: "buyer@prospect.example" },
    })
    const footer = await waitFor(() => screen.getByTestId("mail-compose-commercial-footer"), {
      timeout: 2000,
    })
    expect(footer.textContent).toContain("Org Test SAS, 1 rue de Test, 75001 Paris")
    expect(footer.textContent).toContain("(lien de désinscription) ou répondez stop.")
    expect(footer.querySelector("button, input, textarea, [contenteditable]")).toBeNull()
    expect(footer.closest("[data-testid=mail-compose-editor]")).toBeNull()
    composeCheck.answer = null
  })

  test("says calmly when no basis is recorded for a prospect, records one in one choice, and still lets the person send", async () => {
    const lines = [
      "Org Test SAS, 1 rue de Test, 75001 Paris",
      "To stop commercial messages from Org Test SAS: (opt-out link) or reply stop.",
    ]
    composeCheck.answer = {
      commercial: true,
      footerLines: lines,
      refusal: null,
      line: null,
      missingBasis: { contactId: "contact-9", name: "Ines Moreau" },
    }
    composeCheck.patches = []
    render(() => <MailCompose entityId="compose-no-basis" />)
    fireEvent.input(screen.getByTestId("mail-compose-to"), {
      target: { value: "ines@prospect.example" },
    })
    const line = await waitFor(() => screen.getByTestId("mail-compose-no-basis"), {
      timeout: 2000,
    })
    expect(line.textContent).toContain("No recorded basis for writing to Ines Moreau commercially")
    expect(line.className).not.toContain("red")
    expect((screen.getByTestId("mail-compose-send") as HTMLButtonElement).disabled).toBe(false)

    const asked = composeCheck.asked
    composeCheck.answer = {
      commercial: true,
      footerLines: lines,
      refusal: null,
      line: null,
      missingBasis: null,
    }
    fireEvent.change(screen.getByTestId("mail-compose-record-basis"), {
      target: { value: "professional_interest" },
    })
    await waitFor(() =>
      expect(composeCheck.patches).toEqual([
        { path: "/contacts/contact-9", body: { lawfulBasis: "professional_interest" } },
      ]),
    )
    await waitFor(() => expect(screen.queryByTestId("mail-compose-no-basis")).toBeNull(), {
      timeout: 2000,
    })
    expect(composeCheck.asked).toBeGreaterThan(asked)
    composeCheck.answer = null
  })

  test("says why a prospect who opted out cannot be written to", async () => {
    composeCheck.answer = {
      commercial: true,
      footerLines: null,
      refusal:
        "Nothing was sent. buyer@prospect.example opted out on 2026-03-02, and this is a commercial mail.",
      line: null,
    }
    render(() => <MailCompose entityId="compose-refused" />)
    fireEvent.input(screen.getByTestId("mail-compose-to"), {
      target: { value: "buyer@prospect.example" },
    })
    const refusal = await waitFor(() => screen.getByTestId("mail-compose-commercial-refusal"), {
      timeout: 2000,
    })
    expect(refusal.textContent).toContain("opted out on 2026-03-02")
    composeCheck.answer = null
  })
})
