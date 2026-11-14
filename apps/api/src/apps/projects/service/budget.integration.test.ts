// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `budget_get` through the projects bridge on the real database: planned time against real
// time, coverage, the money scope, the period a retainer reads and the gap before a project
// used time and budgets.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { resolveToolCard } from "~/modules/apps/result-card"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { createDashboard, getBlockData } from "~/modules/dashboards/service"
import { seedContext } from "~/seed/context"
import { seedTaskTime } from "~/seed/factories/projects/time"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { awaitTimeFeatureSync } from "./time-feature"
import { awaitTimeRowWrites } from "./time-rows"
import { todayIn } from "./took"

let orgId = ""
let owner: minimal.Session
let member: minimal.Session

function actorOf(userId: string, scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function call<T = Record<string, any>>(
  method: string,
  input: unknown,
  opts: { userId?: string; scopes?: string[] } = {},
): Promise<T> {
  const a = actorOf(opts.userId ?? owner.userId, opts.scopes)
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
      { origin: "human-ui" } as never,
    )
    return JSON.parse(await bridge[method](JSON.stringify(input))) as T
  })
  await awaitTimeRowWrites()
  return out
}

async function newProject(name: string, on = true): Promise<string> {
  const made = await call<{ id: string }>("projects_createProject", { name })
  if (on) {
    await call("projects_updateProject", { projectId: made.id, timeBudgets: true })
    await awaitTimeFeatureSync(orgId)
  }
  return made.id
}

async function newTask(
  projectId: string,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const t = await call<{ id: string }>("projects_createTask", { projectId, title, ...extra })
  if (!t.id) throw new Error(`task not created: ${JSON.stringify(t)}`)
  return t.id
}

/** Real minutes on a task, entered as the owner on a given day. */
async function enter(projectId: string, taskId: string, minutes: number, date?: string) {
  await seedTaskTime(seedContext({ orgId, now: new Date() }), actorOf(owner.userId), [
    { taskId, projectId, workDate: date ?? todayIn("UTC"), minutes },
  ])
}

const hours = (h: number) => h * 60

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET timezone = 'UTC' WHERE id = ${orgId}::uuid`,
  )
  owner = await minimal.adminSession(orgId)
  member = await minimal.session(orgId, { role: "member" })
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("a fixed-price project with milestones", () => {
  let projectId = ""
  let delorme: Record<string, any> = {}

  beforeAll(async () => {
    projectId = await newProject("Maison Delorme portal")
    await call("projects_billingTermsSet", { projectId, fixedPrice: 64000, currency: "EUR" })
    // Four milestones planned 52, 78, 200 and 90 hours, over 7, 11, 20 and 12 tasks.
    const plan = [
      { name: "Discovery", box: "52 h", tasks: 7, doneNoTime: 0, real: 48, started: 0, todo: 0 },
      { name: "Design", box: "78 h", tasks: 11, doneNoTime: 0, real: 81, started: 0, todo: 0 },
      // Beta: 16 done (3 with no time) and 4 open (3 in progress with time, 1 todo).
      { name: "Beta", box: "200 h", tasks: 20, doneNoTime: 3, real: 189, started: 3, todo: 1 },
      // Launch: 7 done and 5 open (2 in progress without time, 3 todo).
      { name: "Launch", box: "90 h", tasks: 12, doneNoTime: 0, real: 28, started: 2, todo: 3 },
    ]
    for (const m of plan) {
      const milestoneId = await newTask(projectId, m.name, { timebox: m.box, isMilestone: true })
      const open = m.started + m.todo
      const done = m.tasks - open
      const timed: string[] = []
      for (let i = 0; i < m.tasks; i++) {
        const isDone = i < done
        const status = isDone ? "done" : i < done + m.started ? "in_progress" : "todo"
        const id = await newTask(projectId, `${m.name} ${i + 1}`, {
          parentTaskId: milestoneId,
          statusLabel: status,
        })
        const noTime = (isDone && i >= done - m.doneNoTime) || (!isDone && m.name === "Launch")
        if (!noTime && (isDone || status === "in_progress")) timed.push(id)
      }
      const total = hours(m.real)
      const each = Math.floor(total / timed.length)
      for (const [i, id] of timed.entries()) {
        await enter(
          projectId,
          id,
          i === timed.length - 1 ? total - each * (timed.length - 1) : each,
        )
      }
    }
    delorme = await call("projects_budgetGet", { projectId })
  }, 300_000)

  it("a fixed-price project with milestones 52, 78, 200 and 90 hours and 346 real reads 420, 346, 74 left, partial, 41 of 46", () => {
    expect(delorme.error).toBeUndefined()
    expect(delorme.timebox).toBe(hours(420))
    expect(delorme.real).toBe(hours(346))
    expect(delorme.left).toBe(hours(74))
    expect(delorme.partial).toBe(true)
    expect(delorme.coverage).toEqual({ withEntries: 41, total: 46 })
    expect(delorme.line).toBe(
      "346 h real of 420 h planned, 74 h left. Partial: real time entered on 41 of 46 tasks.",
    )
    expect(delorme.milestones.map((m: any) => [m.name, m.plannedMinutes, m.realMinutes])).toEqual([
      ["Discovery", hours(52), hours(48)],
      ["Design", hours(78), hours(81)],
      ["Beta", hours(200), hours(189)],
      ["Launch", hours(90), hours(28)],
    ])
    expect(delorme.money).toEqual({ price: 64000, currency: "EUR" })
    expect(delorme.state).toBeUndefined()
  })

  it("without money scope the answer has no money key", async () => {
    const out = await call(
      "projects_budgetGet",
      { projectId },
      { userId: member.userId, scopes: ["projects:projects:read"] },
    )
    expect(out.error).toBeUndefined()
    expect(out.real).toBe(hours(346))
    expect(out.state).toBe("hours-only")
    expect(JSON.stringify(out)).not.toMatch(/money|price|64000|EUR/)
    expect(out.totals.map((t: any) => t.k)).toEqual(["Planned", "Real", "Left"])
  })

  it("a set whole-project timebox wins the line and milestones keep their own", async () => {
    await call("projects_timePlanSet", { projectId, timebox: "300 h" })
    const out = await call("projects_budgetGet", { projectId })
    expect(out.timebox).toBe(hours(300))
    expect(out.left).toBe(hours(300 - 346))
    expect(out.line).toContain("346 h real against a 300 h timebox, 46 h over.")
    expect(out.milestones.map((m: any) => m.plannedMinutes)).toEqual([
      hours(52),
      hours(78),
      hours(200),
      hours(90),
    ])
    await call("projects_timePlanSet", { projectId, timebox: null })
  })

  it("the budget card resolves with the app bundle not loaded and stays under its bound", () => {
    const template = (projectsAppManifest as any).tools.budget_get.resultCard
    const card = resolveToolCard(template, delorme)
    expect(card).not.toBeNull()
    expect(card?.kind).toBe("groups")
    expect(card?.title).toBe(delorme.line)
    expect(card?.cover).toBe("Real time entered on 41 of 46 tasks")
    expect(card?.status?.label.label).toBe("partial")
    expect(card?.groups?.[0]?.rows.map((r) => r.name)).toEqual([
      "Discovery",
      "Design",
      "Beta",
      "Launch",
    ])
    expect(card?.tot?.map((t) => [t.k, t.v])).toEqual([
      ["Planned", "420 h"],
      ["Real", "346 h"],
      ["Left", "74 h"],
      ["Price", "€64,000.00"],
    ])
    expect(new TextEncoder().encode(JSON.stringify(card)).length).toBeLessThan(24_576)
  })

  it("a dashboard block on budget_get saves and runs", async () => {
    const viewer = actorOf(owner.userId)
    const d = await createDashboard(viewer, {
      title: "Milestones",
      visibility: "personal",
      spec: {
        v: 1,
        blocks: [
          {
            id: "b",
            type: "metric",
            title: "Milestones",
            source: {
              kind: "tool",
              tool: "projects:budget_get",
              params: { projectId },
              rowsPath: "milestones",
            },
            map: { agg: "count" },
          },
        ],
      },
    } as never)
    expect(await getBlockData(viewer, d.id, "b")).toMatchObject({
      ok: true,
      data: { kind: "metric", value: 4 },
    })
  })
})

describe("the line", () => {
  it("a parent's own timebox counts and its descendants' do not add to it", async () => {
    const projectId = await newProject("Studio nesting")
    const parent = await newTask(projectId, "Parent", { timebox: "10 h" })
    await newTask(projectId, "Child", { parentTaskId: parent, timebox: "4 h" })
    await newTask(projectId, "Sibling", { timebox: "2 h" })
    const out = await call("projects_budgetGet", { projectId })
    expect(out.timebox).toBe(hours(12))
  })

  it("a Took entry shows on the next read", async () => {
    const projectId = await newProject("Studio next read")
    const taskId = await newTask(projectId, "Draft", { statusLabel: "in_progress" })
    expect((await call("projects_budgetGet", { projectId })).real).toBe(0)
    await call("projects_taskTimeSet", { taskId, time: "2 h" })
    const after = await call("projects_budgetGet", { projectId })
    expect(after.real).toBe(hours(2))
    expect(after.coverage).toEqual({ withEntries: 1, total: 1 })
    expect(after.partial).toBe(false)
    expect(after.line).not.toContain("Partial")
  })

  it("a retainer, a daily project, a fixed price over its timebox and a project with no timebox read as described", async () => {
    const today = todayIn("UTC")
    const month = today.slice(0, 7)
    const monthName = new Date(`${month}-01T12:00:00Z`).toLocaleString("en-GB", {
      month: "long",
      timeZone: "UTC",
    })
    const lastMonth = new Date(`${month}-01T12:00:00Z`)
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1)

    const retainer = await newProject("Studio retainer")
    const rTask = await newTask(retainer, "Support", { statusLabel: "done" })
    await call("projects_timePlanSet", { projectId: retainer, basis: "retainer" })
    await call("projects_periodTimeboxSet", { projectId: retainer, month, timebox: "40 h" })
    await enter(retainer, rTask, hours(18))
    // Last month's hours are outside the period and not in it.
    const earlier = await newTask(retainer, "Earlier", { statusLabel: "done" })
    await enter(retainer, earlier, hours(5), `${lastMonth.toISOString().slice(0, 7)}-15`)
    expect((await call("projects_budgetGet", { projectId: retainer })).line).toContain(
      `${monthName} so far 18 of 40 h.`,
    )

    const daily = await newProject("Studio daily")
    const dTask = await newTask(daily, "Build", { statusLabel: "done" })
    await call("projects_timePlanSet", { projectId: daily, basis: "daily" })
    await call("projects_periodTimeboxSet", { projectId: daily, month, timebox: "7 days" })
    await enter(daily, dTask, 3.5 * 420)
    const dailyOut = await call("projects_budgetGet", { projectId: daily })
    expect(dailyOut.line).toContain(`${monthName} so far 3.5 of 7 d.`)
    expect(dailyOut.timebox).toBe(7 * 420)
    expect(dailyOut.real).toBe(3.5 * 420)
    // No price yet: no money key, so the panel says no price is set.
    expect(dailyOut.money).toBeUndefined()
    await call("projects_billingTermsSet", { projectId: daily, rate: 930, currency: "EUR" })
    const rated = await call("projects_budgetGet", { projectId: daily })
    expect(rated.money).toEqual({ rate: 930, per: "day", currency: "EUR" })
    expect(rated.totals.find((t: any) => t.k === "Rate")?.text).toBe("€930.00 a day")
    expect(rated.totals.find((t: any) => t.k === "Price")).toBeUndefined()

    const fixed = await newProject("Studio fixed")
    const fTask = await newTask(fixed, "Ship", { statusLabel: "done" })
    await call("projects_timePlanSet", { projectId: fixed, basis: "fixed", timebox: "180 h" })
    await enter(fixed, fTask, hours(212))
    expect((await call("projects_budgetGet", { projectId: fixed })).line).toBe(
      "212 h real against a 180 h timebox, 32 h over. The price does not change.",
    )

    const bare = await newProject("Studio bare")
    const bTask = await newTask(bare, "Think", { statusLabel: "done" })
    await enter(bare, bTask, hours(3))
    const bareOut = await call("projects_budgetGet", { projectId: bare })
    expect(bareOut.line).toBe("Nothing to compare: no timebox is set. 3 h real so far.")
    expect(bareOut.timebox).toBeUndefined()
    expect(bareOut.left).toBeUndefined()
  })

  it("an archived task's time is not counted and is said not to be", async () => {
    const projectId = await newProject("Studio archive")
    const kept = await newTask(projectId, "Kept", { statusLabel: "done" })
    const gone = await newTask(projectId, "Gone", { statusLabel: "done" })
    await enter(projectId, kept, hours(2))
    await enter(projectId, gone, hours(5))
    await db.execute(
      drizzleSql`UPDATE app_projects.tasks SET archived_at = now() WHERE id = ${gone}::uuid`,
    )
    const out = await call("projects_budgetGet", { projectId })
    expect(out.real).toBe(hours(2))
    expect(out.coverage).toEqual({ withEntries: 1, total: 1 })
    expect(out.notInNumbers[0].text).toContain("5 h entered on archived tasks is not counted")
  })

  it("a cancelled task and a task not started are not in coverage", async () => {
    const projectId = await newProject("Studio coverage")
    await newTask(projectId, "Waiting", { statusLabel: "todo" })
    await newTask(projectId, "Dropped", { statusLabel: "cancelled" })
    const live = await newTask(projectId, "Underway", { statusLabel: "in_progress" })
    await enter(projectId, live, hours(1))
    expect((await call("projects_budgetGet", { projectId })).coverage).toEqual({
      withEntries: 1,
      total: 1,
    })
  })

  it("a project without time and budgets answers planning_off and reads nothing", async () => {
    const projectId = await newProject("Studio off", false)
    const out = await call("projects_budgetGet", { projectId })
    expect(out.error?.code).toBe("planning_off")
    expect(out.real).toBeUndefined()
  })
})

describe("a project turned on after tasks closed", () => {
  it("a project turned on after tasks closed says so and lowers nothing", async () => {
    const early = await newProject("Studio late start", false)
    const a = await newTask(early, "Closed before", { statusLabel: "done" })
    await newTask(early, "Also closed before", { statusLabel: "done" })
    await call("projects_updateProject", { projectId: early, timeBudgets: true })
    await awaitTimeFeatureSync(orgId)
    const out = await call("projects_budgetGet", { projectId: early })
    expect(out.offUntil).toBe(todayIn("UTC"))
    expect(out.notInNumbers[0].text).toContain("This project did not use time and budgets until")
    expect(out.notInNumbers[0].text).toContain("so earlier tasks may have no time spent.")
    // The figures are the same as for a project that always used it: both tasks still count.
    expect(out.coverage).toEqual({ withEntries: 0, total: 2 })
    await enter(early, a, hours(1))
    const after = await call("projects_budgetGet", { projectId: early })
    expect(after.coverage).toEqual({ withEntries: 1, total: 2 })
    expect(after.real).toBe(hours(1))

    const always = await newProject("Studio always on")
    await newTask(always, "Closed after", { statusLabel: "done" })
    expect((await call("projects_budgetGet", { projectId: always })).offUntil).toBeUndefined()
  })
})

describe("what the result does not hold", () => {
  it("holds no person: no key names one beside the coverage", async () => {
    const projectId = await newProject("Studio nobody")
    const t = await newTask(projectId, "Work", { statusLabel: "done" })
    await enter(projectId, t, hours(1))
    const out = await call("projects_budgetGet", { projectId })
    const keys: string[] = []
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.push(k)
          walk(x)
        }
      }
    }
    walk(out)
    expect(keys.filter((k) => /user|person|member|assignee|author|people|who/i.test(k))).toEqual([])
    const rows = extractRows<{ n: number }>(
      await db.execute(
        drizzleSql`SELECT count(*)::int AS n FROM app_projects.task_time WHERE project_id = ${projectId}::uuid`,
      ),
    )
    expect(rows[0]?.n).toBe(1)
  })
})
