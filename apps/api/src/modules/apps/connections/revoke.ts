// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a removed OAuth connection still owes its provider, done durably.
//
// Removing a connection (disconnecting it, erasing the person who owns it, purging
// its org) must not leave anything live at the provider. Two things, in order, while
// a token still exists:
//   1. Stop the push watch. A connection declares where with `watchStopUrl` in its
//      manifest (Gmail: users.stop); nothing else ends a Gmail watch before it lapses.
//   2. Revoke the grant (RFC 7009). A connection declares where with `revocationUrl`;
//      Google is `https://oauth2.googleapis.com/revoke`.
// A connection that declares neither has nothing to do; its tokens are simply deleted.
//
// The transaction that removes the connection moves its encrypted tokens, unchanged,
// into a `kernel.connection_teardowns` row (`stageConnectionTeardown`), so a rollback
// leaves everything as it was and a commit leaves work that ANY process can finish:
// no provider call runs inside the transaction, and nothing lives in one process's
// memory. The row is then worked off by whichever comes first:
//   - the caller that owns the transaction, right after it returns
//     (`runConnectionTeardown`);
//   - the `connected_account:disconnect` outbox event, for callers that do not own
//     their transaction (an app's sandboxed disconnect tool). The outbox drains in
//     the worker process, not in the api process that took the request;
//   - the leader's sweep (`registerConnectionTeardownSweep`), which retries what a
//     provider outage or a dead process left, with a growing delay. After
//     `TEARDOWN_MAX_AGE_MS` the row, and with it the tokens, is dropped and the
//     failure logged with `alert: "connection_teardown_gave_up"`.
// Claiming a row is atomic, so two of them never work the same row at once.
//
// One grant, several connections: a provider such as Google keeps ONE grant per
// (user, OAuth client), and revoking any token of it revokes all of it. Mail, Tickets,
// Calendar and Drive connect the same Google account through the same client, so
// revoking on a Mail disconnect would silently cut the Calendar connection of the same
// address. Gmail likewise keeps one watch per mailbox and project, so a stop would
// silence Tickets on the same address, while Calendar does not care. Both checks look,
// when the work runs (`isAccountUsedElsewhere`), for another ACTIVE connection on this
// instance (any org) holding the account at the same endpoint, the row itself
// included: a person who reconnected meanwhile keeps the grant and the new watch, and
// the old tokens are just dropped. Google sign-in holds no token here, so it does not
// count: revoking never signs anyone out of Liaison.

import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  type ConnectionTeardownRow,
  connectedAccounts,
  connectionTeardowns,
} from "~/db/schema/kernel"
import type { DurableEventContext } from "~/infra/events/durable-consumers"
import { registerDurableEventConsumer } from "~/infra/events/durable-consumers"
import { registerSingleton } from "~/infra/leadership"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { fetchWithRedirectValidation } from "~/lib/outbound-fetch"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { resolveRefreshClient } from "~/modules/apps/connections/oauth-client-config"

const REVOKE_TIMEOUT_MS = 5_000
/** A claim holds a row this long; a process that dies frees it for the sweep then. */
const TEARDOWN_LEASE_MS = 2 * 60_000
/** Delay after the Nth failed attempt; the last one repeats until the row expires. */
const TEARDOWN_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  3_600_000,
  4 * 3_600_000,
  8 * 3_600_000,
]
/** How long tokens may wait for a provider that keeps failing. */
const TEARDOWN_MAX_AGE_MS = 72 * 3_600_000
const TEARDOWN_SWEEP_MS = 60_000
const TEARDOWN_SWEEP_BATCH = 20

/** The columns revocation needs from a `kernel.connected_accounts` row. */
export interface RevocableConnection {
  id: string
  orgId: string
  appName: string
  connectionName: string
  providerType: string
  identifier: string
  accessTokenEncrypted: string | null
  refreshTokenEncrypted: string | null
}

export type RevokeOutcome =
  | { status: "revoked" }
  /** The provider says the token is already invalid (revoked or expired). */
  | { status: "already_invalid" }
  | {
      status: "skipped"
      reason: "not_oauth" | "no_revocation_url" | "no_token" | "grant_shared"
    }
  /** `transient`: the provider may answer later (a network failure, a 429 or a 5xx). */
  | { status: "failed"; reason: string; transient: boolean }

/** The revocation endpoint a connection declares, or null. */
export function revocationUrlFor(
  orgId: string,
  appName: string,
  connectionName: string,
): string | null {
  const config = connectionConfigRegistry.get([orgId, appName, connectionName])
  return config?.revocationUrl ?? null
}

type SharedEndpoint = "revocationUrl" | "watchStopUrl"

/**
 * Whether an ACTIVE OAuth2 connection, in ANY org of this instance, holds this provider
 * account (identifier, case-insensitive) at the same endpoint. Runs after the removal
 * committed, so the removed connection counts only if it was reconnected meanwhile. A
 * system read across orgs, so it answers only a boolean: no other org's row, id or app
 * leaves this function.
 *
 * Another org's endpoint comes from that org's registered config, else this org's for
 * the same app and connection (same manifest, same URL), else that org's apps are
 * loaded here. A connection whose config cannot be found counts as using it: leaving a
 * grant in place is the error that can be recovered from, cutting a live one is not.
 */
export async function isAccountUsedElsewhere(
  conn: Pick<RevocableConnection, "orgId" | "identifier">,
  endpoint: SharedEndpoint,
  url: string,
): Promise<boolean> {
  const rows = await withSystemDb("oauth-teardown-account-in-use", (tx) =>
    tx
      .select({
        orgId: connectedAccounts.orgId,
        appName: connectedAccounts.appName,
        connectionName: connectedAccounts.connectionName,
      })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.status, "active"),
          eq(connectedAccounts.providerType, "oauth2"),
          drizzleSql`lower(${connectedAccounts.identifier}) = lower(${conn.identifier})`,
        ),
      ),
  )
  for (const r of rows) {
    let config =
      connectionConfigRegistry.get([r.orgId, r.appName, r.connectionName]) ??
      connectionConfigRegistry.get([conn.orgId, r.appName, r.connectionName])
    if (!config) {
      await loadOrgApps(r.orgId)
      config = connectionConfigRegistry.get([r.orgId, r.appName, r.connectionName])
    }
    if (!config || config[endpoint] === url) return true
  }
  return false
}

/** Load an org's apps into this process's registries. A failure leaves them unloaded. */
async function loadOrgApps(orgId: string): Promise<void> {
  try {
    const { ensureAppsForOrg } = await import("~/modules/apps/init")
    await ensureAppsForOrg(orgId)
  } catch (err) {
    log.warn(
      { orgId, err: (err as Error).message },
      "Connection teardown: could not load the org's apps",
    )
  }
}

function decryptOrNull(value: string | null, context: string): string | null {
  if (!value) return null
  try {
    return decryptSecret(value, process.env.ENCRYPTION_KEY ?? env.ENCRYPTION_KEY, context)
  } catch {
    return null
  }
}

/**
 * Ask the provider to revoke a connection's grant. Sends the refresh token when
 * one is stored (revoking it ends the whole grant, access tokens included), else
 * the access token. Never throws.
 */
export async function revokeConnectionGrant(
  conn: RevocableConnection,
  declaredUrl?: string | null,
): Promise<RevokeOutcome> {
  const logCtx = {
    orgId: conn.orgId,
    appName: conn.appName,
    connectionName: conn.connectionName,
    connectionId: conn.id,
  }
  if (conn.providerType !== "oauth2") return { status: "skipped", reason: "not_oauth" }
  const url = declaredUrl ?? revocationUrlFor(conn.orgId, conn.appName, conn.connectionName)
  if (!url) return { status: "skipped", reason: "no_revocation_url" }

  const refresh = decryptOrNull(
    conn.refreshTokenEncrypted,
    CryptoContext.connectedAccountRefreshToken,
  )
  const access = refresh
    ? null
    : decryptOrNull(conn.accessTokenEncrypted, CryptoContext.connectedAccountAccessToken)
  const token = refresh ?? access
  if (!token) return { status: "skipped", reason: "no_token" }

  let res: Response
  try {
    res = await fetchWithRedirectValidation(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          token,
          token_type_hint: refresh ? "refresh_token" : "access_token",
        }).toString(),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      },
      { requireHttps: true, allowPrivateHostsInTest: true },
    )
  } catch (err) {
    const reason = (err as Error).message
    log.warn({ ...logCtx, err: reason }, "OAuth grant revocation request failed")
    return { status: "failed", reason, transient: true }
  }

  if (res.ok) {
    log.info(logCtx, "OAuth grant revoked at the provider")
    return { status: "revoked" }
  }
  const body = await res.text().catch(() => "")
  // RFC 7009 / Google: an already revoked or expired token answers 400
  // `invalid_token` (Google also says `invalid_grant`). The grant is gone either way.
  if (res.status === 400 && /invalid_token|invalid_grant/.test(body)) {
    log.info(logCtx, "OAuth grant was already invalid at the provider")
    return { status: "already_invalid" }
  }
  log.warn(
    { ...logCtx, status: res.status, body: body.slice(0, 256) },
    "OAuth grant revocation refused by the provider",
  )
  return {
    status: "failed",
    reason: `HTTP ${res.status}`,
    transient: isTransientStatus(res.status),
  }
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500
}

// ---------------------------------------------------------------------------
// Staging, inside the removing transaction
// ---------------------------------------------------------------------------

/** What staging needs from a connection row. */
export interface StageableConnection extends RevocableConnection {
  oauthClientSource: string | null
  oauthClientId: string | null
  tokenExpiresAt: Date | string | null
}

/** Either handle: `insert` is all it uses, and a request role may only insert its own org's row. */
interface TeardownWriter {
  insert: (table: typeof connectionTeardowns) => {
    values: (row: typeof connectionTeardowns.$inferInsert) => PromiseLike<unknown>
  }
}

/**
 * Record, in the transaction that removes the connection, what it still owes its
 * provider. Call it before the tokens are cleared. A connection whose app is loaded here
 * and declares nothing has nothing owed; an app not loaded in this process is resolved
 * by the process that does the work.
 */
export async function stageConnectionTeardown(
  tx: TeardownWriter,
  conn: StageableConnection,
): Promise<void> {
  if (conn.providerType !== "oauth2") return
  if (!conn.refreshTokenEncrypted && !conn.accessTokenEncrypted) return
  const config = connectionConfigRegistry.get([conn.orgId, conn.appName, conn.connectionName])
  if (config && !config.revocationUrl && !config.watchStopUrl) return
  await tx.insert(connectionTeardowns).values({
    sourceOrgId: conn.orgId,
    connectionId: conn.id,
    appName: conn.appName,
    connectionName: conn.connectionName,
    identifier: conn.identifier,
    oauthClientSource: conn.oauthClientSource,
    oauthClientId: conn.oauthClientId,
    accessTokenEncrypted: conn.accessTokenEncrypted,
    refreshTokenEncrypted: conn.refreshTokenEncrypted,
    tokenExpiresAt: conn.tokenExpiresAt ? new Date(conn.tokenExpiresAt) : null,
    revocationUrl: config?.revocationUrl ?? null,
    watchStopUrl: config?.watchStopUrl ?? null,
    tokenUrl: config?.refreshTokenUrl ?? config?.tokenUrl ?? null,
  })
}

// ---------------------------------------------------------------------------
// Working a row off, after the commit
// ---------------------------------------------------------------------------

export type WatchStopOutcome =
  | "stopped"
  | "no_watch_declared"
  | "still_used"
  /** The provider rejected the tokens: the grant is already gone. */
  | "token_invalid"
  /** The access token expired and the client that minted it is gone (an org's own client). */
  | "no_usable_token"
  | "refused"

export type TeardownOutcome =
  | { status: "done"; watch: WatchStopOutcome; grant: RevokeOutcome["status"] | "still_used" }
  | { status: "retry"; reason: string }
  | { status: "gave_up"; reason: string }

type Attempt<T> = { retry: string } | { value: T }

function claimedRowFromSql(r: Record<string, unknown>): ConnectionTeardownRow {
  const date = (v: unknown) => (v ? new Date(v as string) : null)
  return {
    id: r.id as string,
    sourceOrgId: r.source_org_id as string,
    connectionId: r.connection_id as string,
    appName: r.app_name as string,
    connectionName: r.connection_name as string,
    identifier: r.identifier as string,
    oauthClientSource: (r.oauth_client_source as string | null) ?? null,
    oauthClientId: (r.oauth_client_id as string | null) ?? null,
    accessTokenEncrypted: (r.access_token_encrypted as string | null) ?? null,
    refreshTokenEncrypted: (r.refresh_token_encrypted as string | null) ?? null,
    tokenExpiresAt: date(r.token_expires_at),
    revocationUrl: (r.revocation_url as string | null) ?? null,
    watchStopUrl: (r.watch_stop_url as string | null) ?? null,
    tokenUrl: (r.token_url as string | null) ?? null,
    attempts: Number(r.attempts),
    nextAttemptAt: date(r.next_attempt_at) as Date,
    lastError: (r.last_error as string | null) ?? null,
    createdAt: date(r.created_at) as Date,
  }
}

/** Take due rows (all, or one connection's), holding each for the lease. */
async function claimTeardowns(
  filter: { connectionId: string } | { limit: number },
): Promise<ConnectionTeardownRow[]> {
  const leaseUntil = new Date(Date.now() + TEARDOWN_LEASE_MS).toISOString()
  const scope =
    "connectionId" in filter
      ? drizzleSql`connection_id = ${filter.connectionId}::uuid`
      : drizzleSql`true`
  const limit = "limit" in filter ? filter.limit : 10
  const rows = await withSystemDb("connection-teardown-claim", (tx) =>
    tx.execute(drizzleSql`
      UPDATE ${connectionTeardowns}
      SET attempts = attempts + 1, next_attempt_at = ${leaseUntil}::timestamptz
      WHERE id IN (
        SELECT id FROM ${connectionTeardowns}
        WHERE next_attempt_at <= now() AND ${scope}
        ORDER BY next_attempt_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `),
  )
  return extractRows<Record<string, unknown>>(rows).map(claimedRowFromSql)
}

async function finishTeardown(id: string): Promise<void> {
  await withSystemDb("connection-teardown-finish", (tx) =>
    tx.delete(connectionTeardowns).where(eq(connectionTeardowns.id, id)),
  )
}

/** A new access token for the stop, used once and never stored. */
async function refreshedAccessToken(
  row: ConnectionTeardownRow,
  config: { tokenUrl: string | null },
): Promise<Attempt<string | "token_invalid" | "no_usable_token">> {
  const refreshToken = decryptOrNull(
    row.refreshTokenEncrypted,
    CryptoContext.connectedAccountRefreshToken,
  )
  if (!refreshToken || !config.tokenUrl) return { value: "no_usable_token" }
  let client: Awaited<ReturnType<typeof resolveRefreshClient>> = null
  try {
    await loadOrgApps(row.sourceOrgId)
    client = await resolveRefreshClient({
      orgId: row.sourceOrgId,
      appName: row.appName,
      connectionName: row.connectionName,
      oauthClientSource: row.oauthClientSource,
      oauthClientId: row.oauthClientId,
    })
  } catch {
    return { value: "no_usable_token" }
  }
  if (!client) return { value: "no_usable_token" }
  let res: Response
  try {
    res = await fetchWithRedirectValidation(
      config.tokenUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: client.clientId,
          client_secret: client.clientSecret,
        }).toString(),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      },
      { requireHttps: true, allowPrivateHostsInTest: true },
    )
  } catch (err) {
    return { retry: `token refresh: ${(err as Error).message}` }
  }
  if (isTransientStatus(res.status)) return { retry: `token refresh: HTTP ${res.status}` }
  if (!res.ok)
    return { value: res.status === 400 || res.status === 401 ? "token_invalid" : "no_usable_token" }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string }
  return body.access_token ? { value: body.access_token } : { value: "no_usable_token" }
}

/** Stop the push watch, unless another connection still needs it. */
async function stopWatch(
  row: ConnectionTeardownRow,
  urls: { watchStopUrl: string | null; tokenUrl: string | null },
): Promise<Attempt<WatchStopOutcome>> {
  const url = urls.watchStopUrl
  if (!url) return { value: "no_watch_declared" }
  try {
    const conn = { orgId: row.sourceOrgId, identifier: row.identifier }
    if (await isAccountUsedElsewhere(conn, "watchStopUrl", url)) return { value: "still_used" }
  } catch (err) {
    return { retry: `watch sharer check: ${(err as Error).message}` }
  }

  const stored =
    row.tokenExpiresAt === null || row.tokenExpiresAt.getTime() > Date.now() + 30_000
      ? decryptOrNull(row.accessTokenEncrypted, CryptoContext.connectedAccountAccessToken)
      : null
  let token = stored
  for (let refreshed = false; ; refreshed = true) {
    if (!token) {
      const fresh = await refreshedAccessToken(row, urls)
      if ("retry" in fresh) return fresh
      if (fresh.value === "token_invalid" || fresh.value === "no_usable_token") {
        return { value: fresh.value }
      }
      token = fresh.value
    }
    let res: Response
    try {
      res = await fetchWithRedirectValidation(
        url,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        },
        { requireHttps: true, allowPrivateHostsInTest: true },
      )
    } catch (err) {
      return { retry: `watch stop: ${(err as Error).message}` }
    }
    await res.body?.cancel().catch(() => {})
    if (res.ok || res.status === 404) return { value: "stopped" }
    if (isTransientStatus(res.status)) return { retry: `watch stop: HTTP ${res.status}` }
    if (res.status === 401 && !refreshed) {
      token = null
      continue
    }
    if (res.status === 401) return { value: "token_invalid" }
    log.warn(
      {
        orgId: row.sourceOrgId,
        appName: row.appName,
        connectionName: row.connectionName,
        connectionId: row.connectionId,
        status: res.status,
      },
      "Push watch stop refused by the provider; the watch lapses by itself",
    )
    return { value: "refused" }
  }
}

/** Revoke the grant, unless another connection still needs it. */
async function revokeGrant(
  row: ConnectionTeardownRow,
  url: string | null,
): Promise<Attempt<RevokeOutcome["status"] | "still_used">> {
  if (!url) return { value: "skipped" }
  try {
    const conn = { orgId: row.sourceOrgId, identifier: row.identifier }
    if (await isAccountUsedElsewhere(conn, "revocationUrl", url)) return { value: "still_used" }
  } catch (err) {
    return { retry: `grant sharer check: ${(err as Error).message}` }
  }
  const outcome = await revokeConnectionGrant(
    {
      id: row.connectionId,
      orgId: row.sourceOrgId,
      appName: row.appName,
      connectionName: row.connectionName,
      providerType: "oauth2",
      identifier: row.identifier,
      accessTokenEncrypted: row.accessTokenEncrypted,
      refreshTokenEncrypted: row.refreshTokenEncrypted,
    },
    url,
  )
  if (outcome.status === "failed" && outcome.transient)
    return { retry: `revoke: ${outcome.reason}` }
  return { value: outcome.status }
}

async function workTeardown(row: ConnectionTeardownRow): Promise<TeardownOutcome> {
  const logCtx = {
    orgId: row.sourceOrgId,
    appName: row.appName,
    connectionName: row.connectionName,
    connectionId: row.connectionId,
  }
  let urls = {
    revocationUrl: row.revocationUrl,
    watchStopUrl: row.watchStopUrl,
    tokenUrl: row.tokenUrl,
  }
  if (!urls.revocationUrl && !urls.watchStopUrl) {
    // The removing process had not loaded the app: its manifest decides, here.
    await loadOrgApps(row.sourceOrgId)
    const config = connectionConfigRegistry.get([row.sourceOrgId, row.appName, row.connectionName])
    urls = {
      revocationUrl: config?.revocationUrl ?? null,
      watchStopUrl: config?.watchStopUrl ?? null,
      tokenUrl: config?.refreshTokenUrl ?? config?.tokenUrl ?? null,
    }
  }

  const failure = async (reason: string): Promise<TeardownOutcome> => {
    if (Date.now() - row.createdAt.getTime() >= TEARDOWN_MAX_AGE_MS) {
      await finishTeardown(row.id)
      log.error(
        { ...logCtx, alert: "connection_teardown_gave_up", attempts: row.attempts, reason },
        "Connection teardown gave up: the tokens are deleted, the grant may still be live at the provider",
      )
      return { status: "gave_up", reason }
    }
    const delay = TEARDOWN_BACKOFF_MS[
      Math.min(row.attempts, TEARDOWN_BACKOFF_MS.length) - 1
    ] as number
    await withSystemDb("connection-teardown-retry", (tx) =>
      tx
        .update(connectionTeardowns)
        .set({ nextAttemptAt: new Date(Date.now() + delay), lastError: reason.slice(0, 200) })
        .where(eq(connectionTeardowns.id, row.id)),
    )
    log.warn(
      { ...logCtx, attempts: row.attempts, reason, retryInMs: delay },
      "Connection teardown will retry",
    )
    return { status: "retry", reason }
  }

  // The stop first: it needs a token that the revocation ends.
  const watch = await stopWatch(row, urls)
  if ("retry" in watch) return failure(watch.retry)
  const grant = await revokeGrant(row, urls.revocationUrl)
  if ("retry" in grant) return failure(grant.retry)

  await finishTeardown(row.id)
  log.info(
    { ...logCtx, watch: watch.value, grant: grant.value, attempts: row.attempts },
    "Connection teardown finished at the provider; its tokens are deleted",
  )
  return { status: "done", watch: watch.value, grant: grant.value }
}

/**
 * Work off what a committed removal left for this connection. Never throws: a failure
 * stays in the table for the sweep. Nothing to do (another process took it, or the
 * removal rolled back) answers an empty list.
 */
export async function runConnectionTeardown(connectionId: string): Promise<TeardownOutcome[]> {
  try {
    const out: TeardownOutcome[] = []
    for (const row of await claimTeardowns({ connectionId })) out.push(await workTeardown(row))
    return out
  } catch (err) {
    log.warn(
      { connectionId, err: (err as Error).message },
      "Connection teardown failed; the sweep retries it",
    )
    return []
  }
}

/**
 * One sweep: due rows one at a time, each claimed only when its turn comes, so a slow
 * provider cannot outrun a claim's lease. Never throws.
 */
export async function runDueConnectionTeardowns(): Promise<TeardownOutcome[]> {
  const out: TeardownOutcome[] = []
  try {
    for (let i = 0; i < TEARDOWN_SWEEP_BATCH; i++) {
      const rows = await claimTeardowns({ limit: 1 })
      if (rows.length === 0) break
      for (const row of rows) out.push(await workTeardown(row))
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, "Connection teardown sweep failed; it retries")
  }
  return out
}

/**
 * An org about to be deleted: its connections go without a disconnect, so do here what
 * one would have: move each connection's tokens into a teardown row, then try it at
 * once, while the org's own OAuth client still exists. Skipped for an org that moved to
 * another server, whose grants and watches stay in use. A database failure throws, so
 * the purge stops before the rows that hold the tokens go and resumes from here.
 */
export async function teardownOrgConnections(orgId: string): Promise<TeardownOutcome[]> {
  // Only load the org's apps when there is something to tear down: loading them
  // starts the org's whole runtime, which an org with no live connection (most
  // expired demo workspaces) would start only to have it released again.
  const live = await withPrivilegedDb(orgId, "org-purge-connection-teardown-lookup", (tx) =>
    tx
      .select({ id: connectedAccounts.id })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          drizzleSql`${connectedAccounts.status} <> 'disconnected'`,
        ),
      )
      .limit(1),
  )
  if (live.length === 0) return []
  await loadOrgApps(orgId)
  const ids = await withPrivilegedDb(orgId, "org-purge-connection-teardown", async (tx) => {
    const rows = await tx
      .select({
        id: connectedAccounts.id,
        appName: connectedAccounts.appName,
        connectionName: connectedAccounts.connectionName,
        providerType: connectedAccounts.providerType,
        identifier: connectedAccounts.identifier,
        accessTokenEncrypted: connectedAccounts.accessTokenEncrypted,
        refreshTokenEncrypted: connectedAccounts.refreshTokenEncrypted,
        oauthClientSource: connectedAccounts.oauthClientSource,
        oauthClientId: connectedAccounts.oauthClientId,
        tokenExpiresAt: connectedAccounts.tokenExpiresAt,
      })
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          drizzleSql`${connectedAccounts.status} <> 'disconnected'`,
        ),
      )
    const staged: string[] = []
    for (const row of rows) {
      await stageConnectionTeardown(tx, { ...row, orgId })
      staged.push(row.id)
      await tx
        .update(connectedAccounts)
        .set({
          status: "disconnected",
          disconnectedAt: new Date(),
          updatedAt: new Date(),
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          credentialsEncrypted: null,
          tokenExpiresAt: null,
        })
        .where(eq(connectedAccounts.id, row.id))
    }
    return staged
  })
  const out: TeardownOutcome[] = []
  for (const id of ids) out.push(...(await runConnectionTeardown(id)))
  return out
}

/** The outbox side: a committed `kernel/connected_account:disconnect` runs what it left. */
export async function revokeOnDisconnectEvent(event: {
  app?: string
  entity?: string
  action?: string
  entityId?: string | null
  ephemeral?: boolean
}): Promise<void> {
  if (event.ephemeral) return
  if (event.app !== "kernel" || event.entity !== "connected_account") return
  if (event.action !== "disconnect" || !event.entityId) return
  await runConnectionTeardown(event.entityId)
}

let consumerRegistered = false

/** Register the outbox consumer. Idempotent; called at boot. */
export function registerRevokeOnDisconnectConsumer(): void {
  if (consumerRegistered) return
  consumerRegistered = true
  registerDurableEventConsumer("oauth-revoke-on-disconnect", async (ctx: DurableEventContext) => {
    await revokeOnDisconnectEvent(ctx.event)
  })
}

let sweepTimer: ReturnType<typeof setInterval> | null = null
let sweeping = false

/** The leader retries what an outage or a dead process left, one sweep at a time. */
export function registerConnectionTeardownSweep(): void {
  registerSingleton({
    name: "connection-teardown-sweep",
    onAcquired: () => {
      if (sweepTimer) return
      sweepTimer = setInterval(() => {
        if (sweeping) return
        sweeping = true
        void runDueConnectionTeardowns().finally(() => {
          sweeping = false
        })
      }, TEARDOWN_SWEEP_MS)
    },
    onLost: () => {
      if (sweepTimer) clearInterval(sweepTimer)
      sweepTimer = null
    },
  })
}
