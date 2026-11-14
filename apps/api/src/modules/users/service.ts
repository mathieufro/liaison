// SPDX-License-Identifier: FSL-1.1-ALv2
import { IMPORT_PLACEHOLDER_EMAIL_LIKE, isImportPlaceholderEmail } from "@liaison/shared"
import { and, eq, inArray, not, sql } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import {
  roleDimensionGrants,
  roleScopeGrants,
  roles,
  routines,
  sessions,
  userDimensionGrants,
  userRoles,
  userScopeGrants,
  users,
} from "~/db/schema/kernel"
import { routineOwnerInactiveReason } from "~/modules/agent/routines/routine-alert"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { revokeSessions } from "~/modules/auth/session-revocation"
import { assertSeatRoom } from "~/modules/org/caps"
import { resolveEffectivePermissions } from "~/modules/permissions/permissions"
import { removeAllPushDeliveryForUser } from "~/modules/push/end-user-push"
import { deleteAwayRangesOf } from "~/modules/users/away"

/**
 * Which org users a list shows. `people` (the default) are the accounts of
 * actual people; `imported` are the import placeholders (history authors that
 * cannot sign in, see @liaison/shared import-placeholder). Every people list
 * (admin Users page, users_list tool, share pickers) goes through `people`.
 */
export type UserListKind = "people" | "imported"

interface ListUsersParams {
  orgId: string
  page: number
  limit: number
  kind?: UserListKind
}

/** SQL: this user row is an import placeholder (the email domain is the marker). */
export const isImportPlaceholderSql = sql`lower(${users.email}) LIKE ${IMPORT_PLACEHOLDER_EMAIL_LIKE}`

export async function listUsers(db: RlsClient, params: ListUsersParams) {
  const { orgId, page, limit, kind = "people" } = params
  const offset = (page - 1) * limit

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      status: users.status,
      createdAt: users.createdAt,
      _total: sql<number>`COUNT(*) OVER()::int`,
    })
    .from(users)
    .where(
      and(
        eq(users.orgId, orgId),
        kind === "imported" ? isImportPlaceholderSql : not(isImportPlaceholderSql),
      ),
    )
    // Active people first, then suspended, then deactivated; by name within each.
    .orderBy(
      sql`CASE ${users.status} WHEN 'active' THEN 0 WHEN 'suspended' THEN 1 ELSE 2 END`,
      sql`lower(${users.name})`,
      users.id,
    )
    .limit(limit)
    .offset(offset)

  const total = rows[0]?._total ?? 0
  const ids = rows.map((r) => r.id)
  const roleRows = ids.length
    ? await db
        .select({
          userId: userRoles.userId,
          roleId: roles.id,
          roleName: roles.name,
        })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(and(eq(userRoles.orgId, orgId), inArray(userRoles.userId, ids)))
    : []
  const rolesByUser = new Map<string, Array<{ id: string; name: string }>>()
  for (const r of roleRows) {
    const arr = rolesByUser.get(r.userId) ?? []
    arr.push({ id: r.roleId, name: r.roleName })
    rolesByUser.set(r.userId, arr)
  }
  return {
    rows: rows.map(({ _total, ...rest }) => ({
      ...rest,
      roles: rolesByUser.get(rest.id) ?? [],
    })),
    total,
  }
}

/**
 * Detailed user data for the admin user-detail page. Combines identity, role
 * assignments, effective scopes (exactly the token's set, with provenance), and
 * dimension grants.
 */
export async function getUserDetail(db: RlsClient, params: { orgId: string; userId: string }) {
  const { orgId, userId } = params
  const [identity] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      avatarUrl: users.avatarUrl,
      status: users.status,
      timezone: users.timezone,
      locale: users.locale,
      createdAt: users.createdAt,
      lastLoginAt: sql<Date | null>`(
        SELECT max(${sessions.createdAt})
        FROM ${sessions}
        WHERE ${sessions.userId} = ${users.id}
          AND ${sessions.orgId} = ${users.orgId}
      )`,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .limit(1)
  if (!identity) return null

  const userRoleRows = await db
    .select({ id: roles.id, name: roles.name, description: roles.description })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(userRoles.userId, userId), eq(userRoles.orgId, orgId)))

  const roleIds = userRoleRows.map((r) => r.id)
  const roleScopeRows = roleIds.length
    ? await db
        .select({
          roleId: roleScopeGrants.roleId,
          roleName: roles.name,
          scope: roleScopeGrants.scope,
        })
        .from(roleScopeGrants)
        .innerJoin(roles, eq(roles.id, roleScopeGrants.roleId))
        .where(inArray(roleScopeGrants.roleId, roleIds))
    : []

  const directScopeRows = await db
    .select({ scope: userScopeGrants.scope })
    .from(userScopeGrants)
    .where(and(eq(userScopeGrants.userId, userId), eq(userScopeGrants.orgId, orgId)))

  // The scope SET is the token's own (resolveEffectivePermissions is what
  // loadEffectivePermissions builds tokens from): role and direct grants, the
  // every-member scopes, the org MCP servers the person may use, minus the
  // scopes of restricted apps they are kept out of. The grant rows above only
  // annotate where each scope came from, so this view cannot drift from
  // enforcement. Read privileged like the token path; the RLS read of the
  // identity above already proved the caller may see this person.
  const resolved = await withPrivilegedDb(orgId, "user-detail-effective-scopes", (tx) =>
    resolveEffectivePermissions(tx, userId, orgId),
  )
  const fromRolesByScope = new Map<string, string[]>()
  for (const r of roleScopeRows) {
    const names = fromRolesByScope.get(r.scope) ?? []
    if (!names.includes(r.roleName)) names.push(r.roleName)
    fromRolesByScope.set(r.scope, names)
  }
  const directScopes = new Set(directScopeRows.map((r) => r.scope))
  const everyMemberScopes = new Set(resolved.everyMemberScopes)
  const mcpAccessScopes = new Set(resolved.mcpAccessScopes)
  const effectiveScopes = resolved.scopes.map((scope) => ({
    scope,
    fromRoles: fromRolesByScope.get(scope) ?? [],
    direct: directScopes.has(scope),
    /** Held by every active member (kernel or an installed app's every-member scopes). */
    everyMember: everyMemberScopes.has(scope),
    /** Held through an org MCP server this person may use. */
    mcpAccess: mcpAccessScopes.has(scope),
  }))

  const inheritedDimRows = roleIds.length
    ? await db
        .select({
          dimensionKey: roleDimensionGrants.dimensionKey,
          values: roleDimensionGrants.dimensionValues,
          roleId: roleDimensionGrants.roleId,
          roleName: roles.name,
        })
        .from(roleDimensionGrants)
        .innerJoin(roles, eq(roles.id, roleDimensionGrants.roleId))
        .where(inArray(roleDimensionGrants.roleId, roleIds))
    : []

  const directDimRows = await db
    .select({
      dimensionKey: userDimensionGrants.dimensionKey,
      values: userDimensionGrants.dimensionValues,
    })
    .from(userDimensionGrants)
    .where(and(eq(userDimensionGrants.userId, userId), eq(userDimensionGrants.orgId, orgId)))

  const dimensions: Record<
    string,
    { direct: string[]; inherited: Array<{ roleId: string; roleName: string; values: string[] }> }
  > = {}
  for (const r of inheritedDimRows) {
    dimensions[r.dimensionKey] ??= { direct: [], inherited: [] }
    const slot = dimensions[r.dimensionKey]
    slot.inherited.push({
      roleId: r.roleId,
      roleName: r.roleName,
      values: (r.values as string[]) ?? [],
    })
  }
  for (const r of directDimRows) {
    dimensions[r.dimensionKey] ??= { direct: [], inherited: [] }
    const slot = dimensions[r.dimensionKey]
    slot.direct = (r.values as string[]) ?? []
  }

  return {
    ...identity,
    roles: userRoleRows,
    effectiveScopes,
    /** Restricted apps this person is kept out of: none of their scopes are held. */
    deniedApps: resolved.deniedApps,
    dimensions,
  }
}

/** Lightweight, same-org user fields safe to expose to any authenticated org member. */
export async function getUserPreview(db: RlsClient, params: { orgId: string; userId: string }) {
  const { orgId, userId } = params
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      status: users.status,
    })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .limit(1)
  return user ?? null
}

export async function getProfile(db: RlsClient, userId: string) {
  // Explicit allowlist — new columns are excluded by default.
  // Never SELECT * from users; passwordHash/totpSecret/recoveryCodes never leave the DB.
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      timezone: users.timezone,
      locale: users.locale,
      status: users.status,
      totpEnabled: users.totpEnabled,
      orgId: users.orgId,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  if (!user) return null
  return user
}

interface UpdateProfileParams {
  name?: string
  // The profile picture is set via the dedicated avatar endpoints (avatar-service),
  // never through this generic profile update.
  timezone?: string
  locale?: string
}

export async function updateProfile(
  db: RlsClient,
  params: { userId: string; orgId: string; updates: UpdateProfileParams },
) {
  const { userId, orgId, updates } = params
  const [updated] = await db
    .update(users)
    .set({ ...updates, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .returning()
  if (!updated) return null

  const { passwordHash, totpSecret, recoveryCodes, ...profile } = updated

  await db.queueEvent({
    app: "kernel",
    entity: "user",
    action: "updated",
    entityId: userId,
    orgId,
    actorId: userId,
    data: profile,
  })

  return profile
}

/** The actor may not act on this account: it carries more authority than theirs, or it is the last admin. */
export class UserAuthorityError extends Error {
  constructor(
    readonly code: "OUTRANKED" | "LAST_ADMIN",
    message: string,
  ) {
    super(message)
    this.name = "UserAuthorityError"
  }
}

/**
 * Deactivating or reactivating an account is a power over that person's whole
 * access, so it follows the same rule as assigning them a role: the actor's
 * scopes must cover every scope the target holds. A delegated user-manager
 * (`kernel:users:admin` without the wildcard) therefore cannot lock out, or
 * bring back, an account with more authority than their own.
 */
async function assertActorOutranksTarget(
  db: PrivilegedDb,
  params: { targetId: string; orgId: string; actorScopes: readonly string[] },
): Promise<void> {
  const { targetId, orgId, actorScopes } = params
  const held = [...actorScopes]
  if (held.includes("*")) return
  const { loadEffectivePermissions, hasScope } = await import("~/modules/permissions/permissions")
  const target = await loadEffectivePermissions(db, targetId, orgId)
  const uncovered = target.scopes.filter((scope) => !hasScope(scope, held))
  if (uncovered.length > 0) {
    throw new UserAuthorityError(
      "OUTRANKED",
      "This account holds more authority than you do, so you cannot change its status",
    )
  }
}

/** Ids of the active accounts that hold the wildcard scope, through a role or directly. */
async function activeAdminIds(db: PrivilegedDb, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.orgId, orgId),
        eq(users.status, "active"),
        sql`(
          EXISTS (
            SELECT 1 FROM ${userScopeGrants}
            WHERE ${userScopeGrants.userId} = ${users.id}
              AND ${userScopeGrants.orgId} = ${users.orgId}
              AND ${userScopeGrants.scope} = '*'
          )
          OR EXISTS (
            SELECT 1 FROM ${userRoles}
            JOIN ${roleScopeGrants} ON ${roleScopeGrants.roleId} = ${userRoles.roleId}
            WHERE ${userRoles.userId} = ${users.id}
              AND ${userRoles.orgId} = ${users.orgId}
              AND ${roleScopeGrants.scope} = '*'
          )
        )`,
      ),
    )
  return rows.map((r) => r.id)
}

/**
 * Whether the actor may deactivate the target at all: their authority covers the target's, and
 * the target is not the last administrator. Throws `UserAuthorityError`. A caller that reads
 * anything about the target first (the companies they manage) runs this before that read.
 */
export async function assertMayDeactivate(
  db: PrivilegedDb,
  params: { targetId: string; orgId: string; actorScopes: readonly string[] },
): Promise<void> {
  const { targetId, orgId } = params
  await assertActorOutranksTarget(db, params)
  // The last active holder of the wildcard scope cannot be deactivated: nobody
  // would be left who can administer the organisation.
  const admins = await activeAdminIds(db, orgId)
  if (admins.includes(targetId) && admins.every((id) => id === targetId)) {
    throw new UserAuthorityError("LAST_ADMIN", "Cannot deactivate the last administrator")
  }
}

export async function deactivateUser(
  db: PrivilegedDb,
  params: { targetId: string; actorId: string; orgId: string; actorScopes: readonly string[] },
) {
  const { targetId, actorId, orgId, actorScopes } = params

  // Self-deactivation guard at service layer (defense-in-depth for future callers)
  if (targetId === actorId) {
    throw new Error("Cannot deactivate own account")
  }

  await assertMayDeactivate(db, { targetId, orgId, actorScopes })

  const [result] = await db
    .update(users)
    .set({ status: "deactivated", authVersion: sql`auth_version + 1` })
    .where(and(eq(users.id, targetId), eq(users.orgId, orgId)))
    .returning({ id: users.id })
  if (!result) return null
  const ended = await db
    .delete(sessions)
    .where(eq(sessions.userId, targetId))
    .returning({ id: sessions.id })
  // A deactivated person's devices stop receiving their notifications.
  await removeAllPushDeliveryForUser(db, targetId)
  // Their away ranges go at once; a standing next in line naming them reads as absent.
  await deleteAwayRangesOf(db, orgId, targetId)
  // Their routines act for nobody now: they read paused, with why, at once rather than at their
  // next tick (which would pause them too, routine-worker.ts). Reactivating the owner lets the
  // next tick run them again; a routine its owner switched off or paused stays as it was.
  await db
    .update(routines)
    .set({
      status: "paused_scope_mismatch",
      lastRunError: routineOwnerInactiveReason("deactivated"),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(routines.orgId, orgId),
        eq(routines.ownerUserId, targetId),
        eq(routines.status, "active"),
      ),
    )

  // Credential revocation: the auth_version bump above is the durable backstop,
  // but every process caches auth state for 15s. Broadcast the invalidation so
  // the deactivated user's existing access tokens stop authenticating on all
  // nodes immediately rather than after the cache TTL.
  invalidateAuthCache(targetId)
  // And their sessions' access tokens, including any open socket. Recorded
  // before the caller's transaction commits: were it to roll back, the user
  // would only have to refresh (the session rows are still there).
  revokeSessions(
    ended.map((r) => r.id),
    "user-deactivated",
  )

  await db.queueEvent({
    app: "kernel",
    entity: "user",
    action: "deactivate",
    orgId,
    actorId,
    entityId: targetId,
  })

  return result
}

/** Refusal to reactivate an import placeholder (see reactivateUser). */
export class ImportPlaceholderError extends Error {
  readonly code = "IMPORT_PLACEHOLDER"
  constructor() {
    super(
      "This account is an import placeholder (the author of imported history). It cannot sign in and cannot be reactivated. Invite the person with their real email instead.",
    )
    this.name = "ImportPlaceholderError"
  }
}

export async function reactivateUser(
  db: PrivilegedDb,
  params: { targetId: string; actorId: string; orgId: string; actorScopes: readonly string[] },
) {
  const { targetId, actorId, orgId, actorScopes } = params

  await assertActorOutranksTarget(db, { targetId, orgId, actorScopes })

  // An import placeholder is a history author, not a person: it has no
  // password and an undeliverable address, so reactivating it cannot let
  // anyone in and only adds a second "person" beside the real colleague.
  const [target] = await db
    .select({ email: users.email, status: users.status })
    .from(users)
    .where(and(eq(users.id, targetId), eq(users.orgId, orgId)))
  if (target && isImportPlaceholderEmail(target.email)) {
    throw new ImportPlaceholderError()
  }
  // A reactivated person takes a seat again (modules/org/caps.ts): checked
  // under the org's seats lock, in this transaction.
  if (target?.status === "deactivated") await assertSeatRoom(db, orgId)

  // Only reactivate if currently deactivated — prevents false audit entries
  const [updated] = await db
    .update(users)
    .set({ status: "active", authVersion: sql`auth_version + 1` })
    .where(and(eq(users.id, targetId), eq(users.orgId, orgId), eq(users.status, "deactivated")))
    .returning({ id: users.id, status: users.status })

  if (!updated) return null

  // The auth_version bump invalidates any token minted while deactivated; drop
  // the cached (stale "deactivated") auth state everywhere so the reactivated
  // user can authenticate again without waiting out the cache TTL.
  invalidateAuthCache(targetId)

  await db.queueEvent({
    app: "kernel",
    entity: "user",
    action: "reactivate",
    orgId,
    actorId,
    entityId: targetId,
  })

  return updated
}
