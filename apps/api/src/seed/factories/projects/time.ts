// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The time and budgets factory: hours in a day, a project's time plan and
// billing terms, its timeboxes per period, cost rates and the time a person
// took on a task. Each write runs in a real RLS transaction as the actor the
// product would act as, so a row the policies refuse is refused here too:
// time taken as the person who took it, the plan as someone holding
// `projects:projects:write`, billing terms with `projects:money:write`, cost
// rates with the exact `projects:cost_rates:write`, hours in a day with
// `projects:settings:admin`.
//
// Idempotent: every table has a natural key (org, project, period start,
// person and day, person and effective date), and a re-run adopts the row
// already there instead of writing a second one. No privileged write.
//
// Turning time and budgets on for a project is not here: that goes through
// the project writer, which also derives the org's feature row.
import type { UserContext } from "~/db/rls"
import {
  costRates,
  projectBillingTerms,
  projectTimeboxes,
  projectTimePlan,
  taskTime,
  timeSettings,
} from "~/db/schema/app_projects"
import type { SeedContext } from "~/seed/context"
import { asUser } from "~/seed/factories/people/actors"

type Basis = (typeof projectTimePlan.$inferInsert)["basis"]

/** Hours in a day for the org, in minutes (7 h is 420). Writes nothing when already set. */
export async function seedTimeSettings(
  ctx: SeedContext,
  admin: UserContext,
  input: { hoursPerDayMinutes: number },
): Promise<void> {
  await asUser(admin, async (tx) => {
    await tx
      .insert(timeSettings)
      .values({
        orgId: ctx.orgId,
        hoursPerDayMinutes: input.hoursPerDayMinutes,
        updatedBy: admin.userId,
      })
      .onConflictDoNothing()
  })
}

export interface SeedTimePlanInput {
  projectId: string
  basis: NonNullable<Basis>
  /** Whole-project timebox, in minutes. */
  timeboxMinutes?: number
  billerId?: string
  datedHours: boolean
  /** The repositories its reconcile reads, as the plan writer stores them. */
  sourceRepos: Array<{ provider: string; repo: string }>
  /** Project timeboxes per period, civil dates. */
  periods: ReadonlyArray<{
    periodStart: string
    periodEnd: string
    minutes: number
    source: "manual" | "retainer"
  }>
}

/** A project's time plan and its period timeboxes, as someone who may edit the project. */
export async function seedTimePlan(
  ctx: SeedContext,
  editor: UserContext,
  input: SeedTimePlanInput,
): Promise<void> {
  const at = ctx.now
  await asUser(editor, async (tx) => {
    await tx
      .insert(projectTimePlan)
      .values({
        projectId: input.projectId,
        orgId: ctx.orgId,
        basis: input.basis,
        timeboxMinutes: input.timeboxMinutes ?? null,
        billerId: input.billerId ?? null,
        datedHours: input.datedHours,
        ...(input.datedHours
          ? { datedHoursChangedBy: editor.userId, datedHoursChangedAt: earliest(input, at) }
          : {}),
        sourceRepos: input.sourceRepos,
      })
      .onConflictDoNothing()
    for (const period of input.periods) {
      await tx
        .insert(projectTimeboxes)
        .values({
          orgId: ctx.orgId,
          projectId: input.projectId,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          minutes: period.minutes,
          source: period.source,
          createdBy: editor.userId,
        })
        .onConflictDoNothing()
    }
  })
}

/**
 * When dated hours count from: the first period's start, so the rows of every
 * seeded period are on or after it, else the base time.
 */
function earliest(input: SeedTimePlanInput, at: Date): Date {
  const first = [...input.periods].map((p) => p.periodStart).sort()[0]
  if (!first) return at
  const [y, m, d] = first.split("-").map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d, 12))
}

/** A project's rate or fixed price, as someone holding the money scope. */
export async function seedBillingTerms(
  ctx: SeedContext,
  biller: UserContext,
  input: { projectId: string; rateMinor?: number; fixedPriceMinor?: number; currency: string },
): Promise<void> {
  await asUser(biller, async (tx) => {
    await tx
      .insert(projectBillingTerms)
      .values({
        projectId: input.projectId,
        orgId: ctx.orgId,
        rateMinor: input.rateMinor ?? null,
        fixedPriceMinor: input.fixedPriceMinor ?? null,
        currency: input.currency,
      })
      .onConflictDoNothing()
  })
}

/**
 * Cost rates per person from a date, as an exact holder of the cost-rate scope.
 * A `null` currency is a rate written before a currency was required: the writer
 * refuses one now, the column still holds them.
 */
export async function seedCostRates(
  ctx: SeedContext,
  writer: UserContext,
  rows: ReadonlyArray<{
    userId: string
    rateMinor: number
    currency: string | null
    effectiveFrom: string
  }>,
): Promise<void> {
  await asUser(writer, async (tx) => {
    for (const row of rows) {
      await tx
        .insert(costRates)
        .values({ orgId: ctx.orgId, ...row })
        .onConflictDoNothing()
    }
  })
}

/** The time one person took, on their own tasks' days: written as that person. */
export async function seedTaskTime(
  ctx: SeedContext,
  person: UserContext,
  rows: ReadonlyArray<{ taskId: string; projectId: string; workDate: string; minutes: number }>,
): Promise<void> {
  if (rows.length === 0) return
  await asUser(person, async (tx) => {
    await tx
      .insert(taskTime)
      .values(
        rows.map((row) => ({
          orgId: ctx.orgId,
          taskId: row.taskId,
          projectId: row.projectId,
          userId: person.userId,
          workDate: row.workDate,
          minutes: row.minutes,
          enteredVia: "field" as const,
          changedBy: person.userId,
        })),
      )
      .onConflictDoNothing()
  })
}
