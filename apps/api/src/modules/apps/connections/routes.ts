// SPDX-License-Identifier: FSL-1.1-ALv2
import { resolveLocale } from "@liaison/shared"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { appsLogger as log } from "~/lib/logger"
import { connectBindingEnabled, setConnectBindingCookie } from "~/lib/oauth-browser-binding"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { isAppOriginRequest } from "~/lib/response"
import { requireScope } from "~/middleware/require-scope"
import { connectionConfigRegistry, manifestRegistry } from "~/modules/apps/app-registries"
import { appVisibilityFor } from "~/modules/apps/app-visibility"
import { connectionAdminScope } from "~/modules/apps/connections/admin-scope"
import { runBeforeDisconnect } from "~/modules/apps/connections/before-disconnect"
import { claimConnectLink, peekConnectLink } from "~/modules/apps/connections/connect-links"
import {
  accountsMintedByAnotherClient,
  oauthConnectionKey,
} from "~/modules/apps/connections/oauth-client"
import {
  getConnectionOAuthClient,
  upsertConnectionOAuthClient,
} from "~/modules/apps/connections/oauth-client-provisioning"
import { precheckCredentials } from "~/modules/apps/connections/precheck"
import { runConnectionTeardown } from "~/modules/apps/connections/revoke"
import {
  CONNECT_BINDING_COOKIE,
  CONNECT_CALLBACK_PATH,
  ConnectionHeldByMemberError,
  ConnectionHeldByOtherOwnerError,
  CredentialRefusedError,
  connectionAccountLabel,
  createCredentialConnection,
  describeConnectionAccounts,
  disconnectConnection,
  getMultiInstanceCredentialCheck,
  healUnnamedConnectionAccounts,
  listConnections,
  MULTI_INSTANCE_IDENTIFIER_RE,
  OAuthCallbackRefusedError,
  reconcileAppConnections,
  reconcileConnection,
  redeemShellConnect,
  refreshConnectionDisplayName,
  startOAuthFlow,
} from "~/modules/apps/connections/service"
import { readConnectionSettings } from "~/modules/apps/connections/settings"
import {
  ConnectHandoffRefusedError,
  parseConnectClient,
} from "~/modules/apps/connections/shell-connect"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { serverT } from "~/modules/i18n/server-i18n"
import { hasScope } from "~/modules/permissions/permissions"

type ConnectMode = "personal" | "org"

function getConnectMode(c: any, body?: Record<string, any>): ConnectMode {
  const raw = c.req.query("mode") ?? c.req.query("owner") ?? body?.mode ?? "personal"
  if (raw === "personal" || raw === "org") return raw
  throw new HTTPException(400, { message: "Connection mode must be personal or org" })
}

function getOAuthConnectMode(c: any, body?: Record<string, any>): ConnectMode {
  return getConnectMode(c, { ...body, mode: body?.mode ?? body?.ownerType })
}

/** Org-level administration of a connection takes its admin scope (connections/admin-scope.ts). */
function requireOrgConnectScope(
  c: any,
  appName: string,
  connectionName: string,
  mode: ConnectMode,
): void {
  if (mode !== "org") return
  const scopes = c.get("scopes")
  if (!hasScope(connectionAdminScope(c.get("orgId"), appName, connectionName), scopes)) {
    throw new HTTPException(403, { message: "Admin scope required for org-level connections" })
  }
}

function ownerTypeFromMode(mode: ConnectMode): "user" | "org" {
  return mode === "org" ? "org" : "user"
}

/** The token of a one-time connect link, from a JSON body. */
async function linkToken(c: any): Promise<string> {
  const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
  return typeof body.token === "string" ? body.token : ""
}

/** A refused credential: nothing was stored; the message is the field's or the check's. */
function credentialRefused(c: any, err: CredentialRefusedError) {
  const locale = resolveLocale(c.req.header("accept-language")?.split(",")[0]?.trim())
  const translated = err.messageKey ? serverT(locale, err.messageKey) : null
  return c.json(
    {
      error: {
        code: err.code,
        message: translated && translated !== err.messageKey ? translated : err.message,
        details: { field: err.field, stored: false },
      },
    },
    422,
  )
}

export const connectionRoutes = new Hono<AppEnv>()
  // A one-time connect link (connect-links.ts): what it is for, for the
  // signed-in person only. Consumes nothing.
  .post("/links/peek", async (c) => {
    const view = await peekConnectLink(await linkToken(c), {
      orgId: c.get("orgId"),
      userId: c.get("userId"),
    })
    return c.json({ data: view })
  })
  // Redeem it: only the person it was minted for, once. Starts the same
  // browser-bound personal flow as the Connect button (authorize, below).
  .post("/links/redeem", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const outcome = await claimConnectLink(await linkToken(c), { orgId, userId })
    if (outcome.status === "wrong_user") {
      return c.json(
        {
          error: {
            code: "CONNECT_LINK_WRONG_USER",
            message: `This link is for ${outcome.email}: sign in as ${outcome.email}, then open this link again.`,
          },
        },
        403,
      )
    }
    if (outcome.status === "invalid") {
      return c.json(
        {
          error: {
            code: "CONNECT_LINK_INVALID",
            message: "This connect link was already used or has expired: ask for a new one.",
          },
        },
        410,
      )
    }
    const { claim } = outcome
    const bind = connectBindingEnabled()
    let redirectUrl: string
    try {
      redirectUrl = await startOAuthFlow(orgId, userId, claim.appName, claim.connectionName, {
        ownerType: "user",
        ownerId: userId,
        browserBound: bind,
        connectLinkId: claim.linkId,
        onState: (state) => {
          if (bind) setConnectBindingCookie(c, CONNECT_BINDING_COOKIE, CONNECT_CALLBACK_PATH, state)
        },
      })
    } catch (err) {
      await claim.restore()
      throw err
    }
    await claim.redeemed()
    return c.json({ data: { redirectUrl } })
  })
  .get("/", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const accounts = await withRequestRls(c, async (tx) => listConnections(tx, orgId, userId))
    return c.json({ data: accounts })
  })
  .get("/:appName", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const appName = c.req.param("appName")
    const accounts = await withRequestRls(c, async (tx) =>
      listConnections(tx, orgId, userId, { appName }),
    )
    return c.json({ data: accounts })
  })
  // The accounts behind one of an app's connections, as its settings page lists
  // them: the org's own and the caller's personal ones (never another person's
  // personal account), active or broken, each with the name it is shown by
  // (S7), whose it is (`ownerType`: org or personal), its health and whether
  // the access renews by itself. No secrets. An org account's details (its
  // identifier, error message, renewal, who connected it) go to holders of the
  // connection's admin scope only; others get its label and status. `GET /:appName` cannot serve this:
  // it leaves org-owned app accounts out. The app must be one the caller may
  // see (the manifests list's rule); 404 otherwise, as for an unknown app.
  .get("/:appName/:connectionName/accounts", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const { appName, connectionName } = c.req.param()
    await ensureAppsForOrg(orgId)
    const visible =
      manifestRegistry.get([orgId, appName]) !== undefined &&
      appVisibilityFor(orgId, (c.get("scopes") as string[] | undefined) ?? [])(appName)
    if (!visible || !connectionConfigRegistry.get([orgId, appName, connectionName])) {
      throw new HTTPException(404, { message: "Connection not found" })
    }
    const rows = await describeConnectionAccounts(orgId, userId, appName, connectionName)
    // Accounts stored without a name get it looked up in the background (one at
    // a time, throttled), so the next listing shows it; this answer does not wait.
    void healUnnamedConnectionAccounts(orgId, appName, connectionName, rows)
    // An org account's identifier, error details and who connected it are for
    // the holders of the connection's admin scope (the ones who can act on
    // them); any other member reads its name and health only (L1).
    const admin = hasScope(
      connectionAdminScope(orgId, appName, connectionName),
      (c.get("scopes") as string[] | undefined) ?? [],
    )
    return c.json({
      data: rows.map((r) => {
        const label = connectionAccountLabel(r)
        if (admin || r.ownerType !== "org") return { ...r, label }
        return {
          ...r,
          label,
          identifier: "",
          displayName: null,
          statusMessage: null,
          tokenExpiresAt: null,
          hasRefreshToken: false,
          connectedByName: null,
        }
      }),
    })
  })
  // OAuth CLIENT provisioning for an installed app's oauth2 connection -- the
  // per-connection client id + secret used to start the OAuth flow. Admin-gated
  // (instance-wide app config, same scope as install). The UI's OAuth dialog and
  // the `config apply` CLI both land here (via the shared upsert service), so the
  // two surfaces stay consistent.
  .get("/:appName/:connectionName/oauth-client", requireScope("kernel:apps:admin"), async (c) => {
    const orgId = c.get("orgId")
    const { appName, connectionName } = c.req.param()
    // The app's own client resolver lives in the org's runtime registry.
    await ensureAppsForOrg(orgId)
    return c.json({ data: await getConnectionOAuthClient(orgId, appName, connectionName) })
  })
  .put("/:appName/:connectionName/oauth-client", requireScope("kernel:apps:admin"), async (c) => {
    const orgId = c.get("orgId")
    const { appName, connectionName } = c.req.param()
    const body = (await c.req.json().catch(() => ({}))) as {
      clientId?: string
      clientSecret?: string
    }
    const clientId = body.clientId?.trim()
    const clientSecret = body.clientSecret
    if (!clientId || !clientSecret) {
      throw new HTTPException(400, { message: "clientId and clientSecret are required" })
    }
    // Only oauth2 connections have a client. Guard so a typo'd connection name or
    // a credentials connection can't silently create a dangling client row.
    const connConfig = connectionConfigRegistry.get([orgId, appName, connectionName])
    if (!connConfig) {
      throw new HTTPException(404, {
        message: `Connection "${connectionName}" not declared in app "${appName}" manifest (is the app installed?)`,
      })
    }
    if (connConfig.type !== "oauth2") {
      throw new HTTPException(400, {
        message: `Connection "${connectionName}" is not an oauth2 connection`,
      })
    }
    const { created } = await upsertConnectionOAuthClient({
      orgId,
      appName,
      connectionName,
      clientId,
      clientSecret,
    })
    // Accounts connected with another client keep working on it; a reconnect
    // moves each one to this client. Say so, with the count.
    const reconnectToMove = await accountsMintedByAnotherClient(
      orgId,
      [oauthConnectionKey(appName, connectionName)],
      clientId,
    )
    return c.json({ data: { configured: true, created, clientId, reconnectToMove } })
  })
  // Re-drive an app connection's post-connect initialization, keyed by
  // app + connection name (the identity the Settings UI already holds). Org-owned
  // connect handlers are gated by the connection's admin scope, the same guard the
  // org-level connect uses. Idempotent; safe to click repeatedly.
  .post("/:appName/:connectionName/reconcile", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const { appName, connectionName } = c.req.param()
    requireOrgConnectScope(c, appName, connectionName, "org")
    const { reconciled } = await reconcileAppConnections(orgId, userId, appName, connectionName)
    if (reconciled.length === 0) {
      throw new HTTPException(404, {
        message: `No active "${connectionName}" connection to reconcile for "${appName}"`,
      })
    }
    return c.json({ data: { success: true, reconciled } })
  })
  .post("/:appName/:connectionName/authorize", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const { appName, connectionName } = c.req.param()
    const body = await c.req.json().catch(() => ({}))
    const mode = getOAuthConnectMode(c, body)
    requireOrgConnectScope(c, appName, connectionName, mode)

    // Per-store providers (Shopify) need the shop domain to substitute the
    // `{shop}` placeholder in the auth/token URLs. Accept it from the request
    // body or `?shop=` query param; other providers ignore it.
    const shop = typeof body?.shop === "string" ? body.shop : (c.req.query("shop") ?? undefined)

    // A desktop or mobile shell binds the flow to itself (shell-connect.ts):
    // the cookie below could never be stored on its cross-site fetch.
    const client = parseConnectClient(body, isAppOriginRequest(c))
    if (client.kind === "invalid") throw new HTTPException(400, { message: client.message })
    const shellFlow = client.kind === "shell" ? client.flow : undefined

    const bind = connectBindingEnabled() && !shellFlow
    const redirectUrl = await startOAuthFlow(orgId, userId, appName, connectionName, {
      ownerType: ownerTypeFromMode(mode),
      shop,
      // The address being connected (e.g. reconnecting a listed account).
      ...(typeof body?.accountHint === "string" ? { accountHint: body.accountHint } : {}),
      browserBound: bind,
      shellFlow,
      // The callback is unauthenticated, so the browser that started the flow
      // carries the proof: a cookie holding a hash of the state.
      onState: (state) => {
        if (bind) setConnectBindingCookie(c, CONNECT_BINDING_COOKIE, CONNECT_CALLBACK_PATH, state)
      },
    })
    return c.json({ data: { redirectUrl } })
  })
  // A shell redeeming the connect flow it started: the one-time code from its
  // `liaison://oauth-complete` link, with the PKCE verifier only it holds. The
  // session must be the one that started the flow.
  .post("/oauth-handoff", async (c) => {
    const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>
    try {
      const done = await redeemShellConnect({
        code: body.code,
        codeVerifier: body.code_verifier,
        orgId: c.get("orgId"),
        userId: c.get("userId"),
      })
      return c.json({ data: done })
    } catch (err) {
      if (err instanceof ConnectHandoffRefusedError) {
        log.warn("Connect handoff refused: unknown, replayed or foreign code, or a wrong verifier")
        throw new HTTPException(400, { message: err.message })
      }
      if (err instanceof ConnectionHeldByOtherOwnerError) {
        throw new HTTPException(409, { message: err.message })
      }
      if (err instanceof OAuthCallbackRefusedError) {
        throw new HTTPException(400, { message: err.message })
      }
      // A mailbox outside the org's domains is already a 403 (mail-domains.ts).
      throw err
    }
  })
  .post("/:appName/:connectionName/credentials", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const { appName, connectionName } = c.req.param()
    const body = await c.req.json()

    // Validate the connection exists in the app manifest and only declared fields are provided
    const connConfig = connectionConfigRegistry.get([orgId, appName, connectionName])
    if (!connConfig) {
      throw new HTTPException(404, {
        message: `Connection "${connectionName}" not declared in app "${appName}" manifest`,
      })
    }
    if (connConfig.type !== "credentials") {
      throw new HTTPException(400, {
        message: `Connection "${connectionName}" is not a credentials-type connection`,
      })
    }

    // A multiInstance connection is org-owned only and addressed by the body's
    // slug `identifier` (never a credential field): mode is forced to org, so
    // the accounts-admin scope is always required.
    const multiInstance = connConfig.multiInstance === true
    const envelopeKeys = ["ownerType", "mode", "credentials", "displayName", "takeOver"]
    if (multiInstance) envelopeKeys.push("identifier")

    // Extract credentials — support both { credentials: {...} } and flat body
    const rawCredentials: Record<string, string> = body.credentials ?? body
    const providedCredentials = Object.fromEntries(
      Object.entries(rawCredentials).filter(([key]) => !envelopeKeys.includes(key)),
    ) as Record<string, string>
    const mode = multiInstance ? "org" : getConnectMode(c, body)
    const ownerType = ownerTypeFromMode(mode)
    requireOrgConnectScope(c, appName, connectionName, mode)
    let multiInstanceIdentifier: string | null = null
    if (multiInstance) {
      // Top-level `identifier`, or inside `credentials` (the settings form's shape).
      const raw = typeof body.identifier === "string" ? body.identifier : rawCredentials.identifier
      if (typeof raw !== "string" || !MULTI_INSTANCE_IDENTIFIER_RE.test(raw)) {
        throw new HTTPException(400, {
          message:
            "identifier is required: a lowercase slug (letters, digits, -) of at most 40 characters",
        })
      }
      multiInstanceIdentifier = raw
    }

    if (connConfig.credentialFields && Array.isArray(connConfig.credentialFields)) {
      const declaredKeys = new Set(connConfig.credentialFields.map((f: any) => f.name))
      const requiredKeys = connConfig.credentialFields
        .filter((f: any) => f.required !== false)
        .map((f: any) => f.name)
      for (const key of requiredKeys) {
        if (!providedCredentials[key]) {
          throw new HTTPException(400, { message: `Missing required credential field: "${key}"` })
        }
      }
      for (const key of Object.keys(providedCredentials)) {
        if (!declaredKeys.has(key)) {
          throw new HTTPException(400, { message: `Undeclared credential field: "${key}"` })
        }
      }
    }

    if (multiInstanceIdentifier !== null) {
      const check = getMultiInstanceCredentialCheck(orgId, appName, connectionName)
      if (check) {
        const verdict = await check({
          orgId,
          identifier: multiInstanceIdentifier,
          credentials: providedCredentials,
        })
        if (!verdict.ok) throw new HTTPException(verdict.status, { message: verdict.message })
      }
    }

    // The account's identifier: the slug, else the "email" or "identifier"
    // field. A connection whose fields name no account keys a personal save on
    // the person and an ORG save on the org, never on the admin who typed it:
    // keyed on the admin, it met their own personal account of the same
    // connection and retired it. An existing org row keyed on an admin's id is
    // re-keyed by its next save (the upsert matches the owner, not the identifier).
    const identifier =
      multiInstanceIdentifier ??
      providedCredentials.email ??
      providedCredentials.identifier ??
      (ownerType === "org" ? orgId : userId)

    try {
      // The connection's own check of the key before it is kept: a refused key
      // replaces nothing (precheck.ts).
      await precheckCredentials({
        actor: extractRlsContext(c),
        appName,
        connectionName,
        credentials: providedCredentials,
      })
    } catch (err) {
      if (err instanceof CredentialRefusedError) return credentialRefused(c, err)
      throw err
    }

    const connectionInput = {
      identifier,
      credentials: providedCredentials,
      displayName: body.displayName,
      ownerType,
      takeOver: body.takeOver === true,
    }
    try {
      const account =
        ownerType === "org"
          ? await withPrivilegedDb(orgId, "create-org-credential-connection", async (tx) =>
              createCredentialConnection(
                tx,
                orgId,
                userId,
                appName,
                connectionName,
                connectionInput,
              ),
            )
          : await withRequestRls(c, async (tx) =>
              createCredentialConnection(
                tx,
                orgId,
                userId,
                appName,
                connectionName,
                connectionInput,
              ),
            )
      return c.json({ data: account }, 201)
    } catch (err) {
      // The account is someone else's (service.ts, one active account per identifier).
      if (err instanceof ConnectionHeldByOtherOwnerError) {
        throw new HTTPException(409, { message: err.message })
      }
      // The wrong kind of secret: nothing was stored; the field's own message says why.
      if (err instanceof CredentialRefusedError) return credentialRefused(c, err)
      // A member holds it personally: the caller confirms with `takeOver: true`.
      if (err instanceof ConnectionHeldByMemberError) {
        return c.json(
          {
            error: {
              message: err.message,
              code: err.code,
              details: { memberName: err.memberName },
            },
          },
          409,
        )
      }
      throw err
    }
  })
  // The non-secret settings an account stores (hosts, ports, username), for the
  // edit form: never a password-type field (connections/settings.ts).
  .get("/:id/settings", async (c) => {
    const outcome = await readConnectionSettings({
      orgId: c.get("orgId"),
      userId: c.get("userId"),
      scopes: (c.get("scopes") as string[] | undefined) ?? [],
      connectedAccountId: c.req.param("id"),
    })
    if (outcome.status === "not_found") {
      throw new HTTPException(404, { message: "Connection not found" })
    }
    if (outcome.status === "forbidden") {
      throw new HTTPException(403, {
        message: "Admin scope required to read org-level connection settings",
      })
    }
    return c.json({ data: { settings: outcome.settings } })
  })
  .delete("/:id", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const id = c.req.param("id")

    // Check org-owned accounts outside user RLS: app-specific extension tables own
    // visibility, but the generic disconnect route still needs the admin guard.
    const account = await withPrivilegedDb(
      orgId,
      "connected-account-disconnect-lookup",
      async (tx) => {
        const rows = await tx
          .select({
            ownerType: connectedAccounts.ownerType,
            appName: connectedAccounts.appName,
            connectionName: connectedAccounts.connectionName,
          })
          .from(connectedAccounts)
          .where(and(eq(connectedAccounts.id, id), eq(connectedAccounts.orgId, orgId)))
          .limit(1)
        return rows[0]
      },
    )

    if (account?.ownerType === "org") {
      const scopes = c.get("scopes")
      if (!hasScope(connectionAdminScope(orgId, account.appName, account.connectionName), scopes)) {
        throw new HTTPException(403, {
          message: "Admin scope required to disconnect org-level connections",
        })
      }
    }

    if (!account) throw new HTTPException(404, { message: "Connection not found" })
    // A personal connection is disconnected under the caller's RLS, so it is theirs to
    // disconnect only if they can see it (the same lookup `disconnectConnection` does).
    // Checked BEFORE the provider cleanup below: a member must never get another
    // member's store cleaned up by a disconnect that then answers 404.
    if (account.ownerType !== "org") {
      const visible = await withRequestRls(c, (tx) =>
        tx
          .select({ id: connectedAccounts.id })
          .from(connectedAccounts)
          .where(and(eq(connectedAccounts.id, id), eq(connectedAccounts.orgId, orgId)))
          .limit(1),
      )
      if (visible.length === 0) throw new HTTPException(404, { message: "Connection not found" })
    }

    // Authorized: while the token is still valid, the app removes what it registered at
    // the provider (best effort, never throws; before-disconnect.ts).
    await runBeforeDisconnect(orgId, id)

    if (account.ownerType === "org") {
      await withPrivilegedDb(orgId, "connected-account-org-disconnect", async (tx) =>
        disconnectConnection(tx, orgId, userId, id),
      )
    } else {
      await withRequestRls(c, async (tx) => disconnectConnection(tx, orgId, userId, id))
    }
    // Committed: stop the push watch and revoke the grant at the provider (never throws; what
    // a provider outage prevents stays queued and is retried).
    await runConnectionTeardown(id)
    return c.json({ data: { success: true } })
  })
  // Re-drive an active connection's post-connect initialization (re-emit
  // `connected_account:create`) — the recovery path when the one-shot connect
  // event was lost (app subscriber not live at publish time) and the app is
  // silently uninitialised. Same org-owned admin guard as disconnect. Idempotent.
  .post("/:id/reconcile", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const id = c.req.param("id")

    // Resolve outside user RLS so org-owned app connections are visible for the
    // admin guard (mirrors the disconnect route).
    const account = await withPrivilegedDb(
      orgId,
      "connected-account-reconcile-lookup",
      async (tx) => {
        const rows = await tx
          .select({
            ownerType: connectedAccounts.ownerType,
            appName: connectedAccounts.appName,
            connectionName: connectedAccounts.connectionName,
          })
          .from(connectedAccounts)
          .where(and(eq(connectedAccounts.id, id), eq(connectedAccounts.orgId, orgId)))
          .limit(1)
        return rows[0]
      },
    )
    if (!account) throw new HTTPException(404, { message: "Connection not found" })
    if (account.ownerType === "org") {
      const scopes = c.get("scopes")
      if (!hasScope(connectionAdminScope(orgId, account.appName, account.connectionName), scopes)) {
        throw new HTTPException(403, {
          message: "Admin scope required to reconcile org-level connections",
        })
      }
    }

    const outcome =
      account.ownerType === "org"
        ? await withPrivilegedDb(orgId, "connected-account-org-reconcile", async (tx) =>
            reconcileConnection(tx, orgId, userId, id),
          )
        : await withRequestRls(c, async (tx) => reconcileConnection(tx, orgId, userId, id))

    if (outcome.status === "not_found")
      throw new HTTPException(404, { message: "Connection not found" })
    if (outcome.status === "not_active") {
      throw new HTTPException(409, {
        message: `Connection is ${outcome.connectionStatus}; reconnect it instead of reconciling`,
      })
    }
    // After the transaction: the provider lookup must not hold a pooled connection.
    await refreshConnectionDisplayName(orgId, id)
    return c.json({ data: { success: true, ...outcome } })
  })
