// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ApprovalSummary } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import { buildAttachmentSummaryLines, type FileOrigin } from "~/modules/files/attach"

const mailSchema = schemaRef("app_mail")
const accountsTable = () => drizzleSql.raw(`${quoteIdent(mailSchema)}.accounts`)
const conversationsTable = () => drizzleSql.raw(`${quoteIdent(mailSchema)}.conversations`)
const messagesTable = () => drizzleSql.raw(`${quoteIdent(mailSchema)}.messages`)

/**
 * Resolve a same-app (`mail`) file origin to its home conversation id, so
 * `buildAttachmentSummaryLines` can flag an attachment pulled from a *different*
 * conversation. Only ever called for `mail`-app conversational origins.
 */
function makeMailOriginRootResolver(ctx: { tx: RlsClient; orgId: string }) {
  return async (origin: FileOrigin): Promise<string | null> => {
    const { entityType, entityId } = origin.parent
    if (entityType === "conversation") return entityId
    if (entityType === "message") {
      const [row] = extractRows<{ conversation_id: string }>(
        await ctx.tx.execute(drizzleSql`
          SELECT conversation_id FROM ${messagesTable()}
          WHERE id = ${entityId} AND org_id = ${ctx.orgId} LIMIT 1
        `),
      )
      return row?.conversation_id ?? null
    }
    return null
  }
}

// An accountId/conversationId from a WEAK agent can be missing or a hallucinated NON-UUID placeholder
// (e.g. "default-account-id" — the mail tools explicitly tell the agent to OMIT accountId to send from
// the org's default mailbox). A raw `WHERE id = ${x}` then throws Postgres "invalid input syntax for
// type uuid" — and because a gated tool's summarizer runs at the PROPOSE stage (BEFORE the approval
// request is created), that throw surfaces to the agent as a bare "Tool execution failed" with NO
// gated draft, sending a weak model into a give-up spiral (the same class the BL-30 `_doCompose` fix
// already handles — that handler tolerates a bad accountId by falling back to the org mailbox, but the
// summarizer did NOT, so a hallucinated accountId failed compose at propose). Guard every id-bound
// summary lookup with this so a bad id degrades gracefully, never throws.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value)
}

function clip(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value
}

/**
 * Invariant K, Task 6.5. An approval summary is persisted twice: once in
 * `kernel.approval_requests.summary`, and once inside the durable
 * `kernel.pending_events` row that the approval's creation emits. For a compose
 * or a forward the subject and the note are text the USER typed, so this leak
 * does not self-heal when Phase 12 purges the mail tables.
 *
 * So for an encrypted personal mailbox the title is built from things that are
 * not content: the correspondent's address, the sending mailbox, and a short
 * conversation id. The approver still knows exactly which thread they are
 * approving a send on, and the card renders the real subject and body after
 * decrypting the sealed payload client-side.
 */
function shortConversationId(conversationId: string): string {
  return conversationId.slice(0, 8)
}

/**
 * True when this mail account is a personal mailbox under the encryption regime.
 *
 * `blocked` and `paused` count. They are where a mailbox lands on a seal failure
 * or an elapsed grace window, its historical plaintext columns are still
 * populated until the Phase 12 purge, and a summary is a durable control-plane
 * row: keying on `ready` alone meant one seal failure started writing real
 * subjects into approval titles again. This runs inside the app bundle over the
 * account row it was handed, so it cannot reach the SECURITY DEFINER armed
 * helper the host-side sites use; the state list is the same superset those
 * sites apply on top of it.
 */
function accountIsEncrypted(account: {
  owner_type?: string | null
  encryption_state?: string | null
}): boolean {
  return (
    account.owner_type === "user" &&
    (account.encryption_state === "ready" ||
      account.encryption_state === "managed" ||
      account.encryption_state === "blocked" ||
      account.encryption_state === "paused")
  )
}

function safeParseJson(value: string): { name?: string; email?: string } {
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === "object" && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function formatRecipients(recipients: Array<string | { email: string; name?: string }>): string {
  return recipients
    .map((recipient) => (typeof recipient === "string" ? recipient : recipient.email))
    .join(", ")
}

/**
 * Links to the people a new mail goes to, as the requester sees them: the
 * request is then about their contacts (and through them, their company), so
 * it reaches that company's page while it waits. Only the To recipients, and
 * only contacts the requester can read; an unknown address links nothing.
 */
async function recipientContactLinks(
  tx: RlsClient,
  orgId: string,
  to: Array<string | { email: string; name?: string }>,
): Promise<NonNullable<ApprovalSummary["links"]>> {
  const emails = [
    ...new Set(
      to
        .map((r) => (typeof r === "string" ? r : r?.email))
        .filter((e): e is string => typeof e === "string" && e.includes("@"))
        .map((e) => e.trim().toLowerCase()),
    ),
  ].slice(0, 10)
  if (emails.length === 0) return []
  try {
    const rows = await tx.transaction(async (sp) =>
      extractRows<{ id: string; name: string | null; email: string }>(
        await sp.execute(drizzleSql`
          SELECT id::text AS id, name, email
          FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.contacts
          WHERE org_id = ${orgId}::uuid
            AND lower(email) IN (${drizzleSql.join(
              emails.map((e) => drizzleSql`${e}`),
              drizzleSql`, `,
            )})
          ORDER BY created_at
          LIMIT 10
        `),
      ),
    )
    return rows.map((r) => ({
      label: r.name || r.email,
      app: "kernel",
      entityType: "contact",
      entityId: r.id,
    }))
  } catch {
    // A recipient lookup never blocks the request: it only routes it.
    return []
  }
}

export async function summarizeMailReply(
  params: {
    conversationId: string
    textBody: string
    to?: Array<string | { email: string; name?: string }>
    cc?: Array<string | { email: string; name?: string }>
    attachments?: string[]
  },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  // Guard the id-bound lookup (see isUuid note): a non-uuid conversationId must not throw an opaque
  // uuid-cast error at propose. A bad id degrades to fallbacks here; the handler then returns a clean
  // not-found when it actually runs.
  const [conversation] = isUuid(params.conversationId)
    ? extractRows<{
        subject: string | null
        email_address: string | null
        owner_type: string | null
        encryption_state: string | null
        from_address: { name?: string; email?: string } | string | null
      }>(
        await ctx.tx.execute(drizzleSql`
    SELECT c.subject, a.email_address, a.owner_type, a.encryption_state, m.from_address
    FROM ${conversationsTable()} c
    JOIN ${accountsTable()} a ON a.id = c.account_id
    LEFT JOIN LATERAL (
      SELECT from_address
      FROM ${messagesTable()} m2
      WHERE m2.conversation_id = c.id
        AND m2.direction = 'inbound'
      ORDER BY sent_at DESC
      LIMIT 1
    ) m ON true
    WHERE c.id = ${params.conversationId} AND c.org_id = ${ctx.orgId}
    LIMIT 1
  `),
      )
    : []

  const subject = conversation?.subject ?? "(no subject)"
  const accountEmail = conversation?.email_address ?? "unknown account"
  const fromRaw = conversation?.from_address
  const from: { name?: string; email?: string } =
    typeof fromRaw === "string" ? safeParseJson(fromRaw) : (fromRaw ?? {})
  const fromName = from.name ?? from.email ?? "Unknown sender"
  // An explicit `to` override (gmail-style recipient edit) wins over the
  // default last-inbound-sender target — the card must show what will be sent.
  const toAddress = params.to?.length ? formatRecipients(params.to) : (from.email ?? "unknown")
  const ccLine = params.cc?.length ? `, cc ${formatRecipients(params.cc)}` : ""

  // No body-preview line — the approval card renders the full outgoing message
  // in its own "Message" block (primaryMessageBody in ApprovalCard.tsx), sourced
  // from the exact payload. A clipped duplicate here would show the same text
  // twice: once cropped, once in full.
  const lines = [clip(`To: ${toAddress}${ccLine}`, 200)]
  if (params.attachments?.length) {
    lines.push(
      ...(await buildAttachmentSummaryLines(params.attachments, {
        rlsTx: ctx.tx,
        orgId: ctx.orgId,
        surfaceApp: "mail",
        replyTargetRootId: params.conversationId,
        resolveOriginRoot: makeMailOriginRootResolver(ctx),
      })),
    )
  }

  // Content-free title for an encrypted mailbox, see `accountIsEncrypted`.
  const encrypted = conversation ? accountIsEncrypted(conversation) : false
  const title = encrypted
    ? `Reply on mail thread ${shortConversationId(params.conversationId)} to ${toAddress}`
    : subject

  return {
    kind: "mail.reply",
    title,
    subtitle: `Reply to ${fromName} via ${accountEmail}`,
    lines,
    links: [
      {
        label: "Open conversation",
        app: "mail",
        entityType: "conversation",
        entityId: params.conversationId,
      },
    ],
  }
}

export async function summarizeMailForward(
  params: {
    conversationId: string
    messageId?: string
    to: Array<string | { email: string; name?: string }>
    cc?: Array<string | { email: string; name?: string }>
    bcc?: Array<string | { email: string; name?: string }>
    note?: string
    attachments?: string[]
  },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  // Resolve the source message (subject + which mailbox it forwards via) so the
  // approval card shows the real forwarded subject (Fwd: …), the recipients, and
  // the carried-over attachments by filename + origin. Guard the id-bound lookup
  // (isUuid) so a non-uuid conversationId degrades, never throws an opaque
  // uuid-cast at propose (same discipline as compose/reply summaries).
  type ForwardSource = {
    subject: string | null
    email_address: string | null
    message_id: string | null
    owner_type: string | null
    encryption_state: string | null
  }
  let source: ForwardSource | undefined
  if (isUuid(params.conversationId)) {
    if (isUuid(params.messageId)) {
      ;[source] = extractRows<ForwardSource>(
        await ctx.tx.execute(drizzleSql`
          SELECT m.subject, a.email_address, a.owner_type, a.encryption_state, m.id AS message_id
          FROM ${conversationsTable()} c
          JOIN ${accountsTable()} a ON a.id = c.account_id
          JOIN ${messagesTable()} m ON m.id = ${params.messageId} AND m.conversation_id = c.id
          WHERE c.id = ${params.conversationId} AND c.org_id = ${ctx.orgId}
          LIMIT 1
        `),
      )
    } else {
      ;[source] = extractRows<ForwardSource>(
        await ctx.tx.execute(drizzleSql`
          SELECT c.subject, a.email_address, a.owner_type, a.encryption_state, m.id AS message_id
          FROM ${conversationsTable()} c
          JOIN ${accountsTable()} a ON a.id = c.account_id
          LEFT JOIN LATERAL (
            SELECT id, subject
            FROM ${messagesTable()} m2
            WHERE m2.conversation_id = c.id AND m2.direction = 'inbound'
            ORDER BY sent_at DESC
            LIMIT 1
          ) m ON true
          WHERE c.id = ${params.conversationId} AND c.org_id = ${ctx.orgId}
          LIMIT 1
        `),
      )
    }
  }

  const rawSubject = source?.subject ?? "(no subject)"
  const subject = /^fwd:/i.test(rawSubject) ? rawSubject : `Fwd: ${rawSubject}`
  const accountEmail = source?.email_address ?? "the org mailbox"
  const ccLine = params.cc?.length ? `, cc ${formatRecipients(params.cc)}` : ""
  const bccLine = params.bcc?.length ? `Bcc: ${formatRecipients(params.bcc)}` : ""

  // The forwarded subject AND the user's lead-in note are both content, so an
  // encrypted mailbox gets neither. The card renders them after decrypt.
  const encrypted = source ? accountIsEncrypted(source) : false
  const lines = [
    clip(`To: ${formatRecipients(params.to)}${ccLine}`, 200),
    ...(bccLine ? [clip(bccLine, 200)] : []),
    ...(encrypted
      ? []
      : [
          ...(params.note?.trim() ? [clip(params.note.trim(), 200)] : []),
          clip(`Forwarding: ${rawSubject}`, 200),
        ]),
  ]

  // List the ORIGINAL message's attachments (carried over by the forward) by
  // filename + origin. The forward re-attaches whatever the source message holds,
  // so the reviewer SEES the PDF (etc.) going out before approving — this is the
  // load-bearing surface that proves the attachment is not dropped.
  // Extra files the caller added (a local upload, a Drive import) are listed too:
  // the approver must see everything that goes out.
  const attachmentFileIds = [
    ...new Set([
      ...(await listMessageAttachmentFileIds(source?.message_id ?? null, ctx)),
      ...(params.attachments ?? []),
    ]),
  ]
  if (attachmentFileIds.length) {
    lines.push(
      ...(await buildAttachmentSummaryLines(attachmentFileIds, {
        rlsTx: ctx.tx,
        orgId: ctx.orgId,
        surfaceApp: "mail",
        replyTargetRootId: params.conversationId,
        resolveOriginRoot: makeMailOriginRootResolver(ctx),
      })),
    )
  }

  return {
    kind: "mail.forward",
    title: encrypted
      ? `Forward of mail thread ${shortConversationId(params.conversationId)} to ${formatRecipients(params.to)}`
      : subject,
    subtitle: `Forward to ${formatRecipients(params.to)} via ${accountEmail}`,
    lines,
    links: [
      {
        label: "Open conversation",
        app: "mail",
        entityType: "conversation",
        entityId: params.conversationId,
      },
    ],
  }
}

// Enumerate the kernel.files attachment ids parented to a single mail message,
// so the forward summary can list the carried-over attachments. Returns [] for a
// null/non-existent message — never throws (a forward of an attachment-less
// message just shows no attachment lines).
async function listMessageAttachmentFileIds(
  messageId: string | null,
  ctx: { tx: RlsClient; orgId: string },
): Promise<string[]> {
  if (!messageId) return []
  const rows = extractRows<{ id: string }>(
    await ctx.tx.execute(drizzleSql`
      SELECT id FROM ${drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}`)}.files
      WHERE app = 'mail' AND entity_type = 'message' AND entity_id = ${messageId}
        AND org_id = ${ctx.orgId}
      ORDER BY ordinal
    `),
  )
  return rows.map((r) => r.id)
}

export async function summarizeMailCompose(
  params: {
    // OPTIONAL — the compose tool tells the agent to OMIT this to send from the org's default mailbox;
    // a weak agent may instead pass a non-uuid placeholder. Resolved tolerantly below (mirror _doCompose).
    accountId?: string
    to: Array<string | { email: string; name?: string }>
    cc?: Array<string | { email: string; name?: string }>
    bcc?: Array<string | { email: string; name?: string }>
    subject: string
    textBody: string
    attachments?: string[]
  },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  // Resolve the send-from email for the summary the SAME way `_doCompose` resolves it for the real send:
  // a valid accountId is looked up; a missing/non-uuid accountId falls back to the org's default mailbox.
  // NEVER a raw uuid-cast on an untrusted id (that throws at propose → opaque "Tool execution failed").
  type ComposeAccount = {
    email_address: string
    owner_type: string | null
    encryption_state: string | null
  }
  let account: ComposeAccount | undefined
  if (isUuid(params.accountId)) {
    ;[account] = extractRows<ComposeAccount>(
      await ctx.tx.execute(drizzleSql`
      SELECT email_address, owner_type, encryption_state
      FROM ${accountsTable()}
      WHERE id = ${params.accountId} AND org_id = ${ctx.orgId}
      LIMIT 1
    `),
    )
  }
  if (!account) {
    ;[account] = extractRows<ComposeAccount>(
      await ctx.tx.execute(drizzleSql`
      SELECT email_address, owner_type, encryption_state
      FROM ${accountsTable()}
      WHERE org_id = ${ctx.orgId} AND owner_type = 'org'
      ORDER BY created_at
      LIMIT 1
    `),
    )
  }
  const accountEmail = account?.email_address ?? "the org mailbox"
  const ccLine = params.cc?.length ? `, cc ${formatRecipients(params.cc)}` : ""
  // Surface bcc on its OWN line (a reviewer — and the chaos judge — must SEE who is on BCC before
  // approving; e.g. a "BCC me on every one so I have a record" compose). The recipient never reads bcc,
  // but the approver does, so it belongs in the approval summary alongside To/Cc.
  const bccLine = params.bcc?.length ? `Bcc: ${formatRecipients(params.bcc)}` : ""

  // No body-preview line — the Message block on the card carries the full
  // outgoing text; see the identical note in summarizeMailReply.
  const lines = [
    clip(`To: ${formatRecipients(params.to)}${ccLine}`, 200),
    ...(bccLine ? [clip(bccLine, 200)] : []),
  ]
  if (params.attachments?.length) {
    // Compose has no reply target — only a cross-app origin can be flagged.
    lines.push(
      ...(await buildAttachmentSummaryLines(params.attachments, {
        rlsTx: ctx.tx,
        orgId: ctx.orgId,
        surfaceApp: "mail",
      })),
    )
  }

  // A compose subject is text the user typed. Unlike an ingested subject it is
  // never purged, so leaving it in the summary would leak it permanently.
  const links = await recipientContactLinks(ctx.tx, ctx.orgId, params.to ?? [])
  return {
    kind: "mail.compose",
    title:
      account && accountIsEncrypted(account)
        ? `Compose to ${formatRecipients(params.to)} via ${accountEmail}`
        : params.subject,
    subtitle: `Compose via ${accountEmail}`,
    lines,
    ...(links.length > 0 ? { links } : {}),
  }
}

/** A request to lift an opt-out: who opted out, when and how, for the mail admin who decides. */
export async function summarizeSuppressionRemove(
  params: { email?: unknown },
  ctx: { tx: RlsClient; orgId: string; userId: string },
): Promise<ApprovalSummary> {
  const email = typeof params.email === "string" ? params.email.trim() : ""
  const { suppressionRemoveCard } = await import("~/modules/mail/suppressions")
  const card = await suppressionRemoveCard(ctx.orgId, email)
  return { kind: "mail.suppression_remove", title: card.title, lines: card.lines }
}
