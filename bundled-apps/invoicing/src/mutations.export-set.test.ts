// SPDX-License-Identifier: FSL-1.1-ALv2
//
// mutations.ts is an index over ./mutations/ (one file per domain). handlers.ts registers these
// exports by name and the manifest resolves tool and preflight names through it, so the runtime
// export set is pinned with the kind of each export: a tool dropped or renamed while moving code
// between the domain files shows up here. The list was taken from the single-file module before
// the split.
//
// Adding or removing a mutation export means editing this list on purpose.
import { describe, expect, it } from "bun:test"
import * as mutations from "./mutations"

type Kind = "function" | "number" | "set"

const EXPECTED_EXPORTS: ReadonlyArray<readonly [string, Kind]> = [
  ["ISSUED_INVOICE_STATUSES", "set"],
  ["NOTES_MAX_LENGTH", "number"],
  ["assertNoLiveInvoiceForOrder", "function"],
  ["computeLineFinancials", "function"],
  ["contactRelationshipsSet", "function"],
  ["creditNoteCreateAndIssue", "function"],
  ["creditNoteCreateAndIssuePreflight", "function"],
  ["creditNoteIssue", "function"],
  ["creditNoteIssuePreflight", "function"],
  ["creditedTotalMinor", "function"],
  ["documentsConvertLocal", "function"],
  ["documentsConvertToInvoice", "function"],
  ["documentsConvertToInvoicePreflight", "function"],
  ["documentsMarkPaid", "function"],
  ["documentsMarkPaidPreflight", "function"],
  ["documentsRecordRefund", "function"],
  ["documentsRecordRefundPreflight", "function"],
  ["documentsRetryPdf", "function"],
  ["documentsSendToCustomer", "function"],
  ["documentsSendToCustomerPreflight", "function"],
  ["documentsUpdate", "function"],
  ["documentsUpdatePreflight", "function"],
  ["documentsUpdatePreview", "function"],
  ["draftsCreate", "function"],
  ["draftsCreateTool", "function"],
  ["draftsCreatePreflight", "function"],
  ["draftIssuePreview", "function"],
  ["draftsDiscard", "function"],
  ["draftsUpdate", "function"],
  ["draftsUpdateTool", "function"],
  ["draftsUpdatePreflight", "function"],
  ["ensureDocumentPdf", "function"],
  ["hsCodesAssign", "function"],
  ["hsCodesLibraryDelete", "function"],
  ["hsCodesLibraryUpsert", "function"],
  ["hsCodesUnassign", "function"],
  ["inferContactRelationshipOnIssue", "function"],
  ["invoiceCreateAndIssue", "function"],
  ["invoiceCreateAndIssuePreflight", "function"],
  ["invoiceIssue", "function"],
  ["invoiceIssuePreflight", "function"],
  ["isFullyCredited", "function"],
  ["isUniqueViolation", "function"],
  ["liftMisplacedCountry", "function"],
  ["liftMisplacedCountryOnLine", "function"],
  ["liftMisplacedHsCode", "function"],
  ["minorToMajorAmount", "function"],
  ["netLinesForIssuer", "function"],
  ["normaliseNotes", "function"],
  ["normalizeHsCode", "function"],
  ["orderReissueApply", "function"],
  ["orderReissueApplyPreflight", "function"],
  ["poCreateAndIssue", "function"],
  ["poCreateAndIssuePreflight", "function"],
  ["poIssue", "function"],
  ["proformaCreateAndIssue", "function"],
  ["proformaCreateAndIssuePreflight", "function"],
  ["quoteCreateAndIssuePreflight", "function"],
  ["proformaIssue", "function"],
  ["proformaIssuePreflight", "function"],
  ["quoteCreateAndIssue", "function"],
  ["quoteIssue", "function"],
  ["quoteIssuePreflight", "function"],
  ["readDraftOrderId", "function"],
  ["sendErrorFromEnvelope", "function"],
  ["settingsIssuerProfileCreate", "function"],
  ["settingsIssuerProfileDelete", "function"],
  ["settingsIssuerProfileUpdate", "function"],
  ["settingsIssuerProfileWritePreflight", "function"],
  ["splitPostalAddress", "function"],
  ["toShopifyDraftLines", "function"],
]

function kindOf(value: unknown): string {
  if (typeof value === "function") return "function"
  if (value instanceof Set) return "set"
  return typeof value
}

describe("invoicing mutations export set", () => {
  it("exports exactly the pinned names", () => {
    expect(Object.keys(mutations).sort()).toEqual(EXPECTED_EXPORTS.map(([name]) => name).sort())
  })

  it("every pinned export keeps its kind", () => {
    const actual = EXPECTED_EXPORTS.map(([name]) => [
      name,
      kindOf((mutations as Record<string, unknown>)[name]),
    ])
    expect(actual).toEqual(EXPECTED_EXPORTS.map(([name, kind]) => [name, kind]))
  })
})
