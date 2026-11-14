// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The startup governance check ("App declares governed tables no grantable
// scope can reach") flagged 15 tables of the built-in apps. 14 were false
// alarms: their real access comes from policies the SQL migrations own, which
// Postgres ORs with the generated ones, and the check only modelled the
// generated policies. The fix taught the check about migration-owned access
// and changed no policy on those tables. One gap was real: tickets `api_keys`
// had no policy a `tickets:settings:admin` holder could pass, so the tickets
// admin role saw an empty key list and could not create a key.
//
// This file proves that nobody lost anything. For each of the 15 tables, a
// least-privilege member holding the scopes real roles grant today runs every
// read and write its tools perform, under RLS. On the code before the fix
// every case passes except the three api_keys management cases; after it,
// all pass, and the non-widening cases (other users' drafts and read markers,
// key management for a support agent) still deny.
//
// It also boots every built-in app for a fresh org and asserts the
// registration logs no governance warning and no drift warning for the
// columns the same change reconciled (tickets sla_deadline and handle,
// projects due_date and start_date, knowledge documents' sharing columns and
// source_links.synced_source_id; later projects next_task_number and tasks
// archived_at), and that none of them was altered.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import projectsManifest from "~/apps/projects/app.manifest.json"
import { runAdminOp } from "~/apps/tickets/admin"
import ticketsManifest from "~/apps/tickets/app.manifest.json"
import { extractRows } from "~/db"
import { __privileged_db__ as db, sql } from "~/db/connection"
import { type ActorContext, withRlsContext } from "~/db/rls"
import { appsLogger } from "~/lib/logger"
import { TEST_ONLY_APPS } from "~/modules/apps/discover-apps"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { AppRegistrationFatalError, registerApps } from "~/modules/apps/runtime"

type Manifest = { roles?: Record<string, { scopes?: string[]; extends?: string }> }

function roleScopes(manifest: Manifest, role: string): string[] {
  const def = manifest.roles?.[role]
  if (!def) throw new Error(`unknown role ${role}`)
  const inherited = def.extends ? roleScopes(manifest, def.extends) : []
  return [...new Set([...inherited, ...(def.scopes ?? [])])]
}

const slug = `access-no-loss-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
let orgId: string
let userId: string
let otherUserId: string
const warnings: { obj: Record<string, unknown>; msg: string }[] = []

// Fixture ids, all seeded through the privileged pool.
const id = () => crypto.randomUUID()
const mail = { sharedAccount: id(), personalAccount: id(), sharedConv: id(), personalConv: id() }
const proj = { project: id(), status: id(), thread: id(), task: id() }
const know = {
  identity: id(),
  link: id(),
  collection: id(),
  tag: id(),
  cache: id(),
  policySource: `src-${slug}`,
}
const tick = { ticket: id(), otherMarkerTicket: id() }

function user(scopes: string[], dimensionGrants: Record<string, string[]> = {}): ActorContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants }
}

async function asActor<T extends Record<string, unknown>>(
  actor: ActorContext,
  query: SQL,
): Promise<T[]> {
  return withRlsContext(actor, async (tx) => extractRows<T>(await tx.execute(query)))
}

async function system(query: SQL): Promise<void> {
  await db.execute(query)
}

async function seedTicket(ticketId: string, team: string): Promise<void> {
  await system(drizzleSql`
    INSERT INTO app_tickets.tickets (
      id, org_id, handle, subject, status, priority, channel, sensitivity, team,
      reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
      sla_elapsed_seconds, message_count, created_at, updated_at
    ) VALUES (
      ${ticketId}, ${orgId}, ${`ticket-${ticketId.slice(0, 8)}`}, 'No-loss fixture', 'open',
      'normal', 'manual', 'internal', ${team}, ${`RT${ticketId.replace(/-/g, "").slice(0, 14)}`},
      3600, now() + interval '1 hour', now(), 0, 0, now(), now()
    )`)
}

beforeAll(async () => {
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Access No Loss Org', ${slug}) RETURNING id`),
  )
  orgId = org.id
  const users = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES
        (gen_random_uuid(), ${orgId}, ${`a-${slug}@test.com`}, 'Member', 'active', 'hash', 1, 1),
        (gen_random_uuid(), ${orgId}, ${`b-${slug}@test.com`}, 'Colleague', 'active', 'hash', 1, 1)
      RETURNING id`),
  )
  userId = users[0].id
  otherUserId = users[1].id

  // The first registration of this org in the process runs the full
  // registration body: governance check, drift detection and the NOT NULL
  // heal. Capture what it logs.
  const warnSpy = spyOn(appsLogger, "warn").mockImplementation(((obj: unknown, msg: unknown) => {
    warnings.push({ obj: (obj ?? {}) as Record<string, unknown>, msg: String(msg ?? "") })
  }) as never)
  try {
    await ensureAppsForOrg(orgId, {})
  } finally {
    warnSpy.mockRestore()
  }

  // Mail: one shared (org) inbox and the member's own personal inbox.
  await system(drizzleSql`
    INSERT INTO app_mail.accounts (id, org_id, connected_account_id, provider, email_address, sync_status, owner_type, owner_id)
    VALUES
      (${mail.sharedAccount}, ${orgId}, gen_random_uuid(), 'gmail', ${`shared-${slug}@test.com`}, 'idle', 'org', NULL),
      (${mail.personalAccount}, ${orgId}, gen_random_uuid(), 'gmail', ${`own-${slug}@test.com`}, 'idle', 'user', ${userId})`)
  await system(drizzleSql`
    INSERT INTO app_mail.conversations (id, org_id, account_id, external_thread_id, status, owner_type, owner_id)
    VALUES
      (${mail.sharedConv}, ${orgId}, ${mail.sharedAccount}, ${`t-shared-${slug}`}, 'open', 'org', NULL),
      (${mail.personalConv}, ${orgId}, ${mail.personalAccount}, ${`t-own-${slug}`}, 'open', 'user', ${userId})`)
  // A colleague's draft on the shared inbox: must stay invisible to the member.
  await system(drizzleSql`
    INSERT INTO app_mail.drafts (org_id, account_id, created_by)
    VALUES (${orgId}, ${mail.sharedAccount}, ${otherUserId})`)

  // Projects: a project with one status column and one task.
  await system(drizzleSql`
    INSERT INTO kernel.threads (id, org_id, handle, created_by)
    VALUES (${proj.thread}, ${orgId}, ${`thr-${slug}`}, ${userId})`)
  await system(drizzleSql`
    INSERT INTO app_projects.projects (id, org_id, name, owner_id, key)
    VALUES (${proj.project}, ${orgId}, 'No-loss project', ${userId}, 'NL')`)
  await system(drizzleSql`
    INSERT INTO app_projects.project_statuses (id, org_id, project_id, label, "order")
    VALUES (${proj.status}, ${orgId}, ${proj.project}, 'Todo', 0)`)
  await system(drizzleSql`
    INSERT INTO app_projects.tasks (id, org_id, project_id, status_id, title, thread_id, created_by, number)
    VALUES (${proj.task}, ${orgId}, ${proj.project}, ${proj.status}, 'No-loss task', ${proj.thread}, ${userId}, 1)`)

  // Knowledge: one linked source document, a collection, a tag, a cache entry
  // and a source policy, plus the memberships that point at the link.
  await system(drizzleSql`
    INSERT INTO app_knowledge.source_identities (id, org_id, source, external_id)
    VALUES (${know.identity}, ${orgId}, 'google-drive', ${`ext-${slug}`})`)
  await system(drizzleSql`
    INSERT INTO app_knowledge.source_links (id, org_id, source_identity_id, source, external_id, title)
    VALUES (${know.link}, ${orgId}, ${know.identity}, 'google-drive', ${`ext-${slug}`}, 'Linked doc')`)
  await system(drizzleSql`
    INSERT INTO app_knowledge.collections (id, org_id, name) VALUES (${know.collection}, ${orgId}, 'Root')`)
  await system(drizzleSql`
    INSERT INTO app_knowledge.tags (id, org_id, name, normalized_name)
    VALUES (${know.tag}, ${orgId}, 'Seeded', 'seeded')`)
  await system(drizzleSql`
    INSERT INTO app_knowledge.collection_memberships (org_id, collection_id, target_type, target_id)
    VALUES (${orgId}, ${know.collection}, 'source_link', ${know.link})`)
  await system(drizzleSql`
    INSERT INTO app_knowledge.taggings (org_id, tag_id, target_type, target_id)
    VALUES (${orgId}, ${know.tag}, 'source_link', ${know.link})`)
  await system(drizzleSql`
    INSERT INTO app_knowledge.content_cache_entries (id, org_id, source_identity_id)
    VALUES (${know.cache}, ${orgId}, ${know.identity})`)
  await system(drizzleSql`
    INSERT INTO app_knowledge.source_policies (org_id, source) VALUES (${orgId}, ${know.policySource})`)

  // Tickets: a ticket in the agent's team, and a colleague's read marker on it.
  await seedTicket(tick.ticket, "support")
  await system(drizzleSql`
    INSERT INTO app_tickets.ticket_reads (ticket_id, user_id, org_id, read_at)
    VALUES (${tick.ticket}, ${otherUserId}, ${orgId}, now())`)
})

afterAll(async () => {
  if (!orgId) return
  for (const stmt of [
    `DELETE FROM app_tickets.api_keys WHERE org_id = $1`,
    `DELETE FROM app_tickets.ticket_reads WHERE org_id = $1`,
    `DELETE FROM app_tickets.tickets WHERE org_id = $1`,
    `DELETE FROM app_knowledge.synced_sources WHERE org_id = $1`,
    `DELETE FROM app_knowledge.collection_memberships WHERE org_id = $1`,
    `DELETE FROM app_knowledge.taggings WHERE org_id = $1`,
    `DELETE FROM app_knowledge.tags WHERE org_id = $1`,
    `DELETE FROM app_knowledge.collections WHERE org_id = $1`,
    `DELETE FROM app_knowledge.content_cache_entries WHERE org_id = $1`,
    `DELETE FROM app_knowledge.source_policies WHERE org_id = $1`,
    `DELETE FROM app_knowledge.source_links WHERE org_id = $1`,
    `DELETE FROM app_knowledge.source_identities WHERE org_id = $1`,
    `DELETE FROM app_projects.task_checklist_items WHERE org_id = $1`,
    `DELETE FROM app_projects.tasks WHERE org_id = $1`,
    `DELETE FROM app_projects.project_statuses WHERE org_id = $1`,
    `DELETE FROM app_projects.projects WHERE org_id = $1`,
    `DELETE FROM app_mail.drafts WHERE org_id = $1`,
    `DELETE FROM app_mail.messages WHERE org_id = $1`,
    `DELETE FROM app_mail.conversations WHERE org_id = $1`,
    `DELETE FROM app_mail.accounts WHERE org_id = $1`,
  ]) {
    await sql.unsafe(stmt, [orgId]).catch(() => {})
  }
})

// ── Least-privilege actors, scopes taken from the roles real orgs grant ─────

// Mail declares no app roles: a mailbox user holds mail:accounts:read (the
// composer and reply tools require it) and mail:conversations:read/write, plus
// an inbox dimension grant per account.
const mailMember = () =>
  user(["mail:accounts:read", "mail:conversations:read", "mail:conversations:write"], {
    "mail:inbox": [mail.sharedAccount, mail.personalAccount],
  })
const projectsMember = () => user(roleScopes(projectsManifest as Manifest, "member"))
const projectsLead = () => user(roleScopes(projectsManifest as Manifest, "lead"))
const knowledgeMember = () => user(roleScopes(knowledgeManifest as Manifest, "member"))
const knowledgeCurator = () => user(roleScopes(knowledgeManifest as Manifest, "curator"))
const knowledgeAdmin = () => user(roleScopes(knowledgeManifest as Manifest, "admin"))
const ticketDims = { "tickets:team": ["support"], "tickets:sensitivity": ["internal"] }
const ticketsSupport = () => user(roleScopes(ticketsManifest as Manifest, "support"), ticketDims)
const ticketsAdmin = () => user(roleScopes(ticketsManifest as Manifest, "admin"), ticketDims)

describe("mail: messages and drafts keep every access a member has", () => {
  for (const which of ["shared", "personal"] as const) {
    it(`messages: read, insert, update, delete on a ${which} inbox`, async () => {
      const account = which === "shared" ? mail.sharedAccount : mail.personalAccount
      const conv = which === "shared" ? mail.sharedConv : mail.personalConv
      const msgId = id()
      const inserted = await asActor(
        mailMember(),
        drizzleSql`INSERT INTO app_mail.messages (id, org_id, conversation_id, account_id, direction)
          VALUES (${msgId}, ${orgId}, ${conv}, ${account}, 'inbound') RETURNING id`,
      )
      expect(inserted).toHaveLength(1)
      const read = await asActor(
        mailMember(),
        drizzleSql`SELECT id FROM app_mail.messages WHERE id = ${msgId}`,
      )
      expect(read).toHaveLength(1)
      const updated = await asActor(
        mailMember(),
        drizzleSql`UPDATE app_mail.messages SET is_read = true WHERE id = ${msgId} RETURNING id`,
      )
      expect(updated).toHaveLength(1)
      const deleted = await asActor(
        mailMember(),
        drizzleSql`DELETE FROM app_mail.messages WHERE id = ${msgId} RETURNING id`,
      )
      expect(deleted).toHaveLength(1)
    })

    it(`drafts: the author reads, writes and deletes own draft on a ${which} inbox`, async () => {
      const account = which === "shared" ? mail.sharedAccount : mail.personalAccount
      const draftId = id()
      const inserted = await asActor(
        mailMember(),
        drizzleSql`INSERT INTO app_mail.drafts (id, org_id, account_id, created_by)
          VALUES (${draftId}, ${orgId}, ${account}, ${userId}) RETURNING id`,
      )
      expect(inserted).toHaveLength(1)
      expect(
        await asActor(
          mailMember(),
          drizzleSql`SELECT id FROM app_mail.drafts WHERE id = ${draftId}`,
        ),
      ).toHaveLength(1)
      expect(
        await asActor(
          mailMember(),
          drizzleSql`UPDATE app_mail.drafts SET updated_at = now() WHERE id = ${draftId} RETURNING id`,
        ),
      ).toHaveLength(1)
      expect(
        await asActor(
          mailMember(),
          drizzleSql`DELETE FROM app_mail.drafts WHERE id = ${draftId} RETURNING id`,
        ),
      ).toHaveLength(1)
    })
  }

  it("drafts: a colleague's draft on a shared inbox stays invisible (not widened)", async () => {
    const rows = await asActor(
      mailMember(),
      drizzleSql`SELECT id FROM app_mail.drafts WHERE created_by = ${otherUserId}`,
    )
    expect(rows).toHaveLength(0)
  })
})

describe("projects: statuses and checklist items keep every access", () => {
  it("project_statuses: a member reads the board's columns", async () => {
    const rows = await asActor(
      projectsMember(),
      drizzleSql`SELECT id FROM app_projects.project_statuses WHERE project_id = ${proj.project}`,
    )
    expect(rows).toHaveLength(1)
  })

  it("project_statuses: a lead adds, renames and deletes a column", async () => {
    const statusId = id()
    expect(
      await asActor(
        projectsLead(),
        drizzleSql`INSERT INTO app_projects.project_statuses (id, org_id, project_id, label, "order")
          VALUES (${statusId}, ${orgId}, ${proj.project}, 'Review', 1) RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        projectsLead(),
        drizzleSql`UPDATE app_projects.project_statuses SET label = 'In review' WHERE id = ${statusId} RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        projectsLead(),
        drizzleSql`DELETE FROM app_projects.project_statuses WHERE id = ${statusId} RETURNING id`,
      ),
    ).toHaveLength(1)
  })

  it("task_checklist_items: a member adds, reads, checks and removes an item", async () => {
    const itemId = id()
    expect(
      await asActor(
        projectsMember(),
        drizzleSql`INSERT INTO app_projects.task_checklist_items (id, org_id, task_id, title, created_by)
          VALUES (${itemId}, ${orgId}, ${proj.task}, 'Check it', ${userId}) RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        projectsMember(),
        drizzleSql`SELECT id FROM app_projects.task_checklist_items WHERE id = ${itemId}`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        projectsMember(),
        drizzleSql`UPDATE app_projects.task_checklist_items SET title = 'Checked' WHERE id = ${itemId} RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        projectsMember(),
        drizzleSql`DELETE FROM app_projects.task_checklist_items WHERE id = ${itemId} RETURNING id`,
      ),
    ).toHaveLength(1)
  })
})

describe("knowledge: the nine migration-governed tables keep every access", () => {
  it("a member reads every table", async () => {
    const m = knowledgeMember()
    const counts = {
      source_identities: await asActor(
        m,
        drizzleSql`SELECT id FROM app_knowledge.source_identities WHERE id = ${know.identity}`,
      ),
      source_links: await asActor(
        m,
        drizzleSql`SELECT id FROM app_knowledge.source_links WHERE id = ${know.link}`,
      ),
      collections: await asActor(
        m,
        drizzleSql`SELECT id FROM app_knowledge.collections WHERE id = ${know.collection}`,
      ),
      collection_memberships: await asActor(
        m,
        drizzleSql`SELECT id FROM app_knowledge.collection_memberships WHERE target_id = ${know.link}`,
      ),
      tags: await asActor(m, drizzleSql`SELECT id FROM app_knowledge.tags WHERE id = ${know.tag}`),
      taggings: await asActor(
        m,
        drizzleSql`SELECT id FROM app_knowledge.taggings WHERE target_id = ${know.link}`,
      ),
      content_cache_entries: await asActor(
        m,
        drizzleSql`SELECT id FROM app_knowledge.content_cache_entries WHERE id = ${know.cache}`,
      ),
      source_policies: await asActor(
        m,
        drizzleSql`SELECT id FROM app_knowledge.source_policies WHERE source = ${know.policySource}`,
      ),
    }
    expect(Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.length]))).toEqual({
      source_identities: 1,
      source_links: 1,
      collections: 1,
      collection_memberships: 1,
      tags: 1,
      taggings: 1,
      content_cache_entries: 1,
      source_policies: 1,
    })
  })

  it("a member links a source (identity + link) and updates the link", async () => {
    const identityId = id()
    const linkId = id()
    const ext = `ext-member-${slug}`
    expect(
      await asActor(
        knowledgeMember(),
        drizzleSql`INSERT INTO app_knowledge.source_identities (id, org_id, source, external_id)
          VALUES (${identityId}, ${orgId}, 'google-drive', ${ext}) RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        knowledgeMember(),
        drizzleSql`INSERT INTO app_knowledge.source_links (id, org_id, source_identity_id, source, external_id, title)
          VALUES (${linkId}, ${orgId}, ${identityId}, 'google-drive', ${ext}, 'Member link') RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        knowledgeMember(),
        drizzleSql`UPDATE app_knowledge.source_links SET summary = 'updated' WHERE id = ${linkId} RETURNING id`,
      ),
    ).toHaveLength(1)
  })

  it("a member mounts, reads, updates and removes a personal synced folder", async () => {
    const sourceId = id()
    expect(
      await asActor(
        knowledgeMember(),
        drizzleSql`INSERT INTO app_knowledge.synced_sources (id, org_id, app_name, folder_ref, display_name, root_collection_id, created_by, owner_user_id)
          VALUES (${sourceId}, ${orgId}, 'google-drive', 'folder-1', 'My folder', ${know.collection}, ${userId}, ${userId}) RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        knowledgeMember(),
        drizzleSql`SELECT id FROM app_knowledge.synced_sources WHERE id = ${sourceId}`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        knowledgeMember(),
        drizzleSql`UPDATE app_knowledge.synced_sources SET display_name = 'Renamed' WHERE id = ${sourceId} RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        knowledgeMember(),
        drizzleSql`DELETE FROM app_knowledge.synced_sources WHERE id = ${sourceId} RETURNING id`,
      ),
    ).toHaveLength(1)
  })

  it("a curator manages collections, memberships, tags, taggings, source policies and source identities", async () => {
    const c = knowledgeCurator()
    const colId = id()
    const tagId = id()
    const source = `curated-${slug}`
    expect(
      await asActor(
        c,
        drizzleSql`INSERT INTO app_knowledge.collections (id, org_id, name) VALUES (${colId}, ${orgId}, 'Curated') RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        c,
        drizzleSql`UPDATE app_knowledge.collections SET name = 'Curated 2' WHERE id = ${colId} RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        c,
        drizzleSql`INSERT INTO app_knowledge.collection_memberships (org_id, collection_id, target_type, target_id)
          VALUES (${orgId}, ${colId}, 'source_link', ${know.link}) RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        c,
        drizzleSql`DELETE FROM app_knowledge.collection_memberships WHERE collection_id = ${colId} RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        c,
        drizzleSql`DELETE FROM app_knowledge.collections WHERE id = ${colId} RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        c,
        drizzleSql`INSERT INTO app_knowledge.tags (id, org_id, name, normalized_name)
          VALUES (${tagId}, ${orgId}, 'Curated', 'curated') RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        c,
        drizzleSql`INSERT INTO app_knowledge.taggings (org_id, tag_id, target_type, target_id)
          VALUES (${orgId}, ${tagId}, 'source_link', ${know.link}) RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        c,
        drizzleSql`DELETE FROM app_knowledge.taggings WHERE tag_id = ${tagId} RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(c, drizzleSql`DELETE FROM app_knowledge.tags WHERE id = ${tagId} RETURNING id`),
    ).toHaveLength(1)
    expect(
      await asActor(
        c,
        drizzleSql`INSERT INTO app_knowledge.source_policies (org_id, source) VALUES (${orgId}, ${source}) RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        c,
        drizzleSql`DELETE FROM app_knowledge.source_policies WHERE source = ${source} RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        c,
        drizzleSql`UPDATE app_knowledge.source_identities SET mime_type = 'text/plain' WHERE id = ${know.identity} RETURNING id`,
      ),
    ).toHaveLength(1)
  })

  it("a curator deletes a source link", async () => {
    const identityId = id()
    const linkId = id()
    const ext = `ext-curator-${slug}`
    await system(drizzleSql`
      INSERT INTO app_knowledge.source_identities (id, org_id, source, external_id)
      VALUES (${identityId}, ${orgId}, 'google-drive', ${ext})`)
    await system(drizzleSql`
      INSERT INTO app_knowledge.source_links (id, org_id, source_identity_id, source, external_id, title)
      VALUES (${linkId}, ${orgId}, ${identityId}, 'google-drive', ${ext}, 'To delete')`)
    expect(
      await asActor(
        knowledgeCurator(),
        drizzleSql`DELETE FROM app_knowledge.source_links WHERE id = ${linkId} RETURNING id`,
      ),
    ).toHaveLength(1)
  })

  it("an admin writes the content cache", async () => {
    const identityId = id()
    await system(drizzleSql`
      INSERT INTO app_knowledge.source_identities (id, org_id, source, external_id)
      VALUES (${identityId}, ${orgId}, 'google-drive', ${`ext-cache-${slug}`})`)
    const cacheId = id()
    expect(
      await asActor(
        knowledgeAdmin(),
        drizzleSql`INSERT INTO app_knowledge.content_cache_entries (id, org_id, source_identity_id)
          VALUES (${cacheId}, ${orgId}, ${identityId}) RETURNING id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        knowledgeAdmin(),
        drizzleSql`UPDATE app_knowledge.content_cache_entries SET updated_at = now() WHERE id = ${cacheId} RETURNING id`,
      ),
    ).toHaveLength(1)
  })
})

describe("tickets: read markers keep every access; api keys reach the tickets admin role", () => {
  it("ticket_reads: a support agent marks a ticket read, reads, updates and clears the marker", async () => {
    const a = ticketsSupport()
    expect(
      await asActor(
        a,
        drizzleSql`INSERT INTO app_tickets.ticket_reads (ticket_id, user_id, org_id, read_at)
          VALUES (${tick.ticket}, ${userId}, ${orgId}, now()) RETURNING ticket_id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        a,
        drizzleSql`SELECT ticket_id FROM app_tickets.ticket_reads WHERE ticket_id = ${tick.ticket} AND user_id = ${userId}`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        a,
        drizzleSql`UPDATE app_tickets.ticket_reads SET read_at = now() WHERE ticket_id = ${tick.ticket} AND user_id = ${userId} RETURNING ticket_id`,
      ),
    ).toHaveLength(1)
    expect(
      await asActor(
        a,
        drizzleSql`DELETE FROM app_tickets.ticket_reads WHERE ticket_id = ${tick.ticket} AND user_id = ${userId} RETURNING ticket_id`,
      ),
    ).toHaveLength(1)
  })

  it("ticket_reads: an agent cannot rewrite a colleague's marker (not widened)", async () => {
    const rows = await asActor(
      ticketsSupport(),
      drizzleSql`UPDATE app_tickets.ticket_reads SET read_at = now() WHERE user_id = ${otherUserId} RETURNING ticket_id`,
    )
    expect(rows).toHaveLength(0)
  })

  it("api_keys: the tickets admin role creates, lists and revokes a key", async () => {
    const a = ticketsAdmin()
    const ref = { actorType: "user" as const, userId, scopes: a.scopes }
    const created = (await withRlsContext(a, (tx) =>
      runAdminOp(tx as never, orgId, "apiKeysCreate", { label: "Support form" }, ref),
    )) as { id?: string; error?: unknown }
    expect(created.error).toBeUndefined()
    expect(typeof created.id).toBe("string")
    const listed = (await withRlsContext(a, (tx) =>
      runAdminOp(tx as never, orgId, "apiKeysList", {}, ref),
    )) as unknown as { id: string }[]
    expect(listed.map((k) => k.id)).toContain(created.id as string)
    await withRlsContext(a, (tx) =>
      runAdminOp(tx as never, orgId, "apiKeysRevoke", { id: created.id }, ref),
    )
    const [row] = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM app_tickets.api_keys WHERE id = ${created.id as string}`
    expect(row.revoked_at).not.toBeNull()
  })

  it("api_keys: a support agent still sees and writes no key (not widened)", async () => {
    await system(drizzleSql`
      INSERT INTO app_tickets.api_keys (org_id, key_hash, key_prefix, label, created_by)
      VALUES (${orgId}, ${`hash-${slug}`}, 'abcdefgh', 'Seeded', ${userId})`)
    const a = ticketsSupport()
    expect(
      await asActor(a, drizzleSql`SELECT id FROM app_tickets.api_keys WHERE org_id = ${orgId}`),
    ).toHaveLength(0)
    await expect(
      asActor(
        a,
        drizzleSql`INSERT INTO app_tickets.api_keys (org_id, key_hash, key_prefix, label, created_by)
          VALUES (${orgId}, ${`hash2-${slug}`}, 'ijklmnop', 'Agent', ${userId}) RETURNING id`,
      ),
    ).rejects.toThrow()
  })

  it("api_keys: an org owner (wildcard scope) keeps full access", async () => {
    const owner = user(["*"], { "*": ["*"] })
    expect(
      (
        await asActor(
          owner,
          drizzleSql`SELECT id FROM app_tickets.api_keys WHERE org_id = ${orgId}`,
        )
      ).length,
    ).toBeGreaterThan(0)
    expect(
      await asActor(
        owner,
        drizzleSql`INSERT INTO app_tickets.api_keys (org_id, key_hash, key_prefix, label, created_by)
          VALUES (${orgId}, ${`hash3-${slug}`}, 'qrstuvwx', 'Owner', ${userId}) RETURNING id`,
      ),
    ).toHaveLength(1)
  })
})

describe("startup registration of the built-in apps", () => {
  it("refuses no app for a table its scopes cannot reach", async () => {
    // A refusal throws outside production, so reaching this line already says
    // the registration above refused none; no app is left in error either.
    const errored = await sql<{ name: string }[]>`
      SELECT name FROM kernel.apps WHERE org_id = ${orgId} AND status = 'error'`
    expect(errored.map((r) => r.name).filter((n) => !TEST_ONLY_APPS.has(n))).toEqual([])
  })

  it("logs no drift warning for the reconciled columns", () => {
    const watched: Record<string, string[]> = {
      "tickets.tickets": ["sla_deadline", "handle"],
      "projects.projects": ["next_task_number"],
      "projects.tasks": ["due_date", "start_date", "archived_at"],
      "knowledge.documents": [
        "org_access",
        "edit_scope",
        "acl_user_ids",
        "acl_role_ids",
        "org_wide",
        "required_scopes",
      ],
      "knowledge.source_links": ["synced_source_id"],
    }
    const drift = warnings
      .filter((w) => w.msg.startsWith("Schema drift"))
      .filter((w) => (watched[`${w.obj.app}.${w.obj.entity}`] ?? []).includes(String(w.obj.column)))
      .map((w) => `${w.obj.app}.${w.obj.entity}.${w.obj.column}: ${w.msg}`)
    expect(drift).toEqual([])
  })

  it("still generates the runtime policies of the migration-governed tables", async () => {
    // The marker only steers the check: the generated policies (which keep
    // serving wildcard grants) are created exactly as before.
    const rows = await sql<{ t: string; n: string }[]>`
      SELECT schemaname || '.' || tablename AS t, count(*)::text AS n FROM pg_policies
      WHERE (schemaname, tablename) IN (
        ('app_mail', 'messages'), ('app_mail', 'drafts'),
        ('app_projects', 'project_statuses'), ('app_projects', 'task_checklist_items'),
        ('app_tickets', 'ticket_reads'), ('app_tickets', 'api_keys')
      ) AND policyname ~ '_rls_(select|insert|update|delete)$'
      GROUP BY 1 ORDER BY 1`
    expect(rows.map((r) => `${r.t} ${r.n}`)).toEqual([
      "app_mail.drafts 4",
      "app_mail.messages 4",
      "app_projects.project_statuses 4",
      "app_projects.task_checklist_items 4",
      "app_tickets.api_keys 4",
      "app_tickets.ticket_reads 4",
    ])
  })

  it("leaves the reconciled columns as the migrations made them", async () => {
    const cols = await sql<
      {
        table_schema: string
        table_name: string
        column_name: string
        data_type: string
        is_nullable: string
      }[]
    >`
      SELECT table_schema, table_name, column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE (table_schema, table_name, column_name) IN (
        ('app_tickets', 'tickets', 'sla_deadline'),
        ('app_tickets', 'tickets', 'handle'),
        ('app_projects', 'projects', 'next_task_number'),
        ('app_projects', 'tasks', 'archived_at'),
        ('app_projects', 'tasks', 'due_date'),
        ('app_projects', 'tasks', 'start_date'),
        ('app_knowledge', 'documents', 'edit_scope'),
        ('app_knowledge', 'source_links', 'synced_source_id')
      )
      ORDER BY 1, 2, 3`
    expect(
      cols.map((c) => `${c.table_name}.${c.column_name} ${c.data_type} ${c.is_nullable}`),
    ).toEqual([
      "documents.edit_scope text YES",
      "source_links.synced_source_id uuid YES",
      "projects.next_task_number integer NO",
      "tasks.archived_at timestamp with time zone YES",
      "tasks.due_date date YES",
      "tasks.start_date date YES",
      "tickets.handle text NO",
      "tickets.sla_deadline timestamp with time zone YES",
    ])
  })
})

describe("the governance check on a migration-governed table", () => {
  const APP = "mg-check-app"
  const SCHEMA = "app_mg_check_app"
  const manifest = (version: string) => ({
    name: APP,
    version,
    _format: "manifest" as const,
    _bundlePath: "/apps/mg-check-app/handlers.js",
    schema: { notes: { rlsGovernedByMigration: true, fields: { title: "string" } } },
  })
  /** The tables a refused registration names, or [] when it registers. */
  const refusedTables = async (version: string): Promise<string[]> => {
    try {
      await registerApps([manifest(version) as never], orgId)
      return []
    } catch (err) {
      if (!(err instanceof AppRegistrationFatalError)) throw err
      return (err.details.tables ?? []) as string[]
    }
  }

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    await sql`DELETE FROM kernel.apps WHERE name = ${APP}`
  })

  it("refuses the app while no migration policy can grant the table, and registers it once one does", async () => {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
    // A migration created the table with a deny-default policy alone, which grants nothing.
    // Owned by the role registrations run as, as a migration-created schema is.
    await sql.unsafe(`CREATE SCHEMA "${SCHEMA}"`)
    await sql.unsafe(
      `CREATE TABLE "${SCHEMA}".notes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, title text NOT NULL)`,
    )
    await sql.unsafe(`ALTER TABLE "${SCHEMA}".notes ENABLE ROW LEVEL SECURITY`)
    await sql.unsafe(`ALTER SCHEMA "${SCHEMA}" OWNER TO liaison_admin`)
    await sql.unsafe(`ALTER TABLE "${SCHEMA}".notes OWNER TO liaison_admin`)
    await sql.unsafe(
      `CREATE POLICY notes_deny_default ON "${SCHEMA}".notes FOR ALL TO liaison_rls USING (false) WITH CHECK (false)`,
    )
    expect(await refusedTables("1.0.1")).toEqual(["notes"])
    await sql.unsafe(
      `CREATE POLICY notes_owner ON "${SCHEMA}".notes FOR SELECT TO liaison_rls USING (org_id = NULLIF(rls_ctx.org_id(), '')::uuid)`,
    )
    expect(await refusedTables("1.0.2")).toEqual([])
  })
})
