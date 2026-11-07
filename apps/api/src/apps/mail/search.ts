// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Host-side mail conversation search — the mail twin of `apps/tickets/search.ts`.
 *
 * Replaces the old in-sandbox scan (equality-only bridge `where` + an in-JS
 * post-filter over up to 2000 rows paged INTO the QuickJS heap, which timed
 * out and OOMed on large mailboxes). Here every structured predicate —
 * account/contact/status/unread/assignee equality, sender substring, date
 * range — is real SQL over `app_mail.conversations`, and free text (query +
 * body) resolves through the kernel Meili index (token-based, typo-tolerant,
 * permission-filtered) to an id-join. The page query runs on the CALLER's RLS
 * transaction, so mailbox privacy (personalScope RLS) re-checks every row the
 * index returned — a stale or mis-indexed Meili doc can never leak content.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import {
  type MailCategory,
  mailCategoryCondition,
  parseMailCategory,
} from "~/modules/mail/category"
import { resolveMailConversationMatches } from "~/modules/search/service"

type SqlClient = RlsClient | RlsTx | PrivilegedDb

function mailRel(name: string): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("app_mail")}.${name}`)
}

/** Same actor contract as TicketSearchActor — the caller's REAL scopes,
 * dimensionGrants and roleIds, never an empty-grant placeholder. */
export interface MailSearchActor {
  userId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  roleIds: string[]
}

/** Same bridge-crossing contract as TicketSearchUnavailableError: the bridge
 * catches this and RETURNS `{error:{code,message,retryable,status}}` so the
 * status/code survive the QuickJS boundary. */
export class MailSearchUnavailableError extends Error {
  readonly status = 503
  readonly code = "SEARCH_UNAVAILABLE"

  constructor(message = "Search is temporarily unavailable. Try again shortly.") {
    super(message)
    this.name = "MailSearchUnavailableError"
  }
}

/** Test-only injection seam (mirrors TicketsSearchTestAccess.setMatchResolver). */
let mailMatchResolverOverride:
  | ((args: { orgId: string; actor: MailSearchActor; q: string }) => Promise<string[]>)
  | null = null

async function resolveMatchIds(
  orgId: string,
  actor: MailSearchActor,
  q: string,
): Promise<string[]> {
  if (mailMatchResolverOverride) return mailMatchResolverOverride({ orgId, actor, q })
  return resolveMailConversationMatches({
    orgId,
    userId: actor.userId,
    scopes: actor.scopes,
    dimensionGrants: actor.dimensionGrants,
    roleIds: actor.roleIds,
    q,
  })
}

export interface MailConversationSearchParams {
  /** Free text over subject + snippet + participants + message bodies (Meili). */
  query?: string
  /** Legacy body-text param — merged into the same Meili free-text resolution
   * (message bodies are part of the indexed document body). */
  body?: string
  accountId?: string
  /** Any of these accounts. An empty list names no account, so it matches nothing. */
  accountIds?: string[]
  contactId?: string
  status?: string
  unreadOnly?: boolean
  isStarred?: boolean
  assignedTo?: string
  /** Case-insensitive substring over the sender email — SQL ILIKE. */
  from?: string
  /** ISO datetime bounds over last_message_at — SQL range predicates. */
  since?: string
  until?: string
  limit?: number
  offset?: number
  /**
   * Message ids the caller's OWN BROWSER matched against its local index over a
   * sealed mailbox (spec section 5.5). Restricts the result to conversations
   * holding at least one of them, so the client's free-text answer is
   * intersected with the structured filters and re-checked by RLS here rather
   * than trusted as a result. An empty list means the browser matched nothing,
   * which is an answer, so it narrows to no rows rather than being ignored.
   */
  messageIds?: string[]
  /**
   * Gmail's Primary / Other split (A40): `primary` = CATEGORY_PERSONAL or no
   * CATEGORY_* label, `other` = categorized without CATEGORY_PERSONAL, `all`
   * (or absent) = no filter.
   */
  category?: MailCategory
  /**
   * `personal-gmail`: the category narrows only the conversations of personal
   * Gmail mailboxes, every other mailbox stays whole. The agent's default when
   * it names no category: a shared inbox's "Updates" can be a customer.
   */
  categoryScope?: "personal-gmail"
}

export interface MailConversationSearchRow {
  id: string
  subject: string | null
  snippet: string | null
  from_email: string | null
  from_address: { name?: string | null; email?: string | null } | null
  account_id: string | null
  account_email: string | null
  contact_id: string | null
  assigned_to: string | null
  status: string | null
  is_read: boolean
  is_starred: boolean
  last_message_at: string | null
  message_count: number | null
  /** The newest message the other side sent: our own outbound never moves it. */
  last_inbound_at: string | null
}

export interface MailConversationSearchResult {
  items: MailConversationSearchRow[]
  totalCount: number
  nextOffset: number | null
  /** True when free text ran on the SQL ILIKE fallback (Meili unavailable). */
  degraded?: boolean
}

/** Escape LIKE metacharacters in a user-supplied substring needle. */
function escapeLike(needle: string): string {
  return needle.replace(/[\\%_]/g, (c) => `\\${c}`)
}

// Bound on how many Meili-resolved ids we inline into the id-join. Ranked
// order means the cut keeps the most relevant matches; date-ordered paging
// over >2000 text matches is not a real workflow.
const MATCH_ID_JOIN_CAP = 2000

/** Cheap shape guard before a `::uuid` cast that would otherwise throw. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function searchMailConversations(
  tx: SqlClient,
  orgId: string,
  params: MailConversationSearchParams,
  actor: MailSearchActor,
): Promise<MailConversationSearchResult> {
  const limit = Math.min(Math.max(params.limit ?? 20, 1), 50)
  const offset = Math.max(params.offset ?? 0, 0)

  for (const [field, v] of [
    ["since", params.since],
    ["until", params.until],
  ] as const) {
    if (v !== undefined && Number.isNaN(Date.parse(v))) {
      throw new Error(`${field} is not a valid ISO date`)
    }
  }

  const C = mailRel("conversations")
  const conditions = [drizzleSql`${C}.org_id = ${orgId}`]
  if (params.accountId) conditions.push(drizzleSql`${C}.account_id = ${params.accountId}::uuid`)
  if (params.accountIds) {
    const ids = params.accountIds.filter((id) => UUID_SHAPE.test(id))
    conditions.push(
      ids.length === 0
        ? drizzleSql`false`
        : drizzleSql`${C}.account_id IN (${drizzleSql.join(
            ids.map((id) => drizzleSql`${id}::uuid`),
            drizzleSql`, `,
          )})`,
    )
  }
  if (params.contactId) conditions.push(drizzleSql`${C}.contact_id = ${params.contactId}::uuid`)
  if (params.status) conditions.push(drizzleSql`${C}.status = ${params.status}`)
  if (params.unreadOnly) conditions.push(drizzleSql`${C}.is_read = false`)
  if (params.isStarred !== undefined)
    conditions.push(drizzleSql`${C}.is_starred = ${params.isStarred}`)
  if (params.assignedTo) conditions.push(drizzleSql`${C}.assigned_to = ${params.assignedTo}::uuid`)
  if (params.from?.trim()) {
    const needle = `%${escapeLike(params.from.trim())}%`
    conditions.push(drizzleSql`${C}.from_email ILIKE ${needle} ESCAPE '\\'`)
  }
  if (params.messageIds) {
    const M = mailRel("messages")
    // Uuid-shaped only: anything else cannot name a row and would only make the
    // `::uuid` cast throw.
    const ids = params.messageIds.filter((id) => UUID_SHAPE.test(id)).slice(0, MATCH_ID_JOIN_CAP)
    conditions.push(
      ids.length === 0
        ? drizzleSql`false`
        : drizzleSql`EXISTS (
            SELECT 1 FROM ${M}
            WHERE ${M}.conversation_id = ${C}.id
              AND ${M}.org_id = ${orgId}
              AND ${M}.id IN (${drizzleSql.join(
                ids.map((id) => drizzleSql`${id}::uuid`),
                drizzleSql`, `,
              )})
          )`,
    )
  }
  const categoryCondition = mailCategoryCondition(
    drizzleSql`${C}.labels`,
    parseMailCategory(params.category),
  )
  if (categoryCondition) {
    if (params.categoryScope === "personal-gmail") {
      const A = mailRel("accounts")
      conditions.push(drizzleSql`(${categoryCondition} OR NOT EXISTS (
        SELECT 1 FROM ${A}
        WHERE ${A}.id = ${C}.account_id AND ${A}.owner_type = 'user' AND ${A}.provider = 'gmail'
      ))`)
    } else {
      conditions.push(categoryCondition)
    }
  }
  if (params.since)
    conditions.push(drizzleSql`${C}.last_message_at >= ${params.since}::timestamptz`)
  if (params.until)
    conditions.push(drizzleSql`${C}.last_message_at <= ${params.until}::timestamptz`)

  // Free text: UNION semantics. The DB is ground truth for exact substring
  // matches (subject/snippet/sender/message text via ILIKE — zero indexing
  // lag, works before the Meili backfill and during a Meili outage), and the
  // Meili id set widens it with token-based, typo-tolerant, participant- and
  // enrichment-aware matches (permission-filtered per actor). A just-synced
  // conversation is therefore searchable IMMEDIATELY even though its index
  // upsert is still queued. `degraded: true` flags a run where Meili could
  // not be consulted at all.
  let degraded = false
  const rawQuery = [params.query?.trim(), params.body?.trim()].filter(Boolean).join(" ")
  if (rawQuery.length > 0) {
    let matchedIds: string[] = []
    try {
      matchedIds = await resolveMatchIds(orgId, actor, rawQuery)
    } catch {
      degraded = true
    }
    const bounded = matchedIds.slice(0, MATCH_ID_JOIN_CAP)
    const needle = `%${escapeLike(rawQuery)}%`
    // Cheap single-table substring branch — always on (12k rows scan in ms).
    let likeClause = drizzleSql`
      ${C}.subject ILIKE ${needle} ESCAPE '\\'
      OR ${C}.snippet ILIKE ${needle} ESCAPE '\\'
      OR ${C}.from_email ILIKE ${needle} ESCAPE '\\'`
    // The correlated EXISTS over message text is a full untrigrammed text scan
    // of app_mail.messages — on a real mailbox it alone blew the 5s tool
    // budget when included unconditionally (prod, 2026-07-24). Message-text
    // matching is Meili's job on the healthy path (the enrichment body carries
    // it), so the SQL scan runs ONLY when it is the last resort: Meili down
    // (degraded), or an explicit `body` search (bounded, deliberate ask that
    // must also catch not-yet-indexed rows).
    if (degraded || params.body?.trim()) {
      const M = mailRel("messages")
      likeClause = drizzleSql`${likeClause}
      OR EXISTS (
        SELECT 1 FROM ${M}
        WHERE ${M}.conversation_id = ${C}.id
          AND ${M}.org_id = ${orgId}
          AND ${M}.text_body ILIKE ${needle} ESCAPE '\\'
      )`
    }
    conditions.push(
      bounded.length > 0
        ? drizzleSql`(${likeClause} OR ${C}.id IN (${drizzleSql.join(
            bounded.map((id) => drizzleSql`${id}::uuid`),
            drizzleSql`, `,
          )}))`
        : drizzleSql`(${likeClause})`,
    )
  }

  const whereClause = drizzleSql.join(conditions, drizzleSql.raw(" AND "))

  try {
    return await runPageAndCount(tx, whereClause, limit, offset, degraded)
  } catch (err) {
    // Drizzle wraps the Postgres error as `cause`; surface it — "Failed query"
    // alone is undebuggable from the tool-error envelope.
    const cause = (err as { cause?: { message?: string } }).cause
    if (cause?.message) {
      throw new Error(`mail search query failed: ${cause.message}`, { cause: err })
    }
    throw err
  }
}

async function runPageAndCount(
  tx: SqlClient,
  whereClause: ReturnType<typeof drizzleSql.join>,
  limit: number,
  offset: number,
  degraded: boolean,
): Promise<MailConversationSearchResult> {
  const C = mailRel("conversations")
  const M = mailRel("messages")
  const A = mailRel("accounts")
  // ONE scan for page + exact total: under RLS every row visit pays the
  // policy subplan, and a separate COUNT(*) doubled that cost — on the real
  // prod mailbox (31k conversations) the two scans together blew the 5s tool
  // budget. The COUNT(*) OVER() window computes the exact total on the same
  // scan the page comes from. The inner query is filter+page only; the
  // account/last-message joins run on the ≤limit page rows, never the scan.
  const pageRows = await tx
    .execute(
      drizzleSql`
        SELECT p.id, p.subject, p.snippet, p.from_email, lm.from_address,
               p.account_id, ${A}.email_address AS account_email,
               p.contact_id, p.assigned_to, p.status,
               p.is_read, p.is_starred, p.last_message_at, p.message_count,
               li.last_inbound_at, p.__total
        FROM (
          SELECT ${C}.*, COUNT(*) OVER()::int AS __total
          FROM ${C}
          WHERE ${whereClause}
          ORDER BY ${C}.last_message_at DESC NULLS LAST, ${C}.id DESC
          LIMIT ${limit} OFFSET ${offset}
        ) p
        LEFT JOIN ${A} ON ${A}.id = p.account_id
        LEFT JOIN LATERAL (
          SELECT ${M}.from_address FROM ${M}
          WHERE ${M}.conversation_id = p.id
          ORDER BY ${M}.sent_at DESC NULLS LAST
          LIMIT 1
        ) lm ON true
        LEFT JOIN LATERAL (
          SELECT max(${M}.sent_at) AS last_inbound_at FROM ${M}
          WHERE ${M}.conversation_id = p.id AND ${M}.direction = 'inbound'
        ) li ON true
        ORDER BY p.last_message_at DESC NULLS LAST, p.id DESC
      `,
    )
    .then((r) => extractRows<MailConversationSearchRow & { __total: number }>(r))

  // Page rows carry the exact total; an empty page past the end falls back to
  // one cheap COUNT (rare — only when a caller pages beyond the last row).
  let totalCount: number
  if (pageRows.length > 0) {
    totalCount = pageRows[0].__total
  } else if (offset === 0) {
    totalCount = 0
  } else {
    totalCount = await tx
      .execute(drizzleSql`SELECT COUNT(*)::int AS total FROM ${C} WHERE ${whereClause}`)
      .then((r) => extractRows<{ total: number }>(r)[0]?.total ?? 0)
  }

  const items = pageRows.map(({ __total, ...row }) => row)
  const nextOffset = offset + items.length < totalCount ? offset + items.length : null
  return { items, totalCount, nextOffset, degraded }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const MailSearchTestAccess = {
  setMatchResolver(resolver: typeof mailMatchResolverOverride): void {
    mailMatchResolverOverride = resolver
  },
}
