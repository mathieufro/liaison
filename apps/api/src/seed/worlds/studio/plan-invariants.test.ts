// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The services world's plan held to its invariants with no database: the
// fixed-price milestones, last month's dated lines, the day-rate month, the
// 180 h project, next week's capacity, this month's retainer hours and the
// team, at the board date and at anchors across a year (month starts and
// ends included).
import { describe, expect, it } from "bun:test"
import { addCalendarDays, isoWeekdayOf } from "@liaison/shared"
import { scanWorldPackDir } from "~/seed/worlds/prose-guard"
import { STUDIO_DELIVERY_KEYS, STUDIO_TEAM } from "./fiction"
import {
  inNameOrder,
  parisCivil,
  STUDIO_COST_RATES,
  STUDIO_DATED_LINES,
  type StudioPlan,
  type StudioProjectPlan,
  studioBoardCounts,
  studioPlan,
} from "./plan"

const BOARD_DATE = new Date("2026-11-09T08:30:00Z")

/**
 * The sweep: one anchor a week for 13 months from the board date, every
 * month's 1st (at 00:30 Paris, just after the month turns, and mid-morning),
 * the 2nd, the 28th to the 31st, a Sunday the 1st, 1 January and 29 February.
 */
function anchors(): Date[] {
  const out = new Map<number, Date>([[BOARD_DATE.getTime(), BOARD_DATE]])
  const add = (d: Date) => out.set(d.getTime(), d)
  for (let w = 1; w <= 57; w++) add(new Date(BOARD_DATE.getTime() + w * 7 * 86_400_000))
  for (let m = 0; m < 14; m++) {
    // 00:30 Paris on the 1st is 23:30 or 22:30 UTC the day before.
    add(new Date(Date.UTC(2026, 10 + m, 1, 0, 30) - 3_600_000))
    for (const day of [1, 2, 28, 29, 30, 31]) {
      const at = new Date(Date.UTC(2026, 10 + m, day, 7, 15))
      if (at.getUTCDate() === day) add(at)
    }
  }
  add(new Date(Date.UTC(2027, 7, 1, 10, 0))) // Sunday 1 August 2027
  add(new Date(Date.UTC(2028, 0, 1, 10, 0)))
  add(new Date(Date.UTC(2028, 1, 29, 10, 0)))
  return [...out.values()]
}

/** Next week's hours per person, as the board shows them. */
const NEXT_WEEK_HOURS: Record<string, number> = {
  bastien: 28,
  clara: 35,
  emma: 36,
  hugo: 36,
  lina: 35,
  mathis: 15,
  nadia: 44,
  paul: 37,
  sofia: 34,
  yanis: 36,
}

/** Last month's dated lines as the board lists them: ordinal weekday, person, task, hours. */
const BOARD_DATED_LINES: ReadonlyArray<readonly [number, string, string, number]> = [
  [1, "emma", "SOREL-21", 2],
  [3, "nadia", "SOREL-19", 3],
  [4, "sofia", "SOREL-18", 4],
  [5, "sofia", "SOREL-18", 5],
  [6, "bastien", "SOREL-16", 3],
  [7, "nadia", "SOREL-19", 4],
  [8, "sofia", "SOREL-18", 5],
  [10, "emma", "SOREL-21", 3],
  [11, "nadia", "SOREL-20", 4],
  [13, "sofia", "SOREL-18", 4],
  [14, "emma", "SOREL-17", 1],
  [16, "nadia", "SOREL-20", 3],
  [18, "emma", "SOREL-21", 4],
  [20, "emma", "SOREL-17", 1],
]

const project = (plan: StudioPlan, key: string): StudioProjectPlan => {
  const found = plan.projects.find((p) => p.key === key)
  if (!found) throw new Error(`no project ${key}`)
  return found
}

const hoursOf = (rows: readonly { minutes: number }[]) =>
  rows.reduce((n, r) => n + r.minutes, 0) / 60

const monthOf = (civil: string) => civil.slice(0, 7)
const lastMonthOf = (civil: string) => {
  const [y, m] = civil.split("-").map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`
}

/**
 * Capacity's placement, worked by hand over the plan: leaf tasks with a
 * timebox and an assignee, open, on projects using time and budgets, placed
 * whole in the ISO week of their due date. The people are those holding such
 * a task in the week or later.
 */
function weekLoad(plan: StudioPlan, from: string, to: string) {
  const planned = new Map<string, Array<{ key: string; minutes: number }>>()
  const later = new Set<string>()
  for (const p of plan.projects.filter((x) => x.timeBudgets)) {
    const parents = new Set(p.tasks.map((t) => t.parent).filter(Boolean))
    for (const t of p.tasks) {
      if (parents.has(t.key) || !t.timeboxMinutes || !t.assignee || t.status === "done") continue
      const due = t.dueOn ?? plan.today
      if (due > to) later.add(t.assignee)
      if (due < from || due > to) continue
      later.add(t.assignee)
      planned.set(t.assignee, [
        ...(planned.get(t.assignee) ?? []),
        { key: t.key, minutes: t.timeboxMinutes },
      ])
    }
  }
  return [...later].map((person) => {
    const tasks = planned.get(person) ?? []
    return { person, tasks, minutes: tasks.reduce((n, t) => n + t.minutes, 0) }
  })
}

describe("services world plan", () => {
  it("the sweep covers a week at a time for 13 months, the 1st and 2nd of every month, and 29 February", () => {
    const days = anchors().map((d) => parisCivil(d))
    expect(anchors().filter((d) => d.getTime() > BOARD_DATE.getTime()).length).toBeGreaterThan(57)
    expect(days).toContain("2027-08-01")
    expect(days).toContain("2028-02-29")
    expect(days.filter((d) => d.endsWith("-01")).length).toBeGreaterThanOrEqual(14)
  })

  for (const anchor of anchors()) {
    const at = anchor.toISOString()
    const plan = studioPlan(anchor)

    it(`planned 420 and real 346 per milestone sums at ${at}`, () => {
      const marlin = project(plan, "MARLIN")
      const milestones = marlin.tasks.filter((t) => t.isMilestone)
      expect(milestones.map((m) => m.title)).toEqual(["Discovery", "Design", "Beta", "Launch"])
      expect(milestones.map((m) => (m.timeboxMinutes ?? 0) / 60)).toEqual([52, 78, 200, 90])
      expect(milestones.reduce((n, m) => n + (m.timeboxMinutes ?? 0), 0) / 60).toBe(420)
      const time = plan.taskTime.filter((r) => r.project === "MARLIN")
      const realOf = (milestone: string) =>
        hoursOf(
          time.filter((r) => marlin.tasks.find((t) => t.key === r.task)?.parent === milestone),
        )
      expect(milestones.map((m) => realOf(m.key))).toEqual([48, 81, 189, 28])
      expect(hoursOf(time)).toBe(346)
      // 41 done, 5 in progress, 4 to do; real time on 41 of the 46 started or closed.
      const counts = studioBoardCounts(plan).MARLIN
      expect(counts).toEqual({ todo: 4, in_progress: 5, done: 41 })
      const withTime = new Set(time.map((r) => r.task))
      expect(withTime.size).toBe(41)
      const started = marlin.tasks.filter((t) => t.status !== "todo")
      expect(started.length).toBe(46)
      expect(started.filter((t) => withTime.has(t.key)).length).toBe(41)
      expect(marlin.tasks.filter((t) => t.status === "done" && !withTime.has(t.key)).length).toBe(3)
      // Beta: 16 of its 20 done.
      const beta = marlin.tasks.filter((t) => t.key === "MARLIN-19" || t.parent === "MARLIN-19")
      expect(beta.length).toBe(20)
      expect(beta.filter((t) => t.status === "done").length).toBe(16)
      expect(project(plan, "MARLIN").fixedPriceMinor).toBe(4 * 1_600_000)
    })

    it(`the dated lines sum to 46 on working days at ${at}`, () => {
      const lastMonth = lastMonthOf(plan.today)
      const rows = plan.taskTime.filter(
        (r) => r.project === "SOREL" && monthOf(r.workDate) === lastMonth,
      )
      expect(rows.length).toBe(14)
      expect(hoursOf(rows)).toBe(46)
      expect(rows.every((r) => isoWeekdayOf(r.workDate) <= 5)).toBe(true)
      expect(plan.daysOff).toEqual([])
      // Each line is on the board's ordinal weekday of last month.
      const weekdays: string[] = []
      for (let d = `${lastMonth}-01`; monthOf(d) === lastMonth; d = addCalendarDays(d, 1)) {
        if (isoWeekdayOf(d) <= 5) weekdays.push(d)
      }
      expect(rows.map((r) => [r.workDate, r.person, r.task, r.minutes / 60])).toEqual(
        BOARD_DATED_LINES.map(([k, who, task, h]) => [weekdays[k - 1], who, task, h]),
      )
      expect(STUDIO_DATED_LINES).toEqual(BOARD_DATED_LINES)
      expect([...new Set(rows.map((r) => r.task))].sort()).toEqual([
        "SOREL-16",
        "SOREL-17",
        "SOREL-18",
        "SOREL-19",
        "SOREL-20",
        "SOREL-21",
      ])
      const partial = rows.filter((r) => r.task !== "SOREL-17" && r.task !== "SOREL-16")
      expect(hoursOf(partial)).toBe(41)
      expect(new Set(partial.map((r) => r.task)).size).toBe(4)
      // The six are closed last month, after their last line.
      for (const t of project(plan, "SOREL").tasks.filter((x) =>
        rows.some((r) => r.task === x.key),
      )) {
        expect(t.status).toBe("done")
        expect(monthOf(parisCivil(t.completedAt as Date))).toBe(lastMonth)
      }
    })

    it(`next week's planned hours are each person's tasks at ${at}`, () => {
      expect(isoWeekdayOf(plan.nextWeek.from)).toBe(1)
      expect(plan.nextWeek.from > plan.today).toBe(true)
      expect(addCalendarDays(plan.today, 7) >= plan.nextWeek.from).toBe(true)
      const load = weekLoad(plan, plan.nextWeek.from, plan.nextWeek.to)
      const byPerson = Object.fromEntries(load.map((l) => [l.person, l.minutes / 60]))
      expect(byPerson).toEqual(NEXT_WEEK_HOURS)
      expect(load.reduce((n, l) => n + l.minutes, 0) / 60).toBe(336)
      // Ten people at 5 days of 7 h, nobody of them away, no company day off.
      const away = new Set(plan.away.map((a) => a.person))
      expect(load.some((l) => away.has(l.person))).toBe(false)
      expect(load.length * 5 * plan.hoursPerDayMinutes).toBe(350 * 60)
      const nadia = load.find((l) => l.person === "nadia")
      expect(nadia?.tasks.map((t) => t.minutes / 60)).toEqual([16, 8, 8, 12])
      const mathis = load.find((l) => l.person === "mathis")
      expect(mathis?.tasks.map((t) => t.minutes / 60)).toEqual([4, 11])
      expect(35 - (mathis?.minutes ?? 0) / 60).toBe(20)
      // The six open tasks of the 180 h project carry 126 h and no real.
      const verd = project(plan, "VERD").tasks.filter((t) => t.status !== "done")
      expect(verd.reduce((n, t) => n + (t.timeboxMinutes ?? 0), 0) / 60).toBe(126)
      expect(plan.taskTime.some((r) => verd.some((t) => t.key === r.task))).toBe(false)
    })

    it(`last month on the by-the-day project: 11 closed, time on 9, 7 days planned and 7.5 taken at ${at}`, () => {
      const lastMonth = lastMonthOf(plan.today)
      const alpine = project(plan, "ALPINE")
      const closed = alpine.tasks.filter(
        (t) => t.status === "done" && monthOf(parisCivil(t.completedAt as Date)) === lastMonth,
      )
      expect(closed.length).toBe(11)
      const time = plan.taskTime.filter(
        (r) => r.project === "ALPINE" && monthOf(r.workDate) === lastMonth,
      )
      expect(new Set(time.map((r) => r.task)).size).toBe(9)
      const day = plan.hoursPerDayMinutes
      const line = (keys: string[]) => ({
        planned:
          alpine.tasks
            .filter((t) => keys.includes(t.key))
            .reduce((n, t) => n + (t.timeboxMinutes ?? 0), 0) / day,
        real: time.filter((r) => keys.includes(r.task)).reduce((n, r) => n + r.minutes, 0) / day,
      })
      expect(line(["ALPINE-11", "ALPINE-13", "ALPINE-14", "ALPINE-15"])).toEqual({
        planned: 3,
        real: 3.5,
      })
      expect(line(["ALPINE-6", "ALPINE-7", "ALPINE-16", "ALPINE-17"])).toEqual({
        planned: 4,
        real: 4,
      })
      expect(line(["ALPINE-8"]).real).toBe(0.5)
      expect(hoursOf(time)).toBe(56)
      const period = alpine.periods.find((p) => monthOf(p.periodStart) === lastMonth)
      expect(period?.minutes).toBe(7 * day)
      // 7 days at the day rate, VAT at 20%.
      const excl = 7 * (alpine.rateMinor ?? 0)
      expect([excl, excl / 5, excl + excl / 5]).toEqual([651_000, 130_200, 781_200])
    })

    it(`the second fixed-price project takes 212 h on its eight closed tasks against 180 h at ${at}`, () => {
      const verd = project(plan, "VERD")
      const time = plan.taskTime.filter((r) => r.project === "VERD")
      expect(time.map((r) => r.minutes / 60)).toEqual([30, 24, 36, 28, 22, 32, 20, 20])
      expect(hoursOf(time)).toBe(212)
      expect(verd.timeboxMinutes).toBe(180 * 60)
      const closed = verd.tasks.filter((t) => t.status === "done")
      expect(closed.length).toBe(8)
      expect(closed.every((t) => t.timeboxMinutes === undefined)).toBe(true)
      expect(new Set(time.map((r) => r.task))).toEqual(new Set(closed.map((t) => t.key)))
    })

    it(`every time row is on a day up to the anchor's, on a task of its project, once per person and day at ${at}`, () => {
      const seen = new Set<string>()
      for (const r of plan.taskTime) {
        expect(r.workDate <= plan.today).toBe(true)
        expect(project(plan, r.project).tasks.some((t) => t.key === r.task)).toBe(true)
        const id = `${r.task}|${r.person}|${r.workDate}`
        expect(seen.has(id)).toBe(false)
        seen.add(id)
      }
      for (const p of plan.projects) {
        for (const t of p.tasks) {
          if (t.completedAt) expect(t.completedAt.getTime()).toBeLessThanOrEqual(anchor.getTime())
        }
      }
    })

    it(`this month's real on the retainer project is 18 h, none after today, at ${at}`, () => {
      const month = monthOf(plan.today)
      const rows = plan.taskTime.filter(
        (r) => r.project === "SOREL" && monthOf(r.workDate) === month,
      )
      expect(hoursOf(rows)).toBe(18)
      expect(rows.every((r) => r.workDate <= plan.today)).toBe(true)
    })
  }

  it("this month's real on the retainer project clamps to the latest elapsed day on a month's first days", () => {
    const firsts = anchors().filter((d) => parisCivil(d).endsWith("-01"))
    expect(firsts.length).toBeGreaterThan(14)
    for (const anchor of firsts) {
      const plan = studioPlan(anchor)
      const rows = plan.taskTime.filter(
        (r) => r.project === "SOREL" && monthOf(r.workDate) === monthOf(plan.today),
      )
      expect(rows.map((r) => r.workDate)).toEqual([plan.today, plan.today, plan.today])
      expect(hoursOf(rows)).toBe(18)
    }
    for (const anchor of anchors().filter((d) => parisCivil(d).endsWith("-02"))) {
      const plan = studioPlan(anchor)
      const rows = plan.taskTime.filter(
        (r) => r.project === "SOREL" && monthOf(r.workDate) === monthOf(plan.today),
      )
      expect(rows.every((r) => r.workDate === plan.today)).toBe(true)
    }
  })

  it("the team is 24 and 10 hold timeboxes", () => {
    // 23 people and the owner's seat.
    expect(STUDIO_TEAM.length + 1).toBe(24)
    expect(new Set(STUDIO_TEAM.map((p) => p.key)).size).toBe(23)
    const plan = studioPlan(BOARD_DATE)
    const holders = new Set(
      plan.projects.flatMap((p) =>
        p.tasks.filter((t) => t.timeboxMinutes && t.assignee).map((t) => t.assignee),
      ),
    )
    expect([...holders].sort()).toEqual([...STUDIO_DELIVERY_KEYS].sort())
    expect(plan.costRates.map((r) => r.person).sort()).toEqual([...STUDIO_DELIVERY_KEYS].sort())
    expect(STUDIO_COST_RATES.bastien).toBe(6000)
    expect(STUDIO_COST_RATES.mathis).toBe(4800)
    expect(STUDIO_COST_RATES.nadia).toBe(6200)
    expect(STUDIO_COST_RATES.sofia).toBe(5500)
    for (const r of plan.costRates)
      expect(r.effectiveFrom < plan.taskTime.map((t) => t.workDate).sort()[0]!).toBe(true)
    // Every assignee is on the team.
    const keys = new Set(STUDIO_TEAM.map((p) => p.key))
    for (const p of plan.projects)
      for (const t of p.tasks) if (t.assignee) expect(keys.has(t.assignee)).toBe(true)
  })

  it("seven projects hold 120 tasks in the per-project counts, and each column follows from its own tasks", () => {
    const counts = studioBoardCounts(studioPlan(BOARD_DATE))
    const total = (k: string) => Object.values(counts[k] ?? {}).reduce((n, v) => n + v, 0)
    expect(Object.keys(counts)).toEqual([
      "MARLIN",
      "SOREL",
      "ALPINE",
      "SALES",
      "RHONE",
      "VERD",
      "STUDIO",
    ])
    expect(Object.keys(counts).map(total)).toEqual([50, 14, 17, 9, 7, 14, 9])
    expect(counts.STUDIO).toEqual({ todo: 2, in_progress: 2, done: 5 })
    expect(counts.VERD).toEqual({ todo: 6, in_progress: 0, done: 8 })
    const sum = { todo: 0, in_progress: 0, done: 0 }
    for (const c of Object.values(counts))
      for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += c[k]
    // The per-project facts close 81 tasks; the board's 77 cannot hold with them.
    expect(sum).toEqual({ todo: 24, in_progress: 15, done: 81 })
  })

  it("time and budgets is on for the five client projects, off for the studio's own, never on the pipeline", () => {
    const plan = studioPlan(BOARD_DATE)
    const on = plan.projects.filter((p) => p.timeBudgets).map((p) => p.key)
    expect(on).toEqual(["MARLIN", "SOREL", "ALPINE", "RHONE", "VERD"])
    expect(plan.projects.filter((p) => p.datedHours).map((p) => p.key)).toEqual(["SOREL"])
    expect(project(plan, "STUDIO").tasks.some((t) => t.timeboxMinutes)).toBe(false)
    expect(plan.taskTime.some((r) => r.project === "STUDIO" || r.project === "SALES")).toBe(false)
    expect(plan.hoursPerDayMinutes).toBe(7 * 60)
    expect(plan.pipeline.deals.length).toBe(9)
  })

  it("name order follows the org's language, accented names in their letter's place", () => {
    const names = ["Yanis", "Léa", "Fabien", "Lambert", "Émilie"]
    for (const locale of ["en", "fr"]) {
      expect(inNameOrder(names, (n) => n, locale)).toEqual([
        "Émilie",
        "Fabien",
        "Lambert",
        "Léa",
        "Yanis",
      ])
    }
    const team = new Map(STUDIO_TEAM.map((p) => [p.key, p.name]))
    const ordered = inNameOrder([...STUDIO_DELIVERY_KEYS].reverse(), (k) => team.get(k) ?? k, "fr")
    expect(ordered).toEqual([...STUDIO_DELIVERY_KEYS])
  })

  it("the person away this week and next holds no planned work, with a colleague next in line", () => {
    for (const anchor of anchors()) {
      const plan = studioPlan(anchor)
      expect(plan.away.length).toBe(1)
      const range = plan.away[0]!
      expect(range.startsOn <= plan.today && plan.today <= range.endsOn).toBe(true)
      expect(range.endsOn).toBe(plan.nextWeek.to)
      expect(range.nextInLine).toBe("victor")
      expect(plan.projects.some((p) => p.tasks.some((t) => t.assignee === range.person))).toBe(
        false,
      )
    }
  })

  it("two plans at one anchor are equal", () => {
    expect(studioPlan(BOARD_DATE)).toEqual(studioPlan(new Date(BOARD_DATE)))
  })

  it("no pack string holds a literal date, a year, a weekday or a relative day word", async () => {
    const hits = await scanWorldPackDir(import.meta.dir)
    expect(hits).toEqual([])
  })
})
