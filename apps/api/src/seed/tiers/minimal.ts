// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The minimal tier: nothing by itself, one row per call, on an org a test (or
// a caller) already has. Each entry point writes through the product path a
// person or an admin would take, so a row a service would refuse is refused
// here too:
//
//   person      the org admin's invitation, then the invitee's registration
//               (`createInvitation` + `inviteRegister`), as the standard tier
//               seeds its people;
//   thread      `createThread` in an RLS transaction as the person;
//   contact     `resolveContact` as the person (the resolved-contacts factory);
//   contactAddress
//               `addAddress` as the org's admin (the address book's add);
//   grantScope, revokeScope, assignRole, revokeRole
//               the admin role editor's own services (`grantUserScope`,
//               `revokeUserScope`, `assignRole`, `unassignRole`) as the org's
//               admin, which bump the person's permission version;
//   secondOrg   the provisioning CLI's org and admin provisioners (the org
//               factory), for a test that needs a second tenant.
//
// Privileged reads only (named): the org's admin and a role id by name (the
// auth middleware and the role editor read the same rows), and the person's
// permissions when a session token is minted for them (`token`), which is what
// the login path signs. One named privileged write, `privilegedAssignRole`,
// for the case no admin is left to act (a test that removed every admin
// restores them).
//
// Emails and slugs come from `demoId` on a per-process sequence, so a call
// never needs a random value and two orgs never collide.
import { and, asc, eq, like, sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { messages, organizations, roles, userRoles, users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { inviteRegister } from "~/modules/auth/auth"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { signAccessToken } from "~/modules/auth/jwt"
import { type AddressFields, addAddress } from "~/modules/contacts/addresses"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import {
  assignRole as assignRoleService,
  grantUserScope,
  revokeUserScope,
  unassignRole,
} from "~/modules/permissions/roles"
import { createScope } from "~/modules/permissions/types"
import { createThread } from "~/modules/threads/thread"
import { createInvitation } from "~/modules/users/invites"
import { demoId, seedContext } from "~/seed/context"
import { seedPersonalAgent } from "~/seed/factories/agent/agents"
import { agentDmWith } from "~/seed/factories/agent/presence"
import { provisionAdminAndRoles, provisionOrgShell } from "~/seed/factories/org/org"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import { resolveContacts } from "~/seed/factories/people/contacts"

/** A person the tier made, as a test addresses them. */
export interface Person {
  id: string
  email: string
  orgId: string
  permissionVersion: number
}

/** A person with a signed access token, as a request carries it. */
export interface Session {
  cookie: string
  bearer: string
  userId: string
  orgId: string
}

export type PersonRole = "admin" | "member"

/** The password every minimal person signs in with. */
export const MINIMAL_PASSWORD = "Passw0rd!"

/** An access token outlives any single test. */
const ACCESS_TOKEN_SECONDS = 60 * 60

let sequence = 0
const next = () => String(++sequence)

/** A short, stable token for (org, kind, n): the first block of its `demoId`. */
const tag = (orgId: string, kind: string, n: string) => demoId(orgId, kind, n).slice(0, 8)

const ctxOf = (orgId: string) => seedContext({ orgId, now: new Date(0) })

async function roleIdByName(orgId: string, name: string): Promise<string> {
  const [row] = await withPrivilegedDb(orgId, "seed-minimal:role-by-name", (tx) =>
    tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, orgId), eq(roles.name, name)))
      .limit(1),
  )
  if (!row) throw new Error(`minimal seed: role '${name}' not in org ${orgId}`)
  return row.id
}

async function orgOfUser(userId: string): Promise<string> {
  const [row] = await withSystemDb("seed-minimal:org-of-user", (tx) =>
    tx.select({ orgId: users.orgId }).from(users).where(eq(users.id, userId)).limit(1),
  )
  if (!row) throw new Error(`minimal seed: user ${userId} not found`)
  return row.orgId
}

/** The org's first admin: the account its registration (or provisioning) created. */
export async function orgAdmin(orgId: string): Promise<Person> {
  const [row] = await withPrivilegedDb(orgId, "seed-minimal:org-admin", (tx) =>
    tx
      .select({ id: users.id, email: users.email, permissionVersion: users.permissionVersion })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(eq(users.orgId, orgId), eq(roles.name, "admin"), eq(users.status, "active")))
      .orderBy(asc(users.createdAt))
      .limit(1),
  )
  if (!row) throw new Error(`minimal seed: org ${orgId} has no admin`)
  return { id: row.id, email: row.email, orgId, permissionVersion: row.permissionVersion }
}

async function adminActor(orgId: string) {
  const admin = await orgAdmin(orgId)
  return actorFor(ctxOf(orgId), admin.id)
}

/**
 * A new person in `orgId` holding `role` (default `member`): invited by the
 * org's admin, then registered with `MINIMAL_PASSWORD`.
 */
export async function person(
  orgId: string,
  opts: { role?: PersonRole; name?: string; email?: string } = {},
): Promise<Person> {
  const role = opts.role ?? "member"
  const email = (
    opts.email ?? `p-${tag(orgId, "minimal-person", next())}@minimal.test`
  ).toLowerCase()
  const admin = await adminActor(orgId)
  const roleId = await roleIdByName(orgId, role)
  const invited = await asUser(admin, (tx) =>
    createInvitation(tx as never, {
      orgId,
      email,
      roleId,
      invitedBy: admin.userId,
      actorScopes: admin.scopes,
      actorDimensionGrants: admin.dimensionGrants ?? {},
    }),
  )
  if (!invited || "error" in invited) {
    throw new Error(
      `minimal seed: invitation of ${email} refused: ${invited ? invited.error : "role not found"}`,
    )
  }
  const name = opts.name ?? (role === "admin" ? "Test Admin" : "Test Member")
  const registered = await inviteRegister(invited.inviteToken, MINIMAL_PASSWORD, name)
  if (!registered.success) {
    throw new Error(`minimal seed: registration of ${email} failed: ${registered.error}`)
  }
  const [row] = await withPrivilegedDb(orgId, "seed-minimal:person-version", (tx) =>
    tx
      .select({ permissionVersion: users.permissionVersion })
      .from(users)
      .where(eq(users.id, registered.data.userId))
      .limit(1),
  )
  return {
    id: registered.data.userId,
    email,
    orgId,
    permissionVersion: row?.permissionVersion ?? 1,
  }
}

/** A signed access token for `userId`, carrying the permissions they hold now. */
export async function token(userId: string): Promise<string> {
  const [row] = await withSystemDb("seed-minimal:token-user", (tx) =>
    tx
      .select({
        orgId: users.orgId,
        name: users.name,
        authVersion: users.authVersion,
        permissionVersion: users.permissionVersion,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )
  if (!row) throw new Error(`minimal seed: user ${userId} not found`)
  const perms = await withPrivilegedDb(row.orgId, "seed-minimal:token-permissions", (tx) =>
    loadEffectivePermissions(tx, userId, row.orgId),
  )
  return signAccessToken(
    {
      userId,
      orgId: row.orgId,
      name: row.name,
      authVersion: row.authVersion,
      permissionVersion: row.permissionVersion,
      roles: perms.roles,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    env.JWT_SECRET,
    ACCESS_TOKEN_SECONDS,
  )
}

/** The session of an existing person. */
export async function sessionOf(p: { id: string; orgId: string }): Promise<Session> {
  const bearer = await token(p.id)
  return { cookie: `access_token=${bearer}`, bearer, userId: p.id, orgId: p.orgId }
}

/** A new person in `orgId` (see `person`) with a session. */
export async function session(orgId: string, opts: { role?: PersonRole } = {}): Promise<Session> {
  return sessionOf(await person(orgId, opts))
}

/** The org admin's session. */
export async function adminSession(orgId: string): Promise<Session> {
  return sessionOf(await orgAdmin(orgId))
}

/** A plain thread created by `userId`, its owner, with `participantIds` as its other members. */
export async function thread(
  orgId: string,
  userId: string,
  opts: { title?: string; participantIds?: string[] } = {},
): Promise<string> {
  const actor = await actorFor(ctxOf(orgId), userId)
  const created = await asUser(actor, (tx) =>
    createThread(
      tx as never,
      {
        orgId,
        userId,
        participantIds: opts.participantIds ?? [],
        title: opts.title ?? "Test Thread",
        // A separate conversation on purpose: two threads a test makes are two threads.
        forceCreate: true,
      } as never,
    ),
  )
  return (created as { id: string }).id
}

/** `userId`'s direct messages with their own personal agent, opened as "Message" opens it. */
export async function agentDm(orgId: string, userId: string): Promise<string> {
  const agent = await seedPersonalAgent(orgId, userId, "assistant")
  return agentDmWith(ctxOf(orgId), userId, agent.agentId)
}

/**
 * A message `userId` wrote in `threadId`: the person's own words in that conversation, with
 * the `metadata` a stored turn carries (its tool calls and their cards) when given.
 */
export async function postUserMessage(
  orgId: string,
  threadId: string,
  userId: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await withPrivilegedDb(orgId, "seed-minimal:message", (tx) =>
    tx.insert(messages).values({
      threadId,
      orgId,
      authorId: userId,
      authorType: "user",
      content,
      requiredScopes: [],
      ...(metadata ? { metadata } : {}),
    }),
  )
}

/** A contact with `email`, resolved by the org's admin. */
export async function contact(
  orgId: string,
  email: string,
  opts: { name?: string } = {},
): Promise<string> {
  const admin = await adminActor(orgId)
  const [entry] = await resolveContacts(ctxOf(orgId), admin, [
    { key: "contact", email, name: opts.name ?? "Test Contact", externalId: {}, tags: [] },
  ])
  if (!entry) throw new Error(`minimal seed: contact ${email} was not resolved`)
  return entry[1].id
}

/** An address on `contactId` (default role `delivery`), added by the org's admin. Returns its id. */
export async function contactAddress(
  orgId: string,
  contactId: string,
  fields: AddressFields,
): Promise<string> {
  const admin = await adminActor(orgId)
  const { address } = await asUser(admin, (tx) =>
    addAddress(tx, { orgId, userId: admin.userId, contactId, fields }),
  )
  return address.id
}

type Admin = Awaited<ReturnType<typeof adminActor>>

const actorContext = (admin: Admin, orgId: string) => ({
  actorId: admin.userId,
  actorScopes: admin.scopes.map(createScope),
  actorDimensionGrants: admin.dimensionGrants ?? {},
  orgId,
})

/** A role editor service's refusal (`null` or `{ error }`) as a thrown error. */
function refused(what: string, userId: string, result: unknown): void {
  if (result === null || (typeof result === "object" && result !== null && "error" in result)) {
    throw new Error(`minimal seed: ${what} for ${userId} refused: ${JSON.stringify(result)}`)
  }
}

/** Grant `scope` to the person directly (the role editor's per-person grant), as the org's admin. */
export async function grantScope(userId: string, scope: string): Promise<void> {
  const orgId = await orgOfUser(userId)
  const admin: Admin = await adminActor(orgId)
  const result = await asUser(admin, (tx) =>
    grantUserScope(tx as never, { userId, scope, ...actorContext(admin, orgId) }),
  )
  refused(`grant ${scope}`, userId, result)
  invalidateAuthCache(userId)
}

/** Revoke a direct grant of `scope`, as the org's admin. */
export async function revokeScope(userId: string, scope: string): Promise<void> {
  const orgId = await orgOfUser(userId)
  const admin: Admin = await adminActor(orgId)
  await asUser(admin, (tx) =>
    revokeUserScope(tx as never, { userId, scope, ...actorContext(admin, orgId) }),
  )
  invalidateAuthCache(userId)
}

/** Give the person the org's role named `role`, as the org's admin. */
export async function assignRole(userId: string, role: string): Promise<void> {
  const orgId = await orgOfUser(userId)
  const roleId = await roleIdByName(orgId, role)
  const admin: Admin = await adminActor(orgId)
  const result = await asUser(admin, (tx) =>
    assignRoleService(tx as never, { userId, roleId, ...actorContext(admin, orgId) }),
  )
  refused(`assign ${role}`, userId, result)
  invalidateAuthCache(userId)
}

/** Take the role named `role` away from the person, as the org's admin; one they do not hold is a no-op. */
export async function revokeRole(userId: string, role: string): Promise<void> {
  const orgId = await orgOfUser(userId)
  const roleId = await roleIdByName(orgId, role)
  const [held] = await withPrivilegedDb(orgId, "seed-minimal:role-held", (tx) =>
    tx
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)))
      .limit(1),
  )
  if (!held) return
  const admin: Admin = await adminActor(orgId)
  const result = await asUser(admin, (tx) =>
    unassignRole(tx as never, { userId, roleId, ...actorContext(admin, orgId) }),
  )
  refused(`revoke ${role}`, userId, result)
  invalidateAuthCache(userId)
}

/**
 * Give the person the role named `role` through a privileged write, for the one
 * case the role editor cannot serve: no admin is left to act, because a test
 * took the admin role from every admin and now restores it. Anything else goes
 * through `assignRole`.
 */
export async function privilegedAssignRole(userId: string, role: string): Promise<void> {
  const orgId = await orgOfUser(userId)
  const roleId = await roleIdByName(orgId, role)
  await withPrivilegedDb(orgId, "seed-minimal:privileged-assign-role", async (tx) => {
    await tx.insert(userRoles).values({ userId, roleId, orgId }).onConflictDoNothing()
    await tx
      .update(users)
      .set({ permissionVersion: sql`permission_version + 1` })
      .where(eq(users.id, userId))
  })
  invalidateAuthCache(userId)
}

/**
 * A second org with its own admin, through the provisioning CLI's org and
 * admin provisioners (the instance's first org came from a registration, which
 * runs once). Its slug is the next free `minimal-org-<n>`.
 */
export async function secondOrg(
  opts: { name?: string } = {},
): Promise<{ orgId: string; adminUserId: string }> {
  const [{ n } = { n: 0 }] = await withSystemDb("seed-minimal:org-count", (tx) =>
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(organizations)
      .where(like(organizations.slug, "minimal-org-%")),
  )
  const slug = `minimal-org-${n + 1}-${next()}`
  const config = {
    org: { slug, name: opts.name ?? "Second Org", credits: { currency: "EUR", initial: "20" } },
    admin: { email: `admin-${slug}@minimal.test`, name: "Org B Admin", password: MINIMAL_PASSWORD },
  }
  const { orgId } = await provisionOrgShell(config as never, "minimal.secondOrg", () => {})
  await provisionAdminAndRoles(config as never, "minimal.secondOrg", () => {})
  const admin = await orgAdmin(orgId)
  return { orgId, adminUserId: admin.id }
}
