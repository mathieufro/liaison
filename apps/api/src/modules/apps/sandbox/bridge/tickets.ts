// SPDX-License-Identifier: FSL-1.1-ALv2

import { generateText } from "ai"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { quoteIdent } from "~/lib/sql-utils"
import { pgErrorFacts, retryOnTransientDbError } from "~/lib/transient-db-error"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import {
  ERROR_NOT_FOUND,
  envelopeError,
  toIso,
  withPgCause,
} from "~/modules/apps/sandbox/bridge/shared"

/** The tickets app surface: state machine, search, sync, summaries and Gmail push. */
export function createTicketsMethods(ctx: BridgeContext): Record<string, any> {
  const {
    actorType,
    appName,
    appTable,
    approvalContext,
    auditActorType,
    bridgeActingAgentId,
    bridgeRoutineId,
    callerScopes,
    dispatchRerouteAppend,
    inheritedActor,
    logger,
    orgId,
    requireApp,
    rpcBridge,
    summaryEnvelope,
    ticketsSchema,
    txDb,
    userId,
  } = ctx
  // Tool results go to a model when an agent or an MCP client is the reader.
  const readerIsModel = auditActorType === "agent" || auditActorType === "mcp"
  return {
    // --- Tickets-specific bridge methods (gated; only meaningful when appName === "tickets") ---
    tickets_validateAndApply: async (ticketId: string, inputJson: string): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_validateAndApply is only available to the tickets app")
      }
      const input = JSON.parse(inputJson)
      const { validateAndApply } = await import("~/apps/tickets/state-machine")
      const result = await validateAndApply(txDb as never, ticketId, input, {
        actorType: actorType as "user" | "agent" | "system" | "mcp",
        auditActorType,
        userId,
        orgId,
      })
      return JSON.stringify(result)
    },

    tickets_setPriority: async (ticketId: string, priority: string): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_setPriority is only available to the tickets app")
      }
      const { setPriorityAndRecompute } = await import("~/apps/tickets/state-machine")
      return JSON.stringify(
        await setPriorityAndRecompute(txDb as never, ticketId, priority, {
          actorType: actorType as "user" | "agent" | "system" | "mcp",
          auditActorType,
          userId,
          orgId,
        }),
      )
    },

    // Google Drive connector methods (`drive_search`/`drive_import`/`drive_export`)
    // are registered by the google-drive app as a bridge extension and merged into
    // its sandbox bridge below — they are not part of the generic kernel surface.

    tickets_search: async (paramsJson: string): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_search is only available to the tickets app")
      }
      const { searchTickets } = await import("~/apps/tickets/search")
      const { toCamelTicket } = await import("~/apps/tickets/projection")
      const { projectReadState } = await import("~/apps/tickets/read-state")
      const params = JSON.parse(paramsJson) as Record<string, unknown>
      // Inject actor userId so the self-scoped reads can resolve to the caller: smartFilter
      // 'my-backlog' (my assigned non-closed set), assignedTo:'me'/'self', and any call that did not
      // set actorUserId explicitly. Without this the routine tick — which runs AS its owner but does not
      // know its own UUID — could not scope "my tickets" and fell back to a whole-org read.
      if (
        userId &&
        (params.smartFilter === "my-backlog" ||
          params.smartFilter === "assigned-to-me" ||
          params.actorUserId === undefined)
      ) {
        params.actorUserId = userId
      }
      // Free-text matching (spec §3.5) resolves through the shared search
      // executor, which needs the REAL caller scopes/dimensionGrants/roleIds
      // — NOT an empty-grant placeholder. `inheritedActor` is exactly that:
      // it resolves to the real ActorContext execute-tool.ts threaded in via
      // bridgeOptions.actor for both the web-inbox tickets:search invocation
      // and cross-app/approval-gated dispatch (both paths already assign
      // bridgeOptions.actor: actorForRls before reaching this bridge). A
      // SYSTEM actor gets the wildcard dimension grant — parity with
      // resolveDimensionGrants (db/rls.ts), which gives SystemContext
      // `{"*":["*"]}` under RLS. Passing {} instead would make the Meili
      // filter emit `(NOT team EXISTS) AND (NOT sensitivity EXISTS)` and a
      // system-purpose text search would return zero tickets (every ticket
      // doc carries sensitivity), a silent regression from the SQL path. The
      // id-join re-select still runs under the same RLS tx either way, so
      // this widens nothing beyond what RLS already grants that actor.
      const searchActor = {
        userId: inheritedActor.actorType === "user" ? inheritedActor.userId : userId,
        scopes: callerScopes ?? [],
        dimensionGrants:
          inheritedActor.actorType === "user"
            ? (inheritedActor.dimensionGrants ?? {})
            : { "*": ["*"] },
        roleIds: inheritedActor.actorType === "user" ? (inheritedActor.roles ?? []) : [],
      }
      let raw: Awaited<ReturnType<typeof searchTickets>>
      try {
        raw = await searchTickets(txDb as never, orgId, params as never, searchActor)
      } catch (err) {
        // A thrown error crossing the sandbox boundary is flattened to its
        // bare `.message` (see executor.ts's installBridgeAndCtx catch handler) —
        // `status`/`code` do NOT survive a throw here. So a search-unavailable
        // condition must be RETURNED as the structured `{error:{code,message,
        // retryable,status}}` envelope instead (mirrors dispatchTransition's
        // `result.ok === false` handling above), which crosses intact as plain
        // JSON and execute-tool.ts's normalizeToolErrorResult picks up the
        // `status`/`code` from exactly that shape.
        const { TicketSearchUnavailableError } = await import("~/apps/tickets/search")
        if (err instanceof TicketSearchUnavailableError) {
          return JSON.stringify({
            error: { code: err.code, message: err.message, retryable: true, status: err.status },
          })
        }
        throw err
      }
      const ticketIds = raw.items.map((r) => String((r as Record<string, unknown>).id))
      const readState = await projectReadState(txDb as never, ticketIds)
      // Every row carries the display handle (`ticket-B2B-12`), computed from
      // its current segment field; one privileged config read per page.
      const { loadSegmentConfig } = await import("~/apps/tickets/display-handle")
      const segment = await loadSegmentConfig(orgId)
      const { wrapExternalContent } = await import("~/lib/external-content")
      const items = raw.items.map((r) => {
        const camel = toCamelTicket(r as Record<string, unknown>, segment)
        // The preview is the customer's own text. When an agent (or an MCP client)
        // is the reader, it is fenced as untrusted data; the web inbox reads it plain.
        if (readerIsModel && typeof camel.snippet === "string" && camel.snippet) {
          camel.snippet = wrapExternalContent(camel.snippet)
        }
        const proj = readState[camel.id]
        camel.unread = proj?.unread ?? false
        camel.readByCount = proj?.readByCount ?? 0
        camel.readByRecent = proj?.readByRecent ?? []
        return camel
      })
      return JSON.stringify({ items, nextCursor: raw.nextCursor, totalCount: raw.totalCount })
    },

    tickets_get: async (paramsJson: string): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_get is only available to the tickets app")
      }
      const { getTicket } = await import("~/apps/tickets/search")
      const { toCamelTicket, toCamelMessage, rewriteCidReferences } = await import(
        "~/apps/tickets/projection"
      )
      const { projectReadState } = await import("~/apps/tickets/read-state")
      const raw = await getTicket(txDb as never, orgId, JSON.parse(paramsJson))
      // A bad ticket ref (unknown handle, garbage id) comes back as a TYPED
      // tool error, not a thrown Postgres uuid-cast failure: pass it through.
      if ("error" in raw) {
        return JSON.stringify({ error: raw.error })
      }
      if (!raw.ticket) {
        return JSON.stringify({ ticket: null, messages: { items: [], nextCursor: null } })
      }
      const { loadSegmentConfig } = await import("~/apps/tickets/display-handle")
      const ticket = toCamelTicket(
        raw.ticket as Record<string, unknown>,
        await loadSegmentConfig(orgId),
      )
      const proj = (await projectReadState(txDb as never, [ticket.id]))[ticket.id]
      ticket.unread = proj?.unread ?? false
      ticket.readByCount = proj?.readByCount ?? 0
      ticket.readByRecent = proj?.readByRecent ?? []
      // Who the ticket is with (the customer card's key), by the same rule
      // and loader as the agent's customer context, under the caller's RLS.
      const { loadTicketParticipantEmail } = await import("~/apps/tickets/participants")
      ticket.participantEmail = await loadTicketParticipantEmail(txDb, orgId, ticket.id)
      // Composer prefill: the effective reply signature (inbox first, else the
      // viewer's own) so the reply box shows exactly what will be sent — the
      // send path appends nothing. Privileged read: the inbox row's signature
      // config may be RLS-hidden from non-admin agents, but the signature is
      // part of every outbound reply, so every composer must see it.
      let composeSignatureText: string | null = null
      if (userId) {
        const { loadEffectiveSignature } = await import("~/apps/tickets/tools")
        const { withPrivilegedDb } = await import("~/db/privileged")
        const sourceInboxId = (ticket as { sourceInboxId?: string | null }).sourceInboxId ?? null
        composeSignatureText = await withPrivilegedDb(orgId, "tickets-compose-signature", (ptx) =>
          loadEffectiveSignature(ptx as never, orgId, sourceInboxId, userId).then(
            (sig) => sig?.text ?? null,
          ),
        )
      }
      const { wrapExternalContent: fence } = await import("~/lib/external-content")
      const items = (raw.messages?.items ?? []).map((m) => {
        const camel = toCamelMessage(m as Record<string, unknown>)
        // A customer's message text is third-party content. Read by an agent or an
        // MCP client it is fenced as untrusted data (any fence tag inside it is
        // escaped); the web inbox gets it plain.
        if (readerIsModel && camel.kind === "inbound") {
          if (camel.textBody) camel.textBody = fence(camel.textBody)
          if (camel.htmlBody) camel.htmlBody = fence(camel.htmlBody)
          if (camel.snippet) camel.snippet = fence(camel.snippet)
        }
        return camel
      })
      // Load attachments parented to tickets:message for the returned ids and
      // attach + rewrite cid: HTML body references to /api/files/:id/inline.
      const ids = items.map((m) => m.id)
      if (ids.length > 0) {
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
          analysis_status: string | null
          analysis_summary: string | null
        }>(
          await txDb.execute(drizzleSql`
            SELECT id::text AS id, entity_id, filename, mime_type, size_bytes,
                   disposition, content_id, ordinal, analysis_status, analysis_summary
            FROM ${KS}.files
            WHERE app = 'tickets' AND entity_type = 'message'
              AND entity_id IN (${drizzleSql.join(
                ids.map((id) => drizzleSql`${id}`),
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
            analysisStatus: string | null
            analysisSummary: string | null
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
            analysisStatus: r.analysis_status,
            analysisSummary: r.analysis_summary,
          })
          byMessage.set(r.entity_id, list)
        }
        for (const m of items) {
          const list = byMessage.get(m.id) ?? []
          m.attachments = list
          if (m.htmlBody && list.length > 0) {
            m.htmlBody = rewriteCidReferences(m.htmlBody, list)
          }
        }
      }
      const messages = { items, nextCursor: raw.messages?.nextCursor ?? null }
      // The reply drafts already waiting for approval on this ticket. An agent asked to draft a
      // reply must see them before it drafts (walk 2026-10-19: a second pending draft appeared next
      // to the one already waiting); tickets:reply refuses a second one, naming this id. Read
      // under the caller's RLS: a ticket reader sees the ticket's tickets:* approvals (0018).
      const KD = drizzleSql.raw(schemaRef("kernel"))
      const pendingReplyDrafts = extractRows<{
        id: string
        text_body: string | null
        requested_by: string
        requester_name: string | null
        agent_id: string | null
        agent_name: string | null
        created_at: string | Date
      }>(
        await txDb.execute(drizzleSql`
          SELECT ar.id::text AS id,
                 ar.current_payload->>'textBody' AS text_body,
                 ar.requested_by::text AS requested_by,
                 u.name AS requester_name,
                 ar.agent_id::text AS agent_id,
                 ag.display_name AS agent_name,
                 ar.created_at
          FROM ${KD}.approval_requests ar
          LEFT JOIN ${KD}.users u ON u.id = ar.requested_by
          LEFT JOIN ${KD}.agents ag ON ag.id = ar.agent_id
          WHERE ar.org_id = ${orgId}::uuid
            AND ar.tool_name = 'tickets:reply'
            AND ar.status = 'pending'
            AND ar.tool_params->>'ticketId' = ${ticket.id}
          ORDER BY ar.created_at ASC
        `),
      ).map((r) => ({
        approvalId: r.id,
        textBody: r.text_body ?? "",
        requestedBy: { userId: r.requested_by, name: r.requester_name },
        agent: r.agent_id ? { id: r.agent_id, name: r.agent_name } : null,
        createdAt: new Date(r.created_at).toISOString(),
      }))
      return JSON.stringify({
        ticket,
        messages,
        composeSignatureText,
        totalMessageCount: raw.totalMessageCount ?? items.length,
        pendingReplyDrafts,
      })
    },

    tickets_create: async (paramsJson: string): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_create is only available to the tickets app")
      }
      const { createTicket } = await import("~/apps/tickets/create")
      return JSON.stringify(
        await createTicket(txDb as never, orgId, JSON.parse(paramsJson), {
          actorType: actorType as "user" | "agent" | "system" | "mcp",
          auditActorType,
          userId,
          // Checked against the message fileParent's write scope when the
          // call attaches files to the first message: the operating scopes
          // (this bridge's actor), as files_attachToParent does.
          scopes: callerScopes,
          operatingScopes: inheritedActor.scopes ?? callerScopes,
        }),
      )
    },

    tickets_setCategory: async (ticketId: string, categoryId: string | null): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_setCategory is only available to the tickets app")
      }
      const { requireActiveTicketCategory } = await import("~/apps/tickets/create")
      const tickets = appTable(ticketsSchema, "tickets")
      const ticket = extractRows<{ id: string }>(
        await txDb.execute(drizzleSql`
          SELECT id FROM ${tickets}
          WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )[0]
      if (!ticket) return envelopeError(ERROR_NOT_FOUND.code, "ticket not visible")
      if (categoryId) {
        const category = await requireActiveTicketCategory(orgId, categoryId)
        if ("error" in category) return JSON.stringify(category)
      }
      await txDb.execute(drizzleSql`
        UPDATE ${tickets}
        SET category_id = ${categoryId ?? null}::uuid, updated_at = now()
        WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
      `)
      // The change event names the ticket by its (possibly re-segmented)
      // display handle.
      const { displayHandleFor } = await import("~/apps/tickets/display-handle")
      const handle = await displayHandleFor(txDb as never, orgId, ticketId)
      return JSON.stringify({ ticketId, categoryId, handle })
    },

    tickets_setLanguage: async (ticketId: string, language: string | null): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_setLanguage is only available to the tickets app")
      }
      const tickets = appTable(ticketsSchema, "tickets")
      const ticket = extractRows<{ id: string }>(
        await txDb.execute(drizzleSql`
          SELECT id FROM ${tickets}
          WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )[0]
      if (!ticket) return envelopeError(ERROR_NOT_FOUND.code, "ticket not visible")
      // `language` is a free-text label (e.g. "French"/"German") on its OWN column, so it coexists with
      // the topic category_id rather than overwriting it — unlike setCategory (single scalar).
      await txDb.execute(drizzleSql`
        UPDATE ${tickets}
        SET language = ${language ?? null}, updated_at = now()
        WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
      `)
      return JSON.stringify({ ticketId, language })
    },

    tickets_setTeam: async (ticketId: string, team: string | null): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_setTeam is only available to the tickets app")
      }
      // Delegates to the shared primitive so the trim rule (and the fact that a
      // blank string clears rather than stores "") lives in ONE place — the same
      // module `teams.list` and `teams.rename` read from. `team` is free text on
      // purpose: a desk must be able to file its first ticket for a team nobody
      // registered yet. The UPDATE runs under the caller's RLS context, so the
      // `tickets:team` dimension still governs which tickets are reachable.
      const { setTeam } = await import("~/apps/tickets/teams")
      const out = await setTeam(txDb as never, orgId, ticketId, team)
      if ("error" in out) return JSON.stringify(out)
      const { displayHandleFor } = await import("~/apps/tickets/display-handle")
      return JSON.stringify({
        ...out,
        handle: await displayHandleFor(txDb as never, orgId, ticketId),
      })
    },

    tickets_setAudience: async (ticketId: string, audience: string | null): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_setAudience is only available to the tickets app")
      }
      // Closed set of two, enforced by a CHECK on the column — unlike `team`,
      // which is free text and accumulated sixteen near-duplicate spellings.
      const { setAudience } = await import("~/apps/tickets/audience")
      const out = await setAudience(txDb as never, orgId, ticketId, audience as never)
      if (out && typeof out === "object" && "error" in out) return JSON.stringify(out)
      const { displayHandleFor } = await import("~/apps/tickets/display-handle")
      return JSON.stringify({
        ...out,
        handle: await displayHandleFor(txDb as never, orgId, ticketId),
      })
    },

    tickets_assign: async (
      ticketId: string,
      assignedTo: string | null,
      // BL-266: optimistic-concurrency guards turning the blind SET into a
      // compare-and-swap claim. `onlyIfUnassigned` claims a ticket ONLY while it
      // is still unowned (assigned_to IS NULL); the (hasExpected, expectedAssignee)
      // pair is the general CAS — require the current owner to match a specific id
      // (or null). Either guard makes the UPDATE conditional + RETURNING, so a lost
      // race (zero rows) surfaces as a TYPED `conflict` envelope instead of a silent
      // last-writer-wins clobber.
      //
      // These are PRIMITIVE positional args (boolean / string|null), NOT a guard
      // OBJECT: the QuickJS→host bridge shim (`__wrap` in executor.ts) JSON-
      // stringifies any non-primitive arg into a string before it reaches the host,
      // which would silently disable an object guard. Primitive args cross the
      // boundary intact.
      onlyIfUnassignedArg?: boolean,
      hasExpectedArg?: boolean,
      expectedAssigneeArg?: string | null,
    ): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_assign is only available to the tickets app")
      }
      const { requireUserInOrg, isSelfAssignSentinel } = await import("~/apps/tickets/create")
      // BL-76: resolve a "me"/"self" sentinel to the acting user before validating.
      let resolvedAssignee = assignedTo
      if (isSelfAssignSentinel(resolvedAssignee)) {
        if (actorType !== "user") {
          return envelopeError("invalid_params", "self-assignment ('me') requires a user actor")
        }
        resolvedAssignee = userId
      }
      const tickets = appTable(ticketsSchema, "tickets")
      const existing = extractRows<{ id: string; assigned_to: string | null }>(
        await txDb.execute(drizzleSql`
          SELECT id, assigned_to::text AS assigned_to FROM ${tickets}
          WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )[0]
      if (!existing) return envelopeError(ERROR_NOT_FOUND.code, "ticket not visible")
      if (resolvedAssignee) {
        const user = await requireUserInOrg(orgId, resolvedAssignee)
        if ("error" in user) return JSON.stringify(user)
      }

      const onlyIfUnassigned = onlyIfUnassignedArg === true
      const hasExpected = hasExpectedArg === true

      // BL-266: a CLAIM (onlyIfUnassigned, or an expectedAssignee CAS to a
      // non-null owner) with a NULL new assignee is a contradiction — you cannot
      // "claim" a ticket while ALSO clearing its owner. The legacy blind SET would
      // happily UPDATE assigned_to = null on an unowned row (it matches
      // `assigned_to IS NULL`), RETURN one row, and report `{assignedTo:null}` —
      // a SILENT NO-OP that LOOKS like a successful claim, so a weak model that
      // forgot `assignedTo:'me'` fabricates "assigned to you" while the ticket
      // stays ORPHANED (the run-3 gate fail). FAIL LOUDLY instead with an
      // actionable message so the agent supplies the assignee and re-claims —
      // never a success-shaped no-op.
      if (
        (onlyIfUnassigned || (hasExpected && (expectedAssigneeArg ?? null) !== null)) &&
        resolvedAssignee === null
      ) {
        return envelopeError(
          "invalid_params",
          "Claiming a ticket requires an assignee — pass assignedTo:'me' (to claim it for yourself) or a teammate's UUID. onlyIfUnassigned with no assignee would unassign, not claim.",
        )
      }

      // BL-266: resolve a "me"/"self" sentinel in expectedAssignee too, so a
      // CAS swap can be expressed relative to the acting user.
      let expectedAssignee = expectedAssigneeArg ?? null
      if (hasExpected && isSelfAssignSentinel(expectedAssignee)) {
        if (actorType !== "user") {
          return envelopeError("invalid_params", "expectedAssignee 'me' requires a user actor")
        }
        expectedAssignee = userId
      }

      // The CAS UPDATE. Without a guard it stays a plain (id, org) match —
      // identical to the legacy blind SET (idempotent reassign still allowed).
      // WITH a guard the WHERE also pins the CURRENT assigned_to, so two
      // concurrent claims of the same ticket cannot both update the row: under
      // READ COMMITTED the second waits on the first's row lock, then re-checks
      // the (now-changed) assigned_to and matches zero rows. Each branch is a
      // full statement (no nested SQL fragments — the bridge executor rejects
      // an interpolated SQL object inside another, BL-266).
      const newAssignee = resolvedAssignee ?? null
      let updateResult: unknown
      if (onlyIfUnassigned || (hasExpected && expectedAssignee === null)) {
        updateResult = await txDb.execute(drizzleSql`
          UPDATE ${tickets}
          SET assigned_to = ${newAssignee}::uuid, updated_at = now()
          WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid AND assigned_to IS NULL
          RETURNING id
        `)
      } else if (hasExpected) {
        updateResult = await txDb.execute(drizzleSql`
          UPDATE ${tickets}
          SET assigned_to = ${newAssignee}::uuid, updated_at = now()
          WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid AND assigned_to = ${expectedAssignee}::uuid
          RETURNING id
        `)
      } else {
        updateResult = await txDb.execute(drizzleSql`
          UPDATE ${tickets}
          SET assigned_to = ${newAssignee}::uuid, updated_at = now()
          WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
          RETURNING id
        `)
      }
      const updated = extractRows<{ id: string }>(updateResult)

      if (updated.length === 0 && (onlyIfUnassigned || hasExpected)) {
        // Lost the race / precondition not met. RE-READ the current owner from the
        // committed row (the `existing` snapshot was read pre-race and may show the
        // stale null both contenders saw) so the conflict reflects REAL post-CAS
        // state — the agent can acknowledge "already taken" truthfully and SKIP,
        // never claim ownership it does not hold or name a fabricated owner.
        const fresh = extractRows<{ assigned_to: string | null }>(
          await txDb.execute(drizzleSql`
            SELECT assigned_to::text AS assigned_to FROM ${tickets}
            WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
            LIMIT 1
          `),
        )[0]
        const currentOwner = fresh?.assigned_to ?? null
        // currentAssignee is carried under `body` (not a top-level error field):
        // the executeTool error normalizer preserves `code/message/retryable/body`
        // but strips unknown top-level fields, so `body` is the durable channel for
        // the structured owner id that reaches the agent/client.
        return JSON.stringify({
          error: {
            code: "conflict",
            message: onlyIfUnassigned
              ? `Ticket already claimed${currentOwner ? ` by ${currentOwner}` : ""}; not reassigned. Skip it and acknowledge it was already taken.`
              : `Ticket assignee changed${currentOwner ? ` (now ${currentOwner})` : ""}; expected guard not met, not reassigned.`,
            retryable: false,
            currentAssignee: currentOwner,
            ticketId,
            body: { currentAssignee: currentOwner, ticketId },
          },
        })
      }
      if (updated.length > 0) {
        // A pending request about this ticket is now for its new owner. Its own transaction:
        // a failure is logged and the assignment stands.
        const { updateItemRoutePerson } = await import("~/modules/approvals/route-world")
        await updateItemRoutePerson({
          orgId,
          app: "tickets",
          entityType: "ticket",
          entityId: ticketId,
          personId: newAssignee,
        })
      }
      return JSON.stringify({ ticketId, assignedTo: resolvedAssignee })
    },

    tickets_merge: async (paramsJson: string): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_merge is only available to the tickets app")
      }
      const { mergeTickets } = await import("~/apps/tickets/merge")
      return JSON.stringify(
        await mergeTickets(txDb as never, orgId, JSON.parse(paramsJson), {
          actorType: actorType as "user" | "agent" | "system" | "mcp",
          auditActorType,
          userId,
        }),
      )
    },

    tickets_markRead: async (paramsJson: string): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_markRead is only available to the tickets app")
      }
      if (!userId) {
        throw new Error("tickets_markRead requires a user actor")
      }
      const { markRead } = await import("~/apps/tickets/read-state")
      const params = JSON.parse(paramsJson) as {
        ticketId: string
        lastReadMessageId?: string | null
      }
      try {
        const outcome = await markRead(txDb as never, {
          ticketId: params.ticketId,
          userId,
          lastReadMessageId: params.lastReadMessageId,
        })
        return JSON.stringify(outcome)
      } catch (err) {
        // Same rationale as db_update: only `message` survives the worker IPC,
        // so a failed query here must inline its pg cause or the log shows the
        // SQL but not WHY it failed (a prod markRead failure was undiagnosable).
        throw withPgCause(err, "tickets_markRead failed")
      }
    },

    tickets_inboxCounts: async (paramsJson: string): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_inboxCounts is only available to the tickets app")
      }
      const { inboxCounts } = await import("~/apps/tickets/read-state")
      const params = JSON.parse(paramsJson) as { inboxIds?: string[] }
      return JSON.stringify(await inboxCounts(txDb as never, { inboxIds: params.inboxIds }))
    },

    tickets_listForContact: async (paramsJson: string): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_listForContact is only available to the tickets app")
      }
      const { listForContact } = await import("~/apps/tickets/list-for-contact")
      const { applyDisplayHandles } = await import("~/apps/tickets/display-handle")
      const params = JSON.parse(paramsJson) as { contactId: string; limit?: number }
      const out = await listForContact(txDb as never, {
        contactId: params.contactId,
        limit: params.limit,
      })
      // The display handle (`ticket-B2B-12`), as on every ticket surface.
      out.items = await applyDisplayHandles(txDb as never, orgId, out.items, (r) => r.id)
      return JSON.stringify(out)
    },

    tickets_admin: async (op: string, paramsJson: string): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_admin is only available to the tickets app")
      }
      const { runAdminOp } = await import("~/apps/tickets/admin")
      return JSON.stringify(
        // `originRoutineId: bridgeRoutineId` (see the capture site above):
        // a routine-drafted reply's signature (tools.draftSignature)
        // needs to know it is running inside a routine tick, but this callback
        // runs OUTSIDE the ALS frame `currentRunContext()` reads, same as the
        // knowledge bridge's own routine-bound-doc redirect. `bridgeRoutineId`
        // was captured IN-FRAME at bridge-construction time, so it survives the
        // lost ALS frame here; undefined for a non-routine caller, exactly as
        // before.
        //
        // An APPROVED re-entry reaches this callback too, and it has no routine
        // frame at all: the routine and the approver are read off the approval,
        // and the acting agent off the re-entry frame the bridge captured. Without
        // them a routine reply an agent drafted was stored as written by the
        // routine's owner, with no approver.
        await runAdminOp(txDb as never, orgId, op, JSON.parse(paramsJson), {
          actorType: actorType as "user" | "agent" | "system" | "mcp",
          auditActorType,
          userId,
          scopes: callerScopes,
          // Only the attached files' destination check reads these (ActorRef).
          operatingScopes: inheritedActor.scopes ?? callerScopes,
          originRoutineId: bridgeRoutineId ?? approvalContext?.originRoutineId,
          approverUserId: approvalContext?.approvalDeciderId ?? null,
          actingAgentId: bridgeActingAgentId,
          approvalRequestId: approvalContext?.approvalRequestId ?? null,
        }),
      )
    },

    tickets_runJob: async (jobName: string): Promise<void> => {
      if (appName !== "tickets") {
        throw new Error("tickets_runJob is only available to the tickets app")
      }
      const jobs = await import("~/apps/tickets/jobs")
      if (jobName === "slaCheck") return jobs.runSlaCheck(orgId)
      if (jobName === "followupCheck") return jobs.runFollowupCheck(orgId)
      if (jobName === "closeSilentCheck") {
        await jobs.runCloseSilentCheck(orgId)
        return
      }
      throw new Error(`unknown tickets job: ${jobName}`)
    },

    tickets_listSyncableAccounts: async (): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_listSyncableAccounts is only available to the tickets app")
      }
      // Enumerate this org's live mailbox inboxes (kind='mailbox', not archived) whose backing
      // kernel connection is active, so a payload-less scheduled cron can fan out one per-account
      // sync/renewal job. Org-owned connections are invisible to liaison_rls, so this MUST read
      // under withPrivilegedDb (BYPASSRLS, scoped to orgId) — the request role would see 0 rows
      // (or trip the connected_accounts ::uuid-on-empty-GUC cast). `api` inboxes have no
      // connected_account and are excluded by the kind filter + inner join. Provider is derived
      // from connection_name (imap vs gmail), matching ticketsOnAccountConnected.
      const { withPrivilegedDb } = await import("~/db/privileged")
      return withPrivilegedDb(orgId, "tickets-list-syncable-accounts", async (db) => {
        const r = await db.execute(drizzleSql`
          SELECT ca.id AS connected_account_id, ca.connection_name AS connection_name
          FROM ${drizzleSql.raw(quoteIdent(schemaRef("app_tickets")))}.inboxes i
          JOIN ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.connected_accounts ca
            ON ca.id = i.connected_account_id
          WHERE i.org_id = ${orgId}::uuid
            AND i.kind = 'mailbox'
            AND i.archived_at IS NULL
            AND ca.app_name = 'tickets'
            AND ca.status = 'active'
            AND ca.disconnected_at IS NULL
            -- ONLY the two connections this app can actually sync. A mailbox
            -- inbox can be backed by something else (a staging box carries an
            -- smtp-sink account), and the old code mapped anything that was
            -- not imap to gmail by default. That handed the gmail fan-out an
            -- account with no Gmail connection at all, which then failed every
            -- cycle with "No connected account for connection gmail" and a
            -- permanent no_cursor. Never guess a provider from the absence of
            -- another one.
            AND ca.connection_name IN ('gmail', 'imap')
        `)
        const rows = extractRows<{ connected_account_id: string; connection_name: string }>(r)
        return JSON.stringify(
          rows.map((row) => ({
            connectedAccountId: row.connected_account_id,
            provider: row.connection_name,
          })),
        )
      })
    },

    tickets_runSync: async (jobName: string, connectedAccountId: string): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_runSync is only available to the tickets app")
      }
      const sync = await import("~/apps/tickets/sync")
      const inbound = await import("~/apps/tickets/inbound")
      const { withPrivilegedDb } = await import("~/db/privileged")
      const ctx = {
        fetch: globalThis.fetch,
        getAccessToken: async (conn: "gmail" | "imap", email: string) => {
          // E2E fixture tests historically use a stub here (the fixture
          // doesn't validate the bearer). Real Gmail (chaos sim, prod) needs
          // a refreshed OAuth token. Mail's gmail-sync uses
          // `connections_getToken` for this; tickets needs the same path or
          // its sync 401s against api.googleapis.com. Detect chaos/online
          // mode by env: when the api process has CHAOS_DEBUG set OR
          // NODE_ENV !== "test", do the real OAuth refresh; otherwise
          // preserve the fixture-stub fallback for legacy E2E tests.
          if (process.env.CHAOS_DEBUG === "1" || process.env.NODE_ENV !== "test") {
            const { getTokenForConnection } = await import("~/modules/apps/connections/service")
            // Resolve the mailbox OAuth token via the SYSTEM (privileged) path,
            // consistent with every other DB op in this sync ctx (loadAccount /
            // loadInbox / saveAccountMetadata / processInbound all use
            // withPrivilegedDb(orgId)). A tickets mailbox sync is a background
            // operation on an ORG-OWNED connection, which is deliberately
            // invisible to liaison_rls -- so the "user" path finds nothing and,
            // worse, its RLS-scoped read ABORTS (22P02 invalid uuid "") when this
            // sync job's RLS context carries an empty `app.current_org_id` GUC.
            // That abort is what silently stalled prod support-mail ingestion
            // (2026-07-09): the token lookup threw before the org-owned privileged
            // fallback could run. The system branch re-opens its own privileged tx
            // scoped to `orgId`, so it neither depends on the caller's RLS context
            // nor touches the unguarded connected_accounts policy cast.
            return getTokenForConnection(txDb, orgId, userId, "tickets", conn, email, {
              actorType: "system",
            })
          }
          return "stub-access-token"
        },
        // REAL enqueue, not a stub. gmailIncrementalSync self-heals a missing
        // history cursor by enqueueing `gmail-initial-sync` (the designed
        // poll-only fallback when GMAIL_PUBSUB_TOPIC is unset: users.watch
        // 400s, so no cursor is ever saved). A no-op here silently killed that
        // fallback: every tick logged `dropped: no_cursor`, enqueued nothing,
        // and the mailbox never ingested again after a reconnect (the prod
        // support mailbox outage of 2026-07-10). Pin the trusted orgId like
        // the sandbox enqueueJob bridge above.
        enqueueJob: async (
          jobName: string,
          payload: unknown,
          opts?: { jobId?: string },
        ): Promise<void> => {
          const { enqueueAppJob } = await import("~/infra/jobs/jobs")
          await enqueueAppJob(
            "tickets",
            jobName,
            { ...(payload as Record<string, unknown>), orgId },
            opts?.jobId ? { jobId: opts.jobId } : undefined,
          )
        },
        imapFetch: async (
          accountEmail: string,
          opts: { mode: "incremental" | "initial"; cursor?: string },
        ) => {
          const { fetchFromImapFixture } = await import("~/modules/apps/sandbox/imap-bridge")
          return fetchFromImapFixture(accountEmail, opts)
        },
        loadAccount: async () => {
          return withPrivilegedDb(orgId, "tickets-sync-load-account", async (db) => {
            const r = await db.execute(drizzleSql`
              SELECT id, identifier AS email_address, metadata, status
              FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.connected_accounts
              WHERE id = ${connectedAccountId}::uuid AND org_id = ${orgId}::uuid
              LIMIT 1
            `)
            const row = extractRows<{
              id: string
              email_address: string
              metadata: Record<string, unknown> | null
              status: string
            }>(r)[0]
            if (!row) {
              throw new Error(`connected account not found: ${connectedAccountId}`)
            }
            return {
              id: row.id,
              email_address: row.email_address,
              metadata: row.metadata ?? {},
              status: row.status,
            }
          })
        },
        saveAccountMetadata: async (caId: string, metadata: Record<string, unknown>) => {
          await withPrivilegedDb(orgId, "tickets-sync-save-metadata", async (db) => {
            await db.execute(drizzleSql`
              UPDATE ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.connected_accounts
              SET metadata = ${JSON.stringify(metadata)}::jsonb, updated_at = now()
              WHERE id = ${caId}::uuid AND org_id = ${orgId}::uuid
            `)
          })
        },
        loadInboxByAccountId: async (caId: string) => {
          return withPrivilegedDb(orgId, "tickets-sync-load-inbox", async (db) => {
            const r = await db.execute(drizzleSql`
              SELECT id, email_address, org_id, default_team, default_sensitivity
              FROM ${drizzleSql.raw(quoteIdent(schemaRef("app_tickets")))}.inboxes
              WHERE org_id = ${orgId}::uuid AND connected_account_id = ${caId}::uuid AND archived_at IS NULL
              LIMIT 1
            `)
            return (
              extractRows<{
                id: string
                email_address: string
                org_id: string
                default_team: string | null
                default_sensitivity: "internal" | "confidential" | "restricted" | null
              }>(r)[0] ?? null
            )
          })
        },
        processInbound: async (parsed: unknown, inbox: unknown, opts?: { backfill: boolean }) => {
          const result = await withPrivilegedDb(orgId, "tickets-process-inbound", async (db) => {
            return inbound.processInboundMessage(
              parsed as never,
              inbox as never,
              {
                db: db as never,
                orgId,
                // Every privileged read of the ingest runs on this transaction.
                privilegedTx: db,
                // A first (backfill) sync reads the mailbox's history: nothing
                // it opens is acknowledged as if it had just arrived.
                noAcknowledgement: opts?.backfill === true,
              } as never,
            )
          })
          if ("error" in result) {
            const err = new Error(result.error.message) as Error & {
              code?: string
              retryable?: boolean
            }
            err.code = result.error.code
            err.retryable = result.error.retryable
            throw err
          }
          if (result.outcome === "rerouted") {
            const dispatched = await dispatchRerouteAppend(parsed, result.conversationId)
            if (!dispatched.ok) {
              logger.warn(
                {
                  conversationId: result.conversationId,
                  externalMessageId: (parsed as { messageId?: string | null }).messageId ?? null,
                  errorCode: dispatched.reason,
                },
                "mail reroute dispatch failed",
              )
              return {
                outcome: "rerouted_failed" as const,
                conversationId: result.conversationId,
                reason: dispatched.reason,
              }
            }
            return { outcome: "rerouted" as const, conversationId: result.conversationId }
          }
          return result
        },
      }
      const opts = { processMessage: ctx.processInbound }
      let result: unknown
      try {
        switch (jobName) {
          case "gmail-incremental-sync":
            result = await sync.gmailIncrementalSync(orgId, connectedAccountId, ctx, opts)
            break
          case "gmail-initial-sync":
            result = await sync.gmailInitialSync(orgId, connectedAccountId, ctx, opts)
            break
          case "gmail-watch-renewal":
            result = await sync.gmailWatchRenewal(orgId, connectedAccountId, ctx)
            break
          case "imap-incremental-sync":
            result = await sync.imapIncrementalSync(orgId, connectedAccountId, ctx, opts)
            break
          case "imap-initial-sync":
            result = await sync.imapInitialSync(orgId, connectedAccountId, ctx, opts)
            break
          default:
            throw new Error(`unknown tickets sync job: ${jobName}`)
        }
      } catch (err) {
        // An account that isn't authorized yet (no token / disconnected / needs
        // re-auth) is an EXPECTED, recoverable state — not a server fault. Warn +
        // skip (don't re-throw → no BullMQ retry storm) so a pending/unauthed
        // mailbox doesn't pollute the server-error budget.
        const { isAccountNotReadyError } = await import("~/modules/apps/connections/service")
        if (isAccountNotReadyError(err)) {
          logger.warn(
            { jobName, connectedAccountId, reason: (err as Error).message },
            "tickets_runSync skipped (account not ready)",
          )
          return JSON.stringify({ skipped: "account_not_ready", reason: (err as Error).message })
        }
        logger.error({ err, jobName, connectedAccountId }, "tickets_runSync failed")
        throw err
      }
      logger.info({ jobName, connectedAccountId, result }, "tickets_runSync done")
      return JSON.stringify(result)
    },

    tickets_onGmailPushService: async (
      accountEmail: string,
      _historyId: string,
    ): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_onGmailPushService is only available to the tickets app")
      }
      const { withPrivilegedDb } = await import("~/db/privileged")
      const ca = await withPrivilegedDb(orgId, "tickets-push-account-lookup", async (db) => {
        const r = await db.execute(drizzleSql`
          SELECT id FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.connected_accounts
          WHERE org_id = ${orgId}::uuid AND app_name = 'tickets'
            AND status <> 'disconnected'
            AND lower(identifier) = ${String(accountEmail).toLowerCase()}
          LIMIT 1
        `)
        return extractRows<{ id: string }>(r)[0]
      })
      // A push for an account no longer connected (a watch still lapsing at the provider):
      // dropped and acknowledged, and its address is not kept even in the log.
      if (!ca?.id) {
        logger.info({ orgId }, "tickets_onGmailPushService: push for no connected account, dropped")
        return JSON.stringify({ skipped: "unknown_account" })
      }
      // Push handler triggers the same incremental sync that the cron uses.
      const runSyncFn = (rpcBridge as Record<string, (...args: unknown[]) => Promise<string>>)
        .tickets_runSync
      try {
        const runSyncResult = JSON.parse(await runSyncFn("gmail-incremental-sync", ca.id))
        logger.info({ accountEmail, runSyncResult }, "tickets_onGmailPushService done")
        return JSON.stringify({ connectedAccountId: ca.id, sync: runSyncResult })
      } catch (err) {
        logger.error({ err, accountEmail }, "tickets_onGmailPushService runSync failed")
        throw err
      }
    },

    tickets_processInboundMessage: async (
      parsedJson: string,
      inboxJson: string,
    ): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_processInboundMessage is only available to the tickets app")
      }
      const inbound = await import("~/apps/tickets/inbound")
      const parsed = JSON.parse(parsedJson)
      const inbox = JSON.parse(inboxJson)
      const result = await inbound.processInboundMessage(parsed, inbox, {
        db: txDb,
        orgId,
      } as never)
      if (!("error" in result) && result.outcome === "rerouted") {
        const dispatched = await dispatchRerouteAppend(parsed, result.conversationId)
        if (!dispatched.ok) {
          return JSON.stringify({
            outcome: "rerouted_failed",
            conversationId: result.conversationId,
            reason: dispatched.reason,
          })
        }
      }
      return JSON.stringify(result)
    },

    tickets_summary_ensure: async (ticketId: string): Promise<string> => {
      requireApp("tickets", "tickets_summary_ensure")
      const tickets = appTable(ticketsSchema, "tickets")
      const t = extractRows<Record<string, any>>(
        await txDb.execute(drizzleSql`
          SELECT id, status, message_count, summary_message_count, summary_status, summary_text,
                 summary_at, summary_model, summary_token_usage, summary_error
          FROM ${tickets}
          WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
          LIMIT 1
        `),
      )[0]
      if (!t) return envelopeError(ERROR_NOT_FOUND.code, "ticket not visible")
      if (Number(t.message_count) === 0) {
        return JSON.stringify({
          summary: null,
          summaryAt: null,
          summaryStatus: "idle",
          isStale: false,
        })
      }
      const stale = Number(t.message_count) > Number(t.summary_message_count)
      if (stale && t.summary_status === "idle" && t.status !== "closed") {
        const updated = extractRows(
          await txDb.execute(drizzleSql`
            UPDATE ${tickets}
            SET summary_status = 'generating', updated_at = now()
            WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid AND summary_status = 'idle'
            RETURNING id
          `),
        )
        if (updated.length > 0) {
          await enqueueAppJob(
            "tickets",
            "tickets-summarize",
            { ticketId, orgId },
            { jobId: `tickets-summarize:${ticketId}` },
          )
        }
      }
      return summaryEnvelope(ticketId)
    },

    tickets_summary_regenerate: async (ticketId: string): Promise<string> => {
      requireApp("tickets", "tickets_summary_regenerate")
      const tickets = appTable(ticketsSchema, "tickets")
      const updated = extractRows<Record<string, any>>(
        await txDb.execute(drizzleSql`
          UPDATE ${tickets}
          SET summary_status = 'generating', summary_error = null, updated_at = now()
          WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
            AND (
              summary_status IN ('idle', 'error') OR
              (summary_status = 'generating' AND updated_at < now() - interval '10 minutes')
            )
          RETURNING *
        `),
      )
      if (updated.length > 0) {
        await enqueueAppJob(
          "tickets",
          "tickets-summarize",
          { ticketId, orgId },
          { jobId: `tickets-summarize:${ticketId}` },
        )
      }
      return summaryEnvelope(ticketId)
    },

    tickets_summary_runJob: async (payloadJson: string): Promise<string> => {
      requireApp("tickets", "tickets_summary_runJob")
      const payload = JSON.parse(payloadJson || "{}") as { ticketId?: string; orgId?: string }
      const ticketId = payload.ticketId
      if (!ticketId) return envelopeError("invalid_params", "ticketId required")
      const tickets = appTable(ticketsSchema, "tickets")
      const messages = appTable(ticketsSchema, "messages")
      const { markSummaryFailed, writeTicketSummary } = await import("~/apps/tickets/summary-write")
      // Every statement here is its own short transaction (session mode), so a
      // deadlock or serialization failure is retried in place, with backoff.
      const writeRetry = {
        onRetry: (info: { attempt: number; delayMs: number; code: string | null }) =>
          logger.warn(
            { ticketId, orgId, attempt: info.attempt, delayMs: info.delayMs, dbCode: info.code },
            "ticket summary: transient database error, retrying",
          ),
      }
      const readRetry = { retries: 2, delayMs: (attempt: number) => 100 * attempt, ...writeRetry }
      const ticket = await retryOnTransientDbError(
        async () =>
          extractRows<Record<string, any>>(
            await txDb.execute(drizzleSql`
              SELECT * FROM ${tickets}
              WHERE id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
              LIMIT 1
            `),
          )[0],
        readRetry,
      )
      if (!ticket) return JSON.stringify({ skipped: "missing_ticket" })
      const { broadcastEphemeral } = await import("~/infra/events/event-bus")
      const failSummary = async (reason: string) => {
        await markSummaryFailed(txDb, tickets, { ticketId, orgId, reason }, writeRetry)
        await broadcastEphemeral({
          app: "tickets",
          entity: "ticket",
          action: "summary_updated",
          entityId: ticketId,
          orgId,
          actorId: null,
          actorType: "system",
          data: { ticketId, summaryStatus: "error", summaryError: reason },
        })
      }
      const { appPromptRegistry } = await import("~/modules/apps/app-registries")
      const prompt = appPromptRegistry.get([orgId, "tickets", "summarizer"])
      if (!prompt) {
        await failSummary("prompt_missing")
        return JSON.stringify({ error: "prompt_missing" })
      }
      const rows = await retryOnTransientDbError(
        async () =>
          extractRows<Record<string, any>>(
            await txDb.execute(drizzleSql`
              SELECT * FROM ${messages}
              WHERE ticket_id = ${ticketId}::uuid AND org_id = ${orgId}::uuid
              ORDER BY sent_at, created_at, id
            `),
          ),
        readRetry,
      )
      const { capMessages, assemblePrompt } = await import("~/apps/tickets/summary")
      const indexed = rows.map((row, index) => ({
        id: row.id,
        kind: row.kind,
        textBody: row.text_body,
        htmlBody: row.html_body,
        sentAt: toIso(row.sent_at) ?? new Date().toISOString(),
        fromEmail: row.from_email,
        ordinal: index + 1,
      }))
      const newMessages = indexed.filter(
        (row) => row.ordinal > Number(ticket.summary_message_count),
      )
      const capped = capMessages(newMessages, { maxMessages: 20, maxInputTokens: 10_000 })
      // Taken right before the call, so nothing between the pre check and the
      // call's own try can leave a demo org's hold open.
      const credit = await (await import("~/modules/agent/credits/credit-meter")).preCheck(
        orgId,
        null,
      )
      if (!credit.allowed) {
        await failSummary(credit.reason ?? "insufficient_credits")
        return JSON.stringify({ error: "insufficient_credits" })
      }
      let summaryText: string
      let inputTokens = 0
      let outputTokens = 0
      let callUsage: ReturnType<
        typeof import("~/modules/agent/providers/side-call-model").sideCallUsage
      > | null = null
      try {
        const { displayHandleOfRow, loadSegmentConfig } = await import(
          "~/apps/tickets/display-handle"
        )
        const model = await (
          await import("~/modules/agent/providers/side-call-model")
        ).resolveSideCallModel(credit)
        const assembledPrompt = assemblePrompt({
          skill: prompt.content,
          ticket: {
            // The display handle (`ticket-B2B-12`), the one people will read.
            handle: displayHandleOfRow(ticket, await loadSegmentConfig(orgId)),
            subject: ticket.subject,
            status: ticket.status,
            priority: ticket.priority,
            categoryName: null,
            contactName: null,
            fromEmail: null,
          },
          previousSummary: ticket.summary_text ?? "",
          newMessages: capped.messages,
          truncated: capped.truncated,
        })
        const result = await generateText({
          model,
          messages: [{ role: "user", content: assembledPrompt }],
        })
        summaryText = result.text
        callUsage = (await import("~/modules/agent/providers/side-call-model")).sideCallUsage(
          result.usage,
          result.providerMetadata,
        )
        inputTokens = callUsage.inputTokens
        outputTokens = callUsage.outputTokens
      } catch (err) {
        logger.warn({ err, ticketId }, "ticket summary provider failed")
        // A demo visitor's hold goes back (no usage was read).
        await credit.demo?.finish()
        await failSummary("provider_error")
        return JSON.stringify({ error: "provider_error" })
      }
      const usage = { inputTokens, outputTokens }
      const { finalizeUsage } = await import("~/modules/agent/credits/credit-meter")
      await finalizeUsage(orgId, {
        model: credit.model,
        ...(callUsage ?? { inputTokens, outputTokens }),
        keySource: credit.keySource,
        userId: "system",
        ...(credit.demo ? { demo: credit.demo } : {}),
      })
      let updated: { summaryAt: Date | string } | null
      try {
        updated = await writeTicketSummary(
          txDb,
          tickets,
          {
            ticketId,
            orgId,
            summaryText,
            messageCount: Number(ticket.message_count),
            modelId: credit.model.modelId,
            usage,
          },
          writeRetry,
        )
      } catch (err) {
        // The retries are spent (or the error is not transient). The model was
        // already paid for; say so, and leave the ticket in `error` so it can be
        // regenerated instead of showing "generating" forever.
        logger.error(
          { ticketId, orgId, db: pgErrorFacts(err), model: credit.model.modelId },
          "ticket summary: the summary was generated but could not be stored",
        )
        await failSummary("store_failed")
        return JSON.stringify({ error: "store_failed" })
      }
      if (!updated) return JSON.stringify({ skipped: "missing_ticket" })
      await broadcastEphemeral({
        app: "tickets",
        entity: "ticket",
        action: "summary_updated",
        entityId: ticketId,
        orgId,
        actorId: null,
        actorType: "system",
        data: {
          ticketId,
          summary: summaryText,
          summaryAt: toIso(updated.summaryAt),
          // A completed generation MUST carry the terminal status, otherwise the
          // client's per-ticket status map stays pinned on "generating" and the
          // summary card spins forever ("Generating…"/"Updating…") even though the
          // text already arrived — the error path already sends summaryStatus.
          summaryStatus: "idle",
          model: credit.model.modelId,
          tokenUsage: usage,
        },
      })
      return JSON.stringify({ ok: true })
    },

    pubsub_verifyGoogleOidcJwt: async (
      token: string,
      expectedAudience: string,
      expectedServiceAccount: string,
    ): Promise<string> => {
      const { verifyGoogleOidcJwt } = await import("~/modules/webhooks/google-oidc")
      const result = await verifyGoogleOidcJwt(token, {
        expectedAudience,
        expectedServiceAccount,
        issuer: process.env.TICKETS_GMAIL_PUSH_ISSUER,
        jwksUrl: process.env.TICKETS_GMAIL_PUSH_JWKS_URL,
      })
      return JSON.stringify(result)
    },

    tickets_attentionItems: async (): Promise<string> => {
      if (appName !== "tickets") {
        throw new Error("tickets_attentionItems is only available to the tickets app")
      }
      const { computeAttentionItems } = await import("~/apps/tickets/attention")
      return JSON.stringify(await computeAttentionItems(txDb as never, orgId, userId))
    },
  }
}
