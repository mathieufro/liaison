// SPDX-License-Identifier: FSL-1.1-ALv2
//
// withPortalContext on the login requests really use (liaison_request): it
// reaches the portal role, and it opens only for an active external user.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { PortalContextRefusedError, withPortalContext } from "~/db/portal-rls"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG_ID = crypto.randomUUID()
const OTHER_ORG_ID = crypto.randomUUID()
const COMPANY_ID = crypto.randomUUID()
const EXTERNAL_ID = crypto.randomUUID()
const SUSPENDED_ID = crypto.randomUUID()
const MEMBER_ID = crypto.randomUUID()

beforeAll(async () => {
  for (const id of [ORG_ID, OTHER_ORG_ID]) {
    await sql.unsafe(
      insertSql("kernel.organizations", {
        id,
        name: "Portal context",
        slug: `portal-ctx-${id.slice(0, 8)}`,
      }),
    )
  }
  await sql.unsafe(
    insertSql("kernel.users", [
      {
        id: EXTERNAL_ID,
        org_id: ORG_ID,
        email: `client-${EXTERNAL_ID.slice(0, 8)}@example.com`,
        name: "Client",
        user_type: "external",
        company_id: COMPANY_ID,
        status: "active",
      },
      {
        id: SUSPENDED_ID,
        org_id: ORG_ID,
        email: `gone-${SUSPENDED_ID.slice(0, 8)}@example.com`,
        name: "Gone",
        user_type: "external",
        company_id: COMPANY_ID,
        status: "deactivated",
      },
      {
        id: MEMBER_ID,
        org_id: ORG_ID,
        email: `member-${MEMBER_ID.slice(0, 8)}@example.com`,
        name: "Member",
        user_type: "member",
        company_id: null,
        status: "active",
      },
    ]),
  )
})

afterAll(async () => {
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_ID}, ${OTHER_ORG_ID})`
})

describe("withPortalContext", () => {
  test("on the request login, withPortalContext reaches liaison_portal and reads portal.me", async () => {
    const out = await withPortalContext({ orgId: ORG_ID, userId: EXTERNAL_ID }, async (tx) => {
      const [who] = extractRows<{ login: string; role: string }>(
        await tx.execute(
          drizzleSql`SELECT session_user::text AS login, current_user::text AS role`,
        ),
      )
      const me = extractRows<{ id: string; company_id: string }>(
        await tx.execute(drizzleSql`SELECT id, company_id FROM portal.me`),
      )
      const [scopes] = extractRows<{ scopes: string }>(
        await tx.execute(drizzleSql`SELECT rls_ctx.scopes() AS scopes`),
      )
      return { who, me, scopes }
    })
    expect(out.who).toEqual({ login: "liaison_request", role: "liaison_portal" })
    expect(out.me).toEqual([{ id: EXTERNAL_ID, company_id: COMPANY_ID }])
    expect(out.scopes?.scopes).toBe("__none__")
  })

  test("a statement inside the portal context can return to the login's roles, so portal code runs only static SQL", async () => {
    const role = await withPortalContext({ orgId: ORG_ID, userId: EXTERNAL_ID }, async (tx) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE liaison_rls`)
      const [who] = extractRows<{ role: string }>(
        await tx.execute(drizzleSql`SELECT current_user::text AS role`),
      )
      return who?.role
    })
    // No guard refuses the step back today: the role switch is not a sandbox for caller text.
    expect(role).toBe("liaison_rls")
  })

  test("refuses a member and runs nothing", async () => {
    let ran = false
    await expect(
      withPortalContext({ orgId: ORG_ID, userId: MEMBER_ID }, async () => {
        ran = true
      }),
    ).rejects.toBeInstanceOf(PortalContextRefusedError)
    expect(ran).toBe(false)
  })

  test("refuses an external user who is no longer active", async () => {
    await expect(
      withPortalContext({ orgId: ORG_ID, userId: SUSPENDED_ID }, async () => "ran"),
    ).rejects.toBeInstanceOf(PortalContextRefusedError)
  })

  test("refuses an id that is no user, and a value that is no id", async () => {
    await expect(
      withPortalContext({ orgId: ORG_ID, userId: crypto.randomUUID() }, async () => "ran"),
    ).rejects.toBeInstanceOf(PortalContextRefusedError)
    await expect(
      withPortalContext({ orgId: ORG_ID, userId: "not-a-uuid" }, async () => "ran"),
    ).rejects.toBeInstanceOf(PortalContextRefusedError)
  })

  test("portal.company_id returns the caller's company and nobody else's", async () => {
    const company = await withPortalContext(
      { orgId: ORG_ID, userId: EXTERNAL_ID },
      async (tx) =>
        extractRows<{ company_id: string | null }>(
          await tx.execute(drizzleSql`SELECT portal.company_id() AS company_id`),
        )[0]?.company_id,
    )
    expect(company).toBe(COMPANY_ID)
  })
})
