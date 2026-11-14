// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { demoNeedsSchema } from "../demo/needs"
import { DEMO_WORLD_NEEDS, type DemoWorldId } from "../demo/worlds"
import {
  DEMO_ENTRIES,
  DEMO_ENTRY_NEEDS,
  DEMO_ENTRY_TEXT_MAX,
  demoEntrySchema,
  needsAfterEntry,
  presetNeeds,
} from "./demo-entry"

const ALL_WORLDS: readonly DemoWorldId[] = ["products", "saas", "studio"]

describe("the demo door's company question", () => {
  it("preselects the needs agreed for each entry, and none for other", () => {
    expect(DEMO_ENTRY_NEEDS).toEqual({
      products: ["support", "commerce", "knowledge"],
      software: ["support", "dev", "knowledge"],
      expertise: ["projects", "sales", "knowledge"],
      other: [],
    })
  })

  it("preselects a list the signup route accepts", () => {
    for (const entry of DEMO_ENTRIES) {
      if (entry === "other") continue
      expect(demoNeedsSchema.safeParse([...DEMO_ENTRY_NEEDS[entry]]).success).toBe(true)
    }
  })

  it("takes a known id and refuses any other", () => {
    expect(demoEntrySchema.parse({ id: "software" })).toEqual({ id: "software" })
    for (const id of ["crm", "", "PRODUCTS", 3, null, undefined]) {
      expect(demoEntrySchema.safeParse({ id }).success).toBe(false)
    }
  })

  it("keeps free text for other only", () => {
    expect(demoEntrySchema.parse({ id: "other", text: "  A bakery  " })).toEqual({
      id: "other",
      text: "A bakery",
    })
    expect(demoEntrySchema.parse({ id: "products", text: "A bakery" })).toEqual({ id: "products" })
  })

  it("caps the free text at its length", () => {
    const longest = "x".repeat(DEMO_ENTRY_TEXT_MAX)
    expect(demoEntrySchema.parse({ id: "other", text: longest }).text).toBe(longest)
    expect(demoEntrySchema.safeParse({ id: "other", text: `${longest}x` }).success).toBe(false)
  })

  it("flattens control and invisible formatting characters out of the free text", () => {
    expect(demoEntrySchema.parse({ id: "other", text: "line\none\t‮two​\0" })).toEqual({
      id: "other",
      text: "line one two",
    })
  })

  it("drops free text that holds nothing", () => {
    expect(demoEntrySchema.parse({ id: "other", text: " \n​ " })).toEqual({ id: "other" })
  })
})

describe("the door's presets and picks by world", () => {
  it("presets light money, support and dev for software and leave other empty", () => {
    expect(presetNeeds("software", ALL_WORLDS)).toEqual(["money", "support", "dev"])
    expect(presetNeeds("expertise", ALL_WORLDS)).toEqual(["client", "projects", "sales"])
    expect(presetNeeds("products", ALL_WORLDS)).toEqual(["support", "commerce", "knowledge"])
    expect(presetNeeds("other", ALL_WORLDS)).toEqual([])
    expect(presetNeeds(null, ALL_WORLDS)).toEqual([])
    for (const entry of DEMO_ENTRIES) {
      const preset = presetNeeds(entry, ALL_WORLDS)
      if (preset.length > 0) expect(demoNeedsSchema.safeParse([...preset]).success).toBe(true)
    }
  })

  it("a disabled world keeps today's presets", () => {
    for (const enabled of [[], ["products"], ["products", "studio"]] as DemoWorldId[][]) {
      expect(presetNeeds("software", enabled)).toEqual(["support", "dev", "knowledge"])
    }
    for (const enabled of [[], ["products"], ["products", "saas"]] as DemoWorldId[][]) {
      expect(presetNeeds("expertise", enabled)).toEqual(["projects", "sales", "knowledge"])
    }
    for (const entry of DEMO_ENTRIES) {
      expect(presetNeeds(entry, [])).toEqual([...DEMO_ENTRY_NEEDS[entry]])
    }
  })

  it("changing the answer keeps only needs of the next world", () => {
    const picks = ["money", "support", "dev", "chat"] as const
    expect(needsAfterEntry(picks, "other", ALL_WORLDS)).toEqual(["support", "dev", "chat"])
    expect(needsAfterEntry(picks, null, ALL_WORLDS)).toEqual(["support", "dev", "chat"])
    expect(needsAfterEntry(picks, "expertise", ALL_WORLDS)).toEqual(["support", "dev", "chat"])
    expect(needsAfterEntry(picks, "software", ALL_WORLDS)).toEqual([...picks])
    // The world the answer would choose is off: the products world's list binds.
    expect(needsAfterEntry(picks, "software", ["products"])).toEqual(["support", "dev", "chat"])
    expect(needsAfterEntry(["commerce", "client"], "expertise", ALL_WORLDS)).toEqual(["client"])
    for (const world of ALL_WORLDS) {
      for (const entry of [...DEMO_ENTRIES, null]) {
        for (const need of needsAfterEntry(DEMO_WORLD_NEEDS[world], entry, ALL_WORLDS)) {
          expect(needsAfterEntry([need], entry, ALL_WORLDS)).toEqual([need])
        }
      }
    }
  })
})
