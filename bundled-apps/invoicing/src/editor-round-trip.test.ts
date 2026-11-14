// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Editor open -> save -> issue round trip, exercised against the REAL
// reads.ts / mutations.ts / ui/index.ts / ui/Editor.ts functions (no jsdom,
// no semantic mocks — same createMockDb generic-CRUD surface as
// reads.test.ts / mutations.test.ts).
//
// Regression: documents_get (reads.ts:354, before the fix) collapsed a
// line's NULL tax_rate_bp (no per-line override -> follow the issuer's
// classified rate) into 0 (an explicit zero-percent exemption). The Editor
// echoed that 0 straight back as `tax_rate_bp_override: 0` on save
// (ui/Editor.tsx buildItems), and mutations.ts honours an explicit 0 the
// same as any deliberate exemption (issue.ts / mutations.ts recomputeLines),
// so a document that had NEVER had its VAT touched lost it entirely the
// moment an operator merely opened and saved it: a 299.00 quote under a
// tax-inclusive FR issuer issued at 249.17 with no VAT line at all.
//
// These tests drive the WHOLE chain a real operator triggers: draftsCreate
// (typed gross price, no override) -> documentsGet (the Editor's load) ->
// mapDocumentToDraft/mapLine (the Editor's own state) -> buildItems (what
// the Editor sends back) -> draftsUpdate (an unchanged save) -> invoiceIssue
// -> assert the PERSISTED row and the ISSUED totals, not any component's
// internal state.

import { describe, expect, test } from "bun:test"
import { FICTIONAL_SIRENS } from "./einvoicing/test-fixtures"
import type { Counterparty, IssuerProfile } from "./issue"
import { draftsCreate, draftsUpdate, invoiceIssue, type MutationsCtx } from "./mutations"
import { documentsGet, type ReadsCtx } from "./reads"
import { createMockDb, type MockDb } from "./test-db"
import { testTime } from "./test-time"
import type { DocumentLine as DetailDocumentLine, DocumentSummary } from "./ui/DocumentDetail"
import {
  applyNetToGrossOnLoad,
  buildItems,
  type DraftLine,
  type EditorIssuerProfile,
} from "./ui/Editor"
import { mapDocumentToDraft } from "./ui/index"

const inclusiveIssuer: IssuerProfile = {
  id: "iss-1",
  legal_name: "Acme SAS",
  country: "FR",
  vat_id: "FR12345678901",
  address: "1 rue Test",
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

const defaultCounterparty: Counterparty = {
  contact_id: "contact-1",
  legal_name: "Buyer SARL",
  country: "FR",
  vat_id: null,
  address: "1 rue Buyer, 75002 Paris",
  email: "ap@buyersarl.example",
}

function makeCtx(): { ctx: MutationsCtx; readsCtx: ReadsCtx; db: MockDb } {
  const db = createMockDb({
    seed: {
      issuer_profiles: [
        {
          id: inclusiveIssuer.id,
          legal_name: inclusiveIssuer.legal_name,
          country: inclusiveIssuer.country,
          vat_id: inclusiveIssuer.vat_id,
          address: inclusiveIssuer.address,
          iban: null,
          swift_bic: null,
          bank_name: null,
          default_language: inclusiveIssuer.default_language,
          prefix_invoice: inclusiveIssuer.prefix_invoice,
          prefix_quote: inclusiveIssuer.prefix_quote,
          prefix_proforma: inclusiveIssuer.prefix_proforma,
          prefix_po: inclusiveIssuer.prefix_po,
          prefix_credit_note: inclusiveIssuer.prefix_credit_note,
          invoice_approval_threshold_minor: null,
          po_approval_threshold_minor: null,
          require_two_eyes: false,
          mail_account_id: "acct-mail-1",
          prices_include_tax: true,
        },
      ],
      // E-invoicing gate in enforce mode.
      einvoicing_settings: [{ gate_mode: "enforce", gate_mode_source: "config" }],
      // The French business buyer: a registry-confirmed identity on its contact.
      counterparty_identities: [
        {
          contact_id: "contact-1",
          customer_kind: "business",
          siren: FICTIONAL_SIRENS[0],
          registry_name: "Buyer SARL",
          registry_status: "A",
          source: "registry",
          confirmed_via: "auto",
        },
      ],
    },
  })
  const ctx: MutationsCtx = {
    getUserId: async () => "user-1",
    approval: null,
    db,
    time: testTime(),
    pdf: {
      async render() {
        return {
          file_id: "pdf-1",
          byte_size: 1024,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: {
      async post() {
        return { message_id: "msg-1" }
      },
    },
    requestApproval: async () => ({ approval_id: "appr-1" }),
    decideApproval: async () => ({ status: "error", error: { code: "not_found", message: "n/a" } }),
    executeTool: async (name: string) =>
      // No Stripe app here: the kernel answers an absent app's tool as not found.
      name.startsWith("stripe:")
        ? {
            status: "error" as const,
            error: { code: "tool_not_found", message: "tool not registered" },
          }
        : { status: "completed", result: { dispatched: true } },
    emit: async () => {},
  }
  const readsCtx: ReadsCtx = {
    db,
    kernel: {
      async listApprovals() {
        return []
      },
    },
  }
  return { ctx, readsCtx, db }
}

/** What the real Editor does between load and save: reuse `documentsGet` +
 *  `mapDocumentToDraft` (the Editor's load), then `grossUpLinesForDisplay`
 *  (the Editor's net -> gross boundary once an inclusive issuer resolves —
 *  `applyNetToGrossOnLoad` in ui/Editor.tsx), then `buildItems` (what an
 *  unedited "Save" sends). */
async function openEditSave(
  readsCtx: ReadsCtx,
  ctx: MutationsCtx,
  draftId: string,
  editLine?: (l: DraftLine) => DraftLine,
) {
  const doc = await documentsGet(readsCtx, { id: draftId })
  if (!doc) throw new Error("document not found")
  let draft = mapDocumentToDraft(
    doc as unknown as DocumentSummary,
    doc.lines as unknown as DetailDocumentLine[],
  )
  const issuerProfiles: EditorIssuerProfile[] = [
    {
      id: inclusiveIssuer.id,
      legal_name: inclusiveIssuer.legal_name,
      country: inclusiveIssuer.country,
      vat_id: inclusiveIssuer.vat_id,
      prices_include_tax: true,
    },
  ]
  applyNetToGrossOnLoad({
    initialId: doc.id,
    getDraft: () => draft,
    setDraft: (next) => {
      draft = next
    },
    getIssuerProfiles: () => issuerProfiles,
  })
  const lines = editLine ? draft.lines.map(editLine) : draft.lines
  const patched = { ...draft, lines }
  return draftsUpdate(ctx, { draft_id: draftId, patch: { lines: buildItems(patched) } })
}

describe("Editor open -> save -> issue round trip (tax-inclusive issuer)", () => {
  test("an unchanged open-and-save keeps the issuer's VAT: 299.00 issues at 299.00 with VAT, not 249.17 with none", async () => {
    const { ctx, readsCtx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      operation_category: "goods",
      billing_line1: "1 rue Buyer",
      billing_postcode: "75002",
      billing_city: "Paris",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          description: "Widget",
          quantity: "1",
          unit_price_minor: 29_900n,
          product_source: null,
          external_id: null,
        },
      ],
    })

    // Sanity: the freshly-created draft line stores NULL (no per-line override), net of the 20%
    // FR domestic rate — 299.00 gross typed -> 249.17 net.
    const created = db.__all("document_lines").find((l) => l.document_id === draft_id)!
    expect(created.tax_rate_bp).toBeNull()
    expect(String(created.unit_price_minor)).toBe("24917")

    // Operator opens the draft in the Editor and saves it WITHOUT changing anything.
    await openEditSave(readsCtx, ctx, draft_id)

    // The saved row must STILL carry no explicit override (untouched save must not freeze one in).
    const savedLine = db.__all("document_lines").find((l) => l.document_id === draft_id)!
    expect(savedLine.tax_rate_bp).toBeNull()
    // And the net price must not have shrunk again (the c2a750cc compounding-division guard).
    expect(String(savedLine.unit_price_minor)).toBe("24917")

    const res = await invoiceIssue(ctx, { draft_id })
    expect(res.status).toBe("completed")
    if (res.status !== "completed") throw new Error("unreachable")
    const issued = db.__all("documents").find((d) => d.id === res.document_id)!
    // The full 299.00 gross, WITH its VAT line — not 249.17 with none.
    expect(Number(issued.grand_total_minor)).toBe(29_900)
    expect(Number(issued.tax_total_minor)).toBeGreaterThan(0)
    expect(Number(issued.tax_total_minor)).toBe(4_983) // 20% of 24917, banker's rounding
  })

  test("an explicit 0 percent line survives an open-and-save and still issues at 0 percent", async () => {
    const { ctx, readsCtx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      operation_category: "goods",
      billing_line1: "1 rue Buyer",
      billing_postcode: "75002",
      billing_city: "Paris",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          description: "Exempt service",
          quantity: "1",
          unit_price_minor: 5_000n,
          tax_rate_bp_override: 0,
          product_source: null,
          external_id: null,
        },
      ],
    })
    const created = db.__all("document_lines").find((l) => l.document_id === draft_id)!
    expect(created.tax_rate_bp).toBe(0)
    expect(String(created.unit_price_minor)).toBe("5000") // 0% -> never netted

    await openEditSave(readsCtx, ctx, draft_id)

    const savedLine = db.__all("document_lines").find((l) => l.document_id === draft_id)!
    expect(savedLine.tax_rate_bp).toBe(0) // still an explicit exemption, not lost, not re-defaulted
    expect(String(savedLine.unit_price_minor)).toBe("5000")

    const res = await invoiceIssue(ctx, { draft_id })
    expect(res.status).toBe("completed")
    if (res.status !== "completed") throw new Error("unreachable")
    const issued = db.__all("documents").find((d) => d.id === res.document_id)!
    expect(Number(issued.tax_total_minor)).toBe(0)
    expect(Number(issued.grand_total_minor)).toBe(5_000)
  })

  test("a genuinely changed per-line rate takes the new rate, not the classifier default", async () => {
    const { ctx, readsCtx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      operation_category: "goods",
      billing_line1: "1 rue Buyer",
      billing_postcode: "75002",
      billing_city: "Paris",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          description: "Widget",
          quantity: "1",
          unit_price_minor: 29_900n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(
      db.__all("document_lines").find((l) => l.document_id === draft_id)!.tax_rate_bp,
    ).toBeNull()

    // The operator types a real rate change: 5.5% (550 bp) instead of the FR domestic 20%.
    await openEditSave(readsCtx, ctx, draft_id, (l) => ({
      ...l,
      tax_rate_bp: 550,
      tax_rate_bp_overridden: true,
    }))

    const savedLine = db.__all("document_lines").find((l) => l.document_id === draft_id)!
    expect(savedLine.tax_rate_bp).toBe(550)

    const res = await invoiceIssue(ctx, { draft_id })
    expect(res.status).toBe("completed")
    if (res.status !== "completed") throw new Error("unreachable")
    const issuedLine = db.__all("document_lines").find((l) => l.document_id === res.document_id)!
    expect(issuedLine.tax_rate_bp).toBe(550)
    const issued = db.__all("documents").find((d) => d.id === res.document_id)!
    expect(Number(issued.tax_total_minor)).toBeGreaterThan(0)
    expect(Number(issued.tax_total_minor)).not.toBe(4_983) // not the FR-domestic 20% figure
  })
})
