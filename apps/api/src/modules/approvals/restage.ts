// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Restage-in-place for dedupe-keyed gated approvals.
//
// A gated tool with an `approvalDedupeKeyParam` (e.g. boxtal:create_shipment
// keyed on `draft_id`) surfaces at most ONE pending approval per keyed action:
// a second staging call re-surfaces the existing approval instead of stacking a
// duplicate. Before this module, that re-surface returned the OLD approval id
// while the blocked envelope carried a summary freshly built from the NEW call's
// params — the agent was told "staged via <new carrier>" while the stored
// payload (and the human's card) still said the old one, and approving executed
// the OLD params. A restage with DIFFERENT params must therefore update the
// stored approval in place: tool_params + current_payload + summary, with the
// same protections a payload edit gets (prior sign-offs reset, an audit system
// message in the thread, an approval_request update event so live cards refresh).

import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { captureActingAgentId } from "~/modules/agent/runtime/run-context"
import { proposingTurnWriteScopes } from "~/modules/agent/scopes/write-required-scopes"
import {
  loadApprovalSummary,
  lockedUpdateApproval,
  normalizeApprovalPayload,
  proposingTurnScopesUnionSql,
} from "~/modules/approvals/event-data"
import { maskApprovalPayload } from "~/modules/approvals/payload-mask"
import {
  narrowPendingApprovalForTaint,
  type TaintNarrowRow,
} from "~/modules/approvals/taint-narrow"
import { MAIL_APPROVAL_SEAL_ENVELOPE_KEYS } from "~/modules/mailbox-crypto/approval-payload"
import { sendMessage } from "~/modules/threads/message"

const K = drizzleSql.raw(schemaRef("kernel"))

export interface RestageArgs {
  orgId: string
  requestId: string
  /** The NEW call's validated params — becomes tool_params + current_payload. */
  toolParams: Record<string, unknown>
  /** The NEW call's freshly built summary — becomes the stored card summary. */
  summary: Record<string, unknown>
  /** Who restaged (the caller of the gated tool). */
  actorUserId: string
  /** A11: the acting agent, forwarded by a caller that resolved it once for the
   *  whole dispatch (and that may have crossed the frame-losing sandbox hop).
   *  Undefined means "read the live turn". */
  actingAgentId?: string | null
  /** Rule 8g (scope-taint.ts): the restaging turn's taint. The row is narrowed to holders of
   *  the union of its demand and this taint, in place, or the restage is refused. */
  turnTaint?: readonly string[]
}

export type RestageResult =
  /** False when the new params deep-equal the stored payload (pure re-surface). */
  | { updated: boolean }
  /** Rule 8g: nobody who may decide the narrowed row holds the union, or the requester lacks it. */
  | { updated: false; taintRefusal: string }

function deepEq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Update a pending dedupe-hit approval to the latest staging call's params +
 * summary. No-ops (updated:false) when the params are identical. Best-effort by
 * contract at the call site: the caller treats a throw as "re-surface the old
 * approval untouched" only for row-gone/stale races — see executeToolInternal.
 */
export async function restagePendingApproval(args: RestageArgs): Promise<RestageResult> {
  // FX4: this runs in the LATER turn that re-staged the action, and that turn
  // may have read more than the one that first staged it. Captured here, where
  // that turn's frame is still live, and unioned into the recorded set below.
  const restagingTurnScopes = proposingTurnWriteScopes()
  // A11: and the agent of that same later turn. Forwarded wins (the caller
  // resolved it before any hop); otherwise the live frame answers, and outside
  // a turn that is a truthful null.
  const actingAgentId =
    args.actingAgentId !== undefined ? args.actingAgentId : captureActingAgentId()
  return await withPrivilegedDb(args.orgId, "approval-restage", async (tx) => {
    const locked = extractRows<
      {
        id: string
        thread_id: string
        current_payload: unknown
        status: string
        metadata: { approvedBy?: string[]; taintAudienceMustHold?: unknown } | null
      } & TaintNarrowRow
    >(
      await tx.execute(drizzleSql`
        SELECT id, thread_id, requested_by, current_payload, status, metadata, tool_name,
               notify_user_ids, resource_owner_id, approve_scope, dimension_constraint
        FROM ${K}.approval_requests WHERE id = ${args.requestId} AND org_id = ${args.orgId}::uuid
        FOR UPDATE
      `),
    )[0]
    // Row gone or already decided between the dedupe lookup and this lock: the
    // caller's dedupe hit is stale; nothing to update here.
    if (!locked || locked.status !== "pending") return { updated: false }

    const currentPayload = normalizeApprovalPayload(locked.current_payload)
    // Masked like a new request (payload-mask.ts): no card number or payment key is kept.
    const nextPayload = maskApprovalPayload(
      JSON.parse(JSON.stringify(args.toolParams ?? {})) as Record<string, unknown>,
    )
    const nextSummary = maskApprovalPayload(args.summary)

    // Top-level field diff — both the no-op decision and the audit trail (same
    // metadata shape the payload-edit path emits, so the UI renders it
    // identically). Per-field, not whole-object stringify: jsonb round-trips
    // reorder keys, which would fabricate a "change" out of identical params.
    const diff: Array<{ field: string; from: unknown; to: unknown }> = []
    for (const key of new Set([...Object.keys(currentPayload), ...Object.keys(nextPayload)])) {
      if (!deepEq(currentPayload[key], nextPayload[key])) {
        // A sealed mail draft's ciphertext and key material say nothing to a
        // reader: the diff records that they changed, not the blobs.
        const sealedPart = MAIL_APPROVAL_SEAL_ENVELOPE_KEYS.has(key)
        const marker = (value: unknown) =>
          sealedPart && typeof value === "string" ? { sealed: true } : value
        diff.push({ field: key, from: marker(currentPayload[key]), to: marker(nextPayload[key]) })
      }
    }
    if (diff.length === 0) return { updated: false }

    // N-eyes: a sign-off applies to the content the approver reviewed — any
    // restage resets the recorded approver set (mirrors edit.ts).
    const priorApprovals = Array.isArray(locked.metadata?.approvedBy)
      ? locked.metadata.approvedBy.length
      : 0
    // The recorded proposing-turn scopes are UNIONED with the restaging turn's,
    // never replaced: the approved re-entry will execute THIS payload, so it
    // must carry everything either turn had read.
    // Rule 8g: a tainted restage keeps the row exactly as narrow as a fresh tainted proposal.
    const turnTaint = [...(args.turnTaint ?? [])]
    const narrowing = await narrowPendingApprovalForTaint(tx, args.orgId, locked, turnTaint)
    if (!narrowing.ok) return { updated: false, taintRefusal: narrowing.message }
    const taintSet =
      turnTaint.length > 0
        ? drizzleSql`, notify_user_ids = ${`{${narrowing.notifyUserIds.join(",")}}`}::uuid[], metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ taintAudienceMustHold: narrowing.mustHold })}::jsonb`
        : drizzleSql``
    const unionScopes =
      restagingTurnScopes === null ? null : [...new Set([...restagingTurnScopes, ...turnTaint])]
    const scopeUnion = drizzleSql`, ${proposingTurnScopesUnionSql(unionScopes)}${taintSet}`
    const updated = await lockedUpdateApproval<{ current_payload: unknown }>(tx, {
      requestId: locked.id,
      from: ["pending"],
      set:
        priorApprovals > 0
          ? drizzleSql`tool_params = ${JSON.stringify(nextPayload)}::jsonb, current_payload = ${JSON.stringify(nextPayload)}::jsonb, summary = ${JSON.stringify(nextSummary)}::jsonb, metadata = metadata - 'approvedBy'${scopeUnion}`
          : drizzleSql`tool_params = ${JSON.stringify(nextPayload)}::jsonb, current_payload = ${JSON.stringify(nextPayload)}::jsonb, summary = ${JSON.stringify(nextSummary)}::jsonb${scopeUnion}`,
      returning: drizzleSql`current_payload`,
    })
    if (!updated) return { updated: false }

    const fieldList = diff.map((d) => d.field).join(", ")
    const editMetadata = { type: "payload-edit", diff, editorUserId: args.actorUserId }
    const content =
      priorApprovals > 0
        ? `Restaged with updated parameters (${fieldList}), see diff. ${priorApprovals} prior sign-off${priorApprovals === 1 ? "" : "s"} reset: approvers must re-review.`
        : `Restaged with updated parameters (${fieldList}), see diff.`
    // Author as the ORIGINAL requester (always a participant of the approval's
    // thread) — the real editor is carried in metadata.editorUserId, mirroring
    // the shared-surface fallback in edit.ts.
    // The diff quotes the payload: stamped with what the row demands of its readers.
    await sendMessage(tx as unknown as RlsClient, {
      requiredScopes: narrowing.mustHold,
      orgId: args.orgId,
      userId: locked.requested_by,
      threadId: locked.thread_id,
      content,
      authorType: "system",
      agentId: actingAgentId,
      metadata: editMetadata,
    })

    const eventData = await loadApprovalSummary(tx, args.orgId, locked.id, {
      editorUserId: args.actorUserId,
      at: new Date().toISOString(),
      diff,
    })
    await tx.queueEvent({
      app: "kernel",
      entity: "approval_request",
      action: "update",
      entityId: locked.id,
      orgId: args.orgId,
      actorId: args.actorUserId,
      actorType: "user",
      // A11: the human stays the actor; the agent that restaged the keyed
      // action rides alongside so the audit row names it (FX18's four sites,
      // reached from executeToolCore's dedupe branch).
      agentId: actingAgentId,
      data: eventData,
    })

    return { updated: true }
  })
}
