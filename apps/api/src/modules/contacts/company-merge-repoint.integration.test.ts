// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A company merge under the real liaison_rls role: every row that named the
// merged company names the survivor afterwards (people, portal accounts,
// deals, pipelines and the approvals waiting on it, which then go to the
// survivor's account manager), the survivor's manager is chosen, the card says
// who stays, a stale tab's change hears where the company went, and a contact
// merge carries a deal's contact.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { type RlsClient, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { env } from "~/lib/env"
import { estimateToolSchemaTokens } from "~/modules/agent/context/context"
import { handleCompaniesMerge, summarizeCompaniesMerge } from "~/modules/agent/tools/company-tools"
import { providerInputSchemaOf } from "~/modules/agent/tools/tool-bridge"
import { type RoutableApprovalRow, readRoutesIgnoringAway } from "~/modules/approvals/route-world"
import { toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { setOrgAppStatus } from "~/modules/apps/org-app-service"
import { signAccessToken } from "~/modules/auth/jwt"
import { createCompany, getCompany, mergeCompanies } from "~/modules/contacts/companies"
import { mergeContactsWithMailReferences } from "~/modules/contacts/service"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = crypto.randomUUID()
const ANNA = crypto.randomUUID() // merges
const MIA = crypto.randomUUID() // manages the survivor
const LEO = crypto.randomUUID() // manages the merged company
const PORTAL = crypto.randomUUID() // a client's portal account
const THREAD = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)
const AT = "2026-03-02T09:00:00.000Z"

const SCOPES = [
  "kernel:contacts:read",
  "kernel:contacts:write",
  "kernel:companies:read",
  "kernel:companies:write",
  "projects:projects:read",
  "projects:tasks:read",
  "projects:tasks:write",
  "projects:deals:read",
  "projects:deals:write",
]
const anna: UserContext = {
  actorType: "user",
  userId: ANNA,
  orgId: ORG_ID,
  scopes: SCOPES,
  dimensionGrants: {},
}
const asAnna = <T>(fn: (tx: RlsClient) => Promise<T>) => withRlsContext(anna, fn)

const insert = (table: string, rows: Record<string, RowValue> | Record<string, RowValue>[]) =>
  sql.unsafe(insertSql(table, rows))

let token = ""
let seq = 0

async function company(name: string, owner: string | null): Promise<string> {
  const { company: row } = await asAnna((tx) =>
    createCompany(tx, { orgId: ORG_ID, userId: ANNA, input: { name } }),
  )
  if (owner) await sql`UPDATE kernel.companies SET owner_user_id = ${owner} WHERE id = ${row.id}`
  return row.id
}

async function contact(companyId: string | null, companyText: string | null): Promise<string> {
  const id = crypto.randomUUID()
  seq += 1
  await insert("kernel.contacts", {
    id,
    org_id: ORG_ID,
    handle: `@merge-${id.slice(0, 8)}`,
    email: `person-${seq}-${id.slice(0, 6)}@client.example`,
    name: `Person ${seq}`,
    org_access: "editor",
    created_by: ANNA,
    company_id: companyId,
    company: companyText,
  })
  return id
}

/** A pipeline naming `companyId` with one deal naming it (and `contactId`). */
async function pipelineWithDeal(
  companyId: string,
  contactId: string | null = null,
): Promise<{ project: string; task: string }> {
  const project = crypto.randomUUID()
  const status = crypto.randomUUID()
  const task = crypto.randomUUID()
  const thread = crypto.randomUUID()
  await insert("kernel.threads", {
    id: thread,
    org_id: ORG_ID,
    handle: `merge-deal-${thread.slice(0, 8)}`,
    created_by: ANNA,
  })
  await insert("app_projects.projects", {
    id: project,
    org_id: ORG_ID,
    name: "Sales",
    key: `M${project.slice(0, 8).toUpperCase()}`,
    owner_id: ANNA,
    kind: "pipeline",
    company_id: companyId,
    created_at: AT,
    updated_at: AT,
  })
  await insert("app_projects.project_statuses", {
    id: status,
    org_id: ORG_ID,
    project_id: project,
    label: "Proposal",
    '"order"': 1,
    terminal: false,
    created_at: AT,
    updated_at: AT,
  })
  await insert("app_projects.tasks", {
    id: task,
    org_id: ORG_ID,
    project_id: project,
    status_id: status,
    title: "Studio fit-out",
    number: 1,
    thread_id: thread,
    created_by: ANNA,
    parent_task_id: null,
    created_at: AT,
    updated_at: AT,
  })
  await insert("app_projects.deals", {
    task_id: task,
    org_id: ORG_ID,
    company_id: companyId,
    contact_id: contactId,
  })
  return { project, task }
}

/** A routine's reminder about `companyId`, waiting or decided. */
async function approvalAbout(companyId: string, status = "pending"): Promise<string> {
  const id = crypto.randomUUID()
  await insert("kernel.approval_requests", {
    id,
    org_id: ORG_ID,
    handle: `APR-${id.slice(0, 8)}`,
    thread_id: THREAD,
    originating_thread_id: THREAD,
    tool_name: "kernel:companies_write",
    tool_params: "{}",
    current_payload: JSON.stringify({ title: "Follow up" }),
    expires_at: { raw: "now() + INTERVAL '3 days'" },
    notify_user_ids: `{${[ANNA, MIA, LEO].join(",")}}`,
    requested_by: ANNA,
    status,
    summary: JSON.stringify({ title: "Follow up" }),
    metadata: JSON.stringify({ originRoutineId: crypto.randomUUID() }),
    approve_scope: "kernel:companies:write",
    route_company_id: companyId,
    decided_at: status === "pending" ? null : { raw: "now()" },
  })
  return id
}

/** Whom the request goes to now, as Home routes it. */
async function routedTo(requestId: string): Promise<string | null> {
  const rows = await sql<RoutableApprovalRow[]>`
    SELECT id::text AS id, tool_name, status, metadata, notify_user_ids::text[] AS notify_user_ids,
           requested_by::text AS requested_by, approve_scope,
           resource_owner_id::text AS resource_owner_id, route_person_id::text AS route_person_id,
           route_company_id::text AS route_company_id
      FROM kernel.approval_requests WHERE id = ${requestId}`
  const route = await asAnna(async (tx) =>
    (await readRoutesIgnoringAway(tx, ORG_ID, [...rows])).route(requestId),
  )
  return route.to === "person" ? (route as { userId: string }).userId : null
}

async function namingCount(companyId: string): Promise<Record<string, number>> {
  const [row] = await sql<Record<string, number>[]>`
    SELECT
      (SELECT count(*)::int FROM kernel.contacts WHERE company_id = ${companyId}) AS contacts,
      (SELECT count(*)::int FROM kernel.users WHERE company_id = ${companyId}) AS users,
      (SELECT count(*)::int FROM app_projects.deals WHERE company_id = ${companyId}) AS deals,
      (SELECT count(*)::int FROM app_projects.projects WHERE company_id = ${companyId}) AS projects,
      (SELECT count(*)::int FROM kernel.approval_requests WHERE route_company_id = ${companyId}) AS approvals`
  return row ?? {}
}

beforeAll(async () => {
  await acquireTestLock()
  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  registerEventSubscribers({
    bufferAndBroadcast: async () => {},
    broadcast: async () => {},
    closeConnectionsForUser: () => {},
  } as never)
  await insert("kernel.organizations", { id: ORG_ID, name: "Company merge", slug: `cm-${tag}` })
  await insert(
    "kernel.users",
    [
      [ANNA, "Anna Merge"],
      [MIA, "Mia Laurent"],
      [LEO, "Léo Brun"],
    ].map(([id, name]) => ({
      id: id as string,
      org_id: ORG_ID,
      email: `${(id as string).slice(0, 8)}@team.example`,
      name: name as string,
      status: "active",
      password_hash: "x",
      user_type: "member",
      company_id: null,
    })),
  )
  for (const user of [ANNA, MIA, LEO]) {
    for (const scope of SCOPES) {
      await insert("kernel.user_scope_grants", { user_id: user, org_id: ORG_ID, scope })
    }
  }
  await insert("kernel.threads", {
    id: THREAD,
    org_id: ORG_ID,
    handle: `merge-requests-${tag}`,
    created_by: ANNA,
  })
  await ensureAppsForOrg(ORG_ID)
  const [versions] = await sql<{ auth_version: number; permission_version: number }[]>`
    SELECT auth_version, permission_version FROM kernel.users WHERE id = ${ANNA}`
  token = await signAccessToken(
    {
      userId: ANNA,
      orgId: ORG_ID,
      name: "Anna Merge",
      authVersion: versions?.auth_version ?? 1,
      permissionVersion: versions?.permission_version ?? 1,
      scopes: SCOPES,
      roles: [],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
}, 120_000)

afterAll(async () => {
  for (const table of ["deal_values", "deals", "tasks", "project_statuses", "projects"]) {
    await sql.unsafe(`DELETE FROM app_projects.${table} WHERE org_id = '${ORG_ID}'`)
  }
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`.catch(() => undefined)
  resetEventBus()
  await releaseTestLock()
})

describe("company merge", () => {
  it("after a merge every row of users, deals, projects and waiting approvals that named the source names the target, and its waiting items go to the target's manager", async () => {
    const source = await company("Arlon Studio", LEO)
    const target = await company("Maison Arlon", MIA)
    const person = await contact(source, "Arlon Studio")
    await insert("kernel.users", {
      id: PORTAL,
      org_id: ORG_ID,
      email: `${PORTAL.slice(0, 8)}@client.example`,
      name: "Paula Portal",
      status: "active",
      password_hash: "x",
      user_type: "external",
      company_id: source,
    })
    const { project, task } = await pipelineWithDeal(source)
    const waiting = await approvalAbout(source)
    const decided = await approvalAbout(source, "approved")

    // Before: every row names the old company, and its waiting item is its manager's.
    expect(await namingCount(source)).toEqual({
      contacts: 1,
      users: 1,
      deals: 1,
      projects: 1,
      approvals: 2,
    })
    expect(await routedTo(waiting)).toBe(LEO)

    const result = await asAnna((tx) =>
      mergeCompanies(tx, { orgId: ORG_ID, userId: ANNA, sourceId: source, targetId: target }),
    )
    expect(result.moved).toEqual({
      contacts: 1,
      accounts: 1,
      waitingApprovals: 1,
      deals: 1,
      projects: 1,
    })

    expect(await namingCount(source)).toEqual({
      contacts: 0,
      users: 0,
      deals: 0,
      projects: 0,
      approvals: 0,
    })
    const [rows] = await sql<Record<string, string | null>[]>`
      SELECT
        (SELECT company_id::text FROM kernel.contacts WHERE id = ${person}) AS contact,
        (SELECT company FROM kernel.contacts WHERE id = ${person}) AS contact_text,
        (SELECT company_id::text FROM kernel.users WHERE id = ${PORTAL}) AS account,
        (SELECT company_id::text FROM app_projects.deals WHERE task_id = ${task}) AS deal,
        (SELECT company_id::text FROM app_projects.projects WHERE id = ${project}) AS pipeline,
        (SELECT route_company_id::text FROM kernel.approval_requests WHERE id = ${waiting}) AS waiting,
        (SELECT route_company_id::text FROM kernel.approval_requests WHERE id = ${decided}) AS decided,
        (SELECT id::text FROM kernel.companies WHERE id = ${source}) AS source_row`
    expect(rows).toEqual({
      contact: target,
      contact_text: "Maison Arlon",
      account: target,
      deal: target,
      pipeline: target,
      waiting: target,
      decided: target,
      source_row: null,
    })
    expect(await routedTo(waiting)).toBe(MIA)
  }, 60_000)

  it("the target's manager stays; a target without one takes the source's", async () => {
    const a = await company("Studio Lune", LEO)
    const b = await company("Lune Studio SARL", MIA)
    const kept = await asAnna((tx) =>
      handleCompaniesMerge({ sourceId: a, targetId: b }, { orgId: ORG_ID, userId: ANNA, db: tx }),
    )
    expect(kept).toMatchObject({ targetId: b, deletedId: a, managerId: MIA })
    expect((kept as { message: string }).message).toBe(
      "Studio Lune was merged into Lune Studio SARL and deleted: 0 people, 0 deals, 0 pipelines, 0 waiting approvals now name Lune Studio SARL. Mia Laurent stays its account manager. Sharing of Lune Studio SARL did not change.",
    )

    const c = await company("Menuiserie Nord", LEO)
    const d = await company("Nord Menuiserie", null)
    const taken = await asAnna((tx) =>
      mergeCompanies(tx, { orgId: ORG_ID, userId: ANNA, sourceId: c, targetId: d }),
    )
    expect(taken).toMatchObject({ managerId: LEO, managerFrom: "source" })
    const [row] = await sql<{ owner_user_id: string | null }[]>`
      SELECT owner_user_id FROM kernel.companies WHERE id = ${d}`
    expect(row?.owner_user_id).toBe(LEO)
  }, 60_000)

  it("the merge card names both managers, which one stays, and that sharing does not widen", async () => {
    const a = await company("Ferme Delage", LEO)
    const b = await company("Delage Frères", MIA)
    const card = await asAnna((tx) =>
      summarizeCompaniesMerge({ sourceId: a, targetId: b }, { tx, orgId: ORG_ID, userId: ANNA }),
    )
    expect(card.title).toBe("Merge Ferme Delage into Delage Frères")
    expect(card.lines).toEqual([
      "Ferme Delage is deleted; its people, deals, pipelines and waiting approvals move to Delage Frères.",
      "Account managers: Mia Laurent (Delage Frères) stays; Léo Brun (Ferme Delage) no longer manages it.",
      "Sharing stays as Delage Frères's: nobody, a portal account included, sees more than before.",
      "This cannot be undone.",
    ])
  })

  it("a restricted company is not merged into one the organisation sees: nothing moves, and the result says to widen its sharing first", async () => {
    const source = await company("Maison Privée", null)
    const target = await company("Maison Privee SAS", null)
    const person = await contact(source, "Maison Privée")
    await sql`UPDATE kernel.companies SET org_access = 'none' WHERE id = ${source}`
    const result = await asAnna((tx) =>
      handleCompaniesMerge(
        { sourceId: source, targetId: target },
        { orgId: ORG_ID, userId: ANNA, db: tx },
      ),
    )
    expect(result).toMatchObject({ error: { code: "merge_widens_access" } })
    const message = String((result as { error: { message: string } }).error.message)
    expect(message).toContain("Nothing was merged.")
    expect(message).toContain("Maison Privée is restricted")
    expect(message).toContain("Next: widen Maison Privée's sharing first")
    const [kept] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.companies WHERE id = ${source}`
    expect(kept?.n).toBe(1)
    const [row] = await sql<{ company_id: string | null }[]>`
      SELECT company_id::text FROM kernel.contacts WHERE id = ${person}`
    expect(row?.company_id).toBe(source)
  }, 60_000)

  it("a restricted company is not merged into one shared with other people, nor a view-only one into an editable one", async () => {
    // Mutation caught: only the restricted-into-org-wide case was refused.
    const merge = (sourceId: string, targetId: string) =>
      asAnna((tx) =>
        handleCompaniesMerge({ sourceId, targetId }, { orgId: ORG_ID, userId: ANNA, db: tx }),
      )
    const deal = await company("Acme (acquisition)", null)
    const acme = await company("Acme", null)
    const person = await contact(deal, "Acme (acquisition)")
    await sql`UPDATE kernel.companies SET org_access = 'none', acl_user_ids = ${JSON.stringify([MIA])}::jsonb
               WHERE id = ${deal}`
    await sql`UPDATE kernel.companies SET org_access = 'none', acl_user_ids = ${JSON.stringify([MIA, LEO])}::jsonb
               WHERE id = ${acme}`
    const wider = await merge(deal, acme)
    expect(wider).toMatchObject({ error: { code: "merge_widens_access" } })
    const message = String((wider as { error: { message: string } }).error.message)
    expect(message).toContain("Nothing was merged.")
    expect(message).toContain("Next: widen Acme (acquisition)'s sharing first")
    const [row] = await sql<{ company_id: string | null }[]>`
      SELECT company_id::text FROM kernel.contacts WHERE id = ${person}`
    expect(row?.company_id).toBe(deal)

    const viewOnly = await company("Studio Vue", null)
    const editable = await company("Vue Studio", null)
    await sql`UPDATE kernel.companies SET org_access = 'viewer' WHERE id = ${viewOnly}`
    expect(await merge(viewOnly, editable)).toMatchObject({
      error: { code: "merge_widens_access" },
    })

    // A survivor seen by no one the source was not shared with merges.
    const wide = await company("Bois Dormant", null)
    const narrow = await company("Dormant Bois", null)
    await sql`UPDATE kernel.companies SET org_access = 'none', acl_user_ids = ${JSON.stringify([MIA, LEO])}::jsonb
               WHERE id = ${wide}`
    await sql`UPDATE kernel.companies SET org_access = 'none', acl_user_ids = ${JSON.stringify([MIA])}::jsonb
               WHERE id = ${narrow}`
    expect(await merge(wide, narrow)).not.toMatchObject({ error: expect.anything() })
  }, 60_000)

  it("the merge tool is gated and its whole schema stays within its budget", () => {
    const def = toolRegistry.get([ORG_ID, "kernel", "companies_merge"])!
    expect(def.gated).toBe(true)
    const tokens = estimateToolSchemaTokens("kernel__companies_merge", {
      description: def.description,
      inputSchema: providerInputSchemaOf(def.params),
    })
    expect(tokens).toBeLessThanOrEqual(100)
  })

  it("a change to a merged company answers 404 naming the company it was merged into", async () => {
    const source = await company("Verrerie Claire", null)
    const target = await company("Claire Verrerie", null)
    await asAnna((tx) =>
      mergeCompanies(tx, { orgId: ORG_ID, userId: ANNA, sourceId: source, targetId: target }),
    )
    await drainOutbox()
    const res = await app.request(`/api/contacts/companies/${source}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ description: "late edit" }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: Record<string, unknown> }
    expect(body.error).toEqual({
      code: "company_merged",
      mergedInto: { id: target, name: "Claire Verrerie" },
      message: "This company was merged into Claire Verrerie.",
    })
  }, 60_000)

  it("merging contacts re-points the deal's contact", async () => {
    const co = await company("Boulangerie Pivot", null)
    const keep = await contact(co, "Boulangerie Pivot")
    const gone = await contact(co, "Boulangerie Pivot")
    const { task } = await pipelineWithDeal(co, gone)
    await sql`UPDATE kernel.companies SET main_contact_id = ${gone} WHERE id = ${co}`
    await asAnna((tx) =>
      mergeContactsWithMailReferences(tx, {
        orgId: ORG_ID,
        userId: ANNA,
        sourceId: gone,
        targetId: keep,
      }),
    )
    const [row] = await sql<{ deal: string | null; main: string | null }[]>`
      SELECT (SELECT contact_id::text FROM app_projects.deals WHERE task_id = ${task}) AS deal,
             (SELECT main_contact_id::text FROM kernel.companies WHERE id = ${co}) AS main`
    expect(row).toEqual({ deal: keep, main: keep })
  }, 60_000)

  it("with projects off during a merge, its deals name the target once it is back on", async () => {
    const source = await company("Cave Morel", null)
    const target = await company("Morel Caves", null)
    const { task } = await pipelineWithDeal(source)
    await setOrgAppStatus(ORG_ID, "projects", "disabled")
    try {
      await asAnna((tx) =>
        mergeCompanies(tx, { orgId: ORG_ID, userId: ANNA, sourceId: source, targetId: target }),
      )
    } finally {
      await setOrgAppStatus(ORG_ID, "projects", "active")
    }
    const survivor = await asAnna((tx) => getCompany(tx, { orgId: ORG_ID, companyId: target }))
    expect(survivor?.openDeal?.taskId).toBe(task)
    const [deal] = await sql<{ company_id: string | null }[]>`
      SELECT company_id::text FROM app_projects.deals WHERE task_id = ${task}`
    expect(deal?.company_id).toBe(target)
  }, 60_000)
})
