// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The notification router (S1): the single function that decides, for one item
 * and one recipient, on which channels the item is delivered.
 *
 * Rules, in order:
 *   1. app_rule: the recipient's per-app rule (kernel.attention_subscriptions)
 *      switched the app off or unticked the kind: suppressed everywhere,
 *      in_app included. A mention and a system alert are never narrowed by a
 *      rule (today's HIGH_SIGNAL_KINDS in the translator).
 *   2. thread_muted / kind_muted (etiquette rule 7, mute means mute): a muted
 *      or archived thread, or a kind (group) the recipient set to off, is
 *      silenced on push, desktop and email whatever its group, an @mention and
 *      an urgent item included. The in-app record stays, marked `quiet`: the
 *      producer writes it already read, so it shows in the inbox list without
 *      counting toward the badge.
 *   3. in_app always delivers past that point.
 *   4. grid_off: the recipient's grid cell for (group, channel) is off. Digest
 *      cadence `off` reads as every email cell off. A channel the recipient
 *      opted into every post (`user_thread_state.notify_all_posts`) reads its
 *      `replies` messages under the `direct` row's live cells: by default a
 *      channel interrupts its members only for a mention.
 *   5. quiet_time (etiquette rule 8): outside the work window, push and desktop
 *      are held back. Until the person sets their own hours the window is
 *      08:00-20:00 Monday to Friday (quiet-window.ts), read in their time zone,
 *      else the org's, else UTC. Email is deferred to the next window
 *      (`eligibleAt`). Only a critical (urgent) incident for a person on call
 *      crosses quiet time; any other urgent item is emailed at once only inside
 *      the window.
 *   5b. not_on_call (etiquette rule 9): an incident (group `monitoring`)
 *      interrupts only the org's on-call people (on-call.ts); everyone else who
 *      can see it gets it in the inbox only.
 *   6. active_in_thread: a message in a thread the recipient is reading on a
 *      focused client, or has just posted or typed in, is not pushed or raised
 *      on the desktop (thread-activity.ts). The in-app record stays. Urgency
 *      does not break through: they are looking at it. A computer session's
 *      notice (`sessionPresence`) is held back the same way while a focused
 *      client shows the session (2 min idle bound, no interaction rule). An
 *      item marked `presenceViewingOnly` (an agent's finished answer to the
 *      person who asked, an approval raised in a chat) is held back only while
 *      that very conversation is on a focused screen: having posted there a
 *      moment ago and moved on does not count.
 *   7. no_device: push with no registered token.
 *
 * Every sender takes a `RouterDecision`, which only this module constructs, so
 * a producer cannot send without asking the router first (S2).
 */

import { createHash } from "node:crypto"
import {
  type AwayRangeDays,
  awayRunEnd,
  groupForChatMessage,
  groupForKind,
  type HomePlacement,
  isUrgentFor,
  type NotificationGrid,
  type NotificationGroupId,
  personLocalDate,
} from "@liaison/shared"
import { sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { evaluateSubscriptionDecision, loadRulesForUser } from "~/modules/attention/subscriptions"
import {
  firstWorkWindowAfterDay,
  isOutsideWorkWindow,
  nextWorkWindowStart,
  type WorkHoursPrefs,
} from "~/modules/attention/work-hours"
import { orgNotificationFacts } from "./on-call"
import { defaultQuietHoursOn, effectiveQuietWindow, isValidTimezone } from "./quiet-window"
import { readNotificationChannels } from "./settings"
import { loadActiveInThread, loadViewingSession, loadViewingThread } from "./thread-activity"

const K = sql.raw(schemaRef("kernel"))
const log = rootLogger.child({ module: "notifications-router" })

/** Kinds a per-app rule can never narrow (same set as the translator's). */
const HIGH_SIGNAL_KINDS = new Set<string>(["mention", "system_alert"])

export type SuppressReason =
  | "grid_off"
  | "app_rule"
  | "thread_muted"
  | "quiet_time"
  | "no_device"
  /** The recipient's settings could not be loaded (push/desktop only). */
  | "router_error"
  /** The recipient is reading the thread, or just posted in it (push/desktop only). */
  | "active_in_thread"
  /** The owner muted this computer session (push, desktop and email). */
  | "session_muted"
  /** Held for the recipient's burst summary (burst.ts): push and desktop only. */
  | "burst"
  /** The recipient set this kind (group) to off: push, desktop and email (rule 7). */
  | "kind_muted"
  /** An incident for someone who is not on call: push and desktop only (rule 9). */
  | "not_on_call"
  /** A request that is another person's to decide: a row in the feed, nobody's news. */
  | "not_for_you"
  /** The recipient is away and the item is not urgent: push and desktop only. */
  | "away"

export interface ChannelDecision {
  deliver: boolean
  reason?: SuppressReason
  /**
   * In-app only: the item is muted (thread or kind). It is recorded already
   * read, so it shows in the inbox list without asking for attention.
   */
  quiet?: true
}

export interface EmailDecision extends ChannelDecision {
  /** When the digest may send it: now, or the next work window for a held item. */
  eligibleAt?: Date
  /** Settings were unreadable: keep the row pending, the digest decides again. */
  recheck?: boolean
}

export interface RouterRecipient {
  userId: string
  orgId: string
}

export interface RouterItem {
  /** Attention kind (`sla_risk`, `shopify:order.created`), or any label for a chat message. */
  kind: string
  /** Source app, the key of the per-app rule (`kernel` for kernel kinds). */
  app: string
  entityType?: string
  entityId?: string
  threadId?: string | null
  /** The stored `attention_events.is_urgent`. */
  isUrgent: boolean
  /** `approval_pending`: the users who can decide it. */
  approverIds?: readonly string[]
  /**
   * `approval_pending`: where the row sits for this recipient (approvals/attention.ts). `others`
   * is a request for someone else that the recipient may also decide: it stays in their feed and
   * asks nothing of them. Absent reads as theirs.
   */
  placement?: Exclude<HomePlacement, "hidden">
  /** The recipient is @mentioned by this item. */
  isMention?: boolean
  /** Set for a chat message event: its group comes from the room, not the kind. */
  chatMessage?: { direct: boolean }
  /** Per-app rule filter axes (`attention_subscriptions.filters`). */
  axes?: Record<string, string | undefined>
  /**
   * Set for a message: the conversation a client must have ON SCREEN for the
   * recipient to count as in it (rule 6). The thread's id for a message the
   * channel shows; the reply thread's ROOT message id for a reply that lives
   * only in its reply thread, so having the channel open does not swallow a
   * reply nobody is looking at.
   */
  presenceKey?: string
  /**
   * `presenceKey` is a computer session's id: the recipient counts as in it
   * while a focused client shows the session (`isViewingSession`), not by the
   * thread rules.
   */
  sessionPresence?: true
  /**
   * `presenceKey` counts only while the conversation is ON SCREEN on a focused
   * client (`isViewingThread`), not by the recent-interaction rule: the
   * finished answer of an agent to the person who asked it, and an approval
   * raised in a chat, are for them unless they are looking at it right now.
   */
  presenceViewingOnly?: true
}

type AppRules = Parameters<typeof evaluateSubscriptionDecision>[0]

/** Everything the router reads about one recipient for one item. */
export interface RecipientContext {
  grid: NotificationGrid
  digestCadence: "immediate" | "hourly" | "daily" | "off"
  workHours: WorkHoursPrefs
  workHoursExplicit: boolean
  appRules: AppRules
  threadMuted: boolean
  /**
   * The recipient archived the item's thread: its channel posts stay quiet
   * (the `replies` group, a mention breaks through), as before mute meant mute.
   */
  threadArchived?: boolean
  /** The recipient opted the item's thread into every post (absent reads as no). */
  threadNotifyAll?: boolean
  hasPushDevice: boolean
  /** The recipient is in the item's thread right now (rule 6). Absent reads as no. */
  activeInThread?: boolean
  /** Groups the recipient set to off (mute the kind, etiquette rule 7). */
  mutedGroups?: readonly NotificationGroupId[]
  /** The org's time zone, the fallback clock of quiet hours (rule 8). */
  orgTimezone?: string | null
  /** The org's admin set its time zone. */
  orgTimezoneSet?: boolean
  /** The person set `workHours.timezone` (settings, the agent, or their browser reported it). */
  timezoneSet?: boolean
  /** `users.timezone`, the profile's; null until set. */
  profileTimezone?: string | null
  /** The recipient is on call (rule 9). Read for incidents only; absent reads as yes. */
  onCall?: boolean
  /** Default quiet hours are on (rule 8); absent reads `NOTIFICATIONS_DEFAULT_QUIET_HOURS`. */
  defaultQuietHours?: boolean
  /**
   * The recipient is away today: the last day of the run of away days, `YYYY-MM-DD` in their own
   * zone. Non-urgent push and desktop stay quiet and email waits for the first work window after it.
   */
  awayUntil?: string | null
}

export type RecipientContextLoader = (
  recipient: RouterRecipient,
  item: RouterItem,
) => Promise<RecipientContext>

declare const routerDecisionBrand: unique symbol

/**
 * The router's answer. Branded: only `resolveChannels` builds one, so a sender
 * typed to take a `RouterDecision` cannot be called with a hand-made object.
 */
export interface RouterDecision {
  readonly [routerDecisionBrand]: true
  readonly userId: string
  readonly orgId: string
  readonly group: NotificationGroupId
  readonly urgent: boolean
  /** True when the recipient's settings could not be loaded. */
  readonly degraded: boolean
  readonly channels: {
    readonly in_app: ChannelDecision
    readonly desktop: ChannelDecision
    readonly push: ChannelDecision
    readonly email: EmailDecision
  }
}

type DecisionBody = Omit<RouterDecision, typeof routerDecisionBrand>

function brand(body: DecisionBody): RouterDecision {
  return Object.freeze(body) as RouterDecision
}

let degradedCount = 0

/** How many decisions fell back because settings could not be loaded (metric). */
export function routerDegradedCount(): number {
  return degradedCount
}

/**
 * Namespace of `notificationIdFor` (uuidv5). Fixed forever: changing it would
 * change every id a client may still hold a receipt for.
 */
export const NOTIFICATION_ID_NAMESPACE = "5b0f3c1e-8d2a-4e6b-9a7c-2f4d6e8a0c13"

function uuidv5(name: string, namespace: string): string {
  const hash = createHash("sha1")
    .update(Buffer.from(namespace.replace(/-/g, ""), "hex"))
    .update(name, "utf8")
    .digest()
  const b = hash.subarray(0, 16)
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = b.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * The `notificationId` of one routed item for one recipient (S1, A5, F2): the
 * identity every payload carries (APNs custom data, the desktop frame, Web
 * Push) and every delivery row and receipt is keyed on.
 *
 * Deterministic on (recipient, the producer's `notifyId`), so the same item
 * routed again (an outbox retry, a second instance) gets the same id and the
 * log stays one notification. The router decides before the producer's row
 * exists (an attention row's id is known only after its insert), so the id is
 * derived from the decision's recipient and the item key at the send points,
 * never stored on the decision.
 */
export function notificationIdFor(userId: string, notifyId: string): string {
  return uuidv5(`${userId}:${notifyId}`, NOTIFICATION_ID_NAMESPACE)
}

/**
 * The collapse id (push) and tag (computer) of a notification that keeps its
 * own banner: a direct ask (a direct message, a mention, an urgent item such
 * as an approval). It still stacks with its conversation (APNs `thread-id`),
 * but a later ordinary message of that conversation never replaces it. 38
 * bytes, under the APNs 64-byte cap.
 */
export function ownBannerId(userId: string, notifyId: string): string {
  return `n:${notificationIdFor(userId, notifyId)}`
}

/** A direct ask: delivered on its own, never folded into a burst of someone else's (burst.ts). */
export function isDirectAsk(decision: RouterDecision, mentioned = false): boolean {
  return mentioned || decision.urgent || decision.group === "direct"
}

export function groupOfItem(item: RouterItem): NotificationGroupId {
  if (item.chatMessage) {
    return groupForChatMessage({ direct: item.chatMessage.direct, mentioned: !!item.isMention })
  }
  return groupForKind(item.kind)
}

function all(decision: ChannelDecision): DecisionBody["channels"] {
  return { in_app: decision, desktop: decision, push: decision, email: decision }
}

function decide(
  recipient: RouterRecipient,
  item: RouterItem,
  ctx: RecipientContext,
  now: Date,
): DecisionBody {
  const group = groupOfItem(item)
  const incident = group === "monitoring"
  const onCall = ctx.onCall !== false
  // A critical incident is urgent only for the people on call: everyone else
  // gets it in the inbox and the digest, never the urgent email (rule 9).
  const urgent = isUrgentFor(item, recipient.userId) && !(incident && !onCall)
  const base = { userId: recipient.userId, orgId: recipient.orgId, group, urgent, degraded: false }

  if (!HIGH_SIGNAL_KINDS.has(item.kind)) {
    const allowed = evaluateSubscriptionDecision(ctx.appRules, {
      kind: item.kind,
      axes: item.axes ?? {},
    })
    if (!allowed) return { ...base, channels: all({ deliver: false, reason: "app_rule" }) }
  }

  // Another person's request that this recipient may also decide: its row stays in the feed,
  // but it asks nothing of them, so no push, no desktop banner and no digest line.
  if (item.kind === "approval_pending" && item.placement === "others") {
    const off: ChannelDecision = { deliver: false, reason: "not_for_you" }
    return {
      ...base,
      urgent: false,
      channels: { in_app: { deliver: true }, desktop: off, push: off, email: off },
    }
  }

  const muteReason: SuppressReason | null = ctx.threadMuted
    ? "thread_muted"
    : ctx.mutedGroups?.includes(group)
      ? "kind_muted"
      : null
  const archivedQuiet = ctx.threadArchived === true && group === "replies" && !item.isMention
  if (muteReason || archivedQuiet) {
    const off: ChannelDecision = { deliver: false, reason: muteReason ?? "thread_muted" }
    return {
      ...base,
      channels: { in_app: { deliver: true, quiet: true }, desktop: off, push: off, email: off },
    }
  }

  // A channel opted into every post interrupts like a direct message does
  // (its live cells come from the `direct` row); its email stays `replies`'.
  const cells =
    group === "replies" && item.chatMessage && ctx.threadNotifyAll === true
      ? { ...ctx.grid.replies, desktop: ctx.grid.direct.desktop, push: ctx.grid.direct.push }
      : ctx.grid[group]
  const window = effectiveQuietWindow({
    stored: ctx.workHours,
    explicit: ctx.workHoursExplicit,
    clock: {
      prefsTimezoneSet: ctx.timezoneSet,
      profileTimezone: ctx.profileTimezone,
      orgTimezone: ctx.orgTimezone,
      orgTimezoneSet: ctx.orgTimezoneSet,
    },
    defaultOn: ctx.defaultQuietHours ?? defaultQuietHoursOn(),
  })
  const outside = isOutsideWorkWindow(now, window)
  // Only a critical alert for the people on call crosses quiet hours.
  const crossesQuiet = incident && urgent && onCall
  const quiet = window.quietLive && outside && !crossesQuiet

  const live = (on: boolean): ChannelDecision => {
    if (!on) return { deliver: false, reason: "grid_off" }
    if (incident && !onCall) return { deliver: false, reason: "not_on_call" }
    if (quiet) return { deliver: false, reason: "quiet_time" }
    return { deliver: true }
  }

  const here = typeof item.presenceKey === "string" && ctx.activeInThread === true
  const device = (on: boolean): ChannelDecision => {
    const d = live(on)
    return d.deliver && here ? { deliver: false, reason: "active_in_thread" } : d
  }

  // Someone away gets less noise, not less data: nothing non-urgent interrupts them, and what
  // they would have read at their desk waits for the first work window after the range.
  const awayHold = ctx.awayUntil && !urgent ? ctx.awayUntil : null
  const quietForAway = (d: ChannelDecision): ChannelDecision =>
    awayHold && d.deliver ? { deliver: false, reason: "away" } : d

  let push = device(cells.push)
  if (push.deliver && !ctx.hasPushDevice) push = { deliver: false, reason: "no_device" }
  push = quietForAway(push)
  const desktop = quietForAway(device(cells.desktop))

  const usualEmailAt =
    crossesQuiet || (urgent && (!outside || !window.quietLive))
      ? now
      : nextWorkWindowStart(now, window)
  const afterAway = awayHold ? firstWorkWindowAfterDay(awayHold, window) : null
  const emailAt =
    afterAway && afterAway.getTime() > usualEmailAt.getTime() ? afterAway : usualEmailAt
  const emailOn = cells.email && ctx.digestCadence !== "off"
  const email: EmailDecision = emailOn
    ? { deliver: true, eligibleAt: emailAt }
    : { deliver: false, reason: "grid_off" }

  return {
    ...base,
    channels: { in_app: { deliver: true }, desktop, push, email },
  }
}

export interface ResolveChannelsOptions {
  now?: Date
  /** Injected in tests; defaults to the privileged DB loader. */
  loadContext?: RecipientContextLoader
}

/** Decide the channels for one item and one recipient. Never throws. */
export async function resolveChannels(
  recipient: RouterRecipient,
  item: RouterItem,
  opts: ResolveChannelsOptions = {},
): Promise<RouterDecision> {
  const now = opts.now ?? new Date()
  const load = opts.loadContext ?? defaultLoadRecipientContext
  let ctx: RecipientContext
  try {
    ctx = await load(recipient, item)
  } catch (err) {
    degradedCount += 1
    log.warn(
      {
        err,
        metric: "notifications.router.degraded",
        userId: recipient.userId,
        orgId: recipient.orgId,
        kind: item.kind,
      },
      "notification settings unreadable: in_app kept, email left to the digest, push/desktop suppressed",
    )
    return brand({
      userId: recipient.userId,
      orgId: recipient.orgId,
      group: groupOfItem(item),
      urgent: isUrgentFor(item, recipient.userId),
      degraded: true,
      channels: {
        in_app: { deliver: true },
        desktop: { deliver: false, reason: "router_error" },
        push: { deliver: false, reason: "router_error" },
        email: { deliver: true, recheck: true },
      },
    })
  }
  return brand(decide(recipient, item, ctx, now))
}

/**
 * A muted computer session (S14): the decision with push, desktop and email
 * off (`session_muted`); the in-app row stays. Built here so a decision stays
 * something only the router makes.
 */
export function mutedSessionDecision(decision: RouterDecision): RouterDecision {
  const off: ChannelDecision = { deliver: false, reason: "session_muted" }
  return brand({
    userId: decision.userId,
    orgId: decision.orgId,
    group: decision.group,
    urgent: decision.urgent,
    degraded: decision.degraded,
    channels: { in_app: decision.channels.in_app, desktop: off, push: off, email: off },
  })
}

/**
 * The decision of an item held for a burst summary (burst.ts): push and
 * desktop off with reason `burst`, everything else as the router decided.
 */
export function burstHeldDecision(decision: RouterDecision): RouterDecision {
  const off: ChannelDecision = { deliver: false, reason: "burst" }
  const hold = (c: ChannelDecision): ChannelDecision => (c.deliver ? off : c)
  return brand({
    userId: decision.userId,
    orgId: decision.orgId,
    group: decision.group,
    urgent: decision.urgent,
    degraded: decision.degraded,
    channels: {
      in_app: decision.channels.in_app,
      desktop: hold(decision.channels.desktop),
      push: hold(decision.channels.push),
      email: decision.channels.email,
    },
  })
}

/**
 * The decision a burst summary is sent with: the live channels the router had
 * allowed for at least one held item. It writes no in-app row and no email
 * (the items have their own); its group is `direct` so the computer plays the
 * message sound once.
 */
export function burstSummaryDecision(args: {
  orgId: string
  userId: string
  push: boolean
  desktop: boolean
}): RouterDecision {
  const off: ChannelDecision = { deliver: false, reason: "burst" }
  return brand({
    userId: args.userId,
    orgId: args.orgId,
    group: "direct",
    urgent: false,
    degraded: false,
    channels: {
      in_app: off,
      desktop: args.desktop ? { deliver: true } : off,
      push: args.push ? { deliver: true } : off,
      email: off,
    },
  })
}

const DEFAULT_WORK_HOURS: WorkHoursPrefs = {
  workHoursStart: "09:00",
  workHoursEnd: "17:00",
  workDays: [1, 2, 3, 4, 5],
  timezone: "UTC",
}

/**
 * Production loader: one privileged transaction reading the preferences row,
 * the per-app rules for the item's source, the thread state and the push
 * tokens. A user with no preferences row gets the defaults (grid, no quiet
 * time on push/desktop, email as today). An invalid timezone reads as UTC.
 */
export async function defaultLoadRecipientContext(
  recipient: RouterRecipient,
  item: RouterItem,
): Promise<RecipientContext> {
  // The presence registry lives in Redis, so it is read outside the
  // transaction, and only for an item with a presence key (rule 6). It fails
  // open on its own.
  const presence = (key: string): Promise<boolean> =>
    item.sessionPresence
      ? loadViewingSession(recipient.orgId, recipient.userId, key)
      : item.presenceViewingOnly
        ? loadViewingThread(recipient.orgId, recipient.userId, key)
        : loadActiveInThread(recipient.orgId, recipient.userId, key)
  const [ctx, activeInThread] = await Promise.all([
    loadStoredRecipientContext(recipient, item),
    item.presenceKey ? presence(item.presenceKey) : Promise.resolve(false),
  ])
  return { ...ctx, activeInThread }
}

async function loadStoredRecipientContext(
  recipient: RouterRecipient,
  item: RouterItem,
): Promise<RecipientContext> {
  return withPrivilegedDb(
    recipient.orgId,
    "notifications:router-load",
    async (tx: PrivilegedDb) => {
      const prefRows = (await tx.execute(
        sql`SELECT p.digest_cadence, p.work_hours_start, p.work_hours_end, p.work_days,
                 p.timezone, p.notification_channels, u.timezone AS profile_timezone
            FROM ${K}.user_preferences p
            JOIN ${K}.users u ON u.id = p.user_id AND u.org_id = ${recipient.orgId}
           WHERE p.user_id = ${recipient.userId} LIMIT 1`,
      )) as unknown as Array<{
        digest_cadence: string
        work_hours_start: string
        work_hours_end: string
        work_days: number[]
        timezone: string | null
        notification_channels: unknown
        profile_timezone: string | null
      }>
      const pref = prefRows[0]

      let workHours = DEFAULT_WORK_HOURS
      if (pref) {
        let timezone = pref.timezone ?? "UTC"
        if (!isValidTimezone(timezone)) {
          log.warn({ userId: recipient.userId, timezone }, "invalid timezone, using UTC")
          timezone = "UTC"
        }
        workHours = {
          workHoursStart: pref.work_hours_start.slice(0, 5),
          workHoursEnd: pref.work_hours_end.slice(0, 5),
          workDays: Array.isArray(pref.work_days) ? [...pref.work_days] : [1, 2, 3, 4, 5],
          timezone,
        }
      }
      const stored = readNotificationChannels(pref?.notification_channels ?? null)

      const appRules = await loadRulesForUser(tx, recipient.userId, item.app)

      let threadMuted = false
      let threadArchived = false
      let threadNotifyAll = false
      if (item.threadId) {
        const rows = (await tx.execute(
          sql`SELECT is_muted, is_archived, notify_all_posts
                FROM ${K}.user_thread_state
              WHERE user_id = ${recipient.userId} AND thread_id = ${item.threadId}
                AND org_id = ${recipient.orgId}
              LIMIT 1`,
        )) as unknown as Array<{
          is_muted: boolean
          is_archived: boolean
          notify_all_posts: boolean
        }>
        threadMuted = rows[0]?.is_muted === true
        threadArchived = rows[0]?.is_archived === true
        threadNotifyAll = rows[0]?.notify_all_posts === true
      }

      const tokens = (await tx.execute(
        sql`SELECT 1 FROM ${K}.push_tokens
            WHERE user_id = ${recipient.userId} AND org_id = ${recipient.orgId}
            LIMIT 1`,
      )) as unknown as unknown[]

      const org = await orgNotificationFacts(tx, recipient.orgId, {
        onCallFor: groupOfItem(item) === "monitoring" ? recipient.userId : null,
      })

      const awayUntil = await readAwayUntil(
        tx,
        recipient,
        pref?.profile_timezone ?? null,
        org.timezone,
      )

      return {
        grid: stored.grid,
        mutedGroups: stored.mutedGroups,
        orgTimezone: org.timezone,
        orgTimezoneSet: org.timezoneSet,
        timezoneSet: stored.timezoneSet,
        profileTimezone: pref?.profile_timezone ?? null,
        defaultQuietHours: defaultQuietHoursOn(),
        ...(org.onCall !== undefined ? { onCall: org.onCall } : {}),
        ...(awayUntil ? { awayUntil } : {}),
        digestCadence: (pref?.digest_cadence ?? "daily") as RecipientContext["digestCadence"],
        workHours,
        workHoursExplicit: stored.workHoursExplicit,
        appRules,
        threadMuted,
        threadArchived,
        threadNotifyAll,
        hasPushDevice: tokens.length > 0,
      }
    },
  )
}

/**
 * The last day of the run of away days the recipient is in today, in their own zone, or null.
 * Read on the loader's transaction (a range of one person; no second privileged acquisition).
 * Unreadable means not away, so a failure can only make a notification arrive, never wait.
 */
async function readAwayUntil(
  tx: PrivilegedDb,
  recipient: RouterRecipient,
  profileTimezone: string | null,
  orgTimezone: string | null,
): Promise<string | null> {
  try {
    const rows = (await tx.execute(
      sql`SELECT starts_on::text AS starts_on, ends_on::text AS ends_on, weekdays, status,
                 ended_early_on::text AS ended_early_on
            FROM ${K}.away_ranges
           WHERE org_id = ${recipient.orgId}::uuid AND user_id = ${recipient.userId}::uuid
             AND status = 'active'
             AND starts_on <= (now() AT TIME ZONE 'UTC')::date + 1
             AND (ends_on IS NULL OR ends_on >= (now() AT TIME ZONE 'UTC')::date - 1)`,
    )) as unknown as Array<{
      starts_on: string
      ends_on: string | null
      weekdays: number[] | null
      status: AwayRangeDays["status"]
      ended_early_on: string | null
    }>
    if (rows.length === 0) return null
    return awayRunEnd(
      rows.map((r) => ({
        startsOn: r.starts_on,
        endsOn: r.ends_on,
        weekdays: r.weekdays,
        status: r.status,
        endedEarlyOn: r.ended_early_on,
      })),
      personLocalDate(new Date(), profileTimezone, orgTimezone),
    )
  } catch (err) {
    log.warn({ err, userId: recipient.userId }, "away days unreadable: notifying as if present")
    return null
  }
}
