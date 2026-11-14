// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The regime line on a document: the regime in plain words with its one-line reason, in the
// reader's language, and a calm "data to complete" note when the document was issued in warn
// mode or a draft still lacks data. Never an alarm colour, every gap carries one action.
import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RegimeLine, regimeLineView } from "./RegimeLine"

const source = readFileSync(join(import.meta.dir, "RegimeLine.tsx"), "utf-8")

afterEach(() => {
  ;(globalThis as { __liaisonHost?: unknown }).__liaisonHost = undefined
})

const eInvoiceReason = {
  code: "fr_business_with_siren",
  en: "French business buyer with an active SIREN: e-invoicing.",
  fr: "Acheteur professionnel français avec un SIREN actif : facturation électronique.",
}

describe("RegimeLine", () => {
  it("names the regime and its reason in plain words", () => {
    const v = regimeLineView({ regime: "e_invoice", reasons: [eInvoiceReason] }, {})
    expect(v.label).toBe("E-invoice")
    expect(v.reason).toBe("French business buyer with an active SIREN: e-invoicing.")
    expect(v.note).toBeNull()
    expect(regimeLineView({ regime: "e_reporting", reasons: [] }, {}).label).toBe("E-reporting")
    expect(regimeLineView({ regime: "out_of_scope", reasons: [] }, {}).label).toBe("Out of scope")
    expect(regimeLineView({ regime: "needs_review", reasons: [] }, {}).label).toBe(
      "Awaiting a decision",
    )
    expect(regimeLineView({ regime: null, reasons: [] }, {}).label).toBe("Not classified yet")
    // Never a bare state: it says what it means.
    expect(regimeLineView({ regime: null, reasons: [] }, {}).reason).toContain("not yet known")
  })

  it("reads the reason in the reader's language", () => {
    ;(globalThis as { __liaisonHost?: unknown }).__liaisonHost = { locale: () => "fr" }
    const v = regimeLineView({ regime: "e_invoice", reasons: [eInvoiceReason] }, {})
    expect(v.reason).toBe(eInvoiceReason.fr)
    expect(v.label).toBe("Facture électronique")
  })

  it("an issued warn-mode document shows a neutral note naming what to complete, with one action", () => {
    const v = regimeLineView(
      {
        regime: "e_invoice",
        source: "recorded",
        reasons: [
          eInvoiceReason,
          { code: "gate_warning", en: "Issued in warn mode", fr: "Émis", missing: ["buyer_siren"] },
        ],
      },
      { documentId: "doc-1", contactId: "c-1" },
    )
    expect(v.reason).toBe(eInvoiceReason.en)
    expect(v.note).toContain("SIREN")
    expect(v.tone).toBe("neutral")
    expect(v.actions).toEqual([
      { kind: "open", href: "/invoicing/identity/c-1", label: "Open the customer identity" },
    ])
  })

  it("a draft the gate would refuse lists every gap with exactly one action each", () => {
    const v = regimeLineView(
      {
        regime: "e_invoice",
        gate_mode: "enforce",
        reasons: [eInvoiceReason],
        would_refuse: {
          code: "einvoice_data_missing",
          message: "missing",
          missing: [
            { field: "buyer_siren", fix_tool: "counterparty_identity_lookup" },
            { field: "operation_category", fix_tool: "drafts_update" },
          ],
        },
      },
      { documentId: "doc-1", contactId: "c-1" },
    )
    expect(v.tone).toBe("neutral")
    expect(v.note).toContain("SIREN")
    expect(v.note).toContain("operation type")
    expect(v.actions).toEqual([
      { kind: "open", href: "/invoicing/identity/c-1", label: "Open the customer identity" },
      { kind: "open", href: "/invoicing/editor/doc-1", label: "Open the draft" },
    ])
  })

  it("is calm: no alarm colour anywhere in the line, never a modal", () => {
    expect(typeof RegimeLine).toBe("function")
    expect(source).not.toMatch(/text-error|bg-error|border-error|text-warning|bg-warning|red-\d/)
    expect(source).not.toMatch(/ConfirmDialog|role="dialog"/)
    expect(source).toContain('data-testid="document-detail-regime-line"')
  })
})
