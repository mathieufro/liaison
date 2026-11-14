// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every reader names its record, says when the mirror last wrote what it
// answers, and returns masked rows.
import { describe, expect, it } from "bun:test"
import { MemDb } from "./mem-db.testkit"
import { customersGet, customersSearch } from "./tools/customers"
import { disputesList } from "./tools/disputes"
import { invoicesSearch } from "./tools/invoices"
import { paymentsSearch } from "./tools/payments"
import { subscriptionsSearch } from "./tools/subscriptions"

const AT = "2026-11-09T10:00:00.000Z"

function world() {
  const db = new MemDb()
  db.seed("stripe_customers", [
    {
      stripe_id: "cus_A",
      email: "ana@maison.example",
      name: "Aube Lune",
      address: { line1: "12 rue des Lilas" },
      tax_ids: [{ value: "FR123" }],
      stripe_updated: AT,
    },
    {
      stripe_id: "cus_B",
      email: "bo@gmail.com",
      name: "Bo Durand",
      company_id: null,
      contact_id: null,
      stripe_updated: "2026-11-01T00:00:00.000Z",
    },
  ])
  db.seed("stripe_subscriptions", [
    {
      stripe_id: "sub_1",
      customer_id: "cus_A",
      status: "past_due",
      plan_name: "Studio Pro",
      card_brand: "visa",
      card_last4: "4242",
      card_exp: "04/27",
      stripe_updated: AT,
    },
  ])
  db.seed("stripe_invoices", [
    {
      stripe_id: "in_1",
      customer_id: "cus_A",
      number: "LUNE-0042",
      status: "open",
      stripe_updated: AT,
    },
  ])
  db.seed("stripe_payments", [
    {
      stripe_id: "ch_1",
      customer_id: "cus_A",
      invoice_id: null,
      status: "succeeded",
      amount_minor: 100,
      card_brand: "visa",
      card_last4: "4242",
      stripe_updated: AT,
    },
  ])
  db.seed("stripe_disputes", [
    {
      stripe_id: "dp_1",
      payment_id: "ch_1",
      reason: "fraudulent",
      status: "needs_response",
      stripe_updated: AT,
    },
  ])
  return { db }
}

describe("a customer page's address", () => {
  it("a customer is read by the row id its page carries, and the lists name that row id", async () => {
    const db = new MemDb()
    const ROW = "5b1f0c2e-7a64-4f0e-9d0a-2f0a1b7c9e01"
    db.seed("stripe_customers", [
      {
        id: ROW,
        stripe_id: "cus_Z",
        email: "zoe@maison.example",
        name: "Zoe Marin",
        stripe_updated: AT,
      },
    ])
    const byRow = (await customersGet({ id: ROW }, { db })) as {
      customer: { id: string; rowId: string }
    }
    expect(byRow.customer).toMatchObject({ id: "cus_Z", rowId: ROW })
    const listed = (await customersSearch({ query: "zoe" }, { db })) as {
      items: Array<{ rowId: string }>
    }
    expect(listed.items[0]?.rowId).toBe(ROW)
  })
})

describe("a contact or company with no Stripe customer", () => {
  const PROSPECT = "0b6a7c1e-3f52-4d8e-9a10-5c2e4b7d9f11"
  it("a company with no Stripe customer is an answer that says so, not a failed read", async () => {
    const { db } = world()
    const r = (await customersGet({ companyId: PROSPECT }, { db })) as Record<string, unknown>
    expect(r.error).toBeUndefined()
    expect(r.customer).toBeNull()
    expect(r.subscriptions).toEqual([])
    expect(String(r.summary)).toStartWith("No Stripe customer is linked to this company")
  })

  it("a contact with no Stripe customer says so too", async () => {
    const { db } = world()
    const r = (await customersGet({ contactId: PROSPECT }, { db })) as Record<string, unknown>
    expect(r.customer).toBeNull()
    expect(String(r.summary)).toStartWith("No Stripe customer is linked to this contact")
  })

  it("a named Stripe id that matches nothing is still refused", async () => {
    const { db } = world()
    const r = (await customersGet({ id: "cus_missing" }, { db })) as { error?: { code?: string } }
    expect(r.error?.code).toBe("customer_not_found")
  })
})

describe("the Stripe mirror readers", () => {
  it("a reader's result names its record and says when the mirror was last synced", async () => {
    const ctx = world()
    const reads: Array<[string, Record<string, unknown>]> = [
      ["cus_A", (await customersSearch({ query: "aube" }, ctx)) as Record<string, unknown>],
      ["sub_1", (await subscriptionsSearch({ id: "sub_1" }, ctx)) as Record<string, unknown>],
      ["in_1", (await invoicesSearch({ customerId: "cus_A" }, ctx)) as Record<string, unknown>],
      ["ch_1", (await paymentsSearch({ unmatched: true }, ctx)) as Record<string, unknown>],
      ["dp_1", (await disputesList({ customerId: "cus_A" }, ctx)) as Record<string, unknown>],
    ]
    for (const [id, out] of reads) {
      expect((out.items as Array<{ id: string }>).map((r) => r.id)).toEqual([id])
      expect(out.syncedAt).toBe(AT)
      expect(String(out.summary)).toContain(`last synced ${AT}`)
    }
    const one = (await customersGet({ id: "cus_A" }, ctx)) as Record<string, unknown>
    expect(String(one.summary)).toContain("Stripe customer cus_A (Aube Lune)")
    expect(one.syncedAt).toBe(AT)
    const none = (await customersSearch({ query: "nobody@x.example" }, ctx)) as Record<
      string,
      unknown
    >
    expect(none.items).toEqual([])
    expect(String(none.summary)).toContain("No customers")
  })

  it("rows are masked: no address, no tax id, a card is brand, last 4 and expiry", async () => {
    const ctx = world()
    const all = JSON.stringify([
      await customersSearch({}, ctx),
      await customersGet({ id: "cus_A" }, ctx),
      await subscriptionsSearch({}, ctx),
      await paymentsSearch({}, ctx),
    ])
    expect(all).not.toContain("rue des Lilas")
    expect(all).not.toContain("FR123")
    expect(all).toContain('"card":{"brand":"visa","last4":"4242","exp":"04/27"}')
  })

  it("the unlinked filter, an email, an id and a page cursor each read the mirror", async () => {
    const ctx = world()
    const ids = async (p: Record<string, unknown>) =>
      ((await customersSearch(p, ctx)) as { items: Array<{ id: string }> }).items.map((r) => r.id)
    expect(await ids({ filter: "unlinked" })).toEqual(["cus_A", "cus_B"])
    expect(await ids({ filter: "past_due" })).toEqual(["cus_A"])
    expect(await ids({ query: "bo@gmail.com" })).toEqual(["cus_B"])
    expect(await ids({ query: "cus_B" })).toEqual(["cus_B"])
    const first = (await customersSearch({ limit: 1 }, ctx)) as {
      items: unknown[]
      nextCursor: string
    }
    expect(first.nextCursor).toBe("1")
    expect(await ids({ limit: 1, cursor: first.nextCursor })).toEqual(["cus_B"])
  })

  it("an unlinked customer whose email names a contact shows that contact as a suggestion to confirm", async () => {
    const { db } = world()
    const ANA = "33333333-3333-4333-8333-333333333333"
    const ctx = {
      db,
      executeTool: async (tool: string) =>
        tool === "kernel:contacts_search"
          ? {
              status: "completed" as const,
              result: { items: [{ id: ANA, primaryEmail: "ana@maison.example" }] },
            }
          : { status: "completed" as const, result: { items: [] } },
    }
    const one = (await customersGet({ id: "cus_A" }, ctx)) as Record<string, unknown>
    expect(one.contactSuggestion).toEqual({ contactId: ANA, email: "ana@maison.example" })
    expect(String(one.summary)).toContain(`contact ${ANA} has this email`)
    expect(String(one.summary)).toContain("customer_link")
  })
})
