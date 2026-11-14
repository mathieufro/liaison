// SPDX-License-Identifier: FSL-1.1-ALv2
// `liaison agent ask`: resolves the member and the agent in the database, then
// drives the server's HTTP API (faked here) as that member: opens the DM,
// posts the question and polls for the agent's reply. It acts only as the
// member named by --as, holds no session (so it cannot evict the member's own),
// and leaves an audit row naming the CLI operator.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { type FetchLike, formatPendingApprovals, runAgentAsk } from "~/cli/agent/ask"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { auditLog, sessions } from "~/db/schema/kernel"
import { createSession } from "~/modules/auth/auth"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { createExternalUser } from "~/modules/users/external-user"
import { createTestCompany } from "~/tests/helpers/company"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const BASE = "http://server.test"

async function freshOrg(): Promise<{
  slug: string
  orgId: string
  userId: string
  email: string
}> {
  const slug = `cli-ask-${crypto.randomUUID().slice(0, 12)}`
  const { orgId } = await ensureOrg({ slug, name: "AskOrg" })
  const email = `owner-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`
  const { userId } = await ensureUser({
    orgId,
    email,
    name: "Robin",
    role: "admin",
    allowPasswordless: true,
  })
  return { slug, orgId, userId, email }
}

/** A fake server: one DM thread whose agent answers after `answerAfterPolls` reads. */
function fakeServer(answerAfterPolls: number) {
  const calls: Array<{ method: string; path: string; body?: unknown; auth?: string }> = []
  let reads = 0
  const fetchImpl: FetchLike = async (url, init) => {
    const path = url.replace(BASE, "")
    const method = init?.method ?? "GET"
    const headers = new Headers(init?.headers)
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body, auth: headers.get("authorization") ?? undefined })
    if (path === "/api/threads/dm") return Response.json({ data: { id: "thread-1" } })
    if (method === "POST") return Response.json({ data: { id: "q-1" } })
    reads += 1
    const messages: unknown[] = [{ id: "old-1", authorType: "agent", content: "Earlier answer" }]
    if (reads > answerAfterPolls) {
      messages.push({
        id: "a-1",
        authorType: "agent",
        content: "Plans start at 10 EUR (Pricing, https://acme.example/pricing).",
        metadata: { toolCalls: [{ toolName: "knowledge_search", args: { query: "pricing" } }] },
      })
    }
    return Response.json({ data: messages })
  }
  return { fetchImpl, calls }
}

describe("liaison agent ask", () => {
  test("asks as the named member and returns the new agent reply with its tools", async () => {
    const { slug, orgId, userId, email } = await freshOrg()
    // The member's own sessions, at the per-user cap: none may be evicted.
    for (let i = 0; i < 10; i++) await createSession(userId, orgId)
    const before = await withSystemDb("t", (db) =>
      db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId)),
    )
    const { fetchImpl, calls } = fakeServer(2)
    const { exitCode, report } = await runAgentAsk(
      {
        question: "How much is it?",
        orgSlug: slug,
        asEmail: email,
        operator: "ops-alice",
        timeoutSeconds: 30,
        baseUrl: BASE,
      },
      fetchImpl,
      async () => {},
    )
    expect(exitCode).toBe(0)
    expect(report.ok).toBe(true)
    expect(report.answer).toContain("10 EUR")
    expect(report.toolCalls).toEqual([{ tool: "knowledge_search", args: { query: "pricing" } }])
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/threads/dm", body: {} })
    expect(
      calls.find((c) => c.path === "/api/threads/thread-1/messages" && c.method === "POST"),
    ).toMatchObject({ body: { content: "How much is it?" } })
    expect(calls.every((c) => c.auth?.startsWith("Bearer "))).toBe(true)

    // No session was created or evicted: the member's sessions are untouched.
    const after = await withSystemDb("t", (db) =>
      db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId)),
    )
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort())

    // The question is on the audit log, attributed to the operator.
    const [audit] = await withSystemDb("t", (db) =>
      db
        .select({ actorType: auditLog.actorType, metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "cli_agent_ask"))),
    )
    expect(audit?.actorType).toBe("system")
    expect(audit?.metadata).toMatchObject({
      operator: "ops-alice",
      asUserId: userId,
      question: "How much is it?",
    })
  })

  test("targets a named agent by handle", async () => {
    const { slug, email } = await freshOrg()
    const { fetchImpl, calls } = fakeServer(1)
    const { exitCode } = await runAgentAsk(
      {
        question: "Hi",
        orgSlug: slug,
        asEmail: email.toUpperCase(),
        agentHandle: "base",
        timeoutSeconds: 30,
        baseUrl: BASE,
      },
      fetchImpl,
      async () => {},
    )
    expect(exitCode).toBe(0)
    expect(calls[0]?.body).toMatchObject({ agentId: expect.any(String) })
  })

  test("--new-conversation asks in a fresh conversation, not the member's DM", async () => {
    const { slug, email } = await freshOrg()
    const { fetchImpl, calls } = fakeServer(1)
    const routed: FetchLike = async (url, init) => {
      const path = url.replace(BASE, "")
      if (path === "/api/threads" && init?.method === "POST") {
        await fetchImpl(url, init)
        return Response.json({ data: { id: "thread-1" } }, { status: 201 })
      }
      return fetchImpl(url, init)
    }
    const { exitCode, report } = await runAgentAsk(
      {
        question: "How much is it?",
        orgSlug: slug,
        asEmail: email,
        agentHandle: "base",
        newConversation: true,
        timeoutSeconds: 30,
        baseUrl: BASE,
      },
      routed,
      async () => {},
    )
    expect(exitCode).toBe(0)
    expect(report.threadId).toBe("thread-1")
    expect(calls.some((c) => c.path === "/api/threads/dm")).toBe(false)
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/threads",
      body: { participantIds: [], forceCreate: true, title: expect.stringContaining("agent ask") },
    })
    const seat = calls.find((c) => c.path === "/api/threads/thread-1/participants")
    const agentId = (seat?.body as { agentId?: string } | undefined)?.agentId
    expect(agentId).toEqual(expect.any(String))
    // Seated before the question, then addressed by mention.
    const posted = calls.find(
      (c) => c.path === "/api/threads/thread-1/messages" && c.method === "POST",
    )
    expect(calls.indexOf(seat!)).toBeLessThan(calls.indexOf(posted!))
    expect(posted?.body).toEqual({ content: `@[base](agent:${agentId}) How much is it?` })
  })

  test("--thread follows up in an earlier conversation, addressing the agent by mention", async () => {
    const { slug, email } = await freshOrg()
    const { fetchImpl, calls } = fakeServer(1)
    const { exitCode, report } = await runAgentAsk(
      {
        question: "Done, what next?",
        orgSlug: slug,
        asEmail: email,
        agentHandle: "base",
        threadId: "thread-1",
        timeoutSeconds: 30,
        baseUrl: BASE,
      },
      fetchImpl,
      async () => {},
    )
    expect(exitCode).toBe(0)
    expect(report.threadId).toBe("thread-1")
    // No new conversation and no DM: the question goes straight into the thread.
    expect(calls.some((c) => c.path === "/api/threads/dm")).toBe(false)
    expect(calls.some((c) => c.path === "/api/threads" && c.method === "POST")).toBe(false)
    const posted = calls.find(
      (c) => c.path === "/api/threads/thread-1/messages" && c.method === "POST",
    )
    expect((posted?.body as { content?: string } | undefined)?.content).toMatch(
      /^@\[base\]\(agent:[^)]+\) Done, what next\?$/,
    )
  })

  test("a missing --as, an unknown agent or an unknown member is a usage error before any request", async () => {
    const { slug, email } = await freshOrg()
    const { fetchImpl, calls } = fakeServer(0)
    const noAgent = await runAgentAsk(
      {
        question: "Hi",
        orgSlug: slug,
        asEmail: email,
        agentHandle: "@nobody",
        timeoutSeconds: 5,
        baseUrl: BASE,
      },
      fetchImpl,
    )
    expect(noAgent.exitCode).toBe(2)
    const noMember = await runAgentAsk(
      {
        question: "Hi",
        orgSlug: slug,
        asEmail: "ghost@x.example",
        timeoutSeconds: 5,
        baseUrl: BASE,
      },
      fetchImpl,
    )
    expect(noMember.exitCode).toBe(2)
    const noAs = await runAgentAsk(
      { question: "Hi", orgSlug: slug, asEmail: "", timeoutSeconds: 5, baseUrl: BASE },
      fetchImpl,
    )
    expect(noAs.exitCode).toBe(2)
    expect(noAs.report.error).toContain("--as")
    expect(calls).toEqual([])
  })

  test("an external row is refused before any token or request, and leaves no audit row", async () => {
    const { slug, orgId } = await freshOrg()
    const email = `client-${crypto.randomUUID().slice(0, 8)}@client.example`
    const companyId = await createTestCompany(orgId)
    const created = await withPrivilegedDb(orgId, "cli-ask-external-test", (tx) =>
      createExternalUser(tx, { orgId, companyId, email, name: "Client" }),
    )
    if (!created.ok) throw new Error(created.code)
    const calls: string[] = []
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url)
      return Response.json({ data: { id: "t" } })
    }
    const result = await runAgentAsk(
      { question: "Hi", orgSlug: slug, asEmail: email, timeoutSeconds: 5, baseUrl: BASE },
      fetchImpl,
    )
    expect(result.exitCode).toBe(2)
    expect(result.report.error).toContain("portal")
    expect(calls).toEqual([])
    const audit = await withSystemDb("cli-ask-external-audit", (tx) =>
      tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.orgId, orgId), eq(auditLog.action, "cli_agent_ask"))),
    )
    expect(audit).toEqual([])
  })

  test("a turn that failed at the provider is a failure carrying the provider's reason", async () => {
    const { slug, email } = await freshOrg()
    let reads = 0
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith("/api/threads/dm")) return Response.json({ data: { id: "t" } })
      if (init?.method === "POST") return Response.json({ data: { id: "q" } })
      reads += 1
      return Response.json({
        data:
          reads === 1
            ? []
            : [
                {
                  id: "a",
                  authorType: "agent",
                  content: "I couldn't complete that response",
                  metadata: { finishReason: "error", error: "credit balance is too low" },
                },
              ],
      })
    }
    const { exitCode, report } = await runAgentAsk(
      { question: "Hi", orgSlug: slug, asEmail: email, timeoutSeconds: 30, baseUrl: BASE },
      fetchImpl,
      async () => {},
    )
    expect(exitCode).toBe(1)
    expect(report.error).toBe("credit balance is too low")
  })

  test("an approval the agent opens is reported, and the agent's reply after it is the answer", async () => {
    const { slug, email } = await freshOrg()
    let reads = 0
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith("/api/threads/dm")) return Response.json({ data: { id: "t" } })
      if (init?.method === "POST") return Response.json({ data: { id: "q" } })
      reads += 1
      // The platform's "approval opened" line lands first; the agent's own
      // reply follows on a later read, when its turn completes.
      const approvalLine = {
        id: "s-1",
        authorType: "system",
        content: "Approval request request-7 opened.",
        metadata: {
          type: "approval-created",
          requestId: "00000000-0000-4000-8000-000000000007",
          requestHandle: "request-7",
          toolName: "connector_write",
        },
      }
      const agentReply = {
        id: "a-1",
        authorType: "agent",
        content: "I drafted the contact update; it is waiting for your approval.",
        metadata: { toolCalls: [{ toolName: "connector_write", args: { op: "contact.update" } }] },
      }
      return Response.json({
        data: reads === 1 ? [] : reads === 2 ? [approvalLine] : [approvalLine, agentReply],
      })
    }
    const { exitCode, report } = await runAgentAsk(
      { question: "Update Ada", orgSlug: slug, asEmail: email, timeoutSeconds: 30, baseUrl: BASE },
      fetchImpl,
      async () => {},
    )
    expect(exitCode).toBe(0)
    expect(report.ok).toBe(true)
    expect(report.error).toBeUndefined()
    expect(report.answer).toBe("I drafted the contact update; it is waiting for your approval.")
    expect(report.pendingApprovals).toEqual([{ request: "request-7", tool: "connector_write" }])
    expect(formatPendingApprovals(report)).toEqual([
      "Pending approval: request-7 (connector_write)",
    ])
  })

  test("a system refusal with no agent reply is still a failure carrying the system's line", async () => {
    const { slug, email } = await freshOrg()
    let reads = 0
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith("/api/threads/dm")) return Response.json({ data: { id: "t" } })
      if (init?.method === "POST") return Response.json({ data: { id: "q" } })
      reads += 1
      return Response.json({
        data: reads === 1 ? [] : [{ id: "s", authorType: "system", content: "Out of agent usage" }],
      })
    }
    const { exitCode, report } = await runAgentAsk(
      { question: "Hi", orgSlug: slug, asEmail: email, timeoutSeconds: 30, baseUrl: BASE },
      fetchImpl,
      async () => {},
    )
    expect(exitCode).toBe(1)
    expect(report.error).toContain("Out of agent usage")
  })

  test("no reply before the timeout is a failure that points at the server log", async () => {
    const { slug, email } = await freshOrg()
    const { fetchImpl } = fakeServer(Number.POSITIVE_INFINITY)
    const { exitCode, report } = await runAgentAsk(
      { question: "Hi", orgSlug: slug, asEmail: email, timeoutSeconds: 0, baseUrl: BASE },
      fetchImpl,
      async () => {},
    )
    expect(exitCode).toBe(1)
    expect(report.error).toContain("docker compose logs app")
  })
})
