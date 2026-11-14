// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Generic manifest-driven connector (Task 11). A NEW app needs zero CLI code:
 * the connector reads the connection's declaration from `connectionConfigRegistry`
 * (warmed by `ensureAppsForOrg`, which the org provisioner runs post-commit) and
 * drives it off the manifest `type`:
 *
 *  - `type:'credentials'`: validate supplied `credentials` against the manifest
 *    `credentialFields` (required by `name`); derive `identifier` (`resolveIdentifier`:
 *    the explicit config `connection.identifier`, else the manifest `identifierVar`
 *    field value, else the settings form's default);
 *    4-key precheck on the active partial-unique index. Absent → create inside
 *    `ctx.rls` (branded RlsClient) `createCredentialConnection` (ownerType:'org').
 *    Present → every declared field is compared with the stored (decrypted)
 *    one: the non-secret settings (a base URL, a host, an account id) and the
 *    secrets alike. All equal → idempotent skip. Any drift →
 *    `disconnectConnection(rls, …, existingRowId)` (the ROW id from the precheck,
 *    correction #8) then reinsert, reported per changed field
 *    (`apps.<app>.connection.<field>`). A secret field (manifest `type:
 *    "password"`, or undeclared) is named only; a non-secret setting also shows
 *    its stored and declared values (`baseUrl "old" -> "new"`), so a stale host
 *    is visible in the log, the report and a `--dry-run` (`planConnection`).
 *  - After apply, `checkConnectionHealth` runs the app's `config verify` probe
 *    (when it has one) against the stored row, so a connection that is
 *    "unchanged" but dead is reported instead of passing silently.
 *  - `type:'oauth2'`: report `pending` (the interactive `liaison connect <app>/<conn>`
 *    step) — NO write.
 *
 * No `as`/`as unknown as` casts: `createCredentialConnection`/`disconnectConnection`
 * take `RlsClient` → called inside `ctx.rls`.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel } from "~/apps/tickets/schema-refs"
import { ConfigError } from "~/cli/config/parse"
import { requireActor } from "~/cli/provisioners/admin"
import {
  connectingPersonOrFail,
  type PendingItem,
  type ProvisionContext,
} from "~/cli/provisioners/types"
import type { VerifyProbe } from "~/cli/provisioners/verify-probes"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { isRecord } from "~/lib/guards"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { upsertConnectionOAuthClient } from "~/modules/apps/connections/oauth-client-provisioning"
import { precheckCredentials } from "~/modules/apps/connections/precheck"
import {
  CredentialRefusedError,
  createCredentialConnection,
  disconnectConnection,
  getCredentialsForConnection,
} from "~/modules/apps/connections/service"

/** What the apps provisioner declares per `apps[].connection`. */
export interface ConnectionSpec {
  name: string
  identifier?: string
  ownerType?: "org" | "user"
  credentials?: Record<string, string>
  /** OAuth2 connections only: the per-connection OAuth client (app id/secret). */
  oauthClient?: { clientId: string; clientSecret: string }
}

/**
 * One drifted field of a credentials connection. A SECRET field (manifest
 * `type: "password"`, or a field the manifest does not declare) carries its
 * name only; a non-secret setting (a base URL, a host, an account id) also
 * carries the stored (`from`) and declared (`to`) values, absent when that
 * side has no value.
 */
export interface ConnectionFieldChange {
  field: string
  secret: boolean
  from?: string
  to?: string
}

/** Outcome of the post-apply health check of one connection. */
export interface ConnectionHealth {
  status: "PASS" | "FAIL" | "SKIPPED"
  /** Non-secret identity the app's probe returned (PASS only). */
  identity?: string
  /** Why it failed or was skipped; never a credential value. */
  error?: string
}

/** The connector's per-connection outcome. */
export interface ConnectorResult {
  /** True once an active credentials connection exists (created or already present). */
  connected: boolean
  /** The connection identifier, once an active credentials connection exists. */
  identifier?: string
  /** The drifted fields of an existing connection that this run replaced. */
  fieldChanges?: ConnectionFieldChange[]
  /** Set for an oauth2 connection awaiting the interactive flow. */
  pending?: PendingItem
  /** Dotted change/unchanged keys this connection contributed. */
  changed?: string[]
  unchanged?: string[]
}

/**
 * The fields whose declared value differs from the stored one (sorted names).
 * A field present on one side only counts as changed: the reinsert stores the
 * declared map as is, so a stored field the config no longer declares goes.
 */
export function changedConnectionFields(
  stored: Record<string, string>,
  declared: Record<string, string>,
): string[] {
  const names = new Set([...Object.keys(stored), ...Object.keys(declared)])
  return [...names].filter((k) => stored[k] !== declared[k]).sort()
}

/** The manifest's credential field declarations, as far as drift needs them. */
type CredentialFieldDecl = { name: string; type: string }

/**
 * The drift between the stored and declared credentials, one entry per changed
 * field (sorted by name). Only a field the manifest declares with a type other
 * than `password` is a non-secret setting whose values may be shown; every
 * other field (a password, or a field the manifest does not declare) is
 * reported by name alone.
 */
export function describeConnectionDrift(
  stored: Record<string, string>,
  declared: Record<string, string>,
  fields: readonly CredentialFieldDecl[],
): ConnectionFieldChange[] {
  const plain = new Set(fields.filter((f) => f.type !== "password").map((f) => f.name))
  return changedConnectionFields(stored, declared).map((field) => {
    if (!plain.has(field)) return { field, secret: true }
    const from = stored[field]
    const to = declared[field]
    return {
      field,
      secret: false,
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
    }
  })
}

/** One drifted field for a log line: `baseUrl "old" -> "new"`, or `token (secret)`. */
export function formatFieldChange(change: ConnectionFieldChange): string {
  if (change.secret) return `${change.field} (secret)`
  const show = (v: string | undefined) => (v === undefined ? "(unset)" : JSON.stringify(v))
  return `${change.field} ${show(change.from)} -> ${show(change.to)}`
}

/** What drift detection needs from a credentials connection's manifest declaration. */
interface CredentialConnectionDecl {
  type: "oauth2" | "credentials"
  credentialFields?: CredentialFieldDecl[]
  identifierVar?: string
  multiInstance?: boolean
}

/**
 * The connection identifier: the config's explicit `connection.identifier` when it
 * names one, else the manifest `identifierVar` field's value. The explicit one wins
 * so that a manifest which starts deriving its identifier (ads/google-config: the
 * customer id) keeps updating the account an existing config file stored under its
 * own identifier, instead of creating a second one beside it (`config verify` reads
 * the same explicit identifier).
 *
 * Neither: the same default the settings form's connect route uses
 * (`connections/routes.ts`): an `email` or `identifier` credential field, else
 * the owner (the org for an org-owned connection, the acting person for a
 * personal one). A connection made in the UI and one applied from a config file
 * therefore land on the same account. A `multiInstance` connection has no
 * default (each account is an admin-chosen slug): a `ConfigError` names the field.
 */
function resolveIdentifier(
  manifest: CredentialConnectionDecl,
  spec: ConnectionSpec,
  credentials: Record<string, string>,
  appName: string,
  owner: { orgId: string; userId: string },
): string {
  const connName = spec.name
  if (spec.identifier !== undefined && spec.identifier.length > 0) return spec.identifier
  if (manifest.identifierVar) {
    const fromField = credentials[manifest.identifierVar]
    if (fromField === undefined || fromField.length === 0) {
      throw new ConfigError(
        `apps: connection '${appName}/${connName}' requires credential '${manifest.identifierVar}' (the manifest identifierVar)`,
      )
    }
    return fromField
  }
  if (manifest.multiInstance) {
    throw new ConfigError(
      `apps: connection '${appName}/${connName}' needs an 'identifier' (a multi-instance connection names each account by a slug)`,
    )
  }
  const fromCredentials = credentials.email || credentials.identifier
  if (fromCredentials) return fromCredentials
  return (spec.ownerType ?? "org") === "org" ? owner.orgId : owner.userId
}

/** Runs `fn` in a privileged transaction scoped to the connection's org. */
type PrivRunner = <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>

/**
 * The active connection on the 4-key (org, app, connection, identifier) and
 * its stored credentials, decrypted by the same service call the app's tools
 * use. Null when there is none. A privileged read: org-owned
 * `connected_accounts` rows are deliberately invisible to the generic RLS
 * `listConnections`.
 */
async function readActiveConnection(
  priv: PrivRunner,
  orgId: string,
  actorUserId: string,
  appName: string,
  connName: string,
  identifier: string,
): Promise<{ id: string; stored: Record<string, string> } | null> {
  const precheck = await priv("cli-connector-precheck", (tx) =>
    tx.execute(drizzleSql`
      SELECT id FROM ${kernelRel("connected_accounts")}
      WHERE org_id = ${orgId}::uuid AND app_name = ${appName} AND connection_name = ${connName}
        AND identifier = ${identifier} AND status = 'active'
      LIMIT 1
    `),
  )
  const row = extractRows<{ id: string }>(precheck)[0]
  if (!row) return null
  // Read after `priv`, in a privileged transaction of the org: the service's
  // system lookup reuses it (no second slot), which an org-less `priv` (a plan
  // runs before the org is set) could not offer.
  const stored = await withPrivilegedDb(orgId, "cli-connector-read-creds", (tx) =>
    getCredentialsForConnection(tx, orgId, actorUserId, appName, connName, identifier, {
      actorType: "system",
    }),
  )
  return { id: row.id, stored }
}

/** A manifest connection declaration read from an app descriptor, or null. */
function parseConnectionDecl(value: unknown): CredentialConnectionDecl | null {
  if (!isRecord(value)) return null
  const type = value.type
  if (type !== "oauth2" && type !== "credentials") return null
  const credentialFields: CredentialFieldDecl[] = []
  if (Array.isArray(value.credentialFields)) {
    for (const f of value.credentialFields) {
      if (isRecord(f) && typeof f.name === "string" && typeof f.type === "string") {
        credentialFields.push({ name: f.name, type: f.type })
      }
    }
  }
  return {
    type,
    credentialFields,
    ...(typeof value.identifierVar === "string" ? { identifierVar: value.identifierVar } : {}),
    ...(value.multiInstance === true ? { multiInstance: true } : {}),
  }
}

/**
 * The connection's manifest declaration for a read-only plan. A dry run does
 * not register the org's apps (registration writes), so when the registry is
 * cold the declaration is read from the app descriptors registration would
 * use, without registering anything.
 */
async function planConnectionDecl(
  orgId: string,
  appName: string,
  connName: string,
): Promise<CredentialConnectionDecl | null> {
  const registered = connectionConfigRegistry.get([orgId, appName, connName])
  if (registered) return registered
  const { getDefaultApps } = await import("~/modules/apps/init")
  const descriptor = (await getDefaultApps()).find((a) => a.name === appName)
  const connections: unknown = descriptor?.connections
  return isRecord(connections) ? parseConnectionDecl(connections[connName]) : null
}

/**
 * Read-only plan lines for one credentials connection of an EXISTING org: the
 * fields that differ from the stored connection (values for the non-secret
 * ones, names only for secrets), or that it is unchanged. Nothing for a new
 * connection, an OAuth one or credentials not configured yet (the apps plan
 * line already says "connect"), and nothing when the org does not exist.
 */
export async function planConnection(
  ctx: ProvisionContext,
  orgId: string,
  appName: string,
  spec: ConnectionSpec,
): Promise<string[]> {
  if (orgId === "") return []
  const connName = spec.name
  const credentials = spec.credentials ?? {}
  if (Object.values(credentials).every((v) => v.length === 0)) return []
  const manifest = await planConnectionDecl(orgId, appName, connName)
  if (manifest?.type !== "credentials") return []
  // A personal connection is keyed on its person, unknown before the admin applies.
  if (
    (spec.ownerType ?? "org") === "user" &&
    spec.identifier === undefined &&
    ctx.actor.userId === ""
  )
    return []
  const identifier = resolveIdentifier(manifest, spec, credentials, appName, {
    orgId,
    userId: ctx.actor.userId,
  })
  // The plan runs before the org provisioner sets `ctx.orgId`, so the read
  // goes through the org-less seam; every query names the org explicitly.
  const existing = await readActiveConnection(ctx.sys, orgId, "", appName, connName, identifier)
  if (!existing) return []
  const drift = describeConnectionDrift(
    existing.stored,
    credentials,
    manifest.credentialFields ?? [],
  )
  if (drift.length === 0) return [`app '${appName}' connection '${connName}' unchanged`]
  return [
    `update app '${appName}' connection '${connName}': ${drift.map(formatFieldChange).join(", ")}`,
  ]
}

/**
 * Post-apply health check of one active credentials connection: the app's
 * `config verify` check (`verify-probes.ts`, its `provisioning.verify`
 * handler), one cheap authenticated read through the app's connection, the
 * stored credential added host-side. An app without one is SKIPPED. Never
 * throws, and never returns a credential value.
 */
export async function checkConnectionHealth(
  ctx: ProvisionContext,
  probe: VerifyProbe,
  appName: string,
  connName: string,
  provision?: Record<string, unknown>,
): Promise<ConnectionHealth> {
  try {
    const probed = await probe({
      orgId: ctx.orgId,
      appName,
      ...(provision ? { provision } : {}),
    })
    if (!probed) {
      ctx.log(`app '${appName}': connection '${connName}' health check SKIPPED (no probe)`)
      return { status: "SKIPPED", error: "the app declares no health check" }
    }
    ctx.log(`app '${appName}': connection '${connName}' health check PASS (${probed.identity})`)
    return { status: "PASS", identity: probed.identity }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    ctx.log(`warning: app '${appName}': connection '${connName}' health check FAIL: ${error}`)
    return { status: "FAIL", error }
  }
}

/**
 * Provision ONE connection generically. `appName` + `spec.name` (the connection
 * name) key the manifest registry; the manifest `type` decides the path.
 */
export async function provisionConnection(
  ctx: ProvisionContext,
  appName: string,
  spec: ConnectionSpec,
): Promise<ConnectorResult> {
  const connName = spec.name
  const manifest = connectionConfigRegistry.get([ctx.orgId, appName, connName])
  if (!manifest) {
    throw new ConfigError(
      `apps: connection '${connName}' is not declared in app '${appName}' manifest (is the app registered?)`,
    )
  }

  // OAUTH2 → provision the per-connection OAuth client (if supplied), then report
  // pending for the interactive browser consent. No token write here.
  if (manifest.type === "oauth2") {
    const changed: string[] = []
    // A declared-but-unconfigured OAuth client (empty id/secret -- e.g. an unset
    // `${ENV:-}` ref) is SKIPPED, not an error, so `config apply` stays usable for
    // incremental setup: provision the apps whose client IS set, and report the
    // rest as pending (needs client + consent). Both fields must be non-empty.
    const oc = spec.oauthClient
    const hasClient =
      oc !== undefined && oc.clientId.trim().length > 0 && oc.clientSecret.trim().length > 0
    if (hasClient && oc) {
      const { created } = await upsertConnectionOAuthClient({
        orgId: ctx.orgId,
        appName,
        connectionName: connName,
        clientId: oc.clientId,
        clientSecret: oc.clientSecret,
      })
      ctx.log(
        `app '${appName}': connection '${connName}' OAuth client ${created ? "set" : "updated"}`,
      )
      changed.push(`apps.${appName}.${connName}.oauthClient`)
    } else if (oc !== undefined) {
      ctx.log(
        `app '${appName}': connection '${connName}' OAuth client declared but not configured (empty) -- skipping client provisioning`,
      )
    }
    ctx.log(
      `app '${appName}': connection '${connName}' is OAuth — run 'liaison connect ${appName}/${connName}' to authorize`,
    )
    return {
      connected: false,
      ...(changed.length > 0 ? { changed } : {}),
      pending: {
        kind: "oauth",
        app: appName,
        connection: connName,
        action: `liaison connect ${appName}/${connName}`,
        message: hasClient
          ? `Connection '${appName}/${connName}' client configured; awaits OAuth consent.`
          : `Connection '${appName}/${connName}' awaits OAuth client + consent (no client set).`,
      },
    }
  }

  // CREDENTIALS path.
  const credentials = spec.credentials ?? {}

  // All-empty credentials means the secrets are not pasted yet (`${VAR:-}` env
  // refs interpolate to "") — SKIP as pending rather than hard-failing, the same
  // incremental-apply convention the oauth path uses. A PARTIAL fill still falls
  // through to the required-field check below and fails loudly: that is a real
  // misconfiguration, not a deferred secret.
  const allEmpty = Object.values(credentials).every((v) => v === undefined || v.length === 0)
  if (allEmpty && (manifest.credentialFields ?? []).length > 0) {
    ctx.log(
      `app '${appName}': connection '${connName}' credentials not configured (all empty) -- skipping`,
    )
    return {
      connected: false,
      pending: {
        kind: "credentials",
        app: appName,
        connection: connName,
        action: `set the ${appName} credential env vars and re-run config apply`,
        message: `Connection '${appName}/${connName}' awaits credentials (all env refs empty).`,
      },
    }
  }

  // Validate supplied creds against the manifest required fields (by name).
  const required = (manifest.credentialFields ?? []).filter((f) => f.required !== false)
  for (const field of required) {
    const value = credentials[field.name]
    if (value === undefined || value.length === 0) {
      throw new ConfigError(
        `apps: connection '${appName}/${connName}' missing required credential '${field.name}'`,
      )
    }
  }

  // A user-owned connection is keyed by its person; an org-owned one needs an
  // actor only to write (connectingPersonOrFail below), not to compare.
  if ((spec.ownerType ?? "org") !== "org") {
    requireActor(ctx, `apps: connection '${appName}/${connName}'`)
  }
  const resolvedIdentifier = resolveIdentifier(manifest, spec, credentials, appName, {
    orgId: ctx.orgId,
    userId: ctx.actor.userId,
  })

  const ownerType = spec.ownerType ?? "org"

  // 4-key precheck on the active partial-unique index, with the stored
  // (decrypted) credentials to compare.
  const existing = await readActiveConnection(
    ctx.priv,
    ctx.orgId,
    ctx.actor.userId,
    appName,
    connName,
    resolvedIdentifier,
  )
  /** Set when an existing connection drifted: the fields that changed. */
  let fieldChanges: ConnectionFieldChange[] | null = null

  if (existing) {
    const drift = describeConnectionDrift(
      existing.stored,
      credentials,
      manifest.credentialFields ?? [],
    )
    if (drift.length === 0) {
      ctx.log(`app '${appName}': connection '${connName}' already connected (unchanged)`)
      return {
        connected: true,
        identifier: resolvedIdentifier,
        unchanged: [`apps.${appName}.connection`],
      }
    }
    fieldChanges = drift
  }

  // Every write below (the reconnect's disconnect, the insert) records the
  // acting person; an unchanged connection above needs none.
  const creator = connectingPersonOrFail(ctx, `apps: the '${connName}' connection of '${appName}'`)

  // The connection's own check of the key before it is kept, as the credentials
  // route runs it (precheck.ts): a refused key replaces nothing, so the stored
  // one stays the key every sync uses. Before the disconnect below.
  try {
    await precheckCredentials({
      actor: {
        actorType: "user",
        userId: creator,
        orgId: ctx.orgId,
        scopes: ctx.actor.scopes,
        dimensionGrants: ctx.actor.dimensionGrants,
      },
      appName,
      connectionName: connName,
      credentials,
    })
  } catch (err) {
    if (err instanceof CredentialRefusedError) {
      throw new ConfigError(
        `apps: connection '${appName}/${connName}': the key was refused by the connection's check (${err.code}: ${err.message}). Nothing was stored; the stored key was kept.`,
      )
    }
    throw err
  }

  if (existing && fieldChanges) {
    // Drift → disconnect the existing row (by its ROW id, #8) then reinsert.
    // An org-owned non-kernel connection is invisible to the RLS UPDATE policy, so
    // the disconnect runs under the same handle the insert needs (privileged for
    // org-owned; RLS for user-owned).
    ctx.log(
      `app '${appName}': connection '${connName}' updated (${fieldChanges.map(formatFieldChange).join(", ")}) — reconnecting`,
    )
    const rowId = existing.id
    if (ownerType === "org") {
      await ctx.priv("cli-connector-disconnect", (priv) =>
        disconnectConnection(priv, ctx.orgId, creator, rowId),
      )
    } else {
      await ctx.rls((rls) => disconnectConnection(rls, ctx.orgId, creator, rowId))
    }
  }

  // Absent (or just disconnected) → create the connection. ORG-owned connections
  // are uninsertable under `liaison_rls` (see `createCredentialConnection`), so they
  // run under `ctx.priv`; user-owned connections run under `ctx.rls`.
  if (ownerType === "org") {
    await ctx.priv("cli-connector-create", (priv) =>
      createCredentialConnection(priv, ctx.orgId, creator, appName, connName, {
        identifier: resolvedIdentifier,
        credentials,
        ownerType,
      }),
    )
  } else {
    await ctx.rls((rls) =>
      createCredentialConnection(rls, ctx.orgId, creator, appName, connName, {
        identifier: resolvedIdentifier,
        credentials,
        ownerType,
      }),
    )
  }
  if (fieldChanges) {
    return {
      connected: true,
      identifier: resolvedIdentifier,
      fieldChanges,
      changed: fieldChanges.map((f) => `apps.${appName}.connection.${f.field}`),
    }
  }
  ctx.log(`app '${appName}': connection '${connName}' connected (${resolvedIdentifier})`)
  return {
    connected: true,
    identifier: resolvedIdentifier,
    changed: [`apps.${appName}.connection`],
  }
}
