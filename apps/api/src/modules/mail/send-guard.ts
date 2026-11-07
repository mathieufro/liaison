// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The send check's final say. An agent-staged mail must not go when the state
 * says it must not: a person answered, the address failed, or the person is away
 * and nobody has chosen to send anyway. Pure, so one decision serves the
 * preflight, the card and the handler alike.
 */
import { createHash } from "node:crypto"
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { appBridgeManifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { classifyInbound, type InboundKind } from "~/modules/mail/classify-inbound"
import { applyCommercialFooter, commercialIdentityMissing } from "~/modules/mail/commercial-footer"
import { parseReturnDate } from "~/modules/mail/parse-return-date"
import { lawfulBasisProblem, suppressedAmong } from "~/modules/mail/suppressions"

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

/**
 * Who counts as the other side at this evaluation. Read each time rather than
 * at stage, so a wider set reaches every draft already waiting. For now it is
 * the list pinned at stage.
 */
async function guardContactSet(_orgId: string, pinned: readonly string[]): Promise<string[]> {
  return [...pinned]
}
/** What one draft's inbound read is about. */
interface InboundQuery {
  contactIds: string[]
  addresses: string[]
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
      cur_ord: cursor?.ord ?? null,
      cur_id: cursor?.id ?? null,
    }
  })
  return drizzleSql`
    SELECT x.k, x.since::timestamptz AS since, x.conv::uuid AS conv,
           ARRAY(SELECT jsonb_array_elements_text(x.contacts)::uuid) AS contacts,
           ARRAY(SELECT jsonb_array_elements_text(x.addrs)) AS addrs,
           x.cur_ord::timestamptz AS cur_ord, x.cur_id::uuid AS cur_id
      FROM jsonb_to_recordset(${JSON.stringify(spec)}::jsonb)
        AS x(k text, since text, conv text, contacts jsonb, addrs jsonb, cur_ord text, cur_id text)`
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
                   r.raw_headers, r.text_body, r.subject
              FROM d CROSS JOIN LATERAL (
                SELECT m.id, GREATEST(m.sent_at, m.synced_at) AS ord_at,
                       GREATEST(m.sent_at, m.synced_at)::text AS ord,
                       m.conversation_id, m.from_address->>'email' AS sender,
                       COALESCE(m.sent_at, m.synced_at) AS at,
                       m.raw_headers, m.text_body, m.subject
                  FROM ${table("app_mail", "messages")} m
                  JOIN ${table("app_mail", "conversations")} c ON c.id = m.conversation_id
                  JOIN ${table("app_mail", "accounts")} a ON a.id = m.account_id
                 WHERE m.org_id = ${orgId}::uuid AND m.direction = 'inbound'
                   AND (c.contact_id = ANY(d.contacts)
                        OR c.id = d.conv
                        OR lower(m.from_address->>'email') = ANY(d.addrs))
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
        kind: classifyInbound(row.raw_headers, row.subject, row.text_body, row.sender),
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
        kind: classifyInbound({}, row.subject, row.text_body, row.sender),
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
  const { orgId, guard, recipients, at } = input

  // 1. Stays on whatever the operator switch says: an opt-out is the law, not our design.
  if (guard.classification === "marketing") {
    let optedOut: string[]
    try {
      optedOut = await suppressedAmong(orgId, [...recipients])
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
    const [verdict] = await inboundVerdicts(orgId, [input], input.db)
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

/** What the inbound rows say about one draft. */
function inboundVerdict(inbound: readonly GuardInbound[], check: InboundCheck): SendGuardVerdict {
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
  const named = {
    who: decision.who,
    at: decision.at.toISOString(),
    ...(record ? { record } : {}),
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
  for (const [i, check] of checks.entries()) {
    const { guard } = check
    queries.set(String(i), {
      contactIds: await guardContactSet(orgId, guard.contactIds),
      addresses: [...new Set([...guard.addresses, ...check.recipients])],
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
    return inboundVerdict([...fromMail, ...fromTickets], check)
  })
}

export interface CardSendGuardCheck {
  guard: PinnedSendGuard
  /** The current payload's To, Cc and Bcc. */
  recipients: readonly string[]
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
  checks: readonly CardSendGuardCheck[],
  now: Date = new Date(),
): Promise<SendGuardVerdict[]> {
  const out: Array<SendGuardVerdict | undefined> = checks.map(() => undefined)

  // 1. Stays on whatever the operator switch says.
  const marketing = checks.flatMap((c, i) => (c.guard.classification === "marketing" ? [i] : []))
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
  if (!env.MAIL_SEND_GUARD_ENFORCE) return out.map((v) => v ?? CLEAR)

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
  return out.map((v) => v ?? unavailable("the mail and tickets could not be read"))
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
  now?: Date
  locale?: string | null
  timeZone?: string | null
}

export type BuildSendGuardResult =
  | { sendGuard: PinnedSendGuard; guardKey?: string; verdict: SendGuardVerdict }
  | { commercialIdentityMissing: true }

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

/**
 * The value pinned on a staged send, and what the check answers about it now.
 * Only a follow-up can be refused here; a plain draft always stages.
 */
export async function buildSendGuard(input: BuildSendGuardInput): Promise<BuildSendGuardResult> {
  const now = input.now ?? new Date()
  const stagedAt = now.toISOString()
  const refs = input.followUp?.refs ?? []
  const mode = input.followUpRun || input.followUp ? "followup" : "plain"
  const addresses = [...input.recipients]
  const contactIds = [...input.contactIds]

  let classification: PinnedSendGuard["classification"] = "none"
  if (mode === "followup") {
    const saidService = input.followUp?.classification === "service"
    const backed = refs.some((ref) => findProvider(input.orgId, ref.kind)?.serviceMessage === true)
    classification = saidService && backed ? "service" : "marketing"
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

  if (mode === "plain") {
    const line = await optedOutLine(input.orgId, addresses)
    return { sendGuard: line ? { ...sendGuard, line } : sendGuard, verdict: CLEAR }
  }
  if (classification === "marketing" && (await commercialIdentityMissing(input.orgId))) {
    return { commercialIdentityMissing: true }
  }
  return {
    sendGuard,
    guardKey: guardKeyOf(refs, addresses),
    verdict: await evaluateSendGuard({
      orgId: input.orgId,
      guard: sendGuard,
      recipients: addresses,
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

/** Everything a commercial mail carries when it leaves. Never reaches the payload an approver saw. */
export async function commercialFooterFor(
  orgId: string,
  recipient: string,
  textBody: unknown,
  htmlBody: unknown,
): Promise<{ textBody?: string; htmlBody?: string; headers: Record<string, string> }> {
  let headers: Record<string, string> = {}
  const out: { textBody?: string; htmlBody?: string } = {}
  if (typeof textBody === "string") {
    const footed = await applyCommercialFooter(orgId, textBody, recipient)
    out.textBody = footed.body
    headers = footed.headers
  }
  if (typeof htmlBody === "string" && htmlBody !== "") {
    const footed = await applyCommercialFooter(orgId, htmlBody, recipient)
    out.htmlBody = footed.body
    headers = { ...headers, ...footed.headers }
  }
  return { ...out, headers }
}

// ── What the caller is told. Facts only, and never what a message said. ──────

function day(iso: string): string {
  return iso.slice(0, 16).replace("T", " ")
}

function whereItCameIn(verdict: SendGuardVerdict): string {
  const record = verdict.record
  if (!record) return "It came in to a mailbox you cannot read."
  return record.kind === "ticket"
    ? `It is on ticket ${record.id}.`
    : `It is in conversation ${record.id}.`
}

function nextAfterReply(verdict: SendGuardVerdict): string {
  const record = verdict.record
  if (!record)
    return "Next: ask whoever holds that mailbox, or tell the person who wanted this mail."
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
      return `${notDone} ${verdict.label ?? "The record this mail is about says not to send it."} Next: check that record before writing again.`
    case "held": {
      const until = verdict.holdUntil ? day(verdict.holdUntil) : ""
      const source = verdict.returnDate
        ? `their message gives ${verdict.returnDate} as the return date`
        : "their message gives no return date, so the default of 7 days applies"
      return `${notDone} ${who} sent an automatic reply${at}; ${source}. It reads as held until ${until} UTC. ${whereItCameIn(verdict)} Next: a person can choose Send now on the card, or it clears by itself after that time.`
    }
    case "unavailable":
      return `${notDone} The check before sending could not run: ${verdict.reason ?? "a read failed"}. Next: try again shortly.`
    case "clear":
      return ""
  }
}

/** The code of a stop: a provider's or a check's own, else one per state. */
export function stopCode(verdict: SendGuardVerdict): string {
  return verdict.code ?? `send_guard_${verdict.state}`
}
