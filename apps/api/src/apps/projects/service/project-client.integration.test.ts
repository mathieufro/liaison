// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A project's client company, set by `createProject` and `update_project` as an
// agent's call reaches them: only a company the caller can read, and null
// clears it. Real database, real liaison_rls role.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { insertSql } from "~/seed/factories/org/test-rows"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { type DealWorld, makeDealWorld, makeWorkProject } from "./__tests__/deal-world"

let w: DealWorld
let otherUser = ""

async function call<T = Record<string, unknown>>(method: string, input: unknown): Promise<T> {
  return withRlsContext(w.actor, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      w.userId,
      w.orgId,
      tx,
      { name: "projects" },
      w.actor.scopes,
    )
    return JSON.parse(await bridge[method](JSON.stringify(input))) as T
  })
}

async function company(name: string, visible: boolean): Promise<string> {
  const id = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.companies", {
      id,
      org_id: w.orgId,
      handle: `@client-${id.slice(0, 8)}`,
      name,
      created_by: visible ? w.userId : otherUser,
      org_access: visible ? "editor" : "none",
    }),
  )
  return id
}

const clientOf = async (projectId: string) =>
  extractRows<{ company_id: string | null }>(
    await db.execute(drizzleSql`
      SELECT company_id::text AS company_id FROM app_projects.projects WHERE id = ${projectId}::uuid`),
  )[0]?.company_id ?? null

beforeAll(async () => {
  await acquireTestLock()
  w = await makeDealWorld("project-client")
  otherUser = crypto.randomUUID()
  await sql.unsafe(
    insertSql("kernel.users", {
      id: otherUser,
      org_id: w.orgId,
      email: `other-${otherUser.slice(0, 8)}@client.test`,
      name: "Other",
      status: "active",
      password_hash: "h",
      auth_version: 1,
      permission_version: 1,
    }),
  )
})

afterAll(releaseTestLock)

describe("a project's client", () => {
  it("setting a project's client needs a company the caller can read and null clears it", async () => {
    const seen = await company("Lumen", true)
    const unseen = await company("Hidden Holdings", false)
    const p = await makeWorkProject(w, "Website rebuild")

    const set = await call<{ companyId?: string }>("projects_updateProject", {
      projectId: p.projectId,
      companyId: seen,
    })
    expect(set.companyId).toBe(seen)
    expect(await clientOf(p.projectId)).toBe(seen)

    const refused = await call<{ error?: { code: string; message: string } }>(
      "projects_updateProject",
      { projectId: p.projectId, companyId: unseen },
    )
    expect(refused.error?.code).toBe("company_not_found")
    expect(refused.error?.message).toContain("Nothing was changed")
    expect(await clientOf(p.projectId)).toBe(seen)

    const cleared = await call<{ companyId?: string | null }>("projects_updateProject", {
      projectId: p.projectId,
      companyId: null,
    })
    expect(cleared.companyId).toBeNull()
    expect(await clientOf(p.projectId)).toBeNull()

    const created = await call<{ id: string; companyId?: string; error?: { code: string } }>(
      "projects_createProject",
      { name: "Support retainer", companyId: seen },
    )
    expect(created.companyId).toBe(seen)
    expect(await clientOf(created.id)).toBe(seen)

    const hidden = await call<{ error?: { code: string } }>("projects_createProject", {
      name: "Hidden client board",
      companyId: unseen,
    })
    expect(hidden.error?.code).toBe("company_not_found")
    const boards = extractRows<{ n: string }>(
      await db.execute(drizzleSql`
        SELECT COUNT(*)::text AS n FROM app_projects.projects
        WHERE org_id = ${w.orgId}::uuid AND name = 'Hidden client board'`),
    )
    expect(boards[0]?.n).toBe("0")
  })
})
