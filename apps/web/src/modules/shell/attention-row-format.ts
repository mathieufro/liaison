// SPDX-License-Identifier: FSL-1.1-ALv2
// Format helpers for the attention feed row.
//
// Each item kind has a single stenographic metric phrase that does double
// duty: it tells you the metric (number + unit) AND the kind (one-word
// label) in one mono-typeset line. Reading "3d over" tells you both how
// many days are overdue AND that it's an overdue task — no separate
// label/badge required. Warm tones (`warning`) only on the truly urgent.

import type { AttentionItem, AttentionKind } from "@liaison/shared"
import {
  AtSign,
  Bell,
  CheckCircle2,
  CircleAlert,
  Clock,
  FileText,
  KeyRound,
  Lock,
  MessageSquare,
  OctagonAlert,
  Reply,
  Timer,
  UserMinus,
} from "lucide-solid"
import type { Component } from "solid-js"
import { guardDay } from "~/modules/approvals/send-guard-line"
import { catalogHasKey, englishT, type Translate } from "~/modules/i18n/i18n-context"
import { pluralFormFor } from "~/modules/projects/plural"
import { kindShortLabel } from "~/modules/shell/attention-groups"
import { localizeAgentNotice } from "~/modules/threads/agent-notice"

/**
 * What a formatter needs from the reader's locale. It is the translator plus
 * the locale tag, passed explicitly rather than pulled from the i18n context:
 * these are pure functions, called from group summaries and row meta lines
 * alike, and several of them run inside `createMemo`s that must re-run when
 * the language changes.
 *
 * Optional everywhere it is accepted. The attention feed always passes it;
 * the half-dozen other callers of `formatRelativeTime` (contacts, agent
 * activity, the thread sidebar) are not part of this surface and keep the
 * English default until they are localized in their own right.
 */
export interface RowLocale {
  t: (key: string, params?: Record<string, string | number | boolean>) => string
  locale: string
}

/**
 * Snapshot the i18n context into a `RowLocale`. Call it INSIDE the reactive
 * scope that renders the string (a JSX expression, a memo): reading
 * `i18n.locale()` here is what subscribes the caller to a language change, so
 * a hoisted constant would freeze the feed in whatever locale it first saw.
 */
export function rowLocaleFrom(i18n: {
  t: (key: string, params?: Record<string, string | number | boolean>) => string
  locale: () => string
}): RowLocale {
  return { t: i18n.t, locale: i18n.locale() }
}

export type MetricTone = "warning" | "tertiary" | "secondary"

export interface KindIcon {
  icon: Component<{ size?: number; class?: string }>
  /** Default tone for the icon when row is not hovered. */
  tone: "tertiary" | "warning"
}

export interface AttentionMetric {
  /** Mono-typeset metric phrase, e.g. "3d over" or "45m sla". */
  text: string
  tone: MetricTone
  /** Optional second-line label below the row (e.g. "Bug Tracker · 2h ago"). */
}

const KIND_ICON: Record<AttentionKind, KindIcon> = {
  task_overdue: { icon: Clock as unknown as Component, tone: "warning" },
  task_due_this_week: { icon: Clock as unknown as Component, tone: "tertiary" },
  task_blocked: { icon: OctagonAlert as unknown as Component, tone: "tertiary" },
  sla_risk: { icon: Timer as unknown as Component, tone: "warning" },
  awaiting_agent: { icon: MessageSquare as unknown as Component, tone: "tertiary" },
  unassigned: { icon: UserMinus as unknown as Component, tone: "tertiary" },
  followup_due: { icon: Bell as unknown as Component, tone: "tertiary" },
  nudge_due: { icon: Bell as unknown as Component, tone: "tertiary" },
  approval_pending: { icon: Lock as unknown as Component, tone: "tertiary" },
  admin_action: { icon: CircleAlert as unknown as Component, tone: "tertiary" },
  mention: { icon: AtSign as unknown as Component, tone: "tertiary" },
  thread_reply: { icon: Reply as unknown as Component, tone: "tertiary" },
  thread_followup: { icon: Reply as unknown as Component, tone: "tertiary" },
  approval_decision: { icon: CheckCircle2 as unknown as Component, tone: "tertiary" },
  system_alert: { icon: CircleAlert as unknown as Component, tone: "warning" },
  file_shared: { icon: FileText as unknown as Component, tone: "tertiary" },
  agent_notification: { icon: Bell as unknown as Component, tone: "tertiary" },
  dm_window_closing: { icon: Timer as unknown as Component, tone: "warning" },
  // An access request is a decision like any approval: a neutral key, never
  // a warning (calm UI: urgency only orders the list).
  scope_request: { icon: KeyRound as unknown as Component, tone: "tertiary" },
  scope_request_decided: { icon: CheckCircle2 as unknown as Component, tone: "tertiary" },
  routine_mailbox_wait: { icon: Lock as unknown as Component, tone: "tertiary" },
}

export function getKindIcon(kind: AttentionKind): KindIcon {
  return KIND_ICON[kind] ?? { icon: CircleAlert as unknown as Component, tone: "tertiary" }
}

/** The kernel is the platform itself, not one feature of it, so a bare
 *  "kernel" -> "Approvals" mapping mislabels everything else it emits: a
 *  gestalt walk found "Outbox worker fell behind - Approvals - 3h ago" and
 *  "Bob requests invoicing:approve - Approvals - 5h ago" sitting directly
 *  under the real Approvals card. Kernel rows take their source from the KIND. */
const KERNEL_SOURCE_LABEL: Record<string, string> = {
  approval_pending: "Approvals",
  approval_decision: "Approvals",
  routine_mailbox_wait: "Approvals",
  scope_request: "Access",
  scope_request_decided: "Access",
  system_alert: "System",
  admin_action: "System",
}

/** Source label -> catalog slug. The English label IS the slug's fallback, so
 *  an app with no catalog entry still reads exactly as it did. */
function sourceKey(label: string): string {
  return `kernel.homeSource.${label.toLowerCase()}`
}

/**
 * The source a row cites ("Tickets", "Team", "Knowledge"). It was derived by
 * capitalizing the app id, which no locale can reach: a French reader got a
 * translated item under an English source. The label now resolves through the
 * catalog, falling back to the capitalized id for a third party app that has
 * no entry.
 */
export function getAppLabel(app: string, kind?: string, i18n?: RowLocale): string {
  const english =
    app === "kernel"
      ? kind === undefined
        ? "Approvals"
        : (KERNEL_SOURCE_LABEL[kind] ?? "Team")
      : app.charAt(0).toUpperCase() + app.slice(1)
  if (!i18n) return english
  const key = sourceKey(english)
  const translated = i18n.t(key)
  return translated === key ? english : translated
}

/**
 * The reader's locale, or the shipped English catalog when a caller passes
 * none. The fallback resolves through the SAME catalog entries the French
 * reader gets, so an English literal can no longer drift away from its
 * translated twin: there is one source for the phrase and one for its
 * translation, never a hard-coded third.
 */
let englishRowLocale: RowLocale | undefined
function localeOr(i18n?: RowLocale): RowLocale {
  if (i18n) return i18n
  if (!englishRowLocale) {
    englishRowLocale = {
      locale: "en",
      t: (key, params) => {
        const full = key.startsWith("kernel.") ? key : `kernel.${key}`
        return catalogHasKey(full) ? englishT(full, params) : key
      },
    }
  }
  return englishRowLocale
}

/**
 * Compose the metric phrase for a row. Mono-typeset. Stenographic.
 *
 * Examples:
 *   "3d over"      — overdue task (warning)
 *   "in 4d"        — due this week (tertiary)
 *   "blocked"      — blocked task (tertiary)
 *   "45m sla"      — SLA imminent (warning)
 *   "2h waiting"   — awaiting agent (tertiary)
 *   "unassigned"   — open ticket (tertiary)
 *   "25m left"     — approval expiring soon (warning if <60m, else tertiary)
 *   "follow-up"    — followup due (tertiary)
 *   "nudge"        — nudge due (tertiary)
 */
export function getMetric(item: AttentionItem, i18n?: RowLocale): AttentionMetric {
  const m = (item.metadata ?? {}) as Record<string, unknown>
  const l = localeOr(i18n)
  const t = (key: string, params?: Record<string, string | number>) =>
    l.t(`kernel.homeMetric.${key}`, params)
  // A count only picks the word in the locales that inflect on it, so the
  // form comes from `pluralFormFor` (French takes the singular for 0 too),
  // never from `count === 1`.
  const counted = (key: string, count: number) =>
    t(`${key}.${pluralFormFor(l.locale, count)}`, { count })
  const duration = (seconds: number) => formatShortDuration(seconds, l)
  switch (item.kind) {
    case "task_overdue": {
      const days = typeof m.daysOver === "number" ? m.daysOver : 0
      if (days <= 0) return { text: t("dueToday"), tone: "warning" }
      return { text: counted("daysOver", days), tone: "warning" }
    }
    case "task_due_this_week": {
      const days = typeof m.daysRemaining === "number" ? m.daysRemaining : 0
      if (days <= 0) return { text: t("dueToday"), tone: "tertiary" }
      return { text: counted("inDays", days), tone: "tertiary" }
    }
    case "task_blocked":
      return { text: t("blocked"), tone: "tertiary" }
    case "sla_risk": {
      // No default-to-zero here: a missing slaSecondsLeft rendered a confident
      // "0s sla", which reads as "the SLA is already blown" on a row whose
      // whole point is that it is APPROACHING. A gestalt walk caught it on a
      // row with no metadata; stale or partial metadata from a provider would
      // lie the same way in prod. An absent figure states nothing instead
      // (AttentionRow hides the metric on empty text).
      if (typeof m.slaSecondsLeft !== "number") return { text: "", tone: "warning" }
      return { text: t("sla", { value: duration(m.slaSecondsLeft) }), tone: "warning" }
    }
    case "awaiting_agent": {
      const last = typeof m.lastInboundAt === "string" ? m.lastInboundAt : item.occurredAt
      const elapsed = secondsSince(last)
      return { text: t("waiting", { value: duration(elapsed) }), tone: "tertiary" }
    }
    case "unassigned":
      return { text: t("unassigned"), tone: "tertiary" }
    case "followup_due":
      return { text: t("followUp"), tone: "tertiary" }
    case "nudge_due":
      return { text: t("nudge"), tone: "tertiary" }
    case "approval_pending": {
      // No countdown on a wedged row (already approved, outcome unknown: the
      // expiry means nothing) nor on one whose deadline has passed and the
      // expiry job has not swept yet. Both printed a confident "0s left".
      if (m.wedged === true) return { text: "", tone: "warning" }
      // A draft the send check stopped is not waiting on anyone: nothing runs out on it. A held
      // one waits for its hold, so its date is the one the row gives, never the expiry.
      if (m.uncounted === true) return { text: "", tone: "tertiary" }
      const guard = m.sendGuard as { state?: unknown; holdUntil?: unknown } | undefined
      if (guard?.state === "held") {
        return typeof guard.holdUntil === "string"
          ? {
              text: l.t("kernel.approvalsUi.sendGuard.holdDate", {
                until: guardDay(guard.holdUntil, l.locale),
              }),
              tone: "tertiary",
            }
          : { text: "", tone: "tertiary" }
      }
      if (typeof m.expiresInSeconds === "number" && m.expiresInSeconds <= 0) {
        return { text: "", tone: "warning" }
      }
      const left = typeof m.expiresInSeconds === "number" ? m.expiresInSeconds : 3600
      const tone: MetricTone = left <= 3600 ? "warning" : "tertiary"
      return { text: formatExpiresIn(left, l), tone }
    }
    case "admin_action":
      return { text: t("admin"), tone: "tertiary" }
    case "dm_window_closing": {
      // Time left in the platform's reply window before it closes (after which
      // only the customer can reopen the conversation). Warm tone: acting now
      // is the only way to keep replying via the API.
      const left = typeof m.windowSecondsLeft === "number" ? m.windowSecondsLeft : 0
      return { text: t("toClose", { value: duration(left) }), tone: "warning" }
    }
    default:
      return { text: "", tone: "tertiary" }
  }
}

/**
 * Compact relative-time formatter. "just now", "5m ago", "2h ago", "3d ago"
 * in English; "à l'instant", "il y a 5 min", "il y a 2 h" in French.
 *
 * The English strings used to be built by hand, so the whole feed said
 * "5h ago" and "MIS À JOUR JUST NOW" to a French reader. The figure now goes
 * through `Intl.RelativeTimeFormat` in the reader's locale, which owns every
 * language's phrasing; only "just now" is a catalog string, because zero
 * elapsed units has no relative-time phrase of its own.
 */
export function formatRelativeTime(
  iso: string,
  opts: { now?: Date; i18n?: RowLocale } = {},
): string {
  const now = opts.now ?? new Date()
  const locale = opts.i18n?.locale ?? "en"
  const elapsed = Math.max(0, (now.getTime() - new Date(iso).getTime()) / 1000)
  if (elapsed < 60) return opts.i18n ? opts.i18n.t("kernel.homeTimeJustNow") : "just now"
  if (elapsed < 3600) return relative(locale, -Math.floor(elapsed / 60), "minute")
  if (elapsed < 86_400) return relative(locale, -Math.floor(elapsed / 3600), "hour")
  if (elapsed < 86_400 * 7) return relative(locale, -Math.floor(elapsed / 86_400), "day")
  return relative(locale, -Math.floor(elapsed / 86_400 / 7), "week")
}

/**
 * One relative-time phrase, as narrow as the locale can say it and still be a
 * phrase. English narrow is exactly the compact form this feed has always
 * used ("5h ago"); French narrow is `-5 h`, a signed quantity with no phrase
 * at all, which reads as minus five hours rather than as an age. A narrow form
 * carrying a minus sign is therefore taken as unphrased and the short form
 * ("il y a 5 h") is used instead.
 */
function relative(locale: string, value: number, unit: Intl.RelativeTimeFormatUnit): string {
  const narrow = new Intl.RelativeTimeFormat(locale, {
    numeric: "always",
    style: "narrow",
  }).format(value, unit)
  if (!narrow.includes("-") && !narrow.includes("\u2212")) return narrow
  return new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" }).format(
    value,
    unit,
  )
}

/** Compose the second-line meta: "App · Context · 2h ago". The optional
 * context segment is the parent name (project, ticket inbox, knowledge
 * collection) so rows with identical summaries stay disambiguated. */
export function formatMetaLine(item: AttentionItem, i18n?: RowLocale, now?: Date): string {
  const m = (item.metadata ?? {}) as Record<string, unknown>
  const context =
    typeof m.projectName === "string"
      ? m.projectName
      : typeof m.inboxName === "string"
        ? m.inboxName
        : typeof m.collectionName === "string"
          ? m.collectionName
          : null
  const time = formatRelativeTime(item.occurredAt, { now, i18n })
  // Kinds merged away by the aggregator's per-entity dedupe still deserve a
  // trace ("also unassigned") so the row explains the whole state of the thing.
  const also =
    item.alsoKinds && item.alsoKinds.length > 0
      ? ` · ${i18n ? i18n.t("kernel.homeAlso") : "also"} ${item.alsoKinds
          .map((k) => kindShortLabel(k, i18n))
          .join(", ")}`
      : ""
  const source = getAppLabel(item.app, item.kind, i18n)
  if (context) return `${source} · ${context} · ${time}${also}`
  return `${source} · ${time}${also}`
}

/**
 * Compact duration: 45s, 12m, 3h, 5d in English, 45 min, 3 h, 5 j in French.
 * Tuned for sub-day spans common in SLA / waiting / expiry contexts, so the
 * unit stays an abbreviation in every locale: the chip is one mono line on a
 * row that already carries a summary.
 */
export function formatShortDuration(seconds: number, i18n?: RowLocale): string {
  const l = localeOr(i18n)
  const unit = (key: string, count: number) => l.t(`kernel.homeDuration.${key}`, { count })
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return unit("seconds", s)
  if (s < 3600) return unit("minutes", Math.round(s / 60))
  if (s < 86_400) return unit("hours", Math.round(s / 3600))
  return unit("days", Math.round(s / 86_400))
}

/**
 * THE one way the product says how long is left, wherever it says it.
 *
 * The feed row said "3d left" and the expanded approval card said
 * "4123 min left" about the same deadline, because the card had a
 * minutes-only catalog string of its own. Both read this now, so they cannot
 * disagree again.
 */
export function formatTimeLeft(seconds: number, i18n?: RowLocale): string {
  return localeOr(i18n).t("kernel.homeMetric.left", {
    value: formatShortDuration(seconds, i18n),
  })
}

/**
 * When a pending approval lapses, in words: "Expires in 7 days". "7d left" did not say what
 * runs out (cold walk, 2026-11-08), so every approval deadline says it expires, the row as the
 * card. Rounded to the largest unit, as `formatShortDuration`.
 */
export function formatExpiresIn(seconds: number, i18n?: RowLocale): string {
  const l = localeOr(i18n)
  const s = Math.max(0, Math.round(seconds))
  const [unit, count] =
    s < 60
      ? (["seconds", s] as const)
      : s < 3600
        ? (["minutes", Math.round(s / 60)] as const)
        : s < 86_400
          ? (["hours", Math.round(s / 3600)] as const)
          : (["days", Math.round(s / 86_400)] as const)
  return l.t(`kernel.homeMetric.expiresIn.${unit}.${pluralFormFor(l.locale, count)}`, { count })
}

function secondsSince(iso: string): number {
  return Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
}

// Suppress unused-import warning for the type re-export.

/**
 * A KERNEL attention row's title in the reader's language. The kernel's translations write
 * these summaries once, in English, from fixed templates (attention/kernel-translations.ts):
 * "Scope request denied" and "<name> mentioned you" reached the French Home as written
 * (third QA walk). Each known template is matched and rebuilt from the catalog, keeping the
 * names it carries; a reply row quoting an agent's failure line is rendered from its code;
 * anything else is shown as written.
 */
export function kernelAttentionTitle(
  item: { app: string; kind: string; summary: string; metadata?: Record<string, unknown> | null },
  t: Translate,
): string {
  const s = item.summary
  if (item.app !== "kernel") return s
  let m: RegExpExecArray | null
  switch (item.kind) {
    case "kernel:away.recap":
      return t("kernel.homeRouting.recapTitle")
    case "scope_request_decided":
      m = /^Scope request (approved|denied)$/.exec(s)
      return m ? t(`kernel.attentionTitle.scopeRequestDecided.${m[1]}`) : s
    case "mention":
      m = /^(.+) mentioned you$/.exec(s)
      return m ? t("kernel.attentionTitle.mentionedYou", { name: m[1] ?? "" }) : s
    case "file_shared":
      m = /^(.+) added a file to (.+)$/.exec(s)
      return m ? t("kernel.attentionTitle.fileShared", { name: m[1] ?? "", label: m[2] ?? "" }) : s
    case "scope_request":
      m = /^(.+) requested access: (.+)$/.exec(s)
      return m
        ? t("kernel.attentionTitle.requestedAccess", { name: m[1] ?? "", title: m[2] ?? "" })
        : s
    case "approval_decision":
      m = /^Approval (\S+) (approved|rejected)$/.exec(s)
      return m ? t(`kernel.attentionTitle.approvalDecided.${m[2]}`, { handle: m[1] ?? "" }) : s
    case "thread_reply":
    case "thread_followup":
      return localizeAgentNotice(s, t)
    case "agent_notification": {
      // The person's own calendar made, moved or asks about an away range: dates, next in
      // line, and for a question the event's title, read live by the feed and never stored.
      const cal = item.metadata?.awayCalendar as
        | { kind?: string; said?: string; nextInLine?: string | null; title?: string }
        | undefined
      if (cal?.said && (cal.kind === "set" || cal.kind === "moved" || cal.kind === "asked")) {
        const next = cal.nextInLine
          ? t("kernel.attentionTitle.awayCalendar.next", { name: cal.nextInLine })
          : t("kernel.attentionTitle.awayCalendar.nobody")
        if (cal.kind === "asked")
          return cal.title
            ? t("kernel.attentionTitle.awayCalendar.asked", { title: cal.title, dates: cal.said })
            : t("kernel.attentionTitle.awayCalendar.askedNoTitle", { dates: cal.said })
        return t(`kernel.attentionTitle.awayCalendar.${cal.kind}`, { dates: cal.said, next })
      }
      // A request waiting a day (approvals/routed-reminders.ts): the row carries `routedReminder`.
      m = item.metadata?.routedReminder
        ? /^Waiting more than (\d+) hours for a decision: (.+)$/s.exec(s)
        : null
      if (m)
        return t("kernel.attentionTitle.routedReminder", { hours: m[1] ?? "", title: m[2] ?? "" })
      // Someone marked this person away (modules/users/away.ts): the row carries `awayNamed`.
      m = item.metadata?.awayNamed ? /^(.+) marked you away (.+)$/.exec(s) : null
      return m ? t("kernel.attentionTitle.awayNamed", { name: m[1] ?? "", dates: m[2] ?? "" }) : s
    }
    default:
      return s
  }
}

/** The most of a session notice's own words a row shows (the server bounds them at 300). */
const SESSION_NOTICE_MAX = 400

/**
 * S16: a computer session notice's own words: `metadata.body` (the in-app
 * feed's body, node-session-notify.ts) without its first line when that line
 * is the row's fixed line, on one line, at most SESSION_NOTICE_MAX code
 * points. Null for any other row, or a body with nothing more to say.
 */
export function sessionNoticeWords(item: {
  app: string
  entity: string
  summary: string
  metadata?: Record<string, unknown> | null
}): string | null {
  if (item.app !== "kernel" || item.entity !== "node_session") return null
  const body = item.metadata?.body
  if (typeof body !== "string") return null
  const lines = body.split("\n")
  if (lines[0] === item.summary) lines.shift()
  const text = lines.join(" ").replace(/\s+/g, " ").trim()
  if (!text) return null
  return Array.from(text).slice(0, SESSION_NOTICE_MAX).join("")
}
