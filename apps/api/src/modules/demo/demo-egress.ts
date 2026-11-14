// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Outbound lockdown for demo orgs.
//
// A public demo box hands a stranger an admin account. Everything that account
// can reach from inside Liaison is fixture data and is meant to be poked at.
// Everything it could reach OUTSIDE Liaison is somebody else's inbox, somebody
// else's Shopify store or somebody else's money, so those doors are closed.
//
// REFUSE, NOT SINK. A blocked send throws with a message the visitor reads,
// rather than accepting the send and dropping it. A silent sink teaches the
// demo's most important lesson wrong: the visitor watches the product report
// "sent", believes mail works, and either files a support ticket about the
// message that never arrived or, worse, trusts the same behaviour on a real
// deployment. The refusal names the reason and names the instance, which is
// also the only version an auditor can verify from a log.
//
// The check is two conditions, both required: demo mode is on for the process
// AND this specific org carries the demo marker. So a normal deployment is
// untouched (demo mode off), and even on the demo box an org that is not marked
// is not restricted, which keeps the mechanism keyed on data rather than on a
// global that would have to be right for every tenant at once.
//
// WEB SEARCH is the one door that opens, and only partway: a VERIFIED visitor
// may search on this box's OpenRouter key (the web plugin, engine Exa),
// through the visitor spend gate (demo-budget.ts): a reservation per search,
// LIAISON_DEMO_WEB_SEARCH_PER_TURN per turn and
// LIAISON_DEMO_WEB_SEARCH_PER_EMAIL_PER_DAY per email per UTC day, at most 5
// results and a 500-character query (web-tools.ts). The box's own Exa key is
// never reachable from a visitor org. Its own key, Exa or OpenRouter, is its
// own business.
import type { ShippedLocale } from "@liaison/shared"
import type { PrivilegedDb, RlsClient } from "~/db"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import { loadDemoOrg } from "~/modules/demo/demo-org"
import { type ServerTParams, serverT } from "~/modules/i18n/server-i18n"

/** What a demo org is refused. One member per closed door. */
export type DemoRestrictedAction =
  /** Customer mail out through the sandbox SMTP bridge. */
  | "outbound_mail"
  /** Storing real third-party credentials (a credentials connection, an OAuth grant). */
  | "connector_credentials"
  /** The agent's `web_search` on this deployment's own key, outside the visitor gate. */
  | "web_search"
  /** A sandboxed app's outbound HTTP (`ctx.fetch`, `ctx.bulk.fetchToBlob`). */
  | "app_fetch"
  /** Adding, replacing or removing an API connector connection, or giving it credentials. */
  | "api_connector_change"
  /** A request the card-payments stand-in does not model (never answered empty). */
  | "payments_unsupported"

const MESSAGE_KEY: Record<DemoRestrictedAction, string> = {
  outbound_mail: "kernel.demo.mailBlocked",
  connector_credentials: "kernel.demo.connectorBlocked",
  web_search: "kernel.demo.webSearchBlocked",
  app_fetch: "kernel.demo.appFetchBlocked",
  api_connector_change: "kernel.demo.apiConnectorBlocked",
  payments_unsupported: "kernel.demo.paymentsUnsupported",
}

/**
 * Thrown when a demo org reaches for the outside world. Carries `status` and
 * `code`, which is the shape `errorHandler` turns into a real HTTP response
 * (403 FORBIDDEN-style envelope) and which a sandboxed tool result surfaces
 * verbatim instead of flattening to "Tool execution failed".
 */
export class DemoRestrictionError extends Error {
  readonly status = 403
  readonly code = "DEMO_RESTRICTED"
  constructor(
    message: string,
    readonly action: DemoRestrictedAction,
  ) {
    super(message)
    this.name = "DemoRestrictionError"
  }
}

/** The refusal message for `action`, in `locale`. */
export function demoRestrictionMessage(
  action: DemoRestrictedAction,
  locale: ShippedLocale = "en",
  params?: ServerTParams,
): string {
  return serverT(locale, MESSAGE_KEY[action], params)
}

/**
 * Throw if `orgId` is a demo org on a demo instance reaching for `action`.
 * A no-op (one cached read, usually zero queries) everywhere else, so this is
 * safe to call on the hot path of a normal deployment.
 */
export async function assertDemoEgressAllowed(
  orgId: string,
  action: DemoRestrictedAction,
  /** The caller's transaction, read on when it is a privileged one of this org. */
  on?: RlsClient | PrivilegedDb,
): Promise<void> {
  if (!isDemoModeEnabled()) return
  const { marker, locale } = await loadDemoOrg(orgId, on)
  if (!marker) return
  throw new DemoRestrictionError(demoRestrictionMessage(action, locale), action)
}

/**
 * True when `orgId` is a demo org on a demo instance, so every door an app
 * handler could open to the outside world is closed for it: mail is refused,
 * app egress is refused or answered from fixtures, and credentials cannot be
 * stored. For such an org no handler can have an UNKNOWN external outcome,
 * because nothing a handler does leaves the box. (The agent's own read-only
 * `web_fetch` is not a handler and reads public pages as on any org.) The approved-handler classifier reads this to report a
 * refused action as a definite failure rather than parking it as ambiguous.
 * False without a query on every normal deployment.
 */
export async function isDemoEgressRestricted(orgId: string): Promise<boolean> {
  if (!isDemoModeEnabled()) return false
  const { marker } = await loadDemoOrg(orgId)
  return marker !== null
}

/** A demo refusal, thrown on the host or carried across the sandbox boundary by its code. */
export function isDemoRestriction(err: unknown): boolean {
  if (err instanceof DemoRestrictionError) return true
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "DEMO_RESTRICTED"
  )
}

// ---------------------------------------------------------------------------
// The agent's web fetch, on a demo box.
//
// A demo org's `web_fetch` is a normal org's: its own `webFetchAllowlist` and
// `webFetchBlocklist` decide, and the default (both empty) reads any public
// page. There is no demo-specific fetch policy, so nothing for it lives here.
//
// That is not an open HTTP proxy. On a demo box every fetch is driven by a
// model step, and a visitor's steps are reserved and paid against the visitor
// budgets in demo-budget.ts (per email for its lifetime, per network per day,
// the box per day and per hour) and its turn slots and turns per minute. The
// web-read guardrails (agent/tools/web-read-guardrails.ts: reads per turn, in a
// row, distinct hosts, per conversation per hour) apply on top. So a visitor
// can only fetch a bounded number of pages, each one paid for. The SSRF guards
// in web-tools.ts (private, link-local and metadata ranges refused, the host
// pinned to its checked address, redirects re-checked and limited, the body
// size capped) are the same for every org. The visitor administers their own
// throwaway workspace and may narrow its allowlist; that only hurts them.

// ---------------------------------------------------------------------------
// The agent's web SEARCH, on a demo box.
//
// `web_search` spends: it calls Exa or OpenRouter on some key, and on a public
// box the deployment's own keys must not become a free search service. So:
//
// - An org with a key of its own (BYOK) searches on it, as anywhere else.
// - A VISITOR org with no key of its own searches on the box's OpenRouter key
//   through the visitor gate in web-tools.ts (`visitorBoxKeySearch`): each
//   search is counted by `takeWebSearch` in demo-budget.ts against
//   `LIAISON_DEMO_WEB_SEARCH_PER_TURN` and
//   `LIAISON_DEMO_WEB_SEARCH_PER_EMAIL_PER_DAY` (past either, the refusal is
//   `demoWebSearchLimitMessage` below), holds a reservation in the visitor
//   budget, and returns few, short results. The box's Exa key is never used
//   for a visitor: a visitor search that resolved the deployment's key is
//   refused by `demoWebSearchRefusal`.
// - The RESERVED App Review org searches on the deployment's key under
//   `LIAISON_DEMO_RESERVED_TOKEN_CEILING`, the same rolling ceiling its model
//   spend has: once that org has burnt its day of tokens it stops searching
//   too. A reviewer will not paste a key, and an agent refusing its own
//   advertised tool in front of App Review is the rejected build this org
//   exists to avoid.
//
// A refusal is a sentence the agent reads out, never a silent empty result:
// "no results" for every query would teach the visitor the search is broken.

/**
 * The refusal to hand back instead of running `web_search`, or null to mean
 * "run it exactly as before".
 *
 * Null on every normal deployment without a query, because the first line is
 * the demo-mode gate. `keySource` is the source `resolveKey` reported, or null
 * when no key resolved at all: a demo org with no key of its own gets the demo
 * explanation rather than the generic "not configured", which on a demo box
 * reads like a broken product rather than a deliberate boundary.
 */
export async function demoWebSearchRefusal(
  orgId: string,
  keySource: "byok" | "liaison" | null,
): Promise<string | null> {
  if (!isDemoModeEnabled()) return null
  const { marker, locale } = await loadDemoOrg(orgId)
  if (!marker) return null
  // An org that somehow holds its own key spends its own money: their call.
  if (keySource === "byok") return null
  // The reserved App Review org searches on the deployment's key, bounded by
  // the same rolling ceiling its model spend is bounded by.
  if (marker.variant === "reserved" && keySource === "liaison") {
    const { demoSpendExhausted } = await import("~/modules/demo/demo-spend")
    if (!(await demoSpendExhausted(orgId))) return null
    return serverT(locale, "kernel.demo.spendCeilingReached")
  }
  return demoRestrictionMessage("web_search", locale)
}

/**
 * The refusal of a visitor's search past its per-turn or per-day allowance:
 * the `demo_rate_limited` refusal (its copy is the demo door's).
 */
export async function demoWebSearchLimitMessage(orgId: string): Promise<string> {
  const { locale } = await loadDemoOrg(orgId)
  const { demoSpendMessage } = await import("~/modules/demo/demo-spend")
  return demoSpendMessage("demo_rate_limited", locale)
}

// ---------------------------------------------------------------------------
// A sandboxed app's outbound HTTP, on a demo box.
//
// `ctx.fetch` and `ctx.bulk.fetchToBlob` were governed only by the app
// manifest's declared `allowedDomains`, which is a supply-chain boundary
// ("this app may talk to Pennylane") and not a tenancy one. A demo org could
// therefore put real requests on the wire to app.pennylane.com, the Boxtal
// carrier API, graph.facebook.com and the VIES VAT service, from the demo box's
// address, carrying whatever the connection row held. Shopify was already the
// exception: its traffic is answered from fixtures and never forwarded.
//
// This closes the rest of the door the same way, and REFUSES rather than
// answering empty. An empty list is a lie a visitor cannot detect: "Pennylane
// has no invoices" and "Pennylane is not reachable from a demo" look identical
// on screen, and the first one is the demo teaching something false about the
// product. A refusal that names the host is the honest version, and it is also
// the SHAPE the sandbox already has: `validateSandboxFetchUrl` throws for a
// host off the manifest allowlist, and a fetch timeout throws, so every app
// that calls `ctx.fetch` already handles it throwing. This adds a better
// message to a path they all already survive.
//
// Shopify is deliberately NOT routed through here by `ctx.fetch`: the fixture
// provider answers first and this check is only reached when it declined, so
// the fixture behaviour is untouched and nothing is checked twice.

/**
 * Throw if `orgId` is a demo org on a demo instance making an outbound app
 * request to `url`. A no-op (one module-local boolean) on every normal
 * deployment, so this is safe on the sandbox fetch hot path.
 */
export async function assertDemoAppFetchAllowed(orgId: string, url: string): Promise<void> {
  if (!isDemoModeEnabled()) return
  const { marker, locale } = await loadDemoOrg(orgId)
  if (!marker) return
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    host = url
  }
  throw new DemoRestrictionError(demoRestrictionMessage("app_fetch", locale, { host }), "app_fetch")
}
