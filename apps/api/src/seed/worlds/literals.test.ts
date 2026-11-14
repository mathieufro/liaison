// SPDX-License-Identifier: FSL-1.1-ALv2
//
// No world's text holds another world's literals: its pack (people, desks,
// support, knowledge, threads, named rows), the software world's brief, and
// the door strings a visitor reads for the world in every language. A planted
// literal of the other world is found.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { findDemoWorldPack, seedableDemoWorlds } from "./index"
import { foreignLiterals, WORLD_LITERALS } from "./literals"
import { saasMorningBrief } from "./saas/brief"

const LOCALES = path.join(import.meta.dir, "../../../../../packages/shared/src/i18n/locales")
const BOARD_DATE = new Date("2026-11-09T08:30:00Z")

/** A pack's data as text, functions left out. */
function packText(world: Parameters<typeof findDemoWorldPack>[0]): string {
  const pack = findDemoWorldPack(world)
  return JSON.stringify(pack, (_k, v) => (typeof v === "function" ? undefined : v))
}

describe("world literals", () => {
  it("each world has a list, and the lists do not share a name", () => {
    const products = WORLD_LITERALS.products ?? []
    const saas = WORLD_LITERALS.saas ?? []
    expect(products.length).toBeGreaterThan(10)
    expect(saas.length).toBeGreaterThan(200)
    expect(products.filter((l) => saas.includes(l))).toEqual([])
  })

  for (const world of seedableDemoWorlds()) {
    it(`the ${world} pack holds no other world's literal`, () => {
      expect(foreignLiterals(world, packText(world))).toEqual([])
    })
  }

  it("the software world's brief holds no other world's literal", () => {
    expect(foreignLiterals("saas", saasMorningBrief(BOARD_DATE))).toEqual([])
  })

  it("the door strings for the software world hold no other world's literal, in every language", () => {
    const locales = readdirSync(LOCALES, { withFileTypes: true }).filter((d) => d.isDirectory())
    expect(locales.length).toBeGreaterThan(1)
    for (const { name: locale } of locales) {
      const file = path.join(LOCALES, locale, "kernel.json")
      const kernel = JSON.parse(readFileSync(file, "utf8")) as {
        demo?: { world?: Record<string, unknown> }
      }
      const door = kernel.demo?.world?.saas
      if (!door) continue
      expect({ locale, hits: foreignLiterals("saas", JSON.stringify(door)) }).toEqual({
        locale,
        hits: [],
      })
    }
  })

  it("a planted literal of the other world is found", () => {
    const planted = `${saasMorningBrief(BOARD_DATE)} ${(WORLD_LITERALS.products ?? [])[0]}`
    expect(foreignLiterals("saas", planted)).toHaveLength(1)
  })
})
