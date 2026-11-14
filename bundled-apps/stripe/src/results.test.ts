// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What every Stripe tool answers is masked: no address, no tax id, no card number, no
// `metadata`; a card is its brand, last 4 and expiry. The mirror is seeded with values that
// must never come out, every tool of the manifest is called (a tool with no case below fails
// the coverage check), and the whole answer is searched for them.
import { beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  activityRead,
  approvalRouteRead,
  billingStatusForCounterparty,
  cardUpdateLink,
  customerContext,
  customerLink,
  customersGet,
  customersSearch,
  disputesList,
  homeLoad,
  invoiceDocumentLink,
  invoiceSendState,
  invoicesSearch,
  mrrQuery,
  paymentsSearch,
  reconcileCandidates,
  refundDocumentLink,
  refundsCreatePreflight,
  refundsForCharge,
  subscriptionCancelEffect,
  subscriptionCancelPreflight,
  subscriptionsSearch,
} from "./handlers"
import type { MemDb } from "./mem-db.testkit"
import {
  connectedDb,
  mockFetch,
  moneyCtx,
  seedCharge,
  stripeMockReset,
  stripeMockSeed,
} from "./money.testkit"
import { civil } from "./mrr-fixtures.testkit"

const CO = "11111111-1111-4111-8111-111111111111"
const CONTACT = "33333333-3333-4333-8333-333333333333"
const AT = "2026-11-09T10:00:00.000Z"

/** Values the mirror holds but no answer may carry. */
const FORBIDDEN = [
  "12 rue des Lilas",
  "75011",
  "FR12345678901",
  "4111111111111111",
  "secret-metadata-value",
  "cvc-123-secret",
]

function world(): MemDb {
  const db = connectedDb()
  // homeLoad also counts rows.
  Object.assign(db, { count: async (entity: string) => db.rows(entity).length })
  db.seed("stripe_customers", [
    {
      stripe_id: "cus_A",
      email: "ana@maison.example",
      name: "Aube Lune",
      company_id: CO,
      contact_id: CONTACT,
      address: { line1: "12 rue des Lilas", postal_code: "75011", city: "Paris", country: "FR" },
      tax_ids: [{ type: "eu_vat", value: "FR12345678901" }],
      metadata: { note: "secret-metadata-value" },
      stripe_updated: AT,
    },
  ])
  db.seed("stripe_subscriptions", [
    {
      stripe_id: "sub_1",
      customer_id: "cus_A",
      status: "past_due",
      plan_name: "Studio Pro",
      mrr_minor: 4900,
      currency: "eur",
      current_period_end: "2026-12-01T00:00:00.000Z",
      card_brand: "visa",
      card_last4: "4242",
      card_exp: "04/27",
      card_number: "4111111111111111",
      cvc: "cvc-123-secret",
      stripe_updated: AT,
    },
  ])
  db.seed("stripe_invoices", [
    {
      stripe_id: "in_1",
      customer_id: "cus_A",
      subscription_id: "sub_1",
      number: "LUNE-0042",
      status: "open",
      total_minor: 4900,
      currency: "eur",
      hosted_invoice_url: "https://invoice.stripe.com/i/acct_x/live_abc",
      finalized_at: "2026-11-05T00:00:00.000Z",
      customer_address: "12 rue des Lilas",
      stripe_updated: AT,
    },
  ])
  db.seed("stripe_payments", [
    {
      stripe_id: "ch_1",
      customer_id: "cus_A",
      invoice_id: null,
      status: "succeeded",
      amount_minor: 4900,
      currency: "eur",
      card_brand: "visa",
      card_last4: "4242",
      card_exp: "04/27",
      billing_details: { address: { line1: "12 rue des Lilas" } },
      created_at_stripe: AT,
      stripe_updated: AT,
    },
  ])
  db.seed("stripe_refunds", [
    {
      stripe_id: "re_1",
      payment_id: "ch_1",
      amount_minor: 1000,
      currency: "eur",
      created_at_stripe: AT,
      stripe_updated: AT,
    },
  ])
  db.seed("stripe_disputes", [
    {
      stripe_id: "dp_1",
      payment_id: "ch_1",
      amount_minor: 4900,
      currency: "eur",
      reason: "fraudulent",
      status: "needs_response",
      created_at_stripe: AT,
      stripe_updated: AT,
    },
  ])
  return db
}

type Case = () => Promise<unknown>

function cases(db: MemDb): Record<string, Case | string> {
  const read = { db }
  const money = moneyCtx(db, null)
  return {
    customers_search: () => customersSearch({ query: "aube" }, read),
    customers_get: () => customersGet({ id: "cus_A" }, read),
    subscriptions_search: () => subscriptionsSearch({}, read),
    mrr_query: () => mrrQuery({}, { db, time: { civil } }),
    invoices_search: () => invoicesSearch({ customerId: "cus_A" }, read),
    payments_search: () => paymentsSearch({}, read),
    disputes_list: () => disputesList({}, read),
    customer_context: () =>
      customerContext(
        { subject: { app: "contacts", entityType: "contact", entityId: CONTACT } },
        read,
      ),
    activity_read: () => activityRead({ companyId: CO }, read),
    approval_route_read: () =>
      approvalRouteRead({ entityType: "subscription", entityId: "sub_1" }, read),
    billing_status_for_counterparty: () => billingStatusForCounterparty({ companyId: CO }, read),
    invoice_document_link: () =>
      invoiceDocumentLink(
        { stripeInvoiceId: "in_1", documentId: "22222222-2222-4222-8222-222222222222" },
        { db },
      ),
    refund_document_link: () =>
      refundDocumentLink(
        { stripeRefundId: "re_1", documentId: "22222222-2222-4222-8222-222222222222" },
        { db },
      ),
    refunds_for_charge: () =>
      refundsForCharge({ chargeId: "ch_card" }, { ...money, db: money.db as never }),
    reconcile_candidates: () => reconcileCandidates({}, { db: db as never, fetch: mockFetch }),
    invoice_send_state: () =>
      invoiceSendState(
        { ref: { kind: "stripe:invoice", id: "in_FIXTURE0001" } },
        { db: db as never, fetch: mockFetch },
      ),
    refunds_create: () => refundsCreatePreflight({ chargeId: "ch_card", amountMinor: 500 }, money),
    subscription_cancel: () => subscriptionCancelPreflight({ subscriptionId: "sub_1" }, money),
    subscription_cancel_effect: () => subscriptionCancelEffect({ subscriptionId: "sub_1" }, money),
    card_update_link: () =>
      cardUpdateLink(
        { customerId: "cus_A" },
        { db, fetch: mockFetch, config: { get: async () => null } },
      ),
    customer_link: () =>
      customerLink({ stripeCustomerId: "cus_A", unlink: true }, { db: db as never, userId: "u1" }),
    home_load: () => homeLoad({}, { db: db as never }),
    // Their answers hold the connection's own checks and settings, never a customer's record:
    // connection.test.ts reads every row they give.
    connection_check: "no customer data: ten permission rows (connection.test.ts)",
    connection_precheck: "no customer data: one verdict about a key (connection.test.ts)",
    settings_load:
      "no customer data: the connection's state and webhook address (connection.test.ts)",
  }
}

beforeEach(() => {
  stripeMockReset()
  seedCharge("ch_card", 4900, 0, {
    billing_details: { address: { line1: "12 rue des Lilas", postal_code: "75011" } },
    payment_method_details: {
      card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2027 },
    },
  })
  stripeMockSeed("invoices", {
    id: "in_FIXTURE0001",
    status: "open",
    customer_address: { line1: "12 rue des Lilas" },
  })
})

describe("every Stripe tool's result", () => {
  it("each tool of the manifest has a case here, so a new tool cannot skip the mask", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"),
    ) as { tools: Record<string, unknown> }
    expect(Object.keys(cases(world())).sort()).toEqual(Object.keys(manifest.tools).sort())
  })

  it("answers with masked fields only: no address, no tax id, no card number, no metadata", async () => {
    const db = world()
    const ran: string[] = []
    for (const [tool, run] of Object.entries(cases(db))) {
      if (typeof run === "string") continue
      const out = JSON.stringify(await run())
      ran.push(tool)
      for (const secret of FORBIDDEN)
        expect({ tool, leaked: out.includes(secret) ? secret : null }).toEqual({
          tool,
          leaked: null,
        })
      expect({
        tool,
        address: /"address"|"tax_ids"|"metadata"|"billing_details"|"card_number"|"cvc"/.test(out),
      }).toEqual({ tool, address: false })
    }
    expect(ran.length).toBeGreaterThanOrEqual(20)
  })

  it("a card is shown as brand, last 4 and expiry", async () => {
    const db = world()
    const subs = JSON.stringify(await subscriptionsSearch({}, { db }))
    expect(subs).toContain('"card":{"brand":"visa","last4":"4242","exp":"04/27"}')
  })

  it("customers_search carries no address, and customers_get, the detail call, carries none either", async () => {
    const db = world()
    const found = (await customersSearch({ query: "aube" }, { db })) as {
      items: Array<Record<string, unknown>>
    }
    expect(found.items).toHaveLength(1)
    expect(Object.keys(found.items[0] ?? {})).not.toContain("address")
    const detail = (await customersGet({ id: "cus_A" }, { db })) as {
      customer: Record<string, unknown>
    }
    expect(Object.keys(detail.customer)).not.toContain("address")
    expect(JSON.stringify([found, detail])).not.toContain("Lilas")
  })
})
