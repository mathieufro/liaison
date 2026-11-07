// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The database boundary around an external user (a client who signs in to the
// portal): on the member side a restrictive policy hides the row, on the portal
// side the role reaches kernel tables not at all. Everything runs through the
// real roles on the real request login; a privileged test sees past both.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows, type RlsClient, sql } from "~/db"
import { type PortalClient, withPortalContext } from "~/db/portal-rls"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { countSeats } from "~/modules/org/caps"
import {
  eligibleApprovers,
  eligibleApproversWithDimension,
  everyMemberScopeFragment,
} from "~/modules/permissions/eligible-approvers"
import { KERNEL_EVERY_MEMBER_SCOPES } from "~/modules/permissions/every-member-scopes"
import { everyMemberScopeGrants, mcpServerAccessGrants } from "~/modules/permissions/permissions"
import { KERNEL_SCOPES } from "~/modules/permissions/scope-catalog"
import { createExternalUser } from "~/modules/users/external-user"
import { listUsers } from "~/modules/users/service"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG_ID = crypto.randomUUID()
const COMPANY_ID = crypto.randomUUID()
const EXTERNAL_ID = crypto.randomUUID()
const OTHER_EXTERNAL_ID = crypto.randomUUID()
const MEMBER_ID = crypto.randomUUID()
const ROLE_ID = crypto.randomUUID()

const member: UserContext = {
  actorType: "user",
  userId: MEMBER_ID,
  orgId: ORG_ID,
  scopes: [],
  dimensionGrants: {},
}
const portalAdmin: UserContext = { ...member, scopes: ["kernel:portal:admin"] }

function pgCode(err: unknown): string {
  const e = err as { code?: string; cause?: { code?: string } } | null
  return e?.cause?.code ?? e?.code ?? "unknown"
}

function pgMessage(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string } } | null
  return e?.cause?.message ?? e?.message ?? ""
}

/** The rows, or the error the statement raised, so the transaction goes on (a savepoint). */
async function outcome(savepoint: () => Promise<Record<string, unknown>[]>) {
  try {
    return { rows: await savepoint() }
  } catch (err) {
    return { code: pgCode(err), message: pgMessage(err) }
  }
}

const inRls = (tx: RlsClient, statement: string) =>
  outcome(() =>
    tx.transaction(async (sp) =>
      extractRows<Record<string, unknown>>(await sp.execute(drizzleSql.raw(statement))),
    ),
  )

const inPortal = (tx: PortalClient, statement: string) =>
  outcome(() =>
    tx.transaction(async (sp) =>
      extractRows<Record<string, unknown>>(await sp.execute(drizzleSql.raw(statement))),
    ),
  )

beforeAll(async () => {
  await sql.unsafe(
    insertSql("kernel.organizations", {
      id: ORG_ID,
      name: "External boundary",
      slug: `ext-boundary-${ORG_ID.slice(0, 8)}`,
    }),
  )
  await sql.unsafe(
    insertSql("kernel.users", {
      id: MEMBER_ID,
      org_id: ORG_ID,
      email: `member-${MEMBER_ID.slice(0, 8)}@example.com`,
      name: "Member",
    }),
  )
  for (const id of [EXTERNAL_ID, OTHER_EXTERNAL_ID]) {
    await sql.unsafe(
      insertSql("kernel.users", {
        id,
        org_id: ORG_ID,
        email: `client-${id.slice(0, 8)}@example.com`,
        name: "Client",
        user_type: "external",
        company_id: COMPANY_ID,
      }),
    )
  }
  await sql.unsafe(
    insertSql("kernel.roles", {
      id: ROLE_ID,
      org_id: ORG_ID,
      name: `plain-${ROLE_ID.slice(0, 8)}`,
    }),
  )
})

afterAll(async () => {
  await sql`DELETE FROM app_mcp_manager.mcp_connections WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("the portal role", () => {
  it("kernel.users, kernel.contacts and app_projects.tasks raise permission denied under the portal role", async () => {
    const results = await withPortalContext({ orgId: ORG_ID, userId: EXTERNAL_ID }, async (tx) => ({
      users: await inPortal(tx, "SELECT * FROM kernel.users LIMIT 1"),
      contacts: await inPortal(tx, "SELECT * FROM kernel.contacts LIMIT 1"),
      tasks: await inPortal(tx, "SELECT * FROM app_projects.tasks LIMIT 1"),
    }))
    // Rows returned here is a boundary failure, not a test to adjust.
    for (const result of Object.values(results)) {
      expect(result.code).toBe("42501")
      expect(result.rows).toBeUndefined()
    }
  })

  it("portal.me returns only the caller", async () => {
    const rows = await withPortalContext({ orgId: ORG_ID, userId: EXTERNAL_ID }, async (tx) =>
      extractRows<{ id: string }>(await tx.execute(drizzleSql`SELECT * FROM portal.me`)),
    )
    expect(rows.map((r) => r.id)).toEqual([EXTERNAL_ID])
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      ["company_id", "email", "id", "locale", "name", "timezone"].sort(),
    )
  })

  it("a member id in the context returns none", async () => {
    // withPortalContext refuses a member, so the role is entered by hand: the
    // view itself has to hold if a context ever carries a member's id.
    const rows = await withRlsContext(member, async (tx) => {
      await tx.execute(drizzleSql`SELECT set_config('role', 'liaison_portal', true)`)
      return extractRows<{ id: string }>(await tx.execute(drizzleSql`SELECT id FROM portal.me`))
    })
    expect(rows).toEqual([])
  })
})

describe("the member side of the boundary", () => {
  it("under liaison_rls a member reads no external row, a holder of the portal admin scope does", async () => {
    const read = (ctx: UserContext) =>
      withRlsContext(ctx, async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`SELECT id FROM kernel.users WHERE org_id = ${ORG_ID}`),
        ).map((r) => r.id),
      )
    expect(await read(member)).toEqual([MEMBER_ID])
    expect((await read(portalAdmin)).sort()).toEqual(
      [MEMBER_ID, EXTERNAL_ID, OTHER_EXTERNAL_ID].sort(),
    )
  })

  it("users_members_only keeps an index scan on users by id", async () => {
    // An org of real size, analyzed: on a handful of rows the org's own index
    // can be the cheaper plan for reasons that have nothing to do with the
    // policy, depending on what earlier tests left in the table.
    const bigOrg = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.organizations", {
        id: bigOrg,
        name: "Sized org",
        slug: `ext-sized-${bigOrg.slice(0, 8)}`,
      }),
    )
    await sql.unsafe(
      insertSql(
        "kernel.users",
        Array.from({ length: 2000 }, (_, i) => ({
          org_id: bigOrg,
          email: `sized-${i + 1}-${bigOrg}@example.com`,
          name: "Sized",
        })),
      ),
    )
    await sql`ANALYZE kernel.users`
    const [target] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.users WHERE org_id = ${bigOrg} LIMIT 1`
    try {
      const plan = await withRlsContext({ ...member, orgId: bigOrg }, async (tx) => {
        const rows = extractRows<{ "QUERY PLAN": string }>(
          await tx.execute(
            drizzleSql.raw(`EXPLAIN SELECT * FROM kernel.users WHERE id = '${target?.id}'`),
          ),
        )
        return rows.map((r) => r["QUERY PLAN"]).join("\n")
      })
      // The planner may answer a one-row lookup by id through the primary key (plain or bitmap) or,
      // when earlier tests left many orgs in the table, through the org's own index with the id as a
      // filter. What the policy must never cause is a sequential scan.
      expect(plan).toMatch(/Index Scan using \w+ on users|Bitmap Index Scan on \w+/)
      expect(plan).toContain(`id = '${target?.id}'`)
      expect(plan).not.toContain("Seq Scan")
    } finally {
      await sql`DELETE FROM kernel.users WHERE org_id = ${bigOrg}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${bigOrg}`
    }
  })

  it("as liaison_rls without the portal scope, inserting a role for an external user raises", async () => {
    const result = await withRlsContext(member, (tx) =>
      inRls(
        tx,
        insertSql(
          "kernel.user_roles",
          { user_id: EXTERNAL_ID, role_id: ROLE_ID, org_id: ORG_ID },
          { returning: "user_id" },
        ),
      ),
    )
    // The trigger's own words: the row is invisible to this role, so a trigger
    // that read it as the caller would let the insert through.
    expect(result.message).toContain("an external user holds no role")
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.user_roles WHERE user_id = ${EXTERNAL_ID}`
    expect(count?.n).toBe(0)
  })

  it("inserting a role for an external user raises on a privileged connection too", async () => {
    await expect(
      sql.unsafe(
        insertSql("kernel.user_roles", { user_id: EXTERNAL_ID, role_id: ROLE_ID, org_id: ORG_ID }),
      ),
    ).rejects.toThrow("an external user holds no role")
  })

  it("a role for a member still inserts", async () => {
    await withRlsContext(member, async (tx) => {
      await tx.execute(
        drizzleSql.raw(
          insertSql("kernel.user_roles", { user_id: MEMBER_ID, role_id: ROLE_ID, org_id: ORG_ID }),
        ),
      )
    })
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.user_roles WHERE user_id = ${MEMBER_ID}`
    expect(count?.n).toBe(1)
  })

  it("as liaison_rls, changing user_type raises", async () => {
    const result = await withRlsContext(member, (tx) =>
      inRls(
        tx,
        `UPDATE kernel.users SET user_type = 'external', company_id = '${COMPANY_ID}'
          WHERE id = '${MEMBER_ID}' RETURNING id`,
      ),
    )
    expect(result.message).toContain("user_type cannot change")
    const [row] = await sql<{ user_type: string }[]>`
      SELECT user_type FROM kernel.users WHERE id = ${MEMBER_ID}`
    expect(row?.user_type).toBe("member")
  })

  it("changing user_type raises on a privileged connection, and another column still updates", async () => {
    await expect(
      sql`UPDATE kernel.users SET user_type = 'member', company_id = NULL WHERE id = ${EXTERNAL_ID}`,
    ).rejects.toThrow("user_type cannot change")
    await sql`UPDATE kernel.users SET name = 'Client renamed' WHERE id = ${EXTERNAL_ID}`
    const [row] = await sql<
      { name: string }[]
    >`SELECT name FROM kernel.users WHERE id = ${EXTERNAL_ID}`
    expect(row?.name).toBe("Client renamed")
  })

  it("external with null company_id violates the check", async () => {
    const id = crypto.randomUUID()
    await expect(
      sql.unsafe(
        insertSql("kernel.users", {
          id,
          org_id: ORG_ID,
          email: `nocompany-${id.slice(0, 8)}@example.com`,
          name: "X",
          user_type: "external",
        }),
      ),
    ).rejects.toThrow("users_external_company_check")
  })

  it("a member with a company_id violates the check", async () => {
    const id = crypto.randomUUID()
    await expect(
      sql.unsafe(
        insertSql("kernel.users", {
          id,
          org_id: ORG_ID,
          email: `membercompany-${id.slice(0, 8)}@example.com`,
          name: "X",
          company_id: COMPANY_ID,
        }),
      ),
    ).rejects.toThrow("users_external_company_check")
  })
})

describe("the scope that sees external rows", () => {
  it("is declared in the kernel's catalog", () => {
    expect(KERNEL_SCOPES.map((s) => s.scope)).toContain("kernel:portal:admin")
  })
})

describe("the routes and services a member reads people through", () => {
  const tokenFor = (scopes: string[]) =>
    signAccessToken(
      {
        userId: MEMBER_ID,
        orgId: ORG_ID,
        name: "Member",
        authVersion: 1,
        permissionVersion: 1,
        scopes,
      },
      env.JWT_SECRET,
    )
  const get = async (path: string, scopes: string[]) =>
    app.request(path, { headers: { Authorization: `Bearer ${await tokenFor(scopes)}` } })
  const ids = async (res: Response) =>
    ((await res.json()) as { data: { userId: string }[] }).data.map((m) => m.userId)

  it("listUsers shows a member no external row, a holder of the portal admin scope all of them", async () => {
    const list = (ctx: UserContext) =>
      withRlsContext(ctx, (tx) => listUsers(tx, { orgId: ORG_ID, page: 1, limit: 50 }))
    expect((await list(member)).rows.map((r) => r.id)).toEqual([MEMBER_ID])
    expect((await list(portalAdmin)).rows.map((r) => r.id).sort()).toEqual(
      [MEMBER_ID, EXTERNAL_ID, OTHER_EXTERNAL_ID].sort(),
    )
  })

  it("/api/sharing/members shows a member no external row, a holder of the portal admin scope all of them", async () => {
    const asMember = await get("/api/sharing/members", [])
    expect(asMember.status).toBe(200)
    expect(await ids(asMember)).toEqual([MEMBER_ID])
    const asHolder = await get("/api/sharing/members", ["kernel:portal:admin"])
    expect((await ids(asHolder)).sort()).toEqual([MEMBER_ID, EXTERNAL_ID, OTHER_EXTERNAL_ID].sort())
  })

  it("/api/users/:id/preview of an external row is 404 for a member, found for a holder of the portal admin scope", async () => {
    expect((await get(`/api/users/${EXTERNAL_ID}/preview`, [])).status).toBe(404)
    expect((await get(`/api/users/${MEMBER_ID}/preview`, [])).status).toBe(200)
    expect((await get(`/api/users/${EXTERNAL_ID}/preview`, ["kernel:portal:admin"])).status).toBe(
      200,
    )
  })
})

describe("creating an external row", () => {
  const create = (email: string, orgId = ORG_ID) =>
    withPrivilegedDb(orgId, "external-user-test", (tx) =>
      createExternalUser(tx, { orgId, companyId: COMPANY_ID, email, name: "Client" }),
    )
  const rowsWithEmail = async (email: string) =>
    sql<{ id: string }[]>`SELECT id FROM kernel.users
      WHERE org_id = ${ORG_ID} AND lower(email) = lower(${email})`

  it("creates an external row in the company, with no password and no role", async () => {
    const email = `new-${crypto.randomUUID().slice(0, 8)}@client.example`
    const result = await create(email)
    expect(result.ok).toBe(true)
    const [row] = await sql<
      { user_type: string; company_id: string; password_hash: string | null; roles: number }[]
    >`SELECT user_type, company_id, password_hash,
        (SELECT count(*)::int FROM kernel.user_roles r WHERE r.user_id = u.id) AS roles
      FROM kernel.users u WHERE org_id = ${ORG_ID} AND email = ${email}`
    expect(row).toEqual({
      user_type: "external",
      company_id: COMPANY_ID,
      password_hash: null,
      roles: 0,
    })
  })

  it("a member's address is refused with email_is_member, no row written", async () => {
    const email = `member-${MEMBER_ID.slice(0, 8)}@example.com`
    expect(await create(email)).toEqual({ ok: false, code: "email_is_member" })
    expect((await rowsWithEmail(email)).map((r) => r.id)).toEqual([MEMBER_ID])
  })

  it("the same address in other capitals and with spaces is refused too", async () => {
    const email = `  MEMBER-${MEMBER_ID.slice(0, 8).toUpperCase()}@Example.COM `
    expect(await create(email)).toEqual({ ok: false, code: "email_is_member" })
    expect((await rowsWithEmail(email.trim())).length).toBe(1)
  })

  it("a member row stored with capitals is still the same address", async () => {
    const id = crypto.randomUUID()
    const stored = `Mixed-${id.slice(0, 8)}@Example.com`
    await sql.unsafe(
      insertSql("kernel.users", { id, org_id: ORG_ID, email: stored, name: "Mixed" }),
    )
    expect(await create(stored.toLowerCase())).toEqual({ ok: false, code: "email_is_member" })
    expect((await rowsWithEmail(stored)).map((r) => r.id)).toEqual([id])
  })

  it("a deactivated member's address is refused too", async () => {
    const id = crypto.randomUUID()
    const email = `gone-${id.slice(0, 8)}@example.com`
    await sql.unsafe(
      insertSql("kernel.users", {
        id,
        org_id: ORG_ID,
        email,
        name: "Gone",
        status: "deactivated",
      }),
    )
    expect(await create(email)).toEqual({ ok: false, code: "email_is_member" })
  })

  it("an address already held by an external row is refused and adds nothing", async () => {
    const email = `twice-${crypto.randomUUID().slice(0, 8)}@client.example`
    expect((await create(email)).ok).toBe(true)
    expect(await create(email)).toEqual({ ok: false, code: "email_is_external" })
    expect((await rowsWithEmail(email)).length).toBe(1)
  })

  it("an address taken while the create was under way is refused, with no error and one row", async () => {
    const email = `race-${crypto.randomUUID().slice(0, 8)}@client.example`
    let second: ReturnType<typeof create> | undefined
    // The first create stays uncommitted while the second reads no holder and
    // then waits on the unique index, so the second learns of it at the insert.
    // The second create starts outside the first's transaction, as another caller would.
    let created!: () => void
    const firstCreated = new Promise<void>((resolve) => {
      created = resolve
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const firstTx = withPrivilegedDb(ORG_ID, "external-user-race", async (tx) => {
      const first = await createExternalUser(tx, {
        orgId: ORG_ID,
        companyId: COMPANY_ID,
        email,
        name: "Client",
      })
      expect(first.ok).toBe(true)
      created()
      await held
    })
    await firstCreated
    second = create(email)
    await Bun.sleep(300)
    release()
    await firstTx
    expect(await second).toEqual({ ok: false, code: "email_is_external" })
    expect((await rowsWithEmail(email)).length).toBe(1)
  })

  it("a member of another org with that address is no refusal here", async () => {
    const otherOrg = crypto.randomUUID()
    const email = `both-${otherOrg.slice(0, 8)}@example.com`
    await sql.unsafe(
      insertSql("kernel.organizations", {
        id: otherOrg,
        name: "Other",
        slug: `ext-other-${otherOrg.slice(0, 8)}`,
      }),
    )
    await sql.unsafe(
      insertSql("kernel.users", {
        id: crypto.randomUUID(),
        org_id: otherOrg,
        email,
        name: "Other member",
      }),
    )
    try {
      expect((await create(email)).ok).toBe(true)
    } finally {
      await sql`DELETE FROM kernel.users WHERE org_id = ${otherOrg}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${otherOrg}`
    }
  })
})

describe("seats, every-member grants and approvers ignore an external row", () => {
  const privileged = <T>(fn: (tx: Parameters<Parameters<typeof withPrivilegedDb>[2]>[0]) => T) =>
    withPrivilegedDb(ORG_ID, "external-user-test", async (tx) => fn(tx))

  it("countSeats counts active members only", async () => {
    const before = await privileged((tx) => countSeats(tx, ORG_ID))
    const [members] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM kernel.users
      WHERE org_id = ${ORG_ID} AND status = 'active' AND user_type = 'member'`
    expect(before).toBe(members?.n ?? -1)
    const added = await privileged((tx) =>
      createExternalUser(tx, {
        orgId: ORG_ID,
        companyId: COMPANY_ID,
        email: `seat-${crypto.randomUUID().slice(0, 8)}@client.example`,
        name: "Client",
      }),
    )
    expect(added.ok).toBe(true)
    expect(await privileged((tx) => countSeats(tx, ORG_ID))).toBe(before)
  })

  it("everyMemberScopeGrants returns none for an external row and the kernel's own for a member", async () => {
    const grants = (userId: string) =>
      privileged((tx) => everyMemberScopeGrants(tx, userId, ORG_ID))
    expect(await grants(EXTERNAL_ID)).toEqual([])
    expect((await grants(MEMBER_ID)).map((g) => g.scope)).toEqual(
      expect.arrayContaining([...KERNEL_EVERY_MEMBER_SCOPES]),
    )
  })

  it("an org MCP server open to everyone is no grant for an external row", async () => {
    const slug = `everyone-${crypto.randomUUID().slice(0, 6)}`
    await privileged((tx) =>
      tx.insert(mcpConnections).values({
        orgId: ORG_ID,
        slug,
        displayName: slug,
        transport: "http",
        httpUrl: "https://mcp.example/mcp",
        ownershipScope: "org",
        accessMode: "everyone",
        createdBy: MEMBER_ID,
      }),
    )
    const grants = (userId: string) =>
      privileged((tx) => mcpServerAccessGrants(tx, { userId, orgId: ORG_ID, roleIds: [] }))
    expect(await grants(MEMBER_ID)).toEqual([{ scope: `mcp:${slug}` }])
    expect(await grants(EXTERNAL_ID)).toEqual([])
  })

  it("eligibleApprovers finds an external row by no route: a direct grant or a scope every member holds", async () => {
    await sql.unsafe(
      insertSql("kernel.user_scope_grants", [
        { user_id: EXTERNAL_ID, org_id: ORG_ID, scope: "tickets:approve" },
        { user_id: MEMBER_ID, org_id: ORG_ID, scope: "tickets:approve" },
      ]),
    )
    expect(await privileged((tx) => eligibleApprovers(tx, ORG_ID, "tickets:approve"))).toEqual([
      MEMBER_ID,
    ])
    const everyMember = KERNEL_EVERY_MEMBER_SCOPES[0] as string
    const approvers = await privileged((tx) => eligibleApprovers(tx, ORG_ID, everyMember))
    expect(approvers).toContain(MEMBER_ID)
    expect(approvers).not.toContain(EXTERNAL_ID)
  })

  it("eligibleApproversWithDimension does not find one either", async () => {
    await sql.unsafe(
      insertSql(
        "kernel.user_scope_grants",
        { user_id: OTHER_EXTERNAL_ID, org_id: ORG_ID, scope: "*" },
        { onConflictDoNothing: true },
      ),
    )
    const approvers = await privileged((tx) =>
      eligibleApproversWithDimension(tx, ORG_ID, "tickets:approve", {
        key: "team",
        values: ["a"],
      }),
    )
    expect(approvers).not.toContain(OTHER_EXTERNAL_ID)
  })

  it("the approval policy's reader does not count an every-member scope for an external row", async () => {
    const everyMember = KERNEL_EVERY_MEMBER_SCOPES[0] as string
    const approvalId = crypto.randomUUID()
    const threadId = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.threads", {
        id: threadId,
        org_id: ORG_ID,
        handle: `ext-${threadId.slice(0, 8)}`,
        created_by: MEMBER_ID,
        title: "Approval",
        type: "approval",
      }),
    )
    await sql.unsafe(
      insertSql("kernel.approval_requests", {
        id: approvalId,
        org_id: ORG_ID,
        handle: `external-${approvalId.slice(0, 8)}`,
        thread_id: threadId,
        originating_thread_id: threadId,
        tool_name: "tickets:reply",
        tool_params: "{}",
        current_payload: "{}",
        expires_at: { raw: "now() + interval '1 hour'" },
        requested_by: MEMBER_ID,
        status: "pending",
        notify_user_ids: `{${EXTERNAL_ID}}`,
        approve_scope: everyMember,
        reason: "gated",
      }),
    )
    try {
      // The context carries the client's id, as a session of theirs would: the
      // policy's reader then looks up a row the restrictive policy hides.
      const visible = await withRlsContext({ ...member, userId: EXTERNAL_ID }, async (tx) => ({
        covers: extractRows<{ covers: boolean }>(
          await tx.execute(
            drizzleSql`SELECT kernel.every_member_scope_covers(${ORG_ID}::uuid, ${EXTERNAL_ID}::uuid, ${everyMember}::text) AS covers`,
          ),
        )[0]?.covers,
        rows: extractRows<{ id: string }>(
          await tx.execute(
            drizzleSql`SELECT id FROM kernel.approval_requests WHERE id = ${approvalId}::uuid`,
          ),
        ),
      }))
      expect(visible).toEqual({ covers: false, rows: [] })
    } finally {
      await sql`DELETE FROM kernel.approval_requests WHERE id = ${approvalId}`
      await sql`DELETE FROM kernel.threads WHERE id = ${threadId}`
    }
  })

  it("the requester-decides reader does not count an every-member scope for an external row", async () => {
    const everyMember = KERNEL_EVERY_MEMBER_SCOPES[0] as string
    const covers = (userId: string) =>
      privileged(async (tx) => {
        const fragment = everyMemberScopeFragment(
          ORG_ID,
          drizzleSql`${userId}::uuid`,
          drizzleSql`${everyMember}`,
        )
        const rows = extractRows<{ covers: boolean }>(
          await tx.execute(drizzleSql`SELECT ${fragment} AS covers`),
        )
        return rows[0]?.covers
      })
    expect(await covers(MEMBER_ID)).toBe(true)
    expect(await covers(EXTERNAL_ID)).toBe(false)
  })
})
