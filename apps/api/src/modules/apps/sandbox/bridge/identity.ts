// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import {
  createConfigSecretMethods,
  manifestSecretConfigKeys,
} from "~/modules/apps/sandbox/bridge/secret-free"
import { setUserScopes as setUserScopesService } from "~/modules/permissions/app-grants"
import { hasScope } from "~/modules/permissions/permissions"

/** Caller identity, settings, scopes, app config, grants and logging. */
export function createIdentityMethods(ctx: BridgeContext): Record<string, any> {
  const {
    appName,
    appTable,
    approvalContext,
    bridgeOptions,
    callerScopes,
    errorEnvelope,
    findEntityById,
    kernelSchema,
    logger,
    manifest,
    orgId,
    requireCapability,
    txDb,
    userId,
  } = ctx
  return {
    getUserId: () => userId,
    getOrgId: () => orgId,

    // Whether THIS call's actor holds one of the calling app's OWN scopes (`<app>:…`, with the
    // usual wildcard and parent rules), so a read tool can tell the UI which actions to offer
    // instead of letting a click fail. Any scope outside the app's namespace answers false: an app
    // learns nothing about the caller's other grants.
    callerHasScope: (scope: string): boolean =>
      typeof scope === "string" &&
      scope.startsWith(`${appName}:`) &&
      hasScope(scope, callerScopes ?? []),

    // The DECLARED cross-app caller of THIS dispatch (execute-tool.ts's
    // `internalCall.callerApp`), or "" for a direct user/agent/MCP call. A
    // handler reads it to tell a connector's own deterministic ingestion from
    // an agent-authored action: knowledge's org-scope approval gate is an
    // AGENT decision gate, and a webhook ingestion arriving through the K4
    // `cross_app_calls` contract is an app write path that must not raise an
    // approval no human is watching (it lands in the review queue instead).
    // Synchronous in process, awaited over the worker IPC hop: handlers call
    // it as `await ctx.getCallerApp()`, which is correct on both paths.
    getCallerApp: () =>
      typeof bridgeOptions?.callerApp === "string" && bridgeOptions.callerApp !== appName
        ? bridgeOptions.callerApp
        : "",

    // The same caller, answered ONLY when the kernel recognises THIS dispatch as an
    // ingestion: the caller declares this target in its operator-approved
    // `cross_app_calls` AND the pair is one of the kernel's ingestion paths
    // (modules/apps/cross-app-ingestions.ts). A handler that skips an approval gate for
    // a machine write path asks THIS, never "is there any caller app": every declared
    // cross-app call would otherwise buy the skip, and a gate that wide is a gate nobody
    // can reason about. Computed by `executeToolCore`, the only place that knows both
    // halves, and forwarded here exactly as `humanAuthorized` is, so the sandbox can
    // neither claim it nor widen it.
    getIngestionCallerApp: () =>
      typeof bridgeOptions?.ingestionCallerApp === "string" ? bridgeOptions.ingestionCallerApp : "",

    // Phase 17 B11 + fix C5 — sandbox-side `ctx.approval` accessor. Returns
    // the post-approval context JSON (or `null`) so re-entrant gated tools
    // can branch on "first call → surface card" vs "post-approval
    // re-invocation → do work". The executor pre-bakes this synchronously
    // at shim-build time and embeds the result as a literal field on the
    // `__ctx` object (see `executor.ts:buildCtxSpec`) — handlers read
    // `ctx.approval` directly (no `await`). The method is left here as a
    // synchronous fallback for runtime inspection / migrations of the shim.
    // Shape: `{ approvalRequestId, approvalDeciderId, toolName }` or null.
    _approvalContext_get: () => JSON.stringify(approvalContext ?? null),

    // --- App-issued scope grants (capability: grants.setUserScopes) ---
    // Phase 16 Task A1. The calling app's name is *forced* from `appName` (the
    // bridge's authenticated context); any `callingApp` passed in the payload
    // is ignored. The service enforces the namespace ceiling.
    grants_setUserScopes: async (userId: string, scopesJson: string): Promise<string> => {
      try {
        requireCapability("grants.setUserScopes")
        const scopes = JSON.parse(scopesJson) as unknown
        if (!Array.isArray(scopes) || !scopes.every((s): s is string => typeof s === "string")) {
          throw new Error("scopes must be a JSON array of strings")
        }
        await setUserScopesService(txDb, {
          orgId,
          callingApp: appName,
          userId,
          scopes: scopes as string[],
          // I9 — pin to the calling app's declared scope set so an app cannot
          // grant undeclared (typo'd) scopes that the kernel scope-check would
          // then silently reject.
          declaredScopes: Array.isArray(manifest.scopes)
            ? (manifest.scopes as string[])
            : undefined,
        })
        return JSON.stringify({ ok: true })
      } catch (e) {
        return errorEnvelope(e)
      }
    },

    // --- Logger ---
    log_info: (msg: string, dataJson?: string) => {
      logger.info(dataJson ? JSON.parse(dataJson) : {}, msg)
    },
    log_warn: (msg: string, dataJson?: string) => {
      logger.warn(dataJson ? JSON.parse(dataJson) : {}, msg)
    },
    log_error: (msg: string, dataJson?: string) => {
      logger.error(dataJson ? JSON.parse(dataJson) : {}, msg)
    },
    log_debug: (msg: string, dataJson?: string) => {
      logger.debug(dataJson ? JSON.parse(dataJson) : {}, msg)
    },

    // Read-only accessor over the app's `kernel.apps.config` jsonb store, exposed
    // to tool/event handlers as `ctx.config.get(key)`. Mirrors the webhook
    // verifier's `config_get` (webhooks/routes.ts) so a credentials-connection
    // app's connect handler can read the kernel-minted webhook secret
    // (`webhookSecretConfigKey`) and forward it to the provider's subscription
    // API. There is no write counterpart — the kernel owns the mint.
    // App-held secret capability (write half): store a provider-minted secret under a key the
    // manifest declares in `connections.<c>.appSecretConfigKeys`. Encrypted host-side; returns
    // nothing, and the value never reaches a log line.
    config_setSecret: async (key: string, value: string): Promise<void> => {
      const { storeAppHeldSecret } = await import("~/modules/apps/connections/service")
      await storeAppHeldSecret({
        orgId,
        appName,
        key: String(key),
        value: String(value),
        manifestConnections: manifest.connections,
      })
    },
    config_get: async (key: string) => readAppConfigValue(ctx, key),

    // Secret-by-key (secret-free.ts): sign or verify with a declared config secret, or ask
    // whether one is set, without the secret entering the app's memory.
    ...createConfigSecretMethods({
      readConfig: (key) => readAppConfigValue(ctx, key),
      secretConfigKeys: manifestSecretConfigKeys(manifest.connections),
    }),

    hasOnlineUsers: async (accountId: string) => {
      const account = (await findEntityById("accounts", accountId)) as {
        id: string
        owner_type: "user" | "org"
        owner_id: string | null
      } | null
      if (!account) return JSON.stringify(false)

      const { getWsManager } = await import("~/infra/websocket")
      const wsMgr = getWsManager()
      if (!wsMgr) return JSON.stringify(false)

      return JSON.stringify(
        await wsMgr.hasOnlineUserWithMailAccess(orgId, {
          id: accountId,
          ownerType: account.owner_type,
          ownerId: account.owner_id,
        }),
      )
    },

    hasScope: async (scope: string) => {
      const { hasScope: checkScope } = await import("~/modules/permissions/permissions")
      return checkScope(scope, callerScopes ?? [])
    },

    getOrgSettings: async (): Promise<string> => {
      const { getOrgAppSettings } = await import("~/lib/settings")
      const { appSettingsRegistry } = await import("~/modules/apps/app-registries")
      const reg = appSettingsRegistry.get([orgId, appName])
      if (!reg?.orgSchema) return JSON.stringify({})
      const value = await getOrgAppSettings(txDb, orgId, appName, reg.orgSchema)
      return JSON.stringify(value)
    },

    getUserSettings: async (lookupUserId: string): Promise<string> => {
      const { getUserAppSettings } = await import("~/lib/settings")
      const { appSettingsRegistry } = await import("~/modules/apps/app-registries")
      const reg = appSettingsRegistry.get([orgId, appName])
      if (!reg?.userSchema) return JSON.stringify(reg?.userDefaults ?? {})
      // The settings live on the user row, read by id. The bridge's transaction is
      // not always an RLS one (a vouched app's system handlers run privileged), so
      // the row is held to this bridge's org here rather than left to RLS.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lookupUserId)) {
        return JSON.stringify(reg.userDefaults ?? {})
      }
      const member = extractRows(
        await txDb.execute(
          drizzleSql`SELECT 1 FROM ${appTable(kernelSchema, "users")} WHERE id = ${lookupUserId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`,
        ),
      )
      if (member.length === 0) return JSON.stringify(reg.userDefaults ?? {})
      const value = await getUserAppSettings(
        txDb,
        lookupUserId,
        appName,
        reg.userSchema,
        reg.userDefaults ?? {},
      )
      return JSON.stringify(value)
    },
  }
}

/**
 * The app's `kernel.apps.config` value for `key`, as `ctx.config.get` answers
 * it: the cell's value for a key the cell owns, else the stored value (a
 * declared connection secret decrypted host-side), else the instance default.
 * Shared by `config_get`, `config_has`, the *ForConfig crypto methods and the
 * `configSecrets` of `ctx.fetch`; a Workers run refuses only the first for a
 * secret key.
 */
export async function readAppConfigValue(
  ctx: BridgeContext,
  key: string,
  db: BridgeContext["txDb"] = ctx.txDb,
): Promise<unknown> {
  const { appName, appTable, kernelSchema, manifest, orgId } = ctx
  const txDb = db

  const rows = await txDb.execute(
    drizzleSql`SELECT config FROM ${appTable(kernelSchema, "apps")} WHERE org_id = ${orgId} AND name = ${appName} LIMIT 1`,
  )
  const row = extractRows(rows)[0] as { config?: unknown } | undefined
  const rawConfig = row?.config
  const config =
    typeof rawConfig === "string"
      ? (JSON.parse(rawConfig) as Record<string, unknown>)
      : (rawConfig as Record<string, unknown> | null | undefined)
  const value = config?.[key]
  // A key the managed cell owns answers the cell's value (cell-locked-config.ts).
  const { cellConfigOverride } = await import("~/modules/apps/cell-locked-config")
  const cell = await cellConfigOverride(orgId, appName, String(key), value)
  if (cell !== undefined) return cell
  if (value === undefined || value === null) {
    // The instance may answer for every workspace (Mail's shared Gmail push topic).
    const { instanceConfigDefault } = await import("~/modules/apps/instance-config-defaults")
    return instanceConfigDefault(appName, key)
  }
  // Connection secrets (OAuth client secret / kernel-minted webhook secret)
  // are stored encrypted in apps.config. Decrypt ONLY those keys here, so a
  // connect handler / verifier reads the same plaintext secret it always did;
  // every other config key (e.g. gmailPushAudience) is returned verbatim. The
  // decrypt runs host-side — the ENCRYPTION_KEY is NEVER handed into the
  // sandbox; only the resulting plaintext secret string crosses the boundary,
  // exactly as the plaintext value did before encryption-at-rest.
  const { decryptConnectionConfigValue } = await import("~/modules/apps/connections/service")
  // Derive which keys are secret from THIS bridge's manifest connections —
  // the stable source always present here — so a registry-population gap can
  // never leak ciphertext to the consumer. Default encKey resolves live env.
  return decryptConnectionConfigValue(orgId, appName, key, value, undefined, manifest.connections)
}
