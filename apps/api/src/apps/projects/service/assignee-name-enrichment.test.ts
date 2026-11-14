// SPDX-License-Identifier: FSL-1.1-ALv2
// tasks_byProject / tasks_byAssignee surface the assignee's display NAME (`assigneeName`) on every
// row, joined from kernel.users, so a readout of a project's tasks says who holds each one without
// a separate per-id user lookup. The sprint-board proxy is per-status (terminal flag) task counts;
// people are never ranked or compared by their task counts. Fails without the LEFT JOIN
// kernel.users enrichment (assigneeName would be undefined), passes with it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { createProject } from "~/apps/projects/service/create-project"
import {
  createTask,
  listProjectTasks,
  listTasksAcrossProjects,
} from "~/apps/projects/service/tasks"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { ActorContext, UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"

// Hermeticity (module-mock poisoning), defense-in-depth: a neighbouring file
// (`modules/apps/sandbox/rpc-bridge.k4.test.ts`) calls
// `mock.module("~/modules/apps/execute-tool", ...)`. That polluter is now
// spread-complete + restores the real module in `afterAll`, which removes the
// MISSING-EXPORT class. But its `executeToolCore` OVERRIDE still leaks to any
// consumer whose execute-tool binding resolves at MODULE SCOPE: Bun evaluates
// all files' module-scope code (including a plain `await import(...)`) BEFORE
// any `afterAll` runs, so a normal import here would still capture k4's stubbed
// `executeToolCore` (returning its leftover `nextEnvelope` = `{ data: null }`).
// A query-string-suffixed specifier is a DISTINCT module key that Bun's mock
// registry never matches, so it loads a FRESH, unmocked copy of execute-tool
// regardless of evaluation order — recovering the genuine dispatch path.
const { executeTool } = (await import(
  `${import.meta.dir}/../../../modules/apps/execute-tool.ts?hermetic=projects-assignee`
)) as typeof import("~/modules/apps/execute-tool")

import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let callerId: string
let liamId: string
let sofiaId: string
let actor: UserContext
let projectId: string
let openStatusId: string
let doneStatusId: string

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:write",
  "kernel:threads:read",
]

async function mkUser(name: string): Promise<string> {
  const rows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`an-${name}-${Date.now()}-${Math.random()}@xp.test`}, ${name}, 'active', 'h', 1, 1)
      RETURNING id
    `),
  )
  return rows[0]!.id
}

beforeAll(async () => {
  await acquireTestLock()
  const orgRows = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Assignee Name', ${`assignee-name-${Date.now()}-${Math.random()}`}) RETURNING id
    `),
  )
  orgId = orgRows[0]!.id
  callerId = await mkUser("Caller Admin")
  liamId = await mkUser("Liam Support")
  sofiaId = await mkUser("Sofia Editor")
  actor = {
    actorType: "user",
    userId: callerId,
    orgId,
    scopes: SCOPES,
    dimensionGrants: { "*": ["*"] },
  }

  await withRlsContext(actor, async (tx) => {
    const p = await createProject({ tx, orgId, actor, input: { name: "Product Roadmap" } })
    projectId = p.id
    openStatusId = p.statuses.find((s) => !s.terminal)!.id
    doneStatusId = p.statuses.find((s) => s.terminal)!.id
    // Liam holds 2 open, Sofia 1 open + 1 done, plus 1 unassigned.
    await createTask({
      tx,
      orgId,
      actor,
      input: { projectId, statusId: openStatusId, title: "liam-1", assigneeId: liamId },
    })
    await createTask({
      tx,
      orgId,
      actor,
      input: { projectId, statusId: openStatusId, title: "liam-2", assigneeId: liamId },
    })
    await createTask({
      tx,
      orgId,
      actor,
      input: { projectId, statusId: openStatusId, title: "sofia-1", assigneeId: sofiaId },
    })
    await createTask({
      tx,
      orgId,
      actor,
      input: { projectId, statusId: doneStatusId, title: "sofia-done", assigneeId: sofiaId },
    })
    await createTask({
      tx,
      orgId,
      actor,
      input: { projectId, statusId: openStatusId, title: "unassigned-1" },
    })
  })
  await ensureAppsForOrg(orgId, {})
})

afterAll(async () => {
  await releaseTestLock()
})

describe("listProjectTasks — assigneeName enrichment (per-person workload proxy)", () => {
  it("carries each task's assignee display NAME (null when unassigned)", async () => {
    await withRlsContext(actor, async (tx) => {
      const res = await listProjectTasks({ tx, orgId, projectId } as never)
      const byTitle = new Map(res.items.map((t) => [t.title, t]))
      expect(byTitle.get("liam-1")!.assigneeName).toBe("Liam Support")
      expect(byTitle.get("liam-2")!.assigneeName).toBe("Liam Support")
      expect(byTitle.get("sofia-1")!.assigneeName).toBe("Sofia Editor")
      expect(byTitle.get("unassigned-1")!.assigneeName).toBeNull()
    })
  })

  it("done-vs-remaining split via the terminal flag stays derivable alongside the name", async () => {
    await withRlsContext(actor, async (tx) => {
      const res = await listProjectTasks({ tx, orgId, projectId } as never)
      const done = res.items.filter((t) => t.statusTerminal).length
      const remaining = res.items.filter((t) => !t.statusTerminal).length
      expect(done).toBe(1)
      expect(remaining).toBe(4)
    })
  })

  it("surfaces assigneeName through the projects:tasks_byProject tool (manifest → rpc bridge)", async () => {
    const out = await executeTool({
      toolName: "projects:tasks_byProject",
      orgId,
      actor: actor as ActorContext,
      params: { projectId },
    })
    const data = out.data as { items: { title: string; assigneeName: string | null }[] }
    const liam1 = data.items.find((t) => t.title === "liam-1")
    expect(liam1?.assigneeName).toBe("Liam Support")
  })
})

describe("listTasksAcrossProjects — assigneeName enrichment", () => {
  it("carries the assignee NAME on each cross-project row", async () => {
    await withRlsContext(actor, async (tx) => {
      const res = await listTasksAcrossProjects({ tx, orgId, assigneeId: liamId } as never)
      expect(res.items.length).toBe(2)
      expect(res.items.every((t) => t.assigneeName === "Liam Support")).toBe(true)
    })
  })
})
