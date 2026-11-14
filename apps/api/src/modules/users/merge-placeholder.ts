// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Link an import placeholder to the real person it stands for.
//
// A history import (Slack) authors every message whose sender has no account
// in the org with a deactivated placeholder user (`slack-import+…@import.invalid`,
// @liaison/shared import-placeholder). When that person joins, or already had
// an account under another address, their history stays authored by the
// placeholder: search by person, "my messages" and mentions miss it, and the
// pickers show two of them (design audit 2026-09-30, finding 7). This moves
// everything the placeholder holds onto the real user, then removes the
// placeholder.
//
// Rules, all enforced here whatever the caller:
// - The SOURCE must be an import placeholder and the TARGET must be a real,
//   ACTIVE user (not a placeholder, not deactivated, not an erasure
//   tombstone), both in the caller's org. Two real accounts are
//   never merged, and an id from another org reads as "not found".
// - One transaction, both user rows locked: it either all happens or nothing
//   does. Anything that still references the placeholder at the end and is not
//   covered below (an approval it decided, a project it owns...) makes the
//   final DELETE fail its foreign key, so the merge refuses instead of losing a
//   row. A reference that needs its own decision (an automation, an agent, a
//   connected account, mailbox keys) refuses the merge before anything moves.
// - Idempotent: a placeholder that is already gone is reported as already
//   merged (from the audit record) rather than merged twice.
// - Audited: a durable `kernel:user:merge` event with the counts, which the
//   audit consumer records like every identity change.
// - Dry run: the same plan, counted with reads only and without row locks,
//   for the preview.
//
// Coverage. Every foreign key to kernel.users has a disposition in
// merge-references.ts (repoint, drop, cascade or refuse); the FKs are read
// from the catalog at run time, a column missing from the list refuses the
// merge, and a test fails when the list and the catalog disagree. On top of
// the FKs, the columns that hold a user id WITHOUT a foreign key are moved
// here by name: messages authored, the mention markup `@[Name](user:<id>)` in
// content and the `mentions` jsonb, threads created, per-user thread state
// (read marks, mute, pin, archive) and the actor of attention rows. Wherever a
// unique index covers a re-pointed column, the real user's own row wins and
// the placeholder's duplicate is dropped (a reaction with the same emoji, a
// participation, a read mark, a follow...).
//
// Search: the moved and re-pointed messages are re-indexed after commit through
// the search module's own bulk indexer (`indexMessagesBulk`), best effort: the
// merge is committed whatever the index does, and a failure is logged.
import { isImportPlaceholderEmail } from "@liaison/shared"
import { type SQL, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { mergeContactsAsKernel } from "~/modules/contacts/service"
import { moveUserSharing } from "~/modules/sharing/service"
import { type ReferenceDisposition, USER_FK_DISPOSITION } from "./merge-references"

const log = rootLogger.child({ module: "merge-placeholder" })

export type MergeErrorCode =
  | "PLACEHOLDER_NOT_FOUND"
  | "TARGET_NOT_FOUND"
  | "NOT_A_PLACEHOLDER"
  | "TARGET_IS_PLACEHOLDER"
  | "SAME_USER"
  | "TARGET_NOT_ACTIVE"
  | "BLOCKED_BY_REFERENCE"

export class MergeUserError extends Error {
  constructor(
    readonly code: MergeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "MergeUserError"
  }
}

export interface MergeCounts {
  messagesAuthored: number
  messagesMentioning: number
  reactionsMoved: number
  reactionsDropped: number
  filesMoved: number
  threadsCreated: number
  participationsMoved: number
  participationsDropped: number
  threadStatesMoved: number
  threadStatesDropped: number
  followsMoved: number
  followsDropped: number
  attentionDropped: number
  attentionActorMoved: number
  /** Private contacts of the placeholder merged into the person's own
   *  contact for the same address (fields, ids and links kept, not dropped). */
  contactsMerged: number
  /** Every foreign-key reference that moved or was dropped, by `<schema>.<table>.<column>`. */
  references: Record<string, { moved: number; dropped: number }>
}

interface MergeUserRef {
  id: string
  name: string
  email: string
}

export interface MergeResult {
  dryRun: boolean
  /** True when the placeholder was merged into this target earlier (nothing done now). */
  alreadyMerged: boolean
  placeholder: MergeUserRef
  target: MergeUserRef
  counts: MergeCounts
}

export interface MergeParams {
  orgId: string
  actorId: string
  placeholderId: string
  targetId: string
  dryRun?: boolean
}

export interface MergeDeps {
  /** Re-index messages after commit. Defaults to the search module's bulk indexer. */
  indexMessages?: (orgId: string, messageIds: string[]) => Promise<unknown>
}

const EMPTY_COUNTS: MergeCounts = {
  messagesAuthored: 0,
  messagesMentioning: 0,
  reactionsMoved: 0,
  reactionsDropped: 0,
  filesMoved: 0,
  threadsCreated: 0,
  participationsMoved: 0,
  participationsDropped: 0,
  threadStatesMoved: 0,
  threadStatesDropped: 0,
  followsMoved: 0,
  followsDropped: 0,
  attentionDropped: 0,
  attentionActorMoved: 0,
  contactsMerged: 0,
  references: {},
}

const K = () => sql.raw(schemaRef("kernel"))

async function count(tx: PrivilegedDb, query: SQL): Promise<number> {
  const [row] = extractRows<{ n: number }>(
    await tx.execute(sql`SELECT count(*)::int AS n FROM (${query}) q`),
  )
  return Number(row?.n ?? 0)
}

/** Run a data-modifying statement and return how many rows it touched. */
async function touched(tx: PrivilegedDb, statement: SQL): Promise<number> {
  const [row] = extractRows<{ n: number }>(
    await tx.execute(sql`WITH w AS (${statement} RETURNING 1) SELECT count(*)::int AS n FROM w`),
  )
  return Number(row?.n ?? 0)
}

/** The mention token the composer (and the importer) write for a user. */
const mentionToken = (userId: string) => `(user:${userId})`

/** Both users, row-locked for a merge; a dry run (the preview) takes no lock. */
async function loadUsers(
  tx: PrivilegedDb,
  orgId: string,
  placeholderId: string,
  targetId: string,
  lock: boolean,
): Promise<{ placeholder?: MergeUserRow; target?: MergeUserRow }> {
  const rows = extractRows<MergeUserRow>(
    await tx.execute(sql`
      SELECT id, name, email, status FROM ${K()}.users
       WHERE org_id = ${orgId} AND id IN (${placeholderId}, ${targetId})
       ORDER BY id
       ${lock ? sql`FOR UPDATE` : sql``}`),
  )
  return {
    placeholder: rows.find((r) => r.id === placeholderId),
    target: rows.find((r) => r.id === targetId),
  }
}

interface MergeUserRow extends MergeUserRef {
  status: string
}

const toRef = (r: MergeUserRow): MergeUserRef => ({ id: r.id, name: r.name, email: r.email })

/** An erasure tombstone or the per-org "deleted user" sentinel (modules/erasure). */
const isErasedUserEmail = (email: string) => email.startsWith("deleted-user-")

/** A merge the audit log already recorded for this placeholder, if any. */
async function priorMerge(
  tx: PrivilegedDb,
  orgId: string,
  placeholderId: string,
): Promise<{ targetId: string; placeholder: MergeUserRef } | null> {
  const [row] = extractRows<{ changes: Record<string, unknown> | null }>(
    await tx.execute(sql`
      SELECT changes FROM ${K()}.audit_log
       WHERE org_id = ${orgId} AND app = 'kernel' AND entity_type = 'user'
         AND entity_id = ${placeholderId} AND action = 'user.merge'
       ORDER BY "timestamp" DESC LIMIT 1`),
  )
  const c = row?.changes
  if (!c || typeof c.targetUserId !== "string") return null
  return {
    targetId: c.targetUserId,
    placeholder: {
      id: placeholderId,
      name: typeof c.placeholderName === "string" ? c.placeholderName : "",
      email: typeof c.placeholderEmail === "string" ? c.placeholderEmail : "",
    },
  }
}

// ── Foreign keys: read from the catalog, handled per merge-references.ts ────

interface UserReference {
  /** `<schema>.<table>.<column>`, unprefixed schema (the disposition key). */
  key: string
  table: SQL
  column: string
  disposition: ReferenceDisposition
  /** For each unique index covering the column: its other columns, its
   *  partial-index predicate (a twin must satisfy it too) and whether NULLs
   *  are distinct (the default: two NULLs never collide). */
  uniqueWith: Array<{ others: string[]; predicate: string | null; nullsDistinct: boolean }>
}

/** The schema prefix test workers run under (`w<id>_kernel`), empty in production. */
function schemaPrefix(): string {
  const kernel = schemaRef("kernel")
  return kernel.slice(0, kernel.length - "kernel".length)
}

/** Every FK column to kernel.users, with its disposition and unique indexes. */
async function userReferences(tx: PrivilegedDb): Promise<UserReference[]> {
  const prefix = schemaPrefix()
  const rows = extractRows<{
    nsp: string
    rel: string
    col: string
    uniques: Array<{
      cols: string[]
      expr: boolean
      pred: string | null
      nullsDistinct: boolean
    }> | null
  }>(
    await tx.execute(sql`
      SELECT n.nspname AS nsp, t.relname AS rel, a.attname AS col,
             (SELECT json_agg(json_build_object(
                       'cols', (SELECT array_agg(ia.attname ORDER BY k.ord)
                                  FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
                                  JOIN pg_attribute ia ON ia.attrelid = i.indrelid AND ia.attnum = k.attnum),
                       'expr', 0 = ANY(i.indkey) OR i.indexprs IS NOT NULL,
                       'pred', pg_get_expr(i.indpred, i.indrelid),
                       'nullsDistinct', NOT i.indnullsnotdistinct))
                FROM pg_index i
               WHERE i.indrelid = c.conrelid AND i.indisunique AND a.attnum = ANY(i.indkey)
             ) AS uniques
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
       WHERE c.contype = 'f'
         AND c.confrelid = ${`${schemaRef("kernel")}.users`}::regclass
       ORDER BY 1, 2, 3`),
  )
  return rows.map((r) => {
    const schema = r.nsp.startsWith(prefix) ? r.nsp.slice(prefix.length) : r.nsp
    const key = `${schema}.${r.rel}.${r.col}`
    const disposition = USER_FK_DISPOSITION[key] ?? {
      kind: "refuse" as const,
      reason: "a reference this merge does not know yet (merge-references.ts)",
    }
    if ((r.uniques ?? []).some((u) => u.expr) && disposition.kind === "repoint") {
      throw new MergeUserError(
        "BLOCKED_BY_REFERENCE",
        `${key} has an expression unique index a merge cannot reason about. Nothing was changed.`,
      )
    }
    return {
      key,
      table: sql.raw(`${quoteIdent(r.nsp)}.${quoteIdent(r.rel)}`),
      column: r.col,
      disposition,
      uniqueWith: (r.uniques ?? []).map((u) => ({
        others: u.cols.filter((c) => c !== r.col),
        predicate: u.pred,
        nullsDistinct: u.nullsDistinct,
      })),
    }
  })
}

/** SQL: a placeholder row of `ref` the real user already holds (a unique-index twin). */
function conflictPredicate(ref: UserReference, real: string): SQL {
  const col = sql.raw(quoteIdent(ref.column))
  // A twin is a row the unique index would actually collide with: same values
  // (NULLs never collide unless the index says NULLS NOT DISTINCT), and, for a
  // partial index, both rows inside its predicate.
  const twins = ref.uniqueWith.map(({ others, predicate, nullsDistinct }) => {
    const same = others.map((o) => {
      const c = sql.raw(quoteIdent(o))
      return nullsDistinct
        ? sql` AND y.${c} = x.${c}`
        : sql` AND y.${c} IS NOT DISTINCT FROM x.${c}`
    })
    const inIndex = predicate
      ? sql` AND x.ctid IN (SELECT ctid FROM ${ref.table} WHERE ${sql.raw(predicate)})
             AND y.ctid IN (SELECT ctid FROM ${ref.table} WHERE ${sql.raw(predicate)})`
      : sql``
    return sql`EXISTS (SELECT 1 FROM ${ref.table} y WHERE y.${col} = ${real}${sql.join(same, sql``)}${inIndex})`
  })
  return twins.length > 0 ? sql`(${sql.join(twins, sql` OR `)})` : sql`false`
}

interface ReferenceOutcome {
  moved: number
  dropped: number
}

/** Refuse before anything moves when a `refuse` reference holds a row. */
async function assertNoRefusedReferences(
  tx: PrivilegedDb,
  refs: UserReference[],
  ph: string,
): Promise<void> {
  for (const ref of refs) {
    if (ref.disposition.kind !== "refuse") continue
    const col = sql.raw(quoteIdent(ref.column))
    const n = await count(tx, sql`SELECT 1 FROM ${ref.table} WHERE ${col} = ${ph}`)
    if (n > 0) {
      throw new MergeUserError(
        "BLOCKED_BY_REFERENCE",
        `The imported user still holds ${ref.disposition.reason} (${ref.key}), which a merge does not hand to a person. Nothing was changed.`,
      )
    }
  }
}

/**
 * A pending approval whose resource owner is the placeholder: the merge would
 * make the person its owner, and the resource-owner branch lets the owner
 * decide it. That hand-over needs its own decision, so the merge refuses.
 */
async function assertNoPendingOwnedApprovals(tx: PrivilegedDb, orgId: string, ph: string) {
  const n = await count(
    tx,
    sql`SELECT 1 FROM ${K()}.approval_requests
         WHERE org_id = ${orgId} AND resource_owner_id = ${ph}
           AND status IN ('pending', 'approving', 'deferred')`,
  )
  if (n > 0) {
    throw new MergeUserError(
      "BLOCKED_BY_REFERENCE",
      `The imported user owns ${n} pending approval request(s): decide or withdraw them first. Nothing was changed.`,
    )
  }
}

/** What each FK reference would do (dry run) or did. */
async function handleReferences(
  tx: PrivilegedDb,
  refs: UserReference[],
  ph: string,
  real: string,
  write: boolean,
): Promise<Record<string, ReferenceOutcome>> {
  const out: Record<string, ReferenceOutcome> = {}
  for (const ref of refs) {
    const col = sql.raw(quoteIdent(ref.column))
    const mine = sql`x.${col} = ${ph}`
    if (ref.disposition.kind === "repoint") {
      const conflict = conflictPredicate(ref, real)
      const dropped = write
        ? await touched(tx, sql`DELETE FROM ${ref.table} x WHERE ${mine} AND ${conflict}`)
        : await count(tx, sql`SELECT 1 FROM ${ref.table} x WHERE ${mine} AND ${conflict}`)
      const moved = write
        ? await touched(tx, sql`UPDATE ${ref.table} SET ${col} = ${real} WHERE ${col} = ${ph}`)
        : await count(tx, sql`SELECT 1 FROM ${ref.table} x WHERE ${mine} AND NOT ${conflict}`)
      if (moved + dropped > 0) out[ref.key] = { moved, dropped }
    } else if (ref.disposition.kind === "drop") {
      const dropped = write
        ? await touched(tx, sql`DELETE FROM ${ref.table} x WHERE ${mine}`)
        : await count(tx, sql`SELECT 1 FROM ${ref.table} x WHERE ${mine}`)
      if (dropped > 0) out[ref.key] = { moved: 0, dropped }
    }
    // `cascade`: dies with the placeholder row. `refuse`: checked beforehand.
  }
  return out
}

/** The named counts the preview and the approval summary show. */
function namedCounts(refs: Record<string, ReferenceOutcome>, base: MergeCounts): MergeCounts {
  const at = (k: string) => refs[k] ?? { moved: 0, dropped: 0 }
  return {
    ...base,
    reactionsMoved: at("kernel.message_reactions.user_id").moved,
    reactionsDropped: at("kernel.message_reactions.user_id").dropped,
    filesMoved: at("kernel.files.uploaded_by").moved,
    participationsMoved: at("kernel.thread_participants.user_id").moved,
    participationsDropped: at("kernel.thread_participants.user_id").dropped,
    followsMoved: at("kernel.reply_thread_followers.user_id").moved,
    followsDropped: at("kernel.reply_thread_followers.user_id").dropped,
    attentionDropped: at("kernel.attention_events.user_id").dropped,
    references: refs,
  }
}

// ── Columns holding a user id WITHOUT a foreign key: moved by name ───────────

const mentionsContaining = (ph: string) => JSON.stringify([{ type: "user", id: ph }])

/** Counts of what a merge would do, reads only (the dry run and the approval summary). */
async function planCounts(
  tx: PrivilegedDb,
  orgId: string,
  ph: string,
  real: string,
): Promise<MergeCounts> {
  const k = K()
  const refs = await userReferences(tx)
  await assertNoRefusedReferences(tx, refs, ph)
  await assertNoPendingOwnedApprovals(tx, orgId, ph)
  const base: MergeCounts = {
    ...EMPTY_COUNTS,
    messagesAuthored: await count(
      tx,
      sql`SELECT 1 FROM ${k}.messages WHERE org_id = ${orgId} AND author_id = ${ph}`,
    ),
    messagesMentioning: await count(
      tx,
      sql`SELECT 1 FROM ${k}.messages WHERE org_id = ${orgId}
            AND (mentions @> ${mentionsContaining(ph)}::jsonb
                 OR content LIKE ${`%${mentionToken(ph)}%`})`,
    ),
    threadsCreated: await count(
      tx,
      sql`SELECT 1 FROM ${k}.threads WHERE org_id = ${orgId} AND created_by = ${ph}`,
    ),
    threadStatesMoved: await count(
      tx,
      sql`SELECT 1 FROM ${k}.user_thread_state x WHERE x.user_id = ${ph}
            AND NOT EXISTS (SELECT 1 FROM ${k}.user_thread_state y
                             WHERE y.thread_id = x.thread_id AND y.user_id = ${real})`,
    ),
    threadStatesDropped: await count(
      tx,
      sql`SELECT 1 FROM ${k}.user_thread_state x WHERE x.user_id = ${ph}
            AND EXISTS (SELECT 1 FROM ${k}.user_thread_state y
                         WHERE y.thread_id = x.thread_id AND y.user_id = ${real})`,
    ),
    attentionActorMoved: await count(
      tx,
      sql`SELECT 1 FROM ${k}.attention_events WHERE org_id = ${orgId} AND actor_id = ${ph}`,
    ),
  }
  const twins = await contactTwins(tx, orgId, ph, real)
  base.contactsMerged = twins.length
  const counts = namedCounts(await handleReferences(tx, refs, ph, real, false), base)
  // The preview counts those twins as merged, not dropped.
  const owned = counts.references[CONTACT_OWNER_KEY]
  if (owned && twins.length > 0) owned.dropped = Math.max(0, owned.dropped - twins.length)
  return counts
}

const CONTACT_OWNER_KEY = "kernel.contacts.owner_user_id"

/** The placeholder's private contacts the person already has one for (same address). */
async function contactTwins(
  tx: PrivilegedDb,
  orgId: string,
  ph: string,
  real: string,
): Promise<Array<{ source: string; target: string }>> {
  const k = K()
  return extractRows<{ source: string; target: string }>(
    await tx.execute(sql`
      SELECT x.id::text AS source, y.id::text AS target
        FROM ${k}.contacts x
        JOIN ${k}.contacts y
          ON y.org_id = x.org_id AND y.owner_user_id = ${real} AND y.org_access = 'none'
         AND y.audience_key IS NULL AND y.email = x.email
       WHERE x.org_id = ${orgId} AND x.owner_user_id = ${ph} AND x.org_access = 'none'
         AND x.audience_key IS NULL AND x.email IS NOT NULL`),
  )
}

/** Every write of the merge, in dependency order. Returns counts and the messages to re-index. */
async function applyMerge(
  tx: PrivilegedDb,
  orgId: string,
  ph: string,
  real: string,
): Promise<{ counts: MergeCounts; messageIds: string[]; joinedThreadIds: string[] }> {
  const k = K()
  const refs = await userReferences(tx)
  await assertNoRefusedReferences(tx, refs, ph)
  await assertNoPendingOwnedApprovals(tx, orgId, ph)
  const base = { ...EMPTY_COUNTS }

  // Messages to re-index once committed: authored or mentioning, read BEFORE
  // the rewrite (afterwards the placeholder id is gone from them).
  const affected = extractRows<{ id: string }>(
    await tx.execute(sql`
      SELECT id FROM ${k}.messages
       WHERE org_id = ${orgId}
         AND (author_id = ${ph}
              OR mentions @> ${mentionsContaining(ph)}::jsonb
              OR content LIKE ${`%${mentionToken(ph)}%`})`),
  ).map((r) => r.id)
  // Threads the real user joins through the merge (announced after commit).
  const joined = extractRows<{ thread_id: string }>(
    await tx.execute(sql`
      SELECT x.thread_id FROM ${k}.thread_participants x
       WHERE x.user_id = ${ph}
         AND NOT EXISTS (SELECT 1 FROM ${k}.thread_participants y
                          WHERE y.thread_id = x.thread_id AND y.user_id = ${real})`),
  ).map((r) => r.thread_id)

  base.messagesAuthored = await touched(
    tx,
    sql`UPDATE ${k}.messages SET author_id = ${real}
         WHERE org_id = ${orgId} AND author_id = ${ph}`,
  )

  // Mentions: the markup in content and the structured list. The list is
  // rewritten element-wise and de-duplicated (a message that mentioned both
  // the placeholder and the real user keeps one entry, in first position).
  const markupTouched = await touched(
    tx,
    sql`UPDATE ${k}.messages
           SET content = replace(content, ${mentionToken(ph)}, ${mentionToken(real)})
         WHERE org_id = ${orgId} AND content LIKE ${`%${mentionToken(ph)}%`}`,
  )
  const listTouched = await touched(
    tx,
    sql`UPDATE ${k}.messages m
           SET mentions = (
             SELECT coalesce(jsonb_agg(d.elem ORDER BY d.first_ord), '[]'::jsonb)
               FROM (
                 SELECT s.elem, min(s.ord) AS first_ord
                   FROM (
                     SELECT CASE
                              WHEN t.e->>'type' = 'user' AND t.e->>'id' = ${ph}
                                THEN jsonb_set(t.e, '{id}', to_jsonb(${real}::text))
                              ELSE t.e
                            END AS elem,
                            t.ord
                       FROM jsonb_array_elements(m.mentions) WITH ORDINALITY AS t(e, ord)
                   ) s
                  GROUP BY s.elem
               ) d)
         WHERE m.org_id = ${orgId}
           AND m.mentions @> ${mentionsContaining(ph)}::jsonb`,
  )
  base.messagesMentioning = Math.max(markupTouched, listTouched)

  base.threadsCreated = await touched(
    tx,
    sql`UPDATE ${k}.threads SET created_by = ${real} WHERE org_id = ${orgId} AND created_by = ${ph}`,
  )
  // A company's creator decides who may share it (migration 0293). The column
  // is soft, so the foreign key walk never sees it: the person takes it over
  // here, or a private company the placeholder created would be nobody's.
  await tx.execute(
    sql`UPDATE ${k}.companies SET created_by = ${real} WHERE org_id = ${orgId} AND created_by = ${ph}`,
  )
  base.threadStatesDropped = await touched(
    tx,
    sql`DELETE FROM ${k}.user_thread_state x
         WHERE x.user_id = ${ph}
           AND EXISTS (SELECT 1 FROM ${k}.user_thread_state y
                        WHERE y.thread_id = x.thread_id AND y.user_id = ${real})`,
  )
  base.threadStatesMoved = await touched(
    tx,
    sql`UPDATE ${k}.user_thread_state SET user_id = ${real} WHERE user_id = ${ph}`,
  )
  base.attentionActorMoved = await touched(
    tx,
    sql`UPDATE ${k}.attention_events SET actor_id = ${real}
         WHERE org_id = ${orgId} AND actor_id = ${ph}`,
  )

  // A private contact the placeholder and the person both hold for the same
  // address: one contact, merged (fields, external ids, conversations and
  // invoice links kept), never a "duplicate" the generic re-point would drop.
  const twins = await contactTwins(tx, orgId, ph, real)
  for (const twin of twins) {
    await mergeContactsAsKernel(tx, {
      orgId,
      userId: real,
      sourceId: twin.source,
      targetId: twin.target,
    })
  }
  base.contactsMerged = twins.length

  // Every FK reference, per its disposition.
  const counts = namedCounts(await handleReferences(tx, refs, ph, real, true), base)
  // Sharing names users in grants and in the search ACL, with no FK: the
  // placeholder's shares and its place on shared resources' ACLs move too.
  await moveUserSharing(tx, orgId, ph, real)

  // The placeholder goes; `cascade` references go with it. Anything still
  // pointing at it (a reference added between the catalog read and now) fails
  // its foreign key here and rolls the whole merge back.
  try {
    await tx.execute(sql`DELETE FROM ${k}.users WHERE id = ${ph} AND org_id = ${orgId}`)
  } catch (err) {
    const pg = err as {
      code?: string
      constraint_name?: string
      cause?: { code?: string; constraint_name?: string }
    }
    if ((pg.code ?? pg.cause?.code) === "23503") {
      const constraint = pg.constraint_name ?? pg.cause?.constraint_name ?? "a foreign key"
      throw new MergeUserError(
        "BLOCKED_BY_REFERENCE",
        `The placeholder is still referenced (${constraint}), which a merge does not move. Nothing was changed.`,
      )
    }
    throw err
  }

  return { counts, messageIds: affected, joinedThreadIds: joined }
}

/**
 * Merge (or, with `dryRun`, preview merging) an import placeholder into a real
 * user of the same org. Throws {@link MergeUserError} on a refused merge.
 */
export async function mergePlaceholderIntoUser(
  params: MergeParams,
  deps: MergeDeps = {},
): Promise<MergeResult> {
  const { orgId, actorId, placeholderId, targetId, dryRun = false } = params
  if (placeholderId === targetId) {
    throw new MergeUserError("SAME_USER", "A user cannot be merged into itself.")
  }

  const outcome = await withPrivilegedDb(orgId, "admin-merge-placeholder", async (tx) => {
    const loaded = await loadUsers(tx, orgId, placeholderId, targetId, !dryRun)
    const placeholder = loaded.placeholder && toRef(loaded.placeholder)
    if (!loaded.target) {
      throw new MergeUserError("TARGET_NOT_FOUND", "The user to merge into was not found.")
    }
    const target = toRef(loaded.target)
    if (isImportPlaceholderEmail(target.email)) {
      throw new MergeUserError(
        "TARGET_IS_PLACEHOLDER",
        "The user to merge into is itself an import placeholder: pick the real person's account.",
      )
    }
    // Only a live person receives history: never a deactivated account, an
    // erasure tombstone or the org's "deleted user" sentinel.
    if (loaded.target.status !== "active" || isErasedUserEmail(target.email)) {
      throw new MergeUserError(
        "TARGET_NOT_ACTIVE",
        "The user to merge into is not an active member: reactivate or invite the person first.",
      )
    }
    if (!placeholder) {
      const prior = await priorMerge(tx, orgId, placeholderId)
      if (prior && prior.targetId === targetId) {
        return { alreadyMerged: true as const, placeholder: prior.placeholder, target }
      }
      throw new MergeUserError("PLACEHOLDER_NOT_FOUND", "The imported user was not found.")
    }
    if (!isImportPlaceholderEmail(placeholder.email)) {
      throw new MergeUserError(
        "NOT_A_PLACEHOLDER",
        "Only an import placeholder can be merged into a person; two real accounts are never merged.",
      )
    }

    if (dryRun) {
      const counts = await planCounts(tx, orgId, placeholderId, targetId)
      return { alreadyMerged: false as const, placeholder, target, counts, messageIds: [] }
    }

    const { counts, messageIds, joinedThreadIds } = await applyMerge(
      tx,
      orgId,
      placeholderId,
      targetId,
    )
    // The real user joined the placeholder's threads: their open sessions and
    // the thread search documents learn it the way any join is announced.
    for (const threadId of joinedThreadIds) {
      await tx.queueEvent({
        app: "kernel",
        entity: "participant",
        action: "add",
        entityId: threadId,
        orgId,
        actorId,
        data: { threadId, userId: targetId, userName: target.name, via: "merge" },
      })
    }
    await tx.queueEvent({
      app: "kernel",
      entity: "user",
      action: "merge",
      orgId,
      actorId,
      entityId: placeholderId,
      data: {
        targetUserId: targetId,
        placeholderName: placeholder.name,
        placeholderEmail: placeholder.email,
        counts,
      },
    })
    return { alreadyMerged: false as const, placeholder, target, counts, messageIds }
  })

  if (outcome.alreadyMerged) {
    return {
      dryRun,
      alreadyMerged: true,
      placeholder: outcome.placeholder,
      target: outcome.target,
      counts: { ...EMPTY_COUNTS },
    }
  }

  if (!dryRun) {
    invalidateAuthCache(placeholderId)
    if (outcome.messageIds.length > 0) {
      const index =
        deps.indexMessages ??
        (async (o: string, ids: string[]) => {
          const { indexMessagesBulk } = await import("~/modules/search/message-indexer")
          return indexMessagesBulk(o, ids)
        })
      try {
        await index(orgId, outcome.messageIds)
      } catch (err) {
        log.warn(
          { err, orgId, placeholderId, messages: outcome.messageIds.length },
          "merge committed; re-indexing its messages failed (the next reindex heals it)",
        )
      }
    }
  }

  return {
    dryRun,
    alreadyMerged: false,
    placeholder: outcome.placeholder,
    target: outcome.target,
    counts: outcome.counts,
  }
}
