// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Capability DISPLAY: the one place a scope string, or the app slug a scope
 * belongs to, is turned into words a person reads (A14, charter agent.md
 * "A scope name on screen").
 *
 * `capability-categories.ts` answers "which app does this grant belong to";
 * this module answers "what do I PRINT for it". They are separate because the
 * category is a key (a test id, a lookup) while the label is prose, and the
 * surfaces need both: the chip keeps the category in its test id and renders
 * the label.
 *
 * Every function here is pure. The display names an instance actually has
 * (manifest `displayName`s, role names) are passed in by the caller, because
 * only the client knows which apps this org runs; the built-in maps are the
 * fallback for the first-party apps that ship in the image.
 */

import { WILDCARD_CAPABILITY_CATEGORY } from "./capability-categories"

/** Display names for the first-party apps, when no manifest one is loaded. */
export const APP_DISPLAY_NAMES: Record<string, string> = {
  ads: "Ads",
  boxtal: "Boxtal",
  calendar: "Calendar",
  contacts: "Contacts",
  database: "Database",
  files: "Files",
  github: "GitHub",
  gitlab: "GitLab",
  "google-drive": "Google Drive",
  invoicing: "Invoicing",
  kernel: "Workspace",
  knowledge: "Knowledge",
  mail: "Mail",
  "mcp-manager": "Connected services",
  monitoring: "Monitoring",
  pennylane: "Pennylane",
  projects: "Projects",
  shopify: "Shopify",
  social: "Social",
  threads: "Threads",
  tickets: "Tickets",
}

/** `some-app_name` -> `Some app name`: a slug read aloud, never a slug shown. */
export function humanizeSlug(slug: string): string {
  const words = slug
    .split(/[-_.:]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
  if (words.length === 0) return slug
  const joined = words.join(" ")
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

/** The words a derived phrase is allowed to use, so a caller can translate. */
export interface CapabilityVocabulary {
  /** What a grant that names only an app amounts to. */
  fullAccess: string
  /**
   * What sits between the app's name and what it allows. It is punctuation
   * with a LOCALE in it: French puts a space before a colon, English does
   * not, so the separator is catalog copy and never a literal here.
   */
  separator: string
  /** One verb per known scope action; an unknown action keeps its own word. */
  actions: Record<string, string>
  /**
   * The nouns a derived phrase names, keyed by the identifier's own words
   * joined with `_` (`agent_memory`, `tasks`). A phrase is looked up whole
   * first, then word by word, so a locale can translate either grain; an
   * unknown word keeps its own spelling rather than inventing one.
   */
  resources?: Record<string, string>
}

export const DEFAULT_CAPABILITY_VOCABULARY: CapabilityVocabulary = {
  fullAccess: "full access",
  separator: ": ",
  actions: {
    read: "read",
    list: "list",
    write: "edit",
    create: "create",
    delete: "delete",
    admin: "manage",
    approve: "approve",
    export: "export",
    analyze: "analyze",
  },
}

export interface AppNameOptions {
  /** Manifest display names, keyed by app slug: the instance's own truth. */
  appNames?: Record<string, string>
}

/** The name a person reads for one app slug. */
export function appDisplayName(slug: string, opts: AppNameOptions = {}): string {
  if (typeof slug !== "string" || slug === "") return ""
  const manifest = opts.appNames?.[slug]
  if (manifest) return manifest
  const known = Object.hasOwn(APP_DISPLAY_NAMES, slug) ? APP_DISPLAY_NAMES[slug] : undefined
  if (known !== undefined) return known
  return humanizeSlug(slug)
}

/** A role name reduced to the bare word a scope string uses (`C-Level` -> `clevel`). */
export function roleScopeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "")
}

export interface CategoryLabelOptions extends AppNameOptions {
  /** Role names, so a category that is really a role reads as the role. */
  roleNames?: string[]
  /** What an unresolvable category is called: a neutral word, never a slug.
   *  Required: the words a person reads are the caller's catalog, never a
   *  literal in this package. */
  unknownLabel: string
}

/** What a capability chip shows, and what it keeps for a hover. */
export interface CapabilityChip {
  label: string
  /** The raw category, present ONLY when the label could not name it. */
  title?: string
}

/**
 * ONE capability category, as a chip: an app's display name, a role's own name
 * when the category is really a role's bare scope, and the wildcard phrase
 * untouched (it is already a sentence, not an identifier).
 *
 * A category nothing can name reads as the neutral word the caller supplies,
 * with the identifier in the title. It is NEVER a de-slugged guess: the org
 * role `clevel` is "C-Level", and "Clevel" is a mangling that claims to be a
 * name, which is worse than admitting the page does not know it.
 */
export function capabilityCategoryChip(
  category: string,
  opts: CategoryLabelOptions,
): CapabilityChip {
  if (typeof category !== "string" || category === "") return { label: "" }
  if (category === WILDCARD_CAPABILITY_CATEGORY || category === "*") {
    return { label: WILDCARD_CAPABILITY_CATEGORY }
  }
  for (const name of opts.roleNames ?? []) {
    if (roleScopeKey(name) === category) return { label: name }
  }
  const named = opts.appNames?.[category] ?? APP_DISPLAY_NAMES[category]
  if (named) return { label: named }
  return { label: opts.unknownLabel, title: category }
}

export interface ScopeLabelOptions extends AppNameOptions {
  /** The catalog description for this scope, when the surface has one. */
  description?: string
  vocabulary?: CapabilityVocabulary
}

/**
 * The label for ONE scope string: `<App name>: <what it lets you do>`, and
 * never the `app:resource:action` identifier.
 *
 * The catalog description wins when there is one. Without it the phrase is
 * DERIVED from the identifier's own words (resource, then action verb), which
 * still reads as a sentence: a missing description degrades the wording, it
 * never falls back to printing the id.
 */
export function scopeDisplayLabel(scope: string, opts: ScopeLabelOptions = {}): string {
  if (typeof scope !== "string" || scope === "") return ""
  if (scope === "*") return WILDCARD_CAPABILITY_CATEGORY
  const vocab = opts.vocabulary ?? DEFAULT_CAPABILITY_VOCABULARY
  const parts = scope.split(":").filter((p) => p.length > 0)
  const slug = parts[0] ?? scope
  const app = appDisplayName(slug, opts)

  const described = typeof opts.description === "string" ? opts.description.trim() : ""
  if (described) {
    const lower = described.toLowerCase()
    // A description that already names its app is a whole sentence: prefixing
    // it with the app again reads as a stutter ("Workspace: Full kernel access").
    if (lower.includes(app.toLowerCase()) || lower.includes(slug.toLowerCase())) return described
    return `${app}${vocab.separator}${described}`
  }

  const rest = parts.slice(1)
  if (rest.length === 0) return `${app}${vocab.separator}${vocab.fullAccess}`
  const last = rest[rest.length - 1] ?? ""
  const verb = (Object.hasOwn(vocab.actions, last) ? vocab.actions[last] : undefined) ?? ""
  const words = (verb ? rest.slice(0, -1) : rest)
    .flatMap((w) => w.split(/[-_.]+/))
    .filter((w) => w.length > 0)
  const resourceWords = translateResource(words, vocab.resources)
  const phrase = verb
    ? resourceWords
      ? `${verb} ${resourceWords}`
      : verb
    : resourceWords || vocab.fullAccess
  return `${app}${vocab.separator}${phrase}`
}

/**
 * The nouns of a derived phrase, in the reader's language: the whole phrase
 * first (`agent_memory`), then word by word, then the identifier's own word.
 */
function translateResource(words: string[], resources?: Record<string, string>): string {
  if (words.length === 0) return ""
  if (resources) {
    const whole = resources[words.join("_")]
    if (whole) return whole
    return words.map((w) => resources[w] ?? w).join(" ")
  }
  return words.join(" ")
}
