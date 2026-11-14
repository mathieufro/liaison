// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A flow run that resumes (a wait came due, an approval was decided) makes the checks a fresh tick
// makes, and carries on the run's context (0303):
//   - a routine switched off meanwhile ends the run `skipped_condition`, nothing after the wait;
//   - an owner deactivated meanwhile ends it `skipped_scope_mismatch` and pauses the routine;
//   - a credit refusal ends it `skipped_no_credits` before an agent step, the agent never called;
//   - an agent step after the wait gets the trigger event, its chain hop included;
//   - a flow edited while the run waited ends it `skipped_condition`, "flow changed";
//   - a throw after the claim ends the run `failed`, never left `running`;
//   - an approval decided on a routine switched off meanwhile ends the run the same way;
//   - the resume job keeps the record's lock alive while a long step runs;
//   - the sweep ends a run left `running` or `waiting` on a lost job, and the reconciler then
//     fires the routine again for its event (a stuck run is not served).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import type { RoutineFlow } from "@liaison/shared"
import { createProject } from "~/apps/projects/service/create-project"
import { createTask } from "~/apps/projects/service/tasks"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { redis } from "~/lib/redis"
import {
  type FlowDeps,
  type FlowResumePayload,
  resumeFlowOnDecision,
  resumeFlowWait,
  runFlowResumeJob,
  sweepStuckFlowRuns,
} from "~/modules/agent/routines/flow-runner"
import {
  type ReconcileOptions,
  RoutineEventReconcilerTestAccess,
  reconcileEventRoutines,
} from "~/modules/agent/routines/routine-event-reconciler"
import {
  RoutineLockTestAccess,
  type RoutineTickOpts,
  type RoutineTriggerEvent,
  runRoutineTick,
} from "~/modules/agent/routines/routine-worker"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { seedContext } from "~/seed/context"
import { seedRoutine } from "~/seed/factories/agent/routines"
import { seedApprovalRequests } from "~/seed/factories/approvals/requests"
import { seedAuditEntry } from "~/seed/factories/org/rows"
import * as minimal from "~/seed/tiers/minimal"
import { clearRedisPatterns } from "~/tests/route-test-setup"

let ORG = ""
let OWNER = ""
const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:read",
  "kernel:threads:write",
]
const ctx = (): UserContext => ({
  actorType: "user",
  userId: OWNER,
  orgId: ORG,
  scopes: SCOPES,
  dimensionGrants: { "*": ["*"] },
  roles: [],
})
let projectId = ""
let openStatus = ""

// The trigger fires after the tasks are created: `status_unchanged_since_trigger` holds.
const T0 = new Date(Date.now() + 60_000)
// Past the one working day the wait counts from any start: from a Friday evening that day ends
// on Monday or Tuesday, so three calendar days were not always enough.
const LATER = new Date(T0.getTime() + 7 * 86400_000)

const WAIT_THEN = (then: RoutineFlow["steps"][number]): RoutineFlow => ({
  version: 1,
  steps: [
    {
      id: "wait",
      type: "wait",
      for: { amount: 1, unit: "working_days" },
      until: { op: "status_unchanged_since_trigger" },
    },
    then,
  ],
})
const COMMENT_FLOW = WAIT_THEN({
  id: "remind",
  type: "action",
  action: "comment",
  args: { text: "Resumed: {{task.title}}" },
})
const AGENT_FLOW = WAIT_THEN({ id: "chase", type: "agent", prompt: "Chase the assignee" })

const armed: Array<{ payload: FlowResumePayload; delayMs: number; jobId: string }> = []
const deps = (now: Date, extra: FlowDeps = {}): FlowDeps => ({
  now: () => now,
  enqueueResume: async (payload, opts) => {
    armed.push({ payload, ...opts })
  },
  loadOwnerScopes: async () => ["*"],
  checkCredits: async () => null,
  ...extra,
})

async function routine(name: string, flow: RoutineFlow): Promise<string> {
  return seedRoutine(seedContext({ orgId: ORG, now: new Date() }), {
    createdByUserId: OWNER,
    ownerScopes: ["*"],
    enabled: true,
    routine: {
      name,
      description: name,
      kind: "event",
      event: "projects:task:status_changed",
      ownerUserId: OWNER,
      scopes: SCOPES,
      prompt: name,
      flow,
    },
  })
}

async function task(title: string) {
  const t = await withRlsContext(ctx(), (tx) =>
    createTask({ tx, orgId: ORG, actor: ctx(), input: { projectId, statusId: openStatus, title } }),
  )
  return t.id
}

function event(taskId: string, hop?: number): RoutineTriggerEvent {
  return {
    app: "projects",
    entity: "task",
    action: "status_changed",
    entityId: taskId,
    data: { id: taskId, projectId, fromStatusId: null, toStatusId: openStatus },
    origin: "internal",
    eventId: randomUUID(),
    ...(hop ? { hop } : {}),
  }
}

function tick(routineId: string, taskId: string, extra: Partial<RoutineTickOpts> = {}) {
  return runRoutineTick({
    orgId: ORG,
    routineId,
    scheduledAt: T0.toISOString(),
    triggerEvent: event(taskId),
    loadOwnerScopes: async () => ["*"],
    checkCredits: async () => null,
    agentInvoker: async () => {
      throw new Error("no agent before the wait")
    },
    flowDeps: deps(T0),
    ...extra,
  })
}

async function run(runId: string) {
  const [row] = await sql<
    { status: string; error: string | null; steps: Array<{ id: string; state: string }> }[]
  >`SELECT status, error, steps FROM kernel.routine_runs WHERE id = ${runId}::uuid`
  return row!
}

async function comments(taskId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM kernel.messages m
      JOIN app_projects.tasks t ON t.thread_id = m.thread_id
     WHERE t.id = ${taskId}::uuid AND m.content LIKE 'Resumed:%'`
  return row!.n
}

const payloadOf = (routineId: string, runId: string): FlowResumePayload => ({
  orgId: ORG,
  routineId,
  runId,
  stepId: "wait",
})

beforeAll(async () => {
  ORG = (await minimal.secondOrg({ name: "Flow Resume Org" })).orgId
  OWNER = (await minimal.person(ORG, { name: "Owner" })).id
  await minimal.grantScope(OWNER, "*")
  await ensureAppsForOrg(ORG, {})
  const p = await withRlsContext(ctx(), (tx) =>
    createProject({ tx, orgId: ORG, actor: ctx(), input: { name: "Resume room" } }),
  )
  projectId = p.id
  openStatus = p.statuses.filter((s) => !s.terminal)[0]!.id
}, 120_000)

beforeEach(async () => {
  armed.length = 0
  await clearRedisPatterns(["routine-lock:*"])
  await sql`UPDATE kernel.users SET status = 'active' WHERE id = ${OWNER}::uuid`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.routine_runs WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG}`
})

describe("a resumed flow run makes a tick's checks", () => {
  it("a routine switched off while the run waited ends it skipped_condition", async () => {
    const routineId = await routine("off-meanwhile", COMMENT_FLOW)
    const taskId = await task("Off meanwhile")
    const res = await tick(routineId, taskId)
    expect(res.status).toBe("waiting")
    await sql`UPDATE kernel.routines SET enabled = false WHERE id = ${routineId}::uuid`
    const out = await resumeFlowWait(payloadOf(routineId, res.runId!), deps(LATER))
    expect(out.status).toBe("skipped_condition")
    const row = await run(res.runId!)
    expect(row.status).toBe("skipped_condition")
    expect(row.error).toContain("switched off")
    expect(row.steps.map((s) => s.state)).toEqual(["skipped", "skipped"])
    expect(await comments(taskId)).toBe(0)
  }, 60_000)

  it("an owner deactivated while the run waited ends it skipped_scope_mismatch", async () => {
    const routineId = await routine("owner-left", COMMENT_FLOW)
    const taskId = await task("Owner left")
    const res = await tick(routineId, taskId)
    await sql`UPDATE kernel.users SET status = 'deactivated' WHERE id = ${OWNER}::uuid`
    const out = await resumeFlowWait(payloadOf(routineId, res.runId!), deps(LATER))
    expect(out.status).toBe("skipped_scope_mismatch")
    expect((await run(res.runId!)).status).toBe("skipped_scope_mismatch")
    const [r] = await sql<{ status: string }[]>`
      SELECT status FROM kernel.routines WHERE id = ${routineId}::uuid`
    expect(r!.status).toBe("paused_scope_mismatch")
    expect(await comments(taskId)).toBe(0)
  }, 60_000)

  it("a credit refusal ends the run before its agent step", async () => {
    const routineId = await routine("no-credits-later", AGENT_FLOW)
    const taskId = await task("No credits later")
    const res = await tick(routineId, taskId)
    let invoked = 0
    const out = await resumeFlowWait(
      payloadOf(routineId, res.runId!),
      deps(LATER, {
        checkCredits: async () => "Out of credits",
        agentInvoker: async () => {
          invoked++
          return { turnsAdded: 1 }
        },
      }),
    )
    expect(out.status).toBe("skipped_no_credits")
    expect(invoked).toBe(0)
    expect((await run(res.runId!)).status).toBe("skipped_no_credits")
  }, 60_000)

  it("an agent step after the wait gets the trigger event and its hop", async () => {
    const routineId = await routine("event-carried", AGENT_FLOW)
    const taskId = await task("Event carried")
    const ev = event(taskId, 2)
    const res = await tick(routineId, taskId, { triggerEvent: ev })
    const seen: Array<{ ev?: RoutineTriggerEvent; hop?: number }> = []
    const out = await resumeFlowWait(
      payloadOf(routineId, res.runId!),
      deps(LATER, {
        agentInvoker: async (input) => {
          seen.push({ ev: input.triggerEvent, hop: currentRunContext()?.eventHop })
          return { turnsAdded: 1 }
        },
      }),
    )
    expect(out.status).toBe("succeeded")
    expect(seen).toHaveLength(1)
    expect(seen[0]!.ev?.eventId).toBe(ev.eventId!)
    expect(seen[0]!.ev?.hop).toBe(2)
    expect(seen[0]!.hop).toBe(2)
  }, 60_000)

  it("a flow edited while the run waited ends it skipped_condition, flow changed", async () => {
    const routineId = await routine("edited-meanwhile", COMMENT_FLOW)
    const taskId = await task("Edited meanwhile")
    const res = await tick(routineId, taskId)
    const edited = WAIT_THEN({
      id: "remind",
      type: "action",
      action: "comment",
      args: { text: "Resumed, edited: {{task.title}}" },
    })
    await sql`UPDATE kernel.routines SET flow = ${JSON.stringify(edited)}::jsonb
               WHERE id = ${routineId}::uuid`
    const out = await resumeFlowWait(payloadOf(routineId, res.runId!), deps(LATER))
    expect(out.status).toBe("skipped_condition")
    const row = await run(res.runId!)
    expect(row.error).toContain("Flow changed")
    expect(await comments(taskId)).toBe(0)
  }, 60_000)

  it("a throw after the claim ends the run failed, never left running", async () => {
    const routineId = await routine("throws-after-claim", COMMENT_FLOW)
    const taskId = await task("Throws")
    const res = await tick(routineId, taskId)
    const out = await resumeFlowWait(
      payloadOf(routineId, res.runId!),
      deps(LATER, {
        loadOwnerScopes: async () => {
          throw new Error("permissions unreadable")
        },
      }),
    )
    expect(out.status).toBe("failed")
    const row = await run(res.runId!)
    expect(row.status).toBe("failed")
    expect(row.error).toContain("permissions unreadable")
  }, 60_000)

  it("an approval decided on a routine switched off meanwhile ends the run", async () => {
    const routineId = await routine("approval-off", {
      version: 1,
      steps: [
        { id: "assign", type: "action", action: "assign", args: { to: OWNER } },
        { id: "note", type: "action", action: "comment", args: { text: "Resumed: approved" } },
      ],
    })
    const taskId = await task("Approval off")
    const approvalId = randomUUID()
    const res = await tick(routineId, taskId, {
      flowDeps: deps(T0, {
        callTool: async (call) => {
          const frame = currentRunContext()
          await seedApprovalRequests(seedContext({ orgId: ORG, now: new Date() }), [
            {
              id: approvalId,
              handle: `request-${approvalId.slice(0, 6)}`,
              threadId: call.threadId,
              toolName: call.toolName,
              payload: call.params,
              requestedBy: OWNER,
              agentId: null,
              notifyUserIds: [OWNER],
              status: "approved",
              createdAt: new Date(),
              metadata: {
                originRoutineId: frame?.routineId,
                originRoutineRunId: frame?.routineRunId,
              },
            },
          ])
          return { blocked: { approvalRequestId: approvalId } }
        },
      }),
    })
    expect(res.status).toBe("waiting_approval")
    await sql`UPDATE kernel.routines SET enabled = false WHERE id = ${routineId}::uuid`
    let called = 0
    const out = await resumeFlowOnDecision(ORG, approvalId, {
      ...deps(LATER),
      callTool: async () => {
        called++
        return { ok: true, data: {} }
      },
    })
    expect(out?.status).toBe("skipped_condition")
    expect(called).toBe(0)
    expect(await comments(taskId)).toBe(0)
  }, 60_000)

  it("the resume job keeps the record's lock alive through a long step", async () => {
    const routineId = await routine("long-step", AGENT_FLOW)
    const taskId = await task("Long step")
    const res = await tick(routineId, taskId)
    const lockKey = `routine-lock:${routineId}:${taskId}`
    const was = RoutineLockTestAccess.heartbeatMs
    RoutineLockTestAccess.heartbeatMs = 50
    let ttlSeen = -1
    try {
      const out = await runFlowResumeJob(
        payloadOf(routineId, res.runId!),
        deps(LATER, {
          agentInvoker: async () => {
            // Shorten the lock as a long step would let it run down; the heartbeat lifts it back.
            await redis.expire(lockKey, 2)
            await new Promise((r) => setTimeout(r, 200))
            ttlSeen = await redis.ttl(lockKey)
            return { turnsAdded: 1 }
          },
        }),
      )
      expect(out.status).toBe("succeeded")
    } finally {
      RoutineLockTestAccess.heartbeatMs = was
    }
    expect(ttlSeen).toBeGreaterThan(60)
  }, 60_000)
})

describe("the stuck flow run sweep", () => {
  async function eventRun(name: string) {
    const routineId = await routine(name, COMMENT_FLOW)
    // The routine predates its event: the reconciler never replays an event older than the routine.
    await sql`UPDATE kernel.routines SET created_at = now() - interval '1 day' WHERE id = ${routineId}::uuid`
    const taskId = await task(name)
    const ev = event(taskId)
    await seedAuditEntry({
      orgId: ORG,
      actorType: "user",
      actorId: OWNER,
      app: "projects",
      entityType: "task",
      entityId: taskId,
      action: "task.status_changed",
      changes: ev.data as Record<string, unknown>,
      eventId: ev.eventId!,
      timestamp: new Date(Date.now() - 3600_000),
    })
    const res = await tick(routineId, taskId, { triggerEvent: ev })
    expect(res.status).toBe("waiting")
    return { routineId, runId: res.runId!, eventId: ev.eventId! }
  }
  async function retried(routineId: string, eventId: string) {
    type Enq = Parameters<NonNullable<ReconcileOptions["enqueue"]>>[0]
    const enqueued: Enq[] = []
    await RoutineEventReconcilerTestAccess.clearInFlight(routineId)
    await reconcileEventRoutines({ routineId, enqueue: async (p) => void enqueued.push(p) })
    return enqueued.some((e) => e.triggerEvent.eventId === eventId)
  }

  it("ends a run left running with no progress, and its event is fired again", async () => {
    const { routineId, runId, eventId } = await eventRun("left-running")
    await sql`UPDATE kernel.routine_runs SET status = 'running', ran_at = now() - interval '3 hours'
               WHERE id = ${runId}::uuid`
    expect(await retried(routineId, eventId)).toBe(false)
    expect(await sweepStuckFlowRuns(ORG)).toBeGreaterThanOrEqual(1)
    const row = await run(runId)
    expect(row.status).toBe("failed")
    expect(row.error).toContain("made no progress")
    expect(await retried(routineId, eventId)).toBe(true)
  }, 60_000)

  it("ends a run whose wait's resume never came, and leaves a live wait alone", async () => {
    const lost = await eventRun("lost-wait")
    const live = await eventRun("live-wait")
    await sql`UPDATE kernel.routine_runs
                 SET steps = jsonb_set(steps, '{0,output,deadline}', to_jsonb((now() - interval '3 hours')::text))
               WHERE id = ${lost.runId}::uuid`
    await sweepStuckFlowRuns(ORG)
    const row = await run(lost.runId)
    expect(row.status).toBe("failed")
    expect(row.steps[0]!.state).toBe("failed")
    expect((await run(live.runId)).status).toBe("waiting")
    expect(await retried(lost.routineId, lost.eventId)).toBe(true)
  }, 60_000)
})
