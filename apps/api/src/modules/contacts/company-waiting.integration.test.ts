// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A company page's Waiting section: the pending approvals the reader sees whose
// summary links name the company, one of its people or one of its deals, and
// never another company's.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { companyWaitingApprovalIds } from "~/modules/contacts/companies"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG_ID = crypto.randomUUID()
const ANNA = crypto.randomUUID()
const ROLE = crypto.randomUUID()
const COMPANY = crypto.randomUUID()
const OTHER_COMPANY = crypto.randomUUID()
const HIDDEN_COMPANY = crypto.randomUUID()
const PERSON = crypto.randomUUID()
const OTHER_PERSON = crypto.randomUUID()
const THREAD = crypto.randomUUID()
const PROJECT = crypto.randomUUID()
const STATUS = crypto.randomUUID()
const DEAL_TASK = crypto.randomUUID()
const AT = "2026-03-02T09:00:00.000Z"

const SCOPES = [
  "kernel:contacts:read",
  "kernel:companies:read",
  "projects:projects:read",
  "projects:tasks:read",
  "projects:deals:read",
]

let token = ""
let seq = 0

async function approval(opts: {
  links?: unknown
  status?: string
  requestedBy?: string
}): Promise<string> {
  const id = crypto.randomUUID()
  seq += 1
  const summary = JSON.stringify({
    title: `Waiting item ${seq}`,
    ...(opts.links === undefined ? {} : { links: opts.links }),
  })
  await sql.unsafe(
    insertSql("kernel.approval_requests", {
      id,
      org_id: ORG_ID,
      handle: `waiting-${id.slice(0, 8)}`,
      status: opts.status ?? "pending",
      tool_name: "kernel:companies_write",
      tool_params: { raw: "'{}'::jsonb" },
      summary: { raw: `'${summary.replaceAll("'", "''")}'::jsonb` },
      current_payload: { raw: "'{}'::jsonb" },
      thread_id: THREAD,
      originating_thread_id: THREAD,
      requested_by: opts.requestedBy ?? ANNA,
      notify_user_ids: { raw: `ARRAY['${ANNA}']::uuid[]` },
      expires_at: { raw: `'${new Date(Date.now() + 86_400_000).toISOString()}'::timestamptz` },
      created_at: { raw: `'${new Date(Date.now() + seq * 1000).toISOString()}'::timestamptz` },
    }),
  )
  return id
}

const link = (entityType: string, entityId: string, app = "kernel") => ({
  label: entityType,
  app,
  entityType,
  entityId,
})

beforeAll(async () => {
  await sql.unsafe(
    insertSql("kernel.organizations", {
      id: ORG_ID,
      name: "Company waiting",
      slug: `cw-${ORG_ID.slice(0, 8)}`,
    }),
  )
  await sql.unsafe(
    insertSql("kernel.users", {
      id: ANNA,
      org_id: ORG_ID,
      email: `anna-${ANNA.slice(0, 8)}@example.com`,
      name: "Anna",
      status: "active",
    }),
  )
  await sql.unsafe(insertSql("kernel.roles", { id: ROLE, org_id: ORG_ID, name: "company-reader" }))
  await sql.unsafe(
    insertSql(
      "kernel.role_scope_grants",
      SCOPES.map((scope) => ({ role_id: ROLE, scope })),
    ),
  )
  await sql.unsafe(insertSql("kernel.user_roles", { user_id: ANNA, role_id: ROLE, org_id: ORG_ID }))
  await sql.unsafe(
    insertSql("kernel.companies", [
      {
        id: COMPANY,
        org_id: ORG_ID,
        handle: "maison",
        name: "Maison Arlon",
        created_by: ANNA,
        org_access: "editor",
      },
      {
        id: OTHER_COMPANY,
        org_id: ORG_ID,
        handle: "other",
        name: "Hotel Ondine",
        created_by: ANNA,
        org_access: "editor",
      },
      {
        id: HIDDEN_COMPANY,
        org_id: ORG_ID,
        handle: "hidden",
        name: "Private Rooms",
        created_by: crypto.randomUUID(),
        org_access: "none",
      },
    ]),
  )
  await sql.unsafe(
    insertSql("kernel.contacts", [
      {
        id: PERSON,
        org_id: ORG_ID,
        handle: `@cw-${PERSON.slice(0, 8)}`,
        email: `claire-${PERSON.slice(0, 6)}@maison.example`,
        name: "Claire",
        org_access: "editor",
        created_by: ANNA,
        company_id: COMPANY,
      },
      {
        id: OTHER_PERSON,
        org_id: ORG_ID,
        handle: `@cw-${OTHER_PERSON.slice(0, 8)}`,
        email: `remy-${OTHER_PERSON.slice(0, 6)}@ondine.example`,
        name: "Remy",
        org_access: "editor",
        created_by: ANNA,
        company_id: OTHER_COMPANY,
      },
    ]),
  )
  await sql.unsafe(
    insertSql("kernel.threads", {
      id: THREAD,
      org_id: ORG_ID,
      handle: `cw-${THREAD.slice(0, 8)}`,
      created_by: ANNA,
    }),
  )
  await sql.unsafe(
    insertSql("app_projects.projects", {
      id: PROJECT,
      org_id: ORG_ID,
      name: "Sales",
      key: `W${PROJECT.slice(0, 8).toUpperCase()}`,
      owner_id: ANNA,
      kind: "pipeline",
      created_at: AT,
      updated_at: AT,
    }),
  )
  await sql.unsafe(
    insertSql("app_projects.project_statuses", {
      id: STATUS,
      org_id: ORG_ID,
      project_id: PROJECT,
      label: "Proposal",
      '"order"': 1,
      terminal: false,
      created_at: AT,
      updated_at: AT,
    }),
  )
  await sql.unsafe(
    insertSql("app_projects.tasks", {
      id: DEAL_TASK,
      org_id: ORG_ID,
      project_id: PROJECT,
      status_id: STATUS,
      title: "Four more hotels",
      number: 1,
      thread_id: THREAD,
      created_by: ANNA,
      parent_task_id: null,
      created_at: AT,
      updated_at: AT,
    }),
  )
  await sql.unsafe(
    insertSql("app_projects.deals", { task_id: DEAL_TASK, org_id: ORG_ID, company_id: COMPANY }),
  )
  const [versions] = await sql<{ auth_version: number; permission_version: number }[]>`
    SELECT auth_version, permission_version FROM kernel.users WHERE id = ${ANNA}`
  token = await signAccessToken(
    {
      userId: ANNA,
      orgId: ORG_ID,
      name: "Anna",
      authVersion: versions?.auth_version ?? 1,
      permissionVersion: versions?.permission_version ?? 1,
      scopes: SCOPES,
      roles: [ROLE],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
})

afterAll(async () => {
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG_ID}`
  for (const table of ["deals", "tasks", "project_statuses", "projects"]) {
    await sql.unsafe(`DELETE FROM app_projects.${table} WHERE org_id = '${ORG_ID}'`)
  }
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.companies WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("a company's waiting approvals", () => {
  it("lists pending approvals linking the company, its people or its deals, and not another company's", async () => {
    const onCompany = await approval({ links: [link("company", COMPANY)] })
    const onPerson = await approval({ links: [link("contact", PERSON)] })
    const onDeal = await approval({
      links: [link("ticket", crypto.randomUUID(), "tickets"), link("task", DEAL_TASK, "projects")],
    })
    await approval({ links: [link("company", OTHER_COMPANY)] })
    await approval({ links: [link("contact", OTHER_PERSON)] })
    await approval({ links: [link("company", COMPANY)], status: "approved" })
    await approval({})
    await approval({ links: "not a list" })

    const ids = await withRlsContext(
      { actorType: "user", userId: ANNA, orgId: ORG_ID, scopes: SCOPES, dimensionGrants: {} },
      (tx) => companyWaitingApprovalIds(tx, { orgId: ORG_ID, companyId: COMPANY }),
    )
    expect(ids).toEqual([onDeal, onPerson, onCompany])
  })

  it("answers through the company route, and 404 for a company the reader cannot see", async () => {
    const headers = { Authorization: `Bearer ${token}` }
    const res = await app.request(`/api/contacts/companies/${COMPANY}/waiting`, { headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { approvalIds: string[] } }
    expect(body.data.approvalIds.length).toBe(3)
    const hidden = await app.request(`/api/contacts/companies/${HIDDEN_COMPANY}/waiting`, {
      headers,
    })
    expect(hidden.status).toBe(404)
  })
})
