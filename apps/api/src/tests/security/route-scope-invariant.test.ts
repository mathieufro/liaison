// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Route scope invariant, enumerated from the booted app.
//
// A signed-in account that holds NO scope at all (no role, no grant) calls every
// session-gated route. A route that answers it 2xx is reachable by any member
// whatever their role, so it must be in ANY_MEMBER below with the reason that
// is acceptable (the caller's own data, a catalog with no org data, a list
// filtered to what the caller may see). Every other route must refuse (403) or
// fail for want of input. A new route that serves a scopeless account fails
// this file until it is reviewed.
//
// Org data for the probe: the org is bootstrapped (its admin, base agent and
// in-tree apps), and a thread and a contact exist, so a list route that leaks
// returns rows.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

/** `METHOD path` -> why a scopeless member may be answered. */
const ANY_MEMBER: Record<string, string> = {
  "GET /api/dashboards":
    "the caller's own personal dashboards and the org-visible ones, filtered by RLS; titles and specs only, each block's data is read with the viewer's own scopes",
  "GET /api/health": "public route, see route-auth-invariant.test.ts",
  "GET /api/health/ready": "public route, see route-auth-invariant.test.ts",
  "GET /api/settings/branding": "public route, see route-auth-invariant.test.ts",
  "GET /healthz": "public route, see route-auth-invariant.test.ts",
  "GET /api/client-policy":
    "public route: the minimum desktop and mobile client versions, read before sign-in",
  "GET /api/apps/host-api": "the app host API major versions this server supports, no org data",
  "GET /api/connections/oauth-done":
    "the static page an OAuth popup lands on; it carries no data and closes itself",
  "GET /api/imports/uploads/config":
    "the instance's upload mode and size limits, the same for every member",
  "GET /api/auth/bootstrap-state": "public route, see route-auth-invariant.test.ts",
  "GET /api/auth/totp/status": "the caller's own sign-in factors and WebSocket ticket",
  "POST /api/auth/totp/step-up": "the caller's own sign-in factors and WebSocket ticket",
  "GET /api/auth/oauth/providers": "public route, see route-auth-invariant.test.ts",
  "POST /api/auth/ws-ticket": "the caller's own sign-in factors and WebSocket ticket",
  "GET /api/users/me": "the caller's own profile",
  "PATCH /api/users/me": "the caller's own profile",
  "DELETE /api/users/me/avatar": "the caller's own profile",
  "GET /api/notifications/badge":
    "the caller's own unread count, read as that user: a number with no content",
  "GET /api/notifications/conversations":
    "the caller's own muted and all-posts conversations, read under their RLS",
  "GET /api/notifications/on-call":
    "who is on call for incidents, shown to every member as names; the member list takes kernel:org:admin",
  "GET /api/notifications/settings": "the caller's own notification settings and devices",
  "PATCH /api/notifications/settings": "the caller's own notification settings and devices",
  "DELETE /api/notifications/desktop-devices/:deviceId":
    "the caller's own notification settings and devices",
  "DELETE /api/notifications/browser-subscriptions/:deviceId":
    "the caller's own notification settings and devices",
  "POST /api/notifications/test": "the caller's own notification settings and devices",
  "GET /api/notifications/web-push/config": "the caller's own notification settings and devices",
  "GET /api/notifications/devices": "the caller's own notification settings and devices",
  "GET /api/user/preferences": "the caller's own notification settings and devices",
  "GET /api/user/preferences/away":
    "the caller's own away ranges and next in line, and who in the org is away (active ranges only, as the away_ranges select policy shows every member)",
  "GET /api/user/preferences/away/standing-in":
    "who names the caller as next in line today: the caller's own Home line",
  "POST /api/user/preferences/away/:id/end": "ends one of the caller's own away ranges only",
  "DELETE /api/user/preferences/away/:id": "undoes one of the caller's own away ranges only",
  "GET /api/apps/features":
    "the features switched on in the workspace, read with the shell's app list; names only, no org data",
  "GET /api/home/brief":
    "the caller's own morning brief, read from their own routine's thread under their RLS",
  "GET /api/nodes/me/attachments": "the caller's own computers",
  "GET /api/nodes/me": "the caller's own computers",
  "GET /api/nodes/me/jobs": "the caller's own computers",
  "GET /api/nodes/me/profiles": "the caller's own computers",
  "GET /api/tours":
    "the guided-tour catalogue (code, no org data) filtered to the org's installed apps and the caller's own scopes, with the caller's own progress (tour_progress RLS: own rows only)",
  "GET /api/org": "org name, timezone and business hours, shown to every member",
  "GET /api/sharing/members":
    "sharing pickers: member names and role names, by design for any member",
  "GET /api/sharing/roles":
    "sharing pickers: member names and role names, by design for any member",
  "GET /api/apps/mcp-manager/oauth/done": "public route, see route-auth-invariant.test.ts",
  "GET /api/apps/manifests": "app manifests and connection type definitions, no org data",
  "GET /api/apps/connections": "app manifests and connection type definitions, no org data",
  "GET /api/attention-items": "the caller's own attention feed and rules, filtered per row",
  "GET /api/attention/subscriptions": "the caller's own attention feed and rules, filtered per row",
  "GET /api/apps/manifests/attention-axes":
    "app manifests and connection type definitions, no org data",
  "GET /api/v1/slots/:slot": "app manifests and connection type definitions, no org data",
  "POST /api/connections/links/peek":
    "a one-time connect link, looked up by its secret token: what it connects, for the person it was minted for only",
  "GET /api/bug-reports/forwarding":
    "whether the deployment offers forwarding a bug report, the same for every member",
  "GET /api/bug-reports/drafts":
    "the caller's own bug report drafts (keyed by org and user), as open to every member as filing a report",
  "GET /api/connections": "the caller's own connections (RLS), empty for a scopeless member",
  "GET /api/connections/:appName":
    "the caller's own connections (RLS), empty for a scopeless member",
  "GET /api/credits/models": "the org's credit balance and model list, shown to every member",
  "GET /api/credits/balance": "the org's credit balance and model list, shown to every member",
  "GET /api/billing/state": "the org's credit balance and model list, shown to every member",
  "GET /api/scope-requests": "the caller's own scope requests",
  "GET /api/knowledge/documents":
    "knowledge reads filtered by the sharing ACL and dimensions; empty here",
  "POST /api/knowledge/search":
    "knowledge reads filtered by the sharing ACL and dimensions; empty here",
  "GET /api/knowledge/collections/tree":
    "knowledge reads filtered by the sharing ACL and dimensions; empty here",
  "GET /api/knowledge/collections":
    "knowledge reads filtered by the sharing ACL and dimensions; empty here",
  "GET /api/knowledge/tags":
    "knowledge reads filtered by the sharing ACL and dimensions; empty here",
  "GET /api/knowledge/home":
    "knowledge reads filtered by the sharing ACL and dimensions; empty here",
  "GET /api/knowledge/synced-sources":
    "knowledge reads filtered by the sharing ACL and dimensions; empty here",
  "GET /api/files/delivery": "deployment file delivery mode",
  "GET /api/assist/capabilities":
    "whether dictation is available in the org and the caller's own clean-up default",
  "GET /.well-known/oauth-protected-resource": "public route, see route-auth-invariant.test.ts",
  "GET /.well-known/oauth-authorization-server": "public route, see route-auth-invariant.test.ts",
  "GET /.well-known/mcp": "public route, see route-auth-invariant.test.ts",
  "GET /api/mcp/connections": "the caller's own MCP connections and the server URL",
  "GET /api/mcp/connect-info": "the caller's own MCP connections and the server URL",
}

const SKIP = [
  /^\/api\/_test\//,
  /^\/api\/agent\/chat/,
  /^\/mcp/,
  /^\/webhooks\//,
  /^\/api\/auth\/(logout|account)/,
]

const UUID = "00000000-0000-4000-8000-000000000001"
function concretePath(path: string): string {
  return path
    .replace(/:key\{\.\+\}/g, "a/b")
    .replace(/:[A-Za-z_]+(\{[^}]*\})?/g, (m) => (/(id|Id)$/.test(m.split("{")[0]) ? UUID : "x1"))
}

let token = ""
const answered: string[] = []

beforeAll(async () => {
  await acquireTestLock()
  const org = await createTestOrg()
  const [admin] = await withSystemDb("scope-probe-admin", (db) =>
    db.select({ id: users.id }).from(users).where(eq(users.orgId, org.id)).limit(1),
  )
  await minimal.thread(org.id, admin!.id)
  await minimal.contact(org.id, `scope-probe-${crypto.randomUUID()}@example.com`)
  const [u] = await withSystemDb("scope-probe-user", (db) =>
    db
      .insert(users)
      .values({
        orgId: org.id,
        email: `noscope-${crypto.randomUUID()}@t.co`,
        name: "No Scope",
        status: "active",
      })
      .returning({
        id: users.id,
        authVersion: users.authVersion,
        permissionVersion: users.permissionVersion,
      }),
  )
  token = await signAccessToken(
    {
      userId: u!.id,
      orgId: org.id,
      name: "No Scope",
      authVersion: u!.authVersion,
      permissionVersion: u!.permissionVersion,
      roles: [],
      scopes: [],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
    3600,
  )
  const seen = new Set<string>()
  for (const r of app.routes) {
    if (r.method === "ALL" || r.method === "OPTIONS") continue
    if (SKIP.some((re) => re.test(r.path))) continue
    const key = `${r.method} ${r.path}`
    if (seen.has(key)) continue
    seen.add(key)
    const init: RequestInit = {
      method: r.method,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    }
    if (r.method !== "GET" && r.method !== "HEAD") init.body = "{}"
    const res = await app.request(concretePath(r.path), init)
    if (res.status >= 200 && res.status < 300) {
      const body = (await res.text()).slice(0, 160).replace(/\s+/g, " ")
      answered.push(`${key} -> ${res.status} ${body}`)
    }
  }
}, 600_000)

afterAll(releaseTestLock)

describe("route scope invariant (a scopeless member against every session route)", () => {
  it("every route that answers a scopeless member is a reviewed any-member route", () => {
    const unreviewed = answered.filter((a) => !(a.split(" -> ")[0]! in ANY_MEMBER))
    expect(unreviewed).toEqual([])
  })
})
