// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BL-261 — the kernel `data_subject_export` tool compiles ONE data subject's records ACROSS apps
// (contact + tickets + invoices) into a single GDPR DSR bundle. Regression coverage for the
// bundle-assembly core: it returns the subject's REAL records (no fabrication), reflects an absent
// subject as NOT_FOUND, honestly EXCLUDES Shopify (a live connector with no local data) rather than
// inventing orders, and rejects a non-UUID contactId. Runs without a DB/storage — the SQL/file-write
// shell is exercised by the chaos gate; this pins the data-honesty + shape contract.
import { describe, expect, it } from "bun:test"
import {
  billingCustomerRecord,
  buildDataSubjectBundle,
  handleDataSubjectExport,
  scheduleRecord,
} from "~/modules/export/data-subject-export-tool"

const ORG = "00000000-0000-0000-0000-0000000000e1"
const CONTACT = "11111111-1111-1111-1111-111111111111"

interface FakeRows {
  contact?: Record<string, unknown>[]
  invoices?: Record<string, unknown>[]
  tickets?: Record<string, unknown>[]
  identity?: Record<string, unknown>[]
}

// A minimal RLS-client-shaped fake. The handler issues its reads in a FIXED order —
// (1) contact, (2) tickets (inside listForContact), (3) the invoicing tables probe, (4) invoices — so we route by call index. This is
// robust to how drizzle's SQL object stringifies (no brittle SQL-text matching). When the contact read
// returns [], the handler short-circuits NOT_FOUND before the ticket/invoice reads, which is correct.
function fakeDb(rows: FakeRows) {
  let call = 0
  return {
    execute: async () => {
      const idx = call++
      if (idx === 0) return rows.contact ?? []
      if (idx === 1) return rows.tickets ?? []
      // idx 2: the invoicing tables' existence probe, idx 3: the documents, idx 4: the identity row.
      if (idx === 2)
        return [
          {
            documents: "app_invoicing.documents",
            identities: rows.identity ? "app_invoicing.counterparty_identities" : null,
          },
        ]
      if (idx === 3) return rows.invoices ?? []
      return rows.identity ?? []
    },
  } as never
}

describe("buildDataSubjectBundle — DSR assembly [BL-261]", () => {
  const subjectRow = {
    id: CONTACT,
    handle: "qa-contact-claudine",
    name: "Claudine Moreau",
    email: "claudine.moreau@example.com",
    phone: null,
    company: "Moreau Film Scoring",
    external_ids: { country: "FR" },
    metadata: null,
    tags: ["vip"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-02-01T00:00:00.000Z",
  }

  it("assembles the subject's REAL contact + tickets + invoices and EXCLUDES Shopify honestly", async () => {
    const db = fakeDb({
      contact: [subjectRow],
      tickets: [
        {
          id: "t-1",
          handle: "gdpr-tkt-gain",
          subject: "Gain staging question on Kestrel 6",
          status: "closed",
          lastActivityAt: "2026-02-01T00:00:00.000Z",
        },
      ],
      invoices: [
        {
          id: "d-1",
          type: "invoice",
          status: "issued",
          number: "INV-2026-0209",
          currency: "EUR",
          grand_total_minor: "83880",
          issued_at: "2026-02-01T00:00:00.000Z",
          due_at: "2026-03-01T00:00:00.000Z",
        },
      ],
    })
    const bundle = await buildDataSubjectBundle(CONTACT, { orgId: ORG, userId: "u1", db })
    if ("error" in bundle) throw new Error(`expected a bundle, got error ${JSON.stringify(bundle)}`)

    expect(bundle.kind).toBe("gdpr_data_subject_export")
    expect(bundle.subject.email).toBe("claudine.moreau@example.com")
    expect(bundle.subject.name).toBe("Claudine Moreau")
    expect(bundle.counts).toEqual({
      tickets: 1,
      invoices: 1,
      recurringSchedules: 0,
      billingCustomers: 0,
      shopifyOrders: 0,
      memoryFiles: 0,
      memoryEpisodes: 0,
      memoryCheckpoints: 0,
    })
    expect(bundle.records.tickets[0].subject).toContain("Gain staging")
    expect(bundle.records.invoices[0].number).toBe("INV-2026-0209")
    expect(bundle.records.invoices[0].grandTotalMinor).toBe(83880)
    // Shopify is a live connector — NOT in the local bundle by default; the note must say so.
    expect(bundle.records.shopify.includedInBundle).toBe(false)
    expect(bundle.records.shopify.note.toLowerCase()).toContain("live connector")
    // No invented record types leaked into the bundle. `memory` is P4m-T32's
    // one appended section, following the same one-section-per-data-holder shape.
    expect(Object.keys(bundle.records).sort()).toEqual([
      "deals",
      "identity",
      "invoices",
      "memory",
      "payments",
      "recurringSchedules",
      "shopify",
      "tickets",
    ])
  })

  it("FOLDS agent-supplied live-connector Shopify orders into the ONE bundle (no second/fabricated file)", async () => {
    const db = fakeDb({ contact: [subjectRow], tickets: [], invoices: [] })
    // Order rows the agent retrieved via the shopify orders read and passes verbatim.
    const orders = [
      {
        id: 2199,
        name: "#2199",
        financial_status: "paid",
        total_price: "799.00",
        currency: "EUR",
        created_at: "2026-01-15T00:00:00.000Z",
      },
    ]
    const bundle = await buildDataSubjectBundle(CONTACT, { orgId: ORG, userId: "u1", db }, orders)
    if ("error" in bundle) throw new Error("expected a bundle when shopifyOrders are supplied")
    expect(bundle.records.shopify.includedInBundle).toBe(true)
    if (bundle.records.shopify.includedInBundle === true) {
      expect(bundle.records.shopify.source).toBe("live_connector_supplied")
      expect(bundle.records.shopify.orders).toHaveLength(1)
      expect(bundle.records.shopify.orders[0].name).toBe("#2199")
    }
    expect(bundle.counts.shopifyOrders).toBe(1)
  })

  it("returns NOT_FOUND when the data subject is not visible — never fabricates a subject", async () => {
    const db = fakeDb({ contact: [] })
    const bundle = await buildDataSubjectBundle(CONTACT, { orgId: ORG, userId: "u1", db })
    if (!("error" in bundle)) throw new Error("expected NOT_FOUND error for an invisible subject")
    expect(bundle.error.code).toBe("NOT_FOUND")
  })

  it("an empty-but-visible subject yields an empty-but-valid bundle (header, zero counts)", async () => {
    const db = fakeDb({ contact: [subjectRow], tickets: [], invoices: [] })
    const bundle = await buildDataSubjectBundle(CONTACT, { orgId: ORG, userId: "u1", db })
    if ("error" in bundle)
      throw new Error("expected a bundle for a visible subject with no records")
    expect(bundle.counts).toEqual({
      tickets: 0,
      invoices: 0,
      recurringSchedules: 0,
      billingCustomers: 0,
      shopifyOrders: 0,
      memoryFiles: 0,
      memoryEpisodes: 0,
      memoryCheckpoints: 0,
    })
    expect(bundle.records.tickets).toEqual([])
    expect(bundle.records.invoices).toEqual([])
    expect(bundle.records.shopify.includedInBundle).toBe(false)
  })

  it("the export bundle carries a memory section with the tree, episodes and checkpoints", async () => {
    const db = fakeDb({ contact: [subjectRow], tickets: [], invoices: [] })
    const bundle = await buildDataSubjectBundle(CONTACT, { orgId: ORG, userId: "u1", db })
    if ("error" in bundle) throw new Error("expected a bundle for a visible subject")
    // Three subsections, always present: an absent key reads as a bug, an
    // empty section reads as an answer.
    expect(Object.keys(bundle.records.memory).sort()).toEqual([
      "checkpoints",
      "episodes",
      "note",
      "tree",
    ])
    expect(Array.isArray(bundle.records.memory.tree)).toBe(true)
    expect(Array.isArray(bundle.records.memory.episodes)).toBe(true)
    expect(Array.isArray(bundle.records.memory.checkpoints)).toBe(true)
    expect(bundle.records.memory.note.length).toBeGreaterThan(10)
  })
})

describe("buildDataSubjectBundle — invoicing identity", () => {
  const subjectRow = {
    id: CONTACT,
    handle: "qa-contact-identity",
    name: "Fabrikam SAS",
    email: null,
    phone: null,
    company: "Fabrikam SAS",
    external_ids: {},
    metadata: null,
    tags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-02-01T00:00:00.000Z",
  }

  it("includes the identity under the caller's RLS", async () => {
    const db = fakeDb({
      contact: [subjectRow],
      identity: [
        {
          customer_kind: "business",
          siren: "123456782",
          siret: "12345678200002",
          vat_id: "FR40123456782",
          registry_name: "FABRIKAM",
          source: "registry",
          source_url: "https://registry.example/123456782",
          confirmed_via: "auto",
          secret_column: "never exported",
        },
      ],
    })
    const bundle = await buildDataSubjectBundle(CONTACT, { orgId: ORG, userId: "u1", db })
    if ("error" in bundle) throw new Error("expected a bundle")
    expect(bundle.records.identity).toEqual({
      kind: "business",
      siren: "123456782",
      siret: "12345678200002",
      vat_id: "FR40123456782",
      registry_name: "FABRIKAM",
      source: "registry",
      source_url: "https://registry.example/123456782",
    })
  })

  it("is null when the subject has no identity or the table is absent", async () => {
    const none = await buildDataSubjectBundle(CONTACT, {
      orgId: ORG,
      userId: "u1",
      db: fakeDb({ contact: [subjectRow], identity: [] }),
    })
    if ("error" in none) throw new Error("expected a bundle")
    expect(none.records.identity).toBeNull()
    const absent = await buildDataSubjectBundle(CONTACT, {
      orgId: ORG,
      userId: "u1",
      db: fakeDb({ contact: [subjectRow] }),
    })
    if ("error" in absent) throw new Error("expected a bundle")
    expect(absent.records.identity).toBeNull()
  })
})

describe("handleDataSubjectExport — param guard [BL-261]", () => {
  it("rejects a non-UUID contactId without touching storage", async () => {
    const db = fakeDb({})
    const r = await handleDataSubjectExport(
      { contactId: "not-a-uuid" },
      { orgId: ORG, userId: "22222222-2222-2222-2222-222222222222", db },
    )
    if (!("error" in r)) throw new Error("expected INVALID_PARAMS for a non-UUID contactId")
    expect(r.error.code).toBe("INVALID_PARAMS")
  })

  it("refuses a call with no member behind it before reading or storing anything", async () => {
    let reads = 0
    const db = {
      execute: async () => {
        reads++
        return []
      },
    } as never
    const r = await handleDataSubjectExport(
      { contactId: CONTACT },
      { orgId: ORG, userId: "system", db, scopes: ["kernel:data_subject:export"] },
    )
    if (!("error" in r)) throw new Error("expected REQUESTER_REQUIRED")
    expect(r.error.code).toBe("REQUESTER_REQUIRED")
    expect(r.error.message).toContain("nothing was exported or saved")
    expect(reads).toBe(0)
  })
})

describe("buildDataSubjectBundle — recurring schedules and payments customers", () => {
  it("a payments customer carries its subscriptions with brand, last 4 and expiry of the card, never more", () => {
    const customer = {
      mirror_id: "cus_maison1",
      email: "buyer@maison.example",
      name: "Maison Buyer",
      currency: "eur",
      delinquent: false,
      address: { city: "Lyon" },
      tax_ids: null,
      company_id: null,
      created_upstream_at: "2026-03-01T00:00:00.000Z",
      deleted_at: null,
      metadata: { internal: "never exported" },
    }
    const subscription = {
      mirror_id: "sub_maison1",
      customer_id: "cus_maison1",
      status: "active",
      plan_name: "Studio",
      mrr_minor: "4900",
      currency: "eur",
      current_period_start: "2026-11-01T00:00:00.000Z",
      current_period_end: "2026-12-01T00:00:00.000Z",
      trial_end: null,
      cancel_at: null,
      canceled_at: null,
      card_brand: "visa",
      card_last4: "4242",
      card_exp: "04/29",
      card_fingerprint: "never exported",
      items: [{ price: "never exported" }],
    }
    const other = { ...subscription, mirror_id: "sub_other", customer_id: "cus_other" }
    const record = billingCustomerRecord(customer, [subscription, other])
    expect(record).toEqual({
      id: "cus_maison1",
      email: "buyer@maison.example",
      name: "Maison Buyer",
      currency: "eur",
      delinquent: false,
      address: { city: "Lyon" },
      taxIds: null,
      companyId: null,
      createdAt: "2026-03-01T00:00:00.000Z",
      deletedAt: null,
      subscriptions: [
        {
          id: "sub_maison1",
          status: "active",
          planName: "Studio",
          mrrMinor: 4900,
          currency: "eur",
          currentPeriodStart: "2026-11-01T00:00:00.000Z",
          currentPeriodEnd: "2026-12-01T00:00:00.000Z",
          trialEnd: null,
          cancelAt: null,
          canceledAt: null,
          card: { brand: "visa", last4: "4242", exp: "04/29" },
        },
      ],
    })
  })

  it("a schedule carries what it bills and when, with days as dates", () => {
    const record = scheduleRecord({
      id: "5f0c0b8e-6f8d-4a37-9e1a-2f4b1c7d9e01",
      status: "ended",
      repeats: "month",
      billing_day: "1",
      ends_on: new Date("2026-10-31T00:00:00.000Z"),
      covers: "current",
      issue_mode: "review",
      paid_by: "transfer",
      due_rule: "days",
      due_days: 30,
      language: "fr",
      lines: [{ description: "Studio rent", quantity: 1 }],
      notes: null,
      paused_until: null,
      next_issue_on: null,
      company_id: null,
      created_at: "2026-01-05T00:00:00.000Z",
      card_link_url: "never exported",
    })
    expect(record.endsOn).toBe("2026-10-31")
    expect(record.status).toBe("ended")
    expect(record.lines).toEqual([{ description: "Studio rent", quantity: 1 }])
    expect(Object.keys(record)).not.toContain("cardLinkUrl")
  })
})
