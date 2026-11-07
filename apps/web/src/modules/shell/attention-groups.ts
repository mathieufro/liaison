// SPDX-License-Identifier: FSL-1.1-ALv2
// Pure feed-shaping logic for Home: split the aggregated attention items into
// a short "needs you now" list and calm, collapsible category groups.
//
// The split rule: an item is NOW when it demands an individual decision or is
// genuinely urgent — approvals, scope requests, mentions, direct notifications,
// SLA fires, or anything the provider scored >= 70. Everything else is volume
// work (ticket queues, order digests, stale nudges) and reads better as a
// grouped ledger than as a wall of rows.

import { type AttentionItem, NOW_URGENCY } from "@liaison/shared"
import { getAttentionGroupLabel } from "~/framework/app-registry"
import { tNow } from "~/modules/i18n/i18n-context"
import { pluralFormFor } from "~/modules/projects/plural"
import type { RowLocale } from "~/modules/shell/attention-row-format"

/** Kinds that always surface individually, regardless of urgency score. */
const NOW_KINDS = new Set<string>([
  "approval_pending",
  "scope_request",
  "scope_request_decided",
  "approval_decision",
  "mention",
  "sla_risk",
  "system_alert",
  "admin_action",
  "dm_window_closing",
  "awaiting_agent",
  "routine_mailbox_wait",
])

// agent_notification is deliberately NOT a NOW kind: most of these are
// informational ("Routine X finished running", "Routine X run failed") and
// belong in the collapsible Notifications group below, not in "needs you now".
// Genuinely urgent ones still surface individually via the >= NOW_URGENCY
// score rule (notify_user / routine emitters set urgency per item).

// --- Card redesign (liaison-messaging-visibility, Task 8) ---
// Two of the NOW_KINDS now render in their own Home cards (Approvals,
// Messages) instead of the flat "needs you now" strip. The strip must not
// double-render them: it shows only the NOW items that are NOT carded.
// An access request and a routine run waiting for its owner's mailbox are
// items of the approvals list (approval-facets.ts `isApprovalItem`), so they
// are carded there too, never in the alerts.
const CARDED_NOW_KINDS = new Set<string>([
  "approval_pending",
  "mention",
  "routine_mailbox_wait",
  "scope_request",
])

/**
 * NOW items minus the kinds carded elsewhere on Home (Approvals, Messages,
 * Mail). sla_risk / system_alert / admin_action / etc. keep
 * surfacing individually here exactly as before the card redesign — nothing
 * urgent is ever demoted into a collapsible group by this filter.
 *
 * `app === "mail"` is excluded the same way `isCardedElsewhereInActivity`
 * excludes it from Activity groups below: the Mail card renders every
 * `attentionStore.items` entry with `app === "mail"`, including ones that
 * `splitFeed` routes into `now` (NOW_KINDS or urgency >= 70) — without this,
 * such an item would double-render as both a strip row and a Mail-card row.
 */
export function urgentStripItems(nowItems: AttentionItem[]): AttentionItem[] {
  return nowItems.filter((item) => !CARDED_NOW_KINDS.has(item.kind) && item.app !== "mail")
}

// thread_reply is never a NOW kind (urgency 30 < NOW_URGENCY), so it always
// landed in the grouped ledger before this redesign. It is now carded by the
// Messages card (thread-store driven), so it must be excluded from Activity
// groups too — otherwise every unread thread would double-render once as a
// Messages-card row and again as an Activity "replies" group item. Every
// `app === "mail"` item is likewise carded by the Mail card and excluded
// from Activity for the same reason.
function isCardedElsewhereInActivity(item: AttentionItem): boolean {
  return item.kind === "thread_reply" || item.app === "mail"
}

/** Groups at or under this many items render expanded by default. */
export const GROUP_AUTO_EXPAND_MAX = 5

export interface AttentionGroup {
  /** The item app — mark-read group calls are keyed by app (+ kinds). */
  app: string
  /** Unique section key for rendering/testids — the app, or `<app>::notifications`
   *  for the split-out informational notifications group. */
  key: string
  label: string
  /** Catalog key for the label a READER sees (`kernel.homeGroup*`). */
  labelKey?: string
  items: AttentionItem[]
  /** Distinct kinds present, ordered by frequency desc, with counts. */
  kindCounts: Array<{ kind: string; count: number }>
  /** Highest urgency inside the group — drives group ordering. */
  maxUrgency: number
  /** True when every item is a persisted attention event (bulk mark-read works). */
  markable: boolean
}

export interface SplitFeed {
  now: AttentionItem[]
  groups: AttentionGroup[]
  /** Total item count across now + groups (the honest headline number). */
  total: number
}

export function isNowItem(item: AttentionItem): boolean {
  return NOW_KINDS.has(item.kind) || item.urgency >= NOW_URGENCY
}

/** Catalog key for an app's group label, or undefined for an app that declares none. */
export function groupLabelKeyForApp(app: string): string | undefined {
  return getAttentionGroupLabel(app)?.labelKey
}

/**
 * The group label a reader sees. `t` resolves the catalog key; a key the
 * catalog does not carry falls back to the stored English label, the same
 * contract `registryLabel` uses for app-supplied nav labels.
 */
export function groupLabel(t: (key: string) => string, group: AttentionGroup): string {
  if (!group.labelKey) return group.label
  const translated = t(group.labelKey)
  return translated === group.labelKey ? group.label : translated
}

/** The group heading an app's manifest declares; an app that declares none
 *  gets its capitalised name. */
export function groupLabelForApp(app: string): string {
  const declared = getAttentionGroupLabel(app)?.label
  if (declared) return declared
  return app.length > 0 ? app.charAt(0).toUpperCase() + app.slice(1) : app
}

/**
 * Short human label for a kind, used in group summaries ("52 awaiting reply").
 * Manifest kinds ("shopify:orders.unfulfilled") fall back to the last segment
 * with separators spaced out ("unfulfilled").
 */
/** The bare kind a catalog entry is keyed by: a manifest kind arrives as
 *  `<app>:<thing>.<state>`, and only its last segment names the thing. */
function bareKind(kind: string): string {
  const tail = kind.includes(":") ? kind.slice(kind.indexOf(":") + 1) : kind
  return tail.includes(".") ? tail.slice(tail.lastIndexOf(".") + 1) : tail
}

/** The catalog phrase for a kind, or undefined when it carries none (a third
 *  party manifest kind, which no shipped locale can know about). */
function catalogKindLabel(
  kind: string,
  form: "one" | "other",
  i18n: RowLocale,
): string | undefined {
  const key = `kernel.homeKind.${bareKind(kind)}.${form}`
  const translated = i18n.t(key)
  return translated === key ? undefined : translated
}

export function kindShortLabel(kind: string, i18n?: RowLocale): string {
  if (i18n) {
    const translated = catalogKindLabel(kind, "other", i18n)
    if (translated !== undefined) return translated
  }
  const known: Record<string, string> = {
    awaiting_agent: "awaiting reply",
    unassigned: "unassigned",
    nudge_due: "stale, nudge due",
    followup_due: "follow-up due",
    sla_risk: "SLA risk",
    task_overdue: "overdue",
    task_due_this_week: "due this week",
    task_blocked: "blocked",
    thread_reply: "replies",
    thread_followup: "replies in threads you follow",
    file_shared: "files shared",
    mention: "mentions",
    agent_notification: "notifications",
  }
  if (known[kind]) return known[kind]!
  return bareKind(kind).replace(/_/g, " ")
}

// Singular counterpart for kinds whose short label is a plural noun. Only the
// count-bearing kinds need this; state phrases ("awaiting reply", "unassigned",
// "overdue", "SLA risk") already read the same for one or many, so they are
// absent here and fall through to the shared label.
const KIND_SINGULAR_LABEL: Record<string, string> = {
  thread_reply: "reply",
  thread_followup: "reply in a thread you follow",
  file_shared: "file shared",
  mention: "mention",
  agent_notification: "notification",
}

/**
 * Count + short label with correct grammatical number: "1 reply", "3 replies".
 * Used by the Home group summary so a single item never reads "1 replies".
 * Falls back to the plural/shared label when a kind has no distinct singular.
 */
export function kindCountLabel(kind: string, count: number, i18n?: RowLocale): string {
  if (i18n) {
    // `count === 1` is an English rule. French takes the singular for 0 as
    // well, so the section line read "0 bloqués" under the old test.
    const form = pluralFormFor(i18n.locale, count)
    const translated = catalogKindLabel(kind, form, i18n)
    if (translated !== undefined) return `${count} ${translated}`
  }
  const label =
    count === 1 ? (KIND_SINGULAR_LABEL[kind] ?? kindShortLabel(kind)) : kindShortLabel(kind)
  return `${count} ${label}`
}

export interface SplitFeedOptions {
  /** Overrides `isNowItem` (D21: Home files a ticket awaiting a reply as
   *  queue volume, so it lands in its app's group, not in `now`). */
  isNow?: (item: AttentionItem) => boolean
}

export function splitFeed(items: AttentionItem[], opts: SplitFeedOptions = {}): SplitFeed {
  const isNow = opts.isNow ?? isNowItem
  const now: AttentionItem[] = []
  const byKey = new Map<string, AttentionItem[]>()
  for (const item of items) {
    if (isNow(item)) {
      now.push(item)
      continue
    }
    if (isCardedElsewhereInActivity(item)) continue
    // Informational agent notifications get their own section instead of
    // blending into the app's work queue — they are FYIs, not work items.
    const key = item.kind === "agent_notification" ? `${item.app}::notifications` : item.app
    const bucket = byKey.get(key)
    if (bucket) bucket.push(item)
    else byKey.set(key, [item])
  }

  const groups: AttentionGroup[] = []
  for (const [key, groupItems] of byKey.entries()) {
    const isNotifications = key.endsWith("::notifications")
    const app = isNotifications ? key.slice(0, key.indexOf("::")) : key
    const counts = new Map<string, number>()
    let maxUrgency = 0
    let markable = true
    for (const item of groupItems) {
      counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1)
      if (item.urgency > maxUrgency) maxUrgency = item.urgency
      if (!item.persisted) markable = false
    }
    const kindCounts = [...counts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count)
    groups.push({
      app,
      key,
      label: isNotifications ? tNow("kernel.shellUi.notifications") : groupLabelForApp(app),
      labelKey: isNotifications ? "kernel.homeGroupNotifications" : groupLabelKeyForApp(app),
      items: groupItems,
      kindCounts,
      maxUrgency,
      markable,
    })
  }
  // Notifications sections always sink below work-item groups — they are the
  // "read when you get to it" ledger, whatever their urgency scores say.
  const rank = (g: AttentionGroup): number => (g.key.endsWith("::notifications") ? 1 : 0)
  groups.sort(
    (a, b) => rank(a) - rank(b) || b.maxUrgency - a.maxUrgency || b.items.length - a.items.length,
  )

  return { now, groups, total: items.length }
}

// --- Alert clustering (2026-09-11) ---
//
// The urgent strip rendered one row per item with no cap. A support inbox
// breaching SLA emits one `sla_risk` item per ticket, so a normal Tuesday put
// 24 near-identical "SLA approaching for ticket-N" rows at the top of Home and
// pushed the Approvals card entirely below the fold — the operator never saw
// that three requests were waiting on their decision, and concluded the
// platform was broken. Identical kinds now collapse into ONE row carrying the
// count, expandable to the individual items.
//
// Clustering is by (app, kind): two `sla_risk` items from different apps are
// different alerts, and a lone item is left EXACTLY as it was — a single
// "SLA approaching for ticket-10431" row still reads better than
// "1 ticket approaching SLA" wrapped around the same thing.

export interface AlertCluster {
  /** `<app>::<kind>` — stable across refetches, used for testids + expansion state. */
  key: string
  app: string
  kind: string
  items: AttentionItem[]
  /** Highest urgency inside the cluster, so the summary row can take its tone. */
  maxUrgency: number
}

export type AlertEntry =
  | { type: "item"; key: string; item: AttentionItem }
  | { type: "cluster"; key: string; cluster: AlertCluster }

/** Plural phrasing for a clustered alert kind. Count is prepended by
 *  `alertClusterLabel`, so these read as "<n> tickets approaching SLA". */
const CLUSTER_PLURAL_LABEL: Record<string, string> = {
  sla_risk: "tickets approaching SLA",
  system_alert: "system alerts",
  scope_request: "scope requests",
  scope_request_decided: "scope decisions",
  approval_decision: "approval decisions",
  admin_action: "admin actions",
  awaiting_agent: "conversations awaiting a reply",
  dm_window_closing: "DM windows closing",
}

/** "12 tickets approaching SLA". Falls back to the group-summary phrasing for
 *  kinds with no dedicated plural (manifest kinds included). */
export function alertClusterLabel(kind: string, count: number, i18n?: RowLocale): string {
  if (i18n) {
    const key = `kernel.homeCluster.${bareKind(kind)}`
    const translated = i18n.t(key)
    if (translated !== key) return `${count} ${translated}`
  }
  const plural = CLUSTER_PLURAL_LABEL[kind]
  return plural ? `${count} ${plural}` : kindCountLabel(kind, count, i18n)
}

// --- Time-limited items (P6-fix9, 2026-10-08) ---
//
// A node chat's permission prompt is denied automatically after 10 minutes.
// It arrives as a kernel `agent_notification` at urgency 80, so it clustered
// with any other urgent agent notification ("Routine X run failed") into one
// collapsed "2 notifications" row: the owner had to know to open a disclosure
// before a 10-minute clock ran out. A decision that expires soon is never
// bundled, and it takes the top slot.

/** Items expiring sooner than this are never clustered. */
export const TIME_LIMITED_WINDOW_MS = 60 * 60_000

/** When the item stops being actionable: a node prompt's expiry, or a generic
 *  `metadata.expiresAt`. Null when the row carries none. */
export function itemExpiresAt(item: AttentionItem): number | null {
  const node = item.metadata?.nodePermission as Record<string, unknown> | undefined
  const raw = node?.expiresAt ?? item.metadata?.expiresAt
  if (typeof raw !== "string") return null
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : null
}

/** True for a node permission prompt (always time-limited, even when its row
 *  lost the expiry) and for anything expiring within the hour. */
export function isTimeLimited(item: AttentionItem, nowMs: number = Date.now()): boolean {
  if (item.metadata?.nodePermission || item.metadata?.nodePermissionPromptId) return true
  const expiresAt = itemExpiresAt(item)
  return expiresAt !== null && expiresAt - nowMs < TIME_LIMITED_WINDOW_MS
}

/**
 * Home shows ONE "needs your OK" row per conversation: a node chat's newest
 * undecided permission prompt. The older ones of the same chat are answered
 * in the chat itself (its cards), never as a pile of identical rows here.
 */
export function newestPromptPerChat(items: AttentionItem[]): AttentionItem[] {
  const newest = new Map<string, AttentionItem>()
  for (const item of items) {
    if (!item.metadata?.nodePermission && !item.metadata?.nodePermissionPromptId) continue
    const link = item.metadata?.link as { entityId?: unknown } | undefined
    const chat = typeof link?.entityId === "string" ? link.entityId : null
    if (!chat) continue
    const kept = newest.get(chat)
    if (!kept || kept.occurredAt < item.occurredAt) newest.set(chat, item)
  }
  return items.filter((item) => {
    if (!item.metadata?.nodePermission && !item.metadata?.nodePermissionPromptId) return true
    const link = item.metadata?.link as { entityId?: unknown } | undefined
    const chat = typeof link?.entityId === "string" ? link.entityId : null
    return !chat || newest.get(chat) === item
  })
}

/**
 * Collapse an ordered alert list into rows: a run of 2+ items sharing an
 * (app, kind) becomes one cluster, anything alone stays a plain item. Input
 * order is preserved by first occurrence, so the most urgent alert keeps the
 * top slot whether or not it clustered. Time-limited items (isTimeLimited)
 * never cluster and come first, soonest expiry on top.
 */
export function clusterAlerts(all: AttentionItem[], nowMs: number = Date.now()): AlertEntry[] {
  const items = newestPromptPerChat(all)
  const timeLimited = items
    .filter((item) => isTimeLimited(item, nowMs))
    .sort(
      (a, b) =>
        (itemExpiresAt(a) ?? Number.POSITIVE_INFINITY) -
        (itemExpiresAt(b) ?? Number.POSITIVE_INFINITY),
    )
  const pinned: AlertEntry[] = timeLimited.map((item) => ({
    type: "item" as const,
    key: item.id,
    item,
  }))
  const order: string[] = []
  const byKey = new Map<string, AttentionItem[]>()
  for (const item of items) {
    if (isTimeLimited(item, nowMs)) continue
    const key = `${item.app}::${item.kind}`
    const bucket = byKey.get(key)
    if (bucket) bucket.push(item)
    else {
      byKey.set(key, [item])
      order.push(key)
    }
  }
  const rest = order.map((key): AlertEntry => {
    const bucket = byKey.get(key) ?? []
    const first = bucket[0]!
    if (bucket.length === 1) return { type: "item" as const, key: first.id, item: first }
    return {
      type: "cluster" as const,
      key,
      cluster: {
        key,
        app: first.app,
        kind: first.kind,
        items: bucket,
        maxUrgency: bucket.reduce((max, i) => (i.urgency > max ? i.urgency : max), 0),
      },
    }
  })
  return [...pinned, ...rest]
}
