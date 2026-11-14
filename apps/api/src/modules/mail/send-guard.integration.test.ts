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
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
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
import {
  currentRunContext,
  type RunContext,
  runContextStore,
} from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import {
  computeApprovalAttentionItems,
  computeApprovalBadgeItems,
} from "~/modules/approvals/attention"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import { updatePayload } from "~/modules/approvals/edit"
import { runApprovalExpiry } from "~/modules/approvals/expiry"
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
import { readActivity } from "~/modules/contacts/activity"
import * as footerModule from "~/modules/mail/commercial-footer"
import { writeMailPage } from "~/modules/mail/page-write"
import { mailRoutes } from "~/modules/mail/routes"
import {
  checkPersonCompose,
  commercialRecipient,
  evaluateSendGuard,
  type PinnedSendGuard,
  plainGuardSince,
  stopCode,
} from "~/modules/mail/send-guard"
import * as mailService from "~/modules/mail/service"
import * as suppressionsModule from "~/modules/mail/suppressions"
import { TestKeyring } from "~/modules/mailbox-keys/__fixtures__/keyring"
import { enrollKeyring } from "~/modules/mailbox-keys/service"
import { seedContext } from "~/seed/context"
import { seedApprovalRequests } from "~/seed/factories/approvals/requests"
import { insertSql } from "~/seed/factories/org/test-rows"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { setTestCommercialIdentity } from "~/tests/helpers/commercial-identity"
import { createTestCompany } from "~/tests/helpers/company"
import { ensureRecordedBasis, recordProspect } from "~/tests/helpers/prospect"
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

async function agentCall(toolName: string, params: Record<string, unknown>): Promise<Envelope> {
  // Commercial mail needs a recorded basis; these tests are about the other checks.
  if (
    toolName === "mail:compose" &&
    (params.followUp !== undefined || currentRunContext()?.routineFollowUp)
  ) {
    await ensureRecordedBasis(orgId, [
      ...((params.to as unknown[]) ?? []),
      ...((params.cc as unknown[]) ?? []),
      ...((params.bcc as unknown[]) ?? []),
    ])
  }
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

/** What the send handler returned, as the execution stored it. */
async function executionResult(requestId: string): Promise<Record<string, unknown> | null> {
  const [row] = await sql<Array<{ result: Record<string, unknown> | null }>>`
    SELECT result FROM kernel.approved_handler_executions WHERE approval_request_id = ${requestId}`
  return row?.result ?? null
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
  options: {
    contactId?: string
    sentAt?: string | null
    imported?: boolean
    subject?: string
  } = {},
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
    if (options.sentAt === null) {
      // As a ticket inbox ingests it: times with microseconds, which a JS date cannot hold.
      await tx.execute(
        drizzleSql`UPDATE app_tickets.messages
                      SET sent_at = clock_timestamp(), received_at = clock_timestamp()
                    WHERE id = ${messageId}::uuid`,
      )
    }
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
async function seedOutbound(
  to: string | string[],
  sentAt: string = ago(2 * HOUR),
): Promise<string> {
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
  const { messageIds } = await appendMailMessages(ctx, {
    conversationId,
    messages: [
      {
        direction: "outbound",
        from: { email: "sales@org.test" },
        to: (Array.isArray(to) ? to : [to]).map((email) => ({ email })),
        textBody: "Here is our offer.",
        sentAt,
      },
    ],
    updateConversation: false,
    announce: false,
  })
  const [row] = await sql<Array<{ id: string }>>`SELECT external_message_id AS id
     FROM ${sql(schemaRef("app_mail"))}.messages WHERE id = ${messageIds[0] as string}`
  if (!row) throw new Error("seedOutbound: no row")
  return row.id
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
  // A commercial mail needs the identity it states.
  await setTestCommercialIdentity(orgId)
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

  it("a follow-up a routine staged with its refs gets the footer at send, and its record says so", async () => {
    const to = unique("routine-footer")
    const staged = await runContextStore.run(followUpFrame(), () =>
      agentCall(
        "mail:compose",
        composeParams(to, { followUp: { refs: [{ kind: "fixture:deal", id: "open" }] } }),
      ),
    )
    const id = blockedId(staged)
    expect(
      ((await requestRow(id)).current_payload.sendGuard as PinnedSendGuard).classification,
    ).toBe("marketing")
    const footer = spyOn(footerModule, "applyCommercialFooter").mockImplementation(
      async (_org, body) => ({ body: `${body}\n\nUnsubscribe here`, headers: {} }),
    )
    try {
      const before = sent.length
      await approve(id)
      expect(sent.length).toBe(before + 1)
      expect(footer).toHaveBeenCalled()
      expect(String(sent.at(-1)?.textBody)).toEndWith("Unsubscribe here")
      expect((await executionRow(id))?.external_ref?.guard).toMatchObject({
        classification: "marketing",
        footer: "commercial",
      })
      expect((await executionResult(id))?.guard).toMatchObject({ footer: "commercial" })
    } finally {
      footer.mockRestore()
    }
  }, 60_000)

  it("an MCP-staged marketing follow-up sent clear calls the footer, and its result and ref say so", async () => {
    const to = unique("mcp-footer")
    await ensureRecordedBasis(orgId, [to])
    const id = blockedId(
      await executeToolCore({
        toolName: "mail:compose",
        orgId,
        actor: admin,
        params: composeParams(to, { followUp: {} }),
        threadId,
        origin: "mcp",
      }),
    )
    expect(
      ((await requestRow(id)).current_payload.sendGuard as PinnedSendGuard).classification,
    ).toBe("marketing")
    const footer = spyOn(footerModule, "applyCommercialFooter")
    try {
      const before = sent.length
      await approve(id)
      expect(sent.length).toBe(before + 1)
      expect(footer).toHaveBeenCalledTimes(1)
      const record = { state: "clear", classification: "marketing", footer: "commercial" }
      expect((await executionRow(id))?.external_ref?.guard).toMatchObject(record)
      expect((await executionResult(id))?.guard).toMatchObject(record)
    } finally {
      footer.mockRestore()
    }
  }, 60_000)

  it("no footer on a plain send", async () => {
    const id = await stageCompose(unique("plain-no-footer"))
    const footer = spyOn(footerModule, "applyCommercialFooter")
    try {
      await approve(id)
      expect(footer).not.toHaveBeenCalled()
      expect((await executionRow(id))?.external_ref?.guard).not.toHaveProperty("footer")
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
    // Colleagues on copy (the admin's own domain): a commercial mail names one outside person.
    const added = `edit-cc-${++counter}@t.co`
    const bcc = `edit-bcc-${++counter}@t.co`
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

  it("an agent's new message to an opted-out address is refused; a reply in their thread is not", async () => {
    const to = unique("suppressed-plain")
    const { conversationId } = await seedInbound(to, { sentAt: ago(HOUR) })
    await suppressionsModule.addSuppression(null, {
      orgId,
      email: to,
      reason: "person",
      createdBy: userId,
    })
    const before = sent.length
    const staged = await agentCall("mail:compose", composeParams(to))
    if (!("error" in staged)) throw new Error(`not refused: ${JSON.stringify(staged)}`)
    expect(staged.error.code).toBe("suppressed_new_message")
    expect(String(staged.error.message)).toContain(`${to} opted out on `)
    expect(String(staged.error.message)).toContain("reply in their own thread")
    const reply = blockedId(
      await agentCall("mail:reply", { conversationId, textBody: "Here you go." }),
    )
    const guard = (await requestRow(reply)).current_payload.sendGuard as PinnedSendGuard
    expect(guard.line).toBe(`${to} opted out. Send only if this is not commercial.`)
    await approve(reply)
    expect(sent.length).toBe(before + 1)
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
      footer: "commercial",
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

/** A delivery failure as a mail server sends it: from its daemon, in a thread of its own. */
const REPORT_HEADERS = {
  "content-type": 'multipart/report; report-type=delivery-status; boundary="b1"',
  "auto-submitted": "auto-replied",
}
function deliveryReport(recipient: string): string {
  return [
    "This is the mail system at host mx.client.test.",
    "",
    "I'm sorry to have to inform you that your message could not be delivered.",
    "",
    `<${recipient}>: host mx.client.test said: 550 5.1.1 User unknown`,
    "",
    "Reporting-MTA: dns; mx.client.test",
    `Final-Recipient: rfc822; ${recipient}`,
    `Original-Recipient: rfc822;${recipient}`,
    "Action: failed",
    "Status: 5.1.1",
  ].join("\n")
}

describe("a delivery failure stops a staged send", () => {
  it("a mailer-daemon report naming the recipient, in a thread of its own: no provider call, bounced, closed", async () => {
    const to = unique("gone")
    const staged = await runContextStore.run(followUpFrame(), () =>
      agentCall("mail:compose", composeParams(to)),
    )
    const id = blockedId(staged)
    await seedInbound("mailer-daemon@mx.client.test", {
      subject: "Undelivered Mail Returned to Sender",
      body: deliveryReport(to),
      rawHeaders: REPORT_HEADERS,
    })
    const before = sent.length

    await approveSettled(id)

    expect(sent.length).toBe(before)
    const execution = await executionRow(id)
    expect(execution?.status).toBe("failed_no_effect")
    expect(execution?.error?.code).toBe("send_guard_bounced")
    expect(execution?.error?.final).toBe(true)
    expect((await requestRow(id)).status).toBe("cancelled")
  }, 60_000)

  it("the card reads bounced before anyone approves", async () => {
    const to = unique("gone-card")
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedInbound("postmaster@mx.client.test", {
      subject: "Delivery Status Notification (Failure)",
      body: deliveryReport(to.toUpperCase()),
      rawHeaders: REPORT_HEADERS,
    })
    expect((await check(to, since)).state).toBe("bounced")
  }, 60_000)

  it("a report naming another address does not stop this one", async () => {
    const to = unique("still-here")
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedInbound("mailer-daemon@mx.client.test", {
      subject: "Undelivered Mail Returned to Sender",
      body: deliveryReport(`x${to}`),
      rawHeaders: REPORT_HEADERS,
    })
    expect((await check(to, since)).state).toBe("clear")
  }, 60_000)

  it("a delay notice naming the recipient does not stop", async () => {
    const to = unique("delayed")
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedInbound("mailer-daemon@mx.client.test", {
      subject: "Delayed Mail (still being retried)",
      body: deliveryReport(to).replace("Action: failed", "Action: delayed"),
      rawHeaders: REPORT_HEADERS,
    })
    expect((await check(to, since)).state).toBe("clear")
  }, 60_000)

  it("a report with no readable text that answers our mail to the recipient stops", async () => {
    const to = unique("gone-threaded")
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedOutbound(to)
    const { id } = await seedInbound("mailer-daemon@mx.client.test", {
      subject: "Undelivered Mail Returned to Sender",
      body: "",
      rawHeaders: REPORT_HEADERS,
    })
    await privileged.withSystemDb("send-guard-test-report-thread", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE ${MAIL}.messages m
           SET text_body = NULL, html_body = NULL,
               in_reply_to = (SELECT o.external_message_id FROM ${MAIL}.messages o
                               WHERE o.direction = 'outbound' AND o.org_id = m.org_id
                                 AND o.to_addresses @> ${JSON.stringify([{ email: to }])}::jsonb
                               LIMIT 1)
         WHERE m.id = ${id}::uuid`)
    })
    expect((await check(to, since)).state).toBe("bounced")
  }, 60_000)
})

describe("a delivery failure for one recipient of a group mail", () => {
  /** A report as Gmail writes one: the failed address first, then the original's headers. */
  function groupReport(failed: string, all: string[], machine: boolean): string {
    return [
      `Your message wasn't delivered to ${failed} because the address couldn't be found.`,
      "",
      ...(machine
        ? [
            "Reporting-MTA: dns; mx.client.test",
            "",
            `Final-Recipient: rfc822; ${failed}`,
            "Action: failed",
            "",
          ]
        : []),
      "----- Original message -----",
      "",
      "From: sales@org.test",
      `To: ${all.join(", ")}`,
      "Subject: Our offer",
    ].join("\n")
  }

  async function answering(reportId: string, outboundId: string | null, sealed = false) {
    await privileged.withSystemDb("send-guard-test-report-answers", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE ${MAIL}.messages
           SET in_reply_to = ${outboundId},
               text_body = CASE WHEN ${sealed} THEN NULL ELSE text_body END,
               html_body = CASE WHEN ${sealed} THEN NULL ELSE html_body END
         WHERE id = ${reportId}::uuid`)
    })
  }

  it("alice bounces on a mail to alice and bob: a draft to bob goes, a draft to alice stops", async () => {
    const alice = unique("alice")
    const bob = unique("bob")
    const since = new Date(Date.now() - 60_000).toISOString()
    const outbound = await seedOutbound([alice, bob])
    for (const machine of [true, false]) {
      const { id } = await seedInbound("mailer-daemon@mx.client.test", {
        subject: "Delivery Status Notification (Failure)",
        body: groupReport(alice, [alice, bob], machine),
        rawHeaders: REPORT_HEADERS,
      })
      await answering(id, outbound)
    }
    expect((await check(bob, since)).state).toBe("clear")
    expect((await check(alice, since)).state).toBe("bounced")
  }, 60_000)

  it("a sealed report on a mail to two addresses stops neither; on a mail to one it stops", async () => {
    const alice = unique("sealed-alice")
    const bob = unique("sealed-bob")
    const solo = unique("sealed-solo")
    const since = new Date(Date.now() - 60_000).toISOString()
    for (const [to, outbound] of [
      [[alice, bob], await seedOutbound([alice, bob])],
      [[solo], await seedOutbound(solo)],
    ] as const) {
      const { id } = await seedInbound("mailer-daemon@mx.client.test", {
        subject: "Undelivered Mail Returned to Sender",
        body: groupReport(to[0] as string, [...to], true),
        rawHeaders: REPORT_HEADERS,
      })
      await answering(id, outbound, true)
    }
    expect((await check(alice, since)).state).toBe("clear")
    expect((await check(bob, since)).state).toBe("clear")
    expect((await check(solo, since)).state).toBe("bounced")
  }, 60_000)

  it("an address ending a sentence stops; a longer domain does not", async () => {
    const to = unique("full-stop")
    const other = unique("sub-domain")
    const since = new Date(Date.now() - 60_000).toISOString()
    await seedInbound("mailer-daemon@mx.client.test", {
      subject: "Undelivered Mail Returned to Sender",
      body: `Your message could not be delivered to ${to}.`,
      rawHeaders: REPORT_HEADERS,
    })
    await seedInbound("mailer-daemon@mx.client.test", {
      subject: "Undelivered Mail Returned to Sender",
      body: `Your message could not be delivered to ${other}.evil.example.`,
      rawHeaders: REPORT_HEADERS,
    })
    expect((await check(to, since)).state).toBe("bounced")
    expect((await check(other, since)).state).toBe("clear")
  }, 60_000)

  it("an HTML-only delay notice does not stop", async () => {
    const to = unique("html-delay")
    const since = new Date(Date.now() - 60_000).toISOString()
    const { id } = await seedInbound("mailer-daemon@mx.client.test", {
      subject: "Mail delivery notice",
      body: "",
      rawHeaders: REPORT_HEADERS,
    })
    await privileged.withSystemDb("send-guard-test-html-delay", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE ${MAIL}.messages
           SET text_body = NULL,
               html_body = ${`<p>This is a warning only.</p><p>Final-Recipient: rfc822; ${to}<br>Action: delayed</p>`}
         WHERE id = ${id}::uuid`)
    })
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

  it("a draft stopped by a ticket reply: the card names that ticket, so it offers Open ticket", async () => {
    const to = unique("ticket-card")
    const id = await stageCompose(to, { followUp: {} })
    const { ticketId } = await seedTicketInbound(to, { sentAt: null })
    await approveSettled(id)
    const guard = (
      await withRlsContext(admin, (tx) =>
        getApproval(tx as never, { orgId, userId: admin.userId, requestId: id, sendGuards: true }),
      )
    )?.sendGuard
    expect(guard?.state).toBe("replied")
    expect(guard?.record).toEqual({ kind: "ticket", id: ticketId })
    expect(guard?.quote).toContain("I already answered this.")
  }, 60_000)

  it("a stop on a ticket the caller cannot open names a ticket, not a mailbox", async () => {
    const to = unique("ticket-unreadable")
    await ensureRecordedBasis(orgId, [to])
    await seedOutbound(to)
    const { ticketId } = await seedTicketInbound(to)
    const staged = await executeToolCore({
      toolName: "mail:compose",
      orgId,
      actor: {
        ...admin,
        // Every mail scope, none of the tickets app's.
        scopes: [
          ...admin.scopes.filter((s: string) => s !== "*"),
          "mail:accounts:admin",
          "mail:accounts:read",
          "mail:accounts:write",
          "mail:drafts:read",
          "mail:drafts:write",
        ],
      },
      params: composeParams(to, { followUp: {} }),
      threadId,
      origin: "in-app-agent",
    })
    if (!("error" in staged)) throw new Error(`not refused: ${JSON.stringify(staged)}`)
    expect(staged.error.code).toBe("SEND_GUARD_REPLIED")
    expect(staged.error.message).toContain("It came in on a ticket you cannot open.")
    expect(staged.error.message).not.toContain(ticketId)
    expect(staged.error.message).not.toContain("mailbox")
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
    const companyId = await createTestCompany(orgId)
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

  it("an import placeholder or a former member counts by their exact address only, never their domain", async () => {
    // Mutation caught: every non-portal user's domain counted as the org's own, whatever its status.
    const domain = `prospect-${++counter}.example`
    await privileged.withSystemDb("send-guard-test-placeholder", (tx) =>
      tx.execute(
        drizzleSql.raw(
          insertSql("kernel.users", {
            org_id: orgId,
            email: `jane@${domain}`,
            name: "Jane (imported)",
            user_type: "member",
            status: "deactivated",
          }),
        ),
      ),
    )
    const buyer = `buyer@${domain}`
    expect(await commercialRecipient(orgId, [`jane@${domain}`, buyer])).toBe(buyer)
  }, 60_000)

  it("an active member's domain stays the org's own", async () => {
    const domain = `ourteam-${++counter}.example`
    await privileged.withSystemDb("send-guard-test-active-member", (tx) =>
      tx.execute(
        drizzleSql.raw(
          insertSql("kernel.users", {
            org_id: orgId,
            email: `lead@${domain}`,
            name: "Team Lead",
            user_type: "member",
            status: "active",
          }),
        ),
      ),
    )
    const outsider = unique("outsider")
    expect(await commercialRecipient(orgId, [`someone.else@${domain}`, outsider])).toBe(outsider)
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
    await seedInbound(daemon, { body: `Your message to ${to} could not be delivered.` })
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

  async function heldDraft(extra: Record<string, unknown> = {}) {
    const to = unique("away")
    const id = await stageCompose(to, extra)
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

  it("held is on Home as the viewer's own decision, with its hold, and not counted", async () => {
    const { id } = await heldDraft()
    const { feed, badge } = await home()
    const row = feed.find((i) => i.entityId === id)
    expect(row?.kind).toBe("approval_pending")
    expect(row?.metadata?.sendGuard).toMatchObject({ state: "held" })
    expect(typeof (row?.metadata?.sendGuard as { holdUntil?: unknown })?.holdUntil).toBe("string")
    expect(row?.metadata?.uncounted).toBeUndefined()
    expect(badge.some((i) => i.entityId === id)).toBe(false)
  }, 60_000)

  it("when its hold ends it is on Home and counted, with no write", async () => {
    const { id } = await heldDraft()
    expect((await home()).badge.some((i) => i.entityId === id)).toBe(false)
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
      // On Home as the viewer's own decision, never in the badge.
      expect(feed.find((i) => i.entityId === held.id)?.metadata?.sendGuard).toMatchObject({
        state: "held",
      })
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

  it("a held marketing follow-up sent by Send now calls the footer, and its record says so", async () => {
    const { id } = await heldDraft({ followUp: {} })
    expect(
      ((await requestRow(id)).current_payload.sendGuard as PinnedSendGuard).classification,
    ).toBe("marketing")
    const footer = spyOn(footerModule, "applyCommercialFooter")
    try {
      const before = sent.length
      await sendNow(id)
      expect(sent.length).toBe(before + 1)
      expect(footer).toHaveBeenCalledTimes(1)
      expect((await executionRow(id))?.external_ref?.guard).toMatchObject({ footer: "commercial" })
      expect((await executionResult(id))?.guard).toMatchObject({
        classification: "marketing",
        footer: "commercial",
      })
    } finally {
      footer.mockRestore()
    }
  }, 60_000)

  it("a held draft does not expire before its hold ends: its deadline moves past the hold", async () => {
    const { id } = await heldDraft()
    const until = new Date((await card(id))?.sendGuard?.holdUntil ?? 0).getTime()
    await sql`UPDATE kernel.approval_requests
                 SET created_at = now() - interval '7 days', expires_at = now() - interval '1 minute'
               WHERE id = ${id}`
    await runApprovalExpiry({ orgId, requestId: id })
    const [row] = await sql<Array<{ status: string; expires_at: Date }>>`
      SELECT status, expires_at FROM kernel.approval_requests WHERE id = ${id}`
    expect(row?.status).toBe("pending")
    // The hold's end plus the window it was given (7 days less a minute here).
    expect(new Date(row?.expires_at ?? 0).getTime()).toBeGreaterThan(until + 6 * DAY)
    // A plain draft past its deadline still expires.
    const plain = await stageCompose(unique("plain-expiry"))
    await sql`UPDATE kernel.approval_requests SET expires_at = now() - interval '1 minute' WHERE id = ${plain}`
    await runApprovalExpiry({ orgId, requestId: plain })
    expect((await requestRow(plain)).status).toBe("expired")
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

describe("a new message is commercial by its recipient's data", () => {
  const AT = "2026-03-02T09:00:00.000Z"
  const insert = (table: string, row: Record<string, unknown>) =>
    sql.unsafe(insertSql(table, row as never))

  /** A contact at `email` on an open deal of a pipeline. */
  async function contactOnOpenDeal(
    email: string,
    basis: string | null = "professional_interest",
  ): Promise<string> {
    const contact = crypto.randomUUID()
    const project = crypto.randomUUID()
    const status = crypto.randomUUID()
    const task = crypto.randomUUID()
    const thread = crypto.randomUUID()
    await insert("kernel.contacts", {
      id: contact,
      org_id: orgId,
      handle: `@deal-${contact.slice(0, 8)}`,
      email,
      name: "Prospect",
      org_access: "editor",
      created_by: userId,
      // What a commercial mail to them needs: a recorded basis, a business, a country.
      lawful_basis: basis,
      is_consumer: false,
      recipient_country: "FR",
    })
    await insert("kernel.threads", {
      id: thread,
      org_id: orgId,
      handle: `deal-${thread.slice(0, 8)}`,
      created_by: userId,
    })
    await insert("app_projects.projects", {
      id: project,
      org_id: orgId,
      name: "Sales",
      key: `D${project.slice(0, 8).toUpperCase()}`,
      owner_id: userId,
      kind: "pipeline",
      created_at: AT,
      updated_at: AT,
    })
    await insert("app_projects.project_statuses", {
      id: status,
      org_id: orgId,
      project_id: project,
      label: "Proposal",
      '"order"': 1,
      terminal: false,
      created_at: AT,
      updated_at: AT,
    })
    await insert("app_projects.tasks", {
      id: task,
      org_id: orgId,
      project_id: project,
      status_id: status,
      title: "Studio fit-out",
      number: 1,
      thread_id: thread,
      created_by: userId,
      created_at: AT,
      updated_at: AT,
    })
    await insert("app_projects.deals", { task_id: task, org_id: orgId, contact_id: contact })
    return contact
  }

  it("a new message to a contact on an open deal gets the footer and opt-out link and is refused when they opted out, whoever staged it", async () => {
    const to = unique("deal-prospect")
    await contactOnOpenDeal(to)
    const id = await stageCompose(to)
    const guard = (await requestRow(id)).current_payload.sendGuard as PinnedSendGuard
    expect(guard.classification).toBe("marketing")
    const before = sent.length
    await approve(id)
    expect(sent.length).toBe(before + 1)
    const text = String(sent.at(-1)?.textBody)
    expect(text).toContain("Org Test SAS, 1 rue de Test, 75001 Paris")
    expect(text).toMatch(/\/public\/opt-out\/[A-Za-z0-9_-]{43} or reply stop\./)
    expect((sent.at(-1)?.headers as Record<string, string>)?.["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    )

    await suppressionsModule.addSuppression(null, { orgId, email: to, reason: "person" })
    for (const origin of ["in-app-agent", "mcp"] as const) {
      const staged = await executeToolCore({
        toolName: "mail:compose",
        orgId,
        actor: admin,
        params: composeParams(to),
        threadId,
        origin,
      })
      if (!("error" in staged)) throw new Error(`${origin}: not refused`)
      expect(staged.error.code).toBe("SEND_GUARD_OPTED_OUT")
    }
    expect(sent.length).toBe(before + 1)
  }, 60_000)

  /** A person's own call from the UI: no agent, no approval. */
  const ownCompose = (to: string) =>
    executeToolCore({
      toolName: "mail:compose",
      orgId,
      actor: admin,
      params: composeParams(to),
      threadId,
      origin: "human-ui",
    })

  const requestCount = async () =>
    Number(
      (
        await sql<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${orgId}`
      )[0]?.n,
    )

  /** A person's own new message written in the composer and sent from its draft. The draft is
   *  saved first: a send claims its draft in a transaction of its own. */
  async function sendFromComposer(to: string) {
    const draft = await withRlsContext(admin, (tx) =>
      mailService.createDraft(tx as never, {
        orgId,
        userId,
        accountId: oldAccount,
        to: [{ email: to }],
        subject: "Our offer",
      }),
    )
    return withRlsContext(admin, async (tx) => {
      return mailService.sendDraft(tx as never, {
        orgId,
        userId,
        draftId: (draft as { id: string }).id,
        to: [{ email: to }],
        subject: "Our offer",
        textBody: "Here is our offer.",
        htmlBody: "<p>Here is our offer.</p>",
      })
    })
  }

  const setContactLanguage = (email: string, language: string) =>
    sql`UPDATE kernel.contacts SET metadata = ${JSON.stringify({ language })}::jsonb
         WHERE org_id = ${orgId} AND lower(email) = ${email}`

  it("a person's own new message to a prospect carries the footer, opt-out link and headers, adds no approval, and is refused when they opted out", async () => {
    const to = unique("own-prospect")
    await contactOnOpenDeal(to)
    const requests = await requestCount()
    const before = sent.length
    const result = await ownCompose(to)
    expect("blocked" in result || "error" in result).toBe(false)
    expect(sent.length).toBe(before + 1)
    const text = String(sent.at(-1)?.textBody)
    expect(text).toContain("Org Test SAS, 1 rue de Test, 75001 Paris")
    expect(text).toMatch(/\/public\/opt-out\/[A-Za-z0-9_-]{43} or reply stop\./)
    const headers = sent.at(-1)?.headers as Record<string, string>
    expect(headers?.["List-Unsubscribe"]).toMatch(/^<.+\/public\/opt-out\/[A-Za-z0-9_-]{43}>$/)
    expect(headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click")
    expect(await requestCount()).toBe(requests)

    await suppressionsModule.addSuppression(null, { orgId, email: to, reason: "person" })
    const refused = await ownCompose(to)
    if (!("error" in refused)) throw new Error(`not refused: ${JSON.stringify(refused)}`)
    expect(refused.error.code).toBe("suppressed_new_message")
    expect(String(refused.error.message)).toContain(`${to} opted out on `)
    expect(sent.length).toBe(before + 1)
    expect(await requestCount()).toBe(requests)
  }, 60_000)

  it("a prospect's mail from the composer shows its footer as fixed lines and leaves with it in the recipient's language, else the organization's", async () => {
    const [org] = await sql<Array<{ default_locale: string | null }>>`
      SELECT default_locale FROM kernel.organizations WHERE id = ${orgId}`
    const french = unique("own-fr")
    await contactOnOpenDeal(french)
    await setContactLanguage(french, "fr")
    const check = await checkPersonCompose(orgId, [french])
    if (!("footerLines" in check)) throw new Error(`no footer: ${JSON.stringify(check)}`)
    expect(check.footerLines).toEqual([
      "Org Test SAS, 1 rue de Test, 75001 Paris",
      "Si vous ne nous avez pas donné votre adresse vous-même, Org Test SAS l'a obtenue d'une autre source et ne l'utilise que pour des messages professionnels comme celui-ci. Vous pouvez vous y opposer à tout moment avec le lien ci-dessous.",
      "Pour ne plus recevoir de messages commerciaux de Org Test SAS : (lien de désinscription) ou répondez stop.",
    ])
    const before = sent.length
    await sendFromComposer(french)
    expect(sent.length).toBe(before + 1)
    expect(String(sent.at(-1)?.textBody)).toMatch(
      /Pour ne plus recevoir de messages commerciaux de Org Test SAS : \S+\/public\/opt-out\/[A-Za-z0-9_-]{43} ou répondez stop\./,
    )
    expect(String(sent.at(-1)?.htmlBody)).toContain("ou répondez stop.")
    expect((sent.at(-1)?.headers as Record<string, string>)?.["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    )

    const noLanguage = unique("own-org-language")
    await contactOnOpenDeal(noLanguage)
    const english = await checkPersonCompose(orgId, [noLanguage])
    if (!("footerLines" in english)) throw new Error("no footer")
    expect(english.footerLines.at(-1)).toBe(
      "To stop commercial messages from Org Test SAS: (opt-out link) or reply stop.",
    )
    try {
      await sql`UPDATE kernel.organizations SET default_locale = 'fr' WHERE id = ${orgId}`
      const orgFrench = await checkPersonCompose(orgId, [noLanguage])
      if (!("footerLines" in orgFrench)) throw new Error("no footer")
      expect(orgFrench.footerLines.at(-1)).toContain("ou répondez stop.")
    } finally {
      await sql`UPDATE kernel.organizations SET default_locale = ${org?.default_locale ?? null}
                 WHERE id = ${orgId}`
    }

    await suppressionsModule.addSuppression(null, { orgId, email: french, reason: "link" })
    const refusal = await checkPersonCompose(orgId, [french])
    expect("refused" in refusal && refusal.refused.message).toContain(`${french} opted out on `)
    await expect(sendFromComposer(french)).rejects.toThrow(`${french} opted out on `)
    expect(sent.length).toBe(before + 1)
  }, 60_000)

  it("the composer is told a prospect has no recorded basis and the person can still send; an opted-out prospect stays refused", async () => {
    const app = new Hono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("userId", userId)
      c.set("orgId", orgId)
      c.set("scopes", ["mail:conversations:write"] as never)
      c.set("dimensionGrants", {})
      await next()
    })
    app.route("/api/mail", mailRoutes)
    const check = async (to: string) => {
      const res = await app.request("/api/mail/compose-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: [to] }),
      })
      expect(res.status).toBe(200)
      return ((await res.json()) as { data: Record<string, unknown> }).data
    }

    const to = unique("own-no-basis")
    const contact = await contactOnOpenDeal(to, null)
    const answer = await check(to)
    expect(answer.refusal).toBeNull()
    expect(answer.missingBasis).toEqual({ contactId: contact, name: "Prospect" })
    // The first commercial mail to them carries where their address came from.
    expect(answer.footerLines).toContain(
      "If you did not give us your address yourself, Org Test SAS obtained it from another source and uses it only for professional messages like this one. You can object at any time with the link below.",
    )
    const before = sent.length
    const result = await ownCompose(to)
    expect("error" in result || "blocked" in result).toBe(false)
    expect(sent.length).toBe(before + 1)

    const recorded = unique("own-basis")
    await contactOnOpenDeal(recorded)
    expect((await check(recorded)).missingBasis).toBeNull()

    await suppressionsModule.addSuppression(null, { orgId, email: to, reason: "person" })
    const optedOut = await check(to)
    expect(optedOut.missingBasis).toBeNull()
    expect(String(optedOut.refusal)).toContain(`${to} opted out on `)
    // A check before any send says why it cannot go, never that something failed to send.
    expect(String(optedOut.refusal)).not.toContain("Nothing was sent")
    const refused = await ownCompose(to)
    if (!("error" in refused)) throw new Error(`not refused: ${JSON.stringify(refused)}`)
    expect(refused.error.code).toBe("suppressed_new_message")
    expect(sent.length).toBe(before + 1)
  }, 60_000)

  it("a person's own new message to an opted-out supplier sends with the line", async () => {
    const to = unique("own-supplier")
    await insert("kernel.contacts", {
      id: crypto.randomUUID(),
      org_id: orgId,
      handle: `@supplier-${counter}`,
      email: to,
      name: "Supplier",
      org_access: "editor",
      created_by: userId,
    })
    await suppressionsModule.addSuppression(null, { orgId, email: to, reason: "person" })
    expect(await checkPersonCompose(orgId, [to])).toEqual({
      commercial: false,
      line: `${to} opted out. Send only if this is not commercial.`,
    })
    const before = sent.length
    const result = await ownCompose(to)
    expect("error" in result || "blocked" in result).toBe(false)
    expect(sent.length).toBe(before + 1)
    expect(String(sent.at(-1)?.textBody)).not.toContain("/public/opt-out/")
  }, 60_000)

  it("a new message to someone with no deal, basis or outside source stays plain", async () => {
    const to = unique("no-deal")
    const id = await stageCompose(to)
    const guard = (await requestRow(id)).current_payload.sendGuard as PinnedSendGuard
    expect(guard.classification).toBe("none")
  }, 60_000)

  /** The commercial-send records written for `email`. */
  const commercialRecords = async (
    email: string,
  ): Promise<Array<{ metadata: Record<string, unknown> }>> => [
    ...(await sql<Array<{ metadata: Record<string, unknown> }>>`
      SELECT metadata FROM kernel.audit_log
       WHERE org_id = ${orgId} AND action = 'mail.commercial_send'
         AND metadata ->> 'recipientHash' = ${suppressionsModule.hashEmail(orgId, email)}`),
  ]
  const noticeAt = async (email: string) =>
    (
      await sql<Array<{ at: string | null }>>`
        SELECT art14_notice_at::text AS at FROM kernel.contacts
         WHERE org_id = ${orgId} AND lower(email) = ${email}`
    )[0]?.at ?? null
  const pushSend = async (_c: unknown, _i: unknown, message: unknown) => {
    sent.push(message as Record<string, unknown>)
    return { messageId: `<sent-${sent.length}@org.test>`, deliveryState: "delivered" as const }
  }
  /** Runs `fn` with every send failing at the provider. */
  async function withFailingSend(fn: () => Promise<unknown>): Promise<void> {
    SandboxBridgeTestAccess.setSmtpSend(async () => {
      throw Object.assign(new Error("550 mailbox unavailable"), { providerRejected: true })
    })
    try {
      await fn()
    } catch {
      // The outcome is read from the rows.
    } finally {
      SandboxBridgeTestAccess.setSmtpSend(pushSend as never)
    }
  }

  it("a plain draft whose recipient is edited to a prospect leaves with the footer and its record; edited to someone who opted out, it does not leave", async () => {
    const prospect = unique("edited-to-prospect")
    await contactOnOpenDeal(prospect)
    const id = await stageCompose(unique("edited-from-plain"))
    expect(
      ((await requestRow(id)).current_payload.sendGuard as PinnedSendGuard).classification,
    ).toBe("none")
    await updatePayload({ orgId, requestId: id, actor: admin, fields: { to: [prospect] } } as never)
    const before = sent.length
    await approve(id)
    expect(sent.length).toBe(before + 1)
    expect(String(sent.at(-1)?.textBody)).toMatch(
      /\/public\/opt-out\/[A-Za-z0-9_-]{43} or reply stop\./,
    )
    expect((await commercialRecords(prospect)).length).toBe(1)

    const optedOut = unique("edited-to-opted-out")
    await contactOnOpenDeal(optedOut)
    await suppressionsModule.addSuppression(null, { orgId, email: optedOut, reason: "person" })
    const second = await stageCompose(unique("edited-from-plain-2"))
    await updatePayload({
      orgId,
      requestId: second,
      actor: admin,
      fields: { to: [optedOut] },
    } as never)
    const sentBefore = sent.length
    await approveSettled(second)
    expect(sent.length).toBe(sentBefore)
    expect((await executionRow(second))?.error?.code).toBe("send_guard_opted_out")
  }, 90_000)

  it("a commercial draft edited to name two people outside the organization does not leave, and says why", async () => {
    const first = unique("one-of-two")
    const other = unique("two-of-two")
    await contactOnOpenDeal(first)
    await contactOnOpenDeal(other)
    const id = await stageCompose(first)
    expect(
      ((await requestRow(id)).current_payload.sendGuard as PinnedSendGuard).classification,
    ).toBe("marketing")
    await updatePayload({ orgId, requestId: id, actor: admin, fields: { cc: [other] } } as never)
    const before = sent.length
    await approveSettled(id)
    expect(sent.length).toBe(before)
    const error = (await executionRow(id))?.error
    expect(error?.code).toBe("commercial_one_recipient")
    expect(String(error?.message)).toContain(`${first}, ${other}`)
    expect(String(error?.message)).toContain("one message per person")
  }, 90_000)

  it("an organization whose member writes from a shared mail provider still treats a prospect there as outside", async () => {
    const member = `owner-${counter}@gmail.com`
    const prospect = `prospect-${++counter}@gmail.com`
    const second = `prospect-${++counter}@gmail.com`
    await privileged.withSystemDb("send-guard-test-gmail-member", (tx) =>
      tx.execute(
        drizzleSql.raw(
          insertSql("kernel.users", { org_id: orgId, email: member, name: "Gmail Owner" }),
        ),
      ),
    )
    try {
      await contactOnOpenDeal(prospect)
      await contactOnOpenDeal(second)
      const one = await checkPersonCompose(orgId, [member, prospect])
      expect("recipient" in one && one.recipient).toBe(prospect)
      const two = await checkPersonCompose(orgId, [prospect, second])
      expect("refused" in two && two.refused.code).toBe("commercial_one_recipient")
    } finally {
      await sql`DELETE FROM kernel.users WHERE org_id = ${orgId} AND email = ${member}`
    }
  }, 60_000)

  it("a person's own commercial mail from the composer writes its send record and marks the notice, only once it left", async () => {
    const failed = unique("composer-failed")
    await contactOnOpenDeal(failed)
    await withFailingSend(() => sendFromComposer(failed))
    expect(await commercialRecords(failed)).toEqual([])
    expect(await noticeAt(failed)).toBeNull()

    const to = unique("composer-recorded")
    await contactOnOpenDeal(to)
    await sendFromComposer(to)
    const records = await commercialRecords(to)
    expect(records).toHaveLength(1)
    expect(records[0]?.metadata.approvedBy).toBe("person")
    expect(records[0]?.metadata.art14Notice).toBe(true)
    expect(await noticeAt(to)).not.toBeNull()
  }, 90_000)

  it("an agent's commercial mail that fails at the provider writes no send record and leaves the notice owed", async () => {
    const to = unique("agent-failed")
    await contactOnOpenDeal(to)
    const id = await stageCompose(to)
    await withFailingSend(() => approve(id))
    expect(await commercialRecords(to)).toEqual([])
    expect(await noticeAt(to)).toBeNull()
  }, 90_000)
})

describe("the client's company is the other side", () => {
  /** A company holding `domain`, as the companies tools store one. */
  async function companyAt(domain: string | null, name = "Client Co"): Promise<string> {
    const id = await createTestCompany(orgId, name)
    await privileged.withSystemDb("send-guard-test-company-domain", (tx) =>
      tx.execute(drizzleSql`UPDATE kernel.companies SET domain = ${domain} WHERE id = ${id}::uuid`),
    )
    return id
  }

  async function joinCompany(contactId: string, companyId: string): Promise<void> {
    await privileged.withSystemDb("send-guard-test-contact-company", (tx) =>
      tx.execute(
        drizzleSql`UPDATE kernel.contacts SET company_id = ${companyId}::uuid WHERE id = ${contactId}::uuid`,
      ),
    )
  }

  async function companyOf(email: string): Promise<string | null> {
    const [row] = await sql<Array<{ company_id: string | null }>>`
      SELECT company_id::text AS company_id FROM kernel.contacts
       WHERE org_id = ${orgId} AND lower(email) = ${email.toLowerCase()}`
    if (!row) throw new Error(`no contact for ${email}`)
    return row.company_id
  }

  /** One inbound mail written as the sync writes it, in a thread of its own. */
  async function ingest(from: string, body = "Thanks, that works for me.") {
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
          accountId: oldAccount,
          origin: "incremental",
          messages: [
            {
              from: { email: from },
              to: [{ email: "sales@org.test" }],
              externalMessageId: id,
              externalThreadId: id,
              externalProviderId: id,
              subject: "About the order",
              textBody: body,
              htmlBody: "",
              snippet: body.slice(0, 40),
              cc: [],
              bcc: [],
              isRead: false,
              isStarred: false,
              labels: [],
              references: [],
              inReplyTo: null,
              direction: "inbound",
              sentAt: new Date().toISOString(),
              headers: {},
            },
          ],
        },
      )
    })
  }

  it("a colleague at the same company who becomes a contact after staging and replies stops the send", async () => {
    // Mutation caught: the contact set kept to the pinned list (no company expansion).
    const companyId = await companyAt(null)
    const to = unique("buyer")
    await joinCompany(await minimal.contact(orgId, to), companyId)
    const id = await stageCompose(to)
    const colleague = unique("colleague")
    const colleagueId = await minimal.contact(orgId, colleague)
    await joinCompany(colleagueId, companyId)
    await seedInbound(colleague, { contactId: colleagueId })
    const before = sent.length
    await approveSettled(id)
    expect(sent.length).toBe(before)
    expect((await executionRow(id))?.error?.code).toBe("send_guard_replied")
  }, 60_000)

  it("a colleague's mail in a thread linked to nobody stops the send too", async () => {
    const companyId = await companyAt(null)
    const to = unique("buyer-b")
    await joinCompany(await minimal.contact(orgId, to), companyId)
    const id = await stageCompose(to)
    const colleague = unique("colleague-b")
    await joinCompany(await minimal.contact(orgId, colleague), companyId)
    await seedInbound(colleague)
    await approveSettled(id)
    expect((await executionRow(id))?.error?.code).toBe("send_guard_replied")
  }, 60_000)

  it("a contact at another company replying does not stop the send", async () => {
    const to = unique("buyer-c")
    await joinCompany(await minimal.contact(orgId, to), await companyAt(null))
    const id = await stageCompose(to)
    const other = unique("elsewhere")
    const otherId = await minimal.contact(orgId, other)
    await joinCompany(otherId, await companyAt(null, "Other Co"))
    await seedInbound(other, { contactId: otherId })
    const before = sent.length
    await approve(id)
    expect(sent.length).toBe(before + 1)
  }, 60_000)

  it("a new sender at the company's domain is linked and stops the send at the next check", async () => {
    // Mutation caught: a new sender contact left without its company.
    const domain = `acme-${++counter}.example`
    const companyId = await companyAt(domain)
    const to = `buyer@${domain}`
    await joinCompany(await minimal.contact(orgId, to), companyId)
    const id = await stageCompose(to)
    const stranger = `new.person@${domain.toUpperCase()}`
    await ingest(stranger)
    expect(await companyOf(stranger)).toBe(companyId)
    await approveSettled(id)
    expect((await executionRow(id))?.error?.code).toBe("send_guard_replied")
  }, 60_000)

  it("two companies on one domain link nobody", async () => {
    const domain = `group-${++counter}.example`
    await companyAt(domain, "Group North")
    await companyAt(domain, "Group South")
    const stranger = `someone@${domain}`
    await ingest(stranger)
    expect(await companyOf(stranger)).toBeNull()
  }, 60_000)

  it("a sender at a consumer mail domain joins no company", async () => {
    await companyAt("gmail.com", "Misfiled Co")
    const stranger = `someone.${++counter}@gmail.com`
    await ingest(stranger)
    expect(await companyOf(stranger)).toBeNull()
  }, 60_000)

  for (const domain of ["hotmail.fr", "t-online.de", "outlook.fr", "yahoo.it", "bluewin.ch"]) {
    it(`a sender at a national free mail domain (${domain}) joins no company, even one recorded on it`, async () => {
      await companyAt(domain, `Misfiled ${domain}`)
      const stranger = `someone.${++counter}@${domain}`
      await ingest(stranger)
      expect(await companyOf(stranger)).toBeNull()
    }, 60_000)
  }

  /** A member's own mailbox, which the admin running these calls cannot read. */
  async function someoneElsesMailbox(): Promise<string> {
    const ctx = seedContext({ orgId, now: new Date() })
    const holder = await minimal.person(orgId, { name: "Mailbox Holder" })
    return (
      await ensureMailAccount(ctx, {
        ownerType: "user",
        userId: holder.id,
        email: `holder-${++counter}@org.test`,
        provider: "imap",
      })
    ).accountId
  }

  it("a colleague at the client who wrote to a mailbox the caller cannot read is named only by their company", async () => {
    // Mutation caught: the stop names the colleague's address, read from someone else's mailbox.
    const companyId = await companyAt(null, "Hidden Client Co")
    const to = unique("buyer-m")
    await joinCompany(await minimal.contact(orgId, to), companyId)
    const colleague = unique("cfo")
    await joinCompany(await minimal.contact(orgId, colleague), companyId)
    await seedOutbound(to)
    await seedInbound(colleague, { account: await someoneElsesMailbox() })
    const staged = await agentCall("mail:compose", composeParams(to, { followUp: {} }))
    if (!("error" in staged)) throw new Error(`not refused: ${JSON.stringify(staged)}`)
    expect(staged.error.code).toBe("SEND_GUARD_REPLIED")
    expect(staged.error.message).toContain("Someone at Hidden Client Co replied on ")
    expect(staged.error.message).toContain("a mailbox you cannot read")
    expect(JSON.stringify(staged.error)).not.toContain(colleague)
  }, 60_000)

  it("a colleague's automatic reply in a mailbox the caller cannot read gives neither their address nor their return date", async () => {
    // Mutation caught: the held stop and the card name the colleague and the date their reply gives.
    const companyId = await companyAt(null, "Away Client Co")
    const to = unique("buyer-h")
    await joinCompany(await minimal.contact(orgId, to), companyId)
    const id = await stageCompose(to)
    const colleague = unique("away-cfo")
    await joinCompany(await minimal.contact(orgId, colleague), companyId)
    await seedInbound(colleague, {
      account: await someoneElsesMailbox(),
      rawHeaders: { "auto-submitted": "auto-replied" },
      subject: "Automatic reply",
      body: "I am out of the office until 28 December.",
    })
    await approveSettled(id)
    const error = (await executionRow(id))?.error
    expect(error?.code).toBe("send_guard_held")
    const message = String(error?.message)
    expect(message).toContain("Someone at Away Client Co sent an automatic reply")
    expect(message).not.toContain("return date")
    expect(JSON.stringify(error)).not.toContain(colleague)
    const card = await withRlsContext(admin, (tx) =>
      getApproval(tx as never, { orgId, userId: admin.userId, requestId: id, sendGuards: true }),
    )
    expect(card?.sendGuard?.state).toBe("held")
    expect(card?.sendGuard?.who).toBe("Someone at Away Client Co")
    expect(JSON.stringify(card?.sendGuard)).not.toContain(colleague)
  }, 60_000)

  it("the draft's own recipient is still named when their reply is in a mailbox the caller cannot read", async () => {
    const companyId = await companyAt(null, "Named Client Co")
    const to = unique("buyer-n")
    await joinCompany(await minimal.contact(orgId, to), companyId)
    await seedOutbound(to)
    await seedInbound(to, { account: await someoneElsesMailbox() })
    const staged = await agentCall("mail:compose", composeParams(to, { followUp: {} }))
    if (!("error" in staged)) throw new Error(`not refused: ${JSON.stringify(staged)}`)
    expect(staged.error.message).toContain(`${to} replied on `)
  }, 60_000)
})

describe("a reply asking to stop", () => {
  const extractRowsOf = <T>(result: unknown): T[] =>
    (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[]
  async function ingestFrom(
    from: string,
    body: string,
    headers: Record<string, string> = {},
    into: { accountId?: string; message?: Record<string, unknown> } = {},
  ) {
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
          accountId: into.accountId ?? oldAccount,
          origin: "incremental",
          messages: [
            {
              from: { email: from },
              to: [{ email: "sales@org.test" }],
              externalMessageId: id,
              externalThreadId: id,
              externalProviderId: id,
              subject: "Re: our offer",
              textBody: body,
              htmlBody: "",
              snippet: body.slice(0, 40),
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
              ...into.message,
            },
          ],
        },
      )
    })
  }

  async function proposals(email: string) {
    return sql<Array<{ id: string; status: string; tool_params: Record<string, unknown> }>>`
      SELECT id::text AS id, status, tool_params FROM kernel.approval_requests
       WHERE org_id = ${orgId} AND tool_name = 'mail:suppression_add'
         AND lower(tool_params->>'email') = ${email.toLowerCase()}`
  }

  it("each opt-out phrase proposes once per sender and never suppresses by itself", async () => {
    // Mutation caught: no dedupe by sender (a second card), or a suppression written at ingest.
    const email = unique("stop-asker")
    await ingestFrom(email, "Please unsubscribe me from these emails.")
    await ingestFrom(email, "STOP")
    const rows = await proposals(email)
    expect(rows.length).toBe(1)
    expect(rows[0]?.status).toBe("pending")
    expect(rows[0]?.tool_params).toMatchObject({ email, reason: "reply" })
    const [message] = extractRowsOf<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id FROM ${MAIL}.messages
         WHERE org_id = ${orgId}::uuid AND lower(from_address->>'email') = ${email}
         ORDER BY synced_at ASC LIMIT 1`),
    )
    expect(rows[0]?.tool_params.source).toBe(message?.id)
    expect(await suppressionsModule.suppressedAmong(orgId, [email])).toEqual([])
    for (const ask of ["Merci de me désinscrire", "Bitte abmelden", "Quiero darme de baja"]) {
      const other = unique("asker")
      await ingestFrom(other, ask)
      expect((await proposals(other)).length).toBe(1)
    }
  }, 90_000)

  it("a long reply quoting stop proposes nothing", async () => {
    const email = unique("long-reply")
    const words = Array.from({ length: 70 }, () => "fine").join(" ")
    await ingestFrom(email, `${words} we will not stop the project ${words}`)
    await ingestFrom(email, "Sounds good.\n\nOn Monday, Sales wrote:\n> Reply STOP to unsubscribe.")
    expect((await proposals(email)).length).toBe(0)
  }, 60_000)

  it("a newsletter saying unsubscribe proposes nothing", async () => {
    const email = unique("newsletter")
    await ingestFrom(email, "Unsubscribe", { "List-Unsubscribe": "<https://news.example/u>" })
    expect((await proposals(email)).length).toBe(0)
  }, 60_000)

  it("approving the proposal a reply raised records the opt-out", async () => {
    const email = unique("approve-asker")
    await ingestFrom(email, "Ne plus recevoir, merci.")
    const [row] = await proposals(email)
    if (!row) throw new Error("no proposal")
    await approve(row.id)
    expect(await suppressionsModule.suppressedAmong(orgId, [email])).toEqual([email])
    // An address that already opted out raises no new card.
    await ingestFrom(email, "stop")
    expect((await proposals(email)).length).toBe(1)
  }, 90_000)

  async function ownerOf(requestId: string): Promise<string | null> {
    const [row] = await sql<Array<{ owner: string | null }>>`
      SELECT resource_owner_id::text AS owner FROM kernel.approval_requests WHERE id = ${requestId}`
    return row?.owner ?? null
  }

  it("a stop asked in a person's own mailbox goes to that person, one asked in a shared mailbox to the mail approvers", async () => {
    // Mutation caught: every proposal routed to the org's mail approvers, naming who wrote to whom.
    const ctx = seedContext({ orgId, now: new Date() })
    const holder = await minimal.person(orgId, { name: "Own Mailbox" })
    const own = await ensureMailAccount(ctx, {
      ownerType: "user",
      userId: holder.id,
      email: `own-box-${++counter}@org.test`,
      provider: "imap",
    })
    const personal = unique("personal-stop")
    await ingestFrom(personal, "Please unsubscribe me.", {}, { accountId: own.accountId })
    const [mine] = await proposals(personal)
    if (!mine) throw new Error("no proposal from the personal mailbox")
    expect(await ownerOf(mine.id)).toBe(holder.id)
    const shared = unique("shared-stop")
    await ingestFrom(shared, "Please unsubscribe me.")
    const [theirs] = await proposals(shared)
    if (!theirs) throw new Error("no proposal from the shared mailbox")
    expect(await ownerOf(theirs.id)).toBeNull()
  }, 90_000)

  it("a stop from a sender whose authentication failed proposes nothing", async () => {
    // Mutation caught: a forged From proposed like a real one.
    const forged = unique("forged")
    const fail = {
      receivedVia: "gmail_api",
      authenticationResults: ["mx.google.com; dmarc=fail header.from=client.test"],
    }
    await ingestFrom(forged, "Please unsubscribe me.", {}, { message: fail })
    expect((await proposals(forged)).length).toBe(0)
    const real = unique("authentic")
    const pass = {
      receivedVia: "gmail_api",
      authenticationResults: ["mx.google.com; dmarc=pass header.from=client.test"],
    }
    await ingestFrom(real, "Please unsubscribe me.", {}, { message: pass })
    expect((await proposals(real)).length).toBe(1)
  }, 90_000)
})

describe("mail a person sends from the composer", () => {
  const insert = (table: string, row: Record<string, unknown>) =>
    sql.unsafe(insertSql(table, row as never))

  it("links the first To address's existing contact, so the mail is on the contact's and the company's timeline, and creates no contact", async () => {
    // Mutation caught: the composer's send stored its conversation with no contact.
    const company = await createTestCompany(orgId, "Composer Studio")
    const contact = crypto.randomUUID()
    const known = unique("composer-known")
    await insert("kernel.contacts", {
      id: contact,
      org_id: orgId,
      handle: `@composer-${contact.slice(0, 8)}`,
      email: known,
      name: "Daniel Composer",
      company_id: company,
      org_access: "editor",
      created_by: userId,
    })
    const unknown = unique("composer-unknown")
    const app = new Hono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("userId", userId)
      c.set("orgId", orgId)
      // The person's own request: their scopes, roles and grants.
      c.set("scopes", admin.scopes as never)
      c.set("dimensionGrants", admin.dimensionGrants as never)
      c.set("roles", admin.roles as never)
      await next()
    })
    app.route("/api/mail", mailRoutes)
    const send = async (to: string, subject: string) => {
      const draft = await withRlsContext(admin, (tx) =>
        mailService.createDraft(tx as never, {
          orgId,
          userId,
          accountId: oldAccount,
          to: [{ email: to }],
          subject,
        }),
      )
      const res = await app.request(`/api/mail/drafts/${(draft as { id: string }).id}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to: [{ email: to.toUpperCase() }],
          subject,
          textBody: "It ships on Monday.",
          htmlBody: "<p>It ships on Monday.</p>",
        }),
      })
      expect(res.status === 200 ? 200 : await res.text()).toBe(200)
      const [row] = await sql<Array<{ contact_id: string | null }>>`
        SELECT conversation.contact_id::text AS contact_id
          FROM app_mail.messages message
          JOIN app_mail.conversations conversation ON conversation.id = message.conversation_id
         WHERE message.org_id = ${orgId} AND message.subject = ${subject}`
      return row?.contact_id ?? null
    }
    expect(await send(known, "Your monitor repair: delivery date")).toBe(contact)
    expect(await send(unknown, "A note to nobody we know")).toBeNull()

    for (const target of [{ contactId: contact }, { companyId: company }]) {
      const page = await readActivity({ orgId, actor: admin, target })
      const mail = page?.items.filter((r) => r.source === "mail") ?? []
      expect(mail.map((r) => r.contactId)).toEqual([contact])
      expect(mail[0]?.title).toContain("Your monitor repair: delivery date")
    }
    const created = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.contacts WHERE org_id = ${orgId} AND lower(email) = ${unknown}`
    expect(created[0]?.n).toBe(0)
  }, 60_000)
})

describe("the recipient facts on an agent mail's card", () => {
  it("any agent mail to a contact shows its basis, consumer status and opt-out, whatever it is classified, as the composer reads them", async () => {
    // Mutation caught: a plain agent mail's card showed no facts about its recipient, so a
    // sales offer classified as a plain mail was approved blind.
    const business = unique("facts-business")
    await recordProspect(orgId, business, { lawfulBasis: "customer", isConsumer: false })
    const staged = blockedId(await agentCall("mail:compose", composeParams(business)))
    const read = await withRlsContext(admin, (tx) =>
      getApproval(tx as never, { orgId, userId, requestId: staged, sendGuards: true }),
    )
    const facts = [
      {
        email: business,
        name: "Test Contact",
        basis: "customer",
        isConsumer: false,
        optedOutAt: null,
      },
    ]
    expect(read?.sendGuard?.recipients).toEqual(facts as never)
    // The composer's own check reads the same facts for the same address.
    const app = new Hono<AppEnv>()
    app.use("*", async (c, next) => {
      c.set("userId", userId)
      c.set("orgId", orgId)
      c.set("scopes", ["mail:conversations:write"] as never)
      c.set("dimensionGrants", {})
      await next()
    })
    app.route("/api/mail", mailRoutes)
    const res = await app.request("/api/mail/compose-check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: [business] }),
    })
    const body = (await res.json()) as { data: { recipients: unknown } }
    expect(body.data.recipients).toEqual(facts)

    // Opted out: the composer says since when; an address no contact holds has no facts.
    const optedOut = unique("facts-opted-out")
    await recordProspect(orgId, optedOut, { lawfulBasis: null, isConsumer: null })
    await suppressionsModule.addSuppression(null, { orgId, email: optedOut, reason: "person" })
    const stranger = unique("facts-stranger")
    const res2 = await app.request("/api/mail/compose-check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: [optedOut, stranger] }),
    })
    const body2 = (await res2.json()) as {
      data: { recipients: Array<{ email: string; optedOutAt: string | null; basis: unknown }> }
    }
    expect(body2.data.recipients.map((r) => [r.email, r.basis, typeof r.optedOutAt])).toEqual([
      [optedOut, null, "string"],
    ])
  }, 60_000)
})
