// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Recipient-completeness rule — a document cannot be ISSUED without a complete
// counterparty (legal_name + country + address + email).
//
// Two distinct defects are pinned here, both reported from production:
//
//   1. The DROPPED SNAPSHOT. Every draft-based issue path built its counterparty from a
//      hardcoded stub (`legal_name: "Customer"`, `address: null`, `email: null`) instead of the
//      draft row's own counterparty_* columns. An operator who filled the editor's Customer
//      section got an issued invoice addressed to "Customer" with no address and no email.
//   2. The MISSING GATE. Nothing refused an issuance whose recipient was blank, so a document
//      with no recipient name at all could be issued, numbered, rendered and sent.
//
// Both are asserted through the PUBLIC handlers (drafts_create -> invoice_issue) and against the
// persisted `documents` row, not against the helper in isolation, so a future refactor that
// reintroduces a stub anywhere in that chain fails here.

import { describe, expect, test } from "bun:test"
import {
  type Counterparty,
  CounterpartyIncompleteError,
  counterpartyCompletenessError,
  type IssueCtx,
  type IssueInput,
  type IssuerProfile,
  issueDocument,
} from "./issue"
import { draftsCreate, invoiceCreateAndIssue, invoiceIssue, type MutationsCtx } from "./mutations"
import { createMockDb, type MockDb } from "./test-db"
import { testTime } from "./test-time"

const issuer: IssuerProfile = {
  id: "iss-1",
  legal_name: "Acme SAS",
  country: "FR",
  vat_id: "FR12345678901",
  address: "1 rue Test, 75001 Paris",
  iban: null,
  swift_bic: null,
  bank_name: null,
  default_language: "fr",
  prefix_invoice: "INV-{YYYY}-",
  prefix_quote: "QUO-{YYYY}-",
  prefix_proforma: "PRO-{YYYY}-",
  prefix_po: "PO-{YYYY}-",
  prefix_credit_note: "CN-{YYYY}-",
}

/** A complete recipient — every field the rule requires. */
const completeRecipient = {
  counterparty_contact_id: "contact-1",
  counterparty_name: "Klangwerk GmbH",
  counterparty_address: "Rheinallee 4, 40545 Duesseldorf, Germany",
  counterparty_vat_id: "DE298765432",
  counterparty_email: "billing@klangwerk.example",
  counterparty_country: "DE",
}

const sampleItems = [
  {
    position: 1,
    description: "Widget",
    quantity: "2",
    unit_price_minor: 5_000n,
    product_source: null,
    external_id: null,
  },
]

function seedIssuerRow(): Record<string, unknown> {
  return {
    id: issuer.id,
    legal_name: issuer.legal_name,
    country: issuer.country,
    vat_id: issuer.vat_id,
    address: issuer.address,
    iban: issuer.iban,
    swift_bic: issuer.swift_bic,
    bank_name: issuer.bank_name,
    default_language: issuer.default_language,
    prefix_invoice: issuer.prefix_invoice,
    prefix_quote: issuer.prefix_quote,
    prefix_proforma: issuer.prefix_proforma,
    prefix_po: issuer.prefix_po,
    prefix_credit_note: issuer.prefix_credit_note,
    invoice_approval_threshold_minor: null,
    po_approval_threshold_minor: null,
    require_two_eyes: false,
    mail_account_id: "acct-mail-1",
  }
}

function makeCtx(): { ctx: MutationsCtx; db: MockDb } {
  const db = createMockDb({ seed: { issuer_profiles: [seedIssuerRow()] } })
  let idSeq = 0
  const ctx: MutationsCtx = {
    getUserId: async () => "user-1",
    approval: null,
    db,
    time: testTime(),
    pdf: {
      async render() {
        return {
          file_id: `pdf-${++idSeq}`,
          byte_size: 1024,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: {
      async post() {
        return { message_id: `msg-${++idSeq}` }
      },
    },
    requestApproval: async () => ({ approval_id: `appr-${++idSeq}` }),
    decideApproval: async () => ({ status: "ok" }),
    executeTool: async (name: string) =>
      // No Stripe app here: the kernel answers an absent app's tool as not found.
      name.startsWith("stripe:")
        ? {
            status: "error" as const,
            error: { code: "tool_not_found", message: "tool not registered" },
          }
        : { status: "completed", result: {} },
    emit: async () => {},
  }
  return { ctx, db }
}

function issued(db: MockDb): Array<Record<string, unknown>> {
  return db.__all("documents").filter((d) => d.status !== "draft")
}

// ── The rule itself ───────────────────────────────────────────────────────

describe("counterpartyCompletenessError", () => {
  const complete: Counterparty = {
    contact_id: "contact-1",
    legal_name: "Klangwerk GmbH",
    country: "DE",
    vat_id: null,
    address: "Rheinallee 4, 40545 Duesseldorf",
    email: "billing@klangwerk.example",
  }

  test("accepts a complete recipient", () => {
    expect(counterpartyCompletenessError(complete)).toBeNull()
  })

  for (const field of ["legal_name", "country", "address", "email"] as const) {
    test(`refuses a recipient with no ${field}`, () => {
      const err = counterpartyCompletenessError({ ...complete, [field]: null })
      expect(err?.code).toBe("counterparty_incomplete")
      expect(err?.message).toContain(field)
    })

    test(`refuses a recipient whose ${field} is whitespace only`, () => {
      // A blank string is not a recipient: "   " must fail exactly like null, or the UI can
      // satisfy the rule with an empty text input.
      const err = counterpartyCompletenessError({ ...complete, [field]: "   " })
      expect(err?.code).toBe("counterparty_incomplete")
    })
  }

  test("names every missing field, not just the first", () => {
    const err = counterpartyCompletenessError({
      ...complete,
      address: null,
      email: null,
    })
    expect(err?.message).toContain("address")
    expect(err?.message).toContain("email")
  })
})

// ── The issuance seam (backstop) ──────────────────────────────────────────

describe("issueDocument recipient backstop", () => {
  function issueCtx(db: MockDb): IssueCtx {
    let idSeq = 0
    return {
      getUserId: async () => "user-1",
      db,
      time: testTime(),
      pdf: {
        async render() {
          return {
            file_id: `pdf-${++idSeq}`,
            byte_size: 1024,
            page_count: 1,
            sha256: "0".repeat(64),
            parent_entity_id: crypto.randomUUID(),
          }
        },
      },
      messages: {
        async post() {
          return { message_id: `msg-${++idSeq}` }
        },
      },
      executeTool: async (name: string) =>
        // No Stripe app here: the kernel answers an absent app's tool as not found.
        name.startsWith("stripe:")
          ? {
              status: "error" as const,
              error: { code: "tool_not_found", message: "tool not registered" },
            }
          : { status: "completed", result: {} },
      emit: async () => {},
    } as unknown as IssueCtx
  }

  function input(counterparty: Counterparty): IssueInput {
    return {
      type: "invoice",
      issuer,
      counterparty,
      draft: {
        currency: "EUR",
        incoterm: "DAP",
        year_of_issue: 2026,
        issued_at: "2026-05-15",
        due_at: null,
        external_refs: {},
        lines: sampleItems,
      },
    }
  }

  test("throws CounterpartyIncompleteError and persists NOTHING when the recipient is incomplete", async () => {
    const db = createMockDb({ seed: {} })
    await expect(
      issueDocument(
        issueCtx(db),
        input({
          contact_id: null,
          legal_name: "",
          country: "FR",
          vat_id: null,
          address: null,
          email: null,
        }),
      ),
    ).rejects.toBeInstanceOf(CounterpartyIncompleteError)
    // The refusal must come BEFORE number allocation and the document insert: a rejected
    // issuance may not burn a gap-free invoice number nor leave a half-written row.
    expect(db.__all("documents")).toHaveLength(0)
  })
})

// ── The handler paths (the reported defects) ──────────────────────────────

describe("draft-based issuance carries the draft's recipient", () => {
  test("invoice_issue issues to the DRAFT's recipient, not a 'Customer' stub", async () => {
    const { ctx, db } = makeCtx()
    const created = await draftsCreate(ctx, {
      type: "invoice",
      issuer_profile_id: issuer.id,
      currency: "EUR",
      items: sampleItems,
      ...completeRecipient,
    } as never)
    const draftId = created.draft_id

    const result = await invoiceIssue(ctx, { draft_id: draftId })
    expect(result.status).toBe("completed")

    const doc = issued(db)[0]
    // Was: "Customer" / null / null — the stub dropped the whole snapshot.
    expect(doc?.counterparty_name).toBe("Klangwerk GmbH")
    expect(doc?.counterparty_address).toBe("Rheinallee 4, 40545 Duesseldorf, Germany")
    expect(doc?.counterparty_email).toBe("billing@klangwerk.example")
    expect(doc?.counterparty_vat_id).toBe("DE298765432")
    expect(doc?.counterparty_country).toBe("DE")
  })

  test("drafts_create given only a contact takes the recipient from that contact, and the draft issues", async () => {
    const { ctx, db } = makeCtx()
    // A German company: its VAT number is checked in VIES (stubbed valid).
    ctx.fetch = async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        isValid: true,
        userError: "VALID",
        name: "KLANGWERK GMBH",
        address: "---",
      }),
    })
    await db.insert("counterparty_identities", {
      contact_id: "contact-9",
      customer_kind: "business",
      vat_id: "DE298765432",
    })
    const reads: Record<string, unknown> = {
      "kernel:contacts_read": {
        contact: {
          id: "contact-9",
          name: "Lena Vogel",
          company: "Klangwerk GmbH",
          email: "billing@klangwerk.example",
        },
      },
      "kernel:contacts_addresses_list": {
        addresses: [
          {
            role: "delivery",
            street1: "Lagerweg 2",
            postalCode: "40549",
            city: "Duesseldorf",
            countryIso2: "DE",
          },
          {
            role: "billing",
            street1: "Rheinallee 4",
            postalCode: "40545",
            city: "Duesseldorf",
            countryIso2: "de",
          },
        ],
      },
    }
    const base = ctx.executeTool
    ctx.executeTool = async (name, args) =>
      name in reads ? { status: "completed", result: reads[name] } : base(name, args)
    const created = await draftsCreate(ctx, {
      type: "invoice",
      issuer_profile_id: issuer.id,
      currency: "EUR",
      items: sampleItems,
      counterparty_contact_id: "contact-9",
    } as never)
    const draft = db.__all("documents").find((d) => d.id === created.draft_id)
    expect(draft).toMatchObject({
      counterparty_name: "Klangwerk GmbH",
      counterparty_address: "Rheinallee 4, 40545 Duesseldorf",
      counterparty_country: "DE",
      counterparty_email: "billing@klangwerk.example",
      counterparty_vat_id: "DE298765432",
    })
    const result = await invoiceIssue(ctx, { draft_id: created.draft_id })
    expect(result).toMatchObject({ status: "completed" })
    expect(issued(db)[0]).toMatchObject({
      counterparty_name: "Klangwerk GmbH",
      counterparty_address: "Rheinallee 4, 40545 Duesseldorf",
    })
    expect(issued(db)[0]).toMatchObject({
      billing_line1: "Rheinallee 4",
      billing_postcode: "40545",
      billing_city: "Duesseldorf",
      billing_country_code: "DE",
    })
  })

  test("drafts_create keeps what the caller typed and fills only what is missing from the contact", async () => {
    const { ctx, db } = makeCtx()
    const base = ctx.executeTool
    ctx.executeTool = async (name, args) =>
      name === "kernel:contacts_read"
        ? {
            status: "completed",
            result: {
              contact: { id: "contact-9", name: "Lucie Brume", email: "lucie@brume.example" },
            },
          }
        : base(name, args)
    const created = await draftsCreate(ctx, {
      type: "invoice",
      issuer_profile_id: issuer.id,
      currency: "EUR",
      items: sampleItems,
      counterparty_contact_id: "contact-9",
      counterparty_name: "Brume Holding",
    } as never)
    expect(db.__all("documents").find((d) => d.id === created.draft_id)).toMatchObject({
      counterparty_name: "Brume Holding",
      counterparty_email: "lucie@brume.example",
      counterparty_address: null,
    })
  })

  test("invoice_issue REFUSES a draft with no recipient name, and issues nothing", async () => {
    const { ctx, db } = makeCtx()
    const created = await draftsCreate(ctx, {
      type: "invoice",
      issuer_profile_id: issuer.id,
      currency: "EUR",
      items: sampleItems,
      counterparty_contact_id: "contact-1",
      // No name, no address, no email — exactly the state that used to issue happily.
    } as never)
    const draftId = created.draft_id

    const result = await invoiceIssue(ctx, { draft_id: draftId })
    expect(result.status).toBe("error")
    expect((result as { error: { code: string } }).error.code).toBe("counterparty_incomplete")
    expect(issued(db)).toHaveLength(0)
    // The draft survives so the operator can complete it and re-issue.
    expect(db.__all("documents").filter((d) => d.status === "draft")).toHaveLength(1)
  })

  test("invoice_issue REFUSES a draft that has a name but no address or email", async () => {
    const { ctx, db } = makeCtx()
    // A German company: the intra-EU business-buyer guard wants its VAT number (VIES stubbed
    // valid), so the draft saves and the test reaches the missing address and email.
    ctx.fetch = async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        isValid: true,
        userError: "VALID",
        name: "KLANGWERK GMBH",
        address: "---",
      }),
    })
    const created = await draftsCreate(ctx, {
      type: "invoice",
      issuer_profile_id: issuer.id,
      currency: "EUR",
      items: sampleItems,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Klangwerk GmbH",
      counterparty_country: "DE",
      counterparty_vat_id: "DE123456789",
    } as never)
    const draftId = created.draft_id

    const result = await invoiceIssue(ctx, { draft_id: draftId })
    expect(result.status).toBe("error")
    const message = (result as { error: { message: string } }).error.message
    expect(message).toContain("address")
    expect(message).toContain("email")
    expect(issued(db)).toHaveLength(0)
  })
})

describe("create-and-issue rejects an incomplete recipient", () => {
  test("invoice_create_and_issue refuses a counterparty with no email", async () => {
    const { ctx, db } = makeCtx()
    const result = await invoiceCreateAndIssue(ctx, {
      counterparty: {
        contact_id: null,
        legal_name: "Klangwerk GmbH",
        country: "DE",
        vat_id: null,
        address: "Rheinallee 4, 40545 Duesseldorf",
      },
      issuer_profile_id: issuer.id,
      currency: "EUR",
      items: sampleItems,
    } as never)
    expect(result.status).toBe("error")
    expect((result as { error: { code: string } }).error.code).toBe("counterparty_incomplete")
    expect(db.__all("documents")).toHaveLength(0)
  })

  test("invoice_create_and_issue refuses a counterparty with a blank name", async () => {
    const { ctx, db } = makeCtx()
    const result = await invoiceCreateAndIssue(ctx, {
      counterparty: {
        contact_id: null,
        legal_name: "  ",
        country: "DE",
        vat_id: null,
        address: "Rheinallee 4, 40545 Duesseldorf",
        email: "billing@klangwerk.example",
      },
      issuer_profile_id: issuer.id,
      currency: "EUR",
      items: sampleItems,
    } as never)
    expect(result.status).toBe("error")
    expect((result as { error: { code: string } }).error.code).toBe("counterparty_incomplete")
    expect(db.__all("documents")).toHaveLength(0)
  })

  test("invoice_create_and_issue accepts a complete counterparty", async () => {
    const { ctx, db } = makeCtx()
    const result = await invoiceCreateAndIssue(ctx, {
      counterparty: {
        contact_id: "contact-1",
        legal_name: "Klangwerk GmbH",
        country: "DE",
        vat_id: "DE298765432",
        address: "Rheinallee 4, 40545 Duesseldorf",
        email: "billing@klangwerk.example",
      },
      issuer_profile_id: issuer.id,
      currency: "EUR",
      items: sampleItems,
    } as never)
    expect(result.status).toBe("completed")
    const doc = issued(db)[0]
    expect(doc?.counterparty_name).toBe("Klangwerk GmbH")
    expect(doc?.counterparty_email).toBe("billing@klangwerk.example")
  })
})
