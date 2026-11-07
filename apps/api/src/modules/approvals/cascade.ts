// SPDX-License-Identifier: FSL-1.1-ALv2

import { findRefTokens, resolveRefTokens } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { enqueueApprovalResultTurn } from "~/modules/approvals/approval-result-turn"
import { failBundle } from "~/modules/approvals/cascade-fail"
import {
  enterApprovalExecution,
  isDraining,
  leaveApprovalExecution,
} from "~/modules/approvals/drain"
import {
  emitApprovalStateChange,
  loadApprovalSummary,
  loadRequesterContext,
  loadUserName,
  lockedUpdateApproval,
  normalizeApprovalPayload,
} from "~/modules/approvals/event-data"
import {
  HandlerAmbiguousError,
  HandlerNoEffectError,
  readHandlerExecution,
} from "~/modules/approvals/handler-protocol"
import {
  applyMailboxFulfilment,
  MAILBOX_FULFILLABLE_TOOLS,
  type MailboxFulfilment,
} from "~/modules/approvals/mailbox-fulfilment"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { enqueuePoll } from "~/modules/approvals/poll-output"
import { readDecidedResult } from "~/modules/approvals/read-decided-result"
import { readApprovalRequester } from "~/modules/approvals/requester"
import { resolveApprovalResourceOwner } from "~/modules/approvals/resource-owner"
import {
  approvalResultForConversation,
  approvalResultRequiredScopes,
  postApprovalResultNotice,
} from "~/modules/approvals/result-notice"
import { approvalExpiryRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { parseOriginRun, type ToolOrigin } from "~/modules/apps/execute-tool"
import {
  HandlerToolMissingError,
  RequesterLostScopeError,
  runApprovedToolHandler,
  softErrorOf,
} from "~/modules/apps/run-approved-handler"
import { writeAuditLog } from "~/modules/audit/service"
import {
  evaluateSendGuard,
  isPinnedSendGuard,
  personZone,
  recipientsOf,
} from "~/modules/mail/send-guard"
import {
  isManagedApprovalPayload,
  openManagedApprovalPayload,
} from "~/modules/mailbox-crypto/managed-approval"

const K = drizzleSql.raw(schemaRef("kernel"))

/** The one override a person has over the send check: send although the other side is away. */
export type SendGuardOverride = "auto_reply"

const GUARDED_SENDS = new Set(["mail:compose", "mail:reply"])

/**
 * "Send now" on a held mail, under the claim's row lock and after the payload hash was judged.
 * The state is read again here, so a reply that came in since the card was drawn wins over the
 * click. Only a hold can be overridden; the mark is written into the payload the handler runs
 * and the audit row names who chose it.
 */
async function lockedSendGuardOverride(
  tx: PrivilegedDb,
  args: {
    orgId: string
    requestId: string
    toolName: string
    payload: unknown
    requestedBy: string
    deciderId: string
    override: SendGuardOverride
  },
): Promise<{ held: true } | { held: false; state: string }> {
  const payload = normalizeApprovalPayload(args.payload) as Record<string, unknown>
  const guard = payload.sendGuard
  if (!GUARDED_SENDS.has(args.toolName) || !isPinnedSendGuard(guard)) {
    return { held: false, state: "not_guarded" }
  }
  // Every read runs on the claim's own transaction: a second privileged slot taken while this
  // one holds the row lock is the shape that deadlocks a full pool.
  const verdict = await evaluateSendGuard({
    ...(await personZone(args.orgId, args.requestedBy, tx)),
    orgId: args.orgId,
    db: tx,
    guard,
    recipients: recipientsOf(payload.to, payload.cc, payload.bcc),
    at: "card",
  })
  if (verdict.state !== "held") return { held: false, state: verdict.state }
  const mark = { by: args.deciderId, at: new Date().toISOString() }
  await tx.execute(drizzleSql`
    UPDATE ${K}.approval_requests
       SET current_payload = jsonb_set(current_payload, '{sendGuard,ignoreAutoReply}', ${JSON.stringify(mark)}::jsonb, true)
     WHERE id = ${args.requestId}`)
  await writeAuditLog(
    tx,
    {
      orgId: args.orgId,
      actorId: args.deciderId,
      actorType: "user",
      app: "mail",
      entityType: "approval_request",
      entityId: args.requestId,
      action: "send_guard.override",
      metadata: {
        override: args.override,
        toolName: args.toolName,
        heldBy: verdict.who ?? null,
        holdUntil: verdict.holdUntil ?? null,
        at: mark.at,
      },
    },
    { required: true },
  )
  return { held: true }
}

export type StepOutcome =
  | { kind: "succeeded" }
  | { kind: "awaiting_output"; toolName: string }
  | { kind: "failed"; error: Error }
  | { kind: "already_claimed"; currentStatus: string }
  /** Process is shutting down; the claim was NOT taken and the row is untouched. */
  | { kind: "draining" }
  /** The payload changed after the decider's card was rendered: nothing was claimed or run. */
  | { kind: "payload_changed" }
  /** "Send now" on a mail that is no longer held (a reply came in, the hold ended): nothing ran. */
  | { kind: "send_guard_not_held"; state: string }

/** Locks `row` from `sourceStatus` → approving, runs its handler, then
 *  terminalizes → approved (or reports awaiting_output / failed). Does NOT
 *  cascade — the caller decides what happens next. */
export async function executeApprovedStep(args: {
  orgId: string
  approvalId: string
  sourceStatus: "pending" | "deferred"
  decider: UserContext
  deciderId: string
  /** Blueprint Task 9.8 and 9.9: execute-time only plaintext for a gated send
   *  from an encrypted personal mailbox. Merged in memory below and never
   *  persisted; see `mailbox-fulfilment.ts`. */
  mailboxFulfilment?: MailboxFulfilment
  /** The fingerprint of the payload the human reviewed (`approvalPayloadHash`). When set, the claim
   *  succeeds only if the stored payload still hashes to it, judged under the row lock the claim
   *  itself takes, so an edit cannot slip in between the check and the claim. */
  expectedPayloadHash?: string
  /** Whose decision this was when the decider is not the person the row is for: read by the
   *  claim itself on the row it has locked and stored by the same update, so it names whose the
   *  row was when this claim won. */
  decidedFor?: ((tx: PrivilegedDb) => Promise<Record<string, unknown> | null>) | undefined
  /** "Send now" on a held mail: judged and written under the claim's row lock, after the hash. */
  sendGuardOverride?: SendGuardOverride
}): Promise<StepOutcome> {
  // Step 0: REFUSE BEFORE CLAIMING while the process is shutting down.
  //
  // The claim commits `pending → approving` and the handler then runs outside
  // any transaction, so from the claim until terminalize a SIGKILL leaves the
  // row wedged at `approving` with an outcome nobody can determine (8 rows
  // wedged this way across the 2026-07-16/20/22 deploys, unresolved 12-19
  // days). Refusing HERE -- before the claim -- leaves the row `pending` and
  // fully decidable, so the human just re-approves after the deploy. Refusing
  // any later would itself create the wedge we are preventing.
  if (isDraining()) {
    return { kind: "draining" }
  }

  // Step 1: optimistic lock sourceStatus → approving.
  let payloadChanged = false
  let notHeld: string | null = null
  const claimed = await withPrivilegedDb(args.orgId, "cascade-claim", async (tx) => {
    let decidedFor: Record<string, unknown> | null = null
    if (
      args.expectedPayloadHash !== undefined ||
      args.sendGuardOverride !== undefined ||
      args.decidedFor !== undefined
    ) {
      const [locked] = extractRows<{
        tool_name: string
        current_payload: unknown
        status: string
        requested_by: string
      }>(
        await tx.execute(
          drizzleSql`SELECT tool_name, current_payload, status, requested_by FROM ${K}.approval_requests WHERE id = ${args.approvalId} FOR UPDATE`,
        ),
      )
      if (locked && locked.status === args.sourceStatus) {
        // The hash is judged on the payload the decider saw, so it comes first: the override's
        // own patch below changes the payload, and judged after it every real card would refuse.
        if (
          args.expectedPayloadHash !== undefined &&
          approvalPayloadHash(locked.tool_name, locked.current_payload) !== args.expectedPayloadHash
        ) {
          payloadChanged = true
          return undefined
        }
        if (args.sendGuardOverride !== undefined) {
          const override = await lockedSendGuardOverride(tx, {
            orgId: args.orgId,
            requestId: args.approvalId,
            toolName: locked.tool_name,
            payload: locked.current_payload,
            requestedBy: locked.requested_by,
            deciderId: args.deciderId,
            override: args.sendGuardOverride,
          })
          if (!override.held) {
            notHeld = override.state
            return undefined
          }
        }
        if (args.decidedFor) decidedFor = await args.decidedFor(tx)
      }
    }
    return lockedUpdateApproval<{
      id: string
      current_payload: unknown
      originating_thread_id: string
      thread_id: string
      tool_name: string
      requested_by: string
      metadata: { origin?: ToolOrigin; originRoutineId?: string; originRun?: unknown } | null
      /** FX4: the proposing turn's accumulated scopes, or null when the row
       *  predates migration 0067 (or its turn's taint was unknowable). */
      proposing_turn_scopes: string[] | null
      /** A11: the agent whose turn proposed the call, or null when none was
       *  recorded (a human request, or a row written before it was). */
      agent_id: string | null
    }>(tx, {
      requestId: args.approvalId,
      from: args.sourceStatus,
      // Any earlier claim's decided-for goes with it: only this decider's is kept.
      set: drizzleSql`status = 'approving', decided_by = ${args.deciderId}, decided_at = now(), approving_started_at = now(), metadata = (COALESCE(metadata, '{}'::jsonb) - 'reaperFlaggedAt' - 'decidedFor')${
        decidedFor
          ? drizzleSql` || jsonb_build_object('decidedFor', ${JSON.stringify(decidedFor)}::jsonb)`
          : drizzleSql``
      }`,
      returning: drizzleSql`id, current_payload, originating_thread_id, thread_id, tool_name, requested_by, metadata, proposing_turn_scopes, agent_id`,
    })
  })
  if (payloadChanged) return { kind: "payload_changed" }
  if (notHeld !== null) return { kind: "send_guard_not_held", state: notHeld }
  if (!claimed) {
    // Lost the optimistic claim to a concurrent caller — read the current status
    // so the caller can decide (head: AlreadyDecidedError; cascade: no-op).
    const [cur] = extractRows<{ status: string }>(
      await withPrivilegedDb(args.orgId, "cascade-claim-cur", (tx) =>
        tx.execute(
          drizzleSql`SELECT status FROM ${K}.approval_requests WHERE id = ${args.approvalId}`,
        ),
      ),
    )
    return { kind: "already_claimed", currentStatus: cur?.status ?? "unknown" }
  }

  // The claim is COMMITTED: the wedge window is now open. Register it so
  // shutdown waits for this execution to terminalize rather than being
  // SIGKILLed mid-handler. `finally` closes it on every exit path -- success,
  // the early awaiting_output return, and the handler-failure returns alike.
  enterApprovalExecution(claimed.id)
  try {
    // Step 2: refresh both parties' permissions. The handler runs AS the requester (identity and
    // attribution never move) WITH the decider's authority delegated to it: approving is the
    // decider doing the action through the requester's draft, so a grant the requester lacks
    // and the approver holds must not fail the execution.
    const requesterContext = await loadRequesterContext(
      args.orgId,
      claimed.requested_by,
      "cascade-requester-perms",
    )
    const deciderContext =
      args.deciderId === claimed.requested_by
        ? undefined
        : await loadRequesterContext(args.orgId, args.deciderId, "cascade-decider-perms")

    // Step 3: run the handler outside a DB tx.
    try {
      await runApprovedToolHandler({
        orgId: args.orgId,
        requesterContext,
        deciderId: args.deciderId,
        ...(deciderContext ? { deciderContext } : {}),
        toolName: claimed.tool_name,
        // The ONE place the sealed payload becomes executable plaintext. The
        // merge is in memory and the merged object is handed straight to the
        // handler: `current_payload` on disk still holds the Phase 6 ciphertext
        // after this returns.
        payload: isManagedApprovalPayload(
          normalizeApprovalPayload(claimed.current_payload) as Record<string, unknown>,
        )
          ? // A transparent mailbox's draft: opened in memory for its owner.
            await openManagedApprovalPayload({
              payload: normalizeApprovalPayload(claimed.current_payload) as Record<string, unknown>,
              orgId: args.orgId,
              deciderId: args.deciderId,
              approvalRequestId: claimed.id,
            })
          : applyMailboxFulfilment({
              toolName: claimed.tool_name,
              payload: normalizeApprovalPayload(claimed.current_payload) as Record<string, unknown>,
              ...(args.mailboxFulfilment ? { fulfilment: args.mailboxFulfilment } : {}),
            }),
        approvalRequestId: claimed.id,
        threadId: claimed.thread_id,
        origin: claimed.metadata?.origin,
        originRoutineId: claimed.metadata?.originRoutineId,
        // FX4: the handler re-runs OUTSIDE the proposing turn's frame, so the
        // scopes that turn had read travel on the row and are seeded back into
        // the execution. Undefined-vs-null matters: null is "nothing recorded".
        proposingTurnScopes: claimed.proposing_turn_scopes,
        // A11: same journey as the scopes -- the identity was PERSISTED when
        // the call was proposed and is read back here, never re-resolved, so
        // the re-entry's writes name the agent whose turn actually proposed it.
        agentId: claimed.agent_id ?? null,
        // And the proposing sub-run's depth, the same journey (MAX_NESTING_DEPTH).
        ...(() => {
          const originRun = parseOriginRun(claimed.metadata?.originRun)
          return originRun ? { originRun } : {}
        })(),
      })
    } catch (err) {
      if (
        err instanceof HandlerNoEffectError ||
        err instanceof HandlerToolMissingError ||
        err instanceof RequesterLostScopeError ||
        err instanceof HandlerAmbiguousError
      ) {
        return { kind: "failed", error: err }
      }
      if (err instanceof Error) return { kind: "failed", error: err }
      return { kind: "failed", error: new Error(String(err)) }
    }

    // Step 4: inspect the execution. An async tool records `awaiting_output`.
    const exec = await readHandlerExecution(args.orgId, claimed.id, claimed.tool_name)
    if (exec?.status === "awaiting_output") {
      // The human-approved action committed; only output retrieval is pending.
      // Terminalize the APPROVAL — the output lands later via the poll job.
      await terminalizeApproved(args, claimed, /* postMessages */ false)
      return { kind: "awaiting_output", toolName: claimed.tool_name }
    }

    await terminalizeApproved(args, claimed, /* postMessages */ true, {
      requesterScopes: requesterContext.scopes,
    })
    return { kind: "succeeded" }
  } finally {
    leaveApprovalExecution(claimed.id)
  }
}

/** Flip approving → approved; optionally post the dual "Approved" system
 *  messages + queue the `approval_request:update` event. */
async function terminalizeApproved(
  args: { orgId: string; deciderId: string },
  claimed: {
    id: string
    originating_thread_id: string
    thread_id: string
    requested_by: string
    tool_name: string
    proposing_turn_scopes: string[] | null
    current_payload: unknown
    metadata: { origin?: ToolOrigin; originRoutineId?: string } | null
    agent_id: string | null
  },
  postMessages: boolean,
  resultNotice?: { requesterScopes: string[] },
): Promise<void> {
  // The handler's stored output, handed back to the proposing conversation so
  // the agent's next turn reads what the call returned (result-notice.ts).
  const decided = resultNotice ? await readDecidedResult(args.orgId, claimed.id) : null
  const result = resultNotice
    ? await approvalResultForConversation({
        orgId: args.orgId,
        toolName: claimed.tool_name,
        payload: normalizeApprovalPayload(claimed.current_payload),
        originatingThreadId: claimed.originating_thread_id,
        result: decided,
      })
    : null
  // An approved READ that failed (a 404 from the fetched site) is executed with
  // its error as the result (run-approved-handler.ts, `answersWithItsError`):
  // the decision line says so instead of claiming success.
  const ranWithError = softErrorOf(decided) !== null
  const resultScopes = resultNotice
    ? approvalResultRequiredScopes({
        orgId: args.orgId,
        toolName: claimed.tool_name,
        proposingTurnScopes: claimed.proposing_turn_scopes,
        requesterScopes: resultNotice.requesterScopes,
      })
    : []
  let resultPosted = false
  let terminalized = false
  await withPrivilegedDb(args.orgId, "cascade-terminalize", async (tx) => {
    const updated = await lockedUpdateApproval<{ id: string }>(tx, {
      requestId: claimed.id,
      from: "approving",
      set: drizzleSql`status = 'approved', approving_started_at = NULL`,
      returning: drizzleSql`id`,
    })
    if (!updated) return
    terminalized = true
    if (postMessages) {
      const deciderName = await loadUserName(tx, args.deciderId)
      await emitApprovalStateChange(tx, {
        // Fixed success text plus the decider's display name: no handler output.
        requiredScopes: [],
        orgId: args.orgId,
        requestId: claimed.id,
        threadId: claimed.thread_id,
        originatingThreadId: claimed.originating_thread_id,
        requesterId: claimed.requested_by,
        actorUserId: args.deciderId,
        actorType: "user",
        content: ranWithError
          ? `Approved by ${deciderName}. The tool ran and returned an error, which was passed to the agent.`
          : `Approved by ${deciderName}. Tool executed successfully.`,
        metadata: {
          type: "approval-decision",
          decision: "approved",
          actorId: args.deciderId,
          requestId: claimed.id,
        },
      })
      if (result) {
        const summary = await loadApprovalSummary(tx, args.orgId, claimed.id)
        await postApprovalResultNotice(tx, {
          orgId: args.orgId,
          requestId: claimed.id,
          requestHandle: summary.handle,
          toolName: summary.toolName,
          originatingThreadId: claimed.originating_thread_id,
          requesterId: claimed.requested_by,
          requiredScopes: resultScopes,
          result,
        })
        resultPosted = true
      }
    } else {
      // No message — just queue the update event so listeners refresh.
      const summaryData = await loadApprovalSummary(tx, args.orgId, claimed.id)
      await tx.queueEvent({
        app: "kernel",
        entity: "approval_request",
        action: "update",
        entityId: claimed.id,
        orgId: args.orgId,
        actorId: args.deciderId,
        actorType: "user",
        // A11: a PERSON decided this. The explicit null is what stops FX21's
        // central stamp from filing the transition under whatever agent's turn
        // happens to be live in the deciding request, which would answer "what
        // did this agent do" with a human's click.
        agentId: null,
        data: summaryData,
      })
    }
  })
  // The result is committed in the proposing conversation: hand the turn back
  // to the agent that proposed the call, so it answers from it without the
  // person having to write again (approval-result-turn.ts). A routine run that
  // waits on the call resumes with or without an output.
  // Only once the row is `approved`: an earlier job would take the
  // once-per-approval claim while the run still saw the call undecided.
  if (resultPosted || (terminalized && claimed.metadata?.originRoutineId)) {
    await enqueueApprovalResultTurn({
      orgId: args.orgId,
      approvalId: claimed.id,
      originatingThreadId: claimed.originating_thread_id,
      requesterId: claimed.requested_by,
      agentId: claimed.agent_id,
      origin: claimed.metadata?.origin,
      originRoutineId: claimed.metadata?.originRoutineId,
    })
  }
}

/** After `approvedId` reaches a succeeded execution, run every deferred
 *  dependent in bundle-position order, resolving @ref tokens between steps. */
export async function cascadeDeferredDependents(args: {
  orgId: string
  approvedId: string
  decider: UserContext
  deciderId: string
}): Promise<void> {
  const dependents = await withPrivilegedDb(args.orgId, "cascade-load-dependents", async (tx) =>
    extractRows<{ id: string; tool_name: string }>(
      await tx.execute(drizzleSql`
        SELECT id, tool_name
        FROM ${K}.approval_requests
        WHERE depends_on_id = ${args.approvedId} AND status = 'deferred'
        ORDER BY bundle_position`),
    ),
  )

  for (const dep of dependents) {
    // Resolve @ref tokens against the step's CURRENT payload under a row lock,
    // and write the resolved payload in the SAME transaction. Deferred steps
    // stay human-editable until the cascade claims them; an unlocked
    // read-resolve-write here raced a concurrent edit and silently overwrote it
    // with the resolved PRE-edit payload — the executed step then sent content
    // the editor had already replaced. The lock serializes against
    // updatePayload's FOR UPDATE, so the resolve always sees either the fully
    // committed edit or blocks it until the step has left `deferred`.
    const resolve = await withPrivilegedDb(args.orgId, "cascade-resolve-payload", async (tx) => {
      const [locked] = extractRows<{
        current_payload: unknown
        status: string
        metadata: { approvedPayloadHash?: unknown } | null
      }>(
        await tx.execute(drizzleSql`
          SELECT current_payload, status, metadata FROM ${K}.approval_requests
          WHERE id = ${dep.id} FOR UPDATE`),
      )
      if (locked?.status !== "deferred") {
        return { kind: "not_deferred" as const, currentStatus: locked?.status ?? "missing" }
      }
      // The step runs on the head's approval only as the decider saw it (decide.ts stamps the
      // version shown). An edit after that, or a step the decider was never shown, does not run.
      if (
        locked.metadata?.approvedPayloadHash !==
        approvalPayloadHash(dep.tool_name, locked.current_payload)
      ) {
        return {
          kind: "failed" as const,
          message:
            "this step changed (or was added) after the request was approved, so it was not run",
        }
      }

      // Collect ancestor results. Per the linear-chain invariant, every ancestor
      // referenced by a dependent is already terminal — a null result therefore
      // means a genuine failure, never a not-yet-run step.
      const ancestorIds = [
        ...new Set(findRefTokens(locked.current_payload).map((r) => r.approvalId)),
      ]
      const results: Record<string, Record<string, unknown>> = {}
      for (const ancestorId of ancestorIds) {
        const result = await readDecidedResult(args.orgId, ancestorId, tx)
        if (result == null || typeof result !== "object") {
          return {
            kind: "failed" as const,
            message: `the step it refers to (${await refSourceLabel(tx, ancestorId)}) produced no result to fill in its @ref tokens`,
          }
        }
        results[ancestorId.toLowerCase()] = result as Record<string, unknown>
      }

      let resolvedPayload: unknown
      try {
        resolvedPayload = resolveRefTokens(locked.current_payload, results)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          kind: "failed" as const,
          message: `${message}${await declaredOutputsNote(tx, args.orgId, ancestorIds)}`,
        }
      }

      await tx.execute(drizzleSql`
        UPDATE ${K}.approval_requests
        SET current_payload = ${JSON.stringify(resolvedPayload)}::jsonb
        WHERE id = ${dep.id}`)
      return {
        kind: "resolved" as const,
        ownerMustFulfil: needsOwnerFulfilment(dep.tool_name, resolvedPayload),
      }
    })

    if (resolve.kind === "failed") {
      await failBundle(args.orgId, dep.id, resolve.message)
      return
    }
    if (resolve.kind === "not_deferred") {
      // Mirrors the already_claimed handling below: a concurrent cascade that
      // moved the step forward owns it; any other status breaks the chain.
      if (resolve.currentStatus === "approving" || resolve.currentStatus === "approved") {
        return
      }
      log.error(
        { depId: dep.id, status: resolve.currentStatus },
        "Bundle step left the deferred state before resolve — cancelling remainder",
      )
      await failBundle(
        args.orgId,
        dep.id,
        `step is ${resolve.currentStatus} — sequence cannot continue`,
      )
      return
    }

    if (resolve.ownerMustFulfil) {
      // A send from an end-to-end encrypted personal mailbox: its draft is
      // sealed to the mailbox owner and only their unlocked browser can make it
      // executable (mailbox-fulfilment.ts), so it cannot run here. It becomes
      // its owner's own decision instead, with its @ref tokens already filled
      // in; approving it through decide carries the fulfilment and continues
      // the cascade from there. Later steps stay deferred behind it.
      await awaitOwnerDecision(args.orgId, dep.id)
      return
    }

    const outcome = await executeApprovedStep({
      orgId: args.orgId,
      approvalId: dep.id,
      sourceStatus: "deferred",
      decider: args.decider,
      deciderId: args.deciderId,
    })

    if (outcome.kind === "succeeded") {
      await cascadeDeferredDependents({ ...args, approvedId: dep.id })
    } else if (outcome.kind === "draining") {
      // Shutting down mid-bundle. This step was NOT claimed, so it is still
      // `deferred` and the bundle is intact -- STOP without failing it. The
      // remainder is picked up when a human re-decides the head, which is far
      // better than cancelling a half-executed sequence over a deploy.
      log.warn(
        { depId: dep.id },
        "Bundle cascade halted: server draining — remaining steps stay deferred",
      )
      return
    } else if (outcome.kind === "already_claimed") {
      // A concurrent cascade legitimately owns this step ONLY if it moved it
      // forward (approving / approved) — then stop, it will continue there.
      // Any other status (cancelled / denied / expired / unknown) means the
      // chain is broken: fail the bundle so the remainder is cancelled and the
      // agent re-invoked, never silently leaving a half-executed bundle.
      if (outcome.currentStatus === "approving" || outcome.currentStatus === "approved") {
        return
      }
      log.error(
        { depId: dep.id, status: outcome.currentStatus },
        "Bundle step left the deferred state unexpectedly — cancelling remainder",
      )
      await failBundle(
        args.orgId,
        dep.id,
        `step is ${outcome.currentStatus} — sequence cannot continue`,
      )
      return
    } else if (outcome.kind === "awaiting_output") {
      await enqueuePoll(args.orgId, dep.id, outcome.toolName, 0)
      return
    } else if (outcome.kind === "payload_changed") {
      // Unreachable: a dependent is claimed without an expected hash. Fail closed if it ever is.
      await failBundle(args.orgId, dep.id, "step payload changed — sequence cannot continue")
      return
    } else if (outcome.kind === "send_guard_not_held") {
      // Unreachable: a dependent is claimed without the send-now override. Fail closed if it ever is.
      await failBundle(args.orgId, dep.id, "send check no longer holds — sequence cannot continue")
      return
    } else {
      log.error({ depId: dep.id, err: outcome.error }, "Bundle step failed — cancelling remainder")
      await failBundle(args.orgId, dep.id, stepFailureText(outcome.error))
      return
    }
  }
}

/**
 * A dependent that only its mailbox owner's browser can make executable: a mail
 * send sealed to a private (end-to-end) mailbox. A transparent mailbox's sealed
 * draft is opened by the server at send time, so it still runs in the cascade.
 */
export function needsOwnerFulfilment(toolName: string, payload: unknown): boolean {
  if (!MAILBOX_FULFILLABLE_TOOLS.has(toolName)) return false
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false
  const record = payload as Record<string, unknown>
  return record.mailboxSealed === true && !isManagedApprovalPayload(record)
}

/**
 * Move a deferred sealed mail step to `pending`, routed to its mailbox owner,
 * and announce it as an approval waiting for them. Nothing is executed. When
 * no owner can be resolved nobody could ever supply the draft, so the sequence
 * fails with that reason rather than waiting forever.
 */
async function awaitOwnerDecision(orgId: string, stepId: string): Promise<void> {
  const [row] = extractRows<{ tool_name: string; current_payload: unknown; requested_by: string }>(
    await withPrivilegedDb(orgId, "cascade-owner-step-read", (tx) =>
      tx.execute(drizzleSql`
        SELECT tool_name, current_payload, requested_by FROM ${K}.approval_requests
        WHERE id = ${stepId}`),
    ),
  )
  if (!row) return
  const [appName = "", toolShortName = ""] = row.tool_name.split(":")
  const ownerId = await resolveApprovalResourceOwner(
    orgId,
    appName,
    toolShortName,
    normalizeApprovalPayload(row.current_payload),
    row.requested_by,
  )
  if (!ownerId) {
    await failBundle(
      orgId,
      stepId,
      "this step sends from an encrypted personal mailbox whose owner could not be resolved, so nobody can approve it",
    )
    return
  }
  const expiryHours =
    approvalExpiryRegistry.get([orgId, appName, toolShortName]) ?? OWNER_STEP_DEFAULT_EXPIRY_HOURS
  let promoted: { id: string; thread_id: string; originating_thread_id: string } | undefined
  await withPrivilegedDb(orgId, "cascade-owner-step-promote", async (tx) => {
    promoted = await lockedUpdateApproval<{
      id: string
      thread_id: string
      originating_thread_id: string
    }>(tx, {
      requestId: stepId,
      from: "deferred",
      // Owner-routed like any approval on a personal resource: only the owner
      // sees and decides it, and decide accepts a fulfilment only from them.
      // The decision is new, so it gets the tool's full window to be made.
      set: drizzleSql`status = 'pending', resource_owner_id = ${ownerId}::uuid,
        notify_user_ids = ARRAY[${ownerId}::uuid],
        expires_at = GREATEST(expires_at, now() + make_interval(hours => ${expiryHours}::int)),
        metadata = (COALESCE(metadata, '{}'::jsonb) - 'approvedPayloadHash')
          || jsonb_build_object('awaitingMailboxOwner', true)`,
      returning: drizzleSql`id, thread_id, originating_thread_id`,
    })
    if (!promoted) return
    const requester = await readApprovalRequester(tx, orgId, stepId, row.requested_by)
    await emitApprovalStateChange(tx, {
      // Fixed text: the draft itself stays sealed and is never quoted.
      requiredScopes: [],
      orgId,
      requestId: stepId,
      threadId: promoted.thread_id,
      originatingThreadId: promoted.originating_thread_id,
      requesterId: row.requested_by,
      actorUserId: row.requested_by,
      actorType: "system",
      content:
        "The previous step ran. This email is sent from an encrypted mailbox, so it waits for its owner to approve it from a device where the mailbox is unlocked.",
      metadata: {
        type: "approval-created",
        requestId: stepId,
        requesterId: row.requested_by,
        requesterKind: requester.kind,
        requesterName: requester.name,
      },
    })
  })
  if (!promoted) return
  try {
    const { enqueueAppJob } = await import("~/infra/jobs/jobs")
    const [cur] = extractRows<{ expires_at: string }>(
      await withPrivilegedDb(orgId, "cascade-owner-step-expiry", (tx) =>
        tx.execute(drizzleSql`SELECT expires_at FROM ${K}.approval_requests WHERE id = ${stepId}`),
      ),
    )
    const delay = cur ? Math.max(0, new Date(cur.expires_at).getTime() - Date.now()) : 0
    await enqueueAppJob(
      "kernel",
      "approval-expiry",
      { orgId, requestId: stepId },
      { jobId: `approval-expiry:${stepId}`, delay },
    )
  } catch (err) {
    log.error(
      { err, requestId: stepId },
      "Failed to enqueue approval-expiry job — sweep will recover",
    )
  }
}

/** The tool default (`APPROVAL_DEFAULT_EXPIRY_HOURS` in execute-tool.ts). */
const OWNER_STEP_DEFAULT_EXPIRY_HOURS = 168

/**
 * The real error of a step that failed when it ran. The protocol's typed errors
 * carry a fixed message ("handler X failed with no side effect") and the
 * handler's own text in `details.message` (the upstream rejection, the invalid
 * field): that text is what the agent needs to correct the call.
 */
export function stepFailureText(err: Error): string {
  const details = (err as { details?: unknown }).details
  if (details && typeof details === "object") {
    const message = (details as { message?: unknown }).message
    if (typeof message === "string" && message.trim() !== "") return message
  }
  return err.message
}

type Tx = Parameters<Parameters<typeof withPrivilegedDb>[2]>[0]

/** "approval <id> (<tool>)" for a referenced step. */
async function refSourceLabel(tx: Tx, approvalId: string): Promise<string> {
  const [row] = extractRows<{ tool_name: string }>(
    await tx.execute(
      drizzleSql`SELECT tool_name FROM ${K}.approval_requests WHERE id = ${approvalId}`,
    ),
  )
  return row ? `approval ${approvalId}, ${row.tool_name}` : `approval ${approvalId}`
}

/** What each referenced step's tool declares it returns, for an unresolvable ref's message. */
async function declaredOutputsNote(tx: Tx, orgId: string, ancestorIds: string[]): Promise<string> {
  const notes: string[] = []
  for (const id of ancestorIds) {
    const [row] = extractRows<{ tool_name: string }>(
      await tx.execute(drizzleSql`SELECT tool_name FROM ${K}.approval_requests WHERE id = ${id}`),
    )
    if (!row) continue
    const [app, name] = row.tool_name.split(":")
    const declared = toolRegistry.get([orgId, app ?? "", name ?? ""])?.referenceableOutputs ?? []
    notes.push(
      `${row.tool_name} (${id}) declares the referenceable outputs ${declared.length > 0 ? declared.join(", ") : "(none)"}`,
    )
  }
  return notes.length > 0 ? `. ${notes.join("; ")}: refer to one of those keys.` : ""
}
