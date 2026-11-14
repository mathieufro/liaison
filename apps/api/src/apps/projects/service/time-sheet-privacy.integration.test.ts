// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a project's dated sheet may show of people's own time, on the real
// database, through the same doors people and agents use: an entry joins the
// sheet only when it was made on a project using dated hours, after they were
// turned on. Entries made before, earlier the same day or in an org east of
// UTC, and entries that come over with a task moved or merged from a project
// without dated hours, stay their author's alone. Moves and merges carry the
// rows in the mover's own transaction, and a merge never drops minutes.

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
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { moveTask } from "./move-task"
import { awaitTimeFeatureSync } from "./time-feature"
import { awaitTimeRowWrites } from "./time-rows"

let orgId = ""
let admin: minimal.Session
let ana: minimal.Session
let leo: minimal.Session
let finance: minimal.Session

const MEMBER = ["projects:projects:read", "projects:tasks:read", "projects:tasks:write"]
const LEAD = [...MEMBER, "projects:projects:write"]
const FINANCE = [...MEMBER, "projects:timesheet:read"]

function actorOf(userId: string, scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function call<T = Record<string, any>>(
  method: string,
  input: unknown,
  who: { userId: string; scopes: string[] },
): Promise<T> {
  const a = actorOf(who.userId, who.scopes)
  const out = await runContextStore.run({} as never, () =>
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
  await awaitTimeRowWrites()
  return out
}

const asAdmin = () => ({ userId: admin.userId, scopes: ["*"] })
const asAna = () => ({ userId: ana.userId, scopes: MEMBER })
const asLeo = () => ({ userId: leo.userId, scopes: LEAD })
const asFinance = () => ({ userId: finance.userId, scopes: FINANCE })

async function newProject(
  name: string,
  who: { userId: string; scopes: string[] },
  dated: boolean,
): Promise<string> {
  const made = await call<{ id: string }>("projects_createProject", { name }, who)
  await call("projects_updateProject", { projectId: made.id, timeBudgets: true }, who)
  await awaitTimeFeatureSync(orgId)
  if (dated) await call("projects_timePlanSet", { projectId: made.id, datedHours: true }, who)
  return made.id
}

async function newTask(projectId: string, title: string): Promise<string> {
  return (await call<{ id: string }>("projects_createTask", { projectId, title }, asAdmin())).id
}

/** Ana's rows as `who` reads them under their own row policies. */
async function anaRowsSeenBy(who: { userId: string; scopes: string[] }, taskId: string) {
  return withRlsContext(actorOf(who.userId, who.scopes), async (tx) =>
    extractRows<{ id: string; minutes: number }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, minutes FROM app_projects.task_time
         WHERE user_id = ${ana.userId}::uuid AND task_id = ${taskId}::uuid ORDER BY work_date`),
    ),
  )
}

const rowsOf = async (taskId: string) =>
  extractRows<{ id: string; project_id: string; minutes: number; user_id: string }>(
    await db.execute(drizzleSql`
      SELECT id::text AS id, project_id::text AS project_id, minutes, user_id::text AS user_id
        FROM app_projects.task_time WHERE task_id = ${taskId}::uuid ORDER BY work_date, id`),
  )

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  // An org east of UTC: its day starts hours before the UTC day does.
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET timezone = 'Asia/Tokyo' WHERE id = ${orgId}::uuid`,
  )
  admin = await minimal.adminSession(orgId)
  ana = await minimal.session(orgId, { role: "member" })
  leo = await minimal.session(orgId, { role: "member" })
  finance = await minimal.session(orgId, { role: "member" })
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("a task moved or merged into a dated project", () => {
  it("keeps the time entered on a project without dated hours private to its author after a move", async () => {
    const plain = await newProject("Plain board", asAdmin(), false)
    const dated = await newProject("Leo's dated board", asLeo(), true)
    const taskId = await newTask(plain, "Wireframes")
    await call("projects_taskTimeSet", { taskId, time: "6 h" }, asAna())
    await call("projects_moveTask", { taskId, projectId: dated }, asLeo())
    expect((await rowsOf(taskId)).map((r) => r.project_id)).toEqual([dated])
    expect(await anaRowsSeenBy(asLeo(), taskId)).toEqual([])
    expect(await anaRowsSeenBy(asFinance(), taskId)).toEqual([])
    expect((await anaRowsSeenBy(asAna(), taskId)).map((r) => r.minutes)).toEqual([360])
    const refused = await call<{ error?: { code: string } }>(
      "projects_taskTimeCorrect",
      { entryId: (await rowsOf(taskId))[0]!.id, time: "1 h" },
      asLeo(),
    )
    expect(refused.error?.code).toBe("not_found")
  })

  it("keeps the time entered on a project without dated hours private to its author after a merge", async () => {
    const plain = await newProject("Plain merge board", asAdmin(), false)
    const dated = await newProject("Leo's merge board", asLeo(), true)
    const source = await newTask(plain, "Logo sketches")
    const target = await newTask(dated, "Logo")
    await call("projects_taskTimeSet", { taskId: source, time: "4 h" }, asAna())
    await call("projects_mergeTasks", { sourceId: source, targetId: target }, asLeo())
    expect((await rowsOf(target)).map((r) => r.minutes)).toEqual([240])
    expect(await anaRowsSeenBy(asLeo(), target)).toEqual([])
    expect(await anaRowsSeenBy(asFinance(), target)).toEqual([])
  })

  it("a row entered on the dated sheet stays on it when its task moves within dated projects", async () => {
    const a = await newProject("Dated A", asLeo(), true)
    const b = await newProject("Dated B", asLeo(), true)
    const taskId = await newTask(a, "Shared work")
    await call("projects_taskTimeSet", { taskId, time: "2 h" }, asAna())
    expect((await anaRowsSeenBy(asLeo(), taskId)).map((r) => r.minutes)).toEqual([120])
    await call("projects_moveTask", { taskId, projectId: b }, asLeo())
    expect((await anaRowsSeenBy(asLeo(), taskId)).map((r) => r.minutes)).toEqual([120])
  })
})

describe("the moment dated hours are turned on", () => {
  it("an entry made earlier the same day stays private, one made after joins the sheet", async () => {
    const proj = await newProject("Same day board", asLeo(), false)
    const before = await newTask(proj, "Morning work")
    const after = await newTask(proj, "Afternoon work")
    await call("projects_taskTimeSet", { taskId: before, time: "3 h" }, asAna())
    await call("projects_timePlanSet", { projectId: proj, datedHours: true }, asLeo())
    await call("projects_taskTimeSet", { taskId: after, time: "2 h" }, asAna())
    expect(await anaRowsSeenBy(asLeo(), before)).toEqual([])
    expect(await anaRowsSeenBy(asFinance(), before)).toEqual([])
    expect((await anaRowsSeenBy(asLeo(), after)).map((r) => r.minutes)).toEqual([120])
  })

  it("compares the instant of the entry with the instant of the switch, whatever the work date", async () => {
    // Dated hours turned on at 00:30 local time on the 11th in an org at UTC+1,
    // which is 23:30 UTC on the 10th. Rows of the local 10th were all entered before.
    const proj = await newProject("Midnight board", asLeo(), true)
    const early = await newTask(proj, "Late evening")
    const late = await newTask(proj, "Next morning")
    await call("projects_taskTimeSet", { taskId: early, time: "1 h" }, asAna())
    await call("projects_taskTimeSet", { taskId: late, time: "1 h" }, asAna())
    await db.execute(drizzleSql`
      UPDATE app_projects.project_time_plan
         SET dated_hours_changed_at = '2026-11-10T23:30:00Z'
       WHERE project_id = ${proj}::uuid`)
    await db.execute(drizzleSql`
      UPDATE app_projects.task_time SET work_date = '2026-11-10', created_at = '2026-11-10T20:00:00Z'
       WHERE task_id = ${early}::uuid`)
    await db.execute(drizzleSql`
      UPDATE app_projects.task_time SET work_date = '2026-11-11', created_at = '2026-11-11T07:00:00Z'
       WHERE task_id = ${late}::uuid`)
    expect(await anaRowsSeenBy(asLeo(), early)).toEqual([])
    expect((await anaRowsSeenBy(asLeo(), late)).map((r) => r.minutes)).toEqual([60])
  })

  it("a person cannot choose when their entry was made or put it on the sheet", async () => {
    const proj = await newProject("Own row board", asLeo(), false)
    const taskId = await newTask(proj, "Own row")
    await call("projects_taskTimeSet", { taskId, time: "1 h" }, asAna())
    await call("projects_timePlanSet", { projectId: proj, datedHours: true }, asLeo())
    await withRlsContext(actorOf(ana.userId, MEMBER), (tx) =>
      tx.execute(drizzleSql`
        UPDATE app_projects.task_time SET entered_dated = true, created_at = now() + interval '1 day'
         WHERE task_id = ${taskId}::uuid AND user_id = ${ana.userId}::uuid`),
    )
    expect(await anaRowsSeenBy(asLeo(), taskId)).toEqual([])
  })

  it("a lead cannot move the switch time by writing the plan directly", async () => {
    const proj = await newProject("Switch time board", asLeo(), true)
    const stamp = async () =>
      extractRows<{ at: string }>(
        await db.execute(drizzleSql`
          SELECT dated_hours_changed_at::text AS at FROM app_projects.project_time_plan
           WHERE project_id = ${proj}::uuid`),
      )[0]?.at
    const set = await stamp()
    await withRlsContext(actorOf(leo.userId, LEAD), (tx) =>
      tx.execute(drizzleSql`
        UPDATE app_projects.project_time_plan SET dated_hours_changed_at = '2020-01-01T00:00:00Z'
         WHERE project_id = ${proj}::uuid`),
    )
    expect(await stamp()).toBe(set)
    await withRlsContext(actorOf(leo.userId, LEAD), (tx) =>
      tx.execute(drizzleSql`
        UPDATE app_projects.project_time_plan
           SET dated_hours = false, dated_hours_changed_at = '2020-01-01T00:00:00Z'
         WHERE project_id = ${proj}::uuid`),
    )
    const off = await stamp()
    expect(off).not.toBe("2020-01-01 00:00:00+00")
    expect(Date.parse(String(off))).toBeGreaterThanOrEqual(Date.parse(String(set)))
  })
})

describe("moves and merges through every door", () => {
  it("a move made as the board makes it re-points the rows in the same transaction", async () => {
    const a = await newProject("Board move A", asLeo(), true)
    const b = await newProject("Board move B", asLeo(), true)
    const taskId = await newTask(a, "Dragged card")
    await call("projects_taskTimeSet", { taskId, time: "2 h" }, asAna())
    await withRlsContext(actorOf(leo.userId, LEAD), async (tx) => {
      await moveTask({
        tx,
        orgId,
        actor: actorOf(leo.userId, LEAD),
        projectId: a,
        taskId,
        targetProjectId: b,
      } as never)
      const inTx = extractRows<{ project_id: string }>(
        await tx.execute(drizzleSql`
          SELECT project_id::text AS project_id FROM app_projects.task_time
           WHERE task_id = ${taskId}::uuid`),
      )
      expect(inTx.map((r) => r.project_id)).toEqual([b])
    })
    expect((await rowsOf(taskId)).map((r) => r.project_id)).toEqual([b])
  })

  it("a merge into a project without dated hours adds a person's time into one row and loses no minute", async () => {
    const proj = await newProject("Fold board", asAdmin(), false)
    const source = await newTask(proj, "Fold source")
    const target = await newTask(proj, "Fold target")
    await call("projects_taskTimeSet", { taskId: source, time: "2 h" }, asAna())
    await call("projects_taskTimeSet", { taskId: target, time: "1h30" }, asAna())
    await call("projects_mergeTasks", { sourceId: source, targetId: target }, asAdmin())
    expect((await rowsOf(target)).map((r) => r.minutes)).toEqual([210])
    expect(await rowsOf(source)).toEqual([])
  })

  it("a merge that would pass the most one entry holds is refused and changes nothing", async () => {
    const proj = await newProject("Full board", asAdmin(), false)
    const source = await newTask(proj, "Full source")
    const target = await newTask(proj, "Full target")
    await call("projects_taskTimeSet", { taskId: source, time: "20 h" }, asAna())
    await call("projects_taskTimeSet", { taskId: target, time: "730 h" }, asAna())
    const refused = await call(
      "projects_mergeTasks",
      { sourceId: source, targetId: target },
      asAdmin(),
    )
      .then(() => null)
      .catch((err: { code?: string; message?: string }) => err)
    expect(refused?.code).toBe("time_over_limit")
    expect(refused?.message).toMatch(/^Nothing was merged/)
    expect((await rowsOf(source)).map((r) => r.minutes)).toEqual([1200])
    expect((await rowsOf(target)).map((r) => r.minutes)).toEqual([43800])
    const live = extractRows<{ archived: boolean }>(
      await db.execute(drizzleSql`
        SELECT archived_at IS NOT NULL AS archived FROM app_projects.tasks WHERE id = ${source}::uuid`),
    )
    expect(live[0]?.archived).toBe(false)
  })

  it("minutes merged on a project without dated hours stay private when dated hours are turned on later", async () => {
    const proj = await newProject("Later dated board", asLeo(), false)
    const source = await newTask(proj, "Early source")
    const target = await newTask(proj, "Early target")
    await call("projects_taskTimeSet", { taskId: source, time: "2 h" }, asAna())
    await call("projects_mergeTasks", { sourceId: source, targetId: target }, asLeo())
    await call("projects_timePlanSet", { projectId: proj, datedHours: true }, asLeo())
    expect(await anaRowsSeenBy(asLeo(), target)).toEqual([])
  })
})

describe("dates given to Took and to a correction", () => {
  it("a date that does not exist, a future date or another entry's day is refused with a reason", async () => {
    const proj = await newProject("Dates board", asLeo(), true)
    const taskId = await newTask(proj, "Dated task")
    const bad = await call<{ error?: { code: string } }>(
      "projects_taskTimeSet",
      { taskId, time: "1 h", date: "2026-02-30" },
      asAna(),
    )
    expect(bad.error?.code).toBe("invalid_date")
    await call("projects_taskTimeSet", { taskId, time: "1 h", date: "2026-11-02" }, asAna())
    await call("projects_taskTimeSet", { taskId, time: "2 h", date: "2026-11-03" }, asAna())
    const entryId = (await rowsOf(taskId))[0]!.id
    for (const [date, code] of [
      ["2026-02-30", "invalid_date"],
      ["tomorrow", "invalid_date"],
      ["2999-01-01", "future_date"],
      ["2026-11-03", "entry_exists"],
    ] as const) {
      const out = await call<{ error?: { code: string; message: string } }>(
        "projects_taskTimeCorrect",
        { entryId, time: "3 h", date },
        asLeo(),
      )
      expect(out.error?.code).toBe(code)
      expect(out.error?.message).toMatch(/^Nothing (was )?changed/)
    }
    expect((await rowsOf(taskId)).map((r) => r.minutes)).toEqual([60, 120])
  })
})
