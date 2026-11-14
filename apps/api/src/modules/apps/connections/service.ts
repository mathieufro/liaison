// SPDX-License-Identifier: FSL-1.1-ALv2

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { connectFailureReason } from "@liaison/shared"
import { and, desc, sql as drizzleSql, eq, inArray, isNull } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb, withPrivilegedReusing } from "~/db/privileged"
import { apps as appsTable, connectedAccounts, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { manifestRegExp } from "~/lib/manifest-regex"
import { connectBindingMatches } from "~/lib/oauth-browser-binding"
import {
  oauthStateForOrg,
  oauthStatePrefixed,
  oauthStateSlug,
  stateSlugFitsHost,
} from "~/lib/oauth-state"
import { bindingAllowsOrg, type HostBinding, orgIdForSlug } from "~/lib/org-host"
import { oauthRedirectBaseUrl, orgAppBaseUrl, orgPublicBaseUrl } from "~/lib/org-public-url"
import {
  fetchWithRedirectValidation,
  UnsafeOutboundUrlError,
  validateOutboundUrl,
} from "~/lib/outbound-fetch"
import { redis } from "~/lib/redis"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { connectionAdminScope } from "~/modules/apps/connections/admin-scope"
import { ConnectionCredentialsMissingError } from "~/modules/apps/connections/credentials-missing"
import {
  isKernelAccountMetadataKey,
  type KernelAccountMetadataKey,
} from "~/modules/apps/connections/kernel-account-metadata"
import { assertMailboxAllowed } from "~/modules/apps/connections/mail-domains"
import { NoConnectedAccountError } from "~/modules/apps/connections/no-connected-account"
import { MINTING_CLIENT_GONE_MESSAGE } from "~/modules/apps/connections/oauth-client"
import {
  resolveOAuthClientConfig,
  resolveRefreshClient,
} from "~/modules/apps/connections/oauth-client-config"
import {
  accountsAtPath,
  chooseUserinfoAccount,
  resolveAuthorizeConfigParams,
  type UserinfoAccount,
} from "~/modules/apps/connections/oauth-manifest-knobs"
import {
  authorizeScopes,
  existingAccountGrant,
  loadOptedInScopes,
  type ProtectedScope,
  protectedScopesOf,
  recordedGrant,
} from "~/modules/apps/connections/protected-scopes"
import { buildConnectedAccountCreateEvent } from "~/modules/apps/connections/reconcile-event"
import {
  restrictedScopesAllowed,
  restrictedScopesOf,
  withoutRestricted,
} from "~/modules/apps/connections/restricted-scopes"
import { stageConnectionTeardown } from "~/modules/apps/connections/revoke"
import {
  claimConnectHandoff,
  parkConnectHandoff,
  type ShellConnectFlow,
  shellConnectFlowOf,
} from "~/modules/apps/connections/shell-connect"
import { closeSqlPools } from "~/modules/apps/connections/sql/pool"
import { isAppActiveForOrgAsync } from "~/modules/apps/org-apps"
import { appSettingsPath } from "~/modules/apps/settings-paths"
import { detectMailAccountType } from "~/modules/connection-guides/account-type"
import { assertDemoEgressAllowed } from "~/modules/demo/demo-egress"
import { assertMailboxRoom, isMailboxConnection } from "~/modules/org/caps"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? ""
const OAUTH_STATE_TTL_SECONDS = 15 * 60 // 15 minutes

/** The secret columns a disconnected connection no longer holds. */
const CLEARED_SECRETS = {
  accessTokenEncrypted: null,
  refreshTokenEncrypted: null,
  credentialsEncrypted: null,
  tokenExpiresAt: null,
} as const

/**
 * A connection declaration carrying the two config keys that name an encrypted
 * secret: the OAuth client-secret mirror (`clientSecretConfigKey`) and the
 * kernel-minted webhook secret (`webhookSecretConfigKey`). This is the shape
 * both the app manifest's `connections` map and the in-memory
 * `connectionConfigRegistry` expose, so either can be the source.
 */
export interface ConnectionSecretKeySource {
  clientSecretConfigKey?: string
  webhookSecretConfigKey?: string
  /** Provider-minted secrets the app stores itself through `config_setSecret` (app-held
   *  secret capability). Encrypted exactly like the two kernel-written keys. */
  appSecretConfigKeys?: string[]
}

/**
 * The set of `kernel.apps.config` keys that hold an ENCRYPTED connection secret
 * for `(orgId, appName)` — the OAuth client-secret mirror
 * (`clientSecretConfigKey`) and the kernel-minted webhook secret
 * (`webhookSecretConfigKey`) written by this module.
 *
 * This is the single source of truth the two `config_get` bridges (the webhook
 * verifier in `webhooks/routes.ts` and the sandbox `ctx.config.get` in
 * `rpc-bridge.ts`) use to decide which keys to decrypt — every other config key
 * (e.g. `gmailPushAudience`) is passed through verbatim.
 *
 * PRIMARY (stable) source: the app's manifest `connections` map, passed in by
 * the caller. The manifest is ALWAYS available at both call sites — the sandbox
 * bridge receives it as `createRpcBridge(..., manifest)`, and the webhook
 * verifier reads it from the webhook-handler registration's `_manifest` — and it
 * is the same place `clientSecretConfigKey`/`webhookSecretConfigKey` originate.
 * Deriving from it means a process restart (or any code path that skipped
 * populating the per-org `connectionConfigRegistry`) can never silently cause a
 * stored secret to be returned as raw ciphertext, which would BREAK webhook HMAC
 * verification in production.
 *
 * FALLBACK source: the in-memory `connectionConfigRegistry` (keyed by
 * `[orgId, appName, connectionName]`), unioned across every connection declared
 * for that app. Used only when no manifest is supplied (or it declares no
 * connections) so legacy/in-process callers keep working.
 */
export function resolveConnectionSecretConfigKeys(
  orgId: string,
  appName: string,
  manifestConnections?: Record<string, ConnectionSecretKeySource> | null,
): Set<string> {
  const keys = new Set<string>()
  // Primary: the manifest's connection declarations — always available at the
  // call site, immune to registry-population gaps.
  if (manifestConnections) {
    for (const conn of Object.values(manifestConnections)) {
      if (conn?.clientSecretConfigKey) keys.add(conn.clientSecretConfigKey)
      if (conn?.webhookSecretConfigKey) keys.add(conn.webhookSecretConfigKey)
      for (const k of conn?.appSecretConfigKeys ?? []) keys.add(k)
    }
  }
  if (keys.size > 0) return keys

  // Fallback: the in-memory registry (legacy / no-manifest callers).
  for (const [[, regApp], conn] of connectionConfigRegistry.entriesOf(orgId)) {
    if (regApp !== appName) continue
    if (conn.clientSecretConfigKey) keys.add(conn.clientSecretConfigKey)
    if (conn.webhookSecretConfigKey) keys.add(conn.webhookSecretConfigKey)
    for (const k of conn.appSecretConfigKeys ?? []) keys.add(k)
  }
  return keys
}

/**
 * Decrypt a `kernel.apps.config` value IF the key is a registered connection
 * secret for `(orgId, appName)`; otherwise return the raw value unchanged.
 *
 * Shared by both `config_get` bridges so a webhook signature that verified
 * before encryption-at-rest was introduced still verifies after: the bridge
 * round-trips the ciphertext back to the exact plaintext secret the HMAC uses.
 *
 * Robustness (pre-launch, no migration): if the key IS a secret key but the
 * stored value is not valid ciphertext — a dev row written plaintext before this
 * change, or a string that was never encrypted — `decryptSecret` throws and we
 * fall back to returning the raw value. Such rows re-encrypt cleanly on their
 * next write (re-connect). A non-string value (or a non-secret key) is always
 * returned untouched.
 */
export function decryptConnectionConfigValue(
  orgId: string,
  appName: string,
  key: string,
  value: unknown,
  encKey: string = process.env.ENCRYPTION_KEY ?? ENCRYPTION_KEY,
  manifestConnections?: Record<string, ConnectionSecretKeySource> | null,
): unknown {
  if (typeof value !== "string") return value
  if (!resolveConnectionSecretConfigKeys(orgId, appName, manifestConnections).has(key)) return value
  try {
    return decryptSecret(value, encKey, CryptoContext.appConfigConnectionSecret)
  } catch {
    // Legacy / pre-encryption plaintext dev row — return as-is so it keeps
    // verifying until it re-saves. (Production rows written after this change
    // are always valid ciphertext.)
    return value
  }
}
const SIGNING_SECRET_KEY = "webhookSigningSecret"
const PREVIOUS_SECRET_KEY = "webhookSigningSecretPrevious"
const PREVIOUS_SECRET_UNTIL_KEY = "webhookSigningSecretPreviousUntil"
/** How long the old signing secret keeps verifying after a roll. */
const PREVIOUS_SECRET_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * App-held secret capability: store a secret the PROVIDER minted (returned once by its API, e.g.
 * a webhook signing secret) into the app's own `kernel.apps.config`, encrypted at rest. Only a
 * key the manifest declares in `connections.<c>.appSecretConfigKeys` is writable, and only for
 * the calling (org, app). The value is never logged; it comes back only through the app's own
 * `config_get` bridges (its verifier and its handlers), which decrypt the declared keys.
 */
export async function storeAppHeldSecret(args: {
  orgId: string
  appName: string
  key: string
  value: string
  manifestConnections?: Record<string, ConnectionSecretKeySource> | null
  encKey?: string
}): Promise<void> {
  const declared = new Set<string>()
  for (const conn of Object.values(args.manifestConnections ?? {})) {
    for (const k of conn?.appSecretConfigKeys ?? []) declared.add(k)
  }
  if (!declared.has(args.key)) {
    const err = new Error(`config key "${args.key}" is not a declared app secret`) as Error & {
      code: string
      status: number
    }
    err.code = "forbidden"
    err.status = 403
    throw err
  }
  if (typeof args.value !== "string" || args.value.length === 0 || args.value.length > 4096) {
    const err = new Error(
      "app secret must be a non-empty string of at most 4096 characters",
    ) as Error & { code: string; status: number }
    err.code = "invalid_input"
    err.status = 400
    throw err
  }
  const encKey = args.encKey ?? process.env.ENCRYPTION_KEY ?? ENCRYPTION_KEY
  const overlayJson = JSON.stringify({
    [args.key]: encryptSecret(args.value, encKey, CryptoContext.appConfigConnectionSecret),
  })
  // A replaced webhook signing secret is not cut off at once: the provider may still be
  // delivering with the old one. In the SAME update, the old (already encrypted) value moves
  // to the "previous" key with a deadline, which the verifier reads.
  const rolls = args.key === SIGNING_SECRET_KEY && declared.has(PREVIOUS_SECRET_KEY)
  const untilJson = JSON.stringify(new Date(Date.now() + PREVIOUS_SECRET_WINDOW_MS).toISOString())
  const rollOver = rolls
    ? drizzleSql`|| CASE
        WHEN coalesce(${appsTable.config}->>${SIGNING_SECRET_KEY}, '') <> ''
        THEN jsonb_build_object(
          ${PREVIOUS_SECRET_KEY}::text, ${appsTable.config}->${SIGNING_SECRET_KEY},
          ${PREVIOUS_SECRET_UNTIL_KEY}::text, ${untilJson}::jsonb)
        ELSE '{}'::jsonb END`
    : drizzleSql``
  await withPrivilegedDb(args.orgId, "app-held-secret-store", (tx) =>
    tx
      .update(appsTable)
      .set({
        config: drizzleSql`coalesce(${appsTable.config}, '{}'::jsonb) || ${overlayJson}::jsonb ${rollOver}`,
        updatedAt: new Date(),
      })
      .where(and(eq(appsTable.orgId, args.orgId), eq(appsTable.name, args.appName))),
  )
}

const OAUTH_STATE_PREFIX = "oauth:state"

/**
 * A connect started from a card in a conversation (secret-requests,
 * `oauth_connect`). Carried in the state, server-side only: the grant settles
 * that card, and the browser goes back to the conversation instead of the
 * app's settings. `popup` ends on a page that closes the window the card
 * opened; `tab` (the popup was blocked) returns the tab to the conversation.
 */
export interface ConnectCardRef {
  requestId: string
  threadId: string
  display: "popup" | "tab"
}

/** The public page a card's popup ends on (app.ts serves it). */
export const CONNECT_DONE_PATH = "/api/connections/oauth-done"

function connectCardRefOf(value: unknown): ConnectCardRef | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (typeof v.requestId !== "string" || typeof v.threadId !== "string") return null
  return {
    requestId: v.requestId,
    threadId: v.threadId,
    display: v.display === "tab" ? "tab" : "popup",
  }
}

/**
 * Where a card's connect sends the browser once the callback is done: the
 * popup's closing page, or the conversation. A failure carries only its reason
 * code (connect-failures.ts), worded by the page or the card; never the text
 * the provider or the callback produced.
 */
export async function connectCardReturnUrl(
  orgId: string,
  card: ConnectCardRef,
  failure?: { error: string },
): Promise<string> {
  const params = new URLSearchParams()
  const reason = failure ? connectFailureReason(failure.error) : null
  if (card.display === "popup") {
    params.set("result", reason ? "failed" : "connected")
    if (reason) params.set("reason", reason)
    return `${await orgPublicBaseUrl(orgId)}${CONNECT_DONE_PATH}?${params.toString()}`
  }
  if (reason) {
    // The card that started it shows the failure, with Retry, and cleans the URL.
    params.set("connect_request", card.requestId)
    params.set("oauth_error", reason)
  }
  return getFrontendRedirectUrl(orgId, `/threads/${encodeURIComponent(card.threadId)}`, params)
}
/** Cookie carrying the hash of the connect state, scoped to the callback path. */
export const CONNECT_BINDING_COOKIE = "__connect_state"
export const CONNECT_CALLBACK_PATH = "/api/connections/callback"

/**
 * A connect that cannot start for a reason the person can act on: a template
 * value (the shop) that is missing or not one, or no OAuth client yet. Its
 * `code` is what a card words for the person; the message is for logs.
 */
export class OAuthStartRefusedError extends Error {
  /** A refusal the person acts on, never a server fault (error-handler.ts). */
  readonly status = 400
  constructor(
    readonly code: "missing_value" | "invalid_value" | "no_client" | "missing_setting",
    message: string,
  ) {
    super(message)
    this.name = "OAuthStartRefusedError"
  }
}

/**
 * The provider's callback failed its own checks: a signature that is missing or
 * wrong (Shopify signs its callback with the client secret), or a template
 * variable (the shop) other than the one the flow was started for. Nothing is
 * exchanged and nothing is stored.
 */
export class OAuthCallbackRefusedError extends Error {
  readonly code: string = "oauth_callback_refused"
  constructor(reason: string, message?: string) {
    super(
      message ?? `The provider's answer did not check out (${reason}), so nothing was connected.`,
    )
    this.name = "OAuthCallbackRefusedError"
  }
}

/** Most accounts a choice names; the rest are counted. */
const MAX_LISTED_ACCOUNT_CHOICES = 10

/**
 * The sign-in covered several accounts of a connection whose identifier is read
 * at a path (`identifierFromUserinfoPath`) and the flow was not started for one
 * of them: nothing is stored, and the person is told which accounts came back so
 * they connect again for the one they mean (a connect started with that
 * account's id as its hint, e.g. the agent's connect card for it). The kernel
 * never picks one silently.
 */
export class OAuthAccountChoiceError extends OAuthCallbackRefusedError {
  override readonly code = "account_choice_required"
  constructor(readonly accounts: UserinfoAccount[]) {
    const listed = accounts
      .slice(0, MAX_LISTED_ACCOUNT_CHOICES)
      .map((a) => (a.name ? `${a.name} (${a.id})` : a.id))
      .join(", ")
    const more =
      accounts.length > MAX_LISTED_ACCOUNT_CHOICES
        ? ` and ${accounts.length - MAX_LISTED_ACCOUNT_CHOICES} more`
        : ""
    super(
      "account_choice",
      `This sign-in covers ${accounts.length} accounts: ${listed}${more}. Nothing was connected: ` +
        "connect again for the one you mean (ask the agent to connect it by its id or name).",
    )
    this.name = "OAuthAccountChoiceError"
  }
}

/**
 * Verify a callback signed as `hmac-sha256-query` (Shopify): `hmac` is the hex
 * HMAC-SHA256, keyed with the client secret, of every other parameter sorted by
 * name and joined `name=value&...`. Constant-time; a missing or malformed hmac
 * fails.
 */
export function callbackHmacValid(
  params: Record<string, string | undefined>,
  clientSecret: string,
): boolean {
  const presented = params.hmac
  if (!presented || !/^[a-f0-9]{64}$/i.test(presented)) return false
  const message = Object.entries(params)
    .filter(
      (entry): entry is [string, string] =>
        entry[0] !== "hmac" && entry[0] !== "signature" && entry[1] !== undefined,
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&")
  const expected = createHmac("sha256", clientSecret).update(message).digest()
  return timingSafeEqual(Buffer.from(presented.toLowerCase(), "hex"), expected)
}

/** The callback did not come from the browser that started the flow. */
/** The callback's app is turned Off (or removed) for the workspace (S19). */
export class OAuthAppDisabledError extends Error {
  readonly code = "app_disabled"
  constructor(
    readonly appName: string,
    /** Where the callback sends the browser back: the app's manifest-derived settings page. */
    readonly settingsPath: string,
  ) {
    super(`The ${appName} app is turned off by your admin, so the connection was not completed.`)
    this.name = "OAuthAppDisabledError"
  }
}

export class OAuthBrowserMismatchError extends Error {
  readonly code = "oauth_browser_mismatch"
  constructor() {
    super(
      "This authorization was not started in this browser. Start the connection again from your own session.",
    )
    this.name = "OAuthBrowserMismatchError"
  }
}
/**
 * A PERSONAL connect whose account is already connected under another owner
 * (the organization, or another member). Only one active row may hold an
 * (app, connection, identifier) key, so storing the personal grant would have to
 * retire that row: a member's personal reconnect used to silently turn the org's
 * shared connection into their own, and every other member and agent lost it.
 * The callback refuses instead and says how to reconnect the shared one.
 */
export class ConnectionHeldByOtherOwnerError extends Error {
  readonly code = "connection_held_by_other_owner"
  constructor(
    readonly appName: string,
    readonly heldBy: "org" | "user",
    /**
     * Whether the person may administer the organization's connection. The
     * message only names what this person can do: a member cannot reconnect
     * or disconnect the shared one, so they are never told to.
     */
    readonly canConnectForOrg = false,
  ) {
    super(heldByOtherOwnerMessage(heldBy, canConnectForOrg))
    this.name = "ConnectionHeldByOtherOwnerError"
  }
}

/** The refusal in words the person it is shown to can act on. */
export function heldByOtherOwnerMessage(heldBy: "org" | "user", canConnectForOrg: boolean): string {
  if (heldBy === "org") {
    return canConnectForOrg
      ? "This account is already connected for the whole organization, so it was not connected as your own. Keep using the shared connection, or disconnect it in the app's settings first if it should be yours alone."
      : "This account is already connected for the whole organization, so it was not connected as your own. Connect a different account, or ask an admin if this one should be yours alone."
  }
  return canConnectForOrg
    ? "This account is already connected by another member, so it was not connected for you. Ask them to disconnect it first, connect a different account, or connect it for the organization."
    : "This account is already connected by another member, so it was not connected for you. Ask them to disconnect it first, or connect a different account."
}

/** Whether `userId` holds the admin scope of this connection (who may connect it for the org). */
async function mayConnectForOrg(
  tx: PrivilegedDb,
  args: { orgId: string; userId: string; appName: string; connectionName: string },
): Promise<boolean> {
  const { scopes } = await loadEffectivePermissions(tx, args.userId, args.orgId)
  return hasScope(connectionAdminScope(args.orgId, args.appName, args.connectionName), scopes)
}

/**
 * A personal connect the callback refused because another owner holds the
 * account: the person is told through the attention feed (a system alert,
 * kernel-translations.ts), not only by the redirect's transient message, which
 * is gone in seconds or lands in a popup that closes. Its own transaction: the
 * refused store rolled back. Best effort: a failed notice never changes the
 * refusal.
 */
async function announceConnectRefused(args: {
  orgId: string
  userId: string
  appName: string
  connectionName: string
  identifier: string
  message: string
}): Promise<void> {
  try {
    await withPrivilegedDb(args.orgId, "connect-refused-notice", (tx) =>
      tx.queueEvent({
        app: "kernel",
        entity: "connected_account",
        action: "refuse",
        entityId: randomUUID(),
        data: {
          orgId: args.orgId,
          appName: args.appName,
          connectionName: args.connectionName,
          ownerType: "user",
          ownerId: args.userId,
          identifier: args.identifier,
          reason: "connect_refused",
          notifyUserId: args.userId,
          summary: `${args.identifier} was not connected. ${args.message}`.slice(0, 500),
        },
        actorId: args.userId,
        actorType: "user",
        orgId: args.orgId,
        timestamp: new Date().toISOString(),
      }),
    )
  } catch (err) {
    log.warn({ err, orgId: args.orgId, appName: args.appName }, "Connect refusal notice failed")
  }
}

/**
 * An ORG credentials save met an account a MEMBER holds personally (same
 * identifier: a mailbox address). Taking it over disconnects that member's own
 * connection, so it is never silent: the save is refused with the member named
 * until the request says `takeOver: true` (the secret card asks first).
 */
export class ConnectionHeldByMemberError extends Error {
  readonly code = "connection_held_by_member"
  constructor(readonly memberName: string) {
    super(
      `This account is connected personally by ${memberName}. Saving it for the organization replaces ${memberName}'s personal connection: confirm to take it over.`,
    )
    this.name = "ConnectionHeldByMemberError"
  }
}

/**
 * A credential value its manifest field refuses (`credentialFields[].refusePattern`):
 * the wrong kind of secret was pasted. Thrown before anything is encrypted or
 * stored. The message is the manifest's and never holds the value.
 */
export class CredentialRefusedError extends Error {
  constructor(
    readonly code: string,
    readonly field: string,
    message: string,
    readonly messageKey?: string,
  ) {
    super(message)
    this.name = "CredentialRefusedError"
  }
}

/** Throws {@link CredentialRefusedError} when a declared field's value matches its `refusePattern`. */
export function assertCredentialsAccepted(
  connConfig: ReturnType<typeof connectionConfigRegistry.get>,
  credentials: Record<string, string>,
): void {
  for (const field of connConfig?.credentialFields ?? []) {
    const rule = field.refusePattern
    const value = credentials[field.name]
    if (!rule || typeof value !== "string") continue
    if (manifestRegExp(rule.pattern).test(value.trim())) {
      throw new CredentialRefusedError(rule.code, field.name, rule.message, rule.messageKey)
    }
  }
}

/** A personal row an org connection took over: retired, announced, never silent. */
export interface TakenOverAccount {
  id: string
  ownerType: string
  ownerId: string | null
  appName: string
  connectionName: string
  identifier: string
}

/**
 * Tell everyone a takeover retired someone's personal account: one
 * `connected_account:disconnect` per row (the audit log records it, the app's
 * disconnect handler stops its syncs), carrying `reason: "taken_over"` and a
 * summary the attention translator turns into a system alert for the former
 * owner (kernel-translations.ts). The rows must already be retired.
 */
export async function announceTakenOverAccounts(
  tx: RlsClient | PrivilegedDb,
  args: { orgId: string; actorId: string; rows: TakenOverAccount[] },
): Promise<void> {
  for (const row of args.rows) {
    await tx.queueEvent({
      app: "kernel",
      entity: "connected_account",
      action: "disconnect",
      entityId: row.id,
      data: {
        id: row.id,
        orgId: args.orgId,
        appName: row.appName,
        connectionName: row.connectionName,
        ownerType: row.ownerType,
        ownerId: row.ownerId,
        identifier: row.identifier,
        reason: "taken_over",
        summary: `Your ${row.appName} connection for ${row.identifier} is now the organization's: an admin connected it for everyone, so your personal connection was disconnected.`,
      },
      ...connectionEventActor(args.actorId),
      orgId: args.orgId,
      timestamp: new Date().toISOString(),
    })
  }
}

/**
 * Declarative OAuth URL template-variable normalization.
 *
 * When an app's OAuth authorization/token URL contains template variables
 * (e.g. `{shop}` for per-store providers), the app declares — in its manifest
 * connection config — how each variable's raw value must be normalized and
 * validated before substitution. This keeps app-specific knowledge (e.g.
 * Shopify's `.myshopify.com` shape) out of the kernel: the kernel applies the
 * declared rule generically.
 *
 * Rule fields:
 *  - `lowercase`:    lower-case the trimmed value first.
 *  - `pattern`:      a regex the (normalized) value MUST match, else the value
 *                    is rejected and `startOAuthFlow` throws. This is the
 *                    security boundary that prevents an attacker-controlled
 *                    value from redirecting the OAuth flow to an arbitrary host.
 *  - `appendSuffix`: appended when the value doesn't already end with it
 *                    (e.g. bare `acme` → `acme.myshopify.com`).
 *
 * A connection may also declare `identifierVar`: the template variable whose
 * normalized value is the canonical `connected_accounts.identifier` (preferring
 * the provider's authoritative callback echo of that param).
 */
export interface OAuthTemplateVarRule {
  lowercase?: boolean
  pattern: string
  appendSuffix?: string
}

/**
 * Apply a declarative normalization rule to a raw template-variable value.
 * Returns the canonical value, or `null` if it fails validation (rejected).
 */
function applyTemplateVarRule(raw: string, rule: OAuthTemplateVarRule): string | null {
  let value = raw.trim()
  if (rule.lowercase) value = value.toLowerCase()
  let re: RegExp
  try {
    re = manifestRegExp(rule.pattern)
  } catch {
    return null
  }
  if (!re.test(value)) return null
  if (rule.appendSuffix && !value.endsWith(rule.appendSuffix)) {
    value = `${value}${rule.appendSuffix}`
  }
  return value
}

/**
 * Substitute all occurrences of `{variableName}` in a URL template string.
 */
function substituteUrlTemplateVariables(url: string, variables: Record<string, string>): string {
  let result = url
  for (const [name, value] of Object.entries(variables)) {
    result = result.replaceAll(`{${name}}`, value)
  }
  return result
}

/**
 * Extract the set of template variable names present in a URL string,
 * e.g. `{shop}` → `["shop"]`.
 */
function extractTemplateVariables(url: string): string[] {
  const matches = url.match(/\{([^}]+)\}/g) ?? []
  return matches.map((m) => m.slice(1, -1))
}

/**
 * Resolve all template variables in the authorization and token URLs for the
 * given connection, applying the per-variable normalization rules declared in
 * the connection's manifest config. Throws if a required variable is missing,
 * if its value is rejected by the declared rule's pattern, or if the variable
 * has no declared rule at all.
 *
 * A template variable with no `templateVars[var]` rule is REJECTED rather than
 * substituted raw: the validating `pattern` is the security boundary that
 * prevents a caller-supplied value (e.g. `shop`) from injecting an attacker
 * host into the authorization/token URL (`shop=evil.com/` →
 * `https://evil.com/.myshopify.com/...`), which would redirect the OAuth
 * code/PKCE/client_secret exchange. `validateOutboundUrl` only blocks private
 * networks, so it cannot catch a public attacker host; the rule must.
 */
function resolveOAuthUrlTemplateVariables(
  connectionName: string,
  authorizationUrl: string,
  tokenUrl: string,
  rawVariables: Record<string, string | undefined>,
  templateVarRules: Record<string, OAuthTemplateVarRule> | undefined,
): Record<string, string> {
  const varNames = new Set([
    ...extractTemplateVariables(authorizationUrl),
    ...extractTemplateVariables(tokenUrl),
  ])
  if (varNames.size === 0) return {}

  const resolved: Record<string, string> = {}

  for (const varName of varNames) {
    const raw = rawVariables[varName]
    if (!raw) {
      throw new OAuthStartRefusedError(
        "missing_value",
        `Connection "${connectionName}" requires a "${varName}" value in the OAuth flow`,
      )
    }
    // A template variable substituted into the auth/token URL MUST have a
    // declared validation rule — without one the kernel cannot prove the value
    // doesn't redirect the OAuth flow to an attacker host. Reject rather than
    // substitute the raw value.
    const rule = templateVarRules?.[varName]
    if (!rule) {
      throw new Error(
        `Connection "${connectionName}" uses template variable "${varName}" in its OAuth URL ` +
          `but declares no templateVars rule for it — cannot validate the substituted value`,
      )
    }
    const canonical = applyTemplateVarRule(raw, rule)
    if (!canonical) {
      throw new OAuthStartRefusedError(
        "invalid_value",
        `Invalid value for "${varName}" in connection "${connectionName}": "${raw}"`,
      )
    }
    resolved[varName] = canonical
  }
  return resolved
}

/**
 * The token URL a refresh posts to. A per-store URL (`https://{shop}/...`) is
 * filled from the account's identifier, the value of the connection's
 * `identifierVar` that the authenticated start validated, re-checked here with
 * the same rule. Null when the URL names any other variable, or the identifier
 * no longer passes the rule: nothing is ever substituted raw.
 */
function refreshTokenUrl(
  connConfig: {
    tokenUrl?: string
    identifierVar?: string
    templateVars?: Record<string, OAuthTemplateVarRule>
  },
  identifier: string | null,
): string | null {
  const url = connConfig.tokenUrl
  if (!url) return null
  const names = extractTemplateVariables(url)
  if (names.length === 0) return url
  const variable = connConfig.identifierVar
  if (!variable || !identifier || names.some((n) => n !== variable)) return null
  const rule = connConfig.templateVars?.[variable]
  const canonical = rule ? applyTemplateVarRule(identifier, rule) : null
  return canonical ? substituteUrlTemplateVariables(url, { [variable]: canonical }) : null
}

async function validateConnectionEndpoint(url: string, standIn = false): Promise<void> {
  // Only the test stand-in provider (below) may be a local http address; a
  // manifest's own endpoints never are, in tests too.
  await validateOutboundUrl(url, { requireHttps: true, allowPrivateHostsInTest: standIn })
}

/**
 * A test stack's stand-in OAuth provider (`LIAISON_TEST_OAUTH_PROVIDER`, read
 * only when NODE_ENV is test): every OAuth connection authorizes at its
 * `/authorize` and exchanges at its `/token`, so a browser test drives a real
 * consent round trip without reaching Google or Shopify. Never read elsewhere.
 */
export function testOAuthProvider(
  nodeEnv: string = env.NODE_ENV,
  value: string | undefined = process.env.LIAISON_TEST_OAUTH_PROVIDER,
): string | null {
  if (nodeEnv !== "test") return null
  const base = value?.trim()
  return base ? base.replace(/\/+$/, "") : null
}

type ConnectedAccount = typeof connectedAccounts.$inferSelect

type ConnectionLookupActor = "user" | "system"

/**
 * Gate for the privileged org-connection fallback. The fallback re-opens a
 * privileged tx with `set_config('app.current_org_id', orgId::uuid)`, so it can
 * only run for a real (UUID) org id. Unit tests pass mock org ids like "org-1"
 * and a stubbed `tx`; for those the RLS read is the final answer.
 */
function isRealOrgId(orgId: string): boolean {
  return UUID_RE.test(orgId)
}

/**
 * Connection lookup accepts either an RLS-scoped or privileged DB handle. The
 * "system" branch ignores `tx` entirely (re-opens its own privileged tx); the
 * "user" branches use `tx` for `.select()` / `.execute()`, both of which are
 * available on either branded type. This lets background workers — which only
 * have a privileged handle — call through without an unsafe cast.
 */
async function loadConnectedAccounts(
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  userId: string,
  appName: string,
  actorType: ConnectionLookupActor,
  conditions: Parameters<typeof and>,
  identifier?: string,
): Promise<ConnectedAccount[]> {
  // Every LIMIT 1 below is ORDERED. Without an ORDER BY, an org that somehow
  // carries two active rows for the same connection (pre-fix duplicates from the
  // old insert-on-reconnect path, or a user- and org-owned pair) got whichever
  // row Postgres felt like returning — so a freshly entered credential could
  // silently lose to a dead one. Newest-updated wins, which is always the
  // credential the operator entered last.
  // The privileged reads below run on `tx` when the caller already holds a
  // privileged transaction of this org (a CLI step, a sync job): a second
  // privileged slot taken under it is the nested shape that deadlocks a full pool.
  if (actorType === "system") {
    return withPrivilegedReusing(
      tx,
      orgId,
      "connected-account-runtime-load",
      async (privilegedTx) =>
        privilegedTx
          .select()
          .from(connectedAccounts)
          .where(and(...conditions))
          .orderBy(desc(connectedAccounts.updatedAt), desc(connectedAccounts.createdAt))
          .limit(1),
    )
  }

  if (appName === "mail") {
    return loadMailAuthorizedConnectedAccounts(tx, orgId, userId, conditions, identifier)
  }

  // RLS-scoped read first — this is what user-owned connections expect (and what
  // the unit-test mock tx returns).
  const rlsRows = await tx
    .select()
    .from(connectedAccounts)
    .where(and(...conditions))
    .orderBy(desc(connectedAccounts.updatedAt), desc(connectedAccounts.createdAt))
    .limit(1)
  if (rlsRows.length > 0 || !isRealOrgId(orgId)) return rlsRows

  // Org-owned app connections (e.g. Shopify's "shop") are deliberately invisible
  // to RLS — the `connected_accounts` SELECT policy only exposes org-owned rows
  // for `app_name='kernel'`. When the RLS read finds nothing, the kernel resolves
  // the app's OWN org connection on its behalf via the privileged path, scoped to
  // (orgId, appName, connectionName) + owner_type='org'.
  return withPrivilegedReusing(tx, orgId, "connected-account-app-load", (ptx) =>
    ptx
      .select()
      .from(connectedAccounts)
      .where(and(...conditions, eq(connectedAccounts.ownerType, "org")))
      .orderBy(desc(connectedAccounts.updatedAt), desc(connectedAccounts.createdAt))
      .limit(1),
  )
}

async function loadMailAuthorizedConnectedAccounts(
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  _userId: string,
  conditions: Parameters<typeof and>,
  identifier?: string,
): Promise<ConnectedAccount[]> {
  const appMailSchema = quoteIdent(schemaRef("app_mail"))
  const accountRows = extractRows<{ connected_account_id: string }>(
    await tx.execute(drizzleSql`
      SELECT connected_account_id
      FROM ${drizzleSql.raw(`${appMailSchema}.accounts`)}
      WHERE org_id = ${orgId}
        AND disconnected_at IS NULL
        ${identifier ? drizzleSql`AND email_address = ${identifier}` : drizzleSql``}
      ORDER BY created_at DESC
      LIMIT 1
    `),
  )
  const connectedAccountId = accountRows[0]?.connected_account_id
  if (!connectedAccountId) return []

  return withPrivilegedReusing(
    tx,
    orgId,
    "connected-account-mail-authorized-load",
    async (privilegedTx) =>
      privilegedTx
        .select()
        .from(connectedAccounts)
        .where(and(...conditions, eq(connectedAccounts.id, connectedAccountId)))
        .limit(1),
  )
}

/** A web-app page of the org (orgAppBaseUrl); with no org known, of the instance's web origin. */
async function getFrontendRedirectUrl(
  orgId: string | null,
  pathname: string,
  params?: URLSearchParams,
): Promise<string> {
  const url = new URL(pathname, await orgAppBaseUrl(orgId))
  // Merged into the path's own query: a connector's `?open=<app>` survives an error.
  for (const [k, v] of params ?? []) url.searchParams.set(k, v)
  return url.toString()
}

/** Safe DTO returned to clients — never includes encrypted secret columns. */
export type ConnectedAccountDto = {
  id: string
  orgId: string
  appName: string
  connectionName: string
  ownerType: "user" | "org"
  ownerId: string | null
  identifier: string
  displayName: string | null
  providerType: "oauth2" | "credentials"
  status: string
  statusMessage: string | null
  tokenExpiresAt: Date | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
}

function redact(account: ConnectedAccount): ConnectedAccountDto {
  return {
    id: account.id,
    orgId: account.orgId,
    appName: account.appName,
    connectionName: account.connectionName,
    ownerType: account.ownerType as "user" | "org",
    ownerId: account.ownerId,
    identifier: account.identifier,
    displayName: account.displayName,
    providerType: account.providerType as "oauth2" | "credentials",
    status: account.status,
    statusMessage: account.statusMessage,
    tokenExpiresAt: account.tokenExpiresAt,
    createdBy: account.createdBy,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  }
}

export function validateAccountStatus(account: {
  status: string
  statusMessage?: string | null
}): void {
  if (account.status === "disconnected") {
    throw new Error("Account is disconnected")
  }
  if (account.status === "error") {
    throw new Error(
      `Account requires re-authorization: ${account.statusMessage ?? "unknown error"}`,
    )
  }
}

/**
 * True for errors meaning the connected account isn't authorized/ready yet — no
 * token stored, disconnected, or needs re-authorization. These are EXPECTED,
 * recoverable account states (a mailbox pending OAuth, a revoked grant), not
 * server faults. Background callers (e.g. the gmail sync jobs) should warn + skip
 * on these rather than logging an error + retrying, which would otherwise pollute
 * the server-error budget for every un-authed account.
 */
export function isAccountNotReadyError(err: unknown): boolean {
  const msg = (err as { message?: string } | null)?.message ?? ""
  return /no access token stored|account is disconnected|requires re-authorization|connection_credentials_missing/i.test(
    msg,
  )
}

// Refresh slightly BEFORE the token actually expires so an in-flight Gmail call
// never races the boundary.
const TOKEN_REFRESH_SKEW_MS = 2 * 60 * 1000

/**
 * Renew an Instagram-style long-lived token that has NO refresh_token: present
 * the CURRENT access token to the connection's refresh endpoint
 * (`GET refreshTokenUrl?grant_type=ig_refresh_token&access_token=<current>`),
 * which returns a fresh 60-day token. Persist the new token + expiry. Returns
 * null (and flags the account for re-connect on a 4xx) when it can't be renewed.
 * No client secret is involved -- the access token authenticates the renewal.
 */
async function refreshViaAccessToken(
  account: ConnectedAccount,
  connConfig: NonNullable<ReturnType<typeof connectionConfigRegistry.get>>,
): Promise<string | null> {
  if (!account.accessTokenEncrypted) return null
  const refreshUrl = connConfig.refreshTokenUrl ?? connConfig.tokenUrl
  if (!refreshUrl) return null
  const encKey = process.env.ENCRYPTION_KEY ?? ENCRYPTION_KEY
  const current = decryptSecret(
    account.accessTokenEncrypted,
    encKey,
    CryptoContext.connectedAccountAccessToken,
  )
  const url = `${refreshUrl}?${new URLSearchParams({
    grant_type: connConfig.refreshGrantType ?? "ig_refresh_token",
    access_token: current,
  }).toString()}`

  let res: Response
  try {
    res = await fetchWithRedirectValidation(
      url,
      { method: "GET", headers: { Accept: "application/json" } },
      { requireHttps: true, allowPrivateHostsInTest: true },
    )
  } catch (err) {
    log.warn(
      {
        orgId: account.orgId,
        appName: account.appName,
        connectionName: account.connectionName,
        err: (err as Error).message,
      },
      "long-lived token self-refresh request failed",
    )
    return null
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    log.warn(
      {
        orgId: account.orgId,
        appName: account.appName,
        connectionName: account.connectionName,
        status: res.status,
        body: body.slice(0, 256),
      },
      "long-lived token self-refresh failed",
    )
    // A rejected long-lived token (expired past 60 days, or revoked) needs a
    // human re-connect -- flag it so the operator/UI can see it.
    if (res.status >= 400 && res.status < 500) {
      await withPrivilegedDb(account.orgId, "oauth-selfrefresh-mark-error", async (db) => {
        await db
          .update(connectedAccounts)
          .set({
            status: "error",
            statusMessage: "Authorization expired -- reconnect required",
            updatedAt: new Date(),
          })
          .where(eq(connectedAccounts.id, account.id))
      })
    }
    return null
  }
  const tokens = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!tokens.access_token) return null
  const newToken = tokens.access_token
  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null
  const displayName = await fetchAccountDisplayName(connConfig, newToken, {
    orgId: account.orgId,
    appName: account.appName,
    connectionName: account.connectionName,
  })
  await withPrivilegedDb(account.orgId, "oauth-selfrefresh-persist", async (db) => {
    await db
      .update(connectedAccounts)
      .set({
        accessTokenEncrypted: encryptSecret(
          newToken,
          encKey,
          CryptoContext.connectedAccountAccessToken,
        ),
        // Renewal re-reads the account name, so a row stored without one heals.
        ...(displayName ? { displayName } : {}),
        tokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, account.id))
  })
  log.info(
    { orgId: account.orgId, appName: account.appName, connectionName: account.connectionName },
    "long-lived token self-refreshed",
  )
  return newToken
}

/**
 * Refresh an OAuth2 access token using the stored refresh token, persist the new
 * token + expiry, and return it. Returns null when the account cannot be
 * refreshed (no refresh token, or no client config / token URL available).
 *
 * Liaison connection access tokens are short-lived (Google ~1h) but the read
 * path previously returned the STORED token verbatim with no refresh, so once
 * the initial token lapsed every Gmail/mail sync 401'd forever. This closes that
 * gap. A provider rejection of the refresh token (Google 400 invalid_grant ==
 * revoked / consent withdrawn) is unrecoverable without re-consent, so the
 * account is marked `error` (needs re-authorization) and null is returned.
 */
async function refreshOAuthAccessToken(account: ConnectedAccount): Promise<string | null> {
  const connConfig = connectionConfigRegistry.get([
    account.orgId,
    account.appName,
    account.connectionName,
  ])
  // Instagram-style self-refresh: the long-lived token has NO refresh_token and
  // renews by presenting itself (no client secret) -- handled separately.
  if (connConfig?.refreshUsesAccessToken) {
    return refreshViaAccessToken(account, connConfig)
  }
  if (!account.refreshTokenEncrypted) return null
  const tokenUrl = connConfig ? refreshTokenUrl(connConfig, account.identifier) : null
  if (!tokenUrl) return null

  // The client that minted the tokens, never whichever client is current: a
  // refresh token only works with the client it was issued to.
  const provider = await resolveRefreshClient(account)
  if (!provider) {
    log.warn(
      {
        orgId: account.orgId,
        appName: account.appName,
        connectionName: account.connectionName,
        oauthClientSource: account.oauthClientSource,
      },
      "OAuth refresh: the client that minted this account is gone; reconnect required",
    )
    await withPrivilegedDb(account.orgId, "oauth-refresh-mark-client-gone", async (db) => {
      await db
        .update(connectedAccounts)
        .set({
          status: "error",
          statusMessage: MINTING_CLIENT_GONE_MESSAGE,
          updatedAt: new Date(),
        })
        .where(eq(connectedAccounts.id, account.id))
    })
    return null
  }

  const encKey = process.env.ENCRYPTION_KEY ?? ENCRYPTION_KEY
  const refreshToken = decryptSecret(
    account.refreshTokenEncrypted,
    encKey,
    CryptoContext.connectedAccountRefreshToken,
  )

  let res: Response
  try {
    res = await fetchWithRedirectValidation(
      tokenUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
        }).toString(),
      },
      { requireHttps: true, allowPrivateHostsInTest: true },
    )
  } catch (err) {
    log.warn(
      {
        orgId: account.orgId,
        appName: account.appName,
        connectionName: account.connectionName,
        err: (err as Error).message,
      },
      "OAuth token refresh request failed",
    )
    return null
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    log.warn(
      {
        orgId: account.orgId,
        appName: account.appName,
        connectionName: account.connectionName,
        status: res.status,
        body: body.slice(0, 256),
      },
      "OAuth token refresh failed",
    )
    // 400 invalid_grant / 401 == the refresh token is revoked or invalid; this
    // needs a human re-consent. Flag the account so the UI/operator can see it.
    if (res.status === 400 || res.status === 401) {
      await withPrivilegedDb(account.orgId, "oauth-refresh-mark-error", async (db) => {
        await db
          .update(connectedAccounts)
          .set({
            status: "error",
            statusMessage: "Authorization expired -- reconnect required",
            updatedAt: new Date(),
          })
          .where(eq(connectedAccounts.id, account.id))
      })
    }
    return null
  }

  const tokens = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
  }
  if (!tokens.access_token) return null
  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null
  const displayName = await fetchAccountDisplayName(connConfig, tokens.access_token, {
    orgId: account.orgId,
    appName: account.appName,
    connectionName: account.connectionName,
  })
  await withPrivilegedDb(account.orgId, "oauth-refresh-persist", async (db) => {
    await db
      .update(connectedAccounts)
      .set({
        accessTokenEncrypted: encryptSecret(
          tokens.access_token,
          encKey,
          CryptoContext.connectedAccountAccessToken,
        ),
        // Renewal re-reads the account name, so a row stored without one heals.
        ...(displayName ? { displayName } : {}),
        // Google usually omits a new refresh_token on refresh; persist one only
        // if the provider rotated it (never null out the existing one).
        ...(tokens.refresh_token
          ? {
              refreshTokenEncrypted: encryptSecret(
                tokens.refresh_token,
                encKey,
                CryptoContext.connectedAccountRefreshToken,
              ),
            }
          : {}),
        tokenExpiresAt: expiresAt,
        updatedAt: new Date(),
      })
      .where(eq(connectedAccounts.id, account.id))
  })
  log.info(
    { orgId: account.orgId, appName: account.appName, connectionName: account.connectionName },
    "OAuth access token refreshed",
  )
  return tokens.access_token
}

export async function getTokenFromAccount(
  account: ConnectedAccount,
  encKey: string = ENCRYPTION_KEY,
): Promise<string> {
  validateAccountStatus(account)
  if (!account.accessTokenEncrypted) throw new Error("No access token stored")
  // Refresh an expired (or about-to-expire) OAuth access token before returning
  // it. Without this the stored short-lived token keeps 401ing every sync once it
  // lapses. Only OAuth2 accounts with a stored refresh token + known expiry are
  // eligible; credential connections and tokens with no expiry pass through.
  if (account.providerType === "oauth2" && account.tokenExpiresAt) {
    const connConfig = connectionConfigRegistry.get([
      account.orgId,
      account.appName,
      account.connectionName,
    ])
    const selfRefresh = connConfig?.refreshUsesAccessToken === true
    const canRefresh = Boolean(account.refreshTokenEncrypted) || selfRefresh
    // Long-lived tokens (Instagram, 60 days) set a WIDE window so any routine
    // sync in the tail renews them; standard tokens default to the ~2 min skew.
    const refreshWindow = connConfig?.refreshWindowMs ?? TOKEN_REFRESH_SKEW_MS
    const expiresAtMs = account.tokenExpiresAt.getTime()
    const now = Date.now()
    if (canRefresh && expiresAtMs <= now + refreshWindow) {
      const refreshed = await refreshOAuthAccessToken(account)
      if (refreshed) return refreshed
      // Refresh failed. Only fatal if the token is actually (near-)expired; a
      // failed EARLY refresh (wide window, token still valid) falls through to
      // the still-good stored token and retries on the next call.
      if (expiresAtMs <= now + TOKEN_REFRESH_SKEW_MS) {
        throw new Error("Account requires re-authorization: token refresh failed")
      }
    }
  }
  return decryptSecret(
    account.accessTokenEncrypted,
    encKey,
    CryptoContext.connectedAccountAccessToken,
  )
}

/**
 * A credentials connection that only exists so the kernel mints an inbound
 * webhook signing secret: it declares `webhookSecretConfigKey`, no egress domain
 * (the app can never present the stored fields to anyone's API) and no password
 * field (nothing a third party issued is asked for). Storing one holds no real
 * credential, so the demo lockdown lets it through.
 */
export function isInboundOnlyConnection(
  connConfig: ReturnType<typeof connectionConfigRegistry.get>,
): boolean {
  if (!connConfig || connConfig.type !== "credentials") return false
  if (!connConfig.webhookSecretConfigKey) return false
  if (connConfig.allowedDomains.length > 0) return false
  return (connConfig.credentialFields ?? []).every((field) => field.type !== "password")
}

/**
 * A `multiInstance` credentials connection holds several org-owned accounts of
 * the same (app, connection), one per identifier; the identifier is the
 * account's slug, chosen by the admin, never derived from a credential.
 */
export const MULTI_INSTANCE_IDENTIFIER_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

export type MultiInstanceCredentialCheckResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 409 | 422; message: string }

/**
 * App-side admission check for a multiInstance credential post (e.g. "an
 * adapter exists for this identifier and these are the fields its auth type
 * needs"). Registered by the kernel module that owns the app's host side.
 */
export type MultiInstanceCredentialCheck = (input: {
  orgId: string
  identifier: string
  credentials: Record<string, string>
}) => Promise<MultiInstanceCredentialCheckResult>

const multiInstanceChecks = new Map<string, MultiInstanceCredentialCheck>()

/** Register (or with null, remove) the admission check for one multiInstance connection. */
export function registerMultiInstanceCredentialCheck(
  appName: string,
  connectionName: string,
  check: MultiInstanceCredentialCheck | null,
): void {
  const key = `${appName}\0${connectionName}`
  if (check) multiInstanceChecks.set(key, check)
  else multiInstanceChecks.delete(key)
}

/**
 * A check chosen by what an app's manifest declares rather than by its name
 * (the platform-held API connections: any app's connection with an `api` block).
 */
export type MultiInstanceCredentialResolver = (
  orgId: string,
  appName: string,
  connectionName: string,
) => MultiInstanceCredentialCheck | undefined

const multiInstanceResolvers: MultiInstanceCredentialResolver[] = []

export function registerMultiInstanceCredentialResolver(
  resolver: MultiInstanceCredentialResolver,
): void {
  if (!multiInstanceResolvers.includes(resolver)) multiInstanceResolvers.push(resolver)
}

export function getMultiInstanceCredentialCheck(
  orgId: string,
  appName: string,
  connectionName: string,
): MultiInstanceCredentialCheck | undefined {
  const named = multiInstanceChecks.get(`${appName}\0${connectionName}`)
  if (named) return named
  for (const resolve of multiInstanceResolvers) {
    const check = resolve(orgId, appName, connectionName)
    if (check) return check
  }
  return undefined
}

export async function createCredentialConnection(
  // Accepts an RLS-scoped OR a privileged handle (mirrors `getCredentialsForConnection`
  // / `getTokenForConnection`). User-owned connections pass an `RlsClient`; ORG-owned
  // connections (owner_type='org', owner_id=null) MUST pass a `PrivilegedDb` — the
  // `connected_accounts_insert` RLS policy's WITH CHECK + the org-owned SELECT policy
  // (which only exposes `owner_type='org' AND app_name='kernel'`) make a `RETURNING`
  // insert of an org-owned non-kernel row impossible under `liaison_rls`. The body uses
  // only `.insert`/`.select`/`.update`/`.execute`/`.queueEvent`, all present on both.
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  userId: string,
  appName: string,
  connectionName: string,
  input: {
    identifier: string
    credentials: Record<string, string>
    displayName?: string
    ownerType?: "user" | "org"
    /** An org save may replace a member's personal account of the same identifier. */
    takeOver?: boolean
  },
): Promise<ConnectedAccountDto> {
  // A demo org must not be able to store a real third-party credential: the
  // whole point of the demo is that its connectors are fixtures. Checked in the
  // service rather than in the route so the sandbox and any future caller are
  // covered by the same line. No-op unless this box is the demo instance.
  // An inbound-only connection is exempt: it holds no third-party credential.
  if (!isInboundOnlyConnection(connectionConfigRegistry.get([orgId, appName, connectionName]))) {
    await assertDemoEgressAllowed(orgId, "connector_credentials", tx)
  }
  // The wrong kind of secret (a field's `refusePattern`) is refused before it
  // is encrypted or stored, so nothing of it is kept anywhere.
  assertCredentialsAccepted(
    connectionConfigRegistry.get([orgId, appName, connectionName]),
    input.credentials,
  )
  // A mailbox outside the org's allowed domains is refused (mail-domains.ts).
  // Read on this transaction: no second privileged connection.
  await assertMailboxAllowed(
    orgId,
    connectionName,
    input.identifier,
    input.credentials.username,
    tx,
  )

  // Resolve the encryption key from the LIVE env (falling back to the
  // module-load capture) so the encrypt-at-write side here uses the SAME key the
  // decrypt-at-read side (`decryptConnectionConfigValue`, `getCredentialsForConnection`)
  // resolves — otherwise a key set after module load (tests; an env rotation)
  // would write ciphertext the read path's key cannot authenticate (AES-GCM tag
  // failure). Mirrors `getCredentialsForConnection`'s `process.env.ENCRYPTION_KEY ?? ENCRYPTION_KEY`.
  const encKey = process.env.ENCRYPTION_KEY ?? ENCRYPTION_KEY
  const resolvedOwnerType = input.ownerType ?? "user"
  const resolvedOwnerId = resolvedOwnerType === "org" ? null : userId
  const multiInstance =
    connectionConfigRegistry.get([orgId, appName, connectionName])?.multiInstance === true
  if (multiInstance) {
    if (resolvedOwnerType !== "org") {
      throw new Error(`Connection "${appName}:${connectionName}" is org-owned only (multiInstance)`)
    }
    if (!MULTI_INSTANCE_IDENTIFIER_RE.test(input.identifier)) {
      throw new Error(
        `Invalid identifier for multiInstance connection "${appName}:${connectionName}": a lowercase slug of at most 40 characters`,
      )
    }
  }

  const encryptedCredentials = encryptSecret(
    JSON.stringify(input.credentials),
    encKey,
    CryptoContext.connectedAccountCredentials,
  )

  // RE-CONNECT REPLACES, it never duplicates. Re-entering credentials for a
  // connection that already exists (the normal reason anyone opens this form: a
  // revoked or expired token) used to plain-INSERT a second row for the same
  // (org, app, connection, owner). Nothing then chose deterministically between
  // them — the lookup takes LIMIT 1 — so the operator pasted a working token and
  // got a coin flip between it and the dead one. Prod hit exactly this with the
  // GitLab PAT (2026-08-02): the identifier of a credentials connection is
  // derived from the credential payload, so a re-connect could not even land on
  // the same identifier to be recognised as the same account.
  //
  // Keyed on (org, app, connection, ownerType, ownerId) — NOT the identifier,
  // which is exactly the field a credential rotation is allowed to change. The
  // row id is preserved so anything referencing this account keeps working, and
  // a previously disconnected account is reactivated rather than shadowed.
  //
  // A multiInstance connection adds the identifier to the key: its identifier
  // is the account's admin-chosen slug, so each slug is its own account and a
  // re-post replaces only that one. So does an ORG mailbox: an org holds several
  // shared mailboxes and its address names each one, while a person's own
  // mailbox stays one row that a re-connect rotates.
  //
  // A mailbox's address is the same mailbox in any case (the cap and the CLI
  // already compare it lowercased), so its matches here ignore case. A match
  // keeps the row's stored spelling: Mail's account and its token lookups hold
  // that spelling and compare it exactly.
  const isMailbox = isMailboxConnection(connectionName)
  const keyedByAddress = isMailbox && resolvedOwnerId === null
  const sameIdentifier = isMailbox
    ? drizzleSql`lower(${connectedAccounts.identifier}) = lower(${input.identifier})`
    : eq(connectedAccounts.identifier, input.identifier)
  const existing = await tx
    .select({
      id: connectedAccounts.id,
      status: connectedAccounts.status,
      identifier: connectedAccounts.identifier,
    })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.orgId, orgId),
        eq(connectedAccounts.appName, appName),
        eq(connectedAccounts.connectionName, connectionName),
        eq(connectedAccounts.ownerType, resolvedOwnerType),
        resolvedOwnerId === null
          ? isNull(connectedAccounts.ownerId)
          : eq(connectedAccounts.ownerId, resolvedOwnerId),
        ...(multiInstance || keyedByAddress ? [sameIdentifier] : []),
      ),
    )
    .limit(1)
  const storedIdentifier =
    keyedByAddress && existing[0]?.identifier ? existing[0].identifier : input.identifier

  // The org's mailbox cap (modules/org/caps.ts), under its mailboxes lock: a
  // new mailbox, or a disconnected one coming back, must fit. Re-entering the
  // credentials of a connected mailbox is an update and is never refused.
  if (isMailbox && (!existing[0] || existing[0].status === "disconnected")) {
    await assertMailboxRoom(tx, orgId, input.identifier)
  }

  // ONE ACTIVE ACCOUNT PER IDENTIFIER, WHOEVER OWNS IT (a credentials
  // connection never declares `orgAndPersonalCoexist`), kept here in code: the
  // unique index (migration 0239) is keyed on the owner type too. Another
  // owner's active row for this identifier used to reach the index and answer a
  // raw 500. Now:
  //  - a personal save over an account someone else holds is refused with
  //    ConnectionHeldByOtherOwnerError (409);
  //  - an org save over a MEMBER's personal account is refused with that member
  //    named (ConnectionHeldByMemberError, 409) unless `takeOver` says so; a
  //    takeover retires the row (secrets cleared) and announces it
  //    (announceTakenOverAccounts). The saver's own personal account of the
  //    same identifier is theirs to replace.
  // A personal save reads privileged: a member's RLS context cannot see an
  // org-owned row, the very one to find.
  const readHolders = (db: RlsClient | PrivilegedDb) =>
    db
      .select({
        id: connectedAccounts.id,
        identifier: connectedAccounts.identifier,
        ownerType: connectedAccounts.ownerType,
        ownerId: connectedAccounts.ownerId,
        ownerName: users.name,
      })
      .from(connectedAccounts)
      .leftJoin(users, eq(users.id, connectedAccounts.ownerId))
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, appName),
          eq(connectedAccounts.connectionName, connectionName),
          sameIdentifier,
          eq(connectedAccounts.status, "active"),
        ),
      )
      .limit(50)
  // An org save runs on the privileged handle already (see the signature).
  const holders =
    resolvedOwnerType === "org"
      ? await readHolders(tx)
      : await withPrivilegedReusing(tx, orgId, "credential-connection-holders", (ptx) =>
          readHolders(ptx),
        )
  const foreign = holders.filter(
    (h) =>
      h.id !== existing[0]?.id &&
      !(h.ownerType === resolvedOwnerType && (h.ownerId ?? null) === resolvedOwnerId),
  )
  if (foreign.length > 0) {
    if (resolvedOwnerType === "user") {
      const held = foreign.find((h) => h.ownerType === "org") ?? foreign[0]
      const canConnectForOrg = await withPrivilegedReusing(
        tx,
        orgId,
        "credential-connection-held-by",
        (ptx) => mayConnectForOrg(ptx, { orgId, userId, appName, connectionName }),
      )
      throw new ConnectionHeldByOtherOwnerError(
        appName,
        held?.ownerType === "org" ? "org" : "user",
        canConnectForOrg,
      )
    }
    const otherMember = foreign.find((h) => h.ownerType === "user" && h.ownerId !== userId)
    if (otherMember && input.takeOver !== true) {
      throw new ConnectionHeldByMemberError(otherMember.ownerName ?? "another member")
    }
    await tx
      .update(connectedAccounts)
      .set({
        status: "disconnected",
        disconnectedAt: new Date(),
        updatedAt: new Date(),
        ...CLEARED_SECRETS,
      })
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          inArray(
            connectedAccounts.id,
            foreign.map((h) => h.id),
          ),
        ),
      )
    await announceTakenOverAccounts(tx, {
      orgId,
      actorId: userId,
      rows: foreign.map((h) => ({
        id: h.id,
        ownerType: h.ownerType,
        ownerId: h.ownerId,
        appName,
        connectionName,
        identifier: h.identifier,
      })),
    })
  }

  const [account] = existing[0]
    ? await tx
        .update(connectedAccounts)
        .set({
          providerType: "credentials",
          identifier: storedIdentifier,
          displayName: input.displayName ?? null,
          credentialsEncrypted: encryptedCredentials,
          status: "active",
          statusMessage: null,
          disconnectedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(connectedAccounts.id, existing[0].id))
        .returning()
    : await tx
        .insert(connectedAccounts)
        .values({
          orgId,
          appName,
          connectionName,
          ownerType: resolvedOwnerType,
          ownerId: resolvedOwnerId,
          providerType: "credentials",
          identifier: input.identifier,
          displayName: input.displayName ?? null,
          credentialsEncrypted: encryptedCredentials,
          status: "active",
          createdBy: userId,
        })
        .returning()

  // Webhook-secret mint (symmetric with the OAuth `clientSecretConfigKey` mirror).
  // A credentials connection has no OAuth client secret to mirror, so when the
  // manifest connection declares `webhookSecretConfigKey` the kernel generates a
  // crypto-random secret and merges it into `apps.config` (never clobbering other
  // keys). It is REUSED on re-connect so existing subscriptions keep verifying.
  // The connect handler reads it via `ctx.config.get` to register subscriptions;
  // the sandboxed verifier reads the same value via `bridge.config_get`.
  const connConfig = connectionConfigRegistry.get([orgId, appName, connectionName])
  if (connConfig?.webhookSecretConfigKey) {
    const key = connConfig.webhookSecretConfigKey
    const existing = await tx
      .select({ config: appsTable.config })
      .from(appsTable)
      .where(and(eq(appsTable.orgId, orgId), eq(appsTable.name, appName)))
      .limit(1)
    const currentConfig = (existing[0]?.config ?? {}) as Record<string, unknown>
    if (!currentConfig[key]) {
      const secret = randomBytes(32).toString("hex")
      // Encrypt at rest (symmetric with the OAuth `clientSecretConfigKey` mirror
      // above): the minted webhook secret is stored as ciphertext, decrypted only
      // at the two `config_get` bridges right before the verifier/connect handler
      // needs the plaintext. The ENCRYPTION_KEY never enters the sandbox.
      const overlayJson = JSON.stringify({
        [key]: encryptSecret(secret, encKey, CryptoContext.appConfigConnectionSecret),
      })
      await tx
        .update(appsTable)
        .set({
          config: drizzleSql`coalesce(${appsTable.config}, '{}'::jsonb) || ${overlayJson}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(appsTable.orgId, orgId), eq(appsTable.name, appName)))
    }
  }

  await tx.queueEvent({
    app: "kernel",
    entity: "connected_account",
    action: "create",
    entityId: account.id,
    data: {
      id: account.id,
      orgId,
      appName,
      connectionName,
      ownerType: resolvedOwnerType,
      ownerId: resolvedOwnerId,
      providerType: "credentials",
      identifier: storedIdentifier,
      status: "active",
      // Public origin where the kernel webhook routes are reachable from
      // third-party APIs — credentials-connection apps (e.g. Boxtal) need this
      // to register webhook subscriptions pointing at /webhooks/<orgId>/<app>/...
      // Mirrors the OAuth path. With org hosts it is the org's own host, so
      // deliveries pass through the edge (and its hold while the org moves cell).
      kernelPublicBaseUrl: await orgPublicBaseUrl(orgId),
    },
    ...connectionEventActor(userId),
    orgId,
    timestamp: new Date().toISOString(),
  })

  return redact(account)
}

/**
 * The actor a connection event names. A connection created or disconnected with
 * no person behind it (`liaison config apply` without an admin user passes "",
 * the operator's CLI passes "system") is a SYSTEM event with no actor id:
 * neither names a user, and the uuid-typed audit column refused "" outright,
 * which dead-lettered the audit row.
 */
export function connectionEventActor(userId: string): {
  actorId: string | null
  actorType: "user" | "system"
} {
  return userId.trim() === "" || userId === "system"
    ? { actorId: null, actorType: "system" }
    : { actorId: userId, actorType: "user" }
}

export async function listConnections(
  tx: RlsClient,
  orgId: string,
  _userId: string,
  opts?: { appName?: string },
): Promise<ConnectedAccountDto[]> {
  const conditions = [eq(connectedAccounts.orgId, orgId)]
  if (opts?.appName) conditions.push(eq(connectedAccounts.appName, opts.appName))
  const rows = await tx
    .select({
      id: connectedAccounts.id,
      orgId: connectedAccounts.orgId,
      appName: connectedAccounts.appName,
      connectionName: connectedAccounts.connectionName,
      ownerType: connectedAccounts.ownerType,
      ownerId: connectedAccounts.ownerId,
      identifier: connectedAccounts.identifier,
      displayName: connectedAccounts.displayName,
      providerType: connectedAccounts.providerType,
      status: connectedAccounts.status,
      statusMessage: connectedAccounts.statusMessage,
      tokenExpiresAt: connectedAccounts.tokenExpiresAt,
      createdBy: connectedAccounts.createdBy,
      createdAt: connectedAccounts.createdAt,
      updatedAt: connectedAccounts.updatedAt,
    })
    .from(connectedAccounts)
    .where(and(...conditions))
  // Exclude org-owned app connections from generic list — these must be
  // accessed through their app's sandboxed tools (e.g. mail:listAccounts)
  return (rows as ConnectedAccountDto[]).filter(
    (r) => !(r.ownerType === "org" && r.appName !== "kernel"),
  )
}

export async function disconnectConnection(
  // Accepts an RLS-scoped OR a privileged handle (same rationale as
  // `createCredentialConnection`): an ORG-owned non-kernel connection is invisible to
  // the `liaison_rls` UPDATE policy, so disconnecting one (e.g. the connector's
  // creds-changed path) must run under `withPrivilegedDb`. Body uses only
  // `.select`/`.update`/`.queueEvent`, present on both handles.
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  userId: string,
  connectionId: string,
  /**
   * An app refusing the account it was just given (a mailbox address another
   * owner holds): the person who connected it is told why, as a system alert
   * (attention/kernel-translations.ts, reason `connect_refused`).
   */
  notice?: { reason: "connect_refused"; summary: string },
): Promise<void> {
  const [row] = await tx
    .select({
      id: connectedAccounts.id,
      createdBy: connectedAccounts.createdBy,
      appName: connectedAccounts.appName,
      connectionName: connectedAccounts.connectionName,
      ownerType: connectedAccounts.ownerType,
      ownerId: connectedAccounts.ownerId,
      identifier: connectedAccounts.identifier,
      providerType: connectedAccounts.providerType,
      accessTokenEncrypted: connectedAccounts.accessTokenEncrypted,
      refreshTokenEncrypted: connectedAccounts.refreshTokenEncrypted,
      oauthClientSource: connectedAccounts.oauthClientSource,
      oauthClientId: connectedAccounts.oauthClientId,
      tokenExpiresAt: connectedAccounts.tokenExpiresAt,
    })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.id, connectionId), eq(connectedAccounts.orgId, orgId)))
    .limit(1)

  // No row (an unknown id, another app's own account id, or a connection the caller cannot
  // see) used to fall through to a 0-row UPDATE and a success answer: the disconnect button
  // then did nothing, silently. Report it.
  if (!row) throw new HTTPException(404, { message: "Connection not found" })

  // What the connection still owes its provider (stop its push watch, revoke its grant) runs
  // only after this transaction commits, and the tokens it takes move with it: written here in
  // this transaction, worked off by any process (revoke.ts).
  await stageConnectionTeardown(tx, { ...row, orgId })

  // Then forget the secrets: a disconnected connection holds no token or credential. A
  // reconnect stores fresh ones.
  await tx
    .update(connectedAccounts)
    .set({
      status: "disconnected",
      disconnectedAt: new Date(),
      updatedAt: new Date(),
      ...CLEARED_SECRETS,
    })
    .where(and(eq(connectedAccounts.id, connectionId), eq(connectedAccounts.orgId, orgId)))

  // A SQL connection's pool in this process serves nobody now (other processes
  // close theirs when their next call finds no account, or when idle).
  closeSqlPools({ orgId, appName: row.appName, connectionName: row.connectionName })

  await tx.queueEvent({
    app: "kernel",
    entity: "connected_account",
    action: "disconnect",
    entityId: connectionId,
    data: {
      id: connectionId,
      orgId,
      appName: row.appName,
      connectionName: row.connectionName,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      // The account the connection was for (the create event carries it too): an app keys its
      // own per-account state by it, so without it a disconnect handler matches nothing and the
      // disconnected account's syncs keep running.
      identifier: row.identifier,
      ...(notice
        ? { reason: notice.reason, summary: notice.summary, notifyUserId: row.createdBy }
        : {}),
    },
    // A disconnect no person made (the operator's CLI, an app refusing the account).
    ...connectionEventActor(userId),
    orgId,
    timestamp: new Date().toISOString(),
  })
}

export type ReconcileOutcome =
  | { status: "reconciled"; appName: string; connectionName: string; identifier: string }
  | { status: "not_found" }
  | { status: "not_active"; connectionStatus: string }

/**
 * Re-emit `kernel/connected_account:create` for an existing ACTIVE connection so
 * its owning app's `onConnectionEstablished` handler re-runs.
 *
 * This is the recovery path for a *lost* connect event. App connect handlers are
 * best-effort live pub/sub subscribers (outbox Phase 2b): if the app's
 * subscriber isn't registered at the instant the original event publishes (a
 * boot / redeploy race), the initialization — provider-specific metadata rows,
 * upstream webhook subscriptions — never runs, and the pub/sub message is never
 * replayed. The connection then looks "active" on the kernel side while the app
 * is silently uninitialised (e.g. Shopify's `install_metadata row not found`).
 *
 * Reconcile re-drives that initialization without a re-OAuth. It is idempotent
 * by the same at-least-once contract every connect handler already honours
 * (`onConnectionEstablished` takes an "existing row" branch on replay). The
 * payload mirrors `handleOAuthCallback` exactly, plus `reconcile: true` for
 * observability.
 */
export async function reconcileConnection(
  // Accepts an RLS-scoped OR privileged handle (same rationale as
  // `disconnectConnection`): an ORG-owned non-kernel connection is invisible to
  // `liaison_rls`, so the caller passes a privileged handle for those.
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  userId: string,
  connectionId: string,
): Promise<ReconcileOutcome> {
  const [row] = await tx
    .select({
      id: connectedAccounts.id,
      appName: connectedAccounts.appName,
      connectionName: connectedAccounts.connectionName,
      ownerType: connectedAccounts.ownerType,
      ownerId: connectedAccounts.ownerId,
      providerType: connectedAccounts.providerType,
      identifier: connectedAccounts.identifier,
      status: connectedAccounts.status,
    })
    .from(connectedAccounts)
    .where(and(eq(connectedAccounts.id, connectionId), eq(connectedAccounts.orgId, orgId)))
    .limit(1)

  if (!row) return { status: "not_found" }
  // Only replay init for a live connection — reconciling a disconnected one would
  // re-mint metadata/webhooks for an account the operator deliberately severed.
  if (row.status !== "active") return { status: "not_active", connectionStatus: row.status }

  await tx.queueEvent(
    buildConnectedAccountCreateEvent(row, orgId, userId, await orgPublicBaseUrl(orgId)),
  )

  return {
    status: "reconciled",
    appName: row.appName,
    connectionName: row.connectionName,
    identifier: row.identifier,
  }
}

/**
 * Reconcile every ACTIVE account of an app connection, keyed by
 * `(appName, connectionName)` rather than an opaque account id. This is what the
 * Settings UI calls: it already knows the app + connection name, and org-owned
 * app connections (Shopify's `shop`, mail accounts, …) are deliberately hidden
 * from the generic account list (`listConnections`), so their ids aren't exposed
 * to the client. Runs privileged so those org-owned rows are visible. Re-emits
 * `connected_account:create` per active account (idempotent). Returns the set
 * reconciled so the caller can report "0 active connections" distinctly.
 */
export async function reconcileAppConnections(
  orgId: string,
  /** The operator who asked; null for a system re-run (an app turned back On). */
  userId: string | null,
  appName: string,
  connectionName: string,
): Promise<{ reconciled: Array<{ id: string; identifier: string }> }> {
  const result = await withPrivilegedDb(orgId, "reconcile-app-connections", async (tx) => {
    const webhookBase = await orgPublicBaseUrl(orgId)
    const rows = await tx
      .select({
        id: connectedAccounts.id,
        appName: connectedAccounts.appName,
        connectionName: connectedAccounts.connectionName,
        ownerType: connectedAccounts.ownerType,
        ownerId: connectedAccounts.ownerId,
        providerType: connectedAccounts.providerType,
        identifier: connectedAccounts.identifier,
      })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, appName),
          eq(connectedAccounts.connectionName, connectionName),
          eq(connectedAccounts.status, "active"),
        ),
      )

    for (const row of rows) {
      await tx.queueEvent(buildConnectedAccountCreateEvent(row, orgId, userId, webhookBase))
    }
    return { reconciled: rows.map((r) => ({ id: r.id, identifier: r.identifier })) }
  })
  // Re-read each account's name too (outside the transaction: a provider call
  // must not hold a pooled connection), so a row stored without one heals.
  for (const row of result.reconciled) await refreshConnectionDisplayName(orgId, row.id)
  return result
}

export async function getTokenForConnection(
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  userId: string,
  appName: string,
  connectionName: string,
  identifier?: string,
  opts?: { actorType?: ConnectionLookupActor },
): Promise<string> {
  const conditions = [
    eq(connectedAccounts.orgId, orgId),
    eq(connectedAccounts.appName, appName),
    eq(connectedAccounts.connectionName, connectionName),
    eq(connectedAccounts.status, "active"),
  ]
  if (identifier) conditions.push(eq(connectedAccounts.identifier, identifier))

  const accounts = await loadConnectedAccounts(
    tx,
    orgId,
    userId,
    appName,
    opts?.actorType ?? "user",
    conditions,
    identifier,
  )

  if (accounts.length === 0) throw new NoConnectedAccountError(connectionName)
  return getTokenFromAccount(accounts[0])
}

/** The account a connection lookup resolved to, beside its token. */
export interface ResolvedConnectionAccount {
  id: string
  identifier: string
  ownerType: "org" | "user"
  ownerId: string | null
  metadata: Record<string, unknown> | null
  token: string
}

/**
 * `getTokenForConnection`, also saying WHICH account answered (its owner and
 * metadata): an app whose read scope depends on the account (Drive: an org
 * connection reads only the shared drives an admin chose) takes the token and
 * the account from the same lookup, so the two can never disagree.
 */
export async function resolveConnectionAccount(
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  userId: string,
  appName: string,
  connectionName: string,
  identifier?: string,
  opts?: {
    actorType?: ConnectionLookupActor
    /** Only an account of this owner type resolves (as `getCredentialsForConnection`). */
    ownerType?: "org" | "user"
    /** With `ownerType: "user"`: only this member's own account resolves. */
    ownerId?: string
    /** Only this exact account resolves (an account a ticket or a source names). */
    accountId?: string
  },
): Promise<ResolvedConnectionAccount> {
  const conditions = [
    eq(connectedAccounts.orgId, orgId),
    eq(connectedAccounts.appName, appName),
    eq(connectedAccounts.connectionName, connectionName),
    eq(connectedAccounts.status, "active"),
  ]
  if (identifier) conditions.push(eq(connectedAccounts.identifier, identifier))
  if (opts?.ownerType) conditions.push(eq(connectedAccounts.ownerType, opts.ownerType))
  if (opts?.ownerId) conditions.push(eq(connectedAccounts.ownerId, opts.ownerId))
  if (opts?.accountId) conditions.push(eq(connectedAccounts.id, opts.accountId))
  const accounts = await loadConnectedAccounts(
    tx,
    orgId,
    userId,
    appName,
    opts?.actorType ?? "user",
    conditions,
    identifier,
  )
  const account = accounts[0]
  if (!account) throw new NoConnectedAccountError(connectionName)
  return {
    id: account.id,
    identifier: account.identifier,
    ownerType: account.ownerType === "org" ? "org" : "user",
    ownerId: account.ownerId ?? null,
    metadata: account.metadata ?? null,
    token: await getTokenFromAccount(account),
  }
}

export async function getCredentialsForConnection(
  tx: RlsClient | PrivilegedDb,
  orgId: string,
  userId: string,
  appName: string,
  connectionName: string,
  identifier?: string,
  opts?: {
    actorType?: ConnectionLookupActor
    /** Only an account of this owner type resolves. An org-wide connector
     *  passes "org" so no member's personal connection of the same name can
     *  stand in for the org's (the system lookup is otherwise newest-wins
     *  across owners). */
    ownerType?: "org" | "user"
  },
): Promise<Record<string, string>> {
  const conditions = [
    eq(connectedAccounts.orgId, orgId),
    eq(connectedAccounts.appName, appName),
    eq(connectedAccounts.connectionName, connectionName),
    eq(connectedAccounts.status, "active"),
  ]
  if (identifier) conditions.push(eq(connectedAccounts.identifier, identifier))
  if (opts?.ownerType) conditions.push(eq(connectedAccounts.ownerType, opts.ownerType))

  const accounts = await loadConnectedAccounts(
    tx,
    orgId,
    userId,
    appName,
    opts?.actorType ?? "user",
    conditions,
    identifier,
  )

  if (accounts.length === 0) throw new NoConnectedAccountError(connectionName)

  const account = accounts[0]
  validateAccountStatus(account)
  if (!account.credentialsEncrypted) throw new ConnectionCredentialsMissingError()

  return decryptAccountCredentials(account.credentialsEncrypted)
}

/** The credential values of a connected account's `credentials_encrypted` column. */
export function decryptAccountCredentials(credentialsEncrypted: string): Record<string, string> {
  const decrypted = decryptSecret(
    credentialsEncrypted,
    process.env.ENCRYPTION_KEY ?? ENCRYPTION_KEY,
    CryptoContext.connectedAccountCredentials,
  )
  return JSON.parse(decrypted) as Record<string, string>
}

export async function startOAuthFlow(
  orgId: string,
  userId: string,
  appName: string,
  connectionName: string,
  opts?: {
    ownerType?: "user" | "org"
    ownerId?: string | null
    shop?: string
    /**
     * The flow was started by an authenticated browser request that is setting
     * the state cookie (`setConnectBindingCookie`); the callback must then
     * present it. Absent for operator-run flows (the CLI prints a URL that is
     * opened wherever the operator likes).
     */
    browserBound?: boolean
    /** Receives the state token so the caller can bind a cookie to it. */
    onState?: (state: string) => void
    /**
     * The flow was started by a desktop or mobile shell, which binds it to
     * itself instead of a cookie (shell-connect.ts): the callback parks the
     * grant until the shell redeems it with its verifier.
     */
    shellFlow?: ShellConnectFlow
    /** The flow was started from a connect card in a conversation. */
    card?: ConnectCardRef
    /**
     * The flow was started by redeeming a one-time connect link (connect-links.ts):
     * its id, so a refused callback records why for whoever waits on the link
     * (`liaison connect --for`) and sends the browser back to the link's page.
     */
    connectLinkId?: string
    /**
     * The address of the account being connected, when the flow was started for
     * one (a connect card's `identifier`). It decides the restricted scopes
     * (restricted-scopes.ts) and is sent to the provider as `login_hint`.
     */
    accountHint?: string
  },
): Promise<string> {
  // Same door as createCredentialConnection, the OAuth half: a demo org does
  // not get to complete a real grant against somebody's live account.
  await assertDemoEgressAllowed(orgId, "connector_credentials")

  // Look up connection config from app manifest (populated during registration)
  const connConfig = connectionConfigRegistry.get([orgId, appName, connectionName])
  if (!connConfig) {
    throw new Error(`Connection "${connectionName}" not declared in app "${appName}" manifest`)
  }
  if (connConfig.type !== "oauth2") {
    throw new Error(`Connection "${connectionName}" is not an OAuth2 connection`)
  }
  let { authorizationUrl, tokenUrl } = connConfig
  if (!authorizationUrl || !tokenUrl) {
    throw new Error(
      `OAuth connection "${connectionName}" is missing authorization or token endpoints`,
    )
  }

  // Resolve any URL template variables (e.g. `{shop}` for per-store providers)
  // using the connection's declared normalization rules, then substitute into
  // the URLs. Resolved variables are carried through OAuth state so the callback
  // can reconstruct the canonical connection identifier.
  const rawTemplateVars: Record<string, string | undefined> = {}
  if (opts?.shop !== undefined) rawTemplateVars["shop"] = opts.shop
  const resolvedTemplateVars = resolveOAuthUrlTemplateVariables(
    connectionName,
    authorizationUrl,
    tokenUrl,
    rawTemplateVars,
    connConfig.templateVars,
  )
  if (Object.keys(resolvedTemplateVars).length > 0) {
    authorizationUrl = substituteUrlTemplateVariables(authorizationUrl, resolvedTemplateVars)
    tokenUrl = substituteUrlTemplateVariables(tokenUrl, resolvedTemplateVars)
  }
  const standIn = testOAuthProvider()
  if (standIn) {
    authorizationUrl = `${standIn}/authorize`
    tokenUrl = `${standIn}/token`
  }

  try {
    await validateConnectionEndpoint(authorizationUrl, standIn !== null)
    await validateConnectionEndpoint(tokenUrl, standIn !== null)
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      throw new Error(`Unsafe OAuth connection endpoint: ${err.message}`)
    }
    throw err
  }

  const provider = await resolveOAuthClientConfig({
    orgId,
    appName,
    connectionName,
    auditAction: "oauth-flow-lookup",
  })
  if (!provider) {
    const providerName = `${appName}:${connectionName}`
    throw new OAuthStartRefusedError(
      "no_client",
      `OAuth provider not configured for connection "${providerName}". ` +
        "This connection is not configured for this workspace.",
    )
  }

  // Authorize parameters read from the app's config (Meta's `config_id`), checked
  // before any state is written: a missing or malformed one refuses the start.
  const configParams = connConfig.authorizeConfigParams
    ? await withPrivilegedDb(orgId, "oauth-authorize-config-params", async (tx) => {
        const rows = await tx
          .select({ config: appsTable.config })
          .from(appsTable)
          .where(and(eq(appsTable.orgId, orgId), eq(appsTable.name, appName)))
          .limit(1)
        const raw = rows[0]?.config
        const config = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw
        return resolveAuthorizeConfigParams(
          connConfig.authorizeConfigParams,
          config && typeof config === "object" ? (config as Record<string, unknown>) : {},
        )
      })
    : ({ ok: true, params: {} } as const)
  if (!configParams.ok) {
    throw new OAuthStartRefusedError(
      "missing_setting",
      `Connection "${appName}:${connectionName}" needs the app setting "${configParams.configKey}" ` +
        `${configParams.reason === "missing" ? "set" : "set to a valid value"} first: an admin sets it ` +
        "in the app's settings or with config apply.",
    )
  }

  // Generate PKCE S256 code verifier + challenge
  const codeVerifier = randomBytes(32).toString("base64url")
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")

  // Resolve ownerType/ownerId
  const ownerType = opts?.ownerType ?? "user"
  const ownerId = ownerType === "org" ? null : (opts?.ownerId ?? userId)

  // Generate a random state token and store in Redis
  // With a central redirect host it names the org (lib/oauth-state.ts).
  const stateToken = await oauthStateForOrg(orgId, randomBytes(32).toString("base64url"))
  await redis.set(
    `${OAUTH_STATE_PREFIX}:${stateToken}`,
    JSON.stringify({
      orgId,
      userId,
      appName,
      connectionName,
      codeVerifier,
      tokenUrl,
      ownerType,
      ownerId,
      // Carry resolved template variables for the callback's identifier resolution.
      templateVars: resolvedTemplateVars,
      browserBound: opts?.browserBound === true,
      shell: opts?.shellFlow ?? null,
      card: opts?.card ?? null,
      connectLink: opts?.connectLinkId ?? null,
      // The account the flow was started for, as given (an id or a name): picks
      // one when the sign-in covers several (identifierFromUserinfoPath).
      accountChoice: opts?.accountHint?.trim().slice(0, 200) || null,
      // Legacy field for backward-compat with states from before this was generalised.
      shopDomain: resolvedTemplateVars["shop"] ?? null,
    }),
    "EX",
    OAUTH_STATE_TTL_SECONDS,
  )

  opts?.onState?.(stateToken)

  // Build the authorization URL
  const redirectUri = connectionsRedirectUri()
  const params = new URLSearchParams({
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state: stateToken,
  })
  // PKCE by default; a connection may opt out (some providers -- e.g. Instagram
  // Business Login -- reject an unexpected code_challenge). The verifier is still
  // generated + stored in state; the callback only sends it back when PKCE is on.
  if (connConfig.usePkce !== false) {
    params.set("code_challenge", codeChallenge)
    params.set("code_challenge_method", "S256")
  }
  const requested = await scopesToRequest(
    orgId,
    appName,
    connectionName,
    connConfig,
    {
      identifier: connConfig.identifierVar
        ? resolvedTemplateVars[connConfig.identifierVar]
        : undefined,
      ownerType,
      ownerId,
    },
    {
      userId,
      clientSource: provider.source === "deployment" ? "instance" : "org",
      accountHint: normalizedAccountHint(opts?.accountHint),
    },
  )
  const hint = normalizedAccountHint(opts?.accountHint)
  // The provider's consent opens on the account the flow was started for, so the
  // account that consents is the one the scopes were chosen for.
  if (hint && restrictedScopesOf(connConfig).length > 0) params.set("login_hint", hint)
  if (requested.length > 0) {
    // Default space-join (OAuth2/OIDC); Meta/Instagram want comma-joined scopes.
    params.set("scope", requested.join(connConfig.scopeSeparator ?? " "))
  }

  // Append extraParams from connection config
  if (connConfig.extraParams) {
    for (const [k, v] of Object.entries(connConfig.extraParams)) {
      params.set(k, v)
    }
  }
  for (const [k, v] of Object.entries(configParams.params)) params.set(k, v)

  log.info({ orgId, userId, appName, connectionName, ownerType }, "OAuth flow started")
  return `${authorizationUrl}?${params.toString()}`
}

/** The scopes an authorize request asks for: the manifest's `scopes`, plus each
 *  protected scope the org opted in to or the re-authorized account already holds
 *  (protected-scopes.ts), minus the restricted scopes this client may not ask
 *  this person for (restricted-scopes.ts). */
async function scopesToRequest(
  orgId: string,
  appName: string,
  connectionName: string,
  connConfig: {
    scopes?: string[]
    protectedScopes?: ProtectedScope[]
    restrictedScopes?: string[]
  },
  account: { identifier?: string; ownerType: "user" | "org"; ownerId: string | null },
  flow: { userId: string; clientSource: "org" | "instance"; accountHint?: string },
): Promise<string[]> {
  const base = connConfig.scopes ?? []
  const declared = protectedScopesOf(connConfig)
  const restricted = restrictedScopesOf(connConfig)
  if (declared.length === 0 && restricted.length === 0) return base
  const { optedIn, grant, email, sameAccountGrant } = await withPrivilegedDb(
    orgId,
    "oauth-protected-scopes",
    async (tx) => ({
      optedIn: await loadOptedInScopes(tx, orgId, appName, declared),
      grant: await existingAccountGrant(tx, { orgId, appName, connectionName, ...account }),
      // The address being connected: the one the flow was started for, else the
      // person's own sign-in address.
      email:
        restricted.length === 0
          ? null
          : (flow.accountHint ??
            (
              await tx
                .select({ email: users.email })
                .from(users)
                .where(eq(users.id, flow.userId))
                .limit(1)
            )[0]?.email ??
            null),
      // A reconnect keeps a restricted scope only for the same account: the
      // ACTIVE row with the address the flow was started for.
      sameAccountGrant:
        restricted.length > 0 && flow.accountHint
          ? await activeGrantOf(tx, orgId, appName, connectionName, flow.accountHint)
          : null,
    }),
  )
  const scopes = authorizeScopes(base, declared, optedIn, grant)
  if (restricted.length === 0) return scopes
  const ctx = {
    clientSource: flow.clientSource,
    instanceVerified: env.GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED === true,
    existingGrant: sameAccountGrant,
    personAccountType: null,
  }
  // The person's address is looked up (MX) only when nothing else decides.
  const allowed =
    restrictedScopesAllowed(restricted, ctx) ||
    (email !== null &&
      restrictedScopesAllowed(restricted, {
        ...ctx,
        personAccountType: (await detectMailAccountType(email)).accountType,
      }))
  return withoutRestricted(scopes, restricted, allowed)
}

/** A connect's account address, lower-cased, when it looks like one. */
function normalizedAccountHint(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase()
  return v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254 ? v : undefined
}

/** The recorded grant of the active account with this address (restricted scopes). */
async function activeGrantOf(
  tx: PrivilegedDb,
  orgId: string,
  appName: string,
  connectionName: string,
  identifier: string,
): Promise<string[] | "unknown" | null> {
  const rows = await tx
    .select({ metadata: connectedAccounts.metadata })
    .from(connectedAccounts)
    .where(
      and(
        eq(connectedAccounts.orgId, orgId),
        eq(connectedAccounts.appName, appName),
        eq(connectedAccounts.connectionName, connectionName),
        eq(connectedAccounts.status, "active"),
        drizzleSql`lower(${connectedAccounts.identifier}) = ${identifier}`,
      ),
    )
    .orderBy(desc(connectedAccounts.updatedAt))
    .limit(1)
  return rows[0] ? recordedGrant(rows[0].metadata) : null
}

/** Scopes from a token response field: space-separated per RFC 6749, comma-
 *  separated by Shopify and Instagram, or already a list (Instagram). */
function parseGrantedScopes(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : []
  return parts.filter((s): s is string => typeof s === "string" && s.length > 0)
}

/** The permissions the user granted, read from a connection's `grantedScopesUrl`
 *  (Meta's `{ data: [{ permission, status }] }`). Returns [] when the provider
 *  cannot be read, which records nothing rather than a guessed grant. */
/** The token's expiry as the provider reports it (`tokenDebugUrl`), for `metadata.tokenExpiry`. */
export interface ProviderTokenExpiry {
  /** ISO, or null when the provider says it never lapses. */
  expiresAt: string | null
  dataAccessExpiresAt: string | null
  checkedAt: string
}

/**
 * Ask the provider when the token lapses (Meta's debug_token). Null when the
 * lookup fails or says nothing usable: the stored `expires_in` stays the
 * fallback, as before this lookup existed.
 */
export async function fetchTokenExpiry(
  url: string,
  accessToken: string,
  appToken: string,
  logCtx: { orgId: string; appName: string; connectionName: string },
): Promise<ProviderTokenExpiry | null> {
  const unix = (v: unknown): string | null | undefined =>
    typeof v !== "number" || !Number.isFinite(v) || v < 0
      ? undefined
      : v === 0
        ? null
        : new Date(v * 1000).toISOString()
  try {
    const u = new URL(url)
    u.searchParams.set("input_token", accessToken)
    const res = await fetchWithRedirectValidation(
      u.toString(),
      { headers: { Authorization: `Bearer ${appToken}`, Accept: "application/json" } },
      { requireHttps: true, allowPrivateHostsInTest: true },
    )
    if (!res.ok) {
      log.warn({ ...logCtx, status: res.status }, "Token expiry lookup failed; stored expiry kept")
      return null
    }
    const body = (await res.json()) as {
      data?: { expires_at?: unknown; data_access_expires_at?: unknown }
    }
    const expiresAt = unix(body.data?.expires_at)
    const dataAccessExpiresAt = unix(body.data?.data_access_expires_at)
    if (expiresAt === undefined && dataAccessExpiresAt === undefined) return null
    return {
      expiresAt: expiresAt ?? null,
      dataAccessExpiresAt: dataAccessExpiresAt ?? null,
      checkedAt: new Date().toISOString(),
    }
  } catch (err) {
    log.warn({ ...logCtx, err }, "Token expiry lookup failed; stored expiry kept")
    return null
  }
}

async function fetchGrantedScopes(
  url: string,
  accessToken: string,
  logCtx: { orgId: string; appName: string; connectionName: string },
): Promise<string[]> {
  try {
    const res = await fetchWithRedirectValidation(
      url,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
      { requireHttps: true, allowPrivateHostsInTest: true },
    )
    if (!res.ok) {
      log.warn(
        { ...logCtx, status: res.status },
        "Granted-scopes lookup failed; grant left unrecorded",
      )
      return []
    }
    const body = (await res.json()) as { data?: Array<{ permission?: unknown; status?: unknown }> }
    return (body.data ?? []).flatMap((p) =>
      p.status === "granted" && typeof p.permission === "string" ? [p.permission] : [],
    )
  } catch (err) {
    log.warn({ ...logCtx, err }, "Granted-scopes lookup failed; grant left unrecorded")
    return []
  }
}

/**
 * The one account a sign-in connects, read at `path` of the connection's
 * `userinfoUrl` response. Throws when the response cannot be read or holds no
 * account (nothing is connected under a made-up identifier), and
 * OAuthAccountChoiceError when it holds several and `choice` names none of them.
 */
async function userinfoPathAccount(
  connConfig: { userinfoUrl?: string; accountNameField?: string } | undefined,
  path: string,
  accessToken: string,
  choice: string | null,
  logCtx: { orgId: string; appName: string; connectionName: string },
): Promise<UserinfoAccount> {
  if (!connConfig?.userinfoUrl) {
    throw new Error(
      `Connection "${logCtx.connectionName}" reads its identifier without a userinfoUrl`,
    )
  }
  const res = await fetchWithRedirectValidation(
    connConfig.userinfoUrl,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
    { requireHttps: true, allowPrivateHostsInTest: true },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    log.warn(
      { ...logCtx, status: res.status, body: body.slice(0, 512) },
      "Account lookup failed; nothing connected",
    )
    throw new Error(`The account lookup failed (HTTP ${res.status}), so nothing was connected`)
  }
  const accounts = accountsAtPath(await res.json(), path, connConfig.accountNameField)
  const chosen = chooseUserinfoAccount(accounts, choice)
  if (chosen.kind === "one") return chosen.account
  if (chosen.kind === "none") {
    log.warn(logCtx, "Account lookup returned no account; nothing connected")
    throw new OAuthCallbackRefusedError(
      "no_account",
      "This sign-in gave access to no account, so nothing was connected. Check that the account is assigned to the app, then connect again.",
    )
  }
  log.info(
    { ...logCtx, count: chosen.accounts.length },
    "Sign-in covers several accounts; asking which",
  )
  throw new OAuthAccountChoiceError(chosen.accounts)
}

/** Longest account name stored: a user managing many Pages joins them all. */
const MAX_ACCOUNT_DISPLAY_NAME = 200

/** The non-empty strings at a dotted path; a `[]` segment maps over an array. */
function namesAtPath(value: unknown, segments: string[]): string[] {
  if (segments.length === 0) {
    return typeof value === "string" && value.trim() ? [value.trim()] : []
  }
  if (!value || typeof value !== "object") return []
  const [head, ...rest] = segments
  const each = head.endsWith("[]")
  const next = (value as Record<string, unknown>)[each ? head.slice(0, -2) : head]
  if (!each) return namesAtPath(next, rest)
  return Array.isArray(next) ? next.flatMap((item) => namesAtPath(item, rest)) : []
}

/** The account name in a `displayNameUrl` response: the first of `fields` that
 *  yields one, several names joined with ", ", capped in length. */
export function pickAccountDisplayName(body: unknown, fields: string[]): string | null {
  for (const field of fields) {
    const names = [...new Set(namesAtPath(body, field.split(".")))]
    if (names.length === 0) continue
    const joined = names.join(", ")
    return joined.length > MAX_ACCOUNT_DISPLAY_NAME
      ? `${joined.slice(0, MAX_ACCOUNT_DISPLAY_NAME - 1)}…`
      : joined
  }
  return null
}

/**
 * The connected account's human name, read from the connection's
 * `displayNameUrl` with its access token, for providers whose identifier is an
 * opaque id (Meta). Best effort: null when the connection declares no lookup or
 * the provider cannot be read, and the caller then keeps the stored name.
 */
async function fetchAccountDisplayName(
  connConfig: { displayNameUrl?: string; displayNameFields?: string[] } | undefined,
  accessToken: string,
  logCtx: { orgId: string; appName: string; connectionName: string },
): Promise<string | null> {
  if (!connConfig?.displayNameUrl) return null
  try {
    const res = await fetchWithRedirectValidation(
      connConfig.displayNameUrl,
      { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
      { requireHttps: true, allowPrivateHostsInTest: true },
    )
    if (!res.ok) {
      log.warn({ ...logCtx, status: res.status }, "Account name lookup failed; name left as is")
      return null
    }
    return pickAccountDisplayName(await res.json(), connConfig.displayNameFields ?? ["name"])
  } catch (err) {
    log.warn({ ...logCtx, err }, "Account name lookup failed; name left as is")
    return null
  }
}

/**
 * Re-read an active OAuth connection's account name and store it when the
 * provider gives one (reconcile's healing path for a row stored without a
 * name). One account, on demand, never a sweep. Best effort: never throws.
 */
export async function refreshConnectionDisplayName(
  orgId: string,
  accountId: string,
): Promise<boolean> {
  try {
    const account = await withPrivilegedDb(orgId, "connection-display-name-load", async (db) => {
      const rows = await db
        .select()
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.id, accountId), eq(connectedAccounts.orgId, orgId)))
        .limit(1)
      return rows[0]
    })
    if (account?.status !== "active" || account.providerType !== "oauth2") return false
    const connConfig = connectionConfigRegistry.get([
      orgId,
      account.appName,
      account.connectionName,
    ])
    if (!connConfig?.displayNameUrl) return false
    // getTokenFromAccount renews an expiring token itself, and the renewal
    // stores the name already; this lookup covers a token that needed none.
    // The row was read under `orgId` (its org_id matched), so its org is this one.
    const token = await getTokenFromAccount({ ...account, orgId })
    const name = await fetchAccountDisplayName(connConfig, token, {
      orgId,
      appName: account.appName,
      connectionName: account.connectionName,
    })
    if (!name) return false
    if (name === account.displayName) return true
    await withPrivilegedDb(orgId, "connection-display-name-store", async (db) => {
      await db
        .update(connectedAccounts)
        .set({ displayName: name, updatedAt: new Date() })
        .where(eq(connectedAccounts.id, accountId))
    })
    return true
  } catch (err) {
    log.warn({ orgId, accountId, err }, "Account name refresh failed; name left as is")
    return false
  }
}

/** How long an account whose name lookup failed waits before a page view tries again. */
export const ACCOUNT_NAME_RETRY_COOLDOWN_MS = 30 * 60 * 1000
/** Accounts whose name is being looked up right now (one lookup per account at a time). */
const nameLookupsInFlight = new Set<string>()
/** Account id -> when its last failed name lookup may be retried. */
const nameLookupRetryAt = new Map<string, number>()

/** Forget the retry cooldowns (tests). */
export function resetAccountNameLookupCooldowns(): void {
  nameLookupRetryAt.clear()
}

/**
 * Heal the listed accounts stored without a name (connected before their
 * connection declared `displayNameUrl`): an active one whose connection
 * declares the lookup gets its name read and stored, so the next listing shows
 * it. Runs on the read path (Settings lists the accounts), never at boot. One
 * account at a time; an account already being looked up is skipped, and one
 * whose lookup failed waits `ACCOUNT_NAME_RETRY_COOLDOWN_MS` before a later
 * view tries again, so page views never fan out to the provider. Never throws
 * and never clears a stored name. The caller does not wait for it.
 */
export async function healUnnamedConnectionAccounts(
  orgId: string,
  appName: string,
  connectionName: string,
  accounts: ReadonlyArray<Pick<ConnectionAccountStatus, "id" | "displayName" | "status">>,
): Promise<void> {
  if (!connectionConfigRegistry.get([orgId, appName, connectionName])?.displayNameUrl) return
  const now = Date.now()
  for (const [id, at] of nameLookupRetryAt) if (at <= now) nameLookupRetryAt.delete(id)
  const due = accounts.filter(
    (a) =>
      a.status === "active" &&
      !a.displayName?.trim() &&
      !nameLookupsInFlight.has(a.id) &&
      !nameLookupRetryAt.has(a.id),
  )
  for (const a of due) nameLookupsInFlight.add(a.id)
  try {
    for (const a of due) {
      if (await refreshConnectionDisplayName(orgId, a.id)) continue
      nameLookupRetryAt.set(a.id, Date.now() + ACCOUNT_NAME_RETRY_COOLDOWN_MS)
      log.debug({ orgId, appName, connectionName, accountId: a.id }, "Unnamed account not named")
    }
  } finally {
    for (const a of due) nameLookupsInFlight.delete(a.id)
  }
}

/** What `startOAuthFlow` stores under the state token. */
interface OAuthStateRecord {
  orgId: string
  userId: string
  appName: string
  connectionName: string
  codeVerifier: string
  tokenUrl: string
  ownerType?: "user" | "org"
  ownerId?: string | null
  templateVars?: Record<string, string>
  shopDomain?: string | null
  /** The account the flow was started for (an id or a name), if any. */
  accountChoice?: string | null
  browserBound?: boolean
  shell?: unknown
  /** A connect card's reference (ConnectCardRef), when a card started the flow. */
  card?: unknown
  /** The id of the one-time connect link the flow was started from, if any. */
  connectLink?: string | null
}

/** The redirect_uri of every connector flow: the authorize URL and the code exchange send the same. */
export function connectionsRedirectUri(): string {
  return `${oauthRedirectBaseUrl()}/api/connections/callback`
}

/** Retrieves and consumes a state (single use). */
async function consumeOAuthState(state: string): Promise<OAuthStateRecord> {
  const rawState = await redis.getdel(`${OAUTH_STATE_PREFIX}:${state}`)
  if (!rawState) {
    throw new Error("Invalid or expired OAuth state. Please restart the authorization flow.")
  }
  return JSON.parse(rawState) as OAuthStateRecord
}

/**
 * The org and app a pending OAuth state belongs to, without consuming it: where
 * a failed callback sends the browser back to (settings-paths.ts).
 */
export async function peekOAuthStateApp(state: string): Promise<{
  orgId: string
  appName: string
  card: ConnectCardRef | null
  connectLink: string | null
} | null> {
  const raw = await redis.get(`${OAUTH_STATE_PREFIX}:${state}`)
  if (!raw) return null
  try {
    const record = JSON.parse(raw) as Partial<OAuthStateRecord>
    return typeof record.orgId === "string" && typeof record.appName === "string"
      ? {
          orgId: record.orgId,
          appName: record.appName,
          card: connectCardRefOf(record.card),
          connectLink: typeof record.connectLink === "string" ? record.connectLink : null,
        }
      : null
  } catch {
    return null
  }
}

/**
 * Consumes the state of a callback the provider answered with an error, and
 * says whether a shell started it (it is then told on its handoff link, not
 * sent to the web app's settings page in a browser it may not use).
 */
export async function discardOAuthState(state: string): Promise<ShellConnectFlow | null> {
  const raw = await redis.getdel(`${OAUTH_STATE_PREFIX}:${state}`)
  if (!raw) return null
  try {
    return shellConnectFlowOf((JSON.parse(raw) as OAuthStateRecord).shell)
  } catch {
    return null
  }
}

/** Where a callback goes next. */
export type OAuthCallbackOutcome =
  /** A browser flow, completed: the web app's settings page. */
  | { kind: "redirect"; url: string }
  /** A shell flow, parked: the handoff page sends the browser back to the app. */
  | { kind: "shell-handoff"; code: string; returnState: string }

/**
 * The provider callback. A browser flow is checked against its binding cookie
 * and completed here; a shell flow completes nothing here and is parked for
 * the shell to redeem (shell-connect.ts).
 */
export async function receiveOAuthCallback(
  code: string,
  state: string,
  callbackParams?: Record<string, string | undefined>,
  /** The request's Cookie header: proves the callback is the initiating browser. */
  cookieHeader?: string,
  /** The callback's host binding (lib/org-host.ts): a flow of org A completes only on A's host. */
  hostBinding?: HostBinding,
): Promise<OAuthCallbackOutcome> {
  // Checked before the state is spent: another org's state (or one missing its
  // org prefix) stays for its own browser to finish on its own host.
  if (!stateSlugFitsHost(state, hostBinding ?? { kind: "unbound" })) {
    throw new OAuthBrowserMismatchError()
  }
  const record = await consumeOAuthState(state)
  if (hostBinding && !(await bindingAllowsOrg(hostBinding, record.orgId))) {
    throw new OAuthBrowserMismatchError()
  }
  // The prefix must name the org the flow was started for.
  const stateSlug = oauthStatePrefixed() ? oauthStateSlug(state) : null
  if (stateSlug !== null && (await orgIdForSlug(stateSlug)) !== record.orgId) {
    throw new OAuthBrowserMismatchError()
  }
  // An app turned Off for the workspace while the person was at the provider
  // connects nothing (S19, A6): a readable refusal, not a silent grant.
  if (!(await isAppActiveForOrgAsync(record.orgId, record.appName))) {
    throw new OAuthAppDisabledError(record.appName, appSettingsPath(record.orgId, record.appName))
  }
  const shell = shellConnectFlowOf(record.shell)
  if (shell) {
    const handoff = await parkConnectHandoff({
      record,
      providerCode: code,
      callbackParams: callbackParams ?? {},
      codeChallenge: shell.codeChallenge,
    })
    log.info(
      { orgId: record.orgId, appName: record.appName, connectionName: record.connectionName },
      "OAuth callback parked for the app that started it",
    )
    return { kind: "shell-handoff", code: handoff, returnState: shell.returnState }
  }
  // The state was consumed above (single use), so a refused callback cannot be
  // retried by the browser that did start the flow: it restarts, which is the
  // price of not letting a forwarded link complete it.
  if (record.browserBound && !connectBindingMatches(cookieHeader, CONNECT_BINDING_COOKIE, state)) {
    throw new OAuthBrowserMismatchError()
  }
  return { kind: "redirect", url: await completeOAuthGrant(record, code, callbackParams) }
}

/**
 * The browser half of `receiveOAuthCallback`, for callers that only ever see
 * a browser flow: answers the settings URL, and refuses a shell flow's state.
 */
export async function handleOAuthCallback(
  code: string,
  state: string,
  callbackParams?: Record<string, string | undefined>,
  cookieHeader?: string,
): Promise<string> {
  const outcome = await receiveOAuthCallback(code, state, callbackParams, cookieHeader)
  if (outcome.kind !== "redirect") {
    throw new Error("This authorization completes in the Liaison app that started it.")
  }
  return outcome.url
}

/**
 * Completes a parked shell flow: the shell's verifier and its session must
 * match the flow it started (`claimConnectHandoff`), and only then is the
 * provider's code exchanged and the connection stored. Answers the settings
 * page a browser flow would have landed on.
 */
export async function redeemShellConnect(input: {
  code: unknown
  codeVerifier: unknown
  orgId: string
  userId: string
}): Promise<{ appName: string; connectionName: string; settingsPath: string }> {
  const handoff = await claimConnectHandoff<OAuthStateRecord>(input)
  const { record } = handoff
  await completeOAuthGrant(record, handoff.providerCode, handoff.callbackParams)
  return {
    appName: record.appName,
    connectionName: record.connectionName,
    settingsPath: appSettingsPath(record.orgId, record.appName),
  }
}

/** Exchanges the provider's code and stores the connection the state describes. */
async function completeOAuthGrant(
  record: OAuthStateRecord,
  code: string,
  callbackParams?: Record<string, string | undefined>,
): Promise<string> {
  // The grant writes the org's connection: counted as a live write first (a
  // freeze landing meanwhile sees it), then gated. An org moving to another
  // instance stores no new connection here (503 `org_moving`; the person
  // retries once the move is over).
  const { assertOrgAcceptsWrites } = await import("~/modules/org/transfer-state/gate")
  const { beginOrgActivity } = await import("~/modules/org/transfer-state/state")
  const end = beginOrgActivity(record.orgId, "writes")
  try {
    await assertOrgAcceptsWrites(record.orgId)
    return await storeOAuthGrant(record, code, callbackParams)
  } finally {
    end()
  }
}

async function storeOAuthGrant(
  record: OAuthStateRecord,
  code: string,
  callbackParams?: Record<string, string | undefined>,
): Promise<string> {
  const {
    orgId,
    userId,
    appName,
    connectionName,
    codeVerifier,
    tokenUrl,
    ownerType,
    ownerId,
    templateVars: stateTemplateVars,
    shopDomain: legacyShopDomain,
    accountChoice,
  } = record

  // The callback is unauthenticated: nothing set the org up in this process
  // (boot registers no org), and the connection declaration below lives in
  // its registries. A declaration already registered means the org is set up
  // (awaitOrgApps would return at once).
  if (!connectionConfigRegistry.get([orgId, appName, connectionName])) {
    const { awaitOrgApps } = await import("~/modules/apps/init")
    await awaitOrgApps(orgId)
  }

  // Reconstruct resolvedTemplateVars, merging the modern `templateVars` field
  // with the legacy `shopDomain` for states written before this was generalised.
  const resolvedTemplateVars: Record<string, string> = { ...stateTemplateVars }
  if (!resolvedTemplateVars["shop"] && legacyShopDomain) {
    resolvedTemplateVars["shop"] = legacyShopDomain
  }

  // Resolve ownerType for backwards compat (pre-existing states without ownerType)
  const resolvedOwnerType = ownerType ?? "user"
  const resolvedOwnerId = resolvedOwnerType === "org" ? null : (ownerId ?? userId)

  // Connection declaration (provider-quirk knobs live here). Fetched up-front so
  // the token exchange can honour `usePkce` and the long-lived exchange.
  const connConfig = connectionConfigRegistry.get([orgId, appName, connectionName])

  const provider = await resolveOAuthClientConfig({
    orgId,
    appName,
    connectionName,
    auditAction: "oauth-callback-lookup",
  })
  if (!provider) {
    const providerName = `${appName}:${connectionName}`
    throw new Error(`OAuth provider credentials not found for "${providerName}"`)
  }

  // A provider that signs its callback (Shopify) is checked before anything is
  // exchanged: the signature with the client secret (the org's or the
  // instance's, whichever this flow used), then the template variable it echoes
  // (the shop) against the one the flow was started for.
  if (connConfig?.callbackSignature === "hmac-sha256-query") {
    if (!callbackHmacValid(callbackParams ?? {}, provider.clientSecret)) {
      log.warn({ orgId, appName, connectionName }, "OAuth callback refused: bad or missing hmac")
      throw new OAuthCallbackRefusedError("signature")
    }
  }

  // A connection identified by a template variable (Shopify's shop) takes its
  // identifier from the STATE, which the authenticated start wrote: the
  // callback's echo of it is attacker-influenceable, so it must name the same
  // value or the callback is refused, and it is never stored itself.
  let templatedIdentifier: string | null = null
  const identifierVar = connConfig?.identifierVar
  if (identifierVar) {
    const rule = connConfig?.templateVars?.[identifierVar]
    if (!rule) {
      throw new Error(
        `OAuth callback for "${appName}:${connectionName}" declares identifierVar "${identifierVar}" ` +
          `but no templateVars rule for it — cannot validate the connection identifier.`,
      )
    }
    const fromState = resolvedTemplateVars[identifierVar]
      ? applyTemplateVarRule(resolvedTemplateVars[identifierVar], rule)
      : null
    if (!fromState) {
      throw new Error(
        `OAuth callback for "${appName}:${connectionName}" could not resolve a connection identifier.`,
      )
    }
    const echoed = callbackParams?.[identifierVar]
    if (echoed !== undefined && applyTemplateVarRule(echoed, rule) !== fromState) {
      log.warn(
        { orgId, appName, connectionName },
        "OAuth callback refused: its identifier is not the one the flow started for",
      )
      throw new OAuthCallbackRefusedError(identifierVar)
    }
    templatedIdentifier = fromState
  }

  // Exchange authorization code for tokens
  const redirectUri = connectionsRedirectUri()
  let tokenResponse: Response
  try {
    tokenResponse = await fetchWithRedirectValidation(
      tokenUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: provider.clientId,
          client_secret: provider.clientSecret,
          // PKCE verifier only when the connection uses PKCE (matches authorize).
          ...(connConfig?.usePkce !== false ? { code_verifier: codeVerifier } : {}),
        }).toString(),
      },
      { requireHttps: true, allowPrivateHostsInTest: true },
    )
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      throw new Error(`Unsafe token endpoint: ${err.message}`)
    }
    throw err
  }

  if (!tokenResponse.ok) {
    // Do NOT interpolate the provider response body into the thrown error — it
    // can be unbounded and may carry sensitive material (codes, hints). Log a
    // truncated body server-side for diagnostics; surface only the status.
    const body = await tokenResponse.text().catch(() => "")
    log.warn(
      { orgId, appName, connectionName, status: tokenResponse.status, body: body.slice(0, 512) },
      "OAuth token exchange failed",
    )
    throw new Error(`Token exchange failed (HTTP ${tokenResponse.status})`)
  }

  const tokens = (await tokenResponse.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    id_token?: string
    token_type?: string
    scope?: string
    [key: string]: unknown
  }

  // Capture the scopes the provider ACTUALLY granted (OAuth token responses
  // carry them space-separated per RFC 6749; Shopify comma-separates). Apps
  // persist these from the connect event (e.g. Shopify install_metadata) so
  // scope drift — the manifest now requiring scopes an old grant lacks — is
  // detectable instead of silently degrading (the 60-day order-window class).
  // Instagram Business Login names the field `permissions` (a list or a
  // comma-joined string) instead of `scope`.
  let grantedOAuthScopes = parseGrantedScopes(tokens.scope ?? tokens.permissions)

  // Optional SECOND exchange: swap the short-lived token for a long-lived one
  // (Meta Instagram Business Login). A GET to `<url>?grant_type&client_secret&
  // access_token`; the returned access_token replaces the short-lived one. Any
  // identifier field (e.g. `user_id`) from the FIRST response stays on `tokens`.
  if (connConfig?.longLivedTokenUrl && tokens.access_token) {
    const llParams = new URLSearchParams({
      grant_type: connConfig.longLivedTokenGrantType ?? "ig_exchange_token",
      client_secret: provider.clientSecret,
    })
    // Facebook's fb_exchange_token grant carries the short-lived token under a
    // DIFFERENTLY named param (`fb_exchange_token`) and additionally requires
    // client_id; Instagram's ig_exchange_token uses `access_token` and no
    // client_id. Both are configurable so one code path serves both providers.
    if (connConfig.longLivedIncludeClientId) llParams.set("client_id", provider.clientId)
    llParams.set(connConfig.longLivedTokenParamName ?? "access_token", tokens.access_token)
    let llResponse: Response
    try {
      llResponse = await fetchWithRedirectValidation(
        `${connConfig.longLivedTokenUrl}?${llParams.toString()}`,
        { method: "GET", headers: { Accept: "application/json" } },
        { requireHttps: true, allowPrivateHostsInTest: true },
      )
    } catch (err) {
      if (err instanceof UnsafeOutboundUrlError) {
        throw new Error(`Unsafe long-lived token endpoint: ${err.message}`)
      }
      throw err
    }
    if (!llResponse.ok) {
      const body = await llResponse.text().catch(() => "")
      log.warn(
        { orgId, appName, connectionName, status: llResponse.status, body: body.slice(0, 512) },
        "Long-lived token exchange failed",
      )
      throw new Error(`Long-lived token exchange failed (HTTP ${llResponse.status})`)
    }
    const llTokens = (await llResponse.json()) as { access_token?: string; expires_in?: number }
    if (llTokens.access_token) {
      tokens.access_token = llTokens.access_token
      if (llTokens.expires_in !== undefined) tokens.expires_in = llTokens.expires_in
    }
  }

  // Facebook Login's token response says nothing about which permissions the
  // user kept, so ask the provider. A connection that declares the lookup
  // trusts it over the token body; a failed lookup keeps whatever the token
  // body said (often nothing: drift unknown, as before this lookup existed).
  if (connConfig?.grantedScopesUrl && tokens.access_token) {
    const looked = await fetchGrantedScopes(connConfig.grantedScopesUrl, tokens.access_token, {
      orgId,
      appName,
      connectionName,
    })
    if (looked.length > 0) grantedOAuthScopes = looked
  }
  // The token's real expiry, when the provider says it (Meta's debug_token:
  // a Facebook user token's data access can lapse before the token itself).
  const tokenExpiry =
    connConfig?.tokenDebugUrl && tokens.access_token
      ? await fetchTokenExpiry(
          connConfig.tokenDebugUrl,
          tokens.access_token,
          `${provider.clientId}|${provider.clientSecret}`,
          { orgId, appName, connectionName },
        )
      : null

  const card = connectCardRefOf(record.card)
  await persistOAuthGrant({
    orgId,
    userId,
    appName,
    connectionName,
    ownerType: resolvedOwnerType,
    ownerId: resolvedOwnerId,
    connConfig,
    tokens,
    grantedOAuthScopes,
    tokenExpiry,
    presetIdentifier: templatedIdentifier,
    accountChoice: accountChoice ?? null,
    mintingClient: {
      source: provider.source === "deployment" ? "instance" : "org",
      clientId: provider.clientId,
    },
    clientSecret: provider.clientSecret,
    cardRequestId: card?.requestId ?? null,
  })

  return card
    ? connectCardReturnUrl(orgId, card)
    : getFrontendRedirectUrl(orgId, appSettingsPath(orgId, appName))
}

/** A connection's declaration, as its app's manifest registered it. */
type DeclaredConnection = NonNullable<ReturnType<typeof connectionConfigRegistry.get>>

/** The token response fields a stored grant reads. */
interface GrantTokens {
  access_token: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
  [key: string]: unknown
}

/** One provider grant to store as the connection's active account. */
interface GrantToStore {
  orgId: string
  userId: string
  appName: string
  connectionName: string
  ownerType: "user" | "org"
  ownerId: string | null
  connConfig: DeclaredConnection | undefined
  tokens: GrantTokens
  grantedOAuthScopes: string[]
  tokenExpiry: ProviderTokenExpiry | null
  /** The identifier known before the token (the `identifierVar` value); null resolves it from the token. */
  presetIdentifier: string | null
  accountChoice: string | null
  /** The client that minted the tokens (a refresh uses it); null when no client did. */
  mintingClient: { source: "instance" | "org"; clientId: string } | null
  /** Mirrored into the connection's `clientSecretConfigKey`; null mirrors nothing. */
  clientSecret: string | null
  cardRequestId: string | null
}

/**
 * Store a grant as the connection's active account: its identifier, the row it
 * replaces, the encrypted tokens, the mirrored client secret and the
 * `connected_account:create` event (the app's `onConnectionEstablished`), then
 * the connect cards waiting for it. Shared by the OAuth callback and
 * `connectWithAccessToken`.
 */
async function persistOAuthGrant(
  grant: GrantToStore,
): Promise<{ accountId: string; identifier: string }> {
  const {
    orgId,
    userId,
    appName,
    connectionName,
    ownerType: resolvedOwnerType,
    ownerId: resolvedOwnerId,
    connConfig,
    tokens,
    grantedOAuthScopes,
    tokenExpiry,
    presetIdentifier,
    accountChoice,
    mintingClient,
    clientSecret,
    cardRequestId,
  } = grant

  // Resolve the stored connection identifier.
  //
  // Priority:
  //   1. Connection-declared `identifierVar` (e.g. Shopify: the shop domain).
  //   2. OIDC id_token email claim.
  //   3. Userinfo endpoint email claim.
  //   4. Fallback: the acting userId.
  let identifier: string = presetIdentifier ?? userId
  const hasCustomIdentifier = presetIdentifier !== null

  // Identifier straight from a TOKEN-response field (e.g. Instagram `user_id`) --
  // for providers with no id_token/userinfo. Takes precedence over the email paths.
  const identifierFromTokenField = connConfig?.identifierFromTokenField
  if (!hasCustomIdentifier && identifierFromTokenField) {
    const tokenIdVal = tokens[identifierFromTokenField]
    if (tokenIdVal !== undefined && tokenIdVal !== null) identifier = String(tokenIdVal)
  }

  // Identifier at a path of the userinfo response (`data[].id`), for a sign-in
  // that can cover several accounts: exactly one is connected, the one the flow
  // was started for when there are several, else nothing and the person is asked.
  let pathAccountName: string | null = null
  const identifierPath = connConfig?.identifierFromUserinfoPath
  if (!hasCustomIdentifier && identifierPath) {
    const account = await userinfoPathAccount(
      connConfig,
      identifierPath,
      tokens.access_token,
      accountChoice,
      { orgId, appName, connectionName },
    )
    identifier = account.id
    pathAccountName = account.name
  }

  // Extract identifier from id_token (email) — decode JWT without verification
  // (token came directly from the provider over HTTPS)
  if (!hasCustomIdentifier && identifier === userId && tokens.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString())
      if (payload.email) identifier = payload.email
    } catch {
      log.warn({ orgId, appName }, "Failed to decode id_token for email extraction")
    }
  }

  // Fallback: fetch userinfo endpoint when id_token absent or lacked an email claim
  if (!hasCustomIdentifier && identifier === userId) {
    const userinfoUrl = connConfig?.userinfoUrl
    if (userinfoUrl && tokens.access_token) {
      try {
        const userinfoResp = await fetchWithRedirectValidation(
          userinfoUrl,
          { headers: { Authorization: `Bearer ${tokens.access_token}` } },
          { requireHttps: true },
        )
        if (userinfoResp.ok) {
          const userinfo = (await userinfoResp.json()) as Record<string, unknown>
          // Default "email" (OIDC); Meta/Facebook use "id" (GET /me -> user id).
          const field = connConfig?.identifierFromUserinfoField ?? "email"
          const value = userinfo[field]
          if (value !== undefined && value !== null) identifier = String(value)
        }
      } catch (err) {
        log.warn(
          { orgId, appName, err },
          "Userinfo endpoint fallback failed; using userId as identifier",
        )
      }
    }
  }

  // A mailbox outside the org's allowed domains is refused before its tokens
  // are stored (mail-domains.ts); the callback route shows the reason.
  await assertMailboxAllowed(orgId, connectionName, identifier)

  // A provider whose identifier is an opaque id (Meta) names the account from
  // its own lookup, so Settings shows the account by name.
  const displayName =
    (await fetchAccountDisplayName(connConfig, tokens.access_token, {
      orgId,
      appName,
      connectionName,
    })) ?? pathAccountName

  const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null

  // A connection whose org and personal rows read disjoint data (Drive: the
  // org row only the chosen Shared Drives, the personal row that person's own
  // Drive) lets one account hold both (app-registries.ts orgAndPersonalCoexist).
  // Each owner then replaces only its own row, and nothing is taken over.
  const ownersCoexist = connConfig?.orgAndPersonalCoexist === true

  const accountId = await withPrivilegedDb(orgId, "oauth-callback-store", async (tx) => {
    // A personal connect may only replace the SAME owner's previous row. An
    // active row held by the org (or another member) for this identifier stays
    // untouched and the connect is refused: retiring it would silently convert a
    // shared connection into one person's (see ConnectionHeldByOtherOwnerError).
    // An org connect keeps superseding any holder below (it needs admin scope).
    if (resolvedOwnerType === "user") {
      const holders = await tx
        .select({ ownerType: connectedAccounts.ownerType, ownerId: connectedAccounts.ownerId })
        .from(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.orgId, orgId),
            eq(connectedAccounts.appName, appName),
            eq(connectedAccounts.connectionName, connectionName),
            eq(connectedAccounts.identifier, identifier),
            eq(connectedAccounts.status, "active"),
          ),
        )
      // Where the owners coexist the org's row is no obstacle; another
      // member's personal row of the account still is (one person per account).
      const foreign = holders.find((h) =>
        ownersCoexist
          ? h.ownerType === "user" && h.ownerId !== resolvedOwnerId
          : h.ownerType !== "user" || h.ownerId !== resolvedOwnerId,
      )
      if (foreign) {
        log.warn(
          { orgId, appName, connectionName, heldBy: foreign.ownerType },
          "Personal OAuth connect refused: the account is held by another owner",
        )
        throw new ConnectionHeldByOtherOwnerError(
          appName,
          foreign.ownerType === "org" ? "org" : "user",
          await mayConnectForOrg(tx, { orgId, userId, appName, connectionName }),
        )
      }
    }

    // WHY AN OAUTH ORG CONNECT TAKES OVER WITHOUT A CONFIRM (the credentials save
    // asks for `takeOver`): the person finishing this callback signed in AS this
    // account at the provider and consented, which proves they control it; and a
    // redirect has no place to ask. What it does share with the credentials
    // path: a member's personal row it retires is announced (an audited
    // disconnect and an alert to that member, announceTakenOverAccounts).
    // The org's mailbox cap (modules/org/caps.ts), under its mailboxes lock. A
    // reconnect of a connected address replaces its row below and adds nothing.
    if (isMailboxConnection(connectionName)) {
      await assertMailboxRoom(tx, orgId, identifier)
    }

    const takenOver =
      resolvedOwnerType === "org" && !ownersCoexist
        ? await tx
            .select({
              id: connectedAccounts.id,
              ownerType: connectedAccounts.ownerType,
              ownerId: connectedAccounts.ownerId,
            })
            .from(connectedAccounts)
            .where(
              and(
                eq(connectedAccounts.orgId, orgId),
                eq(connectedAccounts.appName, appName),
                eq(connectedAccounts.connectionName, connectionName),
                eq(connectedAccounts.identifier, identifier),
                eq(connectedAccounts.status, "active"),
                eq(connectedAccounts.ownerType, "user"),
              ),
            )
        : []

    // Deactivate the existing active account for this exact identifier+connection.
    // The unique index `connected_accounts_unique_active_owner_idx` is keyed on
    // (org, app, connection, identifier, owner_type) WHERE status='active'
    // (migration 0239). Where the owners do not coexist (every connection but
    // those declaring `orgAndPersonalCoexist`) the account has ONE owner: the
    // deactivate matches any owner, so an org connect retires a member's row
    // (announced above) and the account never ends up with two holders. Where
    // they coexist only this owner type's row is replaced: a personal connect
    // never retires the org's row, nor an org connect the member's.
    // The replaced row's tokens are dropped, not revoked: the provider usually hands the
    // reconnect the same grant, which a revocation would end.
    const replaced = await tx
      .update(connectedAccounts)
      .set({
        status: "disconnected",
        disconnectedAt: new Date(),
        updatedAt: new Date(),
        ...CLEARED_SECRETS,
      })
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, appName),
          eq(connectedAccounts.connectionName, connectionName),
          eq(connectedAccounts.identifier, identifier),
          eq(connectedAccounts.status, "active"),
          ...(ownersCoexist ? [eq(connectedAccounts.ownerType, resolvedOwnerType)] : []),
        ),
      )
      .returning({
        metadata: connectedAccounts.metadata,
        ownerType: connectedAccounts.ownerType,
        ownerId: connectedAccounts.ownerId,
      })
    // What the app keeps on the account (`ctx.accounts.setMetadata`: a choice made
    // on it, such as the files a person picked at the provider or the shared drives
    // an admin chose) belongs to the account, so a reconnect of the same account by
    // the same owner keeps it; another owner's never follows the account.
    const previous = replaced.find(
      (r) => r.ownerType === resolvedOwnerType && (r.ownerId ?? null) === (resolvedOwnerId ?? null),
    )
    const appMetadata = Object.fromEntries(
      Object.entries(previous?.metadata ?? {}).filter(([k]) => !isKernelAccountMetadataKey(k)),
    )
    // Kernel-owned keys (connections/kernel-account-metadata.ts) are this connect's
    // own: app code may not write them through ctx.accounts.setMetadata.
    const kernelMetadata: Partial<Record<KernelAccountMetadataKey, unknown>> = {
      ...(grantedOAuthScopes.length > 0 ? { grantedOAuthScopes } : {}),
      ...(tokenExpiry ? { tokenExpiry } : {}),
    }
    const accountMetadata: Record<string, unknown> = { ...appMetadata, ...kernelMetadata }
    await announceTakenOverAccounts(tx, {
      orgId,
      actorId: userId,
      rows: takenOver.map((r) => ({ ...r, appName, connectionName, identifier })),
    })

    const [account] = await tx
      .insert(connectedAccounts)
      .values({
        orgId,
        appName,
        connectionName,
        ownerType: resolvedOwnerType,
        ownerId: resolvedOwnerId,
        providerType: "oauth2",
        identifier,
        displayName,
        accessTokenEncrypted: encryptSecret(
          tokens.access_token,
          ENCRYPTION_KEY,
          CryptoContext.connectedAccountAccessToken,
        ),
        refreshTokenEncrypted: tokens.refresh_token
          ? encryptSecret(
              tokens.refresh_token,
              ENCRYPTION_KEY,
              CryptoContext.connectedAccountRefreshToken,
            )
          : null,
        tokenExpiresAt: expiresAt,
        status: "active",
        createdBy: userId,
        // The client that minted these tokens: refresh and webhook checks keep
        // using it after the workspace saves another (oauth-client.ts).
        oauthClientSource: mintingClient?.source ?? null,
        oauthClientId: mintingClient?.clientId ?? null,
        // Persist the granted scopes kernel-side too (not only on the connect
        // event) so the generic connection-health attention provider can flag
        // scope DRIFT — a healthy connection whose grant now lacks scopes the
        // manifest requires — without any app-specific storage.
        ...(Object.keys(accountMetadata).length > 0 ? { metadata: accountMetadata } : {}),
      })
      .returning()

    // Some providers (e.g. Shopify) sign webhook deliveries with the same secret
    // as the OAuth client secret, which the app's sandboxed verifier reads via
    // `config_get(<key>)`. A connection declares `clientSecretConfigKey` to have
    // the kernel mirror the OAuth client secret into `apps.config` under that key
    // once the connection is established — keeping app-specific names out of the
    // kernel. We merge into the existing config jsonb (never clobber other keys)
    // and never log the secret.
    if (connConfig?.clientSecretConfigKey && clientSecret) {
      // The app row already exists (OAuth can only run after the app is
      // installed/registered), so merge the secret into the existing config
      // jsonb. We update rather than upsert to avoid the NOT NULL `version`
      // constraint on a fresh insert.
      //
      // Encrypt at rest: the mirrored client secret is a credential, so it is
      // stored as ciphertext (AES-256-GCM, AAD-bound to
      // `appConfigConnectionSecret`) — never plaintext. It is decrypted only at
      // the two `config_get` bridges (webhooks verifier + sandbox
      // `ctx.config.get`) right before the (sandboxed) consumer needs the
      // plaintext to compute the HMAC; the ENCRYPTION_KEY never enters the sandbox.
      // Resolve from the LIVE env (falling back to the module-load capture) so
      // this encrypt-at-write uses the SAME key the decrypt-at-read bridge
      // (`decryptConnectionConfigValue`, same default) resolves — otherwise a key
      // set after module load would write ciphertext the bridge cannot
      // authenticate (AES-GCM tag failure), silently breaking webhook HMAC verify.
      const configEncKey = process.env.ENCRYPTION_KEY ?? ENCRYPTION_KEY
      const overlayJson = JSON.stringify({
        [connConfig.clientSecretConfigKey]: encryptSecret(
          clientSecret,
          configEncKey,
          CryptoContext.appConfigConnectionSecret,
        ),
      })
      await tx
        .update(appsTable)
        .set({
          config: drizzleSql`coalesce(${appsTable.config}, '{}'::jsonb) || ${overlayJson}::jsonb`,
          updatedAt: new Date(),
        })
        .where(and(eq(appsTable.orgId, orgId), eq(appsTable.name, appName)))
    }

    // Emit connected_account:create event via transactional outbox.
    // `kernelPublicBaseUrl` is the public origin where the kernel webhook
    // routes are reachable from third-party APIs (the org's own host when orgs
    // have hosts, so deliveries follow the org through a cell move); subscribed app handlers
    // (e.g. Shopify's `onConnectionEstablished`) need this to register
    // webhook subscriptions with the upstream provider pointing back at
    // /webhooks/<orgId>/<appName>/<endpoint> (the kernel mounts webhookRoutes
    // at /webhooks — there is NO /api prefix; see app.ts + webhooks/routes.ts).
    await tx.queueEvent({
      app: "kernel",
      entity: "connected_account",
      action: "create",
      entityId: account.id,
      data: {
        id: account.id,
        orgId,
        appName,
        connectionName,
        ownerType: resolvedOwnerType,
        ownerId: resolvedOwnerId,
        providerType: "oauth2",
        identifier,
        status: "active",
        kernelPublicBaseUrl: await orgPublicBaseUrl(orgId),
        grantedOAuthScopes,
      },
      actorId: userId,
      actorType: "user",
      orgId,
      timestamp: new Date().toISOString(),
    })

    return account.id
  }).catch(async (err: unknown) => {
    // The refusal also lands in the person's attention feed (announceConnectRefused).
    if (err instanceof ConnectionHeldByOtherOwnerError && resolvedOwnerId) {
      await announceConnectRefused({
        orgId,
        userId: resolvedOwnerId,
        appName,
        connectionName,
        identifier,
        message: err.message,
      })
    }
    throw err
  })

  log.info({ orgId, userId, appName, connectionName, accountId }, "OAuth connection established")

  // A connect card waiting for this connection is saved now, from the account
  // just stored (secret-requests/connect-settle.ts); so is one a connect made
  // in Settings answers. Loaded lazily: the secret requests import this module.
  const { settleConnectRequests } = await import("~/modules/secret-requests/connect-settle")
  await settleConnectRequests({
    orgId,
    userId,
    appName,
    connectionName,
    ownerType: resolvedOwnerType,
    accountId,
    cardRequestId,
  })

  return { accountId, identifier }
}

/**
 * Connect an OAuth connection with an access token the provider issued without
 * a consent screen (a Shopify custom app's Admin API token), for an operator
 * with shell access (`liaison connect --token-env`). Everything after the code
 * exchange is the OAuth callback's own (`persistOAuthGrant`): the replaced row,
 * the encrypted token, the mirrored client secret, the `connected_account:create`
 * event. The connection is the org's. No client minted the token, so none is
 * recorded and nothing refreshes it.
 */
export async function connectWithAccessToken(args: {
  orgId: string
  /** The member the connection is attributed to (`created_by`, the event's actor). */
  userId: string
  appName: string
  connectionName: string
  accessToken: string
  /** The account: the `identifierVar` value (a shop domain) when the connection declares one. */
  account?: string
  /** Mirrored into the connection's `clientSecretConfigKey` (webhook signatures). */
  clientSecret?: string
  /** The scopes the token holds, when the provider has no lookup for them. */
  grantedScopes?: string[]
}): Promise<{ accountId: string; identifier: string }> {
  const { orgId, userId, appName, connectionName } = args
  await assertDemoEgressAllowed(orgId, "connector_credentials")
  if (!connectionConfigRegistry.get([orgId, appName, connectionName])) {
    const { awaitOrgApps } = await import("~/modules/apps/init")
    await awaitOrgApps(orgId)
  }
  const connConfig = connectionConfigRegistry.get([orgId, appName, connectionName])
  if (!connConfig) {
    throw new Error(`Connection "${connectionName}" not declared in app "${appName}" manifest`)
  }
  if (connConfig.type !== "oauth2") {
    throw new Error(`Connection "${connectionName}" is not an OAuth2 connection`)
  }
  if (!(await isAppActiveForOrgAsync(orgId, appName))) {
    throw new OAuthAppDisabledError(appName, appSettingsPath(orgId, appName))
  }
  if (args.accessToken.trim() === "") throw new Error("The access token is empty")

  let presetIdentifier: string | null = args.account?.trim() || null
  const identifierVar = connConfig.identifierVar
  if (identifierVar) {
    const rule = connConfig.templateVars?.[identifierVar]
    if (!rule) {
      throw new Error(
        `Connection "${appName}:${connectionName}" declares identifierVar "${identifierVar}" ` +
          "but no templateVars rule for it",
      )
    }
    presetIdentifier = presetIdentifier ? applyTemplateVarRule(presetIdentifier, rule) : null
    if (!presetIdentifier) {
      throw new Error(
        `Connection "${appName}:${connectionName}" needs a valid "${identifierVar}" as its account`,
      )
    }
  }

  let grantedOAuthScopes = args.grantedScopes ?? []
  if (connConfig.grantedScopesUrl) {
    const looked = await fetchGrantedScopes(connConfig.grantedScopesUrl, args.accessToken, {
      orgId,
      appName,
      connectionName,
    })
    if (looked.length > 0) grantedOAuthScopes = looked
  }

  const { assertOrgAcceptsWrites } = await import("~/modules/org/transfer-state/gate")
  const { beginOrgActivity } = await import("~/modules/org/transfer-state/state")
  const end = beginOrgActivity(orgId, "writes")
  try {
    await assertOrgAcceptsWrites(orgId)
    return await persistOAuthGrant({
      orgId,
      userId,
      appName,
      connectionName,
      ownerType: "org",
      ownerId: null,
      connConfig,
      tokens: { access_token: args.accessToken },
      grantedOAuthScopes,
      tokenExpiry: null,
      presetIdentifier,
      accountChoice: null,
      mintingClient: null,
      clientSecret: args.clientSecret ?? null,
      cardRequestId: null,
    })
  } finally {
    end()
  }
}

export { getFrontendRedirectUrl }

/** One connected account of an app, as its own settings surface shows it. No secrets. */
export interface ConnectionAccountStatus {
  id: string
  identifier: string
  displayName: string | null
  ownerType: "org" | "user"
  /** The row is the caller's own personal connection. */
  isMine: boolean
  status: "active" | "error"
  statusMessage: string | null
  tokenExpiresAt: string | null
  /**
   * A refresh token is stored, so the kernel renews the access token on its
   * own when it expires. The token itself never leaves the kernel.
   */
  hasRefreshToken: boolean
  connectedByName: string | null
  connectedAt: string
  updatedAt: string
}

/**
 * The name an account is shown by (S7): its display name, else its identifier
 * when that reads as a name (an email, a handle, a host). A bare numeric id
 * (a page or account number) or a UUID (the person's own id, stored when the
 * provider gave no account identity) is no name: null, and the surface names
 * the account by its connection instead.
 */
export function connectionAccountLabel(
  a: Pick<ConnectionAccountStatus, "displayName" | "identifier">,
): string | null {
  const name = a.displayName?.trim()
  if (name) return name
  const id = a.identifier.trim()
  // A UUID is the person's own id, stored when the provider gave no account identity.
  return id && !/^\d+$/.test(id) && !UUID_RE.test(id) ? id : null
}

/**
 * The calling app's accounts for one connection, with who connected them,
 * whether they are org or personal, their health, token expiry and whether a
 * refresh token is stored. The same
 * visibility rule as Settings > Apps' counts (connection-overview.ts): the
 * org's own rows plus the caller's personal ones, active or broken. Privileged
 * because org-owned app rows are invisible to RLS; the WHERE clause is the
 * whole visibility rule, and only non-secret columns are read.
 */
export async function describeConnectionAccounts(
  orgId: string,
  userId: string,
  appName: string,
  connectionName: string,
): Promise<ConnectionAccountStatus[]> {
  if (!isRealOrgId(orgId)) return []
  const rows = await withPrivilegedDb(orgId, "connected-accounts-app-describe", (ptx) =>
    ptx
      .select({
        id: connectedAccounts.id,
        identifier: connectedAccounts.identifier,
        displayName: connectedAccounts.displayName,
        ownerType: connectedAccounts.ownerType,
        ownerId: connectedAccounts.ownerId,
        status: connectedAccounts.status,
        statusMessage: connectedAccounts.statusMessage,
        tokenExpiresAt: connectedAccounts.tokenExpiresAt,
        hasRefreshToken: drizzleSql<boolean>`${connectedAccounts.refreshTokenEncrypted} IS NOT NULL`,
        connectedByName: users.name,
        createdAt: connectedAccounts.createdAt,
        updatedAt: connectedAccounts.updatedAt,
      })
      .from(connectedAccounts)
      .leftJoin(users, eq(users.id, connectedAccounts.createdBy))
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, appName),
          eq(connectedAccounts.connectionName, connectionName),
          drizzleSql`${connectedAccounts.status} IN ('active', 'error')`,
          drizzleSql`(${connectedAccounts.ownerType} = 'org' OR ${connectedAccounts.ownerId} = ${userId})`,
        ),
      )
      .orderBy(desc(connectedAccounts.updatedAt)),
  )
  return rows.map((r) => ({
    id: r.id,
    identifier: r.identifier,
    displayName: r.displayName,
    ownerType: r.ownerType === "org" ? "org" : "user",
    isMine: r.ownerType === "user" && r.ownerId === userId,
    status: r.status === "error" ? "error" : "active",
    statusMessage: r.statusMessage,
    tokenExpiresAt: r.tokenExpiresAt ? r.tokenExpiresAt.toISOString() : null,
    hasRefreshToken: r.hasRefreshToken === true,
    connectedByName: r.connectedByName ?? null,
    connectedAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))
}

export async function listConnectionAccounts(
  tx: RlsClient,
  orgId: string,
  _userId: string,
  appName: string,
  connectionName: string,
): Promise<Array<{ id: string; identifier: string; displayName: string | null; status: string }>> {
  if (appName === "mail") {
    const appMailSchema = quoteIdent(schemaRef("app_mail"))
    const rows = extractRows<{
      connected_account_id: string
      email_address: string
      display_name: string | null
      sync_status: string
    }>(
      await tx.execute(drizzleSql`
        SELECT connected_account_id, email_address, display_name, sync_status
        FROM ${drizzleSql.raw(`${appMailSchema}.accounts`)}
        WHERE org_id = ${orgId}
          AND provider = ${connectionName}
          AND disconnected_at IS NULL
        ORDER BY email_address ASC
      `),
    )
    if (rows.length > 0) {
      return rows.map((row) => ({
        id: row.connected_account_id,
        identifier: row.email_address,
        displayName: row.display_name,
        status: row.sync_status,
      }))
    }
  }

  const cols = {
    id: connectedAccounts.id,
    identifier: connectedAccounts.identifier,
    displayName: connectedAccounts.displayName,
    status: connectedAccounts.status,
  }
  const baseConditions = [
    eq(connectedAccounts.orgId, orgId),
    eq(connectedAccounts.appName, appName),
    eq(connectedAccounts.connectionName, connectionName),
    eq(connectedAccounts.status, "active"),
  ]

  // RLS-scoped read first (user-owned connections + the unit-test mock tx).
  // System / cross-app actors resolve to the nil uuid in `withRlsContext`, so
  // this read returns empty for them (rather than crashing the policy's
  // `current_user_id::uuid` cast) and falls through to the kernel-privileged
  // org-owned path below.
  const rlsRows = await tx
    .select(cols)
    .from(connectedAccounts)
    .where(and(...baseConditions))
  if (rlsRows.length > 0 || !isRealOrgId(orgId)) return rlsRows

  // Org-owned app connections are invisible to RLS (see loadConnectedAccounts) —
  // when the RLS read finds nothing, resolve them via the kernel-privileged path
  // scoped to this app+org + owner_type='org'.
  return withPrivilegedDb(orgId, "connected-accounts-app-list", (ptx) =>
    ptx
      .select(cols)
      .from(connectedAccounts)
      .where(and(...baseConditions, eq(connectedAccounts.ownerType, "org"))),
  )
}
