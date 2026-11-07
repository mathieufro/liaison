// SPDX-License-Identifier: FSL-1.1-ALv2

import type { MessageQuote, ReasoningLevel } from "@liaison/shared"
import { OUT_OF_CREDITS_CODE, PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import { Copy, Ellipsis, MessageSquareReply, Pencil, Quote, Trash2 } from "lucide-solid"
import { type Component, createSignal, For, Show } from "solid-js"
import { getModelLabel } from "~/lib/model-groups"
import AgentActivity from "~/modules/agent/AgentActivity"
import ThinkingBlock from "~/modules/agent/ThinkingBlock"
import ToolCallRow from "~/modules/agent/ToolCallRow"
import ApprovalCard from "~/modules/approvals/ApprovalCard"
import { AttachmentStrip } from "~/modules/files/AttachmentStrip"
import { downloadFile } from "~/modules/files/file-service"
import { tNow, useI18n } from "~/modules/i18n/i18n-context"
import { MailboxLockedPanel } from "~/modules/mailbox/MailboxLockedPanel"
import { mailboxStore } from "~/modules/mailbox/mailbox-store"
import SecretRequestToolCard from "~/modules/secret-request/SecretRequestToolCard"
import { useApi } from "~/modules/shell/ApiContext"
import { formatRelativeTime, rowLocaleFrom } from "~/modules/shell/attention-row-format"
import AgentMessageMenu from "~/modules/threads/AgentMessageMenu"
import { localizeAgentName } from "~/modules/threads/agent-name"
import { DeleteMessageConfirm } from "~/modules/threads/DeleteMessageConfirm"
import { MessageCitations } from "~/modules/threads/MessageCitations"
import { MessageEditField } from "~/modules/threads/MessageEditField"
import {
  MessageActionSheet,
  type MessageSheetAction,
  ReactionsCard,
} from "~/modules/threads/MessageTouchSheets"
import { turnHitLockedMailbox } from "~/modules/threads/mailbox-locked-turn"
import type { Message, SubRunMetadata } from "~/modules/threads/message-store"
import {
  isMessageDeleted,
  isSubRunExpanded,
  toggleSubRunExpanded,
} from "~/modules/threads/message-store"
import { TurnEndApprovals } from "~/modules/threads/NodeDispatchApprovalCard"
import NodeDispatchBlockedCard from "~/modules/threads/NodeDispatchBlockedCard"
import NodeSessionCard from "~/modules/threads/NodeSessionCard"
import { billingRefusalOf, PaymentRequiredNotice } from "~/modules/threads/PaymentRequiredNotice"
import { excerptForWholeMessage, plainQuoteText } from "~/modules/threads/quote-excerpt"
import { setQuoteDraft } from "~/modules/threads/quote-store"
import ReactionPicker, { reactorsLabel } from "~/modules/threads/ReactionPicker"
import { SetupKickoffRow, setupKickoffOf } from "~/modules/threads/SetupKickoffRow"
import SubRunCard from "~/modules/threads/SubRunCard"
import { localizeSystemLine } from "~/modules/threads/system-line"
import { isTurnRefusalLine } from "~/modules/threads/turn-refusal"
import { createTouchPress } from "~/primitives/createTouchPress"
import { AgentGlyph } from "~/ui/AgentGlyph"
import { AvatarImage } from "~/ui/AvatarImage"
import { agentAvatarStyle, avatarColors } from "~/ui/avatar-palette"
import { PopupMenu } from "~/ui/PopupMenu"
import { Tooltip } from "~/ui/Tooltip"

/** The card an approved request_secret filed (approvals/result-notice.ts), unless it was already in the conversation. */
export function approvedSecretCardId(meta: Message["metadata"] | undefined): string | null {
  if (meta?.type !== "approval-result") return null
  const id = meta.secretRequestId
  if (typeof id !== "string" || id.length === 0 || meta.secretCard === "already_posted") return null
  return id
}

interface MessageRowProps {
  message: Message
  grouped: boolean
  currentUserId: string
  isAdmin?: boolean
  agentModelId?: string | null
  agentReasoningLevels?: Record<string, string>
  hasPurchasedCredits?: boolean
  /** Model ids with a usable provider key (GET /credits/models) — filters the
   *  per-message model menu the same way ModelSelector filters the composer's. */
  availableModelIds?: Set<string> | null
  onSelectAgentModel?: (modelId: string | null) => void
  onSelectReasoning?: (modelId: string, level: ReasoningLevel) => void
  onEdit: (msg: { id: string; content: string | null }) => void
  onDelete: (messageId: string) => void
  onReaction: (messageId: string, emoji: string) => void
  onRemoveReaction: (messageId: string, emoji: string) => void
  renderContent: (content: string) => import("solid-js").JSX.Element
  /** Only approval threads render the inline card for "approval-created" posts;
   *  agent threads already show it via the gated tool-call row. */
  isApprovalThread?: boolean
  /** Resolve an approval request UUID from its handle — supplied by MessageList
   *  for approval threads so "approval-created" messages predating the stamped
   *  `requestId` still render their live card. */
  resolveApprovalId?: (handle: string | undefined) => string | undefined
  /** Opens the reply panel on a root (S10). Supplied by the channel list: its
   *  presence draws "Reply in thread" on every row that can be a root, the
   *  summary under a root, and the "view thread" link on a reply also sent to
   *  the channel. The reply panel leaves it out. */
  onReplyInThread?: (rootId: string) => void
  /** Clicking a quote block (S14): jump to the quoted message. */
  onQuoteClick?: (quote: MessageQuote) => void
  /** The composer a quote from this row goes to (quote-store key). Its
   *  presence puts "Quote" in the long-press sheet, the touch path to what a
   *  mouse does by selecting text. */
  quoteSurfaceKey?: string
}

/** A sheet is mounted the first time it opens and then kept: a closed sheet
 *  on every row of a long thread is weight for nothing, and a sheet that is
 *  unmounted to close cannot hand focus back (OverlaySheet). */
function mountedOnceOpen(open: () => boolean): () => boolean {
  let once = false
  return () => {
    if (open()) once = true
    return once
  }
}

/** A press that belongs to something inside the row with its own gesture:
 *  a reaction chip (it opens the reactions card) or a field being edited. */
function ownsItsPress(target: Element): boolean {
  return !!target.closest("[data-reaction-chip], textarea, input")
}

/** What a tap on a row leaves alone because it has an action of its own: a
 *  link, a mention, a button (attachments, images, the quote block, tool
 *  toggles, reaction chips), a field, a media player. A tap anywhere else on
 *  the row opens its action sheet. */
const OWN_TAP_TARGET =
  'a, button, input, textarea, select, label, summary, video, audio, [role="button"], [role="link"], [contenteditable=""], [contenteditable="true"], [data-mention-ref], [data-reaction-chip]'

function ownsItsTap(target: Element): boolean {
  return !!target.closest(OWN_TAP_TARGET)
}

/** Text selection and the iOS callout would fight the row's long press, so a
 *  touch screen gets neither on a message (Copy in the sheet stands in). Not
 *  while editing: WebKit will not edit a field under `user-select: none`. */
function touchPressClass(editing: boolean): string {
  return editing ? "" : "pointer-coarse:select-none [-webkit-touch-callout:none]"
}

/** Quote the whole message into that surface's composer. */
function quoteWholeMessage(message: Message, surfaceKey: string): void {
  setQuoteDraft(surfaceKey, {
    messageId: message.id,
    excerpt: excerptForWholeMessage(message.content ?? ""),
    authorName: message.authorName,
    replyRootId: message.replyRootId ?? null,
  })
}

/** The long-press sheet's Quote (the desktop ⋯ menu offers the same). */
function quoteAction(message: Message, surfaceKey: string, label: string): MessageSheetAction {
  return {
    id: "quote",
    label,
    icon: <Quote size={18} />,
    onSelect: () => quoteWholeMessage(message, surfaceKey),
  }
}

/** The long-press sheet's Copy: the text as drawn (names, not mention tokens),
 *  or the stored text when the row draws none of its own. */
function copyAction(
  message: Message,
  contentEl: HTMLElement | undefined,
  label: string,
): MessageSheetAction {
  return {
    id: "copy",
    label,
    icon: <Copy size={18} />,
    onSelect: () => {
      const text = contentEl?.innerText || contentEl?.textContent || message.content || ""
      void navigator.clipboard?.writeText(text).catch(() => {
        /* a refused clipboard leaves nothing to undo */
      })
    },
  }
}

/** The action "Reply in thread", one toolbar button, human and agent rows alike. */
function ReplyInThreadButton(props: { messageId: string; onClick: () => void }) {
  const i18n = useI18n()
  return (
    <button
      type="button"
      data-testid={`message-reply-in-thread-${props.messageId}`}
      aria-label={i18n.t("kernel.replyThreads.replyInThread")}
      title={i18n.t("kernel.replyThreads.replyInThread")}
      class="flex h-6 w-6 items-center justify-center rounded bg-surface shadow-sm ring-1 ring-border-subtle hover:bg-surface-hover"
      onClick={() => props.onClick()}
    >
      <MessageSquareReply size={14} class="text-text-secondary" />
    </button>
  )
}

/** The quote a message carries, above its content (S14). A click jumps to the
 *  source; a source known to be deleted says so. */
function QuoteBlock(props: {
  message: Message
  quote: MessageQuote
  onClick?: (quote: MessageQuote) => void
}) {
  const i18n = useI18n()
  const sourceDeleted = () => isMessageDeleted(props.message.threadId, props.quote.messageId)
  return (
    <button
      type="button"
      data-testid={`message-quote-${props.message.id}`}
      class="mb-1 mt-0.5 block w-full max-w-[560px] rounded-r border-l-2 border-accent/40 bg-surface/60 py-1 pl-2.5 pr-2 text-left transition-colors hover:bg-surface-hover"
      onClick={() => props.onClick?.(props.quote)}
    >
      <span class="block text-[11.5px] font-medium text-text-secondary">
        {props.quote.authorName}
        <Show when={sourceDeleted()}>
          <span class="ml-1 font-normal italic text-text-tertiary">
            {i18n.t("kernel.replyThreads.quoteSourceDeleted")}
          </span>
        </Show>
      </span>
      <span class="line-clamp-3 block text-[12.5px] leading-snug text-text-secondary">
        {plainQuoteText(props.quote.excerpt)}
      </span>
    </button>
  )
}

/**
 * Under a root with replies (S10): up to three replier avatars, "N replies"
 * and the time of the last reply. A click opens the reply panel.
 */
function ReplySummary(props: { message: Message; onOpen: (rootId: string) => void }) {
  const i18n = useI18n()
  const count = () => props.message.replyCount ?? 0
  const label = () =>
    count() === 1
      ? i18n.t("kernel.replyThreads.replyCountOne")
      : i18n.t("kernel.replyThreads.replyCountMany", { count: count() })
  const last = () => {
    const at = props.message.lastReplyAt
    return at
      ? i18n.t("kernel.replyThreads.lastReply", {
          time: formatRelativeTime(at, { i18n: rowLocaleFrom(i18n) }),
        })
      : ""
  }
  return (
    <button
      type="button"
      data-testid={`reply-summary-${props.message.id}`}
      class="-ml-1 mt-1 flex items-center gap-2 rounded px-1 py-0.5 text-[12px] transition-colors hover:bg-surface-hover"
      onClick={() => props.onOpen(props.message.id)}
    >
      <span class="flex -space-x-1">
        <For each={(props.message.replyAuthors ?? []).slice(0, 3)}>
          {(author) => (
            <span
              data-testid="reply-summary-avatar"
              title={author.name ?? undefined}
              class="flex h-5 w-5 items-center justify-center overflow-hidden rounded-full text-[10px] font-medium ring-2 ring-bg"
              style={{
                "background-color": avatarColors(author.id).bg,
                color: avatarColors(author.id).text,
              }}
            >
              <AvatarImage
                url={author.avatarUrl}
                class="h-full w-full object-cover"
                fallback={(author.name ?? "?").charAt(0).toUpperCase()}
              />
            </span>
          )}
        </For>
      </span>
      <span class="font-medium text-accent">{label()}</span>
      <span class="text-text-tertiary">{last()}</span>
    </button>
  )
}

/** The parts every row draws the same way, human or agent: the reply summary
 *  under a root, and on a reply also sent to the channel, the way into its
 *  thread. */
function ReplyThreadFooter(props: {
  message: Message
  onReplyInThread?: (rootId: string) => void
}) {
  const i18n = useI18n()
  return (
    <Show when={props.onReplyInThread}>
      {(open) => (
        <>
          <Show when={!props.message.replyRootId && (props.message.replyCount ?? 0) > 0}>
            <ReplySummary message={props.message} onOpen={open()} />
          </Show>
          <Show when={props.message.replyRootId && props.message.alsoInChannel}>
            <button
              type="button"
              data-testid={`reply-view-thread-${props.message.id}`}
              class="mt-0.5 text-[11.5px] text-text-tertiary hover:text-text-secondary"
              onClick={() => open()(props.message.replyRootId as string)}
            >
              {i18n.t("kernel.replyThreads.repliedInThread")} ·{" "}
              <span class="text-accent">{i18n.t("kernel.replyThreads.viewThread")}</span>
            </button>
          </Show>
        </>
      )}
    </Show>
  )
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

/** A message's files, human or agent row alike (a deleted message has none,
 *  whatever a live copy still holds). */
function MessageAttachments(props: { message: Message }) {
  const api = useApi()
  return (
    <Show when={!props.message.deletedAt && (props.message.attachments ?? []).length > 0}>
      <AttachmentStrip
        files={(props.message.attachments ?? []).map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          thumbnailUrl: a.thumbnailUrl ?? null,
          disposition: a.disposition,
          contentId: a.contentId ?? null,
        }))}
        onDownload={(f) => {
          void downloadFile(api, f).catch(() => {
            /* swallowed: user can retry */
          })
        }}
      />
    </Show>
  )
}

function AgentMessageRow(
  props: Pick<
    MessageRowProps,
    | "message"
    | "grouped"
    | "renderContent"
    | "agentModelId"
    | "agentReasoningLevels"
    | "hasPurchasedCredits"
    | "availableModelIds"
    | "onSelectAgentModel"
    | "onSelectReasoning"
    | "currentUserId"
    | "isAdmin"
    | "onEdit"
    | "onDelete"
    | "onReplyInThread"
    | "onQuoteClick"
    | "quoteSurfaceKey"
  >,
) {
  const i18n = useI18n()
  // D22: a node answer posted back to the asking thread links to the job
  // thread on the owner's computer for the OWNER alone; anyone else would get
  // a link to a conversation they cannot open (walk 2026-10-12, N8).
  const nodeJobThread = () => {
    const meta = props.message.metadata
    const jobThread = meta?.nodeResultThreadId
    if (!jobThread || meta?.nodeOwnerUserId !== props.currentUserId) return null
    return jobThread === props.message.threadId ? null : jobThread
  }
  // A routine's report links to the full run in its output thread, for the
  // routine's owner: that thread seats the owner, maybe nobody else here.
  const routineRunThread = () => {
    const report = props.message.metadata?.routineReport
    if (!report || report.ownerUserId !== props.currentUserId) return null
    return report.outputThreadId === props.message.threadId ? null : report.outputThreadId
  }
  // An approval a routine's run asked for, in the conversation the routine
  // posts to: the row stands for that one request and draws its live card,
  // which follows the request wherever it is decided (Home, the run's thread).
  // A reader outside the approval's audience gets no card from the server.
  const routineApproval = () => {
    const ask = props.message.metadata?.routineApproval
    return ask && typeof ask.requestId === "string" ? ask : null
  }
  // S11: a dispatch to the owner's computer posts one card message
  // (`metadata.kind: "node_session"`); the card stands in for its text.
  const nodeSession = () => {
    const meta = props.message.metadata as
      | { kind?: string; sessionId?: unknown; nodeName?: unknown }
      | null
      | undefined
    if (meta?.kind !== "node_session" || typeof meta.sessionId !== "string") return null
    return {
      sessionId: meta.sessionId,
      nodeName: typeof meta.nodeName === "string" ? meta.nodeName : null,
    }
  }
  // A finished dispatch's report (`metadata.kind: "node_session_result"`): its
  // session, so a guided step can point at the report of the session it started.
  const sessionResultOf = () => {
    const meta = props.message.metadata as { kind?: string; sessionId?: unknown } | null | undefined
    return meta?.kind === "node_session_result" && typeof meta.sessionId === "string"
      ? meta.sessionId
      : undefined
  }
  // A dispatch refused because its folder is not shared: Fix it / Start again.
  const nodeBlocked = () => {
    const meta = props.message.metadata as Record<string, unknown> | null | undefined
    if (meta?.kind !== "node_dispatch_blocked") return null
    const str = (v: unknown) => (typeof v === "string" ? v : null)
    const nodeId = str(meta.nodeId)
    const name = str(meta.name)
    const ownerUserId = str(meta.ownerUserId)
    if (!nodeId || !name || !ownerUserId) return null
    return {
      nodeId,
      name,
      ownerUserId,
      nodeName: str(meta.nodeName) ?? "",
      retriedSessionId: str(meta.retriedSessionId),
    }
  }
  const toolCalls = () => props.message.metadata?.toolCalls ?? []
  const timeline = () => props.message.metadata?.timeline
  const hasTimeline = () => (timeline()?.length ?? 0) > 0
  /**
   * THE ANSWER IS DRAWN WHERE IT WAS WRITTEN (2026-09-24). A turn that writes a
   * line before each tool (Haiku narrates every step) used to show every tool
   * first and every line after, because the timeline had no text. It does now,
   * and when its words are the stored reply's words (not edited, nothing
   * dropped by a bound), they are drawn in place and the reply is not repeated
   * below. Any mismatch falls back to the reply below the activity.
   */
  const inlineText = () => {
    const entries = timeline()
    const content = props.message.content
    if (!entries || !content || editing() || props.message.editedAt) return false
    const words = entries.flatMap((e) => (e.kind === "text" ? [e.text] : []))
    if (words.length === 0) return false
    const squash = (value: string) => value.replace(/\s+/g, "")
    return squash(words.join("")) === squash(content)
  }
  const [toolsExpanded, setToolsExpanded] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [sheetOpen, setSheetOpen] = createSignal(false)
  const sheetMounted = mountedOnceOpen(sheetOpen)
  let contentEl: HTMLDivElement | undefined
  const [editing, setEditing] = createSignal(false)
  const messageModelId = () => props.message.metadata?.modelId ?? null
  const avatarTooltip = () => {
    const mid = messageModelId()
    return mid
      ? i18n.t("kernel.threadsUi.modelTooltip", { model: getModelLabel(mid) })
      : localizeAgentName(PERSONAL_AGENT_DISPLAY_NAME)
  }

  // Agent messages have no separate identity — `authorId` is already the human
  // whose turn triggered that agent run (sendMessage inserts the initiating
  // userId as authorId for authorType='agent' too; the label in
  // metadata.agentAuthorLabel is attribution, not a different author). So the
  // triggering human can edit/delete their own agent's replies the same way
  // they can their own messages; org admins (kernel:threads:admin) can do so
  // for ANY agent-authored message. Mirrors the server-side authorization in
  // modules/threads/message.ts (editMessage/deleteMessage isAdmin bypass) +
  // the messages_update/messages_delete RLS override
  // (0027_messages_admin_override.sql).
  const canManage = () => props.message.authorId === props.currentUserId || props.isAdmin
  // A reply is never a root, and a message still in flight has no id to hang
  // a thread on.
  const canReply = () =>
    !!props.onReplyInThread && !props.message.replyRootId && !props.message.pending

  function saveEdit(content: string) {
    props.onEdit({ id: props.message.id, content })
    setEditing(false)
  }

  // The touch path to the hover toolbar: the same actions, less the model
  // picker, which the composer's model chip already offers on a phone.
  const sheetActions = (): MessageSheetAction[] => {
    const m = props.message
    const out: MessageSheetAction[] = []
    if (props.quoteSurfaceKey && m.content) {
      out.push(quoteAction(m, props.quoteSurfaceKey, i18n.t("kernel.replyThreads.quote")))
    }
    if (canReply()) {
      out.push({
        id: "reply-in-thread",
        label: i18n.t("kernel.replyThreads.replyInThread"),
        icon: <MessageSquareReply size={18} />,
        onSelect: () => props.onReplyInThread?.(m.id),
      })
    }
    if (m.content) out.push(copyAction(m, contentEl, i18n.t("kernel.threadsUi.copyText")))
    if (canManage() && m.content) {
      out.push({
        id: "edit",
        label: i18n.t("kernel.common.edit"),
        icon: <Pencil size={18} />,
        onSelect: () => setEditing(true),
      })
    }
    if (canManage()) {
      out.push({
        id: "delete",
        label: i18n.t("kernel.common.delete"),
        icon: <Trash2 size={18} />,
        tone: "danger",
        onSelect: () => props.onDelete(m.id),
      })
    }
    return out
  }
  const openSheet = () => {
    if (props.message.deletedAt || props.message.pending || editing()) return
    if (sheetActions().length > 0) setSheetOpen(true)
  }
  const touchPress = createTouchPress({
    onLongPress: openSheet,
    onTap: openSheet,
    ignore: ownsItsPress,
    ignoreTap: ownsItsTap,
  })

  return (
    <div
      ref={touchPress}
      data-testid="message-row"
      data-message-author="agent"
      data-message-id={props.message.id}
      data-session-result={sessionResultOf()}
      data-thread-id={props.message.threadId}
      // A routine's summary posted where it reports: the whole row is what a
      // guided step rings ("read the summary"), not only its full-run link.
      data-routine-report-thread={
        props.message.metadata?.routineReport ? props.message.threadId : undefined
      }
      class={`group relative flex gap-2.5 px-1 py-0.5 transition-colors hover:bg-surface-hover/50 data-[quote-highlight=true]:bg-accent/10 ${touchPressClass(
        editing(),
      )} ${props.grouped ? "mt-0" : "mt-3"}`}
    >
      <Show when={!props.grouped} fallback={<div class="w-8 shrink-0" />}>
        <Tooltip content={avatarTooltip()} triggerClass="mt-0.5 shrink-0 self-start">
          <div
            class="flex h-8 w-8 items-center justify-center rounded-full text-[12px] font-medium"
            style={agentAvatarStyle(props.message.authorAgentId)}
          >
            <AgentGlyph />
          </div>
        </Tooltip>
      </Show>

      {/* `agent-answer` + `data-turn-id`: the saved answer of a turn, as the
          live block marks it while it streams, so a guided step points at the
          answer to the very request it sent, before and after it ends. The id
          is the person's message the answer answers (`askId`), else the turn's
          trigger: after an approval the answering turn is started by the
          result row, and still answers that request. */}
      <div
        class="min-w-0 flex-1"
        data-testid="agent-answer"
        data-turn-id={props.message.metadata?.askId ?? props.message.metadata?.turnId ?? undefined}
      >
        <Show when={!props.grouped}>
          <div class="flex items-baseline gap-2">
            <span class="text-[13px] font-semibold text-accent">
              {localizeAgentName(props.message.authorName ?? PERSONAL_AGENT_DISPLAY_NAME)}
            </span>
            <span
              data-testid={`message-agent-badge-${props.message.id}`}
              class="rounded bg-accent/10 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-accent/80"
            >
              {i18n.t("kernel.threadsUi.agent")}
            </span>
            <span class="text-[11px] text-text-tertiary">
              {formatTime(props.message.createdAt)}
            </span>
          </div>
        </Show>

        <Show
          when={hasTimeline()}
          fallback={
            <>
              <ThinkingBlock
                reasoning={props.message.metadata?.reasoning}
                tokenCount={props.message.metadata?.usage?.reasoningTokens}
              />

              <Show when={toolCalls().length > 0}>
                <button
                  type="button"
                  data-testid="message-row-tools-toggle"
                  class="mt-0.5 flex items-center gap-1 text-[12px] text-text-secondary hover:text-text-primary"
                  onClick={() => setToolsExpanded((prev) => !prev)}
                >
                  <span>{toolsExpanded() ? "▾" : "▸"}</span>
                  <span>
                    {toolsExpanded()
                      ? toolCalls().length === 1
                        ? tNow("kernel.agentUi.oneTool")
                        : tNow("kernel.agentUi.toolsCount", { count: toolCalls().length })
                      : toolCalls().length === 1
                        ? tNow("kernel.agentUi.usedOneTool")
                        : tNow("kernel.agentUi.usedTools", { count: toolCalls().length })}
                  </span>
                </button>
                <Show when={toolsExpanded()}>
                  <div class="ml-2 mt-1">
                    <For each={toolCalls()}>
                      {(tc) => (
                        <ToolCallRow
                          toolCall={tc}
                          turnId={props.message.metadata?.turnId}
                          askId={props.message.metadata?.askId}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </Show>
            </>
          }
        >
          <AgentActivity
            toolCalls={toolCalls()}
            reasoning={props.message.metadata?.reasoning}
            reasoningTokens={props.message.metadata?.usage?.reasoningTokens}
            timeline={timeline()}
            renderText={inlineText() ? props.renderContent : undefined}
            turnId={props.message.metadata?.turnId}
            askId={props.message.metadata?.askId}
          />
        </Show>

        <Show when={!props.message.deletedAt && props.message.metadata?.quote}>
          {(quote) => (
            <QuoteBlock message={props.message} quote={quote()} onClick={props.onQuoteClick} />
          )}
        </Show>

        <Show
          when={!props.message.deletedAt}
          fallback={
            <p class="text-[13px] italic text-text-tertiary">{i18n.t("kernel.messageDeleted")}</p>
          }
        >
          <Show when={nodeSession()}>
            {(session) => (
              <NodeSessionCard
                sessionId={session().sessionId}
                nodeName={session().nodeName}
                fallbackText={props.message.content}
              />
            )}
          </Show>
          <Show when={nodeBlocked()}>
            {(blocked) => (
              <NodeDispatchBlockedCard
                messageId={props.message.id}
                nodeId={blocked().nodeId}
                nodeName={blocked().nodeName}
                name={blocked().name}
                ownerUserId={blocked().ownerUserId}
                currentUserId={props.currentUserId}
                retriedSessionId={blocked().retriedSessionId}
                fallbackText={props.message.content}
              />
            )}
          </Show>
          <Show when={routineApproval()}>
            {(ask) => (
              <div
                class="mt-1"
                data-testid="message-row-routine-approval"
                data-routine-id={ask().routineId}
                data-tool-name={ask().toolName}
              >
                <ApprovalCard requestId={ask().requestId} compact />
              </div>
            )}
          </Show>
          <Show
            when={
              !nodeSession() &&
              !nodeBlocked() &&
              !routineApproval() &&
              props.message.content &&
              !inlineText()
            }
          >
            <Show
              when={editing()}
              fallback={
                <div ref={contentEl} class="text-[13.5px] leading-relaxed text-text">
                  {props.renderContent(props.message.content!)}
                  <Show when={props.message.editedAt}>
                    <span class="ml-1 text-[11px] text-text-tertiary">
                      {i18n.t("kernel.threadsUi.edited")}
                    </span>
                  </Show>
                </div>
              }
            >
              <MessageEditField
                content={props.message.content ?? ""}
                onSave={saveEdit}
                onCancel={() => setEditing(false)}
              />
            </Show>
          </Show>
        </Show>

        <Show when={!props.message.deletedAt && nodeJobThread()}>
          {(jobThread) => (
            <div class="mt-1 text-[12.5px]" data-testid="message-row-node-job-link">
              {props.renderContent(
                `[${i18n.t("kernel.threadsUi.nodeJobThreadLink")}](thread:${jobThread()})`,
              )}
            </div>
          )}
        </Show>

        <Show when={!props.message.deletedAt && routineRunThread()}>
          {(runThread) => (
            <div
              class="mt-1 text-[12.5px]"
              data-testid="message-row-routine-run-link"
              data-thread-id={props.message.threadId}
            >
              {props.renderContent(
                `[${i18n.t("kernel.threadsUi.routineReportRunLink")}](thread:${runThread()})`,
              )}
            </div>
          )}
        </Show>

        {/* The web pages the answer cites (a web search's sources). */}
        <Show when={!props.message.deletedAt && !editing()}>
          <MessageCitations
            content={props.message.content}
            turnId={props.message.metadata?.turnId}
            askId={props.message.metadata?.askId}
          />
        </Show>

        <MessageAttachments message={props.message} />

        <Show when={turnHitLockedMailbox(toolCalls()) && mailboxStore.status === "locked"}>
          <div class="mt-2 max-w-md" data-testid="message-row-mailbox-locked">
            <MailboxLockedPanel
              variant="card"
              body={i18n.t("kernel.mailboxEncryption.locked.agentBody")}
              devicePrfMismatch={mailboxStore.lastErrorCode === "MAILBOX_DEVICE_PRF_MISMATCH"}
              unlockTestId="message-row-mailbox-unlock"
            />
          </div>
        </Show>

        {/* Last in the turn, after its closing words: a dispatch to the person's computer
            waiting for approval, which then becomes that session's card. */}
        <Show when={!props.message.deletedAt}>
          <TurnEndApprovals toolCalls={toolCalls()} />
        </Show>

        <ReplyThreadFooter message={props.message} onReplyInThread={props.onReplyInThread} />
      </div>

      <Show
        when={
          !props.message.deletedAt &&
          !editing() &&
          ((!props.grouped && (props.onSelectAgentModel || canManage())) || canReply())
        }
      >
        <div
          class={`absolute right-1 top-1 flex items-center gap-0.5 transition-opacity ${
            menuOpen()
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
          }`}
        >
          <Show when={canReply()}>
            <ReplyInThreadButton
              messageId={props.message.id}
              onClick={() => props.onReplyInThread?.(props.message.id)}
            />
          </Show>
          <Show when={!props.grouped && (props.onSelectAgentModel || canManage())}>
            {/* ONE "..." menu per agent message: manage actions + model picker merged. */}
            <AgentMessageMenu
              currentModelId={props.agentModelId ?? null}
              hasPurchasedCredits={props.hasPurchasedCredits ?? false}
              onSelectModel={props.onSelectAgentModel}
              availableModelIds={props.availableModelIds}
              canManage={canManage() && !!props.message.content}
              onEdit={() => setEditing(true)}
              onDelete={() => props.onDelete(props.message.id)}
              currentReasoningLevel={
                (props.agentReasoningLevels?.[props.agentModelId ?? ""] as ReasoningLevel) ?? "off"
              }
              onSelectReasoning={(level) => {
                const mid = props.agentModelId
                if (mid) props.onSelectReasoning?.(mid, level)
              }}
              onOpenChange={setMenuOpen}
            />
          </Show>
        </div>
      </Show>

      <Show when={sheetMounted()}>
        <MessageActionSheet
          open={sheetOpen()}
          onClose={() => setSheetOpen(false)}
          messageId={props.message.id}
          actions={sheetActions()}
        />
      </Show>
    </div>
  )
}

const MessageRow: Component<MessageRowProps> = (props) => {
  const i18n = useI18n()
  // Every delete path of this row (⋯ menu, agent menu, long-press sheet) asks
  // first; only the confirm reaches the parent's onDelete.
  const [confirmingDelete, setConfirmingDelete] = createSignal(false)
  const requestDelete = () => setConfirmingDelete(true)
  const deleteConfirm = (
    <Show when={confirmingDelete()}>
      <DeleteMessageConfirm
        open={confirmingDelete()}
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={() => {
          setConfirmingDelete(false)
          props.onDelete(props.message.id)
        }}
      />
    </Show>
  )
  // A membership event is not a message. An agent pulled into a room by a
  // mention used to render as a post BY the person who mentioned it, avatar
  // and all; it is the same muted centered line a room gets when a person is
  // added, written in the reader's language from the event's own fields.
  // WHERE A REQUEST WENT (P4 node routing): "This went to X's computer" or a
  // refusal in words. The server writes it as a system row stamped with the
  // asker's id, so it drew as if the asker had said it (walk 2026-10-12, N8).
  if (
    props.message.authorType === "system" &&
    (props.message.metadata?.nodeQueued === true ||
      typeof props.message.metadata?.nodeRefusal === "string")
  ) {
    return (
      <div
        data-testid="message-row-system-line"
        data-message-id={props.message.id}
        data-system-line="node-routing"
        class="mt-2 flex justify-center px-1 py-0.5"
      >
        <span class="text-[11.5px] text-text-tertiary">{props.message.content}</span>
      </div>
    )
  }
  // A TURN REFUSED BEFORE IT RAN (walk D29): the server writes why as a
  // system row stamped with the asker's id, so it drew as the asker's own
  // message. It is the system's line, said once (turn-refusal.ts).
  if (isTurnRefusalLine(props.message)) {
    return (
      <div
        data-testid="message-row-system-line"
        data-message-id={props.message.id}
        data-system-line="turn-refusal"
        class="mt-2 flex justify-center px-1 py-0.5"
      >
        <span class="text-[11.5px] text-text-tertiary">
          <Show when={billingRefusalOf(props.message.metadata)} fallback={props.message.content}>
            {(code) => <PaymentRequiredNotice outOfCredits={code() === OUT_OF_CREDITS_CODE} />}
          </Show>
        </span>
      </div>
    )
  }
  const setupKickoff = props.message.authorType !== "user" && setupKickoffOf(props.message.metadata)
  if (setupKickoff) return <SetupKickoffRow messageId={props.message.id} view={setupKickoff} />
  if (props.message.metadata?.type === "participant-added") {
    const meta = () => props.message.metadata
    return (
      <div
        data-testid="message-row-system-line"
        data-message-id={props.message.id}
        data-system-line="participant-added"
        class="mt-2 flex justify-center px-1 py-0.5"
      >
        <span class="text-[11.5px] text-text-tertiary">
          {i18n.t("kernel.participantAdded", {
            actor: meta()?.actorName ?? props.message.authorName ?? "",
            participant: meta()?.participantName ?? "",
          })}
        </span>
      </div>
    )
  }
  // An UNDECIDED approval lifecycle notice (expired, cancelled) is an EVENT,
  // not a post. The expiry job writes it with authorType "system" but stamps
  // the REQUESTER's user id on the row, so the thread drew it with that
  // person's avatar and byline: six approvals expiring in one thread read as
  // six identical messages by Alice Chen. Same muted centered treatment a join
  // line gets, and for an expiry the line NAMES its approval, so N notices are
  // N distinguishable facts rather than N copies of one sentence.
  //
  // A notice a PERSON decided (approved, denied, withdrawn, edited) carries
  // that decider in `actorId`, and it stays a full decision row: "Approved by
  // X. Tool executed successfully." is the outcome the room is waiting on, not
  // a housekeeping line, and the row below tags it `message-row-system-decision`.
  if (
    props.message.authorType === "system" &&
    props.message.metadata?.type === "approval-decision" &&
    !props.message.metadata?.actorId
  ) {
    const handle = () => props.message.metadata?.requestHandle
    const text = (): string => {
      const h = handle()
      if (props.message.metadata?.decision === "expired" && typeof h === "string" && h !== "") {
        return i18n.t("kernel.approvalExpiredLine", { handle: h })
      }
      // Older rows predating the stamp keep their stored sentence.
      return props.message.content ?? ""
    }
    return (
      <div
        data-testid="message-row-system-line"
        data-message-id={props.message.id}
        data-system-line="approval-decision"
        class="mt-2 flex justify-center px-1 py-0.5"
      >
        <span class="text-[11.5px] text-text-tertiary">{text()}</span>
      </div>
    )
  }
  // An approved call's OUTPUT, handed back to the agent that asked for it
  // (approvals/result-notice.ts). The output is for the agent's transcript; the
  // room sees one muted line saying it ran and was passed on.
  if (props.message.authorType === "system" && props.message.metadata?.type === "approval-result") {
    const text = (): string => {
      const handle = props.message.metadata?.requestHandle
      return typeof handle === "string" && handle !== ""
        ? i18n.t("kernel.approvalResultLine", { handle })
        : (props.message.content ?? "")
    }
    return (
      <div
        data-testid="message-row-system-line"
        data-message-id={props.message.id}
        data-system-line="approval-result"
        class="mt-2 px-1 py-0.5"
      >
        <div class="flex justify-center">
          <span class="text-[11.5px] text-text-tertiary">{text()}</span>
        </div>
        {/* An approved request_secret's card, exactly as under a call that ran in the turn. */}
        <Show when={approvedSecretCardId(props.message.metadata)}>
          {(id) => (
            <div class="mt-1" data-testid="approval-result-secret-card">
              <SecretRequestToolCard requestId={id()} />
            </div>
          )}
        </Show>
      </div>
    )
  }
  // An approved call that did not go through (approvals/decide.ts: reverted to
  // pending, closed, or held). The server writes the notice as a system row
  // stamped with the requester's id, so it drew as the person's own post: a
  // tour visitor's thread read "Handler failed ..." in their name once per
  // attempt. It is the platform's line, said as one.
  if (props.message.authorType === "system" && props.message.metadata?.type === "approval-error") {
    return (
      <div
        data-testid="message-row-system-line"
        data-message-id={props.message.id}
        data-system-line="approval-error"
        class="mt-2 flex justify-center px-1 py-0.5"
      >
        <span class="text-[11.5px] text-text-tertiary">{props.message.content}</span>
      </div>
    )
  }
  // A routine's run in the conversation it posts to: one calm line, "is
  // running" while the tick works, settled in place when it ends. Its owner
  // gets the link to the full run (the output thread seats them).
  const routineRun = props.message.metadata?.routineRun
  if (props.message.authorType === "system" && routineRun) {
    const text = (): string => {
      const run = props.message.metadata?.routineRun ?? routineRun
      const name = run.routineName
      if (run.status === "succeeded" && run.draftsWaiting === 1)
        return i18n.t("kernel.threadsUi.routineRunSucceededDraftWaiting", { name })
      const draftsWaiting = run.draftsWaiting ?? 0
      if (run.status === "succeeded" && draftsWaiting > 1)
        return i18n.t("kernel.threadsUi.routineRunSucceededDraftsWaiting", {
          name,
          count: draftsWaiting,
        })
      if (run.status === "succeeded")
        return i18n.t("kernel.threadsUi.routineRunSucceeded", { name })
      if (run.status === "failed") return i18n.t("kernel.threadsUi.routineRunFailed", { name })
      if (run.status === "waiting_approval")
        return i18n.t("kernel.threadsUi.routineRunWaitingApproval", { name })
      return i18n.t("kernel.threadsUi.routineRunRunning", { name })
    }
    const runLink = () => {
      const run = props.message.metadata?.routineRun ?? routineRun
      return run.ownerUserId === props.currentUserId &&
        run.outputThreadId !== props.message.threadId
        ? run.outputThreadId
        : null
    }
    return (
      <div
        data-testid="message-row-routine-run"
        data-message-id={props.message.id}
        data-run-status={(props.message.metadata?.routineRun ?? routineRun).status}
        class="mt-2 flex justify-center gap-2 px-1 py-0.5 text-[11.5px] text-text-tertiary"
      >
        <span>{text()}</span>
        <Show when={runLink()}>
          {(thread) => (
            <span data-testid="message-row-routine-run-line-link">
              {props.renderContent(
                `[${i18n.t("kernel.threadsUi.routineReportRunLink")}](thread:${thread()})`,
              )}
            </span>
          )}
        </Show>
      </div>
    )
  }
  // An approval OPENING outside its approval thread is an event too. The
  // greeting is a system row stamped with the requester's user id, so it drew
  // as that person's post ("Avery: Approval request x opened."), even when an
  // agent asked. It is the same muted centered line, naming who asked by the
  // requester rule the server stamped (an agent is named as the agent). An
  // older greeting without that stamp names nobody rather than guess. In an
  // approval thread the row anchors the live card instead (below).
  if (
    !props.isApprovalThread &&
    props.message.authorType === "system" &&
    props.message.metadata?.type === "approval-created"
  ) {
    const text = (): string => {
      const meta = props.message.metadata
      const handle = meta?.requestHandle
      if (typeof handle !== "string" || handle === "") return props.message.content ?? ""
      const name = meta?.requesterName
      return typeof name === "string" && name !== ""
        ? i18n.t("kernel.approvalOpenedLineBy", { handle, name })
        : i18n.t("kernel.approvalOpenedLine", { handle })
    }
    return (
      <div
        data-testid="message-row-system-line"
        data-message-id={props.message.id}
        data-system-line="approval-created"
        class="mt-2 flex justify-center px-1 py-0.5"
      >
        <span class="text-[11.5px] text-text-tertiary">{text()}</span>
      </div>
    )
  }
  // §1.4.5 — sub_run dispatch. authorType is 'agent' or 'system' depending on
  // who spawned the child, so the kind check must come before the agent-row
  // branch to win in both cases.
  if (props.message.metadata?.kind === "sub_run" && props.message.metadata.subRun) {
    // Read through `props` in the JSX, never captured here: a refetch merges a
    // NEW metadata object into the stored message, and live status patches land
    // on that one. A captured `subRun` kept the card on the object it mounted
    // with, frozen at that status.
    return (
      <div
        data-testid="message-row"
        data-message-author={props.message.authorType}
        data-message-id={props.message.id}
        data-message-kind="sub_run"
        data-thread-id={props.message.threadId}
        class={`px-1 py-0.5 ${props.grouped ? "mt-0" : "mt-3"}`}
      >
        <SubRunCard
          subRun={props.message.metadata?.subRun as SubRunMetadata}
          expanded={isSubRunExpanded(props.message.id)}
          onToggle={() => toggleSubRunExpanded(props.message.id)}
        />
      </div>
    )
  }
  if (props.message.authorType === "agent") {
    return (
      <>
        <AgentMessageRow
          message={props.message}
          grouped={props.grouped}
          renderContent={props.renderContent}
          agentModelId={props.agentModelId}
          agentReasoningLevels={props.agentReasoningLevels}
          hasPurchasedCredits={props.hasPurchasedCredits}
          availableModelIds={props.availableModelIds}
          onSelectAgentModel={props.onSelectAgentModel}
          onSelectReasoning={props.onSelectReasoning}
          currentUserId={props.currentUserId}
          isAdmin={props.isAdmin}
          onEdit={props.onEdit}
          onDelete={requestDelete}
          onReplyInThread={props.onReplyInThread}
          onQuoteClick={props.onQuoteClick}
          quoteSurfaceKey={props.quoteSurfaceKey}
        />
        {deleteConfirm}
      </>
    )
  }

  const [activeMenu, setActiveMenu] = createSignal(false)
  const [sheetOpen, setSheetOpen] = createSignal(false)
  // The reaction chip whose reactions card is open, by emoji.
  const [cardFor, setCardFor] = createSignal<string | null>(null)
  const sheetMounted = mountedOnceOpen(sheetOpen)
  const cardMounted = mountedOnceOpen(() => cardFor() !== null)
  let contentEl: HTMLDivElement | undefined
  const [editing, setEditing] = createSignal(false)

  const isSystemDecision = () =>
    props.message.authorType === "system" && props.message.metadata?.type === "approval-decision"

  // Approval threads: an "approval-created" system message anchors the live
  // ApprovalCard inline at its chronological spot — the same inline treatment
  // agent chats give a gated tool call. Prefer the stamped requestId; fall back
  // to resolving the handle (messages predating the stamp).
  const approvalRequestId = (): string | undefined => {
    const m = props.message
    if (!props.isApprovalThread) return undefined
    if (m.authorType !== "system" || m.metadata?.type !== "approval-created") return undefined
    return m.metadata?.requestId ?? props.resolveApprovalId?.(m.metadata?.requestHandle)
  }

  function saveEdit(content: string) {
    props.onEdit({ id: props.message.id, content })
    setEditing(false)
  }

  const canManageOwn = () => props.message.authorId === props.currentUserId || !!props.isAdmin
  // The same Quote the long-press sheet offers: the whole message to this
  // surface's composer (selecting text quotes a part of it).
  const canQuote = () => !!props.quoteSurfaceKey && !!props.message.content
  const quoteFromMenu = () => {
    const key = props.quoteSurfaceKey
    if (key) quoteWholeMessage(props.message, key)
  }

  // The touch path to the hover toolbar (reply in thread, react, edit,
  // delete), plus quote and copy, which a mouse does by selecting text.
  const sheetActions = (): MessageSheetAction[] => {
    const m = props.message
    const out: MessageSheetAction[] = []
    if (props.quoteSurfaceKey && m.content && !isSystemDecision() && !approvalRequestId()) {
      out.push(quoteAction(m, props.quoteSurfaceKey, i18n.t("kernel.replyThreads.quote")))
    }
    if (props.onReplyInThread && !m.replyRootId && !isSystemDecision()) {
      out.push({
        id: "reply-in-thread",
        label: i18n.t("kernel.replyThreads.replyInThread"),
        icon: <MessageSquareReply size={18} />,
        onSelect: () => props.onReplyInThread?.(m.id),
      })
    }
    if (m.content) out.push(copyAction(m, contentEl, i18n.t("kernel.threadsUi.copyText")))
    if (m.authorId === props.currentUserId) {
      out.push({
        id: "edit",
        label: i18n.t("kernel.common.edit"),
        icon: <Pencil size={18} />,
        onSelect: () => setEditing(true),
      })
    }
    if (m.authorId === props.currentUserId || props.isAdmin) {
      out.push({
        id: "delete",
        label: i18n.t("kernel.common.delete"),
        icon: <Trash2 size={18} />,
        tone: "danger",
        onSelect: requestDelete,
      })
    }
    return out
  }
  const openSheet = () => {
    if (props.message.deletedAt || props.message.pending || editing()) return
    setSheetOpen(true)
  }
  const touchPress = createTouchPress({
    onLongPress: openSheet,
    onTap: openSheet,
    ignore: ownsItsPress,
    ignoreTap: ownsItsTap,
  })

  return (
    <div
      ref={touchPress}
      data-testid={isSystemDecision() ? "message-row-system-decision" : "message-row"}
      data-message-id={props.message.id}
      data-thread-id={props.message.threadId}
      class={`group relative flex gap-2.5 px-1 py-0.5 transition-colors hover:bg-surface-hover/50 data-[quote-highlight=true]:bg-accent/10 ${touchPressClass(
        editing(),
      )} ${props.message.pending ? "opacity-60" : ""} ${props.grouped ? "mt-0" : "mt-3"}`}
    >
      {/* Avatar or spacer */}
      <Show when={!props.grouped} fallback={<div class="w-8 shrink-0" />}>
        <div
          class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-medium"
          style={{
            "background-color": avatarColors(props.message.authorId).bg,
            color: avatarColors(props.message.authorId).text,
          }}
        >
          {props.message.authorName?.charAt(0).toUpperCase() ?? "?"}
        </div>
      </Show>

      <div class="min-w-0 flex-1">
        {/* Author + time (only for first in group) */}
        <Show when={!props.grouped}>
          <div class="flex items-baseline gap-2">
            <span class="text-[13px] font-semibold text-text">{props.message.authorName}</span>
            <span class="text-[11px] text-text-tertiary">
              {formatTime(props.message.createdAt)}
            </span>
          </div>
        </Show>

        <Show when={!props.message.deletedAt && props.message.metadata?.quote}>
          {(quote) => (
            <QuoteBlock message={props.message} quote={quote()} onClick={props.onQuoteClick} />
          )}
        </Show>

        {/* Content — edit mode or display */}
        <Show
          when={!props.message.deletedAt}
          fallback={
            <p class="text-[13px] italic text-text-tertiary">{i18n.t("kernel.messageDeleted")}</p>
          }
        >
          <Show
            when={editing()}
            fallback={
              <Show
                when={approvalRequestId()}
                fallback={
                  <div ref={contentEl} class="text-[13.5px] leading-relaxed text-text">
                    {props.message.content
                      ? props.renderContent(
                          isSystemDecision()
                            ? localizeSystemLine(
                                props.message.content,
                                i18n.t,
                                props.message.metadata as Record<string, unknown> | undefined,
                              )
                            : props.message.content,
                        )
                      : null}
                    <Show when={props.message.editedAt}>
                      <span class="ml-1 text-[11px] text-text-tertiary">
                        {i18n.t("kernel.threadsUi.edited")}
                      </span>
                    </Show>
                  </div>
                }
              >
                {(requestId) => (
                  <div class="mt-1">
                    <ApprovalCard requestId={requestId()} compact />
                  </div>
                )}
              </Show>
            }
          >
            <MessageEditField
              content={props.message.content ?? ""}
              onSave={saveEdit}
              onCancel={() => setEditing(false)}
            />
          </Show>
        </Show>

        <MessageAttachments message={props.message} />

        {/* Reactions */}
        <Show when={(props.message.reactions ?? []).length > 0}>
          <div class="mt-1 flex flex-wrap gap-1">
            <For each={props.message.reactions}>
              {(reaction) => (
                <Tooltip
                  placement="top"
                  content={reactorsLabel(
                    reaction.users,
                    reaction.count,
                    props.currentUserId,
                    i18n.t,
                  )}
                >
                  <button
                    type="button"
                    ref={createTouchPress({
                      onLongPress: () => setCardFor(reaction.emoji),
                      onTap: () => setCardFor(reaction.emoji),
                    })}
                    data-reaction-chip=""
                    data-testid={`reaction-chip-${reaction.emoji}`}
                    // A mouse click toggles the viewer's reaction. A finger's
                    // tap never reaches here: it opens the reactions card.
                    onClick={() => {
                      if (reaction.reacted) {
                        props.onRemoveReaction(props.message.id, reaction.emoji)
                      } else {
                        props.onReaction(props.message.id, reaction.emoji)
                      }
                    }}
                    class={`inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] transition-colors hover:bg-surface-hover ${
                      reaction.reacted
                        ? "border-accent/40 bg-accent/10 text-accent"
                        : "border-border-subtle text-text-secondary"
                    }`}
                    aria-label={`${reaction.reacted ? "Remove" : "Add"} ${reaction.emoji} reaction`}
                  >
                    {reaction.emoji} {reaction.count}
                  </button>
                </Tooltip>
              )}
            </For>
          </div>
        </Show>

        <ReplyThreadFooter message={props.message} onReplyInThread={props.onReplyInThread} />
      </div>

      {/* Action toolbar — reply in thread, reaction picker, edit/delete menu.
          Not over a message being edited: it sat on the edit field's text. */}
      <Show when={!props.message.deletedAt && !props.message.pending && !editing()}>
        <div
          class={`absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5 transition-opacity ${
            activeMenu()
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
          }`}
        >
          <Show when={props.onReplyInThread && !props.message.replyRootId && !isSystemDecision()}>
            <ReplyInThreadButton
              messageId={props.message.id}
              onClick={() => props.onReplyInThread?.(props.message.id)}
            />
          </Show>
          {/* Reaction picker — available on ALL messages */}
          <ReactionPicker onSelect={(emoji) => props.onReaction(props.message.id, emoji)} />

          {/* Quote (anyone, on a quotable surface) + edit/delete (own messages or admin) */}
          <Show when={canQuote() || canManageOwn()}>
            <PopupMenu open={activeMenu()} onOpenChange={(open) => setActiveMenu(open)}>
              <PopupMenu.Trigger
                class="flex h-6 w-6 items-center justify-center rounded bg-surface shadow-sm ring-1 ring-border-subtle hover:bg-surface-hover"
                aria-label={i18n.t("kernel.messageActions")}
              >
                <Ellipsis size={14} class="text-text-secondary" />
              </PopupMenu.Trigger>
              <PopupMenu.Content>
                <Show when={canQuote()}>
                  <PopupMenu.Item onSelect={quoteFromMenu}>
                    <Quote size={13} /> {i18n.t("kernel.replyThreads.quote")}
                  </PopupMenu.Item>
                </Show>
                <Show when={props.message.authorId === props.currentUserId}>
                  <PopupMenu.Item onSelect={() => setEditing(true)}>
                    <Pencil size={13} /> {i18n.t("kernel.common.edit")}
                  </PopupMenu.Item>
                </Show>
                <Show when={canManageOwn()}>
                  <PopupMenu.Item onSelect={requestDelete} variant="danger">
                    <Trash2 size={13} /> {i18n.t("kernel.common.delete")}
                  </PopupMenu.Item>
                </Show>
              </PopupMenu.Content>
            </PopupMenu>
          </Show>
        </div>
      </Show>

      <Show when={sheetMounted()}>
        <MessageActionSheet
          open={sheetOpen()}
          onClose={() => setSheetOpen(false)}
          messageId={props.message.id}
          actions={sheetActions()}
          onReact={(emoji) => props.onReaction(props.message.id, emoji)}
        />
      </Show>
      {deleteConfirm}
      <Show when={cardMounted()}>
        <ReactionsCard
          open={cardFor() !== null && (props.message.reactions ?? []).length > 0}
          onClose={() => setCardFor(null)}
          messageId={props.message.id}
          reactions={props.message.reactions ?? []}
          currentUserId={props.currentUserId}
          focusEmoji={cardFor()}
          onReact={(emoji) => props.onReaction(props.message.id, emoji)}
          onRemove={(emoji) => props.onRemoveReaction(props.message.id, emoji)}
        />
      </Show>
    </div>
  )
}

export default MessageRow
