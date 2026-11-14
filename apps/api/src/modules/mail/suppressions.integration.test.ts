// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Opt-outs end to end: the mail tools record, check and lift them; waiting commercial drafts are
// withdrawn; the send check refuses commercial mail to them at send; the list keeps no address;
// the person's and the member's data exports say what it holds.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import { z } from "zod"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import * as eventBusModule from "~/infra/events/event-bus"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import * as jobsModule from "~/infra/jobs/jobs"
import { decideApproval } from "~/modules/approvals/decide"
import * as withdrawModule from "~/modules/approvals/withdraw-on-events"
import { OPTED_OUT_REASON } from "~/modules/approvals/withdraw-on-events"
import { appBridgeManifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  PROSPECT_RETENTION_KIND,
  refreshProspectRetention,
} from "~/modules/contacts/prospect-retention"
import { deleteContact } from "~/modules/contacts/service"
import { buildDataSubjectBundle } from "~/modules/export/data-subject-export-tool"
import { readMemberSections } from "~/modules/export/member-data-subject-bundle"
import { footerLines } from "~/modules/mail/commercial-footer"
import {
  addSuppression,
  addSuppressionHash,
  hashEmail,
  lawfulBasisFacts,
  suppressedAmong,
} from "~/modules/mail/suppressions"
import { seedContext } from "~/seed/context"
import { seedApprovalRequests } from "~/seed/factories/approvals/requests"
import { insertSql } from "~/seed/factories/org/test-rows"
import { resolveContacts } from "~/seed/factories/people/contacts"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import {
  setTestCommercialIdentity,
  TEST_COMMERCIAL_IDENTITY,
} from "~/tests/helpers/commercial-identity"
import { createTestCompany } from "~/tests/helpers/company"
import { drainOutbox } from "~/tests/helpers/outbox"
import { recordProspect } from "~/tests/helpers/prospect"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { ensureMailAccount, seedMailConversation } from "../../../test-support/seed/mail"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})
const jobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "job-id" as never)

let orgId = ""
let userId = ""
let admin: UserContext
let threadId = ""
let account = ""
const sent: Array<Record<string, unknown>> = []
let counter = 0
const unique = (name: string) => `${name}-${++counter}@client.test`

type Envelope = Awaited<ReturnType<typeof executeToolCore>>

function call(toolName: string, params: Record<string, unknown>, actor: UserContext = admin) {
  return executeToolCore({ toolName, orgId, actor, params, threadId, origin: "in-app-agent" })
}

function resultOf(envelope: Envelope): Record<string, any> {
  if (!("data" in envelope)) throw new Error(`no result: ${JSON.stringify(envelope)}`)
  return envelope.data as Record<string, any>
}

/** A refusal the tool answered with: its code and message. */
function refusalOf(envelope: Envelope): { code: string; message: string } {
  if (!("error" in envelope)) throw new Error(`not refused: ${JSON.stringify(envelope)}`)
  return envelope.error as { code: string; message: string }
}

const blockedId = (envelope: Envelope): string => {
  if (!("blocked" in envelope)) throw new Error(`not staged: ${JSON.stringify(envelope)}`)
  return envelope.blocked.approvalRequestId as string
}

/** A commercial follow-up, or a service message about an invoice when `service` is set. */
async function stageCompose(to: string, service = false): Promise<string> {
  // Commercial mail goes only to someone with a recorded basis: one is recorded unless the test set its own.
  if (!service) {
    const [recorded] = await sql`SELECT 1 FROM kernel.contacts
      WHERE org_id = ${orgId} AND lower(email) = ${to.toLowerCase()} AND lawful_basis IS NOT NULL LIMIT 1`
    if (!recorded) await recordProspect(orgId, to)
  }
  const followUp = service
    ? { classification: "service", refs: [{ kind: "fixture:invoice", id: "1" }] }
    : {}
  return blockedId(
    await call("mail:compose", {
      accountId: account,
      to: [to],
      subject: "Checking in",
      textBody: "Any news on the order?",
      followUp,
    }),
  )
}

const approve = (requestId: string, actor: UserContext = admin) =>
  decideApproval({ orgId, requestId, actor, decision: "approve" })

async function approveSettled(requestId: string): Promise<void> {
  try {
    await approve(requestId)
  } catch {
    // The outcome is read from the rows.
  }
}

async function requestRow(requestId: string) {
  const [row] = await sql<Array<{ status: string; reason: string | null; summary: any }>>`
    SELECT status, reason, summary FROM kernel.approval_requests WHERE id = ${requestId}`
  if (!row) throw new Error("no request")
  return row
}

beforeAll(async () => {
  await acquireTestLock()
  await initSandboxPool()
  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  registerEventSubscribers({
    bufferAndBroadcast: async () => {},
    broadcast: async () => {},
    closeConnectionsForUser: () => {},
  } as never)
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  userId = a.userId
  admin = a.actor
  threadId = await minimal.thread(orgId, userId)
  await ensureAppsForOrg(orgId)
  await setTestCommercialIdentity(orgId)
  SandboxBridgeTestAccess.setSmtpSend(async (_connection, _identifier, message) => {
    sent.push(message as Record<string, unknown>)
    return { messageId: `<sent-${sent.length}@org.test>`, deliveryState: "delivered" }
  })
  const ctx = seedContext({ orgId, now: new Date() })
  account = (
    await ensureMailAccount(ctx, {
      ownerType: "org",
      userId,
      email: "sales@org.test",
      provider: "imap",
    })
  ).accountId
  // An invoice is a service record: mail about it is not commercial.
  appBridgeManifestRegistry.set([orgId, "fixture"], {
    name: "fixture",
    sendGuardProviders: { "fixture:invoice": { tool: "invoice_state", serviceMessage: true } },
  })
  toolRegistry.set([orgId, "fixture", "invoice_state"], {
    appName: "fixture",
    name: "invoice_state",
    description: "Fixture provider.",
    requiredScopes: ["fixture:read"],
    readOnly: true,
    params: z.object({ ref: z.object({ kind: z.string(), id: z.string() }) }),
    handler: async () => ({ stop: false }),
  })
  await drainOutbox()
}, 120_000)

afterAll(async () => {
  SandboxBridgeTestAccess.setSmtpSend(null)
  broadcastSpy.mockRestore()
  jobSpy.mockRestore()
  resetEventBus()
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("opt-outs", () => {
  it("adding a suppression withdraws pending commercial drafts to it and the guard refuses later sends, while a service message still goes", async () => {
    const to = unique("stop")
    const commercial = await stageCompose(to)
    const service = await stageCompose(to, true)
    const other = await stageCompose(unique("other"))

    const added = resultOf(await call("mail:suppression_add", { email: to }))
    expect(added.withdrawn).toBe(1)
    expect(added.message).toContain(`${to} is opted out of commercial mail`)
    expect(added.message).toContain("1 waiting commercial draft was withdrawn")
    expect(await requestRow(commercial)).toMatchObject({
      status: "cancelled",
      reason: OPTED_OUT_REASON,
    })
    expect((await requestRow(service)).status).toBe("pending")
    expect((await requestRow(other)).status).toBe("pending")

    // A later commercial draft to them is refused at stage.
    const later = await call("mail:compose", {
      accountId: account,
      to: [to],
      subject: "One more",
      textBody: "Still interested?",
      followUp: {},
    })
    expect("error" in later && later.error.code).toBe("SEND_GUARD_OPTED_OUT")

    // The service message goes.
    const before = sent.length
    await approve(service)
    expect(sent.length).toBe(before + 1)

    // Recording it again changes nothing and says so.
    const again = resultOf(await call("mail:suppression_add", { email: to.toUpperCase() }))
    expect(again.alreadyOptedOut).toBe(true)
    expect(again.message).toContain("Nothing changed")
  }, 90_000)

  it("an opt-out recorded elsewhere withdraws the waiting drafts through the registered event subscriber", async () => {
    const to = unique("event")
    const commercial = await stageCompose(to)
    // The request's own withdrawal is lost: the subscriber does it once the event is out.
    const spy = spyOn(withdrawModule, "withdrawCommercialDraftsOn").mockImplementationOnce(
      async () => [],
    )
    try {
      resultOf(await call("mail:suppression_add", { email: to, reason: "reply" }))
    } finally {
      spy.mockRestore()
    }
    expect((await requestRow(commercial)).status).toBe("pending")
    await drainOutbox()
    expect(await requestRow(commercial)).toMatchObject({
      status: "cancelled",
      reason: OPTED_OUT_REASON,
    })
  }, 90_000)

  it("two opt-outs of one address at once record it once, with one event", async () => {
    const to = unique("twice")
    const emailHash = hashEmail(orgId, to)
    const outcomes = await Promise.all(
      [0, 1].map(() => addSuppressionHash(null, { orgId, emailHash, reason: "link" })),
    )
    expect(outcomes.filter((o) => o.added)).toHaveLength(1)
    const [events] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.pending_events
       WHERE org_id = ${orgId} AND payload->>'entity' = 'suppression'
         AND payload->>'entityId' = ${emailHash}`
    expect(events?.n).toBe(1)
  })

  it("an opt-out whose caller's transaction rolls back withdraws no draft", async () => {
    const to = unique("rolled-back")
    const commercial = await stageCompose(to)
    await expect(
      withRlsContext(admin, async (tx) => {
        await addSuppression(tx as never, { orgId, email: to, reason: "person", createdBy: userId })
        throw new Error("the caller failed after recording it")
      }),
    ).rejects.toThrow("the caller failed after recording it")
    // Where the login cannot step into the admin role the opt-out commits on its own, with
    // its withdrawal; either way a draft is never withdrawn without the opt-out.
    const optedOut = (await suppressedAmong(orgId, [to])).length > 0
    expect((await requestRow(commercial)).status).toBe(optedOut ? "cancelled" : "pending")
  })

  it("a suppression survives the contact's erasure and a new contact with that address is suppressed", async () => {
    const email = unique("erased")
    const ctx = seedContext({ orgId, now: new Date() })
    const [[, first]] = (await resolveContacts(ctx, admin, [
      { key: "a", email, name: "Erased Person" },
    ])) as Array<[string, { id: string }]>
    resultOf(await call("mail:suppression_add", { email }))
    await withRlsContext(admin, (tx) => deleteContact(tx, { orgId, userId, contactId: first.id }))
    expect(await sql`SELECT 1 FROM kernel.contacts WHERE id = ${first.id}`).toHaveLength(0)
    const [[, second]] = (await resolveContacts(ctx, admin, [
      { key: "b", email, name: "Same Address" },
    ])) as Array<[string, { id: string }]>
    expect(second.id).not.toBe(first.id)
    expect(await suppressedAmong(orgId, [email])).toEqual([email])
    const later = await call("mail:compose", {
      accountId: account,
      to: [email],
      subject: "Hello again",
      textBody: "New offer",
      followUp: {},
    })
    expect("error" in later && later.error.code).toBe("SEND_GUARD_OPTED_OUT")
  }, 90_000)

  it("no stored value equals the address", async () => {
    const email = unique("Fingerprint")
    resultOf(await call("mail:suppression_add", { email, source: "msg-1" }))
    const rows = await sql<Array<{ row: string }>>`
      SELECT row_to_json(s)::text AS row FROM kernel.suppressions s WHERE org_id = ${orgId}`
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.row.toLowerCase()).not.toContain(email.toLowerCase())
      expect(r.row.toLowerCase()).not.toContain("@client.test")
    }
    expect(rows.some((r) => r.row.includes(hashEmail(orgId, email)))).toBe(true)
    // A source carrying an address is refused.
    const refused = refusalOf(
      await call("mail:suppression_add", { email: unique("src"), source: "someone@client.test" }),
    )
    expect(refused.code).toBe("invalid_params")
    expect(refused.message).toContain("Nothing was recorded")
  }, 90_000)

  it("bulk approval of five follow-ups with one suppressed sends four and fails one with no effect", async () => {
    const people = [1, 2, 3, 4, 5].map(() => unique("bulk"))
    const ids: string[] = []
    for (const to of people) ids.push(await stageCompose(to))
    // The opt-out lands with its withdrawal lost, so the check at send is what stops it.
    const spy = spyOn(withdrawModule, "withdrawCommercialDraftsOn").mockImplementation(
      async () => [],
    )
    try {
      resultOf(await call("mail:suppression_add", { email: people[2] }))
    } finally {
      spy.mockRestore()
    }
    const before = sent.length
    for (const id of ids) await approveSettled(id)
    expect(sent.length).toBe(before + 4)
    const recipients = sent.slice(before).map((m) => JSON.stringify(m))
    expect(recipients.some((m) => m.includes(people[2] as string))).toBe(false)
    const stopped = await requestRow(ids[2] as string)
    expect(stopped.status).toBe("cancelled")
    const [execution] = await sql<Array<{ status: string; error: any }>>`
      SELECT status, error FROM kernel.approved_handler_executions
       WHERE approval_request_id = ${ids[2] as string}`
    expect(execution?.status).toBe("failed_no_effect")
    expect(execution?.error?.code).toBe("send_guard_opted_out")
  }, 120_000)

  it("removing a suppression parks with who opted out and when, and approving lets the guard pass", async () => {
    const email = unique("lift")
    resultOf(await call("mail:suppression_add", { email }))
    const parked = await call("mail:suppression_remove", { email })
    const id = blockedId(parked)
    const card = await requestRow(id)
    const lines = JSON.stringify(card.summary)
    expect(lines).toContain(`Let ${email} receive commercial mail again`)
    expect(lines).toMatch(/Opted out on \d{1,2} [A-Z][a-z]{2} \d{4}, by /)
    expect(await suppressedAmong(orgId, [email])).toEqual([email])
    await approve(id)
    expect(await suppressedAmong(orgId, [email])).toEqual([])
    const staged = await stageCompose(email)
    expect((await requestRow(staged)).status).toBe("pending")
  }, 90_000)

  it("lifting an address that never opted out is answered at once and parks nothing", async () => {
    const email = unique("never")
    const before = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${orgId}`
    const refused = refusalOf(await call("mail:suppression_remove", { email }))
    expect(refused.message).toBe(
      `${email} has not opted out, so there is nothing to lift. Nothing was staged.`,
    )
    const after = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.approval_requests WHERE org_id = ${orgId}`
    expect(after[0]?.n).toBe(before[0]?.n)
  }, 90_000)

  it("the check answers 50 addresses and refuses 51", async () => {
    const fifty = Array.from({ length: 50 }, () => unique("many"))
    resultOf(await call("mail:suppression_add", { email: fifty[7] }))
    const ok = resultOf(await call("mail:suppression_check", { emails: fifty }))
    expect(ok.checked).toBe(50)
    expect(ok.results.filter((r: { optedOut: boolean }) => r.optedOut)).toHaveLength(1)
    expect(ok.message).toContain(`1 of 50 opted out: ${fifty[7]}`)
    const refused = refusalOf(
      await call("mail:suppression_check", { emails: [...fifty, unique("one-more")] }),
    )
    expect(refused.code).toBe("too_many_addresses")
    expect(refused.message).toContain("Nothing was checked")
  }, 90_000)

  it("the check refuses an agent without the opt-out list's scope and names it", async () => {
    const email = unique("reason")
    resultOf(await call("mail:suppression_add", { email, reason: "reply", source: "msg-9" }))
    const full = resultOf(await call("mail:suppression_check", { emails: [email] }))
    expect(full.results[0]).toMatchObject({ optedOut: true, by: "reply" })
    expect(full.results[0].line).toContain("by a reply asking to stop")
    const limited: UserContext = {
      ...admin,
      scopes: ["mail:conversations:read", "mail:conversations:write"],
    }
    const refused = await call("mail:suppression_check", { emails: [email] }, limited)
    expect("data" in refused).toBe(false)
    expect(refusalOf(refused).message).toContain("mail:suppressions:read")
  }, 90_000)

  it("approving a reply's proposal adds the suppression, by a seeded admin with no fixture grant", async () => {
    const email = unique("proposal")
    const ctx = seedContext({ orgId, now: new Date() })
    const [id] = await seedApprovalRequests(ctx, [
      {
        id: crypto.randomUUID(),
        handle: `AP-${counter}`,
        threadId,
        toolName: "mail:suppression_add",
        payload: { email, reason: "reply", source: "msg-proposal" },
        requestedBy: userId,
        agentId: null,
        notifyUserIds: [userId],
        status: "pending",
        createdAt: new Date(),
      },
    ])
    // The org's own admin, from its default roles: no scope added by this test.
    expect(admin.scopes).not.toContain("mail:conversations:write")
    await approve(id as string)
    expect(await suppressedAmong(orgId, [email])).toEqual([email])
    const [row] = await sql<Array<{ reason: string; source: string }>>`
      SELECT reason, source FROM kernel.suppressions
       WHERE org_id = ${orgId} AND email_hash = ${hashEmail(orgId, email)}`
    expect(row).toMatchObject({ reason: "reply", source: "msg-proposal" })
  }, 90_000)

  it("a contact's export says when and how they opted out", async () => {
    const email = unique("export")
    const ctx = seedContext({ orgId, now: new Date() })
    const [[, contact]] = (await resolveContacts(ctx, admin, [
      { key: "x", email, name: "Exported Person" },
    ])) as Array<[string, { id: string }]>
    const before = await withRlsContext(admin, (tx) =>
      buildDataSubjectBundle(contact.id, { orgId, userId, db: tx }),
    )
    expect("subject" in before && before.subject.optedOut).toBeNull()
    resultOf(await call("mail:suppression_add", { email, reason: "reply" }))
    const bundle = await withRlsContext(admin, (tx) =>
      buildDataSubjectBundle(contact.id, { orgId, userId, db: tx }),
    )
    if (!("subject" in bundle)) throw new Error(JSON.stringify(bundle))
    expect(bundle.subject.optedOut?.by).toBe("reply")
    expect(bundle.subject.optedOut?.line).toMatch(
      /^Opted out on \d{1,2} [A-Z][a-z]{2} \d{4}, by a reply asking to stop\.$/,
    )
  }, 90_000)

  it("a member's bundle lists the suppressions they added", async () => {
    const sections = await withRlsContext(admin, (tx) =>
      readMemberSections(tx, { orgId, subjectUserId: userId }),
    )
    const added = sections.suppressionsAdded
    expect(added?.rows.length).toBeGreaterThan(3)
    for (const r of added?.rows ?? []) {
      expect(Object.keys(r).sort()).toEqual(["created_at", "reason"])
      expect(JSON.stringify(r)).not.toContain("@")
    }
    expect(added?.note).toContain("not kept")
  }, 90_000)
})

describe("lawful basis, notice, record and retention", () => {
  const sha = (v: string) => createHash("sha256").update(v).digest("hex")

  async function sendFollowUp(to: string): Promise<Record<string, unknown>> {
    const before = sent.length
    await approve(await stageCompose(to))
    expect(sent.length).toBe(before + 1)
    return sent[sent.length - 1] as Record<string, unknown>
  }

  it("a new message to a contact with an enrichment source and no basis is refused for no basis", async () => {
    const to = unique("enriched")
    await recordProspect(orgId, to, { lawfulBasis: null, dataSource: "enrichment" })
    const refusal = refusalOf(
      await call("mail:compose", {
        accountId: account,
        to: [to],
        subject: "Hello",
        textBody: "We make studio monitors you may like.",
      }),
    )
    expect(refusal.message).toContain(`No lawful basis is recorded for ${to}`)
    expect(refusal.message).toContain("Nothing was sent")
  })

  it("a contact at its company's business domain with no recorded consumer status counts as a business, and the agent's commercial mail to it is staged", async () => {
    const to = unique("dealer")
    const contactId = await recordProspect(orgId, to, { lawfulBasis: "customer", isConsumer: null })
    const companyId = await createTestCompany(orgId, `Dealer ${counter}`, "client.test")
    await sql`UPDATE kernel.contacts SET company_id = ${companyId} WHERE id = ${contactId}`
    const staged = await call("mail:compose", {
      accountId: account,
      to: [to],
      subject: "New preamp range",
      textBody: "We make studio monitors you may like.",
      followUp: {},
    })
    expect(blockedId(staged)).toBeTruthy()
  })

  it("a contact on no company with no recorded consumer status still counts as a consumer, and the refusal says how to change that", async () => {
    const to = unique("unlinked")
    await recordProspect(orgId, to, { lawfulBasis: "customer", isConsumer: null })
    const refusal = refusalOf(
      await call("mail:compose", {
        accountId: account,
        to: [to],
        subject: "New preamp range",
        textBody: "We make studio monitors you may like.",
        followUp: {},
      }),
    )
    expect(refusal.message).toContain("Nothing was sent")
    expect(refusal.message).toContain(`Whether ${to} is a consumer is not recorded`)
    expect(refusal.message).toContain("records that they are a business")
  })

  for (const [what, address, companyDomain] of [
    ["a company with no domain", "client.test", null],
    ["a company on another domain", "client.test", "other-maker.test"],
    ["a company recorded on a free mail domain", "hotmail.fr", "hotmail.fr"],
    ["a company on a business domain, from a free mail address", "gmail.com", "client.test"],
  ] as const) {
    it(`a contact with no recorded consumer status linked to ${what} still counts as a consumer, and commercial mail to it is refused`, async () => {
      const to = `linked-${++counter}-${crypto.randomUUID().slice(0, 6)}@${address}`
      const contactId = await recordProspect(orgId, to, {
        lawfulBasis: "customer",
        isConsumer: null,
      })
      const companyId = await createTestCompany(orgId, `Linked ${counter}`, companyDomain)
      await sql`UPDATE kernel.contacts SET company_id = ${companyId} WHERE id = ${contactId}`
      const facts = await lawfulBasisFacts(orgId, [to])
      expect(facts.recipients.map((r) => r.isConsumer)).toEqual([null])
      const refusal = refusalOf(
        await call("mail:compose", {
          accountId: account,
          to: [to],
          subject: "New preamp range",
          textBody: "We make studio monitors you may like.",
          followUp: {},
        }),
      )
      expect(refusal.message).toContain("Nothing was sent")
      expect(refusal.message).toContain(`Whether ${to} is a consumer is not recorded`)
    })
  }

  it("a recorded consumer status wins over any company link", async () => {
    const business = unique("recorded-business")
    const consumer = unique("recorded-consumer")
    const companyId = await createTestCompany(orgId, `Recorded ${counter}`, "client.test")
    for (const [to, isConsumer] of [
      [business, false],
      [consumer, true],
    ] as const) {
      const contactId = await recordProspect(orgId, to, { lawfulBasis: "customer", isConsumer })
      await sql`UPDATE kernel.contacts SET company_id = ${companyId} WHERE id = ${contactId}`
    }
    const facts = await lawfulBasisFacts(orgId, [business, consumer])
    expect(facts.recipients.map((r) => [r.email, r.isConsumer])).toEqual([
      [business, false],
      [consumer, true],
    ])
  })

  it("with no recorded country, the contact's first address with a country gives it, and a recorded country wins", async () => {
    // Mutation caught: the send check read only the recorded country, so no seeded contact had one.
    const address = async (
      contactId: string,
      country: string,
      extra: Record<string, unknown> = {},
    ) =>
      sql.unsafe(
        insertSql("kernel.contact_addresses", {
          id: crypto.randomUUID(),
          org_id: orgId,
          contact_id: contactId,
          role: "delivery",
          city: "Somewhere",
          country_iso2: country,
          ...extra,
        } as never),
      )
    const fromAddress = unique("address-country")
    const first = await recordProspect(orgId, fromAddress, { recipientCountry: null })
    // An archived or stale address says nothing of where they are now.
    await address(first, "DE", { archived_at: new Date().toISOString() })
    await address(first, "IT", { stale_at: new Date().toISOString() })
    await address(first, "ES", { role: "other" })
    await address(first, "fr", { role: "billing" })
    const recorded = unique("recorded-country")
    const second = await recordProspect(orgId, recorded, { recipientCountry: "BE" })
    await address(second, "FR")
    const none = unique("no-country")
    await recordProspect(orgId, none, { recipientCountry: null })
    const facts = await lawfulBasisFacts(orgId, [fromAddress, recorded, none])
    expect(facts.recipients.map((r) => [r.email, r.countries])).toEqual([
      [fromAddress, ["FR"]],
      [recorded, ["BE"]],
      [none, []],
    ])
  })

  it("every commercial send records approver, text hash, basis, classification and check", async () => {
    const to = unique("recorded")
    const contactId = await recordProspect(orgId, to)
    const message = await sendFollowUp(to)
    const rows = await sql<
      Array<{ actor_id: string | null; entity_id: string | null; metadata: any }>
    >`
      SELECT actor_id::text AS actor_id, entity_id::text AS entity_id, metadata FROM kernel.audit_log
       WHERE org_id = ${orgId} AND action = 'mail.commercial_send'
         AND metadata ->> 'recipientHash' = ${hashEmail(orgId, to)}`
    expect(rows).toHaveLength(1)
    const meta = rows[0]?.metadata
    expect(rows[0]?.entity_id).toBe(contactId)
    expect(meta.approvedBy).toBe("approver")
    expect(meta.approverId).toBe(userId)
    // The hash is of the approved text with its footer, as it leaves the check (before the
    // mail's own rendering of that text).
    const url = String(message.textBody).match(
      /https?:\/\/[^\s"<>]+\/public\/opt-out\/[A-Za-z0-9_-]{43}/,
    )?.[0]
    expect(url).toBeDefined()
    const final = `Any news on the order?\n\n--\n${footerLines(TEST_COMMERCIAL_IDENTITY, url as string).join("\n")}\n`
    expect(meta.textSha256).toBe(sha(final))
    expect(meta.lawfulBasis).toBe("professional_interest")
    expect(meta.classification).toBe("marketing")
    expect(meta.suppressionCheck).toBe("not_opted_out")
    expect(JSON.stringify(rows)).not.toContain(to)
  })

  it("the first commercial message to a third-party contact carries the notice and the second does not", async () => {
    const to = unique("third-party")
    await recordProspect(orgId, to, { dataSource: "third_party" })
    const first = await sendFollowUp(to)
    expect(String(first.textBody)).toContain("received your address from a third party")
    const [row] = await sql<Array<{ at: string | null }>>`
      SELECT art14_notice_at::text AS at FROM kernel.contacts WHERE org_id = ${orgId} AND lower(email) = ${to}`
    expect(row?.at).not.toBeNull()
    const second = await sendFollowUp(to)
    expect(String(second.textBody)).not.toContain("your address")
    // A contact whose address they gave themselves gets no notice at all.
    const direct = unique("direct")
    await recordProspect(orgId, direct, { dataSource: "direct" })
    expect(String((await sendFollowUp(direct)).textBody)).not.toContain("your address")
  })

  it("a contact with no recorded source gets the notice", async () => {
    const to = unique("no-source")
    await recordProspect(orgId, to, { dataSource: null })
    const message = await sendFollowUp(to)
    expect(String(message.textBody)).toContain("If you did not give us your address yourself")
    expect(String(message.htmlBody)).toContain("If you did not give us your address yourself")
  })

  it("one retention item per org lists prospects silent for three years", async () => {
    const now = new Date()
    const ago = (days: number, years = 0) => {
      const d = new Date(now)
      d.setUTCFullYear(d.getUTCFullYear() - years)
      d.setUTCDate(d.getUTCDate() - days)
      return d.toISOString()
    }
    const recent = unique("wrote-recently")
    const silent = unique("silent")
    const never = unique("never-wrote")
    const fresh = unique("just-added")
    const ids: Record<string, string> = {}
    for (const email of [recent, silent, never, fresh])
      ids[email] = await recordProspect(orgId, email)
    for (const email of [recent, silent, never]) {
      await sql`UPDATE kernel.contacts SET created_at = ${ago(0, 5)} WHERE id = ${ids[email] as string}`
    }
    const ctx = seedContext({ orgId, now })
    // Two years and 364 days ago: still within the three years.
    const lastWrote = { [recent]: ago(-1, 3), [silent]: ago(1, 3) }
    for (const [email, sentAt] of Object.entries(lastWrote)) {
      await seedMailConversation(ctx, {
        accountId: account,
        subject: "Order",
        status: "open",
        labels: [],
        isRead: true,
        isStarred: false,
        contactId: ids[email] as string,
        messages: [
          {
            direction: "inbound",
            from: { email },
            to: [{ email: "sales@org.test" }],
            textBody: "Thanks",
            sentAt,
          },
        ],
      })
    }
    const refresh = () =>
      withPrivilegedDb(orgId, "test-prospect-retention", (tx) =>
        refreshProspectRetention(tx, orgId, now),
      )
    await refresh()
    await refresh()
    const rows = await sql<Array<{ summary: string; metadata: any }>>`
      SELECT summary, metadata FROM kernel.attention_events
       WHERE org_id = ${orgId} AND user_id = ${userId} AND kind = ${PROSPECT_RETENTION_KIND}
         AND read_at IS NULL`
    expect(rows).toHaveLength(1)
    const listed: string[] = rows[0]?.metadata.contactIds
    expect(listed).toContain(ids[silent])
    expect(listed).toContain(ids[never])
    expect(listed).not.toContain(ids[recent])
    expect(listed).not.toContain(ids[fresh])
    expect(rows[0]?.summary).toContain("3 years")
    // Nobody left silent: the row goes.
    await sql`UPDATE kernel.contacts SET lawful_basis = 'consent'
               WHERE org_id = ${orgId} AND lawful_basis = 'professional_interest'`
    await refresh()
    const [left] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.attention_events
       WHERE org_id = ${orgId} AND kind = ${PROSPECT_RETENTION_KIND} AND read_at IS NULL`
    expect(left?.n).toBe(0)
  })
})
