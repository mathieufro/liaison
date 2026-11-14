// SPDX-License-Identifier: FSL-1.1-ALv2
// Ticket detail store — per-ticket header / right-rail state. Drives
// `TicketDetail` header (status, priority, category, assignee), read-by-N
// avatars, and summary collapse linkage.
import { createStore, produce } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import type { ApiClient } from "~/lib/api-client"
import { log } from "~/lib/logger"
import { runTool } from "~/lib/run-tool"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { userFromToken } from "~/modules/auth/auth-store"
import { loadMessages } from "./ticket-message-store"
import { handleTicketSummaryEvent } from "./ticket-summary-store"
import type { Ticket } from "./ticket-types"

interface DetailState {
  byId: Record<string, Ticket>
  loadingById: Record<string, boolean>
  // Terminal load outcome when the ticket could NOT be loaded: "not_found" when
  // tickets:get resolved with no ticket (deleted, or RLS-hidden from this
  // viewer), "error" when the call itself failed. Without this the detail tab
  // showed "Loading ticket…" forever on any failure.
  loadFailedById: Record<string, "not_found" | "error">
  // Per-ticket effective reply signature (inbox first, else the viewer's own),
  // served by tickets:get as `composeSignatureText`. Prefilled into the reply
  // composer so what the agent sees is exactly what will be sent — the send
  // path appends nothing.
  composeSignatureById: Record<string, string | null>
  // Tickets whose cached detail may be out of date after a WS resync bump.
  // Only the ACTIVE ticket tab reloads immediately on resync; background
  // keep-alive tabs are flagged here and reload lazily when activated —
  // otherwise every reconnect blip cost 2 x (open ticket tabs) tickets:get
  // calls (the prod 57-calls-in-40-min over-fetch).
  staleById: Record<string, boolean>
}

const [ticketDetailStore, setTicketDetailStore] = createStore<DetailState>({
  byId: {},
  loadingById: {},
  loadFailedById: {},
  composeSignatureById: {},
  staleById: {},
})

export { ticketDetailStore }

export function getTicket(id: string): Ticket | undefined {
  return ticketDetailStore.byId[id]
}

export function getComposeSignature(id: string): string | null {
  return ticketDetailStore.composeSignatureById[id] ?? null
}

// Merge a fresh server payload into the existing store object (when present)
// instead of swapping in a new one. Keeping the object identity stable means
// downstream computations keyed on `byId[id]` — memos, JSX getters, resource
// sources (FileList, BacklinksPanel) — only re-run for fields that actually
// changed. Replacing the object re-ran all of them on every markRead/WS echo,
// refetching panel resources and re-triggering the tab-level Suspense: the
// visible "ticket keeps reloading" blink.
// The row's `id` is always the key it is stored under: every consumer reads
// `ticket().id` (the file shelf's parent, panels, actions), so a payload that
// names the ticket some other way must never leave a row without one.
function upsertTicket(s: DetailState, ticketId: string, next: Ticket): void {
  const prev = s.byId[ticketId]
  if (prev) Object.assign(prev, next, { id: ticketId })
  else s.byId[ticketId] = { ...next, id: ticketId }
}

// A live summary event is newer than any read that was already in flight when
// it arrived: a tickets:get or ensureSummary answer read before the summary
// changed must not put the old summary back. Each live summary event bumps the
// ticket's summary version; a read remembers the version it started at and,
// when it has moved since, leaves the summary fields as the event set them.
const summaryVersions = new Map<string, number>()
const SUMMARY_FIELDS = [
  "summaryText",
  "summaryAt",
  "summaryMessageCount",
  "summaryStatus",
  "summaryModel",
  "summaryError",
] as const

/** The ticket's summary version: read it before a request, compare after. */
export function ticketSummaryVersion(ticketId: string): number {
  return summaryVersions.get(ticketId) ?? 0
}

function bumpSummaryVersion(ticketId: string): void {
  summaryVersions.set(ticketId, ticketSummaryVersion(ticketId) + 1)
}

/** The payload without its summary fields when a live summary event landed since `version`. */
function withoutStaleSummary(ticketId: string, next: Ticket, version: number): Ticket {
  if (ticketSummaryVersion(ticketId) === version) return next
  const fresh = { ...next } as Partial<Ticket>
  for (const field of SUMMARY_FIELDS) delete fresh[field]
  return fresh as Ticket
}

// Last API client seen — captured so the module-level resync subscription can
// refetch loaded tickets without a component context.
let _ticketApi: ApiClient | null = null

// Per-ticket generation counter. Bumped whenever evictTicketDetail() runs for
// that ticket. loadTicket() captures the generation at call time and drops
// its write-back if the counter moved before the request resolved — otherwise
// an in-flight load that resolves AFTER eviction silently re-creates the
// ticket entry, undoing the eviction (mirrors the requestId guard in
// MailMessageRenderer's blob-url fix).
const _ticketEpoch: Record<string, number> = {}

function currentTicketEpoch(ticketId: string): number {
  return _ticketEpoch[ticketId] ?? 0
}

/**
 * `restart`: a resync after a network blip, or a stale tab activated (S26).
 * The conversation reload starts now, in parallel, and replaces a load the
 * blip may have left hanging (ticket-message-store `restart`).
 */
export async function loadTicket(
  api: ApiClient,
  ticketId: string,
  opts: { restart?: boolean } = {},
): Promise<void> {
  _ticketApi = api
  const epoch = currentTicketEpoch(ticketId)
  if (opts.restart) void loadMessages(api, ticketId, { restart: true })
  // Instant header paint: when the ticket was opened from the inbox list, its
  // row is already in the list store — seed the detail cache from it so the
  // header renders immediately while the full tickets:get revalidates in
  // place (upsertTicket merges, so no blink when the fresh payload lands).
  // Lazy import mirrors handleTicketEvent's list-store import (avoids a
  // static import cycle between the detail and list stores).
  if (!ticketDetailStore.byId[ticketId]) {
    void import("~/modules/tickets/ticket-list-store").then(({ getTicketFromList }) => {
      const cached = getTicketFromList(ticketId)
      if (!cached) return
      if (ticketDetailStore.byId[ticketId] || currentTicketEpoch(ticketId) !== epoch) return
      setTicketDetailStore(
        produce((s) => {
          upsertTicket(s, ticketId, { ...cached })
        }),
      )
    })
  }
  setTicketDetailStore(
    produce((s) => {
      s.loadingById[ticketId] = true
      delete s.loadFailedById[ticketId]
      delete s.staleById[ticketId]
    }),
  )
  try {
    const version = ticketSummaryVersion(ticketId)
    const out = await runTool<{ ticket: Ticket | null; composeSignatureText?: string | null }>(
      api,
      "tickets:get",
      { ticketId },
    )
    if (currentTicketEpoch(ticketId) !== epoch) return // evicted mid-flight — drop the write-back
    if (out.ticket) {
      setTicketDetailStore(
        produce((s) => {
          upsertTicket(s, ticketId, withoutStaleSummary(ticketId, out.ticket as Ticket, version))
          s.composeSignatureById[ticketId] = out.composeSignatureText ?? null
        }),
      )
      void loadMessages(api, ticketId)
    } else if (!ticketDetailStore.byId[ticketId]) {
      // No row came back and we have nothing cached: deleted, or hidden from
      // this viewer by RLS. Surface it — never leave the tab on the spinner.
      setTicketDetailStore("loadFailedById", ticketId, "not_found")
    }
  } catch (err) {
    if (currentTicketEpoch(ticketId) === epoch && !ticketDetailStore.byId[ticketId]) {
      setTicketDetailStore("loadFailedById", ticketId, "error")
    }
    console.error("loadTicket failed", ticketId, err)
  } finally {
    if (currentTicketEpoch(ticketId) === epoch) {
      setTicketDetailStore("loadingById", ticketId, false)
    }
  }
}

// --- Resync subscription ---
// On a resync bump, refetch every loaded ticket in place (upsertTicket merges,
// so the open ticket never blinks). Idempotent.
let _ticketResyncSubscribed = false

export function subscribeTicketDetailResync(): void {
  if (_ticketResyncSubscribed) return
  _ticketResyncSubscribed = true
  subscribeResync(() => {
    const api = _ticketApi
    if (!api) return
    // Refetch ONLY the active ticket tab; flag every other loaded ticket as
    // stale so it reloads lazily when its tab is next activated. A reconnect
    // blip with N keep-alive ticket tabs used to fire 2 x N tickets:get calls
    // (loadTicket + chained loadMessages per ticket).
    void import("~/modules/shell/tab-store").then(({ tabStore, makeTabId }) => {
      for (const ticketId of Object.keys(ticketDetailStore.byId)) {
        if (tabStore.activeTabId === makeTabId("tickets:ticket", ticketId)) {
          void loadTicket(api, ticketId, { restart: true })
        } else {
          setTicketDetailStore("staleById", ticketId, true)
        }
      }
    })
  })
}

/** True when a resync flagged this ticket's cached detail as possibly stale. */
export function isTicketDetailStale(ticketId: string): boolean {
  return ticketDetailStore.staleById[ticketId] === true
}

/**
 * Drop a ticket's per-entity detail payload — called when the last open tab
 * for that ticket closes (tab-store's onTabClosed wiring). The inbox/list
 * store is a separate record and is never touched here.
 */
export function evictTicketDetail(ticketId: string): void {
  _ticketEpoch[ticketId] = currentTicketEpoch(ticketId) + 1
  setTicketDetailStore(
    produce((s) => {
      delete s.byId[ticketId]
      delete s.loadingById[ticketId]
      delete s.loadFailedById[ticketId]
      delete s.composeSignatureById[ticketId]
      delete s.staleById[ticketId]
    }),
  )
}

export async function markRead(api: ApiClient, ticketId: string): Promise<void> {
  try {
    // A background call the viewer never asked for (mount, focus,
    // visibilitychange): a failure must not raise the global error toast.
    await runTool(api, "tickets:markRead", { ticketId }, { suppressGlobalError: true })
    // Patch read state locally instead of re-fetching the whole ticket:
    // markRead only changes THIS viewer's read row (unread flag + their entry
    // in the read-by stack), all derivable client-side. The old follow-up
    // tickets:get made every mark-read (mount, focus, visibilitychange,
    // inbound message) cost a full 5-10s sandbox tool call in prod.
    const me = userFromToken()
    setTicketDetailStore(
      produce((s) => {
        const t = s.byId[ticketId]
        if (!t) return
        t.unread = false
        if (me?.userId) {
          const readers = t.readByRecent ?? []
          if (!readers.some((r) => r.userId === me.userId)) {
            t.readByRecent = [
              { userId: me.userId, name: me.name ?? null, readAt: new Date().toISOString() },
              ...readers,
            ]
            t.readByCount = (t.readByCount ?? 0) + 1
          }
        }
      }),
    )
  } catch (err) {
    log.warn({ err, ticketId }, "marking the ticket read failed")
  }
}

export async function setStatus(api: ApiClient, ticketId: string, status: string): Promise<void> {
  await runTool(api, "tickets:setStatus", { ticketId, status })
  setTicketDetailStore(
    produce((s) => {
      const t = s.byId[ticketId]
      if (t) t.status = status
    }),
  )
}

export async function reopenTicket(api: ApiClient, ticketId: string): Promise<void> {
  await runTool(api, "tickets:reopen", { ticketId })
  setTicketDetailStore(
    produce((s) => {
      const t = s.byId[ticketId]
      if (t) {
        t.status = "open"
        t.closedReason = null
      }
    }),
  )
}

export async function setPriority(
  api: ApiClient,
  ticketId: string,
  priority: string,
): Promise<void> {
  await runTool(api, "tickets:setPriority", { ticketId, priority })
  setTicketDetailStore(
    produce((s) => {
      const t = s.byId[ticketId]
      if (t) t.priority = priority
    }),
  )
}

/**
 * Set (or clear, with `categoryId: null`) the ticket's category. Applied
 * optimistically — the header chip flips immediately — and rolled back to
 * the prior categoryId/categoryName if the tool call fails, mirroring the
 * message-store edit/delete rollback idiom (thread-view-optimistic.ts).
 */
export async function setCategory(
  api: ApiClient,
  ticketId: string,
  categoryId: string | null,
  categoryName: string | null,
): Promise<void> {
  const prev = ticketDetailStore.byId[ticketId]
  const prevCategoryId = prev?.categoryId ?? null
  const prevCategoryName = prev?.categoryName ?? null
  setTicketDetailStore(
    produce((s) => {
      const t = s.byId[ticketId]
      if (t) {
        t.categoryId = categoryId
        t.categoryName = categoryName
      }
    }),
  )
  try {
    await runTool(api, "tickets:setCategory", { ticketId, categoryId })
  } catch (err) {
    setTicketDetailStore(
      produce((s) => {
        const t = s.byId[ticketId]
        if (t) {
          t.categoryId = prevCategoryId
          t.categoryName = prevCategoryName
        }
      }),
    )
    throw err
  }
}

// Re-pull just the ticket header (no message reload) after a mutating action so
// derived fields the server computes — assigneeName, followupAt, contact — land
// in the store without a full loadTicket().
async function refreshTicketHeader(api: ApiClient, ticketId: string): Promise<void> {
  const version = ticketSummaryVersion(ticketId)
  const out = await runTool<{ ticket: Ticket | null }>(api, "tickets:get", {
    ticketId,
    messagesLimit: 1,
  })
  if (out.ticket) {
    setTicketDetailStore(
      produce((s) => {
        upsertTicket(s, ticketId, withoutStaleSummary(ticketId, out.ticket as Ticket, version))
      }),
    )
  }
}

export async function assignTicket(
  api: ApiClient,
  ticketId: string,
  assignedTo: string | null,
  // Display name of the chosen assignee when the caller knows it (member
  // picker). Applied optimistically so the chip never falls back to the raw
  // UUID prefix while the server-joined assigneeName is in flight.
  assigneeName?: string | null,
): Promise<void> {
  const prev = ticketDetailStore.byId[ticketId]
  const prevAssignedTo = prev?.assignedTo ?? null
  const prevAssigneeName = prev?.assigneeName ?? null
  if (assignedTo !== "me") {
    setTicketDetailStore(
      produce((s) => {
        const t = s.byId[ticketId]
        if (t) {
          t.assignedTo = assignedTo
          t.assigneeName = assignedTo ? (assigneeName ?? null) : null
        }
      }),
    )
  }
  try {
    await runTool(api, "tickets:assign", { ticketId, assignedTo })
  } catch (err) {
    setTicketDetailStore(
      produce((s) => {
        const t = s.byId[ticketId]
        if (t) {
          t.assignedTo = prevAssignedTo
          t.assigneeName = prevAssigneeName
        }
      }),
    )
    throw err
  }
  await refreshTicketHeader(api, ticketId)
}

export async function setTicketFollowup(
  api: ApiClient,
  ticketId: string,
  at: string,
): Promise<void> {
  await runTool(api, "tickets:setFollowup", { ticketId, at })
  await refreshTicketHeader(api, ticketId)
}

export async function clearTicketFollowup(api: ApiClient, ticketId: string): Promise<void> {
  await runTool(api, "tickets:clearFollowup", { ticketId })
  await refreshTicketHeader(api, ticketId)
}

/**
 * Apply an ensureSummary/regenerateSummary answer. `sinceVersion` is the
 * summary version read before the call: when a live summary event landed
 * meanwhile, the answer is older than what is on screen and is dropped
 * (returns false).
 */
export function applyTicketSummaryResult(
  ticketId: string,
  result: any,
  sinceVersion?: number,
): boolean {
  if (sinceVersion !== undefined && ticketSummaryVersion(ticketId) !== sinceVersion) return false
  setTicketDetailStore(
    produce((s) => {
      const t = s.byId[ticketId]
      if (!t) return
      if ("summary" in result) t.summaryText = result.summary ?? null
      if ("summaryAt" in result) t.summaryAt = result.summaryAt ?? null
      if ("summaryStatus" in result) t.summaryStatus = result.summaryStatus ?? "idle"
      if ("model" in result) t.summaryModel = result.model ?? null
      if ("summaryError" in result) t.summaryError = result.summaryError ?? null
    }),
  )
  return true
}

export function handleTicketEvent(action: string, data: any): void {
  if (!data?.id && !data?.ticketId) return
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("tickets:attention-invalidated"))
  }
  // Trigger global attention re-fetch so the kernel feed stays in sync.
  // Lazy import to avoid bootstrap order issues.
  const id = data.id ?? data.ticketId
  void import("~/modules/shell/attention-store").then(
    async ({ attentionStore, getAttentionApi }) => {
      const api = getAttentionApi()
      if (!api) return
      attentionStore.markStaleAndReload(api)
      // The same event moves an open approval card: its ref chip is the
      // ticket's live handle, which a reclassify changes (QA APR-02).
      const { refreshTicketApprovals } = await import("~/modules/approvals/approvals-store")
      refreshTicketApprovals(api, [id, data.handle])
    },
  )
  if (action === "summary_updated") {
    bumpSummaryVersion(id)
    handleTicketSummaryEvent(data)
  }
  setTicketDetailStore(
    produce((s) => {
      if (action === "create") {
        // The server's create event is a notice (`ticketId`, handle, subject,
        // priority), not a ticket: it has no status, requester or SLA. It may
        // land before tickets:get (a reconnect replays it while the tab loads),
        // so it only creates a row when it carries a whole ticket (`id`, as the
        // update branch below), and otherwise patches a row that is loaded.
        if (data.id || s.byId[id]) upsertTicket(s, id, data as Ticket)
      } else if (action === "summary_updated") {
        const t = s.byId[id]
        if (t) {
          t.summaryText = data.summary ?? data.summaryText ?? t.summaryText
          t.summaryAt = data.summaryAt ?? data.summary_at ?? t.summaryAt
          t.summaryStatus = data.status ?? data.summaryStatus ?? "idle"
          t.summaryModel = data.model ?? data.summaryModel ?? t.summaryModel
          t.summaryError = data.error ?? data.summaryError ?? null
        }
      } else if (action === "update" || action === "merged" || action === "reopened") {
        const t = s.byId[id]
        if (t) {
          const changes = data.changes ?? data
          // Assignment events carry only the assignee id — drop the stale
          // display name so the chip never pairs the new id with the old name,
          // and refresh below to pull the server-joined assigneeName.
          if ("assignedTo" in changes && !("assigneeName" in changes)) {
            if (changes.assignedTo !== t.assignedTo) t.assigneeName = null
          }
          Object.assign(t, changes)
          t.id = id
        } else if (data.id) {
          s.byId[id] = data as Ticket
        }
      }
    }),
  )
  // An assignment change without the joined name: re-pull the header so the
  // assignee chip shows the name instead of a UUID-prefix fallback.
  if (action === "update" && _ticketApi && ticketDetailStore.byId[id]) {
    const changes = data.changes ?? data
    if (
      "assignedTo" in changes &&
      changes.assignedTo &&
      !("assigneeName" in changes) &&
      !ticketDetailStore.byId[id]?.assigneeName
    ) {
      void refreshTicketHeader(_ticketApi, id).catch(() => {})
    }
  }
  // Keep the inbox list in sync with the ticket's new state without waiting for
  // the next full reload:
  //  - a MERGE transitions the source ticket to closed -> drop it from the list.
  //  - any other status transition (close, convert, reply -> awaiting_customer,
  //    reopen) patches the row and prunes it if it no longer matches the active
  //    filter (e.g. a ticket closed in its own tab leaving the all-open list).
  if (action === "merged") {
    void import("~/modules/tickets/ticket-list-store").then(({ removeTicketFromList }) => {
      if (data.sourceTicketId) removeTicketFromList(data.sourceTicketId)
    })
  } else if (action === "update" || action === "reopened") {
    void import("~/modules/tickets/ticket-list-store").then(({ applyTicketUpdateToList }) => {
      // A "reopened" event carries only { ticketId, reason }; a reopen always
      // resolves to an open, un-closed ticket, so synthesize that transition.
      const changes =
        action === "reopened" ? { status: "open", closedReason: null } : (data.changes ?? data)
      applyTicketUpdateToList(id, changes)
    })
  }
}

export function resetTicketDetailStore(): void {
  setTicketDetailStore({
    byId: {},
    loadingById: {},
    loadFailedById: {},
    composeSignatureById: {},
    staleById: {},
  })
}

onSessionTeardown(resetTicketDetailStore)
