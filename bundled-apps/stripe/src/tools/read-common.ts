// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the mirror readers share: the db slice they use, offset cursors, the
// masked row shapes and the "as of" line every result carries. A reader reads
// the mirror only, never Stripe, so its answer is as fresh as the mirror's
// last write: each result says when that was (`syncedAt`).
import type { CrossAppEnvelope } from "@liaison/app-sdk"

type Obj = Record<string, unknown>

export interface ReadDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      orderBy?: Record<string, "asc" | "desc">
      limit?: number
      offset?: number
    },
  ): Promise<unknown[]>
}

export interface ReadCtx {
  db: ReadDb
  executeTool?: (tool: string, params: Record<string, unknown>) => Promise<CrossAppEnvelope>
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 50
/** Rows the name search scans at most (5 pages of the app database's largest). */
export const SCAN_CAP = 5000

export const iso = (v: unknown): string | null =>
  v instanceof Date
    ? v.toISOString()
    : typeof v === "string" && v
      ? new Date(v).toISOString()
      : null
export const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null)
export const num = (v: unknown): number | null =>
  v === null || v === undefined || v === "" ? null : Number(v)

export function limitOf(v: unknown): number {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_LIMIT, n) : DEFAULT_LIMIT
}

export function offsetOf(cursor: unknown): number {
  const n = typeof cursor === "string" ? Number.parseInt(cursor, 10) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** The newest mirror write among these rows: what the answer is as fresh as. */
export function syncedAt(rows: Obj[]): string | null {
  let best: string | null = null
  for (const r of rows) {
    const t = iso(r.stripe_updated)
    if (t && (!best || t > best)) best = t
  }
  return best
}

/** A page of a list read: its rows, the next cursor and the plain facts line. */
export function pageOf<T>(
  rows: T[],
  raw: Obj[],
  offset: number,
  limit: number,
  noun: string,
  more: boolean,
): { items: T[]; nextCursor: string | null; syncedAt: string | null; summary: string } {
  const at = syncedAt(raw)
  const n = rows.length
  return {
    items: rows,
    nextCursor: more ? String(offset + limit) : null,
    syncedAt: at,
    summary:
      n === 0
        ? `No ${noun} in the Stripe mirror match.${at ? "" : " The mirror may still be importing."}`
        : `${n} ${noun}${more ? " (more on the next page)" : ""} from the Stripe mirror${at ? `, last synced ${at}` : ""}.`,
  }
}

/** Read with one extra row, so the page knows whether another follows. */
export async function readPage(
  ctx: ReadCtx,
  entity: string,
  where: Obj,
  offset: number,
  limit: number,
  orderBy: Record<string, "asc" | "desc">,
): Promise<{ rows: Obj[]; more: boolean }> {
  const rows = (await ctx.db.findMany(entity, {
    where,
    orderBy,
    limit: limit + 1,
    offset,
  })) as Obj[]
  return { rows: rows.slice(0, limit), more: rows.length > limit }
}

/** The Stripe customer ids linked to a contact or a company (mirror only). */
export async function customerIdsFor(
  ctx: ReadCtx,
  by: { contactId?: string; companyId?: string },
): Promise<string[]> {
  const where = by.contactId
    ? { contact_id: by.contactId }
    : by.companyId
      ? { company_id: by.companyId }
      : null
  if (!where) return []
  const rows = (await ctx.db.findMany("stripe_customers", { where, limit: 50 })) as Obj[]
  return rows.filter((r) => r.deleted_at == null).map((r) => String(r.stripe_id))
}

// ---- Masked row shapes: no address, no tax id, card as brand, last 4, expiry.

export function customerItem(r: Obj) {
  return {
    id: String(r.stripe_id),
    rowId: str(r.id),
    name: str(r.name),
    email: str(r.email),
    currency: str(r.currency),
    delinquent: r.delinquent === true,
    deleted: r.deleted_at != null,
    companyId: str(r.company_id),
    contactId: str(r.contact_id),
    linkedBy: str(r.match_method),
  }
}

export function subscriptionItem(r: Obj) {
  return {
    id: String(r.stripe_id),
    customerId: String(r.customer_id),
    status: String(r.status),
    plan: str(r.plan_name),
    mrrMinor: num(r.mrr_minor),
    currency: str(r.currency),
    currentPeriodEnd: iso(r.current_period_end),
    trialEnd: iso(r.trial_end),
    cancelAt: iso(r.cancel_at),
    pastDueSince: iso(r.past_due_since),
    card: cardOf(r),
  }
}

export function invoiceItem(r: Obj) {
  return {
    id: String(r.stripe_id),
    customerId: String(r.customer_id),
    subscriptionId: str(r.subscription_id),
    number: str(r.number),
    status: String(r.status),
    totalMinor: num(r.total_minor),
    amountDueMinor: num(r.amount_due_minor),
    currency: str(r.currency),
    nextPaymentAttempt: iso(r.next_payment_attempt),
    paidAt: iso(r.paid_at),
    issuer: str(r.issuer),
    liaisonDocumentId: str(r.liaison_document_id),
    liaisonDocumentNumber: str(r.liaison_document_number),
  }
}

export function paymentItem(r: Obj) {
  return {
    id: String(r.stripe_id),
    customerId: str(r.customer_id),
    invoiceId: str(r.invoice_id),
    amountMinor: num(r.amount_minor),
    refundedMinor: num(r.refunded_minor),
    currency: str(r.currency),
    status: String(r.status),
    failureCode: str(r.failure_code),
    disputed: r.disputed === true,
    at: iso(r.created_at_stripe),
    card: cardOf(r),
  }
}

export function disputeItem(r: Obj) {
  return {
    id: String(r.stripe_id),
    paymentId: String(r.payment_id),
    amountMinor: num(r.amount_minor),
    currency: str(r.currency),
    reason: str(r.reason),
    status: str(r.status),
    evidenceDueBy: iso(r.evidence_due_by),
    at: iso(r.created_at_stripe),
  }
}

function cardOf(r: Obj): { brand: string | null; last4: string | null; exp: string | null } | null {
  if (!r.card_brand && !r.card_last4) return null
  return { brand: str(r.card_brand), last4: str(r.card_last4), exp: str(r.card_exp) }
}
