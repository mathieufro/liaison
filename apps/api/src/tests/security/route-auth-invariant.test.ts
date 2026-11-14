// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Route authentication invariant, enumerated from the booted app.
//
// Every method/path pair the real `app` registers is requested with no
// credential. A pair is SESSION-GATED when the session middleware itself refused
// it (its "missing_bearer" auth-failure line was logged for that request and the
// answer is 401). Every pair that is not session-gated must appear in
// PUBLIC_ROUTES below with the credential it relies on instead, and no entry of
// PUBLIC_ROUTES may be stale. A new route therefore fails this file until it is
// either mounted behind the session middleware or classified here.
//
// The test-harness routes (`/api/_test/*`) are mounted only under NODE_ENV=test
// or ENABLE_QA_SEED_ROUTES, and a production process refuses to boot with the
// flag on (lib/env.ts); they are listed as a variant, not reviewed one by one.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { app } from "~/app"
import { rootLogger } from "~/lib/logger"
import { markBootComplete, ReadinessTestAccess } from "~/lib/readiness"

type Credential =
  | "none"
  | "challenge-or-credential-in-body"
  | "token-in-path"
  | "state-param"
  | "own-bearer"
  | "flag-gated"
  | "mcp-token"
  | "webhook-verifier"
  | "control-signature"

interface PublicRoute {
  credential: Credential
  reason: string
}

/** `METHOD path` exactly as Hono registers it. */
const PUBLIC_ROUTES: Record<string, PublicRoute> = {
  // Liveness and discovery.
  "GET /api/health": { credential: "none", reason: "liveness, no data" },
  "GET /api/health/ready": {
    credential: "none",
    reason: "readiness verdict only; dependency detail needs loopback or the monitor token",
  },
  "GET /healthz": { credential: "none", reason: "load-balancer probe, trimmed body off-loopback" },
  "GET /readyz": {
    credential: "none",
    reason: "load-balancer readiness probe: status, role, instance id and leader flag, no data",
  },
  "GET /diag": { credential: "own-bearer", reason: "MONITOR_TOKEN, constant time" },
  "GET /api/settings/branding": { credential: "none", reason: "deployment name for first launch" },
  "GET /api/apps/host-api": { credential: "none", reason: "supported host API majors only" },
  "GET /.well-known/mcp": { credential: "none", reason: "static MCP discovery" },
  "GET /.well-known/oauth-authorization-server": { credential: "none", reason: "RFC 8414" },
  "GET /.well-known/oauth-protected-resource": { credential: "none", reason: "RFC 9728" },
  // Sign-in, recovery and registration: the request carries the credential.
  "GET /api/auth/bootstrap-state": { credential: "none", reason: "whether setup is pending" },
  "POST /api/auth/register": {
    credential: "challenge-or-credential-in-body",
    reason: "setup or invite token",
  },
  "GET /api/auth/invites/:token/validate": {
    credential: "token-in-path",
    reason: "256-bit invite",
  },
  "POST /api/auth/login": { credential: "challenge-or-credential-in-body", reason: "password" },
  "POST /api/auth/logout": {
    credential: "challenge-or-credential-in-body",
    reason: "refresh token",
  },
  "POST /api/auth/refresh": {
    credential: "challenge-or-credential-in-body",
    reason: "refresh token",
  },
  "POST /api/auth/magic-link/request": { credential: "none", reason: "uniform answer, throttled" },
  "POST /api/auth/magic-link/verify": {
    credential: "challenge-or-credential-in-body",
    reason: "code or link token",
  },
  "POST /api/auth/password-reset/request": {
    credential: "none",
    reason: "uniform answer, throttled",
  },
  "POST /api/auth/password-reset/confirm": {
    credential: "challenge-or-credential-in-body",
    reason: "reset token",
  },
  "POST /api/auth/totp/verify": {
    credential: "challenge-or-credential-in-body",
    reason: "challenge token",
  },
  "GET /api/auth/oauth/providers": { credential: "none", reason: "enabled sign-in providers" },
  "GET /api/auth/oauth/:providerId/authorize": {
    credential: "none",
    reason: "starts a login, sets state cookie",
  },
  "GET /api/auth/oauth/callback": { credential: "state-param", reason: "GETDEL state + cookie" },
  "POST /api/auth/oauth/exchange": {
    credential: "challenge-or-credential-in-body",
    reason: "one-time code + PKCE",
  },
  "POST /api/auth/device-flow/initiate": {
    credential: "none",
    reason: "device grant start, per-IP budget",
  },
  "GET /api/auth/device-flow/poll/:deviceCode": {
    credential: "token-in-path",
    reason: "256-bit device code",
  },
  // MCP OAuth server and device grant.
  "POST /mcp/oauth/register": { credential: "none", reason: "RFC 7591 DCR, per-IP budget" },
  "GET /mcp/oauth/authorize": { credential: "none", reason: "consent page, issues no code" },
  "GET /mcp/oauth/authorize.js": { credential: "none", reason: "static consent script" },
  "POST /mcp/oauth/token": {
    credential: "challenge-or-credential-in-body",
    reason: "code + PKCE or refresh",
  },
  "POST /mcp/device/initiate": { credential: "none", reason: "device grant start" },
  "GET /mcp/device/poll/:deviceCode": {
    credential: "token-in-path",
    reason: "256-bit device code",
  },
  "DELETE /mcp/device/:deviceCode": {
    credential: "token-in-path",
    reason: "cancel by device code",
  },
  "POST /mcp": { credential: "mcp-token", reason: "MCP transport, mcpAuthMiddleware" },
  // Connector OAuth landings (browser redirect from the provider).
  "GET /api/connections/callback": {
    credential: "state-param",
    reason: "single-use state + browser cookie",
  },
  // The oldest shell version per platform the server supports, read before a
  // shell signs in (modules/client-policy): three version strings, no data.
  "GET /api/client-policy": {
    credential: "none",
    reason: "public shell version minimums, no data",
  },
  // The page a connect card's popup ends on: no data, it reads only its own
  // query ("connected" or "failed" and a reason) and closes the window.
  "GET /api/connections/oauth-done": {
    credential: "none",
    reason: "static closing page, no data",
  },
  "GET /api/apps/mcp-manager/oauth/callback": {
    credential: "state-param",
    reason: "state row + browser cookie",
  },
  // The OAuth Client ID Metadata Document an MCP authorization server fetches
  // (CIMD): public by design, no data, served only for a public https BASE_URL.
  "GET /api/apps/mcp-manager/oauth/client-metadata.json": {
    credential: "none",
    reason: "public client metadata document, no data",
  },
  "GET /api/apps/mcp-manager/oauth/done": {
    credential: "none",
    reason:
      "static landing; the server name only by the random key the callback stored, no row read",
  },
  "GET /api/apps/:name/:version/ui.js": {
    credential: "token-in-path",
    reason: "first-party public, others need bundle token",
  },
  // Capability URLs.
  "PUT /api/file-relay/:token": { credential: "token-in-path", reason: "signed upload token" },
  "GET /api/file-relay-dl/:token": { credential: "token-in-path", reason: "signed download token" },
  "HEAD /api/file-relay-dl/:token": {
    credential: "token-in-path",
    reason: "signed download token",
  },
  "GET /api/org-export-dl/:token": {
    credential: "token-in-path",
    reason: "signed org export download token",
  },
  "HEAD /api/org-export-dl/:token": {
    credential: "token-in-path",
    reason: "signed org export download token",
  },
  "GET /api/avatars/:key": { credential: "token-in-path", reason: "unguessable rotating key" },
  "HEAD /api/avatars/:key": { credential: "token-in-path", reason: "unguessable rotating key" },
  "POST /api/notifications/receipts": {
    credential: "own-bearer",
    reason: "device receipt credential",
  },
  // A commercial mail's opt-out link: the token is the 32-byte random secret it carries.
  "GET /public/opt-out/:token": { credential: "token-in-path", reason: "opt-out link, read only" },
  "POST /public/opt-out/:token": {
    credential: "token-in-path",
    reason: "opt-out link, records one opt-out",
  },
  // Inbound webhooks.
  "POST /webhooks/:orgId/:appName/:endpointName": {
    credential: "webhook-verifier",
    reason: "per-app verifier",
  },
  // The server's own callbacks (managed edition; 404 on any other server).
  "POST /webhooks/_cell/gmail-push": {
    credential: "webhook-verifier",
    reason:
      "managed edition only; Pub/Sub OIDC token checked against the push audience and account",
  },
  "POST /webhooks/_cell/meta": {
    credential: "webhook-verifier",
    reason: "managed edition only; x-hub-signature-256 under the instance Meta app secret",
  },
  "GET /webhooks/_cell/meta": {
    credential: "webhook-verifier",
    reason: "managed edition only; hub.challenge verify token derived from the Meta app secret",
  },
  "GET /webhooks/:orgId/:appName/:endpointName": {
    credential: "webhook-verifier",
    reason: "hub.challenge verify token",
  },
  "POST /webhooks/:orgId/tickets/create": {
    credential: "webhook-verifier",
    reason: "anonymous tier or API key",
  },
  "OPTIONS /webhooks/:orgId/tickets/create": { credential: "none", reason: "CORS preflight" },
  "POST /webhooks/:orgId/inboxes/:inboxId/tickets/create": {
    credential: "webhook-verifier",
    reason: "API key",
  },
  "OPTIONS /webhooks/:orgId/inboxes/:inboxId/tickets/create": {
    credential: "none",
    reason: "CORS preflight",
  },
  "POST /webhooks/:orgId/tickets/attachments": {
    credential: "webhook-verifier",
    reason: "API key",
  },
  "OPTIONS /webhooks/:orgId/tickets/attachments": { credential: "none", reason: "CORS preflight" },
  "POST /webhooks/:orgId/inboxes/:inboxId/tickets/attachments": {
    credential: "webhook-verifier",
    reason: "API key",
  },
  "OPTIONS /webhooks/:orgId/inboxes/:inboxId/tickets/attachments": {
    credential: "none",
    reason: "CORS preflight",
  },
  "POST /webhooks/:orgId/tickets/csat/:token": {
    credential: "token-in-path",
    reason: "128-bit survey token",
  },
  "OPTIONS /webhooks/:orgId/tickets/csat/:token": { credential: "none", reason: "CORS preflight" },
  // Mounted, but answering 404 unless a flag or a managed edition is on.
  "GET /api/qa/notifications/log": {
    credential: "flag-gated",
    reason: "LIAISON_QA_ROUTES, then session",
  },
  "POST /api/qa/notifications/inject": {
    credential: "flag-gated",
    reason: "LIAISON_QA_ROUTES, then session",
  },
  // The Workers executor's remote isolates and app loader; every path answers 404 while
  // the executor is not configured (modules/apps/workers/config.ts).
  "GET /api/app-bridge/bundles/:sha256": {
    credential: "control-signature",
    reason:
      "the app loader's signature, direction loader->cell (modules/apps/workers/bundle-route.ts)",
  },
  "POST /api/app-bridge/:runId": {
    credential: "own-bearer",
    reason:
      "the run's bearer token, bound to one run, org and app (modules/apps/workers/run-registry.ts)",
  },
  "POST /api/cloud/orgs": {
    credential: "control-signature",
    reason: "managed edition only; signed by the control plane (modules/cloud/verify.ts)",
  },
  "POST /api/cloud/orgs/:id/handoff": {
    credential: "control-signature",
    reason: "managed edition only; signed by the control plane (modules/cloud/verify.ts)",
  },
  "POST /api/cloud/orgs/:id/billing": {
    credential: "control-signature",
    reason: "managed edition only; signed by the control plane (modules/cloud/verify.ts)",
  },
  "POST /api/cloud/orgs/:id/credits": {
    credential: "control-signature",
    reason: "managed edition only; signed by the control plane (modules/cloud/verify.ts)",
  },
  "PUT /api/cloud/settings/credit-rate": {
    credential: "control-signature",
    reason: "managed edition only; signed by the control plane (modules/cloud/verify.ts)",
  },
  "POST /api/cloud/lookup": {
    credential: "control-signature",
    reason: "managed edition only; signed by the control plane (modules/cloud/verify.ts)",
  },
  "DELETE /api/cloud/orgs/:id": {
    credential: "control-signature",
    reason: "managed edition only; signed by the control plane (modules/cloud/verify.ts)",
  },
  "PUT /api/cloud/orgs/:id/mail-sender": {
    credential: "control-signature",
    reason: "managed edition only; signed by the control plane (modules/cloud/verify.ts)",
  },
  "PUT /api/cloud/orgs/:id/custom-apps/:name/state": {
    credential: "control-signature",
    reason: "managed edition only; signed by the control plane (modules/cloud/verify.ts)",
  },
  "GET /api/billing/managed/summary": {
    credential: "flag-gated",
    reason: "managed edition only, then session + kernel:org:admin (app.ts)",
  },
  "GET /api/billing/managed/invoices": {
    credential: "flag-gated",
    reason: "managed edition only, then session + kernel:org:admin (app.ts)",
  },
  "GET /api/billing/managed/invoices/:id/pdf": {
    credential: "flag-gated",
    reason: "managed edition only, then session + kernel:org:admin (app.ts)",
  },
  "POST /api/billing/managed/cancel": {
    credential: "flag-gated",
    reason: "managed edition only, then session + kernel:org:admin (app.ts)",
  },
  "POST /api/billing/managed/change-plan": {
    credential: "flag-gated",
    reason: "managed edition only, then session + kernel:org:admin (app.ts)",
  },
  "POST /api/billing/managed/frame-session": {
    credential: "flag-gated",
    reason: "managed edition only, then session + kernel:org:admin (app.ts)",
  },
  "POST /api/billing/managed/resume": {
    credential: "flag-gated",
    reason: "managed edition only, then session + kernel:org:admin (app.ts)",
  },
  "POST /api/billing/managed/topup": {
    credential: "flag-gated",
    reason: "managed edition only, then session + kernel:org:admin (app.ts)",
  },
  "PUT /api/billing/managed/auto-topup": {
    credential: "flag-gated",
    reason: "managed edition only, then session + kernel:org:admin (app.ts)",
  },
  "GET /api/mail-sender/status": {
    credential: "flag-gated",
    reason: "managed edition only, then session + kernel:org:admin (app.ts)",
  },
  "POST /api/mail-sender/domain": {
    credential: "flag-gated",
    reason: "managed edition only, then session + kernel:org:admin (app.ts)",
  },
  "POST /api/mail-sender/verify": {
    credential: "flag-gated",
    reason: "managed edition only, then session + kernel:org:admin (app.ts)",
  },
  "DELETE /api/mail-sender/domain": {
    credential: "flag-gated",
    reason: "managed edition only, then session + kernel:org:admin (app.ts)",
  },
}

/** Route families that exist only in a test or QA process (see header). */
const TEST_ONLY_PREFIXES = ["/api/_test/"]

const UUID = "00000000-0000-4000-8000-000000000001"

function concretePath(path: string): string {
  return path
    .replace(":name/:version/ui.js", "tickets/1.0.0/ui.js")
    .replace(/:key\{\.\+\}/g, "a/b")
    .replace(/:[A-Za-z_]+(\{[^}]*\})?/g, (m) => (/(id|Id)$/.test(m.split("{")[0]) ? UUID : "x1"))
}

interface Probe {
  key: string
  status: number
  sessionGate: boolean
}

let probes: Probe[] = []
let routeKeys: string[] = []

beforeAll(async () => {
  const seen = new Set<string>()
  for (const r of app.routes) {
    if (r.method === "ALL") continue
    const key = `${r.method} ${r.path}`
    if (seen.has(key)) continue
    seen.add(key)
  }
  routeKeys = [...seen].sort()

  // The probe stands for a serving process: index.ts marks the role's boot
  // complete before it takes traffic, and a process still starting answers
  // /readyz 503 by design (lib/readiness.ts). Without this the 5xx check below
  // would flag the probe's own boot state instead of a route.
  markBootComplete()

  const warn = spyOn(rootLogger, "warn")
  try {
    for (const key of routeKeys) {
      const [method, path] = key.split(" ") as [string, string]
      if (TEST_ONLY_PREFIXES.some((p) => path.startsWith(p))) continue
      warn.mockClear()
      const init: RequestInit = { method }
      if (method !== "GET" && method !== "HEAD") {
        init.body = "{}"
        init.headers = { "content-type": "application/json" }
      }
      const res = await app.request(concretePath(path), init)
      const sessionGate =
        res.status === 401 &&
        warn.mock.calls.some(
          (call) =>
            typeof call[0] === "object" &&
            call[0] !== null &&
            (call[0] as { reason?: string }).reason === "missing_bearer",
        )
      probes.push({ key, status: res.status, sessionGate })
    }
  } finally {
    warn.mockRestore()
  }
}, 300_000)

afterAll(() => {
  probes = []
  ReadinessTestAccess.reset()
})

describe("route authentication invariant (anonymous probe of every registered route)", () => {
  it("enumerates a realistic number of routes", () => {
    expect(routeKeys.length).toBeGreaterThan(400)
  })

  it("every route is either behind the session middleware or a reviewed public route", () => {
    const unclassified = probes
      .filter((p) => !p.sessionGate && !(p.key in PUBLIC_ROUTES))
      .map((p) => `${p.status} ${p.key}`)
    expect(unclassified).toEqual([])
  })

  it("a public route is not also behind the session middleware (the allowlist stays honest)", () => {
    const gatedButListed = probes
      .filter((p) => p.sessionGate && p.key in PUBLIC_ROUTES)
      .map((p) => p.key)
    expect(gatedButListed).toEqual([])
  })

  it("no allowlist entry is stale", () => {
    const registered = new Set(routeKeys)
    const stale = Object.keys(PUBLIC_ROUTES).filter((k) => !registered.has(k))
    expect(stale).toEqual([])
  })

  it("no public route answers an anonymous probe with a server error", () => {
    const fivexx = probes.filter((p) => p.status >= 500).map((p) => `${p.status} ${p.key}`)
    expect(fivexx).toEqual([])
  })

  it("a forged bearer is refused on every session-gated route", async () => {
    const forged = `Bearer ${["eyJhbGciOiJub25lIn0", "eyJ1c2VySWQiOiJ4In0", ""].join(".")}`
    const refused: string[] = []
    for (const p of probes.filter((x) => x.sessionGate)) {
      const [method, path] = p.key.split(" ") as [string, string]
      const res = await app.request(concretePath(path), {
        method,
        headers: { Authorization: forged, "content-type": "application/json" },
        ...(method !== "GET" && method !== "HEAD" ? { body: "{}" } : {}),
      })
      if (res.status !== 401) refused.push(`${res.status} ${p.key}`)
    }
    expect(refused).toEqual([])
  }, 300_000)
})
