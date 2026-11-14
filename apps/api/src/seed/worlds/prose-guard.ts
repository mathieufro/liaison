// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The pack prose guard: a world pack's strings are seeded once and read later,
// so a relative day word ("this morning"), a weekday, a literal date or a year
// in them turns false as soon as the org is handed out a day after its seed.
// Dates enter prose through the story clock's formatter (`story-clock.ts`
// `fmt`), computed from the anchor, never as literals.
//
// `scanPackProse` walks every string value of a pack's data; `scanWorldPackDir`
// does it over every module of a `seed/worlds/<world>/` directory and names the
// file and the field. Fields whose value is an identifier rather than prose (a
// document number such as "F-2026-0362", an email, a URL) are on an allow-list.
import { readdirSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export type ProseViolationKind = "date" | "year" | "weekday" | "relative-day"

export interface ProseViolation {
  /** Path of the string inside the scanned value, e.g. `briefs[0].body`. */
  field: string
  kind: ProseViolationKind
  /** The text that matched. */
  match: string
  /** The whole string. */
  value: string
}

export interface WorldProseViolation extends ProseViolation {
  /** The module, relative to the world directory, with `/` separators. */
  file: string
}

/** Field names whose values are identifiers, not prose. */
export const PROSE_GUARD_ALLOWED_FIELDS: readonly string[] = [
  "id",
  "key",
  "slug",
  "number",
  "email",
  "domain",
  "url",
  "href",
  "sku",
  "iban",
  "vatNumber",
  "currency",
  "locale",
  "timeZone",
  "timezone",
]

// Letters and digits on either side end a word, accented letters included.
const W_START = "(?<![\\p{L}\\p{N}])"
const W_END = "(?![\\p{L}\\p{N}])"
const word = (alternatives: string) => new RegExp(`${W_START}(?:${alternatives})${W_END}`, "iu")

const MONTHS_EN =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec"
const MONTHS_FR =
  "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|janv|févr|fevr|avr|juil|sept|oct|nov|déc|dec"
const MONTHS = `${MONTHS_EN}|${MONTHS_FR}`

/** Checked in this order; a string reports its first hit. */
const RULES: ReadonlyArray<{ kind: ProseViolationKind; pattern: RegExp }> = [
  {
    kind: "date",
    pattern: new RegExp(
      [
        // 2026-11-30
        `${W_START}\\d{4}-\\d{1,2}-\\d{1,2}${W_END}`,
        // 12/03, 12/03/2026 (not "24/7")
        `${W_START}(?!24/7${W_END})\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?${W_END}`,
        // 12.03.2026 (a decimal such as 4.8 is not a date)
        `${W_START}\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}${W_END}`,
        // 3 Nov, 1er mai, 3 novembre
        `${W_START}\\d{1,2}(?:er|st|nd|rd|th)?\\s+(?:${MONTHS})${W_END}`,
        // November 3
        `${W_START}(?:${MONTHS_EN})\\.?\\s+\\d{1,2}${W_END}`,
      ].join("|"),
      "iu",
    ),
  },
  { kind: "year", pattern: new RegExp(`${W_START}(?:19|20)\\d{2}${W_END}`, "u") },
  {
    kind: "weekday",
    pattern: word(
      "monday|tuesday|wednesday|thursday|friday|saturday|sunday|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche",
    ),
  },
  {
    kind: "relative-day",
    pattern: word(
      [
        "today",
        "tonight",
        "yesterday",
        "tomorrow",
        "this morning",
        "this afternoon",
        "this evening",
        "last night",
        "aujourd'hui",
        "aujourd’hui",
        "avant-hier",
        "après-demain",
        "hier",
        "demain",
        "ce matin",
        "cet après-midi",
        "ce soir",
      ].join("|"),
    ),
  },
]

function check(value: string): { kind: ProseViolationKind; match: string } | null {
  for (const rule of RULES) {
    const m = rule.pattern.exec(value)
    if (m) return { kind: rule.kind, match: m[0] }
  }
  return null
}

/**
 * Every string value under `value` that holds a literal date, a year, a weekday
 * or a relative day word, with the path that reaches it. Functions are skipped
 * (a pack's layer computes its dates from the clock), and so is any string held
 * by a field on `allowFields`.
 */
export function scanPackProse(
  value: unknown,
  opts: { allowFields?: readonly string[]; root?: string } = {},
): ProseViolation[] {
  const allow = new Set(opts.allowFields ?? PROSE_GUARD_ALLOWED_FIELDS)
  const seen = new Set<object>()
  const out: ProseViolation[] = []

  const walk = (node: unknown, field: string, name: string | null) => {
    if (typeof node === "string") {
      if (name !== null && allow.has(name)) return
      const hit = check(node)
      if (hit) out.push({ field, kind: hit.kind, match: hit.match, value: node })
      return
    }
    if (node === null || typeof node !== "object") return
    if (seen.has(node)) return
    seen.add(node)
    if (Array.isArray(node)) {
      for (const [i, item] of node.entries()) walk(item, `${field}[${i}]`, name)
      return
    }
    if (node instanceof Map) {
      for (const [k, v] of node) walk(v, field ? `${field}.${String(k)}` : String(k), String(k))
      return
    }
    if (node instanceof Set) {
      let i = 0
      for (const v of node) walk(v, `${field}[${i++}]`, name)
      return
    }
    for (const [k, v] of Object.entries(node)) walk(v, field ? `${field}.${k}` : k, k)
  }

  walk(value, opts.root ?? "", null)
  return out
}

function moduleFiles(dir: string, rel = ""): string[] {
  const files: string[] = []
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...moduleFiles(dir, relPath))
    else if (/\.(ts|js)$/.test(entry.name) && !/\.(test|d)\.ts$/.test(entry.name))
      files.push(relPath)
  }
  return files.sort()
}

/**
 * The guard over one world pack directory (`seed/worlds/<world>/`): every
 * module except tests, every export, every string value.
 */
export async function scanWorldPackDir(
  dir: string,
  opts: { allowFields?: readonly string[] } = {},
): Promise<WorldProseViolation[]> {
  const out: WorldProseViolation[] = []
  for (const file of moduleFiles(dir)) {
    const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as Record<string, unknown>
    for (const name of Object.keys(mod).sort()) {
      for (const v of scanPackProse(mod[name], { allowFields: opts.allowFields, root: name })) {
        out.push({ file, ...v })
      }
    }
  }
  return out
}
