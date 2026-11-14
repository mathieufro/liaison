// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Deal follow-ups routine end to end, on a scripted turn: the kernel
// template enabled through its approval, real ticks through `runRoutineTick`
// whose turn reads `deals_followup_candidates` and stages real `mail:compose`
// drafts through the sandboxed mail app, and real decisions on a stubbed SMTP.
// What it proves: a draft stops on a reply from anyone at the company, a closed
// deal withdraws its draft at once and still stops it at send when that event
// is lost, a slow deal answer holds the send, the sender is the deal owner's
// own mailbox or nobody, switching projects off withdraws its drafts, and the
// routine exists only once a person approved it.
//
// No model runs: the turn is a script, so what is decided here is decided by
// the server.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { and, asc, eq } from "drizzle-orm"
import { createPipeline } from "~/apps/projects/service/create-project"
import { moveTask } from "~/apps/projects/service/move-task"
import { createTask } from "~/apps/projects/service/tasks"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { messages, routineRuns, routines as routinesTbl } from "~/db/schema/kernel"
import type { AppEvent } from "~/infra/events/event-bus"
import * as eventBusModule from "~/infra/events/event-bus"
import * as jobsModule from "~/infra/jobs/jobs"
import { getOrCreatePersonalAgentId } from "~/modules/agent/directory/personal-agent"
import { DEAL_FOLLOWUPS_TEMPLATE_KEY } from "~/modules/agent/routines/kernel-routine-templates"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import {
  currentRunContext,
  inheritedRunFields,
  type RunContext,
  runContextStore,
} from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { appSwitchedOffReason } from "~/modules/approvals/cancel"
import { decideApproval } from "~/modules/approvals/decide"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { closedRecordReason, handleWithdrawOnEvent } from "~/modules/approvals/withdraw-on-events"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { disableOrgApp, enableOrgApp } from "~/modules/apps/org-app-admin"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { seedContext } from "~/seed/context"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { setTestCommercialIdentity } from "~/tests/helpers/commercial-identity"
import { createTestCompany } from "~/tests/helpers/company"
import { recordProspect } from "~/tests/helpers/prospect"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"
import {
  appendMailMessages,
  ensureMailAccount,
  seedMailConversation,
} from "../../../../test-support/seed/mail"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})
const jobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(
  (async (
    _app: string,
    jobName: string,
    _payload: Record<string, unknown>,
    opts?: { jobId?: string },
  ) => opts?.jobId ?? `${jobName}:stub`) as typeof jobsModule.enqueueAppJob,
)

let orgId = ""
let userId = ""
let owner: UserContext
let ownerAgentId = ""
let ownMailbox = ""
let otherSeller = ""
let pipelineId = ""
let stages: Record<string, string> = {}
const sent: unknown[] = []
let counter = 0
const unique = (name: string) => `${name}-${++counter}@client.example`

const DEAL_SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "projects:deals:read",
  "projects:deals:write",
]

interface Deal {
  taskId: string
  companyId: string
  contactId: string
  email: string
  title: string
}

/** An open deal 30 days old in the Proposal stage, its company and its contact (a prospect). */
async function makeDeal(title: string, dealOwner: string = userId): Promise<Deal> {
  const taskId = await withRlsContext(owner, async (tx) => {
    const t = await createTask({
      tx,
      orgId,
      actor: owner,
      input: { projectId: pipelineId, title, statusId: stages.Proposal },
    })
    return t.id
  })
  const companyId = await createTestCompany(orgId, `${title} Co`)
  const email = unique("buyer")
  const contactId = await recordProspect(orgId, email)
  await sql`UPDATE kernel.contacts SET company_id = ${companyId}::uuid WHERE id = ${contactId}::uuid`
  await sql`UPDATE app_projects.deals SET company_id = ${companyId}::uuid, contact_id = ${contactId}::uuid
             WHERE task_id = ${taskId}::uuid`
  await sql`UPDATE app_projects.tasks SET assignee_id = ${dealOwner}::uuid,
             created_at = now() - interval '30 days' WHERE id = ${taskId}::uuid`
  return { taskId, companyId, contactId, email, title }
}

async function makeRoutine(): Promise<{ id: string }> {
  const reportThreadId = await minimal.thread(orgId, userId)
  const [row] = await withPrivilegedDb(orgId, "deal-followups-seed-routine", (tx) =>
    tx
      .insert(routinesTbl)
      .values({
        orgId,
        ownerUserId: userId,
        ownerAgentId,
        name: `deal-followups-${crypto.randomUUID().slice(0, 8)}`,
        description: "Deal follow-ups",
        kind: "recurring",
        cron: "0 8 * * 1-5",
        timezone: "UTC",
        prompt: "Draft follow-ups for open deals that went quiet.",
        scopes: [],
        reportThreadId,
        followUp: true,
        templateKey: DEAL_FOLLOWUPS_TEMPLATE_KEY,
        sourceKind: "kernel",
        createdByUserId: userId,
        createdByActorType: "user",
      })
      .returning({ id: routinesTbl.id }),
  )
  return { id: row!.id }
}

/** A call from one turn of the run, in the frame agent-service.ts builds for it. */
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

interface Candidate {
  taskId: string
  title: string
  address: string | null
  accountId: string | null
  skip: string | null
}

/**
 * One scheduled tick whose turn does what the template's prompt says: read the
 * candidates, draft each row with no skip from its accountId with the deal as
 * its ref (and a `sendGuard` of its own, which must be dropped), set the next
 * step, and post the summary.
 */
async function tick(routineId: string) {
  const drafts = new Map<string, string>()
  let candidates: { items: Candidate[]; message: string } = { items: [], message: "" }
  let threadId = ""
  const result = await runRoutineTick({
    orgId,
    routineId,
    scheduledAt: new Date().toISOString(),
    loadOwnerScopes: async () => ["*"],
    checkCredits: async () => null,
    agentInvoker: async (input) => {
      threadId = input.threadId
      await inTurn(async () => {
        const read = await executeTool({
          toolName: "projects:deals_followup_candidates",
          orgId,
          actor: owner,
          params: { quietDays: 7, projectId: pipelineId },
          threadId: input.threadId,
          origin: "in-app-agent",
        })
        candidates = read.data as typeof candidates
        for (const row of candidates.items) {
          if (row.skip !== null) continue
          const res = await executeTool({
            toolName: "mail:compose",
            orgId,
            actor: owner,
            params: {
              accountId: row.accountId,
              to: [row.address],
              subject: `About ${row.title}`,
              textBody: "Did the proposal reach you? Tell me if the timing is off.",
              followUp: { refs: [{ kind: "projects:deal", id: row.taskId }] },
              sendGuard: { mode: "plain", refs: [], addresses: [] },
            },
            threadId: input.threadId,
            origin: "in-app-agent",
          })
          if (!res.blocked?.approvalRequestId) throw new Error(`not staged: ${JSON.stringify(res)}`)
          drafts.set(row.taskId, res.blocked.approvalRequestId)
          await executeTool({
            toolName: "projects:deals_update",
            orgId,
            actor: owner,
            params: { taskId: row.taskId, nextStep: "Wait for their answer to the follow-up" },
            threadId: input.threadId,
            origin: "in-app-agent",
          })
        }
      })
      const skipped = candidates.items.filter((r) => r.skip !== null)
      await withPrivilegedDb(orgId, "deal-followups-summary", (tx) =>
        tx.insert(messages).values({
          threadId: input.threadId,
          orgId,
          authorId: userId,
          authorType: "agent",
          authorAgentId: ownerAgentId,
          content: `${drafts.size} follow-ups drafted. Skipped: ${skipped
            .map((r) => `${r.title} (${r.skip})`)
            .join(", ")}`,
          requiredScopes: [],
        }),
      )
      return { turnsAdded: 1 }
    },
  })
  return { result, drafts, candidates, threadId }
}

async function request(id: string) {
  const [row] = await sql<
    Array<{
      status: string
      reason: string | null
      thread_id: string | null
      current_payload: Record<string, unknown>
      tool_name: string
    }>
  >`SELECT status, reason, thread_id::text AS thread_id, current_payload, tool_name
      FROM kernel.approval_requests WHERE id = ${id}`
  if (!row) throw new Error("no request")
  return row
}

async function execution(id: string) {
  const [row] = await sql<Array<{ status: string; error: Record<string, unknown> | null }>>`
    SELECT status, error FROM kernel.approved_handler_executions WHERE approval_request_id = ${id}`
  return row
}

/** Approve with the card's hash and let a stopped send settle (it answers with an error). */
async function approve(id: string): Promise<void> {
  const row = await request(id)
  try {
    await decideApproval({
      orgId,
      requestId: id,
      actor: owner,
      decision: "approve",
      payloadHash: approvalPayloadHash(row.tool_name, row.current_payload),
    } as never)
  } catch {
    // The stop is what the test reads.
  }
}

/** The deal events the outcome writer queued for `taskId`, as the bus would deliver them. */
async function queuedDealEvents(taskId: string, action: string): Promise<AppEvent[]> {
  const rows = await sql<Array<{ payload: AppEvent }>>`
    SELECT payload FROM kernel.pending_events
     WHERE org_id = ${orgId}::uuid AND payload->>'app' = 'projects'
       AND payload->>'entity' = 'deal' AND payload->>'action' = ${action}
       AND payload->>'entityId' = ${taskId}
     ORDER BY seq`
  return rows.map((r) => r.payload)
}

async function closeDeal(taskId: string) {
  await withRlsContext(owner, (tx) =>
    moveTask({ tx, orgId, actor: owner, taskId, statusId: stages.Won! }),
  )
}

/** One reply seeded into the deal owner's mailbox from `from`, received now. */
async function inboundFrom(from: string) {
  const ctx = seedContext({ orgId, now: new Date() })
  const { conversationId } = await seedMailConversation(ctx, {
    accountId: ownMailbox,
    subject: "Re: the proposal",
    status: "open",
    labels: [],
    isRead: false,
    isStarred: false,
    messageCount: 1,
    messages: [],
  })
  await appendMailMessages(ctx, {
    conversationId,
    messages: [
      {
        direction: "inbound",
        from: { email: from },
        to: [{ email: "seller@org.example" }],
        textBody: "We are still deciding, I will come back to you.",
        sentAt: new Date().toISOString(),
      },
    ],
    updateConversation: false,
    announce: false,
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
    scopes: [
      ...a.actor.scopes,
      ...DEAL_SCOPES,
      "mail:conversations:write",
      "mail:conversations:read",
      "mail:approve",
    ],
  }
  ownerAgentId = await withPrivilegedDb(orgId, "deal-followups-agent", (tx) =>
    getOrCreatePersonalAgentId(tx, { orgId, userId }),
  )
  await ensureAppsForOrg(orgId)
  await setTestCommercialIdentity(orgId)
  SandboxBridgeTestAccess.setSmtpSend(async (_connection, _identifier, message) => {
    sent.push(message)
    return { messageId: `<sent-${sent.length}@org.example>`, deliveryState: "delivered" }
  })
  const ctx = seedContext({ orgId, now: new Date() })
  // The routine's owner sells too: their own mailbox. Another seller's personal
  // mailbox is theirs alone.
  ownMailbox = (
    await ensureMailAccount(ctx, {
      ownerType: "user",
      userId,
      email: "seller@org.example",
      provider: "imap",
    })
  ).accountId
  otherSeller = (await minimal.person(orgId, { name: "Other Seller" })).id
  await ensureMailAccount(ctx, {
    ownerType: "user",
    userId: otherSeller,
    email: "other-seller@org.example",
    provider: "imap",
  })
  const p = await withRlsContext(owner, (tx) =>
    createPipeline({ tx, orgId, actor: owner, input: { name: "Sales" } }),
  )
  pipelineId = p.id
  stages = Object.fromEntries(p.statuses.map((s) => [s.label, s.id]))
}, 120_000)

afterAll(async () => {
  SandboxBridgeTestAccess.setSmtpSend(null)
  broadcastSpy.mockRestore()
  jobSpy.mockRestore()
  await clearRedisPatterns(["routine-lock:*"])
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("a follow-up stops on a reply from the company", () => {
  it("a reply from a colleague at the company stops the approved follow-up with no provider call and tells the routine thread", async () => {
    const deal = await makeDeal("Harbor renewal")
    // The colleague was already a contact of the company when the draft was made.
    const colleague = unique("colleague")
    const colleagueId = await recordProspect(orgId, colleague)
    await sql`UPDATE kernel.contacts SET company_id = ${deal.companyId}::uuid WHERE id = ${colleagueId}::uuid`
    const routine = await makeRoutine()
    const { drafts, threadId } = await tick(routine.id)
    const id = drafts.get(deal.taskId)!
    expect(id).toBeString()

    await inboundFrom(colleague)
    const before = sent.length
    await approve(id)

    expect(sent.length).toBe(before)
    const ran = await execution(id)
    expect(ran?.status).toBe("failed_no_effect")
    expect(ran?.error?.code).toBe("send_guard_replied")
    const row = await request(id)
    // The card sits in the routine's run thread, and closes there with why.
    expect(row.thread_id).toBe(threadId)
    expect(row.status).toBe("cancelled")
    expect(String(ran?.error?.message)).toContain(`${colleague} replied on `)
  }, 120_000)

  it("the stored payload's guard was pinned by the preflight", async () => {
    const deal = await makeDeal("Pinned guard")
    const routine = await makeRoutine()
    const { drafts } = await tick(routine.id)
    const guard = (await request(drafts.get(deal.taskId)!)).current_payload.sendGuard as {
      mode: string
      classification: string
      refs: Array<{ kind: string; id: string }>
      addresses: string[]
    }
    // The turn passed `{mode: "plain", refs: [], addresses: []}`: none of it was kept.
    expect(guard.mode).toBe("followup")
    expect(guard.classification).toBe("marketing")
    expect(guard.refs).toEqual([{ kind: "projects:deal", id: deal.taskId }])
    expect(guard.addresses).toContain(deal.email)
  }, 120_000)
})

describe("a closed deal's follow-up does not go", () => {
  it("closing the deal cancels its pending follow-up at once", async () => {
    const deal = await makeDeal("Closed at once")
    const routine = await makeRoutine()
    const { drafts } = await tick(routine.id)
    const id = drafts.get(deal.taskId)!
    await closeDeal(deal.taskId)
    const events = await queuedDealEvents(deal.taskId, "closed")
    expect(events).toHaveLength(1)
    // The withdrawal subscriber, handed the event the move queued.
    await handleWithdrawOnEvent(events[0]!)
    const row = await request(id)
    expect(row.status).toBe("cancelled")
    expect(row.reason).toBe(
      "Cancelled: the deal it follows up on was closed, so this draft cannot be sent",
    )
    expect(row.reason).toBe(closedRecordReason("deal"))
  }, 120_000)

  it("with the subscriber off the send fails with no effect because the deal is closed", async () => {
    const deal = await makeDeal("Lost event")
    const routine = await makeRoutine()
    const { drafts } = await tick(routine.id)
    const id = drafts.get(deal.taskId)!
    await closeDeal(deal.taskId)
    // The event is never delivered: the draft still waits.
    expect((await request(id)).status).toBe("pending")
    const before = sent.length
    await approve(id)
    expect(sent.length).toBe(before)
    const ran = await execution(id)
    expect(ran?.status).toBe("failed_no_effect")
    expect(ran?.error?.code).toBe("deal_closed")
    expect(String(ran?.error?.message)).toContain("Lost event is closed")
  }, 120_000)

  it("a slow deal state gives a non-final unavailable and no send", async () => {
    const deal = await makeDeal("Slow answer")
    const routine = await makeRoutine()
    const { drafts } = await tick(routine.id)
    const id = drafts.get(deal.taskId)!
    const real = toolRegistry.get([orgId, "projects", "deal_send_state"])!
    toolRegistry.set([orgId, "projects", "deal_send_state"], {
      ...real,
      handler: async () => {
        await new Promise((r) => setTimeout(r, 2500))
        return { stop: false }
      },
    } as never)
    const before = sent.length
    try {
      await approve(id)
    } finally {
      toolRegistry.set([orgId, "projects", "deal_send_state"], real)
    }
    expect(sent.length).toBe(before)
    const ran = await execution(id)
    expect(ran?.error?.code).toBe("send_guard_unavailable")
    expect(ran?.error?.final).toBeUndefined()
    expect((await request(id)).status).toBe("pending")
  }, 120_000)
})

describe("the sender is the deal owner's own mailbox", () => {
  it("a routine speaking as a named agent drafts from the deal owner's mailbox its owner can send from, and skips a deal it cannot send for with no sender, named in the summary", async () => {
    const mine = await makeDeal("Own deal")
    const theirs = await makeDeal("Someone else's deal", otherSeller)
    // A third seller shares their mailbox with the team: their deals go from it.
    const sharer = (await minimal.person(orgId, { name: "Sharing Seller" })).id
    const shared = (
      await ensureMailAccount(seedContext({ orgId, now: new Date() }), {
        ownerType: "user",
        userId: sharer,
        email: "sharing-seller@org.example",
        provider: "imap",
      })
    ).accountId
    await sql`UPDATE app_mail.accounts SET visibility = 'shared' WHERE id = ${shared}::uuid`
    const sharedDeal = await makeDeal("Shared mailbox deal", sharer)
    const routine = await makeRoutine()
    const { drafts, candidates } = await tick(routine.id)

    const own = candidates.items.find((r) => r.taskId === mine.taskId)!
    expect(own).toMatchObject({ skip: null, accountId: ownMailbox, address: mine.email })
    const other = candidates.items.find((r) => r.taskId === theirs.taskId)!
    // The other seller's personal mailbox is not one the routine's owner can send from.
    expect(other).toMatchObject({ skip: "no_sender", accountId: null })
    expect(candidates.message).toContain("no_sender")
    expect(drafts.has(theirs.taskId)).toBe(false)
    expect(candidates.items.find((r) => r.taskId === sharedDeal.taskId)).toMatchObject({
      skip: null,
      accountId: shared,
    })

    const payload = (await request(drafts.get(mine.taskId)!)).current_payload
    expect(payload.accountId).toBe(ownMailbox)

    const [summary] = await withSystemDb("deal-followups-read-summary", (db) =>
      db
        .select({ content: messages.content })
        .from(messages)
        .where(and(eq(messages.orgId, orgId), eq(messages.authorAgentId, ownerAgentId)))
        .orderBy(asc(messages.createdAt)),
    ).then((rows) => rows.filter((r) => r.content.includes("Someone else's deal")).slice(-1))
    expect(summary?.content).toContain("Someone else's deal (no_sender)")
  }, 120_000)
})

describe("switching projects off", () => {
  it("switching projects off cancels its waiting deal follow-ups with a Home line", async () => {
    const deal = await makeDeal("Projects switched off")
    const routine = await makeRoutine()
    const { drafts } = await tick(routine.id)
    const id = drafts.get(deal.taskId)!
    const actor = { actorId: userId, actorType: "user" as const }
    await disableOrgApp(orgId, "projects", actor)
    try {
      const row = await request(id)
      expect(row.status).toBe("cancelled")
      expect(row.reason).toBe(appSwitchedOffReason("projects"))
    } finally {
      await enableOrgApp(orgId, "projects", actor)
    }
  }, 120_000)
})

describe("enabling and pausing the routine", () => {
  it("enabling the template parks first and the routine exists only after approval", async () => {
    const before = await withSystemDb("deal-followups-before", (db) =>
      db
        .select({ id: routinesTbl.id })
        .from(routinesTbl)
        .where(
          and(
            eq(routinesTbl.orgId, orgId),
            eq(routinesTbl.templateKey, DEAL_FOLLOWUPS_TEMPLATE_KEY),
            eq(routinesTbl.sourceKind, "kernel"),
            eq(routinesTbl.name, DEAL_FOLLOWUPS_TEMPLATE_KEY),
          ),
        ),
    )
    expect(before).toEqual([])
    // A deal whose person has no recorded basis, and one whose owner's mailbox is not ours.
    const unrecorded = await makeDeal("No basis yet")
    await sql`UPDATE kernel.contacts SET lawful_basis = NULL WHERE id = ${unrecorded.contactId}::uuid`
    await makeDeal("Not our mailbox", otherSeller)
    const threadId = await minimal.thread(orgId, userId)
    const staged = await executeTool({
      toolName: "kernel:enable_routine_template",
      orgId,
      actor: owner,
      params: {
        appName: "kernel",
        templateKey: DEAL_FOLLOWUPS_TEMPLATE_KEY,
        quietDays: 10,
        pipelineId,
      },
      threadId,
      origin: "in-app-agent",
    })
    const id = staged.blocked?.approvalRequestId
    expect(id).toBeString()
    // The card says what it looks for, what it skips today and why, who approves,
    // and what every mail gets at send.
    const [card] = await sql<Array<{ summary: { title: string; lines: string[] } }>>`
      SELECT summary FROM kernel.approval_requests WHERE id = ${id!}`
    expect(card!.summary.title).toBe("Create routine: Deal follow-ups")
    const lines = card!.summary.lines
    expect(lines).toContain(
      "Looks for: open deals in Sales with nothing from the client for 10 days",
    )
    expect(lines).toContain(
      "Stops when: anyone at the company replies, someone opts out, or the deal closes",
    )
    expect(lines).toContain(
      "Who approves: the deal's owner when it sends from their own mailbox, the mail approvers when it sends from a shared one; in Home and in this thread",
    )
    const skips = lines.find((l) => l.startsWith("Skips:"))!
    expect(skips).toMatch(/Of the deals quiet today: 1 deal's person has no recorded basis/)
    expect(skips).toMatch(/\d+ deals have no mailbox of their owner to send from/)
    expect(lines.some((l) => l.startsWith("Added at send, and nobody can remove it: "))).toBe(true)
    expect(lines).toHaveLength(8)

    const parked = await withSystemDb("deal-followups-parked", (db) =>
      db
        .select({ id: routinesTbl.id })
        .from(routinesTbl)
        .where(
          and(eq(routinesTbl.orgId, orgId), eq(routinesTbl.name, DEAL_FOLLOWUPS_TEMPLATE_KEY)),
        ),
    )
    expect(parked).toEqual([])

    await approve(id!)
    const [made] = await withSystemDb("deal-followups-made", (db) =>
      db
        .select()
        .from(routinesTbl)
        .where(
          and(eq(routinesTbl.orgId, orgId), eq(routinesTbl.name, DEAL_FOLLOWUPS_TEMPLATE_KEY)),
        ),
    )
    expect(made).toBeDefined()
    expect(made!.followUp).toBe(true)
    expect(made!.cron).toBe("0 8 * * 1-5")
    expect(made!.prompt).toContain(
      `projects__deals_followup_candidates with {"quietDays":10,"projectId":"${pipelineId}"}`,
    )
  }, 120_000)

  it("pausing stops ticks and keeps waiting drafts", async () => {
    const deal = await makeDeal("Paused with a draft")
    const routine = await makeRoutine()
    const { drafts } = await tick(routine.id)
    const id = drafts.get(deal.taskId)!
    await withPrivilegedDb(orgId, "deal-followups-pause", (tx) =>
      tx.update(routinesTbl).set({ enabled: false }).where(eq(routinesTbl.id, routine.id)),
    )
    let turned = false
    const paused = await runRoutineTick({
      orgId,
      routineId: routine.id,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => ["*"],
      checkCredits: async () => null,
      agentInvoker: async () => {
        turned = true
        return { turnsAdded: 0 }
      },
    })
    expect(turned).toBe(false)
    expect(paused.status).not.toBe("succeeded")
    const runs = await withSystemDb("deal-followups-runs", (db) =>
      db
        .select({ status: routineRuns.status })
        .from(routineRuns)
        .where(eq(routineRuns.routineId, routine.id))
        .orderBy(asc(routineRuns.ranAt)),
    )
    expect(runs[0]?.status).toBe("succeeded")
    // The draft it made before the pause still waits on Home, and can be decided.
    expect((await request(id)).status).toBe("pending")
  }, 120_000)
})
