// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the Stripe page shows, as plain data: which page the connection's state calls for, the
// attention groups, the trials, the MRR block and each state's next step. No Solid here, so every
// rule is tested without a screen. Urgency only orders rows; nothing here picks a loud colour.
import { tr } from "./i18n"

const DAY = 86_400_000

// ---- What the tools answer (the parts the page reads) ----

export interface HomeLoad {
  connection: {
    state: string
    base: string
    overlay: string | null
    mode?: string
    lastEventAt?: string | null
    lastEventType?: string | null
    connectedAt?: string | null
    /** The demo's stand-in install: no link out to the Stripe dashboard is rendered. */
    standIn?: boolean
  }
  sync: SyncView
  counts: Record<string, number> | null
  attention: unknown
  summary: string
}

export interface SyncView {
  importing: boolean
  partial: boolean
  missing: string[]
  resources: Array<{
    resource: string
    status: string
    done: number
    total: number | null
    error: string | null
  }>
}

export interface SubItem {
  id: string
  customerId: string
  status: string
  plan: string | null
  mrrMinor: number | null
  currency: string | null
  currentPeriodEnd?: string | null
  trialEnd: string | null
  cancelAt?: string | null
  pastDueSince: string | null
  card: { brand: string | null; last4: string | null; exp: string | null } | null
}

export interface InvoiceItem {
  id: string
  customerId: string
  subscriptionId: string | null
  status: string
  amountDueMinor: number | null
  currency: string | null
  nextPaymentAttempt: string | null
  number?: string | null
  totalMinor?: number | null
  issuer?: string | null
  liaisonDocumentId?: string | null
}

export interface DisputeItem {
  id: string
  paymentId: string
  amountMinor: number | null
  currency: string | null
  reason: string | null
  status: string | null
  evidenceDueBy: string | null
  at?: string | null
}

export interface ApprovalItem {
  id: string
  toolName?: string
  status?: string
  expiresAt?: string | null
  payloadHash?: string
  summary?: { title?: string; subtitle?: string; lines?: string[] }
}

export interface MrrLine {
  currency: string
  mrrMinor: number
  pastDueMinor: number
  activeCount: number
  byPlan: Array<{ plan: string; mrrMinor: number; count: number }>
  movements: {
    newMinor: number
    upgradeMinor: number
    downgradeMinor: number
    cancelledMinor: number
    netMinor: number
    startMinor: number
  }
  monthStart: string
}

export interface MrrResult {
  partial: boolean
  asOf: string | null
  rules: string[]
  lines: MrrLine[]
  movementsIncompleteBefore?: string
}

// ---- Formatting ----

const intlLocale = (locale: string) => (locale.startsWith("fr") ? "fr-FR" : "en")

/** Minor units in the currency's own exponent, never converted. */
export function formatMoney(minor: number, currency: string, locale: string): string {
  const cur = (currency || "eur").toUpperCase()
  try {
    const nf = new Intl.NumberFormat(intlLocale(locale), { style: "currency", currency: cur })
    return nf.format(minor / 10 ** (nf.resolvedOptions().maximumFractionDigits ?? 2))
  } catch {
    return `${(minor / 100).toFixed(2)} ${cur}`
  }
}

const signed = (minor: number, currency: string, locale: string) =>
  `${minor > 0 ? "+" : minor < 0 ? "-" : ""}${formatMoney(Math.abs(minor), currency, locale)}`

/** A clock time such as 09:08, in `tz` (the reader's zone when none is given). */
export function asOfLine(iso: string | null | undefined, locale: string, tz?: string): string {
  const t = iso ? new Date(iso) : null
  if (!t || Number.isNaN(t.getTime())) return ""
  return new Intl.DateTimeFormat(intlLocale(locale), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    ...(tz ? { timeZone: tz } : {}),
  }).format(t)
}

export function daysFromNow(iso: string | null | undefined, now: Date): number | null {
  const t = iso ? Date.parse(iso) : Number.NaN
  return Number.isNaN(t) ? null : Math.ceil((t - now.getTime()) / DAY)
}

export const daysLateLabel = (n: number) =>
  n === 1 ? tr("1 day late") : tr("{{n}} days late", { n })
export const daysLeftLabel = (n: number) =>
  n === 1 ? tr("1 day left") : tr("{{n}} days left", { n })
export const inDaysLabel = (n: number) =>
  n === 0 ? tr("today") : n === 1 ? tr("in 1 day") : tr("in {{n}} days", { n })

/** Whether the page may link out to the Stripe dashboard: never for the demo's stand-in install. */
export const dashboardShown = (load: HomeLoad | null | undefined): boolean =>
  load?.connection.standIn !== true

/** A page of the Stripe dashboard, in the mode of the key. */
export const dashboardUrl = (mode: string | undefined, path = "") =>
  `https://dashboard.stripe.com${mode === "live" ? "" : "/test"}${path}`

// ---- Which page ----

export type PageKind =
  | "not_connected"
  | "waiting"
  | "importing"
  | "empty"
  | "revoked"
  | "other_account"
  | "stalled"
  | "partial"
  | "home"

export function pageKind(load: HomeLoad | null): PageKind {
  if (!load || load.connection.base === "not_connected") return "not_connected"
  const { base, overlay } = load.connection
  if (overlay === "key_invalid") return "revoked"
  if (overlay === "different_account") return "other_account"
  if (base === "key_stored" || base === "waiting_first_event") return "waiting"
  if (base === "importing" || load.sync.importing) return "importing"
  if (overlay === "stalled") return "stalled"
  if (overlay === "partial" || load.sync.missing.length > 0) return "partial"
  const c = load.counts
  if (c && (c.customers ?? 0) === 0 && (c.subscriptions ?? 0) === 0) return "empty"
  return "home"
}

/** Whether a page's figures come from the mirror as it stood (nothing updates until a person acts). */
export const isFrozen = (k: PageKind) => k === "revoked" || k === "other_account"

export type DotTone = "success" | "warning" | "muted"
export function dotTone(k: PageKind): DotTone {
  if (k === "home") return "success"
  if (k === "revoked" || k === "stalled" || k === "partial" || k === "other_account")
    return "warning"
  return "muted"
}

/** The word beside the rail's dot, so its state is said and not only coloured. */
export function dotWord(k: PageKind): string {
  if (k === "not_connected") return tr("Not connected")
  if (k === "home") return tr("Connected")
  if (k === "waiting" || k === "importing" || k === "empty") return tr("Setting up")
  return tr("Needs a look")
}

/** What Approve does on this page: a revoked key holds it, with the reason beside it. */
export function approveState(k: PageKind): {
  enabled: boolean
  label: string
  hint: string | null
} {
  if (isFrozen(k)) return { enabled: false, label: tr("Held"), hint: tr("Waits for the key") }
  return { enabled: true, label: tr("Approve"), hint: null }
}

export function staleNotice(load: HomeLoad, locale: string, tz?: string): string {
  const at = asOfLine(load.connection.lastEventAt, locale, tz)
  return at
    ? tr("Showing what was read as of {{time}}. Nothing updates until the key works.", { time: at })
    : tr("Showing what was read before the key stopped working. Nothing updates until it works.")
}

// ---- The state cards ----

export type CardAction = {
  id: "check" | "settings" | "stripe_keys" | "stripe_webhooks" | "stripe" | "ask"
  label: string
  primary?: boolean
}
export interface StateCard {
  kind: PageKind
  title: string
  body: string
  steps: string[]
  note: string | null
  actions: CardAction[]
}

export function stateCard(
  load: HomeLoad | null,
  locale: string,
  now: Date,
  tz?: string,
): StateCard | null {
  const kind = pageKind(load)
  const test = load?.connection.mode !== "live"
  switch (kind) {
    case "not_connected":
      return {
        kind,
        title: tr("Stripe is not connected"),
        body: tr("Nothing has been read from Stripe and nothing has been changed."),
        steps: [
          tr(
            "An admin connects Stripe in Settings, Apps, Stripe, with a restricted key that starts with rk_.",
          ),
        ],
        note: null,
        actions: [{ id: "settings", label: tr("Connect Stripe"), primary: true }],
      }
    case "waiting":
      return {
        kind,
        title: tr("Key stored, waiting for Stripe's first update"),
        body: tr(
          "The key works. The import starts when Stripe sends its first update to this workspace.",
        ),
        steps: [
          tr("In Stripe, open Developers, Webhooks, and add the Liaison endpoint."),
          tr("Give the signing secret to the agent in its form."),
        ],
        note: null,
        actions: [
          { id: "stripe_webhooks", label: tr("Open webhooks in Stripe"), primary: true },
          { id: "check", label: tr("Check again") },
        ],
      }
    case "importing": {
      const view = importingView(load?.sync ?? EMPTY_SYNC)
      return {
        kind,
        title: tr("First import is running"),
        body: tr(
          "You have nothing to do, and you can close this page. Figures show once everything is read.",
        ),
        steps: [view.mrrLine],
        note: tr(
          "No routine runs on this data, and nothing goes to a customer until the import ends.",
        ),
        actions: [{ id: "check", label: tr("Check again") }],
      }
    }
    case "empty":
      return {
        kind,
        title: tr("Connected, and this account has no subscriptions"),
        body: tr("The key works and Stripe answers. It found no customers and no subscriptions."),
        steps: [
          ...(test
            ? [
                tr(
                  "Expected customers? This is a test key, and it only sees test data. Use a live key, rk_live_.",
                ),
              ]
            : []),
          tr(
            "Just starting? Nothing to do. The first subscription appears here within a minute of its creation.",
          ),
        ],
        note: null,
        actions: [
          { id: "settings", label: tr("Use another key"), primary: true },
          { id: "stripe", label: tr("Open Stripe") },
        ],
      }
    case "revoked":
      return {
        kind,
        title: tr("Stripe no longer accepts the key"),
        body: tr("Someone revoked or rolled it in Stripe. Nothing has been lost."),
        steps: [
          tr("In Stripe, create a new restricted key with the same permissions."),
          tr("Give it to the agent in its form. It checks the permissions again and catches up."),
        ],
        note: tr(
          "Until then refunds cannot run. Approvals waiting stay open, and you decide them once the key works.",
        ),
        actions: [
          { id: "settings", label: tr("Replace the key"), primary: true },
          { id: "stripe_keys", label: tr("Open API keys in Stripe") },
        ],
      }
    case "other_account":
      return {
        kind,
        title: tr("This key belongs to another Stripe account"),
        body: tr("Nothing was written, so the data already read is untouched."),
        steps: [
          tr(
            "Check which account and which mode the key belongs to, then replace it or run the check again.",
          ),
        ],
        note: tr("Until then refunds cannot run. Approvals waiting stay open."),
        actions: [
          { id: "check", label: tr("Check again"), primary: true },
          { id: "settings", label: tr("Replace the key") },
        ],
      }
    case "stalled": {
      const at = asOfLine(load?.connection.lastEventAt, locale, tz)
      const hours = load?.connection.lastEventAt
        ? Math.floor((now.getTime() - Date.parse(load.connection.lastEventAt)) / 3_600_000)
        : null
      return {
        kind,
        title: at
          ? tr("No update from Stripe since {{time}}", { time: at })
          : tr("No update from Stripe for a while"),
        body:
          hours !== null && hours >= 1
            ? tr(
                "That was over {{hours}} hours ago. Liaison usually gets an update every few minutes.",
                { hours },
              )
            : tr("Liaison usually gets an update every few minutes."),
        steps: [
          tr(
            "In Stripe, open Developers, Webhooks, then the Liaison endpoint. If it is disabled, enable it.",
          ),
          tr(
            "If it shows failures, the signing secret may have changed. Give the agent the new one.",
          ),
          tr(
            "Stripe resends missed updates for up to 72 hours, so fix this before then and nothing is lost.",
          ),
        ],
        note: tr("Until then Liaison checks Stripe itself every 15 minutes."),
        actions: [
          { id: "check", label: tr("Check again"), primary: true },
          { id: "stripe_webhooks", label: tr("Open webhooks in Stripe") },
        ],
      }
    }
    case "partial": {
      const missing = load?.sync.missing.join(", ") ?? ""
      return {
        kind,
        title: tr("The key cannot read {{what}}, the rest is fine", {
          what: missing || tr("everything it needs"),
        }),
        body: tr("Figures that do not need it still come through."),
        steps: [
          tr(
            "In Stripe, add Read on the missing resource to the same key. You do not need a new key.",
          ),
          tr("Then check again. The agent fills in what is missing."),
        ],
        note: null,
        actions: [
          { id: "check", label: tr("Check again"), primary: true },
          { id: "stripe_keys", label: tr("Open the key in Stripe") },
        ],
      }
    }
    default:
      return null
  }
}

const EMPTY_SYNC: SyncView = { importing: false, partial: false, missing: [], resources: [] }

// ---- Import progress ----

const RESOURCE_ORDER = [
  "customers",
  "subscriptions",
  "invoices",
  "payments",
  "charges",
  "refunds",
  "disputes",
]

const order = (r: string) => (RESOURCE_ORDER.includes(r) ? RESOURCE_ORDER.indexOf(r) : 99)

export function importingView(sync: SyncView) {
  const rows = [...sync.resources]
    .sort((a, b) => order(a.resource) - order(b.resource))
    .map((r) => ({
      resource: r.resource,
      status: r.status,
      done: r.done,
      total: r.total,
      percent:
        r.total && r.total > 0
          ? Math.min(100, Math.round((r.done / r.total) * 100))
          : r.status === "done"
            ? 100
            : 0,
    }))
  const subs = sync.resources.find((r) => r.resource === "subscriptions")
  const mrrLine =
    subs?.total && subs.total > 0
      ? tr("MRR shows once all {{n}} subscriptions are read.", { n: subs.total })
      : tr("MRR shows once every subscription is read.")
  return { rows, mrrLine }
}

// ---- Attention ----

export interface FailedRow {
  subscriptionId: string
  customerId: string
  plan: string | null
  mrrMinor: number
  currency: string
  daysLate: number
  amountDueMinor: number | null
  card: SubItem["card"]
}

export interface Attention {
  failed: FailedRow[]
  retrying: { count: number; mrrByCurrency: Record<string, number> }
  disputes: DisputeItem[]
  requests: ApprovalItem[]
  count: number
}

const MONEY_REQUESTS = new Set(["stripe:refunds_create", "stripe:subscription_cancel"])

/** True when the card is past its expiry month. */
export function cardExpired(
  card: { brand?: string | null; last4?: string | null; exp: string | null } | null | undefined,
  now: Date,
): boolean {
  const m = /^(\d{1,2})\/(\d{2}|\d{4})$/.exec(card?.exp ?? "")
  if (!m) return false
  const year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2])
  return year * 12 + Number(m[1]) - 1 < now.getUTCFullYear() * 12 + now.getUTCMonth()
}

export function buildAttention(input: {
  pastDue: SubItem[]
  openInvoices: InvoiceItem[]
  disputes: DisputeItem[]
  approvals: ApprovalItem[]
  now: Date
}): Attention {
  const { now } = input
  const retryBySub = new Set<string>()
  for (const inv of input.openInvoices) {
    const next = inv.nextPaymentAttempt ? Date.parse(inv.nextPaymentAttempt) : Number.NaN
    if (inv.subscriptionId && !Number.isNaN(next) && next > now.getTime())
      retryBySub.add(inv.subscriptionId)
  }
  const failed: FailedRow[] = []
  const retrying = { count: 0, mrrByCurrency: {} as Record<string, number> }
  for (const s of input.pastDue) {
    if (s.status !== "past_due") continue
    const currency = (s.currency ?? "eur").toLowerCase()
    // A retry on an expired card cannot succeed, so it is a failed payment to look at
    // (someone has to get a new card), never "in Stripe's retries".
    if (retryBySub.has(s.id) && !cardExpired(s.card, now)) {
      retrying.count++
      retrying.mrrByCurrency[currency] = (retrying.mrrByCurrency[currency] ?? 0) + (s.mrrMinor ?? 0)
      continue
    }
    const inv = input.openInvoices.find((i) => i.subscriptionId === s.id)
    failed.push({
      subscriptionId: s.id,
      customerId: s.customerId,
      plan: s.plan,
      mrrMinor: s.mrrMinor ?? 0,
      currency,
      daysLate: s.pastDueSince
        ? Math.max(0, Math.floor((now.getTime() - Date.parse(s.pastDueSince)) / DAY))
        : 0,
      amountDueMinor: inv?.amountDueMinor ?? null,
      card: s.card,
    })
  }
  // Urgency orders, nothing else: the longest overdue first.
  failed.sort((a, b) => b.daysLate - a.daysLate || a.subscriptionId.localeCompare(b.subscriptionId))
  const time = (iso: string | null) => (iso ? Date.parse(iso) : Number.POSITIVE_INFINITY)
  const disputes = input.disputes
    .filter((d) => d.status === "needs_response" || d.status === "warning_needs_response")
    .sort((a, b) => time(a.evidenceDueBy) - time(b.evidenceDueBy) || a.id.localeCompare(b.id))
  const requests = input.approvals.filter(
    (a) => a.status === "pending" && MONEY_REQUESTS.has(a.toolName ?? ""),
  )
  return {
    failed,
    retrying,
    disputes,
    requests,
    count: failed.length + disputes.length + requests.length,
  }
}

/** Only one of this app's pending money requests can be reviewed. */
export const canReview = (a: Attention, id: string) => a.requests.some((r) => r.id === id)

/** The open review after a click on Review: the same one closes, a non-approval opens nothing. */
export function toggleReview(a: Attention, open: string | null, id: string): string | null {
  if (!canReview(a, id)) return open
  return open === id ? null : id
}

// ---- Trials ----

export interface TrialRow {
  subscriptionId: string
  customerId: string
  plan: string | null
  endsAt: string
  days: number
  cardOnFile: boolean
}

export function trialsEnding(subs: SubItem[], now: Date, withinDays = 7): TrialRow[] {
  const rows: TrialRow[] = []
  for (const s of subs) {
    if (s.status !== "trialing" || !s.trialEnd) continue
    const days = daysFromNow(s.trialEnd, now)
    if (days === null || days < 0 || days > withinDays) continue
    rows.push({
      subscriptionId: s.id,
      customerId: s.customerId,
      plan: s.plan,
      endsAt: s.trialEnd,
      days,
      cardOnFile: s.card !== null,
    })
  }
  return rows.sort((a, b) => Date.parse(a.endsAt) - Date.parse(b.endsAt))
}

// ---- MRR ----

export function buildMrrView(mrr: MrrResult | null, locale: string) {
  if (!mrr || mrr.partial || mrr.lines.length === 0) return null
  const lines = mrr.lines.map((l) => {
    const cur = l.currency
    const m = l.movements
    const parts: Array<{ key: string; label: string; amount: string }> = []
    if (m.newMinor)
      parts.push({ key: "new", label: tr("new"), amount: signed(m.newMinor, cur, locale) })
    if (m.upgradeMinor)
      parts.push({
        key: "upgrade",
        label: tr("upgrade"),
        amount: signed(m.upgradeMinor, cur, locale),
      })
    if (m.downgradeMinor)
      parts.push({
        key: "downgrade",
        label: tr("downgrade"),
        amount: signed(m.downgradeMinor, cur, locale),
      })
    if (m.cancelledMinor)
      parts.push({
        key: "cancelled",
        label: tr("cancelled"),
        amount: signed(m.cancelledMinor, cur, locale),
      })
    const dir = m.netMinor > 0 ? tr("up") : m.netMinor < 0 ? tr("down") : tr("unchanged")
    return {
      currency: cur.toUpperCase(),
      total: formatMoney(l.mrrMinor, cur, locale),
      change: m.netMinor === 0 ? dir : `${dir} ${formatMoney(Math.abs(m.netMinor), cur, locale)}`,
      start: formatMoney(m.startMinor, cur, locale),
      monthStart: l.monthStart,
      paying: l.activeCount,
      plans: l.byPlan.map((p) => ({
        plan: p.plan,
        count: p.count,
        amount: formatMoney(p.mrrMinor, cur, locale),
      })),
      pastDue: l.pastDueMinor > 0 ? formatMoney(l.pastDueMinor, cur, locale) : null,
      movements: parts,
    }
  })
  return {
    lines,
    asOf: mrr.asOf,
    ruleLine: tr("Each currency is its own line and is never converted."),
    incomplete: mrr.movementsIncompleteBefore
      ? tr("Movements incomplete before {{date}}.", { date: mrr.movementsIncompleteBefore })
      : null,
  }
}
