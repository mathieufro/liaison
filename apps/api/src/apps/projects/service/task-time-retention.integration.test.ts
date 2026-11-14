// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Time rows older than 36 months lose their person, on the real database with a fixed clock:
// the row's cost is frozen first, so a project's totals and its cost read the same before and
// after, and a younger row keeps its person.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { seedContext } from "~/seed/context"
import { seedCostRates, seedTaskTime } from "~/seed/factories/projects/time"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { anonymiseOldTaskTime, personCutoff } from "./task-time-anonymise"
import { awaitTimeFeatureSync } from "./time-feature"

let orgId = ""
let admin: minimal.Session
let ana: minimal.Session
let projectId = ""
let taskId = ""

const NOW = new Date("2026-11-13T09:00:00Z")

function actor(scopes: string[]): UserContext {
  return { actorType: "user", userId: admin.userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function call<T = Record<string, any>>(method: string, input: unknown): Promise<T> {
  const a = actor(["*"])
  return runContextStore.run({} as never, () =>
    withRlsContext(a, async (tx) => {
      const bridge = createRpcBridge(
        "projects",
        a.userId,
        orgId,
        tx,
        { name: "projects" },
        a.scopes,
        "user",
        undefined,
        { origin: "human-ui" } as never,
      )
      return JSON.parse(await bridge[method](JSON.stringify(input))) as T
    }),
  )
}

/** The project's real minutes and its cost, as margin reads them. */
async function figures(): Promise<{ minutes: number; cost: number }> {
  return withRlsContext(actor(["projects:projects:read", "projects:margin:read"]), async (tx) => {
    const [t] = extractRows<{ m: string }>(
      await tx.execute(drizzleSql`
          SELECT coalesce(sum(minutes), 0)::text AS m
            FROM app_projects.task_time_totals(${projectId}::uuid, NULL, NULL)`),
    )
    const [c] = extractRows<{ c: string }>(
      await tx.execute(drizzleSql`
          SELECT app_projects.project_time_cost(${projectId}::uuid, NULL, NULL)::text AS c`),
    )
    return { minutes: Number(t?.m), cost: Number(c?.c) }
  })
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  admin = await minimal.adminSession(orgId)
  ana = await minimal.session(orgId, { role: "member" })
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
  projectId = (await call<{ id: string }>("projects_createProject", { name: "Maison Delorme" })).id
  await call("projects_updateProject", { projectId, timeBudgets: true })
  await awaitTimeFeatureSync(orgId)
  taskId = (await call<{ id: string }>("projects_createTask", { projectId, title: "Archive" })).id
  // Ana cost 40 an hour until mid 2023, then 50, written by a holder of the cost rate scope.
  const ctx = seedContext({ orgId, now: NOW })
  await seedCostRates(ctx, actor(["projects:cost_rates:write"]), [
    { userId: ana.userId, rateMinor: 4000, currency: "EUR", effectiveFrom: "2022-01-01" },
    { userId: ana.userId, rateMinor: 5000, currency: "EUR", effectiveFrom: "2023-06-01" },
  ])
  // Her own time, written as her.
  await seedTaskTime(
    ctx,
    {
      actorType: "user",
      userId: ana.userId,
      orgId,
      scopes: ["projects:projects:read", "projects:tasks:read", "projects:tasks:write"],
      dimensionGrants: { "*": ["*"] },
    },
    [
      { taskId, projectId, workDate: "2023-03-10", minutes: 90 },
      { taskId, projectId, workDate: "2023-09-12", minutes: 120 },
      { taskId, projectId, workDate: "2026-10-05", minutes: 60 },
    ],
  )
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("time rows past 36 months", () => {
  it("entries past 36 months lose their person and totals and margin stay", async () => {
    expect(personCutoff(NOW)).toBe("2023-11-13")
    const before = await figures()
    expect(before).toEqual({ minutes: 270, cost: 6000 + 10000 + 5000 })
    const out = await anonymiseOldTaskTime(NOW)
    expect(out.anonymised).toBeGreaterThanOrEqual(2)
    const rows = extractRows<{
      work_date: string
      user_id: string | null
      cost_minor: string | null
      cost_currency: string | null
    }>(
      await db.execute(drizzleSql`
        SELECT work_date::text AS work_date, user_id::text AS user_id, cost_minor::text AS cost_minor,
               cost_currency
          FROM app_projects.task_time WHERE task_id = ${taskId}::uuid ORDER BY work_date`),
    )
    expect(rows).toEqual([
      { work_date: "2023-03-10", user_id: null, cost_minor: "6000", cost_currency: "EUR" },
      { work_date: "2023-09-12", user_id: null, cost_minor: "10000", cost_currency: "EUR" },
      { work_date: "2026-10-05", user_id: ana.userId, cost_minor: null, cost_currency: null },
    ])
    expect(await figures()).toEqual(before)
    // A second pass finds nothing left to do and changes nothing.
    await anonymiseOldTaskTime(NOW)
    expect(await figures()).toEqual(before)
  })
})
