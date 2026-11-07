// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Privileged database sites, classified by where their org id comes from
// (security invariant, extends role-elevation-sites.test.ts).
//
// withPrivilegedDb / withSystemDb run as a BYPASSRLS role, so the org a query
// is pinned to is whatever the caller passed. The enumerator
// (test-support/security/enumerate.ts) lists every call site and traces the org
// id expression. Two classes need a person to have read the site:
//
//   - a site inside a route handler whose org id is not the authenticated
//     context (a URL parameter, a row looked up first, no org at all);
//   - a site whose org id could not be traced (`unknown`) or is a literal.
//
// Outside route handlers, a site whose org id is a parameter of its function is
// as safe as what that function's callers pass. The enumerator follows the
// parameter to every caller (imports resolved, through factories, aliases and
// loops) until it reaches the request's auth context, a job payload or a
// reviewed source, dispatcher, origin or registry
// (test-support/security/privileged-org-reviews.ts); such a site is `traced`.
// One that is not traced, and every untraced or literal org id, needs a
// reviewed entry there. The trace matches callers by name with imports
// resolved and local names scoped, so a few reviews dismiss a name collision
// and say so.
//
// Each reviewed site is listed by file and enclosing function with the reason
// it is safe. A new site of any class fails here until it is reviewed.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  enumeratePrivilegedSites,
  LIAISON_ROOT,
  type SurfaceRow,
  serverSourceFiles,
} from "../../test-support/security/enumerate"
import {
  REVIEWED_CALLERS,
  REVIEWED_DISPATCH,
  REVIEWED_ORIGINS,
  REVIEWED_OUTSIDE_ROUTES,
  REVIEWED_REGISTRIES,
  REVIEWS,
  TRUSTED_SOURCES,
} from "../../test-support/security/privileged-org-reviews"

/** `file#enclosing` → why the org id is safe there. */
const REVIEWED: Record<string, string> = {
  // Public endpoints keyed by a capability in the URL: the org id in the path
  // only narrows the lookup, the token / API key / signature is the authority.
  "apps/api/src/modules/webhooks/tickets-public.ts#POST /:orgId/tickets/csat/:token":
    "row matched on org_id AND survey_token (tickets-public.ts:316)",
  "apps/api/src/modules/webhooks/routes.ts#POST /:orgId/:appName/:endpointName":
    "org from the registration found under the URL key; signature verified before the handler",
  "apps/api/src/modules/webhooks/routes.ts#GET /:orgId/:appName/:endpointName":
    "org from the registration; verify token compared in constant time",
  // Org from a row the caller's own org owns (ownership checked first).
  "apps/api/src/modules/agent/routines/routines-routes.ts#GET /:id/runs":
    "actor from extractRlsContext via ownedRoutine (owner + org check)",
  "apps/api/src/modules/agent/routines/routines-routes.ts#GET /:id/runs/:runId/messages":
    "actor from extractRlsContext via ownedRoutine (owner + org check)",
  // The session's own org, checked to be a visitor demo org first.
  "apps/api/src/modules/demo/routes.ts#GET /budget":
    "org from requireVisitorOrg: c.get('orgId'), a 404 unless it is a visitor demo org",
}

/**
 * Route handlers that use withSystemDb on pre-auth or global tables, or whose
 * org comes from a capability (a token, a device code, a node credential), keyed
 * by `file#handler` so a new handler in the same file is reviewed on its own.
 */
const REVIEWED_SYSTEM_ROUTES: Record<string, string> = {
  "apps/api/src/apps/mcp-manager/routes.ts#mcpManagerRoutes.PATCH /connections/:id":
    "clears the health row (keyed by connection id) of a connection loaded first in the caller's org",
  "apps/api/src/apps/mcp-manager/oauth-routes.ts#mcpManagerOAuthRoutes.GET /oauth/callback":
    "the OAuth state row is the capability; the connection's org is checked against it after",
  "apps/api/src/apps/mcp-manager/oauth-routes.ts#mcpManagerOAuthRoutes.POST /oauth/handoff":
    "global OAuth state table (mcp_oauth_state) read by the state id of a parked shell grant, which claimConnectHandoff hands out only when its org and user equal the caller's session (actor.orgId / actor.userId) and the PKCE verifier matches; the grant was parked by the callback from that state row's initiator",
  "apps/api/src/apps/mcp-manager/routes.ts#mcpManagerRoutes.GET /connections":
    "health and last-call reads keyed by the ids of the caller's RLS-visible connections (admin-scoped route)",
  "apps/api/src/modules/agent/directory/definition-routes.ts#GET /:agentId/activity":
    "audit rows filtered to the agent resolvePageAgent found visible in the caller's org (row.orgId, row.id); admin or owner only",
  "apps/api/src/modules/agent/directory/definition-routes.ts#GET /:agentId/settings":
    "agents.orgId = c.get('orgId') in the query",
  "apps/api/src/modules/agent/directory/definition-routes.ts#PATCH /:agentId":
    "read and update both filter agents.orgId = the caller's org",
  "apps/api/src/modules/agent/directory/definition-routes.ts#POST /":
    "inserts with the caller's org id",
  "apps/api/src/modules/agent/directory/definition-routes.ts#POST /:agentId/archive":
    "the org check reads the target's org and 404s unless it is the caller's; the read-back runs only after that check",
  "apps/api/src/modules/agent/local-sessions/local-session-routes.ts#POST /:agentId/local-sessions/:sessionId/events":
    "claims read for the caller's org and thread; acts only when the claim is the caller's own",
  "apps/api/src/modules/agent/local-sessions/local-session-routes.ts#POST /:agentId/local-sessions/:sessionId/reply":
    "claims read for the caller's org and thread; 409 unless the caller holds the claim",
  "apps/api/src/modules/agent/memory/memory-routes.ts#POST /:agentId/memory/forget":
    "admin-only lookup of a thread by handle within the caller's org (threads.orgId = orgId)",
  "apps/api/src/modules/apps/install-routes.ts#GET /":
    "global catalog tables (apps_installed, apps_active_version)",
  "apps/api/src/modules/apps/install-routes.ts#POST /:name/ui-approval":
    "global catalog table apps_installed; the route requires the apps admin scope",
  "apps/api/src/modules/apps/install-routes.ts#POST /:name/upgrade/apply":
    "global catalog table apps_active_version; the route requires the apps admin scope",
  "apps/api/src/modules/apps/install-routes.ts#POST /:name/upgrade/preview":
    "global catalog table apps_active_version; the route requires the apps admin scope",
  "apps/api/src/modules/apps/ui-bundle-routes.ts#uiBundleRoutes.GET /:name/:version/ui.js":
    "global catalog table",
  "apps/api/src/modules/apps/ui-bundle-routes.ts#uiBundleRoutes.GET /:name/:version/frame":
    "global catalog table",
  "apps/api/src/modules/apps/ui-bundle-routes.ts#uiBundleRoutes.GET /:name/:version/:file{statement\\.json|statement\\.sig|manifest\\.json}":
    "global catalog table",
  "apps/api/src/modules/auth/device-flow-routes.ts#GET /poll/:deviceCode":
    "the device code is the capability",
  "apps/api/src/modules/auth/device-flow-routes.ts#POST /initiate":
    "pre-auth: creates a device code",
  "apps/api/src/modules/auth/oauth-routes.ts#GET /:providerId/authorize":
    "pre-auth: provider lookup by org slug",
  "apps/api/src/modules/auth/oauth-routes.ts#GET /providers":
    "pre-auth: provider lookup by org slug",
  "apps/api/src/modules/auth/routes.ts#DELETE /totp":
    "the caller's own user; the audit event carries the caller's org",
  "apps/api/src/modules/auth/routes.ts#GET /invites/:token/validate":
    "the invite token is the capability",
  "apps/api/src/modules/auth/routes.ts#POST /login":
    "pre-auth: user lookup by email, then the password check",
  "apps/api/src/modules/auth/routes.ts#POST /logout":
    "the audit event carries the caller's own org",
  "apps/api/src/modules/auth/routes.ts#POST /magic-link/verify":
    "the magic-link token is the capability",
  "apps/api/src/modules/auth/routes.ts#POST /password-reset/confirm":
    "the reset token is the capability",
  "apps/api/src/modules/auth/routes.ts#POST /password-reset/request":
    "pre-auth: user lookup by email; the answer is the same whether it exists",
  "apps/api/src/modules/auth/routes.ts#POST /password/change":
    "the caller's own user; the audit event carries the caller's org",
  "apps/api/src/modules/auth/routes.ts#POST /register": "pre-auth: registration",
  "apps/api/src/modules/auth/routes.ts#POST /totp/verify":
    "the pending-2FA token names the user; the org is that user's own row",
  "apps/api/src/modules/branding/routes.ts#GET /branding": "public org name and branding by slug",
  "apps/api/src/modules/mcp/device-grant-routes.ts#DELETE /:deviceCode":
    "the device code is the capability",
  "apps/api/src/modules/mcp/device-grant-routes.ts#GET /poll/:deviceCode":
    "the device code is the capability",
  "apps/api/src/modules/mcp/device-grant-routes.ts#POST /initiate":
    "pre-auth: creates a device code",
  "apps/api/src/modules/mcp/oauth-server-routes.ts#POST /authorize/consent":
    "the caller's own user consents for a registered client",
  "apps/api/src/modules/mcp/oauth-server-routes.ts#POST /register":
    "OAuth client registry (global)",
  "apps/api/src/modules/mcp/oauth-server-routes.ts#POST /token":
    "the authorization code or refresh token is the capability",
  "apps/api/src/modules/nodes/attachments.ts#POST /me/attachments":
    "node credential is the authority; the agent is read within the node's org",
  "apps/api/src/modules/nodes/job-routes.ts#POST /jobs/:id/result":
    "node credential is the authority; the agent is read within the reserved job's org",
  "apps/api/src/modules/nodes/permission-prompts.ts#POST /jobs/:id/permission-requests":
    "node credential is the authority; org from the authenticated node row",
  "apps/api/src/modules/nodes/turn-progress-routes.ts#POST /jobs/:id/turn-progress":
    "node credential is the authority; org from the authenticated node row, job fenced by lease holder",
  "apps/api/src/modules/nodes/routes.ts#PUT /:id/capabilities":
    "node credential is the authority; org from the authenticated node row",
}

const NEEDS_REVIEW = new Set(["caller-input", "db-derived", "unknown", "literal", "no-org"])

const keyOf = (r: SurfaceRow) => `${r.location.replace(/:\d+$/, "")}#${r.attrs.enclosing}`

/** Outside route handlers: a parameter, request input, untraced or literal org id. */
function needsOutsideReview(r: SurfaceRow): boolean {
  if (r.attrs.inRouteHandler) return false
  const source = String(r.attrs.orgIdSource)
  if (source === "literal" || source === "unknown") return !traced(r)
  if (source === "caller-input") return !traced(r)
  return false
}

/** Route-handler sites whose org id is not the auth context and that no entry reviews. */
function unreviewedRouteSites(rows: SurfaceRow[]): string[] {
  const unreviewed: string[] = []
  for (const r of rows) {
    if (!r.attrs.inRouteHandler) continue
    if (!NEEDS_REVIEW.has(String(r.attrs.orgIdSource))) continue
    const key = keyOf(r)
    if (REVIEWED[key] || REVIEWED_SYSTEM_ROUTES[key]) continue
    unreviewed.push(`${r.location} ${r.attrs.enclosing} (${r.attrs.orgIdSource})`)
  }
  return unreviewed
}

const traced = (r: SurfaceRow) => String(r.attrs.orgIdTrace ?? "").startsWith("traced")

describe("privileged sites by org-id source", () => {
  const rows = enumeratePrivilegedSites(serverSourceFiles(), undefined, undefined, REVIEWS)

  test("the enumerator finds the privileged pool", () => {
    expect(rows.length).toBeGreaterThan(500)
  })

  test("every route-handler site whose org id is not the auth context is reviewed", () => {
    expect(unreviewedRouteSites(rows)).toEqual([])
  })

  test("a new handler in a file with reviewed handlers fails until it is reviewed", () => {
    const file = path.join(LIAISON_ROOT, "apps/api/src/modules/auth/routes.ts")
    const text = `import { Hono } from "hono"
import { withSystemDb } from "~/db/privileged"
export const auth = new Hono()
auth.post("/register", async (c) => {
  await withSystemDb("register", (db) => db.select())
  return c.json({})
})
auth.get("/everyone", async (c) => {
  const all = await withSystemDb("all-users", (db) => db.select())
  return c.json(all)
})
`
    const synthetic = enumeratePrivilegedSites([file], LIAISON_ROOT, new Map([[file, text]]))
    expect(synthetic.filter((r) => r.attrs.inRouteHandler)).toHaveLength(2)
    expect(unreviewedRouteSites(synthetic)).toEqual([
      "apps/api/src/modules/auth/routes.ts:9 GET /everyone (no-org)",
    ])
  })

  test("every site outside a route handler whose org id is a parameter is traced or reviewed", () => {
    const unreviewed: string[] = []
    for (const r of rows) {
      if (!needsOutsideReview(r)) continue
      if (REVIEWED_OUTSIDE_ROUTES[keyOf(r)]) continue
      unreviewed.push(
        `${r.location} ${r.attrs.enclosing} (${r.attrs.orgIdSource}): ${r.attrs.orgIdTrace ?? r.attrs.orgIdDetail}`,
      )
    }
    expect(unreviewed).toEqual([])
  })

  test("no reviewed outside-route entry, source, dispatch, origin or registry is stale", () => {
    const needing = new Set(rows.filter(needsOutsideReview).map(keyOf))
    const traces = rows.map((r) => String(r.attrs.orgIdTrace ?? "")).join("\n")
    const stale = [
      ...Object.keys(REVIEWED_OUTSIDE_ROUTES).filter((k) => !needing.has(k)),
      ...Object.keys(TRUSTED_SOURCES).filter((n) => !traces.includes(`reviewed ${n}()`)),
      ...Object.keys(REVIEWED_DISPATCH).filter(
        (n) => !traces.includes(`reviewed dispatch of ${n}`),
      ),
      ...Object.keys(REVIEWED_ORIGINS).filter((k) => !traces.includes(`reviewed origin ${k}`)),
      ...Object.keys(REVIEWED_REGISTRIES).filter((k) => !traces.includes(`reviewed registry ${k}`)),
    ]
    expect(stale).toEqual([])
  })

  test("a function reviewed for having no product caller keeps exactly its pinned callers", () => {
    const sources = serverSourceFiles().map((file) => ({
      file: path.relative(LIAISON_ROOT, file).split(path.sep).join("/"),
      // Comments may name a function without calling it.
      code: readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1"),
    }))
    const drift: string[] = []
    for (const [key, pinned] of Object.entries(REVIEWED_CALLERS)) {
      const name = key.slice(key.indexOf("#") + 1)
      const use = new RegExp(`(?<!function\\s+)\\b${name}\\b`)
      const callers = sources.filter((s) => use.test(s.code)).map((s) => s.file)
      const actual = [...callers].sort()
      if (JSON.stringify(actual) !== JSON.stringify([...pinned].sort())) {
        drift.push(
          `${key}: product callers ${JSON.stringify(actual)}, reviewed for ${JSON.stringify(pinned)}. Rewrite its entry in test-support/security/privileged-org-reviews.ts for the new caller's org id, then pin it in REVIEWED_CALLERS.`,
        )
      }
    }
    expect(drift).toEqual([])
  })

  test("no reviewed entry is stale", () => {
    const keys = new Set(rows.map(keyOf))
    const stale = [
      ...Object.keys(REVIEWED).filter((k) => !keys.has(k)),
      ...Object.keys(REVIEWED_SYSTEM_ROUTES).filter((k) => !keys.has(k)),
    ]
    expect(stale).toEqual([])
  })
})
