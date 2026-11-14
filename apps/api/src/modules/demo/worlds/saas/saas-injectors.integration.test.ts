// SPDX-License-Identifier: FSL-1.1-ALv2
// The software world's live events: each writes its fixed content once per run
// through the product's own path, bound to its world, on a demo org of that
// world; the fixture pages answer in process for a demo org only.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { KERNEL_DECLARED_EMITS } from "~/infra/events/event-bus"
import { declaredEmits } from "~/modules/apps/app-registries"
import { markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { RECORDING, recordingOf } from "~/modules/demo/replay/replay"
import { worldInjectors } from "~/modules/demo/world/registry"
import { demoWebFetchFixture } from "~/modules/demo/world/web-fetch-fixture"
import { seedContext } from "~/seed/context"
import { insertUnarmedMail } from "~/seed/factories/mail/conversations"
import { seedUserRow } from "~/seed/factories/org/rows"
import { ensureTicketInboxes } from "~/seed/factories/support/inboxes"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { SAAS_CHAT_CHANNEL, saasChatQuestionInjector } from "./chat-question"
import { saasSalesEmailInjector } from "./sales-email"
import { SAAS_SUPPORT_SUBJECT, saasSupportTicketInjector } from "./support-ticket"
import { SAAS_TRENDS_URL } from "./web-fixture"

let priorKernelEmits: Set<string> | undefined
let demoOrg: string
let plainOrg: string
let owner: string

async function addUser(orgId: string, name: string): Promise<string> {
  const id = crypto.randomUUID()
  return seedUserRow({ id, orgId, email: `inj-${id}@test.com`, name })
}

const ctxOf = (over: Partial<{ run: number; beatId: string; tourId: string }> = {}) => ({
  orgId: demoOrg,
  ownerUserId: owner,
  tourId: over.tourId ?? "kernel.scenario-saas-chat",
  beatId: over.beatId ?? "question",
  run: over.run ?? 0,
  runStartedAt: new Date(Date.now() - 60_000),
})

beforeAll(async () => {
  priorKernelEmits = declaredEmits.get("kernel")
  declaredEmits.set("kernel", new Set(KERNEL_DECLARED_EMITS))
  demoOrg = (await createTestOrg()).id
  await markOrgAsDemo(demoOrg, visitorMarker(24, new Date(), undefined, { worldId: "saas" }))
  plainOrg = (await minimal.secondOrg()).orgId
  owner = await addUser(demoOrg, "Visitor")
  await addUser(demoOrg, "Lucie Vasseur")
})

afterAll(() => {
  if (priorKernelEmits) declaredEmits.set("kernel", priorKernelEmits)
  else declaredEmits.delete("kernel")
})

describe("the software world's injectors", () => {
  it("every one is registered, bound to its world and listed once", () => {
    const registry = worldInjectors()
    for (const id of [
      "saas-support-ticket",
      "saas-projects-comment",
      "saas-chat-question",
      "saas-sales-email",
      "saas-knowledge-asks",
    ]) {
      expect(registry.get(id)?.world, id).toBe("saas")
    }
    // The agent-turn ones wait for a confirmed email; the chat question and the
    // projects comment run no model of their own.
    expect(registry.get("saas-support-ticket")?.spends).toBe(true)
    expect(registry.get("saas-sales-email")?.spends).toBe(true)
    expect(registry.get("saas-knowledge-asks")?.spends).toBe(true)
  })

  it("the chat question opens the channel with the visitor and asks once, pointing at a fictional page", async () => {
    const ctx = ctxOf()
    await saasChatQuestionInjector.injectWorldEvent(ctx)
    await saasChatQuestionInjector.injectWorldEvent(ctx)
    const threads = await sql`SELECT id FROM kernel.threads
      WHERE org_id = ${demoOrg} AND title = ${SAAS_CHAT_CHANNEL}`
    expect(threads).toHaveLength(1)
    const threadId = threads[0]?.id as string
    const msgs = await sql`SELECT content FROM kernel.messages WHERE thread_id = ${threadId}`
    expect(msgs).toHaveLength(1)
    expect(String(msgs[0]?.content)).toContain(SAAS_TRENDS_URL)
    expect(await saasChatQuestionInjector.entityOf?.(ctx)).toBe(threadId)
    const seats =
      await sql`SELECT user_id FROM kernel.thread_participants WHERE thread_id = ${threadId}`
    expect(seats.map((s) => s.user_id)).toContain(owner)
  })

  it("the sales email is one inbound message from the group in the shared mailbox, once per run", async () => {
    const [accountId] = (
      await insertUnarmedMail(seedContext({ orgId: demoOrg, now: new Date() }), {
        domain: "tideform.example",
        mailboxes: [
          {
            box: "sales",
            ownerUserId: null,
            email: "sales@tideform.example",
            displayName: "Sales",
          },
        ],
        conversations: [],
      })
    ).accountIds as [string]
    const ctx = ctxOf({ tourId: "kernel.scenario-saas-sales", beatId: "live-email" })
    await saasSalesEmailInjector.injectWorldEvent(ctx)
    await saasSalesEmailInjector.injectWorldEvent(ctx)
    const msgs = await sql`SELECT from_address FROM app_mail.messages
      WHERE org_id = ${demoOrg} AND account_id = ${accountId}`
    expect(msgs).toHaveLength(1)
    const events = await sql`SELECT payload FROM kernel.pending_events
      WHERE payload->>'app' = 'mail' AND payload->>'entity' = 'message'
        AND payload->>'action' = 'create' AND org_id = ${demoOrg}`
    expect(events).toHaveLength(1)
    const payload = events[0]?.payload as { data: Record<string, unknown> }
    const data = payload.data
    expect(data).toMatchObject({
      direction: "inbound",
      from: { email: "helene.marchand@residence-olympe.example" },
    })
    expect(await saasSalesEmailInjector.entityOf?.(ctx)).toBe(data.conversationId as string)
    // The second run delivers its own email, never the first one again.
    const next = { ...ctx, run: 1 }
    await saasSalesEmailInjector.injectWorldEvent(next)
    expect(
      await sql`SELECT id FROM app_mail.messages WHERE org_id = ${demoOrg} AND account_id = ${accountId}`,
    ).toHaveLength(2)
  })

  it("the support ticket is one ticket per run, never the old one again", async () => {
    await ensureTicketInboxes(
      seedContext({ orgId: demoOrg, now: new Date() }),
      owner,
      [{ name: "Support", team: "support" }],
      {
        fromDisplayName: "Support",
        replyFromEmail: "support@tideform.example",
        slaPromisePhrase: "within a day",
      },
    )
    const ctx = ctxOf({ tourId: "kernel.scenario-saas-support", beatId: "live-ticket" })
    await saasSupportTicketInjector.injectWorldEvent(ctx)
    await saasSupportTicketInjector.injectWorldEvent(ctx)
    const first = await saasSupportTicketInjector.entityOf?.(ctx)
    expect(first).toBeTruthy()
    const next = { ...ctx, run: 1 }
    expect(await saasSupportTicketInjector.entityOf?.(next)).toBeNull()
    await saasSupportTicketInjector.injectWorldEvent(next)
    const second = await saasSupportTicketInjector.entityOf?.(next)
    expect(second).toBeTruthy()
    expect(second).not.toBe(first)
    expect(
      await sql`SELECT id FROM app_tickets.tickets
        WHERE org_id = ${demoOrg} AND subject = ${SAAS_SUPPORT_SUBJECT}`,
    ).toHaveLength(2)
  })

  it("the recorded coding session an org plays is its world's", async () => {
    const saas = await recordingOf(demoOrg)
    expect(saas).not.toBe(RECORDING)
    expect(saas.title).toContain("payroll export")
    expect(await recordingOf(plainOrg)).toBe(RECORDING)
  })

  it("the fictional pages answer for a demo org only, in process", async () => {
    const trends = await demoWebFetchFixture(demoOrg, SAAS_TRENDS_URL)
    expect(trends?.status).toBe(200)
    expect(trends?.body).toContain("fictional")
    const site = await demoWebFetchFixture(demoOrg, "https://residence-olympe.example/")
    expect(site?.body).toContain("Résidence Olympe")
    expect(await demoWebFetchFixture(plainOrg, SAAS_TRENDS_URL)).toBeNull()
    expect(await demoWebFetchFixture(demoOrg, "https://example.org/")).toBeNull()
  })
})
