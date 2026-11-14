// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  DEMO_DEFAULT_WORLD,
  DEMO_NEED_SPECS,
  DEMO_WORLD_NEEDS,
  type DemoNeed,
  type DemoSeedPart,
  type DemoWorldId,
} from "@liaison/shared"

/**
 * The demo app surface. `ads`, `calls` and `kpi` are excluded on purpose: one
 * bills real ad spend, one needs telephony, and `kpi` is a client for an
 * external KPI service no demo org has (it offered a tab and tools that could
 * only fail). Catalog apps are installed from the baked `.liaisonapp` bundles;
 * in-tree apps (tickets, mail, knowledge, projects, calendar, contacts) are
 * enable-only, exactly as the provisioning CLI treats them.
 */
export const DEMO_APPS = [
  "tickets",
  "mail",
  "knowledge",
  "projects",
  "calendar",
  "contacts",
  "invoicing",
  "social",
  "pennylane",
  "boxtal",
  "shopify",
  "monitoring",
  "api-connector",
  "stripe",
] as const

export type DemoApp = (typeof DEMO_APPS)[number]

/**
 * The demo apps each world can show. `products` keeps the list it always had
 * (no payments app); `saas` sells subscriptions, so it has the payments app and
 * no shop, carrier, books, monitoring, social or connector. `studio` holds the
 * shared desk apps until its own pack brings the client-work apps.
 */
export const DEMO_WORLD_APPS: Readonly<Record<DemoWorldId, readonly DemoApp[]>> = {
  products: DEMO_APPS.filter((app) => app !== "stripe"),
  saas: ["tickets", "mail", "knowledge", "projects", "calendar", "contacts", "invoicing", "stripe"],
  studio: ["tickets", "mail", "knowledge", "projects", "calendar", "contacts", "invoicing"],
}

/**
 * The demo apps a world's picks switch On or Off. `products` governs its own
 * apps only, as it always has. The other worlds govern every demo app: they
 * share a box with `products`, whose apps would otherwise show in them.
 */
function governedApps(world: DemoWorldId): readonly DemoApp[] {
  return world === "products" ? DEMO_WORLD_APPS.products : DEMO_APPS
}

/**
 * Apps a tailored seed always installs (the baseline world: people, contacts,
 * knowledge, calendar, threads), whatever the visitor picked.
 */
export const DEMO_BASELINE_APPS = ["mail", "knowledge", "contacts", "calendar"] as const

/**
 * Each world's baseline: the apps its story needs whatever the visitor picked.
 * The software company's sales deals sit on the Projects board and its team
 * plans product work there, so its door and company pages point into Projects:
 * it stays On for every software visitor.
 */
export const DEMO_WORLD_BASELINE_APPS: Readonly<Record<DemoWorldId, readonly string[]>> = {
  products: DEMO_BASELINE_APPS,
  saas: [...DEMO_BASELINE_APPS, "projects"],
  studio: [...DEMO_BASELINE_APPS, "projects"],
}

/**
 * The commerce layer writes the shop, its invoices, the carrier, the books and
 * the monitoring rail together, so the commerce need installs all of them.
 */
export const COMMERCE_LAYER_APPS = [
  "shopify",
  "invoicing",
  "boxtal",
  "pennylane",
  "monitoring",
] as const

/** What one seed writes: its apps, its optional world parts, whether it is tailored. */
export interface DemoSeedPlan {
  /** A visitor's picks drove it (scenario routines, the visitor's task, filtered approvals). */
  tailored: boolean
  apps: readonly string[]
  /**
   * Demo apps the visitor did not pick, turned Off in their workspace
   * (`kernel.apps.status = 'disabled'`: no nav entry, no agent tools, no
   * jobs). Apps are registered for the whole deployment, so turning them Off
   * is what makes the picks decide what a visitor sees. Empty for Everything
   * and untailored seeds.
   */
  offApps: readonly string[]
  parts: ReadonlySet<DemoSeedPart>
  /**
   * Opt-in parts the picks asked for that this deployment has switched off
   * (see `DemoSeedPlanOptions`). Named so the seed's log and result say what
   * was left out on purpose, instead of a part that silently never ran.
   */
  partsOff: readonly DemoSeedPart[]
}

/**
 * The parts a deployment opts into explicitly, never by detection. Every other
 * part is always on, and its failure is an error.
 */
export interface DemoSeedPlanOptions {
  /**
   * The read-only analytics warehouse behind the `database` connector. It
   * needs a dedicated login and a privileged DSN only some deployments have
   * (`LIAISON_DEMO_WAREHOUSE`), so it is off unless the deployment turns it
   * on. On, its failure is an error like any other part's.
   */
  warehouse: boolean
}

/** Parts that run only when the deployment opts in (`DemoSeedPlanOptions`). */
export const OPT_IN_PARTS = ["warehouse"] as const satisfies readonly DemoSeedPart[]

/** Every part a world's needs can seed, in tile order. */
function allParts(world: DemoWorldId): Set<DemoSeedPart> {
  return new Set(DEMO_WORLD_NEEDS[world].flatMap((n) => DEMO_NEED_SPECS[n].seedParts))
}

/**
 * The seed a list of needs asks for, in a world (`products` when none is
 * named). No needs: the whole world, untailored (the reserved org and the
 * nightly reset). All of the world's needs ("Everything"): the whole world with
 * every scenario's extras. Otherwise the baseline plus each need's apps and
 * parts, kept to the world's own apps.
 */
export function demoSeedPlan(
  needs: readonly DemoNeed[] | undefined,
  opts: DemoSeedPlanOptions,
  world: DemoWorldId = DEMO_DEFAULT_WORLD,
): DemoSeedPlan {
  const plan = needsPlan(world, needs)
  const off = new Set<DemoSeedPart>(opts.warehouse ? [] : ["warehouse"])
  const parts = new Set([...plan.parts].filter((p) => !off.has(p)))
  const partsOff = OPT_IN_PARTS.filter((p) => off.has(p) && plan.parts.has(p))
  return { ...plan, parts, partsOff }
}

function needsPlan(
  world: DemoWorldId,
  needs: readonly DemoNeed[] | undefined,
): Omit<DemoSeedPlan, "partsOff"> {
  const worldApps = DEMO_WORLD_APPS[world]
  const governed = governedApps(world)
  const whole = (tailored: boolean) => ({
    tailored,
    apps: worldApps,
    offApps: governed.filter((app) => !worldApps.includes(app)),
    parts: allParts(world),
  })
  if (!needs) return whole(false)
  const picked = new Set(needs)
  if (DEMO_WORLD_NEEDS[world].every((n) => picked.has(n))) return whole(true)
  const apps = new Set<string>(DEMO_WORLD_BASELINE_APPS[world])
  const parts = new Set<DemoSeedPart>()
  for (const need of needs) {
    for (const app of DEMO_NEED_SPECS[need].apps) apps.add(app)
    for (const part of DEMO_NEED_SPECS[need].seedParts) parts.add(part)
    if (need === "commerce") for (const app of COMMERCE_LAYER_APPS) apps.add(app)
  }
  // Installed in the order of `DEMO_APPS`, so two plans with the same apps install alike.
  const ordered = worldApps.filter((app) => apps.has(app))
  const offApps = governed.filter((app) => !ordered.includes(app))
  return { tailored: true, apps: ordered, offApps, parts }
}
