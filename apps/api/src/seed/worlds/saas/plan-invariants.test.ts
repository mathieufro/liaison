// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The software world's plan held to its invariants with no database: the
// pipeline's sums, the deal values as plan prices, the company breakdown, the
// owner's Home counts and the team the door names, at the board date and at
// anchors across a year (month starts and ends included).
import { describe, expect, it } from "bun:test"
import { scanWorldPackDir } from "~/seed/worlds/prose-guard"
import { SAAS_PLANS, SAAS_TEAM } from "./fiction"
import { parisCivil, SAAS_COMPANY_COUNTS, SAAS_VAT_BP, saasMoneyPlan, saasPlan } from "./plan"

const BOARD_DATE = new Date("2026-11-09T08:30:00Z")

/**
 * The sweep: one anchor a week for 13 months from the board date, every month's
 * 1st (at 00:30 Paris, just after the month turns, and mid-morning), a Sunday
 * the 1st, the 28th to the 31st, 1 January and 29 February 2028.
 */
function anchors(): Date[] {
  const out = new Map<number, Date>([[BOARD_DATE.getTime(), BOARD_DATE]])
  const add = (d: Date) => out.set(d.getTime(), d)
  for (let w = 1; w <= 57; w++) add(new Date(BOARD_DATE.getTime() + w * 7 * 86_400_000))
  for (let m = 0; m < 14; m++) {
    // 00:30 Paris on the 1st is 23:30 or 22:30 UTC the day before.
    add(new Date(Date.UTC(2026, 10 + m, 1, 0, 30) - 3_600_000))
    for (const day of [1, 28, 29, 30, 31]) {
      const at = new Date(Date.UTC(2026, 10 + m, day, 7, 15))
      if (at.getUTCDate() === day) add(at)
    }
  }
  add(new Date(Date.UTC(2027, 7, 1, 10, 0))) // Sunday 1 August 2027
  add(new Date(Date.UTC(2028, 0, 1, 10, 0)))
  add(new Date(Date.UTC(2028, 1, 29, 10, 0)))
  return [...out.values()]
}

/** Before VAT, VAT and total of a batch, in minor units. */
function batchTotals(batch: readonly { quantity: number; unitMinor: number; vatBp: number }[]) {
  const ex = batch.reduce((n, s) => n + s.quantity * s.unitMinor, 0)
  const vat = batch.reduce((n, s) => n + (s.quantity * s.unitMinor * s.vatBp) / 10_000, 0)
  return [ex, vat, ex + vat]
}

const monthOf = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit" })
    .format(d)
    .slice(0, 7)

describe("software world plan", () => {
  it("the sweep covers a week at a time for 13 months, a Sunday the 1st, 1 January and 29 February", () => {
    const days = anchors().map((d) => d.toISOString().slice(0, 10))
    expect(anchors().filter((d) => d.getTime() > BOARD_DATE.getTime()).length).toBeGreaterThan(57)
    expect(days).toContain("2027-08-01")
    expect(new Date("2027-08-01T10:00:00Z").getUTCDay()).toBe(0)
    expect(days).toContain("2028-01-01")
    expect(days).toContain("2028-02-29")
  })

  for (const anchor of anchors()) {
    const at = anchor.toISOString()
    const plan = saasPlan(anchor)
    const open = plan.deals.filter((d) => d.stage !== "Won" && d.stage !== "Lost")
    const sum = (stage: string) =>
      open.filter((d) => d.stage === stage).reduce((n, d) => n + d.amountMinor, 0) / 100

    it(`the pipeline sums by stage and the open total hold at ${at}`, () => {
      expect(sum("Lead")).toBe(12_300)
      expect(sum("Qualified")).toBe(9_800)
      expect(sum("Demo")).toBe(23_280)
      expect(sum("Proposal")).toBe(23_280)
      expect(open).toHaveLength(9)
      expect(open.reduce((n, d) => n + d.amountMinor, 0) / 100).toBe(68_660)
      const month = monthOf(anchor)
      const closedThisMonth = (stage: string) =>
        plan.deals.filter((d) => d.stage === stage && d.closedAt && monthOf(d.closedAt) === month)
      expect(closedThisMonth("Won").map((d) => d.key)).toEqual(["vauban-team"])
      expect(closedThisMonth("Lost").map((d) => d.key)).toEqual(["trois-ormes"])
      for (const d of plan.deals) {
        expect(d.createdAt.getTime()).toBeLessThanOrEqual(anchor.getTime())
        if (d.closedAt) expect(d.closedAt.getTime()).toBeLessThanOrEqual(anchor.getTime())
      }
    })

    it(`every deal number up to the last exists once at ${at}`, () => {
      const numbers = [...plan.deals.map((d) => d.number), ...plan.subtasks.map((s) => s.number)]
      expect(numbers.sort((a, b) => a - b)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1))
    })
  }

  it("deal values are plan prices: a year of Group, a year of Team, eight months of Team", () => {
    const plan = saasPlan(BOARD_DATE)
    const year = (p: keyof typeof SAAS_PLANS) => 12 * SAAS_PLANS[p].monthlyMinor
    expect(year("group")).toBe(1_740_000)
    expect(year("team")).toBe(588_000)
    expect(8 * SAAS_PLANS.team.monthlyMinor).toBe(392_000)
    const byNumber = (n: number) => plan.deals.find((d) => d.number === n)?.amountMinor
    expect(byNumber(14)).toBe(year("group"))
    expect(byNumber(17)).toBe(year("group"))
    expect(byNumber(12)).toBe(year("team"))
    expect(byNumber(24)).toBe(8 * SAAS_PLANS.team.monthlyMinor)
  })

  it("214 companies in the breakdown the board states, unique by name, Kora's pair on one domain", () => {
    const plan = saasPlan(BOARD_DATE)
    expect(plan.companies).toHaveLength(214)
    for (const [kind, n] of Object.entries(SAAS_COMPANY_COUNTS)) {
      expect(plan.companies.filter((c) => c.kind === kind)).toHaveLength(n)
    }
    expect(new Set(plan.companies.map((c) => c.name.toLowerCase())).size).toBe(214)
    const paying = plan.companies.filter((c) => c.kind === "paying")
    expect(paying.filter((c) => c.plan === "starter")).toHaveLength(62)
    expect(paying.filter((c) => c.plan === "team")).toHaveLength(83)
    expect(paying.filter((c) => c.plan === "group")).toHaveLength(24)
    const kora = plan.companies.filter((c) => c.name.toLowerCase().startsWith("kora"))
    expect(kora).toHaveLength(2)
    expect(new Set(kora.map((c) => c.domain)).size).toBe(1)
    for (const c of plan.companies) expect(c.domain.endsWith(".example")).toBe(true)
  })

  it("the owner's Home holds 3 approvals and 1 attention row, and the queues 12 items", () => {
    const plan = saasPlan(BOARD_DATE)
    expect(plan.needsYou.filter((r) => r.kind === "approval")).toHaveLength(3)
    expect(plan.needsYou.filter((r) => r.kind === "attention")).toHaveLength(1)
    const q = plan.queues
    expect([q.support, q.deals, q.tasks, q.knowledge]).toEqual([6, 3, 2, 1])
    expect(q.support + q.deals + q.tasks + q.knowledge).toBe(12)
  })

  it("the team is 13 named people and the owner's seat, 14 in all", () => {
    const plan = saasPlan(BOARD_DATE)
    expect(SAAS_TEAM).toHaveLength(plan.team.named)
    expect(plan.team.named + plan.team.ownerSeat).toBe(14)
    expect(new Set(SAAS_TEAM.map((p) => p.key)).size).toBe(13)
    expect(SAAS_TEAM.filter((p) => p.role === "founder_admin")).toHaveLength(1)
  })

  it("two plans at one anchor are equal", () => {
    expect(saasPlan(BOARD_DATE)).toEqual(saasPlan(new Date(BOARD_DATE)))
  })

  it("no pack string holds a literal date, a year, a weekday or a relative day word", async () => {
    const hits = await scanWorldPackDir(import.meta.dir)
    expect(hits).toEqual([])
  })
})

describe("software world money plan", () => {
  const counted = (p: ReturnType<typeof saasMoneyPlan>) =>
    p.subscriptions.filter((s) => s.status === "active" || s.status === "past_due")
  const monthlyOf = (plan: keyof typeof SAAS_PLANS) => SAAS_PLANS[plan].monthlyMinor

  for (const anchor of anchors()) {
    const at = anchor.toISOString()
    const plan = saasMoneyPlan(anchor)

    it(`169 counted subscriptions sum to 84,708 a month, past due 7 at 3,367, at ${at}`, () => {
      const subs = counted(plan)
      expect(subs).toHaveLength(169)
      const byPlan = (p: string) => subs.filter((s) => s.plan === p).length
      expect([byPlan("starter"), byPlan("team"), byPlan("group")]).toEqual([62, 83, 24])
      const mrr = subs.reduce((n, s) => n + monthlyOf(s.plan), 0)
      expect(mrr).toBe(8_470_800)
      const pastDue = subs.filter((s) => s.status === "past_due")
      expect(pastDue).toHaveLength(7)
      expect(pastDue.reduce((n, s) => n + monthlyOf(s.plan), 0)).toBe(336_700)
      expect(mrr - pastDue.reduce((n, s) => n + monthlyOf(s.plan), 0)).toBe(8_134_100)
      // Every past due row bills monthly; 30 monthly and 139 yearly in all.
      for (const s of pastDue) expect(s.billing).toBe("month")
      expect(subs.filter((s) => s.billing === "month")).toHaveLength(30)
      expect(subs.filter((s) => s.billing === "year")).toHaveLength(139)
    })

    it(`this month's twelve movements net +2,281 from an opening of 82,427, all inside the month, at ${at}`, () => {
      const month = monthOf(anchor)
      const mine = plan.movements.filter((m) => monthOf(m.at) === month)
      expect(mine).toHaveLength(12)
      const sum = (k: string) =>
        mine.filter((m) => m.kind === k).reduce((n, m) => n + m.afterMinor - m.beforeMinor, 0)
      expect([sum("new"), sum("upgrade"), sum("downgrade"), sum("cancelled")]).toEqual([
        294_000, 96_000, -34_100, -127_800,
      ])
      const net = mine.reduce((n, m) => n + m.afterMinor - m.beforeMinor, 0)
      expect(net).toBe(228_100)
      expect(8_470_800 - net).toBe(8_242_700)
      for (const m of mine) expect(m.at.getTime()).toBeLessThanOrEqual(anchor.getTime())
      // The won deal's customer is one of the six new Team subscriptions; Café Ombre's
      // cancellation is never this month's.
      const ombre = plan.subscriptions.find((s) => s.companyKey === "cafe-ombre")
      expect(mine.some((m) => m.subscriptionId === ombre?.subscriptionId)).toBe(false)
      const vauban = plan.subscriptions.find((s) => s.companyKey === "les-tables-vauban")
      expect(mine.find((m) => m.subscriptionId === vauban?.subscriptionId)?.kind).toBe("new")
    })

    it(`four trials end within seven days and count nowhere, at ${at}`, () => {
      const trials = plan.subscriptions.filter((s) => s.status === "trialing")
      expect(trials).toHaveLength(4)
      for (const t of trials) {
        // Calendar days on the company's clock: a summer time change moves an hour, not a day.
        const civil = (d: Date) => Date.parse(parisCivil(d))
        const days = (civil(t.trialEnd as Date) - civil(anchor)) / 86_400_000
        expect(days).toBeGreaterThan(0)
        expect(days).toBeLessThanOrEqual(7)
      }
    })

    it(`invoice numbers run from 0001 per year in date order with no gap, at ${at}`, () => {
      const byYear = new Map<number, number[]>()
      const sorted = [...plan.invoices].sort(
        (a, b) => a.issuedAt.getTime() - b.issuedAt.getTime() || a.numberInt - b.numberInt,
      )
      for (const inv of sorted) {
        byYear.set(inv.year, [...(byYear.get(inv.year) ?? []), inv.numberInt])
        expect(inv.number).toBe(`F-${inv.year}-${String(inv.numberInt).padStart(4, "0")}`)
        expect(inv.issuedAt.getTime()).toBeLessThanOrEqual(anchor.getTime())
      }
      for (const nums of byYear.values()) {
        expect(nums).toEqual(Array.from({ length: nums.length }, (_, i) => i + 1))
      }
    })

    it(`the month-end batch is every schedule due on this month's last day, at ${at}`, () => {
      expect(plan.schedules).toHaveLength(10)
      const monthly = plan.schedules.filter((s) => s.repeats === "month" && s.status === "active")
      expect(monthly).toHaveLength(7)
      expect(new Set(monthly.map((s) => s.nextIssueOn)).size).toBe(1)
      const monthEnd = monthly[0]?.nextIssueOn
      expect(monthEnd?.slice(0, 7)).toBe(monthOf(anchor))
      // Selected by the day, not by how often a schedule repeats: in a quarter's
      // last month the quarterly run falls on the same day and joins the batch.
      const batch = plan.schedules.filter((s) => s.nextIssueOn === monthEnd)
      const quarterMonth = ["03", "06", "09", "12"].includes(monthOf(anchor).slice(5))
      expect(batch.filter((s) => s.repeats !== "month").map((s) => s.key)).toEqual(
        quarterMonth ? ["domaine-ferrand-schedule"] : [],
      )
      const [ex, vat, total] = batchTotals(batch)
      expect(total).toBe(ex + vat)
      expect([ex, vat, total]).toEqual(
        quarterMonth ? [517_800, 93_760, 611_560] : [370_800, 64_360, 435_160],
      )
    })
  }

  it("the board month's batch is the seven monthly schedules: 3,708 before VAT, 643.60 VAT, 4,351.60", () => {
    const { schedules } = saasMoneyPlan(BOARD_DATE)
    const batch = schedules.filter((s) => s.nextIssueOn === "2026-11-30")
    expect(batch.map((s) => s.repeats)).toEqual(Array(7).fill("month"))
    expect(batchTotals(batch)).toEqual([370_800, 64_360, 435_160])
  })

  it("in a quarter's last month the quarterly run joins the month-end batch", () => {
    for (const [at, day] of [
      ["2026-12-09T09:00:00Z", "2026-12-31"],
      ["2027-03-15T09:00:00Z", "2027-03-31"],
      ["2027-06-10T09:00:00Z", "2027-06-30"],
    ] as const) {
      const { schedules } = saasMoneyPlan(new Date(at))
      const batch = schedules.filter((s) => s.nextIssueOn === day)
      expect(batch).toHaveLength(8)
      expect(batch.find((s) => s.repeats === "quarter")?.key).toBe("domaine-ferrand-schedule")
      expect(batchTotals(batch)).toEqual([517_800, 93_760, 611_560])
    }
  })

  it("the named invoices carry the board's numbers at the board date", () => {
    const plan = saasMoneyPlan(BOARD_DATE)
    const numberOf = (key: string) => plan.invoices.find((i) => i.key === key)?.number
    expect(
      [
        "verrieres-year",
        "pins-last",
        "ferrand-quarter",
        "arlon-previous",
        "relais-disputed",
        "ombre-after-cancel",
        "belcour-last",
        "alize-last",
        "port-last",
        "marceau-last",
        "comptoir-sud-last",
        "noord-last",
        "arlon-current",
      ].map(numberOf),
    ).toEqual([
      "F-2026-0007",
      "F-2026-0284",
      "F-2026-0298",
      "F-2026-0362",
      "F-2026-0369",
      "F-2026-0391",
      "F-2026-0411",
      "F-2026-0412",
      "F-2026-0413",
      "F-2026-0414",
      "F-2026-0415",
      "F-2026-0416",
      "F-2026-0418",
    ])
    expect(Math.max(...plan.invoices.filter((i) => i.year === 2026).map((i) => i.numberInt))).toBe(
      418,
    )
  })

  it("the named invoices keep their numbers whatever the time of day, and issue times follow numbers", () => {
    const board = (anchor: Date) =>
      Object.fromEntries(
        saasMoneyPlan(anchor)
          .invoices.filter((i) => !i.key.startsWith("renewal-"))
          .map((i) => [i.key, i.number]),
      )
    const expected = board(BOARD_DATE)
    for (const at of ["2026-11-11T13:30:00Z", "2026-11-11T21:45:00Z", "2026-11-12T06:10:00Z"]) {
      const anchor = new Date(at)
      expect(board(anchor)).toEqual(expected)
      const ofYear = saasMoneyPlan(anchor)
        .invoices.filter((i) => i.year === 2026)
        .sort((a, b) => a.numberInt - b.numberInt)
      for (let i = 1; i < ofYear.length; i++) {
        expect(ofYear[i]?.issuedAt.getTime()).toBeGreaterThanOrEqual(
          ofYear[i - 1]?.issuedAt.getTime() ?? 0,
        )
      }
    }
  })

  it("prices with VAT are the plan prices at 20% and the refund splits back to them", () => {
    const vat = (minor: number) => minor + (minor * SAAS_VAT_BP) / 10_000
    expect([vat(14_900), vat(49_000), vat(145_000)]).toEqual([17_880, 58_800, 174_000])
    expect(14_900 + (14_900 * SAAS_VAT_BP) / 10_000 - 14_900).toBe(2_980)
    const plan = saasMoneyPlan(BOARD_DATE)
    const ombre = plan.charges.find((c) => c.key === "cafe-ombre-after-cancel")
    expect((ombre?.netMinor ?? 0) + (ombre?.taxMinor ?? 0)).toBe(17_880)
    expect(ombre?.card.last4).toBe("5108")
    const arlon = plan.charges.find((c) => c.invoiceKey === "arlon-current")
    expect([arlon?.invoiceStatus, (arlon?.netMinor ?? 0) + (arlon?.taxMinor ?? 0)]).toEqual([
      "open",
      174_000,
    ])
    for (const c of plan.charges) expect(["4242", "5108"]).toContain(c.card.last4)
  })

  it("every instant of the mirror is a whole second", () => {
    const plan = saasMoneyPlan(new Date("2026-11-09T08:30:12.345Z"))
    const instants = [
      ...plan.subscriptions.flatMap((s) => [
        s.periodStart,
        s.periodEnd,
        s.trialEnd,
        s.canceledAt,
        s.pastDueSince,
        s.customerSince,
      ]),
      ...plan.movements.map((m) => m.at),
      ...plan.charges.flatMap((c) => [c.at, c.periodStart, c.periodEnd]),
      plan.lastEventAt,
      plan.syncedAt,
    ].filter((d): d is Date => d instanceof Date)
    for (const d of instants) expect(d.getTime() % 1000).toBe(0)
  })

  it("two money plans at one anchor are equal", () => {
    expect(saasMoneyPlan(BOARD_DATE)).toEqual(saasMoneyPlan(new Date(BOARD_DATE)))
  })
})
