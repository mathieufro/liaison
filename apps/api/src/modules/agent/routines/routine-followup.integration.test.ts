// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A follow-up routine (`routines.follow_up`) stages its drafts and ends: it
// does not wait for each approval as a routine run otherwise does
// (routine-run-resume.ts). The run reads `succeeded`, its line says how many
// drafts wait for a person, and the next scheduled tick runs instead of being
// skipped behind a waiting run. Each draft is decided on its own.
//
// Real ticks through `runRoutineTick`; the agent is a stub that makes its
// gated calls through the real executeTool inside the tick's frame, as a turn
// does. The mail case stages a real `mail:compose` through the sandboxed mail
// app, so the second tick for the same record meets the first tick's request.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { messages, routineRuns, routines as routinesTbl, threads } from "~/db/schema/kernel"
import * as eventBusModule from "~/infra/events/event-bus"
import * as jobsModule from "~/infra/jobs/jobs"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import { resumeRoutineRunOnDecision } from "~/modules/agent/routines/routine-run-resume"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import {
  currentRunContext,
  inheritedRunFields,
  type RunContext,
  runContextStore,
} from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  APPROVAL_RESULT_TURN_JOB,
  type ApprovalResultTurnPayload,
} from "~/modules/approvals/approval-result-turn"
import { decideApproval } from "~/modules/approvals/decide"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { appBridgeManifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { seedContext } from "~/seed/context"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { setTestCommercialIdentity } from "~/tests/helpers/commercial-identity"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"
import { ensureMailAccount } from "../../../../test-support/seed/mail"

const enqueued: Array<{ jobName: string; payload: Record<string, unknown> }> = []
const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})
const jobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation((async (
  _app: string,
  jobName: string,
  payload: Record<string, unknown>,
  opts?: { jobId?: string },
) => {
  enqueued.push({ jobName, payload })
  return opts?.jobId ?? `${jobName}:stub`
}) as typeof jobsModule.enqueueAppJob)

const APP = "followup_test"
let orgId = ""
let userId = ""
let ownerAgentId = ""
let owner: UserContext
let accountId = ""
const sent: unknown[] = []

async function makeRoutine(opts: { followUp: boolean }) {
  const reportThreadId = await minimal.thread(orgId, userId)
  const [row] = await withPrivilegedDb(orgId, "followup-seed-routine", (tx) =>
    tx
      .insert(routinesTbl)
      .values({
        orgId,
        ownerUserId: userId,
        ownerAgentId,
        name: `followup-${crypto.randomUUID().slice(0, 8)}`,
        description: "Follow-up test routine",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "Draft a follow-up to each client who has not answered.",
        scopes: [],
        reportThreadId,
        followUp: opts.followUp,
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning({ id: routinesTbl.id }),
  )
  return { id: row!.id, reportThreadId }
}

/**
 * A call from one turn of the run, in the frame agent-service.ts builds for
 * it: the routine, its follow-up flag and what the tick's frame hands every
 * turn, and the turn's own scope record.
 */
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const tickFrame = currentRunContext()
  const frame: RunContext = {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: crypto.randomUUID(),
    nestingDepth: 0,
    background: true,
    humanTurn: false,
    turnScopeAccumulator: createTurnScopeAccumulator({ orgId }),
    routineId: tickFrame?.routineId,
    ...(tickFrame?.routineFollowUp ? { routineFollowUp: true } : {}),
    ...inheritedRunFields(tickFrame),
  }
  return runContextStore.run(frame, fn)
}

/** One gated draft, made from a turn of the run. */
async function draft(threadId: string, to: string): Promise<string> {
  const res = await inTurn(() =>
    executeTool({
      toolName: `${APP}:draft`,
      orgId,
      actor: owner,
      params: { to },
      threadId,
      origin: "in-app-agent",
    }),
  )
  expect(res.blocked?.approvalRequestId).toBeString()
  return res.blocked!.approvalRequestId!
}

async function agentReply(threadId: string, content: string) {
  await withPrivilegedDb(orgId, "followup-seed-reply", (tx) =>
    tx.insert(messages).values({
      threadId,
      orgId,
      authorId: userId,
      authorType: "agent",
      authorAgentId: ownerAgentId,
      content,
      requiredScopes: [],
    }),
  )
}

/** A scheduled tick whose turn stages one gated draft per address, step by step. */
async function tick(routineId: string, steps: string[][]) {
  const approvalIds: string[] = []
  const frames: Array<{ followUp: boolean | undefined }> = []
  const result = await runRoutineTick({
    orgId,
    routineId,
    scheduledAt: new Date().toISOString(),
    loadOwnerScopes: async () => ["*"],
    checkCredits: async () => null,
    agentInvoker: async (input) => {
      frames.push({ followUp: currentRunContext()?.routineFollowUp })
      for (const step of steps) {
        for (const to of step) approvalIds.push(await draft(input.threadId, to))
      }
      await agentReply(input.threadId, `${approvalIds.length} follow-ups drafted.`)
      return { turnsAdded: 1 }
    },
  })
  return { result, approvalIds, frames }
}

async function runRow(runId: string) {
  const [row] = await withSystemDb("followup-read-run", (db) =>
    db.select().from(routineRuns).where(eq(routineRuns.id, runId)),
  )
  return row!
}

async function runsOf(routineId: string) {
  return withSystemDb("followup-read-runs", (db) =>
    db
      .select({ status: routineRuns.status })
      .from(routineRuns)
      .where(eq(routineRuns.routineId, routineId))
      .orderBy(asc(routineRuns.ranAt)),
  )
}

async function runLines(threadId: string) {
  const rows = await withSystemDb("followup-read-lines", (db) =>
    db
      .select({ metadata: messages.metadata })
      .from(messages)
      .where(and(eq(messages.threadId, threadId), eq(messages.orgId, orgId)))
      .orderBy(asc(messages.createdAt)),
  )
  return rows.flatMap((m) => {
    const run = (m.metadata as { routineRun?: { status: string; draftsWaiting?: number } } | null)
      ?.routineRun
    return run ? [{ status: run.status, draftsWaiting: run.draftsWaiting ?? null }] : []
  })
}

async function statuses(ids: string[]) {
  const rows = await sql<Array<{ id: string; status: string }>>`
    SELECT id::text, status FROM kernel.approval_requests WHERE id = ANY(${ids}::uuid[])`
  return ids.map((id) => rows.find((r) => r.id === id)?.status)
}

async function decide(approvalId: string, decision: "approve" | "deny") {
  const [row] =
    await sql`SELECT tool_name, current_payload FROM kernel.approval_requests WHERE id = ${approvalId}`
  await decideApproval({
    orgId,
    requestId: approvalId,
    actor: owner,
    decision,
    ...(decision === "approve"
      ? { payloadHash: approvalPayloadHash(row!.tool_name as string, row!.current_payload) }
      : {}),
  } as never)
}

/** Run the decision job of `approvalId` (its last enqueued one), with a stub turn. */
async function resume(
  approvalId: string,
  turn: (input: { threadId: string }) => Promise<void> = async () => {},
) {
  const job = enqueued
    .filter((j) => j.jobName === APPROVAL_RESULT_TURN_JOB && j.payload.approvalId === approvalId)
    .at(-1)
  expect(job).toBeDefined()
  return resumeRoutineRunOnDecision(job!.payload as unknown as ApprovalResultTurnPayload, {
    loadOwnerScopes: async () => ["*"],
    checkCredits: async () => null,
    invoker: async (input) => {
      await turn({ threadId: input.threadId })
      return { turnsAdded: 1 }
    },
  })
}

beforeAll(async () => {
  await acquireTestLock()
  await initSandboxPool()
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  userId = a.userId
  owner = {
    ...a.actor,
    scopes: [...a.actor.scopes, "mail:conversations:write", "mail:conversations:read"],
  }
  ownerAgentId = await withPrivilegedDb(orgId, "followup-seed-agent", (tx) =>
    getOrCreatePersonalAgentId(tx, { orgId, userId }),
  )
  await ensureAppsForOrg(orgId)
  // The mail case stages commercial follow-ups, which state the org's identity.
  await setTestCommercialIdentity(orgId)
  toolRegistry.set([orgId, APP, "draft"], {
    appName: APP,
    name: "draft",
    description: "Draft a follow-up (gated)",
    requiredScopes: [`${APP}:drafts:write`],
    gated: true,
    params: z.object({ to: z.string() }),
    handler: async (params: { to: string }) => ({ drafted: params.to }),
  } as never)
  SandboxBridgeTestAccess.setSmtpSend(async (_connection, _identifier, message) => {
    sent.push(message)
    return { messageId: `<sent-${sent.length}@org.test>`, deliveryState: "delivered" }
  })
  const ctx = seedContext({ orgId, now: new Date() })
  accountId = (
    await ensureMailAccount(ctx, {
      ownerType: "org",
      userId,
      email: "sales@org.test",
      provider: "imap",
    })
  ).accountId
  // A record with a say over mail about it, as a deals app would declare.
  appBridgeManifestRegistry.set([orgId, "fixture"], {
    name: "fixture",
    sendGuardProviders: { "fixture:deal": { tool: "deal_state", serviceMessage: true } },
  })
  toolRegistry.set([orgId, "fixture", "deal_state"], {
    appName: "fixture",
    name: "deal_state",
    description: "Fixture provider.",
    requiredScopes: ["fixture:read"],
    readOnly: true,
    params: z.object({ ref: z.object({ kind: z.string(), id: z.string() }) }),
    handler: async () => ({ stop: false }),
  } as never)
}, 120_000)

afterAll(async () => {
  SandboxBridgeTestAccess.setSmtpSend(null)
  toolRegistry.deleteByPrefix([orgId])
  broadcastSpy.mockRestore()
  jobSpy.mockRestore()
  await clearRedisPatterns(["routine-lock:*"])
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("a follow-up routine stages its drafts and ends", () => {
  it("tick staging 3 gated calls in 2 steps: succeeded, 3 pending, no waiting_approval row, next tick runs", async () => {
    const routine = await makeRoutine({ followUp: true })
    const first = await tick(routine.id, [["a@client.test", "b@client.test"], ["c@client.test"]])
    expect(first.frames).toEqual([{ followUp: true }])
    expect(first.result.status).toBe("succeeded")
    expect(first.approvalIds).toHaveLength(3)
    expect(await statuses(first.approvalIds)).toEqual(["pending", "pending", "pending"])
    expect((await runRow(first.result.runId!)).status).toBe("succeeded")
    expect(await runLines(routine.reportThreadId)).toEqual([
      { status: "succeeded", draftsWaiting: 3 },
    ])

    const second = await tick(routine.id, [["d@client.test"]])
    expect(second.result.status).toBe("succeeded")
    expect((await runsOf(routine.id)).map((r) => r.status)).toEqual(["succeeded", "succeeded"])
    // The first run's drafts still wait, each on its own.
    expect(await statuses(first.approvalIds)).toEqual(["pending", "pending", "pending"])
  })

  it("a tick that first reads a client's tickets is marked as having read outside text, and still ends succeeded with its drafts waiting", async () => {
    const routine = await makeRoutine({ followUp: true })
    const approvalIds: string[] = []
    let runThreadId = ""
    const result = await runRoutineTick({
      orgId,
      routineId: routine.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        runThreadId = input.threadId
        const read = await inTurn(() =>
          executeTool({
            toolName: "tickets:listForContact",
            orgId,
            actor: owner,
            params: { contactId: crypto.randomUUID() },
            threadId: input.threadId,
            origin: "in-app-agent",
          }),
        )
        expect(read.blocked).toBeUndefined()
        expect(read.data).toEqual({ items: [] })
        for (const to of ["a@client.test", "b@client.test"]) {
          approvalIds.push(await draft(input.threadId, to))
        }
        await agentReply(input.threadId, `${approvalIds.length} follow-ups drafted.`)
        return { turnsAdded: 1 }
      },
    })
    const [thread] = await withSystemDb("followup-read-taint", (db) =>
      db.select({ tainted: threads.tainted }).from(threads).where(eq(threads.id, runThreadId)),
    )
    expect(thread?.tainted).toBe(true)
    expect(result.status).toBe("succeeded")
    expect(await statuses(approvalIds)).toEqual(["pending", "pending"])
    expect(await runLines(routine.reportThreadId)).toEqual([
      { status: "succeeded", draftsWaiting: 2 },
    ])
  })

  it("the same tick on a routine that is not a follow-up waits, and its next tick is skipped", async () => {
    const routine = await makeRoutine({ followUp: false })
    const first = await tick(routine.id, [["a@client.test", "b@client.test"], ["c@client.test"]])
    expect(first.frames).toEqual([{ followUp: undefined }])
    expect(first.result.status).toBe("waiting_approval")
    const second = await tick(routine.id, [["d@client.test"]])
    expect(second.result.status).toBe("skipped_overlap")
  })

  it("a run with nothing staged ends as any run does, with no count on its line", async () => {
    const routine = await makeRoutine({ followUp: true })
    const { result } = await tick(routine.id, [])
    expect(result.status).toBe("succeeded")
    expect(await runLines(routine.reportThreadId)).toEqual([
      { status: "succeeded", draftsWaiting: null },
    ])
  })

  it("approving one draft of a follow-up run runs it and resumes nothing", async () => {
    const routine = await makeRoutine({ followUp: true })
    const { result, approvalIds } = await tick(routine.id, [["a@client.test", "b@client.test"]])
    expect(result.status).toBe("succeeded")
    await decide(approvalIds[0]!, "approve")
    expect(await statuses(approvalIds)).toEqual(["approved", "pending"])
    let resumedTurn = false
    const resumed = await resume(approvalIds[0]!, async () => {
      resumedTurn = true
    })
    expect(resumed.status).toBe("no_run")
    expect(resumedTurn).toBe(false)
    expect((await runRow(result.runId!)).status).toBe("succeeded")
  })

  it("made a follow-up while a run waits: the next tick runs, and the waiting run finishes when decided", async () => {
    const routine = await makeRoutine({ followUp: false })
    const waiting = await tick(routine.id, [["a@client.test"]])
    expect(waiting.result.status).toBe("waiting_approval")
    await withPrivilegedDb(orgId, "followup-flag-on", (tx) =>
      tx.update(routinesTbl).set({ followUp: true }).where(eq(routinesTbl.id, routine.id)),
    )

    const next = await tick(routine.id, [["b@client.test"]])
    expect(next.result.status).toBe("succeeded")

    await decide(waiting.approvalIds[0]!, "approve")
    let staged = ""
    const resumed = await resume(waiting.approvalIds[0]!, async ({ threadId }) => {
      expect(currentRunContext()?.routineFollowUp).toBe(true)
      // A draft staged now does not make the old run wait again.
      staged = await draft(threadId, "c@client.test")
      await agentReply(threadId, "One more follow-up drafted.")
    })
    expect(resumed.status).toBe("succeeded")
    expect((await runRow(waiting.result.runId!)).status).toBe("succeeded")
    expect(await statuses([staged])).toEqual(["pending"])
    const lines = await runLines(routine.reportThreadId)
    expect(lines[0]).toEqual({ status: "succeeded", draftsWaiting: 1 })
  })
})

describe("a follow-up's mail for the same record is one request", () => {
  async function mailTick(routineId: string, dealIds: string[]) {
    const ids: string[] = []
    const result = await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async (input) => {
        for (const id of dealIds) {
          const res = await inTurn(() =>
            executeTool({
              toolName: "mail:compose",
              orgId,
              actor: owner,
              params: {
                accountId,
                to: [`buyer-${id}@client.test`],
                subject: "Checking in",
                textBody: "Any news on the quote?",
                followUp: { classification: "service", refs: [{ kind: "fixture:deal", id }] },
              },
              threadId: input.threadId,
              origin: "in-app-agent",
            }),
          )
          if (!res.blocked?.approvalRequestId) throw new Error(`not staged: ${JSON.stringify(res)}`)
          ids.push(res.blocked.approvalRequestId)
        }
        return { turnsAdded: 1 }
      },
    })
    return { result, ids }
  }

  it("second tick for the same ref returns the existing request; different refs different cards", async () => {
    const routine = await makeRoutine({ followUp: true })
    const deal = crypto.randomUUID()
    const other = crypto.randomUUID()
    const first = await mailTick(routine.id, [deal])
    expect(first.result.status).toBe("succeeded")
    const second = await mailTick(routine.id, [deal, other])
    expect(second.result.status).toBe("succeeded")
    expect(second.ids[0]).toBe(first.ids[0]!)
    expect(second.ids[1]).not.toBe(first.ids[0]!)
    const [{ n }] = (await sql`
      SELECT count(*)::int AS n FROM kernel.approval_requests
       WHERE org_id = ${orgId}::uuid AND tool_name = 'mail:compose' AND status = 'pending'
         AND metadata->>'originRoutineId' = ${routine.id}`) as unknown as [{ n: number }]
    expect(n).toBe(2)
    expect(sent).toHaveLength(0)
  })
})
