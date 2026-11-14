// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Bare org and people rows, for a test that needs an org (or a user, a role, an
// audit entry, an invitation) with a known id and nothing else: no admin, no
// apps, no seeded world. A test that needs a usable org takes the minimal tier
// (`seed/tiers/minimal.ts`) or `createTestOrg` instead.
//
// Privileged: written over the system connection, as the provisioning paths
// write them. Every column is the schema's, so defaults (timezone, settings,
// status) are the product's.
import { withSystemDb } from "~/db/privileged"
import {
  auditLog,
  invitations,
  organizations,
  passwordResets,
  roles,
  userPreferences,
  userScopeGrants,
  users,
} from "~/db/schema/kernel"

export type OrgRowSeed = typeof organizations.$inferInsert

/**
 * An organization row. `onConflict` (default "error"): "skip" leaves an org
 * already holding the id as it is, "reset-settings" sets its settings back to
 * the given ones (default `{}`).
 */
export async function seedOrgRow(
  row: OrgRowSeed,
  opts: { onConflict?: "error" | "skip" | "reset-settings" } = {},
): Promise<string> {
  const [created] = await withSystemDb("seed-org-row", async (db) => {
    const insert = db.insert(organizations).values(row)
    const mode = opts.onConflict ?? "error"
    const done =
      mode === "skip"
        ? insert.onConflictDoNothing({ target: organizations.id })
        : mode === "reset-settings"
          ? insert.onConflictDoUpdate({
              target: organizations.id,
              set: { settings: row.settings ?? {} },
            })
          : insert
    return done.returning({ id: organizations.id })
  })
  return created?.id ?? (row.id as string)
}

export type UserRowSeed = typeof users.$inferInsert

/** User rows; their ids in order. `onConflict: "skip"` leaves existing rows alone. */
export async function seedUserRows(
  rows: UserRowSeed[],
  opts: { onConflict?: "error" | "skip" } = {},
): Promise<string[]> {
  if (rows.length === 0) return []
  const out = await withSystemDb("seed-user-rows", async (db) => {
    const insert = db.insert(users).values(rows)
    return (opts.onConflict === "skip" ? insert.onConflictDoNothing() : insert).returning({
      id: users.id,
    })
  })
  return out.map((r) => r.id)
}

/** One user row; its id. */
export async function seedUserRow(row: UserRowSeed): Promise<string> {
  const [id] = await seedUserRows([row])
  return id as string
}

/** A scope granted to one person directly; a grant already held is left as it is. */
export async function seedUserScopeGrantRow(row: {
  userId: string
  orgId: string
  scope: string
}): Promise<void> {
  await withSystemDb("seed-user-scope-grant", (db) =>
    db.insert(userScopeGrants).values(row).onConflictDoNothing(),
  )
}

/** A role of the org by name, created when the org has none of that name. */
export async function seedRoleRow(orgId: string, name: string): Promise<void> {
  await withSystemDb("seed-role-row", (db) =>
    db
      .insert(roles)
      .values({ orgId, name })
      .onConflictDoNothing({ target: [roles.orgId, roles.name] }),
  )
}

export type UserPreferencesSeed = Omit<typeof userPreferences.$inferInsert, "userId">

/** Set some of a user's preferences (insert, or overwrite those columns). */
export async function setUserPreferences(
  userId: string,
  prefs: UserPreferencesSeed,
): Promise<void> {
  await withSystemDb("seed-user-preferences", (db) =>
    db
      .insert(userPreferences)
      .values({ userId, ...prefs })
      .onConflictDoUpdate({ target: userPreferences.userId, set: prefs }),
  )
}

/** One audit log entry; its id. */
export async function seedAuditEntry(row: typeof auditLog.$inferInsert): Promise<string> {
  const [created] = await withSystemDb("seed-audit-entry", (db) =>
    db.insert(auditLog).values(row).returning({ id: auditLog.id }),
  )
  return created?.id as string
}

/** A pending invitation whose token hashes to `tokenHash`. */
export async function seedInvitationRow(row: typeof invitations.$inferInsert): Promise<void> {
  await withSystemDb("seed-invitation-row", (db) => db.insert(invitations).values(row))
}

/** A password reset whose token hashes to `tokenHash`. */
export async function seedPasswordResetRow(row: typeof passwordResets.$inferInsert): Promise<void> {
  await withSystemDb("seed-password-reset-row", (db) => db.insert(passwordResets).values(row))
}
