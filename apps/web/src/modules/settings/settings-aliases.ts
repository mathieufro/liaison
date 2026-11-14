// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every former settings URL and the page that replaced it.
//
// Settings paths are stored where the web cannot rewrite them: OAuth callback
// redirects, attention rows (`metadata.settingsRoute`), digest emails, an
// agent's earlier answers, people's bookmarks. So a path that moved stays an
// alias for good, and this file is the one list of them. `SettingsLayout`
// reads it: a path no registered section claims is looked up here and replaced
// with its new home (query string kept, so `?oauth_error=` and `?dimension=`
// survive the hop).
//
// While an app still registers its former pages (it has no declarative
// `settings` page yet), those pages keep answering their own paths: a
// registered section always wins over an alias.

export interface SettingsAlias {
  /** The former path (exact pathname, no query). */
  from: string
  /** Where it lands: a path, optionally with a query (`?open=<app>`). */
  to: string
}

/** The App store (renders the apps catalog until the store ships). */
export const SETTINGS_STORE_PATH = "/settings/store"
/** The Connectors page. */
export const SETTINGS_CONNECTORS_PATH = "/settings/connectors"
/** An MCP server's page on Connectors (`/settings/connectors/mcp/<id>`). */
export const SETTINGS_MCP_DETAIL_PREFIX = "/settings/connectors/mcp/"
/** AI > Agent behavior. */
export const SETTINGS_AGENT_BEHAVIOR_PATH = "/settings/ai/agent-behavior"
/** You > Connected tools. */
export const SETTINGS_CONNECTED_TOOLS_PATH = "/settings/connected-tools"

/**
 * The parent of every app's settings page. Alone it is a former path (the old
 * apps list, now the App store); a frame asking for it gets its own app's page.
 */
export const SETTINGS_APPS_ROOT = "/settings/apps"

/** An app's one settings page. */
export function appSettingsPath(appId: string): string {
  return `${SETTINGS_APPS_ROOT}/${appId}`
}

/** A connector's card on the Connectors page, opened. */
export function connectorSettingsPath(appId: string): string {
  return `${SETTINGS_CONNECTORS_PATH}?open=${encodeURIComponent(appId)}`
}

const toApp = (appId: string, ...from: string[]): SettingsAlias[] =>
  from.map((f) => ({ from: f, to: appSettingsPath(appId) }))

const toConnector = (appId: string, ...from: string[]): SettingsAlias[] =>
  from.map((f) => ({ from: f, to: connectorSettingsPath(appId) }))

const to = (target: string, ...from: string[]): SettingsAlias[] =>
  from.map((f) => ({ from: f, to: target }))

/** Exact former paths. */
export const SETTINGS_ALIASES: readonly SettingsAlias[] = [
  // You
  ...to("/settings/notifications", "/settings/attention", "/settings/attention-rules"),
  ...to(
    SETTINGS_CONNECTED_TOOLS_PATH,
    "/settings/connections",
    "/settings/mcp",
    "/settings/mcp-connections",
  ),
  ...to(
    "/settings/security",
    "/settings/admin/integrations",
    "/settings/admin/oauth",
    "/settings/admin/sign-in-security",
  ),
  // AI
  ...to(
    SETTINGS_AGENT_BEHAVIOR_PATH,
    "/settings/admin/agent-safety",
    "/settings/admin/media-analysis",
  ),
  // Workspace
  ...to("/settings/admin/org", "/settings/admin/data-export"),
  ...to(
    "/settings/admin/roles",
    "/settings/admin/scope-requests",
    "/settings/admin/dimension-grants",
  ),
  ...to(SETTINGS_STORE_PATH, "/settings/admin/apps", SETTINGS_APPS_ROOT),
  ...to(SETTINGS_CONNECTORS_PATH, "/settings/admin/mcp-servers"),
  // Apps
  ...toApp(
    "tickets",
    "/settings/tickets",
    "/settings/tickets/inboxes",
    "/settings/tickets/categories",
    "/settings/tickets/sla-email",
    "/settings/tickets/api-keys",
    "/settings/tickets/signature",
    "/settings/admin/sla",
    "/settings/admin/email",
  ),
  ...toApp("mail", "/settings/mail", "/settings/mail/accounts", "/settings/mail/providers"),
  ...toApp("calendar", "/settings/calendar/connections", "/settings/calendar/accounts"),
  ...toApp("knowledge", "/settings/knowledge/synced-sources"),
  ...toApp("invoicing", "/settings/invoicing"),
  ...toApp("shopify", "/settings/shopify"),
  ...toApp("boxtal", "/settings/boxtal"),
  ...toApp("social", "/settings/social"),
  ...toApp("ads", "/settings/ads"),
  // Connectors
  ...toConnector("gitlab", "/settings/gitlab"),
  ...toConnector("database", "/settings/database"),
  ...toConnector("google-drive", "/settings/google-drive"),
  ...toConnector("pennylane", "/settings/pennylane"),
  ...toConnector("stripe", "/settings/stripe"),
  ...toConnector("api-connector", "/settings/api-connector"),
]

/** Former path PREFIXES: the rest of the path is carried over. */
export const SETTINGS_ALIAS_PREFIXES: readonly SettingsAlias[] = [
  { from: "/settings/admin/mcp-servers/", to: SETTINGS_MCP_DETAIL_PREFIX },
]

/**
 * The new home of a former settings path, or null when the path never moved.
 * `search` is the current query (with or without `?`): it is merged into the
 * target's own query, the target's keys winning.
 */
export function resolveSettingsAlias(pathname: string, search = ""): string | null {
  const exact = SETTINGS_ALIASES.find((a) => a.from === pathname)
  let target: string | null = exact ? exact.to : null
  if (!target) {
    const prefix = SETTINGS_ALIAS_PREFIXES.find(
      (a) => pathname.startsWith(a.from) && pathname.length > a.from.length,
    )
    if (prefix) target = prefix.to + pathname.slice(prefix.from.length)
  }
  if (!target) return null
  return withQuery(target, search)
}

/** `target` with `search` merged into its query (target keys win). */
export function withQuery(target: string, search: string): string {
  const [path, targetQuery = ""] = target.split("?")
  const merged = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
  for (const [k, v] of new URLSearchParams(targetQuery)) merged.set(k, v)
  const q = merged.toString()
  return q ? `${path}?${q}` : path
}

/** The pathname part of an alias target. */
export function aliasTargetPath(target: string): string {
  return target.split("?")[0]
}
