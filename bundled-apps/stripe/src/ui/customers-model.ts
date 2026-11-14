// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the customers list and the customer page show, decided without a screen: which read answers a
// search, the chips and their counts, the plan totals (the query's own, never summed from the page),
// the rows ordered problems first, the company suggestion (never for a personal address), the invoice
// and dispute lines, and the one sentence a request in the discussion carries. The components draw this.

import { isConsumerMailDomain } from "../consumer-domains"
import { emailDomain } from "../match"
import {
  type DisputeItem,
  formatMoney,
  type InvoiceItem,
  type MrrResult,
  type SubItem,
} from "./home-model"
import { tr } from "./i18n"

export interface CustomerItem {
  id: string
  rowId: string | null
  name: string | null
  email: string | null
  currency: string | null
  delinquent: boolean
  deleted: boolean
  companyId: string | null
  contactId: string | null
  linkedBy: string | null
}

export interface PaymentItem {
  id: string
  customerId: string | null
  invoiceId: string | null
  amountMinor: number | null
  refundedMinor: number | null
  currency: string | null
  status: string
  failureCode: string | null
  disputed: boolean
  at: string | null
  card: Card | null
}

export interface Card {
  brand: string | null
  last4: string | null
  exp: string | null
}

export interface Suggestion {
  companyId: string
  name: string
  domain: string
}

// ---- Which read answers the list ----

export type Chip = "all" | "subscriptions" | "unlinked" | "past_due" | "trial" | "cancelled"
export const CHIPS: Chip[] = ["all", "subscriptions", "unlinked", "past_due", "trial", "cancelled"]
export const PAGE_SIZE = 25

/**
 * The read for a search and a chip. A name, an email and a Stripe id all go to the mirror as typed
 * (the tool tells them apart); the Subscriptions chip is a state of the same list, so it asks the same
 * read and keeps the customers that hold a live subscription.
 */
export function listRequest(query: string, chip: Chip, cursor?: string | null) {
  const args: Record<string, unknown> = { limit: PAGE_SIZE }
  const q = query.trim()
  if (q) args.query = q
  if (chip === "unlinked" || chip === "past_due" || chip === "trial" || chip === "cancelled")
    args.filter = chip
  if (cursor) args.cursor = cursor
  return { tool: "customers_search" as const, args, liveOnly: chip === "subscriptions" }
}

const LIVE = new Set(["active", "trialing", "past_due", "unpaid", "paused"])

export function chipLabel(chip: Chip): string {
  switch (chip) {
    case "all":
      return tr("All")
    case "subscriptions":
      return tr("Subscriptions")
    case "unlinked":
      return tr("Not linked")
    case "past_due":
      return tr("Past due")
    case "trial":
      return tr("Trial")
    case "cancelled":
      return tr("Cancelled")
  }
}

/** A count that stops where the read stops: "50+" when the page was full and more follows. */
export function countLabel(n: number, more: boolean): string {
  return more ? `${n}+` : String(n)
}

// ---- Plan totals ----

/** The Subscriptions filter's totals: the query's own `byPlan`, per currency, never the page's sum. */
export function planTotals(
  mrr: MrrResult | null,
  locale: string,
): Array<{ currency: string; plans: Array<{ plan: string; count: number; amount: string }> }> {
  if (!mrr || mrr.partial) return []
  return mrr.lines.map((l) => ({
    currency: l.currency,
    plans: l.byPlan.map((p) => ({
      plan: p.plan,
      count: p.count,
      amount: formatMoney(p.mrrMinor, l.currency, locale),
    })),
  }))
}

// ---- Rows ----

export interface ListRow {
  customer: CustomerItem
  sub: SubItem | null
  problem: boolean
}

/** The subscription a row shows: the one that needs a person first, else the newest live one. */
export function mainSubscription(subs: SubItem[]): SubItem | null {
  const rank = (s: SubItem) =>
    s.status === "past_due" || s.status === "unpaid"
      ? 0
      : s.status === "trialing"
        ? 1
        : LIVE.has(s.status)
          ? 2
          : 3
  return (
    [...subs].sort(
      (a, b) =>
        rank(a) - rank(b) || (b.currentPeriodEnd ?? "").localeCompare(a.currentPeriodEnd ?? ""),
    )[0] ?? null
  )
}

export function buildRows(
  customers: CustomerItem[],
  subsByCustomer: Record<string, SubItem[]>,
  liveOnly: boolean,
): ListRow[] {
  const rows: ListRow[] = []
  for (const customer of customers) {
    const subs = subsByCustomer[customer.id] ?? []
    if (liveOnly && !subs.some((s) => LIVE.has(s.status))) continue
    const sub = mainSubscription(subs)
    const problem = customer.delinquent || sub?.status === "past_due" || sub?.status === "unpaid"
    rows.push({ customer, sub, problem })
  }
  // Problems first; the rest keep the mirror's order.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(b.r.problem) - Number(a.r.problem) || a.i - b.i)
    .map((x) => x.r)
}

// ---- Dates and status ----

const intl = (locale: string) => (locale.startsWith("fr") ? "fr-FR" : "en")

export function shortDate(iso: string | null | undefined, locale: string, tz = "UTC"): string {
  const t = iso ? new Date(iso) : null
  if (!t || Number.isNaN(t.getTime())) return ""
  return new Intl.DateTimeFormat(intl(locale), {
    day: "numeric",
    month: "short",
    timeZone: tz,
  }).format(t)
}

export type StatusTone = "problem" | "calm"

export function statusOf(
  sub: SubItem | null,
  customer: { deleted?: boolean },
  locale: string,
): { label: string; tone: StatusTone } {
  if (!sub)
    return {
      label: customer.deleted ? tr("Deleted in Stripe") : tr("No subscription"),
      tone: "calm",
    }
  switch (sub.status) {
    case "past_due":
    case "unpaid":
      return { label: tr("Past due"), tone: "problem" }
    case "trialing":
      return {
        label: sub.trialEnd
          ? tr("Trial, ends {{date}}", { date: shortDate(sub.trialEnd, locale) })
          : tr("Trial"),
        tone: "calm",
      }
    case "canceled":
      return { label: tr("Cancelled"), tone: "calm" }
    case "paused":
      return { label: tr("Paused"), tone: "calm" }
    case "active":
      return {
        label: sub.cancelAt
          ? tr("Ends {{date}}", { date: shortDate(sub.cancelAt, locale) })
          : tr("Active"),
        tone: "calm",
      }
    default:
      return { label: sub.status, tone: "calm" }
  }
}

/** The "What happens next" cell: the one thing Stripe will do. */
export function whatHappensNext(
  sub: SubItem | null,
  nextRetry: string | null,
  locale: string,
): string {
  if (!sub) return ""
  const date = (iso: string | null | undefined) => shortDate(iso, locale)
  if (sub.status === "past_due" || sub.status === "unpaid") {
    return nextRetry
      ? tr("Stripe retries on {{date}}", { date: date(nextRetry) })
      : tr("No retry left. A person decides.")
  }
  if (sub.status === "trialing")
    return sub.trialEnd
      ? tr("Trial ends {{date}}, then it is charged", { date: date(sub.trialEnd) })
      : ""
  if (sub.status === "canceled") return ""
  if (sub.cancelAt) return tr("Ends {{date}}", { date: date(sub.cancelAt) })
  return sub.currentPeriodEnd ? tr("Renews {{date}}", { date: date(sub.currentPeriodEnd) }) : ""
}

// ---- Cards: only brand, last 4 and expiry ----

const BRAND: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "Amex",
  discover: "Discover",
  diners: "Diners",
  jcb: "JCB",
  unionpay: "UnionPay",
}

/** "Visa 4242, 10/26". A card is never more than these three facts, whatever the read held. */
export function maskedCard(card: Card | null | undefined): string {
  if (!card || !card.last4) return tr("No card")
  const last4 = String(card.last4).replace(/\D/g, "").slice(-4)
  const brand = card.brand ? (BRAND[card.brand.toLowerCase()] ?? card.brand) : tr("Card")
  return [`${brand} ${last4}`, card.exp].filter(Boolean).join(", ")
}

/** True when the card is past its expiry month. One rule, shared with the home's attention. */
export { cardExpired } from "./home-model"

// ---- Company link ----

/**
 * What the Not linked section offers for one customer. A personal address (free mail) never gets a
 * company suggestion, only the choice to create one or ask the agent. A suggestion is confirmed by a
 * person (Link); nothing here links anything.
 */
export function linkOffer(
  c: Pick<CustomerItem, "email">,
  suggestion: Suggestion | null,
): { kind: "suggested"; suggestion: Suggestion; why: string } | { kind: "none"; why: string } {
  const domain = emailDomain(c.email)
  if (!domain || isConsumerMailDomain(domain)) {
    return {
      kind: "none",
      why: tr("Personal email, and no company by that name. The agent could not suggest one."),
    }
  }
  if (!suggestion) return { kind: "none", why: tr("No company has this email domain.") }
  return { kind: "suggested", suggestion, why: tr("Suggested: same email domain") }
}

// ---- The customer page ----

export interface InvoiceView {
  id: string
  number: string | null
  issuedBy: "liaison" | "stripe"
  issuedLabel: string
  /** The Liaison document's id, only when Liaison issued it. A Stripe-issued invoice has none to show. */
  documentId: string | null
  statusLabel: string
  total: string
}

/** Invoices: "Issued by Liaison, collected by Stripe" or "Issued by Stripe" with no Liaison number. */
export function invoiceView(
  i: InvoiceItem & {
    number?: string | null
    totalMinor?: number | null
    issuer?: string | null
    liaisonDocumentId?: string | null
    liaisonDocumentNumber?: string | null
  },
  locale: string,
): InvoiceView {
  const byLiaison = i.issuer === "liaison" && !!i.liaisonDocumentId
  const total = i.totalMinor ?? i.amountDueMinor ?? 0
  const status: Record<string, string> = {
    paid: tr("Paid"),
    open: tr("Unpaid"),
    draft: tr("Draft"),
    void: tr("Void"),
    uncollectible: tr("Uncollectible"),
  }
  return {
    id: i.id,
    // Issued by Liaison: the number the customer reads is Liaison's.
    number: (byLiaison ? i.liaisonDocumentNumber : null) ?? i.number ?? null,
    issuedBy: byLiaison ? "liaison" : "stripe",
    issuedLabel: byLiaison ? tr("Issued by Liaison, collected by Stripe") : tr("Issued by Stripe"),
    documentId: byLiaison ? (i.liaisonDocumentId ?? null) : null,
    statusLabel: status[i.status] ?? i.status,
    total: formatMoney(total, i.currency ?? "eur", locale),
  }
}

export interface PaymentView {
  id: string
  amount: string
  statusLabel: string
  detail: string
  /** What is left to refund, in the payment's currency, or null when nothing is. */
  refundable: { minor: number; label: string } | null
  refunded: string | null
}

export function paymentView(p: PaymentItem, locale: string): PaymentView {
  const cur = p.currency ?? "eur"
  const amount = p.amountMinor ?? 0
  const refunded = p.refundedMinor ?? 0
  const left = p.status === "succeeded" && !p.disputed ? Math.max(0, amount - refunded) : 0
  const status =
    p.status === "succeeded" ? tr("Paid") : p.status === "failed" ? tr("Failed") : tr("Pending")
  return {
    id: p.id,
    amount: formatMoney(amount, cur, locale),
    statusLabel: p.disputed ? tr("Disputed") : status,
    detail:
      p.status === "failed" && p.failureCode
        ? p.failureCode.replace(/_/g, " ")
        : maskedCard(p.card),
    refundable: left > 0 ? { minor: left, label: formatMoney(left, cur, locale) } : null,
    refunded: refunded > 0 ? formatMoney(refunded, cur, locale) : null,
  }
}

/** A dispute is a read-only line: answering it happens in Stripe. It carries no action of its own. */
export function disputeLine(
  d: DisputeItem,
  locale: string,
): { id: string; text: string; action: null } {
  const due = d.evidenceDueBy
    ? tr("evidence due {{date}}", { date: shortDate(d.evidenceDueBy, locale) })
    : ""
  const text = [
    formatMoney(d.amountMinor ?? 0, d.currency ?? "eur", locale),
    (d.reason ?? "").replace(/_/g, " "),
    d.status?.replace(/_/g, " ") ?? "",
    due,
  ]
    .filter(Boolean)
    .join(", ")
  return { id: d.id, text, action: null }
}

// ---- Words in the discussion ----

export type DiscussionAsk = "refund" | "cancel"

/**
 * What Refund and Cancel post. They ask; they run nothing. The agent prepares the refund or the
 * cancellation, an approval card follows, and a person decides it.
 */
export function discussionAsk(
  kind: DiscussionAsk,
  customer: Pick<CustomerItem, "id" | "name" | "email">,
  target?: { id: string; label: string },
): string {
  const who = customer.name || customer.email || customer.id
  if (kind === "refund") {
    return target
      ? tr("Please prepare a refund of {{what}} for {{who}} ({{customer}}), for my approval.", {
          what: target.label,
          who,
          customer: customer.id,
        })
      : tr("Please prepare a refund for {{who}} ({{customer}}), for my approval.", {
          who,
          customer: customer.id,
        })
  }
  return target
    ? tr(
        "Please prepare the cancellation of {{what}} for {{who}} ({{customer}}), for my approval.",
        { what: target.label, who, customer: customer.id },
      )
    : tr("Please prepare a cancellation for {{who}} ({{customer}}), for my approval.", {
        who,
        customer: customer.id,
      })
}

/** The customer's initials for the avatar. */
export function initials(name: string | null, email: string | null): string {
  const src = (name || email || "?").trim()
  const parts = src.split(/[\s@.]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? (parts[1]?.[0] ?? "") : "")).toUpperCase()
}
