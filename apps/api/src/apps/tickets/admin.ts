// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash } from "node:crypto"
import {
  formatTicketHandle,
  maskWithNote,
  ticketIdSegmentSchema,
  ticketsApproveRepliesFromHome,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import {
  CLOSE_SILENT_MAX_DAYS,
  CLOSE_SILENT_MAX_TEXT,
  CLOSE_SILENT_MIN_DAYS,
  canActForCloseSilent,
} from "~/apps/tickets/close-silent"
import {
  applyDisplayHandles,
  displayHandleFor,
  loadSegmentConfig,
  saveSegmentConfig,
  type TicketIdSegment,
} from "~/apps/tickets/display-handle"
import { requireUuid, resolveTicketRef } from "~/apps/tickets/resolve-ticket-ref"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"
import { withPrivilegedDb, withPrivilegedReusing } from "~/db/privileged"
import { getEmailProvider } from "~/infra/email"
import { renderBrandedEmail } from "~/infra/email-layout"
import { rootLogger } from "~/lib/logger"
import { orgPublicBaseUrl } from "~/lib/org-public-url"
import { base32Token } from "~/lib/random-token"
import { pgErrorFacts } from "~/lib/transient-db-error"
import { UUID_RE } from "~/lib/uuid"
import { FileServiceError, moveFilesToParent } from "~/modules/files/service"
import { getOrgSenderTransport } from "~/modules/org/email-from"
import { hasScope } from "~/modules/permissions/permissions"

const csatLog = rootLogger.child({ module: "tickets-csat" })
const log = rootLogger.child({ module: "tickets-admin" })

type SqlClient = RlsClient | RlsTx | PrivilegedDb

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
  /** The routine tick this call is running inside, when the sandbox RPC
   *  bridge captured one (BL-275 class: the bridge callback runs outside the
   *  ALS frame currentRunContext() reads, so this is threaded explicitly
   *  rather than resolved ambiently). Undefined for a non-routine caller. */
  originRoutineId?: string
  /** Who approved this call, on an approved re-entry. Null on a direct call. */
  approverUserId?: string | null
  /** The agent whose turn proposed this call (null: no agent acted). */
  actingAgentId?: string | null
  /** The approval this call executes, on an approved re-entry. */
  approvalRequestId?: string | null
}

/** The attribution a sending tool records on its outbound row: the routine,
 *  the approver and the agent that drafted it, threaded explicitly because the
 *  bridge callback runs outside every ALS frame. */
function sendAttribution(actor: ActorRef): {
  originRoutineId?: string
  approverUserId: string | null
  actingAgentId: string | null
  approvalRequestId: string | null
} {
  return {
    ...(actor.originRoutineId ? { originRoutineId: actor.originRoutineId } : {}),
    approverUserId: actor.approverUserId ?? null,
    actingAgentId: actor.actingAgentId ?? null,
    approvalRequestId: actor.approvalRequestId ?? null,
  }
}

type AdminResult =
  | Record<string, unknown>
  | Array<Record<string, unknown>>
  | { error: { code: string; message: string; retryable: boolean } }

async function tryQueueEvent(
  tx: SqlClient,
  orgId: string,
  actor: ActorRef,
  entity: string,
  action: string,
  entityId: string,
  data: Record<string, unknown>,
): Promise<void> {
  // In a SAVEPOINT: the event is non-fatal, but a failed outbox INSERT caught
  // on the caller's own transaction would abort it, and the caller's next
  // statement would fail with 25P02 instead of this being non-fatal.
  try {
    await tx.transaction(async (sp) => {
      await sp.queueEvent({
        app: "tickets",
        entity,
        action,
        entityId,
        data,
        actorId: actor.userId,
        actorType: actor.auditActorType ?? actor.actorType,
        orgId,
        timestamp: new Date().toISOString(),
      })
    })
  } catch (err) {
    rootLogger.warn({ err, entity, action, entityId }, "tickets admin event not queued")
  }
}

export async function runAdminOp(
  tx: SqlClient,
  orgId: string,
  op: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  switch (op) {
    // The sandboxed field setters (setCategory, setLanguage, assign, setStatus
    // and friends) resolve a caller's ticket ref here before binding it to a
    // uuid column, so a `ticket-<n>` handle works and garbage is a typed error.
    case "resolveTicketRef": {
      const ref = await resolveTicketRef(tx, orgId, params.ticketId)
      return ref.ok ? { ticketId: ref.ticketId } : { error: ref.error }
    }
    case "addNote":
      return addNote(tx, orgId, params, actor)
    case "editNote":
      return editNote(tx, orgId, params, actor)
    case "deleteNote":
      return deleteNote(tx, orgId, params, actor)
    // Propose-time preflight slots for the two GATED note tools (manifest `preflight`). Read-only:
    // they resolve the note without touching it, so a call naming no note is refused at staging
    // instead of parking an approval a human would approve into a `not_found`.
    case "editNotePreflight": {
      const pre = await preflightNoteParams(tx, orgId, params, { requireText: true })
      // The approval stores and links the ticket uuid, never the handle the caller passed.
      return pre.ok
        ? { ok: true, canonicalParams: { ticketId: pre.ticketId } }
        : { error: pre.error }
    }
    case "deleteNotePreflight": {
      const pre = await preflightNoteParams(tx, orgId, params, { requireText: false })
      return pre.ok
        ? { ok: true, canonicalParams: { ticketId: pre.ticketId } }
        : { error: pre.error }
    }
    case "categoriesList":
      return categoriesList(tx, orgId)
    case "categoriesCreate":
      return categoriesCreate(tx, orgId, params, actor)
    case "categoriesUpdate":
      return categoriesUpdate(tx, orgId, params, actor)
    case "categoriesArchive":
      return categoriesArchive(tx, orgId, params, actor)
    case "categoriesTree":
      return categoriesTree(tx, orgId)
    case "categoriesReorder":
      return categoriesReorder(tx, orgId, params, actor)
    case "templatesCreate":
      return templatesCreate(tx, orgId, params, actor)
    case "templatesList":
      return templatesList(tx, orgId, params)
    case "templatesUpdate":
      return templatesUpdate(tx, orgId, params, actor)
    case "templatesDelete":
      return templatesDelete(tx, orgId, params, actor)
    case "csatRequest":
      return csatRequest(tx, orgId, params, actor)
    case "csatSummary":
      return csatSummary(tx, orgId)
    case "csatList":
      return csatList(tx, orgId, params)
    case "backlogHealth": {
      const { backlogHealth } = await import("~/apps/tickets/backlog-health")
      const team = typeof params.team === "string" ? params.team : undefined
      return (await backlogHealth(tx, orgId, { team })) as unknown as AdminResult
    }
    case "slaReport": {
      const { slaReport } = await import("~/apps/tickets/sla-report")
      const windowDays = typeof params.windowDays === "number" ? params.windowDays : undefined
      return (await slaReport(tx, orgId, { windowDays })) as unknown as AdminResult
    }
    case "teamsList": {
      const { listTeams } = await import("~/apps/tickets/teams")
      return (await listTeams(tx, orgId)) as unknown as AdminResult
    }
    case "teamsRename": {
      const { renameTeam } = await import("~/apps/tickets/teams")
      const result = await renameTeam(tx, orgId, {
        from: typeof params.from === "string" ? params.from : "",
        to: typeof params.to === "string" ? params.to : "",
        dryRun: params.dryRun === true,
      })
      // A dry run touched nothing, so there is nothing to announce. A real one
      // moved every ticket of a team at once: without an event the open inbox
      // list keeps showing the old name until someone reloads.
      if (!("error" in result) && !result.dryRun) {
        await tryQueueEvent(tx, orgId, actor, "team", "rename", result.to, {
          ...result,
        })
      }
      return result as unknown as AdminResult
    }
    case "inboxesList":
      return inboxesList(tx, orgId)
    case "inboxesCreate":
      return inboxesCreate(tx, orgId, params, actor)
    case "inboxesUpdate":
      return inboxesUpdate(tx, orgId, params, actor)
    case "inboxesDisconnect":
      return inboxesDisconnect(tx, orgId, params, actor)
    case "ticketsMove":
      return ticketsMove(tx, orgId, params, actor)
    case "idSegmentGet":
    case "idSegmentSet":
    case "idSegmentSetPreflight":
      return idSegmentOp(op, orgId, params, actor)
    case "approveFromHomeGet":
    case "approveFromHomeSet":
    case "approveFromHomeSetPreflight":
      return approveFromHomeOp(op, orgId, params, actor)
    case "apiKeysList":
      return apiKeysList(tx, orgId)
    case "apiKeysCreate":
      return apiKeysCreate(tx, orgId, params, actor)
    case "apiKeysRevoke":
      return apiKeysRevoke(tx, orgId, params)
    case "tools.replyPreflight": {
      const { ticketsReplyPreflight } = await import("~/apps/tickets/tools")
      return (await ticketsReplyPreflight(params as never, {
        tx: tx as RlsClient,
        orgId,
        actor,
      })) as AdminResult
    }
    case "tools.draftSignature": {
      const { ticketsDraftSignature } = await import("~/apps/tickets/tools")
      return (await ticketsDraftSignature(params as never, {
        tx: tx as RlsClient,
        orgId,
        actor,
        // Explicit, not resolved ambiently: the sandbox RPC bridge callback
        // this arrives through (tickets_admin, rpc-bridge.ts) runs outside the
        // ALS frame currentRunContext() reads (BL-275 class), so the caller
        // threads the in-frame-captured routine id through `actor` instead.
        originRoutineId: actor.originRoutineId,
      })) as unknown as AdminResult
    }
    case "tools.reply": {
      const { ticketsReply } = await import("~/apps/tickets/tools")
      return (await ticketsReply(params as never, {
        tx: tx as RlsClient,
        orgId,
        actor,
        ...sendAttribution(actor),
      })) as AdminResult
    }
    case "tools.nudgePreflight": {
      const { ticketsNudgePreflight } = await import("~/apps/tickets/tools")
      return (await ticketsNudgePreflight(params as never, {
        tx: tx as RlsClient,
        orgId,
        actor,
      })) as AdminResult
    }
    case "tools.closePreflight": {
      const { ticketsClosePreflight } = await import("~/apps/tickets/tools")
      return (await ticketsClosePreflight(params as never, {
        tx: tx as RlsClient,
        orgId,
        actor,
      })) as AdminResult
    }
    case "tools.nudge": {
      const { ticketsNudge } = await import("~/apps/tickets/tools")
      return (await ticketsNudge(params as never, {
        tx: tx as RlsClient,
        orgId,
        actor,
        ...sendAttribution(actor),
      })) as AdminResult
    }
    case "tools.close": {
      const { ticketsClose } = await import("~/apps/tickets/tools")
      return (await ticketsClose(params as never, {
        tx: tx as RlsClient,
        orgId,
        actor,
        ...sendAttribution(actor),
      })) as AdminResult
    }
    default:
      return {
        error: { code: "unknown_op", message: `unknown admin op: ${op}`, retryable: false },
      }
  }
}

async function addNote(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  // A staff note is masked like a customer's message: no card number or
  // payment key reaches the row, its event or the agent's next read.
  const text = maskWithNote((params.text as string | undefined) ?? "").text
  const attachmentSessionId = params.attachmentSessionId as string | undefined
  const attachments = Array.isArray(params.attachments) ? (params.attachments as string[]) : []
  if (!params.ticketId || (!text && !attachmentSessionId && attachments.length === 0)) {
    return {
      error: {
        code: "invalid_params",
        message: "ticketId and (text, attachments or attachmentSessionId) required",
        retryable: false,
      },
    }
  }
  // Accepts the `ticket-<n>` handle as well as the uuid: an agent reads the
  // handle everywhere, and binding it raw into ticket_id threw in the driver.
  const ref = await resolveTicketRef(tx, orgId, params.ticketId)
  if (!ref.ok) return { error: ref.error }
  const ticketId = ref.ticketId
  // Agent-supplied file ids get the reply's checks BEFORE the note is written,
  // so a refused file adds no note.
  const ticketsTools = attachments.length > 0 ? await import("~/apps/tickets/tools") : null
  if (ticketsTools) {
    try {
      await ticketsTools.resolveAttachableFiles({ tx: tx as RlsClient, orgId }, attachments)
    } catch (err) {
      if (err instanceof FileServiceError) {
        return { error: { code: err.code.toLowerCase(), message: err.message, retryable: false } }
      }
      throw err
    }
  }
  const now = new Date().toISOString()
  const userId = actor.actorType === "user" ? actor.userId : null
  const result = await tx.execute(drizzleSql`
    INSERT INTO ${ticketsRel("messages")} (
      id, org_id, ticket_id, kind, text_body, sent_at, created_by, author_agent_id, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), ${orgId}, ${ticketId}, 'note', ${text}, ${now}, ${userId},
      ${actor.actingAgentId ?? null}, now(), now()
    )
    RETURNING id
  `)
  const messageId = extractRows<{ id: string }>(result)[0]!.id

  // A copy that fails after the checks (quota, write scope) throws, so the
  // call's transaction rolls the note back.
  if (ticketsTools) {
    await ticketsTools.attachFilesToTicketMessage(
      tx as RlsClient,
      actor,
      orgId,
      attachments,
      messageId,
    )
  }

  if (attachmentSessionId) {
    const { schemaRef } = await import("~/db/schema-ref")
    const KS = drizzleSql.raw(schemaRef("kernel"))
    // Load file ids parented to this session under the caller's RLS context.
    // Owner-RLS on `kernel.file_upload_sessions` and the row-level visibility
    // join through `kernel.files` enforces session ownership for non-system actors.
    const fileRows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${KS}.files
        WHERE org_id = ${orgId}
          AND app = 'kernel' AND entity_type = 'file_upload_session'
          AND entity_id = ${attachmentSessionId}
      `),
    )
    const fileIds = fileRows.map((r) => r.id)
    // The ticket composer stages on a session bound to its ticket; those files
    // may only land on a note of that same ticket.
    const sessionRows = extractRows<{
      target_entity_type: string
      target_entity_id: string | null
    }>(
      await tx.execute(drizzleSql`
        SELECT target_entity_type, target_entity_id FROM ${KS}.file_upload_sessions
        WHERE id::text = ${attachmentSessionId} AND org_id = ${orgId} AND target_app = 'tickets'
        LIMIT 1`),
    )
    if (sessionRows[0]?.target_entity_type === "ticket") {
      const { resolveTicketUploadSession, moveTicketSessionFiles } = await import(
        "~/apps/tickets/tools"
      )
      const staged = await resolveTicketUploadSession(
        { tx: tx as RlsClient, orgId, actor },
        attachmentSessionId,
        ticketId,
      )
      if (!staged.ok) return { error: staged.error }
      await moveTicketSessionFiles(orgId, attachmentSessionId, staged.fileIds, messageId)
    } else if (fileIds.length > 0) {
      try {
        await moveFilesToParent(
          {
            orgId,
            userId: actor.userId,
            scopes: actor.scopes ?? ["tickets:tickets:write"],
            sourceSessionId: attachmentSessionId,
            target: { app: "tickets", entityType: "message", entityId: messageId },
            fileIds,
          },
          {
            rlsTx: tx as RlsClient,
            privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
          },
        )
      } catch (err) {
        if (err instanceof FileServiceError) {
          return {
            error: {
              code: err.code.toLowerCase(),
              message: err.message,
              retryable: false,
            },
          }
        }
        throw err
      }
    }
  }

  const ticketRows = extractRows<{ team: string | null; sensitivity: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("tickets")}
      SET message_count = COALESCE(message_count, 0) + 1, last_message_at = ${now}, updated_at = now()
      WHERE id = ${ticketId} AND org_id = ${orgId}
      RETURNING team, sensitivity
    `),
  )
  // Announce the note as its OWN event, `tickets/note:create`: an open ticket shows it live,
  // and anything bound to "a note was added" (a guided tour beat) sees it. Never
  // `message:create`, which means a message on the customer thread: every routine bound to it
  // (triage, draft replies) would fire on an internal note. Same data shape as a reply's
  // (tools.ts ticketsReply), the parent ticket's dimension values under their grant keys
  // included, so the socket fan-out's team/sensitivity filter applies to the note body exactly
  // as it does to a reply's.
  await tryQueueEvent(tx, orgId, actor, "note", "create", messageId, {
    id: messageId,
    ticketId,
    kind: "note",
    textBody: text,
    htmlBody: null,
    createdBy: userId,
    authorAgentId: actor.actingAgentId ?? null,
    sentAt: now,
    orgId,
    "tickets:team": ticketRows[0]?.team ?? null,
    "tickets:sensitivity": ticketRows[0]?.sensitivity ?? null,
  })
  // Say WHERE the note went, in words a model cannot mistake: an agent asked
  // to "add a note to <a CRM company>" once wrote here instead and reported
  // the CRM note done. The handle is the one search results show.
  const ticket = (await displayHandleFor(tx, orgId, ticketId)) ?? ticketId
  return {
    messageId,
    ticketId,
    ticket,
    savedTo: `Internal note added to Liaison ticket ${ticket} (visible to teammates on that ticket only). Nothing was written to any external system such as a CRM.`,
  }
}

/**
 * Shared, read-only validation for the gated note tools (editNote / deleteNote): the params must be
 * present and well shaped, and the messageId must name an existing INTERNAL NOTE on that ticket.
 * ONE copy, called by BOTH the manifest `preflight` exports and the two handlers, so the propose-time
 * and execute-time checks can never drift.
 *
 * WHY it runs at propose time: both tools are GATED, so an id that names no note on that ticket would
 * otherwise park a pending approval for a human and only fail once that human clicked approve. A gated
 * call must not be parked for a human when the data it needs is missing. The handlers keep their own
 * RETURNING-row guard: the note can still be deleted between staging and approval.
 */
async function preflightNoteParams(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  opts: { requireText: boolean },
): Promise<
  | { ok: true; ticketId: string }
  | { ok: false; error: { code: string; message: string; retryable: boolean } }
> {
  const ticketId = params.ticketId as string
  const messageId = params.messageId as string
  const text = params.text as string | undefined
  if (opts.requireText) {
    if (!ticketId || !messageId || typeof text !== "string" || text.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalid_params",
          message: "ticketId, messageId and non-empty text required",
          retryable: false,
        },
      }
    }
  } else if (!ticketId || !messageId) {
    return {
      ok: false,
      error: {
        code: "invalid_params",
        message: "ticketId and messageId required",
        retryable: false,
      },
    }
  }
  // Both ids reach uuid columns: resolve a `ticket-<n>` handle and refuse a
  // malformed messageId with a typed error rather than a driver cast failure.
  const ref = await resolveTicketRef(tx, orgId, ticketId)
  if (!ref.ok) return { ok: false, error: ref.error }
  const messageRef = requireUuid(messageId, "messageId")
  if (!messageRef.ok) return { ok: false, error: messageRef.error }
  const found = await tx.execute(drizzleSql`
    SELECT id FROM ${ticketsRel("messages")}
    WHERE id = ${messageId} AND ticket_id = ${ref.ticketId} AND org_id = ${orgId} AND kind = 'note'
    LIMIT 1
  `)
  if (extractRows(found).length === 0) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: opts.requireText
          ? "no internal note with that id on that ticket (only kind='note' messages are editable)"
          : "no internal note with that id on that ticket (only kind='note' messages can be deleted)",
        retryable: false,
      },
    }
  }
  return { ok: true, ticketId: ref.ticketId }
}

async function editNote(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const messageId = params.messageId as string
  const text = maskWithNote(typeof params.text === "string" ? params.text : "").text
  const pre = await preflightNoteParams(tx, orgId, params, { requireText: true })
  if (!pre.ok) return { error: pre.error }
  const ticketId = pre.ticketId
  const result = await tx.execute(drizzleSql`
    UPDATE ${ticketsRel("messages")}
    SET text_body = ${text}, updated_at = now()
    WHERE id = ${messageId} AND ticket_id = ${ticketId} AND org_id = ${orgId} AND kind = 'note'
    RETURNING id
  `)
  if (extractRows(result).length === 0) {
    return {
      error: {
        code: "not_found",
        message:
          "no internal note with that id on that ticket (only kind='note' messages are editable)",
        retryable: false,
      },
    }
  }
  await tryQueueEvent(tx, orgId, actor, "message", "update", messageId, {
    id: messageId,
    ticketId,
    kind: "note",
    textBody: text,
  })
  return { messageId, ticketId, updated: true }
}

async function deleteNote(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const messageId = params.messageId as string
  const pre = await preflightNoteParams(tx, orgId, params, { requireText: false })
  if (!pre.ok) return { error: pre.error }
  const ticketId = pre.ticketId
  const result = await tx.execute(drizzleSql`
    DELETE FROM ${ticketsRel("messages")}
    WHERE id = ${messageId} AND ticket_id = ${ticketId} AND org_id = ${orgId} AND kind = 'note'
    RETURNING id
  `)
  if (extractRows(result).length === 0) {
    return {
      error: {
        code: "not_found",
        message:
          "no internal note with that id on that ticket (only kind='note' messages can be deleted)",
        retryable: false,
      },
    }
  }
  await tx.execute(drizzleSql`
    UPDATE ${ticketsRel("tickets")}
    SET message_count = GREATEST(COALESCE(message_count, 1) - 1, 0), updated_at = now()
    WHERE id = ${ticketId} AND org_id = ${orgId}
  `)
  await tryQueueEvent(tx, orgId, actor, "message", "delete", messageId, {
    id: messageId,
    ticketId,
    kind: "note",
  })
  return { messageId, ticketId, deleted: true }
}

async function categoriesList(tx: SqlClient, orgId: string): Promise<AdminResult> {
  const result = await tx.execute(drizzleSql`
    SELECT id, parent_id, name, sort_order, archived_at, created_at, updated_at
    FROM ${ticketsRel("categories")}
    WHERE org_id = ${orgId}
    ORDER BY sort_order ASC, name ASC
  `)
  return extractRows<Record<string, unknown>>(result)
}

/**
 * The version of an org's categories tree: the latest write and the row count,
 * so any create, rename, move or archive moves it. The settings page loads it
 * with the tree and hands it back to categoriesReorder as its base.
 */
async function categoriesVersion(tx: SqlClient, orgId: string): Promise<string> {
  const [row] = extractRows<{ v: string | null; n: number }>(
    await tx.execute(drizzleSql`
      SELECT max(updated_at)::text AS v, count(*)::int AS n
      FROM ${ticketsRel("categories")}
      WHERE org_id = ${orgId}
    `),
  )
  return `${row?.v ?? "empty"}#${row?.n ?? 0}`
}

async function categoriesTree(tx: SqlClient, orgId: string): Promise<AdminResult> {
  const rows = (await categoriesList(tx, orgId)) as Array<Record<string, unknown>>
  return { rows, version: await categoriesVersion(tx, orgId) }
}

export const CATEGORY_MAX_DEPTH = 2
export const CATEGORY_NAME_MAX = 200

function categoryParamError(message: string): AdminResult {
  return { error: { code: "invalid_params", message, retryable: false } }
}

interface ReorderInput {
  id?: string
  tempId?: string
  parentId: string | null
  parentTempId?: string
  name: string
  sortOrder: number
  archived: boolean
}

function parseReorderNodes(raw: unknown): ReorderInput[] | string {
  if (!Array.isArray(raw)) return "nodes must be an array"
  const out: ReorderInput[] = []
  for (const [i, n] of raw.entries()) {
    if (!n || typeof n !== "object") return `nodes[${i}] must be an object`
    const r = n as Record<string, unknown>
    const id = typeof r.id === "string" && r.id ? r.id : undefined
    const tempId = typeof r.tempId === "string" && r.tempId ? r.tempId : undefined
    if ((id === undefined) === (tempId === undefined)) {
      return `nodes[${i}] needs exactly one of id or tempId`
    }
    if (id !== undefined && !UUID_RE.test(id)) return `nodes[${i}].id is not a category id`
    const parentTempId =
      typeof r.parentTempId === "string" && r.parentTempId ? r.parentTempId : undefined
    const parentId = typeof r.parentId === "string" && r.parentId ? r.parentId : null
    if (parentTempId !== undefined && parentId !== null) {
      return `nodes[${i}] names both parentId and parentTempId`
    }
    if (parentId !== null && !UUID_RE.test(parentId)) {
      return `nodes[${i}].parentId is not a category id`
    }
    const name = typeof r.name === "string" ? r.name.trim() : ""
    if (!name) return `nodes[${i}].name is required`
    if (name.length > CATEGORY_NAME_MAX) {
      return `nodes[${i}].name is longer than ${CATEGORY_NAME_MAX} characters`
    }
    if (typeof r.sortOrder !== "number" || !Number.isInteger(r.sortOrder)) {
      return `nodes[${i}].sortOrder must be a whole number`
    }
    out.push({
      id,
      tempId,
      parentId,
      parentTempId,
      name,
      sortOrder: r.sortOrder,
      archived: r.archived === true,
    })
  }
  return out
}

/**
 * Save the whole categories tree from the settings page in one transaction.
 * Serialized per org (advisory lock), refused with `conflict` when the tree
 * moved since `baseVersion`, and checked for depth on the final tree before
 * anything is written (the deferred constraint trigger of migration 0189 checks
 * it again at commit). New nodes are inserted first (so a child may name its
 * new parent's temp id), then every node's name, parent, order and archive
 * state is applied. Nodes the payload leaves out keep their state.
 */
async function categoriesReorder(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const base = params.baseVersion
  if (base !== null && typeof base !== "string") {
    return categoryParamError("baseVersion must be the version categories.tree returned")
  }
  const nodes = parseReorderNodes(params.nodes)
  if (typeof nodes === "string") return categoryParamError(nodes)

  await tx.execute(
    drizzleSql`SELECT pg_advisory_xact_lock(hashtextextended(${`tickets.categories:${orgId}`}, 0))`,
  )
  const current = await categoriesVersion(tx, orgId)
  if (base !== current) {
    return {
      error: {
        code: "conflict",
        message: "The categories changed since this page loaded. Reload to see the latest tree.",
        retryable: false,
      },
    }
  }

  const existing = new Map(
    extractRows<{
      id: string
      parent_id: string | null
      name: string
      sort_order: number
      archived_at: string | null
    }>(
      await tx.execute(drizzleSql`
        SELECT id, parent_id, name, sort_order, archived_at
        FROM ${ticketsRel("categories")}
        WHERE org_id = ${orgId}
      `),
    ).map((r) => [r.id, r]),
  )

  // Resolve the final tree: key = id or `temp:<tempId>`.
  const keyOf = (n: ReorderInput) => (n.id !== undefined ? n.id : `temp:${n.tempId}`)
  const final = new Map<string, { parent: string | null; archived: boolean }>()
  for (const [id, row] of existing) {
    final.set(id, { parent: row.parent_id, archived: row.archived_at !== null })
  }
  const seen = new Set<string>()
  const tempIds = new Set(nodes.flatMap((n) => (n.tempId !== undefined ? [n.tempId] : [])))
  for (const n of nodes) {
    const key = keyOf(n)
    if (seen.has(key)) return categoryParamError(`category ${n.id ?? n.tempId} appears twice`)
    seen.add(key)
    if (n.id !== undefined && !existing.has(n.id)) {
      return categoryParamError(`category ${n.id} is not a category of this organization`)
    }
    if (n.parentTempId !== undefined && !tempIds.has(n.parentTempId)) {
      return categoryParamError(`parentTempId ${n.parentTempId} names no new category`)
    }
    if (n.parentId !== null && !existing.has(n.parentId)) {
      return categoryParamError(`parent ${n.parentId} is not a category of this organization`)
    }
    const parent = n.parentTempId !== undefined ? `temp:${n.parentTempId}` : n.parentId
    const wasArchived = n.id !== undefined && existing.get(n.id)?.archived_at !== null
    final.set(key, { parent, archived: n.archived || wasArchived })
  }
  // Depth on the final live tree (archived rows do not count): a live node
  // whose live parent has a parent sits on a third level. A cycle has no root
  // and always trips the same rule.
  for (const [, node] of final) {
    if (node.archived || node.parent === null) continue
    const parent = final.get(node.parent)
    if (parent && !parent.archived && parent.parent !== null) return categoryDepthError()
  }

  // New categories first, at the top level; their parent is set below.
  const ids: Record<string, string> = {}
  for (const n of nodes) {
    if (n.tempId === undefined) continue
    const [row] = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${ticketsRel("categories")} (
          id, org_id, name, parent_id, sort_order, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}::uuid, ${n.name}, NULL, ${n.sortOrder}, now(), now()
        )
        RETURNING id
      `),
    )
    ids[n.tempId] = row.id
  }
  const resolveParent = (n: ReorderInput): string | null =>
    n.parentTempId !== undefined ? (ids[n.parentTempId] ?? null) : n.parentId

  for (const n of nodes) {
    const parentId = resolveParent(n)
    if (n.tempId !== undefined) {
      const id = ids[n.tempId]
      if (parentId !== null || n.archived) {
        await tx.execute(drizzleSql`
          UPDATE ${ticketsRel("categories")}
          SET parent_id = ${parentId}::uuid,
              archived_at = ${n.archived ? drizzleSql`now()` : drizzleSql`NULL`},
              updated_at = now()
          WHERE id = ${id}::uuid AND org_id = ${orgId}
        `)
      }
      await tryQueueEvent(tx, orgId, actor, "category", "create", id, {
        id,
        name: n.name,
        parentId,
      })
      continue
    }
    const id = n.id as string
    const was = existing.get(id)
    if (!was) continue
    const archive = n.archived && was.archived_at === null
    const changes: Record<string, unknown> = {}
    if (was.name !== n.name) changes.name = n.name
    if (was.parent_id !== parentId) changes.parentId = parentId
    if (was.sort_order !== n.sortOrder) changes.sortOrder = n.sortOrder
    if (Object.keys(changes).length === 0 && !archive) continue
    await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("categories")}
      SET name = ${n.name}, parent_id = ${parentId}::uuid, sort_order = ${n.sortOrder},
          archived_at = ${archive ? drizzleSql`now()` : drizzleSql`archived_at`},
          updated_at = now()
      WHERE id = ${id}::uuid AND org_id = ${orgId}
    `)
    if (Object.keys(changes).length > 0) {
      await tryQueueEvent(tx, orgId, actor, "category", "update", id, { id, changes })
    }
    if (archive) await tryQueueEvent(tx, orgId, actor, "category", "archive", id, { id })
  }

  return { version: await categoriesVersion(tx, orgId), ids }
}

/**
 * Would putting `id` (null: a new category) under `parentId` make a third
 * level? Checked before writing so the caller gets a typed error; the deferred
 * constraint trigger (migration 0189) checks the final tree again at commit.
 */
async function categoryDepthExceeded(
  tx: SqlClient,
  orgId: string,
  id: string | null,
  parentId: string | null,
): Promise<boolean> {
  if (parentId === null) return false
  const [row] = extractRows<{ bad: boolean }>(
    await tx.execute(drizzleSql`
      SELECT
        EXISTS (SELECT 1 FROM ${ticketsRel("categories")}
                WHERE id = ${parentId}::uuid AND org_id = ${orgId}
                  AND archived_at IS NULL AND parent_id IS NOT NULL)
        OR (${id}::uuid IS NOT NULL AND EXISTS (
              SELECT 1 FROM ${ticketsRel("categories")}
              WHERE parent_id = ${id}::uuid AND org_id = ${orgId} AND archived_at IS NULL))
        AS bad
    `),
  )
  return row?.bad === true
}

const categoryDepthError = (): AdminResult => ({
  error: {
    code: "category_depth_limit",
    message: `categories nest at most ${CATEGORY_MAX_DEPTH} levels`,
    retryable: false,
  },
})

async function categoriesCreate(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const name = params.name as string
  if (!name)
    return { error: { code: "invalid_params", message: "name required", retryable: false } }
  try {
    const parentId = (params.parentId as string | null | undefined) ?? null
    const sortOrder = (params.sortOrder as number | undefined) ?? 0
    if (await categoryDepthExceeded(tx, orgId, null, parentId)) return categoryDepthError()
    const result = await tx.execute(drizzleSql`
      INSERT INTO ${ticketsRel("categories")} (
        id, org_id, name, parent_id, sort_order, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}::uuid, ${name}, ${parentId}::uuid, ${sortOrder}, now(), now()
      )
      RETURNING *
    `)
    const row = extractRows<Record<string, unknown>>(result)[0] ?? {}
    if (row.id) {
      await tryQueueEvent(tx, orgId, actor, "category", "create", String(row.id), {
        id: row.id,
        name,
        parentId,
      })
    }
    return row
  } catch (e: any) {
    const message = `${e?.message ?? ""}\n${e?.cause?.message ?? ""}`
    if (message.includes("category_depth_limit")) {
      return {
        error: {
          code: "category_depth_limit",
          message: `categories nest at most ${CATEGORY_MAX_DEPTH} levels`,
          retryable: false,
        },
      }
    }
    throw e
  }
}

async function categoriesUpdate(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const id = params.id as string
  if (!id) return { error: { code: "invalid_params", message: "id required", retryable: false } }
  const sets: ReturnType<typeof drizzleSql>[] = []
  const changes: Record<string, unknown> = {}
  if (typeof params.name === "string") {
    sets.push(drizzleSql`name = ${params.name}`)
    changes.name = params.name
  }
  if ("parentId" in params) {
    const parentId = (params.parentId as string | null) ?? null
    if (await categoryDepthExceeded(tx, orgId, id, parentId)) return categoryDepthError()
    sets.push(drizzleSql`parent_id = ${parentId}`)
    changes.parentId = (params.parentId as string | null) ?? null
  }
  if (typeof params.sortOrder === "number") {
    sets.push(drizzleSql`sort_order = ${params.sortOrder}`)
    changes.sortOrder = params.sortOrder
  }
  if (sets.length === 0) return { id }
  sets.push(drizzleSql`updated_at = now()`)
  const setClause = drizzleSql.join(sets, drizzleSql.raw(", "))
  await tx.execute(drizzleSql`
    UPDATE ${ticketsRel("categories")} SET ${setClause}
    WHERE id = ${id} AND org_id = ${orgId}
  `)
  await tryQueueEvent(tx, orgId, actor, "category", "update", id, { id, changes })
  return { id }
}

async function categoriesArchive(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const id = params.id as string
  if (!id) return { error: { code: "invalid_params", message: "id required", retryable: false } }
  await tx.execute(drizzleSql`
    UPDATE ${ticketsRel("categories")} SET archived_at = now(), updated_at = now()
    WHERE id = ${id} AND org_id = ${orgId}
  `)
  await tryQueueEvent(tx, orgId, actor, "category", "archive", id, { id })
  return { id, archived: true }
}

// Reply-template (canned-response macro) CRUD — BL-169 #9. Org-shared saved replies a
// support agent authors once (grounded in Knowledge) and reuses. Mirrors categoriesCreate/List.
async function templatesCreate(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const name = typeof params.name === "string" ? params.name.trim() : ""
  const bodyText = typeof params.bodyText === "string" ? params.bodyText : ""
  if (!name)
    return { error: { code: "invalid_params", message: "name required", retryable: false } }
  if (!bodyText)
    return { error: { code: "invalid_params", message: "bodyText required", retryable: false } }
  const category = typeof params.category === "string" && params.category ? params.category : null
  // Pre-check (org,name) uniqueness BEFORE inserting so the common collision answers without
  // a write. A concurrent creator can still win the race: the INSERT below runs in its own
  // SAVEPOINT, so its 23505 rolls back only the savepoint and the caller's transaction stays
  // usable for whatever it runs next (a caught violation outside a savepoint leaves it 25P02).
  const existing = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${ticketsRel("reply_templates")} WHERE org_id = ${orgId} AND name = ${name} LIMIT 1
    `),
  )
  if (existing.length > 0) {
    return {
      error: {
        code: "name_exists",
        message: `a reply template named "${name}" already exists — pick a different name or update it`,
        retryable: false,
      },
    }
  }
  try {
    return await tx.transaction(async (sp) => {
      const result = await sp.execute(drizzleSql`
        INSERT INTO ${ticketsRel("reply_templates")} (
          id, org_id, name, category, body_text, created_by, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}::uuid, ${name}, ${category}, ${bodyText}, ${actor.userId}::uuid, now(), now()
        )
        RETURNING id, name, category, body_text, created_at
      `)
      const row = extractRows<Record<string, unknown>>(result)[0] ?? {}
      if (row.id) {
        await tryQueueEvent(sp, orgId, actor, "reply_template", "create", String(row.id), {
          id: row.id,
          name,
          category,
        })
      }
      return row
    })
  } catch (e: any) {
    const message = `${e?.message ?? ""}\n${e?.cause?.message ?? ""}`
    // UNIQUE (org_id, name)
    if (
      e?.code === "23505" ||
      e?.cause?.code === "23505" ||
      message.includes("reply_templates_org_id_name_key")
    ) {
      return {
        error: {
          code: "name_exists",
          message: `a reply template named "${name}" already exists — pick a different name or update it`,
          retryable: false,
        },
      }
    }
    throw e
  }
}

async function templatesList(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
): Promise<AdminResult> {
  const category = typeof params.category === "string" && params.category ? params.category : null
  const result = category
    ? await tx.execute(drizzleSql`
        SELECT id, name, category, body_text, created_at
        FROM ${ticketsRel("reply_templates")}
        WHERE org_id = ${orgId} AND category = ${category}
        ORDER BY name ASC
      `)
    : await tx.execute(drizzleSql`
        SELECT id, name, category, body_text, created_at
        FROM ${ticketsRel("reply_templates")}
        WHERE org_id = ${orgId}
        ORDER BY category ASC NULLS FIRST, name ASC
      `)
  return extractRows<Record<string, unknown>>(result)
}

async function templatesUpdate(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const id = typeof params.id === "string" ? params.id : ""
  if (!id) return { error: { code: "invalid_params", message: "id required", retryable: false } }
  const name = typeof params.name === "string" ? params.name.trim() : undefined
  const bodyText = typeof params.bodyText === "string" ? params.bodyText : undefined
  const category =
    params.category === null
      ? null
      : typeof params.category === "string"
        ? params.category
        : undefined
  if (name === undefined && bodyText === undefined && category === undefined) {
    return { error: { code: "invalid_params", message: "nothing to update", retryable: false } }
  }
  // If renaming, pre-check the (org,name) uniqueness against OTHER rows (a 23505 would abort the RLS tx).
  if (name) {
    const clash = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${ticketsRel("reply_templates")}
        WHERE org_id = ${orgId} AND name = ${name} AND id <> ${id}::uuid LIMIT 1
      `),
    )
    if (clash.length > 0) {
      return {
        error: {
          code: "name_exists",
          message: `another reply template named "${name}" already exists`,
          retryable: false,
        },
      }
    }
  }
  const result = await tx.execute(drizzleSql`
    UPDATE ${ticketsRel("reply_templates")} SET
      name = COALESCE(${name ?? null}, name),
      body_text = COALESCE(${bodyText ?? null}, body_text),
      category = ${category === undefined ? drizzleSql`category` : category},
      updated_at = now()
    WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid
    RETURNING id, name, category, body_text, created_at
  `)
  const row = extractRows<Record<string, unknown>>(result)[0]
  if (!row)
    return { error: { code: "not_found", message: "reply template not found", retryable: false } }
  await tryQueueEvent(tx, orgId, actor, "reply_template", "update", id, { id })
  return row
}

async function templatesDelete(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const id = typeof params.id === "string" ? params.id : ""
  if (!id) return { error: { code: "invalid_params", message: "id required", retryable: false } }
  const result = await tx.execute(drizzleSql`
    DELETE FROM ${ticketsRel("reply_templates")}
    WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid
    RETURNING id
  `)
  const row = extractRows<{ id: string }>(result)[0]
  if (!row)
    return { error: { code: "not_found", message: "reply template not found", retryable: false } }
  await tryQueueEvent(tx, orgId, actor, "reply_template", "delete", id, { id })
  return { id, deleted: true }
}

// CSAT post-resolution surveys — BL-169 #8. csatRequest dispatches a satisfaction survey to
// the customer of each CLOSED ticket (one pending survey per ticket); the rating is RECORDED
// only when the customer responds (a separate ingest path), so freshly-dispatched surveys are
// 'pending' and csat.summary reports averageScore=null until responses accrue. The agent must
// report dispatch + honest-pending, never fabricate a CSAT score.
async function csatRequest(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const rawIds = Array.isArray(params.ticketIds) ? params.ticketIds : []
  const ticketIds = rawIds.filter((x): x is string => typeof x === "string" && x.length > 0)
  if (ticketIds.length === 0) {
    return {
      error: {
        code: "invalid_params",
        message:
          "ticketIds (array of CLOSED ticket ids — find them with tickets__search status=closed, closedAfter=<window>) is required",
        retryable: false,
      },
    }
  }
  const dispatched: Array<Record<string, unknown>> = []
  const skipped: Array<{ ticketId: string; reason: string }> = []
  // BL-194 delivery: collect the (recipient, token, subject) tuples for the surveys we actually
  // insert, then SEND the tokenized survey emails best-effort AFTER the loop (a send failure must
  // never block the dispatch record — fire-and-forget, exactly like the kernel transactional path).
  const toDeliver: Array<{ email: string; token: string; subject: string; handle: string }> = []
  for (const ticketId of ticketIds) {
    const trows = extractRows<{
      id: string
      status: string
      contact_id: string | null
      subject: string
      handle: string
      contact_email: string | null
    }>(
      await tx.execute(drizzleSql`
        SELECT t.id, t.status, t.contact_id, t.subject, t.handle,
               -- The ticket's stored requester (who it is for), else the linked
               -- contact's address, else the sender of the first inbound message
               -- by RECEIVED time (a ticket need not link a contact: intake
               -- never creates one, modules/contacts). Never the sender-set Date.
               COALESCE(t.requester_email, ct.email, (
                 SELECT m.from_email FROM ${ticketsRel("messages")} m
                  WHERE m.org_id = t.org_id AND m.ticket_id = t.id AND m.kind = 'inbound'
                    AND m.from_email IS NOT NULL AND m.from_email <> ''
                  ORDER BY m.received_at ASC, m.id ASC LIMIT 1)) AS contact_email
        FROM ${ticketsRel("tickets")} t
        LEFT JOIN ${kernelRel("contacts")} ct ON ct.id = t.contact_id AND ct.org_id = t.org_id
        WHERE t.id = ${ticketId}::uuid AND t.org_id = ${orgId}::uuid LIMIT 1
      `),
    )
    const t = trows[0]
    if (!t) {
      skipped.push({ ticketId, reason: "not_found" })
      continue
    }
    // The survey email and the result name the ticket by its display handle.
    t.handle = (await displayHandleFor(tx, orgId, t.id)) ?? t.handle
    // Only survey resolved cases — a survey on an open ticket is premature.
    if (t.status !== "closed") {
      skipped.push({ ticketId, reason: `not_closed (status=${t.status})` })
      continue
    }
    // One survey per ticket. Pre-check uniqueness BEFORE inserting: a 23505 aborts the whole
    // RLS tx so the per-row loop could not recover mid-flight (the reply_templates lesson).
    const existing = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${ticketsRel("ticket_csat")}
        WHERE org_id = ${orgId} AND ticket_id = ${ticketId}::uuid LIMIT 1
      `),
    )
    if (existing.length > 0) {
      skipped.push({ ticketId, reason: "already_surveyed" })
      continue
    }
    const token = base32Token(16)
    const result = await tx.execute(drizzleSql`
      INSERT INTO ${ticketsRel("ticket_csat")} (
        id, org_id, ticket_id, contact_id, status, survey_token, sent_at, created_by, created_at
      ) VALUES (
        gen_random_uuid(), ${orgId}::uuid, ${ticketId}::uuid, ${t.contact_id}, 'pending', ${token}, now(), ${actor.userId}::uuid, now()
      )
      RETURNING id, ticket_id, status, sent_at
    `)
    const row = extractRows<Record<string, unknown>>(result)[0] ?? {}
    const delivered = typeof t.contact_email === "string" && t.contact_email.includes("@")
    dispatched.push({ ...row, handle: t.handle, subject: t.subject, willEmail: delivered })
    if (delivered) {
      toDeliver.push({
        email: t.contact_email as string,
        token,
        subject: t.subject,
        handle: t.handle,
      })
    }
    if (row.id) {
      await tryQueueEvent(tx, orgId, actor, "csat_survey", "dispatch", String(row.id), { ticketId })
    }
  }
  // BL-194 delivery — send the tokenized survey email per dispatched survey. Best-effort: the
  // survey rows are already inserted; an email failure (no SMTP configured → console adapter,
  // a contact without a routable address, a transient provider error) is logged and never alters
  // the dispatch result. The link carries the opaque per-survey token the public ingest validates.
  let emailed = 0
  // Managed edition: the org's own verified sender, else "<Org> via Liaison"
  // (S29). Null elsewhere: the survey goes out exactly as before.
  const orgSender = toDeliver.length > 0 ? await getOrgSenderTransport(orgId) : null
  for (const d of toDeliver) {
    const link = `${await orgPublicBaseUrl(orgId)}/csat/${orgId}/${d.token}`
    const subject = `How did we do? -- ${d.subject}`
    const { html, text } = renderBrandedEmail({
      subject,
      eyebrow: "Feedback",
      heading: "How did we do?",
      paragraphs: [
        `Thanks for contacting support about "${d.subject}" (${d.handle}).`,
        "We'd love your feedback -- it only takes a moment to rate your experience from 1 to 5.",
      ],
      cta: { label: "Rate your experience", href: link },
    })
    try {
      await (orgSender?.provider ?? getEmailProvider()).send({
        to: d.email,
        ...(orgSender ? { from: orgSender.from } : {}),
        subject,
        template: "tickets.csat-survey",
        idempotencyKey: `csat:${orgId}:${d.token}`,
        text,
        html,
      })
      emailed += 1
    } catch (err) {
      csatLog.warn({ err, handle: d.handle }, "csat survey email delivery failed (best-effort)")
    }
  }
  return {
    dispatched: dispatched.length,
    skipped: skipped.length,
    emailed,
    surveys: dispatched,
    skippedDetail: skipped,
    note: "Surveys dispatched (status=pending) and the survey email sent to each customer with a contact address (emailed). Ratings are recorded only as customers respond — no aggregate CSAT score exists yet; use csat.summary to read recorded responses honestly.",
  }
}

async function csatSummary(tx: SqlClient, orgId: string): Promise<AdminResult> {
  const rows = extractRows<{
    total: number
    responded: number
    pending: number
    declined: number
    avg_score: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'responded')::int AS responded,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'declined')::int AS declined,
        AVG(score) FILTER (WHERE status = 'responded' AND score IS NOT NULL)::numeric(10,2) AS avg_score
      FROM ${ticketsRel("ticket_csat")}
      WHERE org_id = ${orgId}
    `),
  )
  const agg = rows[0] ?? { total: 0, responded: 0, pending: 0, declined: 0, avg_score: null }
  const total = Number(agg.total) || 0
  const responded = Number(agg.responded) || 0
  const averageScore = agg.avg_score == null ? null : Number(agg.avg_score)
  // BL-194 trend — week-over-week buckets over the RECORDED responses (by response week). This is
  // EMPTY until any survey is actually answered; it is a true server-side aggregate over the
  // responses that exist, NOT a projection. When no responses exist the array is [] and the honest
  // "no trend yet" note below still holds — never present an empty/short trend as a satisfaction
  // movement.
  const trendRows = extractRows<{
    week_start: string
    responses: number
    avg_score: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT
        date_trunc('week', responded_at)::date AS week_start,
        COUNT(*)::int AS responses,
        AVG(score)::numeric(10,2) AS avg_score
      FROM ${ticketsRel("ticket_csat")}
      WHERE org_id = ${orgId} AND status = 'responded' AND responded_at IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `),
  )
  const trend = trendRows.map((r) => ({
    weekStart: r.week_start,
    responses: Number(r.responses) || 0,
    averageScore: r.avg_score == null ? null : Number(r.avg_score),
  }))
  const pending = Number(agg.pending) || 0
  const declined = Number(agg.declined) || 0
  return {
    total,
    responded,
    pending,
    declined,
    averageScore, // null until responses accrue — NEVER fabricate a score
    responseRate: total > 0 ? Math.round((responded / total) * 1000) / 10 : 0,
    trend, // week-over-week buckets over RECORDED responses; [] until responses accrue
    note:
      averageScore === null
        ? "No CSAT responses recorded yet — surveys accrue ratings as customers respond. No aggregate CSAT score or week-over-week trend is computable until responses come in (trend is empty); do not invent one."
        : "averageScore + trend aggregate ONLY the RECORDED responses so far (trend bucketed by response week); responses accrue over time, so report the trend only across weeks that actually have responses and never extrapolate beyond them.",
    // The surveys by response status as rows, the list a dashboard block charts by default
    // (`trend` stays reachable by name, a block's rowsPath).
    rows: [
      { key: "responded", value: responded },
      { key: "pending", value: pending },
      { key: "declined", value: declined },
    ],
  }
}

async function csatList(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
): Promise<AdminResult> {
  const status =
    typeof params.status === "string" &&
    ["pending", "responded", "declined"].includes(params.status)
      ? params.status
      : null
  const result = status
    ? await tx.execute(drizzleSql`
        SELECT c.id, c.ticket_id, c.status, c.score, c.sent_at, c.responded_at, t.handle, t.subject
        FROM ${ticketsRel("ticket_csat")} c JOIN ${ticketsRel("tickets")} t ON t.id = c.ticket_id
        WHERE c.org_id = ${orgId} AND c.status = ${status}
        ORDER BY c.sent_at DESC LIMIT 200
      `)
    : await tx.execute(drizzleSql`
        SELECT c.id, c.ticket_id, c.status, c.score, c.sent_at, c.responded_at, t.handle, t.subject
        FROM ${ticketsRel("ticket_csat")} c JOIN ${ticketsRel("tickets")} t ON t.id = c.ticket_id
        WHERE c.org_id = ${orgId}
        ORDER BY c.sent_at DESC LIMIT 200
      `)
  // Each row names its ticket by the display handle (`ticket-B2B-12`).
  return applyDisplayHandles(
    tx,
    orgId,
    extractRows<Record<string, unknown> & { handle: string }>(result),
    (r) => String(r.ticket_id),
  )
}

async function inboxesList(tx: SqlClient, orgId: string): Promise<AdminResult> {
  // Each inbox carries the health of its backing connected account so the
  // Settings UI can show per-inbox connection health ("needs reconnection")
  // instead of only the generic attention-feed item. Reconnect rebinds the
  // inbox to the fresh account row (ticketsOnAccountConnected), so the binding
  // reflects current state. The inboxes are read under the caller's client;
  // the accounts are read privileged: an org mailbox belongs to whoever
  // connected it, and connected_accounts RLS shows a member only their own, so
  // under the caller's client every other mailbox would read as unbound. Only
  // health facts leave this function, never a credential.
  const inboxRows = extractRows<Record<string, unknown>>(
    await tx.execute(drizzleSql`
    SELECT i.id, i.kind, i.connected_account_id, i.name, i.email_address, i.default_team, i.default_audience,
           i.default_sensitivity, i.from_display_name, i.reply_via_inbox_id, i.reply_from_email,
           i.reply_to_email, i.signature_html, i.signature_text, i.ack_enabled, i.ack_body_text,
           i.sla_promise_phrase, i.suppress_attention, i.notify_new_ticket, i.sla_exempt, i.attention_cutoff_at,
           i.close_silent_enabled, i.close_silent_nudge_days, i.close_silent_close_days,
           i.close_silent_nudge_text, i.close_silent_enabled_at,
           i.is_default_for_create, i.archived_at
    FROM ${ticketsRel("inboxes")} i
    WHERE i.org_id = ${orgId}
    ORDER BY i.created_at DESC
  `),
  )
  const accountIds = [
    ...new Set(
      inboxRows
        .map((r) => r.connected_account_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ]
  const accounts = new Map<string, Record<string, unknown>>()
  if (accountIds.length > 0) {
    const accountRows = await withPrivilegedReusing(
      tx,
      orgId,
      "tickets-inbox-account-health",
      async (ptx) =>
        extractRows<Record<string, unknown>>(
          await ptx.execute(drizzleSql`
          SELECT a.id::text AS id,
                 a.app_name AS account_app_name, a.connection_name AS account_connection_name,
                 a.status AS account_status, a.status_message AS account_status_message,
                 a.provider_type AS account_provider_type, a.token_expires_at AS account_token_expires_at,
                 a.refresh_token_encrypted AS account_refresh_token_encrypted,
                 a.metadata AS account_metadata
          FROM ${kernelRel("connected_accounts")} a
          WHERE a.org_id = ${orgId} AND a.id::text IN (${drizzleSql.join(
            accountIds.map((id) => drizzleSql`${id}`),
            drizzleSql`, `,
          )})
        `),
        ),
    )
    for (const a of accountRows) accounts.set(String(a.id), a)
  }
  const rows = inboxRows.map((inbox) => {
    const account = accounts.get(String(inbox.connected_account_id ?? ""))
    if (!account) return inbox
    const { id: _accountId, ...health } = account
    return { ...inbox, ...health }
  })
  const { classifyConnectionHealth } = await import("~/modules/apps/connections/attention")
  return rows.map((row) => {
    const {
      account_app_name,
      account_connection_name,
      account_status,
      account_status_message,
      account_provider_type,
      account_token_expires_at,
      account_refresh_token_encrypted,
      account_metadata,
      ...inbox
    } = row
    // API inboxes (and legacy rows without a bound account) have no connection
    // to be unhealthy — report no health rather than a false "disconnected".
    if (!inbox.connected_account_id || typeof account_status !== "string") {
      return { ...inbox, connection_health: null }
    }
    const classified = classifyConnectionHealth({
      orgId,
      appName: (account_app_name as string) ?? "tickets",
      connectionName: (account_connection_name as string) ?? "",
      status: account_status,
      providerType: (account_provider_type as string) ?? "",
      tokenExpiresAt: account_token_expires_at
        ? new Date(account_token_expires_at as string)
        : null,
      refreshTokenEncrypted: (account_refresh_token_encrypted as string | null) ?? null,
      metadata: account_metadata,
    })
    // Carried so the UI's Reconnect button knows WHICH authorize flow to start
    // (gmail OAuth vs imap credentials) without a second lookup.
    const connection =
      typeof account_connection_name === "string" ? { connection: account_connection_name } : {}
    const health = classified
      ? {
          status: "needs_reconnect" as const,
          ...connection,
          reason: classified.reason,
          ...(classified.missingScopes?.length ? { missingScopes: classified.missingScopes } : {}),
          ...(typeof account_status_message === "string" && account_status_message
            ? { statusMessage: account_status_message }
            : {}),
        }
      : account_status === "active"
        ? { status: "ok" as const, ...connection }
        : // `disconnected` account still bound to a live inbox: the operator
          // disconnected or the OAuth died without a fresh row — reconnect.
          { status: "needs_reconnect" as const, ...connection, reason: "disconnected" }
    return { ...inbox, connection_health: health }
  })
}

async function inboxesCreate(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const name = params.name as string
  const kind = (params.kind as string | undefined) ?? "mailbox"
  if (!name) {
    return { error: { code: "invalid_params", message: "name required", retryable: false } }
  }
  // API inboxes are pure receiving buckets (bug reports, website contact, a
  // per-tenant endpoint): no connected mail account, no mailbox. Their replies
  // are sent through a reply-via mailbox (see loadInboxAndProvider), so the
  // connected-account binding below does NOT apply to them.
  if (kind === "api") {
    return inboxesCreateApi(tx, orgId, params, actor, name)
  }
  if (kind !== "mailbox") {
    return {
      error: { code: "invalid_params", message: `unknown inbox kind "${kind}"`, retryable: false },
    }
  }
  const emailAddress = params.emailAddress as string
  const connectedAccountId = params.connectedAccountId as string
  if (!emailAddress || !connectedAccountId) {
    return {
      error: {
        code: "invalid_params",
        message: "name, emailAddress, connectedAccountId required",
        retryable: false,
      },
    }
  }
  // A tickets inbox is the support face of a CONNECTED mail account — it must
  // bind to a real `connected_accounts` row whose `identifier` (the mailbox
  // address) MATCHES the inbox's `emailAddress`. Binding an inbox labelled
  // support@foo.example to an account that is actually support@bar.example
  // produces a misleading artifact and lets an agent fabricate "I connected
  // support@foo.example as a shared inbox" when no such mailbox exists (there
  // is no agent-callable mail connect/add tool — onboarding a mailbox is an
  // OAuth/Settings flow). Reject the mismatch at the source rather than persist
  // a mislabelled inbox. The lookup runs under the caller's RLS so it can only
  // resolve org-visible accounts.
  const acctRows = extractRows<{ identifier: string; status: string }>(
    await tx.execute(drizzleSql`
      SELECT identifier, status
      FROM ${kernelRel("connected_accounts")}
      WHERE id = ${connectedAccountId}::uuid AND org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )
  let acct = acctRows[0]
  if (!acct) {
    // ORG-owned mail accounts (shared mailboxes) are deliberately invisible to
    // caller RLS: the connected_accounts SELECT policy exposes org-owned rows
    // only for app_name='kernel' (see loadConnectedAccounts in
    // connections/service.ts, which documents this same RLS-first + privileged
    // org-scoped fallback). Without the fallback an inboxes admin can never
    // bind an inbox to a SHARED mailbox — only to their own personal account.
    // Authz is already carried by the tool scope (tickets:inboxes:admin), and
    // the fallback is scoped to (id, org_id, owner_type='org') so it exposes
    // nothing beyond this org's shared accounts.
    const { withPrivilegedDb } = await import("~/db/privileged")
    acct = (
      await withPrivilegedDb(orgId, "tickets-inbox-bind-account", async (ptx) =>
        extractRows<{ identifier: string; status: string }>(
          await ptx.execute(drizzleSql`
            SELECT identifier, status
            FROM ${kernelRel("connected_accounts")}
            WHERE id = ${connectedAccountId}::uuid AND org_id = ${orgId}::uuid
              AND owner_type = 'org'
            LIMIT 1
          `),
        ),
      )
    )[0]
  }
  if (!acct) {
    return {
      error: {
        code: "account_not_found",
        message:
          `No connected account ${connectedAccountId} is visible for this org. A tickets inbox must ` +
          `bind to a mail account that is already connected. A mailbox connects on a Connect card in ` +
          `the conversation (kernel__request_secret kind oauth_connect, app mail, connection gmail, ` +
          `mode org for a shared one); only after it shows as connected can a tickets inbox be ` +
          `created for it.`,
        retryable: false,
      },
    }
  }
  if (acct.identifier.trim().toLowerCase() !== emailAddress.trim().toLowerCase()) {
    return {
      error: {
        code: "inbox_account_email_mismatch",
        message:
          `emailAddress "${emailAddress}" does not match the connected account's mailbox ` +
          `"${acct.identifier}". A tickets inbox must use the SAME address as the mail account it ` +
          `binds to — do NOT create an inbox labelled with one address while pointing it at a ` +
          `different connected mailbox. To onboard "${emailAddress}" as a shared inbox, first connect ` +
          `that mailbox on a Connect card (kernel__request_secret kind oauth_connect, app mail, ` +
          `connection gmail, mode org); once it is connected, create the inbox for it.`,
        retryable: false,
      },
    }
  }
  const isDefaultForCreate = params.isDefaultForCreate === true
  try {
    if (isDefaultForCreate) {
      return await tx.transaction(async (trx) => {
        const inserted = await trx.execute(drizzleSql`
          INSERT INTO ${ticketsRel("inboxes")} (
            id, org_id, connected_account_id, name, email_address, default_team, default_audience, default_sensitivity, from_display_name,
            reply_to_email, signature_html, signature_text, ack_enabled, ack_body_text, sla_promise_phrase,
            suppress_attention, notify_new_ticket, sla_exempt, is_default_for_create, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${orgId}::uuid, ${connectedAccountId}::uuid, ${name}, ${emailAddress},
            ${(params.defaultTeam as string | null) ?? null},
            ${(params.defaultAudience as string | null) ?? null},
            ${(params.defaultSensitivity as string | null) ?? null},
            ${(params.fromDisplayName as string | null) ?? null},
            ${(params.replyToEmail as string | null) ?? null},
            ${(params.signatureHtml as string | null) ?? null},
            ${(params.signatureText as string | null) ?? null},
            ${params.ackEnabled === false ? false : true},
            ${(params.ackBodyText as string | null) ?? null},
            ${(params.slaPromisePhrase as string | null) ?? "within 2 business days"},
            ${params.suppressAttention === true},
            ${params.notifyNewTicket === true},
            ${params.slaExempt === true},
            false,
            now(), now()
          )
          RETURNING id
        `)
        const insertedId = extractRows<{ id: string }>(inserted)[0]?.id
        if (!insertedId) {
          return {
            error: { code: "insert_failed", message: "inbox insert failed", retryable: false },
          }
        }
        await trx.execute(drizzleSql`
          UPDATE ${ticketsRel("inboxes")}
          SET is_default_for_create = CASE WHEN id = ${insertedId} THEN true ELSE false END,
              updated_at = now()
          WHERE org_id = ${orgId}
            AND (id = ${insertedId} OR is_default_for_create = true)
        `)
        const result = await trx.execute(drizzleSql`
          SELECT * FROM ${ticketsRel("inboxes")}
          WHERE org_id = ${orgId} AND id = ${insertedId}
          LIMIT 1
        `)
        const row = extractRows<Record<string, unknown>>(result)[0] ?? {}
        if (row.id) {
          await tryQueueEvent(trx, orgId, actor, "inbox", "create", String(row.id), {
            id: row.id,
            name,
            emailAddress,
            isDefaultForCreate: true,
          })
        }
        return row
      })
    }
    // Its own SAVEPOINT, like the default branch above: a unique violation (email taken) must
    // roll back only this insert, so the caller's transaction stays usable after the typed
    // inbox_email_taken answer below (a bare catch would leave it aborted, 25P02).
    return await tx.transaction(async (sp) => {
      const result = await sp.execute(drizzleSql`
        INSERT INTO ${ticketsRel("inboxes")} (
          id, org_id, connected_account_id, name, email_address, default_team, default_sensitivity, from_display_name,
          reply_to_email, signature_html, signature_text, ack_enabled, ack_body_text, sla_promise_phrase,
          suppress_attention, notify_new_ticket, sla_exempt, is_default_for_create, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}::uuid, ${connectedAccountId}::uuid, ${name}, ${emailAddress},
          ${(params.defaultTeam as string | null) ?? null},
          ${(params.defaultSensitivity as string | null) ?? null},
          ${(params.fromDisplayName as string | null) ?? null},
          ${(params.replyToEmail as string | null) ?? null},
          ${(params.signatureHtml as string | null) ?? null},
          ${(params.signatureText as string | null) ?? null},
          ${params.ackEnabled === false ? false : true},
          ${(params.ackBodyText as string | null) ?? null},
          ${(params.slaPromisePhrase as string | null) ?? "within 2 business days"},
          ${params.suppressAttention === true},
          ${params.notifyNewTicket === true},
          ${params.slaExempt === true},
          ${isDefaultForCreate},
          now(), now()
        )
        RETURNING *
      `)
      const row = extractRows<Record<string, unknown>>(result)[0] ?? {}
      if (row.id) {
        await tryQueueEvent(sp, orgId, actor, "inbox", "create", String(row.id), {
          id: row.id,
          name,
          emailAddress,
          isDefaultForCreate,
        })
      }
      return row
    })
  } catch (e: any) {
    const clash = inboxUniqueViolation(e)
    if (clash) {
      if (clash === "default") {
        return {
          error: {
            code: "default_inbox_conflict",
            message: "another inbox is already the default-for-create",
            retryable: false,
          },
        }
      }
      return {
        error: {
          code: "inbox_email_taken",
          message: "inbox email already in use",
          retryable: false,
        },
      }
    }
    throw e
  }
}

/**
 * Which of `app_tickets.inboxes`' two unique rules a write broke, or null when
 * `err` is not a unique violation. Reads the server's own message and the
 * constraint name, never Drizzle's `Failed query: <sql>` text: that text lists
 * every column, `is_default_for_create` included, so matching on it reported
 * every taken email as a default-for-create clash.
 * - UNIQUE (org_id, email_address): its name carries `email_address` both as
 *   migrated and as the per-worker LIKE clone regenerates it.
 * - the partial default-for-create index (`uniq_app_tickets_inboxes_org`, cloned
 *   as `inboxes_org_id_idx`): any other unique violation on this table.
 */
function inboxUniqueViolation(err: unknown): "email" | "default" | null {
  const facts = pgErrorFacts(err)
  if (facts?.code !== "23505") return null
  const text = `${facts.constraintName ?? ""} ${facts.message ?? ""}`
  return text.includes("email_address") ? "email" : "default"
}

/**
 * A reply-via pointer MUST resolve to a connected, non-archived mailbox inbox
 * in this org — it is the send transport for an API inbox's replies and
 * acknowledgements.
 *
 * Shared by create AND update on purpose. It lived only in the create path,
 * so `inboxesUpdate` would happily point a bucket at another api inbox, at an
 * archived one, or at a UUID that resolves to nothing. Nothing errored: the
 * reply simply dead-ended and the acknowledgement was never sent. A validation
 * that only guards the front door guards nothing.
 *
 * Returns an error envelope to hand straight back, or null when it is fine
 * (including when no pointer was supplied — clearing it is legitimate).
 */
async function validateReplyViaInbox(
  tx: SqlClient,
  orgId: string,
  replyViaInboxId: string | null,
): Promise<AdminResult | null> {
  if (replyViaInboxId == null) return null
  if (!UUID_RE.test(replyViaInboxId)) {
    return {
      error: {
        code: "invalid_params",
        message: "replyViaInboxId must be a UUID",
        retryable: false,
      },
    }
  }
  const rv = extractRows<{
    kind: string
    archived_at: Date | null
    connected_account_id: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT kind, archived_at, connected_account_id
      FROM ${ticketsRel("inboxes")}
      WHERE id = ${replyViaInboxId}::uuid AND org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )[0]
  if (!rv) {
    return {
      error: {
        code: "reply_via_not_found",
        message: "replyViaInboxId does not resolve to an inbox in this org",
        retryable: false,
      },
    }
  }
  if (rv.kind !== "mailbox" || !rv.connected_account_id) {
    return {
      error: {
        code: "reply_via_not_mailbox",
        message:
          "replyViaInboxId must be a connected mailbox inbox — it is the send transport for this API inbox's replies",
        retryable: false,
      },
    }
  }
  if (rv.archived_at) {
    return {
      error: {
        code: "reply_via_archived",
        message: "reply-via inbox is archived",
        retryable: false,
      },
    }
  }
  return null
}

// Create an API inbox: a receiving bucket with NO connected mail account. It
// never sends on its own — replies to its tickets go out through a reply-via
// mailbox (`replyViaInboxId`, else the org's default-for-create mailbox), so an
// org keeps a single reply-from identity (e.g. support@) across every bucket.
// `replyFromEmail` is an optional per-source From override.
async function inboxesCreateApi(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
  name: string,
): Promise<AdminResult> {
  const replyFromEmail = (params.replyFromEmail as string | null) ?? null
  const replyViaInboxId = (params.replyViaInboxId as string | null) ?? null

  const replyViaError = await validateReplyViaInbox(tx, orgId, replyViaInboxId)
  if (replyViaError) return replyViaError

  const result = await tx.execute(drizzleSql`
    INSERT INTO ${ticketsRel("inboxes")} (
      id, org_id, kind, connected_account_id, name, email_address,
      default_team, default_sensitivity, from_display_name,
      reply_via_inbox_id, reply_from_email, reply_to_email,
      signature_html, signature_text, ack_enabled, ack_body_text, sla_promise_phrase,
      suppress_attention, notify_new_ticket, sla_exempt, is_default_for_create, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), ${orgId}::uuid, 'api', NULL, ${name}, NULL,
      ${(params.defaultTeam as string | null) ?? null},
      ${(params.defaultSensitivity as string | null) ?? null},
      ${(params.fromDisplayName as string | null) ?? null},
      ${replyViaInboxId}::uuid, ${replyFromEmail},
      ${(params.replyToEmail as string | null) ?? null},
      ${(params.signatureHtml as string | null) ?? null},
      ${(params.signatureText as string | null) ?? null},
      ${params.ackEnabled === false ? false : true},
      ${(params.ackBodyText as string | null) ?? null},
      ${(params.slaPromisePhrase as string | null) ?? "within 2 business days"},
      ${params.suppressAttention === true},
      ${params.notifyNewTicket === true},
      ${params.slaExempt === true},
      false,
      now(), now()
    )
    RETURNING *
  `)
  const row = extractRows<Record<string, unknown>>(result)[0] ?? {}
  if (row.id) {
    await tryQueueEvent(tx, orgId, actor, "inbox", "create", String(row.id), {
      id: row.id,
      name,
      kind: "api",
    })
  }
  return row
}

/**
 * The "close tickets when the customer stays silent" fields of an inbox
 * update. Switching it on (from off) stamps when and by whom, which is what
 * the job acts as and counts silences from; leaving it on keeps the stamp, so
 * saving other fields never resets the clock. Switching it off clears both.
 */
function closeSilentSets(
  params: Record<string, unknown>,
  actor: ActorRef,
  /** Whether the option is on already (then the stamp, and its person, stay). */
  wasOn: boolean,
):
  | { sets: ReturnType<typeof drizzleSql>[] }
  | { error: { code: string; message: string; retryable: boolean } } {
  const sets: ReturnType<typeof drizzleSql>[] = []
  const invalid = (message: string) => ({
    error: { code: "invalid_params", message, retryable: false },
  })
  for (const key of ["closeSilentNudgeDays", "closeSilentCloseDays"] as const) {
    if (!(key in params)) continue
    const v = params[key]
    if (
      typeof v !== "number" ||
      !Number.isInteger(v) ||
      v < CLOSE_SILENT_MIN_DAYS ||
      v > CLOSE_SILENT_MAX_DAYS
    ) {
      return invalid(
        `${key} is a whole number of days from ${CLOSE_SILENT_MIN_DAYS} to ${CLOSE_SILENT_MAX_DAYS}`,
      )
    }
  }
  if ("closeSilentNudgeDays" in params)
    sets.push(drizzleSql`close_silent_nudge_days = ${params.closeSilentNudgeDays as number}`)
  if ("closeSilentCloseDays" in params)
    sets.push(drizzleSql`close_silent_close_days = ${params.closeSilentCloseDays as number}`)
  if ("closeSilentNudgeText" in params) {
    const raw = params.closeSilentNudgeText
    if (raw !== null && typeof raw !== "string")
      return invalid("closeSilentNudgeText is text or null")
    const text = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null
    if (text && text.length > CLOSE_SILENT_MAX_TEXT) {
      return invalid(`closeSilentNudgeText is at most ${CLOSE_SILENT_MAX_TEXT} characters`)
    }
    sets.push(drizzleSql`close_silent_nudge_text = ${text}`)
  }
  if (params.closeSilentEnabled === true) {
    const by = UUID_RE.test(actor.userId) ? actor.userId : null
    if (!by) return invalid("closeSilentEnabled can only be switched on by a person")
    // The job nudges and closes as whoever switches it on.
    if (!wasOn && !canActForCloseSilent(actor.scopes)) {
      return {
        error: {
          code: "forbidden",
          message:
            "Only someone allowed to reply to and close tickets can switch on closing silent tickets: the nudges and closes are made with their permissions.",
          retryable: false,
        },
      }
    }
    sets.push(
      drizzleSql`close_silent_enabled_at = CASE WHEN close_silent_enabled THEN close_silent_enabled_at ELSE now() END`,
      drizzleSql`close_silent_enabled_by = CASE WHEN close_silent_enabled THEN close_silent_enabled_by ELSE ${by}::uuid END`,
      drizzleSql`close_silent_enabled = true`,
    )
  } else if (params.closeSilentEnabled === false) {
    sets.push(
      drizzleSql`close_silent_enabled = false`,
      drizzleSql`close_silent_enabled_at = NULL`,
      drizzleSql`close_silent_enabled_by = NULL`,
    )
  }
  return { sets }
}

async function closeSilentIsOn(tx: SqlClient, orgId: string, inboxId: string): Promise<boolean> {
  const [row] = extractRows<{ on: boolean }>(
    await tx.execute(drizzleSql`
      SELECT close_silent_enabled AS on FROM ${ticketsRel("inboxes")}
      WHERE id = ${inboxId} AND org_id = ${orgId}`),
  )
  return row?.on === true
}

async function inboxesUpdate(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const id = params.id as string
  if (!id) return { error: { code: "invalid_params", message: "id required", retryable: false } }
  const sets: ReturnType<typeof drizzleSql>[] = []
  if (typeof params.name === "string") sets.push(drizzleSql`name = ${params.name}`)
  if ("defaultTeam" in params)
    sets.push(drizzleSql`default_team = ${(params.defaultTeam as string | null) ?? null}`)
  if ("defaultAudience" in params)
    sets.push(drizzleSql`default_audience = ${(params.defaultAudience as string | null) ?? null}`)
  if ("defaultSensitivity" in params)
    sets.push(
      drizzleSql`default_sensitivity = ${(params.defaultSensitivity as string | null) ?? null}`,
    )
  if ("fromDisplayName" in params)
    sets.push(drizzleSql`from_display_name = ${(params.fromDisplayName as string | null) ?? null}`)
  if ("replyViaInboxId" in params) {
    // Same guard as create: an unvalidated pointer here is a silently broken
    // send transport, not an error anyone sees.
    const replyViaError = await validateReplyViaInbox(
      tx,
      orgId,
      (params.replyViaInboxId as string | null) ?? null,
    )
    if (replyViaError) return replyViaError
    sets.push(
      drizzleSql`reply_via_inbox_id = ${(params.replyViaInboxId as string | null) ?? null}::uuid`,
    )
  }
  if ("replyFromEmail" in params)
    sets.push(drizzleSql`reply_from_email = ${(params.replyFromEmail as string | null) ?? null}`)
  if ("replyToEmail" in params)
    sets.push(drizzleSql`reply_to_email = ${(params.replyToEmail as string | null) ?? null}`)
  if ("signatureHtml" in params)
    sets.push(drizzleSql`signature_html = ${(params.signatureHtml as string | null) ?? null}`)
  if ("signatureText" in params)
    sets.push(drizzleSql`signature_text = ${(params.signatureText as string | null) ?? null}`)
  if ("ackEnabled" in params)
    sets.push(drizzleSql`ack_enabled = ${params.ackEnabled === false ? false : true}`)
  if ("ackBodyText" in params)
    sets.push(drizzleSql`ack_body_text = ${(params.ackBodyText as string | null) ?? null}`)
  if ("slaPromisePhrase" in params)
    sets.push(
      drizzleSql`sla_promise_phrase = ${(params.slaPromisePhrase as string | null) ?? "within 2 business days"}`,
    )
  if ("suppressAttention" in params)
    sets.push(drizzleSql`suppress_attention = ${params.suppressAttention === true}`)
  if ("notifyNewTicket" in params)
    sets.push(drizzleSql`notify_new_ticket = ${params.notifyNewTicket === true}`)
  if ("slaExempt" in params) sets.push(drizzleSql`sla_exempt = ${params.slaExempt === true}`)
  if ("attentionCutoffAt" in params)
    sets.push(
      drizzleSql`attention_cutoff_at = ${(params.attentionCutoffAt as string | null) ?? null}::timestamptz`,
    )
  const closeSilent = closeSilentSets(
    params,
    actor,
    params.closeSilentEnabled === true && (await closeSilentIsOn(tx, orgId, id)),
  )
  if ("error" in closeSilent) return closeSilent
  sets.push(...closeSilent.sets)
  const isSettingDefault = "isDefaultForCreate" in params && params.isDefaultForCreate === true
  // `"isDefaultForCreate" in params` is true even when the caller passed the
  // key with value `undefined` (trivial with an object literal spread such as
  // `{ isDefaultForCreate: cfg?.default === true }`), which used to silently
  // CLEAR the flag. Only emit the SET when the caller actually supplied a
  // boolean.
  if (params.isDefaultForCreate !== undefined)
    sets.push(drizzleSql`is_default_for_create = ${isSettingDefault}`)
  if (params.isDefaultForCreate === false) {
    // Explicit clear guard: refuse to un-set the org's only live default. The
    // partial unique index already guarantees at most one row per org can
    // carry is_default_for_create = true, so "target is the org's only live
    // default" is just "target currently carries the flag and is not
    // archived" -- and the target itself, being that row, is always an
    // eligible (mailbox, non-archived) inbox, so there is always at least one
    // eligible inbox left in play. Without this guard the write would
    // succeed and the DB trigger (0046) would silently snap the flag back
    // onto whichever inbox is oldest, possibly not the one the caller wanted.
    const targetIsLiveDefault =
      extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          SELECT id FROM ${ticketsRel("inboxes")}
          WHERE org_id = ${orgId} AND id = ${id}
            AND is_default_for_create = true AND archived_at IS NULL
          LIMIT 1
        `),
      ).length > 0
    if (targetIsLiveDefault) {
      return {
        error: {
          code: "default_inbox_required",
          message:
            "This inbox cannot be un-set as the default while it is the org's only default. " +
            "Submitted tickets would have nowhere to land and would be rejected. To change it, " +
            "set another inbox as the default instead: that moves the flag atomically.",
          retryable: false,
        },
      }
    }
  }
  if (sets.length === 0) return { id }
  sets.push(drizzleSql`updated_at = now()`)
  const setClause = drizzleSql.join(sets, drizzleSql.raw(", "))
  try {
    if (isSettingDefault) {
      return await tx.transaction(async (trx) => {
        const target = await trx.execute(drizzleSql`
          SELECT id FROM ${ticketsRel("inboxes")}
          WHERE id = ${id} AND org_id = ${orgId}
          LIMIT 1
        `)
        if (extractRows(target).length === 0) {
          return {
            error: { code: "not_found", message: "inbox not found", retryable: false },
          }
        }
        await trx.execute(drizzleSql`
          UPDATE ${ticketsRel("inboxes")}
          SET is_default_for_create = false, updated_at = now()
          WHERE org_id = ${orgId} AND id <> ${id} AND is_default_for_create = true
        `)
        const result = await trx.execute(drizzleSql`
          UPDATE ${ticketsRel("inboxes")} SET ${setClause}
          WHERE id = ${id} AND org_id = ${orgId}
          RETURNING id
        `)
        if (extractRows(result).length === 0) {
          return {
            error: { code: "not_found", message: "inbox not found", retryable: false },
          }
        }
        return { id }
      })
    }
    const result = await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("inboxes")} SET ${setClause}
      WHERE id = ${id} AND org_id = ${orgId}
      RETURNING id
    `)
    if (extractRows(result).length === 0) {
      return { error: { code: "not_found", message: "inbox not found", retryable: false } }
    }
  } catch (e: any) {
    // Only the default-for-create clash is answered, and it can only come from the
    // savepointed branch above, so the caller's transaction is still usable.
    if (inboxUniqueViolation(e) === "default") {
      return {
        error: {
          code: "default_inbox_conflict",
          message: "another inbox is already the default-for-create",
          retryable: false,
        },
      }
    }
    throw e
  }
  await tryQueueEvent(tx, orgId, actor, "inbox", "update", id, { id })
  return { id }
}

async function inboxesDisconnect(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const id = params.id as string
  if (!id) return { error: { code: "invalid_params", message: "id required", retryable: false } }
  const archived = extractRows<{ connected_account_id: string | null }>(
    await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("inboxes")} SET archived_at = now(), updated_at = now()
      WHERE id = ${id} AND org_id = ${orgId}
      RETURNING connected_account_id::text AS connected_account_id
    `),
  )[0]
  await tryQueueEvent(tx, orgId, actor, "inbox", "disconnect", id, { id })
  const connectedAccountId = archived?.connected_account_id ?? null
  if (connectedAccountId) {
    await releaseInboxConnection(tx, orgId, id, connectedAccountId, actor)
  }
  return { id, disconnected: true }
}

/**
 * The mailbox connection behind a disconnected inbox goes too, once no live
 * inbox uses it: its grant is revoked at the provider and its tokens deleted
 * (connections service). The tickets and their messages stay: they are the
 * team's records. Runs privileged, as the connection is org-owned and invisible
 * to the caller's RLS context. Best effort: the inbox is archived either way.
 */
async function releaseInboxConnection(
  tx: SqlClient,
  orgId: string,
  inboxId: string,
  connectedAccountId: string,
  actor: ActorRef,
): Promise<void> {
  const stillUsed = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${ticketsRel("inboxes")}
      WHERE org_id = ${orgId} AND connected_account_id = ${connectedAccountId}::uuid
        AND archived_at IS NULL AND id <> ${inboxId}::uuid
      LIMIT 1
    `),
  )
  if (stillUsed.length > 0) return
  try {
    const { disconnectConnection } = await import("~/modules/apps/connections/service")
    await withPrivilegedDb(orgId, "tickets-inbox-disconnect", async (ptx) => {
      const live = extractRows<{ id: string }>(
        await ptx.execute(drizzleSql`
          SELECT id::text AS id FROM ${kernelRel("connected_accounts")}
          WHERE org_id = ${orgId}::uuid AND id = ${connectedAccountId}::uuid
            AND app_name = 'tickets' AND status <> 'disconnected'
        `),
      )
      if (live.length === 0) return
      await disconnectConnection(ptx, orgId, actor.userId, connectedAccountId)
    })
    // Committed: stop the push watch and revoke the grant at the provider (never throws).
    const { runConnectionTeardown } = await import("~/modules/apps/connections/revoke")
    await runConnectionTeardown(connectedAccountId)
  } catch (err) {
    log.warn(
      { orgId, inboxId, connectedAccountId, err: (err as Error).message },
      "tickets inbox disconnect: could not disconnect the mailbox connection",
    )
  }
}

// Move one or more tickets into a different inbox (routing bucket). The target
// inbox's connected account (NULL for an API inbox) is copied onto the ticket's
// source_account_id so the reply path resolves the right send transport. Org-
// scoped in SQL, so a ticket id from another org simply matches nothing.
async function ticketsMove(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const toInboxId = params.toInboxId as string
  const rawIds = params.ticketIds
  const ticketIds =
    Array.isArray(rawIds) && rawIds.length > 0
      ? rawIds.map((v) => String(v))
      : typeof params.ticketId === "string"
        ? [params.ticketId]
        : []
  if (!toInboxId || ticketIds.length === 0) {
    return {
      error: {
        code: "invalid_params",
        message: "toInboxId and ticketIds (or ticketId) required",
        retryable: false,
      },
    }
  }
  if (!UUID_RE.test(toInboxId)) {
    return {
      error: { code: "invalid_params", message: "toInboxId must be a UUID", retryable: false },
    }
  }
  for (const id of ticketIds) {
    if (!UUID_RE.test(id)) {
      return {
        error: {
          code: "invalid_params",
          message: `ticketId "${id}" must be a UUID`,
          retryable: false,
        },
      }
    }
  }
  const target = extractRows<{ archived_at: Date | null; connected_account_id: string | null }>(
    await tx.execute(drizzleSql`
      SELECT archived_at, connected_account_id
      FROM ${ticketsRel("inboxes")}
      WHERE id = ${toInboxId}::uuid AND org_id = ${orgId}::uuid
      LIMIT 1
    `),
  )[0]
  if (!target) {
    return { error: { code: "not_found", message: "target inbox not found", retryable: false } }
  }
  if (target.archived_at) {
    return {
      error: { code: "archived_inbox", message: "target inbox is archived", retryable: false },
    }
  }
  const moved: string[] = []
  for (const id of ticketIds) {
    const res = await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("tickets")}
      SET source_inbox_id = ${toInboxId}::uuid,
          source_account_id = ${target.connected_account_id}::uuid,
          updated_at = now()
      WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid
      RETURNING id
    `)
    const row = extractRows<{ id: string }>(res)[0]
    if (row) {
      moved.push(row.id)
      // The display handle follows the inbox when the org segments by inbox.
      const handle = await displayHandleFor(tx, orgId, row.id)
      await tryQueueEvent(tx, orgId, actor, "ticket", "move", row.id, {
        id: row.id,
        toInboxId,
        ...(handle ? { handle } : {}),
      })
      // `move` is not an indexer action: an `update` (outbox, after commit)
      // re-indexes the ticket's search document with its new inbox and
      // display handle, and live clients read the same shape as setTeam's.
      await tryQueueEvent(tx, orgId, actor, "ticket", "update", row.id, {
        ticketId: row.id,
        ...(handle ? { handle } : {}),
        changes: { sourceInboxId: toInboxId, ...(handle ? { handle } : {}) },
      })
    }
  }
  return { moved, count: moved.length }
}

/** What a ticket numbered 123 displays as, per code, so a caller can check the
 *  config reads the way it meant before customers see it in subjects. */
function segmentExamples(cfg: TicketIdSegment): Record<string, string> {
  if (cfg.by === "none") return { any: formatTicketHandle(123) }
  return {
    ...Object.fromEntries(
      Object.entries(cfg.codes).map(([k, c]) => [k, formatTicketHandle(123, c)]),
    ),
    withoutCode: formatTicketHandle(123),
  }
}

// The ticket-id prefix (settings.tickets.idSegment). The tool manifest already
// requires tickets:settings:admin; the op re-checks it because runAdminOp is
// reachable from other callers (the CLI, tests) that bypass the manifest.
async function idSegmentOp(
  op: "idSegmentGet" | "idSegmentSet" | "idSegmentSetPreflight",
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  if (!hasScope("tickets:settings:admin", actor.scopes ?? [])) {
    return {
      error: {
        code: "forbidden",
        message: "missing scope: tickets:settings:admin",
        retryable: false,
      },
    }
  }
  if (op === "idSegmentGet") {
    const cfg = await loadSegmentConfig(orgId)
    const examples = segmentExamples(cfg)
    // `rows`: one per example (`key` = the field's value, its `code` and the `example` handle),
    // the list a dashboard block reads.
    const rows = Object.entries(examples).map(([key, example]) => ({
      key,
      code: cfg.codes[key] ?? null,
      example,
    }))
    return { idSegment: cfg, examples, rows }
  }
  const parsed = ticketIdSegmentSchema.safeParse({ by: params.by, codes: params.codes ?? {} })
  if (!parsed.success) {
    return {
      error: {
        code: "invalid_id_segment",
        message: parsed.error.issues
          .map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`)
          .join("; "),
        retryable: false,
      },
    }
  }
  if (op === "idSegmentSetPreflight") return { ok: true }
  const reindexed = await saveSegmentConfig(orgId, parsed.data, actor.userId)
  return { idSegment: parsed.data, examples: segmentExamples(parsed.data), reindexed }
}

/**
 * Write `settings.tickets.approveRepliesFromHome`, merged into settings.tickets
 * so its sibling keys (idSegment, sla, ...) stay as they are. Returns the
 * stored settings when the value changed, null when it already held. Shared by
 * the `approveFromHome.set` tool and the CLI provisioner.
 */
export async function writeApproveRepliesFromHome(
  tx: PrivilegedDb,
  orgId: string,
  value: boolean,
): Promise<{ settings: unknown } | null> {
  const row = extractRows<{ settings: unknown }>(
    await tx.execute(drizzleSql`
      UPDATE ${kernelRel("organizations")}
      SET settings = jsonb_set(
            COALESCE(settings, '{}'::jsonb),
            '{tickets}',
            COALESCE(settings->'tickets', '{}'::jsonb)
              || jsonb_build_object('approveRepliesFromHome', ${value}::boolean),
            true
          ),
          updated_at = now()
      WHERE id = ${orgId}::uuid
        AND (settings->'tickets'->'approveRepliesFromHome') IS DISTINCT FROM to_jsonb(${value}::boolean)
      RETURNING settings
    `),
  )[0]
  return row ?? null
}

// Whether a pending ticket reply may be decided from its Home card
// (settings.tickets.approveRepliesFromHome, absent = off). Same authority as
// the settings page (PATCH /org needs tickets:settings:admin), re-checked here
// for the callers of runAdminOp that bypass the manifest.
async function approveFromHomeOp(
  op: "approveFromHomeGet" | "approveFromHomeSet" | "approveFromHomeSetPreflight",
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  if (!hasScope("tickets:settings:admin", actor.scopes ?? [])) {
    return {
      error: {
        code: "forbidden",
        message: "missing scope: tickets:settings:admin",
        retryable: false,
      },
    }
  }
  if (op === "approveFromHomeGet") {
    const settings = await withPrivilegedDb(orgId, "tickets-approve-from-home", async (tx) => {
      const row = extractRows<{ settings: unknown }>(
        await tx.execute(drizzleSql`
          SELECT settings FROM ${kernelRel("organizations")} WHERE id = ${orgId}::uuid LIMIT 1
        `),
      )[0]
      return row?.settings
    })
    // `{ enabled }` both ways: the settings page binds this pair as one toggle
    // (the get's answer, changed, is the set's params).
    return { enabled: ticketsApproveRepliesFromHome(settings) }
  }
  if (typeof params.enabled !== "boolean") {
    return {
      error: {
        code: "invalid_params",
        message: "enabled must be true or false",
        retryable: false,
      },
    }
  }
  if (op === "approveFromHomeSetPreflight") return { ok: true }
  const enabled = params.enabled
  await withPrivilegedDb(orgId, "tickets-approve-from-home-set", async (tx) => {
    const changed = await writeApproveRepliesFromHome(tx, orgId, enabled)
    if (!changed) return
    // The org route's update event, so an open settings page or Home follows.
    await tx.queueEvent({
      app: "kernel",
      entity: "org",
      action: "update",
      entityId: orgId,
      orgId,
      actorId: actor.userId,
      data: { settings: changed.settings },
    })
  })
  return { enabled }
}

// The keys that still work: a revoked key no longer authenticates, so it leaves
// the list (its row stays for history).
async function apiKeysList(tx: SqlClient, orgId: string): Promise<AdminResult> {
  const result = await tx.execute(drizzleSql`
    SELECT id, key_prefix, label, allowed_origins, inbox_id, last_used_at, created_at
    FROM ${ticketsRel("api_keys")}
    WHERE org_id = ${orgId} AND revoked_at IS NULL
    ORDER BY created_at DESC
  `)
  return extractRows<Record<string, unknown>>(result)
}

async function apiKeysCreate(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
  actor: ActorRef,
): Promise<AdminResult> {
  const label = params.label as string
  if (actor.actorType !== "user") {
    return {
      error: {
        code: "forbidden",
        message: "API keys can only be created by a signed in user, not by an agent or MCP session",
        retryable: false,
      },
    }
  }
  if (!label) {
    return { error: { code: "invalid_params", message: "label required", retryable: false } }
  }
  const key = base32Token(20)
  const keyPrefix = key.slice(0, 8)
  const keyHash = createHash("sha256").update(key).digest("hex")
  // A list, or one string of origins separated by commas, spaces or new lines
  // (the settings page's create form is one text field).
  const rawOrigins = params.allowedOrigins
  const allowedOrigins = (
    typeof rawOrigins === "string"
      ? rawOrigins.split(/[\s,]+/)
      : Array.isArray(rawOrigins)
        ? rawOrigins.filter((o): o is string => typeof o === "string")
        : []
  )
    .map((o) => o.trim())
    .filter(Boolean)
  // Optionally scope the key to a single inbox: a scoped key can ONLY create
  // tickets in that inbox (enforced in the public ingest handler). This is what
  // makes a per-inbox endpoint a self-contained, independently-revocable
  // credential -- e.g. one key per external tenant endpoint.
  const inboxId = (params.inboxId as string | null) ?? null
  if (inboxId != null) {
    if (!UUID_RE.test(inboxId)) {
      return {
        error: { code: "invalid_params", message: "inboxId must be a UUID", retryable: false },
      }
    }
    const exists = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id FROM ${ticketsRel("inboxes")}
        WHERE id = ${inboxId}::uuid AND org_id = ${orgId}::uuid AND archived_at IS NULL
        LIMIT 1
      `),
    )[0]
    if (!exists) {
      return {
        error: {
          code: "inbox_not_found",
          message: "inboxId does not resolve to an inbox in this org",
          retryable: false,
        },
      }
    }
  }
  const result = await tx.execute(drizzleSql`
    INSERT INTO ${ticketsRel("api_keys")} (
      id, org_id, key_hash, key_prefix, label, allowed_origins, inbox_id, created_by, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), ${orgId}, ${keyHash}, ${keyPrefix}, ${label},
      ${JSON.stringify(allowedOrigins)}::jsonb, ${inboxId}::uuid, ${actor.userId}, now(), now()
    )
    RETURNING id
  `)
  const id = extractRows<{ id: string }>(result)[0]!.id
  return { id, label, key, keyPrefix, inboxId }
}

async function apiKeysRevoke(
  tx: SqlClient,
  orgId: string,
  params: Record<string, unknown>,
): Promise<AdminResult> {
  const id = params.id as string
  if (!id) return { error: { code: "invalid_params", message: "id required", retryable: false } }
  await tx.execute(drizzleSql`
    UPDATE ${ticketsRel("api_keys")} SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
    WHERE id = ${id} AND org_id = ${orgId}
  `)
  return { id, revoked: true }
}
