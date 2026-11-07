// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE HOME BADGE. Home and Messages used to show the same number: the Home
// icon drew the unread-message total (A14) that the Messages entry already
// shows, so the two entries said the same thing twice and Home's own content
// never reached a badge. Messages counts unread messages; Home counts what
// Home presents as needing the user's action:
//
//   - the rows its Approvals card lists (pending requests the user can decide,
//     access requests they can grant, their routine runs waiting for their
//     private mailbox; never a row for someone else, which waits in the closed
//     "For others" group uncounted), and
//   - the "need you now" alerts its Messages card pins above the unread
//     threads (`urgentStripItems`: scope requests, node permission prompts,
//     SLA risks, system alerts, overdue work scored urgent, anything the
//     provider scored >= 70).
//
// Unread threads and mentions are Messages things: Home lists them in its
// Messages card, but they belong to the Messages badge, so they are not
// counted here. The count reads the same attention store Home renders from,
// which every live path (WS frames, focus, the safety poll) keeps current.
//
// D21 (Home's own sidebar): this list IS the sidebar's "Needs you" section, so
// its total and the badge are one number by construction. Three refinements,
// all here so the badge and the sidebar can never disagree:
//   - a ticket awaiting a reply is queue volume, not a personal decision: it
//     moves to "Your queues" (and out of the badge) unless it is assigned to
//     the viewer (owner, recommendation 1);
//   - an access request counts only for someone who can grant it;
//   - a routine that failed or paused is filed under Agents, never here.

import type { AttentionItem } from "@liaison/shared"
import { createMemo, createRoot } from "solid-js"
import {
  collapseMailboxWaits,
  isExpiredMailboxWait,
} from "~/modules/agent/routine-mailbox-wait-item"
import { isDecisionInFlight } from "~/modules/approvals/decision-queue"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { isApprovalItem, partitionOthersRows } from "~/modules/shell/approval-facets"
import { newestPromptPerChat, splitFeed, urgentStripItems } from "~/modules/shell/attention-groups"
import { attentionStore } from "~/modules/shell/attention-store"

/** The rows Home's Approvals card lists, before its action facet: approvals,
 *  access requests (only for someone who can grant them) and routine runs
 *  waiting for a private mailbox, all of them as one row. A waiting run whose
 *  24 hours are over has left the list (its run history says it expired; the
 *  server's sweep marks its row read too). With `othersShown` false, a row
 *  for someone else ("For others, you can also approve") is left out. */
export function homeApprovalItems(
  nowItems: AttentionItem[],
  othersShown: boolean,
  viewer: HomeViewer = { userId: "", canGrantAccess: true },
): AttentionItem[] {
  const approvals = collapseMailboxWaits(
    nowItems.filter(
      (item) =>
        isApprovalItem(item) &&
        !isExpiredMailboxWait(item) &&
        (item.kind !== "scope_request" || viewer.canGrantAccess),
    ),
  )
  return othersShown ? approvals : partitionOthersRows(approvals).mine
}

/** Who is looking: what decides an item is theirs to act on. */
export interface HomeViewer {
  userId: string
  /** Holds `kernel:scope_requests:admin`: access requests are theirs to grant. */
  canGrantAccess: boolean
}

export const ACCESS_GRANT_SCOPE = "kernel:scope_requests:admin"

/** The signed-in viewer, read from the token (reactive through it). */
export function currentHomeViewer(): HomeViewer {
  return { userId: userFromToken()?.userId ?? "", canGrantAccess: hasScope(ACCESS_GRANT_SCOPE) }
}

/** A ticket awaiting a reply that is not assigned to the viewer: queue volume
 *  ("Your queues"), not a decision (D21, recommendation 1). */
export function isQueueVolumeItem(item: AttentionItem, viewer: HomeViewer): boolean {
  if (item.kind !== "awaiting_agent") return false
  const assignedTo = item.metadata?.assignedTo
  return !(typeof assignedTo === "string" && assignedTo.length > 0 && assignedTo === viewer.userId)
}

/** A routine that failed or paused (routine-alert.ts): Home's Agents section. */
export function isRoutineAlertItem(item: AttentionItem): boolean {
  const alert = item.metadata?.routineAlert
  return typeof alert === "object" && alert !== null
}

/** The mail app's notice that the send check stopped a send as it went out (manifest kind). */
export const SEND_STOPPED_KIND = "mail:send_guard.stopped"

/**
 * Shown on Home, never counted: a send the check stopped, and a draft whose check says it can no
 * longer go out as written (attention.ts `metadata.uncounted`). Each says why and offers Dismiss.
 */
export function isUncountedItem(item: AttentionItem): boolean {
  // An app event's kind ("mail:...") rides in `kind` beside the kernel's own kinds.
  const kind: string = item.kind
  return kind === SEND_STOPPED_KIND || item.metadata?.uncounted === true
}

/** An approval whose decision is queued or being sent (decision-queue.ts). */
export function isApprovalDecisionInFlight(item: AttentionItem): boolean {
  return (
    item.action?.type === "decide_approval" &&
    isDecisionInFlight("approval", item.action.approvalId)
  )
}

/** Every item Home presents as needing the user's action, each once. This is
 *  the sidebar's "Needs you" section and the Home badge (D21). */
export function homeActionItems(
  items: AttentionItem[],
  othersShown: boolean,
  viewer: HomeViewer = { userId: "", canGrantAccess: true },
): AttentionItem[] {
  const { now } = splitFeed(items)
  const seen = new Set<string>()
  const out: AttentionItem[] = []
  for (const item of [...homeApprovalItems(now, othersShown, viewer), ...urgentStripItems(now)]) {
    if (seen.has(item.id)) continue
    if (isUncountedItem(item)) continue
    // Decided, waiting out its Undo window or being carried out: the row is gone, so is its count.
    if (isApprovalDecisionInFlight(item)) continue
    if (isQueueVolumeItem(item, viewer)) continue
    if (isRoutineAlertItem(item)) continue
    if (item.kind === "scope_request" && !viewer.canGrantAccess) continue
    seen.add(item.id)
    out.push(item)
  }
  return out
}

/**
 * The shared memo, built on the first read rather than at import: importing
 * this module must not read the token or the stores (a module that merely
 * imports the shell would otherwise read auth state before anything set it).
 */
let count: (() => number) | null = null

/** The number the Home entry shows. */
export function homeActionCount(): number {
  count ??= createRoot(() =>
    createMemo(
      () =>
        homeActionItems(newestPromptPerChat(attentionStore.items), false, currentHomeViewer())
          .length,
    ),
  )
  return count()
}

/**
 * The number of approvals Home's Approvals card counts from `items`: the
 * viewer's own rows, never the ones for someone else. Work's Approvals row
 * shows this, so the one queue never carries two counts.
 */
export function homeApprovalCount(items: AttentionItem[]): number {
  return homeApprovalItems(splitFeed(items).now, false, currentHomeViewer()).length
}
