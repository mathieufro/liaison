// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 — Invoicing plugin app handler bundle entrypoint.
//
// Every name referenced in `app.manifest.json` (tools[].handler,
// jobs[].handler, webhooks[].handler, webhooks[].verify, search.handler,
// attention.handler, events.subscribes[].handler) MUST resolve to a named
// export of this module.
//
// **Kernel-handler arg order convention.** The kernel calls every tool
// handler as `handler(params, ctx)` (see
// `apps/api/src/modules/apps/execute-tool.ts` line 1237). The agent-tool
// implementations in `mutations.ts` and `reads.ts` keep the more readable
// internal signature `(ctx, input)` so the in-app unit tests stay legible.
// This module is the seam — each exported tool handler is a thin arg-flip
// wrapper so the manifest-routed call matches what the kernel expects.
//
// **Naming discipline.** The Bun bundler inlines cross-module names, and the
// kernel's `bundle-loader.esmExportsToGlobalThis` rewrites `export { x as y }`
// into `globalThis.y = x`. If the inner implementation and the exported
// wrapper share a name, the globalThis rebind replaces the inner function
// and the wrapper body recurses into itself (stack overflow). To avoid the
// collision, every wrapper here is exported under a `*Handler` suffix, and
// the manifest's `handler:` fields reference the `*Handler` names directly.
//
// Event-subscription, job, and webhook handlers (handlers/*.ts) already use
// the kernel-expected `(payload, ctx)` shape and are re-exported unchanged.

import { documentsIssuePreview } from "./buyer-vat"
import { customerHistory } from "./customer-history"
import { untrustedCounterparty } from "./einvoicing/issue-gate"
import type { Counterparty } from "./issue"
import {
  contactRelationshipsSet,
  creditNoteCreateAndIssue,
  creditNoteCreateAndIssuePreflight,
  creditNoteIssue,
  creditNoteIssuePreflight,
  documentsConvertLocal,
  documentsConvertToInvoice,
  documentsConvertToInvoicePreflight,
  documentsMarkPaid,
  documentsMarkPaidPreflight,
  documentsRecordRefund,
  documentsRecordRefundPreflight,
  documentsRetryPdf,
  documentsSendToCustomer,
  documentsSendToCustomerPreflight,
  documentsUpdate,
  documentsUpdatePreflight,
  documentsUpdatePreview,
  draftIssuePreview,
  draftsCreatePreflight,
  draftsCreateTool,
  draftsDiscard,
  draftsUpdatePreflight,
  draftsUpdateTool,
  hsCodesAssign,
  hsCodesLibraryDelete,
  hsCodesLibraryUpsert,
  hsCodesUnassign,
  invoiceCreateAndIssue,
  invoiceCreateAndIssuePreflight,
  invoiceIssue,
  invoiceIssuePreflight,
  orderReissueApply,
  orderReissueApplyPreflight,
  poCreateAndIssue,
  poCreateAndIssuePreflight,
  poIssue,
  proformaCreateAndIssue,
  proformaCreateAndIssuePreflight,
  proformaIssue,
  proformaIssuePreflight,
  quoteCreateAndIssue,
  quoteCreateAndIssuePreflight,
  quoteIssue,
  quoteIssuePreflight,
  settingsIssuerProfileCreate,
  settingsIssuerProfileDelete,
  settingsIssuerProfileUpdate,
  settingsIssuerProfileWritePreflight,
} from "./mutations"
import { lineAmountsError } from "./mutations/shared"
import { ordersInvoiceabilityCheck } from "./order-invoiceability"
import {
  contactRelationshipsGet,
  deferredList,
  documentsDownloadPdf,
  documentsForOrders,
  documentsGet,
  documentsPreviewPdf,
  documentsSearchTool,
  exportDocuments,
  hsCodesLookup,
  pendingApprovalsList,
  settingsHsCodeList,
  settingsIssuerProfileList,
  settingsShopMappingList,
  settingsTaxRegimeList,
  vatValidate,
  viewerAccess,
} from "./reads"
import { recurringDraftJob, recurringDraftWrite } from "./recurring/draft-job"
import { recurringIssueJob, recurringItemIssue } from "./recurring/issue-job"
import { recurringLegalDateJob } from "./recurring/legal-date-job"
import {
  approvalRouteRead,
  type RunCtx,
  recurringRunIssue,
  recurringRunIssuePreflight,
  recurringRunUnapprove,
  recurringRunUnapprovePreflight,
} from "./recurring/run-card"
import { recurringRunGet } from "./recurring/run-get"
import {
  checkScheduleCreate,
  checkScheduleInput,
  checkScheduleUpdate,
  recurringList,
  recurringScheduleCreate,
  recurringSchedulePause,
  recurringScheduleUpdate,
} from "./recurring/tools"
import {
  cardStreamIssuer,
  issuerEmailsConfirm,
  issuerEmailsConfirmPreflight,
  issuerStreamGet,
  issuerStreamSet,
  issuerStreamSetPreflight,
  onStripeConnectionChanged,
} from "./streams"
import { projectInvoicedGet } from "./tools/project-invoiced-get"
import { vatLookup } from "./vat-lookup"

/** Wire params of an issuing call: a SIREN's registry confirmation is never taken from the
 *  caller (defence in depth: the gate also ignores any confirmation on a call snapshot). */
function fromWire<T extends { counterparty?: Counterparty | null }>(params: T): T {
  return params && typeof params === "object" && params.counterparty
    ? { ...params, counterparty: untrustedCounterparty(params.counterparty) }
    : params
}

// --- Event-subscription handlers (Shopify webhook fan-out) ---
// onShopifyOrderCreated is the manifest-subscribed entry for shopify/order:created
// (adapts the event → OrderPaidPayload, then delegates to onShopifyOrderPaid).
export { onShopifyOrderCreated, onShopifyOrderPaid } from "./handlers/shopify-order-paid"
// Syncs Shopify product customs (HS code + country of origin + customs-description
// metafield) into product_customs_overlay so export invoices auto-carry them.
export { onShopifyProductChanged } from "./handlers/shopify-product-changed"
export { onShopifyRefundCreated } from "./handlers/shopify-refund-created"

import {
  catchUpMissedPaidOrder,
  type OrderPaidCtx,
  type OrderPaidResult,
} from "./handlers/shopify-order-paid"
import {
  type OrderUpdatedCtx,
  type OrderUpdatedResult,
  observeShopifyOrderUpdated,
} from "./handlers/shopify-order-updated"

// shopify/order:updated: record the billing baseline / flag a billable divergence on an
// invoiced order (shopify-order-updated.ts). When the order has NO billing document at all,
// fall through to the paid-order catch-up so an order whose order:created dispatch was lost
// is invoiced on its next update instead of never.
export async function onShopifyOrderUpdated(
  event: Parameters<typeof observeShopifyOrderUpdated>[0] & Record<string, unknown>,
  ctx: OrderPaidCtx & Pick<OrderUpdatedCtx, "emit">,
): Promise<OrderUpdatedResult | OrderPaidResult> {
  const observed = await observeShopifyOrderUpdated(event, ctx as unknown as OrderUpdatedCtx)
  if (observed.status !== "noop") return observed
  return catchUpMissedPaidOrder(event as Parameters<typeof catchUpMissedPaidOrder>[0], ctx)
}
// ONE-TIME backfill (remove once prod reports 0 remaining): records the human
// Shopify order number on documents issued before the column existed, so the
// whole history is searchable by order number. Fills from external_refs when the
// importer already wrote it, else one shopify:orders_get per unique order.
export { backfillOrderNumbersJobHandler } from "./handlers/backfill-order-numbers"
// --- Scheduled jobs ---
// `deferredRetryJobHandler` is the kernel-shaped `(payload, ctx)` wrapper that
// supplies the real re-dispatch (the pure `deferredRetryJob` drain takes an
// injected dispatch for testability and cannot be the manifest handler itself).
export { deferredRetryJobHandler } from "./handlers/deferred-dispatch"
// Writes the Boxtal shipment(s) created against an invoice back onto it (external_refs.shipments)
// through boxtal's public search tool, so invoice and parcel resolve each other in one hop.
export { linkShipmentsJobHandler } from "./handlers/link-shipments"
// `overdueScanJobHandler` is the kernel-shaped `(payload, ctx)` wrapper; the
// inner `overdueScanJob(ctx, opts)` keeps its readable shape for unit tests.
export { overdueScanJobHandler } from "./handlers/overdue-scan"
// `reconcileShopifyPaymentsJobHandler` is the kernel-shaped `(payload, ctx)`
// wrapper; the inner `reconcileShopifyPayments(ctx, opts)` keeps its readable
// shape for unit tests. Reconciles issued Shopify invoices' payment_status
// against the authoritative Shopify order financial_status.
export { reconcileShopifyPaymentsJobHandler } from "./handlers/reconcile-shopify-payments"
// Issues a dead run left numbered but unrendered: their render and owed email are parked for
// deferred-retry (handlers/resume-interrupted.ts).
export { resumeInterruptedIssuesJobHandler } from "./handlers/resume-interrupted"
// Quotes ARE Shopify draft orders when the issuer profile is mapped to a shop: these four keep
// the quote and its draft order in step (create/update mirror it, complete marks it invoiced,
// delete rejects it). See handlers/shopify-draft-order.ts for the full contract.
export {
  onShopifyDraftOrderCompleted,
  onShopifyDraftOrderCreated,
  onShopifyDraftOrderDeleted,
  onShopifyDraftOrderUpdated,
} from "./handlers/shopify-draft-order"
export { onShopifyOrderCancelled } from "./handlers/shopify-order-cancelled"

import { backfillOrderNumbers } from "./handlers/backfill-order-numbers"
import { deferredTaxOverride, deferredTaxOverridePreflight } from "./handlers/tax-override"

// --- Data-export handler (kernel `export` tool — manifest `export.handler`) — BL-188 ---
// Invoked by the export orchestrator as (params:{format,dateRange}, ctx); the FULL-RLS-set documents
// export. Arg-flip wrapper to the readable (ctx, params) impl, like the read tools below.
export const documentsExportHandler = (
  params: Parameters<typeof exportDocuments>[1],
  ctx: Parameters<typeof exportDocuments>[0],
) => exportDocuments(ctx, params)

// --- Timeline source (kernel activitySources; not agent-visible) ---
export const activityReadHandler = (params: unknown, ctx: Parameters<typeof activityRead>[0]) =>
  activityRead(ctx, params)

// --- Read tools (agent-visible, ungated) ---
export const documentsSearchHandler = (
  params: Parameters<typeof documentsSearchTool>[1],
  ctx: Parameters<typeof documentsSearchTool>[0],
) => documentsSearchTool(ctx, params)
export const projectInvoicedGetHandler = (
  params: Parameters<typeof projectInvoicedGet>[1],
  ctx: Parameters<typeof projectInvoicedGet>[0],
) => projectInvoicedGet(ctx, params)
export const customerHistoryHandler = (
  params: Parameters<typeof customerHistory>[1],
  ctx: Parameters<typeof customerHistory>[0],
) => customerHistory(ctx, params)
export const documentsGetHandler = (
  params: Parameters<typeof documentsGet>[1],
  ctx: Parameters<typeof documentsGet>[0],
) => documentsGet(ctx, params)
// The Shopify app's draft order create / complete preflights ask this before staging (cross-app).
export const ordersInvoiceabilityCheckHandler = (
  params: Parameters<typeof ordersInvoiceabilityCheck>[1],
  ctx: Parameters<typeof ordersInvoiceabilityCheck>[0],
) => ordersInvoiceabilityCheck(ctx, params)
export const documentsForOrdersHandler = (
  params: Parameters<typeof documentsForOrders>[1],
  ctx: Parameters<typeof documentsForOrders>[0],
) => documentsForOrders(ctx, params)
export const hsCodesLookupHandler = (
  params: Parameters<typeof hsCodesLookup>[1],
  ctx: Parameters<typeof hsCodesLookup>[0],
) => hsCodesLookup(ctx, params)
export const pendingApprovalsListHandler = (
  params: Parameters<typeof pendingApprovalsList>[1],
  ctx: Parameters<typeof pendingApprovalsList>[0],
) => pendingApprovalsList(ctx, params)
export const vatValidateHandler = (
  params: Parameters<typeof vatValidate>[1],
  ctx: Parameters<typeof vatValidate>[0],
) => vatValidate(ctx, params)
export const vatLookupHandler = (
  params: Parameters<typeof vatLookup>[1],
  ctx: Parameters<typeof vatLookup>[0],
) => vatLookup(ctx, params)

// --- Settings + secondary read tools (Task F — agent/UI-visible, ungated) ---
export const contactRelationshipsGetHandler = (
  params: Parameters<typeof contactRelationshipsGet>[1],
  ctx: Parameters<typeof contactRelationshipsGet>[0],
) => contactRelationshipsGet(ctx, params)
export const deferredTaxOverrideHandler = (
  params: { deferred_id?: string; mode?: string },
  ctx: Parameters<typeof deferredTaxOverride>[0],
) => deferredTaxOverride(ctx, params)
export const deferredTaxOverridePreflightHandler = (
  params: { deferred_id?: string; mode?: string },
  ctx: Parameters<typeof deferredTaxOverridePreflight>[0],
) => deferredTaxOverridePreflight(ctx, params)
export const deferredListHandler = (
  params: Parameters<typeof deferredList>[1],
  ctx: Parameters<typeof deferredList>[0],
) => deferredList(ctx, params)
export const settingsIssuerProfileListHandler = (
  _params: unknown,
  ctx: Parameters<typeof settingsIssuerProfileList>[0],
) => settingsIssuerProfileList(ctx)
export const documentsIssuePreviewHandler = (
  params: Parameters<typeof documentsIssuePreview>[1],
  ctx: Parameters<typeof documentsIssuePreview>[0],
) => documentsIssuePreview(ctx, params)
export const viewerAccessHandler = (_params: unknown, ctx: Parameters<typeof viewerAccess>[0]) =>
  viewerAccess(ctx)
export const settingsTaxRegimeListHandler = (
  _params: unknown,
  ctx: Parameters<typeof settingsTaxRegimeList>[0],
) => settingsTaxRegimeList(ctx)
export const settingsHsCodeListHandler = (
  params: Parameters<typeof settingsHsCodeList>[1],
  ctx: Parameters<typeof settingsHsCodeList>[0],
) => settingsHsCodeList(ctx, params)
export const settingsShopMappingListHandler = (
  _params: unknown,
  ctx: Parameters<typeof settingsShopMappingList>[0],
) => settingsShopMappingList(ctx)

// --- Mutating tools (agent-visible, threshold/always-gated per spec §"Agent Tool Surface") ---
export const draftsCreateHandler = (
  params: Parameters<typeof draftsCreateTool>[1],
  ctx: Parameters<typeof draftsCreateTool>[0],
) => draftsCreateTool(ctx, params)
export const draftsUpdateHandler = (
  params: Parameters<typeof draftsUpdateTool>[1],
  ctx: Parameters<typeof draftsUpdateTool>[0],
) => draftsUpdateTool(ctx, params)
export const draftsDiscardHandler = (
  params: Parameters<typeof draftsDiscard>[1],
  ctx: Parameters<typeof draftsDiscard>[0],
) => draftsDiscard(ctx, params)
export const invoiceIssueHandler = (
  params: Parameters<typeof invoiceIssue>[1],
  ctx: Parameters<typeof invoiceIssue>[0],
) => invoiceIssue(ctx, params)
export const invoiceCreateAndIssueHandler = (
  params: Parameters<typeof invoiceCreateAndIssue>[1],
  ctx: Parameters<typeof invoiceCreateAndIssue>[0],
) => invoiceCreateAndIssue(ctx, fromWire(params))
export const documentsConvertToInvoiceHandler = (
  params: Parameters<typeof documentsConvertToInvoice>[1],
  ctx: Parameters<typeof documentsConvertToInvoice>[0],
) => documentsConvertToInvoice(ctx, params)
export const documentsConvertLocalHandler = (
  params: Parameters<typeof documentsConvertLocal>[1],
  ctx: Parameters<typeof documentsConvertLocal>[0],
) => documentsConvertLocal(ctx, params)
export const documentsMarkPaidHandler = (
  params: Parameters<typeof documentsMarkPaid>[1],
  ctx: Parameters<typeof documentsMarkPaid>[0],
) => documentsMarkPaid(ctx, params)
export const documentsRecordRefundHandler = (
  params: Parameters<typeof documentsRecordRefund>[1],
  ctx: Parameters<typeof documentsRecordRefund>[0],
) => documentsRecordRefund(ctx, params)
export const documentsSendToCustomerHandler = (
  params: Parameters<typeof documentsSendToCustomer>[1],
  ctx: Parameters<typeof documentsSendToCustomer>[0],
) => documentsSendToCustomer(ctx, params)
export const quoteIssueHandler = (
  params: Parameters<typeof quoteIssue>[1],
  ctx: Parameters<typeof quoteIssue>[0],
) => quoteIssue(ctx, params)
export const quoteCreateAndIssueHandler = (
  params: Parameters<typeof quoteCreateAndIssue>[1],
  ctx: Parameters<typeof quoteCreateAndIssue>[0],
) => quoteCreateAndIssue(ctx, fromWire(params))
export const proformaIssueHandler = (
  params: Parameters<typeof proformaIssue>[1],
  ctx: Parameters<typeof proformaIssue>[0],
) => proformaIssue(ctx, params)
export const proformaCreateAndIssueHandler = (
  params: Parameters<typeof proformaCreateAndIssue>[1],
  ctx: Parameters<typeof proformaCreateAndIssue>[0],
) => proformaCreateAndIssue(ctx, fromWire(params))
export const poIssueHandler = (
  params: Parameters<typeof poIssue>[1],
  ctx: Parameters<typeof poIssue>[0],
) => poIssue(ctx, params)
export const poCreateAndIssueHandler = (
  params: Parameters<typeof poCreateAndIssue>[1],
  ctx: Parameters<typeof poCreateAndIssue>[0],
) => poCreateAndIssue(ctx, fromWire(params))
export const creditNoteCreateAndIssueHandler = (
  params: Parameters<typeof creditNoteCreateAndIssue>[1],
  ctx: Parameters<typeof creditNoteCreateAndIssue>[0],
) => creditNoteCreateAndIssue(ctx, fromWire(params))
export const creditNoteIssueHandler = (
  params: Parameters<typeof creditNoteIssue>[1],
  ctx: Parameters<typeof creditNoteIssue>[0],
) => creditNoteIssue(ctx, params)
export const orderReissueApplyHandler = (
  params: Parameters<typeof orderReissueApply>[1],
  ctx: Parameters<typeof orderReissueApply>[0],
) => orderReissueApply(ctx, params)
export const hsCodesAssignHandler = (
  params: Parameters<typeof hsCodesAssign>[1],
  ctx: Parameters<typeof hsCodesAssign>[0],
) => hsCodesAssign(ctx, params)
export const hsCodesUnassignHandler = (
  params: Parameters<typeof hsCodesUnassign>[1],
  ctx: Parameters<typeof hsCodesUnassign>[0],
) => hsCodesUnassign(ctx, params)
export const hsCodesLibraryUpsertHandler = (
  params: Parameters<typeof hsCodesLibraryUpsert>[1],
  ctx: Parameters<typeof hsCodesLibraryUpsert>[0],
) => hsCodesLibraryUpsert(ctx, params)
export const hsCodesLibraryDeleteHandler = (
  params: Parameters<typeof hsCodesLibraryDelete>[1],
  ctx: Parameters<typeof hsCodesLibraryDelete>[0],
) => hsCodesLibraryDelete(ctx, params)
export const contactRelationshipsSetHandler = (
  params: Parameters<typeof contactRelationshipsSet>[1],
  ctx: Parameters<typeof contactRelationshipsSet>[0],
) => contactRelationshipsSet(ctx, params)

// --- Settings issuer CRUD + PDF actions (Task F) ---
export const settingsIssuerProfileCreateHandler = (
  params: Parameters<typeof settingsIssuerProfileCreate>[1],
  ctx: Parameters<typeof settingsIssuerProfileCreate>[0],
) => settingsIssuerProfileCreate(ctx, params)
export const settingsIssuerProfileUpdateHandler = (
  params: Parameters<typeof settingsIssuerProfileUpdate>[1],
  ctx: Parameters<typeof settingsIssuerProfileUpdate>[0],
) => settingsIssuerProfileUpdate(ctx, params)
export const settingsIssuerProfileCreatePreflightHandler = (
  params: Record<string, unknown>,
  ctx: Parameters<typeof settingsIssuerProfileWritePreflight>[0],
) => settingsIssuerProfileWritePreflight(ctx, "create", params)
export const settingsIssuerProfileUpdatePreflightHandler = (
  params: Record<string, unknown>,
  ctx: Parameters<typeof settingsIssuerProfileWritePreflight>[0],
) => settingsIssuerProfileWritePreflight(ctx, "update", params)
export const settingsIssuerProfileDeletePreflightHandler = (
  params: Record<string, unknown>,
  ctx: Parameters<typeof settingsIssuerProfileWritePreflight>[0],
) => settingsIssuerProfileWritePreflight(ctx, "delete", params)
export const settingsIssuerProfileDeleteHandler = (
  params: Parameters<typeof settingsIssuerProfileDelete>[1],
  ctx: Parameters<typeof settingsIssuerProfileDelete>[0],
) => settingsIssuerProfileDelete(ctx, params)
export const documentsRetryPdfHandler = (
  params: Parameters<typeof documentsRetryPdf>[1],
  ctx: Parameters<typeof documentsRetryPdf>[0],
) => documentsRetryPdf(ctx, params)
export const documentsUpdateHandler = (
  params: Parameters<typeof documentsUpdate>[1],
  ctx: Parameters<typeof documentsUpdate>[0],
) => documentsUpdate(ctx, params)
export const documentsUpdatePreflightHandler = (
  params: Parameters<typeof documentsUpdatePreflight>[1],
  ctx: Parameters<typeof documentsUpdatePreflight>[0],
) => documentsUpdatePreflight(ctx, params)
export const documentsUpdatePreviewHandler = (
  params: Parameters<typeof documentsUpdatePreview>[1],
  ctx: Parameters<typeof documentsUpdatePreview>[0],
) => documentsUpdatePreview(ctx, params)
export const quoteIssuePreflightHandler = (
  params: Parameters<typeof quoteIssuePreflight>[1],
  ctx: Parameters<typeof quoteIssuePreflight>[0],
) => quoteIssuePreflight(ctx, params)
export const documentsPreviewPdfHandler = (
  params: Parameters<typeof documentsPreviewPdf>[1],
  ctx: Parameters<typeof documentsPreviewPdf>[0],
) => documentsPreviewPdf(ctx, params)
export const documentsDownloadPdfHandler = (
  params: Parameters<typeof documentsDownloadPdf>[1],
  ctx: Parameters<typeof documentsDownloadPdf>[0],
) => documentsDownloadPdf(ctx, params)

// --- STAGE-TIME preflights for the gated tools (manifest `preflight`) ---
// The kernel runs these BEFORE it creates the approval request: a gated call must not be parked
// for a human when the data it needs is missing or invalid, because the approver can only watch
// it fail. Each one calls the SAME validation function its handler calls (never a second copy
// that could drift), and is read-only: lookups, no writes, no sends.
export const invoiceIssuePreflightHandler = (
  params: Parameters<typeof invoiceIssuePreflight>[1],
  ctx: Parameters<typeof invoiceIssuePreflight>[0],
) => invoiceIssuePreflight(ctx, params)
export const invoiceCreateAndIssuePreflightHandler = (
  params: Parameters<typeof invoiceCreateAndIssuePreflight>[1],
  ctx: Parameters<typeof invoiceCreateAndIssuePreflight>[0],
) => invoiceCreateAndIssuePreflight(ctx, fromWire(params))
export const documentsConvertToInvoicePreflightHandler = (
  params: Parameters<typeof documentsConvertToInvoicePreflight>[1],
  ctx: Parameters<typeof documentsConvertToInvoicePreflight>[0],
) => documentsConvertToInvoicePreflight(ctx, params)
export const documentsMarkPaidPreflightHandler = (
  params: Parameters<typeof documentsMarkPaidPreflight>[1],
  ctx: Parameters<typeof documentsMarkPaidPreflight>[0],
) => documentsMarkPaidPreflight(ctx, params)
export const documentsRecordRefundPreflightHandler = (
  params: Parameters<typeof documentsRecordRefundPreflight>[1],
  ctx: Parameters<typeof documentsRecordRefundPreflight>[0],
) => documentsRecordRefundPreflight(ctx, params)
export const documentsSendToCustomerPreflightHandler = (
  params: Parameters<typeof documentsSendToCustomerPreflight>[1],
  ctx: Parameters<typeof documentsSendToCustomerPreflight>[0],
) => documentsSendToCustomerPreflight(ctx, params)
export const proformaIssuePreflightHandler = (
  params: Parameters<typeof proformaIssuePreflight>[1],
  ctx: Parameters<typeof proformaIssuePreflight>[0],
) => proformaIssuePreflight(ctx, params)
export const draftIssuePreviewHandler = (
  params: Parameters<typeof draftIssuePreview>[1],
  ctx: Parameters<typeof draftIssuePreview>[0],
) => draftIssuePreview(ctx, params)
export const poCreateAndIssuePreflightHandler = (
  params: Parameters<typeof poCreateAndIssuePreflight>[1],
  ctx: Parameters<typeof poCreateAndIssuePreflight>[0],
) => poCreateAndIssuePreflight(ctx, fromWire(params))
/**
 * A draft's money is refused before anything parks, as it is on the create-and-issue tools; then
 * the same draft run, stopped before the write, validates its lines and notes.
 */
export const draftsCreatePreflightHandler = async (
  params: Parameters<typeof draftsCreatePreflight>[1],
  ctx: Parameters<typeof draftsCreatePreflight>[0],
) => {
  const refused = lineAmountsError(params.items)
  return refused ? { error: refused.error } : draftsCreatePreflight(ctx, params)
}
export const draftsUpdatePreflightHandler = async (
  params: Parameters<typeof draftsUpdatePreflight>[1],
  ctx: Parameters<typeof draftsUpdatePreflight>[0],
) => {
  const refused = lineAmountsError(params.patch?.lines, "patch.lines")
  return refused ? { error: refused.error } : draftsUpdatePreflight(ctx, params)
}
export const proformaCreateAndIssuePreflightHandler = (
  params: Parameters<typeof proformaCreateAndIssuePreflight>[1],
  ctx: Parameters<typeof proformaCreateAndIssuePreflight>[0],
) => proformaCreateAndIssuePreflight(ctx, fromWire(params))
export const quoteCreateAndIssuePreflightHandler = (
  params: Parameters<typeof quoteCreateAndIssuePreflight>[1],
  ctx: Parameters<typeof quoteCreateAndIssuePreflight>[0],
) => quoteCreateAndIssuePreflight(ctx, fromWire(params))
export const orderReissueApplyPreflightHandler = (
  params: Parameters<typeof orderReissueApplyPreflight>[1],
  ctx: Parameters<typeof orderReissueApplyPreflight>[0],
) => orderReissueApplyPreflight(ctx, params)

// --- Gated-tool approval summarizers ---
export * from "./summarizers"
export const creditNoteCreateAndIssuePreflightHandler = (
  params: Parameters<typeof creditNoteCreateAndIssuePreflight>[1],
  ctx: Parameters<typeof creditNoteCreateAndIssuePreflight>[0],
) => creditNoteCreateAndIssuePreflight(ctx, fromWire(params))
export const creditNoteIssuePreflightHandler = (
  params: Parameters<typeof creditNoteIssuePreflight>[1],
  ctx: Parameters<typeof creditNoteIssuePreflight>[0],
) => creditNoteIssuePreflight(ctx, params)

import { backfillIdentities } from "./einvoicing/backfill"
import { backfillLegacyOriginals } from "./einvoicing/backfill-legacy"
import { einvoicingClassify } from "./einvoicing/classify-tool"
// --- E-invoicing: counterparty identities, classification, settings ---
import {
  counterpartyIdentityGet,
  counterpartyIdentityLookup,
  counterpartyIdentitySet,
  counterpartyTerritorySet,
} from "./einvoicing/identity-tools"
import { einvoicingReadiness } from "./einvoicing/readiness"
import { einvoicingSettingsSet } from "./einvoicing/settings-tool"
import { legalOriginalsVerify } from "./legal-originals/verify"

export const einvoicingClassifyHandler = (
  params: Parameters<typeof einvoicingClassify>[1],
  ctx: Parameters<typeof einvoicingClassify>[0],
) => einvoicingClassify(ctx, params)
export const counterpartyIdentityGetHandler = (
  params: Parameters<typeof counterpartyIdentityGet>[1],
  ctx: Parameters<typeof counterpartyIdentityGet>[0],
) => counterpartyIdentityGet(ctx, params)
export const counterpartyIdentityLookupHandler = (
  params: Parameters<typeof counterpartyIdentityLookup>[1],
  ctx: Parameters<typeof counterpartyIdentityLookup>[0],
) => counterpartyIdentityLookup(ctx, params)
export const counterpartyIdentitySetHandler = (
  params: Parameters<typeof counterpartyIdentitySet>[1],
  ctx: Parameters<typeof counterpartyIdentitySet>[0],
) => counterpartyIdentitySet(ctx, params)
export const counterpartyTerritorySetHandler = (
  params: Parameters<typeof counterpartyTerritorySet>[1],
  ctx: Parameters<typeof counterpartyTerritorySet>[0],
) => counterpartyTerritorySet(ctx, params)
export const einvoicingSettingsSetHandler = (
  params: Parameters<typeof einvoicingSettingsSet>[1],
  ctx: Parameters<typeof einvoicingSettingsSet>[0],
) => einvoicingSettingsSet(ctx, params)
export const legalOriginalsVerifyHandler = (
  params: Parameters<typeof legalOriginalsVerify>[1],
  ctx: Parameters<typeof legalOriginalsVerify>[0],
) => legalOriginalsVerify(ctx, params)

export const einvoicingReadinessHandler = (
  params: Parameters<typeof einvoicingReadiness>[1],
  ctx: Parameters<typeof einvoicingReadiness>[0],
) => einvoicingReadiness(ctx, params)
export const einvoicingBackfillIdentitiesHandler = (
  params: Parameters<typeof backfillIdentities>[1],
  ctx: Parameters<typeof backfillIdentities>[0],
) => backfillIdentities(ctx, params)
export const einvoicingBackfillLegacyOriginalsHandler = (
  params: Parameters<typeof backfillLegacyOriginals>[1],
  ctx: Parameters<typeof backfillLegacyOriginals>[0],
) => backfillLegacyOriginals(ctx, params)
// `identityConfirmJobHandler` is the kernel-shaped `(payload, ctx)` wrapper: it confirms derived
// SIRENs against the business registry, which re-drives the parks waiting on them.
export { identityConfirmJobHandler } from "./einvoicing/backfill"

import { activityRead } from "./activity"
// — E-invoicing through the bound PA provider (contract einvoicing-pa@1) —
import {
  bookDailyJob,
  bookingInvariantJob,
  einvoiceBookBatch,
  stepBook,
  summariseBatches,
} from "./einvoicing/booking"
import { einvoiceSendBatch, einvoiceSendDailyJob } from "./einvoicing/send-batch"
import { einvoiceStandingDailyJob, einvoiceStandingOff } from "./einvoicing/standing"
import {
  einvoiceTransmissionGet,
  einvoicingProviderOptions,
  einvoicingSettingsGet,
  einvoicingSettingsValues,
} from "./einvoicing/transmission-read"
import {
  type EinvCtx,
  einvoiceSend,
  einvoiceSendRequest,
  einvoiceStatusRefresh,
  statusCatchUp,
  transmitTick,
} from "./einvoicing/transmit"
import { ingestOrQueue, receivedCatchUp } from "./received/ingest"
import {
  type ReceivedToolCtx,
  receivedActionRequest,
  receivedGet,
  receivedList,
  receivedRefresh,
  receivedSetStatus,
  receivedSetStatusPreflight,
} from "./received/tools"
import { type DocumentSendStateCtx, documentSendState } from "./send-state"

export const einvoiceSendRequestHandler = (params: { document_id?: string }, ctx: EinvCtx) =>
  einvoiceSendRequest(ctx, params)
export const einvoiceSendHandler = (params: Parameters<typeof einvoiceSend>[1], ctx: EinvCtx) =>
  einvoiceSend(ctx, params)
export const einvoiceBookBatchHandler = (params: { batch_id?: string }, ctx: EinvCtx) =>
  einvoiceBookBatch(ctx, params)
export const documentSendStateHandler = (
  params: Record<string, unknown>,
  ctx: DocumentSendStateCtx,
) => documentSendState(params, ctx)
export const einvoiceStandingOffHandler = (
  params: { issuerProfileId?: string; stream?: string },
  ctx: EinvCtx,
) => einvoiceStandingOff(ctx, params)
export const einvoicingStandingDailyJobHandler = (_payload: unknown, ctx: EinvCtx) =>
  einvoiceStandingDailyJob(ctx)
export const einvoiceSendBatchHandler = (params: { batch_id?: string }, ctx: EinvCtx) =>
  einvoiceSendBatch(ctx, params)
export const einvoicingSendDailyJobHandler = (_payload: unknown, ctx: EinvCtx) =>
  einvoiceSendDailyJob(ctx)
export const einvoiceStatusRefreshHandler = (params: { document_id?: string }, ctx: EinvCtx) =>
  einvoiceStatusRefresh(ctx, params)
export const einvoiceTransmissionGetHandler = (params: { document_id?: string }, ctx: EinvCtx) =>
  einvoiceTransmissionGet(ctx, params)
export const einvoicingTransmitJobHandler = (_payload: unknown, ctx: EinvCtx) =>
  transmitTick(ctx, {
    stepBook,
    afterTick: async (c) => void (await summariseBatches(c)),
    // A supplier e-invoice the platform announced: mirror it in the Received tab.
    onReceived: (c, ref) => ingestOrQueue(c, ref, "webhook"),
  })
export const einvoicingBookDailyJobHandler = (_payload: unknown, ctx: EinvCtx) => bookDailyJob(ctx)
export const einvoicingStatusCatchUpJobHandler = (_payload: unknown, ctx: EinvCtx) =>
  statusCatchUp(ctx)
export const einvoicingBookingInvariantJobHandler = (_payload: unknown, ctx: EinvCtx) =>
  bookingInvariantJob(ctx)
export const einvoicingSettingsGetHandler = (_params: Record<string, never>, ctx: EinvCtx) =>
  einvoicingSettingsGet(ctx)
export const einvoicingSettingsValuesHandler = (_params: Record<string, never>, ctx: EinvCtx) =>
  einvoicingSettingsValues(ctx)
export const einvoicingProviderOptionsHandler = (_params: Record<string, never>, ctx: EinvCtx) =>
  einvoicingProviderOptions(ctx)

// — Reception: supplier e-invoices received through the PA (the Received tab) —
type ReceivedActionParams = {
  received_id?: string
  action?: string
  reason?: string | null
  comment?: string | null
}
export const receivedEinvoicesListHandler = (
  params: { status?: string; limit?: number; offset?: number },
  ctx: ReceivedToolCtx,
) => receivedList(ctx, params)
export const receivedEinvoicesGetHandler = (
  params: { received_id?: string },
  ctx: ReceivedToolCtx,
) => receivedGet(ctx, params)
export const receivedEinvoicesRefreshHandler = (
  params: { received_id?: string },
  ctx: ReceivedToolCtx,
) => receivedRefresh(ctx, params)
export const receivedEinvoiceActionRequestHandler = (
  params: ReceivedActionParams,
  ctx: ReceivedToolCtx,
) => receivedActionRequest(ctx, params)
export const receivedEinvoiceSetStatusPreflightHandler = (
  params: ReceivedActionParams,
  ctx: ReceivedToolCtx,
) => receivedSetStatusPreflight(ctx, params)
export const receivedEinvoiceSetStatusHandler = (
  params: ReceivedActionParams,
  ctx: ReceivedToolCtx,
) => receivedSetStatus(ctx, params)
export const einvoicingReceivedCatchUpJobHandler = (_payload: unknown, ctx: ReceivedToolCtx) =>
  receivedCatchUp(ctx)

// — import kinds (manifest `import.kinds`) —
export { checkDocuments, importDocuments } from "./import-kind"
export { checkSchedules, importSchedules } from "./recurring/import-kind"

// --- Recurring schedules (the kernel gates the writes; see recurring/tools.ts) ---
export const recurringScheduleCreateHandler = (
  params: Parameters<typeof recurringScheduleCreate>[1],
  ctx: Parameters<typeof recurringScheduleCreate>[0],
) => recurringScheduleCreate(ctx, params)
export const recurringScheduleCreatePreflightHandler = async (
  params: Parameters<typeof checkScheduleCreate>[1],
  ctx: Parameters<typeof checkScheduleCreate>[0],
) => {
  const refused = await checkScheduleCreate(ctx, params)
  return refused ? { error: refused.error } : { ok: true }
}
export const recurringScheduleUpdateHandler = (
  params: Parameters<typeof recurringScheduleUpdate>[1],
  ctx: Parameters<typeof recurringScheduleUpdate>[0],
) => recurringScheduleUpdate(ctx, params)
export const recurringScheduleUpdatePreflightHandler = async (
  params: Parameters<typeof checkScheduleUpdate>[1],
  ctx: Parameters<typeof checkScheduleUpdate>[0],
) => {
  const refused = await checkScheduleUpdate(ctx, params, "preflight")
  return refused ? { error: refused.error } : { ok: true }
}
export const recurringSchedulePauseHandler = (
  params: Parameters<typeof recurringSchedulePause>[1],
  ctx: Parameters<typeof recurringSchedulePause>[0],
) => recurringSchedulePause(ctx, params)
export const recurringSchedulePausePreflightHandler = async (
  params: Parameters<typeof recurringSchedulePause>[1],
  ctx: Parameters<typeof recurringSchedulePause>[0],
) => {
  const checked = await recurringSchedulePause(ctx, params, true)
  return checked.status === "error" ? { error: checked.error } : { ok: true }
}
export const recurringListHandler = (
  params: Parameters<typeof recurringList>[1],
  ctx: Parameters<typeof recurringList>[0],
) => recurringList(ctx, params)

// --- The month-end run (draft, card, approve, issue, legal date; see recurring/*-job.ts) ---
export const recurringDraftJobHandler = (_payload: unknown, ctx: RunCtx) => recurringDraftJob(ctx)
export const recurringDraftWriteHandler = (
  params: Parameters<typeof recurringDraftWrite>[1],
  ctx: RunCtx,
) => recurringDraftWrite(ctx, params)
export const recurringIssueJobHandler = (_payload: unknown, ctx: RunCtx) => recurringIssueJob(ctx)
export const recurringLegalDateJobHandler = (_payload: unknown, ctx: RunCtx) =>
  recurringLegalDateJob(ctx)
export const recurringRunIssueHandler = (
  params: Parameters<typeof recurringRunIssue>[1],
  ctx: RunCtx,
) => recurringRunIssue(ctx, params)
export const recurringRunUnapproveHandler = (
  params: Parameters<typeof recurringRunUnapprove>[1],
  ctx: RunCtx,
) => recurringRunUnapprove(ctx, params)
export const recurringItemIssueHandler = (
  params: Parameters<typeof recurringItemIssue>[1],
  ctx: RunCtx,
) => recurringItemIssue(ctx, params)
export const recurringRunGetHandler = (
  params: Parameters<typeof recurringRunGet>[1],
  ctx: RunCtx,
) => recurringRunGet(ctx, params)
export const recurringRunIssuePreflightHandler = (params: { run_id: string }, ctx: RunCtx) =>
  recurringRunIssuePreflight(ctx, params)
export const recurringRunUnapprovePreflightHandler = (params: { run_id: string }, ctx: RunCtx) =>
  recurringRunUnapprovePreflight(ctx, params)
export const approvalRouteReadHandler = (
  params: { entityType: string; entityId: string },
  ctx: RunCtx,
) => approvalRouteRead(ctx, params)

// --- Who issues what: the card stream's issuer and Stripe's own emails (see streams.ts) ---
export const issuerStreamGetHandler = (
  params: Parameters<typeof issuerStreamGet>[1],
  ctx: Parameters<typeof issuerStreamGet>[0],
) => issuerStreamGet(ctx, params ?? {})
export const issuerStreamSetHandler = (
  params: Parameters<typeof issuerStreamSet>[1],
  ctx: Parameters<typeof issuerStreamSet>[0],
) => issuerStreamSet(ctx, params)
export const issuerStreamSetPreflightHandler = async (
  params: Parameters<typeof issuerStreamSetPreflight>[1],
  ctx: Parameters<typeof issuerStreamSetPreflight>[0],
) => {
  const r = await issuerStreamSetPreflight(ctx, params)
  return "status" in r ? { error: r.error } : r
}
export const issuerEmailsConfirmPreflightHandler = async (
  params: Parameters<typeof issuerEmailsConfirmPreflight>[1],
  ctx: Parameters<typeof issuerEmailsConfirmPreflight>[0],
) => {
  const r = await issuerEmailsConfirmPreflight(ctx, params)
  return "status" in r ? { error: r.error } : r
}
export const issuerEmailsConfirmHandler = (
  params: Parameters<typeof issuerEmailsConfirm>[1],
  ctx: Parameters<typeof issuerEmailsConfirm>[0],
) => issuerEmailsConfirm(ctx, params)
export const cardStreamIssuerHandler = (
  _params: unknown,
  ctx: Parameters<typeof cardStreamIssuer>[0],
) => cardStreamIssuer(ctx)
export const onStripeConnectionStateChanged = (
  event: Parameters<typeof onStripeConnectionChanged>[1],
  ctx: Parameters<typeof onStripeConnectionChanged>[0],
) => onStripeConnectionChanged(ctx, event)

// --- Card payments on Stripe, mode A: invoices, payments, refunds, unmatched payments ---
// Event subscribers keep the kernel's `(event, ctx)` shape; tools are flipped like the others.
import {
  type StripeCtx,
  onStripeInvoiceFinalized as stripeInvoiceFinalized,
} from "./handlers/stripe-invoice-finalized"
import {
  onStripeInvoiceClosed,
  onStripeInvoicePaymentFailed,
  onStripeInvoicePaid as stripeInvoicePaid,
} from "./handlers/stripe-invoice-paid"
import {
  invoiceFromStripePayment,
  invoiceFromStripePaymentPreflight,
  paymentLinkToInvoice,
  paymentLinkToInvoicePreflight,
  onStripePaymentUnmatched as stripePaymentUnmatched,
} from "./handlers/stripe-payment-unmatched"
import { onStripeRefundCreated as stripeRefundCreated } from "./handlers/stripe-refund-created"

export { reconcileStripePaymentsJobHandler } from "./handlers/reconcile-stripe-payments"

export const onStripeInvoiceFinalizedEvent = (event: unknown, ctx: StripeCtx) =>
  stripeInvoiceFinalized(event, ctx)
export const onStripeInvoicePaidEvent = (event: unknown, ctx: StripeCtx) =>
  stripeInvoicePaid(event, ctx)
export const onStripeInvoicePaymentFailedEvent = (event: unknown, ctx: StripeCtx) =>
  onStripeInvoicePaymentFailed(event, ctx)
export const onStripeInvoiceVoidedEvent = (event: unknown, ctx: StripeCtx) =>
  onStripeInvoiceClosed(event, ctx, "voided")
export const onStripeInvoiceUncollectibleEvent = (event: unknown, ctx: StripeCtx) =>
  onStripeInvoiceClosed(event, ctx, "uncollectible")
export const onStripeRefundCreatedEvent = (event: unknown, ctx: StripeCtx) =>
  stripeRefundCreated(event, ctx)
export const onStripePaymentUnmatchedEvent = (event: unknown, ctx: StripeCtx) =>
  stripePaymentUnmatched(event, ctx)
export const invoiceFromStripePaymentHandler = (
  params: Parameters<typeof invoiceFromStripePayment>[1],
  ctx: StripeCtx,
) => invoiceFromStripePayment(ctx, params ?? {})
export const invoiceFromStripePaymentPreflightHandler = async (
  params: Parameters<typeof invoiceFromStripePayment>[1],
  ctx: StripeCtx,
) => {
  const r = await invoiceFromStripePaymentPreflight(ctx, params ?? {})
  return "status" in r ? { error: r.error } : r
}
export const paymentLinkToInvoiceHandler = (
  params: Parameters<typeof paymentLinkToInvoice>[1],
  ctx: StripeCtx,
) => paymentLinkToInvoice(ctx, params)
export const paymentLinkToInvoicePreflightHandler = async (
  params: Parameters<typeof paymentLinkToInvoice>[1],
  ctx: StripeCtx,
) => {
  const r = await paymentLinkToInvoicePreflight(ctx, params)
  return "status" in r ? { error: r.error } : r
}
