// SPDX-License-Identifier: FSL-1.1-ALv2
// An entity's discussion (a task's, a contact's), laid out as a chat: the
// messages run oldest to newest, and the box is the bottom row, under the
// newest one, so the @ picker opens upward over them. Where the discussion is
// a side rail (a wide pane) the messages scroll on their own above the box,
// open at the newest and follow each new one in, unless the reader scrolled up
// to read (sessions/stick-to-bottom.ts, the chat panel's rule). Narrower (the
// phone) the discussion follows the entity's content in the page's own
// scroll, its box last. The composer is an inline DockedComposer: on the phone
// it docks above the keyboard while a message is typed instead of scrolling
// away with the page (ui/DockedComposer.tsx). New messages, a teammate's or an
// agent's, land through the socket's `message:create` (threads/message-store.ts).
//
// THE SAME CONVERSATION AS THE THREAD VIEW. An entity's discussion is a
// thread: it posts to the same route, and an agent tagged here runs the same
// turn with the same access rules. So it draws the conversation with the
// thread view's own stream (threads/MessageList.tsx `MessageStream`): agent
// messages with their tool-call rows, thinking, citations and inline approval
// cards, the live turn as it streams, the working state and the local turn's
// stop. It sends through the thread view's own send (threads/thread-send.ts),
// so the turn knows the view on screen and holds the mailbox scope the same
// way. Only the chrome differs: no header, no archived banner, the box below.
// It keeps the @ picker: bringing an agent into the entity is done from here.
// Its files are the thread composer's own (files/composer-attachments.ts):
// attach, drop, paste, the staged strip and the held send, so a message
// carries its files exactly as one in the thread view does.
//
// Each entity names its own words and test ids (`testId` is the root:
// `task-discussion`, `contact-discussion`); who may read and write is the
// thread's, derived on the server from who may see the entity.

import { Clock, Send } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Show,
} from "solid-js"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { userFromToken } from "~/modules/auth/auth-store"
import { type MentionQuery, RichEditor, type RichEditorHandle } from "~/modules/editor"
import { AttachmentUploadButton } from "~/modules/files/AttachmentUploadButton"
import { createComposerAttachments, pastedFiles } from "~/modules/files/composer-attachments"
import { uploadHoldLabel } from "~/modules/files/file-service"
import { restoreStaged, StagedAttachmentChips } from "~/modules/files/StagedAttachmentChips"
import { useI18n } from "~/modules/i18n/i18n-context"
import { createStickToBottom } from "~/modules/sessions/stick-to-bottom"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { useOptionalWs } from "~/modules/shell/WsContext"
import AgentStateLabel from "~/modules/threads/AgentStateLabel"
import { MentionAutocomplete, type MentionResult } from "~/modules/threads/MentionAutocomplete"
import { createMessageItems, MessageStream } from "~/modules/threads/MessageList"
import { mentionChipFor } from "~/modules/threads/mention-chip"
import {
  getLiveAgentStreams,
  loadMessages,
  loadMoreMessages,
  messageStore,
  seedAgentStreamState,
} from "~/modules/threads/message-store"
import { jumpToMessage } from "~/modules/threads/quote-jump"
import { channelJumpRequest, consumeChannelJump } from "~/modules/threads/reply-panel-store"
import TypingIndicator from "~/modules/threads/TypingIndicator"
import {
  releaseHeldScopes,
  sendFailureToast,
  sendThreadMessage,
} from "~/modules/threads/thread-send"
import { DockedComposer } from "~/ui/DockedComposer"

export interface EntityDiscussionProps {
  threadId: string
  /** The root data-testid; every part's id is derived from it. */
  testId: string
  /** Shown while the discussion has no message. */
  emptyText: string
  placeholder: string
  /** The send button's label. */
  sendLabel: string
  /**
   * Text the page puts in the box (a suggested question), with a counter so
   * the same text can be put again. It is typed at the end and the box takes
   * the focus; nothing is sent until the person sends it.
   */
  prefill?: { text: string; n: number } | null
}

export const EntityDiscussion: Component<EntityDiscussionProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [draft, setDraft] = createSignal("")
  const [submitting, setSubmitting] = createSignal(false)
  const files = createComposerAttachments({ api })
  let editor: RichEditorHandle | undefined
  const dictation = useDictation({ target: () => editor })

  // Load (and reload on threadId change). The store is keyed by threadId so
  // tab switches don't clobber. A failed load is not asked again on its own
  // (the thread view's rule): the retry is an explicit one.
  const streamSeeded = new Set<string>()
  createEffect(() => {
    const id = props.threadId
    if (!id) return
    // Another section of the page may read the same thread (a task's
    // documents): one load, not two.
    if (!messageStore.threads[id] && !messageStore.loading[id] && !messageStore.error[id]) {
      void loadMessages(api, id)
    }
    // A turn already running when the discussion opens (the page was loaded
    // mid-turn, a teammate tagged the agent) shows at once, as in the thread
    // view, rather than from its next socket frame.
    if (!streamSeeded.has(id)) {
      streamSeeded.add(id)
      void seedAgentStreamState(api, id)
    }
  })

  // A suggestion from the page lands in the box, once per request.
  let prefilled = 0
  const [editorReady, setEditorReady] = createSignal(false)
  createEffect(() => {
    const p = props.prefill
    if (!p || p.n === prefilled || !editorReady() || !editor) return
    prefilled = p.n
    editor.insertText(p.text)
    editor.focus()
  })

  const { messages, items } = createMessageItems(props)
  const tid = (part?: string): string => (part ? `${props.testId}.${part}` : props.testId)
  const liveTurns = () => getLiveAgentStreams(props.threadId).length
  // Opens at the newest comment and follows new ones while the reader is at
  // the bottom (a streaming turn grows the content, which it follows too); a
  // reader scrolled up keeps her place.
  const stick = createStickToBottom(() => items().length + liveTurns())
  let scroller: HTMLElement | undefined

  // A NOTIFICATION'S MESSAGE. A push, a desktop notification or an inbox row
  // about a comment here opens the entity and asks for the comment
  // (notifications/open-route.ts): once the first page is in, it is brought
  // into view and marked, older pages loaded if it is above them, as a quote's
  // source is in the thread view.
  createEffect(
    on(channelJumpRequest, (req) => {
      if (!req || req.threadId !== props.threadId) return
      consumeChannelJump(req)
      void (async () => {
        for (let i = 0; i < 50; i++) {
          if (messageStore.threads[props.threadId] && !messageStore.loading[props.threadId]) break
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        stick.hold()
        await jumpToMessage({
          container: () => scroller,
          messageId: req.messageId,
          hasMore: () => messageStore.hasMore[props.threadId] ?? false,
          loadMore: () => loadMoreMessages(api, props.threadId),
          onMissing: () =>
            addToast({ message: i18n.t("kernel.replyThreads.messageNotFound"), type: "warning" }),
        })
        // The comment is in place: the view follows again only from the bottom.
        stick.settle()
      })()
    }),
  )
  const me = createMemo(() => {
    const u = userFromToken()
    return u ? { id: u.userId, name: u.name } : null
  })

  // Mailbox turn scopes this discussion opened whose turn has not ended yet,
  // closed with it (thread-send.ts).
  const heldTurnScopes = new Set<() => void>()
  onCleanup(() => releaseHeldScopes(heldTurnScopes))

  // Teammates see "is typing", as in the thread composer (one frame per 3 s).
  const ws = useOptionalWs()
  let lastTypingEmit = 0
  const emitTyping = (): void => {
    if (!ws || Date.now() - lastTypingEmit <= 3000) return
    lastTypingEmit = Date.now()
    ws.send({ type: "typing", threadId: props.threadId })
  }

  const canSend = () =>
    (draft().trim().length > 0 || files.pendingFiles().length > 0 || files.uploadHold.held()) &&
    !submitting()

  const submit = async (): Promise<void> => {
    // A file still uploading holds the send (pressed again, cancels it); it
    // goes by itself, with the file, once every pick is staged.
    if (files.uploadHold.press(() => void submit())) return
    const content = draft().trim()
    const user = me()
    const attachmentSessionId = files.sendSessionId()
    if ((!content && !attachmentSessionId) || !user || submitting()) return
    setSubmitting(true)
    try {
      await sendThreadMessage(
        api,
        props.threadId,
        content,
        user,
        attachmentSessionId ? { attachmentSessionId } : {},
        heldTurnScopes,
      )
      setDraft("")
      setMention(null)
      files.reset()
      // Your own comment always brings you to the bottom, as in a chat.
      stick.jump()
      queueMicrotask(() => editor?.focus())
    } catch (err) {
      // The draft and its files stay where they were, to send again.
      addToast(sendFailureToast(err, i18n.t))
    } finally {
      setSubmitting(false)
    }
  }

  const onPaste = (e: ClipboardEvent): void => {
    const pasted = pastedFiles(e)
    if (pasted.length === 0) return
    e.preventDefault()
    for (const f of pasted) void files.stageFile(f)
  }

  const holdLabel = (): string | undefined => uploadHoldLabel(i18n.t, files.uploadHold)

  // The @ picker, as in the thread composer: people, agents, entities.
  const [mention, setMention] = createSignal<MentionQuery | null>(null)
  let mentionKeyHandler: ((e: KeyboardEvent) => boolean) | undefined
  const onMentionSelect = (item: MentionResult): void => {
    const chip = mentionChipFor(item)
    if (chip) editor?.mention(chip)
    setMention(null)
  }

  return (
    <div data-testid={tid()} class="flex min-h-0 flex-1 flex-col gap-4">
      {/* Messages — oldest first, newest last, right above the composer. The
          scroller is its own only where the discussion is a side rail. */}
      <div
        data-testid={tid("scroller")}
        ref={(el) => {
          scroller = el
          stick.container(el)
        }}
        class="min-h-0 @[860px]:-mx-1 @[860px]:flex-1 @[860px]:overflow-y-auto @[860px]:px-1"
      >
        <div ref={stick.content}>
          <Show
            when={messages().length > 0 || liveTurns() > 0}
            fallback={
              <p data-testid={tid("empty")} class="py-2 text-[12.5px] text-text-tertiary">
                {props.emptyText}
              </p>
            }
          >
            <MessageStream
              threadId={props.threadId}
              currentUserId={me()?.id ?? ""}
              items={items()}
              listTestId={tid("messages")}
              rowTestId={(id) => tid(`message-${id}`)}
              contentTestId={tid("message-body")}
            />
          </Show>
          {/* The agent's turn state (Queued, Working: <tool>, Stuck, Failed)
              and who is typing, under the newest comment as in the thread. */}
          <AgentStateLabel threadId={props.threadId} />
          <TypingIndicator threadId={props.threadId} currentUserId={me()?.id ?? ""} />
        </div>
      </div>

      {/* Composer — the bottom row, under the newest comment; docked above the
          phone keyboard while typed in. */}
      <DockedComposer mode="inline" class="min-w-0 shrink-0">
        <form
          data-testid={tid("dropzone")}
          class="@container relative flex min-w-0 flex-col gap-2 rounded-sm border border-border-subtle bg-surface/40 p-3"
          classList={{ "ring-2 ring-accent/40": files.dragOver() }}
          onDragOver={files.onDragOver}
          onDragLeave={files.onDragLeave}
          onDrop={files.onDrop}
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Show when={mention()}>
            {(query) => (
              <MentionAutocomplete
                query={query().text}
                trigger={query().trigger}
                position={{ bottom: "100%", left: 12 }}
                // Upward over the comments; below the box only where the page
                // clips the room above it (a phone page scrolled to the box).
                fit
                onSelect={onMentionSelect}
                onClose={() => setMention(null)}
                onKeyDown={(handler) => {
                  mentionKeyHandler = handler
                }}
              />
            )}
          </Show>
          {/* Staged files above the field, as in the thread composer. */}
          <StagedAttachmentChips
            files={files.pendingFiles()}
            onRemoved={(f) => {
              files.uploadHold.cancel()
              files.setPendingFiles((p) => p.filter((x) => x.id !== f.id))
            }}
            onRestored={(f, i) => files.setPendingFiles((p) => restoreStaged(p, f, i))}
            error={files.attachError()}
            class="flex items-center gap-2.5 overflow-x-auto pb-0.5 pt-1.5 [scrollbar-width:thin]"
            uploadParentKey={files.sessionParentKey()}
          />
          <RichEditor
            preset="full"
            toolbar="focus"
            ref={(handle) => {
              editor = handle
              setEditorReady(true)
            }}
            value={draft()}
            onChange={(markdown) => {
              // An edit makes it a different message than the one queued.
              files.uploadHold.cancel()
              setDraft(markdown)
              emitTyping()
            }}
            onSubmit={() => void submit()}
            onPaste={onPaste}
            onMention={setMention}
            // The open picker takes its keys (arrows, Enter, Escape) before the field.
            onKeyDown={(e) => !!mention() && !!mentionKeyHandler?.(e)}
            placeholder={props.placeholder}
            data-testid={tid("composer")}
            editorClass="min-h-[2.75rem]"
          />
          {/* Sized by the composer, not the window: the discussion sits in a
              ~340 px column on a wide screen. The tools wrap among themselves
              while the mic and the send button keep their line, and the send
              hint shows only where the composer itself has the room. While a
              take runs the whole line is the recorder. */}
          <div data-testid={tid("actions")} class="flex min-w-0 items-center gap-2">
            <RecorderRow dictation={dictation}>
              <div
                data-testid={tid("tools")}
                class="flex min-w-0 flex-1 flex-wrap items-center gap-2"
              >
                <AttachmentUploadButton
                  parent={files.uploadParent}
                  onUploaded={files.addStaged}
                  onError={files.reportError}
                />
                <ComposerAssist target={() => editor} disabled={submitting()} />
              </div>
              <span
                data-testid={tid("send-hint")}
                class="hidden shrink-0 whitespace-nowrap text-[11px] text-text-tertiary @md:inline"
              >
                <span class="font-mono">⌘ ↵</span> {i18n.t("projects.toSend")}
              </span>
              <DictationMic dictation={dictation} disabled={submitting()} />
              <button
                type="submit"
                data-testid={tid("send")}
                disabled={!canSend()}
                title={holdLabel()}
                aria-pressed={files.uploadHold.held() ? files.uploadHold.queued() : undefined}
                data-queued={files.uploadHold.queued() ? "true" : undefined}
                class="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm border border-accent-border bg-accent-glow px-2.5 py-1 text-[12px] font-medium text-accent transition-colors hover:bg-accent-wash disabled:opacity-50"
              >
                <Show when={files.uploadHold.queued()} fallback={<Send class="h-3 w-3" />}>
                  <Clock class="h-3 w-3" data-testid={tid("send-queued")} />
                </Show>
                {submitting() ? i18n.t("kernel.common.sending") : props.sendLabel}
              </button>
            </RecorderRow>
          </div>
        </form>
      </DockedComposer>
    </div>
  )
}

export default EntityDiscussion
