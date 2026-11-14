// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `saas` world's company: Tideform, a Paris software company that sells
// rota and shift planning to hospitality groups by subscription. Its team, the
// desks its agents speak for and the customer contacts its named rows name.
//
// The privacy rules of `seed/world/fiction.ts` hold here too: every address
// outside the org is on a reserved `.example` domain, every declared VAT number
// and the IBAN have an all-zero body, and nothing names a real company or
// person. Nothing in this file is a date: every instant the pack writes is a
// role on the story clock (`../story-clock.ts`), computed at seed time.
//
// The owner's seat is the visitor's (they are the CEO), so no person here is
// the CEO and no seeded row carries the owner's name. Yann, the CTO and
// co-founder, holds the founder's admin role: with no owner (an org nobody
// signs into) the org is created around his seat.
import type {
  DemoCompany,
  DemoCustomer,
  DemoPerson,
  DemoRole,
  DemoRoleAgent,
  DemoWorld,
} from "../../world/fiction"

/** The reserved domain the team lives under, one label per org below it. */
export const SAAS_EMAIL_DOMAIN = "tideform.example"

export const SAAS_COMPANY: DemoCompany = {
  name: "Tideform",
  legalName: "Tideform SAS",
  vat: "FR00000000000",
  about:
    "Tideform makes rota and shift planning software for hospitality groups: hotels, restaurants " +
    "and canteens plan their teams, swap shifts and export hours to payroll. Sold by subscription " +
    "from Paris, by a team of 14.",
  addressLine1: "8 rue des Marées",
  postalCode: "75010",
  city: "Paris",
  country: "FR",
  iban: "FR0000000000000000000000000",
  swiftBic: "TDFMFRPPXXX",
  bankName: "Banque des Marées",
  supportEmail: `support@${SAAS_EMAIL_DOMAIN}`,
  billingEmail: `billing@${SAAS_EMAIL_DOMAIN}`,
  salesEmail: `sales@${SAAS_EMAIL_DOMAIN}`,
  websiteUrl: `https://www.${SAAS_EMAIL_DOMAIN}`,
  defaultCurrency: "EUR",
}

/** Plans per month, excluding VAT, in minor units. Yearly bills twelve months at once. */
export const SAAS_PLANS = {
  starter: { name: "Starter", monthlyMinor: 14_900 },
  team: { name: "Team", monthlyMinor: 49_000 },
  group: { name: "Group", monthlyMinor: 145_000 },
} as const

export type SaasPlan = keyof typeof SAAS_PLANS

const person = (
  key: string,
  name: string,
  jobTitle: string,
  role: DemoRole,
  bio: string,
): DemoPerson => ({ key, name, jobTitle, role, email: `${key}@${SAAS_EMAIL_DOMAIN}`, bio })

/**
 * The 13 people beside the owner. With the owner's seat that is the 14 the
 * door names. Order is the directory's.
 */
export const SAAS_TEAM: DemoPerson[] = [
  person(
    "tom",
    "Tom Reyes",
    "Sales",
    "sales",
    "Runs new business: demos, proposals and the pipeline. Most open deals are his.",
  ),
  person(
    "elodie",
    "Élodie Renard",
    "Account Manager",
    "sales",
    "Looks after the larger hotel groups once they sign: renewals, rollouts and the people who use the rota every week.",
  ),
  person(
    "ines",
    "Inès Caron",
    "Support Lead",
    "support",
    "Leads support: the ticket queue, the help centre and the hand over of bugs to the developers.",
  ),
  person(
    "yann",
    "Yann Le Goff",
    "CTO and co-founder",
    "founder_admin",
    "Co-founded the company and runs the product's engineering. Holds the keys to the workspace's settings.",
  ),
  person(
    "sara",
    "Sara Benali",
    "Finance",
    "finance",
    "Runs billing and the books: invoices, failed card payments, refunds and the month end.",
  ),
  person(
    "lucie",
    "Lucie Vasseur",
    "Product Manager",
    "ops_lead",
    "Owns the roadmap and the feedback that feeds it, and keeps support and engineering talking.",
  ),
  person(
    "baptiste",
    "Baptiste Noël",
    "Developer",
    "engineering",
    "Works on the planning engine and the payroll exports.",
  ),
  person(
    "amel",
    "Amel Saïdi",
    "Developer",
    "engineering",
    "Builds the mobile app staff use to see and swap their shifts.",
  ),
  person(
    "jonas",
    "Jonas Keller",
    "Developer",
    "engineering",
    "Looks after integrations and the reliability of the rota bugs room's fixes.",
  ),
  person(
    "clemence",
    "Clémence Roy",
    "Support",
    "support",
    "Answers tickets and runs onboarding calls for new venues.",
  ),
  person(
    "nolan",
    "Nolan Faure",
    "Support",
    "support",
    "Answers tickets and writes most of the help centre's how-to articles.",
  ),
  person(
    "maxime",
    "Maxime Aubert",
    "Sales",
    "sales",
    "Prospects independent restaurants and small hotel groups.",
  ),
  person(
    "rose",
    "Rose Delmas",
    "Office Manager",
    "finance",
    "Keeps the office, the suppliers and the team's admin running.",
  ),
]

/**
 * The people the named rows write to, each at their company. Keys are the
 * contact keys the support layer and the pack's layer share (`customer:<key>`).
 */
export const SAAS_CUSTOMERS: DemoCustomer[] = [
  {
    key: "claire-vidal",
    name: "Claire Vidal",
    email: "claire@maison-arlon.example",
    country: "FR",
    isVip: true,
  },
  {
    key: "noor-haddad",
    name: "Noor Haddad",
    email: "noor@brasserie-lumen.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "marc-sauvan",
    name: "Marc Sauvan",
    email: "marc@hotels-sauvan.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "hugo-perrin",
    name: "Hugo Perrin",
    email: "hugo@auberge-tilleul.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "samir-ait",
    name: "Samir Aït",
    email: "samir@kora-hospitality.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "julie-marchetti",
    name: "Julie Marchetti",
    email: "julie@pont-neuf-bistrots.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "paul-vauban",
    name: "Paul Garnier",
    email: "paul@tables-vauban.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "anais-selene",
    name: "Anaïs Morel",
    email: "anais@comptoir-selene.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "victor-ondine",
    name: "Victor Lambert",
    email: "victor@hotel-ondine.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "lina-carmin",
    name: "Lina Roussel",
    email: "lina@bistrot-carmin.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "denis-ormes",
    name: "Denis Fabre",
    email: "denis@trois-ormes.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "emma-ombre",
    name: "Emma Blanc",
    email: "emma@cafe-ombre.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "theo-saint-cyr",
    name: "Théo Mercier",
    email: "theo@relais-saint-cyr.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "louise-verrieres",
    name: "Louise Bertin",
    email: "louise@groupe-verrieres.example",
    country: "FR",
    isVip: false,
  }, // The colleagues at the named companies (3 at Arlon, 2 at Sauvan, Pont Neuf and Vauban, 4 at
  // Verrières), after each company's first contact, who stays the one the boards write to.
  {
    key: "lise-arlon",
    name: "Lise Morand",
    email: "lise@maison-arlon.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "herve-arlon",
    name: "Hervé Dumas",
    email: "herve@maison-arlon.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "chloe-sauvan",
    name: "Chloé Garcia",
    email: "chloe@hotels-sauvan.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "karim-pont-neuf",
    name: "Karim Haddou",
    email: "karim@pont-neuf-bistrots.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "julie-ferran",
    name: "Julie Ferran",
    email: "julie@tables-vauban.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "marion-verrieres",
    name: "Marion Leclerc",
    email: "marion@groupe-verrieres.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "antoine-verrieres",
    name: "Antoine Roux",
    email: "antoine@groupe-verrieres.example",
    country: "FR",
    isVip: false,
  },
  {
    key: "sophie-verrieres",
    name: "Sophie Girard",
    email: "sophie@groupe-verrieres.example",
    country: "FR",
    isVip: false,
  },
]

/** The company each contact works for, by customer key. */
export const SAAS_CUSTOMER_COMPANIES: Readonly<Record<string, string>> = {
  "claire-vidal": "Maison Arlon",
  "noor-haddad": "Brasserie Lumen",
  "marc-sauvan": "Hôtels Sauvan",
  "hugo-perrin": "Auberge Tilleul",
  "samir-ait": "Kora Hospitality",
  "julie-marchetti": "Pont Neuf Bistrots",
  "paul-vauban": "Les Tables Vauban",
  "anais-selene": "Comptoir Sélène",
  "victor-ondine": "Hôtel Ondine",
  "lina-carmin": "Bistrot Carmin",
  "denis-ormes": "Hôtel des Trois Ormes",
  "emma-ombre": "Café Ombre",
  "theo-saint-cyr": "Relais Saint-Cyr",
  "louise-verrieres": "Groupe Verrières",
  "lise-arlon": "Maison Arlon",
  "herve-arlon": "Maison Arlon",
  "chloe-sauvan": "Hôtels Sauvan",
  "karim-pont-neuf": "Pont Neuf Bistrots",
  "julie-ferran": "Les Tables Vauban",
  "marion-verrieres": "Groupe Verrières",
  "antoine-verrieres": "Groupe Verrières",
  "sophie-verrieres": "Groupe Verrières",
}

export const SAAS_WORLD: DemoWorld = {
  company: SAAS_COMPANY,
  catalog: [],
  team: SAAS_TEAM,
  dealers: [],
  customers: SAAS_CUSTOMERS,
}

/**
 * The ticket teams each desk works. Developers read the support queue, where
 * the bugs arrive; the product manager reads support and sales.
 */
export const SAAS_DESK_TEAMS: Record<Exclude<DemoRole, "founder_admin">, readonly string[]> = {
  ops_lead: ["support", "sales"],
  support: ["support"],
  fulfillment: ["support"],
  engineering: ["support"],
  finance: ["finance"],
  sales: ["sales"],
}

/** Who looks after which named customer (account managers), by person key. */
export const SAAS_ACCOUNT_MANAGERS: Readonly<Record<string, readonly string[]>> = {
  elodie: ["Maison Arlon", "Hôtel Mirabel", "Cantines du Port", "Hôtels Belcour"],
  tom: [
    "Hôtel Ondine",
    "Auberge Tilleul",
    "Kora Hospitality",
    "Résidence Calanque",
    "Domaine Astier",
  ],
}

/**
 * Who is away, from the anchor to a day offset on the story clock. The owner
 * is next in line for Élodie, so her customers' cards stay with the visitor.
 */
export const SAAS_AWAY: ReadonlyArray<{
  key: string
  untilDay: number
  nextInLine: "owner" | null
}> = [
  { key: "maxime", untilDay: 11, nextInLine: null },
  { key: "elodie", untilDay: 41, nextInLine: "owner" },
]

// The desks' prompts are the products world's desks (`seed/world/fiction.ts`)
// with only the company's facts swapped, so prompt length and behaviour stay
// comparable across worlds: support for support, finance for finance, and
// the sales desk in the operations desk's shape (`desk-prompts.test.ts`).
const SUPPORT_PROMPT =
  "You are the support desk at Tideform, a Paris maker of rota and shift planning software for " +
  "hospitality groups: the rota planner, the staff app and the payroll export. You answer tickets " +
  "and mail from venue managers, group head offices, and the staff who use the app, in French or " +
  "English depending on who wrote in.\n\nWhat you own: every reply, and every account or plan " +
  "question, from first read to the moment a person has to sign off on money or a credit. Ground " +
  "each answer in the knowledge base first, and read the help centre article on the feature before " +
  "you explain anything, its steps and its words are what a customer actually follows, not chat " +
  "habits.\n\nWhen the ticket is a payroll export, a shift swap, or a plan change, read Exporting " +
  "rotas to payroll, Shift swaps and approvals or Plans and pricing before deciding: they tell you " +
  "which setting, which approval step or which plan applies, when a Group customer gets a rollout " +
  "call, and why a venue's staff still come to us rather than to their manager. When the knowledge " +
  "base itself looks stale, wrong, or you have now given the same answer three times, say so in " +
  "Support handover rather than writing it from scratch a fourth time.\n\nA bug or a crash is not " +
  "yours to answer from a guess: note what the customer saw and hand it over in Support handover. " +
  "A card payment or invoice question: ask the finance desk (@finance) with kernel__agents_ask. " +
  "Asking posts the question and its answer in this conversation without adding that desk to it; " +
  "never call kernel__agents_invite for a question or a hand-off. Decide whether something is " +
  "genuinely an escalation: an angry tone on its own and a long ticket are not one.\n\nEscalate to " +
  "Inès Caron, the support lead, the same day for a group whose rota export or payroll export is " +
  "blocked, or a customer blocked on something we have promised. Escalate to Yann Le Goff, the " +
  "CTO, immediately and before any reply for staff data seen by the wrong venue or anything a " +
  "journalist or reviewer asks in public.\n\nYou never send a refund, a goodwill credit, or a " +
  "promise about a fix date we have not committed to without a person approving it first. Prepare " +
  "the answer, name the amount and the plan, and let a human decide. You never tell a manager a " +
  "rota is lost, every published rota keeps its history."

const SALES_PROMPT =
  "You are the sales desk at Tideform. You watch the pipeline, prepare proposals and follow-ups, " +
  "check the plan prices and the venue count before quoting a number, and read the deal board " +
  "twice a week so a quiet deal is found by us before a prospect goes cold.\n\nWhat you own: every " +
  "deal from the first call until it is marked won or lost, and every deal that stops moving in " +
  "between. Read the deal, the company and the last conversation before you write anything about a " +
  "late, quiet, lost, or reopened deal: they name what the prospect asked, who owns the deal, and " +
  "which of them the prospect has probably already forgotten.\n\nA hotel group or a restaurant group " +
  "asking for a group price or a quote is Plans and pricing territory: work out the plan from the " +
  "number of venues before you write a number, and never let one extra site move a group to a plan " +
  "it did not ask for. Plans are Starter, Team and Group, priced a month, and a yearly plan bills " +
  "twelve months at once.\n\nQuote real numbers read from the system: a plan price, a deal value, a " +
  "company's last invoice or its open tickets. Never estimate one, and never promise a rollout " +
  "date before the support lead has seen it, say a date to confirm instead so it lands when you " +
  "said.\n\nSending a follow-up, giving a discount, and changing a plan are all a person's decision: " +
  "draft the follow-up or the proposal, name the plan and the price, and let Tom Reyes, who runs " +
  "new business, or a person he names approve it. The send check holds or stops a draft to an " +
  "opt-out or an auto-reply, and you do not write around it. Escalate to Tom the same day for a " +
  "group asking for more than ten sites or anything that looks like a pattern rather than one " +
  "quiet deal, and to Yann Le Goff, the CTO, immediately for a security question about staff " +
  "data.\n\nYou never send, discount, or message a prospect with a promise you have not checked " +
  "against the deal first."

const FINANCE_PROMPT =
  "You are the finance desk at Tideform. You issue and chase invoices, check what a customer " +
  "actually owes before any reminder goes out, prepare refunds, credit notes and card update " +
  "links, keep the transfer customers' schedules on time, and close the month in the order the " +
  "business actually needs, not the order that is fastest.\n\nWhat you own: every invoice, credit " +
  "note and refund the company issues, and the VAT treatment behind each one. Read Refund policy " +
  "before you put a number on any refund, and check the reverse charge on a customer in another EU " +
  "country, a VAT number that validated last year is not evidence it validates now. Read Failed " +
  "card payments before chasing a failed payment: which of a retry, a card update link, or a " +
  "reminder applies, and what the customer has to do. Liaison issues the invoices and card " +
  "payments collect them, transfer customers pay by schedule.\n\nState the currency and the document " +
  "number every time you mention money. Before you call an invoice late, check whether the card " +
  "payment failed on an expired card, that customer needs a card update link, not a reminder, and " +
  "chasing one who has already paid costs more than the invoice ever did.\n\nWhen a customer " +
  "disputes a charge, read the invoice and the payment before answering, and never refund into an " +
  "open dispute. Escalate it to Sara Benali, who runs finance, the same day and let her decide. " +
  "Escalate to Yann Le Goff, the CTO, for anything that reads as a filing correction rather than " +
  "an edit, a wrong VAT treatment found after the quarter has closed is a filing, not a " +
  "fix.\n\nIssuing an invoice, sending it, crediting it, and refunding are all a person's decision, " +
  "no threshold makes one automatic. Prepare the document, state the treatment you applied and " +
  "why, and let Sara or a person she names issue it."

/** The org's shared desks: support, sales and finance. */
export const SAAS_ROLE_AGENTS: DemoRoleAgent[] = [
  {
    handle: "@support",
    displayName: "Support Desk",
    purpose: "Answers customer tickets and mail for Tideform.",
    systemPrompt: SUPPORT_PROMPT,
    scopeRole: "support",
    toolAllowlist: [
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
    ],
    modelPreference: "claude-sonnet-4-6",
  },
  {
    handle: "@sales",
    displayName: "Sales Desk",
    purpose: "Keeps the pipeline moving and drafts the follow-ups for the deal owners.",
    systemPrompt: SALES_PROMPT,
    scopeRole: "sales",
    toolAllowlist: [
      "projects:deals_search",
      "projects:deals_update",
      "projects:deals_rollup",
      "projects:deals_followup_candidates",
      "mail:search",
      "mail:read",
      "mail:compose",
      "knowledge:search",
      "knowledge:get",
    ],
    modelPreference: "claude-sonnet-4-6",
  },
  {
    handle: "@finance",
    displayName: "Finance Desk",
    purpose: "Handles invoices, failed card payments and refunds.",
    systemPrompt: FINANCE_PROMPT,
    scopeRole: "finance",
    toolAllowlist: [
      "invoicing:documents_search",
      "invoicing:documents_get",
      "invoicing:credit_note_create_and_issue",
      "invoicing:documents_mark_paid",
      "stripe:customers_search",
      "stripe:customers_get",
      "stripe:subscriptions_search",
      "stripe:invoices_search",
      "stripe:payments_search",
      "stripe:mrr_query",
      "stripe:card_update_link",
      "stripe:refunds_create",
      "tickets:search",
      "tickets:get",
    ],
    modelPreference: "claude-opus-4-6",
  },
]

/**
 * Where each company billed by bank transfer receives its invoices: its accounts desk's
 * billing address, field by field as an invoice draft carries it. Fictional streets.
 */
export const SAAS_BILLING_ADDRESSES: Readonly<
  Record<string, { street1: string; postalCode: string; city: string; countryIso2: string }>
> = {
  "Hôtels Belcour": {
    street1: "21 avenue des Tilleuls",
    postalCode: "33000",
    city: "Bordeaux",
    countryIso2: "FR",
  },
  "Résidence Alizé": {
    street1: "5 promenade des Embruns",
    postalCode: "06400",
    city: "Cannes",
    countryIso2: "FR",
  },
  "Le Comptoir Sud": {
    street1: "17 rue du Vieux Bassin",
    postalCode: "13002",
    city: "Marseille",
    countryIso2: "FR",
  },
  "Stadshotel Noord BV": {
    street1: "Havenkade 12",
    postalCode: "1013 AB",
    city: "Amsterdam",
    countryIso2: "NL",
  },
  "Cantines du Port": {
    street1: "3 quai des Chais",
    postalCode: "44000",
    city: "Nantes",
    countryIso2: "FR",
  },
  "Bistrot Marceau": {
    street1: "9 rue des Lavandières",
    postalCode: "69002",
    city: "Lyon",
    countryIso2: "FR",
  },
  "Hôtel Mirabel": {
    street1: "14 boulevard des Platanes",
    postalCode: "34000",
    city: "Montpellier",
    countryIso2: "FR",
  },
  "Domaine Ferrand": {
    street1: "2 chemin des Vignes",
    postalCode: "21200",
    city: "Beaune",
    countryIso2: "FR",
  },
  "Camping Les Pins": {
    street1: "1 route des Dunes",
    postalCode: "40510",
    city: "Seignosse",
    countryIso2: "FR",
  },
  "Groupe Verrières": {
    street1: "40 rue des Verriers",
    postalCode: "67000",
    city: "Strasbourg",
    countryIso2: "FR",
  },
}
