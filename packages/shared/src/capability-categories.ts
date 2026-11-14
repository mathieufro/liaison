// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Capability CATEGORIES: the one mapping from scope strings to the words a
 * person is allowed to read (A14).
 *
 * A scope name is never shown to a non-admin, on any surface: the runtime
 * context tail says "capability categories", the agent overview renders
 * `capabilityCategories`, and the skill / routine / memory rows render the
 * same thing. The mapping lives here, in `packages/shared`, because both the
 * API (which composes the context tail and the agent detail payload) and the
 * web client (which renders the rows) have to agree on it; two copies would
 * drift and one of them would eventually leak a scope.
 */

/** What a wildcard grant amounts to: it names no app, so it names everything. */
export const WILDCARD_CAPABILITY_CATEGORY = "everything this workspace allows"

/**
 * The capability CATEGORIES a set of grants amounts to: the text before the
 * first colon of each grant, deduplicated and sorted. A category is an app,
 * not a grant, so nothing here names a scope or a tool. A wildcard grant has
 * no app to name and reports itself as the whole workspace.
 */
export function capabilityCategories(grants: string[]): string[] {
  const out = new Set<string>()
  for (const grant of grants) {
    if (typeof grant !== "string" || grant === "") continue
    if (grant === "*") {
      out.add(WILDCARD_CAPABILITY_CATEGORY)
      continue
    }
    const colon = grant.indexOf(":")
    out.add(colon === -1 ? grant : grant.slice(0, colon))
  }
  return [...out].sort()
}

/**
 * The CURATED capability labels: one readable phrase per app, the words the
 * withheld card is allowed to say (A14).
 *
 * It lives beside `capabilityCategories` for the same reason that one does:
 * the API composes cards from it and the admin surface renders the same words
 * beside the raw scope an admin is entitled to see, and two copies would
 * drift.
 *
 * A label is the CATEGORY, never the app's machine name and never the scope:
 * "finance data", not "pennylane:payouts:read" and not "pennylane". An app
 * with no entry keeps the generic label rather than leaking its prefix.
 */
export const CAPABILITY_LABELS: Record<string, string> = {
  ads: "advertising",
  boxtal: "shipping",
  calendar: "calendars",
  calls: "call recordings",
  database: "business records",
  github: "the code repository",
  gitlab: "the code repository",
  "google-drive": "shared drive files",
  invoicing: "invoices and quotes",
  kernel: "workspace administration",
  knowledge: "the knowledge base",
  kpi: "KPI figures",
  mail: "mailboxes",
  "mcp-manager": "connected services",
  monitoring: "system monitoring",
  pennylane: "finance data",
  projects: "projects and tasks",
  shopify: "the online store",
  social: "social accounts",
  stripe: "payment data",
  tickets: "support tickets",
}

/** What the card says when the app has no curated label. */
export const GENERIC_CAPABILITY_LABEL = "a capability"

/** The readable label for ONE scope string, by the app before its first colon. */
export function capabilityLabel(
  scope: string,
  labels: Record<string, string> = CAPABILITY_LABELS,
): string {
  if (typeof scope !== "string" || scope === "") return GENERIC_CAPABILITY_LABEL
  if (scope === "*") return WILDCARD_CAPABILITY_CATEGORY
  const colon = scope.indexOf(":")
  const app = colon === -1 ? scope : scope.slice(0, colon)
  return (Object.hasOwn(labels, app) ? labels[app] : undefined) ?? GENERIC_CAPABILITY_LABEL
}
