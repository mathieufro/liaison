// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Changing a company's sharing over PUT /api/contacts/companies/:id/sharing,
// under the real liaison_rls role: its creator restricts it, shares it with
// one person and takes that back, and the company then answers 404 to a member
// without a grant and 200 to the grantee. Someone who may not manage its
// sharing is refused and nothing changes.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG_ID = crypto.randomUUID()
const ANNA = crypto.randomUUID() // creates the company
const BEN = crypto.randomUUID() // gets a grant
const CARL = crypto.randomUUID() // a member with no grant
const ROLE = crypto.randomUUID()

const SCOPES = [
  "kernel:contacts:read",
  "kernel:contacts:write",
  "kernel:companies:read",
  "kernel:companies:write",
]

const tokens: Record<string, string> = {}

async function request(as: string, path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokens[as]}`,
      ...(init.headers ?? {}),
    },
  })
}

async function createCompanyAsAnna(name: string): Promise<string> {
  const res = await request(ANNA, "/api/contacts/companies", {
    method: "POST",
    body: JSON.stringify({ name }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { data: { id: string } }).data.id
}

function putSharing(as: string, companyId: string, body: unknown) {
  return request(as, `/api/contacts/companies/${companyId}/sharing`, {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  await sql.unsafe(
    insertSql("kernel.organizations", {
      id: ORG_ID,
      name: "Company sharing",
      slug: `csw-${ORG_ID.slice(0, 8)}`,
    }),
  )
  await sql.unsafe(
    insertSql(
      "kernel.users",
      [
        [ANNA, "Anna"],
        [BEN, "Ben"],
        [CARL, "Carl"],
      ].map(([id, name]) => ({
        id,
        org_id: ORG_ID,
        email: `${name!.toLowerCase()}-${id!.slice(0, 8)}@example.com`,
        name,
        status: "active",
      })),
    ),
  )
  await sql.unsafe(insertSql("kernel.roles", { id: ROLE, org_id: ORG_ID, name: "company-worker" }))
  await sql.unsafe(
    insertSql(
      "kernel.role_scope_grants",
      SCOPES.map((scope) => ({ role_id: ROLE, scope })),
    ),
  )
  await sql.unsafe(
    insertSql(
      "kernel.user_roles",
      [ANNA, BEN, CARL].map((userId) => ({ user_id: userId, role_id: ROLE, org_id: ORG_ID })),
    ),
  )
  for (const [userId, name] of [
    [ANNA, "Anna"],
    [BEN, "Ben"],
    [CARL, "Carl"],
  ] as const) {
    tokens[userId] = await signAccessToken(
      {
        userId,
        orgId: ORG_ID,
        name,
        authVersion: 1,
        permissionVersion: 1,
        scopes: SCOPES,
        roles: [ROLE],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
  }
})

afterAll(async () => {
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.resource_grants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.companies WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("changing a company's sharing", () => {
  it("its creator restricts it and shares it with one person: the grantee sees it, another member gets 404", async () => {
    const companyId = await createCompanyAsAnna("Studio Restreint")
    expect((await request(CARL, `/api/contacts/companies/${companyId}`)).status).toBe(200)

    const restricted = await putSharing(ANNA, companyId, { orgAccess: "none", users: [] })
    expect(restricted.status).toBe(200)
    expect(((await restricted.json()) as { data: { orgAccess: string } }).data.orgAccess).toBe(
      "none",
    )
    expect((await request(CARL, `/api/contacts/companies/${companyId}`)).status).toBe(404)
    expect((await request(BEN, `/api/contacts/companies/${companyId}`)).status).toBe(404)
    expect((await request(ANNA, `/api/contacts/companies/${companyId}`)).status).toBe(200)

    const shared = await putSharing(ANNA, companyId, {
      orgAccess: "none",
      users: [{ userId: BEN, role: "viewer" }],
    })
    expect(shared.status).toBe(200)
    const body = (await shared.json()) as {
      data: { orgAccess: string; users: Array<{ userId: string; role: string }> }
    }
    expect(body.data.users).toEqual([{ userId: BEN, role: "viewer" }])
    expect((await request(BEN, `/api/contacts/companies/${companyId}`)).status).toBe(200)
    expect((await request(CARL, `/api/contacts/companies/${companyId}`)).status).toBe(404)
    // A viewer grant reads, it does not edit (it sees the company, so 403).
    const edit = await request(BEN, `/api/contacts/companies/${companyId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Renamed by Ben" }),
    })
    expect(edit.status).toBe(403)

    const revoked = await putSharing(ANNA, companyId, { orgAccess: "none", users: [] })
    expect(revoked.status).toBe(200)
    expect((await request(BEN, `/api/contacts/companies/${companyId}`)).status).toBe(404)

    const [event] = await sql<
      { data: { orgAccess: string; previousOrgAccess: string; audience: unknown } }[]
    >`
      SELECT payload->'data' AS data FROM kernel.pending_events
       WHERE org_id = ${ORG_ID} AND payload->>'entity' = 'company'
         AND payload->>'action' = 'share' AND payload->>'entityId' = ${companyId}
       ORDER BY seq ASC LIMIT 1`
    expect(event?.data).toMatchObject({ orgAccess: "none", previousOrgAccess: "editor" })
    // Everyone who saw it before the restriction is told it changed.
    expect(event?.data.audience).toEqual({ orgWide: true, userIds: [ANNA] })
  })

  it("its creator opens a restricted company to the organisation as view only", async () => {
    const companyId = await createCompanyAsAnna("Studio Ouvert")
    expect((await putSharing(ANNA, companyId, { orgAccess: "none" })).status).toBe(200)
    expect((await request(CARL, `/api/contacts/companies/${companyId}`)).status).toBe(404)

    expect((await putSharing(ANNA, companyId, { orgAccess: "viewer" })).status).toBe(200)
    expect((await request(CARL, `/api/contacts/companies/${companyId}`)).status).toBe(200)
    const [row] = await sql<{ org_access: string }[]>`
      SELECT org_access FROM kernel.companies WHERE id = ${companyId}`
    expect(row?.org_access).toBe("viewer")
  })

  it("someone who may not manage its sharing is refused with 403 and nothing changes", async () => {
    const companyId = await createCompanyAsAnna("Studio Garde")

    const refused = await putSharing(BEN, companyId, {
      orgAccess: "none",
      users: [{ userId: BEN, role: "editor" }],
    })
    expect(refused.status).toBe(403)
    expect(await refused.text()).toContain("nothing was changed")

    const [row] = await sql<{ org_access: string }[]>`
      SELECT org_access FROM kernel.companies WHERE id = ${companyId}`
    expect(row?.org_access).toBe("editor")
    const grants = await sql`
      SELECT 1 FROM kernel.resource_grants
       WHERE resource_type = 'kernel.company' AND resource_id = ${companyId}`
    expect(grants).toHaveLength(0)
    expect((await request(CARL, `/api/contacts/companies/${companyId}`)).status).toBe(200)
  })

  it("a company the caller cannot see answers 404 to a sharing change, not 403", async () => {
    const companyId = await createCompanyAsAnna("Studio Cache")
    expect((await putSharing(ANNA, companyId, { orgAccess: "none" })).status).toBe(200)

    const hidden = await putSharing(CARL, companyId, { orgAccess: "editor" })
    expect(hidden.status).toBe(404)
    const [row] = await sql<{ org_access: string }[]>`
      SELECT org_access FROM kernel.companies WHERE id = ${companyId}`
    expect(row?.org_access).toBe("none")
  })
})
