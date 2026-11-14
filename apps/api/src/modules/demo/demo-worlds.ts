// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which demo worlds this deployment runs: the worlds a visitor's entry can
// lead to, and the worlds the warm pool keeps workspaces of.
//
// The set is LIAISON_DEMO_WORLDS intersected with the worlds that have a seed
// pack (`seedableDemoWorlds`). Naming a world before its pack exists is not a
// boot failure: the world is dropped with one warn line and the rest run.
import {
  DEMO_DEFAULT_WORLD,
  DEMO_SCENARIO_TOURS,
  DEMO_WORLD_NEEDS,
  DEMO_WORLDS,
  type DemoWorldId,
  demoScenarioTourId,
} from "@liaison/shared"
import { env, parseDemoWorldList } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { findDemoWorldPack, seedableDemoWorlds } from "~/seed/worlds"

const log = rootLogger.child({ module: "demo-worlds" })

let seedableOverride: readonly DemoWorldId[] | null = null
/** The dropped lists already logged, so a dropped world is said once, not per call. */
const warned = new Set<string>()

/**
 * Whether a visitor entering the world has its scenarios to follow: a world whose pack can be
 * seeded (by the CLI, by a test) but has no door tour yet is never offered at the door.
 */
export function hasDoorTours(world: DemoWorldId): boolean {
  const ids = new Set<string>(DEMO_SCENARIO_TOURS.map((t) => t.id))
  return DEMO_WORLD_NEEDS[world].some((need) => ids.has(demoScenarioTourId(world, need)))
}

/** The worlds this deployment runs, in `DEMO_WORLDS` order. Never empty: `products` at worst. */
export function enabledDemoWorlds(): DemoWorldId[] {
  const asked = parseDemoWorldList(env.LIAISON_DEMO_WORLDS) ?? [DEMO_DEFAULT_WORLD]
  const seedable = new Set(seedableOverride ?? seedableDemoWorlds().filter(hasDoorTours))
  const dropped = asked.filter((id) => !seedable.has(id))
  if (dropped.length > 0) {
    const key = dropped.join(",")
    if (!warned.has(key)) {
      warned.add(key)
      log.warn(
        { dropped, asked },
        `LIAISON_DEMO_WORLDS names ${dropped.join(", ")}, which has no seed pack or no door tour yet; dropped`,
      )
    }
  }
  const enabled = DEMO_WORLDS.filter((id) => asked.includes(id) && seedable.has(id))
  return enabled.length > 0 ? enabled : [DEMO_DEFAULT_WORLD]
}

/**
 * The workspace name a visitor's org carries: its world's company as people
 * call it (never the legal entity's name), or the default world's.
 */
export function demoWorldOrgName(worldId: DemoWorldId): string {
  return (
    (findDemoWorldPack(worldId) ?? findDemoWorldPack(DEMO_DEFAULT_WORLD))?.world.company.name ?? ""
  )
}

/** Test seams. */
export const DemoWorldsTestAccess = {
  /** Pretend these worlds have a seed pack (null: the packs registered in `seed/worlds`). */
  setSeedable(worlds: readonly DemoWorldId[] | null): void {
    seedableOverride = worlds
  },
}
