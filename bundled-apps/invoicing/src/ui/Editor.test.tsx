// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Editor F4 tests — pure-logic surfaces only (bun:test, no jsdom).
//
// Pinned:
//   - validateDraft() flags missing due_at + missing counterparty_country
//     + missing currency + at-least-one-line + per-line missing description.
//   - rollupTotals() integrates D5 money helpers (subtotal/tax/grand).
//   - customsReadiness() reports missing HS / CoO when treatment is export.
//   - canIssue() blocks while validation has any errors, when pending_approval,
//     or when the document is non-draft, or when no issuer profile is set.
//   - readOnly() returns true for non-draft AND for pending_approval status.
//   - typeLabel() / DOC_TYPES list, language list, incoterm list.
//   - source emits the four header testids + the per-type primary-action
//     labels for E2E (there is no "Save draft" button any more).
//   - source-grep pins: issuer-profile fetch replaces the hardcoded
//     `issuer_profile_id: ""` TODO, the not-configured banner + issuer select
//     testids exist, and invoke() rejects a `{status: "error"}` tool result
//     instead of silently treating it as success (see Editor.tsx invoke()).
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
// Reactive-graph tests below need the REAL client reactivity (fine-grained
// diffing, disposal on identity change), not solid-js's default bun/node
// resolution of "solid-js" -> dist/server.js (SSR mode: list() is read once,
// non-reactively, so mapArray/indexArray never re-invoke on update and the
// disposal behavior under test wouldn't be exercised at all). The actual app
// runs through Vite, which resolves the package's "browser" export condition
// to this same dist/solid.js -- so importing it directly here is the real
// runtime primitive, not a test-only substitute.
import { createMemo, createRoot, createSignal, indexArray, mapArray } from "solid-js/dist/solid.js"
import { formatMoneyMinor } from "../money"
import { netLinesForIssuer } from "../mutations"
import {
  applyNetToGrossOnLoad,
  bpToPercentInput,
  buildDocumentsUpdatePatch,
  buildItems,
  canIssue,
  canIssueWithEinvoicing,
  createAndIssueSuccessMessage,
  customsReadiness,
  DOC_TYPES,
  type DraftDocument,
  type DraftLine,
  defaultDraft,
  Editor,
  type EditorIssuerProfile,
  EditorSummary,
  einvoicingIssueState,
  emailedMessage,
  grossUpLinesForDisplay,
  INCOTERMS,
  isEditableStatus,
  issueDateNotice,
  issuedAtForIssuer,
  LANGUAGES,
  localCivilDate,
  minorToPriceInput,
  NOTES_MAX_LENGTH,
  pendingApprovalMessage,
  percentInputToBp,
  priceInputToMinor,
  primaryActionEmailLabel,
  primaryActionLabel,
  readOnly,
  replaceLineAt,
  rollupTotals,
  rollupTotalsInclusive,
  shouldReseedPriceText,
  showCustomsColumns,
  statedIssuedAt,
  validateDraft,
} from "./Editor"

const sourceEditor = readFileSync(join(import.meta.dir, "Editor.tsx"), "utf-8")
const sourceSummary = readFileSync(join(import.meta.dir, "EditorSummary.tsx"), "utf-8")

const validLine = (over: Partial<DraftLine> = {}): DraftLine => ({
  position: 1,
  description: "Fabrikam field recorder",
  quantity: "1",
  unit_price_minor: "45000",
  tax_rate_bp: 2000,
  hs_code: "920710",
  country_of_origin: "FR",
  ...over,
})

const validDraft = (over: Partial<DraftDocument> = {}): DraftDocument => ({
  type: "invoice",
  status: "draft",
  currency: "EUR",
  language: "en",
  incoterm: "DAP",
  issuer_profile_id: "11111111-1111-1111-1111-111111111111",
  issuer_country: "FR",
  issuer_vat_id: "FR12345678901",
  counterparty_name: "Tonwerk Audio GmbH",
  counterparty_email: "billing@tonwerk-audio.example",
  counterparty_vat_id: null,
  counterparty_address: "Rheinallee 4, 40545 Düsseldorf, Germany",
  counterparty_country: "DE",
  issued_at: "2026-05-28",
  due_at: "2026-06-27",
  tax_treatment: "domestic",
  lines: [validLine()],
  ...over,
})

describe("Editor (Phase 17 F4)", () => {
  it("exports Editor + EditorSummary components", () => {
    expect(typeof Editor).toBe("function")
    expect(typeof EditorSummary).toBe("function")
  })

  it("DOC_TYPES enumerates the five document types", () => {
    expect(DOC_TYPES).toEqual(["invoice", "quote", "proforma", "purchase_order", "credit_note"])
  })

  it("LANGUAGES + INCOTERMS match manifest enums", () => {
    expect(LANGUAGES).toEqual(["en", "fr", "de"])
    expect(INCOTERMS).toEqual(["EXW", "FCA", "FOB", "CIF", "DAP", "DDP", "DPU"])
  })

  // ── validateDraft ─────────────────────────────────────────────────────
  it("validateDraft passes a complete valid draft", () => {
    const r = validateDraft(validDraft())
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it("validateDraft flags missing due_at", () => {
    const r = validateDraft(validDraft({ due_at: null }))
    expect(r.errors.find((e) => e.field === "due_at")).toBeDefined()
  })

  // Recipient completeness. An issued document must say WHO it is addressed to, WHERE they are
  // and HOW to reach them, so the editor blocks the Issue button per field instead of letting the
  // operator meet a tool error after the fact. INV-2026-3497 was issued to a recipient named
  // literally "Customer" with no address and no email: buildCounterparty substituted that
  // placeholder for an empty name field, and nothing downstream could tell it from a real one.
  it("validateDraft flags a missing customer name", () => {
    const r = validateDraft(validDraft({ counterparty_name: null }))
    expect(r.errors.find((e) => e.field === "counterparty_name")).toBeDefined()
  })

  it("validateDraft flags a whitespace-only customer name", () => {
    const r = validateDraft(validDraft({ counterparty_name: "   " }))
    expect(r.errors.find((e) => e.field === "counterparty_name")).toBeDefined()
  })

  it("validateDraft flags a missing customer address", () => {
    const r = validateDraft(validDraft({ counterparty_address: null }))
    expect(r.errors.find((e) => e.field === "counterparty_address")).toBeDefined()
  })

  it("validateDraft flags a missing customer email", () => {
    const r = validateDraft(validDraft({ counterparty_email: null }))
    expect(r.errors.find((e) => e.field === "counterparty_email")).toBeDefined()
  })

  it("canIssue blocks a draft whose recipient is incomplete", () => {
    expect(canIssue(validDraft({ counterparty_name: null }))).toBe(false)
    expect(canIssue(validDraft({ counterparty_address: null }))).toBe(false)
    expect(canIssue(validDraft({ counterparty_email: null }))).toBe(false)
  })

  it("validateDraft flags missing counterparty_country", () => {
    const r = validateDraft(validDraft({ counterparty_country: null }))
    expect(r.errors.find((e) => e.field === "counterparty_country")).toBeDefined()
  })

  it("validateDraft flags missing currency", () => {
    const r = validateDraft(validDraft({ currency: "" }))
    expect(r.errors.find((e) => e.field === "currency")).toBeDefined()
  })

  it("validateDraft requires at least one line", () => {
    const r = validateDraft(validDraft({ lines: [] }))
    expect(r.errors.find((e) => e.field === "lines")).toBeDefined()
  })

  it("validateDraft flags empty description on a line", () => {
    const r = validateDraft(validDraft({ lines: [validLine({ description: "" })] }))
    expect(r.errors.find((e) => e.field === "lines[0].description")).toBeDefined()
  })

  it("validateDraft flags negative unit price", () => {
    const r = validateDraft(validDraft({ lines: [validLine({ unit_price_minor: "-1" })] }))
    expect(r.errors.find((e) => e.field === "lines[0].unit_price_minor")).toBeDefined()
  })

  it("validateDraft warns when issuer is EU-country with no VAT id", () => {
    const r = validateDraft(validDraft({ issuer_vat_id: null, issuer_country: "FR" }))
    expect(r.warnings.find((w) => w.field === "issuer_vat_id")).toBeDefined()
  })

  it("validateDraft flags missing issuer_profile_id", () => {
    const r = validateDraft(validDraft({ issuer_profile_id: null }))
    const issue = r.errors.find((e) => e.field === "issuer_profile_id")
    expect(issue).toBeDefined()
    expect(issue?.message).toContain("issuer profile is required")
  })

  it("validateDraft passes when issuer_profile_id is set", () => {
    const r = validateDraft(validDraft())
    expect(r.errors.find((e) => e.field === "issuer_profile_id")).toBeUndefined()
  })

  // ── rollupTotals ──────────────────────────────────────────────────────
  it("rollupTotals sums subtotal/tax/grand correctly", () => {
    const r = rollupTotals([
      validLine({ unit_price_minor: "10000", quantity: "2", tax_rate_bp: 2000 }), // €100 × 2 = €200 subtotal, 20% tax = €40, total €240
      validLine({ unit_price_minor: "5000", quantity: "1", tax_rate_bp: 0 }), // €50 × 1 = €50 subtotal, 0% tax, total €50
    ])
    expect(r.subtotal_minor).toBe(25000n)
    expect(r.tax_total_minor).toBe(4000n)
    expect(r.grand_total_minor).toBe(29000n)
  })

  it("rollupTotals returns zero on empty lines", () => {
    const r = rollupTotals([])
    expect(r.subtotal_minor).toBe(0n)
    expect(r.tax_total_minor).toBe(0n)
    expect(r.grand_total_minor).toBe(0n)
  })

  // ── customsReadiness ──────────────────────────────────────────────────
  it("customsReadiness reports clean when all export lines have HS + CoO", () => {
    const r = customsReadiness(
      [validLine({ hs_code: "920710", country_of_origin: "FR" })],
      "eu_export_non_eu",
    )
    expect(r.ready).toBe(true)
    expect(r.missing_hs).toBe(0)
    expect(r.missing_coo).toBe(0)
  })

  it("customsReadiness counts gaps on export treatment", () => {
    const r = customsReadiness(
      [
        validLine({ position: 1, hs_code: null, country_of_origin: "FR" }),
        validLine({ position: 2, hs_code: "920710", country_of_origin: null }),
      ],
      "eu_export_non_eu",
    )
    expect(r.ready).toBe(false)
    expect(r.missing_hs).toBe(1)
    expect(r.missing_coo).toBe(1)
  })

  it("customsReadiness skips checks for domestic treatment", () => {
    const r = customsReadiness([validLine({ hs_code: null, country_of_origin: null })], "domestic")
    expect(r.ready).toBe(true) // not required for domestic
    expect(r.applicable).toBe(false)
  })

  // ── canIssue / readOnly ──────────────────────────────────────────────
  it("canIssue allows when draft + no validation errors", () => {
    expect(canIssue(validDraft())).toBe(true)
  })

  it("canIssue blocks when there are validation errors", () => {
    expect(canIssue(validDraft({ due_at: null }))).toBe(false)
  })

  it("canIssue blocks when status is pending_approval", () => {
    expect(canIssue(validDraft({ status: "pending_approval" }))).toBe(false)
  })

  it("canIssue blocks when status is non-draft (already issued)", () => {
    expect(canIssue(validDraft({ status: "issued" }))).toBe(false)
  })

  it("canIssue blocks when no issuer profile is selected", () => {
    expect(canIssue(validDraft({ issuer_profile_id: null }))).toBe(false)
  })

  // Editing gate rework: a document is editable unless it is voided or
  // cancelled (previously only drafts were editable). pending_approval stays
  // locked (a human decision is in flight); issued/paid/etc. are now
  // editable via documents_update ("Save changes").
  it("readOnly is true for pending_approval and the immutable statuses (voided/cancelled) only", () => {
    expect(readOnly(validDraft({ status: "pending_approval" }))).toBe(true)
    expect(readOnly(validDraft({ status: "voided" }))).toBe(true)
    expect(readOnly(validDraft({ status: "cancelled" }))).toBe(true)
    expect(readOnly(validDraft({ status: "draft" }))).toBe(false)
    expect(readOnly(validDraft({ status: "issued" }))).toBe(false)
    expect(readOnly(validDraft({ status: "paid" }))).toBe(false)
    expect(readOnly(validDraft({ status: "sent" }))).toBe(false)
    expect(readOnly(validDraft({ status: "overdue" }))).toBe(false)
  })

  it("isEditableStatus is false only for voided/cancelled", () => {
    expect(isEditableStatus("voided")).toBe(false)
    expect(isEditableStatus("cancelled")).toBe(false)
    expect(isEditableStatus("draft")).toBe(true)
    expect(isEditableStatus("issued")).toBe(true)
    expect(isEditableStatus("pending_approval")).toBe(true)
  })

  // ── source-grep contracts (E2E pickup) ────────────────────────────────
  it("Editor source emits the spec §12 testids, and no Save-draft button", () => {
    expect(sourceEditor).toContain("editor-button-issue")
    expect(sourceEditor).toContain("editor-button-issue-email")
    expect(sourceEditor).toContain("editor-button-preview-pdf")
    expect(sourceEditor).toContain("editor-button-add-line")
    // A new document is created and issued in one step: the draft stage, and
    // with it the Save-draft button and drafts_create, are gone.
    expect(sourceEditor).not.toContain("editor-button-save-draft")
    expect(sourceEditor).not.toContain("Save draft")
    expect(sourceEditor).not.toContain('"drafts_create"')
  })

  // ── primary-action copy ──
  it("primaryActionLabel names the action per type (quote creates, the rest issue)", () => {
    expect(primaryActionLabel("quote")).toBe("Create quote")
    expect(primaryActionLabel("proforma")).toBe("Issue proforma")
    expect(primaryActionLabel("purchase_order")).toBe("Issue purchase order")
    // Legacy types keep the generic label (reachable only by editing an old row).
    expect(primaryActionLabel("invoice")).toBe("Issue")
    expect(primaryActionLabel("credit_note")).toBe("Issue")
  })

  it("primaryActionEmailLabel is the same action + email", () => {
    expect(primaryActionEmailLabel("quote")).toBe("Create quote + email")
    expect(primaryActionEmailLabel("proforma")).toBe("Issue proforma + email")
  })

  it("the footer renders the per-type label, not a hardcoded Issue", () => {
    expect(sourceEditor).toContain("primaryActionLabel(draft().type)")
    expect(sourceEditor).toContain("primaryActionEmailLabel(draft().type)")
  })

  it("a completed quote result naming a Shopify draft order says so", () => {
    expect(createAndIssueSuccessMessage("quote", { shopify_draft_order_name: "#D12" })).toBe(
      "Quote created from Shopify draft order #D12.",
    )
    // No draft order (standalone install): plain confirmation.
    expect(createAndIssueSuccessMessage("quote", {})).toBe("Quote created.")
    expect(createAndIssueSuccessMessage("quote", { shopify_draft_order_name: null })).toBe(
      "Quote created.",
    )
    expect(createAndIssueSuccessMessage("proforma", { shopify_draft_order_name: "#D12" })).toBe(
      "Issued.",
    )
  })

  it("a pending_approval quote result points at the Shopify approval, not the invoicing queue", () => {
    expect(pendingApprovalMessage("quote")).toBe(
      "Draft order sent for approval in Shopify. The quote appears once it is approved.",
    )
    expect(pendingApprovalMessage("proforma")).toBe(
      "Sent for approval. See the Pending Approval queue.",
    )
  })

  it("the + email variant keeps working and reuses the same completion copy", () => {
    expect(emailedMessage("quote", { shopify_draft_order_name: "#D12" })).toBe(
      "Quote created from Shopify draft order #D12. Emailed to the customer.",
    )
    expect(emailedMessage("proforma")).toBe("Issued. Emailed to the customer.")
    expect(sourceEditor).toContain("send_to_customer: true")
  })

  it("Editor source emits the pending-approval read-only banner copy", () => {
    expect(sourceEditor).toContain("Pending approval")
  })

  // ── issuer profile wiring (F4 follow-up) ──────────────────────────────
  it("Editor source fetches issuer profiles and no longer hardcodes issuer_profile_id", () => {
    expect(sourceEditor).toContain("settings_issuer_profile_list")
    expect(sourceEditor).not.toContain('issuer_profile_id: "", // TODO(v2)')
    expect(sourceEditor).not.toContain('issuer_profile_id: "",')
  })

  it("Editor source emits the not-configured banner + issuer select testids", () => {
    expect(sourceEditor).toContain("editor-not-configured-banner")
    expect(sourceEditor).toContain("editor-field-issuer")
    expect(sourceEditor).toContain("isn't configured yet")
  })

  it("Editor source passes the selected issuer_profile_id to drafts_create / issue tools", () => {
    expect(sourceEditor).toContain("issuer_profile_id: draft().issuer_profile_id")
  })

  it("Editor source rejects a failed tool result (status: error) instead of treating it as success", () => {
    expect(sourceEditor).toContain('result.status === "error"')
    expect(sourceEditor).toContain("editor-error-banner")
    expect(sourceEditor).toContain("setLastError")
  })

  it("EditorSummary source surfaces treatment + totals + customs readiness", () => {
    expect(sourceSummary).toContain("Treatment")
    expect(sourceSummary).toContain("Subtotal")
    expect(sourceSummary).toContain("Grand total")
    expect(sourceSummary).toContain("Customs")
  })

  // ── existing-draft edit wiring (list → detail → edit) ─────────────────
  // Editing a persisted draft (props.documentId set) must not create a
  // second draft: Save calls drafts_update, and Issue calls the {type}_issue
  // tool against the existing draft_id instead of *_create_and_issue.
  it("EditorProps declares an optional documentId", () => {
    expect(sourceEditor).toMatch(/documentId\?:\s*string/)
  })

  it("a legacy draft still pushes pending edits via drafts_update before issuing in place", () => {
    // pushDraftPatch survives for legacy draft rows (reachable only by direct
    // link); nothing in the New flow creates a draft any more.
    expect(sourceEditor).toContain("props.documentId")
    expect(sourceEditor).toContain('"drafts_update"')
    expect(sourceEditor).toContain("draft_id: documentId")
    expect(sourceEditor).toMatch(/patch:\s*draftPatch\(\)/)
  })

  it("issueTool() maps each doc type to its {type}_issue tool name (existing-draft issue)", () => {
    expect(sourceEditor).toContain('"invoice_issue"')
    expect(sourceEditor).toContain('"quote_issue"')
    expect(sourceEditor).toContain('"proforma_issue"')
    expect(sourceEditor).toContain('"po_issue"')
  })

  it("onIssue calls the {type}_issue tool with {draft_id, due_at} when documentId is set, not *_create_and_issue", () => {
    // The existing-draft branch must invoke issueTool(...) (not
    // createAndIssueTool(...)) — pin the exact call shape so a future edit
    // can't silently reintroduce the duplicate-draft bug.
    expect(sourceEditor).toMatch(
      /issueTool\(draft\(\)\.type\),[\s\S]{0,200}?\{\s*draft_id:\s*documentId\s*\}/,
    )
    // And the existing-draft issue path pushes pending edits BEFORE issuing
    // (issue-what-you-see, not the last-saved state).
    expect(sourceEditor).toMatch(/if \(!\(await pushDraftPatch\(documentId\)\)\) return/)
  })

  it("onIssueEmail for an existing draft issues then chains documents_send_to_customer (no send_to_customer param on {type}_issue)", () => {
    // {type}_issue's manifest schema only accepts {draft_id, due_at} — no
    // send_to_customer — so the existing-draft "Issue + email" path issues
    // first, then calls the same documents_send_to_customer tool
    // DocumentDetail's footer action uses.
    expect(sourceEditor).toContain("onIssueEmailExisting")
    expect(sourceEditor).toContain('"documents_send_to_customer"')
  })

  it("onIssue / onIssueEmail still use *_create_and_issue for a brand-new document (no documentId)", () => {
    expect(sourceEditor).toContain("createAndIssueTool(draft().type)")
    expect(sourceEditor).toContain("invoice_create_and_issue")
    expect(sourceEditor).toContain("send_to_customer: true")
  })

  // ── Customer section (counterparty snapshot editing) ──────────────────
  describe("Customer section", () => {
    it("source emits the Customer section field testids", () => {
      expect(sourceEditor).toContain("editor-field-customer-name")
      expect(sourceEditor).toContain("editor-field-customer-email")
      expect(sourceEditor).toContain("editor-field-customer-vat")
      expect(sourceEditor).toContain("editor-field-customer-address")
      expect(sourceEditor).toContain("editor-field-customer-country")
    })

    it("buildItems maps DraftLine[] into the wire item shape (position/description/quantity/unit_price_minor/tax_rate_bp_override + customs fields)", () => {
      const items = buildItems(
        validDraft({
          lines: [
            validLine({
              position: 1,
              description: "Widget",
              quantity: "2",
              unit_price_minor: "1000",
              tax_rate_bp: 2000,
              hs_code: "9207.90",
              country_of_origin: "FR",
            }),
          ],
        }),
      )
      expect(items).toEqual([
        {
          position: 1,
          description: "Widget",
          quantity: "2",
          unit_price_minor: "1000",
          tax_rate_bp_override: 2000,
          hs_code: "9207.90",
          country_of_origin: "FR",
          customs_description: undefined,
          product_source: null,
          external_id: null,
        },
      ])
    })

    it("buildDocumentsUpdatePatch carries the full counterparty snapshot + header fields + lines for a given document id", () => {
      const d = validDraft({
        counterparty_name: "Klangwerk GmbH",
        counterparty_email: "billing@klangwerk.example",
        counterparty_vat_id: "DE298765432",
        counterparty_address: "Rheinallee 4, 40545 Düsseldorf, Germany",
        counterparty_country: "DE",
        counterparty_contact_id: "22222222-2222-2222-2222-222222222222",
        incoterm: "DDP",
        issued_at: "2026-06-01",
        due_at: "2026-07-01",
        tax_treatment: "eu_domestic",
      })
      const patch = buildDocumentsUpdatePatch(d, "33333333-3333-3333-3333-333333333333")
      expect(patch).toEqual({
        id: "33333333-3333-3333-3333-333333333333",
        counterparty_name: "Klangwerk GmbH",
        counterparty_address: "Rheinallee 4, 40545 Düsseldorf, Germany",
        counterparty_shipping_address: null,
        counterparty_shipping_name: null,
        counterparty_vat_id: "DE298765432",
        counterparty_email: "billing@klangwerk.example",
        counterparty_country: "DE",
        counterparty_contact_id: "22222222-2222-2222-2222-222222222222",
        incoterm: "DDP",
        issued_at: "2026-06-01",
        due_at: "2026-07-01",
        tax_treatment: "eu_domestic",
        notes: null,
        lines: buildItems(d),
      })
    })

    it("buildDocumentsUpdatePatch leaves the frozen financial fields OUT for an issued document (paid invoice) so the save is not rejected", () => {
      const d = validDraft({
        status: "paid",
        counterparty_name: "Klangwerk GmbH",
        counterparty_vat_id: "DE298765432",
        notes: "Contract ref 42",
      })
      const patch = buildDocumentsUpdatePatch(d, "id-paid") as Record<string, unknown>
      expect(patch.notes).toBe("Contract ref 42")
      expect(patch.counterparty_address).toBeDefined()
      expect("lines" in patch).toBe(false)
      expect("tax_treatment" in patch).toBe(false)
      expect("counterparty_name" in patch).toBe(false)
      expect("counterparty_vat_id" in patch).toBe(false)
    })

    it("buildDocumentsUpdatePatch keeps lines and the legal identity for an OPEN quote (sent), which the server still accepts", () => {
      const d = validDraft({ type: "quote", status: "sent", counterparty_name: "Klangwerk GmbH" })
      const patch = buildDocumentsUpdatePatch(d, "id-quote") as Record<string, unknown>
      expect(patch.counterparty_name).toBe("Klangwerk GmbH")
      expect(Array.isArray(patch.lines)).toBe(true)
      expect("tax_treatment" in patch).toBe(true)
    })

    it("buildDocumentsUpdatePatch keeps lines for an ISSUED proforma and purchase order (not accounting documents)", () => {
      for (const type of ["proforma", "purchase_order", "quote"] as const) {
        const d = validDraft({ type, status: "issued", counterparty_name: "Klangwerk GmbH" })
        const patch = buildDocumentsUpdatePatch(d, `id-${type}`) as Record<string, unknown>
        expect(Array.isArray(patch.lines), type).toBe(true)
        expect(patch.counterparty_name, type).toBe("Klangwerk GmbH")
        expect("tax_treatment" in patch, type).toBe(true)
      }
    })

    it("buildDocumentsUpdatePatch still leaves lines OUT for an ISSUED credit note", () => {
      const d = validDraft({ type: "credit_note", status: "issued" })
      const patch = buildDocumentsUpdatePatch(d, "id-cn") as Record<string, unknown>
      expect("lines" in patch).toBe(false)
    })

    it("buildDocumentsUpdatePatch defaults every counterparty snapshot field to null when unset", () => {
      const d = validDraft({
        counterparty_name: null,
        counterparty_email: null,
        counterparty_vat_id: null,
        counterparty_address: null,
      })
      const patch = buildDocumentsUpdatePatch(d, "id-1")
      expect(patch.counterparty_name).toBeNull()
      expect(patch.counterparty_email).toBeNull()
      expect(patch.counterparty_vat_id).toBeNull()
      expect(patch.counterparty_address).toBeNull()
    })
  })

  // ── documents_update save path for a non-draft document ────────────────
  describe("Non-draft editing (documents_update)", () => {
    it("source emits the editor-issued-notice banner + Save changes button", () => {
      expect(sourceEditor).toContain("editor-issued-notice")
      expect(sourceEditor).toContain("editor-button-save-changes")
      expect(sourceEditor).toContain("Save changes")
      expect(sourceEditor).toContain("Editing an issued document")
    })

    it("onSaveChanges calls documents_update with buildDocumentsUpdatePatch(draft(), documentId)", () => {
      expect(sourceEditor).toContain('"documents_update"')
      expect(sourceEditor).toContain("buildDocumentsUpdatePatch(draft(), documentId)")
    })

    it("Issue / Issue+email buttons are hidden (not rendered) for a non-draft editable document", () => {
      // The footer's fallback branch (draft / brand-new document) renders Issue +
      // Issue+email; the isNonDraftEditable() branch renders ONLY Save changes.
      expect(sourceEditor).toMatch(/isNonDraftEditable\(\)/)
    })
  })

  // ── prices_include_tax (typed prices are gross) ─────────────────────────
  describe("Prices include tax", () => {
    it("rollupTotals divides the included tax out of taxable lines when the flag is on", () => {
      const lines = [validLine({ unit_price_minor: "12000", quantity: "1", tax_rate_bp: 2000 })]
      const r = rollupTotals(lines, true)
      expect(r.subtotal_minor).toBe(10000n)
      expect(r.tax_total_minor).toBe(2000n)
      // The total the customer pays is exactly the price that was typed.
      expect(r.grand_total_minor).toBe(12000n)
    })

    it("rollupTotals leaves a zero-rated line alone (there is no included tax to remove)", () => {
      const lines = [validLine({ unit_price_minor: "12000", quantity: "1", tax_rate_bp: 0 })]
      const r = rollupTotals(lines, true)
      expect(r.subtotal_minor).toBe(12000n)
      expect(r.tax_total_minor).toBe(0n)
      expect(r.grand_total_minor).toBe(12000n)
    })

    it("rollupTotals stays exclusive by default (the flag is opt-in)", () => {
      const lines = [validLine({ unit_price_minor: "12000", quantity: "1", tax_rate_bp: 2000 })]
      const r = rollupTotals(lines)
      expect(r.subtotal_minor).toBe(12000n)
      expect(r.grand_total_minor).toBe(14400n)
    })

    it("rollupTotalsInclusive is rollupTotals with the flag on", () => {
      const lines = [
        validLine({ unit_price_minor: "12000", quantity: "2", tax_rate_bp: 2000 }),
        validLine({ unit_price_minor: "5000", quantity: "1", tax_rate_bp: 0 }),
      ]
      expect(rollupTotalsInclusive(lines)).toEqual(rollupTotals(lines, true))
    })

    it("Editor source flips the unit-price header and shows the tax-inclusive note", () => {
      expect(sourceEditor).toContain("Unit price (incl. VAT)")
      expect(sourceEditor).toContain(
        "Prices are tax inclusive (issuer setting). Catalog lines take the store price.",
      )
      expect(sourceEditor).toContain("editor-prices-include-tax-note")
    })

    it("Editor source takes prices_include_tax from the selected issuer profile into the totals", () => {
      expect(sourceEditor).toContain("prices_include_tax: !!p.prices_include_tax")
      expect(sourceEditor).toContain("rollupTotals(draft().lines, !!draft().prices_include_tax)")
    })
  })

  // ── net-on-load regression (compounding division bug) ───────────────────
  //
  // netLinesForIssuer nets a typed gross price to net ONCE, at the drafts_update/documents_update
  // write boundary (mutations.ts). A document read back from storage is therefore already net.
  // The Editor's own state must gross it back up ONCE on load so it stays the single gross
  // boundary: rollupTotals(lines, true) then divides the SAME figure out exactly once for
  // display, and a save that echoes the unchanged lines back nets exactly once too. Skipping the
  // load-time gross-up (the pre-fix behaviour) both under-displays the totals and compounds the
  // stored price further on every save: 299.00 -> 249.17 -> 207.64 -> 173.03 ...
  describe("net-on-load: the Editor is the single gross boundary", () => {
    const inclusiveIssuer = { prices_include_tax: true }
    const classifyInput = { issuer_country: "FR", counterparty_country: "FR", has_vat_id: false }

    it("grossUpLinesForDisplay reconstructs the typed gross price from a stored net line", () => {
      const netLine = validLine({ unit_price_minor: "24917", tax_rate_bp: 2000 })
      const grossed = grossUpLinesForDisplay([netLine])
      expect(grossed[0]!.unit_price_minor).toBe("29900")
    })

    it("grossUpLinesForDisplay leaves a zero-rated line untouched (no included tax to remove)", () => {
      const netLine = validLine({ unit_price_minor: "29900", tax_rate_bp: 0 })
      expect(grossUpLinesForDisplay([netLine])[0]!.unit_price_minor).toBe("29900")
    })

    it("a loaded document's totals show 299.00 (24917 subtotal + 4983 VAT), not the pre-fix 249.17", () => {
      // What documents_get / mapDocumentToDraft hands the Editor for an existing document: the
      // NET price actually stored on disk.
      const storedNetLine = validLine({ unit_price_minor: "24917", tax_rate_bp: 2000 })
      // The pre-fix bug: feeding the still-net line straight into rollupTotals(lines, true)
      // divides it a second time, under-displaying the totals as 207.64 + 41.53 VAT = 249.17
      // for a document that was actually issued at 299.00.
      const preFixTotals = rollupTotals([storedNetLine], true)
      expect(preFixTotals.subtotal_minor).toBe(20764n)
      expect(preFixTotals.tax_total_minor).toBe(4153n)
      expect(preFixTotals.grand_total_minor).toBe(24917n) // the display bug's wrong figure (249.17)

      // The fix: the Editor grosses the loaded line up once before it ever reaches rollupTotals.
      const editorState = grossUpLinesForDisplay([storedNetLine])
      const totals = rollupTotals(editorState, true)
      expect(totals.subtotal_minor).toBe(24917n)
      expect(totals.tax_total_minor).toBe(4983n)
      expect(totals.grand_total_minor).toBe(29900n)
    })

    it("saving an unchanged loaded document nets exactly once (round trip through the real write-side netting)", () => {
      const storedNetLine = validLine({ unit_price_minor: "24917", tax_rate_bp: 2000 })

      // Pre-fix: the Editor echoes the still-net line straight back as `items`, and the real
      // write-side netLinesForIssuer (unchanged, mutations.ts) divides it a second time.
      const preFixItems = buildItems(validDraft({ lines: [storedNetLine] }))
      const preFixNetted = netLinesForIssuer(
        preFixItems.map((i) => ({ ...i, unit_price_minor: BigInt(i.unit_price_minor) })),
        inclusiveIssuer,
        classifyInput,
      )
      expect(preFixNetted[0]!.unit_price_minor).toBe(20764n) // the compounding bug

      // Fix: the Editor's own state is the grossed-up line (set once on load), so what it echoes
      // back on an unchanged save is the GROSS figure, and the SAME write-side call reproduces
      // the original stored net value exactly.
      const editorState = grossUpLinesForDisplay([storedNetLine])
      const items = buildItems(validDraft({ lines: editorState }))
      const netted = netLinesForIssuer(
        items.map((i) => ({ ...i, unit_price_minor: BigInt(i.unit_price_minor) })),
        inclusiveIssuer,
        classifyInput,
      )
      expect(netted[0]!.unit_price_minor).toBe(24917n)
      expect(netted[0]!.unit_price_minor).not.toBe(20764n)
    })

    it("a genuinely edited price (operator types 299.00 on a loaded draft) still nets exactly once", () => {
      // The operator overwrites the (already grossed-up) field with a freshly typed value —
      // same figure here, but it goes through the input parser, not a read-back echo.
      const editedLine = validLine({ unit_price_minor: "29900", tax_rate_bp: 2000 })
      const items = buildItems(validDraft({ lines: [editedLine] }))
      const netted = netLinesForIssuer(
        items.map((i) => ({ ...i, unit_price_minor: BigInt(i.unit_price_minor) })),
        inclusiveIssuer,
        classifyInput,
      )
      expect(netted[0]!.unit_price_minor).toBe(24917n)
    })

    it("a non inclusive issuer is unaffected: grossUpLinesForDisplay is never applied, price nets as typed", () => {
      const line = validLine({ unit_price_minor: "29900", tax_rate_bp: 2000 })
      const items = buildItems(validDraft({ lines: [line] }))
      const netted = netLinesForIssuer(
        items.map((i) => ({ ...i, unit_price_minor: BigInt(i.unit_price_minor) })),
        { prices_include_tax: false },
        classifyInput,
      )
      expect(netted[0]!.unit_price_minor).toBe(29900n) // untouched — the setting is off
    })

    it("Editor source wires applyNetToGrossOnLoad into a run-once memo", () => {
      expect(sourceEditor).toContain("applyNetToGrossOnLoad({")
      expect(sourceEditor).toContain("netToGrossApplied = true")
    })
  })

  // ── applyNetToGrossOnLoad: real solid-js reactivity, not a source grep ──────────────────
  //
  // A source-string grep pins that the RIGHT WORDS are in the file, not that the conversion
  // actually behaves correctly across re-evaluations -- exactly the class of hole this morning's
  // shipped regression fell through. These drive the REAL solid-js runtime (imported directly
  // from solid-js/dist/solid.js, same reasoning as the indexArray/mapArray tests above -- the
  // bun/node default resolution is SSR mode and evaluates a memo once, non-reactively) with the
  // SAME wiring the Editor component itself uses (a run-once flag guarding a createMemo around
  // applyNetToGrossOnLoad), so what's under test is the real reactive behavior end to end.
  describe("applyNetToGrossOnLoad (real solid-js reactivity, mirrors the Editor's own memo)", () => {
    const inclusiveProfile: EditorIssuerProfile = {
      id: "iss-1",
      legal_name: "Acme SAS",
      country: "FR",
      prices_include_tax: true,
    }

    /** Wires applyNetToGrossOnLoad into a run-once memo EXACTLY the way Editor.tsx's own
     *  component body does. */
    function wire(initialId: string | undefined, initialDraft: DraftDocument) {
      const [draft, setDraft] = createSignal(initialDraft)
      const [issuerProfiles, setIssuerProfiles] = createSignal<EditorIssuerProfile[] | undefined>(
        undefined,
      )
      let netToGrossApplied = false
      const memo = createMemo(() => {
        if (netToGrossApplied) return
        const applied = applyNetToGrossOnLoad({
          initialId,
          getDraft: draft,
          setDraft,
          getIssuerProfiles: issuerProfiles,
        })
        if (applied) netToGrossApplied = true
      })
      return { draft, setDraft, issuerProfiles, setIssuerProfiles, memo }
    }

    it("loading a net document: state stays net until the issuer profile resolves, then becomes gross", () => {
      createRoot((dispose: () => void) => {
        const netLine = validLine({ unit_price_minor: "24917", tax_rate_bp: 2000 })
        const loaded = validDraft({ id: "doc-1", issuer_profile_id: "iss-1", lines: [netLine] })
        const { draft, setIssuerProfiles, memo } = wire("doc-1", loaded)

        memo() // force the initial evaluation, like the component's first render
        expect(draft().lines[0]!.unit_price_minor).toBe("24917") // still net -- issuer not resolved yet

        setIssuerProfiles([inclusiveProfile]) // the issuer-profile resource just resolved
        memo()

        expect(draft().prices_include_tax).toBe(true)
        expect(draft().lines[0]!.unit_price_minor).toBe("29900") // grossed up exactly once
        dispose()
      })
    })

    it("does not re-apply when the same document is re-fetched after a save (the run-once flag holds)", () => {
      createRoot((dispose: () => void) => {
        const netLine = validLine({ unit_price_minor: "24917", tax_rate_bp: 2000 })
        const loaded = validDraft({ id: "doc-1", issuer_profile_id: "iss-1", lines: [netLine] })
        const { draft, setDraft, setIssuerProfiles, memo } = wire("doc-1", loaded)

        setIssuerProfiles([inclusiveProfile])
        memo()
        expect(draft().lines[0]!.unit_price_minor).toBe("29900")

        // A re-fetch hands the SAME server document back -- still net, exactly as stored. The
        // run-once flag must hold even though the draft signal (a dependency of the memo) just
        // changed, so the conversion is NOT re-applied on top of it.
        setDraft(loaded)
        memo()

        expect(draft().lines[0]!.unit_price_minor).toBe("24917") // untouched by the re-fetch
        dispose()
      })
    })

    it("a brand-new draft (no initialId) is never converted, even once an issuer resolves", () => {
      createRoot((dispose: () => void) => {
        const freshLine = validLine({ unit_price_minor: "0", tax_rate_bp: 2000 })
        const fresh = validDraft({ issuer_profile_id: "iss-1", lines: [freshLine] })
        const { draft, setIssuerProfiles, memo } = wire(undefined, fresh)

        setIssuerProfiles([inclusiveProfile])
        memo()

        expect(draft().lines[0]!.unit_price_minor).toBe("0")
        expect(draft().prices_include_tax).toBeUndefined()
        dispose()
      })
    })

    it("a non inclusive issuer resolving sets prices_include_tax false and leaves lines untouched", () => {
      createRoot((dispose: () => void) => {
        const line = validLine({ unit_price_minor: "29900", tax_rate_bp: 2000 })
        const loaded = validDraft({ id: "doc-1", issuer_profile_id: "iss-1", lines: [line] })
        const { draft, setIssuerProfiles, memo } = wire("doc-1", loaded)

        setIssuerProfiles([{ ...inclusiveProfile, prices_include_tax: false }])
        memo()

        expect(draft().prices_include_tax).toBe(false)
        expect(draft().lines[0]!.unit_price_minor).toBe("29900")
        dispose()
      })
    })
  })
})

// Regression: the unit-price cell bound the input directly to
// unit_price_minor while the column header said "Unit price," so an operator
// typing "100" (meaning 100 EUR) stored 100 MINOR units (1.00 EUR). Quantity
// 2 at that stored price rendered a grand total of "2.00 EUR" instead of
// "200.00 EUR" ("it removes 2 digits").
describe("unit price is typed and stored in major/minor units correctly", () => {
  it("100 EUR at quantity 2 rolls up to 200.00 EUR, not 2.00 EUR", () => {
    const minor = priceInputToMinor("100", "EUR")
    expect(minor).not.toBeNull()
    const line = validLine({ unit_price_minor: minor as string, quantity: "2", tax_rate_bp: 0 })
    const totals = rollupTotals([line])
    expect(totals.grand_total_minor).toBe(20000n)
    expect(formatMoneyMinor(totals.grand_total_minor, "EUR")).toBe("200.00 EUR")
  })

  it("minorToPriceInput shows the stored minor value as the major-unit text the user typed", () => {
    // validLine()'s price is "45000" minor = 450.00 EUR.
    expect(minorToPriceInput("45000", "EUR")).toBe("450.00")
  })
})

// Regression: the line-item table rendered rows with <For each={draft().lines}>,
// which keys by item reference. updateLine rebuilds the edited line as a NEW
// object, so <For>'s row (and its focused <input>) was disposed and
// re-created on every keystroke — typing accepted only one character before
// losing focus. <Index> (which the row loop now uses) keys by POSITION, so
// the row survives an in-place object replacement at the same index.
// No DOM is reachable from this app's test harness without adding a
// dependency (jsdom exists only under apps/web/node_modules and the shared
// .bun store, neither reachable from bundled-apps/invoicing's own node
// resolution, and reaching in with a hardcoded path would violate the
// bundled-app isolation this harness relies on). So the tests below cannot
// render the real Editor row table and assert an input DOM node survives an
// update by identity; they exercise the reactive-graph primitives directly
// (indexArray/mapArray from the actual solid-js runtime) plus the real
// production update function (replaceLineAt, extracted from updateLine) and
// pin the JSX source shape. A true render-based falsification would need
// solid-js/web's client renderInto against a real DOM, which needs jsdom or
// happy-dom added to this app's own devDependencies.
describe("editing a line does not recreate its row", () => {
  it("indexArray (the primitive behind Index) does not re-invoke the row factory when a line object is replaced in place", () => {
    createRoot((dispose: () => void) => {
      const lines: DraftLine[] = [
        validLine({ position: 1, description: "a" }),
        validLine({ position: 2, description: "b" }),
      ]
      const [signal, setSignal] = createSignal(lines)
      let indexFactoryCalls = 0
      const rows = indexArray(signal, () => {
        indexFactoryCalls++
        return {}
      })
      rows() // force initial evaluation
      expect(indexFactoryCalls).toBe(2)

      // The EDITOR's real update function, not a hand written stand-in:
      // replaceLineAt is the exact array-replace `updateLine` calls (Editor.tsx).
      setSignal(replaceLineAt(lines, 0, { description: "ab" }))
      rows()

      // Editing line 0's value must NOT re-invoke the factory for either row:
      // indexArray only re-runs a row's factory when the item at that
      // POSITION changes identity in a way it can't diff (it never does for
      // a plain object replace), and it never re-runs unaffected rows.
      expect(indexFactoryCalls).toBe(2)
      dispose()
    })
  })

  it("mapArray (the primitive behind For) DOES re-invoke the row factory for the edited row, by contrast", () => {
    createRoot((dispose: () => void) => {
      const lines: DraftLine[] = [
        validLine({ position: 1, description: "a" }),
        validLine({ position: 2, description: "b" }),
      ]
      const [signal, setSignal] = createSignal(lines)
      let mapFactoryCalls = 0
      const rows = mapArray(signal, () => {
        mapFactoryCalls++
        return {}
      })
      rows()
      expect(mapFactoryCalls).toBe(2)

      // mapArray keys by item reference: replacing line 0 with a new object
      // is a different reference at that slot, so it disposes and re-creates
      // that row (and, in the DOM, the focused <input> inside it) — this is
      // the mechanism behind the reported "loses focus every keystroke" bug.
      // Same real update path as the indexArray test above (replaceLineAt).
      setSignal(replaceLineAt(lines, 0, { description: "ab" }))
      rows()

      expect(mapFactoryCalls).toBe(3)
      dispose()
    })
  })

  it("Editor source keys the line rows by position (Index), not by item reference (For), and the unit-price input is not bound directly to the stored minor value", () => {
    expect(sourceEditor).toMatch(/<Index\s+each=\{draft\(\)\.lines\}/)
    expect(sourceEditor).not.toMatch(/<For\s+each=\{draft\(\)\.lines\}/)
    expect(sourceEditor).not.toMatch(/value=\{line\.unit_price_minor\}/)
  })
})

// Regression: the price-cell reseed effect compared priceInputToMinor()'s
// return (a string, or null mid-keystroke) against BigInt(stored), which
// never has overlap and so was always truthy - the effect re-seeded the
// input's text on every keystroke, clobbering what the operator just typed
// and making it impossible to clear the field.
describe("shouldReseedPriceText", () => {
  it("the price cell does not reseed while the operator is typing", () => {
    // stored is unchanged from lastStored: this is the operator's own
    // keystroke, not an external update. Old always-true condition: true
    // (clobbered the in-flight text). New: false.
    expect(
      shouldReseedPriceText({
        text: "100.",
        stored: "45000",
        lastStored: "45000",
        currency: "EUR",
        lastCurrency: "EUR",
      }),
    ).toBe(false)
    expect(
      shouldReseedPriceText({
        text: "",
        stored: "45000",
        lastStored: "45000",
        currency: "EUR",
        lastCurrency: "EUR",
      }),
    ).toBe(false)
  })

  it("the price cell reseeds when the document reloads with a different amount", () => {
    // stored changed and the text no longer represents it. Old: true. New: true.
    expect(
      shouldReseedPriceText({
        text: "450.00",
        stored: "60000",
        lastStored: "45000",
        currency: "EUR",
        lastCurrency: "EUR",
      }),
    ).toBe(true)
  })

  it("the price cell does not reseed when the text already means the stored amount", () => {
    // stored changed to the exact value the user just typed. Old: true
    // (string vs bigint never overlap). New: false.
    expect(
      shouldReseedPriceText({
        text: "100",
        stored: "10000",
        lastStored: "45000",
        currency: "EUR",
        lastCurrency: "EUR",
      }),
    ).toBe(false)
  })

  it("clearing the price cell is not undone", () => {
    // stored unchanged, text cleared to empty. Old: true (clobbered the
    // clear with the old stored value). New: false.
    expect(
      shouldReseedPriceText({
        text: "",
        stored: "45000",
        lastStored: "45000",
        currency: "EUR",
        lastCurrency: "EUR",
      }),
    ).toBe(false)
  })

  it("the price cell reseeds when the currency changes even though the stored amount did not", () => {
    // stored is unchanged (10000 minor), but the document switched EUR to
    // JPY: the text "100.00" still reads as the OLD currency's amount and
    // must be re-seeded immediately, not left stale until blur.
    expect(
      shouldReseedPriceText({
        text: "100.00",
        stored: "10000",
        lastStored: "10000",
        currency: "JPY",
        lastCurrency: "EUR",
      }),
    ).toBe(true)
  })
})

// ── Notes (free-text mentions printed on the document) ────────────────────
//
// `notes` is non-financial metadata exactly like po_number: documents_update
// accepts it on ANY editable status, so the field is editable on a draft, on an
// issued invoice, on a sent quote — everywhere the editor itself is reachable.
describe("Notes field", () => {
  // red: drop the Notes <textarea> -> nothing in the UI can set the field.
  it("source renders a Notes textarea with the max length and the printed-on-document placeholder", () => {
    expect(sourceEditor).toContain("editor-field-notes")
    expect(sourceEditor).toContain("maxlength={NOTES_MAX_LENGTH}")
    expect(sourceEditor).toMatch(/value=\{draft\(\)\.notes \?\? ""\}/)
    expect(sourceEditor).toMatch(/update\(\{ notes: e\.currentTarget\.value \|\| null \}\)/)
    expect(sourceEditor).toContain("printed on the document")
  })

  it("caps the notes at 2000 characters and shows how many are left", () => {
    expect(NOTES_MAX_LENGTH).toBe(2000)
    expect(sourceEditor).toContain("editor-field-notes-remaining")
    expect(sourceEditor).toMatch(/NOTES_MAX_LENGTH - \(draft\(\)\.notes\?\.length \?\? 0\)/)
  })

  // red: drop `notes` from draftPatch -> editing the notes on a legacy draft and
  // issuing it silently drops what the operator typed.
  it("the drafts_update patch carries the notes", () => {
    expect(sourceEditor).toMatch(/draftPatch[\s\S]{0,900}?notes: draft\(\)\.notes \?\? null/)
  })

  // red: drop `notes` from buildCreateAndIssuePayload -> a brand-new document is
  // issued (and its PDF rendered) without the mentions the operator typed.
  it("the {type}_create_and_issue payload carries the notes for every type", () => {
    expect(sourceEditor).toMatch(
      /buildCreateAndIssuePayload[\s\S]{0,600}?notes: d\.notes \?\? null[\s\S]{0,200}?items: buildItems\(d\)/,
    )
  })

  // red: drop `notes` from buildDocumentsUpdatePatch -> Save changes on an ISSUED
  // document wipes/ignores the notes even though documents_update accepts them.
  it("buildDocumentsUpdatePatch carries the notes for an issued document", () => {
    const d = validDraft({
      status: "issued",
      notes: "Contract FR-2026-88\nCustoms: repaired goods returning to the EU",
    })
    const patch = buildDocumentsUpdatePatch(d, "44444444-4444-4444-4444-444444444444")
    expect(patch.notes).toBe("Contract FR-2026-88\nCustoms: repaired goods returning to the EU")
  })

  it("buildDocumentsUpdatePatch sends null when the notes are unset", () => {
    expect(buildDocumentsUpdatePatch(validDraft({ notes: null }), "id-1").notes).toBeNull()
    expect(buildDocumentsUpdatePatch(validDraft(), "id-1").notes).toBeNull()
  })
})

// E-invoicing in the Editor: customer type and operation type, gated on what einvoicing_classify
// reports. A blocker is never a dead end: each names its field and carries one action; warn mode
// issues anyway and says, calmly, what is still to complete.
describe("Editor e-invoicing fields", () => {
  const frDraft = (over: Partial<DraftDocument> = {}) =>
    validDraft({
      counterparty_name: "Atelier Fictif SARL",
      counterparty_address: "1 rue Imaginaire, 75001 Paris",
      counterparty_country: "FR",
      ...over,
    })

  it('Issue disabled with "Customer type is required" for an FR buyer', () => {
    const d = frDraft()
    expect(canIssue(d)).toBe(true)
    const state = einvoicingIssueState(d, null)
    expect(state.blockers.map((b) => b.message)).toContain("Customer type is required.")
    expect(state.blockers.find((b) => b.field === "customer_kind")?.action).toEqual({
      kind: "field",
      field: "customer_kind",
      label: "Fill in this field",
    })
    expect(canIssueWithEinvoicing(d, null)).toBe(false)
    expect(
      canIssueWithEinvoicing(
        frDraft({ customer_kind: "business", operation_category: "goods" }),
        null,
      ),
    ).toBe(true)
  })

  it("the customer's recorded kind satisfies the requirement; other buyers and non-invoices never need it", () => {
    const identityKind = {
      regime: "e_reporting" as const,
      buyer: { source: "identity", customer_kind: "individual" as const },
    }
    expect(einvoicingIssueState(frDraft(), identityKind).blockers).toEqual([])
    expect(einvoicingIssueState(validDraft({ counterparty_country: "DE" }), null).blockers).toEqual(
      [],
    )
    expect(einvoicingIssueState(frDraft({ type: "quote" }), null).blockers).toEqual([])
  })

  it("Operation type required when classify says e_invoice", () => {
    const verdict = {
      regime: "e_invoice" as const,
      gate_mode: "enforce" as const,
      would_refuse: null,
    }
    const d = frDraft({ customer_kind: "business" })
    expect(einvoicingIssueState(d, verdict).blockers.map((b) => b.message)).toEqual([
      "Operation type is required.",
    ])
    expect(canIssueWithEinvoicing(d, verdict)).toBe(false)
    expect(
      einvoicingIssueState(
        frDraft({ customer_kind: "business", operation_category: "services" }),
        verdict,
      ).blockers,
    ).toEqual([])
    expect(
      einvoicingIssueState(d, { regime: "e_reporting", gate_mode: "enforce", would_refuse: null })
        .blockers,
    ).toEqual([])
  })

  it("an enforce refusal from classify blocks Issue, each blocker with one action", () => {
    const verdict = {
      regime: "e_invoice" as const,
      gate_mode: "enforce" as const,
      would_refuse: {
        code: "einvoice_data_missing",
        message: "E-invoicing data is missing.",
        missing: [{ field: "buyer_siren", fix_tool: "counterparty_identity_lookup" }],
      },
    }
    const d = frDraft({
      customer_kind: "business",
      operation_category: "goods",
      counterparty_contact_id: "c-1",
    })
    const state = einvoicingIssueState(d, verdict, { documentId: "doc-1" })
    expect(state.blockers).toHaveLength(1)
    expect(state.blockers[0]!.message).toContain("SIREN")
    expect(state.blockers[0]!.action).toEqual({
      kind: "open",
      href: "/invoicing/identity/c-1",
      label: "Open the customer identity",
    })
    expect(state.note).toBeNull()
    expect(canIssueWithEinvoicing(d, verdict)).toBe(false)
  })

  it("warn mode shows the note and keeps Issue enabled", () => {
    const verdict = {
      regime: "e_invoice" as const,
      gate_mode: "warn" as const,
      would_refuse: {
        code: "einvoice_data_missing",
        message: "E-invoicing data is missing.",
        missing: [{ field: "buyer_siren", fix_tool: "counterparty_identity_lookup" }],
      },
    }
    const d = frDraft({ counterparty_contact_id: "c-1" })
    const state = einvoicingIssueState(d, verdict)
    expect(state.blockers).toEqual([])
    expect(state.note).toContain("SIREN")
    expect(state.note).toContain("customer type")
    expect(canIssueWithEinvoicing(d, verdict)).toBe(true)
  })

  it("the fields round-trip through drafts_update and reach the one-shot issue call", () => {
    expect(sourceEditor).toMatch(
      /const draftPatch[\s\S]{0,1600}?customer_kind: draft\(\)\.customer_kind \?\? null/,
    )
    expect(sourceEditor).toMatch(
      /const draftPatch[\s\S]{0,1800}?operation_category: draft\(\)\.operation_category \?\? null/,
    )
    expect(sourceEditor).toMatch(
      /buildCounterparty[\s\S]{0,900}?customer_kind: d\.customer_kind \?\? null/,
    )
    expect(sourceEditor).toContain('testid="editor-field-customer-kind"')
    expect(sourceEditor).toContain('testid="editor-field-operation-category"')
    expect(sourceEditor).toContain("einvoicing_classify")
    // Calm: the e-invoicing note is never painted as an error.
    expect(sourceEditor).toMatch(
      /data-testid="editor-einvoicing-note"[^>]*class="[^"]*text-text-secondary/,
    )
  })
})

describe("the default issue date", () => {
  it("a new document takes its issuer's today while the field holds the default", () => {
    expect(issuedAtForIssuer("2026-12-31", "2026-12-31", "2027-01-01")).toBe("2027-01-01")
  })

  it("a date somebody typed stays", () => {
    expect(issuedAtForIssuer("2026-12-15", "2026-12-31", "2027-01-01")).toBe("2026-12-15")
  })

  it("an opened document keeps its date", () => {
    expect(issuedAtForIssuer("2026-12-31", null, "2027-01-01")).toBe("2026-12-31")
  })

  it("an issuer whose zone is unknown leaves the date as it is", () => {
    expect(issuedAtForIssuer("2026-12-31", "2026-12-31", null)).toBe("2026-12-31")
  })

  it("the date shown before the issuer is known is this computer's, not UTC's", () => {
    // Noon-free local parts: 00:20 local on 1 January is 1 January, whatever the offset to UTC.
    expect(localCivilDate(new Date(2027, 0, 1, 0, 20))).toBe("2027-01-01")
    expect(localCivilDate(new Date(2026, 11, 31, 23, 59))).toBe("2026-12-31")
  })
})

describe("the issue date of a new document", () => {
  const chosen = { ...defaultDraft("quote"), issued_at: "2026-10-30" }

  it("a date the person chose is sent", () => {
    for (const type of ["quote", "proforma", "purchase_order", "credit_note"] as const) {
      expect(statedIssuedAt({ ...chosen, type }, "2026-11-06")).toBe("2026-10-30")
    }
  })

  it("the default the field was given is not a choice: the server dates it", () => {
    expect(statedIssuedAt({ ...chosen, issued_at: "2026-11-06" }, "2026-11-06")).toBeUndefined()
  })

  it("an emptied field sends nothing", () => {
    expect(statedIssuedAt({ ...chosen, issued_at: null }, "2026-11-06")).toBeUndefined()
  })

  it("an invoice takes its date from the moment its number is taken", () => {
    expect(statedIssuedAt({ ...chosen, type: "invoice" }, "2026-11-06")).toBeUndefined()
  })

  // An unknown top-level parameter is refused outright, so sending the date to a tool that does
  // not declare it would stop every new document of that type from being created.
  it("every create tool the date is sent to declares it", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "../../app.manifest.json"), "utf8"),
    ) as {
      tools: Record<string, { params: { properties: Record<string, unknown> } }>
    }
    for (const tool of [
      "quote_create_and_issue",
      "proforma_create_and_issue",
      "po_create_and_issue",
      "credit_note_create_and_issue",
    ]) {
      expect(manifest.tools[tool]?.params.properties.issued_at, tool).toBeDefined()
    }
  })
})

describe("issueDateNotice: a date the server will refuse shows before the click", () => {
  const today = "2026-11-06"
  const quote = (issued_at: string | null) => ({ ...defaultDraft("quote"), issued_at })
  const shop = { id: "i", legal_name: "S", country: "FR", today, shopify_shop_id: "shop.example" }
  const plain = { id: "i", legal_name: "S", country: "FR", today }

  it("a quote on a shop-linked issuer takes its draft order's day", () => {
    expect(issueDateNotice(quote("2026-10-15"), today, shop)).toContain("Shopify draft order")
  })

  it("the default date, no date and today are no choice to refuse", () => {
    expect(issueDateNotice(quote(today), today, shop)).toBeNull()
    expect(issueDateNotice(quote(null), today, shop)).toBeNull()
    expect(issueDateNotice(quote(today), null, shop)).toBeNull()
  })

  it("a date after today is refused for any type that takes one", () => {
    expect(issueDateNotice(quote("2026-12-25"), today, plain)).toContain("after today")
    expect(
      issueDateNotice({ ...defaultDraft("proforma"), issued_at: "2026-12-25" }, today, plain),
    ).toContain("after today")
  })

  it("a past date on an issuer with no shop is fine, and so is an unknown today", () => {
    expect(issueDateNotice(quote("2026-10-15"), today, plain)).toBeNull()
    expect(issueDateNotice(quote("2026-12-25"), today, { ...plain, today: null })).toBeNull()
  })

  it("an invoice takes no date, so it never warns", () => {
    expect(
      issueDateNotice({ ...defaultDraft("invoice"), issued_at: "2026-12-25" }, today, plain),
    ).toBeNull()
  })
})

describe("the VAT rate is typed and read as a percent", () => {
  it("shows 20 for 2000 basis points and reads typed percents back", () => {
    expect(bpToPercentInput(2000)).toBe("20")
    expect(bpToPercentInput(550)).toBe("5.5")
    expect(percentInputToBp("20")).toBe(2000)
    expect(percentInputToBp("5,5")).toBe(550)
    expect(percentInputToBp("5.5 %")).toBe(550)
    expect(percentInputToBp("")).toBe(0)
    expect(percentInputToBp("abc")).toBeNull()
  })

  it("hides the customs columns on a domestic services invoice with no customs data", () => {
    const line = { hs_code: null, country_of_origin: null } as unknown as DraftLine
    expect(showCustomsColumns([line], "domestic")).toBe(false)
    expect(showCustomsColumns([line], "eu_export_non_eu")).toBe(true)
    expect(showCustomsColumns([{ ...line, hs_code: "8518" }], "domestic")).toBe(true)
  })
})
