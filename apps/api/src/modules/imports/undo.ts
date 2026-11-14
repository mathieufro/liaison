// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Undo an import run (A14): delete the rows the run created, as recorded in
 * its ledger, and refuse whatever changed since.
 *
 * - Only the person who started the run or an org admin, holding the kinds'
 *   write scopes (read live), may undo, and only a final run (done, failed,
 *   cancelled). The claim is one conditional UPDATE, and undo holds the
 *   per-(org, kind) import locks, so it never races a run of the same kinds.
 * - Every ledgered row must belong to the run's org: its table must have an
 *   `org_id` (else the row is refused) and every read and DELETE filters on
 *   the run's org. A bundled kind's row created before the run started is
 *   refused: a bundle's ledger can only ever name rows the run itself wrote.
 * - A record's rows (one `record_key`) are kept or deleted together, in one
 *   savepoint. A record is KEPT, and listed, when one of its rows changed after
 *   it was recorded (`updated_at > recorded_at`; a roll-up the run itself made
 *   moved `recorded_at`, runner.ts refreshTouched) or has a child row the run did
 *   not create: a row of any table holding a CASCADE or SET NULL foreign key to
 *   it (read from pg_constraint) or a file attached to it, other than derived
 *   state (read marks, participants). Deleting the parent would take that work
 *   with it.
 * - Shared rows (an ensured project or status, a placeholder user, a contact,
 *   a knowledge tag)
 *   go after the records, each on its own: kept when still referenced. People
 *   (users, contacts) are deleted only when no other run's ledger names them
 *   and no row references them through any foreign key or the known non-key
 *   person columns (R6): their FKs are often ON DELETE SET NULL / CASCADE, so a
 *   delete would not fail, it would silently rewrite someone else's rows. An
 *   edited person is kept like an edited record.
 * - Storage objects of deleted files are removed after the commit, and the
 *   deleted rows' search documents are queued for removal.
 */
import { and, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type ImportRunStatus, importRuns } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { deleteObjects } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { assertRunAuthority } from "~/modules/imports/authority"
import { IMPORT_COVERAGE } from "~/modules/imports/coverage-registry"
import { ownAppSchema } from "~/modules/imports/kind-schema"
import { lookupImportKind } from "~/modules/imports/kinds"
import { isLedgerTableName, type LedgerEntry, readLedger, tableRel } from "~/modules/imports/ledger"
import { acquireImportLocks } from "~/modules/imports/lock"
import { recoverLedger } from "~/modules/imports/recover"
import { FINAL_STATUSES, importRunEvent, readImportRun } from "~/modules/imports/runs"
import { ImportError } from "~/modules/imports/types"
import { messageSearchDocIds, windowAnchorsCovering } from "~/modules/search/message-indexer"

const log = rootLogger.child({ module: "imports-undo" })

export interface UndoRefusal {
  table: string
  id: string
  reason:
    | "changed_after_import"
    | "has_new_children"
    | "still_referenced"
    | "used_by_other_run"
    | "not_org_scoped"
    | "predates_run"
}

export interface UndoReport {
  deleted: number
  refused: UndoRefusal[]
}

/** Children linked by an id with no foreign key: files attached to a row, a
 *  knowledge document's memberships and taggings (polymorphic targets). */
const TEXT_LINK_CHILDREN: Record<string, Array<{ table: string; column: string }>> = {
  "app_knowledge.documents": [
    { table: "kernel.files", column: "entity_id" },
    { table: "app_knowledge.collection_memberships", column: "target_id" },
    { table: "app_knowledge.taggings", column: "target_id" },
  ],
  "app_tickets.messages": [{ table: "kernel.files", column: "entity_id" }],
  "app_projects.tasks": [{ table: "kernel.files", column: "entity_id" }],
  // A reply's key to its root is composite (reply_root_id, thread_id), which
  // the single-column foreign-key discovery does not see.
  "kernel.messages": [
    { table: "kernel.files", column: "entity_id" },
    { table: "kernel.messages", column: "reply_root_id" },
  ],
  "kernel.threads": [{ table: "kernel.files", column: "entity_id" }],
}

/** Child tables that hold derived state, not work: viewing a task seats the viewer. */
const NOT_WORK_CHILDREN = new Set([
  "kernel.thread_participants",
  "kernel.user_thread_state",
  // A deal's rows hang off its task and have no id of their own: they go with
  // the task, and a change to them after the import is checked in rowFacts.
  "app_projects.deals",
  "app_projects.deal_values",
])

/**
 * Person columns that carry no foreign key yet name a user (or a contact).
 * Pinned by undo.test.ts; with every FK to the table, they decide whether a
 * placeholder or a contact the run created is still in use.
 */
export const NON_FK_PERSON_COLUMNS: Record<"kernel.users" | "kernel.contacts", string[]> = {
  "kernel.users": [
    "author_id",
    "created_by",
    "assignee_id",
    "assigned_to",
    "reporter_id",
    "user_id",
    "owner_id",
    "owner_user_id",
    "uploaded_by",
  ],
  "kernel.contacts": ["contact_id"],
}

const PERSON_TABLES = new Set(["kernel.users", "kernel.contacts"])
/** Rows a later record of the run (or another run) may reuse: deleted on their own. */
const SHARED_TABLES = new Set([
  "kernel.users",
  "kernel.contacts",
  // A company a contact or deal record created may be used by later records.
  "kernel.companies",
  "app_projects.projects",
  "app_projects.project_statuses",
  // A tag a document created may tag other documents since.
  "app_knowledge.tags",
  // A person's dimension grant row (a calendar import's access) may carry
  // other grants since: kept or removed on its own, never with the record.
  "kernel.user_dimension_grants",
])

const IDENT = /^[a-z_][a-z0-9_]*$/

/** The logical (unprefixed) schema name of a physical one. */
function logicalSchema(physical: string): string {
  const prefix = schemaRef("")
  return prefix && physical.startsWith(prefix) ? physical.slice(prefix.length) : physical
}

const columnCache = new Map<string, Set<string>>()

async function columnsOf(tx: PrivilegedDb, table: string): Promise<Set<string>> {
  const hit = columnCache.get(table)
  if (hit) return hit
  const [schema, name] = table.split(".") as [string, string]
  const cols = new Set(
    extractRows<{ column_name: string }>(
      await tx.execute(drizzleSql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = ${schemaRef(schema)} AND table_name = ${name}
      `),
    ).map((c) => c.column_name),
  )
  columnCache.set(table, cols)
  return cols
}

const childCache = new Map<string, Array<{ table: string; column: string }>>()

/** Tables with a CASCADE or SET NULL foreign key to `table` (single-column), as work. */
async function cascadeChildren(
  tx: PrivilegedDb,
  table: string,
): Promise<Array<{ table: string; column: string }>> {
  const hit = childCache.get(table)
  if (hit) return hit
  const [schema, name] = table.split(".") as [string, string]
  const rows = extractRows<{ schema: string; table: string; column: string }>(
    await tx.execute(drizzleSql`
      SELECT n.nspname AS schema, c.relname AS table, a.attname AS column
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class rc ON rc.oid = k.confrelid
      JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
      WHERE k.contype = 'f' AND k.confdeltype IN ('c', 'n')
        AND rn.nspname = ${schemaRef(schema)} AND rc.relname = ${name}
        AND array_length(k.conkey, 1) = 1
    `),
  )
  const out: Array<{ table: string; column: string }> = []
  for (const r of rows) {
    if (!IDENT.test(r.schema) || !IDENT.test(r.table) || !IDENT.test(r.column)) continue
    const logical = `${logicalSchema(r.schema)}.${r.table}`
    if (NOT_WORK_CHILDREN.has(logical)) continue
    const coverage = IMPORT_COVERAGE[logical]
    if (coverage && "exempt" in coverage && ["derived", "system"].includes(coverage.exempt)) {
      continue
    }
    out.push({ table: logical, column: r.column })
  }
  out.push(...(TEXT_LINK_CHILDREN[table] ?? []))
  childCache.set(table, out)
  return out
}

interface RowFacts {
  exists: boolean
  refusal: UndoRefusal["reason"] | null
}

async function rowFacts(
  tx: PrivilegedDb,
  orgId: string,
  runId: string,
  startedAt: string,
  e: LedgerEntry,
  bundled: boolean,
): Promise<RowFacts> {
  const cols = await columnsOf(tx, e.table)
  if (!cols.has("org_id")) return { exists: true, refusal: "not_org_scoped" }
  // A roll-up the run itself made (a later record updating this row) moved
  // the row's `recorded_at` (runner refreshTouched); any other change is newer.
  // A dimension grant row has no updated_at: one an import created holds the
  // one value it granted, so more values mean someone granted since.
  const changed =
    e.table === "kernel.user_dimension_grants"
      ? drizzleSql`(jsonb_array_length(dimension_values) > 1)`
      : cols.has("updated_at")
        ? drizzleSql`(updated_at > ${e.recordedAt}::timestamptz)`
        : drizzleSql`false`
  // A bundle's ledger can only name rows the run itself wrote. (Host kinds
  // backdate created_at to the source's history, so the check is bundled-only.)
  const predates = !bundled
    ? drizzleSql`false`
    : cols.has("created_at")
      ? drizzleSql`(created_at < ${startedAt}::timestamptz)`
      : drizzleSql`true`
  const rows = extractRows<{ changed: boolean; predates: boolean }>(
    await tx.execute(drizzleSql`
      SELECT ${changed} AS changed, ${predates} AS predates FROM ${tableRel(e.table)}
      WHERE id = ${e.id}::uuid AND org_id = ${orgId}::uuid
    `),
  )
  const row = rows[0]
  if (!row) return { exists: false, refusal: null }
  if (row.predates) return { exists: true, refusal: "predates_run" }
  if (row.changed) return { exists: true, refusal: "changed_after_import" }
  if (PERSON_TABLES.has(e.table)) return { exists: true, refusal: null }
  if (e.table === "app_projects.tasks") {
    // A deal's amount, company or outcome edited since the import is someone's work.
    const [deal] = extractRows<{ changed: boolean }>(
      await tx.execute(drizzleSql`
        SELECT (d.updated_at > ${e.recordedAt}::timestamptz
                OR COALESCE(v.updated_at > ${e.recordedAt}::timestamptz, false)) AS changed
        FROM ${tableRel("app_projects.deals")} d
        LEFT JOIN ${tableRel("app_projects.deal_values")} v ON v.task_id = d.task_id
        WHERE d.task_id = ${e.id}::uuid AND d.org_id = ${orgId}::uuid
      `),
    )
    if (deal?.changed) return { exists: true, refusal: "changed_after_import" }
  }
  const K = drizzleSql.raw(schemaRef("kernel"))
  for (const spec of await cascadeChildren(tx, e.table)) {
    const childCols = await columnsOf(tx, spec.table)
    const col = drizzleSql.raw(quoteIdent(spec.column))
    const match =
      spec.table === "kernel.files"
        ? drizzleSql`c.${col} = ${e.id}`
        : drizzleSql`c.${col} = ${e.id}::uuid`
    const orgMatch = childCols.has("org_id")
      ? drizzleSql`AND c.org_id = ${orgId}::uuid`
      : drizzleSql``
    // A child table without an id column can never be on a ledger: any row of
    // it is someone's work (task dependencies, say).
    const notOurs = childCols.has("id")
      ? drizzleSql`AND NOT EXISTS (
            SELECT 1 FROM ${K}.import_ledger l
            WHERE l.run_id = ${runId}::uuid AND l.table_name = ${spec.table} AND l.row_id = c.id
          )`
      : drizzleSql``
    const found = extractRows(
      await tx.execute(drizzleSql`
        SELECT 1 FROM ${tableRel(spec.table)} c
        WHERE ${match} ${orgMatch} ${notOurs}
        LIMIT 1
      `),
    )
    if (found.length > 0) return { exists: true, refusal: "has_new_children" }
  }
  return { exists: true, refusal: null }
}

/** Every (table, column) that may name a row of `target`: FKs plus the pinned non-FK columns. */
async function referencingColumns(
  tx: PrivilegedDb,
  target: "kernel.users" | "kernel.contacts",
): Promise<Array<{ schema: string; table: string; column: string }>> {
  const [tSchema, tName] = target.split(".") as [string, string]
  const fks = extractRows<{ schema: string; table: string; column: string }>(
    await tx.execute(drizzleSql`
      SELECT n.nspname AS schema, c.relname AS table, a.attname AS column
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_class rc ON rc.oid = k.confrelid
      JOIN pg_namespace rn ON rn.oid = rc.relnamespace
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY (k.conkey)
      WHERE k.contype = 'f' AND rn.nspname = ${schemaRef(tSchema)} AND rc.relname = ${tName}
        AND array_length(k.conkey, 1) = 1
    `),
  )
  const names = NON_FK_PERSON_COLUMNS[target]
  const nonFk = extractRows<{ schema: string; table: string; column: string }>(
    await tx.execute(drizzleSql`
      SELECT c.table_schema AS schema, c.table_name AS table, c.column_name AS column
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE t.table_type = 'BASE TABLE' AND c.data_type = 'uuid'
        AND c.column_name IN (${drizzleSql.join(
          names.map((n) => drizzleSql`${n}`),
          drizzleSql`, `,
        )})
        AND (c.table_schema = ${schemaRef("kernel")} OR c.table_schema LIKE ${`${schemaRef("app_")}%`})
    `),
  )
  const seen = new Set<string>()
  const out: Array<{ schema: string; table: string; column: string }> = []
  for (const r of [...fks, ...nonFk]) {
    const key = `${r.schema}.${r.table}.${r.column}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

async function personInUse(
  tx: PrivilegedDb,
  runId: string,
  e: LedgerEntry,
): Promise<UndoRefusal["reason"] | null> {
  const K = drizzleSql.raw(schemaRef("kernel"))
  const other = extractRows(
    await tx.execute(drizzleSql`
      SELECT 1 FROM ${K}.import_ledger
      WHERE table_name = ${e.table} AND row_id = ${e.id}::uuid AND run_id <> ${runId}::uuid
      LIMIT 1
    `),
  )
  if (other.length > 0) return "used_by_other_run"
  const target = e.table === "kernel.users" ? "kernel.users" : "kernel.contacts"
  for (const ref of await referencingColumns(tx, target)) {
    if (!IDENT.test(ref.schema) || !IDENT.test(ref.table) || !IDENT.test(ref.column)) continue
    const rel = drizzleSql.raw(`${quoteIdent(ref.schema)}.${quoteIdent(ref.table)}`)
    const col = drizzleSql.raw(quoteIdent(ref.column))
    const hit = extractRows(
      await tx.execute(drizzleSql`SELECT 1 FROM ${rel} WHERE ${col} = ${e.id}::uuid LIMIT 1`),
    )
    if (hit.length > 0) return "still_referenced"
  }
  return null
}

/**
 * A company is held by soft references (no foreign key): contacts, deals,
 * pipelines and portal users. It goes only when nothing outside this undo
 * still names it, and no other run created it too.
 */
async function companyInUse(
  tx: PrivilegedDb,
  orgId: string,
  runId: string,
  e: LedgerEntry,
): Promise<boolean> {
  const K = drizzleSql.raw(schemaRef("kernel"))
  const other = extractRows(
    await tx.execute(drizzleSql`
      SELECT 1 FROM ${K}.import_ledger
      WHERE table_name = ${e.table} AND row_id = ${e.id}::uuid AND run_id <> ${runId}::uuid
      LIMIT 1
    `),
  )
  if (other.length > 0) return true
  for (const [table, column] of [
    ["kernel.contacts", "company_id"],
    ["kernel.users", "company_id"],
    ["app_projects.deals", "company_id"],
    ["app_projects.projects", "company_id"],
  ] as const) {
    const hit = extractRows(
      await tx.execute(drizzleSql`
        SELECT 1 FROM ${tableRel(table)}
        WHERE ${drizzleSql.identifier(column)} = ${e.id}::uuid AND org_id = ${orgId}::uuid LIMIT 1
      `),
    )
    if (hit.length > 0) return true
  }
  return false
}

/** Delete one ledgered row of the run's org; returns its storage keys (files). */
async function deleteRow(tx: PrivilegedDb, orgId: string, e: LedgerEntry): Promise<string[]> {
  if (e.table === "kernel.threads") {
    // user_thread_state has no foreign key to threads: it would be orphaned.
    await tx.execute(drizzleSql`
      DELETE FROM ${tableRel("kernel.user_thread_state")}
      WHERE thread_id = ${e.id}::uuid AND org_id = ${orgId}::uuid
    `)
  }
  const cols = await columnsOf(tx, e.table)
  if (!cols.has("storage_key")) {
    await tx.execute(drizzleSql`
      DELETE FROM ${tableRel(e.table)} WHERE id = ${e.id}::uuid AND org_id = ${orgId}::uuid
    `)
    return []
  }
  const thumb = cols.has("thumbnail_key")
    ? drizzleSql`thumbnail_key`
    : drizzleSql`NULL::text AS thumbnail_key`
  const keys = extractRows<{ storage_key: string; thumbnail_key: string | null }>(
    await tx.execute(drizzleSql`
      DELETE FROM ${tableRel(e.table)} WHERE id = ${e.id}::uuid AND org_id = ${orgId}::uuid
      RETURNING storage_key, ${thumb}
    `),
  )
  return keys.flatMap((k) => (k.thumbnail_key ? [k.storage_key, k.thumbnail_key] : [k.storage_key]))
}

/** The search documents of the run's imported messages, by message id. */
async function messageSearchDocs(orgId: string, runId: string): Promise<Map<string, string[]>> {
  const K = drizzleSql.raw(schemaRef("kernel"))
  const rows = await withPrivilegedDb(orgId, "imports-undo-message-docs", async (tx) =>
    extractRows<{ id: string; thread_id: string }>(
      await tx.execute(drizzleSql`
        SELECT m.id, m.thread_id FROM ${K}.messages m
        JOIN ${K}.import_ledger l ON l.row_id = m.id AND l.table_name = 'kernel.messages'
        WHERE l.run_id = ${runId}::uuid AND l.org_id = ${orgId}::uuid AND m.org_id = ${orgId}::uuid
      `),
    ),
  )
  const out = new Map<string, string[]>()
  for (const r of rows) {
    const anchors = await windowAnchorsCovering(orgId, r.thread_id, r.id).catch(() => [])
    out.set(r.id, messageSearchDocIds(orgId, r.thread_id, r.id, anchors))
  }
  return out
}

/**
 * Take what the undo deleted out of search: a searchable entity's document
 * (a ticket, a task, a knowledge document, a contact...) and a message's own
 * and window documents. Best effort, after the commit: the rows are gone from
 * every read path either way, and a reindex restores the index.
 */
async function removeFromSearch(
  orgId: string,
  runId: string,
  deleted: LedgerEntry[],
  messageDocs: Map<string, string[]>,
): Promise<void> {
  if (deleted.length === 0) return
  try {
    const { collectSearchableRegistrations } = await import("~/modules/search/searchable-entities")
    const { enqueueIndexerDelete } = await import("~/modules/search/indexer")
    const { recordLiveIndex, rawDeleteItem } = await import("~/modules/search/live-index-queue")
    const entityOf = new Map<string, { app: string; entityType: string }>()
    for (const e of collectSearchableRegistrations(orgId).entities) {
      if (!e.tableName) continue
      const schema = e.schemaName ?? ownAppSchema(e.app)
      entityOf.set(`${schema}.${e.tableName}`, { app: e.app, entityType: e.entityType })
    }
    const messageIds: string[] = []
    for (const row of deleted) {
      if (row.table === "kernel.messages") {
        messageIds.push(...(messageDocs.get(row.id) ?? []))
        continue
      }
      const entity = entityOf.get(row.table)
      if (entity) await enqueueIndexerDelete(orgId, entity.app, entity.entityType, row.id, runId)
    }
    for (let i = 0; i < messageIds.length; i += 1000) {
      const ids = messageIds.slice(i, i + 1000)
      await recordLiveIndex([rawDeleteItem(orgId, `import-undo:${runId}:${i}`, { ids })])
    }
  } catch (err) {
    log.warn({ err, orgId, runId }, "undo: search removal could not be queued")
  }
}

function isFkViolation(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code
  return code === "23503"
}

/** The undo's work, in one transaction (see the module header). */
async function undoInTransaction(
  tx: PrivilegedDb,
  orgId: string,
  runId: string,
  startedAt: string,
  storageKeys: string[],
  deletedRows: LedgerEntry[],
): Promise<UndoReport> {
  const ledger = (await readLedger(tx, orgId, runId)).filter((e) => isLedgerTableName(e.table))
  const out: UndoReport = { deleted: 0, refused: [] }
  const groupKey = (e: LedgerEntry) => `${e.kind}\u0000${e.recordKey}`

  // Pass 1: facts of every row; a refused non-shared row keeps its record.
  const keptRecords = new Set<string>()
  const keptRows = new Set<string>()
  const live = new Set<string>()
  const bundledKinds = new Set(
    [...new Set(ledger.map((e) => e.kind))].filter((k) => lookupImportKind(orgId, k, true)?.bundle),
  )
  for (const e of ledger) {
    const facts = await rowFacts(tx, orgId, runId, startedAt, e, bundledKinds.has(e.kind))
    if (!facts.exists) continue
    live.add(`${e.table}:${e.id}`)
    if (!facts.refusal) continue
    out.refused.push({ table: e.table, id: e.id, reason: facts.refusal })
    if (SHARED_TABLES.has(e.table)) keptRows.add(`${e.table}:${e.id}`)
    else keptRecords.add(groupKey(e))
  }

  // Pass 2: each record's own rows, newest first, in one savepoint.
  const groups = new Map<string, LedgerEntry[]>()
  for (const e of ledger) {
    if (SHARED_TABLES.has(e.table) || !live.has(`${e.table}:${e.id}`)) continue
    if (keptRecords.has(groupKey(e))) continue
    const list = groups.get(groupKey(e)) ?? []
    list.push(e)
    groups.set(groupKey(e), list)
  }
  for (const rows of groups.values()) {
    const keys: string[] = []
    try {
      await tx.transaction(async (sp) => {
        for (const e of rows) keys.push(...(await deleteRow(sp, orgId, e)))
      })
      out.deleted += rows.length
      storageKeys.push(...keys)
      deletedRows.push(...rows)
    } catch (err) {
      if (!isFkViolation(err)) throw err
      const first = rows[0]
      if (first) out.refused.push({ table: first.table, id: first.id, reason: "still_referenced" })
    }
  }

  // Pass 3: shared rows, newest first, each on its own.
  for (const e of ledger) {
    if (!SHARED_TABLES.has(e.table) || !live.has(`${e.table}:${e.id}`)) continue
    if (keptRows.has(`${e.table}:${e.id}`) || keptRecords.has(groupKey(e))) continue
    if (PERSON_TABLES.has(e.table)) {
      const inUse = await personInUse(tx, runId, e)
      if (inUse) {
        out.refused.push({ table: e.table, id: e.id, reason: inUse })
        continue
      }
    }
    if (e.table === "kernel.companies" && (await companyInUse(tx, orgId, runId, e))) {
      out.refused.push({ table: e.table, id: e.id, reason: "still_referenced" })
      continue
    }
    try {
      await tx.transaction(async (sp) => {
        await deleteRow(sp, orgId, e)
      })
      out.deleted++
      deletedRows.push(e)
    } catch (err) {
      if (!isFkViolation(err)) throw err
      out.refused.push({ table: e.table, id: e.id, reason: "still_referenced" })
    }
  }
  return out
}

/**
 * Undo a final run for `userId` (the person who started it or an org admin,
 * with the kinds' write scopes). Throws `ImportError` when refused.
 */
export async function undoImportRun(
  orgId: string,
  runId: string,
  opts: { userId: string },
): Promise<UndoReport> {
  const run = await withPrivilegedDb(orgId, "imports-undo-read", (tx) =>
    readImportRun(tx, orgId, runId),
  )
  if (!run) throw new ImportError("not_found", "import run not found")
  await assertRunAuthority(orgId, opts.userId, run)
  if (run.status === "undone") {
    throw new ImportError(
      "already_undone",
      "this import was already undone: nothing is left to undo",
    )
  }
  if (!FINAL_STATUSES.has(run.status)) {
    throw new ImportError("not_final", `an import run that is ${run.status} cannot be undone yet`)
  }

  const locks = await acquireImportLocks(orgId, run.kindSet, 0)
  if (!locks) throw new ImportError("locked", "an import of the same kind is running")
  try {
    // The claim: one conditional UPDATE, so two undos never both start, and
    // the prior status is kept for a revert.
    const priorStatus: ImportRunStatus = run.status
    const claimed = await withPrivilegedDb(orgId, "imports-undo-claim", (tx) =>
      tx
        .update(importRuns)
        .set({
          status: "undoing",
          heartbeatAt: drizzleSql`now()`,
          report: drizzleSql`${importRuns.report} || ${JSON.stringify({ undoPriorStatus: priorStatus })}::jsonb`,
        })
        .where(
          and(
            eq(importRuns.orgId, orgId),
            eq(importRuns.id, runId),
            inArray(importRuns.status, [...FINAL_STATUSES]),
          ),
        )
        .returning({ id: importRuns.id })
        .then(async (rows) => {
          if (rows.length > 0) await tx.queueEvent(importRunEvent(orgId, runId, "undoing"))
          return rows
        }),
    )
    if (claimed.length === 0) {
      throw new ImportError("not_final", "the import run is no longer final")
    }

    // A bundled kind's rows a crash left unrecorded are recorded first.
    if (run.kindSet.some((k) => lookupImportKind(orgId, k, false)?.bundle)) {
      await recoverLedger(orgId, runId)
    }

    const startedAt = (run.startedAt ?? run.createdAt).toISOString()
    const storageKeys: string[] = []
    const deletedRows: LedgerEntry[] = []
    // A message's window documents are found while the message still exists.
    const messageDocs = await messageSearchDocs(orgId, runId)
    const beat = setInterval(() => {
      withPrivilegedDb(orgId, "imports-undo-heartbeat", (tx) =>
        tx
          .update(importRuns)
          .set({ heartbeatAt: drizzleSql`now()` })
          .where(and(eq(importRuns.orgId, orgId), eq(importRuns.id, runId))),
      ).catch(() => {})
    }, 60_000)
    let report: UndoReport
    try {
      report = await withPrivilegedDb(
        orgId,
        "imports-undo",
        (tx) => undoInTransaction(tx, orgId, runId, startedAt, storageKeys, deletedRows),
        { pool: "jobs" },
      )
    } catch (err) {
      // Nothing was deleted (one transaction): the run goes back to its
      // prior status, unless something else already moved it.
      await withPrivilegedDb(orgId, "imports-undo-revert", (tx) =>
        tx
          .update(importRuns)
          .set({ status: priorStatus })
          .where(
            and(
              eq(importRuns.orgId, orgId),
              eq(importRuns.id, runId),
              eq(importRuns.status, "undoing"),
            ),
          )
          .then(() => tx.queueEvent(importRunEvent(orgId, runId, priorStatus))),
      )
      throw err
    } finally {
      clearInterval(beat)
    }

    await removeFromSearch(orgId, runId, deletedRows, messageDocs)
    if (storageKeys.length > 0) {
      await deleteObjects(storageKeys).catch((err) =>
        log.warn({ err, orgId, runId, count: storageKeys.length }, "undo: storage delete failed"),
      )
    }
    await withPrivilegedDb(orgId, "imports-undo-finish", (tx) =>
      tx
        .update(importRuns)
        .set({
          status: "undone",
          report: drizzleSql`${importRuns.report} || ${JSON.stringify({ undo: report })}::jsonb`,
        })
        .where(
          and(
            eq(importRuns.orgId, orgId),
            eq(importRuns.id, runId),
            eq(importRuns.status, "undoing"),
          ),
        )
        .then(() => tx.queueEvent(importRunEvent(orgId, runId, "undone"))),
    )
    return report
  } finally {
    await locks.release().catch(() => {})
  }
}
