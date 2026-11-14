// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Finding a customer's earlier sale and its price. The case: the user names a person ("the same
// price as last time for Brenna Valdi") whose invoice was made out to a company, the person
// appearing only in the invoice's address; the order in the store carries the person's name. A
// name-only search answered "no previous invoice" (fixtures are invented).

import { describe, expect, test } from "bun:test"
import { createMockDb } from "@liaison/test-helpers/mock-db"
import manifest from "../app.manifest.json"
import type { CrossAppEnvelope } from "./cross-app"
import { customerHistory } from "./customer-history"
import { documentsSearch, documentsSearchTool, type ReadsCtx } from "./reads"

const INVOICE_ID = "6d1f2c3a-1b2c-4d5e-8f90-0a1b2c3d4e01"
const OTHER_ID = "6d1f2c3a-1b2c-4d5e-8f90-0a1b2c3d4e02"
const OLD_ID = "6d1f2c3a-1b2c-4d5e-8f90-0a1b2c3d4e03"
const CONTACT_ID = "7e2a3b4c-2c3d-4e5f-9a01-1b2c3d4e5f60"

const invoice = {
  id: INVOICE_ID,
  type: "invoice",
  status: "issued",
  number: "3107",
  number_int: 3107,
  counterparty_name: "Lantern Hollow Records SRL",
  counterparty_address: "Ottavio Brenna Valdi, Via Esempio Nuova, 8, 10124 Torino",
  counterparty_country: "IT",
  currency: "EUR",
  grand_total_minor: "72000",
  issued_at: "2026-09-12",
  external_refs: { shopify_order_number: "3107" },
}
// A newer document whose customer only shares a PART of a term ("valdi" inside "Valdina").
const other = {
  id: OTHER_ID,
  type: "invoice",
  status: "issued",
  number: "INV-2026-0210",
  number_int: 210,
  counterparty_name: "Valdina Havet",
  counterparty_address: "3 rue Imaginaire, 69002 Lyon",
  counterparty_country: "FR",
  currency: "EUR",
  grand_total_minor: "15000",
  issued_at: "2026-10-20",
}
// An imported invoice whose order reference lives only in external_refs.
const old = {
  id: OLD_ID,
  type: "invoice",
  status: "issued",
  number: "INV-2025-0007",
  number_int: 7,
  counterparty_name: "Fenwick Tolle",
  counterparty_email: "hello@fenwick-tolle.example",
  counterparty_address: "12 Quay Lane, 2011 Exampleton",
  currency: "EUR",
  grand_total_minor: "9900",
  issued_at: "2025-03-02",
  external_refs: { shopify_order_number: "4821" },
}
const lines = [
  {
    id: "8f3b4c5d-3d4e-4f60-8b12-2c3d4e5f6071",
    document_id: INVOICE_ID,
    position: 1,
    description: "Ondine MK2 desktop synthesizer",
    // The way an imported invoice carries a dealer price: the list price per unit and a line
    // discount (2 x 130.83), so only subtotal / quantity is the price actually paid.
    quantity: "2",
    unit_price_minor: "49083",
    discount_minor: "26166",
    subtotal_minor: "72000",
    total_minor: "72000",
  },
  {
    id: "8f3b4c5d-3d4e-4f60-8b12-2c3d4e5f6072",
    document_id: OTHER_ID,
    position: 1,
    description: "Patch cable set",
    quantity: "1",
    unit_price_minor: "15000",
    discount_minor: "0",
    total_minor: "15000",
  },
]

function ok(result: unknown): CrossAppEnvelope {
  return { status: "completed", result } as CrossAppEnvelope
}

function makeCtx(
  opts: { tools?: Record<string, (args: Record<string, unknown>) => unknown> } = {},
) {
  const db = createMockDb(
    { seed: { documents: [invoice, other, old], document_lines: lines } },
    { bridgeWhereOperators: true },
  )
  const calls: Array<{ target: string; args: Record<string, unknown> }> = []
  const ctx: ReadsCtx = {
    db: {
      findMany: (entity, o) => db.findMany(entity, o),
      findOne: (entity, id) => db.findOne(entity, id),
      count: (entity, o) => db.count(entity, o),
    },
    kernel: { listApprovals: async () => [] },
    executeTool: async (target, args) => {
      calls.push({ target, args })
      const handler = opts.tools?.[target]
      if (!handler)
        return {
          status: "error",
          error: { code: "tool_not_found", message: "not installed" },
        } as CrossAppEnvelope
      return ok(handler(args))
    },
  }
  return { ctx, calls }
}

describe("documents_search finds a customer named only in the address", () => {
  test("the person's name finds the company-named invoice by its address", async () => {
    const { ctx } = makeCtx()
    const rows = await documentsSearch(ctx, { query: "brenna valdi" })
    expect(rows.map((r) => r.number)).toEqual(["3107"])
  })

  test("a whole-word match ranks above a partial-term match, however new", async () => {
    // The bridge's any-term fallback can hand back a row where only part of a term matches
    // ("valdi" inside "Valdina"), newest first; the ranking puts the real customer first.
    const { ctx } = makeCtx()
    const base = ctx.db
    ctx.db = {
      ...base,
      findMany: async (entity, o) =>
        entity === "documents" && o?.search ? [other, invoice] : base.findMany(entity, o),
    }
    const rows = await documentsSearch(ctx, { query: "Brenna Valdi" })
    expect(rows.map((r) => r.number)).toEqual(["3107", "INV-2026-0210"])
  })

  test("a product name finds the invoice through its line descriptions", async () => {
    const { ctx } = makeCtx()
    const rows = await documentsSearch(ctx, { query: "ondine mk2" })
    expect(rows.map((r) => r.number)).toEqual(["3107"])
  })

  test("an order reference kept only in external_refs is found", async () => {
    const { ctx } = makeCtx()
    const rows = await documentsSearch(ctx, { query: "#4821" })
    expect(rows.map((r) => r.number)).toEqual(["INV-2025-0007"])
  })

  test("contact_id also returns the documents made out to the contact's email or address", async () => {
    const { ctx } = makeCtx({
      tools: {
        "kernel:contacts_read": () => ({
          contact: { id: CONTACT_ID, email: "hello@fenwick-tolle.example" },
        }),
        "kernel:contacts_addresses_list": () => ({
          addresses: [
            {
              street1: "Via Esempio Nuova 8",
              postalCode: "10124",
              city: "Torino",
              countryIso2: "IT",
            },
          ],
        }),
      },
    })
    const rows = await documentsSearch(ctx, { contact_id: CONTACT_ID })
    expect(rows.map((r) => r.number).sort()).toEqual(["3107", "INV-2025-0007"])
  })

  test("a query that finds nothing hints customer_history with the name", async () => {
    const { ctx } = makeCtx()
    const result = await documentsSearchTool(ctx, { query: "Nobody Atall" })
    expect(Array.isArray(result)).toBe(false)
    const r = result as { results: unknown[]; hint: string }
    expect(r.results).toEqual([])
    expect(r.hint).toContain('invoicing__customer_history with customer="Nobody Atall"')
    // A hit keeps the bare array other apps and the UI read.
    expect(Array.isArray(await documentsSearchTool(ctx, { query: "3107" }))).toBe(true)
  })

  test("a number no document carries says so and names the numbers ending in the same digits", async () => {
    const { ctx } = makeCtx()
    const r = (await documentsSearchTool(ctx, { type: "invoice", query: "F-2025-0007" })) as {
      results: unknown[]
      hint: string
    }
    expect(r.results).toEqual([])
    expect(r.hint).toContain('No document is numbered "F-2025-0007"')
    expect(r.hint).toContain("INV-2025-0007")
    expect(r.hint).toContain('None of them is "F-2025-0007"')
    expect(r.hint).not.toContain("customer_history")
  })

  test("a number with no close match says that too", async () => {
    const { ctx } = makeCtx()
    const r = (await documentsSearchTool(ctx, { query: "F-2026-9999" })) as { hint: string }
    expect(r.hint).toBe(
      'No document is numbered "F-2026-9999". No document number ends in 9999 either.',
    )
  })
})

describe("customer_history", () => {
  test("returns the last sale of the product with its unit price, and the matching Shopify order", async () => {
    const { ctx, calls } = makeCtx({
      tools: {
        "shopify:orders_search": () => ({
          results: [
            {
              id: "gid://shopify/Order/9001",
              title: "#3107",
              currency: "EUR",
              attributes: {
                createdAt: "2026-09-10T10:00:00Z",
                totalAmount: "720.00",
                customer: { firstName: "Ottavio", lastName: "Brenna Valdi" },
                lineItems: [{ title: "Ondine MK2", quantity: 2 }],
              },
            },
          ],
        }),
      },
    })
    const h = await customerHistory(ctx, { customer: "Brenna Valdi", product: "Ondine MK2" })
    expect(h.last_sale).toMatchObject({
      unit_price: "360.00 EUR",
      unit_price_minor: "36000",
      list_unit_price: "490.83 EUR",
      quantity: "2",
      document: "3107",
      document_type: "invoice",
    })
    expect(h.documents.map((d) => d.number)).toEqual(["3107"])
    expect(h.shopify).toBe("checked")
    expect(h.shopify_orders.map((o) => o.order)).toEqual(["#3107"])
    const queries = calls
      .filter((c) => c.target === "shopify:orders_search")
      .map((c) => c.args.query)
    expect(queries).toContain('"Brenna Valdi"')
    expect(queries).toContain("name:#3107")
  })

  test("says plainly when nothing is found, and Shopify not installed is not an error", async () => {
    const { ctx } = makeCtx()
    const h = await customerHistory(ctx, { customer: "Nobody Atall" })
    expect(h.documents).toEqual([])
    expect(h.last_sale).toBeNull()
    expect(h.shopify).toBe("not connected")
    expect(h.note).toContain('Nothing found for "Nobody Atall"')
  })

  test("lists the schedules that bill the customer, and says a lasting price change is made on the schedule", async () => {
    const draft = {
      ...other,
      id: "6d1f2c3a-1b2c-4d5e-8f90-0a1b2c3d4e09",
      status: "draft",
      number: null,
      counterparty_name: "Quillmere Studio",
      counterparty_contact_id: CONTACT_ID,
    }
    const schedule = (id: string, status: string) => ({
      id,
      contact_id: CONTACT_ID,
      status,
      repeats: "month",
      billing_day: "1",
      next_issue_on: "2026-12-01",
      lines: [{ description: "Monthly retainer, {period}", qty: 1, unit_price_minor: 55000 }],
      version: 1,
    })
    const db = createMockDb(
      {
        seed: {
          documents: [draft],
          document_lines: [],
          recurring_schedules: [
            schedule("9a1b2c3d-0000-4000-8000-000000000001", "active"),
            schedule("9a1b2c3d-0000-4000-8000-000000000002", "ended"),
          ],
        },
      },
      { bridgeWhereOperators: true },
    )
    const ctx: ReadsCtx = {
      db: {
        findMany: (e, o) => db.findMany(e, o),
        findOne: (e, id) => db.findOne(e, id),
        count: (e, o) => db.count(e, o),
      },
      kernel: { listApprovals: async () => [] },
    }
    const h = await customerHistory(ctx, { customer: "Quillmere" })
    expect(h.recurring_schedules).toEqual([
      {
        id: "9a1b2c3d-0000-4000-8000-000000000001",
        status: "active",
        repeats: "month",
        next_issue_on: "2026-12-01",
        lines: [
          { description: "Monthly retainer, {period}", quantity: "1", unit_price_minor: "55000" },
        ],
      },
    ])
    expect(h.note).toContain("recurring_schedule_update")
    expect(h.note).toContain("drafts_update")
  })

  test("a customer with no schedule gets no schedule note", async () => {
    const { ctx } = makeCtx()
    const h = await customerHistory(ctx, { customer: "brenna valdi" })
    expect(h.recurring_schedules).toEqual([])
    expect(h.note).not.toContain("recurring_schedule_update")
  })
})

describe("manifest", () => {
  const tools = (
    manifest as unknown as { tools: Record<string, { description?: string; handler?: string }> }
  ).tools
  test("customer_history is declared and says it answers 'same price as last time'", () => {
    expect(tools.customer_history?.handler).toBe("customerHistoryHandler")
    expect(tools.customer_history?.description).toContain("same price as last time")
    expect(tools.documents_search?.description).toContain("customer_history")
  })

  test("the document search index carries the address, email, external order reference and lines", () => {
    const doc = (
      manifest as unknown as {
        entities: Record<
          string,
          {
            indexFields?: {
              bodyFields?: string[]
              bodyFrom?: { tableName: string; columns: string[] }
            }
          }
        >
      }
    ).entities.document
    expect(doc?.indexFields?.bodyFields).toEqual(
      expect.arrayContaining([
        "counterparty_address",
        "counterparty_email",
        "external_refs.shopify_order_number",
      ]),
    )
    expect(doc?.indexFields?.bodyFrom).toMatchObject({
      tableName: "document_lines",
      columns: ["description"],
    })
  })
})
