// SPDX-License-Identifier: FSL-1.1-ALv2

import { isApprovingWedged } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"
import { enqueueRoutineDecisionTurn } from "~/modules/approvals/approval-result-turn"
import {
  cascadeDeferredDependents,
  executeApprovedStep,
  type SendGuardOverride,
} from "~/modules/approvals/cascade"
import { failBundle, stampExecutionFailure } from "~/modules/approvals/cascade-fail"
import { mayDecideApproval } from "~/modules/approvals/decider"
import {
  cancelDeferredBundleSiblings,
  cancelDeferredDependents,
  emitApprovalStateChange,
  isSharedSurfaceApproval,
  loadRequesterContext,
  loadUserName,
  lockedUpdateApproval,
  normalizeApprovalPayload,
} from "~/modules/approvals/event-data"
import { FulfilmentRefError, resolveFulfilmentDraftRefs } from "~/modules/approvals/fulfilment-refs"
import {
  HandlerAmbiguousError,
  HandlerNoEffectError,
  readHandlerExecution,
} from "~/modules/approvals/handler-protocol"
import {
  applyMailboxFulfilment,
  type MailboxFulfilment,
  MailboxFulfilmentError,
} from "~/modules/approvals/mailbox-fulfilment"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { enqueuePoll } from "~/modules/approvals/poll-output"
import { approvalFailureRequiredScopes } from "~/modules/approvals/result-notice"
import {
  type AwayWorld,
  readAwayWorld,
  readLockedApprovalRoute,
} from "~/modules/approvals/route-world"
import type { ToolOrigin } from "~/modules/apps/execute-tool"
import {
  HandlerToolMissingError,
  RequesterLostScopeError,
} from "~/modules/apps/run-approved-handler"
import { isManagedApprovalPayload } from "~/modules/mailbox-crypto/managed-approval"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"

const K = drizzleSql.raw(schemaRef("kernel"))

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** The underlying handler message to stamp on the row, for the feed + operator. */
function detailMessageForStamp(err: { details?: unknown; message: string }): string {
  if (isRec(err.details) && typeof err.details.message === "string") return err.details.message
  return err.message
}

export class AlreadyDecidedError extends Error {
  status = 409
  code = "already_decided"
  details: { currentStatus: string }
  constructor(public currentStatus: string) {
    super(`already_decided: ${currentStatus}`)
    this.details = { currentStatus }
  }
}

export class ApprovalDecisionError extends Error {
  constructor(
    // 503 is the DRAIN case: the request was fine, the server is restarting.
    // It must stay a 5xx so clients and the UI treat it as retryable rather
    // than surfacing "you did something wrong" during a deploy.
    // 409 is the WEDGED-EXECUTION case: already approved, outcome never
    // established, and deliberately not re-run. A conflict, not a client error.
    public status: 400 | 403 | 404 | 409 | 422 | 503,
    public code:
      | "invalid_reason"
      | "forbidden"
      | "not_found"
      | "handler_failed"
      | "handler_ambiguous"
      | "execution_outcome_unknown"
      | "requester_lost_scope"
      | "server_draining"
      /** The supplied decrypted mail draft was refused (Task 9.8). */
      | "invalid_mailbox_fulfilment"
      /**
       * A SEALED mail send was approved with no decrypted draft supplied. Only
       * the mailbox owner's unlocked browser can produce one, so this is a
       * conflict with the approver's state, not a malformed request.
       */
      | "mailbox_fulfilment_required"
      /** The draft of this mail send is gone (a mailbox purge emptied it), so it cannot run. */
      | "mail_draft_removed"
      /**
       * The payload was edited after the decider's card was rendered: what they saw is not what
       * would run. They reload the card and decide again (approvals/payload-hash.ts).
       */
      | "payload_changed"
      /** N-eyes: this person's sign-off is already counted; another approver must decide. */
      | "already_signed_off"
      /** "Send now" on a mail that is not held (any more): a reply came in, or the hold ended. */
      | "send_guard_not_held",
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

export interface DecideArgs {
  orgId: string
  requestId: string
  actor: UserContext
  decision: "approve" | "deny"
  reason?: string
  /**
   * Blueprint Task 9.8 and 9.9. Plaintext the mailbox owner's browser decrypted
   * so a gated send from an encrypted personal mailbox can actually execute: the
   * drafted body and subject (sealed at rest by Phase 6), the quoted original,
   * and any re-attached attachment bytes.
   *
   * TRANSIT ONLY. It is merged onto the payload in memory immediately before the
   * handler runs and is never written to `current_payload`, to `pending_events`,
   * to a message diff or to any log line. See `mailbox-fulfilment.ts` for why
   * this is not `approval_update_payload`.
   */
  mailboxFulfilment?: MailboxFulfilment
  /**
   * Fingerprint of the payload the decider reviewed (`approvalPayloadHash`, shown on the approval
   * as `payloadHash`). The decision is bound to the exact payload the human saw: an edit made
   * after the card was rendered refuses the approve with 409 `payload_changed`. The HTTP route
   * REQUIRES it for an approve (a person is always deciding on something they were shown); an
   * in-process caller that decides on no card may omit it. A deny needs none.
   */
  payloadHash?: string
  /**
   * For a bundle head: the fingerprint of every deferred step the decider was shown, by step id.
   * The cascade runs a step only if it still matches what was shown here; a step that changed, or
   * was added, after the card loaded refuses the approve (409). Required when `payloadHash` is.
   */
  stepPayloadHashes?: Record<string, string>
  /**
   * "Send now" on a held mail draft: send although the other side's automatic reply says they
   * are away. Judged under the claim's row lock; refused with 422 `send_guard_not_held` when the
   * draft is not held at that moment.
   */
  sendGuardOverride?: SendGuardOverride
}

export interface DecideResult {
  id: string
  status: "approved" | "denied" | "pending"
  decidedBy: string
  decidedAt: string
  reason?: string
  /** N-eyes (BL-268): set on a partial approval — how many distinct approvers
   *  have signed off vs. the policy-required floor. status stays "pending"
   *  until `approvalsRecorded === approvalsRequired`. */
  approvalsRecorded?: number
  approvalsRequired?: number
}

const REASON_MAX = 1000

interface ApprovalRow {
  id: string
  org_id: string
  tool_name: string
  thread_id: string
  originating_thread_id: string
  current_payload: unknown
  requested_by: string
  status: string
  approving_started_at: string | null
  notify_user_ids: string[]
  resource_owner_id: string | null
  approve_scope: string | null
  dimension_constraint: { key: string; values: string[] } | null
  bundle_id: string | null
  /** What the proposing turn had read (`proposing_turn_scopes`), NULL when not known. */
  proposing_turn_scopes: unknown
  metadata: {
    origin?: ToolOrigin
    // N-eyes (BL-268): when an org approval-tightening policy demanded ≥2
    // distinct approvers, the gate persists the floor + the running list of
    // distinct approvers who have signed off so far.
    minApprovers?: number
    approvedBy?: string[]
    tightenReason?: string
    // Rule 8c: the scopes a tainted proposal's decider must hold, every one of them.
    taintAudienceMustHold?: unknown
  } | null
}

export async function decideApproval(args: DecideArgs): Promise<DecideResult> {
  const row = await withRlsContext(args.actor, async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT id, org_id, tool_name, thread_id, originating_thread_id, current_payload, proposing_turn_scopes, requested_by, status, approving_started_at, notify_user_ids, resource_owner_id, approve_scope, dimension_constraint, bundle_id, metadata
      FROM ${K}.approval_requests
      WHERE id = ${args.requestId}
    `)
    return extractRows<ApprovalRow>(result)[0] ?? null
  })
  if (!row) throw new ApprovalDecisionError(404, "not_found", "not_found")

  // A deferred bundle step is not directly decidable — it is approved (or denied)
  // through its bundle head. This guard is placed BEFORE the scope checks so a
  // deferred step can never be denied out-of-band via denyFlow's requester check.
  if (row.status === "deferred") {
    throw new ApprovalDecisionError(403, "forbidden", "decide the sequence via its first step")
  }

  // Dimension-constrained approvals: a custom decision scope overrides the derived
  // `<app>:approve`, and an optional dimension constraint must be covered by
  // the decider's own dimension grants (unless a super-admin bypass applies).
  // The scope derivation is the shared authority answer — never recomputed here.
  // Eligibility: an approver is in the request's audience AND currently holds the
  // app's `:approve` scope (re-loaded from the DB so a revoked scope can't decide).
  // Shared-surface drafts (ticket/mail replies) widen "audience" to anyone who
  // holds the `:approve` capability — a support ticket is a shared work item, so
  // any teammate who can act on it can approve/deny a colleague's drafted reply.
  // This matches the visibility boundary `listApprovals` already uses; without it
  // a teammate sees the draft card but 403s trying to decide it, because the
  // notify-set is only ever the original requester.
  // Personal-resource approvals (resource_owner_id set) are privately routed:
  // the OWNER decides them, with or without the app's `:approve` scope — it is
  // their own mailbox/resource. The shared-surface widening never applies to
  // them (isSharedSurfaceApproval is ownership-aware).
  // The one decider answer, shared with the edit path (`decider.ts`): fresh grants, the row's own
  // deciding scope, every taint scope of a tainted proposal (rule 8c) and dimension coverage.
  const isResourceOwner = row.resource_owner_id === args.actor.userId
  const isEligibleApprover = await withPrivilegedDb(
    args.orgId,
    "approval-load-decider-perms",
    (tx) =>
      mayDecideApproval({
        orgId: args.orgId,
        userId: args.actor.userId,
        row,
        sharedSurface: isSharedSurfaceApproval(row),
        tx,
      }),
  )
  const isRequester = row.requested_by === args.actor.userId

  if (args.decision === "approve") {
    // Only an eligible approver may approve (a requester cannot self-approve unless
    // they ALSO hold the approve scope and are in the audience).
    if (!isEligibleApprover) {
      throw new ApprovalDecisionError(403, "forbidden", "forbidden")
    }
    // The decision is bound to the payload the human saw (approvals/payload-hash.ts). Judged here
    // so a stale card is refused before anything else; judged AGAIN under the claim's row lock
    // (executeApprovedStep) so an edit landing in between cannot slip through.
    if (
      args.payloadHash !== undefined &&
      approvalPayloadHash(row.tool_name, row.current_payload) !== args.payloadHash
    ) {
      throw new ApprovalDecisionError(
        409,
        "payload_changed",
        "this request was edited after you opened it: review the current version and decide again",
      )
    }
    // Blueprint Task 9.8. Decrypted mail may be supplied ONLY by the mailbox
    // owner. Being an eligible approver is not enough: a teammate holding
    // `mail:approve` must never be able to inject a body into someone else's
    // personal send, and only the owner's browser holds the key that could have
    // produced one honestly.
    if (args.mailboxFulfilment && !isResourceOwner) {
      throw new ApprovalDecisionError(
        403,
        "forbidden",
        "only the mailbox owner may supply the decrypted draft for this approval",
      )
    }
    // A sealed draft's @ref tokens are only visible in the decrypted draft the
    // browser supplied: fill them in now, before the claim (fulfilment-refs.ts).
    if (args.mailboxFulfilment) {
      try {
        args = {
          ...args,
          mailboxFulfilment: await resolveFulfilmentDraftRefs({
            orgId: args.orgId,
            approvalId: row.id,
            bundleId: row.bundle_id,
            fulfilment: args.mailboxFulfilment,
          }),
        }
      } catch (err) {
        if (err instanceof FulfilmentRefError) {
          throw new ApprovalDecisionError(422, "invalid_mailbox_fulfilment", err.message)
        }
        throw err
      }
    }
    // Fail BEFORE the claim. Reaching `applyMailboxFulfilment` inside the
    // cascade would surface the same refusal as a handler failure, which parks
    // the row through a revert instead of rejecting the request.
    //
    // Run UNCONDITIONALLY, not only when a fulfilment was supplied. A SEALED
    // payload approved with no fulfilment (from a device with no key, from a
    // locked mailbox, or by an eligible non-owner) would otherwise reach the
    // handler carrying ciphertext keys and no body, and die there as an opaque
    // error after the row had already been claimed and moved. For any payload
    // that is not sealed and any decision without a fulfilment this is a pure
    // no-op that returns the payload untouched.
    // A draft sealed under a transparent mailbox's key: the server opens it at
    // send time, for the mailbox owner only. Anyone else is refused HERE, before
    // the claim, exactly like a private draft nobody else can open.
    const storedPayload = normalizeApprovalPayload(row.current_payload) as Record<string, unknown>
    if (isManagedApprovalPayload(storedPayload)) {
      if (!isResourceOwner || args.mailboxFulfilment) {
        throw new ApprovalDecisionError(
          403,
          "forbidden",
          "this send's draft is encrypted with its mailbox: only the mailbox owner approves it",
        )
      }
    } else
      try {
        applyMailboxFulfilment({
          toolName: row.tool_name,
          payload: storedPayload,
          fulfilment: args.mailboxFulfilment,
        })
      } catch (err) {
        if (err instanceof MailboxFulfilmentError && err.code === "draft_removed") {
          throw new ApprovalDecisionError(422, "mail_draft_removed", err.message)
        }
        if (err instanceof MailboxFulfilmentError) {
          throw new ApprovalDecisionError(
            err.code === "fulfilment_required" ? 409 : 400,
            err.code === "fulfilment_required"
              ? "mailbox_fulfilment_required"
              : "invalid_mailbox_fulfilment",
            err.message,
          )
        }
        throw err
      }
    await healWedgedApproving(args, row)
    // Still `approving` after the heal attempt = the genuinely unknown case: the
    // handler durably recorded that its side effect MAY have landed, so we will
    // not re-run it. Say that, and name the way out. It used to fall through to
    // approveFlow and surface as a bare 409 `already_decided`, which reads as a
    // dead button and is why the same request got clicked over and over
    // (ticket-10197 / ticket-10200).
    // ...and only once it is PAST the grace window. Inside the window the
    // execution may genuinely still be running, and "it will not be re-run" would
    // be a false statement; AlreadyDecidedError is the honest answer there.
    if (row.status === "approving" && wedgedPastGrace(row)) {
      throw new ApprovalDecisionError(
        409,
        "execution_outcome_unknown",
        "execution_outcome_unknown",
        {
          message:
            "This request was already approved and its execution did not report back, so whether it took effect is unknown. It will not be re-run automatically. Check whether the action landed, then Reject to close this request out.",
        },
      )
    }
    return await approveFlow(args, row)
  }

  // DENY: an eligible approver may REJECT the request, OR the requester may withdraw
  // their own. Per spec, approvers holding `:approve` can approve OR deny. Critically,
  // agent-initiated approvals carry requested_by="system" (execute-tool), so without
  // the approver-deny path NO human could ever deny them — only expiry. (The prior
  // requester-only deny check was the bug.)
  if (!isEligibleApprover && !isRequester) {
    throw new ApprovalDecisionError(403, "forbidden", "forbidden")
  }
  await healWedgedApproving(args, row)
  return await denyFlow(args, row)
}

/**
 * A DENY must ALWAYS be able to terminate a wedged row.
 *
 * healWedgedApproving deliberately refuses to heal a row whose handler durably
 * recorded `started`/`ambiguous`: re-running it could double-send. That guard is
 * about EXECUTION, and a deny executes nothing -- yet deny ran through the same
 * gate and then hit denyFlow's `from: 'pending'`, so it 409'd `already_decided`.
 * The result was a row no human could clear by ANY route: Approve 409s, Reject
 * 409s, the reaper won't touch it, and the code's own comment tells the operator
 * it "needs a person to reconcile it" while shipping no way to do so. One such
 * row sat 22 days on prod; two more piled up behind it (ticket-10197 /
 * ticket-10200).
 *
 * So a deny on a row wedged past the grace window terminates it. The audit trail
 * keeps the truth that matters: `deniedWhileWedged` records that the prior
 * execution's outcome was never established, so nobody later reads this denial
 * as proof the action never ran.
 */
function wedgedPastGrace(row: ApprovalRow): boolean {
  if (row.status !== "approving") return false
  return isApprovingWedged(claimedAtMs(row), Date.now())
}

/** The claim time of an `approving` row; an unstamped claim reads as the epoch (dead).
 *  The grace window is APPROVING_WEDGE_GRACE_MS, shared with the approval card. */
function claimedAtMs(row: ApprovalRow): number {
  return row.approving_started_at ? new Date(row.approving_started_at).getTime() : 0
}

/**
 * Un-wedge a row stuck at `approving` so a fresh decision can proceed.
 *
 * The claim `pending → approving` commits BEFORE the handler runs (cascade.ts). When the
 * handler then dies with an outcome the catch-map doesn't revert (e.g. HandlerAmbiguousError
 * from a handler that recorded no protocol row), the row stays `approving` forever: hidden
 * from the pending list, reported as "pending" by liaison_approval_status, and every decide
 * 409s "already_decided: approving" — the exact wedge a validation error inside a replayed
 * gated handler produced in prod.
 *
 * Healable states, decided from the durable handler-protocol row:
 *   - `failed_no_effect` (any age): the handler PROVED nothing happened — safe to re-decide.
 *   - NO protocol row at all, and the claim is older than the grace window: the execution
 *     died without ever reaching its side effect recording. Re-deciding is the human's
 *     explicit consent to run it (again); for a mid-flight crash this trades a rare
 *     double-execution risk against permanently wedged approvals.
 * NOT healed: a `started` or `ambiguous` protocol row — the handler durably recorded that
 * its side effect may have landed; auto-re-running could double-send. Those stay held.
 *
 * The revert races any live execution atomically via lockedUpdateApproval(from:'approving');
 * whichever transition commits first wins.
 */
async function healWedgedApproving(args: DecideArgs, row: ApprovalRow): Promise<void> {
  if (row.status !== "approving") return
  const exec = await readHandlerExecution(args.orgId, row.id, row.tool_name)
  const claimedAt = claimedAtMs(row)
  const stale = isApprovingWedged(claimedAt, Date.now())
  const healable = exec?.status === "failed_no_effect" || (exec == null && stale)
  if (!healable) {
    // A row that is STILL wedged past the grace window with a durable
    // `started`/`ambiguous` protocol row is the genuinely stuck case: the
    // handler recorded that its side effect may have landed, so auto-healing
    // could double-send and we deliberately hold it for a human. THIS is worth
    // an error-level alert (the ambiguous outcome itself is only warn — see the
    // HandlerAmbiguousError branch — because it normally auto-heals; escalate
    // only once it has failed to heal past the window and needs manual action).
    if (stale && exec != null) {
      log.error(
        { requestId: row.id, toolName: row.tool_name, execStatus: exec.status, claimedAt },
        "Approval wedged at approving past grace window with a durable handler outcome — needs manual reconciliation",
      )
    }
    return
  }
  await withPrivilegedDb(args.orgId, "approval-heal-wedged", async (tx) => {
    const healed = await lockedUpdateApproval<{ id: string }>(tx, {
      requestId: row.id,
      from: "approving",
      set: drizzleSql`status = 'pending', decided_by = NULL, decided_at = NULL, approving_started_at = NULL`,
      returning: drizzleSql`id`,
    })
    if (!healed) return
    // The metadata carries the previous attempt's handler error verbatim, which
    // can quote whatever that handler was holding, so the notice requires what
    // the call could reveal rather than the empty set every member holds.
    const requesterScopes = (await loadEffectivePermissions(tx, row.requested_by, args.orgId))
      .scopes
    await emitApprovalStateChange(tx, {
      requiredScopes: approvalFailureRequiredScopes({
        orgId: args.orgId,
        toolName: row.tool_name,
        proposingTurnScopes: row.proposing_turn_scopes,
        requesterScopes,
      }),
      orgId: args.orgId,
      requestId: row.id,
      threadId: row.thread_id,
      originatingThreadId: row.originating_thread_id,
      requesterId: row.requested_by,
      actorUserId: args.actor.userId,
      actorType: "user",
      content:
        exec?.status === "failed_no_effect"
          ? "A previous approval attempt failed before any action was taken. Request reset to pending."
          : "A previous approval attempt never completed. Request reset to pending.",
      metadata: {
        type: "approval-error",
        error: {
          code: "approving_wedge_healed",
          message:
            exec?.status === "failed_no_effect"
              ? "handler failed with no effect"
              : "execution never completed",
          details: exec?.error ?? null,
        },
      },
    })
  })
  row.status = "pending"
}

async function denyFlow(args: DecideArgs, row: ApprovalRow): Promise<DecideResult> {
  // A deny reason is optional: a reviewer may reject without justifying it. We
  // still cap the length so a runaway string can't be persisted.
  const reason = (args.reason ?? "").trim()
  if (reason.length > REASON_MAX) {
    throw new ApprovalDecisionError(400, "invalid_reason", "invalid_reason")
  }
  const fromWedged = wedgedPastGrace(row)
  const readFor = fromWedged ? undefined : await decidedForReader(args, row)
  const result = await withPrivilegedDb(args.orgId, "approval-deny", async (tx) => {
    // Whose the row is, read on the row as this decision locks it, and written by the same update.
    let forSql = drizzleSql``
    if (readFor) {
      await tx.execute(
        drizzleSql`SELECT 1 FROM ${K}.approval_requests WHERE id = ${row.id} FOR UPDATE`,
      )
      const decidedFor = await readFor(tx)
      if (decidedFor) {
        forSql = drizzleSql`, metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{decidedFor}', ${JSON.stringify(decidedFor)}::jsonb, true)`
      }
    }
    const updated = await lockedUpdateApproval<{
      id: string
      status: string
      decided_by: string
      decided_at: string
      reason: string
      originating_thread_id: string
      tool_name: string
    }>(tx, {
      requestId: row.id,
      // `pending` normally, but ALSO `approving` when the row is wedged past the
      // grace window -- see wedgedPastGrace. Denying runs nothing, so the
      // double-execution guard that blocks healing has no bearing on it, and
      // without this a wedged row is undecidable by anyone, forever.
      from: fromWedged ? "approving" : "pending",
      set: fromWedged
        ? drizzleSql`status = 'denied', decided_by = ${args.actor.userId}, decided_at = now(), reason = ${reason},
                     approving_started_at = NULL,
                     metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{deniedWhileWedged}', to_jsonb(now()))`
        : drizzleSql`status = 'denied', decided_by = ${args.actor.userId}, decided_at = now(), reason = ${reason}${forSql}`,
      returning: drizzleSql`id, status, decided_by, decided_at, reason, originating_thread_id, tool_name`,
    })
    if (!updated) {
      const [cur] = extractRows<{ status: string }>(
        await tx.execute(
          drizzleSql`SELECT status FROM ${K}.approval_requests WHERE id = ${row.id}`,
        ),
      )
      throw new AlreadyDecidedError(cur?.status ?? "unknown")
    }
    // Denying a bundle head cancels every deferred step of the same bundle, and
    // denying a later step that became its own decision cancels the steps after it.
    await cancelDeferredBundleSiblings(tx, row.id)
    await cancelDeferredDependents(tx, row.id)
    const deciderName = await loadUserName(tx, args.actor.userId)
    await emitApprovalStateChange(tx, {
      // The decider's own name and their typed reason, nothing a handler produced.
      requiredScopes: [],
      orgId: args.orgId,
      requestId: row.id,
      threadId: row.thread_id,
      originatingThreadId: updated.originating_thread_id,
      requesterId: row.requested_by,
      actorUserId: args.actor.userId,
      actorType: "user",
      content: fromWedged
        ? `Denied by ${deciderName}${reason ? `. Reason: ${reason}` : ""}. This request was stuck mid-execution, so whether the action already took effect was never established -- check before assuming it did not run.`
        : reason
          ? `Denied by ${deciderName}. Reason: ${reason}.`
          : `Denied by ${deciderName}.`,
      metadata: {
        type: "approval-decision",
        decision: "denied",
        actorId: args.actor.userId,
        reason,
      },
    })
    return updated
  })
  // A routine run waiting on this call carries on, told it was refused
  // (approval-result-turn.ts). No-op for any other approval.
  await enqueueRoutineDecisionTurn(args.orgId, result.id)
  return {
    id: result.id,
    status: "denied",
    decidedBy: result.decided_by,
    decidedAt: new Date(result.decided_at).toISOString(),
    reason: result.reason,
  }
}

/** Who a decision was taken for, when the decider is not the person the row is for. */
type DecidedFor =
  | { userId: string; as: "next_in_line"; awayUntil: string | null }
  | { userId: string; as: "also_could" }

/** Runs on a decision's own transaction once it holds the row's lock. */
type DecidedForReader = (tx: PrivilegedDb) => Promise<DecidedFor | null>

/** A test's hook between the decider's away read and the claim: nothing else sets it. */
export const DecidedForTestAccess: { beforeClaim: (() => Promise<void>) | null } = {
  beforeClaim: null,
}

/**
 * The audit of a decision taken for someone else: the stand-in of a person away decides as
 * their next in line, any other decider as someone who could also approve it. The person the
 * row is for, an owner-routed row and a row for the usual deciders record nothing. Who is away
 * is read here as the decider; the person on the item is read by the claim on its locked row,
 * so the record names whose the row was when this decision won. A route that cannot be read
 * records nothing: the decision itself never waits on it.
 */
async function decidedForReader(
  args: DecideArgs,
  row: ApprovalRow,
): Promise<DecidedForReader | undefined> {
  let world: AwayWorld
  try {
    world = await withRlsContext(args.actor, (tx) => readAwayWorld(tx, args.orgId))
  } catch (err) {
    log.warn({ err, requestId: row.id }, "could not read who is away; no decided-for audit")
    return undefined
  }
  if (DecidedForTestAccess.beforeClaim) await DecidedForTestAccess.beforeClaim()
  return async (tx) => {
    try {
      // A savepoint: a read that fails here must not abort the decision's own transaction.
      const route = await tx.transaction((sp) =>
        readLockedApprovalRoute(sp, args.orgId, row, world),
      )
      if (route.to !== "person" || route.userId === args.actor.userId) return null
      if (route.standIn === args.actor.userId) {
        return { userId: route.userId, as: "next_in_line", awayUntil: route.awayUntil }
      }
      return { userId: route.userId, as: "also_could" }
    } catch (err) {
      log.warn(
        { err, requestId: row.id },
        "could not read whose the request was; no decided-for audit",
      )
      return null
    }
  }
}

async function approveFlow(args: DecideArgs, row: ApprovalRow): Promise<DecideResult> {
  // ── N-eyes (BL-268) ──────────────────────────────────────────────────────
  // When an org approval-tightening policy demanded ≥2 DISTINCT approvers, the
  // first approver does NOT execute the action: we record them on the row's
  // `metadata.approvedBy` (a distinct set) and KEEP the row pending. Only the
  // call that reaches the required distinct-approver count proceeds to execute.
  // The check + the metadata UPDATE run under a row lock so two concurrent
  // approvals can't both believe they were the last (or both the first).
  const minApprovers = row.metadata?.minApprovers ?? 1
  if (minApprovers >= 2) {
    const partial = await withPrivilegedDb(args.orgId, "approval-neyes-record", async (tx) => {
      const [locked] = extractRows<{ metadata: Record<string, unknown> | null; status: string }>(
        await tx.execute(drizzleSql`
          SELECT metadata, status FROM ${K}.approval_requests
          WHERE id = ${row.id} FOR UPDATE`),
      )
      if (locked?.status !== "pending") {
        // Concurrent terminal/claim transition — let the normal path raise the
        // already-decided / state error after the lock releases.
        return { proceed: true as const }
      }
      const meta = (locked.metadata ?? {}) as {
        minApprovers?: number
        approvedBy?: string[]
      }
      const required = meta.minApprovers ?? minApprovers
      const existing = Array.isArray(meta.approvedBy) ? meta.approvedBy : []
      // One person, one sign-off. A second click by someone already counted (the
      // requester whose own send was their sign-off, or an approver clicking
      // again) is refused, so it can never read as progress toward the count.
      if (existing.includes(args.actor.userId)) {
        throw new ApprovalDecisionError(
          409,
          "already_signed_off",
          "you have already signed off on this request: it needs a different approver",
        )
      }
      const distinct = [...existing, args.actor.userId]
      if (distinct.length >= required) {
        // This is the FINAL distinct approver — record them and let execution
        // proceed (the executeApprovedStep claim runs after the lock releases).
        await tx.execute(drizzleSql`
          UPDATE ${K}.approval_requests
          SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb), '{approvedBy}', ${JSON.stringify(distinct)}::jsonb, true)
          WHERE id = ${row.id}`)
        return { proceed: true as const }
      }
      // Not enough distinct approvers yet — record this one, stay pending.
      await tx.execute(drizzleSql`
        UPDATE ${K}.approval_requests
        SET metadata = jsonb_set(
          COALESCE(metadata, '{}'::jsonb), '{approvedBy}', ${JSON.stringify(distinct)}::jsonb, true)
        WHERE id = ${row.id}`)
      const deciderName = await loadUserName(tx, args.actor.userId)
      await emitApprovalStateChange(tx, {
        // Approver names and a count, nothing a handler produced.
        requiredScopes: [],
        orgId: args.orgId,
        requestId: row.id,
        threadId: row.thread_id,
        originatingThreadId: row.originating_thread_id,
        requesterId: row.requested_by,
        actorUserId: args.actor.userId,
        actorType: "user",
        content: `Approved by ${deciderName} (${distinct.length} of ${required} required approvers). Awaiting a second approver per org policy.`,
        metadata: {
          type: "approval-partial",
          decision: "partial_approve",
          actorId: args.actor.userId,
          approvalsRecorded: distinct.length,
          approvalsRequired: required,
        },
      })
      return {
        proceed: false as const,
        recorded: distinct.length,
        required,
      }
    })
    if (!partial.proceed) {
      return {
        id: row.id,
        status: "pending",
        decidedBy: args.actor.userId,
        decidedAt: new Date().toISOString(),
        approvalsRecorded: partial.recorded,
        approvalsRequired: partial.required,
      }
    }
  }

  // Whose this row was when the decider chose: read by the claim, under its row lock.
  const decidedFor = await decidedForReader(args, row)

  // A bundle's later steps run on this same decision: bind each to the version the decider saw.
  await bindDeferredSteps(args, row)

  // Build the requester context up front — needed for the cascade if this is a
  // bundle head, and for the decider context the cascade threads through.
  const decider = await loadRequesterContext(
    args.orgId,
    row.requested_by,
    "approval-load-requester-perms",
  )

  // Run the head step: claim pending → approving, run handler, terminalize.
  const outcome = await executeApprovedStep({
    orgId: args.orgId,
    approvalId: row.id,
    sourceStatus: "pending",
    decider,
    deciderId: args.actor.userId,
    // Only the HEAD step gets it. A deferred bundle dependent is a different
    // tool call the approver never decrypted anything for.
    ...(args.mailboxFulfilment ? { mailboxFulfilment: args.mailboxFulfilment } : {}),
    ...(args.payloadHash !== undefined ? { expectedPayloadHash: args.payloadHash } : {}),
    ...(args.sendGuardOverride !== undefined ? { sendGuardOverride: args.sendGuardOverride } : {}),
    decidedFor,
  })

  if (outcome.kind === "payload_changed") {
    throw new ApprovalDecisionError(
      409,
      "payload_changed",
      "this request was edited after you opened it: review the current version and decide again",
    )
  }

  if (outcome.kind === "send_guard_not_held") {
    throw new ApprovalDecisionError(
      422,
      "send_guard_not_held",
      outcome.state === "not_guarded"
        ? "Send now applies only to a mail draft held by an automatic reply. Nothing was sent; the request is still pending."
        : `Nothing was sent: this draft is no longer held (it now reads ${outcome.state.replace(/_/g, " ")}). The request is still pending: reload it and decide on what it shows now.`,
      { state: outcome.state },
    )
  }

  if (outcome.kind === "draining") {
    // Shutting down (a deploy is recreating this container). The claim was NOT
    // taken, so the approval is untouched and still `pending` -- the caller
    // retries in a moment against the new container and it decides normally.
    // 503 + Retry-After, never a 4xx: nothing is wrong with the request.
    throw new ApprovalDecisionError(503, "server_draining", "server_draining", {
      code: "server_draining",
      details:
        "The server is restarting. This approval was not executed and is still pending -- retry shortly.",
    })
  }

  if (outcome.kind === "already_claimed") {
    // Lost the optimistic claim — a concurrent decide or the reaper already
    // moved the head off `pending`.
    throw new AlreadyDecidedError(outcome.currentStatus)
  }

  if (outcome.kind === "failed") {
    const err = outcome.error
    // Pre-commit failures revert the head to pending; deferred siblings stay
    // deferred so a clean re-approval is possible.
    if (err instanceof HandlerNoEffectError || err instanceof HandlerToolMissingError) {
      // revertToPending already emits the approval-error message AND the
      // `extraEventData.lastFailure` meant to surface on the attention-feed card.
      await revertToPending(args, row, row.originating_thread_id, row.thread_id, err)
      const details = err instanceof HandlerNoEffectError ? err.details : undefined
      throw new ApprovalDecisionError(422, "handler_failed", "handler_failed", {
        code: (err as { code?: string }).code,
        details,
      })
    }
    if (err instanceof HandlerAmbiguousError) {
      // Pino's err serializer drops custom fields — surface `details` (the
      // underlying handler error, e.g. the upstream API denial) explicitly or
      // the log is undiagnosable ("ambiguous outcome" with no cause).
      // WARN, not error: a single ambiguous outcome must not page (over-alerting
      // fix: 30 criticals were mostly this state). The approving-reaper escalates
      // to error level once the row is past the grace window and still unresolved.
      //
      // CORRECTION (2026-08-04): this used to claim healWedgedApproving
      // "auto-resolves it after the grace window". It does NOT — that function
      // explicitly REFUSES to heal a `started` or `ambiguous` protocol row,
      // because the handler durably recorded that its side effect MAY have
      // landed. Such a row is parked until a HUMAN reconciles it. Believing the
      // false premise is how 7 rows sat unresolved for weeks.
      log.warn(
        { err, details: err.details, requestId: row.id },
        "Handler ambiguous outcome — row parked at approving, needs operator reconciliation (does NOT auto-heal)",
      )
      // Persist the failure ON THE ROW. Until now the only trace was a log line
      // and a thread message, so the attention feed could not distinguish
      // "failed seconds ago" from "still running" and had to wait out the full
      // grace window — a 10-minute stretch in which a FAILED approval looks
      // exactly like a successful one to the operator who just clicked Approve.
      // With this stamp the feed surfaces it immediately.
      await withPrivilegedDb(args.orgId, "approval-ambiguous-stamp", (tx) =>
        tx.execute(drizzleSql`
          UPDATE ${K}.approval_requests
          SET metadata = jsonb_set(
                jsonb_set(COALESCE(metadata, '{}'::jsonb), '{ambiguousAt}', to_jsonb(now())),
                '{ambiguousError}',
                to_jsonb(${detailMessageForStamp(err)}::text)
              )
          WHERE id = ${row.id} AND status = 'approving'
        `),
      )
      // Tell the THREAD too — without this the approver clicked Approve, got a
      // silent 422, and the card just sat there with no explanation (the row is
      // held at `approving` until healWedgedApproving or manual reconciliation).
      const detailMessage =
        isRec(err.details) && typeof err.details.message === "string" ? err.details.message : null
      await withPrivilegedDb(args.orgId, "approval-ambiguous-notify", async (tx) => {
        // `detailMessage` is the handler's own message and the metadata carries
        // its raw error, either of which can quote what the handler was holding.
        const requesterScopes = (await loadEffectivePermissions(tx, row.requested_by, args.orgId))
          .scopes
        await emitApprovalStateChange(tx, {
          requiredScopes: approvalFailureRequiredScopes({
            orgId: args.orgId,
            toolName: row.tool_name,
            proposingTurnScopes: row.proposing_turn_scopes,
            requesterScopes,
          }),
          orgId: args.orgId,
          requestId: row.id,
          threadId: row.thread_id,
          originatingThreadId: row.originating_thread_id,
          requesterId: row.requested_by,
          actorUserId: args.actor.userId,
          actorType: "user",
          content: `Approval execution did not complete${detailMessage ? `: ${detailMessage}` : ""}. Nothing was applied that this message does not state. The request is HELD for review and will NOT retry on its own — it needs a person to reconcile it.`,
          metadata: {
            type: "approval-error",
            error: { code: err.code, message: err.message, details: err.details ?? null },
          },
        })
      })
      throw new ApprovalDecisionError(422, "handler_ambiguous", "handler_ambiguous", {
        code: err.code,
        details: err.details,
      })
    }
    if (err instanceof RequesterLostScopeError) {
      await revertToPending(args, row, row.originating_thread_id, row.thread_id, err)
      throw new ApprovalDecisionError(422, "requester_lost_scope", "requester_lost_scope", {
        code: err.code,
        requiredScope: err.requiredScope,
      })
    }
    throw err
  }

  if (outcome.kind === "awaiting_output") {
    // The head committed but its output is async — park the cascade behind a poll
    // job. Deferred dependents resume when the output lands.
    await enqueuePoll(args.orgId, row.id, outcome.toolName, 0)
  } else {
    // Deterministic success — drive every deferred dependent in order.
    await cascadeDeferredDependents({
      orgId: args.orgId,
      approvedId: row.id,
      decider,
      deciderId: args.actor.userId,
    })
  }

  // Read the head's final state (terminalized by executeApprovedStep).
  // A concurrent terminal transition can race this read and leave the row in
  // an unexpected state; guard against an empty result set rather than crashing.
  const [cur] = extractRows<{
    id: string
    status: string
    decided_by: string
    decided_at: string
  }>(
    await withPrivilegedDb(args.orgId, "approval-read-final", (tx) =>
      tx.execute(
        drizzleSql`SELECT id, status, decided_by, decided_at FROM ${K}.approval_requests WHERE id = ${row.id}`,
      ),
    ),
  )
  if (!cur) {
    throw new ApprovalDecisionError(
      422,
      "handler_failed",
      "Approval request disappeared after execution — may have been concurrently cancelled",
    )
  }
  return {
    id: cur.id,
    status: "approved",
    decidedBy: cur.decided_by,
    decidedAt: new Date(cur.decided_at).toISOString(),
  }
}

/**
 * The deferred steps of a bundle run, after the head, on the head's approval. Each is stamped with
 * the fingerprint of the version the decider was shown (`metadata.approvedPayloadHash`), under the
 * steps' row locks; the cascade runs a step only while it still matches (cascade.ts). A step that
 * changed, or that the card never showed (added after it loaded), refuses the approve before the
 * head runs. An in-process caller that decides on no card binds the steps as they stand.
 */
async function bindDeferredSteps(args: DecideArgs, row: ApprovalRow): Promise<void> {
  if (!row.bundle_id) return
  await withPrivilegedDb(args.orgId, "approval-bind-steps", async (tx) => {
    const steps = extractRows<{ id: string; tool_name: string; current_payload: unknown }>(
      await tx.execute(drizzleSql`
        SELECT id, tool_name, current_payload FROM ${K}.approval_requests
        WHERE bundle_id = ${row.bundle_id} AND org_id = ${args.orgId}::uuid
          AND status = 'deferred' AND id <> ${row.id}
        ORDER BY bundle_position
        FOR UPDATE`),
    )
    for (const step of steps) {
      const current = approvalPayloadHash(step.tool_name, step.current_payload)
      if (args.payloadHash !== undefined && args.stepPayloadHashes?.[step.id] !== current) {
        throw new ApprovalDecisionError(
          409,
          "payload_changed",
          "a step of this request was edited or added after you opened it: review the current version and decide again",
        )
      }
      await tx.execute(drizzleSql`
        UPDATE ${K}.approval_requests
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{approvedPayloadHash}', ${JSON.stringify(current)}::jsonb, true)
        WHERE id = ${step.id}`)
    }
  })
}

/** What a stopped mail's Home line says, in short facts. Never a word of the message. */
function sendGuardStopLine(guard: Record<string, unknown>, to: string): string {
  const who = typeof guard.who === "string" && guard.who !== "" ? guard.who : "The other side"
  switch (guard.state) {
    case "replied":
      return `Not sent to ${to}: ${who} replied after it was drafted.`
    case "bounced":
      return `Not sent to ${to}: a delivery failure came back for this address.`
    case "opted_out":
      return `Not sent to ${to}: they opted out of commercial mail.`
    case "ref_stop":
      return `Not sent to ${to}: ${typeof guard.label === "string" ? guard.label : "the record it was about says not to send it."}`
    default:
      return `Not sent to ${to}: the check before sending stopped it.`
  }
}

/**
 * A mail a person approved and the send check then stopped for good: one Home line for the
 * person who decided and for the owner of the routine that drafted it (one row each, since the
 * translation names them as participants). Dismiss marks it read; nothing resolves it.
 */
async function queueSendGuardStopped(
  tx: PrivilegedDb,
  args: DecideArgs,
  row: ApprovalRow,
  details: Record<string, unknown> | null,
): Promise<void> {
  if (row.tool_name !== "mail:compose" && row.tool_name !== "mail:reply") return
  const guard = details && isRec(details.guard) ? details.guard : null
  if (!guard) return
  const routineId = (row.metadata as { originRoutineId?: unknown } | null)?.originRoutineId
  const owners =
    typeof routineId === "string"
      ? extractRows<{ owner_user_id: string | null }>(
          await tx.execute(drizzleSql`
            SELECT owner_user_id FROM ${K}.routines WHERE id = ${routineId}::uuid AND org_id = ${args.orgId}::uuid`),
        ).flatMap((r) => (r.owner_user_id ? [r.owner_user_id] : []))
      : [row.requested_by]
  const targetUserIds = [...new Set([args.actor.userId, ...owners])]
  const payload = isRec(row.current_payload) ? row.current_payload : {}
  const to = Array.isArray(payload.to)
    ? payload.to.filter((v): v is string => typeof v === "string").join(", ")
    : ""
  await tx.queueEvent({
    app: "mail",
    entity: "send_guard",
    action: "stopped",
    entityId: row.id,
    data: {
      requestId: row.id,
      state: guard.state ?? null,
      summary: sendGuardStopLine(guard, to || "the recipient"),
      targetUserIds,
      link: { tabType: "thread", entityId: row.thread_id },
    },
    actorId: args.actor.userId,
    actorType: "user",
    orgId: args.orgId,
    timestamp: new Date().toISOString(),
  })
}

async function revertToPending(
  args: DecideArgs,
  row: ApprovalRow,
  originatingThreadId: string,
  threadId: string,
  err: Error & { details?: unknown; code?: string },
): Promise<void> {
  // A FINAL failure (the handler marked it `final`: what the approval bound has
  // changed, so approving the same request again can never pass) closes the
  // request and its deferred bundle siblings instead of re-pending it forever.
  const final = isRec(err.details) && err.details.final === true
  const closed = await withPrivilegedDb(args.orgId, "approval-revert", async (tx) => {
    const reverted = await lockedUpdateApproval<{ id: string; bundle_id: string | null }>(tx, {
      requestId: row.id,
      from: "approving",
      set: final
        ? drizzleSql`status = 'cancelled', approving_started_at = NULL`
        : // Back to pending, undecided: no decision was taken for anyone.
          drizzleSql`status = 'pending', decided_by = NULL, decided_at = NULL, approving_started_at = NULL,
                     metadata = COALESCE(metadata, '{}'::jsonb) - 'decidedFor'`,
      returning: drizzleSql`id, bundle_id`,
    })
    if (!reverted) return null
    if (final && reverted.bundle_id) {
      await tx.execute(drizzleSql`
        UPDATE ${K}.approval_requests SET status = 'cancelled'
        WHERE bundle_id = ${reverted.bundle_id} AND status IN ('deferred', 'pending')`)
    }
    // Handler-supplied re-stage patch (soft-error `restage_payload_patch`): the
    // failed execution proved the approved payload is stale (e.g. the carrier
    // price rose past tolerance), so the reverted card must re-stage with the
    // corrected values — otherwise the next approve just replays the same
    // doomed buy. Shallow top-level merge, deliberately: the handler names
    // exact payload keys and anything deeper belongs in a full re-stage.
    const details = isRec(err.details) ? err.details : null
    const restagePatch =
      details && isRec(details.restage_payload_patch) ? details.restage_payload_patch : null
    if (restagePatch) {
      await tx.execute(drizzleSql`
        UPDATE ${K}.approval_requests
        SET current_payload = current_payload || ${JSON.stringify(restagePatch)}::jsonb,
            tool_params = tool_params || ${JSON.stringify(restagePatch)}::jsonb
        WHERE id = ${row.id} AND status = 'pending'`)
    }
    // Readable failure detail: the specific message the failing layer produced
    // (e.g. the carrier's own rejection text) beats the generic wrapper.
    const failureMessage =
      details && typeof details.message === "string" && details.message !== ""
        ? details.message
        : err.message
    const failureCode =
      details && typeof details.code === "string" ? details.code : (err.code ?? "handler_failed")
    // `err.message` is the handler's own text and the metadata carries its raw
    // error and details, so the notice requires what the call could reveal.
    const requesterScopes = (await loadEffectivePermissions(tx, row.requested_by, args.orgId))
      .scopes
    await emitApprovalStateChange(tx, {
      requiredScopes: approvalFailureRequiredScopes({
        orgId: args.orgId,
        toolName: row.tool_name,
        proposingTurnScopes: row.proposing_turn_scopes,
        requesterScopes,
      }),
      orgId: args.orgId,
      requestId: row.id,
      threadId,
      originatingThreadId,
      requesterId: row.requested_by,
      actorUserId: args.actor.userId,
      actorType: "user",
      // A closed request says WHY (the handler's own reason): nothing can retry it.
      content: final
        ? `Handler failed: ${failureMessage.replace(/\.?$/, ".")} The request is closed: propose it again if it still applies.`
        : `Handler failed: ${err.message}. Request reverted to pending.`,
      metadata: {
        type: "approval-error",
        error: {
          code: err.code,
          message: err.message,
          details: err.details ?? null,
        },
      },
      // Stamp the failure onto the reverted request's summary so the attention-
      // feed card renders it inline (single source: approved_handler_executions;
      // no separate translation item, no event-data escape hatch).
      lastFailure: {
        code: failureCode,
        message: failureMessage,
        at: new Date().toISOString(),
      },
    })
    if (final) await queueSendGuardStopped(tx, args, row, details)
    if (!final) return null
    if (!reverted.bundle_id) {
      await stampExecutionFailure(tx, args.orgId, {
        failedStepId: row.id,
        reason: failureMessage,
        bundleId: null,
      })
    }
    return { bundleId: reverted.bundle_id, reason: failureMessage }
  })
  // A request closed for good is decided: whoever proposed it is woken with the
  // real error, to propose a corrected call. A bundle fails as a whole (its
  // later steps were cancelled above), through the one bundle-failure path; a
  // lone call of a routine run resumes the run (no-op for any other call).
  if (closed?.bundleId) await failBundle(args.orgId, row.id, closed.reason)
  else if (closed) await enqueueRoutineDecisionTurn(args.orgId, row.id)
}
