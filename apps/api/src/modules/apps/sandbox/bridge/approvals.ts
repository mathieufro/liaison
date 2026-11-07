// SPDX-License-Identifier: FSL-1.1-ALv2

import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"

/** Approval execution recording and handler-requested approvals. */
export function createApprovalsMethods(ctx: BridgeContext): Record<string, any> {
  const {
    appName,
    approvalContext,
    bridgeActingAgentId,
    bridgeOptions,
    bridgeSpawnParentFrame,
    bridgeTurnTaintScopes,
    orgId,
  } = ctx
  return {
    // Where one of THIS app's own approval requests stands (a job releasing work whose approval
    // was declined or expired): `{status, expired}` (`expired`: pending or deferred past its deadline,
    // before the sweep reaches it), or `{status:null}` for an id that is not an
    // approval of this app in this org. Status only: never the payload or who decided.
    approvals_statusOf: async (approvalRequestId: string): Promise<string> => {
      const id = String(approvalRequestId ?? "")
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
        return JSON.stringify({ status: null })
      const { withPrivilegedDb } = await import("~/db/privileged")
      const { extractRows } = await import("~/db")
      const { sql: drizzleSql } = await import("drizzle-orm")
      const { schemaRef } = await import("~/db/schema-ref")
      const KS = drizzleSql.raw(schemaRef("kernel"))
      const rows = await withPrivilegedDb(orgId, "approval-status-of", async (tx) =>
        extractRows<{ status: string; expired: boolean }>(
          await tx.execute(drizzleSql`
            SELECT status, (status IN ('pending', 'deferred') AND expires_at IS NOT NULL AND expires_at < now()) AS expired
            FROM ${KS}.approval_requests
            WHERE id = ${id} AND org_id = ${orgId} AND starts_with(tool_name, ${`${appName}:`})
            LIMIT 1`),
        ),
      )
      const r = rows[0]
      return JSON.stringify(
        r ? { status: r.status, expired: r.expired === true } : { status: null },
      )
    },

    // The approvals still awaiting a decision on this app's own tools whose payload carries
    // `payloadKey` (e.g. "finding_id"), newest first, optionally narrowed to some of this app's tool
    // names. An app derives "awaiting approval" for its own rows at read time from this, so a parked
    // call (the kernel gate parks an agent's call before the handler runs) shows on the row it
    // targets, and the row falls back to its stored state once the request is denied, expires or is
    // cancelled, with nothing written that can go stale. Org-pinned and limited to this app's tools
    // like `approvals_statusOf`; it returns the app's own staged payloads and never who decided.
    // Returns `[{id, tool_name, target_id, payload, created_at}]`.
    approvals_pendingFor: async (payloadKey: string, toolNamesJson?: string): Promise<string> => {
      const key = String(payloadKey ?? "")
      if (!/^[a-z_][a-z0-9_]{0,63}$/i.test(key)) return "[]"
      const prefix = `${appName}:`
      let toolNames: string[] | null = null
      if (toolNamesJson !== undefined && toolNamesJson !== null) {
        let parsed: unknown
        try {
          parsed = typeof toolNamesJson === "string" ? JSON.parse(toolNamesJson) : toolNamesJson
        } catch {
          return "[]"
        }
        toolNames = (Array.isArray(parsed) ? parsed : [parsed]).filter(
          (t): t is string => typeof t === "string" && t.startsWith(prefix),
        )
        if (toolNames.length === 0) return "[]"
      }
      const { withPrivilegedDb } = await import("~/db/privileged")
      const { extractRows } = await import("~/db")
      const { sql: drizzleSql } = await import("drizzle-orm")
      const { schemaRef } = await import("~/db/schema-ref")
      const KS = drizzleSql.raw(schemaRef("kernel"))
      const toolFilter =
        toolNames === null
          ? drizzleSql``
          : drizzleSql`AND tool_name IN (${drizzleSql.join(
              toolNames.map((t) => drizzleSql`${t}`),
              drizzleSql`, `,
            )})`
      const rows = await withPrivilegedDb(orgId, "approval-pending-for", async (tx) =>
        extractRows<{
          id: string
          tool_name: string
          target_id: string
          payload: unknown
          created_at: string | Date
        }>(
          await tx.execute(drizzleSql`
            SELECT id, tool_name, current_payload->>${key} AS target_id, current_payload AS payload, created_at
            FROM ${KS}.approval_requests
            WHERE org_id = ${orgId}
              AND starts_with(tool_name, ${prefix})
              ${toolFilter}
              AND status IN ('pending', 'deferred')
              AND (expires_at IS NULL OR expires_at >= now())
              AND current_payload->>${key} IS NOT NULL
            ORDER BY created_at DESC
            LIMIT 500`),
        ),
      )
      return JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          tool_name: r.tool_name,
          target_id: r.target_id,
          payload: r.payload,
          created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        })),
      )
    },

    // --- Approval bridge methods ---
    // These write to `kernel.approved_handler_executions`, the
    // approval-workflow's execution-tracking table. When the same handler
    // runs outside an approval (human direct call auto-execute past the
    // gate — see execute-tool.ts skipGateAsHumanApprover), there is no
    // approval row to attach to, so these become no-ops. The handler's
    // domain events + audit log still capture the action itself; only the
    // approval-lifecycle metadata is skipped.
    approval_recordStarted: async (toolName: string) => {
      if (!approvalContext) return
      const { withPrivilegedDb } = await import("~/db/privileged")
      const { recordStarted } = await import("~/modules/approvals/handler-protocol")
      await withPrivilegedDb(orgId, "approval-record-started", (ptx) =>
        recordStarted(
          ptx,
          {
            orgId,
            approvalRequestId: approvalContext.approvalRequestId,
            approvalDeciderId: approvalContext.approvalDeciderId,
            toolName: approvalContext.toolName,
          },
          toolName,
        ),
      )
    },
    approval_recordSucceeded: async (toolName: string, externalRefJson?: string) => {
      if (!approvalContext) return
      const { withPrivilegedDb } = await import("~/db/privileged")
      const { recordSucceeded } = await import("~/modules/approvals/handler-protocol")
      await withPrivilegedDb(orgId, "approval-record-succeeded", (ptx) =>
        recordSucceeded(
          ptx,
          {
            orgId,
            approvalRequestId: approvalContext.approvalRequestId,
            approvalDeciderId: approvalContext.approvalDeciderId,
            toolName: approvalContext.toolName,
          },
          toolName,
          externalRefJson ? JSON.parse(externalRefJson) : undefined,
        ),
      )
    },
    // The external effect LANDED: the provider call returned. Call it right after
    // that call and before any post-effect work, with what the provider created
    // (e.g. `{provider:"gmail",messageId,externalThreadId}`). If the handler is cut
    // off afterwards (the sandbox ceiling, a crash), the host promotes the row to
    // `succeeded` from this ref instead of parking the approval as unknown, and
    // never runs the provider call again. Call approval_recordStarted FIRST.
    approval_recordEffectLanded: async (toolName: string, externalRefJson: string) => {
      if (!approvalContext) return
      const { withPrivilegedDb } = await import("~/db/privileged")
      const { recordEffectLanded } = await import("~/modules/approvals/handler-protocol")
      await withPrivilegedDb(orgId, "approval-record-effect-landed", (ptx) =>
        recordEffectLanded(
          ptx,
          {
            orgId,
            approvalRequestId: approvalContext.approvalRequestId,
            approvalDeciderId: approvalContext.approvalDeciderId,
            toolName: approvalContext.toolName,
          },
          toolName,
          JSON.parse(externalRefJson),
        ),
      )
    },
    // Async outputs: the side effect committed but its outputs materialize
    // later (e.g. a carrier label PDF). Records `awaiting_output` +
    // external_ref; the kernel's poll job (see the tool's `pollHandler`)
    // retrieves the outputs on the poll schedule and resumes the sequence
    // cascade. Call approval_recordStarted FIRST (this is an UPDATE).
    approval_recordAwaitingOutput: async (toolName: string, externalRefJson?: string) => {
      if (!approvalContext) return
      const { withPrivilegedDb } = await import("~/db/privileged")
      const { recordAwaitingOutput } = await import("~/modules/approvals/handler-protocol")
      await withPrivilegedDb(orgId, "approval-record-awaiting", (ptx) =>
        recordAwaitingOutput(
          ptx,
          {
            orgId,
            approvalRequestId: approvalContext.approvalRequestId,
            approvalDeciderId: approvalContext.approvalDeciderId,
            toolName: approvalContext.toolName,
          },
          toolName,
          externalRefJson ? JSON.parse(externalRefJson) : undefined,
        ),
      )
    },
    approval_recordFailedNoEffect: async (toolName: string, errJson: string) => {
      if (!approvalContext) return
      const { withPrivilegedDb } = await import("~/db/privileged")
      const { recordFailedNoEffect } = await import("~/modules/approvals/handler-protocol")
      await withPrivilegedDb(orgId, "approval-record-failed", (ptx) =>
        recordFailedNoEffect(
          ptx,
          {
            orgId,
            approvalRequestId: approvalContext.approvalRequestId,
            approvalDeciderId: approvalContext.approvalDeciderId,
            toolName: approvalContext.toolName,
          },
          toolName,
          JSON.parse(errJson),
        ),
      )
    },
    approval_recordAmbiguous: async (toolName: string, errJson: string) => {
      if (!approvalContext) return
      const { withPrivilegedDb } = await import("~/db/privileged")
      const { recordAmbiguous } = await import("~/modules/approvals/handler-protocol")
      await withPrivilegedDb(orgId, "approval-record-ambiguous", (ptx) =>
        recordAmbiguous(
          ptx,
          {
            orgId,
            approvalRequestId: approvalContext.approvalRequestId,
            approvalDeciderId: approvalContext.approvalDeciderId,
            toolName: approvalContext.toolName,
          },
          toolName,
          JSON.parse(errJson),
        ),
      )
    },

    // --- Handler-conditional gating (K6) ---
    // `ctx.requestApproval(input)` — a handler that decides mid-execution to park
    // for approval (e.g. an over-threshold invoice issuance, which can only be
    // evaluated after loading the per-issuer threshold) calls this to create a
    // pending approval. The post-approve re-entry re-invokes `input.tool_name`
    // with `input.current_payload` and `ctx.approval` populated. The arg arrives
    // JSON-stringified (SDK shape via `__wrap`); the return is JSON so `__wrap`
    // parses it back to `{ approval_id }`. Wiring is injected by
    // `executeToolHandler` (see `requestApprovalImpl`) to avoid a circular import.
    requestApproval: async (inputJson: string): Promise<string> => {
      const impl = bridgeOptions?.requestApprovalImpl
      if (!impl) {
        throw new Error("ctx.requestApproval is not available in this execution context")
      }
      const input = JSON.parse(inputJson) as {
        tool_name: string
        summary: string
        summary_detail?: {
          subtitle?: string
          lines?: string[]
          links?: Array<{ label: string; app: string; entityType: string; entityId: string }>
        }
        current_payload: unknown
        editable_fields?: string[]
        auto_approvable?: boolean
        approve_scope?: string
      }
      // FX13: the same captured value `ctx.executeTool` forwards below. A
      // handler that parks itself mid-run reaches the identical recording site
      // (`createApprovalRequest`) through this door, from the same frame-less
      // callback, so it must travel the same way.
      return JSON.stringify(
        await impl(
          input,
          bridgeTurnTaintScopes,
          bridgeActingAgentId,
          // The proposing run (depth, root), captured with the frame: an
          // approved re-entry nests what it spawns below it.
          bridgeSpawnParentFrame === null ? null : (bridgeSpawnParentFrame?.run ?? null),
        ),
      )
    },
  }
}
