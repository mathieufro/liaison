// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `seedDemoCommerce` — the commerce and finance half of the public demo world.
//
// It takes what `seedDemoOrg` returns and fills four apps with the trading
// history the fictional company would actually have: invoicing documents and
// their lines, the Pennylane home snapshots, the Boxtal shipping queues and the
// social listening feed. Support and collaboration data is a different batch
// and a different file.
//
// ── WHY IT WRITES ROWS RATHER THAN CALLING TOOLS ──────────────────────────────
// Three of the four apps read their own local tables, so a seeded row IS what
// the screen renders. The fourth (pennylane) is a hybrid: its Home dashboard
// reads the cached `pnl_snapshot` / `cash_snapshot` tables, while its nine list
// handlers refetch from the live Pennylane API and return a
// `pennylane_not_connected` envelope with no credential. The Home dashboard is
// therefore seeded and the lists are deliberately left in their not connected
// state: faking a credential would be a lie the demo could not keep.
//
// Two Boxtal surfaces are also deliberately untouched: `to_prepare_list` derives
// from a LIVE Shopify order scan and `track` / `get_documents` refetch from
// Boxtal. Those belong to the Shopify demo data provider, not here. Shopify and
// ads have no local mirror at all and are not seeded.
//
// ── DETERMINISM ───────────────────────────────────────────────────────────────
// Every id is derived from (orgId, kind, key) through a SHA-256 digest, and
// every timestamp is a fixed offset from the caller's `baseTime`. So the world
// always looks freshly active, two runs against the same org produce
// byte-identical rows, and the seeder is re-runnable: every write is an upsert
// on the primary key, so a second run changes no row count. There is no
// `Math.random` and no clock read here.
//
// ── PDFs ──────────────────────────────────────────────────────────────────────
// Issued documents are seeded with `pdf_status = 'pending'` and NO
// `pdf_file_id`. That is the app's own documented "retry me" state: both
// `documents_retry_pdf` and `documents_send_to_customer` re-render from the
// persisted document whenever the status is null, pending or failed, so the
// PDF a visitor asks for is rendered by the real template path on demand. A
// seeded `pdf_status = 'ready'` would need a real stored file behind it, and a
// fabricated file id would 404 on the first click.
//
// ── WHERE THE WRITES LIVE ─────────────────────────────────────────────────────
// This file is the demo company's commerce FICTION: its parties, documents,
// shipments, social feed and incidents. The rows are written by the commerce
// factories (`seed/factories/commerce/*`, contacts in `factories/people`,
// staged approvals in `factories/approvals`), which take that fiction as
// typed input and a `SeedContext` whose ids are this layer's commerce ids.

import { DEMO_SHOP_DOMAIN } from "~/modules/demo/shopify/sentinel"
import { type SeedContext, seedContext } from "~/seed/context"
import { shiftTime } from "~/seed/factories/app-tables"
import { findOrCreateTitledThread, seedApprovalRequests } from "~/seed/factories/approvals/requests"
import { type PnlFigures, seedAccountingSnapshot } from "~/seed/factories/commerce/accounting"
import {
  type ComputedDocument,
  computeDocuments,
  FRENCH_ISSUER_TAX_REGIMES,
  type InvoicingDocumentSpec,
  type InvoicingParty,
  type InvoicingSku,
  type IssuerProfileInput,
  invoicingTotals,
  issuerProfileId,
  seedInvoicingHistory,
  seedIssuerProfile,
} from "~/seed/factories/commerce/invoicing"
import { type IncidentSpec, seedIncidents } from "~/seed/factories/commerce/monitoring"
import {
  type AttentionRuleInput,
  type ClaimSpec,
  type ShipmentSpec,
  seedShippingHistory,
} from "~/seed/factories/commerce/shipping"
import {
  type DmSpec,
  type FindingSpec,
  findingId,
  type MonitorTermSpec,
  type SyncStateSpec,
  seedSocialFeed,
  type WatchedSpec,
} from "~/seed/factories/commerce/social"
import { actorFor } from "~/seed/factories/people/actors"
import { seedCompanies } from "~/seed/factories/people/companies"
import { resolveContacts } from "~/seed/factories/people/contacts"
import { DEMO_COMPANY, type DemoSku } from "~/seed/world/fiction"
import {
  DEMO_CONTENT_CATEGORY,
  demoBoxtalSender,
  demoProductId,
  demoShippingProfiles,
} from "./boxtal-catalog"
import { commerceDemoId } from "./commerce-ids"
import type { SeedDemoOrgResult } from "./seed-org"

/**
 * The commerce layer's context: its rows keep the commerce ids
 * (`commerce-ids.ts`), which another layer (the support layer's approvals)
 * names commerce rows by before this layer runs.
 */
function commerceContext(orgId: string, now: Date): SeedContext {
  return seedContext({ orgId, now, idScheme: commerceDemoId })
}

// ── The people and companies money moves between ─────────────────────────────

/** Where a counterparty's address line puts them. One city per country used. */
const CITY_BY_COUNTRY: Record<string, string> = {
  AT: "Graz",
  BE: "Ghent",
  BG: "Plovdiv",
  BR: "Porto Alegre",
  CA: "Halifax",
  DE: "Leipzig",
  DK: "Aarhus",
  FR: "Nantes",
  GB: "Bristol",
  IE: "Galway",
  JP: "Yokohama",
  NL: "Utrecht",
  NO: "Bergen",
  PL: "Gdansk",
  PT: "Braga",
  SE: "Uppsala",
  US: "Portland, OR",
}

function cityFor(country: string): string {
  return CITY_BY_COUNTRY[country.toUpperCase()] ?? "Unknown"
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export type PartyKind = "dealer" | "customer" | "supplier"

export interface DemoParty extends InvoicingParty {
  kind: PartyKind
}

/**
 * The three suppliers the purchase orders are raised against. They live here
 * rather than in `world.ts` because nothing outside this file buys anything:
 * the world bible describes who the company SELLS to. Every address is on a
 * reserved `.example` domain and every VAT body is all zeroes, the same rules
 * the rest of the demo world follows.
 */
const DEMO_SUPPLIERS: { key: string; name: string; country: string; vat: string | null }[] = [
  { key: "sup-chassis", name: "Atelier Mecanique Duval SARL", country: "FR", vat: "FR00000000000" },
  { key: "sup-boards", name: "Nordkrets Assembly AB", country: "SE", vat: "SE000000000000" },
  { key: "sup-cartons", name: "Cartonnerie du Rhone SAS", country: "FR", vat: "FR00000000000" },
]

function buildParties(world: SeedDemoOrgResult["world"]): DemoParty[] {
  const out: DemoParty[] = []
  for (const d of world.dealers) {
    out.push({
      key: `dealer-${d.key}`,
      name: d.name,
      email: `sales@${slug(d.name)}.example`,
      country: d.country,
      vatId: d.vat ?? null,
      address: `${d.name}\n${cityFor(d.country)}\n${d.country}`,
      kind: "dealer",
    })
  }
  for (const c of world.customers) {
    out.push({
      key: `customer-${c.key}`,
      name: c.name,
      email: c.email,
      country: c.country,
      vatId: null,
      address: `${c.name}\n${cityFor(c.country)}\n${c.country}`,
      kind: "customer",
    })
  }
  for (const s of DEMO_SUPPLIERS) {
    out.push({
      key: s.key,
      name: s.name,
      email: `orders@${slug(s.name)}.example`,
      country: s.country,
      vatId: s.vat,
      address: `${s.name}\n${cityFor(s.country)}\n${s.country}`,
      kind: "supplier",
    })
  }
  return out
}

// ── The document set ─────────────────────────────────────────────────────────

/**
 * The trading history a visitor scrolls. Fixed offsets from `baseTime`, so the
 * same story is always the same number of days old. The spread is deliberate:
 * every document type, every status the list filters on, both dealers and end
 * customers, and all four French VAT treatments (domestic, intra EU reverse
 * charge on a dealer VAT number, intra EU B2C, and export outside the EU).
 */
const DOCUMENTS: InvoicingDocumentSpec[] = [
  // — Dealer invoices —
  {
    key: "inv-dealer-de-spring",
    type: "invoice",
    status: "paid",
    paymentStatus: "paid",
    party: "dealer-eu-de",
    lines: [
      { sku: "RAL-FLAG-01", quantity: 6 },
      { sku: "RAL-ACC-CASE", quantity: 6 },
      {
        description: "Pallet freight, Paris to Leipzig",
        unitPriceMinor: 18_000,
        quantity: 1,
        lineKind: "shipping",
      },
    ],
    issuedDaysAgo: 96,
    termsDays: 30,
    paidDaysAgo: 72,
    poNumber: "KW-2026-0418",
  },
  {
    key: "inv-dealer-fr-lyo-q3",
    type: "invoice",
    status: "paid",
    paymentStatus: "paid",
    party: "dealer-fr-lyo",
    lines: [
      { sku: "RAL-FLAG-03", quantity: 4 },
      { sku: "RAL-ACC-STAND", quantity: 4 },
    ],
    issuedDaysAgo: 68,
    termsDays: 30,
    paidDaysAgo: 51,
  },
  {
    key: "inv-dealer-nl-restock",
    type: "invoice",
    status: "issued",
    paymentStatus: "unpaid",
    party: "dealer-nl-ams",
    lines: [
      { sku: "RAL-FLAG-01", quantity: 4 },
      { sku: "RAL-ACC-PSU", quantity: 8 },
    ],
    issuedDaysAgo: 18,
    termsDays: 30,
  },
  {
    key: "inv-dealer-uk-autumn",
    type: "invoice",
    status: "issued",
    paymentStatus: "unpaid",
    party: "dealer-uk-ldn",
    lines: [
      { sku: "RAL-FLAG-02", quantity: 3 },
      { sku: "RAL-ACC-CASE", quantity: 3 },
    ],
    issuedDaysAgo: 64,
    termsDays: 30,
    notes: "Second reminder sent. Dealer confirmed payment run for the end of the month.",
  },
  {
    key: "inv-dealer-us-launch",
    type: "invoice",
    status: "issued",
    paymentStatus: "unpaid",
    party: "dealer-us-ca",
    lines: [
      { sku: "RAL-FLAG-01", quantity: 8 },
      { sku: "RAL-ACC-USB", quantity: 8 },
    ],
    issuedDaysAgo: 91,
    termsDays: 30,
    incoterm: "DDP",
    notes: "Oldest open dealer balance. Escalate before the next shipment leaves.",
  },
  {
    key: "inv-dealer-jp-first",
    type: "invoice",
    status: "issued",
    paymentStatus: "partial",
    party: "dealer-jp-tky",
    lines: [{ sku: "RAL-FLAG-03", quantity: 6 }],
    issuedDaysAgo: 40,
    termsDays: 30,
    notes: "Half settled on order, balance due on delivery.",
  },
  {
    key: "inv-dealer-de-autumn",
    type: "invoice",
    status: "issued",
    paymentStatus: "unpaid",
    party: "dealer-eu-de",
    lines: [{ sku: "RAL-FLAG-04", quantity: 10 }],
    issuedDaysAgo: 27,
    termsDays: 30,
  },
  {
    key: "inv-dealer-nl-accessories",
    type: "invoice",
    status: "paid",
    paymentStatus: "paid",
    party: "dealer-nl-ams",
    lines: [
      { sku: "RAL-ACC-WIND", quantity: 20 },
      { sku: "RAL-ACC-CABLE", quantity: 20 },
    ],
    issuedDaysAgo: 34,
    termsDays: 30,
    paidDaysAgo: 20,
  },
  {
    key: "cn-dealer-de-return",
    type: "credit_note",
    status: "issued",
    paymentStatus: "refunded",
    party: "dealer-eu-de",
    lines: [{ sku: "RAL-FLAG-01", quantity: 1 }],
    issuedDaysAgo: 60,
    termsDays: null,
    notes: "One recorder returned with a faulty preamp board, credited in full.",
  },

  // — Dealer quotes and proformas —
  {
    key: "quo-dealer-uk-2026",
    type: "quote",
    status: "sent",
    paymentStatus: "unpaid",
    party: "dealer-uk-ldn",
    lines: [
      { sku: "RAL-FLAG-01", quantity: 10 },
      { sku: "RAL-FLAG-02", quantity: 4 },
    ],
    issuedDaysAgo: 9,
    termsDays: null,
  },
  {
    key: "quo-dealer-jp-volume",
    type: "quote",
    status: "accepted",
    paymentStatus: "unpaid",
    party: "dealer-jp-tky",
    lines: [{ sku: "RAL-FLAG-03", quantity: 12 }],
    issuedDaysAgo: 21,
    termsDays: null,
  },
  {
    key: "quo-dealer-fr-edu",
    type: "quote",
    status: "expired",
    paymentStatus: "unpaid",
    party: "dealer-fr-lyo",
    lines: [
      { sku: "RAL-FLAG-01", quantity: 6 },
      { sku: "RAL-ACC-STAND", quantity: 6 },
    ],
    issuedDaysAgo: 78,
    termsDays: null,
    notes: "Education tender, closed without an order.",
  },
  {
    key: "pro-dealer-us-customs",
    type: "proforma",
    status: "issued",
    paymentStatus: "unpaid",
    party: "dealer-us-ca",
    lines: [
      { sku: "RAL-FLAG-01", quantity: 8 },
      { sku: "RAL-ACC-USB", quantity: 8 },
    ],
    issuedDaysAgo: 90,
    termsDays: null,
    incoterm: "DDP",
  },

  // — Purchase orders (the company as the buyer) —
  {
    key: "po-chassis-batch",
    type: "purchase_order",
    status: "issued",
    paymentStatus: "unpaid",
    party: "sup-chassis",
    lines: [
      {
        description: "Machined aluminium chassis, flagship recorder",
        unitPriceMinor: 4_200,
        quantity: 250,
      },
      { description: "Anodising, matte black", unitPriceMinor: 900, quantity: 250 },
    ],
    issuedDaysAgo: 30,
    termsDays: 45,
    incoterm: "EXW",
  },
  {
    key: "po-boards-batch",
    type: "purchase_order",
    status: "received",
    paymentStatus: "paid",
    party: "sup-boards",
    lines: [
      { description: "Sensor board assembly, batch 14", unitPriceMinor: 9_800, quantity: 300 },
    ],
    issuedDaysAgo: 58,
    termsDays: 45,
    paidDaysAgo: 21,
  },
  {
    key: "po-cartons",
    type: "purchase_order",
    status: "issued",
    paymentStatus: "unpaid",
    party: "sup-cartons",
    lines: [
      { description: "Double wall carton, 46 x 34 x 16 cm", unitPriceMinor: 180, quantity: 1_200 },
      { description: "Printed sleeve, flagship", unitPriceMinor: 95, quantity: 1_200 },
    ],
    issuedDaysAgo: 12,
    termsDays: 30,
  },

  // — End customer invoices —
  {
    key: "inv-cust-claudine",
    type: "invoice",
    status: "paid",
    paymentStatus: "paid",
    party: "customer-claudine-moreau",
    lines: [
      { sku: "RAL-FLAG-01", quantity: 1 },
      { sku: "RAL-ACC-CASE", quantity: 1 },
    ],
    issuedDaysAgo: 23,
    termsDays: 14,
    paidDaysAgo: 23,
  },
  {
    key: "inv-cust-jasper",
    type: "invoice",
    status: "paid",
    paymentStatus: "paid",
    party: "customer-jasper-nilsson",
    lines: [{ sku: "RAL-FLAG-01", quantity: 1 }],
    issuedDaysAgo: 44,
    termsDays: 14,
    paidDaysAgo: 43,
  },
  {
    key: "inv-cust-helena",
    type: "invoice",
    status: "issued",
    paymentStatus: "unpaid",
    party: "customer-helena-ritter",
    lines: [
      { sku: "RAL-FLAG-02", quantity: 1 },
      { sku: "RAL-ACC-STAND", quantity: 1 },
    ],
    issuedDaysAgo: 5,
    termsDays: 14,
  },
  {
    key: "inv-cust-tomoko",
    type: "invoice",
    status: "paid",
    paymentStatus: "paid",
    party: "customer-tomoko-arai",
    lines: [
      { sku: "RAL-FLAG-03", quantity: 1 },
      { sku: "RAL-ACC-PSU", quantity: 1 },
    ],
    issuedDaysAgo: 31,
    termsDays: 14,
    paidDaysAgo: 30,
  },
  {
    key: "inv-cust-daniel",
    type: "invoice",
    status: "issued",
    paymentStatus: "unpaid",
    party: "customer-daniel-okafor",
    lines: [{ sku: "RAL-FLAG-04", quantity: 1 }],
    issuedDaysAgo: 47,
    termsDays: 14,
    notes: "Bank transfer promised, not yet received.",
  },
  {
    key: "inv-cust-pierre",
    type: "invoice",
    status: "paid",
    paymentStatus: "paid",
    party: "customer-pierre-caron",
    lines: [
      { sku: "RAL-ACC-WIND", quantity: 2 },
      { sku: "RAL-ACC-CABLE", quantity: 1 },
    ],
    issuedDaysAgo: 12,
    termsDays: 14,
    paidDaysAgo: 12,
  },
  {
    key: "inv-cust-marta",
    type: "invoice",
    status: "issued",
    paymentStatus: "unpaid",
    party: "customer-marta-nowak",
    lines: [{ sku: "RAL-FLAG-03", quantity: 1 }],
    issuedDaysAgo: 8,
    termsDays: 14,
  },
  {
    key: "inv-cust-grace",
    type: "invoice",
    status: "paid",
    paymentStatus: "paid",
    party: "customer-grace-whitfield",
    lines: [
      { sku: "RAL-FLAG-01", quantity: 1 },
      { sku: "RAL-ACC-USB", quantity: 1 },
    ],
    issuedDaysAgo: 16,
    termsDays: 14,
    paidDaysAgo: 15,
  },
  {
    key: "inv-cust-andre",
    type: "invoice",
    status: "issued",
    paymentStatus: "partial",
    party: "customer-andre-silva",
    lines: [{ sku: "RAL-FLAG-02", quantity: 1 }],
    issuedDaysAgo: 26,
    termsDays: 14,
    notes: "Deposit received, balance outstanding.",
  },
  {
    key: "inv-cust-nora",
    type: "invoice",
    status: "paid",
    paymentStatus: "paid",
    party: "customer-nora-haugen",
    lines: [{ sku: "RAL-FLAG-03", quantity: 1 }],
    issuedDaysAgo: 53,
    termsDays: 14,
    paidDaysAgo: 52,
  },
  {
    key: "inv-cust-felix",
    type: "invoice",
    status: "paid",
    paymentStatus: "paid",
    party: "customer-felix-berger",
    lines: [
      { sku: "RAL-ACC-CARE", quantity: 1, lineKind: "software" },
      { sku: "RAL-ACC-STAND", quantity: 1 },
    ],
    issuedDaysAgo: 7,
    termsDays: 14,
    paidDaysAgo: 6,
  },
  {
    key: "inv-cust-hiroshi",
    type: "invoice",
    status: "issued",
    paymentStatus: "unpaid",
    party: "customer-hiroshi-kubo",
    lines: [
      { sku: "RAL-FLAG-01", quantity: 1 },
      { sku: "RAL-ACC-CASE", quantity: 1 },
    ],
    issuedDaysAgo: 3,
    termsDays: 14,
  },
  {
    key: "inv-cust-lena",
    type: "invoice",
    status: "paid",
    paymentStatus: "paid",
    party: "customer-lena-vos",
    lines: [{ sku: "RAL-FLAG-04", quantity: 1 }],
    issuedDaysAgo: 19,
    termsDays: 14,
    paidDaysAgo: 18,
  },
  {
    key: "inv-cust-owen",
    type: "invoice",
    status: "paid",
    paymentStatus: "paid",
    party: "customer-owen-brady",
    lines: [
      { sku: "RAL-FLAG-03", quantity: 1 },
      { sku: "RAL-ACC-PSU", quantity: 1 },
    ],
    issuedDaysAgo: 38,
    termsDays: 14,
    paidDaysAgo: 37,
  },
  {
    key: "cn-cust-owen",
    type: "credit_note",
    status: "issued",
    paymentStatus: "refunded",
    party: "customer-owen-brady",
    lines: [{ sku: "RAL-FLAG-03", quantity: 1 }],
    issuedDaysAgo: 14,
    termsDays: null,
    notes: "Returned within the cooling off period, recorder credited, power supply kept.",
  },

  // — End customer quotes, proformas and drafts —
  {
    key: "quo-cust-clara",
    type: "quote",
    status: "sent",
    paymentStatus: "unpaid",
    party: "customer-clara-mendes",
    lines: [
      { sku: "RAL-FLAG-02", quantity: 1 },
      { sku: "RAL-ACC-CASE", quantity: 1 },
    ],
    issuedDaysAgo: 4,
    termsDays: null,
  },
  {
    key: "quo-cust-aisha",
    type: "quote",
    status: "accepted",
    paymentStatus: "unpaid",
    party: "customer-aisha-khan",
    lines: [{ sku: "RAL-FLAG-01", quantity: 1 }],
    issuedDaysAgo: 11,
    termsDays: null,
  },
  {
    key: "quo-cust-sara",
    type: "quote",
    status: "expired",
    paymentStatus: "unpaid",
    party: "customer-sara-lindqvist",
    lines: [{ sku: "RAL-FLAG-04", quantity: 1 }],
    issuedDaysAgo: 84,
    termsDays: null,
  },
  {
    key: "pro-cust-ivan",
    type: "proforma",
    status: "issued",
    paymentStatus: "unpaid",
    party: "customer-ivan-petrov",
    lines: [{ sku: "RAL-FLAG-01", quantity: 1 }],
    issuedDaysAgo: 6,
    termsDays: null,
  },
  {
    key: "draft-cust-victor",
    type: "invoice",
    status: "draft",
    paymentStatus: "unpaid",
    party: "customer-victor-hansen",
    lines: [{ sku: "RAL-FLAG-03", quantity: 1 }],
    issuedDaysAgo: null,
  },
  {
    key: "draft-dealer-uk-topup",
    type: "invoice",
    status: "draft",
    paymentStatus: "unpaid",
    party: "dealer-uk-ldn",
    lines: [{ sku: "RAL-FLAG-01", quantity: 2 }],
    issuedDaysAgo: null,
  },
]

/** Customs data for a goods line on a document that needs an HS code. */
const HS_CODE_BY_TIER: Record<DemoSku["tier"], string> = {
  flagship: "8543.70",
  accessory: "8473.30",
}

// ── Boxtal shipments ─────────────────────────────────────────────────────────

const SHIPMENTS: ShipmentSpec[] = [
  {
    key: "ship-nl-restock",
    document: "inv-dealer-nl-restock",
    kind: "outbound",
    linkState: "create_in_flight",
    orderStatus: null,
    trackingStatus: null,
    offerCode: null,
    trackingNumber: null,
    hasLabel: false,
    createdDaysAgo: 0,
    labelCostTtc: null,
    createdBy: "user",
    parcels: [{ weight: 12.8, length: 62, width: 44, height: 20 }],
    products: "4xLMC, 8xPSU",
    items: 12,
    category: "sale",
    staffNote: "Waiting on the dealer to confirm the delivery window.",
  },
  {
    key: "ship-cust-hiroshi",
    document: "inv-cust-hiroshi",
    kind: "outbound",
    linkState: "created",
    orderStatus: "CONFIRMED",
    trackingStatus: null,
    offerCode: "CHRP-International",
    trackingNumber: null,
    hasLabel: true,
    createdDaysAgo: 2,
    labelCostTtc: 48.9,
    createdBy: "user",
    parcels: [{ weight: 4.1, length: 62, width: 44, height: 20 }],
    products: "1xLMC, 1xCASE",
    items: 2,
    category: "sale",
  },
  {
    key: "ship-cust-helena",
    document: "inv-cust-helena",
    kind: "outbound",
    linkState: "created",
    orderStatus: "PENDING",
    trackingStatus: "ANNOUNCED",
    offerCode: "DHLE-Europlus",
    trackingNumber: "DEMO000000411",
    hasLabel: true,
    createdDaysAgo: 4,
    labelCostTtc: 21.4,
    createdBy: "agent",
    parcels: [{ weight: 5.3, length: 96, width: 50, height: 22 }],
    products: "1xLXL, 1xSTAND",
    items: 2,
    category: "sale",
  },
  {
    key: "ship-cust-marta",
    document: "inv-cust-marta",
    kind: "outbound",
    linkState: "created",
    orderStatus: "REQUESTED",
    trackingStatus: null,
    offerCode: "UPSE-Standard",
    trackingNumber: null,
    hasLabel: true,
    createdDaysAgo: 6,
    labelCostTtc: 16.2,
    createdBy: "user",
    parcels: [{ weight: 1.9, length: 46, width: 34, height: 16 }],
    products: "1xLMI",
    items: 1,
    category: "sale",
  },
  {
    key: "ship-dealer-de-autumn",
    document: "inv-dealer-de-autumn",
    kind: "outbound",
    linkState: "created",
    orderStatus: "CONFIRMED",
    trackingStatus: "IN_TRANSIT",
    offerCode: "DHLE-Europlus",
    trackingNumber: "DEMO000000318",
    hasLabel: true,
    createdDaysAgo: 24,
    labelCostTtc: 74.5,
    createdBy: "user",
    parcels: [
      { weight: 9.4, length: 62, width: 44, height: 20 },
      { weight: 9.4, length: 62, width: 44, height: 20 },
    ],
    products: "10xPSP",
    items: 10,
    category: "sale",
  },
  {
    key: "ship-cust-claudine",
    document: "inv-cust-claudine",
    kind: "outbound",
    linkState: "created",
    orderStatus: "CONFIRMED",
    trackingStatus: "OUT_FOR_DELIVERY",
    offerCode: "COPR-Access",
    trackingNumber: "DEMO000000265",
    hasLabel: true,
    createdDaysAgo: 22,
    labelCostTtc: 9.8,
    createdBy: "user",
    parcels: [{ weight: 4.0, length: 62, width: 44, height: 20 }],
    products: "1xLMC, 1xCASE",
    items: 2,
    category: "sale",
  },
  {
    key: "ship-cust-grace",
    document: "inv-cust-grace",
    kind: "outbound",
    linkState: "created",
    orderStatus: "CONFIRMED",
    trackingStatus: "DELIVERED",
    offerCode: "FEDX-InternationalEconomy",
    trackingNumber: "DEMO000000202",
    hasLabel: true,
    createdDaysAgo: 15,
    labelCostTtc: 61.3,
    createdBy: "user",
    parcels: [{ weight: 3.1, length: 46, width: 34, height: 16 }],
    products: "1xLMC, 1xUSB",
    items: 2,
    category: "sale",
  },
  {
    key: "ship-cust-lena",
    document: "inv-cust-lena",
    kind: "outbound",
    linkState: "created",
    orderStatus: "CONFIRMED",
    trackingStatus: "DELIVERED",
    offerCode: "DHLE-Europlus",
    trackingNumber: "DEMO000000188",
    hasLabel: true,
    createdDaysAgo: 18,
    labelCostTtc: 14.7,
    createdBy: "agent",
    parcels: [{ weight: 2.3, length: 46, width: 34, height: 16 }],
    products: "1xPSP",
    items: 1,
    category: "sale",
  },
  {
    key: "ship-cust-daniel",
    document: "inv-cust-daniel",
    kind: "outbound",
    linkState: "created",
    orderStatus: "CONFIRMED",
    trackingStatus: "EXCEPTION",
    offerCode: "UPSE-Express",
    trackingNumber: "DEMO000000147",
    hasLabel: true,
    createdDaysAgo: 46,
    labelCostTtc: 33.6,
    createdBy: "user",
    parcels: [{ weight: 2.4, length: 46, width: 34, height: 16 }],
    products: "1xPSP",
    items: 1,
    category: "sale",
    staffNote: "Held at customs, missing a commercial invoice copy.",
  },
  {
    key: "ship-cust-andre",
    document: "inv-cust-andre",
    kind: "outbound",
    linkState: "created",
    orderStatus: "CONFIRMED",
    trackingStatus: "FAILED_ATTEMPT",
    offerCode: "CHRP-Domicile",
    trackingNumber: "DEMO000000139",
    hasLabel: true,
    createdDaysAgo: 25,
    labelCostTtc: 18.2,
    createdBy: "user",
    parcels: [{ weight: 4.6, length: 96, width: 50, height: 22 }],
    products: "1xLXL",
    items: 1,
    category: "sale",
    staffNote: "Nobody at the address twice, customer asked for a pickup point.",
  },
  {
    key: "ship-cust-nora",
    document: "inv-cust-nora",
    kind: "outbound",
    linkState: "created",
    orderStatus: "CANCELLED",
    trackingStatus: null,
    offerCode: "UPSE-Standard",
    trackingNumber: null,
    hasLabel: false,
    createdDaysAgo: 54,
    labelCostTtc: null,
    createdBy: "user",
    parcels: [{ weight: 1.9, length: 46, width: 34, height: 16 }],
    products: "1xLMI",
    items: 1,
    category: "sale",
    staffNote: "Bought against the wrong address, cancelled and rebought.",
  },
  {
    key: "ship-return-owen",
    document: "cn-cust-owen",
    kind: "return",
    linkState: "created",
    orderStatus: "CONFIRMED",
    trackingStatus: "IN_TRANSIT",
    offerCode: "COPR-Retour",
    trackingNumber: "DEMO000000121",
    hasLabel: true,
    createdDaysAgo: 13,
    labelCostTtc: 11.4,
    returnReason: "Returned within the cooling off period",
    createdBy: "agent",
    parcels: [{ weight: 1.9, length: 46, width: 34, height: 16 }],
    products: "1xLMI",
    items: 1,
    category: "return",
  },
  {
    key: "ship-return-de",
    document: "cn-dealer-de-return",
    kind: "return",
    linkState: "created",
    orderStatus: "PENDING",
    trackingStatus: null,
    offerCode: "DHLE-Retour",
    trackingNumber: null,
    hasLabel: true,
    createdDaysAgo: 59,
    labelCostTtc: 13.9,
    returnReason: "Faulty sensor board, returned for credit",
    createdBy: "user",
    parcels: [{ weight: 3.6, length: 62, width: 44, height: 20 }],
    products: "1xLMC",
    items: 1,
    category: "return",
  },
  {
    key: "ship-dealer-uk-autumn",
    document: "inv-dealer-uk-autumn",
    kind: "outbound",
    linkState: "created",
    orderStatus: "CONFIRMED",
    trackingStatus: "RETURNED",
    offerCode: "UPSE-Express",
    trackingNumber: "DEMO000000103",
    hasLabel: true,
    createdDaysAgo: 62,
    labelCostTtc: 96.4,
    createdBy: "user",
    parcels: [{ weight: 14.7, length: 96, width: 50, height: 22 }],
    products: "3xLXL, 3xCASE",
    items: 6,
    category: "sale",
    staffNote: "Refused at the border, came back to the workshop.",
  },
]

/** The carton ladder the packing bench works from. */
const PACKS: {
  key: string
  name: string
  length: number
  width: number
  height: number
  grossWeight: number
  cartonTare: number
  components: { sku: string; quantity: number }[]
}[] = [
  {
    key: "pack-s",
    name: "Carton S, accessories",
    length: 34,
    width: 26,
    height: 10,
    grossWeight: 1.2,
    cartonTare: 0.25,
    components: [
      { sku: "RAL-ACC-CABLE", quantity: 1 },
      { sku: "RAL-ACC-USB", quantity: 1 },
    ],
  },
  {
    key: "pack-m",
    name: "Carton M, pocket recorder",
    length: 46,
    width: 34,
    height: 16,
    grossWeight: 1.9,
    cartonTare: 0.45,
    components: [{ sku: "RAL-FLAG-03", quantity: 1 }],
  },
  {
    key: "pack-l",
    name: "Carton L, flagship recorder",
    length: 62,
    width: 44,
    height: 20,
    grossWeight: 3.2,
    cartonTare: 0.7,
    components: [
      { sku: "RAL-FLAG-01", quantity: 1 },
      { sku: "RAL-ACC-PSU", quantity: 1 },
    ],
  },
  {
    key: "pack-xl",
    name: "Carton XL, ten input recorder",
    length: 96,
    width: 50,
    height: 22,
    grossWeight: 4.6,
    cartonTare: 1.1,
    components: [{ sku: "RAL-FLAG-02", quantity: 1 }],
  },
]

/** A short code per SKU, the way the packing bench writes it on a worklist. */
const SHORT_CODES: Record<string, string> = {
  "RAL-FLAG-01": "K6",
  "RAL-FLAG-02": "K10",
  "RAL-FLAG-03": "KPO",
  "RAL-FLAG-04": "KPRE",
  "RAL-ACC-CASE": "CASE",
  "RAL-ACC-CABLE": "CBL",
  "RAL-ACC-STAND": "STAND",
  "RAL-ACC-PSU": "PSU",
  "RAL-ACC-USB": "USB",
  "RAL-ACC-WIND": "WIND",
  "RAL-ACC-CARE": "CARE",
}

// ── Social findings ──────────────────────────────────────────────────────────

const FINDINGS: FindingSpec[] = [
  {
    key: "f-ig-first-hour",
    platform: "instagram",
    relation: "mention_in_post",
    authorHandle: "@loopsmith",
    content:
      "First hour with the Kestrel 6 and I have already recut half the day's rushes. The preamps are unbelievably quiet.",
    hoursAgo: 3,
    status: "new",
    triageCategory: null,
    sentiment: null,
    urgency: null,
    shouldReply: null,
    needsHuman: null,
    brandRelevant: true,
    commentCount: 14,
  },
  {
    key: "f-yt-review",
    platform: "youtube",
    relation: "comment_on_our_content",
    authorHandle: "@modularmornings",
    content:
      "Great walkthrough. Does the Pocket write the same 32 bit float files as the full size recorder, or is it a reduced set?",
    hoursAgo: 6,
    status: "new",
    triageCategory: null,
    sentiment: null,
    urgency: null,
    shouldReply: null,
    needsHuman: null,
    brandRelevant: true,
    commentCount: 2,
    watched: "w-yt-walkthrough",
  },
  {
    key: "f-fb-shipping",
    platform: "facebook",
    relation: "comment_on_our_content",
    authorHandle: "Marek Zielinski",
    content:
      "Ordered ten days ago and the tracking has not moved since it left Paris. Is anyone actually watching these?",
    hoursAgo: 9,
    status: "triaged",
    triageCategory: "shipping",
    sentiment: "negative",
    urgency: 78,
    shouldReply: true,
    needsHuman: true,
    brandRelevant: true,
    commentCount: 5,
  },
  {
    key: "f-ig-windshield",
    platform: "instagram",
    relation: "mention_in_comment",
    authorHandle: "@grainfield",
    content:
      "The windshield pack changes everything. Fur windjammer on the boom, foam on the plant mics, one kit.",
    hoursAgo: 14,
    status: "triaged",
    triageCategory: "praise",
    sentiment: "positive",
    urgency: 20,
    shouldReply: true,
    needsHuman: false,
    brandRelevant: true,
  },
  {
    key: "f-yt-firmware",
    platform: "youtube",
    relation: "comment_on_our_content",
    authorHandle: "@patchcablechaos",
    content:
      "After the last firmware my preamp stopped being detected over the control bus. Rolling back fixed it. Anyone else seeing this?",
    hoursAgo: 20,
    status: "drafted",
    triageCategory: "support",
    sentiment: "negative",
    urgency: 71,
    shouldReply: true,
    needsHuman: true,
    suggestedReply:
      "Thanks for flagging this. Could you tell us which firmware version you rolled back from, and which preamp you are using? We will reproduce it here and get back to you.",
    brandRelevant: true,
    watched: "w-yt-walkthrough",
  },
  {
    key: "f-fb-dealer-ask",
    platform: "facebook",
    relation: "keyword_match",
    authorHandle: "Studio Kleinhaus",
    content:
      "Looking for a European dealer for the Kestrel range. We run a small studio shop and our customers keep asking.",
    hoursAgo: 26,
    status: "new",
    pendingReply: true,
    triageCategory: "sales",
    sentiment: "positive",
    urgency: 55,
    shouldReply: true,
    needsHuman: true,
    suggestedReply:
      "Thank you for the interest. Our partnerships lead will get in touch this week with the dealer terms and the current lead times.",
    brandRelevant: true,
  },
  {
    key: "f-ig-case-question",
    platform: "instagram",
    relation: "mention",
    authorHandle: "@tourbusaudio",
    content:
      "Does the travel case take the recorder with the tripod mount attached, or does the mount travel separately?",
    hoursAgo: 31,
    status: "new",
    pendingReply: true,
    triageCategory: "support",
    sentiment: "neutral",
    urgency: 34,
    shouldReply: true,
    needsHuman: false,
    suggestedReply:
      "The case is cut for the recorder and its cable set. The tripod mount folds flat and travels in the outer pocket.",
    brandRelevant: true,
  },
  {
    key: "f-yt-comparison",
    platform: "youtube",
    relation: "keyword_match",
    authorHandle: "@synthscrolls",
    content:
      "Comparison video is up: three location recorders, and the Kestrel wins on preamp noise by a clear margin.",
    hoursAgo: 38,
    status: "handled",
    triageCategory: "praise",
    sentiment: "positive",
    urgency: 15,
    shouldReply: false,
    needsHuman: false,
    brandRelevant: true,
    commentCount: 41,
    watched: "w-yt-comparison",
  },
  {
    key: "f-fb-preset-share",
    platform: "facebook",
    relation: "mention_in_post",
    authorHandle: "Ines Duarte",
    content:
      "Sharing my ambient recording setup for the Kestrel. Six input presets, all gain staged, free to use.",
    hoursAgo: 45,
    status: "handled",
    triageCategory: "community",
    sentiment: "positive",
    urgency: 22,
    shouldReply: true,
    needsHuman: false,
    brandRelevant: true,
    commentCount: 9,
  },
  {
    key: "f-ig-unboxing",
    platform: "instagram",
    relation: "tagged",
    authorHandle: "@northlightstudio",
    content:
      "Unboxing the ten input recorder. The build quality is closer to a broadcast desk than a field unit.",
    hoursAgo: 52,
    status: "handled",
    triageCategory: "praise",
    sentiment: "positive",
    urgency: 18,
    shouldReply: true,
    needsHuman: false,
    brandRelevant: true,
    watched: "w-ig-unboxing",
  },
  {
    key: "f-yt-spam",
    platform: "youtube",
    relation: "comment_on_our_content",
    authorHandle: "@cheapgearnow",
    content: "Best prices on every recorder, check my profile link.",
    hoursAgo: 58,
    status: "dismissed",
    triageCategory: "spam",
    sentiment: "neutral",
    urgency: 5,
    shouldReply: false,
    needsHuman: false,
    brandRelevant: false,
    watched: "w-yt-walkthrough",
  },
  {
    key: "f-fb-offtopic",
    platform: "facebook",
    relation: "keyword_match",
    authorHandle: "Kestrel Roofing Supplies",
    content: "Our new ridge vents and roof flashing are in stock now.",
    hoursAgo: 63,
    status: "dismissed",
    triageCategory: "off_topic",
    sentiment: "neutral",
    urgency: 2,
    shouldReply: false,
    needsHuman: false,
    brandRelevant: false,
  },
  {
    key: "f-ig-teacher",
    platform: "instagram",
    relation: "mention",
    authorHandle: "@filmschool.sound",
    content:
      "Using two Kestrel recorders in our location sound class this term. The students took about ten minutes to get it.",
    hoursAgo: 70,
    status: "handled",
    triageCategory: "community",
    sentiment: "positive",
    urgency: 30,
    shouldReply: true,
    needsHuman: false,
    brandRelevant: true,
  },
  {
    key: "f-yt-preamp",
    platform: "youtube",
    relation: "reply",
    authorHandle: "@boompoleblues",
    content:
      "The Kestrel preamp linked in seconds. Four more channels on the same timecode, no second clock to babysit.",
    hoursAgo: 77,
    status: "handled",
    triageCategory: "praise",
    sentiment: "positive",
    urgency: 12,
    shouldReply: false,
    needsHuman: false,
    brandRelevant: true,
    watched: "w-yt-comparison",
  },
  {
    key: "f-fb-warranty",
    platform: "facebook",
    relation: "mention_in_comment",
    authorHandle: "Petra Halloran",
    content: "Is the extended care plan worth it? Two years is a long time to think about.",
    hoursAgo: 84,
    status: "triaged",
    triageCategory: "sales",
    sentiment: "neutral",
    urgency: 28,
    shouldReply: true,
    needsHuman: false,
    brandRelevant: true,
  },
  {
    key: "f-ig-repair",
    platform: "instagram",
    relation: "mention",
    authorHandle: "@bassmentworks",
    content:
      "Sent a recorder in for repair and it came back in four days with a note explaining what was replaced. That is rare.",
    hoursAgo: 92,
    status: "handled",
    triageCategory: "praise",
    sentiment: "positive",
    urgency: 10,
    shouldReply: true,
    needsHuman: false,
    brandRelevant: true,
  },
  {
    key: "f-yt-latency",
    platform: "youtube",
    relation: "comment_on_our_content",
    authorHandle: "@dawdoctor",
    content: "Any plan for a class compliant mode so it works on tablets without a driver?",
    hoursAgo: 101,
    status: "triaged",
    triageCategory: "product_feedback",
    sentiment: "neutral",
    urgency: 40,
    shouldReply: true,
    needsHuman: true,
    brandRelevant: true,
  },
  {
    key: "f-fb-stock",
    platform: "facebook",
    relation: "keyword_match",
    authorHandle: "Ola Berg",
    content: "Every shop near me is out of the Pocket. Is a restock coming before the holidays?",
    hoursAgo: 110,
    status: "handled",
    triageCategory: "sales",
    sentiment: "neutral",
    urgency: 45,
    shouldReply: true,
    needsHuman: false,
    brandRelevant: true,
  },
  {
    key: "f-ig-colour",
    platform: "instagram",
    relation: "mention_in_comment",
    authorHandle: "@palettepatch",
    content: "Would buy a second one immediately in a lighter finish. Any chance of a limited run?",
    hoursAgo: 118,
    status: "triaged",
    triageCategory: "product_feedback",
    sentiment: "positive",
    urgency: 25,
    shouldReply: false,
    needsHuman: false,
    brandRelevant: true,
    watched: "w-ig-unboxing",
  },
  {
    key: "f-yt-tutorial-ask",
    platform: "youtube",
    relation: "comment_on_our_content",
    authorHandle: "@slowattack",
    content:
      "Please do a deeper video on gain staging. The manual section is good but seeing it done on location would help.",
    hoursAgo: 126,
    status: "handled",
    triageCategory: "community",
    sentiment: "positive",
    urgency: 20,
    shouldReply: true,
    needsHuman: false,
    brandRelevant: true,
    watched: "w-yt-walkthrough",
  },
]

const WATCHED: WatchedSpec[] = [
  {
    key: "w-yt-walkthrough",
    platform: "youtube",
    objectType: "youtube_video",
    title: "Kestrel 6 Field Recorder: the full walkthrough",
    reason: "manual",
    status: "active",
    priority: 80,
    newFindings: 2,
    lastActivityHoursAgo: 6,
  },
  {
    key: "w-yt-comparison",
    platform: "youtube",
    objectType: "youtube_video",
    title: "Three location recorders compared",
    reason: "auto_hot",
    status: "active",
    priority: 65,
    newFindings: 0,
    lastActivityHoursAgo: 38,
  },
  {
    key: "w-ig-unboxing",
    platform: "instagram",
    objectType: "instagram_media",
    title: "Ten input recorder unboxing",
    reason: "auto_hot",
    status: "decayed",
    priority: 40,
    newFindings: 0,
    lastActivityHoursAgo: 52,
  },
]

const DMS: DmSpec[] = [
  {
    key: "dm-ig-tourbus",
    platform: "instagram",
    participantHandle: "@tourbusaudio",
    displayName: "Tour Bus Audio",
    status: "open",
    unread: 1,
    messages: [
      {
        direction: "inbound",
        body: "Hi, is the travel case sold separately or only bundled?",
        hoursAgo: 30,
      },
      {
        direction: "outbound",
        body: "Both. It is in the accessories list on its own, and it is also part of the touring bundle.",
        hoursAgo: 29,
      },
      {
        direction: "inbound",
        body: "Perfect. Does it fit the ten input recorder too?",
        hoursAgo: 2,
      },
    ],
  },
  {
    key: "dm-fb-kleinhaus",
    platform: "facebook",
    participantHandle: "studio.kleinhaus",
    displayName: "Studio Kleinhaus",
    status: "awaiting_approval",
    unread: 1,
    suggestedReply:
      "Thank you for reaching out. We will send the dealer pack with pricing tiers and current lead times today.",
    messages: [
      {
        direction: "inbound",
        body: "We would like to stock the Kestrel range. Who handles dealer accounts?",
        hoursAgo: 27,
      },
      {
        direction: "inbound",
        body: "We are a four person shop in Leipzig, mostly studio gear.",
        hoursAgo: 26,
      },
    ],
  },
  {
    key: "dm-ig-grainfield",
    platform: "instagram",
    participantHandle: "@grainfield",
    displayName: "Grainfield",
    status: "handled",
    unread: 0,
    messages: [
      {
        direction: "inbound",
        body: "Any chance of a settings export format others can read?",
        hoursAgo: 96,
      },
      {
        direction: "outbound",
        body: "The recorder setup files are plain JSON and documented in the manual, so yes, they travel.",
        hoursAgo: 95,
      },
      { direction: "inbound", body: "Brilliant, thank you.", hoursAgo: 94 },
    ],
  },
]

const MONITOR_TERMS: MonitorTermSpec[] = [
  {
    key: "mt-brand",
    kind: "keyword",
    value: "Resonant Audio Labs",
    notes: "The company name, every platform.",
  },
  {
    key: "mt-kestrel",
    kind: "keyword",
    value: "Kestrel recorder",
    notes: "The flagship product line.",
  },
  { key: "mt-preamp", kind: "keyword", value: "Kestrel preamp" },
  { key: "mt-handle-ig", kind: "handle", value: "@resonantaudiolabs", platform: "instagram" },
  { key: "mt-handle-yt", kind: "handle", value: "@resonantaudiolabs", platform: "youtube" },
  { key: "mt-hashtag", kind: "hashtag", value: "#kestrelrecorder", platform: "instagram" },
]

// ── Monitoring ───────────────────────────────────────────────────────────────
//
// The production alert board the ops desk actually works from. Monitoring has
// no external fetch at all: its dashboard, its list filters and its per source
// health rail all read `app_monitoring.incidents`, so a seeded row IS the
// board. Severity, status and source are spread wide on purpose, because the
// dashboard's summary tiles (open by severity, acknowledged, resolved in the
// trailing 24h) and every list filter are only legible when each bucket has
// something in it.
//
// Two shapes matter beyond the plain rows: a repeated alert is ONE incident
// whose `count` climbs while `first_seen_at` stays put (the flapping case the
// board is meant to expose), and an alert that re fires after a resolve
// carries `reopened_at`. Both are seeded.
//
// `dedup_key` is unique per source under a partial index, so every key here is
// distinct and the one incident that never carried a dedup key keeps it null.

const INCIDENTS: IncidentSpec[] = [
  {
    key: "mi-checkout-502",
    source: "uptime-probe",
    severity: "critical",
    status: "open",
    title: "Checkout step answering 502 from the Paris probe",
    body: "Three consecutive probes hit a 502 on the checkout step. Catalogue and cart pages answer in under 400 ms, so the failure looks confined to the payment step.",
    dedupKey: "probe.checkout.502",
    url: "https://alerts.example.com/incidents/probe-checkout-502",
    count: 3,
    firstSeenDaysAgo: 0,
    firstSeenHour: -5,
    lastSeenDaysAgo: 0,
    lastSeenHour: -1,
  },
  {
    key: "mi-firmware-cdn-latency",
    source: "cdn-edge",
    severity: "warning",
    status: "open",
    title: "Firmware download latency above one second at the edge",
    body: "The firmware bundle is served from origin on most edge misses. Median download start climbed from 180 ms to 1.4 s, which is slow enough that the updater in the app times out on a weak connection.",
    dedupKey: "cdn.firmware.latency",
    count: 12,
    firstSeenDaysAgo: 2,
    firstSeenHour: 3,
    lastSeenDaysAgo: 0,
    lastSeenHour: -3,
  },
  {
    key: "mi-wms-sync-lag",
    source: "warehouse-wms",
    severity: "warning",
    status: "open",
    title: "Stock sync from the warehouse is 40 minutes behind",
    body: "The warehouse feed is still importing, but the lag between a pick being confirmed and the shop seeing it is now 40 minutes. Oversell risk on the two lines that sit under ten units.",
    dedupKey: "wms.sync.lag",
    count: 2,
    firstSeenDaysAgo: 1,
    firstSeenHour: 9,
    lastSeenDaysAgo: 0,
    lastSeenHour: -8,
  },
  {
    key: "mi-backup-disk",
    source: "backup-runner",
    severity: "info",
    status: "open",
    title: "Backup volume at 78 percent",
    body: "Nightly snapshots still complete. At the current growth rate the volume reaches its threshold in about three weeks, so this is a plan it now item rather than a page someone tonight item.",
    dedupKey: null,
    count: 1,
    firstSeenDaysAgo: 1,
    firstSeenHour: 2,
    lastSeenDaysAgo: 1,
    lastSeenHour: 2,
  },
  {
    key: "mi-label-api-timeouts",
    source: "shipping-api",
    severity: "critical",
    status: "acknowledged",
    title: "Label creation timing out at the carrier",
    body: "Label requests are hitting the 30 s timeout in bursts. Each burst clears on its own, then returns. Fulfillment is falling back to manual label entry for the affected orders.",
    dedupKey: "shipping.label.timeout",
    url: "https://alerts.example.com/incidents/shipping-label-timeout",
    count: 37,
    firstSeenDaysAgo: 11,
    firstSeenHour: 8,
    lastSeenDaysAgo: 0,
    lastSeenHour: -2,
    acknowledgedDaysAgo: 0,
    acknowledgedHour: -1,
    acknowledgedBy: "tobias",
  },
  {
    key: "mi-mail-relay-deferred",
    source: "mail-relay",
    severity: "warning",
    status: "acknowledged",
    title: "Support replies deferred by the relay",
    body: "Outbound support mail is being deferred at the relay for one receiving domain. Nothing is bouncing, so the replies land late rather than never. Reputation dashboard is clean.",
    dedupKey: "mail.relay.deferred",
    count: 6,
    firstSeenDaysAgo: 3,
    firstSeenHour: 10,
    lastSeenDaysAgo: 0,
    lastSeenHour: -6,
    acknowledgedDaysAgo: 0,
    acknowledgedHour: -4,
    acknowledgedBy: "amina",
  },
  {
    key: "mi-firmware-build-flaky",
    source: "build-ci",
    severity: "info",
    status: "acknowledged",
    title: "Firmware build flaked twice on the same test",
    body: "The recorder test fixture failed twice in a row on the timing assertion, then passed on a rerun with no code change. Treating it as a flaky test rather than a regression until it reproduces locally.",
    dedupKey: "ci.firmware.flaky",
    count: 2,
    firstSeenDaysAgo: 4,
    firstSeenHour: 11,
    lastSeenDaysAgo: 2,
    lastSeenHour: 15,
    acknowledgedDaysAgo: 2,
    acknowledgedHour: 16,
    acknowledgedBy: "elodie",
  },
  {
    key: "mi-db-pool-saturated",
    source: "database",
    severity: "critical",
    status: "acknowledged",
    title: "Connection pool saturated during the evening peak",
    body: "The pool hit its ceiling for six minutes and queries queued behind it. Every request eventually served, but the slowest checkout took 11 s. A long running report is the prime suspect.",
    dedupKey: "db.pool.saturated",
    count: 5,
    firstSeenDaysAgo: 1,
    firstSeenHour: 8,
    lastSeenDaysAgo: 0,
    lastSeenHour: -9,
    acknowledgedDaysAgo: 0,
    acknowledgedHour: -7,
    acknowledgedBy: "tobias",
  },
  {
    key: "mi-webhook-signature",
    source: "shop-webhooks",
    severity: "warning",
    status: "resolved",
    title: "Shop webhooks rejected on a signature mismatch",
    body: "Order webhooks were rejected for 20 minutes because the receiver verified against the previous signing secret.",
    dedupKey: "webhooks.signature.mismatch",
    count: 9,
    firstSeenDaysAgo: 6,
    firstSeenHour: 13,
    lastSeenDaysAgo: 6,
    lastSeenHour: 14,
    resolvedDaysAgo: 5,
    resolvedHour: 9,
    resolvedBy: "tobias",
    resolutionNote:
      "The rotated signing secret never reached the receiver's environment. Redeployed with the current secret and replayed the 9 held deliveries, all of which verified. Added the secret to the deploy checklist so a rotation cannot land on one side only.",
  },
  {
    key: "mi-payment-capture-retries",
    source: "payment-gateway",
    severity: "critical",
    status: "resolved",
    title: "Card captures retrying and re fired after the first fix",
    body: "Captures were retried up to four times against the gateway, then stopped settling. The first fix held for a day before the same alert came back, which is why this incident was reopened rather than a new one raised.",
    dedupKey: "gateway.capture.retry",
    url: "https://alerts.example.com/incidents/gateway-capture-retry",
    count: 14,
    firstSeenDaysAgo: 10,
    firstSeenHour: 7,
    lastSeenDaysAgo: 9,
    lastSeenHour: 6,
    reopenedDaysAgo: 9,
    reopenedHour: 6,
    resolvedDaysAgo: 8,
    resolvedHour: 10,
    resolvedBy: "henrik",
    resolutionNote:
      "A stale idempotency key on the retry path made the gateway answer the second attempt from cache, so nothing ever settled. Cleared the key, replayed the four held captures, and each one settled on the first try. The key now carries the attempt number.",
  },
  {
    key: "mi-scanner-offline",
    source: "warehouse-wms",
    severity: "info",
    status: "resolved",
    title: "Handheld scanner 3 dropped off the network",
    body: "One picking handheld stopped reporting for half an hour. The other four kept working, so picking continued at reduced pace.",
    dedupKey: "wms.scanner3.offline",
    count: 1,
    firstSeenDaysAgo: 12,
    firstSeenHour: 8,
    lastSeenDaysAgo: 12,
    lastSeenHour: 8,
    resolvedDaysAgo: 12,
    resolvedHour: 11,
    resolvedBy: "margot",
    resolutionNote:
      "The handheld had fallen off the warehouse access point and could not rejoin: its lease had expired while it sat in the charging cradle. Paired it back onto the access point and extended the lease time so an overnight charge no longer knocks it off.",
  },
  {
    key: "mi-tls-expiry",
    source: "uptime-probe",
    severity: "warning",
    status: "resolved",
    title: "Certificate for the shop domain within ten days of expiry",
    body: "The probe flagged the shop certificate ten days out. Nothing was broken yet, but automatic renewal had clearly not run.",
    dedupKey: "probe.tls.expiry",
    count: 4,
    firstSeenDaysAgo: 13,
    firstSeenHour: 5,
    lastSeenDaysAgo: 13,
    lastSeenHour: 5,
    resolvedDaysAgo: 13,
    resolvedHour: 12,
    resolvedBy: "tobias",
    resolutionNote:
      "Renewal was failing against a stale account key, silently, for three cycles. Replaced the account key, renewed the certificate and reloaded the edge. The probe now alerts at 30 days rather than 10, so the next silent failure gets caught with room to spare.",
  },
  {
    key: "mi-search-index-stale",
    source: "search-index",
    severity: "warning",
    status: "resolved",
    title: "Catalogue search index stale by a day",
    body: "The nightly reindex did not finish, so search kept serving the previous day's catalogue. Two new variants were invisible to search while the shop pages showed them.",
    dedupKey: "search.index.stale",
    count: 2,
    firstSeenDaysAgo: 5,
    firstSeenHour: 4,
    lastSeenDaysAgo: 5,
    lastSeenHour: 4,
    resolvedDaysAgo: 4,
    resolvedHour: 9,
    resolvedBy: "elodie",
    resolutionNote:
      "The batch aborted on one variant with an empty title, and an aborted batch left the previous index in place. Fixed the row, reindexed by hand and made the job skip and report a bad row instead of throwing away the whole run.",
  },
  {
    key: "mi-kb-images-404",
    source: "cdn-edge",
    severity: "info",
    status: "resolved",
    title: "Knowledge base images returning 404",
    body: "Four images in the setup guides answered 404 at the edge. Text rendered fine, so the articles were readable but missing their diagrams.",
    dedupKey: "cdn.kb.images.404",
    count: 3,
    firstSeenDaysAgo: 7,
    firstSeenHour: 16,
    lastSeenDaysAgo: 7,
    lastSeenHour: 17,
    resolvedDaysAgo: 7,
    resolvedHour: 19,
    resolvedBy: "amina",
    resolutionNote:
      "The images had been dropped into the bucket by hand and never went through the asset pipeline, so they carried no hashed path. Uploaded them again through the pipeline and pointed the four articles at the new paths.",
  },
  {
    key: "mi-queue-backlog",
    source: "job-queue",
    severity: "warning",
    status: "resolved",
    title: "Background job queue backed up to 900 jobs",
    body: "The queue climbed to 900 waiting jobs during the morning batch and drained slowly. Invoice rendering and order sync both sat behind it.",
    dedupKey: "queue.backlog.depth",
    count: 8,
    firstSeenDaysAgo: 1,
    firstSeenHour: 7,
    lastSeenDaysAgo: 0,
    lastSeenHour: -11,
    resolvedDaysAgo: 0,
    resolvedHour: -5,
    resolvedBy: "tobias",
    resolutionNote:
      "One worker had died without releasing its lock, so the batch ran on a single consumer. Restarted the workers, and the backlog drained in four minutes. The lock now expires on its own so a dead worker cannot hold the queue hostage again.",
  },
]

// ── Public shape ─────────────────────────────────────────────────────────────

export interface SeedDemoCommerceOptions {
  org: SeedDemoOrgResult
  /**
   * Anchor for every relative offset: the caller's one `now` (the moment of
   * the seed run, so the world looks freshly active, or a fixed date to
   * reproduce an exact world, as the tests do).
   */
  baseTime: Date
  /**
   * Write the social replies waiting on a decision. Off for a visitor's
   * tailored seed: their workspace opens with nothing waiting on them, and
   * no scenario is about social.
   */
  pendingApprovals?: boolean
}

export interface SeedDemoCommerceResult {
  orgId: string
  issuerProfileId: string
  /** Rows written per table, as counted from what was seeded. */
  counts: Record<string, number>
  /** Money the invoicing set adds up to, in minor units, as decimal strings. */
  totals: {
    /** Net of tax, over every issued invoice (credit notes subtracted). */
    revenueMinor: string
    /** Grand total still owed on issued, unpaid or partly paid invoices. */
    openReceivableMinor: string
    /** Grand total on issued invoices already past their due date and unpaid. */
    overdueMinor: string
  }
  /** Document ids by spec key, so a later batch can link to them. */
  documentIdsByKey: Record<string, string>
  /** Contact ids by party key. */
  contactIdsByKey: Record<string, string>
}

// ── The seeder ───────────────────────────────────────────────────────────────

export async function seedDemoCommerce(
  opts: SeedDemoCommerceOptions,
): Promise<SeedDemoCommerceResult> {
  const { org } = opts
  const ctx = commerceContext(org.orgId, opts.baseTime)
  const catalog = org.world.catalog
  const parties = buildParties(org.world)
  const partiesByKey = new Map(parties.map((p) => [p.key, p]))
  const skus = new Map(catalog.map((s) => [s.sku, invoicingSku(s)]))
  const documents = computeDocuments(ctx, { documents: DOCUMENTS, parties: partiesByKey, skus })
  const documentsByKey = new Map(documents.map((d) => [d.spec.key, d]))

  // As the admin, through the contacts service. A customer the support layer
  // already resolved is that same contact, found by email and left as it is
  // (its tag is already there); dealers and suppliers are new.
  const adminActor = await actorFor(ctx, org.adminUserId)
  const contactIdsByKey = Object.fromEntries(
    (
      await resolveContacts(
        ctx,
        adminActor,
        parties.map((p) => ({
          key: p.key,
          name: p.name,
          email: p.email,
          ...(p.kind === "customer" ? {} : { company: p.name }),
          tags: [p.kind],
          ...(p.kind === "customer"
            ? {}
            : { recipientCountry: p.country, metadata: { country: p.country, kind: p.kind } }),
        })),
      )
    ).map(([key, c]) => [key, c.id]),
  )
  // A dealer's sales address works at that dealer: put it on the company the
  // support layer wrote (found by name; none is created here), so the company
  // page lists the address its mail comes from.
  await seedCompanies(
    ctx,
    adminActor,
    parties
      .filter((p) => p.kind === "dealer")
      .map((p) => ({ key: p.key, name: p.name, contactKeys: [p.key] })),
    contactIdsByKey,
    { onlyExisting: true },
  )
  const { issuerProfileId } = await seedInvoicingHistory(ctx, {
    issuer: shopIssuer(),
    hsCodes: HS_CODE_LIBRARY,
    relationships: Object.entries(contactIdsByKey).map(([key, contactId]) => ({
      key,
      contactId,
      relationship: key.startsWith("sup-") ? ("vendor" as const) : ("customer" as const),
    })),
    documents,
    contactIdsByPartyKey: contactIdsByKey,
  })
  const pnl = derivePnl(documents)
  await seedAccountingSnapshot(ctx, {
    accountClassMap: ACCOUNT_CLASS_MAP,
    pnl,
    // Cash roughly one quarter of gross margin plus a float, split across the
    // two accounts the company actually holds.
    cashByCurrency: { EUR: pnl.grossMarginMinor / 4n + 4_500_000n, USD: 1_280_000n },
  })
  await seedShippingHistory(ctx, {
    senderAddress: demoBoxtalSender(),
    products: shippingProducts(catalog),
    packs: PACKS.map((p) => ({
      ...p,
      contentCategory: DEMO_CONTENT_CATEGORY,
      components: p.components.map((c) => {
        const sku = catalog.find((s) => s.sku === c.sku)
        if (!sku) throw new Error(`seedDemoCommerce: pack ${p.key} names unknown sku ${c.sku}`)
        return {
          sku: c.sku,
          productSource: sku.productSource,
          productId: demoProductId(sku),
          quantity: c.quantity,
        }
      }),
    })),
    attentionRules: ATTENTION_RULES,
    shipments: SHIPMENTS,
    claims: CLAIMS,
    documentsByKey,
    cityFor,
  })
  await seedSocialFeed(ctx, {
    watched: WATCHED,
    findings: FINDINGS,
    dms: DMS,
    monitorTerms: MONITOR_TERMS,
    syncStates: SYNC_STATES,
  })
  if (opts.pendingApprovals !== false) await seedSocialApprovals(ctx, org)
  await seedIncidents(ctx, {
    incidents: INCIDENTS,
    userIdByPersonKey: new Map(org.people.map((p) => [p.key, p.userId])),
  })

  const totals = invoicingTotals(documents, ctx.now)
  return {
    orgId: org.orgId,
    issuerProfileId,
    counts: {
      contacts: parties.length,
      contactRelationships: parties.length,
      issuerProfiles: 1,
      taxRegimes: FRENCH_ISSUER_TAX_REGIMES.length,
      hsCodes: HS_CODE_LIBRARY.length,
      documents: documents.length,
      documentLines: documents.reduce((n, d) => n + d.lines.length, 0),
      shippingProfiles: catalog.length,
      localProducts: catalog.length,
      packs: PACKS.length,
      packComponents: PACKS.reduce((n, p) => n + p.components.length, 0),
      shipments: SHIPMENTS.length,
      claims: CLAIMS.length,
      prepMeta: SHIPMENTS.length,
      attentionRules: ATTENTION_RULES.length,
      pnlSnapshots: 1,
      cashSnapshots: 1,
      accountClassMap: ACCOUNT_CLASS_MAP.length,
      findings: FINDINGS.length,
      watchedObjects: WATCHED.length,
      dmConversations: DMS.length,
      dmMessages: DMS.reduce((n, d) => n + d.messages.length, 0),
      monitorTerms: MONITOR_TERMS.length,
      syncStates: SYNC_STATES.length,
      incidents: INCIDENTS.length,
    },
    totals: {
      revenueMinor: pnl.revenueMinor.toString(),
      openReceivableMinor: totals.openReceivableMinor.toString(),
      overdueMinor: totals.overdueMinor.toString(),
    },
    documentIdsByKey: Object.fromEntries(documents.map((d) => [d.spec.key, d.id])),
    contactIdsByKey,
  }
}

/** A catalog entry as invoicing sees it: its store id and its customs data. */
function invoicingSku(s: DemoSku): InvoicingSku {
  return {
    sku: s.sku,
    title: s.title,
    priceMinor: s.priceMinor,
    productSource: s.productSource,
    // The store's own variant id: what its orders' invoices carry, and what
    // the Boxtal catalog's profiles are keyed by.
    externalId: demoProductId(s),
    hsCode: HS_CODE_BY_TIER[s.tier],
    customsDescription: `${s.title}, portable audio recording equipment`,
  }
}

function shippingProducts(catalog: readonly DemoSku[]) {
  const profiles = new Map(demoShippingProfiles(catalog).map((p) => [p.sku, p]))
  return catalog.map((s) => {
    const found = profiles.get(s.sku)
    if (!found) throw new Error(`seedDemoCommerce: no shipping profile for ${s.sku}`)
    const { sku: _sku, ...profile } = found
    return { sku: s.sku, label: s.title, shortCode: SHORT_CODES[s.sku] ?? s.sku, profile }
  })
}

// ── Invoicing ────────────────────────────────────────────────────────────────

const HS_CODE_LIBRARY: { code: string; description: string }[] = [
  {
    code: "8543.70",
    description: "Electrical machines with individual functions: portable audio recorders",
  },
  { code: "8473.30", description: "Parts and accessories for automatic data processing machines" },
  { code: "4202.12", description: "Cases with an outer surface of plastics or textile materials" },
  { code: "8544.42", description: "Electric conductors fitted with connectors" },
  { code: "8504.40", description: "Static converters: mains power supplies" },
]

const COMPANY_ADDRESS = `${DEMO_COMPANY.addressLine1}\n${DEMO_COMPANY.postalCode} ${DEMO_COMPANY.city}\n${DEMO_COMPANY.country}`

/** The shop's issuer profile: the one every seeded document is issued from. */
function shopIssuer(): IssuerProfileInput {
  return {
    key: "primary",
    legalName: DEMO_COMPANY.legalName,
    country: "FR",
    vatId: DEMO_COMPANY.vat,
    address: COMPANY_ADDRESS,
    iban: DEMO_COMPANY.iban,
    swiftBic: DEMO_COMPANY.swiftBic,
    bankName: DEMO_COMPANY.bankName,
    defaultCurrency: DEMO_COMPANY.defaultCurrency,
    prefixes: {
      invoice: "INV-{YYYY}-",
      quote: "QUO-{YYYY}-",
      proforma: "PRO-{YYYY}-",
      po: "PO-{YYYY}-",
      creditNote: "CN-{YYYY}-",
    },
    // Mapped to the demo store, as a real shop is once configured: an order
    // arriving there issues its own invoice (the order event, then
    // invoicing's auto-issue), so the commerce scenario's live order has
    // the invoice the shipment draft is anchored to (walk D37).
    shopifyShopId: DEMO_SHOP_DOMAIN,
    invoiceApprovalThresholdMinor: "500000",
    poApprovalThresholdMinor: "500000",
    timezone: "Europe/Paris",
  }
}

/** The legal name of the sales scenario's quoting profile: distinct from the shop's. */
export const SALES_ISSUER_LEGAL_NAME = `${DEMO_COMPANY.legalName} (direct sales)`

const SALES_ISSUER_KEY = "direct-sales"

/** The sales scenario's quoting profile id, fixed per org so the routine prompt can name it. */
export function salesIssuerProfileId(orgId: string): string {
  return commerceDemoId(orgId, "issuer_profile", SALES_ISSUER_KEY)
}

/**
 * The issuer profile the sales scenario's routine quotes from. Linked to no
 * shop, so a quote is a plain quote (a shop-linked profile turns a quote into a
 * Shopify draft order), and gated from the first cent (threshold 0), so every
 * quote waits in the routine's one approval request. Its own legal name keeps it
 * apart from the shop's profile in a workspace that seeds both. Idempotent.
 */
export async function seedSalesIssuerProfile(orgId: string, baseTime: Date): Promise<string> {
  const ctx = commerceContext(orgId, baseTime)
  const id = await seedIssuerProfile(ctx, {
    ...shopIssuer(),
    key: SALES_ISSUER_KEY,
    legalName: SALES_ISSUER_LEGAL_NAME,
    prefixes: {
      invoice: "SINV-{YYYY}-",
      quote: "SQ-{YYYY}-",
      proforma: "SPRO-{YYYY}-",
      po: "SPO-{YYYY}-",
      creditNote: "SCN-{YYYY}-",
    },
    shopifyShopId: null,
    invoiceApprovalThresholdMinor: "0",
    poApprovalThresholdMinor: "0",
  })
  if (id !== issuerProfileId(ctx, SALES_ISSUER_KEY) || id !== salesIssuerProfileId(orgId)) {
    throw new Error("seedSalesIssuerProfile: the profile id drifted from its key")
  }
  return id
}

// ── Pennylane ────────────────────────────────────────────────────────────────

const ACCOUNT_CLASS_MAP: { prefix: string; class: "revenue" | "cogs" | "opex" | "other" }[] = [
  { prefix: "70", class: "revenue" },
  { prefix: "60", class: "cogs" },
  { prefix: "61", class: "opex" },
  { prefix: "62", class: "opex" },
  { prefix: "64", class: "opex" },
  { prefix: "66", class: "other" },
  { prefix: "77", class: "other" },
]

/**
 * The Home dashboard's cached figures, derived from the SAME invoicing set the
 * documents list shows. Revenue is the net of tax over every issued invoice
 * with the credit notes subtracted, so the two screens cannot disagree; cost of
 * goods and operating cost are fixed fractions of it, and gross margin is
 * revenue minus cost of goods, which is what `computePnlSummary` means by it.
 */
function derivePnl(documents: readonly ComputedDocument[]): PnlFigures {
  let revenue = 0n
  for (const d of documents) {
    if (d.spec.type === "invoice" && d.spec.status !== "draft") revenue += d.subtotalMinor
    if (d.spec.type === "credit_note") revenue += d.subtotalMinor
  }
  // 44% of revenue in materials and assembly, 31% in salaries, rent and tools,
  // a small financial charge. Integer division, so the figures stay exact.
  const cogs = (revenue * 44n) / 100n
  const opex = (revenue * 31n) / 100n
  const other = (revenue * 2n) / 100n
  return {
    revenueMinor: revenue,
    cogsMinor: cogs,
    opexMinor: opex,
    otherMinor: other,
    grossMarginMinor: revenue - cogs,
  }
}

// ── Boxtal ───────────────────────────────────────────────────────────────────

const CLAIMS: ClaimSpec[] = [
  {
    key: "claim-daniel-customs",
    shipment: "ship-cust-daniel",
    type: "delay",
    amount: 399,
    status: "submitted",
    submitted: true,
    daysAgo: 12,
  },
  {
    key: "claim-uk-returned",
    shipment: "ship-dealer-uk-autumn",
    type: "damage",
    amount: 4_497,
    status: "open",
    submitted: false,
    daysAgo: 4,
  },
]

const ATTENTION_RULES: AttentionRuleInput[] = [
  {
    key: "rule-us-aluminium",
    name: "Aluminium declaration for US imports",
    enabled: true,
    conditions: [{ field: "destination", op: "eq", value: "US" }],
    documents: [
      {
        name: "Smelt and cast declaration",
        note: "Country of smelt for the chassis. Customs asks for it at the border, not before.",
      },
      {
        name: "Commercial invoice, three copies",
        note: "One in the pouch, two inside the carton.",
      },
    ],
  },
  {
    key: "rule-heavy-parcel",
    name: "Two person lift over 15 kg",
    enabled: true,
    conditions: [{ field: "weight", op: "gte", value: 15 }],
    documents: [{ name: "Heavy parcel label", note: "Yellow label on the two long faces." }],
  },
]

const SYNC_STATES: SyncStateSpec[] = [
  {
    key: "ss-ig-discovery",
    platform: "instagram",
    account: "resonantaudiolabs",
    sourceType: "discovery",
    units: 184,
    lastSyncedHoursAgo: 1,
  },
  {
    key: "ss-ig-dm",
    platform: "instagram",
    account: "resonantaudiolabs",
    sourceType: "dm",
    units: 22,
    lastSyncedHoursAgo: 1,
  },
  {
    key: "ss-fb-discovery",
    platform: "facebook",
    account: "resonantaudiolabs",
    sourceType: "discovery",
    units: 96,
    lastSyncedHoursAgo: 2,
  },
  {
    key: "ss-fb-dm",
    platform: "facebook",
    account: "resonantaudiolabs",
    sourceType: "dm",
    units: 11,
    lastSyncedHoursAgo: 2,
  },
  {
    key: "ss-yt-watch",
    platform: "youtube",
    account: "resonantaudiolabs",
    sourceType: "watch",
    units: 240,
    lastSyncedHoursAgo: 1,
  },
]

// ── Social approvals ─────────────────────────────────────────────────────────

/** The conversation the founder's agent staged the social replies in. */
const SOCIAL_APPROVAL_THREAD_TITLE = "Social listening"

/**
 * The pending approvals behind the findings an agent has drafted a reply for.
 *
 * Social reads "awaiting approval" from the live kernel approval that targets a
 * finding (`ctx.approvals.pendingFor`), not from a stored status: a gated
 * `social:reply_to_finding` is parked before its handler runs, so the finding
 * stays `new`. A seed that stored `awaiting_approval` on the finding showed
 * nothing awaiting at all, because a stored status with no pending request
 * behind it reads as `new`.
 *
 * So the seed writes what the live path leaves behind: the founder's personal
 * agent staged the reply on the founder's turn, in the conversation it works
 * the listening feed from, and the request waits there on a decision. Only the
 * founder persona holds the social scopes in the demo world, so it is the one
 * person whose agent could have staged it. Not the founder's DM with their
 * agent: the accounts layer joins the org owner to every seeded thread, and a
 * DM with a second human in it is no longer the DM the product finds, so each
 * re-run would open another.
 */
async function seedSocialApprovals(ctx: SeedContext, org: SeedDemoOrgResult): Promise<void> {
  const specs = FINDINGS.filter((f) => f.pendingReply)
  if (specs.length === 0) return
  const founder = org.people.find((p) => p.role === "founder_admin")
  if (!founder?.personalAgentId) {
    throw new Error("seedDemoCommerce: no founder personal agent to stage the social replies")
  }
  const threadId = await findOrCreateTitledThread(ctx, founder.userId, SOCIAL_APPROVAL_THREAD_TITLE)
  await seedApprovalRequests(
    ctx,
    specs.map((f) => {
      if (!f.suggestedReply) {
        throw new Error(`seedDemoCommerce: finding ${f.key} is pending a reply but drafts none`)
      }
      return {
        id: ctx.id("approval", f.key),
        handle: `demo-social-${f.key}`,
        threadId,
        toolName: "social:reply_to_finding",
        payload: { finding_id: findingId(ctx, f.key), reply_text: f.suggestedReply },
        requestedBy: founder.userId,
        agentId: founder.personalAgentId,
        notifyUserIds: [founder.userId],
        status: "pending" as const,
        // Drafted an hour after the finding came in.
        createdAt: shiftTime(ctx.now, 0, -f.hoursAgo + 1),
      }
    }),
  )
}
