// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Linking an import placeholder to the real person (design audit 2026-09-30,
// finding 7): the route's authorization, the refusals (two real accounts,
// another org's user, a placeholder as target), the dry run, the complete
// move with its conflict rules, the audit event, the re-index, and the
// idempotent repeat. Real routes, real tokens, a real database.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { mergePlaceholderIntoUser } from "./merge-placeholder"
import {
  handleMergeImportedUser,
  handleMergeImportedUserPreview,
  mergeImportedUserPreflight,
} from "./merge-placeholder-tools"

let orgId: string
let admin: minimal.Session
let member: minimal.Session
let realId: string
let otherOrgUserId: string

async function placeholder(name: string): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO kernel.users (org_id, email, name, status)
    VALUES (${orgId}, ${`slack-import+${name}-${crypto.randomUUID().slice(0, 6)}@import.invalid`},
            ${name}, 'deactivated')
    RETURNING id`
  return row!.id
}

async function thread(createdBy: string): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO kernel.threads (org_id, handle, title, type, created_by)
    VALUES (${orgId}, ${`m-${crypto.randomUUID().slice(0, 8)}`}, 'Merge room', 'thread', ${createdBy})
    RETURNING id`
  return row!.id
}

async function message(threadId: string, authorId: string, content: string, mentions?: unknown) {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, mentions)
    VALUES (${threadId}, ${orgId}, ${authorId}, ${content}, '{}',
            ${mentions === undefined ? null : JSON.stringify(mentions)}::jsonb)
    RETURNING id`
  return row!.id
}

function post(token: string, placeholderId: string, body: unknown) {
  return app.request(`/api/admin/users/${placeholderId}/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  await acquireTestLock()
  // The bus validates every queued kernel event against its declared emit
  // set: without it a merge could queue an event production refuses.
  resetEventBus()
  initEventBus()
  orgId = (await createTestOrg()).id
  admin = await minimal.session(orgId, { role: "admin" })
  member = await minimal.session(orgId, { role: "member" })
  realId = member.userId
  const [otherOrg] = await sql<Array<{ id: string }>>`
    INSERT INTO kernel.organizations (name, slug)
    VALUES ('Other org', ${`other-${crypto.randomUUID().slice(0, 8)}`}) RETURNING id`
  const [other] = await sql<Array<{ id: string }>>`
    INSERT INTO kernel.users (org_id, email, name, status)
    VALUES (${otherOrg!.id}, ${`slack-import+x-${crypto.randomUUID().slice(0, 6)}@import.invalid`},
            'Elsewhere', 'deactivated')
    RETURNING id`
  otherOrgUserId = other!.id
}, 60_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("POST /api/admin/users/:id/merge — who may, and what never merges", () => {
  it("refuses a non-admin", async () => {
    const ph = await placeholder("nonadmin")
    const res = await post(member.bearer, ph, { targetUserId: realId, dryRun: true })
    expect(res.status).toBe(403)
    const [still] = await sql`SELECT 1 FROM kernel.users WHERE id = ${ph}`
    expect(still).toBeDefined()
  })

  it("never merges two real accounts", async () => {
    const res = await post(admin.bearer, admin.userId, { targetUserId: realId })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe("NOT_A_PLACEHOLDER")
    const [still] = await sql`SELECT 1 FROM kernel.users WHERE id = ${admin.userId}`
    expect(still).toBeDefined()
  })

  it("never merges into another placeholder, nor a user into itself", async () => {
    const a = await placeholder("a")
    const b = await placeholder("b")
    const res = await post(admin.bearer, a, { targetUserId: b })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe("TARGET_IS_PLACEHOLDER")
    const self = await post(admin.bearer, a, { targetUserId: a })
    expect(self.status).toBe(400)
    expect(((await self.json()) as any).error.code).toBe("SAME_USER")
  })

  it("never reaches across orgs: another org's placeholder reads as not found", async () => {
    const res = await post(admin.bearer, otherOrgUserId, { targetUserId: realId })
    expect(res.status).toBe(404)
    const [still] = await sql`SELECT 1 FROM kernel.users WHERE id = ${otherOrgUserId}`
    expect(still).toBeDefined()
    const ph = await placeholder("cross")
    const res2 = await post(admin.bearer, ph, { targetUserId: otherOrgUserId })
    expect(res2.status).toBe(404)
  })
})

describe("merging a placeholder into the real person", () => {
  let ph: string
  let room: string
  let shared: string
  let authored: string
  let mentioning: string
  let alsoReal: string

  beforeAll(async () => {
    ph = await placeholder("maxime")
    room = await thread(ph)
    shared = await thread(realId)
    // Participation: the placeholder in both rooms; the real user already in `shared`.
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
              VALUES (${room}, ${ph}, ${orgId}, 'member'), (${shared}, ${ph}, ${orgId}, 'member'),
                     (${shared}, ${realId}, ${orgId}, 'owner')
              ON CONFLICT DO NOTHING`
    // Read state: the real user's row in `shared` wins; the `room` row moves.
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id, is_muted)
              VALUES (${ph}, ${room}, ${orgId}, true), (${ph}, ${shared}, ${orgId}, true)
              ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id, is_muted)
              VALUES (${realId}, ${shared}, ${orgId}, false) ON CONFLICT DO NOTHING`
    authored = await message(room, ph, "from the import")
    mentioning = await message(room, admin.userId, `hi @[Maxime](user:${ph})`, [
      { type: "user", id: ph },
    ])
    alsoReal = await message(
      shared,
      admin.userId,
      `@[Maxime](user:${ph}) and @[M](user:${realId})`,
      [
        { type: "user", id: ph },
        { type: "user", id: realId },
      ],
    )
    // Reactions: one the real user also made (dropped), one unique (moved).
    await sql`INSERT INTO kernel.message_reactions (message_id, user_id, emoji, org_id)
              VALUES (${mentioning}, ${ph}, '👍', ${orgId}), (${mentioning}, ${ph}, '🎉', ${orgId}),
                     (${mentioning}, ${realId}, '👍', ${orgId})`
    await sql`INSERT INTO kernel.reply_thread_followers (root_message_id, user_id, org_id, thread_id)
              VALUES (${authored}, ${ph}, ${orgId}, ${room})`
    // Foreign keys the first version did not know (merge-references.ts): a
    // SET NULL one (saved view), a RESTRICT one in an app schema (project), a
    // CASCADE one that is the placeholder's own rule (dropped), and a
    // credential (dies with the account, never moves).
    await sql`INSERT INTO kernel.saved_views (org_id, app, view_id, name, payload, owner_user_id)
              VALUES (${orgId}, 'kernel', 'threads', 'Mine', '{}'::jsonb, ${ph})`
    await sql`INSERT INTO app_projects.projects (org_id, name, owner_id, key)
              VALUES (${orgId}, 'Imported project', ${ph}, ${`M${crypto.randomUUID().slice(0, 4).toUpperCase()}`})`
    await sql`INSERT INTO kernel.attention_subscriptions (user_id, source, kinds)
              VALUES (${ph}, 'kernel', '{}')`
    await sql`INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
              VALUES (${orgId}, ${ph}, 'ios', ${`tok-${ph}`})`
  })

  it("previews the merge without writing anything", async () => {
    const res = await post(admin.bearer, ph, { targetUserId: realId, dryRun: true })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.dryRun).toBe(true)
    expect(body.data.counts).toMatchObject({
      messagesAuthored: 1,
      messagesMentioning: 2,
      reactionsMoved: 1,
      reactionsDropped: 1,
      threadsCreated: 1,
      participationsMoved: 1,
      participationsDropped: 1,
      threadStatesMoved: 1,
      threadStatesDropped: 1,
      followsMoved: 1,
    })
    const [still] = await sql`SELECT author_id FROM kernel.messages WHERE id = ${authored}`
    expect(still?.author_id).toBe(ph)
  })

  it("moves everything, keeps the real user's own rows on conflict, and removes the placeholder", async () => {
    const reindexed: string[] = []
    const result = await mergePlaceholderIntoUser(
      { orgId, actorId: admin.userId, placeholderId: ph, targetId: realId },
      {
        indexMessages: async (_org, ids) => {
          reindexed.push(...ids)
        },
      },
    )
    expect(result.alreadyMerged).toBe(false)
    expect(result.counts).toMatchObject({
      messagesAuthored: 1,
      messagesMentioning: 2,
      reactionsMoved: 1,
      reactionsDropped: 1,
      participationsMoved: 1,
      participationsDropped: 1,
      threadStatesMoved: 1,
      threadStatesDropped: 1,
      followsMoved: 1,
    })

    const [a] = await sql`SELECT author_id FROM kernel.messages WHERE id = ${authored}`
    expect(a?.author_id).toBe(realId)
    const [m] = await sql`SELECT content, mentions FROM kernel.messages WHERE id = ${mentioning}`
    expect(m?.content).toBe(`hi @[Maxime](user:${realId})`)
    expect(m?.mentions).toEqual([{ type: "user", id: realId }])
    // Mentioning both: one entry left, in first position.
    const [both] = await sql`SELECT mentions FROM kernel.messages WHERE id = ${alsoReal}`
    expect(both?.mentions).toEqual([{ type: "user", id: realId }])

    const reactions = await sql<Array<{ emoji: string }>>`
      SELECT emoji FROM kernel.message_reactions WHERE message_id = ${mentioning} AND user_id = ${realId}
      ORDER BY emoji`
    expect(reactions.map((r) => r.emoji).sort()).toEqual(["🎉", "👍"].sort())
    const [creator] = await sql`SELECT created_by FROM kernel.threads WHERE id = ${room}`
    expect(creator?.created_by).toBe(realId)
    const parts =
      await sql`SELECT thread_id FROM kernel.thread_participants WHERE user_id = ${realId}
                             AND thread_id IN (${room}, ${shared})`
    expect(parts.length).toBe(2)
    const [sharedState] = await sql`SELECT is_muted FROM kernel.user_thread_state
                                     WHERE user_id = ${realId} AND thread_id = ${shared}`
    expect(sharedState?.is_muted).toBe(false) // the real user's own choice won
    const [roomState] = await sql`SELECT is_muted FROM kernel.user_thread_state
                                   WHERE user_id = ${realId} AND thread_id = ${room}`
    expect(roomState?.is_muted).toBe(true)
    const [follow] = await sql`SELECT 1 FROM kernel.reply_thread_followers
                                WHERE root_message_id = ${authored} AND user_id = ${realId}`
    expect(follow).toBeDefined()

    // Every foreign key per its disposition, nothing left to the delete.
    const [view] = await sql`SELECT owner_user_id FROM kernel.saved_views
                              WHERE org_id = ${orgId} AND name = 'Mine'`
    expect(view?.owner_user_id).toBe(realId)
    const [project] = await sql`SELECT owner_id FROM app_projects.projects
                                 WHERE org_id = ${orgId} AND name = 'Imported project'`
    expect(project?.owner_id).toBe(realId)
    expect(result.counts.references["kernel.saved_views.owner_user_id"]).toEqual({
      moved: 1,
      dropped: 0,
    })
    expect(result.counts.references["kernel.attention_subscriptions.user_id"]).toEqual({
      moved: 0,
      dropped: 1,
    })
    const subs = await sql`SELECT 1 FROM kernel.attention_subscriptions WHERE user_id = ${realId}`
    expect(subs.length).toBe(0)
    const tokens = await sql`SELECT user_id FROM kernel.push_tokens WHERE token = ${`tok-${ph}`}`
    expect(tokens.length).toBe(0) // the credential died with the account, never moved

    const [gone] = await sql`SELECT 1 FROM kernel.users WHERE id = ${ph}`
    expect(gone).toBeUndefined()
    const leftovers = await sql`SELECT 1 FROM kernel.messages
                                 WHERE org_id = ${orgId}
                                   AND (author_id = ${ph} OR content LIKE ${`%${ph}%`}
                                        OR mentions::text LIKE ${`%${ph}%`})`
    expect(leftovers.length).toBe(0)

    // Re-indexed through the search module, every message it touched.
    expect(reindexed.sort()).toEqual([authored, mentioning, alsoReal].sort())
    // Audited: one durable identity event with the counts, plus the join.
    const events = await sql<Array<{ payload: any }>>`
      SELECT payload FROM kernel.pending_events
       WHERE payload->>'entity' IN ('user', 'participant')
         AND payload->>'orgId' = ${orgId}
         AND (payload->>'entityId' = ${ph} OR payload->'data'->>'via' = 'merge')`
    const merge = events.find((e) => e.payload.entity === "user")
    expect(merge?.payload.action).toBe("merge")
    expect(merge?.payload.data.targetUserId).toBe(realId)
    expect(events.filter((e) => e.payload.entity === "participant").length).toBe(1)
  })

  it("is idempotent: a repeat does nothing and says it was already merged", async () => {
    // What the durable audit consumer writes for the merge event.
    await sql`INSERT INTO kernel.audit_log (org_id, actor_id, actor_type, app, entity_type,
                                            entity_id, action, changes)
              VALUES (${orgId}, ${admin.userId}, 'user', 'kernel', 'user', ${ph}, 'user.merge',
                      ${JSON.stringify({ targetUserId: realId, placeholderName: "maxime" })}::jsonb)`
    const res = await post(admin.bearer, ph, { targetUserId: realId })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.alreadyMerged).toBe(true)
    expect(body.data.counts.messagesAuthored).toBe(0)
    // Into someone else: not the same merge, so not found.
    const other = await post(admin.bearer, ph, { targetUserId: admin.userId })
    expect(other.status).toBe(404)
  })
})

describe("merging a placeholder named on approvals, away records and feature changes", () => {
  it("merging a placeholder repoints route person, setter, changer and both next in line", async () => {
    const ph = await placeholder("away")
    const room = await thread(admin.userId)
    const [req] = await sql<Array<{ id: string }>>`
      INSERT INTO kernel.approval_requests (org_id, handle, thread_id, originating_thread_id,
                                            tool_name, tool_params, current_payload,
                                            requested_by, route_person_id, status, expires_at)
      VALUES (${orgId}, ${`ap-${crypto.randomUUID().slice(0, 8)}`}, ${room}, ${room},
              'kernel:x', '{}'::jsonb, '{}'::jsonb, ${admin.userId}, ${ph}, 'denied',
              now() + interval '1 day')
      RETURNING id`
    // Someone else's away record names the placeholder twice; its own is its own.
    const [theirs] = await sql<Array<{ id: string }>>`
      INSERT INTO kernel.away_ranges (org_id, user_id, starts_on, ends_on, next_in_line_id, source, set_by)
      VALUES (${orgId}, ${admin.userId}, '2026-12-01', '2026-12-05', ${ph}, 'said', ${ph})
      RETURNING id`
    await sql`INSERT INTO kernel.away_ranges (org_id, user_id, starts_on, ends_on, source)
              VALUES (${orgId}, ${ph}, '2026-12-01', '2026-12-05', 'said')`
    await sql`INSERT INTO kernel.user_preferences (user_id, next_in_line_id)
              VALUES (${admin.userId}, ${ph})
              ON CONFLICT (user_id) DO UPDATE SET next_in_line_id = ${ph}`
    const feature = `feature-${crypto.randomUUID().slice(0, 8)}`
    await sql`INSERT INTO kernel.org_app_features (org_id, app_name, feature, enabled, changed_by, changed_at)
              VALUES (${orgId}, 'projects', ${feature}, true, ${ph}, now())`

    const res = await post(admin.bearer, ph, { targetUserId: realId })
    expect(res.status).toBe(200)

    const [route] =
      await sql`SELECT route_person_id FROM kernel.approval_requests WHERE id = ${req!.id}`
    expect(route?.route_person_id).toBe(realId)
    const [away] =
      await sql`SELECT user_id, next_in_line_id, set_by FROM kernel.away_ranges WHERE id = ${theirs!.id}`
    expect(away).toEqual({ user_id: admin.userId, next_in_line_id: realId, set_by: realId })
    const [prefs] =
      await sql`SELECT next_in_line_id FROM kernel.user_preferences WHERE user_id = ${admin.userId}`
    expect(prefs?.next_in_line_id).toBe(realId)
    const [changed] = await sql`SELECT changed_by FROM kernel.org_app_features
                                 WHERE org_id = ${orgId} AND feature = ${feature}`
    expect(changed?.changed_by).toBe(realId)
    // The placeholder's own away record does not become the person's.
    const own = await sql`SELECT 1 FROM kernel.away_ranges WHERE user_id IN (${ph}, ${realId})`
    expect(own.length).toBe(0)
  })
})

describe("merging a placeholder that owns contacts", () => {
  it("its private contacts, grants and ACL places move to the person; the placeholder can go", async () => {
    const ph2 = await placeholder("contact-owner")
    const email = `ph-contact-${crypto.randomUUID().slice(0, 6)}@x.example`
    const [owned] = await sql<Array<{ id: string }>>`
      INSERT INTO kernel.contacts (org_id, handle, email, org_access, owner_user_id, acl_user_ids)
      VALUES (${orgId}, ${`@ph-${crypto.randomUUID().slice(0, 6)}`}, ${email}, 'none', ${ph2},
              ${JSON.stringify([ph2])}::jsonb)
      RETURNING id`
    // A contact the real user shared with the placeholder.
    const [shared] = await sql<Array<{ id: string }>>`
      INSERT INTO kernel.contacts (org_id, handle, email, org_access, owner_user_id, acl_user_ids)
      VALUES (${orgId}, ${`@rs-${crypto.randomUUID().slice(0, 6)}`}, ${`rs-${email}`}, 'none', ${admin.userId},
              ${JSON.stringify([admin.userId, ph2])}::jsonb)
      RETURNING id`
    await sql`INSERT INTO kernel.resource_grants
                (org_id, resource_type, resource_id, grantee_kind, grantee, role)
              VALUES (${orgId}, 'kernel.contact', ${shared!.id}, 'user', ${ph2}, 'viewer')`
    // Two NULL-email private contacts never collide: the placeholder's is not
    // mistaken for a duplicate of the person's and dropped.
    await sql`INSERT INTO kernel.contacts (org_id, handle, org_access, owner_user_id)
              VALUES (${orgId}, ${`@n1-${crypto.randomUUID().slice(0, 6)}`}, 'none', ${ph2}),
                     (${orgId}, ${`@n2-${crypto.randomUUID().slice(0, 6)}`}, 'none', ${realId})`

    await mergePlaceholderIntoUser({
      orgId,
      actorId: admin.userId,
      placeholderId: ph2,
      targetId: realId,
    })

    const [after] = await sql<Array<{ owner_user_id: string; acl_user_ids: string[] }>>`
      SELECT owner_user_id::text, acl_user_ids FROM kernel.contacts WHERE id = ${owned!.id}`
    expect(after).toEqual({ owner_user_id: realId, acl_user_ids: [realId] })
    const [grant] = await sql<Array<{ grantee: string }>>`
      SELECT grantee FROM kernel.resource_grants WHERE resource_id = ${shared!.id}`
    expect(grant!.grantee).toBe(realId)
    const [sharedAfter] = await sql<Array<{ acl_user_ids: string[] }>>`
      SELECT acl_user_ids FROM kernel.contacts WHERE id = ${shared!.id}`
    expect([...sharedAfter!.acl_user_ids].sort()).toEqual([admin.userId, realId].sort())
    const [nulls] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.contacts
       WHERE org_id = ${orgId} AND owner_user_id = ${realId} AND email IS NULL`
    expect(nulls!.n).toBe(2)
    const [gone] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.users WHERE id = ${ph2}`
    expect(gone!.n).toBe(0)
  })
})

describe("merging a placeholder whose private contact the person also has", () => {
  it("merges the two contacts (fields, ids, links kept) instead of dropping one", async () => {
    const ph3 = await placeholder("twin-owner")
    const email = `twin-${crypto.randomUUID().slice(0, 6)}@x.example`
    const [phContact] = await sql<Array<{ id: string }>>`
      INSERT INTO kernel.contacts (org_id, handle, email, company, org_access, owner_user_id, external_ids)
      VALUES (${orgId}, ${`@tw1-${crypto.randomUUID().slice(0, 6)}`}, ${email}, 'Acme', 'none', ${ph3},
              ${JSON.stringify({ crm: "PH-ONLY" })}::jsonb)
      RETURNING id`
    const [realContact] = await sql<Array<{ id: string }>>`
      INSERT INTO kernel.contacts (org_id, handle, email, org_access, owner_user_id)
      VALUES (${orgId}, ${`@tw2-${crypto.randomUUID().slice(0, 6)}`}, ${email}, 'none', ${realId})
      RETURNING id`
    const [acct] = await sql<Array<{ id: string }>>`
      INSERT INTO app_mail.accounts (org_id, connected_account_id, owner_type, provider, email_address, sync_status)
      VALUES (${orgId}, gen_random_uuid(), 'org', 'gmail', ${`box-${email}`}, 'active')
      RETURNING id`
    const [conv] = await sql<Array<{ id: string }>>`
      INSERT INTO app_mail.conversations
        (org_id, account_id, owner_type, external_thread_id, status, from_email, contact_id, message_count)
      VALUES (${orgId}, ${acct!.id}, 'org', ${`tw-${email}`}, 'open', ${email}, ${phContact!.id}, 1)
      RETURNING id`

    const preview = await mergePlaceholderIntoUser({
      orgId,
      actorId: admin.userId,
      placeholderId: ph3,
      targetId: realId,
      dryRun: true,
    })
    expect(preview.counts.contactsMerged).toBe(1)
    expect(preview.counts.references["kernel.contacts.owner_user_id"]?.dropped ?? 0).toBe(0)

    const result = await mergePlaceholderIntoUser({
      orgId,
      actorId: admin.userId,
      placeholderId: ph3,
      targetId: realId,
    })
    expect(result.counts.contactsMerged).toBe(1)
    const [survivor] = await sql<Array<{ external_ids: Record<string, string> }>>`
      SELECT external_ids FROM kernel.contacts WHERE id = ${realContact!.id}`
    expect(survivor!.external_ids.crm).toBe("PH-ONLY")
    const [gone] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM kernel.contacts WHERE id = ${phContact!.id}`
    expect(gone!.n).toBe(0)
    const [linked] = await sql<Array<{ contact_id: string }>>`
      SELECT contact_id::text FROM app_mail.conversations WHERE id = ${conv!.id}`
    expect(linked!.contact_id).toBe(realContact!.id)
  })
})

describe("the agent's merge tools", () => {
  it("registers the merge as a gated admin tool and the preview as a read", async () => {
    const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
    await registerKernelAgentTools(orgId)
    const merge = toolRegistry.get([orgId, "kernel", "merge_imported_user"])
    expect(merge?.gated).toBe(true)
    expect(merge?.requiredScopes).toEqual(["kernel:users:admin"])
    expect(merge?.preflight).toBeDefined()
    const preview = toolRegistry.get([orgId, "kernel", "merge_imported_user_preview"])
    expect(preview?.readOnly).toBe(true)
    expect(preview?.requiredScopes).toEqual(["kernel:users:admin"])
  })

  it("the handlers refuse a caller without the admin scope, whatever the registry did", async () => {
    const ph = await placeholder("toolnonadmin")
    const ctx = { orgId, userId: member.userId }
    const params = { placeholderUserId: ph, targetUserId: admin.userId }
    expect(await handleMergeImportedUser(params, ctx)).toMatchObject({
      error: { code: "FORBIDDEN" },
    })
    expect(await handleMergeImportedUserPreview(params, ctx)).toMatchObject({
      error: { code: "FORBIDDEN" },
    })
    const [still] = await sql`SELECT 1 FROM kernel.users WHERE id = ${ph}`
    expect(still).toBeDefined()
  })

  it("stage-time preflight refuses two real accounts, so nobody is asked to approve it", async () => {
    const refused = await mergeImportedUserPreflight(
      { placeholderUserId: member.userId, targetUserId: admin.userId },
      { orgId, userId: admin.userId },
    )
    expect(refused).toMatchObject({ error: { code: "NOT_A_PLACEHOLDER" } })
    const ph = await placeholder("toolok")
    const ok = await mergeImportedUserPreflight(
      { placeholderUserId: ph, targetUserId: member.userId },
      { orgId, userId: admin.userId },
    )
    expect(ok).toEqual({ ok: true })
  })
})

describe("what a merge refuses, and what a preview never does", () => {
  it("never merges into a deactivated account or the erasure sentinel", async () => {
    const ph = await placeholder("inactive")
    const [gone] = await sql<Array<{ id: string }>>`
      INSERT INTO kernel.users (org_id, email, name, status)
      VALUES (${orgId}, ${`left-${crypto.randomUUID().slice(0, 6)}@t.co`}, 'Left', 'deactivated')
      RETURNING id`
    const res = await post(admin.bearer, ph, { targetUserId: gone!.id, dryRun: true })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error.code).toBe("TARGET_NOT_ACTIVE")
    const [sentinel] = await sql<Array<{ id: string }>>`
      INSERT INTO kernel.users (org_id, email, name, status)
      VALUES (${orgId}, ${`deleted-user-sentinel-${crypto.randomUUID()}`}, 'Deleted user', 'active')
      RETURNING id`
    const res2 = await post(admin.bearer, ph, { targetUserId: sentinel!.id })
    expect(res2.status).toBe(400)
    expect(((await res2.json()) as any).error.code).toBe("TARGET_NOT_ACTIVE")
  })

  it("refuses, before moving anything, a placeholder holding something that needs its own decision", async () => {
    const ph = await placeholder("holder")
    const room = await thread(ph)
    const msg = await message(room, ph, "kept as is")
    await sql`INSERT INTO kernel.mcp_connections (org_id, user_id, client_id, label, refresh_token_hash)
              VALUES (${orgId}, ${ph}, 'c', 'l', ${`h-${ph}`})`
    const res = await post(admin.bearer, ph, { targetUserId: realId })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe("BLOCKED_BY_REFERENCE")
    const [still] = await sql`SELECT author_id FROM kernel.messages WHERE id = ${msg}`
    expect(still?.author_id).toBe(ph)
  })

  it("refuses a placeholder that owns a pending approval, and keeps grant history", async () => {
    const ph = await placeholder("owner")
    const room = await thread(admin.userId)
    const [req] = await sql<Array<{ id: string }>>`
      INSERT INTO kernel.approval_requests (org_id, handle, thread_id, originating_thread_id,
                                            tool_name, tool_params, current_payload,
                                            requested_by, resource_owner_id, status, expires_at)
      VALUES (${orgId}, ${`ap-${crypto.randomUUID().slice(0, 8)}`}, ${room}, ${room},
              'kernel:x', '{}'::jsonb, '{}'::jsonb, ${admin.userId}, ${ph}, 'pending',
              now() + interval '1 day')
      RETURNING id`
    const res = await post(admin.bearer, ph, { targetUserId: realId, dryRun: true })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.message).toContain("pending approval")

    // Decided: no longer pending, the merge proceeds, and the grant history
    // recorded against the imported account moves instead of being deleted.
    await sql`UPDATE kernel.approval_requests SET status = 'denied' WHERE id = ${req!.id}`
    await sql`INSERT INTO kernel.app_scope_grant_audit (org_id, app_name, target_user_id,
                                                        scopes_set, scopes_added, scopes_removed)
              VALUES (${orgId}, 'kernel', ${ph}, '{}', '{kernel:threads:read}', '{}')`
    const done = await post(admin.bearer, ph, { targetUserId: realId })
    expect(done.status).toBe(200)
    const history = await sql`SELECT 1 FROM kernel.app_scope_grant_audit
                               WHERE org_id = ${orgId} AND target_user_id = ${realId}`
    expect(history.length).toBe(1)
    const [owned] =
      await sql`SELECT resource_owner_id FROM kernel.approval_requests WHERE id = ${req!.id}`
    expect(owned?.resource_owner_id).toBe(realId)
  })

  it("refuses a placeholder that owns a deferred bundle step", async () => {
    const ph = await placeholder("deferred")
    const room = await thread(admin.userId)
    const bundleId = crypto.randomUUID()
    await sql`
      INSERT INTO kernel.approval_requests (org_id, handle, thread_id, originating_thread_id,
                                            tool_name, tool_params, current_payload,
                                            requested_by, resource_owner_id, status, expires_at,
                                            bundle_id, bundle_position)
      VALUES (${orgId}, ${`ap-${crypto.randomUUID().slice(0, 8)}`}, ${room}, ${room},
              'kernel:x', '{}'::jsonb, '{}'::jsonb, ${admin.userId}, ${ph}, 'deferred',
              now() + interval '1 day', ${bundleId}, 1)`
    const res = await post(admin.bearer, ph, { targetUserId: realId })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.code).toBe("BLOCKED_BY_REFERENCE")
    const [still] = await sql`SELECT 1 FROM kernel.users WHERE id = ${ph}`
    expect(still).toBeDefined()
  })

  it("a preview takes no row lock: it answers while another transaction holds the users", async () => {
    const ph = await placeholder("locked")
    const postgres = (await import("postgres")).default
    // A second session on the SAME database: the run's superuser URL, which the
    // runner points at this run's (namespace or shard) database. A bare
    // MIGRATION_DATABASE_URL is not set by the runner, and unset it fell back to
    // the OS user, whom Postgres refuses.
    const otherUrl = process.env.DATABASE_URL_SUPERUSER ?? process.env.MIGRATION_DATABASE_URL
    if (!otherUrl) throw new Error("DATABASE_URL_SUPERUSER is not set: run through the test runner")
    const other = postgres(otherUrl, { max: 1 })
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    const locking = other.begin(async (tx) => {
      await tx`SELECT 1 FROM kernel.users WHERE id IN (${ph}, ${realId}) FOR UPDATE`
      await held
    })
    try {
      await new Promise((r) => setTimeout(r, 100))
      const preview = mergePlaceholderIntoUser({
        orgId,
        actorId: admin.userId,
        placeholderId: ph,
        targetId: realId,
        dryRun: true,
      })
      const winner = await Promise.race([
        preview.then(() => "answered"),
        new Promise((r) => setTimeout(() => r("blocked"), 3_000)),
      ])
      expect(winner).toBe("answered")
    } finally {
      release()
      await locking
      await other.end()
    }
  })
})
