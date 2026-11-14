// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The standard tier's resting rows: what the QA world shows on first sign-in
// but no person can make in one sitting through the product. Each domain is
// one named, privileged writer, and every instant is an offset from `ctx.now`:
//
// - agent app: skills, routines, agent chats, past routine runs (history), a
//   tool-call line in a chat;
// - agent memory: typed entries plus the `_index` row `handleMemorySet` keeps;
// - tickets: three inboxes, five categories, twelve tickets with their first
//   messages (a ticket arrives by mail through a connected mailbox);
// - attention: Elodie's home feed across every source app;
// - approvals: every resting state, decided ones included (history);
// - saved views: two personal, one shared;
// - mail: three unarmed mailboxes with plaintext conversations (a state the
//   product allows), connector placeholders without credentials, a locale.
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { runApprovalExpiry } from "~/modules/approvals/expiry"
import { DAY_MS, HOUR_MS } from "~/seed/clock"
import type { SeedContext } from "~/seed/context"
import { upsertRoleAgent } from "~/seed/factories/agent/agents"
import { seedApprovalRequests } from "~/seed/factories/approvals/requests"
import { rowsOf } from "~/seed/factories/people/actors"
import {
  QA_AGENT_CHATS,
  QA_APPROVALS,
  QA_ATTENTION,
  QA_CONNECTOR_PLACEHOLDERS,
  QA_LOCALES,
  QA_MAIL_CONVERSATIONS,
  QA_MAILBOXES,
  QA_MEMORY,
  QA_ROLE_AGENT,
  QA_ROUTINE_RUN_ERROR,
  QA_ROUTINE_RUNS,
  QA_ROUTINES,
  QA_SAVED_VIEWS,
  QA_SKILLS,
  QA_TICKET_ASSIGNEES,
  QA_TICKET_CATEGORIES,
  QA_TICKET_INBOXES,
  QA_TICKET_STATUSES,
  QA_TOOL_CALL_MESSAGE,
  type QaMailboxKey,
  qaMemoryIndex,
} from "~/seed/world/qa"
import type { StandardPeople } from "./people"

type Tx = Parameters<Parameters<typeof withPrivilegedDb>[2]>[0]

const S = (name: string) => sql.identifier(schemaRef(name))
const at = (ms: number) => new Date(ms).toISOString()
const json = (v: unknown) => JSON.stringify(v)

/**
 * The agent that speaks for `userId`: their personal agent, else the org's
 * built-in `@base` (created when the org has none), as the product resolves a
 * speaker.
 */
async function speakerFor(tx: Tx, orgId: string, userId: string): Promise<string> {
  const [personal] = rowsOf<{ id: string }>(
    await tx.execute(
      sql`SELECT id FROM ${S("kernel")}.agents
          WHERE org_id = ${orgId}::uuid AND owner_user_id = ${userId}::uuid AND kind = 'personal'
            AND archived_at IS NULL
          ORDER BY created_at, id LIMIT 1`,
    ),
  )
  if (personal) return personal.id
  await tx.execute(
    sql`INSERT INTO ${S("kernel")}.agents (org_id, kind, handle, display_name)
        VALUES (${orgId}::uuid, 'system', '@base', 'Base') ON CONFLICT (org_id, handle) DO NOTHING`,
  )
  const [base] = rowsOf<{ id: string }>(
    await tx.execute(
      sql`SELECT id FROM ${S("kernel")}.agents WHERE org_id = ${orgId}::uuid AND handle = '@base' LIMIT 1`,
    ),
  )
  if (!base) throw new Error(`standard seed: no @base agent for org ${orgId}`)
  return base.id
}

/**
 * The shared role agent, skills, routines, agent chats, past routine runs and
 * a tool-call line. Idempotent (every row has its own id, the role agent its
 * handle): a test that cleared the agent-app tables runs it again
 * (`--only agent-app`) to put the baseline back.
 */
export async function seedQaAgentApp(ctx: SeedContext, people: StandardPeople): Promise<void> {
  const { orgId } = ctx
  const roleAgent = await upsertRoleAgent(orgId, {
    ...QA_ROLE_AGENT,
    purpose: "",
    systemPrompt: "",
    scopes: [],
    toolAllowlist: null,
    modelPreference: null,
  })
  await withPrivilegedDb(orgId, "seed-standard:agent-app", async (tx) => {
    for (const s of QA_SKILLS) {
      const author = s.owner === "org" || s.owner === "role" ? null : people[s.owner].id
      const ownerAgentId =
        s.owner === "role" ? roleAgent.agentId : author ? await speakerFor(tx, orgId, author) : null
      await tx.execute(
        sql`INSERT INTO ${S("kernel")}.skills
              (id, org_id, author_user_id, owner_agent_id, name, description, body, required_scopes,
               enabled, created_by_user_id, created_by_actor_type)
            VALUES (${ctx.id("qa-skill", s.name)}::uuid, ${orgId}::uuid, ${author}::uuid,
                    ${ownerAgentId}::uuid, ${s.name}, ${s.description}, ${s.body}, '{}', true,
                    ${author ?? people.admin.id}::uuid, ${s.agentAuthored ? "agent" : "user"})
            ON CONFLICT DO NOTHING`,
      )
    }

    const routineIds: string[] = []
    for (const r of QA_ROUTINES) {
      const owner = people[r.owner].id
      const id = ctx.id("qa-routine", r.name)
      routineIds.push(id)
      const runAt =
        r.kind === "scheduled" && r.runAtDays !== undefined
          ? at(ctx.now.getTime() + r.runAtDays * DAY_MS)
          : null
      await tx.execute(
        sql`INSERT INTO ${S("kernel")}.routines
              (id, org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone,
               run_at, prompt, scopes, visibility, status, created_by_user_id, created_by_actor_type)
            VALUES (${id}::uuid, ${orgId}::uuid, ${owner}::uuid,
                    ${await speakerFor(tx, orgId, owner)}::uuid, ${r.name}, ${r.description},
                    ${r.kind}, ${r.kind === "recurring" ? (r.cron ?? null) : null},
                    ${r.kind === "recurring" ? (r.timezone ?? null) : null}, ${runAt}, ${r.prompt},
                    '{}', ${r.visibility}, ${r.status ?? "active"}, ${owner}::uuid, 'user')
            ON CONFLICT DO NOTHING`,
      )
    }

    let firstChat: string | null = null
    for (const c of QA_AGENT_CHATS) {
      const owner = people[c.owner].id
      const handle = `agent-chat-${c.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)}`
      const threadId = ctx.id("qa-agent-chat", handle)
      firstChat ??= threadId
      await tx.execute(
        sql`INSERT INTO ${S("kernel")}.threads (id, org_id, handle, type, title, created_by)
            VALUES (${threadId}::uuid, ${orgId}::uuid, ${handle}, 'agent_chat', ${c.title}, ${owner}::uuid)
            ON CONFLICT DO NOTHING`,
      )
      await tx.execute(
        sql`INSERT INTO ${S("kernel")}.thread_participants (thread_id, user_id, org_id)
            VALUES (${threadId}::uuid, ${owner}::uuid, ${orgId}::uuid) ON CONFLICT DO NOTHING`,
      )
      await tx.execute(
        sql`INSERT INTO ${S("kernel")}.user_thread_state (thread_id, user_id, org_id)
            VALUES (${threadId}::uuid, ${owner}::uuid, ${orgId}::uuid) ON CONFLICT DO NOTHING`,
      )
      for (const [i, m] of c.messages.entries()) {
        const agentId = m.authorType === "agent" ? await speakerFor(tx, orgId, owner) : null
        await tx.execute(
          sql`INSERT INTO ${S("kernel")}.messages
                (id, thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
              VALUES (${ctx.id("qa-agent-chat-message", `${handle}:${i}`)}::uuid, ${threadId}::uuid,
                      ${orgId}::uuid, ${owner}::uuid, ${m.authorType}, ${agentId}::uuid, ${m.content}, '{}')
              ON CONFLICT DO NOTHING`,
        )
      }
    }

    // Past runs (history), one per routine, newest first.
    for (const [i, routineId] of routineIds.entries()) {
      const { status } = QA_ROUTINE_RUNS[
        i % QA_ROUTINE_RUNS.length
      ] as (typeof QA_ROUTINE_RUNS)[number]
      await tx.execute(
        sql`INSERT INTO ${S("kernel")}.routine_runs
              (id, org_id, routine_id, ran_at, status, duration_ms, error, turns_added)
            VALUES (${ctx.id("qa-routine-run", routineId)}::uuid, ${orgId}::uuid, ${routineId}::uuid,
                    ${at(ctx.now.getTime() - (i + 1) * DAY_MS)}, ${status},
                    ${status === "succeeded" ? 1200 + i * 300 : null},
                    ${status === "failed" ? QA_ROUTINE_RUN_ERROR : null},
                    ${status === "succeeded" ? 1 + i : null})
            ON CONFLICT DO NOTHING`,
      )
    }

    if (firstChat) {
      await tx.execute(
        sql`INSERT INTO ${S("kernel")}.messages
              (id, thread_id, org_id, author_id, author_type, author_agent_id, content, metadata,
               required_scopes)
            VALUES (${ctx.id("qa-agent-chat-message", "tool-call")}::uuid, ${firstChat}::uuid,
                    ${orgId}::uuid, ${people.admin.id}::uuid, 'agent',
                    ${await speakerFor(tx, orgId, people.admin.id)}::uuid,
                    ${QA_TOOL_CALL_MESSAGE.content}, ${json(QA_TOOL_CALL_MESSAGE.metadata)}::jsonb, '{}')
            ON CONFLICT DO NOTHING`,
      )
    }
  })
}

/** Typed memory entries per person, plus the `_index` row the agent reads every turn. */
export async function seedQaMemory(ctx: SeedContext, people: StandardPeople): Promise<void> {
  const { orgId } = ctx
  await withPrivilegedDb(orgId, "seed-standard:memory", async (tx) => {
    for (const { owner, entries } of QA_MEMORY) {
      const userId = people[owner].id
      const [agent] = rowsOf<{ id: string }>(
        await tx.execute(
          sql`SELECT id FROM ${S("kernel")}.agents
              WHERE org_id = ${orgId}::uuid AND owner_user_id = ${userId}::uuid AND kind = 'personal'
              LIMIT 1`,
        ),
      )
      const ownerAgentId = agent?.id ?? null
      for (const e of entries) {
        await tx.execute(
          sql`INSERT INTO ${S("kernel")}.agent_memory
                (org_id, user_id, owner_agent_id, type, name, description, content, required_scopes)
              VALUES (${orgId}::uuid, ${userId}::uuid, ${ownerAgentId}::uuid, ${e.type}, ${e.name},
                      ${e.description}, ${e.content}, '{}'::text[])
              ON CONFLICT (org_id, owner_agent_id, type, name) DO NOTHING`,
        )
      }
      await tx.execute(
        sql`INSERT INTO ${S("kernel")}.agent_memory
              (org_id, user_id, owner_agent_id, type, name, description, content, required_scopes)
            VALUES (${orgId}::uuid, ${userId}::uuid, ${ownerAgentId}::uuid, '_index', '_index', 'index',
                    ${qaMemoryIndex(entries)}, '{}'::text[])
            ON CONFLICT (org_id, owner_agent_id, type, name) DO UPDATE SET content = EXCLUDED.content`,
      )
    }
  })
}

export interface StandardTickets {
  inboxes: Record<"support" | "sales" | "personal", string>
  categories: string[]
  tickets: string[]
}

/** Three inboxes, five categories, twelve tickets with their messages, one read mark. */
export async function seedQaTickets(
  ctx: SeedContext,
  people: StandardPeople,
): Promise<StandardTickets> {
  const { orgId } = ctx
  const now = ctx.now.getTime()
  const T = S("app_tickets")
  return withPrivilegedDb(orgId, "seed-standard:tickets", async (tx) => {
    const inboxes = {} as StandardTickets["inboxes"]
    for (const spec of QA_TICKET_INBOXES) {
      const id = ctx.id("qa-ticket-inbox", spec.key)
      inboxes[spec.key] = id
      const email =
        spec.email ?? `elodie.personal+${people.admin.id.slice(0, 8)}@resonantaudiolabs.example`
      await tx.execute(
        sql`INSERT INTO ${T}.inboxes (
              id, org_id, connected_account_id, name, email_address,
              default_sensitivity, is_default_for_create, created_at, updated_at
            ) VALUES (${id}::uuid, ${orgId}::uuid, ${ctx.id("qa-ticket-inbox-account", spec.key)}::uuid,
                      ${spec.name}, ${email}, 'internal', false, ${at(now)}, ${at(now)})
            ON CONFLICT (id) DO NOTHING`,
      )
    }

    const categories: string[] = []
    for (const [i, name] of QA_TICKET_CATEGORIES.entries()) {
      const id = ctx.id("qa-ticket-category", name)
      await tx.execute(
        sql`INSERT INTO ${T}.categories (id, org_id, parent_id, name, sort_order, created_at, updated_at)
            VALUES (${id}::uuid, ${orgId}::uuid, NULL, ${name}, ${i}, ${at(now)}, ${at(now)})
            ON CONFLICT (id) DO NOTHING`,
      )
      categories.push(id)
    }

    const tickets: string[] = []
    for (const [i, assignee] of QA_TICKET_ASSIGNEES.entries()) {
      const id = ctx.id("qa-ticket", String(i + 1))
      const inboxId = i % 3 === 0 ? inboxes.sales : i % 3 === 1 ? inboxes.personal : inboxes.support
      const categoryName = QA_TICKET_CATEGORIES[i % QA_TICKET_CATEGORIES.length] as string
      await tx.execute(
        sql`INSERT INTO ${T}.tickets (
              id, org_id, handle, subject, status, priority, channel, sensitivity,
              reply_token, sla_target_seconds, sla_deadline,
              sla_active_started_at, sla_elapsed_seconds, message_count,
              source_inbox_id, category_id, assigned_to,
              last_inbound_at, last_message_at, created_at, updated_at
            ) VALUES (
              ${id}::uuid, ${orgId}::uuid, ${`qa-ticket-${i + 1}`},
              ${`QA seeded ticket: ${categoryName} #${i + 1}`},
              ${QA_TICKET_STATUSES[i % QA_TICKET_STATUSES.length]}, 'normal', 'manual', 'internal',
              ${`RT${i.toString().padStart(16, "0")}`}, 3600, ${at(now + HOUR_MS)},
              ${at(now)}, 0, 1,
              ${inboxId}::uuid, ${categories[i % categories.length]}::uuid,
              ${assignee ? people[assignee].id : null}::uuid,
              ${at(now - 5 * 60_000)}, ${at(now - 5 * 60_000)}, ${at(now)}, ${at(now)}
            ) ON CONFLICT (id) DO NOTHING`,
      )
      tickets.push(id)
    }

    // The first ticket's back and forth: six messages, an hour apart.
    const chatty = tickets[0] as string
    for (let r = 0; r < 6; r++) {
      const inbound = r % 2 === 0
      const round = Math.floor(r / 2) + 1
      await tx.execute(
        sql`INSERT INTO ${T}.messages (
              id, org_id, ticket_id, kind, from_email, from_name, text_body, sent_at, created_at, updated_at
            ) VALUES (
              ${ctx.id("qa-ticket-message", `1:${r}`)}::uuid, ${orgId}::uuid, ${chatty}::uuid,
              ${inbound ? "inbound" : "outbound"},
              ${inbound ? "customer-1@example.com" : null}, ${inbound ? "Seeded Customer" : null},
              ${
                inbound
                  ? `Customer follow-up #${round}: still having the issue.`
                  : `Support reply #${round}: we're investigating, expect an update soon.`
              },
              ${at(now - (r + 1) * HOUR_MS)}, ${at(now)}, ${at(now)}
            )`,
      )
    }
    for (let i = 1; i < tickets.length; i++) {
      await tx.execute(
        sql`INSERT INTO ${T}.messages (
              id, org_id, ticket_id, kind, from_email, from_name, text_body, sent_at, created_at, updated_at
            ) VALUES (
              ${ctx.id("qa-ticket-message", `${i + 1}:0`)}::uuid, ${orgId}::uuid, ${tickets[i]}::uuid,
              'inbound', ${`customer-${i + 1}@example.com`}, 'Seeded Customer',
              'Initial customer message for ticket.', ${at(now - 5 * 60_000)}, ${at(now)}, ${at(now)}
            )`,
      )
    }

    // Amina has read the second ticket; Lucas has not.
    await tx.execute(
      sql`INSERT INTO ${T}.ticket_reads (org_id, ticket_id, user_id, read_at)
          VALUES (${orgId}::uuid, ${tickets[1]}::uuid, ${people.amina.id}::uuid, ${at(now)})
          ON CONFLICT DO NOTHING`,
    )
    return { inboxes, categories, tickets }
  })
}

/** Elodie's home feed (`QA_ATTENTION`): an hour old, the read one read half an hour ago. */
export async function seedQaAttention(ctx: SeedContext, people: StandardPeople): Promise<void> {
  const { orgId } = ctx
  const now = ctx.now.getTime()
  await withPrivilegedDb(orgId, "seed-standard:attention", async (tx) => {
    for (const e of QA_ATTENTION) {
      await tx.execute(
        sql`INSERT INTO ${S("kernel")}.attention_events (
              id, org_id, user_id, app, entity_type, entity_id, kind,
              urgency, summary, actor_id, actor_type, metadata,
              occurred_at, read_at, is_urgent, digest_state, digest_eligible_at,
              email_only, source_key, created_at
            ) VALUES (
              ${ctx.id("qa-attention", e.entityId)}::uuid, ${orgId}::uuid, ${people.admin.id}::uuid,
              ${e.app}, ${e.entityType}, ${e.entityId}, ${e.kind},
              ${e.urgency}, ${e.summary},
              ${e.actorType === "user" ? people.amina.id : null}::uuid, ${e.actorType}, NULL,
              ${at(now - HOUR_MS)}, ${e.read ? at(now - 30 * 60_000) : null},
              ${e.urgency >= 3}, ${e.read ? "sent" : "pending"}, ${at(now + HOUR_MS)},
              false, NULL, ${at(now)}
            ) ON CONFLICT DO NOTHING`,
      )
    }
  })
}

/**
 * Every resting approval state (`QA_APPROVALS`), shown in the Q2 marketing
 * thread; the cross-thread one was raised in the checkout bug thread.
 */
export async function seedQaApprovals(
  ctx: SeedContext,
  people: StandardPeople,
  threads: { primary: string; originating: string },
): Promise<void> {
  const now = ctx.now.getTime()
  const bundleId = ctx.id("qa-approval", "qa-approval-bundle-head")
  await seedApprovalRequests(
    ctx,
    QA_APPROVALS.map((a) => ({
      id: ctx.id("qa-approval", a.handle),
      handle: a.handle,
      threadId: threads.primary,
      originatingThreadId: a.crossThread ? threads.originating : threads.primary,
      toolName: a.toolName,
      payload: a.payload,
      requestedBy: people.amina.id,
      agentId: null,
      notifyUserIds: a.notify.map((k) => people[k].id),
      status: a.status,
      reason: a.decided?.reason ?? null,
      decidedBy: a.decided ? people[a.decided.by].id : null,
      decidedAt: a.decided ? new Date(now - a.decided.hoursAgo * HOUR_MS) : null,
      createdAt: new Date(now - a.createdHoursAgo * HOUR_MS),
      // Each QA request's own lifetime: one has already lapsed.
      expiresAt: new Date(now + a.expiresInHours * HOUR_MS),
      bundleId: a.bundlePosition === undefined ? null : bundleId,
      bundlePosition: a.bundlePosition ?? null,
      metadata: a.metadata ?? {},
    })),
    // Like the tier's posts, no seeded marker: the lanes read the feed rows
    // a pending request raises.
    { seeded: false },
  )
  // A pending request whose lifetime is over is expired by the server's sweep
  // (every two minutes, `approval-expiry-sweep`). Left to it, the world a run
  // reads depended on whether the sweep's minute fell inside the run: the
  // request still pending, or expired with its "Expired without decision."
  // line, audit and timeline rows. The seed runs the sweep's own step for it,
  // so the world is the one the sweep leaves, every run.
  for (const a of QA_APPROVALS) {
    if (a.status !== "pending" || a.expiresInHours > 0) continue
    await runApprovalExpiry({ orgId: ctx.orgId, requestId: ctx.id("qa-approval", a.handle) })
  }
}

/** Two personal saved ticket views and one shared with the org. */
export async function seedQaSavedViews(ctx: SeedContext, people: StandardPeople): Promise<void> {
  const { orgId } = ctx
  await withPrivilegedDb(orgId, "seed-standard:saved-views", async (tx) => {
    for (const [position, v] of QA_SAVED_VIEWS.entries()) {
      const owner = people[v.owner].id
      const { assignedToOwner, ...filters } = v.filters
      const payload = { filters: assignedToOwner ? { ...filters, assigned_to: owner } : filters }
      await tx.execute(
        sql`INSERT INTO ${S("kernel")}.saved_views (
              id, org_id, app, view_id, manifest_key, name, payload,
              owner_user_id, shared_with_org, is_default, position
            ) VALUES (
              ${ctx.id("qa-saved-view", v.viewId)}::uuid, ${orgId}::uuid, 'tickets', ${v.viewId}, NULL,
              ${v.name}, ${json(payload)}::jsonb, ${owner}::uuid, ${v.sharedWithOrg}, false, ${position}
            ) ON CONFLICT DO NOTHING`,
      )
    }
  })
}

export interface StandardMail {
  accounts: Record<QaMailboxKey, string>
  conversations: string[]
}

/**
 * Three unarmed mailboxes and their conversations (plaintext, a state the
 * product allows before a mailbox is armed), the Slack and GitHub connector
 * placeholders, and each person's locale.
 */
export async function seedQaMail(
  ctx: SeedContext,
  people: StandardPeople,
  encryptionKey: string | undefined,
): Promise<StandardMail> {
  const { orgId } = ctx
  const now = ctx.now.getTime()
  const M = S("app_mail")
  return withPrivilegedDb(orgId, "seed-standard:mail", async (tx) => {
    const accounts = {} as StandardMail["accounts"]
    for (const box of QA_MAILBOXES) {
      const ownerId = box.owner === "org" ? null : people[box.owner].id
      // A developer's own Gmail refresh token, when set, makes Elodie's mailbox real.
      const refreshToken =
        box.key === "adminGmail" ? (process.env.QA_GMAIL_REFRESH_TOKEN ?? null) : box.refreshToken
      const sealed = refreshToken !== null && encryptionKey !== undefined
      const connectionId = ctx.id("qa-mail-connection", box.key)
      await tx.execute(
        sql`INSERT INTO ${S("kernel")}.connected_accounts (
              id, org_id, app_name, connection_name, owner_type, owner_id,
              provider_type, identifier, display_name, provider_account_id,
              access_token_encrypted, refresh_token_encrypted,
              credentials_encrypted, status, created_by
            ) VALUES (
              ${connectionId}::uuid, ${orgId}::uuid, 'mail', ${box.connection},
              ${ownerId ? "user" : "org"}, ${ownerId}::uuid, 'oauth2', ${box.email},
              ${box.connectionDisplayName}, ${`mail-${box.email}`},
              ${sealed ? encryptSecret("qa-dev-placeholder-access-token", encryptionKey, CryptoContext.connectedAccountAccessToken) : null},
              ${sealed ? encryptSecret(refreshToken, encryptionKey, CryptoContext.connectedAccountRefreshToken) : null},
              NULL, 'active', ${ownerId ?? people.admin.id}::uuid
            )`,
      )
      const accountId = ctx.id("qa-mail-account", box.key)
      accounts[box.key] = accountId
      await tx.execute(
        sql`INSERT INTO ${M}.accounts (
              id, org_id, connected_account_id, owner_type, owner_id, provider,
              email_address, display_name, sync_status, last_sync_at, created_at, updated_at
            ) VALUES (
              ${accountId}::uuid, ${orgId}::uuid, ${connectionId}::uuid, ${ownerId ? "user" : "org"},
              ${ownerId}::uuid, ${box.connection}, ${box.email}, ${box.displayName}, 'idle',
              ${at(now - 5 * 60_000)}, ${at(now)}, ${at(now)}
            )`,
      )
    }

    const conversations: string[] = []
    for (const conv of QA_MAIL_CONVERSATIONS) {
      const box = QA_MAILBOXES.find((b) => b.key === conv.mailbox)
      if (!box) throw new Error(`standard seed: no mailbox ${conv.mailbox}`)
      const ownerId = box.owner === "org" ? null : people[box.owner].id
      const accountId = accounts[conv.mailbox]
      const id = ctx.id("qa-mail-conversation", conv.externalThreadId)
      const last = conv.messages[conv.messages.length - 1]?.hoursAgo ?? 1
      await tx.execute(
        sql`INSERT INTO ${M}.conversations (
              id, org_id, account_id, owner_type, owner_id,
              external_thread_id, subject, snippet, status,
              labels, is_read, is_starred, last_message_at, message_count, created_at, updated_at
            ) VALUES (
              ${id}::uuid, ${orgId}::uuid, ${accountId}::uuid, ${ownerId ? "user" : "org"}, ${ownerId}::uuid,
              ${conv.externalThreadId}, ${conv.subject}, ${conv.snippet}, ${conv.status},
              ${json(conv.labels)}::jsonb, ${conv.isRead}, ${conv.isStarred}, ${at(now - last * HOUR_MS)},
              ${conv.messages.length}, ${at(now - last * HOUR_MS)}, ${at(now)}
            )`,
      )
      conversations.push(id)
      for (const [i, m] of conv.messages.entries()) {
        const sentAt = at(now - m.hoursAgo * HOUR_MS)
        await tx.execute(
          sql`INSERT INTO ${M}.messages (
                id, org_id, conversation_id, account_id, external_message_id,
                message_references, from_address, to_addresses,
                cc_addresses, bcc_addresses, subject, text_body, html_body,
                snippet, is_read, is_starred, labels, direction, sent_at, created_at
              ) VALUES (
                ${ctx.id("qa-mail-message", `${conv.externalThreadId}:${i}`)}::uuid, ${orgId}::uuid,
                ${id}::uuid, ${accountId}::uuid, ${`${conv.externalThreadId}-msg-${i}`},
                '[]'::jsonb, ${json(m.from)}::jsonb, ${json(m.to)}::jsonb,
                '[]'::jsonb, '[]'::jsonb, ${m.subject}, ${m.textBody}, NULL,
                ${m.textBody.slice(0, 120)}, ${conv.isRead}, ${conv.isStarred}, ${json(conv.labels)}::jsonb,
                ${m.direction}, ${sentAt}, ${sentAt}
              )`,
        )
      }
    }

    for (const { key, locale } of QA_LOCALES) {
      await tx.execute(
        sql`UPDATE ${S("kernel")}.users SET locale = ${locale} WHERE id = ${people[key].id}::uuid`,
      )
    }

    for (const p of QA_CONNECTOR_PLACEHOLDERS) {
      await tx.execute(
        sql`INSERT INTO ${S("kernel")}.connected_accounts (
              id, org_id, app_name, connection_name, owner_type, owner_id,
              provider_type, identifier, display_name, provider_account_id,
              access_token_encrypted, refresh_token_encrypted,
              credentials_encrypted, status, created_by
            ) VALUES (
              ${ctx.id("qa-connection", p.app)}::uuid, ${orgId}::uuid, ${p.app}, 'default', 'user',
              ${people.admin.id}::uuid, 'oauth2', ${p.identifier}, ${p.displayName},
              ${`${p.app}-${p.identifier}`}, NULL, NULL, NULL, 'active', ${people.admin.id}::uuid
            )`,
      )
    }
    return { accounts, conversations }
  })
}
