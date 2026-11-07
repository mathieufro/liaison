// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Connection lifecycle. Subscribed via `events.subscribes` to the kernel
// `connected_account:create`/`disconnect` events.
//
// On connect: validate the v3 credentials with a token exchange, read the
// kernel-minted webhook secret is set (`ctx.config.has("boxtalWebhookSecret")` —
// Task K-WEBHOOK-SECRET), and register TWO v3 subscriptions (TRACKING_CHANGED,
// DOCUMENT_CREATED) each carrying that secret (written into the request by the
// host, `configSecrets`: the bundle never reads it) and a callback URL of the form
// `${kernelPublicBaseUrl}/webhooks/{orgId}/boxtal/{endpoint}` (no /api prefix).
// Persist the returned subscription ids + a `webhook_status` flag.
//
// Degrade cleanly (status active connection, `webhook_status:"degraded"`, no
// subscription POST) when the public base URL or webhook secret is absent.
//
// On disconnect: DELETE each persisted subscription and clear the rows + flag.

import { getClient } from "./lib/get-client"
import { BoxtalApiError } from "./lib/boxtal-v3-client"

const WEBHOOK_SECRET_KEY = "boxtalWebhookSecret"

/** Boxtal v3 eventType → kernel webhook endpoint slug (kebab). */
const SUBSCRIPTIONS: ReadonlyArray<{ eventType: "TRACKING_CHANGED" | "DOCUMENT_CREATED"; endpoint: string }> = [
  { eventType: "TRACKING_CHANGED", endpoint: "tracking-changed" },
  { eventType: "DOCUMENT_CREATED", endpoint: "document-created" },
]

interface ConnectionEventData {
  id: string
  appName: string
  orgId?: string
  connectionName: string
  identifier: string
  kernelPublicBaseUrl?: string
}

interface ConnectionEvent {
  app: "kernel"
  entity: "connected_account"
  action: "create" | "disconnect"
  orgId: string
  data: ConnectionEventData | { id: string; appName: string }
}

interface ConnectionCtx {
  orgId: string
  db: {
    findMany(entity: string, opts?: { where?: Record<string, unknown>; limit?: number }): Promise<unknown[]>
    insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
    update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
    delete(entity: string, id: string): Promise<void>
  }
  fetch: (
    url: string,
    opts?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{ status: number; headers: Record<string, string>; body: string }>
  connections: unknown
  config: { get(key: string): Promise<unknown>; has(key: string): Promise<boolean> }
  // Methods are OPTIONAL to match BoxtalToolCtx's `BoxtalLogger` (whose methods
  // are `... | undefined`), so the structural-superset ctx passed by the tool
  // handlers (e.g. webhooksRepairHandler) is assignable here. Every call site
  // already guards with optional chaining (`ctx.logger?.warn?.(...)`).
  logger?: { info?(m: string, d?: unknown): void; warn?(m: string, d?: unknown): void; error?(m: string, d?: unknown): void; debug?(m: string, d?: unknown): void }
}

/** Upsert the single-row `webhook_status` flag in app_config. */
async function setWebhookStatus(ctx: ConnectionCtx, status: "active" | "degraded"): Promise<void> {
  const rows = (await ctx.db.findMany("app_config", { where: { key: "webhook_status" }, limit: 1 })) as Array<{ id: string }>
  if (rows[0]) {
    await ctx.db.update("app_config", rows[0].id, { value: status })
  } else {
    await ctx.db.insert("app_config", { key: "webhook_status", value: status })
  }
}

async function clearWebhookStatus(ctx: ConnectionCtx): Promise<void> {
  const rows = (await ctx.db.findMany("app_config", { where: { key: "webhook_status" }, limit: 1 })) as Array<{ id: string }>
  if (rows[0]) await ctx.db.delete("app_config", rows[0].id)
}

/** Upsert a subscription row keyed by event_type. */
async function upsertSubscription(
  ctx: ConnectionCtx,
  row: { event_type: string; subscription_id: string; callback_url: string },
): Promise<void> {
  const existing = (await ctx.db.findMany("subscription", { where: { event_type: row.event_type }, limit: 1 })) as Array<{ id: string }>
  if (existing[0]) {
    await ctx.db.update("subscription", existing[0].id, {
      subscription_id: row.subscription_id,
      callback_url: row.callback_url,
    })
  } else {
    await ctx.db.insert("subscription", {
      event_type: row.event_type,
      subscription_id: row.subscription_id,
      callback_url: row.callback_url,
    })
  }
}

export async function onConnectionEstablished(event: ConnectionEvent, ctx: ConnectionCtx): Promise<void> {
  if (event.data?.appName !== "boxtal") return
  const data = event.data as ConnectionEventData

  // 1. Validate credentials with a v3 token exchange.
  const client = await getClient(ctx)
  try {
    // a single read forces the token exchange; any biz endpoint works.
    await client.v3.listContentCategories()
  } catch (err) {
    if (err instanceof BoxtalApiError && err.status === 401) {
      throw new Error(`Boxtal credentials invalid for ${client.environment}`)
    }
    // A non-auth error (e.g. transient 5xx on the validation read) shouldn't
    // block the connection — fall through and let webhook setup decide.
  }

  // 2. The kernel-minted webhook secret must be set; degrade if absent.
  const baseUrl = data.kernelPublicBaseUrl
  const hasSecret = await ctx.config.has(WEBHOOK_SECRET_KEY)
  if (!baseUrl || !hasSecret) {
    ctx.logger?.warn?.("boxtal: webhook prerequisites unavailable; degrading", {
      hasBaseUrl: Boolean(baseUrl),
      hasSecret,
    })
    await setWebhookStatus(ctx, "degraded")
    return
  }

  // 3. Register the two v3 subscriptions.
  const orgId = data.orgId ?? event.orgId ?? ctx.orgId
  let allOk = true
  for (const { eventType, endpoint } of SUBSCRIPTIONS) {
    const callbackUrl = `${baseUrl.replace(/\/$/, "")}/webhooks/${orgId}/boxtal/${endpoint}`
    try {
      const sub = await client.v3.createSubscription({
        eventType,
        callbackUrl,
        webhookSecretConfigKey: WEBHOOK_SECRET_KEY,
      })
      // The inline webhookSecret above is IGNORED by the live API — only the
      // dedicated endpoint sets the signing key (see setSubscriptionWebhookSecret).
      await client.v3.setSubscriptionWebhookSecret(sub.id, WEBHOOK_SECRET_KEY)
      await upsertSubscription(ctx, { event_type: eventType, subscription_id: sub.id, callback_url: callbackUrl })
    } catch (err) {
      allOk = false
      ctx.logger?.warn?.("boxtal: createSubscription failed", { eventType, err: String(err) })
    }
  }
  await setWebhookStatus(ctx, allOk ? "active" : "degraded")
}

export async function onConnectionDisconnected(event: ConnectionEvent, ctx: ConnectionCtx): Promise<void> {
  if (event.data?.appName !== "boxtal") return
  const client = await getClient(ctx).catch(() => null)
  const subs = (await ctx.db.findMany("subscription", { limit: 100 })) as Array<{ id: string; subscription_id: string }>
  for (const s of subs) {
    if (client) {
      try {
        await client.v3.deleteSubscription(s.subscription_id)
      } catch (err) {
        ctx.logger?.warn?.("boxtal: deleteSubscription failed", { id: s.subscription_id, err: String(err) })
      }
    }
    await ctx.db.delete("subscription", s.id)
  }
  await clearWebhookStatus(ctx)
}

/**
 * webhooks_repair — re-point the Boxtal v3 subscriptions at the CURRENT
 * kernel-minted webhook secret. Fixes the "Invalid signature" 401 class where
 * Boxtal still signs with the secret of an older install/registration (every
 * delivery rejected, so tracking_status and documents stop syncing). Reuses
 * each stored subscription row's callback_url so no kernel base URL plumbing
 * is needed; rows only exist after a successful initial registration (if none
 * exist, reconnecting the app is the repair path).
 */
export async function webhooksRepair(ctx: ConnectionCtx): Promise<{
  repaired: Array<{ event_type: string; subscription_id: string }>
  failed: Array<{ event_type: string; reason: string }>
  webhook_status: "active" | "degraded"
}> {
  if (!(await ctx.config.has(WEBHOOK_SECRET_KEY))) {
    return {
      repaired: [],
      failed: [{ event_type: "*", reason: "no kernel webhook secret configured" }],
      webhook_status: "degraded",
    }
  }
  const client = await getClient(ctx)
  const rows = (await ctx.db.findMany("subscription", { limit: 100 })) as Array<{
    id: string
    event_type: string
    subscription_id: string
    callback_url: string
  }>
  const repaired: Array<{ event_type: string; subscription_id: string }> = []
  const failed: Array<{ event_type: string; reason: string }> = []
  for (const { eventType } of SUBSCRIPTIONS) {
    const row = rows.find((r) => r.event_type === eventType)
    if (!row?.callback_url) {
      failed.push({ event_type: eventType, reason: "no stored subscription; reconnect the app" })
      continue
    }
    try {
      // Boxtal DOES have an update-secret call — the dedicated
      // PUT /subscription/{id}/webhook-secret (the inline field on create is
      // ignored by the live API). Set it in place first; fall back to
      // delete-then-recreate only when the stored subscription is gone on
      // their side (404/permission), and set the secret on the NEW id too.
      try {
        await client.v3.setSubscriptionWebhookSecret(row.subscription_id, WEBHOOK_SECRET_KEY)
        repaired.push({ event_type: eventType, subscription_id: row.subscription_id })
        continue
      } catch {
        // fall through to recreate
      }
      await client.v3.deleteSubscription(row.subscription_id).catch(() => undefined)
      const sub = await client.v3.createSubscription({
        eventType,
        callbackUrl: row.callback_url,
        webhookSecretConfigKey: WEBHOOK_SECRET_KEY,
      })
      await client.v3.setSubscriptionWebhookSecret(sub.id, WEBHOOK_SECRET_KEY)
      await upsertSubscription(ctx, {
        event_type: eventType,
        subscription_id: sub.id,
        callback_url: row.callback_url,
      })
      repaired.push({ event_type: eventType, subscription_id: sub.id })
    } catch (err) {
      failed.push({ event_type: eventType, reason: String(err) })
    }
  }
  const webhook_status = failed.length === 0 && repaired.length > 0 ? "active" : "degraded"
  await setWebhookStatus(ctx, webhook_status)
  return { repaired, failed, webhook_status }
}
