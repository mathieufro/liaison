// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql as drizzleSql } from "drizzle-orm"
import { displayHandleFor, loadSegmentConfig } from "~/apps/tickets/display-handle"
import type { PrivilegedReadOptions } from "~/apps/tickets/privileged-read"
import { resolveTicketRef } from "~/apps/tickets/resolve-ticket-ref"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import type { ClosedReason, CurrentTicketState, TicketStatus } from "~/apps/tickets/state-machine"
import { applyEffects, validateTransition } from "~/apps/tickets/state-machine"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"
import { cancelApprovalsForSourceTicket, TICKET_MERGED_REASON } from "~/modules/approvals/cancel"
import { repointThreadAnchors } from "~/modules/threads/thread-anchor"

type SqlClient = RlsClient | RlsTx | PrivilegedDb

interface MergeParams {
  targetTicketId: string
  sourceTicketIds: string[]
  note?: string
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
}

interface TicketRow {
  id: string
  handle: string
  status: TicketStatus
  closed_reason: ClosedReason | null
  merged_into_ticket_id: string | null
  converted_to_mail_conversation_id: string | null
  first_response_at: string | Date | null
  message_count: number | null
}

async function fetchTicket(
  tx: SqlClient,
  orgId: string,
  ticketId: string,
): Promise<TicketRow | null> {
  const result = await tx.execute(drizzleSql`
    SELECT id, handle, status, closed_reason, merged_into_ticket_id, converted_to_mail_conversation_id, first_response_at, message_count
    FROM ${ticketsRel("tickets")}
    WHERE id = ${ticketId} AND org_id = ${orgId}
    LIMIT 1
  `)
  return extractRows<TicketRow>(result)[0] ?? null
}

function toCurrentState(row: TicketRow): CurrentTicketState {
  return {
    status: row.status,
    closedReason: row.closed_reason,
    mergedIntoTicketId: row.merged_into_ticket_id,
    convertedToMailConversationId: row.converted_to_mail_conversation_id,
    firstResponseAt:
      row.first_response_at instanceof Date
        ? row.first_response_at.toISOString()
        : row.first_response_at,
  }
}

export async function mergeTickets(
  tx: SqlClient,
  orgId: string,
  params: MergeParams,
  actor: ActorRef,
  // A caller inside a privileged transaction passes it (privileged-read.ts).
  opts: PrivilegedReadOptions = {},
): Promise<
  | { targetTicketId: string; mergedSourceCount: number; copiedMessageCount: number }
  | { error: { code: string; message: string; retryable: boolean } }
> {
  if (!params.targetTicketId || !Array.isArray(params.sourceTicketIds)) {
    return {
      error: {
        code: "invalid_params",
        message: "targetTicketId and sourceTicketIds required",
        retryable: false,
      },
    }
  }
  // Every id may be a uuid or a handle in any display form (`ticket-12`,
  // `ticket-B2B-12`, a stale segment): resolve them all to uuids up front, so
  // a handle never reaches a uuid column.
  const targetRef = await resolveTicketRef(tx, orgId, params.targetTicketId)
  if (!targetRef.ok) {
    return {
      error: {
        ...targetRef.error,
        message:
          targetRef.error.code === "not_found"
            ? "target ticket not found"
            : targetRef.error.message,
      },
    }
  }
  const sourceIds: string[] = []
  for (const raw of params.sourceTicketIds) {
    const ref = await resolveTicketRef(tx, orgId, raw)
    if (!ref.ok) {
      return {
        error: {
          ...ref.error,
          message: ref.error.code === "not_found" ? `source ${raw} not found` : ref.error.message,
        },
      }
    }
    sourceIds.push(ref.ticketId)
  }
  params = { ...params, targetTicketId: targetRef.ticketId, sourceTicketIds: sourceIds }

  if (params.sourceTicketIds.includes(params.targetTicketId)) {
    return {
      error: {
        code: "merge_self_reference",
        message: "target cannot be in sourceTicketIds",
        retryable: false,
      },
    }
  }

  const target = await fetchTicket(tx, orgId, params.targetTicketId)
  if (!target) {
    return { error: { code: "not_found", message: "target ticket not found", retryable: false } }
  }
  const targetValidation = validateTransition(toCurrentState(target), {
    kind: "merge",
    target: true,
  })
  if (!targetValidation.ok) {
    return {
      error: { code: targetValidation.code, message: targetValidation.message, retryable: false },
    }
  }

  // The timeline and the merge event name the target by its display handle.
  const targetDisplay =
    (await displayHandleFor(
      tx,
      orgId,
      params.targetTicketId,
      opts.privilegedTx ? await loadSegmentConfig(orgId, opts.privilegedTx) : undefined,
    )) ?? target.handle

  let totalMessageCount = 0
  for (const sourceId of params.sourceTicketIds) {
    const source = await fetchTicket(tx, orgId, sourceId)
    if (!source) {
      return {
        error: { code: "not_found", message: `source ${sourceId} not found`, retryable: false },
      }
    }
    const validation = validateTransition(toCurrentState(source), { kind: "merge", target: false })
    if (!validation.ok) {
      return { error: { code: validation.code, message: validation.message, retryable: false } }
    }

    // Guarded UPDATE — set merged_into_ticket_id atomically, fail if already merged
    const guardResult = await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("tickets")}
      SET merged_into_ticket_id = ${params.targetTicketId}, updated_at = now()
      WHERE id = ${sourceId} AND org_id = ${orgId} AND merged_into_ticket_id IS NULL
      RETURNING id
    `)
    if (extractRows(guardResult).length === 0) {
      return {
        error: {
          code: "ticket_already_merged",
          message: "source was concurrently merged",
          retryable: false,
        },
      }
    }

    // Copy the source ticket's messages onto the target. external_message_id is set to NULL on the
    // COPY (not carried over): app_tickets.messages has a partial UNIQUE (org_id, external_message_id)
    // WHERE external_message_id IS NOT NULL, and the source row keeps its synced id — copying it would
    // duplicate the pair and abort the merge with a unique violation. This only ever bit MAIL-CONVERTED
    // tickets (whose messages carry the mail's external_message_id); native tickets have NULL and never
    // conflicted. The copy is a merge artifact, not the canonical synced message, so NULL is correct.
    const copiedResult = await tx.execute(drizzleSql`
      INSERT INTO ${ticketsRel("messages")} (
        id, org_id, ticket_id, kind, from_email, from_name, to_emails, cc_emails, subject,
        html_body, text_body, snippet, external_message_id, in_reply_to, header_references,
        sent_at, created_by, created_at, updated_at, received_at, sender_auth
      )
      SELECT gen_random_uuid(), org_id, ${params.targetTicketId}, kind, from_email, from_name,
        to_emails, cc_emails, subject, html_body, text_body, snippet, NULL,
        in_reply_to, header_references, sent_at, created_by, now(), now(), received_at, sender_auth
      FROM ${ticketsRel("messages")}
      WHERE ticket_id = ${sourceId} AND org_id = ${orgId}
      RETURNING id
    `)
    const copiedCount = extractRows(copiedResult).length
    totalMessageCount += copiedCount

    await applyEffects(
      tx,
      sourceId,
      {
        ...validation.effects,
        mergedIntoTicketId: params.targetTicketId,
        timelineDetails: {
          target: targetDisplay,
          targetHandle: targetDisplay,
          mergedMessageCount: copiedCount,
        },
      },
      {
        actorType: actor.actorType,
        auditActorType: actor.auditActorType,
        userId: actor.userId,
        orgId,
      },
      opts,
    )

    await cancelApprovalsForSourceTicket(
      tx,
      orgId,
      sourceId,
      TICKET_MERGED_REASON,
      undefined,
      opts.privilegedTx,
    )
    // A conversation made from the merged-away ticket now belongs to the one that survives.
    await repointThreadAnchors(
      orgId,
      { app: "tickets", entityType: "ticket", fromId: sourceId, toId: params.targetTicketId },
      opts.privilegedTx,
    )
  }

  // Apply target-side merge effects (timeline label "merged_in")
  await applyEffects(
    tx,
    params.targetTicketId,
    {
      ...targetValidation.effects,
      timelineDetails: { sources: params.sourceTicketIds },
    },
    {
      actorType: actor.actorType,
      auditActorType: actor.auditActorType,
      userId: actor.userId,
      orgId,
    },
    opts,
  )

  // Update target's message_count to include moved messages
  await tx.execute(drizzleSql`
    UPDATE ${ticketsRel("tickets")}
    SET message_count = COALESCE(message_count, 0) + ${totalMessageCount},
        last_message_at = (
          SELECT MAX(sent_at) FROM ${ticketsRel("messages")} WHERE ticket_id = ${params.targetTicketId} AND org_id = ${orgId}
        ),
        updated_at = now()
    WHERE id = ${params.targetTicketId} AND org_id = ${orgId}
  `)

  // The merged-in messages may include inbound ones newer than anything the
  // target already had — recompute last_inbound_at from the actual message
  // set (not just the copied batch) and, if the customer now holds the last
  // word on a non-terminally-closed target, reopen it through the state
  // machine so it reappears in needs-attention instead of staying silently
  // closed behind a merge.
  const targetInboundResult = await tx.execute(drizzleSql`
    UPDATE ${ticketsRel("tickets")}
    SET last_inbound_at = GREATEST(
          last_inbound_at,
          (
            SELECT MAX(sent_at) FROM ${ticketsRel("messages")}
            WHERE ticket_id = ${params.targetTicketId} AND org_id = ${orgId} AND kind = 'inbound'
          )
        ),
        updated_at = now()
    WHERE id = ${params.targetTicketId} AND org_id = ${orgId}
    RETURNING status, closed_reason, last_inbound_at, last_outbound_at
  `)
  const targetAfterInbound = extractRows<{
    status: TicketStatus
    closed_reason: ClosedReason | null
    last_inbound_at: string | Date | null
    last_outbound_at: string | Date | null
  }>(targetInboundResult)[0]
  if (targetAfterInbound && targetAfterInbound.status === "closed") {
    const terminal =
      targetAfterInbound.closed_reason === "merged" ||
      targetAfterInbound.closed_reason === "converted_to_mail"
    const lastInbound = targetAfterInbound.last_inbound_at
      ? new Date(targetAfterInbound.last_inbound_at).getTime()
      : -Infinity
    const lastOutbound = targetAfterInbound.last_outbound_at
      ? new Date(targetAfterInbound.last_outbound_at).getTime()
      : -Infinity
    if (!terminal && lastInbound > lastOutbound) {
      const { validateAndApply } = await import("~/apps/tickets/state-machine")
      await validateAndApply(
        tx,
        params.targetTicketId,
        { kind: "inbound" },
        { actorType: actor.actorType, userId: actor.userId, orgId },
        opts,
      )
    }
  }

  if (params.note) {
    const now = new Date().toISOString()
    const userId = actor.actorType === "user" ? actor.userId : null
    await tx.execute(drizzleSql`
      INSERT INTO ${ticketsRel("messages")} (
        id, org_id, ticket_id, kind, text_body, sent_at, created_by, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}, ${params.targetTicketId}, 'note', ${params.note}, ${now}, ${userId}, now(), now()
      )
    `)
    await tx.execute(drizzleSql`
      UPDATE ${ticketsRel("tickets")}
      SET message_count = COALESCE(message_count, 0) + 1, last_message_at = ${now}, updated_at = now()
      WHERE id = ${params.targetTicketId} AND org_id = ${orgId}
    `)
  }

  return {
    targetTicketId: params.targetTicketId,
    mergedSourceCount: params.sourceTicketIds.length,
    copiedMessageCount: totalMessageCount,
  }
}
