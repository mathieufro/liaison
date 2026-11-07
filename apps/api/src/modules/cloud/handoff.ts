// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `POST /api/cloud/orgs/:id/handoff`: a one-time sign-in link for the org's
// owner, on the org's own host (`<base>/login/magic?challengeId&token`, the
// same page an emailed link opens). The challenge is bound to the owner, the
// org and that host, has no code, lives 10 minutes, and signs in only after the
// person clicks "Continue" (modules/auth/magic-link.ts). Idempotent on the
// message id: Control's retry gets the same link back; a new message id mints a
// fresh link that supersedes the last. The stored reply is sealed and purged
// after 600 s, with the challenge.

import {
  CLOUD_ERROR_CODES,
  type CloudErrorReply,
  type CloudHandoffReply,
} from "@liaison/control-plane-contract"
import { and, asc, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { organizations, roles, userRoles, users } from "~/db/schema/kernel"
import { orgPublicBaseUrl } from "~/lib/org-public-url"
import { mintChallenge } from "~/modules/auth/magic-link"
import { claimOutcome, completeOutcome, releaseClaim } from "./outcomes"

const ENDPOINT = "POST /orgs/:id/handoff"
/** The stored reply goes with its challenge. */
const HANDOFF_OUTCOME_TTL_SECONDS = 600

export type HandoffResult =
  | { status: 200; reply: CloudHandoffReply }
  | { status: 400 | 404 | 503; reply: CloudErrorReply }

/** The owner: the org's earliest-created active admin. */
async function findOwner(orgId: string) {
  const [row] = await withSystemDb("cloud-handoff-owner", (db) =>
    db
      .select({ id: users.id, orgId: users.orgId, email: users.email })
      .from(users)
      .innerJoin(userRoles, and(eq(userRoles.userId, users.id), eq(userRoles.orgId, users.orgId)))
      .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.orgId, users.orgId)))
      .where(
        and(
          eq(users.orgId, orgId),
          eq(users.status, "active"),
          eq(users.userType, "member"),
          eq(roles.name, "admin"),
        ),
      )
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(1),
  )
  return row ?? null
}

export async function cloudHandoff(orgId: string, messageId: string): Promise<HandoffResult> {
  const claim = await claimOutcome(ENDPOINT, messageId, orgId)
  if (claim.kind === "done") return { status: 200, reply: claim.reply as CloudHandoffReply }
  if (claim.kind === "mismatch") {
    return { status: 400, reply: { ok: false, code: CLOUD_ERROR_CODES.invalidRequest } }
  }
  if (claim.kind === "busy") {
    return { status: 503, reply: { ok: false, code: CLOUD_ERROR_CODES.busy } }
  }

  try {
    const [org] = await withSystemDb("cloud-handoff-org", (db) =>
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1),
    )
    const owner = org ? await findOwner(org.id) : null
    if (!owner) {
      await releaseClaim(ENDPOINT, messageId)
      return { status: 404, reply: { ok: false, code: CLOUD_ERROR_CODES.notFound } }
    }

    const base = await orgPublicBaseUrl(orgId)
    const minted = await mintChallenge(owner, owner.email, {
      host: new URL(base).host,
      handoff: true,
    })
    const reply: CloudHandoffReply = {
      ok: true,
      url: `${base}/login/magic?challengeId=${encodeURIComponent(minted.challengeId)}&token=${encodeURIComponent(minted.linkToken)}`,
      expiresAt: minted.expiresAt.toISOString(),
    }
    await completeOutcome(ENDPOINT, messageId, 200, reply, HANDOFF_OUTCOME_TTL_SECONDS)
    return { status: 200, reply }
  } catch (err) {
    await releaseClaim(ENDPOINT, messageId)
    throw err
  }
}
