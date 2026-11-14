// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dated sheet on the real database, through the bridge people and agents use: one project
// and month, only on a project with dated hours, only for its lead and finance. Its export
// carries the same lines and total, a partial sheet asks once, and with dated hours off no time
// tool shows anyone's hours.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { projectsAppManifest } from "~/apps/projects/manifest-descriptor"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { files } from "~/db/schema/kernel"
import { getObjectBuffer } from "~/infra/storage/object-storage"
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
import { NOT_A_RECORD } from "./timesheet"

let orgId = ""
let admin: minimal.Session
let ana: minimal.Session
let leo: minimal.Session
let finance: minimal.Session

/** The member role's scopes: the dated sheet scope is the member's, the sheet's code decides. */
const MEMBER = [
  "projects:projects:read",
  "projects:tasks:read",
  "projects:tasks:write",
  "projects:dated_sheet:read",
]
const LEAD = [...MEMBER, "projects:projects:write"]
const FINANCE = [...MEMBER, "projects:timesheet:read"]
const MONTH = "2026-10"

type Who = { userId: string; scopes: string[] }

function actorOf(who: Who): UserContext {
  return {
    actorType: "user",
    userId: who.userId,
    orgId,
    scopes: who.scopes,
    dimensionGrants: { "*": ["*"] },
  }
}

async function call<T = Record<string, any>>(method: string, input: unknown, who: Who): Promise<T> {
  const a = actorOf(who)
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

const asAdmin = (): Who => ({ userId: admin.userId, scopes: ["*"] })
const asAna = (): Who => ({ userId: ana.userId, scopes: MEMBER })
const asLeo = (): Who => ({ userId: leo.userId, scopes: LEAD })
const asFinance = (): Who => ({ userId: finance.userId, scopes: FINANCE })

async function newProject(name: string, dated: boolean): Promise<string> {
  const made = await call<{ id: string }>("projects_createProject", { name }, asLeo())
  await call("projects_updateProject", { projectId: made.id, timeBudgets: true }, asLeo())
  await awaitTimeFeatureSync(orgId)
  if (dated) await call("projects_timePlanSet", { projectId: made.id, datedHours: true }, asLeo())
  return made.id
}

async function newTask(projectId: string, title: string): Promise<string> {
  return (await call<{ id: string }>("projects_createTask", { projectId, title }, asLeo())).id
}

/** October's working days, Thursday the 1st onwards. */
const WORKDAYS = [
  "2026-10-01",
  "2026-10-02",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
  "2026-10-08",
  "2026-10-09",
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
  "2026-10-16",
  "2026-10-19",
  "2026-10-20",
]

let dated = ""
let tasks: string[] = []

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  admin = await minimal.adminSession(orgId)
  ana = await minimal.session(orgId, { role: "member" })
  leo = await minimal.session(orgId, { role: "member" })
  finance = await minimal.session(orgId, { role: "member" })
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
  dated = await newProject("Maison Delorme retainer", true)
  tasks = []
  for (const title of ["Brief", "Moodboard", "Layouts", "Copy", "Review", "Handover"]) {
    tasks.push(await newTask(dated, title))
  }
  // Fourteen entries on six tasks: thirteen of 3 h and one of 7 h, 46 h in all.
  for (const [i, date] of WORKDAYS.entries()) {
    const who = i % 2 === 0 ? asAna() : asFinance()
    const r = await call(
      "projects_taskTimeSet",
      { taskId: tasks[i % 6], time: i === 13 ? "7 h" : "3 h", date },
      who,
    )
    expect(r.error).toBeUndefined()
  }
}, 180_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("the dated sheet", () => {
  it("a dated project's month returns fourteen lines totalling 46 hours to the lead and to finance, and refuses everyone else", async () => {
    for (const who of [asLeo(), asFinance()]) {
      const sheet = await call("projects_timesheetGet", { projectId: dated, month: MONTH }, who)
      expect(sheet.error).toBeUndefined()
      expect(sheet.lines).toHaveLength(14)
      expect(sheet.totalMinutes).toBe(46 * 60)
      expect(sheet.lines.reduce((s: number, l: { minutes: number }) => s + l.minutes, 0)).toBe(
        46 * 60,
      )
      expect(sheet.lines.map((l: { date: string }) => l.date)).toEqual(WORKDAYS)
      expect(sheet.coverage).toEqual({ withEntries: 6, total: 6 })
      expect(sheet.partial).toBe(false)
      expect(sheet.lines.every((l: { person: string }) => l.person.length > 0)).toBe(true)
    }
    for (const who of [asAdmin(), asAna()]) {
      const refused = await call("projects_timesheetGet", { projectId: dated, month: MONTH }, who)
      expect(refused.error?.code).toBe("not_allowed")
      expect(JSON.stringify(refused)).not.toContain(ana.userId)
    }
  })

  it("a project without dated hours has no sheet, even for its lead", async () => {
    const plain = await newProject("Maison Delorme plain", false)
    const refused = await call("projects_timesheetGet", { projectId: plain, month: MONTH }, asLeo())
    // Its own code, so a screen can say how the sheet is turned on rather than who may read it.
    expect(refused.error?.code).toBe("dated_hours_off")
  })

  it("the sheet never calls itself a working-time record", async () => {
    const sheet = await call("projects_timesheetGet", { projectId: dated, month: MONTH }, asLeo())
    expect(sheet.note).toBe("Not a legal working-time record, and it reminds nobody of anything.")
    const rest = JSON.stringify(sheet).split(NOT_A_RECORD).join("")
    expect(rest).not.toMatch(/working[- ]time|legal record|time register|reminder/i)
  })

  it("exports carry the same lines and the coverage line, and a partial sheet asks once", async () => {
    const sheet = await call("projects_timesheetGet", { projectId: dated, month: MONTH }, asLeo())
    const csv = await call(
      "projects_timesheetExport",
      { projectId: dated, month: MONTH, format: "csv" },
      asLeo(),
    )
    expect(csv.fileId).toBeString()
    const [row] = await db.select().from(files).where(eq(files.id, csv.fileId))
    expect(row?.mimeType).toBe("text/csv")
    const text = new TextDecoder().decode(await getObjectBuffer(row!.storageKey))
    const rows = text.trim().split("\r\n")
    expect(rows[0]).toBe(sheet.coverageLine)
    expect(rows[1]).toBe("Date,Person,Task,Hours")
    expect(rows.slice(2, -2)).toHaveLength(14)
    expect(rows.at(-2)).toBe("Total,,,46")
    const pdf = await call(
      "projects_timesheetExport",
      { projectId: dated, month: MONTH, format: "pdf" },
      asFinance(),
    )
    const [pdfRow] = await db.select().from(files).where(eq(files.id, pdf.fileId))
    expect(pdfRow?.mimeType).toBe("application/pdf")
    expect(pdfRow?.uploadedBy).toBe(finance.userId)
    expect(pdf.lines).toBe(14)
    expect(pdf.totalMinutes).toBe(46 * 60)

    // Two tasks closed in October with nothing entered make the month partial.
    for (const title of ["Print check", "Archive"]) {
      const t = await newTask(dated, title)
      await db.execute(
        drizzleSql`UPDATE app_projects.tasks SET completed_at = '2026-10-28T10:00:00Z' WHERE id = ${t}::uuid`,
      )
    }
    const asked = await call(
      "projects_timesheetExport",
      { projectId: dated, month: MONTH, format: "pdf" },
      asLeo(),
    )
    expect(asked.needsConfirm).toBe(true)
    expect(asked.coverage).toEqual({ withEntries: 6, total: 8 })
    expect(asked.fileId).toBeUndefined()
    const accepted = await call(
      "projects_timesheetExport",
      { projectId: dated, month: MONTH, format: "csv", acceptPartial: true },
      asLeo(),
    )
    expect(accepted.partial).toBe(true)
    const [accRow] = await db.select().from(files).where(eq(files.id, accepted.fileId))
    const first = new TextDecoder()
      .decode(await getObjectBuffer(accRow!.storageKey))
      .split("\r\n")[0]
    expect(first).toBe(`"Real time entered on 6 of 8 tasks of October 2026, partial."`)
  })

  it("a dashboard block on timesheet_get does not run: the sheet is read only on a person's own turn", async () => {
    const viewer = actorOf({
      userId: leo.userId,
      scopes: [...LEAD, "kernel:dashboards:read", "kernel:dashboards:write"],
    })
    const spec = {
      v: 1,
      blocks: [
        {
          id: "b",
          type: "metric",
          title: "Lines",
          source: {
            kind: "tool",
            tool: "projects:timesheet_get",
            params: { projectId: dated, month: MONTH },
            rowsPath: "lines",
          },
          map: { agg: "count" },
        },
      ],
    }
    let data: unknown
    try {
      const d = await createDashboard(viewer, {
        title: "Dated hours",
        visibility: "personal",
        spec,
      } as never)
      data = await getBlockData(viewer, d.id, "b")
    } catch (err) {
      data = { ok: false, thrown: String(err) }
    }
    expect(data).toMatchObject({ ok: false })
    expect(JSON.stringify(data)).not.toContain('"value":14')
  })
})

type Outcome = { error?: { code?: string }; data?: any }

/** The in-app agent's call of a sheet tool, as `who`, in `threadId`, from a given run frame. */
async function viaAgent(
  name: "timesheet_get" | "timesheet_export",
  who: Who,
  threadId: string,
  frame: Record<string, unknown>,
): Promise<Outcome> {
  const runId = crypto.randomUUID()
  const params =
    name === "timesheet_get"
      ? { projectId: dated, month: MONTH }
      : { projectId: dated, month: MONTH, format: "csv", acceptPartial: true }
  return runContextStore.run(
    {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      turnScopeAccumulator: createTurnScopeAccumulator({ orgId }),
      ...frame,
    } as never,
    () =>
      executeToolCore({
        toolName: `projects:${name}`,
        orgId,
        actor: actorOf(who),
        params,
        origin: "in-app-agent",
        threadId,
      } as never) as Promise<Outcome>,
  )
}

describe("where the dated sheet may be read", () => {
  const TOOLS = ["timesheet_get", "timesheet_export"] as const

  it("a member who owns and leads nothing is refused both tools by the sheet's own check", async () => {
    const dm = await minimal.agentDm(orgId, ana.userId)
    for (const name of TOOLS) {
      const out = await viaAgent(name, asAna(), dm, { humanTurn: true })
      expect(out.error?.code).toBe("not_allowed")
      expect(JSON.stringify(out)).not.toContain("Moodboard")
    }
  })

  it("a project's owner holding only the member role reads its sheet in a DM", async () => {
    const dm = await minimal.agentDm(orgId, leo.userId)
    const owner = { userId: leo.userId, scopes: MEMBER }
    const out = await viaAgent("timesheet_get", owner, dm, { humanTurn: true })
    expect(out.error).toBeUndefined()
    expect(JSON.stringify(out)).toContain('"totalMinutes":2760')
    // The member role carries the scope the tools ask for.
    const roles = (
      projectsAppManifest as unknown as {
        roles: Record<string, { scopes: string[] }>
      }
    ).roles
    expect(roles.member?.scopes).toContain("projects:dated_sheet:read")
  })

  it("the lead in a shared thread is refused both tools, and nothing is read", async () => {
    const shared = await minimal.thread(orgId, leo.userId, { participantIds: [ana.userId] })
    for (const name of TOOLS) {
      const out = await viaAgent(name, asLeo(), shared, { humanTurn: true })
      expect(out.error?.code).toBe("dm_only")
    }
  })

  it("the lead's routine or a sub-run is refused both tools", async () => {
    const dm = await minimal.agentDm(orgId, leo.userId)
    for (const frame of [
      { routineId: "00000000-0000-4000-8000-000000000001" },
      { background: true },
    ]) {
      for (const name of TOOLS) {
        const out = await viaAgent(name, asLeo(), dm, frame)
        expect(out.error?.code).toBe("human_turn_only")
      }
    }
  })

  it("the lead and finance in their DM read the sheet; a holder of every scope who leads nothing is refused", async () => {
    const leoDm = await minimal.agentDm(orgId, leo.userId)
    const lead = await viaAgent("timesheet_get", asLeo(), leoDm, { humanTurn: true })
    expect(lead.error).toBeUndefined()
    expect(JSON.stringify(lead)).toContain('"totalMinutes":2760')
    const financeDm = await minimal.agentDm(orgId, finance.userId)
    const fin = await viaAgent("timesheet_get", asFinance(), financeDm, { humanTurn: true })
    expect(fin.error).toBeUndefined()
    const adminDm = await minimal.agentDm(orgId, admin.userId)
    const all = await viaAgent("timesheet_get", asAdmin(), adminDm, { humanTurn: true })
    expect(all.error?.code).toBe("not_allowed")
  })
})

describe("with dated hours off", () => {
  it("with dated hours off no tool result shows hours per person", async () => {
    const plain = await newProject("Maison Delorme open", false)
    const task = await newTask(plain, "Wireframes")
    await call("projects_taskTimeSet", { taskId: task, time: "5 h" }, asAna())
    await call("projects_taskTimeSet", { taskId: task, time: "2 h" }, asFinance())
    const names = (
      (await db.execute(
        drizzleSql`SELECT name FROM kernel.users WHERE id IN (${ana.userId}::uuid, ${finance.userId}::uuid)`,
      )) as unknown as Array<{ name: string | null }>
    )
      .map((r) => r.name ?? "")
      .filter((n) => n.length > 0)
    expect(names).toHaveLength(2)
    const outputs: Array<[string, unknown]> = []
    for (const who of [asLeo(), asAdmin()]) {
      outputs.push(["budget_get", await call("projects_budgetGet", { projectId: plain }, who)])
      outputs.push(["task_time_get", await call("projects_taskTimeGet", { taskId: task }, who)])
      outputs.push([
        "reconcile_facts",
        await call("projects_reconcileFacts", { project: plain }, who),
      ])
      outputs.push([
        "timesheet_get",
        await call("projects_timesheetGet", { projectId: plain }, who),
      ])
      outputs.push([
        "timesheet_export",
        await call("projects_timesheetExport", { projectId: plain, format: "csv" }, who),
      ])
      outputs.push(["capacity_get", await call("projects_capacityGet", {}, who)])
    }
    for (const [tool, out] of outputs) {
      const text = JSON.stringify(out)
      for (const id of [ana.userId, finance.userId]) {
        // Capacity lists people by their planned time only; nothing here is planned.
        expect({ tool, hit: text.includes(id) && /"realMinutes"|"minutes"/.test(text) }).toEqual({
          tool,
          hit: false,
        })
      }
      for (const name of names) {
        expect({
          tool,
          hit: new RegExp(`${name}[^}]{0,80}\\b(300|120|5 h|2 h)\\b`).test(text),
        }).toEqual({
          tool,
          hit: false,
        })
      }
    }
  })
})
