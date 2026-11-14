// SPDX-License-Identifier: FSL-1.1-ALv2

import { hasVendorKey } from "@liaison/shared"
import { CaseSensitive, Clock, Mic, Paperclip, Plus, X } from "lucide-solid"
import {
  type Component,
  createEffect,
  createSignal,
  createUniqueId,
  type JSX,
  onCleanup,
  Show,
  useContext,
} from "solid-js"
import { nativeHaptic } from "~/lib/native-bridge"
import { registerUnsavedWork } from "~/lib/unsaved-work"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { MagicWandButton } from "~/modules/assist/MagicWandButton"
import { DictationMic, RecorderFold, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { userFromToken } from "~/modules/auth/auth-store"
import ClaudeSignInNotice from "~/modules/desktop/ClaudeSignInNotice"
import LocalStartRefusal from "~/modules/desktop/LocalStartRefusal"
import PermissionModeMenu from "~/modules/desktop/PermissionModeMenu"
import RuntimeBadge from "~/modules/desktop/RuntimeBadge"
import { type MentionQuery, RichEditor, type RichEditorHandle } from "~/modules/editor"
import { AttachmentUploadButton } from "~/modules/files/AttachmentUploadButton"
import { createComposerAttachments, pastedFiles } from "~/modules/files/composer-attachments"
import { uploadHoldLabel } from "~/modules/files/file-service"
import { restoreStaged, StagedAttachmentChips } from "~/modules/files/StagedAttachmentChips"
import { useI18n } from "~/modules/i18n/i18n-context"
import NodeModeMenu from "~/modules/nodes/NodeModeMenu"
import { useApi } from "~/modules/shell/ApiContext"
import { consumePrefill, pendingPrefill } from "~/modules/shell/dock-prefill"
import { shellTier } from "~/modules/shell/shell-tier"
import { useTabId } from "~/modules/shell/TabVisibilityContext"
import { useOptionalWs } from "~/modules/shell/WsContext"
import { WsStatusContext } from "~/modules/shell/ws-status-context"
import ComposeEmojiButton from "~/modules/threads/ComposeEmojiButton"
import { conversationDisplayName } from "~/modules/threads/conversation-display"
import { MentionAutocomplete, type MentionResult } from "~/modules/threads/MentionAutocomplete"
import { mentionChipFor } from "~/modules/threads/mention-chip"
import type { QuoteDraft } from "~/modules/threads/message-store"
import { knownPersonalAgentDmId } from "~/modules/threads/personal-dm-store"
import { plainQuoteText } from "~/modules/threads/quote-excerpt"
import { getThread } from "~/modules/threads/thread-store"
import { Composer, chatTextClass } from "~/ui/Composer"
import { DockedComposer } from "~/ui/DockedComposer"
import { OverlaySheet } from "~/ui/OverlaySheet"

interface ComposeBarProps {
  /**
   * Sends the message. A host may answer whether it was posted: `false` hands
   * the draft (text and staged files) back to the field, for a send that was
   * held back before anything reached the server (a conversation that runs on
   * this machine whose session could not be had).
   */
  onSend: (content: string, opts?: { attachmentSessionId?: string }) => unknown
  onTyping?: () => void
  disabled?: boolean
  threadId?: string
  /** The conversation's model control, rendered in the composer row on both
   *  desktop and phone. Supplied only for a conversation with an agent: the
   *  model an agent uses is a default a chat may override at any time, and the
   *  chip is where that is said and changed. */
  modelControl?: () => JSX.Element
  /** The dock's 340px panel. The card sits 8px from the panel's sides and
   *  bottom instead of the full surface's 16px, so a narrow panel spends its
   *  width on the field rather than on margin. */
  compact?: boolean
  /** The quote this message will carry (S12), drawn as a removable chip above
   *  the field. The host owns it and sends it with the message. */
  quote?: QuoteDraft | null
  onClearQuote?: () => void
  /** Replaces the default placeholder (the reply panel's "Reply…"). */
  placeholder?: string
  /** Takes the focus when it mounts: the reply panel's composer, so the
   *  reader types straight into the thread she just opened. */
  autofocus?: boolean
}

// The desktop row's icon tiles (`+`, wand, emoji): one size and one hover so
// the three read as a set. 34px is the row's hit target; the phone `+` keeps
// its own 36px circle.
const ROW_ICON_CLASS =
  "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] p-0 text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
/** The phone row's round 36px controls (`+`, Aa). */
const PHONE_ICON_CLASS =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-hover"

/** Whether the Aa row is open: one choice per person on this device (the
 *  `liaison:` keys are cleared at sign-out), shared by every composer. */
const FORMATTING_KEY = "liaison:composeFormatting"
const [formatting, setFormattingSignal] = createSignal(readFormatting())
function readFormatting(): boolean {
  try {
    return localStorage.getItem(FORMATTING_KEY) === "1"
  } catch {
    return false
  }
}
function setFormatting(open: boolean): void {
  setFormattingSignal(open)
  try {
    if (open) localStorage.setItem(FORMATTING_KEY, "1")
    else localStorage.removeItem(FORMATTING_KEY)
  } catch {
    // Storage refused (private mode): the choice lasts the session.
  }
}

/** A row of the phone compose-actions sheet, and the icon column every row
 *  shares: 44px, the tier's touch floor, so an icon button and a bare glyph
 *  take the same room. The row's 3px start inset puts an 18px glyph centred in
 *  that box at 16px, the sheet title's edge. */
const SHEET_ROW =
  "flex min-h-12 w-full items-center gap-2 py-0.5 pl-[3px] pr-4 text-[15px] text-text"
const SHEET_ICON_BOX = "flex h-11 w-11 shrink-0 items-center justify-center"

const ComposeBar: Component<ComposeBarProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const wsStatus = useContext(WsStatusContext)
  const isOffline = () => wsStatus() !== "connected"
  // The connection keeps being cut seconds after it opens (a VPN, as a rule):
  // the reconnect line names the likely cause; the shell's notice says more.
  const ws = useOptionalWs()
  const wsUnstable = () => ws?.unstable() ?? false
  // The message as markdown: exactly what is sent.
  const [text, setText] = createSignal("")
  // A payment key typed or pasted into the message: the send is stopped here
  // and the line under the field says why (the server masks one anyway).
  const [keyBlocked, setKeyBlocked] = createSignal(false)
  const hasContent = () => text().trim() !== ""
  const [mention, setMention] = createSignal<MentionQuery | null>(null)
  // Staged files, the upload session they ride and the send hold: shared
  // with every message composer (files/composer-attachments.ts).
  const attachments = createComposerAttachments({ api, disabled: () => props.disabled })
  const {
    pendingFiles,
    setPendingFiles,
    attachError,
    setSession,
    sessionParentKey,
    uploadHold,
    addStaged,
    stageFile,
  } = attachments

  // M1-B T6: at phone width the control row is a `+` and the send circle, and
  // everything else (attach, wand, emoji, the desktop session controls) lives
  // in a bottom sheet the `+` opens. Desktop and tablet keep the row they have
  // always had, markup included.
  const isPhone = () => shellTier() === "phone"
  const [sheetOpen, setSheetOpen] = createSignal(false)
  let rootRef!: HTMLDivElement

  /** The conversation this composer writes into, named the way the rest of the
   *  product names it: the DM counterpart or the channel title. Null while the
   *  store has not got the thread yet, which is what keeps the generic
   *  placeholder as the fallback rather than a half-rendered one. */
  const threadName = (): string | null => {
    const id = props.threadId
    if (!id) return null
    const thread = getThread(id)
    if (!thread) return null
    const name = conversationDisplayName(thread, userFromToken()?.userId ?? "").trim()
    return name.length > 0 ? name : null
  }

  // An unsent draft, a staged file or one still uploading is work a reload or
  // closing this tab would lose: the shell asks first (lib/unsaved-work.ts).
  onCleanup(
    registerUnsavedWork(`compose:${createUniqueId()}`, {
      tabId: useTabId(),
      describe: () => {
        if (hasContent()) {
          const name = threadName()
          return name
            ? i18n.t("kernel.unsavedWork.composerDraftIn", { name })
            : i18n.t("kernel.unsavedWork.composerDraft")
        }
        const count = pendingFiles().length
        if (count === 1) return i18n.t("kernel.unsavedWork.composerFilesOne")
        if (count > 1) return i18n.t("kernel.unsavedWork.composerFilesMany", { count })
        if (uploadHold.held()) return i18n.t("kernel.unsavedWork.composerUploading")
        return null
      },
    }),
  )

  /** The sheet's Attach row drives the SAME hidden input the desktop row's
   *  label wraps, so a phone upload and a desktop upload are one code path. */
  function openFilePicker(): void {
    rootRef?.querySelector<HTMLInputElement>('[data-testid="attachment-upload-input"]')?.click()
  }

  let editor: RichEditorHandle | undefined
  // Words a page put here through `dock.prefill` (shell/dock-prefill.ts): they land in the field
  // once, caret at the end, and are never sent by it.
  const [editorReady, setEditorReady] = createSignal(false)
  createEffect(() => {
    const p = pendingPrefill(props.threadId)
    if (!p || !editorReady() || !editor || props.disabled) return
    consumePrefill(p.n)
    editor.insertText(p.text)
    editor.focus()
  })
  // THE TAKE belongs to the composer: the mic left of Send starts it at every
  // tier, and so does Dictate in the phone sheet, which closes first. While it
  // runs the control line is the recorder (RecorderBar.tsx), under the field
  // the text lands in.
  const dictation = useDictation({ target: () => editor })
  let lastTypingEmit = 0
  let mentionKeyHandler: ((e: KeyboardEvent) => boolean) | undefined

  function handleChange(markdown: string) {
    setText(markdown)
    if (keyBlocked() && !hasVendorKey(markdown)) setKeyBlocked(false)
    // An edit makes it a different message than the one queued (see
    // createUploadHold): the queued send is dropped.
    uploadHold.cancel()
    if (props.onTyping && Date.now() - lastTypingEmit > 3000) {
      lastTypingEmit = Date.now()
      props.onTyping()
    }
  }

  function handleMentionSelect(item: MentionResult) {
    const chip = mentionChipFor(item)
    if (chip) editor?.mention(chip)
    setMention(null)
  }

  /** The open picker takes its keys (arrows, Enter, Escape) before the field. */
  function handleKeyDown(e: KeyboardEvent): boolean {
    return !!mention() && !!mentionKeyHandler?.(e)
  }

  function handlePaste(e: ClipboardEvent) {
    if (props.disabled) return
    const files = pastedFiles(e)
    if (files.length === 0) return
    e.preventDefault()
    for (const f of files) void stageFile(f)
  }

  function submit() {
    // While a picked file uploads, Enter and the button queue the send (or,
    // pressed again, cancel it); it fires by itself once the files are staged.
    if (uploadHold.press(submit)) return
    const message = text().trim()
    const files = pendingFiles()
    if (!message && files.length === 0) return
    if (hasVendorKey(message)) {
      setKeyBlocked(true)
      return
    }
    const s = attachments.session()
    // On a phone the field empties and the message appears a beat later, over
    // a keyboard that covers most of the thread: the tick is what says the
    // send took. Fired for a real send only, after the empty check above.
    // No-op off a native shell (lib/native-bridge.ts).
    nativeHaptic("light")
    const sent = props.onSend(
      message,
      files.length > 0 && s ? { attachmentSessionId: s.id } : undefined,
    )
    if (sent instanceof Promise) {
      void sent.then((posted) => {
        if (posted !== false) return
        // Only into an EMPTY field: a person who has started the next message
        // meanwhile keeps what they are typing.
        if (hasContent() || pendingFiles().length > 0 || uploadHold.held()) return
        setText(message)
        setPendingFiles(files)
        setSession(s)
      })
    }
    setText("")
    setMention(null)
    lastTypingEmit = 0
    attachments.reset()
  }

  /** The field plus its placeholder: the first line of the composer, which
   *  it owns. It used to share one row with every control, which is why a
   *  narrow panel squeezed it to a one character column and a phone cut the
   *  placeholder mid-word: here nothing is beside it, at any tier, and the
   *  controls sit under it on a line of their own. */
  /** The person's own agent conversation: a guided tour sends a request only into this one. */
  const personalAgent = (): "true" | "false" =>
    props.threadId !== undefined && props.threadId === knownPersonalAgentDmId() ? "true" : "false"

  const editorField = (): JSX.Element => (
    <div
      data-compose-field
      data-testid="compose-field"
      // The person's own agent conversation: a guided tour sends a request
      // only into this one, never into a conversation with colleagues.
      data-personal-agent={personalAgent()}
      // Which conversation this composer writes to: a guided tour run types
      // only into its own conversation's composer.
      data-thread-id={props.threadId}
      class="relative w-full min-w-0 [--editor-bg:var(--color-elevated)]"
    >
      <RichEditor
        preset="minimal"
        value={text()}
        onChange={handleChange}
        onSubmit={submit}
        enterSubmits
        onKeyDown={handleKeyDown}
        onMention={setMention}
        onPaste={handlePaste}
        // The Aa row, above the text. Shortcuts and typed markdown work with
        // it closed.
        toolbar={formatting() ? "always" : "none"}
        disabled={props.disabled}
        autofocus={props.autofocus && !props.disabled}
        ref={(handle) => {
          editor = handle
          setEditorReady(true)
        }}
        aria-label={i18n.t("kernel.writeAMessage")}
        data-testid="compose-editor"
        // The chat field's size and growth cap, shared with every chat
        // composer (ui/Composer.tsx chatTextClass).
        editorClass={chatTextClass(isPhone())}
      />
      <Show when={!hasContent()}>
        <div
          data-compose-placeholder
          // On the text's line, under the Aa row when it is open. SECONDARY,
          // NOT TERTIARY: on the elevated card the tertiary grey was below
          // reading contrast, and the placeholder is the one line that says
          // what the field is for.
          class={`pointer-events-none absolute inset-x-0 bottom-0 select-none truncate text-text-secondary ${
            isPhone() ? "text-[16px] leading-6" : "text-[15px] leading-[22px]"
          }`}
        >
          <Show
            when={!props.placeholder && isPhone() && threadName()}
            fallback={
              props.placeholder ? (
                <span>{props.placeholder}</span>
              ) : (
                <>
                  {/* THE FIELD IS THE NARROWEST THING ON A PHONE. The full hint
                    needs about 300px and the field has roughly 200, so at
                    phone width the hint is the short one and the long form
                    returns at the tablet breakpoint (640px, the shell's own
                    phone boundary). `truncate` is the backstop: a locale whose
                    short form is still too long ends in an ellipsis rather
                    than wrapping and being cut mid-word. */}
                  <span class="sm:hidden">{i18n.t("kernel.writeAMessage")}</span>
                  <span class="hidden sm:inline">{i18n.t("kernel.writeAMessageHint")}</span>
                </>
              )
            }
          >
            {(name) => (
              <span data-testid="compose-placeholder-named">
                {i18n.t("kernel.messageTo", { name: name() })}
              </span>
            )}
          </Show>
        </div>
      </Show>
    </div>
  )

  /** Aa: shows and hides the formatting row above the text. */
  const formattingButton = (): JSX.Element => (
    <button
      type="button"
      data-testid="compose-formatting"
      aria-pressed={formatting()}
      aria-label={i18n.t(
        formatting() ? "kernel.editor.hideFormatting" : "kernel.editor.showFormatting",
      )}
      title={i18n.t(formatting() ? "kernel.editor.hideFormatting" : "kernel.editor.showFormatting")}
      disabled={props.disabled}
      // The caret stays in the text.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setFormatting(!formatting())}
      class={`${isPhone() ? PHONE_ICON_CLASS : ROW_ICON_CLASS} disabled:opacity-40 aria-pressed:bg-surface-active aria-pressed:text-text`}
    >
      <CaseSensitive size={isPhone() ? 20 : 18} />
    </button>
  )

  const sendHoldLabel = (): string | undefined => uploadHoldLabel(i18n.t, uploadHold)

  const sendButton = (): JSX.Element => (
    <Composer.Send
      testId="compose-send"
      threadId={props.threadId}
      personalAgent={personalAgent()}
      onClick={submit}
      // A file on its way counts as something to send: the press queues.
      disabled={
        (!hasContent() && pendingFiles().length === 0 && !uploadHold.held()) ||
        props.disabled ||
        isOffline()
      }
      title={isOffline() ? i18n.t("kernel.youAreOffline") : sendHoldLabel()}
      label={sendHoldLabel() ?? i18n.t("kernel.sendMessage")}
      pressed={uploadHold.held() ? uploadHold.queued() : undefined}
      queued={uploadHold.queued()}
      phone={isPhone()}
    >
      {/* Queued behind an upload: a clock, not the arrow, until it goes. */}
      {uploadHold.queued() ? <Clock size={16} data-testid="compose-send-queued" /> : undefined}
    </Composer.Send>
  )

  /** The file input the `+` clicks, at every tier. It is never painted: the
   *  control it belongs to is the `+` beside it (desktop) or the sheet's
   *  Attach row (phone), and one hidden input keeps both on a single upload
   *  path. */
  const hiddenAttach = (): JSX.Element => (
    <Show when={!props.disabled}>
      <div class="hidden" data-testid="compose-hidden-attach">
        <AttachmentUploadButton
          parent={attachments.uploadParent}
          onUploaded={addStaged}
          onError={attachments.reportError}
        />
      </div>
    </Show>
  )

  /** THE `+` IS THE ATTACH CONTROL, in Claude's terms rather than ours. A
   *  button labelled "Attach" beside four more labelled controls is what made
   *  this row read as a toolbar; a `+` is the one affordance everybody who has
   *  used a chat already knows. It opens the file picker on a desktop and the
   *  actions sheet on a phone, which is where a phone keeps the rest. */
  const plusButton = (): JSX.Element => (
    <button
      type="button"
      data-testid="composer-plus"
      aria-label={i18n.t(isPhone() ? "kernel.composeActions" : "kernel.composeAddAttachment")}
      title={i18n.t(isPhone() ? "kernel.composeActions" : "kernel.composeAddAttachment")}
      disabled={props.disabled}
      onClick={() => (isPhone() ? setSheetOpen(true) : openFilePicker())}
      class={`${isPhone() ? PHONE_ICON_CLASS : ROW_ICON_CLASS} disabled:opacity-40`}
    >
      <Plus size={isPhone() ? 20 : 18} />
    </button>
  )

  /** The files a local session wrote live on the runtime pill; attaching one
   *  stages it exactly where the `+` stages a picked file. */
  const producedFileUpload = {
    parent: attachments.uploadParent,
    onUploaded: addStaged,
    onError: attachments.reportError,
  }

  /** The SECOND line: everything that is not the message. `+` first, then the
   *  writing helpers, then what this session runs on and which model answers,
   *  then send at the far right. Every desktop control renders nothing at all
   *  in a browser, so a browser's second line is `+`, the helpers and send. */
  const controlRow = (): JSX.Element => (
    // ONE LINE, NEVER WRAPPED: the model chip shrinks (its name ends in an
    // ellipsis) rather than taking a line of its own under the controls.
    <Composer.Controls testId="compose-controls-row" class="flex-nowrap">
      <RecorderRow dictation={dictation} variant={isPhone() ? "phone" : "row"}>
        {plusButton()}
        {formattingButton()}
        <Show when={!isPhone()}>
          <ComposerAssist
            target={() => editor}
            disabled={props.disabled}
            class={ROW_ICON_CLASS}
            iconSize={18}
          />
          <ComposeEmojiButton
            onSelect={(emoji) => editor?.insert(emoji)}
            disabled={props.disabled}
            class={ROW_ICON_CLASS}
            iconSize={18}
          />
          {/* A HAIRLINE BETWEEN WRITING AND RUNNING: left of it the tools that
            change the message, right of it the ones that change who answers
            and how. Drawn only when something IS on its right: the desktop
            session controls render nothing in a browser, and a divider next
            to nothing is a stray mark. */}
          <Show when={props.modelControl}>
            <span
              aria-hidden="true"
              data-testid="compose-controls-divider"
              class="mx-1.5 h-[18px] w-px shrink-0 bg-border"
            />
          </Show>
          {/*
          P6d-T09: the desktop controls are SIBLINGS in this row, not elements
          drawn over it. Both render nothing at all unless a local session is
          live for this conversation, so a browser's row is unchanged by them.
          At phone tier they stay in the sheet the `+` opens. The files a
          local session wrote are on the runtime pill, not on an icon of
          their own beside the `+`.
        */}
          <RuntimeBadge
            threadId={props.threadId}
            {...producedFileUpload}
            disabled={props.disabled}
          />
          <PermissionModeMenu threadId={props.threadId} />
          {/* A conversation on the viewer's node (S24): the same mode question. */}
          <NodeModeMenu threadId={props.threadId} />
        </Show>
        <Show when={props.modelControl}>{(control) => control()()}</Show>
        {/* Send is pushed to the far right of the line, whatever is beside it,
          and the mic sits immediately left of it. */}
        <div class="ml-auto flex items-center gap-0.5">
          <DictationMic
            dictation={dictation}
            disabled={props.disabled}
            threadId={props.threadId}
            class={isPhone() ? PHONE_ICON_CLASS : ROW_ICON_CLASS}
            iconSize={isPhone() ? 20 : 18}
          />
          {sendButton()}
        </div>
      </RecorderRow>
    </Composer.Controls>
  )

  return (
    <DockedComposer
      ref={rootRef}
      // NO BAND OF ITS OWN: the bar is transparent, so the conversation's
      // background runs round the card and the card is the one frame. It used
      // to be a bordered surface strip with the card inset inside it.
      // Full surface: 14px under the card, or the dock strip's height where
      // the shell floats the dock's pills over the panel's bottom right
      // (--shell-dock-clearance, Shell.tsx), so the pills sit under the card
      // instead of over its corner and the send button.
      class={`relative ${
        props.compact
          ? "px-2 pb-2 pt-1"
          : "px-4 pb-[max(0.875rem,var(--shell-dock-clearance,0px))] pt-1"
      }`}
      classList={{ "ring-2 ring-accent/40": attachments.dragOver() }}
      onDragOver={attachments.onDragOver}
      onDragLeave={attachments.onDragLeave}
      onDrop={attachments.onDrop}
      data-testid="compose-dropzone"
    >
      <Show when={keyBlocked()}>
        <div
          data-testid="compose-key-blocked"
          role="alert"
          class="mb-1 text-sm text-text-secondary"
        >
          {i18n.t("kernel.composerKeyBlocked")}
        </div>
      </Show>
      <Show when={isOffline()}>
        <div data-testid="compose-offline-banner" class="mb-1 text-sm text-text-secondary">
          {wsUnstable() ? i18n.t("kernel.reconnectingUnstable") : i18n.t("kernel.reconnecting")}
        </div>
      </Show>
      {/* A refused local start stays said here, where the draft came back
          to, with what can be done about it (LocalStartRefusal.tsx). Renders
          nothing in a browser or without a refusal for this conversation. */}
      <LocalStartRefusal threadId={props.threadId} />
      {/* Claude on this computer is not signed in: the sign-in, offered where
          the person is typing (ClaudeSignInNotice.tsx). Nothing in a browser. */}
      <ClaudeSignInNotice threadId={props.threadId} />
      <Show when={mention()}>
        {(query) => (
          <MentionAutocomplete
            query={query().text}
            trigger={query().trigger}
            // ABOVE THE CARD, not over it: the popup's bottom is the bar's top
            // edge, 4px over the card (the bar's pt-1), so the line being typed
            // stays visible however tall the card has grown (a long draft,
            // staged files, a quote) and whatever clears the dock below it. A
            // fixed pixel offset from the bar's bottom landed on the field.
            // Left follows the bar's side padding, the card's own left edge.
            position={{ bottom: "100%", left: props.compact ? 8 : 16 }}
            onSelect={handleMentionSelect}
            onClose={() => setMention(null)}
            onKeyDown={(handler) => {
              mentionKeyHandler = handler
            }}
          />
        )}
      </Show>
      {/* THE CARD: the shared chat card (ui/Composer.tsx `chat`), flat on
          the conversation; mail and tickets keep their sunken look. */}
      <Composer disabled={props.disabled} variant="chat">
        {/* TWO LINES, EVERY TIER: the message on top at the full width of the
            composer, the controls under it. One row of eight controls with the
            field wedged among them is what card 61 called busy and card 104
            called broken, and it is what left a phone's field 122px wide.
            Each line carries its own padding: the field breathes (16px sides,
            14px above), the control row sits tight to the card's edge so its
            34px tiles line up under the text. */}
        <div class="flex flex-col" data-testid={isPhone() ? "compose-row-phone" : undefined}>
          {/* STAGED FILES ON TOP, left under the text's edge: below the
              control row they sat under send, in the corner the dock's
              floating pills cover. */}
          <StagedAttachmentChips
            files={pendingFiles()}
            onRemoved={(f) => {
              uploadHold.cancel()
              setPendingFiles((p) => p.filter((x) => x.id !== f.id))
            }}
            onRestored={(f, i) => setPendingFiles((p) => restoreStaged(p, f, i))}
            error={attachError()}
            disabled={props.disabled}
            // One row that scrolls sideways; each tile carries 6px above it
            // for its corner remove button, hence the lighter top padding.
            class={`flex items-center gap-2.5 overflow-x-auto pb-0.5 [scrollbar-width:thin] ${
              isPhone() ? "px-3.5 pt-1.5" : "px-4 pt-2"
            }`}
            uploadParentKey={sessionParentKey()}
          />
          <Show when={props.quote}>
            {(quote) => (
              <div
                data-testid="compose-quote-chip"
                class={`${isPhone() ? "mx-3.5" : "mx-4"} ${
                  pendingFiles().length > 0 ? "mt-2" : isPhone() ? "mt-3" : "mt-3.5"
                } flex items-start gap-2 rounded-r border-l-2 border-accent/40 bg-surface/60 py-1 pl-2.5 pr-1`}
              >
                <div class="min-w-0 flex-1">
                  <span class="block text-[11.5px] font-medium text-text-secondary">
                    {i18n.t("kernel.replyThreads.quoting", { name: quote().authorName })}
                  </span>
                  <span class="line-clamp-2 block text-[12.5px] leading-snug text-text-secondary">
                    {plainQuoteText(quote().excerpt)}
                  </span>
                </div>
                <button
                  type="button"
                  data-testid="compose-quote-remove"
                  aria-label={i18n.t("kernel.replyThreads.removeQuote")}
                  title={i18n.t("kernel.replyThreads.removeQuote")}
                  class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text"
                  onClick={() => props.onClearQuote?.()}
                >
                  <X size={12} />
                </button>
              </div>
            )}
          </Show>
          {/* Under a quote chip or staged files the field closes up to them
              (8px): they already carry the card's top spacing. On a phone the
              input line itself becomes the recorder while a take runs (D20). */}
          <RecorderFold dictation={dictation} when={isPhone()}>
            <div
              class={`${isPhone() ? "px-3.5" : "px-4"} pb-1 ${
                props.quote || pendingFiles().length > 0 ? "pt-2" : isPhone() ? "pt-3" : "pt-3.5"
              }`}
            >
              {editorField()}
            </div>
          </RecorderFold>
          {controlRow()}
          {hiddenAttach()}
        </div>
      </Composer>
      <Show when={isPhone()}>
        <OverlaySheet
          open={sheetOpen()}
          onClose={() => setSheetOpen(false)}
          variant="bottom"
          title={i18n.t("kernel.composeActions")}
          closeLabel={i18n.t("kernel.close")}
        >
          {/* ONE ICON COLUMN FOR EVERY ROW. Wand and Emoji are icon buttons,
              which the phone tier floors at 44px with the glyph centred in
              them, while Attach drew its bare glyph: its icon and label sat
              14px left of the other two. Every row now puts its glyph in the
              same 44px box (SHEET_ICON_BOX), inset so the glyph lines up with
              the sheet's title. */}
          <div class="flex flex-col pb-2">
            {/* Attach is the first row: it is the one a phone reaches for. */}
            <button
              type="button"
              data-testid="composer-sheet-attach"
              onClick={() => {
                setSheetOpen(false)
                openFilePicker()
              }}
              class={`${SHEET_ROW} text-left hover:bg-surface-hover`}
            >
              <span class={`${SHEET_ICON_BOX} text-text-secondary`}>
                <Paperclip size={18} />
              </span>
              {i18n.t("kernel.composeAttach")}
            </button>
            <div data-testid="composer-sheet-wand" class={SHEET_ROW}>
              <MagicWandButton
                getEl={() => editor?.element}
                kind="html"
                disabled={props.disabled}
                iconSize={18}
                class={SHEET_ICON_BOX}
              />
              {i18n.t("kernel.magicWand")}
            </div>
            {/* Dictate closes the sheet and records on the composer line, so
                the field the text lands in stays in view (the same take as
                the mic left of Send). */}
            <Show when={dictation.available()}>
              <button
                type="button"
                data-testid="composer-sheet-dictation"
                disabled={props.disabled}
                onClick={() => {
                  setSheetOpen(false)
                  void dictation.start()
                }}
                class={`${SHEET_ROW} text-left hover:bg-surface-hover disabled:opacity-50`}
              >
                <span class={`${SHEET_ICON_BOX} text-text-secondary`}>
                  <Mic size={18} />
                </span>
                {i18n.t("kernel.dictation.sheetLabel")}
              </button>
            </Show>
            <div data-testid="composer-sheet-emoji" class={SHEET_ROW}>
              <ComposeEmojiButton
                iconSize={18}
                class={SHEET_ICON_BOX}
                onSelect={(emoji) => {
                  setSheetOpen(false)
                  editor?.insert(emoji)
                }}
                disabled={props.disabled}
              />
              {i18n.t("kernel.composeEmoji")}
            </div>
            {/* The desktop session controls render nothing at all without a
                live local session, exactly as they do in the desktop row. */}
            <div class="flex flex-wrap items-center gap-2 px-4 empty:hidden">
              <PermissionModeMenu threadId={props.threadId} />
              <NodeModeMenu threadId={props.threadId} />
              <RuntimeBadge
                threadId={props.threadId}
                {...producedFileUpload}
                disabled={props.disabled}
              />
            </div>
          </div>
        </OverlaySheet>
      </Show>
    </DockedComposer>
  )
}

export default ComposeBar
