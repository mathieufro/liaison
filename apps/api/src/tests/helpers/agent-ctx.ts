// SPDX-License-Identifier: FSL-1.1-ALv2

import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { roleScopeGrants, roles, userRoles, users } from "~/db/schema/kernel"
import { hashPassword } from "~/lib/crypto"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { createThread } from "~/modules/threads/thread"
import { createTestOrg } from "./org"

export async function buildUserContext(userId: string, orgId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(orgId, "test-load-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
  }
}

/**
 * Bootstrap a fresh org and return its admin actor populated from the admin's
 * REAL persisted scopes/dimensionGrants (not `scopes:["*"]`) so scope-sensitive
 * assertions are genuine. The bootstrap admin holds `["*"]` as a granted scope
 * literal — that is the real grant, distinct from a fabricated test shortcut.
 */
export async function bootstrapAdminCtx(): Promise<{
  orgId: string
  userId: string
  actor: UserContext
}> {
  const { id: orgId } = await createTestOrg()
  const userId = await withSystemDb("test-find-admin-user", async (db) => {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.orgId, orgId))
      .limit(1)
    if (!row) throw new Error("bootstrapAdminCtx: no admin user for org")
    return row.id
  })
  const actor = await buildUserContext(userId, orgId)
  return { orgId, userId, actor }
}

/**
 * Bootstrap a fresh org and return an actor whose scope set is EXACTLY the
 * supplied kernel-admin scopes (no `"*"`). The bootstrap admin's real persisted
 * grant is the literal `"*"` preset (DEFAULT_ROLES.admin), which `hasScope`
 * treats as grant-all — so the "can only grant scopes you hold" guard (S4)
 * cannot fire against it. A finite, explicitly-scoped admin is required to make
 * that negative branch genuine. Creates a dedicated role with `scopes`, assigns
 * the bootstrap user to it, and clears ALL of this freshly-bootstrapped user's
 * role assignments in this org (the only one is the `"*"` admin preset) so the
 * resolved scope set is precisely `scopes`. The delete is intentionally scoped
 * to (userId, orgId): it must not touch any role this user holds in another
 * org, and the contract is "this user has exactly `scopes` in `orgId`".
 */
export async function bootstrapScopedAdminCtx(scopes: string[]): Promise<{
  orgId: string
  userId: string
  actor: UserContext
}> {
  const { orgId, userId } = await bootstrapAdminCtx()
  await withSystemDb("test-scope-down-admin", async (db) => {
    const [scoped] = await db
      .insert(roles)
      .values({ orgId, name: `scoped-admin-${crypto.randomUUID()}` })
      .returning({ id: roles.id })
    for (const scope of scopes) {
      await db.insert(roleScopeGrants).values({ roleId: scoped.id, scope })
    }
    // Drop this user's role assignments IN THIS ORG (the only one is the "*"
    // owner preset) so the resolved set is exactly `scopes`. Org-scoped so the
    // helper is safe if ever reused on a user with cross-org roles.
    await db.delete(userRoles).where(and(eq(userRoles.userId, userId), eq(userRoles.orgId, orgId)))
    await db.insert(userRoles).values({ userId, roleId: scoped.id, orgId })
  })
  const actor = await buildUserContext(userId, orgId)
  return { orgId, userId, actor }
}

/**
 * `bootstrapAdminCtx()` plus a thread created by the admin and a genuinely
 * non-admin member actor (assigned the seeded "member" preset role only — NOT
 * admin, NOT `["*"]`) so non-admin negative branches are real, not tautological.
 */
export async function bootstrapAdminThread(): Promise<{
  orgId: string
  userId: string
  actor: UserContext
  threadId: string
  memberActor: UserContext
}> {
  const { orgId, userId, actor } = await bootstrapAdminCtx()

  const thread = await withRlsContext(actor, (tx) =>
    createThread(tx, {
      orgId,
      userId,
      participantIds: [],
      title: "Setup",
      forceCreate: true,
    }),
  )

  const memberUserId = await withSystemDb("test-create-member", async (db) => {
    const passwordHash = await hashPassword("Passw0rd!")
    const [member] = await db
      .insert(users)
      .values({
        orgId,
        email: `m${crypto.randomUUID()}@t.co`,
        passwordHash,
        name: "Member",
        status: "active",
      })
      .returning({ id: users.id })
    const [memberRole] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.name, "member")))
      .limit(1)
    if (!memberRole) throw new Error("bootstrapAdminThread: seeded 'member' role missing")
    await db.insert(userRoles).values({ userId: member.id, roleId: memberRole.id, orgId })
    return member.id
  })
  const memberActor = await buildUserContext(memberUserId, orgId)

  return { orgId, userId, actor, threadId: thread.id, memberActor }
}
