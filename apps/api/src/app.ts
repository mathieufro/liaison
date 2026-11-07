// SPDX-License-Identifier: FSL-1.1-ALv2

import { connectFailureReason, TRANSCRIBE_MAX_BYTES } from "@liaison/shared"
import type { Context, MiddlewareHandler } from "hono"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { every } from "hono/combine"
import { cors } from "hono/cors"
import { pinoLogger } from "hono-pino"
import { drivePickerRoutes } from "~/apps/google-drive/picker-routes"
import { driveSharedDrivesRoutes } from "~/apps/google-drive/shared-drives-routes"
import { knowledgeRoutes } from "~/apps/knowledge/routes"
import { mcpManagerAuditRoutes } from "~/apps/mcp-manager/audit-routes"
import { mcpManagerOAuthRoutes } from "~/apps/mcp-manager/oauth-routes"
import { mcpManagerRoutes } from "~/apps/mcp-manager/routes"
import { projectsRoutes } from "~/apps/projects/routes"
import { parseOriginAllowlist, resolveCorsOrigin } from "~/lib/app-origins"
import { env, qaSeedRoutesEnabled } from "~/lib/env"
import { envFlag } from "~/lib/env-boolean"
import { classifyFailure } from "~/lib/failure-severity"
import { latencyWindowMiddleware } from "~/lib/latency-window"
import {
  HARNESS_HEADER_SIGNATURE,
  loadHarnessEnabled,
  verifyHarnessContext,
} from "~/lib/load-harness"
import { rootLogger } from "~/lib/logger"
import {
  chaosInjectorModulePath,
  importOptionalModule,
  QA_SEED_ROUTES_MODULE,
} from "~/lib/optional-module"
import {
  boundCorsOrigin,
  hostBindingEnabled,
  isNonOrgHostPath,
  requestHostBinding,
} from "~/lib/org-host"
import { redis } from "~/lib/redis"
import { appRouteStateGate, kernelPrefixStateGate } from "~/middleware/app-state-gate"
import { authMiddleware } from "~/middleware/auth"
import { errorHandler } from "~/middleware/error-handler"
import { maintenanceMiddleware } from "~/middleware/maintenance"
import { publicSurfaceBodyLimit, publicSurfaceRateLimit } from "~/middleware/public-surface-limits"
import { orgRateLimiter, rateLimiter, userRateLimiter } from "~/middleware/rate-limiter"
import { requestTimeout } from "~/middleware/request-timeout"
import { requireScope } from "~/middleware/require-scope"
import { securityHeaders } from "~/middleware/security-headers"
import { versionCheckRoutes } from "~/modules/admin/version-check"
import { creditRoutes } from "~/modules/agent/credits/credit-routes"
import { definitionRoutes } from "~/modules/agent/directory/definition-routes"
import { localSessionRoutes } from "~/modules/agent/local-sessions/local-session-routes"
import { MAILBOX_ANSWER_BODY_MAX_BYTES } from "~/modules/agent/mailbox-plaintext/answer-limits"
import { memoriesRoutes } from "~/modules/agent/memory/memories-routes"
import { agentMemoryRoutes } from "~/modules/agent/memory/memory-routes"
import { agentRoutes } from "~/modules/agent/routes"
import { routinesRoutes } from "~/modules/agent/routines/routines-routes"
import {
  agentDebugRoutes,
  appSkillsRoutes,
  skillsRoutes,
} from "~/modules/agent/skills/skills-routes"
import { apiConnectorRoutes } from "~/modules/api-connector/routes"
import { APPROVAL_DECIDE_BODY_MAX_BYTES } from "~/modules/approvals/mailbox-fulfilment"
import { approvals } from "~/modules/approvals/routes"
import { initAppActivationSync } from "~/modules/apps/activation"
import { attentionRoutes } from "~/modules/apps/attention-routes"
import { bulkRoutes } from "~/modules/apps/bulk-routes"
import { connectionRoutes } from "~/modules/apps/connections/routes"
import { installRoutes } from "~/modules/apps/install-routes"
import { manifestsAxesRoutes } from "~/modules/apps/manifests-axes-route"
import { initOrgAppsInvalidation, UUID_RE } from "~/modules/apps/org-apps"
import { appRoutes, hostApiRoutes } from "~/modules/apps/routes"
import { registerKernelAttentionProvider } from "~/modules/apps/runtime"
import { appSettingsRoutes } from "~/modules/apps/settings-routes"
import { uiBundleRoutes } from "~/modules/apps/ui-bundle-routes"
import { assistRoutes } from "~/modules/assist/routes"
import { TRANSCRIBE_REQUEST_TIMEOUT_MS } from "~/modules/assist/transcribe-service"
import { attentionSubscriptionsRoutes } from "~/modules/attention/subscriptions-routes"
import { auditRoutes } from "~/modules/audit/routes"
import { timeline } from "~/modules/audit/timeline-routes"
import { initAuthCacheInvalidation } from "~/modules/auth/auth-state"
import { deviceFlow } from "~/modules/auth/device-flow-routes"
import { oauth, oauthAdmin } from "~/modules/auth/oauth-routes"
import { auth } from "~/modules/auth/routes"
import { initSessionRevocation } from "~/modules/auth/session-revocation"
import { wsTicket } from "~/modules/auth/ws-ticket-routes"
import { billingManagedRoutes, managedBillingOnly } from "~/modules/billing-managed/routes"
import { billingStateRoutes } from "~/modules/billing-state"
import { brandingRoutes } from "~/modules/branding/routes"
import { bugReports } from "~/modules/bug-reports/routes"
import { CLIENT_HEADER, clientPolicyRoutes, logClientHeader } from "~/modules/client-policy/routes"
import { cellHeaderMiddleware } from "~/modules/cloud/cell-header"
import { mailSenderRoutes, managedMailSenderOnly } from "~/modules/cloud/mail-sender-routes"
import { cloudRoutes } from "~/modules/cloud/routes"
import { contacts } from "~/modules/contacts/routes"
import { trustedSendersRoutes } from "~/modules/contacts/trusted-senders-routes"
import { databaseRoutes } from "~/modules/database/routes"
import { documentRoutes, documentTemplateRoutes } from "~/modules/documents/routes"
import { documentTemplateRuleRoutes } from "~/modules/documents/rules-routes"
import { orgExportDownloadRelay, orgExportRoutes } from "~/modules/export/org-archive/routes"
import { exportRoutes } from "~/modules/export/routes"
import { fileDownloadRelay, files as filesRoutes, fileUploadRelay } from "~/modules/files/routes"
import { health } from "~/modules/health/routes"
import { healthzRoutes, systemHealthRoutes } from "~/modules/healthz"
import { readyzRoutes } from "~/modules/healthz/readyz"
import { homeBriefRoutes } from "~/modules/home/brief-route"
import { serverT } from "~/modules/i18n/server-i18n"
import { importRoutes } from "~/modules/imports/routes"
import { importUploadRoutes } from "~/modules/imports/uploads/routes"
import { liaisonTeamRoutes } from "~/modules/liaison-team/routes"
import { mailRoutes } from "~/modules/mail/routes"
import { mailboxJobsRoutes } from "~/modules/mailbox-jobs/routes"
import { mailboxEncryptionRoutes } from "~/modules/mailbox-keys/encryption-mode-routes"
import { mailboxKeysRoutes, mailboxRoutes } from "~/modules/mailbox-keys/routes"
import { mcpDesktopConnection } from "~/modules/mcp/desktop-connection-routes"
import { mcpDeviceGrant } from "~/modules/mcp/device-grant-routes"
import { mcpAuthMiddleware } from "~/modules/mcp/mcp-auth-middleware"
import { mcpOAuth, mcpOAuthWellKnown } from "~/modules/mcp/oauth-server-routes"
import { mcpSettings } from "~/modules/mcp/settings-routes"
import { mcpTransport } from "~/modules/mcp/transport-routes"
import { monitorDiagRoutes } from "~/modules/monitor"
import { meNodeSessionCommandRoutes } from "~/modules/node-sessions/routes-commands"
import { meLevelConfirmationRoutes } from "~/modules/node-sessions/routes-confirm"
import {
  meNodeSessionFullOutputRoutes,
  nodeSessionFullOutputRoutes,
} from "~/modules/node-sessions/routes-full-output"
import { meNodeSessionImportRoutes } from "~/modules/node-sessions/routes-import"
import { meNodeSessionRoutes } from "~/modules/node-sessions/routes-me"
import { nodeSessionRoutes } from "~/modules/node-sessions/routes-node"
import { nodeLevelConfirmationRoutes } from "~/modules/node-sessions/routes-node-confirm"
import { nodeSessionReportRoutes } from "~/modules/node-sessions/routes-node-report"
import { nodeAttachmentRoutes } from "~/modules/nodes/attachments"
import { dispatchRetryRoutes } from "~/modules/nodes/dispatch-retry"
import {
  nodeFolderRequestRoutes,
  nodeFolderRoutes,
  nodeImportRequestRoutes,
} from "~/modules/nodes/folder-routes"
import { nodeJobRoutes } from "~/modules/nodes/job-routes"
import { nodePermissionRoutes } from "~/modules/nodes/permission-prompts"
import { nodeRoutes } from "~/modules/nodes/routes"
import { threadNodeSettingsRoutes } from "~/modules/nodes/thread-settings"
import { nodeTurnProgressRoutes } from "~/modules/nodes/turn-progress-routes"
import {
  NOTIFICATION_RECEIPTS_PATH,
  notificationDeviceRoutes,
  notificationReceiptRoutes,
} from "~/modules/notifications/device-routes"
import { qaNotificationRoutes } from "~/modules/notifications/qa-routes"
import { notificationSettingsRoutes } from "~/modules/notifications/routes"
import { orgAppRoutes } from "~/modules/org/org-app-routes"
import { org } from "~/modules/org/routes"
import { assertOrgAcceptsWrites, isMutatingMethod } from "~/modules/org/transfer-state/gate"
import { beginOrgActivity, initOrgTransferSync } from "~/modules/org/transfer-state/state"
import { dimensionCatalogRoutes } from "~/modules/permissions/dimension-catalog-routes"
import { adminRoles } from "~/modules/permissions/roles-routes"
import { scopeCatalogRoutes } from "~/modules/permissions/scope-catalog-routes"
import type { Scope } from "~/modules/permissions/types"
import { pushRoutes } from "~/modules/push/routes"
import { savedViewsRoutes } from "~/modules/saved-views/routes"
import { scopeRequests } from "~/modules/scope-requests/routes"
import { search } from "~/modules/search/routes"
import { secretRequestRoutes } from "~/modules/secret-requests/routes"
import { aiKeysRoutes } from "~/modules/settings/ai-keys-routes"
import { aiModelsRoutes } from "~/modules/settings/ai-models-routes"
import { refuseByokInManaged } from "~/modules/settings/byok"
import { integrationsRoutes } from "~/modules/settings/integrations-routes"
import { sharingRoutes } from "~/modules/sharing/routes"
import { slotsRoutes } from "~/modules/slots/routes"
import { mentions } from "~/modules/threads/mentions-routes"
import { references } from "~/modules/threads/references-routes"
import { threads } from "~/modules/threads/routes"
import { tourRoutes } from "~/modules/tours/routes"
import { invites } from "~/modules/users/invites-routes"
import { preferencesRoutes } from "~/modules/users/preferences-routes"
import { adminUserRoutes, avatarPublicRoutes, userRoutes } from "~/modules/users/routes"
import { setUpOrgForInboundWebhook } from "~/modules/webhooks/org-setup"
import { webhookRoutes } from "~/modules/webhooks/routes"
import {
  ATTACHMENT_REQUEST_MAX_BYTES,
  ticketsPublicRoutes,
} from "~/modules/webhooks/tickets-public"

export type AppEnv = {
  Variables: {
    userId: string
    orgId: string
    roles: string[]
    scopes: Scope[]
    dimensionGrants: Record<string, string[]>
    authVersion: number
    permissionVersion: number
    // True when the bearer token belongs to a restricted (device-flow) session:
    // such a session mints no further credential (auth/session-ceiling.ts).
    sessionRestricted?: boolean
    // True on the session of an administrator whose org requires a second factor
    // they have not set up yet: it may only enroll (auth/admin-second-factor.ts).
    secondFactorRequired?: boolean
    // The sign-in session the bearer token came from (its `sid`), when it has
    // one. A WebSocket ticket carries it so the socket closes when it ends.
    sessionId?: string
    // Phase 12: set by mcpAuthMiddleware for MCP transport requests only.
    mcpConnectionId?: string
    // Set by mcpAuthMiddleware only when the resolved MCP connection is bound
    // to a kernel.agents row; absent for a legacy (grantor-only) connection.
    mcpAgentId?: string
    logger?: { child: (bindings: Record<string, unknown>) => unknown }
    // Set by requestTimeout(): aborts when the request budget expires OR the
    // client hangs up. Routes pass it into cancellable work (executeTool) so an
    // abandoned caller releases its sandbox worker instead of holding it to the
    // pool's own kill timer. Read it via getRequestSignal().
    requestSignal?: AbortSignal
    // Set by userRateLimiter once it has spent a token for this request, so a
    // path matching two mounts is not charged twice.
    userRateLimitChecked?: boolean
    // Same, for the per-org limiter.
    orgRateLimitChecked?: boolean
    // Set by a route answering 503 because one of OUR own dependencies is down
    // (database, Redis, search, maintenance), not an outside upstream: the access
    // log keeps that 503 at error (lib/own-dependency-down.ts).
    ownDependencyDown?: boolean
  }
}

// Kernel-scoped attention providers — trusted in-process, registered once at boot.
// Each kernel provider registers under a distinct appName key so the aggregator
// invokes them independently (the registry maps [orgId, appName] → one provider).
registerKernelAttentionProvider({
  handler: "computeApprovalAttentionItems",
  scope: "kernel:approvals:read",
  bundlePath: new URL("./modules/approvals/attention.ts", import.meta.url).pathname,
})
// "While you were away": decisions taken for the person while they were away, once back.
registerKernelAttentionProvider({
  appName: "kernel.away_recap",
  handler: "getAwayRecapAttentionItems",
  bundlePath: new URL("./modules/approvals/away-recap.ts", import.meta.url).pathname,
})
registerKernelAttentionProvider({
  appName: "kernel.attention_events",
  handler: "getEventAttentionItems",
  bundlePath: new URL("./modules/attention/event-provider.ts", import.meta.url).pathname,
})
registerKernelAttentionProvider({
  appName: "kernel.connection_health",
  handler: "computeConnectionHealthAttentionItems",
  scope: "kernel:apps:admin",
  bundlePath: new URL("./modules/apps/connections/attention.ts", import.meta.url).pathname,
})
registerKernelAttentionProvider({
  appName: "kernel.mailbox_enrollment",
  handler: "computeMailboxEnrollmentAttentionItems",
  bundlePath: new URL("./modules/mailbox-keys/attention.ts", import.meta.url).pathname,
})
registerKernelAttentionProvider({
  appName: "kernel.cloud_billing",
  handler: "computeCloudBillingAttentionItems",
  scope: "kernel:org:admin",
  bundlePath: new URL("./modules/cloud/attention.ts", import.meta.url).pathname,
})

export const app = new Hono<AppEnv>()

// Subscribe this process to cross-process auth-cache invalidations so a
// credential revocation on a peer node (password change, deactivate, scope
// change, …) drops this process's cached auth state immediately rather than
// after its 15s TTL. Idempotent + best-effort: a Redis hiccup degrades to
// per-process TTL expiry, never blocks boot.
void initAuthCacheInvalidation().catch((err) => {
  rootLogger.warn({ err }, "auth-cache invalidation subscribe failed")
})
// Ended sign-in sessions, heard from every process: their access tokens and
// sockets are refused at once (modules/auth/session-revocation.ts). It loads
// the current set too, and again on each subscriber reconnect.
void initSessionRevocation().catch((err) => {
  rootLogger.error({ err }, "session revocation subscribe failed")
})
// Same for the per-org app state cache (S18): an admin turning an app Off on
// one node reloads the entry on every peer, with the TTL as the backstop.
void initOrgAppsInvalidation().catch((err) => {
  rootLogger.warn({ err }, "org-apps invalidation subscribe failed")
})
// The orgs moving to another instance (modules/org/transfer-state/): every
// process refreshes its view each second and at once on a change broadcast,
// and confirms what it applies.
void initOrgTransferSync().catch((err) => {
  rootLogger.warn({ err }, "org transfer state sync start failed; gates read on demand")
})
// App versions another server process activated (install, upgrade, rollback).
void initAppActivationSync().catch((err) => {
  rootLogger.warn({ err }, "app activation sync subscribe failed")
})

function isTicketsPublicCreatePath(path: string): boolean {
  return /^\/webhooks\/[^/]+\/tickets\/create$/.test(path)
}

function isTicketsPublicAttachmentPath(path: string): boolean {
  return /^\/webhooks\/[^/]+\/(inboxes\/[^/]+\/)?tickets\/attachments$/.test(path)
}

// CSAT capture-ingest (BL-194) does its own byte-accurate body cap + rate
// limiting in-handler (like tickets/create), so it must bypass the generic
// /webhooks/* body-limit + rate-limiter middleware — those would otherwise
// buffer/consume the request stream before the handler reads c.req.raw.
function isTicketsPublicCsatPath(path: string): boolean {
  return /^\/webhooks\/[^/]+\/tickets\/csat\/[^/]+$/.test(path)
}

/**
 * How a failed response is logged: its status, the error behind it when one was
 * thrown, and whether the route marked its 503 as one of our own dependencies down.
 */
export function responseFailure(c: Context<AppEnv>) {
  return classifyFailure({
    status: c.res.status,
    err: c.error,
    ownDependencyDown: c.get("ownDependencyDown") === true,
  })
}

// Global middleware
app.use(
  pinoLogger({
    pino: rootLogger,
    http: {
      onReqBindings: (c) => ({
        req: { method: c.req.method, url: c.req.path },
      }),
      onReqMessage: false,
      onResBindings: (c) => ({
        res: { status: c.res.status },
        // Why a failed response logged at warn (lib/failure-severity.ts).
        ...(c.res.status >= 400 && { reason: responseFailure(c).reason }),
        ...(c.res.status >= 400 && {
          req: {
            method: c.req.method,
            url: c.req.path,
            headers: {
              "content-type": c.req.header("content-type"),
              "user-agent": c.req.header("user-agent"),
              "x-request-id": c.req.header("x-request-id"),
            },
          },
        }),
      }),
      // Error level means something here is broken: a 4xx, a 501, a 503 relayed
      // from an outside upstream and a caller that hung up mid-request are
      // outcomes, logged at warn. A 503 for our own dependency stays at error.
      onResLevel: (c) => (c.res.status >= 400 ? responseFailure(c).level : "info"),
      onResMessage: (c) => (c.error ? c.error.message : "Request completed"),
    },
  }),
)
app.use("*", securityHeaders())
// Managed edition: every response names the instance that served it (an org's
// move between two instances is measured with it).
app.use("*", cellHeaderMiddleware)
app.use("*", latencyWindowMiddleware())
// X-Liaison-Client (modules/client-policy): debug log only, never access.
app.use("/api/*", logClientHeader)

if (env.NODE_ENV !== "test" && env.ALLOWED_ORIGINS === "*") {
  throw new Error("ALLOWED_ORIGINS=* is only permitted in test environments")
}

// The web app's configured origins PLUS the wrapped shells' own
// (lib/app-origins.ts): apps/web inside Capacitor or Tauri is served from
// capacitor://localhost, tauri://localhost or http://tauri.localhost and calls whatever server the
// user named, cross origin and with credentials, so an allowlist without them
// makes the mobile and desktop apps see nothing but network errors.
const corsAllowlist = [
  ...parseOriginAllowlist(env.ALLOWED_ORIGINS),
  ...parseOriginAllowlist(env.LIAISON_APP_ORIGINS),
]

// With org hosts (LIAISON_ORG_HOST_TEMPLATE), CORS allows exactly the request's
// own org origin plus the shells' fixed origins: never another tenant's host,
// never a pattern (lib/org-host.ts). The template is read per request.
const appShellOrigins = parseOriginAllowlist(env.LIAISON_APP_ORIGINS)

// Host binding: a host that names no org (the cell's own names, a tunnel host,
// loopback, an IP) serves only the control API, health, diagnostics and inbound
// webhooks. A no-op without org hosts.
app.use("*", async (c, next) => {
  if (requestHostBinding(c).kind === "non-org" && !isNonOrgHostPath(c.req.path)) {
    return c.json({ error: { message: "Not found", code: "HOST_NOT_ORG" } }, 404)
  }
  await next()
})

app.use(
  cors({
    origin: (origin, c) => {
      if (hostBindingEnabled()) return boundCorsOrigin(c, origin ?? "", appShellOrigins)
      return env.ALLOWED_ORIGINS === "*"
        ? origin // Reflect any origin in dev/test (credentials-compatible wildcard)
        : resolveCorsOrigin(origin ?? "", corsAllowlist)
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // X-Liaison-Refresh is how a wrapped shell presents the refresh token it
    // holds: its own origin is cross site to every server, so the cookie is
    // never attached and a preflight that omits this header blocks the whole
    // session (lib/response.ts). X-Node-Credential is how the desktop node
    // proves which node it is on every node job call (nodes/credentials.ts);
    // X-Liaison-Node-Protocol is the node protocol it speaks on claim (D46).
    // X-Liaison-Client is a shell's self-declared version, allowed one release
    // before any shell sends it (modules/client-policy).
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Liaison-Refresh",
      "X-Node-Credential",
      "X-Liaison-Node-Protocol",
      CLIENT_HEADER,
    ],
  }),
)
// The upload relay carries whole file bodies — its size cap is the byte count
// pinned inside the signed file token (checked in the handler), not the
// generic 1 MB JSON cap.
// Exported so a route test can assemble the SAME stack rather than a bare Hono
// of its own: a route tested without the body limit and the request timeout in
// front of it is a route whose interaction with them is untested, which is
// exactly how the demo signup shipped under a 30 s timeout it could not meet.
export const apiBodyLimitMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.path.startsWith("/api/file-relay/")) return next()
  // Bug reports carry inline base64 screenshots (reporters may hold no tickets
  // scopes, so they can't use the staged-upload path) — bounded by the route's
  // own per-attachment/count caps, not the generic 1 MB JSON cap.
  if (c.req.path.startsWith("/api/bug-reports")) {
    return bodyLimit({ maxSize: 25 * 1024 * 1024 })(c, next)
  }
  // Avatar upload carries the raw image body — bounded by the route's own 5 MB
  // ceiling (with headroom here), not the generic 1 MB JSON cap.
  if (c.req.method === "POST" && c.req.path === "/api/users/me/avatar") {
    return bodyLimit({ maxSize: 8 * 1024 * 1024 })(c, next)
  }
  // A dictation recording (one client-cut segment, or a short recording whole)
  // is posted as its raw audio bytes: up to TRANSCRIBE_MAX_BYTES, refused with
  // the dictation endpoints' own error shape past that.
  if (c.req.method === "POST" && c.req.path === "/api/assist/transcribe") {
    return bodyLimit({
      maxSize: TRANSCRIBE_MAX_BYTES,
      onError: (ctx) =>
        ctx.json(
          {
            error: {
              code: "too_large",
              message: serverT("en", "kernel.dictationErrors.tooLarge"),
            },
          },
          413,
        ),
    })(c, next)
  }
  // An agent's picture rides the same raw-image body as a user's.
  if (c.req.method === "POST" && /^\/api\/agents\/[^/]+\/avatar$/.test(c.req.path)) {
    return bodyLimit({ maxSize: 8 * 1024 * 1024 })(c, next)
  }
  // Approving a gated send from a sealed (end-to-end encrypted) mailbox: the
  // approver's browser posts the decrypted draft AND the decrypted bytes of
  // every re-attached file, base64, in the decide body, because by design that
  // plaintext is never stored server side (approvals/mailbox-fulfilment.ts).
  // The route's own parser caps those bytes; this cap only has to let that
  // ceiling through.
  if (c.req.method === "POST" && /^\/api\/approvals\/[^/]+\/decide$/.test(c.req.path)) {
    return bodyLimit({ maxSize: APPROVAL_DECIDE_BODY_MAX_BYTES })(c, next)
  }
  // Making a private mailbox transparent: the owner's browser posts the
  // opened content of its own mail, a batch of rows or one attachment (up to
  // 25 MiB), for the server to seal (mailbox-keys/encryption-mode-routes.ts).
  if (
    c.req.method === "POST" &&
    /^\/api\/mailbox\/encryption\/accounts\/[^/]+\/make-transparent\/(batch|files\/[^/]+)$/.test(
      c.req.path,
    )
  ) {
    return bodyLimit({ maxSize: 26 * 1024 * 1024 })(c, next)
  }
  // A browser's answer to an agent's mailbox request: the decrypted bodies of up
  // to 25 messages, and attachment bytes for a conversion (answer-limits.ts).
  if (
    c.req.method === "POST" &&
    /^\/api\/agent\/mailbox-(plaintext|search)\/[^/]+$/.test(c.req.path)
  ) {
    return bodyLimit({ maxSize: MAILBOX_ANSWER_BODY_MAX_BYTES })(c, next)
  }
  // A node session's event batch: up to 1 MiB of events (refused in the route
  // with the protocol's own 413 shape) plus its envelope.
  if (c.req.method === "POST" && /^\/api\/node\/sessions\/[^/]+\/events$/.test(c.req.path)) {
    return bodyLimit({ maxSize: 2 * 1024 * 1024 })(c, next)
  }
  // A cut tool output's whole text (P3-T21): up to 20 MiB, refused in the route
  // past that, plus headroom.
  if (
    c.req.method === "PUT" &&
    /^\/api\/node\/sessions\/[^/]+\/full-output\/[^/]+$/.test(c.req.path)
  ) {
    return bodyLimit({ maxSize: 21 * 1024 * 1024 })(c, next)
  }
  return bodyLimit({ maxSize: 1 * 1024 * 1024 })(c, next)
}
app.use("/api/*", apiBodyLimitMiddleware)
// Demo-instance signup limiter. Registered BEFORE the global /api/* limiter so
// Hono runs it first: a signup flood is refused on the tight per-IP budget
// (LIAISON_DEMO_SIGNUPS_PER_IP_PER_HOUR) instead of spending the deployment-wide
// budget on its way to being refused. Unlike the global limiter this is NOT
// disabled under NODE_ENV=test: the limit is part of what the route is, so a
// test that does not exercise it is not exercising the route.
//
// The import is lazy so that a non-demo process never EXECUTES this module, not
// because it keeps the demo code out of the process: `credit-meter.ts`,
// `egress.ts` and `connections/service.ts` import the demo modules statically,
// as they must, since the restrictions have to be reachable from the paths they
// restrict. What the flag decides is whether any of it ever runs, and the first
// line of every one of those guards is the demo-mode check.
if (env.LIAISON_DEMO_MODE) {
  const { useDemoRateLimit } = await import("~/modules/demo/routes")
  useDemoRateLimit(app, redis)
}

/**
 * The routes someone uses to recover or refresh access: a TOTP setup or step-up,
 * a password change, a WebSocket ticket, a device-flow approval, the MCP OAuth
 * consent POST. Their limiters fail OPEN, so a Redis outage cannot turn a cache
 * incident into a lockout. Both layers have to agree: the per-IP limiter runs
 * first on /api/*, so a fail-open per-user limiter behind a fail-closed IP
 * limiter would never be reached during the very outage it exists for.
 */
export function isCredentialRecoveryPath(path: string): boolean {
  return (
    path.startsWith("/api/auth/totp") ||
    path === "/api/auth/password/change" ||
    path.startsWith("/api/auth/ws-ticket") ||
    path.startsWith("/api/auth/device-flow/pending") ||
    path.startsWith("/api/auth/device-flow/approve") ||
    path.startsWith("/api/auth/device-flow/deny") ||
    path.startsWith("/mcp/oauth/authorize/consent")
  )
}

// Pre-auth per-IP limiting, applied unconditionally — disabled only in test env
// to avoid interference. The disable is a request-time wrapper rather than a
// mount-time branch so RATE_LIMIT_FORCE_ENABLED can exercise the real wiring.
const ipLimiter = rateLimiter(redis)
const ipLimiterFailOpen = rateLimiter(redis, { failOpen: true })
app.use("/api/*", async (c, next) => {
  if (env.NODE_ENV === "test" && !envFlag("RATE_LIMIT_FORCE_ENABLED")) return next()
  // The signed Control→cell API: one caller for every tenant, budgeted after
  // its signature is verified (modules/cloud/verify.ts), never per IP.
  if (c.req.path.startsWith("/api/cloud/")) return next()
  if (await isHarnessSignedRequest(c)) return next()
  return isCredentialRecoveryPath(c.req.path) ? ipLimiterFailOpen(c, next) : ipLimiter(c, next)
})

/**
 * A request signed with the box's load-harness key (lib/load-harness.ts) skips
 * the per-IP limiter, and only that one: a load generator is one address for a
 * thousand synthetic visitors, which real launch traffic never is, so the
 * per-IP budget would measure the generator instead of the box. The per-user,
 * per-org, demo and spend caps still apply to it. Only with the key set; a
 * request without the harness headers is not even read.
 */
async function isHarnessSignedRequest(c: Context<AppEnv>): Promise<boolean> {
  if (!loadHarnessEnabled() || c.req.header(HARNESS_HEADER_SIGNATURE) === undefined) return false
  return (await verifyHarnessContext(c)).kind === "valid"
}

// Global request timeout for all /api/* routes except long-lived SSE streams.
// Agent chat (/api/agent/chat) streams AI responses indefinitely; applying a
// hard timeout there would sever in-progress replies.
// Exported alongside apiBodyLimitMiddleware, for the same reason.
//
// /api/demo/* is NOT exempt, deliberately. The demo signup used to do up to two
// minutes of seeding inside the request and be cut off here at thirty seconds,
// and the fix was to make the route fast rather than to make the timeout long:
// it now returns a session and populates the workspace behind the response, and
// a test drives it through this middleware with a seeder that never returns.
export const apiRequestTimeoutMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.path.startsWith("/api/agent/chat")) return next()
  // A turn's re-attach stream (S10, M10) follows it to its end, bounded by the
  // route's own lifetime.
  if (/^\/api\/agent\/turns\/[^/]+\/events$/.test(c.req.path)) return next()
  // File-relay uploads buffer whole file bodies from slow client links — the
  // token's own 15-min TTL bounds them instead of the generic request timeout.
  if (c.req.path.startsWith("/api/file-relay/")) return next()
  // Download relay streams whole objects (a large preset) to slow client links;
  // the token TTL bounds it, so skip the generic request timeout here too.
  if (c.req.path.startsWith("/api/file-relay-dl/")) return next()
  // The org export relay streams a whole-org archive (up to 4 GB); its token's
  // 5-minute TTL bounds the start, the stream runs to its end.
  if (c.req.path.startsWith("/api/org-export-dl/")) return next()
  // A dictation is transcribed (and cleaned up) inside the request: the
  // upstream speech-to-text call alone may take up to its own 60 s timeout, so
  // the route gets a longer budget than the generic 30 s. The abort signal is
  // kept: the route hands it to the provider fetch.
  if (c.req.method === "POST" && c.req.path === "/api/assist/transcribe") {
    return requestTimeout(TRANSCRIBE_REQUEST_TIMEOUT_MS)(c, next)
  }
  // requestTimeout (not hono/timeout): it aborts a request-scoped AbortSignal
  // as well as answering 504, so the sandbox worker pool actually learns the
  // caller is gone and frees the worker. See middleware/request-timeout.ts.
  return requestTimeout(env.REQUEST_TIMEOUT_MS)(c, next)
}
app.use("/api/*", apiRequestTimeoutMiddleware)

// Error handler
app.onError(errorHandler)

// Public routes
app.route("/api/health", health)

// The desktop's first launch, before any token exists. Mounted HERE, above
// every `authMiddleware` line, because the whole point is that it answers with
// no credential at all; it carries the deployment's name and nothing else.
app.route("/api/settings", brandingRoutes)

// The shells' version policy (S4): public, before any credential, and its own
// per-IP budget on top of the /api/* ceiling.
app.use("/api/client-policy", publicSurfaceRateLimit(redis))
app.route("/api/client-policy", clientPolicyRoutes)

// The public demo signup (POST /api/demo/orgs). Mounted ONLY when
// LIAISON_DEMO_MODE is on: with the flag off the route does not exist and the
// path 404s, which is the difference between a gate and a guard. Mounted here,
// unauthenticated by design (there is no account yet) but AFTER the global
// limiter and request timeout above, so it carries every protection a normal
// public route carries plus its own tighter one.
if (env.LIAISON_DEMO_MODE) {
  const { mountDemoRoutes } = await import("~/modules/demo/routes")
  mountDemoRoutes(app)
}

// Phase 14: top-level /healthz (outside /api/) — version + migration head +
// dependency status. Consumed by load balancers, `liaison.sh upgrade` health
// gate, and `validate-compose`.
app.route("/healthz", healthzRoutes)
// Readiness (lib/readiness.ts): 200 once this process's role has booted and it
// is not draining. Mounted before the maintenance short-circuit, like /healthz.
app.route("/readyz", readyzRoutes)

// C3: top-level /diag (outside /api/), mounted BEFORE maintenanceMiddleware below so the
// monitoring watchdog still gets diagnostics during an upgrade -- exactly like /healthz.
// Bearer-token guarded internally (MONITOR_TOKEN); Caddy additionally denies it publicly.
app.route("/diag", monitorDiagRoutes)

// Phase 14 A2 load test: server-side WS emit endpoint, mounted only when
// ENABLE_LOAD_TEST_ENDPOINT=true. The k6 A2 script POSTs here from inside its
// WS-connected VUs; the receiving WS handler measures `_serverEmittedAt`.
if (envFlag("ENABLE_LOAD_TEST_ENDPOINT")) {
  // Lazy import keeps the load-test module out of production bundles when the
  // env flag is unset.
  const { createLoadTestRoutes } = await import("~/modules/loadtest/routes")
  app.route("/api/__loadtest", createLoadTestRoutes(env.JWT_SECRET))
}

// Phase 14 Track F: maintenance flag short-circuit. Mounted AFTER /healthz so
// the health probe stays reachable during an upgrade; the middleware itself
// also bypasses /healthz as defense-in-depth.
app.use("*", maintenanceMiddleware())

// The signed Control→cell API (managed edition; 404 on self-hosted, checked
// per request). Before the user JWT chain: its only credential is Control's
// signature (modules/cloud/verify.ts).
app.route("/api/cloud", cloudRoutes)

// The former bearer credit-mint API: retired (credits reach an org only
// through the signed /api/cloud grants). Its paths keep answering 404 in every
// edition, before the user JWT chain, so they never turn into a 401.
for (const path of ["/api/admin/billing", "/api/admin/billing/*"]) {
  app.all(path, (c) => c.json({ error: { message: "not found", code: "not_found" } }, 404))
}

// Post-auth per-user limiter (RATE_LIMIT_PER_USER). Composed ONTO the auth
// middleware rather than registered as its own `/api/*` middleware because a
// standalone `app.use("/api/*", ...)` would run BEFORE auth, with no acting
// user to bucket by. Composing it means every authenticated route gets it in
// the one place the identity is already resolved. `authPlusLimit` is the
// composition for the auth-plumbing routes below, which never see `authMw`.
const perUserLimiter = userRateLimiter(redis)
// These mounts are how someone recovers access (password change, TOTP step-up,
// a WebSocket ticket, a device-flow approval), so their limiter fails OPEN: a
// Redis outage must not also close the credential routes. Note it composes the
// RAW auth middleware, not the demo-aware `authMw` below, and carries no org
// limiter: both pre-existing, and unchanged here.
const authPlusLimit: MiddlewareHandler<AppEnv> = every(
  authMiddleware(env.JWT_SECRET),
  userRateLimiter(redis, { failOpen: true }),
)

// TOTP setup/confirm/status require authentication (verify uses challenge token)
// Must be registered BEFORE the auth routes so middleware runs first
app.use("/api/auth/totp/setup", authPlusLimit)
app.use("/api/auth/totp/confirm", authPlusLimit)
app.use("/api/auth/totp/status", authPlusLimit)
app.use("/api/auth/totp/step-up", authPlusLimit)
app.use("/api/auth/totp", authPlusLimit) // DELETE /totp
app.use("/api/auth/password/change", authPlusLimit)
app.use("/api/auth/account/*", authPlusLimit)

app.route("/api/auth", auth)
app.route("/api/auth/oauth", oauth)

// Device flow: initiate + poll are public; approve + deny require auth.
// Initiate writes a row per call, so it has its own per-IP budget.
app.use("/api/auth/device-flow/initiate", publicSurfaceRateLimit(redis))
app.use("/api/auth/device-flow/pending/*", authPlusLimit)
app.use("/api/auth/device-flow/approve/*", authPlusLimit)
app.use("/api/auth/device-flow/deny/*", authPlusLimit)
app.route("/api/auth/device-flow", deviceFlow)

// WebSocket ticket: exchange access token for single-use ticket
app.use("/api/auth/ws-ticket", authPlusLimit)
app.route("/api/auth/ws-ticket", wsTicket)

// Authenticated routes — orgLimiter enforces per-org rate limit overrides after auth sets orgId
const orgLimiter = orgRateLimiter(redis)
// On a DEMO instance every authenticated route additionally refuses an EXPIRED
// visitor workspace. Composed onto auth rather than registered as its own
// `/api/*` middleware because this is the one place the org id is already
// resolved, and composed ONLY under the flag: with demo mode off `authMw` is
// the identical middleware reference it has always been, so a normal
// deployment gains no middleware, no branch and no query.
const baseAuthMw = authMiddleware(env.JWT_SECRET)
const authAndDemoMw: MiddlewareHandler<AppEnv> = env.LIAISON_DEMO_MODE
  ? every(baseAuthMw, (await import("~/modules/demo/demo-expiry")).demoExpiryMiddleware())
  : baseAuthMw
const authMw: MiddlewareHandler<AppEnv> = every(authAndDemoMw, perUserLimiter)

app.use("/api/users", authMw, orgLimiter)
app.use("/api/users/*", authMw, orgLimiter)
app.route("/api/users", userRoutes)

// Settings -> Notifications: the grid, work hours and digest cadence (self only),
// and the caller's devices. The receipt endpoint alone is not a session route:
// a device posts it with its receipt-only credential (A7), from an NSE or a
// service worker that holds no session.
const notificationsSessionMw = every(authMw, orgLimiter)
app.use("/api/notifications/*", (c, next) =>
  c.req.path === NOTIFICATION_RECEIPTS_PATH ? next() : notificationsSessionMw(c, next),
)
app.route("/api/notifications", notificationSettingsRoutes)
app.route("/api/notifications", notificationDeviceRoutes)
app.route("/api/notifications", notificationReceiptRoutes)

// A11: QA-only notification injection for the push matrix. Absent (404) unless
// LIAISON_QA_ROUTES is on, before any auth so "absent" looks absent.
app.use("/api/qa/notifications/*", async (c, next) => {
  if (!env.LIAISON_QA_ROUTES)
    return c.json({ error: { message: "Not found", code: "NOT_FOUND" } }, 404)
  await next()
})
app.use("/api/qa/notifications/*", authMw, orgLimiter)
app.route("/api/qa/notifications", qaNotificationRoutes)

app.use("/api/user/preferences", authMw, orgLimiter)
app.use("/api/user/preferences/*", authMw, orgLimiter)
app.route("/api/user/preferences", preferencesRoutes)

// API connector admin/read routes (kernel module; scopes checked per route).
app.use("/api/api-connector/*", authMw, orgLimiter)
app.use("/api/api-connector/*", kernelPrefixStateGate("api-connector"))
app.route("/api/api-connector", apiConnectorRoutes)

// Database connector settings (kernel module; kernel:apps:admin per route).
app.use("/api/database/*", authMw, orgLimiter)
app.use("/api/database/*", kernelPrefixStateGate("database"))
app.route("/api/database", databaseRoutes)

app.use("/api/assist", authMw, orgLimiter)
app.use("/api/assist/*", authMw, orgLimiter)
app.route("/api/assist", assistRoutes)

// The agent composition API (spec-runtime.md): session identity only.
app.use("/api/agents/*", authMw, orgLimiter)
app.route("/api/agents", agentMemoryRoutes)
app.route("/api/agents", localSessionRoutes)
app.route("/api/agents", definitionRoutes)

// The local node (spec-node.md): registration, jobs, profiles. Session
// identity; the node's own calls also present its node credential.
app.use("/api/nodes", authMw, orgLimiter)
app.use("/api/nodes/*", authMw, orgLimiter)
app.route("/api/nodes", nodeAttachmentRoutes)
app.route("/api/nodes", threadNodeSettingsRoutes)
app.route("/api/nodes", nodePermissionRoutes)
app.route("/api/nodes", nodeTurnProgressRoutes)
app.route("/api/nodes", nodeRoutes)
app.route("/api/nodes", nodeJobRoutes)
app.route("/api/nodes", nodeFolderRoutes)
app.route("/api/nodes", dispatchRetryRoutes)

// Node sessions (spec-protocol.md): the owner's reads and level confirmations
// under /api/me, the node's own calls (session + node credential) under
// /api/node.
app.use("/api/me/node-sessions", authMw, orgLimiter)
app.use("/api/me/node-sessions/*", authMw, orgLimiter)
app.route("/api/me/node-sessions", meNodeSessionRoutes)
app.route("/api/me/node-sessions", meNodeSessionCommandRoutes)
app.route("/api/me/node-sessions", meNodeSessionFullOutputRoutes)
app.use("/api/me/node-level-confirmations", authMw, orgLimiter)
app.use("/api/me/node-level-confirmations/*", authMw, orgLimiter)
app.route("/api/me/node-level-confirmations", meLevelConfirmationRoutes)
app.use("/api/me/node-session-imports", authMw, orgLimiter)
app.use("/api/me/node-session-imports/*", authMw, orgLimiter)
app.route("/api/me/node-session-imports", meNodeSessionImportRoutes)
app.use("/api/node/sessions", authMw, orgLimiter)
app.use("/api/node/sessions/*", authMw, orgLimiter)
app.route("/api/node/sessions", nodeSessionReportRoutes)
app.route("/api/node/sessions", nodeSessionRoutes)
app.route("/api/node/sessions", nodeSessionFullOutputRoutes)
app.use("/api/node/folder-requests/*", authMw, orgLimiter)
app.route("/api/node/folder-requests", nodeFolderRequestRoutes)
app.use("/api/node/import-requests/*", authMw, orgLimiter)
app.route("/api/node/import-requests", nodeImportRequestRoutes)
app.use("/api/node/level-confirmations", authMw, orgLimiter)
app.use("/api/node/level-confirmations/*", authMw, orgLimiter)
app.route("/api/node/level-confirmations", nodeLevelConfirmationRoutes)

// Mobile device registration for push (spec-security.md S17). Bearer only:
// the row's owner is the session, never a user id in the body.
app.use("/api/push", authMw, orgLimiter)
app.use("/api/push/*", authMw, orgLimiter)
app.route("/api/push", pushRoutes)

app.use("/api/saved-views", authMw, orgLimiter)
app.use("/api/saved-views/*", authMw, orgLimiter)
app.route("/api/saved-views", savedViewsRoutes)

app.use("/api/org", authMw, orgLimiter)
app.use("/api/org/*", authMw, orgLimiter)
// Workspace app management (S24): every app, Off and restricted included, for admins.
app.route("/api/org/apps", orgAppRoutes)
// Whole-org export archives (modules/export/org-archive): org admins only.
app.use("/api/org/export", requireScope("kernel:org:admin"))
app.use("/api/org/export/*", requireScope("kernel:org:admin"))
app.route("/api/org/export", orgExportRoutes)
app.route("/api/org", org)

// Multi-app data export (Phase 13, E2). Admin-scoped — same orchestrator the
// kernel.export agent tool delegates to.
app.use("/api/export", authMw, orgLimiter, requireScope("kernel:users:admin"))
app.use("/api/export/*", authMw, orgLimiter, requireScope("kernel:users:admin"))
app.route("/api/export", exportRoutes)

// Import runs (modules/imports): per-route scopes inside the router. The
// uploads sub-path has its own auth and limiter (below): skip it here so a
// request is not authenticated and counted twice.
const importRunsMw = every(authMw, orgLimiter)
const isImportUploadsPath = (path: string) =>
  path === "/api/imports/uploads" || path.startsWith("/api/imports/uploads/")
app.use("/api/imports", importRunsMw)
app.use("/api/imports/*", (c, next) =>
  isImportUploadsPath(c.req.path) ? next() : importRunsMw(c, next),
)
app.route("/api/imports", importRoutes)

// Admin routes
app.use("/api/admin", authMw, orgLimiter)
app.use("/api/admin/*", authMw, orgLimiter)
app.use("/api/admin/invites", requireScope("kernel:users:admin"))
app.use("/api/admin/invites/*", requireScope("kernel:users:admin"))
app.route("/api/admin/invites", invites)
app.use("/api/admin/users", requireScope("kernel:users:admin"))
app.use("/api/admin/users/*", requireScope("kernel:users:admin"))
app.route("/api/admin/users", adminUserRoutes)
app.use("/api/admin/roles", requireScope("kernel:users:admin"))
app.use("/api/admin/roles/*", requireScope("kernel:users:admin"))
app.route("/api/admin/roles", adminRoles)
app.use("/api/admin/oauth-providers", requireScope("kernel:users:admin"))
app.use("/api/admin/oauth-providers/*", requireScope("kernel:users:admin"))
app.route("/api/admin/oauth-providers", oauthAdmin)
app.use("/api/admin/scope-catalog", requireScope("kernel:users:admin"))
app.use("/api/admin/scope-catalog/*", requireScope("kernel:users:admin"))
app.route("/api/admin/scope-catalog", scopeCatalogRoutes)
app.use("/api/admin/dimension-catalog", requireScope("kernel:users:admin"))
app.use("/api/admin/dimension-catalog/*", requireScope("kernel:users:admin"))
app.route("/api/admin/dimension-catalog", dimensionCatalogRoutes)

// Phase 14 Track F: version-check (admin only). Hits the GitHub releases API
// with a 6h Redis cache + stale fallback.
app.use("/api/admin/version-check", requireScope("kernel:org:admin"))
app.use("/api/admin/version-check/*", requireScope("kernel:org:admin"))
app.route("/api/admin/version-check", versionCheckRoutes)
// Settings > System, "Liaison team": the opt-in registration and bug report forwarding switches.
app.use("/api/admin/liaison-team", requireScope("kernel:org:admin"))
app.use("/api/admin/liaison-team/*", requireScope("kernel:org:admin"))
app.route("/api/admin/liaison-team", liaisonTeamRoutes)
// The settings page's dependency pills: the same detail /healthz gives local
// callers, behind an admin session (public /healthz is liveness only).
app.use("/api/admin/system-health", requireScope("kernel:org:admin"))
app.route("/api/admin/system-health", systemHealthRoutes)

// Contact routes (authenticated, scope-checked)
app.use("/api/contacts", authMw, orgLimiter)
app.use("/api/contacts/*", authMw, orgLimiter)
app.use("/api/contacts", kernelPrefixStateGate("contacts"))
app.use("/api/contacts/*", kernelPrefixStateGate("contacts"))
app.use(
  "/api/contacts",
  requireScope({ GET: "kernel:contacts:read", "*": "kernel:contacts:write" }),
)
app.use(
  "/api/contacts/*",
  requireScope({ GET: "kernel:contacts:read", "*": "kernel:contacts:write" }),
)
app.route("/api/contacts", contacts)

// Trusted senders (any member reads with contacts or tickets read; a contacts or tickets
// settings admin changes them; the handler checks the scopes).
app.use("/api/trusted-senders", authMw, orgLimiter)
app.use("/api/trusted-senders/*", authMw, orgLimiter)
app.route("/api/trusted-senders", trustedSendersRoutes)

// Document templates (modules/documents): any member who reads files reads them, an org
// admin creates, changes, archives them and replaces their file.
app.use("/api/document-templates", authMw, orgLimiter)
app.use("/api/document-templates/*", authMw, orgLimiter)
app.use(
  "/api/document-templates",
  requireScope({ GET: "kernel:files:read", "*": "kernel:org:admin" }),
)
app.use(
  "/api/document-templates/*",
  requireScope({ GET: "kernel:files:read", "*": "kernel:org:admin" }),
)
app.route("/api/document-templates", documentTemplateRoutes)

// Needed-template rules (modules/documents/rules-store.ts): which templates a record needs.
// An org admin reads and changes them; matching runs through the agent tools.
app.use("/api/document-template-rules", authMw, orgLimiter)
app.use("/api/document-template-rules/*", authMw, orgLimiter)
app.use("/api/document-template-rules", requireScope("kernel:org:admin"))
app.use("/api/document-template-rules/*", requireScope("kernel:org:admin"))
app.route("/api/document-template-rules", documentTemplateRuleRoutes)

// Printing a record through the org's templates (modules/documents/print.ts): any member who
// reads files lists the templates and record types; printing also needs the record's own file
// write scope, checked by the print service.
app.use("/api/documents", authMw, orgLimiter)
app.use("/api/documents/*", authMw, orgLimiter)
app.use("/api/documents", requireScope("kernel:files:read"))
app.use("/api/documents/*", requireScope("kernel:files:read"))
app.route("/api/documents", documentRoutes)

// Guided tours (any member): the catalogue and the caller's own progress (modules/tours).
app.use("/api/tours", authMw, orgLimiter)
app.use("/api/tours/*", authMw, orgLimiter)
app.route("/api/tours", tourRoutes)

// Sharing pickers (any member): the people and roles a resource can be shared with.
app.use("/api/sharing", authMw, orgLimiter)
app.use("/api/sharing/*", authMw, orgLimiter)
app.route("/api/sharing", sharingRoutes)

// Bug reports (authenticated — open to every member, no tickets scope needed;
// the handler creates the ticket privileged into the configured bug inbox).
// The wildcard covers /forwarding and /forward-preview.
app.use("/api/bug-reports", authMw, orgLimiter)
app.use("/api/bug-reports/*", authMw, orgLimiter)
app.route("/api/bug-reports", bugReports)

// Audit routes (authenticated, admin-only)
app.use("/api/audit", authMw, orgLimiter)
app.use("/api/audit/*", authMw, orgLimiter)
app.use("/api/audit", requireScope("kernel:audit:read"))
app.use("/api/audit/*", requireScope("kernel:audit:read"))
app.route("/api/audit", auditRoutes)

// Timeline routes (authenticated — scope checked per-entity in timeline service)
app.use("/api/timeline", authMw, orgLimiter)
// The host API majors this server answers (S3): public, majors only.
app.route("/api/apps/host-api", hostApiRoutes)

app.use("/api/timeline/*", authMw, orgLimiter)
app.route("/api/timeline", timeline)

// App routes (authenticated — tool execution checks per-tool scopes internally).
// The OAuth bypass is scoped to /api/apps/mcp-manager/oauth/{callback,done}
// specifically — earlier the regex matched any app path ending in oauth/callback,
// which would silently bypass auth for a future app installing its own callback
// endpoint at /api/apps/myapp/oauth/callback (review I17). The Client ID
// Metadata Document is fetched by an MCP server's authorization server, which
// holds no Liaison session, so it is a landing too: that one document, no path
// under it.
const isMcpManagerOAuthLanding = (path: string): boolean =>
  /^\/api\/apps\/mcp-manager\/oauth\/(?:(?:callback|done)(?:\?|$|\/)|client-metadata\.json(?:\?|$))/.test(
    path,
  )
// Phase 16.5 — plugin app UI bundle path (and, beside it, the signed statement,
// signature and manifest of a signed first-party app). Browser `import()` cannot send the
// Bearer header, so this route skips the bearer chain; the handler decides
// access itself: first-party bundles are public, any other installed app's
// bundle needs the short-lived URL token the authenticated app list issues
// (modules/apps/ui-bundle-token.ts). It validates name/version against
// `apps_active_version` and a path-traversal regex, so it can only serve files
// for actively installed apps. The frame document a browser frames an outside
// app's interface in (`frame`, modules/apps/app-frame.ts) is loaded by an
// iframe, which cannot send the header either, and is gated the same way.
const isPluginUiBundle = (path: string): boolean =>
  /^\/api\/apps\/[a-z][a-z0-9-]*\/\d+\.\d+\.\d+(-[\w.]+)?\/(ui\.js|statement\.json|statement\.sig|manifest\.json|frame)$/.test(
    path,
  )
app.use("/api/apps", async (c, next) => {
  if (isMcpManagerOAuthLanding(c.req.path) || isPluginUiBundle(c.req.path)) return next()
  return authMw(c, next)
})
app.use("/api/apps/*", async (c, next) => {
  if (isMcpManagerOAuthLanding(c.req.path) || isPluginUiBundle(c.req.path)) return next()
  return authMw(c, next)
})
app.use("/api/apps", async (c, next) => {
  if (isMcpManagerOAuthLanding(c.req.path) || isPluginUiBundle(c.req.path)) return next()
  return orgLimiter(c, next)
})
app.use("/api/apps/*", async (c, next) => {
  if (isMcpManagerOAuthLanding(c.req.path) || isPluginUiBundle(c.req.path)) return next()
  return orgLimiter(c, next)
})
// An app turned Off or removed for the workspace answers 410 on its own
// routes, and 403 to a person a restricted app is restricted away from (S19,
// S20); admins keep its read-only management routes (app-state-gate.ts).
app.use("/api/apps/*", async (c, next) => {
  if (isMcpManagerOAuthLanding(c.req.path) || isPluginUiBundle(c.req.path)) return next()
  return appRouteStateGate(c, next)
})
app.route("/api/apps", bulkRoutes)
app.route("/api/apps", installRoutes)
// Phase 16.5 — UI bundle serving for installed plugin apps. Mount BEFORE
// appRoutes so the more-specific `:name/:version/ui.js` pattern wins. Auth +
// rate-limit are applied by the `/api/apps/*` middleware above.
app.route("/api/apps", uiBundleRoutes)
// mcp-manager's own routes BEFORE the generic app routes: appRoutes' catch-all
// `GET /:appName/connections` (manifest connection views) otherwise answers
// `/api/apps/mcp-manager/connections` with [] and both MCP lists come up empty.
// Auth and the OAuth landing bypass come from the /api/apps middleware above.
app.route("/api/apps/mcp-manager", mcpManagerRoutes)
app.route("/api/apps/mcp-manager", mcpManagerOAuthRoutes)
app.route("/api/apps/mcp-manager", mcpManagerAuditRoutes)
// Declarative settings: GET|PATCH /api/apps/:app/settings/{org,user}.
app.route("/api/apps", appSettingsRoutes)
app.route("/api/apps", appRoutes)

// Aggregated attention feed (authenticated — providers self-authorize per-row)
app.use("/api/attention-items", authMw, orgLimiter)
app.use("/api/attention-items/*", authMw, orgLimiter)
app.route("/api/attention-items", attentionRoutes)

// Home's "Today's brief": the caller's own morning-brief routine's newest output.
app.use("/api/home/*", authMw, orgLimiter)
app.route("/api/home", homeBriefRoutes)

// Phase 16 Task A8a — user-scoped subscription rules + installed-app axes registry.
app.use("/api/attention/subscriptions", authMw, orgLimiter)
app.use("/api/attention/subscriptions/*", authMw, orgLimiter)
app.route("/api/attention/subscriptions", attentionSubscriptionsRoutes)
app.use("/api/apps/manifests/attention-axes", authMw, orgLimiter)
app.route("/api/apps/manifests", manifestsAxesRoutes)

// Phase 17 Task B9 — slot enumeration for UI extension points (contact_detail, etc.)
app.use("/api/v1/slots", authMw, orgLimiter)
app.use("/api/v1/slots/*", authMw, orgLimiter)
app.route("/api/v1/slots", slotsRoutes)

// Connection routes — OAuth callback is public (no auth), rest requires auth
app.get("/api/connections/callback", async (c) => {
  const {
    connectCardReturnUrl,
    discardOAuthState,
    getFrontendRedirectUrl,
    peekOAuthStateApp,
    receiveOAuthCallback,
  } = await import("~/modules/apps/connections/service")
  const { appSettingsPath, SETTINGS_CONNECTORS_PATH } = await import(
    "~/modules/apps/settings-paths"
  )
  const { desktopHandoffResponse } = await import("~/modules/auth/desktop-oauth")
  const error = c.req.query("error")
  const errorDescription = c.req.query("error_description")
  const state = c.req.query("state")
  // A failed callback goes back to the settings of the app that started it
  // (read before the state is consumed); an unknown state, to Connectors.
  const started = state ? await peekOAuthStateApp(state) : null
  // A flow started just before the org's deletion began writes nothing into
  // the purge (S2.5): the state is consumed and the callback answers 410.
  if (state && started) {
    const { isOrgDeletingAsync } = await import("~/modules/apps/org-apps")
    if (await isOrgDeletingAsync(started.orgId)) {
      await discardOAuthState(state)
      const { OrgDeletedError } = await import("~/modules/org/purge/deleting")
      throw new OrgDeletedError()
    }
  }
  const errorPath = started
    ? appSettingsPath(started.orgId, started.appName)
    : SETTINGS_CONNECTORS_PATH
  // A connect a card in a conversation started goes back there (or to the
  // page that closes its popup), with the reason, never to a settings page.
  const card = started?.card ?? null
  // The card that started it is also told the reason over its own event, so a
  // popup that ends on its closing page leaves the card saying why (the card
  // never reads the popup).
  const backWith = async (params: URLSearchParams, settingsPath = errorPath) => {
    // A connect started from a one-time link (`liaison connect --for`) fails
    // loud: the reason is recorded for whoever waits on the link (the CLI stops
    // with it) and the browser lands back on the link's page, which says why
    // and what to do, never on a settings page where a toast is easy to miss.
    if (started?.connectLink) {
      const reason = connectFailureReason(
        params.get("oauth_error"),
        params.get("oauth_error_description"),
      )
      // Our own refusals carry a sentence written for the person; a provider's
      // description is never shown (its fixed sentence is).
      const own = !error ? params.get("oauth_error_description") : null
      const refusal = {
        reason,
        message: own || serverT("en", `kernel.auth.connectFailedReason.${reason}`),
      }
      const { recordConnectLinkRefusal, connectLinkRefusedUrl } = await import(
        "~/modules/apps/connections/connect-links"
      )
      await recordConnectLinkRefusal(started.connectLink, refusal)
      return connectLinkRefusedUrl(started.orgId, refusal)
    }
    // A card comes only with the state that started the flow, so `started` is set.
    if (!card || !started) {
      return getFrontendRedirectUrl(started?.orgId ?? null, settingsPath, params)
    }
    // An admin-policy block (a Workspace that has not trusted the client) is told
    // apart from a person's refusal by the provider's description.
    const reason = connectFailureReason(
      params.get("oauth_error"),
      params.get("oauth_error_description"),
    )
    if (started) {
      const { announceConnectFailure } = await import("~/modules/secret-requests/service")
      await announceConnectFailure(started.orgId, card.requestId, reason)
    }
    return connectCardReturnUrl(started.orgId, card, { error: reason })
  }
  if (error) {
    // A flow a desktop or mobile app started is told in that app, through its
    // handoff link, not on a settings page of a browser it may not use.
    const shell = state ? await discardOAuthState(state) : null
    if (shell) {
      return desktopHandoffResponse(c, { error: error.slice(0, 200) }, shell.returnState, "connect")
    }
    const params = new URLSearchParams({ oauth_error: error })
    if (errorDescription) params.set("oauth_error_description", errorDescription)
    return c.redirect(await backWith(params))
  }

  const code = c.req.query("code")
  if (!code || !state) return c.text("Missing code or state", 400)
  // Every parameter the provider sent: Shopify signs them all (hmac), and
  // echoes the store as `?shop=`, which must name the store the flow was
  // started for (completeOAuthGrant). Other providers' extras are ignored.
  const callbackParams: Record<string, string> = c.req.query()
  try {
    const outcome = await receiveOAuthCallback(
      code,
      state,
      callbackParams,
      c.req.header("cookie"),
      requestHostBinding(c),
    )
    // A shell's flow is parked, not completed: the handoff page sends the
    // browser back to the app, which redeems it (shell-connect.ts).
    if (outcome.kind === "shell-handoff") {
      return desktopHandoffResponse(c, { code: outcome.code }, outcome.returnState, "connect")
    }
    return c.redirect(outcome.url)
  } catch (err) {
    const { OAuthAppDisabledError, OAuthBrowserMismatchError, OAuthCallbackRefusedError } =
      await import("~/modules/apps/connections/service")
    if (err instanceof OAuthCallbackRefusedError) {
      const params = new URLSearchParams({
        oauth_error: err.code,
        oauth_error_description: err.message,
      })
      return c.redirect(await backWith(params))
    }
    if (err instanceof OAuthAppDisabledError) {
      const params = new URLSearchParams({
        oauth_error: err.code,
        oauth_error_description: err.message,
      })
      return c.redirect(await backWith(params, err.settingsPath))
    }
    if (err instanceof OAuthBrowserMismatchError) {
      const params = new URLSearchParams({
        oauth_error: err.code,
        oauth_error_description: err.message,
      })
      return c.redirect(await backWith(params))
    }
    // A personal connect over an account the org (or another member) holds:
    // back to the settings page with the reason; the shared row is untouched.
    const { ConnectionHeldByOtherOwnerError } = await import("~/modules/apps/connections/service")
    if (err instanceof ConnectionHeldByOtherOwnerError) {
      const params = new URLSearchParams({
        oauth_error: err.code,
        oauth_error_description: err.message,
      })
      return c.redirect(await backWith(params))
    }
    // Every mailbox of the org's cap is connected (modules/org/caps.ts): back
    // to the app's settings with the reason.
    const { CapLimitError } = await import("~/modules/org/caps")
    if (err instanceof CapLimitError) {
      const params = new URLSearchParams({
        oauth_error: err.code,
        oauth_error_description: err.message,
      })
      return c.redirect(await backWith(params))
    }
    // A mailbox outside the org's allowed domains: back to the app's settings
    // with the reason, not a bare 500.
    const { MailDomainNotAllowedError } = await import("~/modules/apps/connections/mail-domains")
    if (!(err instanceof MailDomainNotAllowedError)) {
      // Any other failure of a link's connect still tells the link's waiter and
      // page (backWith) instead of leaving them waiting; the error is logged.
      if (started?.connectLink) {
        const { appsLogger } = await import("~/lib/logger")
        appsLogger.error(
          { err, orgId: started.orgId, appName: started.appName },
          "OAuth callback of a connect link failed",
        )
        return c.redirect(await backWith(new URLSearchParams({ oauth_error: "failed" })))
      }
      throw err
    }
    const params = new URLSearchParams({
      oauth_error: err.code,
      oauth_error_description: err.message,
    })
    return c.redirect(await backWith(params))
  }
})
// The page a connect card's popup ends on: says how it went and closes the
// window (connections/connect-done-page.ts). Public, like the callback that
// redirects here; it reads nothing but its own query and holds no state.
app.get("/api/connections/oauth-done", async (c) => {
  const { connectDonePage } = await import("~/modules/apps/connections/connect-done-page")
  return connectDonePage(c)
})
app.use("/api/connections", authMw, orgLimiter)
app.use("/api/connections/*", authMw, orgLimiter)
app.route("/api/connections", connectionRoutes)
// The Google Picker page (google-drive/picker-page.ts): public, its one-time
// ticket in the path is the only credential; it renders once per ticket.
app.get("/api/drive-picker/:ticket", async (c) => {
  const { drivePickerPage } = await import("~/apps/google-drive/picker-page")
  return drivePickerPage(c)
})
app.post("/api/drive-picker/:ticket/items", async (c) => {
  const { drivePickerPageSave } = await import("~/apps/google-drive/picker-page")
  return drivePickerPageSave(c)
})
app.use("/api/google-drive/*", authMw, orgLimiter)
app.route("/api/google-drive", drivePickerRoutes)
app.route("/api/google-drive", driveSharedDrivesRoutes)

app.use("/api/mail", authMw, orgLimiter)
app.use("/api/mail/*", authMw, orgLimiter)
app.use("/api/mail", kernelPrefixStateGate("mail"))
app.use("/api/mail/*", kernelPrefixStateGate("mail"))
app.route("/api/mail", mailRoutes)

// Mailbox keyring + cutover ledger. Owner scoped, no app scope: a user's own
// key material is not something an org role grants access to.
app.use("/api/mailbox-keys", authMw, orgLimiter)
app.use("/api/mailbox-keys/*", authMw, orgLimiter)
app.use("/api/mailbox-keys", kernelPrefixStateGate("mail"))
app.use("/api/mailbox-keys/*", kernelPrefixStateGate("mail"))
app.route("/api/mailbox-keys", mailboxKeysRoutes)
app.use("/api/mailbox", authMw, orgLimiter)
app.use("/api/mailbox/*", authMw, orgLimiter)
app.use("/api/mailbox", kernelPrefixStateGate("mail"))
app.use("/api/mailbox/*", kernelPrefixStateGate("mail"))
app.route("/api/mailbox/encryption", mailboxEncryptionRoutes)
app.route("/api/mailbox", mailboxRoutes)
// The client job queue shares the mount and the owner-scoped posture.
app.route("/api/mailbox", mailboxJobsRoutes)

// Projects routes (authenticated; per-route scopes applied inside the router)
app.use("/api/projects", authMw, orgLimiter)
app.use("/api/projects/*", authMw, orgLimiter)
app.use("/api/projects", kernelPrefixStateGate("projects"))
app.use("/api/projects/*", kernelPrefixStateGate("projects"))
app.route("/api/projects", projectsRoutes)

// MCP Manager (inbound MCP aggregator) — connections CRUD, tool-policy,
// OAuth start/callback, audit + usage. Per-route scope checks applied via
// requireScope() inside the routers. OAuth callback intentionally lacks a
// requireScope (browser redirect target; bound via mcp_oauth_state row).
//
// /oauth/callback and /oauth/done are loaded via browser redirect from a
// third-party OAuth issuer — there's no auth header / cookie attached at
// those paths. authMw is bypassed by the outer /api/apps middleware above
// when isMcpManagerOAuthLanding matches; security on the callback is
// enforced via the unguessable `state` token bound to a server-side
// mcp_oauth_state row.
// (mounted above, before the generic app routes: see there)

// Agent skills routes (authenticated; scope gates applied inside the router).
// Mounted BEFORE /api/agent so the more-general kernel:threads:write gate
// doesn't shadow these. Scope-checked per-method inside the router.
app.use("/api/agent/skills", authMw, orgLimiter)
app.use("/api/agent/skills/*", authMw, orgLimiter)
app.use(
  "/api/agent/skills",
  requireScope({ GET: "kernel:skills:read", "*": "kernel:skills:write" }),
)
app.use(
  "/api/agent/skills/*",
  requireScope({ GET: "kernel:skills:read", "*": "kernel:skills:write" }),
)
app.route("/api/agent/skills", skillsRoutes)

app.use("/api/agent/app-skills", authMw, orgLimiter)
app.use("/api/agent/app-skills/*", authMw, orgLimiter)
app.use(
  "/api/agent/app-skills",
  requireScope({ GET: "kernel:skills:read", "*": "kernel:skills:write" }),
)
app.use(
  "/api/agent/app-skills/*",
  requireScope({ GET: "kernel:skills:read", "*": "kernel:skills:write" }),
)
app.route("/api/agent/app-skills", appSkillsRoutes)

// Agent debug routes — gated on NODE_ENV === "test" inside the handler. E2E uses
// this to inspect the assembler's pre-LLM manifest without an LLM call.
app.use("/api/agent/_debug", authMw, orgLimiter)
app.use("/api/agent/_debug/*", authMw, orgLimiter)
app.use(
  "/api/agent/_debug/*",
  requireScope({ GET: "kernel:skills:read", "*": "kernel:skills:read" }),
)
app.route("/api/agent/_debug", agentDebugRoutes)

// Agent routines: caller owns the rows; per-method scope via require-scope.
app.use("/api/agent/routines", authMw, orgLimiter)
app.use("/api/agent/routines/*", authMw, orgLimiter)
app.use(
  "/api/agent/routines",
  requireScope({ GET: "kernel:routines:read", "*": "kernel:routines:write" }),
)
app.use(
  "/api/agent/routines/*",
  requireScope({ GET: "kernel:routines:read", "*": "kernel:routines:write" }),
)
app.route("/api/agent/routines", routinesRoutes)

// Agent user memory: per-user RLS-scoped CRUD. Scope check happens
// per-handler inside the router (read on GET, write on POST/PATCH/DELETE).
app.use("/api/agent/memories", authMw, orgLimiter)
app.use("/api/agent/memories/*", authMw, orgLimiter)
app.route("/api/agent/memories", memoriesRoutes)

// Agent routes (authenticated — requires thread write permission since it persists a user message).
// Note: tightened to /api/agent/chat so the more general /api/agent/{skills,app-skills,routines}
// surface (which has its own scope gates) isn't shadowed by kernel:threads:write.
app.use("/api/agent/chat", authMw, orgLimiter, requireScope("kernel:threads:write"))
app.use("/api/agent/chat/*", authMw, orgLimiter, requireScope("kernel:threads:write"))
// Re-attach to a turn that moved to another process (S10, M10): the gate of the
// /chat request that started it; the handler adds the requester and thread checks.
app.use("/api/agent/turns/*", authMw, orgLimiter, requireScope("kernel:threads:write"))
// In-flight run snapshot (read-only) — same gate as reading the thread itself;
// the handler additionally resolves the thread under the caller's RLS.
app.use("/api/agent/stream-state/*", authMw, orgLimiter, requireScope("kernel:threads:read"))
// The client's half of the two-phase mailbox read protocol (blueprint Task 9.3).
// Authenticated like the chat turn it answers: the responder is the mailbox owner
// answering a request their own turn made. The handler additionally requires the
// pending request to belong to THIS user and to carry the turn's own nonce, so
// the auth gate is the outer of two checks, not the only one.
app.use("/api/agent/mailbox-plaintext/*", authMw, orgLimiter, requireScope("kernel:threads:write"))
app.use("/api/agent/mailbox-search/*", authMw, orgLimiter, requireScope("kernel:threads:write"))
app.route("/api/agent", agentRoutes)

// Credit balance (authenticated — no scope gate, all users can check balance)
app.use("/api/credits", authMw, orgLimiter)
app.use("/api/credits/*", authMw, orgLimiter)
app.route("/api/credits", creditRoutes)

// Billing state (authenticated; the edition is read per request)
app.use("/api/billing/state", authMw, orgLimiter)
app.use("/api/billing/state/*", authMw, orgLimiter)
app.route("/api/billing/state", billingStateRoutes)

// The managed Billing page (S17): 404 in any other edition (read per request),
// then org admins only; every route forwards signed to the control plane.
app.use("/api/billing/managed/*", managedBillingOnly)
app.use("/api/billing/managed/*", authMw, orgLimiter)
app.use("/api/billing/managed/*", requireScope("kernel:org:admin"))
app.route("/api/billing/managed", billingManagedRoutes)

// The org's own email sender domain (S29): managed only, org admins only;
// every route forwards signed to the control plane.
app.use("/api/mail-sender/*", managedMailSenderOnly)
app.use("/api/mail-sender/*", authMw, orgLimiter)
app.use("/api/mail-sender/*", requireScope("kernel:org:admin"))
app.route("/api/mail-sender", mailSenderRoutes)

// Thread routes (authenticated, scope checked per-route in threads.ts)
app.use("/api/threads", authMw, orgLimiter)
app.use("/api/threads/*", authMw, orgLimiter)
app.route("/api/threads", threads)

// Approval decide route (authenticated; per-row authorization in service)
app.use("/api/approvals", authMw, orgLimiter)
app.use("/api/approvals/*", authMw, orgLimiter)
app.route("/api/approvals", approvals)

// Scope requests (authenticated; create is ungated, decide gated by
// kernel:scope_requests:admin in the route; per-row visibility via RLS)
app.use("/api/scope-requests", authMw, orgLimiter)
app.use("/api/scope-requests/*", authMw, orgLimiter)
app.route("/api/scope-requests", scopeRequests)
// Secret cards (request_secret): read, complete (server-derived), cancel.
app.use("/api/secret-requests/*", authMw, orgLimiter)
app.route("/api/secret-requests", secretRequestRoutes)

// Search (authenticated — results filtered by user's scopes internally, no blanket scope gate
// to preserve zero-knowledge denial: users with no matching scopes get empty results, not 403)
app.use("/api/search", authMw, orgLimiter)
app.use("/api/search/*", authMw, orgLimiter)
app.route("/api/search", search)

// Knowledge (authenticated — per-route services preserve zero-knowledge read denials)
app.use("/api/knowledge", authMw, orgLimiter)
app.use("/api/knowledge/*", authMw, orgLimiter)
app.use("/api/knowledge", kernelPrefixStateGate("knowledge"))
app.use("/api/knowledge/*", kernelPrefixStateGate("knowledge"))
app.route("/api/knowledge", knowledgeRoutes)

app.use("/api/mentions", authMw, orgLimiter, requireScope("kernel:threads:read"))
app.use("/api/mentions/*", authMw, orgLimiter, requireScope("kernel:threads:read"))
app.route("/api/mentions", mentions)

// Files (authenticated — per-route scope checks done in the service against parent writeScope)
app.use("/api/files", authMw, orgLimiter)
app.use("/api/files/*", authMw, orgLimiter)
app.route("/api/files", filesRoutes)
// Upload relay: token-authenticated (short-TTL signed file token in the path,
// same capability model as a presigned URL) — deliberately outside authMw so
// it mirrors the presigned-PUT flow it substitutes for.
app.route("/api/file-relay", fileUploadRelay)
// Download relay: the mirror of the upload relay. Token-authenticated (short-TTL
// signed download token in the path), outside authMw, so a capability URL works
// over the public app host even when the object store has no public endpoint.
app.route("/api/file-relay-dl", fileDownloadRelay)
// Org export download relay: the same capability model for a whole-org archive
// (modules/export/org-archive/routes.ts), used when the store is not browser
// reachable.
app.route("/api/org-export-dl", orgExportDownloadRelay)

// Import uploads (authenticated; owner-only multipart uploads of large export files)
app.use("/api/imports/uploads", authMw, orgLimiter)
app.use("/api/imports/uploads/*", authMw, orgLimiter)
app.route("/api/imports/uploads", importUploadRoutes)

// Public avatar serving. Deliberately OUTSIDE authMw: an <img> tag cannot send
// the Bearer header, so the unguessable avatar_key in the path is the capability
// (it rotates on every upload). Streams the stored webp with nosniff + a
// locked-down CSP + immutable caching.
app.route("/api/avatars", avatarPublicRoutes)

// /api/references is authorized PER-REFERENCE inside listBacklinks
// (resolveReadScopeForReference + hasScope): a thread reference requires
// kernel:threads:read, while an app-entity reference (e.g. a tickets/projects
// backlink) requires that app's own read scope. A blanket route-level
// requireScope("kernel:threads:read") wrongly blocks legitimate app-entity
// readers, so the gate stays at the data layer rather than the router.
app.use("/api/references", authMw, orgLimiter)
app.use("/api/references/*", authMw, orgLimiter)
app.route("/api/references", references)

// Settings AI keys (admin-scoped BYOK key management)
app.use("/api/settings/ai/keys", authMw, orgLimiter)
app.use("/api/settings/ai/keys/*", authMw, orgLimiter)
app.use("/api/settings/ai/keys", requireScope("kernel:org:admin"))
app.use("/api/settings/ai/keys/*", requireScope("kernel:org:admin"))
app.use("/api/settings/ai/keys", refuseByokInManaged)
app.use("/api/settings/ai/keys/*", refuseByokInManaged)
app.route("/api/settings/ai/keys", aiKeysRoutes)

// Settings AI models (admin-scoped: enablement, Auto, OpenRouter, own servers,
// the dictation transcription model)
for (const path of [
  "/api/settings/ai/models",
  "/api/settings/ai/models/*",
  "/api/settings/ai/openrouter/*",
  "/api/settings/ai/servers",
  "/api/settings/ai/servers/*",
  "/api/settings/ai/transcription",
  "/api/settings/ai/history",
]) {
  app.use(path, authMw, orgLimiter)
  app.use(path, requireScope("kernel:org:admin"))
}
app.use("/api/settings/ai/servers", refuseByokInManaged)
app.use("/api/settings/ai/servers/*", refuseByokInManaged)
app.route("/api/settings/ai", aiModelsRoutes)

// Settings Integrations (admin-scoped shared integration config)
app.use("/api/settings/integrations", authMw, orgLimiter)
app.use("/api/settings/integrations/*", authMw, orgLimiter)
app.route("/api/settings/integrations", integrationsRoutes)

// Webhooks (public — verification handled by each endpoint, rate-limited to prevent DoS)
// The global gate here is intentionally generous (10 MB); the route handler
// applies the per-endpoint `bodyLimitBytes` via `readRequestTextWithLimit` before
// any handler logic runs. A tight global cap here would prevent per-endpoint
// overrides above 1 MB from ever being reachable.
app.use("/webhooks/*", async (c, next) => {
  if (isTicketsPublicCreatePath(c.req.path) || isTicketsPublicCsatPath(c.req.path)) return next()
  // The staged-attachment upload states its own cap (one file plus framing).
  if (isTicketsPublicAttachmentPath(c.req.path)) {
    return bodyLimit({ maxSize: ATTACHMENT_REQUEST_MAX_BYTES })(c, next)
  }
  return bodyLimit({ maxSize: 10 * 1024 * 1024 })(c, next)
})
if (env.NODE_ENV !== "test") {
  app.use("/webhooks/*", async (c, next) => {
    if (isTicketsPublicCreatePath(c.req.path) || isTicketsPublicCsatPath(c.req.path)) return next()
    return rateLimiter(redis)(c, next)
  })
}
// An inbound webhook may be the first touch of an org this process never
// registered: set it up before the route looks up the org's handlers (S3).
app.use("/webhooks/:orgId/*", async (c, next) => {
  const orgId = c.req.param("orgId")
  // An org moving to another instance (modules/org/transfer-state/): a write
  // is counted first (a freeze landing meanwhile sees it), then gated: 503
  // `org_moving` while frozen, incoming or moved. One gate in front of both
  // routers (the public ticket routes included); draining orgs still take it.
  const end =
    UUID_RE.test(orgId) && isMutatingMethod(c.req.method) ? beginOrgActivity(orgId, "writes") : null
  try {
    if (UUID_RE.test(orgId)) await assertOrgAcceptsWrites(orgId)
    await setUpOrgForInboundWebhook(orgId)
    return await next()
  } finally {
    end?.()
  }
})
// Tickets public ticket-create endpoint must mount before the generic webhook route
// because it uses synchronous API-style envelopes that the manifest runtime does not provide.
app.route("/webhooks", ticketsPublicRoutes)
app.route("/webhooks", webhookRoutes)

// Test/QA-seed install harness routes. They live in apps/api/test-support, which
// the production image does not carry (spawnSync + BYPASSRLS seeding logic never
// enters the production module graph). Mounted under NODE_ENV=test (Playwright)
// OR when ENABLE_QA_SEED_ROUTES is set (the qa/ browser harness against
// `bun run dev`); the env validator refuses to boot with the flag on in
// production, and a build without the module refuses to boot with the flag on.
if (qaSeedRoutesEnabled) {
  const { mountQaSeedRoutes } = await importOptionalModule<{
    mountQaSeedRoutes: (target: typeof app) => Promise<void>
  }>({
    feature: "QA seed routes (NODE_ENV=test or ENABLE_QA_SEED_ROUTES)",
    modulePath: QA_SEED_ROUTES_MODULE,
    log: (message) => rootLogger.error(message),
  })
  await mountQaSeedRoutes(app)
}

// MCP server (Phase 12) — discovery metadata + OAuth at the instance ROOT
// (Claude clients fetch /.well-known/* at the origin, not under /api).
// Everything below this point and outside /api misses the /api/* body cap and IP
// limiter, so the public MCP OAuth / device-grant / discovery routes and the MCP
// transport get their own cap and per-IP budgets, applied before any parsing.
app.use("/.well-known/*", publicSurfaceBodyLimit(), publicSurfaceRateLimit(redis))
app.use("/mcp/oauth/*", publicSurfaceBodyLimit(), publicSurfaceRateLimit(redis))
app.use("/mcp/device/*", publicSurfaceBodyLimit(), publicSurfaceRateLimit(redis))
app.use("/mcp", publicSurfaceBodyLimit())
app.route("/.well-known", mcpOAuthWellKnown)
// OAuth: register + token are public (DCR / PKCE token exchange). GET
// /authorize is the PUBLIC consent screen (renders HTML, issues no code).
// Code issuance happens only at POST /authorize/consent, which is behind
// authMiddleware and requires an explicit consent=approve from the
// authenticated owner (spec C1 — no silent grant).
app.use("/mcp/oauth/authorize/consent", authPlusLimit)
app.route("/mcp/oauth", mcpOAuth)
// Device grant: initiate + poll public (approval reuses /api/auth/device-flow).
app.route("/mcp/device", mcpDeviceGrant)
// The desktop app's agent connection, from the session the app is signed in
// with: authenticated, so no device code and no browser round trip.
app.use("/mcp/desktop/*", authPlusLimit)
app.route("/mcp/desktop", mcpDesktopConnection)
// Streamable-HTTP transport: MCP-token auth + per-org rate limit.
app.use("/mcp", mcpAuthMiddleware)
// mcpAuthMiddleware resolves the connection's acting user, so a runaway MCP
// client is contained by the same per-user bucket as its owner's web session.
app.use("/mcp", perUserLimiter)
app.use("/mcp", orgRateLimiter(redis))
app.route("/mcp", mcpTransport)
// Owner-scoped Settings REST (web-session auth).
app.use("/api/mcp", authMw, orgLimiter)
app.use("/api/mcp/*", authMw, orgLimiter)
app.route("/api/mcp", mcpSettings)

if (process.env.CHAOS_DEBUG === "1") {
  if (process.env.NODE_ENV === "production" || process.env.CHAOS_LOCAL_ONLY !== "1") {
    throw new Error("CHAOS_DEBUG requires explicit local chaos mode")
  }
  if (!process.env.CHAOS_DEBUG_TOKEN) {
    throw new Error("CHAOS_DEBUG requires CHAOS_DEBUG_TOKEN")
  }
  // Resolved at run time: a build without the injector still compiles, and
  // CHAOS_DEBUG=1 on such a build refuses to boot rather than half-enabling.
  const { chaosInjectorRoutes } = await importOptionalModule<{ chaosInjectorRoutes: Hono }>({
    feature: "CHAOS_DEBUG",
    modulePath: chaosInjectorModulePath(),
    log: (message) => rootLogger.error(message),
  })
  app.use("/__chaos/*", async (c, next) => {
    if (c.req.header("x-chaos-token") !== process.env.CHAOS_DEBUG_TOKEN) {
      return c.json({ error: { message: "forbidden" } }, 403)
    }
    return next()
  })
  app.route("/", chaosInjectorRoutes)
}

// 404 fallback
app.notFound((c) => {
  return c.json({ error: { message: "Not found", code: "NOT_FOUND" } }, 404)
})
