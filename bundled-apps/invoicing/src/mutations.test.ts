// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E6/E7/E8 — Mutating-tool tests.
//
// Drives every mutation through the generic-CRUD `createMockDb` surface —
// same shape the sandbox bridge exposes. The semantic mocks the original
// suite carried (`insertDraft`, `findDocument`, etc.) hid the gap that
// broke E2E: they let production code "work" against a shape no real
// bridge ever provides. Tests now assert against the in-memory store
// (`db.__all('documents')`, etc.) so what passes here must also pass at
// runtime against the real bridge.

import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import {
  BUYER_VIES_TIMEOUT_MS,
  compatibleNames,
  documentsIssuePreview,
  hasCompanyLegalForm,
  sameAddress,
  sameFullAddress,
} from "./buyer-vat"
import type { CrossAppEnvelope, CrossAppExecuteTool } from "./cross-app"
import { FICTIONAL_SIRENS, FR_SELLER_IDENTITY } from "./einvoicing/test-fixtures"
import {
  draftsCreatePreflightHandler,
  draftsUpdatePreflightHandler,
  invoiceCreateAndIssueHandler,
  quoteCreateAndIssueHandler,
} from "./handlers"
import type { Counterparty, DraftLine, IssuerProfile } from "./issue"
import { formatMoneyMinor } from "./money"
import {
  type ContactRelationshipRow,
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
  draftsCreate,
  draftsCreatePreflight,
  draftsCreateTool,
  draftsDiscard,
  draftsUpdate,
  draftsUpdatePreflight,
  hsCodesAssign,
  hsCodesLibraryDelete,
  hsCodesLibraryUpsert,
  hsCodesUnassign,
  inferContactRelationshipOnIssue,
  invoiceCreateAndIssue,
  invoiceCreateAndIssuePreflight,
  invoiceIssue,
  invoiceIssuePreflight,
  isUniqueViolation,
  liftMisplacedCountry,
  liftMisplacedCountryOnLine,
  liftMisplacedHsCode,
  type MutationsCtx,
  orderReissueApply,
  orderReissueApplyPreflight,
  type ProductCustomsOverlayRow,
  poCreateAndIssue,
  poIssue,
  proformaCreateAndIssue,
  proformaCreateAndIssuePreflight,
  proformaIssue,
  proformaIssuePreflight,
  quoteCreateAndIssue,
  quoteCreateAndIssuePreflight,
  quoteIssue,
  quoteIssuePreflight,
  sendErrorFromEnvelope,
  settingsIssuerProfileCreate,
  settingsIssuerProfileDelete,
  settingsIssuerProfileUpdate,
  settingsIssuerProfileWritePreflight,
  splitPostalAddress,
} from "./mutations"
import type { ReadsFetch } from "./reads"
import { documentsGet, documentsSearch, type ReadsCtx } from "./reads"
import * as summarizers from "./summarizers"
import {
  summarizeDocumentSend,
  summarizeDocumentUpdate,
  summarizeIssuerProfileChange,
  summarizeProformaCreateAndIssue,
} from "./summarizers"
import { createMockDb, type MockDb } from "./test-db"
import { testTime } from "./test-time"

interface MockExtras {
  threadPosts: Array<{
    contact_id: string
    body: string
    attachment_file_ids: string[]
  }>
  renderCalls: Array<{
    template_kind: string
    data: unknown
    link?: { table: string; column: string; row_id: string }
  }>
  approvalsRequested: Array<{
    tool_name: string
    summary: string
    summary_detail?: {
      subtitle?: string
      lines?: string[]
      links?: Array<{ label: string; app: string; entityType: string; entityId: string }>
    }
    current_payload: unknown
    editable_fields?: string[]
    requested_by_user_id: string
  }>
  executeToolCalls: Array<{ name: string; args: string | Record<string, unknown> }>
  emittedAttention: Array<{ entity: string; action: string; entityId?: string; data?: unknown }>
  twoEyesByApprovalId: Record<string, string>
}

const defaultIssuer: IssuerProfile = {
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
  // The seller identity a French e-invoice (Factur-X) needs.
  ...FR_SELLER_IDENTITY,
}

// A French business buyer with complete e-invoicing data: its contact carries a registry-confirmed
// identity (seeded by makeCtx), and the call carries the kind and the structured billing address.
const BUYER_SIREN = FICTIONAL_SIRENS[0]
const defaultCounterparty: Counterparty = {
  contact_id: "contact-1",
  legal_name: "Buyer SARL",
  country: "FR",
  vat_id: null,
  address: "1 rue Buyer, 75002 Paris",
  email: "ap@buyersarl.example",
  customer_kind: "business",
  billing_line1: "1 rue Buyer",
  billing_postcode: "75002",
  billing_city: "Paris",
}

/** The registry-confirmed identity of `contact-1` (the default buyer). */
const DEFAULT_BUYER_IDENTITY = {
  contact_id: "contact-1",
  customer_kind: "business",
  siren: BUYER_SIREN,
  registry_name: "Buyer SARL",
  registry_line1: "1 rue Buyer",
  registry_postcode: "75002",
  registry_city: "Paris",
  registry_country_code: "FR",
  registry_status: "A",
  source: "registry",
  confirmed_via: "auto",
}

/** The e-invoicing fields an invoice / credit-note draft for the default buyer carries. */
const BUYER_DRAFT_EINVOICE = {
  operation_category: "goods" as const,
  billing_line1: "1 rue Buyer",
  billing_postcode: "75002",
  billing_city: "Paris",
}

function seedIssuer(
  issuer: IssuerProfile,
  thresholds: {
    invoice?: bigint | null
    po?: bigint | null
    require_two_eyes?: boolean
    mailAccountId?: string | null
  },
): Record<string, unknown> {
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
    siren: issuer.siren ?? null,
    routing_address: issuer.routing_address ?? null,
    address_line1: issuer.address_line1 ?? null,
    postcode: issuer.postcode ?? null,
    city: issuer.city ?? null,
    country_code: issuer.country_code ?? null,
    prefix_invoice: issuer.prefix_invoice,
    prefix_quote: issuer.prefix_quote,
    prefix_proforma: issuer.prefix_proforma,
    prefix_po: issuer.prefix_po,
    prefix_credit_note: issuer.prefix_credit_note,
    invoice_approval_threshold_minor:
      thresholds.invoice != null ? thresholds.invoice.toString() : null,
    po_approval_threshold_minor: thresholds.po != null ? thresholds.po.toString() : null,
    require_two_eyes: !!thresholds.require_two_eyes,
    // The org's configured send-from mail account — present by default so send_to_customer tests
    // exercise the real account-resolution path; pass `mailAccountId: null` to test the guard.
    mail_account_id:
      thresholds.mailAccountId === undefined ? "acct-mail-1" : thresholds.mailAccountId,
  }
}

const NO_GATE_MINOR = 10n ** 15n
// A standalone credit note (no original invoice) is always approved; tests that only exercise issuing
// run as the post-approval re-entry.
const PRE_APPROVED = {
  approvalRequestId: "appr-pre",
  approvalDeciderId: "user-2",
  toolName: "invoicing:test",
}

const todayIso = () => new Date().toISOString().slice(0, 10)
const usdRateToday = () => ({
  currency: "USD",
  rate_date: todayIso(),
  rate: "1.1225",
  fetched_at: new Date(),
})

function makeCtx(opts?: {
  actorUserId?: string
  approval?: { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null
  issuer?: Partial<IssuerProfile>
  issuerThresholdMinor?: bigint | null
  poThresholdMinor?: bigint | null
  requireTwoEyes?: boolean
  executeToolImpl?: (
    name: string,
    args: string | Record<string, unknown>,
  ) => Promise<CrossAppEnvelope>
  failPdfRender?: boolean
  mailAccountId?: string | null
  seed?: Record<string, Array<Record<string, unknown>>>
  /** Scopes the caller holds (hierarchical, `*` holds everything). Omitted: no hasScope on ctx. */
  scopes?: string[]
}): { ctx: MutationsCtx; db: MockDb; extras: MockExtras } {
  const issuer: IssuerProfile = { ...defaultIssuer, ...opts?.issuer }
  const db = createMockDb({
    seed: {
      issuer_profiles: [
        seedIssuer(issuer, {
          // Unset (undefined) = a threshold nothing reaches; an explicit null = NO threshold, which
          // credit notes and purchase orders treat as "always approve" (security pass).
          invoice:
            opts?.issuerThresholdMinor === undefined ? NO_GATE_MINOR : opts.issuerThresholdMinor,
          po: opts?.poThresholdMinor === undefined ? NO_GATE_MINOR : opts.poThresholdMinor,
          require_two_eyes: opts?.requireTwoEyes,
          mailAccountId: opts?.mailAccountId,
        }),
      ],
      // Tests run the e-invoicing gate in enforce mode unless they say otherwise.
      einvoicing_settings: [{ gate_mode: "enforce", gate_mode_source: "config" }],
      counterparty_identities: [DEFAULT_BUYER_IDENTITY],
      ...(opts?.seed ?? {}),
    },
  })
  const extras: MockExtras = {
    threadPosts: [],
    renderCalls: [],
    approvalsRequested: [],
    executeToolCalls: [],
    emittedAttention: [],
    twoEyesByApprovalId: {},
  }
  let idSeq = 0
  const newId = (prefix: string) => `${prefix}-${++idSeq}`
  const failPdfRender = !!opts?.failPdfRender

  const executeTool: CrossAppExecuteTool = async (name, args) => {
    extras.executeToolCalls.push({ name, args })
    // The app's own internal tool runs its handler, as the kernel does for the app's own call.
    if (name === "invoicing:documents_convert_local") {
      return { status: "completed", result: await documentsConvertLocal(ctx, args as never) }
    }
    // No Stripe app in these tests: the kernel answers an absent app's tool as not found.
    if (name.startsWith("stripe:"))
      return {
        status: "error",
        error: { code: "tool_not_found", message: `tool ${name} not registered` },
      }
    if (opts?.executeToolImpl) return opts.executeToolImpl(name, args)
    return { status: "completed", result: { dispatched: true } }
  }

  const ctx: MutationsCtx = {
    getUserId: async () => opts?.actorUserId ?? "user-1",
    approval: opts?.approval ?? null,
    db,
    time: testTime(),
    pdf: {
      async render(p) {
        extras.renderCalls.push(p)
        if (failPdfRender) {
          const err = new Error("render failed") as Error & { code: string }
          err.code = "render_failed"
          throw err
        }
        return {
          file_id: newId("pdf"),
          byte_size: 1024,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: {
      async post(p) {
        extras.threadPosts.push(p)
        return { message_id: newId("msg") }
      },
    },
    requestApproval: async (input) => {
      const approval_id = newId("appr")
      extras.approvalsRequested.push({
        tool_name: input.tool_name,
        summary: input.summary,
        summary_detail: input.summary_detail,
        current_payload: input.current_payload,
        editable_fields: input.editable_fields,
        requested_by_user_id: await ctx.getUserId(),
      })
      extras.twoEyesByApprovalId[approval_id] = await ctx.getUserId()
      return { approval_id }
    },
    decideApproval: async (input) => {
      const requesterId = extras.twoEyesByApprovalId[input.approval_id]
      if (!requesterId) {
        return {
          status: "error",
          error: { code: "not_found", message: "approval not found" },
        }
      }
      if (requesterId === input.deciding_user_id) {
        return {
          status: "error",
          error: {
            code: "two_eyes_required",
            message: "approver must differ from requester",
          },
        }
      }
      return { status: "ok" }
    },
    executeTool,
    ...(opts?.scopes
      ? {
          hasScope: async (scope: string) =>
            opts.scopes!.some((h) => h === "*" || h === scope || scope.startsWith(`${h}:`)),
        }
      : {}),
    emit: async (event) => {
      extras.emittedAttention.push({
        entity: event.entity,
        action: event.action,
        entityId: event.entityId,
        data: event.data,
      })
    },
  }
  return { ctx, db, extras }
}

const sampleDraftItems = [
  {
    position: 1,
    description: "Widget",
    quantity: "2",
    unit_price_minor: 5_000n,
    product_source: null,
    external_id: null,
  },
]

function draftDocs(db: MockDb): Array<Record<string, unknown>> {
  return db.__all("documents").filter((d) => d.status === "draft")
}
function issuedDocs(db: MockDb): Array<Record<string, unknown>> {
  return db.__all("documents").filter((d) => d.status !== "draft")
}

// ── Drafts ────────────────────────────────────────────────────────────────

describe("drafts preflight (stage-time, conditionalGate)", () => {
  const base = {
    type: "invoice" as const,
    ...BUYER_DRAFT_EINVOICE,
    counterparty_contact_id: "contact-1",
    issuer_profile_id: "iss-1",
    currency: "USD",
    items: sampleDraftItems,
  }

  test("drafts_create: refuses what the insert would refuse, accepts the rest, and writes nothing", async () => {
    const { ctx, db } = makeCtx()
    expect(await draftsCreatePreflight(ctx, { ...base, notes: "x".repeat(5000) })).toMatchObject({
      error: { code: expect.any(String) },
    })
    expect(await draftsCreatePreflight(ctx, { ...base, type: "nope" as "invoice" })).toMatchObject({
      error: { code: "invalid_type" },
    })
    expect(await draftsCreatePreflight(ctx, base)).toEqual({ ok: true })
    expect(draftDocs(db)).toHaveLength(0)
    await draftsCreate(ctx, { ...base, shopify_order_id: "#2001" })
    expect(await draftsCreatePreflight(ctx, { ...base, shopify_order_id: "#2001" })).toMatchObject({
      error: { code: "already_invoiced" },
    })
    expect(draftDocs(db)).toHaveLength(1)
  })

  test("drafts_update: a missing draft and over-long notes are refused at staging; the draft is unchanged", async () => {
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, base)
    expect(
      await draftsUpdatePreflight(ctx, {
        draft_id: "00000000-0000-4000-8000-000000000000",
        patch: {},
      }),
    ).toMatchObject({
      error: { code: "not_found" },
    })
    expect(
      await draftsUpdatePreflight(ctx, { draft_id, patch: { notes: "x".repeat(5000) } }),
    ).toMatchObject({
      error: { code: expect.any(String) },
    })
    expect(await draftsUpdatePreflight(ctx, { draft_id, patch: { notes: "Contract 42" } })).toEqual(
      { ok: true },
    )
    expect(draftDocs(db).find((d) => d.id === draft_id)?.notes ?? null).toBeNull()
  })
})

describe("drafts.create", () => {
  test("inserts a draft and returns its id", async () => {
    const { ctx, db } = makeCtx()
    const result = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(result.draft_id.length).toBeGreaterThan(0)
    const drafts = draftDocs(db)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]!.type).toBe("invoice")
    expect(drafts[0]!.status).toBe("draft")
    const lines = db.__all("document_lines").filter((l) => l.document_id === drafts[0]!.id)
    expect(lines).toHaveLength(1)
  })

  test("emits document:created with the new draft's id, type and draft status", async () => {
    const { ctx, extras } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const created = extras.emittedAttention.find((e) => e.action === "created")
    expect(created?.entity).toBe("document")
    expect(created?.entityId).toBe(draft_id)
    expect(created?.data).toMatchObject({
      document_id: draft_id,
      type: "invoice",
      number: null,
      status: "draft",
    })
  })

  test("derives currency from the issuer's default_currency when not provided", async () => {
    // When omitted, currency derives from the issuer (documents.currency is NOT NULL).
    // Regression for the live chaos 500 "null value in column ... violates not-null constraint".
    const { ctx, db } = makeCtx({
      seed: {
        issuer_profiles: [{ id: "iss-gbp", country: "GB", default_currency: "GBP" }],
      },
    })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-gbp",
      items: sampleDraftItems,
    })
    const draft = draftDocs(db).find((d) => d.id === draft_id)
    expect(draft?.currency).toBe("GBP")
  })

  test("an explicit `currency` param WINS over the issuer default (USD order → USD invoice — claire-shopify-bf-batch-invoices)", async () => {
    // The drafts_create tool now exposes `currency` (manifest param) so the agent can match a Shopify
    // order's currency when reconciling it into an invoice — a USD-store order must become a USD invoice,
    // never silently re-denominated to the issuer's EUR default. Without this the agent could not express
    // the order currency, the user's "that's a USD charge, not EUR" objection was unwinnable, and the
    // batch dead-ended unissued (the bf-batch tool-ergonomics failure). The issuer here defaults to EUR.
    const { ctx, db } = makeCtx({
      seed: { issuer_profiles: [{ id: "iss-eur", country: "FR", default_currency: "EUR" }] },
    })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_country: "US",
      issuer_profile_id: "iss-eur",
      currency: "USD",
      items: sampleDraftItems,
    })
    const draft = draftDocs(db).find((d) => d.id === draft_id)
    expect(draft?.currency, "explicit USD param overrides the issuer's EUR default").toBe("USD")
  })

  test("persists shopify_order_id and is IDEMPOTENT — a 2nd draft for the same order is rejected 'already_invoiced' (claire-shopify-bf-batch-invoices)", async () => {
    // One invoice per Shopify order: a looping agent re-running orders_search and re-issuing must NOT
    // double-bill. drafts_create links the order via shopify_order_id; a second create for the same order
    // throws a clear `already_invoiced` error (not a raw constraint 500) so the agent learns it is done.
    const { ctx, db } = makeCtx()
    const first = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "USD",
      shopify_order_id: "#1149",
      items: sampleDraftItems,
    })
    // The link is persisted on the document row.
    const persisted = draftDocs(db).find((d) => d.id === first.draft_id)
    expect(persisted?.shopify_order_id).toBe("#1149")
    // A SECOND create for the SAME order is rejected — no double-invoice.
    await expect(
      draftsCreate(ctx, {
        type: "invoice",
        ...BUYER_DRAFT_EINVOICE,
        counterparty_contact_id: "contact-1",
        issuer_profile_id: "iss-1",
        currency: "USD",
        shopify_order_id: "#1149",
        items: sampleDraftItems,
      }),
    ).rejects.toThrow(/already_invoiced/)
    // Only the first document exists for that order (the duplicate never persisted).
    expect(draftDocs(db).filter((d) => d.shopify_order_id === "#1149")).toHaveLength(1)
    // A DIFFERENT order still creates cleanly (idempotency is per-order, not a global block).
    const other = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "USD",
      shopify_order_id: "#1150",
      items: sampleDraftItems,
    })
    expect(other.draft_id).not.toBe(first.draft_id)
  })

  test("drafts create is blocked while the order invoice is live", async () => {
    const { ctx } = makeCtx({ issuerThresholdMinor: null })
    const issued = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#5001",
      items: sampleDraftItems,
    })
    expect(issued.status).toBe("completed")
    await expect(
      draftsCreate(ctx, {
        type: "invoice",
        ...BUYER_DRAFT_EINVOICE,
        counterparty_contact_id: "contact-1",
        issuer_profile_id: "iss-1",
        currency: "EUR",
        shopify_order_id: "#5001",
        items: sampleDraftItems,
      }),
    ).rejects.toThrow(/already_invoiced/)
  })

  test("drafts create is allowed once the order invoice is fully credit noted", async () => {
    const { ctx, db } = makeCtx({ approval: PRE_APPROVED, issuerThresholdMinor: null })
    const issued = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#5002",
      items: sampleDraftItems,
    })
    expect(issued.status).toBe("completed")
    if (issued.status !== "completed") throw new Error("unreachable")
    // Fully reverse the invoice's total (2 x 5000 + 20% = 12000) with a credit note.
    const cn = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      original_document_id: issued.document_id,
      items: [
        {
          position: 1,
          description: "Widget",
          quantity: "2",
          unit_price_minor: -5_000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(cn.status).toBe("completed")
    // Before the fix this throws already_invoiced; after the fix it completes and
    // returns a new document row for the same order.
    const replacement = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#5002",
      items: sampleDraftItems,
    })
    expect(replacement.draft_id.length).toBeGreaterThan(0)
    const replacementRow = draftDocs(db).find((d) => d.id === replacement.draft_id)
    expect(replacementRow?.shopify_order_id).toBe("#5002")
  })

  test("a partially credit noted invoice still blocks and reports the remaining amount", async () => {
    const { ctx } = makeCtx({ approval: PRE_APPROVED, issuerThresholdMinor: null })
    const issued = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#5003",
      items: sampleDraftItems,
    })
    expect(issued.status).toBe("completed")
    if (issued.status !== "completed") throw new Error("unreachable")
    // Reverse only ONE of the two units (5000 + 20% = 6000 of the 12000 total).
    const cn = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      original_document_id: issued.document_id,
      items: [
        {
          position: 1,
          description: "Widget",
          quantity: "1",
          unit_price_minor: -5_000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(cn.status).toBe("completed")
    await expect(
      draftsCreate(ctx, {
        type: "invoice",
        ...BUYER_DRAFT_EINVOICE,
        counterparty_contact_id: "contact-1",
        issuer_profile_id: "iss-1",
        currency: "EUR",
        shopify_order_id: "#5003",
        items: sampleDraftItems,
      }),
    ).rejects.toThrow(/60\.00 EUR of 120\.00 EUR still stands/)
  })

  test("a credit note carrying the order id does not block a new invoice", async () => {
    const { ctx, db } = makeCtx({ issuerThresholdMinor: null })
    // A credit note draft that carries the order id directly (no prior invoice for this order).
    const cnDraft = await draftsCreate(ctx, {
      type: "credit_note",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#5004",
      items: sampleDraftItems,
    })
    expect(cnDraft.draft_id.length).toBeGreaterThan(0)
    const replacement = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#5004",
      items: sampleDraftItems,
    })
    expect(replacement.draft_id.length).toBeGreaterThan(0)
    expect(draftDocs(db).filter((d) => d.shopify_order_id === "#5004")).toHaveLength(2)
  })

  // GAP 1 regression — invoiceCreateAndIssue used to carry its OWN copy of the one-invoice-per-order
  // guard, which blocked on ANY existing document for the order (credit noted or not) and never
  // consulted isFullyCredited. That is the guard the real paid-order auto-issue flow calls, so this is
  // the path the reported "cannot re-invoice a modified order" symptom actually came from.
  test("issuing an invoice for an order whose invoice was fully credit noted is allowed", async () => {
    const { ctx } = makeCtx({ approval: PRE_APPROVED, issuerThresholdMinor: null })
    const issued = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#6001",
      items: sampleDraftItems,
    })
    expect(issued.status).toBe("completed")
    if (issued.status !== "completed") throw new Error("unreachable")
    const cn = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      original_document_id: issued.document_id,
      items: [
        {
          position: 1,
          description: "Widget",
          quantity: "2",
          unit_price_minor: -5_000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(cn.status).toBe("completed")
    // Before the fix this throws already_invoiced (status "error", code "already_invoiced")
    // because invoiceCreateAndIssue's stale copy of the guard never checked isFullyCredited.
    const replacement = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#6001",
      items: sampleDraftItems,
    })
    expect(replacement.status).toBe("completed")
  })

  test("the order guard blocks the auto issue path while the invoice is live", async () => {
    const { ctx } = makeCtx({ issuerThresholdMinor: null })
    const issued = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#6002",
      items: sampleDraftItems,
    })
    expect(issued.status).toBe("completed")
    const second = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#6002",
      items: sampleDraftItems,
    })
    expect(second.status).toBe("error")
    if (second.status !== "error") throw new Error("unreachable")
    expect(second.error.code).toBe("already_invoiced")
  })

  // GAP 2 regression — creditedTotalMinor/isFullyCredited used to resolve credit notes ONLY from
  // the invoice's own lifecycle_log `credit_note_issued` entries. An invoice credit noted before
  // that marker existed, or the non-atomic write in creditNoteCreateAndIssue (credit note issued
  // first, invoice lifecycle_log updated in a SEPARATE write) losing the marker to a crash in
  // between, both left a real credit note with no lifecycle_log trace on the invoice — which
  // blocked that order's replacement invoice forever.
  test("an invoice credit noted without a lifecycle marker is still recognised as credited", async () => {
    const { ctx, db } = makeCtx({ issuerThresholdMinor: null })
    const issued = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#6003",
      items: sampleDraftItems,
    })
    expect(issued.status).toBe("completed")
    if (issued.status !== "completed") throw new Error("unreachable")
    // A credit note that back-links via external_refs.original_document_id, carries the FULL
    // reversing total and the order id, but with NO credit_note_issued entry on the invoice's
    // lifecycle_log (simulating the lost-marker crash window, or a pre-existing credit note).
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-0000000060cc",
      type: "credit_note",
      status: "issued",
      number: "CN-2026-9001",
      number_int: 9001,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      currency: "EUR",
      subtotal_minor: "-10000",
      tax_total_minor: "-2000",
      grand_total_minor: "-12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: null,
      pdf_status: "pending",
      shopify_order_id: "#6003",
      external_refs: { original_document_id: issued.document_id },
      lifecycle_log: [{ event: "issued", actor: "user-1", ts: "2026-05-28T00:00:00Z" }],
    })
    // Before the fix this throws already_invoiced: the invoice's own lifecycle_log carries no
    // credit_note_issued marker, so isFullyCredited never sees the credit note above.
    const replacement = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#6003",
      items: sampleDraftItems,
    })
    expect(replacement.draft_id.length).toBeGreaterThan(0)
  })

  test("an invoice credit noted without a lifecycle marker is recognised through the original_document_id column alone", async () => {
    const { ctx, db } = makeCtx({ issuerThresholdMinor: null })
    const issued = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#6004",
      items: sampleDraftItems,
    })
    expect(issued.status).toBe("completed")
    if (issued.status !== "completed") throw new Error("unreachable")
    // A credit note that back-links via external_refs.original_document_id, carries the FULL
    // reversing total and the order id, but with NO credit_note_issued entry on the invoice's
    // lifecycle_log (simulating the lost-marker crash window, or a pre-existing credit note).
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-0000000060cd",
      type: "credit_note",
      status: "issued",
      number: "CN-2026-9002",
      number_int: 9002,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      currency: "EUR",
      subtotal_minor: "-10000",
      tax_total_minor: "-2000",
      grand_total_minor: "-12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: null,
      pdf_status: "pending",
      shopify_order_id: "#6004",
      original_document_id: issued.document_id,
      external_refs: {},
      lifecycle_log: [{ event: "issued", actor: "user-1", ts: "2026-05-28T00:00:00Z" }],
    })
    // Before the fix this throws already_invoiced: the invoice's own lifecycle_log carries no
    // credit_note_issued marker, so isFullyCredited never sees the credit note above.
    const replacement = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "#6004",
      items: sampleDraftItems,
    })
    expect(replacement.draft_id.length).toBeGreaterThan(0)
  })

  test("the order link SURVIVES issuing the draft — order id + human order number reach the issued invoice", async () => {
    // Issuing writes a NEW document row from the draft's external_refs and then
    // DELETES the draft, so an order link held only in the draft's own column was
    // lost at issue: the issued invoice showed no order, could not be found by
    // order number, and the one-invoice-per-order guard (which queries documents
    // by shopify_order_id) no longer saw it.
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "12768069779622",
      shopify_order_number: "#1149",
      items: sampleDraftItems,
    })
    const draft = draftDocs(db).find((d) => d.id === draft_id)
    expect(draft?.shopify_order_number).toBe("#1149")

    const r = await invoiceIssue(ctx, { draft_id })
    expect(r.status).toBe("completed")
    const issued = issuedDocs(db)[0]!
    expect(issued.shopify_order_id).toBe("12768069779622")
    expect(issued.shopify_order_number).toBe("#1149")
  })

  test("a draft with external_ref set appears in the Pending list and issues by draft id", async () => {
    // A draft that comes from a source (a recurring run) carries an external_ref. It is a pending
    // draft anyone can list, and invoice_issue {draft_id} issues it: one numbered invoice, the
    // draft consumed.
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    await db.update("documents", draft_id, { external_ref: "recurring:run-1:item-1" })

    const pending = await documentsSearch(ctx as unknown as ReadsCtx, { status: "draft" })
    expect(pending.map((r) => r.id)).toEqual([draft_id])

    const r = await invoiceIssue(ctx, { draft_id })
    expect(r.status).toBe("completed")
    expect(draftDocs(db)).toHaveLength(0)
    expect(issuedDocs(db)).toHaveLength(1)
    expect(issuedDocs(db)[0]!.number).toMatch(/^INV-/)
    expect(await documentsSearch(ctx as unknown as ReadsCtx, { status: "draft" })).toHaveLength(0)
  })

  test("defaults currency to EUR when neither input nor issuer specifies one", async () => {
    const { ctx, db } = makeCtx() // seeded issuer has no default_currency
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      items: sampleDraftItems,
    })
    const draft = draftDocs(db).find((d) => d.id === draft_id)
    expect(draft?.currency).toBe("EUR")
  })

  test("type must be a valid document type", async () => {
    const { ctx } = makeCtx()
    await expect(
      draftsCreate(ctx, {
        // @ts-expect-error invalid type
        type: "bogus",
        counterparty_contact_id: "contact-1",
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: sampleDraftItems,
      }),
    ).rejects.toThrow(/invalid_type/)
  })

  test("persists the counterparty snapshot fields (name/address/vat_id/email) — editor Customer section", async () => {
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Klangwerk GmbH",
      counterparty_address: "Rheinallee 4, 40545 Düsseldorf, Germany",
      counterparty_vat_id: "DE298765432",
      counterparty_email: "billing@klangwerk.example",
      counterparty_country: "DE",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const draft = draftDocs(db).find((d) => d.id === draft_id)
    expect(draft?.counterparty_name).toBe("Klangwerk GmbH")
    expect(draft?.counterparty_address).toBe("Rheinallee 4, 40545 Düsseldorf, Germany")
    expect(draft?.counterparty_vat_id).toBe("DE298765432")
    expect(draft?.counterparty_email).toBe("billing@klangwerk.example")
  })

  test("counterparty snapshot fields default to null when omitted", async () => {
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const draft = draftDocs(db).find((d) => d.id === draft_id)
    expect(draft?.counterparty_name ?? null).toBeNull()
    expect(draft?.counterparty_address ?? null).toBeNull()
    expect(draft?.counterparty_vat_id ?? null).toBeNull()
    expect(draft?.counterparty_email ?? null).toBeNull()
  })

  // ISSUER DEFAULTING — a weak model that omits issuer_profile_id must NOT push a NULL into the
  // NOT-NULL documents.issuer_profile_id column (that 23502s and surfaces as an opaque failure the
  // agent flails against). With exactly one issuer the app defaults to it; with zero or several it
  // returns a TYPED, agent-readable error instead of the raw pg violation.
  test("defaults to the org's sole issuer profile when issuer_profile_id is omitted", async () => {
    const { ctx, db } = makeCtx() // seeded with exactly one issuer (iss-1)
    const result = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const draft = draftDocs(db).find((d) => d.id === result.draft_id)
    expect(draft, "the draft is persisted").toBeDefined()
    expect(draft?.issuer_profile_id).toBe("iss-1")
  })

  test("no issuer profile configured -> typed no_issuer_profile error, no NULL insert", async () => {
    const { ctx } = makeCtx({ seed: { issuer_profiles: [] } })
    await expect(
      draftsCreate(ctx, {
        type: "invoice",
        ...BUYER_DRAFT_EINVOICE,
        counterparty_contact_id: "contact-1",
        currency: "EUR",
        items: sampleDraftItems,
      }),
    ).rejects.toThrow(/no_issuer_profile/)
  })

  test("multiple issuer profiles -> typed ambiguous error listing their ids and legal names", async () => {
    const { ctx } = makeCtx({
      seed: {
        issuer_profiles: [
          seedIssuer({ ...defaultIssuer, id: "iss-1", legal_name: "Acme SAS" }, {}),
          seedIssuer({ ...defaultIssuer, id: "iss-2", legal_name: "Beta GmbH" }, {}),
        ],
      },
    })
    let err: Error | null = null
    try {
      await draftsCreate(ctx, {
        type: "invoice",
        ...BUYER_DRAFT_EINVOICE,
        counterparty_contact_id: "contact-1",
        currency: "EUR",
        items: sampleDraftItems,
      })
    } catch (e) {
      err = e as Error
    }
    expect(err, "must reject rather than pick one").not.toBeNull()
    expect(err!.message).toMatch(/issuer_profile_ambiguous/)
    // lists both ids + legal names so the agent can pass issuer_profile_id explicitly
    expect(err!.message).toContain("iss-1")
    expect(err!.message).toContain("iss-2")
    expect(err!.message).toContain("Acme SAS")
    expect(err!.message).toContain("Beta GmbH")
  })

  test("an explicit but unknown issuer_profile_id still errors typed (issuer_not_found)", async () => {
    const { ctx } = makeCtx()
    await expect(
      draftsCreate(ctx, {
        type: "invoice",
        ...BUYER_DRAFT_EINVOICE,
        counterparty_contact_id: "contact-1",
        issuer_profile_id: "iss-does-not-exist",
        currency: "EUR",
        items: sampleDraftItems,
      }),
    ).rejects.toThrow(/issuer_not_found/)
  })
})

describe("drafts.update", () => {
  test("patches a draft's currency", async () => {
    const { ctx } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const next = await draftsUpdate(ctx, {
      draft_id,
      patch: { currency: "USD" },
    })
    expect(next.currency).toBe("USD")
  })

  test("patches the counterparty snapshot fields (editor Customer section save)", async () => {
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    await draftsUpdate(ctx, {
      draft_id,
      patch: {
        counterparty_name: "Tonwerk Audio GmbH",
        counterparty_address: "Industriestrasse 12, 80807 München, Germany",
        counterparty_vat_id: "DE000000000",
        counterparty_email: "ap@tonwerk.example",
      },
    })
    const draft = draftDocs(db).find((d) => d.id === draft_id)
    expect(draft?.counterparty_name).toBe("Tonwerk Audio GmbH")
    expect(draft?.counterparty_address).toBe("Industriestrasse 12, 80807 München, Germany")
    expect(draft?.counterparty_vat_id).toBe("DE000000000")
    expect(draft?.counterparty_email).toBe("ap@tonwerk.example")
  })

  // Regression (BL-41) — read→patch→write line round-trip with the read-back STRING unit_price_minor
  // AND inline customs fields. The read tools return unit_price_minor as a string ("41940"); the agent
  // echoes that whole line back into drafts_update to add HS code / customs description / origin
  // (line patches are replace-semantics, so it must resend the full line). The string must coerce to
  // the integer AND the customs fields must persist — this is the export-invoice path that stalled
  // claire-edit run-3 (the schema rejected the string pre-handler, so the customs patch never landed,
  // so invoice_issue was never reached). The manifest now accepts the string (see manifest.test.ts);
  // here we prove the handler then persists both the coerced price and the customs facts.
  test("re-patching a line with the read-back string unit_price_minor persists the price AND inline customs fields", async () => {
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          description: "Kestrel 6",
          quantity: "1",
          unit_price_minor: 41940n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    const updated = await draftsUpdate(ctx, {
      draft_id,
      patch: {
        lines: [
          {
            description: "Kestrel 6",
            quantity: "1",
            unit_price_minor: "41940", // read-back STRING form (documents_get serializes bigint as string)
            hs_code: "9405.41",
            customs_description: "LED stage luminaire",
            country_of_origin: "FR",
            product_source: null,
            external_id: null,
          },
        ],
      },
    })
    // Price coerced + JSON-safe string on the return.
    expect(updated.lines[0]!.unit_price_minor).toBe("41940")
    // Customs fields persisted to the row of record.
    const persisted = db.__all("document_lines").find((l) => l.document_id === draft_id)
    expect(persisted?.unit_price_minor).toBe("41940")
    expect(persisted?.hs_code).toBe("9405.41")
    expect(persisted?.customs_description).toBe("LED stage luminaire")
    expect(persisted?.country_of_origin).toBe("FR")
  })

  test("missing draft surfaces not_found", async () => {
    const { ctx } = makeCtx()
    await expect(draftsUpdate(ctx, { draft_id: "draft-missing", patch: {} })).rejects.toThrow(
      /not_found/,
    )
  })
})

describe("drafts.discard", () => {
  test("removes the draft", async () => {
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    await draftsDiscard(ctx, { draft_id })
    expect(draftDocs(db)).toHaveLength(0)
  })
})

// ── draft round-trip preserves "no per-line override" ─────────────────────

describe("draft round-trip — VAT not dropped when no per-line rate", () => {
  test("issuing a draft with no per-line rate for an FR-domestic counterparty applies the classifier's domestic rate", async () => {
    // sampleDraftItems carry NO tax_rate_bp_override. Persisting the draft and
    // issuing it must consult the FR domestic rate (20%), not silently apply
    // 0%. 2 × 5_000 = 10_000 subtotal → 2_000 tax at 20%.
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })

    // The persisted draft line stores NULL (no override) — not an explicit 0.
    const draftLine = db.__all("document_lines").find((l) => l.document_id === draft_id)
    expect(draftLine?.tax_rate_bp).toBeNull()

    const r = await invoiceIssue(ctx, { draft_id })
    expect(r.status).toBe("completed")

    const issued = issuedDocs(db)
    expect(issued).toHaveLength(1)
    expect(Number(issued[0]!.tax_total_minor)).toBeGreaterThan(0)
    expect(Number(issued[0]!.tax_total_minor)).toBe(2_000)
  })

  test("issuing a draft for a NON-EU (export) counterparty zero-rates it — counterparty_country is honored, not stubbed to the issuer's country", async () => {
    // Regression — the draft-issue path stubbed counterparty.country = issuer.country (FR), so EVERY
    // drafted export/reverse-charge invoice classified as FR-domestic (20% VAT) regardless of where
    // the customer actually was (claire-edit-invoice-vat-number-correction: a post-Brexit GB invoice
    // issued at 20% instead of UK-export zero-rating). The draft now carries counterparty_country;
    // a US (non-EU) counterparty must classify as eu_export_non_eu (rate 0). Same lines as the
    // FR-domestic test above (no per-line rate) — only the country differs, proving it's the driver.
    const { ctx, db } = makeCtx() // default issuer is FR
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Westcoast Buyer LLC",
      counterparty_address: "500 Market St, San Francisco, CA 94105",
      counterparty_email: "ap@westcoastbuyer.example",
      counterparty_country: "US",
      issuer_profile_id: "iss-1",
      currency: "USD",
      items: sampleDraftItems,
    })

    // The draft persisted the country (so the issue path can read it).
    const persistedDraft = draftDocs(db).find((d) => d.id === draft_id)
    expect(persistedDraft?.counterparty_country).toBe("US")

    const r = await invoiceIssue(ctx, { draft_id })
    expect(r.status).toBe("completed")

    const issued = issuedDocs(db)
    expect(issued).toHaveLength(1)
    // FR → US is eu_export_non_eu: zero-rated. Pre-fix this came out 2_000 (20% FR domestic).
    expect(Number(issued[0]!.tax_total_minor)).toBe(0)
  })

  test("drafts_update persists counterparty_country and tax_treatment (whitelist regression)", async () => {
    // updateDraftRow's field whitelist omitted counterparty_country + tax_treatment, so the agent's
    // correction (Juno: switch eu_reverse_charge → UK export) was silently dropped and the stale
    // treatment/country survived to issue. Both must now round-trip through drafts_update.
    const { ctx } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const updated = await draftsUpdate(ctx, {
      draft_id,
      patch: { counterparty_country: "GB", tax_treatment: "eu_export_non_eu" },
    })
    expect(updated.counterparty_country).toBe("GB")
    expect(updated.tax_treatment).toBe("eu_export_non_eu")
  })

  // red: a fractional value was read as major units (x100) and "899.00" as 899 cents, so one field
  // meant two things and a credit note issued at 100 times its amount under a card that said 0.00.
  test("drafts_create refuses a decimal price, naming what to send, and stores nothing", async () => {
    for (const [bad, send] of [
      ["419.40", "41940"],
      ["899.00", "89900"],
      ["-1260.50", "-126050"],
    ] as const) {
      const { ctx, db } = makeCtx()
      await expect(
        draftsCreate(ctx, {
          type: "invoice",
          ...BUYER_DRAFT_EINVOICE,
          counterparty_contact_id: "contact-1",
          issuer_profile_id: "iss-1",
          currency: "EUR",
          items: [
            {
              position: 1,
              description: "Kestrel 6",
              quantity: "25",
              unit_price_minor: bad,
              product_source: null,
              external_id: null,
            },
          ],
        } as unknown as Parameters<typeof draftsCreate>[1]),
      ).rejects.toThrow(
        new RegExp(
          `invalid_amount: items\\[0\\]\\.unit_price_minor is "${bad.replace(".", "\\.")}".*send ${send}`,
        ),
      )
      expect(db.__all("document_lines")).toHaveLength(0)
    }
  })

  // red: coerceMinorAmount maps a non-numeric string to 0n -> the proforma is staged (and once
  // approved, issued) at 0 instead of being refused.
  test("proforma_create_and_issue refuses a price that is not a whole number, before any approval card", async () => {
    for (const bad of ["$1", "1 EUR", "1,00", "abc", "1.00", "899.00", "1e3"]) {
      const m = makeCtx()
      const res = await proformaCreateAndIssue(m.ctx, {
        counterparty: defaultCounterparty,
        issuer_profile_id: "iss-1",
        currency: "USD",
        reason: "sample",
        items: [
          {
            position: 1,
            description: "Kestrel 6",
            quantity: "1",
            unit_price_minor: bad,
            product_source: null,
            external_id: null,
          },
        ],
      } as unknown as Parameters<typeof proformaCreateAndIssue>[1])
      expect(res.status).toBe("error")
      if (res.status !== "error") throw new Error("unreachable")
      expect(res.error.code).toBe("invalid_amount")
      expect(res.error.message).toContain("items[0].unit_price_minor")
      expect(res.error.message).toContain(JSON.stringify(bad))
      expect(res.error.message).toContain("whole number")
      expect(m.extras.approvalsRequested).toHaveLength(0)
      expect(m.db.__all("documents")).toHaveLength(0)
      // The stage-time preflight refuses it too.
      const pre = await proformaCreateAndIssuePreflight(m.ctx, {
        counterparty: defaultCounterparty,
        issuer_profile_id: "iss-1",
        currency: "USD",
        reason: "sample",
        items: [
          {
            position: 1,
            description: "Kestrel 6",
            quantity: "1",
            unit_price_minor: bad,
            product_source: null,
            external_id: null,
          },
        ],
      } as unknown as Parameters<typeof proformaCreateAndIssuePreflight>[1])
      if (!("error" in pre)) throw new Error("preflight let an unparsable price through")
      expect(pre.error.code).toBe("invalid_amount")
    }
  })

  test("a present but unreadable discount is refused; an absent discount and whole-number prices still work", async () => {
    const m = makeCtx()
    const res = await proformaCreateAndIssue(m.ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "USD",
      reason: "sample",
      items: [
        {
          position: 1,
          description: "Kestrel 6",
          quantity: "1",
          unit_price_minor: "100",
          discount_minor: "$5",
          product_source: null,
          external_id: null,
        },
      ],
    } as unknown as Parameters<typeof proformaCreateAndIssue>[1])
    expect(res.status).toBe("error")
    if (res.status !== "error") throw new Error("unreachable")
    expect(res.error.message).toContain("items[0].discount_minor")

    const ok = await proformaCreateAndIssue(makeCtx().ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "USD",
      reason: "sample",
      items: [
        {
          position: 1,
          description: "Kestrel 6",
          quantity: "1",
          unit_price_minor: " 100 ",
          product_source: null,
          external_id: null,
        },
        {
          position: 2,
          description: "Cable",
          quantity: "1",
          unit_price_minor: 250,
          discount_minor: null,
          product_source: null,
          external_id: null,
        },
      ],
    } as unknown as Parameters<typeof proformaCreateAndIssue>[1])
    expect(ok.status).toBe("pending_approval")
  })

  test("drafts_create refuses a price that is not a whole number instead of storing 0", async () => {
    const { ctx, db } = makeCtx()
    await expect(
      draftsCreate(ctx, {
        type: "proforma",
        ...BUYER_DRAFT_EINVOICE,
        counterparty_contact_id: "contact-1",
        issuer_profile_id: "iss-1",
        currency: "USD",
        items: [
          {
            position: 1,
            description: "Kestrel 6",
            quantity: "1",
            unit_price_minor: "$1",
            product_source: null,
            external_id: null,
          },
        ],
      } as unknown as Parameters<typeof draftsCreate>[1]),
    ).rejects.toThrow(/invalid_amount: items\[0\]\.unit_price_minor is "\$1".*whole number/)
    expect(db.__all("document_lines")).toHaveLength(0)
  })

  test("drafts_create populates document_lines.position + line subtotal (agent items carry no position)", async () => {
    // Agent-supplied items carry NO `position`; inserting `undefined` violated document_lines.position
    // NOT-NULL (23502) and aborted the whole drafts_create against the real DB. And subtotal_minor was
    // hardcoded "0", so a draft with priced lines showed €0 totals (export multi-step scenarios read it
    // as broken). Position must fall back to the 1-based index; subtotal must be qty x price.
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          description: "Kestrel 6",
          quantity: "2",
          unit_price_minor: 41940n,
          product_source: null,
          external_id: null,
        },
        {
          description: "Case",
          quantity: "1",
          unit_price_minor: 5000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    const lines = db
      .__all("document_lines")
      .filter((l) => l.document_id === draft_id)
      .sort((a, b) => Number(a.position) - Number(b.position))
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l.position)).toEqual([1, 2]) // never null
    expect(String(lines[0]!.subtotal_minor)).toBe("83880") // 2 × 41940, not "0"
    expect(String(lines[1]!.subtotal_minor)).toBe("5000")
  })

  test("drafts_update returns a JSON-safe shape (line prices as strings, not bigint → no [object Object])", async () => {
    // The sandbox bridge JSON-serialises a handler's return; JSON.stringify THROWS on a bigint, so a
    // raw DraftRow (lines[].unit_price_minor: bigint) surfaced to the agent as an unparseable
    // "[object Object]", hiding the result (export multi-step scenarios stalled). The return must
    // carry string prices.
    const { ctx } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          description: "Kestrel 6",
          quantity: "1",
          unit_price_minor: 41940n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    const updated = await draftsUpdate(ctx, {
      draft_id,
      patch: {
        lines: [
          {
            description: "Kestrel 6",
            quantity: "3",
            unit_price_minor: 41940n,
            product_source: null,
            external_id: null,
          },
        ],
      },
    })
    expect(updated.lines).toHaveLength(1)
    // unit_price_minor must be a STRING (JSON-safe), not a bigint.
    expect(typeof updated.lines[0]!.unit_price_minor).toBe("string")
    expect(updated.lines[0]!.unit_price_minor).toBe("41940")
    // The whole return must JSON-serialise without throwing (the actual sandbox failure mode).
    expect(() => JSON.stringify(updated)).not.toThrow()
  })

  test("drafts_create persists an inline line hs_code + it flows through to the issued document line", async () => {
    // Affordance for the export multi-step gap: the agent can set HS code / customs description on the
    // line at drafts_create (one call) instead of a separate hs_codes_assign round-trip it kept
    // skipping. insertDraftLines hardcoded hs_code:null; issueDocument only read the product overlay.
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Tokyo Sound Import KK",
      counterparty_address: "1-1 Marunouchi, Chiyoda-ku, Tokyo 100-0005",
      counterparty_email: "ap@tokyosoundimport.example",
      counterparty_country: "JP", // export → zero-rated, customs required
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          description: "Kestrel 6 (RAL-44)",
          quantity: "1",
          unit_price_minor: 180000n,
          hs_code: "9207.90",
          customs_description: "Electronic musical instrument",
          country_of_origin: "FR",
          product_source: null,
          external_id: null,
        },
      ],
    })
    // Persisted on the draft line.
    const draftLine = db.__all("document_lines").find((l) => l.document_id === draft_id)
    expect(draftLine?.hs_code).toBe("9207.90")
    expect(draftLine?.customs_description).toBe("Electronic musical instrument")

    // Flows through to the ISSUED document line (issueDocument prefers the inline value over overlay).
    const r = await invoiceIssue(ctx, { draft_id })
    expect(r.status).toBe("completed")
    const issuedLine = db
      .__all("document_lines")
      .find((l) => l.document_id !== draft_id && l.hs_code === "9207.90")
    expect(issuedLine).toBeDefined()
    expect(issuedLine?.country_of_origin).toBe("FR")
  })

  test("issuing a draft with NO line items is rejected (empty_document) — never silently issues an empty invoice", async () => {
    // The weak agent sometimes calls drafts_create without items (creating an empty shell) then
    // issues it — producing a meaningless 0-line, 0-total issued invoice/proforma (claire-proforma /
    // claire-export-aki). Issuing an empty financial document is never valid: reject with a guiding
    // error so the false-success becomes a loud "add line items first" instead.
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [],
    })
    const r = await invoiceIssue(ctx, { draft_id })
    expect(r.status).toBe("error")
    expect(r.status === "error" && r.error.code).toBe("empty_document")
    // No document was issued.
    expect(issuedDocs(db)).toHaveLength(0)
  })
})

// ── invoice.issue threshold-gating ────────────────────────────────────────

describe("invoice.issue — threshold gating", () => {
  test("amount below threshold issues immediately (status completed)", async () => {
    // 2 × 5_000 = 10_000; threshold 50_000 → below
    const { ctx, db, extras } = makeCtx({ issuerThresholdMinor: 50_000n })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const r = await invoiceIssue(ctx, { draft_id })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.document_id.length).toBeGreaterThan(0)
    expect(extras.approvalsRequested).toHaveLength(0)
    // Draft removed; new issued invoice persisted.
    expect(draftDocs(db)).toHaveLength(0)
    expect(issuedDocs(db)).toHaveLength(1)
  })

  test("amount above threshold, a person's own call holding the deciding scope: granted inline, issued at once", async () => {
    const { ctx, db, extras } = makeCtx({ issuerThresholdMinor: 5_000n })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const asked: string[] = []
    ctx.requestApproval = async (input) => {
      asked.push(input.tool_name)
      return { approval_id: null, auto_approved: true }
    }
    const r = await invoiceIssue(ctx, { draft_id })
    expect(asked).toEqual(["invoicing:invoice_issue"])
    expect(r.status).toBe("completed")
    expect(extras.approvalsRequested).toHaveLength(0)
    expect(draftDocs(db)).toHaveLength(0)
    expect(issuedDocs(db)).toHaveLength(1)
  })

  test("amount above threshold returns pending_approval", async () => {
    // 2 × 5_000 = 10_000; threshold 5_000 → above
    const { ctx, db, extras } = makeCtx({ issuerThresholdMinor: 5_000n })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const r = await invoiceIssue(ctx, { draft_id })
    expect(r.status).toBe("pending_approval")
    if (r.status !== "pending_approval") throw new Error("unreachable")
    expect(r.approval_id.length).toBeGreaterThan(0)
    // Draft remains as draft (no issued document yet)
    expect(issuedDocs(db)).toHaveLength(0)
    expect(draftDocs(db)).toHaveLength(1)
    expect(extras.approvalsRequested[0]!.tool_name).toBe("invoicing:invoice_issue")
    const detail = extras.approvalsRequested[0]!.summary_detail!
    // Was "Issue and send to Customer" (the hardcoded `legal_name: "Customer"` stub bug — the
    // draft's real counterparty_name is now read via counterpartyFromRow, so the summary shows it).
    expect(detail.subtitle).toContain("Buyer SARL")
    // Was "Customer: Customer" (the hardcoded `legal_name: "Customer"` stub bug — the draft's
    // real counterparty_name is now read via counterpartyFromRow, so the summary shows it).
    expect(detail.lines).toContain("Customer: Buyer SARL")
    expect(detail.lines).toContain("Line: Widget x 2 @ 50.00 EUR")
    expect(detail.lines).toContain("Total: 120.00 EUR")
    // The effect in one sentence, and the draft named by what it is, never by its id.
    expect(extras.approvalsRequested[0]!.summary).toBe("Issue invoice for Buyer SARL, 120.00 EUR")
    expect(
      [extras.approvalsRequested[0]!.summary, detail.subtitle ?? "", ...(detail.lines ?? [])].join(
        "\n",
      ),
    ).not.toContain(draft_id)
  })

  test("re-entry with ctx.approval populated skips threshold check", async () => {
    const { ctx, db, extras } = makeCtx({
      issuerThresholdMinor: 5_000n,
      approval: {
        approvalRequestId: "appr-1",
        approvalDeciderId: "user-2",
        toolName: "invoicing:invoice_create_and_issue",
      },
    })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const r = await invoiceIssue(ctx, { draft_id })
    expect(r.status).toBe("completed")
    expect(issuedDocs(db)).toHaveLength(1)
    expect(extras.approvalsRequested).toHaveLength(0)
  })
})

// ── Editable payment terms (due_at) on the PENDING issue approval ────────────
// edit-gated-invoice-payment-terms-before-approve: when an invoice is parked for
// approval (above the issue gate), the payment due date / terms can be CORRECTED
// on the pending request (NET-30 → NET-60) via approval_update_payload (due_at is
// a manifest editableField), and issuing reflects the corrected terms.
describe("invoice.issue — editable due_at / payment terms on the pending approval", () => {
  test("a gated issue exposes due_at as the editable field and carries the draft's due_at on the approval payload", async () => {
    const { ctx, db, extras } = makeCtx({ issuerThresholdMinor: 5_000n })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      due_at: "2026-07-20", // NET-30 (the wrong terms)
      items: sampleDraftItems,
    })
    const r = await invoiceIssue(ctx, { draft_id })
    expect(r.status).toBe("pending_approval")
    const req = extras.approvalsRequested[0]!
    expect(req.tool_name).toBe("invoicing:invoice_issue")
    // due_at is the editable field exposed on the approval (so a human/agent can correct the terms).
    expect(req.editable_fields).toEqual(["due_at"])
    // The current terms are carried on the payload so the approver SEES them before editing.
    expect(req.current_payload).toEqual({ draft_id, due_at: "2026-07-20" })
    // Nothing issued yet.
    expect(issuedDocs(db)).toHaveLength(0)
  })

  test("re-entry with a CORRECTED due_at applies it to the draft and the issued invoice reflects NET-60", async () => {
    // The approver edited due_at NET-30 → NET-60 on the pending approval; the kernel re-enters the
    // handler with the corrected due_at in the payload. The issued invoice must carry the new terms.
    const { ctx, db } = makeCtx({
      issuerThresholdMinor: 5_000n,
      approval: {
        approvalRequestId: "appr-1",
        approvalDeciderId: "user-2", // ≠ requester (user-1) → two-eyes passes
        toolName: "invoicing:invoice_issue",
      },
    })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      due_at: "2026-07-20", // NET-30 originally on the draft
      items: sampleDraftItems,
    })
    const r = await invoiceIssue(ctx, { draft_id, due_at: "2026-08-19" }) // corrected NET-60
    expect(r.status).toBe("completed")
    const issued = issuedDocs(db)
    expect(issued).toHaveLength(1)
    expect(String(issued[0]!.due_at)).toBe("2026-08-19")
  })

  test("re-entry WITHOUT an edited due_at issues with the draft's original terms (no accidental clear)", async () => {
    const { ctx, db } = makeCtx({
      issuerThresholdMinor: 5_000n,
      approval: {
        approvalRequestId: "appr-1",
        approvalDeciderId: "user-2",
        toolName: "invoicing:invoice_issue",
      },
    })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      due_at: "2026-07-20",
      items: sampleDraftItems,
    })
    const r = await invoiceIssue(ctx, { draft_id }) // no due_at override
    expect(r.status).toBe("completed")
    const issued = issuedDocs(db)
    expect(issued).toHaveLength(1)
    expect(String(issued[0]!.due_at)).toBe("2026-07-20")
  })
})

// ── Two-eyes ──────────────────────────────────────────────────────────────

describe("invoice.issue — two-eyes", () => {
  test("creator cannot approve own request — rejection surfaces as two_eyes_required", async () => {
    const userA = "user-A"
    const userB = "user-B"
    const { ctx } = makeCtx({
      actorUserId: userA,
      issuerThresholdMinor: 5_000n,
    })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const r = await invoiceIssue(ctx, { draft_id })
    expect(r.status).toBe("pending_approval")
    if (r.status !== "pending_approval") throw new Error("unreachable")
    const approvalId = r.approval_id

    // userA tries to approve own request — must reject with two_eyes_required
    const selfDecide = await ctx.decideApproval({
      approval_id: approvalId,
      deciding_user_id: userA,
    })
    expect(selfDecide.status).toBe("error")
    if (selfDecide.status !== "error") throw new Error("unreachable")
    expect(selfDecide.error.code).toBe("two_eyes_required")

    // userB approves — success
    const otherDecide = await ctx.decideApproval({
      approval_id: approvalId,
      deciding_user_id: userB,
    })
    expect(otherDecide.status).toBe("ok")

    // Re-invocation (kernel-driven) with ctx.approval populated → completed
    const { ctx: ctxRetry, db: dbRetry } = makeCtx({
      actorUserId: userA,
      issuerThresholdMinor: 5_000n,
      approval: {
        approvalRequestId: approvalId,
        approvalDeciderId: userB,
        toolName: "invoicing:invoice_create_and_issue",
      },
    })
    const created = await draftsCreate(ctxRetry, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const r2 = await invoiceIssue(ctxRetry, { draft_id: created.draft_id })
    expect(r2.status).toBe("completed")
    expect(issuedDocs(dbRetry)).toHaveLength(1)
  })
})

// ── create_and_issue convenience ──────────────────────────────────────────

describe("invoice.create_and_issue", () => {
  test("combines create + issue with same threshold gating (below)", async () => {
    const { ctx, db } = makeCtx({ issuerThresholdMinor: 1_000_000n })
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    expect(issuedDocs(db)).toHaveLength(1)
  })

  test("above threshold → pending_approval, no document persisted", async () => {
    const { ctx, db, extras } = makeCtx({ issuerThresholdMinor: 1_000n })
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("pending_approval")
    expect(db.__all("documents")).toHaveLength(0)
    const detail = extras.approvalsRequested[0]!.summary_detail!
    expect(detail.subtitle).toContain("Buyer SARL")
    expect(detail.lines).toContain("Customer: Buyer SARL")
    expect(detail.lines).toContain("Line: Widget x 2 @ 50.00 EUR")
    // The card states what will be issued: net, VAT, treatment and price basis (it once claimed
    // a pre-tax "lines total" while the document charged something else).
    expect(detail.lines).toContain("Total: 120.00 EUR (100.00 EUR net + 20.00 EUR VAT)")
    expect(detail.lines).toContain("Tax: domestic sale, FR VAT 20%; no buyer VAT number")
    expect(detail.lines).toContain("Prices: net as typed, VAT added on top")
  })

  test("persists shopify_order_id and is IDEMPOTENT — a 2nd create for the same order is rejected 'already_invoiced'", async () => {
    // Same one-invoice-per-order contract as drafts_create, but on the
    // full-counterparty convenience path (the one that carries the customer's
    // real legal_name) — so an order-import batch can link every invoice to
    // its order without double-billing on retry. A USD e-invoice needs a cached ECB rate.
    const { ctx, db } = makeCtx({
      issuerThresholdMinor: null,
      seed: { fx_rates: [usdRateToday()] },
    })
    const first = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "USD",
      shopify_order_id: "#3244",
      items: sampleDraftItems,
    })
    expect(first.status).toBe("completed")
    const persisted = issuedDocs(db).find((d) => d.shopify_order_id === "#3244")
    expect(persisted, "the issued document carries the order link").toBeDefined()
    const second = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "USD",
      shopify_order_id: "#3244",
      items: sampleDraftItems,
    })
    expect(second.status).toBe("error")
    if (second.status === "error") {
      expect(second.error.code).toBe("already_invoiced")
    }
    expect(db.__all("documents").filter((d) => d.shopify_order_id === "#3244")).toHaveLength(1)
  })

  // The ECB rate is fetched at issue (no scheduled job), once per currency and day.
  describe("foreign-currency rate at issue", () => {
    function withEcb(ctx: MutationsCtx, answer: "up" | "down") {
      const calls: string[] = []
      const fetch = async (url: string) => {
        calls.push(url)
        if (answer === "down") throw new Error("ECB unreachable")
        return { status: 200, headers: {}, body: `TIME_PERIOD,OBS_VALUE\n${todayIso()},1.1225\n` }
      }
      Object.assign(ctx, { fetch })
      return calls
    }
    const usdInvoice = (order: string) => ({
      operation_category: "goods" as const,
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "USD",
      shopify_order_id: order,
      items: sampleDraftItems,
    })

    test("a USD e-invoice fetches the rate once; the next one that day reuses it", async () => {
      const { ctx, db } = makeCtx({ issuerThresholdMinor: null })
      const calls = withEcb(ctx, "up")
      const first = await invoiceCreateAndIssue(ctx, usdInvoice("#fx-1"))
      expect(first.status).toBe("completed")
      const second = await invoiceCreateAndIssue(ctx, usdInvoice("#fx-2"))
      expect(second.status).toBe("completed")
      expect(calls).toHaveLength(1)
      const docs = issuedDocs(db).filter((d) => String(d.shopify_order_id).startsWith("#fx-"))
      expect(
        docs.map((d) => (d.einvoice as { fx_rate?: string } | undefined)?.fx_rate ?? d.fx_rate),
      ).toEqual(["1.1225", "1.1225"])
    })

    test("ECB unreachable: a USD e-invoice is refused, retryable, and no number is used", async () => {
      const { ctx, db } = makeCtx({ issuerThresholdMinor: null })
      withEcb(ctx, "down")
      const r = await invoiceCreateAndIssue(ctx, usdInvoice("#fx-3"))
      expect(r.status).toBe("error")
      if (r.status === "error") {
        expect(r.error.code).toBe("fx_rate_unavailable")
        expect(r.error.retryable).toBe(true)
      }
      expect(db.__all("documents")).toHaveLength(0)
      expect(db.__sequences.size).toBe(0)
    })

    test("a EUR invoice fetches nothing", async () => {
      const { ctx } = makeCtx({ issuerThresholdMinor: null })
      const calls = withEcb(ctx, "up")
      const r = await invoiceCreateAndIssue(ctx, { ...usdInvoice("#fx-4"), currency: "EUR" })
      expect(r.status).toBe("completed")
      expect(calls).toHaveLength(0)
    })
  })

  // DRAFT-ORDER TRAP — a weak model passed a Shopify DRAFT-order id where the completed order's
  // numeric id belongs. Instead of silently creating an unlinked invoice against a non-order, refuse
  // it with a TYPED, explicit error that names the mistake and steers to the completed order's id.
  test("a Shopify DRAFT-order gid is rejected with a typed shopify_draft_order_id error, nothing persisted", async () => {
    const { ctx, db } = makeCtx({ issuerThresholdMinor: null })
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "gid://shopify/DraftOrder/1696221692235",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("error")
    if (r.status === "error") {
      expect(r.error.code).toBe("shopify_draft_order_id")
      expect(r.error.message).toMatch(/draft-order id/i)
      expect(r.error.message).toMatch(/completed order/i)
    }
    expect(db.__all("documents"), "no invoice created for a draft-order id").toHaveLength(0)
  })

  test("a bare numeric (completed) order id is still accepted and linked", async () => {
    // Only the unmistakable DraftOrder gid is rejected; a normal completed-order id (bare number)
    // must still work, so the guard does not over-reach.
    const { ctx, db } = makeCtx({ issuerThresholdMinor: null })
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "3244",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    expect(issuedDocs(db).find((d) => d.shopify_order_id === "3244")).toBeDefined()
  })

  test("omitting issuer_profile_id defaults to the sole issuer; ambiguous/none give typed errors", async () => {
    // Single issuer -> defaults, no NULL insert.
    const single = makeCtx({ issuerThresholdMinor: null })
    const r1 = await invoiceCreateAndIssue(single.ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r1.status).toBe("completed")

    // No issuer -> typed no_issuer_profile.
    const none = makeCtx({ seed: { issuer_profiles: [] }, issuerThresholdMinor: null })
    const r2 = await invoiceCreateAndIssue(none.ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r2.status).toBe("error")
    if (r2.status === "error") expect(r2.error.code).toBe("no_issuer_profile")

    // Several -> typed ambiguous listing ids.
    const many = makeCtx({
      issuerThresholdMinor: null,
      seed: {
        issuer_profiles: [
          seedIssuer({ ...defaultIssuer, id: "iss-1", legal_name: "Acme SAS" }, {}),
          seedIssuer({ ...defaultIssuer, id: "iss-2", legal_name: "Beta GmbH" }, {}),
        ],
      },
    })
    const r3 = await invoiceCreateAndIssue(many.ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r3.status).toBe("error")
    if (r3.status === "error") {
      expect(r3.error.code).toBe("issuer_profile_ambiguous")
      expect(r3.error.message).toContain("iss-1")
      expect(r3.error.message).toContain("iss-2")
    }
  })
})

// ── Idempotency on re-entry ───────────────────────────────────────────────

describe("invoice.issue — idempotency", () => {
  test("re-running issue on the same draft after success refuses (not_found / invalid_transition)", async () => {
    const { ctx, db } = makeCtx({ issuerThresholdMinor: null })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const r1 = await invoiceIssue(ctx, { draft_id })
    expect(r1.status).toBe("completed")
    expect(issuedDocs(db)).toHaveLength(1)

    // Second call — draft removed → not_found.
    const r2 = await invoiceIssue(ctx, { draft_id })
    expect(r2.status).toBe("error")
    if (r2.status !== "error") throw new Error("unreachable")
    expect(["not_found", "invalid_transition"]).toContain(r2.error.code)
    expect(issuedDocs(db)).toHaveLength(1)
  })
})

// ── documents.convert_to_invoice ──────────────────────────────────────────

describe("documents.convert_to_invoice", () => {
  test("converts an accepted quote into an invoice; records source_document_id", async () => {
    const { ctx, db } = makeCtx({ issuerThresholdMinor: null })
    // Persist an accepted quote directly.
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000109",
      type: "quote",
      status: "accepted",
      number: "QUO-2026-1",
      number_int: 1,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      billing_line1: "1 rue Buyer",
      billing_postcode: "75002",
      billing_city: "Paris",
      billing_country_code: "FR",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: "pdf-existing",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [{ event: "issued", actor: "user-1", ts: "2026-05-28T00:00:00Z" }],
    })

    const r = await documentsConvertToInvoice(ctx, {
      operation_category: "goods",
      source_document_id: "00000000-0000-4000-8000-000000000109",
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.document_id).not.toBe("00000000-0000-4000-8000-000000000109")
    const invoice = db.__all("documents").find((d) => d.id === r.document_id)!
    expect(invoice.type).toBe("invoice")
    expect((invoice.external_refs as { source_document_id?: string }).source_document_id).toBe(
      "00000000-0000-4000-8000-000000000109",
    )
  })

  test("a local convert runs as one call of the internal local convert, and its error leaves the quote as it was", async () => {
    const { ctx, db, extras } = makeCtx()
    await seedShopifyLinkedQuote(db)
    // The same quote with no draft order: a local convert.
    const quote = db
      .__all("documents")
      .find((d) => d.id === "00000000-0000-4000-8000-00000000010b")!
    await db.update("documents", String(quote.id), {
      shopify_draft_order_id: null,
      external_refs: {},
    })
    const r = await documentsConvertToInvoice(ctx, {
      operation_category: "goods",
      source_document_id: String(quote.id),
    })
    expect(r.status).toBe("completed")
    expect(
      extras.executeToolCalls.filter((c) => c.name === "invoicing:documents_convert_local"),
    ).toHaveLength(1)
    const failing = makeCtx()
    await seedShopifyLinkedQuote(failing.db)
    await failing.db.update("documents", "00000000-0000-4000-8000-00000000010b", {
      shopify_draft_order_id: null,
      external_refs: {},
    })
    failing.ctx.executeTool = async () => ({
      status: "error",
      error: { code: "forced", message: "forced failure" },
    })
    const refused = await documentsConvertToInvoice(failing.ctx, {
      operation_category: "goods",
      source_document_id: "00000000-0000-4000-8000-00000000010b",
    })
    expect(refused.status === "error" ? refused.error : refused).toEqual({
      code: "forced",
      message: expect.stringContaining("no number was used"),
    })
    expect(
      failing.db.__all("documents").find((d) => d.id === "00000000-0000-4000-8000-00000000010b")
        ?.status,
    ).toBe("sent")
  })

  test("missing source document → not_found", async () => {
    const { ctx } = makeCtx()
    const r = await documentsConvertToInvoice(ctx, {
      operation_category: "goods",
      source_document_id: "00000000-0000-4000-8000-00000000010c",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("not_found")
  })

  // Regression — the convert hardcoded `legal_name: "Customer"` + `country: issuer.country`, dropping
  // the source quote's counterparty. Since issue RE-DERIVES tax from counterparty_country, a US-export
  // quote converted to a FR-issuer-domestic 20%-VAT "Customer" invoice — the agent then loops trying to
  // reconcile what the convert mis-built. The convert must carry the source counterparty forward.
  test("carries the source quote's counterparty name + country to the invoice (not 'Customer'/issuer)", async () => {
    const { ctx, db } = makeCtx({ issuerThresholdMinor: null })
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-00000000010a",
      type: "quote",
      status: "accepted",
      number: "QUO-2026-7001",
      number_int: 7001,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-wpa",
      counterparty_name: "Westcoast Pro Audio",
      counterparty_address: "500 Market St, San Francisco, CA 94105",
      counterparty_email: "ap@westcoastproaudio.example",
      counterparty_country: "US",
      currency: "USD",
      subtotal_minor: "1048500",
      tax_total_minor: "0",
      grand_total_minor: "1048500",
      tax_treatment: "eu_export_non_eu",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsConvertToInvoice(ctx, {
      operation_category: "goods",
      source_document_id: "00000000-0000-4000-8000-00000000010a",
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    const invoice = db.__all("documents").find((d) => d.id === r.document_id)!
    expect(invoice.counterparty_name).toBe("Westcoast Pro Audio") // was hardcoded "Customer"
    expect(invoice.counterparty_country).toBe("US") // was issuer.country → mis-classified tax
  })

  // B11 — convert MUST honour the same approval threshold as invoice_issue. The convert path used to
  // skip gating entirely, so an agent/low-trust user could issue an arbitrarily large invoice via
  // convert that the direct issue path would have stopped for human approval.
  async function seedAcceptedQuote(db: MockDb, overrides?: Record<string, unknown>): Promise<void> {
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-00000000010b",
      type: "quote",
      status: "accepted",
      number: "QUO-2026-9001",
      number_int: 9001,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Acme Co",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@acmeco.example",
      counterparty_country: "FR",
      // E-invoicing data stated on the quote: the converted invoice is a French B2B e-invoice.
      customer_kind: "business",
      operation_category: "goods",
      operation_category_source: "explicit",
      billing_line1: "1 rue Buyer",
      billing_postcode: "75002",
      billing_city: "Paris",
      billing_country_code: "FR",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "eu_domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      external_refs: {},
      lifecycle_log: [],
      ...overrides,
    })
    // 2 × 5_000 = 10_000 subtotal (+ FR domestic 20% VAT = 12_000 grand) — the gate compares grand.
    await db.insert("document_lines", {
      id: "ql-1",
      document_id: "00000000-0000-4000-8000-00000000010b",
      position: 1,
      description: "Widget",
      quantity: "2",
      unit_price_minor: "5000",
      tax_rate_bp: null,
      subtotal_minor: "10000",
      tax_minor: "0",
      total_minor: "10000",
    })
  }

  // Converting is a deliberate human click on an offer the customer already accepted, so the
  // handler parks NO approval of its own -- not on the threshold, not on two-eyes. Agents are
  // still stopped: the manifest keeps the tool gated, so the KERNEL parks their convert before
  // the handler runs. The old handler-level gate parked a second card on top of that and made
  // the human's own click unusable.
  test("amount above the issuer threshold converts without parking an approval", async () => {
    // grand = 12_000 (10_000 + 20% FR VAT); threshold 5_000 -> above, and still converts.
    const { ctx, db, extras } = makeCtx({ issuerThresholdMinor: 5_000n })
    await seedAcceptedQuote(db)
    const r = await documentsConvertToInvoice(ctx, {
      operation_category: "goods",
      source_document_id: "00000000-0000-4000-8000-00000000010b",
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.mode).toBe("local")
    expect(extras.approvalsRequested).toHaveLength(0)
    expect(db.__all("documents").filter((d) => d.type === "invoice")).toHaveLength(1)
    expect(
      db.__all("documents").find((d) => d.id === "00000000-0000-4000-8000-00000000010b")!.status,
    ).toBe("invoiced")
  })

  test("two-eyes issuer no longer blocks a self-approved convert (the click IS the approval)", async () => {
    const { ctx, db } = makeCtx({
      actorUserId: "user-1",
      requireTwoEyes: true,
      issuerThresholdMinor: 5_000n,
      approval: {
        approvalRequestId: "appr-1",
        approvalDeciderId: "user-1", // same as actor
        toolName: "invoicing:documents_convert_to_invoice",
      },
    })
    await seedAcceptedQuote(db)
    const r = await documentsConvertToInvoice(ctx, {
      operation_category: "goods",
      source_document_id: "00000000-0000-4000-8000-00000000010b",
    })
    expect(r.status).toBe("completed")
    expect(db.__all("documents").filter((d) => d.type === "invoice")).toHaveLength(1)
  })

  // A quote is born `sent`, so `sent` is the status a convert normally starts from -- without the
  // transition the UI button could only ever work on a quote someone had manually accepted.
  test("converts a quote straight from sent", async () => {
    const { ctx, db } = makeCtx()
    await seedAcceptedQuote(db, { status: "sent" })
    const r = await documentsConvertToInvoice(ctx, {
      operation_category: "goods",
      source_document_id: "00000000-0000-4000-8000-00000000010b",
    })
    expect(r.status).toBe("completed")
    expect(
      db.__all("documents").find((d) => d.id === "00000000-0000-4000-8000-00000000010b")!.status,
    ).toBe("invoiced")
  })

  // ── Shopify-linked quote: converting COMPLETES the draft order ──────────────
  // The invoice is NOT issued here: Shopify creates the real order and the existing
  // shopify/order:created auto-flow issues it. Issuing one here too would double-bill.
  async function seedShopifyLinkedQuote(db: MockDb): Promise<void> {
    await seedAcceptedQuote(db, {
      status: "sent",
      shopify_draft_order_id: "gid://shopify/DraftOrder/55",
      shopify_draft_order_name: "#D55",
      external_refs: { shopify_draft_order_id: "gid://shopify/DraftOrder/55" },
    })
  }

  test("shopify-linked quote: completes the draft order with paymentPending and stamps the quote", async () => {
    const { ctx, db, extras } = makeCtx({
      executeToolImpl: async (name) => {
        if (name === "shopify:draft_orders_complete")
          return {
            status: "completed",
            result: { draftOrder: { id: "gid://shopify/DraftOrder/55" } },
          }
        if (name === "shopify:draft_orders_get")
          return {
            status: "completed",
            result: {
              draftOrder: {
                draftOrderId: "gid://shopify/DraftOrder/55",
                orderId: "gid://shopify/Order/900",
                orderName: "#1149",
              },
            },
          }
        return { status: "completed", result: {} }
      },
    })
    await seedShopifyLinkedQuote(db)
    const r = await documentsConvertToInvoice(ctx, {
      operation_category: "goods",
      source_document_id: "00000000-0000-4000-8000-00000000010b",
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.mode).toBe("shopify_order_created")
    expect(r.shopify_order_id).toBe("900")
    expect(r.shopify_order_number).toBe("#1149")
    // The quote itself is what the caller gets back -- the invoice arrives via order:created.
    expect(r.document_id).toBe("00000000-0000-4000-8000-00000000010b")
    const complete = extras.executeToolCalls.find((c) => c.name === "shopify:draft_orders_complete")
    expect(complete).toBeDefined()
    expect((complete!.args as Record<string, unknown>).id).toBe("gid://shopify/DraftOrder/55")
    expect((complete!.args as Record<string, unknown>).paymentPending).toBe(true)
    const quote = db
      .__all("documents")
      .find((d) => d.id === "00000000-0000-4000-8000-00000000010b")!
    expect(quote.status).toBe("invoiced")
    expect(quote.shopify_order_id).toBe("900")
    expect(quote.shopify_order_number).toBe("#1149")
    const log = quote.lifecycle_log as Array<Record<string, unknown>>
    expect(log.map((e) => e.event)).toContain("draft_order_completed")
    // No invoice was issued locally, and the local convert (one transaction) was never entered.
    expect(db.__all("documents").filter((d) => d.type === "invoice")).toHaveLength(0)
    expect(extras.executeToolCalls.map((c) => c.name)).toEqual([
      "shopify:draft_orders_complete",
      "shopify:draft_orders_get",
    ])
  })

  test("shopify-linked quote: the local convert refuses it and writes nothing", async () => {
    const { ctx, db, extras } = makeCtx()
    await seedShopifyLinkedQuote(db)
    const r = await documentsConvertLocal(ctx, {
      operation_category: "goods",
      source_document_id: "00000000-0000-4000-8000-00000000010b",
    })
    expect(r.status === "error" ? r.error.code : r.status).toBe("shopify_linked")
    expect(extras.executeToolCalls).toHaveLength(0)
    const quote = db
      .__all("documents")
      .find((d) => d.id === "00000000-0000-4000-8000-00000000010b")!
    expect(quote.status).toBe("sent")
  })

  test("shopify-linked quote: a pending_approval from Shopify is propagated and the quote untouched", async () => {
    const { ctx, db } = makeCtx({
      executeToolImpl: async (name) =>
        name === "shopify:draft_orders_complete"
          ? { status: "pending_approval", approval_id: "shopify-appr-1" }
          : { status: "completed", result: {} },
    })
    await seedShopifyLinkedQuote(db)
    const r = await documentsConvertToInvoice(ctx, {
      operation_category: "goods",
      source_document_id: "00000000-0000-4000-8000-00000000010b",
    })
    expect(r.status).toBe("pending_approval")
    if (r.status !== "pending_approval") throw new Error("unreachable")
    expect(r.approval_id).toBe("shopify-appr-1")
    const quote = db
      .__all("documents")
      .find((d) => d.id === "00000000-0000-4000-8000-00000000010b")!
    expect(quote.status).toBe("sent")
    expect(db.__all("documents").filter((d) => d.type === "invoice")).toHaveLength(0)
  })

  test("shopify-linked quote: a Shopify error leaves the quote untouched", async () => {
    const { ctx, db } = makeCtx({
      executeToolImpl: async (name) =>
        name === "shopify:draft_orders_complete"
          ? { status: "error", error: { code: "draft_order_locked", message: "locked" } }
          : { status: "completed", result: {} },
    })
    await seedShopifyLinkedQuote(db)
    const r = await documentsConvertToInvoice(ctx, {
      operation_category: "goods",
      source_document_id: "00000000-0000-4000-8000-00000000010b",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("draft_order_locked")
    expect(
      db.__all("documents").find((d) => d.id === "00000000-0000-4000-8000-00000000010b")!.status,
    ).toBe("sent")
  })
})

// ── documents.mark_paid ───────────────────────────────────────────────────

describe("documents.mark_paid", () => {
  test("marks an issued invoice as paid, then re-renders the PDF as settled", async () => {
    const { ctx, db, extras } = makeCtx()
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000100",
      type: "invoice",
      status: "issued",
      number: "INV-2026-1",
      number_int: 1,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: "pdf-x",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsMarkPaid(ctx, {
      document_id: "00000000-0000-4000-8000-000000000100",
      paid_date: "2026-05-29",
      payment_note: "wire transfer",
    })
    expect(r.status).toBe("completed")
    const updated = db
      .__all("documents")
      .find((d) => d.id === "00000000-0000-4000-8000-000000000100")!
    expect(updated.status).toBe("paid")
    expect(updated.payment_status).toBe("paid")
    // The PDF is re-rendered so it stops saying "Total due"/showing the banking box. The re-render
    // reads the freshly-persisted row, so its template data carries the settled state.
    expect(extras.renderCalls.length).toBeGreaterThanOrEqual(1)
    const lastRender = extras.renderCalls[extras.renderCalls.length - 1]!
    const renderDoc = (lastRender.data as { document: Record<string, unknown> }).document
    expect(renderDoc.payment_status).toBe("paid")
    expect(renderDoc.paid_at).toBe("2026-05-29")
  })

  test("marking a transfer invoice paid reports the collection", async () => {
    const { ctx, db } = makeCtx()
    const id = "00000000-0000-4000-8000-000000000131"
    await db.insert("documents", {
      id,
      type: "invoice",
      status: "issued",
      number: "INV-2026-31",
      number_int: 31,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "eu_domestic",
      operation_category: "services",
      regime: "e_invoice",
      pa_provider: "fakepa",
      incoterm: "DAP",
      issued_at: "2026-11-02",
      pdf_file_id: "pdf-x",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [],
    })
    await db.insert("document_lines", {
      document_id: id,
      position: 1,
      description: "Conseil",
      quantity: "1",
      unit_price_minor: "10000",
      subtotal_minor: "10000",
      tax_minor: "2000",
      tax_rate_bp: 2000,
    })
    await db.insert("einvoice_transmissions", {
      document_id: id,
      action: "send_einvoice",
      idempotency_key: "k-31",
      state: "sent",
      provider_app: "fakepa",
      provider_ref: "pa-31",
    })
    const reported: Array<Record<string, unknown>> = []
    Object.assign(ctx, {
      contracts: {
        call: async (_c: string, op: string, params: Record<string, unknown>) => {
          reported.push({ op, ...params })
          return { status: "completed", result: { state: "accepted" } }
        },
      },
    })
    expect(
      (
        await documentsMarkPaid(ctx, {
          document_id: id,
          paid_date: "2026-11-20",
          payment_note: "bank transfer",
        })
      ).status,
    ).toBe("completed")
    expect(reported).toEqual([
      expect.objectContaining({
        op: "report_collection",
        provider_ref: "pa-31",
        date: "2026-11-20",
        amounts_by_vat_rate: [{ rate_bp: 2000, net_minor: "10000", vat_minor: "2000" }],
      }),
    ])
    expect(db.__all("documents").find((d) => d.id === id)).toMatchObject({
      collection_state: "reported",
    })
  })

  test("emits document:paid with paid_at and payment_status", async () => {
    const { ctx, db, extras } = makeCtx()
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000109",
      type: "invoice",
      status: "issued",
      number: "INV-2026-9",
      number_int: 9,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: "pdf-x",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [],
    })
    await documentsMarkPaid(ctx, {
      document_id: "00000000-0000-4000-8000-000000000109",
      paid_date: "2026-05-29",
    })
    const paid = extras.emittedAttention.find((e) => e.action === "paid")
    expect(paid?.entity).toBe("document")
    expect(paid?.entityId).toBe("00000000-0000-4000-8000-000000000109")
    expect(paid?.data).toMatchObject({
      document_id: "00000000-0000-4000-8000-000000000109",
      type: "invoice",
      number: "INV-2026-9",
      status: "paid",
      currency: "EUR",
      grand_total_minor: "12000",
      paid_at: "2026-05-29",
      payment_status: "paid",
    })
  })

  test("draft invoice cannot be mark_paid", async () => {
    const { ctx, db } = makeCtx()
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000101",
      type: "invoice",
      status: "draft",
      number: null,
      number_int: null,
      year_of_issue: null,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      subtotal_minor: "0",
      tax_total_minor: "0",
      grand_total_minor: "0",
      tax_treatment: null,
      incoterm: "DAP",
      issued_at: null,
      due_at: null,
      pdf_file_id: null,
      pdf_status: null,
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsMarkPaid(ctx, { document_id: "00000000-0000-4000-8000-000000000101" })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("invalid_transition")
  })
})

// ── Imported legacy documents: their imported PDF is the legal original ──
//
// A document brought in by the legacy importer carries `external_refs.import_source` and points
// `pdf_file_id` at the imported PDF. No later write (mark paid, edit, explicit retry, payment
// reconcile) may re-render over it: a render would replace the legal original with a copy the
// app generated from approximated data.

const IMPORTED_ID = "00000000-0000-4000-8000-0000000001a0"

function importedDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: IMPORTED_ID,
    type: "invoice",
    status: "issued",
    payment_status: "unpaid",
    number: "1201",
    number_int: 1201,
    year_of_issue: 2025,
    issuer_profile_id: "iss-1",
    counterparty_contact_id: null,
    counterparty_name: "Studio Fictif",
    counterparty_country: "DE",
    currency: "EUR",
    subtotal_minor: "10000",
    tax_total_minor: "0",
    grand_total_minor: "10000",
    tax_treatment: "intra_eu_b2b",
    incoterm: "DAP",
    issued_at: "2025-03-01",
    due_at: null,
    pdf_file_id: "imported-file-1",
    pdf_status: "ready",
    external_refs: { import_source: "1201.pdf", import_file_id: "imported-file-1" },
    lifecycle_log: [],
    ...overrides,
  }
}

describe("imported legacy documents keep their PDF", () => {
  test("documents_mark_paid on an imported document keeps pdf_file_id and renders nothing", async () => {
    const { ctx, db, extras } = makeCtx()
    await db.insert("documents", importedDoc())
    const r = await documentsMarkPaid(ctx, { document_id: IMPORTED_ID, paid_date: "2025-03-10" })
    expect(r.status).toBe("completed")
    const doc = db.__all("documents").find((d) => d.id === IMPORTED_ID)!
    expect(doc.payment_status).toBe("paid")
    expect(doc.pdf_file_id).toBe("imported-file-1")
    expect(doc.pdf_status).toBe("ready")
    expect(extras.renderCalls).toHaveLength(0)
  })

  test("documents_update on an imported document keeps its PDF", async () => {
    const { ctx, db, extras } = makeCtx()
    await db.insert("documents", importedDoc())
    const r = await documentsUpdate(ctx, { id: IMPORTED_ID, notes: "Contract reference 42" })
    expect(r.status).toBe("completed")
    const doc = db.__all("documents").find((d) => d.id === IMPORTED_ID)!
    expect(doc.notes).toBe("Contract reference 42")
    expect(doc.pdf_file_id).toBe("imported-file-1")
    expect(extras.renderCalls).toHaveLength(0)
  })

  test("documents_retry_pdf on an imported document returns the imported file, rendering nothing", async () => {
    const { ctx, db, extras } = makeCtx()
    await db.insert("documents", importedDoc())
    const r = await documentsRetryPdf(ctx, { id: IMPORTED_ID })
    expect(r).toMatchObject({ status: "completed", pdf_file_id: "imported-file-1" })
    expect(extras.renderCalls).toHaveLength(0)
  })

  test("an imported document with no PDF refuses a render with imported_original_missing (409)", async () => {
    const { ctx, db, extras } = makeCtx()
    await db.insert("documents", importedDoc({ pdf_file_id: null, pdf_status: null }))
    const r = await documentsRetryPdf(ctx, { id: IMPORTED_ID })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error).toMatchObject({
      code: "imported_original_missing",
      status: 409,
      retryable: true,
    })
    expect(r.error.message).toContain("einvoicing_backfill_legacy_originals")
    expect(extras.renderCalls).toHaveLength(0)
    const doc = db.__all("documents").find((d) => d.id === IMPORTED_ID)!
    expect(doc.pdf_status).toBeNull()
  })

  test("a non-imported issued document still re-renders on documents_retry_pdf", async () => {
    const { ctx, db, extras } = makeCtx()
    await db.insert("documents", importedDoc({ external_refs: {}, pdf_file_id: "pdf-x" }))
    const r = await documentsRetryPdf(ctx, { id: IMPORTED_ID })
    expect(r.status).toBe("completed")
    expect(extras.renderCalls).toHaveLength(1)
    const doc = db.__all("documents").find((d) => d.id === IMPORTED_ID)!
    expect(doc.pdf_file_id).not.toBe("pdf-x")
  })
})

// ── documents.record_refund ───────────────────────────────────────────────

describe("documents.record_refund", () => {
  test("full refund transitions paid→refunded", async () => {
    const { ctx, db } = makeCtx()
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000100",
      type: "invoice",
      status: "paid",
      number: "INV-2026-1",
      number_int: 1,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: "pdf-x",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsRecordRefund(ctx, {
      document_id: "00000000-0000-4000-8000-000000000100",
      refund_amount_minor: 12_000n,
      refund_kind: "full",
    })
    expect(r.status).toBe("completed")
    const updated = db
      .__all("documents")
      .find((d) => d.id === "00000000-0000-4000-8000-000000000100")!
    expect(updated.status).toBe("refunded")
    expect(updated.payment_status).toBe("refunded")
  })

  test("partial refund stays in paid status but records the refund event", async () => {
    const { ctx, db } = makeCtx()
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000100",
      type: "invoice",
      status: "paid",
      number: "INV-2026-1",
      number_int: 1,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: "pdf-x",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsRecordRefund(ctx, {
      document_id: "00000000-0000-4000-8000-000000000100",
      refund_amount_minor: 3_000n,
      refund_kind: "partial",
    })
    expect(r.status).toBe("completed")
    const updated = db
      .__all("documents")
      .find((d) => d.id === "00000000-0000-4000-8000-000000000100")!
    expect(updated.status).toBe("paid")
    expect(updated.payment_status).toBe("partial")
    const log = updated.lifecycle_log as Array<Record<string, unknown>>
    expect(log.at(-1)).toMatchObject({ event: "partial_refund_recorded" })
  })

  const paidDoc = () => ({
    id: "00000000-0000-4000-8000-000000000100",
    type: "invoice",
    status: "paid",
    number: "INV-2026-1",
    number_int: 1,
    year_of_issue: 2026,
    issuer_profile_id: "iss-1",
    counterparty_contact_id: "contact-1",
    currency: "EUR",
    subtotal_minor: "10000",
    tax_total_minor: "2000",
    grand_total_minor: "12000",
    tax_treatment: "domestic",
    incoterm: "DAP",
    issued_at: "2026-05-28",
    due_at: null,
    pdf_file_id: "pdf-x",
    pdf_status: "ready",
    external_refs: {},
    lifecycle_log: [],
  })

  test("an amount that arrives as a JSON number (an approval payload) is recorded, not thrown on", async () => {
    // The wire carries 3000, not 3000n: mixing it with the bigint prior-refund
    // sum threw "cannot convert bigint to number" and the approval failed.
    const { ctx, db } = makeCtx()
    await db.insert("documents", paidDoc())
    const r = await documentsRecordRefund(ctx, {
      document_id: "00000000-0000-4000-8000-000000000100",
      refund_amount_minor: 3000 as unknown as bigint,
      refund_kind: "partial",
    })
    expect(r.status).toBe("completed")
    const updated = db
      .__all("documents")
      .find((d) => d.id === "00000000-0000-4000-8000-000000000100")!
    expect(updated.payment_status).toBe("partial")
    const log = updated.lifecycle_log as Array<Record<string, unknown>>
    expect(log.at(-1)).toMatchObject({
      event: "partial_refund_recorded",
      refund_amount_minor: "3000",
    })
    const pre = await documentsRecordRefundPreflight(ctx, {
      document_id: "00000000-0000-4000-8000-000000000100",
      refund_amount_minor: 20000 as unknown as bigint,
      refund_kind: "partial",
    })
    expect(JSON.stringify(pre)).toContain("invalid_amount")
  })

  test("partial refund with amount=0n is rejected (invalid_amount)", async () => {
    const { ctx, db } = makeCtx()
    await db.insert("documents", paidDoc())
    const r = await documentsRecordRefund(ctx, {
      document_id: "00000000-0000-4000-8000-000000000100",
      refund_amount_minor: 0n,
      refund_kind: "partial",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("invalid_amount")
  })

  test("partial refund with amount exceeding grand_total is rejected (invalid_amount)", async () => {
    const { ctx, db } = makeCtx()
    await db.insert("documents", paidDoc())
    const r = await documentsRecordRefund(ctx, {
      document_id: "00000000-0000-4000-8000-000000000100",
      refund_amount_minor: 99_999n,
      refund_kind: "partial",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("invalid_amount")
  })

  test("full refund with amount=0n is rejected (invalid_amount)", async () => {
    const { ctx, db } = makeCtx()
    await db.insert("documents", paidDoc())
    const r = await documentsRecordRefund(ctx, {
      document_id: "00000000-0000-4000-8000-000000000100",
      refund_amount_minor: 0n,
      refund_kind: "full",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("invalid_amount")
  })

  // ── C1: cumulative-refund guard (sequential partials) ────────────────────

  test("sequential partials that exceed 100% are rejected on the over-amount", async () => {
    const { ctx, db } = makeCtx()
    await db.insert("documents", paidDoc()) // grand_total_minor = 12000
    // First partial: 8000 of 12000 — accepted, stays partial.
    const r1 = await documentsRecordRefund(ctx, {
      document_id: "00000000-0000-4000-8000-000000000100",
      refund_amount_minor: 8_000n,
      refund_kind: "partial",
    })
    expect(r1.status).toBe("completed")
    const afterFirst = db
      .__all("documents")
      .find((d) => d.id === "00000000-0000-4000-8000-000000000100")!
    expect(afterFirst.payment_status).toBe("partial")
    // Second partial: 5000 — alone it is <= 12000, but cumulative 13000 > 12000.
    const r2 = await documentsRecordRefund(ctx, {
      document_id: "00000000-0000-4000-8000-000000000100",
      refund_amount_minor: 5_000n,
      refund_kind: "partial",
    })
    expect(r2.status).toBe("error")
    if (r2.status !== "error") throw new Error("unreachable")
    expect(r2.error.code).toBe("invalid_amount")
    // The rejected refund left no new lifecycle entry: still exactly one.
    const afterSecond = db
      .__all("documents")
      .find((d) => d.id === "00000000-0000-4000-8000-000000000100")!
    const log = afterSecond.lifecycle_log as Array<Record<string, unknown>>
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      event: "partial_refund_recorded",
      refund_amount_minor: "8000",
    })
    expect(afterSecond.payment_status).toBe("partial")
  })

  test("partials summing to exactly 100% flip payment_status to refunded", async () => {
    const { ctx, db } = makeCtx()
    await db.insert("documents", paidDoc()) // grand_total_minor = 12000
    const r1 = await documentsRecordRefund(ctx, {
      document_id: "00000000-0000-4000-8000-000000000100",
      refund_amount_minor: 5_000n,
      refund_kind: "partial",
    })
    expect(r1.status).toBe("completed")
    const r2 = await documentsRecordRefund(ctx, {
      document_id: "00000000-0000-4000-8000-000000000100",
      refund_amount_minor: 7_000n, // 5000 + 7000 === 12000 exactly
      refund_kind: "partial",
    })
    expect(r2.status).toBe("completed")
    const updated = db
      .__all("documents")
      .find((d) => d.id === "00000000-0000-4000-8000-000000000100")!
    expect(updated.payment_status).toBe("refunded")
    expect(updated.status).toBe("refunded")
    const log = updated.lifecycle_log as Array<Record<string, unknown>>
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ refund_amount_minor: "5000" })
    expect(log[1]).toMatchObject({ refund_amount_minor: "7000" })
  })
})

// ── documents.send_to_customer ────────────────────────────────────────────

describe("documents.send_to_customer", () => {
  test("sends the LEGAL ORIGINAL, never the management copy a later re-render left on pdf_file_id", async () => {
    const { ctx, db, extras } = makeCtx({
      executeToolImpl: async () => ({
        status: "completed",
        result: { messageId: "<legal-original-1>" },
      }),
    })
    await db.insert("legal_originals", {
      id: "00000000-0000-4000-8000-0000000001a0",
      document_id: "00000000-0000-4000-8000-0000000001a1",
      kind: "facturx",
      file_id: "legal-original-file",
      sha256: "f".repeat(64),
      byte_size: 1000,
      recorded_at: "2026-05-28T10:00:00Z",
    })
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-0000000001a1",
      type: "invoice",
      status: "issued",
      number: "INV-2026-9",
      number_int: 9,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: "management-copy",
      pdf_status: "ready",
      legal_original_id: "00000000-0000-4000-8000-0000000001a0",
      legal_original_sha256: "f".repeat(64),
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsSendToCustomer(ctx, {
      document_id: "00000000-0000-4000-8000-0000000001a1",
      to: "buyer@example.com",
    })
    expect(r.status).toBe("completed")
    const call = extras.executeToolCalls.find((c) => c.name === "mail:composeForApp")
    expect((call!.args as { attachments?: unknown[] }).attachments).toEqual(["legal-original-file"])
  })

  test("dispatches via mail:composeForApp (internal cross-app, NOT the gated mail:compose) — BL-186", async () => {
    // documents_send_to_customer is ALREADY gated at the invoicing surface, so its post-approval
    // handler must EXECUTE the send via the INTERNAL mail:composeForApp (no per-call gating), NOT the
    // agent-facing gated mail:compose — which, invoked cross-app from an already-approved handler,
    // tries to create a SECOND approval and fails "threadId required to create an approval request"
    // (no thread in the post-approval execution context) → send_dispatch_failed. composeForApp
    // executes directly and returns a completed envelope.
    const { ctx, db, extras } = makeCtx({
      executeToolImpl: async () => ({
        status: "completed",
        result: { messageId: "<chaos-gmail-1>" },
      }),
    })
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000100",
      type: "invoice",
      status: "issued",
      number: "INV-2026-1",
      number_int: 1,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: "pdf-x",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsSendToCustomer(ctx, {
      document_id: "00000000-0000-4000-8000-000000000100",
      to: "buyer@example.com",
      subject: "Your invoice",
      body: "Find attached.",
    })
    expect(r.status).toBe("completed")
    expect(extras.executeToolCalls).toHaveLength(1)
    expect(extras.executeToolCalls[0]!.name).toBe("mail:composeForApp")
    const rawArgs = extras.executeToolCalls[0]!.args
    const args = (typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs) as {
      attachments: string[]
      textBody?: string
      body?: string
      originating_approval_id?: string
    }
    expect(args.attachments).toContain("pdf-x")
    // composeForApp REQUIRES `textBody` (required set [accountId, to, subject, textBody,
    // originating_approval_id]); the body must go through as `textBody`, NOT `body`, or the send fails
    // `invalid_params` → send_dispatch_failed (the l314 bug, preserved through the BL-186 switch).
    expect(args.textBody).toBe("Find attached.")
    expect(args.body).toBeUndefined()
    // composeForApp threads the originating approval id (present even when empty) for the audit chain.
    expect(args.originating_approval_id !== undefined).toBe(true)
  })

  test("missing PDF is rendered ON-DEMAND then sent (self-heal, not pdf_not_ready)", async () => {
    const { ctx, db, extras } = makeCtx({
      executeToolImpl: async () => ({
        status: "completed",
        result: { messageId: "<chaos-gmail-2>" },
      }),
    })
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000101",
      type: "invoice",
      status: "issued",
      number: "INV-2026-1",
      number_int: 1,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Klangwerk GmbH",
      counterparty_country: "DE",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "eu_domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: "2026-06-04",
      pdf_file_id: null, // never rendered at issue time (e.g. a seeded issued doc, or a failed render)
      pdf_status: "pending",
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsSendToCustomer(ctx, {
      document_id: "00000000-0000-4000-8000-000000000101",
      to: "buyer@example.com",
    })
    // Self-heal: the send rendered the PDF on-demand rather than refusing with pdf_not_ready.
    expect(r.status).toBe("completed")
    expect(extras.renderCalls).toHaveLength(1) // rendered exactly once, on-demand
    // The freshly rendered PDF was persisted on the doc (pdf_status flips to ready).
    const after = (
      await db.findMany("documents", {
        where: { id: "00000000-0000-4000-8000-000000000101" },
        limit: 1,
      })
    )[0] as Record<string, unknown>
    expect(after.pdf_status).toBe("ready")
    expect(after.pdf_file_id).toBeTruthy()
    // BL-191 — this first render IS the invoice's legal original, filed under its own
    // `legal_original` parent; the cross-app mail:composeForApp can only see it once that parent row
    // is committed, so the on-demand render asks the host to commit the row WITH the file
    // (parent.commitRow), never leaving it in this handler's still-open transaction.
    expect(extras.renderCalls).toHaveLength(1)
    const call = extras.renderCalls[0] as unknown as {
      pdfa?: string
      parent?: {
        entityType: string
        entityId?: string
        commitRow?: {
          values: Record<string, unknown>
          fileIdColumn?: string
          sha256Column?: string
        }
      }
    }
    expect(call.pdfa).toBe("3b")
    expect(call.parent?.entityType).toBe("legal_original")
    expect(call.parent?.entityId).toBeUndefined()
    expect(call.parent?.commitRow?.values).toMatchObject({
      document_id: "00000000-0000-4000-8000-000000000101",
      kind: "issued_pdf",
    })
    expect(call.parent?.commitRow?.fileIdColumn).toBe("file_id")
    expect(call.parent?.commitRow?.sha256Column).toBe("sha256")
    expect(after.legal_original_id).toBeTruthy()
    // …and that same file id is what mail:composeForApp attached.
    const mailCall = extras.executeToolCalls.find((c) => c.name === "mail:composeForApp")
    expect(mailCall).toBeDefined()
    const args = typeof mailCall!.args === "string" ? JSON.parse(mailCall!.args) : mailCall!.args
    expect((args as { attachments: string[] }).attachments).toEqual([String(after.pdf_file_id)])
  })

  test("on-demand render FAILURE surfaces the render error (not pdf_not_ready) + marks pdf_status failed", async () => {
    const { ctx, db } = makeCtx({ failPdfRender: true })
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000102",
      type: "invoice",
      status: "issued",
      number: "INV-2026-2",
      number_int: 2,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: null,
      pdf_status: "pending",
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsSendToCustomer(ctx, {
      document_id: "00000000-0000-4000-8000-000000000102",
      to: "buyer@example.com",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("render_failed") // the real cause, surfaced — not a generic pdf_not_ready
    const after = (
      await db.findMany("documents", {
        where: { id: "00000000-0000-4000-8000-000000000102" },
        limit: 1,
      })
    )[0] as Record<string, unknown>
    expect(after.pdf_status).toBe("failed")
  })

  test("no send-from mail account on the issuer → no_mail_account (cannot send without an account)", async () => {
    const { ctx, db } = makeCtx({ mailAccountId: null })
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000103",
      type: "invoice",
      status: "issued",
      number: "INV-2026-3",
      number_int: 3,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: "pdf-y",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsSendToCustomer(ctx, {
      document_id: "00000000-0000-4000-8000-000000000103",
      to: "buyer@example.com",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("no_mail_account")
  })

  test("no send-from mail account refuses with an actionable typed error, never a throw", async () => {
    // Prod 2026-09-22: a human clicking Send on a document whose issuer profile has no
    // send-from mailbox. A configuration precondition is NOT a server fault: it must come
    // back as the module's typed error envelope (HTTP 200 + warn), never as a thrown Error
    // (error-level log + HTTP 500), and the message a human reads must say what to set and
    // carry no dash punctuation.
    const { ctx, db } = makeCtx({ mailAccountId: null })
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000903",
      type: "invoice",
      status: "issued",
      number: "INV-2026-903",
      number_int: 903,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: "pdf-y",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [],
    })
    const input = { document_id: "00000000-0000-4000-8000-000000000903", to: "buyer@example.com" }
    // Both surfaces: the executed send and the stage-time preflight (the UI Send button
    // hits the preflight first). Neither may throw.
    const r = await documentsSendToCustomer(ctx, input)
    const pre = await documentsSendToCustomerPreflight(ctx, input)
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("no_mail_account")
    if (!("error" in pre)) throw new Error("preflight should have refused")
    expect(pre.error.code).toBe("no_mail_account")
    for (const message of [r.error.message, pre.error.message]) {
      // Actionable: names the mailbox setting and the issuer profile.
      expect(message.toLowerCase()).toContain("send-from mailbox")
      expect(message.toLowerCase()).toContain("issuer profile")
      // User-facing copy: no em dash, no en dash, no double hyphen.
      expect(/[\u2013\u2014]|--/.test(message)).toBe(false)
    }
  })

  test("counterparty contact has no email (and no override) → no_recipient", async () => {
    // Default executeTool mock returns no contact → the kernel:contacts_read resolve yields no email.
    const { ctx, db } = makeCtx() // issuer has a mail account by default
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000104",
      type: "invoice",
      status: "issued",
      number: "INV-2026-4",
      number_int: 4,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: "pdf-z",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsSendToCustomer(ctx, {
      document_id: "00000000-0000-4000-8000-000000000104",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("no_recipient")
  })

  test("AUTO-RESOLVES the recipient from the counterparty contact (the tool has no `to` param)", async () => {
    const { ctx, db, extras } = makeCtx({
      executeToolImpl: async (name) => {
        if (name === "kernel:contacts_read") {
          return { status: "completed", result: { contact: { email: "dealer@x.example" } } }
        }
        return { status: "completed", result: { messageId: "<chaos-gmail-x>" } } // mail:composeForApp
      },
    })
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000105",
      type: "invoice",
      status: "issued",
      number: "INV-2026-5",
      number_int: 5,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: "pdf-q",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsSendToCustomer(ctx, {
      document_id: "00000000-0000-4000-8000-000000000105",
    }) // NO `to` — must auto-resolve
    expect(r.status).toBe("completed")
    // It read the contact to resolve the recipient…
    expect(extras.executeToolCalls.some((c) => c.name === "kernel:contacts_read")).toBe(true)
    // …and mail:composeForApp was addressed to that email.
    const mailCall = extras.executeToolCalls.find((c) => c.name === "mail:composeForApp")
    expect(mailCall).toBeDefined()
    const args = typeof mailCall!.args === "string" ? JSON.parse(mailCall!.args) : mailCall!.args
    expect((args as { to: string[] }).to).toEqual(["dealer@x.example"])
  })

  // Regression — the issue-dealer no_recipient flake. The weak agent often builds the document against
  // a freshly-created / email-less contact (counterparty_contact_id points at a contact with no email),
  // so the contacts_read resolve yields nothing and the send dead-ended on no_recipient even though the
  // customer EXISTS in the registry with an address. The send must fall back to contacts_search by the
  // document's counterparty_name and use the matching contact's email.
  test("FALLBACK — resolves the recipient by counterparty_name via contacts_search when the linked contact has no email", async () => {
    const { ctx, db, extras } = makeCtx({
      executeToolImpl: async (name, args) => {
        if (name === "kernel:contacts_read") {
          // the LINKED contact has no email (a fresh duplicate the agent created)
          return { status: "completed", result: { contact: { email: null } } }
        }
        if (name === "kernel:contacts_search") {
          const q = (typeof args === "string" ? JSON.parse(args) : args) as { query?: string }
          expect(q.query).toBe("Tonwerk Audio")
          return {
            status: "completed",
            result: {
              items: [
                { id: "c-dup", name: "Tonwerk Audio", primaryEmail: null }, // the email-less duplicate
                {
                  id: "c-seed",
                  name: "Tonwerk Audio",
                  primaryEmail: "buying@tonwerk-audio.example.de",
                },
              ],
            },
          }
        }
        return { status: "completed", result: { messageId: "<chaos-gmail-y>" } } // mail:composeForApp
      },
    })
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000106",
      type: "invoice",
      status: "issued",
      number: "INV-2026-7",
      number_int: 7,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Tonwerk Audio",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: "pdf-w",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsSendToCustomer(ctx, {
      document_id: "00000000-0000-4000-8000-000000000106",
    }) // NO `to` — must fall back to search
    expect(r.status).toBe("completed")
    // It tried the linked contact first, then fell back to contacts_search…
    expect(extras.executeToolCalls.some((c) => c.name === "kernel:contacts_read")).toBe(true)
    expect(extras.executeToolCalls.some((c) => c.name === "kernel:contacts_search")).toBe(true)
    // …and addressed mail:composeForApp to the searched contact that DOES have an email.
    const mailCall = extras.executeToolCalls.find((c) => c.name === "mail:composeForApp")
    expect(mailCall).toBeDefined()
    const args = typeof mailCall!.args === "string" ? JSON.parse(mailCall!.args) : mailCall!.args
    expect((args as { to: string[] }).to).toEqual(["buying@tonwerk-audio.example.de"])
  })

  // Regression (BL-27, l69) — recipient resolution MUST pass OBJECT args to ctx.executeTool, never a
  // pre-stringified JSON string. The sandbox `__wrap` marshaller only JSON-parses a host method's
  // STRING return when a NON-primitive arg was passed; a primitive string arg makes it skip the parse,
  // so the caller reads an UNPARSED JSON string and `.status`/`.result` come back `undefined` → both
  // resolution paths yield empty → `no_recipient` for a contact that DOES have an email (observed in the
  // dunning-overdue-net30-dealers chaos re-confirm). The unit mock returns objects directly so it can't
  // reproduce the marshaller leak — this asserts the CALL SHAPE that avoids it (the same guard class as
  // l62's "ctx.fetch is called with a non-primitive opts object"). The cross-app.ts type narrow makes the
  // string form a compile error too; this is the runtime backstop.
  test("recipient resolution passes OBJECT args to executeTool (no primitive-string leak — BL-27)", async () => {
    const { ctx, db, extras } = makeCtx({
      executeToolImpl: async (name) => {
        if (name === "kernel:contacts_read") {
          return { status: "completed", result: { contact: { email: "ar@klangwerk.example" } } }
        }
        return { status: "completed", result: { messageId: "<chaos-gmail-z>" } } // mail:composeForApp
      },
    })
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000108",
      type: "invoice",
      status: "issued",
      number: "INV-2026-310",
      number_int: 310,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-dun",
      counterparty_name: "Klangwerk GmbH",
      counterparty_country: "DE",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "1900",
      grand_total_minor: "11900",
      tax_treatment: "eu_domestic",
      incoterm: "DAP",
      issued_at: "2026-05-03",
      due_at: "2026-06-02",
      pdf_file_id: "pdf-dun",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsSendToCustomer(ctx, {
      document_id: "00000000-0000-4000-8000-000000000108",
    }) // NO `to` — resolves via contacts_read
    expect(r.status).toBe("completed")
    // The linked contact's email resolved directly (path 1), so no fallback search was needed…
    expect(extras.executeToolCalls.some((c) => c.name === "kernel:contacts_read")).toBe(true)
    // …and CRUCIALLY every executeTool call carried an OBJECT, never a primitive string.
    expect(extras.executeToolCalls.length).toBeGreaterThan(0)
    for (const call of extras.executeToolCalls) {
      expect(call.args !== null && typeof call.args === "object").toBe(true)
    }
    const mailCall = extras.executeToolCalls.find((c) => c.name === "mail:composeForApp")
    expect((mailCall!.args as { to: string[] }).to).toEqual(["ar@klangwerk.example"])
  })

  // Regression (BL-31) — a DETAIL-LESS send error must NOT dead-end with no reason. Under BL-23 severe
  // memory pressure the cross-app mail:compose dispatch surfaced a bare `{status:"error"}` (no `error`
  // field — the declared CrossAppEnvelope type promises one, but the QuickJS marshaller under-delivers
  // as the world dies under swap). sendErrorFromEnvelope synthesizes a meaningful reason so the
  // agent/judge see WHY the send failed and the conductor log captures the envelope shape.
  test("BL-31: sendErrorFromEnvelope synthesizes a reason for a detail-less error envelope", () => {
    // The wire-bare case (no error field) — the exact BL-31 shape.
    const bare = sendErrorFromEnvelope({})
    expect(bare.code).toBe("send_dispatch_failed")
    expect(bare.message).toMatch(/mail:compose/)
    // A genuine detailed error passes through unchanged.
    const detailed = sendErrorFromEnvelope({ error: { code: "no_recipient", message: "no email" } })
    expect(detailed).toEqual({ code: "no_recipient", message: "no email" })
    // A half-populated error still yields a usable reason.
    const codeOnly = sendErrorFromEnvelope({ error: { code: "smtp_rejected" } })
    expect(codeOnly.code).toBe("smtp_rejected")
  })

  // Regression — the same fallback with NO contact link at all. A document carrying only a
  // counterparty_name (no counterparty_contact_id) must still resolve a recipient via the registry.
  test("FALLBACK — resolves the recipient by counterparty_name even with no counterparty_contact_id", async () => {
    const { ctx, db, extras } = makeCtx({
      executeToolImpl: async (name) => {
        if (name === "kernel:contacts_search") {
          return {
            status: "completed",
            result: {
              items: [
                {
                  id: "c-seed",
                  name: "Tonwerk Audio",
                  primaryEmail: "buying@tonwerk-audio.example.de",
                },
              ],
            },
          }
        }
        return { status: "completed", result: { messageId: "<chaos-gmail-8>" } } // mail:composeForApp
      },
    })
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000107",
      type: "invoice",
      status: "issued",
      number: "INV-2026-8",
      number_int: 8,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: null,
      counterparty_name: "Tonwerk Audio",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      pdf_file_id: "pdf-v",
      pdf_status: "ready",
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsSendToCustomer(ctx, {
      document_id: "00000000-0000-4000-8000-000000000107",
    })
    expect(r.status).toBe("completed")
    // No contact link → it must NOT call contacts_read, but MUST search by name.
    expect(extras.executeToolCalls.some((c) => c.name === "kernel:contacts_read")).toBe(false)
    expect(extras.executeToolCalls.some((c) => c.name === "kernel:contacts_search")).toBe(true)
    const mailCall = extras.executeToolCalls.find((c) => c.name === "mail:composeForApp")
    const args = typeof mailCall!.args === "string" ? JSON.parse(mailCall!.args) : mailCall!.args
    expect((args as { to: string[] }).to).toEqual(["buying@tonwerk-audio.example.de"])
  })
})

// ── E7 — Quote / Proforma / PO ────────────────────────────────────────────

describe("quote.issue + quote.create_and_issue", () => {
  test("quote.issue is ALWAYS gated regardless of amount (no threshold)", async () => {
    const { ctx, extras } = makeCtx({ issuerThresholdMinor: 1_000_000_000n })
    const { draft_id } = await draftsCreate(ctx, {
      type: "quote",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const r = await quoteIssue(ctx, { draft_id })
    expect(r.status).toBe("pending_approval")
    expect(extras.approvalsRequested[0]!.tool_name).toBe("invoicing:quote_issue")
    const detail = extras.approvalsRequested[0]!.summary_detail!
    expect(detail.lines).toContain(
      "Document: new quote from a saved draft (number assigned on issue)",
    )
    // The card names the draft by what it is, never by its id.
    const req = extras.approvalsRequested[0]!
    expect(
      [req.summary, req.summary_detail!.subtitle ?? "", ...(req.summary_detail!.lines ?? [])].join(
        "\n",
      ),
    ).not.toContain(draft_id)
    expect(req.summary).toBe("Issue quote for Buyer SARL, 120.00 EUR")
    expect(detail.lines).toContain("Line: Widget x 2 @ 50.00 EUR")
    expect(detail.lines).toContain("Total: 120.00 EUR")
  })

  test("quote.issue re-entry with ctx.approval populated → completed", async () => {
    const { ctx, db } = makeCtx({
      approval: {
        approvalRequestId: "appr-x",
        approvalDeciderId: "user-2",
        toolName: "invoicing:quote_issue",
      },
    })
    const { draft_id } = await draftsCreate(ctx, {
      type: "quote",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const r = await quoteIssue(ctx, { draft_id })
    expect(r.status).toBe("completed")
    const issued = issuedDocs(db)
    expect(issued).toHaveLength(1)
    expect(issued[0]!.type).toBe("quote")
  })

  // A quote commits nobody to anything, and when the issuer is mapped to a Shopify shop the
  // quote IS a draft order whose creation carries its own Shopify approval. Gating EVERY quote
  // on top of that was pure friction, so the standalone path now gates only above the issuer's
  // invoice threshold, exactly like an invoice.
  test("quote.create_and_issue with no threshold issues immediately (standalone issuer)", async () => {
    const { ctx, db, extras } = makeCtx()
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    expect(extras.approvalsRequested).toHaveLength(0)
    const quotes = db.__all("documents").filter((d) => d.type === "quote")
    expect(quotes).toHaveLength(1)
    // A quote is born "sent": a live offer, and the status the transition table drives
    // accept / reject / expire / convert_to_invoice from.
    expect(quotes[0]!.status).toBe("sent")
  })

  test("quote.create_and_issue above the issuer threshold parks an approval (standalone issuer)", async () => {
    // grand = 12_000 (10_000 + 20% FR VAT); threshold 5_000 -> above
    const { ctx, db, extras } = makeCtx({ issuerThresholdMinor: 5_000n })
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("pending_approval")
    expect(extras.approvalsRequested[0]!.tool_name).toBe("invoicing:quote_create_and_issue")
    expect(db.__all("documents").filter((d) => d.type === "quote")).toHaveLength(0)
  })
})

// ── quote_create_and_issue: the Shopify draft-order path ────────────────────
// A quote for a shop-mapped issuer IS a Shopify draft order. The tool creates the draft order
// and the sync mirrors it back, so there is never a local quote and a draft order describing the
// same offer separately.

describe("splitPostalAddress", () => {
  test("street, extra, zip city, country splits into Shopify fields", () => {
    expect(splitPostalAddress("24 Avenue Marceau, Bureau 108A, 75008 Paris, France", "FR")).toEqual(
      {
        address1: "24 Avenue Marceau",
        address2: "Bureau 108A",
        zip: "75008",
        city: "Paris",
      },
    )
  })
  test("newline separated with the country code as the last line", () => {
    expect(splitPostalAddress("Grimmstr. 9\n70771 Leinfelden-Echterdingen\nDE", "DE")).toEqual({
      address1: "Grimmstr. 9",
      address2: null,
      zip: "70771",
      city: "Leinfelden-Echterdingen",
    })
  })
  test("city before the zip and a UK style postcode", () => {
    expect(splitPostalAddress("130 W 79th St Apt 6E, New York 10024", "US")).toEqual({
      address1: "130 W 79th St Apt 6E",
      address2: null,
      zip: "10024",
      city: "New York",
    })
    expect(
      splitPostalAddress("20 Buccleuch Place, EH8 9LN Edinburgh, United Kingdom", "GB"),
    ).toEqual({
      address1: "20 Buccleuch Place",
      address2: null,
      zip: "EH8 9LN",
      city: "Edinburgh",
    })
  })
  test("no zip anywhere: the last segment is the city", () => {
    expect(splitPostalAddress("1 rue Buyer, Paris", "FR")).toEqual({
      address1: "1 rue Buyer",
      address2: null,
      zip: null,
      city: "Paris",
    })
  })
  test("a single segment has no city", () => {
    expect(splitPostalAddress("Somewhere", "FR")).toEqual({
      address1: "Somewhere",
      address2: null,
      zip: null,
      city: null,
    })
  })
})

describe("quote.create_and_issue via Shopify draft order", () => {
  const shopIssuerSeed = [
    {
      ...seedIssuer(defaultIssuer, { invoice: null, po: null }),
      shopify_shop_id: "acme.myshopify.com",
    },
  ]

  function draftOrderFixture(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      draftOrderId: "gid://shopify/DraftOrder/77",
      name: "#D77",
      status: "open",
      orderId: null,
      orderName: null,
      shopDomain: "acme.myshopify.com",
      currency: "EUR",
      totalPrice: "120.00",
      taxesIncluded: false,
      taxExempt: false,
      email: "ap@buyersarl.example",
      note: null,
      tags: [],
      customer: {
        id: "gid://shopify/Customer/42",
        email: "ap@buyersarl.example",
        firstName: "Buyer",
        lastName: "SARL",
        company: null,
      },
      billingAddress: {
        name: "Buyer SARL",
        company: "Buyer SARL",
        address1: "1 rue Buyer",
        address2: null,
        zip: "75002",
        city: "Paris",
        province: null,
        countryCode: "FR",
        phone: null,
      },
      shippingAddress: null,
      appliedDiscount: null,
      shippingLine: null,
      taxLines: [],
      lineItems: [
        {
          id: "gid://shopify/DraftOrderLineItem/1",
          title: "Widget",
          sku: null,
          variantId: "gid://shopify/ProductVariant/9",
          productId: null,
          quantity: 2,
          unitPrice: "50.00",
          discountedTotal: "100.00",
          appliedDiscount: null,
          taxable: true,
          requiresShipping: true,
          custom: false,
        },
      ],
      ...overrides,
    }
  }

  function shopifyCtx(opts?: { createEnvelope?: CrossAppEnvelope }) {
    return makeCtx({
      seed: { issuer_profiles: shopIssuerSeed },
      executeToolImpl: async (name) => {
        if (name === "shopify:draft_orders_create")
          return (
            opts?.createEnvelope ?? {
              status: "completed",
              result: { draftOrder: { id: "gid://shopify/DraftOrder/77", name: "#D77" } },
            }
          )
        if (name === "shopify:draft_orders_get")
          return { status: "completed", result: { draftOrder: draftOrderFixture() } }
        // The kernel's own contacts_read: `{ contactId }` in, `{ contact: { externalIds } }` out.
        if (name === "kernel:contacts_read")
          return {
            status: "completed",
            result: {
              contact: { id: defaultCounterparty.contact_id, externalIds: { shopify: "42" } },
            },
          }
        return { status: "completed", result: {} }
      },
    })
  }

  test("mapped issuer: creates the draft order in Shopify and returns the synced quote", async () => {
    const { ctx, db, extras } = shopifyCtx()
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "Widget",
          quantity: "2",
          unit_price_minor: 5_000n,
          product_source: "shopify",
          external_id: "gid://shopify/ProductVariant/9",
        },
      ],
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.shopify_draft_order_id).toBe("gid://shopify/DraftOrder/77")
    expect(r.shopify_draft_order_name).toBe("#D77")
    const created = extras.executeToolCalls.find((c) => c.name === "shopify:draft_orders_create")!
    const args = (created.args as { input: Record<string, unknown> }).input
    // A catalog line goes as a VARIANT line so Shopify prices and stocks it itself.
    expect(args.lineItems).toEqual([{ variantId: "gid://shopify/ProductVariant/9", quantity: 2 }])
    expect(args.email).toBe("ap@buyersarl.example")
    expect(args.purchasingEntity).toEqual({ customerId: "gid://shopify/Customer/42" })
    const read = extras.executeToolCalls.find((c) => c.name === "kernel:contacts_read")!
    expect(read.args).toEqual({ contactId: defaultCounterparty.contact_id })
    expect(args.tags).toEqual(["liaison-quote"])
    // Exactly one quote, carrying the link, and never a second one for the same draft order.
    const quotes = db.__all("documents").filter((d) => d.type === "quote")
    expect(quotes).toHaveLength(1)
    expect(quotes[0]!.shopify_draft_order_id).toBe("gid://shopify/DraftOrder/77")
    expect(quotes[0]!.status).toBe("sent")
  })

  test("a business buyer's VAT number rides on the draft order as a custom attribute, a consumer's draft has none", async () => {
    // The order-created auto-flow reads the buyer VAT number only from the order's custom
    // attributes: without it a reverse charge quote turns into an order invoicing parks.
    const item = {
      position: 1,
      description: "Widget",
      quantity: "1",
      unit_price_minor: 5_000n,
      product_source: "shopify",
      external_id: "gid://shopify/ProductVariant/9",
    }
    const b2b = shopifyCtx()
    await quoteCreateAndIssue(b2b.ctx, {
      counterparty: { ...defaultCounterparty, vat_id: " IT01234567890 " },
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [item],
    })
    const b2bInput = (
      b2b.extras.executeToolCalls.find((c) => c.name === "shopify:draft_orders_create")!.args as {
        input: Record<string, unknown>
      }
    ).input
    expect(b2bInput.customAttributes).toEqual([{ key: "VAT number", value: "IT01234567890" }])
    const b2c = shopifyCtx()
    await quoteCreateAndIssue(b2c.ctx, {
      counterparty: { ...defaultCounterparty, vat_id: null },
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [item],
    })
    const b2cInput = (
      b2c.extras.executeToolCalls.find((c) => c.name === "shopify:draft_orders_create")!.args as {
        input: Record<string, unknown>
      }
    ).input
    expect(b2cInput.customAttributes).toBeUndefined()
  })

  test("a non-catalog line goes to Shopify as a custom line at the quote's price", async () => {
    const { ctx, extras } = shopifyCtx()
    await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "Bespoke install day",
          quantity: "1",
          unit_price_minor: 41_940n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    const created = extras.executeToolCalls.find((c) => c.name === "shopify:draft_orders_create")!
    expect((created.args as { input: Record<string, unknown> }).input.lineItems).toEqual([
      {
        title: "Bespoke install day",
        quantity: 1,
        originalUnitPriceWithCurrency: { amount: "419.40", currencyCode: "EUR" },
      },
    ])
  })

  test("a pending_approval from Shopify is the gate: it is returned and no quote is written", async () => {
    const { ctx, db } = shopifyCtx({
      createEnvelope: { status: "pending_approval", approval_id: "shopify-appr-9" },
    })
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("pending_approval")
    if (r.status !== "pending_approval") throw new Error("unreachable")
    expect(r.approval_id).toBe("shopify-appr-9")
    expect(db.__all("documents").filter((d) => d.type === "quote")).toHaveLength(0)
  })

  test("a standalone issuer never touches Shopify", async () => {
    const { ctx, extras } = makeCtx()
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    expect(extras.executeToolCalls.filter((c) => c.name.startsWith("shopify:"))).toHaveLength(0)
  })
})

describe("proforma.issue + proforma.create_and_issue", () => {
  test("proforma.issue is ALWAYS gated", async () => {
    const { ctx, extras } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "proforma",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const r = await proformaIssue(ctx, { draft_id })
    expect(r.status).toBe("pending_approval")
    expect(extras.approvalsRequested[0]!.tool_name).toBe("invoicing:proforma_issue")
    const detail = extras.approvalsRequested[0]!.summary_detail!
    expect(detail.lines).toContain("Line: Widget x 2 @ 50.00 EUR")
  })

  test("proforma.create_and_issue with reason+declared_value (killer agent path: success criterion #7)", async () => {
    // First entry: agent calls create_and_issue → returns pending_approval
    const { ctx: ctx1, extras: extras1 } = makeCtx()
    const r1 = await proformaCreateAndIssue(ctx1, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "Returned widget",
          quantity: "1",
          unit_price_minor: 5_000n,
          product_source: "shopify",
          external_id: "prod-1",
        },
      ],
      reason: "return",
      declared_value_minor: 5_000n,
    })
    expect(r1.status).toBe("pending_approval")
    expect(extras1.approvalsRequested[0]!.tool_name).toBe("invoicing:proforma_create_and_issue")
    // The title states the effect; the reason is its own labelled line (asserted below).
    expect(extras1.approvalsRequested[0]!.summary).toBe("Issue proforma for Buyer SARL, 60.00 EUR")
    const detail1 = extras1.approvalsRequested[0]!.summary_detail!
    expect(detail1.lines).toContain("Customer: Buyer SARL")
    expect(detail1.lines).toContain("Line: Returned widget x 1 @ 50.00 EUR")
    expect(detail1.lines).toContain("Reason: return")

    // Second entry: kernel re-invokes with ctx.approval populated → numbered PDF
    const {
      ctx: ctx2,
      db: db2,
      extras: extras2,
    } = makeCtx({
      approval: {
        approvalRequestId: "appr-pf-1",
        approvalDeciderId: "user-2",
        toolName: "invoicing:proforma_create_and_issue",
      },
    })
    const r2 = await proformaCreateAndIssue(ctx2, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "Returned widget",
          quantity: "1",
          unit_price_minor: 5_000n,
          product_source: "shopify",
          external_id: "prod-1",
        },
      ],
      reason: "return",
      declared_value_minor: 5_000n,
    })
    expect(r2.status).toBe("completed")
    if (r2.status !== "completed") throw new Error("unreachable")
    expect(r2.number).toMatch(/^PRO-/)
    const doc = db2.__all("documents").find((d) => d.id === r2.document_id)!
    expect(doc.type).toBe("proforma")
    const refs = doc.external_refs as { reason?: string; declared_value_minor?: string }
    expect(refs.reason).toBe("return")
    expect(refs.declared_value_minor).toBe("5000")
    // PDF file filed against contact (best-effort thread post inside issueDocument)
    expect(extras2.threadPosts).toHaveLength(1)
    expect(extras2.threadPosts[0]!.attachment_file_ids).toHaveLength(1)
  })
})

describe("po.issue + po.create_and_issue", () => {
  test("po.issue below po-threshold issues immediately (conditional gating)", async () => {
    // 2 × 5_000 = 10_000; po threshold 50_000 → below
    const { ctx, db } = makeCtx({ poThresholdMinor: 50_000n })
    const { draft_id } = await draftsCreate(ctx, {
      type: "purchase_order",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const r = await poIssue(ctx, { draft_id })
    expect(r.status).toBe("completed")
    expect(issuedDocs(db)[0]!.type).toBe("purchase_order")
  })

  test("po.issue above po-threshold returns pending_approval", async () => {
    const { ctx, db, extras } = makeCtx({ poThresholdMinor: 1_000n })
    const { draft_id } = await draftsCreate(ctx, {
      type: "purchase_order",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const r = await poIssue(ctx, { draft_id })
    expect(r.status).toBe("pending_approval")
    expect(issuedDocs(db)).toHaveLength(0)
    expect(extras.approvalsRequested[0]!.tool_name).toBe("invoicing:po_issue")
    const detail = extras.approvalsRequested[0]!.summary_detail!
    expect(detail.lines).toContain("Line: Widget x 2 @ 50.00 EUR")
  })

  test("po.create_and_issue with NO po threshold set → always parks an approval (security pass)", async () => {
    const { ctx, db } = makeCtx({ poThresholdMinor: null })
    const r = await poCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("pending_approval")
    expect(issuedDocs(db)).toHaveLength(0)
  })
})

describe("credit notes and purchase orders: an auto-approve policy approves them", () => {
  // The kernel answers `auto_approved: true` when the org's auto-approve policy for the tool
  // approves the call; the handler then issues at once. Without a policy it parks as before.
  function autoApproving(ctx: ReturnType<typeof makeCtx>["ctx"], flags: unknown[]) {
    ctx.requestApproval = async (input) => {
      flags.push(input.auto_approvable)
      return { approval_id: "appr-policy", auto_approved: true }
    }
  }
  const standaloneCn = {
    counterparty: defaultCounterparty,
    issuer_profile_id: "iss-1",
    currency: "EUR",
    operation_category: "goods" as const,
    items: [
      {
        position: 1,
        description: "x",
        quantity: "1",
        unit_price_minor: -100n,
        product_source: null,
        external_id: null,
      },
    ],
  }

  test("a standalone credit note is issued when the policy approves it, and its card keeps the warning", async () => {
    const parked = makeCtx()
    expect((await creditNoteCreateAndIssue(parked.ctx, standaloneCn)).status).toBe(
      "pending_approval",
    )
    expect(parked.extras.approvalsRequested[0]!.summary_detail!.lines).toContain(
      "WARNING: no original invoice referenced (standalone credit note)",
    )
    const flags: unknown[] = []
    const { ctx, db } = makeCtx()
    autoApproving(ctx, flags)
    const r = await creditNoteCreateAndIssue(ctx, standaloneCn)
    expect(flags).toEqual([true])
    expect(r.status).toBe("completed")
    expect(issuedDocs(db)).toHaveLength(1)
  })

  test("a purchase order is issued when the policy approves it", async () => {
    const flags: unknown[] = []
    const { ctx, db } = makeCtx({ poThresholdMinor: null })
    autoApproving(ctx, flags)
    const r = await poCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(flags).toEqual([true])
    expect(r.status).toBe("completed")
    expect(issuedDocs(db)).toHaveLength(1)
  })

  test("quotes stay with a person: they never offer the policy the call", async () => {
    const flags: unknown[] = []
    const { ctx } = makeCtx({ issuerThresholdMinor: 5_000n })
    ctx.requestApproval = async (input) => {
      flags.push(input.auto_approvable)
      return { approval_id: "appr-1" }
    }
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("pending_approval")
    expect(flags).toEqual([false])
  })
})

describe("credit_note.create_and_issue + credit_note.issue", () => {
  test("a credit note with NO invoice threshold set parks an approval, and a standalone one parks even under a huge threshold", async () => {
    const none = makeCtx({ issuerThresholdMinor: null })
    const input = {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      operation_category: "goods" as const,
      items: [
        {
          position: 1,
          description: "x",
          quantity: "1",
          unit_price_minor: -100n,
          product_source: null,
          external_id: null,
        },
      ],
    }
    expect((await creditNoteCreateAndIssue(none.ctx, input)).status).toBe("pending_approval")
    const huge = makeCtx()
    const r = await creditNoteCreateAndIssue(huge.ctx, input)
    expect(r.status).toBe("pending_approval")
    expect(huge.extras.approvalsRequested[0]!.summary_detail!.lines).toContain(
      "WARNING: no original invoice referenced (standalone credit note)",
    )
  })

  test("issues straight to 'issued' status with its own CN- number series, negative lines accepted", async () => {
    const { ctx, db } = makeCtx({ approval: PRE_APPROVED })
    const r = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "Widget (return)",
          quantity: "1",
          unit_price_minor: -5_000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.number).toMatch(/^CN-/)
    const doc = db.__all("documents").find((d) => d.id === r.document_id)!
    expect(doc.type).toBe("credit_note")
    expect(doc.status).toBe("issued")
    // Negative subtotal → negative tax (20% FR domestic rate) → negative grand total.
    expect(doc.subtotal_minor).toBe("-5000")
    expect(doc.tax_total_minor).toBe("-1000")
    expect(doc.grand_total_minor).toBe("-6000")
    // Never payable: no due date persisted.
    expect(doc.due_at).toBeNull()
  })

  test("credit note number series is independent of the invoice series", async () => {
    const { ctx } = makeCtx({ approval: PRE_APPROVED })
    const inv1 = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const inv2 = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(inv1.status).toBe("completed")
    expect(inv2.status).toBe("completed")
    if (inv1.status !== "completed" || inv2.status !== "completed") throw new Error("unreachable")
    expect(inv1.number.endsWith("-0001")).toBe(true)
    expect(inv2.number.endsWith("-0002")).toBe(true)
    const cn = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "x",
          quantity: "1",
          unit_price_minor: -1000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(cn.status).toBe("completed")
    if (cn.status !== "completed") throw new Error("unreachable")
    // The credit note series starts fresh at 0001 — unaffected by the two invoices already issued.
    expect(cn.number.endsWith("-0001")).toBe(true)
    expect(cn.number.startsWith("CN-")).toBe(true)
  })

  test("original_document_id must reference an existing invoice — rejects a missing id", async () => {
    const { ctx } = makeCtx()
    const r = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
      original_document_id: "does-not-exist",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("not_found")
  })

  test("original_document_id must reference a type='invoice' document — rejects a purchase order", async () => {
    // Quotes AND proformas are always approval-gated by design (never return
    // "completed" directly) — a purchase order is the ungated non-invoice type.
    const { ctx, db } = makeCtx({ issuerThresholdMinor: null })
    const quote = await poCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(quote.status).toBe("completed")
    if (quote.status !== "completed") throw new Error("unreachable")
    const r = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
      original_document_id: quote.document_id,
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("invalid_original_document")
    void db
  })

  test("valid original_document_id appends a credit_note_issued lifecycle entry to the ORIGINAL invoice", async () => {
    const { ctx, db } = makeCtx()
    const inv = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(inv.status).toBe("completed")
    if (inv.status !== "completed") throw new Error("unreachable")
    const cn = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "x",
          quantity: "1",
          unit_price_minor: -5000n,
          product_source: null,
          external_id: null,
        },
      ],
      original_document_id: inv.document_id,
      reason: "return",
    })
    expect(cn.status).toBe("completed")
    if (cn.status !== "completed") throw new Error("unreachable")
    const originalDoc = db.__all("documents").find((d) => d.id === inv.document_id)!
    const log = originalDoc.lifecycle_log as Array<Record<string, unknown>>
    const entry = log.find((e) => e.event === "credit_note_issued")
    expect(entry).toBeDefined()
    expect(entry?.credit_note_id).toBe(cn.document_id)
    expect(entry?.number).toBe(cn.number)
    // external_refs carries the reversal linkage + reason.
    const cnDoc = db.__all("documents").find((d) => d.id === cn.document_id)!
    const refs = cnDoc.external_refs as { original_document_id?: string; reason?: string }
    expect(refs.original_document_id).toBe(inv.document_id)
    expect(refs.reason).toBe("return")
  })

  test("emits document:issued for the credit note and document:credited for the original invoice", async () => {
    const { ctx, db, extras } = makeCtx()
    const inv = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(inv.status).toBe("completed")
    if (inv.status !== "completed") throw new Error("unreachable")
    extras.emittedAttention.length = 0
    const cn = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "x",
          quantity: "1",
          unit_price_minor: -5000n,
          product_source: null,
          external_id: null,
        },
      ],
      original_document_id: inv.document_id,
      reason: "return",
    })
    expect(cn.status).toBe("completed")
    if (cn.status !== "completed") throw new Error("unreachable")
    const issuedEvt = extras.emittedAttention.find(
      (e) => e.action === "issued" && e.entityId === cn.document_id,
    )
    expect(issuedEvt).toBeDefined()
    expect(issuedEvt?.data).toMatchObject({ type: "credit_note", number: cn.number })
    const original = db.__all("documents").find((d) => d.id === inv.document_id)!
    const creditedEvt = extras.emittedAttention.find((e) => e.action === "credited")
    expect(creditedEvt?.entity).toBe("document")
    expect(creditedEvt?.entityId).toBe(inv.document_id)
    expect(creditedEvt?.data).toMatchObject({
      document_id: inv.document_id,
      type: "invoice",
      number: inv.number,
      status: original.status,
      currency: "EUR",
      credit_note_id: cn.document_id,
      original_document_id: inv.document_id,
    })
  })

  test("approval gating compares ABS(grand_total) against invoice_approval_threshold_minor", async () => {
    // -6000 grand total; threshold 5000 → |−6000| > 5000 → must gate.
    const { ctx, extras } = makeCtx({ issuerThresholdMinor: 5_000n })
    const r = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "x",
          quantity: "1",
          unit_price_minor: -5000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(r.status).toBe("pending_approval")
    expect(extras.approvalsRequested[0]!.tool_name).toBe("invoicing:credit_note_create_and_issue")
    const detail = extras.approvalsRequested[0]!.summary_detail!
    expect(extras.approvalsRequested[0]!.summary).toContain("Buyer SARL")
    expect(detail.lines).toContain("Line: x x 1 @ -50.00 EUR")
  })

  test("approval gating: below-threshold ABS total issues immediately", async () => {
    const { ctx, db } = makeCtx({ approval: PRE_APPROVED, issuerThresholdMinor: 100_000n })
    const r = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "x",
          quantity: "1",
          unit_price_minor: -5000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(r.status).toBe("completed")
    expect(issuedDocs(db).filter((d) => d.type === "credit_note")).toHaveLength(1)
  })

  test("credit_note_issue mirrors credit_note_create_and_issue via a draft, and is excluded from PO/invoice draft type checks", async () => {
    const { ctx, db } = makeCtx({ approval: PRE_APPROVED })
    const { draft_id } = await draftsCreate(ctx, {
      type: "credit_note",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "x",
          quantity: "1",
          unit_price_minor: -2000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    const r = await creditNoteIssue(ctx, { draft_id })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    const doc = db.__all("documents").find((d) => d.id === r.document_id)!
    expect(doc.type).toBe("credit_note")
    expect(doc.status).toBe("issued")
  })

  test("credit_note_issue rejects a draft of the wrong type", async () => {
    const { ctx } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const r = await creditNoteIssue(ctx, { draft_id })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("invalid_type")
  })

  test("credit_note_issue above threshold returns pending_approval with rich summary_detail", async () => {
    // FR domestic 20% VAT: -5000 * 1.2 = -6000 grand; threshold 5000 -> |−6000| > 5000 -> must gate.
    const { ctx, extras } = makeCtx({ issuerThresholdMinor: 5_000n })
    const { draft_id } = await draftsCreate(ctx, {
      type: "credit_note",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "x",
          quantity: "1",
          unit_price_minor: -5000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    const r = await creditNoteIssue(ctx, { draft_id })
    expect(r.status).toBe("pending_approval")
    expect(extras.approvalsRequested[0]!.tool_name).toBe("invoicing:credit_note_issue")
    const detail = extras.approvalsRequested[0]!.summary_detail!
    expect(detail.lines).toContain("Line: x x 1 @ -50.00 EUR")
    expect(detail.lines).toContain("Total: -60.00 EUR")
  })

  test("refuses a credit note that would exceed the invoice's own total (over credit)", async () => {
    const { ctx, db } = makeCtx()
    const inv = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(inv.status).toBe("completed")
    if (inv.status !== "completed") throw new Error("unreachable")
    const invoiceDoc = db.__all("documents").find((d) => d.id === inv.document_id)!
    expect(invoiceDoc.grand_total_minor).toBe("12000")

    // First credit note: -4000 net, 20% FR domestic VAT -> -4800 gross (48.00 EUR). Well
    // within the invoice's 12000 (120.00 EUR) total; leaves 72.00 EUR remaining.
    const first = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "partial return",
          quantity: "1",
          unit_price_minor: -4000n,
          product_source: null,
          external_id: null,
        },
      ],
      original_document_id: inv.document_id,
    })
    expect(first.status).toBe("completed")

    // Second credit note: -7000 net -> -8400 gross (84.00 EUR). 48.00 EUR already credited
    // plus 84.00 EUR requested = 132.00 EUR, which exceeds the invoice's own 120.00 EUR total.
    const second = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "second return",
          quantity: "1",
          unit_price_minor: -7000n,
          product_source: null,
          external_id: null,
        },
      ],
      original_document_id: inv.document_id,
    })
    expect(second.status).toBe("error")
    if (second.status !== "error") throw new Error("unreachable")
    expect(second.error.code).toBe("over_credit")
    expect(second.error.message).toContain(inv.number)
    expect(second.error.message).toContain("48.00 EUR already credited")
    expect(second.error.message).toContain("72.00 EUR remaining")
    expect(second.error.message).toContain("120.00 EUR") // invoice total

    // No second credit note was persisted.
    const creditNotes = db.__all("documents").filter((d) => d.type === "credit_note")
    expect(creditNotes).toHaveLength(1)
  })

  test("a credit note landing exactly on the invoice's remaining balance is allowed", async () => {
    const { ctx, db } = makeCtx()
    const inv = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(inv.status).toBe("completed")
    if (inv.status !== "completed") throw new Error("unreachable")

    // Full reversal, exactly the invoice's own total (-10000 net -> -12000 gross).
    const cn = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "full return",
          quantity: "1",
          unit_price_minor: -10000n,
          product_source: null,
          external_id: null,
        },
      ],
      original_document_id: inv.document_id,
    })
    expect(cn.status).toBe("completed")
    const creditNotes = db.__all("documents").filter((d) => d.type === "credit_note")
    expect(creditNotes).toHaveLength(1)
  })

  describe("original link column and regime inheritance", () => {
    const cnItems = [
      {
        position: 1,
        description: "return",
        quantity: "1",
        unit_price_minor: -1000n,
        product_source: null,
        external_id: null,
      },
    ]
    async function issueOriginal(ctx: ReturnType<typeof makeCtx>["ctx"]) {
      const inv = await invoiceCreateAndIssue(ctx, {
        operation_category: "goods",
        counterparty: defaultCounterparty,
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: sampleDraftItems,
      })
      if (inv.status !== "completed") throw new Error("unreachable")
      return inv
    }

    test("persists original_document_id as a column and keeps it in external_refs", async () => {
      const { ctx, db } = makeCtx()
      const inv = await issueOriginal(ctx)
      const cn = await creditNoteCreateAndIssue(ctx, {
        operation_category: "goods",
        counterparty: defaultCounterparty,
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: cnItems,
        original_document_id: inv.number,
      })
      if (cn.status !== "completed") throw new Error("unreachable")
      const doc = db.__all("documents").find((d) => d.id === cn.document_id)!
      expect(doc.original_document_id).toBe(inv.document_id)
      expect((doc.external_refs as Record<string, unknown>).original_document_id).toBe(
        inv.document_id,
      )
    })

    test("credit_note_issue (draft path) persists the column too", async () => {
      const { ctx, db } = makeCtx()
      const inv = await issueOriginal(ctx)
      const { draft_id } = await draftsCreate(ctx, {
        type: "credit_note",
        ...BUYER_DRAFT_EINVOICE,
        counterparty_contact_id: "contact-1",
        counterparty_name: "Buyer SARL",
        counterparty_address: "1 rue Buyer, 75002 Paris",
        counterparty_email: "ap@buyersarl.example",
        counterparty_country: "FR",
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: cnItems,
      })
      // The editor stores the back-link on the draft's external_refs.
      await db.update("documents", draft_id, {
        external_refs: { original_document_id: inv.document_id },
      })
      const r = await creditNoteIssue(ctx, { draft_id })
      if (r.status !== "completed") throw new Error("unreachable")
      const doc = db.__all("documents").find((d) => d.id === r.document_id)!
      expect(doc.original_document_id).toBe(inv.document_id)
    })

    test("a credit note takes its original's stored regime, not internal_cancellation, when accepted", async () => {
      const { ctx, db } = makeCtx()
      const inv = await issueOriginal(ctx)
      const orig = db.__all("documents").find((d) => d.id === inv.document_id)!
      orig.regime = "e_invoice"
      orig.einvoice_state = "accepted"
      const cn = await creditNoteCreateAndIssue(ctx, {
        operation_category: "goods",
        counterparty: defaultCounterparty,
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: cnItems,
        original_document_id: inv.document_id,
      })
      if (cn.status !== "completed") throw new Error("unreachable")
      const doc = db.__all("documents").find((d) => d.id === cn.document_id)!
      expect(doc.regime).toBe("e_invoice")
      expect(doc.internal_cancellation).toBe(false)
    })

    for (const state of ["refused", "rejected"]) {
      test(`a credit note against a ${state} original is an internal_cancellation and keeps the original's regime`, async () => {
        const { ctx, db } = makeCtx()
        const inv = await issueOriginal(ctx)
        const orig = db.__all("documents").find((d) => d.id === inv.document_id)!
        orig.regime = "e_invoice"
        orig.einvoice_state = state
        const cn = await creditNoteCreateAndIssue(ctx, {
          operation_category: "goods",
          counterparty: defaultCounterparty,
          issuer_profile_id: "iss-1",
          currency: "EUR",
          items: cnItems,
          original_document_id: inv.document_id,
        })
        if (cn.status !== "completed") throw new Error("unreachable")
        const doc = db.__all("documents").find((d) => d.id === cn.document_id)!
        expect(doc.regime).toBe("e_invoice")
        expect(doc.internal_cancellation).toBe(true)
        const codes = (doc.regime_reasons as Array<{ code: string }>).map((r) => r.code)
        expect(codes).toContain("internal_cancellation")
      })
    }

    test("a credit note against a legacy original (no stored regime) is classified from the current data", async () => {
      const { ctx, db } = makeCtx()
      const inv = await issueOriginal(ctx)
      // An original issued before regimes were recorded: no regime, no snapshot.
      await db.update("documents", inv.document_id, {
        regime: null,
        regime_reasons: null,
        customer_kind: null,
        buyer_siren: null,
      })
      const cn = await creditNoteCreateAndIssue(ctx, {
        operation_category: "goods",
        counterparty: defaultCounterparty,
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: cnItems,
        original_document_id: inv.document_id,
      })
      if (cn.status !== "completed") throw new Error("unreachable")
      const doc = db.__all("documents").find((d) => d.id === cn.document_id)!
      expect(doc.original_document_id).toBe(inv.document_id)
      // Classified from the credit note's own buyer data (a confirmed French business), never
      // "follows the original" since the original recorded nothing.
      expect(doc.regime).toBe("e_invoice")
      const codes = (doc.regime_reasons as Array<{ code: string }>).map((r) => r.code)
      expect(codes).toContain("fr_business_with_siren")
      expect(codes).not.toContain("credit_note_follows_original")
      expect(doc.buyer_siren).toBe(BUYER_SIREN)
      expect(doc.internal_cancellation).toBe(false)
    })

    test("credit_note_create_and_issue passes the original's issue date to the PDF template", async () => {
      const { ctx, extras } = makeCtx()
      const inv = await issueOriginal(ctx)
      await creditNoteCreateAndIssue(ctx, {
        operation_category: "goods",
        counterparty: defaultCounterparty,
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: cnItems,
        original_document_id: inv.document_id,
      })
      const last = extras.renderCalls[extras.renderCalls.length - 1]!
      const renderDoc = (last.data as { document: Record<string, unknown> }).document
      expect(renderDoc.type).toBe("credit_note")
      expect(typeof renderDoc.original_invoice_date).toBe("string")
    })

    test("a re-rendered credit note keeps the original's number and date on the PDF", async () => {
      const { ctx, db, extras } = makeCtx()
      const inv = await issueOriginal(ctx)
      const cn = await creditNoteCreateAndIssue(ctx, {
        operation_category: "goods",
        counterparty: defaultCounterparty,
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: cnItems,
        original_document_id: inv.document_id,
        reason: "Returned goods",
      })
      if (cn.status !== "completed") throw new Error("unreachable")
      const original = db.__all("documents").find((d) => d.id === inv.document_id)!
      const issueRender = extras.renderCalls[extras.renderCalls.length - 1]!
      const issueDoc = (issueRender.data as { document: Record<string, unknown> }).document
      extras.renderCalls.length = 0
      const r = await documentsRetryPdf(ctx, { id: cn.document_id })
      expect(r.status).toBe("completed")
      expect(extras.renderCalls).toHaveLength(1)
      const renderDoc = (extras.renderCalls[0]!.data as { document: Record<string, unknown> })
        .document
      expect(renderDoc.original_invoice_number).toBe(original.number)
      expect(renderDoc.original_invoice_date).toBe(String(original.issued_at).slice(0, 10))
      expect(renderDoc.original_invoice_number).toBe(issueDoc.original_invoice_number)
      expect(renderDoc.original_invoice_date).toBe(issueDoc.original_invoice_date)
      expect(renderDoc.reason).toBe(issueDoc.reason)
    })
  })
})

// ── order_reissue_apply — operator-approved order-edit reissue ────────────

describe("orderReissueApply", () => {
  test("states no date, so an original dated after today still gets its credit note", async () => {
    const { ctx, db } = makeCtx()
    const original = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-10",
      shopify_order_number: "#1010",
      items: sampleDraftItems,
    })
    if (original.status !== "completed") throw new Error("unreachable")
    db.__all("documents").find((d) => d.id === original.document_id)!.issued_at =
      "2099-01-01T00:00:00.000Z"
    const result = await orderReissueApply(ctx, {
      original_document_id: original.document_id,
      shopify_order_id: "shop-order-10",
      shopify_order_number: "#1010",
      billing_signature: "sig-d",
      dedupe_key: "shop-order-10:sig-d",
      items: [
        {
          description: "Widget",
          quantity: "1",
          unit_price_minor: 5_000,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(result.status).toBe("completed")
  })

  test("reissue after a refused original books an internal cancellation and issues the replacement under a new number", async () => {
    const { ctx, db } = makeCtx()
    const original = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-9",
      shopify_order_number: "#1009",
      items: sampleDraftItems,
    })
    if (original.status !== "completed") throw new Error("unreachable")
    const origDoc = db.__all("documents").find((d) => d.id === original.document_id)!
    origDoc.regime = "e_invoice"
    origDoc.einvoice_state = "refused"
    const result = await orderReissueApply(ctx, {
      original_document_id: original.document_id,
      shopify_order_id: "shop-order-9",
      shopify_order_number: "#1009",
      billing_signature: "sig-r",
      dedupe_key: "shop-order-9:sig-r",
      items: [
        {
          description: "Widget",
          quantity: "1",
          unit_price_minor: 5_000,
          product_source: null,
          external_id: null,
        },
      ],
    })
    if (result.status !== "completed") throw new Error("unreachable")
    const cn = db.__all("documents").find((d) => d.id === result.credit_note_document_id)!
    expect(cn.original_document_id).toBe(original.document_id)
    expect(cn.internal_cancellation).toBe(true)
    expect(cn.regime).toBe("e_invoice")
    const replacement = db.__all("documents").find((d) => d.id === result.replacement_document_id)!
    expect(replacement.number).not.toBe(original.number)
    expect(replacement.number_int).not.toBe(origDoc.number_int)
  })

  test("issues a credit note and a replacement invoice, linked, carrying the updated items", async () => {
    const { ctx, db } = makeCtx()
    const original = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-1",
      shopify_order_number: "#1001",
      items: sampleDraftItems, // 2 x Widget @ 50.00 -> 100.00 + 20% VAT = 120.00
    })
    expect(original.status).toBe("completed")
    if (original.status !== "completed") throw new Error("unreachable")

    const result = await orderReissueApply(ctx, {
      original_document_id: original.document_id,
      shopify_order_id: "shop-order-1",
      shopify_order_number: "#1001",
      billing_signature: "sig-2",
      dedupe_key: "shop-order-1:sig-2",
      items: [
        {
          description: "Widget",
          quantity: "3",
          unit_price_minor: 6_000,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(result.status).toBe("completed")
    if (result.status !== "completed") throw new Error("unreachable")

    // Credit note fully reverses the original and links back to it.
    const creditNote = db.__all("documents").find((d) => d.id === result.credit_note_document_id)!
    expect(creditNote.type).toBe("credit_note")
    expect(String(creditNote.grand_total_minor)).toBe("-12000")
    const cnRefs = creditNote.external_refs as { original_document_id?: string }
    expect(cnRefs.original_document_id).toBe(original.document_id)

    // Replacement invoice carries the NEW items/amounts and links to the original.
    const replacement = db.__all("documents").find((d) => d.id === result.replacement_document_id)!
    expect(replacement.type).toBe("invoice")
    expect(String(replacement.grand_total_minor)).toBe("21600") // 3 x 60.00 = 180.00 + 20% VAT
    const invRefs = replacement.external_refs as {
      original_document_id?: string
      original_document_number?: string
    }
    expect(invRefs.original_document_id).toBe(original.document_id)
    expect(invRefs.original_document_number).toBe(original.number)

    const replacementLines = db
      .__all("document_lines")
      .filter((l) => l.document_id === result.replacement_document_id)
    expect(replacementLines).toHaveLength(1)
    expect(replacementLines[0]!.description).toBe("Widget")
    expect(replacementLines[0]!.quantity).toBe("3")

    // The original invoice is not itself financially rewritten -- only its
    // lifecycle_log gains the reversal entry (same as any other credit note).
    const originalDoc = db.__all("documents").find((d) => d.id === original.document_id)!
    expect(
      (originalDoc.lifecycle_log as Array<Record<string, unknown>>).some(
        (e) => e.event === "credit_note_issued",
      ),
    ).toBe(true)
  })

  // red: drop the po_number thread-through in orderReissueApply (both the explicit
  // invoiceCreateAndIssue input and the follow-up external_refs copy) -> the
  // replacement invoice and its credit note lose the customer's PO reference on
  // an order edit, even though the original invoice carried one.
  test("carries the PO number forward to BOTH the credit note and the replacement invoice", async () => {
    const { ctx, db } = makeCtx()
    const original = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-po1",
      shopify_order_number: "#1001",
      po_number: "PO-4471",
      items: sampleDraftItems,
    })
    expect(original.status).toBe("completed")
    if (original.status !== "completed") throw new Error("unreachable")
    const originalDoc = db.__all("documents").find((d) => d.id === original.document_id)!
    expect(originalDoc.po_number).toBe("PO-4471")

    const result = await orderReissueApply(ctx, {
      original_document_id: original.document_id,
      shopify_order_id: "shop-order-po1",
      shopify_order_number: "#1001",
      billing_signature: "sig-po1",
      dedupe_key: "shop-order-po1:sig-po1",
      items: [
        {
          description: "Widget",
          quantity: "3",
          unit_price_minor: 6_000,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(result.status).toBe("completed")
    if (result.status !== "completed") throw new Error("unreachable")

    const creditNote = db.__all("documents").find((d) => d.id === result.credit_note_document_id)!
    expect(creditNote.po_number).toBe("PO-4471")
    const cnRefs = creditNote.external_refs as { po_number?: string }
    expect(cnRefs.po_number).toBe("PO-4471")

    const replacement = db.__all("documents").find((d) => d.id === result.replacement_document_id)!
    expect(replacement.po_number).toBe("PO-4471")
    const invRefs = replacement.external_refs as { po_number?: string }
    expect(invRefs.po_number).toBe("PO-4471")
  })

  test("reuses the inner threshold gate without a nested approval when ctx.approval is already set", async () => {
    // Both invoice and credit note issuance would normally park their OWN
    // approval above this threshold -- but this call simulates the kernel's
    // post-approval re-entry (ctx.approval populated for order_reissue_apply
    // itself), so their internal `!ctx.approval` checks must skip straight
    // to issuing instead of requesting a second, nested approval.
    const { ctx, db, extras } = makeCtx({ issuerThresholdMinor: 100n })
    const original = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-2",
      items: sampleDraftItems,
    })
    // Above-threshold create parks its OWN approval first (expected, unrelated
    // to order_reissue_apply) -- re-run it as the post-approval re-entry so a
    // real original document exists to reissue.
    expect(original.status).toBe("pending_approval")
    extras.approvalsRequested.length = 0
    const ctxApproved: MutationsCtx = {
      ...ctx,
      approval: {
        approvalRequestId: "appr-seed",
        approvalDeciderId: "user-2",
        toolName: "invoicing:invoice_create_and_issue",
      },
    }
    const seeded = await invoiceCreateAndIssue(ctxApproved, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-2",
      items: sampleDraftItems,
    })
    expect(seeded.status).toBe("completed")
    if (seeded.status !== "completed") throw new Error("unreachable")
    extras.approvalsRequested.length = 0

    const result = await orderReissueApply(ctxApproved, {
      original_document_id: seeded.document_id,
      shopify_order_id: "shop-order-2",
      billing_signature: "sig-3",
      dedupe_key: "shop-order-2:sig-3",
      items: sampleDraftItems,
    })
    expect(result.status).toBe("completed")
    // Neither the credit note nor the replacement invoice parked a nested approval.
    expect(extras.approvalsRequested).toHaveLength(0)
    if (result.status !== "completed") throw new Error("unreachable")
    expect(db.__all("documents").find((d) => d.id === result.credit_note_document_id)).toBeDefined()
    expect(db.__all("documents").find((d) => d.id === result.replacement_document_id)).toBeDefined()
  })

  test("the replacement invoice issues unpaid while the original keeps its recorded payment", async () => {
    const { ctx, db } = makeCtx()
    const original = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-3",
      items: sampleDraftItems,
    })
    expect(original.status).toBe("completed")
    if (original.status !== "completed") throw new Error("unreachable")
    // Simulate a payment already recorded against the original (documents_mark_paid).
    await db.update("documents", original.document_id, { payment_status: "paid" })

    const result = await orderReissueApply(ctx, {
      original_document_id: original.document_id,
      shopify_order_id: "shop-order-3",
      billing_signature: "sig-4",
      dedupe_key: "shop-order-3:sig-4",
      items: sampleDraftItems,
    })
    expect(result.status).toBe("completed")
    if (result.status !== "completed") throw new Error("unreachable")

    const originalDoc = db.__all("documents").find((d) => d.id === original.document_id)!
    expect(originalDoc.payment_status).toBe("paid")
    const replacement = db.__all("documents").find((d) => d.id === result.replacement_document_id)!
    // issueDocument never sets payment_status on a normal (non-settlement) issuance,
    // so the column keeps the production "unpaid" DB default -- it is never "paid".
    expect(replacement.payment_status).not.toBe("paid")
  })

  test("a replacement the order cannot take refuses the reissue before anything is written", async () => {
    const { ctx, db } = makeCtx()
    const original = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-4",
      items: sampleDraftItems,
    })
    expect(original.status).toBe("completed")
    if (original.status !== "completed") throw new Error("unreachable")

    // A decoy SECOND live invoice for the SAME Shopify order, not credited: the replacement's
    // one-invoice-per-order guard refuses it.
    await db.insert("documents", {
      type: "invoice",
      status: "issued",
      currency: "EUR",
      issuer_profile_id: "iss-1",
      shopify_order_id: "shop-order-4",
      number: "INV-2026-DECOY",
      grand_total_minor: "5000",
      lifecycle_log: [],
      counterparty_name: "Buyer SARL",
      counterparty_country: "FR",
    })
    const before = db.__all("documents").length
    const originalLog = structuredClone(
      db.__all("documents").find((d) => d.id === original.document_id)!.lifecycle_log,
    )

    const result = await orderReissueApply(ctx, {
      original_document_id: original.document_id,
      shopify_order_id: "shop-order-4",
      billing_signature: "sig-5",
      dedupe_key: "shop-order-4:sig-5",
      items: sampleDraftItems,
    })

    // Both documents are checked before either is written, and they commit together: no credit
    // note without its replacement, and the original keeps its log.
    expect(result.status).toBe("error")
    if (result.status !== "error") throw new Error("unreachable")
    expect(result.error.code).toBe("already_invoiced")
    expect(db.__all("documents")).toHaveLength(before)
    expect(db.__all("documents").filter((d) => d.type === "credit_note")).toHaveLength(0)
    expect(db.__all("documents").find((d) => d.id === original.document_id)!.lifecycle_log).toEqual(
      originalLog,
    )
  })

  test("a write that fails in the shared commit leaves neither document and uses no number", async () => {
    const { ctx, db } = makeCtx()
    const original = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-8",
      items: sampleDraftItems,
    })
    expect(original.status).toBe("completed")
    if (original.status !== "completed") throw new Error("unreachable")
    const before = db.__all("documents").length
    const sequencesBefore = new Map(db.__sequences)

    // The replacement's lines fail to insert: the batch carrying both documents undoes itself.
    const insert = db.insert.bind(db)
    let failed = false
    db.insert = (async (entity: string, data: Record<string, unknown>) => {
      if (entity === "document_lines" && !failed && db.__all("documents").length > before + 1) {
        failed = true
        throw new Error("line insert failed")
      }
      return insert(entity, data)
    }) as typeof db.insert

    await expect(
      orderReissueApply(ctx, {
        original_document_id: original.document_id,
        shopify_order_id: "shop-order-8",
        billing_signature: "sig-8",
        dedupe_key: "shop-order-8:sig-8",
        items: sampleDraftItems,
      }),
    ).rejects.toThrow(/line insert failed/)
    expect(failed).toBe(true)
    expect(db.__all("documents")).toHaveLength(before)
    expect(db.__sequences).toEqual(sequencesBefore)
  })

  test("a reissue approved after a newer order edit refuses and issues nothing", async () => {
    const { ctx, db } = makeCtx()
    const original = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-6",
      shopify_order_number: "#1006",
      items: sampleDraftItems,
    })
    expect(original.status).toBe("completed")
    if (original.status !== "completed") throw new Error("unreachable")

    // The approval was raised for signature A -- onShopifyOrderUpdated would
    // have stamped this at the time. Then the order is edited AGAIN before a
    // human approves, and onShopifyOrderUpdated advances the SAME field to
    // signature B, leaving the pending approval for A stale.
    await db.update("documents", original.document_id, {
      external_refs: { downstream_order_sig: "sig-A" },
    })
    await db.update("documents", original.document_id, {
      external_refs: { downstream_order_sig: "sig-B" },
    })

    const beforeCount = db.__all("documents").length

    const result = await orderReissueApply(ctx, {
      original_document_id: original.document_id,
      shopify_order_id: "shop-order-6",
      shopify_order_number: "#1006",
      billing_signature: "sig-A",
      dedupe_key: "shop-order-6:sig-A",
      items: sampleDraftItems,
    })

    expect(result.status).toBe("error")
    if (result.status !== "error") throw new Error("unreachable")
    expect(result.error.code).toBe("stale_reissue_approval")
    expect(result.error.message).toMatch(
      /newer edit to this order exists and a fresh approval is needed/,
    )

    // Nothing new was issued: no credit note, no replacement invoice.
    expect(db.__all("documents")).toHaveLength(beforeCount)
    expect(db.__all("documents").filter((d) => d.type === "credit_note")).toHaveLength(0)
  })

  test("a reissue approved while still current issues both documents", async () => {
    const { ctx, db } = makeCtx()
    const original = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-7",
      shopify_order_number: "#1007",
      items: sampleDraftItems,
    })
    expect(original.status).toBe("completed")
    if (original.status !== "completed") throw new Error("unreachable")

    // onShopifyOrderUpdated stamped the same signature the approval was
    // raised for -- no later edit happened, so the approval is still current.
    await db.update("documents", original.document_id, {
      external_refs: { downstream_order_sig: "sig-C" },
    })

    const result = await orderReissueApply(ctx, {
      original_document_id: original.document_id,
      shopify_order_id: "shop-order-7",
      shopify_order_number: "#1007",
      billing_signature: "sig-C",
      dedupe_key: "shop-order-7:sig-C",
      items: sampleDraftItems,
    })

    expect(result.status).toBe("completed")
    if (result.status !== "completed") throw new Error("unreachable")
    expect(db.__all("documents").find((d) => d.id === result.credit_note_document_id)).toBeDefined()
    expect(db.__all("documents").find((d) => d.id === result.replacement_document_id)).toBeDefined()
  })
})

// ── E8 — HS-codes / contact relationships / customs overlay ───────────────

function makeE8Ctx(opts?: {
  actorUserId?: string
  seedOverlay?: ProductCustomsOverlayRow[]
  seedRelationships?: ContactRelationshipRow[]
}): { ctx: MutationsCtx; db: MockDb; extras: MockExtras } {
  const seed: Record<string, Array<Record<string, unknown>>> = {}
  if (opts?.seedOverlay) {
    seed.product_customs_overlay = opts.seedOverlay.map((r) => ({ ...r }))
  }
  if (opts?.seedRelationships) {
    seed.contact_relationships = opts.seedRelationships.map((r) => ({ ...r }))
  }
  return makeCtx({ actorUserId: opts?.actorUserId, seed })
}

describe("hs_codes.assign", () => {
  test("writes overlay + bumps library last_used_at", async () => {
    const { ctx, db } = makeE8Ctx()
    const r = await hsCodesAssign(ctx, {
      product_source: "shopify",
      external_id: "prod-1",
      hs_code: "950300",
      country_of_origin: "FR",
      customs_description: "Toy widget",
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.overlay.hs_code).toBe("950300")
    const lib = db.__all("hs_code_library").find((l) => l.code === "950300")
    expect(lib).toBeDefined()
    expect(lib!.last_used_at).toBeTruthy()
  })

  test("invalid hs_code format rejected", async () => {
    const { ctx } = makeE8Ctx()
    const r = await hsCodesAssign(ctx, {
      product_source: "shopify",
      external_id: "prod-1",
      hs_code: "abc",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("invalid_hs_code")
  })

  test("missing product_source rejected", async () => {
    const { ctx } = makeE8Ctx()
    const r = await hsCodesAssign(ctx, {
      product_source: "",
      external_id: "prod-1",
      hs_code: "950300",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("invalid_input")
  })

  test("assign normalises a dotted HS code before storing", async () => {
    const { ctx, db } = makeE8Ctx()
    const r = await hsCodesAssign(ctx, {
      product_source: "shopify",
      external_id: "prod-1",
      hs_code: "9207.90",
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.overlay.hs_code).toBe("920790")
    const overlayRow = db.__all("product_customs_overlay").find((o) => o.external_id === "prod-1")
    expect(overlayRow?.hs_code).toBe("920790")
    const lib = db.__all("hs_code_library").find((l) => l.code === "920790")
    expect(lib).toBeDefined()
  })

  test("assigning a dotted code where a legacy row exists updates that row instead of duplicating", async () => {
    // A legacy row stored BEFORE normalisation existed, still in dotted format.
    const { ctx, db } = makeCtx({
      seed: {
        hs_code_library: [
          {
            id: "lib-legacy-1",
            code: "9207.90",
            description: "Pianos (legacy)",
            last_used_at: null,
          },
        ],
      },
    })
    const r = await hsCodesAssign(ctx, {
      product_source: "shopify",
      external_id: "prod-piano",
      hs_code: "9207.90",
      customs_description: "Upright piano",
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.overlay.hs_code).toBe("920790")
    // Assigning a dotted code where a legacy row already exists (in ANY format) must UPDATE
    // that row, never insert a second one -- exactly one library row for this HS code afterwards.
    const matching = db
      .__all("hs_code_library")
      .filter((l) => String(l.code).replace(/[^0-9]/g, "") === "920790")
    expect(matching).toHaveLength(1)
    expect(matching[0]!.id).toBe("lib-legacy-1")
    expect(matching[0]!.last_used_at).toBeTruthy()
  })
})

describe("hs_codes_library.upsert / delete", () => {
  test("the library never stores the same code in two formats", async () => {
    const { ctx, db } = makeE8Ctx()
    const first = await hsCodesLibraryUpsert(ctx, { code: "9207.90", description: "Pianos" })
    expect(first.status).toBe("completed")
    const second = await hsCodesLibraryUpsert(ctx, { code: "920790" })
    expect(second.status).toBe("completed")
    const rows = db.__all("hs_code_library").filter((l) => l.code === "920790")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.description).toBe("Pianos")
  })

  test("library upsert updates the description of an existing entry", async () => {
    const { ctx, db } = makeE8Ctx()
    await hsCodesLibraryUpsert(ctx, { code: "950300", description: "Toys" })
    const r = await hsCodesLibraryUpsert(ctx, { code: "950300", description: "Toys, games" })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.row.description).toBe("Toys, games")
    const rows = db.__all("hs_code_library").filter((l) => l.code === "950300")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.description).toBe("Toys, games")
  })

  test("library delete refuses while a product still uses the code, and reports the count", async () => {
    const { ctx } = makeE8Ctx({
      seedOverlay: [
        {
          source: "shopify",
          external_id: "prod-1",
          hs_code: "950300",
          country_of_origin: null,
          customs_description: null,
          updated_by_user_id: "user-1",
        },
      ],
    })
    await hsCodesLibraryUpsert(ctx, { code: "950300", description: "Toys" })
    const r = await hsCodesLibraryDelete(ctx, { code: "950300" })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("hs_code_in_use")
    expect(r.error.message).toContain("1")
  })

  test("library delete with force removes it", async () => {
    const { ctx, db } = makeE8Ctx({
      seedOverlay: [
        {
          source: "shopify",
          external_id: "prod-1",
          hs_code: "950300",
          country_of_origin: null,
          customs_description: null,
          updated_by_user_id: "user-1",
        },
      ],
    })
    await hsCodesLibraryUpsert(ctx, { code: "950300", description: "Toys" })
    const r = await hsCodesLibraryDelete(ctx, { code: "950300", force: true })
    expect(r.status).toBe("completed")
    expect(db.__all("hs_code_library").find((l) => l.code === "950300")).toBeUndefined()
  })
})

describe("hs_codes.unassign", () => {
  test("unassign deletes the overlay row so the product falls back to the Shopify value", async () => {
    const { ctx, db } = makeE8Ctx({
      seedOverlay: [
        {
          source: "shopify",
          external_id: "prod-1",
          hs_code: "950300",
          country_of_origin: "FR",
          customs_description: "Toy widget",
          updated_by_user_id: "user-1",
        },
      ],
    })
    const r = await hsCodesUnassign(ctx, { product_source: "shopify", external_id: "prod-1" })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.deleted).toBe(true)
    expect(
      db.__all("product_customs_overlay").find((o) => o.external_id === "prod-1"),
    ).toBeUndefined()
  })

  test("unassign of a single field leaves the other overlay fields intact", async () => {
    const { ctx, db } = makeE8Ctx({
      seedOverlay: [
        {
          source: "shopify",
          external_id: "prod-1",
          hs_code: "950300",
          country_of_origin: "FR",
          customs_description: "Toy widget",
          updated_by_user_id: "user-1",
        },
      ],
    })
    const r = await hsCodesUnassign(ctx, {
      product_source: "shopify",
      external_id: "prod-1",
      fields: ["hs_code"],
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.deleted).toBe(false)
    const row = db.__all("product_customs_overlay").find((o) => o.external_id === "prod-1")
    expect(row?.hs_code).toBeNull()
    expect(row?.country_of_origin).toBe("FR")
    expect(row?.customs_description).toBe("Toy widget")
  })
})

describe("contact_relationships.set", () => {
  test("writes manual row, overwriting any existing inferred", async () => {
    const { ctx, db } = makeE8Ctx({
      seedRelationships: [{ contact_id: "c-1", relationship: "customer", source: "inferred" }],
    })
    const r = await contactRelationshipsSet(ctx, {
      contact_id: "c-1",
      relationship: "vendor",
    })
    expect(r.status).toBe("completed")
    const row = db.__all("contact_relationships").find((rr) => rr.contact_id === "c-1")
    expect(row?.relationship).toBe("vendor")
    expect(row?.source).toBe("manual")
  })

  test("invalid relationship rejected", async () => {
    const { ctx } = makeE8Ctx()
    const r = await contactRelationshipsSet(ctx, {
      contact_id: "c-1",
      // @ts-expect-error invalid
      relationship: "bogus",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("invalid_relationship")
  })
})

describe("inferContactRelationshipOnIssue — precedence rules", () => {
  test("missing row + invoice → creates (customer, inferred)", async () => {
    const { ctx, db } = makeE8Ctx()
    const r = await inferContactRelationshipOnIssue(ctx, {
      contact_id: "c-1",
      document_type: "invoice",
    })
    expect(r.status).toBe("ok")
    if (r.status !== "ok") throw new Error("unreachable")
    expect(r.action).toBe("created")
    const row = db.__all("contact_relationships").find((rr) => rr.contact_id === "c-1")
    expect(row?.relationship).toBe("customer")
    expect(row?.source).toBe("inferred")
  })

  test("missing row + PO → creates (vendor, inferred)", async () => {
    const { ctx, db } = makeE8Ctx()
    const r = await inferContactRelationshipOnIssue(ctx, {
      contact_id: "c-1",
      document_type: "purchase_order",
    })
    expect(r.status).toBe("ok")
    if (r.status !== "ok") throw new Error("unreachable")
    expect(r.action).toBe("created")
    const row = db.__all("contact_relationships").find((rr) => rr.contact_id === "c-1")
    expect(row?.relationship).toBe("vendor")
  })

  test("inferred (customer) + PO → upgraded to (both, inferred)", async () => {
    const { ctx, db } = makeE8Ctx({
      seedRelationships: [{ contact_id: "c-1", relationship: "customer", source: "inferred" }],
    })
    const r = await inferContactRelationshipOnIssue(ctx, {
      contact_id: "c-1",
      document_type: "purchase_order",
    })
    expect(r.status).toBe("ok")
    if (r.status !== "ok") throw new Error("unreachable")
    expect(r.action).toBe("upgraded")
    const row = db.__all("contact_relationships").find((rr) => rr.contact_id === "c-1")
    expect(row?.relationship).toBe("both")
  })

  test("manual (customer) + PO → NOT overwritten, attention emitted", async () => {
    const { ctx, db, extras } = makeE8Ctx({
      seedRelationships: [{ contact_id: "c-1", relationship: "customer", source: "manual" }],
    })
    const r = await inferContactRelationshipOnIssue(ctx, {
      contact_id: "c-1",
      document_type: "purchase_order",
    })
    expect(r.status).toBe("attention")
    if (r.status !== "attention") throw new Error("unreachable")
    expect(r.reason).toBe("manual_conflict")
    const row = db.__all("contact_relationships").find((rr) => rr.contact_id === "c-1")
    expect(row?.relationship).toBe("customer")
    expect(row?.source).toBe("manual")
    expect(extras.emittedAttention.find((a) => a.action === "contact_conflict")).toBeDefined()
  })

  test("manual (both) + PO → noop (manual both already covers PO side)", async () => {
    const { ctx, db } = makeE8Ctx({
      seedRelationships: [{ contact_id: "c-1", relationship: "both", source: "manual" }],
    })
    const r = await inferContactRelationshipOnIssue(ctx, {
      contact_id: "c-1",
      document_type: "purchase_order",
    })
    expect(r.status).toBe("ok")
    if (r.status !== "ok") throw new Error("unreachable")
    expect(r.action).toBe("noop")
    const row = db.__all("contact_relationships").find((rr) => rr.contact_id === "c-1")
    expect(row?.relationship).toBe("both")
  })

  test("inferred (both) + invoice → noop (no upgrade beyond both)", async () => {
    const { ctx } = makeE8Ctx({
      seedRelationships: [{ contact_id: "c-1", relationship: "both", source: "inferred" }],
    })
    const r = await inferContactRelationshipOnIssue(ctx, {
      contact_id: "c-1",
      document_type: "invoice",
    })
    expect(r.status).toBe("ok")
    if (r.status !== "ok") throw new Error("unreachable")
    expect(r.action).toBe("noop")
  })
})

// ── items-omitted defensive defaults ─────────────────────────────────────

describe("items omitted — defensive defaults", () => {
  test("proforma_create_and_issue with no items does not crash (proforma is always gated so it pends approval)", async () => {
    const { ctx } = makeCtx()
    // Omit items entirely (wire payload may not include it for empty documents).
    // proforma_create_and_issue is always gated, so expect pending_approval rather
    // than a TypeError crash — the key assertion is that no exception is thrown.
    const result = await proformaCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      reason: "sample",
      // items intentionally omitted
    } as Parameters<typeof proformaCreateAndIssue>[1])
    expect(result.status).toBe("pending_approval")
  })

  test("drafts_create with no items does not crash", async () => {
    const { ctx } = makeCtx()
    const result = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      // items intentionally omitted
    } as Parameters<typeof draftsCreate>[1])
    expect(result.draft_id.length).toBeGreaterThan(0)
  })

  test("invoice_create_and_issue with no items does not crash", async () => {
    const { ctx } = makeCtx()
    const result = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      // items intentionally omitted
    } as Parameters<typeof invoiceCreateAndIssue>[1])
    expect(result.status).toBe("completed")
  })
})

// ── threshold gate uses classifier-inclusive total ────────────────────────

describe("threshold gate — uses classifier-inclusive grand total", () => {
  test("invoice_create_and_issue: domestic 20% VAT is included in the threshold check", async () => {
    // FR domestic issuer + FR counterparty → 20% VAT (2000 bp).
    // 1 item × 10_000 → subtotal 10_000 → VAT 2_000 → grand 12_000.
    // Threshold set at 11_000 (above subtotal, below grand total).
    // Without the fix (subtotal-only gate) approval would be skipped.
    const { ctx, extras } = makeCtx({ issuerThresholdMinor: 11_000n })
    const result = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty, // FR counterparty
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "Service",
          quantity: "1",
          unit_price_minor: 10_000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    // The gate fires because grand total (12_000) > threshold (11_000).
    expect(result.status).toBe("pending_approval")
    expect(extras.approvalsRequested).toHaveLength(1)
  })

  test("invoice_create_and_issue: export (0% VAT) does not trigger threshold for same subtotal", async () => {
    // FR issuer + non-EU counterparty → eu_export_non_eu → 0% VAT.
    // 1 item × 10_000 → subtotal 10_000 → VAT 0 → grand 10_000.
    // Threshold 11_000 → no gate.
    const { ctx, extras } = makeCtx({ issuerThresholdMinor: 11_000n })
    const result = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: { ...defaultCounterparty, country: "US", vat_id: null },
      issuer_profile_id: "iss-1",
      currency: "USD",
      items: [
        {
          position: 1,
          description: "Export service",
          quantity: "1",
          unit_price_minor: 10_000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(result.status).toBe("completed")
    expect(extras.approvalsRequested).toHaveLength(0)
  })
})

// ── BL-39: forgiving HS-code field normalization ────────────────────────────
// customs-invoice-aki-export-japan failed 3× across 3 instruction fixes (BL-35/37/38):
// the weak agent — handed the codes by the marco persona — wrote the HS code into the
// free-text customs_description / item description instead of the structured `hs_code`
// field, so the code never reached the structured per-line customs data the export
// overlay is built from, documents_get reported hs_code:null, and a correctly-stated
// code silently failed the export. The instruction layer was exhausted; this is the
// mechanical fix — normaliseDraftLine lifts a clear dotted HS token into hs_code on
// every drafts_create / drafts_update / create-and-issue path.
describe("liftMisplacedHsCode — forgiving HS-code field normalization (BL-39)", () => {
  const line = (over: Partial<DraftLine>): DraftLine => ({
    description: "Kestrel 6",
    quantity: "1",
    unit_price_minor: 100000n,
    product_source: null,
    external_id: null,
    hs_code: null,
    customs_description: null,
    country_of_origin: null,
    ...over,
  })

  test("lifts a dotted HS code out of customs_description into structured hs_code", () => {
    expect(liftMisplacedHsCode(line({ customs_description: "9207.90" })).hs_code).toBe("9207.90")
  })

  test("lifts an HS code embedded in real goods-description text, leaving the text intact", () => {
    const out = liftMisplacedHsCode(
      line({ customs_description: "Electronic musical instrument 9207.90" }),
    )
    expect(out.hs_code).toBe("9207.90")
    expect(out.customs_description).toBe("Electronic musical instrument 9207.90") // source never destroyed
  })

  test("lifts from the item description when customs_description is empty", () => {
    expect(liftMisplacedHsCode(line({ description: "Cable Kit 8543.70" })).hs_code).toBe("8543.70")
  })

  test("supports the dotted 8-digit national subdivision form (NNNN.NN.NN)", () => {
    expect(liftMisplacedHsCode(line({ customs_description: "9207.90.00" })).hs_code).toBe(
      "9207.90.00",
    )
  })

  test("an explicit hs_code always wins — the inline path is untouched", () => {
    expect(
      liftMisplacedHsCode(line({ hs_code: "9207.90", customs_description: "8543.70" })).hs_code,
    ).toBe("9207.90")
  })

  test("does NOT lift a bare integer — could be a SKU / serial / price / quantity", () => {
    expect(
      liftMisplacedHsCode(
        line({ description: "RAL-44 unit 920790", customs_description: "serial 12345678" }),
      ).hs_code,
    ).toBeNull()
  })

  test("leaves hs_code null when no HS token is present", () => {
    expect(
      liftMisplacedHsCode(
        line({ description: "Kestrel 6", customs_description: "Studio synthesizer" }),
      ).hs_code,
    ).toBeNull()
  })

  test("drafts_create persists AND tool-backs the lifted structured hs_code end-to-end", async () => {
    const { ctx, db } = makeCtx()
    const result = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          description: "Kestrel 6",
          quantity: "1",
          unit_price_minor: 90000n,
          product_source: null,
          external_id: null,
          customs_description: "9207.90", // agent put the code in the free-text field, hs_code left blank
        },
      ],
    })
    // (a) persisted into the structured column at create
    const persisted = db.__all("document_lines").filter((l) => l.document_id === result.draft_id)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.hs_code).toBe("9207.90")
    // (b) drafts_create now RETURNS the line (not just an opaque id) so the code is tool-backed —
    //     the agent + judge can verify the export invoice genuinely carries the per-line HS code.
    expect(result.draft_id.length).toBeGreaterThan(0)
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]!.hs_code).toBe("9207.90")
    expect(typeof result.lines[0]!.unit_price_minor).toBe("string") // wire-safe (bigint serialized)
  })
})

describe("liftMisplacedCountry — forgiving country field normalization (BL-44)", () => {
  // Widened-type helper: production callers pass `string | null` (never the literal types a bare
  // object literal would infer), so the lifted fields read back as `string | null` here too.
  const hdr = (counterparty_country: string | null, tax_treatment: string | null) =>
    liftMisplacedCountry({ counterparty_country, tax_treatment })

  test("lifts a country code from tax_treatment onto counterparty_country, clearing the misplaced hint", () => {
    const out = hdr(null, "US")
    expect(out.counterparty_country).toBe("US")
    expect(out.tax_treatment).toBeNull()
  })

  test("normalises case/whitespace of the misplaced country token", () => {
    expect(hdr("", " jp ").counterparty_country).toBe("JP")
  })

  test("an explicit counterparty_country always wins — the correct path is untouched", () => {
    const out = hdr("FR", "US")
    expect(out.counterparty_country).toBe("FR")
    expect(out.tax_treatment).toBe("US") // not touched when counterparty_country already set
  })

  test("does NOT lift a real tax_treatment keyword (not a country code)", () => {
    const out = hdr(null, "export")
    expect(out.counterparty_country).toBeNull()
    expect(out.tax_treatment).toBe("export")
  })

  test("liftMisplacedCountryOnLine lifts a bare country token from customs_description onto country_of_origin", () => {
    const line: DraftLine = {
      description: "Kestrel 6",
      quantity: "1",
      unit_price_minor: 100000n,
      product_source: null,
      external_id: null,
      hs_code: "9207.90",
      customs_description: "FR",
      country_of_origin: null,
    }
    const out = liftMisplacedCountryOnLine(line)
    expect(out.country_of_origin).toBe("FR")
    expect(out.customs_description).toBeNull()
  })

  test("liftMisplacedCountryOnLine does NOT touch a real goods description", () => {
    const line: DraftLine = {
      description: "Kestrel 6",
      quantity: "1",
      unit_price_minor: 100000n,
      product_source: null,
      external_id: null,
      hs_code: "9207.90",
      customs_description: "Studio synthesizer",
      country_of_origin: null,
    }
    const out = liftMisplacedCountryOnLine(line)
    expect(out.country_of_origin).toBeNull()
    expect(out.customs_description).toBe("Studio synthesizer")
  })

  test("drafts_create with a country in tax_treatment persists counterparty_country (the field of record) end-to-end", async () => {
    const { ctx, db } = makeCtx()
    const result = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      tax_treatment: "US", // agent put the destination COUNTRY in the informational treatment field
      items: [
        {
          description: "Kestrel 6",
          quantity: "1",
          unit_price_minor: 90000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    const doc = db.__all("documents").find((d) => d.id === result.draft_id)
    // The country reaches the field of record classify() reads at issue (so export 0% is derived, not domestic 20%).
    expect(doc?.counterparty_country).toBe("US")
    expect(doc?.tax_treatment).toBeNull()
  })

  test("drafts_update with a country in tax_treatment routes onto counterparty_country", async () => {
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          description: "Kestrel 6",
          quantity: "1",
          unit_price_minor: 90000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    await draftsUpdate(ctx, { draft_id, patch: { tax_treatment: "JP" } })
    const doc = db.__all("documents").find((d) => d.id === draft_id)
    expect(doc?.counterparty_country).toBe("JP")
    expect(doc?.tax_treatment).toBeNull()
  })
})

describe("settingsIssuerProfileUpdate — empty-update guard (no-op must not 500)", () => {
  // BL-249 / auto-invoice-on-paid-order-routine-trap: a weak agent "ensures" the issuer profile
  // settings by calling settings_issuer_profile_update with only {id} and no fields. That produced
  // an empty SET clause → opaque HTTP 500. It must instead fail loudly + instructively with a clean
  // invalid_params error that names the writable columns, never crashing the request.
  test("an update with only {id} (no writable fields) returns a clean invalid_params error, not a crash", async () => {
    const { ctx, db } = makeCtx({})
    const updateCalls: Array<{ table: string; id: string }> = []
    const realUpdate = db.update.bind(db)
    // Spy: the guard must short-circuit BEFORE ctx.db.update is reached for the empty case.
    ;(db as unknown as { update: typeof db.update }).update = (async (
      table: string,
      id: string,
      data: Record<string, unknown>,
    ) => {
      updateCalls.push({ table, id })
      return realUpdate(table, id, data)
    }) as typeof db.update

    const res = await settingsIssuerProfileUpdate(ctx, { id: "iss-1" })
    expect(res.status).toBe("error")
    if (res.status === "error") {
      expect(res.error.code).toBe("invalid_params")
      expect(res.error.message).toContain("No updatable fields")
    }
    // No DB write was attempted for the empty payload.
    expect(updateCalls.length).toBe(0)
  })

  test("an update WITH a real field still succeeds (the guard does not block a genuine change)", async () => {
    const { ctx, db } = makeCtx({ scopes: ["invoicing:issuer:admin"] })
    const res = await settingsIssuerProfileUpdate(ctx, {
      id: "iss-1",
      invoice_approval_threshold_minor: 75000n,
    })
    expect(res.status).toBe("completed")
    const row = db.__all("issuer_profiles").find((r) => r.id === "iss-1")
    expect(row?.invoice_approval_threshold_minor).toBe(75000n)
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Part 1 — counterparty snapshot columns (address/vat_id/email) persisted
// at issue time and surfaced back on read/re-render.
// ─────────────────────────────────────────────────────────────────────────

describe("counterparty snapshot — persisted at issue time", () => {
  const richCounterparty: Counterparty = {
    contact_id: "contact-42",
    legal_name: "Northwind Traders GmbH",
    country: "DE",
    vat_id: "DE123456789",
    address: "Hauptstrasse 1, 10115 Berlin, Germany",
    email: "ap@northwind.example",
  }

  test("invoice_create_and_issue persists counterparty_address/vat_id/email onto the issued document", async () => {
    const { ctx, db } = makeCtx({ issuerThresholdMinor: null })
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: richCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    const doc = issuedDocs(db)[0]!
    expect(doc.counterparty_name).toBe("Northwind Traders GmbH")
    expect(doc.counterparty_address).toBe("Hauptstrasse 1, 10115 Berlin, Germany")
    expect(doc.counterparty_vat_id).toBe("DE123456789")
    expect(doc.counterparty_email).toBe("ap@northwind.example")
  })

  test("proforma_create_and_issue (createAndIssueGenerically path) also persists the full counterparty snapshot", async () => {
    // proforma_create_and_issue is ALWAYS gated — simulate post-approval re-entry (ctx.approval set)
    // so the handler executes the issue instead of filing a new approval.
    const { ctx, db } = makeCtx({
      issuerThresholdMinor: null,
      approval: {
        approvalRequestId: "appr-1",
        approvalDeciderId: "user-2",
        toolName: "invoicing:proforma_create_and_issue",
      },
    })
    const r = await proformaCreateAndIssue(ctx, {
      counterparty: richCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      reason: "customs clearance",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    const doc = issuedDocs(db)[0]!
    expect(doc.counterparty_address).toBe("Hauptstrasse 1, 10115 Berlin, Germany")
    expect(doc.counterparty_vat_id).toBe("DE123456789")
    expect(doc.counterparty_email).toBe("ap@northwind.example")
  })

  test("PDF re-render (ensureDocumentPdf via documents_retry_pdf) rebuilds template data from the persisted snapshot, not a name/country-only stub", async () => {
    const { ctx, db, extras } = makeCtx({ issuerThresholdMinor: null })
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: richCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") return
    extras.renderCalls.length = 0 // clear the issue-time render call
    const retry = await documentsRetryPdf(ctx, { id: r.document_id })
    expect(retry.status).toBe("completed")
    expect(extras.renderCalls).toHaveLength(1)
    const data = extras.renderCalls[0]!.data as {
      counterparty: {
        legal_name: string
        address: string | null
        vat_id: string | null
        email: string | null
      }
    }
    expect(data.counterparty.address).toBe("Hauptstrasse 1, 10115 Berlin, Germany")
    expect(data.counterparty.vat_id).toBe("DE123456789")
    expect(data.counterparty.email).toBe("ap@northwind.example")
  })

  // Same regression class as the address/VAT/email drop above: rebuilding the counterparty from
  // the row without the ship to columns silently loses the SHIP TO block on every retried or
  // self-healed PDF, so the second rendering of an invoice no longer matches the first.
  const shipToCounterparty: Counterparty = {
    ...richCounterparty,
    shipping_address: "Am Hafen 12\n21079 Hamburg\nDE",
    shipping_name: "Spedition Nord KG",
  }

  test("invoice_create_and_issue persists the ship to snapshot alongside the billing snapshot", async () => {
    const { ctx, db } = makeCtx({ issuerThresholdMinor: null })
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: shipToCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    const doc = issuedDocs(db)[0]!
    expect(doc.counterparty_address).toBe("Hauptstrasse 1, 10115 Berlin, Germany")
    expect(doc.counterparty_shipping_address).toBe("Am Hafen 12\n21079 Hamburg\nDE")
    expect(doc.counterparty_shipping_name).toBe("Spedition Nord KG")
  })

  test("a PDF RE-RENDER does not drop the ship to", async () => {
    const { ctx, extras } = makeCtx({ issuerThresholdMinor: null })
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: shipToCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") return
    const issueTime = extras.renderCalls[0]!.data as { counterparty: Record<string, unknown> }
    expect(issueTime.counterparty.shipping_address).toBe("Am Hafen 12\n21079 Hamburg\nDE")
    extras.renderCalls.length = 0
    const retry = await documentsRetryPdf(ctx, { id: r.document_id })
    expect(retry.status).toBe("completed")
    const data = extras.renderCalls[0]!.data as { counterparty: Record<string, unknown> }
    expect(data.counterparty.shipping_address).toBe("Am Hafen 12\n21079 Hamburg\nDE")
    expect(data.counterparty.shipping_name).toBe("Spedition Nord KG")
  })

  // An already-issued document from before this feature carries neither column. Re-rendering it
  // must still produce a complete BILL TO block and simply no ship to, with nothing invented.
  test("re-rendering a document issued WITHOUT a ship to yields nulls, not a copy of the billing address", async () => {
    const { ctx, extras } = makeCtx({ issuerThresholdMinor: null })
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: richCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") return
    extras.renderCalls.length = 0
    const retry = await documentsRetryPdf(ctx, { id: r.document_id })
    expect(retry.status).toBe("completed")
    const data = extras.renderCalls[0]!.data as { counterparty: Record<string, unknown> }
    expect(data.counterparty.address).toBe("Hauptstrasse 1, 10115 Berlin, Germany")
    expect(data.counterparty.shipping_address).toBeNull()
    expect(data.counterparty.shipping_name).toBeNull()
  })

  // HARD CONSTRAINT: classify() (mutations.ts, re-render path) keys off counterparty_country.
  test("a ship to in another country changes neither the re-render treatment nor the stored one", async () => {
    const { ctx, db, extras } = makeCtx({ issuerThresholdMinor: null })
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: {
        ...richCounterparty,
        shipping_address: "1 Export Road\nNew York\nUS",
        shipping_name: "US Forwarder Inc",
      },
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") return
    const doc = issuedDocs(db)[0]!
    const treatmentAtIssue = doc.tax_treatment
    expect(doc.counterparty_country).toBe("DE")
    extras.renderCalls.length = 0
    await documentsRetryPdf(ctx, { id: r.document_id })
    const data = extras.renderCalls[0]!.data as { document: Record<string, unknown> }
    expect(data.document.tax_treatment).toBe(treatmentAtIssue)
    expect(issuedDocs(db)[0]!.tax_treatment).toBe(treatmentAtIssue)
    expect(issuedDocs(db)[0]!.counterparty_country).toBe("DE")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Part 2 — documents_update (post-issue editing)
// ─────────────────────────────────────────────────────────────────────────

describe("documents_update: an issued document's date and its number", () => {
  afterEach(() => setSystemTime())

  const row = (n: number, issuedAt: string | null, overrides: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    type: "invoice",
    status: "issued",
    number: `INV-2026-${String(n).padStart(4, "0")}`,
    number_int: n,
    year_of_issue: 2026,
    issuer_profile_id: defaultIssuer.id,
    counterparty_name: "Buyer",
    currency: "EUR",
    subtotal_minor: "10000",
    tax_total_minor: "0",
    grand_total_minor: "10000",
    incoterm: "DAP",
    issued_at: issuedAt,
    pdf_status: "ready",
    external_refs: {},
    lifecycle_log: [],
    ...overrides,
  })

  /** Three numbers of one series, dated 1, 10 and 20 March 2026; today is 15 June 2026. */
  async function series(overrides: Record<string, unknown> = {}) {
    setSystemTime(new Date("2026-06-15T10:00:00Z"))
    const m = makeCtx({ issuerThresholdMinor: null })
    const rows = [
      row(1, "2026-03-01", overrides),
      row(2, "2026-03-10", overrides),
      row(3, "2026-03-20", overrides),
    ]
    for (const r of rows) await m.db.insert("documents", r)
    const [first, middle, last] = rows.map((r) => r.id) as [string, string, string]
    const stored = (id: string) => m.db.__all("documents").find((d) => d.id === id)?.issued_at
    return { m, first, middle, last, stored }
  }

  const code = (res: { status: string; error?: { code?: string } }) =>
    res.status === "error" ? res.error?.code : "completed"

  test("a date in another year is refused and steers to a credit note; nothing changes", async () => {
    const { m, middle, stored } = await series()
    for (const date of ["2025-12-31", "2027-01-03"]) {
      const res = await documentsUpdate(m.ctx, { id: middle, issued_at: date })
      expect(code(res)).toBe("issue_date_crosses_number_year")
      if (res.status === "error") {
        expect(res.error.message).toContain("INV-2026-0002")
        expect(res.error.message).toContain("credit note")
      }
    }
    expect(stored(middle)).toBe("2026-03-10")
  })

  test("the refusal comes at stage time, before an approval card exists", async () => {
    const { m, middle } = await series()
    const res = await documentsUpdatePreflight(m.ctx, { id: middle, issued_at: "2027-01-03" })
    expect(res).toMatchObject({ error: { code: "issue_date_crosses_number_year" } })
  })

  test("re-sending the same date is not a change: the editor's save carries every field", async () => {
    const { m, middle } = await series()
    for (const date of ["2026-03-10", "2026-03-10T00:00:00.000Z"]) {
      expect(
        code(await documentsUpdate(m.ctx, { id: middle, issued_at: date, notes: "Merci" })),
      ).toBe("completed")
    }
  })

  test("a typo fix between the neighbouring numbers still goes through", async () => {
    const { m, first, middle, last, stored } = await series()
    for (const date of ["2026-03-01", "2026-03-05", "2026-03-20"]) {
      expect(code(await documentsUpdate(m.ctx, { id: middle, issued_at: date }))).toBe("completed")
      expect(stored(middle)).toBe(date)
    }
    await documentsUpdate(m.ctx, { id: middle, issued_at: "2026-03-10" })
    expect(code(await documentsUpdate(m.ctx, { id: first, issued_at: "2026-01-02" }))).toBe(
      "completed",
    )
    expect(code(await documentsUpdate(m.ctx, { id: last, issued_at: "2026-06-15" }))).toBe(
      "completed",
    )
  })

  test("a date before the previous number or after the next one is refused, naming it", async () => {
    const { m, middle, stored } = await series()
    const before = await documentsUpdate(m.ctx, { id: middle, issued_at: "2026-02-28" })
    expect(code(before)).toBe("issue_date_breaks_number_order")
    if (before.status === "error") expect(before.error.message).toContain("INV-2026-0001")
    const after = await documentsUpdate(m.ctx, { id: middle, issued_at: "2026-03-21" })
    expect(code(after)).toBe("issue_date_breaks_number_order")
    if (after.status === "error") expect(after.error.message).toContain("INV-2026-0003")
    expect(stored(middle)).toBe("2026-03-10")
  })

  test("a date after today is refused: no number issued today could follow it", async () => {
    const { m, last, stored } = await series()
    expect(code(await documentsUpdate(m.ctx, { id: last, issued_at: "2026-06-16" }))).toBe(
      "issue_date_in_future",
    )
    expect(stored(last)).toBe("2026-03-20")
  })

  test("a credit note keeps its own series", async () => {
    const { m, middle } = await series()
    const note = row(1, "2026-04-01", { type: "credit_note", number: "CN-2026-0001" })
    await m.db.insert("documents", note)
    // Nothing in the credit note series constrains the invoice, and the reverse.
    expect(code(await documentsUpdate(m.ctx, { id: middle, issued_at: "2026-03-15" }))).toBe(
      "completed",
    )
    expect(code(await documentsUpdate(m.ctx, { id: note.id, issued_at: "2026-02-01" }))).toBe(
      "completed",
    )
    const crossing = await documentsUpdate(m.ctx, { id: note.id, issued_at: "2025-12-31" })
    expect(code(crossing)).toBe("issue_date_crosses_number_year")
    if (crossing.status === "error") expect(crossing.error.message).toContain("credit note")
  })

  test("a number that was voided still holds its place in the order", async () => {
    setSystemTime(new Date("2026-06-15T10:00:00Z"))
    const m = makeCtx({ issuerThresholdMinor: null })
    const voided = row(1, "2026-03-01", { status: "voided" })
    const live = row(2, "2026-03-10")
    await m.db.insert("documents", voided)
    await m.db.insert("documents", live)
    expect(code(await documentsUpdate(m.ctx, { id: live.id, issued_at: "2026-02-28" }))).toBe(
      "issue_date_breaks_number_order",
    )
  })

  test("an issued document cannot lose its date, or take something that is no date", async () => {
    const { m, middle, stored } = await series()
    for (const date of [null, "", "someday", "2026-02-31"]) {
      expect(
        code(await documentsUpdate(m.ctx, { id: middle, issued_at: date as string | null })),
      ).toBe("issued_at_invalid")
    }
    expect(stored(middle)).toBe("2026-03-10")
  })

  test("a quote keeps its number's year, but a new quote is the way out, and no order binds it", async () => {
    const { m, middle, stored } = await series({ type: "quote", status: "sent" })
    const crossing = await documentsUpdate(m.ctx, { id: middle, issued_at: "2027-01-03" })
    expect(code(crossing)).toBe("issue_date_crosses_number_year")
    if (crossing.status === "error") {
      expect(crossing.error.message).toContain("new quote")
      expect(crossing.error.message).not.toContain("credit note")
    }
    expect(code(await documentsUpdate(m.ctx, { id: middle, issued_at: "2026-11-30" }))).toBe(
      "completed",
    )
    expect(stored(middle)).toBe("2026-11-30")
  })

  test("a draft has no number yet: its date is free", async () => {
    setSystemTime(new Date("2026-06-15T10:00:00Z"))
    const m = makeCtx({ issuerThresholdMinor: null })
    const draft = row(0, null, {
      status: "draft",
      number: null,
      number_int: null,
      year_of_issue: null,
    })
    await m.db.insert("documents", draft)
    expect(code(await documentsUpdate(m.ctx, { id: draft.id, issued_at: "2027-01-03" }))).toBe(
      "completed",
    )
  })

  test("an imported document with no place in a sequence keeps its year but no neighbour binds it", async () => {
    setSystemTime(new Date("2026-06-15T10:00:00Z"))
    const m = makeCtx({ issuerThresholdMinor: null })
    const imported = row(0, "2026-03-10", {
      number: "LEGACY-77",
      number_int: null,
      pdf_file_id: "imported-file-1",
      external_refs: { import_source: "77.pdf", import_file_id: "imported-file-1" },
    })
    await m.db.insert("documents", row(5, "2026-03-20"))
    await m.db.insert("documents", imported)
    expect(code(await documentsUpdate(m.ctx, { id: imported.id, issued_at: "2026-03-25" }))).toBe(
      "completed",
    )
    expect(code(await documentsUpdate(m.ctx, { id: imported.id, issued_at: "2027-01-03" }))).toBe(
      "issue_date_crosses_number_year",
    )
  })

  test("a date already in the wrong year can be brought back to the number's year", async () => {
    setSystemTime(new Date("2027-02-01T10:00:00Z"))
    const m = makeCtx({ issuerThresholdMinor: null })
    const wrong = row(1, "2027-01-03")
    await m.db.insert("documents", wrong)
    expect(code(await documentsUpdate(m.ctx, { id: wrong.id, issued_at: "2026-12-30" }))).toBe(
      "completed",
    )
  })
})

describe("documents.update", () => {
  async function issueSampleInvoice(ctxDb: ReturnType<typeof makeCtx>): Promise<string> {
    const r = await invoiceCreateAndIssue(ctxDb.ctx, {
      operation_category: "goods",
      counterparty: {
        contact_id: "contact-1",
        legal_name: "Buyer SARL",
        country: "FR",
        vat_id: null,
        address: "1 rue Ancienne",
        email: "old@buyer.example",
        customer_kind: "business",
        billing_line1: "1 rue Buyer",
        billing_postcode: "75002",
        billing_city: "Paris",
      },
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    if (r.status !== "completed") throw new Error("setup issue failed")
    return r.document_id
  }

  // An issued invoice from before legal originals existed (no legal_original_id): its printed
  // addresses stay amendable. Once a legal original exists they are locked with it
  // (legal-originals/record.test.ts).
  async function issueLegacyInvoice(ctxDb: ReturnType<typeof makeCtx>): Promise<string> {
    const id = await issueSampleInvoice(ctxDb)
    await ctxDb.db.update("documents", id, { legal_original_id: null })
    return id
  }

  // A still-DRAFT invoice: documents_update's line/financial-substance mechanics
  // (recompute, 1-based numbering, tax overrides) are exercised on a draft, since
  // those fields are FROZEN once the document is issued (see immutability tests).
  async function draftSampleInvoice(ctxDb: ReturnType<typeof makeCtx>): Promise<string> {
    const r = await draftsCreate(ctxDb.ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    return r.draft_id
  }

  test("edits metadata (address/email) on an ISSUED document and appends an 'edited' lifecycle entry naming the changed fields", async () => {
    // Address/email are metadata, not financial substance — they stay editable
    // post-issue (Sufio-style typo correction). counterparty_name/vat/lines/tax are
    // frozen once issued and covered by the immutability tests below.
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueLegacyInvoice(m)
    const res = await documentsUpdate(m.ctx, {
      id,
      counterparty_address: "2 rue Nouvelle",
      counterparty_email: "new@buyer.example",
    })
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    expect(doc.counterparty_address).toBe("2 rue Nouvelle")
    expect(doc.counterparty_email).toBe("new@buyer.example")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    const edited = log.find((e) => e.event === "edited")
    expect(edited, "an 'edited' lifecycle entry must be appended").toBeDefined()
    const fields = edited!.fields as string[]
    expect(fields).toContain("counterparty_address")
    expect(fields).toContain("counterparty_email")
    expect(fields).not.toContain("lines")
  })

  // red: drop the po_number param handling in documentsUpdate (or the
  // po_number_changed append) -> an issued document can never carry a PO number
  // the customer supplies after the fact, and even if the column changed there
  // would be no audit trail explaining when/how/by whom.
  test("sets a PO number on an ISSUED document, logs po_number_changed (from/to/source), and re-renders the PDF", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    m.extras.renderCalls.length = 0 // clear the issue-time render call
    const res = await documentsUpdate(m.ctx, { id, po_number: "PO-4471" })
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    expect(doc.po_number).toBe("PO-4471")
    const refs = doc.external_refs as { po_number?: string }
    expect(refs.po_number).toBe("PO-4471")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    const change = log.find((e) => e.event === "po_number_changed")
    expect(change, "a po_number_changed lifecycle entry must be appended").toBeDefined()
    expect(change?.from).toBeNull()
    expect(change?.to).toBe("PO-4471")
    expect(change?.source).toBe("person")
    expect(change?.actor).toBeDefined()
    expect(change?.ts).toBeDefined()
    // Non-financial metadata edit still forces a fresh PDF render, same as address/email.
    expect(m.extras.renderCalls.length).toBeGreaterThanOrEqual(1)
  })

  test("amending the PO on an ISSUED document emits document:po_number_changed with the correct from/to", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    m.extras.emittedAttention.length = 0 // clear the issue-time document:issued/po_number_changed events
    const res = await documentsUpdate(m.ctx, { id, po_number: "PO-4471" })
    expect(res.status).toBe("completed")
    const evt = m.extras.emittedAttention.find((e) => e.action === "po_number_changed")
    expect(evt?.entity).toBe("document")
    expect(evt?.entityId).toBe(id)
    expect(evt?.data).toMatchObject({
      document_id: id,
      type: "invoice",
      from: null,
      to: "PO-4471",
    })
  })

  test("emits document:updated with changed_fields and bounded before/after for a metadata edit", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueLegacyInvoice(m)
    m.extras.emittedAttention.length = 0
    await documentsUpdate(m.ctx, { id, counterparty_address: "2 rue Nouvelle" })
    const evt = m.extras.emittedAttention.find((e) => e.action === "updated")
    expect(evt?.entity).toBe("document")
    expect(evt?.entityId).toBe(id)
    const data = evt?.data as {
      changed_fields: string[]
      changes: Record<string, { from: unknown; to: unknown }>
    }
    expect(data.changed_fields).toContain("counterparty_address")
    // The address VALUE is PII: it must never reach the audit trail's before/after map.
    expect(data.changes.counterparty_address).toBeUndefined()
  })

  // The operator correcting a ship to by hand on an already-issued invoice (the Editor's new
  // field, and documents_update's new params) is the flow this is FOR.
  test("documents_update sets the ship to on an ISSUED document and keeps its VALUE out of the audit diff", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueLegacyInvoice(m)
    m.extras.emittedAttention.length = 0
    const res = await documentsUpdate(m.ctx, {
      id,
      counterparty_shipping_address: "Am Hafen 12\n21079 Hamburg\nDE",
      counterparty_shipping_name: "Spedition Nord KG",
    })
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    expect(doc.counterparty_shipping_address).toBe("Am Hafen 12\n21079 Hamburg\nDE")
    expect(doc.counterparty_shipping_name).toBe("Spedition Nord KG")
    // The billing snapshot and the tax country are untouched by a ship to edit.
    expect(doc.counterparty_address).toBe("1 rue Ancienne")
    expect(doc.counterparty_country).toBe("FR")
    const data = m.extras.emittedAttention.find((e) => e.action === "updated")?.data as {
      changed_fields: string[]
      changes: Record<string, unknown>
    }
    expect(data.changed_fields).toContain("counterparty_shipping_address")
    // A ship to is the postal address of a real person: PII, same class as counterparty_address.
    expect(data.changes.counterparty_shipping_address).toBeUndefined()
    expect(data.changes.counterparty_shipping_name).toBeUndefined()
  })

  test("document:updated does NOT fire for an excluded/internal-only column change", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    m.extras.emittedAttention.length = 0
    // documents_update has no manifest param that touches pdf_status directly; simulate the
    // "nothing a human cares about changed" case with a no-op call (no fields in rawInput).
    await documentsUpdate(m.ctx, { id })
    const evt = m.extras.emittedAttention.find((e) => e.action === "updated")
    expect(evt, "a no-op edit must not emit document:updated").toBeUndefined()
  })

  test("changes an existing PO number on an ISSUED document, logging the previous and new value", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    await documentsUpdate(m.ctx, { id, po_number: "PO-1000" })
    const res = await documentsUpdate(m.ctx, { id, po_number: "PO-2000" })
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    expect(doc.po_number).toBe("PO-2000")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    const changes = log.filter((e) => e.event === "po_number_changed")
    expect(changes).toHaveLength(2)
    expect(changes[1]?.from).toBe("PO-1000")
    expect(changes[1]?.to).toBe("PO-2000")
  })

  test("clears an existing PO number (null), logging from the old value to null", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    await documentsUpdate(m.ctx, { id, po_number: "PO-1000" })
    const res = await documentsUpdate(m.ctx, { id, po_number: null })
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    expect(doc.po_number).toBeNull()
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    const changes = log.filter((e) => e.event === "po_number_changed")
    expect(changes).toHaveLength(2)
    expect(changes[1]?.from).toBe("PO-1000")
    expect(changes[1]?.to).toBeNull()
  })

  test("a no-op documents_update call with the SAME PO number does not append a spurious po_number_changed entry", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    await documentsUpdate(m.ctx, { id, po_number: "PO-1000" })
    await documentsUpdate(m.ctx, { id, po_number: "PO-1000" })
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log.filter((e) => e.event === "po_number_changed")).toHaveLength(1)
  })

  test("PO number is NOT in ISSUED_FROZEN_FIELDS — editable on an issued document without a credit note", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    const res = await documentsUpdate(m.ctx, { id, po_number: "PO-5555" })
    expect(res.status).toBe("completed")
  })

  test("number/status/type/currency are unchanged after a documents_update edit", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    const before = m.db.__all("documents").find((d) => d.id === id)!
    const res = await documentsUpdate(m.ctx, { id, counterparty_email: "new@buyer.example" })
    expect(res.status).toBe("completed")
    const after = m.db.__all("documents").find((d) => d.id === id)!
    expect(after.number).toBe(before.number)
    expect(after.status).toBe(before.status)
    expect(after.type).toBe(before.type)
    expect(after.currency).toBe(before.currency)
    expect(after.issuer_profile_id).toBe(before.issuer_profile_id)
  })

  test("replaces lines and recomputes subtotal/tax/grand_total_minor exactly on a DRAFT (FR domestic 20% VAT)", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await draftSampleInvoice(m)
    const res = await documentsUpdate(m.ctx, {
      id,
      lines: [
        {
          description: "Widget A",
          quantity: "3",
          unit_price_minor: 10_000n,
          product_source: null,
          external_id: null,
        },
        {
          description: "Widget B",
          quantity: "2",
          unit_price_minor: 2_500n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(res.status).toBe("completed")
    // subtotal = 3*10000 + 2*2500 = 30000 + 5000 = 35000; FR-domestic 20% VAT → tax 7000; grand 42000.
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    expect(doc.subtotal_minor).toBe("35000")
    expect(doc.tax_total_minor).toBe("7000")
    expect(doc.grand_total_minor).toBe("42000")
    const lines = m.db.__all("document_lines").filter((l) => l.document_id === id)
    expect(lines).toHaveLength(2)
    const a = lines.find((l) => l.description === "Widget A")!
    expect(a.subtotal_minor).toBe("30000")
    expect(a.tax_minor).toBe("6000")
    expect(a.total_minor).toBe("36000")
    const b = lines.find((l) => l.description === "Widget B")!
    expect(b.subtotal_minor).toBe("5000")
    expect(b.tax_minor).toBe("1000")
    expect(b.total_minor).toBe("6000")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    const edited = log.find((e) => e.event === "edited")!
    expect(edited.fields as string[]).toContain("lines")
  })

  test("respects a per-line tax_rate_bp_override when replacing lines on a DRAFT", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await draftSampleInvoice(m)
    await documentsUpdate(m.ctx, {
      id,
      lines: [
        {
          description: "Zero-rated line",
          quantity: "1",
          unit_price_minor: 10_000n,
          tax_rate_bp_override: 0,
          product_source: null,
          external_id: null,
        },
      ],
    })
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    expect(doc.subtotal_minor).toBe("10000")
    expect(doc.tax_total_minor).toBe("0")
    expect(doc.grand_total_minor).toBe("10000")
  })

  test("rejects editing a voided document with document_not_editable", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    await m.db.update("documents", id, { status: "voided" })
    const res = await documentsUpdate(m.ctx, { id, counterparty_name: "Nope" })
    expect(res.status).toBe("error")
    if (res.status === "error") expect(res.error.code).toBe("document_not_editable")
    // The edit did not apply.
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    expect(doc.counterparty_name).not.toBe("Nope")
  })

  test("rejects editing a cancelled document with document_not_editable", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    await m.db.update("documents", id, { status: "cancelled" })
    const res = await documentsUpdate(m.ctx, { id, counterparty_name: "Nope" })
    expect(res.status).toBe("error")
    if (res.status === "error") expect(res.error.code).toBe("document_not_editable")
  })

  test("nonexistent document id returns not_found", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const res = await documentsUpdate(m.ctx, {
      id: "00000000-0000-4000-8000-00000000010c",
      counterparty_name: "X",
    })
    expect(res.status).toBe("error")
    if (res.status === "error") expect(res.error.code).toBe("not_found")
  })

  test("forces a fresh PDF re-render on every edit (ctx.pdf.render called again)", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    m.extras.renderCalls.length = 0 // clear the issue-time render call
    const res = await documentsUpdate(m.ctx, { id, counterparty_email: "renamed@buyer.example" })
    expect(res.status).toBe("completed")
    expect(m.extras.renderCalls.length).toBeGreaterThanOrEqual(1)
  })

  test("replaced lines are numbered 1-based like the issue path (no '# 0' rows) on a DRAFT", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await draftSampleInvoice(m)
    const res = await documentsUpdate(m.ctx, {
      id,
      lines: [
        {
          description: "First",
          quantity: "1",
          unit_price_minor: "1000",
          product_source: null,
          external_id: null,
        },
        {
          description: "Second",
          quantity: "1",
          unit_price_minor: "2000",
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(res.status).toBe("completed")
    const rows = m.db.__all("document_lines").filter((l) => l.document_id === id)
    expect(rows.map((l) => l.position).sort()).toEqual([1, 2])
  })

  test("documents_update renders WITHOUT the cross-tx documents link (deadlock regression)", async () => {
    // The handler updates the documents row inside its own open transaction before rendering.
    // ctx.pdf.render's `link` makes the HOST write documents.pdf_file_id from a separate
    // privileged transaction — which blocks on the handler's row lock until the sandbox timeout
    // kills the worker (observed live on staging: every documents_update timed out at 7s).
    // documents_update must render with NO link; issue/retry paths keep it (BL-191).
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    m.extras.renderCalls.length = 0
    await documentsRetryPdf(m.ctx, { id })
    const retryCall = m.extras.renderCalls.at(-1) as Record<string, unknown>
    expect(retryCall.link).toBeDefined() // retry path keeps the BL-191 link
    m.extras.renderCalls.length = 0
    await documentsUpdate(m.ctx, { id, counterparty_email: "nolink@buyer.example" })
    const updateCall = m.extras.renderCalls.at(-1) as Record<string, unknown>
    expect(updateCall).toBeDefined()
    expect(updateCall.link).toBeUndefined()
  })

  test("a PDF render FAILURE still persists the edit and sets pdf_status failed (does not roll back)", async () => {
    const m = makeCtx({ issuerThresholdMinor: null, failPdfRender: true })
    const id = await issueSampleInvoice(m)
    const res = await documentsUpdate(m.ctx, { id, counterparty_email: "despite@buyer.example" })
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    expect(doc.counterparty_email).toBe("despite@buyer.example")
    expect(doc.pdf_status).toBe("failed")
  })

  test("draft documents may also be edited via documents_update (harmless on a non-issued doc)", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const { draft_id } = await draftsCreate(m.ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const res = await documentsUpdate(m.ctx, { id: draft_id, counterparty_name: "Draft Buyer" })
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.id === draft_id)!
    expect(doc.counterparty_name).toBe("Draft Buyer")
  })

  test("recomputes tax treatment inputs from an updated counterparty_country when lines are replaced on a DRAFT (FR->US export, zero-rated)", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await draftSampleInvoice(m) // originally FR domestic
    const res = await documentsUpdate(m.ctx, {
      id,
      counterparty_country: "US",
      lines: [
        {
          description: "Export widget",
          quantity: "1",
          unit_price_minor: 10_000n,
          hs_code: "9403.60",
          country_of_origin: "FR",
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    // US export is zero-rated — no VAT applied to the recomputed total.
    expect(doc.subtotal_minor).toBe("10000")
    expect(doc.tax_total_minor).toBe("0")
    expect(doc.grand_total_minor).toBe("10000")
    expect(doc.counterparty_country).toBe("US")
  })

  // ISSUED-IMMUTABILITY (French compliance) — an issued invoice's financial substance is frozen.
  // Editing lines/tax_treatment/counterparty legal identity in place on an issued invoice is a
  // compliance problem; the correction path is a CREDIT NOTE. documents_update must reject those
  // field edits with a typed error steering to credit_note_create_and_issue, while still allowing
  // harmless metadata edits (address/email) on the same issued document.
  test("rejects a LINES edit on an ISSUED invoice with issued_document_immutable steering to credit notes", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    const before = m.db.__all("documents").find((d) => d.id === id)!
    const res = await documentsUpdate(m.ctx, {
      id,
      lines: [
        {
          description: "Sneaky rewrite",
          quantity: "1",
          unit_price_minor: 1n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(res.status).toBe("error")
    if (res.status === "error") {
      expect(res.error.code).toBe("issued_document_immutable")
      expect(res.error.message).toMatch(/credit_note_create_and_issue/)
      expect(res.error.message).toMatch(/credit note/i)
    }
    // The issued document is untouched — totals and lines preserved.
    const after = m.db.__all("documents").find((d) => d.id === id)!
    expect(after.grand_total_minor).toBe(before.grand_total_minor)
    expect(m.db.__all("document_lines").filter((l) => l.document_id === id)).toHaveLength(1)
  })

  // The document has a dedicated po_number field that stays amendable after issue, so an agent
  // asked to add a purchase order number to an ISSUED invoice must be steered to po_number on
  // this same tool, rather than to a credit note plus a new invoice, and never to silently
  // editing the linked Shopify order, which leaves the document already sent to the customer
  // unchanged.
  test("issued_document_immutable message names the credit note path and steers a PO number to po_number", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    const res = await documentsUpdate(m.ctx, { id, tax_treatment: "export_zero_rated" })
    expect(res.status).toBe("error")
    if (res.status === "error") {
      expect(res.error.code).toBe("issued_document_immutable")
      expect(res.error.message).toMatch(/credit note/i)
      expect(res.error.message).toMatch(/purchase order number/i)
      expect(res.error.message).toContain("pass po_number to this same tool")
    }
  })

  // po_number is NOT in ISSUED_FROZEN_FIELDS (mutations.ts:4314) so it stays amendable in place
  // on an issued document. The issued_document_immutable message must say exactly that instead of
  // the older, now-wrong instruction to issue a credit note plus a new invoice for a PO number.
  test("issued_document_immutable message tells the agent to pass po_number to this same tool, and po_number update actually succeeds on the same issued document", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    const frozenRes = await documentsUpdate(m.ctx, { id, tax_treatment: "export_zero_rated" })
    expect(frozenRes.status).toBe("error")
    if (frozenRes.status === "error") {
      expect(frozenRes.error.code).toBe("issued_document_immutable")
      expect(frozenRes.error.message).toContain("pass po_number to this same tool")
      expect(frozenRes.error.message).not.toContain("issue a credit note and then a new invoice")
    }
    const poRes = await documentsUpdate(m.ctx, { id, po_number: "PO-4471" })
    expect(poRes.status).toBe("completed")
    if (poRes.status === "completed") {
      const doc = m.db.__all("documents").find((d) => d.id === id)!
      expect(doc.po_number).toBe("PO-4471")
    }
  })

  test("rejects a tax_treatment edit on an ISSUED invoice with issued_document_immutable", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    const res = await documentsUpdate(m.ctx, { id, tax_treatment: "export_zero_rated" })
    expect(res.status).toBe("error")
    if (res.status === "error") expect(res.error.code).toBe("issued_document_immutable")
  })

  test("rejects a counterparty_name / counterparty_vat_id edit on an ISSUED invoice (legal identity is frozen)", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueSampleInvoice(m)
    const nameRes = await documentsUpdate(m.ctx, {
      id,
      counterparty_name: "Different Legal Entity SARL",
    })
    expect(nameRes.status).toBe("error")
    if (nameRes.status === "error") expect(nameRes.error.code).toBe("issued_document_immutable")
    const vatRes = await documentsUpdate(m.ctx, { id, counterparty_vat_id: "FR99999999999" })
    expect(vatRes.status).toBe("error")
    if (vatRes.status === "error") expect(vatRes.error.code).toBe("issued_document_immutable")
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    expect(doc.counterparty_name).not.toBe("Different Legal Entity SARL")
  })

  test("still ALLOWS a metadata (address/email) edit on an ISSUED invoice without a legal original", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issueLegacyInvoice(m)
    const res = await documentsUpdate(m.ctx, {
      id,
      counterparty_address: "9 rue Corrigee",
      counterparty_email: "fixed@buyer.example",
    })
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    expect(doc.counterparty_address).toBe("9 rue Corrigee")
    expect(doc.counterparty_email).toBe("fixed@buyer.example")
  })

  test("financial-substance fields ARE editable while the document is still a DRAFT", async () => {
    // The freeze applies only post-issue: on a draft, lines + tax + counterparty name all still edit.
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await draftSampleInvoice(m)
    const res = await documentsUpdate(m.ctx, {
      id,
      counterparty_name: "Draft Rename SARL",
      lines: [
        {
          description: "Draft line",
          quantity: "1",
          unit_price_minor: 4_000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    expect(doc.counterparty_name).toBe("Draft Rename SARL")
    expect(doc.subtotal_minor).toBe("4000")
  })

  // A proforma, a quote and a purchase order are not accounting documents: the issued freeze is
  // for invoices and credit notes only. An issued proforma at 0 that must declare 1.00 used to be
  // uncorrectable (issued_document_immutable here, and the create tool converged onto it).
  const zeroLine = [
    {
      position: 1,
      description: "Return for repair: no commercial value",
      quantity: "1",
      unit_price_minor: 0n,
      product_source: null,
      external_id: null,
    },
  ]
  test("an ISSUED proforma accepts a lines replacement: totals recompute, the edit is logged, the PDF re-renders", async () => {
    const m = makeCtx({ approval: PRE_APPROVED })
    const r = await proformaCreateAndIssue(m.ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "USD",
      reason: "return",
      items: zeroLine,
      shopify_order_id: "gid://shopify/Order/3446",
    })
    if (r.status !== "completed") throw new Error(`issue failed: ${JSON.stringify(r)}`)
    const before = m.db.__all("documents").find((d) => d.id === r.document_id)!
    expect(before.status).toBe("issued")
    expect(String(before.grand_total_minor)).toBe("0")
    m.extras.renderCalls.length = 0
    const res = await documentsUpdate(m.ctx, {
      id: r.document_id,
      lines: [{ ...zeroLine[0]!, unit_price_minor: 100n }],
    })
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.id === r.document_id)!
    expect(String(doc.subtotal_minor)).toBe("100")
    const lines = m.db.__all("document_lines").filter((l) => l.document_id === r.document_id)
    expect(lines).toHaveLength(1)
    expect(String(lines[0]!.unit_price_minor)).toBe("100")
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    expect(log.at(-1)).toMatchObject({ event: "edited" })
    expect((log.at(-1)!.fields as string[]).includes("lines")).toBe(true)
    expect(m.extras.renderCalls.length).toBeGreaterThanOrEqual(1)
    // Still the same document: number and status untouched.
    expect(doc.number).toBe(before.number)
    expect(doc.status).toBe("issued")
  })

  test("an ISSUED purchase order accepts lines, tax_treatment and counterparty_name edits", async () => {
    const m = makeCtx({ approval: PRE_APPROVED })
    const r = await poCreateAndIssue(m.ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    if (r.status !== "completed") throw new Error(`issue failed: ${JSON.stringify(r)}`)
    const res = await documentsUpdate(m.ctx, {
      id: r.document_id,
      counterparty_name: "Renamed Supplier SARL",
      lines: [{ ...sampleDraftItems[0]!, quantity: "3" }],
    })
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.id === r.document_id)!
    expect(doc.counterparty_name).toBe("Renamed Supplier SARL")
    expect(String(doc.subtotal_minor)).toBe("15000")
  })

  test("an ISSUED credit note stays frozen (accounting document)", async () => {
    const m = makeCtx({ approval: PRE_APPROVED, issuerThresholdMinor: null })
    const inv = await invoiceCreateAndIssue(m.ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    if (inv.status !== "completed") throw new Error("unreachable")
    const cn = await creditNoteCreateAndIssue(m.ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      original_document_id: inv.document_id,
      items: [
        {
          position: 1,
          description: "Widget",
          quantity: "1",
          unit_price_minor: -5_000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    if (cn.status !== "completed") throw new Error(`credit note failed: ${JSON.stringify(cn)}`)
    const res = await documentsUpdate(m.ctx, {
      id: cn.document_id,
      lines: [
        {
          position: 1,
          description: "Widget",
          quantity: "2",
          unit_price_minor: -5_000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(res.status).toBe("error")
    if (res.status === "error") expect(res.error.code).toBe("issued_document_immutable")
  })
})

describe("per-shipment proformas (shipment_ref)", () => {
  // A Shopify order shipped in several physical batches needs ONE proforma per
  // batch, while the legal invoice for the order stays unique. The uniqueness
  // key is (shopify_order_id, scope, shipment_ref); rows with shipment_ref NULL
  // keep the historical one-document-per-(order, scope) behavior.
  const approvalOpts = {
    approval: {
      approvalRequestId: "appr-ship-1",
      approvalDeciderId: "user-2",
      toolName: "invoicing:proforma_create_and_issue",
    },
  }
  const baseInput = () => ({
    counterparty: defaultCounterparty,
    issuer_profile_id: "iss-1",
    currency: "EUR",
    items: sampleDraftItems,
    reason: "partial shipment",
    shopify_order_id: "gid://shopify/Order/7001",
  })

  test("two proformas for the same order with DIFFERENT shipment_ref both issue", async () => {
    const m = makeCtx(approvalOpts)
    const r1 = await proformaCreateAndIssue(m.ctx, { ...baseInput(), shipment_ref: "batch-1" })
    expect(r1.status).toBe("completed")
    const r2 = await proformaCreateAndIssue(m.ctx, { ...baseInput(), shipment_ref: "batch-2" })
    expect(r2.status).toBe("completed")
    if (r1.status !== "completed" || r2.status !== "completed") throw new Error("unreachable")
    expect(r2.document_id).not.toBe(r1.document_id)
    const docs = m.db.__all("documents")
    expect(docs).toHaveLength(2)
    expect(docs.map((d) => d.shipment_ref).sort()).toEqual(["batch-1", "batch-2"])
    // Both carry the order link so boxtal/operators can find the batch's proforma.
    for (const d of docs) expect(d.shopify_order_id).toBe("gid://shopify/Order/7001")
  })

  test("the SAME (order, scope, shipment_ref) twice is idempotent: returns the existing document", async () => {
    const m = makeCtx(approvalOpts)
    const r1 = await proformaCreateAndIssue(m.ctx, { ...baseInput(), shipment_ref: "batch-1" })
    expect(r1.status).toBe("completed")
    const r2 = await proformaCreateAndIssue(m.ctx, { ...baseInput(), shipment_ref: "batch-1" })
    expect(r2.status).toBe("completed")
    if (r1.status !== "completed" || r2.status !== "completed") throw new Error("unreachable")
    expect(r2.document_id).toBe(r1.document_id)
    expect(r2.number).toBe(r1.number)
    expect(m.db.__all("documents")).toHaveLength(1)
  })

  test("a NULL-shipment_ref repeat for the same order is also idempotent (legacy rows keep behaving)", async () => {
    const m = makeCtx(approvalOpts)
    const r1 = await proformaCreateAndIssue(m.ctx, baseInput())
    expect(r1.status).toBe("completed")
    const r2 = await proformaCreateAndIssue(m.ctx, baseInput())
    expect(r2.status).toBe("completed")
    if (r1.status !== "completed" || r2.status !== "completed") throw new Error("unreachable")
    expect(r2.document_id).toBe(r1.document_id)
    expect(m.db.__all("documents")).toHaveLength(1)
    // A per-shipment proforma does NOT satisfy the NULL-ref lookup and vice versa.
    const r3 = await proformaCreateAndIssue(m.ctx, { ...baseInput(), shipment_ref: "batch-9" })
    expect(r3.status).toBe("completed")
    if (r3.status !== "completed") throw new Error("unreachable")
    expect(r3.document_id).not.toBe(r1.document_id)
  })

  // The proforma at 0 for an order, then the same call with unit_price_minor 100: it used to
  // answer "completed" with the untouched 0 document, so the caller reported a change that never
  // happened. A replay with different content is a typed refusal naming the existing document.
  const pricedInput = (unit: bigint) => ({
    ...baseInput(),
    currency: "USD",
    items: [{ ...sampleDraftItems[0]!, quantity: "1", unit_price_minor: unit }],
  })

  test("the SAME key with DIFFERENT lines is refused (already_exists_different_content), nothing changes", async () => {
    const m = makeCtx(approvalOpts)
    const r1 = await proformaCreateAndIssue(m.ctx, pricedInput(0n))
    if (r1.status !== "completed") throw new Error("unreachable")
    const r2 = await proformaCreateAndIssue(m.ctx, {
      ...pricedInput(100n),
      // Not a key: a different human order name must not dodge the dedup either.
      shopify_order_number: "#3446-RET",
    })
    expect(r2.status).toBe("error")
    if (r2.status === "error") {
      expect(r2.error.code).toBe("already_exists_different_content")
      expect(r2.error.message).toContain(r1.number)
      expect(r2.error.message).toContain(r1.document_id)
      expect(r2.error.message).toMatch(/documents_update/)
      expect(r2.error.message).toMatch(/only shipment_ref distinguishes/i)
      expect(r2.error.message).toMatch(/shopify_order_number/)
    }
    expect(m.db.__all("documents")).toHaveLength(1)
    const doc = m.db.__all("documents")[0]!
    expect(String(doc.grand_total_minor)).toBe("0")
  })

  test("the different-content refusal happens at STAGE time: no approval card is parked", async () => {
    const seeded = makeCtx(approvalOpts)
    const r1 = await proformaCreateAndIssue(seeded.ctx, pricedInput(0n))
    expect(r1.status).toBe("completed")
    // A fresh, un-approved context over the same data: the gated tool's preflight runs first.
    const staged = makeCtx({
      seed: {
        documents: seeded.db.__all("documents"),
        document_lines: seeded.db.__all("document_lines"),
      },
    })
    const pre = await proformaCreateAndIssuePreflight(staged.ctx, pricedInput(100n))
    expect("error" in pre && pre.error.code).toBe("already_exists_different_content")
    // And a true replay still passes the preflight (it converges at execution).
    const same = await proformaCreateAndIssuePreflight(staged.ctx, pricedInput(0n))
    expect("error" in same).toBe(false)
    expect(staged.extras.approvalsRequested).toHaveLength(0)
  })

  test("a true replay under prices_include_tax (same GROSS figures) still converges", async () => {
    const inclusive = [
      { ...seedIssuer(defaultIssuer, { invoice: null, po: null }), prices_include_tax: true },
    ]
    const m = makeCtx({ ...approvalOpts, seed: { issuer_profiles: inclusive } })
    const input = {
      ...baseInput(),
      items: [{ ...sampleDraftItems[0]!, unit_price_minor: 12_000n }],
    }
    const r1 = await proformaCreateAndIssue(m.ctx, input)
    if (r1.status !== "completed") throw new Error(`issue failed: ${JSON.stringify(r1)}`)
    const stored = m.db.__all("document_lines").find((l) => l.document_id === r1.document_id)!
    expect(String(stored.unit_price_minor)).toBe("10000") // netted on issue
    const r2 = await proformaCreateAndIssue(m.ctx, input)
    expect(r2.status).toBe("completed")
    if (r2.status === "completed") expect(r2.document_id).toBe(r1.document_id)
    expect(m.db.__all("documents")).toHaveLength(1)
  })
})

// ── prices_include_tax (typed prices are gross) ───────────────────────────
//
// The issuer-profile setting that mirrors the Shopify shop's "include tax in prices". With it on,
// a price typed on a line is the GROSS price: the document stores the net amount and shows the VAT
// it contained, instead of adding VAT on top of the typed figure.

describe("issuer prices_include_tax", () => {
  const inclusiveIssuerSeed = [
    { ...seedIssuer(defaultIssuer, { invoice: null, po: null }), prices_include_tax: true },
  ]
  const typed120 = [
    {
      position: 1,
      description: "Widget",
      quantity: "1",
      unit_price_minor: 12_000n,
      product_source: null,
      external_id: null,
    },
  ]

  test("standalone quote: 120.00 typed for a FR customer issues 100.00 net plus 20.00 VAT", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: typed120,
    })
    expect(r.status).toBe("completed")
    const doc = issuedDocs(db).find((d) => d.type === "quote")!
    expect(String(doc.subtotal_minor)).toBe("10000")
    expect(String(doc.tax_total_minor)).toBe("2000")
    expect(String(doc.grand_total_minor)).toBe("12000")
    // The stored LINE carries the net unit price, which is what the document model means.
    const line = db.__all("document_lines").find((l) => l.document_id === doc.id)!
    expect(String(line.unit_price_minor)).toBe("10000")
  })

  test("standalone quote with the setting OFF: 120.00 typed is net, VAT is added on top", async () => {
    const { ctx, db } = makeCtx()
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: typed120,
    })
    expect(r.status).toBe("completed")
    const doc = issuedDocs(db).find((d) => d.type === "quote")!
    expect(String(doc.subtotal_minor)).toBe("12000")
    expect(String(doc.tax_total_minor)).toBe("2400")
    expect(String(doc.grand_total_minor)).toBe("14400")
  })

  test("export customer: there is no included tax to remove, so 120.00 stays 120.00 net", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: {
        ...defaultCounterparty,
        country: "US",
        vat_id: null,
      },
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: typed120,
    })
    expect(r.status).toBe("completed")
    const doc = issuedDocs(db).find((d) => d.type === "quote")!
    expect(String(doc.subtotal_minor)).toBe("12000")
    expect(String(doc.tax_total_minor)).toBe("0")
    expect(String(doc.grand_total_minor)).toBe("12000")
  })

  test("typed invoice: the same division happens on invoice_create_and_issue", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: typed120,
    })
    expect(r.status).toBe("completed")
    const doc = issuedDocs(db).find((d) => d.type === "invoice")!
    expect(String(doc.subtotal_minor)).toBe("10000")
    expect(String(doc.tax_total_minor)).toBe("2000")
  })

  test("drafts_create stores the NET unit price so the draft and the issued document agree", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const draft = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: typed120,
    })
    const line = db.__all("document_lines").find((l) => l.document_id === draft.draft_id)!
    expect(String(line.unit_price_minor)).toBe("10000")
  })

  test("Shopify path: the typed 120.00 goes to Shopify untouched (the shop prices gross too)", async () => {
    const { ctx, extras } = makeCtx({
      seed: {
        issuer_profiles: [
          {
            ...seedIssuer(defaultIssuer, { invoice: null, po: null }),
            shopify_shop_id: "acme.myshopify.com",
            prices_include_tax: true,
          },
        ],
      },
      executeToolImpl: async (name) => {
        if (name === "shopify:draft_orders_create")
          return {
            status: "completed",
            result: { draftOrder: { id: "gid://shopify/DraftOrder/91", name: "#D91" } },
          }
        if (name === "shopify:draft_orders_get")
          return { status: "error", error: { code: "not_found", message: "no draft order" } }
        return { status: "completed", result: {} }
      },
    })
    await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: typed120,
    })
    const created = extras.executeToolCalls.find((c) => c.name === "shopify:draft_orders_create")!
    const args = (created.args as { input: Record<string, unknown> }).input
    expect(args.lineItems).toEqual([
      {
        title: "Widget",
        quantity: 1,
        originalUnitPriceWithCurrency: { amount: "120.00", currencyCode: "EUR" },
      },
    ])
  })
})

// ── document_lines.unit_price_minor is always NET, at every write site ────
//
// Pins the premise the partial-reversal VAT allocation depends on: whatever entry point writes a
// document_lines row, unit_price_minor is stored NET of tax, even under an issuer with
// prices_include_tax on (where a typed price is gross and must be divided). Uses a rate (FR
// domestic 20%, 2000 bp) where net and gross visibly differ: 100.00 typed/gross -> 8333 stored,
// never 10000. Credit-note items are the one documented exception -- they are reversal amounts
// mirroring an already-net original, not a typed retail price -- and are pinned to stay
// UNCHANGED (never divided) in both pricing modes.
describe("document_lines always stores NET (every write path, inclusive issuer)", () => {
  const inclusiveIssuerSeed = [
    { ...seedIssuer(defaultIssuer, { invoice: null, po: null }), prices_include_tax: true },
  ]
  const typedGross100 = [
    {
      description: "Widget",
      quantity: "1",
      unit_price_minor: 10_000n,
      product_source: null,
      external_id: null,
    },
  ]
  const placeholderLine = [
    {
      description: "Placeholder",
      quantity: "1",
      unit_price_minor: 1_000n,
      product_source: null,
      external_id: null,
    },
  ]

  test("a: drafts_create then invoice_issue stores NET", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: typedGross100,
    })
    const res = await invoiceIssue(ctx, { draft_id })
    expect(res.status).toBe("completed")
    if (res.status !== "completed") throw new Error("unreachable")
    const line = db.__all("document_lines").find((l) => l.document_id === res.document_id)!
    expect(String(line.unit_price_minor)).toBe("8333")
  })

  // Regression: drafts_update used to persist a freshly-typed line VERBATIM (no netLinesForIssuer
  // call at all), so replacing a draft's lines under an inclusive issuer stored the gross figure
  // untouched all the way through to the issued document — this fails without the mutations.ts fix.
  test("b: drafts_create (placeholder) + drafts_update (replaces the line) + invoice_issue stores NET", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: placeholderLine,
    })
    await draftsUpdate(ctx, { draft_id, patch: { lines: typedGross100 } })
    const res = await invoiceIssue(ctx, { draft_id })
    expect(res.status).toBe("completed")
    if (res.status !== "completed") throw new Error("unreachable")
    const line = db.__all("document_lines").find((l) => l.document_id === res.document_id)!
    expect(String(line.unit_price_minor)).toBe("8333")
  })

  // Regression: same gap as (b) but via documents_update's line-replacement branch, which also
  // edits a still-draft document's lines directly (and an OPEN quote's) — it recomputed totals
  // from the raw typed line with no netLinesForIssuer call.
  test("documents_update line replacement on a still-draft document stores NET", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: placeholderLine,
    })
    const res = await documentsUpdate(ctx, { id: draft_id, lines: typedGross100 })
    expect(res.status).toBe("completed")
    const line = db.__all("document_lines").find((l) => l.document_id === draft_id)!
    expect(String(line.unit_price_minor)).toBe("8333")
  })

  test("c: invoice_create_and_issue stores NET", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const res = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: typedGross100,
    })
    expect(res.status).toBe("completed")
    if (res.status !== "completed") throw new Error("unreachable")
    const line = db.__all("document_lines").find((l) => l.document_id === res.document_id)!
    expect(String(line.unit_price_minor)).toBe("8333")
  })

  test("d: documents_convert_to_invoice mirrors an already-NET source line, never dividing it again", async () => {
    const { ctx, db } = makeCtx({
      seed: { issuer_profiles: inclusiveIssuerSeed },
      issuerThresholdMinor: null,
    })
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-0000000001f0",
      type: "quote",
      status: "accepted",
      number: "QUO-2026-9200",
      number_int: 9200,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      billing_line1: "1 rue Buyer",
      billing_postcode: "75002",
      billing_city: "Paris",
      billing_country_code: "FR",
      currency: "EUR",
      subtotal_minor: "8333",
      tax_total_minor: "1667",
      grand_total_minor: "10000",
      tax_treatment: "eu_domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      external_refs: {},
      lifecycle_log: [],
    })
    await db.insert("document_lines", {
      id: "ql-net-1",
      document_id: "00000000-0000-4000-8000-0000000001f0",
      position: 1,
      description: "Widget",
      quantity: "1",
      unit_price_minor: "8333", // already NET, as issueDocument would have stored it
      tax_rate_bp: null,
      subtotal_minor: "8333",
      tax_minor: "1667",
      total_minor: "10000",
    })
    const r = await documentsConvertToInvoice(ctx, {
      operation_category: "goods",
      source_document_id: "00000000-0000-4000-8000-0000000001f0",
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    const line = db.__all("document_lines").find((l) => l.document_id === r.document_id)!
    expect(String(line.unit_price_minor)).toBe("8333")
  })

  test("f: credit_note_create_and_issue never divides tax out of reversal amounts", async () => {
    const { ctx, db } = makeCtx({
      approval: PRE_APPROVED,
      seed: { issuer_profiles: inclusiveIssuerSeed },
    })
    const cn = await creditNoteCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          description: "Refund",
          quantity: "1",
          unit_price_minor: -10_000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(cn.status).toBe("completed")
    if (cn.status !== "completed") throw new Error("unreachable")
    const line = db.__all("document_lines").find((l) => l.document_id === cn.document_id)!
    expect(String(line.unit_price_minor)).toBe("-10000")
  })

  // Regression: drafts_create applied netLinesForIssuer to EVERY type including credit_note, so a
  // credit_note draft (the documented credit_note_issue flow: "Issue a credit note from a draft")
  // divided its reversal amount out under an inclusive issuer — disagreeing with the direct
  // credit_note_create_and_issue tool on the identical conceptual input.
  test("f (draft): a credit_note draft + credit_note_issue also never divides tax out", async () => {
    const { ctx, db } = makeCtx({
      approval: PRE_APPROVED,
      seed: { issuer_profiles: inclusiveIssuerSeed },
    })
    const { draft_id } = await draftsCreate(ctx, {
      type: "credit_note",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          description: "Refund",
          quantity: "1",
          unit_price_minor: -10_000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    const res = await creditNoteIssue(ctx, { draft_id })
    expect(res.status).toBe("completed")
    if (res.status !== "completed") throw new Error("unreachable")
    const line = db.__all("document_lines").find((l) => l.document_id === res.document_id)!
    expect(String(line.unit_price_minor)).toBe("-10000")
  })

  test("g: order_reissue_apply's replacement invoice half stores NET", async () => {
    const { ctx, db } = makeCtx({
      approval: PRE_APPROVED,
      seed: { issuer_profiles: inclusiveIssuerSeed },
    })
    const original = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-net-1",
      shopify_order_number: "#2001",
      items: typedGross100,
    })
    expect(original.status).toBe("completed")
    if (original.status !== "completed") throw new Error("unreachable")
    const result = await orderReissueApply(ctx, {
      original_document_id: original.document_id,
      shopify_order_id: "shop-order-net-1",
      shopify_order_number: "#2001",
      billing_signature: "sig-net-1",
      dedupe_key: "shop-order-net-1:sig-net-1",
      items: typedGross100,
    })
    expect(result.status).toBe("completed")
    if (result.status !== "completed") throw new Error("unreachable")
    const line = db
      .__all("document_lines")
      .find((l) => l.document_id === result.replacement_document_id)!
    expect(String(line.unit_price_minor)).toBe("8333")
  })

  test("h: po_create_and_issue stores NET (shares createAndIssueGenerically with quote/proforma)", async () => {
    const { ctx, db } = makeCtx({
      approval: PRE_APPROVED,
      seed: { issuer_profiles: inclusiveIssuerSeed },
    })
    const res = await poCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: typedGross100,
    })
    expect(res.status).toBe("completed")
    if (res.status !== "completed") throw new Error("unreachable")
    const line = db.__all("document_lines").find((l) => l.document_id === res.document_id)!
    expect(String(line.unit_price_minor)).toBe("8333")
  })
})

// ── the write-side netting contract, and where the fix actually lives ─────
//
// netLinesForIssuer has NO way to tell "a freshly typed gross price" apart from "the same net
// price echoed back unchanged" -- both arrive as a bare `lines` patch, and the tool's own
// contract is that whatever reaches drafts_update/documents_update's line-replacement branch is
// gross-if-the-issuer-says-so, full stop (see the comment at netLinesForIssuer's definition).
// Removing the netting from these two call sites (mutations.ts:1074, :4411) would restore the
// OLDER bug -- a genuinely typed new gross price silently stored untouched -- so it stays. Which
// is exactly why the compounding-division fix lives one layer up, in the Editor (Editor.test.tsx
// "net-on-load: the Editor is the single gross boundary"): the Editor grosses a loaded document's
// net lines up ONCE so what IT echoes back on an unchanged save is always gross, never net. These
// tests pin the write-side contract itself: a genuine edit nets exactly once, and a non
// inclusive / zero-rated issuer is unaffected either way.
describe("write-side netting contract (mutations.ts, unchanged by this fix)", () => {
  const inclusiveIssuerSeed = [
    { ...seedIssuer(defaultIssuer, { invoice: null, po: null }), prices_include_tax: true },
  ]
  const nonInclusiveIssuerSeed = [seedIssuer(defaultIssuer, { invoice: null, po: null })]
  const typedGross299 = [
    {
      position: 1,
      description: "Widget",
      quantity: "1",
      unit_price_minor: 29_900n,
      product_source: null,
      external_id: null,
    },
  ]

  /** What the document actually has on file, in the wire shape a line-replacement patch takes
   *  (unit_price_minor as a STRING, matching documents_get / drafts_update's own serialization). */
  function readBackLines(db: MockDb, documentId: string) {
    return db
      .__all("document_lines")
      .filter((l) => l.document_id === documentId)
      .map((l) => ({
        position: l.position as number,
        description: l.description as string,
        quantity: l.quantity as string,
        unit_price_minor: String(l.unit_price_minor),
        tax_rate_bp_override: l.tax_rate_bp as number | undefined,
        product_source: null,
        external_id: null,
      }))
  }

  test("a genuinely edited price still nets exactly once", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "Widget",
          quantity: "1",
          unit_price_minor: 1_000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    // The operator types a NEW gross price on the existing draft (not a read-back echo).
    await draftsUpdate(ctx, { draft_id, patch: { lines: typedGross299 } })
    const line = db.__all("document_lines").find((l) => l.document_id === draft_id)!
    expect(String(line.unit_price_minor)).toBe("24917")
  })

  test("non inclusive issuer: a read-back save is a no-op, price is never netted", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: nonInclusiveIssuerSeed } })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: typedGross299,
    })
    const afterCreate = db.__all("document_lines").find((l) => l.document_id === draft_id)!
    expect(String(afterCreate.unit_price_minor)).toBe("29900")

    const readBack = readBackLines(db, draft_id)
    await draftsUpdate(ctx, { draft_id, patch: { lines: readBack } })
    const afterSave = db.__all("document_lines").find((l) => l.document_id === draft_id)!
    expect(String(afterSave.unit_price_minor)).toBe("29900")
  })

  test("zero rated (export) counterparty: a read-back save is a no-op even under an inclusive issuer", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_country: "US",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: typedGross299,
    })
    const afterCreate = db.__all("document_lines").find((l) => l.document_id === draft_id)!
    // No included tax to remove on an export line — stored exactly as typed.
    expect(String(afterCreate.unit_price_minor)).toBe("29900")

    const readBack = readBackLines(db, draft_id)
    await draftsUpdate(ctx, { draft_id, patch: { lines: readBack } })
    const afterSave = db.__all("document_lines").find((l) => l.document_id === draft_id)!
    expect(String(afterSave.unit_price_minor)).toBe("29900")
  })
})

// ── documents_update excludes the Shopify draft-order sync from netting ───
//
// The AUTOMATED counterpart of the Editor compounding bug, and worse: no human is in the loop.
// onShopifyDraftOrderUpsert (handlers/shopify-draft-order.ts:606) calls documentsUpdate with
// `lines` built by draftOrderLinesToItems, which already netted them via netOfIncludedTax
// (shopify-draft-order.ts:243-247). mutations.ts:4411's line-replacement netting has no way to
// tell that apart from a genuinely typed gross price, so a re-sync of the SAME open quote under
// an inclusive issuer would divide the included tax out a second time, silently, on every webhook
// delivery, unless something tells it those specific lines are already net.
//
// The exemption is CALLER scoped, via the internal `lines_are_net` input (never a manifest
// param, so no agent/UI caller can set it) — NOT document scoped. A document-scoped exemption
// (e.g. keying off the document row's own shopify_draft_order_id) was tried and REJECTED: it
// would exempt EVERY caller of a Shopify-backed quote from netting, including the Editor's own
// documents_update save on that SAME open quote, which sends genuinely GROSS lines and must
// still be netted — a document-scoped exemption stored the operator's typed price as net,
// inflating it on the PDF the customer sees. Only the sync handler knows ITS OWN lines are
// already net; nothing else does. The tests below cover both the sync handler's own re-sync
// AND an Editor-style caller acting on the same Shopify-backed document, since that pairing is
// exactly what a document-scoped exemption got wrong.
describe("documents_update: Shopify draft-order sync is excluded from netting, CALLER scoped (mutations.ts:4429)", () => {
  const inclusiveIssuerSeed = [
    { ...seedIssuer(defaultIssuer, { invoice: null, po: null }), prices_include_tax: true },
  ]

  async function insertOpenSyncedQuote(db: MockDb, netUnitPriceMinor: string) {
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-0000000002a0",
      type: "quote",
      status: "sent",
      number: "QUO-2026-9300",
      number_int: 9300,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      billing_line1: "1 rue Buyer",
      billing_postcode: "75002",
      billing_city: "Paris",
      billing_country_code: "FR",
      currency: "EUR",
      subtotal_minor: netUnitPriceMinor,
      tax_total_minor: "0",
      grand_total_minor: netUnitPriceMinor,
      tax_treatment: "eu_domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      due_at: null,
      external_refs: {},
      lifecycle_log: [],
      shopify_draft_order_id: "gid://shopify/DraftOrder/9300",
      shopify_draft_order_name: "#D9300",
    })
    await db.insert("document_lines", {
      id: "sync-line-1",
      document_id: "00000000-0000-4000-8000-0000000002a0",
      position: 1,
      description: "Widget",
      quantity: "1",
      unit_price_minor: netUnitPriceMinor, // already net, as draftOrderLinesToItems produced it
      tax_rate_bp: null,
      subtotal_minor: netUnitPriceMinor,
      tax_minor: "0",
      total_minor: netUnitPriceMinor,
    })
    return "00000000-0000-4000-8000-0000000002a0"
  }

  /** What draftOrderLinesToItems (handlers/shopify-draft-order.ts) hands documentsUpdate on a
   *  re-sync: the SAME already-net price, in the DraftLineInput wire shape. */
  const syncedLines = (netUnitPriceMinor: string) => [
    {
      position: 1,
      description: "Widget",
      quantity: "1",
      unit_price_minor: netUnitPriceMinor,
      product_source: "shopify",
      external_id: "gid://shopify/ProductVariant/1",
    },
  ]

  test("the SYNC HANDLER's re-sync of an open quote (lines_are_net: true) holds its stored net value unchanged", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const id = await insertOpenSyncedQuote(db, "24917")

    // Mirrors the call onShopifyDraftOrderUpsert actually makes: lines_are_net: true, because
    // draftOrderLinesToItems already netted `items` before this call.
    const res = await documentsUpdate(ctx, { id, lines: syncedLines("24917"), lines_are_net: true })
    expect(res.status).toBe("completed")
    const line = db.__all("document_lines").find((l) => l.document_id === id)!
    expect(String(line.unit_price_minor)).toBe("24917")
    expect(String(line.unit_price_minor)).not.toBe("20764") // the compounding bug
  })

  test("a line DISCOUNT survives the line replacement, on the row and in the totals", async () => {
    // recomputeLines never read `discount_minor` and the document_lines insert
    // never wrote the column, so EVERY documents_update that replaced lines
    // silently billed the undiscounted price: the Shopify sync on every edit,
    // the Editor saving an open quote, and the agent's own documents_update.
    // Quote QUO-2026-0006 lost a 25.48 line discount exactly this way.
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const id = await insertOpenSyncedQuote(db, "14900")

    const res = await documentsUpdate(ctx, {
      id,
      lines: [{ ...syncedLines("14900")[0]!, discount_minor: 2548n }],
      lines_are_net: true,
    })
    expect(res.status).toBe("completed")

    const line = db.__all("document_lines").find((l) => l.document_id === id)!
    // The discount is on the row, explicitly, not folded into the unit price.
    expect(String(line.discount_minor)).toBe("2548")
    expect(String(line.unit_price_minor)).toBe("14900")
    // ...and subtracted from the subtotal: 149.00 - 25.48 = 123.52.
    expect(String(line.subtotal_minor)).toBe("12352")

    const doc = db.__all("documents").find((d) => d.id === id)!
    expect(String(doc.subtotal_minor)).toBe("12352")
  })

  test("TWO successive sync-handler re-syncs never compound: the second sync also holds 24917", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const id = await insertOpenSyncedQuote(db, "24917")

    await documentsUpdate(ctx, { id, lines: syncedLines("24917"), lines_are_net: true })
    const afterFirstSync = db.__all("document_lines").find((l) => l.document_id === id)!
    expect(String(afterFirstSync.unit_price_minor)).toBe("24917")

    await documentsUpdate(ctx, { id, lines: syncedLines("24917"), lines_are_net: true })
    const afterSecondSync = db.__all("document_lines").find((l) => l.document_id === id)!
    expect(String(afterSecondSync.unit_price_minor)).toBe("24917")
    expect(String(afterSecondSync.unit_price_minor)).not.toBe("17108") // two rounds of compounding
  })

  // THE MIRROR BUG a document-scoped exemption introduced, and exactly the case that slipped
  // through the first fix: the Editor opens this SAME Shopify-backed open quote, its own
  // net-on-load memo grosses the loaded line up for display/editing, and "Save changes"
  // (documents_update, WITHOUT lines_are_net -- the Editor never sets that internal field) sends
  // the GROSS figure back. A document-scoped exemption (keying off the row's own
  // shopify_draft_order_id) would have skipped netting here too and stored 29900 as if it were
  // net -- inflating the price 20% on the PDF the customer sees. The caller-scoped exemption
  // must still net this call exactly once, back down to 24917.
  test("an EDITOR-style caller (no lines_are_net) saving GROSS lines on the SAME Shopify-backed quote still nets exactly once, never inflates", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const id = await insertOpenSyncedQuote(db, "24917")

    // The Editor's buildDocumentsUpdatePatch never sets lines_are_net -- it is an internal field,
    // not something the Editor (or any manifest-exposed caller) can reach.
    const res = await documentsUpdate(ctx, {
      id,
      lines: [
        {
          position: 1,
          description: "Widget",
          quantity: "1",
          unit_price_minor: "29900", // the grossed-up figure the operator now sees/saves
          product_source: "shopify",
          external_id: "gid://shopify/ProductVariant/1",
        },
      ],
    })
    expect(res.status).toBe("completed")
    const line = db.__all("document_lines").find((l) => l.document_id === id)!
    expect(String(line.unit_price_minor)).toBe("24917") // netted exactly once
    expect(String(line.unit_price_minor)).not.toBe("29900") // NOT stored as net (the mirror bug)
  })

  test("a document with NO shopify_draft_order_id is unaffected: line replacement still nets a typed gross price", async () => {
    const { ctx, db } = makeCtx({ seed: { issuer_profiles: inclusiveIssuerSeed } })
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "Placeholder",
          quantity: "1",
          unit_price_minor: 1_000n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    const res = await documentsUpdate(ctx, {
      id: draft_id,
      lines: [
        {
          position: 1,
          description: "Widget",
          quantity: "1",
          unit_price_minor: 29_900n,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(res.status).toBe("completed")
    const line = db.__all("document_lines").find((l) => l.document_id === draft_id)!
    expect(String(line.unit_price_minor)).toBe("24917") // typed gross, netted exactly once
  })
})

// ── Free-text document notes ─────────────────────────────────────────────────
//
// `notes` is non-financial metadata (a contract reference, extra customs information, a special
// mention) printed on the PDF. Unlike po_number it is a PLAIN column: no external_refs mirror,
// no dedicated lifecycle event, no document:notes_changed emit — the generic "edited" entry and
// document:updated carry it, with the VALUE excluded from the before/after diff.
describe("document notes (free text, editable at any status)", () => {
  const noteCounterparty: Counterparty = {
    contact_id: "contact-1",
    legal_name: "Buyer SARL",
    country: "FR",
    vat_id: null,
    address: "1 rue Ancienne",
    email: "old@buyer.example",
    customer_kind: "business",
    billing_line1: "1 rue Buyer",
    billing_postcode: "75002",
    billing_city: "Paris",
  }

  async function issuedInvoice(m: ReturnType<typeof makeCtx>, notes?: string | null) {
    const r = await invoiceCreateAndIssue(m.ctx, {
      operation_category: "goods",
      counterparty: noteCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
      ...(notes === undefined ? {} : { notes }),
    })
    if (r.status !== "completed") throw new Error("setup issue failed")
    return r.document_id
  }

  // red: put "notes" in ISSUED_FROZEN_FIELDS (or drop the `"notes" in rawInput` branch) -> a
  // contract reference can never be added to an invoice that has already gone out.
  test("sets notes on an ISSUED invoice without the immutability error, and re-renders the PDF with them", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issuedInvoice(m)
    m.extras.renderCalls.length = 0
    const res = await documentsUpdate(m.ctx, {
      id,
      notes: "Contract FR-2026-118, delivery in 2 batches",
    })
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    expect(doc.status).toBe("issued")
    expect(doc.notes).toBe("Contract FR-2026-118, delivery in 2 batches")
    // The customer-facing face is re-rendered with the new text, exactly like po_number.
    expect(m.extras.renderCalls.length).toBeGreaterThanOrEqual(1)
    const lastRender = m.extras.renderCalls[m.extras.renderCalls.length - 1]!
    const renderDoc = (lastRender.data as { document: Record<string, unknown> }).document
    expect(renderDoc.notes).toBe("Contract FR-2026-118, delivery in 2 batches")
  })

  // red: drop `changedFields.push("notes")` -> the audit trail never records that the
  // customer-facing text changed.
  test("records the edit as a generic 'edited' lifecycle entry naming notes, with no notes_changed event", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issuedInvoice(m)
    m.extras.emittedAttention.length = 0
    await documentsUpdate(m.ctx, { id, notes: "Customs: goods of FR origin" })
    const doc = m.db.__all("documents").find((d) => d.id === id)!
    const log = doc.lifecycle_log as Array<Record<string, unknown>>
    const edited = log.filter((e) => e.event === "edited")
    expect((edited[edited.length - 1]?.fields as string[]) ?? []).toContain("notes")
    expect(log.some((e) => e.event === "notes_changed")).toBe(false)
    expect(m.extras.emittedAttention.some((e) => e.action === "notes_changed")).toBe(false)
    const updated = m.extras.emittedAttention.find((e) => e.action === "updated")
    expect(updated, "document:updated must still be emitted").toBeDefined()
    const data = updated!.data as { changed_fields: string[]; changes: Record<string, unknown> }
    expect(data.changed_fields).toContain("notes")
    // DOCUMENT_UPDATED_DIFF_EXCLUDED_FIELDS: the field NAME is fine in the audit trail, the
    // free-text VALUE is not copied into it.
    expect(Object.keys(data.changes)).not.toContain("notes")
  })

  // red: drop the trim/blank handling in normaliseNotes -> "  " is stored as a blank string and
  // the PDF grows an empty "Notes" heading.
  test("trims the value, and stores a blank/whitespace-only note as null", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issuedInvoice(m)
    await documentsUpdate(m.ctx, { id, notes: "   Please quote our ref on the packing list   " })
    expect(m.db.__all("documents").find((d) => d.id === id)!.notes).toBe(
      "Please quote our ref on the packing list",
    )
    await documentsUpdate(m.ctx, { id, notes: "   " })
    expect(m.db.__all("documents").find((d) => d.id === id)!.notes).toBeNull()
    await documentsUpdate(m.ctx, { id, notes: null })
    expect(m.db.__all("documents").find((d) => d.id === id)!.notes).toBeNull()
  })

  // red: drop the length cap -> a pasted email thread lands on the column and pushes the legal
  // mention and the payment box off the rendered document.
  test("rejects a note over 2000 characters with a typed notes_too_long error and persists nothing", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issuedInvoice(m)
    const res = await documentsUpdate(m.ctx, { id, notes: "x".repeat(2001) })
    expect(res.status).toBe("error")
    if (res.status !== "error") throw new Error("unreachable")
    expect(res.error.code).toBe("notes_too_long")
    expect(m.db.__all("documents").find((d) => d.id === id)!.notes).toBeNull()
    // Exactly at the cap is accepted.
    const ok = await documentsUpdate(m.ctx, { id, notes: "y".repeat(2000) })
    expect(ok.status).toBe("completed")
    expect(String(m.db.__all("documents").find((d) => d.id === id)!.notes)).toHaveLength(2000)
  })

  test("invoice_create_and_issue persists notes on the issued document", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const id = await issuedInvoice(m, "  Payable against contract 44-B  ")
    expect(m.db.__all("documents").find((d) => d.id === id)!.notes).toBe(
      "Payable against contract 44-B",
    )
  })

  test("drafts_create persists notes, and issuing the draft carries them onto the document", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const draft = await draftsCreate(m.ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Ancienne",
      counterparty_email: "old@buyer.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      notes: "Ref: framework agreement 2026/12",
      items: sampleDraftItems,
    })
    expect(m.db.__all("documents").find((d) => d.id === draft.draft_id)!.notes).toBe(
      "Ref: framework agreement 2026/12",
    )
    const issued = await invoiceIssue(m.ctx, { draft_id: draft.draft_id })
    expect(issued.status).toBe("completed")
    if (issued.status !== "completed") throw new Error("unreachable")
    expect(m.db.__all("documents").find((d) => d.id === issued.document_id)!.notes).toBe(
      "Ref: framework agreement 2026/12",
    )
  })

  test("drafts_update patches notes on a draft", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const draft = await draftsCreate(m.ctx, {
      type: "quote",
      counterparty_contact_id: "contact-1",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    await draftsUpdate(m.ctx, { draft_id: draft.draft_id, patch: { notes: "  Valid 30 days  " } })
    expect(m.db.__all("documents").find((d) => d.id === draft.draft_id)!.notes).toBe(
      "Valid 30 days",
    )
  })

  // red: drop the `notes` carry-forward in documentsConvertToInvoice -> the accepted quote's
  // special mention silently disappears from the invoice the customer is asked to pay.
  test("carries the source quote's notes onto the converted invoice, and an explicit note wins", async () => {
    const m = makeCtx({ issuerThresholdMinor: null })
    const quote = await quoteCreateAndIssue(m.ctx, {
      counterparty: noteCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      notes: "Installation on site included",
      items: sampleDraftItems,
    })
    if (quote.status !== "completed") throw new Error("setup quote failed")
    expect(m.db.__all("documents").find((d) => d.id === quote.document_id)!.notes).toBe(
      "Installation on site included",
    )
    const converted = await documentsConvertToInvoice(m.ctx, {
      operation_category: "goods",
      source_document_id: quote.document_id,
    })
    expect(converted.status).toBe("completed")
    if (converted.status !== "completed") throw new Error("unreachable")
    expect(m.db.__all("documents").find((d) => d.id === converted.document_id)!.notes).toBe(
      "Installation on site included",
    )

    const quote2 = await quoteCreateAndIssue(m.ctx, {
      counterparty: noteCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      notes: "Installation on site included",
      items: sampleDraftItems,
    })
    if (quote2.status !== "completed") throw new Error("setup quote failed")
    const converted2 = await documentsConvertToInvoice(m.ctx, {
      operation_category: "goods",
      source_document_id: quote2.document_id,
      notes: "Installation quoted separately",
    })
    if (converted2.status !== "completed") throw new Error("unreachable")
    expect(m.db.__all("documents").find((d) => d.id === converted2.document_id)!.notes).toBe(
      "Installation quoted separately",
    )
  })

  // red: drop the notes inheritance in creditNoteCreateAndIssue -> the reversal loses the
  // reference the customer reads on both documents.
  test("a credit note inherits the original invoice's notes when none are given explicitly", async () => {
    const m = makeCtx({ approval: PRE_APPROVED, issuerThresholdMinor: null })
    const id = await issuedInvoice(m, "Contract FR-2026-118")
    const cn = await creditNoteCreateAndIssue(m.ctx, {
      operation_category: "goods",
      counterparty: noteCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      original_document_id: id,
      items: [
        {
          description: "Widget",
          quantity: "1",
          unit_price_minor: -10_000,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(cn.status).toBe("completed")
    if (cn.status !== "completed") throw new Error("unreachable")
    expect(m.db.__all("documents").find((d) => d.id === cn.document_id)!.notes).toBe(
      "Contract FR-2026-118",
    )
  })

  // red: drop the notes thread-through in orderReissueApply -> an order edit strips the
  // customer's mention off both replacement documents.
  test("order_reissue_apply carries the original's notes onto BOTH the credit note and the replacement", async () => {
    const m = makeCtx()
    const original = await invoiceCreateAndIssue(m.ctx, {
      operation_category: "goods",
      counterparty: noteCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-notes1",
      shopify_order_number: "#2001",
      notes: "Contract FR-2026-118",
      items: sampleDraftItems,
    })
    if (original.status !== "completed") throw new Error("setup issue failed")
    const result = await orderReissueApply(m.ctx, {
      original_document_id: original.document_id,
      shopify_order_id: "shop-order-notes1",
      shopify_order_number: "#2001",
      billing_signature: "sig-notes1",
      dedupe_key: "shop-order-notes1:sig-notes1",
      items: [
        {
          description: "Widget",
          quantity: "3",
          unit_price_minor: 6_000,
          product_source: null,
          external_id: null,
        },
      ],
    })
    expect(result.status).toBe("completed")
    if (result.status !== "completed") throw new Error("unreachable")
    expect(
      m.db.__all("documents").find((d) => d.id === result.credit_note_document_id)!.notes,
    ).toBe("Contract FR-2026-118")
    expect(
      m.db.__all("documents").find((d) => d.id === result.replacement_document_id)!.notes,
    ).toBe("Contract FR-2026-118")
  })
})

// ── Stage-time preflights for the gated tools ─────────────────────────────
//
// Every tool below is `gated: true` in the manifest: the kernel parks an approval request and a
// human decides it before the handler ever runs. Its required data is therefore validated TWICE:
// once by the manifest `preflight` (these tests), on the way IN to the approval, and again by the
// handler, on the way out of it. What these tests pin is the first half: an incomplete call is
// refused at CALL time, with the same typed error the handler would have raised, so nothing is
// parked for a human who can only watch it fail. Each asserts the error code AND that the handler
// was not reached (no write, no approval, no render, no cross-app send).
describe("gated-tool stage-time preflights", () => {
  const issuedInvoiceRow = (over: Record<string, unknown> = {}) => ({
    id: "00000000-0000-4000-8000-0000000009a1",
    type: "invoice",
    status: "issued",
    number: "INV-2026-900",
    number_int: 900,
    year_of_issue: 2026,
    issuer_profile_id: "iss-1",
    counterparty_contact_id: "contact-1",
    counterparty_name: "Buyer SARL",
    counterparty_address: "1 rue Buyer, 75002 Paris",
    counterparty_email: "ap@buyersarl.example",
    counterparty_country: "FR",
    currency: "EUR",
    subtotal_minor: "10000",
    tax_total_minor: "2000",
    grand_total_minor: "12000",
    tax_treatment: "domestic",
    incoterm: "DAP",
    issued_at: "2026-05-28",
    due_at: null,
    pdf_file_id: "pdf-pre",
    pdf_status: "ready",
    external_refs: {},
    lifecycle_log: [],
    ...over,
  })

  test("documents_send_to_customer: no send-from mail account refuses at staging, nothing is sent", async () => {
    const { ctx, db, extras } = makeCtx({ mailAccountId: null })
    await db.insert("documents", issuedInvoiceRow())
    const r = await documentsSendToCustomerPreflight(ctx, {
      document_id: "00000000-0000-4000-8000-0000000009a1",
      to: "buyer@example.com",
    })
    expect("error" in r && r.error.code).toBe("no_mail_account")
    // Handler not reached: no PDF render, no mail dispatch, no approval parked.
    expect(extras.renderCalls).toHaveLength(0)
    expect(extras.executeToolCalls.filter((c) => c.name.startsWith("mail:"))).toHaveLength(0)
    expect(extras.approvalsRequested).toHaveLength(0)
  })

  test("documents_send_to_customer: a counterparty with no email anywhere refuses at staging", async () => {
    const { ctx, db, extras } = makeCtx()
    await db.insert(
      "documents",
      issuedInvoiceRow({ counterparty_name: null, counterparty_email: null }),
    )
    const r = await documentsSendToCustomerPreflight(ctx, {
      document_id: "00000000-0000-4000-8000-0000000009a1",
    })
    expect("error" in r && r.error.code).toBe("no_recipient")
    expect(extras.executeToolCalls.filter((c) => c.name.startsWith("mail:"))).toHaveLength(0)
  })

  test("invoice_issue: an unresolvable draft refuses at staging, no document is written", async () => {
    const { ctx, db, extras } = makeCtx()
    const before = db.__all("documents").length
    const r = await invoiceIssuePreflight(ctx, {
      draft_id: "00000000-0000-4000-8000-00000000dead",
    })
    expect("error" in r && r.error.code).toBe("not_found")
    expect(db.__all("documents")).toHaveLength(before)
    expect(extras.approvalsRequested).toHaveLength(0)
  })

  test("invoice_create_and_issue: an order that already has a live invoice refuses at staging", async () => {
    const { ctx, db, extras } = makeCtx()
    const first = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-preflight-1",
      items: sampleDraftItems,
    })
    expect(first.status).toBe("completed")
    const before = db.__all("documents").length
    const r = await invoiceCreateAndIssuePreflight(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      shopify_order_id: "shop-order-preflight-1",
      items: sampleDraftItems,
    })
    expect("error" in r && r.error.code).toBe("already_invoiced")
    // No second invoice, and no approval card parked for a duplicate that could never issue.
    expect(db.__all("documents")).toHaveLength(before)
    expect(extras.approvalsRequested).toHaveLength(0)
  })

  test("documents_convert_to_invoice: an already converted quote refuses at staging", async () => {
    const { ctx, db, extras } = makeCtx()
    await db.insert("documents", {
      ...issuedInvoiceRow(),
      id: "00000000-0000-4000-8000-0000000009b2",
      type: "quote",
      status: "invoiced",
      number: "QUO-2026-900",
    })
    const before = db.__all("documents").length
    const r = await documentsConvertToInvoicePreflight(ctx, {
      source_document_id: "00000000-0000-4000-8000-0000000009b2",
    })
    expect("error" in r && r.error.code).toBe("invalid_transition")
    expect(db.__all("documents")).toHaveLength(before)
    expect(extras.approvalsRequested).toHaveLength(0)
  })

  test("documents_record_refund: an over-refund refuses at staging, the document is untouched", async () => {
    const { ctx, db } = makeCtx()
    await db.insert(
      "documents",
      issuedInvoiceRow({
        status: "paid",
        payment_status: "partial",
        lifecycle_log: [{ event: "partial_refund_recorded", refund_amount_minor: "10000" }],
      }),
    )
    const r = await documentsRecordRefundPreflight(ctx, {
      document_id: "00000000-0000-4000-8000-0000000009a1",
      refund_amount_minor: 5_000n,
      refund_kind: "partial",
    })
    expect("error" in r && r.error.code).toBe("invalid_amount")
    // Handler not reached: no second refund entry, payment_status unchanged.
    const doc = db.__all("documents").find((d) => d.id === "00000000-0000-4000-8000-0000000009a1")!
    expect(doc.lifecycle_log as unknown[]).toHaveLength(1)
    expect(doc.payment_status).toBe("partial")
  })

  test("documents_mark_paid: a draft cannot be marked paid, refused at staging", async () => {
    const { ctx, db } = makeCtx()
    await db.insert("documents", issuedInvoiceRow({ status: "draft", number: null }))
    const r = await documentsMarkPaidPreflight(ctx, {
      document_id: "00000000-0000-4000-8000-0000000009a1",
    })
    expect("error" in r && r.error.code).toBe("invalid_transition")
    const doc = db.__all("documents").find((d) => d.id === "00000000-0000-4000-8000-0000000009a1")!
    expect(doc.status).toBe("draft")
    expect(doc.paid_at ?? null).toBeNull()
  })

  test("proforma_issue: a draft with no line items refuses at staging, no approval is parked", async () => {
    const { ctx, extras } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "proforma",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [],
    })
    const r = await proformaIssuePreflight(ctx, { draft_id })
    expect("error" in r && r.error.code).toBe("empty_document")
    // proforma_issue ALWAYS gates, so this is exactly the call that used to park a card and then
    // fail on the approver's click.
    expect(extras.approvalsRequested).toHaveLength(0)
  })

  test("proforma_create_and_issue: an ambiguous issuer profile refuses at staging", async () => {
    const { ctx, db, extras } = makeCtx({
      seed: {
        issuer_profiles: [
          seedIssuer(defaultIssuer, {}),
          seedIssuer({ ...defaultIssuer, id: "iss-2", legal_name: "Acme GmbH" }, {}),
        ],
      },
    })
    const before = db.__all("documents").length
    const r = await proformaCreateAndIssuePreflight(ctx, {
      counterparty: defaultCounterparty,
      currency: "EUR",
      reason: "customs",
      items: sampleDraftItems,
    })
    expect("error" in r && r.error.code).toBe("issuer_profile_ambiguous")
    expect(db.__all("documents")).toHaveLength(before)
    expect(extras.approvalsRequested).toHaveLength(0)
  })

  test("order_reissue_apply: a source that is a draft, not an issued invoice, refuses at staging", async () => {
    const { ctx, db, extras } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const before = db.__all("documents").length
    const r = await orderReissueApplyPreflight(ctx, {
      original_document_id: draft_id,
      shopify_order_id: "shop-order-preflight-2",
      billing_signature: "sig-1",
      dedupe_key: "shop-order-preflight-2:sig-1",
      items: sampleDraftItems,
    })
    expect("error" in r && r.error.code).toBe("invalid_original_document")
    // Handler not reached: no credit note, no replacement invoice.
    expect(db.__all("documents")).toHaveLength(before)
    expect(extras.approvalsRequested).toHaveLength(0)
  })
})

// The due_at write is a mutation of the draft of record. It must never run on a call that then
// fails validation: an id that resolves to nothing (or to the wrong kind of draft) left the
// document edited by a request that was refused.
describe("invoice_issue: due_at is applied only after the draft validates", () => {
  test("an unresolvable draft_id with due_at returns not_found instead of throwing", async () => {
    const { ctx } = makeCtx()
    const r = await invoiceIssue(ctx, {
      draft_id: "00000000-0000-4000-8000-00000000beef",
      due_at: "2026-12-31",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("not_found")
  })

  test("a draft of the wrong type keeps its own due date when the call is refused", async () => {
    const { ctx, db } = makeCtx()
    const { draft_id } = await draftsCreate(ctx, {
      type: "quote",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      due_at: "2026-01-31",
      items: sampleDraftItems,
    })
    const r = await invoiceIssue(ctx, { draft_id, due_at: "2026-12-31" })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("invalid_type")
    const draft = db.__all("documents").find((d) => d.id === draft_id)!
    expect(draft.due_at).toBe("2026-01-31")
  })
})

// ── E-invoicing gate at the manual issue sites ───────────────────────────────
// Enforce mode (makeCtx seeds it) unless the test is named "warn".
describe("e-invoicing gate at the manual issue sites", () => {
  const frPerson: Counterparty = {
    contact_id: null,
    legal_name: "Celine Exemple",
    country: "FR",
    vat_id: null,
    address: "2 avenue du Test, 69002 Lyon",
    email: "celine@exemple.example",
  }

  test("non-FR counterparty with no signal issues with no manual step", async () => {
    const { ctx, db } = makeCtx()
    const r = await invoiceCreateAndIssue(ctx, {
      counterparty: {
        ...frPerson,
        legal_name: "Alex Example",
        country: "DE",
        address: "Musterstr. 1, 10115 Berlin",
      },
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    const doc = db.__all("documents").find((d) => d.id === r.document_id)!
    expect(doc.regime).toBe("e_reporting")
    expect(doc.customer_kind).toBe("individual")
  })

  test('FR counterparty with no signal via create_and_issue is refused customer_kind_missing, then issues once customer_kind:"individual" is passed', async () => {
    const { ctx, db } = makeCtx()
    const refused = await invoiceCreateAndIssue(ctx, {
      counterparty: frPerson,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(refused.status).toBe("error")
    if (refused.status !== "error") throw new Error("unreachable")
    expect(refused.error.code).toBe("customer_kind_missing")
    expect(refused.error.retryable).toBe(true)
    expect(refused.error.status).toBe(422)
    expect(issuedDocs(db)).toHaveLength(0)
    expect(db.__sequences.size).toBe(0)

    const ok = await invoiceCreateAndIssue(ctx, {
      counterparty: { ...frPerson, customer_kind: "individual" },
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(ok.status).toBe("completed")
    if (ok.status !== "completed") throw new Error("unreachable")
    const doc = db.__all("documents").find((d) => d.id === ok.document_id)!
    expect(doc.regime).toBe("e_reporting")
    expect(doc.customer_kind).toBe("individual")
  })

  test('FR counterparty "Exemple Atelier SARL" without VAT or company is refused customer_kind_missing', async () => {
    const { ctx, extras } = makeCtx()
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: {
        ...frPerson,
        contact_id: "contact-legal-form",
        legal_name: "Exemple Atelier SARL",
      },
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("customer_kind_missing")
    // The contact's company was consulted (none recorded) before refusing.
    expect(extras.executeToolCalls.some((c) => c.name === "kernel:contacts_read")).toBe(true)
  })

  test("company signal derives business", async () => {
    const { ctx, db } = makeCtx({
      executeToolImpl: async (name) =>
        name === "kernel:contacts_read"
          ? { status: "completed", result: { contact: { company: "Exemple Atelier" } } }
          : { status: "completed", result: {} },
    })
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: {
        ...frPerson,
        contact_id: "contact-company",
        billing_postcode: "69002",
        billing_city: "Lyon",
      },
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    // Business, French, no SIREN on file: an e-invoice cannot be issued without it.
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("einvoice_data_missing")
    const body = r.error.body as {
      missing: Array<{ field: string; fix_tool: string }>
      regime: string | null
    }
    expect(body.missing.map((m) => m.field)).toContain("buyer_siren")
    expect(r.error.message).toContain("counterparty_identity_lookup")
    // Preflight path: nothing written (the derived identity is recorded only when issuing).
    expect(
      db.__all("counterparty_identities").some((i) => i.contact_id === "contact-company"),
    ).toBe(false)
  })

  test("a call's non-business kind never takes a contact recorded with a company out of e-invoicing", async () => {
    // red: the call's kind was taken as is -> an agent stuck on a missing SIREN re-issued a French
    // company as a non-registered entity and its invoice left e-invoicing.
    for (const kind of ["individual", "non_registered_entity"] as const) {
      const { ctx } = makeCtx({
        executeToolImpl: async (name) =>
          name === "kernel:contacts_read"
            ? { status: "completed", result: { contact: { company: "Exemple Atelier" } } }
            : { status: "completed", result: {} },
      })
      const r = await invoiceCreateAndIssue(ctx, {
        operation_category: "goods",
        counterparty: {
          ...frPerson,
          customer_kind: kind,
          contact_id: "contact-company",
          billing_postcode: "69002",
          billing_city: "Lyon",
        },
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: sampleDraftItems,
      })
      expect(r.status).toBe("error")
      if (r.status !== "error") throw new Error("unreachable")
      expect(r.error.code).toBe("einvoice_data_missing")
    }
  })

  test("a SIREN read off a French VAT id is unconfirmed: refused registry_unconfirmed", async () => {
    const { ctx } = makeCtx()
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: {
        ...frPerson,
        contact_id: "contact-vat",
        legal_name: "Exemple Industries",
        vat_id: "FR68900000001",
        billing_postcode: "75002",
        billing_city: "Paris",
      },
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("registry_unconfirmed")
  })

  test("manual business-FR invoice without operation_category refused", async () => {
    const { ctx, db } = makeCtx()
    const r = await invoiceCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("operation_category_missing")
    expect(issuedDocs(db)).toHaveLength(0)
  })

  test("a complete French business invoice records the e-invoice snapshot", async () => {
    const { ctx, db } = makeCtx()
    const r = await invoiceCreateAndIssue(ctx, {
      operation_category: "goods",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    const doc = db.__all("documents").find((d) => d.id === r.document_id)!
    expect(doc).toMatchObject({
      regime: "e_invoice",
      customer_kind: "business",
      buyer_siren: BUYER_SIREN,
      buyer_routing_address: BUYER_SIREN,
      buyer_siren_confirmed_via: "auto",
      billing_postcode: "75002",
      billing_city: "Paris",
      billing_country_code: "FR",
      operation_category: "goods",
      operation_category_source: "explicit",
    })
    expect("einvoicing_warning" in r).toBe(false)
  })

  test("quote/proforma/PO snapshot out_of_scope, never blocked", async () => {
    // Approved re-entry: the human gate on quotes / proformas is not what this test is about.
    const { ctx, db } = makeCtx({
      approval: {
        approvalRequestId: "appr-q",
        approvalDeciderId: "user-2",
        toolName: "invoicing:quote_create_and_issue",
      },
    })
    const quote = await quoteCreateAndIssue(ctx, {
      counterparty: frPerson,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const proforma = await proformaCreateAndIssue(ctx, {
      reason: "sample",
      counterparty: frPerson,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const po = await poCreateAndIssue(ctx, {
      counterparty: frPerson,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    for (const r of [quote, proforma, po]) {
      expect(r.status).toBe("completed")
      if (r.status !== "completed") throw new Error("unreachable")
      expect(db.__all("documents").find((d) => d.id === r.document_id)!.regime).toBe("out_of_scope")
    }
  })

  test("credit_note_create_and_issue and credit_note_issue preflights refuse with the typed envelope", async () => {
    const { ctx, db } = makeCtx()
    const pre = await creditNoteCreateAndIssuePreflight(ctx, {
      counterparty: frPerson,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [{ ...sampleDraftItems[0]!, unit_price_minor: -5_000n }],
    })
    expect("error" in pre).toBe(true)
    if (!("error" in pre)) throw new Error("unreachable")
    expect(pre.error.code).toBe("customer_kind_missing")
    expect(pre.error.retryable).toBe(true)
    expect(pre.error.status).toBe(422)

    const draft = await draftsCreate(ctx, {
      type: "credit_note",
      counterparty_contact_id: null,
      counterparty_name: frPerson.legal_name,
      counterparty_address: frPerson.address,
      counterparty_email: frPerson.email,
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [{ ...sampleDraftItems[0]!, unit_price_minor: -5_000n }],
    })
    const pre2 = await creditNoteIssuePreflight(ctx, { draft_id: draft.draft_id })
    expect("error" in pre2 && pre2.error.code).toBe("customer_kind_missing")
    expect(issuedDocs(db)).toHaveLength(0)
  })

  test("drafts_update sets kind, category and structured billing, after which invoice_issue issues", async () => {
    const { ctx, db } = makeCtx()
    const draft = await draftsCreate(ctx, {
      type: "invoice",
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    const refused = await invoiceIssue(ctx, { draft_id: draft.draft_id })
    expect(refused.status).toBe("error")
    if (refused.status !== "error") throw new Error("unreachable")
    expect(refused.error.code).toBe("einvoice_data_missing")
    const fixTools = (refused.error.body as { missing: Array<{ fix_tool: string }> }).missing.map(
      (m) => m.fix_tool,
    )
    expect(fixTools).toContain("drafts_update")

    await draftsUpdate(ctx, {
      draft_id: draft.draft_id,
      patch: {
        customer_kind: "business",
        operation_category: "services",
        billing_line1: "1 rue Buyer",
        billing_postcode: "75002",
        billing_city: "Paris",
        billing_country_code: "fr",
      },
    })
    const ok = await invoiceIssue(ctx, { draft_id: draft.draft_id })
    expect(ok.status).toBe("completed")
    if (ok.status !== "completed") throw new Error("unreachable")
    const doc = db.__all("documents").find((d) => d.id === ok.document_id)!
    expect(doc).toMatchObject({
      regime: "e_invoice",
      operation_category: "services",
      operation_category_source: "explicit",
      billing_country_code: "FR",
    })
  })

  test("drafts_update refuses a customer_kind outside the allowed values", async () => {
    const { ctx } = makeCtx()
    const draft = await draftsCreate(ctx, {
      type: "invoice",
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    await expect(
      draftsUpdate(ctx, { draft_id: draft.draft_id, patch: { customer_kind: "company" as never } }),
    ).rejects.toThrow(/invalid_params: customer_kind/)
  })

  test("the wire never confirms a SIREN: a caller-asserted confirmation is dropped", async () => {
    const { ctx } = makeCtx()
    const r = await invoiceCreateAndIssueHandler(
      {
        operation_category: "goods",
        counterparty: {
          ...frPerson,
          customer_kind: "business",
          siren: FICTIONAL_SIRENS[1],
          siren_confirmed_via: "auto",
          billing_postcode: "75002",
          billing_city: "Paris",
        } as never,
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: sampleDraftItems,
      },
      ctx,
    )
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("registry_unconfirmed")
  })

  test("credit note against an e-invoice original follows its snapshot and category", async () => {
    const { ctx, db } = makeCtx()
    const inv = await invoiceCreateAndIssue(ctx, {
      operation_category: "services",
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    if (inv.status !== "completed") throw new Error("unreachable")
    // A later identity change on the contact does not reach the credit note.
    const idn = db.__all("counterparty_identities").find((i) => i.contact_id === "contact-1")!
    await db.update("counterparty_identities", String(idn.id), { siren: FICTIONAL_SIRENS[2] })
    const cn = await creditNoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [{ ...sampleDraftItems[0]!, unit_price_minor: -5_000n }],
      original_document_id: inv.document_id,
    })
    expect(cn.status).toBe("completed")
    if (cn.status !== "completed") throw new Error("unreachable")
    const doc = db.__all("documents").find((d) => d.id === cn.document_id)!
    expect(doc).toMatchObject({
      regime: "e_invoice",
      buyer_siren: BUYER_SIREN,
      operation_category: "services",
      original_document_id: inv.document_id,
      internal_cancellation: false,
    })
  })

  test("warn mode issues, records the warning on the document and returns it", async () => {
    const { ctx, db } = makeCtx({
      seed: { einvoicing_settings: [{ gate_mode: "warn", gate_mode_source: "upgrade_default" }] },
    })
    const r = await invoiceCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.einvoicing_warning?.code).toBe("operation_category_missing")
    const doc = db.__all("documents").find((d) => d.id === r.document_id)!
    expect((doc.regime_reasons as Array<{ code: string }>).map((x) => x.code)).toContain(
      "gate_warning",
    )
    expect(
      (doc.lifecycle_log as Array<{ event: string }>).some(
        (e) => e.event === "einvoice_gate_warning",
      ),
    ).toBe(true)
  })
})

// ── E-invoicing gate: convert, reissue, and caller-asserted SIREN confirmations ─────────────
describe("e-invoicing gate: convert, reissue and caller-asserted confirmations", () => {
  const APPROVED = {
    approvalRequestId: "appr-x",
    approvalDeciderId: "user-2",
    toolName: "invoicing:quote_create_and_issue",
  }
  // A contactless French business buyer whose caller claims a confirmed SIREN.
  const claimedBuyer = {
    contact_id: null,
    legal_name: "Exemple Industries SAS",
    country: "FR",
    vat_id: null,
    address: "1 rue de l'Exemple, 75002 Paris",
    email: "compta@exemple-industries.example",
    customer_kind: "business" as const,
    siren: FICTIONAL_SIRENS[1],
    siren_confirmed_via: "auto",
    billing_line1: "1 rue de l'Exemple",
    billing_postcode: "75002",
    billing_city: "Paris",
  }

  async function seedSource(db: MockDb, over: Record<string, unknown> = {}): Promise<string> {
    const id = "00000000-0000-4000-8000-0000000003a1"
    await db.insert("documents", {
      id,
      type: "quote",
      status: "accepted",
      number: "QUO-2026-3001",
      number_int: 3001,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      counterparty_contact_id: null,
      counterparty_name: "Exemple Industries SAS",
      counterparty_address: "1 rue de l'Exemple, 75002 Paris",
      counterparty_email: "compta@exemple-industries.example",
      counterparty_country: "FR",
      customer_kind: "business",
      operation_category: "goods",
      operation_category_source: "explicit",
      billing_line1: "1 rue de l'Exemple",
      billing_postcode: "75002",
      billing_city: "Paris",
      billing_country_code: "FR",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      external_refs: {},
      lifecycle_log: [],
      ...over,
    })
    await db.insert("document_lines", {
      document_id: id,
      position: 1,
      description: "Widget",
      quantity: "2",
      unit_price_minor: "5000",
      tax_rate_bp: null,
      subtotal_minor: "10000",
      tax_minor: "0",
      total_minor: "10000",
    })
    return id
  }

  test("a quote issued with a caller-asserted SIREN confirmation records none, and its convert is refused registry_unconfirmed", async () => {
    const { ctx, db } = makeCtx({ approval: APPROVED })
    const quote = await quoteCreateAndIssueHandler(
      {
        counterparty: claimedBuyer as never,
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: sampleDraftItems,
      },
      ctx,
    )
    expect(quote.status).toBe("completed")
    if (quote.status !== "completed") throw new Error("unreachable")
    const qdoc = db.__all("documents").find((d) => d.id === quote.document_id)!
    expect(qdoc.buyer_siren).toBe(FICTIONAL_SIRENS[1])
    expect(qdoc.buyer_siren_confirmed_via ?? null).toBeNull()

    const conv = await documentsConvertToInvoice(ctx, {
      source_document_id: quote.document_id,
      operation_category: "goods",
    })
    expect(conv.status).toBe("error")
    if (conv.status !== "error") throw new Error("unreachable")
    expect(conv.error.code).toBe("registry_unconfirmed")
    expect(issuedDocs(db).filter((d) => d.type === "invoice")).toHaveLength(0)
  })

  test("in process too: a snapshot claim never becomes a recorded confirmation", async () => {
    const { ctx, db } = makeCtx({ approval: APPROVED })
    const quote = await quoteCreateAndIssue(ctx, {
      counterparty: claimedBuyer as never,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    if (quote.status !== "completed") throw new Error("unreachable")
    expect(
      db.__all("documents").find((d) => d.id === quote.document_id)!.buyer_siren_confirmed_via ??
        null,
    ).toBeNull()
  })

  test("documents_convert_to_invoice: a French business source without a SIREN is refused before anything changes", async () => {
    const { ctx, db } = makeCtx()
    const id = await seedSource(db)
    const pre = await documentsConvertToInvoicePreflight(ctx, { source_document_id: id })
    expect("error" in pre && pre.error.code).toBe("einvoice_data_missing")
    const r = await documentsConvertToInvoice(ctx, { source_document_id: id })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("einvoice_data_missing")
    expect(r.error.status).toBe(422)
    expect(db.__all("documents").find((d) => d.id === id)!.status).toBe("accepted")
    expect(issuedDocs(db).filter((d) => d.type === "invoice")).toHaveLength(0)
  })

  test("documents_convert_to_invoice: a Shopify-linked source is refused with zero draft-order completions", async () => {
    let draftOrderComplete = 0
    const { ctx, db } = makeCtx({
      executeToolImpl: async (name) => {
        if (name === "shopify:draft_orders_complete") draftOrderComplete += 1
        return { status: "completed", result: {} }
      },
    })
    const id = await seedSource(db, {
      status: "sent",
      shopify_draft_order_id: "gid://shopify/DraftOrder/3001",
      external_refs: { shopify_draft_order_id: "gid://shopify/DraftOrder/3001" },
    })
    const r = await documentsConvertToInvoice(ctx, { source_document_id: id })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("einvoice_data_missing")
    expect(draftOrderComplete).toBe(0)
    expect(db.__all("documents").find((d) => d.id === id)!.status).toBe("sent")
  })

  test("order_reissue_apply: a legacy French business original without a SIREN is refused, nothing issued", async () => {
    const { ctx, db } = makeCtx()
    const id = await seedSource(db, {
      type: "invoice",
      status: "issued",
      number: "INV-2026-3001",
      shopify_order_id: "order-3001",
    })
    const input = {
      original_document_id: id,
      shopify_order_id: "order-3001",
      billing_signature: "sig-1",
      dedupe_key: "order-3001:sig-1",
      items: [
        {
          description: "Widget",
          quantity: "3",
          unit_price_minor: 5000,
          product_source: null,
          external_id: null,
        },
      ],
    }
    const pre = await orderReissueApplyPreflight(ctx, input)
    expect("error" in pre && pre.error.code).toBe("einvoice_data_missing")
    const r = await orderReissueApply(ctx, input)
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("einvoice_data_missing")
    expect(db.__all("documents").filter((d) => d.type === "credit_note")).toHaveLength(0)
  })
})

// ── Issuer profile changes, full refund bound, send recipient ─────────────
describe("issuer profile changes, full refund bound, send recipient", () => {
  test("updating the IBAN is written to the audit timeline with old and new values", async () => {
    const { ctx, extras } = makeCtx({ scopes: ["invoicing:issuer:admin"] })
    const before = String(
      ((await ctx.db.findOne("issuer_profiles", "iss-1")) as { iban?: string }).iban ?? "",
    )
    const r = await settingsIssuerProfileUpdate(ctx, {
      id: "iss-1",
      iban: "FR7630006000011234567890189",
      reason_unknown: "x",
    })
    expect(r.status).toBe("completed")
    const ev = extras.emittedAttention.find(
      (e) => e.entity === "issuer_profile" && e.action === "updated",
    )!
    const data = ev.data as {
      sensitive_fields: string[]
      changes: Record<string, { from: unknown; to: unknown }>
    }
    expect(data.sensitive_fields).toContain("iban")
    expect(data.changes.iban).toEqual({
      from: before === "" ? null : before,
      to: "FR7630006000011234567890189",
    })
    expect(data.changes.reason_unknown).toBeUndefined()
  })

  test("bank and control fields need invoicing:issuer:admin; settings:write alone is refused", async () => {
    const member = [
      "invoicing:settings:write",
      "invoicing:settings:read",
      "invoicing:documents:write",
    ]
    for (const change of [
      { iban: "FR7630006000011234567890189" },
      { swift_bic: "BNPAFRPP" },
      { bank_name: "Other Bank" },
      { invoice_approval_threshold_minor: "9999999" },
      { po_approval_threshold_minor: "9999999" },
      { require_two_eyes: true },
      { auto_email_enabled: true },
      { mail_account_id: "acct-other" },
    ]) {
      const { ctx, db } = makeCtx({ scopes: member })
      const before = { ...db.__all("issuer_profiles").find((r) => r.id === "iss-1") }
      const r = await settingsIssuerProfileUpdate(ctx, { id: "iss-1", ...change })
      expect(r.status).toBe("error")
      if (r.status === "error") {
        expect(r.error.code).toBe("forbidden")
        expect(r.error.message).toContain("invoicing:issuer:admin")
      }
      expect(db.__all("issuer_profiles").find((r) => r.id === "iss-1")).toEqual(before)
      // The stage-time preflight refuses the same call before an approval card exists.
      const pf = await settingsIssuerProfileWritePreflight(ctx, "update", {
        id: "iss-1",
        ...change,
      })
      expect("error" in pf && pf.error.code).toBe("forbidden")
    }
    // No scope check available on the context: refused, never assumed.
    const { ctx: bare } = makeCtx()
    expect((await settingsIssuerProfileUpdate(bare, { id: "iss-1", iban: "X" })).status).toBe(
      "error",
    )
  })

  test("a member edits the other fields, resending the unchanged bank details the form carries", async () => {
    const { ctx, db } = makeCtx({ scopes: ["invoicing:settings:write"] })
    const row = db.__all("issuer_profiles").find((r) => r.id === "iss-1")!
    const r = await settingsIssuerProfileUpdate(ctx, {
      id: "iss-1",
      address: "2 rue Neuve, 75001 Paris",
      iban: row.iban,
      swift_bic: row.swift_bic ?? "",
      bank_name: row.bank_name ?? "",
      invoice_approval_threshold_minor: row.invoice_approval_threshold_minor,
      require_two_eyes: row.require_two_eyes,
      mail_account_id: row.mail_account_id,
    })
    expect(r.status).toBe("completed")
    expect(db.__all("issuer_profiles").find((r) => r.id === "iss-1")?.address).toBe(
      "2 rue Neuve, 75001 Paris",
    )
  })

  test("the issuer admin scope, or the admin wildcard, may change them", async () => {
    for (const scopes of [["invoicing:issuer:admin"], ["*"], ["invoicing"]]) {
      const { ctx, db } = makeCtx({ scopes })
      const r = await settingsIssuerProfileUpdate(ctx, {
        id: "iss-1",
        iban: "DE89370400440532013000",
      })
      expect(r.status).toBe("completed")
      expect(db.__all("issuer_profiles").find((r) => r.id === "iss-1")?.iban).toBe(
        "DE89370400440532013000",
      )
    }
  })

  test("creating a profile with bank or control values, or deleting one, needs the issuer admin scope", async () => {
    const member = makeCtx({ scopes: ["invoicing:settings:write"] }).ctx
    const plain = {
      legal_name: "New Co",
      country: "FR",
      require_two_eyes: false,
      auto_email_enabled: false,
      iban: "",
    }
    expect((await settingsIssuerProfileCreate(member, plain)).status).toBe("completed")
    const withBank = await settingsIssuerProfileCreate(member, {
      ...plain,
      iban: "FR7630006000011234567890189",
    })
    expect(withBank.status === "error" && withBank.error.code).toBe("forbidden")
    const del = await settingsIssuerProfileDelete(member, { id: "iss-1" })
    expect(del.status === "error" && del.error.code).toBe("forbidden")
    const pf = await settingsIssuerProfileWritePreflight(member, "delete", { id: "iss-1" })
    expect("error" in pf && pf.error.code).toBe("forbidden")

    const admin = makeCtx({ scopes: ["invoicing:issuer:admin"] })
    expect(
      (
        await settingsIssuerProfileCreate(admin.ctx, {
          ...plain,
          iban: "FR7630006000011234567890189",
        })
      ).status,
    ).toBe("completed")
    expect((await settingsIssuerProfileDelete(admin.ctx, { id: "iss-1" })).status).toBe("completed")
  })

  test("a profile that issued documents is refused, typed, before the database would refuse it", async () => {
    const admin = makeCtx({ scopes: ["invoicing:issuer:admin"] })
    await admin.db.insert("documents", {
      type: "invoice",
      status: "issued",
      issuer_profile_id: "iss-1",
      number: "INV-2026-0001",
    })
    const pf = await settingsIssuerProfileWritePreflight(admin.ctx, "delete", { id: "iss-1" })
    expect("error" in pf && pf.error.code).toBe("issuer_in_use")
    const del = await settingsIssuerProfileDelete(admin.ctx, { id: "iss-1" })
    expect(del.status === "error" && del.error.code).toBe("issuer_in_use")
    expect(admin.db.__all("issuer_profiles").some((r) => r.id === "iss-1")).toBe(true)
  })

  test("the approval card lists each changed column as old -> new", async () => {
    const s = await summarizeIssuerProfileChange(
      { id: "iss-1", iban: "NEW-IBAN", country: "FR" },
      undefined,
      {
        context: { items: [{ id: "iss-1", legal_name: "Acme", iban: "OLD-IBAN", country: "FR" }] },
      },
    )
    expect(s.lines).toEqual(["IBAN: OLD-IBAN -> NEW-IBAN"])
    expect(s.title).toContain("Acme")
  })

  test("the approval card always lists bank and control changes, however many other fields change", async () => {
    const params: Record<string, unknown> = { id: "iss-1", iban: "NEW-IBAN" }
    const current: Record<string, unknown> = { id: "iss-1", legal_name: "Acme", iban: "OLD-IBAN" }
    for (const k of [
      "address",
      "timezone",
      "prefix_invoice",
      "prefix_quote",
      "prefix_proforma",
      "prefix_po",
      "default_currency",
      "country",
      "tax_registration_id",
      "default_language",
    ]) {
      params[k] = `new-${k}`
      current[k] = `old-${k}`
    }
    const s = await summarizeIssuerProfileChange(params, undefined, {
      context: { items: [current] },
    })
    expect(s.lines[0]).toBe("IBAN: OLD-IBAN -> NEW-IBAN")
    expect(s.lines.at(-1)).toMatch(/other settings/)
    // A change past the displayed prefix still counts as a change.
    const long = "x".repeat(90)
    const s2 = await summarizeIssuerProfileChange({ id: "iss-1", address: `${long}B` }, undefined, {
      context: { items: [{ id: "iss-1", legal_name: "Acme", address: `${long}A` }] },
    })
    expect(s2.lines).toHaveLength(1)
  })

  test("a new profile's card always shows its legal identity, however many settings it carries", async () => {
    // The ordinary settings come first, so a card that kept only the first
    // few lines would drop the identity fields after them.
    const params: Record<string, unknown> = { legal_name: "Northwind Audio SAS" }
    for (const k of [
      "timezone",
      "prefix_invoice",
      "prefix_quote",
      "prefix_proforma",
      "prefix_po",
      "default_currency",
      "default_language",
      "default_payment_terms_days",
    ]) {
      params[k] = `v-${k}`
    }
    Object.assign(params, {
      country: "FR",
      address: "10 Rue de la Paix, 75002 Paris",
      vat_id: "FR40552032534",
      tax_registration_id: "552032534",
      iban: "FR7630006000011234567890189",
      swift_bic: "AGRIFRPP",
    })
    const s = await summarizeIssuerProfileChange(params, undefined, { context: { items: [] } })
    for (const line of [
      "Country: FR",
      "Address: 10 Rue de la Paix, 75002 Paris",
      "VAT number: FR40552032534",
      "Tax registration number: 552032534",
      "IBAN: FR7630006000011234567890189",
      "SWIFT/BIC: AGRIFRPP",
    ]) {
      expect(s.lines.some((l) => l.includes(line))).toBe(true)
    }
  })

  test("a FULL refund cannot exceed what is still unrefunded", async () => {
    const { ctx, db } = makeCtx()
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-000000000101",
      type: "invoice",
      status: "paid",
      number: "INV-2026-2",
      number_int: 2,
      year_of_issue: 2026,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      subtotal_minor: "10000",
      tax_total_minor: "2000",
      grand_total_minor: "12000",
      tax_treatment: "domestic",
      incoterm: "DAP",
      issued_at: "2026-05-28",
      external_refs: {},
      lifecycle_log: [],
    })
    const over = await documentsRecordRefund(ctx, {
      document_id: "00000000-0000-4000-8000-000000000101",
      refund_amount_minor: 99_999_999n,
      refund_kind: "full",
    })
    expect(over.status).toBe("error")
  })

  test("the send approval card names the recipient address", async () => {
    const s = await summarizeDocumentSend({ document_id: "d1" }, undefined, {
      context: {
        number: "INV-1",
        counterparty_name: "Buyer",
        counterparty_email: "ap@buyer.example",
      },
    })
    expect(s.title).toContain("ap@buyer.example")
    const withOverride = await summarizeDocumentSend(
      { document_id: "d1", to: "x@y.example" },
      undefined,
      {
        context: { counterparty_email: "ap@buyer.example" },
      },
    )
    expect(withOverride.title).toContain("x@y.example")
  })

  test("a name search with two same-name contacts resolves no recipient", async () => {
    const { ctx, db } = makeCtx({
      executeToolImpl: async (name) =>
        name === "kernel:contacts_search"
          ? {
              status: "completed",
              result: {
                items: [
                  { name: "Buyer SARL", primaryEmail: "a@x.example" },
                  { name: "Buyer SARL", primaryEmail: "evil@x.example" },
                ],
              },
            }
          : { status: "completed", result: {} },
    })
    await db.insert("documents", {
      id: "00000000-0000-4000-8000-0000000009b1",
      type: "invoice",
      status: "issued",
      number: "INV-2026-901",
      issuer_profile_id: "iss-1",
      counterparty_name: "Buyer SARL",
      counterparty_email: null,
      counterparty_contact_id: null,
      currency: "EUR",
      grand_total_minor: "100",
      external_refs: {},
      lifecycle_log: [],
    })
    const r = await documentsSendToCustomerPreflight(ctx, {
      document_id: "00000000-0000-4000-8000-0000000009b1",
    })
    expect("error" in r && r.error.code).toBe("no_recipient")
  })
})

// ── Sales-quote bundle: referenceable outputs, customer reference, discounts, refusals ──────
// An agent proposes a sequenced bundle (CRM write -> quote -> reply). The reply cites the quote's
// outputs by top-level key (`@ref:<quoteApproval>:pdf_file_id`), so every key it may cite has to
// be on the completed result, and every refusal on the way has to say what to do next.

describe("quote_create_and_issue: outputs, customer_reference, discount_minor and refusals", () => {
  const discountedLine = {
    description: "Controller",
    quantity: "40",
    unit_price_minor: "89900",
    discount_minor: "1366480",
    product_source: null,
    external_id: null,
  }

  test("standalone: returns pdf_file_id, grand_total_minor (discount applied) and currency", async () => {
    const { ctx } = makeCtx()
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [discountedLine],
    })
    expect(r.status).toBe("completed")
    if (r.status !== "completed") throw new Error("unreachable")
    expect(r.pdf_file_id).toMatch(/^pdf-/)
    expect(r.pdf_status).toBe("ready")
    expect(r.pdf_error).toBeUndefined()
    // 40 x 89900 = 3596000, minus 1366480 = 2229520, plus 20% FR VAT = 2675424.
    expect(r.grand_total_minor).toBe("2675424")
    expect(r.currency).toBe("EUR")
  })

  test("a failed PDF render returns pdf_file_id null and a pdf_error naming documents_retry_pdf", async () => {
    const { ctx } = makeCtx({ failPdfRender: true })
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    if (r.status !== "completed") throw new Error(`expected completed, got ${r.status}`)
    expect(r.pdf_file_id).toBeNull()
    expect(r.pdf_status).toBe("failed")
    expect(r.pdf_error).toContain("documents_retry_pdf")
    expect(r.pdf_error).toContain(r.document_id)
  })

  test("customer_reference is stored, printed as Customer ref, re-rendered and read back", async () => {
    const { ctx, db, extras } = makeCtx()
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
      customer_reference: "  crm-48213  ",
    })
    if (r.status !== "completed") throw new Error(`expected completed, got ${r.status}`)
    const row = db.__all("documents").find((d) => d.id === r.document_id)!
    expect((row.external_refs as Record<string, unknown>).customer_reference).toBe("crm-48213")
    const issueData = extras.renderCalls.at(-1)!.data as {
      document: { customer_reference: string | null }
    }
    expect(issueData.document.customer_reference).toBe("crm-48213")
    // A re-render reads it back off the stored row.
    extras.renderCalls.length = 0
    const retry = await documentsRetryPdf(ctx, { id: r.document_id })
    expect(retry.status).toBe("completed")
    const reData = extras.renderCalls[0]!.data as {
      document: { customer_reference: string | null }
    }
    expect(reData.document.customer_reference).toBe("crm-48213")
    const got = await documentsGet({ db } as unknown as ReadsCtx, { id: r.document_id })
    expect(got?.customer_reference).toBe("crm-48213")
  })

  test("a blank customer_reference stores nothing; an over-long one is refused with guidance", async () => {
    const { ctx, db } = makeCtx()
    const blank = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
      customer_reference: "   ",
    })
    if (blank.status !== "completed") throw new Error("expected completed")
    const row = db.__all("documents").find((d) => d.id === blank.document_id)!
    expect("customer_reference" in (row.external_refs as Record<string, unknown>)).toBe(false)
    const long = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
      customer_reference: "x".repeat(201),
    })
    if (long.status !== "error") throw new Error("expected error")
    expect(long.error.code).toBe("customer_reference_too_long")
    expect(long.error.message).toContain("200 character limit")
    expect(long.error.message).toContain("Customer ref")
  })

  test("documents_update sets and clears customer_reference without dropping the PO number", async () => {
    const { ctx, db } = makeCtx()
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
      po_number: "PO-1",
    })
    if (r.status !== "completed") throw new Error("expected completed")
    await documentsUpdate(ctx, {
      id: r.document_id,
      customer_reference: "crm-9",
      po_number: "PO-2",
    })
    let refs = db.__all("documents").find((d) => d.id === r.document_id)!.external_refs as Record<
      string,
      unknown
    >
    expect(refs.customer_reference).toBe("crm-9")
    expect(refs.po_number).toBe("PO-2")
    await documentsUpdate(ctx, { id: r.document_id, customer_reference: null })
    refs = db.__all("documents").find((d) => d.id === r.document_id)!.external_refs as Record<
      string,
      unknown
    >
    expect("customer_reference" in refs).toBe(false)
    expect(refs.po_number).toBe("PO-2")
  })

  test.each([
    ["-500", "cannot be negative"],
    ["3596001", "more than the line itself"],
  ])(
    "discount_minor %s is refused naming the field, the line, the range and an example",
    async (bad, why) => {
      const { ctx, db } = makeCtx()
      const r = await quoteCreateAndIssue(ctx, {
        counterparty: defaultCounterparty,
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: [sampleDraftItems[0]!, { ...discountedLine, discount_minor: bad }],
      })
      if (r.status !== "error") throw new Error("expected error")
      expect(r.error.code).toBe("invalid_discount")
      expect(r.error.message).toContain("items[1].discount_minor")
      expect(r.error.message).toContain(why)
      expect(r.error.message).toContain("between 0 and 3596000")
      expect(r.error.message).toContain("discount_minor 1366480")
      expect(r.error.message).toContain("not per unit")
      expect(db.__all("documents").filter((d) => d.type === "quote")).toHaveLength(0)
    },
  )

  test("a discount given as a percentage is refused as invalid_amount with the line-total meaning", async () => {
    const { ctx } = makeCtx()
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [{ ...discountedLine, discount_minor: "38%" }],
    })
    if (r.status !== "error") throw new Error("expected error")
    expect(r.error.code).toBe("invalid_amount")
    expect(r.error.message).toContain("items[0].discount_minor")
    expect(r.error.message).toContain("TOTAL discount for the whole line")
    expect(r.error.message).toContain("1366480")
  })

  test("a bad unit_price_minor is refused saying it is the price of one unit in minor units", async () => {
    const { ctx } = makeCtx()
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          description: "Controller",
          quantity: "1",
          unit_price_minor: "€899",
          product_source: null,
          external_id: null,
        },
      ],
    })
    if (r.status !== "error") throw new Error("expected error")
    expect(r.error.code).toBe("invalid_amount")
    expect(r.error.message).toContain("items[0].unit_price_minor")
    expect(r.error.message).toContain("price of ONE unit in minor currency units")
    expect(r.error.message).toContain("89900")
  })

  test("no issuer profile: says to ask for the legal identity and use settings_issuer_profile_create", async () => {
    const { ctx } = makeCtx({ seed: { issuer_profiles: [] } })
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      currency: "EUR",
      items: sampleDraftItems,
    })
    if (r.status !== "error") throw new Error("expected error")
    expect(r.error.code).toBe("no_issuer_profile")
    expect(r.error.message).toContain("settings_issuer_profile_create")
    expect(r.error.message).toContain("never make them up")
    expect(r.error.message).toContain("issuer_profile_id")
  })

  test("ambiguous issuer: lists ids, legal names and shop links, and says to pass issuer_profile_id", async () => {
    const { ctx } = makeCtx({
      seed: {
        issuer_profiles: [
          {
            ...seedIssuer({ ...defaultIssuer, id: "iss-1", legal_name: "Acme SAS" }, {}),
            shopify_shop_id: "acme.myshopify.com",
          },
          seedIssuer({ ...defaultIssuer, id: "iss-2", legal_name: "Acme Services" }, {}),
        ],
      },
    })
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      currency: "EUR",
      items: sampleDraftItems,
    })
    if (r.status !== "error") throw new Error("expected error")
    expect(r.error.code).toBe("issuer_profile_ambiguous")
    expect(r.error.message).toContain("iss-1 (Acme SAS, linked to Shopify shop acme.myshopify.com)")
    expect(r.error.message).toContain("iss-2 (Acme Services, no shop linked)")
    expect(r.error.message).toContain("with issuer_profile_id set to one of")
  })

  test("unknown issuer id: lists the profiles that exist", async () => {
    const { ctx } = makeCtx()
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: defaultCounterparty,
      issuer_profile_id: "iss-nope",
      currency: "EUR",
      items: sampleDraftItems,
    })
    if (r.status !== "error") throw new Error("expected error")
    expect(r.error.code).toBe("issuer_not_found")
    expect(r.error.message).toContain("issuer_profile iss-nope not found")
    expect(r.error.message).toContain("iss-1 (Acme SAS, no shop linked)")
    expect(r.error.message).toContain("settings_issuer_profile_list")
  })

  test("incomplete counterparty: names the missing fields and shows a complete example", async () => {
    const { ctx } = makeCtx()
    const r = await quoteCreateAndIssue(ctx, {
      counterparty: { ...defaultCounterparty, address: null, email: "" },
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: sampleDraftItems,
    })
    if (r.status !== "error") throw new Error("expected error")
    expect(r.error.code).toBe("counterparty_incomplete")
    expect(r.error.message).toContain("address, email are missing")
    expect(r.error.message).toContain('"legal_name": "Acme SAS"')
    expect(r.error.message).toContain("never make them up")
  })

  describe("issuer linked to a shop", () => {
    const seed = [
      {
        ...seedIssuer(defaultIssuer, { invoice: null, po: null }),
        shopify_shop_id: "acme.myshopify.com",
      },
      seedIssuer({ ...defaultIssuer, id: "iss-plain", legal_name: "Acme Direct" }, {}),
    ]
    const draft = {
      draftOrderId: "gid://shopify/DraftOrder/88",
      name: "#D88",
      status: "open",
      shopDomain: "acme.myshopify.com",
      currency: "EUR",
      totalPrice: "120.00",
      taxesIncluded: false,
      email: "ap@buyersarl.example",
      billingAddress: {
        name: "Buyer SARL",
        company: "Buyer SARL",
        address1: "1 rue Buyer",
        zip: "75002",
        city: "Paris",
        countryCode: "FR",
      },
      lineItems: [
        {
          id: "l1",
          title: "Widget",
          quantity: 2,
          unitPrice: "50.00",
          discountedTotal: "100.00",
          appliedDiscount: null,
          custom: true,
        },
      ],
    }

    test("a failed draft-order creation explains the shop link, the cause, and how to issue a plain quote", async () => {
      const { ctx } = makeCtx({
        seed: { issuer_profiles: seed },
        executeToolImpl: async (name) =>
          name === "shopify:draft_orders_create"
            ? {
                status: "error",
                error: { code: "shopify_user_error", message: "Email is invalid" },
              }
            : { status: "completed", result: {} },
      })
      const r = await quoteCreateAndIssue(ctx, {
        counterparty: defaultCounterparty,
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: sampleDraftItems,
      })
      if (r.status !== "error") throw new Error("expected error")
      expect(r.error.code).toBe("shopify_user_error")
      expect(r.error.message).toContain("is linked to Shopify shop acme.myshopify.com")
      expect(r.error.message).toContain("made as a Shopify draft order")
      expect(r.error.message).toContain("shopify_user_error: Email is invalid")
      expect(r.error.message).toContain("settings_issuer_profile_list")
      expect(r.error.message).toContain("iss-plain (Acme Direct, no shop linked)")
    })

    test("returns the synced quote's pdf_file_id, total and currency; sends the discount and PO number; keeps the customer ref", async () => {
      const { ctx, db, extras } = makeCtx({
        seed: { issuer_profiles: seed },
        executeToolImpl: async (name) => {
          if (name === "shopify:draft_orders_create")
            return {
              status: "completed",
              result: { draftOrder: { id: draft.draftOrderId, name: draft.name } },
            }
          if (name === "shopify:draft_orders_get")
            return { status: "completed", result: { draftOrder: draft } }
          return { status: "completed", result: {} }
        },
      })
      const r = await quoteCreateAndIssue(ctx, {
        counterparty: defaultCounterparty,
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items: [discountedLine],
        po_number: "PO-77",
        customer_reference: "crm-48213",
      })
      if (r.status !== "completed") throw new Error(`expected completed, got ${JSON.stringify(r)}`)
      expect(r.pdf_file_id).toMatch(/^pdf-/)
      expect(r.grand_total_minor).toBe("12000")
      expect(r.currency).toBe("EUR")
      expect(r.shopify_draft_order_id).toBe(draft.draftOrderId)
      const input = (
        extras.executeToolCalls.find((c) => c.name === "shopify:draft_orders_create")!.args as {
          input: { lineItems: Array<Record<string, unknown>>; poNumber?: string }
        }
      ).input
      expect(input.lineItems[0]!.appliedDiscount).toEqual({
        value: 38,
        valueType: "PERCENTAGE",
        title: "Discount",
      })
      expect(input.poNumber).toBe("PO-77")
      const row = db.__all("documents").find((d) => d.id === r.document_id)!
      expect((row.external_refs as Record<string, unknown>).customer_reference).toBe("crm-48213")
    })
  })
})

// ── Intra-EU business buyer: never a consumer (OSS) document by omission ─────────────────────
//
// The reproduced incident (invented fixtures): a French issuer whose typed prices include VAT
// staged a proforma for an Italian shop with vat_id null. The org's own data said business: an
// earlier invoice to the same address was issued without VAT to a company, and the buyer's Shopify
// order is tagged B2B with no tax charged. The proforma came out as an EU consumer sale at the
// French 20% rate, 360.00 netted to 300.00 + 60.00, while the card claimed "before tax".

describe("intra-EU business buyer guard", () => {
  const IT_EMAIL = "ordini@negozio-esempio.example"
  const itBuyer: Counterparty = {
    contact_id: null,
    legal_name: "Negozio Esempio",
    country: "IT",
    vat_id: null,
    address: "Via dell'Esempio 12, 20121 Milano",
    email: IT_EMAIL,
  }
  const priorInvoice = {
    id: "doc-prior-1",
    type: "invoice",
    status: "paid",
    number: "INV-2025-0100",
    issuer_profile_id: "iss-1",
    counterparty_name: "Esempio Strumenti SRL",
    counterparty_address: "Via dell'Esempio 12, 20121 Milano MI, Italia",
    counterparty_email: "amministrazione@esempio.example",
    counterparty_country: "IT",
    counterparty_vat_id: null,
    tax_treatment: "eu_destination",
    subtotal_minor: "50000",
    tax_total_minor: "0",
    grand_total_minor: "50000",
    currency: "EUR",
    external_refs: { shopify_order_number: "#1001" },
  }
  const b2bOrder = {
    title: "#1001",
    attributes: {
      email: IT_EMAIL,
      tags: ["B2B"],
      totalTax: "0.00",
      totalAmount: "500.00",
      taxExempt: false,
      customerTaxExempt: false,
      euDestination: true,
      shippingCountryCode: "IT",
      b2bCompany: null,
    },
  }
  const VALID_VAT = "IT01234567890"

  function itCtx(
    opts: {
      prior?: Array<Record<string, unknown>>
      orders?: unknown[]
      vies?: "valid" | "invalid" | "down"
      approved?: boolean
    } = {},
  ) {
    const m = makeCtx({
      approval: opts.approved ? PRE_APPROVED : null,
      seed: {
        // The issuer's typed prices include VAT, as in the incident.
        issuer_profiles: [
          {
            ...seedIssuer(defaultIssuer, { invoice: NO_GATE_MINOR, po: NO_GATE_MINOR }),
            prices_include_tax: true,
          },
        ],
        documents: opts.prior ?? [],
      },
      executeToolImpl: async (name) =>
        name === "shopify:orders_search"
          ? { status: "completed", result: { results: opts.orders ?? [] } }
          : { status: "completed", result: { dispatched: true } },
    })
    const viesCalls: string[] = []
    const fetch: ReadsFetch = async (url) => {
      viesCalls.push(url)
      if (opts.vies === "down") throw new Error("connect ETIMEDOUT")
      const valid = opts.vies !== "invalid"
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          isValid: valid,
          userError: valid ? "VALID" : "INVALID",
          name: valid ? "ESEMPIO STRUMENTI SRL" : null,
          address: valid ? "VIA DELL'ESEMPIO 12, 20121 MILANO" : null,
        }),
      }
    }
    m.ctx.fetch = fetch
    return { ...m, viesCalls }
  }

  const proforma = (counterparty: Counterparty, extra: { buyer_is_consumer?: boolean } = {}) => ({
    counterparty,
    issuer_profile_id: "iss-1",
    currency: "EUR",
    reason: "Shop order",
    items: [
      {
        description: "Kestrel 6",
        quantity: "1",
        unit_price_minor: "36000",
        product_source: null,
        external_id: null,
      },
    ],
    ...extra,
  })

  test("the incident: an IT shop with a prior VAT-free invoice and a B2B order is REFUSED, naming the evidence", async () => {
    const m = itCtx({ prior: [priorInvoice], orders: [b2bOrder] })
    const pre = await proformaCreateAndIssuePreflight(m.ctx, proforma(itBuyer))
    if (!("error" in pre))
      throw new Error("preflight staged a consumer proforma for a business buyer")
    expect(pre.error.code).toBe("buyer_vat_id_required")
    expect(pre.error.message).toContain("INV-2025-0100")
    expect(pre.error.message).toContain("Esempio Strumenti SRL")
    expect(pre.error.message).toContain("Shopify order #1001")
    expect(pre.error.message).toContain('tagged "B2B"')
    expect(pre.error.message).toContain("counterparty.vat_id")
    expect(pre.error.message).toContain("buyer_is_consumer: true")
    // The executed call refuses too, and nothing is staged or created.
    const res = await proformaCreateAndIssue(m.ctx, proforma(itBuyer))
    expect(res.status).toBe("error")
    expect(m.extras.approvalsRequested).toHaveLength(0)
    expect(m.db.__all("documents").filter((d) => d.type === "proforma")).toHaveLength(0)
  })

  test("with the VAT number: reverse charge, 360.00 net, no VAT and nothing netted", async () => {
    const m = itCtx({ prior: [priorInvoice], orders: [b2bOrder], approved: true })
    const buyer = { ...itBuyer, vat_id: VALID_VAT }
    const pre = await proformaCreateAndIssuePreflight(m.ctx, proforma(buyer))
    expect(pre).toEqual({ ok: true })
    const res = await proformaCreateAndIssue(m.ctx, proforma(buyer))
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.type === "proforma")!
    expect(doc.tax_treatment).toBe("eu_reverse_charge")
    expect(String(doc.subtotal_minor)).toBe("36000")
    expect(String(doc.tax_total_minor)).toBe("0")
    expect(String(doc.grand_total_minor)).toBe("36000")
    expect(
      m.viesCalls.some(
        (u) => u.endsWith("/ms/IT/vat/IT01234567890") || u.endsWith("/ms/IT/vat/01234567890"),
      ),
    ).toBe(true)
  })

  test("the card for that call states the treatment, the VIES check, the price basis and the exact totals", async () => {
    const m = itCtx({ prior: [priorInvoice], orders: [b2bOrder] })
    const params = proforma({ ...itBuyer, vat_id: VALID_VAT })
    const context = await documentsIssuePreview(m.ctx, params)
    const card = await summarizeProformaCreateAndIssue(params, undefined, { context })
    const t = card.lines.join("\n")
    expect(t).toContain("Total: 360.00 EUR (360.00 EUR net + 0.00 EUR VAT)")
    expect(t).toContain("reverse charge, no VAT charged")
    expect(t).toContain(`buyer VAT number ${VALID_VAT}, VIES verified: ESEMPIO STRUMENTI SRL`)
    expect(t).toContain("Prices: net as typed, no VAT added")
    expect(t).not.toContain("before tax")
    expect(card.title).toContain("360.00 EUR")
  })

  test("buyer_is_consumer: OSS at the ITALIAN rate (22%), and the card says the consumer was confirmed", async () => {
    const m = itCtx({ prior: [priorInvoice], orders: [b2bOrder], approved: true })
    const params = proforma(itBuyer, { buyer_is_consumer: true })
    // Declared against evidence: staged, but only a person may decide it.
    expect(await proformaCreateAndIssuePreflight(m.ctx, params)).toEqual({
      ok: true,
      noAutoApprove: true,
    })
    const res = await proformaCreateAndIssue(m.ctx, params)
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.type === "proforma")!
    expect(doc.tax_treatment).toBe("eu_b2c_oss")
    // 360.00 typed VAT included at 22%: 295.08 net + 64.92 VAT.
    expect(String(doc.subtotal_minor)).toBe("29508")
    expect(String(doc.tax_total_minor)).toBe("6492")
    expect(String(doc.grand_total_minor)).toBe("36000")
    const line = m.db.__all("document_lines").find((l) => l.document_id === doc.id)!
    expect(Number(line.tax_rate_bp)).toBe(2200)
    expect((doc.external_refs as Record<string, unknown>).buyer_is_consumer).toBe(true)

    const card = await summarizeProformaCreateAndIssue(params, undefined, {
      context: await documentsIssuePreview(m.ctx, params),
    })
    const t = card.lines.join("\n")
    expect(t).toContain("EU consumer sale (OSS), IT VAT 22%")
    // Declared against the evidence: the card says the AGENT declared it, and lists the evidence.
    expect(t).toContain("the agent declared this buyer a private consumer")
    expect(t).toContain("INV-2025-0100")
    expect(t).toContain('tagged "B2B"')
    expect(t).toContain("Total: 360.00 EUR (295.08 EUR net + 64.92 EUR VAT)")
    expect(t).toContain(
      "Prices: typed VAT included (issuer setting), 360.00 EUR incl. VAT is 295.08 EUR net",
    )
  })

  test("an invalid VAT number is refused; a VIES outage lets it through, said on the card", async () => {
    const bad = itCtx({ vies: "invalid" })
    const pre = await proformaCreateAndIssuePreflight(
      bad.ctx,
      proforma({ ...itBuyer, vat_id: VALID_VAT }),
    )
    if (!("error" in pre)) throw new Error("an invalid VAT number was accepted")
    expect(pre.error.code).toBe("vat_id_invalid")

    const down = itCtx({ vies: "down" })
    const params = proforma({ ...itBuyer, vat_id: VALID_VAT })
    expect(await proformaCreateAndIssuePreflight(down.ctx, params)).toEqual({ ok: true })
    const card = await summarizeProformaCreateAndIssue(params, undefined, {
      context: await documentsIssuePreview(down.ctx, params),
    })
    expect(card.lines.join("\n")).toContain("NOT verified (VIES unavailable)")
  })

  test("a VAT number on an earlier document for the same CONTACT is filled in, and the card says where from", async () => {
    const prior = {
      ...priorInvoice,
      counterparty_vat_id: VALID_VAT,
      counterparty_contact_id: "contact-it-1",
      counterparty_address: "Altro indirizzo 1",
    }
    const m = itCtx({ prior: [prior], approved: true })
    const itBuyer2 = { ...itBuyer, contact_id: "contact-it-1" }
    const res = await proformaCreateAndIssue(m.ctx, proforma(itBuyer2))
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.type === "proforma")!
    expect(doc.counterparty_vat_id).toBe(VALID_VAT)
    expect(doc.tax_treatment).toBe("eu_reverse_charge")
    const params = proforma(itBuyer2)
    const card = await summarizeProformaCreateAndIssue(params, undefined, {
      context: await documentsIssuePreview(itCtx({ prior: [prior] }).ctx, params),
    })
    expect(card.lines.join("\n")).toContain(
      `buyer VAT number ${VALID_VAT}, filled in from INV-2025-0100`,
    )
  })

  test("an email-only or street-only match never fills in a VAT number: it is a candidate in the refusal", async () => {
    const OTHER_VAT = "IT09876543210"
    const byEmail = {
      ...priorInvoice,
      id: "doc-e",
      number: "INV-2025-0200",
      counterparty_vat_id: OTHER_VAT,
      counterparty_email: IT_EMAIL,
      counterparty_address: "Altro indirizzo 1",
      counterparty_name: "Altra Ditta SRL",
    }
    const byStreet = {
      ...priorInvoice,
      id: "doc-s",
      number: "INV-2025-0300",
      counterparty_vat_id: OTHER_VAT,
      counterparty_address: "Via dell'Esempio 12, 00100 Roma",
      counterparty_name: "Terza Ditta SRL",
    }
    for (const prior of [byEmail, byStreet]) {
      const m = itCtx({ prior: [prior], approved: true })
      const res = await proformaCreateAndIssue(m.ctx, proforma(itBuyer))
      expect(res.status).toBe("error")
      if (res.status !== "error") throw new Error("unreachable")
      expect(res.error.code).toBe("buyer_vat_id_required")
      // A deliberate refusal (refuseTool): the host answers it as a 4xx at warn, never a 500.
      expect(res.error).toMatchObject({ refusal: true, retryable: false })
      expect(res.error.message).toContain(OTHER_VAT)
      expect(res.error.message).toContain("NOT filled in")
      expect(m.db.__all("documents").filter((d) => d.type === "proforma")).toHaveLength(0)
    }
    // The same full address with a compatible name is a strong match: filled in.
    const sameBuyer = {
      ...priorInvoice,
      counterparty_vat_id: VALID_VAT,
      counterparty_email: "x@other.example",
      counterparty_name: "Negozio Esempio SRL",
    }
    const m = itCtx({ prior: [sameBuyer], approved: true })
    const res = await proformaCreateAndIssue(m.ctx, proforma(itBuyer))
    expect(res.status).toBe("completed")
    expect(m.db.__all("documents").find((d) => d.type === "proforma")!.counterparty_vat_id).toBe(
      VALID_VAT,
    )
  })

  test("buyer_is_consumer is REFUSED when a VAT number is on record for the buyer, naming the document and the number", async () => {
    const prior = {
      ...priorInvoice,
      counterparty_vat_id: VALID_VAT,
      counterparty_contact_id: "contact-it-1",
    }
    const m = itCtx({ prior: [prior] })
    const params = proforma({ ...itBuyer, contact_id: "contact-it-1" }, { buyer_is_consumer: true })
    const pre = await proformaCreateAndIssuePreflight(m.ctx, params)
    if (!("error" in pre))
      throw new Error("a consumer declaration was accepted against a VAT number on record")
    expect(pre.error.code).toBe("buyer_is_consumer_refused")
    expect(pre.error.message).toContain(VALID_VAT)
    expect(pre.error.message).toContain("INV-2025-0100")
    // A Shopify company tax registration id of the same customer refuses it too.
    const order = {
      ...b2bOrder,
      attributes: {
        ...b2bOrder.attributes,
        b2bCompany: { name: "Negozio Esempio SRL", taxRegistrationId: VALID_VAT },
      },
    }
    const q = await quoteCreateAndIssuePreflight(
      itCtx({ orders: [order] }).ctx,
      proforma(itBuyer, { buyer_is_consumer: true }),
    )
    if (!("error" in q))
      throw new Error("a consumer declaration was accepted against a Shopify tax id")
    expect(q.error.code).toBe("buyer_is_consumer_refused")
    expect(q.error.message).toContain("Shopify order #1001")
  })

  test("buyer_is_consumer against other business evidence FORCES a person's card: a quote below its threshold, and a draft", async () => {
    const m = itCtx({ prior: [priorInvoice], orders: [b2bOrder] })
    const res = await quoteCreateAndIssue(m.ctx, proforma(itBuyer, { buyer_is_consumer: true }))
    expect(res.status).toBe("pending_approval")
    expect(m.extras.approvalsRequested).toHaveLength(1)
    const lines = (m.extras.approvalsRequested[0]!.summary_detail?.lines ?? []).join("\n")
    expect(lines).toContain("the agent declared this buyer a private consumer")
    expect(lines).toContain("INV-2025-0100")
    expect(m.db.__all("documents").filter((d) => d.type === "quote")).toHaveLength(0)

    const d = await draftsCreateTool(m.ctx, {
      type: "quote",
      counterparty_contact_id: null,
      counterparty_name: itBuyer.legal_name,
      counterparty_country: "IT",
      counterparty_email: IT_EMAIL,
      counterparty_address: itBuyer.address,
      issuer_profile_id: "iss-1",
      items: [],
      buyer_is_consumer: true,
    })
    expect("status" in d && d.status).toBe("pending_approval")
    expect(m.extras.approvalsRequested).toHaveLength(2)
    expect(m.extras.approvalsRequested[1]!.tool_name).toBe("invoicing:drafts_create")
    // Its own card, with the evidence: the manifest's summarizer is for the other parks.
    expect(m.extras.approvalsRequested[1]!.summary).toContain("as a PRIVATE CONSUMER")
    expect((m.extras.approvalsRequested[1]!.summary_detail?.lines ?? []).join("\n")).toContain(
      'tagged "B2B"',
    )
    expect(m.db.__all("documents").filter((x) => x.type === "quote")).toHaveLength(0)

    // Approved by the person: the draft is written and keeps the evidence for the issue card.
    const ok = await draftsCreateTool(
      { ...m.ctx, approval: PRE_APPROVED },
      {
        type: "quote",
        counterparty_contact_id: null,
        counterparty_name: itBuyer.legal_name,
        counterparty_country: "IT",
        counterparty_email: IT_EMAIL,
        counterparty_address: itBuyer.address,
        issuer_profile_id: "iss-1",
        items: [],
        buyer_is_consumer: true,
      },
    )
    if ("status" in ok) throw new Error("the approved draft was parked again")
    const refs = ok.external_refs as Record<string, unknown>
    expect(refs.buyer_is_consumer).toBe(true)
    expect(
      Array.isArray(refs.buyer_is_consumer_evidence) && refs.buyer_is_consumer_evidence.length > 0,
    ).toBe(true)
  })

  test("the refusal tells the agent where to find the VAT number and does not steer it to the override", async () => {
    const m = itCtx({ prior: [priorInvoice], orders: [b2bOrder] })
    const pre = await proformaCreateAndIssuePreflight(m.ctx, proforma(itBuyer))
    if (!("error" in pre)) throw new Error("staged")
    expect(pre.error.message).toContain("find the buyer's VAT number")
    expect(pre.error.message).toContain("Only if the user confirms the buyer is a private person")
    expect(pre.error.message).not.toContain("call again with buyer_is_consumer")
  })

  test("VIES gets a short deadline, the lookups are bounded and newest first, and a VIES name mismatch is flagged", async () => {
    const m = itCtx({ prior: [priorInvoice] })
    const seen: Array<Record<string, unknown> | undefined> = []
    const findMany = m.ctx.db.findMany.bind(m.ctx.db)
    m.ctx.db.findMany = (async (entity: string, opts?: Record<string, unknown>) => {
      if (entity === "documents") seen.push(opts)
      return findMany(entity, opts as never)
    }) as typeof m.ctx.db.findMany
    const timeouts: unknown[] = []
    const fetchBefore = m.ctx.fetch!
    m.ctx.fetch = async (url, opts) => {
      timeouts.push(opts?.timeoutMs)
      const r = await fetchBefore(url, opts)
      return typeof r === "string"
        ? r
        : {
            ...r,
            body: JSON.stringify({
              isValid: true,
              userError: "VALID",
              name: "UNRELATED HOLDING SPA",
              address: "X",
            }),
          }
    }
    const params = proforma({ ...itBuyer, vat_id: VALID_VAT, contact_id: "contact-it-1" })
    const context = await documentsIssuePreview(m.ctx, params)
    expect(timeouts).toEqual([BUYER_VIES_TIMEOUT_MS])
    const card = await summarizeProformaCreateAndIssue(params, undefined, { context })
    expect(card.lines.join("\n")).toContain("NAME MISMATCH")
    // No VAT number: the evidence lookups run, each bounded and ordered newest first.
    await documentsIssuePreview(m.ctx, proforma({ ...itBuyer, contact_id: "contact-it-1" }))
    expect(seen.length).toBeGreaterThanOrEqual(3)
    for (const o of seen) {
      expect(o?.orderBy).toEqual({ createdAt: "desc" })
      expect(Number(o?.limit)).toBeLessThanOrEqual(200)
    }
  })

  test("a consumer declared against evidence is for a PERSON: every preflight says noAutoApprove", async () => {
    const m = itCtx({ prior: [priorInvoice], orders: [b2bOrder] })
    const consumer = proforma(itBuyer, { buyer_is_consumer: true })
    expect(await invoiceCreateAndIssuePreflight(m.ctx, consumer)).toEqual({
      ok: true,
      noAutoApprove: true,
    })
    expect(await proformaCreateAndIssuePreflight(m.ctx, consumer)).toEqual({
      ok: true,
      noAutoApprove: true,
    })
    expect(await quoteCreateAndIssuePreflight(m.ctx, consumer)).toEqual({
      ok: true,
      noAutoApprove: true,
    })
    // A declaration with no evidence against it, and a business with its VAT number, stay ordinary.
    const plain = itCtx()
    expect(
      await invoiceCreateAndIssuePreflight(
        plain.ctx,
        proforma(
          { ...itBuyer, legal_name: "Giulia Bianchi", address: "Via Lontana 3, 00100 Roma" },
          { buyer_is_consumer: true },
        ),
      ),
    ).toEqual({ ok: true })
    expect(
      await invoiceCreateAndIssuePreflight(m.ctx, proforma({ ...itBuyer, vat_id: VALID_VAT })),
    ).toEqual({ ok: true })
    // Issuing a saved draft that carries the declaration: the same.
    const approved = { ...m.ctx, approval: PRE_APPROVED }
    for (const type of ["invoice", "quote"] as const) {
      const d = await draftsCreateTool(approved, {
        type,
        counterparty_contact_id: null,
        counterparty_name: itBuyer.legal_name,
        counterparty_country: "IT",
        counterparty_email: IT_EMAIL,
        counterparty_address: itBuyer.address,
        issuer_profile_id: "iss-1",
        items: [
          {
            description: "Kestrel 6",
            quantity: "1",
            unit_price_minor: "36000",
            product_source: null,
            external_id: null,
          },
        ],
        buyer_is_consumer: true,
      })
      if ("status" in d) throw new Error("setup failed")
      const pre =
        type === "invoice"
          ? await invoiceIssuePreflight(m.ctx, { draft_id: d.draft_id })
          : await quoteIssuePreflight(m.ctx, { draft_id: d.draft_id })
      expect(pre).toEqual({ ok: true, noAutoApprove: true })
    }
  })

  test("documents_update: a consumer declaration against evidence is for a person, and its card lists the evidence", async () => {
    const m = itCtx({ prior: [priorInvoice], orders: [b2bOrder], approved: true })
    const res = await proformaCreateAndIssue(m.ctx, proforma({ ...itBuyer, vat_id: VALID_VAT }))
    if (res.status !== "completed") throw new Error("setup failed")
    const params = { id: res.document_id, counterparty_vat_id: null, buyer_is_consumer: true }
    expect(await documentsUpdatePreflight(m.ctx, params)).toEqual({ ok: true, noAutoApprove: true })
    const context = await documentsUpdatePreview(
      { ...m.ctx, kernel: { listApprovals: async () => [] } },
      params,
    )
    const card = await summarizeDocumentUpdate(params, undefined, { context })
    const t = card.lines.join("\n")
    expect(t).toContain("the agent declared this buyer a private consumer")
    expect(t).toContain("INV-2025-0100")
    // The card still names the document being edited.
    expect(t).toContain("Customer: Negozio Esempio")
  })

  test("documents_update has a preflight that refuses before an approval card is staged", async () => {
    const m = itCtx({ prior: [priorInvoice], orders: [b2bOrder], approved: true })
    const res = await proformaCreateAndIssue(m.ctx, proforma({ ...itBuyer, vat_id: VALID_VAT }))
    if (res.status !== "completed") throw new Error("setup failed")
    const pre = await documentsUpdatePreflight(m.ctx, {
      id: res.document_id,
      counterparty_vat_id: null,
    })
    if (!("error" in pre))
      throw new Error("documents_update staged a VAT-number removal for a business buyer")
    expect(pre.error.code).toBe("buyer_vat_id_required")
    expect(await documentsUpdatePreflight(m.ctx, { id: res.document_id, notes: "Thanks" })).toEqual(
      { ok: true },
    )
  })

  test("a consumer with no business evidence still gets an OSS document at the destination rate", async () => {
    const m = itCtx({ approved: true })
    const consumer = {
      ...itBuyer,
      legal_name: "Giulia Bianchi",
      address: "Via Lontana 3, 00100 Roma",
    }
    const res = await proformaCreateAndIssue(m.ctx, proforma(consumer))
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.type === "proforma")!
    expect(doc.tax_treatment).toBe("eu_b2c_oss")
    expect(String(doc.tax_total_minor)).toBe("6492")
  })

  test("a company legal form in the buyer's name is evidence on its own; quotes, invoices and drafts are guarded too", async () => {
    const m = itCtx()
    const company = { ...itBuyer, legal_name: "Esempio Strumenti S.r.l." }
    const q = await quoteCreateAndIssuePreflight(m.ctx, proforma(company))
    if (!("error" in q)) throw new Error("quote staged for a company without VAT number")
    expect(q.error.code).toBe("buyer_vat_id_required")
    const inv = await invoiceCreateAndIssuePreflight(m.ctx, proforma(company))
    if (!("error" in inv)) throw new Error("invoice staged for a company without VAT number")
    expect(inv.error.code).toBe("buyer_vat_id_required")
    await expect(
      draftsCreate(m.ctx, {
        type: "invoice",
        counterparty_contact_id: null,
        counterparty_name: company.legal_name,
        counterparty_country: "IT",
        counterparty_email: IT_EMAIL,
        counterparty_address: company.address,
        issuer_profile_id: "iss-1",
        items: [],
      }),
    ).rejects.toThrow(/buyer_vat_id_required/)
  })

  test("documents_update can not drop the VAT number of a business buyer on an issued proforma", async () => {
    const m = itCtx({ prior: [priorInvoice], orders: [b2bOrder], approved: true })
    const res = await proformaCreateAndIssue(m.ctx, proforma({ ...itBuyer, vat_id: VALID_VAT }))
    if (res.status !== "completed") throw new Error("setup failed")
    const upd = await documentsUpdate(m.ctx, { id: res.document_id, counterparty_vat_id: null })
    expect(upd.status).toBe("error")
    if (upd.status !== "error") throw new Error("unreachable")
    expect(upd.error.code).toBe("buyer_vat_id_required")
  })

  test("domestic and non-EU buyers are untouched", async () => {
    const m = itCtx()
    expect(await proformaCreateAndIssuePreflight(m.ctx, proforma(defaultCounterparty))).toEqual({
      ok: true,
    })
    expect(
      await proformaCreateAndIssuePreflight(
        m.ctx,
        proforma({ ...itBuyer, legal_name: "Acme Ltd", country: "US" }),
      ),
    ).toEqual({ ok: true })
    expect(m.viesCalls).toHaveLength(0)
  })

  test("legal forms and addresses match the way a person reads them", () => {
    expect(hasCompanyLegalForm("Esempio Strumenti SRL")).toBe(true)
    expect(hasCompanyLegalForm("Kanalwerk GmbH")).toBe(true)
    expect(hasCompanyLegalForm("Studio Rosso S.p.A.")).toBe(true)
    expect(hasCompanyLegalForm("Giulia Bianchi")).toBe(false)
    expect(hasCompanyLegalForm("Sasha Ivanova")).toBe(false)
    expect(
      sameAddress("Via dell'Esempio 12, 20121 Milano", "VIA DELL ESEMPIO 12 - 20121 MILANO (MI)"),
    ).toBe(true)
    expect(sameAddress("Via Roma 1, Milano", "Via Roma 10, Milano")).toBe(false)
    expect(
      sameFullAddress(
        "Via dell'Esempio 12, 20121 Milano",
        "VIA DELL ESEMPIO 12, 20121 MILANO (MI), Italia",
      ),
    ).toBe(true)
    expect(
      sameFullAddress("Via dell'Esempio 12, 20121 Milano", "Via dell'Esempio 12, 00100 Roma"),
    ).toBe(false)
    expect(compatibleNames("Negozio Esempio", "ESEMPIO STRUMENTI SRL")).toBe(true)
    expect(compatibleNames("Negozio Esempio", "Altra Ditta SRL")).toBe(false)
  })
})

// The buyer is a person's name on the agent's call, while the org's records say company: an
// imported invoice to the same address (with the person's name in front and no country) to a
// company, VAT-free, and a Shopify order of that customer with NO email, tagged B2B, tax exempt.
// Every name, address and number here is invented.
describe("intra-EU business buyer guard: evidence without a shared email or name", () => {
  const SHOP_CUSTOMER_GID = "gid://shopify/Customer/9001"
  const buyer: Counterparty = {
    contact_id: "contact-lf-1",
    legal_name: "Lucia Ferro",
    country: "IT",
    vat_id: null,
    address: "Via Esempio Nuova, 8\n10100 Torino\nItaly",
    email: "support@luciaferro.example",
  }
  const importedInvoice = {
    id: "doc-imported-5512",
    type: "invoice",
    status: "paid",
    channel: "import",
    number: "5512",
    issuer_profile_id: "iss-1",
    counterparty_name: "Bottega Notturna SAS",
    counterparty_address: "Marco Lucia Ferro, Via Esempio Nuova, 8, 10100 Torino",
    counterparty_email: null,
    counterparty_contact_id: null,
    counterparty_country: "IT",
    counterparty_vat_id: null,
    tax_treatment: "eu_destination",
    subtotal_minor: "36000",
    tax_total_minor: "0",
    grand_total_minor: "36000",
    currency: "EUR",
    external_refs: { shopify_order_number: "5512" },
  }
  const shopOrder = {
    id: "gid://shopify/Order/5512",
    title: "#5512",
    attributes: {
      email: null,
      tags: ["B2B", "DepotFR"],
      totalTax: "0.0",
      totalAmount: "360.00",
      taxExempt: true,
      customerTaxExempt: false,
      euDestination: true,
      shippingCountryCode: "IT",
      shippingAddress1: "Via Esempio Nuova 8",
      shippingZip: "10100",
      shippingCity: "Torino",
      b2bCompany: null,
      customer: {
        id: SHOP_CUSTOMER_GID,
        email: null,
        firstName: "Marco",
        lastName: "Lucia Ferro",
        defaultAddress: null,
      },
    },
  }
  const shopCustomer = {
    id: SHOP_CUSTOMER_GID,
    title: "Marco Lucia Ferro",
    attributes: {
      email: null,
      firstName: "Marco",
      lastName: "Lucia Ferro",
      tags: [],
      taxExempt: false,
      companies: [],
      defaultAddress: {
        address1: "Via Esempio Nuova 8",
        city: "Torino",
        zip: "10100",
        countryCode: "IT",
      },
      recentOrders: [{ name: "#5512", items: [] }],
    },
  }
  const VALID_VAT = "IT01234567890"

  type ShopMode = "found" | "absent" | "down" | "empty"
  function ctxFor(
    opts: { prior?: Array<Record<string, unknown>>; shop?: ShopMode; approved?: boolean } = {},
  ) {
    const shop = opts.shop ?? "found"
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const m = makeCtx({
      approval: opts.approved ? PRE_APPROVED : null,
      seed: {
        issuer_profiles: [
          {
            ...seedIssuer(defaultIssuer, { invoice: NO_GATE_MINOR, po: NO_GATE_MINOR }),
            prices_include_tax: true,
          },
        ],
        documents: opts.prior ?? [],
      },
      executeToolImpl: async (name, rawArgs) => {
        const args = (typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs) as Record<
          string,
          unknown
        >
        if (!name.startsWith("shopify:"))
          return { status: "completed", result: { dispatched: true } }
        calls.push({ name, args })
        if (shop === "absent")
          return {
            status: "error",
            error: {
              code: "tool_not_found",
              message: `tool ${name} not registered`,
              retryable: false,
            },
          }
        if (shop === "down")
          return {
            status: "error",
            error: { code: "timeout", message: "Shopify did not answer in time", retryable: true },
          }
        if (shop === "empty") return { status: "completed", result: { results: [] } }
        const q = String(args.query ?? "")
        // Shopify keys nothing by an email this customer never gave: an email query finds nothing.
        if (q.startsWith("email:")) return { status: "completed", result: { results: [] } }
        if (name === "shopify:customers_search") {
          return {
            status: "completed",
            result: { results: /lucia ferro/i.test(q) ? [shopCustomer] : [] },
          }
        }
        const hit =
          /5512/.test(q) || /lucia ferro/i.test(q) || /10100/.test(q) || q.includes("9001")
        return { status: "completed", result: { results: hit ? [shopOrder] : [] } }
      },
    })
    m.ctx.fetch = (async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify({
        isValid: true,
        userError: "VALID",
        name: "BOTTEGA NOTTURNA SAS",
        address: "VIA ESEMPIO NUOVA 8, 10100 TORINO",
      }),
    })) as ReadsFetch
    return { ...m, calls }
  }

  const params = (counterparty: Counterparty, extra: { buyer_is_consumer?: boolean } = {}) => ({
    counterparty,
    issuer_profile_id: "iss-1",
    currency: "EUR",
    reason: "Shop order",
    items: [
      {
        description: "Kestrel 6",
        quantity: "1",
        unit_price_minor: "36000",
        product_source: null,
        external_id: null,
      },
    ],
    ...extra,
  })

  test("the production case is REFUSED, naming the prior invoice, its company and the Shopify order", async () => {
    const m = ctxFor({ prior: [importedInvoice] })
    const pre = await proformaCreateAndIssuePreflight(m.ctx, params(buyer))
    if (!("error" in pre))
      throw new Error("preflight staged a consumer (OSS) proforma for a business buyer")
    expect(pre.error.code).toBe("buyer_vat_id_required")
    const msg = pre.error.message
    expect(msg).toContain("invoice 5512")
    expect(msg).toContain("the same address")
    expect(msg).toContain('"Bottega Notturna SAS"')
    expect(msg).toContain("WITHOUT VAT")
    expect(msg).toContain("Shopify order #5512")
    expect(msg).toContain('tagged "B2B"')
    expect(msg).toContain("tax exempt")
    // The likely legal entity, and where to find the VAT number.
    expect(msg).toContain('likely the company "Bottega Notturna SAS"')
    // The exact next call, with the values the guard derived (entity, destination, address).
    expect(msg).toContain(
      "Next step: call invoicing__vat_lookup with legal_name 'Bottega Notturna SAS', country 'IT', city 'Torino', postcode '10100'.",
    )
    expect(pre.error.body).toMatchObject({
      next_call: {
        tool: "invoicing__vat_lookup",
        params: {
          legal_name: "Bottega Notturna SAS",
          country: "IT",
          city: "Torino",
          postcode: "10100",
        },
      },
    })
    expect(msg).toContain("invoicing__vat_validate")
    expect(msg).toContain("company register")
    expect(msg).toContain("legal notice")
    expect(msg).toContain("counterparty.vat_id")
    expect(msg).toContain("counterparty.legal_name")
    const res = await proformaCreateAndIssue(m.ctx, params(buyer))
    expect(res.status).toBe("error")
    if (res.status !== "error") throw new Error("unreachable")
    expect(res.error.code).toBe("buyer_vat_id_required")
    expect(m.extras.approvalsRequested).toHaveLength(0)
    expect(m.db.__all("documents").filter((d) => d.type === "proforma")).toHaveLength(0)
  })

  test("the prior invoice alone is enough (Shopify not installed): the address matches across name, newlines and country", async () => {
    const m = ctxFor({ prior: [importedInvoice], shop: "absent" })
    const pre = await proformaCreateAndIssuePreflight(m.ctx, params(buyer))
    if (!("error" in pre))
      throw new Error("the prior VAT-free invoice to the same address was not seen")
    expect(pre.error.code).toBe("buyer_vat_id_required")
    expect(pre.error.message).toContain("invoice 5512")
  })

  test("the Shopify order alone is enough: found by the customer's name and address, not by email", async () => {
    const m = ctxFor({ prior: [] })
    const pre = await proformaCreateAndIssuePreflight(m.ctx, params(buyer))
    if (!("error" in pre))
      throw new Error("the B2B, tax-exempt Shopify order without an email was not seen")
    expect(pre.error.code).toBe("buyer_vat_id_required")
    expect(pre.error.message).toContain("Shopify order #5512")
    expect(pre.error.message).toContain('tagged "B2B"')
    expect(pre.error.message).toContain("tax exempt")
    // Looked up by more than the email.
    const queries = m.calls.map((c) => String(c.args.query ?? ""))
    expect(queries.some((q) => q.startsWith("email:"))).toBe(true)
    expect(queries.some((q) => /lucia ferro/i.test(q))).toBe(true)
    expect(m.calls.some((c) => c.name === "shopify:customers_search")).toBe(true)
  })

  test("the company on the earlier invoice of the matched Shopify order is named in next_call, never a placeholder", async () => {
    // The earlier invoice is NOT found by contact, email or address (another address, no email):
    // only the Shopify order found by the customer's name leads to it, through its order number.
    const noAddress: Counterparty = {
      ...buyer,
      address: "Corso Diverso 3\n10100 Torino",
      contact_id: null,
    }
    const elsewhere = { ...importedInvoice, counterparty_country: "FR" }
    const m = ctxFor({ prior: [elsewhere] })
    const pre = await proformaCreateAndIssuePreflight(m.ctx, params(noAddress))
    if (!("error" in pre)) throw new Error("staged a consumer (OSS) proforma for a business buyer")
    expect(pre.error.code).toBe("buyer_vat_id_required")
    expect(pre.error.message).toContain("invoice 5512")
    expect(pre.error.message).toContain('likely the company "Bottega Notturna SAS"')
    expect(pre.error.message).toContain(
      "call invoicing__vat_lookup with legal_name 'Bottega Notturna SAS'",
    )
    expect(pre.error.message).not.toContain("<the company")
    expect(pre.error.body).toMatchObject({
      next_call: { params: { legal_name: "Bottega Notturna SAS" } },
    })
  })

  test("no company on record: the refusal says to ask for the company's name, never a placeholder or the person's name", async () => {
    const m = ctxFor({ prior: [] })
    const pre = await proformaCreateAndIssuePreflight(m.ctx, params(buyer))
    if (!("error" in pre)) throw new Error("staged a consumer (OSS) proforma for a business buyer")
    expect(pre.error.code).toBe("buyer_vat_id_required")
    expect(pre.error.message).not.toContain("<the company")
    expect(pre.error.message).toContain("ask the user for the buyer company's legal name")
    expect(pre.error.message).not.toContain("legal_name 'Lucia Ferro'")
  })

  test("a street-only match (another postcode) still counts as evidence: a candidate is evidence", async () => {
    const elsewhere = {
      ...importedInvoice,
      counterparty_address: "Via Esempio Nuova 8, 20100 Milano",
      counterparty_name: "Bottega Notturna SAS",
    }
    const m = ctxFor({ prior: [elsewhere], shop: "absent" })
    const pre = await proformaCreateAndIssuePreflight(m.ctx, params(buyer))
    if (!("error" in pre)) throw new Error("a same-street VAT-free invoice was ignored")
    expect(pre.error.code).toBe("buyer_vat_id_required")
  })

  test("with a valid VAT number: reverse charge, 360.00 net, 0 VAT", async () => {
    const m = ctxFor({ prior: [importedInvoice], approved: true })
    const withVat = { ...buyer, legal_name: "Bottega Notturna SAS", vat_id: VALID_VAT }
    expect(await proformaCreateAndIssuePreflight(m.ctx, params(withVat))).toEqual({ ok: true })
    const res = await proformaCreateAndIssue(m.ctx, params(withVat))
    expect(res.status).toBe("completed")
    const doc = m.db.__all("documents").find((d) => d.type === "proforma")!
    expect(doc.tax_treatment).toBe("eu_reverse_charge")
    expect(String(doc.subtotal_minor)).toBe("36000")
    expect(String(doc.tax_total_minor)).toBe("0")
    expect(String(doc.grand_total_minor)).toBe("36000")
  })

  test("buyer_is_consumer against this evidence is for a person, and the card shows the evidence", async () => {
    const m = ctxFor({ prior: [importedInvoice] })
    const p = params(buyer, { buyer_is_consumer: true })
    expect(await proformaCreateAndIssuePreflight(m.ctx, p)).toEqual({
      ok: true,
      noAutoApprove: true,
    })
    const card = await summarizeProformaCreateAndIssue(p, undefined, {
      context: await documentsIssuePreview(m.ctx, p),
    })
    const t = card.lines.join("\n")
    expect(t).toContain("the agent declared this buyer a private consumer")
    expect(t).toContain("invoice 5512")
    expect(t).toContain("Bottega Notturna SAS")
  })

  test("Shopify down and nothing else conclusive: a person decides, and the card says business status NOT verified", async () => {
    const m = ctxFor({ prior: [], shop: "down" })
    expect(await proformaCreateAndIssuePreflight(m.ctx, params(buyer))).toEqual({
      ok: true,
      noAutoApprove: true,
    })
    const card = await summarizeProformaCreateAndIssue(params(buyer), undefined, {
      context: await documentsIssuePreview(m.ctx, params(buyer)),
    })
    expect(card.lines.join("\n")).toContain("business status NOT verified")
    // Shopify answering "nothing found" is a check that ran: no forced person.
    const ok = ctxFor({ prior: [], shop: "empty" })
    expect(await proformaCreateAndIssuePreflight(ok.ctx, params(buyer))).toEqual({ ok: true })
  })

  test("the Shopify lookups are capped, small and carry a short deadline", async () => {
    const m = ctxFor({ prior: [importedInvoice] })
    await proformaCreateAndIssuePreflight(m.ctx, params(buyer))
    expect(m.calls.length).toBeGreaterThan(0)
    expect(m.calls.length).toBeLessThanOrEqual(5)
    for (const c of m.calls) {
      expect(Number(c.args.limit)).toBeLessThanOrEqual(10)
      expect(Number(c.args.timeout_ms)).toBeGreaterThan(0)
      expect(Number(c.args.timeout_ms)).toBeLessThanOrEqual(3000)
    }
  })

  test("addresses match across a leading name, newlines, a country and a missing country", () => {
    const agent = "Via Esempio Nuova, 8\n10100 Torino\nItaly"
    const prior = "Marco Lucia Ferro, Via Esempio Nuova, 8, 10100 Torino"
    expect(sameAddress(agent, prior)).toBe(true)
    expect(sameFullAddress(agent, prior)).toBe(true)
    expect(sameFullAddress(agent, "Via Esempio Nuova 8, 10100 Torino TO, Italia")).toBe(true)
    expect(sameAddress(agent, "Via Esempio Nuova, 18, 10100 Torino")).toBe(false)
    expect(sameAddress(agent, "Corso Diverso 8, 10100 Torino")).toBe(false)
    expect(sameFullAddress(agent, "Via Esempio Nuova 8, 20100 Milano")).toBe(false)
    expect(
      sameAddress(
        "8 rue de l'Exemple, 75002 Paris, France",
        "Atelier Nord, 8 Rue de l Exemple, 75002 PARIS",
      ),
    ).toBe(true)
  })
})

// A person approves what the card says. Three readings of one call, for many calls: the card the host
// parks (summarizer), the card the handler parks, and the document issuing writes. The grid is fixed,
// so a failure reproduces by re-running this file.
describe("the approval card states the total that issues", () => {
  const QUANTITIES = ["1", "2", "3", "7", "1.5", "1.125", "0.333", "2.675", "40"]
  const PRICES = [1, 7, 99, 101, 333, 1261, 1999, 41940, 12345, 100005]
  const COUNTRIES = ["FR", "DE", "US", "GB", "IT"]
  const TOOLS = [
    {
      run: invoiceCreateAndIssue,
      card: summarizers.summarizeInvoiceCreateAndIssue,
      extra: { operation_category: "goods" },
    },
    { run: quoteCreateAndIssue, card: summarizers.summarizeQuoteCreateAndIssue, extra: {} },
    {
      run: proformaCreateAndIssue,
      card: summarizers.summarizeProformaCreateAndIssue,
      extra: { reason: "sample" },
    },
    { run: poCreateAndIssue, card: summarizers.summarizePoCreateAndIssue, extra: {} },
    {
      run: creditNoteCreateAndIssue,
      card: summarizers.summarizeCreditNoteCreateAndIssue,
      extra: { operation_category: "goods" },
      credit: true,
    },
  ] as const

  function totalOnCard(lines: string[]): string {
    const line = lines.find((l) => /^(Lines total|Total): /.test(l))
    const m = line ? /^(?:Lines total|Total): (-?[\d.]+ [A-Z]{3})/.exec(line) : null
    if (!m) throw new Error(`no total on card: ${JSON.stringify(lines)}`)
    return String(m[1])
  }

  test("over 500 calls, across types, issuers, buyers, quantities, prices and discounts", async () => {
    let seed = 20261106
    const next = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % n
    }
    const issuedSeen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const tool = TOOLS[i % TOOLS.length]!
      const credit = "credit" in tool
      const pricesIncludeTax = !credit && next(2) === 0
      const country = COUNTRIES[next(COUNTRIES.length)]!
      const counterparty = {
        ...defaultCounterparty,
        contact_id: null,
        legal_name: "Erika Mustermann",
        country,
        customer_kind: "individual",
        vat_id: null,
      }
      const items = Array.from({ length: 1 + next(3) }, (_, n) => {
        const quantity = QUANTITIES[next(QUANTITIES.length)]!
        // A credit note of a line that rounds to nothing is refused: keep every one above that.
        const unit = Math.max(PRICES[next(PRICES.length)]!, credit ? 99 : 1)
        const line: Record<string, unknown> = {
          position: n + 1,
          description: `Line ${n + 1}`,
          quantity,
          unit_price_minor: credit ? -unit : next(2) === 0 ? unit : String(unit),
          line_kind: "software",
          product_source: null,
          external_id: null,
        }
        if (next(4) === 0) line.tax_rate_bp_override = [0, 550, 2000][next(3)]
        // A discount stays inside its line: the one cent minimum of a small quantity would be refused.
        if (!credit && next(3) === 0 && unit >= 1000) line.discount_minor = next(2) === 0 ? 3 : "7"
        return line
      })
      const params = {
        counterparty,
        issuer_profile_id: "iss-1",
        currency: "EUR",
        items,
        ...tool.extra,
      } as never
      const label = `#${i} ${JSON.stringify({ country, pricesIncludeTax, items })}`

      const issuerRow = (invoice: bigint, po: bigint) => [
        { ...seedIssuer(defaultIssuer, { invoice, po }), prices_include_tax: pricesIncludeTax },
      ]
      const issuing = makeCtx({
        approval: PRE_APPROVED,
        seed: { issuer_profiles: issuerRow(NO_GATE_MINOR, NO_GATE_MINOR) },
      })
      const issued = (await tool.run(issuing.ctx, params)) as {
        status: string
        document_id?: string
        error?: unknown
      }
      if (issued.status !== "completed")
        throw new Error(`#${i} ${tool.run.name} ${JSON.stringify(issued).slice(0, 400)}`)
      const doc = issuing.db.__all("documents").find((d) => d.id === issued.document_id)!
      const total = formatMoneyMinor(BigInt(String(doc.grand_total_minor)), "EUR")
      issuedSeen.add(total)

      const issuer = issuing.db.__all("issuer_profiles")[0]!
      const hostCard = await tool.card(params, undefined, {
        context: { items: [issuer], original: null },
      } as never)
      expect(`${label} host ${totalOnCard(hostCard.lines)}`).toBe(`${label} host ${total}`)

      const parking = makeCtx({ seed: { issuer_profiles: issuerRow(0n, 0n) } })
      const parked = (await tool.run(parking.ctx, params)) as { status: string }
      if (parked.status === "pending_approval") {
        const asked = parking.extras.approvalsRequested.at(-1) as unknown as {
          summary_detail: { lines: string[] }
        }
        expect(`${label} handler ${totalOnCard(asked.summary_detail.lines)}`).toBe(
          `${label} handler ${total}`,
        )
      }
    }
    // The grid really varied.
    expect(issuedSeen.size).toBeGreaterThan(100)
  })
})

describe("a credit note's total is negative", () => {
  const base = {
    operation_category: "goods",
    counterparty: defaultCounterparty,
    issuer_profile_id: "iss-1",
    currency: "EUR",
  }
  const line = (unit: unknown, description = "Thing") => ({
    description,
    quantity: "1",
    unit_price_minor: unit,
    product_source: null,
    external_id: null,
  })

  test("a positive total is refused at stage and at execution, says what to send, takes no number", async () => {
    const m = makeCtx({ approval: PRE_APPROVED })
    const params = { ...base, items: [line(500)] } as never
    const pre = await creditNoteCreateAndIssuePreflight(m.ctx, params)
    if (!("error" in pre)) throw new Error("preflight let a positive credit note through")
    expect(pre.error.code).toBe("credit_note_not_negative")
    const res = await creditNoteCreateAndIssue(m.ctx, params)
    if (res.status !== "error") throw new Error("a positive credit note issued")
    expect(res.error.code).toBe("credit_note_not_negative")
    expect(res.error.message).toContain("send -500")
    expect(m.db.__all("documents")).toHaveLength(0)
  })

  test("a zero total is refused, unless it mirrors a zero-value invoice", async () => {
    const m = makeCtx({ approval: PRE_APPROVED })
    const res = await creditNoteCreateAndIssue(m.ctx, { ...base, items: [line(0)] } as never)
    if (res.status !== "error") throw new Error("a credit note of nothing issued")
    expect(res.error.code).toBe("credit_note_not_negative")

    const zero = makeCtx({ approval: PRE_APPROVED })
    const invoice = await invoiceCreateAndIssue(zero.ctx, {
      ...base,
      items: [line(0, "Warranty replacement")],
    } as never)
    if (invoice.status !== "completed")
      throw new Error(`no zero-value invoice: ${JSON.stringify(invoice)}`)
    const credit = await creditNoteCreateAndIssue(zero.ctx, {
      ...base,
      original_document_id: invoice.document_id,
      items: [line(0, "Warranty replacement")],
    } as never)
    expect(credit.status).toBe("completed")
  })

  test("a positive line stays allowed while the total is negative", async () => {
    const m = makeCtx({ approval: PRE_APPROVED })
    const res = await creditNoteCreateAndIssue(m.ctx, {
      ...base,
      items: [line(-1000, "Returned"), line(100, "Restocking fee")],
    } as never)
    expect(res.status).toBe("completed")
  })

  test("a draft with a positive total is refused at issue and stays a draft", async () => {
    const m = makeCtx({ approval: PRE_APPROVED })
    const { draft_id } = await draftsCreate(m.ctx, {
      type: "credit_note",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [line(500)],
    } as never)
    const res = await creditNoteIssue(m.ctx, { draft_id })
    if (res.status !== "error") throw new Error("a positive draft credit note issued")
    expect(res.error.code).toBe("credit_note_not_negative")
    expect(m.db.__all("documents").find((d) => d.id === draft_id)?.number ?? null).toBeNull()
  })
})

describe("a saved draft", () => {
  test("keeps a line's discount to issue, and its card states the total that issues", async () => {
    const m = makeCtx({ approval: PRE_APPROVED })
    const { draft_id } = await draftsCreate(m.ctx, {
      type: "invoice",
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      counterparty_name: "Buyer SARL",
      counterparty_address: "1 rue Buyer, 75002 Paris",
      counterparty_email: "ap@buyersarl.example",
      counterparty_country: "FR",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      items: [
        {
          position: 1,
          description: "Kestrel 6",
          quantity: "2",
          unit_price_minor: 10000,
          discount_minor: 500,
          product_source: null,
          external_id: null,
        },
      ],
    } as never)
    const stored = m.db.__all("document_lines").find((l) => l.document_id === draft_id)!
    expect(String(stored.discount_minor)).toBe("500")
    expect(String(stored.subtotal_minor)).toBe("19500")

    const preview = await draftIssuePreview(m.ctx as never, { draft_id })
    const card = await summarizers.summarizeInvoiceIssue({ draft_id }, undefined, {
      context: preview,
    } as never)

    const issued = await invoiceIssue(m.ctx, { draft_id })
    if (issued.status !== "completed") throw new Error(`not issued: ${JSON.stringify(issued)}`)
    const doc = m.db.__all("documents").find((d) => d.id === issued.document_id)!
    // 195.00 net: the discount reached the document.
    expect(String(doc.subtotal_minor)).toBe("19500")
    const total = formatMoneyMinor(BigInt(String(doc.grand_total_minor)), "EUR")
    expect(card.lines).toContain(`Total: ${total}`)
    expect(BigInt(String(doc.grand_total_minor))).toBeGreaterThan(19500n)
  })
})

describe("the other minor-unit fields read as issuing reads them", () => {
  test("a refund amount with a decimal point is refused, not rounded", async () => {
    for (const bad of [12.5, "12.50"]) {
      const m = makeCtx({ approval: PRE_APPROVED })
      const res = await documentsRecordRefund(m.ctx, {
        document_id: "any",
        refund_kind: "partial",
        refund_amount_minor: bad as never,
      })
      if (res.status !== "error") throw new Error("a fractional refund passed")
      expect(res.error.code).toBe("invalid_amount")
      expect(res.error.message).toContain("refund_amount_minor")
    }
  })

  test("an approval threshold with a decimal point is refused", async () => {
    const m = makeCtx({ scopes: ["*"] })
    const res = await settingsIssuerProfileWritePreflight(m.ctx, "update", {
      id: "iss-1",
      invoice_approval_threshold_minor: "1000.50",
    })
    if (!("error" in res)) throw new Error("a fractional threshold passed")
    expect(res.error.code).toBe("invalid_amount")
    expect(res.error.message).toContain("100050")
  })

  test("drafts refuse before parking, for create and update", async () => {
    const { ctx } = makeCtx()
    const input = {
      type: "invoice" as const,
      ...BUYER_DRAFT_EINVOICE,
      counterparty_contact_id: "contact-1",
      issuer_profile_id: "iss-1",
      currency: "USD",
    }
    const bad = [{ description: "x", quantity: "1", unit_price_minor: "899.00" }] as never
    expect(await draftsCreatePreflightHandler({ ...input, items: bad }, ctx)).toMatchObject({
      error: { code: "invalid_amount" },
    })
    expect(
      await draftsUpdatePreflightHandler({ draft_id: "d", patch: { lines: bad } }, ctx),
    ).toMatchObject({
      error: {
        code: "invalid_amount",
        message: expect.stringContaining("patch.lines[0].unit_price_minor"),
      },
    })
    expect(await draftsCreatePreflightHandler({ ...input, items: sampleDraftItems }, ctx)).toEqual({
      ok: true,
    })
  })
})

describe("isUniqueViolation", () => {
  test("reads a unique-key conflict from an error, its cause, or a sandboxed call's rejection text", () => {
    const text =
      'Failed query — pg: duplicate key value violates unique constraint "documents_org_id_external_ref_key" (23505)'
    expect(isUniqueViolation(Object.assign(new Error("x"), { code: "23505" }))).toBe(true)
    expect(isUniqueViolation(new Error("outer", { cause: new Error(text) }))).toBe(true)
    // A failed bridge call without an HTTP status reaches a sandboxed handler as a plain string.
    expect(isUniqueViolation(text)).toBe(true)
    expect(isUniqueViolation("connection reset")).toBe(false)
    expect(isUniqueViolation(new Error("connection reset"))).toBe(false)
  })
})
