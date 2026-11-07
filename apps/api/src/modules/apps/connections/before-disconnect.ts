// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app's `beforeDisconnect` hook: provider-side cleanup that needs the token.
//
// Some apps register state AT THE PROVIDER when a connection is made (Shopify
// creates webhook subscriptions pointing back at this instance). Removing it
// takes the connection's token, and `disconnectConnection` deletes the token in
// the same transaction that flips the row, so the `connected_account:disconnect`
// event an app subscribes to arrives too late: the token is gone. A connection
// that declares `beforeDisconnect: "<export>"` in its manifest gets that handler
// run HERE, before the disconnect, while the row is still active and
// `ctx.connections.<name>.getToken()` still answers.
//
// Who calls it: the disconnect route (once the caller is authorized for the
// connection) and the visitor-org purge (which deletes the rows without a
// disconnect, so it runs the hook for every active connection first). Not run:
// an app disconnecting its own account through `connections_disconnect` (it
// cleans up first itself), and the CLI connector provisioner's replace path
// (credentials connectors, which register nothing at a provider).
//
// Best effort: the hook runs outside any transaction (per-call bridge
// transactions, no pool connection held across the provider calls), under a
// timeout, and a failure is logged and never blocks the disconnect.

import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { createRlsSession } from "~/db/rls"
import { connectedAccounts } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import {
  appBridgeManifestRegistry,
  connectionBeforeDisconnectRegistry,
} from "~/modules/apps/app-registries"

const HOOK_TIMEOUT_MS = 20_000

/** What the hook handler receives as its params. */
export interface BeforeDisconnectEvent {
  id: string
  orgId: string
  appName: string
  connectionName: string
  ownerType: string
  ownerId: string | null
  identifier: string
  /** Public origin of this instance (the base of the callback URLs the app registered). */
  kernelPublicBaseUrl: string
  reason: "disconnect" | "org_purge"
}

export type BeforeDisconnectOutcome =
  | { status: "ran" }
  | { status: "skipped"; reason: "no_connection" | "not_active" | "no_hook" }
  | { status: "failed"; reason: string }

interface HookRow {
  id: string
  appName: string
  connectionName: string
  ownerType: string
  ownerId: string | null
  identifier: string
  status: string
}

const rowColumns = {
  id: connectedAccounts.id,
  appName: connectedAccounts.appName,
  connectionName: connectedAccounts.connectionName,
  ownerType: connectedAccounts.ownerType,
  ownerId: connectedAccounts.ownerId,
  identifier: connectedAccounts.identifier,
  status: connectedAccounts.status,
}

/** Test seam: replaces the sandbox run (bundle load + worker pool). */
type HookExecutor = (args: {
  bundlePath: string
  exportName: string
  params: BeforeDisconnectEvent
  orgId: string
  appName: string
}) => Promise<void>

const defaultExecutor: HookExecutor = async ({
  bundlePath,
  exportName,
  params,
  orgId,
  appName,
}) => {
  const { createSessionRpcBridge } = await import("~/modules/apps/sandbox/rpc-bridge")
  const { runApp } = await import("~/modules/apps/sandbox/run-app")
  const manifest = appBridgeManifestRegistry.get([orgId, appName]) ?? { name: appName }
  // The app acting as itself, like its jobs: under its own scopes, one short
  // transaction per bridge call (the provider calls hold no pool connection).
  const session = createRlsSession(
    { actorType: "system", orgId, purpose: "job", scopes: [`${appName}:*`] },
    { pool: "jobs" },
  )
  const bridge = createSessionRpcBridge(
    appName,
    `system:${appName}`,
    orgId,
    session,
    manifest as Parameters<typeof createSessionRpcBridge>[4],
  )
  // Always the isolated worker pool, whatever the app's trust.
  await runApp({
    trusted: false,
    appName,
    orgId,
    bundlePath,
    exportName,
    entry: `disconnect:${exportName}`,
    params,
    bridge,
    timeoutMs: HOOK_TIMEOUT_MS,
    priority: "background",
    appId: appName,
    holdsTx: false,
  })
}

let executor: HookExecutor = defaultExecutor

async function runHookForRow(
  orgId: string,
  row: HookRow,
  reason: BeforeDisconnectEvent["reason"],
): Promise<BeforeDisconnectOutcome> {
  if (row.status !== "active") return { status: "skipped", reason: "not_active" }
  const hook = connectionBeforeDisconnectRegistry.get([orgId, row.appName, row.connectionName])
  if (!hook) return { status: "skipped", reason: "no_hook" }
  const logCtx = {
    orgId,
    appName: row.appName,
    connectionName: row.connectionName,
    connectionId: row.id,
    identifier: row.identifier,
    reason,
  }
  try {
    await executor({
      bundlePath: hook.bundlePath,
      exportName: hook.exportName,
      orgId,
      appName: row.appName,
      params: {
        id: row.id,
        orgId,
        appName: row.appName,
        connectionName: row.connectionName,
        ownerType: row.ownerType,
        ownerId: row.ownerId,
        identifier: row.identifier,
        kernelPublicBaseUrl: env.BASE_URL,
        reason,
      },
    })
    log.info(logCtx, "beforeDisconnect hook ran")
    return { status: "ran" }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ ...logCtx, err: message }, "beforeDisconnect hook failed; disconnecting anyway")
    return { status: "failed", reason: message }
  }
}

/**
 * Run the connection's `beforeDisconnect` hook, if its app declares one and the
 * connection is still active. Call it BEFORE `disconnectConnection`. Never throws.
 */
export async function runBeforeDisconnect(
  orgId: string,
  connectionId: string,
): Promise<BeforeDisconnectOutcome> {
  let row: HookRow | undefined
  try {
    const { ensureAppsForOrg } = await import("~/modules/apps/init")
    await ensureAppsForOrg(orgId)
    ;[row] = await withPrivilegedDb(orgId, "connection-before-disconnect-lookup", (tx) =>
      tx
        .select(rowColumns)
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.id, connectionId), eq(connectedAccounts.orgId, orgId)))
        .limit(1),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn({ orgId, connectionId, err: message }, "beforeDisconnect hook lookup failed")
    return { status: "failed", reason: message }
  }
  if (!row) return { status: "skipped", reason: "no_connection" }
  return runHookForRow(orgId, row, "disconnect")
}

/**
 * Run the `beforeDisconnect` hook of every active connection of an org about to
 * be deleted (its rows go without a disconnect). Never throws.
 */
export async function runBeforeDisconnectForOrg(
  orgId: string,
): Promise<Array<{ connectionId: string; outcome: BeforeDisconnectOutcome }>> {
  let rows: HookRow[]
  try {
    rows = await withPrivilegedDb(orgId, "org-purge-before-disconnect-lookup", (tx) =>
      tx
        .select(rowColumns)
        .from(connectedAccounts)
        .where(and(eq(connectedAccounts.orgId, orgId), eq(connectedAccounts.status, "active"))),
    )
    // Only load the org's apps when there is something to clean up.
    if (rows.length > 0) {
      const { ensureAppsForOrg } = await import("~/modules/apps/init")
      await ensureAppsForOrg(orgId)
    }
  } catch (err) {
    log.warn(
      { orgId, err: err instanceof Error ? err.message : String(err) },
      "beforeDisconnect hooks skipped for org purge: lookup failed",
    )
    return []
  }
  const out: Array<{ connectionId: string; outcome: BeforeDisconnectOutcome }> = []
  for (const row of rows) {
    out.push({ connectionId: row.id, outcome: await runHookForRow(orgId, row, "org_purge") })
  }
  return out
}

export const BeforeDisconnectTestAccess = {
  setExecutor: (fn: HookExecutor | null) => {
    executor = fn ?? defaultExecutor
  },
}
