// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal, type JSX } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { listUnsavedWork, resetUnsavedWork } from "~/lib/unsaved-work"
import { installAudioContext, installMic, removeMic } from "~/modules/assist/dictation-fakes"
import { installFakeBridge, liveSession, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { editorOf, typeInto } from "~/modules/editor/test-helpers"
import type { FileRow } from "~/modules/files/file-service"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { pendingPrefill, prefillThread, resetDockPrefill } from "~/modules/shell/dock-prefill"
import { mentionMarked } from "~/modules/shell/markdown-content"
import { WsProvider } from "~/modules/shell/WsContext"
import { type WsStatus, WsStatusContext } from "~/modules/shell/ws-status-context"
import ComposeBar from "~/modules/threads/ComposeBar"

// Uploads are held open by the test that needs them (a deferred per call, on
// the confirm step) and run through the REAL uploadFile, so they register as
// in flight exactly as in the app; no other test uploads. A test may also
// hold the upload session's creation open.
const uploads = vi.hoisted(() => ({
  pending: [] as Array<(row: FileRow) => void>,
  failures: [] as Array<(err: Error) => void>,
  sessionGate: null as Promise<void> | null,
}))
vi.mock("~/modules/files/file-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/files/file-service")>()
  const uploadApi = {
    post: (url: string) =>
      url === "/files/confirm"
        ? new Promise<FileRow>((resolve, reject) => {
            uploads.pending.push(resolve)
            uploads.failures.push(reject)
          })
        : Promise.resolve({
            uploadUrl: "https://storage.example.com/put",
            uploadMode: "direct",
            fileToken: "tok",
            storageKey: "k",
          }),
  } as unknown as Parameters<typeof actual.uploadFile>[0]
  return {
    ...actual,
    createUploadSession: async () => {
      if (uploads.sessionGate) await uploads.sessionGate
      return {
        id: "sess-1",
        targetApp: "kernel",
        targetEntityType: "message",
        targetEntityId: null,
      }
    },
    uploadFile: ((_api, file, parent, options) =>
      actual.uploadFile(uploadApi, file, parent, options)) as typeof actual.uploadFile,
  }
})

// Which conversation is the person's own agent DM (a guided tour sends there only).
const personalDm = vi.hoisted(() => ({ id: undefined as string | undefined }))
vi.mock("~/modules/threads/personal-dm-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/threads/personal-dm-store")>()),
  knownPersonalAgentDmId: () => personalDm.id,
}))

// The popup's search is not under test: a stub offers one row to pick
// (Tobias unless a test says otherwise), by click or by Enter.
const picker = vi.hoisted(() => ({
  item: null as Record<string, unknown> | null,
}))
const TOBIAS = { type: "user", id: "u-tobias", label: "Tobias Braun" }
vi.mock("~/modules/threads/MentionAutocomplete", () => ({
  MentionAutocomplete: (props: {
    query: string
    trigger: string
    onSelect: (item: unknown) => void
    onKeyDown?: (handler: (e: KeyboardEvent) => boolean) => void
  }) => {
    const pick = () => props.onSelect(picker.item ?? TOBIAS)
    props.onKeyDown?.((e) => {
      if (e.key !== "Enter") return false
      pick()
      return true
    })
    return (
      <button
        type="button"
        data-testid="mention-pick-tobias"
        data-query={`${props.trigger}${props.query}`}
        onClick={pick}
      />
    )
  },
}))

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
    }),
  ),
)

async function renderCompose(
  overrides: Partial<{
    onSend: (c: string) => unknown
    onTyping: () => void
    disabled: boolean
    threadId: string
    compact: boolean
    modelControl: () => JSX.Element
  }> = {},
) {
  const onSend = overrides.onSend ?? vi.fn()
  const onTyping = overrides.onTyping ?? vi.fn()

  const result = render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <ComposeBar
              onSend={onSend}
              onTyping={onTyping}
              disabled={overrides.disabled}
              threadId={overrides.threadId}
              compact={overrides.compact}
              modelControl={overrides.modelControl}
            />
          </ApiProvider>
        )}
      />
    </Router>
  ))

  const editor = await screen.findByRole("textbox", { name: "Write a message" })
  return {
    ...result,
    editor,
    onSend: onSend as ReturnType<typeof vi.fn>,
    onTyping: onTyping as ReturnType<typeof vi.fn>,
  }
}

/** Replace the message with `text`, typed. */
function typeInEditor(editor: HTMLElement, text: string) {
  const ed = editorOf(editor)
  ed.commands.clearContent()
  typeInto(ed, text)
}

/** Type more at the caret. */
function typeMore(editor: HTMLElement, text: string) {
  typeInto(editorOf(editor), text)
}

function renderWithStatus(initial: WsStatus, unstableInitial = false) {
  const [status, setStatus] = createSignal<WsStatus>(initial)
  const [unstable, setUnstable] = createSignal(unstableInitial)
  const result = render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <WsStatusContext.Provider value={status}>
              <WsProvider send={vi.fn()} status={status} unstable={unstable}>
                <ComposeBar onSend={vi.fn()} />
              </WsProvider>
            </WsStatusContext.Provider>
          </ApiProvider>
        )}
      />
    </Router>
  ))
  return { ...result, setStatus, setUnstable }
}

describe("ComposeBar", () => {
  it("compose-bar.dock is a footer DockedComposer, the bottom row the shell lifts above the keyboard", async () => {
    const { editor } = await renderCompose()
    const bar = editor.closest("[data-testid=compose-dropzone]") as HTMLElement
    expect(bar.getAttribute("data-composer-dock")).toBe("footer")
  })

  it("compose-bar.compact hugs the panel with 8px, not a band around a bordered box", async () => {
    // In the dock the composer sat in a bordered Composer card, inset inside
    // this bar's own px-4 py-3 band, inside the dock thread view's p-2: three
    // frames and roughly 12px of dead space on every side of a 340px panel.
    const { editor } = await renderCompose({ compact: true })
    const bar = editor.closest("[data-testid=compose-dropzone]") as HTMLElement
    expect(bar.className).toContain("px-2")
    expect(bar.className).toContain("pb-2")
    expect(bar.className).not.toContain("px-4")
    // The bar has no band of its own: no border, no fill. The card is the
    // one frame and the conversation shows round it.
    expect(bar.className).not.toContain("border-t")
    expect(bar.className).not.toContain("bg-surface")
  })

  it("compose-bar.dock-clearance keeps the full surface's card above the dock's floating pills", async () => {
    // The dock strip floats over the main panel's bottom right with no band
    // reserved; with 14px under it the card's corner and the send button sat
    // under the Chats pill. The shell publishes the strip's height.
    const { editor } = await renderCompose()
    const bar = editor.closest("[data-testid=compose-dropzone]") as HTMLElement
    expect(bar.className.split(/\s+/)).toContain(
      "pb-[max(0.875rem,var(--shell-dock-clearance,0px))]",
    )
    // Inside the dock's own panel the strip is below, not over it.
    cleanup()
    const compact = await renderCompose({ compact: true })
    const dockBar = compact.editor.closest("[data-testid=compose-dropzone]") as HTMLElement
    expect(dockBar.className).not.toContain("--shell-dock-clearance")
  })

  it("compose-bar.card is a flat card whose ring overrides the shared Composer's", async () => {
    const { editor } = await renderCompose()
    const card = editor.closest("[data-composer]") as HTMLElement
    const cls = card.className.split(/\s+/)
    expect(cls).toContain("rounded-[18px]")
    expect(cls).toContain("bg-elevated")
    expect(cls).toContain("ring-border-strong")
    // Framed by the 1px ring alone: no drop shadow at rest.
    expect(cls).not.toContain("shadow-composer")
    expect(cls).toContain("focus-within:shadow-composer-focus")
    // The shared primitive's defaults are merged away, not stacked under.
    expect(cls).not.toContain("ring-border")
    expect(cls).not.toContain("bg-surface-sunken")
    expect(cls).not.toContain("rounded-xl")
    expect(cls).not.toContain("focus-within:ring-2")
  })

  it("compose-bar.send is a 36px rounded square with its own disabled colours, not a faded accent", async () => {
    const { editor } = await renderCompose()
    const send = screen.getByTestId("compose-send") as HTMLButtonElement
    expect(send.disabled).toBe(true)
    const cls = send.className.split(/\s+/)
    expect(cls).toContain("h-9")
    expect(cls).toContain("w-9")
    expect(cls).toContain("rounded-xl")
    expect(cls).toContain("disabled:bg-surface-active")
    expect(cls).toContain("disabled:text-text-tertiary")
    expect(send.className).not.toContain("opacity")
    typeInEditor(editor, "hi")
    expect(send.disabled).toBe(false)
  })

  it("compose-bar.divider is drawn only when a control sits on its right", async () => {
    await renderCompose()
    expect(screen.queryByTestId("compose-controls-divider")).toBeNull()
    cleanup()
    await renderCompose({ modelControl: () => <span>model</span> })
    expect(screen.getByTestId("compose-controls-divider")).toBeTruthy()
  })

  it("compose-bar.editor keeps the whole width in a dock panel instead of collapsing", async () => {
    // In the dock the controls (wand, emoji, attach, the model chip) shared
    // the field's row and kept their intrinsic width: a six line draft
    // rendered as a one character column. The field is a LINE OF ITS OWN now,
    // above the controls, so nothing can take width from it at any panel size.
    const { editor } = await renderCompose({ compact: true })
    typeInEditor(editor, Array.from({ length: 6 }, (_, i) => `line ${i + 1}`).join("\n"))
    const field = editor.closest("[data-compose-field]") as HTMLElement
    expect(field.className).toContain("w-full")
    expect(field.className).toContain("min-w-0")
    expect(field.className).not.toContain("basis-48")
    const controls = screen.getByTestId("compose-controls-row")
    expect(controls.contains(field)).toBe(false)
    // The cap still holds: eight lines of the 22px leading, then scroll.
    expect(editor.className).toContain("max-h-[176px]")
    expect(editor.className).toContain("overflow-y-auto")
  })

  it("compose-bar.editor grows to eight lines and then scrolls", async () => {
    const { editor } = await renderCompose()
    typeInEditor(editor, Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"))
    // The leading is 22px, so the cap is eight lines. jsdom lays nothing out;
    // what is pinned is that the field HAS a cap and scrolls past it rather
    // than growing without bound inside a 460px dock panel.
    expect(editor.className).toContain("max-h-[176px]")
    expect(editor.className).toContain("text-[15px]")
    expect(editor.className).toContain("overflow-y-auto")
    expect(editor.className).not.toContain("max-h-[160px]")
  })

  afterEach(() => {
    cleanup()
    picker.item = null
  })

  describe("WS offline indicator", () => {
    it("shows 'Reconnecting…' banner when WS disconnected", async () => {
      renderWithStatus("disconnected")
      expect(screen.getByTestId("compose-offline-banner").textContent).toMatch(/reconnect/i)
    })

    it("names the likely cause while the connection keeps dropping", async () => {
      const { setUnstable } = renderWithStatus("reconnecting", true)
      const banner = screen.getByTestId("compose-offline-banner")
      expect(banner.textContent).toBe("Reconnecting… (connection keeps dropping, VPN?)")
      setUnstable(false)
      await waitFor(() =>
        expect(screen.getByTestId("compose-offline-banner").textContent).toBe("Reconnecting…"),
      )
    })

    it("send button is disabled and has offline title when WS disconnected", async () => {
      renderWithStatus("disconnected")
      const btn = screen.getByTestId("compose-send") as HTMLButtonElement
      expect(btn.disabled).toBe(true)
      expect(btn.getAttribute("title") ?? "").toMatch(/offline/i)
    })

    it("banner clears on reconnect", async () => {
      const { setStatus } = renderWithStatus("disconnected")
      setStatus("connected")
      await waitFor(() => expect(screen.queryByTestId("compose-offline-banner")).toBeNull())
    })

    it("no banner when WS connected (default context fallback)", async () => {
      render(() => (
        <Router>
          <Route
            path="/*"
            component={() => (
              <ApiProvider>
                <ComposeBar onSend={vi.fn()} />
              </ApiProvider>
            )}
          />
        </Router>
      ))
      expect(screen.queryByTestId("compose-offline-banner")).toBeNull()
    })
  })

  describe("a prefill from the dock", () => {
    it("lands in its own conversation's field once and is never sent", async () => {
      prefillThread("thread-prefill", "Maison Delorme: Does the rest still fit?")
      const { editor, onSend } = await renderCompose({ threadId: "thread-prefill" })
      await waitFor(() =>
        expect(editor.textContent).toBe("Maison Delorme: Does the rest still fit?"),
      )
      expect(onSend).not.toHaveBeenCalled()
      expect(pendingPrefill("thread-prefill")).toBeNull()
    })

    it("another conversation's composer does not take it", async () => {
      prefillThread("thread-elsewhere", "Not for this one")
      const { editor } = await renderCompose({ threadId: "thread-here" })
      await new Promise((r) => setTimeout(r, 20))
      expect(editor.textContent).toBe("")
      expect(pendingPrefill("thread-elsewhere")?.text).toBe("Not for this one")
      resetDockPrefill()
    })
  })

  describe("Enter vs Shift+Enter", () => {
    it("Enter sends the message", async () => {
      const { editor, onSend } = await renderCompose()
      typeInEditor(editor, "Hello world")

      fireEvent.keyDown(editor, { key: "Enter" })

      expect(onSend).toHaveBeenCalledWith("Hello world", undefined)
    })

    it("Enter does not send when editor is empty", async () => {
      const { editor, onSend } = await renderCompose()
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).not.toHaveBeenCalled()
    })

    it("Enter does not send whitespace-only content", async () => {
      const { editor, onSend } = await renderCompose()
      typeInEditor(editor, "   ")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).not.toHaveBeenCalled()
    })

    it("Shift+Enter does not send (allows newline)", async () => {
      const { editor, onSend } = await renderCompose()
      typeInEditor(editor, "line one")
      fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })
      expect(onSend).not.toHaveBeenCalled()
    })

    it("clears editor content after send", async () => {
      const { editor } = await renderCompose()
      typeInEditor(editor, "sent message")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(editor.textContent).toBe("")
    })

    // A send the host held back before anything reached the server (a
    // conversation that runs on this machine whose session could not start)
    // answers false, and the person gets their draft back to send again.
    it("hands the draft back when the host says the message was not sent", async () => {
      const { editor } = await renderCompose({ onSend: () => Promise.resolve(false) })
      typeInEditor(editor, "make the monthly report")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(editor.textContent).toBe("")
      await waitFor(() => expect(editor.textContent).toBe("make the monthly report"))
    })

    it("keeps the field empty when the host says the message was sent", async () => {
      const { editor } = await renderCompose({ onSend: () => Promise.resolve(true) })
      typeInEditor(editor, "sent for real")
      fireEvent.keyDown(editor, { key: "Enter" })
      await Promise.resolve()
      await Promise.resolve()
      expect(editor.textContent).toBe("")
    })

    it("never overwrites what the person started typing after a held back send", async () => {
      let answer: (posted: boolean) => void = () => {}
      const { editor } = await renderCompose({
        onSend: () => new Promise<boolean>((resolve) => (answer = resolve)),
      })
      typeInEditor(editor, "first")
      fireEvent.keyDown(editor, { key: "Enter" })
      typeInEditor(editor, "second")
      answer(false)
      await Promise.resolve()
      await Promise.resolve()
      expect(editor.textContent).toBe("second")
    })
  })

  // A message is sent as typed: the editor neither escapes plain text nor
  // spells a line break its own way, so a message without formatting is
  // stored byte for byte as the plain field sent it.
  describe("the message as typed", () => {
    it("sends plain text exactly as typed, markdown characters included", async () => {
      const { editor, onSend } = await renderCompose()
      const typed = "snake_case_name, 2*3*4, [x] C:\\temp\\new <b>a & b</b> ~ok~ #1 a > b"
      typeInEditor(editor, typed)
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith(typed, undefined)
    })

    it("Shift+Enter breaks the line with a newline, and a blank line stays one", async () => {
      const { editor, onSend } = await renderCompose()
      typeInEditor(editor, "line 1")
      fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })
      typeMore(editor, "line 2")
      fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })
      fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })
      typeMore(editor, "line 4")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith("line 1\nline 2\n\nline 4", undefined)
    })

    it("typed markdown and shortcuts format the message, with the Aa row closed", async () => {
      const { editor, onSend } = await renderCompose()
      expect(screen.queryByTestId("rich-editor.toolbar")).toBeNull()
      typeInEditor(editor, "**gras** et ")
      fireEvent.keyDown(editor, { key: "u", ctrlKey: true })
      typeMore(editor, "souligné")
      expect(editor.querySelector("strong")?.textContent).toBe("gras")
      expect(editor.textContent).not.toContain("**")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith("**gras** et ++souligné++", undefined)
    })

    it("Shift+Enter in a list starts the next item, and on an empty one leaves the list", async () => {
      const { editor, onSend } = await renderCompose()
      typeInEditor(editor, "- un")
      fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })
      typeMore(editor, "deux")
      fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })
      fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })
      typeMore(editor, "fin")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith("- un\n- deux\n\nfin", undefined)
    })

    it("a marker typed out of habit on the next item is not a second one", async () => {
      const { editor, onSend } = await renderCompose()
      typeInEditor(editor, "- un")
      fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })
      typeMore(editor, "- deux")
      fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })
      typeMore(editor, "* trois")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith("- un\n- deux\n- trois", undefined)
      typeInEditor(editor, "1. un")
      fireEvent.keyDown(editor, { key: "Enter", shiftKey: true })
      typeMore(editor, "2. deux")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenLastCalledWith("1. un\n2. deux", undefined)
    })

    it("a file name, a domain or an address stays text; only a typed URL links", async () => {
      const { editor, onSend } = await renderCompose()
      typeInEditor(editor, "see README.md, init.py, example.com and a@b.io at https://x.io/a_b ok")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith(
        "see README.md, init.py, example.com and a@b.io at https://x.io/a_b ok",
        undefined,
      )
      expect(editor.querySelectorAll("a")).toHaveLength(0)
    })
  })

  // Typing converts emphasis only where the renderer (marked) shows emphasis
  // too: what a message means never changes on the way out. Literal input is
  // sent byte for byte as typed.
  describe("typed emphasis follows the renderer", () => {
    const LITERAL = [
      "_private_var is set",
      "snake_case_word here",
      "my_var_name, ok",
      "file_name.txt",
      "x_a_ y",
      "_x_y z",
      "__a__b c",
      "foo__bar__ x",
      "a*b*c",
      "*a * b",
      "x * a* y",
      "_ a_",
      "2*3*4",
      "~ok~",
    ]
    const EMPHASIS: [string, string, string][] = [
      ["*x* y", "*x* y", "em"],
      ["**x** y", "**x** y", "strong"],
      ["**a**b", "**a**b", "strong"],
      ["_x_ y", "*x* y", "em"],
      ["a _x_, b", "a *x*, b", "em"],
      ["__x__ y", "**x** y", "strong"],
      ["call __init__ now", "call **init** now", "strong"],
    ]
    const rendered = (md: string) => mentionMarked.parseInline(md, { async: false })

    it.each(LITERAL)("%j stays literal and is sent as typed", async (typed) => {
      const { editor, onSend } = await renderCompose()
      typeInEditor(editor, typed)
      expect(editor.querySelector("em, strong")).toBeNull()
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith(typed, undefined)
    })

    it.each(EMPHASIS)(
      "%j shows and sends the emphasis marked renders",
      async (typed, sent, tag) => {
        const { editor, onSend } = await renderCompose()
        typeInEditor(editor, typed)
        expect(editor.querySelector(tag)).not.toBeNull()
        expect(rendered(typed)).toContain(`<${tag}>`)
        fireEvent.keyDown(editor, { key: "Enter" })
        expect(onSend).toHaveBeenCalledWith(sent, undefined)
        expect(rendered(sent)).toBe(rendered(typed))
      },
    )
  })

  describe("mentions", () => {
    async function pickAfter(typed: string, item: Record<string, unknown> | null = null) {
      picker.item = item
      const rendered = await renderCompose()
      typeInEditor(rendered.editor, typed)
      fireEvent.click(await screen.findByTestId("mention-pick-tobias"))
      return rendered
    }

    it("offers what follows @ or #, and only at the start of a word", async () => {
      const { editor } = await renderCompose()
      typeInEditor(editor, "Hi @tob")
      expect(screen.getByTestId("mention-pick-tobias").dataset.query).toBe("@tob")
      typeMore(editor, " ")
      expect(screen.queryByTestId("mention-pick-tobias")).toBeNull()
      typeMore(editor, "see #des")
      expect(screen.getByTestId("mention-pick-tobias").dataset.query).toBe("#des")
      typeInEditor(editor, "mail@example")
      expect(screen.queryByTestId("mention-pick-tobias")).toBeNull()
    })

    it("a picked person becomes a pill, sent as the mention syntax", async () => {
      const { editor, onSend } = await pickAfter("Hey @tob")
      const pill = editor.querySelector(".mention-pill")
      expect(pill?.textContent).toBe("@Tobias Braun")
      expect(screen.queryByTestId("mention-pick-tobias")).toBeNull()
      typeMore(editor, "check this")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith(
        "Hey @[Tobias Braun](user:u-tobias) check this",
        undefined,
      )
    })

    // Walk 3: a picked mention is followed by a space, and the person, used
    // to typing one after a name, typed another: "@Tobias Braun  please".
    // The message carries exactly the spacing typed: a space typed right
    // after the inserted one is taken as that space.
    it("a space typed after a picked mention is not doubled", async () => {
      const { editor, onSend } = await pickAfter("Hi @tob")
      typeMore(editor, " please")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith("Hi @[Tobias Braun](user:u-tobias) please", undefined)
    })

    it("a second space typed after a picked mention is kept", async () => {
      const { editor, onSend } = await pickAfter("@tob")
      typeMore(editor, "  x")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith("@[Tobias Braun](user:u-tobias)  x", undefined)
    })

    it("a pick puts the caret back in the text at once, for the next key", async () => {
      const { editor } = await pickAfter("@tob")
      expect(document.activeElement).toBe(editor)
    })

    it("a word typed straight after a picked mention keeps the inserted space", async () => {
      const { editor, onSend } = await pickAfter("@tob")
      typeMore(editor, "please")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith("@[Tobias Braun](user:u-tobias) please", undefined)
    })

    it("Enter in the open picker picks, it does not send", async () => {
      const { editor, onSend } = await renderCompose()
      typeInEditor(editor, "@tob")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).not.toHaveBeenCalled()
      expect(editor.querySelector(".mention-pill")).not.toBeNull()
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith("@[Tobias Braun](user:u-tobias)", undefined)
    })

    it("a thread reads #Name and is sent as its reference", async () => {
      const { editor, onSend } = await pickAfter("see #des", {
        type: "thread",
        id: "t1",
        label: "Design",
      })
      expect(editor.querySelector(".mention-pill")?.textContent).toBe("#Design")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith("see @[Design](thread:t1)", undefined)
    })

    it("an agent is sent by its handle, an approval by its request handle", async () => {
      const { editor, onSend } = await pickAfter("@fin", {
        type: "agent",
        id: "a1",
        label: "Finance",
        secondaryLabel: "@finance",
      })
      typeMore(editor, "and @req")
      // As /api/mentions returns it: titled by its handle, its uuid below.
      picker.item = {
        type: "approval_request",
        id: "ar-1",
        label: "request-0001",
        secondaryLabel: "ar-1",
      }
      fireEvent.click(screen.getByTestId("mention-pick-tobias"))
      expect(editor.querySelector(".mention-pill")?.textContent).toBe("@finance")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith(
        "@[finance](agent:a1) and @[request-0001](kernel:approval_request:ar-1)",
        undefined,
      )
    })
  })

  describe("the Aa row", () => {
    it("shows and hides one row of formatting tools, and remembers it", async () => {
      localStorage.removeItem("liaison:composeFormatting")
      const { editor, onSend, unmount } = await renderCompose()
      const aa = screen.getByTestId("compose-formatting")
      expect(aa.getAttribute("aria-pressed")).toBe("false")
      expect(screen.queryByTestId("rich-editor.toolbar")).toBeNull()
      fireEvent.click(aa)
      expect(aa.getAttribute("aria-pressed")).toBe("true")
      expect(screen.getByTestId("rich-editor.toolbar")).toBeTruthy()
      expect(localStorage.getItem("liaison:composeFormatting")).toBe("1")

      typeInEditor(editor, "important")
      editorOf(editor).commands.selectAll()
      fireEvent.click(screen.getByTestId("rich-editor.tool-bold"))
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith("**important**", undefined)

      unmount()
      await renderCompose()
      expect(screen.getByTestId("rich-editor.toolbar")).toBeTruthy()
      fireEvent.click(screen.getByTestId("compose-formatting"))
      expect(screen.queryByTestId("rich-editor.toolbar")).toBeNull()
      expect(localStorage.getItem("liaison:composeFormatting")).toBeNull()
    })
  })

  it("links with Cmd+K while the Aa row is closed", async () => {
    localStorage.removeItem("liaison:composeFormatting")
    const { editor, onSend } = await renderCompose()
    typeInEditor(editor, "the spec")
    editorOf(editor).commands.selectAll()
    fireEvent.keyDown(editor, { key: "k", ctrlKey: true })
    const input = (await screen.findByTestId("rich-editor.link-input")) as HTMLInputElement
    fireEvent.input(input, { target: { value: "example.com/spec" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.queryByTestId("rich-editor.toolbar")).toBeNull()
    fireEvent.keyDown(editor, { key: "Enter" })
    expect(onSend).toHaveBeenCalledWith("[the spec](https://example.com/spec)", undefined)
  })

  describe("emoji picker", () => {
    it("renders an emoji picker trigger in the compose toolbar", async () => {
      await renderCompose()
      expect(screen.getByTestId("compose-emoji")).toBeTruthy()
    })

    it("inserts a chosen emoji at the caret and sends it", async () => {
      const { editor, onSend } = await renderCompose()
      typeInEditor(editor, "nice work")
      editorOf(editor).commands.setTextSelection(5)

      fireEvent.click(screen.getByTestId("compose-emoji"))
      const emojiBtn = await screen.findByLabelText("Insert 🔥")
      fireEvent.click(emojiBtn)

      expect(editor.textContent).toBe("nice🔥 work")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith("nice🔥 work", undefined)
    })
  })

  describe("paste", () => {
    const clipboard = (data: Partial<DataTransfer>) => ({
      types: [],
      items: [],
      files: [],
      getData: () => "",
      ...data,
    })

    // VS Code copies one <div> per line (white-space: pre), which read as
    // paragraphs: each line went out with a blank line after it.
    const CODE = "const a = 1\nif (a) {\n  run(b_c, *d)\n}"
    const codeHtml = (attrs: string) =>
      `<div ${attrs}>${CODE.split("\n")
        .map((line) => `<div><span>${line}</span></div>`)
        .join("")}</div>`

    it.each([
      [
        "VS Code",
        ["text/plain", "text/html", "vscode-editor-data"],
        codeHtml('style="color: #ccc"'),
      ],
      ["a code view", ["text/plain", "text/html"], `<pre>${CODE}</pre>`],
      [
        "an editor's pre styling",
        ["text/plain", "text/html"],
        codeHtml('style="white-space: pre;"'),
      ],
    ])("pastes code from %s as a code block, line for line", async (_from, types, html) => {
      const { editor, onSend } = await renderCompose()
      fireEvent.paste(editor, {
        clipboardData: clipboard({
          types,
          getData: (type: string) =>
            type === "text/html" ? html : type === "text/plain" ? `${CODE}\n` : "",
        }),
      })
      // Seen as code while typing, and typing goes on below it.
      expect(editor.querySelector("pre code")?.textContent).toBe(CODE)
      typeInto(editorOf(editor), "ok?")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith(`\`\`\`\n${CODE}\n\`\`\`\n\nok?`, undefined)
    })

    it("pastes one line of code as text, inline", async () => {
      const { editor, onSend } = await renderCompose()
      typeInto(editorOf(editor), "voir ")
      fireEvent.paste(editor, {
        clipboardData: clipboard({
          types: ["text/plain", "text/html", "vscode-editor-data"],
          getData: (type: string) =>
            type === "text/html"
              ? codeHtml('style="white-space: pre;"').replace(CODE, "run(b_c, *d)")
              : type === "text/plain"
                ? "run(b_c, *d)"
                : "",
        }),
      })
      expect(editor.querySelector("pre")).toBeNull()
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith("voir run(b_c, *d)", undefined)
    })

    it("fences a pasted block that holds a fence with a longer one", async () => {
      const { editor, onSend } = await renderCompose()
      const md = "Le README:\n```sh\nbun i\n```"
      fireEvent.paste(editor, {
        clipboardData: clipboard({
          types: ["text/plain", "text/html"],
          getData: (type: string) =>
            type === "text/html" ? `<pre>${md}</pre>` : type === "text/plain" ? md : "",
        }),
      })
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith(`\`\`\`\`\n${md}\n\`\`\`\``, undefined)
    })

    // Chat views, mail clients and rich editors style prose `pre-wrap`; only
    // `pre` (or a <pre>) marks code. A pasted message was stuck as a code block.
    it("pastes prose styled pre-wrap as text, not a code block", async () => {
      const { editor, onSend } = await renderCompose()
      fireEvent.paste(editor, {
        clipboardData: clipboard({
          types: ["text/plain", "text/html"],
          getData: (type: string) =>
            type === "text/html"
              ? '<div style="white-space: pre-wrap;"><p>Salut Maxime,</p><p>trois choses.</p></div>'
              : type === "text/plain"
                ? "Salut Maxime,\ntrois choses."
                : "",
        }),
      })
      expect(editor.querySelector("pre")).toBeNull()
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend.mock.calls[0]?.[0]).not.toContain("```")
    })

    it("pastes a VS Code markdown or plain-text tab as text, line for line", async () => {
      const { editor, onSend } = await renderCompose()
      const prose = "Salut Maxime,\ntrois choses."
      fireEvent.paste(editor, {
        clipboardData: clipboard({
          types: ["text/plain", "text/html", "vscode-editor-data"],
          getData: (type: string) =>
            type === "text/html"
              ? codeHtml('style="white-space: pre;"').replace(CODE, prose)
              : type === "text/plain"
                ? prose
                : type === "vscode-editor-data"
                  ? '{"version":1,"isFromEmptySelection":false,"mode":"markdown"}'
                  : "",
        }),
      })
      expect(editor.querySelector("pre")).toBeNull()
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith(prose, undefined)
    })

    it("turns a code block back into text with Backspace at its start", async () => {
      const { editor, onSend } = await renderCompose()
      typeInto(editorOf(editor), "voir")
      fireEvent.paste(editor, {
        clipboardData: clipboard({
          types: ["text/plain", "text/html"],
          getData: (type: string) =>
            type === "text/html" ? `<pre>${CODE}</pre>` : type === "text/plain" ? CODE : "",
        }),
      })
      const ed = editorOf(editor)
      let start = -1
      ed.state.doc.descendants((node, pos) => {
        if (node.type.name === "codeBlock") start = pos + 1
      })
      ed.commands.setTextSelection(start)
      fireEvent.keyDown(editor.querySelector(".ProseMirror") ?? editor, { key: "Backspace" })
      // Its own paragraph, each line on its own line (not one run-on line).
      expect(editor.querySelector("pre")).toBeNull()
      const lines = editor.querySelectorAll("p")[1]
      expect(lines?.querySelectorAll("br")).toHaveLength(3)
      expect(lines?.textContent).toBe(CODE.replaceAll("\n", ""))
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith(`voir\n\n${CODE}`, undefined)
    })

    it("keeps the formatting of a document's paste", async () => {
      const { editor, onSend } = await renderCompose()
      fireEvent.paste(editor, {
        clipboardData: clipboard({
          types: ["text/plain", "text/html"],
          getData: (type: string) =>
            type === "text/html"
              ? "<p><b>Gras</b> et suite</p>"
              : type === "text/plain"
                ? "Gras et suite"
                : "",
        }),
      })
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith("**Gras** et suite", undefined)
    })

    it("pastes text into the message", async () => {
      const { editor } = await renderCompose()
      fireEvent.paste(editor, {
        clipboardData: clipboard({
          types: ["text/plain"],
          getData: (type: string) => (type === "text/plain" ? "pasted text" : ""),
        }),
      })
      expect(editor.textContent).toContain("pasted text")
    })

    it("pasted plain text lands at the caret exactly as copied", async () => {
      const { editor, onSend } = await renderCompose()
      typeInEditor(editor, "x ")
      const copied = 'line1\nline2\n\nline4 _a_ \\* <img src=x onerror="y"> end'
      fireEvent.paste(editor, {
        clipboardData: clipboard({
          types: ["text/plain"],
          getData: (type: string) => (type === "text/plain" ? copied : ""),
        }),
      })
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).toHaveBeenCalledWith(`x ${copied}`, undefined)
    })

    it("stages a pasted file instead of writing it into the text", async () => {
      uploads.pending = []
      const { editor } = await renderCompose()
      const file = new File(["x"], "shot.pdf", { type: "application/pdf" })
      fireEvent.paste(editor, {
        clipboardData: clipboard({
          types: ["Files"],
          items: [{ kind: "file", getAsFile: () => file }] as unknown as DataTransferItemList,
        }),
      })
      await waitFor(() => expect(uploads.pending).toHaveLength(1))
      expect(editor.textContent).toBe("")
      // Settled, so no upload is left in flight for the next test.
      uploads.pending[0]({
        id: "file-p",
        filename: "shot.pdf",
        sizeBytes: 1,
        mimeType: "application/pdf",
        thumbnailKey: null,
        entityType: "file_upload_session",
        entityId: "sess-1",
      })
      await waitFor(() => expect(screen.queryByTestId("composer-attachment-uploading")).toBeNull())
    })
  })

  describe("typing indicator", () => {
    it("emits onTyping on first input", async () => {
      const { editor, onTyping } = await renderCompose()
      typeInEditor(editor, "hi")
      expect(onTyping).toHaveBeenCalledTimes(1)
    })

    it("throttles onTyping to 3s intervals", async () => {
      vi.useFakeTimers()
      const { editor, onTyping } = await renderCompose()

      typeInEditor(editor, "a")
      expect(onTyping).toHaveBeenCalledTimes(1)

      // Input again immediately — should NOT re-emit
      typeInEditor(editor, "ab")
      expect(onTyping).toHaveBeenCalledTimes(1)

      // Advance past the 3s throttle
      vi.advanceTimersByTime(3001)
      typeInEditor(editor, "abc")
      expect(onTyping).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
    })

    it("resets typing throttle after send", async () => {
      const { editor, onTyping } = await renderCompose()

      typeInEditor(editor, "first")
      expect(onTyping).toHaveBeenCalledTimes(1)

      // Send
      fireEvent.keyDown(editor, { key: "Enter" })

      // Type again immediately — should emit because send resets the timer
      typeInEditor(editor, "second")
      expect(onTyping).toHaveBeenCalledTimes(2)
    })
  })

  describe("the row at phone width", () => {
    // The walk measured the editable field at 122px inside a 402px viewport:
    // the wand, the emoji button, a labelled Attach and the send circle all
    // kept their desktop width, and the placeholder was cut mid-word. What is
    // pinned here is that the two widest pieces of text are gated on the
    // shell's own phone boundary (640px) while the field itself keeps
    // growing; jsdom lays nothing out, so the measured width is read off the
    // simulator.
    const phoneOnly = (el: Element | null) =>
      (el?.getAttribute("class") ?? "").includes("sm:hidden")
    const wideOnly = (el: Element | null) => {
      const cls = el?.getAttribute("class") ?? ""
      return cls.includes("hidden") && cls.includes("sm:inline")
    }

    it("shows the short placeholder at phone width and the full hint above it", async () => {
      await renderCompose()
      const placeholder = document.querySelector("[data-compose-placeholder]")
      expect(placeholder).not.toBeNull()
      expect(placeholder?.textContent).toContain("Write a message")
      const [short, full] = [...(placeholder?.children ?? [])]
      expect(short.textContent).toBe("Write a message")
      expect(phoneOnly(short)).toBe(true)
      expect(full.textContent).toContain("(@ people, # threads)")
      expect(wideOnly(full)).toBe(true)
      // A placeholder that still does not fit ends in an ellipsis instead of
      // wrapping to a second line and being cut mid-word.
      expect(placeholder?.getAttribute("class")).toContain("truncate")
    })

    it("attaches through a `+` rather than a labelled Attach button", async () => {
      await renderCompose()
      const plus = screen.getByTestId("composer-plus")
      expect(plus.getAttribute("aria-label")).toBe("Add attachment")
      // The labelled button is gone from the row: the file input it wrapped
      // is mounted out of sight and the `+` is what clicks it.
      expect(screen.queryByTestId("attachment-upload-button")?.closest(".hidden")).toBeTruthy()
    })

    it("gives the field the whole first line", async () => {
      await renderCompose()
      const field = screen
        .getByRole("textbox", { name: "Write a message" })
        .closest("[data-compose-field]")
      const cls = field?.getAttribute("class") ?? ""
      expect(cls).toContain("w-full")
      expect(cls).toContain("min-w-0")
    })
  })

  // The send control lives at the far right of the CONTROL line now, under
  // the field rather than beside it: there is no tall scroll box left for it
  // to float against.
  describe("the send control's place", () => {
    it("sits at the right hand end of the control row, never inside the field", async () => {
      await renderCompose()
      const send = screen.getByTestId("compose-send")
      const controls = screen.getByTestId("compose-controls-row")
      expect(controls.contains(send)).toBe(true)
      expect(send.parentElement?.getAttribute("class") ?? "").toContain("ml-auto")
      const field = screen.getByTestId("compose-editor").closest("[data-compose-field]")
      expect(field?.contains(send)).toBe(false)
    })
  })

  // THE FALSIFIABLE SHAPE OF CARDS 61, 104 AND 24. Both assertions fail
  // against the one row composer this replaced: there the field sat BETWEEN
  // the controls (so no control row followed it, and the row contained it),
  // and attaching was a labelled button wrapping its own input rather than a
  // `+` that clicks a hidden one.
  describe("staged files", () => {
    const pdfRow = (id: string, filename: string): FileRow => ({
      id,
      filename,
      sizeBytes: 1,
      mimeType: "application/pdf",
      thumbnailKey: null,
      entityType: "file_upload_session",
      entityId: "sess-1",
    })

    // Sending while a picked file was still uploading sent the message
    // WITHOUT it (the file was not on the session yet). The send waited for
    // it, but a press meanwhile did nothing and had to be repeated: it now
    // QUEUES, and the message goes out by itself with the file.
    const tick = () => new Promise((r) => setTimeout(r, 20))
    const pickLate = async (editor: HTMLElement, name = "late.pdf") => {
      const bar = editor.closest("[data-testid=compose-dropzone]") as HTMLElement
      fireEvent.drop(bar, {
        dataTransfer: { files: [new File(["x"], name, { type: "application/pdf" })] },
      })
      await waitFor(() => expect(uploads.pending.length).toBeGreaterThan(0))
    }

    it("Enter while a file uploads queues the send, which goes out with the file", async () => {
      uploads.pending = []
      uploads.failures = []
      const { editor, onSend } = await renderCompose()
      await pickLate(editor)

      typeInEditor(editor, "sending now")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect(onSend).not.toHaveBeenCalled()
      expect(editor.textContent).toBe("sending now")
      const send = screen.getByTestId("compose-send") as HTMLButtonElement
      expect(send.dataset.queued).toBe("true")
      expect(send.getAttribute("aria-pressed")).toBe("true")
      expect(send.getAttribute("aria-label")).toBe(
        "Sending when files finish uploading. Press again to cancel",
      )

      uploads.pending[0](pdfRow("file-1", "late.pdf"))
      await waitFor(() =>
        expect(onSend).toHaveBeenCalledWith("sending now", { attachmentSessionId: "sess-1" }),
      )
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(editor.textContent).toBe("")
      expect(send.dataset.queued).toBeUndefined()
    })

    it("the send button queues while a file uploads, and a second press cancels", async () => {
      uploads.pending = []
      uploads.failures = []
      const { editor, onSend } = await renderCompose()
      await pickLate(editor)
      typeInEditor(editor, "sending now")

      const send = screen.getByTestId("compose-send") as HTMLButtonElement
      expect(send.disabled).toBe(false)
      expect(send.getAttribute("aria-label")).toBe("Send when files finish uploading")
      expect(send.getAttribute("aria-pressed")).toBe("false")
      fireEvent.click(send)
      expect(send.getAttribute("aria-pressed")).toBe("true")
      fireEvent.click(send)
      expect(send.getAttribute("aria-pressed")).toBe("false")

      uploads.pending[0](pdfRow("file-1", "late.pdf"))
      await waitFor(() => expect(send.getAttribute("aria-label")).toBe("Send message"))
      await tick()
      expect(onSend).not.toHaveBeenCalled()
      expect(editor.textContent).toBe("sending now")
    })

    it("editing the text cancels a queued send", async () => {
      uploads.pending = []
      uploads.failures = []
      const { editor, onSend } = await renderCompose()
      await pickLate(editor)
      typeInEditor(editor, "sending now")
      fireEvent.keyDown(editor, { key: "Enter" })
      const send = screen.getByTestId("compose-send") as HTMLButtonElement
      expect(send.dataset.queued).toBe("true")

      typeInEditor(editor, "sending now, and one more thing")
      expect(send.dataset.queued).toBeUndefined()
      uploads.pending[0](pdfRow("file-1", "late.pdf"))
      await waitFor(() => expect(screen.queryByTestId("composer-attachment-uploading")).toBeNull())
      await tick()
      expect(onSend).not.toHaveBeenCalled()
    })

    it("a failed upload cancels the queued send and shows the upload error", async () => {
      uploads.pending = []
      uploads.failures = []
      const { editor, onSend } = await renderCompose()
      await pickLate(editor)
      typeInEditor(editor, "sending now")
      fireEvent.keyDown(editor, { key: "Enter" })
      expect((screen.getByTestId("compose-send") as HTMLButtonElement).dataset.queued).toBe("true")

      uploads.failures[0](new Error("storage down"))
      await waitFor(() => expect(screen.getByTestId("composer-attachment-error")).toBeTruthy())
      await tick()
      expect(onSend).not.toHaveBeenCalled()
      expect(editor.textContent).toBe("sending now")
      const send = screen.getByTestId("compose-send") as HTMLButtonElement
      expect(send.dataset.queued).toBeUndefined()
    })

    // The upload session is created on the first pick, one request before
    // the upload itself registers: a send in that gap went out without it.
    // A press there queues too, and waits for the upload that follows.
    it("a press while the upload session is being created queues until the file is up", async () => {
      uploads.pending = []
      uploads.failures = []
      let openGate: () => void = () => {}
      uploads.sessionGate = new Promise<void>((r) => (openGate = r))
      try {
        const { editor, onSend } = await renderCompose()
        const bar = editor.closest("[data-testid=compose-dropzone]") as HTMLElement
        fireEvent.drop(bar, {
          dataTransfer: { files: [new File(["x"], "early.pdf", { type: "application/pdf" })] },
        })
        typeInEditor(editor, "sending now")
        fireEvent.keyDown(editor, { key: "Enter" })
        expect(onSend).not.toHaveBeenCalled()
        openGate()
        await waitFor(() => expect(uploads.pending).toHaveLength(1))
        await tick()
        expect(onSend).not.toHaveBeenCalled()
        uploads.pending[0](pdfRow("file-1", "early.pdf"))
        await waitFor(() =>
          expect(onSend).toHaveBeenCalledWith("sending now", { attachmentSessionId: "sess-1" }),
        )
      } finally {
        uploads.sessionGate = null
      }
    })

    // Walk 3: a tile still uploading had no remove control. Removing it aborts
    // the storage PUT, the tile goes at once, nothing is staged when the
    // request unwinds, and the queued send (waiting on nothing now) goes out.
    it("removing a file while it uploads aborts it and releases the queued send", async () => {
      uploads.pending = []
      uploads.failures = []
      const fetchMock = vi.mocked(fetch)
      const answer = fetchMock.getMockImplementation()!
      let putSignal: AbortSignal | undefined
      fetchMock.mockImplementation(((url: string, init?: RequestInit) =>
        url === "https://storage.example.com/put"
          ? new Promise((_resolve, reject) => {
              putSignal = init?.signal ?? undefined
              putSignal?.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              )
            })
          : answer(url, init)) as typeof fetch)
      try {
        const { editor, onSend } = await renderCompose()
        const bar = editor.closest("[data-testid=compose-dropzone]") as HTMLElement
        fireEvent.drop(bar, {
          dataTransfer: { files: [new File(["x"], "slow.pdf", { type: "application/pdf" })] },
        })
        await waitFor(() => expect(putSignal).toBeDefined())
        typeInEditor(editor, "sending now")
        fireEvent.keyDown(editor, { key: "Enter" })
        const send = screen.getByTestId("compose-send") as HTMLButtonElement
        expect(send.dataset.queued).toBe("true")

        const tile = screen.getByTestId("composer-attachment-uploading")
        const cancel = tile.querySelector<HTMLButtonElement>(
          "button[data-testid^=composer-attachment-cancel-]",
        )!
        expect(cancel.getAttribute("aria-label")).toBe("Remove slow.pdf")
        fireEvent.click(cancel)
        expect(putSignal?.aborted).toBe(true)
        expect(screen.queryByTestId("composer-attachment-uploading")).toBeNull()

        await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
        expect(onSend.mock.calls[0][0]).toBe("sending now")
        await tick()
        expect(uploads.pending).toHaveLength(0)
        expect(screen.queryByTestId("composer-attachment-strip")).toBeNull()
        expect(screen.queryByTestId("composer-attachment-error")).toBeNull()
      } finally {
        fetchMock.mockImplementation(answer)
      }
    })

    it("an upload into the live session is staged", async () => {
      uploads.pending = []
      const { editor } = await renderCompose()
      const bar = editor.closest("[data-testid=compose-dropzone]") as HTMLElement
      fireEvent.drop(bar, {
        dataTransfer: { files: [new File(["x"], "a.pdf", { type: "application/pdf" })] },
      })
      await waitFor(() => expect(uploads.pending).toHaveLength(1))
      uploads.pending[0]({
        id: "file-2",
        filename: "a.pdf",
        sizeBytes: 1,
        mimeType: "application/pdf",
        thumbnailKey: null,
        entityType: "file_upload_session",
        entityId: "sess-1",
      })
      // Queried afresh: the strip holding the uploading tile goes when the
      // upload settles and a new one holds the staged row a moment later.
      await waitFor(() =>
        expect(
          screen.getByTestId("composer-attachment-strip").querySelector('[title="a.pdf"]'),
        ).not.toBeNull(),
      )
    })
  })

  describe("the composer's two lines", () => {
    it("puts the text field before the control row, and never inside it", async () => {
      const { container } = await renderCompose()
      const field = screen
        .getByTestId("compose-editor")
        .closest("[data-compose-field]") as HTMLElement
      const controls = container.querySelector(
        '[data-testid="compose-controls-row"]',
      ) as HTMLElement
      expect(controls).not.toBeNull()
      expect(
        field.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      expect(controls.contains(field)).toBe(false)
      // Both lines are children of one column, not of a row (the field's band
      // through the recorder fold, a `contents` box that a phone take hides).
      // Each line carries its own padding: the field's band is 16px at the
      // sides and 14px above, the control row sits tighter under it.
      const fieldBand = field.parentElement as HTMLElement
      const fold = fieldBand.parentElement as HTMLElement
      expect(fold.hasAttribute("data-recorder-fold")).toBe(true)
      expect(fold.getAttribute("class")).toBe("contents")
      expect(fold.parentElement).toBe(controls.parentElement)
      expect(fold.parentElement?.getAttribute("class")).toContain("flex-col")
      expect(fieldBand.getAttribute("class")).toContain("px-4")
      expect(fieldBand.getAttribute("class")).toContain("pt-3.5")
      expect(controls.getAttribute("class")).toContain("px-2")
    })

    it("the plus opens the attachment input", async () => {
      const { container } = await renderCompose()
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="attachment-upload-input"]',
      )
      expect(input).not.toBeNull()
      const clicked = vi.fn()
      input?.addEventListener("click", clicked)

      fireEvent.click(screen.getByTestId("composer-plus"))

      expect(clicked).toHaveBeenCalledTimes(1)
    })
  })

  describe("disabled state", () => {
    it("disables the send button when disabled prop is true", async () => {
      await renderCompose({ disabled: true })
      const sendBtn = screen.getByLabelText("Send message")
      expect(sendBtn).toBeDisabled()
    })

    it("disables the send button when editor is empty", async () => {
      await renderCompose()
      const sendBtn = screen.getByLabelText("Send message")
      expect(sendBtn).toBeDisabled()
    })
  })
  // P6d-T09: the desktop controls live IN the control row, as siblings of the
  // `+`. The pinned number below is that row's child count in a BROWSER:
  // `+`, Aa, wand, emoji and the send wrapper. Everything desktop renders nothing
  // at all without a live local session for this conversation.
  describe("desktop controls", () => {
    const BROWSER_ROW_CHILDREN = 5

    function controlRow(container: HTMLElement): HTMLElement {
      // The row's controls, inside the recorder's `display: contents` wrapper.
      const row = container.querySelector<HTMLElement>(
        '[data-testid="compose-controls-row"] > [data-recorder-row]',
      )
      if (!row) throw new Error("the composer has no control row")
      return row
    }

    afterEach(() => uninstallFakeBridge())

    it("the runtime badge sits inside the composer control row and is not positioned", async () => {
      installFakeBridge(liveSession("t1", "a1"))
      const { container } = await renderCompose({ threadId: "t1" })
      const badge = screen.getByTestId("desktop-runtime-badge")
      expect(controlRow(container).contains(badge)).toBe(true)
      const classes = badge.getAttribute("class") ?? ""
      expect(classes).not.toContain("fixed")
      expect(classes).not.toContain("absolute")
      expect(badge.hasAttribute("style")).toBe(false)
    })

    it("the permission mode menu sits in the same row as the plus button", async () => {
      installFakeBridge(liveSession("t1", "a1"))
      const { container } = await renderCompose({ threadId: "t1" })
      const mode = screen.getByRole("button", { name: "How this session asks before it acts" })
      expect(controlRow(container).contains(mode)).toBe(true)
    })

    it("composer shows no desktop controls in a browser", async () => {
      uninstallFakeBridge()
      const { container } = await renderCompose({ threadId: "t1" })
      expect(controlRow(container).children.length).toBe(BROWSER_ROW_CHILDREN)
      expect(screen.queryByTestId("desktop-runtime-badge")).toBeNull()
    })

    it("composer shows no desktop controls for another conversation's session", async () => {
      installFakeBridge(liveSession("other-thread", "a1"))
      const { container } = await renderCompose({ threadId: "t1" })
      expect(controlRow(container).children.length).toBe(BROWSER_ROW_CHILDREN)
    })

    // 2026-09-25: the files a local session wrote open from the runtime pill.
    // The icon of their own beside the `+` read as a second attach button and
    // said nothing about the session; it is gone, here and in the hidden input.
    it("the files a session wrote open from the runtime pill, with no separate icon", async () => {
      installFakeBridge(
        liveSession("t1", "a1", {
          producedFiles: [{ path: "/Users/someone/work/hello.txt", name: "hello.txt" }],
        }),
      )
      const { container } = await renderCompose({ threadId: "t1" })
      const pill = screen.getByRole("button", { name: "Open files created by the agent" })
      expect(screen.getByTestId("desktop-runtime-badge").contains(pill)).toBe(true)
      // `+`, Aa, wand, emoji, send, and exactly two desktop controls: the pill and
      // the permission mode.
      expect(controlRow(container).children.length).toBe(BROWSER_ROW_CHILDREN + 2)
      expect(container.querySelectorAll(".lucide-file-up").length).toBe(0)
    })

    it("another conversation's session offers its files nowhere in this composer", async () => {
      installFakeBridge(
        liveSession("other-thread", "a1", {
          producedFiles: [{ path: "/Users/someone/work/hello.txt", name: "hello.txt" }],
        }),
      )
      const { container } = await renderCompose({ threadId: "t1" })
      expect(controlRow(container).children.length).toBe(BROWSER_ROW_CHILDREN)
      expect(container.querySelectorAll(".lucide-file-up").length).toBe(0)
    })
  })
})

describe("ComposeBar unsaved work", () => {
  afterEach(() => resetUnsavedWork())

  it("names an unsent draft as work a reload would lose, and nothing once it is empty", async () => {
    const { editor, unmount } = await renderCompose()
    expect(listUnsavedWork()).toEqual([])
    typeInEditor(editor, "half a thought")
    await waitFor(() => expect(listUnsavedWork()).toEqual(["A message you have not sent"]))
    editorOf(editor).commands.clearContent(true)
    await waitFor(() => expect(listUnsavedWork()).toEqual([]))
    typeInEditor(editor, "again")
    unmount()
    expect(listUnsavedWork()).toEqual([])
  })
})

describe("ComposeBar guided-tour guard", () => {
  afterEach(() => {
    personalDm.id = undefined
  })

  it("marks the person's own agent conversation, and only that one", async () => {
    personalDm.id = "dm-own"
    await renderCompose({ threadId: "dm-own" })
    expect(screen.getByTestId("compose-field").getAttribute("data-personal-agent")).toBe("true")
    cleanup()
    await renderCompose({ threadId: "thread-with-colleagues" })
    expect(screen.getByTestId("compose-field").getAttribute("data-personal-agent")).toBe("false")
    cleanup()
    // Before the DM is known, nothing counts as it.
    personalDm.id = undefined
    await renderCompose({})
    expect(screen.getByTestId("compose-field").getAttribute("data-personal-agent")).toBe("false")
  })
})

describe("ComposeBar dictation", () => {
  it("the mic sits immediately left of Send; the wand stays with the tools", async () => {
    installMic()
    installAudioContext()
    const prev = globalThis.fetch
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: {
            get: (name: string) =>
              name.toLowerCase() === "content-type" ? "application/json" : null,
          },
          text: () =>
            Promise.resolve(
              JSON.stringify({
                data: String(url).includes("/assist/capabilities")
                  ? { dictation: true, autoClean: true }
                  : [],
              }),
            ),
        }),
      ),
    )
    try {
      await renderCompose()
      const mic = await screen.findByTestId("voice-dictation-button")
      expect(mic.nextElementSibling).toBe(screen.getByTestId("compose-send"))
      expect(screen.getByTestId("magic-wand").nextElementSibling).not.toBe(mic)
    } finally {
      removeMic()
      vi.stubGlobal("fetch", prev)
    }
  })
})

describe("ComposeBar model chip", () => {
  it("shares the control line with Send: the line does not wrap and the chip may shrink", async () => {
    await renderCompose({
      modelControl: () => (
        <div data-testid="thread-model-chip" class="min-w-0">
          chip
        </div>
      ),
    })
    const row = screen.getByTestId("compose-controls-row")
    expect(row.classList.contains("flex-nowrap")).toBe(true)
    expect(row.classList.contains("flex-wrap")).toBe(false)
    expect(row.contains(screen.getByTestId("thread-model-chip"))).toBe(true)
    expect(row.contains(screen.getByTestId("compose-send"))).toBe(true)
  })
})
