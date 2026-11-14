// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seed split: what a visitor's picks install and write. No picks is the
// whole world, untailored (the reserved org and the nightly reset, unchanged);
// all six is the whole world with every scenario's extras; a subset is the
// baseline plus each pick's apps and parts, and nothing unguided.
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import type { TourBeat } from "@liaison/shared"
import {
  DEMO_ENTRIES,
  DEMO_ENTRY_NEEDS,
  DEMO_NEED_SPECS,
  DEMO_WORLD_NEEDS,
  type DemoNeed,
  isTourAvailable,
  SCENARIO_TOURS,
} from "@liaison/shared"
import { demoShopifyBook } from "~/modules/demo/shopify/fixtures"
import { DEMO_WORLD } from "~/seed/world/fiction"
import en from "../../../../../../packages/shared/src/i18n/locales/en/tours.json"
import fr from "../../../../../../packages/shared/src/i18n/locales/fr/tours.json"
import { DEMO_CONTENT_CATEGORY, demoBoxtalSender, demoShippingProfiles } from "./boxtal-catalog"
import { DEMO_APPS, DEMO_BASELINE_APPS, DEMO_WORLD_APPS, demoSeedPlan } from "./demo-apps"
import { SKILL_SPECS, SUPPORT_SCENARIO_ROUTINE } from "./seed-agent-native"
import { pooledFitPlan } from "./seed-demo"
import { SEEDED_PROJECT_NAMES } from "./seed-support"

/** The needs-driven plan, with every opt-in part on (each test below is about the needs). */
const ON = { warehouse: true }

describe("the door's company question", () => {
  for (const entry of DEMO_ENTRIES.filter((id) => id !== "other")) {
    it(`${entry}: every preselected scenario can run in the world those picks seed`, () => {
      const needs = DEMO_ENTRY_NEEDS[entry]
      const plan = demoSeedPlan(needs, ON)
      for (const need of needs) {
        const tour = SCENARIO_TOURS.find((t) => t.id === DEMO_NEED_SPECS[need].scenarioTourId)
        if (!tour) throw new Error(`no scenario tour for ${need}`)
        expect(
          isTourAvailable(tour, { installedApps: plan.apps, scopes: ["*"], isDemo: true }),
        ).toBe(true)
        for (const app of DEMO_NEED_SPECS[need].apps) expect(plan.offApps).not.toContain(app)
        for (const part of DEMO_NEED_SPECS[need].seedParts) {
          if (part !== "warehouse") expect(plan.parts.has(part)).toBe(true)
        }
      }
    })
  }
})

describe("demoSeedPlan", () => {
  it("no needs: today's world, every app, every part, not tailored", () => {
    const plan = demoSeedPlan(undefined, ON)
    expect(plan.tailored).toBe(false)
    expect(plan.apps).toEqual(DEMO_WORLD_APPS.products)
    for (const need of DEMO_WORLD_NEEDS.products) {
      for (const part of DEMO_NEED_SPECS[need].seedParts) expect(plan.parts.has(part)).toBe(true)
    }
  })

  it("everything (all six, any order): every app and part, tailored", () => {
    const plan = demoSeedPlan([...DEMO_WORLD_NEEDS.products].reverse(), ON)
    expect(plan.tailored).toBe(true)
    expect(plan.apps).toEqual(DEMO_WORLD_APPS.products)
    expect(plan.parts).toEqual(demoSeedPlan(undefined, ON).parts)
  })

  it.each(DEMO_WORLD_NEEDS.products.map((n) => [n]))(
    "%s alone: baseline + its own apps and parts",
    (need) => {
      const plan = demoSeedPlan([need as DemoNeed], ON)
      const spec = DEMO_NEED_SPECS[need as DemoNeed]
      for (const app of [...DEMO_BASELINE_APPS, ...spec.apps]) expect(plan.apps).toContain(app)
      expect([...plan.parts].sort()).toEqual([...spec.seedParts].sort())
      // Unguided apps (social) only with Everything.
      expect(plan.apps).not.toContain("social")
      // Every app installed is a demo app, in the demo order.
      expect(plan.apps).toEqual(DEMO_APPS.filter((a) => plan.apps.includes(a)))
    },
  )

  it("support alone installs no shop, no projects; commerce installs the whole commerce layer", () => {
    const support = demoSeedPlan(["support"], ON)
    expect(support.apps).toContain("tickets")
    expect(support.apps).not.toContain("shopify")
    expect(support.apps).not.toContain("projects")
    const commerce = demoSeedPlan(["commerce"], ON)
    for (const app of ["shopify", "invoicing", "boxtal", "pennylane", "monitoring"]) {
      expect(commerce.apps).toContain(app)
    }
    expect(commerce.apps).not.toContain("tickets")
  })

  it("turns Off exactly the demo apps not picked; Everything and an untailored seed none", () => {
    const plan = demoSeedPlan(["chat", "projects", "support", "sales"], ON)
    expect([...plan.offApps].sort()).toEqual(
      DEMO_WORLD_APPS.products.filter((a) => !plan.apps.includes(a)).sort(),
    )
    for (const app of ["shopify", "boxtal", "monitoring", "social", "pennylane"]) {
      expect(plan.offApps).toContain(app)
    }
    // Sales quotes from invoicing (its routine's one request: record, quote, reply).
    expect(plan.apps).toContain("invoicing")
    expect(demoSeedPlan([...DEMO_WORLD_NEEDS.products], ON).offApps).toEqual([])
    expect(demoSeedPlan(undefined, ON).offApps).toEqual([])
  })
})

/**
 * The demo apps a scenario beat uses: the app of the event it waits on, of the
 * approval tool it matches (`tickets:reply`), of its optional app, and of the
 * screen it routes to (`/projects/...`).
 */
function appsUsedBy(beat: TourBeat): string[] {
  const used = new Set<string>()
  const demo = new Set<string>(DEMO_APPS)
  if (beat.event && beat.event.app !== "kernel") used.add(beat.event.app)
  const tool = beat.event?.match?.toolName
  if (typeof tool === "string" && tool.includes(":")) used.add(tool.split(":")[0] as string)
  if (beat.optional?.whenApp) used.add(beat.optional.whenApp)
  for (const route of [beat.route, beat.routePhone]) {
    const first = route?.split("/")[1]
    if (first && demo.has(first)) used.add(first)
  }
  return [...used].filter((app) => demo.has(app))
}

// Walk D65: a Team chat-only visit had no Projects app, so its "Turn it into a
// task" step could never finish. Every scenario's steps use only apps its own
// need installs, picked alone.
describe("demoSeedPlan: opt-in parts", () => {
  it("the warehouse is seeded only when the deployment turns it on, and named when it is off", () => {
    for (const needs of [undefined, [...DEMO_WORLD_NEEDS.products], ["commerce"] as DemoNeed[]]) {
      const on = demoSeedPlan(needs, { warehouse: true })
      const off = demoSeedPlan(needs, { warehouse: false })
      expect(on.parts.has("warehouse")).toBe(true)
      expect(on.partsOff).toEqual([])
      expect(off.parts.has("warehouse")).toBe(false)
      expect(off.partsOff).toEqual(["warehouse"])
      // Nothing else moves: the same apps, the same other parts.
      expect(off.apps).toEqual(on.apps)
      expect([...off.parts, "warehouse"].sort()).toEqual([...on.parts].sort())
    }
  })

  it("a plan whose picks never asked for the warehouse has nothing off", () => {
    expect(demoSeedPlan(["support"], { warehouse: false }).partsOff).toEqual([])
  })
})

describe("each scenario picked alone", () => {
  it.each(DEMO_WORLD_NEEDS.products.map((n) => [n]))(
    "%s: its steps use only the apps it installs",
    (need) => {
      const tour = SCENARIO_TOURS.find(
        (t) => t.id === DEMO_NEED_SPECS[need as DemoNeed].scenarioTourId,
      )
      expect(tour).toBeDefined()
      const installed = new Set(demoSeedPlan([need as DemoNeed], ON).apps)
      const missing = (tour?.beats ?? []).flatMap((beat) =>
        appsUsedBy(beat)
          .filter((app) => !installed.has(app))
          .map((app) => `${beat.id}: ${app}`),
      )
      expect(missing).toEqual([])
    },
  )

  it("Team chat seeds a project for its task to go in, and not the Projects scenario's task", () => {
    const chat = demoSeedPlan(["chat"], ON)
    expect(chat.parts.has("projects")).toBe(true)
    expect(chat.parts.has("scenario-task")).toBe(false)
    expect(demoSeedPlan(["projects"], ON).parts.has("scenario-task")).toBe(true)
  })
})

// Walk D39: the Projects app tour asked for "our product launch" as a project,
// the seeded world already holds the "Kestrel Field Preamp launch" project, so
// the agent reused it, created nothing, and the beat (a project created) never
// completed. The tour asks for a project no seeded world holds.
describe("the Projects app tour on a seeded demo world", () => {
  it("asks for a new project the seed does not hold, in every language", () => {
    for (const copy of [en, fr]) {
      const ask = copy.projects.basics.askPlan.text.toLowerCase()
      for (const name of SEEDED_PROJECT_NAMES) {
        expect(ask).not.toContain(name.toLowerCase())
        // Not even its theme: the agent matches "a launch" to the seeded launch.
        const theme = name.toLowerCase().split(" ").at(-1) ?? ""
        expect(ask).not.toContain(theme)
      }
      expect(ask).not.toContain("lancement")
    }
  })
})

// Walk D66: no project seemed to fit the battery passport task, so the agent
// staged a new board instead of filing the task. The follow-up names a project
// Team chat's own seed holds.
describe("Team chat's task goes in a seeded project", () => {
  it("the follow-up names a project the seed holds, in every language", () => {
    expect(demoSeedPlan(["chat"], ON).parts.has("projects")).toBe(true)
    for (const copy of [en, fr]) {
      const ask = copy.scenarios.chat.followUp.text
      expect(SEEDED_PROJECT_NAMES.some((name) => ask.includes(name))).toBe(true)
    }
  })
})

// Walk 5 (D41): the commerce scenario's live order could not be shipped. Its
// line is keyed to the demo store's own variant, which no seeded shipping
// profile named (they used the catalog's placeholder ids), so the shipment
// draft had no parcel and its customs line no weight.
describe("the demo store's products ship from the seeded Boxtal catalog", () => {
  it("every store variant, the live order's included, has a profile with a weight and a parcel", () => {
    const profiles = demoShippingProfiles(DEMO_WORLD.catalog)
    const book = demoShopifyBook(Date.parse("2026-10-24T08:00:00Z"))
    const byVariant = new Map(profiles.map((p) => [p.product_id, p]))
    const variants = book.products.flatMap((p) => p.variants)
    expect(variants.length).toBeGreaterThan(0)
    for (const variant of variants) {
      const profile = byVariant.get(variant.id)
      expect(profile, `${variant.sku} (${variant.id})`).toBeDefined()
      expect(profile?.product_source).toBe("shopify")
      expect(profile?.unit_weight).toBe(variant.weightKg)
      // A physical item ships alone in a parcel of its own size.
      if (variant.sku !== "RAL-ACC-CARE") {
        for (const d of [profile?.solo_length, profile?.solo_width, profile?.solo_height]) {
          expect(d, variant.sku).toBeGreaterThan(0)
        }
      }
      // The store carries its customs code, which the invoice line takes.
      expect(variant.hsCode).toMatch(/^\d{6,10}$/)
    }
    const preamp = byVariant.get(variants.find((v) => v.sku === "RAL-FLAG-04")?.id ?? "")
    expect(preamp).toMatchObject({
      unit_weight: 1.8,
      solo_length: 20,
      solo_width: 14,
      solo_height: 6,
    })
  })

  it("every seeded content category is one the Boxtal app accepts (content:v1:<code>)", () => {
    // Boxtal refuses a free-text label (a cotation answers 400 "invalid value").
    const accepted = /^content:v1:\d+$/
    expect(DEMO_CONTENT_CATEGORY).toMatch(accepted)
    for (const p of demoShippingProfiles(DEMO_WORLD.catalog)) {
      expect(p.content_category, p.sku).toMatch(accepted)
    }
  })

  it("the ship-from address is complete, so a quote and a label need nothing more", () => {
    const sender = demoBoxtalSender()
    for (const field of ["company", "email", "phone", "street", "city", "postalCode"] as const) {
      expect(sender[field], field).toBeTruthy()
    }
    expect(sender.countryIsoCode).toBe("FR")
  })
})

// Walk D42: on the Projects screen, the escalation playbook (anchored to
// projects too) was injected whole into "plan a project" turns. Its body is
// tagged with the tickets, contacts and approvals scopes it was written
// under, so the turn counted as having read them and creating the project
// waited for an approval.
describe("the demo's playbooks", () => {
  it("anchor to the screens they are about: none surfaces into a turn about projects", () => {
    const onProjects = SKILL_SPECS.filter((s) => (s.apps ?? []).includes("projects"))
    expect(onProjects.map((s) => s.name)).toEqual([])
  })
})

/**
 * Every products plan, need set by need set, both ways the deployment can set
 * the warehouse: the plan the products world had before there were several.
 */
function productsPlans(plan: typeof demoSeedPlan): string {
  const needs = DEMO_WORLD_NEEDS.products
  const lines: string[] = []
  for (const warehouse of [true, false]) {
    const show = (label: string, picked: DemoNeed[] | undefined) => {
      const p = plan(picked, { warehouse })
      lines.push(
        JSON.stringify([label, warehouse, p.tailored, p.apps, p.offApps, [...p.parts], p.partsOff]),
      )
    }
    show("none", undefined)
    for (let mask = 1; mask < 1 << needs.length; mask++) {
      const picked = needs.filter((_, i) => mask & (1 << i))
      show(picked.join(","), picked)
    }
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex")
}

describe("demoSeedPlan per world", () => {
  it("the products plan is unchanged for every need set", () => {
    const pinned = "6e985cba2097011a5a509818dbdca4b4ebe1b3a54068c0aadb547cc61884d523"
    expect(productsPlans(demoSeedPlan)).toBe(pinned)
    expect(productsPlans((needs, opts) => demoSeedPlan(needs, opts, "products"))).toBe(pinned)
  })

  it("a world installs only its own apps and turns Off every other demo app", () => {
    const saas = demoSeedPlan(undefined, ON, "saas")
    expect(saas.apps).toEqual(DEMO_WORLD_APPS.saas)
    for (const app of ["shopify", "boxtal", "pennylane", "monitoring", "social", "api-connector"]) {
      expect(saas.apps).not.toContain(app)
      expect(saas.offApps).toContain(app)
    }
    expect(saas.parts.has("commerce")).toBe(false)
    expect(saas.parts.has("stripe")).toBe(true)
    // The products world never installs the payments app.
    expect(demoSeedPlan(undefined, ON).apps).not.toContain("stripe")
    expect(demoSeedPlan(["money"], ON).apps).not.toContain("stripe")
  })

  it("a software visitor who picked money gets the payments app, invoicing and the baseline with tickets off, the failed payments routine on and the support routine off", () => {
    const fit = pooledFitPlan(["money"], "saas")
    for (const app of ["stripe", "invoicing", ...DEMO_BASELINE_APPS]) {
      expect(fit.apps).toContain(app)
      expect(fit.offApps).not.toContain(app)
    }
    expect(fit.apps).not.toContain("tickets")
    expect(fit.offApps).toContain("tickets")
    // Only the support scenario's routine is switched Off: every routine the
    // world seeded on (its failed payments routine among them) stays on.
    expect(fit.routinesOff).toEqual([SUPPORT_SCENARIO_ROUTINE])
    const plan = demoSeedPlan(["money"], ON, "saas")
    for (const part of ["stripe", "recurring", "crm"] as const)
      expect(plan.parts.has(part)).toBe(true)
    expect(plan.parts.has("support-routine")).toBe(false)
  })

  it("a software workspace keeps Projects on whatever the picks: its deals board and product work live there", () => {
    const door = DEMO_ENTRY_NEEDS.software
    for (const needs of [
      door,
      ["money", "support", "dev"],
      ["money"],
      ["support"],
      ["dev"],
      ["knowledge"],
    ] as DemoNeed[][]) {
      const fit = pooledFitPlan(needs, "saas")
      expect(fit.apps).toContain("projects")
      expect(fit.offApps).not.toContain("projects")
      expect(demoSeedPlan(needs, ON, "saas").apps).toContain("projects")
    }
    // The products world still turns Projects Off when no pick needs it.
    expect(pooledFitPlan(["support"], "products").offApps).toContain("projects")
  })

  it("a pooled products workspace fits as it always did", () => {
    const fit = pooledFitPlan(["support"], "products")
    expect(fit.offApps).toEqual(demoSeedPlan(["support"], ON).offApps)
    expect(fit.routinesOff).toEqual([])
    expect(pooledFitPlan(["projects"], "products").routinesOff).toEqual([SUPPORT_SCENARIO_ROUTINE])
  })
})
