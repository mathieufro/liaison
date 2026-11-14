// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `studio` world's own layer: it writes the plan (`plan.ts`) after the
// shared support layer, through the product's own writers, as the people who
// would do it:
//
// - the lead and finance get the projects app's lead and finance roles from
//   the owner (the role writer);
// - hours in a day, as the owner;
// - the pipeline's deals, as its owner;
// - each project as its owner, with time and budgets turned on through the
//   project writer, so the org's feature row is derived, never seeded;
// - its plan, period timeboxes and billing terms (the biller, through the
//   terms writer), then its tasks in board-number order, timeboxes and
//   milestones through the task plan writer;
// - the time each person took, as that person; cost rates as finance;
// - who is away, through the away writer.
//
// No figure is computed here: budgets, capacity, the dated sheet and margin
// are what the product's reads make of these rows. Every write is idempotent:
// a re-run adopts what is there.
import { and, eq, inArray, sql } from "drizzle-orm"
import { setCostRate } from "~/apps/projects/service/margin"
import { awaitTimeFeatureSync } from "~/apps/projects/service/time-feature"
import { setBillingTerms, setPeriodTimebox, setTaskTime } from "~/apps/projects/service/time-plan"
import { awaitTimeRowWrites } from "~/apps/projects/service/time-rows"
import { updateProjectWithOutcome } from "~/apps/projects/service/update-project"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { roles } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { assignRole } from "~/modules/permissions/roles"
import { setAway } from "~/modules/users/away"
import { type SeedContext, seedContext } from "~/seed/context"
import { actorFor, asUser, rowsOf } from "~/seed/factories/people/actors"
import { seedCompanies } from "~/seed/factories/people/companies"
import { seedPipeline } from "~/seed/factories/projects/deals"
import { seedProject, type TaskSpec } from "~/seed/factories/projects/projects"
import { seedTimePlan, seedTimeSettings } from "~/seed/factories/projects/time"
import type { SeedDemoOrgResult } from "~/seed/tiers/demo/seed-org"
import type { DemoWorldLayerInput } from "../index"
import { STUDIO_CLIENTS } from "./fiction"
import { type StudioPlan, type StudioProjectPlan, studioPlan } from "./plan"

/** Midday UTC, so a past work day keeps its civil date in any zone near UTC. */
const NOON_MS = 12 * 60 * 60 * 1000

type ExecTx = { execute: (q: unknown) => Promise<unknown> }

/** The pipeline's project key. */
export const STUDIO_PIPELINE_KEY = "SALES"

/** A task's or a deal's idempotency key. */
export const studioTaskRef = (key: string) => `demo:studio:task:${key}`

/** Who gets which role of the projects app, beside their demo role. */
const STUDIO_APP_ROLES: ReadonlyArray<{ person: string; role: string }> = [
  { person: "bastien", role: "projects.lead" },
  { person: "anais", role: "projects.finance" },
]

function ownerIdOf(org: SeedDemoOrgResult): string {
  return org.ownerUserId ?? org.adminUserId
}

function userIdOf(org: SeedDemoOrgResult, key: string): string {
  if (key === "owner") return ownerIdOf(org)
  const id = org.peopleByKey[key]?.userId
  if (!id) throw new Error(`studio layer: no person '${key}'`)
  return id
}

/** The number on a board key (`MARLIN-12` is 12). */
function numberOf(key: string): number {
  const n = Number(key.slice(key.lastIndexOf("-") + 1))
  if (!Number.isInteger(n) || n <= 0) throw new Error(`studio layer: no number in '${key}'`)
  return n
}

/** The day before the project's first closed task, period or time entry: when it started. */
function startOf(project: StudioProjectPlan, fallback: Date): Date {
  const dates = [
    ...project.tasks.flatMap((t) => (t.completedAt ? [t.completedAt.getTime()] : [])),
    ...project.periods.map((p) => {
      const [y, m, d] = p.periodStart.split("-").map(Number) as [number, number, number]
      return Date.UTC(y, m - 1, d)
    }),
  ]
  const first = dates.length > 0 ? Math.min(...dates) : fallback.getTime()
  return new Date(Math.min(first, fallback.getTime()) - 86_400_000)
}

/** The lead and finance roles, given by the owner through the role writer. */
async function seedStudioRoles(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  owner: UserContext,
): Promise<void> {
  await asUser(owner, async (tx) => {
    const names = STUDIO_APP_ROLES.map((r) => r.role)
    const found = await tx
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(and(eq(roles.orgId, ctx.orgId), inArray(roles.name, names)))
    const idOf = new Map(found.map((r) => [r.name, r.id]))
    for (const { person, role } of STUDIO_APP_ROLES) {
      const roleId = idOf.get(role)
      if (!roleId) throw new Error(`studio layer: the projects app has no '${role}' role`)
      const out = await assignRole(tx as never, {
        userId: userIdOf(org, person),
        roleId,
        orgId: ctx.orgId,
        actorId: owner.userId,
        actorScopes: owner.scopes as never,
        actorDimensionGrants: owner.dimensionGrants ?? {},
      })
      if (!out || "error" in out) {
        throw new Error(`studio layer: '${role}' was not given to ${person}`)
      }
    }
  })
  ctx.log(`roles: ${STUDIO_APP_ROLES.map((r) => `${r.person} ${r.role}`).join(", ")}`)
}

/** The pipeline's deals, as its owner, on the clients the support layer wrote. */
async function seedStudioDeals(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actors: (key: string) => Promise<UserContext>,
  plan: StudioPlan,
): Promise<Record<string, string>> {
  const owner = await actors(plan.pipeline.owner)
  const companyIds = await seedCompanies(
    ctx,
    owner,
    STUDIO_CLIENTS.map((c) => ({ key: c.key, name: c.name })),
    {},
    { onlyExisting: true },
  )
  await seedPipeline(ctx, owner, {
    people: org.peopleByKey,
    companyIds,
    contactIds: {},
    spec: {
      key: plan.pipeline.key,
      name: plan.pipeline.name,
      description: plan.pipeline.description,
      deals: plan.pipeline.deals.map((d) => ({
        key: d.key,
        title: d.title,
        stage: d.stage,
        ...(d.client ? { companyKey: d.client } : {}),
        owner: d.owner,
        amountMinor: d.amountMinor,
        currency: "EUR",
      })),
    },
    externalRefOf: studioTaskRef,
  })
  return companyIds
}

/** One project: created, switched on, planned and billed, then its tasks. */
async function seedStudioProject(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  actors: (key: string) => Promise<UserContext>,
  project: StudioProjectPlan,
  companyIds: Readonly<Record<string, string>>,
): Promise<{ projectId: string; taskIds: Record<string, string> }> {
  const owner = await actors(project.owner)
  const base = {
    key: project.key,
    name: project.name,
    description: project.description,
    icon: project.icon,
    owner: project.owner,
  }
  const { projectId } = await seedProject(ctx, owner, {
    people: org.peopleByKey,
    spec: { ...base, tasks: [] },
    externalRefOf: studioTaskRef,
  })

  const wanted = project.client ? companyIds[project.client] : undefined
  // A re-run finds the client already set and writes nothing for it.
  const current = await asUser(owner, async (tx) =>
    rowsOf<{ company_id: string | null }>(
      await (tx as ExecTx).execute(
        sql`SELECT company_id::text AS company_id FROM ${sql.raw(schemaRef("app_projects"))}.projects
            WHERE id = ${projectId}::uuid AND org_id = ${ctx.orgId}::uuid`,
      ),
    ),
  )
  const companyId = wanted && current[0]?.company_id !== wanted ? wanted : undefined
  if (project.timeBudgets || companyId) {
    // The client and the switch through the project writer: the org's row follows.
    await asUser(owner, (tx) =>
      updateProjectWithOutcome({
        tx: tx as never,
        orgId: ctx.orgId,
        projectId,
        actor: owner,
        // The world used time and budgets on this project from its start, before any task closed.
        recordedAt: startOf(project, ctx.now),
        patch: {
          ...(companyId ? { companyId } : {}),
          ...(project.timeBudgets ? { timeBudgets: true } : {}),
        },
      }),
    )
  }
  if (project.timeBudgets) {
    // The org's feature row follows after commit; the writers below read it.
    await awaitTimeFeatureSync(ctx.orgId)

    await seedTimePlan(ctx, owner, {
      projectId,
      basis: project.basis,
      ...(project.timeboxMinutes !== undefined ? { timeboxMinutes: project.timeboxMinutes } : {}),
      ...(project.biller ? { billerId: userIdOf(org, project.biller) } : {}),
      datedHours: project.datedHours,
      sourceRepos: project.sourceRepos.map((repo) => ({ provider: "github", repo })),
      // A retainer's periods are its schedule's; the others go through the period writer.
      periods: project.periods.filter((p) => p.source === "retainer"),
    })
    for (const period of project.periods.filter((p) => p.source === "manual")) {
      await asUser(owner, (tx) =>
        setPeriodTimebox({
          tx: tx as never,
          orgId: ctx.orgId,
          actorId: owner.userId,
          scopes: owner.scopes,
          input: {
            projectId,
            from: period.periodStart,
            to: period.periodEnd,
            timebox: `${period.minutes}m`,
          },
        }),
      )
    }
    if (
      project.biller &&
      (project.rateMinor !== undefined || project.fixedPriceMinor !== undefined)
    ) {
      const biller = await actors(project.biller)
      await asUser(biller, (tx) =>
        setBillingTerms({
          tx: tx as never,
          orgId: ctx.orgId,
          scopes: biller.scopes,
          input: {
            projectId,
            ...(project.fixedPriceMinor !== undefined
              ? { fixedPrice: project.fixedPriceMinor / 100 }
              : { rate: (project.rateMinor ?? 0) / 100 }),
            currency: project.currency,
          },
        }),
      )
    }
  }

  const tasks: TaskSpec[] = project.tasks.map((t) => ({
    key: t.key,
    title: t.title,
    status: t.status,
    number: numberOf(t.key),
    ...(t.assignee ? { assignee: t.assignee } : {}),
    ...(t.parent ? { parent: t.parent } : {}),
    ...(t.dueInDays !== undefined ? { dueInDays: t.dueInDays } : {}),
    ...(t.completedAt ? { completedAt: t.completedAt } : {}),
    ...(t.timeboxMinutes !== undefined ? { timeboxMinutes: t.timeboxMinutes } : {}),
    ...(t.isMilestone ? { isMilestone: true } : {}),
  }))
  const { taskIds } = await seedProject(ctx, owner, {
    people: org.peopleByKey,
    spec: { ...base, tasks },
    externalRefOf: studioTaskRef,
  })
  const byKey: Record<string, string> = {}
  const ordered = [...tasks].sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
  ordered.forEach((t, i) => {
    const id = taskIds[i]
    if (id) byKey[t.key] = id
  })
  return { projectId, taskIds: byKey }
}

/** Who is away from the anchor, said by the owner, with who is next in line. */
async function seedStudioAway(
  ctx: SeedContext,
  org: SeedDemoOrgResult,
  owner: UserContext,
  plan: StudioPlan,
): Promise<void> {
  for (const away of plan.away) {
    const userId = userIdOf(org, away.person)
    const recorded = await asUser(owner, async (tx) =>
      rowsOf<{ id: string }>(
        await (tx as ExecTx).execute(
          sql`SELECT id FROM ${sql.raw(schemaRef("kernel"))}.away_ranges
              WHERE org_id = ${ctx.orgId}::uuid AND user_id = ${userId}::uuid LIMIT 1`,
        ),
      ),
    )
    if (recorded.length > 0) continue
    await setAway({
      orgId: ctx.orgId,
      actorId: owner.userId,
      actorScopes: owner.scopes,
      userId,
      form: { from: away.startsOn, to: away.endsOn },
      nextInLineId: userIdOf(org, away.nextInLine),
      now: ctx.now,
    })
  }
  ctx.log(`away: ${plan.away.map((a) => a.person).join(", ")}`)
}

export async function seedStudioLayer(input: DemoWorldLayerInput): Promise<void> {
  const { org, baseTime, log } = input
  const ctx = seedContext({ orgId: org.orgId, now: baseTime, log })
  const plan = studioPlan(baseTime)
  const owner = await actorFor(ctx, ownerIdOf(org))

  await seedStudioRoles(ctx, org, owner)
  // Read after the roles, so each person acts with what they now hold.
  const cache = new Map<string, Promise<UserContext>>()
  const actors = (key: string) => {
    let actor = cache.get(key)
    if (!actor) {
      actor = actorFor(ctx, userIdOf(org, key))
      cache.set(key, actor)
    }
    return actor
  }

  await seedTimeSettings(ctx, owner, { hoursPerDayMinutes: plan.hoursPerDayMinutes })
  const companyIds = await seedStudioDeals(ctx, org, actors, plan)

  const tasksOf: Record<string, { projectId: string; taskIds: Record<string, string> }> = {}
  for (const project of plan.projects) {
    if (project.key === plan.pipeline.key) continue
    tasksOf[project.key] = await seedStudioProject(ctx, org, actors, project, companyIds)
  }
  ctx.log(`projects: ${Object.keys(tasksOf).join(", ")}`)

  // Each person enters their own time through the product's writer, on the day they worked it:
  // a dated project takes the day, an undated one records the day the entry is made.
  const datedProjects = new Set(plan.projects.filter((p) => p.datedHours).map((p) => p.key))
  const rowsSorted = [...plan.taskTime].sort(
    (a, b) => a.person.localeCompare(b.person) || a.workDate.localeCompare(b.workDate),
  )
  for (const r of rowsSorted) {
    const project = tasksOf[r.project]
    const taskId = project?.taskIds[r.task]
    if (!project || !taskId) throw new Error(`studio layer: no task ${r.task}`)
    const person = await actors(r.person)
    const dated = datedProjects.has(r.project)
    await asUser(person, (tx) =>
      setTaskTime({
        tx: tx as never,
        orgId: ctx.orgId,
        userId: person.userId,
        scopes: person.scopes,
        place: { origin: "human-ui", frame: undefined, actingAgentId: null },
        input: { taskId, time: `${r.minutes}m`, ...(dated ? { date: r.workDate } : {}) },
        now: dated ? ctx.now : new Date(Date.parse(r.workDate) + NOON_MS),
      }),
    )
  }
  await awaitTimeRowWrites()
  ctx.log(`time: ${plan.taskTime.length} rows`)

  // Cost rates through the rate writer, as finance sets them.
  const finance = await actors("anais")
  for (const r of plan.costRates) {
    await asUser(finance, (tx) =>
      setCostRate({
        tx: tx as never,
        orgId: ctx.orgId,
        scopes: finance.scopes,
        input: {
          userId: userIdOf(org, r.person),
          rate: r.rateMinor / 100,
          from: r.effectiveFrom,
          currency: r.currency,
        },
      }),
    )
  }
  await seedStudioAway(ctx, org, owner, plan)

  // The product writes each task now, at the seed's run, and setting its timebox touches it
  // again; a task the plan closed weeks ago was last changed when it closed. Its row says so,
  // so a list's "updated" day is the close, not the day the world was seeded.
  await withPrivilegedDb(ctx.orgId, "seed-studio:task-closed-at", (tx) =>
    tx.execute(sql`
      UPDATE ${sql.raw(schemaRef("app_projects"))}.tasks
         SET updated_at = completed_at, created_at = least(created_at, completed_at)
       WHERE org_id = ${ctx.orgId}::uuid AND completed_at IS NOT NULL
         AND external_ref LIKE ${`${studioTaskRef("")}%`}`),
  )
}
