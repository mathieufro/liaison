// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The company service and its REST routes under the real liaison_rls role:
// linking and renaming keep each person's company text in step with the
// company, a domain is a business host or nothing, a delete leaves no deal or
// pipeline naming the company, and the routes are reachable beside the
// contact routes.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { type RlsClient, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import {
  armAfterCompanyRenameFailpoint,
  companyNameKey,
  createCompanies,
  createCompany,
  deleteCompany,
  getCompany,
  linkContactsToCompany,
  listCompanies,
  normaliseCompanyDomain,
  similarCompanies,
  updateCompany,
} from "~/modules/contacts/companies"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG_ID = crypto.randomUUID()
const ANNA = crypto.randomUUID() // a member who works with companies and deals
const BEN = crypto.randomUUID() // owns a private contact Anna cannot see
const ROLE = crypto.randomUUID()

const COMPANY_SCOPES = [
  "kernel:contacts:read",
  "kernel:contacts:write",
  "kernel:companies:read",
  "kernel:companies:write",
]
const PROJECT_SCOPES = ["projects:projects:read", "projects:tasks:read", "projects:tasks:write"]
const DEAL_SCOPES = ["projects:deals:read", "projects:deals:write"]
const ALL_SCOPES = [...COMPANY_SCOPES, ...PROJECT_SCOPES, ...DEAL_SCOPES]

function ctx(scopes: string[] = ALL_SCOPES, userId = ANNA): UserContext {
  return { actorType: "user", userId, orgId: ORG_ID, scopes, dimensionGrants: {} }
}

const asAnna = <T>(fn: (tx: RlsClient) => Promise<T>, scopes = ALL_SCOPES) =>
  withRlsContext(ctx(scopes), fn)

let token = ""
let seq = 0
const AT = "2026-03-02T09:00:00.000Z"

async function addContact(extra: Record<string, unknown> = {}): Promise<string> {
  const id = crypto.randomUUID()
  seq += 1
  await sql.unsafe(
    insertSql("kernel.contacts", {
      id,
      org_id: ORG_ID,
      handle: `@co-test-${id.slice(0, 8)}`,
      email: `person-${seq}-${id.slice(0, 6)}@client.example`,
      name: `Person ${seq}`,
      org_access: "editor",
      created_by: ANNA,
      ...extra,
    }),
  )
  return id
}

async function contactRow(id: string) {
  const [row] = await sql<{ company_id: string | null; company: string | null }[]>`
    SELECT company_id, company FROM kernel.contacts WHERE id = ${id}`
  return row
}

async function request(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  })
}

beforeAll(async () => {
  await sql.unsafe(
    insertSql("kernel.organizations", {
      id: ORG_ID,
      name: "Companies service",
      slug: `cs-${ORG_ID.slice(0, 8)}`,
    }),
  )
  await sql.unsafe(
    insertSql("kernel.users", [
      {
        id: ANNA,
        org_id: ORG_ID,
        email: `anna-${ANNA.slice(0, 8)}@example.com`,
        name: "Anna",
        status: "active",
      },
      {
        id: BEN,
        org_id: ORG_ID,
        email: `ben-${BEN.slice(0, 8)}@example.com`,
        name: "Ben",
        status: "active",
      },
    ]),
  )
  await sql.unsafe(insertSql("kernel.roles", { id: ROLE, org_id: ORG_ID, name: "company-worker" }))
  await sql.unsafe(
    insertSql(
      "kernel.role_scope_grants",
      ALL_SCOPES.map((scope) => ({ role_id: ROLE, scope })),
    ),
  )
  await sql.unsafe(insertSql("kernel.user_roles", { user_id: ANNA, role_id: ROLE, org_id: ORG_ID }))
  const [versions] = await sql<{ auth_version: number; permission_version: number }[]>`
    SELECT auth_version, permission_version FROM kernel.users WHERE id = ${ANNA}`
  token = await signAccessToken(
    {
      userId: ANNA,
      orgId: ORG_ID,
      name: "Anna",
      authVersion: versions?.auth_version ?? 1,
      permissionVersion: versions?.permission_version ?? 1,
      scopes: ALL_SCOPES,
      roles: [ROLE],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
})

afterAll(async () => {
  for (const table of ["deal_values", "deals", "tasks", "project_statuses", "projects"]) {
    await sql.unsafe(`DELETE FROM app_projects.${table} WHERE org_id = '${ORG_ID}'`)
  }
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.thread_references WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.companies WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("many companies at once", () => {
  it("writes each company with its own handle and event in one batch, numbering a taken handle", async () => {
    const { company: older } = await asAnna((tx) =>
      createCompany(tx, { orgId: ORG_ID, userId: ANNA, input: { name: "Brasserie Ombre" } }),
    )
    const created = await asAnna((tx) =>
      createCompanies(tx, {
        orgId: ORG_ID,
        userId: ANNA,
        inputs: [
          { name: "Cantines du Quai", domain: "https://quai.example/", tags: ["prospect"] },
          { name: "Brasserie Ombre SAS" },
          { name: "Cantines du Quai SARL" },
        ],
      }),
    )
    expect(created.map((c) => [c.name, c.domain, c.tags])).toEqual([
      ["Cantines du Quai", "quai.example", ["prospect"]],
      ["Brasserie Ombre SAS", null, []],
      ["Cantines du Quai SARL", null, []],
    ])
    const handles = created.map((c) => c.handle)
    expect(new Set([...handles, older.handle]).size).toBe(4)
    expect(handles[0]).toBe("@company-cantines-du-quai")
    const events = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.pending_events
       WHERE org_id = ${ORG_ID} AND payload->>'entity' = 'company'
         AND payload->>'action' = 'create'
         AND payload->>'entityId' = ANY(${created.map((c) => c.id)}::text[])`
    expect(events[0]?.n).toBe(3)
  })
})

describe("company people and names", () => {
  it("linking a contact writes its company id and company name together", async () => {
    const person = await addContact({ company: "old text" })
    const { company } = await asAnna((tx) =>
      createCompany(tx, { orgId: ORG_ID, userId: ANNA, input: { name: "Maison Arlon" } }),
    )
    const result = await asAnna((tx) =>
      linkContactsToCompany(tx, {
        orgId: ORG_ID,
        userId: ANNA,
        companyId: company.id,
        contactIds: [person],
      }),
    )
    expect(result.linked).toEqual([person])
    expect(await contactRow(person)).toEqual({ company_id: company.id, company: "Maison Arlon" })

    // Linking again reports the person linked and writes nothing: no second update event.
    const updates = async () =>
      (
        await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM kernel.pending_events
           WHERE org_id = ${ORG_ID} AND payload->>'entity' = 'contact'
             AND payload->>'action' = 'update' AND payload->>'entityId' = ${person}`
      )[0]?.n
    const before = await updates()
    const again = await asAnna((tx) =>
      linkContactsToCompany(tx, {
        orgId: ORG_ID,
        userId: ANNA,
        companyId: company.id,
        contactIds: [person],
      }),
    )
    expect(again).toEqual({ companyId: company.id, linked: [person], skipped: [] })
    expect(await updates()).toBe(before)
  })

  it("renaming a company rewrites the company name of all its people in one transaction", async () => {
    const { company } = await asAnna((tx) =>
      createCompany(tx, { orgId: ORG_ID, userId: ANNA, input: { name: "Hotel Lumen" } }),
    )
    const shared = [await addContact(), await addContact()]
    // A person shared with nobody but Ben: Anna cannot edit it, yet it carries
    // the company's name, so the rename rewrites it too.
    const hidden = await addContact({ org_access: "none", owner_user_id: BEN, created_by: BEN })
    await sql`UPDATE kernel.contacts SET company_id = ${company.id}, company = 'Hotel Lumen'
               WHERE id = ANY(${[...shared, hidden]}::uuid[])`

    // A fault after every person was rewritten: nothing changed at all.
    const disarm = armAfterCompanyRenameFailpoint(() => {
      throw new Error("fault after the rewrite")
    })
    try {
      await expect(
        asAnna((tx) =>
          updateCompany(tx, {
            orgId: ORG_ID,
            userId: ANNA,
            companyId: company.id,
            patch: { name: "Lumen Hotels" },
          }),
        ),
      ).rejects.toThrow("fault after the rewrite")
    } finally {
      disarm()
    }
    const [unchanged] = await sql<{ name: string }[]>`
      SELECT name FROM kernel.companies WHERE id = ${company.id}`
    expect(unchanged!.name).toBe("Hotel Lumen")
    for (const id of [...shared, hidden])
      expect((await contactRow(id))!.company).toBe("Hotel Lumen")

    await asAnna((tx) =>
      updateCompany(tx, {
        orgId: ORG_ID,
        userId: ANNA,
        companyId: company.id,
        patch: { name: "Lumen Hotels" },
      }),
    )
    for (const id of [...shared, hidden]) {
      expect(await contactRow(id)).toEqual({ company_id: company.id, company: "Lumen Hotels" })
    }
    // The event counts only the people Anna can see, and names who may get it.
    const [event] = await sql<{ data: Record<string, unknown> }[]>`
      SELECT payload->'data' AS data FROM kernel.pending_events
       WHERE org_id = ${ORG_ID} AND payload->>'entity' = 'company'
         AND payload->>'action' = 'update' AND payload->>'entityId' = ${company.id}
       ORDER BY seq DESC LIMIT 1`
    expect(event?.data.renamedPeople).toBe(2)
    expect(event?.data.audience).toEqual({ orgWide: true, userIds: [] })
  })
})

describe("company domains and names", () => {
  it("two companies may hold the same domain", async () => {
    const first = await asAnna((tx) =>
      createCompany(tx, {
        orgId: ORG_ID,
        userId: ANNA,
        input: { name: "Group North", domain: "group.example" },
      }),
    )
    const second = await asAnna((tx) =>
      createCompany(tx, {
        orgId: ORG_ID,
        userId: ANNA,
        input: { name: "Group South", domain: "group.example" },
      }),
    )
    expect(first.company.domain).toBe("group.example")
    expect(second.company.domain).toBe("group.example")
    expect(second.company.id).not.toBe(first.company.id)
  })

  it("a freemail domain is never stored and never matches", async () => {
    const out = await asAnna((tx) =>
      createCompany(tx, {
        orgId: ORG_ID,
        userId: ANNA,
        input: { name: "Solo Studio", domain: "gmail.com" },
      }),
    )
    expect(out.company.domain).toBeNull()
    expect(out.notice).toContain("gmail.com is a personal mail domain")
    const patched = await asAnna((tx) =>
      updateCompany(tx, {
        orgId: ORG_ID,
        userId: ANNA,
        companyId: out.company.id,
        patch: { domain: "https://www.gmail.com/" },
      }),
    )
    expect(patched.company.domain).toBeNull()
    const [stored] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.companies
       WHERE org_id = ${ORG_ID} AND lower(domain) = 'gmail.com'`
    expect(stored?.n).toBe(0)
    const found = await asAnna((tx) =>
      listCompanies(tx, { orgId: ORG_ID, page: 1, limit: 50, query: "gmail.com" }),
    )
    expect(found.total).toBe(0)
    const similar = await asAnna((tx) =>
      similarCompanies(tx, { orgId: ORG_ID, domain: "gmail.com" }),
    )
    expect(similar).toEqual([])
  })

  it("a typed url is stored as its host", async () => {
    expect(normaliseCompanyDomain("https://www.x.example/")).toEqual({ domain: "x.example" })
    expect(normaliseCompanyDomain("HTTP://Shop.X.Example:8080/a?b#c")).toEqual({
      domain: "shop.x.example",
    })
    expect(() => normaliseCompanyDomain("not a domain")).toThrow("is not a domain")
    const { company } = await asAnna((tx) =>
      createCompany(tx, {
        orgId: ORG_ID,
        userId: ANNA,
        input: { name: "Xavier Partners", domain: "https://www.x.example/" },
      }),
    )
    expect(company.domain).toBe("x.example")
  })

  it("a name typed in capitals with a legal form is offered as looking like the existing company", async () => {
    expect(companyNameKey("MAISON ARLON SAS")).toBe(companyNameKey("Maison Arlon"))
    expect(companyNameKey("Café Étoile S.A.R.L.")).toBe("cafe etoile s a r l")
    const similar = await asAnna((tx) =>
      similarCompanies(tx, { orgId: ORG_ID, name: "MAISON ARLON SAS" }),
    )
    expect(similar.map((s) => [s.name, s.reason])).toContainEqual(["Maison Arlon", "same_name"])
    // A hint only: creating it anyway works.
    const again = await asAnna((tx) =>
      createCompany(tx, { orgId: ORG_ID, userId: ANNA, input: { name: "MAISON ARLON SAS" } }),
    )
    expect(again.company.name).toBe("MAISON ARLON SAS")
    expect(again.company.handle).toBe("@company-maison-arlon-2")
  })
})

describe("company delete", () => {
  it("deleting a company clears it from deals and projects in the same transaction", async () => {
    const { company } = await asAnna((tx) =>
      createCompany(tx, { orgId: ORG_ID, userId: ANNA, input: { name: "Northwind Rooms" } }),
    )
    const person = await addContact({ company: "Northwind Rooms" })
    await sql`UPDATE kernel.contacts SET company_id = ${company.id} WHERE id = ${person}`
    const project = crypto.randomUUID()
    const status = crypto.randomUUID()
    const task = crypto.randomUUID()
    const thread = crypto.randomUUID()
    await sql.unsafe(
      insertSql("kernel.threads", {
        id: thread,
        org_id: ORG_ID,
        handle: `co-deal-${thread.slice(0, 8)}`,
        created_by: ANNA,
      }),
    )
    await sql.unsafe(
      insertSql("app_projects.projects", {
        id: project,
        org_id: ORG_ID,
        name: "Sales",
        key: `S${project.slice(0, 8).toUpperCase()}`,
        owner_id: ANNA,
        kind: "pipeline",
        company_id: company.id,
        created_at: AT,
        updated_at: AT,
      }),
    )
    await sql.unsafe(
      insertSql("app_projects.project_statuses", {
        id: status,
        org_id: ORG_ID,
        project_id: project,
        label: "Proposal",
        '"order"': 1,
        terminal: false,
        created_at: AT,
        updated_at: AT,
      }),
    )
    await sql.unsafe(
      insertSql("app_projects.tasks", {
        id: task,
        org_id: ORG_ID,
        project_id: project,
        status_id: status,
        title: "Rooms deal",
        number: 1,
        thread_id: thread,
        created_by: ANNA,
        parent_task_id: null,
        created_at: AT,
        updated_at: AT,
      }),
    )
    await sql.unsafe(
      insertSql("app_projects.deals", { task_id: task, org_id: ORG_ID, company_id: company.id }),
    )
    await sql.unsafe(
      insertSql("app_projects.deal_values", {
        task_id: task,
        org_id: ORG_ID,
        amount_minor: 480_000,
        currency: "EUR",
      }),
    )

    // The list's summary first: the open deal's stage, its amount only with
    // deal access, and the people count.
    const withAccess = await asAnna((tx) =>
      getCompany(tx, { orgId: ORG_ID, companyId: company.id }),
    )
    expect(withAccess!.peopleCount).toBe(1)
    expect(withAccess!.openDeal).toEqual({
      taskId: task,
      title: "Rooms deal",
      projectId: project,
      stage: "Proposal",
      amountMinor: 480_000,
      currency: "EUR",
    })
    const noDealAccess = await asAnna(
      (tx) => getCompany(tx, { orgId: ORG_ID, companyId: company.id }),
      [...COMPANY_SCOPES, ...PROJECT_SCOPES],
    )
    expect(noDealAccess!.openDeal).toEqual({
      taskId: task,
      title: "Rooms deal",
      projectId: project,
      stage: "Proposal",
      amountMinor: null,
      currency: null,
    })

    // Deleting as a member who cannot see deals at all still clears them.
    const out = await asAnna(
      (tx) => deleteCompany(tx, { orgId: ORG_ID, userId: ANNA, companyId: company.id }),
      COMPANY_SCOPES,
    )
    expect(out).toEqual({ id: company.id, dealsCleared: 1, projectsCleared: 1 })
    const [deal] = await sql<{ company_id: string | null }[]>`
      SELECT company_id FROM app_projects.deals WHERE task_id = ${task}`
    const [pipeline] = await sql<{ company_id: string | null }[]>`
      SELECT company_id FROM app_projects.projects WHERE id = ${project}`
    expect(deal!.company_id).toBeNull()
    expect(pipeline!.company_id).toBeNull()
    // People keep their company text and lose the link.
    expect(await contactRow(person)).toEqual({ company_id: null, company: "Northwind Rooms" })
  })
})

describe("company routes", () => {
  it("routes for companies are not shadowed by the contact id route", async () => {
    const created = await request("/api/contacts/companies", {
      method: "POST",
      body: JSON.stringify({ name: "Route Check", domain: "route-check.example" }),
    })
    expect(created.status).toBe(201)
    const { data } = (await created.json()) as { data: { id: string; handle: string } }
    expect(data.handle).toBe("@company-route-check")

    const list = await request("/api/contacts/companies?query=route-check")
    expect(list.status).toBe(200)
    const listed = (await list.json()) as { data: Array<{ id: string }>; meta: { total: number } }
    expect(listed.data.map((r) => r.id)).toEqual([data.id])

    const one = await request(`/api/contacts/companies/${data.id}`)
    expect(one.status).toBe(200)
    const sharing = await request(`/api/contacts/companies/${data.id}/sharing`)
    expect(sharing.status).toBe(200)
    expect(((await sharing.json()) as { data: { orgAccess: string } }).data.orgAccess).toBe(
      "editor",
    )
    const discussion = await request(`/api/contacts/companies/${data.id}/discussion`, {
      method: "POST",
    })
    expect(discussion.status).toBe(200)
    const [thread] = await sql<{ created_from: Record<string, string> }[]>`
      SELECT created_from FROM kernel.threads
       WHERE id = ${((await discussion.json()) as { data: { threadId: string } }).data.threadId}`
    expect(thread!.created_from).toEqual({
      app: "kernel",
      entityType: "company",
      entityId: data.id,
    })
  })

  it("a contacts admin reads the sharing of a team-wide company someone else created", async () => {
    const admin = crypto.randomUUID()
    const adminRole = crypto.randomUUID()
    const adminScopes = [...ALL_SCOPES, "kernel:contacts:admin"]
    await sql.unsafe(
      insertSql("kernel.users", {
        id: admin,
        org_id: ORG_ID,
        email: `admin-${admin.slice(0, 8)}@example.com`,
        name: "Admin",
        status: "active",
      }),
    )
    await sql.unsafe(insertSql("kernel.roles", { id: adminRole, org_id: ORG_ID, name: "admin" }))
    await sql.unsafe(
      insertSql(
        "kernel.role_scope_grants",
        adminScopes.map((scope) => ({ role_id: adminRole, scope })),
      ),
    )
    await sql.unsafe(
      insertSql("kernel.user_roles", { user_id: admin, role_id: adminRole, org_id: ORG_ID }),
    )
    const adminToken = await signAccessToken(
      {
        userId: admin,
        orgId: ORG_ID,
        name: "Admin",
        authVersion: 1,
        permissionVersion: 1,
        scopes: adminScopes,
        roles: [adminRole],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
    // One company by an active colleague, one with no creator (an import).
    for (const createdBy of [BEN, null]) {
      const companyId = crypto.randomUUID()
      await sql.unsafe(
        insertSql("kernel.companies", {
          id: companyId,
          org_id: ORG_ID,
          name: `Shared ${companyId.slice(0, 6)}`,
          handle: `@company-shared-${companyId.slice(0, 8)}`,
          org_access: "editor",
          created_by: createdBy,
        }),
      )
      const sharing = await request(`/api/contacts/companies/${companyId}/sharing`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      const body = (await sharing.json()) as {
        data: { orgAccess: string; createdBy: string | null; canManage: boolean }
      }
      expect(sharing.status).toBe(200)
      expect(body.data).toMatchObject({
        orgAccess: "editor",
        createdBy,
        canManage: createdBy === null,
      })
    }
  })

  it("a merged or deleted company answers 404 to a stale tab", async () => {
    const created = await request("/api/contacts/companies", {
      method: "POST",
      body: JSON.stringify({ name: "Gone Soon" }),
    })
    const { data } = (await created.json()) as { data: { id: string } }
    const deleted = await request(`/api/contacts/companies/${data.id}`, { method: "DELETE" })
    expect(deleted.status).toBe(200)
    // A merge deletes its source the same way, so a stale tab meets the same 404.
    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", JSON.stringify({ name: "Back" })],
      ["DELETE", undefined],
    ] as const) {
      const res = await request(`/api/contacts/companies/${data.id}`, { method, body })
      expect(res.status).toBe(404)
    }
    const discussion = await request(`/api/contacts/companies/${data.id}/discussion`, {
      method: "POST",
    })
    expect(discussion.status).toBe(404)
  })
})

describe("company search", () => {
  it("a new company is found by /api/search under its name", async () => {
    const { company } = await asAnna((tx) =>
      createCompany(tx, {
        orgId: ORG_ID,
        userId: ANNA,
        input: { name: "Quillfeather Lodges", domain: "quillfeather.example" },
      }),
    )
    const [event] = await sql<{ payload: Record<string, string> }[]>`
      SELECT payload FROM kernel.pending_events
       WHERE org_id = ${ORG_ID} AND payload->>'entity' = 'company'
         AND payload->>'action' = 'create' AND payload->>'entityId' = ${company.id}`
    expect(event).toBeDefined()

    // The boot-time indexer consumer turns that event into this job; a bare
    // test process drives the same job directly, on index settings the boot
    // path would have applied.
    // Boot registers the org's apps, then makes their fields filterable. The
    // index may already exist here (an earlier file in this process made it
    // with fewer fields), and on an existing index the drift check only queues
    // a rebuild no worker runs in a test: apply the settings and wait, so the
    // query's dimension filters are filterable.
    const { ensureAppsForOrg } = await import("~/modules/apps/init")
    await ensureAppsForOrg(ORG_ID)
    const { detectDrift, expectedSettings } = await import("~/modules/search/drift")
    const { collectSearchableRegistrations } = await import("~/modules/search/searchable-entities")
    const regs = collectSearchableRegistrations(ORG_ID)
    expect(regs.entities.some((e) => e.app === "kernel" && e.entityType === "company")).toBe(true)
    const inputs = {
      registeredReadScopes: regs.registeredReadScopes,
      dimensionFields: regs.dimensionFields,
      aclFieldNames: regs.aclFieldNames,
    }
    await detectDrift(inputs)
    const { getMeili, effectiveIndexName } = await import("~/infra/search/client")
    const meili = getMeili()
    const applied = await meili.index(effectiveIndexName()).updateSettings(expectedSettings(inputs))
    await meili.tasks.waitForTask(applied.taskUid)
    const { processIndexerJob } = await import("~/modules/search/indexer")
    await processIndexerJob({
      action: "upsert",
      orgId: ORG_ID,
      app: "kernel",
      entityType: "company",
      entityId: company.id,
    })
    const { globalSearch } = await import("~/modules/search/service")
    const result = await globalSearch({
      orgId: ORG_ID,
      userId: ANNA,
      scopes: ALL_SCOPES,
      dimensionGrants: {},
      roleIds: [ROLE],
      q: "Quillfeather",
      limit: 10,
    })
    expect(result.entities).toContainEqual(
      expect.objectContaining({ app: "kernel", entityType: "company", id: company.id }),
    )
  }, 20_000)
})
