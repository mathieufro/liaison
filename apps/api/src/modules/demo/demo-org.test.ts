// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The world a demo marker holds (demo-org.ts, `demoWorldOf`) and the world
// fields a visitor marker is built with.
import { describe, expect, it } from "bun:test"
import { type DemoOrgMarker, demoMarker, isDemoOrg } from "@liaison/shared"
import { demoWorldOf, visitorMarker } from "~/modules/demo/demo-org"

const base = { variant: "visitor", createdAt: "2026-11-11T09:00:00.000Z", expiresAt: null }

describe("the world a demo marker holds", () => {
  it("a marker without a world or with a malformed one reads as products, never as not a demo", () => {
    const malformed: unknown[] = [
      undefined,
      null,
      "",
      "elsewhere",
      "SAAS",
      3,
      { id: "saas" },
      ["saas"],
    ]
    for (const worldId of malformed) {
      const raw = worldId === undefined ? { ...base } : { ...base, worldId }
      const org = { settings: { demo: raw } }
      // Still a demo org, whatever the world field holds.
      expect(isDemoOrg(org)).toBe(true)
      const marker = demoMarker(org)
      expect(marker).not.toBeNull()
      expect(demoWorldOf(marker)).toBe("products")
    }
    expect(demoWorldOf(null)).toBe("products")
  })

  it("a marker naming a world reads as that world", () => {
    for (const worldId of ["products", "saas", "studio"] as const) {
      expect(demoWorldOf({ ...base, worldId } as DemoOrgMarker)).toBe(worldId)
    }
  })

  it("a visitor marker carries its world, and a month only when one is given", () => {
    const now = new Date("2026-11-11T09:00:00.000Z")
    expect(visitorMarker(24, now, ["money"], { worldId: "saas", worldMonth: "2026-11" })).toEqual({
      variant: "visitor",
      createdAt: now.toISOString(),
      expiresAt: "2026-11-12T09:00:00.000Z",
      needs: ["money"],
      worldId: "saas",
      worldMonth: "2026-11",
    })
    const products = visitorMarker(24, now, ["support"], { worldId: "products", worldMonth: null })
    expect(products.worldId).toBe("products")
    expect("worldMonth" in products).toBe(false)
    expect("worldId" in visitorMarker(24, now)).toBe(false)
  })
})
