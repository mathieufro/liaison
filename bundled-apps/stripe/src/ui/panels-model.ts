// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the contact, company and ticket panels show for one record: nothing when the read is refused
// (the viewer lacks the customers read scope, or the record is not theirs to see), an invitation to
// link when no Stripe customer is linked, or a small masked card. Masked: brand, last 4, expiry only.
import {
  type Card,
  type CustomerItem,
  cardExpired,
  mainSubscription,
  maskedCard,
  shortDate,
  statusOf,
  whatHappensNext,
} from "./customers-model"
import { formatMoney, type InvoiceItem, type SubItem } from "./home-model"
import { tr } from "./i18n"

export interface PanelRead {
  customer?: CustomerItem
  subscriptions?: SubItem[]
  openInvoices?: InvoiceItem[]
  syncedAt?: string | null
  error?: unknown
}

export type PanelKind = "contact" | "company" | "ticket"

export type PanelModel =
  | { kind: "hidden" }
  | { kind: "empty"; text: string }
  | {
      kind: "card"
      customerId: string
      rowId: string | null
      name: string
      pastDue: boolean
      pastDueLabel: string | null
      plan: string
      amount: string
      status: string
      next: string
      card: string
      cardExpired: boolean
      unpaid: string | null
      updated: string
    }

const emptyText = (k: PanelKind) =>
  k === "contact"
    ? tr("No Stripe customer is linked to this contact.")
    : k === "company"
      ? tr("No Stripe customer is linked to this company.")
      : tr("No Stripe customer is linked to this ticket's contact.")

/**
 * `read` is the answer of `customers_get`, or null when the call was refused or failed. A refusal
 * hides the panel entirely (a viewer without the scope never sees a "link" prompt); an answer with no
 * customer says so; otherwise the card.
 */
export function panelModel(
  kind: PanelKind,
  read: PanelRead | null,
  locale: string,
  now: Date = new Date(),
): PanelModel {
  if (!read || read.error) return { kind: "hidden" }
  if (!read.customer) return { kind: "empty", text: emptyText(kind) }
  const subs = read.subscriptions ?? []
  const sub: SubItem | null = mainSubscription(subs)
  const c = read.customer
  const card: Card | null = sub?.card ?? null
  const unpaid = (read.openInvoices ?? [])[0]
  const pastDue = sub?.status === "past_due" || sub?.status === "unpaid"
  return {
    kind: "card",
    customerId: c.id,
    rowId: c.rowId,
    name: c.name || c.email || c.id,
    pastDue,
    pastDueLabel: pastDue
      ? sub?.pastDueSince
        ? tr("Past due since {{date}}", { date: shortDate(sub.pastDueSince, locale) })
        : tr("Past due")
      : null,
    plan: sub?.plan ?? tr("No subscription"),
    amount:
      sub?.mrrMinor != null
        ? tr("{{amount}} per month", {
            amount: formatMoney(sub.mrrMinor, sub.currency ?? "eur", locale),
          })
        : "",
    status: statusOf(sub, c, locale).label,
    next: whatHappensNext(sub, unpaid?.nextPaymentAttempt ?? null, locale),
    card: maskedCard(card),
    cardExpired: cardExpired(card, now),
    unpaid: unpaid
      ? `${unpaid.number ?? unpaid.id}, ${formatMoney(unpaid.amountDueMinor ?? 0, unpaid.currency ?? "eur", locale)}`
      : null,
    updated: read.syncedAt
      ? tr("Last update from Stripe {{date}}", { date: shortDate(read.syncedAt, locale) })
      : "",
  }
}

/** The `customers_get` argument for each place a panel sits. */
export const panelArgs = (kind: "contact" | "company", id: string): Record<string, unknown> =>
  kind === "contact" ? { contactId: id } : { companyId: id }
