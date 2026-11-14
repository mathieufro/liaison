// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import crypto from "node:crypto"
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import * as searchClientModule from "~/infra/search/client"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { appBridgeManifestRegistry, manifestRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { invalidateAuthCache, isUserAuthCurrent } from "~/modules/auth/auth-state"
import {
  discoverKernelUserColumns,
  eraseUser,
  KERNEL_USER_COLUMN_DISPOSITION,
} from "~/modules/erasure/erase-user"
import { IndexWriterTestAccess } from "~/modules/search/index-writer"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireTestLock()
  // A rebuild waits out twice the writers' "is a rebuild running" cache window
  // before reading and before dropping the old index; 100 ms instead of 1 s.
  IndexWriterTestAccess.setRebuildStateCacheMs(100)
})
afterAll(async () => {
  IndexWriterTestAccess.setRebuildStateCacheMs()
  await releaseTestLock()
})

beforeEach(async () => {
  orgId = (await createTestOrg()).id
  await ensureAppsForOrg(orgId)
  userId = await withSystemDb("erase-test-user", async (tx) => {
    const rows = extractRows<{ id: string }>(
      await tx.execute(
        drizzleSql`SELECT id FROM kernel.users WHERE org_id = ${orgId} ORDER BY created_at ASC LIMIT 1`,
      ),
    )
    return rows[0].id
  })
})

async function seedUserWithAppData(): Promise<{ userId: string; orgId: string }> {
  const ticketId = crypto.randomUUID()
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await withSystemDb("erase-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets (
        id, org_id, handle, subject, status, priority, channel, team, sensitivity,
        reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
        sla_elapsed_seconds, message_count, created_at, updated_at
      ) VALUES (
        ${ticketId}, ${orgId}, ${`tk-${suffix}`}, 'Subj', 'open', 'normal', 'manual',
        'support-eu', 'internal', ${`TK${suffix.replace(/[^A-Za-z0-9]/g, "").slice(0, 14)}`},
        3600, now() + interval '1 hour', now(), 0, 0, now(), now()
      )`)
    // NOT NULL anonymize column: app_tickets.api_keys.created_by is declared
    // userRef + onErase:"anonymize" and is NOT NULL — the exact path C1
    // proved the no-op cascade left un-erased. Post-erase the userId must be
    // gone from this column (re-pointed to the per-org sentinel user).
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.api_keys (
        id, org_id, key_hash, key_prefix, label, created_by, created_at, updated_at
      ) VALUES (
        ${crypto.randomUUID()}, ${orgId}, ${`kh-${suffix}`}, ${`kp-${suffix.slice(0, 6)}`},
        'erase-test-key', ${userId}, now(), now()
      )`)
    // anonymize-strategy: createdBy attribution on a shared ticket message
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (
        id, org_id, ticket_id, kind, sent_at, created_by, created_at
      ) VALUES (
        ${crypto.randomUUID()}, ${orgId}, ${ticketId}, 'note', now(), ${userId}, now()
      )`)
    // delete-strategy: a read marker that IS the user's activity
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.ticket_reads (
        org_id, ticket_id, user_id, read_at
      ) VALUES (
        ${orgId}, ${ticketId}, ${userId}, now()
      )`)
  })
  return { userId, orgId }
}

async function seedBareUser(): Promise<{ userId: string; orgId: string }> {
  return { userId, orgId }
}

/**
 * Seed the kernel-schema personal + shared data the erasure-001 fix must handle:
 * personal rows (agent_memory, user_preferences, routines, attention subs)
 * that must be DELETED, and shared/org content (skills, saved_views) whose author
 * link must be ANONYMIZED to NULL. The bootstrap admin already carries a
 * user_roles assignment, which must be DELETED too.
 */
async function seedUserWithKernelData(): Promise<void> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await withSystemDb("erase-kernel-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO kernel.agent_memory (org_id, user_id, type, name, description, content, required_scopes)
      VALUES (${orgId}, ${userId}, 'user', ${`mem-${suffix}`}, 'profile', 'likes terse replies', '{}'::text[])
    `)
    await tx.execute(drizzleSql`
      INSERT INTO kernel.user_preferences (user_id) VALUES (${userId})
    `)
    await tx.execute(drizzleSql`
      INSERT INTO kernel.attention_subscriptions (user_id, source, kinds)
      VALUES (${userId}, 'shopify', ARRAY['mention']::text[])
    `)
    // Personal routine (owner_user_id) — DELETE. Holds a personal prompt.
    await tx.execute(drizzleSql`
      INSERT INTO kernel.routines (
        org_id, owner_user_id, name, description, kind, cron, timezone,
        prompt, scopes, created_by_user_id, created_by_actor_type
      ) VALUES (
        ${orgId}, ${userId}, ${`rt-${suffix}`}, 'desc', 'recurring', '0 9 * * *', 'UTC',
        'my private prompt', ARRAY[]::text[], ${userId}, 'user'
      )
    `)
    // Shared skill authored by the user (author_user_id + created_by_user_id) —
    // ANONYMIZE to NULL; the skill body survives as org content.
    await tx.execute(drizzleSql`
      INSERT INTO kernel.skills (
        org_id, author_user_id, name, description, body,
        created_by_user_id, created_by_actor_type
      ) VALUES (
        ${orgId}, ${userId}, ${`sk-${suffix}`}, 'shared skill', 'do the thing',
        ${userId}, 'user'
      )
    `)
    // Saved view owned by the user — ANONYMIZE owner to NULL.
    await tx.execute(drizzleSql`
      INSERT INTO kernel.saved_views (org_id, app, view_id, name, payload, owner_user_id)
      VALUES (${orgId}, 'tickets', 'inbox', ${`view-${suffix}`}, '{}'::jsonb, ${userId})
    `)
  })
}

/**
 * The memory slice's own rows for the erased user: a personal agent with a
 * memory tree, a supersession chain, a checkpoint of a thread, and a message of
 * theirs that reached the search index.
 */
async function seedAgentMemoryTree(): Promise<{
  agentId: string
  threadId: string
  messageId: string
  checkpointId: string
  oldMemoryId: string
  newMemoryId: string
}> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return withSystemDb("erase-4m-seed", async (tx) => {
    const agentId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
        VALUES (${orgId}, 'personal', ${`erase4m${suffix.replace(/[^a-z0-9]/g, "")}`},
          'Erase Mem', ${userId}, '["*"]'::jsonb)
        RETURNING id`),
    )[0].id
    const threadId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.threads (org_id, handle, created_by)
        VALUES (${orgId}, ${`erase4m-${suffix}`}, ${userId}) RETURNING id`),
    )[0].id
    await tx.execute(drizzleSql`
      INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${threadId}, ${userId}, ${orgId})`)
    const messageId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
        VALUES (${threadId}, ${orgId}, ${userId}, 'indexed by the erased user', '{}'::text[])
        RETURNING id`),
    )[0].id
    const checkpointId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.agent_thread_checkpoints
          (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
        VALUES (${orgId}, ${agentId}, ${threadId}, ${messageId}, 'A summary.', '{}'::text[], 4, 1)
        RETURNING id`),
    )[0].id
    const oldMemoryId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.agent_memory
          (org_id, user_id, owner_agent_id, type, name, description, content, path,
           required_scopes, source_kind, source_thread_id, source_message_id,
           superseded_at, last_confirmed_at, last_recalled_at, recall_count,
           episode_from_message_id, episode_to_message_id)
        VALUES (${orgId}, ${userId}, ${agentId}, 'user', ${`old-${suffix}`}, 'the old fact',
          'It was 40.', ${`user/old-${suffix}.md`}, '{}'::text[], 'consolidation',
          ${threadId}, ${messageId}, now(), now(), now(), 2, ${messageId}, ${messageId})
        RETURNING id`),
    )[0].id
    const newMemoryId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.agent_memory
          (org_id, user_id, owner_agent_id, type, name, description, content, path,
           required_scopes, source_kind, supersedes_id, last_confirmed_at)
        VALUES (${orgId}, ${userId}, ${agentId}, 'user', ${`new-${suffix}`}, 'the new fact',
          'It is 65.', ${`user/new-${suffix}.md`}, '{}'::text[], 'consolidation',
          ${oldMemoryId}, now())
        RETURNING id`),
    )[0].id
    return { agentId, threadId, messageId, checkpointId, oldMemoryId, newMemoryId }
  })
}

/**
 * Seed the erased user into every user-id column slice 2b added, next to a
 * second, surviving user: kernel.audit_log.requester_user_id,
 * room_member_snapshot and disclosure_list on an agent-turn row, and
 * kernel.messages.disclosure_list on a scoped message in a shared thread.
 */
async function seedSlice2bUserIdColumns(): Promise<{
  otherUserId: string
  auditId: string
  messageId: string
}> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return withSystemDb("erase-2b-seed", async (tx) => {
    const otherUserId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (org_id, email, name)
        VALUES (${orgId}, ${`other-2b-${suffix}@t.co`}, 'Other')
        RETURNING id
      `),
    )[0].id
    const threadId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.threads (org_id, handle, created_by)
        VALUES (${orgId}, ${`erase-2b-${suffix}`}, ${otherUserId})
        RETURNING id
      `),
    )[0].id
    for (const uid of [userId, otherUserId]) {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${threadId}, ${uid}, ${orgId})
      `)
    }
    const messageId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.messages (
          thread_id, org_id, author_id, content, required_scopes, disclosure_list
        ) VALUES (
          ${threadId}, ${orgId}, ${otherUserId}, 'disclosed', ARRAY['erase:2b']::text[],
          ARRAY[${userId}, ${otherUserId}]::uuid[]
        )
        RETURNING id
      `),
    )[0].id
    const auditId = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.audit_log (
          org_id, actor_type, action, requester_user_id, room_member_snapshot, disclosure_list
        ) VALUES (
          ${orgId}, 'agent', 'share_anyway', ${userId},
          ${JSON.stringify([userId, otherUserId])}::text::jsonb,
          ARRAY[${userId}, ${otherUserId}]::uuid[]
        )
        RETURNING id
      `),
    )[0].id
    return { otherUserId, auditId, messageId }
  })
}

function readSlice2bColumns(
  auditId: string,
  messageId: string,
): Promise<{
  requesterUserId: string | null
  roomMemberSnapshot: string[] | null
  auditDisclosure: string[] | null
  messageDisclosure: string[] | null
}> {
  return withSystemDb("erase-2b-read", async (tx) => {
    const audit = extractRows<{
      requesterUserId: string | null
      roomMemberSnapshot: string[] | null
      auditDisclosure: string[] | null
    }>(
      await tx.execute(drizzleSql`
        SELECT requester_user_id AS "requesterUserId",
               room_member_snapshot AS "roomMemberSnapshot",
               disclosure_list::text[] AS "auditDisclosure"
        FROM kernel.audit_log WHERE id = ${auditId}
      `),
    )[0]
    const message = extractRows<{ messageDisclosure: string[] | null }>(
      await tx.execute(drizzleSql`
        SELECT disclosure_list::text[] AS "messageDisclosure"
        FROM kernel.messages WHERE id = ${messageId}
      `),
    )[0]
    return { ...audit, messageDisclosure: message.messageDisclosure }
  })
}

const SLICE_2B_USER_COLUMNS = [
  "audit_log.requester_user_id",
  "audit_log.room_member_snapshot",
  "audit_log.disclosure_list",
  "messages.disclosure_list",
] as const

function kernelCounts(uid: string): Promise<{
  memory: number
  prefs: number
  routines: number
  attnSubs: number
  userRoles: number
  skillsAuthored: number
  savedViewsOwned: number
}> {
  return withSystemDb("erase-kernel-counts", async (tx) => {
    const one = async (q: SQL) => extractRows<{ n: number }>(await tx.execute(q))[0].n
    return {
      memory: await one(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.agent_memory WHERE user_id = ${uid}`,
      ),
      prefs: await one(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.user_preferences WHERE user_id = ${uid}`,
      ),
      routines: await one(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.routines WHERE owner_user_id = ${uid} OR created_by_user_id = ${uid}`,
      ),
      attnSubs: await one(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.attention_subscriptions WHERE user_id = ${uid}`,
      ),
      userRoles: await one(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.user_roles WHERE user_id = ${uid}`,
      ),
      skillsAuthored: await one(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.skills WHERE author_user_id = ${uid} OR created_by_user_id = ${uid}`,
      ),
      savedViewsOwned: await one(
        drizzleSql`SELECT count(*)::int AS n FROM kernel.saved_views WHERE owner_user_id = ${uid}`,
      ),
    }
  })
}

function countUserPiiAcrossAppSchemas(uid: string): Promise<number> {
  return withSystemDb("erase-count-pii", async (tx) => {
    const reads = extractRows<{ n: number }>(
      await tx.execute(
        drizzleSql`SELECT count(*)::int AS n FROM app_tickets.ticket_reads WHERE user_id = ${uid}`,
      ),
    )
    const msgs = extractRows<{ n: number }>(
      await tx.execute(
        drizzleSql`SELECT count(*)::int AS n FROM app_tickets.messages WHERE created_by = ${uid}`,
      ),
    )
    // NOT NULL anonymize column — the C1 regression guard. A no-op cascade
    // leaves the userId here and this count stays > 0.
    const apiKeys = extractRows<{ n: number }>(
      await tx.execute(
        drizzleSql`SELECT count(*)::int AS n FROM app_tickets.api_keys WHERE created_by = ${uid}`,
      ),
    )
    return reads[0].n + msgs[0].n + apiKeys[0].n
  })
}

function readUserRow(uid: string): Promise<{ email: string; name: string } | null> {
  return withSystemDb("erase-read-user", async (tx) => {
    const rows = extractRows<{ email: string; name: string }>(
      await tx.execute(drizzleSql`SELECT email, name FROM kernel.users WHERE id = ${uid}`),
    )
    return rows[0] ?? null
  })
}

function auditEntriesFor(
  oid: string,
  action: string,
  uid: string,
): Promise<Array<{ actorType: string }>> {
  return withSystemDb("erase-audit", async (tx) =>
    extractRows<{ actorType: string }>(
      await tx.execute(
        drizzleSql`SELECT actor_type AS "actorType" FROM kernel.audit_log
                   WHERE org_id = ${oid} AND action = ${action} AND entity_id = ${uid}`,
      ),
    ),
  )
}

function auditCount(): Promise<number> {
  return withSystemDb("erase-audit-count", async (tx) => {
    const rows = extractRows<{ n: number }>(
      await tx.execute(drizzleSql`SELECT count(*)::int AS n FROM kernel.audit_log`),
    )
    return rows[0].n
  })
}

describe("erase-user cascade (G2–G6)", () => {
  test("deletes delete-strategy rows and anonymizes anonymize-strategy fields (G2,G4)", async () => {
    const seeded = await seedUserWithAppData()
    const res = await eraseUser(seeded.userId)
    expect(res.exitCode).toBe(0)
    expect(await countUserPiiAcrossAppSchemas(seeded.userId)).toBe(0)
  })

  test("contacts the person owns: unused private ones go, used ones go to an admin, org ones lose their owner", async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const ids = await withSystemDb("erase-contacts-seed", async (tx) => {
      // A second admin to hand used contacts to.
      const [admin] = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
          VALUES (gen_random_uuid(), ${orgId}, ${`admin2-${tag}@x.example`}, 'Admin Two', 'active', 'h')
          RETURNING id`),
      )
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_roles (user_id, role_id, org_id)
        SELECT ${admin.id}::uuid, r.id, r.org_id FROM kernel.roles r
         WHERE r.org_id = ${orgId}::uuid AND r.name = 'admin'`)
      const insert = async (key: string, access: string) =>
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            INSERT INTO kernel.contacts (org_id, handle, email, org_access, owner_user_id)
            VALUES (${orgId}, ${`@${key}-${tag}`}, ${`${key}-${tag}@x.example`}, ${access}, ${userId})
            RETURNING id`),
        )[0].id
      const unused = await insert("unused", "none")
      // Its discussion, which only the person ever opened: it goes with it.
      const [discussion] = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.threads (org_id, handle, type, hidden_from_list, created_by)
          VALUES (${orgId}, ${`contact-primary:${unused}`}, 'thread', true, ${userId}) RETURNING id`),
      )
      await tx.execute(drizzleSql`
        INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${discussion.id}, ${userId}, ${orgId})`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.thread_references (thread_id, org_id, app, entity_type, entity_id, added_by)
        VALUES (${discussion.id}, ${orgId}, 'kernel', 'contact', ${unused}, ${userId})`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
        VALUES (${discussion.id}, ${orgId}, ${userId}, 'Met at the fair', '{}'::text[])`)
      // Only the person's own traces point at this one: a file they attached,
      // a reference from a thread nobody else is in. Not an org use.
      const ownOnly = await insert("ownonly", "none")
      await tx.execute(drizzleSql`
        INSERT INTO kernel.files (org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by)
        VALUES (${orgId}, 'kernel', 'contact', ${ownOnly}, 'note.txt', 'text/plain', 1, ${`k/${tag}`}, ${userId})`)
      const [thread] = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.threads (org_id, handle, type, created_by)
          VALUES (${orgId}, ${`own-${tag}`}, 'agent_chat', ${userId}) RETURNING id`),
      )
      await tx.execute(drizzleSql`
        INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${thread.id}, ${userId}, ${orgId})`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.thread_references (thread_id, org_id, app, entity_type, entity_id, added_by)
        VALUES (${thread.id}, ${orgId}, 'kernel', 'contact', ${ownOnly}, ${userId})`)
      const used = await insert("used", "none")
      const orgWide = await insert("orgwide", "editor")
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity, reply_token,
          sla_target_seconds, sla_deadline, sla_elapsed_seconds, message_count, contact_id,
          created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${`tk-c-${tag}`}, 'S', 'open', 'normal', 'manual', 'internal',
          ${`RT${tag}`}, 3600, now(), 0, 0, ${used}, now(), now()
        )`)
      return { admin: admin.id, unused, used, orgWide, ownOnly, discussion: discussion.id }
    })

    expect((await eraseUser(userId)).exitCode).toBe(0)

    const rows = await withSystemDb("erase-contacts-read", async (tx) =>
      extractRows<{ id: string; owner: string | null; acl: string[] }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id, owner_user_id::text AS owner, acl_user_ids AS acl
            FROM kernel.contacts WHERE org_id = ${orgId}::uuid AND handle LIKE ${`%-${tag}`}`),
      ),
    )
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.has(ids.unused)).toBe(false)
    expect(byId.has(ids.ownOnly)).toBe(false)
    expect(byId.get(ids.used)).toMatchObject({ owner: ids.admin, acl: [ids.admin] })
    expect(byId.get(ids.orgWide)?.owner).toBeNull()
    const discussions = await withSystemDb("erase-contacts-discussion", async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM kernel.threads WHERE id = ${ids.discussion}::uuid`),
      ),
    )
    expect(discussions[0].n).toBe(0)
    // The hand-over is announced (audited) as a share.
    const events = await withSystemDb("erase-contacts-events", async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM kernel.pending_events
           WHERE org_id = ${orgId}::uuid AND payload->>'entity' = 'contact'
             AND payload->>'action' = 'share' AND payload->>'entityId' = ${ids.used}`),
      ),
    )
    expect(events[0].n).toBe(1)
    // And the FK is RESTRICT: a hard delete of an owner is refused, never silent.
    await expect(
      withSystemDb("erase-contacts-restrict", (tx) =>
        tx.execute(drizzleSql`DELETE FROM kernel.users WHERE id = ${ids.admin}::uuid`),
      ),
    ).rejects.toThrow()
  })

  test("tombstones kernel.users, not hard-delete (G3)", async () => {
    await seedUserWithAppData()
    await eraseUser(userId)
    const u = await readUserRow(userId)
    expect(u).not.toBeNull()
    expect(u!.email).toBe(`deleted-user-${userId}`)
    expect(u!.name).toBe(`deleted-user-${userId}`)
  })

  test("writes exactly one system audit entry (G5)", async () => {
    const { orgId: oid } = await seedUserWithAppData()
    await eraseUser(userId)
    const entries = await auditEntriesFor(oid, "user.erased", userId)
    expect(entries).toHaveLength(1)
    expect(entries[0].actorType).toBe("system")
  })

  test("unknown userId: non-zero exit, no mutation, no audit (G6)", async () => {
    const before = await auditCount()
    const res = await eraseUser("00000000-0000-0000-0000-000000000000")
    expect(res.exitCode).not.toBe(0)
    expect(await auditCount()).toBe(before)
  })

  test("re-running on an already-erased user is idempotent: exit 0, no second audit entry", async () => {
    const { orgId: oid } = await seedUserWithAppData()
    await eraseUser(userId)
    const res = await eraseUser(userId)
    expect(res.exitCode).toBe(0)
    expect(await auditEntriesFor(oid, "user.erased", userId)).toHaveLength(1)
  })

  test("a strategy failure mid-transaction rolls back entirely and writes no audit", async () => {
    await seedUserWithAppData()
    const res = await eraseUser(userId, { injectMissingColumnApp: true })
    expect(res.exitCode).not.toBe(0)
    const u = await readUserRow(userId)
    expect(u!.email).not.toContain("deleted-user-")
  })

  test("user with no app data: only tombstone + one audit entry (boundary)", async () => {
    const { orgId: oid } = await seedBareUser()
    const res = await eraseUser(userId)
    expect(res.exitCode).toBe(0)
    expect(await auditEntriesFor(oid, "user.erased", userId)).toHaveLength(1)
  })

  test("NOT NULL anonymize column: userId is gone, FK re-pointed to sentinel (C1/G4)", async () => {
    // app_tickets.api_keys.created_by is userRef + onErase:"anonymize" + NOT
    // NULL — the exact class C1 proved the old no-op cascade left un-erased.
    const { orgId: oid } = await seedUserWithAppData()
    const res = await eraseUser(userId)
    expect(res.exitCode).toBe(0)

    const after = await withSystemDb("erase-c1-check", async (tx) => {
      const erased = extractRows<{ n: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS n FROM app_tickets.api_keys
                     WHERE org_id = ${oid} AND created_by = ${userId}`,
        ),
      )[0].n
      // The row must still exist (anonymize, not delete) but attributed to a
      // retained sentinel user — never the erased id.
      const total = extractRows<{ n: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS n FROM app_tickets.api_keys
                     WHERE org_id = ${oid} AND label = 'erase-test-key'`,
        ),
      )[0].n
      const sentinelRetained = extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM kernel.users u
          WHERE u.id = (
            SELECT created_by FROM app_tickets.api_keys
            WHERE org_id = ${oid} AND label = 'erase-test-key' LIMIT 1
          )
        `),
      )[0].n
      return { erased, total, sentinelRetained }
    })
    expect(after.erased).toBe(0) // userId fully gone from the app schema (G4)
    expect(after.total).toBe(1) // row preserved (anonymize, not delete)
    expect(after.sentinelRetained).toBe(1) // FK still valid → sentinel user row
  })

  test("revokes the erased user's sessions and rejects an already-issued token (B2)", async () => {
    await seedUserWithAppData()

    // Capture the auth-version claims an access token issued just before erasure
    // would carry, and seed a refresh-token session for the user.
    const { authVersion, permissionVersion } = await withSystemDb("erase-b2-claims", async (tx) => {
      const rows = extractRows<{ authVersion: number; permissionVersion: number }>(
        await tx.execute(drizzleSql`
          SELECT auth_version AS "authVersion", permission_version AS "permissionVersion"
          FROM kernel.users WHERE id = ${userId}
        `),
      )
      await tx.execute(drizzleSql`
        INSERT INTO kernel.sessions (org_id, user_id, refresh_token_hash, expires_at)
        VALUES (${orgId}, ${userId}, ${`rt-${crypto.randomUUID()}`}, now() + interval '30 days')
      `)
      return rows[0]
    })

    // Pre-erasure: a token with these claims authenticates.
    invalidateAuthCache(userId)
    expect(await isUserAuthCurrent({ userId, orgId, authVersion, permissionVersion })).toBe(true)

    const res = await eraseUser(userId)
    expect(res.exitCode).toBe(0)

    // Post-erasure: the same already-issued token is rejected (status flipped to
    // deactivated + auth/permission versions bumped), and the session is gone.
    invalidateAuthCache(userId)
    expect(await isUserAuthCurrent({ userId, orgId, authVersion, permissionVersion })).toBe(false)

    const sessionCount = await withSystemDb(
      "erase-b2-sessions",
      async (tx) =>
        extractRows<{ n: number }>(
          await tx.execute(
            drizzleSql`SELECT count(*)::int AS n FROM kernel.sessions WHERE user_id = ${userId}`,
          ),
        )[0].n,
    )
    expect(sessionCount).toBe(0)

    // Residual re-auth material + PII are cleared: recovery codes and TOTP are
    // credentials that could otherwise re-authenticate the erased user;
    // settings/timezone/locale may carry personal data.
    const tombstone = await withSystemDb(
      "erase-b2-tombstone",
      async (tx) =>
        extractRows<{
          totpSecret: string | null
          totpEnabled: boolean
          recoveryCodes: unknown
          timezone: string | null
          locale: string | null
          settings: unknown
          passwordHash: string | null
        }>(
          await tx.execute(drizzleSql`
          SELECT totp_secret AS "totpSecret", totp_enabled AS "totpEnabled",
                 recovery_codes AS "recoveryCodes", timezone, locale, settings,
                 password_hash AS "passwordHash"
          FROM kernel.users WHERE id = ${userId}
        `),
        )[0],
    )
    expect(tombstone.totpSecret).toBeNull()
    expect(tombstone.totpEnabled).toBe(false)
    expect(tombstone.recoveryCodes).toBeNull()
    expect(tombstone.timezone).toBeNull()
    expect(tombstone.locale).toBeNull()
    expect(tombstone.settings).toEqual({})
    expect(tombstone.passwordHash).toBeNull()
  })

  test("erases userRef columns of a registry-installed app NOT in the old hardcoded list (B1)", async () => {
    // Register a lightweight manifest into the LIVE registries — the same source
    // the cascade now enumerates. An app like this (outside the former 6
    // hardcoded in-tree manifests) is exactly what the old MANIFESTS array
    // missed. Its userRef column must be erased.
    const appName = "erasuretest"
    const appSchema = `app_${appName}`
    await withSystemDb("erase-b1-setup", async (tx) => {
      await tx.execute(drizzleSql.raw(`CREATE SCHEMA IF NOT EXISTS "${appSchema}"`))
      await tx.execute(
        drizzleSql.raw(`CREATE TABLE IF NOT EXISTS "${appSchema}".notes (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          org_id UUID NOT NULL,
          author_id UUID,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`),
      )
    })
    manifestRegistry.set([orgId, appName], { name: appName, uiBundleUrl: null })
    appBridgeManifestRegistry.set([orgId, appName], {
      name: appName,
      schema: {
        notes: {
          fields: {
            authorId: { type: "uuid", userRef: true, onErase: "delete" },
          },
        },
      },
    })

    try {
      await withSystemDb("erase-b1-seed", async (tx) => {
        await tx.execute(drizzleSql`
          INSERT INTO ${drizzleSql.raw(`"${appSchema}".notes`)} (org_id, author_id)
          VALUES (${orgId}, ${userId})
        `)
      })

      const res = await eraseUser(userId)
      expect(res.exitCode).toBe(0)

      const remaining = await withSystemDb(
        "erase-b1-check",
        async (tx) =>
          extractRows<{ n: number }>(
            await tx.execute(drizzleSql`
            SELECT count(*)::int AS n FROM ${drizzleSql.raw(`"${appSchema}".notes`)}
            WHERE author_id = ${userId}
          `),
          )[0].n,
      )
      expect(remaining).toBe(0)
    } finally {
      manifestRegistry.delete([orgId, appName])
      appBridgeManifestRegistry.delete([orgId, appName])
      await withSystemDb("erase-b1-teardown", async (tx) => {
        await tx.execute(drizzleSql.raw(`DROP SCHEMA IF EXISTS "${appSchema}" CASCADE`))
      })
    }
  })

  test("deletes personal kernel rows and anonymizes shared kernel content (erasure-001)", async () => {
    // Before erasure: the tombstone (UPDATE of kernel.users) leaves every FK to
    // users.id pointing at a retained row, so ON DELETE CASCADE never fires and
    // these kernel rows previously SURVIVED erasure. Assert they're now handled.
    await seedUserWithKernelData()
    const before = await kernelCounts(userId)
    expect(before.memory).toBeGreaterThan(0)
    expect(before.prefs).toBeGreaterThan(0)
    expect(before.routines).toBeGreaterThan(0)
    expect(before.attnSubs).toBeGreaterThan(0)
    expect(before.userRoles).toBeGreaterThan(0) // bootstrap admin role assignment
    expect(before.skillsAuthored).toBeGreaterThan(0)
    expect(before.savedViewsOwned).toBeGreaterThan(0)

    const res = await eraseUser(userId)
    expect(res.exitCode).toBe(0)

    const after = await kernelCounts(userId)
    // DELETE — clearly personal, user-owned.
    expect(after.memory).toBe(0)
    expect(after.prefs).toBe(0)
    expect(after.routines).toBe(0)
    expect(after.attnSubs).toBe(0)
    // DELETE — role assignment rows (the user no longer exists).
    expect(after.userRoles).toBe(0)
    // ANONYMIZE — shared/org content survives but the PII link is severed.
    expect(after.skillsAuthored).toBe(0)
    expect(after.savedViewsOwned).toBe(0)

    // The shared skill ROW itself must still exist (anonymized, not deleted).
    const skillsSurviving = await withSystemDb(
      "erase-skill-survive",
      async (tx) =>
        extractRows<{ n: number }>(
          await tx.execute(
            drizzleSql`SELECT count(*)::int AS n FROM kernel.skills WHERE org_id = ${orgId}`,
          ),
        )[0].n,
    )
    expect(skillsSurviving).toBeGreaterThan(0)
  })

  test("deletes the personal agent outright, and its owned routine and skill follow agent-ownership semantics (agents slice)", async () => {
    // Every user gets a personal agent at bootstrap (kind='personal',
    // owner_user_id = the user). Find it, then give it a routine it owns
    // (owner_agent_id) and a skill it owns (owner_agent_id) plus authors
    // (author_user_id) — the two FKs that RESTRICT the agent's delete unless
    // the erasure cascade clears them first.
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const agentId = await withSystemDb("erase-agent-seed", async (tx) => {
      const rows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id FROM kernel.agents WHERE owner_user_id = ${userId} AND kind = 'personal'
        `),
      )
      const personalAgentId = rows[0].id

      // owner_user_id is a NOT NULL provenance column, distinct from ownership
      // (owner_agent_id). Point it at a SURVIVING second user so the existing
      // `DELETE ... WHERE owner_user_id = erasedUserId` statement cannot catch
      // this routine by coincidence — only the new owner_agent_id-keyed
      // statement can, which is exactly the hole this test proves closed.
      const survivorRows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.users (org_id, email, name)
          VALUES (${orgId}, ${`survivor-${suffix}@t.co`}, 'Survivor')
          RETURNING id
        `),
      )
      const survivorUserId = survivorRows[0].id

      await tx.execute(drizzleSql`
        INSERT INTO kernel.routines (
          org_id, owner_agent_id, owner_user_id, name, description, kind, cron, timezone,
          prompt, scopes, created_by_user_id, created_by_actor_type
        ) VALUES (
          ${orgId}, ${personalAgentId}, ${survivorUserId}, ${`rt-${suffix}`}, 'desc', 'recurring',
          '0 9 * * *', 'UTC', 'agent owned prompt', ARRAY[]::text[], ${userId}, 'user'
        )
      `)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.skills (
          org_id, owner_agent_id, author_user_id, name, description, body,
          created_by_user_id, created_by_actor_type
        ) VALUES (
          ${orgId}, ${personalAgentId}, ${userId}, ${`sk-agent-${suffix}`}, 'agent owned skill',
          'do the thing', ${userId}, 'user'
        )
      `)
      // Memory row owned via owner_agent_id only (rekey, migration 0055):
      // user_id points at the SURVIVING second user so the existing
      // `DELETE ... WHERE user_id = erasedUserId` statement cannot catch it
      // by coincidence — only the new owner_agent_id-keyed statement can,
      // mirroring the routine case above.
      await tx.execute(drizzleSql`
        INSERT INTO kernel.agent_memory (
          org_id, owner_agent_id, user_id, type, name, description, content
        , required_scopes) VALUES (
          ${orgId}, ${personalAgentId}, ${survivorUserId}, 'user', ${`mem-agent-${suffix}`},
          'agent owned memory', 'owned via owner_agent_id only'
        , '{}'::text[])
      `)
      return personalAgentId
    })

    const res = await eraseUser(userId)
    expect(res.exitCode).toBe(0)

    const after = await withSystemDb("erase-agent-check", async (tx) => {
      const agentRows = extractRows<{ n: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS n FROM kernel.agents WHERE id = ${agentId}`,
        ),
      )
      const routineRows = extractRows<{ n: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS n FROM kernel.routines WHERE owner_agent_id = ${agentId}`,
        ),
      )
      const skillRows = extractRows<{ ownerAgentId: string | null; authorUserId: string | null }>(
        await tx.execute(drizzleSql`
          SELECT owner_agent_id AS "ownerAgentId", author_user_id AS "authorUserId"
          FROM kernel.skills WHERE name = ${`sk-agent-${suffix}`}
        `),
      )
      const memoryRows = extractRows<{ n: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS n FROM kernel.agent_memory WHERE owner_agent_id = ${agentId}`,
        ),
      )
      return {
        agentCount: agentRows[0].n,
        routineCount: routineRows[0].n,
        skill: skillRows[0] ?? null,
        memoryCount: memoryRows[0].n,
      }
    })

    expect(after.agentCount).toBe(0) // personal agent row is GONE
    expect(after.routineCount).toBe(0) // the agent-owned routine is GONE
    expect(after.skill).not.toBeNull() // the skill SURVIVES (anonymize, not delete)
    expect(after.skill!.ownerAgentId).toBeNull()
    expect(after.skill!.authorUserId).toBeNull()
    expect(after.memoryCount).toBe(0) // the agent-owned memory row is GONE
  })

  test("completeness sweep THROWS (refuses to erase) for an unaccounted kernel user-column", async () => {
    // Simulate a future kernel table carrying a user-referencing column that was
    // never added to KERNEL_USER_COLUMN_DISPOSITION. The sweep must convert this
    // silent-survival risk into a loud, gated failure: refuse to erase, roll the
    // whole transaction back, write no audit, leave the user un-tombstoned.
    await seedUserWithKernelData()
    const before = await auditCount()

    const res = await eraseUser(userId, {
      injectUnaccountedKernelColumn: { table: "future_table", column: "secret_user_id" },
    })
    expect(res.exitCode).not.toBe(0)
    expect(res.message ?? "").toContain("unaccounted")

    // Rollback proof: no audit row, user not tombstoned, personal rows intact.
    expect(await auditCount()).toBe(before)
    const u = await readUserRow(userId)
    expect(u!.email).not.toContain("deleted-user-")
    expect((await kernelCounts(userId)).memory).toBeGreaterThan(0)
  })

  test("slice 2b user-id columns: erasure succeeds and applies their retain disposition, other users' entries untouched", async () => {
    // audit_log is append-only (UPDATE/DELETE revoked from the app role) and
    // its actor_id is RETAINed; messages keeps author and participants. The
    // new columns follow the same disposition: the rows keep the id, which
    // now points at the tombstoned user row.
    const { otherUserId, auditId, messageId } = await seedSlice2bUserIdColumns()

    const res = await eraseUser(userId)
    expect(res.message).toBeUndefined()
    expect(res.exitCode).toBe(0)
    expect((await readUserRow(userId))!.email).toBe(`deleted-user-${userId}`)

    const after = await readSlice2bColumns(auditId, messageId)
    expect(after.requesterUserId).toBe(userId)
    expect([...(after.roomMemberSnapshot ?? [])].sort()).toEqual([userId, otherUserId].sort())
    expect([...(after.auditDisclosure ?? [])].sort()).toEqual([userId, otherUserId].sort())
    expect([...(after.messageDisclosure ?? [])].sort()).toEqual([userId, otherUserId].sort())
  })

  test("completeness sweep discovers every slice 2b user-id column (uuid, uuid[] and jsonb)", async () => {
    // Each column must be seen by the sweep: dropping its disposition entry
    // must make the erasure refuse and name that exact column. A column the
    // sweep cannot see would let the erasure succeed silently.
    await seedSlice2bUserIdColumns()
    for (const key of SLICE_2B_USER_COLUMNS) {
      const res = await eraseUser(userId, { omitKernelDispositions: [key] })
      expect({ key, exitCode: res.exitCode }).toEqual({ key, exitCode: 1 })
      expect(res.message ?? "").toContain(`unaccounted for: ${key}`)
    }
    // Every refusal rolled back: the user is still not tombstoned.
    expect((await readUserRow(userId))!.email).not.toContain("deleted-user-")
  })

  // --- P4m-T32: the memory slice's new columns, table and index documents ---

  test("the kernel user column completeness sweep accounts for every new memory and checkpoint column", async () => {
    // Every column P4m-T04 and P4m-T05 added, carrying this user's data, must
    // leave the sweep with nothing unaccounted for.
    await seedAgentMemoryTree()
    const res = await eraseUser(userId)
    expect(res.message ?? "").not.toContain("unaccounted for")
    expect(res.exitCode).toBe(0)
  })

  test("erasing a user deletes their personal agent's checkpoints before the agent row", async () => {
    const { checkpointId } = await seedAgentMemoryTree()
    const res = await eraseUser(userId)
    expect(res.message).toBeUndefined()
    expect(res.exitCode).toBe(0)
    const left = await withSystemDb("erase-4m-checkpoints", async (tx) =>
      extractRows<{ n: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS n FROM kernel.agent_thread_checkpoints WHERE id = ${checkpointId}`,
        ),
      ),
    )
    expect(left[0].n).toBe(0)
  })

  test("deleting a superseded memory row nulls the supersedes id on the row pointing at it and deletes nothing else", async () => {
    const { oldMemoryId, newMemoryId } = await seedAgentMemoryTree()
    await withSystemDb("erase-4m-supersession", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM kernel.agent_memory WHERE id = ${oldMemoryId}`)
    })
    const rows = await withSystemDb("erase-4m-supersession-read", async (tx) =>
      extractRows<{ id: string; supersedes_id: string | null }>(
        await tx.execute(
          drizzleSql`SELECT id, supersedes_id FROM kernel.agent_memory WHERE id = ${newMemoryId}`,
        ),
      ),
    )
    // ON DELETE SET NULL: the surviving current fact stays, minus its pointer.
    expect(rows).toHaveLength(1)
    expect(rows[0].supersedes_id).toBeNull()
  })

  test("erasing a user removes their message and window documents from the index", async () => {
    const { messageId, threadId } = await seedAgentMemoryTree()
    const deleted: string[][] = []
    const spy = spyOn(searchClientModule, "getMeili").mockReturnValue({
      index: () => ({
        deleteDocuments: async (ids: string[]) => {
          deleted.push(ids)
          return { taskUid: 1 }
        },
      }),
      tasks: { waitForTask: async () => undefined },
    } as never)
    const { LiveIndexTestAccess, flushLiveIndexOnce } = await import(
      "~/modules/search/live-index-queue"
    )
    await LiveIndexTestAccess.clear()
    try {
      const res = await eraseUser(userId)
      expect(res.exitCode).toBe(0)
      // The removal is decided inside the erasure and recorded durably; the
      // live index flusher applies it (within about a second in production).
      // Nothing in the erasure waits for Meili.
      expect(deleted).toEqual([])
      while ((await flushLiveIndexOnce()) > 0) {}
    } finally {
      spy.mockRestore()
      await LiveIndexTestAccess.clear()
    }
    const all = deleted.flat()
    expect(all.length).toBeGreaterThan(0)
    // The message's own document AND every window document covering it.
    expect(all.some((id) => id.includes(messageId))).toBe(true)
    expect(threadId.length).toBeGreaterThan(0)
  })

  test("erasing a node owner with a node, a job, a session and a confirmation succeeds and leaves none of their rows", async () => {
    // A role agent (no owner), so the personal agent's own cascade cannot be
    // what removes these rows: the erasure must delete them itself.
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const ids = await withSystemDb("erase-node-seed", async (tx) => {
      const agentId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
          VALUES (${orgId}, 'role', ${`erasenode${suffix.replace(/[^a-z0-9]/g, "")}`},
            'Erase Node', '["*"]'::jsonb)
          RETURNING id`),
      )[0].id
      const nodeId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.nodes (org_id, owner_user_id, device_id, name)
          VALUES (${orgId}, ${userId}, ${`dev-${suffix}`}, 'Erase laptop')
          RETURNING id`),
      )[0].id
      const jobId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.node_jobs
            (org_id, owner_user_id, agent_id, node_id, source, prompt, requester_user_id)
          VALUES (${orgId}, ${userId}, ${agentId}, ${nodeId}, 'app', 'fix it', ${userId})
          RETURNING id`),
      )[0].id
      const sessionId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.node_sessions
            (org_id, owner_user_id, node_id, job_id, agent_id, source, config_kind,
             title, prompt, folder_path, model, level)
          VALUES (${orgId}, ${userId}, ${nodeId}, ${jobId}, ${agentId}, 'app', 'owner',
            'Fix it', 'fix it', '/Users/someone/code', 'claude-haiku-4-5', 'strict')
          RETURNING id`),
      )[0].id
      await tx.execute(drizzleSql`
        INSERT INTO kernel.node_session_events (session_id, seq, at, type, payload)
        VALUES (${sessionId}, 1, now(), 'status', '{"status":"queued"}'::jsonb)`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.node_level_confirmations
          (org_id, owner_user_id, node_id, agent_id, level, purpose, expires_at)
        VALUES (${orgId}, ${userId}, ${nodeId}, ${agentId}, 'open', 'profile_raise',
          now() + interval '5 minutes')`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.node_capabilities (node_id, org_id, owner_user_id)
        VALUES (${nodeId}, ${orgId}, ${userId})`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.node_profiles (org_id, node_owner_user_id, agent_id, level)
        VALUES (${orgId}, ${userId}, ${agentId}, 'standard')`)
      return { nodeId, jobId, sessionId }
    })

    const res = await eraseUser(userId)
    expect(res.message).toBeUndefined()
    expect(res.exitCode).toBe(0)

    const left = await withSystemDb(
      "erase-node-left",
      async (tx) =>
        extractRows<Record<string, number>>(
          await tx.execute(drizzleSql`
          SELECT
            (SELECT count(*)::int FROM kernel.nodes WHERE owner_user_id = ${userId}) AS nodes,
            (SELECT count(*)::int FROM kernel.node_jobs
              WHERE owner_user_id = ${userId} OR requester_user_id = ${userId}) AS jobs,
            (SELECT count(*)::int FROM kernel.node_sessions WHERE owner_user_id = ${userId}) AS sessions,
            (SELECT count(*)::int FROM kernel.node_session_events
              WHERE session_id = ${ids.sessionId}) AS events,
            (SELECT count(*)::int FROM kernel.node_level_confirmations
              WHERE owner_user_id = ${userId}) AS confirmations,
            (SELECT count(*)::int FROM kernel.node_capabilities WHERE owner_user_id = ${userId}) AS capabilities,
            (SELECT count(*)::int FROM kernel.node_profiles WHERE node_owner_user_id = ${userId}) AS profiles
        `),
        )[0],
    )
    expect(left).toEqual({
      nodes: 0,
      jobs: 0,
      sessions: 0,
      events: 0,
      confirmations: 0,
      capabilities: 0,
      profiles: 0,
    })
  })

  // The webhook inbox keeps a delivery's payload while it waits for a retry
  // and, briefly, when it is dead. A payload naming the erased person (their
  // id or email) does not outlive the erasure: it is cleared, and an
  // unsettled delivery carrying it is dropped rather than run later.
  test("clears webhook inbox payloads that name the erased user, and leaves the others", async () => {
    const email = extractRows<{ email: string }>(
      await withSystemDb("erase-inbox-email", (tx) =>
        tx.execute(drizzleSql`SELECT email FROM kernel.users WHERE id = ${userId}`),
      ),
    )[0]!.email
    const insert = (status: string, payload: unknown, headers: unknown = null) =>
      withSystemDb(
        "erase-inbox-seed",
        async (tx) =>
          extractRows<{ id: string }>(
            await tx.execute(drizzleSql`
            INSERT INTO kernel.webhook_inbox (org_id, app_name, endpoint_name, delivery_hash,
              dedup_until, payload, headers, status, attempts, settled_at)
            VALUES (${orgId}, 'inboxapp', 'orders', ${crypto.randomUUID()}, now() + interval '1 hour',
              ${JSON.stringify(payload)}::jsonb, ${headers === null ? null : JSON.stringify(headers)}::jsonb,
              ${status}, 1, ${status === "dead" ? drizzleSql`now()` : null})
            RETURNING id::text AS id`),
          )[0]!.id,
      )
    const pendingByEmail = await insert("pending", { customer: { email: email.toUpperCase() } })
    const deadById = await insert("dead", { assignee: userId })
    const byHeader = await insert("pending", { order: 1 }, { "x-user": email })
    const other = await insert("pending", { customer: { email: "someone-else@example.com" } })

    const r = await eraseUser(userId)
    expect(r.exitCode).toBe(0)
    const rows = extractRows<{ id: string; status: string; payload: unknown; headers: unknown }>(
      await withSystemDb("erase-inbox-read", (tx) =>
        tx.execute(drizzleSql`SELECT id::text AS id, status, payload, headers
          FROM kernel.webhook_inbox WHERE org_id = ${orgId}`),
      ),
    )
    const byId = new Map(rows.map((x) => [x.id, x]))
    expect(byId.get(pendingByEmail)).toMatchObject({
      status: "dropped",
      payload: null,
      headers: null,
    })
    expect(byId.get(deadById)).toMatchObject({ status: "dead", payload: null, headers: null })
    expect(byId.get(byHeader)).toMatchObject({ status: "dropped", payload: null, headers: null })
    expect(byId.get(other)).toMatchObject({
      status: "pending",
      payload: { customer: { email: "someone-else@example.com" } },
    })
  })

  test("every kernel user column the sweep can discover has a disposition, whether or not any row holds a user", async () => {
    // The sweep only refuses for a column that carries the erased user's id,
    // so an unmapped column stays latent until the first user with such a row
    // is erased (a phone's notification credential broke account deletion on
    // the demo server that way). This reads the live catalog instead: every
    // recognised-name column and every foreign key to kernel.users.
    const columns = await withSystemDb("erase-static-sweep", (tx) => discoverKernelUserColumns(tx))
    expect(columns.length).toBeGreaterThan(50)
    const missing = [...new Set(columns.map((c) => `${c.table_name}.${c.column_name}`))].filter(
      (key) => !(key in KERNEL_USER_COLUMN_DISPOSITION),
    )
    expect(missing.sort()).toEqual([])
  })

  test("every kernel disposition names a column that exists", async () => {
    const existing = await withSystemDb("erase-static-columns", async (tx) =>
      extractRows<{ key: string }>(
        await tx.execute(drizzleSql`
          SELECT table_name || '.' || column_name AS key
          FROM information_schema.columns WHERE table_schema = ${schemaRef("kernel")}
        `),
      ).map((r) => r.key),
    )
    const have = new Set(existing)
    const stale = Object.keys(KERNEL_USER_COLUMN_DISPOSITION).filter((k) => !have.has(k))
    expect(stale).toEqual([])
  })

  test("erasing a person takes their away records and every place they are named as next in line, on a route or as a changer", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const seeded = await withSystemDb("erase-away-seed", async (tx) => {
      const otherId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.users (org_id, email, name)
          VALUES (${orgId}, ${`other-away-${suffix}@t.co`}, 'Other') RETURNING id
        `),
      )[0].id
      const roomId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.threads (org_id, handle, created_by)
          VALUES (${orgId}, ${`erase-away-${suffix}`}, ${otherId}) RETURNING id
        `),
      )[0].id
      const approvalId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.approval_requests (org_id, handle, thread_id, originating_thread_id,
                                                tool_name, tool_params, current_payload,
                                                requested_by, route_person_id, status, expires_at)
          VALUES (${orgId}, ${`ap-${suffix}`}, ${roomId}, ${roomId}, 'kernel:x', '{}'::jsonb, '{}'::jsonb,
                  ${otherId}, ${userId}, 'denied', now() + interval '1 day')
          RETURNING id
        `),
      )[0].id
      await tx.execute(drizzleSql`
        INSERT INTO kernel.away_ranges (org_id, user_id, starts_on, ends_on, source)
        VALUES (${orgId}, ${userId}, '2026-12-01', '2026-12-05', 'said')
      `)
      const theirRangeId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.away_ranges (org_id, user_id, starts_on, ends_on, next_in_line_id, source, set_by)
          VALUES (${orgId}, ${otherId}, '2026-12-01', '2026-12-05', ${userId}, 'said', ${userId})
          RETURNING id
        `),
      )[0].id
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_preferences (user_id, next_in_line_id) VALUES (${otherId}, ${userId})
      `)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.org_app_features (org_id, app_name, feature, enabled, changed_by, changed_at)
        VALUES (${orgId}, 'projects', ${`f-${suffix}`}, true, ${userId}, now())
      `)
      return { otherId, approvalId, theirRangeId }
    })

    expect((await eraseUser(userId)).exitCode).toBe(0)

    const after = await withSystemDb("erase-away-read", async (tx) => ({
      own: extractRows<{ n: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS n FROM kernel.away_ranges WHERE user_id = ${userId}`,
        ),
      )[0].n,
      theirs: extractRows<{ next_in_line_id: string | null; set_by: string | null }>(
        await tx.execute(drizzleSql`
          SELECT next_in_line_id, set_by FROM kernel.away_ranges WHERE id = ${seeded.theirRangeId}
        `),
      )[0],
      prefs: extractRows<{ next_in_line_id: string | null }>(
        await tx.execute(drizzleSql`
          SELECT next_in_line_id FROM kernel.user_preferences WHERE user_id = ${seeded.otherId}
        `),
      )[0],
      route: extractRows<{ route_person_id: string | null }>(
        await tx.execute(drizzleSql`
          SELECT route_person_id FROM kernel.approval_requests WHERE id = ${seeded.approvalId}
        `),
      )[0],
      feature: extractRows<{ changed_by: string | null; enabled: boolean }>(
        await tx.execute(drizzleSql`
          SELECT changed_by, enabled FROM kernel.org_app_features
           WHERE org_id = ${orgId} AND feature = ${`f-${suffix}`}
        `),
      )[0],
    }))
    expect(after).toEqual({
      own: 0,
      theirs: { next_in_line_id: null, set_by: null },
      prefs: { next_in_line_id: null },
      route: { route_person_id: null },
      feature: { changed_by: null, enabled: true },
    })
  })

  test("a user with notification devices, mailbox keys and org attributions can be erased and leaves none of their rows", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const shared = await withSystemDb("erase-devices-seed", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.notification_device_credentials
          (org_id, user_id, device_id, surface, token_hash, server_origin)
        VALUES (${orgId}, ${userId}, ${`phone-${suffix}`}, 'ios', ${`hash-${suffix}`},
          'https://example.test')`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.desktop_devices (org_id, user_id, device_id)
        VALUES (${orgId}, ${userId}, ${`desk-${suffix}`})`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.browser_push_subscriptions (org_id, user_id, device_id, endpoint)
        VALUES (${orgId}, ${userId}, ${`br-${suffix}`}, ${`https://push.example.test/${suffix}`})`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.notification_receipts (org_id, user_id, notification_id, device_id, outcome)
        VALUES (${orgId}, ${userId}, ${crypto.randomUUID()}, ${`phone-${suffix}`}, 'shown')`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.notification_deliveries (org_id, user_id, notification_id, channel, result)
        VALUES (${orgId}, ${userId}, ${crypto.randomUUID()}, 'push', 'accepted')`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_mailbox_identities
          (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation)
        VALUES (${orgId}, ${userId}, 0, '\\x01'::bytea, '\\x02'::bytea, '\\x03'::bytea)`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_key_wraps (org_id, user_id, wrap_type, wrapped_account_key)
        VALUES (${orgId}, ${userId}, 'passphrase', '\\x04'::bytea)`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.mailbox_migration_state (user_id, org_id, enrolled_at)
        VALUES (${userId}, ${orgId}, now())`)
      await tx.execute(drizzleSql`
        INSERT INTO kernel.mailbox_client_jobs (org_id, user_id, kind)
        VALUES (${orgId}, ${userId}, 'summarise')`)
      // Org content the user created survives without its creator; a share
      // made TO the user goes with them.
      const policyId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.approval_policies (org_id, tool_name, created_by)
          VALUES (${orgId}, ${`erase:tool-${suffix}`}, ${userId}) RETURNING id`),
      )[0].id
      const senderId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.trusted_senders (org_id, kind, value, created_by)
          VALUES (${orgId}, 'domain', ${`erase-${suffix}.test`}, ${userId}) RETURNING id`),
      )[0].id
      const roleShareId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.resource_grants
            (org_id, resource_type, resource_id, grantee_kind, grantee, role, created_by)
          VALUES (${orgId}, 'document', ${crypto.randomUUID()}, 'role', 'some-role', 'viewer', ${userId})
          RETURNING id`),
      )[0].id
      await tx.execute(drizzleSql`
        INSERT INTO kernel.resource_grants
          (org_id, resource_type, resource_id, grantee_kind, grantee, role)
        VALUES (${orgId}, 'document', ${crypto.randomUUID()}, 'user', ${userId}, 'editor')`)
      // A colleague's node lets the user (and an agent) send it work: the
      // user's entry leaves the allowlist, the agent's stays.
      const colleagueId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.users (org_id, email, name)
          VALUES (${orgId}, ${`erase-colleague-${suffix}@test.local`}, 'Colleague') RETURNING id`),
      )[0].id
      const keptAgent = crypto.randomUUID()
      const nodeAgentId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
          VALUES (${orgId}, 'role', ${`eraseallow${suffix.replace(/[^a-z0-9]/g, "")}`},
            'Erase Allowlist', '["*"]'::jsonb)
          RETURNING id`),
      )[0].id
      const attachmentId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.node_attachments (org_id, node_owner_user_id, agent_id, allowed_requesters)
          VALUES (${orgId}, ${colleagueId}, ${nodeAgentId},
            ${JSON.stringify([
              { type: "user", id: userId },
              { type: "agent", id: keptAgent },
            ])}::text::jsonb)
          RETURNING id`),
      )[0].id
      // Org records the user only authored stay, without the user's id.
      const activationId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.app_activation_events (app, to_version, outcome, actor_id, actor_kind)
          VALUES (${`erase-app-${suffix}`}, '1.0.0', 'activated', ${userId}, 'operator')
          RETURNING id`),
      )[0].id
      const transformId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.import_transforms (org_id, name, version, source, source_type, created_by)
          VALUES (${orgId}, ${`erase-rule-${suffix}`}, 1, 'export default (r) => r', 'upload', ${userId})
          RETURNING id`),
      )[0].id
      const uploadId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.import_uploads (org_id, created_by, filename, mime_type, storage_key, size)
          VALUES (${orgId}, ${userId}, 'tickets.csv', 'text/csv', ${`imports/${suffix}`}, 10)
          RETURNING id`),
      )[0].id
      const secretThreadId = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.threads (org_id, handle, created_by)
          VALUES (${orgId}, ${`erase-secret-${suffix}`}, ${colleagueId}) RETURNING id`),
      )[0].id
      const secretRequestIds = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.secret_requests
            (org_id, thread_id, requested_by, kind, target_key, status, completed_by)
          VALUES
            (${orgId}, ${secretThreadId}, ${userId}, 'api_key', ${`erase-a-${suffix}`}, 'saved', ${colleagueId}),
            (${orgId}, ${secretThreadId}, ${colleagueId}, 'api_key', ${`erase-b-${suffix}`}, 'saved', ${userId})
          RETURNING id`),
      ).map((r) => r.id)
      return {
        policyId,
        senderId,
        roleShareId,
        attachmentId,
        keptAgent,
        activationId,
        transformId,
        uploadId,
        secretRequestIds,
      }
    })

    const res = await eraseUser(userId)
    expect(res.message).toBeUndefined()
    expect(res.exitCode).toBe(0)

    const left = await withSystemDb(
      "erase-devices-left",
      async (tx) =>
        extractRows<Record<string, number>>(
          await tx.execute(drizzleSql`
          SELECT
            (SELECT count(*)::int FROM kernel.notification_device_credentials
              WHERE user_id = ${userId}) AS credentials,
            (SELECT count(*)::int FROM kernel.desktop_devices WHERE user_id = ${userId}) AS desktops,
            (SELECT count(*)::int FROM kernel.browser_push_subscriptions
              WHERE user_id = ${userId}) AS browsers,
            (SELECT count(*)::int FROM kernel.notification_receipts WHERE user_id = ${userId}) AS receipts,
            (SELECT count(*)::int FROM kernel.notification_deliveries
              WHERE user_id = ${userId}) AS deliveries,
            (SELECT count(*)::int FROM kernel.user_mailbox_identities
              WHERE user_id = ${userId}) AS identities,
            (SELECT count(*)::int FROM kernel.user_key_wraps WHERE user_id = ${userId}) AS wraps,
            (SELECT count(*)::int FROM kernel.mailbox_migration_state
              WHERE user_id = ${userId}) AS ledger,
            (SELECT count(*)::int FROM kernel.mailbox_client_jobs WHERE user_id = ${userId}) AS jobs,
            (SELECT count(*)::int FROM kernel.resource_grants
              WHERE (grantee_kind = 'user' AND grantee = ${userId}) OR created_by = ${userId}) AS grants,
            (SELECT count(*)::int FROM kernel.approval_policies
              WHERE id = ${shared.policyId} AND created_by IS NULL) AS policy_kept,
            (SELECT count(*)::int FROM kernel.trusted_senders
              WHERE id = ${shared.senderId} AND created_by IS NULL) AS sender_kept,
            (SELECT count(*)::int FROM kernel.resource_grants
              WHERE id = ${shared.roleShareId} AND created_by IS NULL) AS role_share_kept,
            (SELECT count(*)::int FROM kernel.app_activation_events
              WHERE id = ${shared.activationId} AND actor_id IS NULL) AS activation_kept,
            (SELECT count(*)::int FROM kernel.import_transforms
              WHERE id = ${shared.transformId} AND created_by IS NULL) AS transform_kept,
            (SELECT count(*)::int FROM kernel.import_uploads
              WHERE id = ${shared.uploadId} AND created_by <> ${userId}) AS upload_kept,
            (SELECT count(*)::int FROM kernel.secret_requests
              WHERE id = ANY(${`{${shared.secretRequestIds.join(",")}}`}::uuid[])
                AND requested_by <> ${userId}
                AND completed_by IS DISTINCT FROM ${userId}) AS secret_requests_kept
        `),
        )[0],
    )
    const allowlist = await withSystemDb(
      "erase-devices-allowlist",
      async (tx) =>
        extractRows<{ allowed: unknown }>(
          await tx.execute(drizzleSql`
            SELECT allowed_requesters AS allowed FROM kernel.node_attachments
            WHERE id = ${shared.attachmentId}`),
        )[0].allowed,
    )
    expect(allowlist).toEqual([{ type: "agent", id: shared.keptAgent }])
    expect(left).toEqual({
      credentials: 0,
      desktops: 0,
      browsers: 0,
      receipts: 0,
      deliveries: 0,
      identities: 0,
      wraps: 0,
      ledger: 0,
      jobs: 0,
      grants: 0,
      policy_kept: 1,
      sender_kept: 1,
      role_share_kept: 1,
      activation_kept: 1,
      transform_kept: 1,
      upload_kept: 1,
      secret_requests_kept: 2,
    })
  })
})

// Audit finding 1 of the W2 review (GDPR). Erasure RETAINS the rows of shared
// threads and removes their search documents; a rebuild streams those rows
// from Postgres, so without the erased-author rule it re-indexed the erased
// text. Real erasure, real rows, a real private Meili index, then a rebuild.
describe("erasure and the search index rebuild", () => {
  test("a rebuild after an erasure brings none of the erased user's text back, not even inside a window", async () => {
    const { MeiliSearch } = await import("meilisearch")
    const jobsModule = await import("~/infra/jobs/jobs")
    const minimal = await import("~/seed/tiers/minimal")
    const { expectedSettings } = await import("~/modules/search/drift")
    const { processMessageIndexerJob, MessageIndexerTestAccess } = await import(
      "~/modules/search/message-indexer"
    )
    const { LiveIndexTestAccess, flushLiveIndexOnce } = await import(
      "~/modules/search/live-index-queue"
    )
    const { runReindex } = await import("~/modules/search/reindex")
    const meili = new MeiliSearch({
      host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
      apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
    })
    const INDEX = `test_erase_rebuild_${orgId.slice(0, 8)}`
    const spies = [
      spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX),
      spyOn(searchClientModule, "getMeili").mockReturnValue(meili as never),
      spyOn(jobsModule, "enqueueAppJob").mockImplementation((async () => "job") as never),
    ]
    process.env.GOOGLE_API_KEY = ""
    MessageIndexerTestAccess.resetEmbedderCache()
    await LiveIndexTestAccess.clear()
    try {
      const created = await meili.createIndex(INDEX, { primaryKey: "id" })
      await meili.tasks.waitForTask(created.taskUid)
      const applied = await meili
        .index(INDEX)
        .updateSettings(
          expectedSettings({ registeredReadScopes: ["kernel:threads:read"], dimensionFields: [] }),
        )
      await meili.tasks.waitForTask(applied.taskUid)

      const colleague = (await minimal.person(orgId)).id
      const threadId = await withSystemDb(
        "erase-rebuild-thread",
        async (tx) =>
          extractRows<{ id: string }>(
            await tx.execute(drizzleSql`INSERT INTO kernel.threads (org_id, handle, created_by)
            VALUES (${orgId}, ${`erase-rebuild-${orgId.slice(0, 8)}`}, ${colleague}) RETURNING id`),
          )[0].id,
      )
      const ids: string[] = []
      for (let i = 0; i < 30; i++) {
        const author = i === 12 ? userId : colleague
        const content = i === 12 ? "my okapi diagnosis stays private" : `ordinary line ${i}`
        ids.push(
          await withSystemDb(
            "erase-rebuild-msg",
            async (tx) =>
              extractRows<{ id: string }>(
                await tx.execute(drizzleSql`INSERT INTO kernel.messages
                (thread_id, org_id, author_id, content, required_scopes, created_at)
                VALUES (${threadId}, ${orgId}, ${author}, ${content}, '{}'::text[],
                  now() - make_interval(secs => ${60 - i}))
                RETURNING id`),
              )[0].id,
          ),
        )
      }
      for (const id of ids)
        await processMessageIndexerJob({ action: "upsert", orgId, messageId: id })
      const okapi = async () =>
        (await meili.index(INDEX).search("okapi", { filter: `org_id = "${orgId}"` })).hits.length
      expect(await okapi()).toBeGreaterThan(0)

      // The race: inside the erasure transaction, after its removal was
      // queued, the flusher applies it and neighbouring messages (and the
      // erased one itself) are re-indexed from another connection, which does
      // not see the uncommitted tombstone yet and re-quotes the text.
      // The flusher and the indexer are workers of their own, so the hook runs
      // them outside the erasure's async context, as production does.
      const elsewhere = AsyncLocalStorage.snapshot()
      const res = await eraseUser(userId, {
        inTransaction: () =>
          elsewhere(async () => {
            while ((await flushLiveIndexOnce()) > 0) {}
            for (const id of [ids[11] as string, ids[12] as string, ids[13] as string]) {
              await processMessageIndexerJob({ action: "upsert", orgId, messageId: id })
            }
          }),
      })
      expect(res.exitCode).toBe(0)
      expect(await okapi()).toBeGreaterThan(0)
      while ((await flushLiveIndexOnce()) > 0) {}
      for (const uid of Object.keys(await LiveIndexTestAccess.ledger())) {
        await meili.tasks.waitForTask(Number(uid))
      }
      expect(await okapi()).toBe(0)

      // A later event on the erased message or a neighbour rebuilds nothing
      // that quotes it.
      for (const id of [ids[12] as string, ids[13] as string, ids[11] as string]) {
        await processMessageIndexerJob({ action: "upsert", orgId, messageId: id })
      }
      expect(await okapi()).toBe(0)

      const rebuilt = await runReindex()
      expect(rebuilt.swapped).toBe(true)
      expect(await okapi()).toBe(0)
      // The neighbours are still searchable: only the erased text is gone.
      const ordinary = await meili
        .index(INDEX)
        .search("ordinary", { filter: `org_id = "${orgId}" AND entity_type = "message"` })
      expect(ordinary.estimatedTotalHits).toBe(29)
    } finally {
      for (const s of spies) s.mockRestore()
      await LiveIndexTestAccess.clear()
      for (const name of [INDEX, `${INDEX}__rebuild`]) {
        try {
          await meili.tasks.waitForTask((await meili.deleteIndex(name)).taskUid)
        } catch {
          /* gone */
        }
      }
    }
  }, 180_000)
})

describe("erase-user revokes the user's OAuth grants", () => {
  async function seedGmailConnection(
    forOrg: string,
    ownerId: string,
    identifier: string,
  ): Promise<string> {
    return withSystemDb("erase-revoke-seed", async (tx) => {
      const rows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.connected_accounts
            (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
             refresh_token_encrypted, status, created_by)
          VALUES (${forOrg}, 'mail', 'gmail', 'user', ${ownerId}, 'oauth2', ${identifier},
                  ${encryptSecret(`refresh-of-${identifier}`, env.ENCRYPTION_KEY, CryptoContext.connectedAccountRefreshToken)},
                  'active', ${ownerId})
          RETURNING id`),
      )
      return rows[0].id
    })
  }

  async function connectionExists(id: string): Promise<boolean> {
    return withSystemDb(
      "erase-revoke-check",
      async (tx) =>
        extractRows<{ n: number }>(
          await tx.execute(
            drizzleSql`SELECT count(*)::int AS n FROM kernel.connected_accounts WHERE id = ${id}`,
          ),
        )[0].n > 0,
    )
  }

  const calls: Array<{ url: string; token: string | null; rowStillThere: boolean }> = []
  let connectionId = ""
  let fail = false

  beforeEach(() => {
    calls.length = 0
    fail = false
    OutboundFetchTestAccess.setFetch((async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({
        url,
        token: new URLSearchParams(String(init?.body ?? "")).get("token"),
        rowStillThere: await connectionExists(connectionId),
      })
      if (fail) throw new Error("provider unreachable")
      return new Response("{}", { status: 200 })
    }) as typeof fetch)
  })
  afterAll(() => OutboundFetchTestAccess.setFetch(null))

  test("revokes the user's grant at the provider after the erasure commits", async () => {
    connectionId = await seedGmailConnection(orgId, userId, `erase-${orgId}@example.com`)
    const res = await eraseUser(userId)
    expect(res.exitCode).toBe(0)
    expect(calls).toEqual([
      {
        url: "https://oauth2.googleapis.com/revoke",
        token: `refresh-of-erase-${orgId}@example.com`,
        // The row (and its tokens) were already deleted when the provider was called.
        rowStillThere: false,
      },
    ])
  })

  test("keeps a grant another org of the instance still uses", async () => {
    const identifier = `shared-${orgId}@example.com`
    connectionId = await seedGmailConnection(orgId, userId, identifier)
    // Another org of the same instance (createTestOrg would truncate this one).
    const { otherOrg, otherUser } = await withSystemDb("erase-revoke-other-org", async (tx) => {
      const org = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'Other org', ${`other-${crypto.randomUUID()}`})
          RETURNING id`),
      )[0].id
      const user = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO kernel.users
            (id, org_id, email, name, status, password_hash, auth_version, permission_version)
          VALUES (gen_random_uuid(), ${org}, ${`other-${crypto.randomUUID()}@example.com`}, 'Other',
                  'active', 'h', 1, 1)
          RETURNING id`),
      )[0].id
      return { otherOrg: org, otherUser: user }
    })
    await seedGmailConnection(otherOrg, otherUser, identifier.toUpperCase())

    const res = await eraseUser(userId)
    expect(res.exitCode).toBe(0)
    expect(calls).toEqual([])
    expect(await connectionExists(connectionId)).toBe(false)
  })

  test("a revoke failure does not fail the erasure", async () => {
    fail = true
    connectionId = await seedGmailConnection(orgId, userId, `fail-${orgId}@example.com`)
    const res = await eraseUser(userId)
    expect(res.exitCode).toBe(0)
    expect(calls).toHaveLength(1)
    expect(await connectionExists(connectionId)).toBe(false)
  })
})
