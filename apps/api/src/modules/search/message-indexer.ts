// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Message-level search indexer (P2b-T25, spec-security.md D16).
//
// Thread messages become independently searchable, carrying their
// `requiredScopes` as a Meili filterable ARRAY attribute so a query can be
// narrowed with the `IN[...]` operator to the scopes the searcher actually
// holds. This module owns the write side only; the query side is `service.ts`
// (T26) and `memory-search.ts`, both of which re-check every hit in the
// database.
//
// WHAT THE INDEX HOLDS, and why that list is short
// ------------------------------------------------
// A Meili document has no ACL of its own: everything in it is readable by
// anything that can query the index (the API process, the reindex CLI, anyone
// holding a Meili key). So a message document carries only:
//
//   id, org_id, app, entity_type, entity_id   document identity
//   read_scope                                "kernel:threads:read"
//   is_mentionable = false                    messages never enter the @-picker
//   title                                     the message CONTENT (searchable)
//   created_at, updated_at                    set by the shared doc builder
//   required_scopes                           only when the array is non-empty
//   thread_id                                 memory search scopes a query to
//                                             one conversation; thread search
//                                             narrows to the caller's rooms
//   _vectors, has_vector                      the embedding (index-writer.ts)
//
// and deliberately NOT: the disclosure list, the author, the mentions or the
// metadata. Publishing "who was this message disclosed to" into the index would
// leak the membership of every Share anyway; the disclosure branch is a DB
// post-filter over the (small) result set.
//
// `author_agent_id` and `participant_agent_ids` used to be written too, and
// filterable. Nothing ever filtered on them: memory search enforces the agent's
// seat in the database (`agentMembershipPredicate`), which is also the only
// place it can be right, because the seated agents change after a message is
// indexed and nothing re-indexed the thread's messages when they did. They cost
// a participant read per flush and two facet databases per write; they are gone.
//
// `required_scopes` is OMITTED when empty rather than emitted as `[]`: Meili
// counts an empty array as present for `EXISTS`, so an emitted `[]` would match
// neither `required_scopes IN [...]` nor `NOT required_scopes EXISTS`.
//
// WINDOWS (P4m-T20, redesigned)
// -----------------------------
// A WINDOW document concatenates consecutive messages of a thread, because a
// fact spread over several turns is in no single message ("what did we decide
// about the DHL account"). Memory search is their only reader: its keyword and
// vector legs search `message_window` beside `message`, and map a window hit
// back to its anchor message, which the database then re-checks.
//
// Windows used to sit on every THIRD message by ordinal, which made indexing
// one message read the WHOLE thread up to it (the ordinal was `count(*)` of the
// rows returned): 62 MB of content per message in a 132k message channel, and
// every delete re-read every id of the thread.
//
// A message now ANCHORS a window when its own id says so (`isWindowAnchor`, one
// in MESSAGE_WINDOW_EVERY on average, uniformly because ids are random uuids).
// The window of an anchor covers the messages back to and including the
// previous anchor, so consecutive windows overlap by one message and together
// cover the thread; it is capped at MESSAGE_WINDOW_MAX messages. Everything is
// therefore decided from a BOUNDED read keyed by position:
//
//   - indexing a message reads at most MESSAGE_WINDOW_MAX rows before it (only
//     when it is an anchor) and MESSAGE_WINDOW_MAX ids after it (the window
//     that covers it, when an edit or a delete changes that window's text);
//   - a deletion changes only the window containing the message, not the
//     numbering of every later message as the ordinal scheme did.
//
// One window per four messages instead of one per three: the window documents
// were 25 % of the production index; this is 20 % of the messages' count.
// A message more than MESSAGE_WINDOW_MAX - 1 messages after the previous anchor
// sits in no window (probability (3/4)^15, about 1 %); it keeps its own
// message document, which is the unit that finds a single fact anyway.
//
// All reads that decide a flush's documents run in ONE privileged transaction
// per org, with rows fetched by id in one query.

import { sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { DurableEventContext } from "~/infra/events/durable-consumers"
import { registerDurableEventConsumer } from "~/infra/events/durable-consumers"
import { registerJobWorker } from "~/infra/jobs/jobs"
import { effectiveIndexName, ensureMeiliVectorStore, getMeili } from "~/infra/search/client"
import { isManagedEdition } from "~/lib/edition"
import { offlineSideCalls } from "~/lib/env"
import { searchLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"
import { isRetrievalTool } from "~/modules/agent/context/cold-resume"
import { authorErasedSql } from "~/modules/erasure/erased-user"
import { buildSearchDocument } from "~/modules/search/doc-builder"
import { documentId } from "~/modules/search/document-id"
import { type IndexSourceSink, registerIndexSource } from "~/modules/search/index-sources"
import { sendIndexWrite, writeIndexAndWait } from "~/modules/search/index-writer"
import {
  type LiveIndexItem,
  type LiveIndexResolution,
  rawDeleteItem,
  recordLiveIndex,
  registerLiveIndexResolver,
  registerLiveIndexWorkers,
} from "~/modules/search/live-index-queue"
import type { SearchableEntityRegistration } from "~/modules/search/searchable-entities"

const QUEUE_APP = "kernel"
const UPSERT_JOB = "search-message-index-upsert"
const DELETE_JOB = "search-message-index-delete"
const BRIEF_UPSERT_JOB = "search-brief-index-upsert"
const BRIEF_DELETE_JOB = "search-brief-index-delete"

const MESSAGE_APP = "kernel"
const MESSAGE_ENTITY_TYPE = "message"

/**
 * The message registration, in the exact shape of `KERNEL_BUILTINS`' entries,
 * but held here rather than in that array on purpose: an entry in
 * `KERNEL_BUILTINS` is streamed by the entity rebuild with the shared doc
 * builder, which knows nothing about `required_scopes`; messages are built
 * here, by this module's own rebuild source.
 */
export const MESSAGE_SEARCH_REGISTRATION: SearchableEntityRegistration = {
  app: MESSAGE_APP,
  entityType: MESSAGE_ENTITY_TYPE,
  schemaName: "kernel",
  tableName: "messages",
  readScope: "kernel:threads:read",
  // A message has no title column; its content IS the indexed text.
  indexFields: { title: "content" },
  permissionFields: {},
  mentionable: false,
  // The attributes the transcript queries filter on: scopes (T26, memory
  // search), the thread (memory search, agent thread search), the date (memory
  // search's time window) and whether a vector is stored (the rebuild's vector
  // carry-over). Declared HERE, on the one registration `index-shape.ts` unions
  // into the settings, so no second literal list exists anywhere.
  filterableAttributes: ["required_scopes", "thread_id", "created_at", "has_vector"],
}

/**
 * The sliding window document's entity type: a SECOND document id namespace in
 * the same index, not a second indexer. It reuses the message registration's
 * read scope and filterable attributes, so the settings stay single sourced.
 */
const MESSAGE_WINDOW_ENTITY_TYPE = "message_window"
const MESSAGE_WINDOW_REGISTRATION: SearchableEntityRegistration = {
  ...MESSAGE_SEARCH_REGISTRATION,
  entityType: MESSAGE_WINDOW_ENTITY_TYPE,
}

/** One message in this many anchors a window, on average (see the header). */
export const MESSAGE_WINDOW_EVERY = 4
/** The most messages one window covers, and the most rows a window read touches. */
export const MESSAGE_WINDOW_MAX = 16

/**
 * Filterable attributes the message document needs. Consumed by
 * `expectedSettings` (index-shape.ts), the single settings definition.
 */
export const MESSAGE_SEARCH_FILTERABLE_ATTRIBUTES: readonly string[] =
  MESSAGE_SEARCH_REGISTRATION.filterableAttributes ?? []

/**
 * P4c-T49: the brief's own documents.
 *
 * A brief row and an episode are searchable for the same reason a message is:
 * the answer to "what did we decide about the DHL account" is more often the
 * DECISION ROW than the turn it was said in. They are two more document id
 * namespaces in the SAME index, carrying the same thread and scope attributes
 * as a message, so no query-side filter has to learn anything new. Which agent
 * may recall one (the join point rule, invariant I5) is decided by memory
 * search's database re-check, never by the index.
 */
const BRIEF_ROW_ENTITY_TYPE = "brief_row"
const EPISODE_ENTITY_TYPE = "episode"

const BRIEF_ROW_REGISTRATION: SearchableEntityRegistration = {
  ...MESSAGE_SEARCH_REGISTRATION,
  entityType: BRIEF_ROW_ENTITY_TYPE,
  tableName: "thread_briefs",
}

const EPISODE_REGISTRATION: SearchableEntityRegistration = {
  ...MESSAGE_SEARCH_REGISTRATION,
  entityType: EPISODE_ENTITY_TYPE,
  tableName: "thread_episodes",
}

export interface MessageIndexerJobPayload {
  action: "upsert" | "delete"
  orgId: string
  messageId: string
}

export interface BriefIndexerJobPayload {
  action: "upsert" | "delete"
  kind: "brief_row" | "episode"
  orgId: string
  id: string
}

type Doc = Record<string, unknown>
type Row = Record<string, unknown>

const kernelTable = (name: string) =>
  sql.raw(`${quoteIdent(schemaRef("kernel"))}.${quoteIdent(name)}`)

function rowsOf(result: unknown): Row[] {
  return ((result as { rows?: Row[] }).rows ?? (result as Row[]) ?? []) as Row[]
}

/** An id list as one bound JSON parameter (a bound `string[]` renders as a scalar). */
function uuidList(ids: string[]) {
  return sql`(SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`
}

function indexActionFor(action: string): "upsert" | "delete" | null {
  if (action === "create" || action === "created") return "upsert"
  if (action === "update" || action === "updated") return "upsert"
  if (action === "restore" || action === "restored") return "upsert"
  if (action === "delete" || action === "deleted") return "delete"
  if (action === "archive" || action === "archived") return "delete"
  return null
}

/** Scope arrays reach us straight from postgres; keep only real scope strings. */
function normalizeRequiredScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((s): s is string => typeof s === "string" && s.length > 0)
}

/**
 * A50 (P4c-T50): a row whose whole substance is a RETRIEVAL tool call
 * (memory_search, memory_open, memory_episode, threads_search) and no text.
 *
 * The message TEXT is indexed, the tool part is not: a retrieval result that
 * became a searchable document would be recalled by the next memory_search and
 * replayed as if it were something the conversation said, which is the
 * feedback loop of an agent repeating itself. A row that carries real text
 * alongside a retrieval call still indexes that text; only a row with nothing
 * but the retrieval call has nothing left to index.
 *
 * Nothing is deleted from the row: the thread view keeps showing the call.
 */
export function isRetrievalOnlyMessageRow(row: Record<string, unknown>): boolean {
  const content = typeof row.content === "string" ? row.content.trim() : ""
  if (content.length > 0) return false
  const rawMeta = row.metadata
  const meta =
    typeof rawMeta === "string"
      ? (() => {
          try {
            return JSON.parse(rawMeta) as Record<string, unknown>
          } catch {
            return null
          }
        })()
      : (rawMeta as Record<string, unknown> | null)
  const toolCalls = meta?.toolCalls
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false
  return toolCalls.every((tc) =>
    isRetrievalTool(String((tc as { toolName?: unknown } | null)?.toolName ?? "")),
  )
}

/* -------------------------------------------------------------------------- */
/* Documents                                                                  */
/* -------------------------------------------------------------------------- */

function messageDocId(orgId: string, messageId: string): string {
  return documentId(orgId, MESSAGE_APP, MESSAGE_ENTITY_TYPE, messageId)
}

function windowDocId(orgId: string, threadId: string, anchorId: string): string {
  return documentId(orgId, MESSAGE_APP, MESSAGE_WINDOW_ENTITY_TYPE, `${threadId}:${anchorId}`)
}

/**
 * True when this message anchors a window. A pure function of the id, so every
 * writer (live flush, bulk import, rebuild) agrees without reading the thread.
 */
export function isWindowAnchor(messageId: string): boolean {
  const hex = messageId.replace(/-/g, "").slice(-8)
  if (!/^[0-9a-f]{8}$/i.test(hex)) return false
  return Number.parseInt(hex, 16) % MESSAGE_WINDOW_EVERY === 0
}

/**
 * The span of the window anchored at the LAST row of `recent` (oldest first,
 * at most MESSAGE_WINDOW_MAX rows ending at the anchor): back to and including
 * the previous anchor, or all of `recent` when none is in reach.
 */
export function windowSpan<T extends { id?: unknown }>(recent: T[]): T[] {
  for (let i = recent.length - 2; i >= 0; i--) {
    if (isWindowAnchor(String(recent[i]?.id ?? ""))) return recent.slice(i)
  }
  return recent
}

/** The document of one indexable message row. Scopes come from the ROW. */
async function messageDocument(orgId: string, row: Row): Promise<Doc> {
  const doc = await buildSearchDocument(MESSAGE_SEARCH_REGISTRATION, orgId, row)
  const requiredScopes = normalizeRequiredScopes(row.required_scopes)
  if (requiredScopes.length > 0) doc.required_scopes = requiredScopes
  if (typeof row.thread_id === "string") doc.thread_id = row.thread_id
  return doc
}

/**
 * The window document anchored at the last row of `span` (oldest first).
 * `title` is the window's text, the field the message document uses for its
 * own content, so one searchable attribute covers both.
 */
async function windowDocument(orgId: string, span: Row[]): Promise<Doc | null> {
  const anchor = span[span.length - 1]
  const threadId = typeof anchor?.thread_id === "string" ? anchor.thread_id : null
  const anchorId = typeof anchor?.id === "string" ? anchor.id : null
  if (!anchor || !threadId || !anchorId) return null
  // A window quotes ONLY messages exactly as visible as its anchor: memory
  // search maps a window hit to its anchor and re-checks that one message, so
  // a quoted message with other scopes (or another disclosure list) would let
  // a searcher who may read the anchor match on words they may not read.
  const quoted = span.filter((m) => sameVisibility(m, anchor))
  const doc = await buildSearchDocument(MESSAGE_WINDOW_REGISTRATION, orgId, {
    ...anchor,
    id: `${threadId}:${anchorId}`,
    content: quoted
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .filter((c) => c.length > 0)
      .join("\n"),
  })
  doc.thread_id = threadId
  const scopes = normalizeRequiredScopes(anchor.required_scopes).sort()
  if (scopes.length > 0) doc.required_scopes = scopes
  return doc
}

/** Same required scopes and same disclosure list, as sets. */
function sameVisibility(a: Row, b: Row): boolean {
  const key = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.map(String))].sort().join("\u0000") : ""
  return (
    key(a.required_scopes) === key(b.required_scopes) &&
    key(a.disclosure_list) === key(b.disclosure_list)
  )
}

/* -------------------------------------------------------------------------- */
/* Bounded thread reads                                                       */
/* -------------------------------------------------------------------------- */

/** The window columns: what `windowDocument` and the doc builder read. */
const WINDOW_COLUMNS = sql`m.id, m.thread_id, m.org_id, m.content, m.required_scopes,
  m.disclosure_list, m.created_at`

/**
 * The rows search may quote: live, and not written by an ERASED user. Erasure
 * keeps the rows of shared threads and removes their documents; every read
 * that builds a document (live, bulk, rebuild) applies this, so neither a
 * later event nor a rebuild can bring erased text back.
 */
const QUOTABLE = sql`m.deleted_at IS NULL AND NOT ${authorErasedSql("m")}`

/**
 * The first anchor AFTER `messageId` whose window reaches back to it, or null.
 * Its window is the one that quotes `messageId` (unless `messageId` is itself
 * an anchor, whose own window also does). Positions are compared in Postgres
 * against the row itself, never through a JS Date (which drops microseconds).
 */
async function coveringAnchorAfter(
  tx: PrivilegedDb,
  orgId: string,
  threadId: string,
  messageId: string,
): Promise<string | null> {
  const pivot = sql`(SELECT p.created_at FROM ${kernelTable("messages")} p
    WHERE p.id = ${messageId} AND p.org_id = ${orgId})`
  // The plain `created_at >=` on the pivot is what the (thread_id, created_at)
  // index bounds the scan with (EXPLAIN on a 50k thread: 16 rows, 0.07 ms); the
  // row comparison beside it only breaks ties. Without it the planner walked
  // the thread from its first message.
  const result = await tx.execute(
    sql`SELECT m.id FROM ${kernelTable("messages")} m
        WHERE m.thread_id = ${threadId} AND m.org_id = ${orgId} AND ${QUOTABLE}
          AND m.created_at >= ${pivot}
          AND (m.created_at, m.id) > (${pivot}, ${messageId}::uuid)
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT ${MESSAGE_WINDOW_MAX - 1}`,
  )
  for (const r of rowsOf(result)) if (isWindowAnchor(String(r.id))) return String(r.id)
  return null
}

/**
 * The last MESSAGE_WINDOW_MAX live rows of the thread up to and including
 * `anchorId`, oldest first. Empty when the anchor is not live any more.
 */
async function readWindowRows(
  tx: PrivilegedDb,
  orgId: string,
  threadId: string,
  anchorId: string,
): Promise<Row[]> {
  const pivot = sql`(SELECT p.created_at FROM ${kernelTable("messages")} p
    WHERE p.id = ${anchorId} AND p.org_id = ${orgId})`
  const result = await tx.execute(
    sql`SELECT ${WINDOW_COLUMNS} FROM ${kernelTable("messages")} m
        WHERE m.thread_id = ${threadId} AND m.org_id = ${orgId} AND ${QUOTABLE}
          AND m.created_at <= ${pivot}
          AND (m.created_at, m.id) <= (${pivot}, ${anchorId}::uuid)
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${MESSAGE_WINDOW_MAX}`,
  )
  const rows = rowsOf(result).reverse()
  const last = rows[rows.length - 1]
  return last && String(last.id) === anchorId ? rows : []
}

/**
 * The documents a set of message requests writes, WITHOUT vectors (the caller
 * attaches them once per org): every message's own document or its deletion,
 * and every window whose text the requests changed. One transaction, one row
 * read for the whole set, and bounded reads per message.
 */
async function planMessageRequests(
  orgId: string,
  requests: Array<{ action: "upsert" | "delete"; messageId: string }>,
): Promise<{ docs: Doc[]; deleteIds: string[] }> {
  const out = { docs: [] as Doc[], deleteIds: [] as string[] }
  if (requests.length === 0) return out
  const ids = [...new Set(requests.map((r) => r.messageId).filter((id) => UUID_RE.test(id)))]
  // Runs under BYPASSRLS, so org_id is bound in every predicate as well as the
  // id: the message id travels through an event payload and must never be able
  // to pull another tenant's row into this org's documents.
  return await withPrivilegedDb(orgId, "message-indexer:kernel:plan", async (tx) => {
    const rows =
      ids.length === 0
        ? []
        : rowsOf(
            await tx.execute(
              sql`SELECT m.*, ${authorErasedSql("m")} AS author_erased
                  FROM ${kernelTable("messages")} m
                  WHERE m.org_id = ${orgId} AND m.id IN ${uuidList(ids)}`,
            ),
          )
    const byId = new Map(rows.map((r) => [String(r.id), r]))
    const rebuild = new Map<string, { threadId: string; anchorId: string }>()
    const dropped = new Set<string>()
    for (const req of requests) {
      const row = byId.get(req.messageId)
      // A row soft-deleted since the event was queued leaves no document: the
      // thread read path hides it, and search must agree. A50: a retrieval-only
      // turn has no indexable text. Deleted rather than skipped, so a row that
      // becomes retrieval-only through an edit does not keep its old document.
      // An erased author's message is as gone as a deleted one (see QUOTABLE).
      const live =
        !!row && req.action === "upsert" && row.deleted_at == null && row.author_erased !== true
      if (row && live && !isRetrievalOnlyMessageRow(row)) {
        out.docs.push(await messageDocument(orgId, row))
      } else {
        out.deleteIds.push(messageDocId(orgId, req.messageId))
      }
      // A vanished row leaves nothing to position a window by; the rebuild's
      // fresh index is what drops a window quoting it.
      if (!row) continue
      const threadId = String(row.thread_id)
      if (isWindowAnchor(req.messageId)) {
        const wid = windowDocId(orgId, threadId, req.messageId)
        if (live) rebuild.set(wid, { threadId, anchorId: req.messageId })
        else dropped.add(wid)
      }
      const next = await coveringAnchorAfter(tx, orgId, threadId, req.messageId)
      if (next) rebuild.set(windowDocId(orgId, threadId, next), { threadId, anchorId: next })
    }
    for (const [wid, w] of rebuild) {
      if (dropped.has(wid)) continue
      const recent = await readWindowRows(tx, orgId, w.threadId, w.anchorId)
      const doc = recent.length > 0 ? await windowDocument(orgId, windowSpan(recent)) : null
      if (doc) out.docs.push(doc)
      else dropped.add(wid)
    }
    out.deleteIds.push(...dropped)
    return out
  })
}

/* -------------------------------------------------------------------------- */
/* Streaming a thread (bulk import, rebuild)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Turns a thread's rows, in (thread, created_at, id) order, into the documents
 * the live path would write for them: the same builders, the same anchors, the
 * same skip rules. Keeps the last MESSAGE_WINDOW_MAX rows of the current
 * thread, which is all a window needs.
 */
class TranscriptAccumulator {
  private recent: Row[] = []
  private threadId: string | null = null
  counts = { messages: 0, windows: 0 }

  constructor(private readonly orgId: string) {}

  async push(row: Row): Promise<Doc[]> {
    const docs: Doc[] = []
    const threadId = String(row.thread_id)
    if (threadId !== this.threadId) {
      this.threadId = threadId
      this.recent = []
    }
    this.recent.push(row)
    if (this.recent.length > MESSAGE_WINDOW_MAX) this.recent.shift()
    if (!isRetrievalOnlyMessageRow(row)) {
      docs.push(await messageDocument(this.orgId, row))
      this.counts.messages += 1
    }
    if (isWindowAnchor(String(row.id))) {
      const doc = await windowDocument(this.orgId, windowSpan(this.recent))
      if (doc) {
        docs.push(doc)
        this.counts.windows += 1
      }
    }
    return docs
  }
}

/**
 * Keyset-page the live messages of one thread, or of a whole org, in
 * (thread_id, created_at, id) order. The cursor is the row's own
 * `created_at::text`, so no position is ever rounded through a JS Date.
 */
async function streamMessageRows(
  orgId: string,
  scope: { threadId: string } | "org",
  pageSize: number,
  onPage: (rows: Row[]) => Promise<void>,
): Promise<void> {
  let cursor: { thread: string; at: string; id: string } | null = null
  const threadPredicate = scope === "org" ? sql`` : sql`AND m.thread_id = ${scope.threadId}`
  for (;;) {
    const after: typeof cursor = cursor
    const rows = await withPrivilegedDb(orgId, "message-indexer:kernel:stream", async (tx) =>
      rowsOf(
        await tx.execute(
          sql`SELECT m.*, m.created_at::text AS cursor_at FROM ${kernelTable("messages")} m
              WHERE m.org_id = ${orgId} AND ${QUOTABLE} ${threadPredicate}
                ${
                  after
                    ? sql`AND (m.thread_id, m.created_at, m.id) >
                          (${after.thread}::uuid, ${after.at}::timestamptz, ${after.id}::uuid)`
                    : sql``
                }
              ORDER BY m.thread_id ASC, m.created_at ASC, m.id ASC
              LIMIT ${pageSize}`,
        ),
      ),
    )
    if (rows.length === 0) return
    const last = rows[rows.length - 1] as Row
    cursor = { thread: String(last.thread_id), at: String(last.cursor_at), id: String(last.id) }
    await onPage(rows.map(({ cursor_at: _c, ...row }) => row))
    if (rows.length < pageSize) return
  }
}

/** Pages a bulk backfill keeps queued in Meili at once (see indexThreadMessagesBulk). */
const MAX_QUEUED_PAGES = 4

/** Wait for one bulk task as long as the queue needs; fail only on a task Meili failed. */
async function waitForBulkTask(meili: ReturnType<typeof getMeili>, uid: number | undefined) {
  if (typeof uid !== "number") return
  const done = await meili.tasks.waitForTask(uid, { timeout: 120 * 60_000, interval: 500 })
  if (done.status !== "succeeded") {
    throw new Error(`search task ${uid} ${done.status}: ${done.error?.message ?? "no detail"}`)
  }
}

/**
 * Bulk backfill of ONE thread's messages into the search index: every message
 * document and every window document, built from a single ordered stream of
 * the thread instead of one job per message.
 *
 * For writers that put history in with direct SQL and therefore emit no
 * message events (the Slack importer). The documents are the ones the live
 * path builds (`TranscriptAccumulator` shares the builders and the anchors).
 *
 * Keyword only by default (`_vectors` null, which the embedding backfill job
 * fills later): embedding a whole imported history is a provider bill the
 * operator opts into with `withVectors`.
 */
export async function indexThreadMessagesBulk(
  orgId: string,
  threadId: string,
  opts: { pageSize?: number; withVectors?: boolean } = {},
): Promise<{ messages: number; windows: number }> {
  const pageSize = opts.pageSize ?? 1000
  const meili = getMeili()
  const acc = new TranscriptAccumulator(orgId)
  const taskUids: number[] = []

  await streamMessageRows(orgId, { threadId }, pageSize, async (rows) => {
    const docs: Doc[] = []
    for (const row of rows) docs.push(...(await acc.push(row)))
    if (docs.length === 0) return
    if (opts.withVectors) await attachVectors(orgId, docs)
    // Bounded look-ahead: enough queued pages for Meili to batch them, few
    // enough that one batch stays small. An unbounded queue (a 130k message
    // channel) had Meili batch it all at once and get OOM-killed.
    while (taskUids.length >= MAX_QUEUED_PAGES) await waitForBulkTask(meili, taskUids.shift())
    const uids = await sendIndexWrite(
      { docs },
      {
        replay: rows.map((r) =>
          messageLiveIndexItem({ action: "upsert", orgId, messageId: String(r.id) }),
        ),
      },
    )
    taskUids.push(...uids)
  })
  // Pages are enqueued ahead of the waits: Meili batches consecutive document
  // additions into one indexing pass, which waiting after each page prevents.
  for (const uid of taskUids) await waitForBulkTask(meili, uid)
  return acc.counts
}

/**
 * Index a known set of messages in batches: one Meili task per batch instead
 * of one per message. For writers that INSERT messages directly and emit no
 * events (the projects importer). The documents are the live path's own
 * (`planMessageRequests`); a vanished, deleted or retrieval only row leaves
 * no document.
 *
 * Best effort per message: a batch whose documents could not be built, or
 * that Meili failed, comes back in `failures`; nothing throws.
 */
export async function indexMessagesBulk(
  orgId: string,
  messageIds: string[],
  opts: { batchSize?: number } = {},
): Promise<{ indexed: number; failures: Array<{ messageId: string; error: string }> }> {
  const batchSize = Math.max(1, opts.batchSize ?? 500)
  const meili = getMeili()
  const failures: Array<{ messageId: string; error: string }> = []
  const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))
  const inFlight: Array<{ uids: number[]; ids: string[] }> = []
  let indexed = 0
  const settle = async (entry: { uids: number[]; ids: string[] }) => {
    try {
      for (const uid of entry.uids) await waitForBulkTask(meili, uid)
      indexed += entry.ids.length
    } catch (err) {
      for (const messageId of entry.ids) failures.push({ messageId, error: errorText(err) })
    }
  }

  for (let start = 0; start < messageIds.length; start += batchSize) {
    const batchIds = messageIds.slice(start, start + batchSize)
    const requests = batchIds.map((messageId) => ({ action: "upsert" as const, messageId }))
    try {
      const plan = await planMessageRequests(orgId, requests)
      await attachVectors(orgId, plan.docs)
      while (inFlight.length >= MAX_QUEUED_PAGES) await settle(inFlight.shift()!)
      const uids = await sendIndexWrite(plan, {
        replay: requests.map((r) => messageLiveIndexItem({ ...r, orgId })),
      })
      inFlight.push({ uids, ids: batchIds })
    } catch (err) {
      for (const messageId of batchIds) failures.push({ messageId, error: errorText(err) })
    }
  }
  while (inFlight.length > 0) await settle(inFlight.shift()!)
  return { indexed, failures }
}

/**
 * The window documents whose text quotes `messageId`, by their ANCHOR id: its
 * own window when it is an anchor, and the window of the next anchor within
 * reach. Two bounded reads, whatever the thread's length.
 */
export async function windowAnchorsCovering(
  orgId: string,
  threadId: string,
  messageId: string,
  privileged?: PrivilegedDb,
): Promise<string[]> {
  const anchors = isWindowAnchor(messageId) ? [messageId] : []
  const read = (tx: PrivilegedDb) => coveringAnchorAfter(tx, orgId, threadId, messageId)
  // On the caller's privileged transaction (an erasure), inside a savepoint so a
  // failed read stays best effort and never aborts that transaction.
  const next = privileged
    ? await privileged.transaction(read)
    : await withPrivilegedDb(orgId, "message-indexer:kernel:window-anchors", read)
  if (next) anchors.push(next)
  return anchors
}

/**
 * Remove a message's own document AND every window document quoting it, for a
 * HUMAN delete or an erasure: decided NOW, while the row still positions the
 * message, and recorded as a durable delete the flusher applies within about a
 * second. Nothing waits for Meili here, so a slow index never holds the
 * caller's transaction open.
 *
 * The post-commit delete event then REBUILDS the covering window from the
 * thread as it stands (the live resolver reads the soft-deleted row), so the
 * other messages of that window become recallable again without the deleted
 * text. An erasure, which emits no such event, leaves the window deleted.
 */
export async function deleteMessageAndWindowDocuments(
  orgId: string,
  threadId: string,
  messageId: string,
  privileged?: PrivilegedDb,
): Promise<string[]> {
  try {
    const anchors = await windowAnchorsCovering(orgId, threadId, messageId, privileged)
    const docId = messageDocId(orgId, messageId)
    await recordLiveIndex([
      rawDeleteItem(orgId, `${docId}:erase`, {
        ids: [docId, ...anchors.map((a) => windowDocId(orgId, threadId, a))],
      }),
    ])
    return anchors
  } catch (err) {
    // Search is best effort and must never fail the delete: the message itself
    // is gone from every read path, and a rebuild restores the index.
    log.warn({ err, orgId, threadId, messageId }, "Could not queue removal of message documents")
    return []
  }
}

/**
 * The search documents of one message: its own, and the windows anchored at
 * `anchors` (from `windowAnchorsCovering`, read while the message still
 * exists). For a caller that removes the message itself and records the
 * deletes after its own commit (an import undo).
 */
export function messageSearchDocIds(
  orgId: string,
  threadId: string,
  messageId: string,
  anchors: string[],
): string[] {
  return [messageDocId(orgId, messageId), ...anchors.map((a) => windowDocId(orgId, threadId, a))]
}

/**
 * Index one message NOW and wait for Meili (direct callers: backfills, tests).
 * Live message events go through the coalescing queue instead.
 */
export async function processMessageIndexerJob(payload: MessageIndexerJobPayload): Promise<void> {
  const plan = await planMessageRequests(payload.orgId, [
    { action: payload.action, messageId: payload.messageId },
  ])
  // P4c-T48: one vector per document, from the org's own key. Absent when the
  // org has no key, which is the keyword-only mode, not a failure.
  await attachVectors(payload.orgId, plan.docs)
  // Deliberately NOT caught: a Meili failure must fail the caller.
  await writeIndexAndWait(plan, { replay: [messageLiveIndexItem(payload)] })
}

/** The rebuild's transcript source: messages and windows, then briefs and episodes. */
async function streamTranscriptForRebuild(orgId: string, sink: IndexSourceSink): Promise<void> {
  const acc = new TranscriptAccumulator(orgId)
  await streamMessageRows(orgId, "org", 2000, async (rows) => {
    const docs: Doc[] = []
    for (const row of rows) docs.push(...(await acc.push(row)))
    await sink(docs, { transcript: true })
  })
  for (const kind of ["brief_row", "episode"] as const) {
    const table = kind === "brief_row" ? "thread_briefs" : "thread_episodes"
    let after: string | null = null
    for (;;) {
      const cursor: string | null = after
      const rows: Row[] = await withPrivilegedDb(
        orgId,
        `message-indexer:kernel:${table}:stream`,
        async (tx) =>
          rowsOf(
            await tx.execute(
              sql`SELECT * FROM ${kernelTable(table)} WHERE org_id = ${orgId}
                ${cursor ? sql`AND id > ${cursor}::uuid` : sql``}
                ORDER BY id ASC LIMIT 500`,
            ),
          ),
      )
      if (rows.length === 0) break
      after = String(rows[rows.length - 1]?.id)
      const docs: Doc[] = []
      for (const row of rows) {
        const doc = await briefDocumentFromRow(orgId, kind, row)
        if (doc) docs.push(doc)
      }
      await sink(docs, { transcript: true })
      if (rows.length < 500) break
    }
  }
}

registerIndexSource("kernel-transcript", streamTranscriptForRebuild)

/* -------------------------------------------------------------------------- */
/* P4c-T49: brief row and episode documents                                   */
/* -------------------------------------------------------------------------- */

/** The union of `required_scopes` over a set of message ids. */
async function readScopesForMessages(orgId: string, messageIds: string[]): Promise<string[]> {
  if (messageIds.length === 0) return []
  return await withPrivilegedDb(orgId, "brief-indexer:kernel:scopes", async (tx) => {
    const result = await tx.execute(
      sql`SELECT m.required_scopes AS required_scopes FROM ${kernelTable("messages")} m
          WHERE m.org_id = ${orgId} AND m.id IN ${uuidList(messageIds)}`,
    )
    return [
      ...new Set(rowsOf(result).flatMap((r) => normalizeRequiredScopes(r.required_scopes))),
    ].sort()
  })
}

async function readBriefRow(
  orgId: string,
  table: "thread_briefs" | "thread_episodes",
  id: string,
): Promise<Row | null> {
  return await withPrivilegedDb(orgId, `brief-indexer:kernel:${table}`, async (tx) => {
    const result = await tx.execute(
      sql`SELECT * FROM ${kernelTable(table)} WHERE id = ${id} AND org_id = ${orgId} LIMIT 1`,
    )
    return rowsOf(result)[0] ?? null
  })
}

function messageIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === "string" && v.length > 0)
}

/** The document of one brief row or episode row, already read. */
async function briefDocumentFromRow(
  orgId: string,
  kind: "brief_row" | "episode",
  row: Row,
): Promise<Doc | null> {
  const threadId = typeof row.thread_id === "string" ? row.thread_id : null
  if (!threadId) return null
  const doc = await buildSearchDocument(
    kind === "brief_row" ? BRIEF_ROW_REGISTRATION : EPISODE_REGISTRATION,
    orgId,
    {
      ...row,
      content:
        kind === "brief_row" ? `${row.kind} ${row.key}: ${row.value}` : `${row.title}\n${row.body}`,
    },
  )
  doc.thread_id = threadId
  const scopes = await readScopesForMessages(orgId, messageIdArray(row.message_ids))
  if (scopes.length > 0) doc.required_scopes = scopes
  return doc
}

/**
 * The Meili document for one brief row: the line's own text, in the thread it
 * belongs to, with the scopes of the messages it was drawn from.
 */
export async function buildBriefRowDocument(orgId: string, id: string): Promise<Doc | null> {
  const row = await readBriefRow(orgId, "thread_briefs", id)
  return row ? await briefDocumentFromRow(orgId, "brief_row", row) : null
}

/** The Meili document for one episode. Same shape, the episode's title and body. */
export async function buildEpisodeDocument(orgId: string, id: string): Promise<Doc | null> {
  const row = await readBriefRow(orgId, "thread_episodes", id)
  return row ? await briefDocumentFromRow(orgId, "episode", row) : null
}

async function planBriefDocument(
  payload: BriefIndexerJobPayload,
): Promise<{ doc: Doc } | { deleteId: string }> {
  const entityType = payload.kind === "brief_row" ? BRIEF_ROW_ENTITY_TYPE : EPISODE_ENTITY_TYPE
  const docId = documentId(payload.orgId, MESSAGE_APP, entityType, payload.id)
  if (payload.action === "delete") return { deleteId: docId }
  const doc =
    payload.kind === "brief_row"
      ? await buildBriefRowDocument(payload.orgId, payload.id)
      : await buildEpisodeDocument(payload.orgId, payload.id)
  return doc ? { doc } : { deleteId: docId }
}

/** Index one brief row or episode NOW and wait for Meili (direct callers, tests). */
export async function processBriefIndexerJob(payload: BriefIndexerJobPayload): Promise<void> {
  const plan = await planBriefDocument(payload)
  if ("deleteId" in plan) {
    await writeIndexAndWait(
      { deleteIds: [plan.deleteId] },
      { replay: [briefLiveIndexItem(payload)] },
    )
    return
  }
  // P4c-T48: a brief row and an episode carry a vector for the same reason a
  // message does, so the vector leg reaches all three document kinds.
  await attachVectors(payload.orgId, [plan.doc])
  await writeIndexAndWait({ docs: [plan.doc] }, { replay: [briefLiveIndexItem(payload)] })
}

/** The coalescing-queue request for one message change. */
export function messageLiveIndexItem(payload: MessageIndexerJobPayload): LiveIndexItem {
  return {
    t: "message",
    key: messageDocId(payload.orgId, payload.messageId),
    payload: { action: payload.action, orgId: payload.orgId, messageId: payload.messageId },
  }
}

/** The coalescing-queue request for one brief row or episode change. */
export function briefLiveIndexItem(payload: BriefIndexerJobPayload): LiveIndexItem {
  const entityType = payload.kind === "brief_row" ? BRIEF_ROW_ENTITY_TYPE : EPISODE_ENTITY_TYPE
  return {
    t: "brief",
    key: documentId(payload.orgId, MESSAGE_APP, entityType, payload.id),
    payload: { action: payload.action, kind: payload.kind, orgId: payload.orgId, id: payload.id },
  }
}

/** Group items by org, so each org's reads share a transaction and one embedding call. */
function byOrg(items: LiveIndexItem[]): Map<string, LiveIndexItem[]> {
  const out = new Map<string, LiveIndexItem[]>()
  for (const item of items) {
    const list = out.get(item.payload.orgId) ?? []
    list.push(item)
    out.set(item.payload.orgId, list)
  }
  return out
}

registerLiveIndexResolver("message", async (items) => {
  const out: LiveIndexResolution = { docs: [], deleteIds: [], failed: [] }
  for (const [orgId, list] of byOrg(items)) {
    try {
      const plan = await planMessageRequests(
        orgId,
        list.map((item) => {
          const p = item.payload as unknown as MessageIndexerJobPayload
          return { action: p.action, messageId: p.messageId }
        }),
      )
      // Vectors are attached per org in ONE embedding call for the round.
      await attachVectors(orgId, plan.docs)
      out.docs.push(...plan.docs)
      out.deleteIds.push(...plan.deleteIds)
    } catch (err) {
      log.warn({ err, orgId, count: list.length }, "Could not build message search documents")
      out.failed.push(...list)
    }
  }
  return out
})

registerLiveIndexResolver("brief", async (items) => {
  const out: LiveIndexResolution = { docs: [], deleteIds: [], failed: [] }
  for (const [orgId, list] of byOrg(items)) {
    const docs: Doc[] = []
    for (const item of list) {
      try {
        const r = await planBriefDocument(item.payload as unknown as BriefIndexerJobPayload)
        if ("deleteId" in r) out.deleteIds.push(r.deleteId)
        else docs.push(r.doc)
      } catch (err) {
        log.warn({ err, key: item.key }, "Could not build a brief search document")
        out.failed.push(item)
      }
    }
    await attachVectors(orgId, docs)
    out.docs.push(...docs)
  }
  return out
})

/**
 * Queue indexing for freshly written brief rows or episodes. BEST EFFORT, like
 * every other search write on this path: the rows are already committed and
 * every read path serves them, so a Redis or Meili outage costs searchability
 * and never the advance that produced them.
 */
export async function enqueueBriefIndexing(
  orgId: string,
  kind: "brief_row" | "episode",
  ids: string[],
): Promise<void> {
  try {
    await recordLiveIndex(
      ids.map((id) => briefLiveIndexItem({ action: "upsert", kind, orgId, id })),
    )
  } catch (err) {
    log.error({ err, orgId, kind, count: ids.length }, "Could not queue brief search indexing")
  }
}

/* -------------------------------------------------------------------------- */
/* P4c-T48: the embedding leg's write side                                    */
/* -------------------------------------------------------------------------- */

/** The default embedding model, the one the long-context bench measured with. */
export const DEFAULT_EMBEDDING_MODEL_ID = "gemini-embedding-001"

/** The Meili embedder these vectors are stored under. */
export { MEMORY_EMBEDDER_NAME } from "~/modules/search/vector-opt-out"

import { MEMORY_EMBEDDER_NAME } from "~/modules/search/vector-opt-out"

/**
 * Output dimensionality per model. Meili's `userProvided` embedder declares a
 * FIXED width and rejects a document whose vector is a different length, so
 * this table and the model id are one decision, never two.
 */
const EMBEDDING_DIMENSIONS_BY_MODEL: Record<string, number> = {
  "gemini-embedding-001": 3072,
  "text-embedding-004": 768,
}
const FALLBACK_EMBEDDING_DIMENSIONS = 3072

export function embeddingDimensionsFor(modelId: string): number {
  return EMBEDDING_DIMENSIONS_BY_MODEL[modelId] ?? FALLBACK_EMBEDDING_DIMENSIONS
}

export interface Embedder {
  modelId: string
  dimensions: number
  /** Vectors in the order the texts were given, plus what the call cost. */
  embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }>
}

type EmbedderFactory = (orgId: string) => Promise<Embedder | null>

let embedderFactoryOverride: EmbedderFactory | null = null

/** Orgs already told, this process, that they are searching keyword only. */
const loggedEmbeddingLegOff = new Set<string>()

/**
 * An org with no usable Google key indexes and searches KEYWORD ONLY. It is a
 * degraded mode, not a failure: every keyword leg still answers, so the line is
 * logged once per org per process rather than once per message.
 */
function noteEmbeddingLegOff(orgId: string, reason: string): null {
  if (!loggedEmbeddingLegOff.has(orgId)) {
    loggedEmbeddingLegOff.add(orgId)
    log.info({ orgId, reason }, "embedding_leg_off")
  }
  return null
}

/** Test-only: has this org been told yet? */
export function embeddingLegOffLoggedFor(orgId: string): boolean {
  return loggedEmbeddingLegOff.has(orgId) || managedRefusalLoggedAt.has(orgId)
}

/**
 * When a managed org's embed batch was last refused and said so. A refusal
 * (payment required, no balance) is a state that ends, so it is logged once
 * per org per hour rather than once per process.
 */
const managedRefusalLoggedAt = new Map<string, number>()
const MANAGED_REFUSAL_LOG_EVERY_MS = 60 * 60 * 1000

function noteManagedEmbeddingRefused(orgId: string, reason: string, code?: string): void {
  const last = managedRefusalLoggedAt.get(orgId)
  const now = Date.now()
  if (last !== undefined && now - last < MANAGED_REFUSAL_LOG_EVERY_MS) return
  managedRefusalLoggedAt.set(orgId, now)
  log.info({ orgId, reason, code }, "embedding_leg_off")
}

/**
 * A managed cell's embedder (S31): OpenRouter, the cell's key, zero data
 * retention, the same Google model and width as the self-hosted path (so the
 * shared index's embedder width never changes). Each batch passes the side-call
 * gate first (`resolveKey` refuses while payment is required; `spendGate`
 * checks the balance), so an embedder built while the org was active stops
 * spending the moment it is not; a refused batch embeds nothing and the
 * documents stay keyword only. Each batch is ONE usage row, billed to
 * a real org user (`systemWorkUserId`).
 */
function managedOrgEmbedder(orgId: string, modelId: string): Embedder {
  const upstreamId = `google/${modelId}`
  return {
    modelId,
    dimensions: embeddingDimensionsFor(modelId),
    async embed(texts: string[]) {
      const [{ managedSideCallGate, systemWorkUserId }, { openRouterEmbed }, { finalizeUsage }] =
        await Promise.all([
          import("~/modules/agent/credits/managed-side-call"),
          import("~/modules/agent/providers/openrouter-embeddings"),
          import("~/modules/agent/credits/credit-meter"),
        ])
      const gate = await managedSideCallGate(orgId, upstreamId)
      if (!gate.allowed) {
        noteManagedEmbeddingRefused(orgId, gate.reason, gate.billingCode)
        return { vectors: [], tokens: 0 }
      }
      const result = await openRouterEmbed({ apiKey: gate.key, upstreamId, texts, orgId })
      recordEmbeddingTokens(orgId, result.tokens)
      await finalizeUsage(orgId, {
        model: gate.model,
        inputTokens: result.tokens,
        outputTokens: 0,
        ...(result.costUsd !== undefined ? { providerCostUsd: result.costUsd } : {}),
        keySource: gate.keySource,
        // No acting user: a real org user, never the system sentinel.
        userId: (await systemWorkUserId(orgId)) ?? "system",
        // A side call inside whatever is running: it took no reservation.
        releaseReservation: false,
        description: "Search embeddings",
        metadata: { feature: "embedding", texts: texts.length },
      }).catch((err) => log.error({ err, orgId }, "Could not meter an embedding batch"))
      return { vectors: result.vectors, tokens: result.tokens }
    },
  }
}

const embedderCache = new Map<string, Embedder | null>()

/**
 * Forget the memoised embedder for one org.
 *
 * MUST be called by every path that changes what `resolveOrgEmbedder` would
 * decide: a BYOK key written, re-validated or removed. The map memoises the
 * NEGATIVE answer too, so without this an org that had no key when its first
 * message was indexed keeps no embedding leg until the process restarts, and
 * on a demo box that is the entire life of the workspace.
 */
export function invalidateOrgEmbedder(orgId: string): void {
  embedderCache.delete(orgId)
  loggedEmbeddingLegOff.delete(orgId)
  managedRefusalLoggedAt.delete(orgId)
}

/**
 * The org's embedder, or null when it has no key. Resolved through the SAME
 * provider seam every model call uses (`resolveKey`), so a BYOK org embeds on
 * its own key and never on Liaison's.
 */
export async function resolveOrgEmbedder(orgId: string): Promise<Embedder | null> {
  if (embedderFactoryOverride) return await embedderFactoryOverride(orgId)
  if (embedderCache.has(orgId)) return embedderCache.get(orgId) ?? null
  // A test server on placeholder keys calls no provider (see offlineSideCalls).
  if (offlineSideCalls()) return noteEmbeddingLegOff(orgId, "offline_side_calls")

  const [{ getOrgKernelSettings }, { orgKernelSettingsSchema }, { isProviderUsable, resolveKey }] =
    await Promise.all([
      import("~/lib/settings"),
      import("@liaison/shared"),
      import("~/modules/agent/credits/credit-meter"),
    ])
  const settings = await withPrivilegedDb(orgId, "embedder:org-settings", (tx) =>
    getOrgKernelSettings(tx, orgId, orgKernelSettingsSchema),
  )
  const modelId =
    (settings.ai as { embeddingModelId?: string | null } | undefined)?.embeddingModelId ||
    DEFAULT_EMBEDDING_MODEL_ID
  // A managed cell embeds on OpenRouter (S31); whether a batch may spend is
  // decided per batch, so the embedder itself is always there.
  if (isManagedEdition()) {
    const embedder = managedOrgEmbedder(orgId, modelId)
    embedderCache.set(orgId, embedder)
    return embedder
  }
  // `isProviderUsable`, not `isProviderConfigured`: on a demo box the key in the
  // environment is refused for a visitor org, so the old check passed,
  // `resolveKey` threw, and the null below was cached for the life of the
  // process. The org then had no embedding leg for the rest of its life, even
  // after its owner pasted a Google key, because nothing invalidated this map.
  // `invalidateOrgEmbedder` is the other half of that fix.
  if (!(await isProviderUsable(orgId, "google", settings))) {
    embedderCache.set(orgId, null)
    return noteEmbeddingLegOff(orgId, "no_google_key")
  }
  // The reserved App Review org does not embed on the deployment's key. The
  // embedder is unmetered and the nightly re-seed would re-embed the whole
  // demo world into the one ledger whose ceiling App Review lives under, so it
  // searches on the lexical leg alone, the same state as an org with no key.
  // No query on a normal deployment.
  const { isReservedDemoOrg } = await import("~/modules/demo/demo-spend")
  if (await isReservedDemoOrg(orgId)) {
    embedderCache.set(orgId, null)
    return noteEmbeddingLegOff(orgId, "reserved_demo_org")
  }

  let apiKey: string
  try {
    apiKey = (await resolveKey(orgId, "google")).key
  } catch {
    embedderCache.set(orgId, null)
    return noteEmbeddingLegOff(orgId, "key_unresolvable")
  }

  const { createGoogle } = await import("@ai-sdk/google")
  const { embedMany } = await import("ai")
  const model = createGoogle({ apiKey }).textEmbeddingModel(modelId)
  const embedder: Embedder = {
    modelId,
    dimensions: embeddingDimensionsFor(modelId),
    async embed(texts: string[]) {
      const { embeddings, usage } = await embedMany({
        model,
        // The provider rejects an oversized value outright; a message longer
        // than this is embedded on its opening, which is where a fact is said.
        values: texts.map((t) => t.slice(0, 8000)),
      })
      const tokens = (usage as { tokens?: number } | undefined)?.tokens ?? 0
      recordEmbeddingTokens(orgId, tokens)
      return { vectors: embeddings as number[][], tokens }
    },
  }
  embedderCache.set(orgId, embedder)
  return embedder
}

/** Running embedding spend, per org per UTC day, for the cost line. */
const embeddingTokensByOrgDay = new Map<string, number>()
/** The UTC day the map's keys are for: a new day drops the past ones. */
let embeddingTokensDay = ""

export function recordEmbeddingTokens(orgId: string, tokens: number): void {
  if (tokens <= 0) return
  const day = new Date().toISOString().slice(0, 10)
  if (day !== embeddingTokensDay) {
    embeddingTokensByOrgDay.clear()
    embeddingTokensDay = day
  }
  const key = `${orgId}:${day}`
  const total = (embeddingTokensByOrgDay.get(key) ?? 0) + tokens
  embeddingTokensByOrgDay.set(key, total)
  log.info({ orgId, day, tokens, dayTokens: total }, "embedding_tokens")
}

const embedderSettingsApplied = new Set<string>()

/**
 * When a declaration last FAILED, per (index, width). A failed declaration is a
 * settings task over the whole index, so it is retried at most once per
 * `EMBEDDER_DECLARE_RETRY_MS` rather than once per indexed message.
 */
const embedderDeclareFailedAt = new Map<string, number>()
const EMBEDDER_DECLARE_RETRY_MS = 60 * 60 * 1000
/** A settings task runs over the whole index; the client's 5 s default is short. */
const EMBEDDER_DECLARE_WAIT_MS = 60_000

/** When the index was last found WITHOUT the embedder, for the search path. */
const embedderAbsentCheckedAt = new Map<string, number>()
const EMBEDDER_ABSENT_RECHECK_MS = 5 * 60 * 1000

/** The embedder could not be declared on the index; vectors are pointless. */
export class MemoryEmbedderUndeclaredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MemoryEmbedderUndeclaredError"
  }
}

type EmbedderSettings = {
  embedders?: Record<string, { source?: string; dimensions?: number }> | null
}

function embedderMatches(settings: EmbedderSettings, dimensions: number): boolean {
  const current = settings.embedders?.[MEMORY_EMBEDDER_NAME]
  return current?.source === "userProvided" && current.dimensions === dimensions
}

/**
 * Declare the `userProvided` embedder on the index, once per process per
 * (index, width).
 *
 * Meilisearch 1.11 keeps the vector store behind an EXPERIMENTAL FEATURE flag,
 * so the flag is turned on first; on a build where the flag does not exist the
 * PATCH is a no-op and the `updateEmbedders` call below is what actually fails,
 * loudly, rather than documents being written with vectors nothing can query.
 *
 * THE TASK'S OUTCOME IS READ, NOT ASSUMED. Meili accepts the settings call and
 * then FAILS the task when any document already in the index carries no
 * `_vectors.memory` (a document written before every writer opted out). A
 * failed task throws, and is not retried for an hour.
 *
 * That failure is healed by a REBUILD, not by a sweep. The sweep that used to
 * run here paged the whole index with its vectors (tens of GB of JSON on a
 * large index) to find the documents to opt out. Every writer now goes through
 * index-writer.ts, which always writes `_vectors.memory`, so such documents
 * only exist in an index written by older code; the rebuild creates its shadow
 * index WITH the embedder declared and swaps it in (reindex.ts).
 */
export async function ensureMemoryEmbedderSettings(dimensions: number): Promise<void> {
  const cacheKey = `${effectiveIndexName()}:${dimensions}`
  if (embedderSettingsApplied.has(cacheKey)) return
  // One declaration (and its sweep) per key at a time: concurrent index jobs
  // share it instead of each sweeping the index and queueing its own task.
  const inFlight = embedderDeclareInFlight.get(cacheKey)
  if (inFlight) return await inFlight
  const run = declareMemoryEmbedder(dimensions).finally(() =>
    embedderDeclareInFlight.delete(cacheKey),
  )
  embedderDeclareInFlight.set(cacheKey, run)
  return await run
}

const embedderDeclareInFlight = new Map<string, Promise<void>>()

async function declareMemoryEmbedder(dimensions: number): Promise<void> {
  const indexName = effectiveIndexName()
  const cacheKey = `${indexName}:${dimensions}`
  if (embedderSettingsApplied.has(cacheKey)) return
  const failedAt = embedderDeclareFailedAt.get(cacheKey)
  if (failedAt !== undefined && Date.now() - failedAt < EMBEDDER_DECLARE_RETRY_MS) {
    throw new MemoryEmbedderUndeclaredError(
      `The ${MEMORY_EMBEDDER_NAME} embedder is not declared on ${indexName}; retrying later`,
    )
  }

  const meili = getMeili()
  try {
    // Through the Meili client's own HTTP layer, so the host, the API key and
    // the per-request timeout come from infra/search/client.ts rather than
    // being re-derived here.
    await ensureMeiliVectorStore()
  } catch (err) {
    log.warn({ err }, "Could not enable the Meili vector store experimental feature")
  }

  const index = meili.index(indexName)
  const settings = (await index.getSettings()) as EmbedderSettings
  if (embedderMatches(settings, dimensions)) {
    embedderSettingsApplied.add(cacheKey)
    return
  }
  const task = await index.updateEmbedders({
    ...(settings.embedders ?? {}),
    [MEMORY_EMBEDDER_NAME]: { source: "userProvided", dimensions },
  } as never)
  const taskUid = (task as { taskUid?: number }).taskUid
  type TaskOutcome = { status?: string; error?: { message?: string; code?: string } | null }
  let done: TaskOutcome | null = null
  if (typeof taskUid === "number") {
    try {
      done = (await meili.tasks.waitForTask(taskUid, {
        timeout: EMBEDDER_DECLARE_WAIT_MS,
      })) as unknown as TaskOutcome
    } catch (err) {
      // Still queued behind other work: not declared yet, and not re-enqueued
      // on the next message either.
      done = { status: "unfinished", error: { message: (err as Error).message } }
    }
  }
  if (done && done.status !== "succeeded") {
    embedderDeclareFailedAt.set(cacheKey, Date.now())
    if (
      done.error?.code === "vector_embedding_error" ||
      /no vectors provided/i.test(done.error?.message ?? "")
    ) {
      // Documents that predate the vector opt-out: rebuild with the embedder.
      const { requestIndexRebuild } = await import("~/modules/search/reindex")
      await requestIndexRebuild("memory_embedder_needs_rebuild", { embedderDimensions: dimensions })
    }
    log.warn(
      { indexName, dimensions, taskUid, status: done.status, error: done.error ?? null },
      "memory_embedder_declare_failed",
    )
    throw new MemoryEmbedderUndeclaredError(
      done.error?.message ?? `Declaring the ${MEMORY_EMBEDDER_NAME} embedder ${done.status}`,
    )
  }
  embedderDeclareFailedAt.delete(cacheKey)
  embedderAbsentCheckedAt.delete(cacheKey)
  embedderSettingsApplied.add(cacheKey)
}

/**
 * Whether the index carries the memory embedder at this width, for the SEARCH
 * path. A vector search against an index without it is a Meili 400 on every
 * query; asking first lets the caller search keyword only. Read only: the
 * search path never declares the embedder, the indexing path does. A miss is
 * re-read at most every five minutes.
 */
export async function memoryEmbedderDeclared(dimensions: number): Promise<boolean> {
  const indexName = effectiveIndexName()
  const cacheKey = `${indexName}:${dimensions}`
  if (embedderSettingsApplied.has(cacheKey)) return true
  const checkedAt = embedderAbsentCheckedAt.get(cacheKey)
  if (checkedAt !== undefined && Date.now() - checkedAt < EMBEDDER_ABSENT_RECHECK_MS) return false
  const settings = (await getMeili().index(indexName).getSettings()) as EmbedderSettings
  if (embedderMatches(settings, dimensions)) {
    embedderAbsentCheckedAt.delete(cacheKey)
    embedderSettingsApplied.add(cacheKey)
    return true
  }
  embedderAbsentCheckedAt.set(cacheKey, Date.now())
  return false
}

/**
 * Attach one vector per document, in place. BEST EFFORT: an embedding outage
 * costs the vector leg for those documents and never the document itself,
 * which is exactly the "search works keyword only until a document has its
 * vector" rule the backfill relies on.
 *
 * A document left without a vector carries an explicit `_vectors.memory: null`.
 * Once the `userProvided` embedder is declared on the index (by any org with a
 * key), Meili 1.11 REJECTS the whole batch for a new document that has no
 * `_vectors.memory` ("no vectors provided for document"). Without the opt-out,
 * an embedding outage, a bad key, or an org with no key at all lost the
 * document itself, not just its vector. The null is accepted whether or not
 * the embedder exists.
 */
export async function attachVectors(
  orgId: string,
  docs: Array<Record<string, unknown>>,
): Promise<void> {
  if (docs.length === 0) return
  try {
    await attachVectorsOrLeave(orgId, docs)
  } finally {
    for (const doc of docs) {
      if (doc._vectors === undefined) doc._vectors = { [MEMORY_EMBEDDER_NAME]: null }
    }
  }
}

async function attachVectorsOrLeave(
  orgId: string,
  docs: Array<Record<string, unknown>>,
): Promise<void> {
  const embedder = await resolveOrgEmbedder(orgId)
  if (!embedder) return
  try {
    await ensureMemoryEmbedderSettings(embedder.dimensions)
    const { vectors } = await embedder.embed(
      docs.map((d) => (typeof d.title === "string" ? d.title : "")),
    )
    docs.forEach((doc, i) => {
      const vector = vectors[i]
      if (Array.isArray(vector) && vector.length === embedder.dimensions) {
        doc._vectors = { [MEMORY_EMBEDDER_NAME]: vector }
      }
    })
  } catch (err) {
    // An undeclared embedder already said so once, as memory_embedder_declare_failed.
    if (err instanceof MemoryEmbedderUndeclaredError) return
    log.warn({ err, orgId }, "Could not embed documents; indexing them keyword only")
  }
}

/**
 * A contact or company merge that moved the merged-away record's discussion
 * messages into the survivor's (contacts/discussion.ts, companies.ts): their
 * documents name the thread they were in, and the survivor's windows now quote
 * them. Every message of the survivor's discussion is re-indexed from the
 * committed rows, through the same coalescing queue as a live edit. Best
 * effort, like every message indexing (see below).
 */
async function reindexMergedDiscussion(
  orgId: string,
  entity: "contact" | "company",
  data: unknown,
): Promise<void> {
  const d = (data ?? {}) as { targetId?: unknown; discussionMoved?: unknown }
  if (d.discussionMoved !== true || typeof d.targetId !== "string") return
  // A company's discussion is an entity discussion (threads/entity-discussion.ts).
  const handle =
    entity === "contact" ? `contact-primary:${d.targetId}` : `entity:kernel:company:${d.targetId}`
  try {
    const ids = await withPrivilegedDb(orgId, `message-indexer:${entity}-merge`, async (tx) =>
      rowsOf(
        await tx.execute(
          sql`SELECT m.id::text AS id FROM ${kernelTable("messages")} m
              JOIN ${kernelTable("threads")} t ON t.id = m.thread_id AND t.org_id = m.org_id
              WHERE m.org_id = ${orgId} AND t.handle = ${handle} AND m.deleted_at IS NULL`,
        ),
      ).map((r) => String(r.id)),
    )
    for (let i = 0; i < ids.length; i += 1000) {
      await recordLiveIndex(
        ids
          .slice(i, i + 1000)
          .map((messageId) => messageLiveIndexItem({ action: "upsert", orgId, messageId })),
      )
    }
  } catch (err) {
    log.error({ err, orgId, handle }, "Could not queue re-indexing of a merged discussion")
  }
}

async function messageIndexerDurableHandler(ctx: DurableEventContext): Promise<void> {
  const { event } = ctx
  if (event.ephemeral) return
  if (
    event.app === MESSAGE_APP &&
    (event.entity === "contact" || event.entity === "company") &&
    event.action === "merge"
  ) {
    await reindexMergedDiscussion(event.orgId, event.entity, event.data)
    return
  }
  // `tickets:message` is a different entity with its own derived-reindex rule
  // in indexer.ts; only kernel thread messages are handled here.
  if (event.app !== MESSAGE_APP || event.entity !== MESSAGE_ENTITY_TYPE) return

  const action = indexActionFor(event.action)
  if (!action) return
  const data = (event.data ?? {}) as Record<string, unknown>
  const messageId = (data.id as string | undefined) ?? event.entityId
  if (!messageId) return

  try {
    await recordLiveIndex([messageLiveIndexItem({ action, orgId: event.orgId, messageId })])
  } catch (err) {
    // Indexing is best effort and must never reach the writer. This consumer
    // runs post-commit off the outbox, and `runDurableConsumers` rethrows:
    // throwing here would leave the outbox row unprocessed, so every OTHER
    // consumer of the same event (attention, websocket bookkeeping) would be
    // replayed for as long as search or Redis was unwell. The message itself
    // is already committed and delivered; only its searchability is lost, and
    // a later reindex or edit restores it.
    log.error(
      { err, orgId: event.orgId, messageId, action },
      "Could not queue message search indexing; the message itself is unaffected",
    )
  }
}

/**
 * Registers the handlers for the per-message job names. Live indexing no
 * longer enqueues them (it records into the coalescing queue); they stay so
 * jobs already queued when that shipped drain by recording their request.
 */
export function registerMessageIndexerJobWorkers(): void {
  registerJobWorker(QUEUE_APP, UPSERT_JOB, async (payload: MessageIndexerJobPayload) =>
    recordLiveIndex([messageLiveIndexItem({ ...payload, action: "upsert" })]),
  )
  registerJobWorker(QUEUE_APP, DELETE_JOB, async (payload: MessageIndexerJobPayload) =>
    recordLiveIndex([messageLiveIndexItem({ ...payload, action: "delete" })]),
  )
  registerJobWorker(QUEUE_APP, BRIEF_UPSERT_JOB, async (payload: BriefIndexerJobPayload) =>
    recordLiveIndex([briefLiveIndexItem({ ...payload, action: "upsert" })]),
  )
  registerJobWorker(QUEUE_APP, BRIEF_DELETE_JOB, async (payload: BriefIndexerJobPayload) =>
    recordLiveIndex([briefLiveIndexItem({ ...payload, action: "delete" })]),
  )
  registerLiveIndexWorkers()
  // P4c-T48's jobs are the indexer's own: the backfill that gives existing
  // documents their vectors, and the clusterer that collapses near duplicates.
  // Imported dynamically because both of them index through this module, and a
  // static import either way would be a cycle.
  void import("~/infra/jobs/embedding-backfill").then((m) => m.registerEmbeddingBackfillWorker())
  void import("~/infra/jobs/near-duplicate-clusters").then((m) => m.registerNearDuplicateWorker())
}

/**
 * Full wiring: the durable event consumer (event to job) plus the job
 * handlers. Run in the event-consuming process (the API).
 */
export function registerMessageIndexerConsumer(): void {
  registerDurableEventConsumer("search-message-indexer", messageIndexerDurableHandler)
  registerMessageIndexerJobWorkers()
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const MessageIndexerTestAccess = {
  /**
   * The test seam. Injected HERE rather than mocked at the module boundary so the
   * search path and the index path resolve the SAME embedder in a test, which is
   * the only way a "reworded query finds it" assertion means anything.
   */
  setEmbedderFactory(factory: EmbedderFactory | null): void {
    embedderFactoryOverride = factory
    embedderCache.clear()
    loggedEmbeddingLegOff.clear()
    embedderSettingsApplied.clear()
    embedderDeclareFailedAt.clear()
    embedderAbsentCheckedAt.clear()
  },
  /** Test-only: drop the memoised embedders (a settings change invalidates them). */
  resetEmbedderCache(): void {
    embedderCache.clear()
    managedRefusalLoggedAt.clear()
    loggedEmbeddingLegOff.clear()
    embedderSettingsApplied.clear()
    embedderDeclareFailedAt.clear()
    embedderAbsentCheckedAt.clear()
  },
  /** Test-only: the day total this process has accumulated for an org. */
  embeddingTokens(orgId: string, day?: string): number {
    return (
      embeddingTokensByOrgDay.get(`${orgId}:${day ?? new Date().toISOString().slice(0, 10)}`) ?? 0
    )
  },
}
