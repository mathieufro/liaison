// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mirror holds no card number, no CVC, no raw event body and no Stripe
// `metadata`: every `app_stripe` column is on this allow-list, and a new column
// fails here until someone decides it belongs.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

type FieldDef = string | { type: string }
type Manifest = { schema: Record<string, { fields: Record<string, FieldDef> }> }

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"),
) as Manifest

const ALLOWED: Record<string, string[]> = {
  stripe_customers: [
    "stripe_id",
    "email",
    "name",
    "currency",
    "delinquent",
    "address",
    "tax_ids",
    "company_id",
    "contact_id",
    "match_method",
    "match_by",
    "deleted_at",
    "stripe_updated",
    "created_at_stripe",
    // The link a person's change replaced (company, contact, method, who), for undo: Liaison ids only.
    "previous_link",
  ],
  stripe_subscriptions: [
    "stripe_id",
    "customer_id",
    "status",
    "plan_name",
    "items",
    "discount_percent",
    "discount_amount_minor",
    "mrr_minor",
    "currency",
    "current_period_start",
    "current_period_end",
    "trial_end",
    "cancel_at",
    "canceled_at",
    "card_brand",
    "card_last4",
    "card_exp",
    "past_due_since",
    "started_at",
    "stripe_updated",
  ],
  stripe_invoices: [
    "stripe_id",
    "customer_id",
    "subscription_id",
    "number",
    "status",
    "total_minor",
    "tax_minor",
    "amount_paid_minor",
    "amount_due_minor",
    "currency",
    "period_start",
    "period_end",
    "billing_reason",
    "hosted_invoice_url",
    "next_payment_attempt",
    "finalized_at",
    "paid_at",
    "issuer",
    "liaison_document_id",
    "liaison_document_number",
    "stripe_updated",
  ],
  stripe_payments: [
    "stripe_id",
    "payment_intent",
    "invoice_id",
    "customer_id",
    "amount_minor",
    "refunded_minor",
    "currency",
    "status",
    "failure_code",
    "failure_message",
    "card_brand",
    "card_last4",
    "card_exp",
    "created_at_stripe",
    "disputed",
    "stripe_updated",
  ],
  stripe_refunds: [
    "stripe_id",
    "payment_id",
    "amount_minor",
    "currency",
    "status",
    "reason",
    "liaison_document_id",
    "liaison_skipped",
    "created_at_stripe",
    "stripe_updated",
  ],
  stripe_disputes: [
    "stripe_id",
    "payment_id",
    "amount_minor",
    "currency",
    "reason",
    "status",
    "evidence_due_by",
    "funds_withdrawn_at",
    "created_at_stripe",
    "stripe_updated",
  ],
  stripe_mrr_events: [
    "stripe_event_id",
    "subscription_id",
    "customer_id",
    "at",
    "kind",
    "delta_minor",
    "before_minor",
    "after_minor",
    "currency",
    "source",
  ],
  sync_state: [
    "resource",
    "cursor",
    "done_count",
    "total_count",
    "status",
    "catchup_due",
    "last_error_code",
    "updated",
  ],
  install_metadata: [
    "account_id",
    "account_name",
    "livemode",
    "permissions",
    "state",
    "last_event_at",
    "last_event_type",
    "connected_at",
    "webhook_confirmed_at",
  ],
  webhook_deliveries: [
    "event_id",
    "topic",
    "status",
    "failure_count",
    "received_at",
    "processed_at",
    "claimed_at",
  ],
}

/** Column names that could only hold a payload, a card number, a CVC or metadata. */
const FORBIDDEN_NAME =
  /payload|metadata|card_number|cvc|cvv|first6|fingerprint|(^|_)(raw|body|pan|bin|iin|data)(_|$)/i

const typeOf = (f: FieldDef) => (typeof f === "string" ? f.replace(/\?$/, "") : f.type)

describe("app_stripe schema", () => {
  it("every app_stripe column is on the allow-list and none can hold a payload, a card number or metadata", () => {
    expect(Object.keys(manifest.schema).sort()).toEqual(Object.keys(ALLOWED).sort())
    for (const [table, def] of Object.entries(manifest.schema)) {
      const columns = Object.keys(def.fields)
      expect({ table, columns: columns.sort() }).toEqual({
        table,
        columns: [...(ALLOWED[table] ?? [])].sort(),
      })
      for (const column of columns)
        expect({ table, column, forbidden: FORBIDDEN_NAME.test(column) }).toEqual({
          table,
          column,
          forbidden: false,
        })
    }
    // A card's last four and expiry are text, never a number column a PAN could fit in.
    for (const def of Object.values(manifest.schema)) {
      for (const col of ["card_last4", "card_exp"]) {
        if (def.fields[col]) expect(typeOf(def.fields[col] as FieldDef)).toBe("text")
      }
    }
  })

  it("the webhook ledger keeps no body of the event", () => {
    const cols = Object.keys(manifest.schema.webhook_deliveries?.fields ?? {})
    expect(cols).not.toContain("payload")
    expect(cols).not.toContain("body")
  })
})
