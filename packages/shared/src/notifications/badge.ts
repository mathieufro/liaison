// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE BADGE: one number, one meaning, on every surface.
 *
 * The badge counts the unread things that ask for the person, the direct asks
 * of the notification etiquette (docs/notifications.md, "The badge"):
 *
 *   - every unread message in a direct conversation (a DM, a group DM, an
 *     agent chat: `isDirectMessageShape`), unless the person muted or archived
 *     it;
 *   - an unread mention of them, outside a direct conversation (one inside is
 *     already counted by that conversation's messages);
 *   - an unread reply in a reply thread they are in (`thread_followup`);
 *   - an approval they are asked to decide (another person's request they
 *     could have approved themselves is folded, as Home folds it), an access
 *     request they can grant, a routine run waiting for their private mailbox,
 *     a computer session asking them for permission;
 *   - a critical alert (an app kind ending in `.critical`, such as a critical
 *     monitoring incident) scored `NOW_URGENCY` or more. A row scored lower is
 *     not presented as needing anyone now, so nobody could find what it counts.
 *
 * Channel traffic that names nobody, task and ticket work, mail and the rest
 * of the feed are not in it: they wait in the inbox without a number.
 *
 * The phone's icon (the server, `computeBadgeCount`, sent in every push and
 * in the badge sync push after a read), the desktop dock and the browser tab
 * title all count with THIS function, so they cannot disagree on the same
 * data. The Home entry shows its own number: the rows of its "Needs you"
 * section (`homeActionCount`), so that number can always be opened.
 */
import { isDirectMessageShape } from "../threads/conversation-shape"
import type { AttentionItem } from "../types/attention"

/** One conversation as the badge needs it. */
export interface BadgeThread {
  id: string
  /** `kernel.threads.type`. */
  type?: string | null
  /** `kernel.threads.title`. */
  title: string | null
  /** Unread messages for the person, as the thread list counts them. */
  unreadCount: number
  isMuted?: boolean
  isArchived?: boolean
}

/** One attention row as the badge needs it (a feed item satisfies it). */
export type BadgeItem = Pick<AttentionItem, "kind" | "entity" | "entityId"> & {
  urgency?: AttentionItem["urgency"]
  action?: AttentionItem["action"]
  metadata?: Record<string, unknown>
}

/** Who is looking: decides whether an access request is theirs to grant. */
export interface BadgeViewer {
  /** Holds `kernel:scope_requests:admin`. */
  canGrantAccess: boolean
}

/** The kind suffix an app gives an alert that is critical for the people on call. */
export const CRITICAL_ALERT_KIND_SUFFIX = ".critical"

/** Items scored at or above this need the person now, whatever their kind. */
export const NOW_URGENCY = 70

/** Whether a conversation's unread messages count: a direct conversation, not muted or archived. */
export function isBadgeThread(thread: BadgeThread): boolean {
  if (thread.isMuted || thread.isArchived) return false
  return isDirectMessageShape({
    title: thread.title,
    type: thread.type ?? "thread",
    discoverable: false,
    participants: [],
    currentUserId: "",
  })
}

/** The conversation an attention row is about: its channel when it sits in a reply. */
export function badgeItemThreadId(item: BadgeItem): string | null {
  const channel = item.metadata?.threadId
  if (typeof channel === "string" && channel.length > 0) return channel
  return item.entity === "thread" ? item.entityId : null
}

/** Whether an attention row is a direct ask of the viewer. */
export function isBadgeAsk(item: BadgeItem, viewer: BadgeViewer): boolean {
  // A muted item (thread or kind, rule 7) stays in the inbox but never asks.
  if (item.metadata?.quiet === true) return false
  const kind: string = item.kind
  if (kind === "mention" || kind === "thread_followup") return true
  if (kind === "scope_request") return viewer.canGrantAccess
  if (kind === "routine_mailbox_wait") return true
  if (item.metadata?.nodePermissionPromptId || item.metadata?.nodePermission) return true
  if (item.action?.type === "decide_approval" || kind === "approval_pending") {
    // A row for someone else is one this person can also approve, never their ask.
    if (item.metadata?.placement === "others") return false
    return item.metadata?.peerSelfApprovable !== true
  }
  return kind.endsWith(CRITICAL_ALERT_KIND_SUFFIX) && (item.urgency ?? NOW_URGENCY) >= NOW_URGENCY
}

/** The badge: unread messages of direct conversations plus the direct asks among the rows, each once. */
export function countBadge(args: {
  threads: readonly BadgeThread[]
  items: readonly BadgeItem[]
  viewer: BadgeViewer
}): number {
  const direct = new Set<string>()
  let total = 0
  for (const thread of args.threads) {
    if (!isBadgeThread(thread)) continue
    direct.add(thread.id)
    total += Math.max(0, thread.unreadCount)
  }
  const seen = new Set<string>()
  for (const item of args.items) {
    if (!isBadgeAsk(item, args.viewer)) continue
    const threadId = badgeItemThreadId(item)
    if ((item.kind === "mention" || item.kind === "thread_followup") && threadId) {
      // A mention or reply inside a direct conversation is one of its messages.
      if (direct.has(threadId)) continue
    }
    const key = `${item.kind}\u0000${item.entity}\u0000${item.entityId}`
    if (seen.has(key)) continue
    seen.add(key)
    total += 1
  }
  return total
}
