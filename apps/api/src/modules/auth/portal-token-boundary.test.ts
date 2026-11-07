// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The token side of the boundary around an external user (a client who signs in
// to the portal). A session of an external row is a portal token at every mint,
// no access token can be signed for one, and a portal token opens nothing of the
// member product: the walk below requests every route the booted app registers
// with a real one, for a real active row, so only the audience stands in the way.
// A new route is tested by being registered.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { eq } from "drizzle-orm"
import type { Context } from "hono"
import * as jose from "jose"
import { type AppEnv, app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { sessions } from "~/db/schema/kernel"
import { hashPassword } from "~/lib/crypto"
import { _setEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { markBootComplete, ReadinessTestAccess } from "~/lib/readiness"
import { restToolCall } from "~/modules/apps/rest-tool-call"
import { changePassword, createSession, refreshSession } from "~/modules/auth/auth"
import { signAccessToken, signPortalToken, verifyAccessToken } from "~/modules/auth/jwt"
import { cleanupSeededOrg, seedOrgWithUser } from "~/modules/mcp/test-helpers"
import { createExternalUser } from "~/modules/users/external-user"
import { insertSql } from "~/seed/factories/org/test-rows"

let orgId: string
let memberId: string
let externalId: string
let portalToken: string
let memberToken: string

async function newExternal(label: string): Promise<string> {
  const result = await withPrivilegedDb(orgId, "portal-token-test-external", (tx) =>
    createExternalUser(tx, {
      orgId,
      companyId: crypto.randomUUID(),
      email: `${label}-${crypto.randomUUID().slice(0, 8)}@client.example`,
      name: "Client",
    }),
  )
  if (!result.ok) throw new Error(result.code)
  return result.userId
}

function claims(token: string) {
  return jose.decodeJwt(token) as jose.JWTPayload & Record<string, unknown>
}

function expectPortalClaims(token: string) {
  const c = claims(token)
  expect(c.aud).toBe("portal")
  // A portal token carries who, never what they may do.
  expect(c.scopes).toBeUndefined()
  expect(c.roles).toBeUndefined()
  expect(c.dimensionGrants).toBeUndefined()
}

beforeAll(async () => {
  const seeded = await seedOrgWithUser()
  orgId = seeded.orgId
  memberId = seeded.userId
  externalId = await newExternal("walk")
  portalToken = (await createSession(externalId, orgId)).accessToken
  memberToken = (await createSession(memberId, orgId)).accessToken
})

afterAll(async () => {
  await withSystemDb("portal-token-test-sessions", (db) =>
    db.delete(sessions).where(eq(sessions.orgId, orgId)),
  )
  await cleanupSeededOrg(orgId)
})

describe("signing", () => {
  const identity = {
    userId: crypto.randomUUID(),
    orgId: crypto.randomUUID(),
    name: "Client",
    authVersion: 1,
    permissionVersion: 1,
  }

  it("signAccessToken refuses an external user", async () => {
    await expect(
      signAccessToken({ ...identity, userType: "external" }, env.JWT_SECRET),
    ).rejects.toThrow("external user")
  })

  it("the person's type is never a claim of an access token", async () => {
    const token = await signAccessToken({ ...identity, userType: "member" }, env.JWT_SECRET)
    expect(claims(token).userType).toBeUndefined()
    expect(claims(token).aud).toBe("access")
  })

  it("a portal token has audience portal and verifyAccessToken refuses it", async () => {
    const token = await signPortalToken(identity, env.JWT_SECRET)
    expectPortalClaims(token)
    await expect(verifyAccessToken(token, env.JWT_SECRET)).rejects.toThrow()
  })
})

describe("a session mint chooses by the row's type", () => {
  it("a member's session is an access token", () => {
    expect(claims(memberToken).aud).toBe("access")
  })

  it("an external row's session is a portal token", () => {
    expectPortalClaims(portalToken)
    expect(claims(portalToken).userId).toBe(externalId)
  })

  it("a direct wildcard grant on an external row adds nothing: portal token, not an admin", async () => {
    const id = await newExternal("wildcard")
    await sql.unsafe(
      insertSql("kernel.user_scope_grants", { user_id: id, org_id: orgId, scope: "*" }),
    )
    const pair = await createSession(id, orgId)
    expectPortalClaims(pair.accessToken)
    expect(pair.admin).toBe(false)
  })

  it("a device-flow ceiling on an external row's session is still a portal token", async () => {
    const id = await newExternal("device")
    expectPortalClaims((await createSession(id, orgId, ["kernel:threads:read"])).accessToken)
  })

  it("the second-factor branch of a session mint is a portal token too", async () => {
    const id = await newExternal("second-factor")
    await sql.unsafe(
      insertSql("kernel.user_scope_grants", { user_id: id, org_id: orgId, scope: "*" }),
    )
    await sql`UPDATE kernel.organizations SET settings = jsonb_set(settings, '{requireAdminSecondFactor}', 'true') WHERE id = ${orgId}`
    try {
      const token = (await createSession(id, orgId)).accessToken
      expectPortalClaims(token)
      expect(claims(token).secondFactorRequired).toBeUndefined()
    } finally {
      await sql`UPDATE kernel.organizations SET settings = settings - 'requireAdminSecondFactor' WHERE id = ${orgId}`
    }
  })

  it("a refresh of an external row's session is a portal token", async () => {
    const id = await newExternal("refresh")
    const first = await createSession(id, orgId)
    expectPortalClaims((await refreshSession(first.refreshToken)).accessToken)
  })

  it("a password change on an external row mints a portal token", async () => {
    const id = await newExternal("password")
    await sql`UPDATE kernel.users SET password_hash = ${await hashPassword("old-pass-1234")} WHERE id = ${id}`
    await sql.unsafe(
      insertSql("kernel.user_scope_grants", { user_id: id, org_id: orgId, scope: "*" }),
    )
    const pair = await changePassword(id, "old-pass-1234", "new-pass-5678")
    expectPortalClaims(pair.accessToken)
    expect(pair.admin).toBe(false)
  })
})

// Routes a portal token may reach without a 401: they read no session at all, so
// the token means nothing there. Every other registered route, /mcp included,
// answers 401. A route added to the app that takes no session fails the walk
// until it is listed here (tests/security/route-auth-invariant.test.ts holds the
// reason each one needs no session).
const NO_SESSION_ROUTES = new Set([
  "GET /api/health",
  "GET /api/health/ready",
  "GET /healthz",
  "GET /readyz",
  "GET /api/settings/branding",
  "GET /api/apps/host-api",
  "GET /.well-known/mcp",
  "GET /.well-known/oauth-authorization-server",
  "GET /.well-known/oauth-protected-resource",
  "GET /api/auth/bootstrap-state",
  "POST /api/auth/register",
  "GET /api/auth/invites/:token/validate",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "POST /api/auth/refresh",
  "POST /api/auth/magic-link/request",
  "POST /api/auth/magic-link/verify",
  "POST /api/auth/password-reset/request",
  "POST /api/auth/password-reset/confirm",
  "POST /api/auth/totp/verify",
  "GET /api/auth/oauth/providers",
  "GET /api/auth/oauth/:providerId/authorize",
  "GET /api/auth/oauth/callback",
  "POST /api/auth/oauth/exchange",
  "POST /api/auth/device-flow/initiate",
  "GET /api/auth/device-flow/poll/:deviceCode",
  "POST /mcp/oauth/register",
  "GET /mcp/oauth/authorize",
  "GET /mcp/oauth/authorize.js",
  "POST /mcp/oauth/token",
  "POST /mcp/device/initiate",
  "GET /mcp/device/poll/:deviceCode",
  "DELETE /mcp/device/:deviceCode",
  "GET /api/connections/callback",
  "GET /api/client-policy",
  "GET /api/connections/oauth-done",
  "GET /api/apps/mcp-manager/oauth/callback",
  "GET /api/apps/mcp-manager/oauth/client-metadata.json",
  "GET /api/apps/mcp-manager/oauth/done",
  "GET /api/apps/:name/:version/ui.js",
  "PUT /api/file-relay/:token",
  "GET /api/file-relay-dl/:token",
  "HEAD /api/file-relay-dl/:token",
  "GET /api/drive-picker/:ticket",
  "POST /api/drive-picker/:ticket/items",
  "GET /api/org-export-dl/:token",
  "HEAD /api/org-export-dl/:token",
  "GET /api/avatars/:key",
  "HEAD /api/avatars/:key",
  "POST /webhooks/:orgId/:appName/:endpointName",
  "GET /webhooks/:orgId/:appName/:endpointName",
  "POST /webhooks/:orgId/tickets/create",
  "OPTIONS /webhooks/:orgId/tickets/create",
  "POST /webhooks/:orgId/inboxes/:inboxId/tickets/create",
  "OPTIONS /webhooks/:orgId/inboxes/:inboxId/tickets/create",
  "POST /webhooks/:orgId/tickets/attachments",
  "OPTIONS /webhooks/:orgId/tickets/attachments",
  "POST /webhooks/:orgId/inboxes/:inboxId/tickets/attachments",
  "OPTIONS /webhooks/:orgId/inboxes/:inboxId/tickets/attachments",
  "POST /webhooks/:orgId/tickets/csat/:token",
  "OPTIONS /webhooks/:orgId/tickets/csat/:token",
  // Its own device receipt credential, in the body.
  "POST /api/notifications/receipts",
  // Mounted, answering 404 unless a flag or a managed edition is on.
  "GET /api/qa/notifications/log",
  "POST /api/qa/notifications/inject",
  // The managed edition's signed Control-to-cell API and cell webhooks: their only
  // credential is a signature (modules/cloud/verify.ts, route-auth-invariant.test.ts),
  // never a session, and they answer 404 on a self-hosted server.
  "POST /api/cloud/orgs",
  "POST /api/cloud/orgs/:id/handoff",
  "POST /api/cloud/orgs/:id/billing",
  "POST /api/cloud/orgs/:id/credits",
  "PUT /api/cloud/settings/credit-rate",
  "POST /api/cloud/lookup",
  "DELETE /api/cloud/orgs/:id",
  "PUT /api/cloud/orgs/:id/mail-sender",
  "PUT /api/cloud/orgs/:id/custom-apps/:name/state",
  "POST /webhooks/_cell/gmail-push",
  "POST /webhooks/_cell/meta",
  "GET /webhooks/_cell/meta",
])

/** Session routes mounted only in the managed edition: walked with it on, so they reach the session check. */
const MANAGED_ONLY = ["/api/billing/managed/", "/api/mail-sender/"]

/** Paths answering 404 in every edition before the session chain: a retired API (app.ts). */
const RETIRED_PATHS = new Set(["/api/admin/billing"])

/** The portal's own routes, and the harness routes that exist only in a test process. */
const OUT_OF_THE_WALK = ["/api/portal/", "/api/_test/"]

const UUID = "00000000-0000-4000-8000-000000000001"

function concretePath(path: string): string {
  return path
    .replace(":name/:version/ui.js", "tickets/1.0.0/ui.js")
    .replace(/:key\{\.\+\}/g, "a/b")
    .replace(/:[A-Za-z_]+(\{[^}]*\})?/g, (m) =>
      /(id|Id)$/.test(m.split("{")[0] ?? "") ? UUID : "x1",
    )
}

async function request(method: string, path: string, token: string) {
  return app.request(concretePath(path), {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(method !== "GET" && method !== "HEAD" ? { body: "{}" } : {}),
  })
}

function registeredRoutes(): string[] {
  const seen = new Set<string>()
  for (const r of app.routes) {
    if (r.method !== "ALL") seen.add(`${r.method} ${r.path}`)
  }
  return [...seen].sort()
}

describe("a portal token on the member product", () => {
  let answers: { key: string; status: number }[] = []

  beforeAll(async () => {
    markBootComplete()
    for (const key of registeredRoutes()) {
      const [method, path] = key.split(" ") as [string, string]
      if (OUT_OF_THE_WALK.some((p) => path.startsWith(p))) continue
      if (NO_SESSION_ROUTES.has(key)) continue
      const managed = MANAGED_ONLY.some((p) => path.startsWith(p))
      if (managed) _setEdition("managed")
      try {
        const res = await request(method, path, portalToken)
        answers.push({ key, status: res.status })
      } finally {
        if (managed) _setEdition(null)
      }
    }
  }, 300_000)

  afterAll(() => {
    answers = []
    ReadinessTestAccess.reset()
  })

  it("401 on every route but the listed public ones and /api/portal/*", () => {
    expect(answers.length).toBeGreaterThan(400)
    expect(answers.filter((a) => a.status !== 401).map((a) => `${a.status} ${a.key}`)).toEqual([])
  })

  it("401 on a path registered for every method too", async () => {
    const specific = new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => r.path))
    const paths = new Set(
      app.routes
        .filter(
          (r) =>
            r.method === "ALL" &&
            !r.path.includes("*") &&
            !specific.has(r.path) &&
            !RETIRED_PATHS.has(r.path),
        )
        .map((r) => r.path),
    )
    expect(paths.size).toBeGreaterThan(0)
    const open: string[] = []
    for (const path of paths) {
      const { status } = await request("GET", path, portalToken)
      if (status !== 401) open.push(`${status} ${path}`)
    }
    expect(open).toEqual([])
    // A retired path is shut for everyone, a portal token included.
    for (const path of RETIRED_PATHS) {
      expect((await request("GET", path, portalToken)).status).toBe(404)
    }
  })

  it("the list of public routes names only routes the app registers", () => {
    const registered = new Set(registeredRoutes())
    expect([...NO_SESSION_ROUTES].filter((k) => !registered.has(k))).toEqual([])
  })

  it("the same row's token would open the door the walk found shut, were it an access token", async () => {
    // What the audience alone refuses: an access token for the same active row
    // authenticates, so a walk that saw 401s is not seeing a dead user.
    const [row] = await sql<{ auth_version: number; permission_version: number }[]>`
      SELECT auth_version, permission_version FROM kernel.users WHERE id = ${externalId}`
    const forged = await signAccessToken(
      {
        userId: externalId,
        orgId,
        name: "Client",
        authVersion: row?.auth_version ?? 1,
        permissionVersion: row?.permission_version ?? 1,
      },
      env.JWT_SECRET,
    )
    expect((await request("GET", "/api/sharing/members", forged)).status).toBe(200)
    expect((await request("GET", "/api/sharing/members", portalToken)).status).toBe(401)
    expect((await request("GET", "/api/sharing/members", memberToken)).status).toBe(200)
  })

  async function refusedUnder(prefix: string) {
    const keys = registeredRoutes().filter((key) => {
      const path = key.split(" ")[1] ?? ""
      return (path === prefix || path.startsWith(`${prefix}/`)) && !NO_SESSION_ROUTES.has(key)
    })
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      const [method, path] = key.split(" ") as [string, string]
      expect(`${(await request(method, path, portalToken)).status} ${key}`).toBe(`401 ${key}`)
    }
  }

  it("the MCP transport refuses a portal token", () => refusedUnder("/mcp"))
  it("the agent routes refuse a portal token", () => refusedUnder("/api/agent"))
  it("the search routes refuse a portal token", () => refusedUnder("/api/search"))
  it("the file routes refuse a portal token", () => refusedUnder("/api/files"))
  it("the WebSocket ticket route refuses a portal token", () => refusedUnder("/api/auth/ws-ticket"))
})

describe("a restricted session is no person's click", () => {
  const SRC = join(import.meta.dir, "..", "..")

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        if (entry !== "tests" && entry !== "__fixtures__" && entry !== "migrations") {
          sourceFiles(path, out)
        }
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        out.push(path)
      }
    }
    return out
  }

  /** A route file that passes an origin to a tool, with each origin it passes. */
  function toolOriginsOfRoutes(source: string): string[] {
    if (!/new Hono|Context<AppEnv>/.test(source)) return []
    return [...source.matchAll(/\borigin: ([^,\n}]+)/g)].map((m) => (m[1] ?? "").trim())
  }

  function refusedOrigins(path: string, source: string): string[] {
    const origins = toolOriginsOfRoutes(source)
    if (origins.length === 0) return []
    const fromCall = origins.every((o) => o === "call.origin") && source.includes("restToolCall(")
    return fromCall ? [] : [`${path}: ${origins.join(", ")}`]
  }

  it("every route calling executeTool with human-ui passes through sessionRestricted", () => {
    const routeFiles: string[] = []
    const offenders: string[] = []
    for (const path of sourceFiles(SRC)) {
      const source = readFileSync(path, "utf8")
      const rel = relative(SRC, path)
      if (!/\b(executeTool|executeToolCore|dispatchBulk\w*|runBulk\w*)\(/.test(source)) continue
      if (toolOriginsOfRoutes(source).length > 0) routeFiles.push(rel)
      offenders.push(...refusedOrigins(rel, source))
    }
    expect(offenders).toEqual([])
    // The three families of tool route: a walk that found none proves nothing.
    expect(routeFiles).toEqual(
      expect.arrayContaining([
        "modules/apps/routes.ts",
        "modules/apps/bulk-routes.ts",
        "modules/apps/settings-routes.ts",
      ]),
    )
  })

  it("a route that sets its own origin fails that walk", () => {
    const route = `const r = new Hono<AppEnv>()
      r.post("/x", async (c) => executeTool({ origin: "human-ui" }))`
    expect(refusedOrigins("x.ts", route)).toEqual(['x.ts: "human-ui"'])
  })

  it("the one place reads the restricted flag: the same request is mcp when restricted", async () => {
    const context = (restricted: boolean) =>
      ({
        get: (key: string) =>
          ({ sessionRestricted: restricted, orgId, userId: memberId })[key] as never,
      }) as unknown as Context<AppEnv>
    expect((await restToolCall(context(false))).origin).toBe("human-ui")
    expect((await restToolCall(context(true))).origin).toBe("mcp")
  })
})

describe("what can mint an access token", () => {
  it("every production caller of signAccessToken states the row's type or mints only for members it created", () => {
    const SRC = join(import.meta.dir, "..", "..")
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) {
          if (entry !== "tests" && entry !== "__fixtures__" && entry !== "migrations")
            walk(path, out)
        } else if (
          entry.endsWith(".ts") &&
          !entry.endsWith(".test.ts") &&
          readFileSync(path, "utf8").includes("signAccessToken(")
        ) {
          out.push(relative(SRC, path))
        }
      }
      return out
    }
    expect(walk(SRC).sort()).toEqual([
      "cli/agent/ask.ts",
      "modules/auth/auth.ts",
      "modules/auth/jwt.ts",
      "modules/mcp/connection-service.ts",
      // Seeds a fresh organization's owner: a member it has just created.
      "seed/tiers/minimal.ts",
    ])
    for (const file of [
      "cli/agent/ask.ts",
      "modules/auth/auth.ts",
      "modules/mcp/connection-service.ts",
    ]) {
      expect(`${file}: ${readFileSync(join(SRC, file), "utf8").includes("userType")}`).toBe(
        `${file}: true`,
      )
    }
  })
})
