// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The projects factory on the real database: board numbers kept across gaps,
// timeboxes and milestones through the task plan writer (refused on a project
// that does not use time and budgets), time taken in one write per person, and
// a re-run that adopts every row instead of adding one.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { awaitTimeFeatureSync } from "~/apps/projects/service/time-feature"
import { updateProjectWithOutcome } from "~/apps/projects/service/update-project"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { seedContext } from "~/seed/context"
import { asUser, rowsOf } from "~/seed/factories/people/actors"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { type ProjectSpec, seedProject, type TaskSpec } from "./projects"
import { seedTaskTime } from "./time"

let orgId = ""
let owner: UserContext

const ref = (key: string) => `factory-test:${key}`

function spec(key: string, tasks: TaskSpec[]): ProjectSpec {
  return { key, name: `Maison ${key}`, description: "", icon: "folder", owner: "owner", tasks }
}

async function seed(s: ProjectSpec) {
  return seedProject(seedContext({ orgId, now: new Date() }), owner, {
    people: { owner: { userId: owner.userId } },
    spec: s,
    externalRefOf: ref,
  })
}

async function rows(projectId: string) {
  return rowsOf<{ number: number; timebox: number | null; milestone: boolean; ref: string }>(
    await db.execute(
      sql`SELECT number, timebox_minutes AS timebox, is_milestone AS milestone, external_ref AS ref
            FROM app_projects.tasks WHERE project_id = ${projectId}::uuid ORDER BY number`,
    ),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  const session = await minimal.adminSession(orgId)
  owner = {
    actorType: "user",
    userId: session.userId,
    orgId,
    scopes: ["*"],
    dimensionGrants: { "*": ["*"] },
  }
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
}, 120_000)

afterAll(async () => {
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("the projects factory", () => {
  const tasks: TaskSpec[] = [
    {
      key: "BOARD-1",
      title: "Discovery",
      status: "done",
      number: 1,
      isMilestone: true,
      timeboxMinutes: 600,
    },
    {
      key: "BOARD-4",
      title: "Interviews",
      status: "done",
      number: 4,
      parent: "BOARD-1",
      timeboxMinutes: 90,
    },
    { key: "BOARD-9", title: "Audit", status: "todo", number: 9, parent: "BOARD-1" },
  ]

  it("keeps the board's numbers across gaps and writes timeboxes through the plan writer", async () => {
    const first = await seed(spec("BOARD", []))
    await asUser(owner, (tx) =>
      updateProjectWithOutcome({
        tx: tx as never,
        orgId,
        projectId: first.projectId,
        actor: owner,
        patch: { timeBudgets: true },
      }),
    )
    await awaitTimeFeatureSync(orgId)
    const { projectId, taskIds } = await seed(spec("BOARD", tasks))
    expect(taskIds).toHaveLength(3)
    expect((await rows(projectId)).map((r) => [r.number, r.timebox, r.milestone])).toEqual([
      [1, 600, true],
      [4, 90, false],
      [9, null, false],
    ])
  })

  it("a re-run adopts every task and writes no second row", async () => {
    const { projectId, taskIds } = await seed(spec("BOARD", tasks))
    expect(taskIds).toHaveLength(3)
    expect(await rows(projectId)).toHaveLength(3)
  })

  it("a timebox on a project that does not use time and budgets is refused, nothing written", async () => {
    await expect(
      seed(
        spec("PLAIN", [
          { key: "PLAIN-1", title: "Boxed", status: "todo", number: 1, timeboxMinutes: 60 },
        ]),
      ),
    ).rejects.toThrow()
    const left = rowsOf<{ n: number }>(
      await db.execute(
        sql`SELECT count(*)::int AS n FROM app_projects.tasks
             WHERE org_id = ${orgId}::uuid AND external_ref = ${ref("PLAIN-1")}`,
      ),
    )
    expect(left[0]?.n).toBe(0)
  })

  it("numbers on some tasks and not others are refused", async () => {
    await expect(
      seed(
        spec("MIXED", [
          { key: "MIXED-1", title: "One", status: "todo", number: 1 },
          { key: "MIXED-2", title: "Two", status: "todo" },
        ]),
      ),
    ).rejects.toThrow("numbers some tasks and not others")
  })

  it("one person's time lands in one write, and a re-run adds nothing", async () => {
    const { projectId, taskIds } = await seed(spec("BOARD", tasks))
    const ctx = seedContext({ orgId, now: new Date() })
    const lines = [
      { taskId: taskIds[1] as string, projectId, workDate: "2026-10-05", minutes: 60 },
      { taskId: taskIds[1] as string, projectId, workDate: "2026-10-06", minutes: 30 },
    ]
    await seedTaskTime(ctx, owner, lines)
    await seedTaskTime(ctx, owner, lines)
    const time = rowsOf<{ n: number; m: number }>(
      await db.execute(
        sql`SELECT count(*)::int AS n, sum(minutes)::int AS m FROM app_projects.task_time
             WHERE project_id = ${projectId}::uuid`,
      ),
    )
    expect(time[0]).toEqual({ n: 2, m: 90 })
  })
})
