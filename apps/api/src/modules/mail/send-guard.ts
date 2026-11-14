// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The send check's final say. An agent-staged mail must not go when the state
 * says it must not: a person answered, the address failed, or the person is away
 * and nobody has chosen to send anyway. Pure, so one decision serves the
 * preflight, the card and the handler alike.
 */
import { createHash } from "node:crypto"
import type { RecipientFact } from "@liaison/shared"
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { appBridgeManifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { serverT } from "~/modules/i18n/server-i18n"
import {
  classifyInbound,
  type InboundKind,
  reportConcerns,
  reportText,
} from "~/modules/mail/classify-inbound"
import {
  applyCommercialFooter,
  art14NoticeDue,
  art14NoticeLine,
  COMMERCIAL_IDENTITY_SETTING,
  commercialIdentityMissing,
  footerLines,
  mintOptOutLink,
  optOutHeaders,
  readCommercialIdentity,
  recipientLocale,
} from "~/modules/mail/commercial-footer"
import { parseReturnDate } from "~/modules/mail/parse-return-date"
import {
  isColleague,
  lawfulBasisFacts,
  lawfulBasisProblem,
  listSuppressions,
  readColleagues,
  suppressedAmong,
} from "~/modules/mail/suppressions"

export interface GuardInbound {
  id: string
  kind: InboundKind
  sender: string | null
  /** When it was sent, or when it was synced for a mail with no sent date. */
  at: Date
  /** The cleartext body the hold date is read from; null on a sealed mailbox. */
  textBody: string | null
  /** Where the message sits, so a stop can name it. */
  record?: GuardRecord
}

export interface GuardRecord {
  kind: "conversation" | "ticket"
  id: string
}

export interface DecideSendGuardInputs {
  inbound: readonly GuardInbound[]
  now: Date
  /** Set only by a person's "send now" on a hold. */
  ignoreAutoReply?: { by: string; at: string }
  /** The requester's, for the hold date. */
  locale?: string | null
  timeZone?: string | null
}

interface NamedMessage {
  messageId: string
  who: string | null
  at: Date
}

export type SendGuardDecision =
  | { state: "clear" }
  | ({ state: "replied" | "bounced"; final: true } & NamedMessage)
  | ({
      state: "held"
      final: false
      /** Null when the message states no usable date and the default applies. */
      returnDate: string | null
      holdUntil: Date
    } & NamedMessage)

function newestOf(inbound: readonly GuardInbound[], kind: InboundKind): GuardInbound | null {
  let newest: GuardInbound | null = null
  for (const item of inbound) {
    if (item.kind !== kind) continue
    if (newest === null || item.at.getTime() > newest.at.getTime()) newest = item
  }
  return newest
}

function named(item: GuardInbound): NamedMessage {
  return { messageId: item.id, who: item.sender, at: item.at }
}

/**
 * A reply stops the send whatever came after it, so a person's answer followed
 * by their out-of-office does not read as "away". Only a hold can be overridden.
 */
export function decideSendGuard(inputs: DecideSendGuardInputs): SendGuardDecision {
  const { inbound, now, ignoreAutoReply, locale, timeZone } = inputs
  const reply = newestOf(inbound, "reply")
  if (reply) return { state: "replied", final: true, ...named(reply) }

  const bounce = newestOf(inbound, "bounce")
  if (bounce) return { state: "bounced", final: true, ...named(bounce) }

  const autoReply = newestOf(inbound, "auto_reply")
  if (autoReply && !ignoreAutoReply) {
    const { returnDate, holdUntil } = parseReturnDate(
      autoReply.textBody,
      autoReply.at,
      locale,
      timeZone,
    )
    if (now.getTime() < holdUntil.getTime()) {
      return { state: "held", final: false, ...named(autoReply), returnDate, holdUntil }
    }
  }
  return { state: "clear" }
}

// ── The value the staged call carries ───────────────────────────────────────

export interface SendGuardRef {
  kind: string
  id: string
}

/** Set only by the preflight: a caller's own value is dropped before anything reads the call. */
export interface PinnedSendGuard {
  v: 1
  applies: true
  mode: "followup" | "plain"
  since: string
  stagedAt: string
  addresses: string[]
  contactIds: string[]
  conversationId?: string
  refs: SendGuardRef[]
  classification: "marketing" | "service" | "none"
  /** Set only by a person's "send now" on a hold. */
  ignoreAutoReply?: { by: string; at: string }
  /** A plain draft to someone who opted out stages with this line on its card. */
  line?: string
}

export type SendGuardState =
  | "clear"
  | "replied"
  | "bounced"
  | "held"
  | "opted_out"
  | "ref_stop"
  | "unavailable"

export interface SendGuardVerdict {
  state: SendGuardState
  /** Final: approving the same draft again can never pass. */
  final: boolean
  /** Replaces the state's own code: a provider's, or `suppression_check_unavailable`. */
  code?: string
  who?: string | null
  at?: string
  holdUntil?: string
  /** Null when the message states no usable date and the default applies. */
  returnDate?: string | null
  optedOut?: string[]
  label?: string
  /** Why the check could not run, in plain words. Never message text. */
  reason?: string
  record?: GuardRecord
  /** Where the message came in when the caller cannot open it: a ticket is named as one. */
  source?: GuardRecord["kind"]
  /**
   * Set when the message is from someone other than the draft's own people (a colleague of
   * theirs at the same company), with that company's name. A reader who cannot open the record
   * learns only "someone at <company>": see `withoutThirdParty`.
   */
  thirdParty?: { company: string | null }
  /** The class the draft was checked under, from its recipients as they stand. */
  classification?: PinnedSendGuard["classification"]
}

// ── Recipients ──────────────────────────────────────────────────────────────

/** The bare lowercased address out of a stored `{email}`, or a `Name <a@b>` or `a@b` string. */
export function addressOf(value: unknown): string | null {
  const raw =
    typeof value === "string"
      ? value
      : value !== null && typeof value === "object"
        ? (value as { email?: unknown }).email
        : null
  if (typeof raw !== "string") return null
  const inner = /<([^>]*)>\s*$/.exec(raw)?.[1] ?? raw
  const address = inner.trim().toLowerCase()
  return address.includes("@") ? address : null
}

/** Every distinct address of a To, Cc and Bcc, in that order. */
export function recipientsOf(...lists: unknown[]): string[] {
  const out = new Set<string>()
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      const address = addressOf(item)
      if (address) out.add(address)
    }
  }
  return [...out]
}

// ── Reads. Envelope and headers, privileged, and nothing is kept. ────────────

function table(schema: string, name: string) {
  return drizzleSql.raw(`${quoteIdent(schemaRef(schema))}.${quoteIdent(name)}`)
}

/**
 * A privileged read on the caller's own privileged transaction when it holds one (a claim under
 * its row lock), else in a transaction of its own. Never a second slot while one is held.
 */
function onPrivileged<T>(
  db: PrivilegedDb | undefined,
  orgId: string,
  reason: string,
  fn: (tx: PrivilegedDb) => Promise<T>,
): Promise<T> {
  return db ? fn(db) : withPrivilegedDb(orgId, reason, fn)
}

const textSet = (values: readonly string[]): SQL =>
  drizzleSql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`
const uuidSet = (values: readonly string[]): SQL =>
  drizzleSql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb)::uuid)`

/** The org's mailboxes and its members. An external user's address is deliberately not in it. */
async function ownAddresses(orgId: string, db?: PrivilegedDb): Promise<string[]> {
  const rows = await onPrivileged(db, orgId, "send-guard-own-addresses", async (tx) =>
    extractRows<{ email: string | null }>(
      await tx.execute(drizzleSql`
        SELECT lower(email_address) AS email FROM ${table("app_mail", "accounts")}
         WHERE org_id = ${orgId}::uuid
        UNION
        SELECT lower(email) AS email FROM ${table("kernel", "users")}
         WHERE org_id = ${orgId}::uuid AND user_type = 'member'`),
    ),
  )
  return rows.flatMap((row) => (row.email ? [row.email] : []))
}

/** Who counts as the other side of one draft at this evaluation. */
interface GuardContactSet {
  contactIds: string[]
  /** The addresses of the contacts the company adds: their mail counts wherever it lands. */
  colleagueAddresses: string[]
  /** The company of each address the company adds, and of the pinned contacts (first one). */
  companyOf: ReadonlyMap<string, string>
  company: string | null
}

/**
 * Who counts as the other side at this evaluation, for several drafts at once. Read each time
 * rather than at stage, so a wider set reaches every draft already waiting: the contacts pinned
 * at stage, plus every contact who shares a company with one of them, such as a colleague at the
 * client who became a contact after the draft was staged. Read privileged, like the inbound rows:
 * who wrote is a fact about the client, whoever staged the draft.
 */
async function guardContactSets(
  orgId: string,
  pinnedLists: readonly (readonly string[])[],
  db?: PrivilegedDb,
): Promise<GuardContactSet[]> {
  const pinned = [...new Set(pinnedLists.flat())]
  const colleagues = new Map<string, Array<{ id: string; email: string | null; company: string }>>()
  if (pinned.length > 0) {
    const rows = await onPrivileged(db, orgId, "send-guard-contact-set", async (tx) =>
      extractRows<{ pinned: string; id: string; email: string | null; company: string }>(
        await tx.execute(drizzleSql`
          SELECT p.id::text AS pinned, c.id::text AS id, lower(c.email) AS email,
                 co.name AS company
            FROM ${table("kernel", "contacts")} p
            JOIN ${table("kernel", "contacts")} c
              ON c.org_id = p.org_id AND c.company_id = p.company_id
            JOIN ${table("kernel", "companies")} co
              ON co.org_id = p.org_id AND co.id = p.company_id
           WHERE p.org_id = ${orgId}::uuid AND p.company_id IS NOT NULL
             AND p.id = ANY(${uuidSet(pinned)})`),
      ),
    )
    for (const row of rows) {
      const list = colleagues.get(row.pinned)
      if (list) list.push(row)
      else colleagues.set(row.pinned, [row])
    }
  }
  return pinnedLists.map((list) => {
    const pinnedHere = new Set(list)
    const ids = new Set(list)
    const addresses = new Set<string>()
    const companyOf = new Map<string, string>()
    let company: string | null = null
    for (const id of list) {
      for (const colleague of colleagues.get(id) ?? []) {
        company ??= colleague.company
        // A pinned contact's own addresses are the draft's already.
        if (pinnedHere.has(colleague.id)) continue
        ids.add(colleague.id)
        if (colleague.email) {
          addresses.add(colleague.email)
          if (!companyOf.has(colleague.email)) companyOf.set(colleague.email, colleague.company)
        }
      }
    }
    return { contactIds: [...ids], colleagueAddresses: [...addresses], companyOf, company }
  })
}
/** What one draft's inbound read is about. */
interface InboundQuery {
  contactIds: string[]
  addresses: string[]
  /** Senders whose mail counts as the other side's, and nothing more (never a bounce's subject). */
  senders: string[]
  conversationId?: string
  since: string
}

/** Rows read per page. Pages go on until a reply turns up or the rows run out. */
const INBOUND_PAGE = 50
/** Past this many rows without a reply, the check cannot rule one out and refuses to send. */
const INBOUND_MAX_ROWS = 2000

/** Where the next page starts: the order key (full precision, as text) and the row id. */
type InboundCursor = { ord: string; id: string } | null

/** A draft's inbound rows, or null past `INBOUND_MAX_ROWS` without a reply. */
type InboundRead = Map<string, GuardInbound[] | null>

/**
 * Read inbound rows newest first, page by page, until one classifies as a reply (a reply
 * outranks everything else, so nothing older can change the answer) or the rows run out. The
 * classifier is code, not SQL, so a fixed window could hide a real reply behind newer
 * automated mail. Every draft still open shares one query per page, so the number of queries
 * is bounded by the pages one draft needs, not by the number of drafts. A draft with too many
 * rows to read answers null, and its check answers unavailable.
 */
async function pageInbound<R extends { k: string; ord: string; id: string }>(
  keys: readonly string[],
  readPage: (open: ReadonlyMap<string, InboundCursor>) => Promise<R[]>,
  toInbound: (row: R) => GuardInbound,
): Promise<InboundRead> {
  const read: InboundRead = new Map()
  const acc = new Map<string, GuardInbound[]>(keys.map((k) => [k, []]))
  let open = new Map<string, InboundCursor>(keys.map((k) => [k, null]))
  while (open.size > 0) {
    const pages = new Map<string, R[]>()
    for (const row of await readPage(open)) {
      const page = pages.get(row.k)
      if (page) page.push(row)
      else pages.set(row.k, [row])
    }
    const next = new Map<string, InboundCursor>()
    for (const k of open.keys()) {
      const rows = pages.get(k) ?? []
      const items = rows.map(toInbound)
      const out = acc.get(k) as GuardInbound[]
      out.push(...items)
      if (items.some((item) => item.kind === "reply") || rows.length < INBOUND_PAGE) {
        read.set(k, out)
      } else if (out.length >= INBOUND_MAX_ROWS) {
        read.set(k, null)
      } else {
        const last = rows[rows.length - 1] as R
        next.set(k, { ord: last.ord, id: last.id })
      }
    }
    open = next
  }
  return read
}

/** The drafts still open at a page, as rows a query joins against, each with its cursor. */
function openDrafts(
  queries: ReadonlyMap<string, InboundQuery>,
  open: ReadonlyMap<string, InboundCursor>,
): SQL {
  const spec = [...open].map(([k, cursor]) => {
    const q = queries.get(k) as InboundQuery
    return {
      k,
      since: q.since,
      conv: q.conversationId ?? null,
      contacts: q.contactIds,
      addrs: q.addresses,
      senders: q.senders,
      addr_res: q.addresses.map(addressInText),
      cur_ord: cursor?.ord ?? null,
      cur_id: cursor?.id ?? null,
    }
  })
  return drizzleSql`
    SELECT x.k, x.since::timestamptz AS since, x.conv::uuid AS conv,
           ARRAY(SELECT jsonb_array_elements_text(x.contacts)::uuid) AS contacts,
           ARRAY(SELECT jsonb_array_elements_text(x.addrs)) AS addrs,
           ARRAY(SELECT jsonb_array_elements_text(x.senders)) AS senders,
           ARRAY(SELECT jsonb_array_elements_text(x.addr_res)) AS addr_res,
           x.cur_ord::timestamptz AS cur_ord, x.cur_id::uuid AS cur_id
      FROM jsonb_to_recordset(${JSON.stringify(spec)}::jsonb)
        AS x(k text, since text, conv text, contacts jsonb, addrs jsonb, senders jsonb, addr_res jsonb, cur_ord text, cur_id text)`
}

/**
 * A pattern that finds an address as a whole word in a delivery report's text, any case. A
 * full stop after it ends a sentence; one followed by more of a domain makes another address.
 */
export function addressInText(address: string): string {
  const escaped = address.toLowerCase().replace(/[^a-z0-9]/g, (c) => `\\${c}`)
  return `(^|[^a-z0-9._%+-])${escaped}($|[^a-z0-9._%+-]|\\.($|[^a-z0-9]))`
}

/**
 * Whether a mail row is a delivery report: from a mail server's daemon, or a
 * `multipart/report`. Only these carry their HTML and the mail they answer.
 */
const IS_REPORT = drizzleSql`(split_part(lower(m.from_address->>'email'), '@', 1)
                               IN ('mailer-daemon', 'postmaster')
                             OR m.raw_headers->>'content-type' ILIKE 'multipart/report%')`

/** A bounce about another address, such as another recipient of a group mail, is nothing here. */
function reportAbout(kind: InboundKind, facts: Parameters<typeof reportConcerns>[0]): InboundKind {
  return kind === "bounce" && !reportConcerns(facts) ? "ignored" : kind
}

async function readMailInbound(
  orgId: string,
  own: readonly string[],
  queries: ReadonlyMap<string, InboundQuery>,
  db?: PrivilegedDb,
): Promise<InboundRead> {
  type Row = {
    k: string
    id: string
    ord: string
    conversation_id: string
    sender: string | null
    at: string | Date
    raw_headers: unknown
    text_body: string | null
    html_body: string | null
    answered: string[] | null
    subject: string | null
  }
  return onPrivileged(db, orgId, "send-guard-mail-inbound", (tx) =>
    pageInbound(
      [...queries.keys()],
      async (open) =>
        extractRows<Row>(
          await tx.execute(drizzleSql`
            WITH d AS (${openDrafts(queries, open)})
            SELECT d.k, r.id, r.ord, r.conversation_id, r.sender, r.at,
                   r.raw_headers, r.text_body, r.html_body, r.answered, r.subject
              FROM d CROSS JOIN LATERAL (
                SELECT m.id, GREATEST(m.sent_at, m.synced_at) AS ord_at,
                       GREATEST(m.sent_at, m.synced_at)::text AS ord,
                       m.conversation_id, m.from_address->>'email' AS sender,
                       COALESCE(m.sent_at, m.synced_at) AS at,
                       m.raw_headers, m.text_body, m.subject,
                       CASE WHEN ${IS_REPORT} THEN m.html_body END AS html_body,
                       -- Everyone the mail a report answers went to: who it can be about.
                       CASE WHEN ${IS_REPORT} THEN (
                         SELECT jsonb_agg(DISTINCT lower(t->>'email'))
                           FROM (SELECT o.to_addresses || o.cc_addresses || o.bcc_addresses AS rcpts
                                   FROM ${table("app_mail", "messages")} o
                                  WHERE o.org_id = m.org_id AND o.direction = 'outbound'
                                    AND (o.external_message_id = m.in_reply_to
                                         OR m.message_references ? o.external_message_id)
                                  ORDER BY (o.external_message_id = m.in_reply_to) DESC NULLS LAST
                                  LIMIT 1) ans,
                                jsonb_array_elements(ans.rcpts) AS t
                          WHERE t->>'email' IS NOT NULL) END AS answered
                  FROM ${table("app_mail", "messages")} m
                  JOIN ${table("app_mail", "conversations")} c ON c.id = m.conversation_id
                  JOIN ${table("app_mail", "accounts")} a ON a.id = m.account_id
                 WHERE m.org_id = ${orgId}::uuid AND m.direction = 'inbound'
                   AND (c.contact_id = ANY(d.contacts)
                        OR c.id = d.conv
                        OR lower(m.from_address->>'email') = ANY(d.addrs)
                        OR lower(m.from_address->>'email') = ANY(d.senders)
                        -- A delivery report comes from the server, in a thread of its own:
                        -- it may be about an address its text names, or the mail it answers.
                        -- Which address failed is read in code (reportConcerns).
                        OR (${IS_REPORT}
                            AND (EXISTS (SELECT 1 FROM unnest(d.addr_res) AS re
                                          WHERE lower(COALESCE(m.text_body, '')) ~ re
                                             OR lower(COALESCE(m.html_body, '')) ~ re)
                                 OR EXISTS (SELECT 1 FROM ${table("app_mail", "messages")} o
                                             WHERE o.org_id = m.org_id AND o.direction = 'outbound'
                                               AND (o.external_message_id = m.in_reply_to
                                                    OR m.message_references ? o.external_message_id)
                                               AND EXISTS (SELECT 1 FROM jsonb_array_elements(o.to_addresses
                                                                || o.cc_addresses || o.bcc_addresses) AS t
                                                            WHERE lower(t->>'email') = ANY(d.addrs))))))
                   AND lower(m.from_address->>'email') <> ALL(${textSet(own)})
                   AND (COALESCE(m.sent_at, m.synced_at) > d.since
                        OR (m.synced_at > d.since
                            AND (m.sent_at > a.created_at
                                 OR m.sent_at > d.since - interval '72 hours')))
                   AND (d.cur_id IS NULL
                        OR (GREATEST(m.sent_at, m.synced_at), m.id) < (d.cur_ord, d.cur_id))
                 ORDER BY GREATEST(m.sent_at, m.synced_at) DESC, m.id DESC
                 LIMIT ${INBOUND_PAGE}
              ) r
             ORDER BY d.k, r.ord_at DESC, r.id DESC`),
        ),
      (row) => ({
        id: row.id,
        kind: reportAbout(
          classifyInbound(
            row.raw_headers,
            row.subject,
            reportText(row.text_body, row.html_body),
            row.sender,
          ),
          {
            textBody: row.text_body,
            htmlBody: row.html_body,
            answered: row.answered,
            addresses: queries.get(row.k)?.addresses ?? [],
          },
        ),
        sender: row.sender,
        at: new Date(row.at),
        textBody: row.text_body,
        record: { kind: "conversation", id: row.conversation_id },
      }),
    ),
  )
}

/**
 * A client who answers through the support address has answered. Only this check
 * reads it: a reply on a ticket stays unguarded. An import is history whatever
 * its dates say, so a ledger row rules it out. Ticket ingest already dropped
 * auto-responders, so only the subject and the text are left to classify.
 */
async function readTicketInbound(
  orgId: string,
  own: readonly string[],
  queries: ReadonlyMap<string, InboundQuery>,
  db?: PrivilegedDb,
): Promise<InboundRead> {
  type Row = {
    k: string
    id: string
    ord: string
    ticket_id: string
    sender: string | null
    at: string | Date
    text_body: string | null
    subject: string | null
  }
  return onPrivileged(db, orgId, "send-guard-ticket-inbound", async (tx) => {
    const present = extractRows<{ name: string | null }>(
      await tx.execute(
        drizzleSql`SELECT to_regclass(${`${quoteIdent(schemaRef("app_tickets"))}.messages`})::text AS name`,
      ),
    )
    if (!present[0]?.name) return new Map([...queries.keys()].map((k) => [k, []]))
    return pageInbound(
      [...queries.keys()],
      async (open) =>
        extractRows<Row>(
          await tx.execute(drizzleSql`
            WITH d AS (${openDrafts(queries, open)})
            SELECT d.k, r.id, r.ord, r.ticket_id, r.sender, r.at, r.text_body, r.subject
              FROM d CROSS JOIN LATERAL (
                SELECT m.id, COALESCE(m.sent_at, m.received_at) AS ord_at,
                       COALESCE(m.sent_at, m.received_at)::text AS ord,
                       m.ticket_id, m.from_email AS sender,
                       COALESCE(m.sent_at, m.received_at) AS at, m.text_body, m.subject
                  FROM ${table("app_tickets", "messages")} m
                  JOIN ${table("app_tickets", "tickets")} t ON t.id = m.ticket_id
                  LEFT JOIN ${table("app_tickets", "inboxes")} i ON i.id = t.source_inbox_id
                 WHERE m.org_id = ${orgId}::uuid AND m.kind = 'inbound'
                   AND (lower(m.from_email) = ANY(d.addrs)
                        OR lower(m.from_email) = ANY(d.senders)
                        OR t.contact_id = ANY(d.contacts))
                   AND lower(m.from_email) <> ALL(${textSet(own)})
                   AND (COALESCE(m.sent_at, m.received_at) > d.since
                        OR (m.received_at > d.since
                            AND (m.sent_at > i.created_at
                                 OR m.sent_at > d.since - interval '72 hours')))
                   AND NOT EXISTS (SELECT 1 FROM ${table("kernel", "import_ledger")} l
                                    WHERE l.table_name = 'app_tickets.messages' AND l.row_id = m.id)
                   AND (d.cur_id IS NULL
                        OR (COALESCE(m.sent_at, m.received_at), m.id) < (d.cur_ord, d.cur_id))
                 ORDER BY COALESCE(m.sent_at, m.received_at) DESC, m.id DESC
                 LIMIT ${INBOUND_PAGE}
              ) r
             ORDER BY d.k, r.ord_at DESC, r.id DESC`),
        ),
      (row) => ({
        id: row.id,
        kind: reportAbout(classifyInbound({}, row.subject, row.text_body, row.sender), {
          textBody: row.text_body,
          htmlBody: null,
          answered: null,
          addresses: queries.get(row.k)?.addresses ?? [],
        }),
        sender: row.sender,
        at: new Date(row.at),
        textBody: row.text_body,
        record: { kind: "ticket", id: row.ticket_id },
      }),
    )
  })
}

// ── Providers: another app's say over a mail about one of its records ───────

const PROVIDER_TIMEOUT_MS = 2000

interface FoundProvider {
  app: string
  tool: string
  serviceMessage: boolean
}

function findProvider(orgId: string, kind: string): FoundProvider | null {
  for (const [[, app], manifest] of appBridgeManifestRegistry.entriesOf(orgId)) {
    const entry = manifest.sendGuardProviders?.[kind]
    if (entry) return { app, tool: entry.tool, serviceMessage: entry.serviceMessage === true }
  }
  return null
}

/**
 * The pill a provider declares for a mail about one of its records ("Billing: payment reminder"):
 * the first ref's provider entry names the row, over the tool's own pill, since one tool
 * (`mail:compose`) carries several kinds of send.
 */
export function sendGuardProviderPill(
  orgId: string,
  kind: string,
): { label: string; labelKey?: string } | undefined {
  for (const [, manifest] of appBridgeManifestRegistry.entriesOf(orgId)) {
    const pill = manifest.sendGuardProviders?.[kind]?.pill
    if (pill && typeof pill.label === "string" && pill.label.length > 0) return pill
  }
  return undefined
}

type ProviderAnswer =
  | { stop: false }
  | { stop: true; code: string; label: string }
  | { unavailable: string }

async function askProvider(
  orgId: string,
  provider: FoundProvider,
  ref: SendGuardRef,
): Promise<ProviderAnswer> {
  const toolName = `${provider.app}:${provider.tool}`
  if (toolRegistry.get([orgId, provider.app, provider.tool])?.readOnly !== true) {
    return { unavailable: `${toolName} is not a read-only tool` }
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<ProviderAnswer>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ unavailable: `${toolName} did not answer within 2 seconds` })
    }, PROVIDER_TIMEOUT_MS)
  })
  const { executeToolCore } = await import("~/modules/apps/execute-tool")
  const asked = executeToolCore({
    toolName,
    orgId,
    actor: { actorType: "system", orgId, purpose: "job", scopes: [`${provider.app}:*`] },
    params: { ref },
    origin: "system",
    signal: controller.signal,
  }).then((envelope): ProviderAnswer => {
    if (!("data" in envelope)) return { unavailable: `${toolName} did not answer` }
    const data = envelope.data as { stop?: unknown; code?: unknown; label?: unknown } | null
    if (data?.stop !== true) return { stop: false }
    return {
      stop: true,
      code: typeof data.code === "string" ? data.code : "send_guard_ref_stop",
      label: typeof data.label === "string" ? data.label : `${toolName} said not to send this`,
    }
  })
  try {
    return await Promise.race([asked, timedOut])
  } catch (err) {
    rootLogger.warn({ err, orgId, toolName }, "send guard provider failed")
    return { unavailable: `${toolName} failed` }
  } finally {
    clearTimeout(timer)
  }
}

// ── The check ───────────────────────────────────────────────────────────────

export interface EvaluateSendGuardInput {
  orgId: string
  guard: PinnedSendGuard
  /** The current payload's To, Cc and Bcc, so an approver's edit is checked. */
  recipients: readonly string[]
  /** The staged tool: a new message (`mail:compose`) is decided commercial again from its recipients. */
  toolName?: string
  /** Providers do not run at a card read. A kind with no provider refuses at stage and passes at send. */
  at: "stage" | "card" | "send"
  now?: Date
  locale?: string | null
  timeZone?: string | null
  /** The caller's privileged transaction (a claim holding the row lock): every read runs on it. */
  db?: PrivilegedDb
}

const CLEAR: SendGuardVerdict = { state: "clear", final: false }

function unavailable(reason: string, code?: string): SendGuardVerdict {
  return { state: "unavailable", final: false, reason, ...(code ? { code } : {}) }
}

/**
 * The one check, at preflight, card read and handler. A read that fails answers
 * `unavailable`, which never sends: it fails closed.
 */
export async function evaluateSendGuard(input: EvaluateSendGuardInput): Promise<SendGuardVerdict> {
  let now: Awaited<ReturnType<typeof classificationNow>>
  try {
    now = await classificationNow(
      input.orgId,
      input.guard,
      input.recipients,
      input.toolName,
      input.db,
    )
  } catch (err) {
    rootLogger.error({ err, orgId: input.orgId }, "send guard: the recipients could not be read")
    return unavailable("the recipients could not be read")
  }
  // 0. A commercial mail's one opt-out link is its one outside recipient's.
  const tooMany = now.classification === "marketing" ? moreThanOneOutside(now.outside) : null
  if (tooMany) return oneRecipientStop(tooMany)
  const verdict = await evaluateAs(input, { ...input.guard, classification: now.classification })
  return { ...verdict, classification: now.classification }
}

async function evaluateAs(
  input: EvaluateSendGuardInput,
  guard: PinnedSendGuard,
): Promise<SendGuardVerdict> {
  const { orgId, recipients, at } = input

  // 1. Stays on whatever the operator switch says: an opt-out is the law, not our design.
  if (guard.classification === "marketing") {
    let optedOut: string[]
    try {
      optedOut = await suppressedAmong(orgId, [...recipients], input.db)
    } catch (err) {
      rootLogger.error({ err, orgId }, "send guard: suppression check failed")
      return unavailable("the opt-out list could not be read", "suppression_check_unavailable")
    }
    if (optedOut.length > 0) return { state: "opted_out", final: true, optedOut }
  }
  if (!env.MAIL_SEND_GUARD_ENFORCE) return CLEAR

  try {
    // 2. Typed slot, a final stop with its label on the card.
    if (guard.classification === "marketing") {
      const problem = await lawfulBasisProblem(orgId, guard.contactIds, [...recipients])
      if (problem) {
        return {
          state: "ref_stop",
          final: true,
          code: problem.code,
          label: problem.label,
          who: problem.who,
        }
      }
    }

    // 3.
    if (at !== "card") {
      for (const ref of guard.refs) {
        const provider = findProvider(orgId, ref.kind)
        if (!provider) {
          if (at === "stage") return unavailable(`nothing can check a ${ref.kind} record`)
          rootLogger.warn(
            { orgId, kind: ref.kind },
            "send guard: the app that checked this kind of record is gone, sending",
          )
          continue
        }
        const answer = await askProvider(orgId, provider, ref)
        if ("unavailable" in answer) return unavailable(answer.unavailable)
        if (answer.stop) {
          return { state: "ref_stop", final: true, code: answer.code, label: answer.label }
        }
      }
    }

    // 4 to 6.
    const [verdict] = await inboundVerdicts(orgId, [{ ...input, guard }], input.db)
    return verdict ?? unavailable("the mail and tickets could not be read")
  } catch (err) {
    rootLogger.error({ err, orgId }, "send guard: a read failed, not sending")
    return unavailable("the mail and tickets could not be read")
  }
}

interface InboundCheck {
  guard: PinnedSendGuard
  recipients: readonly string[]
  now?: Date
  locale?: string | null
  timeZone?: string | null
}

/** What the inbound rows say about one draft; `set` and `addresses` say who its own people are. */
function inboundVerdict(
  inbound: readonly GuardInbound[],
  check: InboundCheck,
  side: { set: GuardContactSet; addresses: readonly string[] },
): SendGuardVerdict {
  const { guard } = check
  const decision = decideSendGuard({
    inbound,
    now: check.now ?? new Date(),
    ...(guard.ignoreAutoReply ? { ignoreAutoReply: guard.ignoreAutoReply } : {}),
    locale: check.locale ?? null,
    timeZone: check.timeZone ?? null,
  })
  if (decision.state === "clear") return CLEAR
  const record = inbound.find((item) => item.id === decision.messageId)?.record
  // Someone other than the draft's own people, outside its own conversation: a colleague of
  // theirs the company brought in, who may have written to a mailbox the reader cannot open.
  const sender = decision.who?.trim().toLowerCase() ?? null
  const ownPerson = sender !== null && side.addresses.includes(sender)
  const ownConversation =
    record?.kind === "conversation" && !!guard.conversationId && record.id === guard.conversationId
  const thirdParty =
    ownPerson || ownConversation
      ? null
      : { company: (sender ? side.set.companyOf.get(sender) : undefined) ?? side.set.company }
  const named = {
    who: decision.who,
    at: decision.at.toISOString(),
    ...(record ? { record } : {}),
    ...(thirdParty ? { thirdParty } : {}),
  }
  if (decision.state === "held") {
    return {
      state: "held",
      final: false,
      ...named,
      holdUntil: decision.holdUntil.toISOString(),
      returnDate: decision.returnDate,
    }
  }
  return { state: decision.state, final: true, ...named }
}

/**
 * Steps 4 to 6 for several drafts at once: one read of the org's own addresses, then mail and
 * ticket pages shared by every draft. A draft with too many rows to rule a reply out answers
 * unavailable; a read that fails throws.
 */
async function inboundVerdicts(
  orgId: string,
  checks: readonly InboundCheck[],
  db?: PrivilegedDb,
): Promise<SendGuardVerdict[]> {
  if (checks.length === 0) return []
  const queries = new Map<string, InboundQuery>()
  const sets = await guardContactSets(
    orgId,
    checks.map((check) => check.guard.contactIds),
    db,
  )
  for (const [i, check] of checks.entries()) {
    const { guard } = check
    const set = sets[i] as GuardContactSet
    queries.set(String(i), {
      contactIds: set.contactIds,
      addresses: [
        ...new Set([...guard.addresses, ...check.recipients].map((a) => a.toLowerCase())),
      ],
      senders: set.colleagueAddresses,
      since: guard.since,
      ...(guard.conversationId ? { conversationId: guard.conversationId } : {}),
    })
  }
  const own = await ownAddresses(orgId, db)
  const mail = await readMailInbound(orgId, own, queries, db)
  const tickets = await readTicketInbound(orgId, own, queries, db)
  return checks.map((check, i) => {
    const fromMail = mail.get(String(i))
    const fromTickets = tickets.get(String(i))
    if (!fromMail || !fromTickets) {
      rootLogger.error(
        { orgId },
        `send guard: over ${INBOUND_MAX_ROWS} inbound rows to read without a reply, not sending`,
      )
      return unavailable("the mail and tickets could not be read")
    }
    return inboundVerdict([...fromMail, ...fromTickets], check, {
      set: sets[i] as GuardContactSet,
      addresses: queries.get(String(i))?.addresses ?? [],
    })
  })
}

export interface CardSendGuardCheck {
  guard: PinnedSendGuard
  /** The current payload's To, Cc and Bcc. */
  recipients: readonly string[]
  toolName?: string
  locale?: string | null
  timeZone?: string | null
}

/**
 * What `evaluateSendGuard` answers at `card`, for many drafts at once (a list, Home's feed, the
 * badge every push counts). The number of queries does not grow with the drafts: the opt-out list
 * is read once for all their recipients, and the inbound reads are shared pages. The answers are
 * in the order of `checks`.
 */
export async function evaluateSendGuardsAtCard(
  orgId: string,
  asked: readonly CardSendGuardCheck[],
  now: Date = new Date(),
): Promise<SendGuardVerdict[]> {
  let checks: readonly CardSendGuardCheck[] = asked
  const out: Array<SendGuardVerdict | undefined> = checks.map(() => undefined)

  // 0. Each draft's class from its recipients as they stand, in shared reads: who is a
  // colleague once, and which outside addresses the data marks commercial once.
  let colleagues: Awaited<ReturnType<typeof readColleagues>>
  let commercial: Set<string>
  try {
    colleagues = await withPrivilegedDb(orgId, "send-guard-colleagues", (tx) =>
      readColleagues(tx, orgId),
    )
    const outsideOf = (c: CardSendGuardCheck) =>
      c.recipients.filter((a) => !isColleague(colleagues, a))
    const asked = checks.filter(
      (c) =>
        c.guard.classification === "none" &&
        c.guard.mode === "plain" &&
        c.toolName === "mail:compose",
    )
    commercial = await commercialAmong(orgId, [...new Set(asked.flatMap(outsideOf))])
  } catch (err) {
    rootLogger.error({ err, orgId }, "send guard: the recipients could not be read")
    return checks.map(() => unavailable("the recipients could not be read"))
  }
  const classes = checks.map((c) => {
    const outside = c.recipients.filter((a) => !isColleague(colleagues, a))
    const classification =
      c.guard.classification !== "none"
        ? c.guard.classification
        : classifyBy(orgId, {
            toolName: c.toolName,
            mode: c.guard.mode,
            refs: c.guard.refs,
            saidService: false,
            outside,
            commercial,
          })
    return { classification, outside }
  })
  for (const [i, k] of classes.entries()) {
    const tooMany = k.classification === "marketing" ? moreThanOneOutside(k.outside) : null
    if (tooMany) out[i] = oneRecipientStop(tooMany)
  }
  checks = checks.map((c, i) => ({
    ...c,
    guard: { ...c.guard, classification: (classes[i] as (typeof classes)[number]).classification },
  }))

  // 1. Stays on whatever the operator switch says.
  const marketing = checks.flatMap((c, i) =>
    c.guard.classification === "marketing" && !out[i] ? [i] : [],
  )
  if (marketing.length > 0) {
    const all = [
      ...new Set(marketing.flatMap((i) => [...(checks[i] as CardSendGuardCheck).recipients])),
    ]
    let suppressed: Set<string> | null
    try {
      suppressed = new Set((await suppressedAmong(orgId, all)).map((a) => a.toLowerCase()))
    } catch (err) {
      rootLogger.error({ err, orgId }, "send guard: suppression check failed")
      suppressed = null
    }
    for (const i of marketing) {
      if (suppressed === null) {
        out[i] = unavailable("the opt-out list could not be read", "suppression_check_unavailable")
        continue
      }
      const hit = suppressed
      const optedOut = (checks[i] as CardSendGuardCheck).recipients.filter((r) =>
        hit.has(r.toLowerCase()),
      )
      if (optedOut.length > 0) out[i] = { state: "opted_out", final: true, optedOut }
    }
  }
  const withClass = (v: SendGuardVerdict, i: number): SendGuardVerdict => ({
    ...v,
    classification: (classes[i] as (typeof classes)[number]).classification,
  })
  if (!env.MAIL_SEND_GUARD_ENFORCE) return out.map((v, i) => withClass(v ?? CLEAR, i))

  // 2. Typed slot, a final stop with its label on the card. 3. Providers do not run at a card.
  for (const i of marketing) {
    if (out[i]) continue
    const check = checks[i] as CardSendGuardCheck
    try {
      const problem = await lawfulBasisProblem(orgId, check.guard.contactIds, [...check.recipients])
      if (problem) {
        out[i] = {
          state: "ref_stop",
          final: true,
          code: problem.code,
          label: problem.label,
          who: problem.who,
        }
      }
    } catch (err) {
      rootLogger.error({ err, orgId }, "send guard: a read failed, not sending")
      out[i] = unavailable("the mail and tickets could not be read")
    }
  }

  // 4 to 6.
  const rest = checks.flatMap((c, i) => (out[i] ? [] : [{ i, check: { ...c, now } }]))
  try {
    const verdicts = await inboundVerdicts(
      orgId,
      rest.map((r) => r.check),
    )
    for (const [j, r] of rest.entries()) out[r.i] = verdicts[j]
  } catch (err) {
    rootLogger.error({ err, orgId }, "send guard: a read failed, not sending")
    for (const r of rest) out[r.i] = unavailable("the mail and tickets could not be read")
  }
  return out.map((v, i) => withClass(v ?? unavailable("the mail and tickets could not be read"), i))
}

/** Each person's zone and language, in one read. */
export async function personZones(
  orgId: string,
  userIds: readonly (string | null)[],
): Promise<Map<string, { locale: string | null; timeZone: string | null }>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id && UUID.test(id)))]
  const out = new Map<string, { locale: string | null; timeZone: string | null }>()
  if (ids.length === 0) return out
  const rows = await withPrivilegedDb(orgId, "send-guard-person-zone", async (tx) =>
    extractRows<{ id: string; locale: string | null; timezone: string | null }>(
      await tx.execute(drizzleSql`
        SELECT id, locale, timezone FROM ${table("kernel", "users")}
         WHERE id = ANY(${uuidSet(ids)}) AND org_id = ${orgId}::uuid`),
    ),
  )
  for (const row of rows) out.set(row.id, { locale: row.locale, timeZone: row.timezone })
  return out
}

// ── Build, in the preflight ─────────────────────────────────────────────────

export interface BuildSendGuardInput {
  orgId: string
  toolName: "mail:compose" | "mail:reply"
  /** A routine that follows up, or a caller that said so. */
  followUpRun: boolean
  followUp?: { refs?: SendGuardRef[]; classification?: "marketing" | "service" } | null
  recipients: readonly string[]
  contactIds: readonly string[]
  conversationId?: string
  /** Staged by an agent, a routine or a connected client, not by a person's own call. */
  agentStaged?: boolean
  now?: Date
  locale?: string | null
  timeZone?: string | null
}

export type BuildSendGuardResult =
  | { sendGuard: PinnedSendGuard; guardKey?: string; verdict: SendGuardVerdict }
  | { commercialIdentityMissing: true }
  | { refused: { code: string; message: string } }

async function newestOutboundAt(
  orgId: string,
  contactIds: readonly string[],
  addresses: readonly string[],
): Promise<string | null> {
  const rows = await withPrivilegedDb(orgId, "send-guard-newest-outbound", async (tx) =>
    extractRows<{ at: string | Date | null }>(
      await tx.execute(drizzleSql`
        SELECT max(COALESCE(m.sent_at, m.synced_at)) AS at
          FROM ${table("app_mail", "messages")} m
          JOIN ${table("app_mail", "conversations")} c ON c.id = m.conversation_id
         WHERE m.org_id = ${orgId}::uuid AND m.direction = 'outbound'
           AND (c.contact_id = ANY(${uuidSet(contactIds)})
                OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(m.to_addresses) = 'array' THEN m.to_addresses ELSE '[]'::jsonb END ||
                    CASE WHEN jsonb_typeof(m.cc_addresses) = 'array' THEN m.cc_addresses ELSE '[]'::jsonb END ||
                    CASE WHEN jsonb_typeof(m.bcc_addresses) = 'array' THEN m.bcc_addresses ELSE '[]'::jsonb END
                  ) AS e
                   WHERE lower(COALESCE(e->>'email', substring(e#>>'{}' from '<([^>]+)>'), e#>>'{}'))
                         = ANY(${textSet(addresses)})))`),
    ),
  )
  const at = rows[0]?.at
  return at ? new Date(at).toISOString() : null
}

/**
 * What a plain reply answers: everything in the conversation that has already
 * reached us. The moment it reached us counts, not the date it was sent: every
 * message is synced after it was sent, so a date alone would make the message
 * being answered read as a newer reply to itself. Rounded up, since the value
 * travels as a millisecond ISO date and the column holds microseconds.
 */
async function newestInboundInConversation(
  orgId: string,
  conversationId: string,
): Promise<string | null> {
  const rows = await withPrivilegedDb(orgId, "send-guard-newest-inbound", async (tx) =>
    extractRows<{ at: string | Date | null }>(
      await tx.execute(drizzleSql`
        SELECT date_trunc('milliseconds', max(GREATEST(sent_at, synced_at))) + interval '1 millisecond' AS at
          FROM ${table("app_mail", "messages")}
         WHERE org_id = ${orgId}::uuid AND direction = 'inbound'
           AND conversation_id = ${conversationId}::uuid`),
    ),
  )
  const at = rows[0]?.at
  return at ? new Date(at).toISOString() : null
}

function guardKeyOf(refs: readonly SendGuardRef[], addresses: readonly string[]): string {
  const first = refs[0]
  if (first) return `ref:${first.kind}:${first.id}`
  const digest = createHash("sha256")
    .update([...addresses].sort().join(","))
    .digest("hex")
  return `to:${digest}`
}

/** What the card reads when a plain draft goes to someone who opted out. */
async function optedOutLine(orgId: string, recipients: readonly string[]): Promise<string | null> {
  try {
    const hit = await suppressedAmong(orgId, [...recipients])
    return hit.length > 0
      ? `${hit.join(", ")} opted out. Send only if this is not commercial.`
      : null
  } catch (err) {
    rootLogger.warn({ err, orgId }, "send guard: opt-out line not added, the list was unreadable")
    return null
  }
}

/** The recipients outside the organization: anyone who is not a colleague (`readColleagues`). */
async function outsideRecipients(
  orgId: string,
  recipients: readonly string[],
  db?: PrivilegedDb,
): Promise<string[]> {
  if (recipients.length === 0) return []
  const colleagues = await onPrivileged(db, orgId, "send-guard-colleagues", (tx) =>
    readColleagues(tx, orgId),
  )
  return recipients.filter((address) => !isColleague(colleagues, address))
}

/**
 * A new message is commercial by what the data says of its recipients, never by
 * the model: one of them is the contact of an open deal (directly or through
 * its company), or was recorded under professional interest, or came from a
 * third party or an enrichment. Read fresh, privileged, for whoever stages.
 */
async function commercialByData(
  orgId: string,
  recipients: readonly string[],
  db?: PrivilegedDb,
): Promise<boolean> {
  return (await commercialAmong(orgId, recipients, db)).size > 0
}

/** The addresses among `recipients` the data marks as commercial (`commercialByData`), in one read. */
async function commercialAmong(
  orgId: string,
  recipients: readonly string[],
  db?: PrivilegedDb,
): Promise<Set<string>> {
  if (recipients.length === 0) return new Set()
  const addresses = textSet(recipients.map((r) => r.trim().toLowerCase()))
  const rows = await onPrivileged(db, orgId, "send-guard-commercial-by-data", async (tx) => {
    const projects = extractRows<{ present: boolean }>(
      await tx.execute(
        drizzleSql`SELECT to_regclass(${`${schemaRef("app_projects")}.deals`}) IS NOT NULL AS present`,
      ),
    )[0]?.present
    const onDeal = projects
      ? drizzleSql`OR EXISTS (
          SELECT 1 FROM ${table("app_projects", "deals")} d
            JOIN ${table("app_projects", "tasks")} t ON t.id = d.task_id AND t.org_id = d.org_id
           WHERE d.org_id = c.org_id AND d.outcome = 'open' AND t.archived_at IS NULL
             AND (d.contact_id = c.id OR (c.company_id IS NOT NULL AND d.company_id = c.company_id)))`
      : drizzleSql``
    return extractRows<{ email: string }>(
      await tx.execute(drizzleSql`
        SELECT DISTINCT lower(c.email) AS email FROM ${table("kernel", "contacts")} c
         WHERE c.org_id = ${orgId}::uuid AND lower(c.email) = ANY(${addresses})
           AND (c.lawful_basis = 'professional_interest'
                OR c.data_source IN ('third_party', 'enrichment')
                ${onDeal})`),
    )
  })
  return new Set(rows.map((row) => row.email))
}

/**
 * The commercial decision, one rule wherever it is taken: a follow-up is marketing unless it
 * said service and a record backs that; a new message is marketing when the data marks one of
 * its outside recipients as a prospect; anything else is not commercial.
 */
function classifyBy(
  orgId: string,
  facts: {
    toolName: string | undefined
    mode: PinnedSendGuard["mode"]
    refs: readonly SendGuardRef[]
    saidService: boolean
    outside: readonly string[]
    commercial: ReadonlySet<string>
  },
): PinnedSendGuard["classification"] {
  if (facts.mode === "followup") {
    const backed = facts.refs.some((ref) => findProvider(orgId, ref.kind)?.serviceMessage === true)
    return facts.saidService && backed ? "service" : "marketing"
  }
  if (facts.toolName === "mail:compose" && facts.outside.some((a) => facts.commercial.has(a))) {
    return "marketing"
  }
  return "none"
}

/** A commercial mail names more than one outside person: why it cannot go, or null. */
function moreThanOneOutside(outside: readonly string[]): string | null {
  return outside.length > 1
    ? `A commercial mail goes to one person outside the organization, and this one names ${outside.length}: ${outside.join(", ")}.`
    : null
}

const ONE_PER_PERSON_NEXT =
  "Next: send one message per person; each gets their own opt-out link. Colleagues may stay on copy."

/**
 * The class a waiting draft is checked under now, from its recipients as they stand (an edit may
 * have changed them since stage), with its outside recipients. A class pinned at stage never
 * drops; one pinned as not commercial is decided again by the rule that decided it at stage.
 */
async function classificationNow(
  orgId: string,
  guard: PinnedSendGuard,
  recipients: readonly string[],
  toolName: string | undefined,
  db?: PrivilegedDb,
): Promise<{ classification: PinnedSendGuard["classification"]; outside: string[] }> {
  const outside = await outsideRecipients(orgId, recipients, db)
  if (guard.classification !== "none") return { classification: guard.classification, outside }
  const commercial =
    guard.mode === "plain" && toolName === "mail:compose"
      ? await commercialAmong(orgId, outside, db)
      : new Set<string>()
  return {
    classification: classifyBy(orgId, {
      toolName,
      mode: guard.mode,
      refs: guard.refs,
      saidService: false,
      outside,
      commercial,
    }),
    outside,
  }
}

/** The stop for a commercial mail that names more than one outside person, at a later check. */
function oneRecipientStop(label: string): SendGuardVerdict {
  return {
    state: "ref_stop",
    final: true,
    code: "commercial_one_recipient",
    label,
    classification: "marketing",
  }
}

function day10(iso: string): string {
  return iso.slice(0, 10)
}

/**
 * The value pinned on a staged send, and what the check answers about it now.
 * A follow-up, or a new message the data makes commercial, can be refused here;
 * an agent's new message to someone who opted out is refused; a person's own
 * plain draft always stages, with a line when someone opted out.
 */
export async function buildSendGuard(input: BuildSendGuardInput): Promise<BuildSendGuardResult> {
  const now = input.now ?? new Date()
  const stagedAt = now.toISOString()
  const refs = input.followUp?.refs ?? []
  const mode = input.followUpRun || input.followUp ? "followup" : "plain"
  const addresses = [...input.recipients]
  const contactIds = [...input.contactIds]
  const outside = await outsideRecipients(input.orgId, addresses)

  const classification = classifyBy(input.orgId, {
    toolName: input.toolName,
    mode,
    refs,
    saidService: input.followUp?.classification === "service",
    outside,
    commercial:
      mode === "plain" && input.toolName === "mail:compose"
        ? await commercialAmong(input.orgId, outside)
        : new Set<string>(),
  })

  // Each commercial mail's opt-out link is its one outside recipient's.
  const tooMany = classification === "marketing" ? moreThanOneOutside(outside) : null
  if (tooMany) {
    return {
      refused: {
        code: "commercial_one_recipient",
        message: `Nothing was sent and no draft was staged. ${tooMany} ${ONE_PER_PERSON_NEXT}`,
      },
    }
  }

  let since = stagedAt
  if (mode === "followup" && classification !== "service") {
    since = (await newestOutboundAt(input.orgId, contactIds, addresses)) ?? stagedAt
  } else if (mode === "plain" && input.toolName === "mail:reply" && input.conversationId) {
    since = (await newestInboundInConversation(input.orgId, input.conversationId)) ?? stagedAt
  }

  const sendGuard: PinnedSendGuard = {
    v: 1,
    applies: true,
    mode,
    since,
    stagedAt,
    addresses,
    contactIds,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    refs,
    classification,
  }

  if (mode === "plain" && classification !== "marketing") {
    // An agent's new message never goes to someone who opted out; a reply in
    // their own thread does, and a person's own draft stages with the line.
    if (input.agentStaged && input.toolName === "mail:compose") {
      const hits = await listSuppressions(input.orgId, addresses)
      if (hits.length > 0) {
        const who = hits.map((h) => `${h.email} opted out on ${day10(h.createdAt)}`).join("; ")
        return {
          refused: {
            code: "suppressed_new_message",
            message: `Nothing was sent and no draft was staged. ${who}. Next: reply in their own thread, or ask a person to write.`,
          },
        }
      }
    }
    const line = await optedOutLine(input.orgId, addresses)
    return { sendGuard: line ? { ...sendGuard, line } : sendGuard, verdict: CLEAR }
  }
  if (classification === "marketing" && (await commercialIdentityMissing(input.orgId))) {
    return { commercialIdentityMissing: true }
  }
  return {
    sendGuard,
    ...(mode === "followup" ? { guardKey: guardKeyOf(refs, addresses) } : {}),
    verdict: await evaluateSendGuard({
      orgId: input.orgId,
      guard: sendGuard,
      recipients: addresses,
      toolName: input.toolName,
      at: "stage",
      now,
      locale: input.locale ?? null,
      timeZone: input.timeZone ?? null,
    }),
  }
}

/** When a request was staged and who asked for it, for a call staged with no guard. */
export async function requestFacts(
  orgId: string,
  requestId: string,
): Promise<{ createdAt: Date; requestedBy: string | null } | null> {
  const rows = await withPrivilegedDb(orgId, "send-guard-request", async (tx) =>
    extractRows<{ created_at: string | Date; requested_by: string | null }>(
      await tx.execute(drizzleSql`
        SELECT created_at, requested_by FROM ${table("kernel", "approval_requests")}
         WHERE id = ${requestId}::uuid AND org_id = ${orgId}::uuid`),
    ),
  )
  const row = rows[0]
  return row ? { createdAt: new Date(row.created_at), requestedBy: row.requested_by } : null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A hold's date is read in the requester's zone and language. */
export async function personZone(
  orgId: string,
  userId: string | null,
  db?: PrivilegedDb,
): Promise<{ locale: string | null; timeZone: string | null }> {
  // A system actor has no person behind it, and no zone.
  if (!userId || !UUID.test(userId)) return { locale: null, timeZone: null }
  const rows = await onPrivileged(db, orgId, "send-guard-person-zone", async (tx) =>
    extractRows<{ locale: string | null; timezone: string | null }>(
      await tx.execute(drizzleSql`
        SELECT locale, timezone FROM ${table("kernel", "users")}
         WHERE id = ${userId}::uuid AND org_id = ${orgId}::uuid`),
    ),
  )
  return { locale: rows[0]?.locale ?? null, timeZone: rows[0]?.timezone ?? null }
}

/** A staged call with no guard (a chained `@ref` step, or one staged before this check existed). */
export function plainGuardSince(
  recipients: readonly string[],
  contactIds: readonly string[],
  since: Date,
  conversationId?: string,
): PinnedSendGuard {
  return {
    v: 1,
    applies: true,
    mode: "plain",
    since: since.toISOString(),
    stagedAt: since.toISOString(),
    addresses: [...recipients],
    contactIds: [...contactIds],
    ...(conversationId ? { conversationId } : {}),
    refs: [],
    classification: "none",
  }
}

export function isPinnedSendGuard(value: unknown): value is PinnedSendGuard {
  if (value === null || typeof value !== "object") return false
  const guard = value as Partial<PinnedSendGuard>
  return (
    guard.v === 1 &&
    guard.applies === true &&
    typeof guard.since === "string" &&
    Array.isArray(guard.addresses) &&
    Array.isArray(guard.contactIds) &&
    Array.isArray(guard.refs)
  )
}

/** The refusal sentence when a commercial mail's identity is unset, at stage or at send. */
export const COMMERCIAL_IDENTITY_MISSING_MESSAGE = `This organization has not set the legal name and postal address a commercial mail must state. Next: an admin sets them in ${COMMERCIAL_IDENTITY_SETTING}, then this can go.`

/**
 * Everything a commercial mail carries when it leaves: one opt-out link for its
 * one outside recipient, in the text, the HTML and the unsubscribe headers
 * alike, in that recipient's language. Never reaches the payload an approver saw. Null when the identity is
 * unset: the mail must not leave.
 */
export async function commercialFooterFor(
  orgId: string,
  recipient: string,
  textBody: unknown,
  htmlBody: unknown,
): Promise<{ textBody?: string; htmlBody?: string; headers: Record<string, string> } | null> {
  const identity = await readCommercialIdentity(orgId)
  if (!identity) return null
  const link = await mintOptOutLink(orgId, recipient)
  const locale = await recipientLocale(orgId, recipient)
  const out: { textBody?: string; htmlBody?: string } = {}
  if (typeof textBody === "string") {
    out.textBody = (
      await applyCommercialFooter(orgId, textBody, { kind: "text", link, locale }, identity)
    ).body
  }
  if (typeof htmlBody === "string" && htmlBody !== "") {
    out.htmlBody = (
      await applyCommercialFooter(orgId, htmlBody, { kind: "html", link, locale }, identity)
    ).body
  }
  return { ...out, headers: optOutHeaders(link) }
}

/** What a person's own new message gets, decided by its recipients' data, never by a choice of theirs. */
export type PersonComposeCheck =
  | { commercial: false; line: string | null }
  | { commercial: true; refused: { code: string; message: string } }
  | {
      commercial: true
      recipient: string
      footerLines: string[]
      /**
       * No lawful basis is recorded for the recipient: the person is told and
       * may still send (they are the accountable sender); an agent's mail is
       * refused for the same fact. `contactId` is the contact to record it on.
       */
      missingBasis: { contactId: string | null; name: string } | null
    }

/**
 * A person's own new message (the composer, or their own call): no approval and
 * no reply check, but the company's commercial rules. When the data marks a
 * recipient as a prospect, it goes to one outside person, never to someone who
 * opted out, never without the legal name and address, and it carries the
 * footer the composer shows (with the link as a label: the link itself is made
 * at send). Otherwise it is the person's own mail, with the opted-out line
 * when it applies.
 */
export async function checkPersonCompose(
  orgId: string,
  recipients: readonly string[],
): Promise<PersonComposeCheck> {
  const outside = await outsideRecipients(orgId, recipients)
  if (!(await commercialByData(orgId, outside))) {
    return { commercial: false, line: await optedOutLine(orgId, recipients) }
  }
  if (outside.length > 1) {
    return {
      commercial: true,
      refused: {
        code: "commercial_one_recipient",
        message: `Nothing was sent. This is a commercial mail, which goes to one person outside the organization, and it names ${outside.length}: ${outside.join(", ")}. Next: send one message per person; each gets their own opt-out link. Colleagues may stay on copy.`,
      },
    }
  }
  const hits = await listSuppressions(orgId, recipients)
  if (hits.length > 0) {
    const who = hits.map((h) => `${h.email} opted out on ${day10(h.createdAt)}`).join("; ")
    return {
      commercial: true,
      refused: {
        code: "suppressed_new_message",
        message: `Nothing was sent. ${who}, and this is a commercial mail. Next: remove them from this mail, or reply in their own thread.`,
      },
    }
  }
  const identity = await readCommercialIdentity(orgId)
  if (!identity) {
    return {
      commercial: true,
      refused: {
        code: "commercial_identity_missing",
        message: `Nothing was sent. ${COMMERCIAL_IDENTITY_MISSING_MESSAGE}`,
      },
    }
  }
  const recipient = outside[0] as string
  const locale = await recipientLocale(orgId, recipient)
  const facts = (await lawfulBasisFacts(orgId, [recipient])).recipients[0]
  const missingBasis =
    facts && !facts.basis && !facts.conflict
      ? { contactId: facts.contactIds[0] ?? null, name: facts.name ?? recipient }
      : null
  return {
    commercial: true,
    recipient,
    missingBasis,
    // The composer shows the notice line too when this mail will carry it.
    footerLines: footerLines(
      identity,
      serverT(locale, "mail.commercialFooter.linkLabel"),
      locale,
      await art14NoticeDue(orgId, recipient).then((due) =>
        due ? art14NoticeLine(identity, due.source, locale) : undefined,
      ),
    ),
  }
}

/**
 * What is recorded about each outside recipient who is a contact: their lawful
 * basis, whether they are a consumer or a business, and since when they opted
 * out. The composer shows it for a person's own mail, and an agent mail's card
 * shows the same, whatever the mail is classified. Recipients no contact holds
 * are left out.
 */
export async function recipientFacts(
  orgId: string,
  recipients: readonly string[],
): Promise<RecipientFact[]> {
  const known = (await lawfulBasisFacts(orgId, recipients)).recipients.filter(
    (r) => r.contactIds.length > 0,
  )
  if (known.length === 0) return []
  const since = new Map(
    (
      await listSuppressions(
        orgId,
        known.map((r) => r.email),
      )
    ).map((h) => [h.email.toLowerCase(), h.createdAt]),
  )
  return known.map((r) => ({
    email: r.email,
    name: r.name,
    basis: r.basis,
    isConsumer: r.isConsumer,
    optedOutAt: since.get(r.email) ?? null,
  }))
}

/** The one outside recipient a commercial mail's link is minted for (the first when none is outside). */
export async function commercialRecipient(
  orgId: string,
  recipients: readonly string[],
): Promise<string | null> {
  const outside = await outsideRecipients(orgId, recipients)
  return outside[0] ?? recipients[0] ?? null
}

// ── What the caller is told. Facts only, and never what a message said. ──────

function day(iso: string): string {
  return iso.slice(0, 16).replace("T", " ")
}

function whereItCameIn(verdict: SendGuardVerdict): string {
  const record = verdict.record
  if (!record)
    return verdict.source === "ticket"
      ? "It came in on a ticket you cannot open."
      : "It came in to a mailbox you cannot read."
  return record.kind === "ticket"
    ? `It is on ticket ${record.id}.`
    : `It is in conversation ${record.id}.`
}

function nextAfterReply(verdict: SendGuardVerdict): string {
  const record = verdict.record
  if (!record)
    return verdict.source === "ticket"
      ? "Next: ask whoever handles that ticket, or tell the person who wanted this mail."
      : "Next: ask whoever holds that mailbox, or tell the person who wanted this mail."
  return record.kind === "ticket"
    ? `Next: read ticket ${record.id} and answer there if it still needs an answer.`
    : `Next: read conversation ${record.id} and write a new reply if one is still needed.`
}

/**
 * One tool result for every stop: what happened, what did not, which record, and
 * the next step. `when` says how far the mail had got.
 */
export function describeStop(
  verdict: SendGuardVerdict,
  when: "stage" | "approved" | "auto",
): string {
  const notDone =
    when === "stage"
      ? "Nothing was sent and no draft was staged."
      : when === "auto"
        ? "The mail was not sent."
        : verdict.final
          ? "The mail was not sent and this request is closed."
          : "The mail was not sent. The request is back to pending."
  const who = verdict.who ?? "The other side"
  const at = verdict.at ? ` on ${day(verdict.at)} UTC` : ""
  switch (verdict.state) {
    case "replied":
      return `${notDone} ${who} replied${at}. ${whereItCameIn(verdict)} ${nextAfterReply(verdict)}`
    case "bounced":
      return `${notDone} A delivery failure for this mail's address came back from ${who}${at}. ${whereItCameIn(verdict)} Next: check the address before writing again.`
    case "opted_out":
      return `${notDone} ${(verdict.optedOut ?? []).join(", ")} opted out of commercial mail. Next: remove them from the recipients, or leave this mail unsent.`
    case "ref_stop":
      if (verdict.code === "commercial_one_recipient")
        return `${notDone} ${verdict.label ?? ""} ${ONE_PER_PERSON_NEXT}`
      return `${notDone} ${verdict.label ?? "The record this mail is about says not to send it."} Next: check that record before writing again.`
    case "held": {
      const until = verdict.holdUntil ? day(verdict.holdUntil) : ""
      // No return date at all: withheld from a reader who cannot open the message.
      const source =
        verdict.returnDate === undefined
          ? ""
          : verdict.returnDate
            ? `; their message gives ${verdict.returnDate} as the return date`
            : "; their message gives no return date, so the default of 7 days applies"
      return `${notDone} ${who} sent an automatic reply${at}${source}. It reads as held until ${until} UTC. ${whereItCameIn(verdict)} Next: a person can choose Send now on the card, or it clears by itself after that time.`
    }
    case "unavailable":
      return `${notDone} The check before sending could not run: ${verdict.reason ?? "a read failed"}. Next: try again shortly.`
    case "clear":
      return ""
  }
}

/**
 * A stop as told to a reader who cannot open the message that caused it: a third person (a
 * colleague of the draft's own people) is named only by their company, and their automatic
 * reply's return date is left out. The draft's own people stay named.
 */
export function withoutThirdParty<T extends SendGuardVerdict>(verdict: T): T {
  if (!verdict.thirdParty) return verdict
  const { thirdParty, returnDate: _withheld, ...rest } = verdict
  return {
    ...rest,
    who: thirdParty.company ? `Someone at ${thirdParty.company}` : null,
  } as T
}

/** The code of a stop: a provider's or a check's own, else one per state. */
export function stopCode(verdict: SendGuardVerdict): string {
  return verdict.code ?? `send_guard_${verdict.state}`
}
