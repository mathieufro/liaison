// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A contact's discussion: one thread per contact, created the first time
 * someone opens it, where teammates and agents write about the person.
 *
 * It is the contact's primary thread (modules/threads/contact-primary.ts), the
 * same thread apps already post their system messages to. Like a task's
 * thread, its access is derived from the entity: kernel threads are
 * participant-gated by RLS, and the only way in is to prove, under the
 * caller's own RLS, that the contact is visible to them. Opening it then
 * enrols them. Who sees the contact (its owner, its sharing, the
 * organisation) therefore decides who reads and writes its discussion, and a
 * private contact's discussion stays private.
 *
 * When a contact's sharing changes, the people enrolled so far are dropped
 * from it (pruneContactDiscussion): whoever can still see the contact is
 * enrolled again the next time they open it, and whoever no longer can never
 * is. Agent seats are kept: an agent reads only what its person may.
 */
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows, type PrivilegedDb } from "~/db"
import { contacts } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import { getOrCreateContactPrimaryThread } from "~/modules/threads/contact-primary"
import {
  deleteEntityDiscussions,
  entityDiscussionThreads,
  pruneEntityDiscussion,
  unindexDiscussionThreads,
} from "~/modules/threads/entity-discussion"

const ks = drizzleSql.raw(`"${schemaRef("kernel")}"`)

function discussionHandle(contactId: string): string {
  return `contact-primary:${contactId}`
}

/** True when the caller's RLS shows them the contact. */
async function contactVisible(tx: RlsClient, orgId: string, contactId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.orgId, orgId)))
    .limit(1)
  return !!row
}

/**
 * Open a contact's discussion for `userId`: the thread id, created on first
 * use, with the caller enrolled. Null when the contact does not exist or the
 * caller may not see it (nothing is created then).
 */
export async function openContactDiscussion(
  tx: RlsClient,
  params: { orgId: string; contactId: string; userId: string },
): Promise<{ threadId: string; created: boolean } | null> {
  if (!(await contactVisible(tx, params.orgId, params.contactId))) return null
  const { id, created } = await getOrCreateContactPrimaryThread(
    params.orgId,
    params.contactId,
    params.userId,
  )
  return { threadId: id, created }
}

/**
 * Drop the people enrolled in a contact's discussion, but `keepUserId` (the
 * person who changed the sharing), after its sharing changed. Each one who can
 * still see the contact is enrolled again when they next open it. `db` is a
 * privileged handle already open (a kernel maintenance transaction); without
 * one the deletion runs in its own privileged, org-scoped transaction, since a
 * person's RLS may not remove someone else's seat.
 */
export async function pruneContactDiscussion(
  params: { orgId: string; contactId: string; keepUserId: string | null },
  db?: PrivilegedDb | RlsClient,
): Promise<void> {
  await pruneEntityDiscussion(
    {
      orgId: params.orgId,
      ref: { app: "kernel", entityType: "contact", entityId: params.contactId },
      keepUserId: params.keepUserId,
    },
    db,
  )
}

type Handle = PrivilegedDb | RlsClient

const CONTACT = { app: "kernel", entityType: "contact" } as const

/** The discussion thread of each contact that has one, by contact id. */
function discussionThreads(
  h: Handle,
  orgId: string,
  contactIds: string[],
): Promise<Map<string, string>> {
  return entityDiscussionThreads(h, orgId, CONTACT, contactIds)
}

/**
 * Delete the discussions of contacts that are being deleted, in the same
 * transaction as the contacts when `db` is a privileged handle already open
 * (erasure, a kernel merge), else in its own privileged transaction (a person
 * deleting a contact may not remove the other participants' seats under their
 * own RLS).
 *
 * A contact has no bin: deleting one is final, unlike a task, whose delete is a
 * soft delete that leaves its thread for a restore. So nothing of the
 * discussion stays readable: the thread goes with its messages, seats and
 * references. An approval asked in it keeps its row (an approval request names
 * the thread it was asked in and cannot let go of it), so a thread an approval
 * points at stays as an empty shell: no message, no participant, no reference
 * to the contact, as a mailbox reset leaves the mail threads approvals hold.
 */
export async function deleteContactDiscussions(
  params: { orgId: string; contactIds: string[] },
  db?: PrivilegedDb,
): Promise<void> {
  await deleteEntityDiscussions(
    {
      orgId: params.orgId,
      app: CONTACT.app,
      entityType: CONTACT.entityType,
      entityIds: params.contactIds,
    },
    db,
  )
}

/**
 * A merge folds `sourceId` into `targetId`: the source's discussion joins the
 * survivor's, so nothing written about the person is lost. Runs in the merge
 * transaction, elevated (the merge has already proved, under the caller's
 * RLS, that they may delete the source and edit the target).
 *
 *   - Only the source has a discussion: it becomes the survivor's (its handle
 *     and contact link move), with its messages in place.
 *   - Both have one: the source's messages move into the survivor's with their
 *     ids, authors and dates, so the thread shows them in the order they were
 *     written, interleaved with the survivor's own. Their reply followers,
 *     agent seats and the approvals and scope requests asked in the thread
 *     follow them; then the source's thread is deleted.
 *
 * Either way the people seated in the source's discussion are not carried:
 * the survivor's sharing decides who reads its discussion, and whoever sees
 * the survivor is enrolled again by opening it, as after a sharing change.
 * Agent seats move (an agent reads only what its person may). Other threads
 * that referenced the source contact now reference the survivor.
 *
 * Returns true when messages changed thread: their search documents name the
 * thread, so the merge event re-indexes the survivor's discussion after
 * commit (search/message-indexer.ts).
 */
export async function mergeContactDiscussion(
  h: Handle,
  params: { orgId: string; sourceId: string; targetId: string; userId: string | null },
): Promise<boolean> {
  const { orgId, sourceId, targetId } = params
  const found = await discussionThreads(h, orgId, [sourceId, targetId])
  const source = found.get(sourceId)
  const target = found.get(targetId)

  // References from any thread to the source contact follow it to the survivor.
  await h.execute(drizzleSql`
    UPDATE ${ks}.thread_references r SET entity_id = ${targetId}
     WHERE r.org_id = ${orgId}::uuid AND r.app = 'kernel' AND r.entity_type = 'contact'
       AND r.entity_id = ${sourceId}
       AND NOT EXISTS (
         SELECT 1 FROM ${ks}.thread_references t
          WHERE t.thread_id = r.thread_id AND t.app = 'kernel' AND t.entity_type = 'contact'
            AND t.entity_id = ${targetId})`)
  await h.execute(drizzleSql`
    DELETE FROM ${ks}.thread_references
     WHERE org_id = ${orgId}::uuid AND app = 'kernel' AND entity_type = 'contact'
       AND entity_id = ${sourceId}`)

  if (!source) return false
  const dropPeople = (threadId: string) =>
    h.execute(drizzleSql`
      DELETE FROM ${ks}.thread_participants
       WHERE org_id = ${orgId}::uuid AND thread_id = ${threadId}::uuid AND user_id IS NOT NULL
         AND (${params.userId}::uuid IS NULL OR user_id <> ${params.userId}::uuid)`)

  if (!target) {
    await h.execute(drizzleSql`
      UPDATE ${ks}.threads
         SET handle = ${discussionHandle(targetId)},
             created_from = jsonb_set(COALESCE(created_from, '{}'::jsonb), '{entityId}', to_jsonb(${targetId}::text))
       WHERE org_id = ${orgId}::uuid AND id = ${source}::uuid`)
    await h.execute(drizzleSql`
      INSERT INTO ${ks}.thread_references (thread_id, org_id, app, entity_type, entity_id, added_by)
      SELECT ${source}::uuid, ${orgId}::uuid, 'kernel', 'contact', ${targetId}, th.created_by
        FROM ${ks}.threads th WHERE th.id = ${source}::uuid
      ON CONFLICT DO NOTHING`)
    await dropPeople(source)
    return false
  }

  // Reply followers name their root together with its thread, so they are set
  // aside while the messages move and put back under the survivor's thread.
  const followers = extractRows<{
    root_message_id: string
    user_id: string
    last_read_at: string | null
    created_at: string
  }>(
    await h.execute(drizzleSql`
      DELETE FROM ${ks}.reply_thread_followers
       WHERE org_id = ${orgId}::uuid AND thread_id = ${source}::uuid
      RETURNING root_message_id::text AS root_message_id, user_id::text AS user_id,
                last_read_at::text AS last_read_at, created_at::text AS created_at`),
  )
  // Agent seats first: an agent's messages stay in a thread it sits in.
  await h.execute(drizzleSql`
    INSERT INTO ${ks}.thread_participants (thread_id, org_id, role, participant_type, agent_id, seat_origin)
    SELECT ${target}::uuid, org_id, role, participant_type, agent_id, seat_origin
      FROM ${ks}.thread_participants
     WHERE org_id = ${orgId}::uuid AND thread_id = ${source}::uuid AND agent_id IS NOT NULL
    ON CONFLICT DO NOTHING`)
  // One statement, so a reply and its root move together. An import key the
  // survivor's thread already holds is dropped from the moved copy (it only
  // keeps a rerun from copying twice, and both copies are now here).
  await h.execute(drizzleSql`
    UPDATE ${ks}.messages m
       SET thread_id = ${target}::uuid,
           external_ref = CASE WHEN m.external_ref IS NOT NULL AND EXISTS (
               SELECT 1 FROM ${ks}.messages t
                WHERE t.org_id = m.org_id AND t.thread_id = ${target}::uuid
                  AND t.external_ref = m.external_ref)
             THEN NULL ELSE m.external_ref END
     WHERE m.org_id = ${orgId}::uuid AND m.thread_id = ${source}::uuid`)
  for (const f of followers) {
    await h.execute(drizzleSql`
      INSERT INTO ${ks}.reply_thread_followers (root_message_id, thread_id, user_id, org_id, last_read_at, created_at)
      VALUES (${f.root_message_id}::uuid, ${target}::uuid, ${f.user_id}::uuid, ${orgId}::uuid,
              ${f.last_read_at}::timestamptz, ${f.created_at}::timestamptz)
      ON CONFLICT DO NOTHING`)
  }
  for (const column of ["thread_id", "originating_thread_id"]) {
    await h.execute(drizzleSql`
      UPDATE ${ks}.approval_requests SET ${drizzleSql.raw(quoteIdent(column))} = ${target}::uuid
       WHERE org_id = ${orgId}::uuid AND ${drizzleSql.raw(quoteIdent(column))} = ${source}::uuid`)
  }
  await h.execute(drizzleSql`
    UPDATE ${ks}.scope_requests SET originating_thread_id = ${target}::uuid
     WHERE org_id = ${orgId}::uuid AND originating_thread_id = ${source}::uuid`)
  await h.execute(drizzleSql`
    DELETE FROM ${ks}.threads WHERE org_id = ${orgId}::uuid AND id = ${source}::uuid`)
  // The moved messages' old documents name the source thread; the survivor's
  // are rebuilt from the committed rows by the merge event.
  await unindexDiscussionThreads(orgId, [source])
  return true
}
