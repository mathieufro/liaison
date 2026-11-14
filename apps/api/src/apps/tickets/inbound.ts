// SPDX-License-Identifier: FSL-1.1-ALv2

import { randomUUID } from "node:crypto"
import {
  maskHtmlWithNote,
  maskPaymentSecrets,
  maskWithNote,
  PUBLIC_EMAIL_PROVIDERS,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { lookupTicketIdByHandle } from "~/apps/tickets/display-handle"
import { detectAutoResponder } from "~/apps/tickets/inbound-auto-responder"
import { recordInboundOnTicket } from "~/apps/tickets/inbound-record"
import {
  collectRecipients,
  loadRoutingCandidates,
  type RoutableInbox,
  resolveInboxForMessage,
} from "~/apps/tickets/inbound-routing"
import { extractWhitelistedTransferLinks } from "~/apps/tickets/link-ingest-scan"
import {
  addParticipantsFromTrustedSender,
  isTicketParty,
  loadTicketParties,
  recordRelatedTicketNote,
} from "~/apps/tickets/participants"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import { isSelfSendEcho } from "~/apps/tickets/self-send-marker"
import { validateAndApply } from "~/apps/tickets/state-machine"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { putObject, sanitizeFilename } from "~/infra/storage/object-storage"
import { quarantineStorageKey, scanInboundAttachment } from "~/lib/clamav"
import { sanitizeCustomerHtml } from "~/lib/email/sanitize"
import { type SenderAuth, senderAuthOf } from "~/lib/email/sender-auth"
import type { ParsedAttachment, ParsedEmail } from "~/lib/email/types"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { checkRateLimit } from "~/middleware/rate-limiter"
import { TRANSFER_HOST_WHITELIST } from "~/modules/agent/media/media-analysis-constants"
import { loadAllowedMailDomains } from "~/modules/apps/connections/mail-domains"
import { resolveContact } from "~/modules/contacts/service"
import { senderAuthForRules } from "~/modules/contacts/trusted-senders"
import { emitSecurityEvent } from "~/modules/security/security-events"

export type InboxRow = {
  id: string
  org_id: string
  email_address: string
  default_team?: string | null
  default_audience?: string | null
  default_sensitivity?: "internal" | "confidential" | "restricted" | null
}

export type TicketsServiceCtx = {
  db: RlsClient
  orgId: string
  /** Set when `db` is a privileged transaction (a mailbox sync's ingest): every privileged
   *  read of the ingest (settings, trusted senders, mail domains, the ID segment) then runs on
   *  it, never on a second privileged connection (privileged-read.ts). */
  privilegedTx?: PrivilegedDb
  /** Never acknowledge a ticket this ingest opens: set by a first (backfill)
   *  mailbox sync and by every import or seed path, whose mail did not just
   *  arrive. */
  noAcknowledgement?: boolean
}

/** Mail this much older (or newer) than now is not "just arrived": no acknowledgement. */
export const ACK_MAX_MESSAGE_AGE_MS = 2 * 60 * 60 * 1000

/**
 * Whether the message reached us recently enough to acknowledge. The first
 * sync of a newly connected mailbox ingests weeks of history, and a delayed
 * retry can carry old mail: thanking a customer for a request they sent last
 * month is wrong. A message with no usable date is not acknowledged.
 */
export function isRecentForAcknowledgement(raw: ParsedEmail, now = Date.now()): boolean {
  const stamp = raw.receivedAt ?? raw.sentAt
  const at = stamp ? Date.parse(stamp) : Number.NaN
  return Number.isFinite(at) && Math.abs(now - at) <= ACK_MAX_MESSAGE_AGE_MS
}

/** Mail older than this is history when a mailbox catches up: no new-ticket notice. */
export const NEW_TICKET_NOTICE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Whether a ticket opened from this mail is news for a "Notify on new ticket"
 * inbox. Not a first (backfill) sync's history, and not a thread we opened by
 * writing first. Deliberately wider than the acknowledgement's window: staff
 * still want to hear of mail that waited out an outage. An undated message counts.
 */
export function isNewTicketNews(
  raw: ParsedEmail,
  direction: MessageDirection,
  backfill: boolean,
  now = Date.now(),
): boolean {
  if (backfill || direction !== "inbound") return false
  const at = Date.parse(raw.receivedAt ?? raw.sentAt ?? "")
  return !Number.isFinite(at) || now - at <= NEW_TICKET_NOTICE_MAX_AGE_MS
}

export type MatcherResult =
  | { outcome: "appended"; ticketId: string; messageId: string }
  | { outcome: "created"; ticketId: string; messageId: string }
  | { outcome: "dropped"; reason: string }
  | { outcome: "rerouted"; target: "mail_conversation"; conversationId: string }
  | { error: { code: string; retryable: boolean; message: string } }

const TOKEN_REGEX = /\+tkt_([a-zA-Z0-9]+)@/i
const HANDLE_REGEX = /\[#([a-zA-Z0-9_-]+)\]/

export type MessageDirection = "inbound" | "outbound"

// Public mailbox providers: for an org whose SUPPORT mailbox is hosted on one of
// these, the mailbox domain is shared with the whole world, so "same domain as
// the mailbox" says nothing about who sent a message — a customer @gmail.com is
// not a colleague. We fall back to exact-address matching for these, and never
// treat one as an own domain even when it is configured. For an org on its OWN
// domain (the common case: support@acme.com) a From on that domain claims to be
// a teammate; see resolveSyncedDirection for the evidence that claim needs.
// The list (PUBLIC_EMAIL_PROVIDERS) lives in @liaison/shared, beside the trusted-senders rule.

function domainOf(email: string | undefined): string | null {
  const at = email?.lastIndexOf("@") ?? -1
  return at >= 0
    ? (email as string)
        .slice(at + 1)
        .trim()
        .toLowerCase()
    : null
}

/**
 * The mailbox sync (`sync.ts`) lists the WHOLE mailbox (`q: after:<ts>`, no
 * `in:inbox` filter) and routes every message through this inbound pipeline —
 * so a message WE sent (an agent reply made outside Liaison, e.g. the legacy
 * Freshdesk replies still sitting in the mailbox, or the Sent copy of a Liaison
 * reply) arrives here too. A message authored by us is OUTBOUND (staff), not
 * inbound.
 *
 * A message CLAIMS to be ours when its From is the synced mailbox address, or an
 * address on one of the org's own domains: the domains the org configured for
 * its mailboxes (`organizations.settings.allowedMailDomains`, see
 * `modules/apps/connections/mail-domains.ts`) plus the synced mailbox's own
 * domain. A public provider's domain (gmail.com, outlook.com, ...) is never an
 * own domain, whatever is configured: every customer shares it.
 *
 * The From header is whatever the sender typed, so a claim alone grants
 * nothing. A message that claims to be ours is staff ONLY when:
 *   (a) the receiving provider's trusted verdict (the topmost
 *       Authentication-Results header, from a trusted authserv-id; see
 *       `lib/email/sender-auth.ts`) is a pass for its From domain, or
 *   (b) it was fetched through the Gmail API from the org's own synced mailbox
 *       and carries that mailbox's SENT label (Gmail metadata, not a header).
 * Anything else stays a customer message: a forged "From: alex@ourdomain"
 * gains no authority, and neither does an unauthenticated colleague.
 */
export function resolveSyncedDirection(
  raw: ParsedEmail,
  inbox: InboxRow,
  orgMailDomains: readonly string[] = [],
): MessageDirection {
  const from = raw.from?.email?.trim().toLowerCase()
  const self = inbox.email_address?.trim().toLowerCase()
  if (!from || !self) return "inbound"
  const fromDomain = domainOf(from)
  const ownDomains = new Set(
    [domainOf(self), ...orgMailDomains.map((d) => d.trim().toLowerCase().replace(/^@/, ""))]
      .filter((d): d is string => Boolean(d))
      .filter((d) => !PUBLIC_EMAIL_PROVIDERS.has(d)),
  )
  const claimsToBeUs = from === self || Boolean(fromDomain && ownDomains.has(fromDomain))
  if (!claimsToBeUs) return "inbound"
  if (raw.receivedVia === "gmail_api" && raw.labelIds?.includes("SENT")) return "outbound"
  if (senderAuthOf(raw) === "pass") return "outbound"
  return "inbound"
}

const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The org's configured mail domains (none for a unit test's synthetic org id), read on the
 * ingest's privileged transaction when it has one: it takes no second privileged slot.
 */
async function loadOrgMailDomains(orgId: string, on?: PrivilegedDb): Promise<string[]> {
  if (!ORG_UUID_RE.test(orgId)) return []
  return loadAllowedMailDomains(orgId, on)
}

// Community/forum notification emails ("[New Reply] in <topic>", "[New Topic] in
// <forum>", localised) that a helpdesk (e.g. Freshdesk) sends FROM the support
// address TO the synced mailbox. They are activity notifications, not customer
// requests -- and because they are self-sent (From == the mailbox) with no
// existing thread to append to, they otherwise open junk tickets whose contact
// is the support address itself (the same self-sent-opens-a-ticket path agent
// replies use). Drop them at ingest, the same class of guard as
// detectAutoResponder. Matches the bracketed forum-activity prefix across the
// languages the helpdesk emits (subject is localised to the notified user).
const FORUM_NOTIFICATION_SUBJECT =
  /^\s*\[(new reply|new topic|new post|neue antwort|neues thema|nieuwe reactie|nieuw onderwerp|nouvelle réponse|nouveau sujet|nueva respuesta|nuevo tema|nuova risposta|nuovo argomento)\]/i

export function detectForumNotification(raw: ParsedEmail): boolean {
  return FORUM_NOTIFICATION_SUBJECT.test(raw.subject ?? "")
}

/**
 * Reply tokens named in the recipient addresses. Tokens are minted upper-case
 * base32, and mail clients and servers freely change the case of an address, so
 * every token is matched in its minted (upper) case as well as as written.
 */
export function extractTokens(emails: string[]): string[] {
  const tokens: string[] = []
  for (const email of emails ?? []) {
    const m = TOKEN_REGEX.exec(email)
    if (!m) continue
    for (const t of [m[1].toUpperCase(), m[1]]) if (!tokens.includes(t)) tokens.push(t)
  }
  return tokens
}

type TicketCandidate = {
  id: string
  status: string
  closed_reason: string | null
  merged_into_ticket_id: string | null
  converted_to_mail_conversation_id: string | null
  first_response_at: string | null
}

async function lookupTicketById(
  ctx: TicketsServiceCtx,
  ticketId: string,
): Promise<TicketCandidate | null> {
  const r = await ctx.db.execute(drizzleSql`
    SELECT id, status, closed_reason, merged_into_ticket_id,
           converted_to_mail_conversation_id, first_response_at
    FROM ${ticketsRel("tickets")}
    WHERE id = ${ticketId} AND org_id = ${ctx.orgId}
    LIMIT 1
  `)
  return extractRows<TicketCandidate>(r)[0] ?? null
}

async function resolveLeaf(
  ctx: TicketsServiceCtx,
  candidate: TicketCandidate,
): Promise<TicketCandidate> {
  if (!candidate.merged_into_ticket_id) return candidate
  const leaf = await lookupTicketById(ctx, candidate.merged_into_ticket_id)
  return leaf ?? candidate
}

async function lookupByToken(
  ctx: TicketsServiceCtx,
  tokens: string[],
): Promise<TicketCandidate | null> {
  if (tokens.length === 0) return null
  const inList = drizzleSql.join(
    tokens.map((t) => drizzleSql`${t}`),
    drizzleSql`, `,
  )
  const r = await ctx.db.execute(drizzleSql`
    SELECT id, status, closed_reason, merged_into_ticket_id,
           converted_to_mail_conversation_id, first_response_at
    FROM ${ticketsRel("tickets")}
    WHERE org_id = ${ctx.orgId} AND reply_token IN (${inList})
    LIMIT 1
  `)
  return extractRows<TicketCandidate>(r)[0] ?? null
}

/**
 * The ticket a reference names. `ours` says whether it matched a message WE sent (its Message-ID
 * is ours, and only the people we sent it to know it) or only a message a customer sent us (its id
 * was minted by the customer's client, and anyone they copied, or a predictable client, knows it).
 * A match on one of ours wins over a match on a customer's.
 */
async function lookupByExternalMessageIds(
  ctx: TicketsServiceCtx,
  ids: string[],
): Promise<{ ticketId: string; ours: boolean } | null> {
  if (ids.length === 0) return null
  const inList = drizzleSql.join(
    ids.map((id) => drizzleSql`${id}`),
    drizzleSql`, `,
  )
  const r = await ctx.db.execute(drizzleSql`
    SELECT ticket_id, (kind = 'outbound') AS ours FROM ${ticketsRel("messages")}
    WHERE org_id = ${ctx.orgId} AND external_message_id IN (${inList})
    ORDER BY (kind = 'outbound') DESC
    LIMIT 1
  `)
  const row = extractRows<{ ticket_id: string; ours: boolean }>(r)[0]
  return row ? { ticketId: row.ticket_id, ours: row.ours === true } : null
}

async function lookupByHandle(
  ctx: TicketsServiceCtx,
  handle: string,
): Promise<TicketCandidate | null> {
  // `[#ticket-12]` (an old subject) and `[#ticket-B2B-12]` (the display form,
  // whatever the segment is now) name the same ticket: resolve by number,
  // exact stored match first. Anything else keeps the exact-match lookup.
  const id = await lookupTicketIdByHandle(ctx.db, ctx.orgId, handle)
  const where = id ? drizzleSql`id = ${id}` : drizzleSql`handle = ${handle}`
  const r = await ctx.db.execute(drizzleSql`
    SELECT id, status, closed_reason, merged_into_ticket_id,
           converted_to_mail_conversation_id, first_response_at
    FROM ${ticketsRel("tickets")}
    WHERE org_id = ${ctx.orgId} AND ${where}
    LIMIT 1
  `)
  return extractRows<TicketCandidate>(r)[0] ?? null
}

// Reply/forward subject prefixes across the mail clients we see (EN Re/Fw/Fwd,
// FR TR/RE, DE AW/WG, ES/IT R/RV/RIF/I, NL Antw, SV/NO/DA SV/VS/VB), with the
// optional bracketed counter some clients add ("Re[2]:"). Stripped repeatedly —
// "Re: TR: Re: x" normalizes to "x".
const REPLY_PREFIX_RE = /^\s*(re|fw|fwd|tr|aw|wg|sv|vs|vb|antw|rif|rv|r|i)\s*(\[\d+\])?\s*:\s*/i

// A normalized subject must carry at least this much text to be trusted as a
// thread key — "Re: hi" / "Re: help" style subjects collide across unrelated
// conversations from the same contact.
const SUBJECT_FALLBACK_MIN_LENGTH = 8

// Only tickets still active in this window are eligible for the subject
// fallback — an old identically-titled conversation should not swallow a new
// request that happens to reuse its subject.
const SUBJECT_FALLBACK_WINDOW = "60 days"

/**
 * Strip reply/forward prefixes and collapse whitespace for subject-based thread
 * matching. `isReply` reports whether at least one prefix was stripped — a
 * subject that never had one is a NEW conversation and must not fuzzy-attach.
 */
export function normalizeReplySubject(subject: string | null | undefined): {
  normalized: string
  isReply: boolean
} {
  let s = (subject ?? "").trim()
  let isReply = false
  while (REPLY_PREFIX_RE.test(s)) {
    s = s.replace(REPLY_PREFIX_RE, "")
    isReply = true
  }
  return { normalized: s.replace(/\s+/g, " ").trim().toLowerCase(), isReply }
}

/**
 * Step B3 lookup: recent tickets on the SAME inbox whose contact matches the
 * counterparty address, compared by normalized subject. Exists for replies
 * whose RFC 5322 threading headers reference messages we never stored — the
 * canonical case is a customer replying to a pre-migration helpdesk email
 * (e.g. Freshdesk notification Message-IDs absent from the import), where
 * Steps A/B/B2 all miss and ingest would otherwise open a context-less
 * duplicate ticket. Scoped to one inbox so cross-channel tickets (API inboxes)
 * never capture mailbox replies. Most recently active match wins.
 */
async function lookupByContactSubject(
  ctx: TicketsServiceCtx,
  inboxId: string,
  counterpartyEmail: string,
  normalizedSubject: string,
): Promise<TicketCandidate | null> {
  const KS = drizzleSql.raw(schemaRef("kernel"))
  const r = await ctx.db.execute(drizzleSql`
    SELECT t.id, t.subject, t.status, t.closed_reason, t.merged_into_ticket_id,
           t.converted_to_mail_conversation_id, t.first_response_at
    FROM ${ticketsRel("tickets")} t
    LEFT JOIN ${KS}.contacts c ON c.id = t.contact_id AND c.org_id = t.org_id
    WHERE t.org_id = ${ctx.orgId}
      AND t.source_inbox_id = ${inboxId}
      AND (
        LOWER(t.requester_email) = ${counterpartyEmail.toLowerCase()}
        OR LOWER(c.email) = ${counterpartyEmail.toLowerCase()}
      )
      AND t.last_message_at >= now() - ${SUBJECT_FALLBACK_WINDOW}::interval
    ORDER BY t.last_message_at DESC
    LIMIT 20
  `)
  const rows = extractRows<TicketCandidate & { subject: string | null }>(r)
  return rows.find((t) => normalizeReplySubject(t.subject).normalized === normalizedSubject) ?? null
}

async function preCreateDuplicateCheck(
  ctx: TicketsServiceCtx,
  externalMessageId: string,
): Promise<boolean> {
  const r = await ctx.db.execute(drizzleSql`
    SELECT 1 FROM ${ticketsRel("messages")}
    WHERE org_id = ${ctx.orgId} AND external_message_id = ${externalMessageId}
    LIMIT 1
  `)
  return extractRows<unknown>(r).length > 0
}

async function insertMessage(
  ctx: TicketsServiceCtx,
  params: {
    ticketId: string
    raw: ParsedEmail
    kind: MessageDirection
  },
): Promise<string> {
  const sentAt = params.raw.sentAt ?? new Date().toISOString()
  const fromEmail = params.raw.from?.email ?? null
  const fromName = params.raw.from?.name ?? null
  const toEmails = (params.raw.to ?? []).map((a) => a.email)
  const ccEmails = (params.raw.cc ?? []).map((a) => a.email)
  // Card numbers and payment keys are masked before the row is written, so no
  // reader (a person, an agent, search, an export) ever meets the full value.
  const subject = params.raw.subject ? maskPaymentSecrets(params.raw.subject).text : null
  const html = params.raw.htmlBody
    ? maskHtmlWithNote(sanitizeCustomerHtml(params.raw.htmlBody)).text
    : null
  const text = params.raw.textBody ? maskWithNote(params.raw.textBody).text : null
  const snippet = (text ?? html ?? "").slice(0, 200)
  const externalMessageId = params.raw.messageId ?? null
  const inReplyTo = params.raw.inReplyTo ?? null
  const headerReferences = params.raw.references ?? []
  const senderAuth = senderAuthOf(params.raw)
  const r = await ctx.db.execute(drizzleSql`
    INSERT INTO ${ticketsRel("messages")} (
      id, org_id, ticket_id, kind,
      from_email, from_name, to_emails, cc_emails,
      subject, html_body, text_body, snippet,
      sent_at, external_message_id, in_reply_to, header_references, created_at, updated_at,
      sender_auth, received_at
    ) VALUES (
      gen_random_uuid(), ${ctx.orgId}, ${params.ticketId}, ${params.kind},
      ${fromEmail}, ${fromName},
      ${JSON.stringify(toEmails)}::jsonb, ${JSON.stringify(ccEmails)}::jsonb,
      ${subject}, ${html}, ${text}, ${snippet},
      ${sentAt}, ${externalMessageId}, ${inReplyTo}, ${JSON.stringify(headerReferences)}::jsonb, now(), now(),
      ${senderAuth}, now()
    )
    RETURNING id
  `)
  return extractRows<{ id: string }>(r)[0]!.id
}

/** Remove every `[#handle]` tag from a subject. */
function stripForeignHandleTags(subject: string): string {
  const cleaned = subject
    .replace(/\s*\[#[a-zA-Z0-9_-]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned || "(no subject)"
}

/**
 * Whether a message that matched `ticket` only through a weak key (subject
 * handle) may join its thread: our own staff, or the ticket's requester or a
 * participant. Takes the merge leaf into account.
 */
async function senderMayJoinTicket(
  ctx: TicketsServiceCtx,
  candidate: TicketCandidate,
  raw: ParsedEmail,
  direction: MessageDirection,
  senderAuth: SenderAuth,
): Promise<boolean> {
  // Outbound is only ever decided by provider evidence (resolveSyncedDirection).
  if (direction === "outbound") return true
  // The provider says the From is forged: it is nobody's.
  if (senderAuth === "fail") return false
  const leaf = await resolveLeaf(ctx, candidate)
  const parties = await loadTicketParties(ctx.db, ctx.orgId, leaf.id)
  return isTicketParty(parties, raw.from?.email)
}

async function appendOrReroute(
  ctx: TicketsServiceCtx,
  candidate: TicketCandidate,
  raw: ParsedEmail,
  direction: MessageDirection,
): Promise<MatcherResult> {
  const leaf = await resolveLeaf(ctx, candidate)
  if (leaf.converted_to_mail_conversation_id) {
    // Conversion is currently one-way: tickets:convertToMail closes the
    // ticket and points future inbound at the linked mail conversation. If
    // that mail conversation is later converted back to a ticket, no reverse
    // pointer exists yet — replies on the original `reply_token` would still
    // route to the closed ticket via this branch and then through Mail's
    // appendInboundMessage. Round-trip safety (Mail → Ticket → Mail back to
    // Ticket) is deferred; if/when round-trip is supported, store
    // `mail.conversation.source_ticket_id` and resolve here.
    return {
      outcome: "rerouted",
      target: "mail_conversation",
      conversationId: leaf.converted_to_mail_conversation_id,
    }
  }
  return appendInboundToTicket(ctx, leaf, raw, direction)
}

/**
 * Persist inbound `ParsedAttachment[]` to object storage + `kernel.files`,
 * parented to `tickets:message:<messageId>`. Inline parts that came in via
 * `cid:<Content-ID>` in the HTML body are stored with `disposition='inline'`
 * and `content_id` populated so projection can rewrite the body to the
 * authenticated inline route.
 *
 * No bytes ⇒ skip silently. The Gmail sync layer hydrates provider-id
 * attachments via `hydrateGmailAttachments` before this runs; a part still
 * byte-less here failed that fetch (or exceeded the caps) and is dropped.
 * Per-attachment failures don't break the inbound message ingest.
 *
 * `strict: true` (bulk import) inverts that tolerance: any condition the
 * default mode would silently skip on (missing bytes, per-attachment cap,
 * per-message cumulative cap, object-storage failure) THROWS instead, so a
 * caller running inside a per-record transaction rolls back whole — a
 * migration must never half-import a record. The returned report names every
 * skip so a lenient caller can surface them loudly instead of losing them.
 * (Existing inbound-mail callers ignore the return value — behaviour there is
 * unchanged.)
 */
export const INBOUND_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024
export const INBOUND_EMAIL_MAX_BYTES = 35 * 1024 * 1024

export type PersistAttachmentsReport = {
  persisted: number
  skipped: Array<{ filename: string; reason: string }>
  /** Attachments the virus scanner found infected (`CLAMAV_HOST`): stored as a notice instead. */
  quarantined: Array<{ filename: string; signature: string }>
  /** Each stored file, by its position in `params.attachments`. */
  files: Array<{ index: number; fileId: string }>
}

export async function persistInboundAttachments(
  // Only `db.execute` / `db.queueEvent` and the org are used: the import kind
  // (tickets.ticket) persists through the run's privileged transaction.
  ctx: { db: RlsClient | PrivilegedDb; orgId: string },
  params: {
    messageId: string
    attachments: ParsedAttachment[]
    strict?: boolean
    /** Attribute the stored files to a kernel user (e.g. an in-app bug
     *  reporter). Inbound mail has no uploader — defaults to NULL. */
    uploadedBy?: string | null
  },
): Promise<PersistAttachmentsReport> {
  const report: PersistAttachmentsReport = {
    persisted: 0,
    skipped: [],
    quarantined: [],
    files: [],
  }
  if (!params.attachments.length) return report
  const strict = params.strict ?? false
  const skip = (filename: string, reason: string): void => {
    if (strict) throw new Error(`attachment "${filename}": ${reason}`)
    report.skipped.push({ filename, reason })
  }
  const KS = drizzleSql.raw(schemaRef("kernel"))
  const quarantinedDetail: Array<{ signature: string; quarantineKey: string }> = []
  let ordinal = 0
  let cumulative = 0
  for (const att of params.attachments) {
    if (!att.bytesBase64) {
      skip(att.filename || "attachment", "no bytes available")
      ordinal += 1
      continue
    }
    const bytes = Buffer.from(att.bytesBase64, "base64")
    if (bytes.byteLength > INBOUND_ATTACHMENT_MAX_BYTES) {
      skip(
        att.filename || "attachment",
        `exceeds per-attachment cap (${bytes.byteLength} > ${INBOUND_ATTACHMENT_MAX_BYTES} bytes)`,
      )
      ordinal += 1
      continue
    }
    if (cumulative + bytes.byteLength > INBOUND_EMAIL_MAX_BYTES) {
      // This and any remaining attachments would exceed the per-message
      // cumulative cap — dropped (silently in default mode; report/throw via skip).
      for (const rest of params.attachments.slice(ordinal)) {
        skip(rest.filename || "attachment", "exceeds per-message cumulative cap")
      }
      break
    }
    const fileId = randomUUID()
    // Virus scan when the operator runs clamd (CLAMAV_HOST); off, a no-op. An
    // infected attachment is kept under a quarantine key and the message
    // carries a text notice in its place (lib/clamav.ts).
    const scan = await scanInboundAttachment(
      { filename: att.filename || "attachment", mimeType: att.mimeType, bytes },
      { orgId: ctx.orgId, where: "tickets" },
    )
    let stored: { filename: string; mimeType: string; bytes: Uint8Array } = {
      filename: att.filename || "attachment",
      mimeType: att.mimeType,
      bytes,
    }
    let disposition = att.disposition
    if (scan.quarantined) {
      const quarantineKey = quarantineStorageKey(
        ctx.orgId,
        fileId,
        sanitizeFilename(att.filename || "attachment"),
      )
      try {
        await putObject({
          key: quarantineKey,
          body: bytes,
          contentType: "application/octet-stream",
        })
      } catch (err) {
        rootLogger.error({ err, orgId: ctx.orgId, quarantineKey }, "quarantine write failed")
      }
      report.quarantined.push({ filename: att.filename || "attachment", signature: scan.signature })
      quarantinedDetail.push({ signature: scan.signature, quarantineKey })
      stored = scan.attachment
      disposition = "attachment"
    }
    const safeName = sanitizeFilename(stored.filename)
    const storageKey = `orgs/${ctx.orgId}/tickets/message/${params.messageId}/${fileId}/${safeName}`
    try {
      await putObject({
        key: storageKey,
        body: Buffer.from(stored.bytes),
        contentType: stored.mimeType,
      })
    } catch (err) {
      skip(
        att.filename || "attachment",
        `object storage write failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      ordinal += 1
      continue
    }
    const contentId = scan.quarantined ? null : (att.contentId ?? null)
    const originalContentId = scan.quarantined
      ? null
      : (att.originalContentId ?? (att.contentId ? `<${att.contentId}>` : null))
    await ctx.db.execute(drizzleSql`
      INSERT INTO ${KS}.files
        (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
         storage_key, uploaded_by, disposition, content_id, original_content_id, ordinal)
      VALUES (
        ${fileId}, ${ctx.orgId}, 'tickets', 'message', ${params.messageId},
        ${safeName}, ${stored.mimeType}, ${stored.bytes.byteLength},
        ${storageKey}, ${params.uploadedBy ?? null}, ${disposition}, ${contentId}, ${originalContentId}, ${ordinal}
      )
    `)
    // Mirror the kernel upload path's `file:create` event (files/service.ts)
    // so event-driven kernel consumers — the thumbnail pipeline in particular —
    // fire for mail-ingested attachments too. Before this, raw-SQL inserts here
    // never emitted the event, so inbound images kept thumbnail_key NULL and
    // `?variant=thumb` fell back to the multi-MB original forever.
    await ctx.db.queueEvent({
      app: "kernel",
      entity: "file",
      action: "create",
      entityId: fileId,
      orgId: ctx.orgId,
      actorId: params.uploadedBy ?? "00000000-0000-0000-0000-000000000000",
      actorType: params.uploadedBy ? "user" : "system",
      data: {
        id: fileId,
        app: "tickets",
        entityType: "message",
        entityId: params.messageId,
        filename: safeName,
        mimeType: stored.mimeType,
        sizeBytes: stored.bytes.byteLength,
        storageKey,
      },
    })
    cumulative += bytes.byteLength
    report.files.push({ index: ordinal, fileId })
    ordinal += 1
    report.persisted += 1
  }
  for (const q of quarantinedDetail) {
    await emitSecurityEvent({
      kind: "malware_quarantined",
      orgId: ctx.orgId,
      detail: { where: "tickets", messageId: params.messageId, ...q },
    })
  }
  return report
}

/** Transfer links queued for download per message. */
export const MAX_TRANSFER_LINKS_PER_MESSAGE = 3
/** Transfer links queued for download per sender per day. */
export const MAX_TRANSFER_LINKS_PER_SENDER_PER_DAY = 10

async function senderMayQueueLink(orgId: string, sender: string): Promise<boolean> {
  try {
    const rl = await checkRateLimit(redis, [
      {
        identifier: `tickets:link-ingest:${orgId}:${sender}:day`,
        limit: MAX_TRANSFER_LINKS_PER_SENDER_PER_DAY,
        windowSeconds: 86_400,
      },
    ])
    return rl.allowed
  } catch {
    // The cap is protective, not load-bearing: never fail an ingest over it.
    return true
  }
}

/**
 * Always-on (for whitelisted hosts): scan the inbound body for transfer links
 * and enqueue one `files-link-ingest` job per match. The job downloads + verifies
 * the media and materializes a `kernel.files` row (no analysis). No settings gate
 * at enqueue. The jobId `(messageId, urlHash)` dedups re-deliveries.
 */
export async function enqueueTransferLinkIngest(
  ctx: TicketsServiceCtx,
  messageId: string,
  raw: ParsedEmail,
): Promise<void> {
  // The `(initial)` sentinel means the follow-up message-id SELECT missed —
  // enqueuing with it would parent a downloaded file to a non-existent message.
  if (messageId === "(initial)") return
  const body = raw.textBody ?? raw.htmlBody ?? ""
  // Each link queues a download of up to 200 MB, so a mail may not queue many, and
  // one sender may not queue many per day: an outsider can otherwise drive storage,
  // bandwidth and worker memory with one email.
  const links = extractWhitelistedTransferLinks(body, TRANSFER_HOST_WHITELIST).slice(
    0,
    MAX_TRANSFER_LINKS_PER_MESSAGE,
  )
  const sender = raw.from?.email?.trim().toLowerCase() || "unknown"
  for (const { url, urlHash } of links) {
    if (!(await senderMayQueueLink(ctx.orgId, sender))) {
      rootLogger.warn(
        { module: "tickets-inbound", orgId: ctx.orgId, sender },
        "transfer link ingest skipped: sender is over the daily link cap",
      )
      break
    }
    await enqueueAppJob(
      "kernel",
      "files-link-ingest",
      { messageId, orgId: ctx.orgId, app: "tickets", entityId: messageId, url },
      { jobId: `files-link-ingest:${messageId}:${urlHash}` },
    )
  }
}

async function appendInboundToTicket(
  ctx: TicketsServiceCtx,
  ticket: TicketCandidate,
  raw: ParsedEmail,
  direction: MessageDirection,
): Promise<MatcherResult> {
  if (raw.messageId) {
    const dup = await preCreateDuplicateCheck(ctx, raw.messageId)
    if (dup) return { outcome: "dropped", reason: "duplicate_external_message_id" }
  }
  const messageId = await insertMessage(ctx, { ticketId: ticket.id, raw, kind: direction })

  // Addresses the requester (or an existing participant) copied in become
  // participants; a stranger's Cc list adds nobody.
  if (direction === "inbound") {
    await addParticipantsFromTrustedSender(
      ctx.db,
      ctx.orgId,
      ticket.id,
      raw.from?.email,
      await senderAuthForRules(ctx.orgId, senderAuthOf(raw), raw.from?.email, ctx.privilegedTx),
      [...(raw.to ?? []), ...(raw.cc ?? [])].map((a) => a.email),
    )
  }

  // Unified-search derived-reindex rule (§3.3): every message append on an
  // EXISTING ticket must re-upsert that ticket's search document (message
  // text is folded into the ticket's enriched body). Before this, NO durable
  // event fired on this path at all — customer replies and synced outbound
  // replies never reindexed the ticket, so their text was never searchable.
  // Queued UNCONDITIONALLY, in the SAME transaction as the message insert
  // (transactional outbox — rolls back with the insert), and independent of
  // validateAndApply's outcome below (which can return emit:[]/ok:false on
  // some transitions, e.g. nudge/merged/converted tickets) so those cases
  // still reindex.
  await ctx.db.queueEvent({
    app: "tickets",
    entity: "message",
    action: "create",
    entityId: messageId,
    data: { ticketId: ticket.id },
    actorType: "system",
    actorId: "00000000-0000-0000-0000-000000000000",
    orgId: ctx.orgId,
  })

  if (raw.attachments?.length) {
    await persistInboundAttachments(ctx, {
      messageId,
      attachments: raw.attachments,
    })
  }
  // Transfer links live in the body, not the attachment list — scan/enqueue
  // unconditionally (messageId is in scope here).
  await enqueueTransferLinkIngest(ctx, messageId, raw)

  // A self-sent message (agent reply synced back from the mailbox) drives the
  // same status transition an in-app reply would (-> awaiting_customer); a
  // genuine customer message drives the inbound transition (-> awaiting_followup
  // or reopen), funneled through the shared choke point so every ingestion
  // path keeps the counters, timestamps and transition in lockstep.
  const sentAt = raw.sentAt ?? new Date().toISOString()
  const actor = {
    actorType: "system" as const,
    userId: "00000000-0000-0000-0000-000000000000",
    orgId: ctx.orgId,
  }

  if (direction === "inbound") {
    await recordInboundOnTicket(ctx.db as never, {
      orgId: ctx.orgId,
      ticketId: ticket.id,
      sentAt,
      actor,
      privilegedTx: ctx.privilegedTx,
    })
  } else {
    const transitionResult = await validateAndApply(
      ctx.db as never,
      ticket.id,
      { kind: "reply" } as never,
      actor,
      { privilegedTx: ctx.privilegedTx },
    )
    // best-effort; matcher must succeed even if state machine declines
    void transitionResult

    await ctx.db.execute(drizzleSql`
      UPDATE ${ticketsRel("tickets")}
      SET message_count = message_count + 1,
          last_message_at = GREATEST(COALESCE(last_message_at, ${sentAt}::timestamptz), ${sentAt}::timestamptz),
          last_outbound_at = GREATEST(COALESCE(last_outbound_at, ${sentAt}::timestamptz), ${sentAt}::timestamptz),
          updated_at = now()
      WHERE id = ${ticket.id}
    `)
  }

  return { outcome: "appended", ticketId: ticket.id, messageId }
}

async function createNewTicket(
  ctx: TicketsServiceCtx,
  inbox: InboxRow,
  raw: ParsedEmail,
  direction: MessageDirection,
  related?: { ticketId: string; reference: string },
): Promise<MatcherResult> {
  if (raw.messageId) {
    const dup = await preCreateDuplicateCheck(ctx, raw.messageId)
    if (dup) return { outcome: "dropped", reason: "duplicate_external_message_id" }
  }
  const { createTicket } = await import("~/apps/tickets/create")
  const senderAuth = senderAuthOf(raw)
  // The customer is the counterparty: on a genuine inbound message that's the
  // sender (From); on a self-sent message that opens a thread (agent emailed
  // the customer first, synced back before the customer's reply) it's the
  // recipient (To).
  const counterparty =
    direction === "outbound"
      ? (raw.to ?? []).find((a) => a.email)
      : raw.from?.email
        ? { email: raw.from.email, name: raw.from.name ?? undefined }
        : undefined
  // Inbound mail never adds its sender to the organisation's contacts (that
  // is a person's choice): the ticket links an org contact that already exists
  // for the address, or none; the sender's address stays on the message.
  // An unauthenticated From does not link a contact either: an attacker writing
  // "From: <a real customer>" would otherwise have the customer's profile shown
  // beside attacker-written text. (An outbound counterparty is the address our
  // own staff wrote to, so it is not a claim by the sender.)
  // A trusted sender (staff marked the address or domain) counts as authenticated here when the
  // provider gave no verdict; the message still records the provider's own verdict.
  const mayLinkContact =
    direction === "outbound" ||
    (await senderAuthForRules(ctx.orgId, senderAuth, raw.from?.email, ctx.privilegedTx)) === "pass"
  const contact =
    counterparty?.email && mayLinkContact
      ? await resolveContact(
          ctx.db as never,
          ctx.orgId,
          "00000000-0000-0000-0000-000000000000",
          { email: counterparty.email, name: counterparty.name ?? undefined },
          { audience: "none" },
        )
      : null
  const result = await createTicket(
    ctx.db,
    ctx.orgId,
    {
      // A subject that named ANOTHER ticket's handle must not keep the tag:
      // every reply on this thread would carry it back and match that ticket.
      subject: related
        ? stripForeignHandleTags(raw.subject ?? "(no subject)")
        : (raw.subject ?? "(no subject)"),
      channel: "email",
      sourceInboxId: inbox.id,
      requesterEmail: counterparty?.email ?? null,
      relatedTicketId: related?.ticketId ?? null,
      senderAuth,
      // The creation acknowledgement, sent after the OUTERMOST commit
      // (ack-after-commit.ts): this runs inside the caller's transaction, so no
      // other connection can see the ticket yet. Only for a customer's own
      // message (never a ticket we opened by writing first), and only when the
      // provider authenticated the sender (or staff trust it): the ack goes to
      // the From address, and an unauthenticated From is the classic
      // backscatter vector. Never for mail that did not just arrive: a first
      // (backfill) sync or an import says so (`noAcknowledgement`), and a
      // message dated hours away from now is history, not a new request.
      // Gated per inbox (ack_enabled) and send-once (ack_sent_at) in the sender.
      acknowledgeAfterCommit:
        direction === "inbound" &&
        mayLinkContact &&
        ctx.noAcknowledgement !== true &&
        isRecentForAcknowledgement(raw),
      contactId: contact?.contact?.id ?? null,
      team: inbox.default_team ?? undefined,
      audience: inbox.default_audience ?? undefined,
      sensitivity: (inbox.default_sensitivity as never) ?? "internal",
      initialMessage: {
        kind: direction,
        fromEmail: raw.from?.email,
        fromName: raw.from?.name ?? null,
        toEmails: (raw.to ?? []).map((a) => a.email),
        ccEmails: (raw.cc ?? []).map((a) => a.email),
        subject: raw.subject ?? null,
        htmlBody: raw.htmlBody ? sanitizeCustomerHtml(raw.htmlBody) : null,
        textBody: raw.textBody ?? null,
        externalMessageId: raw.messageId ?? null,
        inReplyTo: raw.inReplyTo ?? null,
        headerReferences: raw.references ?? [],
        sentAt: raw.sentAt ?? null,
      },
    },
    { actorType: "system", userId: "00000000-0000-0000-0000-000000000000" } as never,
    {
      notNews: !isNewTicketNews(raw, direction, ctx.noAcknowledgement === true),
      privilegedTx: ctx.privilegedTx,
    },
  )
  if ("error" in result) {
    // A concurrent delivery of the same provider message id can lose the race
    // to the unique index — that is a duplicate, not a failure. Drop cleanly.
    if (result.error.code === "duplicate_external_message_id") {
      return { outcome: "dropped", reason: "duplicate_external_message_id" }
    }
    return { error: { ...result.error } }
  }

  const messageRow = await ctx.db.execute(drizzleSql`
    SELECT id FROM ${ticketsRel("messages")}
    WHERE org_id = ${ctx.orgId} AND ticket_id = ${result.ticketId}
    ORDER BY created_at ASC
    LIMIT 1
  `)
  const messageId = extractRows<{ id: string }>(messageRow)[0]?.id ?? "(initial)"

  if (related) {
    await recordRelatedTicketNote(ctx.db, ctx.orgId, result.ticketId, related.reference)
  }

  if (raw.attachments?.length && messageId !== "(initial)") {
    await persistInboundAttachments(ctx, {
      messageId,
      attachments: raw.attachments,
    })
  }
  // The `messageId !== "(initial)"` guard is mandatory — enqueuing with the
  // sentinel would parent a downloaded file to a non-existent message.
  if (messageId !== "(initial)") {
    await enqueueTransferLinkIngest(ctx, messageId, raw)
  }

  return {
    outcome: "created",
    ticketId: result.ticketId,
    messageId,
  }
}

// Why messages were silently dropped before reaching a ticket, per reason, since
// the process started. The drops are unauthenticated and automatic (a list header,
// an auto-responder header), so a real customer behind a mailing-list tool or a
// forwarding rule would vanish without a trace; this counter and the log line
// below are the operator's signal.
const inboundDropCounts = new Map<string, number>()

export function inboundDropCountsByReason(): Record<string, number> {
  return Object.fromEntries(inboundDropCounts)
}

function noteInboundDrop(reason: string, ctx: TicketsServiceCtx, raw: ParsedEmail): MatcherResult {
  inboundDropCounts.set(reason, (inboundDropCounts.get(reason) ?? 0) + 1)
  rootLogger.info(
    {
      module: "tickets-inbound",
      orgId: ctx.orgId,
      reason,
      from: raw.from?.email ?? null,
      messageId: raw.messageId ?? null,
    },
    "inbound message dropped before reaching a ticket",
  )
  return { outcome: "dropped", reason }
}

export async function processInboundMessage(
  raw: ParsedEmail,
  inbox: InboxRow,
  ctx: TicketsServiceCtx,
): Promise<MatcherResult> {
  const headersFlat = (raw.headers ?? {}) as Record<string, string | string[]>
  const headersForGate: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(headersFlat)) {
    headersForGate[k.toLowerCase()] = Array.isArray(v) ? v : [String(v)]
  }
  if (detectAutoResponder(headersForGate as never)) {
    return noteInboundDrop("auto_responder", ctx, raw)
  }
  // Helpdesk community/forum notifications ("[New Reply] in ...") are self-sent
  // activity mail, not support requests -- drop them before they open a junk
  // ticket contacted as the support address itself.
  if (detectForumNotification(raw)) {
    return noteInboundDrop("forum_notification", ctx, raw)
  }

  // Our own Sent copy coming back at us. The sync lists the whole mailbox by
  // design, so every reply we send is seen again and classified `outbound`; the
  // send path has already recorded it, so ingesting it here stores it twice.
  // Dropped on a marker header rather than a body/time heuristic — see
  // self-send-marker.ts for why, and for why an unconditional drop is safe.
  if (isSelfSendEcho(raw.headers)) {
    return noteInboundDrop("self_send_echo", ctx, raw)
  }

  // The provider's verdict, except that a trusted sender (staff marked the address or domain)
  // with no verdict counts as verified for desk routing and the acknowledgement. A failed verdict
  // stays failed.
  const senderAuth = await senderAuthForRules(
    ctx.orgId,
    senderAuthOf(raw),
    raw.from?.email,
    ctx.privilegedTx,
  )

  // Direction is fixed by (From vs the synced mailbox and the org's own
  // domains, plus the provider's evidence) and is invariant across every match
  // branch below — compute it once.
  const direction = resolveSyncedDirection(
    raw,
    inbox,
    await loadOrgMailDomains(ctx.orgId, ctx.privilegedTx),
  )

  // Recipient dispatch. Several published addresses (Groups / aliases) may
  // deliver into this ONE synced mailbox; each maps to its own api inbox
  // carrying that desk's team and reply identity.
  //
  // `inbox` (the synced mailbox) stays the reference for `direction` above —
  // that question is "is the From our own mailbox?" and only the real account
  // can answer it. Only the ticket's OWNING inbox is dispatched, below.
  const candidates = await loadRoutingCandidates(ctx)
  // A sender picks the desk by choosing the recipient address, so an inbound
  // message is dispatched into a non-default desk only when the provider
  // authenticated its sender. Our own (outbound) mail follows its addresses.
  const mayDispatch = direction === "outbound" || senderAuth === "pass"
  const dispatch = mayDispatch
    ? resolveInboxForMessage(raw, inbox as RoutableInbox, candidates)
    : { inbox: inbox as RoutableInbox, matchedOn: null }
  const target = dispatch.inbox as InboxRow
  if (dispatch.matchedOn === null && candidates.some((c) => c.id !== inbox.id)) {
    // Dispatch is configured, yet nothing matched: the message reached us on an
    // address no inbox claims. It still lands (in the sync inbox, team-less and
    // visible) — but this is the signal that a published address was never
    // registered, which is otherwise indistinguishable from ordinary traffic.
    rootLogger.warn(
      {
        module: "tickets-inbound",
        orgId: ctx.orgId,
        syncInboxId: inbox.id,
        recipients: collectRecipients(raw),
      },
      "inbound message matched no routing inbox — falling back to the synced mailbox",
    )
  }

  const threadKey = raw.inReplyTo?.trim().toLowerCase() ?? raw.messageId ?? String(Math.random())
  const lockKey = `tickets:inbound:${ctx.orgId}:${threadKey}`

  // Sentinel error thrown from inside the transaction when the advisory lock
  // times out. The lock timeout puts the transaction into aborted state (25P02)
  // so we must not return a value from inside the transaction body — Drizzle
  // would try to COMMIT an aborted transaction. Throw instead, and catch
  // outside so the caller receives a clean error result.
  class LockTimeoutError extends Error {
    constructor() {
      super("advisory_lock_timeout")
      this.name = "LockTimeoutError"
    }
  }

  let result: MatcherResult
  try {
    result = await ctx.db.transaction(async (tx) => {
      const txCtx: TicketsServiceCtx = { ...ctx, db: tx as never }

      // Acquire advisory lock with a 30s timeout. Use a stable hashtext over the
      // org-scoped thread key so two concurrent inbound deliveries serialize.
      try {
        await tx.execute(drizzleSql.raw(`SET LOCAL lock_timeout = '30s'`))
        await tx.execute(drizzleSql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`)
      } catch (_err) {
        // Throw out of the transaction body so Drizzle rolls back cleanly
        // rather than attempting COMMIT on the already-aborted transaction.
        throw new LockTimeoutError()
      }

      // Step A: token in to[]/cc[]
      const tokens = extractTokens([
        ...(raw.to ?? []).map((a) => a.email),
        ...(raw.cc ?? []).map((a) => a.email),
      ])
      let candidate = await lookupByToken(txCtx, tokens)
      if (candidate) return appendOrReroute(txCtx, candidate, raw, direction)

      // Step B: In-Reply-To / References lookup
      const referenceIds: string[] = []
      if (raw.inReplyTo) referenceIds.push(raw.inReplyTo)
      for (const r of raw.references ?? []) referenceIds.push(r)
      if (referenceIds.length > 0) {
        const match = await lookupByExternalMessageIds(txCtx, referenceIds)
        if (match) {
          const c = await lookupTicketById(txCtx, match.ticketId)
          // A reply to one of OUR messages threads as always. A reference that only names a
          // customer's own message is a hint like the subject handle: the sender must be a party.
          if (
            c &&
            (match.ours || (await senderMayJoinTicket(txCtx, c, raw, direction, senderAuth)))
          ) {
            return appendOrReroute(txCtx, c, raw, direction)
          }
          if (c) {
            return createNewTicket(txCtx, target, raw, direction, {
              ticketId: c.id,
              reference: "a message of an earlier ticket",
            })
          }
        }
      }

      // Step B2: subject [#handle] fallback
      const handleMatch = HANDLE_REGEX.exec(raw.subject ?? "")
      if (handleMatch) {
        candidate = await lookupByHandle(txCtx, handleMatch[1])
        if (candidate) {
          // The handle is a guessable hint, not a credential. Only the ticket's
          // requester, one of its participants or our own staff may join the
          // thread by naming it; a stranger gets a new ticket that points back.
          if (await senderMayJoinTicket(txCtx, candidate, raw, direction, senderAuth)) {
            return appendOrReroute(txCtx, candidate, raw, direction)
          }
          return createNewTicket(txCtx, target, raw, direction, {
            ticketId: candidate.id,
            reference: `ticket ${handleMatch[1]}`,
          })
        }
      }

      // Step B3: contact + normalized-subject fallback. Reaches here only when
      // the reply carries NO usable threading key (no token, no stored
      // Message-ID match, no [#handle]) — a reply-shaped subject from the same
      // contact on the same inbox then threads onto the most recently active
      // matching ticket instead of opening a context-less duplicate.
      // A From the provider marked as forged never threads by address.
      const { normalized, isReply } = normalizeReplySubject(raw.subject)
      const mayThreadByAddress = direction === "outbound" || senderAuth !== "fail"
      if (mayThreadByAddress && isReply && normalized.length >= SUBJECT_FALLBACK_MIN_LENGTH) {
        const counterpartyEmail =
          direction === "outbound" ? (raw.to ?? []).find((a) => a.email)?.email : raw.from?.email
        if (counterpartyEmail) {
          // Scoped to the DISPATCHED inbox: the customer's prior ticket on this
          // desk is the right thread to land on. Scoping to the shared synced
          // mailbox instead would let a reply thread onto that contact's ticket
          // on a DIFFERENT shopping centre — the exact cross-desk leak this
          // dispatch exists to prevent.
          candidate = await lookupByContactSubject(txCtx, target.id, counterpartyEmail, normalized)
          if (candidate) return appendOrReroute(txCtx, candidate, raw, direction)
        }
      }

      // Step C: create new — on the dispatched inbox, so the ticket inherits
      // that desk's team + sensitivity and its replies go out under that desk's
      // identity.
      return createNewTicket(txCtx, target, raw, direction)
    })
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      return { error: { code: "advisory_lock_timeout", retryable: true, message: "lock timeout" } }
    }
    throw err
  }

  return result
}
