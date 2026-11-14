// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  displayTicketHandle,
  maskHtmlWithNote,
  maskPaymentSecrets,
  maskWithNote,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { ACKNOWLEDGE_AFTER_COMMIT_METADATA } from "~/apps/tickets/ack-after-commit"
import { loadSegmentConfig } from "~/apps/tickets/display-handle"
import { normalizeEmail } from "~/apps/tickets/participants"
import { onPrivilegedDb, type PrivilegedReadOptions } from "~/apps/tickets/privileged-read"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { walkForwardBusinessHours } from "~/apps/tickets/sla"
import { loadTicketsSlaSettings } from "~/apps/tickets/state-machine"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { nextHandle } from "~/lib/handle"
import { base32Token } from "~/lib/random-token"
import { UUID_RE } from "~/lib/uuid"
import { ensureAudienceContact } from "~/modules/contacts/audience-contact"
import { FileServiceError } from "~/modules/files/service"

type SqlClient = RlsClient | RlsTx | PrivilegedDb

/**
 * BL-76: self-assignment sentinels. The most common ticket assignment is "give
 * it to me" (the acting user), yet `tickets:assign` / `convertToTicket.assigneeId`
 * take a UUID — so an agent had to resolve its OWN name via users_search, which
 * is fragile (weak models fumble it, and the search can miss). Accepting a "me"
 * sentinel lets the caller self-assign without any lookup; it resolves to the
 * acting user id server-side.
 */
const SELF_ASSIGN_SENTINELS = new Set(["me", "self", "@me", "myself"])
export function isSelfAssignSentinel(value: unknown): value is string {
  return typeof value === "string" && SELF_ASSIGN_SENTINELS.has(value.trim().toLowerCase())
}

export async function requireUserInOrg(
  orgId: string,
  userId: string,
  privilegedTx?: PrivilegedDb,
): Promise<{ ok: true } | { error: { code: string; message: string; retryable: boolean } }> {
  const rows = await onPrivilegedDb(orgId, "tickets-require-user", privilegedTx, async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(
        drizzleSql`SELECT id FROM ${kernelRel("users")} WHERE id = ${userId}::uuid AND org_id = ${orgId}::uuid AND status = 'active' LIMIT 1`,
      ),
    ),
  )
  if (rows.length === 0) {
    return { error: { code: "not_found", message: "user not found", retryable: false } }
  }
  return { ok: true }
}

// A categoryId MUST be a UUID (resolve a NAME via tickets:categories.list first).
// Without this guard a name like "Support" reached `${categoryId}::uuid` below and
// Postgres threw "invalid input syntax for type uuid", surfacing as an opaque HTTP 500
// instead of an actionable, retryable error the agent can recover from.

export async function requireActiveTicketCategory(
  orgId: string,
  categoryId: string,
  privilegedTx?: PrivilegedDb,
): Promise<{ ok: true } | { error: { code: string; message: string; retryable: boolean } }> {
  if (!UUID_RE.test(categoryId)) {
    return {
      error: {
        code: "invalid_category",
        message: `categoryId must be a category id (UUID), got "${categoryId}". Resolve the category NAME to its id with tickets:categories.list first.`,
        retryable: false,
      },
    }
  }
  const rows = await onPrivilegedDb(orgId, "tickets-require-category", privilegedTx, async (tx) =>
    extractRows<{ archived_at: Date | null }>(
      await tx.execute(
        drizzleSql`SELECT archived_at FROM ${ticketsRel("categories")} WHERE id = ${categoryId}::uuid AND org_id = ${orgId}::uuid LIMIT 1`,
      ),
    ),
  )
  const row = rows[0]
  if (!row) {
    return { error: { code: "not_found", message: "category not found", retryable: false } }
  }
  if (row.archived_at) {
    return {
      error: { code: "archived_category", message: "category is archived", retryable: false },
    }
  }
  return { ok: true }
}

/**
 * Resolve a `"Parent / Child"` category path (case-insensitive, trimmed
 * segments) to a category id by walking the parent_id chain from the root.
 * A parent-only path (single segment) is valid. Used by the tickets-public
 * webhook so external systems can address categories by name instead of a
 * UUID they'd otherwise have to look up first.
 */
export async function resolveCategoryPath(
  orgId: string,
  categoryPath: string,
): Promise<
  | { ok: true; categoryId: string }
  | { error: { code: string; message: string; retryable: boolean } }
> {
  const segments = categoryPath
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (segments.length === 0) {
    return {
      error: { code: "unknown_category", message: "categoryPath is empty", retryable: false },
    }
  }
  let parentId: string | null = null
  let resolvedId: string | null = null
  for (const segment of segments) {
    const rows = await withPrivilegedDb(orgId, "tickets-resolve-category-path", async (tx) =>
      extractRows<{ id: string; archived_at: Date | null }>(
        await tx.execute(drizzleSql`
          SELECT id, archived_at FROM ${ticketsRel("categories")}
          WHERE org_id = ${orgId}::uuid
            AND lower(name) = lower(${segment})
            AND ${parentId === null ? drizzleSql`parent_id IS NULL` : drizzleSql`parent_id = ${parentId}::uuid`}
          LIMIT 1
        `),
      ),
    )
    const row = rows[0]
    if (!row || row.archived_at) {
      return {
        error: {
          code: "unknown_category",
          message: `category path "${categoryPath}" does not resolve (failed at "${segment}")`,
          retryable: false,
        },
      }
    }
    parentId = row.id
    resolvedId = row.id
  }
  return { ok: true, categoryId: resolvedId as string }
}

interface CreateTicketParams {
  subject: string
  channel?: "email" | "web_form" | "api" | "mail_escalation" | "manual" | "social"
  priority?: "low" | "normal" | "high" | "urgent"
  // Initial ticket status (default 'open'). Honoured for bulk import / migration so a
  // resolved/closed source ticket is not silently created as 'open'. Validated against
  // the same enum as the DB CHECK.
  status?: "open" | "awaiting_customer" | "awaiting_followup" | "closed"
  // Only meaningful when status === 'closed'; defaults to 'resolved'.
  closedReason?:
    | "resolved"
    | "converted_to_mail"
    | "merged"
    | "spam"
    | "duplicate"
    | "no_response"
    | null
  // Backdate the ticket + its SLA clock to the source system's real timestamps
  // (createTicket otherwise binds now()). ISO-8601 strings.
  createdAt?: string | null
  firstResponseAt?: string | null
  team?: string | null
  /** b2b | b2c — which side wrote. Omitted falls back to the source inbox's
   *  `defaultAudience`, then null. Orthogonal to `team`. */
  audience?: string | null
  // Free-text language label (e.g. "French"/"German") on its OWN column, coexisting
  // with the topic categoryId — the same semantics as the tickets_setLanguage tool
  // (which is otherwise the only writer; inbound flows tag it after the fact).
  // Passed through verbatim; search lowercases both sides when filtering.
  language?: string | null
  sensitivity?: "internal" | "confidential" | "restricted"
  contactId?: string | null
  contactEmail?: string | null
  contactName?: string | null
  categoryId?: string | null
  assignedTo?: string | null
  sourceInboxId?: string | null
  externalRef?: string | null
  /** The address the ticket is for. Replies go to it. Defaults to the sender of
   *  an inbound `initialMessage`, else `contactEmail`. */
  requesterEmail?: string | null
  /** An earlier ticket this one refers to (a stranger named its handle). */
  relatedTicketId?: string | null
  /** Sender authentication verdict stored on the initial message. */
  senderAuth?: "pass" | "fail" | "none" | null
  /** Send the creation acknowledgement once this ticket has COMMITTED: the
   *  `ticket:create` event carries the request and the outbox runs it after the
   *  caller's transaction, however deeply nested (ack-after-commit.ts). */
  acknowledgeAfterCommit?: boolean
  /** Liaison file ids to attach to the initial message (needs `initialMessage`).
   *  Same checks as a reply's attachments (`resolveAttachableFiles`). */
  attachments?: string[]
  initialMessage?:
    | string
    | {
        kind?: "inbound" | "outbound" | "note"
        fromEmail?: string | null
        fromName?: string | null
        toEmails?: string[]
        ccEmails?: string[]
        subject?: string | null
        htmlBody?: string | null
        textBody?: string | null
        snippet?: string | null
        externalMessageId?: string | null
        inReplyTo?: string | null
        headerReferences?: string[]
        sentAt?: string | null
      }
}

type InitialMessageObject = Exclude<CreateTicketParams["initialMessage"], string | undefined>

/**
 * Weak-model affordance (BL-91): the `initialMessage` tool param is an OBJECT, but a
 * cheap model — reading "put the complaint detail in initialMessage" — often passes the
 * raw complaint text as a BARE STRING, which previously 400'd at ajv validation
 * ("initialMessage must be an object") and left a latent first-call failure that only a
 * lucky retry recovered. The manifest now accepts `["object","string"]`; this normalizes
 * a string into the obvious inbound-message shape so the natural interpretation succeeds.
 */
function normalizeInitialMessage(
  m: CreateTicketParams["initialMessage"],
): InitialMessageObject | undefined {
  if (m == null) return undefined
  if (typeof m === "string") {
    const text = m.trim()
    if (!text) return undefined
    return { kind: "inbound", textBody: text }
  }
  return m
}

interface ActorRef {
  actorType: "user" | "agent" | "system" | "mcp"
  /**
   * The AUDIT category for what this call emits, when it differs from the RLS
   * actor above (X10's split, extended by FX2 to every audit-bearing seam). A
   * sandboxed app tool call made inside an agent turn is an AGENT action and
   * audits as one, while `actorType` keeps deciding the RLS actor, the
   * self-assignment sentinel, `created_by` and the note author. Absent means
   * "the same as actorType", which is every non-agent caller.
   */
  auditActorType?: "user" | "agent" | "system" | "mcp"
  userId: string
  /** The caller's effective scopes. Needed only to attach files (`attachments`):
   *  the copy checks the message fileParent's write scope against them, unless
   *  `operatingScopes` is set. */
  scopes?: string[]
  /**
   * The scopes this tickets call OPERATES under: the bridge actor's, which on a
   * declared cross-app dispatch is `tickets:*` plus the caller's, and on a
   * direct call the caller's own. They decide one thing only: the write-scope
   * check on the ticket message that attached files are copied onto, as
   * `files_attachToParent` does for a sandboxed app's own parents. Every other
   * check (settings admin, attribution) keeps `scopes`.
   */
  operatingScopes?: string[]
}

export type CreateTicketOptions = PrivilegedReadOptions & {
  /**
   * The ticket records something from the past (an import, a mailbox backfill),
   * or our own mail: it is not news, so a "Notify on new ticket" inbox says
   * nothing. An option rather than a param, so no tool input can set it.
   */
  notNews?: boolean
  /**
   * The ticket's number, for a seed that tells a story with fixed ticket ids. The org must not
   * hold it yet. An option rather than a param, so no tool input can set it.
   */
  handleNumber?: number
}

/**
 * The next ticket handle of one org: the instance sequence's next value, or the number after the
 * org's highest when the org already holds a higher one (a seeded story's fixed ids), so a new
 * ticket never meets a number the org holds and numbers keep rising within the org.
 */
async function nextTicketHandle(
  tx: SqlClient,
  orgId: string,
  privilegedTx: PrivilegedDb | undefined,
): Promise<string> {
  const drawn = await nextHandle(tx, `${schemaRef("app_tickets")}.tickets_handle_seq`, "ticket")
  const drawnNumber = Number(drawn.slice("ticket-".length))
  // Every ticket of the org, whatever the caller may read: a hidden one holds its number too.
  const row = await onPrivilegedDb(
    orgId,
    "tickets-handle-top",
    privilegedTx,
    async (ptx) =>
      extractRows<{ top: string | number | null }>(
        await ptx.execute(drizzleSql`
        SELECT max((substring(handle from '^ticket-([0-9]+)$'))::bigint) AS top
        FROM ${ticketsRel("tickets")}
        WHERE org_id = ${orgId}::uuid
      `),
      )[0],
  )
  const top = row?.top === null || row?.top === undefined ? 0 : Number(row.top)
  return top >= drawnNumber ? `ticket-${top + 1}` : drawn
}

/** What a new-ticket notice calls the person who asked: name and address, whichever exist. */
function requesterLabel(name: string | null | undefined, email: string | null): string {
  const cleanName = name?.trim()
  if (cleanName && email) return `${cleanName} <${email}>`
  return cleanName || email || "unknown sender"
}

export async function createTicket(
  tx: SqlClient,
  orgId: string,
  params: CreateTicketParams,
  actor: ActorRef,
  // A caller inside a privileged transaction passes it here: every privileged
  // read then runs on it, never on a second connection (privileged-read.ts).
  opts: CreateTicketOptions = {},
): Promise<
  | {
      ticketId: string
      ticketHandle: string
      replyToken: string
      priority: string
      assignedTo: string | null
      categoryId: string | null
      // Id of the `initialMessage` row created alongside the ticket, when one
      // was provided. Null when `initialMessage` was omitted. Lets callers
      // (e.g. the tickets-public webhook) parent attachments onto it.
      initialMessageId: string | null
    }
  | { error: { code: string; message: string; retryable: boolean } }
> {
  if (!params.subject || typeof params.subject !== "string") {
    return { error: { code: "invalid_params", message: "subject required", retryable: false } }
  }
  // Attachments are resolved and checked BEFORE anything is written, so a
  // refused file (not visible to the caller, another org's, a blocked type,
  // over the caps) creates no ticket at all.
  const attachmentIds = Array.isArray(params.attachments) ? params.attachments : []
  if (attachmentIds.length > 0) {
    if (!normalizeInitialMessage(params.initialMessage)) {
      return {
        error: {
          code: "invalid_params",
          message:
            "attachments go on the ticket's first message: pass initialMessage with them (a note, or the customer's message)",
          retryable: false,
        },
      }
    }
    const { resolveAttachableFiles } = await import("~/apps/tickets/tools")
    try {
      await resolveAttachableFiles({ tx, orgId }, attachmentIds)
    } catch (err) {
      if (err instanceof FileServiceError) {
        return { error: { code: err.code.toLowerCase(), message: err.message, retryable: false } }
      }
      throw err
    }
  }
  // BL-91: a weak model frequently passes EMPTY STRINGS for optional fields it has no
  // value for (`team: ""`, `priority: ""`, `categoryId: ""`, `externalRef: ""`) instead of
  // omitting them. An empty `team` is the dangerous one: under a SCOPED team dimension the
  // INSERT row fails the team WITH CHECK (`""` isn't in the grant list) → opaque HTTP 500.
  // An empty `channel`/`priority` would also break the CHECK enum / SLA lookup. Normalize
  // every optional string param: blank/whitespace → undefined, so the `?? default`/`?? null`
  // logic below applies the real default (no team = NULL, always allowed) rather than binding
  // an empty string. (`subject` is required and validated above, so it is left untouched.)
  const blankToUndef = <T extends string | null | undefined>(v: T): T | undefined =>
    typeof v === "string" && v.trim() === "" ? undefined : v
  params.channel = blankToUndef(params.channel)
  params.priority = blankToUndef(params.priority)
  params.team = blankToUndef(params.team)
  params.language = blankToUndef(params.language)
  params.sensitivity = blankToUndef(params.sensitivity)
  params.categoryId = blankToUndef(params.categoryId)
  params.contactId = blankToUndef(params.contactId)
  params.contactEmail = blankToUndef(params.contactEmail)
  params.contactName = blankToUndef(params.contactName)
  params.assignedTo = blankToUndef(params.assignedTo)
  params.sourceInboxId = blankToUndef(params.sourceInboxId)
  params.externalRef = blankToUndef(params.externalRef)
  params.status = blankToUndef(params.status)
  params.closedReason = blankToUndef(params.closedReason)
  params.createdAt = blankToUndef(params.createdAt)
  params.firstResponseAt = blankToUndef(params.firstResponseAt)
  // Resolve + validate the ticket status (default 'open'). Previously hardcoded to
  // 'open' in the INSERT, which silently dropped status on bulk import. closed_reason
  // is only stored for a 'closed' ticket; it defaults to 'resolved' (the common case).
  const ALLOWED_STATUSES = new Set(["open", "awaiting_customer", "awaiting_followup", "closed"])
  if (params.status && !ALLOWED_STATUSES.has(params.status)) {
    return {
      error: {
        code: "invalid_params",
        message:
          `status '${params.status}' is not a valid ticket status. ` +
          `Allowed: open, awaiting_customer, awaiting_followup, closed.`,
        retryable: false,
      },
    }
  }
  const status = params.status ?? "open"
  const ALLOWED_CLOSED_REASONS = new Set([
    "resolved",
    "converted_to_mail",
    "merged",
    "spam",
    "duplicate",
    "no_response",
  ])
  let closedReason: string | null = null
  if (status === "closed") {
    closedReason = params.closedReason ?? "resolved"
    if (!ALLOWED_CLOSED_REASONS.has(closedReason)) {
      return {
        error: {
          code: "invalid_params",
          message:
            `closedReason '${closedReason}' is invalid. ` +
            `Allowed: ${Array.from(ALLOWED_CLOSED_REASONS).join(", ")}.`,
          retryable: false,
        },
      }
    }
  }
  // BL-91/BL-246 class: `channel` is enforced by a DB CHECK (email/web_form/api/mail_escalation/
  // manual/social). The agent tool param is a free string, so a weak model passing a channel the
  // CHECK rejects — e.g. a ticket opened from an Instagram/Facebook/YouTube DM or comment, where the
  // model naturally reaches for "instagram-dm" / "instagram" / "facebook" / "dm" — would otherwise
  // bind a non-enum value and surface as an OPAQUE HTTP 500 from the INSERT (the same class already
  // guarded for team/categoryId/contactId). Two-part fix: (1) canonicalize the common social-platform
  // aliases to the real `social` channel so the natural value is ACCEPTED (a social-derived ticket is
  // honestly labeled `social`, not mislabeled `email`), and (2) for any genuinely-unknown value,
  // return a clean, retryable invalid_params error naming the allowed set — never a 500.
  const ALLOWED_CHANNELS = new Set([
    "email",
    "web_form",
    "api",
    "mail_escalation",
    "manual",
    "social",
  ])
  // Aliases a model commonly invents for a social-platform source → canonical `social`. Matched on a
  // normalized form (lowercased, non-alphanumerics stripped) so "instagram-dm"/"instagram_dm"/
  // "Instagram DM" all collapse to the same key.
  const SOCIAL_CHANNEL_ALIASES = new Set([
    "instagram",
    "instagramdm",
    "instagramdirectmessage",
    "ig",
    "igdm",
    "facebook",
    "facebookdm",
    "fb",
    "fbdm",
    "messenger",
    "youtube",
    "youtubecomment",
    "dm",
    "directmessage",
    "socialdm",
    "socialmedia",
    "comment",
  ])
  if (typeof params.channel === "string") {
    const normalized = params.channel.toLowerCase().replace(/[^a-z0-9]/g, "")
    if (SOCIAL_CHANNEL_ALIASES.has(normalized)) {
      params.channel = "social"
    } else if (!ALLOWED_CHANNELS.has(params.channel)) {
      return {
        error: {
          code: "invalid_params",
          message:
            `channel '${params.channel}' is not a valid ticket channel. Allowed: ` +
            `email, web_form, api, mail_escalation, manual, social. For a ticket opened from a ` +
            `social-platform DM or comment (Instagram/Facebook/YouTube), use 'social'.`,
          retryable: false,
        },
      }
    }
  }
  const channel = params.channel ?? "manual"
  const priority = params.priority ?? "normal"
  let team = params.team ?? null
  let unlinkedContactEmail: string | null = null
  let audience = (params.audience as string | null | undefined) ?? null
  let sensitivity = params.sensitivity ?? "internal"

  const privilegedTx = opts.privilegedTx
  const sla = await loadTicketsSlaSettings(orgId, privilegedTx)
  const slaTargetSeconds = sla.targets[priority] ?? sla.targets.normal
  if (typeof slaTargetSeconds !== "number") {
    return {
      error: {
        code: "sla_settings_missing",
        message: "sla targets not configured",
        retryable: false,
      },
    }
  }
  const now = new Date()
  // Imported/historical tickets may carry their real creation + first-response times
  // (createTicket otherwise binds now()). Anchor the ticket's created_at + SLA clock to
  // the real creation time so a backdated ticket's deadline/elapsed reflect reality.
  const createdTs = params.createdAt ? new Date(params.createdAt) : now
  if (Number.isNaN(createdTs.getTime())) {
    return {
      error: {
        code: "invalid_params",
        message: `createdAt is not a valid timestamp: "${params.createdAt}"`,
        retryable: false,
      },
    }
  }
  const firstResponseTs = params.firstResponseAt ? new Date(params.firstResponseAt) : null
  if (firstResponseTs && Number.isNaN(firstResponseTs.getTime())) {
    return {
      error: {
        code: "invalid_params",
        message: `firstResponseAt is not a valid timestamp: "${params.firstResponseAt}"`,
        retryable: false,
      },
    }
  }
  const slaDeadline = walkForwardBusinessHours(createdTs, slaTargetSeconds, sla.businessHours)

  if (params.categoryId) {
    const category = await requireActiveTicketCategory(orgId, params.categoryId, privilegedTx)
    if ("error" in category) return category
  }
  if (params.contactId) {
    // A contactId MUST be a UUID. Without this guard a non-UUID value — a contact HANDLE
    // (`@contact-…`), a NAME, or any non-uuid the agent passed instead of the search result's
    // `id` — reached `WHERE id = '<non-uuid>'::uuid` and Postgres threw "invalid input syntax
    // for type uuid", surfacing as an opaque HTTP 500 (the BL-246 class that already guards
    // categoryId + sourceInboxId; contactId was the remaining unguarded `::uuid` cast — the
    // comment below claimed it was covered, but it never was). A non-UUID contactId with a
    // contactEmail fallback resolves via email (mirrors the stale-id BL-73 path); otherwise it
    // is a clean, actionable, retryable error the agent can recover from — never a 500.
    if (!UUID_RE.test(params.contactId)) {
      if (params.contactEmail) {
        params.contactId = null
      } else {
        return {
          error: {
            code: "invalid_contact",
            message: `contactId must be a contact id (UUID), got "${params.contactId}". Resolve the contact id first (e.g. via contacts_search), or pass contactEmail to find-or-create the contact.`,
            retryable: false,
          },
        }
      }
    }
  }
  if (params.contactId) {
    const rows = extractRows<{ id: string }>(
      await tx.execute(
        // A ticket is team work: it links only an org-visible contact, never
        // someone's own or a mailbox-restricted one (their name would surface
        // to everyone who can read the ticket).
        drizzleSql`SELECT id FROM ${kernelRel("contacts")} WHERE id = ${params.contactId}::uuid AND org_id = ${orgId}::uuid AND org_access <> 'none' LIMIT 1`,
      ),
    )
    if (rows.length === 0) {
      // BL-73: a provided contactId that no longer resolves (e.g. a stale
      // conversation.contact_id whose contact was deleted — conversations.contact_id
      // carries no FK) falls back to resolving from contactEmail when one is
      // supplied, rather than hard-failing the create/convert. With no email to
      // fall back to, surface not_found (preserves the manual-create contract).
      if (!params.contactEmail) {
        return { error: { code: "not_found", message: "contact not found", retryable: false } }
      }
      params.contactId = null
    }
  }
  if (!params.contactId && params.contactEmail) {
    const email = params.contactEmail.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return {
        error: { code: "invalid_params", message: "valid contactEmail required", retryable: false },
      }
    }
    // A ticket links the organisation's contact for the address when one
    // exists; it never creates one (adding someone to the organisation's
    // contacts is an explicit share, modules/sharing). The address stays on
    // the ticket's inbound message, which replies and CSAT use; with no such
    // message, a contact shared with the ticket's audience keeps it (below).
    const contactId = await onPrivilegedDb(
      orgId,
      "tickets-resolve-manual-contact",
      privilegedTx,
      async (pTx) =>
        extractRows<{ id: string }>(
          await pTx.execute(
            drizzleSql`SELECT id FROM ${kernelRel("contacts")}
                      WHERE org_id = ${orgId}::uuid AND lower(email) = ${email} AND org_access <> 'none'
                      ORDER BY created_at LIMIT 1`,
          ),
        )[0]?.id ?? null,
    )
    params.contactId = contactId
    if (!contactId) unlinkedContactEmail = email
  }
  if (isSelfAssignSentinel(params.assignedTo)) {
    if (actor.actorType !== "user") {
      return {
        error: {
          code: "invalid_params",
          message: "self-assignment ('me') requires a user actor",
          retryable: false,
        },
      }
    }
    params.assignedTo = actor.userId
  }
  if (params.assignedTo) {
    // assignedTo MUST be a UUID by now (the 'me' sentinel is resolved to actor.userId above).
    // Without this guard a non-UUID assignee — a teammate NAME the agent passed instead of a user
    // id, or any free-text — reached `WHERE id = '<non-uuid>'::uuid` in requireUserInOrg and
    // Postgres threw "invalid input syntax for type uuid" → an opaque HTTP 500 (the same unguarded
    // `::uuid`-cast class as categoryId/contactId/sourceInboxId). Return a clean, actionable error
    // so the agent resolves the user id (e.g. via users_search) or omits the assignee.
    if (!UUID_RE.test(params.assignedTo)) {
      return {
        error: {
          code: "invalid_assignee",
          message: `assignedTo must be a user id (UUID) or 'me', got "${params.assignedTo}". Resolve the teammate's user id first (e.g. via users_search), or omit it to leave the ticket unassigned.`,
          retryable: false,
        },
      }
    }
    const user = await requireUserInOrg(orgId, params.assignedTo, privilegedTx)
    if ("error" in user) return user
  }
  let sourceAccountId: string | null = null
  // Per-inbox SLA exemption (inboxes.sla_exempt, an admin-configurable toggle set
  // per virtual mailbox, e.g. on the Bug Reports inbox). An sla_exempt inbox's
  // tickets carry NO SLA: a NULL sla_deadline + NULL sla_active_started_at means
  // no countdown, no breach, and no SLA surface anywhere (every SLA predicate is
  // a comparison a NULL deadline never satisfies). Resolved from whichever inbox
  // the ticket lands in (explicit or the default-for-create fallback below).
  let slaExempt = false
  // The inbox's "Notify on new ticket": its name when it applies, read from the
  // same row. A monitoring inbox (suppress_attention) stays silent whatever the flag.
  let notifyInboxName: string | null = null
  const notifyName = (row: {
    name: string
    notify_new_ticket: boolean | null
    suppress_attention: boolean | null
  }): string | null =>
    row.notify_new_ticket === true && row.suppress_attention !== true ? row.name : null
  if (params.sourceInboxId) {
    // A sourceInboxId MUST be a UUID. Without this guard a non-UUID value (e.g. the inbox SLUG
    // "support", or any free-text the agent guessed) reached `WHERE id = 'support'` against the
    // uuid `id` column and Postgres threw "invalid input syntax for type uuid" — an opaque HTTP 500
    // (the l187 reference-validation class that already guards categoryId/contactId/assignedTo, but
    // sourceInboxId was missed). Return an actionable, recoverable error instead so the agent can
    // resolve the real inbox id rather than dead-ending on a 500 (mail:convertToTicket regression).
    if (!UUID_RE.test(params.sourceInboxId)) {
      return {
        error: {
          code: "invalid_inbox",
          message: `sourceInboxId must be an inbox id (UUID), got "${params.sourceInboxId}". It is neither an inbox slug nor an account id — resolve the inbox id first (e.g. via the tickets/mail inbox listing).`,
          retryable: false,
        },
      }
    }
    const ib = await tx.execute(
      drizzleSql`SELECT archived_at, connected_account_id, default_team, default_audience, default_sensitivity, sla_exempt, name, notify_new_ticket, suppress_attention FROM ${ticketsRel("inboxes")} WHERE id = ${params.sourceInboxId}::uuid AND org_id = ${orgId} LIMIT 1`,
    )
    const row = extractRows<{
      archived_at: Date | null
      connected_account_id: string
      default_team: string | null
      default_audience: string | null
      default_sensitivity: "internal" | "confidential" | "restricted" | null
      sla_exempt: boolean | null
      name: string
      notify_new_ticket: boolean | null
      suppress_attention: boolean | null
    }>(ib)[0]
    if (!row) {
      return { error: { code: "not_found", message: "inbox not found", retryable: false } }
    }
    if (row.archived_at) {
      return { error: { code: "archived_inbox", message: "inbox is archived", retryable: false } }
    }
    sourceAccountId = row.connected_account_id
    team = params.team ?? row.default_team ?? null
    // Same inheritance as the team: the receiving bucket knows which side it
    // serves (the back-office form is b2b, the member form b2c), so a ticket
    // filed through it starts classified instead of landing on the pile.
    audience = (params.audience as string | null | undefined) ?? row.default_audience ?? null
    sensitivity = params.sensitivity ?? row.default_sensitivity ?? "internal"
    slaExempt = row.sla_exempt === true
    notifyInboxName = notifyName(row)
  } else {
    // No explicit sourceInboxId → bind the ticket to the org's DEFAULT outbound inbox so a created
    // ticket is REPLYABLE. Without this a manually/agent-created ticket landed with source_inbox_id
    // NULL, and any subsequent tickets:reply preflighted `no_inbox` ("ticket has no source inbox") —
    // the agent's create-then-reply flow (proactively open a case for a customer, then draft the gated
    // heads-up) dead-ended on a 422. Resolve the default-for-create inbox (the same routing inbound
    // mail uses), JOINed to an ACTIVE connected account so the reply's loadInboxAndProvider succeeds.
    // Optional, non-fatal: an org with NO usable inbox still creates the ticket (source_inbox_id NULL,
    // the prior behaviour) — the reply tool then returns its existing actionable no_inbox error rather
    // than this path masking it.
    // Read the default inbox under a PRIVILEGED tx: the inbox→connected_account JOIN spans
    // app_tickets + kernel, and the agent actor's RLS context does not necessarily grant read on
    // connected_accounts, so an RLS-scoped read would return nothing and silently leave the ticket
    // inbox-less (the bug). The same privileged-read pattern already resolves contactEmail above.
    const dib = await onPrivilegedDb(
      orgId,
      "tickets-resolve-default-inbox",
      privilegedTx,
      async (pTx) =>
        extractRows<{
          id: string
          connected_account_id: string
          default_team: string | null
          default_audience: string | null
          default_sensitivity: "internal" | "confidential" | "restricted" | null
          sla_exempt: boolean | null
          name: string
          notify_new_ticket: boolean | null
          suppress_attention: boolean | null
        }>(
          await pTx.execute(
            drizzleSql`SELECT i.id, i.connected_account_id, i.default_team, i.default_audience, i.default_sensitivity, i.sla_exempt,
                            i.name, i.notify_new_ticket, i.suppress_attention
                       FROM ${ticketsRel("inboxes")} i
                       JOIN ${kernelRel("connected_accounts")} ca ON ca.id = i.connected_account_id
                      WHERE i.org_id = ${orgId}::uuid AND i.archived_at IS NULL
                        AND ca.org_id = ${orgId}::uuid AND ca.status = 'active'
                      ORDER BY i.is_default_for_create DESC, i.created_at ASC
                      LIMIT 1`,
          ),
        )[0],
    )
    if (dib) {
      params.sourceInboxId = dib.id
      sourceAccountId = dib.connected_account_id
      team = params.team ?? dib.default_team ?? null
      audience = (params.audience as string | null | undefined) ?? dib.default_audience ?? null
      sensitivity = params.sensitivity ?? dib.default_sensitivity ?? "internal"
      slaExempt = dib.sla_exempt === true
      notifyInboxName = notifyName(dib)
    }
  }

  // SLA exemption (suppress_attention inboxes): no live deadline, no running
  // clock. sla_target_seconds stays populated (kept for reference), but the
  // deadline/active-start are NULL so nothing ever breaches or surfaces an SLA.
  const slaDeadlineValue = slaExempt ? null : slaDeadline.toISOString()
  const slaActiveStartedValue = slaExempt ? null : createdTs.toISOString()

  const handle =
    opts.handleNumber !== undefined
      ? `ticket-${opts.handleNumber}`
      : await nextTicketHandle(tx, orgId, opts.privilegedTx)

  const initialForRequester = normalizeInitialMessage(params.initialMessage)
  const requesterEmail =
    normalizeEmail(params.requesterEmail) ??
    (initialForRequester?.kind === "inbound"
      ? normalizeEmail(initialForRequester.fromEmail)
      : null) ??
    normalizeEmail(params.contactEmail) ??
    null

  // A backdated ticket is history too, whoever creates it.
  const newTicketNotice =
    notifyInboxName !== null && opts.notNews !== true && !params.createdAt
      ? {
          notifyNewTicket: true,
          inboxName: notifyInboxName,
          requester: requesterLabel(
            (initialForRequester?.kind === "inbound" ? initialForRequester.fromName : null) ??
              params.contactName,
            requesterEmail,
          ),
        }
      : null

  const userId = actor.actorType === "user" ? actor.userId : null

  // A customer named by address, unknown to the organisation, on a ticket with
  // no inbound message to carry the address: keep it as the ticket team's
  // contact, shared with the people who see the ticket (with no team, the
  // creator's private contact). Never org-wide, never dropped.
  // (A conversion from mail copies the inbound messages right after: not here.)
  if (
    unlinkedContactEmail &&
    channel === "manual" &&
    normalizeInitialMessage(params.initialMessage)?.kind !== "inbound"
  ) {
    params.contactId = await ensureAudienceContact(tx as never, {
      orgId,
      email: unlinkedContactEmail,
      name: params.contactName ?? null,
      ownerUserId: userId && UUID_RE.test(userId) ? userId : null,
      audience: team ? { key: "tickets:team", value: team } : null,
      actorId: userId,
    })
  }
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const replyToken = base32Token(10)
    try {
      // Each attempt runs in its own SAVEPOINT: a unique violation (reply_token retry,
      // external_message_id duplicate) or any other failure below rolls back only this
      // attempt, so the retry and the caller's next statement run on a live transaction.
      // Without it the first 23505 left the tx aborted (25P02) and every retry failed too.
      return await tx.transaction(async (sp) => {
        const result = await sp.execute(drizzleSql`
          INSERT INTO ${ticketsRel("tickets")} (
            id, org_id, handle, subject, status, priority, channel, team, audience, language, sensitivity,
            category_id, contact_id, assigned_to, reply_token, source_inbox_id, source_account_id, external_ref,
            closed_reason, first_response_at, requester_email, related_ticket_id,
            sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
            message_count, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${orgId}::uuid, ${handle}, ${maskPaymentSecrets(params.subject).text}, ${status}, ${priority}, ${channel},
            ${team}, ${audience}, ${params.language ?? null}, ${sensitivity},
            ${params.categoryId ?? null}::uuid, ${params.contactId ?? null}::uuid, ${params.assignedTo ?? null}::uuid,
            ${replyToken}, ${params.sourceInboxId ?? null}::uuid, ${sourceAccountId}::uuid, ${params.externalRef ?? null},
            ${closedReason}, ${firstResponseTs ? firstResponseTs.toISOString() : null}::timestamptz,
            ${requesterEmail}, ${params.relatedTicketId ?? null}::uuid,
            ${slaTargetSeconds}, ${slaDeadlineValue}::timestamptz, ${slaActiveStartedValue}::timestamptz, 0,
            0, ${createdTs.toISOString()}::timestamptz, now()
          )
          RETURNING id
        `)
        const ticketId = extractRows<{ id: string }>(result)[0]!.id

        let messageCount = 0
        let initialMessageId: string | null = null
        const initialMessage = normalizeInitialMessage(params.initialMessage)
        if (initialMessage) {
          const m = initialMessage
          const sentAt = m.sentAt ?? createdTs.toISOString()
          // An INBOUND initial message is "the customer wrote this" — stamp the
          // linked contact's email/name as the sender when the caller didn't
          // supply one. Without a from_email on any inbound message the ticket
          // is unreplyable: tickets:reply resolves the outbound To: from the
          // most recent inbound from_email and fails with no_recipient (bit the
          // agent live: create with contactEmail, then reply → no_recipient).
          if (m.kind === "inbound" && !m.fromEmail && params.contactEmail) {
            m.fromEmail = params.contactEmail.trim().toLowerCase()
            m.fromName = m.fromName ?? params.contactName ?? null
          }
          // Card numbers and payment keys are masked in the values below, before
          // the row is written (and so before any reader or index meets them).
          const messageInsert = await sp.execute(drizzleSql`
            INSERT INTO ${ticketsRel("messages")} (
              id, org_id, ticket_id, kind,
              from_email, from_name, to_emails, cc_emails,
              subject, html_body, text_body, snippet,
              external_message_id, in_reply_to, header_references,
              sent_at, created_by, created_at, updated_at, sender_auth
            ) VALUES (
              gen_random_uuid(), ${orgId}, ${ticketId}, ${m.kind ?? "note"},
              ${m.fromEmail ?? null}, ${m.fromName ?? null},
              ${JSON.stringify(m.toEmails ?? [])}::jsonb, ${JSON.stringify(m.ccEmails ?? [])}::jsonb,
              ${m.subject ? maskPaymentSecrets(m.subject).text : null},
              ${m.htmlBody ? maskHtmlWithNote(m.htmlBody).text : null},
              ${m.textBody ? maskWithNote(m.textBody).text : null},
              ${m.snippet ? maskPaymentSecrets(m.snippet).text : null},
              ${m.externalMessageId ?? null}, ${m.inReplyTo ?? null},
              ${JSON.stringify(m.headerReferences ?? [])}::jsonb,
              ${sentAt}, ${userId}, now(), now(), ${params.senderAuth ?? null}
            )
            RETURNING id
          `)
          initialMessageId = extractRows<{ id: string }>(messageInsert)[0]!.id
          messageCount = 1
          // Inside this attempt's savepoint: a copy that fails (quota, write
          // scope) rolls the ticket back with it.
          if (attachmentIds.length > 0) {
            const { attachFilesToTicketMessage } = await import("~/apps/tickets/tools")
            await attachFilesToTicketMessage(
              sp as RlsClient,
              actor,
              orgId,
              attachmentIds,
              initialMessageId,
            )
          }
          const inboundUpdate =
            m.kind === "inbound"
              ? drizzleSql`, last_inbound_at = ${sentAt}`
              : m.kind === "outbound"
                ? drizzleSql`, last_outbound_at = ${sentAt}`
                : drizzleSql``
          await sp.execute(drizzleSql`
            UPDATE ${ticketsRel("tickets")}
            SET message_count = ${messageCount}, last_message_at = ${sentAt}${inboundUpdate}
            WHERE id = ${ticketId}
          `)
          // The first message is a message like any other: whatever reacts to
          // `tickets:message:create` (an event routine drafting a reply to every
          // inbound customer message, its reconciler) must see it too. Without
          // this only the appends on an existing ticket fired it, so a brand-new
          // ticket never reached a routine watching messages. An internal note is
          // not a message on the customer thread and never fires it (addNote).
          if (m.kind === "inbound" || m.kind === "outbound") {
            await (sp as RlsClient).queueEvent({
              app: "tickets",
              entity: "message",
              action: "create",
              entityId: initialMessageId,
              data: {
                ticketId,
                kind: m.kind,
                // The parent ticket's dimension values, so the WS frame filter
                // applies the ticket's team/sensitivity isolation to this frame.
                "tickets:team": team,
                "tickets:sensitivity": sensitivity,
              },
              actorId: actor.userId,
              actorType: actor.auditActorType ?? actor.actorType,
              orgId,
            })
          }
        }

        // Unified-search §3.3: no separate `tickets:message create` event is
        // needed for the initial message inserted above (belt-and-braces case
        // in the spec) — verified here, not assumed: the initial message
        // INSERT (if any) runs BEFORE this `tickets:ticket create` event, in
        // the SAME transaction, and the indexer's ticket-create branch already
        // re-upserts (re-enriches) the ticket document, which reads the fully
        // committed message set. A ticket created with no initialMessage has
        // no message text to enrich anyway. So this one event is sufficient
        // coverage for both cases.
        // People, agents and the live event read the DISPLAY handle
        // (`ticket-B2B-12`); the stored one stays `ticket-<n>`.
        const displayHandle = displayTicketHandle(
          handle,
          {
            audience,
            team,
            categoryId: params.categoryId ?? null,
            sourceInboxId: params.sourceInboxId ?? null,
          },
          await loadSegmentConfig(orgId, privilegedTx),
        )
        await (sp as RlsClient).queueEvent({
          app: "tickets",
          entity: "ticket",
          action: "create",
          entityId: ticketId,
          data: {
            ticketId,
            handle: displayHandle,
            subject: maskPaymentSecrets(params.subject).text,
            priority,
            channel,
            // The ticket's dimension values, so the WS frame filter keeps its
            // subject (and a notice's requester) within its team and sensitivity.
            "tickets:team": team,
            "tickets:sensitivity": sensitivity,
            ...newTicketNotice,
          },
          actorId: actor.userId,
          actorType: actor.auditActorType ?? actor.actorType,
          orgId,
          ...(params.acknowledgeAfterCommit ? { metadata: ACKNOWLEDGE_AFTER_COMMIT_METADATA } : {}),
        })
        // BL-78: report the applied fields so a caller (e.g. mail:convertToTicket,
        // which sets priority/assignee/category ATOMICALLY) is self-verifying — the
        // resolved assignedTo reflects a "me"-sentinel resolution.
        return {
          ticketId,
          ticketHandle: displayHandle,
          replyToken,
          priority,
          assignedTo: params.assignedTo ?? null,
          categoryId: params.categoryId ?? null,
          initialMessageId,
        }
      })
    } catch (e: unknown) {
      lastErr = e
      if (e instanceof FileServiceError) {
        return { error: { code: e.code.toLowerCase(), message: e.message, retryable: false } }
      }
      const code = (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code
      if (code === "23505") {
        // Distinguish WHICH unique index collided. Concurrent inbound
        // deliveries of the same provider message id hash to different
        // advisory locks, so the pre-insert duplicate check can miss and two
        // racers both reach this INSERT — one wins, the other violates the
        // `external_message_id` unique index. Regenerating `reply_token` and
        // retrying does nothing for that case: it would just collide again and
        // exhaust the retry budget into a hard throw / retry storm. Treat an
        // `external_message_id` collision as a clean duplicate-drop; only retry
        // on a genuine `reply_token` collision (which a fresh token resolves).
        const constraint = String(
          (e as { constraint_name?: string }).constraint_name ??
            (e as { constraint?: string }).constraint ??
            (e as { cause?: { constraint_name?: string } }).cause?.constraint_name ??
            "",
        )
        const detail = `${constraint} ${String((e as { message?: string }).message ?? "")}`
        if (detail.includes("external_message_id")) {
          return {
            error: {
              code: "duplicate_external_message_id",
              message: "message already ingested",
              retryable: false,
            },
          }
        }
        // reply_token (or any other) unique collision — retry with a new token.
        continue
      }
      // A malformed-UUID bind (pg 22P02 "invalid input syntax for type uuid") on an optional
      // reference column reaching `::uuid` must surface as a CLEAN, actionable, non-retryable error
      // that NAMES the offending value — never an opaque HTTP 500 that the agent then fabricates
      // success around or retries into the step budget (the boxtal-tracking-exception-sweep-to-tickets
      // gate symptom). The per-field UUID_RE guards above catch the known vectors (categoryId /
      // contactId / assignedTo / sourceInboxId); this is the BELT-AND-SUSPENDERS net for any other
      // non-UUID value that reaches a `::uuid` cast in the INSERT/message path, converting the raw pg
      // exception into the same convention-compliant error envelope (docs/conventions.md → error
      // reporting & field observability) so the real signal (the bad uuid) reaches the agent + log.
      if (code === "22P02") {
        const pgMessage = String((e as { message?: string }).message ?? "")
        if (/invalid input syntax for type uuid/i.test(pgMessage)) {
          return {
            error: {
              code: "invalid_uuid_reference",
              message: `A reference field was not a valid id (UUID): ${pgMessage}. Resolve the real id first (contacts_search / users_search / tickets categories+inboxes), or omit the optional reference.`,
              retryable: false,
            },
          }
        }
      }
      // Error reporting & field observability (docs/conventions.md, BINDING): a ticket INSERT must
      // NEVER surface to the agent/judge as a bare opaque HTTP 500. Convert ANY remaining pg failure
      // into a typed error carrying the REAL signal — pg code · constraint · column · message — plus a
      // snapshot of the bound reference values, so the field failure is actionable AND becomes a real
      // bug report instead of a swallow. (The external client still gets only the safe message via
      // app.onError; this detail is for the trusted agent + the internal structured log.)
      const pgErr = e as {
        code?: string
        message?: string
        constraint_name?: string
        constraint?: string
        column?: string
        column_name?: string
        detail?: string
      }
      const pgCode = pgErr.code ?? code ?? "unknown"
      const constraint = pgErr.constraint_name ?? pgErr.constraint ?? ""
      const column = pgErr.column_name ?? pgErr.column ?? ""
      const refSnapshot = JSON.stringify({
        categoryId: params.categoryId ?? null,
        contactId: params.contactId ?? null,
        assignedTo: params.assignedTo ?? null,
        sourceInboxId: params.sourceInboxId ?? null,
        team,
        audience,
        sensitivity,
      })
      return {
        error: {
          code: "ticket_create_failed",
          message:
            `tickets:create INSERT failed (pg ${pgCode}` +
            (constraint ? ` constraint=${constraint}` : "") +
            (column ? ` column=${column}` : "") +
            `): ${String(pgErr.message ?? "")}` +
            (pgErr.detail ? ` — ${pgErr.detail}` : "") +
            ` [refs=${refSnapshot}]`,
          retryable: false,
        },
      }
    }
  }
  throw lastErr ?? new Error("reply_token collision after 3 retries")
}
