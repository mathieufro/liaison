// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The first project of an org turned on to time and budgets tells the person who
// turned it, in the tool's result, and the org's admins, once, on Home.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { type UserContext, withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  awaitTimeFeatureSync,
  FIRST_ON_KIND,
  firstOnNotice,
  NEXT_MESSAGE_LINE,
  STAFF_CONSULTATION_MEMBERS,
  syncTimeBudgetsFeature,
} from "./time-feature"

let orgId = ""
let owner: minimal.Session

const actor = (): UserContext => ({
  actorType: "user",
  userId: owner.userId,
  orgId,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
})

async function call(method: string, input: unknown): Promise<Record<string, any>> {
  const a = actor()
  const out = await withRlsContext(a, async (tx) => {
    const bridge = createRpcBridge(
      "projects",
      a.userId,
      orgId,
      tx,
      { name: "projects" },
      a.scopes,
      "user",
      undefined,
      {
        origin: "human-ui",
      } as never,
    )
    return JSON.parse(await bridge[method](JSON.stringify(input)))
  })
  await awaitTimeFeatureSync(orgId)
  return out
}

const homeLines = async () =>
  extractRows<{ user_id: string; summary: string }>(
    await db.execute(drizzleSql`
      SELECT user_id::text AS user_id, summary FROM kernel.attention_events
      WHERE org_id = ${orgId}::uuid AND kind = ${FIRST_ON_KIND}`),
  )

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.adminSession(orgId)
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("the first project turned on", () => {
  it("the first project turned on tells its turner and the admins once", async () => {
    const a = await call("projects_createProject", { name: "Atlas build", timeBudgets: true })
    expect(a.timeBudgets).toBe(true)
    expect(String(a.timeBudgetsNote)).toContain(firstOnNotice(1))
    expect(String(a.timeBudgetsNote)).toContain(NEXT_MESSAGE_LINE)
    const first = await homeLines()
    expect(first.map((l) => l.user_id)).toEqual([owner.userId])
    expect(first[0]?.summary).toContain("notice template")

    // A second project, and the first turned off and on again: no second notice.
    const b = await call("projects_createProject", { name: "Orbit build" })
    const bOn = await call("projects_updateProject", { projectId: b.id, timeBudgets: true })
    expect(String(bOn.timeBudgetsNote)).not.toContain(NEXT_MESSAGE_LINE)
    await call("projects_updateProject", { projectId: a.id, timeBudgets: false })
    await call("projects_updateProject", { projectId: a.id, timeBudgets: true })
    expect(await homeLines()).toHaveLength(1)
  })

  it("from 50 active members the notice also names consulting the staff representatives", () => {
    expect(firstOnNotice(STAFF_CONSULTATION_MEMBERS - 1)).not.toContain("staff representatives")
    expect(firstOnNotice(STAFF_CONSULTATION_MEMBERS)).toContain(
      "consult your staff representatives first",
    )
  })
})

describe("an org whose time projects come and go", () => {
  it("the admins are told once, also after every project goes off, a line is read and one comes back on", async () => {
    const c = await call("projects_createProject", { name: "Comet build" })
    await db.execute(drizzleSql`
      UPDATE kernel.attention_events SET read_at = now()
       WHERE org_id = ${orgId}::uuid AND kind = ${FIRST_ON_KIND}`)
    await db.execute(drizzleSql`
      UPDATE app_projects.projects SET time_budgets_on = false WHERE org_id = ${orgId}::uuid`)
    expect((await syncTimeBudgetsFeature(orgId, null)).enabled).toBe(false)
    await call("projects_updateProject", { projectId: c.id, timeBudgets: true })
    expect(await homeLines()).toHaveLength(1)
  })

  it("an archived project no longer keeps the time tools on for the org", async () => {
    await db.execute(drizzleSql`
      UPDATE app_projects.projects SET archived_at = now()
       WHERE org_id = ${orgId}::uuid AND time_budgets_on`)
    expect((await syncTimeBudgetsFeature(orgId, null)).enabled).toBe(false)
    await db.execute(drizzleSql`
      UPDATE app_projects.projects SET archived_at = NULL
       WHERE org_id = ${orgId}::uuid AND time_budgets_on`)
    expect((await syncTimeBudgetsFeature(orgId, null)).enabled).toBe(true)
  })
})
