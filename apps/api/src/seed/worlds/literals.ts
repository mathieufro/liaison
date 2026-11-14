// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Each world's literals: the names a visitor would recognise as that world's
// (its company, its people, its customers and companies, its products). A
// world's own text and rows must hold none of another world's (W10): a
// software company's brief naming a field recorder, or a products dealer in
// the software world's pipeline, is a seam the visitor sees. The lists are read
// from the packs themselves, so a name added to a pack is checked from then on.
import type { DemoWorldId } from "@liaison/shared"
import { DEMO_WORLD } from "~/seed/world/fiction"
import { SAAS_TEAM, SAAS_WORLD } from "./saas/fiction"
import { saasPlan } from "./saas/plan"

/** Shorter than this, a name could be a common word: it is not a literal of the world. */
const MIN_LITERAL_LENGTH = 6

const BOARD_DATE = new Date("2026-11-09T08:30:00Z")

function listOf(values: Iterable<string>): readonly string[] {
  return [
    ...new Set([...values].map((v) => v.trim()).filter((v) => v.length >= MIN_LITERAL_LENGTH)),
  ].sort()
}

/** The literals of each world with a pack. */
export const WORLD_LITERALS: Readonly<Partial<Record<DemoWorldId, readonly string[]>>> = {
  products: listOf([
    DEMO_WORLD.company.name,
    DEMO_WORLD.company.legalName,
    ...DEMO_WORLD.team.map((p) => p.name),
    ...DEMO_WORLD.customers.map((c) => c.name),
    ...DEMO_WORLD.dealers.map((d) => d.name),
    ...DEMO_WORLD.catalog.map((s) => s.title),
    "Kestrel",
  ]),
  saas: listOf([
    SAAS_WORLD.company.name,
    SAAS_WORLD.company.legalName,
    ...SAAS_TEAM.map((p) => p.name),
    ...SAAS_WORLD.customers.map((c) => c.name),
    // Every company of the plan: its customers, prospects and past customers.
    ...saasPlan(BOARD_DATE).companies.map((c) => c.name),
  ]),
}

/** Every literal of another world found in `text`, as `world: literal`. */
export function foreignLiterals(world: DemoWorldId, text: string): string[] {
  const hits: string[] = []
  for (const [other, literals] of Object.entries(WORLD_LITERALS)) {
    if (other === world) continue
    for (const literal of literals ?? [])
      if (text.includes(literal)) hits.push(`${other}: ${literal}`)
  }
  return hits
}
