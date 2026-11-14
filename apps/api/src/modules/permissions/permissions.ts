// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq, exists, inArray, ne, or } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { mcpConnectionAccess, mcpConnections } from "~/db/schema/app_mcp_manager"
import {
  apps,
  orgAppAccess,
  roleDimensionGrants,
  roleScopeGrants,
  userDimensionGrants,
  userRoles,
  userScopeGrants,
  users,
} from "~/db/schema/kernel"
import { KERNEL_EVERY_MEMBER_SCOPES } from "~/modules/permissions/every-member-scopes"

export function hasScope(required: string, granted: string[]): boolean {
  if (!required) return false
  const requiredParts = required.split(":")
  return granted.some((g) => {
    // Full wildcard grants everything.
    if (g === "*") return true
    const grantedParts = g.split(":")
    if (grantedParts.length > requiredParts.length) return false
    // A trailing `:*` segment matches any remaining required segments
    // (e.g. `knowledge:*` grants `knowledge:links:create`). Mirrors the
    // DB-side `app_has_scope` which accepts `<prefix>:*` as a wildcard.
    // Mid-segment wildcards (e.g. `a:*:c`) are NOT supported — they diverge
    // from DB semantics and allow unintended scope matches.
    const wildcardIdx = grantedParts.indexOf("*")
    if (wildcardIdx !== -1 && wildcardIdx !== grantedParts.length - 1) {
      // Mid-segment wildcard: skip this grant rather than matching erroneously
      return false
    }
    return grantedParts.every((part, i) => part === "*" || part === requiredParts[i])
  })
}

interface PermissionSources {
  roleIds: string[]
  roleScopeGrants: { scope: string }[]
  userScopeGrants: { scope: string }[]
  roleDimensionGrants: { dimensionKey: string; dimensionValues: string[] }[]
  userDimensionGrants: { dimensionKey: string; dimensionValues: string[] }[]
}

interface EffectivePermissions {
  roles: string[]
  scopes: string[]
  dimensionGrants: Record<string, string[]>
}

export function computeEffectivePermissions(sources: PermissionSources): EffectivePermissions {
  // Union all scopes, deduplicated
  const scopeSet = new Set<string>()
  for (const g of sources.roleScopeGrants) scopeSet.add(g.scope)
  for (const g of sources.userScopeGrants) scopeSet.add(g.scope)

  // Union dimension grants per key, deduplicated
  const dimensions: Record<string, Set<string>> = {}
  for (const g of [...sources.roleDimensionGrants, ...sources.userDimensionGrants]) {
    if (!dimensions[g.dimensionKey]) dimensions[g.dimensionKey] = new Set()
    for (const v of g.dimensionValues) dimensions[g.dimensionKey].add(v)
  }

  const dimensionGrants: Record<string, string[]> = {}
  for (const [key, valueSet] of Object.entries(dimensions)) {
    dimensionGrants[key] = [...valueSet]
  }

  return { roles: sources.roleIds, scopes: [...scopeSet], dimensionGrants }
}

/** Load effective permissions for a user from DB. Used during token issuance/refresh. */
export async function loadEffectivePermissions(
  tx: PrivilegedDb,
  userId: string,
  orgId: string,
): Promise<EffectivePermissions> {
  const { roles, scopes, dimensionGrants } = await resolveEffectivePermissions(tx, userId, orgId)
  return { roles, scopes, dimensionGrants }
}

/**
 * The token's permissions plus where the computed (non-grant-table) scopes came
 * from: the every-member set, the org MCP servers the person may use, and the
 * restricted apps whose scopes were dropped. `scopes` is exactly what
 * `loadEffectivePermissions` puts in a token (it is built on this), so a
 * diagnosis (admin user detail, `kernel__describe_user_access`) reading it can
 * never disagree with enforcement.
 */
export async function resolveEffectivePermissions(
  tx: PrivilegedDb,
  userId: string,
  orgId: string,
): Promise<
  EffectivePermissions & {
    everyMemberScopes: string[]
    mcpAccessScopes: string[]
    deniedApps: string[]
  }
> {
  // Load role assignments
  const roleAssignments = await tx
    .select()
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.orgId, orgId)))
  const roleIds = roleAssignments.map((r) => r.roleId)

  // Load role-level grants
  const roleScopes = roleIds.length
    ? await tx.select().from(roleScopeGrants).where(inArray(roleScopeGrants.roleId, roleIds))
    : []
  const roleDims = roleIds.length
    ? await tx
        .select()
        .from(roleDimensionGrants)
        .where(inArray(roleDimensionGrants.roleId, roleIds))
    : []

  // Load user-level overrides
  const userScopes = await tx
    .select()
    .from(userScopeGrants)
    .where(and(eq(userScopeGrants.userId, userId), eq(userScopeGrants.orgId, orgId)))
  const userDims = await tx
    .select()
    .from(userDimensionGrants)
    .where(and(eq(userDimensionGrants.userId, userId), eq(userDimensionGrants.orgId, orgId)))

  const everyMember = await everyMemberScopeGrants(tx, userId, orgId)
  const mcpAccess = await mcpServerAccessGrants(tx, { userId, orgId, roleIds })
  const effective = computeEffectivePermissions({
    roleIds,
    roleScopeGrants: [...roleScopes, ...everyMember, ...mcpAccess],
    userScopeGrants: userScopes,
    roleDimensionGrants: roleDims,
    userDimensionGrants: userDims,
  })
  const denied = await restrictedAppsDeniedTo(tx, {
    orgId,
    userId,
    roleIds,
    scopes: effective.scopes,
  })
  return {
    ...effective,
    scopes: dropAppScopes(effective.scopes, denied),
    everyMemberScopes: [...new Set(everyMember.map((g) => g.scope))],
    mcpAccessScopes: [...new Set(mcpAccess.map((g) => g.scope))],
    deniedApps: [...denied],
  }
}

/**
 * The scopes every member holds: the kernel's own (`KERNEL_EVERY_MEMBER_SCOPES`)
 * and those the org's installed apps give every member (manifest
 * `everyMemberScopes`, recorded on `kernel.apps.every_member_scopes` at
 * registration), for an ACTIVE member of the org only; nothing for a suspended
 * or deactivated account, an external user, a person of another org, or an app
 * removed from the workspace. Not a role: no admin edit removes them. The caller still applies
 * the app-access restriction (S20) after the union, so a person kept out of a
 * restricted app loses these with the rest of the app's scopes; an Off app keeps
 * them in the token like its role grants, and its routes stay closed by the
 * app-state gate.
 */
export async function everyMemberScopeGrants(
  tx: PrivilegedDb,
  userId: string,
  orgId: string,
): Promise<{ scope: string }[]> {
  // The member first (active, of this org), then the apps beside them: a member
  // of an org whose apps are all removed still holds the kernel's own
  // every-member scopes (every-member-scopes.ts).
  const rows = await tx
    .select({ scopes: apps.everyMemberScopes })
    .from(users)
    .leftJoin(apps, and(eq(apps.orgId, users.orgId), ne(apps.status, "removed")))
    .where(
      and(
        eq(users.id, userId),
        eq(users.orgId, orgId),
        eq(users.status, "active"),
        eq(users.userType, "member"),
      ),
    )
  if (rows.length === 0) return []
  return [...KERNEL_EVERY_MEMBER_SCOPES, ...rows.flatMap((r) => r.scopes ?? [])].map((scope) => ({
    scope,
  }))
}

/**
 * The tool namespaces (`mcp:<slug>`) of the org MCP servers this person may use:
 * every server whose access is `everyone`, and every `restricted` one that lists
 * the person or one of their roles (migration 0198). An ACTIVE member only, like
 * `everyMemberScopeGrants`. Computed here rather than written as role grants, so
 * a role created later and a member who joins later are covered. Personal
 * connections are not read: their owner holds the namespace as a direct grant
 * (apps/mcp-manager/service/connections.ts). Org admins hold `*` and need none.
 */
export async function mcpServerAccessGrants(
  tx: PrivilegedDb,
  args: { userId: string; orgId: string; roleIds: readonly string[] },
): Promise<{ scope: string }[]> {
  const listed = args.roleIds.length
    ? or(
        and(
          eq(mcpConnectionAccess.principalType, "user"),
          eq(mcpConnectionAccess.principalId, args.userId),
        ),
        and(
          eq(mcpConnectionAccess.principalType, "role"),
          inArray(mcpConnectionAccess.principalId, [...args.roleIds]),
        ),
      )
    : and(
        eq(mcpConnectionAccess.principalType, "user"),
        eq(mcpConnectionAccess.principalId, args.userId),
      )
  const rows = await tx
    .select({ slug: mcpConnections.slug })
    .from(mcpConnections)
    .innerJoin(users, eq(users.orgId, mcpConnections.orgId))
    .where(
      and(
        eq(mcpConnections.orgId, args.orgId),
        eq(mcpConnections.ownershipScope, "org"),
        eq(users.id, args.userId),
        eq(users.status, "active"),
        eq(users.userType, "member"),
        or(
          eq(mcpConnections.accessMode, "everyone"),
          exists(
            tx
              .select({ one: mcpConnectionAccess.connectionId })
              .from(mcpConnectionAccess)
              .where(and(eq(mcpConnectionAccess.connectionId, mcpConnections.id), listed)),
          ),
        ),
      ),
    )
  return rows.map((r) => ({ scope: `mcp:${r.slug}` }))
}

/** The app a scope belongs to: its first segment (`tickets:tickets:read` -> `tickets`). */
export function scopeApp(scope: string): string {
  const i = scope.indexOf(":")
  return i === -1 ? scope : scope.slice(0, i)
}

/**
 * The scope prefix of an app: its name with hyphens as underscores
 * (`mcp-manager` -> `mcp_manager`), the form manifests declare their scopes in
 * (contract.ts accepts both spellings).
 */
export function appScopePrefix(app: string): string {
  return app.replace(/-/g, "_")
}

/** Does the scope belong to the app (either spelling of its prefix)? */
export function scopeBelongsToApp(scope: string, app: string): boolean {
  const prefix = scopeApp(scope)
  return prefix === app || prefix === appScopePrefix(app)
}

/**
 * Apps restricted in the workspace (S20, A3, D20) that this person may not
 * use: `access_mode = 'restricted'` and the person is neither listed nor holds
 * a listed role. Holders of `*` are exempt (empty set). The same rule as the
 * SQL `kernel.app_access_denied` the grant-table readers call.
 */
export async function restrictedAppsDeniedTo(
  tx: PrivilegedDb,
  args: { orgId: string; userId: string; roleIds: readonly string[]; scopes: readonly string[] },
): Promise<Set<string>> {
  if (args.scopes.includes("*")) return new Set()
  const restricted = await tx
    .select({ name: apps.name })
    .from(apps)
    .where(and(eq(apps.orgId, args.orgId), eq(apps.accessMode, "restricted")))
  if (restricted.length === 0) return new Set()
  const principal = args.roleIds.length
    ? or(
        and(eq(orgAppAccess.principalType, "user"), eq(orgAppAccess.principalId, args.userId)),
        and(
          eq(orgAppAccess.principalType, "role"),
          inArray(orgAppAccess.principalId, [...args.roleIds]),
        ),
      )
    : and(eq(orgAppAccess.principalType, "user"), eq(orgAppAccess.principalId, args.userId))
  const kept = await tx
    .select({ app: orgAppAccess.app })
    .from(orgAppAccess)
    .where(and(eq(orgAppAccess.orgId, args.orgId), principal))
  const keptSet = new Set(kept.map((k) => k.app))
  return new Set(restricted.map((r) => r.name).filter((name) => !keptSet.has(name)))
}

/** Drop every scope of the denied apps, prefix grants included (`app`, `app:*`, `app:...`). */
export function dropAppScopes(scopes: readonly string[], denied: ReadonlySet<string>): string[] {
  if (denied.size === 0) return [...scopes]
  const prefixes = new Set([...denied].flatMap((app) => [app, appScopePrefix(app)]))
  return scopes.filter((s) => !prefixes.has(scopeApp(s)))
}
