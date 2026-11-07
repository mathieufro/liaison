// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The workspace lookup of the managed edition (`POST /api/cloud/lookup`, spec
// S43): the orgs on this cell where an email is an active member, so the
// control plane can tell a person where to sign in. Read-only. An org being
// deleted is left out.

import type { CloudLookupReply } from "@liaison/control-plane-contract"
import { and, asc, eq, isNull } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { organizations, users } from "~/db/schema/kernel"

/** The reply's cap (the contract's). */
const MAX_ORGS = 500

export async function lookupOrgsByEmail(email: string): Promise<CloudLookupReply> {
  const rows = await withSystemDb("cloud-lookup", (db) =>
    db
      .selectDistinct({ slug: organizations.slug, name: organizations.name })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.orgId))
      .where(
        and(
          eq(users.email, email.trim().toLowerCase()),
          eq(users.status, "active"),
          // A client's portal account is no workspace to sign in to.
          eq(users.userType, "member"),
          isNull(organizations.deletingAt),
        ),
      )
      .orderBy(asc(organizations.slug))
      .limit(MAX_ORGS),
  )
  return { ok: true, orgs: rows }
}
