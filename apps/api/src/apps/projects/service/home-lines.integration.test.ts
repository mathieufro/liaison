// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The time and budgets Home lines on the real database: the month-close line on its one day to
// the biller only, the capacity line to leads only and once per person and week, and nothing
// at all that reminds anyone about time.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { addCalendarDays, isoWeekOf } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { computeAttentionItems } from "~/apps/projects/attention"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { readStandingInFor } from "~/modules/approvals/route-world"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { orgTransferView } from "~/modules/org/transfer-state/state"
import { setAway } from "~/modules/users/away"
import { seedContext } from "~/seed/context"
import { seedReconciliation } from "~/seed/factories/projects/reconcile"
import { seedTaskTime } from "~/seed/factories/projects/time"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { syncDaysOffCalendar } from "./days-off-calendar"
import {
  CAPACITY_OVER_KIND,
  MONTH_CLOSE_KIND,
  monthCloseDay,
  raiseCapacityLines,
  raiseCapacityLinesAll,
} from "./home-lines"
import { awaitTimeFeatureSync } from "./time-feature"
import { awaitTimeRowWrites } from "./time-rows"

const MEMBER_SCOPES = ["projects:projects:read", "projects:tasks:read", "projects:tasks:write"]

let orgId = ""
let owner: minimal.Session

function actorOf(userId: string, scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function call<T = Record<string, any>>(method: string, input: unknown): Promise<T> {
  const a = actorOf(owner.userId)
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

async function newPerson(name: string): Promise<string> {
  const p = await minimal.session(orgId, { role: "member" })
  await db.execute(drizzleSql`UPDATE kernel.users SET name = ${name} WHERE id = ${p.userId}::uuid`)
  return p.userId
}

async function newProject(name: string): Promise<string> {
  const made = await call<{ id: string }>("projects_createProject", { name })
  await call("projects_updateProject", { projectId: made.id, timeBudgets: true })
  await awaitTimeFeatureSync(orgId)
  return made.id
}

async function task(projectId: string, assigneeId: string, timebox: string): Promise<string> {
  const t = await call<{ id: string }>("projects_createTask", {
    projectId,
    title: `Work ${timebox}`,
    assigneeId,
    timebox,
  })
  if (!t.id) throw new Error(`task not created: ${JSON.stringify(t)}`)
  return t.id
}

const feed = (userId: string, now: Date, scopes = MEMBER_SCOPES) =>
  withRlsContext(actorOf(userId, scopes), (tx) => computeAttentionItems(tx, orgId, userId, [], now))

async function capacityLines(userId: string) {
  return extractRows<{ entity_id: string; read_at: unknown; set_aside_until: unknown }>(
    await db.execute(drizzleSql`
      SELECT entity_id, read_at, set_aside_until FROM kernel.attention_events
       WHERE org_id = ${orgId}::uuid AND user_id = ${userId}::uuid AND kind = ${CAPACITY_OVER_KIND}
       ORDER BY created_at`),
  )
}
/** Midday UTC on a civil date. */
const noon = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d, 12))
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET timezone = 'UTC' WHERE id = ${orgId}::uuid`,
  )
  owner = await minimal.adminSession(orgId)
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("the month-close line", () => {
  let biller = ""
  let daily = ""
  let fixed = ""
  let someTask = ""

  beforeAll(async () => {
    biller = await newPerson("Bea Biller")
    daily = await newProject("Daily client")
    fixed = await newProject("Fixed client")
    await call("projects_timePlanSet", { projectId: daily, basis: "daily", billerId: biller })
    await call("projects_timePlanSet", { projectId: fixed, basis: "fixed", billerId: biller })
    someTask = await task(daily, biller, "2 h")
  }, 120_000)

  it("the month-close line shows one day in each of three months, to the biller only, and reads no time", async () => {
    // May 2027 ends on a Monday, July 2027 on a Saturday, October 2027 on a Sunday.
    const months: Array<[string, string]> = [
      ["2027-05", "2027-05-28"],
      ["2027-07", "2027-07-30"],
      ["2027-10", "2027-10-29"],
    ]
    const shownOn = async (userId: string, month: string) => {
      const days: string[] = []
      for (let d = `${month}-01`; d.startsWith(month); d = addCalendarDays(d, 1)) {
        const items = (await feed(userId, noon(d))).filter(
          (i) => (i.kind as string) === MONTH_CLOSE_KIND,
        )
        if (items.length > 0) days.push(`${d}:${items.map((i) => i.entityId).join(",")}`)
      }
      return days
    }
    for (const [month, day] of months) {
      expect(await shownOn(biller, month)).toEqual([`${day}:${daily}`])
      expect(await shownOn(owner.userId, month)).toEqual([])
    }
    // Time entered on the project changes nothing about the line.
    const before = JSON.stringify(await feed(biller, noon("2027-05-28")))
    await seedTaskTime(seedContext({ orgId, now: new Date() }), actorOf(biller), [
      { taskId: someTask, projectId: daily, workDate: "2027-05-27", minutes: 300 },
    ])
    expect(JSON.stringify(await feed(biller, noon("2027-05-28")))).toBe(before)
    const [item] = (await feed(biller, noon("2027-05-28"))).filter(
      (i) => (i.kind as string) === MONTH_CLOSE_KIND,
    )
    expect(item?.urgency).toBeLessThan(30)
  })

  it("a missed line never comes back", async () => {
    for (const d of ["2027-05-29", "2027-05-30", "2027-05-31", "2027-06-01", "2027-06-02"]) {
      const items = (await feed(biller, noon(d))).filter(
        (i) => (i.kind as string) === MONTH_CLOSE_KIND,
      )
      expect({ d, items }).toEqual({ d, items: [] })
    }
  })

  it("a drafted reconcile for the month ends the line, a proposed one does not", async () => {
    const thread = await minimal.thread(orgId, biller)
    await seedReconciliation(orgId, {
      now: new Date(),
      projectId: daily,
      createdBy: owner.userId,
      threadId: thread,
      state: "proposed",
      month: "2027-07",
      idleDays: 0,
    })
    expect(
      (await feed(biller, noon("2027-07-30"))).filter(
        (i) => (i.kind as string) === MONTH_CLOSE_KIND,
      ),
    ).toHaveLength(1)
    await seedReconciliation(orgId, {
      now: new Date(),
      projectId: daily,
      createdBy: owner.userId,
      threadId: thread,
      state: "drafted",
      month: "2027-07",
      idleDays: 0,
    })
    const items = (
      await feed(biller, noon("2027-07-30"), [...MEMBER_SCOPES, "projects:reconcile:read"])
    ).filter((i) => (i.kind as string) === MONTH_CLOSE_KIND)
    expect(items).toEqual([])
  })

  it("a company day off moves the line to the working day before it", async () => {
    expect(monthCloseDay(2027, 5, new Set(["2027-05-28"]))).toBe("2027-05-27")
    expect(monthCloseDay(2027, 7, new Set())).toBe("2027-07-30")
    expect(monthCloseDay(2027, 10, new Set())).toBe("2027-10-29")
  })
})

describe("the month-close line across people", () => {
  const monthClose = (items: Awaited<ReturnType<typeof computeAttentionItems>>) =>
    items.filter((i) => (i.kind as string) === MONTH_CLOSE_KIND)

  it("a colleague's draft for the month ends the line for a biller who cannot read reconciles", async () => {
    const drafter = await newPerson("Ada Drafter")
    const biller = await newPerson("Bo Biller")
    await minimal.grantScope(drafter, "projects:reconcile:read")
    await minimal.grantScope(drafter, "projects:reconcile:write")
    const project = await newProject("Hourly client")
    await call("projects_timePlanSet", { projectId: project, basis: "hourly", billerId: biller })
    const day = noon("2027-10-29")
    const [before] = monthClose(await feed(biller, day))
    expect(before?.entityId).toBe(project)
    expect(before?.summary).toBe(
      "Hourly client: October ends soon. Reconcile it when you are ready.",
    )

    const thread = await minimal.thread(orgId, drafter)
    await seedReconciliation(orgId, {
      now: new Date(),
      projectId: project,
      createdBy: drafter,
      threadId: thread,
      state: "drafted",
      month: "2027-10",
      idleDays: 0,
      basis: "hourly",
    })
    // The biller cannot read the colleague's draft...
    const visible = await withRlsContext(actorOf(biller, MEMBER_SCOPES), async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM app_projects.reconciliations
           WHERE project_id = ${project}::uuid`),
      ),
    )
    expect(visible[0]?.n).toBe(0)
    // ...and still gets no line, because the month is drafted.
    expect(monthClose(await feed(biller, day))).toEqual([])
    expect(monthClose(await feed(drafter, day))).toEqual([])
  })

  it("an away biller's month-close line reaches their next in line, marked for them", async () => {
    const biller = await newPerson("Cy Away")
    const next = await newPerson("Di Next")
    const project = await newProject("Retainer client")
    await call("projects_timePlanSet", { projectId: project, basis: "retainer", billerId: biller })
    const day = noon("2027-10-29")
    const feedOf = (userId: string) =>
      withRlsContext(actorOf(userId, MEMBER_SCOPES), async (tx) =>
        computeAttentionItems(
          tx,
          orgId,
          userId,
          await readStandingInFor(tx as never, orgId, userId, day),
          day,
        ),
      )
    // Not away: the line is the biller's alone.
    expect(monthClose(await feedOf(next))).toEqual([])

    // The biller says it themselves, ahead of time, naming the next in line.
    const said = await setAway({
      orgId,
      actorId: biller,
      actorScopes: MEMBER_SCOPES,
      form: { from: "2027-10-28", to: "2027-11-03" },
      nextInLineId: next,
    })
    if (!said.ok || said.action !== "set") throw new Error(`away not set: ${JSON.stringify(said)}`)
    try {
      const items = monthClose(await feedOf(next))
      expect(items.map((i) => [i.entityId, i.metadata?.forUserId])).toEqual([[project, biller]])
      expect(items[0]?.id).toBe(`projects:month_close:${project}:2027-10`)
      // The biller's own feed keeps the line; nobody else gets it.
      expect(monthClose(await feedOf(biller)).map((i) => i.entityId)).toEqual([project])
      expect(monthClose(await feedOf(owner.userId))).toEqual([])
    } finally {
      await db.execute(drizzleSql`DELETE FROM kernel.away_ranges WHERE id = ${said.id}::uuid`)
    }
  })

  it("an away biller with nobody next in line sees the line once, on their first working day back", async () => {
    const biller = await newPerson("Eve Away")
    const project = await newProject("Hourly away client")
    await call("projects_timePlanSet", { projectId: project, basis: "hourly", billerId: biller })
    // December 2027 ends on a Friday: its one day is Thursday 30. The biller is away from the
    // 29th to Tuesday 4 January, and Wednesday 5 January is a company day off.
    expect(monthCloseDay(2027, 12, new Set())).toBe("2027-12-30")
    const said = await setAway({
      orgId,
      actorId: biller,
      actorScopes: MEMBER_SCOPES,
      form: { from: "2027-12-29", to: "2028-01-04" },
    })
    if (!said.ok || said.action !== "set") throw new Error(`away not set: ${JSON.stringify(said)}`)
    const off = await call<{ created?: boolean }>("projects_daysOffSet", {
      on: "2028-01-05",
      label: "Studio day",
    })
    expect(off.created).toBe(true)
    try {
      const shown: string[] = []
      for (let d = "2027-12-20"; d <= "2028-01-12"; d = addCalendarDays(d, 1)) {
        for (const item of monthClose(await feed(biller, noon(d)))) {
          shown.push(`${d}:${item.id}:${item.summary}`)
        }
        expect(monthClose(await feed(owner.userId, noon(d)))).toEqual([])
      }
      expect(shown).toEqual([
        `2028-01-06:projects:month_close:${project}:2027-12:Hourly away client: December has ended. Reconcile it when you are ready.`,
      ])
    } finally {
      await db.execute(drizzleSql`DELETE FROM kernel.away_ranges WHERE id = ${said.id}::uuid`)
      await db.execute(drizzleSql`
        DELETE FROM app_projects.days_off WHERE org_id = ${orgId}::uuid AND starts_on = '2028-01-05'`)
    }
  })
})

describe("the capacity line", () => {
  let project = ""
  let nadia = ""
  let lena = ""
  let paul = ""
  let mat = ""

  beforeAll(async () => {
    project = await newProject("Atlas capacity")
    nadia = await newPerson("Nadia Over")
    lena = await newPerson("Lena Lead")
    paul = await newPerson("Paul Elsewhere")
    mat = await newPerson("Mat Member")
    await minimal.grantScope(lena, "projects:capacity:read")
    await minimal.grantScope(paul, "projects:capacity:read")
    await minimal.grantScope(nadia, "projects:capacity:read")
    // No dates: the whole box falls in the current week.
    await task(project, nadia, "44 h")
    await task(project, lena, "2 h")
    await task(project, mat, "2 h")
  }, 120_000)

  it("a lead sees one capacity line per over person per week, the person does not, and Not now hides it for the week", async () => {
    const now = new Date()
    const week = isoWeekOf(now.toISOString().slice(0, 10))
    await raiseCapacityLines(orgId, now)
    await raiseCapacityLines(orgId, now)
    const lenaLines = await capacityLines(lena)
    expect(lenaLines.map((l) => l.entity_id)).toEqual([`${nadia}:${week}`])
    // The project's owner leads it too; the person, a member without capacity read and a
    // holder of capacity read on no project of hers get nothing.
    expect((await capacityLines(owner.userId)).map((l) => l.entity_id)).toEqual([
      `${nadia}:${week}`,
    ])
    expect(await capacityLines(nadia)).toEqual([])
    expect(await capacityLines(mat)).toEqual([])
    expect(await capacityLines(paul)).toEqual([])
    const [summary] = extractRows<{ summary: string; urgency: number }>(
      await db.execute(drizzleSql`
        SELECT summary, urgency FROM kernel.attention_events
         WHERE org_id = ${orgId}::uuid AND user_id = ${lena}::uuid AND kind = ${CAPACITY_OVER_KIND}`),
    )
    expect(summary?.summary).toBe(
      `Nadia Over has more planned than fits in week ${Number(week.slice(6))}.`,
    )
    expect(summary?.urgency).toBeLessThan(30)

    // Not now: set aside until Monday; the week's later passes raise no second line.
    await db.execute(drizzleSql`
      UPDATE kernel.attention_events SET set_aside_until = now() + interval '3 days'
       WHERE org_id = ${orgId}::uuid AND user_id = ${lena}::uuid AND kind = ${CAPACITY_OVER_KIND}`)
    await raiseCapacityLines(orgId, now)
    expect(await capacityLines(lena)).toHaveLength(1)
    // Read: still none again that week.
    await db.execute(drizzleSql`
      UPDATE kernel.attention_events SET read_at = now()
       WHERE org_id = ${orgId}::uuid AND user_id = ${owner.userId}::uuid
         AND kind = ${CAPACITY_OVER_KIND}`)
    await raiseCapacityLines(orgId, now)
    expect(await capacityLines(owner.userId)).toHaveLength(1)

    // Next week is a new line, and last week's unread one is retired.
    const later = new Date(now.getTime() + 7 * 86_400_000)
    const nextWeek = isoWeekOf(later.toISOString().slice(0, 10))
    await raiseCapacityLines(orgId, later)
    const after = await capacityLines(lena)
    expect(after.map((l) => l.entity_id)).toEqual([`${nadia}:${week}`, `${nadia}:${nextWeek}`])
    expect(after[0]?.read_at).not.toBeNull()
    expect(after[1]?.read_at).toBeNull()
  })

  it("someone whose only task on the project is closed is not its lead", async () => {
    const closed = await task(project, paul, "1 h")
    await db.execute(drizzleSql`
      UPDATE app_projects.tasks SET completed_at = now() WHERE id = ${closed}::uuid`)
    const later = new Date(Date.now() + 14 * 86_400_000)
    await raiseCapacityLinesAll(later)
    expect(await capacityLines(paul)).toEqual([])
    // An open task makes them one.
    await task(project, paul, "1 h")
    await raiseCapacityLinesAll(new Date(Date.now() + 28 * 86_400_000))
    expect((await capacityLines(paul)).length).toBeGreaterThan(0)
  })

  it("the daily pass writes no capacity line for an org that is being moved", async () => {
    const later = new Date(Date.now() + 21 * 86_400_000)
    const week = isoWeekOf(later.toISOString().slice(0, 10))
    const ofWeek = async () =>
      (await capacityLines(lena)).filter((l) => l.entity_id === `${nadia}:${week}`)
    await db.execute(drizzleSql`
      UPDATE kernel.organizations
         SET transfer_state = 'frozen', transfer_id = ${crypto.randomUUID()}, transfer_at = now()
       WHERE id = ${orgId}::uuid`)
    try {
      await orgTransferView.refresh()
      await raiseCapacityLinesAll(later)
      expect(await ofWeek()).toEqual([])
    } finally {
      await db.execute(drizzleSql`
        UPDATE kernel.organizations
           SET transfer_state = NULL, transfer_id = NULL, transfer_at = NULL
         WHERE id = ${orgId}::uuid`)
      await orgTransferView.refresh()
    }
    // Once the move is over, the next pass raises it.
    await raiseCapacityLinesAll(later)
    expect(await ofWeek()).toHaveLength(1)
  })
})

describe("nothing reminds anyone", () => {
  it("sixty simulated days with no time entered leave no attention item or notification about time", async () => {
    const people = [await newPerson("Ana Quiet"), await newPerson("Ben Quiet")]
    const project = await newProject("Quiet client")
    await call("projects_timePlanSet", { projectId: project, basis: "hourly", billerId: people[0] })
    for (const p of people) await task(project, p, "6 h")
    const start = new Date().toISOString().slice(0, 10)
    const aboutTime =
      /took|task_time|timesheet|log(ged)? (your )?time|enter(ed)? (your )?(time|hours)|hours? (missing|due)|fill/i
    const seen: string[] = []
    for (let i = 0; i < 60; i++) {
      const now = noon(addCalendarDays(start, i))
      await raiseCapacityLines(orgId, now)
      await syncDaysOffCalendar(orgId, now)
      for (const p of people) {
        for (const item of await feed(p, now)) {
          if (aboutTime.test(`${item.kind} ${item.summary}`)) seen.push(`${i}:${item.summary}`)
        }
      }
    }
    expect(seen).toEqual([])
    const stored = extractRows<{ kind: string; summary: string }>(
      await db.execute(drizzleSql`
        SELECT kind, summary FROM kernel.attention_events
         WHERE org_id = ${orgId}::uuid AND user_id IN (${drizzleSql.join(
           people.map((p) => drizzleSql`${p}::uuid`),
           drizzleSql`, `,
         )})`),
    )
    expect(stored.filter((r) => aboutTime.test(`${r.kind} ${r.summary}`))).toEqual([])
    expect(stored.filter((r) => r.kind.includes("time_budgets"))).toEqual([])
    const notified = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM kernel.notification_deliveries
         WHERE org_id = ${orgId}::uuid AND user_id IN (${drizzleSql.join(
           people.map((p) => drizzleSql`${p}::uuid`),
           drizzleSql`, `,
         )})`),
    )[0]?.n
    expect(notified).toBe(0)
  }, 120_000)
})
