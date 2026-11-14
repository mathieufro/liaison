// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Capacity, company days off and time settings through the projects bridge on the real
// database: planned time from timeboxes only, available time from hours in a day, days per
// week, company days off and away days, people in name order, and who may set what.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { addCalendarDays, capacityNamedDays, isoWeekOf } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import type { AppEvent } from "~/infra/events/event-bus"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { resolveToolCard } from "~/modules/apps/result-card"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { processTranslationEvent } from "~/modules/attention/translator"
import { createDashboard, getBlockData } from "~/modules/dashboards/service"
import { setAway } from "~/modules/users/away"
import { deactivateUser } from "~/modules/users/service"
import { seedContext } from "~/seed/context"
import { seedTaskTime } from "~/seed/factories/projects/time"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { projectsAppManifest } from "../manifest-descriptor"
import { weekRange } from "./capacity"
import { awaitTimeFeatureSync } from "./time-feature"
import { awaitTimeRowWrites } from "./time-rows"
import { todayIn } from "./took"

const LEAD_SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "projects:capacity:read",
  "projects:capacity:write",
]
const MEMBER_SCOPES = ["projects:projects:read", "projects:tasks:read", "projects:tasks:write"]

let orgId = ""
let owner: minimal.Session

const addDays = addCalendarDays

const today = () => todayIn("UTC")
/** Next week, so every date the tests set lies ahead of today. */
const nextWeek = () => isoWeekOf(addDays(today(), 7))
const day = (n: number) => addDays(weekRange(nextWeek()).from, n) // 0 = Monday

function actorOf(userId: string, scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

async function call<T = Record<string, any>>(
  method: string,
  input: unknown,
  opts: { userId?: string; scopes?: string[]; origin?: "human-ui" | "in-app-agent" } = {},
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
      { origin: opts.origin ?? "human-ui" } as never,
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

async function newProject(name: string, on = true): Promise<string> {
  const made = await call<{ id: string }>("projects_createProject", { name })
  if (on) {
    await call("projects_updateProject", { projectId: made.id, timeBudgets: true })
    await awaitTimeFeatureSync(orgId)
  }
  return made.id
}

async function task(
  projectId: string,
  assigneeId: string,
  timebox: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const t = await call<{ id: string }>("projects_createTask", {
    projectId,
    title: `Work ${timebox}`,
    assigneeId,
    timebox,
    dueDate: day(2),
    ...extra,
  })
  if (!t.id) throw new Error(`task not created: ${JSON.stringify(t)}`)
  return t.id
}

const capacity = (input: Record<string, unknown> = {}, opts: { scopes?: string[] } = {}) =>
  call<Record<string, any>>("projects_capacityGet", { week: nextWeek(), ...input }, opts)

const personOf = (out: Record<string, any>, userId: string) =>
  (out.people as Array<Record<string, any>>).find((p) => p.userId === userId)

async function wipeDaysOff() {
  await db.execute(drizzleSql`DELETE FROM app_projects.days_off WHERE org_id = ${orgId}::uuid`)
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

describe("the week's figures", () => {
  const people: Record<string, string> = {}
  let projectId = ""

  beforeAll(async () => {
    projectId = await newProject("Atlas studio")
    // Ten people at 35 h; planned 44, 15, 28 and seven more for 336 h in all.
    const plan: Array<[string, number]> = [
      ["Yanis Faure", 36],
      ["Émilie Roux", 36],
      ["Nadia Colin", 44],
      ["Mathis Perrin", 15],
      ["Bastien Morel", 28],
      ["Chloé Garnier", 35],
      ["Inès Lambert", 35],
      ["Théo Vidal", 35],
      ["Léa Fontaine", 36],
      ["Hugo Marchal", 36],
    ]
    for (const [name, h] of plan) {
      people[name] = await newPerson(name)
      await task(projectId, people[name] as string, `${h} h`)
    }
  }, 120_000)

  it("next week reads 350 available and 336 planned with each person's figure in name order", async () => {
    const out = await capacity()
    expect(out.availableMinutes).toBe(350 * 60)
    expect(out.plannedMinutes).toBe(336 * 60)
    const names = (out.people as Array<{ name: string }>).map((p) => p.name)
    expect(names).toEqual([
      "Bastien Morel",
      "Chloé Garnier",
      "Émilie Roux",
      "Hugo Marchal",
      "Inès Lambert",
      "Léa Fontaine",
      "Mathis Perrin",
      "Nadia Colin",
      "Théo Vidal",
      "Yanis Faure",
    ])
    const nadia = personOf(out, people["Nadia Colin"] as string)
    expect([nadia?.plannedMinutes, nadia?.availableMinutes]).toEqual([44 * 60, 35 * 60])
    expect(nadia?.note).toBe("9 h more than fits")
    expect(personOf(out, people["Mathis Perrin"] as string)?.note).toBe("20 h free")
    expect(personOf(out, people["Bastien Morel"] as string)?.plannedMinutes).toBe(28 * 60)
  })

  it("a week where nobody has planned work says so and how time gets planned", async () => {
    expect((await capacity()).nothingPlanned).toBeUndefined()
    const far = isoWeekOf(addDays(today(), 40 * 7))
    const out = await capacity({ week: far })
    expect(out.people).toEqual([])
    const line = out.nothingPlanned as string
    expect(line).toStartWith(`Nobody has planned work in week ${Number(far.slice(6))}`)
    expect(line).toMatch(/no task on the \d+ projects? that uses? time and budgets has a timebox/)
    expect(line).toContain("giving a task a timebox and an assignee")
  })

  it("draws its card from the manifest within the card bound", async () => {
    const out = await capacity()
    const template = (projectsAppManifest as any).tools.capacity_get.resultCard
    const card = resolveToolCard(template, out)
    expect(card?.kind).toBe("groups")
    expect(card?.groups?.[0]?.rows.map((r) => r.name)?.slice(0, 2)).toEqual([
      "Bastien Morel",
      "Chloé Garnier",
    ])
    expect(new TextEncoder().encode(JSON.stringify(card)).length).toBeLessThan(24_576)
  })

  it("a hundred hours of Took leave capacity byte for byte", async () => {
    const before = JSON.stringify(await capacity())
    const someTask = extractRows<{ id: string }>(
      await db.execute(
        drizzleSql`SELECT id::text AS id FROM app_projects.tasks WHERE project_id = ${projectId}::uuid LIMIT 1`,
      ),
    )[0]?.id as string
    await seedTaskTime(seedContext({ orgId, now: new Date() }), actorOf(owner.userId), [
      { taskId: someTask, projectId, workDate: today(), minutes: 100 * 60 },
    ])
    expect(JSON.stringify(await capacity())).toBe(before)
  })

  it("an org with no days off gets full availability and nothing reads a country", async () => {
    await wipeDaysOff()
    const out = await capacity()
    for (const p of out.people as Array<{ availableMinutes: number }>) {
      expect(p.availableMinutes).toBe(35 * 60)
    }
    const src = readFileSync(join(import.meta.dir, "capacity.ts"), "utf8")
    const daysOff = readFileSync(join(import.meta.dir, "days-off.ts"), "utf8")
    expect(`${src}\n${daysOff}`).not.toMatch(/country|holiday_data|issuer/i)
  })

  it("a day, a range and a week from the tool and from settings land in the same table and count at once", async () => {
    await wipeDaysOff()
    const one = await call("projects_daysOffSet", { on: day(0), label: "Founding day" })
    expect(one.created).toBe(true)
    expect(one.resolved.days).toHaveLength(1)
    expect((await capacity()).availableMinutes).toBe(10 * 28 * 60)
    // The same row again reports it as already there.
    expect((await call("projects_daysOffSet", { on: day(0) })).created).toBe(false)
    // A range, as the settings list saves it (origin human-ui), then an agent's week.
    await call("projects_daysOffSet", { from: day(1), to: day(1) })
    expect((await capacity()).availableMinutes).toBe(10 * 21 * 60)
    const listed = await call<{
      rows: Array<{ from: string; fromCalendar: boolean; source: string | null }>
    }>("projects_daysOffList", {})
    expect(listed.rows.map((r) => r.from)).toEqual([day(0), day(1)])
    expect(listed.rows.every((r) => r.fromCalendar === false && r.source === null)).toBe(true)
    const [y, w] = nextWeek().split("-W")
    const week = await call("projects_daysOffSet", { week: Number(w), weekYear: Number(y) })
    expect(week.resolved).toMatchObject({ from: day(0), to: day(6) })
    expect((await capacity()).availableMinutes).toBe(0)
    await wipeDaysOff()
  })

  it("removing a typed day off restores the figure and a calendar row stays", async () => {
    await call("projects_daysOffSet", { on: day(3) })
    await db.execute(drizzleSql`
      UPDATE app_projects.days_off SET source_event_id = gen_random_uuid(), label = 'Team offsite'
       WHERE org_id = ${orgId}::uuid AND starts_on = ${day(3)}::date`)
    await call("projects_daysOffSet", { on: day(4) })
    const out = await call("projects_daysOffRemove", { on: day(4) })
    expect(out.removed).toHaveLength(1)
    const listed = await call("projects_daysOffList", {})
    // The calendar row is read back without its event title, marked for the settings list.
    expect(listed.rows).toEqual([
      expect.objectContaining({
        from: day(3),
        fromCalendar: true,
        source: "calendar",
        label: null,
      }),
    ])
    const kept = await call("projects_daysOffRemove", { on: day(3) })
    expect([kept.removed.length, kept.fromCalendar.length]).toEqual([0, 1])
    await wipeDaysOff()
  })

  it("a colleague's day off shows only as a lower available figure", async () => {
    const nadia = people["Nadia Colin"] as string
    const before = personOf(await capacity(), nadia)
    await setAway({
      orgId,
      actorId: nadia,
      actorScopes: MEMBER_SCOPES,
      form: { on: day(1) },
    })
    const after = personOf(await capacity({}, { scopes: LEAD_SCOPES }), nadia)
    expect(after?.availableMinutes).toBe(28 * 60)
    const { availableMinutes: _a, note: _n, ...restAfter } = after ?? {}
    const { availableMinutes: _b, note: _m, ...restBefore } = before ?? {}
    expect(restAfter).toEqual(restBefore)
    const keys = Object.keys(after ?? {}).sort()
    expect(keys).toEqual(["availableMinutes", "name", "note", "plannedMinutes", "tasks", "userId"])
    expect(JSON.stringify(after)).not.toContain(day(1))
  })

  it("a day off added after planning moves nothing and asks nobody", async () => {
    const tasksBefore = extractRows(
      await db.execute(
        drizzleSql`SELECT id, due_date, assignee_id FROM app_projects.tasks WHERE project_id = ${projectId}::uuid ORDER BY id`,
      ),
    )
    const eventsBefore = extractRows<{ n: number }>(
      await db.execute(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.attention_events WHERE org_id = ${orgId}::uuid`,
      ),
    )[0]?.n
    await call("projects_daysOffSet", { on: day(2) })
    const out = await capacity()
    expect(personOf(out, people["Chloé Garnier"] as string)?.note).toBe("7 h more than fits")
    const tasksAfter = extractRows(
      await db.execute(
        drizzleSql`SELECT id, due_date, assignee_id FROM app_projects.tasks WHERE project_id = ${projectId}::uuid ORDER BY id`,
      ),
    )
    expect(tasksAfter).toEqual(tasksBefore)
    const eventsAfter = extractRows<{ n: number }>(
      await db.execute(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.attention_events WHERE org_id = ${orgId}::uuid`,
      ),
    )[0]?.n
    expect(eventsAfter).toBe(eventsBefore)
    await call("projects_daysOffRemove", { on: day(2) })
    expect(personOf(await capacity(), people["Chloé Garnier"] as string)?.note).toBeNull()
  })

  it("who can take this answers from capacity and membership only", async () => {
    const extra = await task(projectId, people["Mathis Perrin"] as string, "10 h", {
      dueDate: addDays(day(0), 21),
    })
    const out = await capacity({ taskId: extra })
    const candidates = out.candidates as Array<Record<string, unknown>>
    expect(candidates.map((c) => c.name)).toEqual(["Mathis Perrin"])
    expect(candidates[0]).toEqual({
      userId: people["Mathis Perrin"],
      name: "Mathis Perrin",
      freeMinutes: 20 * 60,
      onProject: true,
    })
    expect(JSON.stringify(out)).not.toMatch(/real|took|commit|trace|entered"/i)
    expect(out.covers).toContain("projects that use time and budgets")
  })

  it("who can take this reads a task key too, and refuses anything else by name", async () => {
    const extra = await task(projectId, people["Mathis Perrin"] as string, "1 h", {
      dueDate: addDays(day(0), 21),
    })
    const key = extractRows<{ key: string }>(
      await db.execute(drizzleSql`
        SELECT p.key || '-' || t.number::text AS key FROM app_projects.tasks t
          JOIN app_projects.projects p ON p.id = t.project_id WHERE t.id = ${extra}::uuid`),
    )[0]!.key
    const byKey = await capacity({ taskId: key })
    expect(byKey.error).toBeUndefined()
    expect(byKey.taskId).toBe(extra)
    for (const taskId of ["not a task", "NOPE-999"]) {
      const out = await capacity({ taskId })
      expect(["invalid_id", "not_found"]).toContain(out.error?.code)
      expect(JSON.stringify(out)).not.toContain("22P02")
    }
  })

  it("a dashboard block on capacity_get saves and runs", async () => {
    const viewer = actorOf(owner.userId)
    const d = await createDashboard(viewer, {
      title: "Capacity",
      visibility: "personal",
      spec: {
        v: 1,
        blocks: [
          {
            id: "b",
            type: "metric",
            title: "People planned",
            source: {
              kind: "tool",
              tool: "projects:capacity_get",
              params: { week: nextWeek() },
              rowsPath: "people",
            },
            map: { agg: "count" },
          },
        ],
      },
    } as never)
    expect(await getBlockData(viewer, d.id, "b")).toMatchObject({
      ok: true,
      data: { kind: "metric", value: 10 },
    })
  })
})

describe("days per week", () => {
  let four = ""
  let five = ""

  beforeAll(async () => {
    const projectId = await newProject("Orbit part time")
    four = await newPerson("Agathe Part")
    five = await newPerson("Bruno Full")
    await task(projectId, four, "20 h")
    await task(projectId, five, "20 h")
  }, 60_000)

  it("a four-day person reads 28, 28 and 21 hours with none, one and two company days off, and 0 and 6 are refused", async () => {
    await wipeDaysOff()
    for (const bad of [0, 6]) {
      const r = await call(
        "projects_timeSettingsSet",
        { daysPerWeek: bad },
        {
          userId: four,
          scopes: MEMBER_SCOPES,
        },
      )
      expect(r.error?.code).toBe("days_per_week_invalid")
    }
    for (const ok of [1, 5]) {
      const r = await call(
        "projects_timeSettingsSet",
        { daysPerWeek: ok },
        {
          userId: four,
          scopes: MEMBER_SCOPES,
        },
      )
      expect(r.person).toEqual({ userId: four, daysPerWeek: ok })
    }
    await call(
      "projects_timeSettingsSet",
      { daysPerWeek: 4 },
      { userId: four, scopes: MEMBER_SCOPES },
    )
    const read = () => capacity()
    const a = await read()
    expect(personOf(a, four)?.availableMinutes).toBe(28 * 60)
    await call("projects_daysOffSet", { on: day(0) })
    expect(personOf(await read(), four)?.availableMinutes).toBe(28 * 60)
    await call("projects_daysOffSet", { on: day(1) })
    const c = await read()
    expect(personOf(c, four)?.availableMinutes).toBe(21 * 60)
    // Only the available figure tells the two apart.
    expect(Object.keys(personOf(c, four) ?? {})).toEqual(Object.keys(personOf(c, five) ?? {}))
    expect(personOf(c, four)?.plannedMinutes).toBe(personOf(c, five)?.plannedMinutes)
    expect(personOf(await read(), five)?.availableMinutes).toBe(21 * 60)
    await wipeDaysOff()
  })

  it("company days need settings admin; one person's need that person, user admin or capacity write; others are refused", async () => {
    const byMember = await call(
      "projects_daysOffSet",
      { on: day(0) },
      {
        userId: five,
        scopes: MEMBER_SCOPES,
      },
    )
    expect(byMember.error?.code).toBe("not_allowed")
    const other = await call(
      "projects_timeSettingsSet",
      { userId: four, daysPerWeek: 3 },
      {
        userId: five,
        scopes: MEMBER_SCOPES,
      },
    )
    expect(other.error?.code).toBe("not_allowed")
    const hours = await call(
      "projects_timeSettingsSet",
      { hoursPerDay: 8 },
      {
        userId: five,
        scopes: MEMBER_SCOPES,
      },
    )
    expect(hours.error?.code).toBe("not_allowed")
    const lead = await newPerson("Lena Lead")
    const byLead = await call(
      "projects_timeSettingsSet",
      { userId: four, daysPerWeek: 3 },
      {
        userId: lead,
        scopes: LEAD_SCOPES,
      },
    )
    expect(byLead.person).toEqual({ userId: four, daysPerWeek: 3 })
    const byAdmin = await call(
      "projects_timeSettingsSet",
      { userId: four, daysPerWeek: 4 },
      { userId: owner.userId, scopes: ["kernel:users:admin", "projects:projects:read"] },
    )
    expect(byAdmin.person).toEqual({ userId: four, daysPerWeek: 4 })
    const read = await call(
      "projects_timeSettingsGet",
      { userId: four },
      {
        userId: five,
        scopes: MEMBER_SCOPES,
      },
    )
    expect(read.error?.code).toBe("not_allowed")
    expect(
      (
        await call(
          "projects_timeSettingsGet",
          { userId: four },
          { userId: four, scopes: MEMBER_SCOPES },
        )
      ).daysPerWeek,
    ).toBe(4)
  })

  it("someone else's days per week give the person a line naming who set it", async () => {
    const lead = await newPerson("Paul Lead")
    await call(
      "projects_timeSettingsSet",
      { userId: four, daysPerWeek: 2 },
      {
        userId: lead,
        scopes: LEAD_SCOPES,
      },
    )
    const rows = extractRows<{ summary: string }>(
      await db.execute(drizzleSql`
        SELECT payload->'data'->>'summary' AS summary FROM kernel.pending_events
         WHERE org_id = ${orgId}::uuid
           AND payload->'data'->'capacityNamed'->>'setBy' = ${lead}`),
    )
    expect(rows.map((r) => r.summary)).toEqual([
      "Paul Lead set your days per week to 2. Back to 5 days: ask your agent, or set it in your Projects time settings",
    ])
  })

  it("the Home row the kernel makes from that line carries what Back to 5 days needs", async () => {
    const lead = await newPerson("Rita Lead")
    const target = await newPerson("Bruno Part")
    await call(
      "projects_timeSettingsSet",
      { userId: target, daysPerWeek: 3 },
      { userId: lead, scopes: LEAD_SCOPES },
    )
    const events = extractRows<{ payload: AppEvent }>(
      await db.execute(drizzleSql`
        SELECT payload FROM kernel.pending_events
         WHERE org_id = ${orgId}::uuid
           AND payload->'data'->'capacityNamed'->>'setBy' = ${lead}`),
    )
    expect(events).toHaveLength(1)
    // The real translator, with its real insert: the row is what Home reads.
    await processTranslationEvent(events[0]?.payload as AppEvent)
    const rows = extractRows<{ kind: string; metadata: Record<string, unknown> | null }>(
      await db.execute(drizzleSql`
        SELECT kind, metadata FROM kernel.attention_events
         WHERE org_id = ${orgId}::uuid AND user_id = ${target}::uuid`),
    )
    expect(rows.map((r) => r.kind)).toEqual(["agent_notification"])
    // The same reader the Home row's button is drawn from.
    expect(capacityNamedDays({ metadata: rows[0]?.metadata ?? null })).toBe(3)
    // The lead who set it gets no row.
    const leadRows = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM kernel.attention_events
         WHERE org_id = ${orgId}::uuid AND user_id = ${lead}::uuid`),
    )
    expect(leadRows[0]?.n).toBe(0)
  })
})

describe("an agent acting for someone", () => {
  it("an agent may set days off and days per week exactly as far as the person it acts for", async () => {
    const asAgent = { origin: "in-app-agent" as const }
    const member = await newPerson("Mina Member")
    const colleague = await newPerson("Cole Colleague")
    const lead = await newPerson("Leo Lead")
    // Company days: only for a settings admin.
    const memberDay = await call(
      "projects_daysOffSet",
      { on: day(4) },
      { ...asAgent, userId: member, scopes: MEMBER_SCOPES },
    )
    expect(memberDay.error?.code).toBe("not_allowed")
    const adminDay = await call(
      "projects_daysOffSet",
      { on: day(4) },
      { ...asAgent, scopes: ["projects:settings:admin", "projects:projects:read"] },
    )
    expect(adminDay.created).toBe(true)
    const [{ via } = { via: "" }] = extractRows<{ via: string }>(
      await db.execute(drizzleSql`
        SELECT created_via AS via FROM app_projects.days_off WHERE id = ${adminDay.id}::uuid`),
    )
    expect(via).toBe("agent")
    await call("projects_daysOffRemove", { on: day(4) })
    // One person's days per week: their own, or a holder of capacity write or user admin.
    const own = await call(
      "projects_timeSettingsSet",
      { daysPerWeek: 4 },
      { ...asAgent, userId: member, scopes: MEMBER_SCOPES },
    )
    expect(own.person).toEqual({ userId: member, daysPerWeek: 4 })
    const forOther = await call(
      "projects_timeSettingsSet",
      { userId: colleague, daysPerWeek: 3 },
      { ...asAgent, userId: member, scopes: MEMBER_SCOPES },
    )
    expect(forOther.error?.code).toBe("not_allowed")
    const byLead = await call(
      "projects_timeSettingsSet",
      { userId: colleague, daysPerWeek: 3 },
      { ...asAgent, userId: lead, scopes: LEAD_SCOPES },
    )
    expect(byLead.person).toEqual({ userId: colleague, daysPerWeek: 3 })
    const byAdmin = await call(
      "projects_timeSettingsSet",
      { userId: colleague, daysPerWeek: 5 },
      { ...asAgent, scopes: ["kernel:users:admin", "projects:projects:read"] },
    )
    expect(byAdmin.person).toEqual({ userId: colleague, daysPerWeek: 5 })
    const hours = await call(
      "projects_timeSettingsSet",
      { hoursPerDay: 8 },
      { ...asAgent, userId: lead, scopes: LEAD_SCOPES },
    )
    expect(hours.error?.code).toBe("not_allowed")
  })
})

describe("away days of a colleague", () => {
  it("a lead with capacity write sets a colleague's away days at once", async () => {
    const roles = (projectsAppManifest as any).roles
    const leadScopes: string[] = [...roles.member.scopes, ...roles.lead.scopes]
    expect(leadScopes).toContain("projects:capacity:write")
    const lead = await newPerson("Iris Lead")
    const colleague = await newPerson("Oscar Team")
    const out = await setAway({
      orgId,
      actorId: lead,
      actorScopes: leadScopes,
      userId: colleague,
      form: { on: day(3) },
    })
    expect(out).toMatchObject({ ok: true, action: "set" })
    const rows = extractRows<{ source: string; set_by: string }>(
      await db.execute(drizzleSql`
        SELECT source, set_by::text AS set_by FROM kernel.away_ranges WHERE user_id = ${colleague}::uuid`),
    )
    expect(rows).toEqual([{ source: "lead", set_by: lead }])
  })
})

describe("people who left and projects that do not use time", () => {
  it("a person who left is refused, and their open timeboxes show in one quiet row", async () => {
    const projectId = await newProject("Leaving studio")
    const leaver = await newPerson("Rémi Gone")
    await task(projectId, leaver, "12 h")
    await call("projects_timeSettingsSet", { userId: leaver, daysPerWeek: 3 }, { scopes: ["*"] })
    await withPrivilegedDb(orgId, "test-deactivate", (tx) =>
      deactivateUser(tx, {
        targetId: leaver,
        actorId: owner.userId,
        orgId,
        actorScopes: ["*"],
      }),
    )
    const out = await capacity()
    expect(personOf(out, leaver)).toBeUndefined()
    expect(out.left).toEqual([expect.objectContaining({ title: "Work 12 h", minutes: 12 * 60 })])
    expect(out.groups.at(-1).label).toBe("Assigned to people who have left")
    const refused = await call("projects_timeSettingsSet", { userId: leaver, daysPerWeek: 4 })
    expect(refused.error?.code).toBe("person_inactive")
    const kept = extractRows(
      await db.execute(
        drizzleSql`SELECT 1 FROM app_projects.person_capacity WHERE user_id = ${leaver}::uuid`,
      ),
    )
    expect(kept).toEqual([])
  })

  it("capacity counts only projects using time", async () => {
    const counted = await newProject("Marked project")
    const plain = await newProject("Plain studio", false)
    const both = await newPerson("Vera Both")
    const onlyPlain = await newPerson("Walt Plain")
    await task(counted, both, "20 h")
    // Timeboxes kept on a project that does not use time: laid directly, as one turned off keeps them.
    for (const who of [both, both, both, onlyPlain]) {
      const t = await call<{ id: string }>("projects_createTask", {
        projectId: plain,
        title: "Plain work",
        assigneeId: who,
        dueDate: day(2),
      })
      await db.execute(
        drizzleSql`UPDATE app_projects.tasks SET timebox_minutes = 600 WHERE id = ${t.id}::uuid`,
      )
    }
    let out = await capacity()
    expect(personOf(out, both)?.plannedMinutes).toBe(20 * 60)
    expect(personOf(out, onlyPlain)).toBeUndefined()
    // Turned off, its timeboxes add nothing; turned back on, they return.
    await call("projects_updateProject", { projectId: counted, timeBudgets: false })
    await awaitTimeFeatureSync(orgId)
    out = await capacity()
    expect(personOf(out, both)).toBeUndefined()
    await call("projects_updateProject", { projectId: counted, timeBudgets: true })
    await awaitTimeFeatureSync(orgId)
    expect(personOf(await capacity(), both)?.plannedMinutes).toBe(20 * 60)
  })
})

describe("moving a task from the capacity board", () => {
  let projectId = ""
  let lead = ""
  let nadia = ""
  let mathis = ""

  const assigneeOf = async (taskId: string) =>
    extractRows<{ assignee: string | null; timebox: number | null; due: string | null }>(
      await db.execute(drizzleSql`
        SELECT assignee_id::text AS assignee, timebox_minutes AS timebox, due_date::text AS due
          FROM app_projects.tasks WHERE id = ${taskId}::uuid`),
    )[0]
  const linesAbout = async (taskId: string) =>
    extractRows<{ target: string; summary: string }>(
      await db.execute(drizzleSql`
        SELECT payload->'data'->'targetUserIds'->>0 AS target, payload->'data'->>'summary' AS summary
          FROM kernel.pending_events
         WHERE org_id = ${orgId}::uuid AND payload->>'entity' = 'agent_notification'
           AND payload->>'entityId' = ${taskId}`),
    )
  const approvalCount = async () =>
    extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${orgId}::uuid`),
    )[0]?.n

  beforeAll(async () => {
    projectId = await newProject("Orbit board")
    lead = await newPerson("Léa Lead")
    nadia = await newPerson("Nadia Board")
    mathis = await newPerson("Mathis Board")
  })

  it("moves the task to the person named, tells both, and keeps its timebox and dates", async () => {
    const moving = await task(projectId, nadia, "16 h", { dueDate: day(4) })
    const before = await assigneeOf(moving)
    const approvalsBefore = await approvalCount()
    const out = await call(
      "projects_capacityMove",
      { taskId: moving, toUserId: mathis },
      {
        userId: lead,
        scopes: LEAD_SCOPES,
      },
    )
    expect(out.moved).toBe(true)
    expect(out.from).toEqual({ userId: nadia, name: "Nadia Board" })
    expect(out.to).toEqual({ userId: mathis, name: "Mathis Board" })
    expect(out.told).toEqual(["Mathis Board", "Nadia Board"])
    expect(out.message).toContain(
      "is now with Mathis Board. Mathis Board and Nadia Board were both told.",
    )
    expect(out.message).toContain("To undo, move it back to Nadia Board.")
    const after = await assigneeOf(moving)
    expect(after).toEqual({ ...before, assignee: mathis })
    const key = out.task.key as string
    const lines = await linesAbout(moving)
    expect(lines).toHaveLength(2)
    expect(lines).toEqual(
      expect.arrayContaining([
        { target: mathis, summary: `Léa Lead moved ${key} to you` },
        { target: nadia, summary: `Léa Lead moved ${key} to Mathis Board` },
      ]),
    )
    // The presser's own act: nothing waits for anyone's approval.
    expect(await approvalCount()).toBe(approvalsBefore)
    // The board reads it at once: the planned time is now Mathis's.
    const board = await capacity()
    expect(personOf(board, mathis)?.tasks.map((t: { id: string }) => t.id)).toContain(moving)
    expect(personOf(board, nadia)?.tasks.map((t: { id: string }) => t.id) ?? []).not.toContain(
      moving,
    )
    expect(JSON.stringify(out)).not.toMatch(/took|entered|utili|rank/i)
  })

  it("undo is the same press back, and moving it to whoever holds it changes nothing", async () => {
    const moving = await task(projectId, nadia, "4 h", { dueDate: day(3) })
    await call(
      "projects_capacityMove",
      { taskId: moving, toUserId: mathis },
      { userId: lead, scopes: LEAD_SCOPES },
    )
    const back = await call(
      "projects_capacityMove",
      { taskId: moving, toUserId: nadia },
      {
        userId: lead,
        scopes: LEAD_SCOPES,
      },
    )
    expect(back.moved).toBe(true)
    expect((await assigneeOf(moving))?.assignee).toBe(nadia)
    const lines = (await linesAbout(moving)).length
    const same = await call(
      "projects_capacityMove",
      { taskId: moving, toUserId: nadia },
      {
        userId: lead,
        scopes: LEAD_SCOPES,
      },
    )
    expect(same.moved).toBe(false)
    expect(same.message).toContain("Nothing changed and nobody was told.")
    expect((await linesAbout(moving)).length).toBe(lines)
  })

  it("a move from unassigned says how to undo it, and the undo leaves the task with nobody", async () => {
    const moving = await task(projectId, nadia, "1 h", { dueDate: day(3), assigneeId: null })
    expect((await assigneeOf(moving))?.assignee).toBeNull()
    const out = await call(
      "projects_capacityMove",
      { taskId: moving, toUserId: mathis },
      { userId: lead, scopes: LEAD_SCOPES },
    )
    expect(out.moved).toBe(true)
    expect(out.from).toBeNull()
    expect(out.message).toContain("To undo, leave it unassigned again (toUserId null).")
    const back = await call(
      "projects_capacityMove",
      { taskId: moving, toUserId: null },
      { userId: lead, scopes: LEAD_SCOPES },
    )
    expect(back.moved).toBe(true)
    expect(back.to).toBeNull()
    expect(back.told).toEqual(["Mathis Board"])
    expect((await assigneeOf(moving))?.assignee).toBeNull()
    const again = await call(
      "projects_capacityMove",
      { taskId: moving, toUserId: null },
      { userId: lead, scopes: LEAD_SCOPES },
    )
    expect(again.moved).toBe(false)
    expect(again.message).toContain("already unassigned")
  })

  it("the person moving their own task away tells only the one who takes it", async () => {
    const moving = await task(projectId, nadia, "2 h", { dueDate: day(3) })
    const out = await call(
      "projects_capacityMove",
      { taskId: moving, toUserId: mathis },
      {
        userId: nadia,
        scopes: LEAD_SCOPES,
      },
    )
    expect(out.told).toEqual(["Mathis Board"])
    expect((await linesAbout(moving)).map((l) => l.target)).toEqual([mathis])
  })

  it("refuses a person who left or a task that does not exist, and moves nothing", async () => {
    const moving = await task(projectId, nadia, "3 h", { dueDate: day(3) })
    const gone = await newPerson("Gone Board")
    await db.execute(
      drizzleSql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${gone}::uuid`,
    )
    const refused = await call(
      "projects_capacityMove",
      { taskId: moving, toUserId: gone },
      {
        userId: lead,
        scopes: LEAD_SCOPES,
      },
    )
    expect(refused.error?.code).toBe("person_unavailable")
    expect(refused.error?.message).toContain("was not moved")
    expect((await assigneeOf(moving))?.assignee).toBe(nadia)
    const missing = await call(
      "projects_capacityMove",
      { taskId: "NOPE-999", toUserId: mathis },
      {
        userId: lead,
        scopes: LEAD_SCOPES,
      },
    )
    expect(["invalid_id", "not_found"]).toContain(missing.error?.code)
    expect(await linesAbout(moving)).toEqual([])
  })
})
