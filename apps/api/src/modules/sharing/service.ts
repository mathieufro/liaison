// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Generic, Drive-style sharing for any resource (migration 0117).
//
// A shareable resource row carries `owner_user_id` and `org_access` ('none' |
// 'viewer' | 'editor', what every org member gets). `kernel.resource_grants`
// adds explicit grants to a USER, a ROLE or a DIMENSION value, each viewer or
// editor. A dimension grant ("mail:inbox=<account id>") is how something is
// shared with "whoever has access to that mailbox": it follows the mailbox's
// access as it changes, instead of copying a user list that goes stale.
//
// Enforcement is in the database: each resource's RLS policies call
// `kernel.resource_grant_role(type, id)`, and `kernel.can_manage_sharing`
// dispatches to the resource type's own "who may change the sharing" rule.
// This module is the one TypeScript surface over it: read and replace a
// resource's grants, ask the database for the actor's role, and keep the
// search ACL projection (org_wide / acl_user_ids / acl_role_ids) current.
//
// Users of it: Knowledge documents (apps/knowledge/service.ts), contacts
// (modules/contacts/sharing.ts) and dashboards (modules/dashboards/sharing.ts). A new shareable resource adds its columns, a
// can_manage function and a row in kernel.shareable_resource_types, plus an
// entry in SHAREABLE_RESOURCES below.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { transactionRole } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"

const K = () => drizzleSql.raw(schemaRef("kernel"))

export type ShareRole = "viewer" | "editor"
export type OrgAccess = "none" | "viewer" | "editor"

export interface UserGrant {
  userId: string
  role: ShareRole
}
export interface RoleGrant {
  roleId: string
  role: ShareRole
}
export interface DimensionGrant {
  /** Full dimension key, e.g. "mail:inbox". */
  key: string
  value: string
  role: ShareRole
}

export interface ResourceGrants {
  users: UserGrant[]
  roles: RoleGrant[]
  dimensions: DimensionGrant[]
}

/** A replacement: each kind given REPLACES that kind's grants; omitted = unchanged. */
export type GrantsPatch = Partial<ResourceGrants>

interface ShareableResource {
  schema: string
  table: string
  /** Columns whose user ids always read the resource (search projection). */
  aclUserColumns: string[]
}

export const SHAREABLE_RESOURCES: Record<string, ShareableResource> = {
  "knowledge.document": {
    schema: "app_knowledge",
    table: "documents",
    aclUserColumns: ["owner_user_id", "created_by"],
  },
  "kernel.contact": { schema: "kernel", table: "contacts", aclUserColumns: ["owner_user_id"] },
  // A company's sharing follows its creator, never its account manager (0303).
  "kernel.company": { schema: "kernel", table: "companies", aclUserColumns: ["created_by"] },
  "kernel.dashboard": { schema: "kernel", table: "dashboards", aclUserColumns: ["owner_user_id"] },
  "kernel.dashboard_table": {
    schema: "kernel",
    table: "dashboard_tables",
    aclUserColumns: ["owner_user_id"],
  },
}

function resourceFor(type: string): ShareableResource {
  const resource = SHAREABLE_RESOURCES[type]
  if (!resource) throw new Error(`not a shareable resource type: ${type}`)
  return resource
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIMENSION_KEY = /^[a-z0-9_-]+(:[a-z0-9_-]+)?$/i

export function dimensionGrantee(key: string, value: string): string {
  if (!DIMENSION_KEY.test(key)) throw new Error(`invalid dimension key: ${key}`)
  if (!value || value.includes("=") || value === "*") {
    throw new Error("a dimension grant names one concrete value")
  }
  return `${key}=${value}`
}

function parseDimensionGrantee(grantee: string): { key: string; value: string } {
  const at = grantee.indexOf("=")
  return { key: grantee.slice(0, at), value: grantee.slice(at + 1) }
}

function localKey(key: string): string {
  return key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key
}

/**
 * The search keys a dimension grant is projected to (into acl_role_ids), so
 * the search filter matches it exactly as `kernel.has_dimension_value` does:
 * the value under the full and the local key, each key's wildcard, and the
 * global wildcard. The searcher's own keys come from `actorSearchKeys`.
 */
export function searchKeysForDimension(key: string, value: string): string[] {
  const local = localKey(key)
  return [`dim:${key}=${value}`, `dim:${local}=${value}`, `dim:${key}=*`, `dim:${local}=*`, "dim:*"]
}

/** The search keys an actor holds through their dimension grants. */
export function actorSearchKeys(dimensionGrants: Record<string, string[]> | undefined): string[] {
  const keys = new Set<string>()
  for (const [key, values] of Object.entries(dimensionGrants ?? {})) {
    for (const value of values) {
      if (key === "*" && value === "*") keys.add("dim:*")
      else keys.add(`dim:${key}=${value}`)
    }
  }
  return [...keys]
}

/**
 * The strongest role a GIVEN actor holds on the resource through a grant, for
 * callers whose transaction is not that actor's (a privileged or bridge
 * transaction): the same rule as `kernel.resource_grant_role`, evaluated from
 * the actor's user id, roles and dimension grants instead of the GUCs.
 */
export async function actorGrantRole(
  tx: Pick<RlsClient, "execute">,
  type: string,
  resourceId: string,
  actor: { userId: string; roles?: string[]; dimensionGrants?: Record<string, string[]> },
): Promise<ShareRole | null> {
  resourceFor(type)
  const rows = extractRows<{ grantee_kind: string; grantee: string; role: ShareRole }>(
    await tx.execute(drizzleSql`
      SELECT grantee_kind, grantee, role FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.resource_grants
       WHERE resource_type = ${type} AND resource_id = ${resourceId}::uuid`),
  )
  const roles = new Set(actor.roles ?? [])
  const dims = actor.dimensionGrants ?? {}
  const holdsDimension = (key: string, value: string) => {
    const local = localKey(key)
    const has = (k: string) => (dims[k] ?? []).some((v) => v === "*" || v === value)
    return (dims["*"] ?? []).includes("*") || has(key) || has(local)
  }
  let best: ShareRole | null = null
  for (const row of rows) {
    const applies =
      (row.grantee_kind === "user" && row.grantee === actor.userId) ||
      (row.grantee_kind === "role" && roles.has(row.grantee)) ||
      (row.grantee_kind === "dimension" &&
        holdsDimension(
          parseDimensionGrantee(row.grantee).key,
          parseDimensionGrantee(row.grantee).value,
        ))
    if (!applies) continue
    if (row.role === "editor") return "editor"
    best = "viewer"
  }
  return best
}

/** May the current RLS actor change who the resource is shared with? */
export async function canManageSharing(
  tx: Pick<RlsClient, "execute">,
  type: string,
  resourceId: string,
): Promise<boolean> {
  resourceFor(type)
  const [row] = extractRows<{ ok: boolean }>(
    await tx.execute(
      drizzleSql`SELECT ${K()}.can_manage_sharing(${type}, ${resourceId}::uuid) AS ok`,
    ),
  )
  return row?.ok === true
}

export async function listGrants(
  tx: Pick<RlsClient, "execute">,
  type: string,
  resourceId: string,
): Promise<ResourceGrants> {
  resourceFor(type)
  const rows = extractRows<{ grantee_kind: string; grantee: string; role: ShareRole }>(
    await tx.execute(drizzleSql`
      SELECT grantee_kind, grantee, role FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.resource_grants
       WHERE resource_type = ${type} AND resource_id = ${resourceId}::uuid
       ORDER BY created_at ASC, grantee ASC`),
  )
  const out: ResourceGrants = { users: [], roles: [], dimensions: [] }
  for (const row of rows) {
    if (row.grantee_kind === "user") out.users.push({ userId: row.grantee, role: row.role })
    else if (row.grantee_kind === "role") out.roles.push({ roleId: row.grantee, role: row.role })
    else out.dimensions.push({ ...parseDimensionGrantee(row.grantee), role: row.role })
  }
  return out
}

/**
 * Replace a resource's grants, kind by kind (a kind left out is unchanged; an
 * empty list clears it), then refresh its search projection. The grants
 * table's write policy refuses the whole call unless the actor may manage the
 * resource's sharing, so a caller cannot grant what it does not control.
 * `protect` names grants that define the resource (a mailbox contact's grant
 * to its mailbox): the call never removes nor changes them.
 */
export async function replaceGrants(
  tx: RlsClient,
  actor: { orgId: string; userId: string | null },
  type: string,
  resourceId: string,
  patch: GrantsPatch,
  protect: Array<{ kind: "user" | "role" | "dimension"; grantee: string }> = [],
): Promise<void> {
  resourceFor(type)
  const desired: Array<{ kind: "user" | "role" | "dimension"; entries: Map<string, ShareRole> }> =
    []
  if (patch.users) {
    const m = new Map<string, ShareRole>()
    for (const g of patch.users) {
      if (!UUID.test(g.userId)) throw new Error(`not a user id: ${g.userId}`)
      m.set(g.userId.toLowerCase(), g.role)
    }
    desired.push({ kind: "user", entries: m })
  }
  if (patch.roles) {
    const m = new Map<string, ShareRole>()
    for (const g of patch.roles) {
      if (!UUID.test(g.roleId)) throw new Error(`not a role id: ${g.roleId}`)
      m.set(g.roleId.toLowerCase(), g.role)
    }
    desired.push({ kind: "role", entries: m })
  }
  if (patch.dimensions) {
    const m = new Map<string, ShareRole>()
    for (const g of patch.dimensions) m.set(dimensionGrantee(g.key, g.value), g.role)
    desired.push({ kind: "dimension", entries: m })
  }
  const grants = drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.resource_grants`)
  const createdBy = actor.userId && UUID.test(actor.userId) ? actor.userId : null
  for (const { kind, entries } of desired) {
    for (const p of protect) if (p.kind === kind) entries.delete(p.grantee)
    const keep = [
      ...entries.keys(),
      ...protect.filter((p) => p.kind === kind).map((p) => p.grantee),
    ]
    await tx.execute(drizzleSql`
      DELETE FROM ${grants}
       WHERE resource_type = ${type} AND resource_id = ${resourceId}::uuid AND grantee_kind = ${kind}
         ${
           keep.length > 0
             ? drizzleSql`AND grantee NOT IN (${drizzleSql.join(
                 keep.map((g) => drizzleSql`${g}`),
                 drizzleSql`, `,
               )})`
             : drizzleSql``
         }`)
    for (const [grantee, role] of entries) {
      await tx.execute(drizzleSql`
        INSERT INTO ${grants}
          (org_id, resource_type, resource_id, grantee_kind, grantee, role, created_by)
        VALUES (${actor.orgId}::uuid, ${type}, ${resourceId}::uuid, ${kind}, ${grantee}, ${role},
                ${createdBy}::uuid)
        ON CONFLICT (resource_type, resource_id, grantee_kind, grantee)
        DO UPDATE SET role = EXCLUDED.role`)
    }
  }
  await recomputeSearchAcl(tx, type, resourceId)
}

/**
 * Refresh the resource's search projection from its owner columns and grants:
 * acl_user_ids = those users; acl_role_ids = granted role ids plus the search
 * keys of its dimension grants (`searchKeysForDimension`). `org_wide` is a
 * generated column. The UPDATE is `kernel.recompute_search_acl` (migration
 * 0178), a SECURITY DEFINER function that derives the projection from the
 * database alone and only touches a row of the transaction's org: the caller
 * may not hold UPDATE on the row (a viewer who manages sharing), and a request
 * transaction cannot elevate. It runs on the caller's transaction, so the
 * projection commits with the change that caused it.
 */
export async function recomputeSearchAcl(
  tx: Pick<RlsClient, "execute">,
  type: string,
  resourceId: string,
): Promise<void> {
  resourceFor(type)
  await tx.execute(
    drizzleSql`SELECT ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.recompute_search_acl(${type}, ${resourceId}::uuid)`,
  )
}

/**
 * Run `fn` as liaison_admin inside the caller's transaction, then return to
 * the transaction's role. For writes that must commit with an operation that
 * also runs under the caller's RLS (the contact merge's re-point). Only a
 * transaction whose LOGIN can step into liaison_admin can do this: the
 * privileged login, or an RLS transaction opened on it by
 * `withElevatableRlsFrom`. A request transaction on the request login is
 * refused here, loudly, rather than by Postgres halfway through. Every
 * statement run this way must pin itself to the org. On error the transaction
 * is aborted anyway, so the role is not restored.
 */
export async function asAdmin<T>(tx: Pick<RlsClient, "execute">, fn: () => Promise<T>): Promise<T> {
  const { role, canElevate } = await transactionRole(tx)
  if (role === "liaison_admin") return fn()
  if (!canElevate || !/^liaison_[a-z_]+$/.test(role)) {
    throw new Error(
      "asAdmin: this transaction's login cannot step into liaison_admin; open it with withElevatableRlsFrom",
    )
  }
  await tx.execute(drizzleSql.raw("SET LOCAL ROLE liaison_admin"))
  const out = await fn()
  await tx.execute(drizzleSql.raw(`SET LOCAL ROLE ${quoteIdent(role)}`))
  return out
}

/**
 * A user's grants and search-ACL membership move to another user (an import
 * placeholder merged into the real person). A grant the target already holds
 * on the same resource wins; the moved one is dropped. Every shareable row
 * whose ACL named the old user is recomputed (its owner column may just have
 * moved too). Runs in the caller's (privileged, org-pinned) transaction.
 */
export async function moveUserSharing(
  tx: Pick<RlsClient, "execute">,
  orgId: string,
  fromUserId: string,
  toUserId: string,
): Promise<number> {
  const grants = drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.resource_grants`)
  await tx.execute(drizzleSql`
    DELETE FROM ${grants} x
     WHERE x.org_id = ${orgId}::uuid AND x.grantee_kind = 'user' AND x.grantee = ${fromUserId}
       AND EXISTS (SELECT 1 FROM ${grants} y
                    WHERE y.resource_type = x.resource_type AND y.resource_id = x.resource_id
                      AND y.grantee_kind = 'user' AND y.grantee = ${toUserId})`)
  await tx.execute(drizzleSql`
    UPDATE ${grants} SET grantee = ${toUserId}
     WHERE org_id = ${orgId}::uuid AND grantee_kind = 'user' AND grantee = ${fromUserId}`)
  let recomputed = 0
  for (const [type, resource] of Object.entries(SHAREABLE_RESOURCES)) {
    const table = drizzleSql.raw(
      `${quoteIdent(schemaRef(resource.schema))}.${quoteIdent(resource.table)}`,
    )
    const ids = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${table}
         WHERE org_id = ${orgId}::uuid AND acl_user_ids ? ${fromUserId}`),
    ).map((r) => r.id)
    for (const id of ids) await recomputeSearchAcl(tx, type, id)
    recomputed += ids.length
  }
  return recomputed
}
