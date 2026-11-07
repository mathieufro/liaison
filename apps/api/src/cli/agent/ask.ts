// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `liaison agent ask`: ask one agent one question as a member and print the
 * answer, the tools the agent called and how long it took, as JSON. It is the
 * headless smoke test a setup run ends with ("does the support agent answer
 * from the knowledge we just loaded?") and works on any instance, with or
 * without SMTP, because the operator CLI acts as the member itself.
 *
 * It goes through the running server's own HTTP API on this container
 * (`http://127.0.0.1:$PORT`), exactly as the web app does: the turn runs in the
 * server, under the member's permissions, never in this process.
 *
 * Acting as a member is explicit and recorded:
 *  - `--as <email>` is required; there is no default member.
 *  - The credential is a bare access token that expires with the command
 *    (timeout + 60 s), with no session row: the member's real sessions are
 *    never counted against, evicted or refreshed. It is marked `restricted`,
 *    so it cannot mint any other credential.
 *  - An audit row records that the CLI operator asked this question as that
 *    member (OS user, or LIAISON_CLI_OPERATOR when set).
 *
 * By default the question goes to the member's one DM with the agent, so a
 * second ask sees the first one's conversation. `--new-conversation` asks in
 * a fresh titled conversation instead (the agent seated, then mentioned, as
 * the web app's "New chat" does): a repeated smoke test then answers from
 * the org's data, not from what the agent said last time.
 *
 * The answer is the agent's own message. When a tool the agent calls opens an
 * approval, the platform posts "Approval request request-N opened." in the
 * conversation mid-turn: that line is reported under `pendingApprovals`, never
 * taken for the answer, and the wait goes on until the agent's reply.
 *
 *   liaison agent ask --as owner@acme.example --agent @support "What is our refund policy?"
 *   liaison agent ask --as owner@acme.example --new-conversation "What is our refund policy?"
 *   liaison agent ask --org acme --as owner@acme.example --agent @support --timeout 180 "..."
 */
import { userInfo } from "node:os"
import { and, eq, isNull } from "drizzle-orm"
import { type CliMember, resolveMember } from "~/cli/lib/resolve-member"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { agents, users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { isRecord } from "~/lib/guards"
import { writeAuditLog } from "~/modules/audit/service"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"

export const AGENT_ASK_USAGE =
  'usage: liaison agent ask --as <member email> [--org <slug>] [--agent <@handle>] [--new-conversation | --thread <id>] [--timeout <seconds>] "<question>"'

export interface AgentAskOptions {
  question: string
  orgSlug?: string
  /** The member to ask as. Required: the CLI never picks one. */
  asEmail: string
  agentHandle?: string
  /** Ask in a fresh conversation instead of the member's DM with the agent. */
  newConversation?: boolean
  /** Ask in this conversation (the `threadId` of an earlier ask), to follow up. */
  threadId?: string
  /** Who ran the command, for the audit row (defaults to the OS user). */
  operator?: string
  timeoutSeconds: number
  baseUrl: string
}

export interface AgentAskReport {
  ok: boolean
  agent?: string
  threadId?: string
  question: string
  answer?: string
  /** The model that answered (auto mode picks one the org has a key for). */
  model?: string
  toolCalls?: Array<{ tool: string; args: unknown }>
  /** Approvals the turn opened, still waiting for a person's decision. */
  pendingApprovals?: PendingApproval[]
  seconds: number
  error?: string
}

export interface PendingApproval {
  /** The request's handle, e.g. `request-7`. */
  request: string
  tool: string
}

/** One "Pending approval: request-N (<tool>)" line per approval the turn opened. */
export function formatPendingApprovals(report: AgentAskReport): string[] {
  return (report.pendingApprovals ?? []).map((a) => `Pending approval: ${a.request} (${a.tool})`)
}

/** The minimal HTTP surface this command needs; injectable for tests. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

interface ThreadMessage {
  id: string
  authorType?: string
  content?: string | null
  metadata?: {
    toolCalls?: Array<{ toolName?: string; args?: unknown }>
    modelId?: string
    finishReason?: string
    error?: string
    /** Platform lines: `approval-created` marks "Approval request request-N opened." */
    type?: string
    requestHandle?: string
    toolName?: string
  } | null
}

function dataOf(body: unknown): unknown {
  return isRecord(body) ? body.data : undefined
}

/** The platform's "Approval request request-N opened." line, posted mid-turn. */
function isApprovalLine(m: ThreadMessage): boolean {
  return m.authorType === "system" && m.metadata?.type === "approval-created"
}

function toMessages(body: unknown): ThreadMessage[] {
  const data = dataOf(body)
  if (!Array.isArray(data)) return []
  return data.filter((m): m is ThreadMessage => isRecord(m) && typeof m.id === "string")
}

/**
 * A short-lived access token for the member, with no session behind it (see
 * the header): nothing to evict, nothing to refresh, gone when it expires.
 * Null for an external user, who holds no agent and no access token.
 */
async function shortLivedToken(member: CliMember, ttlSeconds: number): Promise<string | null> {
  const { user, permissions } = await withPrivilegedDb(
    member.orgId,
    "cli-agent-ask-token",
    async (tx) => {
      const [u] = await tx
        .select({
          name: users.name,
          authVersion: users.authVersion,
          permissionVersion: users.permissionVersion,
          userType: users.userType,
        })
        .from(users)
        .where(eq(users.id, member.userId))
      return {
        user: u,
        permissions: await loadEffectivePermissions(tx, member.userId, member.orgId),
      }
    },
  )
  if (user?.userType !== "member") return null
  return signAccessToken(
    {
      userId: member.userId,
      orgId: member.orgId,
      name: user.name,
      authVersion: user.authVersion,
      permissionVersion: user.permissionVersion,
      userType: user.userType,
      roles: permissions.roles,
      scopes: permissions.scopes,
      dimensionGrants: permissions.dimensionGrants,
      restricted: true,
    },
    env.JWT_SECRET,
    ttlSeconds,
  )
}

function defaultOperator(): string {
  if (process.env.LIAISON_CLI_OPERATOR) return process.env.LIAISON_CLI_OPERATOR
  try {
    return userInfo().username
  } catch {
    return "unknown"
  }
}

interface AgentRef {
  id: string
  handle: string
}

async function resolveAgent(orgId: string, handle: string): Promise<AgentRef | null> {
  const normalized = handle.startsWith("@") ? handle.toLowerCase() : `@${handle.toLowerCase()}`
  const [row] = await withSystemDb("cli-agent-ask-agent", (tx) =>
    tx
      .select({ id: agents.id, handle: agents.handle })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.handle, normalized)))
      .limit(1),
  )
  return row ?? null
}

/** The member's own personal agent (what the DM route resolves without an agent id). */
async function resolvePersonalAgent(member: CliMember): Promise<AgentRef | null> {
  const [row] = await withSystemDb("cli-agent-ask-personal-agent", (tx) =>
    tx
      .select({ id: agents.id, handle: agents.handle })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, member.orgId),
          eq(agents.ownerUserId, member.userId),
          eq(agents.kind, "personal"),
          isNull(agents.archivedAt),
        ),
      )
      .limit(1),
  )
  return row ?? null
}

/** The mention that addresses the agent in a shared conversation. */
function agentMention(agent: AgentRef): string {
  return `@[${agent.handle.replace(/^@/, "")}](agent:${agent.id})`
}

export async function runAgentAsk(
  opts: AgentAskOptions,
  fetchImpl: FetchLike = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<{ exitCode: number; report: AgentAskReport }> {
  const started = Date.now()
  const fail = (error: string, exitCode = 1) => ({
    exitCode,
    report: {
      ok: false,
      question: opts.question,
      seconds: Math.round((Date.now() - started) / 1000),
      error,
    },
  })

  if (opts.asEmail.trim() === "") return fail("--as <member email> is required", 2)
  const member = await resolveMember(opts.orgSlug, opts.asEmail)
  if (typeof member === "string") return fail(member, 2)

  let agent: AgentRef | undefined
  if (opts.agentHandle) {
    const found = await resolveAgent(member.orgId, opts.agentHandle)
    if (!found) return fail(`no agent answers to '${opts.agentHandle}' in this org`, 2)
    agent = found
  } else if (opts.newConversation || opts.threadId) {
    const found = await resolvePersonalAgent(member)
    if (!found) return fail("the member has no personal agent yet; name one with --agent", 2)
    agent = found
  }
  const agentId = agent?.id

  const accessToken = await shortLivedToken(member, opts.timeoutSeconds + 60)
  if (accessToken === null) {
    return fail(`'${opts.asEmail}' is a client's portal account, not a member`, 2)
  }
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  }
  await withPrivilegedDb(member.orgId, "cli-agent-ask-audit", (tx) =>
    writeAuditLog(tx, {
      orgId: member.orgId,
      actorId: null,
      actorType: "system",
      app: "kernel",
      entityType: "user",
      entityId: member.userId,
      action: "cli_agent_ask",
      metadata: {
        operator: opts.operator ?? defaultOperator(),
        via: "liaison agent ask",
        asUserId: member.userId,
        agent: opts.agentHandle ?? null,
        question: opts.question,
        newConversation: opts.newConversation === true,
        threadId: opts.threadId ?? null,
      },
    }),
  )
  let threadId: string | null
  let content = opts.question
  if (opts.threadId && agent) {
    // A follow-up in the conversation an earlier ask started: the agent is
    // already seated there and answers when mentioned.
    threadId = opts.threadId
    content = `${agentMention(agent)} ${opts.question}`
  } else if (opts.newConversation && agent) {
    // A fresh titled conversation, the agent seated before the question (so
    // its "added" notice is not mistaken for the reply), then addressed by
    // mention: a shared conversation's agent answers only when mentioned.
    const createRes = await fetchImpl(`${opts.baseUrl}/api/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: `liaison agent ask ${new Date(started).toISOString()}`,
        participantIds: [],
        forceCreate: true,
      }),
    })
    const created = dataOf(await createRes.json().catch(() => null))
    threadId = isRecord(created) && typeof created.id === "string" ? created.id : null
    if (!createRes.ok || !threadId) {
      return fail(`could not start a new conversation (HTTP ${createRes.status})`)
    }
    const seatRes = await fetchImpl(`${opts.baseUrl}/api/threads/${threadId}/participants`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId: agent.id }),
    })
    if (!seatRes.ok) {
      return fail(`could not add the agent to the new conversation (HTTP ${seatRes.status})`)
    }
    content = `${agentMention(agent)} ${opts.question}`
  } else {
    const dmRes = await fetchImpl(`${opts.baseUrl}/api/threads/dm`, {
      method: "POST",
      headers,
      body: JSON.stringify(agentId ? { agentId } : {}),
    })
    const dm = dataOf(await dmRes.json().catch(() => null))
    threadId = isRecord(dm) && typeof dm.id === "string" ? dm.id : null
    if (!dmRes.ok || !threadId) {
      return fail(`could not open a conversation with the agent (HTTP ${dmRes.status})`)
    }
  }

  const before = new Set(
    toMessages(
      await (
        await fetchImpl(`${opts.baseUrl}/api/threads/${threadId}/messages?limit=50`, { headers })
      )
        .json()
        .catch(() => null),
    ).map((m) => m.id),
  )

  const postRes = await fetchImpl(`${opts.baseUrl}/api/threads/${threadId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content }),
  })
  if (!postRes.ok) return fail(`could not send the question (HTTP ${postRes.status})`)

  const deadline = started + opts.timeoutSeconds * 1000
  let pendingApprovals: PendingApproval[] = []
  while (Date.now() < deadline) {
    await sleep(2000)
    const res = await fetchImpl(`${opts.baseUrl}/api/threads/${threadId}/messages?limit=50`, {
      headers,
    })
    const fresh = toMessages(await res.json().catch(() => null)).filter(
      (m) => !before.has(m.id) && m.authorType !== "user",
    )
    pendingApprovals = fresh.filter(isApprovalLine).map((m) => ({
      request: m.metadata?.requestHandle ?? "unknown",
      tool: m.metadata?.toolName ?? "unknown",
    }))
    // The answer is the agent's own message. A tool that opens an approval
    // posts the platform line "Approval request request-N opened." mid-turn;
    // it is reported, never taken for the reply, and the agent's text that
    // ends the turn is still awaited. Any other system line (a usage refusal)
    // ends the turn with no agent reply, so it is the failure.
    const withText = fresh.filter((m) => (m.content ?? "").trim() !== "")
    const reply =
      withText.find((m) => m.authorType === "agent") ??
      withText.find((m) => m.authorType === "system" && !isApprovalLine(m))
    if (!reply) continue
    // A turn that failed at the provider still posts an agent message that
    // explains it; the cause is in its metadata.
    const turnError =
      reply.authorType !== "agent"
        ? `the reply came from the system: ${(reply.content ?? "").trim()}`
        : reply.metadata?.finishReason === "error"
          ? (reply.metadata.error ?? "the agent turn failed")
          : null
    return {
      exitCode: turnError ? 1 : 0,
      report: {
        ok: turnError === null,
        ...(opts.agentHandle ? { agent: opts.agentHandle } : {}),
        threadId,
        question: opts.question,
        answer: reply.content ?? "",
        ...(reply.metadata?.modelId ? { model: reply.metadata.modelId } : {}),
        toolCalls: (reply.metadata?.toolCalls ?? []).map((t) => ({
          tool: t.toolName ?? "unknown",
          args: t.args,
        })),
        ...(pendingApprovals.length > 0 ? { pendingApprovals } : {}),
        seconds: Math.round((Date.now() - started) / 1000),
        ...(turnError ? { error: turnError } : {}),
      },
    }
  }
  const timedOut = fail(
    `no answer within ${opts.timeoutSeconds}s; check the server log (docker compose logs app) for the turn's error`,
  )
  return pendingApprovals.length > 0
    ? { ...timedOut, report: { ...timedOut.report, pendingApprovals } }
    : timedOut
}
