// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DISCUSSION OF ANY ENTITY. One conversation per record an app declares
// (`entities.<type>.discussion: true`), where teammates and agents write about
// it. Like a task's comments and a contact's discussion, who reads and writes
// it is derived from who sees the record: kernel threads are participant-gated
// by RLS, and the only way in is to prove, under the caller's own RLS, that the
// record is visible to them (canReadThreadAnchorEntity). Opening it then
// enrols them, in a privileged step that runs only after that proof.
//
// A task keeps its own thread (`tasks.thread_id`) and a contact its primary
// thread: both are returned as they are, never a second one. Any other kind
// gets one thread with the handle `entity:<app>:<entityType>:<entityId>`; the
// org's unique handle index makes two simultaneous first opens one thread.
//
// When a record's sharing narrows, its app calls pruneEntityDiscussion (the
// sandbox bridge's `threads_pruneEntityDiscussion`): the people enrolled so far
// are dropped, and whoever can still see the record is enrolled again the next
// time they open it. When a record is deleted, its app calls
// deleteEntityDiscussions (the bridge's `threads_deleteEntityDiscussion`).
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"
import { lookupEntityDecl, resolveReferenceMetadataFromManifests } from "./reference-display"
import { canReadThreadAnchorEntity, type ThreadAnchorRef } from "./thread-anchor"

const log = rootLogger.child({ module: "entity-discussion" })
const ks = drizzleSql.raw(`"${schemaRef("kernel")}"`)

type Handle = PrivilegedDb | RlsClient

/** The entity names no kind that holds a discussion (422). */
export class DiscussionNotDeclaredError extends Error {
  readonly code = "discussion_not_declared"
  constructor(ref: { app: string; entityType: string }) {
    super(
      `${ref.app}:${ref.entityType} has no discussion: its app does not declare one (entities.${ref.entityType}.discussion).`,
    )
    this.name = "DiscussionNotDeclaredError"
  }
}

/** Kinds whose discussion is a thread they already own. */
const isTask = (ref: { app: string; entityType: string }) =>
  ref.app === "projects" && ref.entityType === "task"
const isContact = (ref: { app: string; entityType: string }) =>
  ref.app === "kernel" && ref.entityType === "contact"

/**
 * Whether the kind holds a discussion: a task or a contact, or an app entity
 * declaring `discussion: true` that has a page to open (a view for its kind).
 */
export function isDiscussionEntity(
  orgId: string,
  ref: { app: string; entityType: string },
): boolean {
  if (isTask(ref) || isContact(ref)) return true
  const decl = lookupEntityDecl(orgId, ref.app, ref.entityType) as {
    discussion?: unknown
    labelField?: unknown
  } | null
  if (decl?.discussion !== true || typeof decl.labelField !== "string") return false
  return resolveReferenceMetadataFromManifests(ref.app, ref.entityType, orgId) !== null
}

/** The handle of a declared entity's discussion thread. */
export function entityDiscussionHandle(ref: ThreadAnchorRef): string {
  if (isContact(ref)) return `contact-primary:${ref.entityId}`
  return `entity:${ref.app}:${ref.entityType}:${ref.entityId}`
}

export interface OpenedDiscussion {
  threadId: string
  /** True when this call created the thread. */
  created: boolean
}

/**
 * Open an entity's discussion for `userId`: its thread id, created on first
 * use, with the caller enrolled. Null when the entity does not exist, the
 * caller may not see it under `tx`'s RLS, or the caller is not an active member
 * of the organization (nothing is created then). Throws
 * DiscussionNotDeclaredError for a kind that holds none.
 */
export async function openEntityDiscussion(
  tx: RlsClient,
  params: { orgId: string; userId: string; ref: ThreadAnchorRef },
): Promise<OpenedDiscussion | null> {
  const { orgId, userId, ref } = params
  if (!isDiscussionEntity(orgId, ref)) throw new DiscussionNotDeclaredError(ref)

  if (isTask(ref)) {
    if (!UUID_RE.test(ref.entityId)) return null
    const { getTask } = await import("~/apps/projects/service/tasks")
    try {
      // Reading the task under the caller's RLS enrols them in its thread, as
      // opening the task's page does.
      const task = await getTask({ tx, orgId, taskId: ref.entityId, viewerId: userId })
      return task.threadId ? { threadId: task.threadId, created: false } : null
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null
      throw err
    }
  }

  if (isContact(ref)) {
    if (!UUID_RE.test(ref.entityId)) return null
    const { openContactDiscussion } = await import("~/modules/contacts/discussion")
    const opened = await openContactDiscussion(tx, {
      orgId,
      contactId: ref.entityId,
      userId,
    })
    return opened ? { threadId: opened.threadId, created: opened.created } : null
  }

  if (!(await canReadThreadAnchorEntity(tx, orgId, ref))) return null
  return getOrCreateEntityDiscussionThread(orgId, ref, userId)
}

/**
 * Find or create the thread of a declared entity and seat `userId` in it.
 * Privileged: the caller has already proved, under their own RLS, that they
 * see the entity, and a person not yet seated cannot see the thread under
 * `threads_select` (as getOrCreateContactPrimaryThread). Only an active member
 * of the organization is seated, the rule `enrolInEntityDiscussion` applies to
 * others: anyone else gets null and nothing is created.
 */
async function getOrCreateEntityDiscussionThread(
  orgId: string,
  ref: ThreadAnchorRef,
  userId: string,
): Promise<OpenedDiscussion | null> {
  const handle = entityDiscussionHandle(ref)
  return withPrivilegedDb(orgId, "entity-discussion-open", async (tx) => {
    const member = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${ks}.users
         WHERE id = ${userId}::uuid AND org_id = ${orgId}::uuid
           AND status = 'active' AND user_type = 'member'`),
    )
    if (member.length === 0) return null
    const find = async (): Promise<string | null> => {
      const [row] = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id FROM ${ks}.threads
           WHERE org_id = ${orgId}::uuid AND handle = ${handle} LIMIT 1`),
      )
      return row?.id ?? null
    }
    // Insert first, ON CONFLICT on the org's handle: of two simultaneous first
    // opens one inserts, and the other inserts nothing and reads its row.
    const id = randomUUID()
    const createdFrom = JSON.stringify({
      app: ref.app,
      entityType: ref.entityType,
      entityId: ref.entityId,
    })
    const inserted = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${ks}.threads (id, org_id, handle, title, type, hidden_from_list, created_by, created_from)
        VALUES (${id}::uuid, ${orgId}::uuid, ${handle}, NULL, 'thread', true, ${userId}::uuid, ${createdFrom}::jsonb)
        ON CONFLICT DO NOTHING
        RETURNING id::text AS id`),
    )
    const created = inserted.length > 0
    const threadId = created ? id : await find()
    if (created) {
      await tx.execute(drizzleSql`
        INSERT INTO ${ks}.thread_references (thread_id, org_id, app, entity_type, entity_id, added_by)
        VALUES (${id}::uuid, ${orgId}::uuid, ${ref.app}, ${ref.entityType}, ${ref.entityId}, ${userId}::uuid)
        ON CONFLICT DO NOTHING`)
    }
    if (!threadId) throw new Error(`entity discussion ${handle} could not be created`)
    await tx.execute(drizzleSql`
      INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${threadId}::uuid, ${userId}::uuid, ${orgId}::uuid, ${created ? "admin" : "member"})
      ON CONFLICT DO NOTHING`)
    return { threadId, created }
  })
}

/**
 * Seat the people named for an entity's discussion who may see the entity,
 * each judged under their OWN visibility (resolveThreadAnchorForReaders), never
 * the caller's: someone who cannot see the record is not seated and is
 * returned in `dropped`. The seats are written privileged because a person's
 * RLS lets them seat only themselves.
 */
export async function enrolInEntityDiscussion(params: {
  orgId: string
  threadId: string
  ref: ThreadAnchorRef
  userIds: readonly string[]
}): Promise<{ enrolled: string[]; dropped: string[] }> {
  const { orgId, threadId, ref } = params
  const ids = [...new Set(params.userIds)].filter((id) => UUID_RE.test(id))
  if (ids.length === 0) return { enrolled: [], dropped: [...new Set(params.userIds)] }
  // Only active members of this organization can be seated at all: a client's portal
  // account never joins an internal discussion, whatever it can see.
  const members = new Set(
    await withPrivilegedDb(orgId, "entity-discussion-members", async (tx) =>
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id::text AS id FROM ${ks}.users
           WHERE org_id = ${orgId}::uuid AND status = 'active' AND user_type = 'member'
             AND id IN (${drizzleSql.join(
               ids.map((id) => drizzleSql`${id}::uuid`),
               drizzleSql`, `,
             )})`),
      ).map((r) => r.id),
    ),
  )
  const { resolveThreadAnchorForReaders } = await import("./thread-anchor")
  const seen = await resolveThreadAnchorForReaders(
    orgId,
    ref,
    ids.filter((id) => members.has(id)),
  )
  const enrolled = ids.filter((id) => members.has(id) && seen.get(id))
  const dropped = [...new Set(params.userIds)].filter((id) => !enrolled.includes(id))
  if (enrolled.length > 0) {
    await withPrivilegedDb(orgId, "entity-discussion-enrol", async (tx) => {
      for (const userId of enrolled) {
        await tx.execute(drizzleSql`
          INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id, role)
          VALUES (${threadId}::uuid, ${userId}::uuid, ${orgId}::uuid, 'member')
          ON CONFLICT DO NOTHING`)
      }
    })
  }
  return { enrolled, dropped }
}

/**
 * Drop the people enrolled in an entity's discussion, but `keepUserId` (the
 * person who changed the sharing), after its sharing changed. Each one who can
 * still see the entity is enrolled again when they next open it. Agent seats
 * are kept: an agent reads only what its person may. `db` is a privileged
 * handle already open; without one the deletion runs in its own privileged,
 * org-scoped transaction, since a person's RLS may not remove someone else's
 * seat. A task has no row sharing (its project decides), so it has nothing to
 * prune here. Returns how many seats were dropped, or null when the entity has
 * no discussion yet.
 */
export async function pruneEntityDiscussion(
  params: { orgId: string; ref: ThreadAnchorRef; keepUserId: string | null },
  db?: Handle,
): Promise<number | null> {
  const handle = entityDiscussionHandle(params.ref)
  const run = async (h: Handle): Promise<number | null> => {
    const [thread] = extractRows<{ id: string }>(
      await h.execute(drizzleSql`
        SELECT id::text AS id FROM ${ks}.threads
         WHERE org_id = ${params.orgId}::uuid AND handle = ${handle}
         LIMIT 1`),
    )
    if (!thread) return null
    return extractRows(
      await h.execute(drizzleSql`
        DELETE FROM ${ks}.thread_participants
         WHERE org_id = ${params.orgId}::uuid AND thread_id = ${thread.id}::uuid
           AND user_id IS NOT NULL
           AND (${params.keepUserId}::uuid IS NULL OR user_id <> ${params.keepUserId}::uuid)
        RETURNING user_id`),
    ).length
  }
  if (db) return run(db)
  return withPrivilegedDb(params.orgId, "entity-discussion-prune", run)
}

/** The discussion thread of each entity that has one, by entity id. */
export async function entityDiscussionThreads(
  h: Handle,
  orgId: string,
  kind: { app: string; entityType: string },
  entityIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (entityIds.length === 0) return out
  const byHandle = new Map(
    entityIds.map((entityId) => [entityDiscussionHandle({ ...kind, entityId }), entityId]),
  )
  const handles = drizzleSql.join(
    [...byHandle.keys()].map((handle) => drizzleSql`${handle}`),
    drizzleSql`, `,
  )
  const rows = extractRows<{ id: string; handle: string }>(
    await h.execute(drizzleSql`
      SELECT id::text AS id, handle FROM ${ks}.threads
       WHERE org_id = ${orgId}::uuid AND handle IN (${handles})`),
  )
  for (const r of rows) {
    const entityId = byHandle.get(r.handle)
    if (entityId) out.set(entityId, r.id)
  }
  return out
}

/**
 * Take every search document of a thread out of the index: its messages, its
 * windows, its brief rows and episodes all carry `thread_id`. Best effort: the
 * rows are gone from every read path already, search re-checks each message
 * hit against them, and a rebuild drops whatever is left.
 */
export async function unindexDiscussionThreads(orgId: string, threadIds: string[]): Promise<void> {
  const ids = threadIds.filter((id) => UUID_RE.test(id))
  if (ids.length === 0 || !UUID_RE.test(orgId)) return
  try {
    const { rawDeleteItem, recordLiveIndex } = await import("~/modules/search/live-index-queue")
    await recordLiveIndex(
      ids.map((threadId) =>
        rawDeleteItem(orgId, `contact-discussion:${threadId}:removed`, {
          filter: `org_id = "${orgId}" AND thread_id = "${threadId}"`,
        }),
      ),
    )
  } catch (err) {
    log.warn({ err, orgId, threadIds: ids }, "Could not queue removal of a discussion")
  }
}

/**
 * Delete the discussions of entities that are being deleted, in the caller's
 * transaction when `db` is a privileged handle already open, else in its own
 * privileged transaction (a person deleting a record may not remove the other
 * participants' seats under their own RLS).
 *
 * Nothing of the discussion stays readable: the thread goes with its messages,
 * seats and references. An approval asked in it keeps its row (an approval
 * request names the thread it was asked in and cannot let go of it), so a
 * thread an approval points at stays as an empty shell: no message, no
 * participant, no reference to the entity. Returns the threads removed or
 * emptied.
 */
export async function deleteEntityDiscussions(
  params: { orgId: string; app: string; entityType: string; entityIds: string[] },
  db?: PrivilegedDb,
): Promise<string[]> {
  const kind = { app: params.app, entityType: params.entityType }
  const run = async (h: Handle): Promise<string[]> => {
    const threads = [
      ...(await entityDiscussionThreads(h, params.orgId, kind, params.entityIds)).values(),
    ]
    if (threads.length === 0) return []
    const list = drizzleSql.join(
      threads.map((id) => drizzleSql`${id}::uuid`),
      drizzleSql`, `,
    )
    await h.execute(drizzleSql`
      DELETE FROM ${ks}.threads th
       WHERE th.org_id = ${params.orgId}::uuid AND th.id IN (${list})
         AND NOT EXISTS (
           SELECT 1 FROM ${ks}.approval_requests ar
            WHERE ar.thread_id = th.id OR ar.originating_thread_id = th.id)`)
    // What an approval still holds: emptied, nobody seated, linked to nothing.
    for (const table of [
      "messages",
      "thread_participants",
      "user_thread_state",
      "thread_references",
    ]) {
      await h.execute(drizzleSql`
        DELETE FROM ${ks}.${drizzleSql.raw(quoteIdent(table))}
         WHERE org_id = ${params.orgId}::uuid AND thread_id IN (${list})`)
    }
    return threads
  }
  const removed = db
    ? await run(db)
    : await withPrivilegedDb(params.orgId, "entity-discussion-delete", run)
  await unindexDiscussionThreads(params.orgId, removed)
  return removed
}
