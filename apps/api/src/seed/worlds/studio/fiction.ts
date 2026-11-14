// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `studio` world's company: Halden Studio, a Lyon software services firm
// of 24 people that builds and runs systems for its clients, billed by the
// day, by the hour on a retainer, or at a fixed price per project. Its team,
// its clients and the contacts its named rows name.
//
// The privacy rules of `seed/world/fiction.ts` hold here too: every address
// outside the org is on a reserved `.example` domain, the declared VAT number
// and the IBAN have an all-zero body, and nothing names a real company or
// person. Nothing in this file is a date: every instant the pack writes is a
// role on the story clock (`../story-clock.ts`), computed by `plan.ts`.
//
// The owner's seat is the visitor's (a co-founder), so no person here holds
// the owner's name. Léa Fontaine, the other co-founder, holds the founder's
// admin role.
import type {
  DemoCompany,
  DemoCustomer,
  DemoPerson,
  DemoRole,
  DemoWorld,
} from "../../world/fiction"

/** The reserved domain the team lives under, one label per org below it. */
export const STUDIO_EMAIL_DOMAIN = "haldenstudio.example"

export const STUDIO_COMPANY: DemoCompany = {
  name: "Halden Studio",
  legalName: "Halden Studio SAS",
  vat: "FR00000000000",
  about:
    "Halden Studio builds and runs software for its clients: partner portals, data pipelines, " +
    "dashboards and the upkeep that follows. Billed by the day, on a monthly retainer or at a " +
    "fixed price per project, from Lyon, by a team of 24.",
  addressLine1: "14 quai des Tanneurs",
  postalCode: "69002",
  city: "Lyon",
  country: "FR",
  iban: "FR0000000000000000000000000",
  swiftBic: "HLDNFRPPXXX",
  bankName: "Banque des Tanneurs",
  supportEmail: `support@${STUDIO_EMAIL_DOMAIN}`,
  billingEmail: `billing@${STUDIO_EMAIL_DOMAIN}`,
  salesEmail: `sales@${STUDIO_EMAIL_DOMAIN}`,
  websiteUrl: `https://www.${STUDIO_EMAIL_DOMAIN}`,
  defaultCurrency: "EUR",
}

/** Hours in the studio's working day, in minutes. */
export const STUDIO_HOURS_PER_DAY_MINUTES = 7 * 60

const person = (
  key: string,
  name: string,
  jobTitle: string,
  role: DemoRole,
  bio: string,
): DemoPerson => ({ key, name, jobTitle, role, email: `${key}@${STUDIO_EMAIL_DOMAIN}`, bio })

/**
 * The ten people of delivery who carry planned work, by person key. They are
 * the people capacity lists, and the only ones with a cost rate.
 */
export const STUDIO_DELIVERY_KEYS = [
  "bastien",
  "clara",
  "emma",
  "hugo",
  "lina",
  "mathis",
  "nadia",
  "paul",
  "sofia",
  "yanis",
] as const

export type StudioDeliveryKey = (typeof STUDIO_DELIVERY_KEYS)[number]

/**
 * The 23 people beside the owner. With the owner's seat that is the 24 the
 * door names: the owner, Léa, the ten of delivery and finance are the 13 a
 * board names; the other 11 hold no planned work this period. Order is the
 * directory's.
 */
export const STUDIO_TEAM: DemoPerson[] = [
  person(
    "lea",
    "Léa Fontaine",
    "Co-founder",
    "founder_admin",
    "Co-founded the studio and signs the agreements. Holds the keys to the workspace's settings.",
  ),
  person(
    "bastien",
    "Bastien Morel",
    "Project Lead",
    "ops_lead",
    "Leads delivery: plans the work, watches who has room next week and talks to clients when scope moves.",
  ),
  person(
    "clara",
    "Clara Meunier",
    "Developer",
    "fulfillment",
    "Builds back ends and exports for insurance and logistics clients.",
  ),
  person(
    "emma",
    "Emma Giraud",
    "Developer",
    "fulfillment",
    "Works on route planning and keeps the publisher's reader site running.",
  ),
  person(
    "hugo",
    "Hugo Tran",
    "Developer",
    "fulfillment",
    "Builds data feeds and the integrations around them.",
  ),
  person(
    "lina",
    "Lina Besson",
    "Developer",
    "fulfillment",
    "Builds member portals and their sign-in.",
  ),
  person(
    "mathis",
    "Mathis Aubry",
    "Developer",
    "fulfillment",
    "Works on connectors, test data and the cooperative's stock exports.",
  ),
  person(
    "nadia",
    "Nadia Kerroum",
    "Lead Developer",
    "fulfillment",
    "Leads the developers on the partner portal and reviews most pull requests.",
  ),
  person(
    "paul",
    "Paul Arnaud",
    "Developer",
    "fulfillment",
    "Works on rollouts and member sign-in.",
  ),
  person(
    "sofia",
    "Sofia Lind",
    "Data Engineer",
    "fulfillment",
    "Designs data models, imports and dashboards.",
  ),
  person(
    "yanis",
    "Yanis Belkacem",
    "Developer",
    "fulfillment",
    "Writes business rules and the checks on the data behind them.",
  ),
  person(
    "anais",
    "Anaïs Colin",
    "Finance",
    "finance",
    "Runs billing and the books: invoices, retainers, payments and the month end.",
  ),
  person(
    "romain",
    "Romain Pélissier",
    "Sales",
    "sales",
    "Runs new business: briefs, proposals and the pipeline.",
  ),
  person(
    "sarah",
    "Sarah Ouali",
    "Sales",
    "sales",
    "Looks after clients once they sign: renewals and the next piece of work.",
  ),
  person(
    "manon",
    "Manon Leclerc",
    "Designer",
    "fulfillment",
    "Designs interfaces and the screens clients sign off.",
  ),
  person(
    "victor",
    "Victor Hamon",
    "Designer",
    "fulfillment",
    "Designs interfaces and covers for Manon when she is away.",
  ),
  person(
    "noemie",
    "Noémie Garnier",
    "QA",
    "support",
    "Tests releases and answers the questions clients send about them.",
  ),
  person(
    "adil",
    "Adil Rahmani",
    "QA",
    "support",
    "Tests releases and keeps the test environments in shape.",
  ),
  person(
    "gaspard",
    "Gaspard Roche",
    "Operations",
    "support",
    "Runs the studio's own systems: laptops, accounts and the build machines.",
  ),
  person(
    "salome",
    "Salomé Petit",
    "Operations",
    "support",
    "Runs the office, the rota and the new starters' first week.",
  ),
  person(
    "julien",
    "Julien Marchetti",
    "Junior Developer",
    "fulfillment",
    "Joined delivery recently and pairs with the developers.",
  ),
  person(
    "tristan",
    "Tristan Bard",
    "Junior Developer",
    "fulfillment",
    "Joined delivery recently and pairs with the developers.",
  ),
  person(
    "maelle",
    "Maëlle Lopez",
    "Junior Developer",
    "fulfillment",
    "Joined delivery recently and pairs with the data engineer.",
  ),
]

/** A client company and its contacts. */
export interface StudioClient {
  key: string
  name: string
  /** Its reserved `.example` domain. */
  domain: string
  /** Customer keys of its contacts. */
  contactKeys: string[]
}

export const STUDIO_CLIENTS: StudioClient[] = [
  {
    key: "marlin",
    name: "Groupe Marlin",
    domain: "groupe-marlin.example",
    contactKeys: ["pauline-gros", "remi-castel"],
  },
  {
    key: "sorel",
    name: "Éditions Sorel",
    domain: "editions-sorel.example",
    contactKeys: ["thomas-blanc"],
  },
  {
    key: "alpine",
    name: "Coopérative Alpine",
    domain: "cooperative-alpine.example",
    contactKeys: ["ines-royer"],
  },
  {
    key: "tessier",
    name: "Tessier Logistique",
    domain: "tessier-logistique.example",
    contactKeys: ["jean-tessier"],
  },
  {
    key: "verdier",
    name: "Verdier Transports",
    domain: "verdier-transports.example",
    contactKeys: ["marc-verdier"],
  },
  {
    key: "rhone",
    name: "Rhône Mutuelle",
    domain: "rhone-mutuelle.example",
    contactKeys: ["helene-faure"],
  },
]

const contact = (key: string, name: string, client: string, local: string): DemoCustomer => {
  const domain = STUDIO_CLIENTS.find((c) => c.key === client)?.domain
  if (!domain) throw new Error(`studio fiction: no client '${client}'`)
  return { key, name, email: `${local}@${domain}`, country: "FR", isVip: false }
}

/** The clients' people the studio deals with. */
export const STUDIO_CONTACTS: DemoCustomer[] = [
  contact("pauline-gros", "Pauline Gros", "marlin", "pauline"),
  contact("remi-castel", "Rémi Castel", "marlin", "remi.castel"),
  contact("thomas-blanc", "Thomas Blanc", "sorel", "thomas.blanc"),
  contact("ines-royer", "Inès Royer", "alpine", "ines.royer"),
  contact("jean-tessier", "Jean Tessier", "tessier", "jean"),
  contact("marc-verdier", "Marc Verdier", "verdier", "marc"),
  contact("helene-faure", "Hélène Faure", "rhone", "helene.faure"),
]

export const STUDIO_WORLD: DemoWorld = {
  company: STUDIO_COMPANY,
  catalog: [],
  team: STUDIO_TEAM,
  dealers: [],
  customers: STUDIO_CONTACTS,
}

/**
 * Who is away, by week on the story clock: Manon this week and next, with
 * Victor next in line. She holds no planned work, so no capacity figure moves.
 */
export const STUDIO_AWAY: ReadonlyArray<{
  key: string
  /** Weeks from this week's Monday: 0 is this week. */
  fromWeek: number
  /** Through the Sunday of this week offset. */
  throughWeek: number
  nextInLine: string
}> = [{ key: "manon", fromWeek: 0, throughWeek: 1, nextInLine: "victor" }]
