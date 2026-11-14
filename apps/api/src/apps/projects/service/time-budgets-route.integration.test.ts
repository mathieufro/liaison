// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The REST routes of a project carry the time and budgets switch through the
// same writer as the agent's tools, and the daily sweep heals the org row when
// a recompute after a commit was lost.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { HEAL_HOUR_UTC, healTimeBudgets, runReconcileSweep } from "./reconcile-sweep"

let orgId = ""
let owner: minimal.Session

const headers = () => ({
  Authorization: `Bearer ${owner.bearer}`,
  "Content-Type": "application/json",
})

async function rest(method: string, path: string, body?: unknown) {
  const res = await app.request(`/api/projects${path}`, {
    method,
    headers: headers(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return {
    status: res.status,
    body: (await res.json()) as { data?: Record<string, any>; error?: any },
  }
}

const orgRow = async (): Promise<boolean | null> =>
  extractRows<{ enabled: boolean }>(
    await db.execute(drizzleSql`
      SELECT enabled FROM kernel.org_app_features
      WHERE org_id = ${orgId}::uuid AND app_name = 'projects' AND feature = 'time_budgets'`),
  )[0]?.enabled ?? null

const projectOn = async (id: string) =>
  extractRows<{ on: boolean; by: string | null }>(
    await db.execute(drizzleSql`
      SELECT time_budgets_on AS on, time_budgets_changed_by::text AS by
        FROM app_projects.projects WHERE id = ${id}::uuid`),
  )[0]

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

describe("the project routes carry the time and budgets switch", () => {
  it("creating a project with timeBudgets turns it on and the org's tools follow", async () => {
    const made = await rest("POST", "", { name: "Atlas route", timeBudgets: true })
    expect(made.status).toBe(200)
    const id = made.body.data?.id as string
    expect((await projectOn(id))?.on).toBe(true)
    expect((await projectOn(id))?.by).toBe(owner.userId)
    expect(await orgRow()).toBe(true)
  })

  it("the edit route turns it off, a repeat records no change, and a pipeline refuses planning_off", async () => {
    const made = await rest("POST", "", { name: "Orbit route" })
    const id = made.body.data?.id as string
    const onRes = await rest("PATCH", `/${id}`, { timeBudgets: true })
    expect(onRes.status).toBe(200)
    expect((await projectOn(id))?.on).toBe(true)
    const audit = async () =>
      Number(
        extractRows<{ n: string | number }>(
          await db.execute(drizzleSql`
            SELECT count(*) AS n FROM kernel.pending_events
             WHERE org_id = ${orgId}::uuid AND payload->>'entity' = 'time_feature'
               AND payload->>'entityId' = ${id}`),
        )[0]?.n ?? 0,
      )
    const before = await audit()
    await rest("PATCH", `/${id}`, { timeBudgets: true })
    expect(await audit()).toBe(before)
    const offRes = await rest("PATCH", `/${id}`, { timeBudgets: false })
    expect(offRes.status).toBe(200)
    expect((await projectOn(id))?.on).toBe(false)

    const { createPipeline } = await import("./create-project")
    const { withRlsContext } = await import("~/db/rls")
    const actor = {
      actorType: "user" as const,
      userId: owner.userId,
      orgId,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    }
    const pipeline = await withRlsContext(actor, (tx) =>
      createPipeline({ tx, orgId, actor, input: { name: "Sales route" } }),
    )
    const refused = await rest("PATCH", `/${pipeline.id}`, { timeBudgets: true })
    expect(refused.status).toBe(409)
    expect(refused.body.error?.code).toBe("planning_off")
    expect((await projectOn(pipeline.id))?.on).toBe(false)
  })
})

describe("a task's time keys and the plan read back on the REST routes", () => {
  const as = async (bearer: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/projects${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    return {
      status: res.status,
      body: (await res.json()) as { data?: Record<string, any>; error?: any },
    }
  }
  const TIME_KEYS = ["timeboxMinutes", "realTotalMinutes", "isMilestone"]
  // A colleague who reads projects and tasks and holds no money scope.
  const colleague = async () => {
    const p = await minimal.person(orgId)
    await minimal.grantScope(p.id, "projects:projects:read")
    await minimal.grantScope(p.id, "projects:tasks:read")
    return minimal.sessionOf(p)
  }

  it("a task of a project using it carries its timebox, total and milestone flag; another project's carries none", async () => {
    const on = (await rest("POST", "", { name: "Keys on", timeBudgets: true })).body.data!
    const off = (await rest("POST", "", { name: "Keys off" })).body.data!
    const onTask = (await rest("POST", `/${on.id}/tasks`, { title: "Planned work" })).body.data!
    const offTask = (await rest("POST", `/${off.id}/tasks`, { title: "Plain work" })).body.data!
    await db.execute(drizzleSql`
      UPDATE app_projects.tasks SET timebox_minutes = 720, is_milestone = true
       WHERE id = ${onTask.id}::uuid`)
    const member = await colleague()
    // Two people's time on the task, each said by its author through the tool route: the
    // reader gets the total, never anyone's row.
    const took = async (bearer: string, time: string) => {
      const res = await app.request("/api/apps/run-tool", {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          toolName: "projects:task_time_set",
          params: { taskId: onTask.id, time },
        }),
      })
      expect(res.status, await res.clone().text()).toBe(200)
    }
    await took(owner.bearer, "1h30")
    await minimal.grantScope(member.userId, "projects:tasks:write")
    await took((await minimal.sessionOf({ id: member.userId, orgId })).bearer, "30 min")
    const reader = await minimal.sessionOf({ id: member.userId, orgId })
    const read = (await as(reader.bearer, "GET", `/${on.id}/tasks/${onTask.id}`)).body.data!
    expect(read.timeboxMinutes).toBe(720)
    expect(read.realTotalMinutes).toBe(120)
    expect(read.isMilestone).toBe(true)
    const text = JSON.stringify(read)
    expect(text).not.toContain('"userId"')
    expect(text).not.toMatch(/"minutes":(90|30)\b/)

    const listed = (await as(reader.bearer, "GET", `/${on.id}/tasks`)).body.data!.items as any[]
    expect(listed.find((t) => t.id === onTask.id)?.realTotalMinutes).toBe(120)

    const plain = (await as(reader.bearer, "GET", `/${off.id}/tasks/${offTask.id}`)).body.data!
    for (const k of TIME_KEYS) expect(Object.hasOwn(plain, k)).toBe(false)
    const plainList = (await as(reader.bearer, "GET", `/${off.id}/tasks`)).body.data!.items as any[]
    for (const k of TIME_KEYS) expect(Object.hasOwn(plainList[0], k)).toBe(false)

    // The edit answers with the keys too, so the open task keeps them.
    const patched = (
      await rest("PATCH", `/${on.id}/tasks/${onTask.id}`, { title: "Planned work 2" })
    ).body.data!
    expect(patched.timeboxMinutes).toBe(720)
  })

  it("the cross-project task lists carry Planned only on the rows of a project using it", async () => {
    const on = (await rest("POST", "", { name: "List on", timeBudgets: true })).body.data!
    const off = (await rest("POST", "", { name: "List off" })).body.data!
    const a = (await rest("POST", `/${on.id}/tasks`, { title: "Sized", assigneeId: owner.userId }))
      .body.data!
    const b = (
      await rest("POST", `/${off.id}/tasks`, { title: "Unsized", assigneeId: owner.userId })
    ).body.data!
    await db.execute(drizzleSql`
      UPDATE app_projects.tasks SET timebox_minutes = 240 WHERE id = ${a.id}::uuid`)
    const { listTasksAcrossProjects, listProjectTasks } = await import("./tasks")
    const { withRlsContext } = await import("~/db/rls")
    const actor = {
      actorType: "user" as const,
      userId: owner.userId,
      orgId,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    }
    const mine = await withRlsContext(actor, (tx) =>
      listTasksAcrossProjects({ tx: tx as never, orgId, assigneeId: owner.userId }),
    )
    const rowA = mine.items.find((t) => t.id === a.id) as Record<string, unknown> | undefined
    const rowB = mine.items.find((t) => t.id === b.id) as Record<string, unknown> | undefined
    expect(rowA?.timeboxMinutes).toBe(240)
    expect(rowA?.realTotalMinutes).toBe(0)
    for (const k of TIME_KEYS) expect(Object.hasOwn(rowB ?? {}, k)).toBe(false)
    const ofOff = await withRlsContext(actor, (tx) =>
      listProjectTasks({ tx: tx as never, orgId, projectId: off.id }),
    )
    for (const k of TIME_KEYS) expect(Object.hasOwn(ofOff.items[0] ?? {}, k)).toBe(false)
  })

  it("the plan reads back its basis, biller and dated hours, and its rate only with the money scope", async () => {
    const on = (await rest("POST", "", { name: "Plan read", timeBudgets: true })).body.data!
    const { setTimePlan, setBillingTerms } = await import("./time-plan")
    const { withRlsContext } = await import("~/db/rls")
    const actor = {
      actorType: "user" as const,
      userId: owner.userId,
      orgId,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    }
    await withRlsContext(actor, async (tx) => {
      await setTimePlan({
        tx: tx as never,
        orgId,
        actorId: owner.userId,
        scopes: ["*"],
        input: { projectId: on.id, basis: "hourly", billerId: owner.userId, datedHours: true },
      })
      await setBillingTerms({
        tx: tx as never,
        orgId,
        scopes: ["*"],
        input: { projectId: on.id, rate: 95, currency: "EUR" },
      })
    })
    const full = await rest("GET", `/${on.id}/time-plan`)
    expect(full.status).toBe(200)
    expect(full.body.data).toMatchObject({
      basis: "hourly",
      billerId: owner.userId,
      datedHours: true,
      rate: 95,
      fixedPrice: null,
      currency: "EUR",
    })
    expect(typeof full.body.data?.billerName).toBe("string")

    const member = await colleague()
    const hoursOnly = (await as(member.bearer, "GET", `/${on.id}/time-plan`)).body.data!
    expect(hoursOnly.basis).toBe("hourly")
    for (const k of ["rate", "fixedPrice", "currency"]) {
      expect(Object.hasOwn(hoursOnly, k)).toBe(false)
    }

    const off = (await rest("POST", "", { name: "Plan off" })).body.data!
    const refused = await rest("GET", `/${off.id}/time-plan`)
    expect(refused.status).toBe(409)
    expect(refused.body.error?.code).toBe("planning_off")
  })
})

describe("the daily sweep heals the org row", () => {
  it("a lost recompute is corrected both ways from the projects' switches", async () => {
    // A project on with the org row off: the recompute after its commit was lost.
    await db.execute(drizzleSql`
      UPDATE kernel.org_app_features SET enabled = false
       WHERE org_id = ${orgId}::uuid AND app_name = 'projects' AND feature = 'time_budgets'`)
    const anyOn = extractRows<{ on: boolean }>(
      await db.execute(drizzleSql`
        SELECT EXISTS (SELECT 1 FROM app_projects.projects
          WHERE org_id = ${orgId}::uuid AND kind = 'work' AND time_budgets_on) AS on`),
    )[0]?.on
    expect(anyOn).toBe(true)
    const healed = await healTimeBudgets()
    expect(healed.corrected).toContain(orgId)
    expect(await orgRow()).toBe(true)

    // Every project off with the org row still on.
    await db.execute(drizzleSql`
      UPDATE app_projects.projects SET time_budgets_on = false WHERE org_id = ${orgId}::uuid`)
    await healTimeBudgets()
    expect(await orgRow()).toBe(false)

    // Nothing to correct: a second pass changes nothing.
    const again = await healTimeBudgets()
    expect(again.corrected).not.toContain(orgId)
  })

  it("the hourly sweep heals only at its hour of the day", async () => {
    await db.execute(drizzleSql`
      UPDATE app_projects.projects SET time_budgets_on = true
       WHERE org_id = ${orgId}::uuid AND kind = 'work'`)
    const notYet = new Date(Date.UTC(2026, 10, 13, (HEAL_HOUR_UTC + 1) % 24, 13))
    await runReconcileSweep(notYet)
    expect(await orgRow()).toBe(false)
    await runReconcileSweep(new Date(Date.UTC(2026, 10, 13, HEAL_HOUR_UTC, 13)))
    expect(await orgRow()).toBe(true)
  })

  it("reads only the switch state: the sweep's module reads no time, task or message rows", async () => {
    const source = await Bun.file(new URL("./reconcile-sweep.ts", import.meta.url)).text()
    // It touches task_time only to re-point a row to its task's project, never its minutes.
    expect(source).not.toMatch(/minutes|messages|attention_events|work_date/)
  })
})
