// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the demo door says about the company a workspace is a copy of. The
// seed's own literals live in apps/api/src/seed/world/fiction.ts, which the web bundle does
// not import, so the few the door names are restated here and in the
// `kernel.demo.company*` / `kernel.demo.team*` strings, and
// door-company.test.ts pins both to the seed.

/** The name of the fictional company every demo workspace is seeded with. */
export const DEMO_COMPANY_NAME = "Resonant Audio Labs"

/**
 * The teammates the door lists under "The team", in the seed's order, keyed
 * like `DEMO_TEAM`. The founder is left out: the visitor is the CEO.
 */
export const DEMO_DOOR_TEAM = [
  { key: "tobias", name: "Tobias Braun" },
  { key: "amina", name: "Amina Cherif" },
  { key: "lucas", name: "Lucas Pereira" },
  { key: "margot", name: "Margot Dufour" },
  { key: "henrik", name: "Henrik Sandberg" },
  { key: "giulia", name: "Giulia Ferrari" },
] as const

/** The six parts of the company's operations, each with the app it runs in. */
export const DEMO_DOOR_OPS = [
  { key: "support", app: "tickets" },
  { key: "orders", app: "shopify" },
  { key: "invoicing", app: "invoicing" },
  { key: "sales", app: "crm" },
  { key: "projects", app: "projects" },
  { key: "knowledge", app: "knowledge" },
] as const

/** The worlds whose company the door describes (a world with no entry here reads as `products`). */
export type DoorWorldId = "products" | "saas"

/** One part of a company's operations: its row key and the app whose colour it wears. */
export interface DoorOp {
  key: string
  app: string
}

/** One teammate the door lists, keyed like the world's `teamRole` strings. */
export interface DoorPerson {
  key: string
  name: string
}

/**
 * What the door says about each world's company. Strings live under
 * `copyKey`: `kernel.demo` for `products` (its keys are the ones it always
 * had), `kernel.demo.world.<world>` for the others, with `companyFacts`,
 * `companyAbout`, `companyOps.<key>`, `companyYou`, `companySimulated`,
 * `companyExample` and `teamRole.<key>` beneath it. door-company.test.ts pins each
 * world to its seed pack, which the web bundle never imports.
 */
export interface DoorCompany {
  name: string
  initials: string
  opsList: readonly DoorOp[]
  /** The teammates listed under "The team", after the visitor's own line. */
  team: readonly DoorPerson[]
  copyKey: string
}

/** The software company: Tideform, whose seat of CEO the visitor takes. */
export const DEMO_SAAS_COMPANY_NAME = "Tideform"

/** The thirteen teammates beside the visitor, in the pack's order. */
export const DEMO_SAAS_DOOR_TEAM = [
  { key: "tom", name: "Tom Reyes" },
  { key: "elodie", name: "Élodie Renard" },
  { key: "ines", name: "Inès Caron" },
  { key: "yann", name: "Yann Le Goff" },
  { key: "sara", name: "Sara Benali" },
  { key: "lucie", name: "Lucie Vasseur" },
  { key: "baptiste", name: "Baptiste Noël" },
  { key: "amel", name: "Amel Saïdi" },
  { key: "jonas", name: "Jonas Keller" },
  { key: "clemence", name: "Clémence Roy" },
  { key: "nolan", name: "Nolan Faure" },
  { key: "maxime", name: "Maxime Aubert" },
  { key: "rose", name: "Rose Delmas" },
] as const

export const DEMO_DOOR: Readonly<Record<DoorWorldId, DoorCompany>> = {
  products: {
    name: DEMO_COMPANY_NAME,
    initials: "RA",
    opsList: DEMO_DOOR_OPS,
    team: DEMO_DOOR_TEAM,
    copyKey: "kernel.demo",
  },
  saas: {
    name: DEMO_SAAS_COMPANY_NAME,
    initials: "TF",
    opsList: [
      { key: "payments", app: "stripe" },
      { key: "invoicing", app: "invoicing" },
      { key: "support", app: "tickets" },
      { key: "sales", app: "crm" },
      { key: "product", app: "projects" },
      { key: "knowledge", app: "knowledge" },
    ],
    team: DEMO_SAAS_DOOR_TEAM,
    copyKey: "kernel.demo.world.saas",
  },
}

/** The company the door describes for `world`: `products` for a world it has no page for. */
export function doorCompanyOf(world: string | null | undefined): DoorCompany {
  return world === "saas" ? DEMO_DOOR.saas : DEMO_DOOR.products
}
