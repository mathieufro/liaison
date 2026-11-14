// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every gated invoicing tool's approval card says what approving it does, in words a person
// can decide on: the document by number and type, the customer by name, money with its
// currency, the order by its store name, an edit as before -> after. No raw id, gid, JSON,
// snake_case field name or minor-unit amount; no dash punctuation.
//
// The card is built the way the kernel builds it: the tool's declared summarizer (manifest
// `summarizer`), fed the read its `summarizerContext` names; a tool that declares none gets
// the kernel's fallback, a "field: value" dump (replicated here from
// apps/api/src/modules/apps/approval-summarizers.ts defaultSummary), which these tests reject.

import { describe, expect, it } from "bun:test"
import manifest from "../app.manifest.json"
import { CARD_MAX_LINES } from "./approval-cards"
import * as summarizers from "./summarizers"

type Card = {
  kind: string
  title: string
  subtitle?: string
  lines: string[]
  links?: Array<{ label: string; entityId?: string }>
}
type Tool = {
  gated?: boolean
  summarizer?: string
  approvalCard?: unknown
  summarizerContext?: { tool: string; params: Record<string, string> }
}
const TOOLS = (manifest as unknown as { tools: Record<string, Tool> }).tools

/** The kernel's fallback card for a gated tool with no summarizer. */
function kernelFallback(toolName: string, params: Record<string, unknown>): Card {
  const compact = (v: unknown): string => {
    if (v === null || v === undefined) return "(none)"
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v)
    if (Array.isArray(v))
      return v.length === 0 ? "(empty list)" : `${v.length} item${v.length === 1 ? "" : "s"}`
    return JSON.stringify(v)
  }
  return {
    kind: toolName,
    title: `invoicing:${toolName}`,
    subtitle: "Pending approval",
    lines: Object.entries(params)
      .slice(0, 7)
      .map(([k, v]) => `${k}: ${compact(v)}`.slice(0, 200)),
  }
}

async function cardFor(
  toolName: string,
  params: Record<string, unknown>,
  context: unknown = null,
): Promise<Card> {
  const tool = TOOLS[toolName]
  expect(tool).toBeDefined()
  const fn = tool!.summarizer
    ? (summarizers as Record<string, unknown>)[tool!.summarizer]
    : undefined
  if (typeof fn !== "function") return kernelFallback(toolName, params)
  return (await (fn as (p: unknown, c: unknown, m: unknown) => Promise<Card>)(params, undefined, {
    context,
  })) as Card
}

function visible(card: Card): string {
  return [
    card.title,
    card.subtitle ?? "",
    ...card.lines,
    ...(card.links ?? []).map((l) => l.label),
  ].join("\n")
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** The card reads as words: no handle, no JSON, no field names, no dash punctuation. */
function expectHuman(card: Card, rawMinor: string[] = []) {
  const t = visible(card)
  expect(t).not.toMatch(UUID)
  expect(t).not.toMatch(/gid:\/\//)
  expect(t).not.toMatch(/[{}"]|\[object/)
  expect(t).not.toMatch(/\b[a-z]+_[a-z_]+\b/) // snake_case field name
  expect(t).not.toMatch(/[–—]|--/)
  expect(t).not.toContain("Pending approval")
  for (const raw of rawMinor) expect(t).not.toMatch(new RegExp(`(?<![\\d.,])${raw}(?![\\d.,])`))
  expect(card.lines.length).toBeGreaterThan(0)
  expect(card.lines.length).toBeLessThanOrEqual(8)
  for (const l of card.lines) expect(l.length).toBeLessThanOrEqual(200)
}

const DOC_ID = "f620184e-1c7a-4d2b-9a51-3f0d2a9b7c11"
const ISSUER_ID = "0b9c3e1a-7d5f-4a8e-9c21-6e4f8a2d1b30"
const ORDER_GID = "gid://shopify/Order/6123456789012"

const proforma = {
  id: DOC_ID,
  type: "proforma",
  number: "PRO-2026-0029",
  status: "sent",
  currency: "USD",
  subtotal_minor: "0",
  tax_total_minor: "0",
  grand_total_minor: "0",
  payment_status: "unpaid",
  tax_treatment: "us_export",
  counterparty_name: "Thomas Raz",
  counterparty_email: "thomas@raz.example",
  counterparty_country: "US",
  shopify_order_id: ORDER_GID,
  shopify_order_number: "#3446",
  due_at: "2026-11-01",
  lines: [
    {
      id: "a1b2c3d4-0000-4000-8000-000000000001",
      description: "Kestrel 6",
      quantity: "1",
      unit_price_minor: "0",
      discount_minor: "0",
    },
  ],
}

const invoice = {
  ...proforma,
  type: "invoice",
  number: "INV-2026-3531",
  currency: "EUR",
  subtotal_minor: "34950",
  tax_total_minor: "6990",
  grand_total_minor: "41940",
  tax_treatment: "eu_domestic",
  counterparty_name: "Atelier Sonore",
  counterparty_email: "compta@ateliersonore.example",
  counterparty_country: "FR",
  shopify_order_number: "#3502",
}

const draft = { ...invoice, number: null, status: "draft", grand_total_minor: "41940" }

const issuers = {
  items: [
    {
      id: ISSUER_ID,
      legal_name: "Resonant Audio Labs",
      default_currency: "EUR",
      iban: "FR7600000000000000000000001",
      invoice_approval_threshold_minor: "100000",
    },
  ],
}

describe("invoicing approval cards: edits", () => {
  it("documents_update names the document, the customer and the total before -> after", async () => {
    const card = await cardFor(
      "documents_update",
      { id: DOC_ID, lines: [{ description: "Kestrel 6", quantity: 1, unit_price_minor: 100 }] },
      proforma,
    )
    expect(card.title).toBe(
      "Change proforma PRO-2026-0029 (Thomas Raz) total from 0.00 USD to 1.00 USD",
    )
    expect(card.lines).toContain("Total: 0.00 USD -> 1.00 USD")
    expect(card.lines).toContain("Line 1: Kestrel 6 x 1 @ 0.00 USD -> Kestrel 6 x 1 @ 1.00 USD")
    expect(card.lines).toContain("Order: #3446")
    expect(card.lines).toContain("Customer: Thomas Raz")
    expect(card.links?.[0]?.label).toBe("Open proforma PRO-2026-0029")
    expectHuman(card, ["100"])
  })

  it("documents_update shows each changed field by name, before -> after, and skips unchanged ones", async () => {
    const card = await cardFor(
      "documents_update",
      {
        id: DOC_ID,
        counterparty_email: "billing@raz.example",
        due_at: "2026-12-01",
        counterparty_contact_id: ISSUER_ID,
        incoterm: undefined,
        notes: null,
        counterparty_name: "Thomas Raz",
      },
      proforma,
    )
    expect(card.title).toContain("Edit proforma PRO-2026-0029 (Thomas Raz)")
    expect(card.lines).toContain("Customer email: thomas@raz.example -> billing@raz.example")
    expect(card.lines).toContain("Due date: 2026-11-01 -> 2026-12-01")
    expect(card.lines).toContain("Linked contact: (none) -> (a contact)")
    expect(visible(card)).not.toContain("Customer name:")
    expectHuman(card)
  })

  it("documents_update with tax names the subtotal, never a guessed total", async () => {
    const card = await cardFor(
      "documents_update",
      { id: DOC_ID, lines: [{ description: "Kestrel 6", quantity: 2, unit_price_minor: 34950 }] },
      invoice,
    )
    expect(card.title).toBe(
      "Change invoice INV-2026-3531 (Atelier Sonore) subtotal from 349.50 EUR to 699.00 EUR",
    )
    expectHuman(card, ["34950", "69900"])
  })

  it("documents_update still reads as words when the document could not be read", async () => {
    const card = await cardFor("documents_update", {
      id: DOC_ID,
      po_number: "PO 77",
      lines: [{ description: "Kestrel 6", quantity: 1, unit_price_minor: 100 }],
    })
    expect(card.lines).toContain("Customer PO number: set to PO 77")
    expectHuman(card, ["100"])
  })

  it("settings_issuer_profile_update shows each setting by its name, money formatted", async () => {
    const card = await cardFor(
      "settings_issuer_profile_update",
      {
        id: ISSUER_ID,
        iban: "FR7611111111111111111111111",
        invoice_approval_threshold_minor: 500000,
        require_two_eyes: true,
      },
      issuers,
    )
    expect(card.title).toBe("Change issuer profile Resonant Audio Labs")
    expect(card.lines).toContain("IBAN: FR7600000000000000000000001 -> FR7611111111111111111111111")
    expect(card.lines).toContain("Invoice approval threshold: 1000.00 EUR -> 5000.00 EUR")
    expect(card.lines).toContain("Two people must approve: (empty) -> yes")
    expectHuman(card, ["500000", "100000"])
  })

  it("settings_issuer_profile_delete names the profile it deletes", async () => {
    const card = await cardFor("settings_issuer_profile_delete", { id: ISSUER_ID }, issuers)
    expect(card.title).toBe("Delete issuer profile Resonant Audio Labs")
    expectHuman(card)
  })
})

describe("invoicing approval cards: issuing", () => {
  it("proforma_create_and_issue: customer, amount and order in one sentence, from a JSON counterparty string", async () => {
    const card = await cardFor(
      "proforma_create_and_issue",
      {
        counterparty: JSON.stringify({
          legal_name: "Thomas Raz",
          country: "US",
          email: "thomas@raz.example",
        }),
        items: [{ description: "Kestrel 6", quantity: 1, unit_price_minor: 100 }],
        reason: "Customs value for the replacement unit",
        declared_value_minor: 100,
        issuer_profile_id: ISSUER_ID,
        currency: "USD",
        shopify_order_id: ORDER_GID,
        shopify_order_number: "3446",
      },
      issuers,
    )
    expect(card.title).toBe("Issue proforma for Thomas Raz, 1.00 USD, order #3446")
    expect(card.lines).toContain("Customer: Thomas Raz")
    expect(card.lines).toContain("Order: #3446")
    expect(card.lines).toContain("Declared customs value: 1.00 USD")
    expect(card.lines).toContain("Line: Kestrel 6 x 1 @ 1.00 USD")
    expect(card.lines).toContain("Issued by: Resonant Audio Labs")
    expectHuman(card, ["100"])
  })

  it("invoice_create_and_issue names the customer and the lines total, many lines summarised", async () => {
    const items = Array.from({ length: 9 }, (_, i) => ({
      description: `Pad ${i + 1}`,
      quantity: 1,
      unit_price_minor: 1000,
    }))
    const card = await cardFor(
      "invoice_create_and_issue",
      { counterparty: { legal_name: "Atelier Sonore", country: "FR" }, items, currency: "EUR" },
      issuers,
    )
    expect(card.title).toBe("Issue invoice for Atelier Sonore, 90.00 EUR")
    expect(card.lines.some((l) => /^and \d+ more lines$/.test(l))).toBe(true)
    expectHuman(card, ["1000", "9000"])
  })

  for (const [tool, type] of [
    ["invoice_issue", "invoice"],
    ["quote_issue", "quote"],
    ["proforma_issue", "proforma"],
  ] as const) {
    it(`${tool}: issues the saved draft for its customer, total and order, no draft id`, async () => {
      const card = await cardFor(tool, { draft_id: DOC_ID }, { ...draft, type })
      expect(card.title).toBe(`Issue ${type} for Atelier Sonore, 419.40 EUR, order #3502`)
      expect(card.lines).toContain(
        `Document: new ${type} from a saved draft (number assigned on issue)`,
      )
      expect(card.lines).toContain("Total: 419.40 EUR")
      expectHuman(card, ["41940"])
    })
  }
})

describe("invoicing approval cards: money on issued documents", () => {
  it("documents_record_refund: amount, document and customer", async () => {
    const card = await cardFor(
      "documents_record_refund",
      { document_id: DOC_ID, refund_amount_minor: 41940, refund_kind: "full" },
      invoice,
    )
    expect(card.title).toBe(
      "Record a full refund of 419.40 EUR on invoice INV-2026-3531 (Atelier Sonore)",
    )
    expect(card.lines).toContain("Order: #3502")
    expectHuman(card, ["41940"])
  })

  it("documents_mark_paid: document, customer and total", async () => {
    const card = await cardFor(
      "documents_mark_paid",
      { document_id: DOC_ID, paid_date: "2026-10-15" },
      invoice,
    )
    expect(card.title).toBe("Mark invoice INV-2026-3531 (Atelier Sonore) as paid, 419.40 EUR")
    expect(card.lines).toContain("Paid on: 2026-10-15")
    expectHuman(card, ["41940"])
  })

  it("documents_convert_to_invoice: the quote it converts, for whom and how much", async () => {
    const card = await cardFor(
      "documents_convert_to_invoice",
      { source_document_id: DOC_ID },
      { ...invoice, type: "quote", number: "QUO-2026-0007", shopify_draft_order_name: "#D12" },
    )
    expect(card.title).toBe(
      "Convert quote QUO-2026-0007 (Atelier Sonore) into an invoice, 419.40 EUR",
    )
    expect(card.lines).toContain(
      "Shopify draft order #D12 is completed in Shopify with payment pending",
    )
    expectHuman(card, ["41940"])
  })

  it("documents_send_to_customer: what is sent, to which address", async () => {
    const card = await cardFor("documents_send_to_customer", { document_id: DOC_ID }, invoice)
    expect(card.title).toBe("Email invoice INV-2026-3531 to compta@ateliersonore.example")
    expect(card.lines).toContain("Total: 419.40 EUR")
    expectHuman(card, ["41940"])
  })

  it("order_reissue_apply: the invoice it reverses and the order", async () => {
    const card = await cardFor(
      "order_reissue_apply",
      {
        original_document_id: DOC_ID,
        shopify_order_id: ORDER_GID,
        shopify_order_number: "#3502",
        billing_signature: "abc",
        dedupe_key: "k",
        currency: "EUR",
        items: [{ description: "Kestrel 6", quantity: 1, unit_price_minor: 30000 }],
      },
      invoice,
    )
    expect(card.title).toBe("Reissue invoice INV-2026-3531 for the edited order #3502")
    expectHuman(card, ["41940", "30000"])
  })
})

describe("invoicing approval cards: e-invoicing and customer settings", () => {
  it("einvoice_send names the invoice and its customer", async () => {
    const card = await cardFor(
      "einvoice_send",
      {
        document_id: DOC_ID,
        legal_original_sha256: "ab".repeat(32),
        buyer_siren: "552100554",
        routing_address: "552100554_ROUTE",
      },
      invoice,
    )
    expect(card.title).toBe("Send invoice INV-2026-3531 (Atelier Sonore) as an e-invoice")
    expect(card.lines).toContain("Buyer SIREN: 552100554")
    expectHuman(card)
  })

  it("received_einvoice_set_status names the supplier invoice", async () => {
    const card = await cardFor(
      "received_einvoice_set_status",
      { received_id: DOC_ID, action: "refuse", reason: "DOUBLON" },
      {
        status: "ok",
        invoice: {
          supplier: { name: "Fournitures Martin" },
          invoice_number: "FM-881",
          issue_date: "2026-10-02",
          currency: "EUR",
          totals: { total: "120.00" },
        },
      },
    )
    expect(card.title).toBe("Refuse supplier invoice FM-881 from Fournitures Martin")
    expect(card.lines).toContain("Total: 120.00 EUR")
    expectHuman(card, ["12000"])
  })

  it("deferred_tax_override names the order and the tax source in words", async () => {
    const card = await cardFor(
      "deferred_tax_override",
      { deferred_id: "77", mode: "shopify_reported" },
      { items: [{ id: "77", order_number: "#3510", reason: "shopify_tax_mismatch" }] },
    )
    expect(card.title).toBe(
      "Issue the invoice for order #3510 with the tax Shopify reported on each line",
    )
    expectHuman(card)
  })

  it("counterparty_territory_set names the customer and the treatment in words", async () => {
    const card = await cardFor(
      "counterparty_territory_set",
      { contact_id: DOC_ID, treatment: "as_foreign", reason: "Ships to Geneva" },
      { counterparty_name: "Atelier Sonore" },
    )
    expect(card.title).toBe("Treat Atelier Sonore as a foreign customer (export or EU rules)")
    expectHuman(card)
  })

  it("einvoicing settings and backfills read as settings, not field names", async () => {
    const settings = await cardFor("einvoicing_settings_set", {
      gate_mode: "enforce",
      send_enabled: true,
      cutover_date: "2026-09-01",
      provider_app: "pennylane",
    })
    expect(settings.lines).toContain("Send e-invoices: on")
    expect(settings.lines).toContain("E-invoicing platform: Pennylane")
    expectHuman(settings)
    expectHuman(await cardFor("einvoicing_backfill_identities", { dry_run: false, limit: 50 }))
    expectHuman(await cardFor("einvoicing_backfill_legacy_originals", { dry_run: true }))
    expectHuman(await cardFor("einvoice_book_batch", { batch_id: DOC_ID }))
    expectHuman(await cardFor("einvoice_send_batch", { batch_id: DOC_ID }))
  })
})

describe("invoicing approval cards: coverage", () => {
  it("every gated invoicing tool declares an exported summarizer (no kernel field dump)", () => {
    const missing = Object.entries(TOOLS)
      .filter(([, t]) => t.gated === true)
      .filter(
        ([, t]) =>
          !t.summarizer ||
          typeof (summarizers as Record<string, unknown>)[t.summarizer] !== "function",
      )
      .map(([n]) => n)
    expect(missing).toEqual([])
  })

  it("every summarizer context names an ungated read of this app", () => {
    for (const [name, t] of Object.entries(TOOLS)) {
      if (!t.summarizerContext) continue
      const read = TOOLS[t.summarizerContext.tool]
      expect({ name, read: !!read, gated: read?.gated === true }).toEqual({
        name,
        read: true,
        gated: false,
      })
    }
  })
})

describe("invoicing approval cards: a quote staged before it is issued", () => {
  it("quote_create_and_issue states the customer, each line with its discount, the total, validity and customer ref", async () => {
    const card = await cardFor(
      "quote_create_and_issue",
      {
        issuer_profile_id: ISSUER_ID,
        counterparty: {
          legal_name: "Northwind Acoustics",
          country: "PT",
          email: "ines@northwind.example",
        },
        customer_reference: "CRM-1042",
        due_at: "2026-11-30",
        items: [
          {
            description: "Kestrel 6",
            quantity: 40,
            unit_price_minor: 89900,
            discount_minor: 1366480,
          },
        ],
      },
      issuers,
    )
    expectHuman(card, ["89900", "1366480"])
    expect(card.title).toContain("Issue quote for Northwind Acoustics")
    const t = visible(card)
    expect(t).toContain("Customer: Northwind Acoustics")
    expect(t).toMatch(/Line: Kestrel 6 x 40 @ .*899.*less .*13.?664/)
    expect(t).toMatch(/Lines total: .*22.?295/)
    expect(t).toContain("Customer ref: CRM-1042")
    expect(t).toContain("Valid until: 2026-11-30")
    expect(t).toContain("Issued by: Resonant Audio Labs")
  })
})

describe("invoicing approval cards: a draft parked for any reason but a consumer declaration", () => {
  const CONSUMER = /private consumer|consumer VAT/i
  const company = {
    type: "proforma",
    counterparty_name: "Werkton Distribution GmbH",
    counterparty_vat_id: "DE123456789",
    shopify_order_number: "3446",
    currency: "EUR",
    items: [{ description: "Kestrel 6", quantity: 2, unit_price_minor: 41940 }],
  }

  it("drafts_create for a company: says what it creates, and claims no consumer", async () => {
    const card = await cardFor("drafts_create", company)
    expectHuman(card, ["41940"])
    expect(card.title).toBe("Create a draft proforma for Werkton Distribution GmbH")
    expect(visible(card)).not.toMatch(CONSUMER)
    expect(visible(card)).toContain("Order: #3446")
    expect(visible(card)).toContain("Kestrel 6 x 2 @ 419.40")
  })

  it("drafts_create that declares a consumer says so, in the call's own terms", async () => {
    const card = await cardFor("drafts_create", { ...company, buyer_is_consumer: true })
    expectHuman(card)
    expect(card.lines[0]).toContain("This call declares the buyer a private consumer")
  })

  it("drafts_update of a company draft: names the document and the change, and claims no consumer", async () => {
    const context = {
      id: DOC_ID,
      type: "proforma",
      number: null,
      counterparty_name: "Werkton Distribution GmbH",
    }
    const card = await cardFor(
      "drafts_update",
      { draft_id: DOC_ID, patch: { notes: "Ship in one crate" } },
      context,
    )
    expectHuman(card)
    expect(card.title).toBe("Update draft proforma (Werkton Distribution GmbH)")
    expect(visible(card)).toContain("Notes: set to Ship in one crate")
    expect(visible(card)).not.toMatch(CONSUMER)
  })

  it("drafts_update still says something true when the document cannot be read", async () => {
    const card = await cardFor("drafts_update", {
      draft_id: DOC_ID,
      patch: { due_at: "2026-11-30" },
    })
    expectHuman(card)
    expect(card.title).toBe("Update a draft")
    expect(visible(card)).not.toMatch(CONSUMER)
  })

  it("drafts_update that declares or clears a consumer says so", async () => {
    const declared = await cardFor("drafts_update", {
      draft_id: DOC_ID,
      patch: { buyer_is_consumer: true },
    })
    expect(declared.lines[0]).toContain("This call declares the buyer a private consumer")
    const cleared = await cardFor("drafts_update", {
      draft_id: DOC_ID,
      patch: { buyer_is_consumer: false },
    })
    expect(cleared.lines[0]).toContain("removes the declaration")
    expectHuman(declared)
    expectHuman(cleared)
  })

  it("the tools use the summarizer, not a fixed sentence", () => {
    for (const name of ["drafts_create", "drafts_update"]) {
      expect(typeof TOOLS[name]?.summarizer).toBe("string")
      expect(TOOLS[name]?.approvalCard).toBeUndefined()
    }
  })
})

describe("credit note and purchase order cards", () => {
  const {
    summarizeCreditNoteCreateAndIssue,
    summarizeCreditNoteIssue,
    summarizePoCreateAndIssue,
    summarizePoIssue,
  } = summarizers

  it("every issuing tool an approval can park declares a summarizer, not the template fallback", () => {
    const missing = Object.entries(TOOLS)
      .filter(([name, t]) => /_issue$/.test(name) && !t.summarizer)
      .map(([name]) => name)
    expect(missing).toEqual([])
  })

  const items = [
    { description: "Kestrel 6 Field Recorder", quantity: "1", unit_price_minor: -89900 },
    { description: "USB C Cable", quantity: "1", unit_price_minor: -1900 },
  ]
  const counterparty = { legal_name: "Grace Whitfield", country: "US", email: "grace@example.com" }
  const issuers = {
    items: [{ id: "issuer-1", country: "FR", legal_name: "Resonant SAS", default_currency: "EUR" }],
  }

  it("a credit note states the amount, every line, the date and the invoice it reverses", async () => {
    const card = await summarizeCreditNoteCreateAndIssue(
      {
        counterparty,
        items,
        currency: "EUR",
        issued_at: "2026-11-03",
        original_document_id: "INV-2026-0017",
      },
      undefined,
      {
        context: {
          ...issuers,
          original: { number: "INV-2026-0017", issued_at: "2026-10-30T00:00:00.000Z" },
        },
      },
    )
    expect(card.title).toBe("Credit 918.00 EUR on INV-2026-0017 for Grace Whitfield")
    expect(card.lines).toContain("Reverses invoice: INV-2026-0017 (2026-10-30)")
    expect(card.lines).toContain("Issue date: 2026-11-03")
    expect(card.lines.join("\n")).toContain("-918.00 EUR")
    expect(card.lines.join("\n")).toContain("Kestrel 6 Field Recorder")
    expect(card.lines.join("\n")).toContain("USB C Cable")
    expect(card.lines.length).toBeLessThanOrEqual(CARD_MAX_LINES)
  })

  it("a credit note keeps its amount, date and invoice on the card with many lines and a long reason", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      description: `Line ${i}`,
      quantity: "1",
      unit_price_minor: -100,
    }))
    const card = await summarizeCreditNoteCreateAndIssue(
      { counterparty, items: many, reason: "Returned", original_document_id: "INV-2026-0017" },
      undefined,
      { context: issuers },
    )
    const text = card.lines.join("\n")
    expect(text).toContain("Total: -12.00 EUR")
    expect(text).toContain("Reverses invoice: INV-2026-0017")
    expect(text).toContain("Issue date: the day this is approved")
    expect(text).toContain("more line")
    // The disclosure line a tainted proposal adds takes the eighth line, never one of these.
    expect(card.lines.slice(0, 7).join("\n")).toContain("Issue date")
  })

  it("an unhydrated credit note still states the lines total and never prints an id", async () => {
    const card = await summarizeCreditNoteCreateAndIssue({
      counterparty,
      items,
      original_document_id: "1949cceb-504c-41ef-8d77-6669593136fa",
    })
    const text = [card.title, ...card.lines].join("\n")
    expect(text).toContain("Lines total: -918.00 EUR as typed")
    expect(text).toContain("the invoice referenced")
    expect(text).not.toContain("1949cceb")
  })

  // A step of a sequence skips the stage-time check (its params carry @ref tokens): the card is then
  // all a person has. The walk's card said "Credit 0.00 EUR" over a credit note that issued -1,500.00.
  it("a call whose amount cannot be read says it will be refused, and prints no amount", async () => {
    for (const bad of ["-1260.50", "899.00", -550.5, "$1"]) {
      const card = await summarizeCreditNoteCreateAndIssue(
        { counterparty, items: [{ description: "Thing", quantity: "1", unit_price_minor: bad }] },
        undefined,
        { context: issuers },
      )
      const text = [card.title, ...card.lines].join("\n")
      expect(card.title).toContain("will be refused")
      expect(text).toContain("REFUSED")
      expect(text).toContain(JSON.stringify(bad))
      expect(text).not.toMatch(/\d\.\d\d EUR/)
    }
  })

  it("a positive credit note says it will be refused", async () => {
    const card = await summarizeCreditNoteCreateAndIssue(
      {
        counterparty,
        items: [{ description: "Thing", quantity: "1", unit_price_minor: 500 }],
        original_document_id: "INV-1",
      },
      undefined,
      { context: { ...issuers, original: { number: "INV-1", grand_total_minor: "9000" } } },
    )
    expect(card.title).toContain("will be refused")
    expect(card.lines[0]).toContain("must be negative")
  })

  it("a zero credit note on a zero-value invoice stays a plain card", async () => {
    const card = await summarizeCreditNoteCreateAndIssue(
      {
        counterparty,
        items: [{ description: "Warranty", quantity: "1", unit_price_minor: 0 }],
        original_document_id: "INV-1",
      },
      undefined,
      { context: { ...issuers, original: { number: "INV-1", grand_total_minor: "0" } } },
    )
    expect(card.title).not.toContain("will be refused")
  })

  it("a credit note from a draft names its invoice and its total", async () => {
    const card = await summarizeCreditNoteIssue({ draft_id: "d1" }, undefined, {
      context: {
        id: "d1",
        type: "credit_note",
        currency: "EUR",
        grand_total_minor: "-91800",
        counterparty_name: "Grace Whitfield",
        external_refs: { original_document_number: "INV-2026-0017" },
        lines: items,
      },
    })
    expect(card.title).toBe("Credit 918.00 EUR on INV-2026-0017 for Grace Whitfield")
    expect(card.lines).toContain("Total: -918.00 EUR")
    expect(card.lines).toContain("Issue date: the day this is approved")
  })

  it("a purchase order states its total and lines, on both issuing tools", async () => {
    const lines = [{ description: "Enclosures", quantity: "2", unit_price_minor: 5000 }]
    const created = await summarizePoCreateAndIssue(
      {
        counterparty: { legal_name: "Acme Parts", country: "DE" },
        items: lines,
        currency: "EUR",
        issued_at: "2026-11-02",
      },
      undefined,
      { context: issuers },
    )
    // 100.00 net at the German rate the document will charge.
    expect(created.title).toContain("119.00 EUR")
    expect(created.lines.join("\n")).toContain("Enclosures")
    expect(created.lines).toContain("Issue date: 2026-11-02")
    const fromDraft = await summarizePoIssue({ draft_id: "d2" }, undefined, {
      context: {
        id: "d2",
        type: "purchase_order",
        currency: "EUR",
        grand_total_minor: "10000",
        counterparty_name: "Acme Parts",
        lines,
      },
    })
    expect(fromDraft.title).toContain("100.00 EUR")
    expect(fromDraft.lines.join("\n")).toContain("Enclosures")
  })
})
