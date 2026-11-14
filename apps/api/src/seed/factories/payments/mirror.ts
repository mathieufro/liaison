// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The card-payments mirror factory: the rows the payments app would hold after
// its first import and a few months of webhooks (customers, subscriptions,
// their invoices and charges, disputes, the MRR movement log, the import's
// progress and the install row), written in the app's own row shape.
//
// The shapes are the app's own row builders' (its `mirror.ts`): a stand-in
// install answers the processor's API from these rows, and the app writes back
// what it reads, so a row written here must be the row the app would build from
// the object the stand-in returns. That is why instants are whole seconds (the
// processor counts in seconds), a subscription's plan name is its first item's
// product name, and its amount a month is the app's MRR rule over its items.
//
// Privileged and idempotent: each table is written in a few multi-row
// statements keyed on deterministic ids, so a re-seed overwrites in place.
import { type SQL, sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import {
  standInHostedInvoiceUrl,
  standInInstallPermissions,
} from "~/modules/demo/worlds/saas/payments/sentinel"
import type { SeedContext } from "~/seed/context"
import { type AppCell, jsonCell, type SeedTx } from "../app-tables"

/** The payments app, by the id it is installed under. */
const APP = "stripe"
const table = (name: string) => `${APP}_${name}`

/** Rows per INSERT: a few statements per table, far under the bound-parameter limit. */
const BATCH = 250

export interface MirrorCard {
  brand: string
  last4: string
  /** `MM/YY`. */
  exp: string
}

export interface MirrorCustomer {
  id: string
  email: string
  name: string
  createdAt: Date
  delinquent: boolean
  companyId: string | null
  contactId: string | null
}

export interface MirrorSubscription {
  id: string
  customerId: string
  status: "active" | "past_due" | "trialing" | "canceled"
  /** The product's name: the plan the subscription is on. */
  planName: string
  /** The price per billing interval, excluding tax. */
  unitMinor: number
  interval: "month" | "year"
  taxPercent: number
  periodStart: Date
  periodEnd: Date
  trialEnd: Date | null
  canceledAt: Date | null
  pastDueSince: Date | null
  /** When the subscription began; the current period's start when omitted. */
  startedAt?: Date | null
  card: MirrorCard | null
}

export interface MirrorInvoice {
  id: string
  customerId: string
  subscriptionId: string | null
  status: "paid" | "open"
  netMinor: number
  taxMinor: number
  periodStart: Date
  periodEnd: Date
  finalizedAt: Date
  paidAt: Date | null
  nextPaymentAttempt: Date | null
  billingReason: string
  /** The issued invoice that invoices this one, when the org issues its own. */
  documentId: string | null
  /** That invoice's number, shown on the processor's invoice row. */
  documentNumber?: string | null
}

export interface MirrorPayment {
  id: string
  invoiceId: string
  customerId: string
  amountMinor: number
  status: "succeeded" | "failed"
  failureCode: string | null
  failureMessage: string | null
  card: MirrorCard
  at: Date
  disputed: boolean
}

export interface MirrorDispute {
  id: string
  paymentId: string
  amountMinor: number
  reason: string
  status: string
  at: Date
  evidenceDueBy: Date
}

export interface MirrorMovement {
  eventId: string
  subscriptionId: string
  customerId: string
  at: Date
  kind: "new" | "upgrade" | "downgrade" | "cancelled"
  beforeMinor: number
  afterMinor: number
}

export interface PaymentsMirrorSpec {
  currency: string
  customers: readonly MirrorCustomer[]
  subscriptions: readonly MirrorSubscription[]
  invoices: readonly MirrorInvoice[]
  payments: readonly MirrorPayment[]
  disputes: readonly MirrorDispute[]
  movements: readonly MirrorMovement[]
  install: {
    accountId: string
    accountName: string
    connectedAt: Date
    lastEventAt: Date
    lastEventType: string
  }
  /** When the app last read the account (the import's and the nightly reconcile's time). */
  syncedAt: Date
}

const COUNTED = new Set(["active", "past_due"])

/** The app's MRR rule for one item: the price over its interval as one month, halves up. */
export function mirrorMrrMinor(s: Pick<MirrorSubscription, "status" | "unitMinor" | "interval">) {
  if (!COUNTED.has(s.status)) return 0
  return s.interval === "year" ? Math.floor((2 * s.unitMinor + 12) / 24) : s.unitMinor
}

/** A subscription's items, exactly as the app's row builder keeps them. */
export function mirrorItems(s: MirrorSubscription, currency: string) {
  return [
    {
      price_id: `price_${s.planName.replace(/[^A-Za-z0-9]/g, "")}${s.interval === "year" ? "Yearly" : "Monthly"}`,
      product_name: s.planName,
      unit_amount: s.unitMinor,
      currency,
      interval: s.interval,
      interval_count: 1,
      quantity: 1,
      usage_type: "licensed",
      tax_behavior: "exclusive",
      tax_percent: s.taxPercent,
    },
  ]
}

const iso = (d: Date | null) => {
  if (d === null) return null
  if (d.getTime() % 1000 !== 0) {
    throw new Error(`payments mirror: ${d.toISOString()} is not a whole second`)
  }
  return d.toISOString()
}

type Row = Record<string, AppCell> & { id: string; org_id: string }

/** INSERT rows into one app table in a few statements; a re-run overwrites by id. */
async function upsertRows(tx: SeedTx, name: string, rows: readonly Row[]): Promise<void> {
  if (rows.length === 0) return
  const cols = Object.keys(rows[0] as Row)
  const target = sql`${sql.identifier(schemaRef(`app_${APP}`))}.${sql.identifier(name)}`
  const colList = sql.join(
    cols.map((c) => sql.identifier(c)),
    sql`, `,
  )
  const assignments = sql.join(
    cols
      .filter((c) => c !== "id" && c !== "org_id")
      .map((c) => sql`${sql.identifier(c)} = EXCLUDED.${sql.identifier(c)}`),
    sql`, `,
  )
  for (let i = 0; i < rows.length; i += BATCH) {
    const values: SQL[] = rows.slice(i, i + BATCH).map((row) => {
      const cells = cols.map((c) => {
        const v = row[c] as AppCell
        return v !== null && typeof v === "object" && "__json" in v
          ? sql`${JSON.stringify(v.__json)}::jsonb`
          : sql`${v}`
      })
      return sql`(${sql.join(cells, sql`, `)})`
    })
    await tx.execute(
      sql`INSERT INTO ${target} (${colList}) VALUES ${sql.join(values, sql`, `)}
          ON CONFLICT (id) DO UPDATE SET ${assignments}`,
    )
  }
}

export interface PaymentsMirrorResult {
  customers: number
  subscriptions: number
  invoices: number
  payments: number
  disputes: number
  movements: number
}

export interface PaymentsMirrorRows {
  customers: Row[]
  subscriptions: Row[]
  invoices: Row[]
  payments: Row[]
  disputes: Row[]
  movements: Row[]
  syncState: Row[]
  install: Row
}

/** The rows of the org's payments mirror, per table, exactly as they are written. Pure. */
export function paymentsMirrorRows(
  ctx: Pick<SeedContext, "orgId" | "id">,
  spec: PaymentsMirrorSpec,
): PaymentsMirrorRows {
  const { orgId } = ctx
  const cur = spec.currency
  const synced = iso(spec.syncedAt) as string
  const id = (kind: string, key: string) => ctx.id(`payments-${kind}`, key)
  const card = (c: MirrorCard | null) => ({
    card_brand: c?.brand ?? null,
    card_last4: c?.last4 ?? null,
    card_exp: c?.exp ?? null,
  })

  const customers: Row[] = spec.customers.map((c) => ({
    id: id("customer", c.id),
    org_id: orgId,
    stripe_id: c.id,
    email: c.email,
    name: c.name,
    currency: cur,
    delinquent: c.delinquent,
    address: null,
    tax_ids: null,
    company_id: c.companyId,
    contact_id: c.contactId,
    match_method: c.companyId || c.contactId ? "email" : null,
    deleted_at: null,
    stripe_updated: synced,
    created_at_stripe: iso(c.createdAt),
  }))
  const subscriptions: Row[] = spec.subscriptions.map((s) => ({
    id: id("subscription", s.id),
    org_id: orgId,
    stripe_id: s.id,
    customer_id: s.customerId,
    status: s.status,
    plan_name: s.planName,
    items: jsonCell(mirrorItems(s, cur)),
    discount_percent: null,
    discount_amount_minor: null,
    mrr_minor: mirrorMrrMinor(s),
    currency: cur,
    current_period_start: iso(s.periodStart),
    current_period_end: iso(s.periodEnd),
    trial_end: iso(s.trialEnd),
    cancel_at: null,
    canceled_at: iso(s.canceledAt),
    ...card(s.card),
    past_due_since: iso(s.pastDueSince),
    // The processor always knows a subscription's start: the period's when the spec names none.
    started_at: iso(s.startedAt ?? s.periodStart),
    stripe_updated: synced,
  }))
  const invoices: Row[] = spec.invoices.map((v) => ({
    id: id("invoice", v.id),
    org_id: orgId,
    stripe_id: v.id,
    customer_id: v.customerId,
    subscription_id: v.subscriptionId,
    number: null,
    status: v.status,
    total_minor: v.netMinor + v.taxMinor,
    tax_minor: v.taxMinor,
    amount_paid_minor: v.status === "paid" ? v.netMinor + v.taxMinor : 0,
    amount_due_minor: v.status === "paid" ? 0 : v.netMinor + v.taxMinor,
    currency: cur,
    period_start: iso(v.periodStart),
    period_end: iso(v.periodEnd),
    billing_reason: v.billingReason,
    hosted_invoice_url: standInHostedInvoiceUrl(v.id),
    next_payment_attempt: iso(v.nextPaymentAttempt),
    finalized_at: iso(v.finalizedAt),
    paid_at: iso(v.paidAt),
    issuer: "liaison",
    liaison_document_id: v.documentId,
    liaison_document_number: v.documentNumber ?? null,
    stripe_updated: synced,
  }))
  const payments: Row[] = spec.payments.map((p) => ({
    id: id("payment", p.id),
    org_id: orgId,
    stripe_id: p.id,
    payment_intent: p.id.replace(/^ch_/, "pi_"),
    invoice_id: p.invoiceId,
    customer_id: p.customerId,
    amount_minor: p.amountMinor,
    refunded_minor: 0,
    currency: cur,
    status: p.status,
    failure_code: p.failureCode,
    failure_message: p.failureMessage,
    ...card(p.card),
    created_at_stripe: iso(p.at),
    disputed: p.disputed,
    stripe_updated: synced,
  }))
  const disputes: Row[] = spec.disputes.map((d) => ({
    id: id("dispute", d.id),
    org_id: orgId,
    stripe_id: d.id,
    payment_id: d.paymentId,
    amount_minor: d.amountMinor,
    currency: cur,
    reason: d.reason,
    status: d.status,
    evidence_due_by: iso(d.evidenceDueBy),
    funds_withdrawn_at: iso(d.at),
    created_at_stripe: iso(d.at),
    stripe_updated: synced,
  }))
  const movements: Row[] = spec.movements.map((m) => ({
    id: id("movement", m.eventId),
    org_id: orgId,
    stripe_event_id: m.eventId,
    subscription_id: m.subscriptionId,
    customer_id: m.customerId,
    at: iso(m.at),
    kind: m.kind,
    delta_minor: m.afterMinor - m.beforeMinor,
    before_minor: m.beforeMinor,
    after_minor: m.afterMinor,
    currency: cur,
    source: "webhook",
  }))
  // The first import is done for every resource, and the movement log is
  // covered up to the last reconcile, so the MRR read gives its figure.
  const counts: Record<string, number> = {
    customers: customers.length,
    subscriptions: subscriptions.length,
    invoices: invoices.length,
    charges: payments.length,
    refunds: 0,
    disputes: disputes.length,
  }
  const syncState: Row[] = Object.entries(counts).map(([resource, n]) => ({
    id: id("sync", resource),
    org_id: orgId,
    resource,
    cursor: null,
    done_count: n,
    total_count: n,
    status: "done",
    catchup_due: false,
    last_error_code: null,
    updated: synced,
  }))
  syncState.push({
    id: id("sync", "mrr_rebuild"),
    org_id: orgId,
    resource: "mrr_rebuild",
    cursor: synced,
    done_count: 0,
    total_count: null,
    status: "done",
    catchup_due: false,
    last_error_code: null,
    updated: synced,
  })
  const install: Row = {
    id: id("install", "metadata"),
    org_id: orgId,
    account_id: spec.install.accountId,
    account_name: spec.install.accountName,
    livemode: false,
    permissions: jsonCell(standInInstallPermissions(iso(spec.install.connectedAt) as string)),
    state: "connected",
    last_event_at: iso(spec.install.lastEventAt),
    last_event_type: spec.install.lastEventType,
    connected_at: iso(spec.install.connectedAt),
    webhook_confirmed_at: iso(spec.install.connectedAt),
  }

  return { customers, subscriptions, invoices, payments, disputes, movements, syncState, install }
}

/** Write the org's payments mirror. Idempotent. */
export async function seedPaymentsMirror(
  ctx: SeedContext,
  spec: PaymentsMirrorSpec,
): Promise<PaymentsMirrorResult> {
  const { customers, subscriptions, invoices, payments, disputes, movements, syncState, install } =
    paymentsMirrorRows(ctx, spec)
  await withSystemDb("seed-payments-mirror", async (tx) => {
    await upsertRows(tx, table("customers"), customers)
    await upsertRows(tx, table("subscriptions"), subscriptions)
    await upsertRows(tx, table("invoices"), invoices)
    await upsertRows(tx, table("payments"), payments)
    await upsertRows(tx, table("disputes"), disputes)
    await upsertRows(tx, table("mrr_events"), movements)
    await upsertRows(tx, "sync_state", syncState)
    await upsertRows(tx, "install_metadata", [install])
  })
  return {
    customers: customers.length,
    subscriptions: subscriptions.length,
    invoices: invoices.length,
    payments: payments.length,
    disputes: disputes.length,
    movements: movements.length,
  }
}
