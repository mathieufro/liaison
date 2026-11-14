// SPDX-License-Identifier: FSL-1.1-ALv2

import { displayTicketHandle, imapSyncSummary, type TicketIdSegment } from "@liaison/shared"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import mailManifest from "~/apps/mail/app.manifest.json"
import { loadSegmentConfig } from "~/apps/tickets/display-handle"
import type { PrivilegedDb, RlsClient } from "~/db"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { contacts } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { ConnectionCredentialsMissingError } from "~/modules/apps/connections/credentials-missing"
import { NoConnectedAccountError } from "~/modules/apps/connections/no-connected-account"
import { CORE_APP_MODULES } from "~/modules/apps/core/registry"
import { resolveSandboxMaxToolTimeoutMs } from "~/modules/apps/run-limits"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { type MailCategory, mailCategoryCondition } from "~/modules/mail/category"
import {
  type CommercialSend,
  recordCommercialSendAfterSend,
} from "~/modules/mail/commercial-send-record"
import { enqueueGmailWriteBack } from "~/modules/mail/gmail-write-back"
import { markConversationReadThrough } from "~/modules/mail/page-write"
import {
  COMMERCIAL_IDENTITY_MISSING_MESSAGE,
  checkPersonCompose,
  commercialFooterFor,
  recipientsOf,
} from "~/modules/mail/send-guard"
import { resolveSenderContacts } from "~/modules/mail/sender-contacts"
import {
  isMailAccountSuppressed,
  stripMailContentFromPayload,
} from "~/modules/mailbox-crypto/content-suppression"
import {
  applyMailSealToRow,
  assertMailboxWritable,
  assertSealRecipient,
  mailboxRequiresSealing,
  pointConversationAtMessage,
  resolveMailAccountCrypto,
} from "~/modules/mailbox-crypto/mail-writer"
import { openManagedMailRowsByAccount } from "~/modules/mailbox-crypto/managed-open"
import { hasScope } from "~/modules/permissions/permissions"

const K = () => drizzleSql.raw(schemaRef("kernel"))

const mailSchema = schemaRef("app_mail")
const ticketsSchema = schemaRef("app_tickets")
const kernelSchema = schemaRef("kernel")
const convTable = () => drizzleSql.raw(`${quoteIdent(mailSchema)}.conversations`)
const msgTable = () => drizzleSql.raw(`${quoteIdent(mailSchema)}.messages`)
const accTable = () => drizzleSql.raw(`${quoteIdent(mailSchema)}.accounts`)
const ticketTable = () => drizzleSql.raw(`${quoteIdent(ticketsSchema)}.tickets`)
const usersTable = () => drizzleSql.raw(`${quoteIdent(kernelSchema)}.users`)
const threadMessagesTable = () => drizzleSql.raw(`${quoteIdent(kernelSchema)}.messages`)

function normalizeSenderDomain(senderDomain: string): string {
  return senderDomain.trim().toLowerCase()
}

function getAllowedImageSenderDomains(metadata: unknown, userId: string): string[] {
  const domains = (metadata as any)?.mailImageSenderDomainsByUser?.[userId]
  if (!Array.isArray(domains)) return []
  return domains
    .filter((value): value is string => typeof value === "string")
    .map((value) => normalizeSenderDomain(value))
    .filter(Boolean)
}

function setAllowedImageSenderDomains(metadata: unknown, userId: string, domains: string[]) {
  const nextMetadata =
    typeof metadata === "object" && metadata !== null
      ? { ...(metadata as Record<string, unknown>) }
      : {}
  const byUser =
    typeof nextMetadata.mailImageSenderDomainsByUser === "object" &&
    nextMetadata.mailImageSenderDomainsByUser !== null
      ? { ...(nextMetadata.mailImageSenderDomainsByUser as Record<string, unknown>) }
      : {}

  byUser[userId] = domains
  nextMetadata.mailImageSenderDomainsByUser = byUser

  return nextMetadata
}

function parseJsonField(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonField(value)
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

function parseJsonArray(value: unknown): unknown[] {
  const parsed = parseJsonField(value)
  return Array.isArray(parsed) ? parsed : []
}

async function loadDiscussionMarkers(db: RlsClient, threadId: string | null) {
  if (!threadId) return []
  const rows = extractRows<{
    id: string
    author_id: string
    author_name: string | null
    content: string
    metadata: any
    created_at: string
  }>(
    await db.execute(drizzleSql`
      SELECT m.id, m.author_id, u.name AS author_name, m.content, m.metadata, m.created_at
      FROM ${threadMessagesTable()} m
      LEFT JOIN ${usersTable()} u ON u.id = m.author_id AND u.org_id = m.org_id
      WHERE m.thread_id = ${threadId}
        AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC
      LIMIT 50
    `),
  )
  return rows.map((row) => {
    const metadata = parseJsonObject(row.metadata)
    return {
      id: `discussion-${row.id}`,
      threadMessageId: row.id,
      anchorMessageId:
        typeof metadata?.anchorMessageId === "string"
          ? metadata.anchorMessageId
          : typeof metadata?.mailAnchorMessageId === "string"
            ? metadata.mailAnchorMessageId
            : null,
      author: { id: row.author_id, name: row.author_name ?? "Teammate" },
      excerpt: row.content.length > 180 ? `${row.content.slice(0, 177)}...` : row.content,
      createdAt: row.created_at,
      markerKind: typeof metadata?.markerKind === "string" ? metadata.markerKind : "note",
    }
  })
}

/**
 * Server-managed mailboxes (`enc_version = 2`): the server opens the rows for
 * their owner and the projection carries plaintext, exactly like an unsealed
 * row, so the browser needs no key and no unlock. The ciphertext and key
 * columns are dropped and `enc_version` reads 0 on the wire, which every web
 * client (old ones included) renders as a plain row. A row the reader may not
 * open (not the owner) keeps its ciphertext and stays unreadable.
 *
 * Only for the person's own reads. Never call this on a projection that feeds
 * an event, the timeline or the search index.
 */
const MANAGED_PLAINTEXT_COLUMNS: Record<
  "messages" | "conversations" | "drafts",
  Record<string, string>
> = {
  messages: {
    subject: "subject",
    textBody: "text_body",
    htmlBody: "html_body",
    snippet: "snippet",
  },
  conversations: { subject: "subject", snippet: "snippet" },
  drafts: { subject: "subject", body: "text_body", htmlBody: "html_body" },
}
const MANAGED_SEALED_COLUMNS = [
  "subject_ciphertext",
  "text_body_ciphertext",
  "html_body_ciphertext",
  "snippet_ciphertext",
  "raw_headers_ciphertext",
  "body_ciphertext",
  "content_key_wrapped",
  "content_key_epk",
]

async function revealManagedRows(
  rows: any[],
  entity: "messages" | "conversations" | "drafts",
  orgId: string,
  userId: string,
): Promise<void> {
  if (!rows.some((r) => Number(r?.enc_version ?? 0) === 2)) return
  const opened = await openManagedMailRowsByAccount({
    orgId,
    entity,
    rows,
    actor: { userId },
    purpose: { kind: "web_view" },
  })
  for (const row of rows) {
    const fields = opened.get(row.id)
    if (!fields) continue
    for (const [field, col] of Object.entries(MANAGED_PLAINTEXT_COLUMNS[entity])) {
      row[col] = fields[field] ?? null
    }
    for (const col of MANAGED_SEALED_COLUMNS) if (col in row) row[col] = null
    row.enc_key_id = null
    row.enc_version = 0
  }
}

/** bytea column -> base64 on the wire, or null. The browser opens it; the
 *  server holds no key that could. */
function sealedColumn(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return Buffer.from(value as Uint8Array).toString("base64")
}

function projectMailMessage(message: any) {
  return {
    id: message.id,
    conversationId: message.conversation_id,
    accountId: message.account_id,
    externalMessageId: message.external_message_id,
    externalProviderId: message.external_provider_id,
    inReplyTo: message.in_reply_to,
    messageReferences: message.message_references,
    fromAddress: parseJsonObject(message.from_address),
    toAddresses: parseJsonArray(message.to_addresses),
    ccAddresses: parseJsonArray(message.cc_addresses),
    bccAddresses: parseJsonArray(message.bcc_addresses),
    subject: message.subject,
    textBody: message.text_body,
    htmlBody: message.html_body,
    snippet: message.snippet,
    // The sealed half, shaped exactly as `SealedMessagePayload` declares it.
    // On a personal mailbox the plaintext columns above are NULL by construction,
    // so without these the reader renders an empty message and never calls
    // `openSealedMessage`. `encVersion` is what tells the client which of the
    // two representations is the real one.
    subjectCiphertext: sealedColumn(message.subject_ciphertext),
    textBodyCiphertext: sealedColumn(message.text_body_ciphertext),
    htmlBodyCiphertext: sealedColumn(message.html_body_ciphertext),
    snippetCiphertext: sealedColumn(message.snippet_ciphertext),
    rawHeadersCiphertext: sealedColumn(message.raw_headers_ciphertext),
    contentKeyWrapped: sealedColumn(message.content_key_wrapped),
    contentKeyEpk: sealedColumn(message.content_key_epk),
    encKeyId: message.enc_key_id ?? null,
    encVersion: message.enc_version ?? 0,
    direction: message.direction,
    sentAt: message.sent_at,
    isRead: message.is_read,
    isStarred: message.is_starred,
    labels: message.labels,
    sentByUser: message.sent_by_user_actual_id
      ? {
          id: message.sent_by_user_actual_id,
          name: message.sent_by_user_name,
          avatarUrl: message.sent_by_user_avatar_url,
        }
      : null,
  }
}

async function getMessageProjection(
  db: RlsClient | PrivilegedDb,
  orgId: string,
  messageId: string,
) {
  const rows = extractRows<any>(
    await db.execute(drizzleSql`
      SELECT
        message.*,
        sent_user.id AS sent_by_user_actual_id,
        sent_user.name AS sent_by_user_name,
        sent_user.avatar_url AS sent_by_user_avatar_url
      FROM ${msgTable()} AS message
      LEFT JOIN ${usersTable()} AS sent_user
        ON sent_user.id = message.sent_by_user_id
        AND sent_user.org_id = message.org_id
      WHERE message.id = ${messageId} AND message.org_id = ${orgId}
      LIMIT 1
    `),
  )
  return rows[0] ? projectMailMessage(rows[0]) : null
}

function dimensionGrantAllows(value: unknown, accountId: string): boolean {
  return Array.isArray(value) && (value.includes(accountId) || value.includes("*"))
}

function mailInboxGrantExistsSql(orgId: string, userRef: unknown, accountId: string) {
  return drizzleSql`(
    EXISTS (
      SELECT 1
      FROM ${drizzleSql.raw(`${quoteIdent(kernelSchema)}.user_dimension_grants`)} g
      WHERE g.org_id = ${orgId}
        AND g.user_id = ${userRef}
        AND g.dimension_key = 'mail:inbox'
        AND (g.dimension_values @> ${JSON.stringify([accountId])}::jsonb OR g.dimension_values @> ${JSON.stringify(["*"])}::jsonb)
    )
    OR EXISTS (
      SELECT 1
      FROM ${drizzleSql.raw(`${quoteIdent(kernelSchema)}.user_roles`)} ur
      JOIN ${drizzleSql.raw(`${quoteIdent(kernelSchema)}.role_dimension_grants`)} rdg ON rdg.role_id = ur.role_id
      WHERE ur.org_id = ${orgId}
        AND ur.user_id = ${userRef}
        AND rdg.dimension_key = 'mail:inbox'
        AND (rdg.dimension_values @> ${JSON.stringify([accountId])}::jsonb OR rdg.dimension_values @> ${JSON.stringify(["*"])}::jsonb)
    )
  )`
}

/**
 * Queue a mail event, with Invariant K applied at the emit.
 *
 * For an encrypted personal mailbox the payload keeps ids, envelope and state
 * fields and loses every content field. That has to happen HERE rather than in
 * each caller: `getMessageProjection` returns the whole projected message, so a
 * caller that forgot would publish the subject and body into
 * `kernel.pending_events`, `kernel.audit_log.changes` and a timeline entry, none
 * of which the Phase 12 purge can reach.
 *
 * Today those columns are already NULL for a sealed row, so this is also the
 * guard that keeps a future projection widening (or the Phase 12 dual-read
 * window, where the plaintext column still exists) from reopening the hole.
 */
async function queueMailEvent(
  db: Pick<RlsClient, "queueEvent" | "execute">,
  params: {
    orgId: string
    userId: string
    entity: string
    action: string
    entityId: string
    data: Record<string, unknown>
  },
) {
  const accountId =
    typeof params.data.accountId === "string"
      ? params.data.accountId
      : typeof params.data.account_id === "string"
        ? params.data.account_id
        : null
  const data =
    accountId && (await isMailAccountSuppressed(db, params.orgId, accountId))
      ? stripMailContentFromPayload(params.data)
      : params.data
  await db.queueEvent({
    app: "mail",
    entity: params.entity,
    action: params.action,
    entityId: params.entityId,
    orgId: params.orgId,
    actorId: params.userId,
    actorType: "user",
    timestamp: new Date().toISOString(),
    data,
  })
}

async function userHasMailInboxGrant(
  db: RlsClient,
  orgId: string,
  userId: string,
  accountId: string,
): Promise<boolean> {
  const [context] = extractRows<{ current_user_id: string | null; current_dimensions: unknown }>(
    await db.execute(drizzleSql`
    SELECT
      nullif(rls_ctx.user_id(), '') AS current_user_id,
      nullif(rls_ctx.dimensions(), '')::jsonb AS current_dimensions
  `),
  )
  const currentDimensions = parseJsonObject(context?.current_dimensions)
  if (
    context?.current_user_id === userId &&
    dimensionGrantAllows(currentDimensions?.["mail:inbox"], accountId)
  ) {
    return true
  }

  return withPrivilegedDb(orgId, "mail-inbox-grant-check", async (tx) => {
    const [row] = extractRows<{ exists: boolean }>(
      await tx.execute(drizzleSql`
      SELECT ${mailInboxGrantExistsSql(orgId, drizzleSql`${userId}`, accountId)} AS "exists"
    `),
    )
    return row?.exists === true
  })
}

interface ListConversationsParams {
  orgId: string
  userId: string
  accountId?: string
  /** "personal": only the requesting user's own mailboxes. */
  ownership?: "personal"
  status?: string
  isRead?: boolean
  isStarred?: boolean
  assignedTo?: string
  contactId?: string
  /**
   * Restrict the page to these conversations. The live list uses it to fetch
   * the rows a realtime event named: a sealed mailbox's event carries no
   * content, so the row has to come from this projection to be opened.
   */
  ids?: string[]
  /** Gmail Primary / Other (A40); absent or `all` does not narrow. */
  category?: MailCategory
  cursor?: string
  limit: number
}

// The escalated ticket is named by its DISPLAY handle (`ticket-B2B-12`),
// computed from its current segment field, like every ticket surface.
const ESCALATED_SEGMENT_COLUMNS =
  drizzleSql.raw(`escalated_ticket.audience AS escalated_ticket_audience,
      escalated_ticket.team AS escalated_ticket_team,
      escalated_ticket.category_id::text AS escalated_ticket_category_id,
      escalated_ticket.source_inbox_id::text AS escalated_ticket_source_inbox_id`)

function escalatedDisplayHandle(row: any, segment: TicketIdSegment | null): string | null {
  const stored = row.escalated_ticket_handle as string | null | undefined
  if (!stored) return null
  if (!segment) return stored
  return displayTicketHandle(
    stored,
    {
      audience: row.escalated_ticket_audience,
      team: row.escalated_ticket_team,
      categoryId: row.escalated_ticket_category_id,
      sourceInboxId: row.escalated_ticket_source_inbox_id,
    },
    segment,
  )
}

export async function listConversations(db: RlsClient, params: ListConversationsParams) {
  const { orgId, limit } = params
  const status = params.status ?? "open"

  let where = drizzleSql`conversation.org_id = ${orgId} AND conversation.status = ${status}`
  if (params.accountId)
    where = drizzleSql`${where} AND conversation.account_id = ${params.accountId}`
  if (params.ownership === "personal")
    where = drizzleSql`${where} AND conversation.account_id IN (
      SELECT id FROM ${accTable()}
      WHERE org_id = ${orgId} AND owner_type = 'user' AND owner_id = ${params.userId}
    )`
  if (params.isRead !== undefined)
    where = drizzleSql`${where} AND conversation.is_read = ${params.isRead}`
  if (params.isStarred !== undefined)
    where = drizzleSql`${where} AND conversation.is_starred = ${params.isStarred}`
  if (params.assignedTo) {
    const assignedId = params.assignedTo === "me" ? params.userId : params.assignedTo
    where = drizzleSql`${where} AND conversation.assigned_to = ${assignedId}`
  }
  if (params.contactId)
    where = drizzleSql`${where} AND conversation.contact_id = ${params.contactId}`
  const categoryCondition = mailCategoryCondition(drizzleSql`conversation.labels`, params.category)
  if (categoryCondition) where = drizzleSql`${where} AND ${categoryCondition}`
  if (params.ids && params.ids.length > 0)
    where = drizzleSql`${where} AND conversation.id IN (${drizzleSql.join(
      params.ids.map((id) => drizzleSql`${id}`),
      drizzleSql`, `,
    )})`
  // D1/D2 mail perf: `COUNT(*) OVER()` re-scans the WHOLE matching set on
  // EVERY page (a windowed scan inside the same query as the join-heavy page
  // read). `countWhere` captures the predicate BEFORE the cursor clause is
  // appended, so the count always reflects the TOTAL matching the filters —
  // not "remaining after the cursor" — on every page, first or not. The count
  // still runs as a separate, cheap, non-windowed `COUNT(*)` query (no join to
  // latest_message/escalated_ticket) executed concurrently with the page
  // query via Promise.all below, so a page still costs exactly two queries
  // instead of one windowed one, keeping `meta.total` accurate on cursor pages
  // too (mirrors tickets D1's countOnly/runCount pattern).
  const countWhere = where
  if (params.cursor)
    where = drizzleSql`${where} AND conversation.last_message_at < ${params.cursor}`

  const runPage = () =>
    db
      .execute(drizzleSql`
    SELECT
      conversation.*,
      latest_message.from_address AS latest_from_address,
      escalated_ticket.handle AS escalated_ticket_handle,
      escalated_ticket.status AS escalated_ticket_status,
      ${ESCALATED_SEGMENT_COLUMNS}
    FROM ${convTable()} AS conversation
    LEFT JOIN LATERAL (
      SELECT from_address
      FROM ${msgTable()} AS message
      WHERE message.conversation_id = conversation.id
        AND message.org_id = conversation.org_id
      ORDER BY
        CASE WHEN message.direction = 'inbound' THEN 0 ELSE 1 END,
        message.sent_at DESC NULLS LAST,
        message.created_at DESC
      LIMIT 1
    ) AS latest_message ON true
    LEFT JOIN ${ticketTable()} AS escalated_ticket
      ON escalated_ticket.id = conversation.escalated_ticket_id
      AND escalated_ticket.org_id = conversation.org_id
    WHERE ${where}
    ORDER BY conversation.last_message_at DESC
    LIMIT ${limit}
  `)
      .then((result) => extractRows<any>(result))

  const runCount = () =>
    db
      .execute(
        drizzleSql`SELECT COUNT(*)::int AS total FROM ${convTable()} AS conversation WHERE ${countWhere}`,
      )
      .then((result) => extractRows<{ total: number }>(result)[0]?.total ?? 0)

  const [rows, total] = await Promise.all([runPage(), runCount()])
  await revealManagedRows(rows, "conversations", orgId, params.userId)
  const segment = rows.some((r: any) => r.escalated_ticket_handle)
    ? await loadSegmentConfig(params.orgId)
    : null

  const data = rows.map((rest: any) => {
    const latestFromAddress = parseJsonObject(rest.latest_from_address)

    return {
      id: rest.id,
      accountId: rest.account_id,
      subject: rest.subject,
      snippet: rest.snippet,
      // The inbox list reads a sealed mailbox too: without the envelope every
      // row in it would render as an untitled conversation with no preview.
      subjectCiphertext: sealedColumn(rest.subject_ciphertext),
      snippetCiphertext: sealedColumn(rest.snippet_ciphertext),
      contentKeyWrapped: sealedColumn(rest.content_key_wrapped),
      contentKeyEpk: sealedColumn(rest.content_key_epk),
      encKeyId: rest.enc_key_id ?? null,
      encVersion: rest.enc_version ?? 0,
      // Set when the sealed fields are a COPY of that message's ciphertext, so
      // the browser opens them under the message's AAD, not a conversation one.
      snippetSourceMessageId: rest.snippet_source_message_id ?? null,
      contactId: rest.contact_id,
      assignedTo: rest.assigned_to,
      status: rest.status,
      labels: rest.labels,
      isRead: rest.is_read,
      isStarred: rest.is_starred,
      internalThreadId: rest.internal_thread_id ?? null,
      lastMessageAt: rest.last_message_at,
      messageCount: rest.message_count,
      senderName: typeof latestFromAddress?.name === "string" ? latestFromAddress.name : null,
      senderEmail: typeof latestFromAddress?.email === "string" ? latestFromAddress.email : null,
      escalatedTicketId: rest.escalated_ticket_id ?? null,
      escalatedTicketHandle: escalatedDisplayHandle(rest, segment),
      escalatedTicketStatus: rest.escalated_ticket_status ?? null,
    }
  })

  const lastRow = data[data.length - 1]
  const nextCursor = data.length === limit ? lastRow?.lastMessageAt : null
  return { data, meta: { nextCursor, total } }
}

export async function getConversation(
  db: RlsClient,
  params: {
    orgId: string
    userId: string
    conversationId: string
    messageCursor?: string
    messageLimit?: number
  },
) {
  const { orgId, conversationId } = params
  const messageLimit = Math.min(params.messageLimit ?? 20, 50)

  const convRows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT conversation.*, escalated_ticket.handle AS escalated_ticket_handle,
           escalated_ticket.status AS escalated_ticket_status,
           ${ESCALATED_SEGMENT_COLUMNS}
    FROM ${convTable()} AS conversation
    LEFT JOIN ${ticketTable()} AS escalated_ticket
      ON escalated_ticket.id = conversation.escalated_ticket_id
      AND escalated_ticket.org_id = conversation.org_id
    WHERE conversation.id = ${conversationId} AND conversation.org_id = ${orgId}
    LIMIT 1
  `),
  )
  if (convRows.length === 0) return null
  const conv = convRows[0]
  await revealManagedRows([conv], "conversations", orgId, params.userId)

  let isRead = Boolean(conv.is_read)
  if (!isRead) {
    const flipped = await withPrivilegedDb(orgId, "mail-auto-mark-read", async (tx) => {
      const rows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          UPDATE ${convTable()} SET is_read = true, updated_at = now()
          WHERE id = ${conversationId} AND org_id = ${orgId} AND is_read = false
          RETURNING id
        `),
      )
      if (rows.length === 0) return false
      await tx.execute(drizzleSql`
        UPDATE ${msgTable()} SET is_read = true, updated_at = now()
        WHERE conversation_id = ${conversationId} AND org_id = ${orgId} AND is_read = false
      `)
      return true
    })
    // Zero rows flipped means a concurrent open of this conversation (the web
    // client fires two page loads at once) committed the same UPDATE between
    // our SELECT and ours. The row is read either way; answering with the
    // stale unread snapshot would put the unread dot back in the list.
    isRead = true
    if (flipped) {
      // The privileged write above has committed: opening a conversation
      // reads it in Gmail too.
      await enqueueGmailWriteBack({
        orgId,
        accountId: String(conv.account_id),
        conversationIds: [conversationId],
        changes: { isRead: true },
      })
      await queueMailEvent(db, {
        orgId,
        userId: params.userId,
        entity: "conversation",
        action: "update",
        entityId: conversationId,
        data: { id: conversationId, accountId: conv.account_id, isRead: true },
      })
    }
  }

  let msgWhere = drizzleSql`message.conversation_id = ${conversationId} AND message.org_id = ${orgId}`
  if (params.messageCursor)
    msgWhere = drizzleSql`${msgWhere} AND message.sent_at < ${params.messageCursor}`

  const msgRows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT
      message.*,
      sent_user.id AS sent_by_user_actual_id,
      sent_user.name AS sent_by_user_name,
      sent_user.avatar_url AS sent_by_user_avatar_url
    FROM ${msgTable()} AS message
    LEFT JOIN ${usersTable()} AS sent_user
      ON sent_user.id = message.sent_by_user_id
      AND sent_user.org_id = message.org_id
    WHERE ${msgWhere}
    ORDER BY message.sent_at DESC
    LIMIT ${messageLimit}
  `),
  )

  const [contact] = conv.contact_id
    ? await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, conv.contact_id), eq(contacts.orgId, orgId)))
        .limit(1)
    : [null]

  // Reverse to ASC order for display (query fetches newest-first for correct cursor pagination)
  msgRows.reverse()
  await revealManagedRows(msgRows, "messages", orgId, params.userId)

  const messages = msgRows.map(projectMailMessage)

  // Attachments parented to `mail:message` for the returned ids — batched in
  // one query, grouped by message id. CIDs in HTML bodies are rewritten to
  // `/api/files/:id/inline` so inline images render through the authenticated
  // route instead of the original `cid:` URI.
  const msgIds = messages.map((m) => m.id)
  if (msgIds.length > 0) {
    const { schemaRef } = await import("~/db/schema-ref")
    const KS = drizzleSql.raw(schemaRef("kernel"))
    const attRows = extractRows<{
      id: string
      entity_id: string
      filename: string
      mime_type: string
      size_bytes: number | string
      disposition: "inline" | "attachment"
      content_id: string | null
      ordinal: number
      thumbnail_key: string | null
    }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id, entity_id, filename, mime_type, size_bytes,
               disposition, content_id, ordinal, thumbnail_key
        FROM ${KS}.files
        WHERE app = 'mail' AND entity_type = 'message'
          AND entity_id IN (${drizzleSql.join(
            msgIds.map((id) => drizzleSql`${id}`),
            drizzleSql`, `,
          )})
        ORDER BY ordinal ASC, id ASC
      `),
    )
    const byMessage = new Map<
      string,
      Array<{
        id: string
        filename: string
        mimeType: string
        sizeBytes: number
        disposition: "inline" | "attachment"
        contentId: string | null
        ordinal: number
      }>
    >()
    for (const r of attRows) {
      const list = byMessage.get(r.entity_id) ?? []
      list.push({
        id: r.id,
        filename: r.filename,
        mimeType: r.mime_type,
        sizeBytes: Number(r.size_bytes),
        disposition: r.disposition,
        contentId: r.content_id,
        ordinal: r.ordinal,
      })
      byMessage.set(r.entity_id, list)
    }
    for (const m of messages as Array<Record<string, unknown>>) {
      const list = byMessage.get(m.id as string) ?? []
      m.attachments = list
      if (m.htmlBody && list.length > 0) {
        let html = m.htmlBody as string
        for (const att of list) {
          if (att.disposition !== "inline" || !att.contentId) continue
          const escaped = att.contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          html = html.replace(new RegExp(`cid:${escaped}`, "gi"), `/api/files/${att.id}/inline`)
        }
        m.htmlBody = html
      }
    }
  }

  const oldestInBatch = messages[0]
  const nextMessageCursor = messages.length === messageLimit ? oldestInBatch?.sentAt : null

  const discussionMarkers = await loadDiscussionMarkers(db, conv.internal_thread_id ?? null)

  return {
    conversation: {
      id: conv.id,
      accountId: conv.account_id,
      subject: conv.subject,
      snippet: conv.snippet,
      // Same reason as the message projection: on a sealed mailbox the two
      // fields above are NULL and the header is unreadable without these.
      subjectCiphertext: sealedColumn(conv.subject_ciphertext),
      snippetCiphertext: sealedColumn(conv.snippet_ciphertext),
      contentKeyWrapped: sealedColumn(conv.content_key_wrapped),
      contentKeyEpk: sealedColumn(conv.content_key_epk),
      encKeyId: conv.enc_key_id ?? null,
      encVersion: conv.enc_version ?? 0,
      snippetSourceMessageId: conv.snippet_source_message_id ?? null,
      contactId: conv.contact_id,
      assignedTo: conv.assigned_to,
      status: conv.status,
      labels: conv.labels,
      isRead,
      isStarred: conv.is_starred,
      internalThreadId: conv.internal_thread_id,
      lastMessageAt: conv.last_message_at,
      messageCount: conv.message_count,
      escalatedTicketId: conv.escalated_ticket_id ?? null,
      escalatedTicketHandle: escalatedDisplayHandle(
        conv,
        conv.escalated_ticket_handle ? await loadSegmentConfig(orgId) : null,
      ),
      escalatedTicketStatus: conv.escalated_ticket_status ?? null,
    },
    messages,
    contact: contact ?? null,
    discussionMarkers,
    nextMessageCursor,
  }
}

export async function updateConversation(
  db: RlsClient,
  params: {
    orgId: string
    userId: string
    conversationId: string
    changes: { status?: string; isRead?: boolean; isStarred?: boolean; assignedTo?: string | null }
  },
) {
  const { orgId, conversationId, changes } = params
  if (changes.assignedTo !== undefined && changes.assignedTo !== null) {
    const [convAccount] = extractRows<{
      account_id: string
      owner_type: string
      owner_id: string | null
    }>(
      await db.execute(drizzleSql`
      SELECT account_id, owner_type, owner_id
      FROM ${convTable()}
      WHERE id = ${conversationId} AND org_id = ${orgId}
      LIMIT 1
    `),
    )
    if (!convAccount) throw new HTTPException(404, { message: "Conversation not found" })
    if (convAccount.owner_type === "user") {
      throw new HTTPException(422, { message: "Personal mailboxes can't be claimed" })
    }
    if (!(await userHasMailInboxGrant(db, orgId, changes.assignedTo, convAccount.account_id))) {
      throw new HTTPException(422, { message: "User has no access to this inbox" })
    }
  }

  const sets: any[] = []
  if (changes.status !== undefined) sets.push(drizzleSql`status = ${changes.status}`)
  if (changes.isRead !== undefined) sets.push(drizzleSql`is_read = ${changes.isRead}`)
  if (changes.isStarred !== undefined) sets.push(drizzleSql`is_starred = ${changes.isStarred}`)
  if (changes.assignedTo !== undefined) sets.push(drizzleSql`assigned_to = ${changes.assignedTo}`)
  sets.push(drizzleSql`updated_at = now()`)

  const updateConversationRow = async (tx: Pick<RlsClient, "execute">) =>
    tx.execute(drizzleSql`
    UPDATE ${convTable()} SET ${drizzleSql.join(sets, drizzleSql.raw(", "))}
    WHERE id = ${conversationId} AND org_id = ${orgId}
    RETURNING *
  `)
  const rows = extractRows(await updateConversationRow(db))
  if (rows.length === 0) return null

  if (changes.isRead !== undefined) {
    await db.execute(drizzleSql`
      UPDATE ${msgTable()} SET is_read = ${changes.isRead}, updated_at = now()
      WHERE conversation_id = ${conversationId} AND org_id = ${orgId}
    `)
  }
  await queueMailEvent(db, {
    orgId,
    userId: params.userId,
    entity: "conversation",
    action: "update",
    entityId: conversationId,
    data: { id: conversationId, accountId: rows[0].account_id, ...changes },
  })
  return rows[0]
}

export async function listAssignableUsersForAccount(
  db: RlsClient,
  params: { orgId: string; requesterId: string; accountId: string },
) {
  if (!(await userHasMailInboxGrant(db, params.orgId, params.requesterId, params.accountId))) {
    throw new HTTPException(403, { message: "Forbidden" })
  }

  return extractRows(
    await db.execute(drizzleSql`
    SELECT DISTINCT u.id, u.name, u.email, u.avatar_url AS "avatarUrl"
    FROM ${usersTable()} u
    WHERE u.org_id = ${params.orgId}
      AND u.status != 'deactivated'
      AND ${mailInboxGrantExistsSql(params.orgId, drizzleSql`u.id`, params.accountId)}
    ORDER BY u.name ASC
  `),
  )
}

/**
 * Runs one of the mail module's send entries (`sendReply`, `sendCompose`) through
 * the one door: `runApp` calls the core module's export in this process
 * (modules/apps/core/registry.ts), on a session bridge.
 */
async function runMailSend(
  orgId: string,
  exportName: string,
  params: unknown,
  opts: { onDispatch?: () => void } = {},
) {
  const [{ runApp }, { createRlsSession }] = await Promise.all([
    import("~/modules/apps/sandbox/run-app"),
    import("~/db/rls"),
  ])
  // The external provider send (Gmail/SMTP) must NOT run inside the caller's
  // request transaction, and must not pin ANY pool connection for the
  // roundtrip-long SMTP/Gmail call. The session bridge opens a short RLS
  // transaction per bridge db call, so the provider I/O itself holds no
  // connection at all. The bridge's credential lookup uses `withPrivilegedDb`
  // internally, so it does not depend on the caller's RLS context. The caller
  // persists the message row in a separate committed step keyed on the
  // provider message id (idempotent via the (account_id, external_message_id)
  // unique constraint).
  //
  // System actor: the credential lookup resolves the account by
  // org + connection + identifier (the account email) via privileged db,
  // mirroring the background sync jobs. Sender attribution (sent_by_user_id)
  // is persisted by the caller in `service.ts`, not by the handler, so the
  // real `userId` is preserved on the stored message row regardless.
  const session = createRlsSession({ actorType: "system", orgId, purpose: "job" })
  const bridge = createSessionRpcBridge("mail", "system", orgId, session, mailManifest as any)
  try {
    return await runApp({
      appName: "mail",
      orgId,
      installed: null,
      bundlePath: CORE_APP_MODULES.mail!.modulePath,
      exportName,
      entry: `tool:${exportName}`,
      params,
      // The handler's third argument: it calls onDispatch just before the
      // message goes to the provider, so a failure after it is "maybe sent".
      extraArgs: [{ onDispatch: opts.onDispatch }],
      bridge,
      holdsTx: false,
      // The provider round trip (Gmail upload with attachments, a slow SMTP
      // relay) gets the tool ceiling, not the 5 s default of a sandboxed run:
      // a send cut short here is usually delivered all the same.
      timeoutMs: mailSendTimeoutMs(),
    })
  } catch (err) {
    // A mailbox without stored credentials, or whose connected account is
    // gone, comes back typed (a 422 that names the mailbox and says to
    // reconnect it), not a 500.
    const message = err instanceof Error ? err.message : String(err)
    throw (
      ConnectionCredentialsMissingError.fromMessage(message) ??
      NoConnectedAccountError.fromMessage(message) ??
      err
    )
  }
}

/** How long a person's send waits for the provider: the tool ceiling (120 s by default). */
export function mailSendTimeoutMs(): number {
  return resolveSandboxMaxToolTimeoutMs()
}

export const MAIL_SEND_IN_PROGRESS = "mail_send_in_progress"
export const MAIL_SEND_OUTCOME_UNKNOWN = "mail_send_outcome_unknown"

/** The draft is being sent by another request right now: nothing was sent twice. */
export class MailSendInProgressError extends Error {
  readonly status = 409
  readonly code = MAIL_SEND_IN_PROGRESS
  constructor() {
    super("This message is being sent. Wait a moment, then check Sent before sending it again.")
    this.name = "MailSendInProgressError"
  }
}

/**
 * The provider did not confirm a send that had already left: it may have been
 * delivered. The draft is kept, and sending it again needs `confirmResend`.
 */
export class MailSendOutcomeUnknownError extends Error {
  readonly status = 409
  readonly code = MAIL_SEND_OUTCOME_UNKNOWN
  constructor() {
    super(
      "The mail provider did not confirm this message, so it may already have been delivered. Check Sent before sending it again.",
    )
    this.name = "MailSendOutcomeUnknownError"
  }
}

/** A provider answer that says nothing left (a 4xx), or a send stopped before dispatch. */
function sendHadNoEffect(err: unknown, dispatched: boolean): boolean {
  if (!dispatched) return true
  const e = err as { providerRejected?: unknown; deliveryState?: unknown } | null
  if (e?.providerRejected === true) return true
  if (e?.deliveryState === "rejected" || e?.deliveryState === "not_delivered") return true
  return err instanceof ConnectionCredentialsMissingError || err instanceof NoConnectedAccountError
}

/** The draft a person sends: the send's idempotency key (one compose or reply, one send). */
export interface DraftSendKey {
  draftId: string
  /** Who owns the draft (`created_by`): the person sending it. */
  createdBy: string
  /** The person confirmed sending again a draft whose earlier send may have been delivered. */
  confirmResend?: boolean
}

interface SendResult {
  messageId: string
  externalThreadId?: string
}

/**
 * A send that is still "sending" after this long ended without a word (the
 * process died mid-send): it counts as maybe delivered.
 */
function staleSendingMs(): number {
  return mailSendTimeoutMs() + 60_000
}

/**
 * Sends a draft at most once. The draft row is the idempotency key: before the
 * provider call it is claimed (`send_state = 'sending'`, committed on its own so
 * a concurrent request or a retry sees it); once the provider accepts it, the
 * provider's ids are recorded (`'sent'`), so a retry after a later failure
 * (persisting, a lost answer) records the same message instead of sending it
 * again. A failure before dispatch, or one the provider says left nothing,
 * releases the claim; any other failure after dispatch is "maybe sent"
 * (`'unknown'`), refused until the person confirms a resend.
 */
async function sendDraftOnce(
  orgId: string,
  key: DraftSendKey,
  send: (onDispatch: () => void) => Promise<SendResult>,
): Promise<SendResult> {
  const stale = `${staleSendingMs()} milliseconds`
  const claimed = await withPrivilegedDb(orgId, "mail-claim-draft-send", async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${draftTable()}
           SET send_state = 'sending', send_started_at = now()
         WHERE id = ${key.draftId} AND org_id = ${orgId} AND created_by = ${key.createdBy}
           AND (
             send_state IS NULL
             OR (${key.confirmResend === true} AND (
               send_state = 'unknown'
               OR (send_state = 'sending' AND send_started_at < now() - ${stale}::interval)
             ))
           )
        RETURNING id
      `),
    ),
  )
  if (claimed.length === 0) {
    const [row] = await withPrivilegedDb(orgId, "mail-read-draft-send", async (tx) =>
      extractRows<{
        send_state: string | null
        stale: boolean
        sent_message_id: string | null
        sent_thread_id: string | null
      }>(
        await tx.execute(drizzleSql`
          SELECT send_state, sent_message_id, sent_thread_id,
                 COALESCE(send_started_at < now() - ${stale}::interval, false) AS stale
            FROM ${draftTable()}
           WHERE id = ${key.draftId} AND org_id = ${orgId} AND created_by = ${key.createdBy}
        `),
      ),
    )
    if (!row) throw new HTTPException(404, { message: "Draft not found" })
    // Accepted by the provider already: record that message, send nothing.
    if (row.send_state === "sent" && row.sent_message_id) {
      return {
        messageId: row.sent_message_id,
        ...(row.sent_thread_id ? { externalThreadId: row.sent_thread_id } : {}),
      }
    }
    if (row.send_state === "sending" && !row.stale) throw new MailSendInProgressError()
    throw new MailSendOutcomeUnknownError()
  }

  let dispatched = false
  let result: SendResult
  try {
    result = await send(() => {
      dispatched = true
    })
  } catch (err) {
    const noEffect = sendHadNoEffect(err, dispatched)
    await withPrivilegedDb(orgId, "mail-settle-draft-send", (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${draftTable()}
           SET send_state = ${noEffect ? null : "unknown"}
         WHERE id = ${key.draftId} AND org_id = ${orgId}
      `),
    ).catch((settleErr) =>
      rootLogger.warn({ err: settleErr, orgId, draftId: key.draftId }, "mail send: settle failed"),
    )
    if (noEffect) throw err
    rootLogger.warn({ err, orgId, draftId: key.draftId }, "mail send: outcome unknown")
    throw new MailSendOutcomeUnknownError()
  }
  // Recorded before anything else can fail: from here on a retry sends nothing.
  await withPrivilegedDb(orgId, "mail-record-draft-send", (tx) =>
    tx.execute(drizzleSql`
      UPDATE ${draftTable()}
         SET send_state = 'sent', sent_message_id = ${result.messageId},
             sent_thread_id = ${result.externalThreadId ?? null}
       WHERE id = ${key.draftId} AND org_id = ${orgId}
    `),
  ).catch((err) =>
    rootLogger.warn({ err, orgId, draftId: key.draftId }, "mail send: recording the send failed"),
  )
  return result
}

/**
 * The provider call of one send: once per draft when the send is a draft's
 * (`draftSend`), else a plain call (an agent's approved send has its own
 * ledger, the approval).
 */
function providerSend(
  orgId: string,
  draftSend: DraftSendKey | undefined,
  exportName: string,
  params: unknown,
): Promise<SendResult> {
  const call = (onDispatch?: () => void) =>
    runMailSend(orgId, exportName, params, { onDispatch }) as Promise<SendResult>
  return draftSend ? sendDraftOnce(orgId, draftSend, call) : call()
}

/** MIME part shape the mail handlers' `buildSendMessage` consumes. */
export interface OutboundMimeAttachment {
  filename: string
  mimeType: string
  bytesBase64: string
  disposition: "inline" | "attachment"
  contentId?: string
}

// Mirror the attachment-bytes bridge caps so human sends and agent
// sends obey the same outbound size budget.
const ATTACHMENT_PER_FILE_MAX = 25 * 1024 * 1024
const ATTACHMENT_PER_SEND_MAX = 35 * 1024 * 1024

/**
 * Load the files staged on a draft (`mail/draft/<id>` parents, written by the
 * composer's attach control) as MIME parts for the outgoing message. The
 * caller's RLS context has already proven draft ownership.
 */
async function loadDraftAttachmentParts(
  db: RlsClient,
  orgId: string,
  draftId: string,
): Promise<OutboundMimeAttachment[]> {
  const { schemaRef } = await import("~/db/schema-ref")
  const { getObjectBytes } = await import("~/lib/storage/get-object-bytes")
  const KS = drizzleSql.raw(schemaRef("kernel"))
  const rows = extractRows<{
    filename: string
    mime_type: string
    storage_key: string
    disposition: string | null
    content_id: string | null
  }>(
    await db.execute(drizzleSql`
      SELECT filename, mime_type, storage_key, disposition, content_id
      FROM ${KS}.files
      WHERE org_id = ${orgId}
        AND app = 'mail' AND entity_type = 'draft' AND entity_id = ${draftId}
      ORDER BY ordinal NULLS LAST, created_at
    `),
  )
  const parts: OutboundMimeAttachment[] = []
  let cumulative = 0
  for (const row of rows) {
    const obj = await getObjectBytes(row.storage_key, { maxBytes: ATTACHMENT_PER_FILE_MAX })
    cumulative += obj.bytes.byteLength
    if (cumulative > ATTACHMENT_PER_SEND_MAX) {
      throw new HTTPException(413, {
        message: `Attachments exceed the ${Math.floor(ATTACHMENT_PER_SEND_MAX / (1024 * 1024))} MB send limit`,
      })
    }
    parts.push({
      filename: row.filename,
      mimeType: row.mime_type || obj.contentType || "application/octet-stream",
      bytesBase64: obj.bytes.toString("base64"),
      disposition: row.disposition === "inline" ? "inline" : "attachment",
      contentId: row.content_id ?? undefined,
    })
  }
  return parts
}

/**
 * The mail account's encryption facts, read through the one resolver so the
 * application layer and the Invariant P trigger cannot disagree.
 *
 * SEND-PATH RESIDUAL, documented rather than hidden: the plaintext of an
 * outbound message transits server memory at send time, because the SMTP and
 * Gmail credentials are server-held and the mail has to leave as plaintext
 * regardless. That is what email is. The server does not PERSIST it: what lands
 * in the Sent folder for a sealed mailbox is ciphertext only. Do not "fix" the
 * transit by removing the seal; making the transit disappear needs client-held
 * SMTP credentials, which is a different feature.
 */
async function accountCryptoOf(db: RlsClient, orgId: string, accountId: string) {
  return resolveMailAccountCrypto(db, mailSchema, orgId, accountId)
}

export async function sendReply(
  db: RlsClient,
  params: {
    orgId: string
    userId: string
    conversationId: string
    htmlBody: string
    textBody: string
    cc?: string[]
    bcc?: string[]
    attachments?: OutboundMimeAttachment[]
    /** The draft being sent: the send happens at most once per draft. */
    draftSend?: DraftSendKey
  },
) {
  const convRows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT * FROM ${convTable()} WHERE id = ${params.conversationId} AND org_id = ${params.orgId} LIMIT 1
  `),
  )
  if (convRows.length === 0) throw new HTTPException(404, { message: "Conversation not found" })
  const conversation = convRows[0]

  // Reply threading must derive from the latest INBOUND message — the message
  // we are actually replying to. Using the latest message regardless of
  // direction would, on the common case where the team replied last, address
  // the reply to the mailbox's own outbound `from_address` (the conversation's
  // own account) and corrupt In-Reply-To/References.
  const latestInboundRows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT * FROM ${msgTable()}
    WHERE conversation_id = ${params.conversationId} AND org_id = ${params.orgId}
      AND direction = 'inbound'
    ORDER BY sent_at DESC
    LIMIT 1
  `),
  )
  const latest = latestInboundRows[0]
  const accountRows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT * FROM ${accTable()} WHERE id = ${conversation.account_id} AND org_id = ${params.orgId} LIMIT 1
  `),
  )
  if (accountRows.length === 0) throw new HTTPException(404, { message: "Account not found" })
  const account = accountRows[0]

  // Refuse BEFORE the provider call. A mailbox that cannot be sealed to must
  // not send either, because the Sent copy would have nowhere to go but a
  // plaintext column, and writing that is forbidden.
  const accountCrypto = await accountCryptoOf(db, params.orgId, account.id)
  assertMailboxWritable(accountCrypto, "sendReply")
  const sealing = mailboxRequiresSealing(accountCrypto)
  if (sealing) assertSealRecipient(accountCrypto, params.userId)

  // Recipient: the inbound sender if one exists, otherwise fall back to the
  // conversation's linked contact. If neither resolves to an address there is
  // nobody to reply to — reject rather than silently sending to the mailbox.
  let recipientEmail: string | undefined = latest?.from_address?.email
  if (!recipientEmail && conversation.contact_id) {
    const [contact] = await db
      .select({ email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.id, conversation.contact_id), eq(contacts.orgId, params.orgId)))
      .limit(1)
    recipientEmail = contact?.email ?? undefined
  }
  if (!recipientEmail) {
    throw new HTTPException(422, { message: "No recipient to reply to" })
  }

  const references = [
    ...new Set(
      [...(latest?.message_references ?? []), latest?.external_message_id].filter(Boolean),
    ),
  ]
  const replySubject = conversation.subject?.startsWith("Re:")
    ? conversation.subject
    : `Re: ${conversation.subject ?? ""}`.trim()

  const sendResult = await providerSend(params.orgId, params.draftSend, "sendReply", {
    provider: account.provider,
    accountEmail: account.email_address,
    externalThreadId: conversation.external_thread_id,
    to: [recipientEmail],
    cc: params.cc ?? [],
    bcc: params.bcc ?? [],
    subject: replySubject,
    htmlBody: params.htmlBody,
    textBody: params.textBody,
    inReplyTo: latest?.external_message_id ?? null,
    references,
    attachments: params.attachments ?? [],
  })

  // The email is now delivered. Persist locally in a SEPARATE committed
  // transaction so a failure here (or a rollback of any enclosing request tx)
  // cannot orphan an already-sent email. The (org_id, account_id,
  // external_message_id) unique index (migration 0116) makes re-persisting the
  // same provider message id a no-op,
  // so a client/job retry of the same delivered message is idempotent.
  await withPrivilegedDb(params.orgId, "mail-persist-sent-reply", async (tx) => {
    const inserted = extractRows<any>(
      await tx.execute(drizzleSql`
      INSERT INTO ${msgTable()} (
        id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
        in_reply_to, message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
        subject, text_body, html_body, snippet, is_read, is_starred, labels, direction,
        sent_at, synced_at, raw_headers, owner_type, owner_id, sent_by_user_id
      ) VALUES (
        gen_random_uuid(), ${params.orgId}, ${params.conversationId}, ${conversation.account_id}, ${sendResult.messageId}, ${sendResult.messageId},
        ${latest?.external_message_id ?? null}, ${JSON.stringify(references)}::jsonb,
        ${JSON.stringify({ email: account.email_address })}::jsonb,
        ${JSON.stringify(latest?.from_address ? [latest.from_address] : [{ email: recipientEmail }])}::jsonb,
        ${JSON.stringify(params.cc ?? [])}::jsonb,
        ${JSON.stringify(params.bcc ?? [])}::jsonb,
        ${sealing ? null : replySubject},
        ${sealing ? null : params.textBody}, ${sealing ? null : params.htmlBody},
        ${sealing ? null : params.textBody.slice(0, 200)},
        true, false, '["SENT"]'::jsonb, 'outbound', now(), now(), '{}'::jsonb,
        ${conversation.owner_type}, ${conversation.owner_id}, ${params.userId}
      )
      ON CONFLICT (org_id, account_id, external_message_id) DO NOTHING
      RETURNING *
    `),
    )
    // No row inserted → this provider message id is already persisted (retry).
    // The original send already produced the row + events; nothing to do.
    if (inserted.length === 0) return
    const message = inserted[0]

    // Seal against the id the INSERT returned, in the SAME transaction. The
    // row went in with every guarded plaintext column NULL, which Invariant P
    // permits; a seal failure here throws and rolls the whole thing back, so no
    // plaintext row is ever committed and no half-sealed row survives.
    if (sealing) {
      await applyMailSealToRow(tx, {
        schemaName: mailSchema,
        orgId: params.orgId,
        userId: accountCrypto.ownerId as string,
        account: accountCrypto,
        entity: "messages",
        rowId: message.id,
        values: {
          subject: replySubject,
          textBody: params.textBody,
          htmlBody: params.htmlBody,
          snippet: params.textBody.slice(0, 200),
        },
        headers: {},
      })
    }

    await tx.execute(drizzleSql`
      UPDATE ${convTable()}
      SET snippet = ${sealing ? null : params.textBody.slice(0, 200)}, last_message_at = now(), message_count = message_count + 1, updated_at = now()
      WHERE id = ${params.conversationId} AND org_id = ${params.orgId}
    `)
    // The user saw what they answered: the reply reads the conversation up to it.
    await markConversationReadThrough(
      tx,
      mailSchema,
      params.orgId,
      params.conversationId,
      message.sent_at ?? null,
    )
    if (sealing) {
      await pointConversationAtMessage(
        tx,
        mailSchema,
        params.orgId,
        params.conversationId,
        message.id,
      )
    }

    const messageProjection = await getMessageProjection(tx, params.orgId, message.id)
    await queueMailEvent(tx, {
      orgId: params.orgId,
      userId: params.userId,
      entity: "message",
      action: "create",
      entityId: message.id,
      data: messageProjection ?? {
        id: message.id,
        conversationId: params.conversationId,
        accountId: conversation.account_id,
        sentByUserId: params.userId,
      },
    })
    await queueMailEvent(tx, {
      orgId: params.orgId,
      userId: params.userId,
      entity: "conversation",
      action: "update",
      entityId: params.conversationId,
      data: { id: params.conversationId, accountId: conversation.account_id },
    })
  })

  return { messageId: sendResult.messageId }
}

/**
 * The existing contact a sent mail's first To address belongs to, under the
 * mailbox's visibility rules, or null. The mail has already left when this
 * runs, so a failed lookup leaves the conversation unlinked rather than
 * losing its record.
 */
async function addressedContact(
  orgId: string,
  userId: string,
  account: { id: string; owner_type: string; owner_id: string | null },
  firstTo: string | undefined,
): Promise<string | null> {
  const email = firstTo?.trim().toLowerCase()
  if (!email) return null
  try {
    const found = await resolveSenderContacts(
      orgId,
      userId,
      { id: account.id, ownerType: account.owner_type, ownerId: account.owner_id },
      [{ email }],
      { create: false },
    )
    return found[email] ?? null
  } catch (err) {
    rootLogger.warn({ err, orgId, accountId: account.id }, "sent mail: contact lookup failed")
    return null
  }
}

export async function sendCompose(
  db: RlsClient,
  params: {
    orgId: string
    userId: string
    accountId: string
    to: string[]
    cc?: string[]
    bcc?: string[]
    subject: string
    htmlBody: string
    textBody: string
    /** Extra headers (a commercial mail's unsubscribe headers). */
    headers?: Record<string, string>
    attachments?: OutboundMimeAttachment[]
    /** The draft being sent: the send happens at most once per draft. */
    draftSend?: DraftSendKey
  },
) {
  const accountRows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT * FROM ${accTable()} WHERE id = ${params.accountId} AND org_id = ${params.orgId} LIMIT 1
  `),
  )
  if (accountRows.length === 0) throw new HTTPException(404, { message: "Account not found" })
  const account = accountRows[0]

  // Same refusal as sendReply, and for the same reason: no seal path means no
  // Sent copy, and a plaintext Sent copy is forbidden. Refuse before the
  // provider call so nothing leaves.
  const accountCrypto = await accountCryptoOf(db, params.orgId, account.id)
  assertMailboxWritable(accountCrypto, "sendCompose")
  const sealing = mailboxRequiresSealing(accountCrypto)
  if (sealing) assertSealRecipient(accountCrypto, params.userId)

  const sendResult = await providerSend(params.orgId, params.draftSend, "sendCompose", {
    provider: account.provider,
    accountEmail: account.email_address,
    to: params.to,
    cc: params.cc ?? [],
    bcc: params.bcc ?? [],
    subject: params.subject,
    htmlBody: params.htmlBody,
    textBody: params.textBody,
    ...(params.headers ? { headers: params.headers } : {}),
    attachments: params.attachments ?? [],
  })

  const externalThreadId = sendResult.externalThreadId ?? sendResult.messageId

  // The conversation links to the contact it was addressed to (its first To
  // recipient), found by the same lookup and visibility rules as mail the
  // mailbox sync stores: an existing contact only, sending creates none.
  const contactId = await addressedContact(params.orgId, params.userId, account, params.to[0])

  // The email is delivered. Persist the new conversation + message in a SEPARATE
  // committed transaction so a DB failure (or rollback of any enclosing request
  // tx) cannot orphan an already-sent email. Idempotent on the provider message
  // id: a retry that finds an existing message with this external_message_id
  // returns the existing conversation instead of creating a duplicate.
  const conversationId = await withPrivilegedDb(
    params.orgId,
    "mail-persist-sent-compose",
    async (tx) => {
      const existing = extractRows<{ conversation_id: string }>(
        await tx.execute(drizzleSql`
        SELECT conversation_id FROM ${msgTable()}
        WHERE account_id = ${params.accountId} AND external_message_id = ${sendResult.messageId}
          AND org_id = ${params.orgId}
        LIMIT 1
      `),
      )
      if (existing.length > 0) return existing[0].conversation_id

      // The thread may already exist: the Gmail sync can import the sent
      // message's thread between the send and this write. The unique
      // (org_id, account_id, external_thread_id) index turns that into a
      // conflict, which must not fail an email that is already delivered: the
      // sent message joins the existing conversation instead.
      let [conversation] = extractRows<any>(
        await tx.execute(drizzleSql`
        INSERT INTO ${convTable()} (
          id, org_id, account_id, owner_type, owner_id, external_thread_id,
          subject, snippet, contact_id, status, labels, is_read, is_starred, last_message_at, message_count
        ) VALUES (
          gen_random_uuid(), ${params.orgId}, ${params.accountId}, ${account.owner_type}, ${account.owner_id}, ${externalThreadId},
          ${sealing ? null : params.subject}, ${sealing ? null : params.textBody.slice(0, 200)},
          ${contactId}::uuid, 'open', '["SENT"]'::jsonb, true, false, now(), 1
        )
        ON CONFLICT (org_id, account_id, external_thread_id) DO NOTHING
        RETURNING *
      `),
      )
      const joinedExisting = !conversation
      if (!conversation) {
        ;[conversation] = extractRows<any>(
          await tx.execute(drizzleSql`
          SELECT * FROM ${convTable()}
           WHERE org_id = ${params.orgId} AND account_id = ${params.accountId}
             AND external_thread_id = ${externalThreadId}
           FOR UPDATE
        `),
        )
      }

      const [message] = extractRows<any>(
        await tx.execute(drizzleSql`
        INSERT INTO ${msgTable()} (
          id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
          in_reply_to, message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
          subject, text_body, html_body, snippet, is_read, is_starred, labels, direction,
          sent_at, synced_at, raw_headers, owner_type, owner_id, sent_by_user_id
        ) VALUES (
          gen_random_uuid(), ${params.orgId}, ${conversation.id}, ${params.accountId}, ${sendResult.messageId}, ${sendResult.messageId},
          null, '[]'::jsonb, ${JSON.stringify({ email: account.email_address })}::jsonb,
          ${JSON.stringify(params.to.map((email) => ({ email })))}::jsonb,
          ${JSON.stringify((params.cc ?? []).map((email) => ({ email })))}::jsonb,
          ${JSON.stringify((params.bcc ?? []).map((email) => ({ email })))}::jsonb,
          ${sealing ? null : params.subject}, ${sealing ? null : params.textBody},
          ${sealing ? null : params.htmlBody}, ${sealing ? null : params.textBody.slice(0, 200)},
          true, false, '["SENT"]'::jsonb, 'outbound', now(), now(), '{}'::jsonb,
          ${account.owner_type}, ${account.owner_id}, ${params.userId}
        )
        ON CONFLICT (org_id, account_id, external_message_id) DO NOTHING
        RETURNING *
      `),
      )
      // Stored already (by the sync, between the send and here): its
      // conversation is the answer, and nothing is announced twice.
      if (!message) return conversation.id as string
      if (joinedExisting) {
        await tx.execute(drizzleSql`
          UPDATE ${convTable()}
             SET message_count = message_count + 1, last_message_at = now(), updated_at = now(),
                 contact_id = COALESCE(contact_id, ${contactId}::uuid)
           WHERE id = ${conversation.id} AND org_id = ${params.orgId}`)
      }

      // Seal in the same transaction the rows were created in. A failure here
      // rolls both rows back rather than leaving plaintext behind.
      if (sealing) {
        await applyMailSealToRow(tx, {
          schemaName: mailSchema,
          orgId: params.orgId,
          userId: accountCrypto.ownerId as string,
          account: accountCrypto,
          entity: "messages",
          rowId: message.id,
          values: {
            subject: params.subject,
            textBody: params.textBody,
            htmlBody: params.htmlBody,
            snippet: params.textBody.slice(0, 200),
          },
          headers: {},
        })
        await pointConversationAtMessage(tx, mailSchema, params.orgId, conversation.id, message.id)
      }

      const messageProjection = await getMessageProjection(tx, params.orgId, message.id)
      await queueMailEvent(tx, {
        orgId: params.orgId,
        userId: params.userId,
        entity: "conversation",
        action: joinedExisting ? "update" : "create",
        entityId: conversation.id,
        data: { id: conversation.id, accountId: params.accountId },
      })
      await queueMailEvent(tx, {
        orgId: params.orgId,
        userId: params.userId,
        entity: "message",
        action: "create",
        entityId: message.id,
        data: messageProjection ?? {
          id: message.id,
          conversationId: conversation.id,
          accountId: params.accountId,
          sentByUserId: params.userId,
        },
      })

      return conversation.id as string
    },
  )

  return { conversationId, messageId: sendResult.messageId }
}

export async function triggerSync(
  db: RlsClient,
  params: { orgId: string; userId: string; accountId: string; scopes: string[] },
) {
  const rows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT id, provider, disconnected_at, owner_type FROM ${accTable()}
    WHERE id = ${params.accountId} AND org_id = ${params.orgId}
    LIMIT 1
  `),
  )
  if (rows.length === 0) throw new HTTPException(404, { message: "Account not found" })
  const account = rows[0]
  if (account.disconnected_at)
    throw new HTTPException(409, { message: "Account disconnected — reconnect required" })
  // hasScope, not a literal match: the admin wildcard `*` and a parent grant
  // (`mail:*`, `mail:accounts`) hold this scope too.
  if (account.owner_type === "org" && !hasScope("mail:accounts:admin", params.scopes)) {
    throw new HTTPException(403, { message: "Admin scope required for org-account sync" })
  }

  const { enqueueAppJob } = await import("~/infra/jobs/jobs")
  const jobName = account.provider === "gmail" ? "gmail-incremental-sync" : "imap-incremental-sync"
  await enqueueAppJob(
    "mail",
    jobName,
    { orgId: params.orgId, accountId: params.accountId },
    { jobId: `${jobName}:${params.accountId}` },
  )
  return { enqueued: true }
}

export async function getSyncStatus(db: RlsClient, params: { orgId: string; accountId: string }) {
  const rows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT sync_status, last_sync_at, last_sync_error, sync_state FROM ${accTable()}
    WHERE id = ${params.accountId} AND org_id = ${params.orgId}
    LIMIT 1
  `),
  )
  if (rows.length === 0) throw new HTTPException(404, { message: "Account not found" })
  const account = rows[0]
  return {
    status: account.sync_status,
    lastSyncAt: account.last_sync_at,
    lastSyncError: account.last_sync_error,
    messagesSynced: account.sync_state?.messagesSynced ?? 0,
  }
}

// ============================================================
// Draft service functions
// ============================================================

const draftTable = () => drizzleSql.raw(`${quoteIdent(mailSchema)}.drafts`)

function mapDraftRow(row: any) {
  return {
    id: row.id,
    orgId: row.org_id,
    accountId: row.account_id,
    conversationId: row.conversation_id ?? null,
    replyToMessageId: row.reply_to_message_id ?? null,
    to: parseJsonArray(row.to),
    cc: parseJsonArray(row.cc),
    bcc: parseJsonArray(row.bcc),
    subject: row.subject ?? "",
    htmlBody: row.html_body ?? "",
    textBody: row.text_body ?? "",
    // The sealed half. Base64 on the wire; the browser opens it, the server
    // cannot. `encVersion` 1 tells the client which representation is real.
    bodyCiphertext: row.body_ciphertext
      ? Buffer.from(row.body_ciphertext).toString("base64")
      : null,
    // A legacy draft can carry a text AND an html alternative, so the backfill
    // seals both. Without this the html one would be readable by nobody.
    htmlBodyCiphertext: row.html_body_ciphertext
      ? Buffer.from(row.html_body_ciphertext).toString("base64")
      : null,
    subjectCiphertext: row.subject_ciphertext
      ? Buffer.from(row.subject_ciphertext).toString("base64")
      : null,
    contentKeyWrapped: row.content_key_wrapped
      ? Buffer.from(row.content_key_wrapped).toString("base64")
      : null,
    contentKeyEpk: row.content_key_epk ? Buffer.from(row.content_key_epk).toString("base64") : null,
    encKeyId: row.enc_key_id ?? null,
    encVersion: row.enc_version ?? 0,
    updatedAt: row.updated_at,
  }
}

export async function createDraft(
  db: RlsClient,
  params: {
    orgId: string
    userId: string
    accountId: string
    conversationId?: string
    replyToMessageId?: string
    to?: Array<{ name?: string; email: string }>
    cc?: Array<{ name?: string; email: string }>
    subject?: string
  },
) {
  // For reply drafts, upsert keyed by (created_by, conversation_id)
  if (params.conversationId) {
    const existing = extractRows<any>(
      await db.execute(drizzleSql`
      SELECT * FROM ${draftTable()}
      WHERE org_id = ${params.orgId}
        AND created_by = ${params.userId}
        AND conversation_id = ${params.conversationId}
      LIMIT 1
    `),
    )
    if (existing.length > 0) {
      await revealManagedRows(existing, "drafts", params.orgId, params.userId)
      return mapDraftRow(existing[0])
    }
  }

  // Verify account is accessible to this user
  const accountRows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT id FROM ${accTable()}
    WHERE id = ${params.accountId}
      AND org_id = ${params.orgId}
      AND (
        (owner_type = 'user' AND owner_id = ${params.userId})
        OR owner_type = 'org'
      )
    LIMIT 1
  `),
  )
  if (accountRows.length === 0) {
    throw new HTTPException(409, {
      message: "Account not accessible — reconnect or check account permissions",
    })
  }

  // A subject is plaintext: an end to end encrypted mailbox never stores one
  // (updateDraft refuses it), so its draft starts without and the browser
  // seals whatever it saves later.
  const draftAccount = await accountCryptoOf(db, params.orgId, params.accountId)
  const subject = params.subject && !mailboxRequiresSealing(draftAccount) ? params.subject : null

  const [draft] = extractRows<any>(
    await db.execute(drizzleSql`
    INSERT INTO ${draftTable()} (
      id, org_id, account_id, conversation_id, reply_to_message_id,
      "to", cc, bcc, subject, html_body, text_body, created_by, sent_by_user_id
    ) VALUES (
      gen_random_uuid(), ${params.orgId}, ${params.accountId},
      ${params.conversationId ?? null}, ${params.replyToMessageId ?? null},
      ${JSON.stringify(params.to ?? [])}::jsonb, ${JSON.stringify(params.cc ?? [])}::jsonb,
      '[]'::jsonb, ${subject}, null, null, ${params.userId}, ${params.userId}
    ) RETURNING *
  `),
  )
  // A managed mailbox's subject is sealed by the server, in this transaction.
  if (draftAccount.encryptionState === "managed" && params.subject) {
    await applyMailSealToRow(db, {
      schemaName: mailSchema,
      orgId: params.orgId,
      userId: draftAccount.ownerId as string,
      account: draftAccount,
      entity: "drafts",
      rowId: draft.id,
      values: { subject: params.subject },
    })
    return (
      (await getDraft(db, { orgId: params.orgId, userId: params.userId, draftId: draft.id })) ??
      mapDraftRow(draft)
    )
  }
  return mapDraftRow(draft)
}

export async function listDrafts(db: RlsClient, params: { orgId: string; userId: string }) {
  const rows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT * FROM ${draftTable()}
    WHERE org_id = ${params.orgId} AND created_by = ${params.userId}
    ORDER BY updated_at DESC
  `),
  )
  await revealManagedRows(rows, "drafts", params.orgId, params.userId)
  return rows.map(mapDraftRow)
}

export async function getDraft(
  db: RlsClient,
  params: { orgId: string; userId: string; draftId: string },
) {
  const rows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT * FROM ${draftTable()}
    WHERE id = ${params.draftId}
      AND org_id = ${params.orgId}
      AND created_by = ${params.userId}
    LIMIT 1
  `),
  )
  if (rows.length === 0) return null
  await revealManagedRows(rows, "drafts", params.orgId, params.userId)
  return mapDraftRow(rows[0])
}

/**
 * A draft of a server-managed mailbox: the browser sends plaintext and the
 * server seals it (`enc_version = 2`). Every content field is re-sealed under
 * one fresh content key on each save, the unchanged ones taken from the stored
 * draft, so the row never mixes two keys.
 */
async function updateManagedDraft(
  db: RlsClient,
  params: Parameters<typeof updateDraft>[1],
  accountCrypto: Awaited<ReturnType<typeof accountCryptoOf>>,
) {
  const { changes } = params
  const current = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT * FROM ${draftTable()}
     WHERE id = ${params.draftId} AND org_id = ${params.orgId} AND created_by = ${params.userId}
     LIMIT 1`),
  )[0]
  if (!current) return null
  await revealManagedRows([current], "drafts", params.orgId, params.userId)
  const pick = (next: string | undefined, stored: unknown) =>
    next !== undefined ? next : typeof stored === "string" ? stored : null
  const values = {
    subject: pick(changes.subject, current.subject),
    body: pick(changes.textBody, current.text_body),
    htmlBody: pick(changes.htmlBody, current.html_body),
  }
  await db.execute(drizzleSql`
    UPDATE ${draftTable()} SET
      "to" = COALESCE(${changes.to ? JSON.stringify(changes.to) : null}::jsonb, "to"),
      cc = COALESCE(${changes.cc ? JSON.stringify(changes.cc) : null}::jsonb, cc),
      bcc = COALESCE(${changes.bcc ? JSON.stringify(changes.bcc) : null}::jsonb, bcc),
      subject = NULL, html_body = NULL, text_body = NULL,
      body_ciphertext = NULL, subject_ciphertext = NULL, html_body_ciphertext = NULL,
      updated_at = now()
    WHERE id = ${params.draftId} AND org_id = ${params.orgId} AND created_by = ${params.userId}`)
  await applyMailSealToRow(db, {
    schemaName: mailSchema,
    orgId: params.orgId,
    userId: accountCrypto.ownerId as string,
    account: accountCrypto,
    entity: "drafts",
    rowId: params.draftId,
    values,
  })
  return getDraft(db, params)
}

export async function updateDraft(
  db: RlsClient,
  params: {
    orgId: string
    userId: string
    draftId: string
    changes: {
      to?: Array<{ name?: string; email: string }>
      cc?: Array<{ name?: string; email: string }>
      bcc?: Array<{ name?: string; email: string }>
      subject?: string
      htmlBody?: string
      textBody?: string
      /** Base64. Sealed IN THE BROWSER before the request left it, so an unsent
       *  draft is never plaintext at rest. */
      bodyCiphertext?: string
      subjectCiphertext?: string
      contentKeyWrapped?: string
      contentKeyEpk?: string
      encKeyId?: number
    }
  },
) {
  const { changes } = params
  // Resolve the owning account first: the refusal below has to happen before
  // the UPDATE, not be discovered by the trigger afterwards, so that the row is
  // genuinely left unchanged.
  const owning = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT a.id, a.owner_type, a.owner_id, a.encryption_state
      FROM ${draftTable()} d
      JOIN ${accTable()} a ON a.id = d.account_id
     WHERE d.id = ${params.draftId} AND d.org_id = ${params.orgId} AND d.created_by = ${params.userId}
     LIMIT 1`),
  )
  if (owning.length === 0) return null
  const accountCrypto = await accountCryptoOf(db, params.orgId, owning[0].id)
  assertMailboxWritable(accountCrypto, "updateDraft")
  const sealing = mailboxRequiresSealing(accountCrypto)
  const managed = accountCrypto.encryptionState === "managed"

  if (managed) return updateManagedDraft(db, params, accountCrypto)

  if (sealing) {
    // An empty string is absence everywhere in this feature, not content, so a
    // client clearing a field is accepted rather than refused.
    const offenders = (["subject", "htmlBody", "textBody"] as const).filter((field) => {
      const value = changes[field]
      return typeof value === "string" && value !== ""
    })
    if (offenders.length > 0) {
      throw new HTTPException(400, {
        message: `MAILBOX_PLAINTEXT_DRAFT_REFUSED: ${offenders.join(", ")} must be sealed in the browser before this request. This mailbox is end to end encrypted.`,
      })
    }
  }

  const decode = (value: string | undefined) =>
    typeof value === "string" && value !== "" ? Buffer.from(value, "base64") : null

  const rows = extractRows<any>(
    await db.execute(drizzleSql`
    UPDATE ${draftTable()} SET
      "to" = COALESCE(${changes.to ? JSON.stringify(changes.to) : null}::jsonb, "to"),
      cc = COALESCE(${changes.cc ? JSON.stringify(changes.cc) : null}::jsonb, cc),
      bcc = COALESCE(${changes.bcc ? JSON.stringify(changes.bcc) : null}::jsonb, bcc),
      subject = COALESCE(${sealing ? null : (changes.subject ?? null)}, subject),
      html_body = COALESCE(${sealing ? null : (changes.htmlBody ?? null)}, html_body),
      text_body = COALESCE(${sealing ? null : (changes.textBody ?? null)}, text_body),
      body_ciphertext = COALESCE(${decode(changes.bodyCiphertext)}, body_ciphertext),
      subject_ciphertext = COALESCE(${decode(changes.subjectCiphertext)}, subject_ciphertext),
      content_key_wrapped = COALESCE(${decode(changes.contentKeyWrapped)}, content_key_wrapped),
      content_key_epk = COALESCE(${decode(changes.contentKeyEpk)}, content_key_epk),
      enc_key_id = COALESCE(${changes.encKeyId ?? null}, enc_key_id),
      enc_version = ${changes.bodyCiphertext || changes.subjectCiphertext ? 1 : drizzleSql.raw("enc_version")},
      updated_at = now()
    WHERE id = ${params.draftId}
      AND org_id = ${params.orgId}
      AND created_by = ${params.userId}
    RETURNING *
  `),
  )
  if (rows.length === 0) return null
  return mapDraftRow(rows[0])
}

export async function deleteDraft(
  db: RlsClient,
  params: { orgId: string; userId: string; draftId: string },
) {
  await db.execute(drizzleSql`
    DELETE FROM ${draftTable()}
    WHERE id = ${params.draftId}
      AND org_id = ${params.orgId}
      AND created_by = ${params.userId}
  `)
}

/**
 * The bodies and headers a person's own new message leaves with. A recipient
 * the data marks as a prospect makes it commercial: the footer and opt-out
 * link are added (the composer showed them), and a refusal (opted out, more
 * than one outside person, no legal identity) stops it with its reason.
 */
async function personComposeBodies(
  orgId: string,
  userId: string,
  mail: {
    to: Array<{ email: string }>
    cc: Array<{ email: string }>
    bcc: Array<{ email: string }>
    htmlBody: string
    textBody: string
  },
): Promise<{
  htmlBody: string
  textBody: string
  headers?: Record<string, string>
  /** The commercial send's record, written once the mail left. */
  record?: CommercialSend
}> {
  const recipients = recipientsOf(
    mail.to.map((a) => a.email),
    mail.cc.map((a) => a.email),
    mail.bcc.map((a) => a.email),
  )
  const own = await checkPersonCompose(orgId, recipients)
  if (!own.commercial) return { htmlBody: mail.htmlBody, textBody: mail.textBody }
  if ("refused" in own) throw new HTTPException(422, { message: own.refused.message })
  const footer = await commercialFooterFor(orgId, own.recipient, mail.textBody, mail.htmlBody)
  if (!footer) {
    throw new HTTPException(422, {
      message: `Nothing was sent. ${COMMERCIAL_IDENTITY_MISSING_MESSAGE}`,
    })
  }
  const htmlBody = footer.htmlBody ?? mail.htmlBody
  const textBody = footer.textBody ?? mail.textBody
  return {
    htmlBody,
    textBody,
    headers: footer.headers,
    record: {
      orgId,
      actorId: userId,
      actorType: "user",
      toolName: "mail:compose",
      recipient: own.recipient,
      textBody,
      htmlBody,
      mode: null,
      approvedBy: "person",
      approverId: userId,
    },
  }
}

export async function sendDraft(
  db: RlsClient,
  params: {
    orgId: string
    userId: string
    draftId: string
    to?: Array<{ name?: string; email: string }>
    cc?: Array<{ name?: string; email: string }>
    bcc?: Array<{ name?: string; email: string }>
    subject?: string
    htmlBody: string
    textBody: string
    /** The person confirmed sending again a draft whose earlier send may have been delivered. */
    confirmResend?: boolean
  },
) {
  const draftRows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT d.*, a.provider, a.email_address, a.owner_type, a.owner_id, a.disconnected_at
    FROM ${draftTable()} d
    JOIN ${accTable()} a ON a.id = d.account_id AND a.org_id = d.org_id
    WHERE d.id = ${params.draftId}
      AND d.org_id = ${params.orgId}
      AND d.created_by = ${params.userId}
    LIMIT 1
  `),
  )
  if (draftRows.length === 0) throw new HTTPException(404, { message: "Draft not found" })
  const draft = draftRows[0]

  if (draft.disconnected_at) {
    throw new HTTPException(409, { message: "Account disconnected — reconnect before sending" })
  }

  const toAddresses = params.to ?? draft.to ?? []
  const ccAddresses = params.cc ?? draft.cc ?? []
  const bccAddresses = params.bcc ?? draft.bcc ?? []
  const subject = params.subject ?? draft.subject ?? ""
  const senderUserId = draft.sent_by_user_id ?? params.userId

  // Files the composer staged onto this draft ride the outgoing MIME — without
  // this the sent message row would show chips (reparent below) while the
  // customer's actual email arrives attachment-less.
  const attachments = await loadDraftAttachmentParts(db, params.orgId, params.draftId)
  // One draft, one send: a retry (a lost answer, a second click) never sends twice.
  const draftSend: DraftSendKey = {
    draftId: params.draftId,
    createdBy: params.userId,
    ...(params.confirmResend === true ? { confirmResend: true } : {}),
  }

  // A new message's bodies as they leave: a prospect's mail gains its footer here.
  const outgoing: Awaited<ReturnType<typeof personComposeBodies>> = draft.conversation_id
    ? { htmlBody: params.htmlBody, textBody: params.textBody }
    : await personComposeBodies(params.orgId, params.userId, {
        to: toAddresses,
        cc: ccAddresses,
        bcc: bccAddresses,
        htmlBody: params.htmlBody,
        textBody: params.textBody,
      })

  const result = draft.conversation_id
    ? {
        conversationId: draft.conversation_id,
        messageId: (
          await sendReply(db, {
            orgId: params.orgId,
            userId: senderUserId,
            conversationId: draft.conversation_id,
            htmlBody: params.htmlBody,
            textBody: params.textBody,
            cc: ccAddresses.map((a: any) => a.email),
            bcc: bccAddresses.map((a: any) => a.email),
            attachments,
            draftSend,
          })
        ).messageId,
      }
    : await sendCompose(db, {
        orgId: params.orgId,
        userId: senderUserId,
        accountId: draft.account_id,
        to: toAddresses.map((a: any) => a.email),
        cc: ccAddresses.map((a: any) => a.email),
        bcc: bccAddresses.map((a: any) => a.email),
        subject,
        htmlBody: outgoing.htmlBody,
        textBody: outgoing.textBody,
        headers: outgoing.headers,
        attachments,
        draftSend,
      })
  // Only once it left: a send that failed writes no record and leaves the notice owed.
  if (outgoing.record) await recordCommercialSendAfterSend(outgoing.record)

  // Reparent any draft-staged attachments onto the new mail message before
  // deleting the draft (otherwise the file rows would lose their parent).
  // The UPDATE is gated by an EXISTS subquery on `drafts.created_by` so a
  // caller invoking `sendDraft` with another user's draftId cannot move that
  // user's staged files into a message they create.
  if (result.messageId) {
    const { schemaRef } = await import("~/db/schema-ref")
    const KS = drizzleSql.raw(schemaRef("kernel"))
    const mailMsgRows = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        SELECT id::text AS id FROM ${msgTable()}
        WHERE external_message_id = ${result.messageId}
          AND org_id = ${params.orgId}
        ORDER BY sent_at DESC NULLS LAST
        LIMIT 1
      `),
    )
    const sentMessageId = mailMsgRows[0]?.id
    if (sentMessageId) {
      await db.execute(drizzleSql`
        UPDATE ${KS}.files
        SET app = 'mail', entity_type = 'message', entity_id = ${sentMessageId}
        WHERE org_id = ${params.orgId}
          AND app = 'mail' AND entity_type = 'draft'
          AND entity_id = ${params.draftId}
          AND EXISTS (
            SELECT 1 FROM ${draftTable()} d
            WHERE d.id = ${params.draftId}
              AND d.org_id = ${params.orgId}
              AND d.created_by = ${params.userId}
          )
      `)
    }
  }

  // Delete draft only after send succeeds and attachments are reparented.
  await db.execute(drizzleSql`
    DELETE FROM ${draftTable()}
    WHERE id = ${params.draftId}
      AND org_id = ${params.orgId}
      AND created_by = ${params.userId}
  `)

  return result
}

export async function allowSenderImageDomain(
  db: RlsClient,
  params: { orgId: string; userId: string; accountId: string; senderDomain: string },
) {
  const normalizedDomain = normalizeSenderDomain(params.senderDomain)
  if (!normalizedDomain) {
    throw new HTTPException(400, { message: "Sender domain is required" })
  }

  const rows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT a.id, a.connected_account_id, ca.metadata
    FROM ${accTable()} a
    JOIN ${K()}.connected_accounts ca
      ON ca.id = a.connected_account_id
      AND ca.org_id = a.org_id
      AND ca.status = 'active'
    WHERE a.id = ${params.accountId}
      AND a.org_id = ${params.orgId}
      AND a.disconnected_at IS NULL
      AND (
        (a.owner_type = 'user' AND a.owner_id = ${params.userId})
        OR a.owner_type = 'org'
      )
    LIMIT 1
  `),
  )
  if (rows.length === 0) {
    throw new HTTPException(404, { message: "Account not found" })
  }

  const row = rows[0]
  const nextDomains = Array.from(
    new Set([...getAllowedImageSenderDomains(row.metadata, params.userId), normalizedDomain]),
  ).sort()
  const nextMetadata = setAllowedImageSenderDomains(row.metadata, params.userId, nextDomains)

  await db.execute(drizzleSql`
    UPDATE ${K()}.connected_accounts
    SET metadata = ${JSON.stringify(nextMetadata)}::jsonb, updated_at = now()
    WHERE id = ${row.connected_account_id}
      AND org_id = ${params.orgId}
  `)

  return { allowedImageSenderDomains: nextDomains }
}

/**
 * Per-account visibility override ('personal' | 'shared'). Defaults from
 * owner_type when null (user-owned = personal, org-owned = shared). Runs under
 * the caller's RLS context: the accounts table's personalScope policy means a
 * PERSONAL account is only writable by its owner, so only the owner can flip
 * their own mailbox to shared (an admin cannot expose it), while a shared/org
 * account is manageable by any mail:accounts:write holder who can see it.
 */
export async function setAccountVisibility(
  db: RlsClient,
  params: { orgId: string; accountId: string; visibility: "personal" | "shared" },
) {
  const rows = extractRows<{ id: string; visibility: string | null; owner_type: string }>(
    await db.execute(drizzleSql`
      UPDATE ${accTable()} SET visibility = ${params.visibility}, updated_at = now()
      WHERE id = ${params.accountId} AND org_id = ${params.orgId}
      RETURNING id, visibility, owner_type
    `),
  )
  if (rows.length === 0) throw new HTTPException(404, { message: "Account not found" })
  return rows[0]
}

export async function listAccounts(db: RlsClient, params: { orgId: string; userId: string }) {
  const rows = extractRows<any>(
    await db.execute(drizzleSql`
    SELECT
      a.*,
      ca.id AS connected_account_id_ref,
      ca.metadata AS connected_account_metadata,
      ca.status AS connected_account_status,
      ca.status_message AS connected_account_status_message,
      ca.app_name AS connected_account_app_name,
      ca.connection_name AS connected_account_connection_name,
      ca.provider_type AS connected_account_provider_type,
      ca.token_expires_at AS connected_account_token_expires_at,
      ca.refresh_token_encrypted AS connected_account_refresh_token_encrypted,
      unread_counts.unread_count
    FROM ${accTable()} a
    LEFT JOIN ${K()}.connected_accounts ca
      ON ca.id = a.connected_account_id AND ca.org_id = a.org_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS unread_count
      FROM ${convTable()} conversation
      WHERE conversation.org_id = a.org_id
        AND conversation.account_id = a.id
        AND conversation.status = 'open'
        AND conversation.is_read = false
    ) AS unread_counts ON true
    WHERE a.org_id = ${params.orgId}
      AND a.disconnected_at IS NULL
      AND (
        (a.owner_type = 'user' AND a.owner_id = ${params.userId})
        OR a.owner_type = 'org'
      )
    ORDER BY a.created_at ASC
  `),
  )
  const { classifyConnectionHealth } = await import("~/modules/apps/connections/attention")
  return rows.map((row: any) => ({
    id: row.id,
    connectedAccountId: row.connected_account_id_ref ?? row.connected_account_id,
    // Same classifier as the connection-health attention feed, so the mail
    // Settings page can show a "Re-authorize" state (OAuth revoked / scope
    // drift), not just protocol-level sync errors. Null when no kernel
    // account row backs this mailbox (legacy rows).
    connectionHealth: row.connected_account_id_ref
      ? ((): {
          status: "ok" | "needs_reconnect"
          reason?: string
          missingScopes?: string[]
          statusMessage?: string
        } => {
          const classified = classifyConnectionHealth({
            orgId: params.orgId,
            appName: row.connected_account_app_name ?? "mail",
            connectionName: row.connected_account_connection_name ?? "",
            status: row.connected_account_status ?? "",
            providerType: row.connected_account_provider_type ?? "",
            tokenExpiresAt: row.connected_account_token_expires_at
              ? new Date(row.connected_account_token_expires_at)
              : null,
            refreshTokenEncrypted: row.connected_account_refresh_token_encrypted ?? null,
            metadata: row.connected_account_metadata,
          })
          if (classified) {
            return {
              status: "needs_reconnect",
              reason: classified.reason,
              ...(classified.missingScopes?.length
                ? { missingScopes: classified.missingScopes }
                : {}),
              ...(row.connected_account_status_message
                ? { statusMessage: row.connected_account_status_message }
                : {}),
            }
          }
          if (row.connected_account_status === "active") return { status: "ok" }
          return { status: "needs_reconnect", reason: "disconnected" }
        })()
      : null,
    provider: row.provider,
    emailAddress: row.email_address,
    displayName: row.display_name ?? null,
    ownerType: row.owner_type,
    ownerId: row.owner_id ?? null,
    syncStatus: row.sync_status,
    lastSyncAt: row.last_sync_at ?? null,
    lastSyncError: row.last_sync_error ?? null,
    unreadCount: row.unread_count ?? 0,
    allowedImageSenderDomains: getAllowedImageSenderDomains(
      row.connected_account_metadata,
      params.userId,
    ),
    // Spec section 4.3. The web surface needs this to explain a personal
    // mailbox that has stopped fetching (MailEncryptionEnrollmentBanner);
    // without it a suspended mailbox just goes quiet. Null on a row read
    // before the column existed.
    encryptionState: row.encryption_state ?? null,
    // `to_private` / `to_managed` while the mailbox moves between encryption
    // modes, so its owner can see the move and finish it.
    encryptionConversion: row.encryption_conversion ?? null,
    // The first import of a large mailbox runs for a long time. The inbox
    // shows this count while it does (MailSyncProgressBanner), so "still
    // syncing" is visibly moving rather than a status word that never changes.
    messagesSynced: Number(row.sync_state?.messagesSynced ?? 0),
    // A mailbox whose sync keeps failing waits before the next try: when.
    nextRetryAt:
      typeof row.sync_state?.nextRetryAt === "string" ? row.sync_state.nextRetryAt : null,
    // What an IMAP mailbox keeps in step with its server (null for Gmail, or
    // before the first sync read the server's capabilities).
    serverSync:
      row.provider === "imap"
        ? imapSyncSummary(row.sync_state?.capabilities, row.sync_state)
        : null,
  }))
}
