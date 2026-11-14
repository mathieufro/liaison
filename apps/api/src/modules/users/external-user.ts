// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one writer of an external user: someone from a client's company, who signs
// in to the portal and never to the member product. An address that already has a
// row in the org keeps it: the same person cannot be both a member and a client,
// and a member's address must never turn into a portal account.
import { and, eq, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { users } from "~/db/schema/kernel"

export interface ExternalUserInput {
  orgId: string
  companyId: string
  email: string
  name: string
  invitedBy?: string
}

export type ExternalUserResult =
  | { ok: true; userId: string }
  | { ok: false; code: "email_is_member" | "email_is_external" }

export async function createExternalUser(
  tx: PrivilegedDb,
  input: ExternalUserInput,
): Promise<ExternalUserResult> {
  const email = input.email.trim().toLowerCase()
  const holder = () =>
    tx
      .select({ userType: users.userType })
      .from(users)
      .where(and(eq(users.orgId, input.orgId), sql`lower(${users.email}) = ${email}`))
      .limit(1)
  const refusal = (userType: string): ExternalUserResult => ({
    ok: false,
    code: userType === "external" ? "email_is_external" : "email_is_member",
  })

  const [existing] = await holder()
  if (existing) return refusal(existing.userType)

  const [row] = await tx
    .insert(users)
    .values({
      orgId: input.orgId,
      email,
      name: input.name,
      userType: "external",
      companyId: input.companyId,
      ...(input.invitedBy ? { invitedBy: input.invitedBy } : {}),
    })
    .onConflictDoNothing({ target: [users.orgId, users.email] })
    .returning({ id: users.id })
  if (row) return { ok: true, userId: row.id }

  // A row with this address committed between the read and the insert.
  const [winner] = await holder()
  return refusal(winner?.userType ?? "member")
}
