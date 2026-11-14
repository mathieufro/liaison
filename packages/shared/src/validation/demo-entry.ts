// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "Which looks most like your company?" on the demo door: the entries, the
 * world each one opens, the needs each one preselects, and the answer the
 * signup route takes.
 *
 * The answer chooses the demo world (`DEMO_ENTRY_WORLD`) when that world is
 * enabled, and the products world otherwise. NOT IN `demo/` all the same:
 * every file there is hashed into the demo world fingerprint
 * (`DEMO_WORLD_INPUTS`), which retires the warm pool when it changes. This map
 * changes who gets which world, not what any world seeds, so changing it must
 * not retire anything.
 *
 * The answer rides on the org's demo marker (`settings.demo.entry`) as a hint,
 * like the welcome popup's. The marker schema does not declare it on purpose: a
 * malformed marker reads as "not a demo", and a hint must never be able to do
 * that. Read it through `demoEntrySchema.safeParse`.
 */
import { z } from "zod"
import type { DemoNeed } from "../demo/needs"
import { DEMO_DEFAULT_WORLD, DEMO_WORLD_NEEDS, type DemoWorldId } from "../demo/worlds"

/** In the order the door lists them. */
export const DEMO_ENTRIES = ["products", "software", "expertise", "other"] as const

export type DemoEntryId = (typeof DEMO_ENTRIES)[number]

/**
 * The needs each entry preselects, in the order their scenarios play. `other`
 * preselects nothing: the picker keeps its usual empty start. Each set is one a
 * visitor could pick by hand, and `seed-plan.test.ts` checks its tours can run.
 */
export const DEMO_ENTRY_NEEDS: Readonly<Record<DemoEntryId, readonly DemoNeed[]>> = {
  products: ["support", "commerce", "knowledge"],
  software: ["support", "dev", "knowledge"],
  expertise: ["projects", "sales", "knowledge"],
  other: [],
}

/** The world each entry opens when that world is enabled. */
export const DEMO_ENTRY_WORLD: Readonly<Record<DemoEntryId, DemoWorldId>> = {
  products: "products",
  software: "saas",
  expertise: "studio",
  other: "products",
}

/**
 * The needs an entry preselects when it opens its own world, which leads with
 * that world's need. An entry whose world is products or disabled keeps
 * `DEMO_ENTRY_NEEDS`.
 */
export const DEMO_ENTRY_WORLD_NEEDS: Readonly<Partial<Record<DemoEntryId, readonly DemoNeed[]>>> = {
  software: ["money", "support", "dev"],
  expertise: ["client", "projects", "sales"],
}

/**
 * The world an answer opens: the entry's own world when `enabledWorlds` holds
 * it, the products world otherwise (no answer, `other`, a disabled world).
 */
export function demoWorldOfEntry(
  entry: DemoEntryId | null | undefined,
  enabledWorlds: readonly DemoWorldId[],
): DemoWorldId {
  if (!entry) return DEMO_DEFAULT_WORLD
  const world = DEMO_ENTRY_WORLD[entry]
  return enabledWorlds.includes(world) ? world : DEMO_DEFAULT_WORLD
}

/** The needs an answer preselects, given the worlds this deployment runs. */
export function presetNeeds(
  entry: DemoEntryId | null | undefined,
  enabledWorlds: readonly DemoWorldId[],
): DemoNeed[] {
  if (!entry) return []
  const own = DEMO_ENTRY_WORLD_NEEDS[entry]
  if (own && demoWorldOfEntry(entry, enabledWorlds) !== DEMO_DEFAULT_WORLD) return [...own]
  return [...DEMO_ENTRY_NEEDS[entry]]
}

/**
 * The picks once the answer changes to `nextEntry`: only the needs the world it
 * opens shows, in the order they were picked.
 */
export function needsAfterEntry(
  picks: readonly DemoNeed[],
  nextEntry: DemoEntryId | null | undefined,
  enabledWorlds: readonly DemoWorldId[],
): DemoNeed[] {
  const shown = DEMO_WORLD_NEEDS[demoWorldOfEntry(nextEntry, enabledWorlds)]
  return picks.filter((need) => shown.includes(need))
}

/** The longest free text an `other` answer may carry. */
export const DEMO_ENTRY_TEXT_MAX = 120

/** Control and invisible formatting characters (bidi overrides, zero-width marks). */
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/gu

/** Untrusted text flattened to one printable line. */
function flatten(raw: string): string {
  return raw
    .replace(/[\t\r\n]/g, " ")
    .replace(UNPRINTABLE, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * The visitor's answer. The text is untrusted: capped, flattened, kept for
 * `other` only, and dropped when nothing is left of it. Render it as text only.
 */
export const demoEntrySchema = z
  .object({
    id: z.enum(DEMO_ENTRIES),
    text: z.string().max(DEMO_ENTRY_TEXT_MAX).optional(),
  })
  .transform(({ id, text }) => {
    const kept = id === "other" && text ? flatten(text) : ""
    return kept ? { id, text: kept } : { id }
  })

export type DemoEntry = z.output<typeof demoEntrySchema>

export function isDemoEntryId(value: unknown): value is DemoEntryId {
  return typeof value === "string" && (DEMO_ENTRIES as readonly string[]).includes(value)
}
