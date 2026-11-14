// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Time and budgets is per project, and the org's feature row follows the
// projects: on if and only if a work project has it on. These tests drive the
// real writer (the projects bridge as the agent's tools reach it, and the REST
// routes), the real privileged recompute and the real catalog readers.
//
// The time tools are every projects tool that declares the feature. The list is
// computed from the registry, never frozen; `task_time_get` is the one each
// check names, so the gate bites on a real time tool.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { flushEventHandlers } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import {
  ALL_DEFERRED_TOOLS_UNLOCKED,
  buildToolSet,
  listDeferredTools,
  listGatewayTools,
} from "~/modules/agent/tools/tool-bridge"
import { handleToolSearch } from "~/modules/agent/tools/tool-search"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, isFeatureOffForTool, primeOrgApps } from "~/modules/apps/org-apps"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import {
  __resetCatalogNotifier,
  registerActiveServer,
  unregisterActiveServer,
} from "~/modules/mcp/catalog-notifier"
import { insertSql } from "~/seed/factories/org/test-rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { awaitTimeFeatureSync, syncTimeBudgetsFeature, timeFeatureTestHooks } from "./time-feature"

const TIME_TOOL = "task_time_get"
/** Keys a time-carrying row would hold; none may appear on a project without it. */
const TIME_KEYS = ["timeboxMinutes", "realTotalMinutes", "coverage"]

let orgId = ""
let owner: minimal.Session

function actor(scopes: string[] = ["*"]): UserContext {
  return { actorType: "user", userId: owner.userId, orgId, scopes, dimensionGrants: { "*": ["*"] } }
}

/** Every projects tool behind the feature an agent is shown, read from the registry. */
function timeTools(): string[] {
  const out: string[] = []
  for (const [key, def] of toolRegistry.entriesOf(orgId)) {
    const d = def as { feature?: string; agentVisible?: boolean }
    if (key[1] === "projects" && d.feature === "time_budgets" && d.agentVisible !== false) {
      out.push(`projects__${key[2]}`)
    }
  }
  return out.sort()
}

async function call<T = Record<string, any>>(
  method: string,
  input: unknown,
  opts: { scopes?: string[]; origin?: "in-app-agent" | "mcp" | "human-ui" } = {},
): Promise<T> {
  const a = actor(opts.scopes)
  return withRlsContext(a, async (tx) => {
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
}

async function turn(projectId: string, on: boolean, scopes?: string[]) {
  const result = await call("projects_updateProject", { projectId, timeBudgets: on }, { scopes })
  await awaitTimeFeatureSync(orgId)
  return result
}

async function newProject(name: string): Promise<string> {
  const made = await call<{ id: string }>("projects_createProject", { name })
  return made.id
}

async function newPipeline(name: string): Promise<string> {
  const { createPipeline } = await import("./create-project")
  const p = await withRlsContext(actor(), (tx) =>
    createPipeline({ tx, orgId, actor: actor(), input: { name } }),
  )
  return p.id
}

const orgRow = async (): Promise<boolean | null> =>
  extractRows<{ enabled: boolean }>(
    await db.execute(drizzleSql`
      SELECT enabled FROM kernel.org_app_features
      WHERE org_id = ${orgId}::uuid AND app_name = 'projects' AND feature = 'time_budgets'`),
  )[0]?.enabled ?? null

const anyOn = async (): Promise<boolean> =>
  extractRows<{ on: boolean }>(
    await db.execute(drizzleSql`
      SELECT EXISTS (SELECT 1 FROM app_projects.projects
        WHERE org_id = ${orgId}::uuid AND kind = 'work' AND time_budgets_on) AS on`),
  )[0]?.on === true

async function allOff() {
  await db.execute(drizzleSql`
    UPDATE app_projects.projects SET time_budgets_on = false WHERE org_id = ${orgId}::uuid`)
  await syncTimeBudgetsFeature(orgId, owner.userId)
}

const catalogNames = () => ({
  gateway: listGatewayTools(orgId, actor()).map((t) => t.sdkName),
  inApp: listDeferredTools(orgId, actor()).map((t) => t.sdkName),
  turn: Object.keys(buildToolSet(orgId, actor(), undefined, ALL_DEFERRED_TOOLS_UNLOCKED)),
})

beforeAll(async () => {
  await acquireTestLock()
  registerEventSubscribers()
  orgId = (await createTestOrg()).id
  owner = await minimal.adminSession(orgId)
  await ensureAppsForOrg(orgId)
  await primeOrgApps(orgId, 0)
}, 120_000)

afterAll(async () => {
  timeFeatureTestHooks.afterRead = undefined
  forgetOrgApps(orgId)
  await releaseTestLock()
})

describe("the org gate follows the projects", () => {
  it("an org with no project using time has none of the time tools in the MCP list, the in-app catalog, tool search and a turn's tool set", async () => {
    await allOff()
    const tools = timeTools()
    expect(tools).toContain(`projects__${TIME_TOOL}`)
    const seen = catalogNames()
    for (const tool of tools) {
      expect(seen.gateway).not.toContain(tool)
      expect(seen.inApp).not.toContain(tool)
      expect(seen.turn).not.toContain(tool)
    }
    // The plain projects tools stay: only the feature's are filtered.
    expect(seen.gateway).toContain("projects__update_project")
    const found = await handleToolSearch({ query: `select:projects__${TIME_TOOL}` }, {
      orgId,
      userId: owner.userId,
      scopes: ["*"],
    } as never)
    expect(JSON.stringify(found)).not.toContain(`"projects__${TIME_TOOL}"`)
  })

  it("a time tool called directly in such an org answers feature_off and writes nothing, from the UI too", async () => {
    await allOff()
    for (const origin of ["in-app-agent", "human-ui", "mcp"] as const) {
      const envelope = await executeToolCore({
        toolName: `projects:${TIME_TOOL}`,
        orgId,
        actor: actor(),
        params: {},
        origin,
      } as never)
      const error = (envelope as { error?: Record<string, any> }).error
      expect(error?.code).toBe("feature_off")
      expect(error?.retryable).toBe(false)
    }
  })

  it("the first project on adds the tools and sends list_changed, the last off removes them", async () => {
    await allOff()
    while ((await processOutboxBatch()) > 0) {
      // Earlier events delivered before the session opens.
    }
    await flushEventHandlers()
    let listChanged = 0
    registerActiveServer({
      connectionId: "time-switch",
      orgId,
      ownerId: owner.userId,
      sendListChanged: () => {
        listChanged += 1
      },
    })
    const waitForNotice = async (count: number) => {
      await processOutboxBatch()
      await flushEventHandlers()
      const deadline = Date.now() + 10_000
      while (listChanged < count && Date.now() < deadline) await Bun.sleep(50)
    }
    try {
      const a = await newProject("Atlas build")
      const b = await newProject("Orbit build")
      await turn(a, true)
      expect(await orgRow()).toBe(true)
      for (const tool of timeTools()) expect(catalogNames().gateway).toContain(tool)
      expect(catalogNames().turn).toContain(`projects__${TIME_TOOL}`)
      await waitForNotice(1)
      expect(listChanged).toBe(1)

      await turn(b, true)
      await turn(a, false)
      expect(await orgRow()).toBe(true)
      expect(catalogNames().gateway).toContain(`projects__${TIME_TOOL}`)

      await turn(b, false)
      expect(await orgRow()).toBe(false)
      for (const tool of timeTools()) expect(catalogNames().gateway).not.toContain(tool)
      await waitForNotice(2)
      expect(listChanged).toBe(2)
    } finally {
      unregisterActiveServer("time-switch")
      __resetCatalogNotifier()
    }
  }, 60_000)

  it("first-on and last-off racing end with the row equal to the projects", async () => {
    const p1 = await newProject("House rework")
    const p2 = await newProject("House move")
    const setOn = (id: string, on: boolean) =>
      db.execute(drizzleSql`
        UPDATE app_projects.projects SET time_budgets_on = ${on} WHERE id = ${id}::uuid`)
    // One writer turns p2 on (first on), the other turns p1 off (last off); each commits,
    // then recomputes. The hook pauses the first recompute between its read and its write,
    // still holding the lock, while the other writer commits and recomputes.
    const interleavings: Array<{ name: string; run: () => Promise<void> }> = [
      {
        name: "on commits and recomputes, then off",
        run: async () => {
          await setOn(p2, true)
          await syncTimeBudgetsFeature(orgId, null)
          await setOn(p1, false)
          await syncTimeBudgetsFeature(orgId, null)
        },
      },
      {
        name: "off commits and recomputes, then on",
        run: async () => {
          await setOn(p1, false)
          await syncTimeBudgetsFeature(orgId, null)
          await setOn(p2, true)
          await syncTimeBudgetsFeature(orgId, null)
        },
      },
      {
        name: "on's recompute has read and holds the lock while off commits",
        run: async () => {
          await setOn(p2, true)
          let release!: () => void
          const gate = new Promise<void>((r) => (release = r))
          let entered!: () => void
          const inLock = new Promise<void>((r) => (entered = r))
          timeFeatureTestHooks.afterRead = async () => {
            timeFeatureTestHooks.afterRead = undefined
            entered()
            await gate
          }
          const first = syncTimeBudgetsFeature(orgId, null)
          await inLock
          await setOn(p1, false)
          // Another process: its own connection, so only the lock can make it wait.
          const second = syncTimeBudgetsFeature(orgId, null, { pool: "jobs" })
          // Long enough for the other recompute to read and write, were it not held.
          await Bun.sleep(300)
          release()
          await Promise.all([first, second])
        },
      },
      {
        name: "off's recompute has read nothing on and holds the lock while on commits",
        run: async () => {
          await setOn(p1, false)
          let release!: () => void
          const gate = new Promise<void>((r) => (release = r))
          let entered!: () => void
          const inLock = new Promise<void>((r) => (entered = r))
          timeFeatureTestHooks.afterRead = async () => {
            timeFeatureTestHooks.afterRead = undefined
            entered()
            await gate
          }
          const first = syncTimeBudgetsFeature(orgId, null)
          await inLock
          await setOn(p2, true)
          // Another process: its own connection, so only the lock can make it wait.
          const second = syncTimeBudgetsFeature(orgId, null, { pool: "jobs" })
          // Long enough for the other recompute to read and write, were it not held.
          await Bun.sleep(300)
          release()
          await Promise.all([first, second])
        },
      },
    ]
    for (const case_ of interleavings) {
      await allOff()
      await setOn(p1, true)
      await syncTimeBudgetsFeature(orgId, null)
      expect(await orgRow()).toBe(true)
      await case_.run()
      expect({ case: case_.name, row: await orgRow() }).toEqual({
        case: case_.name,
        row: await anyOn(),
      })
    }
    await allOff()
    expect(await orgRow()).toBe(false)
  }, 60_000)

  it("a second process that primed the org before the first project turned on reads the feature on", async () => {
    await allOff()
    const p = await newProject("Cold read")
    const peer = Bun.spawn(
      [
        "bun",
        "run",
        "src/modules/apps/org-features.peer.test-helpers.ts",
        orgId,
        "projects",
        "time_budgets",
      ],
      {
        cwd: `${import.meta.dir}/../../../..`,
        env: process.env,
        stdout: "pipe",
        stderr: "inherit",
      },
    )
    const lines = peer.stdout.pipeThrough(new TextDecoderStream()).getReader()
    expect(((await lines.read()).value ?? "").trim()).toBe("off")
    await turn(p, true)
    await peer.exited
    let rest = ""
    for (let read = await lines.read(); !read.done; read = await lines.read()) rest += read.value
    expect(rest.trim()).toBe("on")
    await allOff()
  }, 60_000)
})

describe("the switch on a project", () => {
  it("a flip writes one audit row and a repeat writes none", async () => {
    await allOff()
    const p = await newProject("Audit trail")
    const events = async () =>
      Number(
        extractRows<{ n: number | string }>(
          await db.execute(drizzleSql`
            SELECT count(*) AS n FROM kernel.pending_events
            WHERE org_id = ${orgId}::uuid AND payload->>'entity' = 'time_feature'
              AND payload->>'entityId' = ${p}`),
        )[0]?.n ?? 0,
      )
    const stamp = async () =>
      extractRows<{ by: string | null; at: string | null; updated: string }>(
        await db.execute(drizzleSql`
          SELECT time_budgets_changed_by::text AS by, time_budgets_changed_at::text AS at,
                 updated_at::text AS updated
          FROM app_projects.projects WHERE id = ${p}::uuid`),
      )[0]!
    const on = await turn(p, true)
    expect(on.timeBudgets).toBe(true)
    expect(await events()).toBe(1)
    const first = await stamp()
    expect(first.by).toBe(owner.userId)
    expect(first.at).not.toBeNull()

    const again = await turn(p, true)
    expect(again.timeBudgets).toBe(true)
    expect(String(again.timeBudgetsNote)).toContain("already on")
    expect(await events()).toBe(1)
    expect(await stamp()).toEqual(first)
    await allOff()
  })

  it("turning a project off and on keeps every row", async () => {
    await allOff()
    const p = await newProject("Keep rows")
    const made = await call<{ id: string }>("projects_createTask", { projectId: p, title: "Kept" })
    await db.execute(drizzleSql`
      UPDATE app_projects.tasks SET timebox_minutes = 420 WHERE id = ${made.id}::uuid`)
    const counts = async () => {
      const tables = extractRows<{ table_name: string }>(
        await db.execute(drizzleSql`
          SELECT c.table_name FROM information_schema.columns c
          JOIN information_schema.tables t
            ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'app_projects' AND c.column_name = 'org_id'
            AND t.table_type = 'BASE TABLE'
          ORDER BY c.table_name`),
      )
      const out: Record<string, number> = {}
      for (const { table_name } of tables) {
        const [row] = extractRows<{ n: number | string }>(
          await db.execute(
            drizzleSql`SELECT count(*) AS n FROM ${drizzleSql.raw(`app_projects."${table_name}"`)}
              WHERE org_id = ${orgId}::uuid`,
          ),
        )
        out[table_name] = Number(row?.n ?? 0)
      }
      return out
    }
    await turn(p, true)
    const before = await counts()
    await turn(p, false)
    expect(await orgRow()).toBe(false)
    await turn(p, true)
    expect(await counts()).toEqual(before)
    const [task] = extractRows<{ timebox_minutes: number | null }>(
      await db.execute(drizzleSql`
        SELECT timebox_minutes FROM app_projects.tasks WHERE id = ${made.id}::uuid`),
    )
    expect(task?.timebox_minutes).toBe(420)
    await allOff()
  })

  it("a pipeline project cannot be turned on: update_project answers planning_off and writes nothing", async () => {
    await allOff()
    const pipe = await newPipeline("Sales pipeline")
    const refused = await turn(pipe, true)
    expect(refused.error?.code).toBe("planning_off")
    expect(refused.error?.details?.canTurnOn).toBe(false)
    expect(refused.error?.details?.next).toBe("Say so. Do not offer to turn it on.")
    const [row] = extractRows<{ on: boolean; by: string | null }>(
      await db.execute(drizzleSql`
        SELECT time_budgets_on AS on, time_budgets_changed_by::text AS by
        FROM app_projects.projects WHERE id = ${pipe}::uuid`),
    )
    expect(row).toEqual({ on: false, by: null })
    expect(await orgRow()).toBe(false)
  })

  it("turning it from a routine or a sub-run is refused human_turn_only, and the rest of update_project still runs there", async () => {
    await allOff()
    const p = await newProject("Routine edit")
    for (const frame of [{ routineId: crypto.randomUUID() }, { background: true }]) {
      const refused = await runContextStore.run(frame as never, () =>
        call(
          "projects_updateProject",
          { projectId: p, timeBudgets: true },
          { origin: "in-app-agent" },
        ),
      )
      expect(refused.error?.code).toBe("human_turn_only")
      const renamed = await runContextStore.run(frame as never, () =>
        call(
          "projects_updateProject",
          { projectId: p, description: "Edited by a routine" },
          { origin: "in-app-agent" },
        ),
      )
      expect(renamed.description).toBe("Edited by a routine")
    }
    await awaitTimeFeatureSync(orgId)
    expect(await orgRow()).toBe(false)
    // In the app and over MCP a person turns it.
    const fromUi = await call(
      "projects_updateProject",
      { projectId: p, timeBudgets: true },
      {
        origin: "human-ui",
      },
    )
    expect(fromUi.timeBudgets).toBe(true)
    await awaitTimeFeatureSync(orgId)
    await allOff()
  })

  it("an org not using it sees no switch key on a project, and a call that passes it sees both keys", async () => {
    await allOff()
    const p = await newProject("Plain board")
    const plain = await call("projects_updateProject", { projectId: p, description: "x" })
    for (const key of ["timeBudgets", "timeBudgetsNote", "timeBudgetsChangedAt"]) {
      expect(Object.keys(plain)).not.toContain(key)
    }
    const rollup = await call<{ projects: Array<Record<string, unknown>> }>(
      "projects_portfolioRollup",
      {},
    )
    for (const row of rollup.projects) expect(Object.keys(row)).not.toContain("timeBudgets")
    const passed = await turn(p, false)
    expect(passed.timeBudgets).toBe(false)
    expect(String(passed.timeBudgetsNote)).toContain("already off")
    // In use, the rollup carries the switch per project.
    await turn(p, true)
    const inUse = await call<{ projects: Array<Record<string, unknown>> }>(
      "projects_portfolioRollup",
      {},
    )
    expect(inUse.projects.find((r) => r.projectId === p)?.timeBudgets).toBe(true)
    await allOff()
  })

  it("reads carry no time key on a project without it, row by row", async () => {
    await allOff()
    const on = await newProject("Timed board")
    const off = await newProject("Untimed board")
    await turn(on, true)
    const task = await call<{ id: string; statusId: string }>("projects_createTask", {
      projectId: off,
      title: "Untimed task",
      assigneeId: owner.userId,
    })
    const reads: unknown[] = [
      task,
      await call("projects_get", { taskId: task.id }),
      await call("projects_search", { query: "Untimed" }),
      await call("projects_tasksByProject", { projectId: off }),
      await call("projects_tasksByAssignee", { assigneeId: owner.userId }),
      await call("projects_updateTask", { taskId: task.id, title: "Untimed task, renamed" }),
    ]
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) {
        for (const [i, v] of value.entries()) walk(v, `${path}[${i}]`)
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          expect({ path, key: k, timeKey: TIME_KEYS.includes(k) }).toEqual({
            path,
            key: k,
            timeKey: false,
          })
          walk(v, `${path}.${k}`)
        }
      }
    }
    for (const [i, r] of reads.entries()) walk(r, `read${i}`)
    expect(isFeatureOffForTool(orgId, { appName: "projects", feature: "time_budgets" })).toBe(false)
    await allOff()
  })
})

describe("an approved call keeps the place it was asked from", () => {
  /** A held approval of update_project, as a turn with or without a person left it. */
  async function heldApproval(originHasPerson: boolean | undefined): Promise<string> {
    const id = crypto.randomUUID()
    const threadId = await minimal.thread(orgId, owner.userId)
    const metadata = JSON.stringify(originHasPerson === undefined ? {} : { originHasPerson })
    await sql.unsafe(
      insertSql("kernel.approval_requests", {
        id,
        org_id: orgId,
        handle: `ap-${id.slice(0, 8)}`,
        thread_id: threadId,
        originating_thread_id: threadId,
        tool_name: "projects:update_project",
        tool_params: { raw: `'{}'::jsonb` },
        current_payload: { raw: `'{}'::jsonb` },
        expires_at: { raw: "now() + interval '1 day'" },
        requested_by: owner.userId,
        status: "approved",
        reason: "gated",
        summary: { raw: `'{"kind":"update_project","title":"Update project","lines":[]}'::jsonb` },
        metadata: { raw: `'${metadata}'::jsonb` },
      }),
    )
    return id
  }

  /** The projects bridge as an approved re-entry builds it: an approval context, no routine. */
  async function approvedCall<T = Record<string, any>>(
    approvalRequestId: string,
    method: string,
    input: unknown,
  ): Promise<T> {
    const a = actor()
    return runContextStore.run(
      { runId: approvalRequestId, rootRunId: approvalRequestId, nestingDepth: 0 } as never,
      () =>
        withRlsContext(a, async (tx) => {
          const bridge = createRpcBridge(
            "projects",
            a.userId,
            orgId,
            tx,
            { name: "projects" },
            a.scopes,
            "user",
            {
              approvalRequestId,
              approvalDeciderId: owner.userId,
              toolName: "projects:update_project",
            },
            { origin: "in-app-agent" } as never,
          )
          return JSON.parse(await bridge[method](JSON.stringify(input))) as T
        }),
    )
  }

  it("a switch a sub-run asked for is refused human_turn_only when approved, and one a person asked for turns", async () => {
    await allOff()
    const p = await newProject("Approved switch")
    const fromSubRun = await heldApproval(false)
    const refused = await approvedCall(fromSubRun, "projects_updateProject", {
      projectId: p,
      timeBudgets: true,
    })
    expect(refused.error?.code).toBe("human_turn_only")
    await awaitTimeFeatureSync(orgId)
    expect(await orgRow()).toBe(false)
    for (const person of [true, undefined]) {
      const held = await heldApproval(person)
      const turned = await approvedCall(held, "projects_updateProject", {
        projectId: p,
        timeBudgets: true,
      })
      expect(turned.timeBudgets).toBe(true)
      await awaitTimeFeatureSync(orgId)
      await allOff()
    }
  })

  it("time a sub-run asked to record is refused when approved", async () => {
    await allOff()
    const p = await newProject("Approved took")
    await turn(p, true)
    const task = await call<{ id: string }>("projects_createTask", { projectId: p, title: "T" })
    const fromSubRun = await heldApproval(false)
    const out = await approvedCall(fromSubRun, "projects_taskTimeSet", {
      taskId: task.id,
      time: "2 h",
      quote: "took 2 h",
    })
    expect(out.error?.code).toBe("needs_person_statement")
    expect(String(out.error?.message)).toContain("sub-run")
    const written = extractRows<{ n: number }>(
      await db.execute(drizzleSql`
        SELECT count(*)::int AS n FROM app_projects.task_time WHERE task_id = ${task.id}::uuid`),
    )[0]
    expect(written?.n).toBe(0)
    await allOff()
  })
})
