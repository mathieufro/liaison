// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash, timingSafeEqual } from "node:crypto"
import { APP_DISABLED_CODE, ORG_SUSPENDED_CODE } from "@liaison/shared"
import { and, asc, eq } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import type { ActorContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { apps, users } from "~/db/schema/kernel"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { withPinnedJobSlot } from "~/infra/jobs/pinned-jobs-gate"
import { isManagedEdition } from "~/lib/edition"
import { env } from "~/lib/env"
import { webhooksLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { RequestBodyTooLargeError, readRequestTextWithLimit } from "~/lib/request-body"
import { getClientIp } from "~/lib/request-context"
import { success } from "~/lib/response"
import { UUID_RE } from "~/lib/uuid"
import { appVisibleToOrg } from "~/modules/apps/app-org-scope"
import {
  isManifestHandler,
  type ManifestHandlerRef,
  webhookHandlers,
} from "~/modules/apps/app-registries"
import {
  type ConnectionSecretKeySource,
  decryptConnectionConfigValue,
} from "~/modules/apps/connections/service"
import { createAppContext } from "~/modules/apps/context"
import { getInstallTrust } from "~/modules/apps/install-trust"
import { APP_STATE_UNAVAILABLE_CODE, pathOrgAppState } from "~/modules/apps/org-apps"
import { isBundleLoadError, isSandboxFault, loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { createSandboxRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { appRunsOnWorkers } from "~/modules/apps/sandbox/run-app"
import { writeAuditLog } from "~/modules/audit/service"
import { orgSuspendedOrClosed } from "~/modules/cloud/billing-status"
import {
  createCellWebhookRoutes,
  gmailOrgsForAddress,
  metaOrgsForPageIds,
} from "~/modules/cloud/cell-webhooks"
import { ORG_DELETED_CODE } from "~/modules/org/purge/deleting"
import { assertOrgAcceptsWrites } from "~/modules/org/transfer-state/gate"
import { assertCustomAppWebhookRate } from "~/modules/webhooks/custom-app-webhook-limit"
import { recordWebhookAccepted, recordWebhookRejected } from "~/modules/webhooks/ingest-health"
import { deliveryBudget, executeManifestWebhook } from "~/modules/webhooks/manifest-execution"
import { setUpOrgForInboundWebhook } from "~/modules/webhooks/org-setup"
import {
  normalizeReplayTtlSeconds,
  parseWebhookVerificationResult,
  resolveHandlerScopes,
} from "~/modules/webhooks/verification"
import { createWebhookVerifyBridge } from "~/modules/webhooks/verify-bridge"

export const webhookRoutes = new Hono<AppEnv>()

// Webhook flow: receive POST -> check body size -> verify signature -> invoke handler
// If verification fails -> 401 (a forged/missing signature is failed
// authentication; the b13 webhook-signature security contract asserts 401).
// If the handler reports a transient failure -> propagate its
// status (e.g. 5xx) so the provider retries, and release the replay key so the
// retry re-reaches the handler.

const MAX_WEBHOOK_BODY_SIZE = 1024 * 1024 // 1MB default (spec section 13)

/**
 * U4.12 (CI→projects webhook): a webhook whose manifest entry sets
 * `requiresUserActor: true` needs its RLS session's `app.current_user_id` to
 * be a REAL user — some kernel-owned, user-scoped tables (e.g.
 * `kernel.thread_participants`, which `projects`' `createTask` writes to via
 * `kernel.threads`) have a `WITH CHECK (user_id =
 * current_setting('app.current_user_id')::uuid OR ...)` RLS policy that a
 * `SystemContext` actor (no user id, by design — a webhook's HMAC trust
 * boundary is not a specific human) can never satisfy. Resolve the org's
 * oldest ACTIVE user as the acting identity — the same "admin fallback until
 * personas are active" convention the ops provisioners already
 * use for RJ/DSP2/compliance tasks. Every OTHER webhook (monitoring/tickets/
 * shopify/boxtal/invoicing) never sets the flag and is unaffected.
 */
async function resolveWebhookUserActorId(orgId: string): Promise<string | null> {
  const [row] = await withPrivilegedDb(orgId, "webhook-user-actor-fallback", (db) =>
    db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.status, "active")))
      .orderBy(asc(users.createdAt))
      .limit(1),
  )
  return row?.id ?? null
}

/** Third-party deliveries dropped because their app is Off for the org (S19, D24). */
let webhooksDroppedAppDisabled = 0
export function webhooksDroppedAppDisabledCount(): number {
  return webhooksDroppedAppDisabled
}

/**
 * A delivery to an app turned Off for the org (S19, D24) is acknowledged with
 * 200 and dropped, BEFORE the registration lookup: a provider that sees a
 * 404/410 counts a failure and may drop the subscription, which re-enabling
 * could not restore. Logged and counted; not replayed on re-enable. Returns the
 * response to send, or null when the app is On. Fail-closed: an unreadable
 * state answers 503 so the provider retries later.
 */
async function dropIfAppOff(
  c: Context<AppEnv>,
  orgId: string,
  appName: string,
  endpointName: string,
): Promise<Response | null> {
  let state: Awaited<ReturnType<typeof pathOrgAppState>>
  try {
    state = await pathOrgAppState(orgId, appName)
  } catch (err) {
    log.error({ err, orgId, app: appName, endpointName }, "webhook: app state unreadable; 503")
    return c.json(
      { error: { message: "Temporarily unavailable", code: APP_STATE_UNAVAILABLE_CODE } },
      503,
    )
  }
  if (state === "on") return null
  // An org being deleted: acknowledged and dropped as well, so the provider
  // stops retrying instead of writing into the purge (S2.5).
  if (state === "deleting") {
    log.info({ orgId, app: appName, endpointName }, "webhook dropped: the org is being deleted")
    return c.json({ ok: true, dropped: ORG_DELETED_CODE }, 200)
  }
  webhooksDroppedAppDisabled++
  log.info({ orgId, app: appName, endpointName }, "webhook dropped: the app is Off for the org")
  return c.json({ ok: true, dropped: APP_DISABLED_CODE }, 200)
}

/** Deliveries dropped per org because the org was suspended or closed for billing. */
const webhooksDroppedOrgSuspended = new Map<string, number>()
export function webhooksDroppedOrgSuspendedCount(orgId: string): number {
  return webhooksDroppedOrgSuspended.get(orgId) ?? 0
}

/**
 * A delivery to a managed org suspended or closed for billing: 200 and
 * dropped, logged and counted per org, so the provider keeps the subscription
 * and the org's integrations work again once it pays. Not replayed on resume.
 * 410 stays for an org being deleted (above). A no-op, without a query, on a
 * self-hosted instance.
 */
async function dropIfOrgSuspended(
  c: Context<AppEnv>,
  orgId: string,
  appName: string,
  endpointName: string,
): Promise<Response | null> {
  if (!(await orgSuspendedOrClosed(orgId))) return null
  if (webhooksDroppedOrgSuspended.size > 10_000) webhooksDroppedOrgSuspended.clear()
  webhooksDroppedOrgSuspended.set(orgId, webhooksDroppedOrgSuspendedCount(orgId) + 1)
  log.info({ orgId, app: appName, endpointName }, "webhook dropped: the org is suspended")
  return c.json({ ok: true, dropped: ORG_SUSPENDED_CODE }, 200)
}

// The server-level callbacks of the managed edition (one Gmail push subscription,
// one Meta app callback per server), fanned out to the orgs they concern
// (cloud/cell-webhooks.ts). Self-hosted: 404.
webhookRoutes.route(
  "/_cell",
  createCellWebhookRoutes({
    managed: isManagedEdition,
    gmailPush: () => ({
      audience: env.GMAIL_PUSH_AUDIENCE,
      serviceAccount: env.GMAIL_PUSH_SERVICE_ACCOUNT,
    }),
    metaAppSecret: () => env.META_APP_SECRET,
    verifyOidc: async (token, expectedAudience, expectedServiceAccount) => {
      const { verifyGoogleOidcJwt } = await import("~/modules/webhooks/google-oidc")
      return verifyGoogleOidcJwt(token, {
        expectedAudience,
        expectedServiceAccount,
        issuer: process.env.TICKETS_GMAIL_PUSH_ISSUER,
        jwksUrl: process.env.TICKETS_GMAIL_PUSH_JWKS_URL,
      })
    },
    gmailOrgsFor: gmailOrgsForAddress,
    metaOrgsForPages: metaOrgsForPageIds,
    suspended: orgSuspendedOrClosed,
    // The org's own endpoint, the whole path: its verifier checks the token again.
    forward: async (orgId, appName, endpointName, req) => {
      await setUpOrgForInboundWebhook(orgId)
      return webhookRoutes.request(`/${orgId}/${appName}/${endpointName}`, {
        method: "POST",
        headers: req.headers,
        body: req.body,
      })
    },
    dispatchVerified: (c, orgId, appName, endpointName, req) =>
      dispatchKernelVerified(c as Context<AppEnv>, orgId, appName, endpointName, req),
  }),
)

/**
 * A delivery the kernel verified itself (the server's Meta callback): the org's
 * app-off, suspension and deletion drops, then the same dispatch as an
 * app-verified delivery. Never throws: an HTTP error becomes its response, so one
 * org's failure does not stop the others'.
 */
async function dispatchKernelVerified(
  c: Context<AppEnv>,
  orgId: string,
  appName: string,
  endpointName: string,
  req: { rawBody: string; replayKey: string },
): Promise<Response> {
  try {
    await assertOrgAcceptsWrites(orgId)
    await setUpOrgForInboundWebhook(orgId)
    const dropped = await dropIfAppOff(c, orgId, appName, endpointName)
    if (dropped) return dropped
    const suspended = await dropIfOrgSuspended(c, orgId, appName, endpointName)
    if (suspended) return suspended
    const registration = webhookHandlers.get([orgId, appName, endpointName])
    if (!registration) return c.json({ error: { message: "Unknown webhook endpoint" } }, 404)
    return await dispatchVerifiedWebhook(c, {
      webhookOrgId: orgId,
      appName,
      endpointName,
      registration,
      rawBody: req.rawBody,
      outcome: { replayKey: req.replayKey },
    })
  } catch (err) {
    if (err instanceof HTTPException) return err.getResponse()
    log.error({ err, orgId, appName, endpointName }, "kernel-verified webhook dispatch failed")
    return c.json({ error: { message: "Webhook handler error" } }, 500)
  }
}

// An org moving to another instance (modules/org/transfer-state/): every
// delivery to it answers 503 `org_moving` with `Retry-After` while it is
// frozen, incoming or moved, so the provider retries (the router forwards
// the retry to wherever the org is served). Draining orgs still take them.
webhookRoutes.use("/:orgId/:appName/:endpointName", async (c, next) => {
  const orgId = c.req.param("orgId")
  if (UUID_RE.test(orgId)) await assertOrgAcceptsWrites(orgId)
  await next()
})

webhookRoutes.post("/:orgId/:appName/:endpointName", async (c) => {
  const webhookOrgId = c.req.param("orgId")
  const appName = c.req.param("appName")
  const endpointName = c.req.param("endpointName")
  const handlerKey: [string, string, string] = [webhookOrgId, appName, endpointName]

  // Another org's custom app has no endpoint under this org (app-org-scope.ts).
  if (!(await appVisibleToOrg(appName, webhookOrgId))) {
    throw new HTTPException(404, { message: "Unknown webhook endpoint" })
  }
  // An org's custom app: a per-minute budget before any sandbox work.
  await assertCustomAppWebhookRate(webhookOrgId, appName)
  const dropped = await dropIfAppOff(c, webhookOrgId, appName, endpointName)
  if (dropped) return dropped
  const suspended = await dropIfOrgSuspended(c, webhookOrgId, appName, endpointName)
  if (suspended) return suspended

  const registration = webhookHandlers.get(handlerKey)
  if (!registration) {
    throw new HTTPException(404, { message: "Unknown webhook endpoint" })
  }

  // Body size check (spec: configurable max body size, default 1MB; per-endpoint override allowed)
  const bodyLimit = registration.bodyLimitBytes ?? MAX_WEBHOOK_BODY_SIZE
  const contentLength = Number(c.req.header("content-length") ?? 0)
  if (contentLength > bodyLimit) {
    throw new HTTPException(413, { message: "Payload too large" })
  }

  // Signature verification -- called before handler
  let rawBody: string
  try {
    rawBody = await readRequestTextWithLimit(c.req.raw, bodyLimit)
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      throw new HTTPException(413, { message: "Payload too large" })
    }
    throw err
  }
  const request = new Request(c.req.url, {
    method: "POST",
    headers: c.req.raw.headers,
    body: rawBody,
  })
  const appOrgId = registration.orgId
  const [appRecord] = await withPrivilegedDb(appOrgId, "webhook-app-lookup", (db) =>
    db
      .select()
      .from(apps)
      .where(and(eq(apps.name, appName), eq(apps.orgId, appOrgId)))
      .limit(1),
  )
  if (!appRecord) {
    throw new HTTPException(404, { message: "App not found" })
  }

  let verificationResult: unknown
  try {
    if (isManifestHandler(registration.verify)) {
      // Manifest path: execute verify function in sandbox with serialized request data
      const handlerRef = registration.verify as ManifestHandlerRef
      const requestData = {
        headers: Object.fromEntries(c.req.raw.headers.entries()),
        body: rawBody,
        method: "POST",
        query: Object.fromEntries(new URL(c.req.url).searchParams.entries()),
      }
      const source = await loadBundle(handlerRef.bundlePath)
      // A verifier on Workers gets a bridge that hands back no secret.
      const workersRun = await appRunsOnWorkers({
        trusted: handlerRef.trusted === true,
        appName,
        orgId: appOrgId,
        bundlePath: handlerRef.bundlePath,
      })
      verificationResult = await executeManifestWebhook({
        appName,
        orgId: appOrgId,
        // The verify bridge is inline (config_get only): no transaction.
        holdsTx: false,
        handlerRef,
        bundleSource: source,
        params: requestData,
        entryKind: "webhook-verify",
        bridge: createWebhookVerifyBridge({
          appOrgId,
          appName,
          appConfig: appRecord.config,
          manifestConnections: registration._manifest?.connections as
            | Record<string, ConnectionSecretKeySource>
            | undefined,
          ...(workersRun ? { workersRun: true } : {}),
        }),
      })
    } else {
      verificationResult = await (registration.verify as (request: Request) => Promise<unknown>)(
        request,
      )
    }
  } catch (err) {
    if (isBundleLoadError(err)) {
      // The app's own code could not load: a server fault, not a bad signature.
      // Answering 401 here hid the cause behind "signature verification failed".
      const error = err instanceof Error ? err : new Error(String(err))
      log.error(
        {
          err: error,
          appName,
          appVersion: appRecord.version,
          endpointName,
          errorMessage: error.message,
          errorStack: error.stack,
        },
        "Webhook verifier bundle failed to load",
      )
      throw new HTTPException(503, { message: "Webhook handler unavailable" })
    }
    if (isSandboxFault(err)) {
      // The verifier never answered: a server fault the provider should retry, not a bad signature.
      log.warn({ err, appName, endpointName }, "Webhook verifier lost its sandbox")
      throw new HTTPException(503, { message: "Webhook handler unavailable" })
    }
    log.warn({ err, appName, endpointName }, "Webhook verification execution failed")
    verificationResult = false
  }

  const payloadHash = createHash("sha256").update(rawBody).digest("hex")
  const sourceIp = getClientIp(c)
  const outcome = parseWebhookVerificationResult(verificationResult)

  if (!outcome) {
    // Surface the verifier's own failure reason (e.g. missing_secret /
    // missing_signature / signature_mismatch) — without it a prod 401 is
    // undiagnosable from logs alone.
    const failureReason =
      verificationResult && typeof verificationResult === "object"
        ? (verificationResult as { reason?: string }).reason
        : undefined
    // A verifier may also report the REJECTED signature's shape (length +
    // charset class, never its value). Without it, a provider that signs in an
    // encoding we don't accept is indistinguishable from a wrong secret, and
    // telling them apart needs a packet capture — which is exactly what the
    // 2026-08-03 Boxtal diagnosis cost. See bundled-apps/boxtal/src/lib/hmac.ts.
    const sigShape =
      verificationResult && typeof verificationResult === "object"
        ? (verificationResult as { sigShape?: string }).sigShape
        : undefined
    log.warn(
      { appName, endpointName, sourceIp, payloadHash, reason: failureReason, sigShape },
      "Webhook signature verification failed",
    )
    // Count it: a warn line is invisible to the alerting path, and this rejection
    // happens BEFORE any app handler or app-side ledger row, so nothing else in
    // the system records that a delivery was even attempted. Boxtal's tracking
    // stream died this exact way and stayed dead for a month. See ingest-health.
    recordWebhookRejected(appName, failureReason ?? null)
    throw new HTTPException(401, { message: "Invalid signature" })
  }

  if (outcome.kind === "drop") {
    return new Response("", { status: outcome.status })
  }
  if (outcome.kind === "reject") {
    const headers: Record<string, string> = {}
    if (outcome.retryAfterSeconds !== undefined) {
      headers["retry-after"] = String(outcome.retryAfterSeconds)
    }
    if (process.env.CHAOS_DEBUG === "1") {
      const chaosReason =
        verificationResult && typeof verificationResult === "object"
          ? (verificationResult as { _chaosReason?: string })._chaosReason
          : undefined
      log.warn(
        { appName, endpointName, status: outcome.status, chaosReason },
        "Webhook rejected by verifier",
      )
    }
    return new Response(JSON.stringify({ error: { message: "Webhook rejected" } }), {
      status: outcome.status,
      headers: { "content-type": "application/json", ...headers },
    })
  }

  return dispatchVerifiedWebhook(c, {
    webhookOrgId,
    appName,
    endpointName,
    registration,
    rawBody,
    outcome,
  })
})

type WebhookRegistration = NonNullable<ReturnType<typeof webhookHandlers.get>>

/**
 * Everything after a delivery's verification: replay claim, handler scopes, the
 * acting identity, the handler run in the background pool, status mapping and
 * retries, the audit row. Shared by the per-org endpoint (the app's verifier
 * accepted) and the server-level callbacks (cloud/cell-webhooks.ts: the kernel
 * verified the provider's signature once for the whole server).
 */
async function dispatchVerifiedWebhook(
  c: Context<AppEnv>,
  args: {
    webhookOrgId: string
    appName: string
    endpointName: string
    registration: WebhookRegistration
    rawBody: string
    outcome: { replayKey: string; replayTtlSeconds?: number; scopes?: string[] }
  },
): Promise<Response> {
  const { webhookOrgId, appName, endpointName, registration, rawBody, outcome } = args
  const appOrgId = registration.orgId
  const payloadHash = createHash("sha256").update(rawBody).digest("hex")
  // Signature verified: the sender is reaching us and being heard. Recorded here
  // rather than after handler dispatch on purpose — this counter measures the
  // VERIFICATION GATE (the thing that silently closed on Boxtal), not handler
  // success, and a duplicate redelivery is still proof the stream is alive.
  recordWebhookAccepted(appName)

  // Parse JSON before claiming the replay key so a malformed body does not
  // consume the delivery's dedup slot — a later valid redelivery would otherwise
  // be rejected as a duplicate even though the first attempt never ran the handler.
  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" })
  }

  // Replay protection — verifier supplies a delivery/event identity after signature validation.
  const replayHash = createHash("sha256").update(outcome.replayKey).digest("hex")
  const dedupeKey = `webhook:replay:${webhookOrgId}:${appName}:${endpointName}:${replayHash}`
  const isNew = await redis.set(
    dedupeKey,
    "1",
    "EX",
    normalizeReplayTtlSeconds(outcome.replayTtlSeconds),
    "NX",
  )
  if (!isNew) {
    log.warn({ replayHash, app: appName, endpoint: endpointName }, "Duplicate webhook rejected")
    return success(c, { received: true, duplicate: true })
  }

  // The verifier MAY declare per-handler scopes via `outcome.scopes` (rare).
  // Default: grant the handler the full app namespace — webhook delivery is
  // a system-level trust point (HMAC + replay-dedup just validated above),
  // and the bundle's handler is the canonical writer for its own app's
  // entity tables (e.g. `app_shopify.webhook_deliveries`). Without this
  // default, the bundle hits RLS denial on its very first `ctx.db.insert`
  // because `app.current_scopes` would be empty.
  //
  // The verifier is the app's own code, so its scopes are only a request: for an
  // installed third-party app they are intersected with what the admin granted.
  const trust = await getInstallTrust(appName)
  const handlerScopes = resolveHandlerScopes(appName, outcome.scopes ?? [], {
    thirdParty: trust.installed && !trust.firstParty,
    grantedScopes: trust.grantedScopes,
  })
  if (
    outcome.scopes &&
    outcome.scopes.length > 0 &&
    handlerScopes.length !== outcome.scopes.length
  ) {
    log.warn(
      { appName, endpointName, requested: outcome.scopes, granted: handlerScopes },
      "Webhook verifier requested scopes beyond the app's grant; narrowed",
    )
  }
  // requiresUserActor opt-in (see resolveWebhookUserActorId doc comment) —
  // every existing webhook leaves this unset and keeps the SystemContext path.
  const webhookUserActorId = registration.requiresUserActor
    ? await resolveWebhookUserActorId(appOrgId)
    : null
  if (registration.requiresUserActor && !webhookUserActorId) {
    log.error(
      { appName, endpointName, orgId: appOrgId },
      "requiresUserActor webhook has no active org user to act as — refusing",
    )
    throw new HTTPException(503, { message: "No active user available to process this webhook" })
  }
  const webhookActor: ActorContext = webhookUserActorId
    ? {
        actorType: "user",
        userId: webhookUserActorId,
        orgId: appOrgId,
        scopes: handlerScopes,
        dimensionGrants: { "*": ["*"] },
      }
    : {
        actorType: "system",
        orgId: appOrgId,
        purpose: "webhook",
        scopes: handlerScopes,
      }

  // Lowercased inbound header dict — passed as the 3rd handler arg (the manifest
  // webhook signature is `(payload, ctx, headers)`; bundle code reads e.g.
  // `x-shopify-webhook-id` for dedup) and persisted in the retry job payload so
  // the kernel retry path can re-supply the same headers. Headers are lowercased
  // + JSON-cloned so the sandbox sees a plain dict.
  const headerDict: Record<string, string> = {}
  for (const [k, v] of c.req.raw.headers.entries()) {
    headerDict[k.toLowerCase()] = v
  }

  // Release the replay claim so a provider retry (or the kernel retry job)
  // re-reaches the handler. Called when the delivery did NOT durably succeed.
  const releaseReplayClaim = async () => {
    try {
      await redis.del(dedupeKey)
    } catch (delErr) {
      log.error({ delErr, appName, endpointName }, "Failed to release webhook replay claim")
    }
  }

  let handlerResult: unknown
  try {
    // Primary inbound webhook delivery runs the app's manifest handler inside
    // this RLS transaction, which for Shopify (etc.) makes an external HTTP
    // round-trip via ctx.fetch() while the connection sits "idle in
    // transaction" for the whole executeInSandbox run. Draw from the dedicated
    // background pool -- NOT the interactive request pool -- so a burst of
    // inbound webhooks (e.g. a provider replay after an endpoint repoint, as at
    // the 2026-07-08 cutover) can never starve MCP/HTTP/agent traffic into
    // DbAcquireTimeoutError. Webhook retries (webhook-worker.ts) and
    // event-subscription handlers already draw from "jobs"; the primary
    // delivery was the one long-held-across-HTTP path still on the request pool.
    //
    // A handler that declares a budget may hold that connection for up to
    // 29 s, against 5 s for the rest: it waits for a pinned slot first, as the
    // retry job does (infra/jobs/pinned-jobs-gate.ts), so a burst of them cannot
    // starve the jobs pool. The wait is bounded so the run still ends inside the
    // request ceiling; past it the delivery goes to the retry job below, unrun.
    const budget = deliveryBudget(registration.timeoutMs, env.REQUEST_TIMEOUT_MS)
    const runDelivery = () =>
      withRlsContext(
        webhookActor,
        async (tx) => {
          if (isManifestHandler(registration.handler)) {
            const handlerRef = registration.handler as ManifestHandlerRef
            const manifest = registration._manifest ?? {
              name: appName,
              schema: {},
              events: {},
              connections: {},
              network: {},
            }
            const bridge = createSandboxRpcBridge(
              appName,
              webhookUserActorId ?? "system",
              appOrgId,
              tx,
              manifest,
              handlerScopes,
              webhookUserActorId ? "user" : "system",
              undefined,
              { actor: webhookActor },
            )
            const source = await loadBundle(handlerRef.bundlePath)
            // Pass the hoisted header dict as the 3rd handler arg.
            return executeManifestWebhook({
              appName,
              orgId: appOrgId,
              // Inside the delivery's withRlsContext transaction.
              holdsTx: true,
              handlerRef,
              bundleSource: source,
              params: payload,
              bridge,
              extraArgs: [headerDict],
              ...(budget ? { timeoutMs: budget.timeoutMs } : {}),
            })
          }
          const ctx = createAppContext(appName, "system", appOrgId, tx)
          return (registration.handler as (payload: unknown, ctx: any) => Promise<unknown>)(
            payload,
            ctx,
          )
        },
        { pool: "jobs" },
      )
    handlerResult = budget
      ? await withPinnedJobSlot(
          `webhook:${appName}`,
          runDelivery,
          AbortSignal.timeout(budget.slotWaitMs),
        )
      : await runDelivery()
  } catch (err) {
    // The handler threw (vs. returning a status). Treat as transient: release
    // the replay claim and schedule the kernel retry. Surface 500 so providers
    // that key retries on the HTTP status (Shopify) also re-deliver.
    log.error({ err, appName, endpointName }, "Webhook handler threw -- scheduling retry")
    await releaseReplayClaim()
    // Best-effort: a retry-queue hiccup must NOT override the HTTP status the
    // provider keys re-delivery on (the retriable 5xx below already triggers
    // re-delivery, which re-runs the handler). Never let it surface as a 500.
    try {
      await enqueueAppJob("kernel", "retry-webhook", {
        orgId: appOrgId,
        appName,
        endpointName,
        payload,
        headers: headerDict,
        // The retry's key in the effect ledger (webhook-worker.ts): a retry
        // re-run after a crash or a hand-back does not apply it twice.
        deliveryId: crypto.randomUUID(),
      })
    } catch (enqErr) {
      log.error({ enqErr, appName, endpointName }, "Failed to schedule webhook retry (best-effort)")
    }
    return c.json({ error: { message: "Webhook handler error" } }, 500)
  }

  // Manifest webhook handlers report success/failure via a returned
  // `{ status, body? }` (they do NOT throw on transient downstream failure —
  // e.g. an emit/DB error returns `{ status: 503 }`). The route MUST honor that
  // status: a 5xx (or 408/429, or any other non-2xx that is not a 4xx
  // rejection) is a transient failure where the side effect did not durably complete, so release the replay claim and propagate the status so
  // the provider retries. Handlers that return nothing (legacy `Promise<void>`)
  // are treated as success.
  const handlerStatus = extractHandlerStatus(handlerResult)
  // A 4xx is the handler REJECTING the delivery (malformed envelope, unknown
  // value, auth mismatch): nothing was written and re-sending the same payload
  // can only fail the same way. Answer that status with the handler's own
  // message and do NOT retry. 408/429 are the transient 4xx and keep the retry
  // path below. The replay claim is released so a corrected re-send is not
  // short-circuited as a duplicate.
  if (handlerStatus !== null && isPermanentRejection(handlerStatus)) {
    log.warn(
      { appName, endpointName, payloadHash, status: handlerStatus },
      "Webhook handler rejected the delivery -- not retrying",
    )
    await releaseReplayClaim()
    return new Response(
      JSON.stringify({ error: { message: extractRejectionMessage(handlerResult) } }),
      { status: handlerStatus, headers: { "content-type": "application/json" } },
    )
  }
  if (handlerStatus !== null && (handlerStatus < 200 || handlerStatus >= 300)) {
    log.warn(
      { appName, endpointName, payloadHash, status: handlerStatus },
      "Webhook handler reported non-2xx -- scheduling retry",
    )
    await releaseReplayClaim()
    // Best-effort retry scheduling — see note above; a queue failure must not
    // turn the intended retriable 5xx into a 500.
    try {
      await enqueueAppJob("kernel", "retry-webhook", {
        orgId: appOrgId,
        appName,
        endpointName,
        payload,
        headers: headerDict,
        // The retry's key in the effect ledger (webhook-worker.ts): a retry
        // re-run after a crash or a hand-back does not apply it twice.
        deliveryId: crypto.randomUUID(),
      })
    } catch (enqErr) {
      log.error({ enqErr, appName, endpointName }, "Failed to schedule webhook retry (best-effort)")
    }
    // Coerce to a retriable 5xx so the provider re-delivers (Shopify only
    // retries on 5xx/timeout). Preserve an explicit 5xx the handler chose.
    const responseStatus = handlerStatus >= 500 ? handlerStatus : 503
    return new Response(JSON.stringify({ error: { message: "Webhook processing failed" } }), {
      status: responseStatus,
      headers: { "content-type": "application/json" },
    })
  }

  log.info({ appName, endpointName, payloadHash }, "Webhook processed successfully")
  // Audit write is best-effort: a failure here must not roll back the already-
  // committed delivery or change the HTTP response the provider receives.
  try {
    await withRlsContext(
      webhookActor,
      (tx) =>
        writeAuditLog(tx, {
          orgId: appOrgId,
          actorType: "system",
          actorId: null,
          app: appName,
          entityType: "webhook",
          action: `webhook.${endpointName}`,
          metadata: { endpointName, payloadHash, replayHash },
        }),
      // Keep the trailing audit write on the background pool too, so the whole
      // inbound-webhook lifecycle stays off the interactive request pool.
      { pool: "jobs" },
    )
  } catch (auditErr) {
    log.error({ err: auditErr, appName, endpointName }, "Webhook audit log write failed")
  }

  // The handler's own JSON object body reaches the sender (e.g. what the
  // delivery did); a handler that returns no body, or a non-JSON one, keeps the
  // default acknowledgement.
  return success(c, extractHandlerJsonBody(handlerResult) ?? { received: true })
}

const MAX_REJECTION_MESSAGE_LENGTH = 500

function isPermanentRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

/** The handler's rejection text (its `body` string), bounded; a generic message when it gave none. */
function extractRejectionMessage(result: unknown): string {
  if (result && typeof result === "object" && "body" in result) {
    const body = (result as { body: unknown }).body
    if (typeof body === "string" && body.trim().length > 0) {
      return body.trim().slice(0, MAX_REJECTION_MESSAGE_LENGTH)
    }
  }
  return "Webhook rejected"
}

/**
 * The handler's 2xx body when it is a JSON object (a JSON-encoded string, the
 * manifest handler shape, or a plain object). Anything else yields `null`.
 */
function extractHandlerJsonBody(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object" || !("body" in result)) return null
  let body: unknown = (result as { body: unknown }).body
  if (typeof body === "string") {
    try {
      body = JSON.parse(body)
    } catch {
      return null
    }
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>
  }
  return null
}

/**
 * Extract a numeric HTTP-like status from a manifest webhook handler's return
 * value. Manifest handlers return `{ status: number, body?: string }`; legacy
 * void handlers return `undefined`. Returns `null` when no status is present
 * (treated as success by the caller).
 */
function extractHandlerStatus(result: unknown): number | null {
  if (result && typeof result === "object" && "status" in result) {
    const status = (result as { status: unknown }).status
    if (typeof status === "number" && Number.isFinite(status)) return status
  }
  return null
}

// Subscription handshake used by Meta (Facebook / Instagram) webhooks: before it
// delivers anything, Meta calls the callback URL with GET
// `?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<n>` and expects the
// challenge echoed back as plain text. Answered only for a registered endpoint
// whose app config carries `webhookVerifyToken` (a random string, the same value
// given to the provider: entered in its dashboard, or sent by the app's own setup
// tool, e.g. social's `webhooks_setup`) and only when the
// presented token matches it in constant time. Every other GET stays a 405.
webhookRoutes.get("/:orgId/:appName/:endpointName", async (c) => {
  const q = new URL(c.req.url).searchParams
  const mode = q.get("hub.mode")
  const challenge = q.get("hub.challenge")
  const presented = q.get("hub.verify_token")
  if (mode !== "subscribe" || challenge === null) {
    return c.json({ error: { message: "Method not allowed", code: "METHOD_NOT_ALLOWED" } }, 405)
  }
  if (!(await appVisibleToOrg(c.req.param("appName"), c.req.param("orgId")))) {
    throw new HTTPException(404, { message: "Unknown webhook endpoint" })
  }
  const droppedChallenge = await dropIfAppOff(
    c,
    c.req.param("orgId"),
    c.req.param("appName"),
    c.req.param("endpointName"),
  )
  if (droppedChallenge) return droppedChallenge
  const registration = webhookHandlers.get([
    c.req.param("orgId"),
    c.req.param("appName"),
    c.req.param("endpointName"),
  ])
  if (!registration) throw new HTTPException(404, { message: "Unknown webhook endpoint" })
  const [appRecord] = await withPrivilegedDb(registration.orgId, "webhook-challenge-app", (db) =>
    db
      .select()
      .from(apps)
      .where(and(eq(apps.name, c.req.param("appName")), eq(apps.orgId, registration.orgId)))
      .limit(1),
  )
  const rawConfig = appRecord?.config
  const config =
    typeof rawConfig === "string"
      ? (JSON.parse(rawConfig) as Record<string, unknown>)
      : (rawConfig as Record<string, unknown> | null | undefined)
  // An app may hold the token as an app-held secret (`connections.<c>.appSecretConfigKeys`,
  // written through `ctx.config.setSecret`, encrypted at rest); decrypt it the way the POST
  // verifier's `config_get` does. A plaintext token (not a declared secret) passes verbatim.
  const expected = decryptConnectionConfigValue(
    registration.orgId,
    c.req.param("appName"),
    "webhookVerifyToken",
    config?.webhookVerifyToken,
    undefined,
    registration._manifest?.connections as Record<string, ConnectionSecretKeySource> | undefined,
  )
  if (typeof expected !== "string" || expected.length === 0 || !presented) {
    return c.text("Forbidden", 403)
  }
  const left = Buffer.from(presented)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return c.text("Forbidden", 403)
  }
  // The challenge is reflected, so it must be a plain token (Meta sends an integer).
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(challenge)) return c.text("Bad request", 400)
  return c.text(challenge, 200, { "X-Content-Type-Options": "nosniff" })
})

// Method not allowed for non-POST
webhookRoutes.all("/:orgId/:appName/:endpointName", (c) => {
  return c.json({ error: { message: "Method not allowed", code: "METHOD_NOT_ALLOWED" } }, 405)
})
