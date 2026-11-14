// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The parts of Home's sidebar that are not in the attention feed (D21):
//   - Waiting on others: the viewer's own pending requests someone else decides
//     (GET /approvals?status=pending&requestedByMe=true);
//   - the latest morning brief (GET /agent/routines/latest-brief);
//   - My computer: the viewer's node, online or not, and its queue (GET /nodes/me);
//   - Today: the next events of the day from the viewer's calendars.
//
// LIVE THE SAME WAY THE FEED IS. Every realtime frame that can change these
// (an approval raised or decided, a routine run posting its output, a node job
// landing) already reloads the attention feed, so this store reloads whenever
// the feed did, at most once per REFRESH_MIN_MS. No second WS subscription,
// no second poll.

import type { ApprovalRequestSummary } from "@liaison/shared"
import { createEffect, createRoot, createSignal, on } from "solid-js"
import { getTabType } from "~/framework/app-registry"
import { isAppUnavailable } from "~/framework/unavailable-apps"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { hasScope } from "~/modules/auth/auth-store"
import type { CalendarEventDto } from "~/modules/calendar/calendar-api"
import { attentionStore } from "~/modules/shell/attention-store"

export interface LatestBrief {
  routineId: string
  name: string
  status: string
  enabled: boolean
  lastRunAt: string | null
  lastRunStatus: string | null
  outputThreadId: string | null
  messageId: string | null
  /** When the newest brief was written: the one time Home shows for the brief. */
  messageAt?: string | null
}

export interface MyComputer {
  online: boolean
  queued: number
}

export interface TodayEvent {
  id: string
  title: string
  start: string
  allDay: boolean
}

const REFRESH_MIN_MS = 3_000
const TODAY_MAX = 3

/** `undefined` = not answered yet; `null` = answered, nothing there. */
const [waiting, setWaiting] = createSignal<ApprovalRequestSummary[]>([])
const [brief, setBrief] = createSignal<LatestBrief | null | undefined>(undefined)
const [computer, setComputer] = createSignal<MyComputer | null>(null)
const [today, setToday] = createSignal<TodayEvent[] | null>(null)

export const homeAgents = {
  waiting,
  brief,
  computer,
  today,
}

/** "Waiting on others": my pending requests that are not mine to decide (a
 *  request I can approve myself is already under Needs you > Approvals). */
export function waitingOnOthers(): ApprovalRequestSummary[] {
  const decidable = new Set(
    attentionStore.items.filter((i) => i.kind === "approval_pending").map((i) => i.entityId),
  )
  return waiting().filter((r) => !decidable.has(r.id))
}

/** The calendar app is there for this viewer (registered, not hidden). */
function calendarAvailable(): boolean {
  const reg = getTabType("calendar:month")
  return Boolean(reg) && !isAppUnavailable(reg?.appId)
}

function startOf(point: CalendarEventDto["start"]): { at: string; allDay: boolean } | null {
  if (!point) return null
  if (point.dateTime) return { at: point.dateTime, allDay: false }
  if (point.date) return { at: `${point.date}T00:00:00`, allDay: true }
  return null
}

/** The next events of the day, soonest first, all-day ones first. */
export function nextEventsToday(
  events: CalendarEventDto[],
  now: Date,
  max = TODAY_MAX,
): TodayEvent[] {
  const out: TodayEvent[] = []
  for (const e of events) {
    if (e.status === "cancelled") continue
    const start = startOf(e.start)
    if (!start) continue
    const endIso = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00` : null)
    // Still to come, or under way.
    if (endIso && new Date(endIso).getTime() <= now.getTime()) continue
    out.push({ id: e.eventId, title: e.title ?? "", start: start.at, allDay: start.allDay })
  }
  out.sort(
    (a, b) =>
      Number(b.allDay) - Number(a.allDay) ||
      new Date(a.start).getTime() - new Date(b.start).getTime(),
  )
  return out.slice(0, max)
}

async function loadWaiting(api: ApiClient): Promise<void> {
  try {
    const rows = await api.get<ApprovalRequestSummary[]>(
      "/approvals?status=pending&requestedByMe=true",
    )
    setWaiting(Array.isArray(rows) ? rows : [])
  } catch {
    // Keep what we had: a failed refresh must not empty the row.
  }
}

async function loadBrief(api: ApiClient): Promise<void> {
  // A viewer who cannot read routines has no brief to point at; asking anyway
  // answers 403 and the client toasts "Permission denied" (walk 2026-10-12).
  if (!hasScope("kernel:routines:read")) {
    setBrief(null)
    return
  }
  try {
    setBrief((await api.get<LatestBrief | null>("/agent/routines/latest-brief")) ?? null)
  } catch {
    if (brief() === undefined) setBrief(null)
  }
}

async function loadComputer(api: ApiClient): Promise<void> {
  try {
    const res = await api.get<{
      nodes?: Array<{ enabled: boolean; online: boolean }>
      queuedJobs?: number
    }>("/nodes/me")
    const nodes = Array.isArray(res?.nodes) ? res.nodes.filter((n) => n.enabled) : []
    setComputer(
      nodes.length === 0
        ? null
        : { online: nodes.some((n) => n.online), queued: res?.queuedJobs ?? 0 },
    )
  } catch {
    // No node feature for this viewer: the row stays hidden.
  }
}

async function loadToday(api: ApiClient): Promise<void> {
  if (!calendarAvailable()) {
    setToday(null)
    return
  }
  const now = new Date()
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  try {
    const events = await api.post<CalendarEventDto[]>("/apps/calendar/tools/list_events", {
      params: { timeMin: startOfDay.toISOString(), timeMax: end.toISOString() },
    })
    setToday(nextEventsToday(Array.isArray(events) ? events : [], now))
  } catch {
    // No calendar connected, or no access: the section stays hidden.
    setToday(null)
  }
}

let lastLoadAt = 0
let pending: ReturnType<typeof setTimeout> | null = null

/** Reload everything now. */
export async function reloadHomeAgents(api: ApiClient): Promise<void> {
  lastLoadAt = Date.now()
  await Promise.all([loadWaiting(api), loadBrief(api), loadComputer(api), loadToday(api)])
}

/** Reload soon, coalescing a burst into one round. */
export function scheduleHomeAgentsReload(api: ApiClient): void {
  if (pending) return
  const wait = Math.max(0, REFRESH_MIN_MS - (Date.now() - lastLoadAt))
  pending = setTimeout(() => {
    pending = null
    void reloadHomeAgents(api)
  }, wait)
}

/**
 * Keep the store live while Home's sidebar is on screen: one reload now, then
 * one after every attention-feed reload. Returns the stop function.
 */
export function followAttentionFeed(api: ApiClient): () => void {
  void reloadHomeAgents(api)
  const dispose = createRoot((disposeRoot) => {
    createEffect(
      on(
        () => attentionStore.lastFetchedAt,
        (ts, prev) => {
          if (ts !== null && prev !== undefined && ts !== prev) scheduleHomeAgentsReload(api)
        },
      ),
    )
    return disposeRoot
  })
  return () => {
    dispose()
  }
}

export function resetHomeAgents(): void {
  if (pending) clearTimeout(pending)
  pending = null
  lastLoadAt = 0
  setWaiting([])
  setBrief(undefined)
  setComputer(null)
  setToday(null)
}
onSessionTeardown(resetHomeAgents)

/** Test seam: set the store's state directly. */
export const HomeAgentsTestAccess = {
  set(state: {
    waiting?: ApprovalRequestSummary[]
    brief?: LatestBrief | null
    computer?: MyComputer | null
    today?: TodayEvent[] | null
  }): void {
    if (state.waiting !== undefined) setWaiting(state.waiting)
    if (state.brief !== undefined) setBrief(state.brief)
    if (state.computer !== undefined) setComputer(state.computer)
    if (state.today !== undefined) setToday(state.today)
  },
}
