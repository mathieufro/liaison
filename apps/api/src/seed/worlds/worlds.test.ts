// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seed packs of the demo worlds: `products` is today's Resonant Audio Labs,
// read from the files it was always seeded from, and a world with no pack yet
// is refused by name rather than seeded as another world.
import { describe, expect, it } from "bun:test"
import { DEMO_WORLDS } from "@liaison/shared"
import { env } from "~/lib/env"
import { enabledDemoWorlds } from "~/modules/demo/demo-worlds"
import { PRODUCTS_AGENT_NATIVE_SPECS } from "~/seed/tiers/demo/seed-agent-native"
import { PRODUCTS_SUPPORT_WORLD } from "~/seed/tiers/demo/seed-support"
import {
  DEMO_DESK_TEAMS,
  DEMO_EMAIL_DOMAIN,
  DEMO_ROLE_AGENTS,
  DEMO_TEAM,
  DEMO_WORLD,
} from "~/seed/world/fiction"
import { demoWorldPack, findDemoWorldPack, seedableDemoWorlds } from "./index"

describe("demo world packs", () => {
  it("the products pack is the products world's own values, not a copy", () => {
    const pack = demoWorldPack("products")
    expect(pack.id).toBe("products")
    expect(pack.world).toBe(DEMO_WORLD)
    expect(pack.orgName).toBe(DEMO_WORLD.company.legalName)
    expect(pack.emailDomain).toBe(DEMO_EMAIL_DOMAIN)
    expect(pack.roleAgents).toBe(DEMO_ROLE_AGENTS)
    expect(pack.deskTeams).toBe(DEMO_DESK_TEAMS)
    expect(pack.supportSpecs).toBe(PRODUCTS_SUPPORT_WORLD.support)
    expect(pack.knowledgeSpecs).toBe(PRODUCTS_SUPPORT_WORLD.knowledge)
    expect(pack.threadSpecs).toBe(PRODUCTS_SUPPORT_WORLD.threads)
    expect(pack.agentNative).toBe(PRODUCTS_AGENT_NATIVE_SPECS)
    expect(pack.layer).toBeUndefined()
  })

  it("exposes the staff by role and the named rows for a driver outside the seed", () => {
    const pack = demoWorldPack("products")
    expect(pack.people).toBe(DEMO_TEAM)
    const byRole = Object.values(pack.personas).flat()
    expect(byRole).toHaveLength(DEMO_TEAM.length)
    for (const person of DEMO_TEAM) expect(pack.personas[person.role]).toContain(person)
    expect(pack.namedRows.company).toBe(DEMO_WORLD.company)
  })

  it("a world with no pack yet is refused by name, never seeded as another world", () => {
    for (const id of DEMO_WORLDS) {
      if (findDemoWorldPack(id)) continue
      expect(() => demoWorldPack(id)).toThrow(`'${id}' world has no seed pack`)
    }
    expect(seedableDemoWorlds()).toContain("products")
    expect(seedableDemoWorlds().every((id) => DEMO_WORLDS.includes(id))).toBe(true)
  })

  it("studio is seedable and never enabled for the door before it has tours", () => {
    expect(seedableDemoWorlds()).toContain("studio")
    const pack = demoWorldPack("studio")
    expect(pack.layer).toBeDefined()
    expect(pack.people).toHaveLength(23)
    const saved = env.LIAISON_DEMO_WORLDS
    try {
      env.LIAISON_DEMO_WORLDS = "studio"
      expect(enabledDemoWorlds()).toEqual(["products"])
      env.LIAISON_DEMO_WORLDS = "products,saas,studio"
      expect(enabledDemoWorlds()).toEqual(["products", "saas"])
    } finally {
      env.LIAISON_DEMO_WORLDS = saved
    }
  })
})
