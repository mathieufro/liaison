// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every way a deal reaches a closing stage sets its outcome once: the same
// outcome, close stamps and one closed event, whichever path wrote the status.
// Real database, real liaison_rls role.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { setDealOutcome } from "~/apps/projects/service/deals"
import { moveTask } from "~/apps/projects/service/move-task"
import { deleteStatus, migrateStatusTasks } from "~/apps/projects/service/statuses"
import { mergeTasks, updateTask } from "~/apps/projects/service/tasks"
import { withRlsContext } from "~/db/rls"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  type DealWorld,
  dealEvents,
  dealState,
  makeDealWorld,
  makePipeline,
  makeTask,
  type Pipeline,
  taskStatus,
} from "./__tests__/deal-world"

let w: DealWorld

beforeAll(async () => {
  await acquireTestLock()
  w = await makeDealWorld("deal-paths")
})

afterAll(releaseTestLock)

type Path = (p: Pipeline, taskId: string) => Promise<void>

const run = <T>(fn: (tx: Parameters<Parameters<typeof withRlsContext>[1]>[0]) => Promise<T>) =>
  withRlsContext(w.actor, fn)

const paths: Array<[string, Path]> = [
  [
    "update",
    (p, taskId) =>
      run((tx) =>
        updateTask({
          tx,
          orgId: w.orgId,
          actor: w.actor,
          taskId,
          input: { statusId: p.stage.Won },
        }),
      ).then(() => undefined),
  ],
  [
    "bulk update",
    // A bulk status change runs `update` once per item.
    async (p, taskId) => {
      const other = await makeTask(w, p.projectId, "Second in the batch")
      for (const id of [taskId, other]) {
        await run((tx) =>
          updateTask({
            tx,
            orgId: w.orgId,
            actor: w.actor,
            taskId: id,
            input: { statusLabel: "won" },
          }),
        )
      }
    },
  ],
  [
    "move",
    (p, taskId) =>
      run((tx) =>
        moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId, statusId: p.stage.Won }),
      ).then(() => undefined),
  ],
  [
    "cross-project move",
    async (_p, taskId) => {
      const other = await makePipeline(w, "Other pipeline")
      await run((tx) =>
        moveTask({
          tx,
          orgId: w.orgId,
          actor: w.actor,
          taskId,
          targetProjectId: other.projectId,
          statusId: other.stage.Won,
        }),
      )
    },
  ],
  [
    "merge",
    // The survivor is closed; merging another deal into it closes nothing again.
    async (p, taskId) => {
      await run((tx) =>
        moveTask({ tx, orgId: w.orgId, actor: w.actor, taskId, statusId: p.stage.Won }),
      )
      const source = await makeTask(w, p.projectId, "Duplicate deal")
      await run((tx) =>
        mergeTasks({ tx, orgId: w.orgId, actor: w.actor, sourceId: source, targetId: taskId }),
      )
    },
  ],
  [
    "status delete",
    // Deleting a stage moves its deals to another stage first.
    async (p) => {
      await run((tx) =>
        migrateStatusTasks({
          tx,
          orgId: w.orgId,
          actor: w.actor,
          projectId: p.projectId,
          sourceStatusId: p.stage.Lead!,
          targetStatusId: p.stage.Won!,
        }),
      )
      await run((tx) =>
        deleteStatus({
          tx,
          orgId: w.orgId,
          actor: w.actor,
          projectId: p.projectId,
          statusId: p.stage.Lead!,
        }),
      )
    },
  ],
  [
    "board drag",
    // The board's drag goes through the project's own move route.
    (p, taskId) =>
      run((tx) =>
        moveTask({
          tx,
          orgId: w.orgId,
          actor: w.actor,
          projectId: p.projectId,
          taskId,
          statusId: p.stage.Won,
          beforeTaskId: null,
          afterTaskId: null,
        }),
      ).then(() => undefined),
  ],
  [
    "deal update",
    (_p, taskId) =>
      run((tx) =>
        setDealOutcome({ tx, orgId: w.orgId, actor: w.actor, taskId, outcome: "won" }),
      ).then(() => undefined),
  ],
]

describe("deal outcome paths", () => {
  it("reaching a won or lost stage by update, bulk update, move, cross-project move, merge, status delete, board drag or deal update sets the outcome once", async () => {
    const seen: Record<string, unknown> = {}
    for (const [name, path] of paths) {
      const p = await makePipeline(w, `Pipeline ${name}`)
      const taskId = await makeTask(w, p.projectId, `Deal by ${name}`, { statusId: p.stage.Lead })
      expect((await dealState(taskId))?.outcome).toBe("open")
      await path(p, taskId)
      const state = await dealState(taskId)
      seen[name] = {
        outcome: state?.outcome,
        closed: state?.closed_at !== null,
        closedBy: state?.closed_by === w.userId,
        events: await dealEvents(w, taskId),
      }
    }
    const expected = { outcome: "won", closed: true, closedBy: true, events: ["closed:won"] }
    expect(seen).toEqual(Object.fromEntries(paths.map(([name]) => [name, expected])))
  })

  it("marking done on a board with two closing stages names both and changes nothing", async () => {
    const p = await makePipeline(w, "Done on a pipeline")
    const taskId = await makeTask(w, p.projectId, "Lumen", { statusId: p.stage.Proposal })
    const err = await run((tx) =>
      updateTask({ tx, orgId: w.orgId, actor: w.actor, taskId, input: { statusLabel: "done" } }),
    ).catch((e: unknown) => e as { code?: string; message?: string; details?: unknown })
    expect(err).toMatchObject({ code: "status_not_found" })
    expect((err as { message: string }).message).toContain('"Won" or "Lost"')
    expect((err as { message: string }).message).toContain("nothing was changed")
    expect((err as { details: { closingStages: unknown } }).details.closingStages).toEqual([
      { id: p.stage.Won, label: "Won", outcome: "won" },
      { id: p.stage.Lost, label: "Lost", outcome: "lost" },
    ])
    expect(await taskStatus(taskId)).toBe(p.stage.Proposal!)
    expect((await dealState(taskId))?.outcome).toBe("open")
    expect(await dealEvents(w, taskId)).toEqual([])
  })
})
