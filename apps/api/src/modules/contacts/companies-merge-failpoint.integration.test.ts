// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A company merge is one transaction: a fault after the waiting items moved,
// or after every reference moved, leaves both companies and every link as they
// were.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  armCompanyMergeFailpoint,
  type CompanyMergeStage,
  createCompany,
  mergeCompanies,
} from "~/modules/contacts/companies"
import { insertSql, type RowValue } from "~/seed/factories/org/test-rows"

const ORG_ID = crypto.randomUUID()
const ANNA = crypto.randomUUID()
const THREAD = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)
const SCOPES = [
  "kernel:contacts:read",
  "kernel:contacts:write",
  "kernel:companies:read",
  "kernel:companies:write",
]
const anna: UserContext = {
  actorType: "user",
  userId: ANNA,
  orgId: ORG_ID,
  scopes: SCOPES,
  dimensionGrants: {},
}
const asAnna = <T>(fn: (tx: RlsClient) => Promise<T>) => withRlsContext(anna, fn)
const insert = (table: string, rows: Record<string, RowValue>) => sql.unsafe(insertSql(table, rows))

async function company(name: string): Promise<string> {
  const { company: row } = await asAnna((tx) =>
    createCompany(tx, { orgId: ORG_ID, userId: ANNA, input: { name } }),
  )
  return row.id
}

/** Everything a merge would change, read back as plain values. */
async function world(source: string, target: string) {
  return sql`
    SELECT
      (SELECT array_agg(id::text ORDER BY id) FROM kernel.companies
        WHERE id IN (${source}, ${target})) AS companies,
      (SELECT array_agg(company_id::text || ':' || coalesce(company, '') ORDER BY id)
         FROM kernel.contacts WHERE org_id = ${ORG_ID}) AS people,
      (SELECT array_agg(route_company_id::text ORDER BY id)
         FROM kernel.approval_requests WHERE org_id = ${ORG_ID}) AS routes,
      (SELECT array_agg(not_same_as::text ORDER BY id)
         FROM kernel.companies WHERE org_id = ${ORG_ID}) AS not_same`
}

beforeAll(async () => {
  await insert("kernel.organizations", { id: ORG_ID, name: "Merge failpoint", slug: `mf-${tag}` })
  await insert("kernel.users", {
    id: ANNA,
    org_id: ORG_ID,
    email: `${tag}@team.example`,
    name: "Anna",
    status: "active",
  })
  await insert("kernel.threads", {
    id: THREAD,
    org_id: ORG_ID,
    handle: `merge-fp-${tag}`,
    created_by: ANNA,
  })
})

afterAll(async () => {
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`.catch(() => undefined)
})

describe("company merge atomicity", () => {
  it("a merge that fails half way leaves both companies and every link as they were", async () => {
    for (const stage of ["after-routes", "after-references"] as CompanyMergeStage[]) {
      const source = await company(`Tissage ${stage}`)
      const target = await company(`Tissages ${stage} SA`)
      const other = await company(`Other ${stage}`)
      await sql`UPDATE kernel.companies SET not_same_as = ARRAY[${source}]::uuid[] WHERE id = ${other}`
      const person = crypto.randomUUID()
      await insert("kernel.contacts", {
        id: person,
        org_id: ORG_ID,
        handle: `@fp-${person.slice(0, 8)}`,
        name: "Person",
        org_access: "editor",
        created_by: ANNA,
        company_id: source,
        company: `Tissage ${stage}`,
      })
      const request = crypto.randomUUID()
      await insert("kernel.approval_requests", {
        id: request,
        org_id: ORG_ID,
        handle: `APR-${request.slice(0, 8)}`,
        thread_id: THREAD,
        originating_thread_id: THREAD,
        tool_name: "kernel:companies_write",
        tool_params: "{}",
        current_payload: "{}",
        expires_at: { raw: "now() + INTERVAL '3 days'" },
        requested_by: ANNA,
        status: "pending",
        route_company_id: source,
      })
      const before = await world(source, target)

      const seen: { at: CompanyMergeStage | null } = { at: null }
      const disarm = armCompanyMergeFailpoint((at) => {
        if (at === stage) {
          seen.at = at
          throw new Error(`fault ${at}`)
        }
      })
      try {
        await expect(
          asAnna((tx) =>
            mergeCompanies(tx, { orgId: ORG_ID, userId: ANNA, sourceId: source, targetId: target }),
          ),
        ).rejects.toThrow(`fault ${stage}`)
      } finally {
        disarm()
      }
      expect(seen.at).toBe(stage)
      expect(await world(source, target)).toEqual(before)
    }
  })
})
