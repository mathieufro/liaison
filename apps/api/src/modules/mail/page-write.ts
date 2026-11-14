// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mail sync's page write, host side, in ONE transaction.
//
// A sync delivers mail a page at a time (a Gmail list page, a history page, an
// IMAP batch). The sandboxed mail bundle fetches and normalizes the page and
// hands it here through `mail_writePage`; this writes it whole:
//
//   1. one lookup of the page's external ids   -> skip what is already stored
//   2. one lookup of the page's threads         -> which conversations exist
//   3. the senders -> contact ids, under the mailbox's policy (sender-contacts.ts)
//   4. one insert of the new conversations      (ON CONFLICT: a racing writer's
//   5. one insert of the new messages            row wins, never a duplicate)
//      sealed row by row for an armed personal mailbox, in this transaction
//   6. the roll-up of every conversation the page touched
//   7. the events: one per conversation, one per message (search indexing and
//      the new-mail notifier consume them)
//   8. a new reply asking to stop becomes an opt-out proposal (optout-wording.ts)
//
// WHY HOST SIDE AND ONE TRANSACTION. Each bridge call is its own transaction,
// so a page split across calls could be interrupted after its messages were
// stored and before they were counted and announced; the retry then found them
// stored and skipped them, and they stayed uncounted, unread-less, unindexed
// and unnotified forever. Here the messages, their conversation roll-up and
// their events commit together or not at all. The mailbox's ownership, its
// sealing and its contact policy are read from the account row, never taken
// from the sandbox, and the account whose policy applies is by construction the
// account the page is written into.
//
// What cannot be in the transaction is the work that talks to object storage
// or another queue: attachment import and envelope-triggered client jobs. A
// message that has such work is stored with `ingest_pending = true` and the
// bundle clears it (`mail_completeIngest`) once the work is done. A retried page
// finds a pending message stored, and returns it again (`resumed`) so the
// bundle finishes it; the Gmail page loops do not treat a pending message as
// stored, so it is re-fetched rather than skipped. The bundle skips the
// attachments already imported and enqueues triggered jobs with `dedupe`, so a
// resume repeats nothing. A message whose re-fetch has no work left is settled
// at once, and one that has failed INGEST_MAX_ATTEMPTS retries is settled with
// an error log, so a poison attachment cannot hold a mailbox's sync forever.
//
// Cost (bench:mail-sync, 10k messages): the import went from ~87k bridge calls
// and 140M sequentially scanned tuples to a few calls per page on the
// (org_id, account_id, external_*) indexes of migration 0116.

import { maskHtmlWithNote, maskPaymentSecrets, maskWithNote } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows } from "~/db"
import { sanitizeCustomerHtml } from "~/lib/email/sanitize"
import { evaluateAuthenticationResults, trustedAuthservIdsFor } from "~/lib/email/sender-auth"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { type OptOutCandidate, optOutPhraseIn, proposeOptOuts } from "~/modules/mail/optout-wording"
import { resolveSenderContacts } from "~/modules/mail/sender-contacts"
import {
  applyMailSealToRow,
  assertMailboxWritable,
  mailboxRequiresSealing,
  pointConversationAtMessage,
  resolveMailAccountCrypto,
  resolveSealRecipient,
} from "~/modules/mailbox-crypto/mail-writer"

const log = rootLogger.child({ module: "mail-page-write" })

/** Messages per page write. A sync page is 25; this bounds a hostile caller. */
export const PAGE_WRITE_MAX_MESSAGES = 100

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Which sync path stored a message (S16): the new-mail notifier keys on it. */
/**
 * Where a page comes from. `sent` is a message Liaison itself sent; `imap-sent`
 * is the IMAP Sent folder import (mail sent from the mailbox, in any client).
 */
export type MailSyncOrigin = "initial" | "incremental" | "imap" | "sent" | "imap-sent" | "reset"
const ORIGINS: ReadonlySet<string> = new Set([
  "initial",
  "incremental",
  "imap",
  "sent",
  "imap-sent",
  "reset",
])

/** A normalized message as the bundle's provider adapters produce it. */
export interface PageMessage {
  externalMessageId: string
  externalProviderId?: string | null
  externalThreadId: string
  from?: { email?: string; name?: string } | null
  to?: unknown[]
  cc?: unknown[]
  bcc?: unknown[]
  subject?: string | null
  textBody?: string | null
  htmlBody?: string | null
  snippet?: string | null
  headers?: Record<string, unknown>
  inReplyTo?: string | null
  references?: string[]
  labels?: string[]
  isRead?: boolean
  isStarred?: boolean
  sentAt?: string | null
  direction?: string
  sentByUserId?: string | null
  internalDate?: number | null
  /** Every `Authentication-Results` header value, topmost first (sender-auth.ts). */
  authenticationResults?: string[]
  /** How the message reached us; decides which authserv-ids are trusted. */
  receivedVia?: "gmail_api" | "imap"
  /** The bundle has post-commit work for it (attachments, envelope jobs). */
  postSteps?: boolean
}

/** A message the page stored now, or one an earlier run stored unfinished. */
export interface PageWriteEntry {
  messageId: string
  externalMessageId: string
  conversationId: string
  /** Stored by an earlier, interrupted run: its post-commit work is unfinished. */
  resumed: boolean
}

export interface PageWriteResult {
  entries: PageWriteEntry[]
  /** Set when nothing was written because the account is gone or disconnected. */
  refused?: "account_disconnected"
}

export interface MailEvent {
  entity: "conversation" | "message"
  action: "create" | "update"
  entityId: string
  data: Record<string, unknown>
}

export interface PageWriteDeps {
  tx: RlsClient
  schemaName: string
  orgId: string
  /** The bridge's acting identity (a sync is `system:mail:<job>`). */
  actorId: string
  /** Stamps and queues the events inside `tx`, as the bridge's `emit` would. */
  queueEvents: (events: MailEvent[]) => Promise<void>
}

// ── Pure helpers: the roll-up and the event shapes ───────────────────────────

/** Gmail categories that mean "sent to a list, not to you". */
const BULK_GMAIL_CATEGORIES = [
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
  "CATEGORY_UPDATES",
]

function headerOf(message: PageMessage, name: string): string | null {
  const headers = message.headers
  if (!headers || typeof headers !== "object") return null
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== name) continue
    const value = headers[key]
    return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "")
  }
  return null
}

/**
 * True when a message was sent in bulk or by a machine: a mailing list, a
 * newsletter, an auto-reply or a notifier. Its sender never becomes a contact.
 */
export function isBulkMessage(message: PageMessage): boolean {
  if (headerOf(message, "list-unsubscribe") !== null) return true
  if (headerOf(message, "list-id") !== null) return true
  const precedence = (headerOf(message, "precedence") ?? "").trim().toLowerCase()
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") return true
  const autoSubmitted = (headerOf(message, "auto-submitted") ?? "").trim().toLowerCase()
  if (autoSubmitted !== "" && autoSubmitted !== "no") return true
  return (message.labels ?? []).some((label) => BULK_GMAIL_CATEGORIES.includes(label))
}

/** A message's subject, bodies and snippet, masked in place, the bodies noted. */
function maskPageMessage(m: PageMessage): void {
  if (m.subject) m.subject = maskPaymentSecrets(m.subject).text
  if (m.textBody) m.textBody = maskWithNote(m.textBody).text
  if (m.htmlBody) m.htmlBody = maskHtmlWithNote(m.htmlBody).text
  if (m.snippet) m.snippet = maskPaymentSecrets(m.snippet).text
}

function sentAtMs(message: PageMessage): number {
  const ms = Date.parse(message.sentAt ?? "")
  return Number.isFinite(ms) ? ms : 0
}

function isInbound(message: PageMessage): boolean {
  return (message.direction ?? "inbound") === "inbound"
}

/** The first To address of a message, lowercased: `a@b`, `Name <a@b>` or `{ email }`. */
function firstRecipient(message: PageMessage): string | null {
  const first = message.to?.[0]
  const raw =
    typeof first === "string"
      ? first
      : first &&
          typeof first === "object" &&
          typeof (first as { email?: unknown }).email === "string"
        ? (first as { email: string }).email
        : ""
  const email = (/<([^<>]+)>/.exec(raw)?.[1] ?? raw).trim().toLowerCase()
  return email.includes("@") ? email : null
}

/**
 * The status a new conversation starts with. A thread the Sent folder import
 * finds with only the mailbox's own mail in it (its inbound half was archived
 * on the server before the mailbox was connected, or it was never answered) is
 * history, not work: it starts archived and shows in Sent, so a backfill of
 * years of sent mail does not flood the inbox. A reply joining it reopens it.
 */
export function newConversationStatus(
  messages: PageMessage[],
  origin: MailSyncOrigin,
): "open" | "archived" {
  return origin === "imap-sent" && messages.every((m) => !isInbound(m)) ? "archived" : "open"
}

/** The conversation state a roll-up starts from (null for a new conversation). */
export interface ConversationState {
  labels?: string[] | null
  is_read?: boolean
  is_starred?: boolean
  last_message_at?: string | Date | null
  snippet?: string | null
  status?: string | null
}

/**
 * The roll-up of a thread after `messages` join it.
 *
 * Read state follows Gmail and `recomputeConversationState` exactly: the
 * conversation is read only when every message in it is read. So a later label
 * change, which recomputes from the messages, can never flip it back. (Reading
 * a conversation marks its messages read; sending a reply does not.)
 *
 * The latest-message fields (time, snippet, sender) follow the newest message
 * and move only when a new message is at least as recent as the conversation's:
 * the initial import pages newest first, and an older message imported later
 * must not rewind them. Starred when any message is; labels unioned.
 */
export function threadRollup(
  messages: PageMessage[],
  current: ConversationState | null,
  sealing: boolean,
) {
  const byRecency = [...messages].sort((a, b) => sentAtMs(b) - sentAtMs(a))
  const latest = byRecency[0] as PageMessage
  const currentLast = current?.last_message_at
    ? new Date(current.last_message_at).getTime()
    : Number.NaN
  const newer = !current || !Number.isFinite(currentLast) || sentAtMs(latest) >= currentLast
  const inboundByRecency = byRecency.filter((m) => isInbound(m) && m.from?.email)
  const outboundByRecency = byRecency.filter((m) => !isInbound(m))
  const latestInbound = inboundByRecency[0]
  return {
    newer,
    latest,
    labels: [...new Set([...(current?.labels ?? []), ...messages.flatMap((m) => m.labels ?? [])])],
    isRead: (current ? Boolean(current.is_read) : true) && messages.every((m) => m.isRead ?? false),
    isStarred: Boolean(current?.is_starred) || messages.some((m) => m.isStarred ?? false),
    lastMessageAt: newer ? (latest.sentAt ?? null) : (current?.last_message_at ?? null),
    snippet: sealing ? null : newer ? latest.snippet || current?.snippet || null : null,
    // New mail that Gmail delivered to the inbox reopens an archived
    // conversation, as Gmail puts the thread back in the inbox. Trashed and
    // escalated conversations are left alone.
    reopens:
      current?.status === "archived" &&
      newer &&
      messages.some((m) => isInbound(m) && (m.labels ?? []).includes("INBOX")),
    fromEmail:
      latestInbound && (!Number.isFinite(currentLast) || sentAtMs(latestInbound) >= currentLast)
        ? String(latestInbound.from?.email).toLowerCase()
        : null,
    inboundByRecency,
    outboundByRecency,
  }
}

/**
 * The `message:create` event. S16: the origin plus the envelope facts the
 * new-email producer decides on. Labels, read state and Gmail's receipt time
 * are not content (Invariant K: no subject, body or snippet, ever).
 */
export function messageCreateEvent(
  message: PageMessage,
  messageId: string,
  conversationId: string,
  accountId: string,
  origin: MailSyncOrigin,
): MailEvent {
  const direction = message.direction ?? "inbound"
  return {
    entity: "message",
    action: "create",
    entityId: messageId,
    data: {
      id: messageId,
      conversationId,
      accountId,
      direction,
      from: message.from,
      origin,
      ...(direction === "inbound"
        ? {
            // The receiving provider's SPF/DKIM/DMARC verdict for the From
            // address. A routine's sender filter trusts the From only on "pass".
            senderAuth: evaluateAuthenticationResults(
              message.authenticationResults,
              message.from?.email,
              trustedAuthservIdsFor(message),
            ),
            labels: message.labels ?? [],
            isRead: message.isRead ?? false,
            internalDate: typeof message.internalDate === "number" ? message.internalDate : null,
          }
        : {}),
    },
  }
}

/**
 * Invariant K. An event payload is durable: it lands in `pending_events`, the
 * audit log and a timeline entry, and unlike a message row no purge heals it.
 * So a sealed mailbox's conversation events carry ids and metadata only; an
 * unencrypted mailbox's keep their subject / snippet as before.
 */
export function conversationCreateEvent(
  conversationId: string,
  accountId: string,
  subject: string | null | undefined,
  sealing: boolean,
): MailEvent {
  return {
    entity: "conversation",
    action: "create",
    entityId: conversationId,
    data: sealing ? { id: conversationId, accountId } : { id: conversationId, accountId, subject },
  }
}

export function conversationUpdateEvent(
  conversationId: string,
  accountId: string,
  state: {
    snippet: string | null
    messageCount: number
    isRead: boolean
    lastMessageAt: unknown
    status?: string
  },
  sealing: boolean,
): MailEvent {
  return {
    entity: "conversation",
    action: "update",
    entityId: conversationId,
    data: {
      id: conversationId,
      accountId,
      ...(sealing ? {} : { snippet: state.snippet }),
      messageCount: state.messageCount,
      isRead: state.isRead,
      lastMessageAt: state.lastMessageAt,
      ...(state.status ? { status: state.status } : {}),
    },
  }
}

// ── The write ────────────────────────────────────────────────────────────────

interface ThreadWrite {
  threadId: string
  messages: PageMessage[]
  current:
    | (ConversationState & { id: string; message_count: number; contact_id: string | null })
    | null
  conversationId: string | null
  created: boolean
  inserted: Array<{ message: PageMessage; id: string }>
}

function jsonb(value: unknown) {
  return drizzleSql`${JSON.stringify(value ?? null)}::jsonb`
}

function validate(messages: unknown): PageMessage[] {
  if (!Array.isArray(messages)) throw new Error("mail_writePage: messages must be an array")
  if (messages.length > PAGE_WRITE_MAX_MESSAGES) {
    throw new Error(`mail_writePage: at most ${PAGE_WRITE_MAX_MESSAGES} messages per page`)
  }
  for (const m of messages as PageMessage[]) {
    if (!m || typeof m.externalMessageId !== "string" || !m.externalMessageId) {
      throw new Error("mail_writePage: every message needs an externalMessageId")
    }
    if (typeof m.externalThreadId !== "string" || !m.externalThreadId) {
      throw new Error("mail_writePage: every message needs an externalThreadId")
    }
  }
  return messages as PageMessage[]
}

/**
 * After this many runs that found a message still pending, its post-commit work
 * is given up on: the message stays (it is counted, announced and readable),
 * the failure is logged, and the sync stops re-fetching it. Without a bound, a
 * message whose attachment can never be imported would be re-fetched by every
 * page that lists it, forever.
 */
export const INGEST_MAX_ATTEMPTS = 5

/**
 * The messages an earlier, interrupted run stored but did not finish. Each is
 * handed back to the bundle to finish, unless it no longer has post-commit work
 * (its page no longer asks for any: cleared now) or it has used its attempts
 * (cleared, and logged as ingested with an error).
 */
async function resumePending(
  deps: PageWriteDeps,
  schema: ReturnType<typeof drizzleSql.raw>,
  pending: Array<{ id: string; external_message_id: string; conversation_id: string }>,
  pageMessages: Map<string, PageMessage>,
): Promise<PageWriteEntry[]> {
  if (pending.length === 0) return []
  const rows = extractRows<{ id: string; attempts: number }>(
    await deps.tx.execute(drizzleSql`
      UPDATE ${schema}.messages
         SET ingest_attempts = COALESCE(ingest_attempts, 0) + 1
       WHERE org_id = ${deps.orgId}::uuid
         AND id IN (${drizzleSql.join(
           pending.map((r) => drizzleSql`${r.id}::uuid`),
           drizzleSql`, `,
         )})
      RETURNING id::text AS id, ingest_attempts AS attempts`),
  )
  const attemptsById = new Map(rows.map((r) => [r.id, Number(r.attempts)]))
  const entries: PageWriteEntry[] = []
  const settled: string[] = []
  for (const row of pending) {
    const message = pageMessages.get(row.external_message_id)
    const attempts = attemptsById.get(row.id) ?? 0
    if (message?.postSteps !== true) {
      settled.push(row.id)
      continue
    }
    if (attempts > INGEST_MAX_ATTEMPTS) {
      settled.push(row.id)
      log.error(
        { orgId: deps.orgId, messageId: row.id, attempts: attempts - 1 },
        "mail message ingested with an error: its attachments or envelope jobs failed on every attempt",
      )
      continue
    }
    entries.push({
      messageId: row.id,
      externalMessageId: row.external_message_id,
      conversationId: row.conversation_id,
      resumed: true,
    })
  }
  if (settled.length > 0) {
    await deps.tx.execute(drizzleSql`
      UPDATE ${schema}.messages SET ingest_pending = NULL
       WHERE org_id = ${deps.orgId}::uuid
         AND id IN (${drizzleSql.join(
           settled.map((id) => drizzleSql`${id}::uuid`),
           drizzleSql`, `,
         )})`)
  }
  return entries
}

export async function writeMailPage(
  deps: PageWriteDeps,
  input: { accountId: string; origin: string; messages: unknown },
): Promise<PageWriteResult> {
  const { tx, schemaName, orgId, actorId } = deps
  if (!ORIGINS.has(input.origin)) throw new Error(`mail_writePage: unknown origin ${input.origin}`)
  const origin = input.origin as MailSyncOrigin
  const page = validate(input.messages)
  const schema = drizzleSql.raw(quoteIdent(schemaName))

  // A disconnected (or deleted) mailbox takes no more mail: disconnecting deleted
  // its content, and a sync tick already in flight must not bring it back. The
  // row is locked FOR SHARE, so a disconnect purging it (which locks it FOR
  // UPDATE and marks it first) is either fully before this write or fully after
  // it. The lock is taken by the schema's `mail_lock_account` SECURITY DEFINER
  // helper (mailbox-crypto/post-sync-assertions.ts): a row lock under RLS needs
  // the UPDATE policy (mail:accounts:write), which a writer storing its own sent
  // reply does not hold, and the page was then refused as if the account were
  // gone. Visibility is still this transaction's own read below.
  await tx.execute(
    drizzleSql`SELECT ${drizzleSql.raw(`${quoteIdent(schemaName)}.mail_lock_account`)}(${orgId}::uuid, ${input.accountId}::uuid)`,
  )
  const live = extractRows<{ sync_status: string | null; disconnected_at: unknown }>(
    await tx.execute(drizzleSql`
      SELECT sync_status, disconnected_at FROM ${schema}.accounts
       WHERE org_id = ${orgId}::uuid AND id = ${input.accountId}::uuid`),
  )[0]
  if (!live || live.disconnected_at != null || live.sync_status === "disconnected") {
    log.info(
      { orgId, accountId: input.accountId, origin },
      "mail page write refused: the account is disconnected or gone",
    )
    return { entries: [], refused: "account_disconnected" }
  }

  // The account, its sealing and its policy: from its row, never the sandbox.
  const account = await resolveMailAccountCrypto(tx, schemaName, orgId, input.accountId)
  assertMailboxWritable(account, "mail_writePage")
  // Sealed when the database guard is armed (the owner holds, or once held, a
  // mailbox identity) OR the mailbox says it is `ready`: a `ready` mailbox
  // whose owner has no usable key must fail the seal (and be blocked by the
  // bundle), never quietly take plaintext because the guard is not armed.
  const sealing =
    mailboxRequiresSealing(account) ||
    (account.ownerType === "user" &&
      (account.encryptionState === "ready" || account.encryptionState === "managed"))
  const recipient = sealing ? resolveSealRecipient(account, actorId) : null
  const accountId = account.id

  // 1. What is new, and what an earlier run stored without finishing.
  const seen = new Set<string>()
  const candidates = page.filter(
    (m) => !seen.has(m.externalMessageId) && seen.add(m.externalMessageId),
  )
  if (candidates.length === 0) return { entries: [] }
  const storedRows = extractRows<{
    id: string
    external_message_id: string
    conversation_id: string
    ingest_pending: boolean | null
  }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, external_message_id, conversation_id::text AS conversation_id,
             ingest_pending
        FROM ${schema}.messages
       WHERE org_id = ${orgId}::uuid AND account_id = ${accountId}::uuid
         AND external_message_id IN (${drizzleSql.join(
           [...seen].map((id) => drizzleSql`${id}`),
           drizzleSql`, `,
         )})`),
  )
  const stored = new Set(storedRows.map((r) => r.external_message_id))
  const entries = await resumePending(
    deps,
    schema,
    storedRows.filter((r) => r.ingest_pending === true),
    new Map(candidates.map((m) => [m.externalMessageId, m])),
  )
  const fresh = candidates.filter((m) => !stored.has(m.externalMessageId))
  if (fresh.length === 0) return { entries }

  // Card numbers and payment keys are masked in the page itself, before the
  // rows, the conversation rollup, the index and the triggered jobs read it. A
  // sealed mailbox is the documented exception: the server never stores its
  // plaintext, and its text is masked where the agent reads it instead
  // (agent/mailbox-plaintext).
  if (!sealing) for (const m of fresh) maskPageMessage(m)

  // 2. The page's threads.
  const threads = new Map<string, ThreadWrite>()
  for (const message of fresh) {
    let thread = threads.get(message.externalThreadId)
    if (!thread) {
      thread = {
        threadId: message.externalThreadId,
        messages: [],
        current: null,
        conversationId: null,
        created: false,
        inserted: [],
      }
      threads.set(message.externalThreadId, thread)
    }
    thread.messages.push(message)
  }
  const readConversations = async (threadIds: string[]) =>
    extractRows<NonNullable<ThreadWrite["current"]> & { external_thread_id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, external_thread_id, contact_id::text AS contact_id, labels,
               is_read, is_starred, last_message_at, message_count, snippet, status
          FROM ${schema}.conversations
         WHERE org_id = ${orgId}::uuid AND account_id = ${accountId}::uuid
           AND external_thread_id IN (${drizzleSql.join(
             threadIds.map((id) => drizzleSql`${id}`),
             drizzleSql`, `,
           )})
         FOR UPDATE`),
    )
  for (const row of await readConversations([...threads.keys()])) {
    const thread = threads.get(row.external_thread_id)
    if (!thread) continue
    thread.current = row
    thread.conversationId = row.id
  }

  // 3. Senders -> contacts, under THIS account's policy.
  const senders = new Map<string, { email: string; name?: string; bulk: boolean }>()
  for (const m of fresh) {
    if (!isInbound(m) || !m.from?.email) continue
    const email = String(m.from.email).toLowerCase()
    const seenSender = senders.get(email)
    senders.set(email, {
      email,
      name: seenSender?.name ?? m.from.name,
      bulk: Boolean(seenSender?.bulk) || isBulkMessage(m),
    })
  }
  const contactByEmail =
    senders.size > 0
      ? await resolveSenderContacts(
          orgId,
          actorId,
          { id: accountId, ownerType: account.ownerType, ownerId: account.ownerId },
          [...senders.values()],
        )
      : {}
  // Mail the mailbox sent links to the contact it was addressed to (its first
  // To recipient), found the same way and under the same policy as a sender,
  // but never created: a thread with an inbound sender links to the sender.
  const recipients = new Set<string>()
  for (const m of fresh) {
    const email = isInbound(m) ? null : firstRecipient(m)
    if (email && !contactByEmail[email]) recipients.add(email)
  }
  const contactByRecipient =
    recipients.size > 0
      ? await resolveSenderContacts(
          orgId,
          actorId,
          { id: accountId, ownerType: account.ownerType, ownerId: account.ownerId },
          [...recipients].map((email) => ({ email })),
          { create: false },
        )
      : {}
  const contactFor = (rollup: {
    inboundByRecency: PageMessage[]
    outboundByRecency: PageMessage[]
  }): string | null => {
    for (const m of rollup.inboundByRecency) {
      const id = m.from?.email ? contactByEmail[String(m.from.email).toLowerCase()] : undefined
      if (id) return id
    }
    for (const m of rollup.outboundByRecency) {
      const email = firstRecipient(m)
      const id = email ? (contactByEmail[email] ?? contactByRecipient[email]) : undefined
      if (id) return id
    }
    return null
  }

  // 4. New conversations. Provisional roll-up of every page message; step 6
  //    corrects it if another writer stored one of them first.
  const toCreate = [...threads.values()].filter((t) => !t.current)
  if (toCreate.length > 0) {
    const tuples = toCreate.map((thread) => {
      const rollup = threadRollup(thread.messages, null, sealing)
      const first = [...thread.messages].sort((a, b) => sentAtMs(a) - sentAtMs(b))[0] as PageMessage
      const status = newConversationStatus(thread.messages, origin)
      return drizzleSql`(${orgId}::uuid, ${accountId}::uuid, ${account.ownerType}, ${account.ownerId}::uuid,
        ${thread.threadId}, ${sealing ? null : first.subject || null}, ${sealing ? null : rollup.snippet},
        ${rollup.fromEmail}, ${contactFor(rollup)}::uuid, ${status}, ${jsonb(rollup.labels)},
        ${rollup.isRead}, ${rollup.isStarred}, ${rollup.lastMessageAt}::timestamptz, ${thread.messages.length})`
    })
    const created = extractRows<{ id: string; external_thread_id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${schema}.conversations
          (org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet, from_email,
           contact_id, status, labels, is_read, is_starred, last_message_at, message_count)
        VALUES ${drizzleSql.join(tuples, drizzleSql`, `)}
        ON CONFLICT (org_id, account_id, external_thread_id) DO NOTHING
        RETURNING id::text AS id, external_thread_id`),
    )
    for (const row of created) {
      const thread = threads.get(row.external_thread_id)
      if (!thread) continue
      thread.conversationId = row.id
      thread.created = true
    }
    // A thread another writer created meanwhile: adopt its conversation.
    const raced = toCreate.filter((t) => !t.conversationId).map((t) => t.threadId)
    if (raced.length > 0) {
      for (const row of await readConversations(raced)) {
        const thread = threads.get(row.external_thread_id)
        if (!thread) continue
        thread.current = row
        thread.conversationId = row.id
      }
    }
  }

  // 5. Messages. A sealed row goes in with every guarded column NULL (the
  //    Invariant P trigger permits it) and is sealed against its own id in
  //    this same transaction: a seal failure rolls the whole page back.
  const writable = [...threads.values()].filter((t) => t.conversationId)
  const messageTuples = writable.flatMap((thread) =>
    thread.messages.map((m) => {
      const html =
        !sealing && typeof m.htmlBody === "string" && isInbound(m)
          ? sanitizeCustomerHtml(m.htmlBody)
          : (m.htmlBody ?? null)
      return drizzleSql`(${orgId}::uuid, ${thread.conversationId}::uuid, ${accountId}::uuid,
        ${m.externalMessageId}, ${m.externalProviderId ?? null}, ${m.inReplyTo || null},
        ${jsonb(m.references ?? [])}, ${jsonb(m.from ?? {})}, ${jsonb(m.to ?? [])}, ${jsonb(m.cc ?? [])},
        ${jsonb(m.bcc ?? [])}, ${sealing ? null : m.subject || null}, ${sealing ? null : m.textBody || null},
        ${sealing ? null : html || null}, ${sealing ? null : m.snippet || null}, ${m.isRead ?? false},
        ${m.isStarred ?? false}, ${jsonb(m.labels ?? [])}, ${m.direction ?? "inbound"},
        ${m.sentAt ?? null}::timestamptz, now(), ${jsonb(sealing ? {} : (m.headers ?? {}))},
        ${account.ownerType}, ${account.ownerId}::uuid,
        ${typeof m.sentByUserId === "string" && UUID.test(m.sentByUserId) ? m.sentByUserId : null}::uuid,
        ${m.postSteps === true ? true : null})`
    }),
  )
  if (messageTuples.length > 0) {
    const insertedRows = extractRows<{ id: string; external_message_id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${schema}.messages
          (org_id, conversation_id, account_id, external_message_id, external_provider_id,
           in_reply_to, message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
           subject, text_body, html_body, snippet, is_read, is_starred, labels, direction, sent_at,
           synced_at, raw_headers, owner_type, owner_id, sent_by_user_id, ingest_pending)
        VALUES ${drizzleSql.join(messageTuples, drizzleSql`, `)}
        ON CONFLICT (org_id, account_id, external_message_id) DO NOTHING
        RETURNING id::text AS id, external_message_id`),
    )
    const idByExternal = new Map(insertedRows.map((r) => [r.external_message_id, r.id]))
    for (const thread of writable) {
      for (const message of thread.messages) {
        const id = idByExternal.get(message.externalMessageId)
        if (id) thread.inserted.push({ message, id })
      }
    }
  }
  if (sealing && recipient) {
    for (const thread of writable) {
      for (const { message, id } of thread.inserted) {
        await applyMailSealToRow(tx, {
          schemaName,
          orgId,
          userId: recipient,
          account,
          entity: "messages",
          rowId: id,
          values: {
            subject: message.subject || null,
            textBody: message.textBody || null,
            htmlBody: message.htmlBody || null,
            snippet: message.snippet || null,
          },
          headers: message.headers ?? {},
        })
      }
    }
  }

  // 6 + 7. Roll-ups and events.
  const conversationEvents: MailEvent[] = []
  const messageEvents: MailEvent[] = []
  for (const thread of writable) {
    if (thread.inserted.length === 0) continue
    const conversationId = thread.conversationId as string
    const added = thread.inserted.map((e) => e.message)
    const latestId = (() => {
      let best = thread.inserted[0] as { message: PageMessage; id: string }
      for (const e of thread.inserted) if (sentAtMs(e.message) >= sentAtMs(best.message)) best = e
      return best.id
    })()
    if (thread.created) {
      const rollup = threadRollup(added, null, sealing)
      if (added.length !== thread.messages.length) {
        await tx.execute(drizzleSql`
          UPDATE ${schema}.conversations
             SET message_count = ${added.length}, labels = ${jsonb(rollup.labels)},
                 is_read = ${rollup.isRead}, is_starred = ${rollup.isStarred},
                 last_message_at = ${rollup.lastMessageAt}::timestamptz,
                 snippet = ${sealing ? null : rollup.snippet}, updated_at = now()
           WHERE id = ${conversationId}::uuid AND org_id = ${orgId}::uuid`)
      }
      if (sealing) await pointConversationAtMessage(tx, schemaName, orgId, conversationId, latestId)
      const first = [...added].sort((a, b) => sentAtMs(a) - sentAtMs(b))[0] as PageMessage
      conversationEvents.push(
        conversationCreateEvent(conversationId, accountId, first.subject, sealing),
      )
    } else {
      const current = thread.current as NonNullable<ThreadWrite["current"]>
      const rollup = threadRollup(added, current, sealing)
      const messageCount = Number(current.message_count ?? 0) + added.length
      const contactId = current.contact_id ? null : contactFor(rollup)
      const snippet = rollup.newer ? rollup.snippet : (current.snippet ?? null)
      await tx.execute(drizzleSql`
        UPDATE ${schema}.conversations
           SET message_count = ${messageCount}, labels = ${jsonb(rollup.labels)},
               is_read = ${rollup.isRead}, is_starred = ${rollup.isStarred},
               last_message_at = ${rollup.lastMessageAt}::timestamptz,
               ${sealing || !rollup.newer ? drizzleSql`` : drizzleSql`snippet = ${snippet},`}
               ${rollup.fromEmail ? drizzleSql`from_email = ${rollup.fromEmail},` : drizzleSql``}
               ${contactId ? drizzleSql`contact_id = ${contactId}::uuid,` : drizzleSql``}
               ${rollup.reopens ? drizzleSql`status = 'open',` : drizzleSql``}
               updated_at = now()
         WHERE id = ${conversationId}::uuid AND org_id = ${orgId}::uuid`)
      if (sealing && rollup.newer) {
        await pointConversationAtMessage(tx, schemaName, orgId, conversationId, latestId)
      }
      // A reply the user sent (origin `sent`) reads what it answered.
      const replies =
        origin === "sent" || origin === "imap-sent" ? added.filter((m) => !isInbound(m)) : []
      const isRead =
        replies.length > 0
          ? await markConversationReadThrough(
              tx,
              schemaName,
              orgId,
              conversationId,
              [...replies].sort((a, b) => sentAtMs(b) - sentAtMs(a))[0]?.sentAt ?? null,
            )
          : rollup.isRead
      conversationEvents.push(
        conversationUpdateEvent(
          conversationId,
          accountId,
          {
            snippet,
            messageCount,
            isRead,
            lastMessageAt: rollup.lastMessageAt,
            ...(rollup.reopens ? { status: "open" } : {}),
          },
          sealing,
        ),
      )
    }
    for (const { message, id } of thread.inserted) {
      messageEvents.push(messageCreateEvent(message, id, conversationId, accountId, origin))
      entries.push({
        messageId: id,
        externalMessageId: message.externalMessageId,
        conversationId,
        resumed: false,
      })
    }
  }
  // Conversation events first: a consumer of a message event may look up its
  // conversation.
  await deps.queueEvents([...conversationEvents, ...messageEvents])

  // 8. A reply asking to stop: a proposal for a person, never an opt-out by itself. Plaintext
  //    mail of a person only (a sealed body is unreadable, a list or a machine is not a person),
  //    whose sender the receiving provider did not find forged, and only mail arriving now: a
  //    backfill of old history raises nothing.
  if (!sealing && origin !== "initial" && origin !== "reset") {
    const asked: OptOutCandidate[] = []
    for (const thread of writable) {
      for (const { message, id } of thread.inserted) {
        if (!isInbound(message) || isBulkMessage(message) || !message.from?.email) continue
        const auth = evaluateAuthenticationResults(
          message.authenticationResults,
          message.from.email,
          trustedAuthservIdsFor(message),
        )
        if (auth === "fail") continue
        const sent = Date.parse(message.sentAt ?? "")
        if (Number.isFinite(sent) && sent < Date.now() - OPT_OUT_RECENT_MS) continue
        try {
          if (optOutPhraseIn(message.textBody))
            asked.push({ email: message.from.email, messageId: id })
        } catch (err) {
          log.error({ err, orgId, accountId }, "opt-out reply: the text could not be read")
        }
      }
    }
    if (asked.length > 0) {
      await proposeOptOuts(
        orgId,
        { id: accountId, ownerType: account.ownerType, ownerId: account.ownerId },
        asked,
      )
    }
  }
  return { entries }
}

/** A reply older than this, synced late, raises no opt-out proposal: it is history. */
const OPT_OUT_RECENT_MS = 30 * 24 * 60 * 60 * 1000

/**
 * A reply the user sent reads the conversation up to it: they obviously saw
 * what they answered. Every message at or before the reply is marked read (and
 * loses Gmail's UNREAD label locally), then the conversation's read state is
 * recomputed with the one rule used everywhere, "read when every message is
 * read". A message that arrived after the reply keeps it unread, and a later
 * label recompute derives the same answer, so nothing flips back.
 * Returns the conversation's read state.
 */
export async function markConversationReadThrough(
  tx: Pick<RlsClient, "execute">,
  schemaName: string,
  orgId: string,
  conversationId: string,
  throughSentAt: string | Date | null,
): Promise<boolean> {
  const schema = drizzleSql.raw(quoteIdent(schemaName))
  await tx.execute(drizzleSql`
    UPDATE ${schema}.messages
       SET is_read = true, labels = labels - 'UNREAD', updated_at = now()
     WHERE org_id = ${orgId}::uuid AND conversation_id = ${conversationId}::uuid
       AND is_read = false
       AND (${throughSentAt}::timestamptz IS NULL OR sent_at IS NULL OR sent_at <= ${throughSentAt}::timestamptz)`)
  const [row] = extractRows<{ is_read: boolean }>(
    await tx.execute(drizzleSql`
      UPDATE ${schema}.conversations c
         SET is_read = NOT EXISTS (
               SELECT 1 FROM ${schema}.messages m
                WHERE m.org_id = c.org_id AND m.conversation_id = c.id AND m.is_read = false),
             updated_at = now()
       WHERE c.id = ${conversationId}::uuid AND c.org_id = ${orgId}::uuid
      RETURNING c.is_read`),
  )
  return row?.is_read ?? true
}

/** Clear `ingest_pending` once the bundle has finished a message's post-commit work. */
export async function completeMailIngest(
  deps: Pick<PageWriteDeps, "tx" | "schemaName" | "orgId">,
  input: { accountId: string; messageIds: unknown },
): Promise<number> {
  const ids = Array.isArray(input.messageIds)
    ? input.messageIds.filter((id): id is string => typeof id === "string" && UUID.test(id))
    : []
  if (ids.length === 0) return 0
  const rows = extractRows<{ id: string }>(
    await deps.tx.execute(drizzleSql`
      UPDATE ${drizzleSql.raw(quoteIdent(deps.schemaName))}.messages
         SET ingest_pending = NULL
       WHERE org_id = ${deps.orgId}::uuid AND account_id = ${input.accountId}::uuid
         AND ingest_pending = true
         AND id IN (${drizzleSql.join(
           ids.map((id) => drizzleSql`${id}::uuid`),
           drizzleSql`, `,
         )})
      RETURNING id`),
  )
  return rows.length
}
