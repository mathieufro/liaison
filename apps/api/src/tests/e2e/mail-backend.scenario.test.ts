// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { allocatePorts, api, createUserWithScopes } from "@liaison/test-helpers"
import { Queue } from "bullmq"
import {
  queryConversations,
  queryMessages,
  seedContact,
  seedConversation,
  seedConversationWithMessages,
  seedMessage,
  setAppConfig,
} from "./helpers/mail-seed"
import { startMockOidc } from "./helpers/mock-oidc"
import { setupScenario, teardownScenario } from "./setup"

/**
 * Waits until the mail app's queue holds a job of `name` whose payload matches,
 * in any state. A job id is a deduplication id that the queue releases once the
 * job finishes, and the job's own key carries a minted id, so a key-name scan
 * misses a job a quick worker already ran: the queue's job lists do not.
 */
async function waitForMailJob(
  env: WorkerEnv,
  name: string,
  matches: (data: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<boolean> {
  const queue = new Queue("app-mail", {
    connection: env.redis.redis,
    prefix: `${env.redisPrefix ?? ""}bull`,
  })
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const jobs = await queue.getJobs([
        "waiting",
        "prioritized",
        "delayed",
        "active",
        "completed",
        "failed",
      ])
      if (jobs.some((j) => j?.name === name && matches((j.data ?? {}) as Record<string, unknown>)))
        return true
      await Bun.sleep(100)
    }
    return false
  } finally {
    await queue.close()
  }
}

// ─── Helpers ───

function ks(env: WorkerEnv) {
  return env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
}

function ms(env: WorkerEnv) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
}

async function patchOAuthState(env: WorkerEnv, state: string, oidcPort: number) {
  const redisPrefix = env.redisPrefix ?? ""
  const key = `${redisPrefix}oauth:state:${state}`
  const raw = await env.redis.redis.get(key)
  if (!raw) throw new Error("OAuth state not found in Redis")
  const parsed = JSON.parse(raw)
  parsed.tokenUrl = `http://localhost:${oidcPort}/token`
  const ttl = await env.redis.redis.ttl(key)
  await env.redis.redis.set(key, JSON.stringify(parsed), "EX", ttl > 0 ? ttl : 900)
}

async function waitForExtensionRow(
  env: WorkerEnv,
  where: string,
  timeoutMs = 5000,
): Promise<Record<string, any>> {
  const schema = ms(env)
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const rows = await env.db.sql.unsafe(`SELECT * FROM ${schema}.accounts WHERE ${where} LIMIT 1`)
    if (rows.length > 0) return rows[0]
    await Bun.sleep(200)
  }
  throw new Error(`Extension row not found within ${timeoutMs}ms: ${where}`)
}

async function doGmailOAuthFlow(
  url: string,
  token: string,
  env: WorkerEnv,
  oidcPort: number,
  opts?: { ownerType?: "org"; loginHint?: string },
): Promise<{ kernelId: string; extensionRow: Record<string, any> }> {
  const authRes = await api(url, "/api/connections/mail/gmail/authorize", {
    token,
    body: opts?.ownerType ? { mode: opts.ownerType } : {},
  })
  expect(authRes.status).toBe(200)
  const redirectUrl = new URL(authRes.body.data.redirectUrl)
  const state = redirectUrl.searchParams.get("state")!

  await patchOAuthState(env, state, oidcPort)

  const callbackUri = `${url}/api/connections/callback`
  const email = opts?.loginHint ?? "gmail-user@e2e.test"
  const oidcAuthUrl = `http://localhost:${oidcPort}/authorize?state=${state}&redirect_uri=${encodeURIComponent(callbackUri)}&login_hint=${encodeURIComponent(email)}`
  const oidcRes = await fetch(oidcAuthUrl, { redirect: "manual" })
  const oidcLocation = oidcRes.headers.get("location")!
  const cbUrl = new URL(oidcLocation)
  const code = cbUrl.searchParams.get("code")!

  // The callback must come from the browser that started the flow: it carries
  // the binding cookie the authorize response set.
  const cbRes = await fetch(`${url}/api/connections/callback?code=${code}&state=${state}`, {
    redirect: "manual",
    headers: { cookie: (authRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "" },
  })
  expect(cbRes.status).toBe(302)

  const extensionRow = await waitForExtensionRow(
    env,
    `email_address = '${email}' AND sync_status != 'disconnected'`,
  )

  const kernelSchema = ks(env)
  const [kernelRow] = await env.db.sql.unsafe(
    `SELECT id FROM ${kernelSchema}.connected_accounts WHERE identifier = '${email}' AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
  )

  return { kernelId: kernelRow.id, extensionRow }
}

function isoDate(offset: number): string {
  return new Date(Date.now() + offset).toISOString()
}

async function grantInboxDimension(env: WorkerEnv, userId: string, accountIds: string[]) {
  const k = ks(env)
  const [membership] = await env.db.sql.unsafe(
    `SELECT role_id FROM ${k}.user_roles WHERE user_id = '${userId}' LIMIT 1`,
  )
  await env.db.sql.unsafe(
    `INSERT INTO ${k}.role_dimension_grants (role_id, dimension_key, dimension_values)
     VALUES ($1, $2, $3)
     ON CONFLICT (role_id, dimension_key) DO UPDATE SET dimension_values = $3`,
    [membership.role_id, "mail:inbox", JSON.stringify(accountIds)],
  )
  await env.db.sql.unsafe(
    `UPDATE ${k}.users SET permission_version = permission_version + 1 WHERE id = $1`,
    [userId],
  )
}

async function reloginUser(url: string, email: string): Promise<string> {
  const loginRes = await api(url, "/api/auth/login", {
    body: { email, password: "Pass1234!" },
  })
  return loginRes.body.data.accessToken
}

async function setGmailProviderEnabled(url: string, token: string, enabled: boolean) {
  const res = await api(url, "/api/mail/providers/gmail", {
    token,
    method: "PATCH",
    body: { enabled },
  })

  expect(res.status).toBe(200)
  expect(res.body.data.enabled).toBe(enabled)
}

// ─── Test Suite ───

describe("Mail Backend Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let oidc: Awaited<ReturnType<typeof startMockOidc>>
  let oidcPort: number

  let adminToken: string
  let orgId: string
  let adminId: string

  // Shared account state seeded during beforeAll
  let personalAccountRow: Record<string, any>
  let orgAccountRow: Record<string, any>

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 20,
      org: { name: "Mail Backend E2E" },
      populate: {
        users: { count: 10 },
        threads: { count: 20, participants: "random(2-4)", messages: "random(1-3)" },
      },
      serverEnv: {
        GMAIL_OAUTH_CLIENT_ID: "api-backend-gmail-client-id",
        GMAIL_OAUTH_CLIENT_SECRET: "api-backend-gmail-client-secret",
        // The S10 push tests drive the static-token fallback, which is opt-in.
        ALLOW_INSECURE_PUSH: "true",
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    adminToken = world.admin.token
    orgId = world.org.id
    adminId = world.admin.id

    // Start mock OIDC
    const [port] = await allocatePorts(1)
    oidcPort = port
    oidc = await startMockOidc(oidcPort)

    await setGmailProviderEnabled(url, adminToken, true)

    // Connect personal Gmail account for admin
    const personalResult = await doGmailOAuthFlow(url, adminToken, env, oidcPort, {
      loginHint: "admin-personal@gmail.e2e.test",
    })
    personalAccountRow = personalResult.extensionRow

    // Connect org-level Gmail account
    const orgResult = await doGmailOAuthFlow(url, adminToken, env, oidcPort, {
      ownerType: "org",
      loginHint: "org-shared@company.e2e.test",
    })
    orgAccountRow = orgResult.extensionRow
  }, 180_000)

  afterAll(async () => {
    if (oidc) oidc.stop()
    if (env && world) await teardownScenario(env, world)
    else if (env) await env.teardown()
  }, 15_000)

  // ════════════════════════════════════════════════════════════════════════
  //  S1: Smoke — mail routes respond with empty mail data
  // ════════════════════════════════════════════════════════════════════════

  describe("S1: Smoke", () => {
    it("gmail OAuth bootstrap succeeds without a mail:gmail oauth_providers row", async () => {
      const oauthProviderRows = await env.db.sql.unsafe(
        `SELECT id FROM ${ks(env)}.oauth_providers WHERE name = 'mail:gmail'`,
      )

      expect(oauthProviderRows.length).toBe(0)
      expect(personalAccountRow.provider).toBe("gmail")
      expect(orgAccountRow.provider).toBe("gmail")
    })

    it("conversations endpoint returns empty list on realistic baseline", async () => {
      const res = await api(url, "/api/mail/conversations", { token: adminToken })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
      expect(res.body.meta.nextCursor).toBeNull()
      expect(res.body.meta.total).toBe(0)
    })

    it("contacts query returns empty for nonexistent", async () => {
      const res = await api(url, "/api/contacts?query=nonexistent", { token: adminToken })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([])
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  S2: Conversation listing with pagination and filters
  // ════════════════════════════════════════════════════════════════════════

  describe("S2: Conversation listing with pagination and filters", () => {
    const convIds: string[] = []

    beforeAll(async () => {
      // Seed 8 conversations: mix of open/archived, read/unread, starred/unstarred
      const configs = [
        {
          subject: "Conv 1 Open Unread",
          status: "open",
          isRead: false,
          isStarred: false,
          lastMessageAt: isoDate(-8000),
        },
        {
          subject: "Conv 2 Open Read",
          status: "open",
          isRead: true,
          isStarred: false,
          lastMessageAt: isoDate(-7000),
        },
        {
          subject: "Conv 3 Open Starred",
          status: "open",
          isRead: false,
          isStarred: true,
          lastMessageAt: isoDate(-6000),
        },
        {
          subject: "Conv 4 Open Read Starred",
          status: "open",
          isRead: true,
          isStarred: true,
          lastMessageAt: isoDate(-5000),
        },
        {
          subject: "Conv 5 Open Unread",
          status: "open",
          isRead: false,
          isStarred: false,
          lastMessageAt: isoDate(-4000),
        },
        {
          subject: "Conv 6 Archived",
          status: "archived",
          isRead: true,
          isStarred: false,
          lastMessageAt: isoDate(-3000),
        },
        {
          subject: "Conv 7 Archived Starred",
          status: "archived",
          isRead: false,
          isStarred: true,
          lastMessageAt: isoDate(-2000),
        },
        {
          subject: "Conv 8 Open Assigned",
          status: "open",
          isRead: false,
          isStarred: false,
          lastMessageAt: isoDate(-1000),
          assignedTo: adminId,
        },
      ]

      for (const cfg of configs) {
        const { id } = await seedConversation(env, {
          accountId: personalAccountRow.id,
          orgId,
          ownerType: "user",
          ownerId: adminId,
          subject: cfg.subject,
          status: cfg.status,
          isRead: cfg.isRead,
          isStarred: cfg.isStarred,
          lastMessageAt: cfg.lastMessageAt,
          assignedTo: cfg.assignedTo ?? null,
          messageCount: 2,
        })
        convIds.push(id)
        // Seed 2 messages per conversation
        for (let j = 0; j < 2; j++) {
          await seedMessage(env, {
            conversationId: id,
            accountId: personalAccountRow.id,
            orgId,
            ownerType: "user",
            ownerId: adminId,
            fromAddress: { name: "Sender", email: "sender@e2e.test" },
            toAddresses: [{ email: "admin-personal@gmail.e2e.test" }],
            subject: cfg.subject,
            textBody: `Message ${j + 1} of ${cfg.subject}`,
            direction: "inbound",
            sentAt: isoDate(-8000 + j * 1000),
          })
        }
      }
    })

    it("paginates with limit and cursor", async () => {
      const page1 = await api(url, "/api/mail/conversations?limit=3", { token: adminToken })
      expect(page1.status).toBe(200)
      expect(page1.body.data.length).toBe(3)
      expect(page1.body.meta.nextCursor).not.toBeNull()
      // Total counts only open conversations (6 open)
      expect(page1.body.meta.total).toBe(6)

      const page2 = await api(
        url,
        `/api/mail/conversations?limit=3&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`,
        { token: adminToken },
      )
      expect(page2.status).toBe(200)
      expect(page2.body.data.length).toBe(3)

      // No overlap
      const page1Ids = page1.body.data.map((c: any) => c.id)
      const page2Ids = page2.body.data.map((c: any) => c.id)
      expect(page1Ids.filter((id: string) => page2Ids.includes(id))).toEqual([])

      // Ordered by lastMessageAt DESC
      for (const page of [page1.body.data, page2.body.data]) {
        for (let i = 1; i < page.length; i++) {
          expect(new Date(page[i - 1].lastMessageAt).getTime()).toBeGreaterThanOrEqual(
            new Date(page[i].lastMessageAt).getTime(),
          )
        }
      }
    })

    it("filters by status=archived", async () => {
      const res = await api(url, "/api/mail/conversations?status=archived", { token: adminToken })
      expect(res.status).toBe(200)
      expect(res.body.data.length).toBe(2)
      for (const c of res.body.data) {
        expect(c.status).toBe("archived")
      }
    })

    it("filters by isRead=false", async () => {
      const res = await api(url, "/api/mail/conversations?isRead=false", { token: adminToken })
      expect(res.status).toBe(200)
      for (const c of res.body.data) {
        expect(c.isRead).toBe(false)
      }
    })

    it("filters by isStarred=true", async () => {
      const res = await api(url, "/api/mail/conversations?isStarred=true", { token: adminToken })
      expect(res.status).toBe(200)
      for (const c of res.body.data) {
        expect(c.isStarred).toBe(true)
      }
    })

    it("filters by accountId", async () => {
      const res = await api(url, `/api/mail/conversations?accountId=${personalAccountRow.id}`, {
        token: adminToken,
      })
      expect(res.status).toBe(200)
      for (const c of res.body.data) {
        expect(c.accountId).toBe(personalAccountRow.id)
      }
    })

    it("filters by assignedTo=me", async () => {
      const res = await api(url, "/api/mail/conversations?assignedTo=me", { token: adminToken })
      expect(res.status).toBe(200)
      expect(res.body.data.length).toBe(1)
      expect(res.body.data[0].assignedTo).toBe(adminId)
    })

    it("response shape matches contract", async () => {
      const res = await api(url, "/api/mail/conversations?limit=1", { token: adminToken })
      expect(res.status).toBe(200)
      const conv = res.body.data[0]
      expect(conv).toHaveProperty("id")
      expect(conv).toHaveProperty("accountId")
      expect(conv).toHaveProperty("subject")
      expect(conv).toHaveProperty("snippet")
      expect(conv).toHaveProperty("status")
      expect(conv).toHaveProperty("labels")
      expect(conv).toHaveProperty("isRead")
      expect(conv).toHaveProperty("isStarred")
      expect(conv).toHaveProperty("lastMessageAt")
      expect(conv).toHaveProperty("messageCount")
      expect(res.body.meta).toHaveProperty("nextCursor")
      expect(res.body.meta).toHaveProperty("total")
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  S3: Conversation detail — messages, projections, auto-mark-read
  // ════════════════════════════════════════════════════════════════════════

  describe("S3: Conversation detail", () => {
    let convAId: string
    let convBId: string
    let contactBId: string

    beforeAll(async () => {
      // Conversation A: 3 messages, unread, no contact
      const resultA = await seedConversationWithMessages(
        env,
        {
          accountId: personalAccountRow.id,
          orgId,
          ownerType: "user",
          ownerId: adminId,
          subject: "Detail Test Conv A",
          isRead: false,
        },
        [
          {
            fromAddress: { email: "alice@e2e.test" },
            toAddresses: [{ email: "admin@e2e.test" }],
            subject: "Detail Test Conv A",
            textBody: "Message A1",
            direction: "inbound",
            sentAt: isoDate(-30000),
          },
          {
            fromAddress: { email: "alice@e2e.test" },
            toAddresses: [{ email: "admin@e2e.test" }],
            subject: "Re: Detail Test Conv A",
            textBody: "Message A2",
            direction: "inbound",
            sentAt: isoDate(-20000),
          },
          {
            fromAddress: { email: "admin@e2e.test" },
            toAddresses: [{ email: "alice@e2e.test" }],
            subject: "Re: Detail Test Conv A",
            textBody: "Message A3",
            direction: "outbound",
            sentAt: isoDate(-10000),
          },
        ],
      )
      convAId = resultA.conversationId

      // Conversation B: with linked contact
      const { id: contactId } = await seedContact(env, orgId, {
        name: "Bob External",
        email: "bob-external@e2e.test",
        createdBy: adminId,
      })
      contactBId = contactId

      const resultB = await seedConversationWithMessages(
        env,
        {
          accountId: personalAccountRow.id,
          orgId,
          ownerType: "user",
          ownerId: adminId,
          subject: "Detail Test Conv B",
          contactId,
          isRead: true,
        },
        [
          {
            fromAddress: { email: "bob-external@e2e.test" },
            toAddresses: [{ email: "admin@e2e.test" }],
            subject: "Detail Test Conv B",
            textBody: "Message B1",
            direction: "inbound",
            sentAt: isoDate(-5000),
          },
        ],
      )
      convBId = resultB.conversationId
    })

    it("first fetch returns messages and auto-marks as read", async () => {
      const res = await api(url, `/api/mail/conversations/${convAId}`, { token: adminToken })
      expect(res.status).toBe(200)

      // Conversation is marked read in response
      expect(res.body.data.conversation.isRead).toBe(true)

      // Messages sorted by sentAt ASC
      const msgs = res.body.data.messages
      expect(msgs.length).toBe(3)
      for (let i = 1; i < msgs.length; i++) {
        expect(new Date(msgs[i - 1].sentAt).getTime()).toBeLessThanOrEqual(
          new Date(msgs[i].sentAt).getTime(),
        )
      }

      // Message shape
      const msg = msgs[0]
      expect(msg).toHaveProperty("id")
      expect(msg).toHaveProperty("externalMessageId")
      expect(msg).toHaveProperty("fromAddress")
      expect(msg).toHaveProperty("toAddresses")
      expect(msg).toHaveProperty("subject")
      expect(msg).toHaveProperty("textBody")
      expect(msg).toHaveProperty("direction")
      expect(msg).toHaveProperty("sentAt")
      expect(msg).toHaveProperty("isRead")
      expect(msg).toHaveProperty("isStarred")
      expect(msg).toHaveProperty("labels")
    })

    it("auto-mark-read persists in DB", async () => {
      // Verify conversation row
      const convRows = await queryConversations(env, `id = '${convAId}'`)
      expect(convRows[0].is_read).toBe(true)

      // Verify all message rows
      const msgRows = await queryMessages(env, `conversation_id = '${convAId}'`)
      for (const row of msgRows) {
        expect(row.is_read).toBe(true)
      }
    })

    it("second fetch is idempotent", async () => {
      const res = await api(url, `/api/mail/conversations/${convAId}`, { token: adminToken })
      expect(res.status).toBe(200)
      expect(res.body.data.conversation.isRead).toBe(true)
      expect(res.body.data.messages.length).toBe(3)
    })

    it("detail with linked contact returns contact info", async () => {
      const res = await api(url, `/api/mail/conversations/${convBId}`, { token: adminToken })
      expect(res.status).toBe(200)
      expect(res.body.data.conversation.contactId).toBe(contactBId)
    })

    it("response has expected shape", async () => {
      const res = await api(url, `/api/mail/conversations/${convAId}`, { token: adminToken })
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveProperty("conversation")
      expect(res.body.data).toHaveProperty("messages")
      expect(res.body.data).toHaveProperty("contact")
      expect(res.body.data).toHaveProperty("discussionMarkers")
      expect(res.body.data).toHaveProperty("nextMessageCursor")
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  S4A: Reply and compose failure paths
  // ════════════════════════════════════════════════════════════════════════

  describe("S4A: Reply and compose failure paths", () => {
    let replyConvId: string

    beforeAll(async () => {
      const result = await seedConversationWithMessages(
        env,
        {
          accountId: personalAccountRow.id,
          orgId,
          ownerType: "user",
          ownerId: adminId,
          subject: "Reply Failure Test",
        },
        [
          {
            fromAddress: { email: "external@e2e.test" },
            toAddresses: [{ email: "admin@e2e.test" }],
            subject: "Reply Failure Test",
            textBody: "Original message",
            direction: "inbound",
            sentAt: isoDate(-1000),
          },
        ],
      )
      replyConvId = result.conversationId
    })

    it("reply fails cleanly without creating outbound message", async () => {
      // Capture pre-request state
      const msgsBefore = await queryMessages(env, `conversation_id = '${replyConvId}'`)
      const convBefore = await queryConversations(env, `id = '${replyConvId}'`)

      const res = await api(url, `/api/mail/conversations/${replyConvId}/reply`, {
        token: adminToken,
        body: { htmlBody: "<p>Reply</p>", textBody: "Reply" },
      })
      expect(res.status).toBeGreaterThanOrEqual(400)

      // No outbound message row inserted
      const msgsAfter = await queryMessages(env, `conversation_id = '${replyConvId}'`)
      expect(msgsAfter.length).toBe(msgsBefore.length)

      // Conversation metadata unchanged
      const convAfter = await queryConversations(env, `id = '${replyConvId}'`)
      expect(convAfter[0].message_count).toBe(convBefore[0].message_count)
    })

    it("compose fails cleanly without creating conversation or message", async () => {
      const convsBefore = await queryConversations(env, `account_id = '${personalAccountRow.id}'`)
      const msgsBefore = await queryMessages(env, `account_id = '${personalAccountRow.id}'`)

      const res = await api(url, "/api/mail/compose", {
        token: adminToken,
        body: {
          accountId: personalAccountRow.id,
          to: ["new-recipient@e2e.test"],
          subject: "Compose Failure Test",
          htmlBody: "<p>Hello</p>",
          textBody: "Hello",
        },
      })
      expect(res.status).toBeGreaterThanOrEqual(400)

      const convsAfter = await queryConversations(env, `account_id = '${personalAccountRow.id}'`)
      const msgsAfter = await queryMessages(env, `account_id = '${personalAccountRow.id}'`)
      expect(convsAfter.length).toBe(convsBefore.length)
      expect(msgsAfter.length).toBe(msgsBefore.length)
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  S4: Conversation update — status, read, star, assignment
  // ════════════════════════════════════════════════════════════════════════

  describe("S4: Conversation update", () => {
    let updateConvId: string

    beforeAll(async () => {
      const result = await seedConversationWithMessages(
        env,
        {
          accountId: personalAccountRow.id,
          orgId,
          ownerType: "user",
          ownerId: adminId,
          subject: "Update Test Conv",
          isRead: false,
          isStarred: false,
          status: "open",
        },
        [
          {
            fromAddress: { email: "alice@e2e.test" },
            toAddresses: [{ email: "admin@e2e.test" }],
            subject: "Update Test",
            textBody: "Msg 1",
            direction: "inbound",
            sentAt: isoDate(-2000),
            isRead: false,
          },
          {
            fromAddress: { email: "alice@e2e.test" },
            toAddresses: [{ email: "admin@e2e.test" }],
            subject: "Update Test",
            textBody: "Msg 2",
            direction: "inbound",
            sentAt: isoDate(-1000),
            isRead: false,
          },
        ],
      )
      updateConvId = result.conversationId
    })

    it("stars a conversation", async () => {
      const res = await api(url, `/api/mail/conversations/${updateConvId}`, {
        method: "PATCH",
        token: adminToken,
        body: { isStarred: true },
      })
      expect(res.status).toBe(200)

      const verify = await api(url, `/api/mail/conversations/${updateConvId}`, {
        token: adminToken,
      })
      expect(verify.body.data.conversation.isStarred).toBe(true)
    })

    it("marks read cascades to messages", async () => {
      const res = await api(url, `/api/mail/conversations/${updateConvId}`, {
        method: "PATCH",
        token: adminToken,
        body: { isRead: true },
      })
      expect(res.status).toBe(200)

      // Verify all messages marked read via SQL
      const msgRows = await queryMessages(env, `conversation_id = '${updateConvId}'`)
      for (const row of msgRows) {
        expect(row.is_read).toBe(true)
      }
    })

    it("archives a conversation", async () => {
      const res = await api(url, `/api/mail/conversations/${updateConvId}`, {
        method: "PATCH",
        token: adminToken,
        body: { status: "archived" },
      })
      expect(res.status).toBe(200)

      // Not in default (open) listing
      const openRes = await api(url, "/api/mail/conversations", { token: adminToken })
      const found = openRes.body.data.find((c: any) => c.id === updateConvId)
      expect(found).toBeUndefined()

      // Appears in archived listing
      const archivedRes = await api(url, "/api/mail/conversations?status=archived", {
        token: adminToken,
      })
      const foundArchived = archivedRes.body.data.find((c: any) => c.id === updateConvId)
      expect(foundArchived).toBeDefined()
    })

    it("rejects assigning a personal mailbox conversation", async () => {
      // Unarchive first
      await api(url, `/api/mail/conversations/${updateConvId}`, {
        method: "PATCH",
        token: adminToken,
        body: { status: "open" },
      })

      const res = await api(url, `/api/mail/conversations/${updateConvId}`, {
        method: "PATCH",
        token: adminToken,
        body: { assignedTo: adminId },
      })
      expect(res.status).toBe(422)
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  S6: RLS enforcement — personal account conversations
  // ════════════════════════════════════════════════════════════════════════

  describe("S6: RLS — personal account conversations", () => {
    let userA: { id: string; token: string; email: string }
    let userB: { id: string; token: string; email: string }
    const personalConvIds: string[] = []

    beforeAll(async () => {
      // User A connects personal Gmail
      userA = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
        scopes: [
          "mail:conversations:read",
          "mail:conversations:write",
          "mail:accounts:read",
          "mail:accounts:write",
        ],
        dimensions: {},
        schemaPrefix: env.schemaPrefix,
      })
      const resultA = await doGmailOAuthFlow(url, userA.token, env, oidcPort, {
        loginHint: "usera-rls@gmail.e2e.test",
      })

      // Seed 3 conversations under User A's personal account
      for (let i = 0; i < 3; i++) {
        const { id } = await seedConversation(env, {
          accountId: resultA.extensionRow.id,
          orgId,
          ownerType: "user",
          ownerId: userA.id,
          subject: `UserA Personal Conv ${i + 1}`,
          messageCount: 1,
        })
        personalConvIds.push(id)
      }

      // User B has mail scope but no ownership/dimension
      userB = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
        scopes: ["mail:conversations:read"],
        dimensions: {},
        schemaPrefix: env.schemaPrefix,
      })
    }, 60_000)

    it("owner sees personal conversations", async () => {
      const res = await api(url, "/api/mail/conversations", { token: userA.token })
      expect(res.status).toBe(200)
      const ids = res.body.data.map((c: any) => c.id)
      for (const id of personalConvIds) {
        expect(ids).toContain(id)
      }
    })

    it("non-owner sees no personal conversations", async () => {
      const res = await api(url, "/api/mail/conversations", { token: userB.token })
      expect(res.status).toBe(200)
      const ids = res.body.data.map((c: any) => c.id)
      for (const id of personalConvIds) {
        expect(ids).not.toContain(id)
      }
    })

    it("non-owner gets 404 on detail", async () => {
      const res = await api(url, `/api/mail/conversations/${personalConvIds[0]}`, {
        token: userB.token,
      })
      expect(res.status).toBe(404)
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  S7: RLS enforcement — shared inbox with dimension grants
  // ════════════════════════════════════════════════════════════════════════

  describe("S7: RLS — shared inbox with dimension grants", () => {
    let userC: { id: string; token: string; email: string }
    let userD: { id: string; token: string; email: string }
    const orgConvIds: string[] = []

    beforeAll(async () => {
      // Seed 2 conversations under the org account
      for (let i = 0; i < 2; i++) {
        const { id } = await seedConversation(env, {
          accountId: orgAccountRow.id,
          orgId,
          ownerType: "org",
          ownerId: null,
          subject: `Org Shared Conv ${i + 1}`,
          messageCount: 1,
        })
        orgConvIds.push(id)
      }

      // User C: has mail scopes + inbox dimension grant
      userC = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
        scopes: ["mail:conversations:read", "mail:conversations:write"],
        dimensions: {},
        schemaPrefix: env.schemaPrefix,
      })
      await grantInboxDimension(env, userC.id, [orgAccountRow.id])
      userC.token = await reloginUser(url, userC.email)

      // User D: has mail scope but NO inbox dimension
      userD = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
        scopes: ["mail:conversations:read"],
        dimensions: {},
        schemaPrefix: env.schemaPrefix,
      })
    }, 30_000)

    it("user with dimension sees org conversations", async () => {
      const res = await api(url, "/api/mail/conversations", { token: userC.token })
      expect(res.status).toBe(200)
      const ids = res.body.data.map((c: any) => c.id)
      for (const id of orgConvIds) {
        expect(ids).toContain(id)
      }
    })

    it("user without dimension sees no org conversations", async () => {
      const res = await api(url, "/api/mail/conversations", { token: userD.token })
      expect(res.status).toBe(200)
      const ids = res.body.data.map((c: any) => c.id)
      for (const id of orgConvIds) {
        expect(ids).not.toContain(id)
      }
    })

    it("user without dimension cannot claim org conversations", async () => {
      const res = await api(url, `/api/mail/conversations/${orgConvIds[0]}`, {
        method: "PATCH",
        token: userD.token,
        body: { assignedTo: userD.id },
      })
      expect([403, 404]).toContain(res.status)
    })

    it("user with dimension can assign", async () => {
      const res = await api(url, `/api/mail/conversations/${orgConvIds[0]}`, {
        method: "PATCH",
        token: userC.token,
        body: { assignedTo: userC.id },
      })
      expect(res.status).toBe(200)
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  S8: Contact search — ILIKE query filter
  // ════════════════════════════════════════════════════════════════════════

  describe("S8: Contact search", () => {
    beforeAll(async () => {
      const contacts = [
        { name: "Alice Chen", email: "alice-search@example.com", company: "Acme Corp" },
        { name: "Bob Martinez", email: "bob-search@example.com", company: "Beta Inc" },
        { name: "Charlie Kim", email: "charlie-search@example.com", company: "Acme Corp" },
        { name: "Diana Park", email: "diana-search@example.com", company: "Delta LLC" },
      ]
      for (const c of contacts) {
        await seedContact(env, orgId, { ...c, createdBy: adminId })
      }
    })

    it("matches by name", async () => {
      const res = await api(url, "/api/contacts?query=Alice Chen", { token: adminToken })
      expect(res.status).toBe(200)
      expect(res.body.data.length).toBeGreaterThanOrEqual(1)
      expect(res.body.data.some((c: any) => c.name === "Alice Chen")).toBe(true)
    })

    it("matches by company", async () => {
      const res = await api(url, "/api/contacts?query=Acme", { token: adminToken })
      expect(res.status).toBe(200)
      expect(res.body.data.length).toBeGreaterThanOrEqual(2)
    })

    it("matches by email", async () => {
      const res = await api(url, "/api/contacts?query=search@example.com", { token: adminToken })
      expect(res.status).toBe(200)
      expect(res.body.data.length).toBeGreaterThanOrEqual(4)
    })

    it("case-insensitive", async () => {
      const res = await api(url, "/api/contacts?query=ALICE", { token: adminToken })
      expect(res.status).toBe(200)
      expect(res.body.data.some((c: any) => c.name === "Alice Chen")).toBe(true)
    })

    it("no match returns empty", async () => {
      const res = await api(url, "/api/contacts?query=zzzzzznonexistent", { token: adminToken })
      expect(res.status).toBe(200)
      expect(res.body.data.length).toBe(0)
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  S9: Contact merge — atomic merge with async mail reference update
  // ════════════════════════════════════════════════════════════════════════

  describe("S9: Contact merge", () => {
    let sourceId: string
    let targetId: string
    const mergeConvIds: string[] = []

    beforeAll(async () => {
      const source = await seedContact(env, orgId, {
        name: "John Doe",
        email: "john-merge-source@e2e.test",
        createdBy: adminId,
      })
      sourceId = source.id

      const target = await seedContact(env, orgId, {
        name: "J. Doe",
        email: "john-merge-target@e2e.test",
        createdBy: adminId,
      })
      targetId = target.id

      // Seed 2 conversations referencing source contact
      for (let i = 0; i < 2; i++) {
        const { id } = await seedConversation(env, {
          accountId: personalAccountRow.id,
          orgId,
          ownerType: "user",
          ownerId: adminId,
          subject: `Merge Test Conv ${i + 1}`,
          contactId: sourceId,
          messageCount: 1,
        })
        mergeConvIds.push(id)
      }
    })

    it("merges contacts and updates mail references asynchronously", async () => {
      // This test polls for async event processing — needs extra time
      const res = await api(url, "/api/contacts/merge", {
        method: "POST",
        token: adminToken,
        body: { sourceId, targetId, resolvedFields: { name: "John Doe" } },
      })
      expect(res.status).toBe(200)
      expect(res.body.data.contact.name).toBe("John Doe")

      // Source deleted
      const sourceRes = await api(url, `/api/contacts/${sourceId}`, { token: adminToken })
      expect(sourceRes.status).toBe(404)

      // Target exists with merged data
      const targetRes = await api(url, `/api/contacts/${targetId}`, { token: adminToken })
      expect(targetRes.status).toBe(200)
      expect(targetRes.body.data.name).toBe("John Doe")

      // Poll for async mail reference update (up to 10s)
      const deadline = Date.now() + 10_000
      let updated = false
      let lastCount = 0
      while (Date.now() < deadline) {
        const convRows = await queryConversations(env, `contact_id = '${targetId}'`)
        lastCount = convRows.length
        if (lastCount === 2) {
          updated = true
          break
        }
        await Bun.sleep(200)
      }
      if (!updated) {
        // Diagnostics: check if conversations still reference source
        const sourceRows = await queryConversations(env, `contact_id = '${sourceId}'`)
        throw new Error(
          `Contact merge async update failed: expected 2 conversations with targetId, got ${lastCount}. ` +
            `Conversations still referencing sourceId: ${sourceRows.length}. ` +
            `Server stdout (last 500): ${env.getStdout().slice(-500)}`,
        )
      }
    }, 20_000)
  })

  // ════════════════════════════════════════════════════════════════════════
  //  S10: Gmail webhook — verification, dedup, and handler
  // ════════════════════════════════════════════════════════════════════════

  describe("S10: Gmail webhook", () => {
    const gmailPushSecret = "e2e-gmail-push-secret-12345"

    beforeAll(async () => {
      // Seed gmailPushSecret into the mail app's config
      await setAppConfig(env, orgId, "mail", { gmailPushSecret })
    })

    it("valid push enqueues sync job", async () => {
      const pushMessageId = `push-msg-${randomUUID()}`
      const emailData = JSON.stringify({
        emailAddress: "admin-personal@gmail.e2e.test",
        historyId: "12345",
      })
      const messageData = Buffer.from(emailData).toString("base64")

      const res = await api(url, `/webhooks/${orgId}/mail/gmail-push?token=${gmailPushSecret}`, {
        method: "POST",
        body: { message: { data: messageData, messageId: pushMessageId } },
      })
      expect(res.status).toBe(200)
      expect(res.body.data.received).toBe(true)

      const jobFound = await waitForMailJob(
        env,
        "gmail-incremental-sync",
        (d) => d.orgId === orgId && d.push === true && d.historyId === "12345",
      )
      expect(jobFound).toBe(true)
    }, 10_000)

    it("wrong token returns 401", async () => {
      const pushMessageId = `push-msg-wrong-${randomUUID()}`
      const emailData = JSON.stringify({
        emailAddress: "admin-personal@gmail.e2e.test",
        historyId: "12345",
      })
      const messageData = Buffer.from(emailData).toString("base64")

      const res = await api(url, `/webhooks/${orgId}/mail/gmail-push?token=wrong-token`, {
        method: "POST",
        body: { message: { data: messageData, messageId: pushMessageId } },
      })
      expect(res.status).toBe(401)
    })

    it("duplicate messageId returns 409", async () => {
      const pushMessageId = `push-msg-dedup-${randomUUID()}`
      const emailData = JSON.stringify({
        emailAddress: "admin-personal@gmail.e2e.test",
        historyId: "12345",
      })
      const messageData = Buffer.from(emailData).toString("base64")

      // First call succeeds
      const res1 = await api(url, `/webhooks/${orgId}/mail/gmail-push?token=${gmailPushSecret}`, {
        method: "POST",
        body: { message: { data: messageData, messageId: pushMessageId } },
      })
      expect(res1.status).toBe(200)

      // Second call with same messageId returns 200 with `duplicate: true`.
      const res2 = await api(url, `/webhooks/${orgId}/mail/gmail-push?token=${gmailPushSecret}`, {
        method: "POST",
        body: { message: { data: messageData, messageId: pushMessageId } },
      })
      expect(res2.status).toBe(200)
      const body = res2.body as { data: { duplicate?: boolean } }
      expect(body.data.duplicate).toBe(true)
    }, 10_000)
  })

  // ════════════════════════════════════════════════════════════════════════
  //  S11: Sync trigger and status
  // ════════════════════════════════════════════════════════════════════════

  describe("S11: Sync trigger and status", () => {
    let syncUser: { id: string; token: string; email: string }
    let syncAccountRow: Record<string, any>
    let nonAdminWriter: { id: string; token: string; email: string }

    beforeAll(async () => {
      // Create a user who owns a personal account
      syncUser = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
        scopes: ["mail:accounts:read", "mail:accounts:write"],
        dimensions: {},
        schemaPrefix: env.schemaPrefix,
      })

      const result = await doGmailOAuthFlow(url, syncUser.token, env, oidcPort, {
        loginHint: "sync-user@gmail.e2e.test",
      })
      syncAccountRow = result.extensionRow

      // Update account to simulate completed sync
      const schema = ms(env)
      await env.db.sql.unsafe(
        `UPDATE ${schema}.accounts SET sync_status = 'active', last_sync_at = now() WHERE id = '${syncAccountRow.id}'`,
      )

      // Non-admin writer (for org account test)
      nonAdminWriter = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
        scopes: ["mail:accounts:read", "mail:accounts:write"],
        dimensions: {},
        schemaPrefix: env.schemaPrefix,
      })
      // Grant inbox dimension so they can see the org account
      await grantInboxDimension(env, nonAdminWriter.id, [orgAccountRow.id])
      nonAdminWriter.token = await reloginUser(url, nonAdminWriter.email)
    }, 60_000)

    it("sync-status returns current state", async () => {
      const res = await api(url, `/api/mail/accounts/${syncAccountRow.id}/sync-status`, {
        token: syncUser.token,
      })
      expect(res.status).toBe(200)
      expect(res.body.data.status).toBe("active")
      expect(res.body.data.lastSyncAt).not.toBeNull()
      expect(res.body.data.lastSyncError).toBeNull()
    })

    it("sync trigger enqueues job", async () => {
      const res = await api(url, `/api/mail/accounts/${syncAccountRow.id}/sync`, {
        method: "POST",
        token: syncUser.token,
      })
      expect(res.status).toBe(200)
      expect(res.body.data.enqueued).toBe(true)

      const jobFound = await waitForMailJob(
        env,
        "gmail-incremental-sync",
        (d) => d.orgId === orgId && d.accountId === syncAccountRow.id,
      )
      expect(jobFound).toBe(true)
    }, 10_000)

    it("org account sync without admin scope returns 403", async () => {
      const res = await api(url, `/api/mail/accounts/${orgAccountRow.id}/sync`, {
        method: "POST",
        token: nonAdminWriter.token,
      })
      expect(res.status).toBe(403)
    })

    it("disconnected account sync returns 409", async () => {
      // Disconnect the personal sync account
      const schema = ms(env)
      await env.db.sql.unsafe(
        `UPDATE ${schema}.accounts SET disconnected_at = now() WHERE id = '${syncAccountRow.id}'`,
      )

      const res = await api(url, `/api/mail/accounts/${syncAccountRow.id}/sync`, {
        method: "POST",
        token: syncUser.token,
      })
      expect(res.status).toBe(409)
      expect(res.body.error.message).toContain("disconnected")
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  S12: Scope enforcement — missing scope blocked
  // ════════════════════════════════════════════════════════════════════════

  describe("S12: Scope enforcement", () => {
    let noScopeUser: { id: string; token: string; email: string }

    beforeAll(async () => {
      noScopeUser = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
        scopes: ["kernel:threads:read"],
        dimensions: {},
        schemaPrefix: env.schemaPrefix,
      })
    })

    it("GET /api/mail/conversations blocked without mail:conversations:read", async () => {
      const res = await api(url, "/api/mail/conversations", { token: noScopeUser.token })
      expect(res.status).toBe(403)
    })

    it("PATCH /api/mail/conversations/:id blocked without mail:conversations:write", async () => {
      const res = await api(url, `/api/mail/conversations/${randomUUID()}`, {
        method: "PATCH",
        token: noScopeUser.token,
        body: { isRead: true },
      })
      expect(res.status).toBe(403)
    })

    it("POST /api/mail/accounts/:id/sync blocked without mail:accounts:write", async () => {
      const res = await api(url, `/api/mail/accounts/${randomUUID()}/sync`, {
        method: "POST",
        token: noScopeUser.token,
      })
      expect(res.status).toBe(403)
    })

    it("POST /api/contacts/merge blocked without kernel:contacts:write", async () => {
      const res = await api(url, "/api/contacts/merge", {
        method: "POST",
        token: noScopeUser.token,
        body: { sourceId: randomUUID(), targetId: randomUUID(), resolvedFields: {} },
      })
      expect(res.status).toBe(403)
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  S13: Conversation detail — message pagination
  // ════════════════════════════════════════════════════════════════════════

  describe("S13: Message pagination", () => {
    let paginConvId: string

    beforeAll(async () => {
      // Seed a conversation with 25 messages
      const { id } = await seedConversation(env, {
        accountId: personalAccountRow.id,
        orgId,
        ownerType: "user",
        ownerId: adminId,
        subject: "Message Pagination Test",
        messageCount: 25,
        isRead: true,
      })
      paginConvId = id

      for (let i = 0; i < 25; i++) {
        await seedMessage(env, {
          conversationId: id,
          accountId: personalAccountRow.id,
          orgId,
          ownerType: "user",
          ownerId: adminId,
          fromAddress: { email: "sender@e2e.test" },
          toAddresses: [{ email: "admin@e2e.test" }],
          subject: "Message Pagination Test",
          textBody: `Message ${i + 1} of 25`,
          direction: "inbound",
          sentAt: new Date(Date.now() - (25 - i) * 60000).toISOString(),
          isRead: true,
        })
      }
    })

    it("paginates messages with messageLimit and messageCursor", async () => {
      const page1 = await api(url, `/api/mail/conversations/${paginConvId}?messageLimit=10`, {
        token: adminToken,
      })
      expect(page1.status).toBe(200)
      expect(page1.body.data.messages.length).toBe(10)
      expect(page1.body.data.nextMessageCursor).not.toBeNull()

      const page2 = await api(
        url,
        `/api/mail/conversations/${paginConvId}?messageLimit=10&messageCursor=${encodeURIComponent(page1.body.data.nextMessageCursor)}`,
        { token: adminToken },
      )
      expect(page2.status).toBe(200)
      expect(page2.body.data.messages.length).toBe(10)

      // No overlap
      const page1Ids = page1.body.data.messages.map((m: any) => m.id)
      const page2Ids = page2.body.data.messages.map((m: any) => m.id)
      expect(page1Ids.filter((id: string) => page2Ids.includes(id))).toEqual([])
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  S14: Contact merge — edge cases
  // ════════════════════════════════════════════════════════════════════════

  describe("S14: Contact merge edge cases", () => {
    let edgeCaseContactId: string
    let edgeCaseTargetId: string

    beforeAll(async () => {
      const source = await seedContact(env, orgId, {
        name: "Edge Source",
        email: "edge-source@e2e.test",
        createdBy: adminId,
      })
      edgeCaseContactId = source.id

      const target = await seedContact(env, orgId, {
        name: "Edge Target",
        email: "edge-target@e2e.test",
        createdBy: adminId,
      })
      edgeCaseTargetId = target.id
    })

    it("self-merge returns 422", async () => {
      const res = await api(url, "/api/contacts/merge", {
        method: "POST",
        token: adminToken,
        body: { sourceId: edgeCaseContactId, targetId: edgeCaseContactId, resolvedFields: {} },
      })
      expect(res.status).toBe(422)
      expect(res.body.error.message).toContain("itself")
    })

    it("nonexistent source returns 404", async () => {
      const res = await api(url, "/api/contacts/merge", {
        method: "POST",
        token: adminToken,
        body: { sourceId: randomUUID(), targetId: edgeCaseTargetId, resolvedFields: {} },
      })
      expect(res.status).toBe(404)
      expect(res.body.error.message).toContain("Source")
    })

    it("zero-conversation merge succeeds cleanly", async () => {
      // Create contacts with no conversations
      const src = await seedContact(env, orgId, {
        name: "No Conv Source",
        email: "no-conv-source@e2e.test",
        createdBy: adminId,
      })
      const tgt = await seedContact(env, orgId, {
        name: "No Conv Target",
        email: "no-conv-target@e2e.test",
        createdBy: adminId,
      })

      const res = await api(url, "/api/contacts/merge", {
        method: "POST",
        token: adminToken,
        body: { sourceId: src.id, targetId: tgt.id, resolvedFields: {} },
      })
      expect(res.status).toBe(200)

      // Source deleted
      const sourceRes = await api(url, `/api/contacts/${src.id}`, { token: adminToken })
      expect(sourceRes.status).toBe(404)

      // Target exists
      const targetRes = await api(url, `/api/contacts/${tgt.id}`, { token: adminToken })
      expect(targetRes.status).toBe(200)
    })
  })
})
