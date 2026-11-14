// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql as drizzleSql, eq } from "drizzle-orm"
import { afterMcpConnectionLifecycle } from "~/apps/mcp-manager/service/access"
import { acknowledgeCommittedTicket } from "~/apps/tickets/ack-after-commit"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agents, userRoles } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import {
  type DurableEventContext,
  registerDurableEventConsumer,
} from "~/infra/events/durable-consumers"
import { type AppEvent, HANDLER_TIMEOUT_MS, onEvent } from "~/infra/events/event-bus"
import type { WebSocketManager } from "~/infra/websocket"
import { eventsLogger as log } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"
import { syncPersonalAgentCeilingsForEvent } from "~/modules/agent/directory/personal-agent"
import { registerApprovalMaterializeConsumer } from "~/modules/approvals/prompt-materialize"
import { handleWithdrawOnEvent } from "~/modules/approvals/withdraw-on-events"
import { noteOrgPrincipalsChanged } from "~/modules/apps/org-apps"
import {
  isApprovalAuditEntity,
  redactApprovalAuditChanges,
  redactUserAuditChanges,
} from "~/modules/audit/approval-redaction"
import { type AuditEntry, isUnknownAgentFkError, writeAuditLog } from "~/modules/audit/service"
import { generateTimelineEntries } from "~/modules/audit/timeline"
import { handleCompanyOwnershipEvent } from "~/modules/contacts/company-unowned"
import { registerDemoConnectionExtension } from "~/modules/demo/demo-connected-ttl"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"
import {
  MAIL_CONTENT_ENTITIES,
  MAIL_CONTENT_KEYS,
} from "~/modules/mailbox-crypto/content-suppression"
import { onCatalogEvent } from "~/modules/mcp/catalog-notifier"
import { applyMcpConnectionEvent } from "~/modules/mcp-client/index"
import { handleResourceUpdated } from "~/modules/mcp-client/resource-notifier"
import { registerNodeSessionPostBack } from "~/modules/node-sessions/post-back"
import { registerReadSyncConsumer } from "~/modules/notifications/read-sync"
import { registerPushFanoutConsumer } from "~/modules/push/fanout-consumer"
import { registerNodeSessionPush } from "~/modules/push/node-session-push"

// F1 — wall-clock cap on the durable WS fan-out. A wedged socket send must not
// stall the outbox (it awaits this consumer before stamping processed_at). Reuse
// the event-bus handler-timeout budget (E1) so all dispatch caps share one knob.
let _wsFanoutTimeoutMs = HANDLER_TIMEOUT_MS

async function enrichMailFanoutData(event: {
  app: string
  entity: string
  entityId?: string
  orgId?: string
  data?: unknown
}): Promise<unknown> {
  if (event.app !== "mail") return event.data
  if (event.entity !== "conversation" && event.entity !== "message" && event.entity !== "account") {
    return event.data
  }
  if (!event.orgId || !UUID_RE.test(event.orgId)) return event.data

  const data = (event.data && typeof event.data === "object" ? event.data : {}) as Record<
    string,
    unknown
  >
  const existingAccountId =
    typeof data._inboxAccountId === "string"
      ? data._inboxAccountId
      : typeof data.accountId === "string"
        ? data.accountId
        : undefined

  // Resolved per call, like every other app-schema read: a hard-coded
  // `app_mail` misses the row under a schema prefix, and a miss drops the
  // owner check below to the `mail:inbox` grant, which a personal mailbox's
  // owner does not hold, so the owner never received their own mailbox events.
  const mailSchema = drizzleSql.raw(quoteIdent(schemaRef("app_mail")))

  try {
    const [row] = await withPrivilegedDb(event.orgId, "mail-ws-fanout-scope", async (tx) => {
      if (event.entity === "account") {
        const accountId = existingAccountId ?? event.entityId
        if (!accountId) return []
        return extractRows<{ account_id: string; owner_type: string; owner_id: string | null }>(
          await tx.execute(drizzleSql`
            SELECT id AS account_id, owner_type, owner_id
            FROM ${mailSchema}.accounts
            WHERE id = ${accountId} AND org_id = ${event.orgId}
            LIMIT 1
          `),
        )
      }

      if (event.entity === "conversation") {
        const conversationId = event.entityId ?? (typeof data.id === "string" ? data.id : undefined)
        if (!conversationId) return []
        return extractRows<{ account_id: string; owner_type: string; owner_id: string | null }>(
          await tx.execute(drizzleSql`
            SELECT account_id, owner_type, owner_id
            FROM ${mailSchema}.conversations
            WHERE id = ${conversationId} AND org_id = ${event.orgId}
            LIMIT 1
          `),
        )
      }

      const messageId = event.entityId ?? (typeof data.id === "string" ? data.id : undefined)
      if (!messageId) return []
      return extractRows<{ account_id: string; owner_type: string; owner_id: string | null }>(
        await tx.execute(drizzleSql`
          SELECT account_id, owner_type, owner_id
          FROM ${mailSchema}.messages
          WHERE id = ${messageId} AND org_id = ${event.orgId}
          LIMIT 1
        `),
      )
    })

    if (!row) return event.data
    return {
      ...data,
      _inboxAccountId: row.account_id,
      _mailOwnerType: row.owner_type,
      _mailOwnerId: row.owner_id,
    }
  } catch (err) {
    log.error(
      { err, entity: event.entity, entityId: event.entityId },
      "Mail WS scope enrichment error",
    )
    return event.data
  }
}

/** Entity types that represent permission changes */
const PERMISSION_ENTITIES = new Set([
  "role_assignment",
  "user_scope",
  "user_dimension",
  "role_scope",
  "role_dimension",
])

/**
 * Strip raw PII from audit changes before they are persisted to
 * `kernel.audit_log.changes`. Shared by the durable audit consumer and the
 * outbox-bypass fallback so both paths persist the same redacted shape.
 *
 *   - `message` create/update → drop raw content, keep only `contentLength` (S6).
 *   - `auth` events (login / login_fail / …) → drop the raw email (erasure-002).
 *     The audit RECORD itself is a security/legal basis and must survive user
 *     erasure (see KERNEL_USER_COLUMN_DISPOSITION → audit_log.actor_id RETAIN),
 *     but the user's raw email must NOT be retained indefinitely inside it.
 *     Redacting at ingestion keeps the event (who/when/why) without the PII.
 */
function stripMessageContentForAudit(event: AppEvent): unknown {
  if (isApprovalAuditEntity(event.entity)) {
    return redactApprovalAuditChanges(event.data)
  }
  if (event.app === "kernel" && event.entity === "user") {
    return redactUserAuditChanges(event.data)
  }
  if (event.entity === "auth") {
    return stripAuthEmailForAudit(event.data)
  }
  if (event.app === "mail") {
    return stripMailContentForAudit(event)
  }
  // A dashboard table's row events carry ids and changed keys only; keep exactly those, so no
  // cell value can ever reach the org-wide audit log (a restricted table's rows stay its own).
  if (event.app === "kernel" && event.entity === "dashboard_table_row") {
    const d = (event.data ?? {}) as Record<string, unknown>
    return { tableId: d.tableId, rowId: d.rowId, changeId: d.changeId, changed: d.changed }
  }
  if (event.entity !== "message" || (event.action !== "create" && event.action !== "update")) {
    return event.data
  }
  const data = event.data as Record<string, unknown> | undefined
  if (!data || !("content" in data)) return event.data
  const { content, ...rest } = data
  return {
    ...rest,
    contentLength: typeof content === "string" ? content.length : 0,
  }
}

/**
 * Invariant K, second line of defence: no mail content in `audit_log.changes`.
 *
 * SCOPED TO `event.app === "mail"`, deliberately. `event.app` is available at
 * both call sites, so this can key on it instead of becoming a global content
 * filter that would strip a ticket subject or a Shopify order note.
 *
 * The fix proper is at the emit (Task 6.1): the payload never carries the
 * content in the first place. This exists so a new mail event shape, a widened
 * projection or an app rollback cannot reopen the hole in a table the Phase 12
 * purge does not reach. Each removed field leaves a `<field>Length` marker so
 * the audit record stays diagnostic.
 *
 * It is unconditional on encryption state, unlike the emit-site strip: an audit
 * record has no need of the subject either way, and making it conditional would
 * mean a privileged account lookup per audited event.
 */
function stripMailContentForAudit(event: AppEvent): unknown {
  const data = event.data
  if (!data || typeof data !== "object" || Array.isArray(data)) return data
  if (!MAIL_CONTENT_ENTITIES.has(event.entity)) return data
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!MAIL_CONTENT_KEYS.has(key)) {
      out[key] = value
      continue
    }
    out[`${key}Length`] = typeof value === "string" ? value.length : 0
  }
  return out
}

/**
 * Remove the raw email from an `auth` event's data before it lands in the audit
 * log. The entity id already carries the user id (the durable identifier), so
 * the email is redundant PII here. Non-email fields (e.g. `login_fail.reason`)
 * are preserved so the audit record stays useful.
 */
function stripAuthEmailForAudit(data: unknown): unknown {
  if (!data || typeof data !== "object") return data
  if (!("email" in (data as Record<string, unknown>))) return data
  const { email: _email, ...rest } = data as Record<string, unknown>
  return rest
}

/**
 * Durable timeline consumer (I-EVT-1). Runs inside the outbox transaction
 * before the event is marked processed; on throw the row stays unprocessed and
 * the outbox retries (and eventually dead-letters). Idempotent via `eventId`
 * (timeline rows are inserted with `onConflictDoNothing` keyed on the event id),
 * so a replay after a crash is a no-op. This is an at-least-once guarantee —
 * unlike the previous fire-and-forget `onEvent` handler, a transient failure or
 * crash can no longer silently drop the timeline entry.
 */
async function timelineDurableHandler(ctx: DurableEventContext): Promise<void> {
  const event = ctx.event
  if (event.ephemeral) return
  if (!event.entityId) return
  if (!event.orgId || !UUID_RE.test(event.orgId)) return
  await withRlsContext({ actorType: "system", orgId: event.orgId, purpose: "timeline" }, (tx) =>
    generateTimelineEntries(
      tx,
      {
        orgId: event.orgId,
        app: event.app,
        entity: event.entity,
        action: event.action,
        entityId: event.entityId!,
        userId: event.actorId || null,
        actorType: event.actorType,
        data: event.data,
        eventId: ctx.eventId,
      },
      { propagateErrors: true },
    ),
  )
}

/**
 * Which of 0070's TWO causes refused this agent id.
 *
 * The key is COMPOSITE over (agent_id, org_id), so `audit_log_agent_org_fk`
 * raises the same constraint name whether the agent was DELETED or belongs to
 * ANOTHER ORG — and those mean opposite things. The first is ordinary
 * lifecycle. The second says something upstream is already broken (a bug, or an
 * attempt), and nulling it in silence spends the alarm for nothing.
 *
 * The constraint name cannot separate them, so the DATABASE is asked which it
 * is. That question runs on the ERROR PATH ONLY, after the insert has already
 * been refused, so the happy path pays nothing for the distinction.
 */
type AgentFkCause =
  | { kind: "deleted" }
  | { kind: "cross-org"; agentOrgId: string }
  | { kind: "present" }
  | { kind: "undiagnosed"; probeError: unknown }

async function classifyAgentFkFailure(agentId: string, rowOrgId: string): Promise<AgentFkCause> {
  try {
    // Privileged, because the whole question is whether this id lives in a
    // DIFFERENT org — which an org-scoped read is by construction unable to
    // see, and would report as a deletion.
    const rows = await withPrivilegedDb(rowOrgId, "audit-agent-fk-diagnosis", (tx) =>
      tx.select({ orgId: agents.orgId }).from(agents).where(eq(agents.id, agentId)).limit(1),
    )
    const found = rows[0]
    if (!found) return { kind: "deleted" }
    if (found.orgId !== rowOrgId) return { kind: "cross-org", agentOrgId: found.orgId }
    return { kind: "present" }
  } catch (probeError) {
    // The diagnosis is a nicety; the audit row is not. A failed probe must
    // never turn a recoverable insert into a lost record.
    return { kind: "undiagnosed", probeError }
  }
}

/**
 * Say which cause it was, at the level that cause deserves.
 *
 * Every kind gets its OWN `case`, and the `default` asserts the union is
 * exhausted. `deleted` used to be handled by the `default` itself, which meant
 * any kind added to `AgentFkCause` later would silently claim the agent "no
 * longer exists" — a statement that would be provably false and would send
 * whoever reads it at 3am the wrong way. With the assertion below, a new kind
 * fails to COMPILE here instead.
 */
function reportAgentFkCause(
  cause: AgentFkCause,
  agentId: string,
  orgId: string,
  action: string,
  retryingWithAgentId: boolean,
): void {
  switch (cause.kind) {
    case "cross-org":
      // The stored-data guarantee is intact either way: the id is nulled by the
      // caller, so no cross-org id is ever written. What must NOT happen is
      // silence. This is the anomaly, so it is reported as one, naming the
      // row's own org and the org the agent actually lives in — and the row
      // still lands, because losing it would help nobody.
      log.error(
        { agentId, rowOrgId: orgId, agentOrgId: cause.agentOrgId, action },
        "Audit row named an agent of a different org - upstream integrity anomaly, recording no agent",
      )
      return
    case "present":
      // The probe proved the agent is alive HERE, so the refusal was a race and
      // the id is retried rather than dropped. Which of the two happened is the
      // difference between keeping the attribution and losing it, so the
      // message says which.
      log.warn(
        { agentId, orgId, action, retryingWithAgentId },
        retryingWithAgentId
          ? "Audit row agent id was refused but the agent is present in this org - a concurrent write, retrying with the agent id"
          : "Audit row agent id was refused twice while the agent is present in this org - recording no agent",
      )
      return
    case "undiagnosed":
      log.warn(
        { err: cause.probeError, agentId, orgId, action },
        "Audit row named an agent id the foreign key refused, and the cause could not be determined - recording no agent",
      )
      return
    case "deleted":
      log.warn(
        { agentId, orgId, action },
        "Audit row named an agent that no longer exists - recording no agent",
      )
      return
    default: {
      // Exhaustiveness. `cause` is `never` here only while every kind above has
      // its own case, so adding a kind to `AgentFkCause` (or deleting one of
      // the cases) is a TYPE error, not a wrong log line at runtime. The
      // runtime arm stays deliberately vague and never throws: this runs inside
      // the recovery, and a throw here would cost the audit row itself.
      const unhandled: never = cause
      log.warn(
        { agentId, orgId, action, cause: (unhandled as AgentFkCause).kind },
        "Audit row named an agent id the foreign key refused - recording no agent",
      )
      return
    }
  }
}

/**
 * Write ONE audit row in its OWN transaction, retrying when 0070's composite
 * foreign key refuses the agent id: once KEEPING the id if the probe proves the
 * agent is alive in this org, then once with a null agent.
 *
 * THE RETRY MUST OWN THE TRANSACTION BOUNDARY. Postgres aborts a transaction on
 * its first failed statement: every later statement returns 25P02 until
 * rollback. So the recovery cannot live inside `writeAuditLog`, which is handed
 * an already-open tx — the second insert there could never commit. This loop
 * therefore sits OUTSIDE `withRlsContext` and the retry runs in a brand new
 * transaction, exactly as the approval retries sit outside `withPrivilegedDb`
 * in `modules/apps/execute-tool.ts`.
 *
 * Reachable without anyone inventing an id: an agent DELETED after the event
 * naming it was queued. The composite FK SET NULLs the rows that already exist
 * (so the approval card survives), but the queued event still carries the dead
 * agent's id, so the audit insert is refused with 23503. Left to escape, the
 * durable consumer throws, the outbox retries and dead-letters the event at
 * MAX_ATTEMPTS, and the audit row is lost ENTIRELY — which is the outcome A11
 * exists to prevent. A dead agent costs the agent's NAME, never the record.
 *
 * `required: true` is what lets the failure REACH this loop; the best-effort
 * branch inside `writeAuditLog` would swallow it and the retry would never run.
 * Callers that want best-effort semantics swallow at their own boundary.
 * The retry runs only after a failure, so the happy path costs nothing — and
 * neither does the cause diagnosis, which runs inside the same catch.
 *
 * The REPORT differs by cause (see `reportAgentFkCause`): a deleted agent is
 * lifecycle and warns; an agent that exists in another org is an upstream
 * integrity anomaly and is reported at error level. So does the RECOVERY, in
 * one case. A `present` agent is neither dead nor foreign: the probe has just
 * proven the id names a live agent of this very org, so the refusal was a race
 * and the retry keeps the id rather than throwing away a valid attribution
 * A11 never asked for. If that retry fails too the id goes, because losing the
 * ROW remains the one outcome this loop exists to prevent.
 *
 * `outcomeReportedByCaller` is what stops the recovery from paging: this loop
 * knows how the row ended, `writeAuditLog` does not.
 */
/**
 * At most TWO recoveries per row: one that may KEEP the agent id (the `present`
 * race), one that drops it. The attempt counter is what bounds the loop, and it
 * has to be: on the `present` branch the id survives the first recovery, so
 * "stop once the id is null" would not terminate this loop at all.
 */
const MAX_AGENT_FK_RECOVERIES = 2

async function writeAuditRowInOwnTx(orgId: string, entry: AuditEntry): Promise<void> {
  // What the ROW named, fixed for the whole loop. `agentId` is what the current
  // attempt carries, which is the only thing a recovery changes.
  const namedAgentId = entry.agentId ?? null
  let agentId = namedAgentId
  for (let attempt = 0; ; attempt++) {
    try {
      await withRlsContext({ actorType: "system", orgId, purpose: "audit" }, (tx) =>
        // A fresh object per attempt: `writeAuditLog` normalizes in place.
        writeAuditLog(tx, { ...entry, agentId }, { required: true, outcomeReportedByCaller: true }),
      )
      return
    } catch (err) {
      if (
        attempt >= MAX_AGENT_FK_RECOVERIES ||
        namedAgentId === null ||
        !isUnknownAgentFkError(err)
      ) {
        throw err
      }
      const cause = await classifyAgentFkFailure(namedAgentId, orgId)
      // The one branch worth retrying WITH the id: the probe has just proven
      // this agent exists and belongs to THIS org, so the refusal was a race
      // with a concurrent write and the attribution is still true. A11 costs a
      // DEAD agent its name; this agent is not dead. Every other cause, and any
      // SECOND failure, drops the id instead.
      const keepAgentId = attempt === 0 && cause.kind === "present"
      reportAgentFkCause(cause, namedAgentId, orgId, entry.action, keepAgentId)
      agentId = keepAgentId ? namedAgentId : null
    }
  }
}

/**
 * Durable audit consumer (I-EVT-1). Same durability contract as the timeline
 * consumer: errors propagate so the outbox retries instead of silently losing
 * the audit record. Idempotent via `eventId` (`writeAuditLog` uses
 * `onConflictDoNothing` on the event id).
 */
async function auditDurableHandler(ctx: DurableEventContext): Promise<void> {
  const event = ctx.event
  if (event.ephemeral) return
  if (!event.orgId || !UUID_RE.test(event.orgId)) return

  const auditChanges = stripMessageContentForAudit(event)

  // Durable consumer: insert failures propagate so the outbox retries instead
  // of silently losing the audit record (I-EVT-1) — except an agent id that no
  // longer names a row, which is recovered inside rather than dead-lettered.
  await writeAuditRowInOwnTx(event.orgId, {
    orgId: event.orgId,
    actorId: event.actorId || null,
    actorType: event.actorType ?? "user",
    app: event.app,
    entityType: event.entity,
    entityId: event.entityId,
    // Audit action format: "entity.action" (e.g., "thread.create", "user.deactivate")
    action: `${event.entity}.${event.action}`,
    changes: auditChanges,
    metadata: event.metadata,
    eventId: ctx.eventId,
    // A11 — the acting agent rides the envelope. It cannot be read from the
    // run frame here: this consumer runs in the outbox worker, outside the
    // turn's async context, so `currentRunContext()` is always undefined.
    agentId: event.agentId ?? null,
  })
}

/**
 * Outbox-bypass audit/timeline fallback. The durable audit + timeline consumers
 * above run ONLY from the outbox worker (`runDurableConsumers`), so events that
 * reach the event bus WITHOUT going through the outbox — notably MCP tool-call
 * audit events published directly via `_publishEventInternal`
 * (`modules/mcp-client/index.ts` `emitAuditEvent`) — would otherwise never be
 * persisted, silently dropping the entire MCP tool-call audit trail.
 *
 * This best-effort `onEvent` handler closes that gap by auditing exactly the
 * events the durable path misses:
 *   - `_eventId` present  → the event came through the outbox; the durable
 *     consumer already persisted it. Skip (never double-write).
 *   - `_remote` true      → published by another process's outbox and already
 *     audited at the origin (single-writer discipline, mirrors the WS replay
 *     buffer). The handler is registered `once`, so the bus never hands it a
 *     peer's `_remote` copy.
 *   - ephemeral           → never audited. Skip.
 * Errors are swallowed (audit is best-effort on this path, matching the
 * pre-I-EVT-1 behavior for direct publishes); there is no outbox row to retry.
 */
async function auditTimelineBypassFallback(event: AppEvent): Promise<void> {
  if (event.ephemeral) return
  // Events that flowed through the outbox carry the outbox row id; the durable
  // consumer has already persisted them. `_eventId` is stamped by the outbox
  // worker and not part of the public AppEvent shape.
  const eventId = (event as AppEvent & { _eventId?: string })._eventId
  if (eventId) return
  if (!event.orgId || !UUID_RE.test(event.orgId)) return

  try {
    // Same dead-agent recovery as the durable path: this consumer carries the
    // same agent id and hits the same composite FK, so without it a deleted
    // agent would lose the MCP tool-call audit trail here instead. Errors stay
    // swallowed at THIS boundary (best-effort, as before): there is no outbox
    // row to retry, so the caller's catch below is the only backstop.
    await writeAuditRowInOwnTx(event.orgId, {
      orgId: event.orgId,
      actorId: event.actorId || null,
      actorType: event.actorType ?? "user",
      app: event.app,
      entityType: event.entity,
      entityId: event.entityId,
      action: `${event.entity}.${event.action}`,
      changes: stripMessageContentForAudit(event),
      metadata: event.metadata,
      // Same identity on the bypass path, or this consumer would be a hole in
      // the agent-attribution trail the durable one keeps (A11).
      agentId: event.agentId ?? null,
    })
  } catch (err) {
    log.error({ err, app: event.app, entity: event.entity }, "Audit fallback (bypass) error")
  }

  if (!event.entityId) return
  try {
    await withRlsContext({ actorType: "system", orgId: event.orgId, purpose: "timeline" }, (tx) =>
      generateTimelineEntries(tx, {
        orgId: event.orgId,
        app: event.app,
        entity: event.entity,
        action: event.action,
        entityId: event.entityId!,
        userId: event.actorId || null,
        actorType: event.actorType,
        data: event.data,
      }),
    )
  } catch (err) {
    log.error({ err, app: event.app, entity: event.entity }, "Timeline fallback (bypass) error")
  }
}

export function registerEventSubscribers(wsManager?: WebSocketManager): void {
  // Audit + timeline are at-least-once durable consumers (I-EVT-1): the outbox
  // awaits them before marking the event processed and retries on failure.
  // Registered idempotently (keyed by name) so repeated calls (tests, hot
  // reload) overwrite rather than stack.
  registerDurableEventConsumer("timeline", timelineDurableHandler)
  registerDurableEventConsumer("audit", auditDurableHandler)

  // Mobile push fanout (S17). Durable for the same reason audit is: a
  // notification the outbox believed it delivered, and did not, is invisible.
  // The handler never throws, so it cannot hold an outbox row hostage.
  registerPushFanoutConsumer()

  // Rule 5: a read on any device sends the person's phones the new badge.
  registerReadSyncConsumer()

  // A node session that starts waiting on its owner pushes their devices once
  // per transition (P4-T08), from the waiting hook after the ingest commit.
  registerNodeSessionPush()

  // A dispatch session that ends done by its own signal posts its result back
  // into the conversation that dispatched it, once per end (S60).
  registerNodeSessionPostBack()

  // A new approval is materialized for its approvers at once, so its push does
  // not wait for the once-a-minute materializer job (P1-T12).
  registerApprovalMaterializeConsumer()

  // Demo instance only: a visitor workspace that completes a real outside
  // connection (an app account, an MCP OAuth consent) lives longer.
  if (isDemoModeEnabled()) registerDemoConnectionExtension()

  // Outbox-bypass fallback: durable consumers only fire from the outbox worker,
  // so events published directly via `_publishEventInternal` (e.g. MCP tool-call
  // audit events) would lose their audit/timeline rows. This handler audits
  // exactly those bypass events and never double-writes outbox-handled ones.
  onEvent(auditTimelineBypassFallback, { delivery: "once", name: "audit-timeline-bypass" })

  // MCP catalog-change notifier (Phase 12) — debounced
  // notifications/tools/list_changed for active MCP connections whose owner's
  // tool catalog could have changed (app lifecycle / permission change).
  onEvent(
    async (event) => {
      if (event.ephemeral) return
      try {
        onCatalogEvent({
          orgId: event.orgId,
          entity: event.entity,
          action: event.action,
          data: event.data,
        })
      } catch (err) {
        log.error({ err, entity: event.entity }, "MCP catalog notifier error")
      }
    },
    // Each process notifies its own streaming MCP sessions.
    { delivery: "per-replica" },
  )

  // Who keeps a restricted app is resolved at load (role members, `*`
  // holders): a committed role assignment or scope change reloads the org's
  // app state in every process, so the restriction follows it at once. Only
  // the publishing process's copy also publishes the peer invalidation.
  onEvent(
    async (event) => {
      if (event.ephemeral) return
      try {
        await noteOrgPrincipalsChanged(event)
      } catch (err) {
        log.warn(
          { err, entity: event.entity },
          "org app state reload after a permission change failed; TTL converges",
        )
      }
    },
    // Each process reloads its own cached org app state.
    { delivery: "per-replica" },
  )

  // MCP client connection lifecycle: each process holds its own projected
  // tools, slug index, health gate and pool, so a connection deleted (or
  // disabled / enabled) on one node is applied on every node from its event.
  // Without it a peer kept offering a deleted server's tools until a restart.
  onEvent(
    async (event) => {
      if (event.ephemeral) return
      if (event.app !== "mcp_manager" || event.entity !== "connection") return
      try {
        await applyMcpConnectionEvent(event)
      } catch (err) {
        log.error({ err, action: event.action }, "mcp_manager:connection handler error")
      }
    },
    { delivery: "per-replica" },
  )
  // A ticket's creation acknowledgement goes out once the ticket has committed
  // (the inbound-mail path runs inside its caller's transaction, so it cannot
  // send it itself). It writes and sends mail: once, on the outbox's process.
  onEvent(acknowledgeCommittedTicket, { delivery: "once", name: "tickets-ack-after-commit" })

  // A company's manager changed, or a person who left came back: the previous manager's Home
  // row and the admins' unowned rows follow, once, after the change committed.
  onEvent(handleCompanyOwnershipEvent, { delivery: "once", name: "company-ownership-follow-up" })

  // An address opted out: the waiting commercial drafts to it are withdrawn, once, after the
  // opt-out committed (the send check refuses them anyway; this takes them off Home).
  onEvent(handleWithdrawOnEvent, { delivery: "once", name: "suppression-withdraw-drafts" })

  // An org server added or deleted: members' tokens and personal agent ceilings follow,
  // once, on the process that published the event (a peer's copy never reaches it).
  onEvent(
    async (event) => {
      if (event.ephemeral) return
      if (event.app !== "mcp_manager" || event.entity !== "connection") return
      try {
        await afterMcpConnectionLifecycle(event)
      } catch (err) {
        log.error(
          { err, action: event.action, orgId: event.orgId },
          "mcp_manager:connection access follow-up failed",
        )
      }
    },
    { delivery: "once", name: "mcp-connection-lifecycle" },
  )

  // MCP inbound-client resource update subscriber (Phase 15 — Task 33). Routes
  // notifications/resources/updated to the right surface (agent thread msg
  // or user WS frame) based on the queued payload's subscriber_actor_type.
  // An agent subscriber's thread message is written once (the publishing
  // process); a user subscriber's WS frame goes out from every process to its
  // own sockets.
  const isResourceUpdated = (event: AppEvent): boolean =>
    !event.ephemeral &&
    event.app === "mcp" &&
    event.entity === "resource" &&
    event.action === "updated"
  onEvent(
    async (event) => {
      if (!isResourceUpdated(event)) return
      try {
        await handleResourceUpdated(event, "agent")
      } catch (err) {
        log.error({ err, entity: event.entity }, "mcp:resource:updated agent handler error")
      }
    },
    { delivery: "once", name: "mcp-resource-updated-agent" },
  )
  onEvent(
    async (event) => {
      if (!isResourceUpdated(event)) return
      try {
        await handleResourceUpdated(event, "user")
      } catch (err) {
        log.error({ err, entity: event.entity }, "mcp:resource:updated user handler error")
      }
    },
    { delivery: "per-replica" },
  )

  // WebSocket fan-out.
  //
  // DURABLE for stored events (F1): the buffer-then-broadcast for persisted
  // events runs as a DURABLE consumer (`ws-fanout`), which the outbox worker
  // awaits BEFORE it stamps `processed_at`. This closes the crash window where an
  // event was marked processed before it landed in the WS replay buffer — now
  // `processed_at` implies "in the replay buffer". Because durable consumers run
  // per-event inside the sequential outbox loop, fan-out is also strictly
  // outbox-ordered (fixing out-of-order broadcasts for free).
  //
  // Delivery semantics: the replay-buffer zadd happens FIRST inside
  // `bufferAndBroadcast`; only a Redis/buffer failure throws (→ outbox retries,
  // correctly, since the event is not yet buffered). A hung/failed SOCKET send is
  // best-effort: `bufferAndBroadcast` already swallows per-client send errors, and
  // we additionally cap the whole call with a wall-clock timeout so one wedged
  // socket cannot stall the outbox — on timeout we log and RETURN SUCCESS (the
  // buffer write already happened; socket delivery is at-most-once and the client
  // replays on reconnect).
  //
  // EPHEMERAL events (typing/presence/sub_run running-deltas) still fan out via
  // the fire-and-forget `onEvent` path below — they have no outbox row, are never
  // buffered, and must not block the (non-existent) completion.
  if (wsManager) {
    const applyMembershipMap = (event: AppEvent): void => {
      // Update thread membership map before broadcasting participant events so
      // the newly-added user receives their own participant:add event and a
      // removed user stops receiving events immediately.
      if (event.app === "kernel" && event.entity === "participant") {
        const data = event.data as { threadId?: string; userId?: string } | undefined
        if (data?.threadId && data?.userId) {
          if (event.action === "add") {
            wsManager.addThreadMember(data.userId, data.threadId)
          } else if (event.action === "remove") {
            wsManager.removeThreadMember(data.userId, data.threadId)
          }
        }
      }
    }

    const buildFanoutPayload = async (event: AppEvent) => ({
      app: event.app,
      entity: event.entity,
      action: event.action,
      entityId: event.entityId,
      data: await enrichMailFanoutData(event),
      orgId: event.orgId,
      actorId: event.actorId,
    })

    // Durable consumer for STORED (non-ephemeral) events — runs before
    // processed_at is stamped (outbox-worker.ts phase 2a).
    registerDurableEventConsumer("ws-fanout", async (ctx) => {
      const event = ctx.event
      if (event.ephemeral) return // ephemeral events never ride the outbox

      applyMembershipMap(event)
      const payload = await buildFanoutPayload(event)

      // Single-writer replay buffer: use the id assigned once at publish time and
      // only buffer in the originating process (remote events are broadcast-only).
      // The zadd is the FIRST thing bufferAndBroadcast does — a Redis/buffer
      // failure rejects here and (correctly) propagates so the outbox retries.
      // A hung socket send is capped by the timeout and treated as success.
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          resolve()
        }, _wsFanoutTimeoutMs)
      })
      // Keep a handle on the broadcast promise so that if the timeout wins the
      // race we still OBSERVE the losing promise. Without this, a rejection that
      // arrives AFTER the timeout fired lands on an unobserved promise and
      // surfaces as an unhandledRejection (process-level fatal handler). Attach
      // a .catch that logs (scrubbed) ONLY once the timeout has already fired —
      // the buffer write happened first, so a late socket-delivery failure is
      // best-effort and must not crash the worker. A fast reject (before the
      // timeout) still propagates out of the race below so the outbox retries,
      // and this guard keeps it from being double-logged as a post-settle error.
      const broadcast = wsManager.bufferAndBroadcast(payload, event._wsEventId, !event._remote)
      broadcast.catch((err) => {
        if (timedOut) {
          log.error(
            { err, app: event.app, entityId: event.entityId },
            "WebSocket fan-out broadcast rejected after timeout — buffered, socket delivery best-effort",
          )
        }
      })
      try {
        await Promise.race([broadcast, timeout])
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (timedOut) {
        // Buffer write already happened first; only socket delivery could still be
        // in flight. Log and succeed — do NOT throw (throwing = outbox retry, which
        // would re-buffer + re-broadcast an already-buffered event).
        log.error(
          { app: event.app, entityId: event.entityId },
          "WebSocket fan-out timed out — buffered, socket delivery best-effort",
        )
      }
    })

    // Fire-and-forget fan-out for events the durable consumer does NOT cover:
    //   - EPHEMERAL events (typing/presence/etc) — no outbox row, never buffered.
    //   - REMOTE stored events (`_remote`, arrived via the Redis subscriber from
    //     another process) — the ORIGIN process already buffered them via the
    //     durable consumer (single-writer replay buffer); this process only needs
    //     to broadcast them to its LOCAL sockets, broadcast-only (no re-buffer).
    // Local stored events are handled exclusively by the durable ws-fanout
    // consumer above, so this handler skips them to avoid a double broadcast.
    onEvent(
      async (event) => {
        if (!event.ephemeral && !event._remote) return
        try {
          applyMembershipMap(event)
          const payload = await buildFanoutPayload(event)
          if (event.ephemeral) {
            await wsManager.broadcast(payload)
          } else {
            // Remote stored event: broadcast with the origin-assigned replay id but
            // do NOT write the buffer (shouldBuffer=false — the origin is the single
            // writer).
            await wsManager.bufferAndBroadcast(payload, event._wsEventId, false)
          }
        } catch (err) {
          log.error({ err, app: event.app }, "WebSocket fan-out error (ephemeral/remote)")
        }
      },
      // Every process broadcasts to its own sockets.
      { delivery: "per-replica" },
    )

    // Permission change handler — close affected users' WS connections to trigger token refresh.
    // The client reconnect flow calls ensureFreshToken() which re-reads permissions from DB.
    onEvent(
      async (event) => {
        if (event.app !== "kernel") return
        if (event.ephemeral) return

        // User deactivation — close all WS connections immediately (H-2)
        if (event.entity === "user" && event.action === "deactivate" && event.entityId) {
          log.debug({ userId: event.entityId }, "Closing WS for deactivated user")
          wsManager.closeConnectionsForUser(event.entityId, 4010, "user_deactivated")
          return
        }

        if (!PERMISSION_ENTITIES.has(event.entity)) return

        const data = event.data as Record<string, unknown> | undefined
        if (!data) return

        try {
          // User-targeted events (role_assignment, user_scope, user_dimension)
          if (data.targetUserId && typeof data.targetUserId === "string") {
            log.debug(
              { userId: data.targetUserId, entity: event.entity, action: event.action },
              "Closing WS for permission refresh",
            )
            wsManager.closeConnectionsForUser(data.targetUserId)
            return
          }

          // Workspace app state/access changes (S19, S20) name every affected member.
          if (Array.isArray(data.targetUserIds)) {
            for (const userId of data.targetUserIds) {
              if (typeof userId === "string") wsManager.closeConnectionsForUser(userId)
            }
            return
          }

          // Role-level events (role_scope, role_dimension) — find all users with that role
          if (data.roleId && typeof data.roleId === "string") {
            const rows = await withPrivilegedDb(event.orgId!, "permission-refresh-lookup", (tx) =>
              tx
                .select({ userId: userRoles.userId })
                .from(userRoles)
                .where(eq(userRoles.roleId, data.roleId as string)),
            )
            for (const row of rows) {
              log.debug(
                { userId: row.userId, roleId: data.roleId, entity: event.entity },
                "Closing WS for role permission refresh",
              )
              wsManager.closeConnectionsForUser(row.userId)
            }
          }
        } catch (err) {
          log.error({ err, entity: event.entity }, "Permission refresh WS close error")
        }
      },
      // Every process closes the affected users' sockets it holds.
      { delivery: "per-replica" },
    )
  }

  // A grant change re-derives the personal agent ceilings it touches, from the
  // permission event its own transaction queued, so a person's own agent never
  // keeps a snapshot of what they held at signup (personal-agent.ts).
  // Registered AFTER the WebSocket fan-out: consumers run in registration
  // order and a throw stops the ones after it, so a failed recompute never
  // holds the event's frames back. It throws, so the outbox retries it (the
  // recompute is idempotent; the consumers before it are too, and a re-sent
  // frame carries the same event id, which clients drop as a duplicate).
  registerDurableEventConsumer("personal-agent-ceilings", async ({ event }) => {
    try {
      await syncPersonalAgentCeilingsForEvent(event)
    } catch (err) {
      log.error(
        { err, entity: event.entity, orgId: event.orgId },
        "Personal agent ceiling sync failed; the outbox retries the event",
      )
      throw err
    }
  })
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const EventSubscribersTestAccess = {
  /** Test-only — override the WS fan-out timeout so the wedge case can be exercised without waiting 60s. */
  setWsFanoutTimeoutMs(ms: number | null): void {
    _wsFanoutTimeoutMs = ms ?? HANDLER_TIMEOUT_MS
  },
}
