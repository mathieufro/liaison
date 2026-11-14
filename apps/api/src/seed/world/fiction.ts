// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The public demo instance's world, at showroom scale.
//
// It is SELF CONTAINED: every company, catalog, team, dealer and customer
// literal a visitor can see is declared here, and nothing in this directory
// imports anything outside it beyond the runtime it seeds into. That is what
// lets the sample world ship as source.
//
// The privacy rules `world.test.ts` enforces:
//   * SKUs keep the fictional `RAL-` prefix.
//   * Every person and company address outside the org lives on an RFC 2606
//     reserved domain (`.example`), which can never collide with a live mailbox
//     if a demo agent ever actually tries to send.
//   * Declared VAT numbers use an all-zero body, so none can read as a live
//     registration. That includes the company's own.
//   * The IBAN body is all zeros too, which puts "00" in the check-digit
//     positions. Those two digits are 02..98 in every valid IBAN, so the
//     number cannot pass a mod 97 check anywhere and can never be a payable
//     account.
//   * No real retailer, trade show or person's name appears anywhere in the
//     serialized module. That scan runs from the private operator tooling,
//     whose list of real names cannot ship in this tree.
//
// Everything here is a deterministic literal. Nothing is randomized at module
// scope: two seeds of the same org produce byte-identical data, which is what
// makes the seeder re-runnable and the guard meaningful.

/** The domain every seeded address (team, dealers, customers) lives on. */
export const DEMO_EMAIL_DOMAIN = "resonantaudiolabs.example"

/**
 * The company a visitor sees: the identity, plus the detail an invoice, a
 * signature block or an About page needs.
 */
export const DEMO_COMPANY = {
  name: "Resonant Audio Labs",
  legalName: "Resonant Audio Labs SAS",
  /**
   * All-zero body. A published fictional company must not carry a VAT number
   * that reads like a registration, and "checksum happens to be invalid" is
   * luck, not a policy. Same shape as the dealers'.
   */
  vat: "FR00000000000",
  about:
    "Resonant Audio Labs designs portable field recorders and location sound equipment in France, " +
    "and sells them direct and through a small dealer network across Europe, North America and Japan.",
  addressLine1: "14 rue des Ateliers",
  postalCode: "75011",
  city: "Paris",
  country: "FR",
  /**
   * The French IBAN shape (FR + 25 characters) with an all-zero body. The two
   * characters after the country code are the check digits, and "00" is
   * invalid in every IBAN, so this is unmistakably synthetic and can never
   * route to an account. Never a payable one.
   */
  iban: "FR0000000000000000000000000",
  swiftBic: "RALBFRPPXXX",
  bankName: "Banque des Ateliers",
  supportEmail: `support@${DEMO_EMAIL_DOMAIN}`,
  billingEmail: `billing@${DEMO_EMAIL_DOMAIN}`,
  salesEmail: `sales@${DEMO_EMAIL_DOMAIN}`,
  websiteUrl: `https://www.${DEMO_EMAIL_DOMAIN}`,
  defaultCurrency: "EUR",
} as const

/** A catalog entry, with the one line of copy a storefront or a quote shows. */
export interface DemoSku {
  sku: string
  title: string
  tier: "flagship" | "accessory"
  priceMinor: number
  weightKg: number
  productSource: "shopify"
  variantId: string
  description: string
  /** The item alone, packed, in cm: the parcel a one-item shipment takes. None for a service. */
  dimsCm?: { length: number; width: number; height: number }
}

/** The demo store's variant numbers start here, one per catalog entry in order. */
export const DEMO_SHOPIFY_VARIANT_BASE = 8_200_000

/**
 * The demo store's variant id for `sku` (`gid://shopify/ProductVariant/<n>`),
 * the id an order line, its invoice line and a shipment draft carry; null for
 * a SKU the store does not sell.
 */
export function demoShopifyVariantGid(sku: string): string | null {
  const i = DEMO_CATALOG.findIndex((s) => s.sku === sku)
  return i < 0 ? null : `gid://shopify/ProductVariant/${DEMO_SHOPIFY_VARIANT_BASE + i}`
}

/**
 * The catalog a visitor browses: three recorders, one preamp and seven
 * accessories. Deterministic order, fictional `RAL-` prefix throughout.
 */
export const DEMO_CATALOG: DemoSku[] = [
  {
    sku: "RAL-FLAG-01",
    title: "Kestrel 6 Field Recorder",
    tier: "flagship",
    priceMinor: 89900,
    weightKg: 2.4,
    productSource: "shopify",
    variantId: "RAL-VAR-FLAG-01",
    dimsCm: { length: 30, width: 22, height: 8 },
    description:
      "The flagship location recorder: six inputs, 32 bit float capture, timecode in and out.",
  },
  {
    sku: "RAL-ACC-CASE",
    title: "Kestrel Travel Case",
    tier: "accessory",
    priceMinor: 12900,
    weightKg: 1.1,
    productSource: "shopify",
    variantId: "RAL-VAR-ACC-CASE",
    dimsCm: { length: 40, width: 30, height: 14 },
    description: "A moulded travel case sized for the flagship recorder and its cable set.",
  },
  {
    sku: "RAL-ACC-CABLE",
    title: "Kestrel XLR Cable Set",
    tier: "accessory",
    priceMinor: 2900,
    weightKg: 0.2,
    productSource: "shopify",
    variantId: "RAL-VAR-ACC-CABLE",
    dimsCm: { length: 20, width: 15, height: 5 },
    description: "The complete XLR set for microphones, timecode and the control bus.",
  },
  {
    sku: "RAL-FLAG-02",
    title: "Kestrel 10 Field Recorder",
    tier: "flagship",
    priceMinor: 134900,
    weightKg: 3.6,
    productSource: "shopify",
    variantId: "RAL-VAR-FLAG-02",
    dimsCm: { length: 36, width: 26, height: 9 },
    description: "The ten input body for a larger crew: the same preamps, more tracks at once.",
  },
  {
    sku: "RAL-FLAG-03",
    title: "Kestrel Pocket Recorder",
    tier: "flagship",
    priceMinor: 54900,
    weightKg: 1.2,
    productSource: "shopify",
    variantId: "RAL-VAR-FLAG-03",
    dimsCm: { length: 16, width: 9, height: 4 },
    description: "A two input recorder for a bag or a coat pocket, with the same preamps.",
  },
  {
    sku: "RAL-FLAG-04",
    title: "Kestrel Field Preamp",
    tier: "flagship",
    priceMinor: 39900,
    weightKg: 1.8,
    productSource: "shopify",
    variantId: "RAL-VAR-FLAG-04",
    dimsCm: { length: 20, width: 14, height: 6 },
    description:
      "A four channel preamp that links to the recorders over the same clock and control bus.",
  },
  {
    sku: "RAL-ACC-STAND",
    title: "Kestrel Tripod Mount",
    tier: "accessory",
    priceMinor: 8900,
    weightKg: 1.4,
    productSource: "shopify",
    variantId: "RAL-VAR-ACC-STAND",
    dimsCm: { length: 25, width: 10, height: 8 },
    description: "An adjustable aluminium mount that fixes a recorder to a tripod or a boom stand.",
  },
  {
    sku: "RAL-ACC-PSU",
    title: "Kestrel Power Supply",
    tier: "accessory",
    priceMinor: 4900,
    weightKg: 0.4,
    productSource: "shopify",
    variantId: "RAL-VAR-ACC-PSU",
    dimsCm: { length: 12, width: 8, height: 5 },
    description: "The spare mains adapter, with interchangeable EU, UK, US and JP heads.",
  },
  {
    sku: "RAL-ACC-USB",
    title: "Kestrel USB C Cable",
    tier: "accessory",
    priceMinor: 1900,
    weightKg: 0.1,
    productSource: "shopify",
    variantId: "RAL-VAR-ACC-USB",
    dimsCm: { length: 15, width: 10, height: 2 },
    description: "A two metre braided cable rated for the recorder's full bus power draw.",
  },
  {
    sku: "RAL-ACC-WIND",
    title: "Kestrel Windshield Pack",
    tier: "accessory",
    priceMinor: 3900,
    weightKg: 0.3,
    productSource: "shopify",
    variantId: "RAL-VAR-ACC-WIND",
    dimsCm: { length: 30, width: 20, height: 10 },
    description: "A blimp cover, a fur windjammer, two foam shields and a spare shoe mount.",
  },
  {
    sku: "RAL-ACC-CARE",
    title: "Extended Care Plan",
    tier: "accessory",
    priceMinor: 7900,
    weightKg: 0.05,
    productSource: "shopify",
    variantId: "RAL-VAR-ACC-CARE",
    description: "Two extra years of cover, including one free return shipment per year.",
  },
]

/** The role vocabulary the seeded team maps onto. */
export type DemoRole =
  | "founder_admin"
  | "ops_lead"
  | "support"
  | "fulfillment"
  | "engineering"
  | "finance"
  | "sales"

export interface DemoPerson {
  /** Stable key: the seeder's result is indexed by it, and the avatar derives from it. */
  key: string
  name: string
  /** Shown next to the name wherever the demo names a person. */
  jobTitle: string
  role: DemoRole
  email: string
  /** Two sentences at most: who they are and what lands on their desk. */
  bio: string
}

export const DEMO_TEAM: DemoPerson[] = [
  {
    key: "elodie",
    name: "Elodie Vasseur",
    jobTitle: "Founder and CEO",
    role: "founder_admin",
    email: `elodie@${DEMO_EMAIL_DOMAIN}`,
    bio: "Founded the company after ten years designing recorders for other people. Still reads every support thread on a Monday morning.",
  },
  {
    key: "tobias",
    name: "Tobias Braun",
    jobTitle: "Head of Operations",
    role: "ops_lead",
    email: `tobias@${DEMO_EMAIL_DOMAIN}`,
    bio: "Runs the desk end to end: the support queue, the dealer orders and everything that ships. Owns the morning digest.",
  },
  {
    key: "amina",
    name: "Amina Cherif",
    jobTitle: "Customer Support Lead",
    role: "support",
    email: `amina@${DEMO_EMAIL_DOMAIN}`,
    bio: "Leads the support team and keeps the knowledge base honest. Answers in French, English and Arabic.",
  },
  {
    key: "lucas",
    name: "Lucas Pereira",
    jobTitle: "Customer Support Specialist",
    role: "support",
    email: `lucas@${DEMO_EMAIL_DOMAIN}`,
    bio: "Handles firmware and connectivity tickets, and the ones that arrive as a video of a blinking light. Escalates hardware faults to fulfillment.",
  },
  {
    key: "margot",
    name: "Margot Dufour",
    jobTitle: "Fulfillment Coordinator",
    role: "fulfillment",
    email: `margot@${DEMO_EMAIL_DOMAIN}`,
    bio: "Prepares every shipment and every return, customs paperwork included. Knows which carrier is late before the tracking does.",
  },
  {
    key: "henrik",
    name: "Henrik Sandberg",
    jobTitle: "Finance Manager",
    role: "finance",
    email: `henrik@${DEMO_EMAIL_DOMAIN}`,
    bio: "Owns invoicing, refunds and the month end close. Reconciles the dealer accounts before anyone asks.",
  },
  {
    key: "giulia",
    name: "Giulia Ferrari",
    jobTitle: "Sales and Partnerships",
    role: "sales",
    email: `giulia@${DEMO_EMAIL_DOMAIN}`,
    bio: "Looks after the dealer network and the education accounts. Turns a volume enquiry into a quote the same day.",
  },
]

/**
 * The ticket teams each desk works, as `tickets:team` values. Every seeded
 * ticket is tagged with one of these four teams, and a team-tagged ticket is
 * readable only by someone holding that team (RLS on the `tickets:team`
 * dimension), so a desk without its team sees an empty queue.
 *
 * Support answers the support queue, fulfillment is the operations team
 * (shipping, customs, returns), finance and sales keep their own. The head of
 * operations "runs the desk end to end: the support queue, the dealer orders
 * and everything that ships", so the ops lead holds those three teams and not
 * finance's. The founder is the org's `admin`, whose wildcard grant already
 * covers every team.
 */
export const DEMO_DESK_TEAMS: Record<Exclude<DemoRole, "founder_admin">, readonly string[]> = {
  ops_lead: ["support", "operations", "sales"],
  support: ["support"],
  fulfillment: ["operations"],
  engineering: ["support"],
  finance: ["finance"],
  sales: ["sales"],
}

export interface DemoDealer {
  key: string
  name: string
  /** ISO 3166-1 alpha-2. */
  country: string
  /**
   * Optional, and an all-zero body when declared: never a real public example
   * VAT, which would read as a live registration.
   */
  vat?: string
  isVip: boolean
}

/** The dealer network: six territories across the EU, the UK, the US and Japan. */
export const DEMO_DEALERS: DemoDealer[] = [
  { key: "eu-de", name: "Klangwerk GmbH", country: "DE", vat: "DE000000000", isVip: true },
  { key: "us-ca", name: "Westcoast Pro Audio LLC", country: "US", isVip: false },
  {
    key: "uk-ldn",
    name: "Northfield Instruments Ltd",
    country: "GB",
    vat: "GB000000000",
    isVip: true,
  },
  { key: "jp-tky", name: "Harborlight Audio KK", country: "JP", isVip: false },
  { key: "nl-ams", name: "Kanaal Audio BV", country: "NL", vat: "NL000000000", isVip: false },
  { key: "fr-lyo", name: "Atelier Sonore SARL", country: "FR", vat: "FR00000000000", isVip: true },
]

export interface DemoCustomer {
  key: string
  name: string
  email: string
  /** ISO 3166-1 alpha-2. */
  country: string
  isVip: boolean
}

/**
 * The end-customer base: about twenty people across the territories the
 * dealers cover. Every address is on a reserved domain.
 */
export const DEMO_CUSTOMERS: DemoCustomer[] = [
  {
    key: "claudine-moreau",
    name: "Claudine Moreau",
    email: "claudine.moreau@studiotone.example",
    country: "FR",
    isVip: true,
  },
  {
    key: "jasper-nilsson",
    name: "Jasper Nilsson",
    email: "jasper.nilsson@arclight.example",
    country: "SE",
    isVip: true,
  },
  {
    key: "helena-ritter",
    name: "Helena Ritter",
    email: "helena.ritter@nordlicht.example",
    country: "DE",
    isVip: true,
  },
  {
    key: "tomoko-arai",
    name: "Tomoko Arai",
    email: "tomoko.arai@hanabi.example",
    country: "JP",
    isVip: true,
  },
  {
    key: "daniel-okafor",
    name: "Daniel Okafor",
    email: "daniel.okafor@brightroom.example",
    country: "GB",
    isVip: false,
  },
  {
    key: "sara-lindqvist",
    name: "Sara Lindqvist",
    email: "sara.lindqvist@vinterljud.example",
    country: "SE",
    isVip: false,
  },
  {
    key: "pierre-caron",
    name: "Pierre Caron",
    email: "pierre.caron@atelier9.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "marta-nowak",
    name: "Marta Nowak",
    email: "marta.nowak@dzwiek.example",
    country: "PL",
    isVip: false,
  },
  {
    key: "ivan-petrov",
    name: "Ivan Petrov",
    email: "ivan.petrov@echoform.example",
    country: "BG",
    isVip: false,
  },
  {
    key: "grace-whitfield",
    name: "Grace Whitfield",
    email: "grace.whitfield@lowtide.example",
    country: "US",
    isVip: false,
  },
  {
    key: "andre-silva",
    name: "Andre Silva",
    email: "andre.silva@maresom.example",
    country: "PT",
    isVip: false,
  },
  {
    key: "nora-haugen",
    name: "Nora Haugen",
    email: "nora.haugen@fjordlab.example",
    country: "NO",
    isVip: false,
  },
  {
    key: "felix-berger",
    name: "Felix Berger",
    email: "felix.berger@klangbau.example",
    country: "AT",
    isVip: false,
  },
  {
    key: "amelie-roux",
    name: "Amelie Roux",
    email: "amelie.roux@studiobleu.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "hiroshi-kubo",
    name: "Hiroshi Kubo",
    email: "hiroshi.kubo@aozora.example",
    country: "JP",
    isVip: false,
  },
  {
    key: "lena-vos",
    name: "Lena Vos",
    email: "lena.vos@grachtsound.example",
    country: "NL",
    isVip: false,
  },
  {
    key: "owen-brady",
    name: "Owen Brady",
    email: "owen.brady@harbourkeys.example",
    country: "IE",
    isVip: false,
  },
  {
    key: "clara-mendes",
    name: "Clara Mendes",
    email: "clara.mendes@ritmolab.example",
    country: "BR",
    isVip: false,
  },
  {
    key: "victor-hansen",
    name: "Victor Hansen",
    email: "victor.hansen@bolgelyd.example",
    country: "DK",
    isVip: false,
  },
  // A business customer who is ALSO a company in the demo's API connection
  // (the fixture CRM): her address is on that company's domain, so the
  // customer card on her ticket and her mail thread shows a match.
  {
    key: "jane-doe",
    name: "Jane Doe",
    email: "jane.doe@acme-instruments.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "aisha-khan",
    name: "Aisha Khan",
    email: "aisha.khan@northsignal.example",
    country: "CA",
    isVip: false,
  },
]

/**
 * One end customer with one order of her own, both FIXED: the demo store
 * places them outside its seeded random assignment, so adding them moved no
 * other order's customer. A request that names a customer by first name
 * ("refund Élodie on her Shopify order") has exactly one person and one order
 * to find. Not in `DEMO_CUSTOMERS`, so the seeded contacts, tickets and
 * conversations drawn from that list are unchanged.
 */
export const DEMO_FIXED_CUSTOMER: DemoCustomer = {
  key: "elodie-marchand",
  name: "Élodie Marchand",
  email: "elodie.marchand@lumiere-sonore.example",
  country: "FR",
  isVip: false,
}

/**
 * The school the seeded dealer quote approval is for (`dealer-quote-conservatoire`),
 * FIXED like `DEMO_FIXED_CUSTOMER`: the demo store lists it as a customer outside
 * its seeded random assignment (so no generated order or quote changes customer),
 * and its kernel contact carries that Shopify customer id. Approving the quote then
 * makes a draft order linked to a store customer with an email on record, which is
 * what Invoicing needs to invoice the order once it is paid (the draft's own email
 * is on a reserved domain, which Shopify drops).
 */
export const DEMO_QUOTE_DEALER = {
  key: "conservatoire-belmont",
  name: "Conservatoire de Belmont",
  email: "achats@conservatoire-belmont.example",
  country: "FR",
  address: "12 rue des Ateliers\n69007 Lyon\nFrance",
  /** Above the generated customers (7100000 upward) and the fixed customer. */
  shopifyCustomerId: 7_190_002,
} as const

/** Her order: paid, shipped, nothing refunded yet. */
export const DEMO_FIXED_ORDER = {
  /** Above the generated orders and the live scenario's orders, so no number clashes. */
  numericId: 6_102_001,
  name: "#3001",
  sku: "RAL-FLAG-02",
  quantity: 1,
  /** Placed this many days before the store's day anchor. */
  daysAgo: 12,
} as const

/**
 * A world's company: what an invoice, a signature block, the mail footer or an
 * About page states about it. Every world pack fills the same fields.
 */
export interface DemoCompany {
  readonly name: string
  readonly legalName: string
  /** All-zero body, like every declared VAT number in a pack. */
  readonly vat: string
  readonly about: string
  readonly addressLine1: string
  readonly postalCode: string
  readonly city: string
  /** ISO 3166-1 alpha-2. */
  readonly country: string
  /** All-zero body: never a payable account. */
  readonly iban: string
  readonly swiftBic: string
  readonly bankName: string
  readonly supportEmail: string
  readonly billingEmail: string
  readonly salesEmail: string
  readonly websiteUrl: string
  readonly defaultCurrency: string
}

/** The whole world in one value, so a seeder takes a single argument. */
export interface DemoWorld {
  company: DemoCompany
  catalog: DemoSku[]
  team: DemoPerson[]
  dealers: DemoDealer[]
  customers: DemoCustomer[]
}

export const DEMO_WORLD: DemoWorld = {
  company: DEMO_COMPANY,
  catalog: DEMO_CATALOG,
  team: DEMO_TEAM,
  dealers: DEMO_DEALERS,
  customers: DEMO_CUSTOMERS,
}

/**
 * The shared role agents the org runs alongside each person's own. `scopeRole`
 * names which role's scope bundle bounds the agent's ceiling (resolved through
 * `role-scopes.ts`), so an agent can never reach past the desk it speaks for.
 *
 * `toolAllowlist` and `modelPreference` mirror what a real desk agent carries
 * in production: a curated tool set narrower than the scope ceiling (the
 * ceiling is what the desk COULD reach, the allowlist is what it actually
 * calls day to day) and a model pinned to the desk's own risk profile rather
 * than left on Auto. Both are bounded by `scopeRole`: every allowlist entry
 * below names a tool whose deciding scope is already inside the matching
 * bundle in `role-scopes.ts`.
 */
export interface DemoRoleAgent {
  handle: string
  displayName: string
  /** The one sentence the agent directory shows. */
  purpose: string
  systemPrompt: string
  scopeRole: DemoRole
  /** Canonical `app:tool` names, matching the deciding scope of `scopeRole`. */
  toolAllowlist: string[]
  /** A `model-pricing-seed.ts` model id. Null means Auto; these desks pin one. */
  modelPreference: string
}

export const DEMO_ROLE_AGENTS: DemoRoleAgent[] = [
  {
    handle: "@support",
    displayName: "Support Desk",
    purpose: "Answers customer tickets and mail for Resonant Audio Labs.",
    systemPrompt:
      "You are the support desk at Resonant Audio Labs, a French maker of portable field recorders " +
      "and location sound gear: the Kestrel recorders, the field preamp, and the accessory range. You answer " +
      "tickets and mail from direct customers, dealers, and education accounts, in French or English " +
      "depending on who wrote in.\n\n" +
      "What you own: every reply, and every return or warranty decision, from first read to the moment " +
      "a person has to sign off on money or a label. Ground each answer in the knowledge base first, and " +
      "read customer-reply-voice before you draft anything, its shape and its voice rules are what a " +
      "customer actually receives, not chat habits.\n\n" +
      "When the ticket is a return, a warranty claim, or a replacement, read returns-and-warranty before " +
      "deciding: it tells you which of return, warranty, or credit applies, when a Care Plan holder gets " +
      "advance replacement, and why a dealer's customer still comes to us rather than back to the shop. " +
      "When the knowledge base itself looks stale, wrong, or you have now given the same answer three " +
      "times, follow knowledge-upkeep and say so rather than writing it from scratch a fourth time.\n\n" +
      "A shipping or tracking question is not yours to answer from a guess: ask the operations desk " +
      "(@operations) with kernel__agents_ask. A payment or invoice question: ask the finance desk " +
      "(@finance) with kernel__agents_ask. Asking posts the question and its answer in this conversation " +
      "without adding that desk to it; never call kernel__agents_invite for a question or a hand-off. " +
      "Read escalation-path before deciding " +
      "whether something is genuinely an escalation, an angry tone on its own and a long ticket are not " +
      "one.\n\n" +
      "Escalate to Amina Cherif, the support lead, the same day for a customer on their second failed " +
      "unit, or a dealer or education account blocked on something we have promised. Escalate to Elodie " +
      "Vasseur, the founder, immediately and before any reply for a safety question about a power supply " +
      "or a mains lead, or anything a journalist or reviewer asks in public.\n\n" +
      "You never send a refund, a goodwill gesture, or a promise about a date we have not committed to " +
      "without a person approving it first. Prepare the return, name the amount and the carrier, and let " +
      "a human decide. You never call a unit beyond saving, every one has a recovery bootloader.",
    scopeRole: "support",
    toolAllowlist: [
      "database:db_list_reads",
      "database:db_read",
      "database:db_describe",
      "tickets:search",
      "tickets:get",
      "tickets:reply",
      "tickets:addNote",
      "tickets:setStatus",
      "tickets:assign",
      "tickets:close",
      "mail:search",
      "mail:read",
      "mail:reply",
      "knowledge:search",
      "knowledge:get",
      "shopify:orders_search",
      "shopify:orders_get",
      "shopify:returns_request",
      "shopify:returns_approve",
      "boxtal:track",
      "boxtal:get_shipment",
    ],
    modelPreference: "claude-sonnet-4-6",
  },
  {
    handle: "@operations",
    displayName: "Operations Desk",
    purpose: "Prepares shipments, tracks carriers and keeps the order queue moving.",
    systemPrompt:
      "You are the operations desk at Resonant Audio Labs. You watch the order queue, prepare shipments " +
      "and returns, check stock before promising a date, and read the carrier tracking twice a day so an " +
      "exception is found by us before a customer notices it.\n\n" +
      "What you own: every shipment from the moment an order is ready to pack until it is marked " +
      "delivered, and every parcel that stops moving in between. Read shipment-exception before you " +
      "write anything about a late, stuck, refused, damaged, or lost parcel: it names the five shapes an " +
      "exception takes and what each one calls for, and which of them the customer has probably already " +
      "noticed.\n\n" +
      "A dealer or an education account asking for trade pricing or a quote is dealer-pricing-and-quotes " +
      "territory: work out the tier from FLAGSHIP units ordered in the last twelve months before you " +
      "write a number, and never let an accessory order move a tier. Read escalation-path when a dealer " +
      "sounds blocked rather than simply asking a question, a blocked promise to a dealer or an education " +
      "account is same day, named as such.\n\n" +
      "Quote real numbers read from the system: an inventory count, a tracking scan, a carrier's own " +
      "status. Never estimate one, and never promise same day shipping after the 15:00 Paris carrier " +
      "cutoff, say next working day instead so it arrives when you said.\n\n" +
      "Buying a replacement label, opening a paid carrier claim, and any refund are all a person's " +
      "decision: prepare the shipment or the claim, name the carrier and the cost, and let Tobias Braun, " +
      "the head of operations, or a person he names approve it. Escalate to Tobias the same day for " +
      "anything that looks like a pattern rather than one late parcel, and to Elodie Vasseur, the " +
      "founder, immediately for a safety question about a unit or its power supply.\n\n" +
      "You never buy a label, refund, or message a customer with a promise you have not checked against " +
      "the tracking first.",
    scopeRole: "ops_lead",
    toolAllowlist: [
      "database:db_list_reads",
      "database:db_read",
      "database:db_describe",
      "database:db_query",
      "boxtal:track",
      "boxtal:get_shipment",
      "boxtal:get_documents",
      "boxtal:quote",
      "boxtal:to_prepare_list",
      "boxtal:ready_list",
      "boxtal:exceptions_list",
      "boxtal:print_pack",
      // The commerce scenario: the order's row in the prep list, its draft,
      // and the booking itself (gated: a person approves it).
      "boxtal:prep_list",
      "boxtal:prep_order_prefill",
      "boxtal:shipment_draft_get",
      "boxtal:create_shipment",
      "shopify:orders_search",
      "shopify:orders_get",
      "shopify:fulfillments_get",
      "shopify:fulfillment_orders_get",
      "shopify:inventory_levels_list",
      "shopify:returns_search",
      // Whether an order is invoiced, and its invoice when the order event
      // issued none (gated: a person approves it).
      "invoicing:documents_for_orders",
      "invoicing:documents_get",
      "invoicing:invoice_create_and_issue",
      "tickets:search",
      "tickets:get",
      "tickets:reply",
    ],
    modelPreference: "claude-sonnet-4-6",
  },
  {
    handle: "@finance",
    displayName: "Finance Desk",
    purpose: "Handles invoices, refunds and the dealer accounts.",
    systemPrompt:
      "You are the finance desk at Resonant Audio Labs. You issue and chase invoices, check what a " +
      "dealer actually owes before any reminder goes out, prepare refunds and credit notes, and close " +
      "the month in the order the business actually needs, not the order that is fastest.\n\n" +
      "What you own: every invoice, credit note, quote, and purchase order the company issues, and the " +
      "VAT treatment behind each one. Read eu-and-export-vat before you put a number on anything crossing " +
      "a border or naming a reverse charge, a VAT number that validated last quarter is not evidence it " +
      "validates today. Read refunds-and-credit-notes before preparing either one: which of a refund, a " +
      "credit, or a partial credit note applies, and what the document has to say about why. Read " +
      "month-end-close in order, doing it out of order is what turns a close into a week's work instead " +
      "of a day's.\n\n" +
      "State the currency and the document number every time you mention money. Before you call an " +
      "invoice late, check whether a receipt is sitting unmatched, our dealers settle several invoices " +
      "with one transfer, and chasing one who has already paid costs more than the invoice ever did.\n\n" +
      "When a customer disputes a charge or a chargeback lands, read the order and the invoice before " +
      "answering, and never refund into an open dispute. Escalate it to Henrik Sandberg, the finance " +
      "manager, the same day and let him decide. Escalate to Elodie Vasseur, the founder, for anything " +
      "that reads as a filing correction rather than an edit, a wrong VAT treatment found after the " +
      "quarter has closed is a filing, not a fix.\n\n" +
      "Issuing an invoice, sending it, crediting it, and refunding are all a person's decision, no " +
      "threshold makes one automatic. Prepare the document, state the treatment you applied and why, and " +
      "let Henrik or a person he names issue it.",
    scopeRole: "finance",
    toolAllowlist: [
      "database:db_list_reads",
      "database:db_read",
      "database:db_describe",
      "invoicing:documents_search",
      "invoicing:documents_get",
      "invoicing:documents_for_orders",
      "invoicing:vat_validate",
      "invoicing:deferred_list",
      "invoicing:invoice_issue",
      "invoicing:invoice_create_and_issue",
      "invoicing:credit_note_create_and_issue",
      "invoicing:credit_note_issue",
      "invoicing:documents_record_refund",
      "invoicing:documents_mark_paid",
      "shopify:refunds_create",
      "shopify:orders_get",
      "pennylane:trial_balance_get",
      "pennylane:cash_position",
      "pennylane:supplier_invoices_list",
      "tickets:search",
      "tickets:get",
    ],
    modelPreference: "claude-opus-4-6",
  },
]
