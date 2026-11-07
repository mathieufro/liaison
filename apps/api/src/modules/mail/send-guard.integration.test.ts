// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A staged send cannot leave when the state says it must not. These run the real
// mail handlers in the sandbox, through the real gate and decision, on a stubbed
// SMTP: a recorded send is the one thing that must not happen after a reply.

import { afterAll, beforeAll, describe, expect, it, setSystemTime, spyOn } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { buildRefToken } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import * as privileged from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import * as eventBusModule from "~/infra/events/event-bus"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import * as jobsModule from "~/infra/jobs/jobs"
import { env } from "~/lib/env"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  computeApprovalAttentionItems,
  computeApprovalBadgeItems,
} from "~/modules/approvals/attention"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import { updatePayload } from "~/modules/approvals/edit"
import { getApproval } from "~/modules/approvals/list"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { appBridgeManifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  AttentionTranslatorTestAccess,
  registerTranslatorConsumer,
} from "~/modules/attention/translator"
import * as footerModule from "~/modules/mail/commercial-footer"
import { writeMailPage } from "~/modules/mail/page-write"
import {
  evaluateSendGuard,
  type PinnedSendGuard,
  plainGuardSince,
  stopCode,
} from "~/modules/mail/send-guard"
import * as suppressionsModule from "~/modules/mail/suppressions"
import { TestKeyring } from "~/modules/mailbox-keys/__fixtures__/keyring"
import { enrollKeyring } from "~/modules/mailbox-keys/service"
import { seedContext } from "~/seed/context"
import { seedApprovalRequests } from "~/seed/factories/approvals/requests"
import { insertSql } from "~/seed/factories/org/test-rows"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  appendMailMessages,
  ensureMailAccount,
  seedMailConversation,
} from "../../../test-support/seed/mail"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})
const jobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(
  (async (_appName: string, jobName: string) =>
    `${jobName}:stub`) as typeof jobsModule.enqueueAppJob,
)

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
const HOUR = 60 * 60 * 1000
const YEAR = 365 * 24 * HOUR

let orgId = ""
let userId = ""
let admin: UserContext
let threadId = ""
let oldAccount = ""
let newAccount = ""
let sealedAccount = ""
let inboxId = ""
let connectedInboxAccount = ""

let flaky: "ok" | "slow" | "stop" = "ok"

/** What the stubbed SMTP was handed. A row here is a mail that left. */
const sent: Array<Record<string, unknown>> = []
let counter = 0
const unique = (name: string) => `${name}-${++counter}@client.test`
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

type Envelope = Awaited<ReturnType<typeof executeToolCore>>
const blockedId = (envelope: Envelope): string => {
  if (!("blocked" in envelope)) throw new Error(`not staged: ${JSON.stringify(envelope)}`)
  return envelope.blocked.approvalRequestId as string
}

function agentCall(toolName: string, params: Record<string, unknown>): Promise<Envelope> {
  return executeToolCore({
    toolName,
    orgId,
    actor: admin,
    params,
    threadId,
    origin: "in-app-agent",
  })
}

const composeParams = (to: string, extra: Record<string, unknown> = {}) => ({
  accountId: oldAccount,
  to: [to],
  subject: "Checking in",
  textBody: "Any news on the order?",
  ...extra,
})

async function stageCompose(to: string, extra: Record<string, unknown> = {}): Promise<string> {
  return blockedId(await agentCall("mail:compose", composeParams(to, extra)))
}

const approve = (requestId: string) =>
  decideApproval({ orgId, requestId, actor: admin, decision: "approve" })

/** Approve and settle: a stopped send answers with an error, which is what these tests read. */
async function approveSettled(requestId: string): Promise<void> {
  try {
    await approve(requestId)
  } catch {
    // The outcome is read from the rows below.
  }
}

async function requestRow(requestId: string) {
  const [row] = await sql<
    Array<{ status: string; current_payload: Record<string, unknown>; summary: unknown }>
  >`SELECT status, current_payload, summary FROM kernel.approval_requests WHERE id = ${requestId}`
  if (!row) throw new Error("no request")
  return row
}

async function executionRow(requestId: string) {
  const [row] = await sql<
    Array<{
      status: string
      actor_id: string | null
      error: Record<string, unknown> | null
      external_ref: Record<string, unknown> | null
    }>
  >`SELECT status, actor_id, error, external_ref FROM kernel.approved_handler_executions
     WHERE approval_request_id = ${requestId}`
  return row
}

interface InboundOptions {
  account?: string
  sentAt?: string | null
  syncedAt?: string
  rawHeaders?: Record<string, string>
  subject?: string
  body?: string
  conversationId?: string
  contactId?: string
}

/** One inbound mail, stored as a sync stores it, with the dates the case needs. */
async function seedInbound(from: string, options: InboundOptions = {}) {
  const ctx = seedContext({ orgId, now: new Date() })
  const account = options.account ?? oldAccount
  const conversationId =
    options.conversationId ??
    (
      await seedMailConversation(ctx, {
        accountId: account,
        subject: options.subject ?? "About the order",
        status: "open",
        labels: [],
        isRead: false,
        isStarred: false,
        messageCount: 1,
        messages: [],
      })
    ).conversationId
  const { messageIds } = await appendMailMessages(ctx, {
    conversationId,
    messages: [
      {
        direction: "inbound",
        from: { email: from },
        to: [{ email: "us@org.test" }],
        textBody: options.body ?? "Thanks, that works for me.",
        sentAt: options.sentAt ?? new Date().toISOString(),
        ...(options.rawHeaders ? { rawHeaders: options.rawHeaders } : {}),
      },
    ],
    updateConversation: false,
    announce: false,
  })
  const id = messageIds[0] as string
  await privileged.withSystemDb("send-guard-test-dates", async (tx) => {
    if (options.sentAt === null) {
      await tx.execute(
        drizzleSql`UPDATE ${MAIL}.messages SET sent_at = NULL WHERE id = ${id}::uuid`,
      )
    }
    if (options.syncedAt) {
      await tx.execute(
        drizzleSql`UPDATE ${MAIL}.messages SET synced_at = ${options.syncedAt}::timestamptz WHERE id = ${id}::uuid`,
      )
    }
    if (options.contactId) {
      await tx.execute(
        drizzleSql`UPDATE ${MAIL}.conversations SET contact_id = ${options.contactId}::uuid WHERE id = ${conversationId}::uuid`,
      )
    }
  })
  return { id, conversationId }
}

async function seedTicketInbound(
  from: string,
  options: { contactId?: string; sentAt?: string; imported?: boolean; subject?: string } = {},
) {
  return privileged.withPrivilegedDb(orgId, "send-guard-test-ticket", async (tx) => {
    const slug = `t${++counter}`
    const ticketId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    await tx.execute(
      drizzleSql.raw(
        insertSql("app_tickets.tickets", {
          id: ticketId,
          org_id: orgId,
          handle: `ticket_${slug}`,
          subject: options.subject ?? "Order question",
          status: "open",
          priority: "normal",
          channel: "email",
          sensitivity: "internal",
          reply_token: slug,
          source_inbox_id: inboxId,
          source_account_id: connectedInboxAccount,
          sla_target_seconds: 3600,
          sla_elapsed_seconds: 0,
          message_count: 1,
          contact_id: options.contactId ?? null,
        }),
      ),
    )
    await tx.execute(
      drizzleSql.raw(
        insertSql("app_tickets.messages", {
          id: messageId,
          org_id: orgId,
          ticket_id: ticketId,
          kind: "inbound",
          from_email: from,
          subject: options.subject ?? "Order question",
          text_body: "I already answered this.",
          sent_at: options.sentAt ?? new Date().toISOString(),
        }),
      ),
    )
    if (options.imported) {
      const runId = crypto.randomUUID()
      await tx.execute(
        drizzleSql.raw(
          insertSql("kernel.import_runs", { id: runId, org_id: orgId, status: "done" }),
        ),
      )
      await tx.execute(
        drizzleSql.raw(
          insertSql("kernel.import_ledger", {
            org_id: orgId,
            run_id: runId,
            kind: "tickets",
            table_name: "app_tickets.messages",
            row_id: messageId,
          }),
        ),
      )
    }
    return { ticketId, messageId }
  })
}

/** A routine's tick that follows up. */
function followUpFrame(): RunContext {
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected([])
  return {
    runId: "00000000-0000-4000-8000-0000000000f1",
    parentRunId: null,
    rootRunId: "00000000-0000-4000-8000-0000000000f1",
    nestingDepth: 0,
    effectiveScope: ["mail:conversations:write"],
    turnScopeAccumulator,
    routineFollowUp: true,
  }
}

/** Our earlier mail to them: what a follow-up's `since` reads. */
async function seedOutbound(to: string, sentAt: string = ago(2 * HOUR)) {
  const ctx = seedContext({ orgId, now: new Date() })
  const { conversationId } = await seedMailConversation(ctx, {
    accountId: oldAccount,
    subject: "Our offer",
    status: "open",
    labels: [],
    isRead: true,
    isStarred: false,
    messageCount: 1,
    messages: [],
  })
  await appendMailMessages(ctx, {
    conversationId,
    messages: [
      {
        direction: "outbound",
        from: { email: "sales@org.test" },
        to: [{ email: to }],
        textBody: "Here is our offer.",
        sentAt,
      },
    ],
    updateConversation: false,
    announce: false,
  })
}

/** The check alone, on a value as a stage would pin it. */
function check(
  address: string,
  since: string,
  extra: Partial<PinnedSendGuard> = {},
  recipients: string[] = [address],
) {
  return evaluateSendGuard({
    orgId,
    guard: { ...plainGuardSince([address], [], new Date(since)), ...extra },
    recipients,
    at: "send",
  })
}

beforeAll(async () => {
  await acquireTestLock()
  await initSandboxPool()
  // The real audit consumer, for the logged record of a send; WS fan-out stubbed.
  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  registerEventSubscribers({
    bufferAndBroadcast: async () => {},
    broadcast: async () => {},
  } as never)
  // And the attention translator, for the Home line a stop leaves.
  AttentionTranslatorTestAccess.resetRegistration()
  registerTranslatorConsumer()
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  userId = a.userId
  admin = {
    ...a.actor,
    scopes: [
      ...a.actor.scopes,
      "mail:conversations:write",
      "mail:conversations:read",
      "mail:approve",
    ],
  }
  threadId = await minimal.thread(orgId, userId)
  await ensureAppsForOrg(orgId)
  SandboxBridgeTestAccess.setSmtpSend(async (_connection, _identifier, message) => {
    sent.push(message as Record<string, unknown>)
    return { messageId: `<sent-${sent.length}@org.test>`, deliveryState: "delivered" }
  })

  const ctx = seedContext({ orgId, now: new Date() })
  const mailbox = async (email: string) =>
    (await ensureMailAccount(ctx, { ownerType: "org", userId, email, provider: "imap" })).accountId
  oldAccount = await mailbox("sales@org.test")
  newAccount = await mailbox("new-box@org.test")
  await privileged.withSystemDb("send-guard-test-accounts", (tx) =>
    tx.execute(
      drizzleSql`UPDATE ${MAIL}.accounts SET created_at = now() - interval '5 years' WHERE id = ${oldAccount}::uuid`,
    ),
  )

  await privileged.withPrivilegedDb(orgId, "send-guard-test-inbox", async (tx) => {
    connectedInboxAccount = crypto.randomUUID()
    inboxId = crypto.randomUUID()
    await tx.execute(
      drizzleSql.raw(
        insertSql("kernel.connected_accounts", {
          id: connectedInboxAccount,
          org_id: orgId,
          app_name: "tickets",
          connection_name: "gmail",
          owner_type: "org",
          owner_id: null,
          provider_type: "oauth2",
          identifier: "support@org.test",
          status: "active",
          created_by: userId,
        }),
      ),
    )
    await tx.execute(
      drizzleSql.raw(
        insertSql("app_tickets.inboxes", {
          id: inboxId,
          org_id: orgId,
          kind: "mailbox",
          connected_account_id: connectedInboxAccount,
          name: "Support",
          email_address: "support@org.test",
          from_display_name: "Support",
          created_at: ago(5 * YEAR),
        }),
      ),
    )
  })

  // A personal mailbox, end-to-end encrypted to its owner's enrolled keyring.
  const personal = await ensureMailAccount(ctx, {
    ownerType: "user",
    userId,
    email: "owner@org.test",
    provider: "imap",
  })
  sealedAccount = personal.accountId
  const keyring = new TestKeyring(userId)
  const enrolled = await keyring.enrollPayload(1)
  await asUser(await actorFor(ctx, userId), (tx) =>
    enrollKeyring(tx as never, userId, orgId, {
      ...enrolled,
      wraps: [
        {
          wrapType: "passphrase",
          label: "Mailbox password",
          wrappedAccountKey: Buffer.from("wrapped-under-the-password").toString("base64"),
          kdfParams: { salt: "c2FsdA==" },
        },
      ],
    }),
  )
  await privileged.withSystemDb("send-guard-test-seal", (tx) =>
    tx.execute(
      drizzleSql`UPDATE ${MAIL}.accounts SET encryption_state = 'ready' WHERE id = ${sealedAccount}::uuid`,
    ),
  )

  // A fixture app with a say over mail about one of its records.
  appBridgeManifestRegistry.set([orgId, "fixture"], {
    name: "fixture",
    sendGuardProviders: {
      "fixture:deal": { tool: "deal_state" },
      "fixture:invoice": {
        tool: "invoice_state",
        serviceMessage: true,
        pill: { label: "Billing: payment reminder" },
      },
      "fixture:slow": { tool: "slow_state" },
      "fixture:broken": { tool: "broken_state" },
      "fixture:flaky": { tool: "flaky_state" },
    },
  })
  const provider = (name: string, handler: (p: unknown) => Promise<unknown>) =>
    toolRegistry.set([orgId, "fixture", name], {
      appName: "fixture",
      name,
      description: "Fixture provider.",
      requiredScopes: ["fixture:read"],
      readOnly: true,
      params: z.object({ ref: z.object({ kind: z.string(), id: z.string() }) }),
      handler,
    })
  provider("deal_state", async (p) => {
    const id = (p as { ref: { id: string } }).ref.id
    return id === "closed"
      ? { stop: true, code: "deal_closed", label: "The deal is closed." }
      : { stop: false }
  })
  provider("invoice_state", async () => ({ stop: false }))
  provider("slow_state", async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    return { stop: false }
  })
  provider("flaky_state", async () => {
    if (flaky === "slow") await new Promise((resolve) => setTimeout(resolve, 2500))
    return flaky === "stop"
      ? { stop: true, code: "invoice_paid", label: "The invoice is paid." }
      : { stop: false }
  })
  provider("broken_state", async () => {
    throw new Error("the provider blew up")
  })

  toolRegistry.set([orgId, "kernel", "guard_head"], {
    appName: "kernel",
    name: "guard_head",
    description: "A first step whose output the mail step refers to.",
    requiredScopes: ["kernel:threads:read"],
    gated: true,
    approvalImpact: "internal",
    referenceableOutputs: ["value"],
    params: z.object({ note: z.string() }),
    handler: async () => ({ value: "the invoice is attached" }),
  })
  registerApprovalSummarizer(orgId, "kernel", "guard_head", async () => ({
    kind: "probe",
    title: "Probe",
    lines: ["probe"],
  }))
}, 120_000)

afterAll(async () => {
  SandboxBridgeTestAccess.setSmtpSend(null)
  broadcastSpy.mockRestore()
  jobSpy.mockRestore()
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("a reply stops a staged send", () => {
  it("compose from a follow-up routine, inbound seeded, approve: no provider call, failed_no_effect, cancelled", async () => {
    const to = unique("stale")
    const staged = await runContextStore.run(followUpFrame(), () =>
      agentCall("mail:compose", composeParams(to)),
    )
    const id = blockedId(staged)
    const payload = (await requestRow(id)).current_payload
    expect((payload.sendGuard as PinnedSendGuard).mode).toBe("followup")
    const { conversationId } = await seedInbound(to)
    const before = sent.length

    await approveSettled(id)

    expect(sent.length).toBe(before)
    const execution = await executionRow(id)
    expect(execution?.status).toBe("failed_no_effect")
    expect(execution?.error?.code).toBe("send_guard_replied")
    expect(execution?.error?.final).toBe(true)
    expect((await requestRow(id)).status).toBe("cancelled")
    // The stop says what happened, what did not, which record and the next step.
    const message = String(execution?.error?.message)
    expect(message).toContain("The mail was not sent and this request is closed.")
    expect(message).toContain(`${to} replied on `)
    expect(message).toContain(`conversation ${conversationId}`)
    expect(message).toContain("Next:")
  }, 60_000)

  it("the stop carries who and when and never a word of the reply", async () => {
    const to = unique("no-quote")
    const id = await stageCompose(to)
    await seedInbound(to, { body: "SECRETWORDS please stop writing to me" })
    await approveSettled(id)
    const stored = JSON.stringify(await executionRow(id))
    expect(stored).toContain(to)
    expect(stored).not.toContain("SECRETWORDS")
    expect(JSON.stringify(await requestRow(id))).not.toContain("SECRETWORDS")
  }, 60_000)

  it("no send and a clear stop on mail:reply too, against newer replies only", async () => {
    const to = unique("reply")
    const { conversationId } = await seedInbound(to, { sentAt: ago(HOUR) })
    const staged = await agentCall("mail:reply", { conversationId, textBody: "Here you go." })
    const id = blockedId(staged)
    const guard = (await requestRow(id)).current_payload.sendGuard as PinnedSendGuard
    expect(guard.mode).toBe("plain")
    // The message being answered is not newer than itself, however late it synced.
    expect(new Date(guard.since).getTime()).toBeGreaterThan(Date.now() - HOUR / 2)
    await seedInbound(to, { conversationId })
    const before = sent.length
    await approveSettled(id)
    expect(sent.length).toBe(before)
    expect((await requestRow(id)).status).toBe("cancelled")
  }, 60_000)

  it("nothing newer than the draft: the reply sends", async () => {
    const to = unique("reply-clear")
    const { conversationId } = await seedInbound(to, { sentAt: ago(HOUR) })
    const id = blockedId(
      await agentCall("mail:reply", { conversationId, textBody: "Here you go." }),
    )
    const before = sent.length
    await approveSettled(id)
    expect((await executionRow(id))?.error ?? null).toBeNull()
    expect(sent.length).toBe(before + 1)
  }, 60_000)

  it("preflight SEND_GUARD_REPLIED stages nothing, the model sees why", async () => {
    const to = unique("preflight")
    await seedOutbound(to)
    const { conversationId } = await seedInbound(to)
    const staged = await agentCall("mail:compose", composeParams(to, { followUp: {} }))
    expect("error" in staged).toBe(true)
    if (!("error" in staged)) return
    expect(staged.error.code).toBe("SEND_GUARD_REPLIED")
    expect(staged.error.message).toContain("Nothing was sent and no draft was staged.")
    expect(staged.error.message).toContain(`${to} replied on `)
    expect(staged.error.message).toContain(`conversation ${conversationId}`)
    const [row] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.approval_requests
       WHERE org_id = ${orgId} AND tool_params->>'to' LIKE ${`%${to}%`}`
    expect(row?.n).toBe(0)
  }, 60_000)

  it("a stop in a mailbox the caller cannot read names no conversation", async () => {
    const to = unique("private")
    const ctx = seedContext({ orgId, now: new Date() })
    const colleague = await minimal.person(orgId, { name: "Colleague" })
    const privateBox = await ensureMailAccount(ctx, {
      ownerType: "user",
      userId: colleague.id,
      email: "colleague@org.test",
      provider: "imap",
    })
    await seedOutbound(to)
    const { conversationId } = await seedInbound(to, { account: privateBox.accountId })
    const staged = await agentCall("mail:compose", composeParams(to, { followUp: {} }))
    if (!("error" in staged)) throw new Error(`not refused: ${JSON.stringify(staged)}`)
    expect(staged.error.code).toBe("SEND_GUARD_REPLIED")
    expect(staged.error.message).toContain("a mailbox you cannot read")
    expect(staged.error.message).not.toContain(conversationId)
  }, 60_000)
})

describe("a send that goes", () => {
  it("the check's value is part of what the card binds: approving with the card's hash sends once", async () => {
    const to = unique("hash")
    const id = await stageCompose(to, { followUp: {} })
    const { current_payload: payload } = await requestRow(id)
    const before = sent.length
    await decideApproval({
      orgId,
      requestId: id,
      actor: admin,
      decision: "approve",
      payloadHash: approvalPayloadHash("mail:compose", payload),
    })
    expect(sent.length).toBe(before + 1)
    expect((await requestRow(id)).current_payload).toEqual(payload)
  }, 60_000)

  it("the result names who it went to and from where", async () => {
    const to = unique("result")
    const id = await stageCompose(to)
    const decided = await approve(id)
    const stored = await sql<Array<{ result: { note?: string } | null }>>`
      SELECT result FROM kernel.approved_handler_executions WHERE approval_request_id = ${id}`
    expect(stored[0]?.result?.note).toBe(`Sent to ${to} from sales@org.test.`)
    expect(decided.status).toBe("approved")
  }, 60_000)
})

describe("what a caller can and cannot set", () => {
  it("a caller's sendGuard is dropped", async () => {
    const to = unique("dropped")
    const id = await stageCompose(to, { sendGuard: { v: 1, mode: "caller", since: "2999-01-01" } })
    const guard = (await requestRow(id)).current_payload.sendGuard as PinnedSendGuard
    expect(guard.mode).toBe("plain")
    expect(guard.since).not.toContain("2999")
  }, 60_000)

  it("followup cannot be downgraded", async () => {
    const to = unique("downgrade")
    const staged = await runContextStore.run(followUpFrame(), () =>
      agentCall(
        "mail:compose",
        composeParams(to, { sendGuard: { v: 1, applies: true, mode: "plain" } }),
      ),
    )
    const guard = (await requestRow(blockedId(staged))).current_payload.sendGuard as PinnedSendGuard
    expect(guard.mode).toBe("followup")
  }, 60_000)

  it("edit.ts refuses it", async () => {
    const id = await stageCompose(unique("edit"))
    await expect(
      updatePayload({
        orgId,
        requestId: id,
        actor: admin,
        fields: { "sendGuard.mode": "plain" },
      } as never),
    ).rejects.toThrow(/set by the server/)
    await expect(
      updatePayload({ orgId, requestId: id, actor: admin, fields: { guardKey: "x" } } as never),
    ).rejects.toThrow(/set by the server/)
  }, 60_000)
})

describe("providers", () => {
  it("provider stop:true stops with its label", async () => {
    const to = unique("provider")
    const staged = await agentCall(
      "mail:compose",
      composeParams(to, { followUp: { refs: [{ kind: "fixture:deal", id: "closed" }] } }),
    )
    if (!("error" in staged)) throw new Error("not refused")
    expect(staged.error.code).toBe("SEND_GUARD_REF_STOP")
    expect(staged.error.message).toContain("The deal is closed.")

    const verdict = await check(to, ago(HOUR), { refs: [{ kind: "fixture:deal", id: "closed" }] })
    expect(verdict).toMatchObject({
      state: "ref_stop",
      final: true,
      code: "deal_closed",
      label: "The deal is closed.",
    })
  }, 60_000)

  it("provider timeout at 2 s stops non-final send_guard_unavailable", async () => {
    const to = unique("slow")
    const started = Date.now()
    const verdict = await check(to, ago(HOUR), { refs: [{ kind: "fixture:slow", id: "1" }] })
    expect(verdict.state).toBe("unavailable")
    expect(verdict.final).toBe(false)
    expect(stopCode(verdict)).toBe("send_guard_unavailable")
    expect(Date.now() - started).toBeLessThan(2400)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1950)
  }, 60_000)

  it("a provider that turns slow while the draft waits stops at send, the request stays pending", async () => {
    flaky = "ok"
    const id = await stageCompose(unique("flaky-slow"), {
      followUp: { refs: [{ kind: "fixture:flaky", id: "1" }] },
    })
    flaky = "slow"
    const before = sent.length
    await approveSettled(id)
    flaky = "ok"
    expect(sent.length).toBe(before)
    expect((await requestRow(id)).status).toBe("pending")
    const error = (await executionRow(id))?.error
    expect(error?.code).toBe("send_guard_unavailable")
    expect(error?.final).toBeUndefined()
    expect(String(error?.message)).toContain("The request is back to pending.")
    expect(String(error?.message)).toContain("did not answer within 2 seconds")
  }, 60_000)

  it("a provider that says stop while the draft waits closes the request with its label", async () => {
    flaky = "ok"
    const id = await stageCompose(unique("flaky-stop"), {
      followUp: { refs: [{ kind: "fixture:flaky", id: "1" }] },
    })
    flaky = "stop"
    const before = sent.length
    await approveSettled(id)
    flaky = "ok"
    expect(sent.length).toBe(before)
    expect((await requestRow(id)).status).toBe("cancelled")
    const error = (await executionRow(id))?.error
    expect(error?.code).toBe("invoice_paid")
    expect(String(error?.message)).toContain("The invoice is paid.")
  }, 60_000)

  it("a provider that throws stops non-final, and approving again can retry", async () => {
    const verdict = await check(unique("broken"), ago(HOUR), {
      refs: [{ kind: "fixture:broken", id: "1" }],
    })
    expect(verdict).toMatchObject({ state: "unavailable", final: false })
  }, 60_000)

  it("a kind with no provider refuses at stage and passes at send with a log line", async () => {
    const to = unique("gone")
    const staged = await agentCall(
      "mail:compose",
      composeParams(to, { followUp: { refs: [{ kind: "gone:deal", id: "1" }] } }),
    )
    if (!("error" in staged)) throw new Error("not refused")
    expect(staged.error.code).toBe("SEND_GUARD_UNAVAILABLE")
    expect(staged.error.retryable).toBe(true)
    const verdict = await check(to, ago(HOUR), { refs: [{ kind: "gone:deal", id: "1" }] })
    expect(verdict.state).toBe("clear")
  }, 60_000)
})

describe("the auto-approve path", () => {
  async function allowCompose() {
    await privileged.withSystemDb("send-guard-test-policy", (tx) =>
      tx.execute(
        drizzleSql.raw(
          insertSql(
            "kernel.auto_approve_policies",
            {
              org_id: orgId,
              tool_name: "mail:compose",
              enabled: true,
              conditions: { raw: `'[{"path":"params.subject","op":"eq","value":"Auto"}]'::jsonb` },
              limits: { raw: `'{}'::jsonb` },
              requires_scope: "mail:approve",
              created_by: userId,
            },
            { onConflictDoNothing: true },
          ),
        ),
      ),
    )
  }

  it("auto-approved compose with an inbound does not send and the run gets the refusal", async () => {
    await allowCompose()
    const to = unique("auto")
    await seedOutbound(to)
    await seedInbound(to, {
      rawHeaders: { "auto-submitted": "auto-replied" },
      body: "I am out of the office until 16 November.",
    })
    const before = sent.length
    const result = await agentCall(
      "mail:compose",
      composeParams(to, { subject: "Auto", followUp: {} }),
    )
    expect(sent.length).toBe(before)
    if (!("error" in result)) throw new Error(`not refused: ${JSON.stringify(result)}`)
    expect(result.error.code).toBe("send_guard_held")
    expect(result.error.message).toContain("The mail was not sent.")
    expect(result.error.message).not.toContain("request")
    expect(result.error.message).toContain("automatic reply")
  }, 60_000)

  it("bulk approve same per item", async () => {
    const replied = unique("bulk-replied")
    const clear = unique("bulk-clear")
    const first = await stageCompose(replied)
    const second = await stageCompose(clear)
    await seedInbound(replied)
    const before = sent.length
    const results = await Promise.allSettled([approve(first), approve(second)])
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"])
    expect(sent.length).toBe(before + 1)
    expect(sent.at(-1)?.to).toEqual([clear])
    expect((await requestRow(first)).status).toBe("cancelled")
  }, 60_000)

  it("direct human compose sends with no guard", async () => {
    const to = unique("human")
    await seedInbound(to)
    const before = sent.length
    const result = await executeToolCore({
      toolName: "mail:compose",
      orgId,
      actor: admin,
      params: composeParams(to, { sendGuard: { v: 1, applies: true } }),
      threadId,
      origin: "human-ui",
    })
    expect("error" in result).toBe(false)
    expect(sent.length).toBe(before + 1)
  }, 60_000)
})

describe("classification and marketing", () => {
  it("service with no serviceMessage ref is stored marketing", async () => {
    const id = await stageCompose(unique("mkt"), {
      followUp: { classification: "service", refs: [{ kind: "fixture:deal", id: "open" }] },
    })
    const guard = (await requestRow(id)).current_payload.sendGuard as PinnedSendGuard
    expect(guard.classification).toBe("marketing")
    expect(guard.mode).toBe("followup")
  }, 60_000)

  it("marketing send calls the footer after the check, nothing added in current_payload", async () => {
    const to = unique("footer")
    const id = await stageCompose(to, { followUp: {} })
    const order: string[] = []
    const suppressed = spyOn(suppressionsModule, "suppressedAmong").mockImplementation(async () => {
      order.push("check")
      return []
    })
    const footer = spyOn(footerModule, "applyCommercialFooter").mockImplementation(
      async (_org, body) => {
        order.push("footer")
        return { body: `${body}\n\nUnsubscribe here`, headers: {} }
      },
    )
    try {
      const before = sent.length
      await approve(id)
      expect(sent.length).toBe(before + 1)
      expect(order[0]).toBe("check")
      expect(order).toContain("footer")
      // Deleting the footer's use in the handler turns this red.
      expect(String(sent.at(-1)?.textBody)).toEndWith("Unsubscribe here")
      expect(JSON.stringify((await requestRow(id)).current_payload)).not.toContain("Unsubscribe")
    } finally {
      suppressed.mockRestore()
      footer.mockRestore()
    }
  }, 60_000)

  it("no footer on a plain send", async () => {
    const id = await stageCompose(unique("plain-no-footer"))
    const footer = spyOn(footerModule, "applyCommercialFooter")
    try {
      await approve(id)
      expect(footer).not.toHaveBeenCalled()
    } finally {
      footer.mockRestore()
    }
  }, 60_000)

  it("service since is stagedAt: older inbound stages; inbound after staging stops", async () => {
    const to = unique("service")
    await seedInbound(to, { sentAt: ago(HOUR) })
    const followUp = { classification: "service", refs: [{ kind: "fixture:invoice", id: "1" }] }
    const staged = await agentCall("mail:compose", composeParams(to, { followUp }))
    const id = blockedId(staged)
    const guard = (await requestRow(id)).current_payload.sendGuard as PinnedSendGuard
    expect(guard.classification).toBe("service")
    expect(guard.since).toBe(guard.stagedAt)
    await seedInbound(to)
    const before = sent.length
    await approveSettled(id)
    expect(sent.length).toBe(before)
    expect((await executionRow(id))?.error?.code).toBe("send_guard_replied")
  }, 60_000)

  it("same message resolved marketing refused at stage", async () => {
    const to = unique("service-marketing")
    await seedOutbound(to)
    await seedInbound(to, { sentAt: ago(HOUR) })
    const staged = await agentCall("mail:compose", composeParams(to, { followUp: {} }))
    if (!("error" in staged)) throw new Error("not refused")
    expect(staged.error.code).toBe("SEND_GUARD_REPLIED")
  }, 60_000)

  it("with the stub true no send, final", async () => {
    const to = unique("optout")
    const id = await stageCompose(to, { followUp: {} })
    const spy = spyOn(suppressionsModule, "suppressedAmong").mockImplementation(async () => [to])
    try {
      const before = sent.length
      await approveSettled(id)
      expect(sent.length).toBe(before)
      expect((await requestRow(id)).status).toBe("cancelled")
      const error = (await executionRow(id))?.error
      expect(error?.code).toBe("send_guard_opted_out")
      expect(error?.final).toBe(true)
      expect(String(error?.message)).toContain(`${to} opted out`)
    } finally {
      spy.mockRestore()
    }
  }, 60_000)

  it("classification service sends", async () => {
    const to = unique("optout-service")
    const followUp = { classification: "service", refs: [{ kind: "fixture:invoice", id: "1" }] }
    const id = await stageCompose(to, { followUp })
    const spy = spyOn(suppressionsModule, "suppressedAmong").mockImplementation(async () => [to])
    try {
      const before = sent.length
      await approve(id)
      expect(sent.length).toBe(before + 1)
    } finally {
      spy.mockRestore()
    }
  }, 60_000)

  it("predicate asked for every To, Cc, Bcc after an edit, marketing only", async () => {
    const to = unique("edit-to")
    const added = unique("edit-cc")
    const bcc = unique("edit-bcc")
    const marketing = await stageCompose(to, { followUp: {} })
    const plain = await stageCompose(unique("edit-plain"))
    await updatePayload({
      orgId,
      requestId: marketing,
      actor: admin,
      fields: { cc: [added], bcc: [bcc] },
    } as never)
    const spy = spyOn(suppressionsModule, "suppressedAmong").mockImplementation(async () => [])
    try {
      await approve(plain)
      expect(spy).not.toHaveBeenCalled()
      await approve(marketing)
      const asked = spy.mock.calls.flatMap((call) => call[1])
      expect(asked).toEqual([to, added, bcc])
    } finally {
      spy.mockRestore()
    }
  }, 60_000)

  it("predicate throwing refuses non-final suppression_check_unavailable", async () => {
    const id = await stageCompose(unique("predicate-throws"), { followUp: {} })
    const spy = spyOn(suppressionsModule, "suppressedAmong").mockImplementation(async () => {
      throw new Error("list unreadable")
    })
    try {
      const before = sent.length
      await approveSettled(id)
      expect(sent.length).toBe(before)
      expect((await requestRow(id)).status).toBe("pending")
      const error = (await executionRow(id))?.error
      expect(error?.code).toBe("suppression_check_unavailable")
      expect(error?.final).toBeUndefined()
      expect(String(error?.message)).toContain("The request is back to pending.")
    } finally {
      spy.mockRestore()
    }
  }, 60_000)

  it("plain draft to a suppressed address stages with the line, not stopped", async () => {
    const to = unique("suppressed-plain")
    const spy = spyOn(suppressionsModule, "suppressedAmong").mockImplementation(async () => [to])
    try {
      const id = await stageCompose(to)
      const guard = (await requestRow(id)).current_payload.sendGuard as PinnedSendGuard
      expect(guard.line).toBe(`${to} opted out. Send only if this is not commercial.`)
      const before = sent.length
      await approve(id)
      expect(sent.length).toBe(before + 1)
    } finally {
      spy.mockRestore()
    }
  }, 60_000)

  it("executions plus audit hold approver, final text, mode, classification, result", async () => {
    const to = unique("record")
    const id = await stageCompose(to, { followUp: {} })
    await updatePayload({
      orgId,
      requestId: id,
      actor: admin,
      fields: { textBody: "The final text." },
    } as never)
    await approve(id)
    const execution = await executionRow(id)
    expect(execution?.status).toBe("succeeded")
    expect(execution?.actor_id).toBe(userId)
    expect(execution?.external_ref?.guard).toEqual({
      state: "clear",
      mode: "followup",
      classification: "marketing",
    })
    const request = await requestRow(id)
    expect(request.current_payload.textBody).toBe("The final text.")
    for (let i = 0; i < 5; i++) {
      await processOutboxBatch()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const audited = await sql<Array<{ actor_id: string | null }>>`
      SELECT actor_id FROM kernel.audit_log
       WHERE org_id = ${orgId} AND entity_id = ${id} AND action = 'approval_request.update'`
    expect(audited.map((row) => row.actor_id)).toContain(userId)
  }, 60_000)
})

describe("chained steps and drafts from before this check", () => {
  it("a two-step @ref sequence stages unpinned and is stopped by a reply seeded after staging", async () => {
    const to = unique("chain")
    const head = await agentCall("kernel:guard_head", { note: "first" })
    const headId = blockedId(head)
    const step = await agentCall(
      "mail:compose",
      composeParams(to, { textBody: buildRefToken(headId, "value") }),
    )
    const stepId = blockedId(step)
    expect((await requestRow(stepId)).current_payload.sendGuard).toBeUndefined()
    await seedInbound(to)
    const before = sent.length
    await approveSettled(headId)
    if ((await requestRow(stepId)).status === "pending") await approveSettled(stepId)
    expect(sent.length).toBe(before)
    expect((await executionRow(stepId))?.error?.code).toBe("send_guard_replied")
  }, 60_000)

  it("no sendGuard at execute is built plain, since created_at", async () => {
    const to = unique("legacy")
    const older = await stageCompose(to)
    const clearOne = await stageCompose(unique("legacy-clear"))
    await privileged.withSystemDb("send-guard-test-legacy", async (tx) => {
      for (const id of [older, clearOne]) {
        await tx.execute(drizzleSql`
          UPDATE kernel.approval_requests
             SET current_payload = current_payload - 'sendGuard',
                 tool_params = tool_params - 'sendGuard',
                 created_at = now() - interval '1 hour'
           WHERE id = ${id}::uuid`)
      }
    })
    await seedInbound(to, { sentAt: ago(HOUR / 2) })
    const before = sent.length
    await approveSettled(older)
    expect(sent.length).toBe(before)
    expect((await executionRow(older))?.error?.code).toBe("send_guard_replied")
    await approve(clearOne)
    expect(sent.length).toBe(before + 1)
  }, 60_000)

  it("the same address in another case stops the send", async () => {
    const to = unique("Case").replace("case", "CaSe")
    const id = await stageCompose(to)
    await seedInbound(to.toUpperCase())
    await approveSettled(id)
    expect((await executionRow(id))?.error?.code).toBe("send_guard_replied")
  }, 60_000)

  it("guard reads the set at each evaluation", async () => {
    const to = unique("set")
    const contactId = await minimal.contact(orgId, to)
    const id = await stageCompose(to)
    const guard = (await requestRow(id)).current_payload.sendGuard as PinnedSendGuard
    expect(guard.contactIds).toEqual([contactId])
    // Another address of the same contact, on a conversation linked to them.
    await seedInbound(unique("set-other"), { contactId })
    await approveSettled(id)
    expect((await executionRow(id))?.error?.code).toBe("send_guard_replied")
  }, 60_000)
})

describe("history is not a reply", () => {
  it("an inbound sent long before stagedAt, first synced after it on a newly connected account, does not stop the send", async () => {
    const to = unique("history")
    const id = await stageCompose(to)
    await seedInbound(to, { account: newAccount, sentAt: ago(2 * YEAR) })
    const before = sent.length
    await approve(id)
    expect(sent.length).toBe(before + 1)
  }, 60_000)

  it("an inbound sent minutes before stagedAt and synced after it still stops it", async () => {
    const to = unique("lag")
    const since = ago(0)
    await seedInbound(to, { account: newAccount, sentAt: ago(10 * 60 * 1000) })
    expect((await check(to, since)).state).toBe("replied")
  }, 60_000)

  it("sent 71 h 59 before since and synced after it stops on a new account", async () => {
    const to = unique("h7159")
    const since = new Date(Date.now() - 60_000).toISOString()
    const sentAt = new Date(new Date(since).getTime() - (71 * HOUR + 59 * 60_000)).toISOString()
    await seedInbound(to, { account: newAccount, sentAt })
    expect((await check(to, since)).state).toBe("replied")
  }, 60_000)

  it("72 h 01 does not", async () => {
    const to = unique("h7201")
    const since = new Date(Date.now() - 60_000).toISOString()
    const sentAt = new Date(new Date(since).getTime() - (72 * HOUR + 60_000)).toISOString()
    await seedInbound(to, { account: newAccount, sentAt })
    expect((await check(to, since)).state).toBe("clear")
  }, 60_000)

  it("72 h 01 on an account connected before it was sent still stops", async () => {
    const to = unique("h7201-old")
    const since = new Date(Date.now() - 60_000).toISOString()
    const sentAt = new Date(new Date(since).getTime() - (72 * HOUR + 60_000)).toISOString()
    await seedInbound(to, { account: oldAccount, sentAt })
    expect((await check(to, since)).state).toBe("replied")
  }, 60_000)

  it("an inbound with no sent date synced after since stops", async () => {
    const to = unique("no-date")
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedInbound(to, { sentAt: null })
    expect((await check(to, since)).state).toBe("replied")
  }, 60_000)

  it("an inbound synced before since does not stop", async () => {
    const to = unique("before")
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedInbound(to, { sentAt: ago(HOUR), syncedAt: ago(HOUR) })
    expect((await check(to, since)).state).toBe("clear")
  }, 60_000)
})

describe("a reply through a ticket inbox", () => {
  it("stage a follow-up, ingest an inbound on a ticket inbox from that address, approve: no provider call", async () => {
    const to = unique("ticket")
    const id = await stageCompose(to, { followUp: {} })
    const { ticketId } = await seedTicketInbound(to)
    const before = sent.length
    await approveSettled(id)
    expect(sent.length).toBe(before)
    const error = (await executionRow(id))?.error
    expect(error?.code).toBe("send_guard_replied")
    expect(String(error?.message)).toContain(`ticket ${ticketId}`)
  }, 60_000)

  it("the same when only the ticket's contact is in the set", async () => {
    const to = unique("ticket-contact")
    const contactId = await minimal.contact(orgId, to)
    const id = await stageCompose(to, { followUp: {} })
    await seedTicketInbound(unique("ticket-other"), { contactId })
    await approveSettled(id)
    expect((await executionRow(id))?.error?.code).toBe("send_guard_replied")
  }, 60_000)

  it("a ticket message imported from two years ago does not stop", async () => {
    const to = unique("ticket-import")
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedTicketInbound(to, { sentAt: ago(2 * YEAR), imported: true })
    expect((await check(to, since)).state).toBe("clear")
  }, 60_000)

  it("an out-of-office subject on a ticket message holds rather than stops", async () => {
    const to = unique("ticket-ooo")
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedTicketInbound(to, { subject: "Automatic reply: your order" })
    expect((await check(to, since)).state).toBe("held")
  }, 60_000)

  it("no tickets schema: the guard reads mail and answers", async () => {
    const to = unique("no-schema")
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedInbound(to)
    await db.execute(drizzleSql`ALTER TABLE app_tickets.messages RENAME TO messages_set_aside`)
    try {
      expect((await check(to, since)).state).toBe("replied")
      expect((await check(unique("no-schema-clear"), since)).state).toBe("clear")
    } finally {
      await db.execute(drizzleSql`ALTER TABLE app_tickets.messages_set_aside RENAME TO messages`)
    }
  }, 60_000)

  it("a ticket read that throws reads unavailable, no send", async () => {
    const to = unique("ticket-throws")
    const id = await stageCompose(to)
    const real = privileged.withPrivilegedDb
    const spy = spyOn(privileged, "withPrivilegedDb").mockImplementation(((
      org: string,
      label: string,
      fn: never,
    ) => {
      if (label === "send-guard-ticket-inbound") throw new Error("tickets unreadable")
      return real(org, label, fn)
    }) as typeof privileged.withPrivilegedDb)
    try {
      const before = sent.length
      await approveSettled(id)
      expect(sent.length).toBe(before)
      expect((await requestRow(id)).status).toBe("pending")
      expect((await executionRow(id))?.error?.code).toBe("send_guard_unavailable")
    } finally {
      spy.mockRestore()
    }
  }, 60_000)
})

describe("a colleague is not a client", () => {
  it("a reply from an org member's own address, mailbox not connected, does not stop", async () => {
    const colleague = await minimal.person(orgId, { name: "Teammate" })
    const [row] = await sql<Array<{ email: string }>>`
      SELECT email FROM kernel.users WHERE id = ${colleague.id}`
    const email = row?.email as string
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedInbound(email)
    expect((await check(email, since)).state).toBe("clear")
  }, 60_000)

  it("a reply from an external user's address stops", async () => {
    const email = unique("portal-client")
    const companyId = crypto.randomUUID()
    await privileged.withSystemDb("send-guard-test-external", (tx) =>
      tx.execute(
        drizzleSql.raw(
          insertSql("kernel.users", {
            org_id: orgId,
            email,
            name: "Portal Client",
            user_type: "external",
            company_id: companyId,
          }),
        ),
      ),
    )
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedInbound(email)
    expect((await check(email, since)).state).toBe("replied")
  }, 60_000)
})

/**
 * A sync page written as the mail app's bridge writes it: on a transaction of its own, never
 * inside a privileged slot, since the page's sender-contacts read takes one of its own.
 */
function onPageTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(drizzleSql`SET LOCAL ROLE liaison_admin`)
    await privileged.setPrivilegedContext(tx, orgId)
    return fn(tx)
  })
}

describe("what a mailbox's headers say", () => {
  const replyFrom = (to: string) => ({ from: { email: to }, to: [{ email: "owner@org.test" }] })

  async function ingestSealed(to: string, headers: Record<string, string>) {
    await onPageTx(async (tx) => {
      const id = `<${++counter}@client.test>`
      await writeMailPage(
        {
          tx: tx as never,
          schemaName: schemaRef("app_mail"),
          orgId,
          actorId: userId,
          queueEvents: async () => {},
        } as never,
        {
          accountId: sealedAccount,
          origin: "incremental",
          messages: [
            {
              ...replyFrom(to),
              externalMessageId: id,
              externalThreadId: id,
              externalProviderId: id,
              subject: "Sealed subject",
              textBody: "Sealed body",
              htmlBody: "",
              snippet: "Sealed",
              cc: [],
              bcc: [],
              isRead: false,
              isStarred: false,
              labels: [],
              references: [],
              inReplyTo: null,
              direction: "inbound",
              sentAt: new Date().toISOString(),
              headers,
            },
          ],
        },
      )
    })
  }

  it("a sealed inbound with auto-submitted reads held", async () => {
    const to = unique("sealed-auto")
    const since = new Date(Date.now() - 60_000).toISOString()
    await ingestSealed(to, { "auto-submitted": "auto-replied" })
    const verdict = await check(to, since)
    expect(verdict.state).toBe("held")
    expect(verdict.returnDate).toBeNull()
  }, 60_000)

  it("a sealed inbound with no such header reads replied", async () => {
    const to = unique("sealed-plain")
    const since = new Date(Date.now() - 60_000).toISOString()
    await ingestSealed(to, {})
    expect((await check(to, since)).state).toBe("replied")
  }, 60_000)

  it("a newsletter from the contact's address does not stop", async () => {
    const to = unique("newsletter")
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedInbound(to, { rawHeaders: { "list-id": "<news.client.test>" } })
    expect((await check(to, since)).state).toBe("clear")
  }, 60_000)

  it("a reply behind more than a page of newer newsletters still stops", async () => {
    const to = unique("buried-reply")
    const since = new Date(Date.now() - HOUR).toISOString()
    const { conversationId } = await seedInbound(to, { sentAt: ago(HOUR / 2) })
    for (let i = 0; i < 60; i++) {
      await seedInbound(to, {
        conversationId,
        sentAt: ago(60_000 + i * 1000),
        rawHeaders: { "list-id": "<news.client.test>" },
      })
    }
    expect((await check(to, since)).state).toBe("replied")
  }, 120_000)

  it("a stored From of mailer-daemon reads bounced through the sender column", async () => {
    const to = `mailer-daemon-${++counter}@client.test`
    const daemon = "mailer-daemon@client.test"
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedInbound(daemon, { body: "Your message could not be delivered." })
    const verdict = await evaluateSendGuard({
      orgId,
      guard: plainGuardSince([to, daemon], [], new Date(since)),
      recipients: [to],
      at: "send",
    })
    expect(verdict.state).toBe("bounced")
  }, 60_000)
})

describe("the operator's switch", () => {
  it("off, a reply no longer stops a send and an opt-out still does", async () => {
    const replied = unique("switch-replied")
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedInbound(replied)
    expect((await check(replied, since)).state).toBe("replied")
    const was = env.MAIL_SEND_GUARD_ENFORCE
    const spy = spyOn(suppressionsModule, "suppressedAmong").mockImplementation(async () => [
      replied,
    ])
    env.MAIL_SEND_GUARD_ENFORCE = false
    try {
      expect((await check(replied, since)).state).toBe("clear")
      const verdict = await check(replied, since, { classification: "marketing" })
      expect(verdict.state).toBe("opted_out")
    } finally {
      env.MAIL_SEND_GUARD_ENFORCE = was
      spy.mockRestore()
    }
  }, 60_000)
})

describe("what the source says", () => {
  const source = readFileSync(join(import.meta.dir, "send-guard.ts"), "utf8")
  const footer = readFileSync(join(import.meta.dir, "commercial-footer.ts"), "utf8")

  it("no insert in send-guard.ts; lastFailure holds code, time, who", async () => {
    expect(source).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE\s+\S+\s+SET|DELETE\s+FROM)\b/i)
    expect(source).not.toMatch(/\b(?:tx|db)\.(?:insert|update|delete)\(/)
    const to = unique("last-failure")
    const id = await stageCompose(to)
    await seedInbound(to, { body: "QUOTEDWORDS from the reply" })
    await approveSettled(id)
    const row = await requestRow(id)
    const summary = JSON.stringify(row.summary ?? {})
    expect(summary).not.toContain("QUOTEDWORDS")
    const error = (await executionRow(id))?.error
    expect(JSON.stringify(error)).not.toContain("QUOTEDWORDS")
    const guard = error?.guard as { who?: string; at?: string } | undefined
    expect(guard?.who).toBe(to)
    expect(guard?.at).toBeString()
    expect(error?.code).toBe("send_guard_replied")
  }, 60_000)

  it("no pixel in the footer builder", () => {
    expect(footer).not.toMatch(/<img|tracking|pixel|open-track/i)
  })
})

describe("the card says what the check says, and Send now", () => {
  const DAY = 24 * HOUR
  const MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ]
  const away = { "auto-submitted": "auto-replied" }

  /** The card as the viewer reads it, through their own access. */
  const card = (requestId: string, viewer: UserContext = admin) =>
    withRlsContext(viewer, (tx) =>
      getApproval(tx as never, { orgId, userId: viewer.userId, requestId, sendGuards: true }),
    )

  async function sendNow(requestId: string, payloadHash?: string) {
    const row = await requestRow(requestId)
    return decideApproval({
      orgId,
      requestId,
      actor: admin,
      decision: "approve",
      payloadHash: payloadHash ?? approvalPayloadHash("mail:compose", row.current_payload),
      sendGuardOverride: "auto_reply",
    })
  }

  async function refusal(run: () => Promise<unknown>): Promise<ApprovalDecisionError> {
    try {
      await run()
    } catch (err) {
      if (err instanceof ApprovalDecisionError) return err
      throw err
    }
    throw new Error("the decision went through")
  }

  async function heldDraft() {
    const to = unique("away")
    const id = await stageCompose(to)
    const back = new Date(Date.now() + 10 * DAY)
    await seedInbound(to, {
      rawHeaders: away,
      subject: "Automatic reply",
      body: `I am out of the office until ${back.getUTCDate()} ${MONTHS[back.getUTCMonth()]}.`,
    })
    return { to, id, back }
  }

  /** Home's feed and badge as the viewer reads them, through their own access. */
  const home = (viewer: UserContext = admin) =>
    withRlsContext(viewer, async (tx) => ({
      feed: await computeApprovalAttentionItems(tx as never, orgId, viewer.userId),
      badge: await computeApprovalBadgeItems(tx as never, orgId, viewer.userId, 500),
    }))

  it("held not on Home and not counted", async () => {
    const { id } = await heldDraft()
    const { feed, badge } = await home()
    expect(feed.some((i) => i.entityId === id)).toBe(false)
    expect(badge.some((i) => i.entityId === id)).toBe(false)
  }, 60_000)

  it("when its hold ends it is on Home and counted, with no write", async () => {
    const { id } = await heldDraft()
    expect((await home()).feed.some((i) => i.entityId === id)).toBe(false)
    const before = JSON.stringify(await requestRow(id))
    // Past the stated return date: the check is read fresh, so nothing has to change.
    setSystemTime(new Date(Date.now() + 15 * DAY))
    try {
      const { feed, badge } = await home()
      expect(feed.find((i) => i.entityId === id)?.metadata?.sendGuard).toMatchObject({
        state: "clear",
      })
      expect(badge.some((i) => i.entityId === id)).toBe(true)
    } finally {
      setSystemTime()
    }
    expect(JSON.stringify(await requestRow(id))).toBe(before)
  }, 60_000)

  it("stopped shows reason, uncounted", async () => {
    const to = unique("answered")
    const id = await stageCompose(to)
    await seedInbound(to, { body: "Thanks, we are comparing two options." })
    const { feed, badge } = await home()
    const row = feed.find((i) => i.entityId === id)
    expect(row?.metadata?.sendGuard).toMatchObject({ state: "replied" })
    expect(row?.metadata?.uncounted).toBe(true)
    expect(badge.some((i) => i.entityId === id)).toBe(false)
  }, 60_000)

  it("the badge over 200 waiting drafts reads in a bounded number of queries", async () => {
    const held = await heldDraft()
    const answeredTo = unique("answered-many")
    const answered = await stageCompose(answeredTo)
    await seedInbound(answeredTo, { body: "Thanks, we will decide next week." })
    const template = await stageCompose(unique("many-template"))
    const [row] = await sql<
      Array<{
        thread_id: string
        handle: string
        requested_by: string
        agent_id: string | null
        notify_user_ids: string[]
        current_payload: Record<string, unknown>
        metadata: Record<string, unknown> | null
      }>
    >`SELECT thread_id, handle, requested_by, agent_id, notify_user_ids, current_payload, metadata
        FROM kernel.approval_requests WHERE id = ${template}`
    if (!row) throw new Error("no template request")
    const guard = row.current_payload.sendGuard as PinnedSendGuard
    const waiting = Array.from({ length: 200 }, (_, i) => {
      const to = unique("many")
      return {
        id: crypto.randomUUID(),
        handle: `${row.handle}-${i}`,
        threadId: row.thread_id,
        toolName: "mail:compose",
        payload: { ...row.current_payload, to: [to], sendGuard: { ...guard, addresses: [to] } },
        requestedBy: row.requested_by,
        agentId: row.agent_id,
        notifyUserIds: row.notify_user_ids,
        status: "pending" as const,
        createdAt: new Date(),
        metadata: row.metadata ?? {},
      }
    })
    await seedApprovalRequests(seedContext({ orgId, now: new Date() }), waiting, { seeded: false })
    // The 200 rows are this test's alone: every later read of this org's Home would otherwise
    // serve them too, filling each one's summary on every attention pass.
    try {
      // Every statement the badge sends, through the viewer's own transaction or a privileged one.
      let statements = 0
      const counted = <T extends object>(tx: T): T =>
        new Proxy(tx, {
          get(target, prop) {
            const value = Reflect.get(target, prop, target)
            if (typeof value !== "function") return value
            if (prop === "execute") {
              return (...args: unknown[]) => {
                statements++
                return value.apply(target, args)
              }
            }
            if (prop === "transaction") {
              return (fn: (sp: object) => unknown, ...rest: unknown[]) =>
                value.call(target, (sp: object) => fn(counted(sp)), ...rest)
            }
            return value.bind(target)
          },
        })
      const real = privileged.withPrivilegedDb
      const spy = spyOn(privileged, "withPrivilegedDb").mockImplementation(((
        org: string,
        label: string,
        fn: (tx: object) => unknown,
      ) => {
        statements++
        return real(org, label, ((tx: object) => fn(counted(tx))) as never)
      }) as typeof privileged.withPrivilegedDb)
      let badge: Awaited<ReturnType<typeof computeApprovalBadgeItems>>
      try {
        badge = await withRlsContext(admin, (tx) =>
          computeApprovalBadgeItems(counted(tx) as never, orgId, admin.userId, 500),
        )
      } finally {
        spy.mockRestore()
      }
      expect(statements).toBeLessThanOrEqual(25)

      const ids = new Set(badge.map((i) => i.entityId))
      for (const w of waiting) expect(ids.has(w.id)).toBe(true)
      expect(ids.has(template)).toBe(true)
      expect(ids.has(held.id)).toBe(false)
      expect(ids.has(answered)).toBe(false)
      const { feed } = await home()
      expect(feed.some((i) => i.entityId === held.id)).toBe(false)
      const stopped = feed.find((i) => i.entityId === answered)
      expect(stopped?.metadata?.sendGuard).toMatchObject({ state: "replied" })
      expect(stopped?.metadata?.uncounted).toBe(true)
    } finally {
      await sql`DELETE FROM kernel.approval_requests WHERE id = ANY(${waiting.map((w) => w.id)}::uuid[])`
    }
  }, 120_000)

  it("fixture pill Billing: payment reminder names the row over the tool's", async () => {
    const id = await stageCompose(unique("pill"), {
      followUp: { refs: [{ kind: "fixture:invoice", id: "F-2026-0418" }] },
    })
    const plain = await stageCompose(unique("nopill"))
    const { feed } = await home()
    expect(feed.find((i) => i.entityId === id)?.metadata?.pill).toEqual({
      label: "Billing: payment reminder",
    })
    expect(feed.find((i) => i.entityId === plain)?.metadata?.pill).toBeUndefined()
  }, 60_000)

  it("auto-reply after since: Held with the parsed date", async () => {
    const { id, back } = await heldDraft()
    const guard = (await card(id))?.sendGuard
    expect(guard?.state).toBe("held")
    // The day after the stated date, at midnight in the requester's zone.
    const until = new Date(guard?.holdUntil ?? 0).getTime()
    const day = Date.UTC(back.getUTCFullYear(), back.getUTCMonth(), back.getUTCDate())
    expect(until).toBeGreaterThanOrEqual(day)
    expect(until).toBeLessThanOrEqual(day + 2 * DAY)
    expect(guard?.quote).toContain("out of the office")
  }, 60_000)

  it("Send now sends and audits the override", async () => {
    const { id } = await heldDraft()
    const before = sent.length
    await sendNow(id)
    expect(sent.length).toBe(before + 1)
    const request = await requestRow(id)
    expect(request.status).toBe("approved")
    expect((request.current_payload.sendGuard as PinnedSendGuard).ignoreAutoReply?.by).toBe(userId)
    const audited = await sql<
      Array<{ actor_id: string | null; metadata: Record<string, unknown> }>
    >`
      SELECT actor_id, metadata FROM kernel.audit_log
       WHERE org_id = ${orgId} AND entity_id = ${id} AND action = 'send_guard.override'`
    expect(audited).toHaveLength(1)
    expect(audited[0]?.actor_id).toBe(userId)
    expect(audited[0]?.metadata.override).toBe("auto_reply")
  }, 60_000)

  it("sealed: held 7 days, no quote", async () => {
    const to = unique("sealed-away")
    const id = await stageCompose(to)
    await onPageTx(async (tx) => {
      const ref = `<${++counter}@client.test>`
      await writeMailPage(
        {
          tx: tx as never,
          schemaName: schemaRef("app_mail"),
          orgId,
          actorId: userId,
          queueEvents: async () => {},
        } as never,
        {
          accountId: sealedAccount,
          origin: "incremental",
          messages: [
            {
              from: { email: to },
              to: [{ email: "owner@org.test" }],
              externalMessageId: ref,
              externalThreadId: ref,
              externalProviderId: ref,
              subject: "Sealed subject",
              textBody: "Back on the 2nd",
              htmlBody: "",
              snippet: "Back on the 2nd",
              cc: [],
              bcc: [],
              isRead: false,
              isStarred: false,
              labels: [],
              references: [],
              inReplyTo: null,
              direction: "inbound",
              sentAt: new Date().toISOString(),
              headers: away,
            },
          ],
        },
      )
    })
    const guard = (await card(id))?.sendGuard
    expect(guard?.state).toBe("held")
    const span = new Date(guard?.holdUntil ?? 0).getTime() - new Date(guard?.at ?? 0).getTime()
    expect(span).toBe(7 * DAY)
    expect(guard?.quote).toBeUndefined()
  }, 60_000)

  it("expired hold reads clear", async () => {
    const to = unique("was-away")
    const id = await stageCompose(to)
    // Sent eight days ago and first synced now: the default seven days are over.
    await seedInbound(to, { rawHeaders: away, sentAt: ago(8 * DAY), syncedAt: ago(1000) })
    expect((await card(id))?.sendGuard?.state).toBe("clear")
  }, 60_000)

  it("override on anything but held 422", async () => {
    const to = unique("not-away")
    const id = await stageCompose(to)
    const before = sent.length
    const err = await refusal(() => sendNow(id))
    expect(err.status).toBe(422)
    expect(err.code).toBe("send_guard_not_held")
    expect(sent.length).toBe(before)
    expect((await requestRow(id)).status).toBe("pending")
  }, 60_000)

  it("Send now with the card's own payloadHash sends once", async () => {
    const { id } = await heldDraft()
    const shown = await card(id)
    expect(shown?.payloadHash).toBeString()
    const before = sent.length
    await sendNow(id, shown?.payloadHash)
    expect(sent.length).toBe(before + 1)
    expect((await requestRow(id)).status).toBe("approved")
  }, 60_000)

  it("a stored Send now replayed after a real reply arrived does not send", async () => {
    const { to, id } = await heldDraft()
    const shown = await card(id)
    expect(shown?.sendGuard?.state).toBe("held")
    await seedInbound(to, { body: "Actually, I am back: no need." })
    const before = sent.length
    const err = await refusal(() => sendNow(id, shown?.payloadHash))
    expect(err.code).toBe("send_guard_not_held")
    expect(sent.length).toBe(before)
    expect((await requestRow(id)).status).toBe("pending")
  }, 60_000)

  it("a viewer who loses mailbox access sees no quote on reload", async () => {
    const to = unique("private")
    const id = await stageCompose(to)
    const { conversationId } = await seedInbound(to, { body: "Yes, please go ahead." })
    const first = (await card(id))?.sendGuard
    expect(first?.state).toBe("replied")
    expect(first?.quote).toContain("go ahead")
    expect(first?.record).toEqual({ kind: "conversation", id: conversationId })

    // The conversation moves to a colleague's own mailbox: the viewer can no longer read it.
    const colleague = await minimal.person(orgId)
    const ctx = seedContext({ orgId, now: new Date() })
    const theirs = (
      await ensureMailAccount(ctx, {
        ownerType: "user",
        userId: colleague.id,
        email: `colleague-${counter}@org.test`,
        provider: "imap",
      })
    ).accountId
    await privileged.withSystemDb("send-guard-test-move", async (tx) => {
      await tx.execute(
        drizzleSql`UPDATE ${MAIL}.conversations SET account_id = ${theirs}::uuid, owner_type = 'user', owner_id = ${colleague.id}::uuid WHERE id = ${conversationId}::uuid`,
      )
      await tx.execute(
        drizzleSql`UPDATE ${MAIL}.messages SET account_id = ${theirs}::uuid, owner_type = 'user', owner_id = ${colleague.id}::uuid WHERE conversation_id = ${conversationId}::uuid`,
      )
    })
    const reloaded = (await card(id))?.sendGuard
    // The reply still stops the send: the check reads every mailbox.
    expect(reloaded?.state).toBe("replied")
    expect(reloaded?.quote).toBeUndefined()
    expect(reloaded?.record).toBeUndefined()
    // And nothing of it was kept on the request.
    expect(JSON.stringify(await requestRow(id))).not.toContain("go ahead")
  }, 60_000)

  it("a stop after approval leaves one Home line for the person who decided", async () => {
    const to = unique("home-line")
    const id = await stageCompose(to)
    await seedInbound(to)
    await approveSettled(id)
    expect((await requestRow(id)).status).toBe("cancelled")
    for (let i = 0; i < 5; i++) {
      await processOutboxBatch()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const lines = await sql<Array<{ user_id: string; summary: string }>>`
      SELECT user_id, summary FROM kernel.attention_events
       WHERE org_id = ${orgId} AND entity_id = ${id} AND kind = 'mail:send_guard.stopped'`
    expect(lines).toHaveLength(1)
    expect(lines[0]?.user_id).toBe(userId)
    expect(lines[0]?.summary).toBe(`Not sent to ${to}: ${to} replied after it was drafted.`)
  }, 60_000)
})
