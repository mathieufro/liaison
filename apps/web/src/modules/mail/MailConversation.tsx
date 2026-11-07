// SPDX-License-Identifier: FSL-1.1-ALv2
// MailConversation — single-column layout matching Tickets vibe:
// consolidated 2-row header (handle/account · status pill · actions; subject
// + assignee chip), banners, message stream with avatar gutter, reply bar.

import { type ApprovalRequestSummary, htmlToText } from "@liaison/shared"
import { MessageSquare } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { createQuoteCache, splitQuotedHistory, splitQuotedHtml } from "~/lib/email-quote"
import ApprovalCard from "~/modules/approvals/ApprovalCard"
import { userFromToken } from "~/modules/auth/auth-store"
import { AttachmentStrip } from "~/modules/files/AttachmentStrip"
import { useI18n } from "~/modules/i18n/i18n-context"
import { AssigneePicker } from "~/modules/mail/AssigneePicker"
import { MailEncryptionEnrollmentBanner } from "~/modules/mail/MailEncryptionEnrollmentBanner"
import { MailMessageRenderer } from "~/modules/mail/MailMessageRenderer"
import { MailReplyBar } from "~/modules/mail/MailReplyBar"
import { getAccount } from "~/modules/mail/mail-account-store"
import {
  closeMailConversationMoreSheet,
  isMailConversationMoreSheetOpen,
} from "~/modules/mail/mail-conversation-phone-header-store"
import {
  archiveConversation,
  claimConversation,
  conversationStore,
  reassignConversation,
} from "~/modules/mail/mail-conversation-store"
import { deriveSubject, openedSubjectOf } from "~/modules/mail/mail-conversation-subject"
import { mailConversationTabLabel } from "~/modules/mail/mail-conversation-tab-label"
import { createDraft, saveDraft } from "~/modules/mail/mail-draft-store"
import {
  getDiscussionMarkers,
  getMessages,
  loadMessages,
  loadOlderMessages,
  type MailMessage,
} from "~/modules/mail/mail-message-store"
import { forwardBody, forwardSubject } from "~/modules/mail/mail-phone-view"
import { openMailAttachment } from "~/modules/mailbox/attachment-download"
import { MailboxLockedPanel } from "~/modules/mailbox/MailboxLockedPanel"
import { mailboxStore } from "~/modules/mailbox/mailbox-store"
import { useApi } from "~/modules/shell/ApiContext"
import EntityPreview from "~/modules/shell/entity-preview/EntityPreview"
import { presentMessageKind } from "~/modules/shell/message-kind"
import { quotedHistoryLabels } from "~/modules/shell/quoted-history-labels"
import { createSlotPanels, SlotPanels } from "~/modules/shell/SlotPanels"
import { shellTier } from "~/modules/shell/shell-tier"
import { makeTabId, openTab, tabStore, tabToUrl, updateTabLabel } from "~/modules/shell/tab-store"
import { discussWithPersonalAgent } from "~/modules/threads/personal-dm-store"
import { Avatar } from "~/ui/AvatarStack"
import { avatarColors } from "~/ui/avatar-palette"
import { OverlaySheet } from "~/ui/OverlaySheet"
import { QuotedHistory } from "~/ui/QuotedHistory"
import { ScrollFade } from "~/ui/ScrollFade"
import { ThreadMap } from "~/ui/ThreadMap"
import { ThreadMapDrawer } from "~/ui/ThreadMapDrawer"
import { Tooltip } from "~/ui/Tooltip"
import { type ThreadMapItem, threadMapFirstLine, threadMapPlainText } from "~/ui/thread-map-model"
import {
  clearThreadMapSize,
  closeThreadMap,
  isThreadMapOpen,
  openThreadMap,
  setThreadMapSize,
} from "~/ui/thread-map-store"

const MailConvertToTicketDialog = lazy(() =>
  import("~/modules/tickets/MailConvertToTicketDialog").then((m) => ({
    default: m.MailConvertToTicketDialog,
  })),
)

interface MailQuoteSplit {
  mode: "html" | "text"
  visible: string
  quoted: string
}

// conversationItems() re-derives (and the rows remount) on every store
// update, so the split of a long quoted chain is cached per message.
const quoteSplitCache = createQuoteCache<MailQuoteSplit>()
const visibleTextCache = createQuoteCache<string>()

/**
 * Splits a message into its visible reply and its folded quoted history: HTML
 * structurally (as a whole document, so the renderer keeps the email's head
 * styles and body attributes), text-only against the previous message. A
 * reply written in Liaison holds only what was written: a quote in it is part
 * of the reply, never history to fold away.
 */
function splitMailMessage(msg: MailMessage, prev: MailMessage | undefined): MailQuoteSplit {
  const writtenHere = msg.direction === "outbound" && !!msg.sentByUser
  const html = msg.htmlBody
  if (html) {
    if (writtenHere) return { mode: "html", visible: html, quoted: "" }
    return quoteSplitCache.get(`html:${msg.id}`, html, () => {
      const s = splitQuotedHtml(html, { document: true })
      return { mode: "html", visible: s.visibleHtml, quoted: s.quotedHtml }
    })
  }
  const text = msg.textBody ?? ""
  if (writtenHere || !text) return { mode: "text", visible: text, quoted: "" }
  const prevText = prev?.textBody ?? ""
  return quoteSplitCache.get(`text:${msg.id}`, `${text}\u0000${prevText}`, () => {
    const s = splitQuotedHistory(text, prevText)
    return { mode: "text", visible: s.visible, quoted: s.quoted }
  })
}

/** One row of a phone action sheet: full width, 44px tall, left aligned. */
const phoneSheetRowClass =
  "flex min-h-11 w-full items-center px-4 py-3 text-left text-[15px] text-text hover:bg-surface-hover"

interface MailConversationProps {
  entityId: string
}

const STATUS_TONE: Record<string, { dot: string; text: string; label: string }> = {
  open: { dot: "bg-emerald-400", text: "text-emerald-300", label: "mail.status.open" },
  archived: { dot: "bg-zinc-500", text: "text-zinc-400", label: "mail.status.archived" },
  trashed: { dot: "bg-zinc-500", text: "text-zinc-400", label: "mail.status.trashed" },
  escalated: { dot: "bg-violet-400", text: "text-violet-300", label: "mail.status.escalated" },
}

function avatarInitials(name: string | null | undefined, fallback: string): string {
  const source = (name ?? "").trim() || fallback
  const parts = source.split(/\s+/).filter(Boolean)
  const letters = parts
    .slice(0, 2)
    .map((p) => p[0]!)
    .join("")
  return letters.toUpperCase() || fallback.slice(0, 2).toUpperCase()
}

export const MailConversation: Component<MailConversationProps> = (props) => {
  const i18n = useI18n()
  // True while at least one row of this conversation is sealed and unopened.
  const anyMessageLocked = () =>
    getMessages(props.entityId).some((m) => (m as { encState?: string }).encState === "locked")
  const api = useApi()
  let scrollRef!: HTMLDivElement
  let streamRef: HTMLDivElement | undefined
  const [error, setError] = createSignal<string | null>(null)
  // A 404 is not a glitch a retry can fix: the conversation is not one this
  // user can read (another person's personal mailbox, an inbox they were
  // removed from, a thread that was merged away). It says so, and offers no
  // Retry that could only fail again.
  const [unavailable, setUnavailable] = createSignal(false)

  // Every load, the first one and each Retry, settles here: a rejection that
  // escaped used to surface as an unhandled "Conversation not found".
  async function load(conversationId: string): Promise<void> {
    setError(null)
    setUnavailable(false)
    try {
      await loadMessages(api, conversationId)
      requestAnimationFrame(() => {
        if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight
      })
    } catch (err) {
      const gone = err instanceof ApiError && (err.status === 404 || err.status === 403)
      setUnavailable(gone)
      setError(i18n.t(gone ? "mail.conversationUnavailable" : "mail.conversationLoadFailed"))
    }
  }

  createEffect(
    on(
      () => props.entityId,
      (conversationId) => void load(conversationId),
    ),
  )
  // The thread mounts fresh when the mailbox unlocks: land on the newest
  // message, as a first load does.
  createEffect(
    on(
      anyMessageLocked,
      (locked, wasLocked) => {
        if (wasLocked && !locked)
          requestAnimationFrame(() => {
            if (scrollRef) scrollRef.scrollTop = scrollRef.scrollHeight
          })
      },
      { defer: true },
    ),
  )

  // S10: this tab is titled with the email's subject once it is known, even
  // when an opener labelled it with a notification's text, and again after an
  // unlock turns "Conversation" into the real subject. Stored on the tab so a
  // restored tab starts with it; the tab type's resolveLabel covers the rest.
  createEffect(() => {
    const label = mailConversationTabLabel(props.entityId, i18n.t)
    if (!label) return
    const tabId = makeTabId("mail:conversation", props.entityId)
    const current = untrack(() => tabStore.tabs.find((t) => t.id === tabId)?.label)
    if (current !== undefined && current !== label) updateTabLabel(tabId, label)
  })

  const conversation = () => conversationStore.byId[props.entityId]
  const messageList = () => getMessages(props.entityId)
  // The previous message in thread order (markers interleave in
  // conversationItems, so it comes from messageList).
  const previousMessage = (msg: MailMessage): MailMessage | undefined => {
    const list = messageList()
    const i = list.findIndex((m) => m.id === msg.id)
    return i > 0 ? list[i - 1] : undefined
  }
  // Which messages have their quoted history expanded, and which show its
  // original. Kept here, not in the row: rows remount whenever
  // conversationItems() re-derives.
  const [expandedQuotes, setExpandedQuotes] = createSignal<Record<string, boolean>>({})
  const [originalQuotes, setOriginalQuotes] = createSignal<Record<string, boolean>>({})
  const quoteLabels = createMemo(() => quotedHistoryLabels(i18n.t))
  // The thread's messages as plain visible text, once per thread: a quoted
  // copy of one of them links up to it instead of repeating it.
  const threadTexts = createMemo(() => {
    const list = messageList()
    return list.flatMap((m, i) => {
      if (m.encState === "locked") return []
      const s = splitMailMessage(m, list[i - 1])
      const text =
        s.mode === "html"
          ? visibleTextCache.get(m.id, s.visible, () => htmlToText(s.visible))
          : s.visible
      return [{ id: m.id, text }]
    })
  })
  function scrollToMessage(id: string): void {
    const el = scrollRef?.querySelector(`[data-message-id="${id}"]`)
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    el?.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" })
  }
  const conversationItems = () =>
    [
      ...messageList().map((message) => ({
        kind: "message" as const,
        at: message.sentAt,
        message,
      })),
      ...getDiscussionMarkers(props.entityId).map((marker) => ({
        kind: "marker" as const,
        at: marker.createdAt,
        marker,
      })),
    ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  const senderLabel = (msg: any) =>
    msg.fromAddress?.name ?? msg.fromAddress?.email ?? i18n.t("kernel.common.unknown")
  // The phone header (a separate component) offers the thread drawer only
  // from 3 messages: it learns the count through the shared store. While a
  // message is locked or the load failed the drawer is not rendered, so the
  // count reads 0 and the header hides its button.
  const threadMapKey = () => `mail:${props.entityId}`
  createEffect(
    on(threadMapKey, (key) => {
      onCleanup(() => clearThreadMapSize(key))
    }),
  )
  createEffect(() =>
    setThreadMapSize(threadMapKey(), error() || anyMessageLocked() ? 0 : messageList().length),
  )
  // The thread map's entries, one per rendered row in the same order: each
  // message root and discussion marker carries `data-thread-map-id`.
  const threadMapItems = createMemo<ThreadMapItem[]>(() => {
    const shortDate = (at: string) =>
      new Date(at).toLocaleDateString(i18n.locale(), { day: "numeric", month: "short" })
    return conversationItems().map((item) =>
      item.kind === "message"
        ? {
            id: item.message.id,
            kind: item.message.direction === "outbound" ? "out" : "in",
            who: senderLabel(item.message),
            dateLabel: shortDate(item.message.sentAt),
            line: threadMapFirstLine(
              item.message.textBody || threadMapPlainText(item.message.htmlBody),
            ),
          }
        : {
            id: item.marker.id,
            kind: "event",
            who: item.marker.author.name ?? "",
            dateLabel: shortDate(item.marker.createdAt),
            line: item.marker.excerpt,
          },
    )
  })
  const account = () => {
    const c = conversation()
    return c ? getAccount(c.accountId) : undefined
  }
  const showAssignmentControls = () => {
    const a = account()
    return !!conversation() && a?.ownerType === "org"
  }
  // What other apps add, from the one server list: the viewer's, from apps that are on.
  const banners = createSlotPanels(() => "mail:conversation:banner")
  const actions = createSlotPanels(() => "mail:conversation:actions")

  // Pending gated mail:reply/forward approvals for this conversation, rendered
  // INLINE at the bottom of the message stream (same treatment as tickets) so
  // the gate reads as part of the exchange. Refreshes on conversation change
  // and on `mail:approvals-invalidated` (dispatched by the WS approval_request
  // handler via handleMailApprovalWs).
  const [approvalsRefreshKey, setApprovalsRefreshKey] = createSignal(0)
  onMount(() => {
    function onInvalidated(e: Event): void {
      const detail = (e as CustomEvent<{ conversationId?: string }>).detail
      if (detail?.conversationId !== props.entityId) return
      setApprovalsRefreshKey((k) => k + 1)
    }
    window.addEventListener("mail:approvals-invalidated", onInvalidated)
    onCleanup(() => window.removeEventListener("mail:approvals-invalidated", onInvalidated))
  })
  const [approvals] = createResource(
    () => [props.entityId, approvalsRefreshKey()] as const,
    async ([conversationId]) => {
      const res = await api.getEnvelope<ApprovalRequestSummary[]>(
        `/approvals?conversationId=${conversationId}`,
      )
      return res.data
    },
  )
  const pendingApprovals = createMemo(() =>
    approvals.error ? [] : (approvals() ?? []).filter((a) => a.status === "pending"),
  )

  /** Deep link to this conversation: the route its tab already carries. */
  function conversationLink(): string {
    const tabId = makeTabId("mail:conversation", props.entityId)
    const tab = tabStore.tabs.find((t) => t.id === tabId)
    return tab ? tabToUrl(tab) : window.location.pathname
  }

  // "Discuss" is now one message in the viewer's own DM with their agent: no
  // per-conversation discussion thread, no side panel. The desktop affordance
  // and the phone sheet row name it with the SAME kernel string, so the two
  // tiers cannot drift apart again.
  async function handleDiscuss(): Promise<void> {
    await discussWithPersonalAgent(
      {
        title: deriveSubject(
          conversation(),
          anyMessageLocked(),
          i18n.t,
          openedSubjectOf(getMessages(props.entityId)),
        ),
        link: conversationLink(),
        // The agent, and the reader, get a reference that OPENS the mail,
        // not the bare "/mail/af05..." path the message used to carry.
        ref: `mail:conversation:${props.entityId}`,
      },
      api,
    )
  }

  // --- Phone tier (M2-2 T15) ---
  // The pinned action bar. K4: the nav bar moved OUT of this component into
  // `MailConversationPhoneHeader`, registered onto the tab type at runtime, so
  // MainPanel's phone top bar renders it in place of its own generic bar
  // instead of stacking a second one above it. The "⋯" sheet's open flag is
  // now the shared `mail-conversation-phone-header-store` signal: the header
  // (a separate component) flips it, this component still renders the sheet
  // and owns everything it does (archive, convert, discuss all need data and
  // mutations that live here).
  const phone = () => shellTier() === "phone"
  const moreOpen = () => isMailConversationMoreSheetOpen(props.entityId)
  const [composerMode, setComposerMode] = createSignal<"reply" | "reply-all" | null>(null)
  const [showConvert, setShowConvert] = createSignal(false)

  /**
   * Forward opens the SAME compose view the Compose control opens, on a draft
   * seeded from the last message of this conversation. It carries no
   * `conversationId`, because a forward is a new exchange with someone else,
   * not another reply on this thread.
   */
  async function handleForward(): Promise<void> {
    const c = conversation()
    const accountId = c?.accountId
    if (!accountId) return
    const last = messageList()[messageList().length - 1]
    const draft = await createDraft(api, { accountId })
    const subject = forwardSubject(c?.subject)
    await saveDraft(api, draft.id, {
      subject,
      textBody: last
        ? forwardBody({
            fromName: last.fromAddress?.name ?? null,
            fromEmail: last.fromAddress?.email ?? null,
            sentAt: last.sentAt,
            textBody: last.textBody,
            htmlBody: last.htmlBody,
          })
        : "",
    })
    openTab({ type: "mail:compose", entityId: draft.id, label: subject })
  }

  async function handleScrollUp(): Promise<void> {
    if (!scrollRef || scrollRef.scrollTop > 200) return
    // Capture the scroll height before prepending older messages so we can
    // restore the viewport to the same visual position afterwards.
    const prevScrollHeight = scrollRef.scrollHeight
    await loadOlderMessages(api, props.entityId)
    // After the DOM updates, shift scrollTop by the height delta so the
    // content the user was reading stays in view.
    requestAnimationFrame(() => {
      if (scrollRef) {
        scrollRef.scrollTop += scrollRef.scrollHeight - prevScrollHeight
      }
    })
  }

  return (
    <div class="flex h-full flex-col bg-surface text-text" data-testid="mail-conversation">
      {/* Same notice as the list view: a reader who opened an old thread still
          needs to know why nothing new is arriving. */}
      <MailEncryptionEnrollmentBanner />
      {/* Consolidated header — same vibe as Tickets: 2 dense rows, no rail. */}
      <Show when={conversation()}>
        {(c) => {
          const tone = () => STATUS_TONE[c().status] ?? STATUS_TONE.open!
          return (
            // K4: at phone tier this screen renders NO bar of its own — the
            // nav bar now lives in `MailConversationPhoneHeader`, registered
            // onto the tab type and rendered by MainPanel's phone top bar.
            <Show when={!phone()}>
              <header class="border-b border-border bg-surface">
                {/* Row 1 — handle (account) · status · labels · actions */}
                <div class="flex items-center gap-3 px-5 pt-4 pb-2">
                  <span class="font-mono text-[11px] uppercase tracking-wider text-text-tertiary">
                    {i18n.t("mail.mail")} {account()?.emailAddress ?? "inbox"}
                  </span>
                  <span class="h-3 w-px bg-border" />
                  <span
                    class={`inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-0.5 text-xs ${tone().text}`}
                    data-testid="mail-status-pill"
                  >
                    <span class={`h-1.5 w-1.5 rounded-full ${tone().dot}`} />
                    <span class="font-medium">{i18n.t(tone().label)}</span>
                  </span>

                  <Show when={c().labels?.length}>
                    <For each={c().labels.slice(0, 2)}>
                      {(label) => (
                        <span class="inline-flex items-center rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-text-tertiary">
                          {label}
                        </span>
                      )}
                    </For>
                  </Show>

                  <div class="ml-auto flex items-center gap-1">
                    <SlotPanels
                      slot="mail:conversation:actions"
                      entries={actions}
                      entityId={props.entityId}
                      panelProps={{ mailConversationId: props.entityId }}
                      position="actions"
                    />
                    <Tooltip content={i18n.t("kernel.mailDiscuss")}>
                      <button
                        type="button"
                        data-testid="mail-add-note"
                        aria-label={i18n.t("kernel.mailDiscuss")}
                        class="flex items-center justify-center rounded-md p-1.5 text-text-secondary transition-colors hover:bg-surface-sunken hover:text-text"
                        onClick={() => void handleDiscuss()}
                      >
                        <MessageSquare size={16} />
                      </button>
                    </Tooltip>
                  </div>
                </div>

                {/* Row 2 — subject + assignee/claim chip */}
                <div class="flex items-start gap-3 px-5 pb-3">
                  <h2
                    class="-mx-1 flex-1 truncate cursor-text rounded px-1 text-[19px] font-semibold leading-7 text-text"
                    data-testid="mail-conversation-subject"
                  >
                    {deriveSubject(
                      c(),
                      anyMessageLocked(),
                      i18n.t,
                      openedSubjectOf(getMessages(props.entityId)),
                    )}
                  </h2>

                  <Show when={showAssignmentControls()}>
                    <Show
                      when={c().assignedTo}
                      fallback={
                        <button
                          type="button"
                          data-testid="conversation-header-claim"
                          aria-label={i18n.t("mail.claim")}
                          class="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] text-text-tertiary hover:text-text-secondary"
                          onClick={() => {
                            const userId = userFromToken()?.userId
                            if (userId) void claimConversation(api, props.entityId, userId)
                          }}
                        >
                          <span class="text-[14px] leading-none">+</span> {i18n.t("mail.claim")}
                        </button>
                      }
                    >
                      <div class="shrink-0">
                        <AssigneePicker
                          assignedTo={c().assignedTo!}
                          accountId={c().accountId}
                          onReassign={(userId) => reassignConversation(api, props.entityId, userId)}
                        />
                      </div>
                    </Show>
                  </Show>
                </div>
              </header>
            </Show>
          )
        }}
      </Show>

      {/* Banners other apps add (a customer card) share the column: capped
          and scrolling, so a tall one never pushes the reply bar below the
          panel's edge, where its reserve was clipped and the dock's bar sat
          on Send. Where the cap cuts a banner, the cut fades out: a bare cut
          left half an order row of the card against the thread's first
          message, which then read as drawn over the card. */}
      <Show when={banners().length > 0}>
        <ScrollFade
          class="max-h-[45%] min-h-0 shrink"
          scrollClass="flex flex-col"
          scrollTestId="mail-conversation-banners"
        >
          <SlotPanels
            slot="mail:conversation:banner"
            entries={banners}
            entityId={props.entityId}
            panelProps={{ mailConversationId: props.entityId }}
          />
        </ScrollFade>
      </Show>

      <Show when={error()}>
        <div class="flex flex-1 flex-col items-center justify-center gap-2">
          <p
            data-testid="mail-conversation-load-error"
            class={
              unavailable()
                ? "max-w-sm text-center text-sm text-text-secondary"
                : "text-sm text-red-500"
            }
          >
            {error()}
          </p>
          <Show when={!unavailable()}>
            <button
              type="button"
              class="text-sm text-accent hover:underline"
              onClick={() => void load(props.entityId)}
            >
              {i18n.t("kernel.common.retry2")}
            </button>
          </Show>
        </div>
      </Show>

      {/* A locked mailbox cannot open this thread's messages. Rather than a
          column of senders over empty bodies, the reader gets the one way in. */}
      <Show when={!error() && anyMessageLocked()}>
        <div class="flex flex-1 flex-col" data-testid="mail-conversation-locked">
          <MailboxLockedPanel
            variant="page"
            devicePrfMismatch={mailboxStore.lastErrorCode === "MAILBOX_DEVICE_PRF_MISMATCH"}
          />
        </div>
      </Show>

      <Show when={!error()}>
        <Show when={!anyMessageLocked()}>
          {/* The scroller and, on a long thread past the phone tier, the
              thread map beside it (ThreadMap hides itself on a short one). */}
          <div class="relative flex min-h-0 flex-1">
            <div
              ref={scrollRef!}
              data-testid="mail-conversation-scroll"
              class={`min-w-0 flex-1 overflow-y-auto py-5 ${phone() ? "px-3" : "px-5"}`}
              onScroll={() => void handleScrollUp()}
            >
              <div class="flex flex-col gap-5" ref={streamRef}>
                <For each={conversationItems()}>
                  {(item) => (
                    <Show
                      when={item.kind === "marker"}
                      fallback={(() => {
                        const msg = item.kind === "message" ? item.message : null
                        if (!msg) return null
                        const isOutbound = msg.direction === "outbound"
                        const fromName = senderLabel(msg)
                        const seed = msg.fromAddress?.email ?? msg.id
                        const initials = avatarInitials(
                          msg.fromAddress?.name ?? msg.fromAddress?.email,
                          fromName,
                        )
                        const quoteSplit = createMemo(() =>
                          splitMailMessage(msg, previousMessage(msg)),
                        )
                        return (
                          // Mail gave inbound and outbound NO visual weight
                          // difference: the only cue was a small "to customer"
                          // caption, so a thread of replies read as one
                          // undifferentiated column (ticket-10175). The same rail
                          // the ticket stream uses now carries it here, so the two
                          // surfaces stop diverging.
                          <div
                            class="relative flex gap-3 rounded-r pl-3"
                            data-testid="mail-message"
                            data-message-id={msg.id}
                            data-thread-map-id={msg.id}
                            data-tone={presentMessageKind(isOutbound ? "outbound" : "inbound").tone}
                          >
                            <Show
                              when={presentMessageKind(isOutbound ? "outbound" : "inbound").rail}
                            >
                              <span
                                aria-hidden="true"
                                data-testid="mail-message-rail"
                                class={`pointer-events-none absolute inset-y-0 left-0 w-[3px] rounded-full ${presentMessageKind(isOutbound ? "outbound" : "inbound").rail}`}
                              />
                            </Show>
                            {/* The one app wide avatar palette. Mail used to carry
                            its own vivid `bg-*-600` set, so the same person
                            wore one colour here and another in a thread. */}
                            <span
                              data-testid="mail-message-avatar"
                              class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                              style={{
                                "background-color": avatarColors(seed).bg,
                                color: avatarColors(seed).text,
                              }}
                            >
                              {initials}
                            </span>
                            <div class="min-w-0 flex-1">
                              {/* ONE row at every width. At 390px a name that
                              could not shrink pushed "TO CUSTOMER" into
                              wrapping inside its own chip and knocked "Sent"
                              and the timestamp off the baseline: the name is
                              the only part allowed to give, by truncating, and
                              the chip, the caption and the date stay whole. */}
                              <div class="mb-1 flex min-w-0 items-center gap-2 text-[11px]">
                                <Show
                                  when={conversation()?.contactId}
                                  fallback={
                                    <span
                                      data-testid="mail-message-from"
                                      class="min-w-0 truncate font-semibold text-text"
                                    >
                                      {fromName}
                                    </span>
                                  }
                                >
                                  <EntityPreview
                                    app="kernel"
                                    entityType="contact"
                                    entityId={conversation()!.contactId!}
                                    class="min-w-0"
                                  >
                                    <span
                                      data-testid="mail-message-from"
                                      class="min-w-0 truncate font-semibold text-text"
                                    >
                                      {fromName}
                                    </span>
                                  </EntityPreview>
                                </Show>
                                <Show
                                  when={isOutbound && msg.sentByUser}
                                  fallback={
                                    <Show when={isOutbound}>
                                      <span
                                        data-testid="mail-message-to-customer"
                                        class="shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-accent-glow text-accent"
                                        title={i18n.t(presentMessageKind("outbound").visibilityKey)}
                                      >
                                        {i18n.t("mail.toCustomer")}
                                      </span>
                                    </Show>
                                  }
                                >
                                  <span
                                    data-testid="mail-message-attribution"
                                    class="flex min-w-0 items-center gap-1 text-[10px] text-text-tertiary"
                                  >
                                    <Avatar user={msg.sentByUser!} size="sm" />
                                    <span class="min-w-0 truncate">
                                      {msg.sentByUser!.name ?? i18n.t("mail.agent")}{" "}
                                      {i18n.t("mail.repliedVia")} {msg.fromAddress?.email}
                                    </span>
                                  </span>
                                </Show>
                                <Show when={isOutbound && !msg.sentByUser}>
                                  <span
                                    data-testid="mail-message-sent"
                                    class="shrink-0 whitespace-nowrap text-[10px] text-text-tertiary"
                                  >
                                    {i18n.t("mail.sent")}
                                  </span>
                                </Show>
                                <span
                                  data-testid="mail-message-date"
                                  class="ml-auto shrink-0 whitespace-nowrap font-mono text-[10px] text-text-tertiary"
                                >
                                  {new Date(msg.sentAt).toLocaleString()}
                                </span>
                              </div>
                              <Show when={msg.toAddresses?.length || msg.ccAddresses?.length}>
                                <div class="mb-1 flex flex-wrap items-center gap-x-3 text-[11px] text-text-tertiary">
                                  <Show when={msg.toAddresses?.length}>
                                    <span data-testid="mail-message-to">
                                      {i18n.t("mail.to2")}{" "}
                                      {msg.toAddresses
                                        .map((a: any) => a.name ?? a.email)
                                        .join(", ")}
                                    </span>
                                  </Show>
                                  <Show when={msg.ccAddresses?.length}>
                                    <span data-testid="mail-message-cc">
                                      {i18n.t("mail.cc2")}{" "}
                                      {msg.ccAddresses
                                        .map((a: any) => a.name ?? a.email)
                                        .join(", ")}
                                    </span>
                                  </Show>
                                </div>
                              </Show>
                              <Show when={msg.encState !== "locked"}>
                                <div
                                  class="rounded-lg bg-surface-sunken px-4 py-3 text-[13.5px] leading-relaxed text-text ring-1 ring-border"
                                  data-testid="mail-message-content"
                                >
                                  <MailMessageRenderer
                                    accountId={conversation()?.accountId ?? null}
                                    htmlBody={
                                      quoteSplit().mode === "html" ? quoteSplit().visible : null
                                    }
                                    textBody={
                                      quoteSplit().mode === "text"
                                        ? quoteSplit().visible
                                        : msg.textBody
                                    }
                                    senderDomain={msg.fromAddress?.email?.split("@")[1] ?? ""}
                                  />
                                  <Show when={quoteSplit().quoted}>
                                    <QuotedHistory
                                      quoted={quoteSplit().quoted}
                                      mode={quoteSplit().mode}
                                      cacheKey={msg.id}
                                      threadMessages={threadTexts().filter((t) => t.id !== msg.id)}
                                      onJump={scrollToMessage}
                                      labels={quoteLabels()}
                                      open={!!expandedQuotes()[msg.id]}
                                      onOpenChange={(open) =>
                                        setExpandedQuotes((prev) => ({ ...prev, [msg.id]: open }))
                                      }
                                      originalOpen={!!originalQuotes()[msg.id]}
                                      onOriginalOpenChange={(open) =>
                                        setOriginalQuotes((prev) => ({ ...prev, [msg.id]: open }))
                                      }
                                      testIdPrefix="mail-message-quote"
                                      testIdKey={msg.id}
                                      renderOriginal={(quoted) =>
                                        quoteSplit().mode === "html" ? (
                                          <MailMessageRenderer
                                            accountId={conversation()?.accountId ?? null}
                                            htmlBody={quoted}
                                            textBody={null}
                                            senderDomain={
                                              msg.fromAddress?.email?.split("@")[1] ?? ""
                                            }
                                            flattenQuotes
                                          />
                                        ) : (
                                          <pre class="whitespace-pre-wrap font-sans text-text-tertiary">
                                            {quoted}
                                          </pre>
                                        )
                                      }
                                    />
                                  </Show>
                                </div>
                              </Show>
                              <Show when={(msg.attachments ?? []).length > 0}>
                                <AttachmentStrip
                                  files={(msg.attachments ?? []).map((a: any) => ({
                                    id: a.id,
                                    filename: a.filename,
                                    mimeType: a.mimeType,
                                    sizeBytes: a.sizeBytes,
                                    thumbnailUrl: a.thumbnailUrl ?? null,
                                    disposition: a.disposition,
                                    contentId: a.contentId ?? null,
                                  }))}
                                  onDownload={(f) => {
                                    // Sealed at rest: the stored bytes are
                                    // ciphertext, so the download goes through the
                                    // crypto worker or it does not happen.
                                    void openMailAttachment(api, f).catch(() => {
                                      /* swallowed: user can retry */
                                    })
                                  }}
                                />
                              </Show>
                            </div>
                          </div>
                        )
                      })()}
                    >
                      <button
                        type="button"
                        data-testid="mail-discussion-marker"
                        data-thread-map-id={item.kind === "marker" ? item.marker.id : undefined}
                        class="mx-auto flex max-w-[80%] items-center gap-2 rounded-full border border-border bg-surface-sunken px-3 py-1.5 text-xs text-text-secondary hover:text-text"
                        onClick={() => {
                          void handleDiscuss().catch(() => {
                            /* surfaced by the api client's error toast */
                          })
                        }}
                      >
                        <MessageSquare size={13} />
                        <span class="font-medium">
                          {item.kind === "marker" && item.marker.author.name}
                        </span>
                        <span class="truncate">
                          {item.kind === "marker" && item.marker.excerpt}
                        </span>
                      </button>
                    </Show>
                  )}
                </For>
                <For each={pendingApprovals()}>
                  {(a) => (
                    <div data-testid="mail-conversation-approval-card" data-approval-id={a.id}>
                      <ApprovalCard requestId={a.id} compact />
                    </div>
                  )}
                </For>
              </div>
            </div>
            <Show
              when={!phone()}
              fallback={
                <ThreadMapDrawer
                  scrollEl={() => scrollRef}
                  contentEl={() => streamRef}
                  items={threadMapItems}
                  open={isThreadMapOpen(threadMapKey())}
                  onOpen={() => openThreadMap(threadMapKey())}
                  onClose={() => closeThreadMap()}
                  title={i18n.t("kernel.threadMap.drawerTitle")}
                  summary={(count, from, to) =>
                    i18n.t("kernel.threadMap.drawerSummary", { count, from, to })
                  }
                  pill={(index, total, who) =>
                    i18n.t("kernel.threadMap.position", { index, total, who })
                  }
                  openLabel={i18n.t("kernel.threadMap.open")}
                  closeLabel={i18n.t("kernel.close")}
                  noteTag={i18n.t("kernel.threadMap.noteTag")}
                />
              }
            >
              <ThreadMap
                scrollEl={() => scrollRef}
                contentEl={() => streamRef}
                items={threadMapItems}
                label={i18n.t("kernel.threadMap.label")}
                counter={(index, total) => i18n.t("kernel.threadMap.counter", { index, total })}
              />
            </Show>
          </div>
        </Show>

        <Show when={phone()} fallback={<MailReplyBar conversationId={props.entityId} />}>
          {/* Pinned bottom bar. It sits above the phone tab bar and keeps clear
              of the home indicator. */}
          <div
            class="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-3 pt-2"
            data-testid="mail-action-bar"
            data-tour-tier="phone"
            style={{ "padding-bottom": "calc(0.5rem + env(safe-area-inset-bottom, 0px))" }}
          >
            <button
              type="button"
              data-testid="mail-action-reply"
              class="min-h-11 flex-[2] rounded-lg bg-accent text-[15px] font-medium text-accent-foreground"
              onClick={() => setComposerMode("reply")}
            >
              {i18n.t("kernel.mailReply")}
            </button>
            <button
              type="button"
              data-testid="mail-action-reply-all"
              class="min-h-11 flex-1 rounded-lg border border-border text-[15px] text-text"
              onClick={() => setComposerMode("reply-all")}
            >
              {i18n.t("kernel.mailReplyAll")}
            </button>
            <button
              type="button"
              data-testid="mail-action-forward"
              class="min-h-11 flex-1 rounded-lg border border-border text-[15px] text-text"
              onClick={() => {
                void handleForward().catch(() => {
                  /* surfaced by the api client's error toast */
                })
              }}
            >
              {i18n.t("kernel.mailForward")}
            </button>
          </div>
        </Show>
      </Show>

      <Show when={phone()}>
        {/* The composer, full screen: the SAME component the desktop renders
            inline, opened on the tab the bar's button names. */}
        <OverlaySheet
          open={composerMode() !== null}
          onClose={() => setComposerMode(null)}
          variant="full"
          title={
            composerMode() === "reply-all"
              ? i18n.t("kernel.mailReplyAll")
              : i18n.t("kernel.mailReply")
          }
          closeLabel={i18n.t("kernel.close")}
        >
          <Show when={composerMode()} keyed>
            {(mode) => (
              <div data-testid="mail-composer-sheet" data-mode={mode}>
                <MailReplyBar
                  conversationId={props.entityId}
                  initialMode={mode}
                  startExpanded={true}
                />
              </div>
            )}
          </Show>
        </OverlaySheet>

        <OverlaySheet
          open={moreOpen()}
          onClose={() => closeMailConversationMoreSheet()}
          variant="bottom"
          title={i18n.t("kernel.mailConversationActions")}
          closeLabel={i18n.t("kernel.close")}
        >
          <div data-testid="mail-more-sheet">
            <button
              type="button"
              data-testid="mail-more-archive"
              class={phoneSheetRowClass}
              onClick={() => {
                closeMailConversationMoreSheet()
                void archiveConversation(api, props.entityId)
              }}
            >
              {i18n.t("kernel.mailArchive")}
            </button>
            <button
              type="button"
              data-testid="mail-more-convert"
              class={phoneSheetRowClass}
              onClick={() => {
                closeMailConversationMoreSheet()
                setShowConvert(true)
              }}
            >
              {i18n.t("kernel.mailConvertToTicket")}
            </button>
            <button
              type="button"
              data-testid="mail-more-discuss"
              class={phoneSheetRowClass}
              onClick={() => {
                closeMailConversationMoreSheet()
                void handleDiscuss().catch(() => {
                  /* surfaced by the api client's error toast */
                })
              }}
            >
              {i18n.t("kernel.mailDiscuss")}
            </button>
          </div>
        </OverlaySheet>

        <Show when={showConvert()}>
          <MailConvertToTicketDialog
            mailConversationId={props.entityId}
            onClose={() => setShowConvert(false)}
          />
        </Show>
      </Show>
    </div>
  )
}
