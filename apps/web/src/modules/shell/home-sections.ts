// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HOME'S SIDEBAR, AS DATA (D21). Home used to borrow the Messages list as its
// sidebar, so Home and Messages read alike and the feed was one undivided
// pile. Home's sidebar is now a table of contents of what is asked of the
// viewer, grouped by WHY it is in front of them:
//
//   Needs you    decisions and alerts. Its total IS the Home badge: the rows
//                are a partition of `homeActionItems`, the badge's own list.
//   Your queues  work piling up per app (muted counts, not in the badge).
//   Agents       what agents produced or got stuck on.
//   Today        next calendar events (client wiring, home-agents-store).
//
// Conversations (channels, DMs, followed threads, mentions) and new mail are
// not here: they live in Messages and Mail. Every main-panel filter reads the
// same model, so a sidebar count and the rows it opens cannot disagree.

import type { AttentionItem } from "@liaison/shared"
import {
  type ApprovalFacet,
  approvalActionFacets,
  isApprovalItem,
  partitionOthersRows,
} from "~/modules/shell/approval-facets"
import {
  type AlertEntry,
  type AttentionGroup,
  clusterAlerts,
  isNowItem,
  isTimeLimited,
  newestPromptPerChat,
  splitFeed,
} from "~/modules/shell/attention-groups"
import {
  type HomeViewer,
  homeActionItems,
  homeApprovalItems,
  isRoutineAlertItem,
  isUncountedItem,
} from "~/modules/shell/home-action-count"

/** Conversation kinds: Messages owns the kernel's, so Home's queues never
 *  list them. Another app's `mention` (a social comment) is work, not a chat. */
const CONVERSATION_KINDS = new Set<string>(["thread_reply", "thread_followup", "mention"])

/** The mail producer's kind for a new email (api notifications/mail-producer.ts). */
const NEW_EMAIL_KIND = "new_email"

function isConversation(item: AttentionItem): boolean {
  return item.app === "kernel" && CONVERSATION_KINDS.has(item.kind)
}

export interface HomeSections {
  needs: {
    /** === homeActionItems(...).length === the Home badge. */
    total: number
    timeLimited: AttentionItem[]
    approvals: AttentionItem[]
    approvalFacets: ApprovalFacet[]
    /** Rows for someone else the viewer can also approve: Home's closed group, not counted. */
    others: AttentionItem[]
    alerts: AttentionItem[]
    alertEntries: AlertEntry[]
    /** Shown in Needs you, not counted: stopped sends and drafts that can no longer go out. */
    uncounted: AttentionItem[]
  }
  /** Work groups by app, biggest urgency first (splitFeed's own order). */
  queues: AttentionGroup[]
  queueTotal: number
  agents: {
    /** Routines that failed or paused (routine-alert.ts). */
    failed: AttentionItem[]
    /** Agent FYIs (`<app>::notifications`), routine alerts excluded. */
    notifications: AttentionItem[]
  }
}

export function buildHomeSections(
  feedItems: AttentionItem[],
  opts: { viewer: HomeViewer; nowMs?: number },
): HomeSections {
  // One "needs your OK" row per node chat, its newest prompt (and one count).
  const items = newestPromptPerChat(feedItems)
  const nowMs = opts.nowMs ?? Date.now()
  const needItems = homeActionItems(items, false, opts.viewer)
  const timeLimited: AttentionItem[] = []
  const approvals: AttentionItem[] = []
  const alerts: AttentionItem[] = []
  for (const item of needItems) {
    if (isTimeLimited(item, nowMs)) timeLimited.push(item)
    // Approvals, access requests and routine runs waiting for a private
    // mailbox: one list, everything that waits on the viewer's decision.
    else if (isApprovalItem(item)) approvals.push(item)
    else alerts.push(item)
  }
  const allApprovals = homeApprovalItems(splitFeed(items).now, true, opts.viewer)
  const others = partitionOthersRows(allApprovals).others

  // Everything urgent that is not in Needs you is volume and joins its app's
  // queue: a ticket awaiting a reply that is not the viewer's, another app's
  // mention or reply suggestion (opened, not decided inline). What stays out
  // of the queues: Needs you itself, approvals (a folded peer request is
  // in the closed "For others" group, access requests among them), routine alerts
  // (Agents) and mail (Mail's).
  const needIds = new Set(needItems.map((i) => i.id))
  const staysNow = (i: AttentionItem): boolean =>
    needIds.has(i.id) ||
    isApprovalItem(i) ||
    i.app === "mail" ||
    (isRoutineAlertItem(i) && isNowItem(i))
  const feed = splitFeed(
    items.filter((i) => !isConversation(i)),
    { isNow: (i) => isNowItem(i) && staysNow(i) },
  )
  const queues: AttentionGroup[] = []
  const notifications: AttentionItem[] = []
  for (const group of feed.groups) {
    if (group.key.endsWith("::notifications")) {
      notifications.push(...group.items.filter((i) => !isRoutineAlertItem(i)))
      continue
    }
    const work = group.items.filter((i) => !isRoutineAlertItem(i))
    if (work.length === 0) continue
    queues.push(work.length === group.items.length ? group : regroup(group, work))
  }
  // D21a: new emails (S9, in production) are queue volume: "New mail" under
  // Your queues, never Needs you or the badge. splitFeed's groups skip every
  // mail item (Home's old Mail card carded them), so they are filed here.
  // A mail reply approval stays a decision in Needs you.
  const newMail = items.filter(
    (i) =>
      i.app === "mail" &&
      (i.kind as string) === NEW_EMAIL_KIND &&
      !needIds.has(i.id) &&
      !isApprovalItem(i),
  )
  if (newMail.length > 0) {
    queues.push(itemsGroup("mail", "mail", "New mail", "kernel.homeSidebar.newMail", newMail))
  }
  const failed = items.filter(isRoutineAlertItem)

  return {
    needs: {
      total: needItems.length,
      timeLimited,
      approvals,
      approvalFacets: approvalActionFacets(approvals),
      others,
      alerts,
      alertEntries: clusterAlerts(alerts, nowMs),
      uncounted: items.filter(isUncountedItem),
    },
    queues,
    queueTotal: queues.reduce((sum, g) => sum + g.items.length, 0),
    agents: { failed, notifications },
  }
}

/** A ledger group for a set of items Home shows together (Agents rows). */
export function itemsGroup(
  key: string,
  app: string,
  label: string,
  labelKey: string,
  items: AttentionItem[],
): AttentionGroup {
  return regroup(
    { app, key, label, labelKey, items, kindCounts: [], maxUrgency: 0, markable: true },
    items,
  )
}

function regroup(group: AttentionGroup, items: AttentionItem[]): AttentionGroup {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
  return {
    ...group,
    items,
    maxUrgency: items.reduce((max, i) => (i.urgency > max ? i.urgency : max), 0),
    markable: items.every((i) => i.persisted),
    kindCounts: [...counts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count),
  }
}

// --- The main-panel filter --------------------------------------------------
//
// One string names what the sidebar (or a phone chip) selected:
//   overview
//   needs | needs:time | needs:approvals[:<facet>] | needs:others | needs:alerts[:<cluster>]
//   queues | queue:<groupKey>[|<kind>]
//   agents | agents:failed | agents:waiting | agents:notifications
//   today
export type HomeFilter = string

export const OVERVIEW: HomeFilter = "overview"

/** The section a filter belongs to (the phone chip it lights). */
export function filterSection(
  filter: HomeFilter,
): "overview" | "needs" | "queues" | "agents" | "today" {
  if (filter.startsWith("needs")) return "needs"
  if (filter === "queues" || filter.startsWith("queue:")) return "queues"
  if (filter.startsWith("agents")) return "agents"
  if (filter === "today") return "today"
  return "overview"
}

/** The approval facet a filter selects, null for every approval. */
export function approvalFacetOf(filter: HomeFilter): string | null {
  return filter.startsWith("needs:approvals:") ? filter.slice("needs:approvals:".length) : null
}

/** The alert cluster key a filter selects, null for every alert. */
export function alertClusterOf(filter: HomeFilter): string | null {
  return filter.startsWith("needs:alerts:") ? filter.slice("needs:alerts:".length) : null
}

/** A queue filter's group key and optional kind. */
export function queueOf(filter: HomeFilter): { key: string; kind: string | null } | null {
  if (!filter.startsWith("queue:")) return null
  const rest = filter.slice("queue:".length)
  const bar = rest.indexOf("|")
  return bar < 0
    ? { key: rest, kind: null }
    : { key: rest.slice(0, bar), kind: rest.slice(bar + 1) }
}

/** Items of the alert entries a cluster filter selects. */
export function alertItemsFor(sections: HomeSections, cluster: string | null): AttentionItem[] {
  if (cluster === null) return sections.needs.alerts
  return sections.needs.alerts.filter((i) => `${i.app}::${i.kind}` === cluster)
}
