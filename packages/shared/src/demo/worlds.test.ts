// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { DEMO_ENTRIES, type DemoEntryId, demoWorldOfEntry } from "../validation/demo-entry"
import { DEMO_NEED_SPECS, DEMO_NEEDS, demoNeedsSchema } from "./needs"
import {
  DEMO_WORLD_NEEDS,
  DEMO_WORLDS,
  type DemoWorldId,
  demoNeedSpec,
  demoScenarioTourId,
  demoWorldIdOf,
  isDemoWorldId,
  scenarioNeedOf,
} from "./worlds"

const ENABLEMENTS: readonly (readonly DemoWorldId[])[] = [
  [],
  ["products"],
  ["products", "saas"],
  ["products", "studio"],
  ["products", "saas", "studio"],
]

function expectedWorld(entry: DemoEntryId | null, enabled: readonly DemoWorldId[]): DemoWorldId {
  if (entry === "software" && enabled.includes("saas")) return "saas"
  if (entry === "expertise" && enabled.includes("studio")) return "studio"
  return "products"
}

describe("the demo world registry", () => {
  it("the entry maps to a world only when that world is enabled, and to the products world otherwise", () => {
    for (const enabled of ENABLEMENTS) {
      for (const entry of [...DEMO_ENTRIES, null, undefined]) {
        expect([entry ?? null, enabled, demoWorldOfEntry(entry, enabled)]).toEqual([
          entry ?? null,
          enabled,
          expectedWorld(entry ?? null, enabled),
        ])
      }
    }
  })

  it("every world's scenario tour id maps back to its need", () => {
    const ids = new Set<string>()
    for (const world of DEMO_WORLDS) {
      for (const need of DEMO_WORLD_NEEDS[world]) {
        const id = demoScenarioTourId(world, need)
        expect(id).toBe(
          world === "products" ? `kernel.scenario-${need}` : `kernel.scenario-${world}-${need}`,
        )
        expect(scenarioNeedOf(id)).toBe(need)
        expect(demoNeedSpec(world, need).scenarioTourId).toBe(id)
        ids.add(id)
      }
    }
    expect(ids.size).toBe(DEMO_WORLDS.reduce((n, w) => n + DEMO_WORLD_NEEDS[w].length, 0))
    expect(scenarioNeedOf("kernel.scenario-saas-commerce")).toBeNull()
    expect(scenarioNeedOf("kernel.scenario-money")).toBeNull()
    expect(scenarioNeedOf("kernel.welcome")).toBeNull()
  })

  it("keeps the products world's needs and tour ids as they were", () => {
    expect(DEMO_WORLD_NEEDS.products).toEqual([
      "support",
      "projects",
      "chat",
      "sales",
      "commerce",
      "dev",
      "knowledge",
    ])
    for (const need of DEMO_WORLD_NEEDS.products) {
      expect(DEMO_NEED_SPECS[need].scenarioTourId).toBe(`kernel.scenario-${need}`)
    }
  })

  it("gives every world seven needs, its own in commerce's seat", () => {
    const seat = DEMO_WORLD_NEEDS.products.indexOf("commerce")
    expect(DEMO_WORLD_NEEDS.saas).toEqual(
      DEMO_WORLD_NEEDS.products.map((n, i) => (i === seat ? "money" : n)),
    )
    expect(DEMO_WORLD_NEEDS.studio).toEqual(
      DEMO_WORLD_NEEDS.products.map((n, i) => (i === seat ? "client" : n)),
    )
    for (const world of DEMO_WORLDS) {
      const needs = DEMO_WORLD_NEEDS[world]
      expect(demoNeedsSchema.safeParse([...needs]).success).toBe(true)
      // Tile order: each world's needs keep the order of the full list.
      expect([...needs].sort((a, b) => DEMO_NEEDS.indexOf(a) - DEMO_NEEDS.indexOf(b))).toEqual([
        ...needs,
      ])
    }
    expect(DEMO_NEEDS.length).toBe(9)
  })

  it("the money need installs the payments and invoicing apps and seeds its parts", () => {
    expect(demoNeedSpec("saas", "money")).toEqual({
      scenarioTourId: "kernel.scenario-saas-money",
      apps: ["stripe", "invoicing"],
      seedParts: ["stripe", "recurring", "crm"],
    })
  })

  it("reads an unknown world id as the products world", () => {
    for (const world of DEMO_WORLDS) {
      expect(isDemoWorldId(world)).toBe(true)
      expect(demoWorldIdOf(world)).toBe(world)
    }
    for (const value of ["", "SAAS", "other", 3, null, undefined, {}]) {
      expect(isDemoWorldId(value)).toBe(false)
      expect(demoWorldIdOf(value)).toBe("products")
    }
  })
})
