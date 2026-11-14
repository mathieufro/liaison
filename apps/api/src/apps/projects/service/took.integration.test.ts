// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Timeboxes, Took and the plan tools, driven through the projects bridge the
// agent's tools, the MCP gateway and the app reach, on the real database.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { createDashboard, getBlockData } from "~/modules/dashboards/service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { awaitTimeFeatureSync } from "./time-feature"
import { awaitTimeRowWrites } from "./time-rows"

type Origin = "in-app-agent" | "mcp" | "human-ui"

let orgId = ""
let owner: minimal.Session
let member: minimal.Session

function actorOf(userId: string, scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function call<T = Record<string, any>>(
  method: string,
  input: unknown,
  opts: {
    userId?: string
    scopes?: string[]
    origin?: Origin
    threadId?: string
    frame?: Record<string, unknown>
  } = {},
): Promise<T> {
  const a = actorOf(opts.userId ?? owner.userId, opts.scopes)
  const run = () =>
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
        {
          origin: opts.origin ?? "human-ui",
          ...(opts.threadId ? { threadId: opts.threadId } : {}),
        } as never,
      )
      return JSON.parse(await bridge[method](JSON.stringify(input))) as T
    })
  const out = opts.frame ? await runContextStore.run(opts.frame as never, run) : await run()
  await awaitTimeRowWrites()
  return out
}

async function newProject(name: string, on: boolean): Promise<string> {
  const made = await call<{ id: string }>("projects_createProject", { name })
  if (on) {
    await call("projects_updateProject", { projectId: made.id, timeBudgets: true })
    await awaitTimeFeatureSync(orgId)
  }
  return made.id
}

async function newTask(projectId: string, title: string): Promise<string> {
  const t = await call<{ id: string }>("projects_createTask", { projectId, title })
  return t.id
}

async function said(userId: string, text: string): Promise<string> {
  const threadId = await minimal.thread(orgId, userId)
  await minimal.postUserMessage(orgId, threadId, userId, text)
  return threadId
}

const rows = async (taskId: string) =>
  extractRows<{ user_id: string; minutes: number; work_date: string; entered_via: string }>(
    await db.execute(drizzleSql`
      SELECT user_id::text AS user_id, minutes, work_date::text AS work_date, entered_via
        FROM app_projects.task_time WHERE task_id = ${taskId}::uuid ORDER BY work_date`),
  )

async function setDated(projectId: string, on: boolean) {
  return call("projects_timePlanSet", { projectId, datedHours: on })
}

let on = ""
let off = ""

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  owner = await minimal.adminSession(orgId)
  member = await minimal.session(orgId, { role: "member" })
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
  on = await newProject("Atlas build", true)
  off = await newProject("Studio internal", false)
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("timebox on a task", () => {
  it("3 days stores 1260 minutes at 7 hours a day", async () => {
    const taskId = await newTask(on, "Design the flows")
    const out = await call("projects_updateTask", { taskId, timebox: "3 days" })
    expect(out.timeboxMinutes).toBe(1260)
    expect(out.realTotalMinutes).toBe(0)
    const created = await call("projects_createTask", {
      projectId: on,
      title: "Write the copy",
      timebox: "20 h",
      isMilestone: true,
    })
    expect(created.timeboxMinutes).toBe(1200)
    expect(created.isMilestone).toBe(true)
  })

  it("a timebox on a project without time and budgets refuses planning_off and writes nothing", async () => {
    const taskId = await newTask(off, "Tidy the wiki")
    const out = await call("projects_updateTask", { taskId, timebox: "2 h", title: "Renamed" })
    expect(out.error?.code).toBe("planning_off")
    const t = extractRows<{ title: string; timebox_minutes: number | null }>(
      await db.execute(drizzleSql`
        SELECT title, timebox_minutes FROM app_projects.tasks WHERE id = ${taskId}::uuid`),
    )[0]
    expect(t?.title).toBe("Tidy the wiki")
    expect(t?.timebox_minutes).toBeNull()
    const plain = await call("projects_updateTask", { taskId, title: "Tidy it" })
    expect(plain.error).toBeUndefined()
    expect("timeboxMinutes" in plain).toBe(false)
  })
})

describe("Took", () => {
  it("one row per person per task without dated hours, edit keeps the first date, clearing deletes", async () => {
    const taskId = await newTask(on, "Build the page")
    const first = await call("projects_taskTimeSet", { taskId, time: "2 h" })
    expect(first.minutes).toBe(120)
    expect(first.enteredVia).toBe("field")
    await db.execute(drizzleSql`
      UPDATE app_projects.task_time SET work_date = work_date - 3 WHERE task_id = ${taskId}::uuid`)
    const before = (await rows(taskId))[0]?.work_date
    const edit = await call("projects_taskTimeSet", { taskId, time: "1h30" })
    expect(edit.totalMinutes).toBe(90)
    const after = await rows(taskId)
    expect(after).toHaveLength(1)
    expect(after[0]?.work_date).toBe(before as string)
    const cleared = await call("projects_taskTimeSet", { taskId, time: null })
    expect(cleared.totalMinutes).toBe(0)
    expect(await rows(taskId)).toHaveLength(0)
  })

  it("text it cannot read stores nothing and says which forms it reads", async () => {
    const taskId = await newTask(on, "Unclear entry")
    const out = await call("projects_taskTimeSet", { taskId, time: "a while" })
    expect(out.error?.code).toBe("unreadable_time")
    expect(out.error?.message).toBe("Could not read this. Try 2 h, 1h30, half a day or 2 days.")
    expect(await rows(taskId)).toHaveLength(0)
  })

  it("with dated hours a date defaults to today in the org's zone and refuses the future", async () => {
    const dated = await newProject("Orbit dated", true)
    await setDated(dated, true)
    const taskId = await newTask(dated, "Dated work")
    const tz = extractRows<{ tz: string }>(
      await db.execute(
        drizzleSql`SELECT timezone AS tz FROM kernel.organizations WHERE id = ${orgId}::uuid`,
      ),
    )[0]?.tz as string
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date())
    const out = await call("projects_taskTimeSet", { taskId, time: "3 h" })
    expect(out.date).toBe(today)
    await call("projects_taskTimeSet", { taskId, time: "1 h", date: "2026-01-05" })
    expect(await rows(taskId)).toHaveLength(2)
    const future = await call("projects_taskTimeSet", { taskId, time: "1 h", date: "2999-01-01" })
    expect(future.error?.code).toBe("future_date")
    expect(await rows(taskId)).toHaveLength(2)
  })

  it("the tool has no user parameter", () => {
    const tool = (projectsAppManifest.tools as Record<string, any>).task_time_set
    const props = Object.keys(tool.params.properties)
    expect(props.sort()).toEqual(["date", "quote", "taskId", "time"])
    expect(tool.humanTurnOnly).toBe(true)
    expect(tool.sinkReadersSelf).toBe(true)
    expect(tool.contentParams).toEqual([])
    expect(tool.feature).toBe("time_budgets")
  })

  it("an agent without the person's words, with words not in the last message, or with a different figure is refused, and so is a routine or a sub-run", async () => {
    const taskId = await newTask(on, "Agent entry")
    const threadId = await said(owner.userId, "Log it: that took 2 h.")
    const frame = { humanTurn: true }
    const agent = { origin: "in-app-agent" as const, threadId, frame }
    const cases = [
      { time: "2 h" },
      { time: "2 h", quote: "it was 2 h" },
      { time: "3 h", quote: "took 2 h" },
    ]
    for (const c of cases) {
      const out = await call("projects_taskTimeSet", { taskId, ...c }, agent)
      expect(out.error?.code).toBe("needs_person_statement")
    }
    expect(await rows(taskId)).toHaveLength(0)
    for (const f of [{ routineId: "00000000-0000-4000-8000-000000000001" }, { background: true }]) {
      const out = await call(
        "projects_taskTimeSet",
        { taskId, time: "2 h", quote: "took 2 h" },
        { ...agent, frame: f },
      )
      expect(out.error?.code).toBe("needs_person_statement")
    }
    // Through the tool itself a routine tick is refused before the handler runs.
    const viaTool = await runContextStore.run(
      { routineId: "00000000-0000-4000-8000-000000000001" } as never,
      () =>
        executeToolCore({
          toolName: "projects:task_time_set",
          orgId,
          actor: actorOf(owner.userId),
          params: { taskId, time: "2 h", quote: "took 2 h" },
          origin: "in-app-agent",
        } as never),
    )
    expect((viaTool as { error?: { code?: string } }).error?.code).toBe("human_turn_only")
    expect(await rows(taskId)).toHaveLength(0)
    const ok = await call("projects_taskTimeSet", { taskId, time: "2 h", quote: "took 2 h" }, agent)
    expect(ok.enteredVia).toBe("agent")
    expect(ok.minutes).toBe(120)
  })

  it("over MCP a person's own connection writes their row marked as said through the coding agent, an agent-bound connection is refused, and a retry leaves one row", async () => {
    const taskId = await newTask(on, "Coding agent entry")
    const mcp = { origin: "mcp" as const, frame: { mcpGateway: true } }
    const input = { taskId, time: "2h", quote: "log 2h on this" }
    const a = await call("projects_taskTimeSet", input, mcp)
    const b = await call("projects_taskTimeSet", input, mcp)
    expect(a.enteredVia).toBe("mcp")
    expect(b.totalMinutes).toBe(120)
    const r = await rows(taskId)
    expect(r).toHaveLength(1)
    expect(r[0]?.entered_via).toBe("mcp")
    const bound = await call("projects_taskTimeSet", input, {
      origin: "mcp",
      frame: { mcpGateway: true, agentId: "00000000-0000-4000-8000-000000000002" },
    })
    expect(bound.error?.code).toBe("needs_person_statement")
    const noQuote = await call("projects_taskTimeSet", { taskId, time: "2h" }, mcp)
    expect(noQuote.error?.code).toBe("needs_person_statement")
  })

  it("task_time_get returns only the caller's rows", async () => {
    const taskId = await newTask(on, "Shared task")
    await call("projects_taskTimeSet", { taskId, time: "2 h" })
    await call(
      "projects_taskTimeSet",
      { taskId, time: "1 h" },
      {
        userId: member.userId,
        scopes: ["projects:tasks:write", "projects:projects:read", "projects:tasks:read"],
      },
    )
    const mine = await call(
      "projects_taskTimeGet",
      { taskId },
      { userId: member.userId, scopes: ["projects:projects:read", "projects:tasks:read"] },
    )
    expect(mine.mine).toHaveLength(1)
    expect(mine.mine[0].minutes).toBe(60)
    expect(mine.totalMinutes).toBe(180)
    expect(JSON.stringify(mine)).not.toContain(owner.userId)
    const offTask = await newTask(off, "Off task")
    const refused = await call("projects_taskTimeGet", { taskId: offTask })
    expect(refused.error?.code).toBe("planning_off")
  })
})

describe("dated hours", () => {
  it("turning dated hours on shows the lead only entries made after it, and off and on again hides what came before", async () => {
    const proj = await newProject("Dated reach", true)
    const taskId = await newTask(proj, "Before and after")
    const memberScopes = ["projects:tasks:write", "projects:projects:read", "projects:tasks:read"]
    await call(
      "projects_taskTimeSet",
      { taskId, time: "2 h" },
      { userId: member.userId, scopes: memberScopes },
    )
    // The entry is from last week; dated hours turn on today.
    await db.execute(drizzleSql`
      UPDATE app_projects.task_time SET work_date = current_date - 7 WHERE task_id = ${taskId}::uuid`)
    const turned = await setDated(proj, true)
    expect(turned.datedHours).toBe(true)
    await call(
      "projects_taskTimeSet",
      { taskId, time: "1 h" },
      { userId: member.userId, scopes: memberScopes },
    )
    const leadSees = async () =>
      withRlsContext(actorOf(owner.userId), async (tx) =>
        extractRows<{ minutes: number }>(
          await tx.execute(drizzleSql`
            SELECT minutes FROM app_projects.task_time
             WHERE task_id = ${taskId}::uuid AND user_id = ${member.userId}::uuid ORDER BY work_date`),
        ).map((r) => r.minutes),
      )
    expect(await leadSees()).toEqual([60])
    await setDated(proj, false)
    await setDated(proj, true)
    expect(await leadSees()).toEqual([])
    const home = extractRows<{ n: number | string }>(
      await db.execute(drizzleSql`
        SELECT count(*) AS n FROM kernel.attention_events
         WHERE user_id = ${member.userId}::uuid AND kind = 'projects:time_budgets.dated_on'
           AND entity_id = ${proj}`),
    )[0]
    expect(Number(home?.n)).toBe(1)
  })

  it("the lead corrects an entry and its author sees who changed it", async () => {
    const proj = await newProject("Dated correct", true)
    await setDated(proj, true)
    const taskId = await newTask(proj, "Correct me")
    const memberScopes = ["projects:tasks:write", "projects:projects:read", "projects:tasks:read"]
    await call(
      "projects_taskTimeSet",
      { taskId, time: "2 h" },
      { userId: member.userId, scopes: memberScopes },
    )
    const entryId = extractRows<{ id: string }>(
      await db.execute(
        drizzleSql`SELECT id::text AS id FROM app_projects.task_time WHERE task_id = ${taskId}::uuid`,
      ),
    )[0]?.id as string
    const fixed = await call("projects_taskTimeCorrect", { entryId, time: "3 h" })
    expect(fixed.minutes).toBe(180)
    const seen = await call(
      "projects_taskTimeGet",
      { taskId },
      { userId: member.userId, scopes: memberScopes },
    )
    expect(seen.mine[0].changedBy).toMatch(/^Changed by /)
    const otherProject = await newProject("Not dated", true)
    const t2 = await newTask(otherProject, "Not dated task")
    await call(
      "projects_taskTimeSet",
      { taskId: t2, time: "2 h" },
      { userId: member.userId, scopes: memberScopes },
    )
    const e2 = extractRows<{ id: string }>(
      await db.execute(
        drizzleSql`SELECT id::text AS id FROM app_projects.task_time WHERE task_id = ${t2}::uuid`,
      ),
    )[0]?.id as string
    const refused = await call("projects_taskTimeCorrect", { entryId: e2, time: "3 h" })
    expect(refused.error?.code).toBe("not_found")
  })
})

describe("correcting an entry follows Took's rules", () => {
  const memberScopes = ["projects:tasks:write", "projects:projects:read", "projects:tasks:read"]
  const entryOf = async (taskId: string, userId: string) =>
    extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id FROM app_projects.task_time
         WHERE task_id = ${taskId}::uuid AND user_id = ${userId}::uuid`),
    )[0]?.id as string

  it("an agent correcting without the lead's words, with other words or a different figure is refused, and so is a routine or a sub-run", async () => {
    const proj = await newProject("Dated agent correct", true)
    await setDated(proj, true)
    const taskId = await newTask(proj, "Correct by agent")
    await call(
      "projects_taskTimeSet",
      { taskId, time: "2 h" },
      { userId: member.userId, scopes: memberScopes },
    )
    const entryId = await entryOf(taskId, member.userId)
    const threadId = await said(owner.userId, "Change it: it took 3 h, not 2.")
    const agent = { origin: "in-app-agent" as const, threadId, frame: { humanTurn: true } }
    for (const c of [
      { time: "3 h" },
      { time: "3 h", quote: "it was 3 h" },
      { time: "4 h", quote: "took 3 h" },
    ]) {
      const out = await call("projects_taskTimeCorrect", { entryId, ...c }, agent)
      expect(out.error?.code).toBe("needs_person_statement")
      expect(out.error?.message).toMatch(/^Nothing changed/)
    }
    for (const f of [{ routineId: "00000000-0000-4000-8000-000000000001" }, { background: true }]) {
      const out = await call(
        "projects_taskTimeCorrect",
        { entryId, time: "3 h", quote: "took 3 h" },
        { ...agent, frame: f },
      )
      expect(out.error?.code).toBe("needs_person_statement")
      // A clean turn record, so the call reaches the place check rather than the taint one.
      const runId = crypto.randomUUID()
      const toolFrame = {
        runId,
        parentRunId: null,
        rootRunId: runId,
        nestingDepth: 0,
        turnScopeAccumulator: createTurnScopeAccumulator({ orgId }),
        ...f,
      }
      const viaTool = await runContextStore.run(toolFrame as never, () =>
        executeToolCore({
          toolName: "projects:task_time_correct",
          orgId,
          actor: actorOf(owner.userId),
          params: { entryId, time: "3 h", quote: "took 3 h" },
          origin: "in-app-agent",
        } as never),
      )
      expect((viaTool as { error?: { code?: string } }).error?.code).toBe("human_turn_only")
    }
    expect((await rows(taskId)).map((r) => r.minutes)).toEqual([120])
    const ok = await call(
      "projects_taskTimeCorrect",
      { entryId, time: "3 h", quote: "took 3 h" },
      agent,
    )
    expect(ok.minutes).toBe(180)
  })

  it("a person cannot correct their own private entry on a project without dated hours, finance included", async () => {
    const proj = await newProject("Plain own correct", true)
    const taskId = await newTask(proj, "Own private")
    await call(
      "projects_taskTimeSet",
      { taskId, time: "2 h" },
      { userId: member.userId, scopes: memberScopes },
    )
    const entryId = await entryOf(taskId, member.userId)
    const out = await call(
      "projects_taskTimeCorrect",
      { entryId, time: "4 h" },
      {
        userId: member.userId,
        scopes: [...memberScopes, "projects:dated_sheet:read", "projects:timesheet:read"],
      },
    )
    expect(out.error?.code).toBe("not_found")
    expect((await rows(taskId)).map((r) => r.minutes)).toEqual([120])
  })

  it("on a dated project only its lead or finance corrects, and only entries on the sheet", async () => {
    const proj = await newProject("Dated who corrects", true)
    const taskId = await newTask(proj, "Before and after")
    // Entered before dated hours were on: never on the sheet.
    await call(
      "projects_taskTimeSet",
      { taskId, time: "1 h" },
      { userId: member.userId, scopes: memberScopes },
    )
    const before = await entryOf(taskId, member.userId)
    await setDated(proj, true)
    const early = await call("projects_taskTimeCorrect", { entryId: before, time: "2 h" })
    expect(early.error?.code).toBe("not_found")
    const other = await minimal.session(orgId, { role: "member" })
    const t2 = await newTask(proj, "On the sheet")
    await call(
      "projects_taskTimeSet",
      { taskId: t2, time: "2 h", date: "2026-11-02" },
      { userId: member.userId, scopes: memberScopes },
    )
    const onSheet = await entryOf(t2, member.userId)
    // A colleague holding every project scope but neither leading it nor finance.
    const colleague = await call(
      "projects_taskTimeCorrect",
      { entryId: onSheet, time: "5 h" },
      { userId: other.userId, scopes: ["projects:*"] },
    )
    expect(colleague.error?.code).toBe("not_found")
    expect((await rows(t2)).map((r) => r.minutes)).toEqual([120])
    const lead = await call("projects_taskTimeCorrect", { entryId: onSheet, time: "5 h" })
    expect(lead.minutes).toBe(300)
    const tool = (projectsAppManifest.tools as Record<string, Record<string, unknown>>)
      .task_time_correct
    expect(tool?.requiredScopes).toContain("projects:dated_sheet:read")
    expect(tool?.humanTurnOnly).toBe(true)
  })
})

describe("moving and merging across the line", () => {
  it("moving a task to a project without time keeps its time and stops counting it, and back again counts at once", async () => {
    const taskId = await newTask(on, "Travelling task")
    await call("projects_updateTask", { taskId, timebox: "5 h" })
    await call("projects_taskTimeSet", { taskId, time: "3 h" })
    const away = await call("projects_moveTask", { taskId, projectId: off })
    expect(away.timeBudgetsNote).toContain("stop counting")
    const t = extractRows<{ timebox_minutes: number; project_id: string }>(
      await db.execute(drizzleSql`
        SELECT timebox_minutes, (SELECT project_id::text FROM app_projects.task_time WHERE task_id = ${taskId}::uuid LIMIT 1) AS project_id
          FROM app_projects.tasks WHERE id = ${taskId}::uuid`),
    )[0]
    expect(t?.timebox_minutes).toBe(300)
    expect(t?.project_id).toBe(off)
    const back = await call("projects_moveTask", { taskId, projectId: on })
    expect(back.timeBudgetsNote).toContain("count there from now")
    const keys = await call("projects_updateTask", { taskId })
    expect(keys.timeboxMinutes).toBe(300)
    expect(keys.realTotalMinutes).toBe(180)
  })

  it("merging adds one person's minutes and keeps the target's timebox", async () => {
    const source = await newTask(on, "Merge source")
    const target = await newTask(on, "Merge target")
    await call("projects_updateTask", { taskId: source, timebox: "4 h" })
    await call("projects_updateTask", { taskId: target, timebox: "2 h" })
    await call("projects_taskTimeSet", { taskId: source, time: "1 h" })
    await call("projects_taskTimeSet", { taskId: target, time: "2 h" })
    const out = await call("projects_mergeTasks", { sourceId: source, targetId: target })
    expect(out.merged).toBe(true)
    expect(out.timeboxMinutes).toBe(120)
    const r = await rows(target)
    expect(r).toHaveLength(1)
    expect(r[0]?.minutes).toBe(180)
    expect(await rows(source)).toHaveLength(0)
  })
})

describe("status changes and templates keep the time rules", () => {
  it("a status change on a task with a timebox records its transition and keeps the time keys and rows", async () => {
    const taskId = await newTask(on, "Ship the release")
    await call("projects_updateTask", { taskId, timebox: "2 h" })
    await call("projects_taskTimeSet", { taskId, time: "1 h" })
    const done = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id FROM app_projects.project_statuses
         WHERE project_id = ${on}::uuid AND terminal = true ORDER BY "order" LIMIT 1`),
    )[0]?.id as string
    const out = await call("projects_updateTask", { taskId, statusId: done })
    expect(out.statusId).toBe(done)
    expect(out.timeboxMinutes).toBe(120)
    expect(out.realTotalMinutes).toBe(60)
    const moves = extractRows<{ to_status_id: string }>(
      await db.execute(drizzleSql`
        SELECT to_status_id::text AS to_status_id FROM app_projects.task_transitions
         WHERE task_id = ${taskId}::uuid ORDER BY "at", seq`),
    )
    expect(moves.at(-1)?.to_status_id).toBe(done)
    expect(await rows(taskId)).toHaveLength(1)
    const offTask = await newTask(off, "Plain status change")
    const offDone = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id FROM app_projects.project_statuses
         WHERE project_id = ${off}::uuid AND terminal = true ORDER BY "order" LIMIT 1`),
    )[0]?.id as string
    const plain = await call("projects_updateTask", { taskId: offTask, statusId: offDone })
    expect(plain.statusId).toBe(offDone)
    expect("timeboxMinutes" in plain).toBe(false)
  })

  it("a template instantiated with time and budgets turns the new project on, and its tasks take a timebox", async () => {
    const saved = await call<{ id: string }>("projects_saveTemplate", {
      name: "Sprint",
      statuses: [{ label: "To do" }, { label: "Done", terminal: true }],
      tasks: [{ title: "Kickoff", statusLabel: "To do" }],
    })
    const made = await call<{ projectId: string; timeBudgets?: boolean }>(
      "projects_instantiateTemplate",
      { templateId: saved.id, projectName: "Sprint one", timeBudgets: true },
    )
    expect(made.timeBudgets).toBe(true)
    await awaitTimeFeatureSync(orgId)
    const kickoff = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id FROM app_projects.tasks
         WHERE project_id = ${made.projectId}::uuid AND title = 'Kickoff'`),
    )[0]?.id as string
    const planned = await call("projects_updateTask", { taskId: kickoff, timebox: "1 day" })
    expect(planned.timeboxMinutes).toBe(420)
    const plainMade = await call<{ projectId: string }>("projects_instantiateTemplate", {
      templateId: saved.id,
      projectName: "Sprint plain",
      timeBudgets: false,
    })
    const plainTask = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id FROM app_projects.tasks
         WHERE project_id = ${plainMade.projectId}::uuid AND title = 'Kickoff'`),
    )[0]?.id as string
    const refused = await call("projects_updateTask", { taskId: plainTask, timebox: "1 day" })
    expect(refused.error?.code).toBe("planning_off")
  })
})

describe("plan, terms and period timeboxes", () => {
  it("fixed price and rate together are refused", async () => {
    const out = await call("projects_billingTermsSet", {
      projectId: on,
      rate: 90,
      fixedPrice: 4000,
    })
    expect(out.error?.code).toBe("rate_and_fixed_price")
    const fixed = await call("projects_billingTermsSet", {
      projectId: on,
      fixedPrice: 4000,
      currency: "eur",
    })
    expect(fixed.fixedPrice).toBe(4000)
    expect(fixed.currency).toBe("EUR")
    const rate = await call("projects_billingTermsSet", { projectId: on, rate: 90 })
    expect(rate.rate).toBe(90)
    expect(rate.fixedPrice).toBeNull()
  })

  it("a period timebox cleared stays refused on an off project", async () => {
    const set = await call("projects_periodTimeboxSet", {
      projectId: on,
      month: "2026-11",
      timebox: "10 days",
    })
    expect(set.minutes).toBe(4200)
    expect(set.to).toBe("2026-11-30")
    const cleared = await call("projects_periodTimeboxSet", {
      projectId: on,
      month: "2026-11",
      timebox: null,
    })
    expect(cleared.removed).toBe(true)
    const refused = await call("projects_periodTimeboxSet", {
      projectId: off,
      month: "2026-11",
      timebox: null,
    })
    expect(refused.error?.code).toBe("planning_off")
  })

  it("the plan stores its basis and timebox and refuses on a project without time and budgets", async () => {
    const plan = await call("projects_timePlanSet", {
      projectId: on,
      basis: "fixed",
      timebox: "40 days",
    })
    expect(plan.basis).toBe("fixed")
    expect(plan.timeboxMinutes).toBe(40 * 420)
    const refused = await call("projects_timePlanSet", { projectId: off, basis: "hourly" })
    expect(refused.error?.code).toBe("planning_off")
  })
})

describe("dashboards", () => {
  it("a dashboard block on task_time_get saves and runs", async () => {
    const taskId = await newTask(on, "Charted task")
    await call("projects_taskTimeSet", { taskId, time: "2 h" })
    const viewer = actorOf(owner.userId)
    const d = await createDashboard(viewer, {
      title: "My time on a task",
      visibility: "personal",
      spec: {
        v: 1,
        blocks: [
          {
            id: "b",
            type: "metric",
            title: "Entries",
            source: {
              kind: "tool",
              tool: "projects:task_time_get",
              params: { taskId },
              rowsPath: "mine",
            },
            map: { agg: "count" },
          },
        ],
      },
    } as never)
    expect(await getBlockData(viewer, d.id, "b")).toMatchObject({
      ok: true,
      data: { kind: "metric", value: 1 },
    })
  })
})
