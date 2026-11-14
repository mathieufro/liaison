// SPDX-License-Identifier: FSL-1.1-ALv2
// TicketDetail — single-column layout: consolidated 3-row header
// (handle / status / priority / SLA / actions; subject + read-by; contact /
// assignee / follow-up chips), AI summary, conversation stream, composer.
// Closed-state replaces the composer with exactly one CTA (reopen,
// open-target, or open-linked-mail) per the manifest contract.

import type { Component } from "solid-js"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js"
import { disambiguatedLabel, markAmbiguousNames } from "~/lib/name-collision"
import { relativeTime } from "~/lib/relative-time"
import { appLink, canShare, share } from "~/lib/share"
import { userFromToken } from "~/modules/auth/auth-store"
import FileList from "~/modules/files/FileList"
import FileUploadButton from "~/modules/files/FileUploadButton"
import { useI18n } from "~/modules/i18n/i18n-context"
import { AssigneeListStatus, AssigneeSearchField } from "~/modules/members/AssigneeSearch"
import { createAssignableMembers } from "~/modules/members/assignable-members"
import { useApi } from "~/modules/shell/ApiContext"
import { BacklinksPanel } from "~/modules/shell/references/BacklinksPanel"
import { awayLabel } from "~/modules/shell/route-line"
import { createSlotPanels, SlotPanels } from "~/modules/shell/SlotPanels"
import { shellTier } from "~/modules/shell/shell-tier"
import { makeTabId, openTab, tabStore } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { TicketAssignSheet } from "~/modules/tickets/TicketAssignSheet"
import { loadCategories, ticketCategoryStore } from "~/modules/tickets/ticket-category-store"
import {
  assignTicket,
  clearTicketFollowup,
  getComposeSignature,
  loadTicket,
  markRead,
  reopenTicket,
  setCategory,
  setPriority,
  setStatus,
  setTicketFollowup,
  ticketDetailStore,
} from "~/modules/tickets/ticket-detail-store"
import { latestInboundCc, loadMessages } from "~/modules/tickets/ticket-message-store"
import {
  closeTicketMoreSheet,
  isTicketMoreSheetOpen,
  openTicketMoreSheet,
} from "~/modules/tickets/ticket-phone-header-store"
import { ticketSlaState } from "~/modules/tickets/ticket-phone-views"
import { avatarColors } from "~/ui/avatar-palette"
import { Button } from "~/ui/Button"
import { OverlaySheet } from "~/ui/OverlaySheet"
import { PopupMenu } from "~/ui/PopupMenu"
import { ResponsiveDetail } from "~/ui/ResponsiveDetail"
import { canNoteOnTickets, canReplyOnTickets, TicketComposer } from "./TicketComposer"
import { TicketConversationStream } from "./TicketConversationStream"
import { TicketSummaryCard } from "./TicketSummaryCard"
import type { Ticket, TicketCategory } from "./ticket-types"

const TicketCloseDialog = lazy(() =>
  import("./TicketCloseDialog").then((m) => ({ default: m.TicketCloseDialog })),
)
const TicketNudgeDialog = lazy(() =>
  import("./TicketNudgeDialog").then((m) => ({ default: m.TicketNudgeDialog })),
)
const TicketConvertToMailDialog = lazy(() =>
  import("./TicketConvertToMailDialog").then((m) => ({
    default: m.TicketConvertToMailDialog,
  })),
)

interface Props {
  entityId: string
}

const STATUS_TONE: Record<string, { dot: string; text: string; label: string }> = {
  open: { dot: "bg-emerald-400", text: "text-emerald-300", label: "tickets.status.open" },
  awaiting_customer: {
    dot: "bg-blue-400",
    text: "text-blue-300",
    label: "tickets.status.awaiting_customer",
  },
  awaiting_followup: {
    dot: "bg-violet-400",
    text: "text-violet-300",
    label: "tickets.status.awaiting_followup",
  },
  closed: { dot: "bg-zinc-500", text: "text-zinc-400", label: "tickets.status.closed" },
}

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "open", label: "tickets.status.open" },
  { value: "awaiting_customer", label: "tickets.status.awaiting_customer" },
  { value: "awaiting_followup", label: "tickets.status.awaiting_followup" },
]

const PRIORITY_TONE: Record<string, { glyph: string; text: string }> = {
  low: { glyph: "▽", text: "text-zinc-400" },
  normal: { glyph: "-", text: "text-zinc-400" },
  high: { glyph: "△", text: "text-orange-300" },
  urgent: { glyph: "▲", text: "text-red-300" },
}

const PRIORITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "low", label: "tickets.low" },
  { value: "normal", label: "tickets.normal" },
  { value: "high", label: "tickets.high" },
  { value: "urgent", label: "tickets.urgent" },
]

function slaTone(t: Ticket): "breached" | "approaching" | "ok" | null {
  if (t.firstResponseAt || (!t.slaDeadline && !t.slaBreachedAt)) return null
  return ticketSlaState(t, Date.now()) ?? "ok"
}

// Follow-up presets resurface the ticket at 09:00 local time N days out.
const FOLLOWUP_PRESETS: Array<{ label: string; days: number }> = [
  { label: "tickets.followupTomorrow", days: 1 },
  { label: "tickets.followupIn3Days", days: 3 },
  { label: "tickets.followupNextWeek", days: 7 },
]

function followupPresetIso(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  d.setHours(9, 0, 0, 0)
  return d.toISOString()
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

/** Every initials disc here reads the one app wide avatar palette, the same
 *  one the threads and contacts discs read. Tickets used to carry their own
 *  vivid `bg-*-600` set. */
function discStyle(seed: string) {
  const c = avatarColors(seed)
  return { "background-color": c.bg, color: c.text }
}

/** The contribution slot other apps add sidepanel panels through; each gets `{ ticketId }`. */
export const TICKET_DETAIL_PANEL_SLOT = "ticket:detail:panel"
/** The slot other apps add header actions through; each gets `entityId` = the ticket. */
export const TICKET_DETAIL_ACTIONS_SLOT = "ticket:detail:actions"

/** One row of a phone action sheet: full width, 44px tall, left aligned. */
const phoneSheetRowClass =
  "flex min-h-11 w-full items-center px-4 py-2 text-left text-[15px] text-text hover:bg-surface-hover"

const PANEL_PREF_KEY = "tickets.detailPanelOpen"

function readPanelPref(): boolean {
  try {
    return localStorage.getItem(PANEL_PREF_KEY) !== "0"
  } catch {
    return true
  }
}

export const TicketDetail: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const ticket = createMemo(() => ticketDetailStore.byId[props.entityId])

  /**
   * Hands the ticket's own address to whatever else the device can send it
   * with. The link is the deployment's `/tickets/<id>`, not `window.location`,
   * which inside the native shell is `capacitor://localhost` and opens on no
   * other device (lib/share.ts). A desktop browser with no share sheet copies
   * it instead, and says so.
   */
  async function shareTicket(): Promise<void> {
    const handle = ticket()?.handle
    const title = handle ? `#${handle}` : i18n.t("tickets.ticketActions")
    const outcome = await share({
      title,
      text: ticket()?.subject ?? title,
      url: appLink(`/tickets/${props.entityId}`),
    })
    if (outcome === "copied") addToast({ type: "success", message: i18n.t("kernel.linkCopied") })
  }
  const [showClose, setShowClose] = createSignal(false)
  const [showNudge, setShowNudge] = createSignal(false)
  const [showConvert, setShowConvert] = createSignal(false)
  const [statusOpen, setStatusOpen] = createSignal(false)
  const [priorityOpen, setPriorityOpen] = createSignal(false)
  const [readByOpen, setReadByOpen] = createSignal(false)
  const [kebabOpen, setKebabOpen] = createSignal(false)
  const [assignOpen, setAssignOpen] = createSignal(false)
  // Teammates for the assignee picker, loaded from the member directory the
  // first time the menu opens, then as its search field changes. A failure is
  // shown in the menu with a retry, never a silent list of just "me".
  const assignees = createAssignableMembers(api, assignOpen)
  function onAssignOpenChange(open: boolean) {
    setAssignOpen(open)
    if (!open) assignees.setQuery("")
  }
  const [followupOpen, setFollowupOpen] = createSignal(false)
  const [categoryOpen, setCategoryOpen] = createSignal(false)
  const [categoryError, setCategoryError] = createSignal<string | null>(null)
  const [ticketFileRefreshKey, setTicketFileRefreshKey] = createSignal(0)
  // Details sidepanel open/closed. Persisted because it is a working-style
  // preference, not per-ticket state: an operator who collapses it to read a
  // long thread does not want it back on the next ticket. Reads defensively —
  // localStorage throws in private-mode Safari and must not take the tab down.
  const [panelOpen, setPanelOpenRaw] = createSignal(readPanelPref())
  const setPanelOpen = (next: boolean | ((v: boolean) => boolean)): void => {
    const value = typeof next === "function" ? next(panelOpen()) : next
    setPanelOpenRaw(value)
    try {
      localStorage.setItem(PANEL_PREF_KEY, value ? "1" : "0")
    } catch {
      /* preference is best effort */
    }
  }
  let markReadTimer: ReturnType<typeof setTimeout> | undefined
  let lastInboundSeen: string | null | undefined

  // --- Phone tier (M2-1 T11) ---
  // A JS branch, not a `md:` class pair: the composer is ONE stateful component
  // (drafts, attachments, gated-send placeholders) and it cannot exist twice.
  // At phone width it lives in a full screen sheet; everywhere else, inline.
  const phone = () => shellTier() === "phone"
  const [composerFor, setComposerFor] = createSignal<"reply" | "note" | null>(null)
  // The sheet's OPEN flag lives in a shared store: the trigger that flips it
  // is TicketPhoneHeader, a SEPARATE component rendered by MainPanel's phone
  // top bar (see that file's comment for why), not this one.
  const moreOpen = () => isTicketMoreSheetOpen(props.entityId)
  // What other apps add, from the one server list: the viewer's, from apps that are on.
  const panelEntries = createSlotPanels(() => TICKET_DETAIL_PANEL_SLOT)
  const actionEntries = createSlotPanels(() => TICKET_DETAIL_ACTIONS_SLOT)
  const setMoreOpen = (open: boolean) => {
    if (open) openTicketMoreSheet(props.entityId)
    else closeTicketMoreSheet()
  }
  const [phoneAssignOpen, setPhoneAssignOpen] = createSignal(false)
  /** Phone: what other apps add to the details panel (the customer card), in a sheet. */
  const [phoneCustomerOpen, setPhoneCustomerOpen] = createSignal(false)
  const [phoneCategoryOpen, setPhoneCategoryOpen] = createSignal(false)
  const [phonePriorityOpen, setPhonePriorityOpen] = createSignal(false)
  const activeCategories = createMemo(() =>
    ticketCategoryStore.categories.filter((c) => !c.archivedAt),
  )
  const categoryRoots = createMemo(() => activeCategories().filter((c) => !c.parentId))
  const categoryChildrenByParent = createMemo(() => {
    const map = new Map<string, TicketCategory[]>()
    for (const c of activeCategories()) {
      if (!c.parentId) continue
      map.set(c.parentId, [...(map.get(c.parentId) ?? []), c])
    }
    return map
  })

  async function pickCategory(categoryId: string | null, categoryName: string | null) {
    setCategoryError(null)
    try {
      await setCategory(api, props.entityId, categoryId, categoryName)
    } catch (err: any) {
      setCategoryError(String(err?.message ?? err))
    }
  }

  function isActiveTicketTab(): boolean {
    return tabStore.activeTabId === makeTabId("tickets:ticket", props.entityId)
  }

  function canMarkRead(): boolean {
    return (
      isActiveTicketTab() &&
      (typeof document === "undefined" || document.visibilityState === "visible")
    )
  }

  function scheduleMarkRead(delayMs = 0): void {
    if (markReadTimer) clearTimeout(markReadTimer)
    markReadTimer = setTimeout(() => {
      if (canMarkRead()) void markRead(api, props.entityId)
    }, delayMs)
  }

  onMount(() => {
    // Parallel kickoff: the conversation fetch needs only the ticket id, so it
    // must NOT wait behind loadTicket (tickets:get is 1-2s on prod — chaining
    // them made big tickets open empty for the sum of both calls). The store
    // dedupes against loadTicket's own chained loadMessages.
    void loadMessages(api, props.entityId)
    void loadTicket(api, props.entityId).then(() => {
      scheduleMarkRead()
    })
    if (!ticketCategoryStore.loaded) void loadCategories(api)
    function onFocus(): void {
      if (canMarkRead()) scheduleMarkRead()
    }
    function onVisibility(): void {
      if (canMarkRead()) scheduleMarkRead()
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus)
      document.addEventListener("visibilitychange", onVisibility)
      onCleanup(() => {
        window.removeEventListener("focus", onFocus)
        document.removeEventListener("visibilitychange", onVisibility)
        if (markReadTimer) clearTimeout(markReadTimer)
      })
    }
  })

  // Lazy resync catch-up: a WS resync only reloads the ACTIVE ticket tab and
  // flags background keep-alive tabs stale (ticket-detail-store). When this
  // tab becomes the active one while flagged, reload it now.
  createEffect(() => {
    // Optional-chained: component tests mock the store module with a partial
    // shape that predates staleById.
    if (ticketDetailStore.staleById?.[props.entityId] && isActiveTicketTab()) {
      // A load from before the blip may still hang: restart it (S26).
      void loadTicket(api, props.entityId, { restart: true })
    }
  })

  createEffect(() => {
    const nextInbound = ticket()?.lastInboundAt ?? null
    if (lastInboundSeen === undefined) {
      lastInboundSeen = nextInbound
      return
    }
    if (nextInbound && nextInbound !== lastInboundSeen && canMarkRead()) {
      scheduleMarkRead(500)
    }
    lastInboundSeen = nextInbound
  })

  const loadFailed = createMemo(() => ticketDetailStore.loadFailedById[props.entityId])

  return (
    <Show
      when={ticket()}
      fallback={
        <Show
          when={loadFailed()}
          fallback={
            <div class="p-8 text-center text-text-secondary" data-testid="tickets-detail-loading">
              {i18n.t("tickets.loadingTicket")}
            </div>
          }
        >
          {(failure) => (
            <div
              class="flex flex-col items-center gap-3 p-8 text-center"
              data-testid="tickets-detail-load-failed"
            >
              <div class="text-text-primary font-medium">
                {failure() === "not_found"
                  ? i18n.t("tickets.thisTicketCanTBeOpened")
                  : i18n.t("tickets.couldnTLoadThisTicket")}
              </div>
              <div class="max-w-md text-sm text-text-secondary">
                {failure() === "not_found"
                  ? i18n.t("tickets.itMayHaveBeenDeletedOr")
                  : i18n.t("tickets.somethingWentWrongWhileLoadingCheck")}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadTicket(api, props.entityId)}
              >
                {i18n.t("kernel.common.retry2")}
              </Button>
            </div>
          )}
        </Show>
      }
    >
      {(t) => {
        const tone = createMemo(() => STATUS_TONE[t().status] ?? STATUS_TONE.open!)
        const pri = createMemo(() => PRIORITY_TONE[t().priority] ?? PRIORITY_TONE.normal!)
        const sla = createMemo(() => slaTone(t()))
        const closed = () => t().status === "closed"
        const readers = createMemo(() => t().readByRecent ?? [])
        // Two "Dana Reyes" in the org menu are unremarkable; the row only
        // needs her email when the assignee menu holds both of them.
        const assignCandidates = createMemo(() =>
          assignees
            .members()
            .filter((m) => m.id !== userFromToken()?.userId && m.id !== t().assignedTo),
        )
        const ambiguousAssignNames = createMemo(() =>
          markAmbiguousNames(assignCandidates(), (m) => m.name),
        )
        return (
          <div
            class="flex h-full bg-surface text-text"
            data-testid="tickets-detail"
            data-ticket-id={t().id}
          >
            <ResponsiveDetail
              class="h-full w-full min-w-0"
              contentClass="flex min-h-0 flex-col"
              metadataClass="md:w-80"
              content={
                /* CONVERSATION COLUMN — full height. Everything that is not the
                conversation lives in the right sidepanel, so the stream gets the
                window instead of competing with five stacked blocks for it.
                Approval gates still render INLINE in the stream (charter
                invariant), never in the panel. */
                <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                  <Show
                    when={phone()}
                    fallback={
                      <div class="flex items-center gap-3 border-b border-border px-5 py-2">
                        <span class="font-mono text-[11px] uppercase tracking-wider text-text-tertiary">
                          {i18n.t("tickets.tickets")} {t().handle}
                        </span>
                        <h1
                          class="min-w-0 flex-1 truncate text-[15px] font-semibold leading-6 text-text"
                          data-testid="tickets-detail-subject"
                        >
                          {t().subject}
                        </h1>
                        <button
                          type="button"
                          data-testid="tickets-detail-panel-toggle"
                          aria-expanded={panelOpen()}
                          aria-label={
                            panelOpen()
                              ? i18n.t("tickets.hideTicketDetails")
                              : i18n.t("tickets.showTicketDetails")
                          }
                          class="shrink-0 rounded border border-border-subtle px-2 py-0.5 text-[11px] text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
                          onClick={() => setPanelOpen((v) => !v)}
                        >
                          {panelOpen()
                            ? i18n.t("kernel.common.hideDetails")
                            : i18n.t("kernel.common.details")}
                        </button>
                      </div>
                    }
                  >
                    {/* The ticket's own nav bar (back, handle, ⋯) is rendered
                        by MainPanel's phone top bar now — TicketPhoneHeader,
                        registered via registerAppPhoneHeader (exports.ts) —
                        not here, so it renders exactly once. */}
                    {/* What the ticket IS, once, above the conversation. */}
                    <div
                      class="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3"
                      data-testid="ticket-phone-meta"
                      data-tour-tier="phone"
                    >
                      <h1
                        class="text-[20px] font-semibold leading-tight text-text"
                        data-testid="tickets-detail-subject"
                      >
                        {t().subject}
                      </h1>
                      <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
                        <Show when={sla()}>
                          {(s) => (
                            <span
                              data-testid="ticket-phone-pill-sla"
                              data-sla-tone={s()}
                              class={`rounded-full px-2 py-0.5 font-medium ${
                                s() === "breached"
                                  ? "bg-red-500/15 text-red-300"
                                  : s() === "approaching"
                                    ? "bg-amber-500/15 text-amber-300"
                                    : "bg-surface-sunken text-text-secondary"
                              }`}
                            >
                              {s() === "breached"
                                ? i18n.t("kernel.ticketsSlaBreached")
                                : i18n.t("kernel.ticketsSlaDue", {
                                    when: relativeTime(t().slaDeadline, i18n.locale()),
                                  })}
                            </span>
                          )}
                        </Show>
                        <span
                          class="rounded-full bg-surface-sunken px-2 py-0.5 text-text-secondary"
                          data-testid="ticket-phone-pill-status"
                        >
                          {i18n.t(tone().label)}
                        </span>
                        <Show when={t().category?.name ?? t().categoryName}>
                          {(name) => (
                            <span
                              class="rounded-full bg-surface-sunken px-2 py-0.5 text-text-secondary"
                              data-testid="ticket-phone-pill-category"
                            >
                              {name()}
                            </span>
                          )}
                        </Show>
                        <span
                          class="rounded-full bg-surface-sunken px-2 py-0.5 text-text-secondary"
                          data-testid="ticket-phone-pill-assignee"
                        >
                          {t().assignee?.name ??
                            t().assigneeName ??
                            i18n.t("kernel.ticketsUnassigned")}
                        </span>
                      </div>
                    </div>
                  </Show>
                  <div class="min-h-0 flex-1 overflow-y-auto" data-testid="tickets-detail-stream">
                    {/* Pending approval gates render inside the stream, inline with
                    the conversation (newest position), not as a separate panel. */}
                    <Suspense>
                      <TicketConversationStream
                        ticketId={t().id}
                        approvalThreadId={t().internalThreadId ?? null}
                      />
                    </Suspense>
                  </div>

                  <Show
                    when={!closed()}
                    fallback={
                      <div
                        class="flex items-center justify-between gap-3 border-t border-border bg-surface-emphasis p-3 text-sm"
                        data-testid="tickets-detail-footer-closed"
                      >
                        <span>
                          {i18n.t("tickets.thisTicketIsClosed")}
                          {t().closedReason ?? "-"}).
                        </span>
                        <Show
                          when={
                            t().closedReason === "converted_to_mail" &&
                            t().convertedToMailConversationId
                          }
                          fallback={
                            <Show
                              when={t().closedReason === "merged" && t().mergedIntoTicketId}
                              fallback={
                                <button
                                  type="button"
                                  class="rounded bg-accent px-3 py-1.5 text-accent-foreground"
                                  data-testid="tickets-detail-footer-reopen"
                                  onClick={() => void reopenTicket(api, t().id)}
                                >
                                  {i18n.t("tickets.reopen")}
                                </button>
                              }
                            >
                              {(targetId) => (
                                <button
                                  type="button"
                                  class="rounded border border-border px-3 py-1.5"
                                  data-testid="tickets-detail-footer-open-target"
                                  onClick={() =>
                                    openTab({
                                      type: "tickets:ticket",
                                      entityId: targetId(),
                                      label: i18n.t("tickets.ticket"),
                                    })
                                  }
                                >
                                  {i18n.t("tickets.openTargetTicket")}
                                </button>
                              )}
                            </Show>
                          }
                        >
                          {(conversationId) => (
                            <button
                              type="button"
                              class="rounded border border-border px-3 py-1.5"
                              data-testid="tickets-detail-footer-open-mail"
                              onClick={() =>
                                openTab({
                                  type: "mail:conversation",
                                  entityId: conversationId(),
                                  label: i18n.t("tickets.mailConversation"),
                                })
                              }
                            >
                              {i18n.t("tickets.openLinkedMailConversation")}
                            </button>
                          )}
                        </Show>
                      </div>
                    }
                  >
                    <Show
                      when={phone()}
                      fallback={
                        <TicketComposer
                          ticketId={t().id}
                          signatureText={getComposeSignature(t().id)}
                          defaultCc={latestInboundCc(t().id)}
                          recipientName={t().contact?.name ?? t().contact?.email}
                          onFileUploaded={() => setTicketFileRefreshKey((k) => k + 1)}
                        />
                      }
                    >
                      {/* Pinned bottom bar. It sits above the phone tab bar and
                          keeps clear of the home indicator. */}
                      <div
                        class="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-3 pt-2"
                        data-testid="ticket-action-bar"
                        data-tour-tier="phone"
                        style={{
                          "padding-bottom": "calc(0.5rem + env(safe-area-inset-bottom, 0px))",
                        }}
                      >
                        {/* Only the tabs whose tool the person may run. */}
                        <Show when={canNoteOnTickets()}>
                          <button
                            type="button"
                            data-testid="ticket-action-note"
                            class="min-h-11 flex-1 rounded-lg border border-border text-[15px] text-text"
                            onClick={() => setComposerFor("note")}
                          >
                            {i18n.t("kernel.ticketNote")}
                          </button>
                        </Show>
                        <Show when={canReplyOnTickets()}>
                          <button
                            type="button"
                            data-testid="ticket-action-reply"
                            class="min-h-11 flex-[2] rounded-lg bg-accent text-[15px] font-medium text-accent-foreground"
                            onClick={() => setComposerFor("reply")}
                          >
                            {i18n.t("kernel.ticketReply")}
                          </button>
                        </Show>
                        <button
                          type="button"
                          data-testid="ticket-action-more"
                          class="min-h-11 flex-1 rounded-lg border border-border text-[15px] text-text"
                          onClick={() => setMoreOpen(true)}
                        >
                          {i18n.t("kernel.ticketMore")}
                        </button>
                      </div>
                    </Show>
                  </Show>

                  <Show when={showClose()}>
                    <TicketCloseDialog ticketId={t().id} onClose={() => setShowClose(false)} />
                  </Show>
                  <Show when={showNudge()}>
                    <TicketNudgeDialog ticketId={t().id} onClose={() => setShowNudge(false)} />
                  </Show>
                  <Show when={showConvert()}>
                    <TicketConvertToMailDialog
                      ticketId={t().id}
                      onClose={() => setShowConvert(false)}
                    />
                  </Show>

                  <Show when={phone()}>
                    {/* The composer, full screen: the SAME component the desktop
                        renders inline, opened on the tab the bar's button names. */}
                    <OverlaySheet
                      open={composerFor() !== null}
                      onClose={() => setComposerFor(null)}
                      variant="full"
                      title={
                        composerFor() === "note"
                          ? i18n.t("kernel.ticketNote")
                          : i18n.t("kernel.ticketReply")
                      }
                      closeLabel={i18n.t("kernel.close")}
                    >
                      <Show when={composerFor()}>
                        {(mode) => (
                          <div data-testid="ticket-composer-sheet">
                            <TicketComposer
                              ticketId={t().id}
                              initialMode={mode()}
                              signatureText={getComposeSignature(t().id)}
                              defaultCc={latestInboundCc(t().id)}
                              recipientName={t().contact?.name ?? t().contact?.email}
                              onFileUploaded={() => setTicketFileRefreshKey((k) => k + 1)}
                              // Sent: back to the conversation, where it now shows.
                              onSubmitted={() => setComposerFor(null)}
                            />
                          </div>
                        )}
                      </Show>
                    </OverlaySheet>

                    <OverlaySheet
                      open={moreOpen()}
                      onClose={() => setMoreOpen(false)}
                      variant="bottom"
                      title={i18n.t("tickets.ticketActions")}
                      closeLabel={i18n.t("kernel.close")}
                    >
                      <div class="flex flex-col pb-2" data-testid="ticket-more-sheet">
                        {/* Phone: the header actions other apps add sit here, never in a pinned row. */}
                        <SlotPanels
                          slot={TICKET_DETAIL_ACTIONS_SLOT}
                          entries={actionEntries}
                          entityId={t().id}
                          position="actions"
                          class="px-4 py-2"
                        />
                        {/* The desktop's details panel is not shown at phone
                            width: what other apps add there (the customer
                            card) opens from here. */}
                        <Show when={panelEntries().length > 0}>
                          <button
                            type="button"
                            data-testid="ticket-more-customer"
                            class={phoneSheetRowClass}
                            onClick={() => {
                              setMoreOpen(false)
                              setPhoneCustomerOpen(true)
                            }}
                          >
                            {i18n.t("tickets.moreCustomer")}
                          </button>
                        </Show>
                        <button
                          type="button"
                          data-testid="ticket-more-assign"
                          class={phoneSheetRowClass}
                          onClick={() => {
                            setMoreOpen(false)
                            setPhoneAssignOpen(true)
                          }}
                        >
                          {i18n.t("kernel.ticketAssign")}
                        </button>
                        <button
                          type="button"
                          data-testid="ticket-more-category"
                          class={phoneSheetRowClass}
                          onClick={() => {
                            setMoreOpen(false)
                            setPhoneCategoryOpen(true)
                          }}
                        >
                          {i18n.t("tickets.category")}
                        </button>
                        <button
                          type="button"
                          data-testid="ticket-more-priority"
                          class={phoneSheetRowClass}
                          onClick={() => {
                            setMoreOpen(false)
                            setPhonePriorityOpen(true)
                          }}
                        >
                          {i18n.t("tickets.priority")}
                        </button>
                        {/* The one thing in this sheet that leaves the app.
                            Shown only where something can actually take the
                            link: a native share sheet, `navigator.share`, or
                            the clipboard (lib/share.ts). */}
                        <Show when={canShare()}>
                          <button
                            type="button"
                            data-testid="ticket-more-share"
                            class={phoneSheetRowClass}
                            onClick={() => {
                              setMoreOpen(false)
                              void shareTicket()
                            }}
                          >
                            {i18n.t("kernel.share")}
                          </button>
                        </Show>
                        <Show when={!closed()}>
                          <button
                            type="button"
                            data-testid="ticket-more-nudge"
                            class={phoneSheetRowClass}
                            onClick={() => {
                              setMoreOpen(false)
                              setShowNudge(true)
                            }}
                          >
                            {i18n.t("tickets.sendNudge")}
                          </button>
                          <button
                            type="button"
                            data-testid="ticket-more-convert-mail"
                            class={phoneSheetRowClass}
                            onClick={() => {
                              setMoreOpen(false)
                              setShowConvert(true)
                            }}
                          >
                            {i18n.t("tickets.convertToMail")}
                          </button>
                          <button
                            type="button"
                            data-testid="ticket-more-close"
                            class={phoneSheetRowClass}
                            onClick={() => {
                              setMoreOpen(false)
                              setShowClose(true)
                            }}
                          >
                            {i18n.t("tickets.closeTicket2")}
                          </button>
                        </Show>
                        <Show when={closed()}>
                          <button
                            type="button"
                            data-testid="ticket-more-reopen"
                            class={phoneSheetRowClass}
                            onClick={() => {
                              setMoreOpen(false)
                              void reopenTicket(api, t().id)
                            }}
                          >
                            {i18n.t("tickets.reopenTicket")}
                          </button>
                        </Show>
                      </div>
                    </OverlaySheet>

                    <OverlaySheet
                      open={phoneCustomerOpen()}
                      onClose={() => setPhoneCustomerOpen(false)}
                      variant="bottom"
                      title={i18n.t("tickets.moreCustomer")}
                      closeLabel={i18n.t("kernel.close")}
                    >
                      <div class="flex flex-col pb-2" data-testid="ticket-customer-sheet">
                        <SlotPanels
                          slot={TICKET_DETAIL_PANEL_SLOT}
                          entries={panelEntries}
                          entityId={t().id}
                          panelProps={{ ticketId: t().id }}
                        />
                      </div>
                    </OverlaySheet>

                    <TicketAssignSheet
                      ticketId={t().id}
                      open={phoneAssignOpen()}
                      onClose={() => setPhoneAssignOpen(false)}
                    />

                    <OverlaySheet
                      open={phoneCategoryOpen()}
                      onClose={() => setPhoneCategoryOpen(false)}
                      variant="bottom"
                      title={i18n.t("tickets.category")}
                      closeLabel={i18n.t("kernel.close")}
                    >
                      <div class="flex flex-col pb-2" data-testid="ticket-category-sheet">
                        <For each={activeCategories()}>
                          {(c) => (
                            <button
                              type="button"
                              data-testid={`ticket-category-sheet-${c.id}`}
                              class={phoneSheetRowClass}
                              onClick={() => {
                                setPhoneCategoryOpen(false)
                                void pickCategory(c.id, c.name)
                              }}
                            >
                              {c.name}
                            </button>
                          )}
                        </For>
                      </div>
                    </OverlaySheet>

                    <OverlaySheet
                      open={phonePriorityOpen()}
                      onClose={() => setPhonePriorityOpen(false)}
                      variant="bottom"
                      title={i18n.t("tickets.priority")}
                      closeLabel={i18n.t("kernel.close")}
                    >
                      <div class="flex flex-col pb-2" data-testid="ticket-priority-sheet">
                        <For each={PRIORITY_OPTIONS}>
                          {(opt) => (
                            <button
                              type="button"
                              data-testid={`ticket-priority-sheet-${opt.value}`}
                              class={phoneSheetRowClass}
                              onClick={() => {
                                setPhonePriorityOpen(false)
                                void setPriority(api, t().id, opt.value)
                              }}
                            >
                              {i18n.t(opt.label)}
                            </button>
                          )}
                        </For>
                      </div>
                    </OverlaySheet>
                  </Show>
                </div>
              }
              metadata={
                /* DETAILS SIDEPANEL — collapsible, stacked BELOW the conversation at
                phone width by the primitive. Keeps its own Suspense
                boundaries (moved verbatim): each child owns a createResource whose
                first read would otherwise suspend the tab-wide boundary and blank
                the freshly painted tab. At phone width the header block above
                the conversation IS the metadata, so stacking this panel under
                the pinned action bar too would print it all twice. */
                <Show when={panelOpen() && !phone()}>
                  <aside
                    class="flex min-h-0 w-full shrink-0 flex-col overflow-y-auto border-border bg-surface md:h-full md:w-80 md:border-l"
                    data-testid="tickets-detail-panel"
                    data-tour-tier="wide"
                  >
                    <header
                      class="border-b border-border bg-surface"
                      data-testid="tickets-detail-header"
                    >
                      {/* Row 1 — handle · status · priority · sensitivity · SLA · actions */}
                      <div class="flex flex-wrap items-center gap-2 px-3 pt-3 pb-2">
                        <span class="font-mono text-[11px] uppercase tracking-wider text-text-tertiary">
                          {i18n.t("tickets.tickets")} {t().handle}
                        </span>
                        <span class="h-3 w-px bg-border" />

                        <PopupMenu open={statusOpen()} onOpenChange={setStatusOpen}>
                          <PopupMenu.Trigger>
                            <button
                              type="button"
                              data-testid="tickets-detail-status"
                              data-status={t().status}
                              class={`group inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-0.5 text-xs ${tone().text} transition-colors hover:bg-surface-emphasis`}
                            >
                              <span class={`h-1.5 w-1.5 rounded-full ${tone().dot}`} />
                              <span class="font-medium">{i18n.t(tone().label)}</span>
                              <svg
                                viewBox="0 0 16 16"
                                class="h-3 w-3 fill-current text-text-tertiary group-hover:text-text-secondary"
                                aria-hidden="true"
                              >
                                <path d="M4.2 6.3a1 1 0 0 1 1.4 0L8 8.7l2.4-2.4a1 1 0 1 1 1.4 1.4l-3.1 3.1a1 1 0 0 1-1.4 0L4.2 7.7a1 1 0 0 1 0-1.4z" />
                              </svg>
                            </button>
                          </PopupMenu.Trigger>
                          <PopupMenu.Content
                            aria-label={i18n.t("tickets.changeStatus")}
                            class="w-48"
                          >
                            <For each={STATUS_OPTIONS}>
                              {(opt) => (
                                <PopupMenu.Item
                                  textValue={i18n.t(opt.label)}
                                  onSelect={() => void setStatus(api, t().id, opt.value)}
                                >
                                  <span
                                    class={`h-1.5 w-1.5 rounded-full ${STATUS_TONE[opt.value]?.dot ?? "bg-zinc-500"}`}
                                  />
                                  <span
                                    data-testid={`tickets-status-option-${opt.value}`}
                                    class={t().status === opt.value ? "text-text" : ""}
                                  >
                                    {i18n.t(opt.label)}
                                  </span>
                                  <Show when={t().status === opt.value}>
                                    <span class="ml-auto text-[11px] text-text-tertiary">
                                      {i18n.t("tickets.current")}
                                    </span>
                                  </Show>
                                </PopupMenu.Item>
                              )}
                            </For>
                            {/* Close lives here too — closing is a state change, so the
                          state dropdown is where users look for it. It opens the
                          close-with-reason dialog rather than a raw status set, so
                          the reason/silent-close flow is preserved. */}
                            <Show when={!closed()}>
                              <PopupMenu.Separator />
                              <PopupMenu.Item
                                textValue="Close ticket"
                                onSelect={() => setShowClose(true)}
                              >
                                <span class="h-1.5 w-1.5 rounded-full bg-zinc-500" />
                                <span data-testid="tickets-status-close">
                                  {i18n.t("tickets.closeTicket2")}
                                </span>
                              </PopupMenu.Item>
                            </Show>
                          </PopupMenu.Content>
                        </PopupMenu>

                        <PopupMenu open={priorityOpen()} onOpenChange={setPriorityOpen}>
                          <PopupMenu.Trigger>
                            <button
                              type="button"
                              data-testid="tickets-detail-priority"
                              data-priority={t().priority}
                              class={`inline-flex items-center gap-1 text-xs ${pri().text} hover:opacity-80`}
                            >
                              <span class="font-mono">{pri().glyph}</span>
                              <span class="capitalize">{t().priority}</span>
                            </button>
                          </PopupMenu.Trigger>
                          <PopupMenu.Content
                            aria-label={i18n.t("tickets.changePriority")}
                            class="w-40"
                          >
                            <For each={PRIORITY_OPTIONS}>
                              {(opt) => (
                                <PopupMenu.Item
                                  textValue={i18n.t(opt.label)}
                                  onSelect={() => void setPriority(api, t().id, opt.value)}
                                >
                                  <span class={`font-mono ${PRIORITY_TONE[opt.value]?.text ?? ""}`}>
                                    {PRIORITY_TONE[opt.value]?.glyph ?? "·"}
                                  </span>
                                  <span
                                    data-testid={`tickets-priority-option-${opt.value}`}
                                    class={t().priority === opt.value ? "text-text" : ""}
                                  >
                                    {i18n.t(opt.label)}
                                  </span>
                                  <Show when={t().priority === opt.value}>
                                    <span class="ml-auto text-[11px] text-text-tertiary">
                                      {i18n.t("tickets.current")}
                                    </span>
                                  </Show>
                                </PopupMenu.Item>
                              )}
                            </For>
                          </PopupMenu.Content>
                        </PopupMenu>

                        <Show when={t().sensitivity && t().sensitivity !== "internal"}>
                          <span
                            class="inline-flex items-center gap-1 text-xs text-text-tertiary"
                            title={`Sensitivity: ${t().sensitivity}`}
                          >
                            <svg viewBox="0 0 16 16" class="h-3 w-3 fill-current">
                              <path d="M4 7V5a4 4 0 1 1 8 0v2h1v8H3V7h1zm2 0h4V5a2 2 0 0 0-4 0v2z" />
                            </svg>
                            <span class="capitalize">{t().sensitivity}</span>
                          </span>
                        </Show>

                        <Show when={sla()}>
                          {(s) => (
                            <span
                              data-testid="tickets-detail-sla"
                              data-sla-tone={s()}
                              class={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
                                s() === "breached"
                                  ? "bg-red-950/60 text-red-300 ring-1 ring-red-900/60"
                                  : s() === "approaching"
                                    ? "bg-amber-950/60 text-amber-300 ring-1 ring-amber-900/60"
                                    : "bg-zinc-800/60 text-zinc-400 ring-1 ring-zinc-700/40"
                              }`}
                            >
                              <svg viewBox="0 0 12 12" class="h-2.5 w-2.5 fill-current">
                                <path d="M6 0a6 6 0 1 1 0 12A6 6 0 0 1 6 0zm0 2.5a.6.6 0 0 0-.6.6V6c0 .15.06.3.17.42l1.85 1.85a.6.6 0 0 0 .85-.85L6.6 5.75V3.1a.6.6 0 0 0-.6-.6z" />
                              </svg>
                              {s() === "breached"
                                ? i18n.t("kernel.ticketsSlaBreached")
                                : i18n.t("kernel.ticketsSlaDue", {
                                    when: relativeTime(t().slaDeadline, i18n.locale()),
                                  })}
                            </span>
                          )}
                        </Show>

                        <Show when={t().team}>
                          {(team) => (
                            <span
                              data-testid="tickets-detail-team"
                              class="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-text-secondary"
                            >
                              <span class="text-text-tertiary">{i18n.t("tickets.team")}</span>
                              <span class="font-medium">{team()}</span>
                            </span>
                          )}
                        </Show>

                        <div class="ml-auto flex items-center gap-1">
                          {/* Actions other apps add to the ticket's header. */}
                          <SlotPanels
                            slot={TICKET_DETAIL_ACTIONS_SLOT}
                            entries={actionEntries}
                            entityId={t().id}
                            position="actions"
                          />
                          <PopupMenu open={kebabOpen()} onOpenChange={setKebabOpen}>
                            <PopupMenu.Trigger>
                              <button
                                type="button"
                                class="rounded p-1.5 text-text-secondary hover:bg-surface-sunken hover:text-text"
                                title={i18n.t("tickets.moreActions")}
                                data-testid="tickets-detail-kebab"
                              >
                                <svg viewBox="0 0 16 16" class="h-4 w-4 fill-current">
                                  <circle cx="3" cy="8" r="1.4" />
                                  <circle cx="8" cy="8" r="1.4" />
                                  <circle cx="13" cy="8" r="1.4" />
                                </svg>
                              </button>
                            </PopupMenu.Trigger>
                            <PopupMenu.Content
                              aria-label={i18n.t("tickets.ticketActions")}
                              class="w-52"
                            >
                              <Show when={!closed()}>
                                <PopupMenu.Item
                                  textValue={i18n.t("tickets.sendNudge")}
                                  onSelect={() => setShowNudge(true)}
                                >
                                  <svg
                                    viewBox="0 0 16 16"
                                    class="h-4 w-4 fill-current text-text-tertiary"
                                    aria-hidden="true"
                                  >
                                    <path d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6.5L4 14v-2H4a2 2 0 0 1-2-2V4z" />
                                  </svg>
                                  <span data-testid="tickets-detail-nudge-button">
                                    {i18n.t("tickets.sendNudge")}
                                  </span>
                                </PopupMenu.Item>
                                <PopupMenu.Item
                                  textValue={i18n.t("tickets.convertToMail")}
                                  onSelect={() => setShowConvert(true)}
                                >
                                  <svg
                                    viewBox="0 0 16 16"
                                    class="h-4 w-4 fill-current text-text-tertiary"
                                    aria-hidden="true"
                                  >
                                    <path d="M2 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1zm1.4.5L8 8.3l4.6-3.8H3.4z" />
                                  </svg>
                                  <span data-testid="tickets-detail-convert-mail-button">
                                    {i18n.t("tickets.convertToMail")}
                                  </span>
                                </PopupMenu.Item>
                                <PopupMenu.Separator />
                                <PopupMenu.Item
                                  textValue="Close ticket"
                                  onSelect={() => setShowClose(true)}
                                >
                                  <svg
                                    viewBox="0 0 16 16"
                                    class="h-4 w-4 fill-current text-text-tertiary"
                                    aria-hidden="true"
                                  >
                                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zM5.7 5.7a1 1 0 0 1 1.4 0L8 6.6l.9-.9a1 1 0 1 1 1.4 1.4L9.4 8l.9.9a1 1 0 1 1-1.4 1.4L8 9.4l-.9.9a1 1 0 0 1-1.4-1.4L6.6 8l-.9-.9a1 1 0 0 1 0-1.4z" />
                                  </svg>
                                  <span data-testid="tickets-detail-close-button">
                                    {i18n.t("tickets.closeTicket2")}
                                  </span>
                                </PopupMenu.Item>
                              </Show>
                              <Show when={closed()}>
                                <PopupMenu.Item
                                  textValue="Reopen ticket"
                                  onSelect={() => void reopenTicket(api, t().id)}
                                >
                                  {i18n.t("tickets.reopenTicket")}
                                </PopupMenu.Item>
                              </Show>
                            </PopupMenu.Content>
                          </PopupMenu>
                        </div>
                      </div>

                      {/* Row 2 — read-by stack. The subject itself lives in the
                      conversation column now: rendering it here too showed the
                      same title twice, side by side. */}
                      <div class="flex flex-wrap items-start gap-2 px-3 pb-2">
                        <Show
                          when={(t().readByCount ?? 0) > 0}
                          fallback={
                            <span
                              class="shrink-0 rounded-full bg-surface-sunken px-2.5 py-0.5 text-[11px] text-text-tertiary"
                              data-testid="tickets-readby-empty"
                            >
                              {i18n.t("tickets.notYetReadByAnotherAgent")}
                            </span>
                          }
                        >
                          <PopupMenu open={readByOpen()} onOpenChange={setReadByOpen}>
                            <PopupMenu.Trigger>
                              <button
                                type="button"
                                class="group inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-sunken py-0.5 pl-1 pr-2.5 text-[11px] text-text-secondary hover:bg-surface-emphasis"
                                title={i18n.t("tickets.readByCount", { n: t().readByCount ?? 0 })}
                              >
                                <span class="flex -space-x-1">
                                  <For each={readers().slice(0, 3)}>
                                    {(r) => (
                                      <span
                                        class="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-semibold ring-1 ring-surface"
                                        style={discStyle(r.userId)}
                                      >
                                        {avatarInitials(r.name, r.userId.slice(0, 2))}
                                      </span>
                                    )}
                                  </For>
                                </span>
                                {i18n.t("tickets.readBy")} {t().readByCount}
                              </button>
                            </PopupMenu.Trigger>
                            <PopupMenu.Content aria-label={i18n.t("tickets.readBy")} class="w-56">
                              <div class="px-3 py-2 text-[10px] uppercase tracking-wider text-text-tertiary">
                                {i18n.t("tickets.recentlyRead")}
                              </div>
                              <ul class="flex flex-col px-1 pb-1" data-testid="tickets-readby-list">
                                <For each={readers()}>
                                  {(r) => (
                                    <li
                                      class="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-text-secondary"
                                      data-testid={`tickets-readby-item-${r.userId}`}
                                    >
                                      <span
                                        class="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold"
                                        style={discStyle(r.userId)}
                                      >
                                        {avatarInitials(r.name, r.userId.slice(0, 2))}
                                      </span>
                                      <span class="truncate">{r.name ?? r.userId}</span>
                                    </li>
                                  )}
                                </For>
                                <Show when={(t().readByCount ?? 0) > readers().length}>
                                  <li class="px-2 py-1 text-[11px] text-text-tertiary">
                                    +{(t().readByCount ?? 0) - readers().length}{" "}
                                    {i18n.t("tickets.more")}
                                  </li>
                                </Show>
                              </ul>
                            </PopupMenu.Content>
                          </PopupMenu>
                        </Show>
                      </div>

                      {/* Row 3 — chips: contact, assignee, follow-up */}
                      <div class="flex flex-wrap items-center gap-2 px-3 pb-3 text-xs text-text-secondary">
                        <Show when={t().contactId}>
                          {(_) => {
                            // Show the real sender — name, else email, else the generic
                            // "Contact" label. The avatar initials derive from the same so
                            // there is no stray UUID-prefix "number" in the chip.
                            const contactLabel = () =>
                              t().contact?.name ?? t().contact?.email ?? i18n.t("tickets.contact")
                            return (
                              <button
                                type="button"
                                class="group inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2 py-1 hover:bg-surface-emphasis"
                                data-testid="tickets-detail-contact-chip"
                                title={t().contact?.email ?? undefined}
                                onClick={() =>
                                  openTab({
                                    type: "contacts:contact-detail",
                                    entityId: t().contactId!,
                                    label: contactLabel(),
                                  })
                                }
                              >
                                <span
                                  class="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-semibold"
                                  style={discStyle(t().contactId!)}
                                >
                                  {avatarInitials(
                                    t().contact?.name,
                                    (t().contact?.email ?? t().contactId!).slice(0, 2),
                                  )}
                                </span>
                                <span class="text-text">{contactLabel()}</span>
                              </button>
                            )
                          }}
                        </Show>

                        <PopupMenu open={assignOpen()} onOpenChange={onAssignOpenChange}>
                          <PopupMenu.Trigger>
                            <button
                              type="button"
                              data-testid={
                                t().assignedTo
                                  ? "tickets-detail-assignee-chip"
                                  : "tickets-detail-assign-empty"
                              }
                              class={
                                t().assignedTo
                                  ? "inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2 py-1 hover:bg-surface-emphasis"
                                  : "inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-1 text-text-tertiary hover:text-text-secondary"
                              }
                            >
                              <Show
                                when={t().assignedTo}
                                fallback={
                                  <>
                                    <span class="text-[14px] leading-none">+</span>{" "}
                                    {i18n.t("kernel.common.assign")}
                                  </>
                                }
                              >
                                {(uid) => (
                                  <>
                                    <span
                                      class="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-semibold"
                                      style={discStyle(uid())}
                                    >
                                      {avatarInitials(t().assigneeName, uid().slice(0, 2))}
                                    </span>
                                    <span class="text-text">
                                      {t().assigneeName ?? i18n.t("tickets.assigned")}
                                    </span>
                                  </>
                                )}
                              </Show>
                            </button>
                          </PopupMenu.Trigger>
                          <PopupMenu.Content aria-label={i18n.t("tickets.assignee")} class="w-64">
                            <div class="px-1 pb-1">
                              <AssigneeSearchField
                                testIdPrefix="tickets-assignee"
                                value={assignees.query()}
                                onInput={assignees.setQuery}
                              />
                            </div>
                            <PopupMenu.Item
                              textValue="Assign to me"
                              onSelect={() => {
                                const me = userFromToken()
                                void assignTicket(api, t().id, me?.userId ?? "me", me?.name ?? null)
                              }}
                            >
                              <span data-testid="tickets-detail-assign-me">
                                {i18n.t("tickets.assignToMe")}
                              </span>
                            </PopupMenu.Item>
                            <div class="max-h-72 overflow-y-auto">
                              <For each={ambiguousAssignNames()}>
                                {({ candidate: m, ambiguous }) => (
                                  <PopupMenu.Item
                                    textValue={m.name}
                                    onSelect={() => void assignTicket(api, t().id, m.id, m.name)}
                                  >
                                    <span
                                      class="inline-flex items-center gap-1.5"
                                      data-testid="tickets-detail-assign-member"
                                    >
                                      <span
                                        class="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-semibold"
                                        style={discStyle(m.id)}
                                      >
                                        {avatarInitials(m.name, m.id.slice(0, 2))}
                                      </span>
                                      {disambiguatedLabel(m.name, m.email, ambiguous)}
                                      <Show when={awayLabel(m.away, i18n.t, i18n.locale())}>
                                        {(away) => (
                                          <span
                                            data-testid={`tickets-detail-assign-away-${m.id}`}
                                            class="text-[11px] text-text-tertiary"
                                          >
                                            {away()}
                                          </span>
                                        )}
                                      </Show>
                                    </span>
                                  </PopupMenu.Item>
                                )}
                              </For>
                            </div>
                            <AssigneeListStatus
                              testIdPrefix="tickets-assignee"
                              status={assignees.status()}
                              shown={assignees.members().length}
                              total={assignees.total()}
                              onRetry={assignees.retry}
                            />
                            <Show when={t().assignedTo}>
                              <PopupMenu.Item
                                textValue="Unassign"
                                onSelect={() => void assignTicket(api, t().id, null)}
                              >
                                <span data-testid="tickets-detail-unassign">
                                  {i18n.t("kernel.common.unassign")}
                                </span>
                              </PopupMenu.Item>
                            </Show>
                          </PopupMenu.Content>
                        </PopupMenu>

                        <PopupMenu open={followupOpen()} onOpenChange={setFollowupOpen}>
                          <PopupMenu.Trigger>
                            <button
                              type="button"
                              data-testid={
                                t().followupAt
                                  ? "tickets-detail-followup-chip"
                                  : "tickets-detail-followup-empty"
                              }
                              class={
                                t().followupAt
                                  ? "inline-flex items-center gap-1 rounded-full bg-violet-950/60 px-2 py-1 text-violet-300 ring-1 ring-violet-900/40 hover:bg-violet-900/60"
                                  : "inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-1 text-text-tertiary hover:text-text-secondary"
                              }
                            >
                              <Show
                                when={t().followupAt}
                                fallback={
                                  <>
                                    <span class="text-[14px] leading-none">+</span>{" "}
                                    {i18n.t("tickets.followUp")}
                                  </>
                                }
                              >
                                {(at) => (
                                  <>
                                    <svg viewBox="0 0 16 16" class="h-3 w-3 fill-current">
                                      <path d="M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM7 5a1 1 0 1 1 2 0v3.5l2 1.5a1 1 0 1 1-1.2 1.6l-2.4-1.8A1 1 0 0 1 7 9V5z" />
                                    </svg>
                                    {i18n.t("tickets.followUpWhen", {
                                      when: relativeTime(at(), i18n.locale()),
                                    })}
                                  </>
                                )}
                              </Show>
                            </button>
                          </PopupMenu.Trigger>
                          <PopupMenu.Content
                            aria-label={i18n.t("tickets.scheduleFollowUp")}
                            class="w-44"
                          >
                            <For each={FOLLOWUP_PRESETS}>
                              {(preset) => (
                                <PopupMenu.Item
                                  textValue={i18n.t(preset.label)}
                                  onSelect={() =>
                                    void setTicketFollowup(
                                      api,
                                      t().id,
                                      followupPresetIso(preset.days),
                                    )
                                  }
                                >
                                  {i18n.t(preset.label)}
                                </PopupMenu.Item>
                              )}
                            </For>
                            <Show when={t().followupAt}>
                              <PopupMenu.Separator />
                              <PopupMenu.Item
                                textValue="Clear follow-up"
                                onSelect={() => void clearTicketFollowup(api, t().id)}
                              >
                                <span data-testid="tickets-detail-followup-clear">
                                  {i18n.t("tickets.clearFollowUp")}
                                </span>
                              </PopupMenu.Item>
                            </Show>
                          </PopupMenu.Content>
                        </PopupMenu>

                        <PopupMenu open={categoryOpen()} onOpenChange={setCategoryOpen}>
                          <PopupMenu.Trigger>
                            <button
                              type="button"
                              data-testid={
                                t().categoryId
                                  ? "tickets-detail-category-chip"
                                  : "tickets-detail-category-empty"
                              }
                              class={
                                t().categoryId
                                  ? "inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2 py-1 hover:bg-surface-emphasis"
                                  : "inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-1 text-text-tertiary hover:text-text-secondary"
                              }
                            >
                              <Show
                                when={t().categoryId}
                                fallback={
                                  <>
                                    <span class="text-[14px] leading-none">+</span>{" "}
                                    {i18n.t("tickets.category")}
                                  </>
                                }
                              >
                                <span class="text-text">
                                  {(() => {
                                    const cat = activeCategories().find(
                                      (c) => c.id === t().categoryId,
                                    )
                                    const parent = cat?.parentId
                                      ? activeCategories().find((c) => c.id === cat.parentId)
                                      : null
                                    const label = cat?.name ?? t().categoryName ?? ""
                                    return parent ? `${parent.name} / ${label}` : label
                                  })()}
                                </span>
                              </Show>
                            </button>
                          </PopupMenu.Trigger>
                          <PopupMenu.Content
                            aria-label={i18n.t("tickets.changeCategory")}
                            class="w-56"
                          >
                            <PopupMenu.Item
                              textValue={i18n.t("tickets.noCategory")}
                              onSelect={() => void pickCategory(null, null)}
                            >
                              <span
                                data-testid="tickets-category-option-none"
                                class={!t().categoryId ? "text-text" : ""}
                              >
                                {i18n.t("tickets.noCategory")}
                              </span>
                              <Show when={!t().categoryId}>
                                <span class="ml-auto text-[11px] text-text-tertiary">
                                  {i18n.t("tickets.current")}
                                </span>
                              </Show>
                            </PopupMenu.Item>
                            <For each={categoryRoots()}>
                              {(root) => (
                                <>
                                  <PopupMenu.Separator />
                                  <PopupMenu.Item
                                    textValue={root.name}
                                    onSelect={() => void pickCategory(root.id, root.name)}
                                  >
                                    <span
                                      data-testid={`tickets-category-option-${root.id}`}
                                      class={t().categoryId === root.id ? "text-text" : ""}
                                    >
                                      {root.name}
                                    </span>
                                    <Show when={t().categoryId === root.id}>
                                      <span class="ml-auto text-[11px] text-text-tertiary">
                                        {i18n.t("tickets.current")}
                                      </span>
                                    </Show>
                                  </PopupMenu.Item>
                                  <For each={categoryChildrenByParent().get(root.id) ?? []}>
                                    {(child) => (
                                      <PopupMenu.Item
                                        textValue={child.name}
                                        onSelect={() => void pickCategory(child.id, child.name)}
                                      >
                                        <span
                                          data-testid={`tickets-category-option-${child.id}`}
                                          class={`pl-3 ${t().categoryId === child.id ? "text-text" : ""}`}
                                        >
                                          {child.name}
                                        </span>
                                        <Show when={t().categoryId === child.id}>
                                          <span class="ml-auto text-[11px] text-text-tertiary">
                                            {i18n.t("tickets.current")}
                                          </span>
                                        </Show>
                                      </PopupMenu.Item>
                                    )}
                                  </For>
                                </>
                              )}
                            </For>
                          </PopupMenu.Content>
                        </PopupMenu>
                        <Show when={categoryError()}>
                          <span
                            class="text-[11px] text-red-400"
                            data-testid="tickets-detail-category-error"
                          >
                            {categoryError()}
                          </span>
                        </Show>
                      </div>
                    </header>
                    <TicketSummaryCard ticketId={t().id} />
                    {/* Panels other apps add to the sidepanel (an API connector's
                    customer card): each gets the ticket id and owns its data. */}
                    <SlotPanels
                      slot={TICKET_DETAIL_PANEL_SLOT}
                      entries={panelEntries}
                      entityId={t().id}
                      panelProps={{ ticketId: t().id }}
                    />
                    {/* LOCAL Suspense boundaries: these children mount AFTER the
                  ticket header has already painted (they sit behind the
                  `when={ticket()}` gate) and each owns a createResource whose
                  FIRST read would otherwise suspend MainPanel's tab-wide
                  boundary — blanking the freshly-rendered tab behind the
                  loading bar until the slowest fetch settles. Catch those
                  reads here so each region loads in place instead. */}
                    <Suspense>
                      <BacklinksPanel app="tickets" entityType="ticket" entityId={t().id} />
                    </Suspense>
                    <div class="flex flex-col gap-2 border-t border-border-subtle px-4 py-2">
                      <Suspense>
                        <FileList
                          parent={{ app: "tickets", entityType: "ticket", entityId: t().id }}
                          refreshKey={() => ticketFileRefreshKey()}
                        />
                      </Suspense>
                      {/* Ticket-level files (reference material pinned to the ticket).
                    Files meant to ride an outgoing reply/note go through the
                    composer's own attach control below. */}
                      <div>
                        <FileUploadButton
                          parent={{ app: "tickets", entityType: "ticket", entityId: t().id }}
                          onUploaded={() => setTicketFileRefreshKey((k) => k + 1)}
                        />
                      </div>
                    </div>
                  </aside>
                </Show>
              }
            />
          </div>
        )
      }}
    </Show>
  )
}
