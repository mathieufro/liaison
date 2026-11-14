// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The contact page asks the opt-out list as the reader (`mail:suppression_check`). A member of a
// freshly set-up organisation who holds mail's base member tier, and no scope added by this
// test, gets the answer with when and how.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { and, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { roles, userRoles } from "~/db/schema/kernel"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { bootstrapAdminThread, buildUserContext } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Seeded = Awaited<ReturnType<typeof bootstrapAdminThread>>
let seeded: Seeded
let mailMember: UserContext

beforeAll(async () => {
  await acquireTestLock()
  await initSandboxPool()
  seeded = await bootstrapAdminThread()
  await ensureAppsForOrg(seeded.orgId)
  // The member also gets mail's base member tier, the role mail's registration created.
  await withSystemDb("test-mail-member-tier", async (db) => {
    const [tier] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.orgId, seeded.orgId), eq(roles.name, "mail.member")))
      .limit(1)
    if (!tier) throw new Error("mail's registration created no mail.member role")
    await db
      .insert(userRoles)
      .values({ userId: seeded.memberActor.userId, roleId: tier.id, orgId: seeded.orgId })
  })
  mailMember = await buildUserContext(seeded.memberActor.userId, seeded.orgId)
}, 120_000)

afterAll(async () => {
  await shutdownSandboxPool()
  await releaseTestLock()
})

const run = (toolName: string, params: Record<string, unknown>, actor: UserContext) =>
  executeToolCore({
    toolName,
    orgId: seeded.orgId,
    actor,
    params,
    threadId: seeded.threadId,
    origin: "in-app-agent",
  })

describe("opt-out check for a member", () => {
  it("a member holding mail's base member tier sees Opted out, with when and how", async () => {
    const email = `member-view-${Date.now()}@client.test`
    const added = await run("mail:suppression_add", { email }, seeded.actor)
    expect("data" in added, JSON.stringify(added)).toBe(true)
    const answer = await run("mail:suppression_check", { emails: [email] }, mailMember)
    expect("data" in answer, JSON.stringify({ answer, scopes: mailMember.scopes })).toBe(true)
    const results = (answer as { data: { results: Array<Record<string, unknown>> } }).data.results
    expect(results[0]).toMatchObject({ email, optedOut: true, by: "person" })
    expect(typeof results[0]?.since).toBe("string")
  }, 90_000)
})
