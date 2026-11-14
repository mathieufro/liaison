// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The needs a visitor's scenarios list resolve through the world of their
// workspace: a world's default needs are its own, and each need's tour id is
// the one of that world.
import { describe, expect, it } from "bun:test"
import { DEMO_WORLD_NEEDS, demoScenarioTourId } from "@liaison/shared"
import { pickedNeeds } from "~/modules/demo/scenarios-routes"

describe("picked needs", () => {
  it("picked needs resolve to the world's tour ids", () => {
    for (const world of ["products", "saas", "studio"] as const) {
      const needs = pickedNeeds({ worldId: world })
      expect(needs).toEqual([...DEMO_WORLD_NEEDS[world]])
      expect(needs.map((need) => demoScenarioTourId(world, need))).toEqual(
        DEMO_WORLD_NEEDS[world].map((need) => demoScenarioTourId(world, need)),
      )
    }
    expect(pickedNeeds({ worldId: "saas" })).toContain("money")
    expect(pickedNeeds({ worldId: "saas" })).not.toContain("commerce")
  })

  it("an unknown, missing or empty marker reads as the default world's needs; picks keep their order", () => {
    expect(pickedNeeds(null)).toEqual([...DEMO_WORLD_NEEDS.products])
    expect(pickedNeeds({ worldId: "nowhere" })).toEqual([...DEMO_WORLD_NEEDS.products])
    expect(pickedNeeds({ worldId: "saas", needs: ["sales", "support"] })).toEqual([
      "sales",
      "support",
    ])
  })
})
