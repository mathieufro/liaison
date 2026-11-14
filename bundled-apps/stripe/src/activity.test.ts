// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe rows of a company's timeline: each of the seven kinds, newest first,
// and a cursor that returns only older rows.
import { describe, expect, it } from "bun:test"
import { MemDb } from "./mem-db.testkit"
import { activityRead } from "./tools/activity"

const CO = "11111111-1111-4111-8111-111111111111"

describe("the Stripe timeline rows", () => {
  it("a company timeline gets failed payment, retry failed, started, cancelled, refund and dispute rows", async () => {
    const db = new MemDb()
    db.seed("stripe_customers", [{ stripe_id: "cus_A", name: "Maison Lune", company_id: CO }])
    db.seed("stripe_customers", [{ stripe_id: "cus_X", name: "Elsewhere", company_id: null }])
    db.seed("stripe_subscriptions", [
      {
        stripe_id: "sub_1",
        customer_id: "cus_A",
        plan_name: "Studio Pro",
        status: "canceled",
        created_at: "2026-01-05T09:00:00.000Z",
        canceled_at: "2026-10-30T09:00:00.000Z",
      },
    ])
    db.seed("stripe_payments", [
      {
        stripe_id: "ch_1",
        customer_id: "cus_A",
        invoice_id: "in_9",
        status: "failed",
        amount_minor: 4900,
        currency: "eur",
        created_at_stripe: "2026-10-01T09:00:00.000Z",
      },
      {
        stripe_id: "ch_2",
        customer_id: "cus_A",
        invoice_id: "in_9",
        status: "failed",
        amount_minor: 4900,
        currency: "eur",
        created_at_stripe: "2026-10-04T09:00:00.000Z",
      },
      {
        stripe_id: "ch_3",
        customer_id: "cus_A",
        invoice_id: "in_8",
        status: "succeeded",
        amount_minor: 4900,
        currency: "eur",
        created_at_stripe: "2026-09-01T09:00:00.000Z",
      },
      {
        stripe_id: "ch_4",
        customer_id: "cus_X",
        invoice_id: "in_7",
        status: "failed",
        amount_minor: 100,
        currency: "eur",
        created_at_stripe: "2026-10-02T09:00:00.000Z",
      },
    ])
    db.seed("stripe_refunds", [
      {
        stripe_id: "re_1",
        payment_id: "ch_3",
        amount_minor: 1000,
        currency: "eur",
        created_at_stripe: "2026-09-10T09:00:00.000Z",
      },
    ])
    db.seed("stripe_disputes", [
      {
        stripe_id: "dp_1",
        payment_id: "ch_3",
        amount_minor: 3900,
        currency: "eur",
        created_at_stripe: "2026-09-20T09:00:00.000Z",
      },
    ])

    const { rows } = await activityRead({ companyId: CO, prefix: "stripe:" }, { db })
    expect(rows.map((r) => r.title)).toEqual([
      "Studio Pro cancelled",
      "Retry failed, 49.00 EUR",
      "Payment failed, 49.00 EUR",
      "Dispute opened, 39.00 EUR",
      "Refund, 10.00 EUR",
      "Studio Pro started",
    ])
    expect(rows.every((r) => r.who === "Maison Lune")).toBe(true)
    expect(rows[0]?.href).toEqual({ app: "stripe", entityType: "customer", entityId: "cus_A" })

    const older = await activityRead(
      {
        companyId: CO,
        prefix: "stripe:",
        before: { at: rows[2]?.at, id: `stripe:${rows[2]?.id}` },
      },
      { db },
    )
    expect(older.rows.map((r) => r.title)).toEqual([
      "Dispute opened, 39.00 EUR",
      "Refund, 10.00 EUR",
      "Studio Pro started",
    ])
    expect(
      await activityRead({ companyId: "77777777-7777-4777-8777-777777777777" }, { db }),
    ).toEqual({ rows: [] })
  })

  it("a subscription starts when Stripe started it, not when the mirror first stored it", async () => {
    const db = new MemDb()
    db.seed("stripe_customers", [{ stripe_id: "cus_A", name: "Maison Lune", company_id: CO }])
    db.seed("stripe_subscriptions", [
      {
        stripe_id: "sub_1",
        customer_id: "cus_A",
        plan_name: "Group",
        status: "active",
        created_at: "2026-11-11T09:00:00.000Z",
        started_at: "2025-03-14T09:00:00.000Z",
      },
    ])
    const { rows } = await activityRead({ companyId: CO, prefix: "stripe:" }, { db })
    const started = rows.find((r) => r.title === "Group started")
    expect(started?.at).toBe("2025-03-14T09:00:00.000Z")
  })

  it("a contact's linked customer with no payment or subscription still gives one row opening the customer", async () => {
    const PERSON = "22222222-2222-4222-8222-222222222222"
    const db = new MemDb()
    db.seed("stripe_customers", [
      {
        stripe_id: "cus_B",
        name: "Maison Brume",
        contact_id: PERSON,
        created_at_stripe: "2026-04-01T09:00:00.000Z",
      },
      {
        stripe_id: "cus_C",
        name: "Gone",
        contact_id: PERSON,
        created_at_stripe: "2026-04-02T09:00:00.000Z",
        deleted_at: "2026-05-01T09:00:00.000Z",
      },
    ])
    const { rows } = await activityRead({ contactIds: [PERSON], prefix: "stripe:" }, { db })
    expect(rows.map((r) => [r.title, r.href?.entityId, r.contactId])).toEqual([
      ["Customer created", "cus_B", PERSON],
    ])
  })
})
