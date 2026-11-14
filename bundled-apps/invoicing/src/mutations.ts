// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E6 — Mutating tools (drafts + invoice issuance + lifecycle).
//
// Each tool exported here is registered in the manifest with an appropriate
// `gated`, `trustBoundary`, `approvalCard.summary`, and `editableFields`.
// Threshold-gated tools (invoice.issue, invoice.create_and_issue, po.issue,
// po.create_and_issue) handle the check at handler level — the manifest is
// not gated; the handler explicitly files an approval via `ctx.requestApproval`
// when amount > issuer.invoice_approval_threshold and ctx.approval is unset.
// On post-approval re-entry, the kernel populates `ctx.approval` and the
// handler skips the threshold check — single-approval path.
//
// Two-eyes: enforced inline in the handler. On post-approval re-entry, if
// the issuer profile has `require_two_eyes: true`, reject the mutation when
// the deciding actor is the same as the calling actor.
//
// Drafts are stored as `documents` rows with status='draft'. Their lines
// live in `document_lines` keyed on document_id. Issuance inserts a NEW
// `documents` row (the issued invoice) and then deletes the draft.
//
// The tools live in ./mutations/, one file per domain (shared types and envelopes, db
// helpers, credit coverage, drafts, line normalisation, invoice issuance, quote to invoice
// conversion, payments and refunds, send to customer, quote/proforma/PO issuance, Shopify quotes,
// credit notes, order reissue, customs and contact relationships, issuer profiles, PDFs, post-issue
// update). This index re-exports the public surface that handlers.ts registers and the tests import.

export {
  type ConvertToInvoiceResult,
  documentsConvertLocal,
  documentsConvertToInvoice,
  documentsConvertToInvoicePreflight,
} from "./mutations/convert-to-invoice"
export {
  assertNoLiveInvoiceForOrder,
  creditedTotalMinor,
  ISSUED_INVOICE_STATUSES,
  isFullyCredited,
} from "./mutations/credit-coverage"
export {
  type CreditNoteCreateAndIssueInput,
  creditNoteCreateAndIssue,
  creditNoteCreateAndIssuePreflight,
  creditNoteIssue,
  creditNoteIssuePreflight,
} from "./mutations/credit-notes"
export {
  type ContactRelationshipRow,
  contactRelationshipsSet,
  type HsCodeLibraryRow,
  type HsCodesUnassignField,
  hsCodesAssign,
  hsCodesLibraryDelete,
  hsCodesLibraryUpsert,
  hsCodesUnassign,
  inferContactRelationshipOnIssue,
  normalizeHsCode,
  type ProductCustomsOverlayRow,
  type Relationship,
  type RelationshipSource,
} from "./mutations/customs-relationships"
export { readDraftOrderId } from "./mutations/db-helpers"
export {
  type DocumentsUpdateInput,
  documentsUpdate,
  documentsUpdatePreflight,
  documentsUpdatePreview,
} from "./mutations/documents-update"
export {
  type DraftsCreateInput,
  draftsCreate,
  draftsCreatePreflight,
  draftsCreateTool,
  draftsDiscard,
  draftsUpdate,
  draftsUpdatePreflight,
  draftsUpdateTool,
} from "./mutations/drafts"
export {
  type InvoiceCreateAndIssueInput,
  invoiceCreateAndIssue,
  invoiceCreateAndIssuePreflight,
  invoiceIssue,
  invoiceIssuePreflight,
} from "./mutations/invoice-issue"
export {
  settingsIssuerProfileCreate,
  settingsIssuerProfileDelete,
  settingsIssuerProfileUpdate,
  settingsIssuerProfileWritePreflight,
} from "./mutations/issuer-profiles"
export {
  computeLineFinancials,
  liftMisplacedCountry,
  liftMisplacedCountryOnLine,
  liftMisplacedHsCode,
  netLinesForIssuer,
} from "./mutations/lines"
export {
  type OrderReissueApplyInput,
  type OrderReissueApplyResult,
  orderReissueApply,
  orderReissueApplyPreflight,
} from "./mutations/order-reissue"
export {
  documentsMarkPaid,
  documentsMarkPaidPreflight,
  documentsRecordRefund,
  documentsRecordRefundPreflight,
} from "./mutations/payments"
export {
  type DocumentRenderCtx,
  documentsRetryPdf,
  ensureDocumentPdf,
} from "./mutations/pdf"
export {
  type CreateAndIssueRawInput,
  draftIssuePreview,
  type GatingKind,
  isUniqueViolation,
  type ProformaCreateAndIssueInput,
  poCreateAndIssue,
  poCreateAndIssuePreflight,
  poIssue,
  proformaCreateAndIssue,
  proformaCreateAndIssuePreflight,
  proformaIssue,
  proformaIssuePreflight,
  type QuoteCreateAndIssueInput,
  type QuoteCreateAndIssueResult,
  quoteCreateAndIssue,
  quoteCreateAndIssuePreflight,
  quoteIssue,
  quoteIssuePreflight,
} from "./mutations/quote-proforma-po"
export {
  documentsSendToCustomer,
  documentsSendToCustomerPreflight,
  sendErrorFromEnvelope,
} from "./mutations/send-to-customer"
export {
  type CompletedEnvelope,
  type DocumentRowSummary,
  type DocumentType,
  type DraftInsert,
  type DraftRow,
  type ErrorEnvelope,
  type MutationResult,
  type MutationsCtx,
  type MutationsDb,
  NOTES_MAX_LENGTH,
  normaliseNotes,
  type PendingApprovalEnvelope,
  type PreflightResult,
} from "./mutations/shared"
export {
  minorToMajorAmount,
  type SplitPostalAddress,
  splitPostalAddress,
  toShopifyDraftLines,
} from "./mutations/shopify-quote"
