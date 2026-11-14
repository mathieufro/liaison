// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which demo worlds a deployment runs (demo-worlds.ts): LIAISON_DEMO_WORLDS
// intersected with the worlds that have a seed pack, and how the two pool
// variables are read and refused.
import { afterEach, describe, expect, it } from "bun:test"
import { env, envSchema, parseDemoPoolSizes, parseDemoWorldList } from "~/lib/env"
import { DEMO_COMPANY_NAME } from "~/modules/demo/demo-seeder"
import {
  DemoWorldsTestAccess,
  demoWorldOrgName,
  enabledDemoWorlds,
  hasDoorTours,
} from "~/modules/demo/demo-worlds"
import { findDemoWorldPack, seedableDemoWorlds } from "~/seed/worlds"

const saved = env.LIAISON_DEMO_WORLDS

afterEach(() => {
  env.LIAISON_DEMO_WORLDS = saved
  DemoWorldsTestAccess.setSeedable(null)
})

describe("enabled demo worlds", () => {
  it("a studio entry in the env is dropped while the studio has a seed pack but no door tour", () => {
    expect(seedableDemoWorlds()).toContain("studio")
    expect(hasDoorTours("studio")).toBe(false)
    expect(hasDoorTours("saas")).toBe(true)
    env.LIAISON_DEMO_WORLDS = "products,studio"
    expect(enabledDemoWorlds()).toEqual(["products"])
    // Once its door is there, the same env runs it.
    DemoWorldsTestAccess.setSeedable(["products", "saas", "studio"])
    expect(enabledDemoWorlds()).toEqual(["products", "studio"])
  })

  it("unset runs the default world only, and the worlds come back in their fixed order", () => {
    env.LIAISON_DEMO_WORLDS = "products"
    expect(enabledDemoWorlds()).toEqual(["products"])
    DemoWorldsTestAccess.setSeedable(["products", "saas", "studio"])
    env.LIAISON_DEMO_WORLDS = "studio,products,saas"
    expect(enabledDemoWorlds()).toEqual(["products", "saas", "studio"])
  })

  it("a box naming only worlds without a pack still runs the default world", () => {
    DemoWorldsTestAccess.setSeedable(["products"])
    env.LIAISON_DEMO_WORLDS = "saas"
    expect(enabledDemoWorlds()).toEqual(["products"])
  })
})

describe("the demo world env variables", () => {
  it("reads a world list and a size split, and refuses malformed ones", () => {
    expect(parseDemoWorldList("products, saas")).toEqual(["products", "saas"])
    expect(parseDemoWorldList("products,elsewhere")).toBeNull()
    expect(parseDemoWorldList("saas,saas")).toBeNull()
    expect(parseDemoPoolSizes("")).toEqual({})
    expect(parseDemoPoolSizes("products=2, saas=2,studio=1")).toEqual({
      products: 2,
      saas: 2,
      studio: 1,
    })
    for (const bad of [
      "products",
      "products=x",
      "products=2,products=1",
      "elsewhere=1",
      "saas=101",
    ]) {
      expect(parseDemoPoolSizes(bad)).toBeNull()
    }
  })

  it("a malformed pool split or world list fails env validation at boot", () => {
    const base = { ...process.env }
    const sizes = envSchema.safeParse({ ...base, LIAISON_DEMO_POOL_SIZES: "products:2" })
    expect(sizes.success).toBe(false)
    expect(JSON.stringify(sizes.error?.issues)).toContain("LIAISON_DEMO_POOL_SIZES")
    const worlds = envSchema.safeParse({ ...base, LIAISON_DEMO_WORLDS: "products,elsewhere" })
    expect(worlds.success).toBe(false)
    const good = envSchema.safeParse({
      ...base,
      LIAISON_DEMO_WORLDS: "",
      LIAISON_DEMO_POOL_SIZES: "",
      LIAISON_DEMO_POOL_MAX_AGE_HOURS: "",
    })
    expect(good.success).toBe(true)
    expect(good.data?.LIAISON_DEMO_WORLDS).toBe("products")
    expect(good.data?.LIAISON_DEMO_POOL_MAX_AGE_HOURS).toBe(12)
  })
})

describe("a demo world's workspace name", () => {
  it("is the company's name as people call it, never its legal entity's", () => {
    expect(demoWorldOrgName("products")).toBe(DEMO_COMPANY_NAME)
    for (const id of seedableDemoWorlds()) {
      const company = findDemoWorldPack(id)?.world.company
      expect(demoWorldOrgName(id)).toBe(company?.name ?? "")
      expect(demoWorldOrgName(id)).not.toBe(company?.legalName)
    }
  })
})
