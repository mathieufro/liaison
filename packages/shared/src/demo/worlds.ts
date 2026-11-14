// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The demo worlds: the example companies a demo workspace can hold, and
 * everything keyed by them. Ids only, no fiction: each world's company, people
 * and copy live in its seed pack.
 *
 * `products` is the world every demo had before there were several, and the
 * one an unknown, missing or disabled world reads as. Each world shows seven
 * needs in tile order, the same as `products` with its own need in commerce's
 * seat. Its scenario tours are `kernel.scenario-<need>` in `products` and
 * `kernel.scenario-<world>-<need>` elsewhere.
 */
import { DEMO_NEED_SPECS, type DemoNeed, type DemoNeedSpec, type DemoScenarioTourId } from "./needs"

export const DEMO_WORLDS = ["products", "saas", "studio"] as const

export type DemoWorldId = (typeof DEMO_WORLDS)[number]

/** The world of every demo that names none, or names one this deployment does not run. */
export const DEMO_DEFAULT_WORLD = "products" satisfies DemoWorldId

/** Each world's needs, in tile order. */
export const DEMO_WORLD_NEEDS: Readonly<Record<DemoWorldId, readonly DemoNeed[]>> = {
  products: ["support", "projects", "chat", "sales", "commerce", "dev", "knowledge"],
  saas: ["support", "projects", "chat", "sales", "money", "dev", "knowledge"],
  studio: ["support", "projects", "chat", "sales", "client", "dev", "knowledge"],
}

export function isDemoWorldId(value: unknown): value is DemoWorldId {
  return typeof value === "string" && (DEMO_WORLDS as readonly string[]).includes(value)
}

/** A stored or received world id, read as `products` when it is not one. */
export function demoWorldIdOf(value: unknown): DemoWorldId {
  return isDemoWorldId(value) ? value : DEMO_DEFAULT_WORLD
}

/** The scenario tour that shows `need` in `world`. */
export function demoScenarioTourId(world: DemoWorldId, need: DemoNeed): DemoScenarioTourId {
  return world === "products" ? `kernel.scenario-${need}` : `kernel.scenario-${world}-${need}`
}

/** What `need` turns into in `world`: its scenario tour there, its apps and its seed parts. */
export function demoNeedSpec(world: DemoWorldId, need: DemoNeed): DemoNeedSpec {
  return { ...DEMO_NEED_SPECS[need], scenarioTourId: demoScenarioTourId(world, need) }
}

/** The need a demo scenario tour of any world shows, or null for any other tour. */
export function scenarioNeedOf(tourId: string): DemoNeed | null {
  for (const world of DEMO_WORLDS) {
    for (const need of DEMO_WORLD_NEEDS[world]) {
      if (demoScenarioTourId(world, need) === tourId) return need
    }
  }
  return null
}
