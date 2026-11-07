// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 B1 — get-or-create a contact's "primary" kernel thread.
//
// It is the contact's DISCUSSION (modules/contacts/discussion.ts): the thread
// the contact page draws beside the contact, where teammates and agents write
// about the person, and where apps post their system messages. Like a task's
// thread it lives within its entity (`hidden_from_list`), and reaching it is
// derived from seeing the contact: callers prove that under their own RLS
// before calling here.
//
// The bundled invoicing app (and any future app that wants to post a system
// message into the conversation Liaison already maintains for a contact) needs
// a stable thread it can find by `(orgId, contactId)` and write to. We do not
// add a new `contact_id` column on `kernel.threads`; instead the contact link
// lives in `kernel.thread_references` (`app=kernel, entity_type=contact,
// entity_id=<contactId>`) — the existing kernel surface for entity↔thread
// links — and the thread itself uses `type='thread'` with a deterministic
// handle (`contact-primary:<contactId>`) so creation races are caught by the
// existing `(org_id, handle)` unique index.

import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

export interface ContactPrimaryThread {
  id: string
  /** True when this call created the thread. */
  created: boolean
}

/**
 * Returns the existing `contact_primary` thread for `(orgId, contactId)`, or
 * creates a new one. In both cases `callerUserId` is ensured to be a thread
 * participant before returning, so the caller's RLS context can see and post to
 * the thread.
 *
 * Idempotent. The deterministic `handle` ("contact-primary:<contactId>") makes a
 * concurrent second call collide on the `(org_id, handle)` unique index; we
 * catch that and re-read.
 *
 * All work runs under `withPrivilegedDb` (BYPASSRLS). This is load-bearing:
 * `threads_select` only exposes a thread to users who already have a
 * `thread_participants` row. Under a plain RLS client, a *non-creator* caller's
 * fast-path read sees nothing (no participant row yet), races into the
 * slow-path INSERT, collides on the unique handle, and then the catch re-reads
 * — still RLS-filtered to empty — and rethrows the raw unique violation as a
 * 500. Running privileged lets us find-or-create the shared thread regardless
 * of caller participation and then upsert the caller as a participant
 * (`ON CONFLICT DO NOTHING`) so every subsequent RLS-scoped operation succeeds.
 * Inserts use raw SQL (schema-prefix aware via `schemaRef`) — the same
 * convention `listThreads` already uses.
 */
export async function getOrCreateContactPrimaryThread(
  orgId: string,
  contactId: string,
  callerUserId: string,
): Promise<ContactPrimaryThread> {
  return withPrivilegedDb(orgId, "contact-primary-thread", async (tx) => {
    const { id, created } = await findOrCreateThread(tx, orgId, contactId, callerUserId)
    // Ensure the calling author is a participant. The thread creator joins as
    // `admin` (matching the normal thread-creation path); a later caller posting
    // to a thread someone else created joins as `member`. Without this row their
    // subsequent RLS-scoped reads/writes 500 ("not visible under threads_select").
    await ensureParticipant(tx, id, orgId, callerUserId, created ? "admin" : "member")
    return { id, created }
  })
}

const ks = sql.raw(`"${schemaRef("kernel")}"`)

async function findOrCreateThread(
  tx: PrivilegedDb,
  orgId: string,
  contactId: string,
  creatorUserId: string,
): Promise<{ id: string; created: boolean }> {
  const handle = `contact-primary:${contactId}`

  const existing = extractRows<{ id: string }>(
    await tx.execute(
      sql`SELECT id FROM ${ks}.threads WHERE org_id = ${orgId}::uuid AND handle = ${handle} LIMIT 1`,
    ),
  )
  if (existing[0]) return { id: existing[0].id, created: false }

  try {
    const threadId = randomUUID()
    const createdFrom = JSON.stringify({
      app: "kernel",
      entityType: "contact",
      entityId: contactId,
    })
    await tx.execute(
      sql`INSERT INTO ${ks}.threads (id, org_id, handle, title, type, hidden_from_list, created_by, created_from)
          VALUES (${threadId}::uuid, ${orgId}::uuid, ${handle}, NULL, 'thread', true, ${creatorUserId}::uuid, ${createdFrom}::jsonb)`,
    )
    await tx.execute(
      sql`INSERT INTO ${ks}.thread_references (thread_id, org_id, app, entity_type, entity_id, added_by)
          VALUES (${threadId}::uuid, ${orgId}::uuid, 'kernel', 'contact', ${contactId}, ${creatorUserId}::uuid)
          ON CONFLICT DO NOTHING`,
    )
    return { id: threadId, created: true }
  } catch (e: unknown) {
    // Unique violation on (org_id, handle) → another caller won the race. Re-read.
    const after = extractRows<{ id: string }>(
      await tx.execute(
        sql`SELECT id FROM ${ks}.threads WHERE org_id = ${orgId}::uuid AND handle = ${handle} LIMIT 1`,
      ),
    )
    if (after[0]) return { id: after[0].id, created: false }
    throw e
  }
}

async function ensureParticipant(
  tx: PrivilegedDb,
  threadId: string,
  orgId: string,
  userId: string,
  role: "admin" | "member",
): Promise<void> {
  await tx.execute(
    sql`INSERT INTO ${ks}.thread_participants (thread_id, user_id, org_id, role)
        VALUES (${threadId}::uuid, ${userId}::uuid, ${orgId}::uuid, ${role})
        ON CONFLICT DO NOTHING`,
  )
}
